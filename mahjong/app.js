// app.js — networking + UI for Mahjong.
//
// Topology: host-authoritative star over WebRTC data channels.
//   - The host's browser owns the game state and validates every move.
//   - Guests connect straight to the host (peer-to-peer); no game server.

import {
  PROTO,
  NUM_PLAYERS,
  WINDS,
  VARIANTS,
  variantByKey,
  tileName,
  tileSort,
  isHonor,
  isTerminal,
  buildDeck,
  newMatch,
  nextHand,
  applyMove,
  viewFor,
  botChoose,
  turnSeat,
  playerBySeat,
  markDisconnected,
  markReconnected,
  markBotTakeover,
  markSeatClaimed,
  markSeatResigned,
} from './game.js';
import { initSettings } from '../common/settings.js';
import '../common/version.js';

const cfg = initSettings('mjg', [
  { key: 'botDelay', label: 'Bot thinking delay', def: [1200, 800], section: 'Host pacing', host: true },
  { key: 'claimTimeout', label: 'Claim timeout (0 = off)', def: 0, section: 'Host pacing', host: true, hint: 'Auto-pass a player who hasn\'t responded to a claim after this long. 0 waits indefinitely (the default).' },
  { key: 'talkScale', label: 'Speech-line waits ×', def: 1, min: 0, max: 4, step: 0.1, unit: '×', ms: false, section: 'Table talk' },
  { key: 'talkHoldPad', label: 'Turn hold after last line', def: 1200, section: 'Table talk' },
  { key: 'bubbleSay', label: 'Game bubbles linger', def: 4000, section: 'Bubbles & banners' },
  { key: 'bubbleChat', label: 'Chat bubbles linger', def: 6000, section: 'Bubbles & banners' },
  { key: 'bubbleTrunc', label: 'Bubble text cap', def: 84, min: 12, max: 400, step: 4, unit: 'ch', ms: false, section: 'Bubbles & banners' },
  { key: 'flashMs', label: 'Banner duration', def: 1800, section: 'Bubbles & banners' },
]);

// ---------------------------------------------------------------- networking

const RTC_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
  ],
};

const PEER_OPTS = { debug: 1, config: RTC_CONFIG };
const ID_PREFIX = 'mjg-v1-';
const BOT_NAMES = ['Bamboo', 'Dragon', 'Phoenix', 'Lotus', 'Jade', 'Pearl', 'Tiger', 'Crane'];
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
    peer.on('open', () => { if (!done) { done = true; resolve(peer); } });
    peer.on('error', (e) => { if (!done) { done = true; try { peer.destroy(); } catch {} reject(e); } });
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

const CTRL_RE = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']', 'g');
function cleanName(s) { return (s || '').replace(CTRL_RE, '').trim().slice(0, 16); }
function parseCode(s) { s = (s || '').trim(); const m = s.match(/room=([A-Za-z0-9]+)/); if (m) s = m[1]; return s.replace(/[^A-Za-z0-9]/g, '').toUpperCase(); }
function roomLink(code) { return `${location.origin}${location.pathname}?room=${code}`; }

// ---------------------------------------------------------------- DOM helpers

const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
function showScreen(name) { for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== `screen-${name}`); }
function toast(text, ms = 3000) { const t = el('div', 'toast', text); $('#toasts').append(t); setTimeout(() => t.classList.add('gone'), ms); setTimeout(() => t.remove(), ms + 400); }

let flashTimer = null;
function flash(text, cls = '', ms = 0) {
  const b = $('#banner');
  b.textContent = text;
  b.className = 'flash hidden';
  void b.offsetWidth;
  const dur = ms || cfg('flashMs');
  b.style.setProperty('--dur', `${dur}ms`);
  b.className = `flash ${cls}`;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => b.classList.add('hidden'), dur);
}

function setHomeStatus(text, isError = false) {
  const s = $('#home-status');
  s.textContent = text || '';
  s.classList.toggle('error', isError);
}

function setBusy(busy) { $('#btn-create').disabled = busy; $('#btn-join').disabled = busy; }

function avatarEl(name, seat, bot = false) {
  if (bot) return el('div', 'av bot', '\u{1F916}');
  return el('div', `av s${seat % 4}`, (name || '?').trim().charAt(0).toUpperCase());
}

// ---------------------------------------------------------------- tile rendering

// Tile faces are drawn by us (no Unicode glyph, so no built-in frame): a
// numeral + 萬 for man, traditional dot layouts for pin, bamboo for sou, and
// characters for winds/dragons/flowers. A small English index sits in the
// top-right corner (digit for suits, letter for winds).

const MNUM = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
// rows of pip counts per number — symmetric arrangements like the classic tiles
const PIP_LAYOUT = { 1: [1], 2: [1, 1], 3: [1, 1, 1], 4: [2, 2], 5: [2, 1, 2], 6: [2, 2, 2], 7: [3, 1, 3], 8: [3, 2, 3], 9: [3, 3, 3] };
const WIND_CHAR = { E: '東', S: '南', W: '西', N: '北' };
const DRAGON_CHAR = { R: '中', G: '發', W: '白' };
const FLOWER_CHAR = ['', '梅', '蘭', '菊', '竹', '春', '夏', '秋', '冬'];

function buildFace(t) {
  if (t.kind === 'm') {
    const f = el('div', 'face man');
    f.append(el('span', 'mnum', MNUM[t.v] || t.v));
    f.append(el('span', 'msuit', '萬'));
    return f;
  }
  if (t.kind === 'p' || t.kind === 's') {
    const f = el('div', `face ${t.kind === 'p' ? 'pin' : 'sou'}${t.v === 1 ? ' one' : ''}`);
    const grid = el('div', 'pip-grid');
    for (const count of (PIP_LAYOUT[t.v] || [t.v])) {
      const row = el('div', 'pip-row');
      for (let i = 0; i < count; i++) row.append(el('span', t.kind === 'p' ? 'pip' : 'bamboo'));
      grid.append(row);
    }
    f.append(grid);
    return f;
  }
  if (t.kind === 'wind') { const f = el('div', 'face wind'); f.append(el('span', 'honor', WIND_CHAR[t.v] || t.v)); return f; }
  if (t.kind === 'dragon') { const f = el('div', `face dragon-${t.v}`); f.append(el('span', 'honor', DRAGON_CHAR[t.v] || t.v)); return f; }
  if (t.kind === 'flower') { const f = el('div', 'face flower'); f.append(el('span', 'honor', FLOWER_CHAR[t.v] || '花')); return f; }
  return el('div', 'face');
}

