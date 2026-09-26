// app.js — networking + UI for Toy Battle.
//
// Topology: host-authoritative star over WebRTC data channels.
//   - The host's browser owns the game state and validates every move.
//   - Guests connect straight to the host (peer-to-peer); no game server.
//   - NAT traversal uses Google's public STUN servers (see RTC_CONFIG).
//   - Peer discovery/signaling uses the free PeerJS cloud broker, because
//     GitHub Pages can only serve static files.
// Bots fill the second seat (the host adds one in the lobby) and take over
// for anyone who disconnects.

import {
  PROTO,
  MIN_PLAYERS,
  MAX_PLAYERS,
  RACK_MAX,
  TROOPS,
  TROOP_ORDER,
  TERRAINS,
  POWERS,
  BOT_LEVELS,
  DEFAULT_LEVEL,
  terrainByKey,
  troopLabel,
  strengthOf,
  placeOptions,
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
import { layoutTerrain, BASE, HQ, MEDAL } from './layout.js';
import { initSettings } from '../common/settings.js';
import '../common/feedtoggle.js';
import '../common/version.js';

// The ⚙ drawer (bottom-left): live-tunable pacing for testing. Defaults
// reproduce the shipped behavior exactly; overrides stay in this browser.
const cfg = initSettings('tb', [
  { key: 'botTurn', label: 'Bot turn delay', def: [1500, 900], section: 'Host pacing', host: true },
  { key: 'botStep', label: 'Bot follow-up delay', def: [700, 400], section: 'Host pacing', host: true, hint: 'Pauses before a bot answers its own Cap’n, Jumbo or special base.' },
  { key: 'bubbleChat', label: 'Chat bubbles linger', def: 6500, section: 'Bubbles & banners' },
  { key: 'bubbleTrunc', label: 'Bubble text cap', def: 84, min: 12, max: 400, step: 4, unit: 'ch', ms: false, section: 'Bubbles & banners' },
  { key: 'flashMs', label: 'Banner duration', def: 1700, section: 'Bubbles & banners' },
  { key: 'overlayDelay', label: 'Result screen delay', def: 3400, section: 'Overlays' },
  { key: 'revealBots', label: "Show the bot's hand", def: false, bool: true, section: 'Testing', host: true, hint: 'Turn the bot’s rack face up under its row of the scoreboard while you play, to learn what it holds and why it plays what it does. Only the host builds views, so this shows it to everyone at the table. The 👁 beside the bot’s name flips the same switch.' },
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
const ID_PREFIX = 'tbp-v1-';
const BOT_NAMES = ['Tinbeard', 'Sarge', 'Clockwork', 'Bosun', 'Rivet', 'Corporal', 'Sprocket', 'Major'];
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
    this.terrainKey = TERRAINS[0].key;
    this.botLevel = DEFAULT_LEVEL;
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
  claimOk() {
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
      toast('The meadow is full');
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

  setTerrain(key) {
    if (this.G) return;
    this.terrainKey = terrainByKey(key).key;
    this.pushLobby();
  }

  // Bot skill is the host's browser doing the thinking, so only the host sets
  // it — and it can change between games without leaving the lobby.
  setBotLevel(key) {
    if (!BOT_LEVELS[key]) return;
    this.botLevel = key;
    this.pushLobby();
  }

  // The turn player acts in several small steps (take, three placements,
  // maybe a card, cubes, end). Bots pause longer before a fresh turn, then
  // move briskly through the steps so the table stays readable.
  // A turn is one action, but an action can stop and ask a question (Cap'n's
  // extra Troop, Jumbo's shove, a special base). Whoever the engine is
  // waiting on is the actor — which during a pending choice is not
  // necessarily the player whose turn it is.
  scheduleBots() {
    clearTimeout(this.botTimer);
    if (!this.G || this.G.phase !== 'playing') return;
    const seat = this.G.pending ? this.G.pending.seat : this.G.turn;
    if (!this.seatCovered(seat)) return;
    const delay = this.G.pending ? cfg.range('botStep') : cfg.range('botTurn');
    this.botTimer = setTimeout(() => {
      if (!this.G || this.G.phase !== 'playing') return;
      const actor = this.G.pending ? this.G.pending.seat : this.G.turn;
      if (!this.seatCovered(actor)) return;
      const move = botChoose(this.G, actor, { level: this.botLevel });
      // never stall the table: a pending choice is always declinable, and a
      // player who can do nothing at all is handled by the engine itself
      const res = move ? applyMove(this.G, actor, move) : { ok: false };
      if (!res.ok && this.G.pending) applyMove(this.G, actor, { kind: 'skip' });
      else if (!res.ok && this.G.turn === actor) applyMove(this.G, actor, { kind: 'draw' });
      this.broadcast();
    }, delay);
  }

  lobbyMsg() {
    return {
      t: 'lobby',
      code: this.code,
      watchers: this.watchers.map((x) => x.name),
      players: this.roster.map((p) => ({ seat: p.seat, name: p.name, bot: !!p.bot })),
      min: MIN_PLAYERS,
      max: MAX_PLAYERS,
      terrain: this.terrainKey,
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
    if (this.roster.length < MIN_PLAYERS) {
      toast(`Need at least ${MIN_PLAYERS} players`);
      return;
    }
    this.G = newMatch(this.roster, { terrain: this.terrainKey });
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
    this.G = newMatch(this.roster, { terrain: this.terrainKey });
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
    if (this.G && this.G.fx && this.G.fx.seq !== this._bannerFxSeen) {
      this._bannerFxSeen = this.G.fx.seq;
      if (this.G.fx.kind === 'lastround') {
        this.bannerUntil = Math.max(this.bannerUntil || 0, Date.now() + cfg('flashMs'));
      }
    }
    pendingMove = false;
    showScreen('game');
    this.pushViews();
    this.scheduleBots();
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
            full: 'That meadow is full (4 players max).',
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

const REJOIN_KEY = 'tb-rejoin';

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
        kick.title = `Remove ${p.name}`;
        kick.addEventListener('click', () => sess.removeBot(p.seat));
        row.append(kick);
      }
    } else {
      row.append(el('div', 'av empty', '·'), el('span', 'seat-name dim', 'Empty seat'));
    }
    list.append(row);
  }
  const sp = $('#terrain-picker');
  sp.replaceChildren();
  for (const t of TERRAINS) {
    const b = el('button', `side-pick${t.key === lob.terrain ? ' on' : ''}`, t.name);
    b.type = 'button';
    b.disabled = !sess.isHost;
    if (sess.isHost) b.addEventListener('click', () => sess.setTerrain(t.key));
    sp.append(b);
  }
  const bp = $('#bot-picker');
  bp.replaceChildren();
  for (const [key, lvl] of Object.entries(BOT_LEVELS)) {
    const b = el('button', `side-pick${key === lob.botLevel ? ' on' : ''}`, lvl.label);
    b.type = 'button';
    b.title = lvl.blurb;
    b.disabled = !sess.isHost;
    if (sess.isHost) b.addEventListener('click', () => sess.setBotLevel(key));
    bp.append(b);
  }
  $('#bot-blurb').textContent = (BOT_LEVELS[lob.botLevel] || BOT_LEVELS[DEFAULT_LEVEL]).blurb;

  const chosen = terrainByKey(lob.terrain);
  const blurb = $('#terrain-blurb');
  blurb.replaceChildren(
    el('div', 'tb-blurb-tag', chosen.tag),
    el('div', 'tb-blurb-power', `${POWERS[chosen.power].cry} — ${POWERS[chosen.power].text}`),
    el('div', 'tb-blurb-goal', `Medals objective: ${chosen.target}`),
    el('div', `tb-blurb-source ${chosen.source}`, chosen.source === 'board'
      ? 'Layout read off the printed board.'
      : 'Invented layout — not the printed board.'),
  );

  $('#btn-start').classList.toggle('hidden', !sess.isHost);
  $('#btn-add-bot').classList.toggle('hidden', !sess.isHost);
  if (sess.isHost) {
    $('#btn-start').disabled = lob.players.length < lob.min;
    $('#btn-add-bot').disabled = lob.players.length >= lob.max;
  }
  const n = lob.players.length;
  $('#lobby-hint').textContent = sess.isHost
    ? n < lob.min
      ? 'Share the code or link — or add a bot for a quick skirmish.'
      : 'Both sides ready. Blue moves from the bottom of the board, red from the top.'
    : 'Waiting for the host to start…';
  paintChatBubbles();
}

// ---------------------------------------------------------------- UI state

// viewSeat: whose board fills the workspace (all boards are public)
// ---------------------------------------------------------------- UI state

// choice.tile is the Troop lifted off your rack; choice.from is the first
// half of the volcano's two-part answer (which enemy Troop to throw).
let viewMid = null;
let choice = { tile: null, from: null };

function resetChoice() {
  choice = { tile: null, from: null };
}

const me = (view) => view.players.find((p) => p.seat === view.you);
const foeOf = (view) => view.players.find((p) => p.seat !== view.you);
const seatName = (view, seat) => {
  const p = view.players.find((q) => q.seat === seat);
  return p ? p.name : 'someone';
};
// The boards are printed in two colours and the rules lean on them, so the
// seat number is only ever a stand-in for blue and red.
const side = (seat) => (seat === 0 ? 'blue' : 'red');

const SVGNS = 'http://www.w3.org/2000/svg';
function sv(tag, cls, attrs = {}) {
  const n = document.createElementNS(SVGNS, tag);
  if (cls) n.setAttribute('class', cls);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

// ---------------------------------------------------------------- the board

// Where everything sits comes from layout.js, which takes the printed card
// and spaces out whatever would crowd at screen size. Both players get the
// same layout; this part only turns it the right way up for each of them.

// Which way up to draw the board. Everyone should see their own H.Q. at the
// bottom of the screen, as they would sitting at the table, but the printed
// boards do not agree on where that is: Castle Field puts blue's keep at the
// bottom, Volcanic Jungle at the top, City of Clouds at the left end. So the
// drawing is turned by quarter turns until the line from your own H.Q. to the
// enemy's points up the screen. Cached per view, which arrives fresh with
// every broadcast.
let frameFor = null;
let frameOf = null;
function frame(view) {
  if (frameFor === view) return frameOf;
  const t = view.terrain;
  const L = layoutTerrain(t);
  const centre = (seat) => {
    const hs = t.nodes.filter((n) => n.hq === seat).map((n) => L.pos[n.id]);
    return [hs.reduce((s, p) => s + p[0], 0) / hs.length, hs.reduce((s, p) => s + p[1], 0) / hs.length];
  };
  const [mx, my] = centre(view.you === 1 ? 1 : 0);
  const [ox, oy] = centre(view.you === 1 ? 0 : 1);
  const dx = ox - mx;
  const dy = oy - my;
  // clockwise quarter turns that bring (dx, dy) round to pointing up
  const turns = Math.abs(dy) >= Math.abs(dx) ? (dy < 0 ? 0 : 2) : (dx > 0 ? 3 : 1);
  frameFor = view;
  frameOf = { L, turns, w: turns % 2 ? L.h : L.w, h: turns % 2 ? L.w : L.h };
  return frameOf;
}

// a point of the layout, turned for this viewer
function place(view, x, y) {
  const { L, turns } = frame(view);
  return turns === 0 ? [x, y]
    : turns === 1 ? [L.h - y, x]
      : turns === 2 ? [L.w - x, L.h - y]
        : [y, L.w - x];
}
const nodeAt = (view, id) => place(view, ...frame(view).L.pos[id]);

// A region is the ground enclosed by the bases that ring it, so it is drawn
// as their polygon pulled in off the bases themselves. That works for a ring
// of three as well as a ring of six, which a fixed square never did.
function regionPath(pts) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const inner = pts.map(([x, y]) => {
    const dx = cx - x, dy = cy - y;
    const d = Math.hypot(dx, dy) || 1;
    const k = Math.min(42, d * 0.42) / d;
    return [(x + dx * k).toFixed(1), (y + dy * k).toFixed(1)];
  });
  return 'M' + inner.map((p) => p.join(' ')).join('L') + 'Z';
}

// What each Terrain's special bases look like: the retreat back to the rack,
// the rainbow, the volcanoes, the pumpkin graves, the shield plates and the
// sniper's sights. Tropical Pool's floats show their values instead, and
// Caribbean Sea has none.
const SPECIAL_MARK = { retreat: '↩', splendor: '🌈', eruption: '🌋', undead: '🎃', shield: '🛡', sniper: '🎯' };

// the values a float or an H.Q. takes, the joker as a star
const onlyText = (only) => only.map((v) => (v === 'joker' ? '★' : v)).join(' ');

// Which nodes the click handler should accept right now, and why.
function liveTargets(view) {
  const p = view.pending;
  if (p && p.seat === view.you) {
    if (p.kind === 'jumbo' || p.kind === 'retreat') return new Set(p.options);
    if (p.kind === 'eruption') {
      if (choice.from === null) return new Set(p.options);
      // second half: the bases its starting base touches
      return new Set(shadow(view).terrain.adj[choice.from].filter((m) => view.terrain.nodes[m].hq === null));
    }
    if (p.kind === 'capn' && choice.tile) return new Set(legalFor(view, choice.tile));
    return new Set();
  }
  if (view.phase !== 'playing' || view.turn !== view.you || !choice.tile) return new Set();
  return new Set(legalFor(view, choice.tile));
}

// The engine owns the rules; the view just asks it the same question with a
// throwaway state shaped like the one the host holds.
function legalFor(view, tileId) {
  const tile = view.rack.find((t) => t.id === tileId);
  if (!tile) return [];
  const G = shadow(view);
  return placeOptions(G, view.you, tile.key);
}

// A read-only stand-in for the host's game object, good enough for the pure
// rule function placeOptions and nothing else. The
// view arrives fresh on every broadcast, so one cache slot keyed on identity
// is all it needs — and it saves rebuilding adjacency once per rack Troop.
let shadowFor = null;
let shadowOf = null;
function shadow(view) {
  if (shadowFor === view) return shadowOf;
  const adj = view.terrain.nodes.map(() => []);
  for (const [a, b] of view.terrain.edges) { adj[a].push(b); adj[b].push(a); }
  shadowFor = view;
  shadowOf = { terrain: { ...view.terrain, adj }, board: view.board.map((st) => st.slice()) };
  return shadowOf;
}

function renderBoard(view) {
  const t = view.terrain;
  const host = $('#board');
  const { L, w: W, h: H } = frame(view);
  const svg = sv('svg', 'board-svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${t.name} board` });
  const targets = liveTargets(view);
  const mark = SPECIAL_MARK[t.power] || '★';

  // paths first, so everything else sits on top of them
  for (const [a, b] of t.edges) {
    const [x1, y1] = nodeAt(view, a);
    const [x2, y2] = nodeAt(view, b);
    svg.append(sv('line', 'tb-path', { x1, y1, x2, y2 }));
  }

  // regions and the Medals sitting in them
  t.regions.forEach((r, i) => {
    const spot = L.medals[i];
    const g = sv('g', `tb-region${r.owner === null ? '' : ` taken ${side(r.owner)}`}`);
    g.append(sv('path', 'tb-region-pad', { d: regionPath((r.ring || r.around).map((n) => nodeAt(view, n))) }));
    if (r.owner === null) {
      for (const [x, y] of spot.dots) {
        const [cx, cy] = place(view, x, y);
        g.append(sv('circle', 'tb-medal', { cx, cy, r: MEDAL }));
      }
    } else {
      const [cx, cy] = place(view, spot.x, spot.y);
      const label = sv('text', 'tb-region-claim', { x: cx, y: cy + 7, 'text-anchor': 'middle' });
      label.textContent = '★';
      g.append(label);
    }
    svg.append(g);
  });

  // H.Q. and bases
  for (const n of t.nodes) {
    const [cx, cy] = nodeAt(view, n.id);
    const stack = view.board[n.id];
    const top = stack[stack.length - 1] || null;
    const isHq = n.hq !== null;
    const size = isHq ? HQ : BASE;
    const cls = ['tb-node'];
    if (isHq) cls.push('hq', side(n.hq));
    else cls.push('base');
    if (n.special) cls.push('special');
    if (n.only) cls.push('restricted');
    if (targets.has(n.id)) cls.push('legal');
    if (choice.from === n.id) cls.push('picked');
    const readable = top || n.hq !== null || n.special || n.only;
    const g = sv('g', cls.join(' '), { 'data-node': n.id, tabindex: targets.has(n.id) || readable ? 0 : -1 });
    if (readable) {
      g.dataset.tipNode = n.id;
      g.dataset.tipKey = `node:${n.id}`;
    }
    g.append(sv('rect', 'tb-slot', { x: cx - size / 2, y: cy - size / 2, width: size, height: size, rx: isHq ? 16 : 10 }));

    if (isHq && !top) {
      const flag = sv('text', 'tb-hq-mark', { x: cx, y: cy + (n.only ? 14 : 10), 'text-anchor': 'middle' });
      flag.textContent = n.hq === view.you ? '⌂' : '⚑';
      g.append(flag);
    }
    // an empty special base shows what it does; a held one keeps a corner badge
    if (n.special && !n.only && !top) {
      const m = sv('text', 'tb-special-mark', { x: cx, y: cy + 10, 'text-anchor': 'middle' });
      m.textContent = mark;
      g.append(m);
    }

    if (top) {
      const tg = sv('g', `tb-tile ${side(top.owner)}`);
      tg.append(sv('rect', 'tb-tile-body', { x: cx - 27, y: cy - 27, width: 54, height: 54, rx: 9 }));
      const glyph = sv('text', 'tb-tile-glyph', { x: cx, y: cy + 11, 'text-anchor': 'middle' });
      glyph.textContent = TROOPS[top.key].glyph;
      tg.append(glyph);
      const num = sv('text', 'tb-tile-str', { x: cx - 18, y: cy - 12, 'text-anchor': 'middle' });
      num.textContent = strengthOf(top.key) === null ? '★' : String(strengthOf(top.key));
      tg.append(num);
      if (stack.length > 1) {
        const d = sv('text', 'tb-tile-depth', { x: cx + 18, y: cy + 23, 'text-anchor': 'middle' });
        d.textContent = '×' + stack.length;
        tg.append(d);
      }
      g.append(tg);
      if (n.special && !n.only) {
        g.append(sv('circle', 'tb-badge', { cx: cx + size / 2 - 3, cy: cy - size / 2 + 3, r: 11 }));
        const m = sv('text', 'tb-badge-mark', { x: cx + size / 2 - 3, y: cy - size / 2 + 7.5, 'text-anchor': 'middle' });
        m.textContent = mark;
        g.append(m);
      }
    }

    // A float's values sit in a tab across its top edge, over any Troop on
    // it, because they still decide who may cover that Troop.
    if (n.only) {
      const text = onlyText(n.only);
      const tw = text.length * 7 + 12;
      const ty = cy - size / 2;
      g.append(sv('rect', 'tb-only-tab', { x: cx - tw / 2, y: ty - 9, width: tw, height: 18, rx: 9 }));
      const lab = sv('text', 'tb-only', { x: cx, y: ty + 4.5, 'text-anchor': 'middle' });
      lab.textContent = text;
      g.append(lab);
    }
    svg.append(g);
  }

  svg.addEventListener('click', (e) => {
    const g = e.target.closest('[data-node]');
    if (g) onNodeClick(view, Number(g.dataset.node), g);
  });
  svg.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const g = e.target.closest('[data-node]');
    if (!g) return;
    e.preventDefault();
    onNodeClick(view, Number(g.dataset.node), g);
  });
  host.replaceChildren(svg);
}

function onNodeClick(view, node, g) {
  // not a move: then it is a question — what is standing there?
  if (!liveTargets(view).has(node)) {
    if (g && g.dataset.tipNode !== undefined) pinTip(g);
    return;
  }
  hideTip();
  const p = view.pending;
  if (p && p.seat === view.you) {
    if (p.kind === 'jumbo') return sendMove({ kind: 'jumbo', node });
    if (p.kind === 'retreat') return sendMove({ kind: 'retreat', node });
    if (p.kind === 'eruption') {
      if (choice.from === null) { choice.from = node; return renderGame(view, session); }
      const from = choice.from;
      choice.from = null;
      return sendMove({ kind: 'eruption', from, to: node });
    }
  }
  if (!choice.tile) return;
  const tile = choice.tile;
  choice.tile = null;
  sendMove({ kind: 'place', tile, node });
}

// ---------------------------------------------------------------- the rack

function rackTileEl(view, t, opts = {}) {
  const b = el('button', `tb-troop ${side(view.you)}${opts.sel ? ' sel' : ''}${opts.dead ? ' dead' : ''}`);
  b.type = 'button';
  const str = strengthOf(t.key);
  b.append(el('span', 'tb-troop-str', str === null ? '★' : String(str)));
  b.append(el('span', 'tb-troop-glyph', TROOPS[t.key].glyph));
  b.append(el('span', 'tb-troop-name', TROOPS[t.key].name));
  b.dataset.tipTroop = t.key;
  b.dataset.tipOwner = view.you;
  b.dataset.tipKey = `troop:${t.id}`;
  b.setAttribute('aria-label', `${troopLabel(t.key)}: ${TROOPS[t.key].text}`);
  return b;
}

function renderRack(view) {
  const host = $('#rack');
  host.replaceChildren();
  const my = me(view);
  if (!my) return;
  const mine = view.rack;
  const myTurn = view.phase === 'playing' && ((view.pending && view.pending.seat === view.you && view.pending.kind === 'capn') || (!view.pending && view.turn === view.you));
  for (const t of mine) {
    const pinned = my.frozen === t.id;
    const opts = placeOptions(shadow(view), view.you, t.key);
    const dead = !myTurn || pinned || opts.length === 0;
    const b = rackTileEl(view, t, { sel: choice.tile === t.id, dead });
    if (pinned) b.dataset.tipWhy = 'A sniper has it pinned — it comes back at the end of your turn.';
    else if (dead && myTurn) b.dataset.tipWhy = 'Nowhere legal to place it right now.';
    if (dead) b.setAttribute('aria-disabled', 'true');
    b.addEventListener('click', () => {
      // a Troop you cannot play still answers a tap, with what it does
      if (dead) return pinTip(b);
      hideTip();
      choice.tile = choice.tile === t.id ? null : t.id;
      renderGame(view, session);
    });
    host.append(b);
  }
  if (!mine.length) host.append(el('div', 'tb-rack-empty', 'Your rack is empty — draw.'));
}

// ---------------------------------------------------------------- tips

// What a Troop does, what a base does, what a number means. The browser's
// own title tooltip waits a second or more and never appears on a phone, so
// the game draws its own: a mouse gets one after a short pause, and a tap on
// anything that is not a move pins one until the next tap. Elements opt in
// with data-tip (plain words), data-tip-troop (a Troop, with data-tip-owner
// for its side and data-tip-why for why it cannot move) or data-tip-node (a
// base on the board). data-tip-key finds the element again after a redraw.
const TIP_DELAY = 110;
const TIP_SEL = '[data-tip], [data-tip-troop], [data-tip-node]';
let tipEl = null;
let tipFor = null;
let tipKey = null;
let tipPinned = false;
let tipTimer = null;
let tipDropped = null;

function troopCard(key, owner, why) {
  const t = TROOPS[key];
  const card = el('div', 'tb-card');
  const head = el('div', `tb-card-head${owner === null || owner === undefined ? '' : ' ' + side(owner)}`);
  head.append(el('span', 'tb-card-glyph', t.glyph));
  head.append(el('b', 'tb-card-name', t.name));
  head.append(el('span', 'tb-card-str', t.str === null ? '★ joker' : `strength ${t.str}`));
  card.append(head);
  card.append(el('i', 'tb-card-cry', t.cry));
  card.append(el('span', 'tb-card-text', t.text));
  if (t.note) card.append(el('span', 'tb-card-note', 'Note: ' + t.note));
  if (why) card.append(el('span', 'tb-card-why', why));
  return card;
}

// what a restricted base or H.Q. admits, as a sentence
function onlyWords(only) {
  const nums = only.filter((v) => v !== 'joker');
  if (!nums.length) return 'Only Kwak, the joker, may be placed on it.';
  const list = nums.length > 1 ? `${nums.slice(0, -1).join(', ')} or ${nums[nums.length - 1]}` : String(nums[0]);
  return `Only a Troop of strength ${list}${only.includes('joker') ? ' — or Kwak, the joker —' : ''} may be placed on it.`;
}

function baseWords(view, n) {
  const t = view.terrain;
  if (n.hq !== null) {
    const mine = n.hq === view.you;
    const who = mine ? 'Your H.Q.' : `${seatName(view, n.hq)}’s H.Q.`;
    const what = mine
      ? 'Guard it: an enemy Troop placed here wins them the game.'
      : 'Place a Troop here, along a chain of your own, and you win.';
    return `${who} ${what}${n.only ? ` ${onlyWords(n.only)}` : ''}`;
  }
  if (n.only) return `A float. ${onlyWords(n.only)}`;
  // the aid prints each power beside the base it fires on; said here as what
  // landing on this base does — except the shield, which is what it prevents
  if (n.special) {
    return t.power === 'shield'
      ? `Special base: ${POWERS.shield.text}`
      : `Special base. Place a Troop here, then: ${POWERS[t.power].text}`;
  }
  return null;
}

function nodeCard(view, id) {
  const n = view.terrain.nodes[id];
  const stack = view.board[id] || [];
  const card = el('div', 'tb-card');
  if (stack.length) {
    const top = stack[stack.length - 1];
    const inner = troopCard(top.key, top.owner);
    card.append(...inner.childNodes);
    if (stack.length > 1) {
      const under = stack.slice(0, -1).reverse().map((x) => `${troopLabel(x.key)}, ${side(x.owner)}`);
      card.append(el('span', 'tb-card-note', `Underneath: ${under.join(' · ')}`));
    }
  }
  const words = baseWords(view, n);
  if (words) card.append(el('span', 'tb-card-base', words));
  return card.childNodes.length ? card : null;
}

function tipBody(a) {
  const d = a.dataset;
  if (d.tipTroop) return troopCard(d.tipTroop, d.tipOwner === undefined ? null : Number(d.tipOwner), d.tipWhy);
  if (d.tipNode !== undefined) return lastView ? nodeCard(lastView, Number(d.tipNode)) : null;
  if (d.tip) return el('div', 'tb-card', d.tip);
  return null;
}

function showTip(a, pinned = false) {
  clearTimeout(tipTimer);
  // the Troop you are holding already has its card up by the prompt
  if (!pinned && a.classList.contains('sel')) return hideTip();
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

// ---------------------------------------------------------------- seats

// One scoreboard for the two seats, a row each — theirs on top, as the board
// has their H.Q. at the top — under column heads that say what every number
// is: Medals, Hand, Reserve. The row whose turn it is lights up.
function renderSeats(view) {
  const host = $('#seats');
  host.replaceChildren();
  const rows = [foeOf(view), me(view)].filter(Boolean);
  if (!rows.length) return;
  const board = el('div', 'tb-score');
  const top = el('div', 'tb-score-row tb-score-top');
  top.append(el('span', ''), el('span', '', 'Medals'), el('span', '', 'Hand'), el('span', '', 'Reserve'));
  board.append(top);
  const whoHas = (p) => (p.seat === view.you ? 'You have' : `${p.name} has`);

  for (const p of rows) {
    const on = view.phase === 'playing' && p.seat === view.turn;
    const row = el('div', `tb-score-row ${side(p.seat)}${on ? ' on' : ''}${p.seat === view.you ? ' you' : ''}`);
    const who = el('div', 'tb-score-who');
    who.append(avatarEl(p.name, p.seat, p.bot));
    who.append(el('b', 'tb-score-name', p.name + (p.connected || p.bot ? '' : ' (away)')));
    if (p.bot && view.botLevel && BOT_LEVELS[view.botLevel]) {
      const chip = el('span', 'tb-skill', BOT_LEVELS[view.botLevel].label);
      chip.dataset.tip = BOT_LEVELS[view.botLevel].blurb;
      who.append(chip);
    }
    if (p.bot && p.seat !== view.you && session && session.isHost && !session.observer) {
      const shown = cfg.on('revealBots');
      const eye = el('button', `tb-eye${shown ? ' on' : ''}`, shown ? '🙈' : '👁');
      eye.type = 'button';
      eye.setAttribute('aria-pressed', String(shown));
      eye.setAttribute('aria-label', shown ? `Hide ${p.name}’s hand` : `Show ${p.name}’s hand`);
      eye.dataset.tip = shown ? `Hide ${p.name}’s hand again.` : `Show ${p.name}’s hand — for practice, to see what the bot holds and why it plays what it does.`;
      eye.addEventListener('click', () => {
        hideTip();
        cfg.set('revealBots', !cfg.on('revealBots'));
        session.pushViews();
      });
      who.append(eye);
    }
    row.append(who);
    const num = (key, text, tip) => {
      const n = el('div', `tb-score-num ${key}`, text);
      n.dataset.tip = tip;
      n.dataset.tipKey = `count:${p.seat}:${key}`;
      return n;
    };
    row.append(num('medals', `★ ${p.medals}/${view.terrain.target}`,
      `${whoHas(p)} ${p.medals} of the ${view.terrain.target} Medals it takes to win.`));
    const hand = num('hand', String(p.rackCount),
      `${whoHas(p)} ${p.rackCount} Troop${p.rackCount === 1 ? '' : 's'} in hand, on the rack and ready to place. A rack holds ${RACK_MAX} at most.`);
    if (p.rackCount >= RACK_MAX) hand.classList.add('full');
    row.append(hand);
    row.append(num('reserve', String(p.reserveCount),
      `${whoHas(p)} ${p.reserveCount} face-down Troop${p.reserveCount === 1 ? '' : 's'} left in reserve to draw from.`));
    board.append(row);

    if (p.frozen) {
      board.append(el('div', 'tb-score-note', p.seat === view.you
        ? '📌 A sniper has one of your Troops pinned until the end of your turn.'
        : `📌 A sniper has one of ${p.name}’s Troops pinned until the end of their turn.`));
    }

    // For practice, the host can turn a bot's hand face up; it shows under
    // the bot's row, and the eye beside its name flips it
    if (p.peek) {
      const line = el('div', 'tb-peek');
      for (const t of p.peek) {
        const chip = el('span', `tb-peek-chip ${side(p.seat)}${t.pinned ? ' pinned' : ''}`);
        chip.append(el('b', '', strengthOf(t.key) === null ? '★' : String(strengthOf(t.key))), el('span', '', TROOPS[t.key].glyph));
        chip.dataset.tipTroop = t.key;
        chip.dataset.tipOwner = p.seat;
        chip.dataset.tipKey = `peek:${t.id}`;
        if (t.pinned) chip.dataset.tipWhy = 'Pinned by your sniper until the end of their turn.';
        chip.tabIndex = 0;
        line.append(chip);
      }
      if (!p.peek.length) line.append(el('span', 'tb-peek-empty', 'Nothing in hand.'));
      board.append(line);
    }
  }
  host.append(board);
}

// ---------------------------------------------------------------- action bar

function actBtn(label, cls, fn) {
  const b = el('button', `btn ${cls}`, label);
  b.type = 'button';
  b.addEventListener('click', fn);
  return b;
}

function renderActionBar(view) {
  const host = $('#action-bar');
  host.replaceChildren();
  if (view.phase === 'over') return;
  const p = view.pending;

  if (p && p.seat !== view.you) {
    host.append(el('div', 'tb-prompt dim', `${seatName(view, p.seat)} is deciding…`));
    return;
  }

  if (p) {
    const power = POWERS[view.terrain.power];
    if (p.kind === 'capn') {
      const held = choice.tile && view.rack.find((t) => t.id === choice.tile);
      if (held) host.append(heldCard(held));
      host.append(el('div', 'tb-prompt', held
        ? `Cap’n’s extra Troop: pick a lit base for ${TROOPS[held.key].name}, or tap it again to put it back.`
        : 'Cap’n: place one extra Troop, or wave them off.'));
      host.append(actBtn('No extra Troop', 'ghost', () => sendMove({ kind: 'skip' })));
    } else if (p.kind === 'jumbo') {
      host.append(el('div', 'tb-prompt', 'Jumbo: pick a neighbouring enemy Troop to shove into the discard.'));
      host.append(actBtn('Leave them be', 'ghost', () => sendMove({ kind: 'skip' })));
    } else if (p.kind === 'retreat') {
      host.append(el('div', 'tb-prompt', `${power.cry} Pick one of your other Troops to pull back onto your rack.`));
      host.append(actBtn('Nobody retreats', 'ghost', () => sendMove({ kind: 'skip' })));
    } else if (p.kind === 'eruption') {
      host.append(el('div', 'tb-prompt', choice.from === null
        ? `${power.cry} Pick an enemy Troop beside the volcano.`
        : 'Now pick the base to throw it onto.'));
      host.append(actBtn(choice.from === null ? 'Let it rumble' : 'Pick a different Troop', 'ghost', () => {
        if (choice.from === null) sendMove({ kind: 'skip' });
        else { choice.from = null; renderGame(view, session); }
      }));
    } else if (p.kind === 'undead') {
      host.append(el('div', 'tb-prompt', `${power.cry} Take one of your own Troops back out of the discard.`));
      const row = el('div', 'tb-bin');
      for (const t of view.discard.filter((x) => x.owner === view.you)) {
        const b = rackTileEl(view, t);
        b.addEventListener('click', () => sendMove({ kind: 'undead', tile: t.id }));
        row.append(b);
      }
      host.append(row);
      host.append(actBtn('Let them rest', 'ghost', () => sendMove({ kind: 'skip' })));
    } else if (p.kind === 'sniper') {
      host.append(el('div', 'tb-prompt', `${power.cry} Point at one of their Troops — you do not get to look.`));
      const row = el('div', 'tb-bin');
      for (let i = 0; i < p.count; i++) {
        const b = el('button', 'tb-troop back', '?');
        b.type = 'button';
        b.addEventListener('click', () => sendMove({ kind: 'sniper', index: i }));
        row.append(b);
      }
      host.append(row);
      host.append(actBtn('Hold fire', 'ghost', () => sendMove({ kind: 'skip' })));
    }
    return;
  }

  if (view.turn !== view.you) {
    host.append(el('div', 'tb-prompt dim', `${seatName(view, view.turn)} is thinking…`));
    return;
  }

  const held = choice.tile && view.rack.find((t) => t.id === choice.tile);
  if (held) host.append(heldCard(held));
  host.append(el('div', 'tb-prompt', held
    ? `Pick a lit base for ${TROOPS[held.key].name}, or tap it again to put it back.`
    : 'Your move: draw two Troops, or place one from your rack.'));
  const draw = actBtn('Draw 2 Troops', 'primary', () => sendMove({ kind: 'draw' }));
  draw.disabled = !view.canDraw;
  host.append(draw);
  // a disabled button cannot explain itself on a phone, so the reason is written out
  if (!view.canDraw) {
    host.append(el('div', 'tb-prompt dim', me(view).reserveCount === 0
      ? 'Your reserve is empty — all you can do is place.'
      : `Your hand is full at ${RACK_MAX} — all you can do is place.`));
  }
}

// The Troop in your hand, with what it will do, where a phone can read it —
// there is no hovering on glass.
function heldCard(t) {
  const card = troopCard(t.key, lastView ? lastView.you : null);
  card.classList.add('tb-held');
  return card;
}

// ---------------------------------------------------------------- troop card reference

function renderTroopRef() {
  const host = $('#troop-ref');
  host.replaceChildren();
  for (const key of TROOP_ORDER) {
    const t = TROOPS[key];
    const row = el('li', 'tb-ref-row');
    const chip = el('span', 'tb-ref-chip');
    chip.append(el('span', 'tb-troop-str', t.str === null ? '★' : String(t.str)));
    chip.append(el('span', 'tb-troop-glyph', t.glyph));
    row.append(chip);
    const body = el('div', 'tb-ref-body');
    body.append(el('b', '', `${t.name}${t.str === null ? ' (joker)' : ` (${t.str})`}`));
    body.append(el('i', 'tb-ref-cry', t.cry));
    body.append(el('span', '', t.text));
    if (t.note) body.append(el('span', 'tb-ref-note', 'Note: ' + t.note));
    row.append(body);
    host.append(row);
  }
  const terr = $('#terrain-ref');
  terr.replaceChildren();
  for (const t of TERRAINS) {
    const row = el('li', 'tb-ref-row');
    const body = el('div', 'tb-ref-body');
    body.append(el('b', '', `${t.name} — objective ${t.target}`));
    body.append(el('i', 'tb-ref-cry', POWERS[t.power].cry));
    body.append(el('span', '', POWERS[t.power].text));
    row.append(body);
    terr.append(row);
  }
}

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

function renderGame(view, sess) {
  lastView = view;
  renderDcBanner(view, sess);
  renderObBar(view, sess);
  renderWatchChip(view);
  ensureResignBtn(sess);
  if (viewMid !== view.mid) {
    viewMid = view.mid;
    resetChoice();
  }
  // a Troop you were holding can stop being placeable while you held it —
  // the opponent covered the only slot, or a sniper pinned it
  if (choice.tile && !view.rack.some((t) => t.id === choice.tile)) choice.tile = null;

  $('#room-chip').textContent = view.code || '·····';
  const tc = $('#terrain-chip');
  tc.textContent = view.terrain.name;
  tc.dataset.tip = `${POWERS[view.terrain.power].cry} ${POWERS[view.terrain.power].text}`;
  tc.dataset.tipKey = 'chip:terrain';
  const gc = $('#goal-chip');
  gc.textContent = `★ ${view.terrain.target} to win`;
  gc.dataset.tip = `First to ${view.terrain.target} Medals wins — or march one Troop into the enemy H.Q. along a chain of your own.`;
  gc.dataset.tipKey = 'chip:goal';

  renderSeats(view);
  renderBoard(view);
  renderRack(view);
  renderActionBar(view);
  renderLog(view);
  paintChatBubbles();
  retip();

  if (view.fx && view.fx.seq !== lastFxSeq) {
    lastFxSeq = view.fx.seq;
    const fx = view.fx;
    if (fx.node !== undefined) {
      const n = document.querySelector(`[data-node="${fx.node}"]`);
      if (n) {
        n.classList.remove('fx-pop');
        void n.getBoundingClientRect();
        n.classList.add('fx-pop');
      }
    }
    if (fx.kind === 'medals') {
      flash(fx.seat === view.you ? `+${fx.medals} ★` : `${seatName(view, fx.seat)} takes ${fx.medals} ★`, 'plain');
    } else if (fx.kind === 'blast' && fx.seat !== view.you) {
      toast(`XB-42 blasted ${TROOPS[fx.key].name} off your rack.`);
    } else if (fx.kind === 'pin' && fx.seat !== view.you) {
      toast('A sniper has pinned one of your Troops for your next turn.');
    }
  }

  settleOverlay('#gameover', view.phase === 'over', () => showGameover(view, sess));
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

// ---------------------------------------------------------------- game over

let confettiDone = false;

function showGameover(view, sess) {
  const m = $('#gameover');
  m.classList.remove('hidden');
  const res = view.result;
  const won = res.winner === view.you;
  $('#go-title').textContent = won ? 'Victory!' : `${seatName(view, res.winner)} wins`;
  $('#go-sub').textContent = res.why;

  const list = $('#go-rank');
  list.replaceChildren();
  const rows = [...res.scores].sort((a, b) => (b.seat === res.winner ? 1 : 0) - (a.seat === res.winner ? 1 : 0));
  for (const s of rows) {
    const p = view.players.find((q) => q.seat === s.seat);
    const row = el('li', `rank-row${s.seat === view.you ? ' me' : ''}`);
    row.append(el('span', 'rank-pos', s.seat === res.winner ? '★' : '·'));
    row.append(avatarEl(p.name, p.seat, p.bot));
    row.append(el('span', 'rank-name', p.name + (p.connected || p.bot ? '' : ' (left)')));
    row.append(el('span', 'rank-score', `${s.medals} ★ · ${s.rack} on the rack · ${s.reserve} in reserve`));
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
  localStorage.setItem('tb-name', name);
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
  localStorage.setItem('tb-name', name);
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
  $('#name-input').value = localStorage.getItem('tb-name') || '';
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

  $('#btn-cheatsheet').addEventListener('click', () => {
    $('#modal-cheat').classList.remove('hidden');
    renderTroopRef();
  });
  $('#btn-cheat-close').addEventListener('click', () => $('#modal-cheat').classList.add('hidden'));
  $('#modal-cheat').addEventListener('click', (e) => {
    if (e.target === $('#modal-cheat')) $('#modal-cheat').classList.add('hidden');
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
