// app.js — networking + UI for Space Base.
//
// Topology: host-authoritative star over WebRTC data channels.
//   - The host's browser owns the game and validates every move.
//   - Guests connect straight to the host (peer-to-peer); no game server.
//   - NAT traversal uses Google's public STUN servers (see RTC_CONFIG).
//   - Peer discovery/signaling uses the free PeerJS cloud broker, because
//     GitHub Pages can only serve static files.
// Space Base hides nothing but the order of the decks: every view shows every
// console, every cube and the whole shipyard. While the dice are being taken,
// each view carries its own player's choices. Bots fill empty seats and play
// in the host's browser, and take over for anyone who disconnects.

import {
  PROTO,
  MIN_PLAYERS,
  MAX_PLAYERS,
  WIN_VP,
  YARD,
  LEVELS,
  SECTORS,
  START_CREDITS,
  CARDS,
  OPTIONS,
  defaultOpts,
  capOf,
  needOf,
  shortName,
  allocWords,
  canStart,
  newGame,
  applyMove,
  viewFor,
  botChoose,
  botAsideMove,
  waitingOn,
  markDisconnected,
  markReconnected,
  markBotTakeover,
  markSeatClaimed,
  markSeatResigned,
} from './game.js';
import { initSettings } from '../common/settings.js';
import '../common/feedtoggle.js';
import '../common/version.js';

// The ⚙ drawer (bottom-left): live-tunable pacing for testing. Defaults
// reproduce the shipped behavior exactly; overrides stay in this browser.
const cfg = initSettings('sb', [
  { key: 'botRoll', label: 'Bot rolls in', def: [1100, 500], section: 'Host pacing', host: true, hint: 'How long a bot waits before setting a die or rolling.' },
  { key: 'botAlloc', label: 'Bot takes the dice in', def: [600, 500], section: 'Host pacing', host: true, hint: 'Each bot, once the dice are down.' },
  { key: 'botBuy', label: 'Bot buys in', def: [1300, 600], section: 'Host pacing', host: true, hint: 'How long a bot thinks before an ability, a buy or the end of its turn.' },
  { key: 'stampMs', label: 'Rewards show for', def: 1700, section: 'Bubbles & banners' },
  { key: 'bubbleChat', label: 'Chat bubbles linger', def: 6500, section: 'Bubbles & banners' },
  { key: 'bubbleTrunc', label: 'Bubble text cap', def: 84, min: 12, max: 400, step: 4, unit: 'ch', ms: false, section: 'Bubbles & banners' },
  { key: 'flashMs', label: 'Banner duration', def: 1900, section: 'Bubbles & banners' },
  { key: 'overlayDelay', label: 'Result screen delay', def: 2600, section: 'Overlays' },
]);

// ---------------------------------------------------------------- networking

const RTC_CONFIG = {
  iceServers: [
    {
      urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
      ],
    },
  ],
};

const PEER_OPTS = { debug: 1, config: RTC_CONFIG };
const ID_PREFIX = 'sb-v1-';
// commodores: the Revised Field Manual's Chen and Valor and its Z-bot, and some of this page's own
const BOT_NAMES = ['Chen', 'Valor', 'Z-4045', 'Okoro', 'Lindqvist', 'Moreau', 'Tanaka', 'Rivera'];
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function genCode(len = 5) {
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, (v) => CODE_ALPHABET[v % CODE_ALPHABET.length]).join('');
}

function openPeer(id) {
  return new Promise((resolve, reject) => {
    const peer = id ? new Peer(id, PEER_OPTS) : new Peer(PEER_OPTS);
    let done = false;
    peer.on('open', () => {
      if (!done) {
        done = true;
        resolve(peer);
      }
    });
    peer.on('error', (e) => {
      if (!done) {
        done = true;
        try {
          peer.destroy();
        } catch {}
        reject(e);
      }
    });
  });
}

function explainPeerError(e) {
  const t = e && e.type;
  if (t === 'browser-incompatible') return 'This browser does not support WebRTC.';
  if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed') {
    return 'Could not reach the signaling server — check your connection and try again.';
  }
  return `Connection error${t ? ` (${t})` : ''}. Please try again.`;
}

// control characters in names could smuggle cursor tricks; built from char
// codes so the source stays plain ASCII
const CTRL_RE = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']', 'g');

function cleanName(s) {
  return (s || '').replace(CTRL_RE, '').trim().slice(0, 16);
}

