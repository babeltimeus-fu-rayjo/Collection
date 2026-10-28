// app.js — networking + UI for So Clover!.
//
// Topology: host-authoritative star over WebRTC data channels.
//   - The host's browser owns the game and validates every move.
//   - Guests connect straight to the host (peer-to-peer); no game server.
//   - NAT traversal uses Google's public STUN servers (see RTC_CONFIG).
//   - Peer discovery/signaling uses the free PeerJS cloud broker, because
//     GitHub Pages can only serve static files.
// Every player gets their own view: while the Clues are written, their own
// clover; while a clover is put back, its Clues and the cards on the table —
// and its true placement only for its Spectator. There are no bots: a word
// game needs people to find the words.

import {
  PROTO,
  MIN_PLAYERS,
  MAX_PLAYERS,
  EXTRA_MAX,
  PERFECT,
  LEAF_NAME,
  LEAF_SPOTS,
  wordAt,
  clueProblem,
  clueWarning,
  defaultOpts,
  checkOpts,
  canStart,
  newGame,
  applyMove,
  viewFor,
  setAside,
  silenced,
  markDisconnected,
  markReconnected,
  markSeatClaimed,
  markSeatResigned,
} from './game.js';
import { initSettings } from '../common/settings.js';
import '../common/feedtoggle.js';
import '../common/version.js';

