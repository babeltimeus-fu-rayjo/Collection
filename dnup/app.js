// app.js — networking + UI for DNUP (official rules — see game.js header).
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
  newMatch,
  dealRound,
  applyMove,
  markDisconnected,
  markReconnected,
  markBotTakeover,
  markSeatClaimed,
  markSeatResigned,
  viewFor,
  botChoose,
  activeVal,
  inactiveVal,
  flatSets,
  playConflict,
  addConflict,
} from './game.js';

// ---------------------------------------------------------------- networking

// STUN servers let two browsers discover their public addresses so they can
// talk directly. If your players sit behind strict/symmetric NATs, add a TURN
// server entry here: { urls: 'turn:host:port', username: '…', credential: '…' }
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
const ID_PREFIX = 'dnup-v2-'; // namespaces our room ids on the public broker
const BOT_NAMES = ['Chip', 'Gizmo', 'Sparky', 'Bolt', 'Widget'];
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

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

function cleanName(s) {
  return (s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 16);
}

// Accepts a bare code or a pasted invite link containing ?room=CODE.
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
}

function toast(text, ms = 2800) {
  const t = el('div', 'toast', text);
  $('#toasts').append(t);
  setTimeout(() => t.classList.add('gone'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

let flashTimer = null;
function flash(text, cls = '', ms = 1500) {
  const b = $('#banner');
  b.textContent = text;
  b.className = 'flash hidden';
  void b.offsetWidth; // restart the pop animation
  b.className = `flash ${cls}`;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => b.classList.add('hidden'), ms);
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
  if (bot) return el('div', 'av bot', '🤖');
  return el('div', `av s${seat % 5}`, (name || '?').trim().charAt(0).toUpperCase() || '?');
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

// Briefly surface the newest message next to the chat button when the panel
// is closed, so new chat never goes unnoticed.
function peekChatMsg(m) {
  const peek = $('#chat-peek');
  peek.replaceChildren(
    el('span', `chat-name s${(m.seat || 0) % 5}`, m.name || '?'),
    el('span', 'chat-text', m.text.length > 90 ? `${m.text.slice(0, 90)}…` : m.text),
  );
  peek.classList.remove('hidden');
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => peek.classList.add('hidden'), 6000);
}

// Rendered from an absolute timestamp, so each player sees their own timezone.
function fmtChatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function addChatMsg(m, self) {
  const box = $('#chat-msgs');
  const row = el('div', `chat-msg${self ? ' mine' : ''}`);
  row.append(el('span', `chat-name s${(m.seat || 0) % 5}`, m.name || '?'));
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

// Chat also floats briefly over the sender's seat at the table, so you notice
// who said what without opening the panel. Kept in a map (not the DOM) so
// bubbles survive the re-render that every state update triggers.
const chatBubbles = new Map(); // seat -> { text, timer }

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
    const host = document.querySelector(`.opp[data-seat="${seat}"]`) || document.querySelector(`#my-zone[data-seat="${seat}"]`);
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
    say: !!m.say,
    text: m.text.length > 84 ? `${m.text.slice(0, 84)}\u2026` : m.text,
    timer: setTimeout(() => {
      chatBubbles.delete(m.seat);
      paintChatBubbles();
    }, m.say ? 4200 : 6500),
  });
  paintChatBubbles();
}

