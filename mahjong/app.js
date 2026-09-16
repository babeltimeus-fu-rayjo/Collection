// app.js — networking + UI for Mahjong.
//
// Topology: host-authoritative star over WebRTC data channels.
//   - The host's browser owns the game state and validates every move.
//   - Guests connect straight to the host (peer-to-peer); no game server.

import {
  PROTO,
  NUM_PLAYERS,
  WINDS,
  VARIANTS,
  variantByKey,
  tileName,
  keyParts,
  tileSort,
  isHonor,
  isTerminal,
  buildDeck,
  newMatch,
  applyMove,
  viewFor,
  positionFromView,
  outlookFor,
  botChoose,
  turnSeat,
  playerBySeat,
  markDisconnected,
  markReconnected,
  markBotTakeover,
  markSeatClaimed,
  markSeatResigned,
  SCORING_GUIDE,
} from './game.js';
import { initSettings } from '../common/settings.js';
import '../common/feedtoggle.js';
import '../common/version.js';

const cfg = initSettings('mjg', [
  { key: 'stepBots', label: 'Step bots (click to continue)', def: false, bool: true, section: 'Testing', host: true, hint: 'Bots stop before every action and wait for you to click the table. Use it to watch one move at a time and judge whether they are playing well. Your own hand and the action buttons still work normally — click the felt, not a tile, to let the next bot go.' },
  { key: 'dimOthers', label: 'Hover dims the rest', def: true, bool: true, section: 'Table', hint: 'Hovering a tile fades every tile that is not a copy of it, instead of only ringing the copies. Much easier to pick a tile out of a full pond.' },
  { key: 'revealBots', label: "Reveal bots' hands", def: false, bool: true, section: 'Testing', host: true, hint: 'Turn the bots\' concealed tiles face up while the hand is still being played, so you can see what they are holding. Only the host builds views, so this reveals them to everyone at the table.' },
  { key: 'botDelay', label: 'Bot thinking delay', def: [1200, 800], section: 'Host pacing', host: true },
  { key: 'claimTimeout', label: 'Claim timeout (0 = off)', def: 0, section: 'Host pacing', host: true, hint: 'Auto-pass a player who hasn\'t responded to a claim after this long. 0 waits indefinitely (the default).' },
  { key: 'postFlyDelay', label: 'Pause after discard fly', def: 0, section: 'Host pacing', host: true, hint: 'Extra pause after a discarded tile finishes flying before the next bot acts. Bots always wait for the fly itself; this adds on top.' },
  { key: 'talkScale', label: 'Speech-line waits ×', def: 1, min: 0, max: 4, step: 0.1, unit: '×', ms: false, section: 'Table talk' },
  { key: 'talkHoldPad', label: 'Turn hold after last line', def: 1200, section: 'Table talk' },
  { key: 'bubbleSay', label: 'Game bubbles linger', def: 4000, section: 'Bubbles & banners' },
  { key: 'bubbleChat', label: 'Chat bubbles linger', def: 6000, section: 'Bubbles & banners' },
  { key: 'bubbleTrunc', label: 'Bubble text cap', def: 84, min: 12, max: 400, step: 4, unit: 'ch', ms: false, section: 'Bubbles & banners' },
  { key: 'flashMs', label: 'Banner duration', def: 1800, section: 'Bubbles & banners' },
]);

// What the host is allowed to put in a view beyond what the rules expose. Only
// the testing drawer's "Reveal bots' hands" lives here, and it is read fresh on
// every broadcast, so the switch takes effect on the next state the host sends.
const viewOpts = () => ({ revealBots: cfg.on('revealBots') });

// Bots are holding for a click (see scheduleBots). The prompt is hidden the
// moment they are released, and never shows unless a bot really is waiting.
function paintStep() {
  const el_ = $('#step-peek');
  if (el_) el_.classList.toggle('hidden', !(session && session.isHost && session.stepPending));
}

// A click on the table lets the next bot act. Your own controls are exempt —
// discarding shouldn't double as the nudge, or the bot would move the instant
// you played and you'd never see the board in between.
document.addEventListener('click', (e) => {
  if (!session || !session.isHost || !session.stepPending) return;
  if (e.target.closest && e.target.closest('#hand, #action-bar, #chat, #feed, .topbar, #size-popover, #cfg-drawer, #cfg-gear, .modal')) return;
  session.step();
});

// Settings are stored, not observed, so a toggle would otherwise sit unseen
// until somebody moved. Re-broadcast when the drawer changes, so ticking the box
// lays the bots' tiles out straight away.
document.addEventListener('change', (e) => {
  if (!e.target.closest || !e.target.closest('#cfg-drawer')) return;
  // after the drawer's own handler has saved the new value, not before it
  setTimeout(() => { if (session && session.isHost && session.G) session.broadcast(); }, 0);
}, true);

// how long a discarded tile spends flying out of its quadrant; bots wait at
// least this long after a discard (see scheduleBots) so the fly always lands
const FLY_MS = 600;

// ---------------------------------------------------------------- networking

const RTC_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
  ],
};

const PEER_OPTS = { debug: 1, config: RTC_CONFIG };
const ID_PREFIX = 'mjg-v1-';
const BOT_NAMES = ['Bamboo', 'Dragon', 'Phoenix', 'Lotus', 'Jade', 'Pearl', 'Tiger', 'Crane'];
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
    peer.on('open', () => { if (!done) { done = true; resolve(peer); } });
    peer.on('error', (e) => { if (!done) { done = true; try { peer.destroy(); } catch {} reject(e); } });
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

const CTRL_RE = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']', 'g');
function cleanName(s) { return (s || '').replace(CTRL_RE, '').trim().slice(0, 16); }
function parseCode(s) { s = (s || '').trim(); const m = s.match(/room=([A-Za-z0-9]+)/); if (m) s = m[1]; return s.replace(/[^A-Za-z0-9]/g, '').toUpperCase(); }
function roomLink(code) { return `${location.origin}${location.pathname}?room=${code}`; }

// ---------------------------------------------------------------- DOM helpers

const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
function showScreen(name) { for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== `screen-${name}`); }
function toast(text, ms = 3000) { const t = el('div', 'toast', text); $('#toasts').append(t); setTimeout(() => t.classList.add('gone'), ms); setTimeout(() => t.remove(), ms + 400); }

let flashTimer = null;
function flash(text, cls = '', ms = 0) {
  const b = $('#banner');
  b.textContent = text;
  b.className = 'flash hidden';
  void b.offsetWidth;
  const dur = ms || cfg('flashMs');
  b.style.setProperty('--dur', `${dur}ms`);
  b.className = `flash ${cls}`;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => b.classList.add('hidden'), dur);
}

function setHomeStatus(text, isError = false) {
  const s = $('#home-status');
  s.textContent = text || '';
  s.classList.toggle('error', isError);
}

function setBusy(busy) { $('#btn-create').disabled = busy; $('#btn-join').disabled = busy; }

function avatarEl(name, seat, bot = false) {
  if (bot) return el('div', 'av bot', '\u{1F916}');
  return el('div', `av s${seat % 4}`, (name || '?').trim().charAt(0).toUpperCase());
}

// ---------------------------------------------------------------- tile rendering

// Tile faces are drawn by us (no Unicode glyph, so no built-in frame): a
// numeral + 萬 for man, traditional dot layouts for pin, bamboo for sou, and
// characters for winds/dragons/flowers. A small English index sits in the
// top-right corner (digit for suits, letter for winds).

const MNUM = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
// Per-number pip placement (traditional arrangements), positioned absolutely so
// they can slant / cluster / fan and never touch. Coords are % of the content
// box; a pip may carry its own size override as a 3rd element.
const PIN_POS = {
  1: [[50, 50]],
  2: [[50, 27], [50, 73]],
  3: [[26, 22], [50, 50], [74, 78]],
  4: [[30, 28], [70, 28], [30, 72], [70, 72]],
  5: [[30, 27], [70, 27], [50, 50], [30, 73], [70, 73]],
  6: [[31, 20], [69, 20], [31, 50], [69, 50], [31, 80], [69, 80]],
  7: [[22, 14], [50, 26], [78, 38], [33, 62], [67, 62], [33, 86], [67, 86]],
  8: [[32, 13], [68, 13], [32, 37], [68, 37], [32, 63], [68, 63], [32, 87], [68, 87]],
  9: [[16, 18], [50, 18], [84, 18], [16, 50], [50, 50], [84, 50], [16, 82], [50, 82], [84, 82]],
};
// 1 is the big bullseye; every other pin uses one uniform dot size
const PIN_SZ = { 1: .58, 2: .2, 3: .2, 4: .2, 5: .2, 6: .2, 7: .2, 8: .2, 9: .2 };
// bamboo: [x, y, rotation] — 8 is the classic M / upside-down-M fan
const SOU_POS = {
  1: [[50, 50, 0]],
  2: [[50, 28, 0], [50, 72, 0]],
  3: [[50, 24, 0], [32, 73, 0], [68, 73, 0]],
  4: [[33, 28, 0], [67, 28, 0], [33, 72, 0], [67, 72, 0]],
  5: [[50, 50, 0], [28, 32, 0], [72, 32, 0], [28, 68, 0], [72, 68, 0]],
  6: [[24, 30, 0], [50, 30, 0], [76, 30, 0], [24, 70, 0], [50, 70, 0], [76, 70, 0]],
  7: [[50, 14, 0], [27, 48, 0], [50, 48, 0], [73, 48, 0], [27, 82, 0], [50, 82, 0], [73, 82, 0]],
  8: [[12, 28, 0], [37, 28, 30], [63, 28, -30], [88, 28, 0], [12, 72, 0], [37, 72, -30], [63, 72, 30], [88, 72, 0]],
  9: [[24, 17, 0], [50, 17, 0], [76, 17, 0], [24, 50, 0], [50, 50, 0], [76, 50, 0], [24, 83, 0], [50, 83, 0], [76, 83, 0]],
};
const SOU_SZ = { 1: .6, 2: .3, 3: .3, 4: .3, 5: .28, 6: .28, 7: .26, 8: .36, 9: .24 };
const WIND_CHAR = { E: '東', S: '南', W: '西', N: '北' };
const DRAGON_CHAR = { R: '中', G: '發', W: '白' };
const FLOWER_CHAR = ['', '梅', '蘭', '菊', '竹', '春', '夏', '秋', '冬'];

function buildFace(t) {
  if (t.kind === 'm') {
    const f = el('div', 'face man');
    f.append(el('span', 'mnum', MNUM[t.v] || t.v));
    f.append(el('span', 'msuit', '萬'));
    return f;
  }
  if (t.kind === 'p' || t.kind === 's') {
    const f = el('div', `face ${t.kind === 'p' ? 'pin' : 'sou'}${t.v === 1 ? ' one' : ''}`);
    const box = el('div', 'pip-abs');
    if (t.kind === 'p') {
      for (const p of (PIN_POS[t.v] || [[50, 50]])) {
        const d = p[2] || PIN_SZ[t.v] || .2;
        const s = el('span', 'pip');
        s.style.cssText = `left:${p[0]}%;top:${p[1]}%;width:${d}em;height:${d}em`;
        box.append(s);
      }
    } else {
      for (const p of (SOU_POS[t.v] || [[50, 50, 0]])) {
        const hh = SOU_SZ[t.v] || .3, w = hh * (t.v === 8 ? 0.27 : 0.38), lw = hh * 0.32, lh = hh * 0.48;
        const s = el('span', 'bamboo');
        s.style.cssText = `left:${p[0]}%;top:${p[1]}%;width:${w}em;height:${hh}em;transform:translate(-50%,-50%) rotate(${p[2] || 0}deg)`;
        const lf = el('i', 'leaf');
        lf.style.cssText = `width:${lw}em;height:${lh}em;transform:translateX(-46%) rotate(22deg)`;
        s.append(lf);
        box.append(s);
      }
    }
    f.append(box);
    return f;
  }
  if (t.kind === 'wind') { const f = el('div', 'face wind'); f.append(el('span', 'honor', WIND_CHAR[t.v] || t.v)); return f; }
  if (t.kind === 'dragon') { const f = el('div', `face dragon-${t.v}`); f.append(el('span', 'honor', DRAGON_CHAR[t.v] || t.v)); return f; }
  if (t.kind === 'flower') { const f = el('div', 'face flower'); f.append(el('span', 'honor', FLOWER_CHAR[t.v] || '花')); return f; }
  return el('div', 'face');
}

// small corner index — the digit for number suits, a letter for winds;
// nothing for dragons or flowers
function cornerIndex(t) {
  if (t.kind === 'm' || t.kind === 'p' || t.kind === 's') return String(t.v);
  if (t.kind === 'wind') return t.v; // E S W N
  if (t.kind === 'flower') return String(((t.v - 1) % 4) + 1); // 1-4 plants, 1-4 seasons
  return '';
}

function tileSuitClass(t) {
  if (!t) return '';
  if (t.kind === 'm') return 'man';
  if (t.kind === 'p') return 'pin';
  if (t.kind === 's') return 'sou';
  if (t.kind === 'wind') return 'wind';
  if (t.kind === 'dragon') return `dragon-${t.v}`;
  if (t.kind === 'flower') return 'flower';
  return '';
}

function renderTile(t, opts = {}) {
  if (!t) return el('div', 'tile facedown');
  const cls = ['tile', tileSuitClass(t)];
  if (opts.highlight) cls.push('highlight');
  if (opts.lastDraw) cls.push('last-draw');
  if (opts.riichi) cls.push('riichi-mark');
  const d = el('div', cls.join(' '));
  if (t.key) d.dataset.key = t.key;
  d.append(buildFace(t));
  const idx = cornerIndex(t);
  if (idx) {
    const span = el('span', 'tile-idx', idx);
    // plants (flowers 1-4) number on the left, seasons (5-8) on the right
    if (t.kind === 'flower' && t.v <= 4) span.classList.add('left');
    d.append(span);
  }
  if (opts.onClick) { d.style.cursor = 'pointer'; d.addEventListener('click', opts.onClick); }
  return d;
}

// Hovering a tile lights up every copy of it that is already face up — the
// fastest way to see how many of what you are waiting for have already gone,
// without hunting across four discard piles. A face-down tile carries no key,
// so nothing concealed can ever light up.
let matchKey = null;
// `force` re-applies the same key after a render. Every render rebuilds the
// tiles, so the marks are lost with them — and since the board keeps its dimmed
// class, the result is a faded table with nothing lit on it. A pointer that has
// not moved fires no event to put it back, so the render has to.
function setMatch(key, force = false) {
  if (!force && key === matchKey && (!key || document.querySelector('.tile.match'))) return;
  matchKey = key;
  for (const n of document.querySelectorAll('.tile.match')) n.classList.remove('match');
  // Ringing the copies barely registers: a 2px outline on a 36px tile, in the
  // same warm hue as the tile faces and the turn halo. Fading everything ELSE
  // is the signal that actually carries — the matches do not change, the field
  // recedes around them.
  // Only the table is marked up. Your own hand is the one place you are already
  // looking and already know the contents of, so lighting it up is noise — but
  // it still COUNTS, because two of a tile in your hand is two of it accounted
  // for, and the number would be wrong without them.
  const dim = cfg.on('dimOthers');
  $('#table')?.classList.toggle('dimmed', !!key && dim);
  if (!key) { paintMatchCount(null, 0); return; }

  const esc = (window.CSS && CSS.escape) ? CSS.escape(key) : key;
  let seen = 0;
  for (const [root, mark] of [['#table', true], ['#hand', false]]) {
    const r = $(root);
    if (!r) continue;
    for (const n of r.querySelectorAll(`.tile[data-key="${esc}"]`)) {
      if (mark) n.classList.add('match');
      // A revealed bot hand is a testing convenience, not something the table
      // can see, so it lights up but is not counted as accounted for.
      if (!n.closest('.seat-hand')) seen += 1;
    }
  }
  paintMatchCount(key, seen);
}