function parseCode(s) {
  s = (s || '').trim();
  const m = s.match(/room=([A-Za-z0-9]+)/);
  if (m) s = m[1];
  return s.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function roomLink(code) {
  return `${location.origin}${location.pathname}?room=${code}`;
}

// ---------------------------------------------------------------- DOM helpers

const $ = (sel) => document.querySelector(sel);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function showScreen(name) {
  for (const s of document.querySelectorAll('.screen')) {
    s.classList.toggle('hidden', s.id !== `screen-${name}`);
  }
  if (name !== 'game') hideTip();
}

function toast(text, ms = 3000) {
  const t = el('div', 'toast', text);
  $('#toasts').append(t);
  setTimeout(() => t.classList.add('gone'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

let flashTimer = null;
function flash(text, cls = '') {
  const b = $('#banner');
  b.textContent = text;
  b.className = 'flash hidden';
  void b.offsetWidth;
  const dur = cfg('flashMs');
  b.style.animationDuration = `${dur}ms`;
  b.className = `flash ${cls}`;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => b.classList.add('hidden'), dur);
}

function setHomeStatus(text, isError = false) {
  const s = $('#home-status');
  s.textContent = text || '';
  s.classList.toggle('error', isError);
}

function setBusy(busy) {
  $('#btn-create').disabled = busy;
  $('#btn-join').disabled = busy;
}

function avatarEl(name, seat, bot = false) {
  if (bot) return el('div', 'av bot', '\u{1F916}');
  return el('div', `av s${seat % 8}`, (name || '?').trim().charAt(0).toUpperCase() || '?');
}

// ---------------------------------------------------------------- chat

let chatUnread = 0;
let peekTimer = null;

function chatSetVisible(v) {
  $('#chat').classList.toggle('hidden', !v);
}

function openChatPanel() {
  $('#chat-panel').classList.remove('hidden');
  $('#chat-peek').classList.add('hidden');
  chatUnread = 0;
  $('#chat-unread').classList.add('hidden');
  const box = $('#chat-msgs');
  box.scrollTop = box.scrollHeight;
  $('#chat-input').focus();
}

function peekChatMsg(m) {
  const peek = $('#chat-peek');
  peek.replaceChildren(
    el('span', `chat-name s${(m.seat || 0) % 8}`, m.name || '?'),
    el('span', 'chat-text', m.text.length > 90 ? `${m.text.slice(0, 90)}…` : m.text),
  );
  peek.classList.remove('hidden');
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => peek.classList.add('hidden'), 6000);
}

function fmtChatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function addChatMsg(m, self) {
  const box = $('#chat-msgs');
  const row = el('div', `chat-msg${self ? ' mine' : ''}`);
  row.append(el('span', `chat-name s${(m.seat || 0) % 8}`, m.name || '?'));
  if (m.ts) row.append(el('span', 'chat-time', fmtChatTime(m.ts)));
  row.append(el('span', 'chat-text', m.text));
  box.append(row);
  while (box.children.length > 100) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
  showChatBubble(m);
  if ($('#chat-panel').classList.contains('hidden') && !self) {
    chatUnread++;
    const b = $('#chat-unread');
    b.textContent = chatUnread > 9 ? '9+' : String(chatUnread);
    b.classList.remove('hidden');
    peekChatMsg(m);
  }
}

// Chat floats briefly over the sender's seat tile; kept in a map so the
// bubbles survive re-renders.
const chatBubbles = new Map();
let bubbleId = 0;

function paintChatBubbles() {
  let layer = document.querySelector('#bubble-layer');
  if (!layer) {
    layer = el('div', '');
    layer.id = 'bubble-layer';
    document.body.append(layer);
    window.addEventListener('scroll', paintChatBubbles, { passive: true });
    window.addEventListener('resize', paintChatBubbles);
  }
  const seen = new Set();
  for (const [seat, arr] of chatBubbles) {
    const host = document.querySelector(`.seat[data-seat="${seat}"]`) || document.querySelector(`.seat-row[data-seat="${seat}"]`);
    if (!host || !host.offsetParent) continue;
    const key = String(seat);
    seen.add(key);
    let stack = layer.querySelector(`.bubble-stack[data-seat="${key}"]`);
    if (!stack) {
      stack = el('div', 'bubble-stack');
      stack.dataset.seat = key;
      layer.append(stack);
    }
    const kept = new Set();
    for (const b of arr) {
      const bid = String(b.id);
      kept.add(bid);
      let bub = stack.querySelector(`.chat-bubble[data-id="${bid}"]`);
      if (!bub) {
        bub = el('div', 'chat-bubble', b.text);
        bub.dataset.id = bid;
        stack.append(bub);
      }
    }
    for (const n of stack.querySelectorAll('.chat-bubble')) {
      if (!kept.has(n.dataset.id)) n.remove();
    }
    const r = host.getBoundingClientRect();
    stack.style.left = `${Math.round(r.left + r.width / 2)}px`;
    stack.style.top = `${Math.round(Math.max(r.top, stack.offsetHeight + 14))}px`;
  }
  for (const n of layer.querySelectorAll('.bubble-stack')) {
    if (!seen.has(n.dataset.seat)) n.remove();
  }
}

function showChatBubble(m) {
  if (m.seat == null) return;
  const arr = chatBubbles.get(m.seat) || [];
  const id = ++bubbleId;
  arr.push({
    id,
    text: m.text.length > cfg.raw('bubbleTrunc') ? `${m.text.slice(0, cfg.raw('bubbleTrunc'))}…` : m.text,
    timer: setTimeout(() => {
      const a = chatBubbles.get(m.seat);
      if (a) {
        const idx = a.findIndex((b) => b.id === id);
        if (idx >= 0) a.splice(idx, 1);
        if (!a.length) chatBubbles.delete(m.seat);
      }
      paintChatBubbles();
    }, cfg('bubbleChat')),
  });
  chatBubbles.set(m.seat, arr);
  paintChatBubbles();
}

function clearChatBubbles() {
  for (const arr of chatBubbles.values()) for (const b of arr) clearTimeout(b.timer);
  chatBubbles.clear();
  paintChatBubbles();
}


// ---------------------------------------------------------------- sessions

let session = null;
let pendingMove = false;
let lastView = null;
let lastFxSeq = 0;

class HostSession {
  constructor(peer, code, name) {
    this.isHost = true;
    this.peer = peer;
    this.code = code;
    this.seat = 0;
    this.roster = [{ seat: 0, name, connected: true }];
    this.conns = new Map();
    this.G = null;
    this.tickTimer = null;
    this.chatLog = [];
    this.opts = defaultOpts();
    this.watchers = []; // observers: {id, name, conn, target-seat}
    this.wid = 0;
    peer.on('connection', (conn) => this.accept(conn));
    peer.on('disconnected', () => {
      try {
        peer.reconnect();
      } catch {}
    });
    peer.on('error', (e) => console.warn('peer error:', e && e.type));
    this.hb = setInterval(() => this.sweep(), 5000);
    this.pushLobby();
    showScreen('lobby');
  }

  accept(conn) {
    conn.on('data', (msg) => this.onData(conn, msg));
    conn.on('close', () => this.drop(conn));
    conn.on('error', () => this.drop(conn));
  }

  onData(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    conn._seen = Date.now();
    if (msg.t === 'hello') return this.join(conn, msg);
    if (msg.t === 'watch' && conn._watcher != null) return this.setWatch(conn._watcher, msg.seat);
    if (msg.t === 'chat' && conn._watcher != null) return this.watcherChat(conn._watcher, msg);
    if (msg.t === 'claim' && conn._watcher != null) return this.claimSeat(conn._watcher, msg.seat);
    const seat = conn._seat;
    if (seat == null) return;
    if (msg.t === 'resign') return this.resignSeat(conn);
    if (msg.t === 'move') this.move(seat, msg.move);
    if (msg.t === 'chat') {
      const p = this.roster.find((r) => r.seat === seat);
      if (p) this.relayChat(seat, p.name, msg.text);
    }
  }

  join(conn, msg) {
    const deny = (reason) => {
      try {
        conn.send({ t: 'deny', reason });
      } catch {}
      setTimeout(() => {
        try {
          conn.close();
        } catch {}
      }, 400);
    };
    if (conn._seat != null) return;
    if (msg.v !== PROTO) return deny('version');
    // a returning player proves identity with their reconnect token and
    // reclaims their seat — even mid-game
    if (msg.token) {
      const back = this.roster.find((r) => r.token && r.token === msg.token);
      if (back) return this.reattach(conn, back);
    }
    if (this.G || this.roster.length >= MAX_PLAYERS) return this.attachWatcher(conn, msg);
    let seat = 0;
    while (this.roster.some((p) => p.seat === seat)) seat++;
    const name = cleanName(msg.name) || `Player ${seat + 1}`;
    conn._seat = seat;
    conn._seen = Date.now();
    this.conns.set(seat, conn);
    const token = genCode(12);
    this.roster.push({ seat, name, connected: true, token });
    try {
      conn.send({ t: 'welcome', seat, code: this.code, token });
      if (this.chatLog.length) conn.send({ t: 'chatlog', items: this.chatLog.slice(-20) });
    } catch {}
    toast(`${name} joined`);
    this.pushLobby();
  }

  reattach(conn, p) {
    const old = this.conns.get(p.seat);
    if (old && old !== conn) {
      old._seat = null; // keep drop() from marking them disconnected again
      try {
        old.close();
      } catch {}
    }
    conn._seat = p.seat;
    conn._seen = Date.now();
    this.conns.set(p.seat, conn);
    const wasGone = !p.connected;
    p.connected = true;
    try {
      conn.send({ t: 'welcome', seat: p.seat, code: this.code, token: p.token });
      if (this.chatLog.length) conn.send({ t: 'chatlog', items: this.chatLog.slice(-20) });
    } catch {}
    if (wasGone) toast(`${p.name} reconnected`);
    if (this.G) {
      if (wasGone) markReconnected(this.G, p.seat);
      this.broadcast();
    } else {
      this.pushLobby();
    }
  }

  drop(conn) {
    if (conn._watcher != null) {
      const w = this.watchers.find((x) => x.id === conn._watcher);
      conn._watcher = null;
      if (w) {
        this.watchers = this.watchers.filter((x) => x !== w);
        toast(`${w.name} stopped watching`);
        if (this.G) this.broadcast();
        else this.pushLobby();
      }
      return;
    }
    const seat = conn._seat;
    if (seat == null) return;
    conn._seat = null;
    this.conns.delete(seat);
    const p = this.roster.find((r) => r.seat === seat);
    if (!p) return;
    if (!this.G) {
      this.roster = this.roster.filter((r) => r.seat !== seat);
      toast(`${p.name} left`);
      this.pushLobby();
    } else {
      p.connected = false;
      if (markDisconnected(this.G, seat)) toast(`${p.name} disconnected — the game waits for them`);
      this.broadcast();
    }
  }

  // The table stalls on a disconnected player's turn until they return —
  // unless the host hands their seat to a bot.
  seatCovered(seat) {
    const p = this.G && this.G.players.find((q) => q.seat === seat);
    return !!p && (p.bot || (p.botFor && !p.connected));
  }

  botTakeover(seat) {
    if (!this.G) return;
    if (markBotTakeover(this.G, seat)) this.broadcast();
  }

  // An observer takes a seat: in the lobby any open chair; mid-game a seat
  // whose human is gone (bot-covered or not) \u2014 integrity permitting.
  claimSeat(id, seat) {
    const w = this.watchers.find((x) => x.id === id);
    if (!w) return;
    const err = (text) => {
      try {
        w.conn.send({ t: 'err', error: text });
      } catch {}
    };
    if (!this.G) return this.seatFromLobby(w, err);
    const p = this.roster.find((r) => r.seat === seat);
    if (!p || p.bot) return err('That seat cannot be taken.');
    if (p.connected) return err('That seat is taken.');
    if (!this.claimOk(w, seat)) return err("");
    const old = this.conns.get(seat);
    if (old && old !== w.conn) {
      old._seat = null;
      try {
        old.close();
      } catch {}
    }
    this.watchers = this.watchers.filter((x) => x !== w);
    w.conn._watcher = null;
    w.conn._seat = seat;
    this.conns.set(seat, w.conn);
    p.name = w.name;
    p.connected = true;
    p.token = genCode(12); // the previous owner's token no longer reclaims it
    markSeatClaimed(this.G, seat, w.name);
    try {
      w.conn.send({ t: 'welcome', seat, code: this.code, token: p.token });
    } catch {}
    toast(`${w.name} takes over the seat`);
    this.broadcast();
  }

  seatFromLobby(w, err) {
    if (this.roster.length >= MAX_PLAYERS) return err('The room is full.');
    let seat = 0;
    while (this.roster.some((p) => p.seat === seat)) seat++;
    const token = genCode(12);
    this.watchers = this.watchers.filter((x) => x !== w);
    w.conn._watcher = null;
    w.conn._seat = seat;
    this.conns.set(seat, w.conn);
    this.roster.push({ seat, name: w.name, connected: true, token });
    try {
      w.conn.send({ t: 'welcome', seat, code: this.code, token });
    } catch {}
    toast(`${w.name} takes a seat`);
    this.pushLobby();
  }

  // Space Base keeps nothing secret but the decks, so a watcher may take over
  // any abandoned seat.
  claimOk() {
    return true;
  }

  // A seated guest hands back their seat and becomes an observer of it.
  resignSeat(conn) {
    const seat = conn._seat;
    if (seat == null || seat === 0) return; // the host cannot give up the room
    const p = this.roster.find((r) => r.seat === seat);
    if (!p) return;
    conn._seat = null;
    this.conns.delete(seat);
    const id = ++this.wid;
    conn._watcher = id;
    this.watchers.push({ id, name: p.name, conn, target: seat, seen: new Set([seat]) });
    try {
      conn.send({ t: 'welcome', observer: true, code: this.code });
    } catch {}
    toast(`${p.name} hands back their seat to watch`);
    if (!this.G) {
      this.roster = this.roster.filter((r) => r.seat !== seat);
      this.pushLobby();
    } else {
      p.connected = false;
      p.token = null;
      markSeatResigned(this.G, seat);
      this.broadcast();
    }
  }

  // Overflow and mid-game joiners become observers: they shadow one chosen
  // player's exact view (like standing behind their chair) and can switch.
  attachWatcher(conn, msg) {
    const name = cleanName(msg.name) || 'Watcher';
    const id = ++this.wid;
    conn._watcher = id;
    conn._seen = Date.now();
    const open = this.roster.find((r) => !r.connected && !r.bot);
    const target = open ? open.seat : this.roster.length ? this.roster[0].seat : 0;
    this.watchers.push({ id, name, conn, target, seen: new Set() });
    try {
      conn.send({ t: 'welcome', observer: true, code: this.code });
      if (this.chatLog.length) conn.send({ t: 'chatlog', items: this.chatLog.slice(-20) });
    } catch {}
    toast(`${name} is watching`);
    if (this.G) this.broadcast();
    else this.pushLobby();
  }

  setWatch(id, seat) {
    const w = this.watchers.find((x) => x.id === id);
    if (!w || !this.roster.some((r) => r.seat === seat)) return;
    w.target = seat;
    if (this.G) this.sendWatcher(w);
  }

  sendWatcher(w) {
    if (!this.roster.some((r) => r.seat === w.target)) w.target = this.roster.length ? this.roster[0].seat : 0;
    if (!w.seen) w.seen = new Set();
    w.seen.add(w.target);
    try {
      w.conn.send({
        t: 'state',
        view: {
          ...viewFor(this.G, w.target, this.code, { observer: true }),
          observer: { name: w.name, target: w.target },
          watchers: this.watchers.map((x) => x.name),
        },
      });
    } catch {}
  }

  watcherChat(id, msg) {
    const w = this.watchers.find((x) => x.id === id);
    if (w) this.relayChat(-1, `${w.name} \u{1F441}`, msg.text);
  }

  sweep() {
    const now = Date.now();
    for (const w of [...this.watchers]) {
      if (w.conn._seen && now - w.conn._seen > 20000) {
        try {
          w.conn.close();
        } catch {}
        this.drop(w.conn);
      }
    }
    for (const conn of [...this.conns.values()]) {
      if (conn._seen && now - conn._seen > 20000) {
        try {
          conn.close();
        } catch {}
        this.drop(conn);
      }
    }
  }

  relayChat(seat, name, text) {
    text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text) return;
    const entry = { seat, name, text, ts: Date.now() };
    this.chatLog.push(entry);
    if (this.chatLog.length > 50) this.chatLog.shift();
    this.sendAll({ t: 'chat', ...entry });
    addChatMsg(entry, seat === 0);
  }

  sendChat(text) {
    const me = this.roster.find((p) => p.seat === 0);
    this.relayChat(0, me ? me.name : 'Host', text);
  }

  addBot() {
    if (this.G) return;
    if (this.roster.length >= MAX_PLAYERS) {
      toast('The room is full');
      return;
    }
    let seat = 0;
    while (this.roster.some((p) => p.seat === seat)) seat++;
    const used = new Set(this.roster.map((p) => p.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || `Bot ${seat + 1}`;
    this.roster.push({ seat, name, connected: true, bot: true });
    this.pushLobby();
  }

  // the lobby's variant, on or off
  toggleOption(key) {
    if (this.G || !OPTIONS.some((m) => m.key === key)) return;
    this.opts = { ...this.opts, [key]: !this.opts[key] };
    this.pushLobby();
  }

  removeBot(seat) {
    if (this.G) return;
    if (!this.roster.some((r) => r.seat === seat && r.bot)) return;
    this.roster = this.roster.filter((r) => r.seat !== seat);
    this.pushLobby();
  }

  // The host's clock lets the bots act one move at a time, so the table can
  // see who rolled, took what and bought what.
  schedule(ms) {
    clearTimeout(this.tickTimer);
    if (!this.G || this.G.phase === 'over') return;
    this.tickTimer = setTimeout(() => this.tick(), Math.max(20, ms));
  }

  botDelay() {
    const G = this.G;
    if (!G) return 1000;
    if (G.phase === 'alloc' || G.phase === 'light') return cfg.range('botAlloc');
    if (G.phase === 'roll' || G.phase === 'reroll') return cfg.range('botRoll');
    return cfg.range('botBuy');
  }

  tick() {
    const G = this.G;
    if (!G || G.phase === 'over') return;
    // a bot fires a charged Armstrong at once, on anyone's turn; otherwise
    // the bots the table is waiting on move, one at a time
    let seat = null;
    let mv = null;
    for (const p of G.players) {
      if (!this.seatCovered(p.seat)) continue;
      const aside = botAsideMove(G, p.seat);
      if (aside) {
        seat = p.seat;
        mv = aside;
        break;
      }
    }
    if (!mv) {
      seat = waitingOn(G).find((s) => this.seatCovered(s));
      if (seat != null) mv = botChoose(G, seat);
    }
    if (seat != null) {
      const res = mv ? applyMove(G, seat, mv) : { ok: false };
      if (res.ok) {
        this.pushViews();
      } else {
        console.warn('bot could not move', seat, mv, res.error);
      }
    }
    this.schedule(this.botDelay());
  }

  lobbyMsg() {
    return {
      t: 'lobby',
      code: this.code,
      watchers: this.watchers.map((x) => x.name),
      players: this.roster.map((p) => ({ seat: p.seat, name: p.name, bot: !!p.bot })),
      min: MIN_PLAYERS,
      max: MAX_PLAYERS,
      opts: this.opts,
    };
  }


  pushLobby() {
    this.sendAll(this.lobbyMsg());
    renderLobby(this.lobbyMsg(), this);
  }

  sendAll(msg) {
    for (const c of this.conns.values()) {
      try {
        c.send(msg);
      } catch {}
    }
    for (const w of this.watchers) {
      try {
        w.conn.send(msg);
      } catch {}
    }
  }


  start() {
    const why = canStart(this.roster.length);
    if (why) { toast(why); return; }
    this.G = newGame(this.roster, this.opts);
    this.broadcast();
  }

  again() {
    if (!this.G || this.G.phase !== 'over') return;
    this.roster = this.roster.filter((p) => p.connected || p.bot);
    if (canStart(this.roster.length)) {
      this.toLobby();
      toast('Not enough players — back to the lobby');
      return;
    }
    this.G = newGame(this.roster, this.opts);
    hideOverlays();
    this.broadcast();
  }

  toLobby() {
    this.G = null;
    this.roster = this.roster.filter((p) => p.connected || p.bot);
    hideOverlays();
    this.pushLobby();
    showScreen('lobby');
  }


  broadcast() {
    pendingMove = false;
    showScreen('game');
    this.pushViews();
    this.schedule(this.G ? this.botDelay() : 1000);
  }

  // Everyone's view of the table as it stands.
  pushViews() {
    if (!this.G) return;
    const wnames = this.watchers.map((x) => x.name);
    const opts = {};
    for (const [seat, conn] of this.conns) {
      try {
        conn.send({ t: 'state', view: { ...viewFor(this.G, seat, this.code, opts), watchers: wnames } });
      } catch {}
    }
    for (const w of this.watchers) this.sendWatcher(w);
    renderGame({ ...viewFor(this.G, 0, this.code, opts), watchers: wnames }, this);
  }

  move(seat, move) {
    if (!this.G) return;
    const res = applyMove(this.G, seat, move);
    if (!res.ok) {
      if (seat === 0) {
        pendingMove = false;
        toast(res.error);
        if (lastView) renderGame(lastView, this);
      } else {
        try {
          this.conns.get(seat)?.send({ t: 'err', error: res.error });
        } catch {}
      }
      return;
    }
    this.broadcast();
  }

  localMove(move) {
    this.move(0, move);
  }

  destroy() {
    clearInterval(this.hb);
    clearTimeout(this.tickTimer);
    try {
      this.peer.destroy();
    } catch {}
  }
}


class GuestSession {
  constructor(peer, code, name, resume = null) {
    this.isHost = false;
    this.name = name;
    this.resume = resume; // { token, attempt } while auto-reconnecting
    this.token = (resume && resume.token) || loadRejoin(code);
    this.peer = peer;
    this.code = code;
    this.seat = null;
    this.joined = false;
    this.closed = false;
    const conn = peer.connect(ID_PREFIX + code, { reliable: true, serialization: 'json' });
    this.conn = conn;
    this.timeout = setTimeout(() => {
      if (this.joined) return;
      if (this.resume) retryReconnect(this);
      else this.fail('Could not reach that room. Check the code and try again.');
    }, 12000);
    peer.on('error', (e) => {
      if (e && e.type === 'peer-unavailable' && !this.joined) {
        if (this.resume) retryReconnect(this);
        else this.fail('Room not found — check the code.');
      }
    });
    conn.on('open', () => conn.send({ t: 'hello', v: PROTO, name, token: this.token || undefined }));
    conn.on('data', (msg) => this.onMsg(msg));
    conn.on('close', () => {
      if (this.closed) return;
      if (this.joined) beginReconnect(this);
      else if (this.resume) retryReconnect(this);
      else this.fail('Connection closed.');
    });
    conn.on('error', () => {});
    this.hb = setInterval(() => {
      if (conn.open) {
        try {
          conn.send({ t: 'hb' });
        } catch {}
      }
    }, 4000);
  }

  onMsg(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'welcome':
        this.joined = true;
        this.observer = !!msg.observer;
        this.seat = msg.seat;
        clearTimeout(this.timeout);
        setHomeStatus('');
        setBusy(false);
        if (msg.observer) {
          this.token = null;
          clearRejoin();
        } else {
          this.token = msg.token || this.token;
          saveRejoin(this.code, this.token);
        }
        if (this.resume) {
          toast('Reconnected!');
          this.resume = null;
        }
        break;
      case 'deny': {
        if (this.resume) clearRejoin();
        const why =
          {
            full: 'That room is full (5 players max).',
            'in-progress': 'That game has already started.',
            version: 'Version mismatch — ask everyone to refresh the page.',
          }[msg.reason] || 'Could not join that room.';
        this.fail(why);
        break;
      }
      case 'lobby':
        hideOverlays();
        renderLobby(msg, this);
        showScreen('lobby');
        break;
      case 'state':
        pendingMove = false;
        showScreen('game');
        renderGame(msg.view, this);
        break;
      case 'err':
        pendingMove = false;
        toast(msg.error);
        if (lastView) renderGame(lastView, this);
        break;
      case 'chat':
        addChatMsg(msg, msg.seat === this.seat);
        break;
      case 'chatlog':
        for (const m of Array.isArray(msg.items) ? msg.items : []) addChatMsg(m, m.seat === this.seat);
        break;
    }
  }

  localMove(move) {
    try {
      this.conn.send({ t: 'move', move });
    } catch {}
  }

  watch(seat) {
    try {
      this.conn.send({ t: 'watch', seat });
    } catch {}
  }

  claim(seat) {
    try {
      this.conn.send({ t: 'claim', seat });
    } catch {}
  }

  resign() {
    try {
      this.conn.send({ t: 'resign' });
    } catch {}
  }

  sendChat(text) {
    try {
      this.conn.send({ t: 'chat', text });
    } catch {}
  }

  fail(text) {
    this.destroy();
    session = null;
    showScreen('home');
    chatSetVisible(false);
    $('#chat-msgs').replaceChildren();
    setBusy(false);
    setHomeStatus(text, true);
  }

  destroy() {
    this.closed = true;
    clearInterval(this.hb);
    clearTimeout(this.timeout);
    try {
      this.peer.destroy();
    } catch {}
  }
}

// ---------------------------------------------------------------- reconnection
// The host hands each guest a secret token with its welcome. It is kept per
// room (localStorage), so a dropped connection — or a refreshed tab — can
// reclaim the same seat: automatically with retries, or via a manual Join.

const REJOIN_KEY = 'sb-rejoin';

function saveRejoin(code, token) {
  if (!token) return;
  try {
    localStorage.setItem(REJOIN_KEY, JSON.stringify({ code, token, ts: Date.now() }));
  } catch {}
}

function loadRejoin(code) {
  try {
    const raw = localStorage.getItem(REJOIN_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    return saved && saved.code === code ? saved.token : null;
  } catch {
    return null;
  }
}

function clearRejoin() {
  try {
    localStorage.removeItem(REJOIN_KEY);
  } catch {}
}

const RECONNECT_DELAYS = [1500, 3000, 5000, 8000, 12000, 15000];

function beginReconnect(sess) {
  const { code, name, token } = sess;
  sess.closed = true;
  sess.destroy();
  if (session === sess) session = null;
  if (!token) {
    guestGone(code, 'Disconnected from the host.');
    return;
  }
  scheduleReconnect(code, name, token, 0);
}

function retryReconnect(sess) {
  const next = (sess.resume ? sess.resume.attempt : 0) + 1;
  const { code, name, token } = sess;
  sess.closed = true;
  sess.destroy();
  if (session === sess) session = null;
  scheduleReconnect(code, name, token, next);
}

function scheduleReconnect(code, name, token, attempt) {
  if (attempt >= RECONNECT_DELAYS.length) {
    guestGone(code, 'Could not reconnect.');
    return;
  }
  toast(`Connection lost — reconnecting (try ${attempt + 1} of ${RECONNECT_DELAYS.length})…`, 2600);
  setTimeout(async () => {
    if (session) return; // the player already moved on to something else
    try {
      const peer = await openPeer();
      session = new GuestSession(peer, code, name, { token, attempt });
    } catch {
      scheduleReconnect(code, name, token, attempt + 1);
    }
  }, RECONNECT_DELAYS[attempt]);
}

function guestGone(code, why) {
  showScreen('home');
  chatSetVisible(false);
  $('#chat-msgs').replaceChildren();
  setBusy(false);
  if (code) $('#code-input').value = code;
  setHomeStatus(`${why} Your seat is saved — press Join to pick it back up once the host is reachable.`, true);
}



// ---------------------------------------------------------------- cards, as the table shows them

const TIMING = { blue: 'On your turn', red: 'On the other players’ turns', green: 'On any turn' };
const NUMWORD = ['no', 'one', 'two', 'three', 'four', 'five', 'six'];
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function listWords(a) {
  if (a.length <= 1) return a.join('');
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}

// a reward as the cards print it: a gold coin of credits, a green planet of
// income, a silver rocket of VP
function rw(kind, n) {
  return el('span', `rw ${kind}`, n == null ? '' : String(n));
}

function rewardEls(r) {
  const out = [];
  if (r.cr) out.push(rw('cr', r.cr));
  if (r.inc) out.push(rw('inc', r.inc));
  if (r.vp) out.push(rw('vp', r.vp));
  if (r.arrow) out.push(el('span', 'rw arr', r.arrow === 'LR' ? '◀▶' : r.arrow === 'L' ? '◀' : '▶'));
  if (r.claim) for (const l of LEVELS) if (r.claim[l]) out.push(el('span', 'rw claim', `${r.claim[l]}×L${l}`));
  return out;
}

function rewardWords(r, sector) {
  const parts = [];
  if (r.cr) parts.push(plural(r.cr, 'credit'));
  if (r.inc) parts.push(`${r.inc} income`);
  if (r.vp) parts.push(`${r.vp} VP`);
  if (r.claim) for (const l of LEVELS) if (r.claim[l]) parts.push(`up to ${NUMWORD[r.claim[l]]} level ${l} ship${r.claim[l] === 1 ? '' : 's'} claimed free`);
  let s = listWords(parts);
  if (r.arrow) {
    const where = r.arrow === 'LR' ? 'the rewards of the sector on either side, your pick' : `the rewards of the sector to the ${r.arrow === 'L' ? 'left' : 'right'}${sector ? ` (${sector + (r.arrow === 'L' ? -1 : 1)})` : ''}`;
    s = s ? `${s}, and ${where}` : where;
  }
  return s;
}

// The squares that count at this table, filled as far as the cubes go.
function sqEl(sq, n, cubes) {
  const box = el('span', `sqs${sq.linked ? ' linked' : ''}`);
  const cap = capOf(sq, n);
  for (let i = 0; i < cap; i++) box.append(el('i', cubes != null && i < cubes ? 'on' : ''));
  return box;
}

function squareWords(sq, n) {
  const cap = capOf(sq, n);
  const counts = sq.pips.some((p) => p.length);
  let s;
  if (!sq.linked) s = sq.n === 1 ? 'one charge square' : `${NUMWORD[sq.n]} separate charge squares — a reserve, one cube spent a use`;
  else s = `${NUMWORD[sq.n]} linked charge squares, all filled to use it and all spent`;
  if (counts) {
    const at = [2, 3, 4, 5].map((k) => `${capOf(sq, k)} at ${k}`).join(', ');
    s += `; by the pips, ${at} players — ${cap} here`;
  }
  return s;
}

function abShort(ab) {
  switch (ab.kind) {
    case 'shift': return ab.by.length > 1 ? 'Sum +1/+2' : 'Sum +1';
    case 'double': return '2× a sector';
    case 'reroll': return ab.cr ? `Reroll +${ab.cr}¢` : 'Reroll';
    case 'setdie': return ab.cr ? `Set a die +${ab.cr}¢` : 'Set a die';
    case 'gain': return `+${ab.cr}¢`;
    case 'swap': return `Swap ${ab.a}⇄${ab.b}`;
    case 'buy': {
      const base = ab.high ? 'Buy into 7–12' : ab.n > 1 ? 'Buy 1–2' : 'Buy a card';
      const extra = [ab.cr ? `+${ab.cr}¢` : '', ab.vp ? `+${ab.vp}V` : '', ab.loss ? `rivals −${ab.loss}V` : ''].filter(Boolean);
      return extra.length ? `${base} ${extra.join(' ')}` : base;
    }
    case 'claim': return `Claim ${LEVELS.filter((l) => ab.claim[l]).map((l) => `${ab.claim[l]}×L${l}`).join(' ')}`;
    case 'place': return ab.move ? 'Place + move a charge' : 'Place a charge';
    case 'exchange': return 'Exchange';
    case 'win': return 'You win';
    default: return ab.kind;
  }
}

function abLong(ab) {
  const t = TIMING[ab.color];
  switch (ab.kind) {
    case 'shift': return `${t}, as you take the sum of the dice: raise it by ${ab.by.length > 1 ? '1 or 2' : '1'}`;
    case 'double': return `${t}, as you take the dice: one sector you take pays out twice (never charging this ship)`;
    case 'reroll': return `${t}, right after the roll: roll one die or both again${ab.cr ? `, and gain ${plural(ab.cr, 'credit')}` : ''}`;
    case 'setdie': return `${t}, before the roll: set one die to the number you want${ab.cr ? `, and gain ${plural(ab.cr, 'credit')}` : ''}`;
    case 'gain': return `${t}: gain ${plural(ab.cr, 'credit')}`;
    case 'swap': return `${t}: every card in your sectors ${ab.a} and ${ab.b}, stationed and deployed, trades places`;
    case 'buy': {
      const pre = [ab.cr ? `gain ${plural(ab.cr, 'credit')}` : '', ab.vp ? `gain ${ab.vp} VP` : '', ab.loss ? `every other player loses ${ab.loss} VP` : ''].filter(Boolean);
      const what = ab.high ? 'buy a ship at just its price and station it in any sector from 7 to 12' : ab.n > 1 ? 'buy one or two cards, each at just its price' : 'buy a card at just its price';
      return `${t}: ${pre.length ? `${listWords(pre)}, then ` : ''}${what} — besides your one normal buy`;
    }
    case 'claim': return `${t}: take ${listWords(LEVELS.filter((l) => ab.claim[l]).map((l) => `up to ${NUMWORD[ab.claim[l]]} level ${l} ship${ab.claim[l] === 1 ? '' : 's'}`))} from the shipyard, free`;
    case 'place': return `${t}: place a charge cube on another of your ships${ab.move ? ', then you may move one of your cubes to another empty square' : ''}`;
    case 'exchange': return `${t}: this ship and another on your console trade places — a deployed one with a stationed one, too`;
    case 'win': return `${t}: you win the game, there and then`;
    default: return t;
  }
}

function sideWords(view, id, side) {
  const c = CARDS[id];
  const sd = c[side];
  const bits = [];
  const rew = rewardWords(sd.r, c.sector);
  if (sd.sq) bits.push(`${rew ? `${rew}, and ` : ''}a charge cube on ${squareWords(sd.sq, view.n)}`);
  else if (rew) bits.push(rew);
  if (sd.ab) bits.push(`${abLong(sd.ab)}${sd.sq ? ` (${plural(needOf(sd.sq, view.n), 'cube')})` : ''}`);
  return bits.length ? bits.join('. ') : 'nothing';
}

function cardTip(view, id) {
  const c = CARDS[id];
  const head = `${c.name}\n${c.cls}`;
  if (c.kind === 'colony') return `${head}\nColony · costs ${c.cost} · sector ${c.sector}\nScores ${c.vp} VP when bought, and closes sector ${c.sector} for good: nothing more is stationed or deployed there, and it pays nothing on your rolls.`;
  const meta = c.kind === 'start' ? `Starting ship · sector ${c.sector}` : `Level ${c.level} · costs ${c.cost} · sector ${c.sector}`;
  return `${head}\n${meta}\nStationed (your rolls): ${sideWords(view, id, 'st')}.\nDeployed (everyone else’s rolls): ${sideWords(view, id, 'dp')}.${c.provisional ? `\nProvisional: ${c.provisional}.` : ''}`;
}

// One side of a card: blue for stationed, red for deployed; the reward, the
// charge squares with the cubes on them, and the ability they pay for.
function bandEl(view, id, side, cubes, live) {
  const sd = CARDS[id][side];
  const band = el('div', `band ${side}${live ? ' live' : ''}`);
  const row = el('div', 'band-row');
  row.append(...rewardEls(sd.r));
  if (sd.sq) row.append(sqEl(sd.sq, view.n, cubes));
  if (row.childElementCount) band.append(row);
  if (sd.ab) band.append(el('span', `ab ${sd.ab.color}`, abShort(sd.ab)));
  if (!band.childElementCount) band.append(el('span', 'band-none', '—'));
  return band;
}

// a card face: cost, name, sector, then its two sides
function cardEl(view, id, o = {}) {
  const c = CARDS[id];
  const box = el(o.tag || 'div', `card k-${c.kind} lv${c.level ?? 'c'}${o.cls ? ` ${o.cls}` : ''}`);
  if (o.tag === 'button') box.type = 'button';
  const head = el('div', 'c-head');
  if (o.cost && c.kind !== 'start') head.append(el('span', 'c-cost', String(c.cost)));
  head.append(el('span', 'c-name', shortName(id)));
  head.append(el('span', 'c-sec', String(c.sector)));
  box.append(head);
  if (c.kind === 'colony') {
    const band = el('div', 'band colony');
    band.append(rw('vp', c.vp), el('span', 'band-note', o.placed ? 'closed' : 'closes it'));
    box.append(band);
  } else {
    box.append(bandEl(view, id, 'st', o.side === 'st' ? o.cubes || 0 : null, o.side === 'st'));
    box.append(bandEl(view, id, 'dp', o.side === 'dp' ? o.cubes || 0 : null, o.side === 'dp'));
  }
  box.dataset.tip = cardTip(view, id);
  box.dataset.tipKey = `${o.key || 'c'}-${id}`;
  return box;
}

// ---------------------------------------------------------------- dice

const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
function dieEl(v, cls = '') {
  const d = el('span', `die${cls ? ` ${cls}` : ''}`);
  for (let i = 0; i < 9; i++) d.append(el('i', v && PIPS[v].includes(i) ? 'pip' : ''));
  d.setAttribute('aria-label', v ? `a ${v}` : 'a die');
  return d;
}

// ---------------------------------------------------------------- lobby UI

function renderLobby(lob, sess) {
  logLines = [];
  logMid = null;
  $('#feed').replaceChildren();
  clearChatBubbles();
  chatSetVisible(true);
  $('#lobby-code').textContent = lob.code;
  renderLobbyWatch(lob, sess);
  ensureResignBtn(sess);
  const list = $('#lobby-players');
  list.replaceChildren();
  const mySeat = sess.isHost ? 0 : sess.seat;
  const n = lob.players.length;
  const rows = Math.min(lob.max, Math.max(MIN_PLAYERS, n + 1));
  for (let i = 0; i < rows; i++) {
    const p = lob.players[i];
    const row = el('li', `seat-row${p ? '' : ' empty'}`);
    if (p) {
      row.dataset.seat = String(p.seat);
      row.style.position = 'relative';
      row.append(avatarEl(p.name, p.seat, p.bot));
      row.append(el('span', 'seat-name', p.name));
      if (p.seat === 0) row.append(el('span', 'chip', 'host'));
      if (p.bot) row.append(el('span', 'chip bot', 'bot'));
      if (p.seat === mySeat) row.append(el('span', 'chip you', 'you'));
      if (p.bot && sess.isHost) {
        const kick = el('button', 'kick', '✕');
        kick.type = 'button';
        kick.setAttribute('aria-label', `Remove ${p.name}`);
        kick.addEventListener('click', () => sess.removeBot(p.seat));
        row.append(kick);
      }
    } else {
      row.append(el('div', 'av empty', '·'), el('span', 'seat-name dim', i < MIN_PLAYERS ? 'Empty seat — a game needs two' : 'Empty seat'));
    }
    list.append(row);
  }

  const opts = lob.opts || defaultOpts();
  const op = $('#option-picker');
  op.replaceChildren();
  for (const m of OPTIONS) {
    const on = !!opts[m.key];
    const b = el('button', `mod-pick${on ? ' on' : ''}`, m.name);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(on));
    b.disabled = !sess.isHost;
    b.dataset.tip = `${m.name}. ${m.text}`;
    b.dataset.tipKey = `opt-${m.key}`;
    if (sess.isHost) b.addEventListener('click', () => sess.toggleOption(m.key));
    op.append(b);
  }

  const tn = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, n));
  const sum = $('#cast-summary');
  sum.replaceChildren();
  sum.append(el('div', 'cast-head', n >= MIN_PLAYERS ? `At this table of ${tn}:` : `At a table of ${tn}:`));
  const bonus = ['', '1 credit', '2 credits', '1 income', '1 income'].slice(1, tn);
  sum.append(el('div', 'cast-note', opts.lightspeed
    ? `15 credits and 1 income each, and four level 1 and two level 2 ships to buy from; whoever keeps the most credits goes first. After the first player, ${listWords(bonus.map((b, i) => `the ${['2nd', '3rd', '4th', '5th'][i]} gains ${b}`))}.`
    : `${START_CREDITS} credits each, a level 1 ship drawn and bought; the highest sector goes first. After the first player, ${listWords(bonus.map((b, i) => `the ${['2nd', '3rd', '4th', '5th'][i]} gains ${b}`))}.`));
  sum.append(el('div', 'cast-note', `Six ships of each level in the shipyard, all twelve colonies. The first to ${WIN_VP} VP ends the round.`));

  $('#btn-start').classList.toggle('hidden', !sess.isHost);
  $('#btn-add-bot').classList.toggle('hidden', !sess.isHost);
  const why = canStart(n);
  if (sess.isHost) {
    $('#btn-start').disabled = !!why;
    $('#btn-add-bot').disabled = n >= lob.max;
  }
  const bots = lob.players.filter((p) => p.bot).length;
  $('#lobby-hint').textContent = sess.isHost
    ? why || `${n} players${bots ? ` (${bots} bot${bots === 1 ? '' : 's'})` : ''}. Ready when you are.`
    : 'Waiting for the host to start…';
  paintChatBubbles();
}