function clearChatBubbles() {
  for (const b of chatBubbles.values()) clearTimeout(b.timer);
  chatBubbles.clear();
  paintChatBubbles();
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

// ---------------------------------------------------------------- sessions

let session = null;
let pendingMove = false;
let lastView = null;
let lastFxSeq = 0;
const sel = new Set(); // selected hand card ids

class HostSession {
  constructor(peer, code, name) {
    this.isHost = true;
    this.peer = peer;
    this.code = code;
    this.seat = 0;
    this.roster = [{ seat: 0, name, connected: true }];
    this.conns = new Map(); // seat -> DataConnection
    this.G = null;
    this.botTimer = null;
    this.chatLog = [];
    this.watchers = []; // observers: {id, name, conn, target-seat}
    this.wid = 0;
    peer.on('connection', (conn) => this.accept(conn));
    peer.on('disconnected', () => {
      // Lost the broker (not the players). Reconnect so new guests can join.
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
    // 'hb' just refreshes _seen above
  }

  // All chat flows through the host, which stamps the sender and fans out.
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
    const p = this.roster.find((r) => r.seat === seat && r.bot);
    if (!p) return;
    this.roster = this.roster.filter((r) => r.seat !== seat);
    this.pushLobby();
  }

  // Bots run in the host's browser: whenever the turn lands on one, pick a
  // move after a short "thinking" pause. Chains itself via broadcast().
  scheduleBots() {
    clearTimeout(this.botTimer);
    if (!this.G || this.G.phase !== 'playing') return;
    if (!this.seatCovered(this.G.turn.seat)) return;
    this.botTimer = setTimeout(() => {
      if (!this.G || this.G.phase !== 'playing') return;
      const seat = this.G.turn.seat;
      if (!this.seatCovered(seat)) return;
      const res = applyMove(this.G, seat, botChoose(this.G, seat));
      if (!res.ok) applyMove(this.G, seat, { kind: 'rotate' }); // safety net
      this.broadcast();
    }, Math.max(4600 + Math.random() * 1600, this.talkPauseUntil ? this.talkPauseUntil - Date.now() : 0)); // deliberate pause; never talk over a running exchange
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
    if (this.roster.length < MIN_PLAYERS) {
      toast(`Need at least ${MIN_PLAYERS} players`);
      return;
    }
    this.G = newMatch(this.roster);
    this.broadcast();
  }

  nextRound() {
    if (!this.G || this.G.phase !== 'roundEnd') return;
    dealRound(this.G);
    this.broadcast();
  }

  again() {
    this.roster = this.roster.filter((p) => p.connected);
    if (this.roster.length < MIN_PLAYERS) {
      this.toLobby();
      toast('Not enough players — back to the lobby');
      return;
    }
    this.G = newMatch(this.roster);
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
    // pace the table: note how long the newest spoken exchange needs to
    // air, so bots do not start the next turn mid-conversation
    if (this.G && this.G.chatter) {
      if (this._talkMid !== this.G.mid) {
        this._talkMid = this.G.mid;
        this._talkSeen = 0;
      }
      let talkTotal = null;
      for (const c of this.G.chatter) {
        if (c.n > this._talkSeen) {
          talkTotal = (talkTotal || 0) + (c.wait || 0);
          this._talkSeen = c.n;
        }
      }
      if (talkTotal != null) this.talkPauseUntil = Math.max(this.talkPauseUntil || 0, Date.now() + talkTotal + 4400);
    }
    const wnames = this.watchers.map((x) => x.name);
    for (const [seat, conn] of this.conns) {
      try {
        conn.send({ t: 'state', view: { ...viewFor(this.G, seat, this.code), watchers: wnames } });
      } catch {}
    }
    for (const w of this.watchers) this.sendWatcher(w);
    pendingMove = false;
    sel.clear();
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
      } else {
        const c = this.conns.get(seat);
        try {
          c?.send({ t: 'err', error: res.error });
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
            full: 'That room is full (5 players max).',
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
        sel.clear();
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
        for (const m of Array.isArray(msg.items) ? msg.items : []) {
          addChatMsg(m, m.seat === this.seat);
        }
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

const REJOIN_KEY = 'dnup-rejoin';

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
  handOrder = [];
  logLines = [];
  logKey = null;
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
      row.append(avatarEl(p.name, p.seat, p.bot));
      row.append(el('span', 'seat-name', p.name));
      if (p.seat === 0) row.append(el('span', 'chip', 'host'));
      if (p.bot) row.append(el('span', 'chip bot', 'bot'));
      if (p.seat === mySeat) row.append(el('span', 'chip you', 'you'));
      if (p.bot && sess.isHost) {
        const kick = el('button', 'kick', '✕');
        kick.type = 'button';
        kick.title = `Remove ${p.name}`;
        kick.setAttribute('aria-label', `Remove ${p.name}`);
        kick.addEventListener('click', () => sess.removeBot(p.seat));
        row.append(kick);
      }
    } else {
      row.append(el('div', 'av empty', '·'), el('span', 'seat-name dim', 'Waiting for player…'));
    }
    list.append(row);
  }
  $('#btn-start').classList.toggle('hidden', !sess.isHost);
  $('#btn-add-bot').classList.toggle('hidden', !sess.isHost);
  if (sess.isHost) {
    $('#btn-start').disabled = lob.players.length < lob.min;
    $('#btn-add-bot').disabled = lob.players.length >= lob.max;
  }
  const n = lob.players.length;
  $('#lobby-hint').textContent = sess.isHost
    ? n < lob.min
      ? 'Share the code or link — or add a bot to play right away.'
      : `${n} of ${lob.max} in — ${n === 2 ? '2-player duel rules' : 'first to 4 points'}. Start whenever!`
    : 'Waiting for the host to start the game…';
}

// ---------------------------------------------------------------- game UI

// 6 and 9 get an underline so rotation talk stays unambiguous; 10 gets a
// smaller size class so both digits stay visible on overlapped cards.
function valSpan(cls, v) {
  const isSix9 = v === 6 || v === 9;
  return el('span', `${cls}${isSix9 ? ' u69' : ''}${v === 10 ? ' two' : ''}`, String(v));
}

// Two-tone card: top half = active value's color, bottom half = inactive
// value's color; both numbers upright on the left edge.
//
// The <button> is a STATIONARY hit slot — it never moves, so hovering can
// never un-hover itself. Only the inner .pc-body (the artwork) lifts.
function handCardEl(card, clickable) {
  const b = el('button', 'pcard');
  b.type = 'button';
  b.dataset.id = card.id;
  b.append(el('span', 'pc-body'));
  b.addEventListener('click', () => {
    if (b._dragged) {
      b._dragged = false;
      return;
    }
    if (b._clickable) toggleSelect(b._card);
  });
  attachDrag(b, card.id);
  patchCard(b, card, clickable);
  return b;
}

// Update a card button in place (values change on rotation; sel/inert per turn).
function patchCard(b, card, clickable) {
  b._card = card;
  b._clickable = clickable;
  const v = activeVal(card);
  const iv = inactiveVal(card);
  b.classList.toggle('sel', sel.has(card.id));
  b.classList.toggle('inert', !clickable);
  b.setAttribute('aria-label', `card ${v} (${iv} when rotated)`);
  const body = b.firstChild;
  body.style.setProperty('--ca', `var(--v${v})`);
  body.style.setProperty('--cb', `var(--v${iv})`);
  body.replaceChildren(valSpan('pc-top', v), valSpan('pc-bot', iv));
}

// Keyed hand rendering: reuse existing card buttons (patched in place) and
// only move DOM nodes whose order actually changed. A parked cursor keeps its
// hover through bot broadcasts because the hovered element is not recreated.
function renderHand(view, clickable) {
  const hand = $('#hand');
  const byId = new Map([...hand.children].map((n) => [n.dataset.id, n]));
  const desired = orderedHand(view.hand).map((c) => {
    const existing = byId.get(c.id);
    if (existing) {
      patchCard(existing, c, clickable);
      return existing;
    }
    return handCardEl(c, clickable);
  });
  for (const n of [...hand.children]) if (!desired.includes(n)) n.remove();
  // Don't reshuffle DOM under an active drag; order settles on the next render.
  if (!hand.querySelector('.pcard.dragging')) {
    let cursor = hand.firstChild;
    for (const n of desired) {
      if (n === cursor) {
        cursor = cursor.nextSibling;
        continue;
      }
      hand.insertBefore(n, cursor);
    }
  }
  layoutHand();
}

function miniCardEl(c) {
  const v = c.flip ? c.b : c.a;
  const iv = c.flip ? c.a : c.b;
  const d = el('div', 'mcard');
  d.style.setProperty('--ca', `var(--v${v})`);
  d.style.setProperty('--cb', `var(--v${iv})`);
  d.append(valSpan('mc-top', v), valSpan('mc-bot', iv));
  return d;
}

// ---- local hand arrangement (visual only — never sent to anyone) ----

let handOrder = [];

function orderedHand(cards) {
  const pos = new Map(handOrder.map((id, i) => [id, i]));
  const known = cards.filter((c) => pos.has(c.id)).sort((a, b) => pos.get(a.id) - pos.get(b.id));
  const fresh = cards.filter((c) => !pos.has(c.id));
  const ordered = known.concat(fresh);
  handOrder = ordered.map((c) => c.id);
  return ordered;
}

// Overlap cards just enough that the whole hand fits without scrolling,
// so touch-dragging a card never fights the scroll gesture.
function layoutHand() {
  const hand = $('#hand');
  const cards = [...hand.children];
  if (cards.length < 2) return;
  const cw = cards[0].getBoundingClientRect().width || 66;
  const avail = hand.clientWidth - 28;
  const need = (cards.length * cw - avail) / (cards.length - 1);
  const overlap = Math.max(18, Math.min(cw * 0.72, need));
  cards.forEach((c, i) => {
    c.style.marginLeft = i ? `${-overlap}px` : '0px';
  });
}

function attachDrag(cardEl, cardId) {
  cardEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    cardEl._dragged = false;
    const hand = $('#hand');
    const startX = e.clientX;
    let dragging = false;
    // Snapshot of slot positions taken at drag start. Landing index is always
    // computed against these frozen centers, so the preview shifting cards
    // around never moves the thresholds under the pointer.
    let slots = null;

    const snapshot = () => {
      const children = [...hand.children];
      const rects = children.map((n) => n.getBoundingClientRect());
      slots = {
        children,
        centers: rects.map((r) => r.left + r.width / 2),
        myIndex: children.indexOf(cardEl),
        step: children.length > 1 ? Math.abs(rects[1].left - rects[0].left) : rects[0].width,
      };
    };

    // Final index of the dragged card = how many other cards sit left of the pointer.
    const targetIndex = (x) => {
      let t = 0;
      slots.children.forEach((n, i) => {
        if (n !== cardEl && slots.centers[i] < x) t++;
      });
      return t;
    };

    // Slide the cards between the old and new slot to open the landing gap.
    const preview = (x) => {
      const F = targetIndex(x);
      const D = slots.myIndex;
      slots.children.forEach((n, i) => {
        if (n === cardEl) return;
        let dx = 0;
        if (F > D && i > D && i <= F) dx = -slots.step;
        else if (F < D && i >= F && i < D) dx = slots.step;
        n.style.transform = dx ? `translateX(${dx}px)` : '';
      });
    };

    const move = (ev) => {
      const dx = ev.clientX - startX;
      if (!dragging && Math.abs(dx) > 12) {
        dragging = true;
        cardEl.classList.add('dragging');
        hand.classList.add('reordering');
        snapshot();
      }
      if (dragging) {
        cardEl.style.transform = `translate(${dx}px, -14px) scale(1.04)`;
        preview(ev.clientX);
      }
    };

    const done = (ev) => {
      cardEl.removeEventListener('pointermove', move);
      cardEl.removeEventListener('pointerup', done);
      cardEl.removeEventListener('pointercancel', done);
      if (!dragging) return;
      cardEl._dragged = true;
      cardEl.classList.remove('dragging');
      hand.classList.remove('reordering');
      const idx = targetIndex(ev.clientX);
      for (const n of slots.children) n.style.transform = '';
      cardEl.style.transform = '';
      const rest = handOrder.filter((id) => id !== cardId);
      rest.splice(idx, 0, cardId);
      handOrder = rest;
      if (lastView) renderGame(lastView, session);
    };

    try {
      cardEl.setPointerCapture(e.pointerId);
    } catch {}
    cardEl.addEventListener('pointermove', move);
    cardEl.addEventListener('pointerup', done);
    cardEl.addEventListener('pointercancel', done);
  });
}