// What you are really asking when you hover a tile is how many are left, so
// answer that instead of making anyone count outlines. Only face-up tiles carry
// a key, so this is the same arithmetic a player at a real table can do.
function paintMatchCount(key, seen) {
  const box = $('#match-info');
  if (!box) return;
  if (!key) { box.classList.add('quiet'); return; }
  const total = key[0] === 'f' ? 1 : 4;       // one of each flower, four of everything else
  const left = Math.max(0, total - seen);
  box.replaceChildren();
  box.append(el('span', 'mi-name', tileName({ key, ...keyParts(key) })));
  const line = el('span', 'mi-left');
  if (left === 0) line.append(el('span', 'gone', 'none left'));
  else line.append(el('span', '', `${left} of ${total} left`));
  box.append(line);
  box.classList.remove('quiet');
}
// Clearing is delayed; setting is not. Sweeping along a row of tiles crosses
// the 3px gap between each pair, and on every one of those the pointer is over
// the container rather than a tile — so an immediate clear made the whole board
// flash off and on again the length of the hand. A short grace period is long
// enough for the next tile to claim the highlight, and far shorter than any
// deliberate move away.
let matchClear = null;
document.addEventListener('pointerover', (e) => {
  const t = e.target && e.target.closest ? e.target.closest('.tile[data-key]') : null;
  const key = t && t.closest('#table, #hand') ? t.dataset.key : null;
  clearTimeout(matchClear);
  if (key) { setMatch(key); return; }
  matchClear = setTimeout(() => setMatch(null), 140);
});
// leaving the page entirely is deliberate, so that one is immediate
document.addEventListener('pointerout', (e) => {
  if (!e.relatedTarget) { clearTimeout(matchClear); setMatch(null); }
});

function renderMeld(meld) {
  const g = el('div', 'meld');
  for (const t of meld.tiles) g.append(renderTile(t));
  return g;
}

// A player's face-up tiles, one set per row: flowers/seasons share the top row,
// then each meld gets its own row beneath it.
function renderPlayed(container, p) {
  if (p.flowers && p.flowers.length) {
    const row = el('div', 'played-row');
    for (const f of p.flowers) row.append(renderTile(f));
    container.append(row);
  }
  for (const m of p.melds) container.append(renderMeld(m));
}

// -------- tile size — independent knobs per category, saved per browser --------
// All four knobs now scale the SAME canonical tile, so a percentage means one
// physical size wherever it is spent — 90% played really is smaller than 95%
// discards. The floor drops to 20% because opponents' face-down tiles, which
// carry no information, sit far below the others on that shared scale.
const SZ_MIN = 0.2, SZ_MAX = 2.0, SZ_STEP = 0.05;
const SZ_KEYS = ['hand', 'ohand', 'played', 'disc'];
// Starting sizes for a player who hasn't touched the Size sliders: your own hand
// and the melds/pond a little larger than life, opponents' face-down tiles smaller
// since they carry no information. These render pixel-for-pixel like the old
// 130/80/150/150 did before the categories shared a scale.
const SZ_DEFAULT = { hand: 1.3, ohand: 0.3, played: 0.9, disc: 0.9 };
// Old saved sizes were multiples of each category's own tile (hand 40x52,
// discards 25x33, melds 24x32, opponents' hands 15x20). Convert them once so a
// returning player's table looks exactly as they left it.
// Discards use the MELD ratio, not their own 25/40: the old discard and meld
// tiles were within 4% of each other, and landing both on the same number is
// the whole point of a shared scale.
const SZ_MIGRATE = { hand: 1, ohand: 15 / 40, played: 24 / 40, disc: 24 / 40 };
const clampSize = (v) => Math.min(SZ_MAX, Math.max(SZ_MIN, v));
function loadSize(key) {
  try {
    const v = parseFloat(localStorage.getItem(`mjg-ts2-${key}`));
    if (Number.isFinite(v)) return clampSize(v);
    const old = parseFloat(localStorage.getItem(`mjg-ts-${key}`));
    if (Number.isFinite(old)) {
      const conv = Math.round(clampSize(Math.round(old * SZ_MIGRATE[key] / SZ_STEP) * SZ_STEP) * 100) / 100;
      try { localStorage.setItem(`mjg-ts2-${key}`, String(conv)); } catch {}
      return conv;
    }
  } catch {}
  return SZ_DEFAULT[key] ?? 1;
}
const sizes = { hand: loadSize('hand'), ohand: loadSize('ohand'), played: loadSize('played'), disc: loadSize('disc') };

function applySizes() {
  const g = $('#screen-game');
  if (g) {
    g.style.setProperty('--ts-hand', sizes.hand);
    g.style.setProperty('--ts-ohand', sizes.ohand);
    g.style.setProperty('--ts-played', sizes.played);
    g.style.setProperty('--ts-disc', sizes.disc);
  }
  for (const k of SZ_KEYS) {
    const inp = $(`#sz-${k}`); if (inp) inp.value = sizes[k];
    const lbl = $(`#sz-${k}-v`); if (lbl) lbl.textContent = `${Math.round(sizes[k] * 100)}%`;
  }
  relayout();
}

function setSize(k, v) { sizes[k] = v; try { localStorage.setItem(`mjg-ts2-${k}`, String(v)); } catch {} applySizes(); }

// -------- seat shape: chosen from the WINDOW, never from the tiles on it -----
// A quadrant is the pond plus the played sets. Wide enough and they sit side by
// side, which wants a deep 6-wide pond and a narrow 2-meld sets column. Once
// they have to stack, that shape is wrong: it leaves the quadrant tall and
// half the column empty. So when stacked we spread instead — the pond goes
// 12x2 or 8x3, the sets take three or four melds to a row — and the quadrant
// gets much shorter.
//
// Everything below depends only on the window width, the size knobs and the
// ruleset. It deliberately does NOT look at how many tiles anyone has played,
// so the table re-shapes when you resize the window and at no other time.
const TILE_W = 40, TILE_GAP = 2, MELD_TILES = 4, POND_TILES = 24, FLOWER_TILES = 8;
const POND_SHAPES = [12, 8, 6];     // columns, widest first
const MELDS_PER_ROW = [5, 4, 3, 2]; // widest first

// Greedy pack of the worst case (flowers block, then every meld) into a row
// `widthTiles` wide — the same order flex lays them out in, so the reserved
// height always covers the fullest a seat can get.
function packedRows(widthTiles, maxMelds, hasFlowers) {
  const items = hasFlowers ? [FLOWER_TILES] : [];
  for (let i = 0; i < maxMelds; i++) items.push(MELD_TILES);
  let rows = 1, used = 0;
  for (const it of items) {
    if (used && used + it > widthTiles) { rows++; used = it; } else { used += it; }
  }
  return rows;
}

let layoutVariant = 'tw';
function relayout() {
  const g = $('#screen-game');
  if (!g) return;
  const maxMelds = layoutVariant === 'tw' ? 5 : 4;
  const hasFlowers = layoutVariant !== 'jp';
  const base = parseFloat(getComputedStyle(g).getPropertyValue('--ts-base')) || 1;
  const pw = TILE_W * base * sizes.played;  // one played tile, in px
  const dw = TILE_W * base * sizes.disc;    // one discard tile, in px

  // Width a single quadrant's CONTENT gets: the grid track less the seat's own
  // padding, which is the turn halo's reserved room (see .seat in style.css).
  // The track is minmax(0, --seat-max) so it never depends on what's inside it —
  // measuring is exact and, unlike arithmetic on innerWidth, already accounts for
  // the page's scrollbar. Fall back to the arithmetic (92px centre column,
  // 2 x 8px gaps, 2 x 4px table padding) while the table is still hidden.
  const seatEl = $('.seat-tl');
  const seatCs = seatEl && getComputedStyle(seatEl);
  const pad = seatCs ? (parseFloat(seatCs.paddingLeft) + parseFloat(seatCs.paddingRight)) || 0 : 8;
  const measured = seatEl ? seatEl.clientWidth - pad : 0;
  const vw = document.body.clientWidth || window.innerWidth;
  const seat = measured > 0 ? measured : (vw - 92 - 16 - 8) / 2 - pad;

  const pondW = (cols) => cols * dw + (cols - 1) * TILE_GAP + 6;
  const pondH = (rows) => rows * 52 * base * sizes.disc + (rows - 1) * TILE_GAP + 6;
  const setsW = (melds) => melds * MELD_TILES * pw + (5 * melds - 2);
  const setsTiles = (melds) => melds * MELD_TILES;
  const flowersW = FLOWER_TILES * pw + (FLOWER_TILES - 1);

  // Beside a 4-deep pond the sets get four rows for free, so use them: take the
  // NARROWEST column that still stacks up inside the pond's depth. Riichi has
  // four melds and no flowers, so one meld a row is enough and the quadrant ends
  // up half as wide; Hong Kong and Taiwanese need eight tiles for the flower row
  // whatever happens.
  const POND_DEPTH = 4;
  const minMelds = hasFlowers ? 2 : 1;
  let narrow = maxMelds;
  for (let m = minMelds; m <= maxMelds; m++) {
    if (packedRows(setsTiles(m), maxMelds, hasFlowers) <= POND_DEPTH) { narrow = m; break; }
  }

  let pondCols = 6, melds = narrow, floor = pondH(POND_DEPTH);
  if (pondW(6) + 4 + Math.max(setsW(narrow), hasFlowers ? flowersW : 0) > seat) {
    // stacked: no pond to sit beside any more, so spread wide and stay shallow
    pondCols = POND_SHAPES.find((c) => pondW(c) <= seat) ?? 6;
    melds = MELDS_PER_ROW.find((m) => setsW(m) <= seat) ?? 2;
    floor = 0;
  }

  const set = (k, v) => { if (g.style.getPropertyValue(k) !== String(v)) g.style.setProperty(k, v); };
  set('--pond-cols', pondCols);
  set('--pond-rows', Math.ceil(POND_TILES / pondCols));
  set('--played-cols', setsTiles(melds));
  set('--played-gaps', 5 * melds - 2);
  set('--played-rows', packedRows(setsTiles(melds), maxMelds, hasFlowers));
  // Side by side, the sets box is floored to the pond's height. The rows pack to
  // its top (align-content: flex-start) and the box's bottom is pinned to the
  // pond's, so the first set always starts level with the first discard however
  // few rows a ruleset can produce. The extra height is empty and invisible.
  set('--sets-floor', `${Math.round(floor * 100) / 100}px`);
  // How far a concealed hand may reach past its pond. Side by side that is the
  // whole board — the band above the sets column is empty, so the hand grows
  // into it; stacked, it is the slack beside the centred pond.
  const pw2 = pondW(pondCols);
  const handMax = floor > 0 ? pw2 + 4 + setsW(melds) : pw2 + Math.max(0, (seat - pw2) / 2);
  set('--hand-max', `${Math.round(handMax * 100) / 100}px`);

  // The table is a set of capped, centred columns, so at a wide window there is
  // dead felt to the right of your quadrant. Measure it and let your region's
  // backdrop run out into it, rather than leaving a panel floating in the gap.
  // Window width is the only thing this depends on, which is exactly when
  // relayout runs.
  const zone = $('#my-zone');
  const zr = zone && zone.getBoundingClientRect();
  set('--bleed-right', `${zr ? Math.round(Math.max(0, vw - zr.right)) : 0}px`);
  // Where the quadrant's left edge falls. The strip below starts at the window
  // edge, so this is also the width of the step between them — the one segment
  // of the region's outline that neither box can draw by itself.
  set('--zone-left', `${zr ? Math.round(Math.max(0, zr.left)) : 0}px`);
}

let relayoutPending = false;
function scheduleRelayout() {
  if (relayoutPending) return;
  relayoutPending = true;
  requestAnimationFrame(() => { relayoutPending = false; relayout(); });
}
window.addEventListener('resize', scheduleRelayout);

// ---------------------------------------------------------------- chat

let chatUnread = 0;
let peekTimer = null;

function chatSetVisible(v) { $('#chat').classList.toggle('hidden', !v); }

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
    el('span', `chat-name s${(m.seat || 0) % 4}`, m.name || '?'),
    el('span', 'chat-text', m.text.length > 90 ? `${m.text.slice(0, 90)}…` : m.text),
  );
  peek.classList.remove('hidden');
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => peek.classList.add('hidden'), 6000);
}