// small corner index — the digit for number suits, a letter for winds;
// nothing for dragons or flowers
function cornerIndex(t) {
  if (t.kind === 'm' || t.kind === 'p' || t.kind === 's') return String(t.v);
  if (t.kind === 'wind') return t.v; // E S W N
  return '';
}

// compact text label for buttons (chi/kan)
function shortTag(t) {
  if (!t) return '?';
  if (t.kind === 'm' || t.kind === 'p' || t.kind === 's') return `${t.v}${t.kind}`;
  if (t.kind === 'wind') return t.v;
  if (t.kind === 'dragon') return { R: 'R', G: 'G', W: 'W' }[t.v] || t.v;
  if (t.kind === 'flower') return `F${t.v}`;
  return t.key;
}

function tileSuitClass(t) {
  if (!t) return '';
  if (t.kind === 'm') return 'man';
  if (t.kind === 'p') return 'pin';
  if (t.kind === 's') return 'sou';
  if (t.kind === 'wind') return 'wind';
  if (t.kind === 'dragon') return `dragon-${t.v}`;
  if (t.kind === 'flower') return 'flower';
  return '';
}

function renderTile(t, opts = {}) {
  if (!t) return el('div', `tile facedown${opts.small ? ' small' : ''}`);
  const cls = ['tile', tileSuitClass(t)];
  if (opts.small) cls.push('small');
  if (opts.highlight) cls.push('highlight');
  if (opts.lastDraw) cls.push('last-draw');
  if (opts.riichi) cls.push('riichi-mark');
  const d = el('div', cls.join(' '));
  d.append(buildFace(t));
  const idx = cornerIndex(t);
  if (idx) d.append(el('span', 'tile-idx', idx));
  if (opts.onClick) { d.style.cursor = 'pointer'; d.addEventListener('click', opts.onClick); }
  return d;
}

function renderMeld(meld) {
  const g = el('div', 'meld');
  for (const t of meld.tiles) g.append(renderTile(t, { small: true }));
  return g;
}

// -------- tile size — three independent knobs, saved per browser --------
const SZ_MIN = 0.6, SZ_MAX = 2.8;
const SZ_KEYS = ['hand', 'ohand', 'played', 'disc'];
function loadSize(key) {
  try { const v = parseFloat(localStorage.getItem(`mjg-ts-${key}`)); if (Number.isFinite(v)) return Math.min(SZ_MAX, Math.max(SZ_MIN, v)); } catch {}
  return 1;
}
const sizes = { hand: loadSize('hand'), ohand: loadSize('ohand'), played: loadSize('played'), disc: loadSize('disc') };

function applySizes() {
  const g = $('#screen-game');
  if (g) {
    g.style.setProperty('--ts-hand', sizes.hand);
    g.style.setProperty('--ts-ohand', sizes.ohand);
    g.style.setProperty('--ts-played', sizes.played);
    g.style.setProperty('--ts-disc', sizes.disc);
  }
  for (const k of SZ_KEYS) {
    const inp = $(`#sz-${k}`); if (inp) inp.value = sizes[k];
    const lbl = $(`#sz-${k}-v`); if (lbl) lbl.textContent = `${Math.round(sizes[k] * 100)}%`;
  }
}

function setSize(k, v) { sizes[k] = v; try { localStorage.setItem(`mjg-ts-${k}`, String(v)); } catch {} applySizes(); }

// ---------------------------------------------------------------- chat

let chatUnread = 0;
let peekTimer = null;

function chatSetVisible(v) { $('#chat').classList.toggle('hidden', !v); }

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
    el('span', `chat-name s${(m.seat || 0) % 4}`, m.name || '?'),
    el('span', 'chat-text', m.text.length > 90 ? `${m.text.slice(0, 90)}…` : m.text),
  );
  peek.classList.remove('hidden');
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => peek.classList.add('hidden'), 6000);
}

