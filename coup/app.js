// app.js — networking + UI for Coup, with the Reformation expansion.
//
// Topology: host-authoritative star over WebRTC data channels.
//   - The host's browser owns the game and validates every move.
//   - Guests connect straight to the host (peer-to-peer); no game server.
//   - NAT traversal uses Google's public STUN servers (see RTC_CONFIG).
//   - Peer discovery/signaling uses the free PeerJS cloud broker, because
//     GitHub Pages can only serve static files.
// Every player gets their own view: their own two cards, every card face up,
// the coins and every claim made — nothing else. Bots fill empty seats and
// play in the host's browser, and take over for anyone who disconnects.

import {
  PROTO,
  MIN_PLAYERS,
  MAX_PLAYERS,
  CHARS,
  ACTIONS,
  SIDES,
  charsFor,
  copiesFor,
  claimOf,
  blockersOf,
  defaultOpts,
  canStart,
  advice,
  newGame,
  applyMove,
  viewFor,
  botChoose,
  waitingOn,
  legalActions,
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
const cfg = initSettings('cop', [
  { key: 'botAct', label: 'Bot takes its turn after', def: [1500, 1200], section: 'Host pacing', host: true, hint: 'How long a bot thinks before it acts on its turn.' },
  { key: 'botAnswer', label: 'Bot challenge or block delay', def: [550, 650], section: 'Host pacing', host: true, hint: 'Each bot’s pause before it challenges, blocks or lets a claim go.' },
  { key: 'botDecide', label: 'Bot other decisions', def: [900, 700], section: 'Host pacing', host: true, hint: 'A bot proving a claim, choosing a card to lose, exchanging, showing a card.' },
  { key: 'autoAllow', label: 'Let others’ claims go without asking', def: false, bool: true, section: 'Table', hint: 'Answers “let it go” for you whenever a claim is not aimed at you and is not a block of your own action.' },
  { key: 'bubbleChat', label: 'Chat bubbles linger', def: 6500, section: 'Bubbles & banners' },
  { key: 'bubbleTrunc', label: 'Bubble text cap', def: 84, min: 12, max: 400, step: 4, unit: 'ch', ms: false, section: 'Bubbles & banners' },
  { key: 'flashMs', label: 'Banner duration', def: 1900, section: 'Bubbles & banners' },
  { key: 'overlayDelay', label: 'Result screen delay', def: 2600, section: 'Overlays' },
  { key: 'revealBots', label: "Show the bots' cards", def: false, bool: true, section: 'Testing', host: true, hint: 'Shows every bot’s face-down cards at the table, to see why they play as they do. Only the host builds views, so this shows them to everyone.' },
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
const ID_PREFIX = 'cop-v1-';
// families of a city-state's court — none of them a character's title
const BOT_NAMES = ['Lorenzo', 'Isabella', 'Cesare', 'Lucrezia', 'Giovanni', 'Caterina', 'Federico', 'Beatrice', 'Ludovico', 'Bianca'];
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
    this.opts = defaultOpts();
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

  // Characters are secret, so a watcher may take over an abandoned seat only
  // if it is the only view they have ever had — someone who has stood behind
  // another player's chair knows that player's Character.
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

  // The lobby's options: Reformation's Allegiances, the Inquisitor, the
  // two-player variant.
  setOpt(key, value) {
    if (this.G || !(key in defaultOpts()) || typeof value !== 'boolean') return;
    this.opts = { ...this.opts, [key]: value };
    this.pushLobby();
  }

  // The host's clock lets the bots act, one at a time so the table can see
  // who did what: a bot takes its turn, answers a claim, loses a card.
  schedule(ms) {
    clearTimeout(this.tickTimer);
    if (!this.G || this.G.phase === 'over') return;
    this.tickTimer = setTimeout(() => this.tick(), Math.max(20, ms));
  }

  botDelay() {
    const G = this.G;
    if (G.window) return cfg.range(G.window.kind === 'pick' ? 'botDecide' : 'botAnswer');
    return cfg.range(G.ask && G.ask.kind === 'act' ? 'botAct' : 'botDecide');
  }

  tick() {
    const G = this.G;
    if (!G || G.phase === 'over') return;
    // when several bots may answer, any of them may be first
    const covered = waitingOn(G).filter((s) => this.seatCovered(s));
    const seat = covered.length ? covered[Math.floor(Math.random() * covered.length)] : null;
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
    const why = canStart(this.roster.length, this.opts);
    if (why) { toast(why); return; }
    this.G = newGame(this.roster, this.opts);
    this.broadcast();
  }

  again() {
    if (!this.G || this.G.phase !== 'over') return;
    const winner = this.G.winner;
    this.roster = this.roster.filter((p) => p.connected || p.bot);
    if (canStart(this.roster.length, this.opts)) {
      this.toLobby();
      toast('Not enough players — back to the lobby');
      return;
    }
    // "The person who won the last game starts."
    const first = this.roster.findIndex((p) => p.seat === winner);
    this.G = newGame(this.roster, this.opts, { first: first >= 0 ? first : undefined });
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
            full: 'That room is full (10 players max).',
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

const REJOIN_KEY = 'cop-rejoin';

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


// ---------------------------------------------------------------- the cards, as the table shows them

// no art of the publisher's: a sign for each character
const CHAR_ICON = { duke: '👑', assassin: '🗡️', captain: '⚓', ambassador: '🕊️', contessa: '🌹', inquisitor: '🔍' };
const SIDE_ICON = { loyalist: '⚜', reformist: '✊' };
// what a card does, short enough to print on it; the tip has it in full
const SHORT = {
  duke: 'Tax: take 3 coins. Blocks Foreign Aid.',
  assassin: 'Pay 3: a player loses an influence.',
  captain: 'Steal 2 coins. Blocks stealing.',
  ambassador: 'Exchange 2 cards. Blocks stealing.',
  contessa: 'Blocks assassination.',
  inquisitor: 'Exchange 1, or Examine. Blocks stealing.',
};
const charName = (c) => CHARS[c].name;
const the = (c) => `the ${charName(c)}`;
const actName = (t) => ACTIONS[t].name;

function listWords(a) {
  return a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}
const orWords = (a) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} or ${a[a.length - 1]}`);
const coinWords = (k) => `${k} coin${k === 1 ? '' : 's'}`;

// a character card: face down, face up (an influence lost), or one of yours
function cardEl(c, { big = false, mine = false, peek = false } = {}) {
  const d = el('div', `card${big ? ' big' : ''}${c.up ? ' up' : ''}${c.char ? ` ch-${c.char}` : ' back'}${mine ? ' mine' : ''}${peek ? ' peek' : ''}`);
  if (c.char) {
    d.append(el('span', 'card-ic', CHAR_ICON[c.char]), el('span', 'card-name', charName(c.char)));
    if (big) d.append(el('span', 'card-does', SHORT[c.char]));
    d.dataset.tip = `${charName(c.char)}${c.up ? ' — face up: an influence lost' : peek ? ' — a bot’s card, shown for testing' : mine ? ' — yours, face down' : ''}. ${CHARS[c.char].does}`;
  } else {
    d.append(el('span', 'card-ic', '?'));
    d.dataset.tip = 'A face-down card: an influence. Only its holder knows what it is.';
  }
  return d;
}

// ---------------------------------------------------------------- lobby UI

const OPT_TIP = {
  reformation: 'Reformation: every player is a Loyalist or a Reformist — the start player chooses, and round the table they alternate. No one may Coup, Assassinate, Steal from or block the Foreign Aid of their own side, unless everyone left is on one side. Two more actions: Conversion (1 coin onto the Treasury Reserve changes your side, 2 another player’s) and Embezzlement (claim not to hold the Duke, and take the Treasury Reserve).',
  inquisitor: 'The Inquisitor, in place of the Ambassador: Exchange one card with the Court deck, or Examine — look at one of another player’s cards and either hand it back or make them exchange it. Blocks stealing.',
  twoPlayer: 'The two-player variant’s set-up: each player secretly chooses one card from a set of the five characters, and is dealt the second from a third set; the three cards left are the Court deck. Only in a game of two.',
};

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
  // the seats so far, and empty ones up to the two a game needs (or one more)
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

  const opts = lob.opts;
  const host = sess.isHost;
  const op = $('#option-picker');
  op.replaceChildren();
  const g = el('div', 'opt-group');
  const h = el('div', 'opt-title', 'Reformation');
  h.dataset.tip = 'The Reformation expansion: Allegiances, Conversion and Embezzlement; the Inquisitor; and the cards for up to ten players.';
  const row = el('div', 'pick-row');
  g.append(h, row);
  op.append(g);
  const LABEL = { reformation: ['Allegiances', '⚜'], inquisitor: ['Inquisitor', CHAR_ICON.inquisitor], twoPlayer: ['Two-player variant', '⚔'] };
  for (const k of ['reformation', 'inquisitor', 'twoPlayer']) {
    const b = el('button', `role-pick rule${opts[k] ? ' on' : ''}${k === 'twoPlayer' && n !== 2 ? ' idle' : ''}`);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(!!opts[k]));
    b.disabled = !host;
    if (host) b.addEventListener('click', () => sess.setOpt(k, !opts[k]));
    b.append(el('span', 'role-ic', LABEL[k][1]), el('span', '', LABEL[k][0]));
    b.dataset.tip = OPT_TIP[k];
    row.append(b);
  }

  // the Court deck the table will be dealt from, at its size now (or two)
  const tn = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, n));
  const sum = $('#cast-summary');
  sum.replaceChildren();
  const fit = canStart(tn, opts);
  if (fit) sum.append(el('div', 'cast-bad', fit));
  else {
    const variant = opts.twoPlayer && tn === 2;
    const k = variant ? 3 : copiesFor(tn);
    sum.append(el('div', 'cast-head', n >= MIN_PLAYERS ? `Dealt at this table of ${tn}:` : `Dealt at a table of ${tn}:`));
    sum.append(el('div', 'cast-line', `${k} each of ${listWords(charsFor(opts).map((c) => the(c)))} — ${5 * k} cards.`));
    sum.append(el('div', 'cast-line dim', variant ? 'Each player chooses a card from a set of five and is dealt the second; 1 coin for the starting player, 2 for the other.' : `Two face-down cards and ${tn === 2 ? '2 coins each — the starting player only 1.' : '2 coins each.'}`));
  }
  for (const a of advice(tn, opts)) sum.append(el('div', 'cast-advice', a));

  $('#btn-start').classList.toggle('hidden', !sess.isHost);
  $('#btn-add-bot').classList.toggle('hidden', !sess.isHost);
  const why = canStart(n, opts);
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
let chosen = null;        // the action picked on your turn, waiting for its target
let keep = [];            // the cards you keep in an exchange
let askKey = null;        // the question the picks above belong to
let autoKey = null;       // the question already let go of automatically

const meP = (view) => view.players.find((p) => p.seat === view.you);
const seatName = (view, seat) => (view.players.find((p) => p.seat === seat) || { name: '?' }).name;
// a player's name — or "you", to the one who is that player
const nameOrYou = (view, seat) => (seat === view.you && !isObserver(view) ? 'you' : seatName(view, seat));
const isObserver = (view) => !!view.observer;
const myAsk = (view) => (view.ask && view.ask.seat === view.you && !isObserver(view) && view.phase !== 'over' ? view.ask : null);
const myWindow = (view) => (view.window && view.window.waiting.includes(view.you) && !isObserver(view) && view.phase !== 'over' ? view.window : null);
const myHand = (view) => { const p = meP(view); return p && !isObserver(view) ? p.cards.filter((c) => !c.up && c.char) : []; };
const holds = (view, char) => myHand(view).some((c) => c.char === char);

function btn(label, cls, fn, disabled = false) {
  const b = el('button', `btn ${cls}`, label);
  b.type = 'button';
  b.disabled = disabled || pendingMove;
  b.addEventListener('click', fn);
  return b;
}

// the seats you may tap for the action you picked
function aimable(view, seat) {
  if (!chosen || !myAsk(view) || myAsk(view).kind !== 'act') return false;
  const legal = legalActions(view, view.you)[chosen];
  return Array.isArray(legal) && legal.includes(seat);
}

function seatClick(view, seat) {
  if (!aimable(view, seat)) return;
  const action = chosen;
  chosen = null;
  sendMove({ kind: 'act', action, target: seat });
}

// what the action under way says, in a line
function actLine(view, a = view.act) {
  if (!a) return '';
  const who = seatName(view, a.actor);
  const on = a.target != null && a.type !== 'convert' ? ` on ${nameOrYou(view, a.target)}` : '';
  if (a.type === 'embezzle') return `${who} claims not to hold the Duke, to Embezzle ${coinWords(view.reserve)}`;
  if (a.claim) return `${who} claims ${the(a.claim)}: ${actName(a.type)}${on}`;
  return `${who}: ${actName(a.type)}${on}`;
}

function seatEl(view, p) {
  const act = aimable(view, p.seat);
  const s = el(act ? 'button' : 'div', 'seat');
  if (act) {
    s.type = 'button';
    s.classList.add('can');
    s.addEventListener('click', () => seatClick(view, p.seat));
  }
  s.dataset.seat = String(p.seat);
  const a = view.act;
  const live = view.phase === 'play';
  s.classList.toggle('me', p.seat === view.you);
  s.classList.toggle('turn', live && view.turn === p.seat);
  s.classList.toggle('out', p.out);
  s.classList.toggle('gone', !p.connected && !p.bot);
  s.classList.toggle('target', live && !!a && a.target === p.seat && a.type !== 'convert' && a.type !== 'income');
  s.classList.toggle('won', view.phase === 'over' && view.winner === p.seat);
  const top = el('div', 'seat-top');
  top.append(avatarEl(p.name, p.seat, p.bot), el('span', 'seat-name', p.name));
  if (p.seat === view.you && !isObserver(view)) top.append(el('span', 'you-tag', 'you'));
  s.append(top);
  const mid = el('div', 'seat-mid');
  const coins = el('span', 'coins', `🪙 ${p.coins}`);
  coins.dataset.tip = `${coinWords(p.coins)}. ${p.coins >= 10 ? 'With 10 or more, a Coup is the only action.' : p.coins >= 7 ? 'Enough for a Coup.' : 'A Coup costs 7.'}`;
  mid.append(coins);
  if (p.side) {
    const sd = el('span', `side ${p.side}`, `${SIDE_ICON[p.side]} ${SIDES[p.side]}`);
    sd.dataset.tip = `${SIDES[p.side]}: may not Coup, Assassinate, Steal from, Examine or block the Foreign Aid of another ${SIDES[p.side]} — unless everyone left is on one side.`;
    mid.append(sd);
  }
  s.append(mid);
  const cards = el('div', 'seat-cards');
  const peek = view.revealBots && view.revealBots.find((b) => b.seat === p.seat);
  let k = 0;
  for (const c of p.cards) {
    if (!c.up && !c.char && peek) cards.append(cardEl({ char: peek.chars[k++] }, { peek: true }));
    else cards.append(cardEl(c, { mine: p.seat === view.you && !c.up }));
  }
  s.append(cards);
  const marks = el('div', 'seat-marks');
  const tok = (cls, text, tip) => { const t = el('span', `tok ${cls}`, text); t.dataset.tip = tip; marks.append(t); return t; };
  if (p.out) tok('exiled', 'exiled', 'No influence left: out of the game.');
  else if (live) {
    if (view.turn === p.seat) tok('turn', '▶ turn', 'This player is taking their turn.');
    if (a && a.actor === p.seat && a.claim) tok(`claim ch-${a.claim}`, `${CHAR_ICON[a.claim]} ${charName(a.claim)}`, `${p.name} claims ${the(a.claim)}.`);
    if (a && a.actor === p.seat && a.type === 'embezzle') tok('claim not', '🚫👑 no Duke', `${p.name} claims not to hold the Duke.`);
    if (a && a.block && a.block.by === p.seat) tok(`claim block ch-${a.block.claim}`, `⛔ ${charName(a.block.claim)}`, `${p.name} claims ${the(a.block.claim)} to block.`);
    if (view.challenge && view.challenge.by === p.seat) tok('challenger', '⚔ challenges', `${p.name} challenges ${seatName(view, view.challenge.claimant)}.`);
    if (view.window && view.window.waiting.includes(p.seat)) tok('deciding', '… deciding', view.window.kind === 'challenge' ? 'May challenge — still deciding.' : view.window.kind === 'block' ? 'May block — still deciding.' : 'Still choosing.');
    else if (view.ask && view.ask.seat === p.seat && view.ask.kind !== 'act') tok('deciding', '… deciding', 'Has a decision to make.');
  }
  s.append(marks);
  return s;
}

// the middle of the table: the Court deck, the Treasury Reserve, the action
function courtEl(view) {
  const t = el('div', 'court');
  const piles = el('div', 'piles');
  const deck = el('span', 'pile deck', `🂠 ${view.deck}`);
  deck.dataset.tip = `The Court deck: ${view.deck} card${view.deck === 1 ? '' : 's'}, face down. ${view.copies} each of ${listWords(view.chars.map((c) => the(c)))} are in the game.`;
  piles.append(deck);
  if (view.opts.reformation) {
    const r = el('span', 'pile reserve', `🏛 ${view.reserve}`);
    r.dataset.tip = `The Treasury Reserve: ${coinWords(view.reserve)}, paid for Conversions. Embezzlement takes them all.`;
    piles.append(r);
  }
  t.append(piles);
  const line = el('div', 'court-act');
  if (view.phase === 'over') line.textContent = `${seatName(view, view.winner)} wins.`;
  else if (view.act) line.textContent = actLine(view);
  else if (view.window && view.window.kind === 'pick') line.textContent = 'Each player chooses a card.';
  else if (view.ask && view.ask.kind === 'side') line.textContent = `${seatName(view, view.ask.seat)} chooses an Allegiance.`;
  else if (view.ask && view.ask.kind === 'act') line.textContent = `${seatName(view, view.ask.seat)}’s turn.`;
  t.append(line);
  const a = view.act;
  if (a && a.block) t.append(el('div', 'court-block', `${seatName(view, a.block.by)} blocks with ${the(a.block.claim)}`));
  if (view.challenge) t.append(el('div', 'court-ch', `${seatName(view, view.challenge.by)} challenges ${seatName(view, view.challenge.claimant)}`));
  // what is out of the game, face up
  const up = {};
  for (const p of view.players) for (const c of p.cards) if (c.up) up[c.char] = (up[c.char] || 0) + 1;
  const ups = el('div', 'court-up');
  for (const c of view.chars) {
    const k = up[c] || 0;
    const u = el('span', `up-count ch-${c}${k === view.copies ? ' gone' : ''}`, `${CHAR_ICON[c]} ${k}/${view.copies}`);
    u.dataset.tip = `${charName(c)}: ${k} of ${view.copies} face up${k === view.copies ? ' — no one can hold one now' : ''}.`;
    ups.append(u);
  }
  t.append(ups);
  return t;
}

function renderBoard(view) {
  const board = $('#board');
  // Measured before anything is taken away, and swapped in whole at the end:
  // an empty board would shrink the page for a moment.
  const wide = (board.clientWidth || document.documentElement.clientWidth) >= 640;
  const ring = el('div', 'ring');
  const n = view.players.length;
  ring.classList.toggle('round', wide);
  ring.classList.add(`n${n}`);
  const youIdx = Math.max(0, view.players.findIndex((p) => p.seat === view.you));
  ring.append(courtEl(view));
  for (let k = 0; k < n; k++) {
    // you at the bottom, then clockwise round the table
    const p = view.players[(youIdx + k) % n];
    const s = seatEl(view, p);
    if (wide) {
      const ang = Math.PI / 2 + (k * 2 * Math.PI) / n;
      s.style.left = `${50 + 41 * Math.cos(ang)}%`;
      s.style.top = `${50 + 40 * Math.sin(ang)}%`;
    }
    ring.append(s);
  }
  board.replaceChildren(ring);
}

// ---------------------------------------------------------------- the action panel

const WHY = { coup: 'to the Coup', assassinate: 'to the assassination', challenge: 'for the lost challenge' };

function renderAction(view) {
  const box = $('#action');
  box.replaceChildren();
  const add = (cls, text) => { const p = el('p', cls, text); box.append(p); return p; };
  const row = () => { const r = el('div', 'act-row'); box.append(r); return r; };
  const a = view.act;
  const ask = view.ask;
  const w = view.window;
  if (view.phase === 'over') {
    add('act-head', view.winner === view.you && !isObserver(view) ? 'You are the last with influence — you win.' : `${seatName(view, view.winner)} is the last with influence, and wins.`);
    return;
  }
  // your own cards, whenever you are in the game
  const mine = meP(view);
  const hand = myHand(view);
  const showHand = () => {
    if (!mine || isObserver(view) || mine.out) return;
    box.append(el('p', 'hand-cap', 'Your cards'));
    const hr = el('div', 'hand');
    for (const c of mine.cards) hr.append(cardEl(c, { big: true, mine: !c.up }));
    box.append(hr);
  };

  // --- a question to several players
  if (w && w.kind === 'pick') {
    if (myWindow(view)) {
      add('act-head', 'Choose your card: you keep it, and are dealt a second from the third set.');
      const r = row();
      r.classList.add('cards-row');
      for (const c of view.me.set) {
        const b = el('button', 'card-btn');
        b.type = 'button';
        b.disabled = pendingMove;
        b.append(cardEl(c, { big: true }));
        b.addEventListener('click', () => sendMove({ kind: 'pick', card: c.id }));
        r.append(b);
      }
    } else add('act-head', `Waiting for ${listWords(w.waiting.map((s) => seatName(view, s)))} to choose.`);
    showHand();
    return;
  }
  if (w && (w.kind === 'challenge' || w.kind === 'block')) {
    const actor = seatName(view, a.actor);
    const target = a.target != null ? seatName(view, a.target) : null;
    const meTarget = a.target === view.you && !isObserver(view);
    let head;
    if (w.kind === 'challenge' && w.of === 'block') head = `${seatName(view, a.block.by)} claims ${the(a.block.claim)} to block ${a.actor === view.you ? 'your' : `${actor}’s`} ${actName(a.type)}.`;
    else if (w.kind === 'challenge') head = `${actLine(view)}.`;
    else head = a.type === 'foreignAid' ? `${actor} asks for Foreign Aid.` : `${actor}’s ${actName(a.type)}${target ? ` on ${meTarget ? 'you' : target}` : ''} goes ahead — unless it is blocked.`;
    add('act-head', head);
    if (myWindow(view)) {
      const r = row();
      if (w.kind === 'challenge') {
        r.append(btn(w.inverse ? 'Challenge — they hold the Duke' : `Challenge ${the(w.claim)}`, 'vote-no', () => sendMove({ kind: 'challenge' })));
        const blockers = w.of === 'action' && meTarget ? blocksFor(view) : [];
        for (const c of blockers) r.append(btn(`Block with ${the(c)}${holds(view, c) ? '' : ' (bluff)'}`, 'vote-yes', () => sendMove({ kind: 'block', claim: c })));
        r.append(btn(blockers.length ? 'Let it happen' : w.of === 'block' ? 'Let the block stand' : 'Let it go', 'ghost', () => sendMove({ kind: 'allow' })));
        const claimant = seatName(view, w.claimant);
        add('act-sub', w.inverse
          ? `If you challenge and ${claimant} shows no Duke, you lose an influence; if they hold one, they do — and give the coins back.`
          : `If you challenge and ${claimant} shows ${the(w.claim)}, you lose an influence; if not, they do${w.of === 'action' && a.paid ? ' and get their coins back' : ''}.${blockers.length ? ' Blocking now means not challenging.' : ''}`);
      } else {
        for (const c of blocksFor(view)) r.append(btn(`Block with ${the(c)}${holds(view, c) ? '' : ' (bluff)'}`, 'vote-yes', () => sendMove({ kind: 'block', claim: c })));
        r.append(btn(meTarget ? 'Let it happen' : 'Let it go', 'ghost', () => sendMove({ kind: 'allow' })));
        if (a.type === 'foreignAid') add('act-sub', 'Anyone claiming the Duke may block Foreign Aid — and anyone may challenge that claim.');
      }
    } else {
      const left = w.waiting.map((s) => seatName(view, s));
      add('act-sub', `${w.kind === 'block' ? 'Will anyone block it?' : 'Will anyone challenge?'} Waiting for ${listWords(left)}.`);
      if (a.pre && meTarget) add('act-sub', `You will block with ${the(a.pre)} if no one challenges.`);
    }
    showHand();
    return;
  }

  // --- a question to one player
  const mineAsk = myAsk(view);
  const who = ask ? seatName(view, ask.seat) : '';
  switch (ask && ask.kind) {
    case 'side':
      if (mineAsk) {
        add('act-head', 'You start: choose your Allegiance. Round the table the others alternate.');
        const r = row();
        for (const s of ['loyalist', 'reformist']) r.append(btn(`${SIDE_ICON[s]} ${SIDES[s]}`, 'secondary', () => sendMove({ kind: 'side', side: s })));
      } else add('act-head', `${who} chooses an Allegiance.`);
      break;
    case 'act':
      if (mineAsk) renderActions(view, add, row);
      else add('act-head', `${who} is choosing an action.`);
      break;
    case 'prove': {
      const ch = view.challenge;
      if (mineAsk) {
        add('act-head', ch.inverse ? `${seatName(view, ch.by)} challenges you: they say you hold the Duke.` : `${seatName(view, ch.by)} challenges your claim to ${the(ch.claim)}.`);
        const r = row();
        if (ch.inverse) {
          r.append(btn('Show your cards — no Duke', 'vote-yes', () => sendMove({ kind: 'prove', show: true })));
          r.append(btn('Concede', 'ghost', () => sendMove({ kind: 'prove', show: false })));
          add('act-sub', 'Showing them wins the challenge: your cards are shuffled into the Court deck and you draw new ones.');
        } else {
          r.append(btn(`Show ${the(ch.claim)}`, 'vote-yes', () => sendMove({ kind: 'prove', show: true })));
          r.append(btn('Don’t show it — lose the challenge', 'ghost', () => sendMove({ kind: 'prove', show: false })));
          add('act-sub', `Showing it wins the challenge: ${the(ch.claim)} goes back into the Court deck and you draw a new card.`);
        }
      } else add('act-head', ch.inverse ? `${who} must show they hold no Duke — or concede.` : `${who} must show ${the(ch.claim)} — or lose the challenge.`);
      break;
    }
    case 'lose':
      if (mineAsk) {
        add('act-head', `You lose an influence${WHY[ask.why] ? ` ${WHY[ask.why]}` : ''}: choose a card to turn face up.`);
        const r = row();
        r.classList.add('cards-row');
        for (const c of hand) {
          const b = el('button', 'card-btn');
          b.type = 'button';
          b.disabled = pendingMove;
          b.append(cardEl(c, { big: true, mine: true }));
          b.addEventListener('click', () => sendMove({ kind: 'lose', card: c.id }));
          r.append(b);
        }
        return;
      }
      add('act-head', `${who} loses an influence${WHY[ask.why] ? ` ${WHY[ask.why]}` : ''}, and chooses which card.`);
      break;
    case 'exchange':
      if (mineAsk) {
        const n = hand.length;
        const pool = [...hand, ...ask.drawn];
        keep = keep.filter((id) => pool.some((c) => c.id === id));
        add('act-head', `Keep ${n === 1 ? 'one card' : 'two cards'} — tap ${n === 1 ? 'it' : 'them'}. The rest go back to the Court deck.`);
        const r = row();
        r.classList.add('cards-row');
        for (const c of pool) {
          const b = el('button', `card-btn${keep.includes(c.id) ? ' kept' : ''}`);
          b.type = 'button';
          b.append(cardEl(c, { big: true, mine: true }));
          b.append(el('span', 'card-from', hand.includes(c) ? 'yours' : 'drawn'));
          b.addEventListener('click', () => {
            keep = keep.includes(c.id) ? keep.filter((x) => x !== c.id) : [...keep, c.id].slice(-n);
            renderGame(lastView, session);
          });
          r.append(b);
        }
        const r2 = row();
        r2.append(btn(keep.length === n ? 'Keep these' : `Choose ${n - keep.length} more`, 'primary', () => { const k = keep.slice(); keep = []; sendMove({ kind: 'exchange', keep: k }); }, keep.length !== n));
        add('act-sub', 'No one else sees which you keep.');
        return;
      }
      add('act-head', `${who} looks through the cards drawn from the Court deck.`);
      break;
    case 'show':
      if (mineAsk) {
        add('act-head', `${seatName(view, ask.to)} Examines you: choose a card to show them.`);
        const r = row();
        r.classList.add('cards-row');
        for (const c of hand) {
          const b = el('button', 'card-btn');
          b.type = 'button';
          b.disabled = pendingMove;
          b.append(cardEl(c, { big: true, mine: true }));
          b.addEventListener('click', () => sendMove({ kind: 'show', card: c.id }));
          r.append(b);
        }
        add('act-sub', 'They may hand it back, or make you draw a new card in its place.');
        return;
      }
      add('act-head', `${who} chooses a card to show ${nameOrYou(view, ask.to)}.`);
      break;
    case 'examine':
      if (mineAsk) {
        add('act-head', `${seatName(view, ask.target)} shows you ${the(ask.card.char)}.`);
        const r0 = row();
        r0.classList.add('cards-row');
        r0.append(cardEl(ask.card, { big: true }));
        const r = row();
        r.append(btn('Hand it back', 'secondary', () => sendMove({ kind: 'examine', swap: false })));
        r.append(btn('Make them exchange it', 'vote-no', () => sendMove({ kind: 'examine', swap: true })));
        add('act-sub', 'Exchanging: they draw a new card from the Court deck, and this one goes back into it.');
        return;
      }
      add('act-head', ask.target === view.you && !isObserver(view) ? `${who} looks at the card you showed them.` : `${who} looks at the card ${seatName(view, ask.target)} showed them.`);
      break;
    default:
      add('act-head', 'The court is in session.');
  }
  showHand();
}

// what you may block this action with
function blocksFor(view) {
  const a = view.act;
  return a ? blockersOf(view.opts, a.type) : [];
}

// your turn: every action, with what it claims and costs
function renderActions(view, add, row) {
  const legal = legalActions(view, view.you);
  const p = meP(view);
  if (chosen && !legal[chosen]) chosen = null;
  if (chosen) {
    const verb = { coup: 'launch a Coup against', assassinate: 'assassinate', steal: 'steal from', examine: 'Examine', convert: 'convert' }[chosen];
    add('act-head', chosen === 'convert' ? 'Whom do you convert? Yourself for 1 coin, another player for 2.' : `Whom do you ${verb}? Tap a player.`);
    const r = row();
    for (const s of legal[chosen]) r.append(btn(chosen === 'convert' && s === view.you ? 'Yourself (1 coin)' : seatName(view, s) + (chosen === 'convert' ? ' (2 coins)' : ''), chosen === 'convert' ? 'secondary small' : 'vote-no small', () => { const c = chosen; chosen = null; sendMove({ kind: 'act', action: c, target: s }); }));
    r.append(btn('Back', 'ghost small', () => { chosen = null; renderGame(lastView, session); }));
    return;
  }
  add('act-head', p.coins >= 10 ? 'Your turn — with 10 coins or more, you must launch a Coup.' : 'Your turn: choose an action.');
  const groups = [
    ['General', ['income', 'foreignAid', 'coup']],
    ['Characters', ['tax', 'assassinate', 'steal', 'exchange', 'examine']],
    ['Reformation', ['convert', 'embezzle']],
  ];
  for (const [title, types] of groups) {
    const shown = types.filter((t) => t in ACTIONS && (t !== 'examine' || view.opts.inquisitor) && ((t !== 'convert' && t !== 'embezzle') || view.opts.reformation));
    if (!shown.length) continue;
    const gr = el('div', 'acts');
    gr.append(el('span', 'acts-title', title));
    for (const t of shown) {
      const claim = claimOf(view.opts, t);
      const ok = !!legal[t];
      const b = el('button', `act-btn${claim ? ` ch-${claim}` : ''}`);
      b.type = 'button';
      b.disabled = !ok || pendingMove;
      const cost = { coup: '7', assassinate: '3', convert: '1–2' }[t];
      b.append(el('span', 'ab-name', actName(t)));
      if (claim) b.append(el('span', 'ab-claim', `${CHAR_ICON[claim]} ${charName(claim)}`));
      if (t === 'embezzle') b.append(el('span', 'ab-claim', '🚫 no Duke'));
      if (cost) b.append(el('span', 'ab-cost', `🪙 ${cost}`));
      const bluff = claim ? !holds(view, claim) : t === 'embezzle' ? holds(view, 'duke') : false;
      if (bluff && ok) b.append(el('span', 'ab-bluff', 'bluff'));
      b.dataset.tip = actTip(view, t) + (bluff ? ' You would be bluffing: anyone may challenge.' : '');
      b.addEventListener('click', () => {
        if (Array.isArray(legal[t])) { chosen = t; renderGame(lastView, session); }
        else sendMove({ kind: 'act', action: t });
      });
      gr.append(b);
    }
    $('#action').append(gr);
  }
}

function actTip(view, t) {
  const o = view.opts;
  switch (t) {
    case 'exchange': return o.inquisitor ? 'Claim the Inquisitor: draw 1 card from the Court deck, keep what you like, return 1.' : 'Claim the Ambassador: draw 2 cards from the Court deck, keep what you like, return 2.';
    case 'steal': return `Claim the Captain: take 2 coins from another player (1 if that is all they have). ${orWords(blockersOf(o, 'steal').map((c) => the(c))).replace(/^t/, 'T')} block it.`;
    default: return ACTIONS[t].text;
  }
}

// ---------------------------------------------------------------- the claims record

// Every claim made, by each player: Coup is a game of remembering who said
// what. Shown claims went back into the deck; lost ones were bluffs — or
// conceded.
function renderTracker(view) {
  const host = $('#tracker');
  host.replaceChildren();
  host.append(el('h3', 'side-title', 'Claims'));
  const tbl = el('div', 'claims');
  for (const p of view.players) {
    const r = el('div', `cl-row${p.out ? ' out' : ''}${p.seat === view.you ? ' me' : ''}`);
    r.append(el('span', 'cl-name', p.name));
    const chips = el('span', 'cl-chips');
    const mine = view.claims.filter((c) => c.seat === p.seat).slice(-8);
    for (const c of mine) {
      const res = c.result === 'shown' ? ' shown' : c.result === 'conceded' ? ' lost' : '';
      const t = el('span', `cl ch-${c.char}${res}${c.as === 'block' ? ' block' : ''}${c.as === 'not' ? ' not' : ''}`, c.as === 'not' ? '🚫👑' : CHAR_ICON[c.char]);
      t.dataset.tip = `${c.as === 'not' ? 'Claimed not to hold the Duke (Embezzlement)' : `Claimed ${the(c.char)} ${c.as === 'block' ? 'to block' : `for ${actName(c.type)}`}`}, turn ${c.turn}${c.result === 'shown' ? ' — challenged, and shown' : c.result === 'conceded' ? ' — challenged, and lost' : ''}.`;
      chips.append(t);
    }
    if (!mine.length) chips.append(el('span', 'cl-none', '—'));
    r.append(chips);
    tbl.append(r);
  }
  host.append(tbl);
  host.append(el('p', 'tr-key dim', '⛔ a block · ✓ shown when challenged · ✗ lost'));
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
    chosen = null;
    keep = [];
    lastFxSeq = view.fx ? view.fx.seq : 0;
  }
  // picks belong to the question they were made for
  const key = view.ask ? `${view.ask.kind}:${view.ask.seat}:${view.turns}` : view.window ? `w:${view.window.kind}:${view.turns}` : view.phase;
  if (key !== askKey) {
    askKey = key;
    chosen = null;
    keep = [];
  }

  $('#room-chip').textContent = view.code || '·····';
  const tc = $('#turn-chip');
  tc.textContent = view.phase === 'over' ? 'Game over' : `Turn ${Math.max(1, view.turns)}`;
  tc.dataset.tip = `${view.n} players. The Court deck: ${view.copies} each of ${listWords(view.chars.map((c) => the(c)))}.`;
  const pc = $('#phase-chip');
  const w = view.window;
  pc.textContent = view.phase === 'over' ? `${seatName(view, view.winner)} wins`
    : w ? (w.kind === 'challenge' ? 'Challenge?' : w.kind === 'block' ? 'Block?' : 'Choosing cards')
      : view.ask ? ({ act: `${seatName(view, view.ask.seat)}’s turn`, side: 'Allegiance', prove: 'Challenged', lose: 'Losing influence', exchange: 'Exchange', show: 'Examine', examine: 'Examine' }[view.ask.kind] || '') : '';
  pc.dataset.tip = w && w.kind === 'challenge' ? 'Anyone may challenge the claim — or let it go.' : w && w.kind === 'block' ? 'The action may be blocked by claiming a character.' : '';

  renderBoard(view);
  renderAction(view);
  renderTracker(view);
  renderLog(view);
  paintChatBubbles();
  retip();
  autoAllow(view);

  if (view.fx && view.fx.seq !== lastFxSeq) {
    lastFxSeq = view.fx.seq;
    const fx = view.fx;
    const nm = (s) => seatName(view, s);
    if (fx.kind === 'challenge') flash(`${nm(fx.by)} challenges ${nm(fx.claimant)}`, 'plain');
    else if (fx.kind === 'proved') flash(fx.inverse ? `${nm(fx.seat)} shows no Duke` : `${nm(fx.seat)} shows ${the(fx.chars[0])}`, 'good');
    else if (fx.kind === 'caught') flash(`${nm(fx.seat)} loses the challenge`, 'bad');
    else if (fx.kind === 'block') flash(`${nm(fx.seat)} blocks with ${the(fx.claim)}`, 'plain');
    else if (fx.kind === 'lose') flash(`${nm(fx.seat)} loses ${the(fx.char)}`, 'bad');
    else if (fx.kind === 'act' && fx.type === 'coup') flash(`${nm(fx.seat)} launches a Coup against ${nm(fx.target)}`, 'bad');
    else if (fx.kind === 'sides') flash('The Allegiances are set', 'plain');
  }
  settleOverlay('#gameover', view.phase === 'over', () => showGameover(view, sess));
}

// Let others' claims go without asking, when the player wants that — never
// one aimed at them, nor a block of their own action.
function autoAllow(view) {
  const w = myWindow(view);
  if (!w || !cfg.on('autoAllow') || w.kind === 'pick') return;
  const a = view.act;
  if (!a || a.target === view.you || a.actor === view.you) return;
  const key = `${view.mid}:${view.turns}:${w.kind}:${w.of || ''}`;
  if (autoKey === key) return;
  autoKey = key;
  setTimeout(() => {
    if (lastView && myWindow(lastView) && `${lastView.mid}:${lastView.turns}:${lastView.window.kind}:${lastView.window.of || ''}` === key) sendMove({ kind: 'allow' });
  }, 350);
}

// ---------------------------------------------------------------- game over

let confettiDone = false;

function showGameover(view, sess) {
  const m = $('#gameover');
  m.classList.remove('hidden');
  const iWon = view.winner === view.you && !isObserver(view);
  $('#go-title').textContent = iWon ? 'You win!' : `${seatName(view, view.winner)} wins`;
  $('#go-title').className = iWon ? 'win-me' : '';
  $('#go-sub').textContent = `The last player with influence at court, after ${view.turns} turns. “There is no second place.”`;
  const list = $('#go-rank');
  list.replaceChildren();
  const order = view.players.slice().sort((a, b) => (a.seat === view.winner ? -1 : b.seat === view.winner ? 1 : 0));
  for (const p of order) {
    const row = el('li', `rank-row${p.seat === view.winner ? ' winner' : ''}${p.seat === view.you ? ' me' : ''}`);
    row.append(avatarEl(p.name, p.seat, p.bot));
    row.append(el('span', 'rank-name', p.name + (p.connected || p.bot ? '' : ' (left)')));
    const r = el('span', 'rank-cards');
    for (const c of p.cards) r.append(cardEl(c));
    row.append(r);
    row.append(el('span', 'rank-score', p.seat === view.winner ? `🪙 ${p.coins}` : 'exiled'));
    list.append(row);
  }
  $('#btn-again').classList.toggle('hidden', !sess.isHost);
  $('#btn-golobby').classList.toggle('hidden', !sess.isHost);
  $('#go-wait').classList.toggle('hidden', sess.isHost);
  if (iWon && !confettiDone) {
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

// what a card says, for the tip that explains it

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
  localStorage.setItem('cop-name', name);
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
  localStorage.setItem('cop-name', name);
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
  $('#name-input').value = localStorage.getItem('cop-name') || '';
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