// ---------------------------------------------------------------- UI state

let viewMid = null;
let stepKey = null;
let mode = null;      // an ability being used: { kind, card, picks, sector, target, from, to, step }
let selBuy = null;    // the card picked for the normal buy
let claimPicks = [];  // cards picked to claim, from the dice
let lightPicks = [];  // Light-Speed: the ships to buy, in order
let wasMine = false;  // whether the last view already waited on you
let shownDice = null; // the dice last drawn, to roll them when they change

const me = (view) => view.players.find((p) => p.seat === view.you);
const seatName = (view, seat) => {
  const p = view.players.find((q) => q.seat === seat);
  return p ? p.name : 'someone';
};
const isObserver = (view) => !!view.observer;
const activeOf = (view) => view.players.find((p) => p.seat === view.turn);
const myTurn = (view) => view.turn === view.you && !isObserver(view) && view.phase !== 'over';
const youOr = (view, seat, you = 'you', other = null) => (seat === view.you && !isObserver(view) ? you : other ?? seatName(view, seat));

function clearSel() {
  mode = null;
  selBuy = null;
  claimPicks = [];
}

function rerender() {
  if (lastView && session) renderGame(lastView, session);
}

function send(move) {
  clearSel();
  sendMove(move);
}

function btn(label, cls, fn, disabled = false) {
  const b = el('button', `btn ${cls}`, label);
  b.type = 'button';
  b.disabled = disabled;
  b.addEventListener('click', fn);
  return b;
}

