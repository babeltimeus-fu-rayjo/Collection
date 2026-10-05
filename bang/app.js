// app.js — networking + UI for BANG!.
//
// Topology: host-authoritative star over WebRTC data channels.
//   - The host's browser owns the game and validates every move.
//   - Guests connect straight to the host (peer-to-peer); no game server.
//   - NAT traversal uses Google's public STUN servers (see RTC_CONFIG).
//   - Peer discovery/signaling uses the free PeerJS cloud broker, because
//     GitHub Pages can only serve static files.
// Every player gets their own view: their own hand and role; everyone's
// character, life points, cards in play and hand size; the Sheriff's star
// and the roles of the eliminated — and nothing else. Bots fill empty seats
// and play in the host's browser, and take over for anyone who disconnects.

import {
  PROTO,
  MIN_PLAYERS,
  MAX_PLAYERS,
  KINDS,
  CHARACTERS,
  ROLES,
  ROLES_FOR,
  SUITS,
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
const cfg = initSettings('bng', [
  { key: 'botTurn', label: 'Bot plays a card every', def: [1300, 700], section: 'Host pacing', host: true, hint: 'A bot plays its turn one card at a time, so the table can follow it.' },
  { key: 'botAnswer', label: 'Bot answers a shot in', def: [800, 500], section: 'Host pacing', host: true, hint: 'Missed!, the Indians, a Duel, Sid Ketchum at death’s door.' },
  { key: 'botDraw', label: 'Bot draws and discards in', def: [700, 400], section: 'Host pacing', host: true, hint: 'Jesse Jones, Pedro Ramirez and Kit Carlson drawing; the General Store; discarding at the end of a turn.' },
  { key: 'stampMs', label: 'Shots and wounds show for', def: 1400, section: 'Bubbles & banners' },
  { key: 'bubbleChat', label: 'Chat bubbles linger', def: 6500, section: 'Bubbles & banners' },
  { key: 'bubbleTrunc', label: 'Bubble text cap', def: 84, min: 12, max: 400, step: 4, unit: 'ch', ms: false, section: 'Bubbles & banners' },
  { key: 'flashMs', label: 'Banner duration', def: 1900, section: 'Bubbles & banners' },
  { key: 'overlayDelay', label: 'Result screen delay', def: 2600, section: 'Overlays' },
  { key: 'revealBots', label: "Show the bots' roles", def: false, bool: true, section: 'Testing', host: true, hint: 'Marks every bot’s role at the table, to see why they play as they do. Only the host builds views, so this shows them to everyone.' },
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
const ID_PREFIX = 'bng-v1-';
// frontier nicknames — none of them a character's name
const BOT_NAMES = ['Dusty', 'Tex', 'Rawhide', 'Sundown', 'Cactus', 'Mesa', 'Copper', 'Sagebrush'];
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

  // Roles and hands are secret, so a watcher may take over an abandoned seat
  // only if it is the only view they have ever had — someone who has stood
  // behind another player's chair knows that player's role and cards.
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

  // The host's clock lets the bots act, one card at a time so the table can
  // see who did what — a bot's whole turn, its answers to a BANG!, the
  // Indians or a Duel, its picks from the General Store.
  schedule(ms) {
    clearTimeout(this.tickTimer);
    if (!this.G || this.G.phase === 'over') return;
    this.tickTimer = setTimeout(() => this.tick(), Math.max(20, ms));
  }

  botDelay() {
    const a = this.G.ask;
    if (!a) return 1000;
    return cfg.range({ turn: 'botTurn', shot: 'botAnswer', indians: 'botAnswer', duel: 'botAnswer', dying: 'botAnswer' }[a.kind] || 'botDraw');
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
            full: 'That room is full (7 players max).',
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

const REJOIN_KEY = 'bng-rejoin';

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


// ---------------------------------------------------------------- the cards and roles, as the table shows them

// A picture for each card. The weapons get a gunsight with their range in
// it, as the printed cards have — not 🔫, which most phones now draw as a
// water pistol.
const GLYPH = {
  bang: '💥', missed: '💨', beer: '🍺', saloon: '🥃', stagecoach: '🐴', wellsfargo: '💰', generalstore: '🏪',
  panic: '😱', catbalou: '💃', gatling: '🔥', indians: '🏹', duel: '🤠', barrel: '🛢️', dynamite: '🧨', jail: '⛓️',
  mustang: '🐎', scope: '🔭', volcanic: '◎', schofield: '◎', remington: '◎', carabine: '◎', winchester: '◎',
};
const RED_SUIT = new Set(['H', 'D']);
const ROLE_WORD = { sheriff: 'Sheriff', deputy: 'Deputy', outlaw: 'Outlaw', renegade: 'Renegade' };
const ROLE_A = { sheriff: 'the Sheriff', deputy: 'a Deputy', outlaw: 'an Outlaw', renegade: 'the Renegade' };
const WIN_WORD = { law: 'The Sheriff and the Deputies win', outlaws: 'The Outlaws win', renegade: 'The Renegade wins' };
const corner = (c) => `${c.rank}${SUITS[c.suit]}`;

function listWords(a) {
  return a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}

// "the Sheriff, a Deputy, 2 Outlaws and the Renegade"
function rolesLine(counts) {
  const words = [];
  for (const r of ['sheriff', 'deputy', 'outlaw', 'renegade']) {
    const k = counts[r] || 0;
    if (!k) continue;
    words.push(k > 1 ? `${k} ${ROLE_WORD[r]}s` : ROLE_A[r]);
  }
  return listWords(words);
}
const countRoles = (list) => list.reduce((m, r) => ((m[r] = (m[r] || 0) + 1), m), {});

// A card as its face shows it: the name, a picture, the suit and value in
// the corner that a "draw!" reads, a weapon's range in its sight, and the
// brown or blue border of the printed card.
function cardEl(c, cls = '', tag = 'div') {
  const k = KINDS[c.kind];
  const n = el(tag, `card ${k.color}${k.weapon ? ' weapon' : ''} k-${c.kind}${cls ? ` ${cls}` : ''}`);
  if (tag === 'button') n.type = 'button';
  // one long word (REMINGTON, WINCHESTER, STAGECOACH) is set smaller rather
  // than broken across two lines
  const long = Math.max(...k.name.split(' ').map((w) => w.length)) >= 9;
  n.append(el('span', `cd-name${long ? ' long' : ''}`, k.name));
  if (k.weapon) n.append(el('span', 'cd-range', String(k.range)));
  else n.append(el('span', 'cd-glyph', GLYPH[c.kind]));
  n.append(el('span', `cd-corner${RED_SUIT.has(c.suit) ? ' red' : ''}`, corner(c)));
  cardTip(n, c);
  return n;
}

function cardTip(n, c, why = null) {
  const k = KINDS[c.kind];
  n.dataset.tip = `${k.name} (${corner(c)}): ${k.text}`;
  n.dataset.kind = c.kind;
  n.dataset.face = corner(c);
  if (why) n.dataset.why = why;
  if (c.id != null) n.dataset.tipKey = `card-${c.id}`;
}

// a card someone has in play, as a chip on their seat
function chipEl(c) {
  const k = KINDS[c.kind];
  const n = el('span', `inplay k-${c.kind}${k.weapon ? ' weapon' : ''}`);
  n.append(el('span', 'ip-glyph', GLYPH[c.kind]), el('span', 'ip-name', k.weapon ? `${k.name} ${k.range}` : k.name));
  cardTip(n, c);
  return n;
}

// life points as the bullets on the character card
function lifeEl(p) {
  const box = el('span', 'life');
  for (let i = 0; i < p.max; i++) box.append(el('i', i < p.life ? 'full' : ''));
  box.dataset.tip = p.alive
    ? `${p.life} of ${p.max} life points${p.role === 'sheriff' ? ' — the Sheriff has one more than the character card shows' : ''}. At the end of a turn you keep no more cards than your life points.`
    : 'Eliminated.';
  return box;
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
  // the seats so far, and empty ones up to the four a game needs (or one more)
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
      row.append(el('div', 'av empty', '·'), el('span', 'seat-name dim', i < MIN_PLAYERS ? 'Empty seat — a game needs four' : 'Empty seat'));
    }
    list.append(row);
  }

  // the roles the table will be dealt, at its size now (or four)
  const tn = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, n));
  const sum = $('#cast-summary');
  sum.replaceChildren();
  sum.append(el('div', 'cast-head', n >= MIN_PLAYERS ? `Dealt at this table of ${tn}:` : `Dealt at a table of ${tn}:`));
  const line = el('div', 'cast-roles');
  for (const r of ['sheriff', 'deputy', 'outlaw', 'renegade']) {
    const k = ROLES_FOR[tn].filter((x) => x === r).length;
    if (!k) continue;
    const t = el('span', `role-tag r-${r}`, `${k > 1 ? `${k} ` : ''}${r === 'sheriff' ? '★ ' : ''}${ROLE_WORD[r]}${k > 1 ? 's' : ''}`);
    t.dataset.tip = `${ROLE_WORD[r]}: ${ROLES[r].goal}`;
    line.append(t);
  }
  sum.append(line);
  sum.append(el('div', 'cast-note', 'The Sheriff shows the star; every other role stays secret until its player is eliminated.'));

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
let sel = null;        // the card chosen in your hand
let selTarget = null;  // Panic! and Cat Balou: the player picked, before the card to take
let picks = [];        // cards chosen to discard: at the end of a turn, or two for Sid Ketchum
let mode = null;       // 'sid' while Sid Ketchum picks two cards to trade for a life point
let roleShownFor = null;
let wasMine = false;   // whether the last view already waited on you

const me = (view) => view.players.find((p) => p.seat === view.you);
const seatName = (view, seat) => {
  const p = view.players.find((q) => q.seat === seat);
  return p ? p.name : 'someone';
};
const isObserver = (view) => !!view.observer;
const canAct = (view) => !!view.ask && view.ask.seat === view.you && !isObserver(view) && !!me(view) && view.phase !== 'over';

function clearSel() {
  sel = null;
  selTarget = null;
  picks = [];
  mode = null;
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

// the cards in hand that answer what is asked: Missed! against a shot, BANG!
// against the Indians or in a Duel — and for Calamity Janet, either one
function answers(view) {
  const my = me(view);
  const a = view.ask;
  if (!my || !a) return [];
  const cal = my.char === 'calamity';
  if (a.kind === 'shot') return view.hand.filter((c) => c.kind === 'missed' || (cal && c.kind === 'bang'));
  if (a.kind === 'indians' || a.kind === 'duel') return view.hand.filter((c) => c.kind === 'bang' || (cal && c.kind === 'missed'));
  return [];
}

// the seats the chosen card can be played on, lit up at the table
function targetSeats(view) {
  if (!canAct(view) || view.ask.kind !== 'turn' || sel == null || mode) return new Set();
  const info = view.playable && view.playable[sel];
  if (!info || info.why || !info.targets || selTarget != null) return new Set();
  return new Set(info.targets);
}

function chooseTarget(view, c, seat) {
  if (c.kind === 'panic' || c.kind === 'catbalou') {
    const t = view.players.find((p) => p.seat === seat);
    // only one thing to take: no need to ask which
    if (!t.table.length) return send({ kind: 'play', card: c.id, target: seat, from: 'hand' });
    if (!t.hand && t.table.length === 1) return send({ kind: 'play', card: c.id, target: seat, pick: t.table[0].id });
    selTarget = seat;
    return rerender();
  }
  send({ kind: 'play', card: c.id, target: seat });
}

function seatClick(view, seat) {
  const c = view.hand.find((x) => x.id === sel);
  if (c) chooseTarget(view, c, seat);
}

// ---------------------------------------------------------------- the table

function roleBadge(view, p) {
  let r = p.role;
  let peek = false;
  if (!r) {
    const b = view.revealBots && view.revealBots.find((x) => x.seat === p.seat);
    if (b) {
      r = b.role;
      peek = true;
    }
  }
  if (!r) {
    const t = el('span', 'role-tag hidden-role', '?');
    t.dataset.tip = 'A secret role: a Deputy, an Outlaw or the Renegade. It is turned face up when its player is eliminated.';
    return t;
  }
  const t = el('span', `role-tag r-${r}${peek ? ' peek' : ''}`, `${r === 'sheriff' ? '★ ' : ''}${ROLE_WORD[r]}`);
  t.dataset.tip = `${ROLE_WORD[r]}${p.seat === view.you ? ' — your role' : peek ? ' — shown for testing' : !p.alive && r !== 'sheriff' ? ', turned face up on elimination' : ''}. ${ROLES[r].goal}`;
  return t;
}

function seatEl(view, p, target) {
  const s = el(target ? 'button' : 'div', 'seat');
  if (target) {
    s.type = 'button';
    s.classList.add('target');
    s.addEventListener('click', () => seatClick(view, p.seat));
  }
  s.dataset.seat = String(p.seat);
  const my = me(view);
  s.classList.toggle('me', p.seat === view.you);
  s.classList.toggle('turn', view.turn === p.seat && view.phase !== 'over');
  s.classList.toggle('asked', !!view.ask && view.ask.seat === p.seat && view.ask.kind !== 'turn');
  s.classList.toggle('out', !p.alive);
  s.classList.toggle('gone', !p.connected && !p.bot);
  s.classList.toggle('chosen', selTarget === p.seat);
  const top = el('div', 'seat-top');
  top.append(avatarEl(p.name, p.seat, p.bot), el('span', 'seat-name', p.name));
  if (p.seat === view.you) top.append(el('span', 'you-tag', 'you'));
  s.append(top);
  const ch = el('div', 'seat-char', CHARACTERS[p.char].name);
  ch.dataset.tip = `${CHARACTERS[p.char].name}: ${CHARACTERS[p.char].text}`;
  ch.dataset.char = p.char;
  ch.dataset.tipKey = `char-${p.seat}`;
  s.append(ch);
  const row = el('div', 'seat-line');
  row.append(lifeEl(p), roleBadge(view, p));
  s.append(row);
  if (p.alive) {
    const info = el('div', 'seat-line small');
    const hc = el('span', 'hand-count');
    hc.append(el('i', 'mini-back'), document.createTextNode(String(p.hand)));
    hc.dataset.tip = `${p.hand} card${p.hand === 1 ? '' : 's'} in hand.`;
    hc.dataset.tipKey = `hand-${p.seat}`;
    info.append(hc);
    if (p.seat === view.you) {
      const r = el('span', 'dist mine', `range ${p.range}`);
      r.dataset.tip = `${isObserver(view) ? `${p.name}’s` : 'Your'} weapon reaches distance ${p.range}${p.range === 1 && !p.table.some((c) => KINDS[c.kind].weapon) ? ' — the Colt .45 everyone starts with' : ''}.`;
      r.dataset.tipKey = `range-${p.seat}`;
      info.append(r);
    } else if (p.dist != null && my) {
      const reach = p.dist <= my.range;
      const d = el('span', `dist${reach ? ' reach' : ''}`, `${p.dist} away`);
      d.dataset.tip = `At distance ${p.dist} from ${isObserver(view) ? my.name : 'you'} — ${reach ? `within reach of a BANG! (range ${my.range})` : `out of reach of a BANG! (range ${my.range})`}.${p.dist === 1 ? ' Close enough for Panic!.' : ''}`;
      d.dataset.tipKey = `dist-${p.seat}`;
      info.append(d);
    }
    if (view.turn === p.seat && view.phase !== 'over') {
      const t = el('span', 'tok turn', 'turn');
      t.dataset.tip = `${p.seat === view.you ? 'Your' : `${p.name}’s`} turn.`;
      info.append(t);
    }
    s.append(info);
  } else {
    s.append(el('div', 'seat-line small out-note', 'eliminated'));
  }
  if (p.table.length) {
    const t = el('div', 'seat-table');
    for (const c of p.table) t.append(chipEl(c));
    s.append(t);
  }
  return s;
}

// The middle of the table: the deck, the discard pile, the last "draw!"
function tableauEl(view) {
  const t = el('div', 'tableau');
  const piles = el('div', 'piles');
  const deck = el('div', 'pile');
  const back = el('div', 'card back');
  back.append(el('span', 'back-mark', 'BANG!'));
  deck.append(back, el('span', 'pile-n', `deck · ${view.deck}`));
  deck.dataset.tip = `The deck: ${view.deck} card${view.deck === 1 ? '' : 's'}. When it runs out, the discard pile is shuffled into a new one.`;
  piles.append(deck);
  const disc = el('div', 'pile');
  if (view.discardTop) disc.append(cardEl(view.discardTop, 'small'));
  else disc.append(el('div', 'card empty'));
  disc.append(el('span', 'pile-n', `discards · ${view.discardCount}`));
  piles.append(disc);
  if (view.flips) {
    const f = view.flips;
    const what = f.why.replace(/^the /, '');
    const verdict = {
      Barrel: f.ok ? 'a Heart: missed!' : 'no Heart: hit',
      Jail: f.ok ? 'a Heart: out of Jail' : 'no Heart: stays in Jail',
      Dynamite: f.ok ? 'safe: it passes on' : 'Spades 2–9: it explodes',
    }[what] || '';
    const box = el('div', `pile flip ${f.ok ? 'ok' : 'bad'}`);
    const cards = el('div', 'flip-cards');
    for (const c of f.cards) cards.append(cardEl(c, `small${f.cards.length > 1 && !c.picked ? ' unpicked' : ''}`));
    box.append(cards, el('span', 'pile-n', `draw! · ${what}`));
    box.dataset.tip = `${seatName(view, f.seat)} drew! for the ${what}: ${verdict}.${f.cards.length > 1 ? ' Lucky Duke turns two and keeps the one he likes.' : ''}`;
    piles.append(box);
  }
  t.append(piles);
  return t;
}

function renderBoard(view) {
  const board = $('#board');
  // Measured before anything is taken away, and swapped in whole at the end:
  // an empty board would shrink the page for a moment, and the browser would
  // pull a phone scrolled down to its hand back to the top on every move.
  const wide = (board.clientWidth || document.documentElement.clientWidth) >= 660;
  const ring = el('div', 'ring');
  const n = view.players.length;
  ring.classList.toggle('round', wide);
  ring.classList.add(`n${n}`);
  const youIdx = Math.max(0, view.players.findIndex((p) => p.seat === view.you));
  ring.append(tableauEl(view));
  const targets = targetSeats(view);
  for (let k = 0; k < n; k++) {
    // you at the bottom, then clockwise round the table: the player on your
    // left is the next to play
    const p = view.players[(youIdx + k) % n];
    const s = seatEl(view, p, targets.has(p.seat));
    if (wide) {
      const a = Math.PI / 2 + (k * 2 * Math.PI) / n;
      s.style.left = `${50 + 40 * Math.cos(a)}%`;
      s.style.top = `${50 + 37 * Math.sin(a)}%`;
    }
    ring.append(s);
  }
  board.replaceChildren(ring);
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
    add(`act-head win-${view.winner}`, `${WIN_WORD[view.winner]} — ${view.why}.`);
    return;
  }
  if (!a) return;
  const my = me(view);
  const who = seatName(view, a.seat);
  const sidRow = (r, label) => {
    if (my && my.char === 'sid' && my.life < my.max && view.hand.length >= 2) {
      r.append(btn(label, 'ghost', () => {
        sel = null;
        selTarget = null;
        picks = [];
        mode = 'sid';
        rerender();
      }));
    }
  };
  const sidPanel = () => {
    add('act-head', 'Sid Ketchum: choose two cards to discard for a life point.');
    add('act-sub', `${picks.length} of 2 chosen — tap them in your hand.`);
    const r = row();
    r.append(btn('Discard them for a life point', 'primary', () => send({ kind: 'sid', cards: picks.slice() }), picks.length !== 2));
    r.append(btn('Cancel', 'ghost', () => {
      clearSel();
      rerender();
    }));
  };

  switch (a.kind) {
    case 'turn': {
      if (!mine) {
        add('act-head', `${who}’s turn.`);
        add('act-sub', 'Draw two, play any cards, discard down to their life points.');
        return;
      }
      if (mode === 'sid') return sidPanel();
      const c = sel != null ? view.hand.find((x) => x.id === sel) : null;
      if (!c) {
        add('act-head', 'Your turn: play cards from your hand, then end your turn.');
      } else {
        const info = (view.playable && view.playable[c.id]) || {};
        const k = KINDS[c.kind];
        const head = add('act-head', '');
        head.append(el('span', 'act-card', `${GLYPH[c.kind]} ${k.name}`), document.createTextNode(` ${k.text}`));
        if (info.why) {
          add('act-warn', info.why);
          row().append(btn('Put it back', 'ghost', () => {
            clearSel();
            rerender();
          }));
        } else if (!info.targets) {
          if (c.kind === 'beer' && my.life >= my.max) add('act-warn', 'You are at full life: it would do nothing.');
          if (c.kind === 'beer' && view.players.filter((p) => p.alive).length <= 2) add('act-warn', 'With two players left, a Beer does nothing.');
          const r = row();
          r.append(btn(k.color === 'blue' ? `Put ${k.name} in play` : `Play ${k.name}`, 'primary', () => send({ kind: 'play', card: c.id })));
          r.append(btn('Put it back', 'ghost', () => {
            clearSel();
            rerender();
          }));
        } else if (selTarget != null) {
          const t = view.players.find((p) => p.seat === selTarget);
          add('act-sub', `${c.kind === 'panic' ? 'Take' : 'Make them discard'} which of ${t.name}’s cards?`);
          const r = row();
          for (const tc of t.table) r.append(btn(`${GLYPH[tc.kind]} ${KINDS[tc.kind].name}`, 'secondary', () => send({ kind: 'play', card: c.id, target: t.seat, pick: tc.id })));
          if (t.hand) r.append(btn(`A card from their hand, at random (${t.hand})`, 'secondary', () => send({ kind: 'play', card: c.id, target: t.seat, from: 'hand' })));
          r.append(btn('Back', 'ghost', () => {
            selTarget = null;
            rerender();
          }));
        } else {
          add('act-sub', 'On whom? Tap them at the table, or here:');
          const r = row();
          for (const s of info.targets) {
            const p = view.players.find((q) => q.seat === s);
            r.append(btn(`${p.name}${p.dist != null ? ` · ${p.dist} away` : ''}`, 'secondary target-btn', () => chooseTarget(view, c, s)));
          }
          r.append(btn('Put it back', 'ghost', () => {
            clearSel();
            rerender();
          }));
        }
      }
      const r = row();
      r.append(btn('End your turn', 'primary end-turn', () => send({ kind: 'end' })));
      sidRow(r, 'Sid Ketchum: two cards for a life point');
      const over = view.hand.length - Math.max(0, my.life);
      if (over > 0) r.append(el('span', 'act-note', `${view.hand.length} cards, ${my.life} life point${my.life === 1 ? '' : 's'}: ending now, you discard ${over}.`));
      return;
    }

    case 'discard': {
      if (!mine) {
        add('act-head', `${who} discards down to their life points.`);
        return;
      }
      if (mode === 'sid') return sidPanel();
      add('act-head', `Too many cards: discard ${a.n}.`);
      add('act-sub', `At the end of your turn you keep as many cards as your life points (${my.life}). Tap ${a.n === 1 ? 'the card' : `the ${a.n} cards`} to let go.`);
      const r = row();
      r.append(btn(picks.length && picks.length !== a.n ? `Discard (${picks.length} of ${a.n})` : `Discard ${a.n === 1 ? 'it' : 'them'}`, 'primary', () => send({ cards: picks.slice() }), picks.length !== a.n));
      sidRow(r, 'Sid Ketchum: two for a life point instead');
      return;
    }

    case 'shot': {
      const from = seatName(view, a.from);
      const gat = a.card === 'gatling';
      if (!mine) {
        add('act-head', `${from} ${gat ? 'fires the Gatling' : 'shoots'} at ${who}.`);
        add('act-sub', `Waiting for ${who}: ${a.need === 2 ? 'two Missed!' : 'a Missed!'} or the hit.`);
        return;
      }
      add('act-head danger', gat ? `${from} opens fire with the Gatling!` : `${from} shoots you: BANG!`);
      const ans = answers(view);
      add('act-sub', a.need === 2 ? 'Slab the Killer’s BANG! takes two Missed! to stop.' : 'Play a Missed! to dodge it, or take the hit.');
      const r = row();
      if (a.need === 1) {
        const m = ans.find((c) => c.kind === 'missed');
        const b = ans.find((c) => c.kind === 'bang');
        if (m) r.append(btn('💨 Play Missed!', 'primary', () => send({ kind: 'cards', cards: [m.id] })));
        if (b) r.append(btn('💥 Play a BANG! as Missed!', 'secondary', () => send({ kind: 'cards', cards: [b.id] })));
      } else {
        const two = ans.slice().sort((x, y) => (x.kind === 'missed' ? 0 : 1) - (y.kind === 'missed' ? 0 : 1)).slice(0, 2);
        const label = two[0].kind === two[1].kind ? `two ${KINDS[two[0].kind].name}` : listWords(two.map((c) => KINDS[c.kind].name));
        r.append(btn(`Play ${label}`, 'primary', () => send({ kind: 'cards', cards: two.map((c) => c.id) })));
      }
      r.append(btn(my.life <= 1 ? 'Take the hit — your last life point' : 'Take the hit', 'danger', () => send({ kind: 'take' })));
      lastBreath(view, add);
      return;
    }

    case 'indians':
    case 'duel': {
      const duel = a.kind === 'duel';
      const other = seatName(view, a.other);
      if (!mine) {
        add('act-head', duel ? `Duel: ${who} against ${other}.` : `Indians! sent by ${seatName(view, a.from)}.`);
        add('act-sub', `${who} must discard a BANG! or lose a life point.`);
        return;
      }
      add('act-head danger', duel ? `A Duel with ${other}!` : `${seatName(view, a.from)} sends the Indians!`);
      add('act-sub', duel ? 'Discard a BANG! to fire back — then it is their turn to answer — or lose a life point.' : 'Discard a BANG! or lose a life point. Missed! and Barrels are no help.');
      const ans = answers(view);
      const b = ans.find((c) => c.kind === 'bang');
      const m = ans.find((c) => c.kind === 'missed');
      const r = row();
      if (b) r.append(btn(duel ? '💥 Fire back: discard a BANG!' : '💥 Discard a BANG!', 'primary', () => send({ kind: 'card', card: b.id })));
      if (m) r.append(btn('💨 Discard a Missed! as a BANG!', 'secondary', () => send({ kind: 'card', card: m.id })));
      r.append(btn(duel ? 'Give up: lose a life point' : 'Lose a life point', 'danger', () => send({ kind: 'take' })));
      lastBreath(view, add);
      return;
    }

    case 'store': {
      add('act-head', mine ? 'General Store: take one card.' : `General Store: ${who} is choosing.`);
      const r = el('div', 'card-row');
      for (const c of view.store.cards) {
        const n = cardEl(c, mine ? 'can' : '', mine ? 'button' : 'div');
        if (mine) n.addEventListener('click', () => send({ kind: 'card', card: c.id }));
        r.append(n);
      }
      box.append(r);
      const order = view.store.order.filter((s) => view.players.find((p) => p.seat === s && p.alive));
      const rest = order.slice(view.store.at + 1).map((s) => (s === view.you ? 'you' : seatName(view, s)));
      if (rest.length) add('act-sub', `Then ${listWords(rest)}, in turn — the last card goes to the last player.`);
      return;
    }

    case 'dying': {
      if (!mine) {
        add('act-head', `${who} is down to 0 life points.`);
        add('act-sub', 'As Sid Ketchum, they may discard two cards to stay in the game.');
        return;
      }
      add('act-head danger', 'You are down to 0 life points.');
      add('act-sub', `Sid Ketchum: discard two cards for a life point and stay in — ${picks.length} of 2 chosen. Or fall.`);
      const r = row();
      r.append(btn('Discard them for a life point', 'primary', () => send({ kind: 'sid', cards: picks.slice() }), picks.length !== 2));
      r.append(btn('Fall', 'danger', () => send({ kind: 'die' })));
      return;
    }

    case 'jesse': {
      if (!mine) {
        add('act-head', `${who} (Jesse Jones) chooses where to draw from.`);
        return;
      }
      add('act-head', 'Jesse Jones: where does your first card come from?');
      add('act-sub', 'At random from another player’s hand — or the deck. The second comes from the deck.');
      const r = row();
      for (const p of view.players) {
        if (p.alive && p.seat !== view.you && p.hand) r.append(btn(`${p.name}’s hand (${p.hand})`, 'secondary', () => send({ from: p.seat })));
      }
      r.append(btn('The deck', 'ghost', () => send({ from: 'deck' })));
      return;
    }

    case 'pedro': {
      if (!mine) {
        add('act-head', `${who} (Pedro Ramirez) chooses where to draw from.`);
        return;
      }
      const top = view.discardTop;
      add('act-head', 'Pedro Ramirez: where does your first card come from?');
      add('act-sub', 'The top of the discard pile, or the deck. The second comes from the deck.');
      if (top) {
        const r = el('div', 'card-row');
        r.append(cardEl(top));
        box.append(r);
      }
      const r = row();
      if (top) r.append(btn(`Take the ${KINDS[top.kind].name}`, 'primary', () => send({ from: 'discard' })));
      r.append(btn('The deck', 'ghost', () => send({ from: 'deck' })));
      return;
    }

    case 'kit': {
      if (!mine) {
        add('act-head', `${who} (Kit Carlson) looks at the top three cards of the deck.`);
        return;
      }
      add('act-head', 'Kit Carlson: keep two, put one back.');
      add('act-sub', 'Tap the card to put back on top of the deck.');
      const r = el('div', 'card-row');
      for (const c of view.look || []) {
        const n = cardEl(c, 'can', 'button');
        n.addEventListener('click', () => send({ keep: view.look.filter((x) => x.id !== c.id).map((x) => x.id) }));
        r.append(n);
      }
      box.append(r);
      return;
    }
  }
}

// a Beer saves you from the last life point, unless only two are left
function lastBreath(view, add) {
  const my = me(view);
  if (!my || my.life > 1) return;
  const beer = view.hand.some((c) => c.kind === 'beer');
  const many = view.players.filter((p) => p.alive).length > 2;
  if (beer && many) add('act-note', 'If this is your last life point, you drink a Beer from your hand and stay in.');
  else if (beer) add('act-note', 'With two players left, a Beer cannot save you.');
}

// ---------------------------------------------------------------- your hand

function renderHand(view) {
  const wrap = $('#hand');
  wrap.replaceChildren();
  const my = me(view);
  if (!my || (!view.hand.length && !my.alive)) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');
  const head = el('div', 'hand-head');
  head.append(el('span', 'side-title', `${isObserver(view) ? `${my.name}’s hand` : 'Your hand'} · ${view.hand.length}`));
  if (my.role && !isObserver(view)) head.append(roleBadge(view, my));
  if (canAct(view) && view.ask.kind === 'turn' && sel == null && !mode) head.append(el('span', 'hand-hint', 'tap a card to play it'));
  wrap.append(head);
  const row = el('div', 'card-row hand-row');
  const a = view.ask;
  const act = canAct(view);
  const ans = act ? answers(view) : [];
  // what a tap on a card in hand does right now
  const picking = act && (mode === 'sid' || a.kind === 'discard' || a.kind === 'dying');
  const limit = mode === 'sid' || a?.kind === 'dying' ? 2 : a?.kind === 'discard' ? a.n : 0;
  for (const c of view.hand) {
    let cls = '';
    let onTap = null;
    let why = null;
    if (picking) {
      cls = picks.includes(c.id) ? 'picked' : 'can';
      onTap = () => {
        if (picks.includes(c.id)) picks = picks.filter((x) => x !== c.id);
        else picks = [...picks, c.id].slice(-limit);
        rerender();
      };
    } else if (act && a.kind === 'turn') {
      const info = (view.playable && view.playable[c.id]) || {};
      why = info.why || null;
      cls = `${why ? 'cannot' : 'can'}${sel === c.id ? ' selected' : ''}`;
      onTap = () => {
        sel = sel === c.id ? null : c.id;
        selTarget = null;
        rerender();
      };
    } else if (act && (a.kind === 'shot' || a.kind === 'indians' || a.kind === 'duel')) {
      const ok = ans.some((x) => x.id === c.id);
      cls = ok ? 'can answer' : 'cannot';
      if (ok && (a.kind !== 'shot' || a.need === 1)) onTap = () => send(a.kind === 'shot' ? { kind: 'cards', cards: [c.id] } : { kind: 'card', card: c.id });
    }
    const n = cardEl(c, cls, onTap ? 'button' : 'div');
    if (why) n.dataset.why = why;
    if (onTap) n.addEventListener('click', onTap);
    row.append(n);
  }
  if (!view.hand.length) row.append(el('p', 'dim hand-empty', 'No cards in hand.'));
  wrap.append(row);
}

// ---------------------------------------------------------------- your role

function showRole(view) {
  const my = me(view);
  if (!my || !my.role || isObserver(view)) return;
  const body = $('#role-body');
  body.replaceChildren();
  const r = my.role;
  const card = el('div', `role-card r-${r}`);
  card.append(el('div', 'rc-pre', 'Your role'));
  card.append(el('div', 'rc-name', `${r === 'sheriff' ? '★ ' : ''}${ROLE_WORD[r]}`));
  card.append(el('p', 'rc-goal', ROLES[r].goal));
  body.append(card);
  const ch = CHARACTERS[my.char];
  const cc = el('div', 'char-card');
  const top = el('div', 'cc-top');
  top.append(el('span', 'cc-name', ch.name), lifeEl(my));
  cc.append(el('div', 'rc-pre', 'Your character'), top, el('p', 'cc-text', ch.text));
  body.append(cc);
  const facts = [];
  const sheriff = view.players.find((p) => p.role === 'sheriff');
  if (r === 'sheriff') facts.push('Your star is face up: everyone knows who you are. You begin, and you have one extra life point.');
  else if (sheriff) facts.push(`The Sheriff is ${sheriff.name}, playing ${CHARACTERS[sheriff.char].name}.`);
  facts.push(`At this table: ${rolesLine(countRoles(ROLES_FOR[view.n]))}.`);
  if (r === 'outlaw') facts.push('Whoever eliminates an Outlaw — anyone at all — draws three cards from the deck.');
  if (r === 'deputy') facts.push('If the Sheriff eliminates a Deputy, the Sheriff discards every card in hand and in play.');
  if (r === 'renegade') facts.push('If the Sheriff falls while anyone else is still standing, the Outlaws win — not you.');
  const ul = el('ul', 'rc-facts');
  for (const f of facts) ul.append(el('li', '', f));
  body.append(ul);
  $('#role-secret').textContent = r === 'sheriff' ? '' : 'Keep it to yourself: a role is turned face up only when its player is eliminated.';
  $('#modal-role').classList.remove('hidden');
}

// ---------------------------------------------------------------- what just happened

// Words over a seat — BANG!, Missed!, −1 — for a moment after it happens.
function stamp(seat, text, cls) {
  const host = document.querySelector(`.seat[data-seat="${seat}"]`);
  if (!host || !host.offsetParent) return;
  let layer = $('#fx-layer');
  if (!layer) {
    layer = el('div', '');
    layer.id = 'fx-layer';
    document.body.append(layer);
  }
  const r = host.getBoundingClientRect();
  const n = el('div', `stamp ${cls}`, text);
  const ms = cfg('stampMs');
  n.style.left = `${Math.round(r.left + r.width / 2)}px`;
  n.style.top = `${Math.round(r.top + r.height / 2)}px`;
  n.style.animationDuration = `${ms}ms`;
  layer.append(n);
  setTimeout(() => n.remove(), ms + 60);
  if (cls === 'hit') {
    host.classList.remove('shake');
    void host.offsetWidth;
    host.classList.add('shake');
  }
}

function showFx(view, f) {
  const name = seatName(view, f.seat);
  switch (f.kind) {
    case 'turn':
      if (f.seat === view.you && !isObserver(view) && view.phase !== 'over') flash('Your turn', 'plain');
      return;
    case 'play': {
      // Calamity Janet's Missed! fired as a BANG! is a BANG! to its target
      const shot = f.card.kind === 'bang' || (f.card.kind === 'missed' && f.target != null);
      const label = shot ? '💥 BANG!' : `${GLYPH[f.card.kind]} ${KINDS[f.card.kind].name}`;
      stamp(f.target != null ? f.target : f.seat, label, shot ? 'bang' : 'play');
      return;
    }
    case 'duel-shot':
      return stamp(f.seat, '💥 BANG!', 'bang');
    case 'missed':
      return stamp(f.seat, f.by === 'barrel' ? '🛢️ Barrel!' : '💨 Missed!', 'missed');
    case 'hit':
      return stamp(f.seat, `−${f.amount}`, 'hit');
    case 'heal':
      return stamp(f.seat, '+1', 'heal');
    case 'draw!': {
      const c = f.cards.find((x) => x.picked) || f.cards[0];
      return stamp(f.seat, `draw! ${corner(c)} ${f.ok ? '✓' : '✗'}`, f.ok ? 'missed' : 'play');
    }
    case 'boom':
      return flash(`The Dynamite explodes on ${name}!`, 'boom');
    case 'dead': {
      const by = f.by != null && f.by !== f.seat ? ` by ${f.by === view.you && !isObserver(view) ? 'you' : seatName(view, f.by)}` : '';
      return flash(`${name} is out${by} — ${ROLE_A[f.role]}`, f.role === 'outlaw' ? 'plain' : 'dead');
    }
    default:
  }
}

function playFx(view) {
  const list = view.fxs || [];
  const fresh = list.filter((f) => f.seq > lastFxSeq).slice(-10);
  if (!list.length) return;
  lastFxSeq = Math.max(lastFxSeq, list[list.length - 1].seq);
  fresh.forEach((f, i) => setTimeout(() => showFx(view, f), i * 240));
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
  const ids = new Set(view.hand.map((c) => c.id));
  if (sel != null && !ids.has(sel)) {
    sel = null;
    selTarget = null;
  }
  picks = picks.filter((id) => ids.has(id));
  if (!canAct(view)) clearSel();

  $('#room-chip').textContent = view.code || '·····';
  const tc = $('#turn-chip');
  const turnP = view.players.find((p) => p.seat === view.turn);
  tc.textContent = view.phase === 'over' ? 'Game over' : view.turn === view.you && !isObserver(view) ? 'Your turn' : `${turnP ? turnP.name : '?'}’s turn`;
  tc.classList.toggle('mine', view.turn === view.you && !isObserver(view) && view.phase !== 'over');
  const ac = $('#alive-chip');
  const live = view.players.filter((p) => p.alive);
  const left = countRoles(ROLES_FOR[view.n]);
  for (const p of view.players) if (!p.alive && p.role) left[p.role]--;
  ac.textContent = `${live.length} of ${view.n} in play`;
  ac.dataset.tip = view.phase === 'over' ? `Dealt: ${rolesLine(countRoles(ROLES_FOR[view.n]))}.` : `Still in play: ${rolesLine(left)}.`;
  $('#btn-role').classList.toggle('hidden', !me(view) || isObserver(view));

  renderBoard(view);
  renderAction(view);
  renderHand(view);
  renderLog(view);
  paintChatBubbles();
  retip();
  playFx(view);
  revealPrompt(view);

  // everyone sees their role once, as a game starts
  if (roleShownFor !== view.mid && me(view) && me(view).role && view.phase !== 'over' && !isObserver(view)) {
    roleShownFor = view.mid;
    showRole(view);
  }
  settleOverlay('#gameover', view.phase === 'over', () => showGameover(view, sess));
}

// On a phone the prompt and your hand are below the seats. When the table
// starts waiting on you — your turn, a BANG! at you, the General Store — the
// prompt is brought into view, once, if it is off the screen.
function revealPrompt(view) {
  const mine = canAct(view);
  if (mine && !wasMine) {
    const box = $('#action');
    const r = box.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) {
      // a hidden tab never runs a smooth scroll, so it jumps there instead
      const still = document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      box.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' });
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
  $('#go-title').textContent = `${WIN_WORD[view.winner]}${me(view) && !watching ? (won ? ' — so do you!' : ' — you lose') : ''}`;
  $('#go-title').className = `win-${view.winner}`;
  $('#go-sub').textContent = view.why ? `${view.why.charAt(0).toUpperCase()}${view.why.slice(1)}.` : '';
  const list = $('#go-rank');
  list.replaceChildren();
  const order = view.players.slice().sort((a, b) => (winners.includes(a.seat) ? 0 : 1) - (winners.includes(b.seat) ? 0 : 1));
  for (const p of order) {
    const row = el('li', `rank-row r-${p.role}${p.seat === view.you ? ' me' : ''}${winners.includes(p.seat) ? ' won' : ''}`);
    row.append(avatarEl(p.name, p.seat, p.bot));
    const nm = el('span', 'rank-name');
    nm.append(el('b', '', p.name + (p.connected || p.bot ? '' : ' (left)')), el('small', '', `${CHARACTERS[p.char].name}${p.alive ? '' : ' · eliminated'}`));
    row.append(nm);
    row.append(el('span', `role-tag r-${p.role}`, `${p.role === 'sheriff' ? '★ ' : ''}${ROLE_WORD[p.role]}`));
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
// played now; a character its life points and ability.
function tipBody(a) {
  const kind = a.dataset.kind;
  if (kind && KINDS[kind]) {
    const k = KINDS[kind];
    const box = el('div', 'tb-card');
    const head = el('div', `tb-card-head ${k.color}`);
    head.append(el('span', 'tb-card-glyph', GLYPH[kind]), el('b', 'tb-card-name', k.name));
    head.append(el('span', 'tb-card-str', `${k.color === 'blue' ? 'blue · stays in play' : 'brown · discarded'}${a.dataset.face ? ` · ${a.dataset.face}` : ''}`));
    box.append(head, el('div', '', k.text));
    if (a.dataset.why) box.append(el('div', 'tb-card-why', a.dataset.why));
    return box;
  }
  const ch = a.dataset.char;
  if (ch && CHARACTERS[ch]) {
    const c = CHARACTERS[ch];
    const box = el('div', 'tb-card');
    const head = el('div', 'tb-card-head');
    head.append(el('b', 'tb-card-name', c.name), el('span', 'tb-card-str', `${c.life} life points`));
    box.append(head, el('div', '', c.text));
    return box;
  }
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
  localStorage.setItem('bng-name', name);
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
  localStorage.setItem('bng-name', name);
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
  $('#name-input').value = localStorage.getItem('bng-name') || '';
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

  $('#btn-role').addEventListener('click', () => lastView && showRole(lastView));
  $('#btn-role-close').addEventListener('click', () => $('#modal-role').classList.add('hidden'));
  $('#modal-role').addEventListener('click', (e) => {
    if (e.target === $('#modal-role')) $('#modal-role').classList.add('hidden');
  });
  // the table is laid out for the space it has: round on a wide screen, a list on a phone
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
