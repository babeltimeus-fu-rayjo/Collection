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
function flash(text, cls = '') {
  const b = $('#banner');
  b.textContent = text;
  b.className = 'flash hidden';
  void b.offsetWidth;
  b.className = `flash ${cls}`;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => b.classList.add('hidden'), 1600);
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
    this.botTimer = null;
    this.chatLog = [];
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
    const seat = conn._seat;
    if (seat == null) return;
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
    if (this.G) return deny('in-progress');
    if (this.roster.length >= MAX_PLAYERS) return deny('full');
    let seat = 0;
    while (this.roster.some((p) => p.seat === seat)) seat++;
    const name = cleanName(msg.name) || `Player ${seat + 1}`;
    conn._seat = seat;
    conn._seen = Date.now();
    this.conns.set(seat, conn);
    this.roster.push({ seat, name, connected: true });
    try {
      conn.send({ t: 'welcome', seat, code: this.code });
      if (this.chatLog.length) conn.send({ t: 'chatlog', items: this.chatLog.slice(-20) });
    } catch {}
    toast(`${name} joined`);
    this.pushLobby();
  }

  drop(conn) {
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
      if (markDisconnected(this.G, seat)) toast(`${p.name} disconnected`);
      this.broadcast();
    }
  }

  sweep() {
    const now = Date.now();
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
    const cur = this.roster.find((p) => p.seat === actor);
    if (!cur || !cur.bot) return;
    this.botTimer = setTimeout(() => {
      if (!this.G || this.G.phase !== 'playing') return;
      const g = this.G;
      const seat = g.pending ? g.pending.seat : g.turn;
      const p = this.roster.find((q) => q.seat === seat);
      if (!p || !p.bot) return;
      const res = applyMove(g, seat, botChoose(g, seat));
      if (!res.ok) {
        // never stall the table: fall back to the plainest legal action
        const me = g.players.find((q) => q.seat === seat);
        if (g.pending && g.pending.seat === seat) applyMove(g, seat, { kind: 'bishopChoice', discard: false });
        else if (me && me.hand[0]) applyMove(g, seat, { kind: 'play', cardId: me.hand[0].id });
      }
      this.broadcast();
    }, 2600 + Math.random() * 1600);
  }

  lobbyMsg() {
    return {
      t: 'lobby',
      code: this.code,
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
    for (const [seat, conn] of this.conns) {
      try {
        conn.send({ t: 'state', view: viewFor(this.G, seat, this.code) });
      } catch {}
    }
    pendingMove = false;
    resetChoice();
    showScreen('game');
    renderGame(viewFor(this.G, 0, this.code), this);
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
  constructor(peer, code, name) {
    this.isHost = false;
    this.peer = peer;
    this.code = code;
    this.seat = null;
    this.joined = false;
    this.closed = false;
    const conn = peer.connect(ID_PREFIX + code, { reliable: true, serialization: 'json' });
    this.conn = conn;
    this.timeout = setTimeout(() => {
      if (!this.joined) this.fail('Could not reach that room. Check the code and try again.');
    }, 12000);
    peer.on('error', (e) => {
      if (e && e.type === 'peer-unavailable' && !this.joined) this.fail('Room not found — check the code.');
    });
    conn.on('open', () => conn.send({ t: 'hello', v: PROTO, name }));
    conn.on('data', (msg) => this.onMsg(msg));
    conn.on('close', () => {
      if (!this.closed) this.fail(this.joined ? 'Disconnected from the host.' : 'Connection closed.');
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
        this.seat = msg.seat;
        clearTimeout(this.timeout);
        setHomeStatus('');
        setBusy(false);
        break;
      case 'deny': {
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

// ---------------------------------------------------------------- lobby UI

function renderLobby(lob, sess) {
  logLines = [];
  logMid = null;
  $('#feed').replaceChildren();
  clearChatBubbles();
  chatSetVisible(true);
  $('#lobby-code').textContent = lob.code;
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
  const c = el('div', `card v${cardValue(key)}${size ? ` ${size}` : ''}`);
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

function seatTile(view, p) {
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

  const pile = el('div', 'pile');
  if (p.discard.length) {
    for (const key of p.discard.slice(-6)) pile.append(cardEl(key, 'mini'));
  } else {
    pile.append(el('div', 'pile-empty', 'nothing played yet'));
  }
  tile.append(pile);
  return tile;
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
    const keys = Object.keys(deckCounts(view.players.length))
      .filter((k) => k !== 'guard')
      .sort((a, b) => cardValue(a) - cardValue(b));
    for (const k of keys) {
      const b = el('button', `pick${choice.guess === k ? ' on' : ''}`, `${cardValue(k)} ${cardName(k)}`);
      b.type = 'button';
      b.addEventListener('click', () => {
        choice.guess = k;
        renderGame(lastView, session);
      });
      grow.append(b);
    }
    bar.append(grow);
  }

  if (enough && spec.guess === 'value') {
    bar.append(el('span', 'ask', 'guess their number:'));
    const vrow = el('div', 'pickrow');
    const values = [...new Set(Object.keys(deckCounts(view.players.length)).map(cardValue))].sort((a, b) => a - b);
    for (const v of values) {
      const b = el('button', `pick${choice.guess === v ? ' on' : ''}`, String(v));
      b.type = 'button';
      b.addEventListener('click', () => {
        choice.guess = v;
        renderGame(lastView, session);
      });
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

function renderGame(view, sess) {
  lastView = view;
  chatSetVisible(true);
  $('#room-chip').textContent = view.code;
  $('#round-chip').textContent = `Round ${view.round} · first to ${view.tokensToWin} ♥`;

  renderCardRef(view.players.length);
  const myTurn = view.phase === 'playing' && view.turn === view.you && !view.pending;
  const me = view.players.find((p) => p.seat === view.you);
  document.body.classList.toggle('my-turn', myTurn);

  // the table, starting from your own seat
  const table = $('#table');
  table.replaceChildren();
  const order = view.players.map((p) => p.seat).sort((a, b) => a - b);
  const start = Math.max(0, order.indexOf(view.you));
  for (let k = 0; k < order.length; k++) {
    const p = view.players.find((q) => q.seat === order[(start + k) % order.length]);
    table.append(seatTile(view, p));
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
    status.textContent = cur && cur.bot ? `${cur.name} is thinking…` : `Waiting for ${cur ? cur.name : '…'}…`;
    status.className = 'status';
  }

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

function renderLog(view) {
  if (view.mid !== logMid) {
    logMid = view.mid;
    logLines = [];
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