// where a card sits on a console
function whereOn(p, id) {
  for (const s of SECTORS) {
    if (p.station[s] === id) return { sector: s, side: 'st' };
    if (p.deployed[s].includes(id)) return { sector: s, side: 'dp' };
  }
  return null;
}
const isClosed = (p, s) => p.station[s] != null && CARDS[p.station[s]].kind === 'colony';
const abilityOf = (p, id) => {
  const w = whereOn(p, id);
  return w ? CARDS[id][w.side].ab : null;
};
const capOn = (view, p, id) => {
  const w = whereOn(p, id);
  return w ? capOf(CARDS[id][w.side].sq, view.n) : 0;
};

// the cubes a console would have with an ability's cubes spent
function cubesAfterSpend(view, p, id) {
  const w = whereOn(p, id);
  const sq = CARDS[id][w.side].sq;
  return { ...p.cubes, [id]: (p.cubes[id] || 0) - needOf(sq, view.n) };
}

// ---------------------------------------------------------------- picking cards

// The normal buy and every ability's buy and claim pick from the shipyard;
// whether a card can be picked now, given what is picked already.
function yardPickable(view, id) {
  const m = me(view);
  if (!m || isObserver(view)) return false;
  const c = CARDS[id];
  if (view.phase === 'claim' && myTurn(view) && !mode) {
    if (claimPicks.includes(id)) return true;
    const used = claimPicks.filter((x) => CARDS[x].level === c.level).length;
    return view.claim.cards.includes(id) && used < (view.claim.left[c.level] || 0) && !sectorTaken(m, claimPicks, c.sector);
  }
  if (mode && (mode.kind === 'buy' || mode.kind === 'claim')) {
    if (mode.picks.includes(id)) return true;
    const ab = abilityOf(m, mode.card);
    if (mode.kind === 'claim') {
      if (c.kind === 'colony') return false;
      const used = mode.picks.filter((x) => CARDS[x].level === c.level).length;
      return used < (ab.claim[c.level] || 0) && !sectorTaken(m, mode.picks, c.sector);
    }
    if (mode.picks.length >= ab.n) return false;
    if (ab.high && c.kind === 'colony') return false;
    const left = m.cr + (ab.cr || 0) - mode.picks.reduce((s, x) => s + CARDS[x].cost, 0);
    if (c.cost > left) return false;
    return ab.high ? true : !sectorTaken(m, mode.picks, c.sector);
  }
  if (view.phase === 'buy' && myTurn(view) && !view.bought && !mode) return view.can.buy.includes(id);
  return false;
}

// whether a sector is closed, counting what is already picked to go there
function sectorTaken(p, picks, s) {
  let top = p.station[s];
  for (const x of picks) if (CARDS[x].sector === s) top = x;
  return top != null && CARDS[top].kind === 'colony';
}

function tapYard(view, id) {
  if (!yardPickable(view, id)) return;
  if (view.phase === 'claim' && !mode) {
    claimPicks = claimPicks.includes(id) ? claimPicks.filter((x) => x !== id) : [...claimPicks, id];
  } else if (mode) {
    mode.picks = mode.picks.includes(id) ? mode.picks.filter((x) => x !== id) : [...mode.picks, id];
  } else {
    selBuy = selBuy === id ? null : id;
  }
  rerender();
}

// A charge placed, or a card exchanged: what on your own console can be
// tapped now.
function consolePickable(view, id) {
  if (!mode || isObserver(view)) return false;
  const m = me(view);
  if (mode.kind === 'exchange') return id !== mode.card && CARDS[id].kind !== 'colony' && !(whereOn(m, id).side === 'dp' && whereOn(m, mode.card).side === 'dp' && whereOn(m, id).sector === whereOn(m, mode.card).sector);
  if (mode.kind !== 'place') return false;
  const cubes = cubesAfterSpend(view, m, mode.card);
  if (mode.target != null) cubes[mode.target] = (cubes[mode.target] || 0) + 1;
  if (mode.step === 'target' || mode.step === 'to') return id !== mode.card && (cubes[id] || 0) < capOn(view, m, id) && id !== mode.from;
  if (mode.step === 'from') return (cubes[id] || 0) > 0;
  return false;
}

