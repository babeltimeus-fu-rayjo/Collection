// app.js — networking + UI for Challengers!
//
// Topology: host-authoritative star over WebRTC data channels.
//   - The host's browser owns the tournament and validates every move.
//   - Guests connect straight to the host (peer-to-peer); no game server.
//   - NAT traversal uses Google's public STUN servers (see RTC_CONFIG).
//   - Peer discovery/signaling uses the free PeerJS cloud broker, because
//     GitHub Pages can only serve static files.
// The host also runs the clock: every match of a round plays itself, one
// card at a time, so the host steps them all on a timer and pauses a match
// whenever a card asks its owner something. Bots draft and answer in the
// host's browser, and take over for anyone who disconnects.

import {
  PROTO,
  MIN_PLAYERS,
  MAX_PLAYERS,
  ROUNDS,
  BENCH_SEATS,
  SETS,
  BOXES,
  CARD,
  CARDS,
  BOT_LEVELS,
  DEFAULT_LEVEL,
  defaultOpts,
  canStart,
  newMatch,
  applyMove,
  viewFor,
  botChoose,
  waitingOn,
  stepMatch,
  afterMatches,
  autoAnswer,
  answerMatch,
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
const cfg = initSettings('chg', [
  { key: 'matchStep', label: 'Match speed: one card every', def: 950, section: 'Host pacing', host: true, hint: 'How long each card stays turned over before the next one — for every match at once.' },
  { key: 'matchHold', label: 'Pause after the matches', def: 3200, section: 'Host pacing', host: true, hint: 'How long the finished matches stay up before the next Deck Phase.' },
  { key: 'botDraft', label: 'Bot draft delay', def: [650, 500], section: 'Host pacing', host: true },
  { key: 'botAnswer', label: 'Bot answer delay', def: [600, 400], section: 'Host pacing', host: true, hint: 'Pause before a bot answers a card that asks it something.' },
  { key: 'bubbleChat', label: 'Chat bubbles linger', def: 6500, section: 'Bubbles & banners' },
  { key: 'bubbleTrunc', label: 'Bubble text cap', def: 84, min: 12, max: 400, step: 4, unit: 'ch', ms: false, section: 'Bubbles & banners' },
  { key: 'flashMs', label: 'Banner duration', def: 1900, section: 'Bubbles & banners' },
  { key: 'overlayDelay', label: 'Result screen delay', def: 3400, section: 'Overlays' },
  { key: 'revealBots', label: "Show the bots' decks", def: false, bool: true, section: 'Testing', host: true, hint: 'Lists every bot’s deck in the standings, to see what they drafted and why they win. Only the host builds views, so this shows them to everyone at the table.' },
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
const ID_PREFIX = 'chg-v1-';
const BOT_NAMES = ['Coach Kovač', 'Mo', 'Pip', 'Big Lou', 'Aunt Vera', 'Dr. Flag', 'Ziggy', 'The Ref'];
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
    this.opts = defaultOpts('base');
    this.botLevel = DEFAULT_LEVEL;
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

  // Racks are hidden, but an abandoned seat has been played by a bot in the
  // open anyway, so anyone watching may pick it up.
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

  // The lobby's table setup: which box's basic set and starter decks, and
  // which five additional sets — from either box, mixed however you like.
  setBox(box) {
    if (this.G || !BOXES[box]) return;
    this.opts = defaultOpts(box);
    this.pushLobby();
  }

  toggleSet(set) {
    if (this.G || !SETS[set] || SETS[set].basic) return;
    const sets = this.opts.sets.slice();
    const i = sets.indexOf(set);
    if (i >= 0) sets.splice(i, 1);
    else if (sets.length < 5) sets.push(set);
    else { toast('Five sets play at once — take one out first.'); return; }
    this.opts = { ...this.opts, sets };
    this.pushLobby();
  }

  // Bot skill is the host's browser doing the thinking, so only the host sets
  // it — and it can change between games without leaving the lobby.
  setBotLevel(key) {
    if (!BOT_LEVELS[key]) return;
    this.botLevel = key;
    this.pushLobby();
  }

  // The host's clock. In a Deck Phase it lets the bots draft, one move at a
  // time so the table can see them working; in a Match Phase it turns over
  // the next card in every match at once, lets bots answer what their cards
  // ask, and — once every match is decided and has been up long enough to
  // read — moves the tournament on.
  schedule(ms) {
    clearTimeout(this.tickTimer);
    if (!this.G || this.G.phase === 'over') return;
    this.tickTimer = setTimeout(() => this.tick(), Math.max(20, ms));
  }

  tick() {
    const G = this.G;
    if (!G || G.phase === 'over') return;
    if (G.phase === 'deck' || G.phase === 'final-deck') {
      const seat = waitingOn(G).find((s) => this.seatCovered(s));
      if (seat != null) {
        const mv = botChoose(G, seat, { level: this.botLevel });
        const res = mv ? applyMove(G, seat, mv) : { ok: false };
        // never stall the table: a bot that cannot decide calls it done
        if (!res.ok) {
          const p = G.players.find((q) => q.seat === seat);
          if (p && p.draft && p.draft.pending) applyMove(G, seat, { kind: 'answer', cards: p.draft.pending.optional ? [] : p.draft.pending.pool.slice(0, p.draft.pending.need) });
          else applyMove(G, seat, { kind: 'done' });
        }
        this.pushViews();
      }
      this.schedule(G.phase === 'match' ? cfg('matchStep') : cfg.range('botDraft'));
      return;
    }
    if (G.phase === 'match') {
      let changed = false;
      for (const M of G.matches) {
        if (M.over) continue;
        if (M.pending) {
          if (!this.seatCovered(M.pending.seat)) continue;
          const now = Date.now();
          if (!M._askedAt) M._askedAt = now;
          if (now - M._askedAt < cfg.range('botAnswer')) continue;
          M._askedAt = null;
          answerMatch(G, M, M.pending.seat, autoAnswer(G, M, M.pending));
          changed = true;
          continue;
        }
        stepMatch(G, M);
        changed = true;
      }
      if (G.matches.every((M) => M.over)) {
        if (!this.overSince) this.overSince = Date.now();
        if (Date.now() - this.overSince >= cfg('matchHold')) {
          this.overSince = null;
          afterMatches(G);
          changed = true;
        }
      }
      if (changed) this.pushViews();
      this.schedule(G.phase === 'match' ? cfg('matchStep') : cfg.range('botDraft'));
    }
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
      botLevel: this.botLevel,
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

  broadcast() {
    pendingMove = false;
    showScreen('game');
    this.pushViews();
    this.schedule(this.G && this.G.phase === 'match' ? cfg('matchStep') : cfg.range('botDraft'));
  }

  // Everyone's view of the table as it stands. A change to what views show,
  // like turning the bot's hand face up, re-sends them without touching the
  // game or the bot's clock.
  pushViews() {
    if (!this.G) return;
    const wnames = this.watchers.map((x) => x.name);
    const opts = viewOpts();
    for (const [seat, conn] of this.conns) {
      try {
        conn.send({ t: 'state', view: { ...viewFor(this.G, seat, this.code, opts), watchers: wnames, botLevel: this.botLevel } });
      } catch {}
    }
    for (const w of this.watchers) this.sendWatcher(w);
    renderGame({ ...viewFor(this.G, 0, this.code, opts), watchers: wnames, botLevel: this.botLevel }, this);
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
            full: 'That room is full (8 players max).',
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

const REJOIN_KEY = 'chg-rejoin';

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

const setIcon = (set) => (SETS[set] ? SETS[set].icon : '');

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
      row.append(el('div', 'av empty', '·'), el('span', 'seat-name dim', 'Empty seat'));
    }
    list.append(row);
  }

  const opts = lob.opts;
  const bp = $('#box-picker');
  bp.replaceChildren();
  for (const [key, box] of Object.entries(BOXES)) {
    const b = el('button', `side-pick${key === opts.box ? ' on' : ''}`, box.name);
    b.type = 'button';
    b.disabled = !sess.isHost;
    b.dataset.tip = `${box.name}: the ${SETS[box.basic].name} set, its starter decks and its draft plan. Any five of all twelve additional sets can join it.`;
    if (sess.isHost) b.addEventListener('click', () => sess.setBox(key));
    bp.append(b);
  }

  // the twelve additional sets, the chosen five lit
  const sp = $('#set-picker');
  sp.replaceChildren();
  for (const [key, box] of Object.entries(BOXES)) {
    const row = el('div', 'set-row');
    row.append(el('span', 'set-box', box.name.replace('Challengers! ', '')));
    for (const set of box.sets) {
      const on = opts.sets.includes(set);
      const b = el('button', `set-pick set-${set}${on ? ' on' : ''}`);
      b.type = 'button';
      b.append(el('span', 'set-ic', setIcon(set)), el('span', '', SETS[set].name));
      b.disabled = !sess.isHost;
      b.setAttribute('aria-pressed', String(on));
      if (sess.isHost) b.addEventListener('click', () => sess.toggleSet(set));
      row.append(b);
    }
    sp.append(row);
  }
  $('#set-count').textContent = `${opts.sets.length} of 5 · plus ${SETS[opts.basic].name}`;
  const hint = opts.sets.length === 5
    ? `${SETS[opts.basic].icon} ${SETS[opts.basic].name} and ${opts.sets.map((s) => `${setIcon(s)} ${SETS[s].name}`).join(', ')}.`
    : `Choose ${5 - opts.sets.length} more.`;
  $('#set-blurb').textContent = hint;

  const bl = $('#bot-picker');
  bl.replaceChildren();
  for (const [key, lvl] of Object.entries(BOT_LEVELS)) {
    const b = el('button', `side-pick${key === lob.botLevel ? ' on' : ''}`, lvl.label);
    b.type = 'button';
    b.dataset.tip = lvl.blurb;
    b.disabled = !sess.isHost;
    if (sess.isHost) b.addEventListener('click', () => sess.setBotLevel(key));
    bl.append(b);
  }
  $('#bot-blurb').textContent = (BOT_LEVELS[lob.botLevel] || BOT_LEVELS[DEFAULT_LEVEL]).blurb;

  $('#btn-start').classList.toggle('hidden', !sess.isHost);
  $('#btn-add-bot').classList.toggle('hidden', !sess.isHost);
  const n = lob.players.length;
  const why = canStart(n, opts);
  if (sess.isHost) {
    $('#btn-start').disabled = !!why;
    $('#btn-add-bot').disabled = n >= lob.max;
  }
  const bots = lob.players.filter((p) => p.bot).length;
  $('#lobby-hint').textContent = sess.isHost
    ? why || `${n} players${bots ? `, ${bots} of them bot${bots === 1 ? '' : 's'}` : ''}, ${ROUNDS} rounds${n > 2 ? ' and a final' : ''}. Ready when you are.`
    : 'Waiting for the host to start…';
  paintChatBubbles();
}

// ---------------------------------------------------------------- UI state

let viewMid = null;
let watching = null;          // the match someone chose to look at, if not their own
let qsel = { key: null, ids: [] };   // what a question's answer is being built from
let cutMarks = new Set();     // deck cards marked to cut

const me = (view) => view.players.find((p) => p.seat === view.you);
const seatName = (view, seat) => {
  const p = view.players.find((q) => q.seat === seat);
  return p ? p.name : 'someone';
};

const KW = {
  attack: 'During the attack',
  bench: 'From the bench',
  flag: 'In flag possession',
  loss: 'Flag loss',
  picked: 'When picked',
  nowin: 'No flag win',
  special: 'Special',
};

// a card's printed text, with its keyword in bold and its set icons drawn
function cardText(c) {
  const box = el('span', 'ch-text');
  if (c.kw && KW[c.kw]) box.append(el('b', '', `${KW[c.kw]}: `));
  const parts = (c.text || '').split(/\{(\w+)\}/);
  parts.forEach((part, i) => {
    if (i % 2) box.append(el('span', 'ch-inline-ic', SETS[part] ? SETS[part].icon : part));
    else if (part) box.append(document.createTextNode(part));
  });
  if (SETS[c.set].allIcons && c.level !== 'S') box.append(el('i', 'ch-all', ' This card has all set icons.'));
  return box;
}

const copiesWord = (c) => (c.level === 'S' ? 'starter card' : c.copies < 4 ? `Rare ${c.copies}×` : c.copies > 4 ? `Common ${c.copies}×` : '4 copies');

// A card as the table shows it. `power` is its power where it stands now,
// when that differs from what it prints.
function cardEl(key, o = {}) {
  const c = CARD[key];
  const set = SETS[c.set];
  const n = el(o.button ? 'button' : 'div', `ch-card set-${c.set}${o.size ? ' ' + o.size : ''}${o.cls ? ' ' + o.cls : ''}`);
  if (o.button) n.type = 'button';
  const pow = o.power ?? c.power;
  const top = el('div', 'ch-card-top');
  const pw = el('span', `ch-pow${pow > c.power ? ' up' : pow < c.power ? ' down' : ''}`, String(pow));
  top.append(pw, el('span', `ch-name${/\S{11}/.test(c.name) ? ' long' : ''}`, c.name), el('span', 'ch-ic', set.icon));
  n.append(top);
  if (o.size === 'big' && (c.text || c.kw)) n.append(cardText(c));
  // a card without an effect prints how rare it is instead, as the real ones do
  else if (o.size === 'big' && c.level !== 'S' && c.copies !== 4) n.append(el('i', 'ch-text ch-rare', copiesWord(c).replace('×', 'x')));
  n.append(el('span', 'ch-lvl', c.level));
  n.dataset.tipCard = key;
  if (o.id !== undefined) n.dataset.tipKey = `card:${o.id}`;
  if (o.power !== undefined && o.power !== c.power) n.dataset.tipWhy = `Power ${o.power} here: ${c.power} printed, ${o.power > c.power ? '+' : ''}${o.power - c.power} from effects.`;
  return n;
}

function btn(label, cls, fn, disabled = false) {
  const b = el('button', `btn ${cls}`, label);
  b.type = 'button';
  b.disabled = disabled;
  b.addEventListener('click', fn);
  return b;
}

// ---------------------------------------------------------------- the Deck Phase

function optionText(o) {
  return `${o.pick} card${o.pick === 1 ? '' : 's'} from Level ${o.level}${o.fans ? ` · +${o.fans} fans` : ''}`;
}

function planEl(view) {
  const row = el('div', 'ch-plan');
  view.plan.forEach((opts, i) => {
    const r = i + 1;
    const cell = el('span', `ch-plan-r${r === view.round && !view.final ? ' now' : ''}${r < view.round || view.final ? ' past' : ''}`);
    cell.append(el('b', '', String(r)), el('span', '', opts.map((o) => `${o.pick}${o.level}${o.fans ? '★' : ''}`).join(' / ')));
    cell.dataset.tip = `Round ${r}: ${opts.map(optionText).join(', or ')}.`;
    row.append(cell);
  });
  const f = el('span', `ch-plan-r final${view.final ? ' now' : ''}`, 'F');
  f.dataset.tip = view.players.length > 2 ? 'The final: the two players with the most fans, no drafting — only cuts.' : 'Two players play no final.';
  row.append(f);
  return row;
}

function groupDeck(cards) {
  const groups = new Map();
  for (const c of cards) {
    if (!groups.has(c.key)) groups.set(c.key, []);
    groups.get(c.key).push(c.id);
  }
  return [...groups.entries()].sort((a, b) => CARD[b[0]].power - CARD[a[0]].power || CARD[a[0]].name.localeCompare(CARD[b[0]].name));
}

function deckEl(view, editable) {
  const wrap = el('div', 'ch-deck');
  const names = new Set(view.deck.map((c) => CARD[c.key].name));
  const head = el('div', 'ch-deck-head');
  head.append(el('b', '', `Your deck: ${view.deck.length} cards`), el('span', 'dim', ` · ${names.size} names for ${BENCH_SEATS} bench seats`));
  wrap.append(head);
  const grid = el('div', 'ch-deck-grid');
  for (const [key, ids] of groupDeck(view.deck)) {
    const cell = el('div', 'ch-deck-cell');
    const marked = ids.filter((id) => cutMarks.has(id)).length;
    const card = cardEl(key, { size: 'mid', button: editable, cls: marked ? 'marked' : '' });
    if (editable) {
      card.addEventListener('click', () => {
        // each click marks one more copy, and a click past the last clears them
        const free = ids.find((id) => !cutMarks.has(id));
        if (free !== undefined) cutMarks.add(free); else for (const id of ids) cutMarks.delete(id);
        renderGame(lastView, session);
      });
    }
    cell.append(card, el('span', 'ch-count', `×${ids.length}${marked ? ` · cut ${marked}` : ''}`));
    grid.append(cell);
  }
  wrap.append(grid);
  if (editable) {
    const n = [...cutMarks].filter((id) => view.deck.some((c) => c.id === id)).length;
    const bar = el('div', 'ch-deck-bar');
    bar.append(el('span', 'dim', n ? `${n} marked to cut — they go back to the Level piles (starter cards to the box).` : 'Tap a card to mark a copy to cut. There is no deck size limit either way.'));
    if (n) {
      bar.append(btn(`Cut ${n}`, 'secondary', () => {
        const cards = [...cutMarks].filter((id) => view.deck.some((c) => c.id === id));
        cutMarks = new Set();
        sendMove({ kind: 'cut', cards });
      }));
      bar.append(btn('Clear', 'ghost', () => { cutMarks = new Set(); renderGame(lastView, session); }));
    }
    wrap.append(bar);
  }
  return wrap;
}

function renderDraft(view, stage) {
  const d = view.draft;
  const p = me(view);
  const box = el('div', 'ch-draft');
  box.append(planEl(view));
  if (!d || p.ready) {
    const waiting = view.players.filter((q) => !q.ready).map((q) => q.name);
    box.append(el('h2', '', view.phase === 'final-deck' ? 'The final is about to begin' : `Round ${view.round} · Deck Phase`));
    box.append(el('p', 'ch-wait', waiting.length ? `Waiting for ${waiting.join(', ')}…` : 'Everyone is ready.'));
    if (view.deck.length) box.append(deckEl(view, false));
    stage.append(box);
    return;
  }
  if (d.finalOnly) {
    box.append(el('h2', '', 'Before the final'));
    box.append(el('p', 'ch-lede', 'No drafting before the final — but you may cut any cards you like. Then you are ready.'));
  } else {
    box.append(el('h2', '', `Round ${view.round} · Deck Phase`));
  }

  if (!d.finalOnly && d.chosen === null) {
    box.append(el('p', 'ch-lede', 'This round offers a choice. Draw five from:'));
    const row = el('div', 'ch-options');
    d.options.forEach((o, i) => row.append(btn(optionText(o), i ? 'secondary' : 'primary', () => sendMove({ kind: 'option', option: i }))));
    box.append(row);
  } else if (!d.finalOnly) {
    const o = d.options[d.chosen];
    const left = d.allowed - d.picks;
    box.append(el('p', 'ch-lede', left > 0
      ? `Drawn from Level ${o.level}: keep ${left} more${d.allowed > o.pick ? ` (${d.allowed - o.pick} extra from a card)` : ''}.`
      : `You have kept ${d.picks}. Cut what you like, then you are done.`));
    const row = el('div', 'ch-drawn');
    for (const c of d.drawn) {
      const card = cardEl(c.key, { size: 'big', button: left > 0 && !d.pending, id: c.id });
      if (left > 0 && !d.pending) card.addEventListener('click', () => sendMove({ kind: 'pick', card: c.id }));
      row.append(card);
    }
    if (!d.drawn.length) row.append(el('p', 'dim', 'Nothing left in the draw.'));
    box.append(row);
  }

  if (d.pending) box.append(pickedQuestion(view, d.pending));

  const bar = el('div', 'ch-draft-bar');
  if (!d.finalOnly && d.chosen !== null && !d.redrawn && d.picks < d.allowed && d.drawn.length && !d.pending) {
    bar.append(btn(`Redraw these ${d.drawn.length}`, 'ghost', () => sendMove({ kind: 'redraw' })));
  }
  if (!d.pending && (d.finalOnly || d.chosen !== null)) {
    // stopping short is allowed (the round says how many you *can* keep), but
    // it should not be the button that catches the eye while picks are left
    const unused = !d.finalOnly && d.picks < d.allowed && d.drawn.length;
    const label = !unused ? 'Done' : d.picks ? `Done — keep just ${d.picks}` : 'Done — keep none';
    bar.append(btn(label, unused ? 'ghost' : 'primary', () => { cutMarks = new Set(); sendMove({ kind: 'done' }); }));
  }
  box.append(bar);
  box.append(deckEl(view, !d.pending));
  stage.append(box);
}

// a When picked card asking its question in the Deck Phase
function pickedQuestion(view, q) {
  const box = el('div', 'ch-question');
  const c = CARD[q.card];
  const key = `pick:${q.card}:${q.pool.map((x) => x.id).join(',')}`;
  if (qsel.key !== key) qsel = { key, ids: [] };
  const words = {
    'cut-for-pick': q.need === 2 ? `remove two ${SETS.space.icon}-cards from your deck to pick an extra card` : 'remove a card from your deck to pick an extra card',
    cut: 'you must remove a card with base power 3 or higher from your deck',
    surf: 'keep one of these three Level-A cards as an extra pick',
  };
  box.append(el('div', 'ch-q-head', `${c.name} — ${words[q.kind] || c.text}`));
  const row = el('div', 'ch-q-cards');
  for (const x of q.pool) {
    const on = qsel.ids.includes(x.id);
    const card = cardEl(x.key, { size: q.kind === 'surf' ? 'big' : 'mid', button: true, cls: on ? 'chosen' : '', id: x.id });
    card.addEventListener('click', () => {
      if (on) qsel.ids = qsel.ids.filter((y) => y !== x.id);
      else { qsel.ids.push(x.id); if (qsel.ids.length > q.need) qsel.ids.shift(); }
      renderGame(lastView, session);
    });
    row.append(card);
  }
  box.append(row);
  const bar = el('div', 'ch-q-bar');
  bar.append(btn('Confirm', 'primary', () => sendMove({ kind: 'answer', cards: qsel.ids.slice() }), qsel.ids.length !== q.need));
  if (q.optional) bar.append(btn('No thanks', 'ghost', () => sendMove({ kind: 'answer', cards: [] })));
  box.append(bar);
  return box;
}

// ---------------------------------------------------------------- the match

function benchEl(view, M, S, mineToChoose) {
  const bench = el('div', 'ch-bench');
  let used = 0;
  S.bench.forEach((seat, i) => {
    const top = seat.cards[seat.cards.length - 1];
    const cell = el(mineToChoose ? 'button' : 'div', `ch-seat${seat.wide ? ' wide' : ''}${seat.overflow ? ' overflow' : ''}`);
    if (mineToChoose) {
      cell.type = 'button';
      cell.addEventListener('click', () => sendMove({ kind: 'answer', seat: i }));
    }
    cell.append(cardEl(top.key, { size: 'small', id: top.id }));
    if (seat.cards.length > 1) cell.append(el('span', 'ch-seat-n', `×${seat.cards.length}`));
    cell.dataset.tip = `${seat.name}: ${seat.cards.length} card${seat.cards.length === 1 ? '' : 's'} on this seat${seat.wide ? ', spread across two seats' : ''}.`;
    bench.append(cell);
    used += seat.wide ? 2 : 1;
  });
  for (let i = used; i < BENCH_SEATS; i++) bench.append(el('div', 'ch-seat empty'));
  return bench;
}

function parkEl(view, M, S) {
  const park = el('div', 'ch-park');
  if (S.flag) {
    const stack = el('div', 'ch-flag-stack');
    const card = cardEl(S.flag.key, { size: 'big', power: S.flag.power, id: S.flag.id, cls: 'flag' });
    card.append(el('span', 'ch-flag-pin', '⚑'));
    stack.append(card);
    if (S.under.length) {
      const under = el('div', 'ch-under');
      for (const u of S.under) under.append(cardEl(u.key, { size: 'tiny', id: u.id }));
      under.dataset.tip = `Under the flag: ${S.under.map((u) => CARD[u.key].name).join(', ')}. They go to the bench with it when it falls.`;
      stack.append(under);
    }
    park.append(stack);
  } else if (S.attack.length) {
    const row = el('div', 'ch-attack');
    for (const a of S.attack) row.append(cardEl(a.key, { size: 'mid', power: a.power, id: a.id }));
    park.append(row);
  }
  if (S.limbo.length) {
    const row = el('div', 'ch-limbo');
    for (const x of S.limbo) row.append(cardEl(x.key, { size: 'tiny', id: x.id }));
    row.dataset.tip = 'On their way to the bench.';
    park.append(row);
  }
  if (!S.flag && !S.attack.length && !S.limbo.length) park.append(el('div', 'ch-park-empty', ''));
  return park;
}

function sideEl(view, M, seat, pos) {
  const S = M.sides[seat];
  const box = el('div', `ch-side ${pos}${M.holder === seat ? ' holder' : ''}${M.attacker === seat && !M.over ? ' attacker' : ''}${M.over && M.winner === seat ? ' won' : ''}${M.over && M.winner !== seat ? ' lost' : ''}`);
  const head = el('div', 'ch-side-head');
  const p = view.players.find((q) => q.seat === seat);
  head.append(avatarEl(p.name, p.seat, p.bot), el('b', 'ch-side-name', p.name + (seat === view.you ? ' (you)' : '')));
  const deck = el('span', 'ch-chip', `🂠 ${S.deck}`);
  deck.dataset.tip = `${S.deck} card${S.deck === 1 ? '' : 's'} left to turn over. An attacker who runs out loses.`;
  const ex = el('span', 'ch-chip', `♻ ${S.exhaust.length}`);
  ex.dataset.tip = S.exhaust.length ? `Exhaust pile: ${S.exhaust.map((x) => CARD[x.key].name).join(', ')}. Out of this match; back in the deck afterwards.` : 'Exhaust pile: empty. Cards put here sit out the rest of the match.';
  const seats = el('span', 'ch-chip', `🪑 ${S.empty} free`);
  seats.dataset.tip = `${S.empty} of ${BENCH_SEATS} bench seats free. A card with a new name and no seat for it loses the match.`;
  head.append(deck, ex, seats);
  if (S.fans) { const f = el('span', 'ch-chip fans', `★ +${S.fans}`); f.dataset.tip = `${S.fans} fans taken in this match.`; head.append(f); }
  if (S.next) { const nx = el('span', 'ch-chip up', `next +${S.next}`); nx.dataset.tip = `The next card turned over gets +${S.next}.`; head.append(nx); }
  const choosingSeat = M.pending && M.pending.seat === view.you && M.pending.seats && seat === view.you;
  const parts = [head, benchEl(view, M, S, choosingSeat), parkEl(view, M, S)];
  if (pos === 'bottom') parts.reverse();
  box.append(...parts);
  return box;
}

function duelEl(view, M, topSeat, bottomSeat) {
  const box = el('div', 'ch-duel');
  if (M.over) {
    box.classList.add('over');
    box.append(el('b', '', `${seatName(view, M.winner)} wins${M.final ? ' the final' : ''}`), el('span', '', ` — ${seatName(view, M.winner === M.seats[0] ? M.seats[1] : M.seats[0])} lost: ${M.why}.`));
    return box;
  }
  if (M.holder === null) { box.append(el('span', 'dim', 'Shuffling…')); return box; }
  const flag = el('span', 'ch-duel-flag', `⚑ ${M.flagPower}`);
  flag.dataset.tip = `The card with the flag has power ${M.flagPower}.`;
  const atk = el('span', 'ch-duel-atk', `⚔ ${M.attackTotal}`);
  atk.dataset.tip = `${seatName(view, M.attacker)} has turned over ${M.attackTotal} so far; they need ${M.flagPower} to take the flag.`;
  const holderTop = M.holder === topSeat;
  box.append(holderTop ? flag : atk, el('span', 'ch-duel-vs', 'vs'), holderTop ? atk : flag);
  const who = M.pending ? `${seatName(view, M.pending.seat)} is deciding…` : `${seatName(view, M.attacker)} attacks`;
  box.append(el('span', 'ch-duel-who', who));
  return box;
}

// The question a card asks its owner mid-match: which cards, in what order,
// top or bottom, which seat.
function matchQuestion(view, M) {
  const q = M.pending;
  const box = el('div', 'ch-question');
  const key = `m:${M.id}:${M.seq}:${q.kind}`;
  if (qsel.key !== key) qsel = { key, ids: [] };
  box.append(el('div', 'ch-q-head', q.prompt));
  const bar = el('div', 'ch-q-bar');
  if (q.seats) {
    box.append(el('p', 'dim', 'Tap one of your bench seats above.'));
    return box;
  }
  if (q.options) {
    const row = el('div', 'ch-q-cards');
    row.append(cardEl(q.ids[0].key, { size: 'big', id: q.ids[0].id }));
    box.append(row);
    bar.append(btn('On top', 'primary', () => sendMove({ kind: 'answer', option: 'top' })));
    bar.append(btn('Under the deck', 'secondary', () => sendMove({ kind: 'answer', option: 'under' })));
    box.append(bar);
    return box;
  }
  const labels = q.assign ? q.assign.map((w) => ({ under: 'under your deck', top: 'on top', exhaust: 'to the exhaust pile' }[w])) : null;
  if (q.order || q.assign) {
    box.append(el('p', 'dim', q.order
      ? `Tap them in order, the one for the top first. ${qsel.ids.length ? `So far: ${qsel.ids.map((id, i) => `${i + 1}. ${CARD[q.ids.find((x) => x.id === id).key].name}`).join(', ')}.` : ''}`
      : `Tap the card to go ${labels[qsel.ids.length] || '—'}.`));
  }
  const row = el('div', 'ch-q-cards');
  for (const x of q.ids) {
    const at = qsel.ids.indexOf(x.id);
    const card = cardEl(x.key, { size: 'mid', button: true, cls: at >= 0 ? 'chosen' : '', id: x.id });
    if (at >= 0 && (q.order || q.assign)) card.append(el('span', 'ch-order', q.order ? String(at + 1) : { under: '↓', top: '↑', exhaust: '♻' }[q.assign[at]]));
    card.addEventListener('click', () => {
      if (at >= 0) qsel.ids.splice(at, 1);
      else {
        qsel.ids.push(x.id);
        if (!q.order && !q.assign && qsel.ids.length > q.max) qsel.ids.shift();
      }
      renderGame(lastView, session);
    });
    row.append(card);
  }
  box.append(row);
  if (q.order || q.assign) {
    bar.append(btn('Confirm', 'primary', () => sendMove({ kind: 'answer', ids: qsel.ids.slice() }), qsel.ids.length !== q.ids.length));
    bar.append(btn('Start over', 'ghost', () => { qsel.ids = []; renderGame(lastView, session); }));
  } else {
    const n = qsel.ids.length;
    bar.append(btn(n ? 'Confirm' : q.min === 0 ? 'None' : 'Confirm', n ? 'primary' : 'ghost', () => sendMove({ kind: 'answer', ids: qsel.ids.slice() }), n < q.min || n > q.max));
  }
  box.append(bar);
  return box;
}

function renderMatch(view, M, stage) {
  const box = el('div', `ch-match${M.final ? ' final' : ''}`);
  const mine = M.seats.includes(view.you);
  const bottom = mine ? view.you : M.seats[0];
  const top = M.seats[0] === bottom ? M.seats[1] : M.seats[0];
  const title = el('div', 'ch-match-title');
  title.append(el('b', '', M.final ? 'The final' : `Round ${M.round}${M.park !== null ? ` · park ${M.park + 1}` : ''}`), el('span', 'dim', ` — ${seatName(view, top)} vs ${seatName(view, bottom)}`));
  if (!mine || watching !== null) {
    const own = view.matches.find((x) => x.seats.includes(view.you));
    if (own && own.id !== M.id) title.append(btn('Back to my match', 'ghost small', () => { watching = null; renderGame(lastView, session); }));
  }
  box.append(title);
  box.append(sideEl(view, M, top, 'top'));
  box.append(duelEl(view, M, top, bottom));
  box.append(sideEl(view, M, bottom, 'bottom'));
  if (M.pending && M.pending.seat === view.you && M.pending.kind) box.append(matchQuestion(view, M));
  const log = el('div', 'ch-mlog');
  for (const line of M.log.slice(-6)) log.append(el('div', '', line));
  box.append(log);
  stage.append(box);
}

// ---------------------------------------------------------------- the side panel

function renderStandings(view) {
  const host = $('#standings');
  host.replaceChildren();
  const two = view.players.length === 2;
  const rows = view.players.slice().sort((a, b) => (b.total ?? b.fans) - (a.total ?? a.fans) || b.trophies.length - a.trophies.length);
  const list = el('ol', 'ch-standings');
  for (const p of rows) {
    const row = el('li', `ch-st${p.seat === view.you ? ' you' : ''}`);
    row.append(avatarEl(p.name, p.seat, p.bot));
    const name = el('div', 'ch-st-name');
    name.append(el('b', '', p.name + (p.connected || p.bot ? '' : ' (away)')));
    let status = '';
    if (view.phase === 'deck' || view.phase === 'final-deck') status = p.ready ? 'ready' : 'drafting…';
    else if (view.phase === 'match') {
      const M = view.matches.find((x) => x.seats.includes(p.seat));
      if (M) status = M.over ? (M.winner === p.seat ? 'won' : 'lost') : M.pending && M.pending.seat === p.seat ? 'deciding…' : `vs ${seatName(view, M.seats.find((s) => s !== p.seat))}`;
      else status = 'watching';
    }
    name.append(el('span', 'ch-st-status', status));
    row.append(name);
    const fans = el('span', 'ch-st-fans', `★ ${p.total ?? p.fans}${p.total === null ? '+?' : ''}`);
    fans.dataset.tip = p.total === null
      ? `${p.fans} fans in tokens, plus the hidden fans on ${p.trophies.length} Troph${p.trophies.length === 1 ? 'y' : 'ies'}.`
      : `${p.total} fans: ${p.fans} in tokens${p.trophies.length ? ` and ${p.trophies.map((t) => t.fans).join(' + ')} on Trophies` : ''}.`;
    const tro = el('span', 'ch-st-tro', `🏆 ${p.trophies.length}`);
    tro.dataset.tip = p.trophies.length ? `Trophies from round${p.trophies.length > 1 ? 's' : ''} ${p.trophies.map((t) => t.round).join(', ')}${p.trophies[0].fans !== undefined ? ` — worth ${p.trophies.map((t) => t.fans).join(', ')}` : ''}.` : 'No Trophies yet.';
    const deck = el('span', 'ch-st-deck', `🂠 ${p.deckSize}`);
    deck.dataset.tip = `${p.deckSize} cards in ${p.seat === view.you ? 'your' : 'their'} deck.`;
    row.append(fans, tro, deck);
    list.append(row);
  }
  host.append(el('div', 'ch-side-title', two ? 'Two players: first to a lead of 11 fans, or the most after round 7' : 'Standings — the top two after round 7 play the final'));
  host.append(list);
  if (view.revealBots) {
    for (const b of view.revealBots) {
      const box = el('div', 'ch-botdeck');
      box.append(el('div', 'ch-side-title', `${seatName(view, b.seat)}’s deck`));
      const grid = el('div', 'ch-mini-deck');
      for (const [key, ids] of groupDeck(b.deck)) {
        const c = cardEl(key, { size: 'tiny' });
        if (ids.length > 1) c.append(el('span', 'ch-seat-n', `×${ids.length}`));
        grid.append(c);
      }
      box.append(grid);
      host.append(box);
    }
  }
}

function renderOthers(view, shownId) {
  const host = $('#others');
  host.replaceChildren();
  const rest = view.matches.filter((M) => M.id !== shownId);
  if (!rest.length) return;
  host.append(el('div', 'ch-side-title', 'The other matches'));
  for (const M of rest) {
    const [a, b] = M.seats;
    const tile = el('button', `ch-other${M.over ? ' over' : ''}`);
    tile.type = 'button';
    const line = (s) => {
      const S = M.sides[s];
      const r = el('div', `ch-other-row${M.holder === s ? ' holder' : ''}${M.over && M.winner === s ? ' won' : ''}`);
      r.append(el('b', '', seatName(view, s)));
      r.append(el('span', 'dim', S.flag ? `⚑ ${CARD[S.flag.key].name} ${S.flag.power}` : S.attack.length ? `⚔ ${S.attack.reduce((n, x) => n + x.power, 0)}` : ''));
      r.append(el('span', 'ch-other-bench', `🪑${BENCH_SEATS - S.empty}/${BENCH_SEATS} · 🂠${S.deck}`));
      return r;
    };
    tile.append(line(a), line(b));
    if (M.over) tile.append(el('div', 'ch-other-res', `${seatName(view, M.winner)} won — ${M.why}`));
    tile.addEventListener('click', () => { watching = M.id; renderGame(lastView, session); });
    host.append(tile);
  }
}

// ---------------------------------------------------------------- card reference

function renderCardRef(view) {
  const host = $('#card-ref');
  host.replaceChildren();
  const opts = view ? view.opts : defaultOpts('base');
  const sets = [...new Set([opts.basic, ...opts.sets])];
  const starter = el('section', 'ch-ref-set');
  starter.append(el('h3', '', `${SETS.city.icon} Starter decks — six cards each`));
  if (opts.box === 'beach') starter.append(el('p', 'dim', 'Beach Cup’s starter deck is read off its rulebook as far as the Newcomer and the new Dog; the Talent and Champion are assumed from the first box until checked.'));
  const sgrid = el('div', 'ch-ref-grid');
  for (const k of [...new Set(CARDS.filter((c) => c.level === 'S' && (opts.box === 'beach' ? c.key !== 'dog-s' : c.key !== 'dog-look')).map((c) => c.key))]) sgrid.append(refRow(CARD[k]));
  starter.append(sgrid);
  host.append(starter);
  for (const set of sets) {
    const cards = CARDS.filter((c) => c.set === set && c.level !== 'S');
    if (!cards.length) continue;
    const sec = el('section', 'ch-ref-set');
    sec.append(el('h3', '', `${SETS[set].icon} ${SETS[set].name} — ${cards.reduce((n, c) => n + c.copies, 0)} cards`));
    const grid = el('div', 'ch-ref-grid');
    for (const c of cards) grid.append(refRow(c));
    sec.append(grid);
    host.append(sec);
  }
}

function refRow(c) {
  const row = el('div', 'ch-ref-row');
  row.append(cardEl(c.key, { size: 'mid' }));
  const body = el('div', 'ch-ref-body');
  body.append(el('b', '', c.name), el('span', 'dim', ` · Level ${c.level} · power ${c.power} · ${copiesWord(c)}${c.unconfirmed ? ' (count not yet checked against the cards)' : ''}`));
  if (c.text) { const t = el('div', ''); t.append(cardText(c)); body.append(t); }
  row.append(body);
  return row;
}

// ---------------------------------------------------------------- tips

// What a card does and what a number means. The browser's own title tooltip
// waits a second or more and never appears on a phone, so the game draws its
// own: a mouse gets one after a short pause, and a tap on anything that is not
// a move pins one until the next tap. Elements opt in with data-tip (plain
// words) or data-tip-card (a card, with data-tip-why for where its power
// comes from); data-tip-key finds the element again after a redraw.
const TIP_DELAY = 110;
const TIP_SEL = '[data-tip], [data-tip-card]';
let tipEl = null;
let tipFor = null;
let tipKey = null;
let tipPinned = false;
let tipTimer = null;
let tipDropped = null;

// what a card says, for the tip that explains it
function cardTip(key, why) {
  const c = CARD[key];
  const set = SETS[c.set];
  const card = el('div', 'tb-card');
  const head = el('div', `tb-card-head set-${c.set}`);
  head.append(el('span', 'tb-card-glyph', set.icon), el('b', 'tb-card-name', c.name), el('span', 'tb-card-str', `${c.level === 'S' ? 'starter' : `Level ${c.level}`} · power ${c.power}`));
  card.append(head);
  if (c.text || c.kw) { const t = el('span', 'tb-card-text'); t.append(cardText(c)); card.append(t); }
  else card.append(el('span', 'tb-card-note', 'No effect — just its power.'));
  card.append(el('span', 'tb-card-note', `${set.name} · ${copiesWord(c)}`));
  if (why) card.append(el('span', 'tb-card-why', why));
  return card;
}

function tipBody(a) {
  const d = a.dataset;
  if (d.tipCard) return cardTip(d.tipCard, d.tipWhy);
  if (d.tip) return el('div', 'tb-card', d.tip);
  return null;
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

const PHASE = { deck: 'Deck Phase', match: 'Match Phase', 'final-deck': 'Before the final', over: 'Tournament over' };

function renderGame(view, sess) {
  lastView = view;
  renderDcBanner(view, sess);
  renderObBar(view, sess);
  renderWatchChip(view);
  ensureResignBtn(sess);
  if (viewMid !== view.mid) {
    viewMid = view.mid;
    watching = null;
    cutMarks = new Set();
    qsel = { key: null, ids: [] };
  }

  $('#room-chip').textContent = view.code || '·····';
  const rc = $('#round-chip');
  rc.textContent = view.final ? 'The final' : `Round ${view.round} of ${view.rounds}`;
  rc.dataset.tip = view.players.length > 2 ? 'Seven rounds, then a final between the two players with the most fans.' : 'Seven rounds, no final: the most fans wins — or a lead of 11 at any match’s end.';
  const pc = $('#phase-chip');
  pc.textContent = PHASE[view.phase] || '';
  pc.dataset.tip = view.phase === 'deck' ? 'Everyone drafts at their own pace; the matches start when all are done.'
    : view.phase === 'match' ? 'Every match plays itself. A card that asks its owner something pauses that match until they answer.'
      : '';

  const stage = $('#stage');
  stage.replaceChildren();
  let shownId = null;
  if (view.phase === 'deck' || view.phase === 'final-deck') {
    renderDraft(view, stage);
  } else {
    const M = view.matches.find((x) => x.id === watching) || view.matches.find((x) => x.seats.includes(view.you)) || view.matches[0];
    if (M) { shownId = M.id; renderMatch(view, M, stage); }
    else stage.append(el('p', 'ch-wait', 'Waiting…'));
  }
  renderStandings(view);
  renderOthers(view, shownId);
  renderLog(view);
  paintChatBubbles();
  retip();

  if (view.fx && view.fx.seq !== lastFxSeq) {
    lastFxSeq = view.fx.seq;
    const fx = view.fx;
    if (fx.kind === 'deck' && fx.round > 1) flash(`Round ${fx.round}: draft`, 'plain');
    else if (fx.kind === 'matches') flash(view.final ? 'The final!' : `Round ${fx.round}: kick-off`, 'plain');
    else if (fx.kind === 'final') flash(`Final: ${seatName(view, fx.seats[0])} vs ${seatName(view, fx.seats[1])}`, 'plain');
  }

  settleOverlay('#gameover', view.phase === 'over', () => showGameover(view, sess));
}

// ---------------------------------------------------------------- game over

let confettiDone = false;

function showGameover(view, sess) {
  const m = $('#gameover');
  m.classList.remove('hidden');
  const res = view.result;
  const won = view.winner === view.you;
  $('#go-title').textContent = won ? 'Champion!' : `${seatName(view, view.winner)} wins`;
  $('#go-sub').textContent = res.why;
  const list = $('#go-rank');
  list.replaceChildren();
  // the champion first, then everyone else by fans
  const rows = res.ranked.slice().sort((a, b) => (b.seat === view.winner) - (a.seat === view.winner));
  rows.forEach((s, i) => {
    const p = view.players.find((q) => q.seat === s.seat);
    const row = el('li', `rank-row${s.seat === view.you ? ' me' : ''}`);
    row.append(el('span', 'rank-pos', s.seat === view.winner ? '🏆' : String(i + 1)));
    row.append(avatarEl(p.name, p.seat, p.bot));
    row.append(el('span', 'rank-name', p.name + (p.connected || p.bot ? '' : ' (left)')));
    row.append(el('span', 'rank-score', `${s.fans} fans · ${s.trophies.length} Troph${s.trophies.length === 1 ? 'y' : 'ies'}`));
    list.append(row);
  });
  $('#btn-again').classList.toggle('hidden', !sess.isHost);
  $('#btn-golobby').classList.toggle('hidden', !sess.isHost);
  $('#go-wait').classList.toggle('hidden', sess.isHost);
  if (won && !confettiDone) {
    confettiDone = true;
    confetti();
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
  localStorage.setItem('chg-name', name);
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
  localStorage.setItem('chg-name', name);
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
  $('#name-input').value = localStorage.getItem('chg-name') || '';
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

  $('#btn-cards').addEventListener('click', () => {
    $('#modal-cards').classList.remove('hidden');
    renderCardRef(lastView);
  });
  $('#btn-cards-close').addEventListener('click', () => $('#modal-cards').classList.add('hidden'));
  $('#modal-cards').addEventListener('click', (e) => {
    if (e.target === $('#modal-cards')) $('#modal-cards').classList.add('hidden');
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