// One play area: the set in it, plus add/take affordances for opponents' sets.
function areaEl(view, p, areaIdx, sess) {
  const s = p.areas[areaIdx];
  const mine = p.seat === view.you;
  const myTurn = view.phase === 'playing' && view.turn.seat === view.you && !pendingMove;
  const wrap = el('div', `tset${s ? '' : ' empty'}`);
  wrap.dataset.owner = p.seat;
  wrap.dataset.area = areaIdx;
  if (view.mode === 'duel') {
    const active = view.phase === 'playing' && view.turn.seat === p.seat && view.turn.area === areaIdx;
    wrap.append(el('div', `tset-label${active ? ' now' : ''}`, `Area ${areaIdx + 1}`));
  }
  if (s) {
    const row = el('div', 'tset-cards');
    for (const c of s.cards) row.append(miniCardEl(c));
    const tag = el('div', 'tset-tag');
    tag.append(el('span', null, `${s.size} × `), valSpan('', s.value));
    wrap.append(row, tag);
  } else {
    const note = (p.notes || [])[areaIdx];
    wrap.append(note ? el('div', 'tset-note', note) : el('div', 'tset-none', '·'));
  }
  if (s && !mine && myTurn) {
    const acts = el('div', 'tset-acts');
    if (sel.size === 1) {
      const card = view.hand.find((c) => sel.has(c.id));
      const sets = flatSets(view.players);
      const ref = sets.find((x) => x.owner === p.seat && x.area === areaIdx);
      if (card && ref && addConflict(sets, ref, activeVal(card)).ok) {
        const add = el('button', 'sbtn add', `+ add ${activeVal(card)}`);
        add.type = 'button';
        add.addEventListener('click', () => sendMove({ kind: 'add', cardId: card.id, target: { seat: p.seat, area: areaIdx } }));
        acts.append(add);
      }
    }
    const take = el('button', 'sbtn take', '⤵ take');
    take.type = 'button';
    take.title = 'Take this set into your hand (rotated — dnup!)';
    take.addEventListener('click', () => sendMove({ kind: 'take', target: { seat: p.seat, area: areaIdx } }));
    acts.append(take);
    wrap.append(acts);
  }
  return wrap;
}

