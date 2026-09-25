// app.js — networking + UI for 7 Wonders.
//
// Topology: host-authoritative star over WebRTC data channels.
//   - The host's browser owns the game state and validates every move.
//   - Guests connect straight to the host (peer-to-peer); no game server.
//   - NAT traversal uses Google's public STUN servers (see RTC_CONFIG).
//   - Peer discovery/signaling uses the free PeerJS cloud broker, because
//     GitHub Pages can only serve static files.
//
// 7 Wonders is simultaneous: everybody picks at once and the turn resolves when
// the last of them has. That makes the waiting state the important one to show
// — you always want to know who the table is waiting for.

import {
  PROTO,
  MIN_PLAYERS,
  MAX_PLAYERS,
  SIDE_MODES,
  RES_NAME,
  COLOUR_NAME,
  seatLimit,
  canStart,
  newMatch,
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
// Every knob here changes something you can see. That is not a given: this
// list and the code that read it were built from Skull King's, which has bids,
// tricks, a forced last card and a talking table — none of which 7 Wonders has
// — and the two halves had drifted onto disjoint names. cfg.range returns 0 for
// a key nobody declared and cfg.raw returns undefined, so the reads that missed
// were not loud about it: bots simply acted with no delay at all.
const cfg = initSettings('swd', [
  { key: 'botDelay', label: 'Bot thinking delay', def: [700, 500], section: 'Host pacing', host: true, hint: 'Everybody chooses at once, but the bots still choose one after another so you can read the table filling in.' },
  { key: 'revealHold', label: 'Hold on the reveal', def: 2200, section: 'Host pacing', host: true, hint: 'How long the table shows what everybody just played before the bots start the next turn.' },
  { key: 'stepBots', label: 'Bots wait for a click', def: false, bool: true, section: 'Testing', host: true, hint: 'Bots stop before every choice and wait for you to click the table. Use it to watch one decision at a time. Your own hand still works — click the background, not a card.' },
  { key: 'revealBots', label: 'Show bot hands', def: false, bool: true, section: 'Testing', host: true, hint: 'Turn the bots\' hands, and their undrafted leaders, face up while the Age is still being played. Only the host builds views, so this reveals them to everyone at the table.' },
  { key: 'bubbleChat', label: 'Chat bubbles linger', def: 6500, section: 'Bubbles' },
  { key: 'bubbleTrunc', label: 'Bubble text cap', def: 84, min: 12, max: 400, step: 4, unit: 'ch', ms: false, section: 'Bubbles' },
  { key: 'overlayDelay', label: 'Age / final tally delay', def: 3200, section: 'Overlays' },
]);

// Testing: what the host chooses to put in everybody's view. Only the host
// builds views, so turning bot hands face up turns them face up for the table.
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
const ID_PREFIX = 'swd-v1-';
const BOT_NAMES = ['Hypatia', 'Vitruvius', 'Imhotep', 'Archimedes', 'Nefertiti', 'Zenobia', 'Croesus', 'Sappho'];
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
  if (bot) return el('div', 'av bot', '\u{1F3FA}');
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

// Chat also floats briefly over the sender's seat. Kept in a map (not the
// DOM) so bubbles survive the re-render every state update triggers.
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
      bub.classList.toggle('say', !!b.say);
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
    say: !!m.say,
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
let lastSess = null;
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
    this.opts = { cities: false, leaders: false, teams: false, sideMode: 'random' };
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
    if (msg.t === 'next') this.again(seat);
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

  // The table stalls on a disconnected player's bid or play until they
  // return — unless the host hands their seat to a bot.
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
    if (!this.claimOk(w, seat)) return err("You have watched other players' hands \u2014 you can only take the seat you have been watching from the start.");
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
      toast('The crew is full');
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

  setOpts(patch) {
    if (this.G) return;
    this.opts = { ...this.opts, ...patch };
    this.pushLobby();
  }

  // Whose input the game waits on. Bidding is simultaneous, so any unbid bot
  // (or disconnected player) is fair game; tricks have a single turn seat.
  // Everyone chooses at once, so there is no single seat to wait on: any
  // bot-covered seat that has not chosen yet is fair game.
  botActor() {
    const g = this.G;
    if (!g || !['play', 'draft', 'recruit', 'choose', 'lastcard'].includes(g.phase)) return null;
    const pending = waitingOn(g).filter((seat) => this.seatCovered(seat));
    return pending.length ? pending[0] : null;
  }

  // Bots think in the host's browser. Everybody chooses at once, so there is
  // no turn to take — but they still choose one at a time, because a table
  // that fills in all at once is unreadable.
  scheduleBots() {
    clearTimeout(this.botTimer);
    this.stepPending = false;
    if (!this.G) { paintStep(); return; }
    if (this.botActor() == null) { paintStep(); return; }
    // Stepping: set no timer at all, just mark that a bot is holding and wait
    // to be nudged. Advertised only when a bot actually has something to do.
    if (cfg.on('stepBots')) {
      this.stepPending = true;
      paintStep();
      return;
    }
    paintStep();
    let delay = cfg.range('botDelay');
    // ... and never before the table has finished showing the last reveal, or
    // the Age tally has been up long enough to read.
    if (this.holdUntil) delay = Math.max(delay, this.holdUntil - Date.now());
    this.botTimer = setTimeout(() => this.tickBot(), delay);
  }

  // one click, one bot choice
  step() {
    if (!this.stepPending) return;
    this.stepPending = false;
    paintStep();
    this.tickBot();
  }

  tickBot() {
    if (!this.G) return;
    const seat = this.botActor();
    if (seat == null) return;
    const move = botChoose(this.G, seat);
    if (move) {
      const res = applyMove(this.G, seat, move);
      if (!res.ok) {
        // never stall the table: the simplest legal move in this phase
        const p = this.G.players.find((q) => q.seat === seat);
        const ph = this.G.phase;
        if (ph === 'draft' && p.draft[0]) applyMove(this.G, seat, { kind: 'draft', cardId: p.draft[0].id });
        else if (ph === 'recruit' && p.leaders[0]) applyMove(this.G, seat, { kind: 'pick', how: 'discard', cardId: p.leaders[0].id });
        else if (p.hand[0]) applyMove(this.G, seat, { kind: 'pick', how: 'discard', cardId: p.hand[0].id });
      }
    }
    this.broadcast();
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
    this.G = newMatch(this.roster, this.opts);
    this.broadcast();
  }

  again() {
    if (!this.G || this.G.phase !== 'over') return;
    this.roster = this.roster.filter((p) => p.connected || p.bot);
    if (this.roster.length < MIN_PLAYERS) {
      this.toLobby();
      toast('Not enough players — back to the lobby');
      return;
    }
    this.G = newMatch(this.roster, this.opts);
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

  // Two moments are worth stopping for, and the fx counter is the only thing
  // that says a moment is NEW: everyone's choices turning face up, and the Age
  // tally. Both put a hold on the bots so the table is not three cards further
  // on by the time you have read it.
  broadcast() {
    const fx = this.G && this.G.fx;
    if (fx && fx.seq !== this._holdFxSeen) {
      this._holdFxSeen = fx.seq;
      const wait = fx.kind === 'reveal' ? cfg('revealHold')
        : fx.kind === 'military' ? cfg('overlayDelay')
        : 0;
      if (wait) this.holdUntil = Math.max(this.holdUntil || 0, Date.now() + wait);
    }
    const opts = viewOpts();
    const wnames = this.watchers.map((x) => x.name);
    for (const [seat, conn] of this.conns) {
      try {
        conn.send({ t: 'state', view: { ...viewFor(this.G, seat, this.code, opts), watchers: wnames } });
      } catch {}
    }
    for (const w of this.watchers) this.sendWatcher(w);
    pendingMove = false;
    showScreen('game');
    renderGame({ ...viewFor(this.G, 0, this.code, opts), watchers: wnames }, this);
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

  localNext() {
    this.again(0);
  }

  destroy() {
    clearInterval(this.hb);
    clearTimeout(this.botTimer);
    clearTimeout(this.autoNextTimer);
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
            full: 'That crew is full (8 players max).',
            'in-progress': 'That voyage has already set sail.',
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

  localNext() {
    try {
      this.conn.send({ t: 'next' });
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

const REJOIN_KEY = 'swd-rejoin';

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


const EXPANSIONS = [
  { key: 'cities', name: 'Cities', blurb: 'Black cards, debt and diplomacy, plus the Byzantium and Petra boards. Hands are eight cards, so you play seven an Age instead of six — and it brings the eighth seat, which the base box cannot deal.' },
  { key: 'leaders', name: 'Leaders', blurb: 'Draft four leaders before Age I, then play one at the start of every Age: recruit it for coins, bury it under your wonder, or sell it for 3. Everyone starts with 6 coins instead of 3, and the fourth leader is never played. It also brings Roma, who hires cheaply and has no starting resource at all, and Abu Simbel, who seals leaders under the board for twice what they cost. The six Cities leaders join the deck only when Cities does.' },
  { key: 'teams', name: 'Teams', blurb: 'Pairs sitting side by side, scoring together. You never fight your partner, so the one border you do have counts double. 4, 6 or 8 players.' },
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
  const opts = lob.opts || {};
  const list = $('#lobby-players');
  list.replaceChildren();
  const mySeat = sess.isHost ? 0 : sess.seat;
  const { max } = seatLimit(opts);
  for (let i = 0; i < max; i++) {
    const p = lob.players[i];
    const row = el('li', `seat-row${p ? '' : ' empty'}`);
    if (p) {
      row.dataset.seat = String(p.seat);
      row.append(avatarEl(p.name, p.seat, p.bot));
      row.append(el('span', 'seat-name', p.name));
      // partners sit side by side, so the pairing is seat/2 rather than seat%2
      if (opts.teams) {
        const t = Math.floor(p.seat / 2);
        row.append(el('span', `chip team t${t % 2}`, `team ${t + 1}`));
      }
      if (p.seat === 0) row.append(el('span', 'chip', 'host'));
      if (p.bot) row.append(el('span', 'chip bot', 'bot'));
      if (p.seat === mySeat) row.append(el('span', 'chip you', 'you'));
      if (p.bot && sess.isHost) {
        const kick = el('button', 'kick', '✕');
        kick.type = 'button';
        kick.title = `Remove ${p.name}`;
        kick.addEventListener('click', () => sess.removeBot(p.seat));
        row.append(kick);
      }
    } else {
      row.append(el('div', 'av empty', '·'), el('span', 'seat-name dim', 'Empty seat'));
    }
    list.append(row);
  }

  const ep = $('#exp-picker');
  ep.replaceChildren();
  for (const x of EXPANSIONS) {
    const b = el('button', `pick${opts[x.key] ? ' on' : ''}`, x.name);
    b.type = 'button';
    b.disabled = !sess.isHost;
    b.title = x.blurb;
    if (sess.isHost) b.addEventListener('click', () => sess.setOpts({ [x.key]: !opts[x.key] }));
    ep.append(b);
  }
  const on = EXPANSIONS.filter((x) => opts[x.key]);
  $('#exp-blurb').textContent = on.length ? on.map((x) => x.blurb).join(' ') : 'The base game: 3 to 7 players.';

  const sp = $('#side-picker');
  sp.replaceChildren();
  for (const m of SIDE_MODES) {
    const b = el('button', `pick${(opts.sideMode || 'random') === m.key ? ' on' : ''}`, m.name);
    b.type = 'button';
    b.disabled = !sess.isHost;
    if (sess.isHost) b.addEventListener('click', () => sess.setOpts({ sideMode: m.key }));
    sp.append(b);
  }
  $('#side-blurb').textContent = (SIDE_MODES.find((m) => m.key === (opts.sideMode || 'random')) || SIDE_MODES[0]).blurb;

  $('#btn-start').classList.toggle('hidden', !sess.isHost);
  $('#btn-add-bot').classList.toggle('hidden', !sess.isHost);
  const why = canStart(lob.players.length, opts);
  if (sess.isHost) {
    $('#btn-start').disabled = !!why;
    $('#btn-add-bot').disabled = lob.players.length >= max;
  }
  $('#lobby-hint').textContent = sess.isHost
    ? (why || `${lob.players.length} players — three Ages, most points wins. Begin whenever you like.`)
    : 'Waiting for the host to begin…';
  paintChatBubbles();
}

// ---------------------------------------------------------------- cards

// Resource letters get their own colour so a cost reads as a shape rather than
// a word — you learn to see "two brown, one grey" without reading it.
const RES_CLASS = { W: 'r-wood', S: 'r-stone', C: 'r-clay', O: 'r-ore', G: 'r-glass', P: 'r-papyrus', T: 'r-textile' };
const SCI_GLYPH = { compass: '🧭', gear: '⚙', tablet: '📜', any: '★' };

function resRow(spec, cls = '') {
  const row = el('span', `res ${cls}`);
  if (!spec) return row;
  for (const part of spec.split('/').length > 1 ? [spec] : spec.split('')) {
    if (part.includes('/')) {
      const wrap = el('span', 'res-choice');
      part.split('/').forEach((r, i) => {
        if (i) wrap.append(el('span', 'res-slash', '/'));
        wrap.append(el('span', `res-chip ${RES_CLASS[r]}`, r));
      });
      row.append(wrap);
    } else {
      row.append(el('span', `res-chip ${RES_CLASS[part]}`, part));
    }
  }
  return row;
}

const ROMAN = { 1: 'I', 2: 'II', 3: 'III' };

// The one-line summary of what a card actually does.
function cardGist(c) {
  const bits = [];
  if (c.vp) bits.push(`${c.vp} VP`);
  if (c.shield) bits.push(`${c.shield} shield${c.shield > 1 ? 's' : ''}`);
  if (c.sci) bits.push(SCI_GLYPH[c.sci]);
  if (c.coins) bits.push(`${c.coins} coins`);
  if (c.trade) bits.push(`buy ${c.trade.kind === 'raw' ? 'materials' : 'goods'} at 1 (${c.trade.with})`);
  if (c.mask) bits.push(`${c.mask} mask${c.mask > 1 ? 's' : ''} — copy a neighbour's science`);
  if (c.loss) bits.push(`everyone else loses ${c.loss}`);
  if (c.perLoss) bits.push(`everyone else loses ${c.perLoss.coins} per ${c.perLoss.of === 'victory' ? 'victory token' : c.perLoss.of}`);
  if (c.diplo) bits.push('diplomacy — sit out a conflict');
  if (c.nbCoins) bits.push(`neighbours take ${c.nbCoins}`);
  if (c.rebate) bits.push(`1 off the first buy each turn (${c.rebate.with})`);
  if (c.smuggle) bits.push("1 off a neighbour's own board resource, every time");
  if (c.produceMissing) bits.push('produces what your city cannot');
  if (c.produceOwn) bits.push('one more a turn of something your city already makes');
  if (c.freeStages) bits.push('wonder stages cost no resources');
  if (c.discount) bits.push(`one fewer resource for ${c.discount.of === 'stage' ? 'wonder stages' : c.discount.of + ' cards'}`);
  if (c.freeColour) bits.push(`${c.freeColour} cards cost nothing`);
  if (c.freeColourAge) bits.push(`one free ${c.freeColourAge} card an Age`);
  if (c.freeLeaders) bits.push('later leaders cost nothing');
  if (c.bankBuy) bits.push('one resource a turn from the bank, for 1');
  if (c.bonusCoin) bits.push('once a turn, one extra coin from the bank');
  if (c.onBuild) bits.push(`${c.onBuild.coins} coins for every ${c.onBuild.of} card you build`);
  if (c.onChain) bits.push(`${c.onChain.coins} coins every time a chain makes a card free`);
  if (c.onStage) bits.push(`${c.onStage.coins} coins a wonder stage${c.onStage.others ? `, everyone else loses ${c.onStage.others}` : ''}`);
  if (c.onWin) bits.push(`${c.onWin.coins} coins for every victory token`);
  if (c.token) bits.push(`a victory token for ${c.token === 'age' ? 'the current Age' : 'Age ' + ROMAN[c.token]}, without a fight`);
  if (c.nbDebt) bits.push(`each neighbour takes ${c.nbDebt > 1 ? c.nbDebt + ' debts' : 'a debt'}`);
  if (c.vpPerToken) bits.push(`${c.vpPerToken.vp} VP per Age ${ROMAN[c.vpPerToken.age]} victory token`);
  if (c.coinsPerDefeat) bits.push(`${c.coinsPerDefeat} coins for each defeat token${c.purgeDefeats ? ', which are then discarded' : ''}`);
  if (c.purge) bits.push('burn your defeats; everyone else gives up a victory');
  if (c.deflect) bits.push('your defeats go to whoever beat you');
  if (c.lossAge) bits.push('everyone else loses coins equal to the Age');
  if (c.sciSwap) bits.push('turn one science symbol into another at the end');
  if (c.sciMost) bits.push('one more of whichever science symbol you have most of');
  if (c.sciSetVp) bits.push(`${c.sciSetVp} VP per complete science set`);
  if (c.setVp) bits.push(`${c.setVp.vp} VP per set of ${c.setVp.of.join(' + ')}`);
  if (c.vpPerCoins) bits.push(`1 VP per ${c.vpPerCoins} coins, on top of the usual`);
  if (c.mostVp) bits.push(`${c.mostVp.vp} VP for more ${c.mostVp.of} than BOTH neighbours`);
  if (c.cleanVp) bits.push(`${c.cleanVp} VP if you never lose a conflict`);
  if (c.loneVp) bits.push(`${c.loneVp} VP if this stays your only leader`);
  if (c.pairVp) bits.push('VP per matching pair of victory tokens, at their value');
  if (c.vpIfWonder) bits.push(`${c.vpIfWonder} VP if your wonder is finished`);
  if (c.per) {
    const per = [];
    if (c.per.coins) per.push(`${c.per.coins} coin${c.per.coins > 1 ? 's' : ''}`);
    if (c.per.vp) per.push(`${c.per.vp} VP`);
    bits.push(`${per.join(' + ')} per ${c.per.of} (${c.per.from.replace('+', ' & ')})`);
  }
  return bits.join(' · ');
}

function cardEl(c, { mini = false, age = 0 } = {}) {
  const d = el('div', `swcard ${c.c}${mini ? ' mini' : ''}`);
  d.append(el('div', 'sw-name', c.n));
  if (!mini) {
    if (c.give) d.append(resRow(c.give, 'gives'));
    const gist = cardGist(c);
    if (gist) d.append(el('div', 'sw-gist', gist));
    const cost = el('div', 'sw-cost');
    if (c.coin === 'age') {
      const chip = el('span', 'coin-chip', `${age || '?'}`);
      chip.title = 'Costs the current Age: 1 in Age I, 2 in Age II, 3 in Age III';
      cost.append(chip);
    } else if (c.coin) cost.append(el('span', 'coin-chip', `${c.coin}`));
    if (c.cost) cost.append(resRow(c.cost));
    if (!c.coin && !c.cost) cost.append(el('span', 'sw-free', 'free'));
    d.append(cost);
  }
  d.title = `${c.n} — ${COLOUR_NAME[c.c]}${cardGist(c) ? '\n' + cardGist(c) : ''}`;
  return d;
}

// ---------------------------------------------------------------- local UI state

let selCardId = null;
let selHow = null;

function resetChoice() {
  selCardId = null;
  selHow = null;
}

// ---------------------------------------------------------------- cities

const AGE_ROMAN = { 1: 'I', 2: 'II', 3: 'III' };

// A city, compact enough that seven of them fit round the table: the wonder and
// its progress, the money and shields you can be attacked over, and the cards
// stacked by colour the way they sit on a real table.
// What a stage costs, in words: resources, coins, both, or nothing at all.
function stageCostText(st) {
  return [st.cost || '', st.coin ? `${st.coin} coins` : ''].filter(Boolean).join(' + ') || 'free';
}

function cityEl(view, p, tag) {
  const box = el('div', `city${p.seat === view.mySeat ? ' mine' : ''}`);
  const head = el('div', 'city-head');
  head.append(avatarEl(p.name, p.seat, p.bot));
  head.append(el('span', 'city-name', p.name));
  if (tag) head.append(el('span', `chip nb ${tag}`, tag));
  if (view.partner != null && p.seat === view.partner) head.append(el('span', 'chip mate', 'partner'));
  if (view.opts && view.opts.teams) head.append(el('span', `chip team t${p.team}`, `T${p.team + 1}`));
  if (!p.connected && !p.bot) head.append(el('span', 'chip off', 'away'));
  if (p.picked && view.phase === 'play') head.append(el('span', 'chip ready', '✓'));
  box.append(head);

  const stat = el('div', 'city-stat');
  stat.append(el('span', 'coin-chip', `${p.coins}`));
  stat.append(el('span', 'shield-chip', `⚔ ${p.shields}`));
  const wins = p.tokens.filter((t) => t > 0).reduce((a, b) => a + b, 0);
  const losses = p.tokens.filter((t) => t < 0).length;
  if (wins || losses) stat.append(el('span', 'tok-chip', `${wins ? '+' + wins : ''}${losses ? ' −' + losses : ''}`.trim()));
  if (p.debt) stat.append(el('span', 'debt-chip', `debt ${p.debt}`));
  if (p.diplo) stat.append(el('span', 'diplo-chip', `☮ ${p.diplo}`));
  if (p.leaders) stat.append(el('span', 'lead-chip', `👤 ${p.leaders}`));
  box.append(stat);

  const w = el('div', 'city-wonder');
  const wn = el('span', 'w-name', `${p.wonder} ${p.side}`);
  // Roma is the only board whose power is printed on the board rather than
  // granted by a stage, and the only one with no starting resource to show.
  if (p.power) {
    wn.title = p.power.freeLeaders
      ? 'Recruits every leader for nothing'
      : `Leaders cost ${p.power.leaderOff} less here, and ${p.power.nbLeaderOff} less for each neighbour`;
    wn.classList.add('w-power');
  }
  w.append(wn);
  w.append(resRow(p.wonderRes, 'w-res'));
  const pips = el('span', 'w-pips');
  for (let i = 0; i < p.stages.length; i++) {
    const pip = el('span', `pip${i < p.stagesBuilt ? ' on' : ''}`);
    pip.title = i < p.stagesBuilt ? `Stage ${i + 1} built` : `Stage ${i + 1}: ${stageCostText(p.stages[i])}`;
    pips.append(pip);
  }
  w.append(pips);
  box.append(w);

  // built cards, grouped the way they fan out on the table
  const cards = el('div', 'city-cards');
  const order = ['brown', 'grey', 'blue', 'yellow', 'red', 'green', 'purple', 'black', 'white'];
  for (const colour of order) {
    const of = p.built.filter((c) => c.c === colour);
    if (!of.length) continue;
    const stack = el('div', `stack ${colour}`);
    stack.title = `${COLOUR_NAME[colour]}\n` + of.map((c) => `· ${c.n}${c.fromPile ? ' (out of the discard)' : ''}`).join('\n');
    stack.append(el('span', 'stack-n', String(of.length)));
    for (const c of of) stack.append(el('span', 'stack-card', c.n));
    cards.append(stack);
  }
  if (!p.built.length) cards.append(el('span', 'dim', 'nothing built yet'));
  box.append(cards);

  // Testing only: the host has turned this bot's hand face up.
  if (p.peek) {
    for (const [label, names] of [['holding', p.peek.hand], ['leaders', p.peek.leaders], ['drafting', p.peek.draft]]) {
      if (!names || !names.length) continue;
      box.append(el('div', 'city-peek', `${label}: ${names.join(' · ')}`));
    }
  }
  return box;
}

// ---------------------------------------------------------------- hand

// A row of leaders with buttons under each: the draft offers one button, the
// recruitment phase the same three an Age card gets. The cards themselves are
// drawn by the same cardEl as everything else — a leader is a white card.
function leaderRow(view, cards, buttons) {
  const hand = $('#hand');
  for (const c of cards) {
    const wrap = el('div', 'hand-card');
    wrap.append(cardEl(c, { age: view.age }));
    const acts = el('div', 'card-acts');
    for (const b of buttons(c)) acts.append(b);
    wrap.append(acts);
    hand.append(wrap);
  }
}

function actBtn(label, cls, move, why) {
  const b = el('button', `btn tiny ${cls}`, label);
  b.type = 'button';
  b.disabled = !move;
  if (why) b.title = why;
  if (move) b.addEventListener('click', () => sendMove(move));
  return b;
}

function renderDraft(view) {
  leaderRow(view, view.draftHand, (c) => [
    actBtn('Keep', 'go', { kind: 'draft', cardId: c.id }),
  ]);
}

function renderRecruit(view) {
  const byId = new Map(view.leaderOptions.map((o) => [o.id, o]));
  leaderRow(view, view.myLeaders, (c) => {
    const o = byId.get(c.id) || {};
    return [
      actBtn(o.play ? (o.play.coins ? `Recruit · ${o.play.coins}` : 'Recruit · free') : 'Recruit',
             'go', o.play && { kind: 'pick', how: 'play', cardId: c.id }, o.play ? null : o.why),
      actBtn(o.wonder ? (o.wonder.coins ? `Wonder · ${o.wonder.coins}` : 'Wonder · free') : 'Wonder',
             '', o.wonder && { kind: 'pick', how: 'wonder', cardId: c.id }, o.wonder ? null : o.wonderWhy),
      actBtn('Sell · +3', 'sell', { kind: 'pick', how: 'discard', cardId: c.id }),
    ];
  });
}

// Whatever the table is waiting on one player to pick, laid out for that one
// player. Everyone else gets the waiting line and no list at all — which for
// the discard is what the rules say: you take the pile, look through it, and
// put it back without showing anyone.
const CHOICE_VERB = { discard: 'Build · free', bury: 'Seal it in', extra: null };

function renderChoice(view) {
  const s = view.choice;
  if (!s || !s.cards) return;
  leaderRow(view, s.cards, (c) => [actBtn(
    CHOICE_VERB[s.kind] || `Recruit · ${c.coin === 'age' ? view.age : (c.coin || 0)}`,
    'go', { kind: 'choose', cardId: c.id },
  )]);
  if (!s.canPass) return;
  const out = el('div', 'hand-card');
  const face = el('div', 'swcard ghost');
  face.append(el('div', 'sw-name', 'Or nothing'));
  face.append(el('div', 'sw-gist', 'Put the pile back and carry on with the turn.'));
  out.append(face);
  const acts = el('div', 'card-acts');
  acts.append(actBtn('Take nothing', 'sell', { kind: 'choose', how: 'pass' }));
  out.append(acts);
  $('#hand').append(out);
}

function renderHand(view) {
  const hand = $('#hand');
  hand.replaceChildren();
  if (view.phase === 'choose') return renderChoice(view);
  // Babylon's extra card is an ordinary turn with one card in it, so it is
  // drawn by the ordinary hand — but only for whoever is owed it.
  if (view.phase === 'lastcard' && !view.lastCard.includes(view.mySeat)) return;
  if (!['play', 'draft', 'recruit', 'lastcard'].includes(view.phase)) return;
  if (view.iPicked) {
    hand.append(el('div', 'hand-note', 'Chosen — waiting for the others…'));
    return;
  }
  if (view.phase === 'draft') return renderDraft(view);
  if (view.phase === 'recruit') return renderRecruit(view);
  const byId = new Map(view.options.map((o) => [o.id, o]));
  for (const c of view.hand) {
    const o = byId.get(c.id) || {};
    const wrap = el('div', `hand-card${selCardId === c.id ? ' sel' : ''}`);
    wrap.append(cardEl(c));

    const acts = el('div', 'card-acts');
    const build = el('button', 'btn tiny go', o.play
      ? (o.play.chain ? 'Build · free (chain)' : o.play.coins ? `Build · ${o.play.coins}` : 'Build · free')
      : 'Build');
    build.type = 'button';
    build.disabled = !o.play;
    if (!o.play) build.title = o.why || 'Not available';
    else if (o.play.left || o.play.right) {
      build.title = `Pay ${o.play.left ? `${o.play.left} left` : ''}${o.play.left && o.play.right ? ', ' : ''}${o.play.right ? `${o.play.right} right` : ''}`;
    }
    build.addEventListener('click', () => sendMove({ kind: 'pick', how: 'play', cardId: c.id }));
    acts.append(build);

    // Olympia's once-an-Age build, and Caligula's. Offered next to the price
    // rather than instead of it, because which card to spend it on is the
    // whole decision.
    if (o.playFree) {
      const gift = o.playFree.gift;
      const free = el('button', 'btn tiny free', 'Free build');
      free.type = 'button';
      free.title = gift === 'any'
        ? 'Your one free build this Age — any card'
        : `Your one free ${gift} card this Age`;
      free.addEventListener('click', () => sendMove({ kind: 'pick', how: 'free', cardId: c.id }));
      acts.append(free);
    }

    const wonder = el('button', 'btn tiny', o.wonder ? (o.wonder.coins ? `Wonder · ${o.wonder.coins}` : 'Wonder · free') : 'Wonder');
    wonder.type = 'button';
    wonder.disabled = !o.wonder;
    if (!o.wonder) wonder.title = o.wonderWhy || 'Not available';
    wonder.addEventListener('click', () => sendMove({ kind: 'pick', how: 'wonder', cardId: c.id }));
    acts.append(wonder);

    const sell = el('button', 'btn tiny sell', 'Sell · +3');
    sell.type = 'button';
    sell.addEventListener('click', () => sendMove({ kind: 'pick', how: 'discard', cardId: c.id }));
    acts.append(sell);

    wrap.append(acts);
    hand.append(wrap);
  }
}

// ---------------------------------------------------------------- main render

function renderGame(view, sess) {
  lastView = view;
  lastSess = sess;
  $('#room-chip').textContent = view.code;
  if (view.phase === 'choose') {
    const k = view.choice ? view.choice.kind : 'discard';
    $('#age-chip').textContent = `Age ${AGE_ROMAN[view.age]}`;
    $('#turn-chip').textContent = k === 'bury' ? 'Beneath the wonder'
      : k === 'extra' ? 'One more leader' : 'The discard pile';
    $('#pass-chip').textContent = k === 'discard'
      ? `${view.discardCount} card${view.discardCount === 1 ? '' : 's'}` : view.choice.why;
  } else if (view.phase === 'lastcard') {
    $('#age-chip').textContent = `Age ${AGE_ROMAN[view.age]}`;
    $('#turn-chip').textContent = 'The last card';
    $('#pass-chip').textContent = 'before the conflict';
  } else if (view.phase === 'draft') {
    $('#age-chip').textContent = 'Leader draft';
    $('#turn-chip').textContent = `Round ${view.draftRound} of 4`;
    $('#pass-chip').textContent = 'passing right';
  } else if (view.phase === 'recruit') {
    $('#age-chip').textContent = `Age ${AGE_ROMAN[view.age]}`;
    $('#turn-chip').textContent = 'Recruitment';
    $('#pass-chip').textContent = `${view.myLeaders.length} in hand`;
  } else {
    $('#age-chip').textContent = `Age ${AGE_ROMAN[view.age]}`;
    $('#turn-chip').textContent = view.phase === 'over' ? 'finished' : `Turn ${view.turn} of ${view.turnsPerAge}`;
    $('#pass-chip').textContent = `passing ${view.passDir}`;
  }

  // Neighbours first — they are the only two people you can trade with, and the
  // only two you fight — then everybody else in seating order.
  const others = [];
  for (let i = 1; i < view.nPlayers; i++) {
    const seat = (view.mySeat + i) % view.nPlayers;
    const p = view.players.find((q) => q.seat === seat);
    if (p) others.push([p, seat === view.right ? 'right' : seat === view.left ? 'left' : null]);
  }
  others.sort((a, b) => (b[1] ? 1 : 0) - (a[1] ? 1 : 0));
  const cities = $('#cities');
  cities.replaceChildren();
  for (const [p, tag] of others) cities.append(cityEl(view, p, tag));

  const me = view.players.find((q) => q.seat === view.mySeat);
  const mine = $('#me');
  mine.replaceChildren();
  if (me) mine.append(cityEl(view, me, null));

  const waiting = $('#waiting');
  waiting.replaceChildren();
  if (view.phase === 'lastcard') {
    const mine = view.lastCard.includes(view.mySeat);
    const who = view.lastCard.map((sn) => (view.players.find((q) => q.seat === sn) || {}).name).join(', ');
    waiting.textContent = mine
      ? 'One more card before the Age ends: build it, bury it under your wonder, or sell it.'
      : `Waiting for ${who} to play the last card of the Age…`;
  } else if (view.phase === 'choose' && view.choice) {
    const c = view.choice;
    const who = (view.players.find((q) => q.seat === c.seat) || {}).name;
    const mine = c.kind === 'bury'
      ? `${c.why}: put one of your leaders under the board. It stops doing what it did, and pays twice what it cost.`
      : c.kind === 'extra'
        ? `${c.why}: recruit one more leader out of your hand, and pay for it.`
        : `${c.why}: take one card out of the pile and build it for nothing.`;
    const theirs = c.kind === 'bury' ? `Waiting for ${who} to seal a leader under their wonder…`
      : c.kind === 'extra' ? `Waiting for ${who} to recruit one more leader…`
      : `Waiting for ${who} to pick a card out of the discard…`;
    waiting.textContent = c.cards ? mine : theirs;
  } else if (['play', 'draft', 'recruit'].includes(view.phase) && view.waiting.length) {
    const names = view.waiting
      .filter((s) => s !== view.mySeat)
      .map((s) => (view.players.find((q) => q.seat === s) || {}).name)
      .filter(Boolean);
    const ask = view.phase === 'draft'
      ? 'Keep one leader — the rest pass to your right.'
      : view.phase === 'recruit'
        ? 'Recruit one leader, bury one under your wonder, or sell one for 3.'
        : 'Choose a card.';
    waiting.textContent = view.iPicked
      ? (names.length ? `Waiting for ${names.join(', ')}…` : 'Resolving…')
      : ask;
  }

  renderHand(view);
  renderActions(view, sess);
  renderLog(view);
  paintChatBubbles();
  paintStep();

  maybeShowAgeEnd(view);
  if (view.phase === 'over') showGameOver(view, sess);
  else $('#gameover').classList.add('hidden');
}

// ---------------------------------------------------------------- stepping

// With 'Bots wait for a click' on, the host sets no timer at all and parks
// here instead. Clicking anywhere that is not a control lets exactly one bot
// choose, which is how you watch a draft decision at a time.
function paintStep() {
  const el0 = $('#step');
  if (!el0) return;
  const on = !!(session && session.isHost && session.stepPending);
  el0.classList.toggle('hidden', !on);
  el0.textContent = on ? 'Click anywhere to let the next bot choose' : '';
}

function bindStep() {
  $('#screen-game').addEventListener('click', (e) => {
    if (!session || !session.isHost || !session.stepPending) return;
    // the controls are still live while stepping — only the bare table steps
    if (e.target.closest('button, input, a, #hand, #chat, .topbar, .modal')) return;
    session.step();
  });
}

// ---------------------------------------------------------------- action bar

function renderActions(view, sess) {
  const bar = $('#action-bar');
  bar.replaceChildren();
  if (!['play', 'recruit', 'choose', 'lastcard'].includes(view.phase)) return;
  const me = view.players.find((q) => q.seat === view.mySeat);
  if (!me) return;
  const note = el('span', 'act-note');
  const stage = me.stagesBuilt < me.stages.length ? me.stages[me.stagesBuilt] : null;
  note.append(el('span', '', `You have ${me.coins} coins. `));
  if (stage) {
    note.append(el('span', '', 'Next wonder stage costs '));
    if (stage.cost) note.append(resRow(stage.cost));
    if (stage.coin) note.append(el('span', 'coin-chip', `${stage.coin}`));
    if (!stage.cost && !stage.coin) note.append(el('span', 'sw-free', 'nothing'));
  } else {
    note.append(el('span', '', 'Your wonder is finished.'));
  }
  // Which leaders you are still holding matters while you play the Age: the
  // one you want in Age III is the one you have to afford by then.
  if (view.phase === 'play' && view.myLeaders.length) {
    const held = el('span', 'act-leaders');
    held.append(el('span', 'dim', ' · Still in hand: '));
    view.myLeaders.forEach((c, i) => {
      if (i) held.append(el('span', 'dim', ' · '));
      const name = el('span', 'lead-name', c.n);
      name.title = cardGist(c) || c.n;
      held.append(name);
    });
    note.append(held);
  }
  bar.append(note);
}

// ---------------------------------------------------------------- log

let logLines = [];
let logMid = null;

// The engine has a say() for scripted table-talk, as its siblings do, but
// nothing in 7 Wonders ever calls it: everybody chooses at once and there is no
// turn to comment on. The client half of that machinery — the pacing of spoken
// lines, the hold that kept bots from interrupting one, the YOUR TURN banner —
// is gone with it. Chat bubbles are what is left, and those come from players.

function renderLog(view) {
  const key = String(view.mid);
  const newMatch = key !== logMid;
  if (newMatch) {
    logMid = key;
    logLines = [];
    $('#feed').replaceChildren();
  }
  const have = new Set(logLines.map((l) => l.n));
  let added = false;
  const fresh = [];
  for (const item of view.log || []) {
    if (item && typeof item === 'object' && !have.has(item.n)) {
      logLines.push(item);
      fresh.push(item);
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

// ---------------------------------------------------------------- overlays

function hideOverlays() {
  $('#ageend').classList.add('hidden');
  $('#gameover').classList.add('hidden');
  $('#confetti').replaceChildren();
}

// The military tokens are the only thing that happens between Ages, and they
// happen to everybody at once — so show them side by side rather than as a
// line in the log that scrolls away.
let ageShown = 0;
function maybeShowAgeEnd(view) {
  if (!view.fx || view.fx.kind !== 'military') return;
  if (view.fxSeq === ageShown) return;
  ageShown = view.fxSeq;
  const m = $('#ageend');
  $('#ae-title').textContent = `Age ${AGE_ROMAN[view.fx.age]} — conflicts resolved`;
  const t = $('#ae-table');
  t.replaceChildren();
  const head = el('div', 'ae-row head');
  for (const h of ['Player', 'Shields', 'This age', 'Total']) head.append(el('span', '', h));
  t.append(head);
  for (const p of view.players) {
    const row = el('div', 'ae-row');
    row.append(el('span', 'ae-name', p.name));
    row.append(el('span', '', `⚔ ${p.shields}`));
    // the two tokens just handed out are the last two on the pile
    const fresh = p.tokens.slice(-2);
    const gained = fresh.reduce((a, b) => a + b, 0);
    row.append(el('span', gained > 0 ? 'up' : gained < 0 ? 'down' : '', gained > 0 ? `+${gained}` : `${gained}`));
    row.append(el('span', '', String(p.tokens.reduce((a, b) => a + b, 0))));
    t.append(row);
  }
  m.classList.remove('hidden');
  setTimeout(() => m.classList.add('hidden'), cfg('overlayDelay'));
}

function showGameOver(view, sess) {
  const m = $('#gameover');
  m.classList.remove('hidden');
  const r = view.result;
  if (!r) return;
  $('#go-title').textContent = r.winners.length > 1 ? 'A tie!' : `${r.winners[0]} wins`;
  $('#go-sub').textContent = r.teams
    ? `Team scores: ${r.teams.map((t) => `${t.members.join(' & ')} ${t.total}`).join('  ·  ')}`
    : '';

  const t = $('#go-table');
  t.replaceChildren();
  // Leaders get their own column, and debt gets one whenever anybody actually
  // owes something — it comes off the total either way, so it has to be visible.
  const cols = [
    ['', 'name'], ['⚔', 'military'], ['🪙', 'coins'], ['wonder', 'wonder'],
    ['civil', 'civilian'], ['comm', 'commercial'], ['guild', 'guild'],
  ];
  if (view.opts && view.opts.cities) cols.push(['city', 'cities']);
  if (view.opts && view.opts.leaders) cols.push(['lead', 'leaders']);
  cols.push(['sci', 'science']);
  if (r.scores.some((x) => x.debt)) cols.push(['debt', 'debt']);
  cols.push(['total', 'total']);
  t.style.setProperty('--go-cols', String(cols.length - 1));
  const head = el('div', 'go-row head');
  for (const [label] of cols) head.append(el('span', '', label));
  t.append(head);
  // Each figure carries its own label. On a wide screen the header row names
  // the columns and the labels stay hidden; on a phone there is no room for ten
  // columns, the header goes, and each figure wears its label instead.
  const SHORT = { '⚔': 'mil', '🪙': 'coin' };
  for (const s of r.ranked) {
    const row = el('div', `go-row${r.winners.includes(s.name) ? ' win' : ''}`);
    for (const [label, key] of cols) {
      const v = s[key];
      const cell = el('span', key === 'name' ? 'go-name' : key === 'total' ? 'go-total' : '', String(v));
      if (key !== 'name') cell.dataset.k = SHORT[label] || label;
      row.append(cell);
    }
    t.append(row);
  }

  const host = sess && sess.isHost;
  $('#btn-again').classList.toggle('hidden', !host);
  $('#btn-golobby').classList.toggle('hidden', !host);
  $('#go-wait').classList.toggle('hidden', !!host);
  if (r.winners.length === 1) confetti();
}

function confetti() {
  const c = $('#confetti');
  if (c.childElementCount) return;
  for (let i = 0; i < 60; i++) {
    const bit = el('i', '');
    bit.style.left = `${Math.random() * 100}%`;
    bit.style.animationDelay = `${Math.random() * 1.2}s`;
    bit.style.background = ['#e0b352', '#c8963c', '#7fb4d8', '#c86a6a', '#7fc08a'][i % 5];
    c.append(bit);
  }
  setTimeout(() => c.replaceChildren(), 6000);
}

// ---------------------------------------------------------------- actions

function sendMove(move) {
  if (session && session.observer) {
    toast('You are watching \u2014 only the seated player can act');
    return;
  }
  if (pendingMove || !session) return;
  pendingMove = true;
  resetChoice();
  session.localMove(move);
  if (lastView && !session.isHost) renderGame(lastView, session);
}

async function createRoom() {
  const name = cleanName($('#name-input').value) || 'Host';
  localStorage.setItem('swd-name', name);
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
  localStorage.setItem('swd-name', name);
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
  $('#name-input').value = localStorage.getItem('swd-name') || '';

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

  bindStep();

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