function fmtChatTime(ts) { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

function addChatMsg(m, self) {
  const box = $('#chat-msgs');
  const row = el('div', `chat-msg${self ? ' mine' : ''}`);
  row.append(el('span', `chat-name s${(m.seat || 0) % 4}`, m.name || '?'));
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

const chatBubbles = new Map();
let bubbleId = 0;
const MAX_BUBBLES = 4; // per seat; a new one pushes the oldest out (~3.5 shown)

function paintChatBubbles() {
  let layer = document.querySelector('#bubble-layer');
  if (!layer) { layer = el('div', ''); layer.id = 'bubble-layer'; document.body.append(layer); }
  const seen = new Set();
  for (const [seat, arr] of chatBubbles) {
    const host = document.querySelector(`.seat[data-seat="${seat}"]`) || (seat === lastView?.mySeat ? $('#my-zone') : null);
    if (!host || !host.offsetParent) continue;
    const key = String(seat);
    seen.add(key);
    let stack = layer.querySelector(`.bubble-stack[data-seat="${key}"]`);
    if (!stack) { stack = el('div', 'bubble-stack'); stack.dataset.seat = key; layer.append(stack); }
    // Append-only in chronological order (oldest → newest). Existing bubbles are
    // never moved or recreated, so they don't re-run the entrance animation
    // (no blink). CSS (column + justify-end) keeps the newest at the bottom by
    // the seat and clips the oldest at the top once the cap is reached.
    const kept = new Set();
    for (const b of arr) {
      const bid = String(b.id);
      kept.add(bid);
      if (!stack.querySelector(`.chat-bubble[data-id="${bid}"]`)) {
        const bub = el('div', 'chat-bubble', b.text);
        bub.dataset.id = bid;
        if (b.say) bub.classList.add('say');
        stack.append(bub);
      }
    }
    for (const n of stack.querySelectorAll('.chat-bubble')) { if (!kept.has(n.dataset.id)) n.remove(); }
    // anchor the stack's bottom just above the seat; it grows upward, capped at
    // ~3.5 bubbles and never allowed under the top bar
    const r = host.getBoundingClientRect();
    const bottomEdge = r.top - 8;
    const unit = 26;                       // ~ one bubble incl. gap
    const avail = bottomEdge - 46;         // 46 ≈ bottom of the top bar
    const maxH = Math.max(unit, Math.min(3.5 * unit, avail));
    stack.style.left = `${Math.round(r.left + r.width / 2)}px`;
    stack.style.top = 'auto';
    stack.style.bottom = `${Math.round(window.innerHeight - bottomEdge)}px`;
    stack.style.maxHeight = `${Math.round(maxH)}px`;
  }
  for (const n of layer.querySelectorAll('.bubble-stack')) { if (!seen.has(n.dataset.seat)) n.remove(); }
}

function showChatBubble(m) {
  if (m.seat == null) return;
  const arr = chatBubbles.get(m.seat) || [];
  const id = ++bubbleId;
  const trunc = cfg.raw('bubbleTrunc');
  const text = m.text.length > trunc ? m.text.slice(0, trunc) + '…' : m.text;
  arr.push({ id, text, say: !!m.say });
  while (arr.length > MAX_BUBBLES) arr.shift(); // newest pushes oldest out
  chatBubbles.set(m.seat, arr);
  paintChatBubbles();
  const ms = m.say ? cfg('bubbleSay') : cfg('bubbleChat');
  setTimeout(() => {
    const a = chatBubbles.get(m.seat);
    if (a) {
      const idx = a.findIndex((b) => b.id === id);
      if (idx >= 0) a.splice(idx, 1);
      if (a.length === 0) chatBubbles.delete(m.seat);
    }
    paintChatBubbles();
  }, ms);
}

function clearChatBubbles() {
  for (const [, arr] of chatBubbles) arr.length = 0;
  chatBubbles.clear();
  paintChatBubbles();
}

// -------- claim calls & flying discards ------------------------------------
function seatHost(seat) {
  return document.querySelector(`.seat[data-seat="${seat}"]`) || (seat === lastView?.mySeat ? $('#my-zone') : null);
}
function fxLayer() {
  let layer = document.querySelector('#fx-layer');
  if (!layer) { layer = el('div', ''); layer.id = 'fx-layer'; document.body.append(layer); }
  return layer;
}

// big PON/CHI/KAN/RON call, centred over the claiming player's quadrant
function showCall(seat, text) {
  const host = seatHost(seat);
  if (!host || !host.offsetParent) return;
  const word = String(text).replace(/[^a-z]/gi, '').toLowerCase();
  const r = host.getBoundingClientRect();
  const call = el('div', `call-fx call-${word}`, word.toUpperCase());
  call.style.left = `${Math.round(r.left + r.width / 2)}px`;
  call.style.top = `${Math.round(r.top + r.height / 2)}px`;
  fxLayer().append(call);
  setTimeout(() => call.remove(), 1500);
}

// animate the centre discard tile flying in from the discarder's quadrant, so
// it's obvious who threw it; it then rests in the centre (rendered from
// view.lastDiscard) until it's claimed or the next player draws
function flyTileIn(tile, container, fromSeat) {
  const host = seatHost(fromSeat);
  if (!host || !host.offsetParent) return;
  const hr = host.getBoundingClientRect();
  const cr = container.getBoundingClientRect();
  const dx = Math.round((hr.left + hr.width / 2) - (cr.left + cr.width / 2));
  const dy = Math.round((hr.top + hr.height / 2) - (cr.top + cr.height / 2));
  // hold back the resting box until the tile lands, otherwise an empty shadowed
  // panel sits at the centre for the whole flight
  container.classList.add('flying');
  clearTimeout(container._flyTimer);
  container._flyTimer = setTimeout(() => container.classList.remove('flying'), FLY_MS);
  tile.style.transition = 'none';
  tile.style.transform = `translate(${dx}px, ${dy}px) scale(.72)`;
  void tile.offsetWidth; // reflow so the transition runs
  tile.style.transition = `transform ${FLY_MS}ms ease-out`;
  tile.style.transform = 'translate(0,0) scale(1)';
}

// ---------------------------------------------------------------- rejoin

function saveRejoin(code, token) { try { sessionStorage.setItem(`mjg-rejoin-${code}`, token); } catch {} }
function loadRejoin(code) { try { return sessionStorage.getItem(`mjg-rejoin-${code}`); } catch {} return null; }
function clearRejoin(code) { try { sessionStorage.removeItem(`mjg-rejoin-${code}`); } catch {} }

// PeerJS refuses any JSON message of 16300 bytes or more: it logs the refusal
// and drops it, so an oversized view strands a guest with a frozen board and no
// error visible at either end. Nothing sent now comes near that — the advice a
// player reads is worked out on their own machine rather than shipped to them —
// but four full ponds late in a hand are not nothing, so say so loudly if it
// ever creeps back up rather than letting a table quietly stop.
const WIRE_WARN = 15000;
let warnedWire = false;

function wireCheck(view) {
  if (!warnedWire && new TextEncoder().encode(JSON.stringify(view)).length >= WIRE_WARN) {
    warnedWire = true;
    console.warn('[mahjong] state message is approaching the 16300-byte limit PeerJS drops at');
  }
  return view;
}

// ---------------------------------------------------------------- host session

let session = null;
let lastView = null;
let lastSess = null;
let pendingMove = false;
// Claims you've told the table to stop offering. A call you don't want tends to
// come back every time that tile is thrown, so each one can be waved away for
// the rest of the hand — keyed by the SET it would make, not by the button, so
// muting "Chi 1m+2m" doesn't also mute "Chi 2m+4m" on the same tile. Cleared on
// every new deal, since the next hand is a different problem.
let claimMuted = new Set();
let claimMutedHand = null;
const ponMuteKey = (t) => `pon:${t ? t.key : '?'}`;
const kanMuteKey = (t) => `kan:${t ? t.key : '?'}`;
const chiMuteKey = (combo, t) => `chi:${[...combo.map((x) => x.key), t ? t.key : '?'].sort().join('+')}`;
let selectedTile = null;
let handOrder = [];   // tile-id display order for my hand (drag to rearrange)
let drawnPin = null;  // the drawn tile parked on the end until the discard lands
let lastHandSeen = -1; // reset handOrder on a new hand (tile ids are reused each deal)
let shownDiscardId = null; // the tile currently resting in the centre (fly it in only once)

class HostSession {
  constructor(peer, code, name) {
    this.isHost = true;
    this.peer = peer;
    this.code = code;
    this.conns = new Map();
    this.watchers = [];
    this.wid = 0;
    this.roster = [{ seat: 0, name, connected: true, token: genCode(12) }];
    this.G = null;
    this.chatLog = [];
    this.selectedVariant = 'tw';
    this.botTimer = null;
    this.claimTimer = null;
    this.stepPending = false;

    peer.on('connection', (conn) => {
      conn.on('open', () => {
        conn.on('data', (msg) => this.onMsg(conn, msg));
        conn.on('close', () => this.drop(conn));
        conn.on('error', () => this.drop(conn));
      });
    });

    this.pushLobby();
  }

  onMsg(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'join') return this.join(conn, msg);
    if (msg.t === 'move') {
      const seat = conn._seat;
      if (seat != null && this.G) this.move(seat, msg.move);
      return;
    }
    if (msg.t === 'chat') {
      const seat = conn._seat;
      if (seat == null) return;
      const p = this.roster.find((r) => r.seat === seat);
      if (!p) return;
      const text = cleanName(msg.text);
      if (!text) return;
      const m = { seat, name: p.name, text, ts: Date.now() };
      this.chatLog.push(m);
      if (this.chatLog.length > 100) this.chatLog.shift();
      for (const [, c] of this.conns) { try { c.send({ t: 'chat', msg: m }); } catch {} }
      addChatMsg(m, false);
    }
    if (msg.t === 'next' && conn._seat === 0) return; // only host can advance via UI
  }

  join(conn, msg) {
    const deny = (reason) => { try { conn.send({ t: 'deny', reason }); } catch {} setTimeout(() => { try { conn.close(); } catch {} }, 400); };
    if (conn._seat != null) return;
    if (msg.v !== PROTO) return deny('version');
    if (msg.token) {
      const back = this.roster.find((r) => r.token && r.token === msg.token);
      if (back) return this.reattach(conn, back);
    }
    if (this.G || this.roster.length >= NUM_PLAYERS) return this.attachWatcher(conn, msg);
    let seat = 0;
    while (this.roster.some((p) => p.seat === seat)) seat++;
    const name = cleanName(msg.name) || `Player ${seat + 1}`;
    conn._seat = seat;
    this.conns.set(seat, conn);
    const token = genCode(12);
    this.roster.push({ seat, name, connected: true, token });
    try { conn.send({ t: 'welcome', seat, code: this.code, token }); } catch {}
    toast(`${name} joined`);
    this.pushLobby();
  }

  reattach(conn, p) {
    const old = this.conns.get(p.seat);
    if (old && old !== conn) { old._seat = null; try { old.close(); } catch {} }
    conn._seat = p.seat;
    this.conns.set(p.seat, conn);
    p.connected = true;
    try { conn.send({ t: 'welcome', seat: p.seat, code: this.code, token: p.token }); } catch {}
    if (this.G) { markReconnected(this.G, p.seat); this.broadcast(); } else this.pushLobby();
  }

  drop(conn) {
    if (conn._watcher != null) {
      this.watchers = this.watchers.filter((x) => x.id !== conn._watcher);
      conn._watcher = null;
      return;
    }
    const seat = conn._seat;
    if (seat == null) return;
    conn._seat = null;
    this.conns.delete(seat);
    const p = this.roster.find((r) => r.seat === seat);
    if (!p) return;
    if (!this.G) { this.roster = this.roster.filter((r) => r.seat !== seat); this.pushLobby(); }
    else { p.connected = false; markDisconnected(this.G, seat); this.broadcast(); }
  }

  attachWatcher(conn, msg) {
    const name = cleanName(msg.name) || 'Watcher';
    const id = ++this.wid;
    conn._watcher = id;
    const target = this.roster.length ? this.roster[0].seat : 0;
    this.watchers.push({ id, name, conn, target });
    try {
      conn.send({ t: 'welcome', observer: true, code: this.code });
      if (this.G) conn.send({ t: 'state', view: viewFor(this.G, target, this.code, viewOpts()) });
    } catch {}
  }

  pushLobby() {
    const data = { t: 'lobby', roster: this.roster.map((r) => ({ seat: r.seat, name: r.name, bot: !!r.bot })), variant: this.selectedVariant };
    for (const [, conn] of this.conns) { try { conn.send(data); } catch {} }
    renderLobby(this);
  }

  addBot() {
    if (this.roster.length >= NUM_PLAYERS) return;
    let seat = 0;
    while (this.roster.some((p) => p.seat === seat)) seat++;
    const name = BOT_NAMES[seat % BOT_NAMES.length];
    this.roster.push({ seat, name, bot: true, connected: true });
    this.pushLobby();
  }

  removeBot(seat) {
    this.roster = this.roster.filter((r) => r.seat !== seat || !r.bot);
    this.pushLobby();
  }

  setVariant(key) {
    if (VARIANTS.some((v) => v.key === key)) { this.selectedVariant = key; this.pushLobby(); }
  }

  start() {
    if (this.roster.length < NUM_PLAYERS) return;
    this.G = newMatch(this.roster, this.selectedVariant);
    saveRejoin(this.code, this.roster[0].token);
    this.broadcast();
  }

  broadcast() {
    if (!this.G) return;
    const wnames = this.watchers.map((x) => x.name);
    for (const [seat, conn] of this.conns) {
      try { conn.send({ t: 'state', view: wireCheck({ ...viewFor(this.G, seat, this.code, viewOpts()), watchers: wnames }) }); } catch {}
    }
    for (const w of this.watchers) {
      try { w.conn.send({ t: 'state', view: wireCheck({ ...viewFor(this.G, w.target, this.code, viewOpts()), watchers: wnames }) }); } catch {}
    }
    pendingMove = false;
    selectedTile = null;
    showScreen('game');
    renderGame({ ...viewFor(this.G, 0, this.code, viewOpts()), watchers: wnames }, this);
    this.scheduleBots();
    this.scheduleClaimTimeout();
  }

  move(seat, move) {
    if (!this.G) return false;
    const res = applyMove(this.G, seat, move);
    if (!res.ok) {
      // Re-render from the engine, NOT from lastView: if the two had drifted
      // apart, repainting the stale view would leave the board insisting it is
      // still your turn and every retry would be refused the same way.
      if (seat === 0) { pendingMove = false; toast(res.error); renderGame(viewFor(this.G, 0, this.code, viewOpts()), this); }
      else {
        // same reasoning for a guest: send the reason, then the real state, so a
        // claim that was refused because the window had already closed doesn't
        // leave them staring at buttons the engine will keep rejecting
        const c = this.conns.get(seat);
        try { c?.send({ t: 'err', error: res.error }); } catch {}
        try { c?.send({ t: 'state', view: wireCheck({ ...viewFor(this.G, seat, this.code, viewOpts()), watchers: this.watchers.map((x) => x.name) }) }); } catch {}
      }
      return false;
    }
    // hold the next bot action until the discard has finished flying (+ the
    // configurable pause), so nothing happens on top of the animation
    if (move.kind === 'discard') this.botNotBefore = Date.now() + FLY_MS + cfg('postFlyDelay');
    this.broadcast();
    return true;
  }

  localMove(move) { this.move(0, move); }

  localNext() { this.move(0, { kind: 'next' }); }

  scheduleBots() {
    clearTimeout(this.botTimer);
    this.stepPending = false;
    if (!this.G || this.G.phase === 'over' || this.G.phase === 'handEnd') { paintStep(); return; }
    // stepping: don't set a timer at all, just mark that a bot is holding and
    // wait to be nudged. Only advertise it when a bot actually HAS something to
    // do, so the prompt never appears while the table is waiting on you.
    if (cfg.on('stepBots')) {
      this.stepPending = this.G.players.some((p) => (p.bot || p.botFor) && botChoose(this.G, p.seat));
      paintStep();
      return;
    }
    paintStep();
    // never act before a just-discarded tile has finished flying
    const flyWait = Math.max(0, (this.botNotBefore || 0) - Date.now());
    const delay = Math.max(cfg.range('botDelay'), flyWait);
    this.botTimer = setTimeout(() => this.tickBots(), delay);
  }

  // one click, one bot action
  step() {
    if (!this.stepPending) return;
    this.stepPending = false;
    paintStep();
    this.tickBots();
  }

  tickBots() {
    if (!this.G) return;
    for (const p of this.G.players) {
      if (!p.bot && !p.botFor) continue;
      const move = botChoose(this.G, p.seat);
      if (!move) continue;                 // this bot is waiting (e.g. a gated claim)
      // a successful move re-broadcasts (which reschedules the bots); a rejected
      // one must NOT strand the loop, so fall through and keep the timer alive
      if (this.move(p.seat, move)) return;
    }
    // no bot advanced this tick — if a claim is still open, check again shortly so
    // a still-pending (or just-un-gated) player gets another chance to respond
    if (this.G.phase === 'claim' && this.G.claimPhase
        && !this.G.claimPhase.eligible.every((e) => e.response !== null)) {
      this.scheduleBots();
    }
  }

  scheduleClaimTimeout() {
    clearTimeout(this.claimTimer);
    if (!this.G || this.G.phase !== 'claim') return;
    const ms = cfg('claimTimeout');
    if (!ms || ms <= 0) return; // 0 = wait indefinitely for a response
    this.claimTimer = setTimeout(() => {
      if (!this.G || this.G.phase !== 'claim' || !this.G.claimPhase) return;
      // auto-pass for anyone who hasn't responded
      for (const e of this.G.claimPhase.eligible) {
        if (!e.response) this.move(e.seat, { kind: 'pass' });
      }
    }, ms);
  }

  destroy() {
    clearTimeout(this.botTimer);
    clearTimeout(this.claimTimer);
    // drop the game too: any handler still holding a reference to this session
    // (a DOM node that outlived the room) then becomes a no-op instead of
    // driving a finished game's engine
    this.G = null;
    try { this.peer.destroy(); } catch {}
  }
}

// ---- guest session

class GuestSession {
  constructor(peer, code, name, resume = null) {
    this.isHost = false;
    this.peer = peer;
    this.code = code;
    this.name = name;
    this.seat = null;
    this.token = (resume && resume.token) || loadRejoin(code);
    this.joined = false;
    this.closed = false;
    const conn = peer.connect(ID_PREFIX + code, { reliable: true, serialization: 'json' });
    this.conn = conn;
    conn.on('open', () => {
      conn.send({ t: 'join', v: PROTO, name, token: this.token || undefined });
    });
    conn.on('data', (msg) => this.onMsg(msg));
    conn.on('close', () => { if (!this.closed) guestGone(code, 'The host closed the connection.'); });
    conn.on('error', () => { if (!this.closed) guestGone(code, 'Connection error.'); });
  }

  onMsg(msg) {
    if (!msg) return;
    if (msg.t === 'welcome') {
      this.seat = msg.seat;
      this.joined = true;
      if (msg.token) { this.token = msg.token; saveRejoin(this.code, msg.token); }
      if (msg.observer) toast('Room full — watching');
    }
    if (msg.t === 'deny') {
      this.closed = true;
      try { this.peer.destroy(); } catch {}
      session = null;
      setHomeStatus(msg.reason === 'version' ? 'Version mismatch — refresh the page.' : `Denied: ${msg.reason}`, true);
      showScreen('home');
      setBusy(false);
      return;
    }
    if (msg.t === 'lobby') renderLobby(this, msg);
    if (msg.t === 'state') {
      // Authoritative state has landed, so whatever I was waiting on is done.
      // Without this the flag latches on my first move and every later click is
      // silently swallowed — one move per guest, then a frozen table.
      pendingMove = false;
      selectedTile = null;
      showScreen('game');
      renderGame(msg.view, this);
    }
    if (msg.t === 'err') {
      // a refused move must unlock too, or the retry can never be sent
      pendingMove = false;
      toast(msg.error);
      if (lastView) renderGame(lastView, this);
    }
    if (msg.t === 'chat') addChatMsg(msg.msg, msg.msg.seat === this.seat);
    if (msg.t === 'chatlog') { for (const m of msg.items) addChatMsg(m, m.seat === this.seat); }
  }

  localMove(move) {
    try { this.conn.send({ t: 'move', move }); } catch {}
  }

  localNext() { this.localMove({ kind: 'next' }); }

  destroy() {
    this.closed = true;
    try { this.peer.destroy(); } catch {}
  }
}

function guestGone(code, why) {
  session = null;
  setHomeStatus(why, true);
  showScreen('home');
  setBusy(false);
}

// ---------------------------------------------------------------- render: lobby

function renderLobby(sess, lobbyMsg) {
  showScreen('lobby');
  const isHost = sess.isHost;
  const roster = isHost ? sess.roster : (lobbyMsg && lobbyMsg.roster) || [];
  const variant = isHost ? sess.selectedVariant : (lobbyMsg && lobbyMsg.variant) || 'tw';

  $('#lobby-code').textContent = sess.code;
  // Always render NUM_PLAYERS seats (filled or "Open seat") so the list height
  // stays constant — adding a bot fills a slot instead of growing the panel.
  const list = $('#lobby-players');
  list.replaceChildren();
  const bySeat = [...roster].sort((a, b) => a.seat - b.seat);
  for (let i = 0; i < NUM_PLAYERS; i++) {
    const p = bySeat[i];
    const li = el('li', p ? '' : 'empty');
    if (p) {
      li.append(avatarEl(p.name, p.seat, p.bot));
      li.append(el('span', 'p-name', p.name));
      if (p.bot && isHost) {
        const rm = el('button', 'btn ghost seat-remove', '✕');
        rm.addEventListener('click', () => sess.removeBot(p.seat));
        li.append(rm);
      }
    } else {
      li.append(el('div', 'av empty-av'));
      li.append(el('span', 'p-name empty-label', 'Open seat'));
    }
    list.append(li);
  }

  // variant picker
  const picker = $('#variant-picker');
  picker.replaceChildren();
  for (const v of VARIANTS) {
    const chip = el('div', `chip${v.key === variant ? ' active' : ''}`, v.name);
    if (isHost) chip.addEventListener('click', () => sess.setVariant(v.key));
    picker.append(chip);
  }
  $('#variant-blurb').textContent = variantByKey(variant).blurb;

  // buttons
  const canAdd = isHost && roster.length < NUM_PLAYERS;
  const canStart = isHost && roster.length === NUM_PLAYERS;
  $('#btn-add-bot').classList.toggle('hidden', !canAdd);
  $('#btn-start').classList.toggle('hidden', !canStart);
  $('#lobby-hint').textContent = roster.length < NUM_PLAYERS ? `Need ${NUM_PLAYERS - roster.length} more player${roster.length < 3 ? 's' : ''}.` : isHost ? 'Ready to start!' : 'Waiting for the host…';
}

// ---------------------------------------------------------------- render: game

let seenFxSeq = 0;
let chatSeenN = 0;

function renderGame(view, sess) {
  lastView = view;
  lastSess = sess;
  const handKey = `${view.roundWind}${view.handNum}.${view.honba}`;
  if (handKey !== claimMutedHand) { claimMutedHand = handKey; claimMuted = new Set(); }
  const my = view.mySeat;

  // a new hand reuses tile ids from the previous hand, so drop the old drag
  // order — otherwise the fresh hand inherits last hand's arrangement (unsorted)
  if (view.handNum !== lastHandSeen) { handOrder = []; drawnPin = null; lastHandSeen = view.handNum; }

  // topbar
  $('#room-chip').textContent = view.code;

  // 2x2 seat mapping (me = bottom-right): TL = across (+2), TR = right/next (+1),
  // BL = left/prev (+3) — counter-clockwise BR -> TR -> TL -> BL
  const seatOrder = [(my + 2) % 4, (my + 1) % 4, (my + 3) % 4];
  const seatEls = ['.seat-tl', '.seat-tr', '.seat-bl'];

  for (let i = 0; i < 3; i++) {
    const s = seatOrder[i];
    const p = view.players.find((q) => q.seat === s);
    const el_ = $(seatEls[i]);
    el_.dataset.seat = s;
    el_.classList.toggle('active-turn', !!p && s === view.turn && view.phase !== 'over');
    el_.querySelector('.seat-name').textContent = p ? p.name : '';
    const wind = WINDS[(s - view.dealer + 4) % 4];
    const windEl = el_.querySelector('.seat-wind');
    windEl.textContent = wind;
    windEl.classList.toggle('dealer', s === view.dealer);
    el_.querySelector('.seat-score').textContent = p ? `${p.score}` : '';

    // concealed hand (face-down), so each seat looks like a real player
    const handFd = el_.querySelector('.seat-hand');
    if (handFd) {
      handFd.replaceChildren();
      // p.hand holds nulls while the hand is live and real tiles once it is
      // over, so the same call renders face-down backs or the revealed hand
      if (p) for (let k = 0; k < p.tileCount; k++) handFd.append(renderTile(p.hand[k] || null));
    }

    // played: flowers first, then melds (sets)
    const playedEl = el_.querySelector('.seat-played');
    playedEl.replaceChildren();
    if (p) renderPlayed(playedEl, p);

    // discards
    const discEl = el_.querySelector('.seat-discards');
    discEl.replaceChildren();
    if (p) {
      for (const t of p.discards) {
        if (view.lastDiscard && t.id === view.lastDiscard.id) continue; // resting in the centre
        discEl.append(renderTile(t, { riichi: t.riichi }));
      }
    }
  }

  // The seat's shape depends on the ruleset (how many melds and whether there
  // are flowers) but never on what has actually been played — relayout only
  // rewrites a property when the value really changed, so a discard or a meld
  // never nudges the layout.
  if (view.variant !== layoutVariant) { layoutVariant = view.variant; }
  relayout();

  // center info: round (prevailing wind + hand number) and tiles left in the wall
  const roundName = { E: 'East', S: 'South', W: 'West', N: 'North' }[view.roundWind] || view.roundWind;
  $('#round-wind-display').textContent = `${roundName} ${view.handNum}`;
  $('#wall-display').replaceChildren(term('wall', `${view.wallCount} left`));

  // whose turn it is: only ever announce MY turn in the centre. For opponents the
  // gold halo around their quadrant is the cue, so no label is shown.
  const turnLabel = $('#turn-label');
  if (view.turn === my && (view.phase === 'discard' || view.phase === 'draw')) {
    turnLabel.replaceChildren(el('span', 'tl-text', 'Your turn'));
    turnLabel.className = 'mine';
  } else {
    turnLabel.replaceChildren();
    turnLabel.className = '';
  }
  const doraEl = $('#dora-display');
  doraEl.replaceChildren();
  if (view.dora && view.dora.length > 0) {
    // Label above, indicators in a row beneath. Inline, a second indicator (one
    // turns up for every kan) wrapped onto its own line and read as a stray tile
    // sitting in the middle of the table rather than as dora.
    doraEl.append(term('dora', view.dora.length > 1 ? `Dora \u00d7${view.dora.length}` : 'Dora'));
    const row = el('div', 'dora-tiles');
    for (const d of view.dora) row.append(renderTile(d));
    doraEl.append(row);
  }
  const sticksEl = $('#sticks-display');
  sticksEl.replaceChildren();
  if (view.riichiSticks > 0) sticksEl.append(term('riichisticks', `${view.riichiSticks} riichi`));
  if (view.honba > 0) {
    if (view.riichiSticks > 0) sticksEl.append(el('span', '', ' '));
    sticksEl.append(term('honba', `${view.honba} honba`));
  }

  // the just-discarded tile rests in the centre until it's claimed or the next
  // player draws (view.lastDiscard is cleared on both); fly it in only once
  const ldEl = $('#last-discard');
  const ldId = view.lastDiscard ? view.lastDiscard.id : null;
  if (ldId !== shownDiscardId) {
    shownDiscardId = ldId;
    ldEl.replaceChildren();
    ldEl.classList.remove('flying');
    if (view.lastDiscard) {
      const tile = renderTile(view.lastDiscard, { highlight: true });
      ldEl.append(tile);
      flyTileIn(tile, ldEl, view.lastDiscardSeat);
    }
  }

  // my zone
  const me = view.players.find((q) => q.seat === my);
  const myTurn = my === view.turn && view.phase !== 'over';
  $('#my-zone').classList.toggle('active-turn', myTurn);
  // the halo traces the whole region, so the strip has to know as well
  $('#screen-game').classList.toggle('my-turn', myTurn);
  const nameEl = $('#my-name');
  nameEl.replaceChildren();
  if (me) { nameEl.append(el('span', '', me.name), el('span', 'you-chip', 'YOU')); }
  const myWind = WINDS[(my - view.dealer + 4) % 4];
  const myWindEl = $('#my-wind');
  myWindEl.textContent = myWind;
  myWindEl.className = 'seat-wind' + (my === view.dealer ? ' dealer' : '');
  $('#my-score').textContent = me ? `${me.score}` : '';

  // my discards (nearest the centre)
  const myDisc = $('#my-discards');
  myDisc.replaceChildren();
  if (me) {
    for (const t of me.discards) {
      if (view.lastDiscard && t.id === view.lastDiscard.id) continue; // resting in the centre
      myDisc.append(renderTile(t, { riichi: t.riichi }));
    }
  }

  // Hong Kong only: the faan already banked, under the action bar. Shown for
  // every phase so it is there while you choose a discard, and it names the
  // pieces so the number is checkable rather than magic.
  const faanBar = $('#faan-bar');
  const outlook = outlookOf(view);
  if (outlook) {
    const o = outlook;
    faanBar.classList.remove('hidden');
    const short = o.yakuHan < o.minToWin;
    const lock = $('#faan-locked');
    lock.replaceChildren(term('current', `Current ${o.total} ${o.unit}`));
    lock.classList.toggle('short', short);
    const pieces = $('#faan-parts');
    pieces.replaceChildren();
    if (o.parts.length) {
      pieces.append(el('span', '', '· '));
      o.parts.forEach((f, i) => {
        if (i) pieces.append(el('span', '', ', '));
        pieces.append(f.term ? term(f.term, f.name) : el('span', '', f.name));
      });
      if (short) pieces.append(el('span', '', ` · need ${o.goal} to win`));
    } else {
      pieces.append(el('span', '', `· nothing banked yet · need ${o.goal} to win`));
    }

    // and the way out: the easiest shape that still reaches the minimum, with
    // what it is actually waiting for. The rest are a click away.
    const routes = $('#faan-routes');
    routes.replaceChildren();
    lastRoutes = o.routes || [];
    waysUnit = o.unit;
    if (lastRoutes.length) {
      const r = lastRoutes[0];
      routes.append(el('span', '', `Easiest way to ${o.goal}: `));
      const b = el('b', '');
      b.append(routeLabel(r));
      routes.append(b);
      routes.append(el('span', '', ' → '));
      routes.append(term(o.unit === 'han' ? 'han' : 'faan', `${r.faan} ${o.unit}`));
      routes.append(el('span', '', ' · '));
      routes.append(routeNeedEl(r, 3));
      if (lastRoutes.length > 1) {
        const more = el('button', 'claim-mute undo', waysOpen ? 'hide' : `all ${lastRoutes.length} ways`);
        more.type = 'button';
        more.addEventListener('click', toggleWays);
        routes.append(el('span', '', ' '), more);
      }
    } else {
      routes.append(el('span', '', `No hand from here reaches ${o.goal} — play for the draw`));
    }
    paintWays();
  } else {
    faanBar.classList.add('hidden');
  }

  // my played: flowers first, then melds (sets)
  const myPlayed = $('#my-played');
  myPlayed.replaceChildren();
  if (me) renderPlayed(myPlayed, me);

  // hand — reconciled by id so an in-progress drag isn't disrupted and the
  // tile count stays exact
  renderHand(view, me, sess);

  // action bar
  renderActions(view, sess);

  // feed
  renderFeed(view);

  // announcements: claims pop a big call over the seat; everything else is a
  // normal speech bubble (discards aren't announced — the tile rests in the
  // centre instead)
  if (view.chatter) {
    for (const c of view.chatter) {
      if (c.n > chatSeenN) {
        chatSeenN = c.n;
        if (c.kind === 'claim') showCall(c.seat, c.text);
        else showChatBubble({ seat: c.seat, text: c.text, say: true });
      }
    }
  }

  // fx
  if (view.fx && view.fx.seq > seenFxSeq) {
    seenFxSeq = view.fx.seq;
    if (view.fx.kind === 'deal') flash(`Hand ${view.handNum}`, '', cfg('flashMs'));
    if (view.fx.kind === 'riichi') flash('Riichi!', 'big', cfg('flashMs'));
    if (view.fx.kind === 'handEnd') {
      if (view.fx.result === 'win') flash(view.fx.seat === my ? 'You win!' : `${view.players.find((q) => q.seat === view.fx.seat)?.name || '?'} wins!`, 'big', 2500);
      else flash('Draw', '', 2000);
    }
  }

  // Hand end: hold the score back so the revealed hands can be read, then show
  // it. The panel can also be tucked away to study the board for longer.
  if (view.phase === 'handEnd' && view.handResult) {
    const key = `${view.roundWind}${view.handNum}.${view.honba}.${view.handResult.type}`;
    if (key !== handEndKey) {
      handEndKey = key;
      handEndReady = false;
      scoreHidden = false;
      clearTimeout(handEndTimer);
      handEndTimer = setTimeout(() => {
        handEndReady = true;
        if (lastView && lastView.phase === 'handEnd') paintHandEnd();
      }, REVEAL_MS);
    }
    paintHandEnd();
  } else {
    handEndKey = null;
    handEndReady = false;
    scoreHidden = false;
    clearTimeout(handEndTimer);
    hideHandEnd();
  }

  // game over
  if (view.phase === 'over') {
    showGameOver(view, sess);
  } else {
    $('#gameover').classList.add('hidden');
  }

  chatSetVisible(true);
  paintChatBubbles();
  // the tiles under the pointer were just replaced; light them again
  if (matchKey) setMatch(matchKey, true);
}

// Hand tiles are reused across renders (and tile ids repeat from game to game),
// so a tile element can outlive the session that built it. Always act through
// the session that is live NOW rather than the one captured at bind time.
function handleTileClick(id) {
  if (!session || pendingMove) return;
  if (selectedTile === id) {
    // tap again = discard
    pendingMove = true;
    selectedTile = null;
    session.localMove({ kind: 'discard', tileId: id });
  } else {
    selectedTile = id;
    if (lastView) renderGame(lastView, session);
  }
}

// Where one tile belongs in a hand somebody may have arranged by hand: beside
// its own kind if any are already down, otherwise ahead of the first tile that
// sorts after it. A tidy hand gets a properly sorted insert; a hand arranged by
// hand keeps every other tile exactly where it was put.
function slotFor(ordered, t) {
  let twin = -1;
  for (let i = 0; i < ordered.length; i++) if (ordered[i].key === t.key) twin = i;
  if (twin >= 0) return twin + 1;
  const i = ordered.findIndex((x) => tileSort(t, x) < 0);
  return i < 0 ? ordered.length : i;
}

// Keep my hand in the order I've arranged it: known tiles hold their slot,
// freshly dealt tiles are inserted sorted so the opening hand is tidy.
//
// A tile drawn mid-hand is the exception. It parks on the end, where you can
// see at a glance what you just picked up, and files itself away only once the
// discard is made. Nothing else moves with it, so an arrangement you made
// yourself survives the tidying.
function orderedHand(hand, view) {
  const pos = new Map(handOrder.map((id, i) => [id, i]));
  const known = hand.filter((t) => pos.has(t.id)).sort((a, b) => pos.get(a.id) - pos.get(b.id));
  const fresh = hand.filter((t) => !pos.has(t.id)).sort(tileSort);
  const ordered = known.concat(fresh);

  // turning up alongside a hand that is already arranged makes it a draw
  if (known.length && fresh.length) drawnPin = fresh[fresh.length - 1].id;

  // the turn is over (the view stops naming a draw): file it, then forget it
  if (drawnPin !== null && !(view && view.lastDraw)) {
    const i = ordered.findIndex((t) => t.id === drawnPin);
    if (i >= 0) { const [t] = ordered.splice(i, 1); ordered.splice(slotFor(ordered, t), 0, t); }
    drawnPin = null;
  }

  handOrder = ordered.map((t) => t.id);
  return ordered;
}

// Reconcile the hand DOM in place: reuse each tile element by id (so an active
// drag and exact counts are preserved) and only reshuffle when not dragging.
function renderHand(view, me, sess) {
  const handEl = $('#hand');
  if (!me || !me.hand) { handEl.replaceChildren(); return; }
  const ordered = orderedHand(me.hand, view);
  const byId = new Map([...handEl.children].map((n) => [n.dataset.tid, n]));
  const desired = ordered.map((t) => {
    const isLastDraw = view.lastDraw && t.id === view.lastDraw.id;
    const ex = byId.get(String(t.id));
    if (ex) { patchHandTile(ex, t.id, isLastDraw); return ex; }
    return handCardEl(t, sess, isLastDraw);
  });
  for (const n of [...handEl.children]) if (!desired.includes(n)) n.remove();
  if (!handEl.querySelector('.tile.dragging')) {
    let cursor = handEl.firstChild;
    for (const n of desired) {
      if (n === cursor) { cursor = cursor.nextSibling; continue; }
      handEl.insertBefore(n, cursor);
    }
  }
}

function patchHandTile(el, id, isLastDraw) {
  el.classList.toggle('selected', selectedTile === id);
  el.classList.toggle('last-draw', !!isLastDraw);
}

function handCardEl(t, sess, isLastDraw) {
  const tile = renderTile(t, { lastDraw: isLastDraw });
  tile.dataset.tid = String(t.id);
  tile.style.cursor = 'pointer';
  if (selectedTile === t.id) tile.classList.add('selected');
  attachHandDrag(tile, t.id, sess);
  return tile;
}

// Drag a hand tile to rearrange it. Slot centres are snapshotted once at drag
// start so the thresholds never move under the pointer; the other tiles slide
// aside by transform only (no DOM churn) to preview the landing gap, and the
// order is committed once on release. A tap (no drag) selects/discards.
function attachHandDrag(tile, tileId, sess) {
  tile.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const hand = $('#hand');
    const startX = e.clientX;
    let dragging = false;
    let slots = null;

    const snapshot = () => {
      const children = [...hand.children];
      const rects = children.map((n) => n.getBoundingClientRect());
      slots = {
        children,
        centers: rects.map((r) => r.left + r.width / 2),
        myIndex: children.indexOf(tile),
        step: children.length > 1 ? Math.abs(rects[1].left - rects[0].left) : rects[0].width,
      };
    };
    const targetIndex = (x) => {
      let t = 0;
      slots.children.forEach((n, i) => { if (n !== tile && slots.centers[i] < x) t++; });
      return t;
    };
    const preview = (x) => {
      const F = targetIndex(x), D = slots.myIndex;
      slots.children.forEach((n, i) => {
        if (n === tile) return;
        let dx = 0;
        if (F > D && i > D && i <= F) dx = -slots.step;
        else if (F < D && i >= F && i < D) dx = slots.step;
        n.style.transform = dx ? `translateX(${dx}px)` : '';
      });
    };
    const move = (ev) => {
      const dx = ev.clientX - startX;
      if (!dragging && Math.abs(dx) > 8) {
        dragging = true;
        tile.classList.add('dragging');
        snapshot();
      }
      if (dragging) {
        tile.style.transform = `translate(${dx}px, -10px) scale(1.04)`;
        preview(ev.clientX);
      }
    };
    const done = (ev) => {
      tile.removeEventListener('pointermove', move);
      tile.removeEventListener('pointerup', done);
      tile.removeEventListener('pointercancel', done);
      if (!dragging) {
        if (lastView && lastView.phase === 'discard' && lastView.turn === lastView.mySeat) handleTileClick(tileId);
        return;
      }
      tile.classList.remove('dragging');
      const idx = targetIndex(ev.clientX);
      for (const n of slots.children) n.style.transform = '';
      tile.style.transform = '';
      const rest = handOrder.filter((id) => id !== tileId);
      rest.splice(idx, 0, tileId);
      handOrder = rest;
      if (drawnPin === tileId) drawnPin = null; // placed by hand — leave it there
      if (lastView) renderGame(lastView, sess);
    };

    try { tile.setPointerCapture(e.pointerId); } catch {}
    tile.addEventListener('pointermove', move);
    tile.addEventListener('pointerup', done);
    tile.addEventListener('pointercancel', done);
  });
}

