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
    this.G = newGame(this.roster);
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
    this.G = newGame(this.roster);
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

// the cost circles, in the order the cards print them
function costEl(cost, cls) {
  const box = el('span', cls);
  for (const g of GEMS) if (cost[g]) box.append(el('span', `cc t-${g}`, String(cost[g])));
  return box;
}

// what this player would pay for a card — their own gems first, Gold for the
// rest — or null if they cannot
function payFor(p, c) {
  const pay = { gold: 0 };
  for (const g of GEMS) {
    const need = Math.max(0, (c.cost[g] || 0) - p.bonuses[g]);
    pay[g] = Math.min(need, p.tokens[g]);
    pay.gold += need - pay[g];
  }
  return pay.gold <= p.tokens.gold ? pay : null;
}
function missingFor(p, c) {
  const miss = {};
  for (const g of GEMS) {
    const m = Math.max(0, (c.cost[g] || 0) - p.bonuses[g] - p.tokens[g]);
    if (m) miss[g] = m;
  }
  return miss;
}
function affordWords(p, c, you = true) {
  const pay = payFor(p, c);
  if (pay) return sumOf(pay) ? `${you ? 'You could' : `${p.name} could`} buy it for ${tokenWords(pay)}.` : `${you ? 'You could' : `${p.name} could`} buy it with bonuses alone.`;
  const miss = missingFor(p, c);
  return `${you ? 'You are' : `${p.name} is`} short ${tokenWords(miss)}${p.tokens.gold ? `, less ${p.tokens.gold} Gold` : ''}.`;
}

// A Development card as printed: Prestige points and the bonus gem across the
// top, the cost down the left, the level's dots at the foot.
function cardEl(c, view, cls = '', tag = 'div') {
  const n = el(tag, `card b-${c.bonus} lv${c.level}${cls ? ` ${cls}` : ''}`);
  if (tag === 'button') n.type = 'button';
  const top = el('span', 'cd-top');
  top.append(el('span', 'cd-pts', c.points ? String(c.points) : ''), gemSvg(c.bonus, 'cd-gem'));
  n.append(top, costEl(c.cost, 'cd-cost'), el('span', 'cd-lv', LEVEL_DOTS[c.level]));
  const my = view && me(view);
  n.dataset.tip = [
    `Level ${c.level} ${gemName(c.bonus)} card${c.points ? `, ${c.points} Prestige point${c.points === 1 ? '' : 's'}` : ''}: costs ${tokenWords(c.cost)}.`,
    `Bought, it is a ${gemName(c.bonus)} bonus for good — one ${gemName(c.bonus)} off every later card.`,
    my && !isObserver(view) ? affordWords(my, c) : '',
  ].filter(Boolean).join(' ');
  if (c.id != null) n.dataset.tipKey = `card-${c.id}`;
  return n;
}

function cardBack(level, count, cls = '', tag = 'div') {
  const n = el(tag, `card back lv${level}${cls ? ` ${cls}` : ''}`);
  if (tag === 'button') n.type = 'button';
  n.append(el('span', 'bk-lv', LEVEL_DOTS[level]));
  if (count != null) n.append(el('span', 'bk-n', String(count)));
  n.dataset.tip = count != null ? `The level-${level} deck: ${count} card${count === 1 ? '' : 's'}. You may reserve its top card unseen.` : `A level-${level} card, reserved unseen from the top of the deck.`;
  return n;
}