function tapConsole(view, id) {
  if (!consolePickable(view, id)) return;
  if (mode.kind === 'exchange') mode.target = id;
  else if (mode.step === 'target') {
    mode.target = id;
    mode.step = abilityOf(me(view), mode.card).move ? 'from' : 'done';
  } else if (mode.step === 'from') {
    mode.from = id;
    mode.step = 'to';
  } else if (mode.step === 'to') {
    mode.to = id;
    mode.step = 'done';
  }
  rerender();
}

// ---------------------------------------------------------------- the consoles

function seatHead(view, p, big) {
  const head = el('div', `seat${p.seat === view.turn && view.phase !== 'over' ? ' turn' : ''}${!p.connected && !p.bot ? ' gone' : ''}${view.winners && view.winners.includes(p.seat) ? ' won' : ''}`);
  head.dataset.seat = String(p.seat);
  head.append(avatarEl(p.name, p.seat, p.bot));
  const nm = el('span', 'seat-name', p.name + (p.seat === view.you && !isObserver(view) ? ' (you)' : ''));
  head.append(nm);
  if (p.seat === view.first) {
    const f = el('span', 'first-mark', '★');
    f.dataset.tip = 'The starting player. The player to their right has the last turn of the game.';
    f.dataset.tipKey = `first-${p.seat}`;
    head.append(f);
  }
  const res = el('span', 'res');
  const vp = rw('vp', p.vp);
  vp.dataset.tip = `${p.vp} victory point${p.vp === 1 ? '' : 's'} — ${WIN_VP} ends the game.`;
  vp.dataset.tipKey = `vp-${p.seat}`;
  const cr = rw('cr', p.cr);
  cr.dataset.tip = `${plural(p.cr, 'credit')}. Buying a card spends them all.`;
  cr.dataset.tipKey = `cr-${p.seat}`;
  const inc = rw('inc', p.inc);
  inc.dataset.tip = `${p.inc} income: at the end of ${p.seat === view.you && !isObserver(view) ? 'your' : 'their'} turn, credits below it rise to it.`;
  inc.dataset.tipKey = `inc-${p.seat}`;
  res.append(vp, cr, inc);
  head.append(res);
  if (view.phase === 'alloc' || view.phase === 'light') {
    const st = el('span', `pl-status${p.chose ? ' done' : ''}`, p.chose ? (p.auto ? 'taken' : 'chosen') : 'choosing…');
    head.append(st);
  }
  return head;
}

// what the sum of the dice makes each sector
const WAYS = [0, 12, 13, 14, 15, 16, 17, 6, 5, 4, 3, 2, 1];
function sectorTip(s) {
  return s <= 6
    ? `Sector ${s}: a die showing ${s}, or a sum of ${s} — ${WAYS[s]} results in 36 rolls (doubles count twice).`
    : `Sector ${s}: a sum of ${s} — ${WAYS[s]} roll${WAYS[s] === 1 ? '' : 's'} in 36.`;
}

function consoleEl(view, p, big, lit) {
  const mine = p.seat === view.you && !isObserver(view);
  const box = el('div', `console${big ? ' big' : ' small'}`);
  box.append(seatHead(view, p, big));
  const grid = el('div', 'sectors');
  for (const s of SECTORS) {
    const col = el('div', `sector${isClosed(p, s) ? ' closed' : ''}${lit && lit.includes(s) ? ' lit' : ''}`);
    col.dataset.sector = String(s);
    const num = el('div', 'sec-num', String(s));
    num.dataset.tip = sectorTip(s);
    num.dataset.tipKey = `sec-${p.seat}-${s}`;
    col.append(num);
    const dep = el('div', 'deployed');
    for (const id of p.deployed[s]) {
      const can = mine && consolePickable(view, id);
      const chip = el(can ? 'button' : 'div', `dep${can ? ' can' : ''}${mode && (mode.target === id || mode.from === id || mode.to === id) ? ' picked' : ''}`);
      if (can) {
        chip.type = 'button';
        chip.addEventListener('click', () => tapConsole(view, id));
      }
      if (big) chip.append(el('span', 'dep-name', shortName(id)));
      chip.append(bandEl(view, id, 'dp', p.cubes[id] || 0, true));
      chip.dataset.tip = cardTip(view, id);
      chip.dataset.tipKey = `dep-${p.seat}-${id}`;
      dep.append(chip);
    }
    col.append(dep);
    const id = p.station[s];
    if (id != null) {
      const can = mine && consolePickable(view, id);
      const card = cardEl(view, id, { side: 'st', cubes: p.cubes[id] || 0, cls: `${big ? '' : 'tiny'}${can ? ' can' : ''}${mode && (mode.target === id || mode.from === id || mode.to === id) ? ' picked' : ''}`, tag: can ? 'button' : 'div', key: `st-${p.seat}`, placed: true });
      if (can) card.addEventListener('click', () => tapConsole(view, id));
      col.append(card);
    }
    grid.append(col);
  }
  box.append(grid);
  return box;
}

// the sectors a way of taking the dice lights up
function litOf(o) {
  return o ? [...o.acts, ...o.arrows.map((a) => a.to)] : null;
}
let hoverLit = null;

function renderConsoles(view) {
  const wrap = $('#console-wrap');
  wrap.replaceChildren();
  const m = me(view);
  if (m) wrap.append(consoleEl(view, m, true, hoverLit));
  const others = $('#others');
  others.replaceChildren();
  // everyone else, in turn order from the one after you
  const i = view.players.findIndex((p) => p.seat === view.you);
  for (let k = 1; k <= view.players.length; k++) {
    const p = view.players[(Math.max(0, i) + k) % view.players.length];
    if (m && p.seat === m.seat) continue;
    others.append(consoleEl(view, p, false, null));
  }
}

// ---------------------------------------------------------------- the shipyard

function renderYard(view) {
  const box = $('#yard');
  box.replaceChildren();
  const title = el('div', 'yard-title', 'The shipyard');
  box.append(title);
  for (const l of LEVELS) {
    const row = el('div', 'yard-row');
    const label = el('div', 'yard-label');
    label.append(el('b', '', `Level ${l}`), el('small', '', `${view.decks[l]} in the deck`));
    row.append(label);
    const cards = el('div', 'yard-cards');
    for (let i = 0; i < YARD; i++) {
      const id = view.yard[l][i];
      if (id == null) {
        cards.append(el('div', 'card gap'));
        continue;
      }
      cards.append(yardCard(view, id));
    }
    row.append(cards);
    box.append(row);
  }
  const crow = el('div', 'yard-row colonies');
  const clabel = el('div', 'yard-label');
  clabel.append(el('b', '', 'Colonies'), el('small', '', `${view.colonies.length} left`));
  crow.append(clabel);
  const ccards = el('div', 'yard-cards');
  for (const c of CARDS.filter((x) => x.kind === 'colony')) {
    if (view.colonies.includes(c.id)) ccards.append(yardCard(view, c.id));
    else {
      const owner = view.players.find((p) => p.station.includes(c.id));
      const g = el('div', 'card gap col-gone', owner ? owner.name : '');
      g.dataset.tip = `${c.name} (${c.sector}) is settled${owner ? ` by ${owner.name}` : ''}.`;
      g.dataset.tipKey = `gone-${c.id}`;
      ccards.append(g);
    }
  }
  crow.append(ccards);
  box.append(crow);
}

function yardCard(view, id) {
  const can = yardPickable(view, id);
  const picked = selBuy === id || claimPicks.includes(id) || (mode && mode.picks && mode.picks.includes(id));
  const m = me(view);
  const dim = m && myTurn(view) && view.phase === 'buy' && !mode && !view.bought && !can;
  const card = cardEl(view, id, { cost: true, tag: can ? 'button' : 'div', cls: `${can ? 'can' : ''}${picked ? ' picked' : ''}${dim ? ' dim' : ''}`, key: 'yard' });
  if (can) card.addEventListener('click', () => tapYard(view, id));
  return card;
}

// ---------------------------------------------------------------- the action panel

// the net cubes a way of taking the dice adds, with the squares' room
function netCubes(view, p, o) {
  let n = 0;
  const spent = {};
  for (const s of o.spend) spent[s.id] = (spent[s.id] || 0) + s.n;
  for (const [sid, k] of Object.entries(o.gain.charge)) {
    const id = Number(sid);
    const room = capOn(view, p, id) - ((p.cubes[id] || 0) - (spent[id] || 0));
    n += Math.max(0, Math.min(k, room));
  }
  return n;
}

function gainEls(view, p, o) {
  const out = [];
  if (o.gain.cr) out.push(rw('cr', o.gain.cr));
  if (o.gain.inc) out.push(rw('inc', o.gain.inc));
  if (o.gain.vp) out.push(rw('vp', o.gain.vp));
  const cubes = netCubes(view, p, o);
  if (cubes) out.push(el('span', 'rw cube', String(cubes)));
  for (const l of LEVELS) if (o.gain.claim[l]) out.push(el('span', 'rw claim', `${o.gain.claim[l]}×L${l}`));
  if (!out.length) out.push(el('span', 'nothing', 'nothing'));
  return out;
}

function optionEl(view, o, i, chosen = false) {
  const m = me(view);
  const b = el(chosen ? 'div' : 'button', `opt${chosen ? ' chosen' : ''}`);
  if (!chosen) b.type = 'button';
  const head = el('div', 'opt-head');
  head.append(el('span', 'opt-way', o.mode === 'each' ? 'Each die' : o.shift ? `The sum +${o.shift}` : 'The sum'));
  head.append(el('span', 'opt-sec', o.mode === 'each' ? (o.acts[0] === o.acts[1] ? `${o.acts[0]} twice` : `${o.acts[0]} + ${o.acts[1]}`) : String(o.acts[0])));
  b.append(head);
  const g = el('div', 'opt-gain');
  g.append(...gainEls(view, m, o));
  b.append(g);
  const notes = [];
  for (const a of o.arrows) notes.push(`${shortName(a.id)} points to ${a.to}`);
  if (o.dbl) notes.push(`${shortName(o.dbl.id)} doubles ${o.dbl.sector}`);
  const spends = o.spend.filter((s) => !o.dbl || s.id !== o.dbl.id);
  if (spends.length) notes.push(`spends ${listWords(spends.map((s) => `${shortName(s.id)}’s ${s.n === 1 ? 'cube' : `${s.n} cubes`}`))}`);
  if (notes.length) b.append(el('div', 'opt-note', notes.join(' · ')));
  b.dataset.tip = `Take ${allocWords(o)}.`;
  b.dataset.tipKey = `opt-${i}`;
  if (!chosen) {
    b.addEventListener('click', () => {
      hoverLit = null;
      send({ kind: 'alloc', pick: i });
    });
  }
  // the sectors it takes light up on your console
  b.addEventListener('mouseenter', () => paintLit(litOf(o)));
  b.addEventListener('mouseleave', () => paintLit(null));
  b.addEventListener('focus', () => paintLit(litOf(o)));
  b.addEventListener('blur', () => paintLit(null));
  return b;
}

function paintLit(lit) {
  hoverLit = lit;
  for (const col of document.querySelectorAll('#console-wrap .sector')) col.classList.toggle('lit', !!lit && lit.includes(Number(col.dataset.sector)));
}

function diceRow(view) {
  const row = el('div', 'dice-row');
  const fresh = view.dice && shownDice !== `${view.mid}:${view.rolls}:${view.dice.join(',')}`;
  if (view.dice) {
    row.append(dieEl(view.dice[0], fresh ? 'rolled' : ''), dieEl(view.dice[1], fresh ? 'rolled' : ''));
    const [a, b] = view.dice;
    row.append(el('span', 'dice-sum', a === b ? `${a} and ${b} · or ${a + b}` : `${a} and ${b} · or ${a + b}`));
    shownDice = `${view.mid}:${view.rolls}:${view.dice.join(',')}`;
  } else {
    row.append(dieEl(view.set[0], view.set[0] ? 'set' : 'blank'), dieEl(view.set[1], view.set[1] ? 'set' : 'blank'));
    const set = view.set.filter((v) => v != null);
    if (set.length) row.append(el('span', 'dice-sum', set.length === 2 ? 'both dice set' : `one die set to ${set[0]}`));
  }
  return row;
}