function scoreBadge(view, p) {
  if (view.mode === 'duel') {
    return el('span', 'score', '◆'.repeat(p.rounds) + '◇'.repeat(Math.max(0, view.targetRounds - p.rounds)));
  }
  return el('span', 'score', '●'.repeat(Math.min(4, p.points)) + '○'.repeat(Math.max(0, view.targetPoints - p.points)));
}

// While a human is disconnected mid-game the table stalls; tell everyone
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

// Long rectangular table: you sit on the bottom edge and the turn order
// runs CLOCKWISE on screen — from you leftward along the bottom, up the
// left side, left-to-right across the top, down the right side back to you.
function tableRows(view) {
  const seats = view.players.map((p) => p.seat).sort((a, b) => a - b);
  const myIdx = Math.max(0, seats.indexOf(view.you));
  const S = seats.map((_, k) => seats[(myIdx + k) % seats.length]);
  const bottomN = Math.max(1, Math.floor(S.length / 2));
  return { bottom: S.slice(0, bottomN).reverse(), top: S.slice(bottomN) };
}

// One opponent's box: identity strip + their play area(s). The sets face the
// table — below the head on the top edge, above it on the bottom edge.
function oppBoxEl(view, p, sess, facing) {
  const turnNow = view.phase === 'playing' && view.turn.seat === p.seat;
  const box = el('div', `opp${turnNow ? ' turn' : ''}${p.connected ? '' : ' offline'}`);
  box.dataset.seat = p.seat;
  const head = el('div', 'opp-head');
  head.append(avatarEl(p.name, p.seat, p.bot));
  const meta = el('div', 'opp-meta');
  const nameRow = el('div', 'opp-name', p.name);
  if (p.seat === view.starterSeat) nameRow.append(el('span', 'star-badge', '★'));
  meta.append(nameRow);
  const info = el('div', 'opp-info');
  info.append(scoreBadge(view, p));
  const backs = el('span', 'backs');
  for (let i = 0; i < Math.min(p.handCount, 8); i++) backs.append(el('i', 'mini-back'));
  info.append(backs, el('span', 'count', String(p.handCount)));
  meta.append(info);
  head.append(meta);
  if (p.out) head.append(el('span', 'tag win', view.firstOut === p.seat ? 'OUT +2' : 'OUT +1'));
  else if (!p.connected) head.append(el('span', 'tag off', 'OFFLINE'));
  else if (p.handCount <= 3) {
    // Close-to-out warning: louder the fewer cards they hold.
    head.append(
      el(
        'span',
        `tag ${p.handCount === 1 ? 'dnup' : 'low'}`,
        p.handCount === 1 ? '1 CARD!' : `${p.handCount} CARDS`,
      ),
    );
  }
  const areasRow = el('div', 'areas');
  p.areas.forEach((_, i) => areasRow.append(areaEl(view, p, i, sess)));
  if (facing === 'up') box.append(areasRow, head);
  else box.append(head, areasRow);
  return box;
}