function renderActions(view, sess) {
  const bar = $('#action-bar');
  bar.replaceChildren();
  const my = view.mySeat;

  // claim phase buttons
  if (view.claimOpts) {
    const opts = view.claimOpts;
    const blocked = new Set(opts.blockedOpts || []);
    const tile = opts.tile;
    let offered = 0;

    // a claim plus the little chip that stops it being offered again
    const offer = (btn, muteKey, onTake, blockedWhy) => {
      if (muteKey && claimMuted.has(muteKey)) return;
      offered++;
      if (blockedWhy) { btn.disabled = true; btn.title = blockedWhy; }
      else btn.addEventListener('click', () => { if (!pendingMove) { pendingMove = true; onTake(); } });
      if (!muteKey) { bar.append(btn); return; }
      const group = el('span', 'claim-group');
      const mute = el('button', 'claim-mute', '✕');
      mute.type = 'button';
      mute.title = 'Stop offering this call for the rest of the hand';
      mute.setAttribute('aria-label', `Stop offering ${btn.textContent}`);
      mute.addEventListener('click', () => {
        claimMuted.add(muteKey);
        if (lastView) renderGame(lastView, session);
      });
      group.append(btn, mute);
      bar.append(group);
    };

    // Ron is never muted — declining a win is not a thing you want made easy
    if (opts.options.includes('ron')) {
      offer(el('button', 'btn ron', 'Ron'), null, () => session.localMove({ kind: 'ron' }), null);
    }
    if (opts.options.includes('kan')) {
      offer(el('button', 'btn kan-btn', 'Kan'), kanMuteKey(tile),
        () => session.localMove({ kind: 'kan' }),
        blocked.has('kan') ? 'A player may still Ron — wait for them to pass' : null);
    }
    if (opts.options.includes('pon')) {
      offer(el('button', 'btn pon-btn', 'Pon'), ponMuteKey(tile),
        () => session.localMove({ kind: 'pon' }),
        blocked.has('pon') ? 'A player may still Ron — wait for them to pass' : null);
    }
    if (opts.options.includes('chi')) {
      for (const combo of opts.chiCombos) {
        const chiBtn = el('button', 'btn chi-btn', 'Chi');
        const strip = el('span', 'btn-tiles');
        for (const t of combo) strip.append(renderTile(t));
        chiBtn.append(strip);
        offer(chiBtn, chiMuteKey(combo, tile),
          () => session.localMove({ kind: 'chi', tile1: combo[0].id, tile2: combo[1].id }),
          blocked.has('chi') ? 'A player may Pon or Ron — wait for them to pass' : null);
      }
    }

    // everything on offer has been waved away: pass without asking again
    if (offered === 0) {
      if (!pendingMove) { pendingMove = true; session.localMove({ kind: 'pass' }); }
      bar.append(el('span', 'claim-note', 'Calls muted for this hand — passing'));
      return;
    }

    const pass = el('button', 'btn secondary', 'Pass');
    pass.addEventListener('click', () => { if (!pendingMove) { pendingMove = true; session.localMove({ kind: 'pass' }); } });
    bar.append(pass);
    if (claimMuted.size) {
      const note = el('span', 'claim-note', `${claimMuted.size} call${claimMuted.size > 1 ? 's' : ''} muted`);
      const undo = el('button', 'claim-mute undo', 'undo');
      undo.type = 'button';
      undo.title = 'Offer the muted calls again';
      undo.addEventListener('click', () => { claimMuted = new Set(); if (lastView) renderGame(lastView, session); });
      note.append(undo);
      bar.append(note);
    }
    if (blocked.size) {
      const hint = el('span', 'claim-note', 'Higher-priority calls pending…');
      hint.style.color = '#c9a94e';
      bar.append(hint);
    }
    return;
  }

  // discard phase actions
  if (view.actions && view.phase === 'discard' && view.turn === my) {
    const a = view.actions;
    if (a.canTsumo) {
      const b = el('button', 'btn tsumo', 'Tsumo');
      b.addEventListener('click', () => { if (!pendingMove) { pendingMove = true; session.localMove({ kind: 'tsumo' }); } });
      bar.append(b);
    }
    if (a.canRiichi) {
      const b = el('button', 'btn riichi-btn', 'Riichi');
      b.addEventListener('click', () => {
        if (!pendingMove && selectedTile && a.riichiDiscards.includes(selectedTile)) {
          pendingMove = true;
          session.localMove({ kind: 'riichi', tileId: selectedTile });
        } else {
          toast('Select a tile to discard with Riichi');
        }
      });
      bar.append(b);
    }
    if (a.canClosedKan && a.closedKanKeys.length > 0) {
      for (const key of a.closedKanKeys) {
        const b = el('button', 'btn kan-btn', 'Kan');
        const kt = view.players.find((q) => q.seat === my)?.hand.find((h) => h.key === key);
        if (kt) { const strip = el('span', 'btn-tiles'); strip.append(renderTile(kt)); b.append(strip); }
        b.addEventListener('click', () => { if (!pendingMove) { pendingMove = true; session.localMove({ kind: 'kan', type: 'closed', tileKey: key }); } });
        bar.append(b);
      }
    }
    if (a.canAddKan && a.addKanOptions.length > 0) {
      for (const tid of a.addKanOptions) {
        const t = view.players.find((q) => q.seat === my)?.hand.find((h) => h.id === tid);
        const b = el('button', 'btn kan-btn', 'Kan+');
        if (t) { const strip = el('span', 'btn-tiles'); strip.append(renderTile(t)); b.append(strip); }
        b.addEventListener('click', () => { if (!pendingMove) { pendingMove = true; session.localMove({ kind: 'kan', type: 'add', tileId: tid }); } });
        bar.append(b);
      }
    }

    if (!a.canTsumo) {
      const hint = el('span', '', selectedTile ? 'Click again to discard' : 'Select a tile to discard');
      hint.style.cssText = 'font-size:12px;color:#5a8a6a;';
      bar.append(hint);
    }
  }

  // (whose turn it is now shows in the centre — see #turn-label in renderGame)
}