function nobleEl(nb, cls = '', tag = 'div') {
  const n = el(tag, `noble${cls ? ` ${cls}` : ''}`);
  if (tag === 'button') n.type = 'button';
  const req = el('span', 'nb-req');
  for (const g of GEMS) if (nb.req[g]) req.append(el('span', `nr t-${g}`, String(nb.req[g])));
  n.append(el('span', 'nb-pts', String(nb.points)), req, el('span', 'nb-crest', '♛'));
  n.dataset.tip = `A Noble, worth ${nb.points} Prestige points. At the end of a turn, visits a player with ${listWords(GEMS.filter((g) => nb.req[g]).map((g) => `${nb.req[g]} ${gemName(g)}`))} bonuses — cards bought, not tokens.`;
  n.dataset.tipKey = `noble-${nb.id}`;
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

  // the supply the table will play with, at its size now (or two)
  const tn = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, n));
  const sum = $('#cast-summary');
  sum.replaceChildren();
  sum.append(el('div', 'cast-head', n >= MIN_PLAYERS ? `At this table of ${tn}:` : `At a table of ${tn}:`));
  const line = el('div', 'cast-tokens');
  for (const g of GEMS) line.append(tokenEl(g, GEMS_FOR[tn], 'small'));
  line.append(tokenEl(GOLD, 5, 'small'));
  sum.append(line);
  sum.append(el('div', 'cast-note', `${GEMS_FOR[tn]} tokens of each gem, 5 Gold, ${tn + 1} Nobles. First to ${WIN_POINTS} Prestige points ends the round.`));

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
let sel = null;      // { card } or { level }: what is chosen to buy or reserve
let back = {};       // tokens marked to go back, past ten
let wasMine = false; // whether the last view already waited on you

const me = (view) => view.players.find((p) => p.seat === view.you);
const seatName = (view, seat) => {
  const p = view.players.find((q) => q.seat === seat);
  return p ? p.name : 'someone';
};
const isObserver = (view) => !!view.observer;
const canAct = (view) => !!view.ask && view.ask.seat === view.you && !isObserver(view) && !!me(view) && view.phase !== 'over';
const held = (p) => sumOf(p.tokens);

function clearSel() {
  picks = [];
  sel = null;
  back = {};
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
  if (picks.length === 3 || (avail < 3 && picks.length === avail)) return { move: { kind: 'take', gems: picks.slice() } };
  if (avail < 3) return { move: { kind: 'take', gems: picks.slice() } };
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
  sel = sel && sel.card === id ? null : { card: id };
  rerender();
}