// Your own corner of the table: sets above (facing the middle), label below.
function myZoneEl(view, sess) {
  const mine = view.players.find((p) => p.seat === view.you);
  const zone = el('div', '');
  zone.id = 'my-zone';
  zone.dataset.seat = view.you;
  if (!mine) return zone;
  const areasRow = el('div', 'areas');
  mine.areas.forEach((_, i) => areasRow.append(areaEl(view, mine, i, sess)));
  const label = el('div', 'zone-label');
  label.append(el('span', null, view.mode === 'duel' ? 'Your play areas' : 'Your set'));
  if (view.you === view.starterSeat) label.append(el('span', 'star-badge', '★'));
  label.append(scoreBadge(view, mine));
  if (mine.out) label.append(el('span', 'tag win', view.firstOut === view.you ? 'OUT +2' : 'OUT +1'));
  zone.append(areasRow, label);
  return zone;
}

function renderGame(view, sess) {
  lastView = view;
  renderDcBanner(view, sess);
  renderObBar(view, sess);
  renderWatchChip(view);
  ensureResignBtn(sess);
  chatSetVisible(true);
  $('#room-chip').textContent = view.code;
  $('#round-chip').textContent =
    view.mode === 'duel'
      ? `Round ${view.round} · first to ${view.targetRounds} round wins`
      : `Round ${view.round} · first to ${view.targetPoints} points`;

  const myTurn = view.phase === 'playing' && view.turn.seat === view.you;
  document.body.classList.toggle('my-turn', myTurn);

  // The table: two facing rows, you on the bottom edge, sets facing center.
  const rows = tableRows(view);
  for (const [rowSel, list, facing] of [
    ['#row-top', rows.top, 'down'],
    ['#row-bottom', rows.bottom, 'up'],
  ]) {
    const rowBox = $(rowSel);
    rowBox.replaceChildren();
    for (const seat of list) {
      if (seat === view.you) {
        rowBox.append(myZoneEl(view, sess));
        continue;
      }
      const p = view.players.find((q) => q.seat === seat);
      if (p) rowBox.append(oppBoxEl(view, p, sess, facing));
    }
  }

  const status = $('#status');
  if (view.phase === 'playing') {
    if (myTurn) {
      status.textContent =
        view.mode === 'duel'
          ? `Your turn — Play Area ${view.turn.area + 1}`
          : 'Your turn — play a set, add to / take a set, or rotate';
      status.className = 'status mine';
    } else {
      const cur = view.players.find((p) => p.seat === view.turn.seat);
      status.textContent = cur && (cur.bot || cur.botFor) ? `${cur.name} is thinking…` : `Waiting for ${cur ? cur.name : '…'}…`;
      status.className = 'status';
    }
  } else {
    status.textContent = '';
    status.className = 'status';
  }

  // (your own zone renders inside the bottom row, sets facing the middle)

  // Action bar.
  const play = $('#btn-play');
  const rotate = $('#btn-rotate');
  const hint = $('#sel-hint');
  rotate.disabled = !myTurn || pendingMove;
  if (myTurn && sel.size > 0) {
    const cards = view.hand.filter((c) => sel.has(c.id));
    const v = activeVal(cards[0]);
    const verdict = playConflict(flatSets(view.players), cards.length, v);
    play.disabled = !verdict.ok || pendingMove;
    play.textContent = `▶ Play ${cards.length} × ${v}`;
    hint.textContent = verdict.ok
      ? verdict.bounce
        ? `Beats the ${verdict.bounce.size}-card set — it bounces back rotated!`
        : ''
      : `A ${cards.length}-card set needs a higher value than what's on the table.`;
  } else {
    play.disabled = true;
    play.textContent = '▶ Play set';
    hint.textContent = myTurn ? 'Tap cards of one value to build a set.' : '';
  }

  // Hand (local arrangement + hover state preserved across re-renders).
  renderHand(view, myTurn && !pendingMove);

  renderLog(view);
  playChatter(view);
  announceTurn(view, view.phase === 'playing' && view.turn.seat === view.you);
  paintChatBubbles();

  // One-shot effects.
  if (view.fx && view.fx.seq !== lastFxSeq) {
    lastFxSeq = view.fx.seq;
    const who = view.players.find((p) => p.seat === view.fx.seat);
    // DNUP! marks one thing only: a set flying back into its owner's hand.
    if (view.fx.bouncedSeat != null) spawnDnupPop(view.fx.bouncedSeat, view.fx.bouncedArea || 0);
    if (view.fx.kind === 'play' || view.fx.kind === 'add') {
      const owner = view.fx.kind === 'add' ? view.fx.targetSeat : view.fx.seat;
      const t = document.querySelector(`.tset[data-owner="${owner}"][data-area="${view.fx.area}"]`);
      if (t) t.classList.add('pop');
    } else if (view.fx.kind === 'out') {
      flash(`${who ? who.name : ''} is out — +2!`, 'up');
    }
  }

  // Overlays.
  // Let the winning play sit on screen for a beat before the score screen
  // covers the table.
  settleOverlay('#roundend', view.phase === 'roundEnd', () => showRoundEnd(view, sess));
  settleOverlay('#gameover', view.phase === 'over', () => showGameover(view, sess));
}

