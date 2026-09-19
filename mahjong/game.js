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
// The suits go by their own names — Man, Pin, Sou — not by translations of
// them, and one map feeds every place a suit is spelled out so the two sets can
// never appear side by side again. What they mean is a hover away in the
// glossary, and the Rules panel introduces both.
export const SUIT_WORD = { m: 'Man', p: 'Pin', s: 'Sou' };
// likewise the three dragons, glossed as colours wherever they are introduced
export const DRAGON_WORD = { R: 'Chun', G: 'Hatsu', W: 'Haku' };
// the glossary key for each, so a scoring line can point at the actual tile
const DRAGON_TERM = { R: 'chun', G: 'hatsu', W: 'haku' };
const HONOR_WINDS = ['E', 'S', 'W', 'N'];
const HONOR_DRAGONS = ['R', 'G', 'W'];
// Haku -> Hatsu -> Chun -> Haku: the order a dora indicator walks, which is not
// the order above (see doraKey)
const DRAGON_DORA_ORDER = ['W', 'G', 'R'];

function tileKey(kind, v) {
  if (kind === 'wind') return `w${v}`;
  if (kind === 'dragon') return `d${v}`;
  if (kind === 'flower') return `f${v}`;
  return `${kind}${v}`;
}

export function tileName(t) {
  if (!t) return '?';
  if (t.kind === 'wind') return { E: 'East', S: 'South', W: 'West', N: 'North' }[t.v] + ' Wind';
  if (t.kind === 'dragon') return DRAGON_WORD[t.v];
  if (t.kind === 'flower') return t.v <= 4 ? `Flower ${t.v}` : `Season ${t.v - 4}`;
  return `${t.v} ${SUIT_WORD[t.kind]}`;
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

// opts.faanLimit — a Hong Kong house limit, in faan. Anything at or above it
// pays what that many faan pays. 0 is no limit, which is what the table does on
// its own. It is fixed for the whole match on purpose: what a hand is worth
// should not change between one hand and the next.
export function newMatch(roster, variantKey, opts = {}) {
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
    faanLimit: Math.max(0, Math.round(Number(opts.faanLimit) || 0)),
    // what the END of a hand decided about the NEXT one, held until it is dealt
    pendingDeal: null,
    handsPlayed: 0,
    maxHands: variant === 'jp' ? 8 : 16,
    log: [],
    chatter: [],
    chatSeq: 0,
    feedSeq: 0,
    fx: null,
    fxSeq: 0,
    handResult: null,
    readyNext: [],
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
  if (G.variant === 'jp') revealDora(G, 'Opening');

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
  if (!isWinningHand(testHand, G.variant, p.melds)) return false;
  return meetsWinMinimum(G, seat, G.lastDiscardSeat, false);
}

function canTsumo(G, seat) {
  if (G.phase !== 'discard' || G.turn !== seat) return false;
  const p = playerBySeat(G, seat);
  // concealed hand shrinks by 3 for every meld — a melded player still has the
  // one extra (just-drawn) tile, so compare against that adjusted size
  if (p.hand.length !== handSize(G.variant) + 1 - 3 * p.melds.length) return false;
  if (!isWinningHand(p.hand, G.variant, p.melds)) return false;
  return meetsWinMinimum(G, seat, null, true);
}

// What a win would be worth if it were declared right now — scored, but not
// committed. For a ron the winning tile isn't in the hand yet, so it is lent to
// the hand for the duration of the scoring and taken straight back out. None of
// the scorers mutate G, so this is safe to ask speculatively.
function wouldScore(G, seat, loserSeat, isTsumo) {
  const p = playerBySeat(G, seat);
  const lent = isTsumo ? null : G.lastDiscard;
  if (lent) p.hand.push(lent);
  try {
    return scoreHand(G, seat, loserSeat, isTsumo);
  } finally {
    if (lent) p.hand.pop();
  }
}

// A hand shaped like a win isn't necessarily one you're allowed to declare.
// Hong Kong has a three-faan minimum and Riichi needs a yaku — without this a
// player could stop the hand with something worth nothing, which is exactly what
// scoring it at 0 points was telling us. Taiwanese has no floor.
function meetsWinMinimum(G, seat, loserSeat, isTsumo) {
  if (G.variant === 'tw') return true;
  const s = wouldScore(G, seat, loserSeat, isTsumo);
  if (G.variant === 'hk') return (s.total || 0) >= HK_MIN_FAAN;
  // Riichi: dora are a bonus on top of a yaku, never a yaku by themselves
  return (s.yaku || []).some((y) => !/^Dora/.test(y.name));
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
  if (move.kind === 'next') return doNext(G, p);
  return { ok: false, error: 'Unknown action' };
}

// Everyone still at the table has to finish reading the score before the next
// hand is dealt — the deal wipes the board, and being the host is no reason to
// take that away from the other three. A bot has nothing to read and a
// disconnected seat cannot answer, so neither of those holds anybody up.
export function waitingOnNext(G) {
  if (G.phase !== 'handEnd') return [];
  const ready = G.readyNext || [];
  return G.players
    .filter((p) => !p.bot && !p.botFor && p.connected && !ready.includes(p.seat))
    .map((p) => p.seat);
}

// Deal once the last person we were waiting on has answered — or has left, which
// is the same thing from the table's point of view. Without the second case a
// player dropping out while everyone else has already pressed would strand the
// hand: nobody left to press, and every remaining button already spent.
function maybeDeal(G) {
  if (G.phase !== 'handEnd') return false;
  if (!(G.readyNext || []).length) return false;   // nobody has asked to move on
  if (waitingOnNext(G).length) return false;
  return nextHand(G);
}

function doNext(G, p) {
  if (G.phase !== 'handEnd') return { ok: false, error: 'The hand is not over' };
  if (!G.readyNext) G.readyNext = [];
  if (!G.readyNext.includes(p.seat)) {
    G.readyNext.push(p.seat);
    addLog(G, `${p.name} is ready for the next hand.`);
  }
  maybeDeal(G);
  return { ok: true };
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
      revealDora(G, `${p.name}'s kan turns up a new`);
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
      revealDora(G, `${p.name}'s kan turns up a new`);
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
    revealDora(G, `${p.name}'s kan turns up a new`);
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
  // The winds the hand was PLAYED under. advanceDealer runs a few lines below,
  // so by the time anyone reads the result the seats have already turned — and
  // the score panel was labelling every player with next hand's wind while
  // showing this hand's scoring. A West pung scored by the West seat came back
  // as a South player who had somehow been paid for a seat wind.
  G.handResult = { type: 'draw', exhaustive: true, tenpai, delta };
  setFx(G, { kind: 'handEnd', result: 'draw' });
  // dealer stays if tenpai (JP) or always for HK/TW draw
  const dealerTenpai = isTenpai(playerBySeat(G, G.dealer).hand, G.variant, playerBySeat(G, G.dealer).melds);
  G.pendingDeal = { rotate: G.variant === 'jp' && !dealerTenpai, honba: G.honba + 1 };
  G.phase = 'handEnd';
  G.readyNext = [];
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
    // All others pay. Riichi splits the hand value between them (dealer pays more);
    // Hong Kong and Taiwanese both have each player pay the hand IN FULL on a
    // self-draw, which is what makes tsumo worth three times a win on a discard.
    const each = G.variant === 'jp'
      ? jpTsumoPayments(scoring.points, winnerSeat === G.dealer)
      : scoring.points;
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

  // The deal passes unless the dealer won — but not yet. See pendingDeal.
  const keeps = winnerSeat === G.dealer;
  G.pendingDeal = { rotate: !keeps, honba: keeps ? G.honba + 1 : 0 };
  G.phase = 'handEnd';
  G.readyNext = [];
}

// Rotating the seats the moment a hand ends is a lie told to everybody still
// looking at the result: the score panel is the hand that was just played, and
// under it every player had already been renamed with the wind they will hold
// NEXT hand. A West seat paid for a West pung came back as a South player who
// had somehow been credited with a seat wind. So the hand keeps its own dealer,
// its own round and its own honba until the next hand is dealt, and what
// changes is recorded rather than applied.
function applyPendingDeal(G) {
  const pend = G.pendingDeal;
  G.pendingDeal = null;
  if (!pend) return;
  if (pend.rotate) advanceDealer(G);
  G.honba = pend.honba;
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
  G.readyNext = [];
  G.handsPlayed += 1;
  if (G.handsPlayed >= G.maxHands || isGameEnd(G)) {
    endGame(G);
    return true;
  }
  applyPendingDeal(G);
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

// Player-facing cheatsheet of the special hands each ruleset scores. Kept next to
// the scorers below — update both together if a hand's value changes.
export const SCORING_GUIDE = [
  {
    key: 'hk',
    name: 'Hong Kong',
    unit: 'faan',
    note: '13-tile hand: 4 sets + a pair. Minimum 3 faan to win. Faan → points: 3→8, 4→16, 5→32, 6→48, 7→64, and doubling every faan after that — 8→128, 9→256, 10→512. The host can cap it with a house limit, in which case every hand at or above the limit pays the same.',
    rows: [
      ['Self-draw', '1', 'Win on the tile you drew yourself'],
      ['Concealed hand', '1', 'Win on a discard with no open melds'],
      ['Seat wind', '1', 'Triplet (or kan) of your own seat wind'],
      ['Round wind', '1', 'Triplet (or kan) of the prevailing round wind'],
      ['Dragon triplet', '1 each', 'Triplet of Haku, Hatsu or Chun (white, green, red)'],
      ['All sequences', '1', 'Every set is a run'],
      ['All triplets', '3', 'Every set is a triplet or kan'],
      ['Mixed flush', '3', 'One suit plus honours'],
      ['Full flush', '6', 'A single suit, no honours'],
      ['All honours', '10', 'Only winds and dragons'],
      ['Flowers', '1 each', 'Each flower / season you drew'],
    ],
  },
  {
    key: 'jp',
    name: 'Japanese Riichi',
    unit: 'han',
    note: '13-tile hand: 4 sets + a pair. To declare a win you need at least 1 han that is not dora — that is what a yaku is, and the rows below are the list. A complete hand with no yaku cannot be won on: you keep playing. Riichi, Menzen Tsumo and Tanyao are the easy ones. The payout comes from han + fu, and the dealer pays and receives more.',
    rows: [
      ['Riichi', '1', 'Declared while concealed and tenpai (1000 pt bet)'],
      ['Ippatsu', '1', 'Win within one go-around of your riichi'],
      ['Menzen Tsumo', '1', 'Self-draw with a fully concealed hand'],
      ['Tanyao', '1', 'No terminals (1 or 9) and no honours'],
      ['Seat wind', '1', 'Triplet of your seat wind'],
      ['Round wind', '1', 'Triplet of the round wind'],
      ['Haku / Hatsu / Chun', '1 each', 'Triplet of the white, green or red dragon'],
      ['Pinfu', '1', 'All sequences, concealed'],
      ['Iipeiko', '1', 'Two identical sequences, concealed'],
      ['Toitoi', '2', 'Every set is a triplet or kan'],
      ['Chiitoitsu', '2', 'Seven pairs, concealed'],
      ['Honitsu', '3 / 2', 'One suit plus honours (concealed / open)'],
      ['Chinitsu', '6 / 5', 'A single suit, no honours (concealed / open)'],
      ['Kokushi Musou', '13', 'Thirteen orphans — yakuman, 32000 pts'],
      ['Dora', '+1 each', 'Each dora tile; ura-dora also count after riichi. A bonus only — never a yaku by itself'],
    ],
  },
  {
    key: 'tw',
    name: 'Taiwanese',
    unit: 'tai',
    note: '16-tile hand: 5 sets + a pair. Points are additive: a flat 200 base (底) plus 200 for every tai (台), so 3 tai pays 200 + 600 = 800. Every hand scores at least 1 tai. On a self-draw each of the other three pays the full amount.',
    rows: [
      ['Self-draw', '1', 'Win on the tile you drew yourself'],
      ['Concealed hand', '1', 'No open melds'],
      ['Seat wind', '1', 'Triplet (or kan) of your own seat wind'],
      ['Round wind', '1', 'Triplet (or kan) of the prevailing round wind'],
      ['Dragon triplet', '1 each', 'Triplet of Haku, Hatsu or Chun (white, green, red)'],
      ['All triplets', '4', 'Every set is a triplet or kan'],
      ['Mixed flush', '4', 'One suit plus honours'],
      ['Full flush', '8', 'A single suit, no honours'],
      ['Flowers', '1 each', 'Each flower / season you drew'],
    ],
  },
];

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
      faan.push({ name: `${DRAGON_WORD[d]} (dragon)`, val: 1 });
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
  const points = hkFaanToPoints(total, G.faanLimit);
  return { faan, total, points, summary: `${total} faan (${points} pts)`, yaku: faan };
}

// ---- Hong Kong: what a hand is already worth, whatever happens next.
//
// Only two things can't be taken away mid-hand: flowers, which are set aside the
// moment they're drawn, and the honour pungs inside a declared meld, which can't
// be broken up. Everything else in scoreHK — the flushes, all-triplets, the
// triplets still sitting concealed — survives only as long as you don't discard
// out of it, so none of it belongs in a floor. HK needs three faan to win at
// all, which is what makes the floor worth showing.
export const HK_MIN_FAAN = 3;

// How many unturned flowers a route is allowed to be counting on. Two is the
// point where it stops being a plan and starts being a wish — and without a cap
// every shape on the board, however worthless, becomes a "3 faan route" that
// needs three flowers nobody has seen.
const MAX_PETAL_LIFT = 2;

function hkLockedFaan(pos) {
  if (pos.variant !== 'hk') return null;
  const p = pos, sw = pos.seatWind;
  const parts = [];

  if (p.flowers.length > 0) {
    parts.push({ term: 'flowers', name: `${p.flowers.length} flower${p.flowers.length > 1 ? 's' : ''}`, val: p.flowers.length });
  }
  for (const m of p.melds) {
    const t = m.tiles[0];
    if (!t) continue;
    // seat wind and round wind score separately, so the same pung can pay twice
    if (t.kind === 'wind' && t.v === sw) parts.push({ term: 'seatwind', name: 'Seat wind', val: 1 });
    if (t.kind === 'wind' && t.v === pos.roundWind) parts.push({ term: 'roundwind', name: 'Round wind', val: 1 });
    // point at the dragon itself, not at "a dragon pung": the line already
    // names which one, and a note that explains all three is no answer to
    // "what is this tile?"
    if (t.kind === 'dragon') {
      parts.push({ term: DRAGON_TERM[t.v], name: DRAGON_WORD[t.v], val: 1 });
    }
  }
  const total = parts.reduce((a, f) => a + f.val, 0);
  return { total, yakuHan: total, parts, minToWin: HK_MIN_FAAN, unit: 'faan', goal: `${HK_MIN_FAAN}+ faan` };
}

// The bottom of the table has its own shape — the step from 5 to 6 is half a
// double, not a whole one — and from 7 up it simply doubles, with no ceiling.
// A limit is the usual house rule and there is none here on purpose: a big hand
// is paid what the table says it is worth, which for a 20-faan hand is 8388608
// points. Anything that rare is a story rather than a score.
export function hkFaanToPoints(faan, limit = 0) {
  if (faan < HK_MIN_FAAN) return 0; // below the minimum — not a declarable win
  // A house limit is the usual answer to a table with no ceiling: at the limit
  // and above, every hand pays the same.
  if (limit >= HK_MIN_FAAN && faan > limit) faan = limit;
  if (faan === 3) return 8;
  if (faan === 4) return 16;
  if (faan === 5) return 32;
  if (faan === 6) return 48;
  return 64 * Math.pow(2, faan - 7);
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

// Turn up an indicator and put it in the log with what it actually points at —
// an indicator that appears silently in the middle of the table explains
// nothing, and the tile it names is never the tile it is.
function revealDora(G, why) {
  if (G.variant !== 'jp' || G.dora.length >= 5) return;
  const ind = G.deadWall[4 + G.dora.length * 2];
  const ura = G.deadWall[5 + G.uraDora.length * 2];
  if (!ind) return;
  G.dora.push(ind);
  if (ura) G.uraDora.push(ura);
  const dk = doraKey(ind);
  addLog(G, `${why} dora indicator ${tileName(ind)} — so ${tileName({ key: dk, ...keyParts(dk) })} is dora.`);
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
    // NOT the order HONOR_DRAGONS happens to be declared in. The dora cycle for
    // dragons runs Haku -> Hatsu -> Chun -> Haku; reading it off an array that
    // starts at Chun ran it backwards, so a White indicator pointed at Red
    // instead of Green.
    const idx = DRAGON_DORA_ORDER.indexOf(k[1]);
    return `d${DRAGON_DORA_ORDER[(idx + 1) % DRAGON_DORA_ORDER.length]}`;
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
      tai.push({ name: `${DRAGON_WORD[d]} (dragon)`, val: 1 });
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
  // Taiwanese scoring: a flat base (底) plus a fixed amount per tai (台). Additive
  // so every scoring element is worth a stated number of points and the lines on
  // the hand-end screen add up to the total.
  const base = 200;    // 底
  const perTai = 200;  // 台
  const points = base + total * perTai;
  return { tai, total, points, base, perTai, summary: `${total} tai (${points} pts)`, yaku: tai };
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

// Every tile anyone at the table can legally see, minus this player's own hand.
// Bots read the same board a human does — discards and melds, never a concealed
// hand — so nothing here is a peek.
function visibleCounts(G, exceptSeat) {
  const seen = new Array(34).fill(0);
  const bump = (t) => { const i = keyIdx(t.key); if (i >= 0) seen[i]++; };
  for (const q of G.players) {
    for (const t of q.discards) bump(t);
    for (const m of q.melds) for (const t of m.tiles) bump(t);
  }
  for (const d of G.dora) bump(d);
  return seen;
}

// The best hand this player could still DECLARE, given these concealed tiles:
// nearest first, then biggest. Self-draw is always available, so a shape one
// short of the minimum still counts.
function bestDeclarableHK(G, p, hand, seen) {
  const routes = hkRoutesFor({
    hand, melds: p.melds, flowers: p.flowers,
    seatWind: seatWind(G, p.seat), roundWind: G.roundWind, seen,
  });
  let best = null;
  for (const r of routes) {
    const faan = r.shape >= HK_MIN_FAAN ? r.shape : r.shape + 1;
    if (faan < HK_MIN_FAAN) continue;
    if (!best || r.away < best.away || (r.away === best.away && faan > best.faan)) {
      best = { away: r.away, faan };
    }
  }
  return best;
}

function botPickDiscard(G, p) {
  // simple strategy: discard isolated honor/terminal tiles first,
  // then isolated number tiles, then the tile furthest from a set
  const hand = p.hand;
  if (hand.length === 0) return null;

  // Copies sitting in our own melds count too: a tile matching a meld is pair or
  // kan material, and without this a chi strands the spare copy (claiming 3m with
  // 1m2m leaves a lone 3m with no neighbours left in hand), so the bot would chi
  // a tile and then immediately discard the identical one.
  const meldKeys = p.melds.flatMap((m) => m.tiles.map((t) => t.key));

  // score each tile by "usefulness"
  const scored = hand.map((t) => {
    let score = 0;
    const same = hand.filter((h) => h.key === t.key).length
      + meldKeys.filter((k) => k === t.key).length;
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

  // Hong Kong needs three faan, not merely a complete hand. Shape alone builds
  // tidy all-sequence hands that can never be declared, so each candidate
  // discard is judged by the best DECLARABLE hand left afterwards: how far away
  // it is first, then what it pays, and only then the shape heuristic above as a
  // tie-break. One solve per distinct tile, so a turn costs a handful of ms.
  if (G.variant === 'hk') {
    const seen = visibleCounts(G, p.seat);
    const byKey = new Map();
    for (const s of scored) {
      let ev = byKey.get(s.tile.key);
      if (ev === undefined) {
        ev = bestDeclarableHK(G, p, hand.filter((h) => h.id !== s.tile.id), seen);
        byKey.set(s.tile.key, ev);
      }
      s.away = ev ? ev.away : 99;
      s.faan = ev ? ev.faan : 0;
    }
    scored.sort((a, b) => a.away - b.away || b.faan - a.faan || a.score - b.score);
    return scored[0].tile;
  }

  // sort ascending (worst first), discard the least useful
  scored.sort((a, b) => a.score - b.score);
  return scored[0].tile;
}

// ---------------------------------------------------------------- HK routes
//
// "What could this hand still be worth, and how far away is it?" — answered
// exactly rather than guessed. Every scoring shape Hong Kong recognises is
// measured against the tiles you hold AND the tiles still unseen, so a route
// needing a fourth Red Dragon when three are already on the table is never
// offered. Distance is the number of tiles you'd have to swap out, so a route
// two away is two draws of work, not a vague aspiration.
//
// The engine is a max-reuse DP: for every shape, how many of my tiles can
// survive into a finished hand of that shape? Tiles that can't survive are the
// distance. Suits are walked value by value carrying the runs that straddle the
// boundary; honours are independent, so they just convolve.


const SUIT_BASE = { m: 0, p: 9, s: 18 };
const SUIT_NAME = { m: SUIT_WORD.m.toLowerCase(), p: SUIT_WORD.p.toLowerCase(), s: SUIT_WORD.s.toLowerCase() };
const KEY_LIST = (() => {
  const ks = [];
  for (const s of SUITS) for (let v = 1; v <= 9; v++) ks.push(`${s}${v}`);
  for (const w of HONOR_WINDS) ks.push(`w${w}`);
  for (const d of HONOR_DRAGONS) ks.push(`d${d}`);
  return ks;
})();
const KEY_IDX = new Map(KEY_LIST.map((k, i) => [k, i]));
function keyIdx(key) { const i = KEY_IDX.get(key); return i === undefined ? -1 : i; }

const NEG = -1e9;
const SUITS_ORDER = SUITS;
const HONORS_ORDER = [...HONOR_WINDS.map((w) => `w${w}`), ...HONOR_DRAGONS.map((d) => `d${d}`)];
const MAX_HF = 6;          // most faan an honour pung set can be worth

function emptySuitTable() {
  return Array.from({ length: 5 }, () => [NEG, NEG]);
}

// max of my tiles reusable inside one 9-value suit, indexed [sets][pairUsed]
function suitReuse(mine, supply, base, allowRun, allowTrip) {
  const memo = new Map();
  const go = (i, c2, c1) => {
    const mk = (i * 5 + c2) * 5 + c1;
    const hit = memo.get(mk);
    if (hit) return hit;
    const res = emptySuitTable();
    if (i === 9) {
      if (c2 === 0 && c1 === 0) res[0][0] = 0;
      memo.set(mk, res);
      return res;
    }
    const maxRun = (allowRun && i <= 6) ? 4 : 0;
    for (let r = 0; r <= maxRun; r++) {
      for (let t = 0; t <= (allowTrip ? 1 : 0); t++) {
        for (let pr = 0; pr <= 1; pr++) {
          const used = c2 + c1 + r + 3 * t + 2 * pr;
          if (used > supply[base + i]) continue;
          const gain = Math.min(used, mine[base + i]);
          const sub = go(i + 1, c1, r);
          for (let s = 0; s + r + t <= 4; s++) {
            for (let p = 0; p + pr <= 1; p++) {
              const v = sub[s][p];
              if (v <= NEG / 2) continue;
              const ns = s + r + t, np = p + pr;
              if (gain + v > res[ns][np]) res[ns][np] = gain + v;
            }
          }
        }
      }
    }
    memo.set(mk, res);
    return res;
  };
  const at = (i, c2, c1, s, pr) => go(i, c2, c1)[s][pr];
  // Walk the memo forward, picking any choice that still reaches the target, to
  // recover ONE composition that achieves it. That is what turns "three away"
  // into "needs East x3" — a distance never says what you are waiting for.
  const trace = (sets, pair) => {
    const used = new Array(9).fill(0);
    let i = 0, c2 = 0, c1 = 0, s = sets, pr = pair;
    while (i < 9) {
      const maxRun = (allowRun && i <= 6) ? 4 : 0;
      let picked = null;
      for (let r = 0; r <= maxRun && !picked; r++) {
        for (let t = 0; t <= (allowTrip ? 1 : 0) && !picked; t++) {
          for (let q = 0; q <= 1 && !picked; q++) {
            if (r + t > s || q > pr) continue;
            const u = c2 + c1 + r + q * 2 + t * 3;
            if (u > supply[base + i]) continue;
            const rest = go(i + 1, c1, r)[s - r - t][pr - q];
            if (rest <= NEG / 2) continue;
            if (Math.min(u, mine[base + i]) + rest !== at(i, c2, c1, s, pr)) continue;
            picked = { r, t, q, u };
          }
        }
      }
      if (!picked) break;
      used[i] = picked.u;
      s -= picked.r + picked.t;
      pr -= picked.q;
      const keep = c1;
      c2 = keep; c1 = picked.r; i++;
    }
    return used;
  };
  return { table: go(0, 0, 0), trace };
}

function emptyHonorTable() {
  // [sets][pair][honourFaan][honoursUsed]
  return Array.from({ length: 5 }, () =>
    Array.from({ length: 2 }, () =>
      Array.from({ length: MAX_HF + 1 }, () => [NEG, NEG])));
}

// honours don't form runs, so each one is independent and the groups convolve
function honorReuse(mine, supply, base, allowTrip, honVal) {
  let cur = emptyHonorTable();
  cur[0][0][0][0] = 0;
  const steps = [cur];
  for (let j = 0; j < HONORS_ORDER.length; j++) {
    const next = emptyHonorTable();
    const idx = base + j;
    for (let s = 0; s < 5; s++) for (let p = 0; p < 2; p++) {
      for (let hf = 0; hf <= MAX_HF; hf++) for (let hu = 0; hu < 2; hu++) {
        const have = cur[s][p][hf][hu];
        if (have <= NEG / 2) continue;
        for (let t = 0; t <= (allowTrip ? 1 : 0); t++) {
          for (let pr = 0; pr <= 1; pr++) {
            if (t && pr) continue;                 // 3 + 2 copies is five, never legal
            const used = 3 * t + 2 * pr;
            if (used > supply[idx]) continue;
            if (s + t > 4 || p + pr > 1) continue;
            const nhf = Math.min(MAX_HF, hf + (t ? honVal[j] : 0));
            const nhu = (used > 0) ? 1 : hu;
            const gain = Math.min(used, mine[idx]);
            if (have + gain > next[s + t][p + pr][nhf][nhu]) {
              next[s + t][p + pr][nhf][nhu] = have + gain;
            }
          }
        }
      }
    }
    cur = next;
    steps.push(cur);
  }
  // the same walk-back, one honour at a time
  const trace = (sets, pair, hf, hu) => {
    const used = new Array(HONORS_ORDER.length).fill(0);
    let s = sets, p = pair, f = hf, u = hu;
    for (let j = HONORS_ORDER.length - 1; j >= 0; j--) {
      const target = steps[j + 1][s][p][f][u];
      let done = false;
      for (let t = 0; t <= (allowTrip ? 1 : 0) && !done; t++) {
        for (let pr = 0; pr <= 1 && !done; pr++) {
          if (t && pr) continue;
          if (t > s || pr > p) continue;
          const tiles = 3 * t + 2 * pr;
          if (tiles > supply[base + j]) continue;
          const pf = t ? Math.max(0, f - honVal[j]) : f;
          const gain = Math.min(tiles, mine[base + j]);
          for (const pu of (tiles > 0 ? [0, 1] : [u])) {
            const prev = steps[j][s - t][p - pr][pf][pu];
            if (prev <= NEG / 2 || prev + gain !== target) continue;
            used[j] = tiles; s -= t; p -= pr; f = pf; u = pu; done = true;
            break;
          }
        }
      }
      if (!done) break;
    }
    return used;
  };
  return { table: cur, trace };
}

const ZERO_SUIT = (() => { const t = emptySuitTable(); t[0][0] = 0; return t; })();
const ZERO_HONOR = (() => { const t = emptyHonorTable(); t[0][0][0][0] = 0; return t; })();

function convolveSuits(tables) {
  let cur = emptySuitTable();
  cur[0][0] = 0;
  let splits = Array.from({ length: 5 }, () => [[], []]);
  for (let k = 0; k < tables.length; k++) {
    const t = tables[k];
    const next = emptySuitTable();
    const nextSplit = Array.from({ length: 5 }, () => [null, null]);
    for (let s = 0; s < 5; s++) for (let p = 0; p < 2; p++) {
      if (cur[s][p] <= NEG / 2) continue;
      for (let s2 = 0; s + s2 < 5; s2++) for (let p2 = 0; p + p2 < 2; p2++) {
        const v = t[s2][p2];
        if (v <= NEG / 2) continue;
        if (cur[s][p] + v > next[s + s2][p + p2]) {
          next[s + s2][p + p2] = cur[s][p] + v;
          nextSplit[s + s2][p + p2] = [...(splits[s][p] || []), [s2, p2]];
        }
      }
    }
    cur = next;
    splits = nextSplit;
  }
  return { table: cur, splits };
}

// Every arrangement of a shape worth showing, with the honour faan and the
// arrangement that produced it — the arrangement is what the trace functions
// turn into "needs".
//
// There is more than one, and that used to be lost. Within a single
// (flush × set-mode) cell the honour pungs are a CHOICE: chasing a second
// dragon costs you a tile and buys you a faan, and which of those you want
// depends on how much faan you still need. Reporting only the max-reuse
// arrangement hid every other side of that trade — and they are different
// WAITS, not just different prices. A hand holding a dragon pair and an East
// pair, one tile from home, wins on the East (a pung worth two) or on the
// dragon (worth one, so self-draw only). Two tiles, two hands, and only the
// first was ever mentioned.
//
// So every honour-faan level a shape can reach gets its own entry, at the
// closest arrangement that reaches it. No pruning here: whether one entry
// makes another pointless depends on the minimum, on flowers, and on the
// self-draw faan, none of which this function knows about.
function shapeBests(suits, honorPart, need, requireHonor) {
  const byHf = [];
  for (let s = 0; s <= need; s++) for (let p = 0; p < 2; p++) {
    const a = suits.table[s][p];
    if (a <= NEG / 2) continue;
    const s2 = need - s, p2 = 1 - p;
    for (let hf = 0; hf <= MAX_HF; hf++) for (let hu = 0; hu < 2; hu++) {
      if (requireHonor && hu === 0) continue;
      const b = honorPart[s2][p2][hf][hu];
      if (b <= NEG / 2) continue;
      const reuse = a + b;
      if (!byHf[hf] || reuse > byHf[hf].reuse) {
        byHf[hf] = { reuse, hf, suitSplit: suits.splits[s][p], honSets: s2, honPair: p2, hu };
      }
    }
  }
  return byHf.filter(Boolean).reverse();
}

const SET_MODES = [
  { id: 'free', name: null, val: 0, run: true, trip: true },
  { id: 'sequences', name: 'all sequences', val: 1, run: true, trip: false },
  { id: 'triplets', name: 'all triplets', val: 3, run: false, trip: true },
];

function hkRoutesFor(ctx) {
  // ctx: { hand, melds, flowers, seatWind, roundWind, seen } — seen counts every
  // tile anyone can see that isn't in my hand (all discards, all melds).
  const { hand, melds, flowers, seatWind: sw, roundWind: rw, seen } = ctx;
  const need = 4 - melds.length;
  if (need < 0) return [];

  const mine = new Array(34).fill(0);
  for (const t of hand) { const i = keyIdx(t.key); if (i >= 0) mine[i]++; }
  const supply = new Array(34).fill(0);
  for (let i = 0; i < 34; i++) supply[i] = Math.max(0, Math.min(4, 4 - (seen[i] || 0)));

  const honVal = HONORS_ORDER.map((k) => {
    let v = 0;
    if (k === `w${sw}`) v += 1;
    if (k === `w${rw}`) v += 1;
    if (k[0] === 'd') v += 1;
    return v;
  });

  // faan already banked in declared melds, plus flowers
  let meldHon = 0;
  for (const m of melds) {
    const t = m.tiles[0];
    if (!t) continue;
    if (t.kind === 'wind' && t.v === sw) meldHon++;
    if (t.kind === 'wind' && t.v === rw) meldHon++;
    if (t.kind === 'dragon') meldHon++;
  }
  const flowerFaan = flowers.length;
  const anyChiMeld = melds.some((m) => m.type === 'chi');
  const allChiMelds = melds.every((m) => m.type === 'chi');
  const meldKinds = new Set(melds.flatMap((m) => m.tiles.map((t) => t.kind)));

  // suit tables, once per (suit, run/trip) combination — routes just reuse them
  const suitTab = {};
  for (const s of SUITS_ORDER) {
    for (const m of SET_MODES) suitTab[`${s}:${m.id}`] = suitReuse(mine, supply, SUIT_BASE[s], m.run, m.trip);
  }
  const honTab = {};
  for (const m of SET_MODES) honTab[m.id] = honorReuse(mine, supply, 27, m.trip, honVal);
  const ZERO_TRACE = { table: ZERO_SUIT, trace: () => new Array(9).fill(0) };

  const FLUSH = [
    { id: 'any', name: null, val: 0, suits: SUITS_ORDER, honors: true, requireHonor: false },
    ...SUITS_ORDER.map((s) => ({ id: `mixed:${s}`, name: `mixed flush in ${SUIT_NAME[s]}`, val: 3, suits: [s], honors: true, requireHonor: true })),
    ...SUITS_ORDER.map((s) => ({ id: `full:${s}`, name: `full flush in ${SUIT_NAME[s]}`, val: 6, suits: [s], honors: false, requireHonor: false })),
    { id: 'honors', name: 'all honours', val: 10, suits: [], honors: true, requireHonor: true },
  ];

  const concealed = hand.length;
  const out = [];
  for (const f of FLUSH) {
    // a declared meld outside the flush rules it out before we start
    if (f.suits.length < 3 || !f.honors) {
      const okKinds = new Set(f.suits);
      if (f.honors) { okKinds.add('wind'); okKinds.add('dragon'); }
      if ([...meldKinds].some((k) => !okKinds.has(k))) continue;
    }
    for (const m of SET_MODES) {
      if (m.id === 'sequences' && !allChiMelds) continue;
      if (m.id === 'triplets' && anyChiMeld) continue;
      const parts_ = SUITS_ORDER.map((s) => (f.suits.includes(s) ? suitTab[`${s}:${m.id}`] : ZERO_TRACE));
      const hon = f.honors ? honTab[m.id] : { table: ZERO_HONOR, trace: () => new Array(HONORS_ORDER.length).fill(0) };
      const cell = convolveSuits(parts_.map((x) => x.table));
      for (const best of shapeBests(cell, hon.table, need, f.requireHonor)) {
        if (best.reuse <= NEG / 2) continue;

        // what the arrangement actually asks for, beyond what is already held
        const wants = [];
        const noteWant = (idx, used) => {
          const short = used - mine[idx];
          // `have` is what the arrangement already has of this tile. With
          // `count` it says which SET the tile is for, and that decides who can
          // hand it to you — see setSeats.
          if (short > 0) wants.push({ key: KEY_LIST[idx], count: short, have: mine[idx], left: Math.max(0, supply[idx] - mine[idx]) });
        };
        if (best.suitSplit) {
          parts_.forEach((tab, si) => {
            const [ss, sp] = best.suitSplit[si] || [0, 0];
            const used = tab.trace(ss, sp);
            used.forEach((u, vi) => noteWant(SUIT_BASE[SUITS_ORDER[si]] + vi, u));
          });
        }
        hon.trace(best.honSets, best.honPair, best.hf, best.hu)
          .forEach((u, hi) => noteWant(27 + hi, u));
        wants.sort((a, b) => b.count - a.count || a.left - b.left);
        const shape = f.val + m.val + best.hf + meldHon + flowerFaan;
        const parts = [];
        if (f.name) parts.push({ term: f.id.split(':')[0], text: f.name });
        if (m.name) parts.push({ term: m.id, text: m.name });
        // faan, not pungs: an East pung in the East round is worth two on its own
        const honFaan = best.hf + meldHon;
        if (honFaan > 0) parts.push({ term: 'honourpung', text: `${honFaan} from dragon/wind pungs` });
        if (flowerFaan > 0) parts.push({ term: 'flowers', text: `${flowerFaan} flower${flowerFaan > 1 ? 's' : ''}` });
        out.push({
          id: `${f.id}|${m.id}|${best.hf}`, parts, shape, mode: m.id,
          away: concealed - best.reuse,
          wants,
        });
      }
    }
  }
  return out;
}


// Everything above is shape arithmetic. This turns a live game into the question
// it answers, and adds the one faan the shape can't know about: a self-draw is
// always available, so a route one short of the minimum is still a route.
// ---- Riichi: the same question, a different rulebook.
//
// The bar is far lower — one han that isn't dora — but the trap is different:
// open your hand and riichi, pinfu, tsumo and seven pairs all vanish at once,
// and a beginner discovers this only when a finished hand refuses to be
// declared. So the routes are worth showing precisely BECAUSE most of them are
// cheap: the useful message is usually "you are still concealed, just reach
// tenpai and declare".
export const JP_MIN_HAN = 1;

// Seven pairs and thirteen orphans don't fit the four-sets-and-a-pair machinery
// at all, so they get their own arithmetic. Both are concealed-only.
function chiitoiRoute(mine, supply, concealed) {
  const cands = [];
  for (let i = 0; i < 34; i++) {
    if (supply[i] < 2) continue;                 // can't finish a pair nobody has
    cands.push({ i, have: Math.min(2, mine[i]) });
  }
  if (cands.length < 7) return null;
  cands.sort((a, b) => b.have - a.have);
  const picked = cands.slice(0, 7);
  const reuse = picked.reduce((a, c) => a + c.have, 0);
  const wants = picked.filter((c) => c.have < 2)
    .map((c) => ({ key: KEY_LIST[c.i], count: 2 - c.have, have: c.have, left: Math.max(0, supply[c.i] - mine[c.i]) }));
  return { away: concealed - reuse, wants };
}

const ORPHAN_KEYS = [
  ...SUITS.flatMap((s) => [`${s}1`, `${s}9`]),
  ...HONOR_WINDS.map((w) => `w${w}`), ...HONOR_DRAGONS.map((d) => `d${d}`),
];

function kokushiRoute(mine, supply, concealed) {
  let distinct = 0, pairable = false;
  const wants = [];
  for (const k of ORPHAN_KEYS) {
    const i = keyIdx(k);
    if (supply[i] < 1) return null;              // one of the thirteen is gone
    if (mine[i] > 0) distinct++;
    else wants.push({ key: k, count: 1, have: mine[i], left: Math.max(0, supply[i] - mine[i]) });
    if (mine[i] > 1) pairable = true;
  }
  const reuse = Math.min(concealed, distinct + (pairable ? 1 : 0));
  return { away: concealed - reuse, wants };
}

function jpLockedHan(pos) {
  if (pos.variant !== 'jp') return null;
  const p = pos, sw = pos.seatWind;
  const parts = [];
  if (p.riichi) parts.push({ term: 'riichi', name: 'Riichi', val: 1 });
  for (const m of p.melds) {
    const t = m.tiles[0];
    if (!t) continue;
    if (t.kind === 'wind' && t.v === sw) parts.push({ term: 'seatwind', name: 'Seat wind', val: 1 });
    if (t.kind === 'wind' && t.v === pos.roundWind) parts.push({ term: 'roundwind', name: 'Round wind', val: 1 });
    // point at the dragon itself, not at "a dragon pung": the line already
    // names which one, and a note that explains all three is no answer to
    // "what is this tile?"
    if (t.kind === 'dragon') {
      parts.push({ term: DRAGON_TERM[t.v], name: DRAGON_WORD[t.v], val: 1 });
    }
  }
  // dora sitting inside a declared meld can't be discarded away either. Dora is
  // never a yaku, so it is listed but doesn't count toward the minimum.
  let melded = 0;
  for (const ind of pos.dora) {
    const dk = doraKey(ind);
    for (const m of p.melds) melded += m.tiles.filter((t) => t.key === dk).length;
  }
  if (melded > 0) parts.push({ term: 'dora', name: `${melded} dora`, val: melded, bonus: true });

  const total = parts.reduce((a, f) => a + f.val, 0);
  const yakuHan = parts.filter((f) => !f.bonus).reduce((a, f) => a + f.val, 0);
  return { total, yakuHan, parts, minToWin: JP_MIN_HAN, unit: 'han', goal: 'a yaku' };
}

// a tile key back into the shape tileName wants
export function keyParts(key) {
  if (key[0] === 'w') return { kind: 'wind', v: key.slice(1) };
  if (key[0] === 'd') return { kind: 'dragon', v: key.slice(1) };
  // 'f' is the deck's letter for a flower but 'flower' is what tileName knows,
  // and without this a hovered flower reads as "7 undefined"
  if (key[0] === 'f') return { kind: 'flower', v: Number(key.slice(1)) };
  return { kind: key[0], v: Number(key.slice(1)) };
}

// Riichi's shape-based yaku, measured with the same DP as Hong Kong's. Tanyao
// needs no new machinery: zero the supply of every terminal and honour and the
// solver simply can't build with them.
function jpRoutesFor(ctx) {
  const { hand, melds, seatWind: sw, roundWind: rw, seen } = ctx;
  const need = 4 - melds.length;
  if (need < 0) return [];
  const concealed = hand.length;
  const closed = melds.every((m) => !m.open);

  const mine = new Array(34).fill(0);
  for (const t of hand) { const i = keyIdx(t.key); if (i >= 0) mine[i]++; }
  const supply = new Array(34).fill(0);
  for (let i = 0; i < 34; i++) supply[i] = Math.max(0, Math.min(4, 4 - (seen[i] || 0)));
  // simples only: no terminals, no honours
  const simples = supply.map((v, i) => {
    const k = KEY_LIST[i];
    if (k[0] === 'w' || k[0] === 'd') return 0;
    const n = Number(k.slice(1));
    return (n >= 2 && n <= 8) ? v : 0;
  });

  const honVal = HONORS_ORDER.map((k) => {
    let v = 0;
    if (k === `w${sw}`) v += 1;
    if (k === `w${rw}`) v += 1;
    if (k[0] === 'd') v += 1;
    return v;
  });
  let meldHon = 0;
  for (const m of melds) {
    const t = m.tiles[0];
    if (!t) continue;
    if (t.kind === 'wind' && t.v === sw) meldHon++;
    if (t.kind === 'wind' && t.v === rw) meldHon++;
    if (t.kind === 'dragon') meldHon++;
  }
  const anyChi = melds.some((m) => m.type === 'chi');
  const allChi = melds.every((m) => m.type === 'chi');
  const meldKinds = new Set(melds.flatMap((m) => m.tiles.map((t) => t.kind)));

  const tab = (sup, suit, mode) => suitReuse(mine, sup, SUIT_BASE[suit], mode.run, mode.trip);
  const honTab = (sup, mode) => honorReuse(mine, sup, 27, mode.trip, honVal);
  const out = [];

  const evaluate = (id, label, han, opts) => {
    const { sup = supply, suits = SUITS_ORDER, honors = true, requireHonor = false, mode } = opts;
    if (opts.closedOnly && !closed) return;
    // A yaku that needs a concealed hand cannot be reached by calling, which is
    // the whole difference between riichi and Hong Kong — see winChance.
    const needsClosed = !!opts.closedOnly;
    if (mode.id === 'sequences' && !allChi) return;
    if (mode.id === 'triplets' && anyChi) return;
    const okKinds = new Set(suits);
    if (honors) { okKinds.add('wind'); okKinds.add('dragon'); }
    if ([...meldKinds].some((k) => !okKinds.has(k))) return;
    const parts_ = SUITS_ORDER.map((x) => (suits.includes(x)
      ? tab(sup, x, mode)
      : { table: ZERO_SUIT, trace: () => new Array(9).fill(0) }));
    const hon = honors ? honTab(sup, mode) : { table: ZERO_HONOR, trace: () => new Array(HONORS_ORDER.length).fill(0) };
    const cell = convolveSuits(parts_.map((x) => x.table));
    for (const best of shapeBests(cell, hon.table, need, requireHonor)) {
      if (best.reuse <= NEG / 2) continue;

      const wants = [];
      const noteWant = (idx, used) => {
        const short = used - mine[idx];
        if (short > 0) wants.push({ key: KEY_LIST[idx], count: short, have: mine[idx], left: Math.max(0, supply[idx] - mine[idx]) });
      };
      if (best.suitSplit) {
        parts_.forEach((t2, si) => {
          const [ss, sp] = best.suitSplit[si] || [0, 0];
          t2.trace(ss, sp).forEach((u, vi) => noteWant(SUIT_BASE[SUITS_ORDER[si]] + vi, u));
        });
      }
      hon.trace(best.honSets, best.honPair, best.hf, best.hu).forEach((u, hi) => noteWant(27 + hi, u));
      wants.sort((a, b) => b.count - a.count || a.left - b.left);

      const yakuhai = best.hf + meldHon;
      const parts = [...label];
      if (yakuhai > 0) parts.push({ term: 'yakuhai', text: `${yakuhai} yakuhai` });
      out.push({
        id: `${id}|${best.hf}`, parts, shape: han + yakuhai, mode: mode.id, needsClosed,
        away: concealed - best.reuse, wants,
      });
    }
  };

  const FREE = SET_MODES[0], SEQ = SET_MODES[1], TRIP = SET_MODES[2];
  // The plain hand: worth nothing on its own, which for a concealed hand is the
  // one line a beginner most needs to read — reach tenpai, declare, and the
  // declaration IS the yaku. shapeBests hands that back on its own now: its
  // zero-yakuhai entry is this shape priced without the honour pungs, at the
  // closest arrangement that does not chase them.
  evaluate('any', [], 0, { mode: FREE });
  evaluate('tanyao', [{ term: 'tanyao', text: 'tanyao' }], 1, { mode: FREE, sup: simples, honors: false });
  evaluate('pinfu', [{ term: 'pinfu', text: 'pinfu' }], 1, { mode: SEQ, closedOnly: true });
  evaluate('toitoi', [{ term: 'toitoi', text: 'toitoi' }], 2, { mode: TRIP });
  for (const s of SUITS_ORDER) {
    evaluate(`honitsu:${s}`, [{ term: 'honitsu', text: `honitsu in ${SUIT_NAME[s]}` }], closed ? 3 : 2,
      { mode: FREE, suits: [s], requireHonor: true });
    evaluate(`chinitsu:${s}`, [{ term: 'chinitsu', text: `chinitsu in ${SUIT_NAME[s]}` }], closed ? 6 : 5,
      { mode: FREE, suits: [s], honors: false });
  }

  if (closed) {
    const c = chiitoiRoute(mine, supply, concealed);
    if (c) out.push({ id: 'chiitoi', parts: [{ term: 'chiitoitsu', text: 'chiitoitsu' }], shape: 2, mode: 'nosets', needsClosed: true, away: c.away, wants: c.wants });
    const k = kokushiRoute(mine, supply, concealed);
    if (k) out.push({ id: 'kokushi', parts: [{ term: 'kokushi', text: 'kokushi musou' }], shape: 13, mode: 'nosets', needsClosed: true, away: k.away, wants: k.wants });
  }
  return out;
}

// The traced plan names ONE way to fill a shape, which is not the same thing as
// every tile that would fill it: a 3-4 waiting on 2 or 5 gets reported as
// whichever the walk happened to reach first, and a learner reading it would
// pass up half their own winning tiles. So ask the question directly — deal one
// tile that is still out there, solve again, and see which routes came a tile
// closer. For a route one short that set is exactly what wins; further out it
// is what helps. Around 30 extra solves, ~20ms, and only ever for a seat that
// is going to read the answer.
function routeWins(routesFor, ctx, base) {
  const mine = new Array(34).fill(0);
  for (const t of ctx.hand) { const i = keyIdx(t.key); if (i >= 0) mine[i]++; }
  const shortOf = (r) => r.wants.reduce((a, w) => a + w.count, 0);
  const was = new Map(base.map((r) => [r.id, shortOf(r)]));

  const wins = new Map();
  for (let i = 0; i < 34; i++) {
    const left = Math.max(0, Math.min(4, 4 - (ctx.seen[i] || 0)) - mine[i]);
    if (left <= 0) continue;                    // nobody can draw what is all gone
    const key = KEY_LIST[i], parts = keyParts(key);
    for (const r of routesFor({ ...ctx, hand: [...ctx.hand, { key, ...parts }] })) {
      if (was.get(r.id) !== shortOf(r) + 1) continue;
      if (!wins.has(r.id)) wins.set(r.id, []);
      wins.get(r.id).push({ k: key, left });
    }
  }
  return wins;
}

// Two cells can describe the same hand in the same words — "full flush in man
// + all triplets" falls out of both the honours-allowed and honours-barred
// passes — and with every honour level enumerated there are more of these than
// before. If two rows would render identically they are one row.
function dedupeRoutes(routes) {
  const seen = new Set();
  return routes.filter((r) => {
    const k = [
      r.faan, r.away, r.selfDraw ? 'sd' : '', r.riichi ? 'r' : '', r.flowersNeeded || 0,
      r.parts.map((x) => x.text).join('+'),
      r.wants.map((w) => `${w.key}:${w.count}`).sort().join(','),
    ].join('|');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Only what the panel is actually going to print: the tiles when it will name
// them, and otherwise just how many there are. Every route carrying its full
// set of helpful tiles made the view several times bigger than everything else
// in it put together — and the view has to fit down a data channel, which drops
// what it cannot carry without telling anybody.
function winsField(list, wants) {
  const short = wants.reduce((a, w) => a + w.count, 0);
  return { wins: (short === 1 || list.length <= 4) ? list : [], winsN: list.length };
}

// Every tile anyone at the table can see. A route needing a fourth Chun when
// three are already face up is not a route.
function seenFrom(pos) {
  const seen = new Array(34).fill(0);
  const bump = (t) => { const i = keyIdx(t.key); if (i >= 0) seen[i]++; };
  for (const q of pos.players) {
    for (const t of q.discards) bump(t);
    for (const m of q.melds) for (const t of m.tiles) bump(t);
  }
  for (const d of pos.dora) bump(d);
  return seen;
}

// routeWins is around thirty extra solves. The line under the hand only ever
// prints it when a route is one tile from home; the full panel wants it always.
// So pay for it when somebody is going to read it, and skip it otherwise.
function winsFor(routesFor, ctx, shapes, opts = {}) {
  const oneAway = shapes.some((r) => r.wants.reduce((a, w) => a + w.count, 0) === 1);
  if (!opts.deep && !oneAway) return new Map();
  return routeWins(routesFor, ctx, shapes);
}

// ---- how likely a route actually is ---------------------------------------
//
// The list used to be ordered by an "effort" score — tiles to discard plus a
// surcharge for scarcity. It ranked sensibly enough, but it was a number with
// no meaning, so it could neither be printed nor checked. This answers the
// question the ordering is really asking: what are the chances?
//
// It is the poker calculation. Every tile nobody can see is equally likely to
// be the next one you touch, so for each tile a route still wants, the chance
// of collecting enough copies is hypergeometric — L copies of it hidden in a
// pool of U, and N chances to find them.
//
// Two approximations, both deliberate:
//
//   * The wanted tiles are treated as independent. They are not: your draws are
//     shared between them, so a route wanting several tiles reads a little
//     rosier than it is. The error grows with the number of tiles wanted, which
//     is the same thing that sinks a route anyway, so it costs accuracy at the
//     bottom of the list rather than order at the top.
//   * Every route is priced as though you play for it and nothing else. That is
//     what makes them comparable; it is not what you will actually do.
//
// And one thing it does not attempt: whether somebody ELSE finishes first. That
// depends on three hands nobody at this seat can see. So this is the chance the
// tiles arrive, not the chance the hand is still yours to win when they do.
//
// Measured against 556 dealt hands per variant, sampling the top route's number
// once the wall was down to 50 and then asking who actually won:
//
//   said      HK won    JP won
//   ~1%        5.0%      5.9%
//   ~3%        4.5%      8.7%
//   ~10%      19.7%     12.3%
//   ~23%      23.2%     14.3%
//   ~56%      46.3%     24.1%
//
// Hong Kong tracks; riichi reads high in the upper bands, and the same runs say
// why — a rival won 41% of those hands and the wall ran out in another 35%. It
// ranks the same either way, which is what the list is for.

const LOG_FACT = [0];
for (let i = 1; i <= 256; i++) LOG_FACT[i] = LOG_FACT[i - 1] + Math.log(i);
const logChoose = (n, k) => (k < 0 || k > n || n < 0 ? -Infinity : LOG_FACT[n] - LOG_FACT[k] - LOG_FACT[n - k]);

// P(at least `want` of the `good` tiles turn up in `draws` from a pool of `pool`)
function hyperAtLeast(pool, good, draws, want) {
  if (want <= 0) return 1;
  if (good < want || draws < want || pool <= 0) return 0;
  if (draws >= pool) return good >= want ? 1 : 0;
  let below = 0;
  for (let x = 0; x < want; x++) {
    const lp = logChoose(good, x) + logChoose(pool - good, draws - x) - logChoose(pool, draws);
    if (lp > -Infinity) below += Math.exp(lp);
  }
  return Math.min(1, Math.max(0, 1 - below));
}

// Who can hand you a tile depends on the set it is for, and between them the
// count and what the arrangement already holds say which set that is:
//
//   need 1 hold 2 / need 2 hold 1 / need 3 hold 0    a triplet — pon, from anyone
//   need 2 hold 0 / need 1 hold 1                    the pair — nobody can give it
//   need 1 hold 0                                    a run — chi, from your left only
//
// A run never wants two of the same tile, so `need + hold >= 3` is a triplet and
// nothing else, and anything short of three that you already hold a copy of is
// the pair. The pair is the one shape no discard can help with: there is no call
// for it, and by the time you would want to claim one you are winning instead —
// which winChance handles separately, because ron does not care about sets.
function setSeats(w, others, mode) {
  if (mode === 'nosets') return 0;                        // seven pairs, thirteen orphans
  if (w.count + (w.have || 0) >= 3) return others;        // a triplet: pon
  if (w.count === 2 || (w.have || 0) >= 1) return 0;      // the pair
  return Math.min(1, others);                             // a run: chi, from the left
}

// Flowers and seasons nobody has turned up. Each is worth a faan and none of
// them costs you a tile: a flower is set aside the moment you draw it and
// replaced from the wall, so the only thing standing between you and the faan
// is drawing one. That makes them the cheapest faan in the game and the easiest
// to forget — a shape a faan or two short of declarable is not dead while there
// are flowers still out there.
function flowersOut(pos) {
  if (pos.variant === 'jp') return 0;                 // riichi has none
  let shown = 0;
  for (const q of pos.players || []) shown += (q.flowers || []).length;
  return Math.max(0, 8 - shown);
}

// Your own draws, and how many other seats are in front of you.
function chanceCtx(pos) {
  const n = Math.max(1, (pos.players || []).length || 4);
  const wall = Math.max(0, pos.wallCount || 0);
  // The next tile you draw is however many seats away the turn is. On your own
  // turn you have already drawn, so the next one is a full lap off.
  const gap = ((pos.mySeat - pos.turn) % n + n) % n || n;
  const draws = wall >= gap ? Math.floor((wall - gap) / n) + 1 : 0;
  return { draws, others: n - 1, declared: !!pos.riichi, furiten: !!pos.furiten, flowers: flowersOut(pos) };
}

// Every tile nobody at the table can see and you are not holding: the wall plus
// the other hands. Flowers are in there too — they are not in the 34 the solver
// counts, but they are tiles you can draw instead of what you wanted.
function unseenPool(pos, seen) {
  const mine = new Array(34).fill(0);
  for (const t of pos.hand) { const i = keyIdx(t.key); if (i >= 0) mine[i]++; }
  let pool = 0;
  for (let i = 0; i < 34; i++) pool += Math.max(0, Math.min(4, 4 - (seen[i] || 0)) - mine[i]);
  if (pos.variant !== 'jp') {
    let shown = 0;
    for (const q of pos.players || []) shown += (q.flowers || []).length;
    pool += Math.max(0, 8 - shown);
  }
  return pool;
}

function winChance(route, ctx) {
  const short = route.wants.reduce((a, w) => a + w.count, 0);
  const petals = route.flowersNeeded || 0;
  if (!short && !petals) return 1;                       // already there
  if (ctx.pool <= 0 || ctx.draws <= 0) return 0;         // no wall, no chances
  let p = 1;
  // Flowers come out of your own draws and nowhere else — nobody discards one,
  // because nobody ever holds one.
  if (petals) {
    p *= hyperAtLeast(ctx.pool, ctx.flowers, ctx.draws, petals);
    if (p <= 0) return 0;
  }
  for (const w of route.wants) {
    if (w.left < w.count) return 0;                      // not enough of it left
    // One tile from home, any player's discard ends it: ron does not care what
    // set the tile was going to be for. Unless the route needs the self-draw
    // faan, in which case the tile has to come out of the wall on your turn.
    // A route that only scores while the hand stays concealed cannot call for
    // any of it, and a hand that has already declared riichi cannot call at all.
    // The tile you win on is the exception either way: ron does not open a hand.
    const mute = route.riichi || route.needsClosed || ctx.declared;
    // Furiten is the same restriction arriving from the other direction: having
    // discarded one of your own winning tiles, you can only self-draw the win.
    const seats = short === 1
      ? (route.selfDraw || ctx.furiten ? 0 : ctx.others)
      : (mute ? 0 : setSeats(w, ctx.others, route.mode));
    // Each of your draws comes around with one discard from every other seat.
    // Only the copy that completes the set can be taken off one, though, so the
    // claim channel is worth a fraction of itself when several are wanted.
    let chances = ctx.draws + (seats * ctx.draws) / w.count;
    // Further out, a self-draw route can still claim its way through the middle
    // of the hand — it is only the last tile that has to be drawn.
    if (route.selfDraw && short > 1) chances = ctx.draws + (chances - ctx.draws) * (short - 1) / short;
    p *= hyperAtLeast(ctx.pool, w.left, Math.min(ctx.pool, Math.round(chances)), w.count);
    if (p <= 0) return 0;
  }
  return p;
}

// What the outlook actually needs, lifted out of the private game state: your
// own tiles, what everyone has face up, the dora and the two winds. All of it
// is in the view every player already receives, so this can be built at either
// end — and it is built at the receiving end, because the host has no business
// solving four people's hands and posting them the answers.
export function positionFromView(view) {
  const me = view.players && view.players.find((q) => q.seat === view.mySeat);
  if (!me || !me.hand || me.hand.some((t) => !t)) return null;   // not a hand I can read
  return {
    variant: view.variant,
    hand: me.hand,
    melds: me.melds || [],
    flowers: me.flowers || [],
    riichi: me.riichi,
    furiten: me.furiten,
    seatWind: WINDS[((view.mySeat - view.dealer) % 4 + 4) % 4],
    roundWind: view.roundWind,
    dora: view.dora || [],
    players: view.players,
    // for the odds: how much wall is left and how long until it is your turn
    wallCount: view.wallCount,
    turn: view.turn,
    mySeat: view.mySeat,
  };
}

export function outlookFor(pos, opts = {}) {
  if (!pos) return null;
  if (pos.variant === 'jp') return jpOutlook(pos, opts);
  if (pos.variant === 'hk') return hkOutlook(pos, opts);
  return null;
}

function jpOutlook(pos, opts) {
  if (pos.variant !== 'jp') return null;
  const locked = jpLockedHan(pos);
  const p = pos;
  const closed = p.melds.every((m) => !m.open);

  const seen = seenFrom(pos);
  const ctx = { hand: p.hand, melds: p.melds, seatWind: pos.seatWind, roundWind: pos.roundWind, seen };
  const shapes = jpRoutesFor(ctx);
  const wins = winsFor(jpRoutesFor, ctx, shapes, opts);
  const chance = { ...chanceCtx(pos), pool: unseenPool(pos, seen) };

  const ranked = shapes
    .map((r) => {
      // A concealed hand can always declare riichi, which IS the yaku — so a
      // shape worth nothing still gets you home as long as you stay closed.
      if (r.shape >= JP_MIN_HAN) return { ...r, han: r.shape, riichi: false };
      if (closed && !p.riichi) return { ...r, han: r.shape + 1, riichi: true };
      return null;
    })
    .filter((r) => r && r.han >= JP_MIN_HAN)
    .map((r) => ({ ...r, p: winChance(r, chance) }))
    // Cheapest hand first, and where two cost the same, the likelier one. The
    // odds still decide within a rank but no longer decide the ranking: sorting
    // by them alone put a 3-han shape above a 13-han one it was a hair more
    // likely than, which reads as noise rather than as advice.
    .sort((a, b) => a.han - b.han || b.p - a.p || a.away - b.away);

  const routes = dedupeRoutes(ranked)
    .map((r) => ({
      parts: r.parts, faan: r.han, away: r.away, selfDraw: false, riichi: r.riichi, p: r.p,
      wants: r.wants.map((w) => ({ k: w.key, count: w.count, left: w.left })),
      ...winsField(wins.get(r.id) || [], r.wants),
    }));

  return { ...locked, routes };
}

function hkOutlook(pos, opts) {
  if (pos.variant !== 'hk') return null;
  const locked = hkLockedFaan(pos);
  const p = pos;

  const seen = seenFrom(pos);
  const ctx = {
    hand: p.hand, melds: p.melds, flowers: p.flowers,
    seatWind: pos.seatWind, roundWind: pos.roundWind, seen,
  };
  const shapes = hkRoutesFor(ctx);
  const wins = winsFor(hkRoutesFor, ctx, shapes, opts);
  const chance = { ...chanceCtx(pos), pool: unseenPool(pos, seen) };

  // A shape short of the minimum is not dead: there are two faan lying around
  // that cost no tiles at all. The self-draw is worth one, and every flower
  // still in the wall is worth one more. So a shape two faan short reaches the
  // minimum by drawing it yourself AND turning up a flower — or by turning up
  // two flowers, which leaves the finish claimable off anyone's discard. Both
  // are real hands and both used to be filtered out as unreachable.
  const petalsLeft = flowersOut(pos);
  const banked = (p.flowers || []).length;
  // A route's name says what the finished hand is worth, which is why the
  // self-draw appears in it. Flowers have to do the same: a row that names the
  // two you are holding while quietly taking a third from the needs column
  // reads as two flowers adding up to three faan. Name the total.
  const nameFlowers = (r, need) => {
    if (!need) return r.parts;
    const total = banked + need;
    return [
      ...r.parts.filter((x) => x.term !== 'flowers'),
      { term: 'flowers', text: `${total} flower${total > 1 ? 's' : ''}` },
    ];
  };
  const lift = (r, sd, need) => ({
    ...r, faan: HK_MIN_FAAN, selfDraw: sd, flowersNeeded: need, parts: nameFlowers(r, need),
  });
  const ranked = shapes
    .flatMap((r) => {
      const gap = HK_MIN_FAAN - r.shape;
      if (gap <= 0) return [{ ...r, faan: r.shape, selfDraw: false, flowersNeeded: 0 }];
      const lifted = [];
      // the self-draw covers a faan, flowers cover the rest
      if (gap - 1 <= petalsLeft) lifted.push(lift(r, true, gap - 1));
      // or flowers cover all of it, and then anyone can throw you the last tile
      if (gap <= petalsLeft && gap <= MAX_PETAL_LIFT) lifted.push(lift(r, false, gap));
      return lifted;
    })
    .filter((r) => r.faan >= HK_MIN_FAAN && (r.flowersNeeded || 0) <= MAX_PETAL_LIFT)
    .map((r) => ({ ...r, p: winChance(r, chance) }))
    // Cheapest hand first, and where two cost the same, the likelier one — see
    // the note on the riichi sort above.
    .sort((a, b) => a.faan - b.faan || b.p - a.p || a.away - b.away);

  const routes = dedupeRoutes(ranked)
    .map((r) => ({
      parts: r.parts, faan: r.faan, away: r.away, selfDraw: r.selfDraw, p: r.p,
      flowersNeeded: r.flowersNeeded || 0,
      wants: r.wants.map((w) => ({ k: w.key, count: w.count, left: w.left })),
      ...winsField(wins.get(r.id) || [], r.wants),
    }));

  return { ...locked, routes };
}

// ---------------------------------------------------------------- view

// opts.revealBots — a host-side testing switch that lays the bots' concealed
// tiles face up mid-hand; see the settings drawer in app.js.
export function viewFor(G, seat, code, opts = {}) {
  const p = playerBySeat(G, seat);
  // once the hand is over nothing is secret any more
  const handOver = G.phase === 'handEnd' || G.phase === 'over';
  const players = G.players.map((q) => {
    const isMe = q.seat === seat;
    return {
      seat: q.seat,
      name: q.name,
      bot: q.bot,
      connected: q.connected,
      // hidden while the hand is live; everyone's is laid open once it is over,
      // so the table can be read before the score panel covers it — and a bot's
      // can be laid open the whole time, for testing
      hand: (isMe || handOver || (opts.revealBots && q.bot)) ? q.hand : q.hand.map(() => null),
      melds: q.melds,
      discards: q.discards,
      flowers: q.flowers,
      score: q.score,
      riichi: q.riichi,
      // your own furiten is your own business to know: it is the difference
      // between a wait you can ron and one you can only self-draw
      furiten: isMe ? !!q.furiten : undefined,
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
    faanLimit: G.faanLimit,
    handResult: G.handResult,
    readyNext: G.readyNext || [],
    waitingNext: waitingOnNext(G),
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
  maybeDeal(G);
  return true;
}

export function markBotTakeover(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p) return false;
  p.botFor = true;
  addLog(G, `A bot takes over for ${p.name}.`);
  maybeDeal(G);
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
  maybeDeal(G);
  return true;
}