function renderFeed(view) {
  const feed = $('#feed');
  feed.replaceChildren();
  for (const entry of view.log) {
    feed.append(el('div', '', entry.text));
  }
  feed.scrollTop = feed.scrollHeight;
}

// one label:value line in the hand-end breakdown
function heRow(label, value, cls) {
  const row = el('div', 'he-row' + (cls ? ' ' + cls : ''));
  row.append(el('span', 'he-label', label));
  if (value != null && value !== '') row.append(el('span', 'he-val', value));
  return row;
}

// cheatsheet of the special hands each ruleset scores; the ruleset currently in
// play is listed first and flagged, the others stay below for reference
// cheatsheet row names that the glossary can explain
const CHEAT_TERMS = {
  'Self-draw': 'selfdraw', 'Menzen Tsumo': 'selfdraw', 'Concealed hand': 'selfdraw',
  'Seat wind': 'seatwind', 'Round wind': 'roundwind', 'Dragon triplet': 'dragonpung',
  'All sequences': 'sequences', 'All triplets': 'triplets',
  'Mixed flush': 'mixed', 'Full flush': 'full', 'All honours': 'honors', 'Flowers': 'flowers',
  Riichi: 'riichi', Tanyao: 'tanyao', Pinfu: 'pinfu', Toitoi: 'toitoi',
  Chiitoitsu: 'chiitoitsu', Honitsu: 'honitsu', Chinitsu: 'chinitsu',
  'Kokushi Musou': 'kokushi', Dora: 'dora', 'Haku / Hatsu / Chun': 'yakuhai',
  Ippatsu: 'ippatsu', Iipeiko: 'iipeiko', 'Concealed hand': 'concealed',
};

// Hovering only helps if you already know which word to point at, so the panel
// also carries the whole vocabulary, grouped and spelled out.
const GLOSSARY_SECTIONS = [
  ['The tiles', ['man', 'pin', 'sou', 'honours', 'dragons', 'terminals']],
  ['The table', ['meld', 'concealed', 'pung', 'run', 'tenpai', 'wall', 'dealer']],
  ['Calling a tile', ['chi', 'pon', 'kan', 'ron', 'tsumo', 'furiten']],
  ['Keeping score', ['faan', 'han', 'fu', 'dora', 'uradora', 'yakuman', 'riichisticks', 'honba', 'current', 'drop', 'needs']],
  ['Hong Kong & Taiwanese hands', ['flowers', 'selfdraw', 'sequences', 'triplets', 'mixed', 'full', 'honors',
    'honourpung', 'seatwind', 'roundwind', 'dragonpung']],
  ['Riichi yaku', ['riichi', 'ippatsu', 'tanyao', 'pinfu', 'iipeiko', 'toitoi', 'chiitoitsu',
    'honitsu', 'chinitsu', 'kokushi', 'yakuhai']],
];

function renderGlossary(into) {
  const sec = el('div', 'cheat-sec');
  const head = el('div', 'cheat-head');
  head.append(el('span', 'cheat-name', 'Glossary'));
  sec.append(head);
  sec.append(el('div', 'cheat-note', 'Every term this game uses, in plain words. The same notes appear on hover wherever a term shows up.'));
  for (const [heading, keys] of GLOSSARY_SECTIONS) {
    sec.append(el('div', 'gloss-head', heading));
    for (const k of keys) {
      const g = GLOSSARY[k];
      if (!g) continue;
      const row = el('div', 'gloss-row');
      row.append(el('div', 'gloss-term', g.title));
      const d = el('div', 'gloss-def', g.body);
      const ex = exampleEl(g);
      if (ex) { ex.classList.add('gloss-tiles'); d.append(ex); }
      row.append(d);
      sec.append(row);
    }
  }
  into.append(sec);
}