function pickDeck(level) {
  picks = [];
  sel = sel && sel.level === level ? null : { level };
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

// ---------------------------------------------------------------- the table

function renderBoard(view) {
  const board = $('#board');
  const my = me(view);
  const act = canAct(view) && view.ask.kind === 'turn';
  const wrap = el('div', 'board');
  const nobles = el('div', 'nobles');
  for (const nb of view.nobles) nobles.append(nobleEl(nb));
  if (!view.nobles.length) nobles.append(el('span', 'dim nobles-gone', 'Every Noble has been won.'));
  wrap.append(nobles);
  // the cards, level 3 at the top as the decks are laid out
  const rows = el('div', 'market');
  for (const l of [3, 2, 1]) {
    const row = el('div', `mrow lv${l}`);
    const deckOk = act && view.decks[l] > 0 && my.reserved.length < RESERVE_LIMIT;
    const deck = cardBack(l, view.decks[l], `deck${sel && sel.level === l ? ' selected' : ''}${deckOk ? ' can' : ''}${view.decks[l] ? '' : ' gone'}`, deckOk ? 'button' : 'div');
    if (deckOk) deck.addEventListener('click', () => pickDeck(l));
    row.append(deck);
    for (const c of view.market[l]) {
      if (!c) {
        row.append(el('div', 'card empty'));
        continue;
      }
      const afford = act && view.affordable.includes(c.id);
      const n = cardEl(c, view, `${afford ? 'afford' : ''}${sel && sel.card === c.id ? ' selected' : ''}${act ? ' can' : ''}`, act ? 'button' : 'div');
      if (act) n.addEventListener('click', () => pickCard(c.id));
      row.append(n);
    }
    rows.append(row);
  }
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
  const mid = el('div', 'mid');
  mid.append(rows, bank);
  wrap.append(mid);
  board.replaceChildren(wrap);
}

// A player's place at the table: Prestige points; bonuses and tokens gem by
// gem — the cards bought above, the tokens held below; reserved cards; Nobles.
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
    f.dataset.tip = 'The First Player. Once someone reaches 15 Prestige points, the round ends with the player before them, so everyone plays as many turns.';
    head.append(f);
  }
  if (turnNow) head.append(el('span', 'turn-tag', view.ask && view.ask.kind !== 'turn' ? '…' : 'turn'));
  const fromCards = p.cards.reduce((a, c) => a + c.points, 0);
  const pts = el('span', 'pl-pts', String(p.points));
  pts.dataset.tip = `${p.points} Prestige point${p.points === 1 ? '' : 's'}${p.nobles.length ? `: ${fromCards} from cards, ${p.points - fromCards} from Noble${p.nobles.length === 1 ? '' : 's'}` : ''}. ${p.cards.length} card${p.cards.length === 1 ? '' : 's'} bought — fewer wins a tie.`;
  head.append(pts);
  box.append(head);

  const gems = el('div', 'pl-gems');
  for (const t of TOKENS) {
    const col = el('div', `pg t-${t}`);
    if (t === GOLD) col.append(el('span', 'pg-bonus blank', ''));
    else {
      const b = el('span', `pg-bonus${p.bonuses[t] ? '' : ' none'}`, String(p.bonuses[t]));
      b.dataset.tip = `${p.bonuses[t]} ${gemName(t)} card${p.bonuses[t] === 1 ? '' : 's'} bought: ${p.bonuses[t]} ${gemName(t)} off every card.`;
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
  const res = el('div', 'pl-res');
  const act = mine && canAct(view) && view.ask.kind === 'turn';
  for (const r of p.reserved) {
    if (r.hidden) {
      res.append(cardBack(r.level, null, 'mini'));
      continue;
    }
    const afford = act && view.affordable.includes(r.id);
    const n = cardEl(r, view, `${mine ? 'held' : 'mini'}${afford ? ' afford' : ''}${sel && sel.card === r.id ? ' selected' : ''}${act ? ' can' : ''}${r.blind ? ' blind' : ''}`, act ? 'button' : 'div');
    if (r.blind && p.seat === view.you) n.dataset.tip += ' Reserved unseen from the deck: the others see only its back.';
    if (act) n.addEventListener('click', () => pickCard(r.id));
    res.append(n);
  }
  if (p.reserved.length) {
    res.dataset.tip = `${p.reserved.length} reserved card${p.reserved.length === 1 ? '' : 's'} of ${RESERVE_LIMIT}. Only their holder can buy them.`;
    foot.append(res);
  } else if (mine) foot.append(el('span', 'dim pl-none', 'No reserved cards'));
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
    add('act-head', a.kind === 'turn' ? `${who}’s turn.` : a.kind === 'discard' ? `${who} gives back ${a.n} token${a.n === 1 ? '' : 's'} to keep ten.` : `${who} chooses which Noble visits.`);
    if (a.kind === 'turn') add('act-sub', 'Take gems, reserve a card, or buy one.');
    return;
  }

  if (a.kind === 'discard') {
    const marked = sumOf(back);
    add('act-head', `You hold ${held(my)} tokens: give ${a.n} back.`);
    add('act-sub', marked ? `Going back: ${tokenWords(back)}${marked < a.n ? ` — ${a.n - marked} more` : ''}.` : 'Tap your tokens below to choose which go back to the supply.');
    const r = row();
    r.append(btn(marked === a.n ? `Give back ${tokenWords(back)}` : `Give back ${a.n}`, 'primary', () => send({ tokens: { ...back } }), marked !== a.n));
    if (marked) r.append(btn('Clear', 'ghost', () => { back = {}; rerender(); }));
    return;
  }

  if (a.kind === 'noble') {
    add('act-head', 'More than one Noble would visit — choose one.');
    add('act-sub', 'Only one comes each turn; the other may still visit at the end of a later turn.');
    const r = el('div', 'card-row');
    for (const nb of view.nobles.filter((x) => a.options.includes(x.id))) {
      const n = nobleEl(nb, 'can', 'button');
      n.addEventListener('click', () => send({ noble: nb.id }));
      r.append(n);
    }
    box.append(r);
    return;
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
    const c = fromHand || [1, 2, 3].flatMap((l) => view.market[l]).find((x) => x && x.id === sel.card);
    if (!c) { sel = null; return renderAction(view); }
    const head = add('act-head', '');
    head.append(cardEl(c, view, 'inline'), document.createTextNode(` A level-${c.level} ${gemName(c.bonus)} card${c.points ? `, ${c.points} Prestige point${c.points === 1 ? '' : 's'}` : ''}.`));
    const pay = payFor(my, c);
    add('act-sub', affordWords(my, c));
    const r = row();
    r.append(btn(pay ? (sumOf(pay) ? `Buy it for ${tokenWords(pay)}` : 'Buy it with bonuses alone') : 'Buy it', 'primary', () => send({ kind: 'buy', card: c.id }), !pay));
    if (!fromHand) {
      const full = my.reserved.length >= RESERVE_LIMIT;
      r.append(btn(full ? `Reserve it (${RESERVE_LIMIT} held already)` : `Reserve it${view.bank.gold ? ' and take a Gold' : ''}`, 'secondary', () => send({ kind: 'reserve', card: c.id }), full));
    }
    r.append(btn('Cancel', 'ghost', () => { sel = null; rerender(); }));
    if (!fromHand && view.bank.gold && my.reserved.length < RESERVE_LIMIT && held(my) + 1 > TOKEN_LIMIT) add('act-note', 'Reserving brings a Gold — eleven tokens, so one would go back.');
    return;
  }
  if (sel && sel.level) {
    add('act-head', `Reserve the top card of the level-${sel.level} deck, unseen${view.bank.gold ? ', and take a Gold' : ''}?`);
    add('act-sub', 'You see it once it is yours; the others see only its level.');
    const r = row();
    r.append(btn('Reserve it', 'primary', () => send({ kind: 'reserve', level: sel.level })));
    r.append(btn('Cancel', 'ghost', () => { sel = null; rerender(); }));
    return;
  }
  add('act-head', 'Your turn: take gems from the supply, or choose a card to buy or reserve.');
  const k = view.affordable.length;
  add('act-sub', k ? `You can buy ${k === 1 ? 'one card' : `${k} cards`} now — lit in gold.` : 'Three different gems, or two of one colour from a pile of four or more.');
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
  const tokens = (t, sign) => GEMS.concat(GOLD).flatMap((g) => Array.from({ length: t[g] || 0 }, () => tokenEl(g, null, 'small'))).concat(sign ? [el('b', '', sign)] : []);
  switch (f.kind) {
    case 'take':
      return stamp(f.seat, tokens(f.tokens), 'take');
    case 'return':
      return stamp(f.seat, [el('b', '', '−'), ...tokens(f.tokens)], 'return');
    case 'reserve':
      return stamp(f.seat, [el('b', '', 'Reserves'), f.card ? cardEl(f.card, null, 'inline') : cardBack(f.level, null, 'inline')], 'reserve');
    case 'buy':
      return stamp(f.seat, [cardEl(f.card, null, 'inline'), el('b', '', f.card.points ? `+${f.card.points}` : 'bought')], 'buy');
    case 'noble':
      return flash(`A Noble visits ${f.seat === view.you && !isObserver(view) ? 'you' : name}: +3`, 'noble');
    case 'ending':
      return flash(`${f.seat === view.you && !isObserver(view) ? 'You reach' : `${name} reaches`} ${WIN_POINTS} — the last round`, 'plain');
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
  if (sel && sel.card != null && ![1, 2, 3].some((l) => view.market[l].some((c) => c && c.id === sel.card)) && !(me(view) && me(view).reserved.some((c) => c.id === sel.card))) sel = null;

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
    lc.dataset.tip = `${seatName(view, view.ending)} reached ${WIN_POINTS}. The round ends with ${lastP.seat === view.you && !isObserver(view) ? 'you' : lastP.name}, so everyone plays as many turns.`;
  }

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
  const order = view.players.slice().sort((a, b) => b.points - a.points || a.cards.length - b.cards.length);
  for (const p of order) {
    const row = el('li', `rank-row${p.seat === view.you ? ' me' : ''}${winners.includes(p.seat) ? ' won' : ''}`);
    row.append(avatarEl(p.name, p.seat, p.bot));
    const nm = el('span', 'rank-name');
    nm.append(el('b', '', p.name + (p.connected || p.bot ? '' : ' (left)')), el('small', '', `${p.cards.length} card${p.cards.length === 1 ? '' : 's'}${p.nobles.length ? ` · ${p.nobles.length} Noble${p.nobles.length === 1 ? '' : 's'}` : ''}`));
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