// The ⚙ drawer (bottom-left): live-tunable pacing for testing. Defaults
// reproduce the shipped behavior exactly; overrides stay in this browser.
const cfg = initSettings('scl', [
  { key: 'clueSend', label: 'Send a Clue being written after', def: 450, section: 'Table', hint: 'How long typing pauses before the host keeps a Clue you are writing — so a dropped connection does not lose it.' },
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
const ID_PREFIX = 'scl-v1-';
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

function avatarEl(name, seat) {
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
  if (!$('#chat-input').disabled) $('#chat-input').focus();
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

// Chat floats briefly over the sender's row; kept in a map so the bubbles
// survive re-renders.
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
    const host = document.querySelector(`.person[data-seat="${seat}"]`) || document.querySelector(`.seat-row[data-seat="${seat}"]`);
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
  if (m.seat == null || m.seat < 0) return;
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

// The Spectator "cannot communicate in any way" — so while their clover is
// being put back, their chat box is closed, and the host refuses what they
// send anyway.
const HUSH = 'You are the Spectator — not a word until your clover is checked.';
function paintChatInput(view) {
  const inp = $('#chat-input');
  const hushed = !!(view && !view.observer && view.phase === 'resolve' && view.silenced === view.you);
  inp.disabled = hushed;
  inp.placeholder = hushed ? 'Not a word — you are the Spectator' : 'Think out loud…';
  if (hushed) inp.value = '';
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
    this.opts = defaultOpts();
    this.chatLog = [];
    this.watchers = []; // observers: {id, name, conn}
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
      if (markDisconnected(this.G, seat)) toast(`${p.name} disconnected`);
      this.broadcast();
    }
  }

  // An observer takes a seat: in the lobby any open chair; mid-game the seat
  // of a player who is gone. Watchers only ever see what the whole table
  // sees, so anyone watching may take any empty seat.
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
    if (!p) return err('That seat cannot be taken.');
    if (p.connected) return err('That seat is taken.');
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

  // A seated guest hands back their seat and becomes an observer.
  resignSeat(conn) {
    const seat = conn._seat;
    if (seat == null || seat === 0) return; // the host cannot give up the room
    const p = this.roster.find((r) => r.seat === seat);
    if (!p) return;
    conn._seat = null;
    this.conns.delete(seat);
    const id = ++this.wid;
    conn._watcher = id;
    this.watchers.push({ id, name: p.name, conn });
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

  // Overflow and mid-game joiners become observers: they see the table as
  // everyone at it does, and nothing anyone keeps to themselves.
  attachWatcher(conn, msg) {
    const name = cleanName(msg.name) || 'Watcher';
    const id = ++this.wid;
    conn._watcher = id;
    conn._seen = Date.now();
    this.watchers.push({ id, name, conn });
    try {
      conn.send({ t: 'welcome', observer: true, code: this.code });
      if (this.chatLog.length) conn.send({ t: 'chatlog', items: this.chatLog.slice(-20) });
    } catch {}
    toast(`${name} is watching`);
    if (this.G) this.broadcast();
    else this.pushLobby();
  }

  sendWatcher(w) {
    try {
      w.conn.send({
        t: 'state',
        view: { ...viewFor(this.G, -1, this.code, { observer: true }), observer: { name: w.name }, watchers: this.watchers.map((x) => x.name) },
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
    if (this.G && seat >= 0 && silenced(this.G) === seat) {
      if (seat === 0) toast(HUSH);
      else {
        try {
          this.conns.get(seat)?.send({ t: 'err', error: HUSH });
        } catch {}
      }
      return;
    }
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

  // The lobby's one choice: how many cards each player adds before the
  // Resolution — one, or more to add a challenge.
  setOpt(key, value) {
    if (this.G || !(key in defaultOpts())) return;
    this.opts = checkOpts({ ...this.opts, [key]: value });
    this.pushLobby();
  }

  lobbyMsg() {
    return {
      t: 'lobby',
      code: this.code,
      watchers: this.watchers.map((x) => x.name),
      players: this.roster.map((p) => ({ seat: p.seat, name: p.name })),
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
    if (why) {
      toast(why);
      return;
    }
    this.G = newGame(this.roster, this.opts);
    this.broadcast();
  }

  again() {
    if (!this.G || this.G.phase !== 'over') return;
    this.roster = this.roster.filter((p) => p.connected);
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
    this.roster = this.roster.filter((p) => p.connected);
    hideOverlays();
    this.pushLobby();
    showScreen('lobby');
  }

  // the host sets aside the clover of a player who is gone while the Clues
  // are written, so the table can go on
  setAside(seat) {
    if (this.G && setAside(this.G, seat)) this.broadcast();
  }

  broadcast() {
    pendingMove = false;
    showScreen('game');
    this.pushViews();
  }

  pushViews() {
    if (!this.G) return;
    const wnames = this.watchers.map((x) => x.name);
    for (const [seat, conn] of this.conns) {
      try {
        conn.send({ t: 'state', view: { ...viewFor(this.G, seat, this.code), watchers: wnames } });
      } catch {}
    }
    for (const w of this.watchers) this.sendWatcher(w);
    renderGame({ ...viewFor(this.G, 0, this.code), watchers: wnames }, this);
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
            full: `That room is full (${MAX_PLAYERS} players max).`,
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

const REJOIN_KEY = 'scl-rejoin';

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

// ---------------------------------------------------------------- the Record of Legends
// At the end the team's points go into the Record of Legends, a sheet whose
// columns are the date, the cards added, the player count and first names,
// and the score. Kept here in this browser.

const LEGENDS_KEY = 'scl-legends';

function loadLegends() {
  try {
    const a = JSON.parse(localStorage.getItem(LEGENDS_KEY) || '[]');
    return Array.isArray(a) ? a.filter((x) => x && typeof x.score === 'number') : [];
  } catch {
    return [];
  }
}

function recordLegend(view) {
  const all = loadLegends();
  if (all.some((x) => x.mid === view.mid)) return all;
  all.push({
    mid: view.mid,
    date: new Date().toISOString().slice(0, 10),
    added: view.opts.extra,
    n: view.players.length,
    names: view.players.map((p) => p.name),
    score: view.score,
    max: view.max,
  });
  while (all.length > 60) all.shift();
  try {
    localStorage.setItem(LEGENDS_KEY, JSON.stringify(all));
  } catch {}
  return all;
}

// the high score to beat, at a table of this size with this many cards added
function bestLegend(n, added, except = null) {
  const mine = loadLegends().filter((x) => x.n === n && x.added === added && x.mid !== except);
  return mine.length ? mine.reduce((a, b) => (b.score > a.score ? b : a)) : null;
}

const plural = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

// ---------------------------------------------------------------- lobby

const OPT_TIP = 'Add a challenge: “increasing the number of Keyword cards you add before the Resolution phase.” One is the game as it comes; every card more is one more to rule out on each clover. The same number for everyone.';

function renderLobby(lob, sess) {
  logLines = [];
  logMid = null;
  $('#feed').replaceChildren();
  clearChatBubbles();
  chatSetVisible(true);
  paintChatInput(null);
  $('#lobby-code').textContent = lob.code;
  renderLobbyWatch(lob, sess);
  ensureResignBtn(sess);
  const list = $('#lobby-players');
  list.replaceChildren();
  const mySeat = sess.isHost ? 0 : sess.seat;
  const n = lob.players.length;
  // the seats so far, and empty ones up to the three a game needs (or one more)
  const rows = Math.min(lob.max, Math.max(MIN_PLAYERS, n + 1));
  for (let i = 0; i < rows; i++) {
    const p = lob.players[i];
    const row = el('li', `seat-row${p ? '' : ' empty'}`);
    if (p) {
      row.dataset.seat = String(p.seat);
      row.style.position = 'relative';
      row.append(avatarEl(p.name, p.seat));
      row.append(el('span', 'seat-name', p.name));
      if (p.seat === 0) row.append(el('span', 'chip', 'host'));
      if (p.seat === mySeat) row.append(el('span', 'chip you', 'you'));
    } else {
      row.append(el('div', 'av empty', '·'), el('span', 'seat-name dim', i < MIN_PLAYERS ? 'Empty seat — a game needs three' : 'Empty seat'));
    }
    list.append(row);
  }

  const host = sess.isHost;
  const opts = lob.opts || defaultOpts();
  const op = $('#option-picker');
  op.replaceChildren();
  const g = el('div', 'opt-group');
  const h = el('div', 'opt-title', 'Cards added to each clover');
  h.dataset.tip = OPT_TIP;
  const row = el('div', 'pick-row');
  for (let k = 1; k <= EXTRA_MAX; k++) {
    const b = el('button', `role-pick${opts.extra === k ? ' on' : ''}`, k === 1 ? '1 — the game as it comes' : `${k} — a challenge`);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(opts.extra === k));
    b.disabled = !host;
    if (host) b.addEventListener('click', () => sess.setOpt('extra', k));
    row.append(b);
  }
  g.append(h, row);
  op.append(g);

  const sum = $('#cast-summary');
  sum.replaceChildren();
  const tn = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, n));
  sum.append(el('div', 'cast-head', n >= MIN_PLAYERS ? `At this table of ${tn}:` : `At a table of ${tn}:`));
  sum.append(el('div', 'cast-line', `Four Keyword cards on every clover; ${plural(opts.extra, 'more card')} shuffled in before it is put back — ${4 + opts.extra} to choose from.`));
  sum.append(el('div', 'cast-line dim', `${tn} clovers to put back, 6 points for a perfect one: ${PERFECT * tn} at most.`));
  const best = bestLegend(tn, opts.extra);
  if (best) sum.append(el('div', 'cast-best', `Your Record of Legends at ${tn} players with ${plural(opts.extra, 'card')} added: ${best.score} — beat it!`));

  $('#btn-start').classList.toggle('hidden', !host);
  const why = canStart(n);
  if (host) $('#btn-start').disabled = !!why;
  $('#lobby-hint').textContent = host ? why || `${n} players. Ready when you are.` : 'Waiting for the host to start…';
  paintChatBubbles();
}

// ---------------------------------------------------------------- UI state

let viewMid = null;
let sel = null;           // the card in your hand, while putting a clover back
let selKey = null;        // the attempt that card was picked up in
const lastRot = new Map(); // how each card lay at the last render, to show a turn
let drafts = null;        // your Clues as they stand in the boxes
let writer = null;        // the Clue panel, kept while you type in it
const sendTimers = [null, null, null, null];

const seatName = (view, seat) => (view.players.find((p) => p.seat === seat) || { name: '?' }).name;
const isObserver = (view) => !!view.observer;
const possessive = (view, seat) => (seat === view.you && !isObserver(view) ? 'Your' : `${seatName(view, seat)}’s`);

function btn(label, cls, fn, disabled = false) {
  const b = el('button', `btn ${cls}`, label);
  b.type = 'button';
  b.disabled = disabled;
  if (fn) b.addEventListener('click', fn);
  return b;
}

// ---------------------------------------------------------------- a Keyword card

// The words go round the card clockwise from the top; the card is drawn as it
// lies, rot quarter turns from square. `out`, for a card in a spot, are the
// two edges facing the leaves — the only Keywords that count there.
function cardEl(card, rot, { out = null, cls = '', still = false } = {}) {
  const n = el('div', `kcard${cls ? ` ${cls}` : ''}${out ? ' placed' : ''}`);
  n.dataset.card = card.id;
  for (let e = 0; e < 4; e++) {
    const w = wordAt(card, rot, e);
    const k = el('span', `kw e${e}${w.length > 8 ? ' long' : ''}${out ? (out.includes(e) ? ' out' : ' in') : ''}`, w);
    n.append(k);
  }
  // a quarter turn since the last time this card was drawn: show it turning.
  // Where a card really goes is drawn still, and does not count as a draw.
  if (still) return n;
  const was = lastRot.get(card.id);
  if (was != null && was !== rot) n.classList.add((rot - was + 4) % 4 === 1 ? 'turn-cw' : 'turn-ccw');
  lastRot.set(card.id, rot);
  return n;
}

// the two edges of a spot that face out onto the leaves
const outOf = (spot) => [spot, (spot + 3) % 4];

// ---------------------------------------------------------------- the clover

// The board: four leaves round four spots. `spots` holds what lies in each,
// {card, rot, cls, marks} or null; `leaf(l)` fills leaf l.
function cloverEl({ spots, leaf, onSpot = null, target = null, mark = null, still = false }) {
  const c = el('div', 'clover');
  for (let l = 0; l < 4; l++) {
    const lf = el('div', `leaf l${l}`);
    lf.dataset.leaf = String(l);
    leaf(l, lf);
    c.append(lf);
  }
  for (let s = 0; s < 4; s++) {
    const it = spots[s];
    const sp = el('div', `spot s${s}${it ? '' : ' empty'}${target && target(s) ? ' target' : ''}`);
    sp.dataset.spot = String(s);
    if (it) sp.append(cardEl(it.card, it.rot, { out: outOf(s), cls: it.cls || '', still }));
    else sp.append(el('span', '', `${s + 1}`));
    if (mark && mark(s) != null) sp.append(el('span', `mark ${mark(s) ? 'yes' : 'no'}`, mark(s) ? '✓' : '✗'));
    if (onSpot) sp.addEventListener('click', (e) => onSpot(s, e));
    c.append(sp);
  }
  return c;
}

function clueText(text, lf) {
  lf.append(el('span', `clue${text ? '' : ' empty'}`, text || 'Clue'));
}

// ---------------------------------------------------------------- 1. Choosing Clues

// Your own clover, with a box for each leaf's Clue under it. The panel is
// built once and kept while you type: the host answers every Clue with a new
// view, and rebuilding the boxes would take the letters out from under you.
function renderClues(view) {
  const mine = view.mine;
  const board = $('#board');
  const ctl = $('#controls');
  $('#tray').replaceChildren();
  if (!mine || mine.aside) {
    writer = null;
    board.replaceChildren();
    const waiting = view.waiting.map((s) => seatName(view, s));
    ctl.replaceChildren(el('div', 'ctl-note', mine && mine.aside
      ? 'Your clover was set aside while you were away — you will help put the others back.'
      : `The players are writing their Clues${waiting.length ? ` — waiting for ${waiting.join(', ')}` : ''}.`));
    return;
  }
  const cards = new Map(mine.cards.map((c) => [c.id, c]));
  const placed = mine.spots.map((s) => ({ card: cards.get(s.id), rot: s.rot }));
  const pairs = [0, 1, 2, 3].map((l) => LEAF_SPOTS[l].map((s) => wordAt(placed[s].card, placed[s].rot, l)));
  const keywords = pairs.flat();
  if (!drafts) drafts = mine.clues.slice();
  const key = `${view.mid}|${mine.done}|${mine.spots.map((s) => `${s.id}${s.rot}`).join()}`;
  if (!writer || writer.key !== key || !document.contains(writer.board)) {
    if (mine.done) drafts = mine.clues.slice();
    writer = { key, inputs: [], notes: [], rows: [], leaves: [] };
    const cl = cloverEl({
      spots: placed,
      leaf: (l, lf) => {
        lf.classList.add('writing');
        writer.leaves[l] = lf;
        lf.addEventListener('click', () => writer && writer.inputs[l] && !writer.inputs[l].disabled && writer.inputs[l].focus());
      },
    });
    writer.board = cl;
    board.replaceChildren(cl);
    const rows = el('div', 'clue-rows');
    for (let l = 0; l < 4; l++) {
      const row = el('label', 'clue-row');
      const pair = el('span', 'cr-pair');
      pair.append(document.createTextNode(pairs[l][0]), el('span', 'amp', '&'), document.createTextNode(pairs[l][1]));
      const inp = el('input');
      inp.maxLength = 32;
      inp.autocomplete = 'off';
      inp.spellcheck = false;
      inp.placeholder = 'One word that ties them';
      inp.value = drafts[l] || '';
      inp.disabled = mine.done;
      inp.setAttribute('aria-label', `Clue for the ${LEAF_NAME[l]} leaf: ${pairs[l][0]} and ${pairs[l][1]}`);
      inp.addEventListener('input', () => {
        drafts[l] = inp.value;
        if (lastView && lastView.mine) paintWriter(lastView, keywords);
        clearTimeout(sendTimers[l]);
        sendTimers[l] = setTimeout(() => sendClue(l), cfg('clueSend'));
      });
      inp.addEventListener('change', () => sendClue(l));
      inp.addEventListener('focus', () => { row.classList.add('focus'); writer.leaves[l].classList.add('focus'); });
      inp.addEventListener('blur', () => { row.classList.remove('focus'); writer.leaves[l].classList.remove('focus'); });
      inp.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const nxt = writer.inputs[l + 1];
        if (nxt) nxt.focus();
        else if (!writer.doneBtn.disabled) writer.doneBtn.click();
      });
      const note = el('div', 'cr-note');
      row.append(el('span', 'cr-leaf', `${LEAF_NAME[l]} leaf`), pair, inp, note);
      writer.inputs[l] = inp;
      writer.notes[l] = note;
      writer.rows[l] = row;
      rows.append(row);
    }
    const bar = el('div', 'ctl-row');
    writer.doneBtn = btn(mine.done ? '✎ Edit my Clues' : 'Done — these are my four Clues', mine.done ? 'secondary' : 'primary', () => {
      if (mine.done) sendMove({ kind: 'done', on: false });
      else {
        for (let k = 0; k < 4; k++) clearTimeout(sendTimers[k]);
        sendMove({ kind: 'done', clues: drafts.map((d) => d || '') });
      }
    });
    bar.append(writer.doneBtn);
    writer.wait = el('div', 'ctl-note');
    ctl.replaceChildren(rows, bar, writer.wait);
  }
  paintWriter(view, keywords);
}

// what changes as you type: the leaves, the notes under the boxes, Done
function paintWriter(view, keywords) {
  const mine = view.mine;
  let allGood = true;
  for (let l = 0; l < 4; l++) {
    const text = (drafts[l] || '').trim();
    const bad = text ? clueProblem(text, keywords) : null;
    const warn = !bad && text ? clueWarning(text, keywords) : null;
    if (clueProblem(text, keywords)) allGood = false;
    const note = writer.notes[l];
    note.textContent = bad || warn || '';
    note.className = `cr-note${bad ? ' bad' : warn ? ' warn' : ''}`;
    const lf = writer.leaves[l];
    lf.replaceChildren();
    lf.classList.toggle('bad', !!bad);
    clueText(text, lf);
  }
  if (!mine.done) writer.doneBtn.disabled = !allGood;
  const others = view.waiting.filter((s) => s !== view.you).map((s) => seatName(view, s));
  writer.wait.textContent = mine.done
    ? (others.length ? `Your Clues are in. Waiting for ${others.join(', ')}…` : 'Your Clues are in.')
    : 'Write the first word that pops into your head — the others might surprise you.';
}

function sendClue(l) {
  clearTimeout(sendTimers[l]);
  if (!session || session.observer || !lastView || lastView.phase !== 'clues' || !lastView.mine || lastView.mine.done) return;
  if ((lastView.mine.clues[l] || '') === (drafts[l] || '').replace(/\s+/g, ' ').trim()) return;
  session.localMove({ kind: 'clue', leaf: l, text: drafts[l] || '' });
}

// ---------------------------------------------------------------- 2. Resolution

const canTouch = (view) => {
  const r = view.round;
  return !!r && !r.done && !isObserver(view) && view.you !== r.seat;
};

// Board moves go straight to the host, without waiting for each answer: a
// card turned twice should turn twice.
function boardMove(move) {
  if (!session || (session.observer)) return;
  session.localMove(move);
}

function renderRound(view) {
  writer = null;
  const r = view.round;
  const touch = canTouch(view);
  const key = `${view.mid}|${r.seat}|${r.attempt}|${r.done}`;
  if (key !== selKey) {
    selKey = key;
    sel = null;
  }
  const onTable = (id) => r.tray.some((t) => t.id === id) || r.board.some((b) => b && b.id === id && !b.fixed);
  if (sel && !onTable(sel)) sel = null;

  // the clover: what lies on it now — or, once it is checked, where the cards
  // really went, each spot marked right or wrong
  const solution = r.done ? r.solution : null;
  const spots = (solution || r.board).map((b, s) => {
    if (!b) return null;
    let cls = touch && !b.fixed ? 'can' : '';
    if (b.fixed) cls += ' fixed';
    if (b.id === sel) cls += ' sel';
    return { card: b, rot: b.rot, cls };
  });
  const cl = cloverEl({
    spots,
    still: !!solution,
    leaf: (l, lf) => clueText(r.clues[l], lf),
    target: (s) => touch && !!sel && !(r.board[s] && r.board[s].fixed) && !(r.board[s] && r.board[s].id === sel),
    mark: (s) => (r.done ? r.right[s] : r.board[s] && r.board[s].fixed ? true : null),
    onSpot: touch ? (s, e) => {
      const here = r.board[s];
      if (e.target.closest('.turn-btn')) return;
      if (sel && !(here && here.id === sel)) {
        if (here && here.fixed) return;
        boardMove({ kind: 'place', card: sel, spot: s });
        return;
      }
      if (here && !here.fixed) sel = sel === here.id ? null : here.id;
      renderGame(lastView, session);
    } : null,
  });
  if (touch && sel) addTurnButtons(cl, sel);
  $('#board').replaceChildren(cl);

  // the middle of the table
  const tray = $('#tray');
  const head = el('div', 'tray-head', r.done
    ? (r.extra && r.extra.length ? (r.extra.length === 1 ? 'The card that was added' : 'The cards that were added') : '')
    : r.attempt === 2 ? 'In the middle of the table — the wrong cards are back' : 'In the middle of the table');
  const box = el('div', `tray-cards${touch && sel && r.board.some((b) => b && b.id === sel) ? ' target' : ''}`);
  const shown = r.done ? r.tray.filter((t) => r.extra && r.extra.includes(t.id)) : r.tray;
  for (const t of shown) {
    let cls = touch ? 'can' : '';
    if (t.id === sel) cls += ' sel';
    if (r.done) cls += ' extra-card';
    const c = cardEl(t, t.rot, { cls });
    if (touch) {
      c.addEventListener('click', (e) => {
        if (e.target.closest('.turn-btn')) return;
        e.stopPropagation();
        sel = sel === t.id ? null : t.id;
        renderGame(lastView, session);
      });
    }
    box.append(c);
  }
  if (!shown.length && !r.done) box.append(el('div', 'none', 'Every card is on the clover.'));
  if (touch) {
    box.addEventListener('click', () => {
      if (sel && r.board.some((b) => b && b.id === sel)) boardMove({ kind: 'lift', card: sel });
    });
    if (sel && r.tray.some((t) => t.id === sel)) addTurnButtons(box, sel);
  }
  tray.replaceChildren(...(head.textContent ? [head] : []), ...(shown.length || !r.done ? [box] : []));

  renderRoundControls(view);
}

// the two quarter-turn buttons, on the card in your hand
function addTurnButtons(root, id) {
  const card = root.querySelector(`.kcard[data-card="${CSS.escape(id)}"]`);
  if (!card) return;
  for (const [dir, cls, label, tip] of [[-1, 'ccw', '↺', 'A quarter turn back'], [1, 'cw', '↻', 'A quarter turn clockwise']]) {
    const b = el('button', `turn-btn ${cls}`, label);
    b.type = 'button';
    b.setAttribute('aria-label', tip);
    b.title = tip;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      boardMove({ kind: 'turn', card: id, dir });
    });
    card.append(b);
  }
}

function renderRoundControls(view) {
  const r = view.round;
  const ctl = $('#controls');
  const parts = [];
  const spect = seatName(view, r.seat);
  const guessers = view.players.filter((p) => p.seat !== r.seat);
  const chips = (on, label) => {
    const row = el('div', 'agree-chips');
    for (const p of guessers) {
      const yes = on.includes(p.seat);
      row.append(el('span', `agree-chip${yes ? ' on' : ''}${p.connected ? '' : ' off'}`, `${yes ? '✓' : '…'} ${p.name}${p.connected ? '' : ' (away)'}`));
    }
    if (label) row.prepend(el('span', 'ctl-note', label));
    return row;
  };
  if (r.done) {
    const v = el('div', `verdict${r.perfect ? ' perfect' : ''}`);
    v.append(r.perfect ? 'A perfect clover! ' : `${plural(r.right.filter(Boolean).length, 'card')} right after two attempts: `, el('span', 'pts', `+${r.points}`));
    parts.push(v);
    parts.push(el('div', 'ctl-note', 'This is where the cards really went.'));
    const ready = r.ready.includes(view.you);
    if (!isObserver(view)) {
      const row = el('div', 'ctl-row');
      row.append(btn(ready ? 'Waiting for the others…' : (view.turn + 1 < view.order.length ? 'Next clover' : 'See the score'), ready ? 'secondary' : 'primary', () => sendMove({ kind: 'next' }), ready));
      parts.push(row);
    }
    const wait = view.players.filter((p) => p.connected && !r.ready.includes(p.seat)).map((p) => p.name);
    if (wait.length) parts.push(el('div', 'ctl-note', `Waiting for ${wait.join(', ')}.`));
  } else if (isObserver(view) || view.you === r.seat) {
    if (view.you === r.seat && !isObserver(view)) {
      parts.push(el('div', 'ctl-note', '🤐 You are the Spectator: not a word, not a sign — your chat is off until your clover is checked.'));
    }
    parts.push(chips(r.agree, 'Agreed so far:'));
    if (view.you === r.seat && !isObserver(view) && r.solution) {
      const mini = cloverEl({
        spots: r.solution.map((s) => ({ card: s, rot: s.rot })),
        still: true,
        leaf: (l, lf) => clueText(r.clues[l], lf),
      });
      const wrap = el('div', 'mini');
      wrap.append(el('div', 'tray-head', 'Your clover — where the cards really go'), mini);
      parts.push(wrap);
    }
  } else {
    const full = r.board.every(Boolean);
    const agreed = r.agree.includes(view.you);
    const row = el('div', 'ctl-row');
    row.append(btn(agreed ? '✓ You agree' : 'Agree', `secondary agree${agreed ? ' on' : ''}`, () => boardMove({ kind: 'agree', on: !agreed }), !full));
    if (view.decider === view.you) row.append(btn('Lock it in', 'primary', () => sendMove({ kind: 'lock' }), !full));
    parts.push(row);
    parts.push(chips(r.agree, ''));
    parts.push(el('div', 'ctl-note', view.decider === view.you
      ? `You sit to ${spect}’s left: if the table disagrees, the final decision is yours.`
      : `${seatName(view, view.decider)} sits to ${spect}’s left and has the final say. The clover is checked once every guesser agrees.`));
    if (!sel) parts.push(el('div', 'ctl-note dim', 'Tap a card, then a spot. ↺ ↻ turn the card in your hand; tap the middle of the table to take it back off.'));
  }
  ctl.replaceChildren(...parts);
}

// ---------------------------------------------------------------- the table around it

function renderPrompt(view) {
  const p = $('#prompt');
  const head = el('div', 'pr-head');
  const sub = el('div', 'pr-sub');
  const r = view.round;
  if (view.phase === 'clues') {
    const mine = view.mine;
    head.textContent = 'Choosing Clues';
    sub.textContent = mine && !mine.aside
      ? (mine.done ? 'Your four Clues are in.' : 'Each leaf sits between two Keywords — its Pair. Write one word on each leaf that ties its two together.')
      : 'Everyone is writing one Clue for each Pair of Keywords on their clover.';
  } else if (r) {
    const own = view.you === r.seat && !isObserver(view);
    head.textContent = own ? 'Your clover' : `${possessive(view, r.seat)} clover`;
    if (r.done) sub.textContent = r.perfect ? 'All four right at the first attempt.' : `Checked after the second attempt: ${plural(r.points, 'point')}.`;
    else if (own) {
      sub.append(el('span', 'pr-hush', 'Not a word! '), document.createTextNode('The others are putting your cards back from your Clues.'));
    } else {
      sub.textContent = r.attempt === 1
        ? `Put four of the ${r.tray.length + r.board.filter(Boolean).length} cards back — each in its spot, and turned the right way. One is extra.`
        : 'Second and final attempt: the cards that stayed are right; the others came back to the middle.';
    }
  } else {
    head.textContent = 'Every clover is back together';
  }
  p.replaceChildren(head, sub);
}

function renderPeople(view) {
  const box = $('#people');
  const list = el('div', 'people');
  const r = view.round;
  for (const p of view.players) {
    const row = el('div', `person${p.seat === view.you && !isObserver(view) ? ' me' : ''}${r && r.seat === p.seat ? ' spect' : ''}${p.connected ? '' : ' gone'}`);
    row.dataset.seat = String(p.seat);
    row.append(avatarEl(p.name, p.seat), el('span', 'p-name', p.name + (p.seat === view.you && !isObserver(view) ? ' (you)' : '')));
    let state = '';
    let cls = '';
    if (!p.connected) state = p.resigned ? 'left the seat' : '⚠ away';
    else if (view.phase === 'clues') {
      if (p.aside) state = 'set aside';
      else if (p.done) { state = '✓ Clues in'; cls = 'go'; } else state = '✎ writing…';
    } else if (r) {
      if (r.seat === p.seat) { state = r.done ? 'Spectator' : '🤐 Spectator'; cls = 'hush'; } else if (r.done) {
        if (r.ready.includes(p.seat)) { state = '✓ ready'; cls = 'go'; }
      } else if (r.agree.includes(p.seat)) { state = '✓ agrees'; cls = 'go'; } else if (view.decider === p.seat) state = '⚖ final say';
    }
    const st = el('span', `p-state${cls ? ` ${cls}` : ''}`, state);
    if (view.decider === p.seat && r && !r.done) st.dataset.tip = 'Sits to the Spectator’s left: when the others disagree on where the cards go, the final decision is theirs.';
    if (r && r.seat === p.seat && !r.done) st.dataset.tip = '“The Spectator cannot communicate in any way during this phase.”';
    row.append(st);
    list.append(row);
  }
  box.replaceChildren(el('div', 'side-title', 'At the table'), list);
}

function renderSheet(view) {
  const box = $('#sheet');
  const sheet = el('div', 'sheet');
  if (view.phase === 'clues') {
    sheet.append(el('div', 'ctl-note', `${plural(view.max / PERFECT, 'clover')} to put back once every Clue is written — 6 points for a perfect one.`));
  } else {
    view.order.forEach((seat, i) => {
      const res = view.results.find((x) => x.seat === seat);
      const now = view.round && view.round.seat === seat && !view.round.done;
      const row = el('div', `sheet-row${now ? ' now' : ''}${!res && !now ? ' todo' : ''}`);
      row.append(el('span', 'sh-name', `${i + 1}. ${seatName(view, seat)}`));
      row.append(el('span', 'sh-pts', res ? (res.perfect ? '6 ★' : String(res.points)) : now ? '…' : '–'));
      sheet.append(row);
    });
    const tot = el('div', 'sheet-total');
    tot.append(el('span', '', `Score ${view.score}`), el('span', 'of', `of ${view.max}`));
    sheet.append(tot);
  }
  box.replaceChildren(el('div', 'side-title', 'The score'), sheet);
}

// ---------------------------------------------------------------- the game

function renderGame(view, sess) {
  lastView = view;
  renderDcBanner(view, sess);
  renderObBar(view, sess);
  renderWatchChip(view);
  ensureResignBtn(sess);
  if (viewMid !== view.mid) {
    viewMid = view.mid;
    sel = null;
    selKey = null;
    drafts = null;
    writer = null;
    lastRot.clear();
    lastFxSeq = view.fx ? view.fx.seq : 0;
  }
  if (view.phase !== 'clues') drafts = null;

  $('#room-chip').textContent = view.code || '·····';
  const pc = $('#phase-chip');
  pc.textContent = view.phase === 'clues' ? 'Choosing Clues'
    : view.phase === 'over' ? 'Game over'
      : `Clover ${view.turn + 1} of ${view.order.length}`;
  const sc = $('#score-chip');
  sc.textContent = `Score ${view.score}`;
  sc.dataset.tip = `6 points for a clover all right at the first attempt; otherwise 1 for each card right after the second. ${view.max} at most at this table.`;

  renderPrompt(view);
  if (view.phase === 'clues') renderClues(view);
  else if (view.round) renderRound(view);
  else {
    writer = null;
    $('#board').replaceChildren();
    $('#tray').replaceChildren();
    $('#controls').replaceChildren();
  }
  renderPeople(view);
  renderSheet(view);
  renderLog(view);
  paintChatInput(view);
  paintChatBubbles();
  retip();

  if (view.fx && view.fx.seq !== lastFxSeq) {
    lastFxSeq = view.fx.seq;
    const fx = view.fx;
    const mine = fx.seat === view.you && !isObserver(view);
    if (fx.kind === 'round') {
      flash(mine ? 'Your clover — not a word!' : `${seatName(view, fx.seat)}’s clover`, 'plain');
      // a new clover starts at the top of the page, where its Clues are
      const top = $('#stage').getBoundingClientRect().top;
      if (top < 0) window.scrollBy({ top: top - 8, behavior: 'smooth' });
    }
    else if (fx.kind === 'check') flash(`${plural(fx.right, 'card')} right — second and final attempt`, 'bad');
    else if (fx.kind === 'scored') {
      if (fx.perfect) {
        flash('A perfect clover! +6', 'good');
        confetti();
      } else flash(fx.points ? `+${plural(fx.points, 'point')}` : 'No points on this one', fx.points ? 'plain' : 'bad');
    }
  }
  settleOverlay('#gameover', view.phase === 'over', () => showGameover(view, sess));
}

// ---------------------------------------------------------------- game over

let confettiDone = false;

function showGameover(view, sess) {
  const m = $('#gameover');
  m.classList.remove('hidden');
  const n = view.players.length;
  $('#go-title').textContent = `${view.score} points`;
  $('#go-sub').textContent = `of a possible ${view.max} — ${plural(view.order.length, 'clover')}, ${plural(view.opts.extra, 'card')} added to each.`;
  const list = $('#go-clovers');
  list.replaceChildren();
  for (const res of view.results) {
    const row = el('li', 'go-row');
    const head = el('div', 'go-head');
    head.append(el('span', 'go-name', `${possessive(view, res.seat)} clover`), el('span', 'go-pts', res.perfect ? '6 — perfect' : `${res.points}`));
    row.append(head);
    const pairs = el('div', 'go-pairs');
    res.pairs.forEach((pair, l) => {
      pairs.append(el('span', 'go-clue', res.clues[l]), el('span', 'go-kw', `${pair[0]} & ${pair[1]}`));
    });
    row.append(pairs);
    list.append(row);
  }
  // the Record of Legends: this game, and the score to beat
  const lg = $('#go-legends');
  lg.replaceChildren();
  if (!isObserver(view)) {
    const before = bestLegend(n, view.opts.extra, view.mid);
    const all = recordLegend(view);
    lg.append(el('div', 'lg-head', 'Record of Legends — kept in this browser'));
    lg.append(el('div', 'lg-best', !before ? `Your first game at ${n} players with ${plural(view.opts.extra, 'card')} added — the score to beat.`
      : view.score > before.score ? `A new high score! The best before was ${before.score}.`
        : view.score === before.score ? `Level with your best: ${before.score}.`
          : `Your best at ${n} players with ${plural(view.opts.extra, 'card')} added is ${before.score}. Will you beat it?`));
    const table = el('table', 'lg-table');
    const hr = el('tr');
    for (const h of ['Date', 'Card(s) added', 'Player count and first names', 'Score']) hr.append(el('th', '', h));
    table.append(hr);
    for (const x of all.slice(-6).reverse()) {
      const tr = el('tr', x.mid === view.mid ? 'now' : '');
      tr.append(el('td', '', x.date), el('td', 'num', String(x.added)), el('td', '', `${x.n}: ${x.names.join(', ')}`), el('td', 'num', String(x.score)));
      table.append(tr);
    }
    lg.append(table);
  }
  $('#btn-again').classList.toggle('hidden', !sess.isHost);
  $('#btn-golobby').classList.toggle('hidden', !sess.isHost);
  $('#go-wait').classList.toggle('hidden', sess.isHost);
  if (!confettiDone && view.score >= view.max * 0.75) {
    confettiDone = true;
    confetti();
  }
}

// ---------------------------------------------------------------- tips

// What a mark or a number means. The browser's own title tooltip waits a
// second or more and never appears on a phone, so the game draws its own: a
// mouse gets one after a short pause, and a tap on anything that is not a move
// pins one until the next tap. Elements opt in with data-tip.
const TIP_DELAY = 110;
const TIP_SEL = '[data-tip]';
let tipEl = null;
let tipFor = null;
let tipKey = null;
let tipPinned = false;
let tipTimer = null;
let tipDropped = null;

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

function pinTip(a) {
  const key = a.dataset.tipKey || null;
  if (tipDropped && key && tipDropped.key === key && Date.now() - tipDropped.at < 600) {
    tipDropped = null;
    return;
  }
  showTip(a, true);
}

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
    tipTimer = setTimeout(() => showTip(a), tipFor ? 0 : TIP_DELAY);
  });
  document.addEventListener('pointerout', (e) => {
    if (e.pointerType !== 'mouse') return;
    const a = e.target.closest && e.target.closest(TIP_SEL);
    if (!a || (e.relatedTarget && a.contains(e.relatedTarget))) return;
    clearTimeout(tipTimer);
    if (!tipPinned && tipFor) tipTimer = setTimeout(hideTip, 60);
  });
  document.addEventListener('pointerdown', (e) => {
    if (!tipPinned) return;
    const a = e.target.closest && e.target.closest(TIP_SEL);
    tipDropped = a && a === tipFor && tipKey ? { key: tipKey, at: Date.now() } : null;
    hideTip();
  }, true);
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
  window.addEventListener('scroll', () => hideTip(), { passive: true });
  window.addEventListener('resize', () => hideTip());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideTip();
  });
}