// abilities you could use now, as buttons — the ones needing nothing more
// go at once; the rest open a choice
function abilityButtons(view, box) {
  const m = me(view);
  if (!view.can || !view.can.use.length) return;
  const uses = view.can.use.filter((u) => u.kind !== 'reroll');
  if (!uses.length) return;
  const wrap = el('div', 'abilities');
  wrap.append(el('div', 'act-sub', myTurn(view) ? 'Charged and ready:' : 'Charged and ready, on their turn too:'));
  const row = el('div', 'ab-row');
  for (const u of uses) {
    const ab = abilityOf(m, u.id);
    const b = el('button', `ab-btn ${ab.color}${mode && mode.card === u.id ? ' on' : ''}`);
    b.type = 'button';
    b.append(el('b', '', shortName(u.id)), el('span', '', abShort(ab)));
    b.dataset.tip = `${CARDS[u.id].name} (sector ${u.sector}, ${u.side === 'st' ? 'stationed' : 'deployed'}): ${abLong(ab)}.`;
    b.dataset.tipKey = `use-${u.id}`;
    b.addEventListener('click', () => {
      if (mode && mode.card === u.id) mode = null;
      else {
        selBuy = null;
        mode = { kind: ab.kind, card: u.id, picks: [], sector: null, target: null, from: null, to: null, step: 'target' };
        if (ab.kind === 'gain') return send({ kind: 'use', card: u.id });
      }
      rerender();
    });
    row.append(b);
  }
  wrap.append(row);
  box.append(wrap);
}

// what the ability being used still needs, and its button
function modePanel(view, box) {
  if (!mode) return;
  const m = me(view);
  const ab = abilityOf(m, mode.card);
  if (!ab) {
    mode = null;
    return;
  }
  const name = shortName(mode.card);
  const p = el('div', 'mode');
  const row = el('div', 'act-row');
  const cancel = btn('Cancel', 'ghost', () => {
    mode = null;
    rerender();
  });
  switch (mode.kind) {
    case 'swap':
      p.append(el('div', 'act-head', `${name}: swap every card of your sectors ${ab.a} and ${ab.b}?`));
      row.append(btn(`Swap ${ab.a} and ${ab.b}`, 'primary', () => send({ kind: 'use', card: mode.card })), cancel);
      break;
    case 'win':
      p.append(el('div', 'act-head', `${name} is charged: fire it, and win the game?`));
      row.append(btn('Win the game', 'primary', () => send({ kind: 'use', card: mode.card })), cancel);
      break;
    case 'setdie': {
      p.append(el('div', 'act-head', `${name}: set one die to…`));
      for (let v = 1; v <= 6; v++) {
        const b = el('button', 'die-pick');
        b.type = 'button';
        b.append(dieEl(v));
        b.setAttribute('aria-label', `Set a die to ${v}`);
        b.addEventListener('click', () => send({ kind: 'use', card: mode.card, value: v }));
        row.append(b);
      }
      row.append(cancel);
      break;
    }
    case 'buy': {
      const credits = m.cr + (ab.cr || 0);
      const cost = mode.picks.reduce((s, x) => s + CARDS[x].cost, 0);
      p.append(el('div', 'act-head', `${name}: ${abLong(ab).replace(/^On your turn: /, '')}.`));
      p.append(el('div', 'act-sub', `Pick ${ab.n > 1 ? 'up to two cards' : 'a card'} ${ab.high ? 'in the shipyard' : 'in the shipyard or the colonies'} — ${plural(credits, 'credit')} to spend${mode.picks.length ? `, ${cost} picked` : ''}.`));
      if (ab.high && mode.picks.length) {
        const secs = el('div', 'sec-pick');
        secs.append(el('span', 'act-sub', 'Into sector:'));
        for (let s = 7; s <= 12; s++) {
          const b = el('button', `pick${mode.sector === s ? ' on' : ''}`, String(s));
          b.type = 'button';
          b.disabled = isClosed(m, s);
          b.addEventListener('click', () => {
            mode.sector = s;
            rerender();
          });
          secs.append(b);
        }
        p.append(secs);
      }
      const ready = !ab.high || !mode.picks.length || mode.sector != null;
      const label = mode.picks.length ? `Buy ${listWords(mode.picks.map((x) => shortName(x)))}${ab.high && mode.sector ? ` into ${mode.sector}` : ''}` : ab.loss ? 'Use it, buying nothing' : 'Use it, buying nothing';
      row.append(btn(label, 'primary', () => send({ kind: 'use', card: mode.card, cards: mode.picks, ...(ab.high ? { sector: mode.sector } : {}) }), !ready), cancel);
      break;
    }
    case 'claim':
      p.append(el('div', 'act-head', `${name}: ${abLong(ab).replace(/^On your turn: /, '')}.`));
      p.append(el('div', 'act-sub', 'Pick them in the shipyard.'));
      row.append(btn(mode.picks.length ? `Claim ${listWords(mode.picks.map((x) => shortName(x)))}` : 'Use it, claiming nothing', 'primary', () => send({ kind: 'use', card: mode.card, cards: mode.picks })), cancel);
      break;
    case 'place': {
      const say = {
        target: () => 'Tap one of your ships with an empty square for the charge.',
        from: () => `A charge goes on ${shortName(mode.target)}. Now you may move one of your cubes: tap the ship to take it from.`,
        to: () => `Tap the ship to move ${shortName(mode.from)}’s cube to.`,
        done: () => `A charge on ${shortName(mode.target)}${mode.from != null && mode.to != null ? `, and one moved from ${shortName(mode.from)} to ${shortName(mode.to)}` : ''}.`,
      };
      p.append(el('div', 'act-head', `${name}: ${say[mode.step]()}`));
      if (mode.step === 'from') row.append(btn('Skip the move', 'secondary', () => {
        mode.step = 'done';
        rerender();
      }));
      row.append(btn('Place it', 'primary', () => send({ kind: 'use', card: mode.card, target: mode.target, ...(mode.from != null && mode.to != null ? { from: mode.from, to: mode.to } : {}) }), mode.step !== 'done'), cancel);
      break;
    }
    case 'exchange':
      p.append(el('div', 'act-head', mode.target == null ? `${name}: tap another card on your console to trade places with.` : `${name} and ${shortName(mode.target)} trade places?`));
      row.append(btn('Exchange them', 'primary', () => send({ kind: 'use', card: mode.card, target: mode.target }), mode.target == null), cancel);
      break;
    default:
      break;
  }
  p.append(row);
  box.append(p);
}

function renderAction(view) {
  const box = $('#action');
  box.replaceChildren();
  const m = me(view);
  const act = activeOf(view);
  const watching = isObserver(view);
  if (view.phase === 'over') {
    box.append(el('div', 'act-head', view.winners && view.winners.length > 1 ? 'The victory is shared.' : `${youOr(view, view.winners[0], 'You win', `${seatName(view, view.winners[0])} wins`)}!`));
    return;
  }

  if (view.phase === 'light') {
    box.append(el('div', 'act-head', 'Light-Speed: buy any of the six ships you were dealt.'));
    if (!m || watching) {
      box.append(el('div', 'act-sub', `Waiting for ${listWords(view.players.filter((p) => !p.chose).map((p) => p.name))}.`));
      return;
    }
    const offer = view.light.offers[m.seat];
    if (view.light.mine) {
      box.append(el('div', 'act-sub', `You buy ${view.light.mine.length ? listWords(view.light.mine.map((x) => shortName(x))) : 'nothing'}. Waiting for ${listWords(view.players.filter((p) => !p.chose).map((p) => p.name)) || 'the table'}.`));
      return;
    }
    lightPicks = lightPicks.filter((x) => offer.includes(x));
    const cost = lightPicks.reduce((s, x) => s + CARDS[x].cost, 0);
    box.append(el('div', 'act-sub', `${m.cr} credits; the ships are stationed in the order you pick them, and whoever keeps the most credits goes first.${lightPicks.length ? ` Picked: ${cost}.` : ''}`));
    const row = el('div', 'offer');
    for (const id of offer) {
      const on = lightPicks.includes(id);
      const can = on || cost + CARDS[id].cost <= m.cr;
      const card = cardEl(view, id, { cost: true, tag: 'button', cls: `${can ? 'can' : 'dim'}${on ? ' picked' : ''}`, key: 'offer' });
      card.disabled = !can;
      card.addEventListener('click', () => {
        lightPicks = on ? lightPicks.filter((x) => x !== id) : [...lightPicks, id];
        rerender();
      });
      row.append(card);
    }
    box.append(row);
    const r2 = el('div', 'act-row');
    r2.append(btn(lightPicks.length ? `Buy ${plural(lightPicks.length, 'ship')} for ${cost} and keep ${m.cr - cost}` : `Buy nothing and keep ${m.cr}`, 'primary', () => {
      const picks = lightPicks.slice();
      lightPicks = [];
      sendMove({ kind: 'lightspeed', cards: picks });
    }));
    box.append(r2);
    return;
  }

  box.append(diceRow(view));
  const mineNow = myTurn(view);

  if (view.phase === 'roll') {
    if (mineNow) {
      box.append(el('div', 'act-head', 'Your turn: roll the dice.'));
      const row = el('div', 'act-row');
      row.append(btn('🎲 Roll', 'primary big', () => send({ kind: 'roll' }), !!mode));
      box.append(row);
    } else {
      box.append(el('div', 'act-head', `${act.name} is about to roll.`));
    }
    if (m && !watching) {
      abilityButtons(view, box);
      modePanel(view, box);
    }
    return;
  }

  if (view.phase === 'reroll') {
    if (mineNow) {
      box.append(el('div', 'act-head', 'Roll again with a charge, or keep these dice.'));
      const row = el('div', 'act-row');
      for (const u of view.can.use.filter((x) => x.kind === 'reroll')) {
        const nm = shortName(u.id);
        const [a, b] = view.dice;
        // a double: rolling either die again is the same thing
        if (a === b) row.append(btn(`${nm}: one ${a} again`, 'secondary', () => send({ kind: 'use', card: u.id, dice: [0] })));
        else {
          row.append(btn(`${nm}: the ${a} again`, 'secondary', () => send({ kind: 'use', card: u.id, dice: [0] })));
          row.append(btn(`${nm}: the ${b} again`, 'secondary', () => send({ kind: 'use', card: u.id, dice: [1] })));
        }
        row.append(btn(`${nm}: both`, 'secondary', () => send({ kind: 'use', card: u.id, dice: [0, 1] })));
      }
      row.append(btn('Keep these', 'primary', () => send({ kind: 'keep' })));
      box.append(row);
    } else {
      box.append(el('div', 'act-head', `${act.name} may roll again before anyone takes the dice.`));
    }
    return;
  }

  if (view.phase === 'alloc') {
    const waiting = view.players.filter((p) => !p.chose);
    if (view.alloc && view.alloc.pick == null) {
      box.append(el('div', 'act-head', mineNow ? 'Take the dice — your station rewards:' : 'Take the dice — your deployed rewards:'));
      const list = el('div', 'opts');
      view.alloc.options.forEach((o, i) => list.append(optionEl(view, o, i)));
      box.append(list);
    } else if (view.alloc) {
      const o = view.alloc.options[view.alloc.pick];
      box.append(el('div', 'act-head', m.auto ? 'Taken for you — no other way does better:' : 'You take:'));
      box.append(optionEl(view, o, view.alloc.pick, true));
    }
    if (waiting.length) box.append(el('div', 'act-sub wait', `Waiting for ${listWords(waiting.map((p) => youOr(view, p.seat)))}.`));
    return;
  }

  if (view.phase === 'claim') {
    if (mineNow) {
      const left = LEVELS.filter((l) => view.claim.left[l]).map((l) => `${NUMWORD[view.claim.left[l]]} level ${l}`);
      box.append(el('div', 'act-head', `Claim up to ${listWords(left)} free — tap ${Object.values(view.claim.left).reduce((a, b) => a + b, 0) > 1 ? 'them' : 'it'} in the shipyard.`));
      const row = el('div', 'act-row');
      row.append(btn(claimPicks.length ? `Claim ${listWords(claimPicks.map((x) => shortName(x)))}` : 'Claim nothing', 'primary', () => send({ kind: 'claim', cards: claimPicks })));
      box.append(row);
    } else {
      box.append(el('div', 'act-head', `${act.name} is claiming ships from the shipyard.`));
    }
    return;
  }

  if (view.phase === 'buy') {
    if (mineNow) {
      if (!view.bought) {
        if (selBuy != null) {
          const c = CARDS[selBuy];
          box.append(el('div', 'act-head', `Buy ${c.name} for ${c.cost}${m.cr > c.cost ? ` — it spends all ${m.cr} of your credits` : ''}?`));
          const row = el('div', 'act-row');
          row.append(btn(`Buy ${shortName(selBuy)}`, 'primary', () => send({ kind: 'buy', card: selBuy })), btn('Cancel', 'ghost', () => {
            selBuy = null;
            rerender();
          }));
          box.append(row);
        } else {
          box.append(el('div', 'act-head', view.can.buy.length ? `Buy one card — it spends all ${plural(m.cr, 'credit')} — or end your turn.` : `Nothing you can buy with ${plural(m.cr, 'credit')}.`));
        }
      } else {
        box.append(el('div', 'act-head', 'Bought. Use any charged ability, or end your turn.'));
      }
      const row = el('div', 'act-row');
      row.append(btn(view.bought ? 'End turn' : `End turn, keeping ${plural(m.cr, 'credit')}`, view.bought || !view.can.buy.length ? 'primary' : 'secondary', () => send({ kind: 'end' }), !!mode));
      box.append(row);
    } else {
      box.append(el('div', 'act-head', `${act.name} is buying.`));
    }
    if (m && !watching) {
      abilityButtons(view, box);
      modePanel(view, box);
    }
  }
}