function renderCheatsheet() {
  const body = $('#cheat-body');
  if (!body) return;
  const active = (lastView && lastView.variant) || (session && session.selectedVariant) || null;
  const guide = Array.isArray(SCORING_GUIDE) ? SCORING_GUIDE : [];
  const guides = [...guide].sort((a, b) => (b.key === active) - (a.key === active));
  body.replaceChildren();
  for (const g of guides) {
    const sec = el('div', 'cheat-sec');
    const head = el('div', 'cheat-head');
    head.append(el('span', 'cheat-name', g.name));
    if (g.key === active) head.append(el('span', 'cheat-tag', 'in play'));
    sec.append(head);
    sec.append(el('div', 'cheat-note', g.note));
    const rows = el('div', 'cheat-rows');
    for (const [name, val, req] of g.rows) {
      const r = el('div', 'cheat-row');
      // "1 each" reads better as "1 faan each" than "1 each faan"
      const valStr = /\beach$/.test(val)
        ? `${val.replace(/\s*each$/, '')} ${g.unit} each`
        : `${val} ${g.unit}`;
      const key = CHEAT_TERMS[name];
      r.append(key ? (() => { const c = el('span', 'cheat-hand'); c.append(term(key, name)); return c; })()
                   : el('span', 'cheat-hand', name));
      r.append(el('span', 'cheat-val', valStr));
      r.append(el('span', 'cheat-req', req));
      rows.append(r);
    }
    sec.append(rows);
    body.append(sec);
  }
  renderGlossary(body);
  wireTerms(body);
}

// Everyone's hand is laid open the moment a hand ends; the score panel waits
// this long before covering the table with it.
const REVEAL_MS = 2600;
let handEndKey = null, handEndReady = false, handEndTimer = null, scoreHidden = false;

function hideHandEnd() {
  $('#handend').classList.add('hidden');
  $('#he-peek').classList.add('hidden');
}

// Decide what the hand-end state should look like right now: the bare board
// while the hands are being read or while the player has tucked the panel away,
// otherwise the score.
function paintHandEnd() {
  if (!lastView || lastView.phase !== 'handEnd' || !lastView.handResult) { hideHandEnd(); return; }
  if (handEndReady && !scoreHidden) {
    $('#he-peek').classList.add('hidden');
    showHandEnd(lastView, lastSess);
  } else {
    $('#handend').classList.add('hidden');
    $('#he-peek').classList.toggle('hidden', !scoreHidden);
  }
}

// Tucked away, a click anywhere on the board brings the score back. Chrome that
// exists to show you MORE of the game — the log, chat, the top bar — is exempt,
// since dismissing the score to open the log only to have it reappear would be
// self-defeating. Capture phase, so this runs before the hide button's own
// handler sets the flag and can't immediately undo it.
document.addEventListener('click', (e) => {
  if (!scoreHidden) return;
  if (e.target.closest && e.target.closest('#chat, #feed, .topbar, #size-popover, .modal')) return;
  scoreHidden = false;
  paintHandEnd();
}, true);

function showHandEnd(view, sess) {
  const m = $('#handend');
  m.classList.remove('hidden');
  const hr = view.handResult;
  const title = $('#he-title');
  const detail = $('#he-detail');
  const scores = $('#he-scores');
  const nameOf = (seat) => view.players.find((q) => q.seat === seat)?.name || `Seat ${seat}`;
  // scoring unit differs by ruleset: Riichi counts han, Taiwanese tai, HK faan
  const unit = view.variant === 'jp' ? 'han' : view.variant === 'tw' ? 'tai' : 'faan';

  detail.replaceChildren();

  if (hr.type === 'win') {
    const winner = view.players.find((q) => q.seat === hr.winner);
    title.textContent = hr.tsumo ? `${winner?.name} — Tsumo!` : `${winner?.name} — Ron!`;
    const sc = hr.scoring || {};

    // 1) every yaku / faan / tai with its value — and, where each unit is worth a
    //    fixed number of points, what that line earned
    const perUnit = sc.perTai;
    const list = el('div', 'he-yaku');
    const items = sc.yaku || [];
    if (items.length) {
      for (const y of items) {
        const v = y.han != null ? y.han : y.val;
        list.append(heRow(y.name, perUnit != null ? `${v} ${unit} (${v * perUnit} pts)` : `${v} ${unit}`));
      }
    } else {
      list.append(heRow('No yaku', ''));
    }
    // the flat base every win scores, so the lines above add up to the total
    if (sc.base != null && perUnit != null) list.append(heRow('Base', `${sc.base} pts`));
    detail.append(list);

    // 2) the total count (+ fu for Riichi), then the hand's value
    const totalStr = view.variant === 'jp'
      ? `${sc.han || 0} han · ${sc.fu || 0} fu`
      : `${sc.total || 0} ${unit}`;
    detail.append(heRow('Total', totalStr, 'he-total'));
    detail.append(heRow('Hand value', `${sc.points ?? 0} pts`, 'he-total'));

    // 3) how that value is paid out
    const pay = hr.payments;
    const payWrap = el('div', 'he-pay');
    if (pay?.mode === 'ron') {
      payWrap.append(heRow(`Ron — ${nameOf(pay.from)} pays`, `${pay.amount}`));
    } else if (pay?.mode === 'tsumo' && view.variant === 'jp') {
      if (hr.winner === view.dealer) {
        payWrap.append(heRow('Tsumo — each pays', `${pay.dealer}`));
      } else {
        payWrap.append(heRow('Tsumo — dealer pays', `${pay.dealer}`));
        payWrap.append(heRow('Tsumo — others pay', `${pay.nonDealer} each`));
      }
    } else if (pay?.mode === 'tsumo') {
      payWrap.append(heRow('Tsumo — each pays', `${pay.each}`));
    }
    if (hr.bonus?.riichi) payWrap.append(heRow('Riichi sticks', `+${hr.bonus.riichi}`));
    if (hr.bonus?.honba) payWrap.append(heRow('Honba', `+${hr.bonus.honba}`));
    if (payWrap.childElementCount) detail.append(payWrap);
  } else {
    title.textContent = 'Exhaustive draw';
    detail.append(heRow('The wall ran out — no winner.', ''));
    if (hr.tenpai) {
      const names = hr.tenpai.length ? hr.tenpai.map(nameOf).join(', ') : 'nobody';
      detail.append(heRow('Tenpai', names));
    }
  }

  // per-player score change: name | Δ this hand | new total
  scores.replaceChildren();
  const readySeats = view.readyNext || [];
  scores.append(heScoreRow('Player', 'This hand', 'Total', 'he-score-head', 'Ready'));
  for (const p of view.players) {
    const d = hr.delta ? hr.delta[p.seat] || 0 : 0;
    const nm = p.name + (hr.type === 'win' && p.seat === hr.winner ? ' 🏆' : '');
    const dStr = d > 0 ? `+${d}` : `${d}`;
    // a bot or an empty chair is nobody to wait for, so it reads as neither
    const waited = !p.bot && p.connected;
    const mark = !waited ? '—' : readySeats.includes(p.seat) ? '✓' : '…';
    scores.append(heScoreRow(nm, dStr, `${p.score}`, d > 0 ? 'up' : d < 0 ? 'down' : '', mark));
  }

  const hide = $('#btn-he-hide');
  if (hide) hide.onclick = () => { scoreHidden = true; paintHandEnd(); };

  // Everyone reads the score at their own pace, so everyone gets the button and
  // the deal waits for the last of them.
  const btn = $('#btn-next-hand');
  const wait = $('#he-wait');
  const ready = view.readyNext || [];
  const iAmReady = ready.includes(view.mySeat);
  const others = (view.waitingNext || []).filter((x) => x !== view.mySeat);

  btn.classList.remove('hidden');
  btn.disabled = iAmReady;
  btn.textContent = iAmReady ? 'Ready ✓' : 'Ready for the next hand';
  btn.onclick = () => { if (!iAmReady) session && session.localNext(); };

  wait.classList.remove('hidden');
  if (others.length) wait.textContent = `Waiting for ${others.map(nameOf).join(', ')}…`;
  else if (iAmReady) wait.textContent = 'Dealing…';
  else wait.textContent = 'Everyone else is ready.';
}

