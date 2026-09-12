// game.js — Mahjong rules engine (pure logic, no DOM, no network).
//
// Supports three regional variants:
//   hk  — Hong Kong (Cantonese): 13-tile hand, 3-faan minimum, flowers.
//   tw  — Taiwanese: 16-tile hand, 5 sets + 1 pair, flowers, tai scoring.
//   jp  — Japanese (Riichi): 13-tile hand, yaku required, riichi/dora/furiten.
//
// Tile notation: m1–m9 (man), p1–p9 (pin), s1–s9 (sou),
//   wE/wS/wW/wN (winds), dR/dG/dW (dragons), f1–f8 (flowers/seasons).

export const PROTO = 1;
export const NUM_PLAYERS = 4;
export const WINDS = ['E', 'S', 'W', 'N'];

export const VARIANTS = [
  { key: 'tw', name: 'Taiwanese', blurb: '16-tile hand, 5 sets + 1 pair. Flowers drawn aside for bonuses. Tai-based scoring.' },
  { key: 'hk', name: 'Hong Kong', blurb: '13-tile hand, 3-faan minimum to win. Flowers score bonuses. Classic Cantonese rules.' },
  { key: 'jp', name: 'Japanese (Riichi)', blurb: '13-tile hand, at least 1 yaku to win. Riichi bets, dora bonuses, furiten restriction.' },
];

export function variantByKey(key) {
  return VARIANTS.find((v) => v.key === key) || VARIANTS[0];
}

// ---------------------------------------------------------------- tiles

const SUITS = ['m', 'p', 's'];
const HONOR_WINDS = ['E', 'S', 'W', 'N'];
const HONOR_DRAGONS = ['R', 'G', 'W'];

function tileKey(kind, v) {
  if (kind === 'wind') return `w${v}`;
  if (kind === 'dragon') return `d${v}`;
  if (kind === 'flower') return `f${v}`;
  return `${kind}${v}`;
}

export function tileName(t) {
  if (!t) return '?';
  if (t.kind === 'wind') return { E: 'East', S: 'South', W: 'West', N: 'North' }[t.v] + ' Wind';
  if (t.kind === 'dragon') return { R: 'Red', G: 'Green', W: 'White' }[t.v] + ' Dragon';
  if (t.kind === 'flower') return t.v <= 4 ? `Flower ${t.v}` : `Season ${t.v - 4}`;
  const sn = { m: 'Man', p: 'Pin', s: 'Sou' }[t.kind];
  return `${t.v} ${sn}`;
}

export function tileShort(t) {
  if (!t) return '?';
  return t.key;
}