// ---------------------------------------------------------------- what just happened

// a moment's note over a player's seat — what they gained or bought
function stamp(seat, content, cls) {
  const host = document.querySelector(`.seat[data-seat="${seat}"]`);
  if (!host || !host.offsetParent) return;
  let layer = $('#fx-layer');
  if (!layer) {
    layer = el('div', '');
    layer.id = 'fx-layer';
    document.body.append(layer);
  }
  const r = host.getBoundingClientRect();
  const n = el('div', `stamp ${cls}`);
  n.append(...content);
  const ms = cfg('stampMs');
  n.style.left = `${Math.round(r.left + r.width / 2)}px`;
  n.style.top = `${Math.round(r.top + r.height / 2)}px`;
  n.style.animationDuration = `${ms}ms`;
  layer.append(n);
  setTimeout(() => n.remove(), ms + 60);
}

function showFx(view, f) {
  const you = f.seat === view.you && !isObserver(view);
  const name = seatName(view, f.seat);
  switch (f.kind) {
    case 'gain': {
      const bits = [];
      if (f.cr) bits.push(rw('cr', `+${f.cr}`));
      if (f.inc) bits.push(rw('inc', `+${f.inc}`));
      if (f.vp) bits.push(rw('vp', `+${f.vp}`));
      if (f.cubes) bits.push(el('span', 'rw cube', `+${f.cubes}`));
      return stamp(f.seat, bits, 'gain');
    }
    case 'buy':
      return stamp(f.seat, [el('b', '', `${f.free ? 'Claims' : 'Buys'} ${shortName(f.card)}`), el('small', '', ` → ${f.sector}`)], 'buy');
    case 'swap':
      return stamp(f.seat, [el('b', '', `Sectors ${f.a} ⇄ ${f.b}`)], 'buy');
    case 'exchange':
      return stamp(f.seat, [el('b', '', `${shortName(f.a)} ⇄ ${shortName(f.b)}`)], 'buy');
    case 'charge':
      return stamp(f.seat, [el('span', 'rw cube', '+1'), el('small', '', ` on ${shortName(f.card)}`)], 'gain');
    case 'set':
      return stamp(f.seat, [el('b', '', 'Sets a die: '), dieEl(f.value, 'mini')], 'buy');
    case 'roll':
      if (f.reroll) return stamp(f.seat, [el('b', '', 'Rolls again')], 'buy');
      return null;
    case 'ending':
      return flash(`${you ? 'You reach' : `${name} reaches`} ${WIN_VP} VP — the last round`, 'plain');
    case 'tie':
      return flash('A tie — one more round', 'plain');
    default:
      return null;
  }
}

function playFx(view) {
  const list = view.fxs || [];
  if (!list.length) return;
  const fresh = list.filter((f) => f.seq > lastFxSeq).slice(-10);
  lastFxSeq = Math.max(lastFxSeq, list[list.length - 1].seq);
  fresh.forEach((f, i) => setTimeout(() => showFx(view, f), i * 220));
}

// ---------------------------------------------------------------- the whole screen

function renderGame(view, sess) {
  lastView = view;
  renderDcBanner(view, sess);
  renderObBar(view, sess);
  renderWatchChip(view);
  ensureResignBtn(sess);
  if (viewMid !== view.mid) {
    viewMid = view.mid;
    clearSel();
    lightPicks = [];
    stepKey = null;
    hoverLit = null;
    const list = view.fxs || [];
    lastFxSeq = list.length ? list[list.length - 1].seq : 0;
  }
  // a new step of the turn clears whatever was half chosen for the last one
  const key = `${view.phase}:${view.turn}:${view.round}:${view.rolls}`;
  if (key !== stepKey) {
    stepKey = key;
    clearSel();
    hoverLit = null;
  }
  // what was picked and is no longer there
  const m = me(view);
  if (selBuy != null && !(view.can && view.can.buy.includes(selBuy))) selBuy = null;
  if (mode && !(view.can && view.can.use.some((u) => u.id === mode.card))) mode = null;
  if (mode && mode.picks) mode.picks = mode.picks.filter((x) => view.yard[CARDS[x].level]?.includes(x) || view.colonies.includes(x));
  if (claimPicks.length && view.claim) claimPicks = claimPicks.filter((x) => view.claim.cards.includes(x));
  if (!m || isObserver(view)) clearSel();

  $('#room-chip').textContent = view.code || '·····';
  const tc = $('#turn-chip');
  const mineTurn = myTurn(view);
  tc.textContent = view.phase === 'over' ? 'Game over' : view.phase === 'light' ? 'Light-Speed' : mineTurn ? 'Your turn' : `${seatName(view, view.turn)}’s turn`;
  tc.classList.toggle('mine', mineTurn);
  $('#round-chip').textContent = view.phase === 'light' ? '' : `Round ${view.round}`;
  const lc = $('#last-chip');
  lc.classList.toggle('hidden', !view.ending || view.phase === 'over');
  if (view.ending) {
    const firstIdx = view.players.findIndex((p) => p.seat === view.first);
    const lastP = view.players[(firstIdx + view.players.length - 1) % view.players.length];
    lc.textContent = view.tieRound ? 'Tie: one more round' : 'Last round';
    lc.dataset.tip = `${seatName(view, view.ending.seat)} reached ${WIN_VP} VP. The round ends with ${youOr(view, lastP.seat, 'you', lastP.name)}, so everyone plays as many turns.${view.tieRound ? ' The top was tied, so one more round is being played; if it is still tied, the victory is shared.' : ''}`;
    lc.dataset.tipKey = 'last';
  }

  renderAction(view);
  renderConsoles(view);
  renderYard(view);
  renderLog(view);
  paintChatBubbles();
  retip();
  playFx(view);
  revealPrompt(view);
  settleOverlay('#gameover', view.phase === 'over', () => showGameover(view, sess));
}

// On a phone the prompt sits above a long table; when the table starts
// waiting on you, the prompt is brought into view, once, if it is off the
// screen.
function revealPrompt(view) {
  const mine = !isObserver(view) && !!me(view) && ((view.phase === 'alloc' && view.alloc && view.alloc.pick == null) || (myTurn(view) && ['roll', 'reroll', 'claim', 'buy'].includes(view.phase)) || (view.phase === 'light' && !view.light.mine));
  if (mine && !wasMine) {
    const box = $('#action');
    const r = box.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) {
      const still = document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      box.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' });
    }
  }
  wasMine = mine;
}

// ---------------------------------------------------------------- game over

let confettiDone = false;

function showGameover(view, sess) {
  const m = $('#gameover');
  m.classList.remove('hidden');
  const winners = view.winners || [];
  const watching = isObserver(view);
  const won = !watching && winners.includes(view.you);
  const names = winners.map((s) => (s === view.you && !watching ? 'You' : seatName(view, s)));
  $('#go-title').textContent = names.length === 1 ? (names[0] === 'You' ? 'You win!' : `${names[0]} wins`) : `${listWords(names)} share the victory`;
  $('#go-sub').textContent = view.why ? `${view.why.charAt(0).toUpperCase()}${view.why.slice(1)}.` : '';
  const list = $('#go-rank');
  list.replaceChildren();
  const order = view.players.slice().sort((a, b) => (winners.includes(b.seat) - winners.includes(a.seat)) || b.vp - a.vp || b.cr - a.cr);
  for (const p of order) {
    const row = el('li', `rank-row${p.seat === view.you ? ' me' : ''}${winners.includes(p.seat) ? ' won' : ''}`);
    row.append(avatarEl(p.name, p.seat, p.bot));
    const nm = el('span', 'rank-name');
    const colonies = p.station.filter((id) => id != null && CARDS[id].kind === 'colony').length;
    const bits = [`${plural(p.cr, 'credit')}`, `${p.inc} income`, `${p.turns} turn${p.turns === 1 ? '' : 's'}`];
    if (colonies) bits.push(`${colonies} ${colonies === 1 ? 'colony' : 'colonies'}`);
    nm.append(el('b', '', p.name + (p.connected || p.bot ? '' : ' (left)')), el('small', '', bits.join(' · ')));
    row.append(nm, el('span', 'rank-score', `${p.vp} VP`));
    list.append(row);
  }
  $('#btn-again').classList.toggle('hidden', !sess.isHost);
  $('#btn-golobby').classList.toggle('hidden', !sess.isHost);
  $('#go-wait').classList.toggle('hidden', sess.isHost);
  if (won && !confettiDone) {
    confettiDone = true;
    confetti();
  }
}

// ---------------------------------------------------------------- tips

// What a mark, a token or a number means. The browser's own title tooltip
// waits a second or more and never appears on a phone, so the game draws its
// own: a mouse gets one after a short pause, and a tap on anything that is not
// a move pins one until the next tap. Elements opt in with data-tip; data-tip-key
// finds the element again after a redraw.
const TIP_DELAY = 110;
const TIP_SEL = '[data-tip]';
let tipEl = null;
let tipFor = null;
let tipKey = null;
let tipPinned = false;
let tipTimer = null;
let tipDropped = null;

// What a card or a character says, for the tip that explains it: a card
// gets its name, colour, suit and value, its text, and why it cannot be
// what a thing at the table means, for the tip that explains it
function tipBody(a) {
  return a.dataset.tip ? el('div', 'tb-card', a.dataset.tip) : null;
}

function showTip(a, pinned = false) {
  clearTimeout(tipTimer);
  const body = tipBody(a);
  if (!body) return hideTip();
  if (!tipEl) {
    tipEl = el('div', 'tb-tip hidden');
    tipEl.id = 'tb-tip';
    tipEl.setAttribute('role', 'tooltip');
    document.body.append(tipEl);
  }
  if (tipFor && tipFor !== a) tipFor.classList.remove('tip-on');
  tipEl.replaceChildren(body);
  tipFor = a;
  tipKey = a.dataset.tipKey || null;
  tipPinned = pinned;
  a.classList.toggle('tip-on', pinned);
  // measure it where it stands, then put it above the thing it explains —
  // or below, when there is no room above
  tipEl.style.left = '0px';
  tipEl.style.top = '0px';
  tipEl.classList.remove('hidden');
  const r = a.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const w = tipEl.offsetWidth;
  const h = tipEl.offsetHeight;
  const x = Math.max(8, Math.min(vw - w - 8, r.left + r.width / 2 - w / 2));
  let y = r.top - h - 8;
  if (y < 8) y = r.bottom + 8;
  if (y + h > vh - 8) y = Math.max(8, vh - h - 8);
  tipEl.style.left = `${Math.round(x)}px`;
  tipEl.style.top = `${Math.round(y)}px`;
}

function hideTip() {
  clearTimeout(tipTimer);
  if (tipFor) tipFor.classList.remove('tip-on');
  tipFor = null;
  tipKey = null;
  tipPinned = false;
  if (tipEl) tipEl.classList.add('hidden');
}

// A tap that is a question rather than a move. Tapping the same thing again
// puts the answer away.
function pinTip(a) {
  const key = a.dataset.tipKey || null;
  if (tipDropped && key && tipDropped.key === key && Date.now() - tipDropped.at < 600) {
    tipDropped = null;
    return;
  }
  showTip(a, true);
}

// A redraw replaces every element, so a tip that is up follows its thing to
// the new copy, or goes if the thing has gone.
function retip() {
  if (!tipFor) return;
  if (document.contains(tipFor)) return;
  const a = tipKey ? document.querySelector(`[data-tip-key="${CSS.escape(tipKey)}"]`) : null;
  if (a) showTip(a, tipPinned);
  else hideTip();
}

function initTips() {
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const a = e.target.closest && e.target.closest(TIP_SEL);
    if (!a || a === tipFor) return;
    if (tipPinned) return;
    clearTimeout(tipTimer);
    // sliding from one tip to the next should not wait again
    tipTimer = setTimeout(() => showTip(a), tipFor ? 0 : TIP_DELAY);
  });
  document.addEventListener('pointerout', (e) => {
    if (e.pointerType !== 'mouse') return;
    const a = e.target.closest && e.target.closest(TIP_SEL);
    if (!a || (e.relatedTarget && a.contains(e.relatedTarget))) return;
    clearTimeout(tipTimer);
    if (!tipPinned && tipFor) tipTimer = setTimeout(hideTip, 60);
  });
  // any tap puts a pinned tip away; if it lands on the same thing, the click
  // that follows knows not to bring it straight back
  document.addEventListener('pointerdown', (e) => {
    if (!tipPinned) return;
    const a = e.target.closest && e.target.closest(TIP_SEL);
    tipDropped = a && a === tipFor && tipKey ? { key: tipKey, at: Date.now() } : null;
    hideTip();
  }, true);
  // plain words on a chip or a count have no move behind them, so a tap reads them
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('[data-tip]');
    if (a && !a.closest('button')) pinTip(a);
  });
  document.addEventListener('focusin', (e) => {
    const a = e.target.closest && e.target.closest(TIP_SEL);
    if (a && e.target.matches(':focus-visible')) showTip(a);
  });
  document.addEventListener('focusout', () => {
    if (!tipPinned) hideTip();
  });
  // the page scrolling moves what a tip points at; the log scrolling itself
  // as lines arrive does not, so this listens to the page alone
  window.addEventListener('scroll', () => hideTip(), { passive: true });
  window.addEventListener('resize', () => hideTip());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideTip();
  });
}