function fmtChatTime(ts) { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

function addChatMsg(m, self) {
  const box = $('#chat-msgs');
  const row = el('div', `chat-msg${self ? ' mine' : ''}`);
  row.append(el('span', `chat-name s${(m.seat || 0) % 4}`, m.name || '?'));
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

const chatBubbles = new Map();
let bubbleId = 0;

function paintChatBubbles() {
  let layer = document.querySelector('#bubble-layer');
  if (!layer) { layer = el('div', ''); layer.id = 'bubble-layer'; document.body.append(layer); }
  const seen = new Set();
  for (const [seat, arr] of chatBubbles) {
    const host = document.querySelector(`.seat[data-seat="${seat}"]`) || (seat === lastView?.mySeat ? $('#my-zone') : null);
    if (!host || !host.offsetParent) continue;
    const key = String(seat);
    seen.add(key);
    let stack = layer.querySelector(`.bubble-stack[data-seat="${key}"]`);
    if (!stack) { stack = el('div', 'bubble-stack'); stack.dataset.seat = key; layer.append(stack); }
    const kept = new Set();
    for (const b of arr) {
      const bid = String(b.id);
      kept.add(bid);
      let bub = stack.querySelector(`.chat-bubble[data-id="${bid}"]`);
      if (!bub) { bub = el('div', 'chat-bubble', b.text); bub.dataset.id = bid; stack.append(bub); }
      bub.classList.toggle('say', !!b.say);
    }
    for (const n of stack.querySelectorAll('.chat-bubble')) { if (!kept.has(n.dataset.id)) n.remove(); }
    const r = host.getBoundingClientRect();
    stack.style.left = `${Math.round(r.left + r.width / 2)}px`;
    // always above the seat, but floored so it never slides under the topbar
    const minTop = 46 + stack.offsetHeight + 10;
    stack.style.top = `${Math.round(Math.max(r.top, minTop))}px`;
  }
  for (const n of layer.querySelectorAll('.bubble-stack')) { if (!seen.has(n.dataset.seat)) n.remove(); }
}

function showChatBubble(m) {
  if (m.seat == null) return;
  const arr = chatBubbles.get(m.seat) || [];
  const id = ++bubbleId;
  const trunc = cfg.raw('bubbleTrunc');
  const text = m.text.length > trunc ? m.text.slice(0, trunc) + '…' : m.text;
  arr.push({ id, text, say: !!m.say });
  chatBubbles.set(m.seat, arr);
  paintChatBubbles();
  const ms = m.say ? cfg('bubbleSay') : cfg('bubbleChat');
  setTimeout(() => {
    const a = chatBubbles.get(m.seat);
    if (a) {
      const idx = a.findIndex((b) => b.id === id);
      if (idx >= 0) a.splice(idx, 1);
      if (a.length === 0) chatBubbles.delete(m.seat);
    }
    paintChatBubbles();
  }, ms);
}

function clearChatBubbles() {
  for (const [, arr] of chatBubbles) arr.length = 0;
  chatBubbles.clear();
  paintChatBubbles();
}

// ---------------------------------------------------------------- rejoin

function saveRejoin(code, token) { try { sessionStorage.setItem(`mjg-rejoin-${code}`, token); } catch {} }
function loadRejoin(code) { try { return sessionStorage.getItem(`mjg-rejoin-${code}`); } catch {} return null; }
function clearRejoin(code) { try { sessionStorage.removeItem(`mjg-rejoin-${code}`); } catch {} }

// ---------------------------------------------------------------- host session

let session = null;
let lastView = null;
let pendingMove = false;
let selectedTile = null;
let handOrder = [];   // tile-id display order for my hand (drag to rearrange)

class HostSession {
  constructor(peer, code, name) {
    this.isHost = true;
    this.peer = peer;
    this.code = code;
    this.conns = new Map();
    this.watchers = [];
    this.wid = 0;
    this.roster = [{ seat: 0, name, connected: true, token: genCode(12) }];
    this.G = null;
    this.chatLog = [];
    this.selectedVariant = 'tw';
    this.botTimer = null;
    this.claimTimer = null;

    peer.on('connection', (conn) => {
      conn.on('open', () => {
        conn.on('data', (msg) => this.onMsg(conn, msg));
        conn.on('close', () => this.drop(conn));
        conn.on('error', () => this.drop(conn));
      });
    });

    this.pushLobby();
  }

  onMsg(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'join') return this.join(conn, msg);
    if (msg.t === 'move') {
      const seat = conn._seat;
      if (seat != null && this.G) this.move(seat, msg.move);
      return;
    }
    if (msg.t === 'chat') {
      const seat = conn._seat;
      if (seat == null) return;
      const p = this.roster.find((r) => r.seat === seat);
      if (!p) return;
      const text = cleanName(msg.text);
      if (!text) return;
      const m = { seat, name: p.name, text, ts: Date.now() };
      this.chatLog.push(m);
      if (this.chatLog.length > 100) this.chatLog.shift();
      for (const [, c] of this.conns) { try { c.send({ t: 'chat', msg: m }); } catch {} }
      addChatMsg(m, false);
    }
    if (msg.t === 'next' && conn._seat === 0) return; // only host can advance via UI
  }

  join(conn, msg) {
    const deny = (reason) => { try { conn.send({ t: 'deny', reason }); } catch {} setTimeout(() => { try { conn.close(); } catch {} }, 400); };
    if (conn._seat != null) return;
    if (msg.v !== PROTO) return deny('version');
    if (msg.token) {
      const back = this.roster.find((r) => r.token && r.token === msg.token);
      if (back) return this.reattach(conn, back);
    }
    if (this.G || this.roster.length >= NUM_PLAYERS) return this.attachWatcher(conn, msg);
    let seat = 0;
    while (this.roster.some((p) => p.seat === seat)) seat++;
    const name = cleanName(msg.name) || `Player ${seat + 1}`;
    conn._seat = seat;
    this.conns.set(seat, conn);
    const token = genCode(12);
    this.roster.push({ seat, name, connected: true, token });
    try { conn.send({ t: 'welcome', seat, code: this.code, token }); } catch {}
    toast(`${name} joined`);
    this.pushLobby();
  }

  reattach(conn, p) {
    const old = this.conns.get(p.seat);
    if (old && old !== conn) { old._seat = null; try { old.close(); } catch {} }
    conn._seat = p.seat;
    this.conns.set(p.seat, conn);
    p.connected = true;
    try { conn.send({ t: 'welcome', seat: p.seat, code: this.code, token: p.token }); } catch {}
    if (this.G) { markReconnected(this.G, p.seat); this.broadcast(); } else this.pushLobby();
  }

  drop(conn) {
    if (conn._watcher != null) {
      this.watchers = this.watchers.filter((x) => x.id !== conn._watcher);
      conn._watcher = null;
      return;
    }
    const seat = conn._seat;
    if (seat == null) return;
    conn._seat = null;
    this.conns.delete(seat);
    const p = this.roster.find((r) => r.seat === seat);
    if (!p) return;
    if (!this.G) { this.roster = this.roster.filter((r) => r.seat !== seat); this.pushLobby(); }
    else { p.connected = false; markDisconnected(this.G, seat); this.broadcast(); }
  }

  attachWatcher(conn, msg) {
    const name = cleanName(msg.name) || 'Watcher';
    const id = ++this.wid;
    conn._watcher = id;
    const target = this.roster.length ? this.roster[0].seat : 0;
    this.watchers.push({ id, name, conn, target });
    try {
      conn.send({ t: 'welcome', observer: true, code: this.code });
      if (this.G) conn.send({ t: 'state', view: viewFor(this.G, target, this.code) });
    } catch {}
  }

  pushLobby() {
    const data = { t: 'lobby', roster: this.roster.map((r) => ({ seat: r.seat, name: r.name, bot: !!r.bot })), variant: this.selectedVariant };
    for (const [, conn] of this.conns) { try { conn.send(data); } catch {} }
    renderLobby(this);
  }

  addBot() {
    if (this.roster.length >= NUM_PLAYERS) return;
    let seat = 0;
    while (this.roster.some((p) => p.seat === seat)) seat++;
    const name = BOT_NAMES[seat % BOT_NAMES.length];
    this.roster.push({ seat, name, bot: true, connected: true });
    this.pushLobby();
  }

  removeBot(seat) {
    this.roster = this.roster.filter((r) => r.seat !== seat || !r.bot);
    this.pushLobby();
  }

  setVariant(key) {
    if (VARIANTS.some((v) => v.key === key)) { this.selectedVariant = key; this.pushLobby(); }
  }

  start() {
    if (this.roster.length < NUM_PLAYERS) return;
    this.G = newMatch(this.roster, this.selectedVariant);
    saveRejoin(this.code, this.roster[0].token);
    this.broadcast();
  }

  broadcast() {
    if (!this.G) return;
    const wnames = this.watchers.map((x) => x.name);
    for (const [seat, conn] of this.conns) {
      try { conn.send({ t: 'state', view: { ...viewFor(this.G, seat, this.code), watchers: wnames } }); } catch {}
    }
    for (const w of this.watchers) {
      try { w.conn.send({ t: 'state', view: { ...viewFor(this.G, w.target, this.code), watchers: wnames } }); } catch {}
    }
    pendingMove = false;
    selectedTile = null;
    showScreen('game');
    renderGame({ ...viewFor(this.G, 0, this.code), watchers: wnames }, this);
    this.scheduleBots();
    this.scheduleClaimTimeout();
  }

  move(seat, move) {
    if (!this.G) return;
    const res = applyMove(this.G, seat, move);
    if (!res.ok) {
      if (seat === 0) { pendingMove = false; toast(res.error); if (lastView) renderGame(lastView, this); }
      else { try { this.conns.get(seat)?.send({ t: 'err', error: res.error }); } catch {} }
      return;
    }
    this.broadcast();
  }

  localMove(move) { this.move(0, move); }

  localNext() {
    if (!this.G || this.G.phase !== 'handEnd') return;
    nextHand(this.G);
    this.broadcast();
  }

  scheduleBots() {
    clearTimeout(this.botTimer);
    if (!this.G || this.G.phase === 'over' || this.G.phase === 'handEnd') return;
    const delay = cfg.range('botDelay');
    this.botTimer = setTimeout(() => this.tickBots(), delay);
  }

  tickBots() {
    if (!this.G) return;
    for (const p of this.G.players) {
      if (!p.bot && !p.botFor) continue;
      const move = botChoose(this.G, p.seat);
      if (move) { this.move(p.seat, move); return; }
    }
    // if claim phase and all bots have responded, check non-bots
    if (this.G.phase === 'claim' && this.G.claimPhase) {
      const cp = this.G.claimPhase;
      const allDone = cp.eligible.every((e) => e.response !== null);
      if (!allDone) this.scheduleBots(); // re-check soon
    }
  }

  scheduleClaimTimeout() {
    clearTimeout(this.claimTimer);
    if (!this.G || this.G.phase !== 'claim') return;
    const ms = cfg('claimTimeout');
    if (!ms || ms <= 0) return; // 0 = wait indefinitely for a response
    this.claimTimer = setTimeout(() => {
      if (!this.G || this.G.phase !== 'claim' || !this.G.claimPhase) return;
      // auto-pass for anyone who hasn't responded
      for (const e of this.G.claimPhase.eligible) {
        if (!e.response) this.move(e.seat, { kind: 'pass' });
      }
    }, ms);
  }

  destroy() {
    clearTimeout(this.botTimer);
    clearTimeout(this.claimTimer);
    try { this.peer.destroy(); } catch {}
  }
}

// ---- guest session

class GuestSession {
  constructor(peer, code, name, resume = null) {
    this.isHost = false;
    this.peer = peer;
    this.code = code;
    this.name = name;
    this.seat = null;
    this.token = (resume && resume.token) || loadRejoin(code);
    this.joined = false;
    this.closed = false;
    const conn = peer.connect(ID_PREFIX + code, { reliable: true, serialization: 'json' });
    this.conn = conn;
    conn.on('open', () => {
      conn.send({ t: 'join', v: PROTO, name, token: this.token || undefined });
    });
    conn.on('data', (msg) => this.onMsg(msg));
    conn.on('close', () => { if (!this.closed) guestGone(code, 'The host closed the connection.'); });
    conn.on('error', () => { if (!this.closed) guestGone(code, 'Connection error.'); });
  }

  onMsg(msg) {
    if (!msg) return;
    if (msg.t === 'welcome') {
      this.seat = msg.seat;
      this.joined = true;
      if (msg.token) { this.token = msg.token; saveRejoin(this.code, msg.token); }
      if (msg.observer) toast('Room full — watching');
    }
    if (msg.t === 'deny') {
      this.closed = true;
      try { this.peer.destroy(); } catch {}
      session = null;
      setHomeStatus(msg.reason === 'version' ? 'Version mismatch — refresh the page.' : `Denied: ${msg.reason}`, true);
      showScreen('home');
      setBusy(false);
      return;
    }
    if (msg.t === 'lobby') renderLobby(this, msg);
    if (msg.t === 'state') {
      showScreen('game');
      renderGame(msg.view, this);
    }
    if (msg.t === 'err') toast(msg.error);
    if (msg.t === 'chat') addChatMsg(msg.msg, msg.msg.seat === this.seat);
    if (msg.t === 'chatlog') { for (const m of msg.items) addChatMsg(m, m.seat === this.seat); }
  }

  localMove(move) {
    try { this.conn.send({ t: 'move', move }); } catch {}
  }

  localNext() {
    // guest can't advance; just wait
  }

  destroy() {
    this.closed = true;
    try { this.peer.destroy(); } catch {}
  }
}

function guestGone(code, why) {
  session = null;
  setHomeStatus(why, true);
  showScreen('home');
  setBusy(false);
}

// ---------------------------------------------------------------- render: lobby

function renderLobby(sess, lobbyMsg) {
  showScreen('lobby');
  const isHost = sess.isHost;
  const roster = isHost ? sess.roster : (lobbyMsg && lobbyMsg.roster) || [];
  const variant = isHost ? sess.selectedVariant : (lobbyMsg && lobbyMsg.variant) || 'tw';

  $('#lobby-code').textContent = sess.code;
  // Always render NUM_PLAYERS seats (filled or "Open seat") so the list height
  // stays constant — adding a bot fills a slot instead of growing the panel.
  const list = $('#lobby-players');
  list.replaceChildren();
  const bySeat = [...roster].sort((a, b) => a.seat - b.seat);
  for (let i = 0; i < NUM_PLAYERS; i++) {
    const p = bySeat[i];
    const li = el('li', p ? '' : 'empty');
    if (p) {
      li.append(avatarEl(p.name, p.seat, p.bot));
      li.append(el('span', 'p-name', p.name));
      if (p.bot && isHost) {
        const rm = el('button', 'btn ghost seat-remove', '✕');
        rm.addEventListener('click', () => sess.removeBot(p.seat));
        li.append(rm);
      }
    } else {
      li.append(el('div', 'av empty-av'));
      li.append(el('span', 'p-name empty-label', 'Open seat'));
    }
    list.append(li);
  }

  // variant picker
  const picker = $('#variant-picker');
  picker.replaceChildren();
  for (const v of VARIANTS) {
    const chip = el('div', `chip${v.key === variant ? ' active' : ''}`, v.name);
    if (isHost) chip.addEventListener('click', () => sess.setVariant(v.key));
    picker.append(chip);
  }
  $('#variant-blurb').textContent = variantByKey(variant).blurb;

  // buttons
  const canAdd = isHost && roster.length < NUM_PLAYERS;
  const canStart = isHost && roster.length === NUM_PLAYERS;
  $('#btn-add-bot').classList.toggle('hidden', !canAdd);
  $('#btn-start').classList.toggle('hidden', !canStart);
  $('#lobby-hint').textContent = roster.length < NUM_PLAYERS ? `Need ${NUM_PLAYERS - roster.length} more player${roster.length < 3 ? 's' : ''}.` : isHost ? 'Ready to start!' : 'Waiting for the host…';
}

// ---------------------------------------------------------------- render: game

let seenFxSeq = 0;
let chatSeenN = 0;

function renderGame(view, sess) {
  lastView = view;
  const my = view.mySeat;

  // topbar
  $('#room-chip').textContent = view.code;
  $('#wind-chip').textContent = `${view.roundWind}${view.handNum}`;
  $('#wall-chip').textContent = `${view.wallCount} left`;

  // seat mapping: top = across, right = next, left = prev
  const seatOrder = [(my + 2) % 4, (my + 1) % 4, (my + 3) % 4];
  const seatEls = ['.seat-top', '.seat-right', '.seat-left'];

  for (let i = 0; i < 3; i++) {
    const s = seatOrder[i];
    const p = view.players.find((q) => q.seat === s);
    const el_ = $(seatEls[i]);
    el_.dataset.seat = s;
    el_.querySelector('.seat-name').textContent = p ? p.name : '';
    const wind = WINDS[(s - view.dealer + 4) % 4];
    const windEl = el_.querySelector('.seat-wind');
    windEl.textContent = wind;
    windEl.classList.toggle('dealer', s === view.dealer);
    el_.querySelector('.seat-score').textContent = p ? `${p.score}` : '';

    // concealed hand (face-down), so each seat looks like a real player
    const handFd = el_.querySelector('.seat-hand');
    if (handFd) {
      handFd.replaceChildren();
      if (p) for (let k = 0; k < p.tileCount; k++) handFd.append(renderTile(null, { small: true }));
    }

    // played: flowers first, then melds (sets)
    const playedEl = el_.querySelector('.seat-played');
    playedEl.replaceChildren();
    if (p) {
      for (const f of (p.flowers || [])) playedEl.append(renderTile(f, { small: true }));
      for (const m of p.melds) playedEl.append(renderMeld(m));
    }

    // discards
    const discEl = el_.querySelector('.seat-discards');
    discEl.replaceChildren();
    if (p) {
      for (const t of p.discards) {
        discEl.append(renderTile(t, { small: true, riichi: t.riichi }));
      }
    }
  }

  // center info
  $('#round-wind-display').textContent = `${view.roundWind} Round`;
  const doraEl = $('#dora-display');
  doraEl.replaceChildren();
  if (view.dora && view.dora.length > 0) {
    doraEl.append(el('span', '', 'Dora: '));
    for (const d of view.dora) doraEl.append(renderTile(d, { small: true }));
  }
  const sticksEl = $('#sticks-display');
  sticksEl.textContent = '';
  if (view.riichiSticks > 0) sticksEl.textContent = `${view.riichiSticks} riichi`;
  if (view.honba > 0) sticksEl.textContent += ` ${view.honba} honba`;

  // last discard in center
  const ldEl = $('#last-discard');
  ldEl.replaceChildren();
  if (view.lastDiscard && view.phase === 'claim') {
    ldEl.append(renderTile(view.lastDiscard, { highlight: true }));
    const from = view.players.find((q) => q.seat === view.lastDiscardSeat);
    if (from) ldEl.append(el('div', '', `from ${from.name}`));
  }

  // my zone
  const me = view.players.find((q) => q.seat === my);
  $('#my-name').textContent = me ? me.name : '';
  const myWind = WINDS[(my - view.dealer + 4) % 4];
  const myWindEl = $('#my-wind');
  myWindEl.textContent = myWind;
  myWindEl.className = 'seat-wind' + (my === view.dealer ? ' dealer' : '');
  $('#my-score').textContent = me ? `${me.score}` : '';

  // my discards (nearest the centre)
  const myDisc = $('#my-discards');
  myDisc.replaceChildren();
  if (me) {
    for (const t of me.discards) myDisc.append(renderTile(t, { small: true, riichi: t.riichi }));
  }

  // my played: flowers first, then melds (sets)
  const myPlayed = $('#my-played');
  myPlayed.replaceChildren();
  if (me) {
    for (const f of (me.flowers || [])) myPlayed.append(renderTile(f, { small: true }));
    for (const m of me.melds) myPlayed.append(renderMeld(m));
  }

  // hand — reconciled by id so an in-progress drag isn't disrupted and the
  // tile count stays exact
  renderHand(view, me, sess);

  // action bar
  renderActions(view, sess);

  // feed
  renderFeed(view);

  // speech bubbles
  if (view.chatter) {
    for (const c of view.chatter) {
      if (c.n > chatSeenN) {
        chatSeenN = c.n;
        showChatBubble({ seat: c.seat, text: c.text, say: true });
      }
    }
  }

  // fx
  if (view.fx && view.fx.seq > seenFxSeq) {
    seenFxSeq = view.fx.seq;
    if (view.fx.kind === 'deal') flash(`Hand ${view.handNum}`, '', cfg('flashMs'));
    if (view.fx.kind === 'riichi') flash('Riichi!', 'big', cfg('flashMs'));
    if (view.fx.kind === 'handEnd') {
      if (view.fx.result === 'win') flash(view.fx.seat === my ? 'You win!' : `${view.players.find((q) => q.seat === view.fx.seat)?.name || '?'} wins!`, 'big', 2500);
      else flash('Draw', '', 2000);
    }
  }

  // hand end modal
  if (view.phase === 'handEnd' && view.handResult) {
    showHandEnd(view, sess);
  } else {
    $('#handend').classList.add('hidden');
  }

  // game over
  if (view.phase === 'over') {
    showGameOver(view, sess);
  } else {
    $('#gameover').classList.add('hidden');
  }

  chatSetVisible(true);
  paintChatBubbles();
}

function handleTileClick(id, sess) {
  if (pendingMove) return;
  if (selectedTile === id) {
    // tap again = discard
    pendingMove = true;
    selectedTile = null;
    sess.localMove({ kind: 'discard', tileId: id });
  } else {
    selectedTile = id;
    if (lastView) renderGame(lastView, sess);
  }
}

// Keep my hand in the order I've arranged it: known tiles hold their slot,
// freshly dealt/drawn tiles are inserted sorted so the opening hand is tidy.
function orderedHand(hand) {
  const pos = new Map(handOrder.map((id, i) => [id, i]));
  const known = hand.filter((t) => pos.has(t.id)).sort((a, b) => pos.get(a.id) - pos.get(b.id));
  const fresh = hand.filter((t) => !pos.has(t.id)).sort(tileSort);
  const ordered = known.concat(fresh);
  handOrder = ordered.map((t) => t.id);
  return ordered;
}

// Reconcile the hand DOM in place: reuse each tile element by id (so an active
// drag and exact counts are preserved) and only reshuffle when not dragging.
function renderHand(view, me, sess) {
  const handEl = $('#hand');
  if (!me || !me.hand) { handEl.replaceChildren(); return; }
  const ordered = orderedHand(me.hand);
  const byId = new Map([...handEl.children].map((n) => [n.dataset.tid, n]));
  const desired = ordered.map((t) => {
    const isLastDraw = view.lastDraw && t.id === view.lastDraw.id;
    const ex = byId.get(String(t.id));
    if (ex) { patchHandTile(ex, t.id, isLastDraw); return ex; }
    return handCardEl(t, sess, isLastDraw);
  });
  for (const n of [...handEl.children]) if (!desired.includes(n)) n.remove();
  if (!handEl.querySelector('.tile.dragging')) {
    let cursor = handEl.firstChild;
    for (const n of desired) {
      if (n === cursor) { cursor = cursor.nextSibling; continue; }
      handEl.insertBefore(n, cursor);
    }
  }
}

function patchHandTile(el, id, isLastDraw) {
  el.classList.toggle('selected', selectedTile === id);
  el.classList.toggle('last-draw', !!isLastDraw);
}

function handCardEl(t, sess, isLastDraw) {
  const tile = renderTile(t, { lastDraw: isLastDraw });
  tile.dataset.tid = String(t.id);
  tile.style.cursor = 'pointer';
  if (selectedTile === t.id) tile.classList.add('selected');
  attachHandDrag(tile, t.id, sess);
  return tile;
}

// Drag a hand tile to rearrange it. Slot centres are snapshotted once at drag
// start so the thresholds never move under the pointer; the other tiles slide
// aside by transform only (no DOM churn) to preview the landing gap, and the
// order is committed once on release. A tap (no drag) selects/discards.
function attachHandDrag(tile, tileId, sess) {
  tile.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const hand = $('#hand');
    const startX = e.clientX;
    let dragging = false;
    let slots = null;

    const snapshot = () => {
      const children = [...hand.children];
      const rects = children.map((n) => n.getBoundingClientRect());
      slots = {
        children,
        centers: rects.map((r) => r.left + r.width / 2),
        myIndex: children.indexOf(tile),
        step: children.length > 1 ? Math.abs(rects[1].left - rects[0].left) : rects[0].width,
      };
    };
    const targetIndex = (x) => {
      let t = 0;
      slots.children.forEach((n, i) => { if (n !== tile && slots.centers[i] < x) t++; });
      return t;
    };
    const preview = (x) => {
      const F = targetIndex(x), D = slots.myIndex;
      slots.children.forEach((n, i) => {
        if (n === tile) return;
        let dx = 0;
        if (F > D && i > D && i <= F) dx = -slots.step;
        else if (F < D && i >= F && i < D) dx = slots.step;
        n.style.transform = dx ? `translateX(${dx}px)` : '';
      });
    };
    const move = (ev) => {
      const dx = ev.clientX - startX;
      if (!dragging && Math.abs(dx) > 8) {
        dragging = true;
        tile.classList.add('dragging');
        snapshot();
      }
      if (dragging) {
        tile.style.transform = `translate(${dx}px, -10px) scale(1.04)`;
        preview(ev.clientX);
      }
    };
    const done = (ev) => {
      tile.removeEventListener('pointermove', move);
      tile.removeEventListener('pointerup', done);
      tile.removeEventListener('pointercancel', done);
      if (!dragging) {
        if (lastView && lastView.phase === 'discard' && lastView.turn === lastView.mySeat) handleTileClick(tileId, sess);
        return;
      }
      tile.classList.remove('dragging');
      const idx = targetIndex(ev.clientX);
      for (const n of slots.children) n.style.transform = '';
      tile.style.transform = '';
      const rest = handOrder.filter((id) => id !== tileId);
      rest.splice(idx, 0, tileId);
      handOrder = rest;
      if (lastView) renderGame(lastView, sess);
    };

    try { tile.setPointerCapture(e.pointerId); } catch {}
    tile.addEventListener('pointermove', move);
    tile.addEventListener('pointerup', done);
    tile.addEventListener('pointercancel', done);
  });
}

