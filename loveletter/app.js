// app.js — networking + UI for Love Letter (Premium).
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
  CARDS,
  cardName,
  cardValue,
  deckCounts,
  targetOptions,
  mustPlayCountess,
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
const ID_PREFIX = 'llp-v1-';
const BOT_NAMES = ['Chip', 'Gizmo', 'Sparky', 'Bolt', 'Widget', 'Pixel', 'Rusty', 'Nova'];
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

function cleanName(s) {
  return (s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 16);
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
function flash(text, cls = '', ms = 1600) {
  const b = $('#banner');
  b.textContent = text;
  b.className = 'flash hidden';
  void b.offsetWidth;
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

// Chat also floats briefly over the sender's seat. Kept in a map (not the DOM)
// so bubbles survive the re-render that every state update triggers.
const chatBubbles = new Map();

function paintChatBubbles() {
  for (const n of document.querySelectorAll('.chat-bubble')) n.remove();
  for (const [seat, b] of chatBubbles) {
    const host = document.querySelector(`.seat[data-seat="${seat}"]`);
    if (!host) continue;
    const bub = el('div', 'chat-bubble' + (b.say ? ' say' : ''), b.text);
    if (host.closest('#row-top')) bub.classList.add('below');
    host.append(bub);
  }
}

function showChatBubble(m) {
  if (m.seat == null) return;
  const prev = chatBubbles.get(m.seat);
  if (prev) clearTimeout(prev.timer);
  chatBubbles.set(m.seat, {
    say: !!m.say,
    text: m.text.length > 110 ? `${m.text.slice(0, 110)}…` : m.text,
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
      toast('The table is full');
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

  // Bots think in the host's browser; the pause keeps consecutive bot turns
  // readable. Also covers a bot facing the Bishop's redraw choice.
  scheduleBots() {
    clearTimeout(this.botTimer);
    if (!this.G || this.G.phase !== 'playing') return;
    const actor = this.G.pending ? this.G.pending.seat : this.G.turn;
    if (!this.seatCovered(actor)) return;
    this.botTimer = setTimeout(() => {
      if (!this.G || this.G.phase !== 'playing') return;
      const g = this.G;
      const seat = g.pending ? g.pending.seat : g.turn;
      if (!this.seatCovered(seat)) return;
      const res = applyMove(g, seat, botChoose(g, seat));
      if (!res.ok) {
        // never stall the table: fall back to the plainest legal action
        const me = g.players.find((q) => q.seat === seat);
        if (g.pending && g.pending.seat === seat) applyMove(g, seat, { kind: 'bishopChoice', discard: false });
        else if (me && me.hand[0]) applyMove(g, seat, { kind: 'play', cardId: me.hand[0].id });
      }
      this.broadcast();
    }, Math.max(4600 + Math.random() * 1600, this.talkPauseUntil ? this.talkPauseUntil - Date.now() : 0));
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
            full: 'That table is full (8 players max).',
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

const REJOIN_KEY = 'll-rejoin';

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
  $('#btn-start').classList.toggle('hidden', !sess.isHost);
  $('#btn-add-bot').classList.toggle('hidden', !sess.isHost);
  if (sess.isHost) {
    $('#btn-start').disabled = lob.players.length < lob.min;
    $('#btn-add-bot').disabled = lob.players.length >= lob.max;
  }
  const n = lob.players.length;
  const target = { 2: 6, 3: 5, 4: 4 }[n] || 3;
  $('#lobby-hint').textContent = sess.isHost
    ? n < lob.min
      ? 'Share the code or link — or add a bot to play right away.'
      : `${n} at the table — first to ${target} tokens wins. Start whenever!`
    : 'Waiting for the host to start the game…';
}

// ---------------------------------------------------------------- game UI

// Local selection state for the play -> target -> guess flow.
let choice = { cardId: null, targets: [], peek: null, guess: null };

function resetChoice() {
  choice = { cardId: null, targets: [], peek: null, guess: null };
}

function cardEl(key, size = '', copies = null) {
  const c = el('div', `card k-${key} v${cardValue(key)}${size ? ` ${size}` : ''}`);
  c.append(el('span', 'card-val', String(cardValue(key))), el('span', 'card-name', cardName(key)));
  if (copies != null) {
    const badge = el('span', 'card-count', `\u00d7${copies}`);
    badge.title = `${copies} ${cardName(key)}${copies === 1 ? '' : 's'} in this deck`;
    c.append(badge);
  }
  if (size === 'big') c.append(el('span', 'card-text', CARDS[key].text));
  return c;
}

function targetName(view, seat) {
  const p = view.players.find((q) => q.seat === seat);
  return p ? p.name : '?';
}

function seatTile(view, p, facing = 'down') {
  const isTurn = view.phase === 'playing' && view.turn === p.seat && !view.pending;
  const isPending = view.pending && view.pending.seat === p.seat;
  const cls = [
    'seat',
    isTurn || isPending ? 'turn' : '',
    p.out ? 'out' : '',
    p.connected ? '' : 'offline',
    p.seat === view.you ? 'me' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const tile = el('div', cls);
  tile.dataset.seat = p.seat;

  const head = el('div', 'seat-head');
  head.append(avatarEl(p.name, p.seat, p.bot));
  const meta = el('div', 'seat-meta');
  const nameRow = el('div', 'seat-name-row');
  nameRow.append(el('span', 'nm', p.name));
  if (p.seat === view.you) nameRow.append(el('span', 'chip you', 'you'));
  if (p.immune && !p.out) nameRow.append(el('span', 'shield', '\u{1F6E1}'));
  meta.append(nameRow);
  const hearts = el('div', 'hearts');
  for (let i = 0; i < view.tokensToWin; i++) hearts.append(el('span', `heart${i < p.tokens ? ' on' : ''}`, '♥'));
  meta.append(hearts);
  head.append(meta);
  if (p.out) head.append(el('span', 'tag out', 'OUT'));
  else if (!p.connected) head.append(el('span', 'tag off', 'LEFT'));
  else if (view.sycophant === p.seat) head.append(el('span', 'tag syc', 'TARGET'));
  tile.append(head);

  // What this player did on their last turn. Your own tile stays quiet: you
  // already know what you did, and the log has the detail.
  if (p.lastAction && p.seat !== view.you) tile.append(el('div', 'seat-note', p.lastAction));

  // Played cards face the table: below the tile on the top edge, ABOVE it
  // on the bottom edge — as if laid in front of the player.
  const pile = el('div', 'pile');
  if (p.discard.length) {
    for (const key of p.discard.slice(-6)) pile.append(cardEl(key, 'mini'));
  } else {
    pile.append(el('div', 'pile-empty', 'nothing played yet'));
  }
  if (facing === 'up') tile.prepend(pile);
  else tile.append(pile);
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

// The action bar walks you through whatever the chosen card still needs.
function renderActionBar(view, myTurn) {
  const bar = $('#action-bar');
  bar.replaceChildren();

  if (view.pending && view.pending.seat === view.you) {
    bar.append(el('span', 'ask', 'The Bishop calls you out — discard your card and draw a new one?'));
    const yes = el('button', 'btn primary slim', 'Discard & draw');
    yes.type = 'button';
    yes.addEventListener('click', () => sendMove({ kind: 'bishopChoice', discard: true }));
    const no = el('button', 'btn secondary slim', 'Keep it');
    no.type = 'button';
    no.addEventListener('click', () => sendMove({ kind: 'bishopChoice', discard: false }));
    bar.append(yes, no);
    return;
  }
  if (!myTurn) return;

  if (!choice.cardId) {
    bar.append(el('span', 'ask', 'Play one of your two cards.'));
    return;
  }
  const card = view.hand.find((c) => c.id === choice.cardId);
  if (!card) return;
  const spec = CARDS[card.key];
  const options = targetOptions(view.players, view.you, card.key);
  const forced = view.sycophant != null && options.includes(view.sycophant) ? view.sycophant : null;

  bar.append(el('span', 'playing', `${cardName(card.key)}:`));

  const wantTwo = spec.targets === 'two';
  const needTargets = wantTwo ? options.length >= 2 : Boolean(spec.targets) && spec.targets !== 0 && options.length > 0;

  if (!needTargets) {
    if (spec.targets && spec.targets !== 0) {
      bar.append(el('span', 'ask', 'nobody can be targeted, so it will have no effect.'));
    }
    bar.append(confirmBtn(view, card, spec), cancelBtn());
    return;
  }

  if (forced != null) {
    bar.append(el('span', 'ask', `the Sycophant forces you to aim at ${targetName(view, forced)}.`));
  }

  const maxT = wantTwo || spec.targets === 'oneOrTwo' ? 2 : 1;
  bar.append(el('span', 'ask', wantTwo ? 'choose two players:' : maxT === 2 ? 'choose one or two:' : 'choose a player:'));

  const row = el('div', 'pickrow');
  for (const s of options) {
    const on = choice.targets.includes(s);
    const b = el('button', `pick${on ? ' on' : ''}`, targetName(view, s) + (s === view.you ? ' (you)' : ''));
    b.type = 'button';
    if (forced != null && s !== forced && maxT === 1) b.disabled = true;
    b.addEventListener('click', () => {
      if (on) choice.targets = choice.targets.filter((x) => x !== s);
      else if (maxT === 1) choice.targets = [s];
      else if (choice.targets.length < 2) choice.targets.push(s);
      else choice.targets = [choice.targets[1], s];
      choice.peek = null;
      renderGame(lastView, session);
    });
    row.append(b);
  }
  bar.append(row);

  const enough = wantTwo ? choice.targets.length === 2 : choice.targets.length >= 1;

  if (enough && wantTwo) {
    bar.append(el('span', 'ask', 'then look at:'));
    const prow = el('div', 'pickrow');
    for (const s of choice.targets) {
      const b = el('button', `pick${choice.peek === s ? ' on' : ''}`, targetName(view, s));
      b.type = 'button';
      b.addEventListener('click', () => {
        choice.peek = s;
        renderGame(lastView, session);
      });
      prow.append(b);
    }
    bar.append(prow);
  }

  if (enough && spec.guess === 'card') {
    bar.append(el('span', 'ask', 'guess their card:'));
    const grow = el('div', 'pickrow wrap');
    const counts = deckCounts(view.players.length);
    const seen = seenCounts(view);
    const keys = Object.keys(counts)
      .filter((k) => k !== 'guard')
      .sort((a, b) => cardValue(a) - cardValue(b));
    // a card whose every copy is already face up cannot be in anyone's hand
    const spentKeys = new Set(keys.filter((k) => (seen[k] || 0) >= counts[k]));
    const allSpent = spentKeys.size === keys.length; // never leave nothing to pick
    for (const k of keys) {
      const spent = !allSpent && spentKeys.has(k);
      const b = el('button', `pick${choice.guess === k ? ' on' : ''}${spent ? ' spent' : ''}`, `${cardValue(k)} ${cardName(k)}`);
      b.type = 'button';
      if (spent) {
        b.disabled = true;
        b.title = `all ${counts[k]} already face up`;
      } else {
        b.addEventListener('click', () => {
          choice.guess = k;
          renderGame(lastView, session);
        });
      }
      grow.append(b);
    }
    bar.append(grow);
  }

  if (enough && spec.guess === 'value') {
    bar.append(el('span', 'ask', 'guess their number:'));
    const vrow = el('div', 'pickrow');
    const counts = deckCounts(view.players.length);
    const seen = seenCounts(view);
    const keys = Object.keys(counts);
    const values = [...new Set(keys.map(cardValue))].sort((a, b) => a - b);
    const totalOf = (v) => keys.filter((k) => cardValue(k) === v).reduce((n, k) => n + counts[k], 0);
    const seenOf = (v) => keys.filter((k) => cardValue(k) === v).reduce((n, k) => n + (seen[k] || 0), 0);
    const spentValues = new Set(values.filter((v) => seenOf(v) >= totalOf(v)));
    const allSpent = spentValues.size === values.length;
    for (const v of values) {
      const spent = !allSpent && spentValues.has(v);
      const b = el('button', `pick${choice.guess === v ? ' on' : ''}${spent ? ' spent' : ''}`, String(v));
      b.type = 'button';
      if (spent) {
        b.disabled = true;
        b.title = `every ${v} is already face up`;
      } else {
        b.addEventListener('click', () => {
          choice.guess = v;
          renderGame(lastView, session);
        });
      }
      vrow.append(b);
    }
    bar.append(vrow);
  }

  bar.append(confirmBtn(view, card, spec), cancelBtn());
}

function confirmBtn(view, card, spec) {
  const b = el('button', 'btn primary slim', `Play ${cardName(card.key)}`);
  b.type = 'button';
  const options = targetOptions(view.players, view.you, card.key);
  const wantTwo = spec.targets === 'two';
  const targetsNeeded = wantTwo ? options.length >= 2 : Boolean(spec.targets) && spec.targets !== 0 && options.length > 0;
  const targetsOk = !targetsNeeded || (wantTwo ? choice.targets.length === 2 : choice.targets.length >= 1);
  const guessOk = !spec.guess || !targetsNeeded || choice.guess != null;
  const peekOk = !wantTwo || !targetsNeeded || choice.peek != null;
  b.disabled = pendingMove || !targetsOk || !guessOk || !peekOk;
  b.addEventListener('click', () => {
    const move = { kind: 'play', cardId: card.id };
    if (spec.targets === 'oneOrTwo' || wantTwo) {
      if (choice.targets.length) move.targets = choice.targets.slice();
      if (wantTwo && choice.peek != null) move.peek = choice.peek;
    } else if (choice.targets.length) {
      move.target = choice.targets[0];
    }
    if (spec.guess && choice.targets.length) move.guess = choice.guess;
    sendMove(move);
  });
  return b;
}

function cancelBtn() {
  const b = el('button', 'btn ghost slim', 'Cancel');
  b.type = 'button';
  b.addEventListener('click', () => {
    resetChoice();
    renderGame(lastView, session);
  });
  return b;
}

// A hand card is built once per card id and then patched in place, so the card
// under the cursor is never torn down by an incoming state update.
function handCardNode(card, copies) {
  const b = el('button', 'hand-card');
  b.type = 'button';
  b.dataset.id = card.id;
  b.append(cardEl(card.key, 'big', copies));
  b.addEventListener('click', () => {
    if (!b._playable || !b._card || !lastView) return;
    const view = lastView;
    const key = b._card.key;
    choice = { cardId: b._card.id, targets: [], peek: null, guess: null };
    const opts = targetOptions(view.players, view.you, key);
    const forced = view.sycophant != null && opts.includes(view.sycophant) ? view.sycophant : null;
    if (forced != null && CARDS[key].targets && CARDS[key].targets !== 'two') choice.targets = [forced];
    renderGame(view, session);
  });
  return b;
}

function renderHand(view, myTurn) {
  const hand = $('#hand');
  const me = view.players.find((p) => p.seat === view.you);
  const blocked = me && !me.out && mustPlayCountess(view.hand);
  const byId = new Map([...hand.querySelectorAll('.hand-card')].map((n) => [n.dataset.id, n]));
  const counts = deckCounts(view.players.length);
  const desired = view.hand.map((c) => {
    const node = byId.get(c.id) || handCardNode(c, counts[c.key] || 0);
    node._card = c;
    node._playable = myTurn && !pendingMove && (!blocked || c.key === 'countess');
    node.disabled = !node._playable;
    node.classList.toggle('sel', choice.cardId === c.id);
    return node;
  });
  for (const n of [...hand.children]) if (!desired.includes(n)) n.remove();
  let cursor = hand.firstChild;
  for (const n of desired) {
    if (n === cursor) {
      cursor = cursor.nextSibling;
      continue;
    }
    hand.insertBefore(n, cursor);
  }
  if (me && me.out) {
    hand.append(el('div', 'hand-note', 'You are out of this round — sit tight for the next deal.'));
  } else if (blocked && myTurn) {
    hand.append(el('div', 'hand-note', 'You must play the Countess while you hold the King or Prince.'));
  }
}

// Card reference, including how many copies the current deck holds. Cards that
// only appear at larger tables are marked as unused.
let refFor = null;

function renderCardRef(playerCount) {
  if (refFor === playerCount) return;
  refFor = playerCount;
  const counts = deckCounts(playerCount);
  const ref = $('#card-ref');
  ref.replaceChildren();
  for (const [key, spec] of Object.entries(CARDS).sort((a, b) => a[1].value - b[1].value)) {
    const copies = counts[key] || 0;
    const row = el('li', `ref-row${copies ? '' : ' absent'}`);
    row.append(
      cardEl(key, 'mini'),
      el('span', 'ref-name', spec.name),
      el('span', 'ref-count', copies ? `\u00d7${copies}` : 'not in this deck'),
      el('span', 'ref-text', spec.text),
    );
    ref.append(row);
  }
}

// Copies of each card that are already face up for everyone to see: the
// discard piles plus the cards removed at setup.
function seenCounts(view) {
  const seen = {};
  const bump = (key) => {
    seen[key] = (seen[key] || 0) + 1;
  };
  for (const p of view.players) for (const key of p.discard) bump(key);
  for (const key of view.faceUp) bump(key);
  return seen;
}

// Card tracker: one chip per card type in the deck, with a filled pip for
// every copy already face up and a hollow pip for every copy still
// unaccounted for.
function renderTracker(view) {
  const counts = deckCounts(view.players.length);
  const seen = seenCounts(view);

  const box = $('#tracker');
  box.replaceChildren(el('span', 'trk-label', 'played'));
  for (const key of Object.keys(counts).sort((x, y) => cardValue(x) - cardValue(y) || cardName(x).localeCompare(cardName(y)))) {
    const total = counts[key];
    const played = Math.min(seen[key] || 0, total);
    const chip = el('div', `trk${played === total ? ' spent' : ''}`);
    chip.title = `${cardName(key)} — ${played} of ${total} accounted for`;
    chip.append(el('span', `trk-val k-${key}`, String(cardValue(key))));
    const pips = el('span', 'trk-pips');
    for (let i = 0; i < total; i++) pips.append(el('i', i < played ? 'pip on' : 'pip'));
    chip.append(pips);
    box.append(chip);
  }
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

function renderGame(view, sess) {
  lastView = view;
  renderDcBanner(view, sess);
  renderObBar(view, sess);
  renderWatchChip(view);
  ensureResignBtn(sess);
  chatSetVisible(true);
  $('#room-chip').textContent = view.code;
  $('#round-chip').textContent = `Round ${view.round} · first to ${view.tokensToWin} ♥`;

  renderCardRef(view.players.length);
  const myTurn = view.phase === 'playing' && view.turn === view.you && !view.pending;
  const me = view.players.find((p) => p.seat === view.you);
  document.body.classList.toggle('my-turn', myTurn);

  // the table: two facing rows, you on the bottom edge
  const rows = tableRows(view);
  for (const [rowSel, list, facing] of [
    ['#row-top', rows.top, 'down'],
    ['#row-bottom', rows.bottom, 'up'],
  ]) {
    const box = $(rowSel);
    box.replaceChildren();
    for (const seat of list) {
      const p = view.players.find((q) => q.seat === seat);
      if (p) box.append(seatTile(view, p, facing));
    }
  }

  // centre: deck, set-aside card, and the face-up cards of a two-player game
  $('#deck-count').textContent = String(view.deckCount);
  const fu = $('#faceup');
  fu.replaceChildren();
  if (view.faceUp.length) {
    fu.append(el('span', 'faceup-label', 'out of play'));
    for (const key of view.faceUp) fu.append(cardEl(key, 'mini'));
  }

  const status = $('#status');
  if (view.phase !== 'playing') {
    status.textContent = '';
    status.className = 'status';
  } else if (view.pending) {
    const who = view.players.find((p) => p.seat === view.pending.seat);
    status.textContent =
      view.pending.seat === view.you
        ? 'The Bishop is waiting on your answer…'
        : `Waiting for ${who ? who.name : '…'} to answer the Bishop…`;
    status.className = 'status mine';
  } else if (myTurn) {
    status.textContent = 'Your turn';
    status.className = 'status mine';
  } else {
    const cur = view.players.find((p) => p.seat === view.turn);
    status.textContent = cur && (cur.bot || cur.botFor) ? `${cur.name} is thinking…` : `Waiting for ${cur ? cur.name : '…'}…`;
    status.className = 'status';
  }

  renderTracker(view);

  // what you have learned this round
  const info = $('#intel');
  info.replaceChildren();
  for (const r of view.reveals || []) {
    const chip = el('div', 'intel-chip');
    chip.append(
      el('span', 'who', r.name),
      el('span', 'sep', 'holds'),
      el('span', 'what', r.key ? cardName(r.key) : 'nothing'),
    );
    info.append(chip);
  }
  for (const b of view.jesterBets || []) {
    info.append(el('div', 'intel-chip bet', `Jester: backing ${targetName(view, b.target)}`));
  }

  renderHand(view, myTurn);

  renderActionBar(view, myTurn);
  renderLog(view);
  playChatter(view);
  announceTurn(view, view.phase === 'playing' && ((view.pending && view.pending.seat === view.you) || (!view.pending && view.turn === view.you)));
  paintChatBubbles();

  if (view.fx && view.fx.seq !== lastFxSeq) {
    lastFxSeq = view.fx.seq;
    const who = view.players.find((p) => p.seat === view.fx.seat);
    if (view.fx.kind === 'out') {
      const tile = document.querySelector(`.seat[data-seat="${view.fx.seat}"]`);
      if (tile) {
        const pop = el('div', 'out-pop', 'OUT!');
        tile.append(pop);
        setTimeout(() => pop.remove(), 1400);
      }
    } else if (view.fx.kind === 'token' && who) {
      flash(`${who.name} earns a token ♥`, 'gold');
    }
  }

  // Let the final play land before the score screen covers the table.
  settleOverlay('#roundend', view.phase === 'roundEnd', () => showRoundEnd(view, sess));
  settleOverlay('#gameover', view.phase === 'over', () => showGameover(view, sess));
}

// ---------------------------------------------------------------- log

let logLines = [];
let logMid = null;

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
  let spoke = false;
  for (const c of items) {
    if (c.n <= chatterSeen) continue;
    chatterSeen = c.n;
    at += c.wait || 0;
    if (at <= 0) showChatBubble({ seat: c.seat, text: c.text, say: true });
    else {
      const line = c;
      chatterTimers.push(setTimeout(() => showChatBubble({ seat: line.seat, text: line.text, say: true }), at));
    }
    spoke = true;
  }
  // hold the YOUR TURN nudge until the exchange has fully aired
  if (spoke) announceBusyUntil = Math.max(announceBusyUntil, Date.now() + at + 4400);
}

// A loud nudge the moment the table starts waiting on YOU. Waits out a
// just-fired play announcement, and never fires for observers.
let hadTurn = false;
let turnMid = null;
let announceBusyUntil = 0;

function announceTurn(view, isMine) {
  if (turnMid !== view.mid) {
    turnMid = view.mid;
    hadTurn = false;
  }
  if (session && session.observer) {
    hadTurn = isMine;
    return;
  }
  if (isMine && !hadTurn) {
    const wait = Math.max(0, announceBusyUntil - Date.now());
    const fire = () => {
      if (hadTurn) flash('YOUR TURN', '', 3600);
    };
    if (wait > 0) setTimeout(fire, wait);
    else fire();
  }
  hadTurn = isMine;
}

function renderLog(view) {
  // keyed per round, so a new deal starts from an empty panel
  const key = `${view.mid}:${view.round}`;
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

function standingsList(view, listEl, deltas) {
  listEl.replaceChildren();
  // Equal token counts share a rank (1, 2, 2, 4 …).
  let prevScore = null;
  let prevRank = 0;
  (view.standings || []).forEach((r, i) => {
    const row = el('li', `rank-row${r.seat === view.you ? ' me' : ''}`);
    const rank = r.tokens === prevScore ? prevRank : i + 1;
    prevScore = r.tokens;
    prevRank = rank;
    const gained = deltas[r.seat] || 0;
    const score = el('span', 'rank-score');
    if (gained > 0) {
      score.append(
        el('span', null, `${r.tokens - gained} `),
        el('span', 'delta', `+${gained}`),
        el('span', null, ` = ${r.tokens} ♥`),
      );
    } else {
      score.textContent = `${r.tokens} ♥`;
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

// Tokens gained in the round that just ended.
function roundDeltas(view) {
  const d = {};
  const rr = view.roundResult;
  if (!rr) return d;
  for (const s of rr.winners || []) d[s] = (d[s] || 0) + 1;
  return d;
}

function revealRow(view, h) {
  const p = view.players.find((q) => q.seat === h.seat);
  const won = (view.roundResult.winners || []).includes(h.seat);
  const row = el('li', `reveal-row${won ? ' won' : ''}`);
  row.append(avatarEl(p ? p.name : '?', h.seat, p && p.bot), el('span', 'reveal-name', p ? p.name : '?'));
  if (h.key) {
    row.append(cardEl(h.key, 'mini'));
    if (h.score != null && h.score !== cardValue(h.key)) row.append(el('span', 'reveal-score', `= ${h.score}`));
  } else {
    row.append(el('span', 'reveal-out', 'knocked out'));
  }
  return row;
}

function showRoundEnd(view, sess) {
  const m = $('#roundend');
  m.classList.remove('hidden');
  const rr = view.roundResult || {};
  const names = (rr.winners || []).map((s) => targetName(view, s));
  $('#re-title').textContent = names.length
    ? names.length === 1
      ? `${names[0]} wins the round`
      : `${names.join(' & ')} tie the round`
    : 'Round over';
  $('#re-sub').textContent =
    rr.reason === 'last' ? 'Everyone else was knocked out.' : 'The deck ran out — highest card takes it.';
  const rl = $('#re-reveal');
  rl.replaceChildren();
  for (const h of rr.hands || []) rl.append(revealRow(view, h));
  standingsList(view, $('#re-rank'), roundDeltas(view));
  $('#btn-next-round').classList.toggle('hidden', !sess.isHost);
  $('#re-wait').classList.toggle('hidden', sess.isHost);
}

function showGameover(view, sess) {
  const m = $('#gameover');
  m.classList.remove('hidden');
  const w = view.players.find((p) => p.seat === view.winner);
  $('#go-title').textContent = w ? `${w.name} wins the game!` : 'Game over';
  $('#go-sub').textContent = `First to ${view.tokensToWin} tokens of affection.`;
  standingsList(view, $('#go-rank'), roundDeltas(view));
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
  localStorage.setItem('ll-name', name);
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
  localStorage.setItem('ll-name', name);
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
  $('#name-input').value = localStorage.getItem('ll-name') || '';

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

  renderCardRef(MAX_PLAYERS); // full box until a table size is known

  window.addEventListener('beforeunload', () => {
    if (session) session.destroy();
  });

  if (typeof Peer === 'undefined') {
    setHomeStatus('Could not load the PeerJS library — multiplayer needs it. Check your connection and refresh.', true);
    setBusy(true);
  }
}

init();