function renderObBar(view, sess) {
  let bar = $('#ob-bar');
  const on = !!view.observer;
  if (!bar) {
    if (!on) return;
    bar = el('div', '');
    bar.id = 'ob-bar';
    const anchor = $('#table');
    anchor.parentNode.insertBefore(bar, anchor);
  }
  bar.classList.toggle('on', on);
  bar.replaceChildren();
  if (!on) return;
  const cur = view.players.find((p) => p.seat === view.observer.target);
  const row = el('div', 'ob-row');
  row.append(el('span', 'ob-msg', `\u{1F441} Watching ${cur ? cur.name : '?'}'s view \u2014 you can chat, but not act.`));
  const sw = el('div', 'ob-switch');
  for (const p of view.players) {
    const b = el('button', 'ob-btn' + (p.seat === view.observer.target ? ' on' : ''), p.name);
    b.type = 'button';
    b.onclick = () => sess.watch(p.seat);
    sw.append(b);
  }
  row.append(sw);
  const tgt = view.players.find((p) => p.seat === view.observer.target);
  if (tgt && !tgt.connected && !tgt.bot) {
    const claim = el('button', 'ob-btn claim', `\u{1FA91} Take ${tgt.name}'s seat`);
    claim.type = 'button';
    claim.onclick = () => sess.claim(view.observer.target);
    row.append(claim);
  }
  bar.append(row);
}

function renderWatchChip(view) {
  const anchor = $('#room-chip');
  if (!anchor) return;
  let chip = $('#watch-chip');
  const names = view.watchers || [];
  if (!chip) {
    if (!names.length) return;
    chip = el('span', '');
    chip.id = 'watch-chip';
    anchor.parentNode.insertBefore(chip, anchor.nextSibling);
  }
  chip.classList.toggle('on', names.length > 0);
  chip.textContent = names.length ? `\u{1F441} ${names.length}` : '';
  chip.title = names.length ? `Watching: ${names.join(', ')}` : '';
}

function renderLobbyWatch(lob, sess) {
  const anchor = $('#lobby-code');
  if (!anchor) return;
  let chip = $('#lobby-watch');
  const names = lob.watchers || [];
  const mine = !!(sess && sess.observer);
  if (!chip) {
    if (!names.length && !mine) return;
    chip = el('div', '');
    chip.id = 'lobby-watch';
    anchor.parentNode.insertBefore(chip, anchor.nextSibling);
  }
  chip.classList.toggle('on', names.length > 0 || mine);
  chip.replaceChildren();
  if (mine) {
    chip.append(el('span', '', `\u{1F441} You are watching \u2014 the game appears here when it starts.`));
    if ((lob.players || []).length < MAX_PLAYERS) {
      const b = el('button', '', `\u{1FA91} Take a seat`);
      b.type = 'button';
      b.onclick = () => sess.claim(null);
      chip.append(b);
    }
  } else if (names.length) {
    chip.append(el('span', '', `\u{1F441} ${names.length} watching: ${names.join(', ')}`));
  }
}

// A seated guest may hand back their seat and keep watching. Two-step arm so
// a stray click cannot forfeit a seat; injected beside each screen's Leave.
function ensureResignBtn(sess) {
  for (const scr of ['game', 'lobby']) {
    const anchor = document.querySelector(`#screen-${scr} .btn-leave`);
    if (!anchor) continue;
    let b = document.querySelector(`#btn-resign-${scr}`);
    if (!b) {
      b = el('button', anchor.className.split(/\s+/).filter((c) => c !== 'btn-leave').join(' '), '');
      b.id = `btn-resign-${scr}`;
      b.type = 'button';
      b.addEventListener('click', () => {
        if (!session || session.isHost || session.observer) return;
        if (b.dataset.armed) {
          delete b.dataset.armed;
          session.resign();
        } else {
          b.dataset.armed = '1';
          b.textContent = 'Really hand back your seat?';
          setTimeout(() => {
            delete b.dataset.armed;
            b.textContent = '\u{1F441} Watch instead';
          }, 4000);
        }
      });
      anchor.parentNode.insertBefore(b, anchor);
    }
    if (!b.dataset.armed) b.textContent = '\u{1F441} Watch instead';
    b.classList.toggle('hidden', !sess || sess.isHost || !!sess.observer);
  }
}

function renderDcBanner(view, sess) {
  let bar = $('#dc-banner');
  if (!bar) {
    bar = el('div', '');
    bar.id = 'dc-banner';
    const anchor = $('#table');
    anchor.parentNode.insertBefore(bar, anchor);
  }
  bar.replaceChildren();
  const gone = view.phase !== 'over' ? view.players.filter((p) => !p.connected && !p.bot) : [];
  bar.classList.toggle('on', gone.length > 0);
  for (const p of gone) {
    const row = el('div', 'dc-row' + (p.botFor ? ' covered' : ''));
    row.append(
      el(
        'span',
        'dc-msg',
        p.botFor
          ? `🤖 A bot is playing for ${p.name} until they return.`
          : p.resigned
            ? `🪑 ${p.name} handed back their seat — an observer can take it over.`
            : `⚠️ ${p.name} lost connection — the game is waiting for them.`,
      ),
    );
    if (!p.botFor && sess && sess.isHost) {
      const b = el('button', 'dc-btn', '🤖 Let a bot take over');
      b.onclick = () => sess.botTakeover(p.seat);
      row.append(b);
    }
    bar.append(row);
  }
}


// ---------------------------------------------------------------- log

let logLines = [];
let logMid = null;

function renderLog(view) {
  const key = String(view.mid);
  if (key !== logMid) {
    logMid = key;
    logLines = [];
    $('#feed').replaceChildren();
  }
  const have = new Set(logLines.map((l) => l.id));
  let added = false;
  for (const item of view.log || []) {
    if (item && typeof item === 'object' && !have.has(item.id)) {
      logLines.push(item);
      added = true;
    }
  }
  if (!added && logLines.length === $('#feed').children.length) return;
  logLines.sort((a, b) => a.id - b.id);
  if (logLines.length > 200) logLines = logLines.slice(-200);
  const feed = $('#feed');
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 24;
  feed.replaceChildren(...logLines.map((l) => el('div', 'feed-line', l.text)));
  if (atBottom) feed.scrollTop = feed.scrollHeight;
}

// Overlays hold back a good while so the final placement stays visible.
const overlayTimers = new Map();
const overlayPending = new Map();

function settleOverlay(sel, wanted, show) {
  const node = $(sel);
  const pending = overlayTimers.get(sel);
  if (!wanted) {
    if (pending) clearTimeout(pending);
    overlayTimers.delete(sel);
    overlayPending.delete(sel);
    node.classList.add('hidden');
    confettiDone = false;
    return;
  }
  overlayPending.set(sel, show);
  if (!node.classList.contains('hidden')) {
    show();
    return;
  }
  if (pending) return;
  overlayTimers.set(
    sel,
    setTimeout(() => {
      // the newest render's screen, not the one that started the wait
      const latest = overlayPending.get(sel) || show;
      overlayTimers.delete(sel);
      overlayPending.delete(sel);
      latest();
    }, cfg('overlayDelay')),
  );
}

function flushOverlays() {
  for (const [sel, show] of overlayPending) {
    const t = overlayTimers.get(sel);
    if (t) clearTimeout(t);
    overlayTimers.delete(sel);
    show();
  }
  overlayPending.clear();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) flushOverlays();
});

function hideOverlays() {
  for (const t of overlayTimers.values()) clearTimeout(t);
  overlayTimers.clear();
  overlayPending.clear();
  $('#gameover').classList.add('hidden');
  confettiDone = false;
}

function confetti() {
  const box = $('#confetti');
  box.replaceChildren();
  for (let i = 0; i < 70; i++) {
    const p = el('i');
    p.style.left = `${Math.random() * 100}%`;
    p.style.animationDelay = `${Math.random() * 0.9}s`;
    p.style.animationDuration = `${2.2 + Math.random() * 1.6}s`;
    p.style.background = `hsl(${Math.floor(Math.random() * 360)} 85% 60%)`;
    box.append(p);
  }
  setTimeout(() => box.replaceChildren(), 4500);
}

// ---------------------------------------------------------------- actions

function sendMove(move) {
  if (session && session.observer) {
    toast('You are watching \u2014 only the seated player can act');
    return;
  }
  if (pendingMove || !session) return;
  pendingMove = true;

  session.localMove(move);
  if (lastView && !session.isHost) renderGame(lastView, session);
}

async function createRoom() {
  const name = cleanName($('#name-input').value) || 'Host';
  localStorage.setItem('sb-name', name);
  setBusy(true);
  setHomeStatus('Creating room…');
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = genCode();
    try {
      const peer = await openPeer(ID_PREFIX + code);
      session = new HostSession(peer, code, name);
      setHomeStatus('');
      setBusy(false);
      return;
    } catch (e) {
      if (e && e.type === 'unavailable-id') continue;
      setBusy(false);
      setHomeStatus(explainPeerError(e), true);
      return;
    }
  }
  setBusy(false);
  setHomeStatus('Could not allocate a room code — please try again.', true);
}

async function joinRoom() {
  const name = cleanName($('#name-input').value) || 'Guest';
  const code = parseCode($('#code-input').value);
  if (code.length < 4) {
    setHomeStatus('Enter the room code first.', true);
    return;
  }
  localStorage.setItem('sb-name', name);
  setBusy(true);
  setHomeStatus(`Joining ${code}…`);
  try {
    const peer = await openPeer();
    session = new GuestSession(peer, code, name);
  } catch (e) {
    setBusy(false);
    setHomeStatus(explainPeerError(e), true);
  }
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => toast('Copied!'),
      () => toast(text),
    );
  } else {
    toast(text);
  }
}

function leave() {
  clearRejoin();
  if (session) session.destroy();
  session = null;
  location.href = location.pathname;
}

// ---------------------------------------------------------------- boot

function init() {
  $('#name-input').value = localStorage.getItem('sb-name') || '';
  initTips();

  const room = parseCode(new URLSearchParams(location.search).get('room') || '');
  if (room) {
    $('#code-input').value = room;
    setHomeStatus(`Invited to room ${room} — enter your name and press Join.`);
    $('#name-input').focus();
  }

  $('#btn-create').addEventListener('click', createRoom);
  $('#btn-join').addEventListener('click', joinRoom);
  $('#code-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinRoom();
  });
  $('#name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') (room || $('#code-input').value ? joinRoom : createRoom)();
  });

  $('#btn-copy-code').addEventListener('click', () => copyText(session ? session.code : ''));
  $('#btn-copy-link').addEventListener('click', () => copyText(session ? roomLink(session.code) : ''));
  $('#btn-start').addEventListener('click', () => session && session.isHost && session.start());
  $('#btn-add-bot').addEventListener('click', () => session && session.isHost && session.addBot());
  $('#btn-again').addEventListener('click', () => session && session.isHost && session.again());
  $('#btn-golobby').addEventListener('click', () => session && session.isHost && session.toLobby());

  $('#chat-toggle').addEventListener('click', () => {
    if ($('#chat-panel').classList.contains('hidden')) openChatPanel();
    else $('#chat-panel').classList.add('hidden');
  });
  $('#chat-peek').addEventListener('click', openChatPanel);
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = $('#chat-input');
    const text = inp.value.trim();
    if (text && session) session.sendChat(text);
    inp.value = '';
  });

  // the table is laid out for the space it has
  let resizeFrame = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      if (lastView && session && !$('#screen-game').classList.contains('hidden')) renderGame(lastView, session);
    });
  });

  for (const b of document.querySelectorAll('.btn-leave')) b.addEventListener('click', leave);
  for (const b of document.querySelectorAll('.btn-rules')) {
    b.addEventListener('click', () => $('#modal-rules').classList.remove('hidden'));
  }
  $('#btn-rules-close').addEventListener('click', () => $('#modal-rules').classList.add('hidden'));
  $('#modal-rules').addEventListener('click', (e) => {
    if (e.target === $('#modal-rules')) $('#modal-rules').classList.add('hidden');
  });

  window.addEventListener('beforeunload', () => {
    if (session) session.destroy();
  });

  if (typeof Peer === 'undefined') {
    setHomeStatus('Could not load the PeerJS library — multiplayer needs it. Check your connection and refresh.', true);
    setBusy(true);
  }
}

init();