function renderActions(view, sess) {
  const bar = $('#action-bar');
  bar.replaceChildren();
  const my = view.mySeat;

  // claim phase buttons
  if (view.claimOpts) {
    const opts = view.claimOpts;
    if (opts.options.includes('ron')) {
      const b = el('button', 'btn ron', 'Ron');
      b.addEventListener('click', () => { if (!pendingMove) { pendingMove = true; sess.localMove({ kind: 'ron' }); } });
      bar.append(b);
    }
    if (opts.options.includes('kan')) {
      const b = el('button', 'btn kan-btn', 'Kan');
      b.addEventListener('click', () => { if (!pendingMove) { pendingMove = true; sess.localMove({ kind: 'kan' }); } });
      bar.append(b);
    }
    if (opts.options.includes('pon')) {
      const b = el('button', 'btn pon-btn', 'Pon');
      b.addEventListener('click', () => { if (!pendingMove) { pendingMove = true; sess.localMove({ kind: 'pon' }); } });
      bar.append(b);
    }
    if (opts.options.includes('chi')) {
      for (const combo of opts.chiCombos) {
        const label = `Chi ${combo.map((t) => shortTag(t)).join('+')}`;
        const b = el('button', 'btn chi-btn', label);
        b.addEventListener('click', () => {
          if (!pendingMove) { pendingMove = true; sess.localMove({ kind: 'chi', tile1: combo[0].id, tile2: combo[1].id }); }
        });
        bar.append(b);
      }
    }
    const pass = el('button', 'btn secondary', 'Pass');
    pass.addEventListener('click', () => { if (!pendingMove) { pendingMove = true; sess.localMove({ kind: 'pass' }); } });
    bar.append(pass);
    return;
  }

  // discard phase actions
  if (view.actions && view.phase === 'discard' && view.turn === my) {
    const a = view.actions;
    if (a.canTsumo) {
      const b = el('button', 'btn tsumo', 'Tsumo');
      b.addEventListener('click', () => { if (!pendingMove) { pendingMove = true; sess.localMove({ kind: 'tsumo' }); } });
      bar.append(b);
    }
    if (a.canRiichi) {
      const b = el('button', 'btn riichi-btn', 'Riichi');
      b.addEventListener('click', () => {
        if (!pendingMove && selectedTile && a.riichiDiscards.includes(selectedTile)) {
          pendingMove = true;
          sess.localMove({ kind: 'riichi', tileId: selectedTile });
        } else {
          toast('Select a tile to discard with Riichi');
        }
      });
      bar.append(b);
    }
    if (a.canClosedKan && a.closedKanKeys.length > 0) {
      for (const key of a.closedKanKeys) {
        const b = el('button', 'btn kan-btn', `Kan (${key})`);
        b.addEventListener('click', () => { if (!pendingMove) { pendingMove = true; sess.localMove({ kind: 'kan', type: 'closed', tileKey: key }); } });
        bar.append(b);
      }
    }
    if (a.canAddKan && a.addKanOptions.length > 0) {
      for (const tid of a.addKanOptions) {
        const t = view.players.find((q) => q.seat === my)?.hand.find((h) => h.id === tid);
        const b = el('button', 'btn kan-btn', `Kan+ (${t ? shortTag(t) : '?'})`);
        b.addEventListener('click', () => { if (!pendingMove) { pendingMove = true; sess.localMove({ kind: 'kan', type: 'add', tileId: tid }); } });
        bar.append(b);
      }
    }

    if (!a.canTsumo) {
      const hint = el('span', '', selectedTile ? 'Click again to discard' : 'Select a tile to discard');
      hint.style.cssText = 'font-size:12px;color:#5a8a6a;';
      bar.append(hint);
    }
  }

  // waiting hint
  if (view.phase === 'discard' && view.turn !== my) {
    const who = view.players.find((q) => q.seat === view.turn);
    bar.append(el('span', '', `${who?.name || '?'}'s turn…`));
  }
}