export function buildDeck(variant) {
  const deck = [];
  let id = 1;
  for (const s of SUITS) {
    for (let v = 1; v <= 9; v++) {
      for (let c = 0; c < 4; c++) {
        const key = tileKey(s, v);
        deck.push({ id: id++, kind: s, v, key, suit: s });
      }
    }
  }
  for (const w of HONOR_WINDS) {
    for (let c = 0; c < 4; c++) {
      deck.push({ id: id++, kind: 'wind', v: w, key: tileKey('wind', w) });
    }
  }
  for (const d of HONOR_DRAGONS) {
    for (let c = 0; c < 4; c++) {
      deck.push({ id: id++, kind: 'dragon', v: d, key: tileKey('dragon', d) });
    }
  }
  if (variant !== 'jp') {
    for (let v = 1; v <= 8; v++) {
      deck.push({ id: id++, kind: 'flower', v, key: tileKey('flower', v) });
    }
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function isNumber(t) {
  return t.kind === 'm' || t.kind === 'p' || t.kind === 's';
}
export function isHonor(t) {
  return t.kind === 'wind' || t.kind === 'dragon';
}
export function isTerminal(t) {
  return isNumber(t) && (t.v === 1 || t.v === 9);
}
export function isTerminalOrHonor(t) {
  return isTerminal(t) || isHonor(t);
}
export function isSameTile(a, b) {
  return a.key === b.key;
}

const TILE_ORDER = (() => {
  const m = {};
  let n = 0;
  for (const s of SUITS) for (let v = 1; v <= 9; v++) m[tileKey(s, v)] = n++;
  for (const w of HONOR_WINDS) m[tileKey('wind', w)] = n++;
  for (const d of HONOR_DRAGONS) m[tileKey('dragon', d)] = n++;
  for (let v = 1; v <= 8; v++) m[tileKey('flower', v)] = n++;
  return m;
})();

export function tileSort(a, b) {
  return (TILE_ORDER[a.key] ?? 99) - (TILE_ORDER[b.key] ?? 99);
}

// ---------------------------------------------------------------- helpers

export function playerBySeat(G, seat) {
  return G.players.find((p) => p.seat === seat);
}

function addLog(G, text) {
  G.feedSeq += 1;
  G.log.push({ n: G.feedSeq, text });
  if (G.log.length > 300) G.log.shift();
}

// kind: null = plain speech bubble; 'claim' = a big call overlay (Pon/Chi/Kan/
// Ron) on the seat; 'discard' = the discarded tile flies out of the seat (tile
// carries {kind,v,key} for the client to draw)
function say(G, seat, text, kind = null, tile = null) {
  G.chatSeq += 1;
  G.chatter.push({ n: G.chatSeq, seat, text, kind, tile });
  if (G.chatter.length > 30) G.chatter.shift();
}

function setFx(G, fx) {
  G.fxSeq += 1;
  G.fx = { seq: G.fxSeq, ...fx };
}

function handSize(variant) {
  return variant === 'tw' ? 16 : 13;
}

function setsNeeded(variant) {
  return variant === 'tw' ? 5 : 4;
}

function nextSeat(seat) {
  return (seat + 1) % 4;
}

function prevSeat(seat) {
  return (seat + 3) % 4;
}

function seatWind(G, seat) {
  return WINDS[(seat - G.dealer + 4) % 4];
}

// ---------------------------------------------------------------- setup

export function newMatch(roster, variantKey) {
  const variant = variantByKey(variantKey).key;
  const players = roster.map((r) => ({
    seat: r.seat,
    name: r.name,
    bot: !!r.bot,
    connected: r.connected !== false,
    hand: [],
    melds: [],
    discards: [],
    flowers: [],
    score: variant === 'jp' ? 25000 : 0,
    riichi: false,
    riichiTurn: -1,
    ippatsu: false,
    furiten: false,
    lastAction: null,
  })).sort((a, b) => a.seat - b.seat);

  const G = {
    proto: PROTO,
    mid: Math.random().toString(36).slice(2, 10),
    variant,
    phase: 'idle',
    roundWind: 'E',
    handNum: 0,
    dealer: 0,
    turn: 0,
    players,
    wall: [],
    deadWall: [],
    dora: [],
    uraDora: [],
    lastDraw: null,
    lastDiscard: null,
    lastDiscardSeat: -1,
    claimPhase: null,
    kanThisTurn: false,
    riichiSticks: 0,
    honba: 0,
    handsPlayed: 0,
    maxHands: variant === 'jp' ? 8 : 16,
    log: [],
    chatter: [],
    chatSeq: 0,
    feedSeq: 0,
    fx: null,
    fxSeq: 0,
    handResult: null,
  };
  dealHand(G);
  return G;
}

function dealHand(G) {
  G.handNum += 1;
  G.phase = 'draw';
  G.lastDraw = null;
  G.lastDiscard = null;
  G.lastDiscardSeat = -1;
  G.claimPhase = null;
  G.kanThisTurn = false;
  G.handResult = null;
  G.turn = G.dealer;

  const deck = shuffle(buildDeck(G.variant));

  // dead wall: 14 tiles for JP, 16 for others
  const deadCount = G.variant === 'jp' ? 14 : 16;
  G.deadWall = deck.splice(0, deadCount);

  // dora (JP only): flip first indicator
  G.dora = [];
  G.uraDora = [];
  if (G.variant === 'jp') {
    G.dora.push(G.deadWall[4]);
    G.uraDora.push(G.deadWall[5]);
  }

  // deal hands
  const hs = handSize(G.variant);
  for (const p of G.players) {
    p.hand = deck.splice(0, hs).sort(tileSort);
    p.melds = [];
    p.discards = [];
    p.flowers = [];
    p.riichi = false;
    p.riichiTurn = -1;
    p.ippatsu = false;
    p.furiten = false;
    p.lastAction = null;
  }

  G.wall = deck;

  // HK/TW: pull flowers from hands and replace
  if (G.variant !== 'jp') {
    for (const p of G.players) {
      replaceFlowers(G, p);
    }
  }

  // dealer gets an extra tile (the opening draw)
  const dealerP = playerBySeat(G, G.dealer);
  const drawn = drawTileFor(G, dealerP);
  if (drawn) G.lastDraw = drawn;

  G.phase = 'discard'; // dealer discards first
  const ew = seatWind(G, G.dealer);
  addLog(G, `— Hand ${G.handNum} — ${WINDS[WINDS.indexOf(G.roundWind)]} round, ${dealerP.name} is East. ${G.wall.length} tiles in the wall.`);
  setFx(G, { kind: 'deal', hand: G.handNum });
}

function drawFromWall(G) {
  if (G.wall.length === 0) return null;
  return G.wall.shift();
}

function drawFromDeadWall(G) {
  if (G.deadWall.length === 0) return null;
  const t = G.deadWall.pop();
  // shift a tile from wall into dead wall to keep it stable
  if (G.wall.length > 0) G.deadWall.unshift(G.wall.pop());
  return t;
}

// Move every flower out of the hand and draw a real replacement for each — a
// replacement that is itself a flower is set aside and re-drawn, so the hand
// keeps its exact size. Used after the initial deal (hand may hold several).
function replaceFlowers(G, p) {
  let f;
  while ((f = p.hand.find((t) => t.kind === 'flower'))) {
    p.hand = p.hand.filter((t) => t.id !== f.id);
    p.flowers.push(f);
    let rep = drawFromWall(G);
    while (rep && rep.kind === 'flower') { p.flowers.push(rep); rep = drawFromWall(G); }
    if (rep) p.hand.push(rep);
    else break; // wall exhausted mid-replacement — the hand ends short, but the round is ending
  }
  p.hand.sort(tileSort);
}

// Draw one tile into p's hand; if it (or its replacement) is a flower, set the
// flower(s) aside and keep drawing until a non-flower lands. Returns the tile
// that actually entered the hand (for lastDraw), or null if the source ran dry.
function drawTileFor(G, p, fromDeadWall = false) {
  const draw = () => (fromDeadWall ? drawFromDeadWall(G) : drawFromWall(G));
  let t = draw();
  while (t && G.variant !== 'jp' && t.kind === 'flower') { p.flowers.push(t); t = draw(); }
  if (!t) return null;
  p.hand.push(t);
  p.hand.sort(tileSort);
  return t;
}

// ---------------------------------------------------------------- legality

export function turnSeat(G) {
  if (G.phase === 'discard') return G.turn;
  return null;
}

export function canDiscard(G, seat) {
  if (G.phase !== 'discard' || G.turn !== seat) return false;
  const p = playerBySeat(G, seat);
  // must have one more tile than normal (just drew / claimed) — each meld holds
  // 3 tiles outside the concealed hand, so account for those
  return p.hand.length === handSize(G.variant) + 1 - 3 * p.melds.length;
}

function canChi(G, seat) {
  if (!G.lastDiscard || G.lastDiscardSeat === seat) return false;
  if (nextSeat(G.lastDiscardSeat) !== seat) return false;
  const t = G.lastDiscard;
  if (!isNumber(t)) return false;
  const p = playerBySeat(G, seat);
  const hand = p.hand;
  const pairs = chiCombos(hand, t);
  return pairs.length > 0;
}

function chiCombos(hand, t) {
  if (!isNumber(t)) return [];
  const combos = [];
  const s = t.kind;
  const v = t.v;
  // possible sequences containing v: (v-2,v-1,v), (v-1,v,v+1), (v,v+1,v+2)
  const has = (suit, val) => hand.some((h) => h.kind === suit && h.v === val);
  const get = (suit, val) => hand.find((h) => h.kind === suit && h.v === val);
  if (v >= 3 && has(s, v - 2) && has(s, v - 1)) combos.push([get(s, v - 2), get(s, v - 1)]);
  if (v >= 2 && v <= 8 && has(s, v - 1) && has(s, v + 1)) combos.push([get(s, v - 1), get(s, v + 1)]);
  if (v <= 7 && has(s, v + 1) && has(s, v + 2)) combos.push([get(s, v + 1), get(s, v + 2)]);
  return combos;
}

function canPon(G, seat) {
  if (!G.lastDiscard || G.lastDiscardSeat === seat) return false;
  const t = G.lastDiscard;
  const p = playerBySeat(G, seat);
  const count = p.hand.filter((h) => h.key === t.key).length;
  return count >= 2;
}

function canOpenKan(G, seat) {
  if (!G.lastDiscard || G.lastDiscardSeat === seat) return false;
  const t = G.lastDiscard;
  const p = playerBySeat(G, seat);
  const count = p.hand.filter((h) => h.key === t.key).length;
  return count >= 3;
}

function canClosedKan(G, seat) {
  if (G.phase !== 'discard' || G.turn !== seat) return false;
  const p = playerBySeat(G, seat);
  const counts = {};
  for (const t of p.hand) counts[t.key] = (counts[t.key] || 0) + 1;
  return Object.values(counts).some((c) => c >= 4);
}

function closedKanKeys(G, seat) {
  const p = playerBySeat(G, seat);
  const counts = {};
  for (const t of p.hand) counts[t.key] = (counts[t.key] || 0) + 1;
  return Object.keys(counts).filter((k) => counts[k] >= 4);
}

function canAddKan(G, seat) {
  if (G.phase !== 'discard' || G.turn !== seat) return false;
  const p = playerBySeat(G, seat);
  for (const m of p.melds) {
    if (m.type === 'pon' && p.hand.some((t) => t.key === m.tiles[0].key)) return true;
  }
  return false;
}

function addKanOptions(G, seat) {
  const p = playerBySeat(G, seat);
  const opts = [];
  for (const m of p.melds) {
    if (m.type === 'pon') {
      const match = p.hand.find((t) => t.key === m.tiles[0].key);
      if (match) opts.push(match);
    }
  }
  return opts;
}

function canRon(G, seat) {
  if (!G.lastDiscard || G.lastDiscardSeat === seat) return false;
  const p = playerBySeat(G, seat);
  // JP furiten check
  if (G.variant === 'jp' && p.furiten) return false;
  const testHand = [...p.hand, G.lastDiscard];
  return isWinningHand(testHand, G.variant, p.melds);
}

function canTsumo(G, seat) {
  if (G.phase !== 'discard' || G.turn !== seat) return false;
  const p = playerBySeat(G, seat);
  // concealed hand shrinks by 3 for every meld — a melded player still has the
  // one extra (just-drawn) tile, so compare against that adjusted size
  if (p.hand.length !== handSize(G.variant) + 1 - 3 * p.melds.length) return false;
  return isWinningHand(p.hand, G.variant, p.melds);
}

function canRiichi(G, seat) {
  if (G.variant !== 'jp') return false;
  if (G.phase !== 'discard' || G.turn !== seat) return false;
  const p = playerBySeat(G, seat);
  if (p.riichi) return false;
  if (p.melds.some((m) => m.open)) return false; // must be concealed
  if (p.score < 1000) return false;
  if (G.wall.length < 4) return false;
  // must be tenpai (1 tile away from winning) after discarding something
  return riichiDiscards(G, seat).length > 0;
}

function riichiDiscards(G, seat) {
  const p = playerBySeat(G, seat);
  const valid = [];
  for (const t of p.hand) {
    const rest = p.hand.filter((h) => h.id !== t.id);
    if (isTenpai(rest, G.variant, p.melds)) valid.push(t);
  }
  return valid;
}

// ---------------------------------------------------------------- moves

export function applyMove(G, seat, move) {
  if (!G || !move) return { ok: false, error: 'Bad move' };
  const p = playerBySeat(G, seat);
  if (!p) return { ok: false, error: 'Not at the table' };
  if (G.phase === 'over') return { ok: false, error: 'Game is over' };

  if (move.kind === 'discard') return doDiscard(G, p, move);
  if (move.kind === 'chi') return doChi(G, p, move);
  if (move.kind === 'pon') return doPon(G, p, move);
  if (move.kind === 'kan') return doKan(G, p, move);
  if (move.kind === 'ron') return doRon(G, p, move);
  if (move.kind === 'tsumo') return doTsumo(G, p, move);
  if (move.kind === 'riichi') return doRiichi(G, p, move);
  if (move.kind === 'pass') return doPass(G, p, move);
  return { ok: false, error: 'Unknown action' };
}

function doDiscard(G, p, move) {
  if (G.phase !== 'discard' || G.turn !== p.seat) return { ok: false, error: 'Not your turn to discard' };
  const tile = p.hand.find((t) => t.id === move.tileId);
  if (!tile) return { ok: false, error: 'Tile not in hand' };

  p.hand = p.hand.filter((t) => t.id !== tile.id);
  p.discards.push(tile);
  p.lastAction = `discarded ${tileShort(tile)}`;

  // JP furiten: if you discard a tile you could win on, you're furiten
  if (G.variant === 'jp') {
    p.ippatsu = false;
    updateFuriten(G, p);
  }

  G.lastDiscard = tile;
  G.lastDiscardSeat = p.seat;
  G.kanThisTurn = false;

  addLog(G, `${p.name} discards ${tileName(tile)}.`);
  // no bubble/announcement — the tile itself sits in the centre (rendered from
  // G.lastDiscard) until it's claimed or the next player draws

  // check if anyone can claim
  enterClaimPhase(G);
  return { ok: true };
}

function doRiichi(G, p, move) {
  if (!canRiichi(G, p.seat)) return { ok: false, error: 'Cannot declare riichi' };
  const tile = p.hand.find((t) => t.id === move.tileId);
  if (!tile) return { ok: false, error: 'Tile not in hand' };
  // verify this discard leaves tenpai
  const rest = p.hand.filter((h) => h.id !== tile.id);
  if (!isTenpai(rest, G.variant, p.melds)) return { ok: false, error: 'Must be tenpai after discard' };

  p.riichi = true;
  p.riichiTurn = G.handNum;
  p.ippatsu = true;
  p.score -= 1000;
  G.riichiSticks += 1;

  p.hand = rest;
  p.discards.push({ ...tile, riichi: true });
  p.lastAction = `declared riichi, discarded ${tileShort(tile)}`;

  G.lastDiscard = tile;
  G.lastDiscardSeat = p.seat;

  addLog(G, `${p.name} declares Riichi! 🀄`);
  say(G, p.seat, 'Riichi! 🀄');
  setFx(G, { kind: 'riichi', seat: p.seat });

  enterClaimPhase(G);
  return { ok: true };
}

function doChi(G, p, move) {
  if (G.phase !== 'claim') return { ok: false, error: 'Not in claim phase' };
  if (!canChi(G, p.seat)) return { ok: false, error: 'Cannot chi' };
  const combos = chiCombos(p.hand, G.lastDiscard);
  const combo = combos.find((c) =>
    c.some((t) => t.id === move.tile1) && c.some((t) => t.id === move.tile2));
  if (!combo) return { ok: false, error: 'Invalid chi combination' };

  // Chi is the lowest priority — it can't be taken while another player may still
  // Pon, Kan or Ron this tile. They must pass first.
  if (pendingRivalPriority(G, p.seat) > CLAIM_PRIORITY.chi) {
    return { ok: false, error: 'Another player may Pon or Ron — wait for them to pass' };
  }

  // register claim — resolved after all responses
  registerClaim(G, p.seat, 'chi', { tiles: combo });
  return { ok: true };
}

function doPon(G, p, move) {
  if (G.phase !== 'claim') return { ok: false, error: 'Not in claim phase' };
  if (!canPon(G, p.seat)) return { ok: false, error: 'Cannot pon' };
  // only a possible Ron outranks a Pon — wait for a would-be winner to pass
  if (pendingRivalPriority(G, p.seat) > CLAIM_PRIORITY.pon) {
    return { ok: false, error: 'Another player may Ron — wait for them to pass' };
  }
  registerClaim(G, p.seat, 'pon', {});
  return { ok: true };
}

function doKan(G, p, move) {
  // open kan (on a discard)
  if (G.phase === 'claim') {
    if (!canOpenKan(G, p.seat)) return { ok: false, error: 'Cannot kan' };
    // only a possible Ron outranks a Kan — wait for a would-be winner to pass
    if (pendingRivalPriority(G, p.seat) > CLAIM_PRIORITY.kan) {
      return { ok: false, error: 'Another player may Ron — wait for them to pass' };
    }
    registerClaim(G, p.seat, 'kan', {});
    return { ok: true };
  }
  // closed kan or add kan (on your turn)
  if (G.phase === 'discard' && G.turn === p.seat) {
    if (move.type === 'closed') {
      const key = move.tileKey;
      if (!closedKanKeys(G, p.seat).includes(key)) return { ok: false, error: 'Cannot declare closed kan' };
      const tiles = p.hand.filter((t) => t.key === key).slice(0, 4);
      p.hand = p.hand.filter((t) => !tiles.some((x) => x.id === t.id));
      p.melds.push({ type: 'kan', tiles, open: false });
      addLog(G, `${p.name} declares a closed kan of ${tileName(tiles[0])}.`);
      say(G, p.seat, 'Kan!', 'claim');
      // JP: new dora indicator
      if (G.variant === 'jp' && G.dora.length < 5) {
        G.dora.push(G.deadWall[4 + (G.dora.length) * 2]);
        G.uraDora.push(G.deadWall[5 + (G.uraDora.length) * 2]);
      }
      // draw replacement from dead wall
      const rep = drawTileFor(G, p, true);
      if (rep) G.lastDraw = rep;
      G.kanThisTurn = true;
      // still in discard phase — player must discard (or tsumo)
      return { ok: true };
    }
    if (move.type === 'add') {
      const opts = addKanOptions(G, p.seat);
      const tile = opts.find((t) => t.id === move.tileId);
      if (!tile) return { ok: false, error: 'Cannot add to this pon' };
      // TODO: JP — others can ron on the added tile (chankan)
      p.hand = p.hand.filter((t) => t.id !== tile.id);
      const meld = p.melds.find((m) => m.type === 'pon' && m.tiles[0].key === tile.key);
      meld.type = 'kan';
      meld.tiles.push(tile);
      addLog(G, `${p.name} upgrades a pon to kan with ${tileName(tile)}.`);
      say(G, p.seat, 'Kan!', 'claim');
      if (G.variant === 'jp' && G.dora.length < 5) {
        G.dora.push(G.deadWall[4 + (G.dora.length) * 2]);
        G.uraDora.push(G.deadWall[5 + (G.uraDora.length) * 2]);
      }
      const rep = drawTileFor(G, p, true);
      if (rep) G.lastDraw = rep;
      G.kanThisTurn = true;
      return { ok: true };
    }
    return { ok: false, error: 'Invalid kan type' };
  }
  return { ok: false, error: 'Cannot kan now' };
}

function doRon(G, p, move) {
  if (G.phase !== 'claim') return { ok: false, error: 'Not in claim phase' };
  if (!canRon(G, p.seat)) return { ok: false, error: 'Cannot ron' };
  registerClaim(G, p.seat, 'ron', {});
  return { ok: true };
}

function doTsumo(G, p, move) {
  if (!canTsumo(G, p.seat)) return { ok: false, error: 'Cannot tsumo' };
  resolveWin(G, p.seat, null, true);
  return { ok: true };
}

function doPass(G, p, move) {
  if (G.phase !== 'claim') return { ok: false, error: 'Not in claim phase' };
  if (!G.claimPhase) return { ok: false, error: 'No claim phase' };
  registerClaim(G, p.seat, 'pass', {});
  return { ok: true };
}

// ---------------------------------------------------------------- claim resolution

function enterClaimPhase(G) {
  const eligible = [];
  for (const p of G.players) {
    if (p.seat === G.lastDiscardSeat) continue;
    const opts = [];
    if (canRon(G, p.seat)) opts.push('ron');
    if (canOpenKan(G, p.seat)) opts.push('kan');
    if (canPon(G, p.seat)) opts.push('pon');
    if (canChi(G, p.seat)) opts.push('chi');
    if (opts.length > 0) eligible.push({ seat: p.seat, opts, response: null });
  }
  if (eligible.length === 0) {
    advanceTurn(G);
    return;
  }
  G.phase = 'claim';
  G.claimPhase = { eligible, tile: G.lastDiscard };
}

function registerClaim(G, seat, type, data) {
  if (!G.claimPhase) return;
  const entry = G.claimPhase.eligible.find((e) => e.seat === seat);
  if (!entry) return;
  entry.response = { type, ...data };

  const elig = G.claimPhase.eligible;
  // everyone has answered — resolve now
  if (elig.every((e) => e.response !== null)) { resolveClaims(G); return; }

  // otherwise, resolve early if nothing still pending could beat what we already
  // have: a Pon (priority 2) outranks a Chi (1), so a player sitting on a Chi
  // shouldn't hold up a Pon that's already been declared. Only resolve when the
  // best answer so far *strictly* beats every possible pending claim, so ties
  // (e.g. two players who could Ron) still wait for all responses.
  const prio = (t) => CLAIM_PRIORITY[t] || 0;
  const bestSoFar = Math.max(0, ...elig
    .filter((e) => e.response && e.response.type !== 'pass')
    .map((e) => prio(e.response.type)));
  const bestPending = Math.max(0, ...elig
    .filter((e) => e.response === null)
    .map((e) => Math.max(0, ...e.opts.map(prio))));
  if (bestSoFar > bestPending) resolveClaims(G);
}

const CLAIM_PRIORITY = { ron: 4, kan: 3, pon: 2, chi: 1, pass: 0 };

// the highest-priority claim still open to a *rival* (another eligible player who
// hasn't passed). A lower claim must wait for these to decline — you can't Chi
// while someone may Pon, nor Pon while someone may Ron. Ron sits at the top and
// is never gated by this.
function pendingRivalPriority(G, seat) {
  if (!G.claimPhase) return 0;
  let best = 0;
  for (const e of G.claimPhase.eligible) {
    if (e.seat === seat) continue;
    if (e.response && e.response.type === 'pass') continue; // already declined
    for (const o of e.opts) best = Math.max(best, CLAIM_PRIORITY[o] || 0);
  }
  return best;
}

function resolveClaims(G) {
  const cp = G.claimPhase;
  if (!cp) return;

  // sort by priority (ron > kan > pon > chi)
  const claims = cp.eligible
    .filter((e) => e.response && e.response.type !== 'pass')
    .sort((a, b) => (CLAIM_PRIORITY[b.response.type] || 0) - (CLAIM_PRIORITY[a.response.type] || 0));

  G.claimPhase = null;

  if (claims.length === 0) {
    advanceTurn(G);
    return;
  }

  const winner = claims[0];
  const p = playerBySeat(G, winner.seat);
  const tile = G.lastDiscard;

  // remove the tile from discardor's discard pile (it was claimed)
  const disc = playerBySeat(G, G.lastDiscardSeat);
  disc.discards = disc.discards.filter((t) => t.id !== tile.id);

  if (winner.response.type === 'ron') {
    p.hand.push(tile);
    p.hand.sort(tileSort);
    G.lastDiscard = null; // taken off the table
    resolveWin(G, p.seat, G.lastDiscardSeat, false);
    return;
  }

  if (winner.response.type === 'kan') {
    const tiles = p.hand.filter((h) => h.key === tile.key).slice(0, 3);
    tiles.push(tile);
    p.hand = p.hand.filter((h) => !tiles.slice(0, 3).some((x) => x.id === h.id));
    p.melds.push({ type: 'kan', tiles, open: true, from: G.lastDiscardSeat });
    G.lastDiscard = null; // taken off the table into the meld
    addLog(G, `${p.name} calls Kan on ${tileName(tile)}!`);
    say(G, p.seat, 'Kan!', 'claim');
    if (G.variant === 'jp' && G.dora.length < 5) {
      G.dora.push(G.deadWall[4 + (G.dora.length) * 2]);
      G.uraDora.push(G.deadWall[5 + (G.uraDora.length) * 2]);
    }
    const rep = drawTileFor(G, p, true);
    if (rep) G.lastDraw = rep;
    G.turn = p.seat;
    G.phase = 'discard';
    G.kanThisTurn = true;
    return;
  }

  if (winner.response.type === 'pon') {
    const tiles = p.hand.filter((h) => h.key === tile.key).slice(0, 2);
    p.hand = p.hand.filter((h) => !tiles.some((x) => x.id === h.id));
    p.melds.push({ type: 'pon', tiles: [...tiles, tile], open: true, from: G.lastDiscardSeat });
    addLog(G, `${p.name} calls Pon on ${tileName(tile)}!`);
    say(G, p.seat, 'Pon!', 'claim');
    G.turn = p.seat;
    G.phase = 'discard';
    G.lastDraw = null;
    G.lastDiscard = null;
    return;
  }

  if (winner.response.type === 'chi') {
    const combo = winner.response.tiles;
    p.hand = p.hand.filter((h) => !combo.some((x) => x.id === h.id));
    const meldTiles = [...combo, tile].sort(tileSort);
    p.melds.push({ type: 'chi', tiles: meldTiles, open: true, from: G.lastDiscardSeat });
    addLog(G, `${p.name} calls Chi: ${meldTiles.map(tileName).join(', ')}!`);
    say(G, p.seat, 'Chi!', 'claim');
    G.turn = p.seat;
    G.phase = 'discard';
    G.lastDraw = null;
    G.lastDiscard = null;
    return;
  }
}

function advanceTurn(G) {
  // keep G.lastDiscard set: the just-discarded tile stays resting in the centre
  // (shown there, skipped from the tray) until the next player discards — then
  // it settles into that player's discard pile. It's cleared only on a claim
  // (pon/chi/kan/ron) or a new hand.
  const next = nextSeat(G.turn);
  G.turn = next;

  // check for wall exhaustion (exhaustive draw)
  if (G.wall.length === 0) {
    resolveExhaustiveDraw(G);
    return;
  }

  const p = playerBySeat(G, next);

  // JP: clear ippatsu for everyone after a full round
  if (G.variant === 'jp') {
    for (const q of G.players) {
      if (q.seat !== p.seat) q.ippatsu = false;
    }
  }

  // draw (flowers are set aside and re-drawn, so the hand keeps its size)
  const drawn = drawTileFor(G, p);
  if (!drawn) {
    resolveExhaustiveDraw(G);
    return;
  }
  G.lastDraw = drawn;

  G.phase = 'discard';
  G.kanThisTurn = false;
}

function resolveExhaustiveDraw(G) {
  addLog(G, 'The wall is exhausted — draw game.');
  const before = {};
  for (const p of G.players) before[p.seat] = p.score;
  const tenpai = G.players.filter((p) => isTenpai(p.hand, G.variant, p.melds)).map((p) => p.seat);
  // JP: tenpai payments
  if (G.variant === 'jp') {
    const tenpaiSeats = G.players.filter((p) => tenpai.includes(p.seat));
    const notTenpai = G.players.filter((p) => !tenpai.includes(p.seat));
    if (tenpaiSeats.length > 0 && tenpaiSeats.length < 4) {
      const pool = 3000;
      const pay = Math.floor(pool / notTenpai.length);
      const recv = Math.floor(pool / tenpaiSeats.length);
      for (const p of notTenpai) p.score -= pay;
      for (const p of tenpaiSeats) p.score += recv;
      addLog(G, `Tenpai: ${tenpaiSeats.map((p) => p.name).join(', ')}. Non-tenpai pay ${pay} each.`);
    }
  }
  const delta = {};
  for (const p of G.players) delta[p.seat] = p.score - before[p.seat];
  G.handResult = { type: 'draw', exhaustive: true, tenpai, delta };
  setFx(G, { kind: 'handEnd', result: 'draw' });
  // dealer stays if tenpai (JP) or always for HK/TW draw
  const dealerTenpai = isTenpai(playerBySeat(G, G.dealer).hand, G.variant, playerBySeat(G, G.dealer).melds);
  if (G.variant === 'jp' && !dealerTenpai) {
    advanceDealer(G);
  }
  G.honba += 1;
  G.phase = 'handEnd';
}

// ---------------------------------------------------------------- win resolution

function resolveWin(G, winnerSeat, loserSeat, isTsumo) {
  const winner = playerBySeat(G, winnerSeat);
  // snapshot every score so the hand-end breakdown can show the exact net change
  const before = {};
  for (const p of G.players) before[p.seat] = p.score;
  const scoring = scoreHand(G, winnerSeat, loserSeat, isTsumo);

  let payments;
  if (isTsumo) {
    addLog(G, `${winner.name} declares Tsumo — ${scoring.summary}!`);
    say(G, winnerSeat, 'Tsumo! 🀄');
    // all others pay
    const each = G.variant === 'jp'
      ? jpTsumoPayments(scoring.points, winnerSeat === G.dealer)
      : Math.ceil(scoring.points / 3);
    for (const p of G.players) {
      if (p.seat === winnerSeat) continue;
      const pay = G.variant === 'jp'
        ? (p.seat === G.dealer ? each.dealer : each.nonDealer)
        : each;
      p.score -= pay;
      winner.score += pay;
    }
    payments = G.variant === 'jp'
      ? { mode: 'tsumo', dealer: each.dealer, nonDealer: each.nonDealer }
      : { mode: 'tsumo', each };
  } else {
    const loser = playerBySeat(G, loserSeat);
    addLog(G, `${winner.name} wins by Ron from ${loser.name} — ${scoring.summary}!`);
    say(G, winnerSeat, 'Ron!', 'claim');
    loser.score -= scoring.points;
    winner.score += scoring.points;
    payments = { mode: 'ron', from: loserSeat, amount: scoring.points };
  }

  // JP: collect riichi sticks and honba on top of the hand value
  let bonus = null;
  if (G.variant === 'jp') {
    const riichi = G.riichiSticks * 1000;
    const honba = G.honba * 300;
    winner.score += riichi + honba;
    if (riichi || honba) bonus = { riichi, honba };
    G.riichiSticks = 0;
  }

  const delta = {};
  for (const p of G.players) delta[p.seat] = p.score - before[p.seat];

  G.handResult = {
    type: 'win',
    winner: winnerSeat,
    loser: loserSeat,
    tsumo: isTsumo,
    scoring,
    payments,
    bonus,
    delta,
  };
  setFx(G, { kind: 'handEnd', result: 'win', seat: winnerSeat });

  // dealer rotation: dealer stays if they won
  if (winnerSeat === G.dealer) {
    G.honba += 1;
  } else {
    advanceDealer(G);
    G.honba = 0;
  }
  G.phase = 'handEnd';
}

function advanceDealer(G) {
  const oldDealer = G.dealer;
  G.dealer = nextSeat(G.dealer);
  // if we've gone around once, advance the round wind
  if (G.dealer === 0) {
    const wi = WINDS.indexOf(G.roundWind);
    if (wi < 3) G.roundWind = WINDS[wi + 1];
  }
}

function jpTsumoPayments(total, isDealer) {
  if (isDealer) {
    const each = Math.ceil(total / 3);
    return { dealer: each, nonDealer: each };
  }
  const dealerPay = Math.ceil(total / 2);
  const nonDealerPay = Math.ceil(total / 4);
  return { dealer: dealerPay, nonDealer: nonDealerPay };
}

export function nextHand(G) {
  if (G.phase !== 'handEnd') return false;
  G.handsPlayed += 1;
  if (G.handsPlayed >= G.maxHands || isGameEnd(G)) {
    endGame(G);
    return true;
  }
  dealHand(G);
  return true;
}

function isGameEnd(G) {
  if (G.variant === 'jp') {
    // end if anyone is below 0
    if (G.players.some((p) => p.score < 0)) return true;
  }
  return G.handsPlayed >= G.maxHands;
}

function endGame(G) {
  G.phase = 'over';
  const best = Math.max(...G.players.map((p) => p.score));
  const winners = G.players.filter((p) => p.score === best);
  addLog(G, `Game over — ${winners.map((w) => w.name).join(' & ')} win${winners.length === 1 ? 's' : ''} with ${best} points!`);
  setFx(G, { kind: 'over' });
}

// ---------------------------------------------------------------- win detection

// Standard winning hand: N sets + 1 pair
// Also checks seven pairs (JP) and thirteen orphans
export function isWinningHand(hand, variant, melds = []) {
  const closed = hand.map((t) => t.key);
  const meldCount = melds.length;
  const need = setsNeeded(variant) - meldCount;

  // standard form: need sets from closed tiles + 1 pair
  if (canDecompose(closed, need)) return true;

  // seven pairs (JP and HK)
  if (variant !== 'tw' && meldCount === 0 && closed.length === 14) {
    if (isSevenPairs(closed)) return true;
  }

  // thirteen orphans (kokushi)
  if (variant === 'jp' && meldCount === 0 && closed.length === 14) {
    if (isThirteenOrphans(closed)) return true;
  }

  return false;
}

function canDecompose(keys, setsNeeded) {
  if (setsNeeded < 0) return false;
  const sorted = [...keys].sort();
  const counts = {};
  for (const k of sorted) counts[k] = (counts[k] || 0) + 1;

  // try each possible pair
  for (const pairKey of Object.keys(counts)) {
    if (counts[pairKey] < 2) continue;
    const rem = { ...counts };
    rem[pairKey] -= 2;
    if (rem[pairKey] === 0) delete rem[pairKey];
    if (extractSets(rem, setsNeeded)) return true;
  }
  return false;
}

function extractSets(counts, need) {
  if (need === 0) {
    return Object.values(counts).every((v) => v === 0);
  }
  // find first non-zero key
  let first = null;
  for (const k of Object.keys(counts).sort()) {
    if (counts[k] > 0) { first = k; break; }
  }
  if (!first) return need === 0;

  // try triplet
  if (counts[first] >= 3) {
    const c = { ...counts };
    c[first] -= 3;
    if (c[first] === 0) delete c[first];
    if (extractSets(c, need - 1)) return true;
  }

  // try sequence (numbers only)
  const parsed = parseKey(first);
  if (parsed && parsed.suit) {
    const k2 = `${parsed.suit}${parsed.v + 1}`;
    const k3 = `${parsed.suit}${parsed.v + 2}`;
    if (counts[k2] > 0 && counts[k3] > 0) {
      const c = { ...counts };
      c[first] -= 1;
      c[k2] -= 1;
      c[k3] -= 1;
      if (c[first] === 0) delete c[first];
      if (c[k2] === 0) delete c[k2];
      if (c[k3] === 0) delete c[k3];
      if (extractSets(c, need - 1)) return true;
    }
  }

  return false;
}

function parseKey(key) {
  if (key.length >= 2 && SUITS.includes(key[0])) {
    return { suit: key[0], v: parseInt(key.slice(1), 10) };
  }
  return null;
}

function isSevenPairs(keys) {
  if (keys.length !== 14) return false;
  const counts = {};
  for (const k of keys) counts[k] = (counts[k] || 0) + 1;
  const vals = Object.values(counts);
  return vals.length === 7 && vals.every((v) => v === 2);
}

function isThirteenOrphans(keys) {
  const required = ['m1', 'm9', 'p1', 'p9', 's1', 's9', 'wE', 'wS', 'wW', 'wN', 'dR', 'dG', 'dW'];
  const counts = {};
  for (const k of keys) counts[k] = (counts[k] || 0) + 1;
  for (const r of required) {
    if (!counts[r]) return false;
  }
  // must have exactly one pair among the 13 terminal/honor tiles
  return keys.length === 14;
}

// tenpai: is the hand 1 tile away from winning?
function isTenpai(hand, variant, melds) {
  // try adding each possible tile
  const allKeys = [];
  for (const s of SUITS) for (let v = 1; v <= 9; v++) allKeys.push(tileKey(s, v));
  for (const w of HONOR_WINDS) allKeys.push(tileKey('wind', w));
  for (const d of HONOR_DRAGONS) allKeys.push(tileKey('dragon', d));

  for (const key of allKeys) {
    const testHand = [...hand, { key, kind: key[0] === 'w' ? 'wind' : key[0] === 'd' ? 'dragon' : key[0], v: key.slice(1) }];
    if (isWinningHand(testHand, variant, melds)) return true;
  }
  return false;
}

function updateFuriten(G, p) {
  // a player is furiten if they've discarded any of their winning tiles
  const waits = getWaits(p.hand, G.variant, p.melds);
  p.furiten = p.discards.some((d) => waits.includes(d.key));
}

function getWaits(hand, variant, melds) {
  const waits = [];
  const allKeys = [];
  for (const s of SUITS) for (let v = 1; v <= 9; v++) allKeys.push(tileKey(s, v));
  for (const w of HONOR_WINDS) allKeys.push(tileKey('wind', w));
  for (const d of HONOR_DRAGONS) allKeys.push(tileKey('dragon', d));

  for (const key of allKeys) {
    const testHand = [...hand, { key, kind: key[0] === 'w' ? 'wind' : key[0] === 'd' ? 'dragon' : key[0], v: key.slice(1) }];
    if (isWinningHand(testHand, variant, melds)) waits.push(key);
  }
  return waits;
}

// ---------------------------------------------------------------- scoring

function scoreHand(G, winnerSeat, loserSeat, isTsumo) {
  if (G.variant === 'jp') return scoreJP(G, winnerSeat, loserSeat, isTsumo);
  if (G.variant === 'tw') return scoreTW(G, winnerSeat, loserSeat, isTsumo);
  return scoreHK(G, winnerSeat, loserSeat, isTsumo);
}

// ---- Hong Kong scoring (faan-based)
function scoreHK(G, winnerSeat, loserSeat, isTsumo) {
  const p = playerBySeat(G, winnerSeat);
  const hand = p.hand;
  const melds = p.melds;
  const allTiles = [...hand, ...melds.flatMap((m) => m.tiles)];
  const faan = [];

  // self-draw
  if (isTsumo) faan.push({ name: 'Self-draw', val: 1 });

  // all concealed
  if (melds.every((m) => !m.open) && !isTsumo) faan.push({ name: 'Concealed hand', val: 1 });

  // seat wind triplet/kan
  const sw = seatWind(G, winnerSeat);
  if (hasTripletOf(hand, melds, 'wind', sw)) faan.push({ name: 'Seat wind', val: 1 });

  // round wind triplet/kan
  if (hasTripletOf(hand, melds, 'wind', G.roundWind)) faan.push({ name: 'Round wind', val: 1 });

  // dragon triplets
  for (const d of HONOR_DRAGONS) {
    if (hasTripletOf(hand, melds, 'dragon', d)) {
      faan.push({ name: `${d === 'R' ? 'Red' : d === 'G' ? 'Green' : 'White'} dragon`, val: 1 });
    }
  }

  // all sequences (no triplets except pair)
  if (isAllSequences(hand, melds, G.variant)) faan.push({ name: 'All sequences', val: 1 });

  // all triplets
  if (isAllTriplets(hand, melds, G.variant)) faan.push({ name: 'All triplets', val: 3 });

  // mixed one suit (one number suit + honors)
  if (isMixedFlush(allTiles)) faan.push({ name: 'Mixed flush', val: 3 });

  // full flush (one suit only, no honors)
  if (isFullFlush(allTiles)) faan.push({ name: 'Full flush', val: 6 });

  // all honors
  if (allTiles.every((t) => isHonor(t))) faan.push({ name: 'All honors', val: 10 });

  // flowers
  const flowerFaan = p.flowers.length;
  if (flowerFaan > 0) faan.push({ name: `${flowerFaan} flower${flowerFaan > 1 ? 's' : ''}`, val: flowerFaan });

  const total = faan.reduce((s, f) => s + f.val, 0);
  const points = hkFaanToPoints(total);
  return { faan, total, points, summary: `${total} faan (${points} pts)`, yaku: faan };
}

function hkFaanToPoints(faan) {
  if (faan < 3) return 0; // minimum 3 faan
  if (faan <= 3) return 8;
  if (faan === 4) return 16;
  if (faan === 5) return 32;
  if (faan === 6) return 48;
  if (faan === 7) return 64;
  if (faan >= 8 && faan <= 9) return 128;
  return 256; // 10+ faan: max
}

// ---- Japanese scoring (han + fu)
function scoreJP(G, winnerSeat, loserSeat, isTsumo) {
  const p = playerBySeat(G, winnerSeat);
  const hand = p.hand;
  const melds = p.melds;
  const allTiles = [...hand, ...melds.flatMap((m) => m.tiles)];
  const isConcealed = melds.every((m) => !m.open);
  const yaku = [];

  // riichi
  if (p.riichi) {
    yaku.push({ name: 'Riichi', han: 1 });
    if (p.ippatsu) yaku.push({ name: 'Ippatsu', han: 1 });
  }

  // tsumo (concealed only)
  if (isTsumo && isConcealed) yaku.push({ name: 'Menzen Tsumo', han: 1 });

  // tanyao (no terminals or honors)
  if (allTiles.every((t) => isNumber(t) && t.v >= 2 && t.v <= 8)) {
    yaku.push({ name: 'Tanyao', han: 1 });
  }

  // yakuhai (value tiles)
  const sw = seatWind(G, winnerSeat);
  if (hasTripletOf(hand, melds, 'wind', sw)) yaku.push({ name: `Seat wind (${sw})`, han: 1 });
  if (hasTripletOf(hand, melds, 'wind', G.roundWind)) yaku.push({ name: `Round wind (${G.roundWind})`, han: 1 });
  for (const d of HONOR_DRAGONS) {
    if (hasTripletOf(hand, melds, 'dragon', d)) {
      yaku.push({ name: `${d === 'R' ? 'Chun' : d === 'G' ? 'Hatsu' : 'Haku'}`, han: 1 });
    }
  }

  // pinfu (all sequences, valueless pair, two-sided wait, concealed)
  if (isConcealed && isAllSequences(hand, melds, 'jp')) {
    yaku.push({ name: 'Pinfu', han: 1 });
  }

  // iipeiko (two identical sequences, concealed)
  if (isConcealed && hasIipeiko(hand, melds)) yaku.push({ name: 'Iipeiko', han: 1 });

  // all triplets
  if (isAllTriplets(hand, melds, 'jp')) yaku.push({ name: 'Toitoi', han: 2 });

  // seven pairs
  if (isConcealed && hand.length === 14 && isSevenPairs(hand.map((t) => t.key))) {
    yaku.push({ name: 'Chiitoitsu', han: 2 });
  }

  // mixed flush
  if (isMixedFlush(allTiles)) yaku.push({ name: 'Honitsu', han: isConcealed ? 3 : 2 });

  // full flush
  if (isFullFlush(allTiles)) yaku.push({ name: 'Chinitsu', han: isConcealed ? 6 : 5 });

  // thirteen orphans
  if (isConcealed && hand.length === 14 && isThirteenOrphans(hand.map((t) => t.key))) {
    return { yaku: [{ name: 'Kokushi Musou', han: 13 }], han: 13, fu: 0, points: 32000, summary: 'Yakuman! Kokushi Musou (32000 pts)' };
  }

  // dora bonus
  let doraCount = 0;
  for (const indicator of G.dora) {
    const dk = doraKey(indicator);
    doraCount += allTiles.filter((t) => t.key === dk).length;
  }
  if (p.riichi) {
    for (const indicator of G.uraDora) {
      const dk = doraKey(indicator);
      doraCount += allTiles.filter((t) => t.key === dk).length;
    }
  }
  if (doraCount > 0) yaku.push({ name: `Dora (${doraCount})`, han: doraCount });

  const totalHan = yaku.reduce((s, y) => s + y.han, 0);
  if (totalHan === 0) {
    return { yaku: [], han: 0, fu: 0, points: 0, summary: 'No yaku — cannot win' };
  }

  const fu = calculateFu(G, hand, melds, isTsumo, isConcealed, winnerSeat);
  const points = jpHanFuToPoints(totalHan, fu, winnerSeat === G.dealer);
  return { yaku, han: totalHan, fu, points, summary: `${totalHan} han ${fu} fu (${points} pts)` };
}

function doraKey(indicator) {
  if (!indicator) return '';
  const k = indicator.key;
  const p = parseKey(k);
  if (p) {
    const nv = p.v === 9 ? 1 : p.v + 1;
    return `${p.suit}${nv}`;
  }
  if (k.startsWith('w')) {
    const idx = HONOR_WINDS.indexOf(k[1]);
    return `w${HONOR_WINDS[(idx + 1) % 4]}`;
  }
  if (k.startsWith('d')) {
    const idx = HONOR_DRAGONS.indexOf(k[1]);
    return `d${HONOR_DRAGONS[(idx + 1) % 3]}`;
  }
  return '';
}

function calculateFu(G, hand, melds, isTsumo, isConcealed, winnerSeat) {
  let fu = 20; // base fu
  if (isTsumo) fu += 2;
  else if (isConcealed) fu += 10; // menzen ron

  // meld fu
  for (const m of melds) {
    if (m.type === 'pon') {
      let base = isTerminalOrHonor(m.tiles[0]) ? 4 : 2;
      if (!m.open) base *= 2;
      fu += base;
    } else if (m.type === 'kan') {
      let base = isTerminalOrHonor(m.tiles[0]) ? 16 : 8;
      if (!m.open) base *= 2;
      fu += base;
    }
  }

  // closed triplets in hand
  const handKeys = hand.map((t) => t.key);
  const counts = {};
  for (const k of handKeys) counts[k] = (counts[k] || 0) + 1;
  // pair fu
  for (const [k, c] of Object.entries(counts)) {
    if (c >= 2) {
      const t = hand.find((h) => h.key === k);
      if (t && isHonor(t)) {
        if (t.kind === 'dragon') fu += 2;
        const sw = seatWind(G, winnerSeat);
        if (t.kind === 'wind' && t.v === sw) fu += 2;
        if (t.kind === 'wind' && t.v === G.roundWind) fu += 2;
      }
    }
  }

  // round up to next 10
  return Math.ceil(fu / 10) * 10;
}

function jpHanFuToPoints(han, fu, isDealer) {
  if (han >= 13) return isDealer ? 48000 : 32000; // yakuman
  if (han >= 11) return isDealer ? 36000 : 24000; // sanbaiman
  if (han >= 8) return isDealer ? 24000 : 16000; // baiman
  if (han >= 6) return isDealer ? 18000 : 12000; // haneman
  if (han >= 5) return isDealer ? 12000 : 8000; // mangan

  // basic points = fu × 2^(han+2), capped at mangan
  const basic = fu * Math.pow(2, han + 2);
  if (basic >= 2000) return isDealer ? 12000 : 8000; // mangan cap

  if (isDealer) {
    return Math.ceil((basic * 6) / 100) * 100;
  }
  return Math.ceil((basic * 4) / 100) * 100;
}

// ---- Taiwanese scoring (tai-based)
function scoreTW(G, winnerSeat, loserSeat, isTsumo) {
  const p = playerBySeat(G, winnerSeat);
  const hand = p.hand;
  const melds = p.melds;
  const allTiles = [...hand, ...melds.flatMap((m) => m.tiles)];
  const isConcealed = melds.every((m) => !m.open);
  const tai = [];

  // self-draw
  if (isTsumo) tai.push({ name: 'Self-draw', val: 1 });

  // concealed hand
  if (isConcealed) tai.push({ name: 'Concealed hand', val: 1 });

  // seat wind
  const sw = seatWind(G, winnerSeat);
  if (hasTripletOf(hand, melds, 'wind', sw)) tai.push({ name: 'Seat wind', val: 1 });

  // round wind
  if (hasTripletOf(hand, melds, 'wind', G.roundWind)) tai.push({ name: 'Round wind', val: 1 });

  // dragons
  for (const d of HONOR_DRAGONS) {
    if (hasTripletOf(hand, melds, 'dragon', d)) {
      tai.push({ name: `${d === 'R' ? 'Red' : d === 'G' ? 'Green' : 'White'} dragon`, val: 1 });
    }
  }

  // all triplets
  if (isAllTriplets(hand, melds, 'tw')) tai.push({ name: 'All triplets', val: 4 });

  // mixed flush
  if (isMixedFlush(allTiles)) tai.push({ name: 'Mixed flush', val: 4 });

  // full flush
  if (isFullFlush(allTiles)) tai.push({ name: 'Full flush', val: 8 });

  // flowers (1 tai each)
  if (p.flowers.length > 0) tai.push({ name: `${p.flowers.length} flower(s)`, val: p.flowers.length });

  const total = Math.max(1, tai.reduce((s, t) => s + t.val, 0));
  // additive Taiwanese scoring: a flat base (底) plus a fixed amount per tai (台),
  // so each tai is worth a clear, equal number of points and the total adds up
  const base = 1000;   // 底
  const perTai = 500;  // 台
  const points = base + total * perTai;
  return { tai, total, points, base, perTai, summary: `${total} tai — ${points} pts`, yaku: tai };
}

// ---------------------------------------------------------------- scoring helpers

function hasTripletOf(hand, melds, kind, val) {
  // check melds
  for (const m of melds) {
    if ((m.type === 'pon' || m.type === 'kan') && m.tiles[0].kind === kind && m.tiles[0].v === val) return true;
  }
  // check closed triplets in hand
  const count = hand.filter((t) => t.kind === kind && t.v === val).length;
  return count >= 3;
}

function isAllSequences(hand, melds, variant) {
  // all melds must be chi
  for (const m of melds) {
    if (m.type !== 'chi') return false;
  }
  // closed hand must decompose into sequences + 1 pair
  const closed = hand.map((t) => t.key);
  const need = setsNeeded(variant) - melds.length;
  return canDecomposeAllSequences(closed, need);
}

function canDecomposeAllSequences(keys, setsNeeded) {
  const counts = {};
  for (const k of keys) counts[k] = (counts[k] || 0) + 1;
  for (const pairKey of Object.keys(counts)) {
    if (counts[pairKey] < 2) continue;
    const rem = { ...counts };
    rem[pairKey] -= 2;
    if (rem[pairKey] === 0) delete rem[pairKey];
    if (extractSequencesOnly(rem, setsNeeded)) return true;
  }
  return false;
}

function extractSequencesOnly(counts, need) {
  if (need === 0) return Object.values(counts).every((v) => v === 0);
  let first = null;
  for (const k of Object.keys(counts).sort()) {
    if (counts[k] > 0) { first = k; break; }
  }
  if (!first) return need === 0;
  const parsed = parseKey(first);
  if (!parsed || !parsed.suit) return false; // honor can't form sequence
  const k2 = `${parsed.suit}${parsed.v + 1}`;
  const k3 = `${parsed.suit}${parsed.v + 2}`;
  if (!counts[k2] || !counts[k3]) return false;
  const c = { ...counts };
  c[first] -= 1; c[k2] -= 1; c[k3] -= 1;
  if (c[first] === 0) delete c[first];
  if (c[k2] === 0) delete c[k2];
  if (c[k3] === 0) delete c[k3];
  return extractSequencesOnly(c, need - 1);
}

function isAllTriplets(hand, melds, variant) {
  for (const m of melds) {
    if (m.type === 'chi') return false;
  }
  const closed = hand.map((t) => t.key);
  const need = setsNeeded(variant) - melds.length;
  return canDecomposeAllTriplets(closed, need);
}

function canDecomposeAllTriplets(keys, setsNeeded) {
  const counts = {};
  for (const k of keys) counts[k] = (counts[k] || 0) + 1;
  for (const pairKey of Object.keys(counts)) {
    if (counts[pairKey] < 2) continue;
    const rem = { ...counts };
    rem[pairKey] -= 2;
    if (rem[pairKey] === 0) delete rem[pairKey];
    if (extractTripletsOnly(rem, setsNeeded)) return true;
  }
  return false;
}

function extractTripletsOnly(counts, need) {
  if (need === 0) return Object.values(counts).every((v) => v === 0);
  for (const k of Object.keys(counts)) {
    if (counts[k] >= 3) {
      const c = { ...counts };
      c[k] -= 3;
      if (c[k] === 0) delete c[k];
      if (extractTripletsOnly(c, need - 1)) return true;
    }
  }
  return false;
}

function isMixedFlush(tiles) {
  const nonHonor = tiles.filter((t) => isNumber(t));
  if (nonHonor.length === 0) return false;
  const hasHonor = tiles.some((t) => isHonor(t));
  if (!hasHonor) return false;
  const suit = nonHonor[0].kind;
  return nonHonor.every((t) => t.kind === suit);
}

function isFullFlush(tiles) {
  const nonFlower = tiles.filter((t) => t.kind !== 'flower');
  if (nonFlower.length === 0) return false;
  if (nonFlower.some((t) => isHonor(t))) return false;
  const suit = nonFlower[0].kind;
  return nonFlower.every((t) => t.kind === suit);
}

function hasIipeiko(hand, melds) {
  // two identical sequences in a concealed hand
  if (melds.length > 0) return false; // must be fully concealed for this check
  // try decomposing and looking for duplicate sequences
  const keys = hand.map((t) => t.key);
  const counts = {};
  for (const k of keys) counts[k] = (counts[k] || 0) + 1;

  for (const pairKey of Object.keys(counts)) {
    if (counts[pairKey] < 2) continue;
    const rem = { ...counts };
    rem[pairKey] -= 2;
    if (rem[pairKey] === 0) delete rem[pairKey];
    const seqs = extractAllSequences(rem);
    if (seqs && hasDuplicateSequence(seqs)) return true;
  }
  return false;
}

function extractAllSequences(counts) {
  const seqs = [];
  const c = { ...counts };
  for (const k of Object.keys(c).sort()) {
    while (c[k] > 0) {
      const p = parseKey(k);
      if (!p || !p.suit) return null; // honor left over
      const k2 = `${p.suit}${p.v + 1}`;
      const k3 = `${p.suit}${p.v + 2}`;
      if (c[k2] > 0 && c[k3] > 0) {
        c[k] -= 1; c[k2] -= 1; c[k3] -= 1;
        if (c[k] === 0) delete c[k];
        if (c[k2] === 0) delete c[k2];
        if (c[k3] === 0) delete c[k3];
        seqs.push(`${k}-${k2}-${k3}`);
      } else {
        return null;
      }
    }
  }
  return seqs;
}

function hasDuplicateSequence(seqs) {
  const seen = new Set();
  for (const s of seqs) {
    if (seen.has(s)) return true;
    seen.add(s);
  }
  return false;
}

// ---------------------------------------------------------------- bot AI

export function botChoose(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p) return null;

  // claim phase: decide whether to claim
  if (G.phase === 'claim' && G.claimPhase) {
    const entry = G.claimPhase.eligible.find((e) => e.seat === seat);
    if (!entry || entry.response) return null;
    // a claim can't be taken while a higher-priority rival is still deciding; in
    // that case wait (return null) rather than attempt an illegal move that would
    // be rejected and stall the bot loop
    const rival = pendingRivalPriority(G, seat);

    // always ron if possible (Ron is never gated)
    if (entry.opts.includes('ron') && canRon(G, seat)) {
      return { kind: 'ron' };
    }
    // pon if it helps (always pon for simplicity)
    if (entry.opts.includes('pon') && canPon(G, seat) && Math.random() < 0.4) {
      if (rival > CLAIM_PRIORITY.pon) return null; // a possible Ron is pending — wait
      return { kind: 'pon' };
    }
    // chi sometimes
    if (entry.opts.includes('chi') && canChi(G, seat) && Math.random() < 0.3) {
      if (rival > CLAIM_PRIORITY.chi) return null; // a possible Pon/Kan/Ron is pending — wait
      const combos = chiCombos(p.hand, G.lastDiscard);
      if (combos.length > 0) {
        return { kind: 'chi', tile1: combos[0][0].id, tile2: combos[0][1].id };
      }
    }
    return { kind: 'pass' };
  }

  // discard phase
  if (G.phase === 'discard' && G.turn === seat) {
    // check tsumo
    if (canTsumo(G, seat)) return { kind: 'tsumo' };

    // check riichi
    if (canRiichi(G, seat)) {
      const discards = riichiDiscards(G, seat);
      if (discards.length > 0) {
        return { kind: 'riichi', tileId: discards[0].id };
      }
    }

    // if riichi, must discard the drawn tile (only legal discard)
    if (p.riichi && G.lastDraw) {
      return { kind: 'discard', tileId: G.lastDraw.id };
    }

    // discard strategy: discard the most "dangerous" / least useful tile
    const tile = botPickDiscard(G, p);
    return { kind: 'discard', tileId: tile.id };
  }

  return null;
}

function botPickDiscard(G, p) {
  // simple strategy: discard isolated honor/terminal tiles first,
  // then isolated number tiles, then the tile furthest from a set
  const hand = p.hand;
  if (hand.length === 0) return null;

  // score each tile by "usefulness"
  const scored = hand.map((t) => {
    let score = 0;
    const same = hand.filter((h) => h.key === t.key).length;
    score += same * 10; // pairs/triplets are valuable
    if (isNumber(t)) {
      // connected tiles are valuable
      const neighbors = hand.filter((h) =>
        h.kind === t.kind && Math.abs(h.v - t.v) === 1).length;
      score += neighbors * 5;
      // near-connected
      const near = hand.filter((h) =>
        h.kind === t.kind && Math.abs(h.v - t.v) === 2).length;
      score += near * 2;
      // middle tiles more flexible
      if (t.v >= 3 && t.v <= 7) score += 2;
    }
    if (isHonor(t)) {
      if (same >= 2) score += 15; // pair of honors
      // value tiles extra
      const sw = seatWind(G, p.seat);
      if (t.kind === 'wind' && (t.v === sw || t.v === G.roundWind)) score += 5;
      if (t.kind === 'dragon') score += 3;
    }
    return { tile: t, score };
  });

  // sort ascending (worst first), discard the least useful
  scored.sort((a, b) => a.score - b.score);
  return scored[0].tile;
}

// ---------------------------------------------------------------- view

export function viewFor(G, seat, code) {
  const p = playerBySeat(G, seat);
  const players = G.players.map((q) => {
    const isMe = q.seat === seat;
    return {
      seat: q.seat,
      name: q.name,
      bot: q.bot,
      connected: q.connected,
      hand: isMe ? q.hand : q.hand.map(() => null), // hide others' tiles
      melds: q.melds,
      discards: q.discards,
      flowers: q.flowers,
      score: q.score,
      riichi: q.riichi,
      tileCount: q.hand.length,
      lastAction: q.lastAction,
    };
  });

  // claim options for this player
  let claimOpts = null;
  if (G.phase === 'claim' && G.claimPhase) {
    const entry = G.claimPhase.eligible.find((e) => e.seat === seat);
    if (entry && !entry.response) {
      // options a higher-priority rival is still sitting on are shown but locked
      const rival = pendingRivalPriority(G, seat);
      claimOpts = {
        tile: G.claimPhase.tile,
        options: entry.opts,
        chiCombos: entry.opts.includes('chi') ? chiCombos(p.hand, G.lastDiscard) : [],
        blockedOpts: entry.opts.filter((o) => (CLAIM_PRIORITY[o] || 0) < rival),
      };
    }
  }

  // action options during discard phase
  let actions = null;
  if (G.phase === 'discard' && G.turn === seat) {
    actions = {
      canTsumo: canTsumo(G, seat),
      canRiichi: canRiichi(G, seat),
      riichiDiscards: canRiichi(G, seat) ? riichiDiscards(G, seat).map((t) => t.id) : [],
      canClosedKan: canClosedKan(G, seat),
      closedKanKeys: closedKanKeys(G, seat),
      canAddKan: canAddKan(G, seat),
      addKanOptions: addKanOptions(G, seat).map((t) => t.id),
    };
  }

  return {
    variant: G.variant,
    phase: G.phase,
    roundWind: G.roundWind,
    handNum: G.handNum,
    dealer: G.dealer,
    turn: G.turn,
    mySeat: seat,
    players,
    wallCount: G.wall.length,
    deadWallCount: G.deadWall.length,
    dora: G.dora,
    lastDiscard: G.lastDiscard,
    lastDiscardSeat: G.lastDiscardSeat,
    lastDraw: (G.turn === seat) ? G.lastDraw : null,
    claimOpts,
    actions,
    riichiSticks: G.riichiSticks,
    honba: G.honba,
    handResult: G.handResult,
    code,
    log: G.log.slice(-30),
    chatter: G.chatter,
    chatSeq: G.chatSeq,
    feedSeq: G.feedSeq,
    fx: G.fx,
    fxSeq: G.fxSeq,
  };
}

// ---------------------------------------------------------------- lifecycle

export function markReconnected(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p || p.connected) return false;
  p.connected = true;
  p.botFor = false;
  addLog(G, `${p.name} reconnected.`);
  return true;
}

export function markDisconnected(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p || !p.connected) return false;
  p.connected = false;
  addLog(G, `${p.name} disconnected.`);
  return true;
}

export function markBotTakeover(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p) return false;
  p.botFor = true;
  addLog(G, `A bot takes over for ${p.name}.`);
  return true;
}

export function markSeatClaimed(G, seat, name) {
  const p = playerBySeat(G, seat);
  if (!p) return false;
  p.name = name;
  p.connected = true;
  p.botFor = false;
  addLog(G, `${name} takes over seat ${seat}.`);
  return true;
}

export function markSeatResigned(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p) return false;
  p.connected = false;
  p.botFor = false;
  addLog(G, `${p.name} resigned their seat.`);
  return true;
}