// ---------------------------------------------------------------- glossary
// The faan line is dense with terms of art, and it exists for people still
// learning the game — so every one of them explains itself on hover, with real
// tiles where a sentence alone wouldn't land.
const T_ = (kind, v) => ({ kind, v, key: kind === 'wind' ? `w${v}` : kind === 'dragon' ? `d${v}` : `${kind}${v}` });
const GLOSSARY = {
  faan: { title: 'Faan',
    body: "Hong Kong's scoring unit. Three is the minimum to declare a win at all — a complete hand worth less than that cannot be taken, so you keep playing. Above three, each faan roughly doubles the payout." },
  mixed: { title: 'Mixed flush · 3 faan',
    body: 'Every numbered tile in one suit, with any winds or dragons alongside. No tiles from the other two suits.',
    links: { 'a win': 'ron' },
    tiles: [T_('p', 2), T_('p', 3), T_('p', 4), T_('p', 8), T_('p', 8), T_('p', 8), T_('wind', 'E'), T_('wind', 'E'), T_('wind', 'E')] },
  full: { title: 'Full flush · 6 faan',
    body: 'Every tile in a single suit, with no winds or dragons at all. Harder than a mixed flush, and worth double.',
    links: { 'winds or dragons': 'honours', 'mixed flush': 'mixed' },
    tiles: [T_('m', 1), T_('m', 2), T_('m', 3), T_('m', 5), T_('m', 5), T_('m', 5), T_('m', 7), T_('m', 8), T_('m', 9)] },
  honors: { title: 'All honours · 10 faan',
    body: 'Nothing but winds and dragons — no numbered tiles anywhere in the hand. Rare, and paid accordingly.',
    links: { 'winds and dragons': 'honours' },
    tiles: [T_('wind', 'E'), T_('wind', 'E'), T_('wind', 'E'), T_('dragon', 'R'), T_('dragon', 'R'), T_('dragon', 'R'), T_('dragon', 'G'), T_('dragon', 'G')] },
  sequences: { title: 'All sequences · 1 faan',
    body: 'Every set is a run of three consecutive tiles in one suit. No triplets anywhere except the pair.',
    links: { runs: 'run', triplets: 'pung' },
    tiles: [T_('s', 3), T_('s', 4), T_('s', 5), T_('p', 6), T_('p', 7), T_('p', 8)] },
  triplets: { title: 'All triplets · 3 faan',
    body: 'Every set is three (or four) of the same tile. No runs anywhere.',
    links: { triplet: 'pung', kan: 'kan', runs: 'run' },
    tiles: [T_('p', 5), T_('p', 5), T_('p', 5), T_('m', 9), T_('m', 9), T_('m', 9)] },
  honourpung: { title: 'Dragon and wind pungs · 1 faan each',
    body: 'Three of a dragon, of your own seat wind, or of the round wind. Your seat wind pays twice if it is also the round wind — East seat in the East round is two faan from one set.',
    links: { dragon: 'dragons', 'seat wind': 'seatwind', 'round wind': 'roundwind' },
    tiles: [T_('dragon', 'R'), T_('dragon', 'R'), T_('dragon', 'R')] },
  dragonpung: { title: 'Dragon pung · 1 faan',
    body: 'Three of any one dragon — Haku, Hatsu or Chun. Already melded, so it is banked.',
    links: { Haku: 'dragons', Hatsu: 'dragons', Chun: 'dragons', melded: 'meld' },
    tiles: [T_('dragon', 'W'), T_('dragon', 'G'), T_('dragon', 'R')] },
  seatwind: { title: 'Seat wind · 1 faan', body: 'Three of the wind matching your own seat. Banked once melded.' },
  roundwind: { title: 'Round wind · 1 faan', body: 'Three of the wind the round is named for. It stacks with seat wind when they are the same tile.' },
  flowers: { title: 'Flowers · 1 faan each',
    body: 'Flower and season tiles never sit in your hand: they are set aside the moment you draw one and replaced with a fresh tile. Free faan, and nothing can take them away.',
    links: { 'seat wind': 'seatwind' },
    links: { melded: 'meld' },
    tiles: [T_('flower', 1), T_('flower', 6)] },
  selfdraw: { title: 'Self-draw only · 1 faan',
    body: 'Winning on a tile you drew yourself is worth a faan, which is what lifts a two-faan shape to the three you need to declare at all. The catch is in the name: the shape is only worth three WITH the self-draw, so the winning tile has to come off the wall on your own turn. You cannot take it from a discard, however obligingly somebody throws it. That makes the route harder than its distance suggests, and it is ranked accordingly.',
    links: { discard: 'ron' } },
  drop: { title: 'Drop',
    body: 'How many tiles in your hand this route has no use for. You would be discarding these over the coming turns.' },
  needs: { title: 'Needs',
    body: 'What you would then have to draw or claim. One tile short, it turns into "wins on" and lists every tile that finishes the hand — a run open at both ends has two. A number in brackets is how many of that tile nobody has seen yet, shown when it is getting scarce.' },
  han: { title: 'Han',
    body: "Riichi's scoring unit. You need at least one han that is NOT dora — that is what a yaku is — before a finished hand can be declared at all. Han and fu together set the payout." },
  riichi: { title: 'Riichi \u00b7 1 han',
    body: 'Declare when your hand is concealed and one tile from winning. It costs a 1000-point stick and locks your discards, and it is itself the yaku — which is why almost any concealed hand still has a way home.' },
  tanyao: { title: 'Tanyao \u00b7 1 han',
    body: 'No terminals and no honours: every tile between 2 and 8. The easiest yaku to steer into, and one of the few that survives opening your hand.',
    links: { 'self-draw': 'tsumo' },
    links: { concealed: 'concealed', tenpai: 'tenpai', yaku: 'han' },
    links: { yaku: 'han', dora: 'dora', fu: 'fu' },
    tiles: [T_('m', 3), T_('m', 4), T_('m', 5), T_('p', 7), T_('p', 7), T_('p', 7)] },
  pinfu: { title: 'Pinfu \u00b7 1 han',
    body: 'Every set is a run, with a concealed hand. Lost the moment you claim a tile from anyone.',
    links: { runs: 'run', concealed: 'concealed', claim: 'meld' },
    tiles: [T_('s', 2), T_('s', 3), T_('s', 4), T_('p', 6), T_('p', 7), T_('p', 8)] },
  toitoi: { title: 'Toitoi \u00b7 2 han',
    body: 'Every set is a triplet or a kan. Unlike most of the cheap yaku, this one survives claiming tiles.',
    links: { triplet: 'pung', kan: 'kan', yaku: 'han' },
    tiles: [T_('m', 2), T_('m', 2), T_('m', 2), T_('s', 6), T_('s', 6), T_('s', 6)] },
  honitsu: { title: 'Honitsu \u00b7 3 han concealed, 2 open',
    body: 'One suit plus any winds and dragons — the shape Hong Kong calls a mixed flush.',
    links: { 'winds and dragons': 'honours', 'mixed flush': 'mixed' },
    tiles: [T_('p', 2), T_('p', 3), T_('p', 4), T_('p', 9), T_('p', 9), T_('dragon', 'R'), T_('dragon', 'R'), T_('dragon', 'R')] },
  chinitsu: { title: 'Chinitsu \u00b7 6 han concealed, 5 open',
    body: 'A single suit and nothing else — no winds, no dragons.',
    links: { winds: 'honours', dragons: 'dragons' },
    tiles: [T_('s', 1), T_('s', 2), T_('s', 3), T_('s', 5), T_('s', 5), T_('s', 7), T_('s', 8), T_('s', 9)] },
  yakuhai: { title: 'Yakuhai · 1 han each',
    body: 'A triplet of any dragon — Haku, Hatsu or Chun — or of your seat wind, or of the round wind. It stacks: a triplet that is both your seat wind and the round wind is two han.',
    links: { triplet: 'pung', Haku: 'dragons', Hatsu: 'dragons', Chun: 'dragons', 'seat wind': 'seatwind', 'round wind': 'roundwind', han: 'han' },
    tiles: [T_('dragon', 'W'), T_('dragon', 'W'), T_('dragon', 'W'), T_('dragon', 'G'), T_('dragon', 'G'), T_('dragon', 'G'), T_('dragon', 'R'), T_('dragon', 'R'), T_('dragon', 'R')] },
  chiitoitsu: { title: 'Chiitoitsu \u00b7 2 han',
    body: 'Seven different pairs instead of four sets and a pair. Concealed only.',
    links: { pairs: 'pung', Concealed: 'concealed' },
    tiles: [T_('m', 3), T_('m', 3), T_('p', 7), T_('p', 7), T_('s', 1), T_('s', 1), T_('wind', 'W'), T_('wind', 'W')] },
  kokushi: { title: 'Kokushi musou \u00b7 yakuman',
    body: 'One of each terminal and honour \u2014 thirteen distinct tiles \u2014 plus a second copy of any one of them. Concealed only, and worth the maximum.',
    links: { terminal: 'terminals', honour: 'honours', Concealed: 'concealed' },
    tiles: [T_('m', 1), T_('m', 9), T_('p', 1), T_('p', 9), T_('s', 1), T_('s', 9), T_('dragon', 'R')] },
  chi: { title: 'Chi',
    body: 'Claim a discard to finish a run of three, and only from the player on your left. The set is turned face up, which costs you every concealed-only yaku.',
    links: { run: 'run', 'opens your hand': 'concealed' },
    tiles: [T_('s', 4), T_('s', 5), T_('s', 6)] },
  pon: { title: 'Pon',
    body: 'Claim a discard to finish a triplet, from anyone at the table. Outranks Chi when two people want the same tile.',
    links: { triplet: 'pung', Chi: 'chi' },
    tiles: [T_('p', 8), T_('p', 8), T_('p', 8)] },
  kan: { title: 'Kan',
    body: 'A fourth copy of a tile you already have three of. You draw a replacement, and in Riichi it flips another dora indicator.',
    links: { dora: 'dora', Riichi: 'riichi' },
    tiles: [T_('m', 5), T_('m', 5), T_('m', 5), T_('m', 5)] },
  ron: { title: 'Ron',
    body: 'Win on a tile somebody else discarded. Beats every other claim, and the discarder alone pays.' },
  tsumo: { title: 'Tsumo',
    body: 'Win on the tile you drew yourself. Everyone pays — which is what makes a self-draw worth roughly three times a win on a discard.' },
  furiten: { title: 'Furiten',
    body: 'A Riichi rule: if any tile that would complete your hand is sitting in your own discards, you cannot win by Ron. You may still win by self-draw.' },
  dora: { title: 'Dora · +1 han each',
    body: 'The tile shown in the centre is the indicator, and is worth nothing itself. The dora is whatever comes one step after it, as below. Every copy of that tile in your hand is +1 han, so a kan of the right one is four. Each kan anybody calls turns up another indicator, and if you win after declaring riichi the tiles hidden underneath count as well. Dora is never a yaku: a hand with nothing else cannot be declared.',
    links: { Riichi: 'riichi', Ron: 'ron', 'self-draw': 'selfdraw' },
    links: { 'self-draw': 'selfdraw' },
    links: { 'claim': 'meld' },
    links: { han: 'han', kan: 'kan', riichi: 'riichi', 'hidden underneath': 'uradora', yaku: 'han' },
    pairsCaption: 'indicator → the dora it points at',
    pairs: [
      { from: T_('p', 3), to: T_('p', 4), note: 'next in the suit' },
      { from: T_('s', 9), to: T_('s', 1), note: 'nine wraps to one' },
    ],
    chains: [
      { label: 'winds', wraps: true, tiles: [T_('wind', 'E'), T_('wind', 'S'), T_('wind', 'W'), T_('wind', 'N'), T_('wind', 'E')] },
      { label: 'dragons', wraps: true, tiles: [T_('dragon', 'W'), T_('dragon', 'G'), T_('dragon', 'R'), T_('dragon', 'W')] },
    ] },
  dragons: { title: 'Haku, Hatsu, Chun — the dragons',
    body: 'The three dragon tiles: Haku the white one, Hatsu the green, Chun the red. A triplet of any of them pays in every ruleset here, and for dora they cycle in this order, Chun leading back round to Haku.',
    links: { triplet: 'pung', dora: 'dora' },
    pairsCaption: 'Haku → Hatsu → Chun, and round again',
    chains: [
      { label: '', wraps: true, tiles: [T_('dragon', 'W'), T_('dragon', 'G'), T_('dragon', 'R'), T_('dragon', 'W')] },
    ] },
  man: { title: 'Man — the character suit',
    body: 'Numbered 1 to 9, each marked with 萬. Called characters in English. Four copies of every tile, as in Pin and Sou.',
    links: { Pin: 'pin', Sou: 'sou' },
    tiles: [T_('m', 1), T_('m', 5), T_('m', 9)] },
  pin: { title: 'Pin — the circle suit',
    body: 'Numbered 1 to 9, drawn as rings of dots. Called circles or dots in English. The other two suits are Man and Sou.',
    links: { Man: 'man', Sou: 'sou' },
    tiles: [T_('p', 1), T_('p', 5), T_('p', 9)] },
  sou: { title: 'Sou — the bamboo suit',
    body: 'Numbered 1 to 9, drawn as bamboo stalks. Called bamboo or sticks in English. The other two suits are Man and Pin.',
    links: { Man: 'man', Pin: 'pin' },
    tiles: [T_('s', 1), T_('s', 5), T_('s', 9)] },
  uradora: { title: 'Ura-dora',
    body: 'A second set of dora indicators, hidden under the first and revealed only if you win after declaring riichi. Pure luck, and often the difference between a modest hand and a big one.' },
  ippatsu: { title: 'Ippatsu \u00b7 1 han',
    body: 'Win within one go-around of declaring riichi, before your next discard. Any claim by anybody in between cancels it.' },
  iipeiko: { title: 'Iipeiko \u00b7 1 han',
    body: 'Two identical runs — same three tiles, same suit, twice. Concealed hands only.',
    links: { dora: 'dora', riichi: 'riichi' },
    links: { riichi: 'riichi', claim: 'meld' },
    tiles: [T_('s', 3), T_('s', 4), T_('s', 5), T_('s', 3), T_('s', 4), T_('s', 5)] },
  concealed: { title: 'Concealed hand',
    body: 'A hand with no sets claimed from anyone. Drawing everything yourself keeps it concealed; one Chi, Pon or open Kan opens it and costs you riichi, pinfu, seven pairs and the rest of the concealed-only yaku.' },
  fu: { title: 'Fu',
    body: "Riichi's second scoring axis, counted alongside han: a base 20, plus points for triplets (more for honours and terminals, more again if concealed), for a kan, for an awkward wait, and for a pair of value tiles. Han doubles the score, fu sets what is being doubled." },
  tenpai: { title: 'Tenpai',
    body: 'One tile away from a complete hand. You must be tenpai to declare riichi, and at an exhaustive draw players who are tenpai collect from those who are not.' },
  honba: { title: 'Honba',
    body: "A counter that rises each time a hand ends without a fresh dealer — a dealer win or a draw. Every honba adds 300 points to the next hand's payout, so a long dealer streak gets progressively more expensive." },
  riichisticks: { title: 'Riichi sticks',
    body: 'The 1000 points each player stakes when declaring riichi. They sit on the table and go, in full, to whoever wins the next hand — so an unclaimed stick rolls over and sweetens the pot.' },
  wall: { title: 'The wall',
    body: 'Tiles left to draw. When it runs out the hand ends in an exhaustive draw with nobody winning, so the count is also a clock: the lower it goes, the less time your hand has to come together.' },
  meld: { title: 'Meld',
    body: 'A set turned face up because you claimed it from someone. It is locked — those tiles can never be rearranged or discarded — and it opens your hand.' },
  pung: { title: 'Pung (triplet)',
    body: 'Three identical tiles. Four of them is a kan.',
    links: { 'exhaustive draw': 'wall' },
    links: { riichi: 'riichi' },
    links: { dealer: 'dealer', draw: 'wall' },
    links: { riichi: 'riichi', 'exhaustive draw': 'wall' },
    links: { claimed: 'chi', 'opens your hand': 'concealed' },
    links: { Chi: 'chi', Pon: 'pon', Kan: 'kan', riichi: 'riichi', pinfu: 'pinfu', 'seven pairs': 'chiitoitsu', yaku: 'han' },
    links: { han: 'han', triplets: 'pung', honours: 'honours', terminals: 'terminals', concealed: 'concealed', kan: 'kan' },
    tiles: [T_('s', 7), T_('s', 7), T_('s', 7)] },
  run: { title: 'Run (sequence)',
    body: 'Three consecutive tiles in one suit. Winds and dragons have no order, so they can never form a run.',
    links: { 'Winds and dragons': 'honours' },
    tiles: [T_('m', 4), T_('m', 5), T_('m', 6)] },
  terminals: { title: 'Terminals',
    body: 'The 1s and 9s of each suit. Awkward to use — a 1 can only ever sit in a 1-2-3 — which is why hands that avoid them (tanyao) or collect them (kokushi) both score.',
    links: { tanyao: 'tanyao', kokushi: 'kokushi' },
    tiles: [T_('m', 1), T_('m', 9), T_('p', 1), T_('s', 9)] },
  honours: { title: 'Honours',
    body: 'The four winds and the three dragons — Haku, Hatsu and Chun. They never form runs, so they are only useful in pairs and triplets, and the valuable ones pay a han each.',
    links: { winds: 'roundwind', Haku: 'dragons', Hatsu: 'dragons', Chun: 'dragons', runs: 'run', han: 'han' },
    tiles: [T_('wind', 'E'), T_('wind', 'S'), T_('dragon', 'R'), T_('dragon', 'G'), T_('dragon', 'W')] },
  yakuman: { title: 'Yakuman',
    body: 'A limit hand — the maximum payout, worth more than any pile of han. Kokushi musou is the one this game implements.' },
  dealer: { title: 'Dealer (East)',
    body: 'The dealer wins and pays about half again as much as anyone else, and keeps the deal by winning — each repeat adding a honba. The seat rotates otherwise.' },
  current: { title: 'Current score',
    body: "What this hand is worth right now whatever happens next: flowers, a declared riichi, and dragon or wind triplets you have already melded. A triplet still hidden in your hand doesn't count — discard out of it and it's gone." },
};

// ---- the notes themselves -------------------------------------------------
//
// A note can raise as many terms as it explains, so they stack: hover a word in
// one note and the next opens beside it, as deep as you care to follow. Notes
// take the pointer (you have to be able to reach into them), which means
// closing is on a short delay — otherwise the gap between a word and its note
// would slam it shut on the way across.

const tips = [];
let closeTimer = null;

function tipAt(depth) {
  while (tips.length <= depth) {
    const t = el('div', 'tip hidden');
    t.dataset.depth = String(tips.length);
    t.addEventListener('mouseenter', cancelClose);
    t.addEventListener('mouseleave', () => scheduleClose(Number(t.dataset.depth)));
    document.body.append(t);
    tips.push(t);
  }
  return tips[depth];
}

function closeFrom(depth) { for (let i = depth; i < tips.length; i++) tips[i].classList.add('hidden'); }
function hideTip() { clearTimeout(closeTimer); closeFrom(0); }
function cancelClose() { clearTimeout(closeTimer); }
function scheduleClose(depth) {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => closeFrom(depth), 220);
}

// A flat row of tiles can only say "here is the shape". Some terms need to show
// a RELATION — this tile means that one — so pairs render as labelled arrows.
// It is also how the dragon order explains itself to somebody who has no idea
// the tiles are called Haku, Hatsu and Chun.
function exampleEl(g) {
  const box = (g.pairs || g.chains) ? el('div', 'ex-pairs') : null;
  // caption first, once, whichever forms follow it
  if (box && g.pairsCaption) box.append(el('div', 'ex-caption', g.pairsCaption));
  if (g.chains) {
    for (const ch of g.chains) {
      const line = el('div', 'ex-chain');
      if (ch.label) line.append(el('span', 'ex-chain-label', ch.label));
      const strip = el('div', 'ex-chain-tiles');
      ch.tiles.forEach((t, i) => {
        if (i) strip.append(el('span', 'ex-arrow', '\u2192'));
        const node = renderTile(t);
        // the repeat that closes the loop is dimmed: it is the same tile again,
        // not a fifth wind
        if (i === ch.tiles.length - 1 && ch.wraps) node.classList.add('ex-wrap');
        strip.append(node);
      });
      line.append(strip);
      box.append(line);
    }
    if (!g.pairs) return box;
  }
  if (g.pairs) {
    const row = el('div', 'ex-pair-row');
    for (const pr of g.pairs) {
      const cell = el('div', 'ex-pair');
      const t = el('div', 'ex-pair-tiles');
      t.append(renderTile(pr.from), el('span', 'ex-arrow', '\u2192'), renderTile(pr.to));
      cell.append(t);
      if (pr.note) cell.append(el('div', 'ex-note', pr.note));
      row.append(cell);
    }
    box.insertBefore(row, box.querySelector('.ex-chain'));
    return box;
  }
  if (g.tiles) {
    const row = el('div', 'tip-tiles');
    for (const t of g.tiles) row.append(renderTile(t));
    return row;
  }
  return null;
}

const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// wrap the phrases a note points at, so the reader can keep pulling the thread
function bodyEl(g, depth) {
  const div = el('div', 'tip-body');
  const map = g.links;
  if (!map) { div.textContent = g.body; return div; }
  const phrases = Object.keys(map).sort((a, b) => b.length - a.length);
  const re = new RegExp(`(${phrases.map(escapeRe).join('|')})`, 'gi');
  let last = 0, m;
  while ((m = re.exec(g.body)) !== null) {
    if (m.index > last) div.append(document.createTextNode(g.body.slice(last, m.index)));
    const hit = phrases.find((x) => x.toLowerCase() === m[0].toLowerCase());
    div.append(term(map[hit], m[0], depth + 1));
    last = m.index + m[0].length;
  }
  if (last < g.body.length) div.append(document.createTextNode(g.body.slice(last)));
  return div;
}

function showTip(anchor, key, depth = 0) {
  const g = GLOSSARY[key];
  if (!g) return;
  cancelClose();
  closeFrom(depth + 1);
  const tip = tipAt(depth);
  tip.replaceChildren();
  tip.append(el('div', 'tip-title', g.title));
  tip.append(bodyEl(g, depth));
  const ex = exampleEl(g);
  if (ex) tip.append(ex);
  tip.classList.remove('hidden');

  // Try the natural spots in order and take the first that lands on screen
  // without covering a note already open — a third-level note that doubles back
  // onto the first is worse than useless, since the first is what you were
  // reading.
  const r = anchor.getBoundingClientRect();
  const box = tip.getBoundingClientRect();
  const W = window.innerWidth, H = window.innerHeight;
  const clampX = (x) => Math.max(8, Math.min(W - box.width - 8, x));
  const clampY = (y) => Math.max(8, Math.min(H - box.height - 8, y));
  const open = tips.slice(0, depth)
    .filter((t) => !t.classList.contains('hidden'))
    .map((t) => t.getBoundingClientRect());
  const hits = (x, y) => open.some((o) =>
    !(x + box.width <= o.left || x >= o.right || y + box.height <= o.top || y >= o.bottom));

  const mid = r.left + r.width / 2 - box.width / 2;
  const spots = depth === 0
    ? [[mid, r.top - box.height - 8], [mid, r.bottom + 8]]
    : (() => {
      const pr = tips[depth - 1].getBoundingClientRect();
      return [
        [pr.right + 8, r.top - 12],
        [pr.left - box.width - 8, r.top - 12],
        [pr.left + 20, pr.bottom + 8],
        [pr.left + 20, pr.top - box.height - 8],
      ];
    })();

  let pick = null;
  for (const [x, y] of spots) {
    const cx = clampX(x), cy = clampY(y);
    if (!hits(cx, cy)) { pick = [cx, cy]; break; }
  }
  if (!pick) pick = [clampX(spots[0][0]), clampY(spots[0][1])];
  tip.style.left = `${Math.round(pick[0])}px`;
  tip.style.top = `${Math.round(pick[1])}px`;
}