function renderFeed(view) {
  const feed = $('#feed');
  feed.replaceChildren();
  for (const entry of view.log) {
    feed.append(el('div', '', entry.text));
  }
  feed.scrollTop = feed.scrollHeight;
}

function showHandEnd(view, sess) {
  const m = $('#handend');
  m.classList.remove('hidden');
  const hr = view.handResult;
  const title = $('#he-title');
  const detail = $('#he-detail');
  const scores = $('#he-scores');

  if (hr.type === 'win') {
    const winner = view.players.find((q) => q.seat === hr.winner);
    title.textContent = hr.tsumo ? `${winner?.name} — Tsumo!` : `${winner?.name} — Ron!`;
    let detailHtml = '';
    if (hr.scoring && hr.scoring.yaku) {
      for (const y of hr.scoring.yaku) {
        detailHtml += `<div>${y.name}: ${y.han || y.val || ''}</div>`;
      }
    }
    detailHtml += `<div><b>${hr.scoring?.summary || ''}</b></div>`;
    detail.innerHTML = detailHtml;
  } else {
    title.textContent = 'Exhaustive draw';
    detail.textContent = 'The wall ran out.';
  }

  scores.replaceChildren();
  for (const p of view.players) {
    const row = el('div', '');
    row.append(el('span', '', p.name));
    row.append(el('span', '', `${p.score}`));
    scores.append(row);
  }

  const btn = $('#btn-next-hand');
  const wait = $('#he-wait');
  if (sess.isHost) {
    btn.classList.remove('hidden');
    wait.classList.add('hidden');
    btn.onclick = () => sess.localNext();
  } else {
    btn.classList.add('hidden');
    wait.classList.remove('hidden');
  }
}