// Points gained in the round that just ended, per seat.
function scoreDeltas(view) {
  const d = {};
  const rr = view.roundResult;
  if (view.mode === 'duel') {
    if (rr && rr.kind === 'duel') d[rr.winner] = 1;
  } else if (rr && rr.kind === 'standard') {
    d[rr.first] = 2;
    d[rr.second] = 1;
  } else if (view.phase === 'over' && view.firstOut != null && view.winner === view.firstOut) {
    // game ended the moment the first player out crossed the target
    d[view.firstOut] = 2;
  }
  return d;
}

function standingsList(view, listEl) {
  listEl.replaceChildren();
  const deltas = scoreDeltas(view);
  const unit = (n) => (view.mode === 'duel' ? `round${n === 1 ? '' : 's'}` : `pt${n === 1 ? '' : 's'}`);
  // Equal scores share a rank (1, 2, 2, 4 …).
  let prevScore = null;
  let prevRank = 0;
  (view.ranking || []).forEach((r, i) => {
    const row = el('li', `rank-row${r.seat === view.you ? ' me' : ''}`);
    const total = view.mode === 'duel' ? r.rounds : r.points;
    const rank = total === prevScore ? prevRank : i + 1;
    prevScore = total;
    prevRank = rank;
    const delta = deltas[r.seat] || 0;
    const score = el('span', 'rank-cards');
    if (delta > 0) {
      score.append(
        el('span', null, `${total - delta} `),
        el('span', 'delta', `+${delta}`),
        el('span', null, ` = ${total} ${unit(total)}`),
      );
    } else {
      score.textContent = `${total} ${unit(total)}`;
    }
    row.append(
      el('span', 'rank-pos', String(rank)),
      avatarEl(r.name, r.seat, r.bot),
      el('span', 'rank-name', r.name + (r.connected ? '' : ' (left)')),
      score,
    );
    listEl.append(row);
  });
}