function bindTerm(node, key, depth) {
  node.classList.add('term');
  node.tabIndex = 0;
  node.addEventListener('mouseenter', () => showTip(node, key, depth));
  node.addEventListener('focus', () => showTip(node, key, depth));
  node.addEventListener('mouseleave', () => scheduleClose(depth));
  node.addEventListener('blur', () => scheduleClose(depth));
  // touch: tap a word to hold its note open, tap away to drop it
  node.addEventListener('click', (e) => { e.stopPropagation(); showTip(node, key, depth); });
}

// attach the hover note to anything already marked up with data-term — lets the
// static panels (Rules, Hands & scoring) carry terms without building them in JS
function wireTerms(root) {
  for (const n of root.querySelectorAll('[data-term]')) {
    if (n.dataset.wired) continue;
    n.dataset.wired = '1';
    bindTerm(n, n.dataset.term, 0);
  }
}

// a term that explains itself
function term(key, text, depth = 0) {
  const sp = el('span', 'term', text);
  sp.dataset.term = key;
  sp.dataset.wired = '1';
  bindTerm(sp, key, depth);
  return sp;
}
document.addEventListener('click', (e) => { if (!e.target.closest || !e.target.closest('.tip')) hideTip(); });
window.addEventListener('scroll', hideTip, { passive: true });
// the static panels carry their terms in the markup
wireTerms(document);

const SUIT_TERM = { Man: 'man', Pin: 'pin', Sou: 'sou' };

// "5 Pin" names a suit and "Chun" names a dragon — both are terms in their own
// right, so a tile name in a needs list opens its own note like anything else.
function tileNameEl(name, depth = 0) {
  const wrap = el('span', '');
  const suit = name.match(/^(.*\s)(Man|Pin|Sou)$/);
  if (suit) {
    wrap.append(document.createTextNode(suit[1]));
    wrap.append(term(SUIT_TERM[suit[2]], suit[2], depth));
    return wrap;
  }
  if (SUIT_TERM[name]) { wrap.append(term(SUIT_TERM[name], name, depth)); return wrap; }
  if (['Haku', 'Hatsu', 'Chun'].includes(name)) { wrap.append(term('dragons', name, depth)); return wrap; }
  if (/^(East|South|West|North) Wind$/.test(name)) { wrap.append(term('honours', name, depth)); return wrap; }
  wrap.textContent = name;
  return wrap;
}

// "drop 3 · needs East Wind x3, Red Dragon x1" — the discards AND the draws,
// because a distance on its own never says what you are waiting for, and three
// of a tile with three left is not the same work as three of a fresh one
function routeLabel(r) {
  const wrap = el('span', '');
  const bits = [...r.parts];
  // a bare shape needs a name — unless the whole point of the route IS the
  // declaration, in which case "riichi" says it on its own
  if (!bits.length && !r.riichi && !r.selfDraw) bits.push({ term: null, text: 'any winning hand' });
  let n = 0;
  const add = (node) => { if (n++) wrap.append(el('span', '', ' + ')); wrap.append(node); };
  for (const b of bits) add(b.term ? term(b.term, b.text) : el('span', '', b.text));
  if (r.selfDraw) add(term('selfdraw', 'self-draw only'));
  if (r.riichi) add(term('riichi', 'riichi'));
  return wrap;
}

// A, B or C — the last separator reads as a choice, not another item, unless
// the list was cut short and there is no real last item to point at.
// routes travel as tile keys; the spelled-out name is built here
const wantName = (w) => tileName({ key: w.k, ...keyParts(w.k) });

function tileListEl(wrap, list, cap) {
  const show = cap > 0 ? list.slice(0, cap) : list;
  const cut = list.length - show.length;
  show.forEach((w, i) => {
    if (i) wrap.append(el('span', '', !cut && i === show.length - 1 ? ' or ' : ', '));
    wrap.append(tileNameEl(wantName(w)));
    if (w.left <= (w.count || 1)) wrap.append(el('span', '', ` (${w.left} left)`));
  });
  if (cut > 0) wrap.append(el('span', '', ` +${cut} more`));
}

function routeNeedEl(r, cap = 0) {
  const wrap = el('span', '');
  if (r.away > 0) { wrap.append(term('drop', `drop ${r.away}`)); if (r.wants.length) wrap.append(el('span', '', ' · ')); }
  const short = r.wants.reduce((a, w) => a + w.count, 0);
  // named tiles when the engine sent them, otherwise just how many there are
  const wins = r.wins || [];
  const winsN = r.winsN != null ? r.winsN : wins.length;

  // One tile short. Name every tile that finishes the hand, not just the one
  // the solver happened to trace: a 3-4 wins on 2 or 5, and being told only
  // about the 5 costs you half your outs.
  if (short === 1 && wins.length) {
    wrap.append(term('needs', 'wins on'));
    wrap.append(el('span', '', ' '));
    tileListEl(wrap, wins, cap);
    return wrap;
  }

  if (r.wants.length) {
    const show = cap > 0 ? r.wants.slice(0, cap) : r.wants;
    const rest = r.wants.length - show.length;
    wrap.append(term('needs', 'needs'));
    wrap.append(el('span', '', ' '));
    show.forEach((w, i) => {
      if (i) wrap.append(el('span', '', ', '));
      wrap.append(tileNameEl(wantName(w)));
      wrap.append(el('span', '', `\u00d7${w.count}${w.left <= w.count ? ` (${w.left} left)` : ''}`));
    });
    if (rest > 0) wrap.append(el('span', '', ` +${rest} more`));
    // Further out there is no single answer to print — the plan above is one
    // way to fill the shape. Say how much room there is to manoeuvre instead,
    // and name the tiles when there are few enough to act on.
    if (cap === 0 && winsN) {
      wrap.append(el('span', '', ` · ${winsN} tile${winsN > 1 ? 's' : ''} help${winsN > 1 ? '' : 's'}`));
      if (wins.length) { wrap.append(el('span', '', ': ')); tileListEl(wrap, wins, 0); }
    }
  }
  if (!r.away && !r.wants.length) wrap.append(el('span', 'ready', 'ready'));
  return wrap;
}

let lastRoutes = [];

// The outlook is derived entirely from the view, so it is worked out here rather
// than sent — see positionFromView. renderGame also runs for purely local
// repaints (picking a tile up, muting a call), and re-solving the hand for those
// would cost tens of milliseconds for an identical answer, so key the result on
// the view object itself: a new one means new state, the same one means nothing
// the solver cares about has moved.
let outlookView = null, outlookDeep = false, outlookCache = null;
function outlookOf(view) {
  const deep = waysOpen;          // the full panel wants every route's tiles
  if (view === outlookView && deep === outlookDeep) return outlookCache;
  outlookView = view;
  outlookDeep = deep;
  outlookCache = outlookFor(positionFromView(view), { deep });
  return outlookCache;
}
let waysUnit = 'faan';

// The full list, since the line under the hand only has room for the best one.
// It opens in place rather than over the board — you want to read it WHILE
// looking at your tiles, and the page can scroll if it runs long.
let waysOpen = false;
function toggleWays() {
  waysOpen = !waysOpen;
  paintWays();
  if (lastView) renderGame(lastView, session);   // so the button relabels
}
function paintWays() {
  const panel = $('#ways-panel');
  if (!panel) return;
  panel.classList.toggle('hidden', !waysOpen || !lastRoutes.length);
  if (!waysOpen || !lastRoutes.length) return;
  const body = $('#ways-body');
  const intro = $('#ways-intro');
  body.replaceChildren();
  intro.textContent = lastRoutes.length
    ? `Every shape that still gets you a declarable hand, easiest first. "Drop" is how many tiles in your hand have to go; "needs" is one way to fill what is left. One tile short, that becomes "wins on" — every tile that finishes it, with the number nobody has seen yet when it is getting scarce.`
    : 'Nothing from this hand can be declared any more.';
  for (const r of lastRoutes) {
    const row = el('div', 'ways-row');
    const f = el('span', 'ways-faan');
    f.append(term(waysUnit === 'han' ? 'han' : 'faan', `${r.faan} ${waysUnit}`));
    row.append(f);
    const nm = el('span', 'ways-name');
    nm.append(routeLabel(r));
    row.append(nm);
    const nd = el('span', 'ways-need');
    nd.append(routeNeedEl(r));
    row.append(nd);
    body.append(row);
  }
}

// one row of the score table (name / delta / running total)
function heScoreRow(name, delta, total, deltaCls, ready) {
  const row = el('div', 'he-score-row' + (deltaCls === 'he-score-head' ? ' he-score-head' : ''));
  row.append(el('span', 'he-pname', name));
  row.append(el('span', 'he-delta' + (deltaCls && deltaCls !== 'he-score-head' ? ' ' + deltaCls : ''), delta));
  row.append(el('span', 'he-ptotal', total));
  row.append(el('span', `he-ready${ready === '✓' ? ' is-ready' : ready === '…' ? ' not-ready' : ''}`, ready || ''));
  return row;
}

function showGameOver(view, sess) {
  const m = $('#gameover');
  m.classList.remove('hidden');
  const sorted = [...view.players].sort((a, b) => b.score - a.score);
  $('#go-title').textContent = 'Game Over';
  $('#go-sub').textContent = `${sorted[0].name} wins!`;
  const rank = $('#go-rank');
  rank.replaceChildren();
  for (const p of sorted) {
    const li = el('li', '');
    li.append(el('span', '', p.name));
    li.append(el('span', '', `${p.score}`));
    rank.append(li);
  }

  if (sess.isHost) {
    $('#btn-again').classList.remove('hidden');
    $('#btn-golobby').classList.remove('hidden');
    $('#go-wait').classList.add('hidden');
    $('#btn-again').onclick = () => {
      sess.G = newMatch(sess.roster, sess.selectedVariant);
      sess.broadcast();
    };
    $('#btn-golobby').onclick = () => {
      sess.G = null;
      sess.pushLobby();
    };
  } else {
    $('#btn-again').classList.add('hidden');
    $('#btn-golobby').classList.add('hidden');
    $('#go-wait').classList.remove('hidden');
  }
}

// ---------------------------------------------------------------- create / join

async function createRoom() {
  setBusy(true);
  setHomeStatus('Creating room…');
  const name = cleanName($('#name-input').value) || 'Host';
  try {
    const code = genCode();
    const peer = await openPeer(ID_PREFIX + code);
    session = new HostSession(peer, code, name);
    showScreen('lobby');
    setHomeStatus('');
  } catch (e) {
    setHomeStatus(explainPeerError(e), true);
  }
  setBusy(false);
}

async function joinRoom() {
  setBusy(true);
  const name = cleanName($('#name-input').value) || 'Guest';
  const code = parseCode($('#code-input').value);
  if (!code) { setHomeStatus('Enter a room code.', true); setBusy(false); return; }
  setHomeStatus('Connecting…');
  try {
    const peer = await openPeer();
    session = new GuestSession(peer, code, name);
  } catch (e) {
    setHomeStatus(explainPeerError(e), true);
  }
  setBusy(false);
}

function leaveRoom() {
  if (session) { session.destroy(); session = null; }
  lastView = null;
  lastSess = null;
  pendingMove = false;
  selectedTile = null;
  handOrder = [];
  drawnPin = null;
  seenFxSeq = 0;
  chatSeenN = 0;
  shownDiscardId = null;
  lastRoutes = [];
  waysOpen = false;
  // the hand-end sequence, so the next room starts from a clean slate rather
  // than inheriting a hidden score panel or a spent reveal timer
  clearTimeout(handEndTimer);
  handEndKey = null;
  handEndReady = false;
  scoreHidden = false;
  hideHandEnd();
  paintStep();
  // and the board itself: hand tiles are reused by tile id, which repeat every
  // game, so leaving them in place would carry this room's click handlers into
  // the next one
  $('#hand').replaceChildren();
  $('#action-bar').replaceChildren();
  clearChatBubbles();
  showScreen('home');
  setHomeStatus('');
}

// ---------------------------------------------------------------- boot

$('#btn-create').addEventListener('click', createRoom);
$('#btn-join').addEventListener('click', joinRoom);
$('#code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
$('#name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-create').click(); });
$('#btn-add-bot').addEventListener('click', () => session?.addBot());
$('#btn-start').addEventListener('click', () => session?.start());
$('#btn-size').addEventListener('click', (e) => { e.stopPropagation(); $('#size-popover').classList.toggle('hidden'); });
for (const k of SZ_KEYS) { const el = $(`#sz-${k}`); if (el) el.addEventListener('input', (e) => setSize(k, parseFloat(e.target.value))); }
$('#size-popover').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => $('#size-popover').classList.add('hidden'));
applySizes();
for (const b of document.querySelectorAll('.btn-leave')) b.addEventListener('click', leaveRoom);
for (const b of document.querySelectorAll('.btn-rules')) b.addEventListener('click', () => $('#modal-rules').classList.remove('hidden'));
$('#btn-rules-close').addEventListener('click', () => $('#modal-rules').classList.add('hidden'));
$('#modal-rules').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden'); });
// open the cheatsheet even if rendering hiccups (e.g. a half-cached reload), so
// the button always does something visible
for (const b of document.querySelectorAll('.btn-cheat')) {
  b.addEventListener('click', () => {
    try { renderCheatsheet(); } catch (err) { console.error('cheatsheet render failed', err); }
    $('#modal-cheat')?.classList.remove('hidden');
  });
}
$('#btn-cheat-close')?.addEventListener('click', () => $('#modal-cheat').classList.add('hidden'));
$('#modal-cheat')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden'); });
// NB: the hand-end modal is deliberately NOT dismissible by a backdrop click — it
// holds the host's "Deal next hand" button, and nothing re-opens it during the
// handEnd phase, so dismissing it used to strand the whole table.
$('#chat-toggle').addEventListener('click', () => {
  if ($('#chat-panel').classList.contains('hidden')) openChatPanel();
  else $('#chat-panel').classList.add('hidden');
});
$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = cleanName($('#chat-input').value);
  if (!text || !session) return;
  $('#chat-input').value = '';
  if (session.isHost) {
    const m = { seat: 0, name: session.roster[0].name, text, ts: Date.now() };
    session.chatLog.push(m);
    for (const [, conn] of session.conns) { try { conn.send({ t: 'chat', msg: m }); } catch {} }
    addChatMsg(m, true);
  } else {
    try { session.conn.send({ t: 'chat', text }); } catch {}
  }
});
$('#btn-copy-code').addEventListener('click', () => { navigator.clipboard.writeText(session?.code || ''); toast('Code copied'); });
$('#btn-copy-link').addEventListener('click', () => { navigator.clipboard.writeText(roomLink(session?.code || '')); toast('Link copied'); });

// auto-join from URL
const params = new URLSearchParams(location.search);
if (params.get('room')) {
  $('#code-input').value = params.get('room');
  history.replaceState(null, '', location.pathname);
}

// handle window scroll/resize for bubbles
window.addEventListener('scroll', paintChatBubbles, { passive: true });
window.addEventListener('resize', paintChatBubbles);

