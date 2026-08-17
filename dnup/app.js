// app.js — networking + UI for DNUP.
//
// Topology: host-authoritative star over WebRTC data channels.
//   - The host's browser owns the game state and validates every move.
//   - Guests connect straight to the host (peer-to-peer); no game server.
//   - NAT traversal uses Google's public STUN servers (see RTC_CONFIG).
//   - Peer discovery/signaling uses the free PeerJS cloud broker, because
//     GitHub Pages can only serve static files.

import {
  PROTO,
  GLYPHS,
  MIN_PLAYERS,
  MAX_PLAYERS,
  newGame,
  applyMove,
  markDisconnected,
  viewFor,
  botChoose,
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
const ID_PREFIX = 'dnup-v1-'; // namespaces our room ids on the public broker
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
function flash(text, cls = '') {
  const b = $('#banner');
  b.textContent = text;
  b.className = 'flash hidden';
  void b.offsetWidth; // restart the pop animation
  b.className = `flash ${cls}`;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => b.classList.add('hidden'), 1500);
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

function cardEl(card, big = false) {
  const b = el('button', `card c-${card.color}${big ? ' big' : ''}`);
  b.type = 'button';
  b.setAttribute('aria-label', `${card.color} ${card.rank}`);
  b.append(
    el('span', 'corner tl', String(card.rank)),
    el('span', 'glyph', GLYPHS[card.color]),
    el('span', 'rank', String(card.rank)),
    el('span', 'corner br', String(card.rank)),
  );
  return b;
}

function hideGameover() {
  $('#gameover').classList.add('hidden');
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
let lastFxSeq = 0;

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
    const seat = conn._seat;
    if (seat == null) return;
    if (msg.t === 'move') this.move(seat, msg.move);
    // 'hb' just refreshes _seen above
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
    const cur = this.roster.find((p) => p.seat === this.G.turn);
    if (!cur || !cur.bot) return;
    this.botTimer = setTimeout(() => {
      if (!this.G || this.G.phase !== 'playing') return;
      const seat = this.G.turn;
      const p = this.roster.find((q) => q.seat === seat);
      if (!p || !p.bot) return;
      const res = applyMove(this.G, seat, botChoose(this.G, seat));
      if (!res.ok) applyMove(this.G, seat, { kind: 'draw' }); // safety net
      this.broadcast();
    }, 650 + Math.random() * 850);
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
    this.G = newGame(this.roster);
    this.broadcast();
  }

  again() {
    this.roster = this.roster.filter((p) => p.connected);
    if (this.roster.length < MIN_PLAYERS) {
      this.toLobby();
      toast('Not enough players — back to the lobby');
      return;
    }
    this.G = newGame(this.roster);
    hideGameover();
    this.broadcast();
  }

  toLobby() {
    this.G = null;
    this.roster = this.roster.filter((p) => p.connected);
    hideGameover();
    this.pushLobby();
    showScreen('lobby');
  }

  broadcast() {
    for (const [seat, conn] of this.conns) {
      try {
        conn.send({ t: 'state', view: viewFor(this.G, seat, this.code) });
      } catch {}
    }
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
      if (e && e.type === 'peer-unavailable' && !this.joined) {
        this.fail('Room not found — check the code.');
      }
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
            full: 'That room is full (5 players max).',
            'in-progress': 'That game has already started.',
            version: 'Version mismatch — ask everyone to refresh the page.',
          }[msg.reason] || 'Could not join that room.';
        this.fail(why);
        break;
      }
      case 'lobby':
        hideGameover();
        renderLobby(msg, this);
        showScreen('lobby');
        break;
      case 'state':
        showScreen('game');
        renderGame(msg.view, this);
        break;
      case 'err':
        pendingMove = false;
        toast(msg.error);
        break;
    }
  }

  localMove(move) {
    try {
      this.conn.send({ t: 'move', move });
    } catch {}
  }

  fail(text) {
    this.destroy();
    session = null;
    showScreen('home');
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

// ---------------------------------------------------------------- rendering

function renderLobby(lob, sess) {
  $('#lobby-code').textContent = lob.code;
  const list = $('#lobby-players');
  list.replaceChildren();
  const mySeat = sess.isHost ? 0 : sess.seat;
  for (let i = 0; i < lob.max; i++) {
    const p = lob.players[i];
    const row = el('li', `seat-row${p ? '' : ' empty'}`);
    if (p) {
      row.append(avatarEl(p.name, p.seat, p.bot));
      const label = el('span', 'seat-name', p.name);
      row.append(label);
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
  $('#lobby-hint').textContent = sess.isHost
    ? lob.players.length < lob.min
      ? 'Share the code or link — or add a bot to play right away.'
      : `${lob.players.length} of ${lob.max} players in. Start whenever you like!`
    : 'Waiting for the host to start the game…';
}

function renderGame(view, sess) {
  pendingMove = false;
  hideGameover();
  $('#room-chip').textContent = view.code;

  const myTurn = view.phase === 'playing' && view.turn === view.you;
  document.body.classList.toggle('my-turn', myTurn);

  // Opponents, in seat order starting clockwise from you.
  const seats = view.players.map((p) => p.seat).sort((a, b) => a - b);
  const myIdx = Math.max(0, seats.indexOf(view.you));
  const opp = $('#opponents');
  opp.replaceChildren();
  for (let k = 1; k < seats.length; k++) {
    const p = view.players.find((q) => q.seat === seats[(myIdx + k) % seats.length]);
    if (!p || p.seat === view.you) continue;
    const box = el('div', `opp${view.phase === 'playing' && view.turn === p.seat ? ' turn' : ''}${p.connected ? '' : ' offline'}`);
    box.append(avatarEl(p.name, p.seat, p.bot));
    const meta = el('div', 'opp-meta');
    meta.append(el('div', 'opp-name', p.name));
    const backs = el('div', 'backs');
    for (let i = 0; i < Math.min(p.handCount, 7); i++) backs.append(el('i', 'mini-back'));
    backs.append(el('span', 'count', String(p.handCount)));
    meta.append(backs);
    box.append(meta);
    if (p.finished) box.append(el('span', 'tag win', 'WINNER'));
    else if (!p.connected) box.append(el('span', 'tag off', 'OFFLINE'));
    else if (p.handCount === 1) box.append(el('span', 'tag dnup', 'DNUP!'));
    opp.append(box);
  }

  // Center table: draw pile, discard, direction.
  const draw = $('#draw-pile');
  draw.classList.toggle('can', myTurn);
  draw.disabled = !myTurn;
  $('#draw-count').textContent = String(view.drawCount);
  $('#draw-label').textContent = view.drawCount > 0 ? 'draw' : 'pass';

  const disc = $('#discard');
  disc.replaceChildren(cardEl(view.top, true));

  const dir = $('#dir');
  dir.className = `dir ${view.dir}`;
  $('#dir-arrow').textContent = view.dir === 'up' ? '▲' : '▼';
  $('#dir-word').textContent = view.dir === 'up' ? 'UP' : 'DOWN';

  // Your hand.
  const hand = $('#hand');
  hand.replaceChildren();
  const legal = new Set(view.legal);
  for (const c of view.hand) {
    const b = cardEl(c);
    const can = myTurn && legal.has(c.id);
    b.classList.toggle('legal', can);
    b.disabled = !can;
    if (can) b.addEventListener('click', () => playCard(c.id));
    hand.append(b);
  }

  // Status line.
  const status = $('#status');
  if (view.phase === 'playing') {
    if (myTurn) {
      const verb = view.drawCount > 0 ? 'draw a card' : 'pass';
      status.textContent = view.legal.length
        ? `Your turn — play a glowing card, or ${verb}`
        : `Your turn — no playable card, ${verb}`;
      status.className = 'status mine';
    } else {
      const cur = view.players.find((p) => p.seat === view.turn);
      status.textContent = `Waiting for ${cur ? cur.name : '…'}…`;
      status.className = 'status';
    }
  } else {
    status.textContent = '';
    status.className = 'status';
  }

  // Feed.
  const feed = $('#feed');
  feed.replaceChildren();
  for (const line of view.feed) feed.append(el('div', 'feed-line', line));
  feed.scrollTop = feed.scrollHeight;

  // One-shot effects.
  if (view.fx && view.fx.seq !== lastFxSeq) {
    lastFxSeq = view.fx.seq;
    if (view.fx.kind === 'play') {
      disc.firstChild && disc.firstChild.classList.add('pop');
      if (view.fx.flipped) {
        dir.classList.add('pulse');
        setTimeout(() => dir.classList.remove('pulse'), 700);
        flash(view.dir === 'up' ? 'GOING UP ▲' : 'GOING DOWN ▼', view.dir);
      }
      if (view.fx.dnup) {
        const who = view.players.find((p) => p.seat === view.fx.seat);
        const say = () => flash(`${who ? who.name : 'Someone'} calls DNUP!`, 'dnup');
        view.fx.flipped ? setTimeout(say, 1000) : say();
      }
    }
  }

  if (view.phase === 'over') showGameover(view, sess);
}

function showGameover(view, sess) {
  const m = $('#gameover');
  m.classList.remove('hidden');
  const winner = view.players.find((p) => p.seat === view.winner);
  $('#go-title').textContent =
    view.winner == null ? 'Deadlock!' : `${winner ? winner.name : 'Someone'} wins!`;
  $('#go-sub').textContent = view.forfeit
    ? 'Everyone else left the game.'
    : view.stalemate
      ? 'No moves left anywhere — fewest cards takes it.'
      : 'First to shed every card.';
  const list = $('#go-rank');
  list.replaceChildren();
  (view.ranking || []).forEach((r, i) => {
    const row = el('li', `rank-row${r.seat === view.you ? ' me' : ''}`);
    row.append(
      el('span', 'rank-pos', String(i + 1)),
      avatarEl(r.name, r.seat, r.bot),
      el('span', 'rank-name', r.name + (r.connected ? '' : ' (left)')),
      el('span', 'rank-cards', r.cardsLeft === 0 ? 'out!' : `${r.cardsLeft} left`),
    );
    list.append(row);
  });
  $('#btn-again').classList.toggle('hidden', !sess.isHost);
  $('#btn-golobby').classList.toggle('hidden', !sess.isHost);
  $('#go-wait').classList.toggle('hidden', sess.isHost);
  if (view.winner === view.you) confetti();
}

// ---------------------------------------------------------------- actions

function playCard(cardId) {
  if (pendingMove || !session) return;
  pendingMove = true;
  session.localMove({ kind: 'play', cardId });
}

function drawCard() {
  if (pendingMove || !session) return;
  pendingMove = true;
  session.localMove({ kind: 'draw' });
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
  $('#draw-pile').addEventListener('click', drawCard);

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
