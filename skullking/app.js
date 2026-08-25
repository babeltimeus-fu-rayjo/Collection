// app.js — networking + UI for Skull King.
//
// Topology: host-authoritative star over WebRTC data channels.
//   - The host's browser owns the game state and validates every move.
//   - Guests connect straight to the host (peer-to-peer); no game server.
//   - NAT traversal uses Google's public STUN servers (see RTC_CONFIG).
//   - Peer discovery/signaling uses the free PeerJS cloud broker, because
//     GitHub Pages can only serve static files.
// Bots fill empty seats (host adds them in the lobby) and cover anyone who
// disconnects mid-game, so a voyage never stalls.

import {
  PROTO,
  MIN_PLAYERS,
  MAX_PLAYERS,
  ROUNDS,
  SCORING,
  scoringByKey,
  SUIT_META,
  KIND_META,
  cardLabel,
  newMatch,
  dealRound,
  nextRound,
  applyMove,
  viewFor,
  botChoose,
  markDisconnected,
  markReconnected,
  markBotTakeover,
  markSeatClaimed,
  markSeatResigned,
  turnSeat,
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
const ID_PREFIX = 'skk-v1-';
const BOT_NAMES = ['One-Eye', 'Bones', 'Salty', 'Gully', 'Patch', 'Marina', 'Hook', 'Squid'];
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
  if (bot) return el('div', 'av bot', '\u{1F99C}');
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
  if (m.ts) row.append(el('span', 'chat-time', fmtChatTime(m.ts)));
  row.append(el('span', `chat-name s${(m.seat || 0) % 8}`, m.name || '?'), el('span', 'chat-text', m.text));
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

function paintChatBubbles() {
  for (const n of document.querySelectorAll('.chat-bubble')) n.remove();
  for (const [seat, b] of chatBubbles) {
    const host = document.querySelector(`.seat[data-seat="${seat}"]`) || document.querySelector(`.seat-row[data-seat="${seat}"]`);
    if (!host) continue;
    host.append(el('div', 'chat-bubble', b.text));
  }
}

function showChatBubble(m) {
  if (m.seat == null) return;
  const prev = chatBubbles.get(m.seat);
  if (prev) clearTimeout(prev.timer);
  chatBubbles.set(m.seat, {
    text: m.text.length > 110 ? `${m.text.slice(0, 110)}…` : m.text,
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
    this.scoringKey = 'classic';
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
    if (msg.t === 'next') this.nextRound(seat);
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

  setScoring(key) {
    if (this.G) return;
    this.scoringKey = scoringByKey(key).key;
    this.pushLobby();
  }

  // Whose input the game waits on. Bidding is simultaneous, so any unbid bot
  // (or disconnected player) is fair game; tricks have a single turn seat.
  botActor() {
    const g = this.G;
    if (!g) return null;
    const needsCover = (p) => this.seatCovered(p.seat);
    if (g.phase === 'bid') {
      const pending = g.players.filter((p) => p.bid == null && needsCover(p));
      return pending.length ? pending[0].seat : null;
    }
    if (g.phase === 'play') {
      const seat = turnSeat(g);
      if (seat == null) return null;
      const p = g.players.find((q) => q.seat === seat);
      return p && needsCover(p) ? seat : null;
    }
    return null;
  }

  // Bots think in the host's browser; the pause keeps consecutive bot turns
  // readable. Bids come quicker since everyone bids at once.
  scheduleBots() {
    clearTimeout(this.botTimer);
    if (!this.G) return;
    const actor = this.botActor();
    if (actor == null) return;
    const delay = this.G.phase === 'bid' ? 900 + Math.random() * 900 : 2600 + Math.random() * 1600;
    this.botTimer = setTimeout(() => {
      if (!this.G) return;
      const seat = this.botActor();
      if (seat == null) return;
      const move = botChoose(this.G, seat);
      if (move) {
        const res = applyMove(this.G, seat, move);
        if (!res.ok) {
          // never stall the table: simplest legal fallback
          if (this.G.phase === 'bid') applyMove(this.G, seat, { kind: 'bid', n: 0 });
          else {
            const p = this.G.players.find((q) => q.seat === seat);
            const legal = p && p.hand[0];
            if (legal) applyMove(this.G, seat, { kind: 'play', cardId: legal.id, as: 'escape' });
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
      scoring: this.scoringKey,
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
    this.G = newMatch(this.roster, this.scoringKey);
    this.broadcast();
  }

  nextRound(seat) {
    if (seat !== 0) return; // host only
    if (!this.G || this.G.phase !== 'roundEnd') return;
    nextRound(this.G);
    hideOverlays();
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
    this.G = newMatch(this.roster, this.scoringKey);
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

  localNext() {
    this.nextRound(0);
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

const REJOIN_KEY = 'skk-rejoin';

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
  const sp = $('#scoring-picker');
  sp.replaceChildren();
  for (const s of SCORING) {
    const b = el('button', `scoring-pick${s.key === lob.scoring ? ' on' : ''}`, s.name);
    b.type = 'button';
    b.disabled = !sess.isHost;
    if (sess.isHost) b.addEventListener('click', () => sess.setScoring(s.key));
    sp.append(b);
  }
  $('#scoring-blurb').textContent = scoringByKey(lob.scoring).blurb;

  $('#btn-start').classList.toggle('hidden', !sess.isHost);
  $('#btn-add-bot').classList.toggle('hidden', !sess.isHost);
  if (sess.isHost) {
    $('#btn-start').disabled = lob.players.length < lob.min;
    $('#btn-add-bot').disabled = lob.players.length >= lob.max;
  }
  const n = lob.players.length;
  $('#lobby-hint').textContent = sess.isHost
    ? n < lob.min
      ? 'Share the code or link — or add a bot to fill the crew.'
      : `${n} aboard — ten rounds, highest score rules the seas. Set sail whenever!`
    : 'Waiting for the host to set sail…';
  paintChatBubbles();
}

// ---------------------------------------------------------------- cards

function cardEl(card, as = null, mini = false) {
  const cls = ['card'];
  if (card.kind === 'num') cls.push(card.suit);
  else cls.push(card.kind);
  if (mini) cls.push('mini');
  const c = el('div', cls.join(' '));
  if (card.kind === 'num') {
    const v = el('div', 'cv');
    v.append(valSpan(card.v));
    c.append(v);
    if (card.v === 14) {
      // the 14s carry a capture bonus (for whoever takes the trick, on an
      // exact bid): +10 in the three standard suits, +20 for black
      const b = el('div', 'cbonus', card.suit === 'black' ? '+20' : '+10');
      b.title = `Capturing this card is worth ${card.suit === 'black' ? '+20' : '+10'} bonus points (with an exact bid)`;
      c.append(b);
    }
  } else {
    c.append(el('div', 'ck', KIND_META[card.kind].icon));
    const name =
      card.kind === 'tigress' && as ? `Tigress · ${as === 'pirate' ? 'pirate' : 'escape'}` : KIND_META[card.kind].name;
    c.append(el('div', 'cn', name));
  }
  return c;
}

// ---------------------------------------------------------------- local UI state

let selBid = null;
let selCardId = null;
let lastTrick = null; // { plays, winnerCard, seat, ts } — lingers after a trick
let lingerTimer = null;

function resetChoice() {
  selBid = null;
  selCardId = null;
}

// ---------------------------------------------------------------- table

function bidChipFor(view, p) {
  if (view.phase === 'bid') {
    return p.hasBid ? el('span', 'bidchip locked', 'bid locked') : el('span', 'bidchip', 'bidding…');
  }
  if (p.bid == null) return el('span', 'bidchip', '—');
  const cls = p.tricksWon === p.bid ? 'good' : p.tricksWon > p.bid ? 'over' : '';
  return el('span', `bidchip ${cls}`, `bid ${p.bid} · won ${p.tricksWon}`);
}

function seatTile(view, p) {
  const isTurn = view.phase === 'play' && view.turn === p.seat;
  const tile = el('div', `seat${isTurn ? ' turn' : ''}${p.seat === view.you ? ' me' : ''}${p.connected ? '' : ' offline'}`);
  tile.dataset.seat = String(p.seat);
  const head = el('div', 'seat-head');
  head.append(avatarEl(p.name, p.seat, p.bot));
  head.append(el('span', 'nm', p.seat === view.you ? `${p.name} (you)` : p.name));
  head.append(el('span', 'seat-score', `${p.score}`));
  tile.append(head);
  const bidRow = el('div', 'seat-bid');
  bidRow.append(bidChipFor(view, p));
  if (view.dealer === p.seat) bidRow.append(el('span', 'bidchip', 'dealer'));
  if (isTurn) bidRow.append(el('span', 'bidchip locked', 'their turn'));
  tile.append(bidRow);
  // seat notes describe what OTHER players last did — never your own actions
  tile.append(el('div', 'seat-note', p.seat !== view.you && p.lastAction ? `· ${p.lastAction}` : ''));
  return tile;
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

// The card a player has thrown into the current trick sits in a slot on
// their table-facing side (below the top row, above the bottom row).
function playSlotEl(view, p) {
  const slot = el('div', 'pslot');
  const showLast =
    lastTrick && Date.now() - lastTrick.ts < 2200 && (!view.trick || view.trick.plays.length === 0);
  const t = showLast ? lastTrick : view.trick;
  const pl = t && t.plays ? t.plays.find((x) => x.seat === p.seat) : null;
  if (pl) {
    const wrap = el('div', `tplay${showLast && pl.card.id === lastTrick.winnerCard ? ' winner' : ''}`);
    wrap.append(cardEl(pl.card, pl.as, true));
    slot.append(wrap);
  } else {
    slot.classList.add('empty');
    if (!showLast && view.trick && view.phase === 'play' && view.trick.plays.length === 0 && view.trick.leader === p.seat) {
      slot.append(el('span', 'slot-hint', 'leads…'));
    }
  }
  return slot;
}

function renderTable(view) {
  const rows = tableRows(view);
  for (const [rowSel, list, facing] of [
    ['#row-top', rows.top, 'down'],
    ['#row-bottom', rows.bottom, 'up'],
  ]) {
    const box = $(rowSel);
    box.replaceChildren();
    for (const seat of list) {
      const p = view.players.find((q) => q.seat === seat);
      if (!p) continue;
      const cell = el('div', 'pcell');
      const tile = seatTile(view, p);
      const slot = playSlotEl(view, p);
      if (facing === 'down') cell.append(tile, slot);
      else cell.append(slot, tile);
      box.append(cell);
    }
  }
}

// ---------------------------------------------------------------- trick area

function seatName(view, seat) {
  const p = view.players.find((q) => q.seat === seat);
  return p ? p.name : '?';
}

function renderTrick(view) {
  const box = $('#trick');
  box.replaceChildren();
  const label = el('div', 'trick-label');
  // a finished trick lingers a moment so everyone sees who took it — including
  // the round's last trick, while the score overlay is still on its way
  const showLast =
    lastTrick && Date.now() - lastTrick.ts < 2200 && (!view.trick || view.trick.plays.length === 0);
  const t = showLast ? lastTrick : view.trick;

  if (view.phase === 'bid') {
    label.append(el('span', '', `Round ${view.round} — bidding`));
    box.append(label);
    return;
  }
  if (!t) {
    box.append(label);
    return;
  }
  label.append(el('span', '', showLast ? 'Trick taken!' : `Trick ${view.trickNo} of ${view.dealt}`));
  if (!showLast && view.trick) {
    if (view.trick.suit) {
      const chip = el('span', `suitchip`, `follow ${view.trick.suit}`);
      chip.style.background = `var(--s-${view.trick.suit})`;
      chip.style.color = '#fff';
      label.append(chip);
    } else if (view.trick.free) {
      label.append(el('span', 'suitchip', 'no suit — anything goes'));
    } else if (view.trick.plays.length) {
      label.append(el('span', 'suitchip', 'suit not set yet'));
    }
  }
  box.append(label);

  // the played cards themselves sit in front of each player now
  if (!showLast && view.trick && view.phase === 'play' && view.trick.plays.length === 0) {
    box.append(el('span', 'abar-label', `${seatName(view, view.trick.leader)} leads.`));
  }
}

// ---------------------------------------------------------------- hand

function renderHand(view) {
  const box = $('#hand');
  const have = new Map([...box.children].map((n) => [n.dataset.id, n]));
  const wantIds = new Set(view.hand.map((c) => String(c.id)));
  for (const [id, n] of have) {
    if (!wantIds.has(id)) {
      n.remove();
      have.delete(id);
    }
  }
  const myTurn = view.phase === 'play' && view.turn === view.you;
  const legal = new Set(view.legal || []);
  let prev = null;
  for (const c of view.hand) {
    let node = have.get(String(c.id));
    if (!node) {
      node = el('button', 'hcard');
      node.type = 'button';
      node.dataset.id = String(c.id);
      node.append(cardEl(c));
      node.addEventListener('click', () => onHandClick(c.id));
      if (prev) prev.after(node);
      else box.prepend(node);
    }
    const isLegal = myTurn && legal.has(c.id);
    node.disabled = !isLegal;
    node.classList.toggle('illegal', myTurn && !isLegal);
    node.classList.toggle('sel', selCardId === c.id);
    prev = node;
  }
}

function onHandClick(cardId) {
  if (!lastView || lastView.phase !== 'play' || lastView.turn !== lastView.you) return;
  selCardId = selCardId === cardId ? null : cardId;
  renderGame(lastView, session);
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
    row().append(label('The voyage is over — final standings are up.'));
    return;
  }
  if (view.phase === 'roundEnd') {
    row().append(label('Round scored — the tally is up.'));
    return;
  }

  if (view.phase === 'bid') {
    const me = view.players.find((p) => p.seat === view.you);
    if (me && !me.hasBid) {
      const capNote = view.dealt < view.round ? ` (the deck caps this round at ${view.dealt})` : '';
      row().append(label(`How many of the ${view.dealt} trick${view.dealt === 1 ? '' : 's'} will you take${capNote}? Look hard at your hand.`));
      const r = row();
      for (let n = 0; n <= view.dealt; n++) {
        r.append(pickBtn(valSpan(n).textContent === String(n) ? valSpan(n) : String(n), {
          on: selBid === n,
          click: () => {
            selBid = selBid === n ? null : n;
            renderGame(lastView, session);
          },
        }));
      }
      row().append(
        pickBtn('Yo-ho-ho — lock my bid!', {
          cls: 'go',
          disabled: selBid == null,
          click: () => sendMove({ kind: 'bid', n: selBid }),
        }),
      );
    } else {
      const waiting = view.players.filter((p) => !p.hasBid).map((p) => p.name);
      row().append(label(waiting.length ? `Bid locked. Waiting for ${waiting.join(', ')}…` : 'Revealing bids…'));
    }
    return;
  }

  // play phase
  const myTurn = view.turn === view.you;
  if (!myTurn) {
    row().append(label(`${seatName(view, view.turn)} is choosing a card…`));
    return;
  }
  const selCard = view.hand.find((c) => c.id === selCardId);
  if (!selCard) {
    row().append(label('Your turn — pick a card from your hand. Greyed cards must follow the led suit.'));
    return;
  }
  const r = row();
  if (selCard.kind === 'tigress') {
    r.append(label('The Tigress fights or flees — your call:'));
    r.append(
      pickBtn('Play as PIRATE ⚔', { cls: 'pirate-go', click: () => sendMove({ kind: 'play', cardId: selCard.id, as: 'pirate' }) }),
    );
    r.append(
      pickBtn('Play as ESCAPE 🏳', { cls: 'escape-go', click: () => sendMove({ kind: 'play', cardId: selCard.id, as: 'escape' }) }),
    );
  } else {
    r.append(pickBtn(`Play ${cardLabel(selCard)}`, { cls: 'go', click: () => sendMove({ kind: 'play', cardId: selCard.id }) }));
  }
  r.append(pickBtn('Cancel', { click: () => { selCardId = null; renderGame(lastView, session); } }));
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
  $('#room-chip').textContent = view.code || '·····';
  const cap = view.dealt < view.round ? ` (${view.dealt} cards)` : '';
  $('#round-chip').textContent =
    view.phase === 'over'
      ? 'Game over'
      : `Round ${view.round}/${view.rounds}${cap}${view.phase === 'play' ? ` · trick ${view.trickNo}` : ''}`;
  const sc = $('#scoring-chip');
  sc.textContent = scoringByKey(view.scoring).name;
  sc.title = scoringByKey(view.scoring).blurb;

  renderTable(view);
  renderTrick(view);
  renderHand(view);
  renderActionBar(view);
  renderLog(view);
  paintChatBubbles();

  if (view.fx && view.fx.seq !== lastFxSeq) {
    lastFxSeq = view.fx.seq;
    const fx = view.fx;
    if (fx.kind === 'trick') {
      lastTrick = { plays: fx.trick, winnerCard: fx.winnerCard, seat: fx.seat, ts: Date.now() };
      const tile = document.querySelector(`.seat[data-seat="${fx.seat}"]`);
      if (tile) {
        tile.classList.remove('won-pulse');
        void tile.offsetWidth;
        tile.classList.add('won-pulse');
      }
      clearTimeout(lingerTimer);
      lingerTimer = setTimeout(() => {
        if (lastView) {
          renderTrick(lastView);
          renderTable(lastView);
        }
      }, 2300);
      renderTrick(view);
      renderTable(view);
    } else if (fx.kind === 'bids') {
      flash('YO · HO · HO!', '');
    } else if (fx.kind === 'deal') {
      if (fx.round > 1) flash(`ROUND ${fx.round}`, 'plain');
    }
  }

  settleOverlay('#roundend', view.phase === 'roundEnd', () => showRoundEnd(view, sess));
  settleOverlay('#gameover', view.phase === 'over', () => showGameover(view, sess));
}

// ---------------------------------------------------------------- log

let logLines = [];
let logMid = null;

// Feed lines worth flashing across the table as they happen.
const ANNOUNCE_RE = / plays | takes trick /;

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
  // announce the newest play so the whole table sees what just happened
  if (!newMatch && fresh.length) {
    const a = fresh.filter((l) => ANNOUNCE_RE.test(l.text)).pop();
    if (a) flash(a.text, 'plain');
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

function showRoundEnd(view, sess) {
  const m = $('#roundend');
  m.classList.remove('hidden');
  $('#re-title').textContent = `Round ${view.roundResult.round} scored`;
  const box = $('#re-table');
  box.replaceChildren();
  const table = el('table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['Pirate', 'Bid', 'Won', 'Bid pts', 'Bonus', 'Round', 'Total']) hr.append(el('th', '', h));
  thead.append(hr);
  table.append(thead);
  const tbody = el('tbody');
  const lines = [...view.roundResult.lines].sort((a, b) => b.total - a.total);
  for (const l of lines) {
    const tr = el('tr');
    tr.append(el('td', 'nm', seatName(view, l.seat) + (l.seat === view.you ? ' (you)' : '')));
    tr.append(el('td', '', String(l.bid)));
    tr.append(el('td', '', String(l.tricks)));
    const round = l.bidPts + l.bonusPts;
    tr.append(el('td', l.bidPts >= 0 ? 'pos' : 'neg', `${l.bidPts >= 0 ? '+' : ''}${l.bidPts}`));
    tr.append(el('td', l.bonusPts > 0 ? 'pos' : '', l.bonusPts ? `+${l.bonusPts}` : '—'));
    tr.append(el('td', round >= 0 ? 'pos' : 'neg', `${round >= 0 ? '+' : ''}${round}`));
    tr.append(el('td', 'tot', String(l.total)));
    tbody.append(tr);
  }
  table.append(tbody);
  box.append(table);
  $('#btn-next-round').classList.toggle('hidden', !sess.isHost);
  $('#re-wait').classList.toggle('hidden', sess.isHost);
}

let confettiDone = false;

function showGameover(view, sess) {
  const m = $('#gameover');
  m.classList.remove('hidden');
  const standings = [...view.players].sort((a, b) => b.score - a.score);
  const best = standings[0].score;
  const winners = standings.filter((p) => p.score === best);
  $('#go-title').textContent =
    winners.length === 1 ? `${winners[0].name} rules the seas!` : `${winners.map((w) => w.name).join(' & ')} share the crown!`;
  $('#go-sub').textContent = `Ten rounds of scheming and skulking, settled at ${best} points.`;
  const list = $('#go-rank');
  list.replaceChildren();
  // equal scores share a rank (1, 2, 2, 4 …)
  let prevScore = null;
  let prevRank = 0;
  standings.forEach((p, i) => {
    const rank = p.score === prevScore ? prevRank : i + 1;
    prevScore = p.score;
    prevRank = rank;
    const row = el('li', `rank-row${p.seat === view.you ? ' me' : ''}`);
    row.append(el('span', 'rank-pos', String(rank)));
    row.append(avatarEl(p.name, p.seat, p.bot));
    row.append(el('span', 'rank-name', p.name + (p.connected ? '' : ' (left)')));
    row.append(el('span', 'rank-score', `${p.score}`));
    list.append(row);
  });
  $('#btn-again').classList.toggle('hidden', !sess.isHost);
  $('#btn-golobby').classList.toggle('hidden', !sess.isHost);
  $('#go-wait').classList.toggle('hidden', sess.isHost);
  if (winners.some((w) => w.seat === view.you) && !confettiDone) {
    confettiDone = true;
    confetti();
  }
}

// Overlays wait ~1.8s the first time so the last play stays visible.
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
    if (sel === '#gameover') confettiDone = false;
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

// A hidden tab throttles timers — reveal pending overlays when it's visible again.
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
  $('#roundend').classList.add('hidden');
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
  resetChoice();
  session.localMove(move);
  if (lastView && !session.isHost) renderGame(lastView, session);
}

async function createRoom() {
  const name = cleanName($('#name-input').value) || 'Host';
  localStorage.setItem('skk-name', name);
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
  localStorage.setItem('skk-name', name);
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
  $('#name-input').value = localStorage.getItem('skk-name') || '';

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
  $('#btn-next-round').addEventListener('click', () => session && session.localNext());
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
