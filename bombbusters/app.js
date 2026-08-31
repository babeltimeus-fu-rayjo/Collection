// app.js — networking + UI for Bomb Busters.
//
// Topology: host-authoritative star over WebRTC data channels.
//   - The host's browser owns the game state and validates every move.
//   - Guests connect straight to the host (peer-to-peer); no game server.
//   - NAT traversal uses Google's public STUN servers (see RTC_CONFIG).
//   - Peer discovery/signaling uses the free PeerJS cloud broker, because
//     GitHub Pages can only serve static files.

import {
  PROTO,
  MIN_PLAYERS,
  MAX_PLAYERS,
  MISSIONS,
  EQUIPMENT,
  missionByKey,
  newMatch,
  applyMove,
  viewFor,
  botChoose,
  markDisconnected,
  markReconnected,
  markBotTakeover,
  markSeatClaimed,
  markSeatResigned,
} from './game.js';
import { initSettings } from '../common/settings.js';
import '../common/version.js';

// The ⚙ drawer (bottom-left): live-tunable pacing for testing. Defaults
// reproduce the shipped behavior exactly; overrides stay in this browser.
const cfg = initSettings('bmb', [
  { key: 'botPlay', label: 'Bot turn delay', def: [2600, 1600], section: 'Host pacing', host: true },
  { key: 'bubbleChat', label: 'Chat bubbles linger', def: 6500, section: 'Bubbles & banners' },
  { key: 'bubbleTrunc', label: 'Bubble text cap', def: 84, min: 12, max: 400, step: 4, unit: 'ch', ms: false, section: 'Bubbles & banners' },
  { key: 'flashMs', label: 'Banner duration', def: 1700, section: 'Bubbles & banners' },
  { key: 'overlayDelay', label: 'Result screen delay', def: 4800, section: 'Overlays' },
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
const ID_PREFIX = 'bmb-v1-';
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

// control characters would let a prankster smuggle cursor tricks into names;
// the class is built from char codes so the source file stays plain ASCII
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

// value text with the 6/9 underline convention
function valSpan(v) {
  return el('span', v === 6 || v === 9 ? 'u69' : '', String(v));
}

function showScreen(name) {
  for (const s of document.querySelectorAll('.screen')) {
    s.classList.toggle('hidden', s.id !== `screen-${name}`);
  }
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

function boomFlash() {
  const b = $('#boomflash');
  b.classList.add('hidden');
  void b.offsetWidth;
  b.classList.remove('hidden');
  setTimeout(() => b.classList.add('hidden'), 1600);
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

// Chat also floats briefly over the sender's seat. Kept in a map (not the DOM)
// so bubbles survive the re-render that every state update triggers.
const chatBubbles = new Map();

function paintChatBubbles() {
  // Bubbles live on a fixed overlay so seat re-renders never destroy them
  // (no flicker) and no container can clip them.
  let layer = document.querySelector('#bubble-layer');
  if (!layer) {
    layer = el('div', '');
    layer.id = 'bubble-layer';
    document.body.append(layer);
    window.addEventListener('scroll', paintChatBubbles, { passive: true });
    window.addEventListener('resize', paintChatBubbles);
  }
  const seen = new Set();
  for (const [seat, b] of chatBubbles) {
    const host = document.querySelector(`.seat[data-seat="${seat}"]`) || document.querySelector(`.seat-row[data-seat="${seat}"]`);
    if (!host || !host.offsetParent) continue;
    const key = String(seat);
    seen.add(key);
    let bub = layer.querySelector(`.chat-bubble[data-seat="${key}"]`);
    if (!bub) {
      bub = el('div', 'chat-bubble', b.text);
      bub.dataset.seat = key;
      layer.append(bub);
    } else if (bub.textContent !== b.text) {
      bub.textContent = b.text;
    }
    bub.classList.toggle('say', !!b.say);
    const r = host.getBoundingClientRect();
    bub.style.left = `${Math.round(r.left + r.width / 2)}px`;
    bub.style.top = `${Math.round(Math.max(r.top, bub.offsetHeight + 14))}px`;
  }
  for (const n of layer.querySelectorAll('.chat-bubble')) {
    if (!seen.has(n.dataset.seat)) n.remove();
  }
}

function showChatBubble(m) {
  if (m.seat == null) return;
  const prev = chatBubbles.get(m.seat);
  if (prev) clearTimeout(prev.timer);
  chatBubbles.set(m.seat, {
    text: m.text.length > cfg.raw('bubbleTrunc') ? `${m.text.slice(0, cfg.raw('bubbleTrunc'))}…` : m.text,
    timer: setTimeout(() => {
      chatBubbles.delete(m.seat);
      paintChatBubbles();
    }, cfg('bubbleChat')),
  });
  paintChatBubbles();
}

function clearChatBubbles() {
  for (const b of chatBubbles.values()) clearTimeout(b.timer);
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
    this.missionKey = 'standard';
    this.prevCaptain = null;
    this.botTimer = null;
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
      if (markDisconnected(this.G, seat)) toast(`${p.name} disconnected — the mission waits for them`);
      this.broadcast();
    }
  }

  // The squad stalls on a disconnected player's turn until they return —
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
    if (!this.claimOk(w, seat)) return err("You have already seen this rack from another player's view \u2014 you can only take the seat you have been watching from the start.");
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

  // A claimant may not have shoulder-surfed anyone else's hidden cards —
  // the seat they take must be the only view they have ever had.
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
          ...viewFor(this.G, w.target, this.code),
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

  setMission(key) {
    if (this.G) return;
    this.missionKey = missionByKey(key).key;
    this.pushLobby();
  }

  // Whose input the game is waiting for right now.
  actorOf() {
    const g = this.G;
    if (!g) return null;
    if (g.phase === 'setup') return g.setupQueue[g.setupIdx];
    if (g.phase !== 'playing') return null;
    if (g.pending) return g.pending.seat;
    return g.turn;
  }

  // No bots in this game — but a co-op mission cannot go on without a player's
  // rack. If the host hands a disconnected player's seat to a bot, the same
  // brain the tests use plays it until they return.
  scheduleBots() {
    clearTimeout(this.botTimer);
    if (!this.G) return;
    const actor = this.actorOf();
    if (actor == null) return;
    if (!this.seatCovered(actor)) return;
    this.botTimer = setTimeout(() => {
      if (!this.G) return;
      const seat = this.actorOf();
      if (seat == null) return;
      if (!this.seatCovered(seat)) return;
      const g = this.G;
      const res = applyMove(g, seat, botChoose(g, seat) || {});
      if (!res.ok) {
        // never stall the squad: fall back to the plainest legal action
        if (g.phase === 'setup') {
          const t = g.stands.flatMap((s) => (s.owner === seat ? s.tiles : [])).find((q) => q.kind === 'blue' && !q.cut);
          if (t) applyMove(g, seat, { kind: 'mark', tileId: t.id });
        } else if (g.pending && g.pending.seat === seat) {
          applyMove(g, seat, { kind: 'choose', tileId: g.pending.validIds[0] });
        }
      }
      this.broadcast();
    }, Math.max(cfg.range('botPlay'), this.bannerUntil ? this.bannerUntil - Date.now() : 0));
  }

  lobbyMsg() {
    return {
      t: 'lobby',
      code: this.code,
      watchers: this.watchers.map((x) => x.name),
      players: this.roster.map((p) => ({ seat: p.seat, name: p.name })),
      min: MIN_PLAYERS,
      max: MAX_PLAYERS,
      mission: this.missionKey,
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
    if (this.roster.length < MIN_PLAYERS) {
      toast(`Need at least ${MIN_PLAYERS} players`);
      return;
    }
    this.G = newMatch(this.roster, this.missionKey, this.prevCaptain);
    this.prevCaptain = this.G.captain;
    this.broadcast();
  }

  retry() {
    if (!this.G || this.G.phase === 'playing' || this.G.phase === 'setup') return;
    this.roster = this.roster.filter((p) => p.connected);
    if (this.roster.length < MIN_PLAYERS) {
      this.toLobby();
      toast('Not enough players — back to the lobby');
      return;
    }
    this.G = newMatch(this.roster, this.missionKey, this.prevCaptain);
    this.prevCaptain = this.G.captain;
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

  broadcast() {
    if (this.G && this.G.fx && this.G.fx.seq !== this._bannerFxSeen) {
      this._bannerFxSeen = this.G.fx.seq;
      const fk = this.G.fx.kind;
      if (fk === 'save' || fk === 'boom' || fk === 'won') {
        this.bannerUntil = Math.max(this.bannerUntil || 0, Date.now() + cfg('flashMs'));
      }
    }
    const wnames = this.watchers.map((x) => x.name);
    for (const [seat, conn] of this.conns) {
      try {
        conn.send({ t: 'state', view: { ...viewFor(this.G, seat, this.code), watchers: wnames } });
      } catch {}
    }
    for (const w of this.watchers) this.sendWatcher(w);
    pendingMove = false;
    resetChoice();
    showScreen('game');
    renderGame({ ...viewFor(this.G, 0, this.code), watchers: wnames }, this);
    this.scheduleBots();
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
    clearTimeout(this.botTimer);
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
            full: 'That squad is full (5 players max).',
            'in-progress': 'That mission has already started.',
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
        resetChoice();
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

const REJOIN_KEY = 'bmb-rejoin';

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
  for (let i = 0; i < lob.max; i++) {
    const p = lob.players[i];
    const row = el('li', `seat-row${p ? '' : ' empty'}`);
    if (p) {
      row.append(avatarEl(p.name, p.seat));
      row.append(el('span', 'seat-name', p.name));
      if (p.seat === 0) row.append(el('span', 'chip', 'host'));
      if (p.seat === mySeat) row.append(el('span', 'chip you', 'you'));
    } else {
      row.append(el('div', 'av empty', '·'), el('span', 'seat-name dim', 'Empty seat'));
    }
    list.append(row);
  }

  const mp = $('#mission-picker');
  mp.replaceChildren();
  for (const m of MISSIONS) {
    const b = el('button', `mission-pick${m.key === lob.mission ? ' on' : ''}`, m.name);
    b.type = 'button';
    b.disabled = !sess.isHost;
    if (sess.isHost) b.addEventListener('click', () => sess.setMission(m.key));
    mp.append(b);
  }
  $('#mission-blurb').textContent = missionByKey(lob.mission).blurb;

  $('#btn-start').classList.toggle('hidden', !sess.isHost);
  if (sess.isHost) {
    $('#btn-start').disabled = lob.players.length < lob.min;
  }
  const n = lob.players.length;
  $('#lobby-hint').textContent = sess.isHost
    ? n < lob.min
      ? 'Share the code or invite link — the squad needs at least one more expert.'
      : `${n} in the squad — you can afford ${n - 1} wrong call${n === 2 ? '' : 's'}. Good luck!`
    : 'Waiting for the host to start the mission…';
}

// ---------------------------------------------------------------- view helpers
// (pure functions over the personalized view — guests never see hidden info)

function myStands(view) {
  return view.stands.filter((s) => s.owner === view.you);
}

function myHidden(view) {
  return myStands(view).flatMap((s) => s.tiles.filter((t) => !t.cut && !t.revealed));
}

function myValueList(view) {
  const out = [];
  for (const t of myHidden(view)) {
    const v = t.kind === 'blue' ? t.v : t.kind === 'yellow' ? 'yellow' : null;
    if (v != null && !out.includes(v)) out.push(v);
  }
  return out.sort((a, b) => (a === 'yellow' ? 1 : b === 'yellow' ? -1 : a - b));
}

function myCopiesOf(view, value) {
  return myHidden(view).filter((t) =>
    value === 'yellow' ? t.kind === 'yellow' : t.kind === 'blue' && t.v === value,
  );
}

function mySoloOptions(view) {
  const opts = [];
  const byV = {};
  for (const t of myHidden(view)) if (t.kind === 'blue') byV[t.v] = (byV[t.v] || 0) + 1;
  for (const v of Object.keys(byV).map(Number)) {
    const remaining = 4 - (view.cutCount[v] || 0);
    if (byV[v] === remaining && (remaining === 2 || remaining === 4)) opts.push(v);
  }
  const yellows = myHidden(view).filter((t) => t.kind === 'yellow').length;
  if (yellows > 0 && yellows === view.mission.yellow - view.yellowCut) opts.push('yellow');
  return opts;
}

function canRevealReds(view) {
  const mine = myHidden(view);
  return mine.length > 0 && mine.every((t) => t.kind === 'red');
}

function seatName(view, seat) {
  const p = view.players.find((q) => q.seat === seat);
  return p ? p.name : '?';
}

function equipUsable(view, key) {
  const e = (view.equipment || []).find((q) => q.key === key);
  return e && e.unlocked && !e.used;
}

// ---------------------------------------------------------------- choice state

// mode: how the current cut is being aimed.
//   'plain' 1 wire · 'char' 2 wires · 'triple' 3 wires · 'super' whole stand ·
//   'xy' 1 wire 2 values · 'radar' pick a value
let choice = { mode: 'plain', standId: null, tileIds: [], values: [], ownPick: {}, markId: null };

function resetChoice() {
  choice = { mode: 'plain', standId: null, tileIds: [], values: [], ownPick: {}, markId: null };
}

function targetsNeeded(view) {
  if (choice.mode === 'char') return 2;
  if (choice.mode === 'triple') {
    const stand = view.stands.find((s) => s.id === choice.standId);
    if (!stand) return 3;
    return Math.min(3, stand.tiles.filter((t) => !t.cut && !t.revealed).length);
  }
  if (choice.mode === 'super') return 0;
  return 1;
}

function valuesNeeded() {
  return choice.mode === 'xy' ? 2 : 1;
}

function setMode(mode) {
  const again = choice.mode === mode && mode !== 'plain';
  resetChoice();
  choice.mode = again ? 'plain' : mode;
  if (lastView) renderGame(lastView, session);
}

function toggleTarget(view, standId, tileId) {
  if (choice.standId !== standId) {
    choice.standId = standId;
    choice.tileIds = [];
  }
  if (choice.mode === 'super') {
    choice.tileIds = [];
    if (lastView) renderGame(lastView, session);
    return;
  }
  const i = choice.tileIds.indexOf(tileId);
  if (i >= 0) choice.tileIds.splice(i, 1);
  else {
    choice.tileIds.push(tileId);
    const need = targetsNeeded(view);
    while (choice.tileIds.length > need) choice.tileIds.shift();
  }
  if (lastView) renderGame(lastView, session);
}

function toggleValue(view, v) {
  const i = choice.values.indexOf(v);
  if (i >= 0) choice.values.splice(i, 1);
  else {
    choice.values.push(v);
    while (choice.values.length > valuesNeeded()) choice.values.shift();
  }
  for (const k of Object.keys(choice.ownPick)) {
    if (!choice.values.map(String).includes(k)) delete choice.ownPick[k];
  }
  if (lastView) renderGame(lastView, session);
}

function readyToCut(view) {
  if (choice.mode === 'radar') return false;
  if (choice.standId == null) return false;
  if (choice.mode !== 'super' && choice.tileIds.length !== targetsNeeded(view)) return false;
  if (choice.values.length !== valuesNeeded()) return false;
  return true;
}

function sendCut() {
  const move = {
    kind: 'cut',
    standId: choice.standId,
    tileIds: choice.tileIds,
    values: choice.values,
    ownPick: choice.ownPick,
  };
  if (choice.mode !== 'plain') move.equip = choice.mode;
  sendMove(move);
}

// ---------------------------------------------------------------- tiles

// which values the pending "called" label allows (e.g. "7", "YELLOW", "3 or 7")
function calledValues(called) {
  return String(called == null ? '' : called)
    .split(' or ')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => (x.toUpperCase() === 'YELLOW' ? 'yellow' : Number(x)));
}

function tileMatchesCalled(t, called) {
  return calledValues(called).some((v) =>
    v === 'yellow' ? t.kind === 'yellow' : t.kind === 'blue' && t.v === v,
  );
}

function buildWire(t, standId) {
  const b = el('button', 'wire');
  b.type = 'button';
  b.dataset.id = String(t.id);
  b.append(el('span', 'face'));
  b.addEventListener('click', () => onWireClick(standId, t.id));
  return b;
}

function patchWire(node, t, view, ctx) {
  const classes = ['wire'];
  let face;
  if (t.kind === 'blue') {
    classes.push('blue');
    face = [valSpan(t.v)];
  } else if (t.kind === 'yellow') {
    classes.push('yellow');
    face = [el('span', '', 'Y'), el('span', 'sub', t.v != null ? `${t.v}·1` : '')];
  } else if (t.kind === 'red') {
    classes.push('red');
    face = [el('span', '', '☠'), el('span', 'sub', t.v != null ? `${t.v}·5` : '')];
  } else if (t.knownRed) {
    classes.push('knownred');
    face = [el('span', '', '⚠')];
  } else {
    classes.push('back');
    face = [];
  }
  if (t.cut) classes.push('cut');
  if (t.revealed) classes.push('revealed');
  if (view.result && view.result.tileId === t.id) classes.push('boomed');
  if (ctx.choosable) classes.push('choosable');
  if (ctx.ownMatch) {
    classes.push('ownmatch');
    if (choice.ownPick[ctx.ownMatchValue] === t.id) classes.push('ownpick');
  }
  const selected =
    (choice.mode === 'super' && !ctx.mine && ctx.standId === choice.standId && !t.cut && !t.revealed) ||
    choice.tileIds.includes(t.id) ||
    choice.markId === t.id;
  if (selected) classes.push('sel');
  const clickable = ctx.targetable || ctx.choosable || ctx.ownMatch || ctx.markable;
  if (clickable) classes.push('can');
  node.className = classes.join(' ');
  node.disabled = !clickable;

  const faceEl = node.querySelector('.face');
  faceEl.replaceChildren(...face);

  let tok = node.querySelector('.tok');
  if (t.token != null) {
    if (!tok) {
      tok = el('span', 'tok');
      node.append(tok);
    }
    tok.className = `tok${t.token === 'yellow' ? ' yellow' : ''}`;
    tok.textContent = t.token === 'yellow' ? 'Y' : String(t.token);
    tok.title = t.token === 'yellow' ? 'Info token: this wire is YELLOW' : `Info token: this wire is a ${t.token}`;
  } else if (tok) {
    tok.remove();
  }
}

// keyed stand rendering: tile buttons are created once and patched in place,
// so hover/focus never flickers when a broadcast arrives
function renderStand(container, stand, view) {
  let box = container.querySelector(`.stand[data-stand="${stand.id}"]`);
  if (!box) {
    box = el('div', 'stand');
    box.dataset.stand = String(stand.id);
    if (stand.label) box.append(el('span', 'stand-label', stand.label));
    for (const t of stand.tiles) box.append(buildWire(t, stand.id));
    container.append(box);
  }
  const mine = stand.owner === view.you;
  const isMyCutTurn =
    view.phase === 'playing' && view.turn === view.you && !view.pending && choice.mode !== 'radar';
  const isMyMarkTurn = view.phase === 'setup' && view.setupTurn === view.you;
  const pendingMine = view.pending && view.pending.seat === view.you;
  const pointedSet = pendingMine ? new Set(view.pending.tileIds) : null;

  for (const t of stand.tiles) {
    const node = box.querySelector(`.wire[data-id="${t.id}"]`);
    if (!node) continue;
    const uncut = !t.cut && !t.revealed;
    let choosable = false;
    if (pendingMine && mine && uncut && pointedSet.has(t.id)) {
      choosable =
        view.pending.type === 'chooseCut' ? tileMatchesCalled(t, view.pending.called) : t.kind !== 'red';
    }
    let ownMatch = false;
    let ownMatchValue = null;
    if (mine && isMyCutTurn && uncut && t.kind) {
      const v = t.kind === 'blue' ? t.v : t.kind === 'yellow' ? 'yellow' : null;
      if (v != null && choice.values.includes(v) && myCopiesOf(view, v).length > 1) {
        ownMatch = true;
        ownMatchValue = String(v);
      }
    }
    patchWire(node, t, view, {
      mine,
      standId: stand.id,
      targetable: !mine && isMyCutTurn && uncut,
      choosable,
      ownMatch,
      ownMatchValue,
      markable: mine && isMyMarkTurn && uncut && t.kind === 'blue',
    });
  }
}

function onWireClick(standId, tileId) {
  const view = lastView;
  if (!view || !session) return;
  const stand = view.stands.find((s) => s.id === standId);
  const t = stand && stand.tiles.find((q) => q.id === tileId);
  if (!t) return;
  const mine = stand.owner === view.you;

  if (view.phase === 'setup') {
    if (view.setupTurn === view.you && mine && t.kind === 'blue' && !t.cut) {
      choice.markId = choice.markId === tileId ? null : tileId;
      renderGame(view, session);
    }
    return;
  }
  if (view.pending && view.pending.seat === view.you) {
    if (mine && view.pending.tileIds.includes(tileId)) sendMove({ kind: 'choose', tileId });
    return;
  }
  if (view.phase !== 'playing' || view.turn !== view.you || choice.mode === 'radar') return;
  if (mine) {
    const v = t.kind === 'blue' ? t.v : t.kind === 'yellow' ? 'yellow' : null;
    if (v != null && choice.values.includes(v)) {
      choice.ownPick[String(v)] = tileId;
      renderGame(view, session);
    }
    return;
  }
  if (t.cut || t.revealed) return;
  toggleTarget(view, standId, tileId);
}

// ---------------------------------------------------------------- board

function renderStrip(view) {
  const strip = $('#strip');
  let cells = strip.querySelector('.strip-cells');
  if (!cells) {
    cells = el('div', 'strip-cells');
    strip.append(cells);
    for (let v = 1; v <= 12; v++) {
      const c = el('div', 'cell');
      c.dataset.v = String(v);
      const cv = el('div', 'cv');
      cv.append(valSpan(v));
      c.append(cv);
      const pips = el('div', 'pips');
      for (let i = 0; i < 4; i++) pips.append(el('span', 'pip'));
      c.append(pips);
      cells.append(c);
    }
    strip.append(el('div', 'gapmarks'));
  }
  for (let v = 1; v <= 12; v++) {
    const c = cells.querySelector(`.cell[data-v="${v}"]`);
    const n = view.cutCount[v] || 0;
    c.classList.toggle('done', n >= 4);
    c.querySelectorAll('.pip').forEach((p, i) => p.classList.toggle('on', i < n));
    c.title = `${n} of 4 cut`;
  }
  const marks = strip.querySelector('.gapmarks');
  marks.replaceChildren();
  for (const r of view.boardRed || []) {
    if (r.v >= 12) continue;
    const m = el('span', 'gapmark red', `R${r.sure ? '' : '?'}`);
    m.style.gridColumn = String(r.v);
    m.title = r.sure
      ? `A RED wire sorts between the ${r.v}s and the ${r.v + 1}s — never cut it`
      : `MAYBE a red wire between the ${r.v}s and the ${r.v + 1}s — only ${view.mission.red} of the "?" values are really in the bomb`;
    marks.append(m);
  }
  for (const y of view.boardYellow || []) {
    if (y.v >= 12) continue;
    const m = el('span', 'gapmark yellow', 'Y');
    m.style.gridColumn = String(y.v);
    m.title = `A YELLOW wire sorts between the ${y.v}s and the ${y.v + 1}s — cut it by calling "yellow"`;
    marks.append(m);
  }
}

function renderDial(view) {
  const dial = $('#dial');
  const { pos, size } = view.dial;
  dial.replaceChildren();
  dial.append(el('span', 'dlabel', 'Detonator'));
  for (let i = 0; i < size; i++) dial.append(el('span', `seg${i < pos ? ' lit' : ''}`));
  dial.append(el('span', 'seg skull', '☠'));
  const left = size - pos;
  dial.append(
    el('span', 'dleft', view.phase === 'lost' ? 'BOOM' : `${left} wrong call${left === 1 ? '' : 's'} to BOOM`),
  );
  dial.classList.toggle('hot', view.phase !== 'lost' && left <= 1);
}

function renderEquipment(view) {
  const box = $('#equipment');
  box.replaceChildren();
  const myTurn = view.phase === 'playing' && view.turn === view.you && !view.pending;
  for (const e of view.equipment || []) {
    const b = el('button', 'eq');
    b.type = 'button';
    b.classList.add(e.used ? 'used' : e.unlocked ? 'ready' : 'locked');
    if (['triple', 'super', 'xy'].includes(e.key) && choice.mode === e.key) b.classList.add('on');
    const head = el('div');
    const vv = el('span', 'eqv');
    vv.append(valSpan(e.v));
    head.append(vv);
    b.append(head);
    b.append(el('span', 'eqn', e.name));
    b.append(
      el(
        'span',
        'eqs',
        e.used
          ? 'used up'
          : e.unlocked
            ? e.key === 'stab'
              ? 'armed — absorbs one blast'
              : e.key === 'radar'
                ? 'ready — anytime, free'
                : 'ready — on your turn'
            : `cut two ${e.v}s to unlock`,
      ),
    );
    b.title = e.text;
    const clickable = e.unlocked && !e.used && (e.key === 'radar' || (myTurn && ['triple', 'super', 'xy'].includes(e.key)));
    b.disabled = !clickable;
    if (clickable) b.addEventListener('click', () => setMode(e.key === 'radar' ? 'radar' : e.key));
    box.append(b);
  }
}

// ---------------------------------------------------------------- seats

function seatPanel(container, view, p) {
  let panel = container.querySelector(`.seat[data-seat="${p.seat}"]`);
  if (!panel) {
    panel = el('div', 'seat');
    panel.dataset.seat = String(p.seat);
    const head = el('div', 'seat-head');
    head.append(avatarEl(p.name, p.seat));
    head.append(el('span', 'nm', p.seat === view.you ? `${p.name} (you)` : p.name));
    head.append(el('span', 'seat-note'));
    head.append(el('div', 'right'));
    panel.append(head);
    panel.append(el('div', 'stands'));
    container.append(panel);
  }
  const isActor =
    (view.phase === 'setup' && view.setupTurn === p.seat) ||
    (view.phase === 'playing' && !view.pending && view.turn === p.seat) ||
    (view.pending && view.pending.seat === p.seat);
  panel.classList.toggle('turn', !!isActor);
  panel.classList.toggle('offline', !p.connected);

  // seat notes describe what OTHER players last did — never your own actions
  panel.querySelector('.seat-note').textContent = p.seat !== view.you && p.lastAction ? `· ${p.lastAction}` : '';

  const right = panel.querySelector('.right');
  right.replaceChildren();
  if (!p.connected) right.append(el('span', 'tag', 'offline'));
  if (view.captain === p.seat) right.append(el('span', 'tag', 'captain'));
  right.append(el('span', `tag char${p.usedChar ? ' spent' : ''}`, '2× detector'));
  if (p.tilesLeft === 0) right.append(el('span', 'tag done', 'clear'));
  else right.append(el('span', 'tag', `${p.tilesLeft} wire${p.tilesLeft === 1 ? '' : 's'}`));
  if (isActor) {
    right.append(
      el(
        'span',
        'tag turn',
        view.phase === 'setup' ? 'marking' : view.pending && view.pending.seat === p.seat ? 'choosing' : 'their turn',
      ),
    );
  }

  const standsBox = panel.querySelector('.stands');
  for (const s of view.stands) {
    if (s.owner !== p.seat) continue;
    renderStand(standsBox, s, view);
  }
}

// ---------------------------------------------------------------- action bar

function pickBtn(label, opts = {}) {
  const b = el('button', `pick${opts.cls ? ` ${opts.cls}` : ''}`);
  b.type = 'button';
  if (label instanceof Node) b.append(label);
  else b.textContent = label;
  if (opts.on) b.classList.add('on');
  if (opts.disabled) b.disabled = true;
  if (opts.title) b.title = opts.title;
  if (opts.click) b.addEventListener('click', opts.click);
  return b;
}

function valueBtnLabel(v) {
  if (v === 'yellow') return 'YELLOW';
  const s = el('span');
  s.append(valSpan(v));
  return s;
}

function renderActionBar(view) {
  const bar = $('#action-bar');
  bar.replaceChildren();
  const row = () => {
    const r = el('div', 'abar-row');
    bar.append(r);
    return r;
  };

  if (view.phase === 'won' || view.phase === 'lost') {
    row().append(
      el(
        'span',
        'abar-label',
        view.phase === 'won' ? 'Bomb defused. Breathe.' : 'The bomb went off — the racks are face up for the post-mortem.',
      ),
    );
    return;
  }

  const radarReady = equipUsable(view, 'radar');

  if (view.phase === 'setup') {
    if (view.setupTurn === view.you) {
      row().append(el('span', 'abar-label', 'Setup: mark ONE of your blue wires — a free, truthful clue for the squad.'));
      row().append(
        pickBtn('Mark this wire', {
          cls: 'go',
          disabled: choice.markId == null,
          click: () => sendMove({ kind: 'mark', tileId: choice.markId }),
        }),
      );
    } else {
      row().append(el('span', 'abar-label', `${seatName(view, view.setupTurn)} is marking a wire for the squad…`));
    }
    return;
  }

  if (view.pending) {
    if (view.pending.seat === view.you) {
      row().append(
        el(
          'span',
          'abar-label',
          view.pending.type === 'chooseCut'
            ? `A hit! Click which of your pointed wires gets cut — it must really be a ${view.pending.called}.`
            : 'All wrong — click one of the pointed wires to mark with an Info token (never a red one).',
        ),
      );
    } else {
      row().append(el('span', 'abar-label', `${seatName(view, view.pending.seat)} is choosing a wire…`));
    }
    return;
  }

  const myTurn = view.turn === view.you;

  if (choice.mode === 'radar') {
    row().append(
      el('span', 'abar-label', '📡 General Radar — name a value; everyone answers whether they still hold one. Free, does not use a turn.'),
    );
    const r2 = row();
    for (let v = 1; v <= 12; v++) {
      const spent = (view.cutCount[v] || 0) >= 4;
      r2.append(
        pickBtn(valueBtnLabel(v), {
          disabled: spent,
          title: spent ? 'all four already cut' : '',
          click: () => sendMove({ kind: 'radar', value: v }),
        }),
      );
    }
    r2.append(pickBtn('Cancel', { cls: 'mode', click: () => setMode('radar') }));
    return;
  }

  if (!myTurn) {
    const r = row();
    r.append(el('span', 'abar-label', `${seatName(view, view.turn)}'s turn — watch the racks.`));
    if (radarReady) r.append(pickBtn('📡 Radar sweep', { cls: 'mode', click: () => setMode('radar') }));
    return;
  }

  // ---- my turn -----------------------------------------------------------
  const me = view.players.find((q) => q.seat === view.you);
  const modeRow = row();
  modeRow.append(el('span', 'abar-label', 'Your turn — cut with:'));
  modeRow.append(pickBtn('1 wire', { cls: 'mode', on: choice.mode === 'plain', click: () => setMode('plain') }));
  if (me && !me.usedChar) {
    modeRow.append(
      pickBtn('Double Detector · 2 wires', {
        cls: 'mode',
        on: choice.mode === 'char',
        title: 'Once per mission: point at 2 wires in one stand, call one value — cuts if either matches.',
        click: () => setMode('char'),
      }),
    );
  }
  if (equipUsable(view, 'triple')) {
    modeRow.append(pickBtn('Triple Detector · 3 wires', { cls: 'mode', on: choice.mode === 'triple', click: () => setMode('triple') }));
  }
  if (equipUsable(view, 'super')) {
    modeRow.append(pickBtn('Super Detector · whole stand', { cls: 'mode', on: choice.mode === 'super', click: () => setMode('super') }));
  }
  if (equipUsable(view, 'xy')) {
    modeRow.append(pickBtn('X or Y Ray · 2 values', { cls: 'mode', on: choice.mode === 'xy', click: () => setMode('xy') }));
  }
  if (radarReady) modeRow.append(pickBtn('📡 Radar', { cls: 'mode', click: () => setMode('radar') }));

  const need = targetsNeeded(view);
  const targetsOk = choice.mode === 'super' ? choice.standId != null : choice.tileIds.length === need;
  row().append(
    el(
      'span',
      'abar-label',
      targetsOk
        ? 'Now call the value — you can only call what you hold:'
        : choice.mode === 'super'
          ? 'Click any wire in a teammate’s stand to aim at the WHOLE stand.'
          : `Click ${need} wire${need === 1 ? '' : 's'} in a teammate’s stand${choice.mode === 'char' || choice.mode === 'triple' ? ' (same stand)' : ''}.`,
    ),
  );

  const vals = myValueList(view);
  const vRow = row();
  for (const v of vals) {
    if (v === 'yellow' && choice.mode !== 'plain') continue; // detectors call numbers only
    vRow.append(pickBtn(valueBtnLabel(v), { on: choice.values.includes(v), click: () => toggleValue(view, v) }));
  }
  if (choice.mode === 'xy') vRow.append(el('span', 'abar-label', '— pick two'));

  const multi = choice.values.filter((v) => myCopiesOf(view, v).length > 1);
  if (multi.length) {
    row().append(el('span', 'abar-label', 'You hold several — your matching wires glow; click one to choose which is cut on success.'));
  }

  const goRow = row();
  if (readyToCut(view)) {
    const vtxt = choice.values.map((v) => (v === 'yellow' ? 'YELLOW' : v)).join(' or ');
    const label = choice.mode === 'super' ? `Sweep the stand for a ${vtxt}!` : `Cut — it's a ${vtxt}!`;
    goRow.append(pickBtn(label, { cls: 'go', click: sendCut }));
    goRow.append(pickBtn('Reset', { cls: 'mode', click: () => setMode('plain') }));
  }
  for (const v of mySoloOptions(view)) {
    const copies = myCopiesOf(view, v).length;
    goRow.append(
      pickBtn(
        v === 'yellow'
          ? `Solo cut: ${copies > 1 ? `all ${copies} yellows` : 'the last yellow'}`
          : `Solo cut: ${copies === 4 ? 'all four' : 'both'} ${v}s`,
        {
          cls: 'solo',
          title: 'Always safe: these are the only copies left, and they are all yours.',
          click: () => sendMove({ kind: 'solo', value: v }),
        },
      ),
    );
  }
  if (canRevealReds(view)) {
    goRow.append(
      pickBtn('Reveal my red wires', {
        cls: 'danger',
        title: 'Only reds left — show them safely and you are done.',
        click: () => sendMove({ kind: 'reveal' }),
      }),
    );
  }
}

// ---------------------------------------------------------------- main render

// While a human is disconnected mid-game the squad stalls; tell everyone
// why, and give the host the remedy (hand the seat to a bot).
// Observers shadow one player's view; pin a bar naming whose eyes they are
// borrowing, with buttons to switch player.
function renderObBar(view, sess) {
  let bar = $('#ob-bar');
  const on = !!view.observer;
  if (!bar) {
    if (!on) return;
    bar = el('div', '');
    bar.id = 'ob-bar';
    const anchor = $('#action-bar');
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
    const anchor = $('#action-bar');
    anchor.parentNode.insertBefore(bar, anchor);
  }
  bar.replaceChildren();
  const live = view.phase === 'setup' || view.phase === 'playing';
  const gone = live ? view.players.filter((p) => !p.connected && !p.bot) : [];
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
            : `⚠️ ${p.name} lost connection — the mission is waiting for them.`,
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

function renderGame(view, sess) {
  lastView = view;
  renderDcBanner(view, sess);
  renderObBar(view, sess);
  renderWatchChip(view);
  ensureResignBtn(sess);
  $('#room-chip').textContent = view.code || '·····';
  $('#mission-chip').textContent = `${view.mission.name} · ${view.mission.red} red · ${view.mission.yellow} yellow`;

  renderStrip(view);
  renderDial(view);
  renderEquipment(view);

  const table = $('#table');
  const myZone = $('#my-zone');
  const me = view.players.find((p) => p.seat === view.you);
  const others = view.players.filter((p) => p.seat !== view.you);
  others.sort((a, b) => ((a.seat - view.you + 64) % 64) - ((b.seat - view.you + 64) % 64));
  for (const panel of [...table.querySelectorAll('.seat')]) {
    if (!others.some((p) => String(p.seat) === panel.dataset.seat)) panel.remove();
  }
  for (const p of others) seatPanel(table, view, p);
  if (me) {
    for (const panel of [...myZone.querySelectorAll('.seat')]) {
      if (panel.dataset.seat !== String(me.seat)) panel.remove();
    }
    seatPanel(myZone, view, me);
  }

  renderActionBar(view);
  renderLog(view);
  paintChatBubbles();

  if (view.fx && view.fx.seq !== lastFxSeq) {
    lastFxSeq = view.fx.seq;
    const fx = view.fx;
    if (fx.kind === 'cut' || fx.kind === 'reveal') {
      for (const id of fx.tiles || []) {
        const n = document.querySelector(`.wire[data-id="${id}"]`);
        if (n) {
          n.classList.add('fx-cut');
          setTimeout(() => n.classList.remove('fx-cut'), 950);
        }
      }
    } else if (fx.kind === 'fail') {
      for (const id of fx.tiles || []) {
        const n = document.querySelector(`.wire[data-id="${id}"]`);
        if (n) {
          n.classList.add('fx-fail');
          setTimeout(() => n.classList.remove('fx-fail'), 600);
        }
      }
      const dial = $('#dial');
      dial.classList.remove('tick');
      void dial.offsetWidth;
      dial.classList.add('tick');
    } else if (fx.kind === 'save') {
      flash('STABILIZATOR!', 'gold');
    } else if (fx.kind === 'boom') {
      boomFlash();
      flash('BOOM', 'bad');
    } else if (fx.kind === 'won') {
      flash('BOMB DEFUSED', 'gold');
    } else if (fx.kind === 'radar') {
      toast(`📡 Radar sweep on ${fx.v} — see the log`);
    }
  }

  settleOverlay('#result', view.phase === 'won' || view.phase === 'lost', () => showResult(view, sess));
}

// ---------------------------------------------------------------- log

let logLines = [];
let logMid = null;

function renderLog(view) {
  // keyed per mission, so a retry starts from an empty panel
  const key = String(view.mid);
  if (key !== logMid) {
    logMid = key;
    logLines = [];
    $('#feed').replaceChildren();
  }
  const have = new Set(logLines.map((l) => l.n));
  let added = false;
  for (const item of view.log || []) {
    if (item && typeof item === 'object' && !have.has(item.n)) {
      logLines.push(item);
      added = true;
    }
  }
  if (!added && logLines.length === $('#feed').children.length) return;
  logLines.sort((a, b) => a.n - b.n);
  if (logLines.length > 200) logLines = logLines.slice(-200);
  const feed = $('#feed');
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 24;
  feed.replaceChildren(...logLines.map((l) => el('div', 'feed-line', l.text)));
  if (atBottom) feed.scrollTop = feed.scrollHeight;
}

// ---------------------------------------------------------------- result overlay

let confettiDone = false;

function showResult(view, sess) {
  const m = $('#result');
  m.classList.remove('hidden');
  const won = view.phase === 'won';
  $('#res-title').textContent = won ? '💣 Bomb defused!' : '💥 BOOM.';
  const r = view.result || {};
  $('#res-sub').textContent = won
    ? `${view.mission.name} complete — every rack is clear.`
    : r.reason === 'red'
      ? 'A red wire was cut. The racks are face up behind this screen — study them for the retry.'
      : 'The detonator reached the skull. The racks are face up behind this screen.';
  const stats = $('#res-stats');
  stats.replaceChildren();
  const s = view.stats || {};
  const chip = (label, val) => {
    const c = el('span', 'stat-chip');
    c.append(el('b', '', String(val)), el('span', '', ` ${label}`));
    return c;
  };
  stats.append(chip('turns', s.turns || 0), chip('wrong calls', s.errors || 0));
  if (s.saves) stats.append(chip('stabilizator saves', s.saves));
  $('#btn-retry').classList.toggle('hidden', !sess.isHost);
  $('#btn-golobby').classList.toggle('hidden', !sess.isHost);
  $('#res-wait').classList.toggle('hidden', sess.isHost);
  if (won && !confettiDone) {
    confettiDone = true;
    confetti();
  }
}

// Overlays hold back so the final play stays visible for a good while;
// once shown they update instantly.
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

// A hidden tab throttles timers, so reveal any pending result screen as soon
// as the player looks back at the game.
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
  $('#result').classList.add('hidden');
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
  localStorage.setItem('bmb-name', name);
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
  localStorage.setItem('bmb-name', name);
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

function renderEquipRef() {
  const list = $('#equip-ref');
  list.replaceChildren();
  for (const e of EQUIPMENT) {
    const li = el('li');
    li.append(el('b', '', `${e.v} · ${e.name}: `), el('span', '', e.text));
    list.append(li);
  }
}

function init() {
  $('#name-input').value = localStorage.getItem('bmb-name') || '';

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
  $('#btn-retry').addEventListener('click', () => session && session.isHost && session.retry());
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

  for (const b of document.querySelectorAll('.btn-leave')) b.addEventListener('click', leave);
  for (const b of document.querySelectorAll('.btn-rules')) {
    b.addEventListener('click', () => $('#modal-rules').classList.remove('hidden'));
  }
  $('#btn-rules-close').addEventListener('click', () => $('#modal-rules').classList.add('hidden'));
  $('#modal-rules').addEventListener('click', (e) => {
    if (e.target === $('#modal-rules')) $('#modal-rules').classList.add('hidden');
  });

  renderEquipRef();

  window.addEventListener('beforeunload', () => {
    if (session) session.destroy();
  });

  if (typeof Peer === 'undefined') {
    setHomeStatus('Could not load the PeerJS library — multiplayer needs it. Check your connection and refresh.', true);
    setBusy(true);
  }
}

init();