function showGameOver(view, sess) {
  const m = $('#gameover');
  m.classList.remove('hidden');
  const sorted = [...view.players].sort((a, b) => b.score - a.score);
  $('#go-title').textContent = 'Game Over';
  $('#go-sub').textContent = `${sorted[0].name} wins!`;
  const rank = $('#go-rank');
  rank.replaceChildren();
  for (const p of sorted) {
    const li = el('li', '');
    li.append(el('span', '', p.name));
    li.append(el('span', '', `${p.score}`));
    rank.append(li);
  }

  if (sess.isHost) {
    $('#btn-again').classList.remove('hidden');
    $('#btn-golobby').classList.remove('hidden');
    $('#go-wait').classList.add('hidden');
    $('#btn-again').onclick = () => {
      sess.G = newMatch(sess.roster, sess.selectedVariant);
      sess.broadcast();
    };
    $('#btn-golobby').onclick = () => {
      sess.G = null;
      sess.pushLobby();
    };
  } else {
    $('#btn-again').classList.add('hidden');
    $('#btn-golobby').classList.add('hidden');
    $('#go-wait').classList.remove('hidden');
  }
}

// ---------------------------------------------------------------- create / join

async function createRoom() {
  setBusy(true);
  setHomeStatus('Creating room…');
  const name = cleanName($('#name-input').value) || 'Host';
  try {
    const code = genCode();
    const peer = await openPeer(ID_PREFIX + code);
    session = new HostSession(peer, code, name);
    showScreen('lobby');
    setHomeStatus('');
  } catch (e) {
    setHomeStatus(explainPeerError(e), true);
  }
  setBusy(false);
}

