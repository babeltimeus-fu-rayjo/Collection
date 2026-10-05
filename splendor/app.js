// app.js — networking + UI for Splendor.
//
// Topology: host-authoritative star over WebRTC data channels.
//   - The host's browser owns the game and validates every move.
//   - Guests connect straight to the host (peer-to-peer); no game server.
//   - NAT traversal uses Google's public STUN servers (see RTC_CONFIG).
//   - Peer discovery/signaling uses the free PeerJS cloud broker, because
//     GitHub Pages can only serve static files.
// Splendor hides almost nothing: every view shows the whole table but the
// decks and the cards others reserved blind from them. Bots fill empty seats
// and play in the host's browser, and take over for anyone who disconnects.

import {
  PROTO,
  MIN_PLAYERS,
  MAX_PLAYERS,
  GEMS,
  GOLD,
  TOKENS,
  GEM,
  GEMS_FOR,
  WIN_POINTS,
  TOKEN_LIMIT,
  RESERVE_LIMIT,
  MODULES,
  CITIES,
  TRADING_POSTS,
  STRONGHOLDS,
  defaultOpts,
  tokenWords,
  canStart,
  newGame,
  applyMove,
  viewFor,
  botChoose,
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
const cfg = initSettings('spl', [
  { key: 'botTurn', label: 'Bot takes its turn in', def: [1500, 700], section: 'Host pacing', host: true, hint: 'How long a bot thinks before taking gems, reserving or buying.' },
  { key: 'botAfter', label: 'Bot gives back or picks a Noble in', def: [800, 400], section: 'Host pacing', host: true },
  { key: 'stampMs', label: 'Moves show for', def: 1600, section: 'Bubbles & banners' },
  { key: 'bubbleChat', label: 'Chat bubbles linger', def: 6500, section: 'Bubbles & banners' },
  { key: 'bubbleTrunc', label: 'Bubble text cap', def: 84, min: 12, max: 400, step: 4, unit: 'ch', ms: false, section: 'Bubbles & banners' },
  { key: 'flashMs', label: 'Banner duration', def: 1900, section: 'Bubbles & banners' },
  { key: 'overlayDelay', label: 'Result screen delay', def: 2600, section: 'Overlays' },
  { key: 'revealBots', label: "Show the bots' blind reserves", def: false, bool: true, section: 'Testing', host: true, hint: 'Turns face up the cards bots reserved from the top of a deck. Only the host builds views, so this shows them to everyone.' },
]);
const viewOpts = () => ({ revealBots: cfg.on('revealBots') });

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
const ID_PREFIX = 'spl-v1-';
// Renaissance merchants' first names — none of them a Noble's
const BOT_NAMES = ['Lorenzo', 'Bianca', 'Matteo', 'Fiora', 'Tommaso', 'Ginevra', 'Piero', 'Livia'];
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

  // A card reserved blind is secret, so a watcher may take over an abandoned
  // seat only if it is the only view they have ever had — someone who has
  // stood behind another player's chair has seen that player's reserves.
  claimOk(w, seat) {
    if (!w.seen) return true;
    for (const s of w.seen) if (s !== seat) return false;
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
          ...viewFor(this.G, w.target, this.code, viewOpts()),
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

  // The lobby's modules from the two expansion boxes, each on or off; the
  // boxes' two Nobles cannot come with the Cities, which replace the Nobles.
  toggleModule(key) {
    if (this.G || !MODULES.some((m) => m.key === key)) return;
    this.opts = { ...this.opts, [key]: !this.opts[key] };
    if (key === 'cities' && this.opts.cities) this.opts.nobles = false;
    if (key === 'nobles' && this.opts.nobles) this.opts.cities = false;
    this.pushLobby();
  }

  removeBot(seat) {
    if (this.G) return;
    if (!this.roster.some((r) => r.seat === seat && r.bot)) return;
    this.roster = this.roster.filter((r) => r.seat !== seat);
    this.pushLobby();
  }

  // The host's clock lets the bots act, one turn at a time so the table can
  // see who took what, reserved what and bought what.
  schedule(ms) {
    clearTimeout(this.tickTimer);
    if (!this.G || this.G.phase === 'over') return;
    this.tickTimer = setTimeout(() => this.tick(), Math.max(20, ms));
  }

  botDelay() {
    const a = this.G.ask;
    if (!a) return 1000;
    return cfg.range(a.kind === 'turn' ? 'botTurn' : 'botAfter');
  }

  tick() {
    const G = this.G;
    if (!G || G.phase === 'over') return;
    const seat = waitingOn(G).find((s) => this.seatCovered(s));
    if (seat != null) {
      const mv = botChoose(G, seat);
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

  // Everyone's view of the table as it stands. A change to what views show,
  // like marking the bots' Characters, re-sends them without touching the
  // game or the bots' clock.
  pushViews() {
    if (!this.G) return;
    const wnames = this.watchers.map((x) => x.name);
    const opts = viewOpts();
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
            full: 'That room is full (4 players max).',
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

const REJOIN_KEY = 'spl-rejoin';

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



// ---------------------------------------------------------------- gems, cards and Nobles, as the table shows them

const SVGNS = 'http://www.w3.org/2000/svg';
const gemName = (g) => GEM[g].name;
const sumOf = (o) => Object.values(o).reduce((a, b) => a + (b || 0), 0);
const LEVEL_DOTS = { 1: '●', 2: '●●', 3: '●●●' };
const isCopy = (c) => c.kind === 'copy' || c.kind === 'copytake';

function listWords(a) {
  return a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}

// Each gem has its own shape (drawn once, in index.html), so no colour ever
// has to be told apart on its own.
function gemSvg(g, cls = '') {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('class', `gem g-${g}${cls ? ` ${cls}` : ''}`);
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(SVGNS, 'use');
  u.setAttribute('href', `#gem-${g}`);
  s.append(u);
  return s;
}

// a token: the gem in a ring of its colour, and how many
function tokenEl(g, count, cls = '', tag = 'span') {
  const n = el(tag, `tok t-${g}${cls ? ` ${cls}` : ''}${count === 0 ? ' none' : ''}`);
  if (tag === 'button') n.type = 'button';
  n.append(gemSvg(g));
  if (count != null) n.append(el('b', 'tok-n', String(count)));
  return n;
}

// the cost circles, in the order the cards print them — or, for a card
// bought by sacrifice, the two cards of its colour to discard
function costEl(c) {
  const box = el('span', 'cd-cost');
  if (c.kind === 'sacrifice') {
    for (let i = 0; i < 2; i++) box.append(el('span', `cs t-${c.discard}`, '✕'));
    return box;
  }
  for (const g of GEMS) if (c.cost[g]) box.append(el('span', `cc t-${g}`, String(c.cost[g])));
  return box;
}

// what an Orient card does, in words
const POWER_WORDS = {
  gold: 'No colour and no bonus. When you buy a card, you may discard it to pay 2 Gold for that purchase alone; it goes back to the box.',
  copy: 'When you buy it, it takes the colour and bonus of a card of yours that has one — you must own one to buy it.',
  copytake: 'When you buy it, it takes the colour and bonus of a card of yours; then take a face-up level-1 card for free, its effects too.',
  double: 'Two bonuses of its colour to pay with — but one card of that colour for every Noble, Trading Post and City.',
  take: 'When you buy it, take a face-up level-2 card for free, its effects too.',
  sacrifice: 'Paid not in gems but by discarding two cards of the colour shown — copy cards of that colour first. They go back to the box.',
};

function cardTitle(c) {
  const kind = c.kind === 'gold' ? 'Gold card' : isCopy(c) && !c.bonus ? 'copy card' : `${gemName(c.bonus)} ${c.kind === 'double' ? 'double-bonus card' : 'card'}`;
  return `Level ${c.level}${c.orient ? ' Orient' : ''} ${kind}`;
}

function cardTipText(c, view) {
  const parts = [`${cardTitle(c)}${c.points ? `, ${c.points} Prestige point${c.points === 1 ? '' : 's'}` : ''}: ${c.kind === 'sacrifice' ? `costs two ${gemName(c.discard)} cards, discarded` : `costs ${tokenWords(c.cost) || 'nothing'}`}.`];
  if (c.orient) parts.push(POWER_WORDS[c.kind]);
  else parts.push(`Bought, it is ${ONE_WORD[c.bonus]} bonus for good — one ${gemName(c.bonus)} off every later card.`);
  const my = view && !isObserver(view) ? me(view) : null;
  if (my && (tableCards(view).some((x) => x.id === c.id) || my.reserved.some((r) => r.id === c.id))) {
    const buy = view.buys[c.id];
    if (buy) parts.push(buyWords(buy));
    else if (!blockedFor(view, c.id)) parts.push(shortWords(view, my, c));
  }
  return parts.join(' ');
}

function buyWords(buy) {
  if (buy.sacrifice) return `You could buy it by discarding two ${gemName(buy.sacrifice.colour)} cards.`;
  return buy.plans[0] ? `You could buy it ${payLabel(buy.plans[0])}.` : '';
}

// A Development card as printed: Prestige points and the bonus gem across the
// top, the cost down the left, the level's dots at the foot. An Orient card
// shows its power where the base cards have nothing.
function cardEl(c, view, cls = '', tag = 'div') {
  const n = el(tag, `card ${c.bonus ? `b-${c.bonus}` : `b-${c.kind}`} lv${c.level}${c.orient ? ' orient' : ''}${cls ? ` ${cls}` : ''}`);
  if (tag === 'button') n.type = 'button';
  const top = el('span', 'cd-top');
  top.append(el('span', 'cd-pts', c.points ? String(c.points) : ''));
  const gems = el('span', 'cd-gems');
  if (c.kind === 'gold') gems.append(gemSvg('gold', 'cd-gem'), el('b', 'cd-x2', '×2'));
  else if (isCopy(c) && !c.bonus) gems.append(el('span', 'cd-copy', '⧉'));
  else {
    gems.append(gemSvg(c.bonus, 'cd-gem'));
    if (c.kind === 'double') gems.append(gemSvg(c.bonus, 'cd-gem'));
    if (isCopy(c)) gems.append(el('span', 'cd-copy small', '⧉'));
  }
  top.append(gems);
  n.append(top, costEl(c));
  if (c.take) n.append(el('span', 'cd-power', `+${LEVEL_DOTS[c.take]}`));
  n.append(el('span', 'cd-lv', LEVEL_DOTS[c.level]));
  if (view && c.id != null && view.holds && view.holds[c.id]) n.append(holdMarks(view, view.holds[c.id]));
  n.dataset.tip = cardTipText(c, view);
  if (c.id != null) n.dataset.tipKey = `card-${c.id}`;
  return n;
}

// the Strongholds on a card, in their owners' colours
function holdMarks(view, seats) {
  const box = el('span', 'holds');
  for (const s of seats) box.append(el('i', `hold s${s % 8}`, '♜'));
  const owner = seatName(view, seats[0]);
  const yours = seats[0] === view.you && !isObserver(view);
  box.dataset.tip = `${seats.length} of ${yours ? 'your' : `${owner}’s`} Strongholds: only ${yours ? 'you' : owner} may buy or reserve this card.${seats.length === STRONGHOLDS ? ' All three: it can be conquered — bought at the end of an action.' : ''}`;
  return box;
}

function cardBack(level, count, cls = '', tag = 'div', orient = false) {
  const n = el(tag, `card back lv${level}${orient ? ' orient' : ''}${cls ? ` ${cls}` : ''}`);
  if (tag === 'button') n.type = 'button';
  n.append(el('span', 'bk-lv', LEVEL_DOTS[level]));
  if (orient) n.append(el('span', 'bk-mark', '✿'));
  if (count != null) n.append(el('span', 'bk-n', String(count)));
  n.dataset.tip = count != null ? `The level-${level}${orient ? ' Orient' : ''} deck: ${count} card${count === 1 ? '' : 's'}. You may reserve its top card unseen.` : `A level-${level}${orient ? ' Orient' : ''} card, reserved unseen from the top of the deck.`;
  return n;
}

const reqEl = (req, cls = 'nr') => {
  const box = el('span', cls === 'nr' ? 'nb-req' : 'req-row');
  for (const g of GEMS) if (req[g]) box.append(el('span', `${cls} t-${g}`, String(req[g])));
  return box;
};

function nobleEl(nb, cls = '', tag = 'div') {
  const n = el(tag, `noble${cls ? ` ${cls}` : ''}`);
  if (tag === 'button') n.type = 'button';
  n.append(el('span', 'nb-pts', String(nb.points)), reqEl(nb.req), el('span', 'nb-crest', '♛'));
  n.dataset.tip = `${nb.name}${nb.box ? `, from ${nb.box}` : ''} — a Noble, worth ${nb.points} Prestige points. At the end of a turn, visits a player with ${listWords(GEMS.filter((g) => nb.req[g]).map((g) => `${nb.req[g]} ${gemName(g)}`))} cards.`;
  n.dataset.tipKey = `noble-${nb.id}`;
  return n;
}

// A City tile: the Prestige points and the cards it asks for; a grey square
// with = is that many cards of one colour the tile names nowhere else.
function cityEl(view, c) {
  const n = el('div', `city${c.met.length ? ' met' : ''}`);
  const head = el('div', 'ct-head');
  head.append(el('span', 'ct-pts', String(c.points)), el('span', 'ct-name', c.place));
  n.append(head);
  const reqs = reqEl(c.req, 'cr');
  if (c.any) reqs.append(el('span', 'cr any', `${c.any}=`));
  if (!Object.keys(c.req).length && !c.any) reqs.append(el('span', 'ct-none', 'points alone'));
  n.append(reqs);
  if (c.met.length) {
    const who = el('div', 'ct-met');
    for (const s of c.met) {
      const p = view.players.find((q) => q.seat === s);
      if (p) who.append(avatarEl(p.name, p.seat, p.bot));
    }
    n.append(who);
  }
  const wants = [`${c.points} Prestige points`];
  for (const g of GEMS) if (c.req[g]) wants.push(`${c.req[g]} ${gemName(g)} card${c.req[g] === 1 ? '' : 's'}`);
  if (c.any) wants.push(`${c.any} cards of ${Object.keys(c.req).length ? 'another colour' : 'one colour'}`);
  n.dataset.tip = `${c.place} — ${c.ruler}. Asks for ${listWords(wants)}. Meet it at the end of your turn and the round is played out; then whoever meets a City wins, the most Prestige among them.${c.met.length ? ` Met now by ${listWords(c.met.map((s) => seatName(view, s)))}.` : ''}`;
  n.dataset.tipKey = `city-${c.tile}`;
  return n;
}

// what each Trading Post does, in a few words: on the tile, and on the
// smaller copy in its owner's place
const POST_LABEL = {
  gem: ['+1 gem', 'after you buy'],
  third: ['+1 gem', 'after 2 alike'],
  gold: ['Gold ×2', 'when you buy'],
  draw2: ['Draw 2', 'keep 1'],
  points: ['+1 point', 'per Post'],
};
const POST_MINI = { gem: '+1 buy', third: '2 → +1', gold: 'Gold ×2', draw2: 'Draw 2', points: '+1 each' };

function postEl(view, tp, cls = '', tag = 'div') {
  const mini = cls.split(' ').includes('mini');
  const n = el(tag, `post p-${tp.power}${cls ? ` ${cls}` : ''}`);
  if (tag === 'button') n.type = 'button';
  if (mini) n.append(el('span', 'po-mini', POST_MINI[tp.power]));
  else {
    n.append(reqEl(tp.req, 'pr'));
    const label = el('span', 'po-power');
    label.append(el('b', '', POST_LABEL[tp.power][0]), el('small', '', POST_LABEL[tp.power][1]));
    n.append(label);
    if (tp.owners && tp.owners.length) {
      const who = el('span', 'po-owners');
      for (const s of tp.owners) {
        const p = view.players.find((q) => q.seat === s);
        if (p) who.append(avatarEl(p.name, p.seat, p.bot));
      }
      n.append(who);
    }
  }
  const wants = listWords(GEMS.filter((g) => tp.req[g]).map((g) => `${tp.req[g]} ${gemName(g)} card${tp.req[g] === 1 ? '' : 's'}`));
  n.dataset.tip = `Trading Post — opened at the end of a turn with ${wants}, one a turn: ${tp.text}${tp.owners && tp.owners.length ? ` Opened by ${listWords(tp.owners.map((s) => seatName(view, s)))}.` : ''}`;
  n.dataset.tipKey = `post-${tp.i}${mini ? '-mini' : ''}`;
  return n;
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

  // the expansions: each module on or off, the host's to choose
  const opts = lob.opts || defaultOpts();
  const mp = $('#module-picker');
  mp.replaceChildren();
  for (const box of ['The Silk Road', 'The Sun Never Sets', 'both boxes']) {
    const group = el('div', 'mod-group');
    if (box !== 'both boxes') group.append(el('div', 'mod-box', box));
    for (const m of MODULES.filter((x) => x.box === box)) {
      const on = !!opts[m.key];
      const b = el('button', `mod-pick${on ? ' on' : ''}`, m.name);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(on));
      b.disabled = !sess.isHost;
      b.dataset.tip = `${m.name} (${m.box}). ${m.text}`;
      b.dataset.tipKey = `mod-${m.key}`;
      if (sess.isHost) b.addEventListener('click', () => sess.toggleModule(m.key));
      group.append(b);
    }
    mp.append(group);
  }

  // the supply the table will play with, at its size now (or two)
  const tn = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, n));
  const sum = $('#cast-summary');
  sum.replaceChildren();
  sum.append(el('div', 'cast-head', n >= MIN_PLAYERS ? `At this table of ${tn}:` : `At a table of ${tn}:`));
  const line = el('div', 'cast-tokens');
  for (const g of GEMS) line.append(tokenEl(g, GEMS_FOR[tn], 'small'));
  line.append(tokenEl(GOLD, 5, 'small'));
  sum.append(line);
  const parts = [`${GEMS_FOR[tn]} tokens of each gem, 5 Gold`];
  parts.push(opts.cities ? '3 Cities in place of the Nobles' : `${tn + 1} Nobles${opts.nobles ? ' from 12' : ''}`);
  if (opts.orient) parts.push('2 Orient cards a row');
  if (opts.trading) parts.push('5 Trading Posts');
  if (opts.strongholds) parts.push('3 Strongholds each');
  sum.append(el('div', 'cast-note', `${listWords(parts)}. ${opts.cities ? 'Meeting a City ends the round.' : `First to ${WIN_POINTS} Prestige points ends the round.`}`));

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
let askKey = null;
let picks = [];      // gems picked from the supply, for a take
let sel = null;      // { card } or { level, orient }: what is chosen to buy or reserve
let back = {};       // tokens marked to go back, past ten
let discards = null; // the two cards a sacrifice card takes, as chosen
let moveFrom = null; // the card a Stronghold is to be moved from
let holdMove = false; // moving a Stronghold, with some still in hand
let wasMine = false; // whether the last view already waited on you

const me = (view) => view.players.find((p) => p.seat === view.you);
const seatName = (view, seat) => {
  const p = view.players.find((q) => q.seat === seat);
  return p ? p.name : 'someone';
};
const isObserver = (view) => !!view.observer;
const canAct = (view) => !!view.ask && view.ask.seat === view.you && !isObserver(view) && !!me(view) && view.phase !== 'over';
const held = (p) => sumOf(p.tokens);
const tableCards = (view) => [1, 2, 3].flatMap((l) => [...view.market[l], ...view.omarket[l]]).filter(Boolean);
const findCard = (view, id) => tableCards(view).find((c) => c.id === id) || (me(view) && me(view).reserved.find((c) => c.id === id)) || (me(view) && me(view).cards.find((c) => c.id === id)) || (view.look || []).find((c) => c.id === id);
const blockedFor = (view, id) => (view.holds[id] || []).some((s) => s !== view.you);

function clearSel() {
  picks = [];
  sel = null;
  back = {};
  discards = null;
  moveFrom = null;
  holdMove = false;
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

const counts = (list) => list.reduce((m, g) => ((m[g] = (m[g] || 0) + 1), m), {});
const availableGems = (view) => GEMS.filter((g) => view.bank[g] > 0);

// the move the picked gems make, or why they do not make one yet
function takeMove(view) {
  if (!picks.length) return { why: 'Pick gems from the supply.' };
  if (picks.length === 2 && picks[0] === picks[1]) return { move: { kind: 'take2', gem: picks[0] } };
  const avail = availableGems(view).length;
  if (picks.length === 3 || avail < 3) return { move: { kind: 'take', gems: picks.slice() } };
  return { why: `${3 - picks.length} more of a different colour — or tap the same gem again for two of a kind.` };
}

// Tapping the supply: up to three different gems, or the same one twice for
// two of a kind (from a pile of four or more).
function pickGem(view, g) {
  sel = null;
  const has = picks.includes(g);
  if (has && picks.length === 1) {
    if (view.bank[g] >= 4) picks = [g, g];
    else {
      picks = [];
      toast(`Two of a kind only from a pile of four or more — the ${gemName(g)} pile has ${view.bank[g]}.`);
    }
  } else if (has) picks = picks.filter((x) => x !== g);
  else if (picks.length === 2 && picks[0] === picks[1]) picks = [g];
  else if (picks.length >= 3) toast('Three different gems at most.');
  else picks = [...picks, g];
  rerender();
}

function pickCard(id) {
  picks = [];
  discards = null;
  sel = sel && sel.card === id ? null : { card: id };
  rerender();
}

function pickDeck(level, orient) {
  picks = [];
  sel = sel && sel.level === level && !!sel.orient === !!orient ? null : { level, orient };
  rerender();
}

function pickBack(view, g) {
  const p = me(view);
  const n = view.ask.n;
  const marked = sumOf(back);
  if ((back[g] || 0) < p.tokens[g] && marked < n) back = { ...back, [g]: (back[g] || 0) + 1 };
  else if (back[g]) back = { ...back, [g]: back[g] - 1 };
  rerender();
}

// a tap on a card on the table, whatever is being asked
function tapTable(view, id) {
  const a = view.ask;
  if (a.kind === 'take') return send({ card: id });
  if (a.kind === 'hold') {
    const o = view.holdOptions;
    if (moveFrom == null && o.remove.includes(id)) return send({ remove: id });
    if (!moving(view)) return o.to.includes(id) ? send({ to: id }) : undefined;
    if (moveFrom == null) {
      if (o.mine.includes(id)) moveFrom = id;
      return rerender();
    }
    if (id === moveFrom) {
      moveFrom = null;
      return rerender();
    }
    if (o.to.includes(id)) send({ to: id, from: moveFrom });
    return;
  }
  pickCard(id);
}

// ---------------------------------------------------------------- the table

// what a card on the table does when tapped now, if anything
function tableAction(view, c) {
  if (!canAct(view)) return null;
  const a = view.ask;
  if (a.kind === 'turn') return 'pick';
  if (a.kind === 'take') return a.options.includes(c.id) ? 'take' : null;
  if (a.kind === 'hold') {
    const o = view.holdOptions;
    if (moveFrom == null && o.remove.includes(c.id)) return 'knock';
    if (!moving(view)) return o.canPlace && o.to.includes(c.id) ? 'place' : null;
    if (moveFrom == null) return o.mine.includes(c.id) ? 'pickfrom' : null;
    if (c.id === moveFrom) return 'from';
    return o.to.includes(c.id) ? 'place' : null;
  }
  return null;
}

// a Stronghold is to be moved, not placed: all three are out, or the player
// chose to move one
const moving = (view) => me(view).holds === 0 || holdMove;

function tableCardEl(view, c) {
  const act = tableAction(view, c);
  const afford = view.ask && view.ask.kind === 'turn' && canAct(view) && view.affordable.includes(c.id);
  const cls = [afford ? 'afford' : '', sel && sel.card === c.id ? 'selected' : '', act ? `can do-${act}` : '', blockedFor(view, c.id) ? 'held-by-rival' : ''].filter(Boolean).join(' ');
  const n = cardEl(c, view, cls, act ? 'button' : 'div');
  if (act) n.addEventListener('click', () => tapTable(view, c.id));
  return n;
}

function renderBoard(view) {
  const board = $('#board');
  // measured before anything is replaced
  const W = board.clientWidth || document.documentElement.clientWidth - 20;
  const phone = window.matchMedia('(max-width: 640px)').matches;
  const my = me(view);
  const act = canAct(view) && view.ask.kind === 'turn';
  const orient = view.opts.orient;
  const wrap = el('div', 'board');
  // the Nobles, or the Cities in their place; the Trading Posts beside them
  const top = el('div', 'top-row');
  const tiles = el('div', 'nobles');
  if (view.opts.cities) for (const c of view.cities) tiles.append(cityEl(view, c));
  else {
    for (const nb of view.nobles) tiles.append(nobleEl(nb));
    if (!view.nobles.length) tiles.append(el('span', 'dim nobles-gone', 'Every Noble has been won.'));
  }
  top.append(tiles);
  if (view.opts.trading) {
    const posts = el('div', 'posts');
    for (const tp of view.posts) posts.append(postEl(view, tp));
    top.append(posts);
  }
  wrap.append(top);

  // The cards, level 3 at the top as the decks are laid out, each deck at
  // the head of its row. The Orient cards sit to the right of the others —
  // below them on a phone — and the cards are as wide as the room allows:
  // eight across with the Orient, five without, the supply beside them, or
  // below when that leaves the cards too small.
  const market = el('div', `market${orient ? ' with-orient' : ''}`);
  const fit = (room, cols) => Math.floor(room / cols);
  let below = phone;
  let cw;
  if (phone) cw = fit(W - 24, 5);
  else if (!orient) cw = fit(W - 90 - 42, 5);
  else {
    cw = fit(W - 90 - 84, 8);
    if (cw < 72) {
      below = true;
      cw = fit(W - 84, 8);
    }
  }
  cw = Math.max(48, Math.min(phone ? 78 : 92, cw));
  market.style.setProperty('--mcw', `${cw}px`);
  const block = (isOrient) => {
    const b = el('div', `mblock${isOrient ? ' orient' : ' base'}`);
    if (isOrient && phone) b.append(el('div', 'mblock-label', 'The Orient'));
    for (const l of [3, 2, 1]) {
      const row = el('div', `mrow lv${l}`);
      const count = isOrient ? view.odecks[l] : view.decks[l];
      const ok = act && count > 0 && my.reserved.length < RESERVE_LIMIT;
      const on = sel && sel.level === l && !!sel.orient === isOrient;
      const deck = cardBack(l, count, `deck${on ? ' selected' : ''}${ok ? ' can' : ''}${count ? '' : ' gone'}`, ok ? 'button' : 'div', isOrient);
      if (ok) deck.addEventListener('click', () => pickDeck(l, isOrient));
      row.append(deck);
      for (const c of (isOrient ? view.omarket : view.market)[l]) row.append(c ? tableCardEl(view, c) : el('div', 'card empty'));
      b.append(row);
    }
    return b;
  };
  market.append(block(false));
  if (orient) market.append(block(true));

  // the supply
  const bank = el('div', 'bank');
  for (const t of TOKENS) {
    const can = act && t !== GOLD && view.bank[t] > 0;
    const picked = picks.filter((x) => x === t).length;
    const n = tokenEl(t, view.bank[t], `pile${picked ? ' picked' : ''}${can ? ' can' : ''}`, can ? 'button' : 'span');
    if (picked) n.append(el('i', 'pick-n', `+${picked}`));
    n.dataset.tip = t === GOLD
      ? `Gold: ${view.bank[t]} left. Gold stands in for any gem, and comes only with a reserved card.`
      : `${gemName(t)}: ${view.bank[t]} in the supply. Take three different gems, or two of one from a pile of four or more.`;
    n.dataset.tipKey = `bank-${t}`;
    if (can) n.addEventListener('click', () => pickGem(view, t));
    bank.append(n);
  }
  const mid = el('div', `mid${below ? ' below' : ''}`);
  mid.append(market, bank);
  wrap.append(mid);
  board.replaceChildren(wrap);
}

// A player's place at the table: Prestige points; bonuses and tokens gem by
// gem — the bonuses from cards bought above, the tokens held below; reserved
// cards; Nobles; Trading Posts; Strongholds in hand.
function playerEl(view, p, mine) {
  const discard = mine && canAct(view) && view.ask.kind === 'discard';
  const turnNow = view.turn === p.seat && view.phase !== 'over';
  const box = el('div', `player${mine ? ' mine' : ''}${turnNow ? ' turn' : ''}${!p.connected && !p.bot ? ' gone' : ''}${view.winners && view.winners.includes(p.seat) ? ' won' : ''}`);
  box.dataset.seat = String(p.seat);
  const head = el('div', 'pl-head');
  head.append(avatarEl(p.name, p.seat, p.bot), el('span', 'pl-name', p.name));
  if (p.seat === view.you && !isObserver(view)) head.append(el('span', 'you-tag', 'you'));
  if (p.seat === view.first) {
    const f = el('span', 'first-tag', 'first');
    f.dataset.tip = view.opts.cities ? 'The First Player. Once someone meets a City, the round ends with the player before them, so everyone plays as many turns.' : 'The First Player. Once someone reaches 15 Prestige points, the round ends with the player before them, so everyone plays as many turns.';
    head.append(f);
  }
  if (turnNow) head.append(el('span', 'turn-tag', view.ask && view.ask.kind !== 'turn' ? '…' : 'turn'));
  const fromCards = p.cards.reduce((a, c) => a + c.points, 0);
  const pts = el('span', 'pl-pts', String(p.points));
  const extra = [];
  if (p.nobles.length) extra.push(`${p.nobles.length * 3} from Noble${p.nobles.length === 1 ? '' : 's'}`);
  if (p.points - fromCards - p.nobles.length * 3 > 0) extra.push(`${p.points - fromCards - p.nobles.length * 3} from Trading Posts`);
  pts.dataset.tip = `${p.points} Prestige point${p.points === 1 ? '' : 's'}${extra.length ? `: ${fromCards} from cards, ${listWords(extra)}` : ''}. ${p.cards.length} card${p.cards.length === 1 ? '' : 's'} bought — fewer wins a tie.`;
  head.append(pts);
  box.append(head);

  const gems = el('div', 'pl-gems');
  for (const t of TOKENS) {
    const col = el('div', `pg t-${t}`);
    if (t === GOLD) {
      const gc = p.cards.filter((c) => c.kind === 'gold').length;
      const b = el('span', `pg-bonus${gc ? ' goldcards' : ' blank'}`, gc ? `${gc}` : '');
      if (gc) b.dataset.tip = `${gc} Gold card${gc === 1 ? '' : 's'}: each, discarded when buying, pays 2 Gold for that purchase.`;
      col.append(b);
    } else {
      const b = el('span', `pg-bonus${p.bonuses[t] ? '' : ' none'}`, String(p.bonuses[t]));
      const cards = p.counts[t];
      b.dataset.tip = `${p.bonuses[t]} ${gemName(t)} bonus${p.bonuses[t] === 1 ? '' : 'es'}: ${p.bonuses[t]} ${gemName(t)} off every card.${cards !== p.bonuses[t] ? ` ${cards} ${gemName(t)} card${cards === 1 ? '' : 's'} for Nobles, Trading Posts and Cities.` : ''}`;
      b.dataset.tipKey = `bonus-${p.seat}-${t}`;
      col.append(b);
    }
    const marked = discard ? back[t] || 0 : 0;
    const can = discard && (p.tokens[t] > 0);
    const tk = tokenEl(t, p.tokens[t] - marked, `small${marked ? ' marked' : ''}${can ? ' can' : ''}`, can ? 'button' : 'span');
    if (marked) tk.append(el('i', 'pick-n', `−${marked}`));
    tk.dataset.tip = `${p.tokens[t]} ${gemName(t)} token${p.tokens[t] === 1 ? '' : 's'} in hand.`;
    tk.dataset.tipKey = `tok-${p.seat}-${t}`;
    if (can) tk.addEventListener('click', () => pickBack(view, t));
    col.append(tk);
    gems.append(col);
  }
  box.append(gems);

  const foot = el('div', 'pl-foot');
  const total = el('span', `pl-held${held(p) >= TOKEN_LIMIT - 1 ? ' full' : ''}`, `${held(p)}/${TOKEN_LIMIT}`);
  total.dataset.tip = `${held(p)} tokens in hand. At the end of a turn no one may hold more than ${TOKEN_LIMIT}.`;
  foot.append(total);
  if (view.opts.strongholds) {
    const h = el('span', `pl-holds s${p.seat % 8}`);
    for (let i = 0; i < STRONGHOLDS; i++) h.append(el('i', i < p.holds ? 'in' : 'out', '♜'));
    h.dataset.tip = `Strongholds: ${p.holds} of ${STRONGHOLDS} in hand${p.holds < STRONGHOLDS ? `, ${STRONGHOLDS - p.holds} on the table’s cards` : ''}.`;
    foot.append(h);
  }
  const res = el('div', 'pl-res');
  const act = mine && canAct(view) && (view.ask.kind === 'turn');
  for (const r of p.reserved) {
    if (r.hidden) {
      res.append(cardBack(r.level, null, 'mini', 'div', r.orient));
      continue;
    }
    const afford = act && view.affordable.includes(r.id);
    const n = cardEl(r, view, `${mine ? 'held' : 'mini'}${afford ? ' afford' : ''}${sel && sel.card === r.id ? ' selected' : ''}${act ? ' can' : ''}${r.blind ? ' blind' : ''}`, act ? 'button' : 'div');
    if (act) n.addEventListener('click', () => pickCard(r.id));
    if (r.blind && p.seat === view.you) n.dataset.tip += ' Reserved unseen from the deck: the others see only its back.';
    res.append(n);
  }
  if (p.reserved.length) {
    res.dataset.tip = `${p.reserved.length} reserved card${p.reserved.length === 1 ? '' : 's'} of ${RESERVE_LIMIT}. Only their holder can buy them.`;
    foot.append(res);
  } else if (mine) foot.append(el('span', 'dim pl-none', 'No reserved cards'));
  if (p.posts.length) {
    const ps = el('div', 'pl-posts');
    for (const i of p.posts) {
      const tp = view.posts.find((x) => x.i === i) || { i, ...TRADING_POSTS[i], owners: [] };
      ps.append(postEl(view, { ...tp, owners: [] }, 'mini'));
    }
    foot.append(ps);
  }
  if (p.nobles.length) {
    const nb = el('div', 'pl-nobles');
    for (const x of p.nobles) nb.append(nobleEl(x, 'mini'));
    foot.append(nb);
  }
  box.append(foot);
  return box;
}

function renderPlayers(view) {
  const n = view.players.length;
  const youIdx = Math.max(0, view.players.findIndex((p) => p.seat === view.you));
  const others = $('#opponents');
  const list = [];
  // the others in turn order after you
  for (let k = 1; k < n; k++) list.push(playerEl(view, view.players[(youIdx + k) % n], false));
  others.replaceChildren(...list);
  const mine = view.players[youIdx];
  $('#mine').replaceChildren(playerEl(view, mine, true));
}

// ---------------------------------------------------------------- the action panel

function renderAction(view) {
  const box = $('#action');
  box.replaceChildren();
  const add = (cls, text) => {
    const n = el('p', cls, text);
    box.append(n);
    return n;
  };
  const row = () => {
    const r = el('div', 'act-row');
    box.append(r);
    return r;
  };
  const a = view.ask;
  const mine = canAct(view);
  box.className = `${a ? `act-${a.kind}` : ''}${mine ? ' mine' : ''}`;
  if (view.phase === 'over') {
    const w = (view.winners || []).map((s) => seatName(view, s));
    add('act-head', `${listWords(w)} ${w.length === 1 ? 'wins' : 'share the victory'} — ${view.why}.`);
    return;
  }
  if (!a) return;
  const who = seatName(view, a.seat);
  const my = me(view);
  if (!mine) {
    const doing = {
      turn: `${who}’s turn.`,
      discard: `${who} gives back ${a.n} token${a.n === 1 ? '' : 's'} to keep ten.`,
      noble: `${who} chooses which Noble visits.`,
      post: `${who} chooses which Trading Post to open.`,
      copy: `${who} chooses the colour of a copy card.`,
      take: `${who} chooses a free level-${a.level} card.`,
      gem: `${who}’s Trading Post brings them a gem.`,
      third: `${who}’s Trading Post brings them a third gem.`,
      draw2: `${who} looks at the top two cards of a deck.`,
      hold: `${who} places a Stronghold.`,
      conquest: `${who} may conquer the card their three Strongholds hold.`,
    }[a.kind] || `${who} is choosing.`;
    add('act-head', doing);
    if (a.kind === 'turn') add('act-sub', 'Take gems, reserve a card, or buy one.');
    return;
  }

  switch (a.kind) {
    case 'discard': {
      const marked = sumOf(back);
      add('act-head', `You hold ${held(my)} tokens: give ${a.n} back.`);
      add('act-sub', marked ? `Going back: ${tokenWords(back)}${marked < a.n ? ` — ${a.n - marked} more` : ''}.` : 'Tap your tokens below to choose which go back to the supply.');
      const r = row();
      r.append(btn(marked === a.n ? `Give back ${tokenWords(back)}` : `Give back ${a.n}`, 'primary', () => send({ tokens: { ...back } }), marked !== a.n));
      if (marked) r.append(btn('Clear', 'ghost', () => { back = {}; rerender(); }));
      return;
    }
    case 'noble': {
      add('act-head', 'More than one Noble would visit — choose one.');
      add('act-sub', `Only one comes each turn; the other${a.options.length > 2 ? 's' : ''} may still visit at the end of a later turn.`);
      const r = el('div', 'card-row');
      for (const nb of view.nobles.filter((x) => a.options.includes(x.id))) {
        const n = nobleEl(nb, 'can', 'button');
        n.addEventListener('click', () => send({ noble: nb.id }));
        r.append(n);
      }
      box.append(r);
      return;
    }
    case 'post': {
      add('act-head', 'You can open more than one Trading Post — choose one.');
      add('act-sub', `Only one a turn; the other${a.options.length > 2 ? 's' : ''} can be opened at the end of a later turn.`);
      const r = el('div', 'card-row');
      for (const i of a.options) {
        const n = postEl(view, view.posts.find((x) => x.i === i), 'can', 'button');
        n.addEventListener('click', () => send({ post: i }));
        r.append(n);
      }
      box.append(r);
      return;
    }
    case 'copy': {
      add('act-head', 'Your copy card: which colour does it take?');
      add('act-sub', 'It takes the colour and bonus of a card of yours, for the rest of the game.');
      const r = row();
      const byColour = new Map();
      for (const id of a.options) {
        const f = view.copyFaces && view.copyFaces[id];
        if (f && f.bonus && !byColour.has(f.bonus)) byColour.set(f.bonus, id);
      }
      for (const [g, id] of byColour) {
        const b = btn('', 'secondary gem-choice', () => send({ target: id }));
        b.append(gemSvg(g), document.createTextNode(` ${gemName(g)} (${my.counts[g]} card${my.counts[g] === 1 ? '' : 's'})`));
        r.append(b);
      }
      return;
    }
    case 'take': {
      add('act-head', `Take a face-up level-${a.level} card for free — tap it on the table.`);
      add('act-sub', 'You pay nothing, but its effects apply. It is not a purchase.');
      const r = el('div', 'card-row');
      for (const id of a.options) {
        const c = findCard(view, id);
        if (!c) continue;
        const n = cardEl(c, view, 'can', 'button');
        n.addEventListener('click', () => send({ card: id }));
        r.append(n);
      }
      box.append(r);
      return;
    }
    case 'gem':
    case 'third': {
      add('act-head', a.kind === 'gem' ? 'Your Trading Post: take a gem of any colour.' : `Your Trading Post: take a gem of another colour than ${gemName(a.not)}.`);
      const r = el('div', 'pick-row');
      for (const g of a.options) {
        const t = tokenEl(g, null, 'can', 'button');
        t.setAttribute('aria-label', `Take ${ONE_WORD[g]}`);
        t.addEventListener('click', () => send({ gem: g }));
        r.append(t);
      }
      box.append(r);
      return;
    }
    case 'draw2': {
      add('act-head', 'Your Trading Post: keep one of the top two cards; the other goes to the bottom of the deck.');
      add('act-sub', 'The one you keep is reserved, unseen by the others.');
      const r = el('div', 'card-row');
      for (const c of view.look || []) {
        const n = cardEl(c, view, 'can', 'button');
        n.addEventListener('click', () => send({ keep: c.id }));
        r.append(n);
      }
      box.append(r);
      return;
    }
    case 'hold': {
      const o = view.holdOptions;
      add('act-head', 'Your purchase places a Stronghold — tap a card on the table.');
      const ways = [];
      if (!o.canPlace) ways.push('Knock a lone rival Stronghold off its card');
      else {
        if (!moving(view)) ways.push('Place one of yours on any card no rival holds');
        else if (moveFrom == null) ways.push(`${my.holds === 0 ? 'All three of yours are out: tap' : 'Tap'} a card with one of yours on it, to move it from there`);
        else ways.push('Now tap the card to move it to');
        if (o.remove.length && moveFrom == null) ways.push('or knock a lone rival Stronghold off its card');
      }
      add('act-sub', `${ways.join(' — ')}. Only you may buy or reserve a card you hold; with all three on one card, you may buy it at the end of your action.`);
      const r = row();
      if (o.canPlace && my.holds > 0 && o.mine.length && !holdMove) r.append(btn('Move one of yours instead', 'ghost', () => { holdMove = true; rerender(); }));
      if (holdMove) r.append(btn('Place one instead', 'ghost', () => { holdMove = false; moveFrom = null; rerender(); }));
      else if (moveFrom != null) r.append(btn('Choose another card to move from', 'ghost', () => { moveFrom = null; rerender(); }));
      return;
    }
    case 'conquest': {
      const c = findCard(view, a.card);
      const buy = view.buys[a.card];
      add('act-head', 'All three of your Strongholds hold a card: conquer it now?');
      if (c) {
        const r = el('div', 'card-row');
        r.append(cardEl(c, view));
        box.append(r);
      }
      const buttons = [];
      if (buy && buy.sacrifice) buttons.push(sacrificeChooser(view, box, buy, (discard) => send({ buy: true, discard })));
      else if (buy) for (const plan of buy.plans) buttons.push(btn(`Buy it ${payLabel(plan)}`, plan === buy.plans[0] ? 'primary' : 'secondary', () => send({ buy: true, goldCards: plan.goldCards })));
      buttons.push(btn('Not now', 'ghost', () => send({ buy: false })));
      row().append(...buttons);
      return;
    }
    default:
  }

  // your turn
  if (picks.length) {
    const t = takeMove(view);
    add('act-head', `Take ${tokenWords(counts(picks))}?`);
    const chips = el('div', 'pick-row');
    for (const g of picks) {
      const c = tokenEl(g, null, 'small can', 'button');
      c.setAttribute('aria-label', `Put back the ${gemName(g)}`);
      c.addEventListener('click', () => {
        const i = picks.indexOf(g);
        picks = picks.filter((_, k) => k !== i);
        rerender();
      });
      chips.append(c);
    }
    box.append(chips);
    if (t.why) add('act-sub', t.why);
    const over = held(my) + picks.length - TOKEN_LIMIT;
    if (t.move && over > 0) add('act-note', `That makes ${held(my) + picks.length} tokens: you will give ${over} back.`);
    const r = row();
    r.append(btn('Take them', 'primary', () => send(t.move), !t.move));
    r.append(btn('Clear', 'ghost', () => { picks = []; rerender(); }));
    return;
  }
  if (sel && sel.card != null) {
    const fromHand = my.reserved.find((c) => c.id === sel.card);
    const c = fromHand || tableCards(view).find((x) => x.id === sel.card);
    if (!c) { sel = null; return renderAction(view); }
    const head = add('act-head', '');
    head.append(cardEl(c, view, 'inline'), document.createTextNode(` ${cardTitle(c)}${c.points ? `, ${c.points} Prestige point${c.points === 1 ? '' : 's'}` : ''}.`));
    if (c.orient) add('act-sub', POWER_WORDS[c.kind]);
    const buy = view.buys[c.id];
    const blocked = blockedFor(view, c.id);
    const buttons = [];
    if (blocked) add('act-warn', 'A rival’s Stronghold is on it: only they may buy or reserve it.');
    else if (buy && buy.sacrifice) buttons.push(sacrificeChooser(view, box, buy, (discard) => send({ kind: 'buy', card: c.id, discard })));
    else if (buy) {
      for (const plan of buy.plans) buttons.push(btn(`Buy it ${payLabel(plan)}`, plan === buy.plans[0] ? 'primary' : 'secondary', () => send({ kind: 'buy', card: c.id, goldCards: plan.goldCards })));
    } else {
      add('act-sub', shortWords(view, my, c));
      buttons.push(btn('Buy it', 'primary', () => {}, true));
    }
    if (!fromHand && !blocked) {
      const full = my.reserved.length >= RESERVE_LIMIT;
      buttons.push(btn(full ? `Reserve it (${RESERVE_LIMIT} held already)` : `Reserve it${view.bank.gold ? ' and take a Gold' : ''}`, 'secondary', () => send({ kind: 'reserve', card: c.id }), full));
    }
    buttons.push(btn('Cancel', 'ghost', () => { sel = null; rerender(); }));
    row().append(...buttons);
    if (!fromHand && !blocked && view.bank.gold && my.reserved.length < RESERVE_LIMIT && held(my) + 1 > TOKEN_LIMIT) add('act-note', 'Reserving brings a Gold — eleven tokens, so one would go back.');
    return;
  }
  if (sel && sel.level) {
    add('act-head', `Reserve the top card of the level-${sel.level}${sel.orient ? ' Orient' : ''} deck, unseen${view.bank.gold ? ', and take a Gold' : ''}?`);
    add('act-sub', my.posts.some((i) => TRADING_POSTS[i].power === 'draw2') ? 'Your Trading Post lets you draw two and keep one.' : 'You see it once it is yours; the others see only its level.');
    const r = row();
    r.append(btn('Reserve it', 'primary', () => send({ kind: 'reserve', level: sel.level, orient: !!sel.orient })));
    r.append(btn('Cancel', 'ghost', () => { sel = null; rerender(); }));
    return;
  }
  add('act-head', 'Your turn: take gems from the supply, or choose a card to buy or reserve.');
  const k = view.affordable.length;
  add('act-sub', k ? `You can buy ${k === 1 ? 'one card' : `${k} cards`} now — lit in gold.` : 'Three different gems, or two of one colour from a pile of four or more.');
}

// The two cards a sacrifice card takes, as the player chooses them: the copy
// cards of its colour go first — with two or fewer, they are fixed and the
// rest is chosen from the others; with more, two of them. Shown in the action
// panel; returns the button that buys with the two chosen.
function sacrificeChooser(view, box, buy, go) {
  const my = me(view);
  const s = buy.sacrifice;
  const fixed = s.copies.length <= 2 ? s.copies : [];
  const choosable = s.copies.length <= 2 ? s.pool.filter((id) => !s.copies.includes(id)) : s.copies;
  const free = 2 - fixed.length;
  if (!discards) discards = buy.plan.discard.filter((id) => choosable.includes(id)).slice(0, free);
  box.append(el('p', 'act-sub', `It costs two of your ${gemName(s.colour)} cards${s.must ? ` — your ${gemName(s.colour)} copy card${s.must === 2 ? 's' : ''} first` : ''}.${free > 0 && choosable.length > free ? ` Tap to choose ${free === 2 ? 'the two' : fixed.length ? 'the other' : 'the one'} to discard:` : ''}`));
  const pick = el('div', 'card-row');
  for (const id of s.pool) {
    const f = my.cards.find((x) => x.id === id);
    if (!f) continue;
    const isFixed = fixed.includes(id);
    const can = !isFixed && free > 0 && choosable.includes(id) && choosable.length > free;
    const on = isFixed || discards.includes(id);
    const n = cardEl(f, view, `mini${on ? ' picked' : ''}${can ? ' can' : ''}`, can ? 'button' : 'div');
    if (can) n.addEventListener('click', () => {
      discards = discards.includes(id) ? discards.filter((x) => x !== id) : [...discards, id].slice(-free);
      rerender();
    });
    pick.append(n);
  }
  box.append(pick);
  const chosen = [...fixed, ...discards];
  return btn('Buy it, discarding those two', 'primary', () => go(chosen), chosen.length !== 2);
}

const ONE_WORD = { diamond: 'a Diamond', sapphire: 'a Sapphire', emerald: 'an Emerald', ruby: 'a Ruby', onyx: 'an Onyx', gold: 'a Gold' };
const MANY_WORD = { diamond: 'Diamonds', sapphire: 'Sapphires', emerald: 'Emeralds', ruby: 'Rubies', onyx: 'Onyx', gold: 'Gold' };

// "a Sapphire, an Emerald and a Gold card"
function payLabel(plan) {
  const words = TOKENS.filter((t) => plan.pay[t]).map((t) => (plan.pay[t] === 1 ? ONE_WORD[t] : `${plan.pay[t]} ${MANY_WORD[t]}`));
  if (plan.goldCards) words.push(plan.goldCards === 1 ? 'a Gold card' : `${plan.goldCards} Gold cards`);
  return words.length ? `for ${listWords(words)}` : 'with bonuses alone';
}

// why a card cannot be bought yet
function shortWords(view, p, c) {
  if (isCopy(c) && !p.cards.some((x) => x.bonus)) return 'A copy card needs a card of yours with a bonus to match.';
  if (c.kind === 'sacrifice') return `It takes two ${gemName(c.discard)} cards to discard; you have ${p.counts[c.discard]}.`;
  const miss = {};
  for (const g of GEMS) {
    const m = Math.max(0, (c.cost[g] || 0) - p.bonuses[g] - p.tokens[g]);
    if (m) miss[g] = m;
  }
  const gold = p.tokens.gold;
  const gc = p.cards.filter((x) => x.kind === 'gold').length;
  return `You are short ${tokenWords(miss)}${gold || gc ? `, less ${[gold ? `${gold} Gold` : '', gc ? `${gc} Gold card${gc === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ')}` : ''}.`;
}

// ---------------------------------------------------------------- what just happened

// a moment's note over a player's place — what they took, bought, reserved
function stamp(seat, content, cls) {
  const host = document.querySelector(`.player[data-seat="${seat}"]`);
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
  n.style.top = `${Math.round(r.top + Math.min(r.height / 2, 60))}px`;
  n.style.animationDuration = `${ms}ms`;
  layer.append(n);
  setTimeout(() => n.remove(), ms + 60);
}

function showFx(view, f) {
  const name = seatName(view, f.seat);
  const you = f.seat === view.you && !isObserver(view);
  const tokens = (t, sign) => GEMS.concat(GOLD).flatMap((g) => Array.from({ length: t[g] || 0 }, () => tokenEl(g, null, 'small'))).concat(sign ? [el('b', '', sign)] : []);
  switch (f.kind) {
    case 'take':
      return stamp(f.seat, tokens(f.tokens), 'take');
    case 'return':
      return stamp(f.seat, [el('b', '', '−'), ...tokens(f.tokens)], 'return');
    case 'reserve':
      return stamp(f.seat, [el('b', '', 'Reserves'), f.card ? cardEl(f.card, null, 'inline') : cardBack(f.level, null, 'inline', 'div', f.orient)], 'reserve');
    case 'buy':
      return stamp(f.seat, [cardEl(f.card, null, 'inline'), el('b', '', f.free ? 'free' : f.conquest ? 'conquered' : f.card.points ? `+${f.card.points}` : 'bought')], 'buy');
    case 'hold':
      return stamp(f.seat, [el('b', '', '♜ Stronghold')], 'take');
    case 'unhold':
      return stamp(f.owner, [el('b', '', '♜ knocked off')], 'return');
    case 'noble': {
      const p = view.players.find((q) => q.seat === f.seat);
      const nb = p && p.nobles.find((x) => x.id === f.noble);
      return flash(`${nb ? nb.name : 'A Noble'} visits ${you ? 'you' : name}: +3`, 'noble');
    }
    case 'post':
      return stamp(f.seat, [el('b', '', 'Trading Post')], 'buy');
    case 'ending':
      if (f.city != null) return flash(`${you ? 'You meet' : `${name} meets`} ${CITIES[f.city].place} — the last round`, 'plain');
      return flash(`${you ? 'You reach' : `${name} reaches`} ${WIN_POINTS} — the last round`, 'plain');
    default:
  }
}

function playFx(view) {
  const list = view.fxs || [];
  if (!list.length) return;
  const fresh = list.filter((f) => f.seq > lastFxSeq).slice(-8);
  lastFxSeq = Math.max(lastFxSeq, list[list.length - 1].seq);
  fresh.forEach((f, i) => setTimeout(() => showFx(view, f), i * 260));
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
    askKey = null;
    const list = view.fxs || [];
    lastFxSeq = list.length ? list[list.length - 1].seq : 0;
  }
  // a new question clears whatever was half chosen for the last one
  const key = view.ask ? `${view.ask.kind}:${view.ask.seat}` : '';
  if (key !== askKey) {
    askKey = key;
    clearSel();
  }
  if (!canAct(view)) clearSel();
  // picks the supply can no longer give, and cards gone from the table
  picks = picks.filter((g) => view.bank[g] >= picks.filter((x) => x === g).length && (picks.filter((x) => x === g).length < 2 || view.bank[g] >= 4));
  if (sel && sel.card != null && !tableCards(view).some((c) => c.id === sel.card) && !(me(view) && me(view).reserved.some((c) => c.id === sel.card))) sel = null;

  $('#room-chip').textContent = view.code || '·····';
  const tc = $('#turn-chip');
  const mineTurn = view.turn === view.you && !isObserver(view) && view.phase !== 'over';
  tc.textContent = view.phase === 'over' ? 'Game over' : mineTurn ? 'Your turn' : `${seatName(view, view.turn)}’s turn`;
  tc.classList.toggle('mine', mineTurn);
  const lc = $('#last-chip');
  lc.classList.toggle('hidden', view.ending == null || view.phase === 'over');
  if (view.ending != null) {
    const firstIdx = view.players.findIndex((p) => p.seat === view.first);
    const lastP = view.players[(firstIdx + view.players.length - 1) % view.players.length];
    lc.textContent = 'Last round';
    lc.dataset.tip = `${seatName(view, view.ending)} ${view.opts.cities ? 'meets a City' : `reached ${WIN_POINTS}`}. The round ends with ${lastP.seat === view.you && !isObserver(view) ? 'you' : lastP.name}, so everyone plays as many turns.`;
  }
  const mods = $('#mods-chip');
  const on = MODULES.filter((m) => view.opts[m.key]).map((m) => m.name.replace(/^The /, '').replace(/^Their two /, '+2 '));
  mods.classList.toggle('hidden', !on.length);
  mods.textContent = on.join(' · ');
  mods.dataset.tip = MODULES.filter((m) => view.opts[m.key]).map((m) => `${m.name} (${m.box}): ${m.text}`).join(' ');

  renderBoard(view);
  renderPlayers(view);
  renderAction(view);
  renderLog(view);
  paintChatBubbles();
  retip();
  playFx(view);
  revealPrompt(view);
  settleOverlay('#gameover', view.phase === 'over', () => showGameover(view, sess));
}

// On a phone the prompt sits below the cards. When the table starts waiting
// on you, the prompt is brought into view, once, if it is off the screen.
function revealPrompt(view) {
  const mine = canAct(view);
  if (mine && !wasMine) {
    const box = $('#action');
    const r = box.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) {
      // a hidden tab never runs a smooth scroll, so it jumps there instead
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
  const order = view.players.slice().sort((a, b) => (winners.includes(b.seat) - winners.includes(a.seat)) || b.points - a.points || a.cards.length - b.cards.length);
  for (const p of order) {
    const row = el('li', `rank-row${p.seat === view.you ? ' me' : ''}${winners.includes(p.seat) ? ' won' : ''}`);
    row.append(avatarEl(p.name, p.seat, p.bot));
    const nm = el('span', 'rank-name');
    const bits = [`${p.cards.length} card${p.cards.length === 1 ? '' : 's'}`];
    if (p.nobles.length) bits.push(`${p.nobles.length} Noble${p.nobles.length === 1 ? '' : 's'}`);
    if (p.posts.length) bits.push(`${p.posts.length} Trading Post${p.posts.length === 1 ? '' : 's'}`);
    const city = view.cities.find((c) => c.met.includes(p.seat));
    if (city) bits.push(`meets ${city.place}`);
    nm.append(el('b', '', p.name + (p.connected || p.bot ? '' : ' (left)')), el('small', '', bits.join(' · ')));
    row.append(nm, el('span', 'rank-score', String(p.points)));
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
      overlayTimers.delete(sel);
      overlayPending.delete(sel);
      show();
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
  localStorage.setItem('spl-name', name);
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
  localStorage.setItem('spl-name', name);
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
  $('#name-input').value = localStorage.getItem('spl-name') || '';
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

