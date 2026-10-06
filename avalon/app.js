// app.js — networking + UI for The Resistance: Avalon.
//
// Topology: host-authoritative star over WebRTC data channels.
//   - The host's browser owns the game and validates every move.
//   - Guests connect straight to the host (peer-to-peer); no game server.
//   - NAT traversal uses Google's public STUN servers (see RTC_CONFIG).
//   - Peer discovery/signaling uses the free PeerJS cloud broker, because
//     GitHub Pages can only serve static files.
// Every player gets their own view: their Character, what it lets them see,
// and nothing else. Bots fill empty seats and play in the host's browser,
// and take over for anyone who disconnects.

import {
  PROTO,
  MIN_PLAYERS,
  MAX_PLAYERS,
  SIDES,
  TEAM_SIZES,
  ROLES,
  GOOD_CHARS,
  EVIL_CHARS,
  RULES,
  CARDS,
  PLOTS,
  sideOf,
  defaultOpts,
  canStart,
  castFor,
  advice,
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
const cfg = initSettings('avl', [
  { key: 'botLead', label: 'Bot Leader thinks for', def: [2200, 1600], section: 'Host pacing', host: true, hint: 'How long a bot Leader takes to propose its Team.' },
  { key: 'botVote', label: 'Bot vote delay', def: [900, 1400], section: 'Host pacing', host: true },
  { key: 'botQuest', label: 'Bot Quest card delay', def: [900, 1100], section: 'Host pacing', host: true },
  { key: 'botLady', label: 'Bot Lady of the Lake delay', def: [1800, 1400], section: 'Host pacing', host: true },
  { key: 'botAssassin', label: 'Bot Assassin thinks for', def: [3600, 1600], section: 'Host pacing', host: true, hint: 'The pause before a bot Assassin names Merlin — time for the agents of Evil to talk it over.' },
  { key: 'bubbleChat', label: 'Chat bubbles linger', def: 6500, section: 'Bubbles & banners' },
  { key: 'bubbleTrunc', label: 'Bubble text cap', def: 84, min: 12, max: 400, step: 4, unit: 'ch', ms: false, section: 'Bubbles & banners' },
  { key: 'flashMs', label: 'Banner duration', def: 2100, section: 'Bubbles & banners' },
  { key: 'overlayDelay', label: 'Result screen delay', def: 2600, section: 'Overlays' },
  { key: 'revealBots', label: "Show the bots' Characters", def: false, bool: true, section: 'Testing', host: true, hint: 'Marks every bot’s Character at the table, to see why they play as they do. Only the host builds views, so this shows them to everyone.' },
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
const ID_PREFIX = 'avl-v1-';
// knights and ladies of the Round Table — none of them a Character's name
const BOT_NAMES = ['Gawain', 'Bedivere', 'Sir Kay', 'Tristan', 'Elaine', 'Gareth', 'Bors', 'Lamorak', 'Enid', 'Galahad'];
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

  // The lobby's Characters: Merlin and the Assassin always, and any of the
  // optional four; the Lady of the Lake on or off.
  setOpt(key, value) {
    if (this.G || !(key in defaultOpts())) return;
    if (key === 'lancelotVariant' ? ![0, 1, 2].includes(value) : typeof value !== 'boolean') return;
    this.opts = { ...this.opts, [key]: value };
    // a sub-option goes with its module
    if (key === 'sorcerers' && !value) this.opts.sorcererHidden = false;
    if (key === 'messengers' && !value) this.opts.messengerSenior = false;
    this.pushLobby();
  }

  // The host's clock lets the bots act, one at a time so the table can see
  // who did what: a bot Leader proposes, bots vote and play Quest cards, a bot
  // Lady of the Lake looks and speaks, a bot Assassin names Merlin.
  schedule(ms) {
    clearTimeout(this.tickTimer);
    if (!this.G || this.G.phase === 'over') return;
    this.tickTimer = setTimeout(() => this.tick(), Math.max(20, ms));
  }

  botDelay() {
    const G = this.G;
    const a = G.ask ? G.ask.kind : G.phase;
    const k = { propose: 'botLead', give: 'botLead', vote: 'botVote', quest: 'botQuest', lady: 'botLady', declare: 'botLady', loyalty: 'botLady', adjacent: 'botLady', showto: 'botLady', take: 'botLady', recruit: 'botAssassin', assassinate: 'botAssassin' }[a];
    return k ? cfg.range(k) : cfg.range('botVote');
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
    const why = canStart(this.roster.length, this.opts);
    if (why) { toast(why); return; }
    this.G = newGame(this.roster, this.opts);
    this.broadcast();
  }

  again() {
    if (!this.G || this.G.phase !== 'over') return;
    this.roster = this.roster.filter((p) => p.connected || p.bot);
    if (canStart(this.roster.length, this.opts)) {
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

const REJOIN_KEY = 'avl-rejoin';

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


// ---------------------------------------------------------------- Characters, as the table shows them

const ROLE_ICON = {
  merlin: '🧙', percival: '🛡️', servant: '⚔️', cleric: '📿', troublemaker: '🧨', untrustworthy: '🤞',
  lancelotGood: '🏇', lancelotEvil: '🏇', rogueGood: '🏹', rogueEvil: '🏹', sorcererGood: '🪄', sorcererEvil: '🪄',
  messengerSenior: '📜', messengerJunior: '📜', messengerEvil: '📜',
  assassin: '🗡️', morgana: '🔮', mordred: '🐉', oberon: '🌑', minion: '🐍', lunatic: '🤪', brute: '🪓', revealer: '👁️', trickster: '🎭',
};
const LADY_ICON = '🌊';
const roleName = (r) => ROLES[r].name;
const SHORT = { servant: 'Loyal Servant', minion: 'Minion', untrustworthy: 'Untrustworthy', messengerSenior: 'Sr. Messenger', messengerJunior: 'Jr. Messenger' };
const SIDE_WORD = { good: 'Good', evil: 'Evil' };
const PLURAL = { servant: 'Loyal Servants of Arthur', minion: 'Minions of Mordred' };
// the three kinds of Plot card: the Leader's crown (used at once), the
// fleur-de-lis (held until used), the flower (in play all game)
const PLOT_ICON = { now: '♛', held: '⚜', always: '✿' };
const CARD_TIP = {
  success: 'Success.',
  fail: 'Fail: one fails the Quest (two on the 4th Quest at seven or more).',
  rogueSuccess: 'Rogue Success: counts as Success, and leaves a Rogue token on the Quest. Played on the third successful Quest and one before, the Good Rogue wins alone.',
  rogueFail: 'Rogue Fail: counts as Fail, and leaves a Rogue token on the Quest. Played on the third failed Quest and one before, the Evil Rogue wins alone.',
  magic: 'Magic: an odd number of Magic cards turns the Quest’s result around.',
  goodMessage: 'Good Message: counts as Success. Three by the fifth Quest and Good may take a Fail off it. Twice in the game at most.',
  evilMessage: 'Evil Message: counts as Fail. Two by the fifth Quest and Evil may add a Fail to it.',
};

function listWords(a) {
  return a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}

// "3 Good: Merlin and 2 Loyal Servants of Arthur"
function castLine(n, opts, side) {
  const rs = castFor(n, opts).filter((r) => sideOf(r) === side);
  const counts = new Map();
  for (const r of rs) counts.set(r, (counts.get(r) || 0) + 1);
  const words = [...counts].map(([r, k]) => (k > 1 ? `${k} ${PLURAL[r] || roleName(r)}` : k === 1 && PLURAL[r] ? `1 ${roleName(r)}` : roleName(r)));
  return `${rs.length} ${SIDE_WORD[side]}: ${listWords(words)}`;
}

// ---------------------------------------------------------------- lobby UI

// what each lobby option is, in the rulebook's words where it has them
const RULE_TIP = {
  trapper: 'The Trapper: every Team takes one more player, and the Leader looks at one played Quest card and sets it aside — it does not count. Recommended for 8 or more.',
  lady: 'The Lady of the Lake: after the 2nd, 3rd and 4th Quests, whoever holds her looks at one player’s loyalty in secret — then she passes to that player. No one is looked at twice by her. Recommended for 7 or more.',
  excalibur: 'Excalibur: the Leader gives it to a member of the Team (not themselves). Once the cards are played, its holder may switch one other member’s card for their other one — and sees what it was.',
  plot: 'Plot cards: at the start of each Quest the Leader draws one, two or three and gives them away — cards used at once, cards held until used, and Charge!, in play all game. Here at 7 or more players only: which seven cards a table of 5 or 6 uses is printed on the cards, and not yet checked.',
};
const LANCELOT = [
  [0, 'Know each other', 'Lancelot: a Good and an Evil card, dealt in place of a Servant and a Minion. The two Lancelots know each other, and each other’s allegiance.'],
  [1, 'Variant 1', 'Variant 1: the Lancelots do not know each other, and Evil Lancelot is known to Evil but does not know them. At the start of each Quest a card is drawn from an Allegiance deck — four No Change, two Switch: on a Switch the two Lancelots change sides.'],
  [2, 'Variant 2', 'Variant 2: as Variant 1, but five of seven Allegiance cards (two Switch) are dealt face up over the Quests at the start, so everyone knows when the switches come — and Evil Lancelot must Fail every Quest he is on.'],
];

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
  // the seats so far, and empty ones up to the five a game needs (or one more)
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
      row.append(el('div', 'av empty', '·'), el('span', 'seat-name dim', i < MIN_PLAYERS ? 'Empty seat — a game needs five' : 'Empty seat'));
    }
    list.append(row);
  }

  // the options, in four groups: Characters, Lancelot, modules, optional rules
  const opts = lob.opts;
  const host = sess.isHost;
  const op = $('#option-picker');
  op.replaceChildren();
  const group = (title, hint) => {
    const g = el('div', 'opt-group');
    const h = el('div', 'opt-title', title);
    if (hint) h.dataset.tip = hint;
    const r = el('div', 'pick-row');
    g.append(h, r);
    op.append(g);
    return r;
  };
  const pickBtn = (row, { label, icon = '', cls = '', on, tip, set, fixed, sub }) => {
    const b = el(fixed ? 'span' : 'button', `role-pick ${cls}${on ? ' on' : ''}${fixed ? ' fixed' : ''}${sub ? ' sub' : ''}`);
    if (!fixed) {
      b.type = 'button';
      b.setAttribute('aria-pressed', String(!!on));
      b.disabled = !host;
      if (host) b.addEventListener('click', set);
    }
    if (icon) b.append(el('span', 'role-ic', icon));
    b.append(el('span', '', label));
    b.dataset.tip = tip;
    row.append(b);
    return b;
  };
  const toggle = (k) => () => sess.setOpt(k, !opts[k]);
  const chars = group('Characters', 'Merlin and the Assassin are in every game; the rest of each side are Loyal Servants of Arthur and Minions of Mordred. "It is best to add one special character into a game at a time."');
  for (const k of ['merlin', 'assassin']) pickBtn(chars, { label: roleName(k), icon: ROLE_ICON[k], cls: `side-${sideOf(k)}`, on: true, fixed: true, tip: `${roleName(k)}, in every game. ${ROLES[k].power}` });
  for (const k of [...GOOD_CHARS, ...EVIL_CHARS]) pickBtn(chars, { label: roleName(k), icon: ROLE_ICON[k], cls: `side-${sideOf(k)}`, on: opts[k], set: toggle(k), tip: `${roleName(k)} (${SIDE_WORD[sideOf(k)]}). ${ROLES[k].power}` });
  const lan = group('Lancelot');
  pickBtn(lan, { label: 'Off', on: !opts.lancelot, cls: 'plain', set: () => sess.setOpt('lancelot', false), tip: 'No Lancelot.' });
  for (const [v, label, tip] of LANCELOT) pickBtn(lan, { label, icon: v === 0 ? ROLE_ICON.lancelotGood : '⇄', cls: 'plain', on: opts.lancelot && opts.lancelotVariant === v, set: () => { sess.setOpt('lancelot', true); sess.setOpt('lancelotVariant', v); }, tip });
  const mods = group('Modules', '"These modules were designed to be played without Merlin but may be combined with Merlin, other optional modules, characters, and rules. It is recommended that you play each module separately before combining them."');
  pickBtn(mods, { label: 'Good Rogue', icon: ROLE_ICON.rogueGood, cls: 'side-good', on: opts.rogueGood, set: toggle('rogueGood'), tip: `The Rogue module. ${ROLES.rogueGood.power} The Leader gives a Watch token to a member of each Team: a watched Rogue may not play their Rogue card.` });
  pickBtn(mods, { label: 'Evil Rogue', icon: ROLE_ICON.rogueEvil, cls: 'side-evil', on: opts.rogueEvil, set: toggle('rogueEvil'), tip: `The Rogue module. ${ROLES.rogueEvil.power}` });
  pickBtn(mods, { label: 'Sorcerers', icon: ROLE_ICON.sorcererGood, cls: 'mod', on: opts.sorcerers, set: toggle('sorcerers'), tip: 'One Good and one Evil Sorcerer, who may play Magic: an odd number of Magic cards turns a Quest’s result around. The Evil Sorcerer may play Success or Magic, never Fail.' });
  if (opts.sorcerers) pickBtn(mods, { label: 'Evil Sorcerer unseen', cls: 'mod', sub: true, on: opts.sorcererHidden, set: toggle('sorcererHidden'), tip: 'The optional rule: "The Evil Sorcerer does not reveal themself in the Reveal stage" — Evil does not know them, Merlin does not see them.' });
  pickBtn(mods, { label: 'Messengers', icon: ROLE_ICON.messengerSenior, cls: 'mod', on: opts.messengers, set: toggle('messengers'), tip: 'Two Good Messengers and an Evil one, with Message cards: three Good Messages by the fifth Quest and Good takes a Fail off it; two Evil and Evil adds one. At the end the Assassin may go after both Good Messengers instead of Merlin. Recommended for 7 or more.' });
  if (opts.messengers) pickBtn(mods, { label: 'Senior knows Junior', cls: 'mod', sub: true, on: opts.messengerSenior, set: toggle('messengerSenior'), tip: 'The optional rule: "the Senior Messenger knows who the Junior Messenger is, but the Junior Messenger does not know their teammate."' });
  const rules = group('Optional rules');
  const RULE_ICON = { trapper: '🪤', lady: LADY_ICON, excalibur: '⚔', plot: '🂠' };
  const RULE_NAME = { trapper: 'Trapper', lady: 'Lady of the Lake', excalibur: 'Excalibur', plot: 'Plot cards' };
  for (const k of RULES) pickBtn(rules, { label: RULE_NAME[k], icon: RULE_ICON[k], cls: `rule ${k}`, on: opts[k], set: toggle(k), tip: RULE_TIP[k] });

  // the Characters the table will be dealt, at its size now (or five)
  const tn = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, n));
  const sum = $('#cast-summary');
  sum.replaceChildren();
  const fit = canStart(tn, opts);
  if (fit) sum.append(el('div', 'cast-bad', n >= MIN_PLAYERS ? fit : `At a table of ${tn}: ${fit}`));
  else {
    sum.append(el('div', 'cast-head', n >= MIN_PLAYERS ? `Dealt at this table of ${tn}:` : `Dealt at a table of ${tn}:`));
    sum.append(el('div', 'cast-good', castLine(tn, opts, 'good')), el('div', 'cast-evil', castLine(tn, opts, 'evil')));
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
  const [good, evil] = SIDES[tn];
  $('#lobby-hint').textContent = sess.isHost
    ? why || `${n} players${bots ? ` (${bots} bot${bots === 1 ? '' : 's'})` : ''}: ${good} Good, ${evil} Evil. Ready when you are.`
    : 'Waiting for the host to start…';
  paintChatBubbles();
}

// ---------------------------------------------------------------- UI state

let viewMid = null;
let pick = [];            // the Leader's Team, as it is being chosen
let excal = null;         // who the Leader gives Excalibur to
let aim = null;           // the player picked out for the question at hand
let aims = [];            // two players, when the Assassin names the Messengers
let mode = 'merlin';      // whom the Assassin goes after: Merlin, or the Messengers
let card = null;          // the Plot card the Leader is about to give
let askKey = null;        // the question the picks above belong to
let roleShownFor = null;  // the game whose role card has been shown

const me = (view) => view.players.find((p) => p.seat === view.you);
const seatName = (view, seat) => {
  const p = view.players.find((q) => q.seat === seat);
  return p ? p.name : 'someone';
};
const namesOf = (view, seats) => listWords(seats.map((s) => seatName(view, s)));
const isObserver = (view) => !!view.observer;
const lastOf = (a) => (a.length ? a[a.length - 1] : null);
const myAsk = (view) => (view.ask && view.ask.seat === view.you && view.me && !isObserver(view) ? view.ask : null);
const plotName = (t) => PLOTS[t].name;
const isTeam = (view, s) => !!view.team && view.team.includes(s);
// the players the viewer knows (or was shown) to be Evil
const knownEvil = (view, s) => ['evil', 'assassin'].includes(view.me.knows[s]);

function btn(label, cls, fn, disabled = false) {
  const b = el('button', `btn ${cls}`, label);
  b.type = 'button';
  b.disabled = disabled;
  b.addEventListener('click', fn);
  return b;
}

const PHASE = { team: 'Team Building', vote: 'Team Vote', onquest: 'Quest', quest: 'Quest', lady: 'Lady of the Lake', recruit: 'Recruitment', assassin: 'Assassination', over: 'Game over' };
const ASK_LABEL = {
  lead: 'Lead to Victory?', give: 'Plot cards', adjacent: 'Are You the One?', showto: 'Loyalty shown', take: 'Restore Your Honor', loyalty: 'Loyalty check',
  king: 'The King Returns?', watch: 'Watch token', spot: 'We Found You!?', excalibur: 'Excalibur', ambush: 'Ambush?', trap: 'The Trapper', declare: 'Lady of the Lake',
};

// who a tap at a seat may pick out now
function aimable(view, seat) {
  const a = myAsk(view);
  if (!a) return false;
  const you = view.you;
  switch (a.kind) {
    case 'give': case 'showto': return seat !== you;
    case 'adjacent': {
      const i = view.players.findIndex((p) => p.seat === you);
      const n = view.players.length;
      return [view.players[(i + 1) % n].seat, view.players[(i + n - 1) % n].seat].includes(seat);
    }
    case 'watch': case 'trap': return isTeam(view, seat);
    case 'spot': return isTeam(view, seat) && !(seat in view.faceUp);
    case 'excalibur': return isTeam(view, seat) && seat !== you && !(seat in view.faceUp);
    case 'ambush': return isTeam(view, seat) && seat !== you;
    case 'lady': return !view.lady.held.includes(seat);
    case 'recruit': return seat !== you && !knownEvil(view, seat);
    case 'assassinate': return seat !== you && !knownEvil(view, seat);
    default: return false;
  }
}

// what the viewer may do with a seat right now
function seatAct(view, seat) {
  const a = myAsk(view);
  if (!a) return null;
  if (a.kind === 'propose') return 'pick';
  if (a.kind === 'assassinate' && mode === 'messengers') return aimable(view, seat) ? 'aim2' : null;
  return aimable(view, seat) ? 'aim' : null;
}

function seatClick(view, seat, act) {
  if (act === 'pick') {
    const k = view.sizes[view.quest];
    if (pick.includes(seat)) {
      pick = pick.filter((s) => s !== seat);
      if (excal === seat) excal = null;
    } else if (pick.length < k) pick = [...pick, seat];
    else { toast(`The Team is full at ${k} — tap a member to take them off.`); return; }
  } else if (act === 'aim') aim = aim === seat ? null : seat;
  else if (act === 'aim2') aims = aims.includes(seat) ? aims.filter((s) => s !== seat) : [...aims, seat].slice(-2);
  renderGame(lastView, session);
}

// how the last vote went, on the seats, while it still matters: until the
// next Team is put to the vote, or the round ends
function shownVotes(view) {
  const pr = lastOf(view.proposals);
  if (!pr || view.phase === 'vote' || view.phase === 'over') return null;
  if (pr.quest !== view.quest && view.phase !== 'assassin' && view.phase !== 'recruit') return null;
  return pr;
}

const MARK = {
  evil: ['evil', 'Evil'], good: ['good', 'Good'], merlin: ['good', 'Merlin'], 'merlin?': ['maybe', 'Merlin?'], assassin: ['evil', 'Assassin'],
  junior: ['good', 'Messenger'], 'lancelot-good': ['good', 'Lancelot'], 'lancelot-evil': ['evil', 'Lancelot'],
  'shown-good': ['good shown', 'showed Good'], 'shown-evil': ['evil shown', 'showed Evil'],
};
function markTag(view, seat, mark) {
  const mine = view.me.role;
  const lanTip = (side) => `Holds the ${side === 'good' ? 'Good' : 'Evil'} Lancelot card${view.switches ? ` — after ${view.switches === 1 ? 'one switch' : `${view.switches} switches`} of allegiance, now ${(side === 'good') === (view.switches % 2 === 0) ? 'Good' : 'Evil'}` : ''}.`;
  const liars = view.opts.trickster || view.opts.troublemaker;
  const tip = {
    evil: mine === 'merlin' ? 'Merlin sees this agent of Evil.' : 'A fellow agent of Evil.',
    good: 'Loyal to Arthur.',
    merlin: 'Merlin — you know him as Percival.',
    'merlin?': 'Merlin or Morgana: of the two you see, one is Merlin and the other Morgana.',
    assassin: 'The Assassin: revealed to you, the Untrustworthy Servant.',
    junior: 'The Junior Messenger, known to you as the Senior.',
    'lancelot-good': lanTip('good'),
    'lancelot-evil': lanTip('evil'),
    'shown-good': `A loyalty check showed you Good.${liars ? ' The Trickster may lie, the Troublemaker must.' : ''}`,
    'shown-evil': `A loyalty check showed you Evil.${liars ? ' The Trickster may lie, the Troublemaker must.' : ''}`,
  }[mark];
  const [cls, word] = MARK[mark];
  const t = el('span', `mark ${cls}`, word);
  t.dataset.tip = tip;
  return t;
}

function roleTag(r, extra = '') {
  const t = el('span', `mark role side-${sideOf(r)}${extra}`);
  t.append(el('span', 'role-ic', ROLE_ICON[r]), el('span', '', SHORT[r] || roleName(r)));
  t.dataset.tip = `${roleName(r)} (${SIDE_WORD[sideOf(r)]}). ${ROLES[r].power}`;
  return t;
}

function plotTag(c, extra = '') {
  const P = PLOTS[c.type];
  const t = el('span', `tok plot ${P.use}${extra}`, `${PLOT_ICON[P.use]} ${P.name}`);
  t.dataset.tip = `${P.name} — ${P.use === 'now' ? 'used at once' : P.use === 'held' ? 'held until used' : 'in play all game'}. ${P.text}`;
  return t;
}

function cardTag(c, cls = '') {
  const t = el('span', `tok qcard ${CARDS[c].fail ? 'fail' : c === 'magic' ? 'magic' : 'success'}${cls}`, CARDS[c].name);
  t.dataset.tip = CARD_TIP[c];
  return t;
}

function seatEl(view, p, act) {
  const s = el(act ? 'button' : 'div', 'seat');
  if (act) {
    s.type = 'button';
    s.classList.add('can');
    s.addEventListener('click', () => seatClick(view, p.seat, act));
  }
  s.dataset.seat = String(p.seat);
  const live = view.phase === 'vote' || view.phase === 'quest' || view.phase === 'onquest';
  const onTeam = live && isTeam(view, p.seat);
  const picked = myAsk(view) && myAsk(view).kind === 'propose' && pick.includes(p.seat);
  s.classList.toggle('me', p.seat === view.you);
  s.classList.toggle('leader', view.leader === p.seat && view.phase !== 'over');
  s.classList.toggle('team', onTeam || picked);
  s.classList.toggle('aimed', aim === p.seat || aims.includes(p.seat));
  s.classList.toggle('gone', !p.connected && !p.bot);
  s.classList.toggle('asked', !!view.ask && view.ask.seat === p.seat && view.phase !== 'over');
  const top = el('div', 'seat-top');
  top.append(avatarEl(p.name, p.seat, p.bot), el('span', 'seat-name', p.name));
  if (p.seat === view.you) top.append(el('span', 'you-tag', 'you'));
  s.append(top);
  const marks = el('div', 'seat-marks');
  const tok = (cls, text, tip) => { const c = el('span', `tok ${cls}`, text); c.dataset.tip = tip; marks.append(c); return c; };
  if (view.leader === p.seat && view.phase !== 'over') tok('leader', 'Leader', 'The Leader proposes the Team. The role passes clockwise after every vote that fails and every Quest.');
  if (view.lady && view.lady.holder === p.seat && view.phase !== 'over') tok('lady', `${LADY_ICON} Lady`, 'Holds the Lady of the Lake: after the 2nd, 3rd and 4th Quests, looks at one player’s loyalty.');
  if (onTeam || picked) tok('team', '🛡 Team', picked ? 'In the Team you are choosing.' : 'On the Team.');
  const exc = picked ? excal === p.seat : live && view.excalibur === p.seat;
  if (exc) tok('excalibur', '⚔ Excalibur', 'Holds Excalibur: once the cards are played, may switch one other member’s card — and sees what it was.');
  if (live && view.watch === p.seat) tok('watch', '👁 Watch', 'Holds the Watch token: if a Rogue, may not play their Rogue card on this Quest.');
  if (live && p.seat in view.faceUp) {
    const c = view.faceUp[p.seat];
    if (c) marks.append(cardTag(c, ' up'));
    else tok('up', '⤒ face up', 'We Found You!: must play their Quest card face up.');
  }
  if (view.switched && view.switched.target === p.seat && live) tok('switched', '⇄ switched', `${seatName(view, view.switched.by)} switched this player’s Quest card with Excalibur.`);
  if (view.trapped === p.seat && live) tok('trapped', '🪤 set aside', 'The Leader set this card aside: it does not count.');
  if (view.phase === 'vote') {
    const charge = view.chargeVotes && p.seat in view.chargeVotes;
    if (charge) {
      const yes = view.chargeVotes[p.seat];
      tok(`vote ${yes ? 'yes' : 'no'}`, yes ? '✿ Approve' : '✿ Reject', 'A Charge! vote, revealed before the others.');
    } else {
      const done = view.voted.includes(p.seat);
      tok(`pip${done ? ' done' : ''}`, done ? '✓ voted' : '… voting', done ? 'Has voted — the votes turn over together when everyone has.' : view.chargers.includes(p.seat) ? 'Holds Charge!: votes first, for all to see.' : 'Still to vote.');
    }
  } else if (view.phase === 'quest' && onTeam) {
    const done = view.played.includes(p.seat);
    tok(`pip${done ? ' done' : ''}`, done ? '✓ played' : '… on Quest', done ? 'Has played a Quest card.' : 'Still to play a Quest card.');
  }
  const pr = shownVotes(view);
  if (pr && pr.votes[p.seat] !== undefined) {
    const yes = pr.votes[p.seat];
    tok(`vote ${yes ? 'yes' : 'no'}`, yes ? 'Approve' : 'Reject', `Voted to ${yes ? 'approve' : 'reject'} ${seatName(view, pr.leader)}’s Team: ${namesOf(view, pr.team)}.`);
  }
  // what the Lady of the Lake said of this player, out loud
  if (view.lady) {
    const c = lastOf(view.lady.checks.filter((x) => x.target === p.seat && x.declared));
    if (c) tok(`said ${c.declared}`, `${LADY_ICON} ${c.declared === 'good' ? 'Good' : 'Evil'}`, `${seatName(view, c.holder)}, holding the Lady of the Lake, declared ${p.name} ${c.declared === 'good' ? 'Good' : 'Evil'}.`);
  }
  for (const c of p.plots || []) marks.append(plotTag(c));
  if (p.role) marks.append(roleTag(p.role, p.seat === view.you ? ' mine' : p.revealed ? ' revealed' : ''));
  // a Lancelot who has switched, or a recruited Servant, is on the other side now
  if (p.seat === view.you && view.me && p.role && view.me.side !== sideOf(p.role)) {
    const t = el('span', `mark ${view.me.side}`, `now ${view.me.side === 'good' ? 'Good' : 'Evil'}`);
    t.dataset.tip = `Your side has changed: you are ${view.me.side === 'good' ? 'Good' : 'Evil'} now, and win or lose with them.`;
    marks.append(t);
  }
  else if (view.me && view.me.knows[p.seat]) marks.append(markTag(view, p.seat, view.me.knows[p.seat]));
  const bot = view.revealBots && view.revealBots.find((b) => b.seat === p.seat);
  if (!p.role && bot) marks.append(roleTag(bot.role, ' peek'));
  s.append(marks);
  const a = view.assassination;
  if (a && (a.target === p.seat || (a.messengers && a.messengers.includes(p.seat)))) s.classList.add('named');
  return s;
}

// the Quests and the Vote Track, in the middle of the table
function tableauEl(view) {
  const t = el('div', 'tableau');
  const qs = el('div', 'quests');
  const dealt = view.allegiance && view.allegiance.dealt;
  for (let q = 0; q < 5; q++) {
    const r = view.results[q];
    const now = !r && q === view.quest && !['over', 'assassin', 'recruit'].includes(view.phase);
    const d = el('div', `qt${r ? (r.success ? ' won' : ' lost') : ''}${now ? ' now' : ''}`);
    d.append(el('span', 'qt-n', `Quest ${q + 1}`));
    d.append(el('b', '', r ? (r.success ? '✓' : '✗') : String(view.sizes[q])));
    d.append(el('small', '', r ? (r.fails ? `${r.fails} Fail${r.fails === 1 ? '' : 's'}` : 'all Success') : `players`));
    if (view.twoFail === q) d.append(el('i', 'qt-two', 'needs 2 Fails'));
    const toks = [];
    if (r && r.magic) toks.push(`🪄${r.magic > 1 ? r.magic : ''}`);
    if (r && r.messages.good) toks.push(`📜${'✓'.repeat(r.messages.good)}`);
    if (r && r.messages.evil) toks.push(`📜${'✗'.repeat(r.messages.evil)}`);
    if (r && (r.rogue.success || r.rogue.fail)) toks.push(`🏹${r.rogue.success ? '✓' : ''}${r.rogue.fail ? '✗' : ''}`);
    if (dealt && dealt[q] === 'switch') toks.push('⇄');
    if (toks.length) d.append(el('i', 'qt-toks', toks.join(' ')));
    const bits = [];
    if (r) {
      bits.push(`Quest ${q + 1}: ${namesOf(view, r.team)} — ${r.fails ? `${r.fails} Fail card${r.fails === 1 ? '' : 's'}` : 'no Fail'}.`);
      if (r.magic) bits.push(`${r.magic} Magic card${r.magic === 1 ? '' : 's'}${r.magic % 2 ? ': the result turned around' : ', which cancel out'}.`);
      if (r.messages.good || r.messages.evil) bits.push(`Message tokens: ${r.messages.good} Good, ${r.messages.evil} Evil.`);
      if (r.rogue.success || r.rogue.fail) bits.push(`Rogue tokens: ${[r.rogue.success ? 'Rogue Success' : '', r.rogue.fail ? 'Rogue Fail' : ''].filter(Boolean).join(' and ')}.`);
      if (r.backup) bits.push(r.backup === 'cancel' ? 'Both sides called for backup: it cancels out.' : r.backup === 'good' ? 'Good’s backup took a Fail away.' : 'Evil’s backup added a Fail.');
      if (r.switched) bits.push(`${seatName(view, r.switched.by)} switched ${seatName(view, r.switched.target)}’s card with Excalibur.`);
      if (r.trapped != null) bits.push(`${seatName(view, r.trapped)}’s card was set aside by the Trapper.`);
      bits.push(r.success ? 'Success for Arthur.' : 'A failure: Mordred scores.');
    } else bits.push(`Quest ${q + 1} takes a Team of ${view.sizes[q]}.${view.twoFail === q ? ' At seven or more players it fails only on two Fail cards.' : ''}`);
    if (dealt && dealt[q] === 'switch') bits.push('A Switch Allegiance card lies over this Quest: the Lancelots change sides as it begins.');
    d.dataset.tip = bits.join(' ');
    qs.append(d);
  }
  t.append(qs);
  const vt = el('div', 'vtrack');
  vt.append(el('span', 'vt-label', 'Vote Track'));
  const live = view.phase === 'team' || view.phase === 'vote';
  for (let i = 1; i <= 5; i++) {
    vt.append(el('span', `vt${i <= view.rejects ? ' used' : ''}${live && i === view.rejects + 1 ? ' now' : ''}${i === 5 ? ' last' : ''}`, String(i)));
  }
  vt.dataset.tip = `${view.rejects} Team${view.rejects === 1 ? '' : 's'} rejected this round. Evil wins if five Teams are rejected in a single round; the track clears after each Quest.`;
  t.append(vt);
  const won = view.results.filter((r) => r.success).length;
  const lost = view.results.length - won;
  const score = el('div', 'score');
  score.append(el('span', 'sc good', `Arthur ${won}`), el('span', 'sc-sep', '·'), el('span', 'sc evil', `Mordred ${lost}`));
  score.dataset.tip = 'Three successful Quests and Good is one step from victory; three failed and Evil wins.';
  t.append(score);
  // the module counters under the score
  const extra = el('div', 'tab-extra');
  if (view.opts.messengers) {
    const g = view.results.reduce((a, r) => a + r.messages.good, 0);
    const e = view.results.reduce((a, r) => a + r.messages.evil, 0);
    const m = el('span', 'tx', `📜 ${g} Good · ${e} Evil`);
    m.dataset.tip = `Message tokens so far. After the fifth Quest's cards: 3 or more Good Messages and Good takes a Fail off it; 2 or more Evil Messages and Evil adds one; both, and nothing happens.`;
    extra.append(m);
  }
  if (view.allegiance && view.allegiance.drawn) {
    const a = el('span', 'tx', `⇄ Allegiance: ${view.allegiance.drawn.length ? view.allegiance.drawn.map((c) => (c === 'switch' ? 'Switch' : 'No Change')).join(', ') : 'none drawn'}`);
    a.dataset.tip = `Lancelot’s Allegiance deck: four No Change and two Switch, one drawn as each Quest begins. ${view.allegiance.left} left.`;
    extra.append(a);
  }
  if (view.plot) {
    const pd = el('span', 'tx', `🂠 Plot deck: ${view.plot.deck}`);
    pd.dataset.tip = 'Plot cards left to draw. At the start of each Quest the Leader draws 1 (5–6 players), 2 (7–8) or 3 (9–10) and gives them away.';
    extra.append(pd);
  }
  if (extra.childNodes.length) t.append(extra);
  if (view.plot && view.plot.hand.length) {
    const h = el('div', 'plot-hand');
    h.append(el('span', 'tx', 'Drawn:'));
    for (const c of view.plot.hand) h.append(plotTag(c, card === c.id ? ' chosen' : ''));
    t.append(h);
  }
  return t;
}

function renderBoard(view) {
  const board = $('#board');
  // Measured before anything is taken away, and swapped in whole at the end:
  // an empty board would shrink the page for a moment, and the browser would
  // pull a phone scrolled down to the vote record back to the top on every move.
  const wide = (board.clientWidth || document.documentElement.clientWidth) >= 640;
  const ring = el('div', 'ring');
  const n = view.players.length;
  ring.classList.toggle('round', wide);
  ring.classList.add(`n${n}`);
  const youIdx = Math.max(0, view.players.findIndex((p) => p.seat === view.you));
  ring.append(tableauEl(view));
  for (let k = 0; k < n; k++) {
    // you at the bottom, then clockwise round the table
    const p = view.players[(youIdx + k) % n];
    const s = seatEl(view, p, seatAct(view, p.seat));
    if (wide) {
      const a = Math.PI / 2 + (k * 2 * Math.PI) / n;
      s.style.left = `${50 + 41 * Math.cos(a)}%`;
      s.style.top = `${50 + 39 * Math.sin(a)}%`;
    }
    ring.append(s);
  }
  board.replaceChildren(ring);
}

// ---------------------------------------------------------------- the action panel

const REASON = { cleric: 'the Cleric', lady: 'the Lady of the Lake', one: 'Are You the One?', strength: 'Show Your Strength', nature: 'Show Your True Nature' };

function renderAction(view) {
  const box = $('#action');
  box.replaceChildren();
  const add = (cls, text) => { const n = el('p', cls, text); box.append(n); return n; };
  const row = () => { const r = el('div', 'act-row'); box.append(r); return r; };
  const k = view.sizes[view.quest];
  const leader = seatName(view, view.leader);
  const watching = isObserver(view);
  const a = view.ask;
  const mine = myAsk(view);
  const who = a ? seatName(view, a.seat) : '';
  box.className = `act-${a ? a.kind : view.phase}`;

  if (view.phase === 'over') {
    const w = { good: 'Good', evil: 'Evil', rogueGood: 'The Good Rogue', rogueEvil: 'The Evil Rogue' }[view.winner];
    add(`act-head win-${view.winner === 'rogueGood' ? 'good' : view.winner === 'rogueEvil' ? 'evil' : view.winner}`, `${w} wins — ${view.why}.`);
    return;
  }

  if (a && a.kind === 'propose') {
    if (mine) {
      add('act-head', `You are the Leader. Choose ${k} players for Quest ${view.quest + 1} — tap them at the table.`);
      add('act-sub', pick.length ? `Your Team: ${namesOf(view, pick)} (${pick.length} of ${k}).` : 'You may put yourself on the Team, or not. Talk it over in the chat first if you like.');
      let ready = pick.length === k;
      if (view.opts.excalibur) {
        const cands = pick.filter((s) => s !== view.you);
        if (excal != null && !cands.includes(excal)) excal = null;
        if (cands.length) {
          add('act-sub', 'Give Excalibur to a member of the Team other than yourself:');
          const r = row();
          for (const s of cands) r.append(btn(`⚔ ${seatName(view, s)}`, excal === s ? 'primary small' : 'ghost small', () => { excal = s; renderGame(lastView, session); }));
        }
        ready = ready && excal != null;
      }
      const r = row();
      r.append(btn('Propose this Team', 'primary', () => { const team = pick.slice(); const ex = excal; pick = []; excal = null; sendMove({ kind: 'propose', team, ...(view.opts.excalibur ? { excalibur: ex } : {}) }); }, !ready));
      if (pick.length) r.append(btn('Clear', 'ghost', () => { pick = []; excal = null; renderGame(lastView, session); }));
    } else {
      add('act-head', `${leader} is choosing a Team of ${k} for Quest ${view.quest + 1}.`);
      add('act-sub', 'Say whom you trust in the chat — the Leader is listening.');
    }
    if (view.rejects === 4) add('act-warn', 'Four Teams have been rejected this round: if the next one is rejected too, Evil wins.');
    return;
  }

  if (view.phase === 'vote') {
    add('act-head', `${leader} proposes ${namesOf(view, view.team)} for Quest ${view.quest + 1}${view.excalibur != null ? `, with Excalibur for ${seatName(view, view.excalibur)}` : ''}.`);
    if (view.rejects === 4) add('act-warn', 'The fifth Team this round: if it is rejected, Evil wins.');
    const chargeFirst = view.chargers.filter((s) => !view.voted.includes(s));
    const mayVote = view.me && !watching && view.myVote === undefined && (view.chargers.includes(view.you) || !chargeFirst.length);
    if (mayVote) {
      add('act-sub', view.chargers.includes(view.you) ? 'You hold Charge!: your vote is revealed before anyone else votes.' : 'Everyone votes at once; the votes turn over when the last is in.');
      const r = row();
      r.append(btn('Approve', 'vote-yes', () => sendMove({ kind: 'vote', approve: true })));
      r.append(btn('Reject', 'vote-no', () => sendMove({ kind: 'vote', approve: false })));
    } else if (chargeFirst.length) {
      add('act-sub', `${namesOf(view, chargeFirst)} hold${chargeFirst.length === 1 ? 's' : ''} Charge! and vote${chargeFirst.length === 1 ? 's' : ''} first, for all to see.`);
    } else {
      const waiting = view.players.filter((p) => !view.voted.includes(p.seat)).map((p) => p.name);
      add('act-sub', `${view.me && !watching ? `You voted to ${view.myVote ? 'approve' : 'reject'}. ` : ''}Waiting for ${listWords(waiting)}.`);
    }
    return;
  }

  if (view.phase === 'quest') {
    const two = view.twoFail === view.quest;
    add('act-head', `${namesOf(view, view.team)} ${view.team.length === 1 ? 'is' : 'are'} on Quest ${view.quest + 1}.`);
    if (two) add('act-sub', 'This Quest fails only if two Fail cards are played.');
    if (view.myCards) {
      const up = view.you in view.faceUp;
      add('act-sub', `${up ? 'We Found You!: your card is played face up, for all to see. ' : ''}${view.myCards.length === 1 ? `You must play ${CARDS[view.myCards[0]].name}.` : view.me.side === 'good' ? 'Choose your Quest card.' : 'An agent of Evil may play Fail. Only what the cards add up to is shown.'}`);
      const r = row();
      for (const c of view.myCards) {
        const b = btn(CARDS[c].name, CARDS[c].fail ? 'quest-no' : c === 'magic' ? 'quest-magic' : 'quest-yes', () => sendMove({ kind: 'quest', card: c }));
        b.dataset.tip = CARD_TIP[c];
        r.append(b);
      }
    } else {
      const waiting = view.team.filter((s) => !view.played.includes(s));
      add('act-sub', `${view.myCard ? 'Your card is played. ' : ''}Waiting for ${namesOf(view, waiting)}.`);
    }
    return;
  }

  if (!a) return;
  const pickRow = (verb, go, extra) => {
    const r = row();
    r.append(btn(aim != null ? `${verb} ${seatName(view, aim)}` : `${verb}…`, 'primary', () => { const t = aim; aim = null; go(t); }, aim == null));
    if (extra) r.append(extra);
  };
  switch (a.kind) {
    case 'lead':
      if (mine) {
        add('act-head', `Play Lead to Victory and become the Leader, in ${leader}’s place?`);
        const r = row();
        r.append(btn('Play it', 'primary', () => sendMove({ kind: 'lead', use: true })), btn('Keep it', 'ghost', () => sendMove({ kind: 'lead', use: false })));
      } else add('act-head', `${who} holds Lead to Victory and may take the lead from ${leader}.`);
      return;
    case 'give': {
      const hand = view.plot.hand;
      if (mine) {
        if (card == null || !hand.some((c) => c.id === card)) card = hand[0].id;
        add('act-head', `You drew ${listWords(hand.map((c) => plotName(c.type)))}. Give ${hand.length === 1 ? 'it' : 'each'} to another player — tap them at the table.`);
        if (hand.length > 1) {
          add('act-sub', 'Which card first?');
          const r = row();
          for (const c of hand) r.append(btn(`${PLOT_ICON[PLOTS[c.type].use]} ${plotName(c.type)}`, card === c.id ? 'primary small' : 'ghost small', () => { card = c.id; renderGame(lastView, session); }));
        }
        add('act-sub', PLOTS[hand.find((c) => c.id === card).type].text);
        pickRow(`Give ${plotName(hand.find((c) => c.id === card).type)} to`, (t) => { const id = card; card = null; sendMove({ kind: 'give', card: id, to: t }); });
      } else add('act-head', `${leader} drew ${listWords(hand.map((c) => plotName(c.type)))} and is choosing who gets ${hand.length === 1 ? 'it' : 'them'}.`);
      return;
    }
    case 'adjacent':
      if (mine) {
        add('act-head', 'Are You the One?: check the loyalty of the player to your left or right — tap them.');
        pickRow('Check', (t) => sendMove({ kind: 'adjacent', target: t }));
      } else add('act-head', `${who} will check the loyalty of a neighbour (Are You the One?).`);
      return;
    case 'showto':
      if (mine) {
        add('act-head', `${PLOTS[a.plot].name}: pass your Loyalty card to another player for examination — tap them.`);
        pickRow('Show it to', (t) => sendMove({ kind: 'showto', target: t }));
      } else add('act-head', `${who} must show their loyalty to another player (${PLOTS[a.plot].name}).`);
      return;
    case 'take': {
      if (mine) {
        add('act-head', 'Restore Your Honor: take one Plot card from another player.');
        const r = row();
        for (const p of view.players) if (p.seat !== view.you) for (const c of p.plots) r.append(btn(`${plotName(c.type)} from ${p.name}`, 'ghost small', () => sendMove({ kind: 'take', from: p.seat, card: c.id })));
      } else add('act-head', `${who} takes a Plot card from another player (Restore Your Honor).`);
      return;
    }
    case 'loyalty': {
      const checker = a.checker != null ? seatName(view, a.checker) : null;
      if (mine) {
        add('act-head', a.reason === 'cleric' ? 'The Cleric looks at the first Leader’s loyalty: pass your Loyalty card.' : `${checker} checks your loyalty (${REASON[a.reason]}): pass them your Loyalty card.`);
        const ops = view.me.loyalty;
        if (ops.length > 1) add('act-sub', 'You are the Trickster: you may lie and show Good.');
        else if (view.me.role === 'troublemaker') add('act-sub', 'You are the Troublemaker: you must show Evil.');
        const r = row();
        for (const o of ops) r.append(btn(o === 'good' ? 'Pass the Good card' : 'Pass the Evil card', o === 'good' ? 'quest-yes' : 'quest-no', () => sendMove({ kind: 'loyalty', card: o })));
      } else if (a.reason === 'cleric') add('act-head', `The Cleric looks at ${who}’s loyalty — the first Leader’s.`);
      else add('act-head', `${who} passes a Loyalty card to ${checker} (${REASON[a.reason]}).`);
      return;
    }
    case 'king':
      if (mine) {
        add('act-head', 'Play The King Returns and reject the approved Team?');
        add('act-sub', `It counts as a failed vote: the Vote Track would move to ${view.rejects + 1}${view.rejects === 4 ? ' — the fifth, and Evil wins' : ''}.`);
        const r = row();
        r.append(btn('Play it', 'quest-no', () => sendMove({ kind: 'king', use: true })), btn('Let the Team go', 'ghost', () => sendMove({ kind: 'king', use: false })));
      } else add('act-head', `${who} holds The King Returns and may turn the Team back.`);
      return;
    case 'watch':
      if (mine) {
        add('act-head', 'Give the Watch token to a member of the Team — tap them. A watched Rogue may not play their Rogue card.');
        pickRow('Watch', (t) => sendMove({ kind: 'watch', target: t }));
      } else add('act-head', `${leader} gives the Watch token to a member of the Team.`);
      return;
    case 'spot':
      if (mine) {
        add('act-head', 'Play We Found You! and make a member of the Team play their card face up? Tap them.');
        pickRow('Make face up:', (t) => sendMove({ kind: 'spot', target: t }), btn('Keep it', 'ghost', () => sendMove({ kind: 'spot', target: null })));
      } else add('act-head', `${who} holds We Found You! and may make a member of the Team play face up.`);
      return;
    case 'excalibur':
      if (mine) {
        add('act-head', 'The cards are played. Wield Excalibur? Tap another member of the Team to switch their card — you will see what it was.');
        pickRow('Switch the card of', (t) => sendMove({ kind: 'excalibur', target: t }), btn('Keep it sheathed', 'ghost', () => sendMove({ kind: 'excalibur', target: null })));
      } else add('act-head', `${who} holds Excalibur and may switch another member’s Quest card.`);
      return;
    case 'ambush':
      if (mine) {
        add('act-head', 'Play Ambush and look at a member’s played card? Tap them.');
        pickRow('Look at the card of', (t) => sendMove({ kind: 'ambush', target: t }), btn('Keep it', 'ghost', () => sendMove({ kind: 'ambush', target: null })));
      } else add('act-head', `${who} holds Ambush and may look at a played card.`);
      return;
    case 'trap':
      if (mine) {
        add('act-head', 'The Trapper: tap a member of the Team to look at their card and set it aside — it will not count.');
        pickRow('Set aside the card of', (t) => sendMove({ kind: 'trap', target: t }));
      } else add('act-head', `${leader}, the Leader, sets one played card aside unseen by the rest.`);
      return;
    case 'lady':
      if (mine) {
        add('act-head', 'You hold the Lady of the Lake. Choose a player whose loyalty you will see — tap them at the table.');
        add('act-sub', `No one who has held the Lady can be examined: ${namesOf(view, view.lady.held)}.`);
        pickRow('Examine', (t) => sendMove({ kind: 'lady', target: t }));
      } else add('act-head', `${who} holds the Lady of the Lake and is choosing whom to examine.`);
      return;
    case 'declare': {
      const target = seatName(view, a.target);
      if (mine) {
        const c = lastOf(view.me.checks.filter((x) => x.reason === 'lady' && x.target === a.target));
        const good = c && c.shown === 'good';
        const res = add(`act-head lady-${good ? 'good' : 'evil'}`, `The Lady shows you: ${target} is ${good ? 'Good' : 'Evil'}.`);
        res.dataset.tip = 'Only you see this. You may tell the table anything you like — the truth or not.';
        if (view.opts.trickster || view.opts.troublemaker) add('act-sub', 'The Trickster may lie to the Lady, and the Troublemaker must.');
        add('act-sub', 'What do you tell the table? Then the Lady passes to them.');
        const r = row();
        r.append(btn(`“${target} is Good”`, 'vote-yes', () => sendMove({ kind: 'declare', says: 'good' })));
        r.append(btn(`“${target} is Evil”`, 'vote-no', () => sendMove({ kind: 'declare', says: 'evil' })));
        r.append(btn('Say nothing', 'ghost', () => sendMove({ kind: 'declare', says: null })));
      } else {
        add('act-head', `${who}, the Lady of the Lake, has looked at ${target}’s loyalty.`);
        add('act-sub', `Waiting for ${who} to speak.`);
      }
      return;
    }
    case 'recruit':
      if (mine) {
        add('act-head', 'Three Quests have succeeded. First, the Recruitment: name the player you think is the Untrustworthy Servant — tap them.');
        add('act-sub', 'Guess right and they turn Evil, and name Merlin in your place. Guess wrong and you name Merlin yourself.');
        pickRow('Recruit', (t) => sendMove({ kind: 'recruit', target: t }));
      } else add('act-head', `Three Quests have succeeded. ${who}, the Assassin, tries to recruit the Untrustworthy Servant.`);
      return;
    case 'assassinate': {
      const recruited = view.recruit && view.recruit.hit;
      if (mine) {
        add('act-head', recruited ? 'You have been recruited: you are Evil now. Name Merlin, and Evil wins.' : 'Three Quests have succeeded. You are the Assassin: name Merlin, and Evil wins.');
        if (view.opts.messengers) {
          const r = row();
          r.append(btn('Go after Merlin', mode === 'merlin' ? 'primary small' : 'ghost small', () => { mode = 'merlin'; aims = []; renderGame(lastView, session); }));
          r.append(btn('Go after the Messengers', mode === 'messengers' ? 'primary small' : 'ghost small', () => { mode = 'messengers'; aim = null; renderGame(lastView, session); }));
        }
        if (mode === 'messengers' && view.opts.messengers) {
          add('act-sub', 'Name both Good Messengers — tap two players. Both must be right.');
          const r = row();
          r.append(btn(aims.length === 2 ? `Name ${namesOf(view, aims)}` : 'Name two…', 'quest-no', () => { const m = aims.slice(); aims = []; sendMove({ kind: 'assassinate', messengers: m }); }, aims.length !== 2));
        } else {
          add('act-sub', 'Tap the player you name. Your fellow agents of Evil can help you in the chat.');
          const r = row();
          r.append(btn(aim != null ? `Name ${seatName(view, aim)} as Merlin` : 'Name Merlin…', 'quest-no', () => { const t = aim; aim = null; sendMove({ kind: 'assassinate', target: t }); }, aim == null));
        }
      } else {
        add('act-head', `Three Quests have succeeded — but Evil has one last chance. ${who} ${recruited ? '(recruited) ' : ''}will name Merlin${view.opts.messengers ? ', or both Good Messengers' : ''}.`);
        if (view.me && view.me.role === 'merlin') add('act-sub', 'Hold your nerve.');
      }
      return;
    }
    default:
      add('act-head', `${who} is deciding.`);
  }
}

// ---------------------------------------------------------------- the vote record

// Every Team put to the vote: who led, who was on it, how each player voted —
// the record a table keeps on paper to catch the agents of Evil.
function renderTracker(view) {
  const host = $('#tracker');
  host.replaceChildren();
  host.append(el('div', 'side-title', 'Votes'));
  if (!view.proposals.length && view.phase !== 'vote') {
    host.append(el('p', 'dim tr-empty', 'Every Team put to the vote, and how each player voted, shows up here.'));
    return;
  }
  const wrap = el('div', 'tr-wrap');
  const tbl = el('table', 'tracker');
  const head = el('tr');
  head.append(el('th', '', ''));
  for (const p of view.players) {
    const th = el('th', p.seat === view.you ? 'me' : '', p.name.slice(0, 3));
    th.dataset.tip = p.name;
    head.append(th);
  }
  head.append(el('th', '', ''));
  tbl.append(head);
  const addRow = (label, pr, live) => {
    const tr = el('tr', live ? 'live' : '');
    tr.append(el('th', '', label));
    for (const p of view.players) {
      const v = live ? (view.chargeVotes && p.seat in view.chargeVotes ? view.chargeVotes[p.seat] : undefined) : pr.votes[p.seat];
      const td = el('td', v === undefined ? '' : v ? 'yes' : 'no');
      const bits = [];
      if (pr.leader === p.seat) bits.push('♛');
      if (pr.team.includes(p.seat)) bits.push(pr.excalibur === p.seat ? '⚔' : '◆');
      td.textContent = bits.join('');
      if (live && view.voted.includes(p.seat)) td.classList.add('in');
      td.dataset.tip = `${p.name}${pr.leader === p.seat ? ', the Leader,' : ''}${pr.team.includes(p.seat) ? ` (on the Team${pr.excalibur === p.seat ? ', with Excalibur' : ''})` : ''}${v === undefined ? (live ? (view.voted.includes(p.seat) ? ' has voted.' : ' has not voted yet.') : '.') : ` voted to ${v ? 'approve' : 'reject'}.`}`;
      tr.append(td);
    }
    let res = '';
    if (live) res = 'voting';
    else if (!pr.approved) res = 'rejected';
    else if (pr.vetoed != null) res = 'King Returns';
    else {
      const r = view.results[pr.quest];
      res = r ? (r.success ? 'Quest ✓' : `Quest ✗${r.fails > 1 ? ` ${r.fails}` : ''}`) : 'on Quest';
    }
    const td = el('td', `tr-res ${live ? '' : !pr.approved || pr.vetoed != null ? 'rej' : view.results[pr.quest] ? (view.results[pr.quest].success ? 'won' : 'lost') : 'ok'}`, res);
    if (pr.vetoed != null) td.dataset.tip = `${seatName(view, pr.vetoed)} played The King Returns and turned the approved Team back.`;
    tr.append(td);
    tbl.append(tr);
  };
  for (const pr of view.proposals) addRow(`${pr.quest + 1}.${pr.attempt}`, pr, false);
  if (view.phase === 'vote') addRow(`${view.quest + 1}.${view.rejects + 1}`, { leader: view.leader, team: view.team, excalibur: view.excalibur, votes: {} }, true);
  wrap.append(tbl);
  host.append(wrap);
  host.append(el('p', 'tr-key dim', `♛ Leader · ◆ on the Team${view.opts.excalibur ? ' · ⚔ Excalibur' : ''} · green approved, red rejected`));
}

// ---------------------------------------------------------------- your Character

function showRole(view) {
  const mine = view.me;
  if (!mine) return;
  const body = $('#role-body');
  body.replaceChildren();
  const r = mine.role;
  const card = el('div', `role-card side-${mine.side}`);
  card.append(el('div', 'rc-icon', ROLE_ICON[r]));
  card.append(el('div', 'rc-name', roleName(r)));
  const turned = mine.side !== sideOf(r);
  card.append(el('div', 'rc-side', `${mine.side === 'good' ? 'Loyal to Arthur — Good' : 'Servant of Mordred — Evil'}${turned ? ' (for now)' : ''}`));
  card.append(el('p', 'rc-power', ROLES[r].power));
  body.append(card);
  const k = mine.knows;
  const by = (m) => Object.keys(k).filter((s) => k[s] === m).map(Number);
  const facts = [];
  const evil = by('evil');
  if (r === 'merlin') facts.push(evil.length ? `You see the agents of Evil: ${namesOf(view, evil)}.${view.opts.mordred ? ' Mordred is among them unseen.' : ''}${view.opts.untrustworthy ? ' One you see may be the Untrustworthy Servant, who is Good.' : ''}` : 'You see no agents of Evil.');
  else if (sideOf(r) === 'evil' && evil.length) facts.push(`Your fellow agents of Evil: ${namesOf(view, evil)}.`);
  else if (r === 'oberon' || r === 'rogueEvil' || (r === 'sorcererEvil' && view.opts.sorcererHidden)) facts.push('You do not know your fellow agents of Evil, and they do not know you.');
  if (by('merlin?').length) facts.push(`Merlin is ${namesOf(view, by('merlin?')).replace(' and ', ' or ')} — the other is Morgana.`);
  if (by('merlin').length) facts.push(`Merlin is ${namesOf(view, by('merlin'))}.`);
  if (by('assassin').length) facts.push(`The Assassin is ${namesOf(view, by('assassin'))}.`);
  if (by('junior').length) facts.push(`The Junior Messenger is ${namesOf(view, by('junior'))}.`);
  for (const m of ['lancelot-good', 'lancelot-evil']) if (by(m).length) facts.push(`${namesOf(view, by(m))} holds the ${m === 'lancelot-good' ? 'Good' : 'Evil'} Lancelot card.`);
  if ((r === 'lancelotGood' || r === 'lancelotEvil') && view.switches) facts.push(`The Lancelots have switched sides ${view.switches === 1 ? 'once' : `${view.switches} times`}: you are ${mine.side === 'good' ? 'Good' : 'Evil'} now.`);
  for (const c of mine.checks) facts.push(`${REASON[c.reason] ? REASON[c.reason].charAt(0).toUpperCase() + REASON[c.reason].slice(1) : 'A check'}: ${seatName(view, c.target)} showed you ${c.shown === 'good' ? 'Good' : 'Evil'}.`);
  for (const l of mine.looks) facts.push(`${{ excalibur: 'Excalibur', ambush: 'Ambush', trap: 'As the Trapper' }[l.kind]} on Quest ${l.quest + 1}: ${seatName(view, l.target)} had played ${CARDS[l.card].name}.`);
  if (!facts.length) facts.push('No one is revealed to you: watch the votes and the Quests.');
  const ul = el('ul', 'rc-facts');
  for (const f of facts) ul.append(el('li', '', f));
  body.append(ul);
  const win = r === 'rogueGood' ? 'You win alone with Rogue Success on the third successful Quest and on one before; otherwise you share Good’s victory in part.'
    : r === 'rogueEvil' ? 'You win alone with Rogue Fail on the third failed Quest and on one before; otherwise you share Evil’s victory in part.'
      : mine.side === 'good' ? 'Good wins with three successful Quests — and Merlin unfound by the Assassin.'
        : 'Evil wins with three failed Quests, five Teams rejected in one round, or by naming Merlin at the end.';
  body.append(el('p', 'rc-win', win));
  $('#modal-role').classList.remove('hidden');
}

function renderGame(view, sess) {
  lastView = view;
  renderDcBanner(view, sess);
  renderObBar(view, sess);
  renderWatchChip(view);
  ensureResignBtn(sess);
  if (viewMid !== view.mid) {
    viewMid = view.mid;
    pick = [];
    excal = null;
    aim = null;
    aims = [];
    card = null;
    mode = 'merlin';
    lastFxSeq = view.fx ? view.fx.seq : 0;
  }
  // picks belong to the question they were made for
  const key = view.ask ? `${view.ask.kind}:${view.ask.seat}:${view.quest}:${view.rejects}` : view.phase;
  if (key !== askKey) {
    askKey = key;
    pick = [];
    excal = null;
    aim = null;
    aims = [];
  }

  $('#room-chip').textContent = view.code || '·····';
  const qc = $('#quest-chip');
  const won = view.results.filter((r) => r.success).length;
  qc.textContent = ['over', 'assassin', 'recruit'].includes(view.phase) ? `Quests: Arthur ${won}, Mordred ${view.results.length - won}` : `Quest ${view.quest + 1} of 5`;
  qc.dataset.tip = `${view.n} players: ${view.sides[0]} Good, ${view.sides[1]} Evil. Teams of ${view.sizes.join(', ')}.`;
  const pc = $('#phase-chip');
  pc.textContent = (view.ask && ASK_LABEL[view.ask.kind]) || PHASE[view.phase] || '';
  pc.dataset.tip = {
    team: 'The Leader chooses the Team for this Quest.',
    vote: 'Everyone votes on the Team at once. A majority approves it; a tie rejects it.',
    quest: 'The Team plays Quest cards face down. One Fail fails the Quest.',
    onquest: 'The Quest is under way.',
    lady: 'The Lady of the Lake looks at one player’s loyalty.',
    recruit: 'The Assassin tries to recruit the Untrustworthy Servant.',
    assassin: 'Three Quests have succeeded; Evil names Merlin. If right, Evil wins.',
    over: '',
  }[view.phase] || '';
  $('#btn-role').classList.toggle('hidden', !view.me);

  renderBoard(view);
  renderAction(view);
  renderTracker(view);
  renderLog(view);
  paintChatBubbles();
  retip();

  if (view.fx && view.fx.seq !== lastFxSeq) {
    lastFxSeq = view.fx.seq;
    const fx = view.fx;
    if (fx.kind === 'vote') flash(fx.approved ? `Team approved ${fx.yes}–${fx.no}` : `Team rejected ${fx.yes}–${fx.no}${fx.rejects ? ` · Vote Track ${fx.rejects} of 5` : ''}`, fx.approved ? 'good' : 'bad');
    else if (fx.kind === 'quest') flash(fx.success ? `Quest ${fx.quest + 1} succeeds${fx.magic % 2 ? ' — by Magic' : fx.fails ? ` — ${fx.fails} Fail, ${fx.needed} needed` : ''}` : `Quest ${fx.quest + 1} fails${fx.magic % 2 ? ' — by Magic' : ` — ${fx.fails} Fail card${fx.fails === 1 ? '' : 's'}`}`, fx.success ? 'good' : 'bad');
    else if (fx.kind === 'assassin') flash('Three Quests won — Evil’s last chance', 'plain');
    else if (fx.kind === 'declare' && fx.says) flash(`${seatName(view, fx.holder)}: “${seatName(view, fx.target)} is ${fx.says === 'good' ? 'Good' : 'Evil'}”`, 'plain');
    else if (fx.kind === 'switch') flash('Switch Allegiance — the Lancelots change sides', 'plain');
    else if (fx.kind === 'reveal') flash(`${seatName(view, fx.seat)} is the Revealer`, 'bad');
    else if (fx.kind === 'recruit') flash(fx.hit ? `${seatName(view, fx.target)} is recruited to Evil` : `${seatName(view, fx.target)} is not the Untrustworthy Servant`, fx.hit ? 'bad' : 'plain');
    else if (fx.kind === 'excalibur') flash(`${seatName(view, fx.seat)} wields Excalibur`, 'plain');
    else if (fx.kind === 'plot' && !fx.given) flash(`${seatName(view, fx.seat)} plays ${plotName(fx.type)}`, 'plain');
  }

  // the reveal: everyone sees their Character once, as a game starts
  if (roleShownFor !== view.mid && view.me && view.phase !== 'over') {
    roleShownFor = view.mid;
    showRole(view);
  }
  settleOverlay('#gameover', view.phase === 'over', () => showGameover(view, sess));
}

// ---------------------------------------------------------------- game over

let confettiDone = false;

function showGameover(view, sess) {
  const m = $('#gameover');
  m.classList.remove('hidden');
  const mine = view.me;
  const meP = view.players.find((p) => p.seat === view.you);
  const solo = view.winner === 'rogueGood' || view.winner === 'rogueEvil';
  const iWon = mine && meP && (solo ? meP.role === view.winner : meP.side === view.winner);
  const partial = mine && view.partial.includes(view.you);
  const w = { good: 'Good', evil: 'Evil', rogueGood: 'The Good Rogue', rogueEvil: 'The Evil Rogue' }[view.winner];
  $('#go-title').textContent = `${w} wins${mine && !isObserver(view) ? (iWon ? (partial ? ' — a partial victory for you' : ' — so do you!') : ' — you lose') : ''}`;
  $('#go-title').className = `win-${view.winner === 'rogueGood' ? 'good' : view.winner === 'rogueEvil' ? 'evil' : view.winner}`;
  $('#go-sub').textContent = view.why ? view.why.charAt(0).toUpperCase() + view.why.slice(1) + '.' : '';
  const list = $('#go-rank');
  list.replaceChildren();
  const winner = (p) => (solo ? p.role === view.winner : p.side === view.winner);
  const order = view.players.slice().sort((a, b) => (winner(a) ? 0 : 1) - (winner(b) ? 0 : 1));
  for (const p of order) {
    const row = el('li', `rank-row side-${p.side}${p.seat === view.you ? ' me' : ''}`);
    row.append(avatarEl(p.name, p.seat, p.bot));
    row.append(el('span', 'rank-name', p.name + (p.connected || p.bot ? '' : ' (left)')));
    const r = el('span', 'rank-score');
    r.append(el('span', 'role-ic', ROLE_ICON[p.role]), document.createTextNode(` ${roleName(p.role)}`));
    if (p.side !== sideOf(p.role)) r.append(el('span', 'go-named', ` · ${p.side === 'good' ? 'Good' : 'Evil'} at the end`));
    if (view.partial.includes(p.seat)) r.append(el('span', 'go-partial', ' · partial victory'));
    const a = view.assassination;
    if (a && a.target === p.seat) r.append(el('span', 'go-named', ' · named as Merlin'));
    if (a && a.messengers && a.messengers.includes(p.seat)) r.append(el('span', 'go-named', ' · named'));
    row.append(r);
    list.append(row);
  }
  $('#btn-again').classList.toggle('hidden', !sess.isHost);
  $('#btn-golobby').classList.toggle('hidden', !sess.isHost);
  $('#go-wait').classList.toggle('hidden', sess.isHost);
  if (iWon && !confettiDone && !isObserver(view)) {
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
  localStorage.setItem('avl-name', name);
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
  localStorage.setItem('avl-name', name);
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
  $('#name-input').value = localStorage.getItem('avl-name') || '';
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