// Merge each state's log window into one continuous history the player can
// scroll back through. Auto-scrolls only when already parked at the bottom,
// so reading older lines isn't interrupted by incoming ones.
let logLines = [];
let logKey = null;

// Game speech: the engine scripts short first-person table-talk lines;
// replay NEW ones as chat-style bubbles with conversational pauses. On
// (re)join, history is skipped rather than replayed.
let chatterSeen = 0;
let chatterMid = null;
let chatterTimers = [];

function playChatter(view) {
  const items = view.chatter || [];
  if (chatterMid !== view.mid) {
    chatterMid = view.mid;
    for (const t of chatterTimers) clearTimeout(t);
    chatterTimers = [];
    chatterSeen = items.length ? items[items.length - 1].n : 0;
    return;
  }
  let at = 0;
  for (const c of items) {
    if (c.n <= chatterSeen) continue;
    chatterSeen = c.n;
    at += c.wait || 0;
    if (at <= 0) showChatBubble({ seat: c.seat, text: c.text, say: true });
    else {
      const line = c;
      chatterTimers.push(setTimeout(() => showChatBubble({ seat: line.seat, text: line.text, say: true }), at));
    }
  }
}

// A loud nudge fired the instant the turn becomes yours (never for
// observers).
let hadTurn = false;
let turnMid = null;

function announceTurn(view, isMine) {
  if (turnMid !== view.mid) {
    turnMid = view.mid;
    hadTurn = false;
  }
  if (session && session.observer) {
    hadTurn = isMine;
    return;
  }
  if (isMine && !hadTurn) flash('YOUR TURN', '', 3500);
  hadTurn = isMine;
}

