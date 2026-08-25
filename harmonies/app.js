// app.js — networking + UI for Harmonies.
//
// Topology: host-authoritative star over WebRTC data channels.
//   - The host's browser owns the game state and validates every move.
//   - Guests connect straight to the host (peer-to-peer); no game server.
//   - NAT traversal uses Google's public STUN servers (see RTC_CONFIG).
//   - Peer discovery/signaling uses the free PeerJS cloud broker, because
//     GitHub Pages can only serve static files.
// Bots fill empty seats (host adds them in the lobby) and tend the landscape
// of anyone who disconnects.

import {
  PROTO,
  MIN_PLAYERS,
  MAX_PLAYERS,
  HAND_LIMIT,
  BOARD_SIDES,
  sideByKey,
  CELLS,
  stackType,
  ANIMALS,
  animalByKey,
  cubeTargetsFor,
  legalCellsFor,
  cardFeasible,
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
const ID_PREFIX = 'hrm-v1-';
const BOT_NAMES = ['Fern', 'Bramble', 'Pebble', 'Wren', 'Moss', 'Reed', 'Clover', 'Sorrel'];
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
  b.className = `flash ${cls}`;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => b.classList.add('hidden'), 1700);
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
  if (bot) return el('div', 'av bot', '\u{1F994}');
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
    text: m.text.length > 84 ? `${m.text.slice(0, 84)}…` : m.text,
    timer: setTimeout(() => {
      chatBubbles.delete(m.seat);
      paintChatBubbles();
    }, 6500),
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
    this.sideKey = 'A';
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

  // Harmonies is open information — any abandoned seat may be taken.
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

  setSide(key) {
    if (this.G) return;
    this.sideKey = sideByKey(key).key;
    this.pushLobby();
  }

  // The turn player acts in several small steps (take, three placements,
  // maybe a card, cubes, end). Bots pause longer before a fresh turn, then
  // move briskly through the steps so the table stays readable.
  scheduleBots() {
    clearTimeout(this.botTimer);
    if (!this.G || this.G.phase !== 'playing') return;
    const seat = this.G.turn;
    if (!this.seatCovered(seat)) return;
    const p = this.G.players.find((q) => q.seat === seat);
    const midTurn = p && (p.tookTokens || p.tray.length);
    const delay = midTurn ? 650 + Math.random() * 550 : 2400 + Math.random() * 1400;
    this.botTimer = setTimeout(() => {
      if (!this.G || this.G.phase !== 'playing') return;
      const seat2 = this.G.turn;
      if (!this.seatCovered(seat2)) return;
      const move = botChoose(this.G, seat2);
      if (move) {
        const res = applyMove(this.G, seat2, move);
        if (!res.ok) {
          // never stall the meadow: force the turn to a legal close
          const q = this.G.players.find((x) => x.seat === seat2);
          if (!q.tookTokens) {
            const s = this.G.slots.findIndex((sl) => sl.length);
            if (s >= 0) applyMove(this.G, seat2, { kind: 'take', slot: s });
          } else if (q.tray.length) {
            const cells = legalCellsFor(q.board, q.tray[0]);
            if (cells.length) applyMove(this.G, seat2, { kind: 'place', tokenIdx: 0, cell: cells[0] });
            else applyMove(this.G, seat2, { kind: 'discard', tokenIdx: 0 });
          } else {
            applyMove(this.G, seat2, { kind: 'end' });
          }
        }
      }
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
      side: this.sideKey,
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
    this.G = newMatch(this.roster, this.sideKey);
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
    this.G = newMatch(this.roster, this.sideKey);
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
    const wnames = this.watchers.map((x) => x.name);
    for (const [seat, conn] of this.conns) {
      try {
        conn.send({ t: 'state', view: { ...viewFor(this.G, seat, this.code), watchers: wnames } });
      } catch {}
    }
    for (const w of this.watchers) this.sendWatcher(w);
    pendingMove = false;
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

const REJOIN_KEY = 'hrm-rejoin';

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
  const sp = $('#side-picker');
  sp.replaceChildren();
  for (const s of BOARD_SIDES) {
    const b = el('button', `side-pick${s.key === lob.side ? ' on' : ''}`, s.name);
    b.type = 'button';
    b.disabled = !sess.isHost;
    if (sess.isHost) b.addEventListener('click', () => sess.setSide(s.key));
    sp.append(b);
  }
  $('#side-blurb').textContent = sideByKey(lob.side).blurb;

  $('#btn-start').classList.toggle('hidden', !sess.isHost);
  $('#btn-add-bot').classList.toggle('hidden', !sess.isHost);
  if (sess.isHost) {
    $('#btn-start').disabled = lob.players.length < lob.min;
    $('#btn-add-bot').disabled = lob.players.length >= lob.max;
  }
  const n = lob.players.length;
  $('#lobby-hint').textContent = sess.isHost
    ? n < lob.min
      ? 'Share the code or link — or add a bot to fill the meadow.'
      : `${n} gardeners ready — highest landscape wins. Start whenever!`
    : 'Waiting for the host to start…';
  paintChatBubbles();
}

// ---------------------------------------------------------------- UI state

// viewSeat: whose board fills the workspace (all boards are public)
let viewSeat = null;
let viewMid = null;
// choice: traySel (index into my tray) · cubeSel (card key) · cardSel (display key)
let choice = { traySel: null, cubeSel: null, cardSel: null, resetArm: false };

function resetChoice() {
  choice = { traySel: null, cubeSel: null, cardSel: null, resetArm: false };
}

function me(view) {
  return view.players.find((p) => p.seat === view.you);
}

function viewed(view) {
  return view.players.find((p) => p.seat === viewSeat) || me(view);
}

function seatName(view, seat) {
  const p = view.players.find((q) => q.seat === seat);
  return p ? p.name : '?';
}

function stackIcon(type) {
  if (type.startsWith('tree')) return '🌳';
  if (type.startsWith('mtn')) return '⛰️';
  if (type === 'bld') return '🏠';
  if (type === 'redg') return '🧱';
  if (type === 'water') return '💧';
  if (type === 'field') return '🌾';
  if (type.startsWith('trunk')) return '🪵';
  return '';
}

// ---------------------------------------------------------------- seats

// A thumbnail of a player's landscape: the same 23-hex layout at postage
// stamp size, so everyone's progress is visible at a glance.
function miniBoardEl(p) {
  const MW = 26;
  const MH = 19;
  const box = el('div', 'miniboard');
  for (const cell of CELLS) {
    const st = p.board[cell.id];
    const top = st.stack[st.stack.length - 1];
    const h = el('span', `mbhex${top ? ` ${top}` : ' open'}${st.cube ? ' hascube' : ''}`);
    const x = cell.col * MW * 0.75;
    const y = cell.row * MH + (cell.col % 2 === 1 ? MH / 2 : 0);
    h.style.left = `${x}px`;
    h.style.top = `${y}px`;
    box.append(h);
  }
  return box;
}

function renderSeats(view) {
  const box = $('#seats');
  box.replaceChildren();
  const ordered = [...view.players].sort(
    (a, b) => ((a.seat - view.you + 16) % 16) - ((b.seat - view.you + 16) % 16),
  );
  for (const p of ordered) {
    const tile = el('button', `seat${view.phase === 'playing' && view.turn === p.seat ? ' turn' : ''}${p.seat === viewSeat ? ' viewing' : ''}${p.connected ? '' : ' offline'}`);
    tile.type = 'button';
    tile.dataset.seat = String(p.seat);
    const head = el('div', 'seat-head');
    head.append(avatarEl(p.name, p.seat, p.bot));
    head.append(el('span', 'nm', p.seat === view.you ? `${p.name} (you)` : p.name));
    head.append(el('span', 'seat-score', String(p.score.total)));
    tile.append(head);
    const sub = el('div', 'seat-sub');
    sub.append(el('span', '', `🐾 ${p.cubesPlaced}`));
    sub.append(el('span', '', `🗺 ${p.empties} free`));
    sub.append(el('span', '', `🃏 ${p.cards.length}`));
    if (view.phase === 'playing' && view.turn === p.seat) sub.append(el('span', '', '— their turn'));
    tile.append(sub);
    if (p.seat !== view.you) tile.append(miniBoardEl(p));
    // seat notes describe what OTHER players last did — never your own actions
    tile.append(el('div', 'seat-note', p.seat !== view.you && p.lastAction ? `· ${p.lastAction}` : ''));
    tile.addEventListener('click', () => {
      viewSeat = p.seat;
      choice.cubeSel = null;
      renderGame(lastView, session);
    });
    box.append(tile);
  }
}

// ---------------------------------------------------------------- market

function patternDiagram(card) {
  const box = el('div', 'a-pattern');
  const W = 24;
  const H = 27;
  const pts = card.pattern.map((p) => ({ x: p.dx * W, y: (p.dz + p.dx / 2) * H, t: p.t, cube: p === card.pattern[0] }));
  const minX = Math.min(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxX = Math.max(...pts.map((p) => p.x));
  const maxY = Math.max(...pts.map((p) => p.y));
  // the box wraps the diagram exactly, so CSS margin:auto centers it in
  // any card width
  const offX = -minX;
  const offY = -minY;
  box.style.width = `${maxX - minX + 31}px`;
  box.style.height = `${maxY - minY + 27}px`;
  for (const p of pts) {
    const kind = p.t.startsWith('tree') ? 'tree' : p.t.startsWith('mtn') ? 'mtn' : p.t;
    const h = el('div', `mini-hex ${kind}${p.cube ? ' cubespot' : ''}`);
    const height = p.t.match(/(\d)$/);
    h.textContent = height && kind !== 'bld' ? height[1] : kind === 'bld' ? '⌂' : '';
    h.style.left = `${p.x + offX}px`;
    h.style.top = `${p.y + offY}px`;
    h.title = p.t;
    box.append(h);
  }
  return box;
}

function animalCardEl(view, key, opts = {}) {
  const card = animalByKey(key);
  const c = el('div', `acard${opts.cls ? ` ${opts.cls}` : ''}`);
  c.append(el('span', `a-stripe ${card.color}`));
  c.append(el('div', 'a-name', card.name));
  c.append(patternDiagram(card));
  const ladder = el('div', 'a-ladder');
  card.cubes.forEach((v, i) => {
    const placed = opts.placed || 0;
    const r = el('span', `rung${i < placed ? ' filled' : ''}${i === placed ? ' next' : ''}`, String(v));
    ladder.append(r);
  });
  c.append(ladder);
  return c;
}

function renderMarket(view, sess) {
  const slotsBox = $('#slots');
  slotsBox.replaceChildren();
  const my = me(view);
  const canTake = view.phase === 'playing' && view.turn === view.you && my && !my.tookTokens;
  view.slots.forEach((slot, i) => {
    const s = el('button', `slot${canTake && slot.length ? ' can' : ''}`);
    s.type = 'button';
    for (const color of slot) s.append(el('span', `tok ${color}`));
    if (!slot.length) s.append(el('span', 'tray-label', '—'));
    s.disabled = !(canTake && slot.length);
    s.title = canTake ? 'Take these tokens' : '';
    s.addEventListener('click', () => sendMove({ kind: 'take', slot: i }));
    slotsBox.append(s);
  });

  const dBox = $('#display');
  dBox.replaceChildren();
  const canCard = view.phase === 'playing' && view.turn === view.you && my && !my.tookCard && my.cards.length < HAND_LIMIT;
  const supply = tokenSupply(view);
  for (const key of view.display) {
    const dead = my && !cardFeasible(my.board, key, supply);
    const c = animalCardEl(view, key, {
      cls: `${canCard ? 'can' : ''}${choice.cardSel === key ? ' sel' : ''}${dead ? ' impossible' : ''}`,
    });
    if (dead) c.title = 'Out of reach: this habitat can no longer be built on your board with the tokens left in the game.';
    if (canCard) {
      c.addEventListener('click', () => {
        choice.cardSel = choice.cardSel === key ? null : key;
        renderGame(lastView, session);
      });
    }
    dBox.append(c);
  }
}

// ---------------------------------------------------------------- board

const HEXW = 84;
const HEXH = 62;

function hexPos(cell) {
  const x = cell.col * HEXW * 0.75;
  const y = cell.row * HEXH + (cell.col % 2 === 1 ? HEXH / 2 : 0);
  return { x, y };
}

function renderBoard(view) {
  const p = viewed(view);
  const mineShown = p.seat === view.you;
  $('#board-owner').textContent = mineShown ? 'Your landscape' : `${p.name}'s landscape (read-only)`;

  const board = $('#board');
  board.replaceChildren();

  const my = me(view);
  const myTurn = view.phase === 'playing' && view.turn === view.you;
  let placeCells = new Set();
  let cubeCells = new Set();
  if (mineShown && myTurn && my) {
    if (choice.cubeSel) {
      cubeCells = new Set(cubeTargetsFor(my.board, choice.cubeSel));
    } else if (my.tray.length && choice.traySel != null && my.tray[choice.traySel] != null) {
      placeCells = new Set(legalCellsFor(my.board, my.tray[choice.traySel]));
    }
  }

  for (const cell of CELLS) {
    const st = p.board[cell.id];
    const type = stackType(st.stack);
    const top = st.stack[st.stack.length - 1];
    const h = el('button', 'hex');
    h.type = 'button';
    h.dataset.cell = String(cell.id);
    const pos = hexPos(cell);
    h.style.left = `${pos.x}px`;
    h.style.top = `${pos.y}px`;
    if (top) h.classList.add(top);
    if (placeCells.has(cell.id)) h.classList.add('can');
    if (cubeCells.has(cell.id)) h.classList.add('cubetarget');
    const icon = stackIcon(type);
    if (icon) h.append(el('span', 'h-icon', icon));
    if (st.stack.length > 1) h.append(el('span', 'h-height', `×${st.stack.length}`));
    if (st.cube) h.append(el('span', `h-cube ${st.cube.color}`));
    h.title = st.stack.length ? `${st.stack.join(' + ')}${st.cube ? ` · ${animalByKey(st.cube.key).name} settled` : ''}` : '';
    h.disabled = !(placeCells.has(cell.id) || cubeCells.has(cell.id));
    h.addEventListener('click', () => onHexClick(cell.id));
    board.append(h);
  }
}

function onHexClick(cellId) {
  const view = lastView;
  if (!view || !session) return;
  const my = me(view);
  if (!my || view.turn !== view.you) return;
  if (choice.cubeSel) {
    sendMove({ kind: 'cube', card: choice.cubeSel, cell: cellId });
    choice.cubeSel = null;
    return;
  }
  if (my.tray.length && choice.traySel != null) {
    sendMove({ kind: 'place', tokenIdx: choice.traySel, cell: cellId });
  }
}

function renderTray(view) {
  const box = $('#tray');
  box.replaceChildren();
  const my = me(view);
  const p = viewed(view);
  if (p.seat !== view.you) {
    if (p.tray.length) {
      box.append(el('span', 'tray-label', `${p.name} is holding:`));
      for (const color of p.tray) box.append(el('span', `tok ${color}`));
    }
    return;
  }
  if (!my || !my.tray.length) return;
  box.append(el('span', 'tray-label', `Place ${my.tray.length} token${my.tray.length === 1 ? '' : 's'}:`));
  my.tray.forEach((color, i) => {
    const b = el('button', `tray-tok${choice.traySel === i ? ' sel' : ''}`);
    b.type = 'button';
    b.append(el('span', `tok ${color}`));
    b.title = color;
    b.addEventListener('click', () => {
      choice.traySel = i;
      choice.cubeSel = null;
      renderGame(lastView, session);
    });
    box.append(b);
  });
}

function renderMyCards(view) {
  const box = $('#mycards');
  box.replaceChildren();
  const p = viewed(view);
  const mineShown = p.seat === view.you;
  const myTurn = view.phase === 'playing' && view.turn === view.you;
  for (const held of p.cards) {
    const card = animalByKey(held.key);
    const c = animalCardEl(view, held.key, { placed: held.placed, cls: choice.cubeSel === held.key ? 'sel' : '' });
    if (mineShown) {
      const targets = myTurn ? cubeTargetsFor(p.board, held.key) : [];
      const btn = el('button', 'a-cubebtn', choice.cubeSel === held.key ? 'Pick a glowing space…' : `Settle a cube (${targets.length})`);
      btn.type = 'button';
      btn.disabled = !myTurn || targets.length === 0;
      btn.addEventListener('click', () => {
        choice.cubeSel = choice.cubeSel === held.key ? null : held.key;
        choice.traySel = null;
        renderGame(lastView, session);
      });
      c.append(btn);
    }
    box.append(c);
  }
  for (const done of p.done) {
    const card = animalByKey(done.key);
    const c = animalCardEl(view, done.key, { placed: done.placed, cls: 'donecard' });
    c.append(el('div', 'a-cubebtn', `complete ✓ ${card.cubes[card.cubes.length - 1]} pts`));
    box.append(c);
  }
  if (!p.cards.length && !p.done.length) {
    box.append(el('span', 'abar-label', mineShown ? 'No animal cards yet — take one from the row above.' : 'No animal cards yet.'));
  }
}

// ---------------------------------------------------------------- cheatsheet
// Every animal still in the draw pile (the full set minus the display and
// everyone's visible cards — all public information), filterable by the
// terrain a habitat needs.

const CHEAT_FILTERS = [
  { t: 'water', label: 'Water', dot: 'water' },
  { t: 'field', label: 'Field', dot: 'field' },
  { t: 'tree1', label: 'Tree ×1', dot: 'tree' },
  { t: 'tree2', label: 'Tree ×2', dot: 'tree' },
  { t: 'tree3', label: 'Tree ×3', dot: 'tree' },
  { t: 'mtn1', label: 'Mountain ×1', dot: 'mtn' },
  { t: 'mtn2', label: 'Mountain ×2', dot: 'mtn' },
  { t: 'mtn3', label: 'Mountain ×3', dot: 'mtn' },
  { t: 'bld', label: 'Building', dot: 'bld' },
];

const cheatSel = new Set();

// tokens still obtainable by anyone: the pouch plus the central board
function tokenSupply(view) {
  const supply = { ...(view.pouchColors || {}) };
  for (const slot of view.slots) {
    for (const c of slot) supply[c] = (supply[c] || 0) + 1;
  }
  return supply;
}

function deckRemainder(view) {
  const gone = new Set(view.display);
  for (const p of view.players) {
    for (const c of p.cards) gone.add(c.key);
    for (const c of p.done) gone.add(c.key);
  }
  return ANIMALS.filter((a) => !gone.has(a.key)).map((a) => a.key);
}

function renderCheatsheet(view) {
  if ($('#modal-cheat').classList.contains('hidden')) return;
  const remaining = deckRemainder(view);
  const myBoard = me(view) ? me(view).board : null;
  const supply = tokenSupply(view);
  const alive = new Set(myBoard ? remaining.filter((k) => cardFeasible(myBoard, k, supply)) : remaining);
  const dead = remaining.length - alive.size;
  $('#cheat-sub').textContent =
    `${remaining.length} of ${ANIMALS.length} animals are still in the deck — the rest are on display or already claimed.` +
    (dead ? ` ${dead} of them ${dead === 1 ? 'is' : 'are'} greyed out: their habitats can no longer be built on YOUR board.` : '') +
    ' Filter by the terrain a habitat needs to plan your landscape ahead.';

  const fbox = $('#cheat-filters');
  fbox.replaceChildren();
  for (const f of CHEAT_FILTERS) {
    const b = el('button', `cfilter${cheatSel.has(f.t) ? ' on' : ''}`);
    b.type = 'button';
    b.append(el('span', `dotmini dot-${f.dot}`), el('span', '', f.label));
    b.addEventListener('click', () => {
      if (cheatSel.has(f.t)) cheatSel.delete(f.t);
      else cheatSel.add(f.t);
      renderCheatsheet(lastView);
    });
    fbox.append(b);
  }
  if (cheatSel.size) {
    const clear = el('button', 'cfilter clear', '✕ clear filters');
    clear.type = 'button';
    clear.addEventListener('click', () => {
      cheatSel.clear();
      renderCheatsheet(lastView);
    });
    fbox.append(clear);
  }

  const grid = $('#cheat-grid');
  grid.replaceChildren();
  const filtered = remaining.filter((key) => {
    if (!cheatSel.size) return true;
    const types = new Set(animalByKey(key).pattern.map((p) => p.t));
    return [...cheatSel].every((t) => types.has(t));
  });
  const sorted = filtered
    .map((k) => animalByKey(k))
    .sort(
      (a, b) =>
        (alive.has(a.key) ? 0 : 1) - (alive.has(b.key) ? 0 : 1) ||
        a.pattern.length - b.pattern.length ||
        a.name.localeCompare(b.name),
    );
  for (const card of sorted) {
    const node = animalCardEl(view, card.key, { cls: alive.has(card.key) ? '' : 'impossible' });
    if (!alive.has(card.key)) {
      node.title = 'Out of reach: this habitat can no longer be built on your board with the tokens left in the game.';
    }
    grid.append(node);
  }
  if (!sorted.length) {
    grid.append(el('div', 'cheat-empty', 'No animal left in the deck needs exactly that combination — loosen a filter.'));
  }
}

// ---------------------------------------------------------------- action bar

function pickBtn(label, opts = {}) {
  const b = el('button', `pick${opts.cls ? ` ${opts.cls}` : ''}`);
  b.type = 'button';
  b.textContent = label;
  if (opts.disabled) b.disabled = true;
  if (opts.title) b.title = opts.title;
  if (opts.click) b.addEventListener('click', opts.click);
  return b;
}

function resetButton(view) {
  const my = me(view);
  if (!my || !(my.tookTokens || my.tookCard)) return null;
  if (!choice.resetArm) {
    return pickBtn('↺ Start my turn over', {
      cls: 'warn',
      title: 'Take back everything you did this turn — tokens, card, cubes — and begin it again.',
      click: () => {
        choice.resetArm = true;
        renderGame(lastView, session);
      },
    });
  }
  const wrap = el('span', 'abar-row');
  wrap.append(
    pickBtn('Really start over?', { cls: 'warn', click: () => sendMove({ kind: 'reset' }) }),
    pickBtn('Keep playing', {
      click: () => {
        choice.resetArm = false;
        renderGame(lastView, session);
      },
    }),
  );
  return wrap;
}

function renderActionBar(view) {
  const bar = $('#action-bar');
  bar.replaceChildren();
  const row = () => {
    const r = el('div', 'abar-row');
    bar.append(r);
    return r;
  };
  const label = (t) => el('span', 'abar-label', t);

  if (view.phase === 'over') {
    row().append(label('The landscapes are complete — the tally is up.'));
    return;
  }

  const my = me(view);
  if (view.turn !== view.you) {
    row().append(label(`${seatName(view, view.turn)} is shaping their landscape…`));
    return;
  }

  if (viewSeat !== view.you) {
    const r = row();
    r.append(label(`You are looking at ${seatName(view, viewSeat)}'s landscape.`));
    r.append(pickBtn('Back to my board', { click: () => { viewSeat = view.you; renderGame(lastView, session); } }));
    return;
  }

  if (choice.cardSel) {
    const card = animalByKey(choice.cardSel);
    const r = row();
    r.append(label(`Take the ${card.name} card?`));
    r.append(pickBtn(`Take ${card.name}`, { cls: 'go', click: () => sendMove({ kind: 'card', card: choice.cardSel }) }));
    r.append(pickBtn('Cancel', { click: () => { choice.cardSel = null; renderGame(lastView, session); } }));
    return;
  }

  if (!my.tookTokens) {
    row().append(label('Your turn — take the 3 tokens from one spot on the central board. You can also grab an animal card or settle cubes first.'));
    return;
  }

  if (my.tray.length) {
    const color = choice.traySel != null ? my.tray[choice.traySel] : null;
    const stuck = color != null && legalCellsFor(my.board, color).length === 0;
    const r = row();
    if (choice.cubeSel) {
      r.append(label('Pick a glowing space to settle the cube — or reselect a token to keep placing.'));
    } else if (stuck) {
      r.append(label(`No legal space for the ${color} token.`));
      r.append(
        pickBtn(`Return the ${color} token to the box`, {
          cls: 'warn',
          click: () => sendMove({ kind: 'discard', tokenIdx: choice.traySel }),
        }),
      );
    } else {
      r.append(label(`Place your token${my.tray.length > 1 ? 's' : ''} — highlighted spaces are legal.`));
    }
    const rb = resetButton(view);
    if (rb) row().append(rb);
    return;
  }

  const r = row();
  if (choice.cubeSel) {
    r.append(label('Pick a glowing space to settle the cube.'));
    r.append(pickBtn('Cancel', { click: () => { choice.cubeSel = null; renderGame(lastView, session); } }));
    return;
  }
  r.append(label('All tokens placed. Grab a card or settle cubes — then:'));
  r.append(pickBtn('End my turn', { cls: 'go', click: () => sendMove({ kind: 'end' }) }));
  const rb = resetButton(view);
  if (rb) r.append(rb);
}

// ---------------------------------------------------------------- main render

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

function renderGame(view, sess) {
  lastView = view;
  renderDcBanner(view, sess);
  renderObBar(view, sess);
  renderWatchChip(view);
  ensureResignBtn(sess);
  if (viewMid !== view.mid) {
    viewMid = view.mid;
    viewSeat = view.you;
    resetChoice();
  }
  if (viewSeat == null) viewSeat = view.you;
  // normalize the tray selection BEFORE the board renders, so legal-space
  // highlights appear on the very first paint after taking tokens
  const myP = me(view);
  if (myP && myP.tray.length) {
    if (choice.traySel == null || choice.traySel >= myP.tray.length) choice.traySel = 0;
  } else {
    choice.traySel = null;
  }
  $('#room-chip').textContent = view.code || '·····';
  $('#pouch-chip').textContent = `${view.pouchCount} in pouch`;
  const sideMeta = sideByKey(view.side);
  const sideChip = $('#side-chip');
  sideChip.textContent = view.side === 'B' ? 'Side B · Islands' : 'Side A · River';
  sideChip.title = sideMeta.blurb;
  $('#last-chip').classList.toggle('hidden', !(view.lastRound && view.phase === 'playing'));

  renderSeats(view);
  renderMarket(view, sess);
  renderBoard(view);
  renderTray(view);
  renderMyCards(view);
  renderActionBar(view);
  renderLog(view);
  renderCheatsheet(view);
  paintChatBubbles();

  if (view.fx && view.fx.seq !== lastFxSeq) {
    lastFxSeq = view.fx.seq;
    const fx = view.fx;
    if ((fx.kind === 'place' || fx.kind === 'cube') && fx.seat === viewSeat) {
      const n = document.querySelector(`.hex[data-cell="${fx.cell}"]`);
      if (n) {
        n.classList.remove('fx-pop');
        void n.offsetWidth;
        n.classList.add('fx-pop');
      }
    } else if (fx.kind === 'lastround') {
      flash('FINAL ROUND', 'plain');
    } else if (fx.kind === 'reset' && fx.seat === view.you) {
      toast('Turn rewound — take it from the top.');
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

// ---------------------------------------------------------------- game over

let confettiDone = false;

function showGameover(view, sess) {
  const m = $('#gameover');
  m.classList.remove('hidden');
  const res = view.result;
  const winners = res.winners;
  $('#go-title').textContent =
    winners.length === 1
      ? `${seatName(view, winners[0])} grew the finest landscape!`
      : `${winners.map((s) => seatName(view, s)).join(' & ')} share the sunshine!`;

  // score table: one column per player, rows per terrain
  const table = el('table');
  const cols = [...res.scores].sort((a, b) => b.total - a.total);
  const thead = el('thead');
  const hr = el('tr');
  hr.append(el('th', '', ''));
  for (const s of cols) hr.append(el('th', '', seatName(view, s.seat)));
  thead.append(hr);
  table.append(thead);
  const tbody = el('tbody');
  const rows = [
    ['🌳 Trees', 'trees'],
    ['⛰️ Mountains', 'mountains'],
    ['🌾 Fields', 'fields'],
    ['💧 Water', 'water'],
    ['🏠 Buildings', 'buildings'],
    ['🐾 Animals', 'animals'],
  ];
  for (const [labelText, k] of rows) {
    const tr = el('tr');
    tr.append(el('td', 'rowname', labelText));
    for (const s of cols) tr.append(el('td', '', String(s[k])));
    tbody.append(tr);
  }
  const totalRow = el('tr');
  totalRow.append(el('td', 'rowname', 'Total'));
  for (const s of cols) totalRow.append(el('td', 'tot', String(s.total)));
  tbody.append(totalRow);
  table.append(tbody);
  const wrap = $('#go-table');
  wrap.replaceChildren(table);

  // standings with shared ranks
  const list = $('#go-rank');
  list.replaceChildren();
  let prevScore = null;
  let prevRank = 0;
  cols.forEach((s, i) => {
    const rank = s.total === prevScore ? prevRank : i + 1;
    prevScore = s.total;
    prevRank = rank;
    const p = view.players.find((q) => q.seat === s.seat);
    const rowEl = el('li', `rank-row${s.seat === view.you ? ' me' : ''}`);
    rowEl.append(el('span', 'rank-pos', String(rank)));
    rowEl.append(avatarEl(p.name, p.seat, p.bot));
    rowEl.append(el('span', 'rank-name', p.name + (p.connected ? '' : ' (left)')));
    rowEl.append(el('span', 'rank-score', `${s.total} · 🐾${s.cubes}`));
    list.append(rowEl);
  });

  $('#btn-again').classList.toggle('hidden', !sess.isHost);
  $('#btn-golobby').classList.toggle('hidden', !sess.isHost);
  $('#go-wait').classList.toggle('hidden', sess.isHost);
  if (winners.includes(view.you) && !confettiDone) {
    confettiDone = true;
    confetti();
  }
}

// Overlays wait ~1.8s the first time so the final placement stays visible.
const OVERLAY_DELAY = 1800;
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
    }, OVERLAY_DELAY),
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
  if (move.kind === 'card') choice.cardSel = null;
  session.localMove(move);
  if (lastView && !session.isHost) renderGame(lastView, session);
}

async function createRoom() {
  const name = cleanName($('#name-input').value) || 'Host';
  localStorage.setItem('hrm-name', name);
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
  localStorage.setItem('hrm-name', name);
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
  $('#name-input').value = localStorage.getItem('hrm-name') || '';

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
    if (lastView) renderCheatsheet(lastView);
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
