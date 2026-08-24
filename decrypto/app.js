// app.js — networking + UI for Decrypto.
//
// Topology: host-authoritative star over WebRTC data channels.
//   - The host's browser owns the game state and validates every move.
//   - Guests connect straight to the host (peer-to-peer); no game server.
//   - NAT traversal uses Google's public STUN servers (see RTC_CONFIG).
//   - Peer discovery/signaling uses the free PeerJS cloud broker, because
//     GitHub Pages can only serve static files.
// There are no bots in this game: two teams of 2-4 humans.

import {
  PROTO,
  MIN_PER_TEAM,
  MAX_PER_TEAM,
  MAX_PLAYERS,
  MAX_ROUNDS,
  TEAM_META,
  codeLabel,
  newMatch,
  applyMove,
  viewFor,
  markDisconnected,
  markReconnected,
  passEncryptor,
  passDecider,
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
const ID_PREFIX = 'dcr-v1-';
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

// control characters in names could smuggle cursor tricks; the class is built
// from char codes so the source file stays plain ASCII
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
  flashTimer = setTimeout(() => b.classList.add('hidden'), 1800);
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

function avatarEl(name, seat) {
  return el('div', `av s${seat % 8}`, (name || '?').trim().charAt(0).toUpperCase() || '?');
}

// ---------------------------------------------------------------- chat
// Two channels: 'team' (relayed only to your teammates) and 'all'.

let chatUnread = 0;
let peekTimer = null;
let chatChannel = 'team';

function chatSetVisible(v) {
  $('#chat').classList.toggle('hidden', !v);
}

function setChatChannel(ch) {
  chatChannel = ch;
  $('#chat-ch-team').classList.toggle('on', ch === 'team');
  $('#chat-ch-all').classList.toggle('on', ch === 'all');
  $('#chat-input').placeholder = ch === 'team' ? 'Plan with your team…' : 'Say something to everyone…';
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
    el('span', 'chat-lock', m.channel === 'team' ? '🔒' : ''),
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
  const row = el('div', `chat-msg${self ? ' mine' : ''}${m.channel === 'team' ? ' teamch' : ''}`);
  if (m.ts) row.append(el('span', 'chat-time', fmtChatTime(m.ts)));
  if (m.channel === 'team') row.append(el('span', 'chat-lock', '🔒'));
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

// Chat also floats briefly over the sender's seat chip. Kept in a map (not
// the DOM) so bubbles survive re-renders. Team messages only ever REACH
// teammates, so their bubbles can never leak to the other side.
const chatBubbles = new Map();

function paintChatBubbles() {
  for (const n of document.querySelectorAll('.chat-bubble')) n.remove();
  for (const [seat, b] of chatBubbles) {
    const host = document.querySelector(`.member[data-seat="${seat}"]`) || document.querySelector(`.seat-row[data-seat="${seat}"]`);
    if (!host) continue;
    host.append(el('div', 'chat-bubble', b.text));
  }
}

function showChatBubble(m) {
  if (m.seat == null) return;
  const prev = chatBubbles.get(m.seat);
  if (prev) clearTimeout(prev.timer);
  chatBubbles.set(m.seat, {
    text: (m.channel === 'team' ? '🔒 ' : '') + (m.text.length > 110 ? `${m.text.slice(0, 110)}…` : m.text),
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
    this.roster = [{ seat: 0, name, connected: true, team: 0 }];
    this.conns = new Map();
    this.G = null;
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
    if (msg.t === 'team') this.setTeam(seat, msg.team);
    if (msg.t === 'chat') {
      const p = this.roster.find((r) => r.seat === seat);
      if (p) this.relayChat(seat, p.name, msg.text, msg.channel === 'all' ? 'all' : 'team');
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
    if (this.G) return deny('in-progress');
    if (this.roster.length >= MAX_PLAYERS) return deny('full');
    let seat = 0;
    while (this.roster.some((p) => p.seat === seat)) seat++;
    const name = cleanName(msg.name) || `Player ${seat + 1}`;
    // join the smaller team (ties go white)
    const sizes = [0, 1].map((ti) => this.roster.filter((p) => p.team === ti).length);
    const team = sizes[1] < sizes[0] ? 1 : sizes[0] < sizes[1] ? 0 : this.roster.length % 2;
    conn._seat = seat;
    conn._seen = Date.now();
    this.conns.set(seat, conn);
    const token = genCode(12);
    this.roster.push({ seat, name, connected: true, team, token });
    try {
      conn.send({ t: 'welcome', seat, code: this.code, token });
      if (this.chatLog.length) conn.send({ t: 'chatlog', items: this.chatLog.slice(-20) });
    } catch {}
    toast(`${name} joined`);
    this.pushLobby();
  }

  setTeam(seat, team) {
    if (this.G) return;
    team = team ? 1 : 0;
    const p = this.roster.find((r) => r.seat === seat);
    if (!p || p.team === team) return;
    if (this.roster.filter((r) => r.team === team).length >= MAX_PER_TEAM) {
      if (seat === 0) toast('That team is full');
      return;
    }
    p.team = team;
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

  // A round stalls while its encryptor is disconnected — the host can hand
  // the code to a connected teammate instead (Decrypto has no bots).
  passCode(seat) {
    if (!this.G) return;
    if (passEncryptor(this.G, seat)) this.broadcast();
  }

  passFinal(seat) {
    if (!this.G) return;
    if (passDecider(this.G, seat)) this.broadcast();
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

  relayChat(seat, name, text, channel) {
    text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text) return;
    const sender = this.roster.find((r) => r.seat === seat);
    if (!sender) return;
    const entry = { seat, name, text, ts: Date.now(), channel };
    if (channel === 'all') {
      this.chatLog.push(entry);
      if (this.chatLog.length > 50) this.chatLog.shift();
    }
    for (const [s, c] of this.conns) {
      const r = this.roster.find((q) => q.seat === s);
      if (!r) continue;
      if (channel === 'all' || r.team === sender.team) {
        try {
          c.send({ t: 'chat', ...entry });
        } catch {}
      }
    }
    // the host is seat 0
    const me = this.roster.find((r) => r.seat === 0);
    if (channel === 'all' || (me && me.team === sender.team)) addChatMsg(entry, seat === 0);
  }

  sendChat(text, channel) {
    const me = this.roster.find((p) => p.seat === 0);
    this.relayChat(0, me ? me.name : 'Host', text, channel);
  }

  lobbyMsg() {
    return {
      t: 'lobby',
      code: this.code,
      players: this.roster.map((p) => ({ seat: p.seat, name: p.name, team: p.team })),
      perTeamMin: MIN_PER_TEAM,
      perTeamMax: MAX_PER_TEAM,
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
    const sizes = [0, 1].map((ti) => this.roster.filter((p) => p.team === ti).length);
    if (sizes.some((n) => n < MIN_PER_TEAM)) {
      toast(`Each team needs at least ${MIN_PER_TEAM} players`);
      return;
    }
    if (sizes.some((n) => n > MAX_PER_TEAM)) {
      toast(`Teams take at most ${MAX_PER_TEAM} players`);
      return;
    }
    this.G = newMatch(this.roster);
    this.broadcast();
  }

  again() {
    if (!this.G || this.G.phase !== 'over') return;
    this.roster = this.roster.filter((p) => p.connected);
    const sizes = [0, 1].map((ti) => this.roster.filter((p) => p.team === ti).length);
    if (sizes.some((n) => n < MIN_PER_TEAM)) {
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
    showScreen('game');
    renderGame(viewFor(this.G, 0, this.code), this);
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
        this.seat = msg.seat;
        clearTimeout(this.timeout);
        setHomeStatus('');
        setBusy(false);
        this.token = msg.token || this.token;
        saveRejoin(this.code, this.token);
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

  setTeam(team) {
    try {
      this.conn.send({ t: 'team', team });
    } catch {}
  }

  sendChat(text, channel) {
    try {
      this.conn.send({ t: 'chat', text, channel });
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

const REJOIN_KEY = 'dcr-rejoin';

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
  const mySeat = sess.isHost ? 0 : sess.seat;
  for (const ti of [0, 1]) {
    const list = $(`#team-list-${ti}`);
    list.replaceChildren();
    const members = lob.players.filter((p) => p.team === ti);
    for (let i = 0; i < lob.perTeamMax; i++) {
      const p = members[i];
      const row = el('li', `seat-row${p ? '' : ' empty'}`);
      if (p) {
        row.dataset.seat = String(p.seat);
        row.style.position = 'relative';
        row.append(avatarEl(p.name, p.seat));
        row.append(el('span', 'seat-name', p.name));
        if (p.seat === 0) row.append(el('span', 'chip', 'host'));
        if (p.seat === mySeat) row.append(el('span', 'chip you', 'you'));
      } else {
        row.append(el('div', 'av empty', '·'), el('span', 'seat-name dim', i < lob.perTeamMin ? 'Needed' : 'Open seat'));
      }
      list.append(row);
    }
  }
  const me = lob.players.find((p) => p.seat === mySeat);
  for (const b of document.querySelectorAll('.btn-jointeam')) {
    const ti = Number(b.dataset.team);
    const full = lob.players.filter((p) => p.team === ti).length >= lob.perTeamMax;
    b.disabled = (me && me.team === ti) || full;
    b.textContent = me && me.team === ti ? (ti === 0 ? 'You are on White' : 'You are on Black') : ti === 0 ? 'Join White' : 'Join Black';
  }
  const sizes = [0, 1].map((ti) => lob.players.filter((p) => p.team === ti).length);
  const ready = sizes.every((n) => n >= lob.perTeamMin && n <= lob.perTeamMax);
  $('#btn-start').classList.toggle('hidden', !sess.isHost);
  if (sess.isHost) $('#btn-start').disabled = !ready;
  $('#lobby-hint').textContent = ready
    ? sess.isHost
      ? `${sizes[0]}v${sizes[1]} — ready when you are. Plan in team chat once the game starts!`
      : 'Waiting for the host to start the game…'
    : `Each team needs ${lob.perTeamMin}-${lob.perTeamMax} players (now ${sizes[0]}v${sizes[1]}). Share the code or link!`;
  paintChatBubbles();
}

// ---------------------------------------------------------------- game UI

// local picker state for code guesses — one picker per target team's code,
// reset when the round moves on
let choiceMap = new Map();

function choiceFor(view, target) {
  const prefix = `${view.mid}:${view.round}:`;
  const key = prefix + target;
  if (!choiceMap.has(key)) {
    for (const k of [...choiceMap.keys()]) if (!k.startsWith(prefix)) choiceMap.delete(k);
    choiceMap.set(key, [null, null, null]);
  }
  return choiceMap.get(key);
}

function teamName(view, ti) {
  return view.teams[ti].name;
}

function seatName(view, seat) {
  const p = view.players.find((q) => q.seat === seat);
  return p ? p.name : '?';
}

// clues a team has revealed per keyword slot (from resolved history)
function cluesBySlot(view, ti) {
  const slots = [[], [], [], []];
  for (const h of view.history) {
    if (h.team !== ti) continue;
    h.code.forEach((digit, k) => {
      slots[digit - 1].push({ round: h.round, clue: h.clues[k] });
    });
  }
  return slots;
}

function renderTeams(view) {
  const box = $('#teams');
  box.replaceChildren();
  for (const ti of [0, 1]) {
    const t = view.teams[ti];
    const ex = view.exchanges ? view.exchanges[ti] : null;
    const acting = !!ex && !ex.resolved && view.phase === 'playing';
    const panel = el('div', `teampanel t${ti}${acting ? ' acting' : ''}`);

    const head = el('div', 'tp-head');
    head.append(el('span', 'tp-name', t.name + (ti === view.myTeam ? ' (you)' : '')));
    const toks = el('div', 'tp-tokens');
    for (let i = 0; i < 2; i++) toks.append(el('span', `tokdot i${t.intercepts > i ? ' on' : ''}`, t.intercepts > i ? '✓' : ''));
    for (let i = 0; i < 2; i++) toks.append(el('span', `tokdot m${t.miscomms > i ? ' on' : ''}`, t.miscomms > i ? '✗' : ''));
    toks.title = `${t.intercepts} interception ⚪ / ${t.miscomms} miscommunication ⚫`;
    head.append(toks);
    panel.append(head);

    const mem = el('div', 'tp-members');
    for (const seat of t.seats) {
      const p = view.players.find((q) => q.seat === seat);
      const isEnc = !!ex && ex.encryptor === seat && view.phase === 'playing';
      const isDec = !!ex && ex.decider === seat && view.phase === 'playing';
      const chip = el('span', `member${isEnc ? ' enc' : ''}${p && !p.connected ? ' offline' : ''}`);
      chip.dataset.seat = String(seat);
      chip.append(avatarEl(p ? p.name : '?', seat));
      chip.append(el('span', '', (p ? p.name : '?') + (seat === view.you ? ' (you)' : '')));
      if (isEnc) {
        chip.append(el('span', 'mstat', '🔑'));
        chip.title = 'Encryptor this round';
      }
      if (isDec) {
        chip.append(el('span', 'mstat', '🎯'));
        chip.title = (chip.title ? chip.title + ' · ' : '') + 'Final say on guesses this round';
      }
      mem.append(chip);
    }
    panel.append(mem);

    const grid = el('div', 'kwgrid');
    const slots = cluesBySlot(view, ti);
    for (let k = 0; k < 4; k++) {
      const kw = el('div', 'kw');
      kw.append(el('div', 'kw-num', `#${k + 1}`));
      if (t.keywords) kw.append(el('div', 'kw-word', t.keywords[k]));
      else kw.append(el('div', 'kw-word unknown', '?'));
      const cl = el('div', 'kw-clues');
      for (const c of slots[k]) {
        const line = el('div', 'kw-clue');
        line.append(el('span', 'mono', `R${c.round} `), el('b', '', c.clue));
        cl.append(line);
      }
      kw.append(cl);
      panel.append(grid);
      grid.append(kw);
    }

    // this exchange's clues, not yet mapped to slots
    if (ex && ex.clues && !ex.resolved) {
      const pend = el('div', 'tp-pending');
      pend.append(el('span', 'mono', `R${view.round}: `));
      ex.clues.forEach((c, i) => {
        if (i) pend.append(el('span', '', ' · '));
        pend.append(el('span', 'pclue', `“${c}”`));
      });
      pend.append(el('span', '', ' → '));
      pend.append(el('span', 'mono', '?·?·?'));
      panel.append(pend);
    }
    box.append(panel);
  }
}

// ---------------------------------------------------------------- action bar

function digitSet(view, target, row, onPick) {
  const digits = choiceFor(view, target);
  const set = el('div', 'digitset');
  for (let d = 1; d <= 4; d++) {
    const b = el('button', 'dbtn');
    b.type = 'button';
    b.textContent = String(d);
    if (digits[row] === d) {
      b.classList.add('on');
      const dupe = digits.filter((x) => x === d).length > 1;
      if (dupe) b.classList.add('dupe');
    }
    b.addEventListener('click', () => {
      digits[row] = digits[row] === d ? null : d;
      onPick();
    });
    set.append(b);
  }
  return set;
}

function guessReady(view, target) {
  const digits = choiceFor(view, target);
  return digits.every((d) => d != null) && new Set(digits).size === 3;
}

function captureInputs(sel) {
  const vals = {};
  for (const inp of document.querySelectorAll(sel)) vals[inp.dataset.idx] = inp.value;
  return vals;
}

function renderActionBar(view, sess) {
  const keepClues = captureInputs('#action-bar .clue-input');
  const keepSd = captureInputs('#action-bar .sd-input');
  const bar = $('#action-bar');
  bar.replaceChildren();
  const row = (cls) => {
    const r = el('div', 'abar-row');
    if (cls) r.classList.add(cls);
    bar.append(r);
    return r;
  };
  const label = (html) => {
    const s = el('span', 'abar-label');
    s.append(...html);
    return s;
  };
  const txt = (t) => document.createTextNode(t);
  const bold = (t) => el('b', '', t);

  if (view.phase === 'over') {
    row().append(label([txt('Game over — the keywords are revealed above.')]));
    return;
  }

  if (view.phase === 'showdown') {
    const mine = view.teams[view.myTeam];
    if (mine.showdownDone) {
      row().append(label([txt('Keyword guesses locked. Waiting for '), bold(teamName(view, 1 - view.myTeam)), txt('…')]));
    } else {
      row().append(
        label([
          bold('TIEBREAKER: '),
          txt('agree in team chat, then enter the 4 keywords you think '),
          bold(teamName(view, 1 - view.myTeam)),
          txt(' were using. Order does not matter.'),
        ]),
      );
      const r = row();
      for (let i = 0; i < 4; i++) {
        const inp = el('input', 'sd-input');
        inp.dataset.idx = String(i);
        inp.maxLength = 40;
        inp.placeholder = `keyword ${i + 1}`;
        if (keepSd[String(i)]) inp.value = keepSd[String(i)];
        r.append(inp);
      }
      const go = el('button', 'pick go', 'Lock our 4 guesses');
      go.type = 'button';
      go.addEventListener('click', () => {
        const words = [...document.querySelectorAll('#action-bar .sd-input')].map((i) => i.value.trim());
        if (words.some((w) => !w)) {
          toast('Fill in all 4 guesses');
          return;
        }
        sendMove({ kind: 'showdown', words });
      });
      row().append(go);
      row().append(label([txt('First submit locks the answer for your whole team.')]));
    }
    return;
  }

  // Both exchanges run at once: my team's transmission on top, the rival
  // transmission (interception work) below.
  const exs = view.exchanges;
  if (!exs || view.myTeam < 0) return;
  const myEx = exs[view.myTeam];
  const rivEx = exs[1 - view.myTeam];
  const meDecider = myEx.decider === view.you;
  const cluesLine = (cluesArr) => bold(cluesArr.map((c) => `“${c}”`).join(' · '));

  const opinionStrip = (ops) => {
    const entries = Object.entries(ops || {});
    if (!entries.length) return;
    const r = row('oprow');
    for (const [s, c] of entries) {
      const seatN = Number(s);
      r.append(el('span', 'opchip', `${seatName(view, seatN)}${seatN === view.you ? ' (you)' : ''}: ${codeLabel(c)}`));
    }
  };
  const pickerRows = (cluesArr, target) => {
    cluesArr.forEach((c, i) => {
      const r = row('pickrow');
      r.append(el('span', 'cluelbl', `“${c}”`));
      r.append(digitSet(view, target, i, () => renderActionBar(view, sess)));
    });
  };
  const guessButtons = (target, ops, officialLabel) => {
    const r = row();
    if (meDecider) {
      const go = el('button', 'pick go', officialLabel);
      go.type = 'button';
      go.disabled = !guessReady(view, target);
      go.addEventListener('click', () => sendMove({ kind: 'guess', target, code: choiceFor(view, target).slice() }));
      r.append(go);
    } else {
      const sug = el('button', 'pick', ops && ops[view.you] ? 'Update my suggestion' : 'Suggest to my team');
      sug.type = 'button';
      sug.disabled = !guessReady(view, target);
      sug.addEventListener('click', () => sendMove({ kind: 'opinion', target, code: choiceFor(view, target).slice() }));
      r.append(sug);
      r.append(label([txt(`${seatName(view, myEx.decider)} makes the official call.`)]));
    }
  };

  // ---- my team's transmission ---------------------------------------
  if (!myEx.clues) {
    if (myEx.encryptor === view.you) {
      const kws = view.teams[view.myTeam].keywords;
      row().append(label([txt('You are the encryptor. Your secret code: ')]));
      row().append(el('span', 'code-big', codeLabel(myEx.code)));
      row().append(
        label([
          txt('Write one clue per digit — it must point at the meaning of that keyword. Everyone will hear all three.'),
        ]),
      );
      myEx.code.forEach((digit, i) => {
        const r = row('clue-row');
        r.classList.add('clue-row');
        r.append(el('span', 'digit', String(digit)));
        const hint = el('span', 'kwhint');
        hint.append(txt('hints #' + digit + ' '), el('b', '', kws[digit - 1]));
        r.append(hint);
        const inp = el('input', 'clue-input');
        inp.dataset.idx = String(i);
        inp.maxLength = 40;
        inp.placeholder = `clue ${i + 1}`;
        if (keepClues[String(i)]) inp.value = keepClues[String(i)];
        r.append(inp);
      });
      const go = el('button', 'pick go', 'Transmit the 3 clues');
      go.type = 'button';
      go.addEventListener('click', () => {
        const words = [...document.querySelectorAll('#action-bar .clue-input')].map((i) => i.value.trim());
        if (words.some((w) => !w)) {
          toast('Write all 3 clues first');
          return;
        }
        sendMove({ kind: 'clues', words });
      });
      row().append(go);
    } else {
      row().append(
        label([bold(seatName(view, myEx.encryptor)), txt(' is encrypting a code for your team — get ready to decrypt.')]),
      );
    }
  } else if (myEx.resolved) {
    row().append(
      label([
        txt(
          `Your code ${codeLabel(myEx.code)} is revealed — ${myEx.missD ? 'a miscommunication' : 'decrypted cleanly'}${
            myEx.hitI ? ', and the enemy intercepted it' : ''
          }.`,
        ),
      ]),
    );
  } else if (!myEx.haveDecipher) {
    if (myEx.encryptor === view.you) {
      row().append(label([txt('Your teammates are decrypting your clues — keep a straight face.')]));
      opinionStrip(myEx.opinions);
    } else {
      row().append(
        label([
          bold('DECRYPT: '),
          txt(`which keyword is each of ${seatName(view, myEx.encryptor)}'s clues pointing at? Everyone can suggest — `),
          bold(meDecider ? 'you make the official call.' : `${seatName(view, myEx.decider)} makes the official call.`),
        ]),
      );
      pickerRows(myEx.clues, view.myTeam);
      opinionStrip(myEx.opinions);
      guessButtons(view.myTeam, myEx.opinions, 'Lock our official answer');
    }
  } else {
    row().append(
      label([
        txt(
          `Answer locked${myEx.decipherBy != null ? ` by ${seatName(view, myEx.decipherBy)}` : ''}: ${codeLabel(myEx.decipher)}.` +
            (myEx.needIntercept && !myEx.haveIntercept ? ` Waiting for ${teamName(view, 1 - view.myTeam)}'s interception…` : ''),
        ),
      ]),
    );
  }

  // ---- the rival transmission ----------------------------------------
  const div = row('abar-div');
  div.append(el('span', 'divlbl', `${teamName(view, rivEx.team)}'s transmission`));

  if (!rivEx.clues) {
    row().append(
      label([
        bold(seatName(view, rivEx.encryptor)),
        txt(` is encrypting for ${teamName(view, rivEx.team)}. `),
        txt(rivEx.needIntercept ? 'You can work on intercepting once their clues are out.' : 'No interception in Round 1 — take notes!'),
      ]),
    );
  } else if (rivEx.resolved) {
    row().append(
      label([
        txt(
          `Their code ${codeLabel(rivEx.code)} is revealed — ${
            rivEx.hitI ? 'INTERCEPTED by your team!' : rivEx.needIntercept ? (rivEx.haveIntercept ? 'your interception missed' : 'no interception') : 'no interception in Round 1'
          }.`,
        ),
      ]),
    );
  } else if (!rivEx.needIntercept) {
    row().append(label([txt('Their clues — no interception in Round 1, but take notes: '), cluesLine(rivEx.clues)]));
  } else if (!myEx.haveDecipher) {
    row().append(
      label([
        bold('INTERCEPT '),
        txt('later: their clues are out — lock your own answer first, then your team can work on these. '),
        cluesLine(rivEx.clues),
      ]),
    );
  } else if (!rivEx.haveIntercept) {
    row().append(
      label([
        bold('INTERCEPT: '),
        txt(`match ${teamName(view, rivEx.team)}'s pattern from their clue history — a wrong guess costs nothing. Everyone can suggest — `),
        bold(meDecider ? 'you make the official call.' : `${seatName(view, myEx.decider)} makes the official call.`),
      ]),
    );
    pickerRows(rivEx.clues, rivEx.team);
    opinionStrip(rivEx.intOpinions);
    guessButtons(rivEx.team, rivEx.intOpinions, 'Lock the official interception');
  } else {
    row().append(
      label([
        txt(
          `Interception locked${rivEx.interceptBy != null ? ` by ${seatName(view, rivEx.interceptBy)}` : ''}: ${codeLabel(rivEx.intercept)}. Waiting for their team's answer…`,
        ),
      ]),
    );
  }
}

// ---------------------------------------------------------------- main render

// While a player is disconnected the table may stall (hard-stall when they
// are the pending encryptor); tell everyone why, and give the host the
// remedy — Decrypto has no bots, so the code passes to a teammate instead.
function renderDcBanner(view, sess) {
  let bar = $('#dc-banner');
  if (!bar) {
    bar = el('div', '');
    bar.id = 'dc-banner';
    const anchor = $('#action-bar');
    anchor.parentNode.insertBefore(bar, anchor);
  }
  bar.replaceChildren();
  const gone = view.phase !== 'over' ? view.players.filter((p) => !p.connected) : [];
  bar.classList.toggle('on', gone.length > 0);
  for (const p of gone) {
    let msg = `⚠️ ${p.name} lost connection — the game may wait for them.`;
    let fix = null;
    const exs = view.exchanges;
    if (view.phase === 'playing' && exs && p.team >= 0) {
      const E = exs[p.team];
      const R = exs[1 - p.team];
      const encStall = E.encryptor === p.seat && !E.clues && !E.resolved;
      const ownCall = !E.resolved && E.clues && !E.haveDecipher;
      const intCall = !R.resolved && R.needIntercept && R.clues && E.haveDecipher && !R.haveIntercept;
      if (encStall) {
        msg = `⚠️ ${p.name} lost connection — the game is waiting for their clues.`;
        fix = ['Hand the code to a teammate', () => sess.passCode(p.seat)];
      } else if (E.decider === p.seat && (ownCall || intCall)) {
        msg = `⚠️ ${p.name} lost connection — the game is waiting for their official call.`;
        fix = ['Hand the final say to a teammate', () => sess.passFinal(p.seat)];
      }
    }
    const row = el('div', 'dc-row');
    row.append(el('span', 'dc-msg', msg));
    if (fix && sess && sess.isHost) {
      const b = el('button', 'dc-btn', fix[0]);
      b.onclick = fix[1];
      row.append(b);
    }
    bar.append(row);
  }
}

function renderGame(view, sess) {
  lastView = view;
  renderDcBanner(view, sess);
  $('#room-chip').textContent = view.code || '·····';
  $('#round-chip').textContent =
    view.phase === 'showdown' ? 'TIEBREAKER' : view.phase === 'over' ? 'Game over' : `Round ${view.round}/${view.maxRounds}`;

  renderTeams(view);
  renderActionBar(view, sess);
  renderLog(view);
  paintChatBubbles();

  if (view.fx && view.fx.seq !== lastFxSeq) {
    lastFxSeq = view.fx.seq;
    const fx = view.fx;
    if (fx.kind === 'reveal') {
      const mineActing = fx.team === view.myTeam;
      let text = `CODE ${codeLabel(fx.code)}`;
      let cls = 'plain';
      if (fx.hitI) {
        text += ' — INTERCEPTED!';
        cls = mineActing ? 'bad' : '';
      }
      if (fx.missD) {
        text += fx.hitI ? ' + MISCOMMUNICATION' : ' — MISCOMMUNICATION';
        if (mineActing) cls = 'bad';
      }
      flash(text, cls);
    } else if (fx.kind === 'showdown') {
      flash('TIEBREAKER', 'plain');
    } else if (fx.kind === 'over') {
      if (fx.winner != null && fx.winner === view.myTeam) confetti();
    }
  }

  settleOverlay('#result', view.phase === 'over', () => showResult(view, sess));
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

// ---------------------------------------------------------------- result overlay

let confettiDone = false;

function showResult(view, sess) {
  const m = $('#result');
  m.classList.remove('hidden');
  const r = view.result || {};
  const winName = r.winner == null ? null : teamName(view, r.winner);
  $('#res-title').textContent = winName
    ? `${winName} win!`
    : 'Shared victory';
  const why = {
    tokens: 'They came out ahead on tokens.',
    timeout: 'Highest score after all 8 rounds.',
    showdown: 'They named more of the enemy keywords in the tiebreaker.',
    shared: 'Perfectly, stubbornly, evenly matched.',
    forfeit: 'The other team left the field.',
  }[r.reason] || '';
  const mineWon = r.winner != null && r.winner === view.myTeam;
  $('#res-sub').textContent = `${why}${r.winner == null ? '' : mineWon ? ' Take a bow.' : ' Next time, tighten the pattern.'}`;
  const stats = $('#res-stats');
  stats.replaceChildren();
  for (const ti of [0, 1]) {
    const t = view.teams[ti];
    const c = el('span', 'stat-chip');
    c.append(el('b', '', t.name), el('span', '', ` ⚪${t.intercepts} ⚫${t.miscomms}`));
    if (t.showdownHits != null) c.append(el('span', '', ` · ${t.showdownHits}/4 keywords`));
    stats.append(c);
  }
  const kwbox = $('#res-keywords');
  kwbox.replaceChildren();
  for (const ti of [0, 1]) {
    const t = view.teams[ti];
    const card = el('div', 'res-kw');
    card.append(el('div', 'rk-head', `${t.name} — the keywords`));
    const ol = el('ol');
    for (const w of t.keywords || []) {
      const li = el('li');
      li.append(el('b', '', w));
      ol.append(li);
    }
    card.append(ol);
    kwbox.append(card);
  }
  $('#btn-again').classList.toggle('hidden', !sess.isHost);
  $('#btn-golobby').classList.toggle('hidden', !sess.isHost);
  $('#res-wait').classList.toggle('hidden', sess.isHost);
  if (mineWon && !confettiDone) {
    confettiDone = true;
    confetti();
  }
}

// Overlays wait ~1.8s the first time so the final reveal is visible.
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
  $('#result').classList.add('hidden');
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
  if (pendingMove || !session) return;
  pendingMove = true;
  session.localMove(move);
  if (lastView && !session.isHost) renderGame(lastView, session);
}

async function createRoom() {
  const name = cleanName($('#name-input').value) || 'Host';
  localStorage.setItem('dcr-name', name);
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
  localStorage.setItem('dcr-name', name);
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
  $('#name-input').value = localStorage.getItem('dcr-name') || '';

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
  $('#btn-again').addEventListener('click', () => session && session.isHost && session.again());
  $('#btn-golobby').addEventListener('click', () => session && session.isHost && session.toLobby());

  for (const b of document.querySelectorAll('.btn-jointeam')) {
    b.addEventListener('click', () => {
      if (!session) return;
      const ti = Number(b.dataset.team);
      if (session.isHost) session.setTeam(0, ti);
      else session.setTeam(ti);
    });
  }

  $('#chat-ch-team').addEventListener('click', () => setChatChannel('team'));
  $('#chat-ch-all').addEventListener('click', () => setChatChannel('all'));
  $('#chat-toggle').addEventListener('click', () => {
    if ($('#chat-panel').classList.contains('hidden')) openChatPanel();
    else $('#chat-panel').classList.add('hidden');
  });
  $('#chat-peek').addEventListener('click', openChatPanel);
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = $('#chat-input');
    const text = inp.value.trim();
    if (text && session) session.sendChat(text, chatChannel);
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