function renderLog(view) {
  // the log is keyed per round, so a new deal starts from an empty panel
  const key = `${view.mid}:${view.round}`;
  const newMatch = key !== logKey;
  if (newMatch) {
    logKey = key;
    logLines = [];
    $('#feed').replaceChildren();
  }
  const have = new Set(logLines.map((l) => l.n));
  let added = false;
  const fresh = [];
  for (const item of view.feed || []) {
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

function showRoundEnd(view, sess) {
  const m = $('#roundend');
  m.classList.remove('hidden');
  const rr = view.roundResult || {};
  const nameOf = (s) => (view.players.find((p) => p.seat === s) || {}).name || '…';
  if (rr.kind === 'duel') {
    $('#re-title').textContent = `${nameOf(rr.winner)} wins round ${view.round}!`;
    $('#re-sub').textContent = `First to ${view.targetRounds} round wins takes the game.`;
  } else if (rr.kind === 'stall') {
    $('#re-title').textContent = 'Round stalled';
    $('#re-sub').textContent = 'No progress — the cards get redealt.';
  } else {
    $('#re-title').textContent = `${nameOf(rr.first)} +2 · ${nameOf(rr.second)} +1`;
    $('#re-sub').textContent = `First to ${view.targetPoints} points wins the game.`;
  }
  standingsList(view, $('#re-rank'));
  $('#btn-next-round').classList.toggle('hidden', !sess.isHost);
  $('#re-wait').classList.toggle('hidden', sess.isHost);
}

function showGameover(view, sess) {
  const m = $('#gameover');
  m.classList.remove('hidden');
  const winner = view.players.find((p) => p.seat === view.winner);
  $('#go-title').textContent = winner ? `${winner.name} wins the game!` : 'Game over';
  $('#go-sub').textContent =
    view.mode === 'duel'
      ? `${view.targetRounds} round wins — that's the match.`
      : `First to ${view.targetPoints} points.`;
  standingsList(view, $('#go-rank'));
  $('#btn-again').classList.toggle('hidden', !sess.isHost);
  $('#btn-golobby').classList.toggle('hidden', !sess.isHost);
  $('#go-wait').classList.toggle('hidden', sess.isHost);
  if (view.winner === view.you) confetti();
}

// Overlays wait ~1.8s the first time they appear so the last play is visible;
// once shown they update instantly.
const OVERLAY_DELAY = 1800;
const overlayTimers = new Map();

function settleOverlay(sel, wanted, show) {
  const node = $(sel);
  const pending = overlayTimers.get(sel);
  if (!wanted) {
    if (pending) clearTimeout(pending);
    overlayTimers.delete(sel);
    overlayPending.delete(sel);
    node.classList.add('hidden');
    return;
  }
  overlayPending.set(sel, show);
  if (!node.classList.contains('hidden')) {
    show(); // already up: refresh in place
    return;
  }
  if (pending) return; // a reveal is already on its way
  overlayTimers.set(
    sel,
    setTimeout(() => {
      overlayTimers.delete(sel);
      overlayPending.delete(sel);
      show();
    }, OVERLAY_DELAY),
  );
}

// A hidden tab throttles timers, so reveal any pending score screen as soon as
// the player looks back at the game.
const overlayPending = new Map();

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
  $('#roundend').classList.add('hidden');
}

// A small DNUP! burst anchored on the play area whose cards just bounced.
function spawnDnupPop(seat, areaIdx) {
  const t = document.querySelector(`.tset[data-owner="${seat}"][data-area="${areaIdx}"]`);
  if (!t) return;
  const pop = el('div', 'dnup-pop', 'DNUP!');
  t.append(pop);
  setTimeout(() => pop.remove(), 1400);
}

// ---------------------------------------------------------------- actions

function toggleSelect(card) {
  if (!lastView || pendingMove) return;
  const current = lastView.hand.filter((c) => sel.has(c.id));
  if (current.length && activeVal(current[0]) !== activeVal(card)) sel.clear();
  if (sel.has(card.id)) sel.delete(card.id);
  else sel.add(card.id);
  renderGame(lastView, session);
}

function sendMove(move) {
  if (session && session.observer) {
    toast('You are watching \u2014 only the seated player can act');
    return;
  }
  if (pendingMove || !session) return;
  pendingMove = true;
  sel.clear();
  session.localMove(move);
  if (lastView && !session.isHost) renderGame(lastView, session); // lock UI until state/err
}

async function createRoom() {
  const name = cleanName($('#name-input').value) || 'Host';
  localStorage.setItem('dnup-name', name);
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
      if (e && e.type === 'unavailable-id') continue; // rare collision, retry
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
  localStorage.setItem('dnup-name', name);
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
  location.href = location.pathname; // clean reset, drops ?room=
}

// ---------------------------------------------------------------- boot

function init() {
  $('#name-input').value = localStorage.getItem('dnup-name') || '';

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
  $('#btn-next-round').addEventListener('click', () => session && session.isHost && session.nextRound());
  $('#btn-play').addEventListener('click', () => {
    if (!lastView || !sel.size) return;
    sendMove({ kind: 'play', cardIds: [...sel] });
  });
  $('#btn-rotate').addEventListener('click', () => sendMove({ kind: 'rotate' }));

  for (const b of document.querySelectorAll('.btn-leave')) b.addEventListener('click', leave);
  for (const b of document.querySelectorAll('.btn-rules')) {
    b.addEventListener('click', () => $('#modal-rules').classList.remove('hidden'));
  }
  $('#btn-rules-close').addEventListener('click', () => $('#modal-rules').classList.add('hidden'));
  $('#modal-rules').addEventListener('click', (e) => {
    if (e.target === $('#modal-rules')) $('#modal-rules').classList.add('hidden');
  });

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

  window.addEventListener('resize', () => {
    if (!$('#screen-game').classList.contains('hidden')) layoutHand();
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