// ---------------------------------------------------------------- watchers, seats, the absent

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
  const row = el('div', 'ob-row');
  row.append(el('span', 'ob-msg', '\u{1F441} You are watching — you see the table as everyone at it does. You can chat, but not play.'));
  for (const p of view.players) {
    if (p.connected || view.phase === 'over') continue;
    const claim = el('button', 'ob-btn claim', `\u{1FA91} Take ${p.name}'s seat`);
    claim.type = 'button';
    claim.onclick = () => sess.claim(p.seat);
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
    chip.append(el('span', '', '\u{1F441} You are watching — the game appears here when it starts.'));
    if ((lob.players || []).length < MAX_PLAYERS) {
      const b = el('button', '', '\u{1FA91} Take a seat');
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

// Who is gone, and what the table can do about it. While the Clues are being
// written the table waits for everyone — unless the host sets an absent
// player's clover aside. Afterwards nobody is waited for: the Spectator only
// watches, the guessers still there agree among themselves, and the final say
// passes along to the next player round who is there.
function renderDcBanner(view, sess) {
  let bar = $('#dc-banner');
  if (!bar) {
    bar = el('div', '');
    bar.id = 'dc-banner';
    const anchor = $('#table');
    anchor.parentNode.insertBefore(bar, anchor);
  }
  bar.replaceChildren();
  const gone = view.phase !== 'over' ? view.players.filter((p) => !p.connected) : [];
  bar.classList.toggle('on', gone.length > 0);
  for (const p of gone) {
    const stalls = view.phase === 'clues' && !p.done && !p.aside;
    const row = el('div', `dc-row${stalls ? '' : ' covered'}`);
    row.append(el('span', 'dc-msg', p.resigned
      ? `🪑 ${p.name} handed back their seat — a watcher can take it over.`
      : stalls ? `⚠️ ${p.name} lost connection before writing their Clues — the table is waiting for them.`
        : `⚠️ ${p.name} lost connection — the table plays on until they are back.`));
    if (stalls && sess && sess.isHost) {
      const b = el('button', 'dc-btn', '🍀 Set their clover aside');
      b.onclick = () => sess.setAside(p.seat);
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

// Overlays hold back a good while so the last clover stays visible.
const overlayTimers = new Map();
const overlayPending = new Map();

function settleOverlay(sel_, wanted, show) {
  const node = $(sel_);
  const pending = overlayTimers.get(sel_);
  if (!wanted) {
    if (pending) clearTimeout(pending);
    overlayTimers.delete(sel_);
    overlayPending.delete(sel_);
    node.classList.add('hidden');
    confettiDone = false;
    return;
  }
  overlayPending.set(sel_, show);
  if (!node.classList.contains('hidden')) {
    show();
    return;
  }
  if (pending) return;
  overlayTimers.set(
    sel_,
    setTimeout(() => {
      // the newest render's screen, not the one that started the wait
      const latest = overlayPending.get(sel_) || show;
      overlayTimers.delete(sel_);
      overlayPending.delete(sel_);
      latest();
    }, cfg('overlayDelay')),
  );
}

function flushOverlays() {
  for (const [sel_, show] of overlayPending) {
    const t = overlayTimers.get(sel_);
    if (t) clearTimeout(t);
    overlayTimers.delete(sel_);
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
    p.style.background = `hsl(${100 + Math.floor(Math.random() * 60)} 70% ${45 + Math.floor(Math.random() * 25)}%)`;
    box.append(p);
  }
  setTimeout(() => box.replaceChildren(), 4500);
}

// ---------------------------------------------------------------- actions

function sendMove(move) {
  if (session && session.observer) {
    toast('You are watching — only the seated players can play');
    return;
  }
  if (pendingMove || !session) return;
  pendingMove = true;
  session.localMove(move);
  if (lastView && !session.isHost) renderGame(lastView, session);
}

// The card in your hand answers to the keyboard too: R and E turn it, 1–4 put
// it in a spot, Backspace takes it off the clover, Escape puts it down.
function onKey(e) {
  if (!sel || !lastView || !canTouch(lastView)) return;
  if (e.target && e.target.closest && e.target.closest('input, textarea')) return;
  const r = lastView.round;
  if (e.key === 'r' || e.key === 'R' || e.key === ']') boardMove({ kind: 'turn', card: sel, dir: 1 });
  else if (e.key === 'e' || e.key === 'E' || e.key === '[') boardMove({ kind: 'turn', card: sel, dir: -1 });
  else if (/^[1-4]$/.test(e.key)) boardMove({ kind: 'place', card: sel, spot: Number(e.key) - 1 });
  else if ((e.key === 'Backspace' || e.key === 'Delete') && r.board.some((b) => b && b.id === sel)) boardMove({ kind: 'lift', card: sel });
  else if (e.key === 'Escape') {
    sel = null;
    renderGame(lastView, session);
  } else return;
  e.preventDefault();
}

async function createRoom() {
  const name = cleanName($('#name-input').value) || 'Host';
  localStorage.setItem('scl-name', name);
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
  localStorage.setItem('scl-name', name);
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
  $('#name-input').value = localStorage.getItem('scl-name') || '';
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

  document.addEventListener('keydown', onKey);
  // a click on the felt, away from the cards, puts the card in your hand down
  document.addEventListener('click', (e) => {
    if (!sel || !lastView || !canTouch(lastView)) return;
    if (e.target.closest && e.target.closest('.kcard, .spot, .tray-cards, button, #chat, .modal, #cfg-drawer')) return;
    sel = null;
    renderGame(lastView, session);
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