async function joinRoom() {
  setBusy(true);
  const name = cleanName($('#name-input').value) || 'Guest';
  const code = parseCode($('#code-input').value);
  if (!code) { setHomeStatus('Enter a room code.', true); setBusy(false); return; }
  setHomeStatus('Connecting…');
  try {
    const peer = await openPeer();
    session = new GuestSession(peer, code, name);
  } catch (e) {
    setHomeStatus(explainPeerError(e), true);
  }
  setBusy(false);
}

function leaveRoom() {
  if (session) { session.destroy(); session = null; }
  lastView = null;
  pendingMove = false;
  selectedTile = null;
  handOrder = [];
  seenFxSeq = 0;
  chatSeenN = 0;
  clearChatBubbles();
  showScreen('home');
  setHomeStatus('');
}

// ---------------------------------------------------------------- boot

$('#btn-create').addEventListener('click', createRoom);
$('#btn-join').addEventListener('click', joinRoom);
$('#code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
$('#name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-create').click(); });
$('#btn-add-bot').addEventListener('click', () => session?.addBot());
$('#btn-start').addEventListener('click', () => session?.start());
$('#btn-size').addEventListener('click', (e) => { e.stopPropagation(); $('#size-popover').classList.toggle('hidden'); });
for (const k of SZ_KEYS) $(`#sz-${k}`).addEventListener('input', (e) => setSize(k, parseFloat(e.target.value)));
$('#size-popover').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => $('#size-popover').classList.add('hidden'));
applySizes();
for (const b of document.querySelectorAll('.btn-leave')) b.addEventListener('click', leaveRoom);
for (const b of document.querySelectorAll('.btn-rules')) b.addEventListener('click', () => $('#modal-rules').classList.remove('hidden'));
$('#btn-rules-close').addEventListener('click', () => $('#modal-rules').classList.add('hidden'));
$('#modal-rules').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden'); });
$('#handend').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden'); });
$('#chat-toggle').addEventListener('click', () => {
  if ($('#chat-panel').classList.contains('hidden')) openChatPanel();
  else $('#chat-panel').classList.add('hidden');
});
$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = cleanName($('#chat-input').value);
  if (!text || !session) return;
  $('#chat-input').value = '';
  if (session.isHost) {
    const m = { seat: 0, name: session.roster[0].name, text, ts: Date.now() };
    session.chatLog.push(m);
    for (const [, conn] of session.conns) { try { conn.send({ t: 'chat', msg: m }); } catch {} }
    addChatMsg(m, true);
  } else {
    try { session.conn.send({ t: 'chat', text }); } catch {}
  }
});
$('#btn-copy-code').addEventListener('click', () => { navigator.clipboard.writeText(session?.code || ''); toast('Code copied'); });
$('#btn-copy-link').addEventListener('click', () => { navigator.clipboard.writeText(roomLink(session?.code || '')); toast('Link copied'); });

// auto-join from URL
const params = new URLSearchParams(location.search);
if (params.get('room')) {
  $('#code-input').value = params.get('room');
  history.replaceState(null, '', location.pathname);
}

// handle window scroll/resize for bubbles
window.addEventListener('scroll', paintChatBubbles, { passive: true });
window.addEventListener('resize', paintChatBubbles);
