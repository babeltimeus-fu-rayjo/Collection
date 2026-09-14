// game.js — the rules of 7 Wonders. No DOM, no network: give it a state and a
// move and it gives you the next state, which is what makes it testable and
// what lets the host be the only authority on what actually happened.
//
// The shape of a game: three Ages, each dealt as seven cards per player. Every
// turn everybody chooses from their hand at the same time, all the choices are
// revealed together, and the hands pass on — left in Age I, right in Age II,
// left again in Age III. Six turns later the seventh card is thrown away and
// the armies are counted.
//
// The awkward part is not the loop, it is "can I afford this?". Your own cards
// may produce a choice of resources, your neighbours will sell you theirs at a
// price that depends on which trading posts you own, and the answer has to be
// the CHEAPEST way to pay rather than any way at all. That is a min-cost flow,
// and it lives in payFor() below.

import {
  RAW, MANUFACTURED, RESOURCES, RES_NAME, COLOUR_NAME,
  BASE_AGES, GUILDS, WONDERS, CITY_CARDS, CITY_GUILDS, DEBT_VP,
  START_COINS, START_COINS_LEADERS, CARDS_PER_AGE,
  MILITARY_WIN, MILITARY_LOSS, SCIENCE_SET_BONUS,
} from './cards.js';

export { RESOURCES, RES_NAME, COLOUR_NAME, WONDERS } from './cards.js';

export const PROTO = 1;
export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 8;

// The base box deals seven cards per player from a deck that only goes up to
// seven of them. Eight seats need the Cities cards, and team play needs an even
// number to split. The lobby asks this before it will let a game start.
export function seatLimit(opts = {}) {
  return { min: MIN_PLAYERS, max: opts.cities ? 8 : 7 };
}

export function canStart(n, opts = {}) {
  const { min, max } = seatLimit(opts);
  if (n < min) return `Needs at least ${min} players.`;
  if (n > max) return n === 8 ? 'Eight players needs the Cities expansion.' : `At most ${max} players.`;
  if (opts.teams && (n % 2 !== 0 || n < 4)) return 'Team play is for 4, 6 or 8 players, in pairs.';
  return null;
}

export const SIDE_MODES = [
  { key: 'random', name: 'Random side', blurb: 'Each wonder shows a random face.' },
  { key: 'A', name: 'A sides only', blurb: 'The gentler face. Best for a first game.' },
  { key: 'B', name: 'B sides only', blurb: 'The sharper face, with abilities instead of points.' },
];

// ---------------------------------------------------------------- small helpers

export function playerBySeat(G, seat) { return G.players.find((p) => p.seat === seat); }

const clone = (x) => JSON.parse(JSON.stringify(x));

function shuffle(a, rnd = Math.random) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function addLog(G, text) {
  G.log.push({ n: ++G.logN, text });
  if (G.log.length > 200) G.log.shift();
}

function say(G, seat, text) {
  G.chatter.push({ n: ++G.chatSeq, seat, text });
  if (G.chatter.length > 40) G.chatter.shift();
}

// Seat order is a circle, and almost every rule in the game is phrased in terms
// of the two people you can see. Age II passes the other way, which is the only
// thing that ever changes about the table.
// Your partner sits beside you — which side depends on whether you are the odd
// or even half of the pair.
export function partnerOf(G, seat) {
  if (!G.opts.teams) return null;
  const mine = playerBySeat(G, seat);
  const other = G.players.find((q) => q.seat !== seat && q.team === mine.team);
  return other ? other.seat : null;
}

export function leftOf(G, seat) { return (seat + G.nPlayers - 1) % G.nPlayers; }
export function rightOf(G, seat) { return (seat + 1) % G.nPlayers; }
export function passDir(age) { return age === 2 ? 'right' : 'left'; }

// ---------------------------------------------------------------- the deck

// Eight players is not "the seven-player game plus one". The rulebook says to
// prepare a SEVEN-player game — every base card, nine guilds — and add seven
// black cards to each Age, which comes to 56 and deals seven each. So the card
// thresholds and the guild count are driven by this, capped at seven, while the
// number of people the cards are dealt to is not.
const deckScale = (nPlayers) => Math.min(nPlayers, 7);

// Build one Age. A card row lists the player counts that each add a copy, so a
// 5-player game takes every copy whose threshold it has reached.
function buildAge(age, nPlayers, opts, rnd) {
  const scale = deckScale(nPlayers);
  const out = [];
  for (const row of BASE_AGES[age - 1]) {
    for (const threshold of row.at) {
      if (threshold <= scale) out.push({ ...row, age });
    }
  }
  if (age === 3) {
    // guilds: player count + 2, drawn at random — Cities adds three to the pile
    // but not to the number drawn
    const pool = opts.cities ? GUILDS.concat(CITY_GUILDS) : GUILDS;
    for (const g of shuffle(pool.slice(), rnd).slice(0, scale + 2)) out.push({ ...g, age: 3 });
  }
  if (opts.cities) {
    // as many black cards as there are players, drawn blind; the rest of the
    // black cards sit out the whole game
    const black = CITY_CARDS.filter((c) => c.age === age);
    for (const b of shuffle(black.slice(), rnd).slice(0, scale)) out.push({ ...b });
  }
  return out.map((c, i) => ({ ...c, id: `a${age}-${i}` }));
}

// ---------------------------------------------------------------- production

// What a player can make, as a list of generators. A generator offers one unit
// of any single resource from its option list, so 'W/C' is one generator with
// two options and 'WW' is a generator of size two producing wood.
function generators(p, { sellableOnly = false } = {}) {
  const gens = [];
  const add = (give, sellable, why) => {
    if (!give) return;
    const opts = give.split('/');
    if (opts.length > 1) gens.push({ opts, n: 1, sellable, why });
    else {
      // 'WW' — two of the same thing
      const r = opts[0][0];
      gens.push({ opts: [r], n: opts[0].length, sellable, why });
    }
  };
  // the wonder board itself always makes its resource, and it IS for sale
  add(p.wonderRes, true, 'wonder');
  for (const c of p.built) {
    if (!c.give) continue;
    // brown and grey are trade goods; a yellow card's choice is yours alone
    add(c.give, c.c === 'brown' || c.c === 'grey', c.n);
  }
  for (const s of p.stagesBuilt) if (s.give) add(s.give, false, 'wonder stage');

  // Cities: a warehouse makes whatever your city cannot. "Cannot" means your
  // brown and grey cards and the board itself — the ones above — so this has to
  // be worked out after them, and it is yours alone to use.
  const missingCount = p.built.filter((c) => c.produceMissing).length;
  if (missingCount) {
    const own = new Set();
    if (p.wonderRes) own.add(p.wonderRes);
    for (const c of p.built) {
      if (!c.give || (c.c !== 'brown' && c.c !== 'grey')) continue;
      for (const o of c.give.split('/')) for (const ch of o) own.add(ch);
    }
    const missing = RESOURCES.split('').filter((r) => !own.has(r));
    if (missing.length) for (let i = 0; i < missingCount; i++) gens.push({ opts: missing, n: 1, sellable: false, why: 'warehouse' });
  }
  return sellableOnly ? gens.filter((g) => g.sellable) : gens;
}

const isRaw = (r) => RAW.includes(r);

// What one unit of a given resource costs from a given neighbour, after
// trading posts and Olympia's B-side discount.
function tradePrice(p, side, resource) {
  const kind = isRaw(resource) ? 'raw' : 'man';
  let price = 2;
  const consider = (t) => {
    if (!t || t.kind !== kind) return;
    if (t.with === 'both' || t.with === side) price = Math.min(price, 1);
  };
  for (const c of p.built) consider(c.trade);
  for (const s of p.stagesBuilt) consider(s.trade);
  return price;
}

// ---------------------------------------------------------------- paying

// Min-cost flow over a tiny graph: every generator that could serve you is a
// supply node priced at what it costs to use (nothing for your own, the trade
// price for a neighbour's), every resource you still owe is a demand node, and
// the cheapest assignment is the answer. Doing it as a flow rather than a greedy
// walk matters because a choice generator can only be spent once — deciding
// your Tree Farm makes wood may be what forces you to buy the clay.
//
// Returns null when the cost cannot be met at all, otherwise the cheapest
// { coins, left, right } split. A tie is broken toward paying less to any one
// neighbour, since handing a rival money is never neutral.
export function payFor(G, seat, cost, extraGens = []) {
  const need = {};
  for (const r of cost || '') need[r] = (need[r] || 0) + 1;
  const totalNeed = Object.values(need).reduce((a, b) => a + b, 0);
  if (totalNeed === 0) return { coins: 0, left: 0, right: 0 };

  const me = playerBySeat(G, seat);
  const lp = G.nPlayers > 1 ? playerBySeat(G, leftOf(G, seat)) : null;
  const rp = G.nPlayers > 2 ? playerBySeat(G, rightOf(G, seat)) : null;

  // Each generator becomes one supply: capacity is how many units it makes,
  // and every resource it could make is an outgoing edge priced at what that
  // particular resource costs from that particular neighbour. The shared
  // capacity is what stops a Tree Farm being counted as wood AND clay.
  const supplies = [];
  for (const g of generators(me).concat(extraGens)) {
    supplies.push({ opts: g.opts, cap: g.n, from: 'self', price: () => 0 });
  }
  for (const [nb, side] of [[lp, 'left'], [rp, 'right']]) {
    if (!nb || nb.seat === seat) continue;
    for (const g of generators(nb, { sellableOnly: true })) {
      supplies.push({ opts: g.opts, cap: g.n, from: side, price: (r) => tradePrice(me, side, r) });
    }
  }
  const bill = minCostAssign(supplies, need, totalNeed);
  if (!bill) return null;

  // Cities: a clandestine dock takes a coin off the FIRST resource bought from
  // its side each turn. Applied to the finished bill rather than inside the
  // flow — exact whenever the cheapest plan already buys from that side, which
  // is the case that matters, and never makes a card look cheaper than it is.
  for (const side of ['left', 'right']) {
    const has = me.built.some((c) => c.rebate && (c.rebate.with === 'both' || c.rebate.with === side));
    if (!has || !bill[side]) continue;
    bill[side] -= 1;
    bill.coins -= 1;
  }
  return bill;
}

// Successive shortest paths. The graph is tiny — a few dozen supplies against
// at most seven demands — so Bellman-Ford per augmentation is fine and avoids
// the potentials that Dijkstra would need on a residual graph.
function minCostAssign(supplies, need, totalNeed) {
  const kinds = Object.keys(need);
  const S = supplies.length, K = kinds.length;
  const N = S + K + 2, SRC = 0, SINK = N - 1;
  const g = Array.from({ length: N }, () => []);
  const edge = (u, v, cap, cost) => {
    g[u].push({ v, cap, cost, rev: g[v].length });
    g[v].push({ v: u, cap: 0, cost: -cost, rev: g[u].length - 1 });
    return g[u][g[u].length - 1];
  };

  const priced = [];              // remember the edges we may have to pay on
  supplies.forEach((s, i) => {
    edge(SRC, 1 + i, s.cap, 0);
    for (const o of s.opts) {
      const k = kinds.indexOf(o);
      if (k < 0) continue;        // makes something nobody is asking for
      const cost = s.price(o);
      const e = edge(1 + i, S + 1 + k, s.cap, cost);
      if (cost > 0) priced.push({ from: s.from, cost, u: 1 + i, e });
    }
  });
  kinds.forEach((k, i) => edge(S + 1 + i, SINK, need[k], 0));

  let flow = 0, spent = 0;
  while (flow < totalNeed) {
    const dist = new Array(N).fill(Infinity);
    const inq = new Array(N).fill(false);
    const pv = new Array(N).fill(-1), pe = new Array(N).fill(-1);
    dist[SRC] = 0;
    const q = [SRC];
    inq[SRC] = true;
    while (q.length) {
      const u = q.shift();
      inq[u] = false;
      g[u].forEach((e, i) => {
        if (e.cap <= 0 || dist[u] + e.cost >= dist[e.v]) return;
        dist[e.v] = dist[u] + e.cost;
        pv[e.v] = u; pe[e.v] = i;
        if (!inq[e.v]) { inq[e.v] = true; q.push(e.v); }
      });
    }
    if (dist[SINK] === Infinity) return null;      // those resources do not exist
    let push = totalNeed - flow;
    for (let v = SINK; v !== SRC; v = pv[v]) push = Math.min(push, g[pv[v]][pe[v]].cap);
    for (let v = SINK; v !== SRC; v = pv[v]) {
      const e = g[pv[v]][pe[v]];
      e.cap -= push;
      g[e.v][e.rev].cap += push;
    }
    flow += push;
    spent += push * dist[SINK];
  }

  // The flow on an edge is what came back on its twin, so the bill reads
  // straight off the priced edges.
  let left = 0, right = 0;
  for (const p of priced) {
    const used = g[p.e.v][p.e.rev].cap;
    if (used <= 0) continue;
    if (p.from === 'left') left += used * p.cost;
    else if (p.from === 'right') right += used * p.cost;
  }
  return { coins: spent, left, right };
}

// ---------------------------------------------------------------- setup

export function newMatch(roster, opts = {}) {
  const nPlayers = roster.length;
  const o = {
    cities: !!opts.cities, leaders: !!opts.leaders,
    teams: !!opts.teams, sideMode: opts.sideMode || 'random',
  };
  const boards = shuffle(WONDERS.slice());
  const G = {
    proto: PROTO,
    mid: `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,  // a new match clears the log
    opts: o,
    nPlayers,
    age: 1,
    turn: 1,
    phase: 'play',
    players: roster.map((r, i) => {
      const board = boards[i % boards.length];
      const side = o.sideMode === 'A' || o.sideMode === 'B'
        ? o.sideMode : (Math.random() < 0.5 ? 'A' : 'B');
      return {
        seat: r.seat, name: r.name, bot: !!r.bot, botFor: false, connected: r.connected !== false,
        team: o.teams ? Math.floor(r.seat / 2) : null,
        wonder: board.n, side, wonderRes: board.res,
        stages: board.sides[side].map((s) => ({ ...s })),
        stagesBuilt: [],
        coins: o.leaders ? START_COINS_LEADERS : START_COINS,
        built: [],
        shields: 0,
        tokens: [],            // military results, one entry per resolution
        debt: 0,
        diplo: 0,          // Cities: unspent diplomacy tokens
        freeAgeUsed: {},       // Olympia: the one free build per age
        hand: [],
      };
    }),
    hands: {},
    discard: [],
    picks: {},
    revealed: null,            // last turn's plays, for the feed
    result: null,
    log: [], logN: 0,
    chatter: [], chatSeq: 0,
    fx: null, fxSeq: 0,
  };
  dealAge(G);
  addLog(G, `Age I begins. Cards pass to the left.`);
  return G;
}

function dealAge(G) {
  const deck = shuffle(buildAge(G.age, G.nPlayers, G.opts));
  // The deck is built to divide exactly: 7 each in the base game, 8 with Cities
  // (which is why Cities plays seven cards an Age rather than six), and 7 again
  // at an eight-player table, which uses the seven-player deck.
  G.handSize = Math.floor(deck.length / G.nPlayers);
  for (const p of G.players) p.hand = deck.splice(0, G.handSize);
  G.turn = 1;
  G.phase = 'play';
  G.picks = {};
}

// ---------------------------------------------------------------- what you may do

const chainUnlocks = (p) => {
  const s = new Set();
  for (const c of p.built) for (const n of c.chains || []) s.add(n);
  return s;
};

export const alreadyBuilt = (p, name) => p.built.some((c) => c.n === name);

// The next unbuilt stage of your wonder, or null when it is finished.
export function nextStage(p) {
  return p.stagesBuilt.length < p.stages.length ? p.stages[p.stagesBuilt.length] : null;
}

// Everything a player could legally do with each card in hand, priced. The UI
// renders straight off this and applyMove re-derives it, so the two can never
// disagree about what was on offer.
export function optionsFor(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p) return [];
  const unlocked = chainUnlocks(p);
  const stage = nextStage(p);
  const freeStages = p.built.some((c) => c.freeStages);   // Cities: Architect Cabinet
  const stagePay = stage ? (freeStages ? { coins: 0, left: 0, right: 0 } : payFor(G, seat, stage.cost)) : null;

  return p.hand.map((card) => {
    const dup = alreadyBuilt(p, card.n);
    let play = null;
    if (!dup) {
      if (unlocked.has(card.n)) play = { coins: 0, left: 0, right: 0, chain: true };
      else {
        const pay = payFor(G, seat, card.cost);
        if (pay) {
          const total = pay.coins + (card.coin || 0);
          if (total <= p.coins) play = { ...pay, coin: card.coin || 0, coins: total };
        }
      }
    }
    return {
      id: card.id, name: card.n, colour: card.c,
      play,
      why: dup ? 'You have already built that' : (play ? null : 'You cannot pay for it'),
      wonder: stage && stagePay && stagePay.coins <= p.coins ? { ...stagePay } : null,
      wonderWhy: !stage ? 'Your wonder is finished' : (stagePay ? (stagePay.coins <= p.coins ? null : 'You cannot pay for it') : 'You cannot pay for it'),
    };
  });
}

// ---------------------------------------------------------------- moves

export function applyMove(G, seat, move) {
  if (!G || !move) return { ok: false, error: 'Bad move' };
  const p = playerBySeat(G, seat);
  if (!p) return { ok: false, error: 'Not at the table' };
  if (G.phase === 'over') return { ok: false, error: 'The game is over' };
  if (move.kind === 'pick') return doPick(G, p, move);
  return { ok: false, error: 'Unknown action' };
}

function doPick(G, p, move) {
  if (G.phase !== 'play') return { ok: false, error: 'Not choosing right now' };
  if (G.picks[p.seat]) return { ok: false, error: 'You have already chosen' };
  const card = p.hand.find((c) => c.id === move.cardId);
  if (!card) return { ok: false, error: 'That card is not in your hand' };

  const opt = optionsFor(G, p.seat).find((o) => o.id === card.id);
  if (move.how === 'play' && !opt.play) return { ok: false, error: opt.why || 'You cannot build that' };
  if (move.how === 'wonder' && !opt.wonder) return { ok: false, error: opt.wonderWhy || 'You cannot build a stage' };
  if (!['play', 'wonder', 'discard'].includes(move.how)) return { ok: false, error: 'Unknown action' };

  G.picks[p.seat] = {
    seat: p.seat, how: move.how, cardId: card.id,
    pay: move.how === 'play' ? opt.play : move.how === 'wonder' ? opt.wonder : { coins: 0, left: 0, right: 0 },
  };
  if (Object.keys(G.picks).length === G.nPlayers) resolveTurn(G);
  return { ok: true };
}

export function waitingOn(G) {
  if (G.phase !== 'play') return [];
  return G.players.filter((p) => !G.picks[p.seat]).map((p) => p.seat);
}

// ---------------------------------------------------------------- resolution

// Everybody's choice lands at once. Payments are worked out from the state as
// it was at the start of the turn and only then applied, so nobody can spend a
// coin their neighbour is paying them in the same breath.
function resolveTurn(G) {
  const picks = G.players.map((p) => G.picks[p.seat]).filter(Boolean);
  const shown = [];

  for (const pick of picks) {
    const p = playerBySeat(G, pick.seat);
    const card = p.hand.find((c) => c.id === pick.cardId);
    p.hand = p.hand.filter((c) => c.id !== pick.cardId);
    shown.push({ seat: p.seat, how: pick.how, name: card.n, colour: card.c });

    if (pick.how === 'discard') {
      G.discard.push(card);
      p.coins += 3;
      addLog(G, `${p.name} sells a card for 3 coins.`);
      continue;
    }
    // pay the bank and the neighbours
    p.coins -= pick.pay.coins;
    if (pick.pay.left) playerBySeat(G, leftOf(G, p.seat)).coins += pick.pay.left;
    if (pick.pay.right) playerBySeat(G, rightOf(G, p.seat)).coins += pick.pay.right;

    if (pick.how === 'wonder') {
      const stage = nextStage(p);
      // the card goes face down under the board — out of the game, and NOT into
      // the discard pile, which Halikarnassos is allowed to dig through
      p.stagesBuilt.push({ ...stage, buried: card.n });
      applyImmediate(G, p, stage);
      addLog(G, `${p.name} completes stage ${p.stagesBuilt.length} of ${p.wonder}.`);
    } else {
      p.built.push(card);
      applyImmediate(G, p, card);
      addLog(G, `${p.name} builds ${card.n}${pick.pay.coins ? ` for ${pick.pay.coins}` : ''}.`);
    }
  }

  // Cities: losses land after everyone has played and paid for their trades, so
  // the money you just earned this turn is money you can be made to lose.
  for (const pick of picks) {
    if (pick.how !== 'play') continue;
    const p = playerBySeat(G, pick.seat);
    const card = (p.built[p.built.length - 1] || {});
    if (!card.loss && !card.perLoss) continue;
    for (const q of G.players) {
      if (q.seat === p.seat) continue;         // never the player who played it
      const owed = card.loss ? card.loss : countOwned(q, card.perLoss.of) * card.perLoss.coins;
      if (owed <= 0) continue;
      const paid = Math.min(q.coins, owed);
      q.coins -= paid;
      const short = owed - paid;
      if (short > 0) q.debt += short;          // one debt token per coin unpaid
      if (owed) addLog(G, `${q.name} loses ${owed} to ${card.n}${short ? ` (${short} as debt)` : ''}.`);
    }
  }

  G.revealed = shown;
  G.picks = {};
  bumpFx(G, { kind: 'reveal', plays: shown });

  // shields and immediate coins are settled; now pass the hands on
  if (G.turn >= G.handSize - 1) return endAge(G);
  passHands(G);
  G.turn += 1;
}

function applyImmediate(G, p, thing) {
  if (thing.shield) p.shields += thing.shield;
  if (thing.coins) p.coins += thing.coins;
  if (thing.diplo) p.diplo += thing.diplo;
  if (thing.nbCoins) {
    // a gambling den pays the house AND the people either side of it
    for (const s of [leftOf(G, p.seat), rightOf(G, p.seat)]) {
      const q = playerBySeat(G, s);
      if (q && q.seat !== p.seat) q.coins += thing.nbCoins;
    }
  }
  if (thing.per && thing.per.coins) {
    const n = countFor(G, p.seat, thing.per);
    p.coins += n * thing.per.coins;
    if (n) addLog(G, `${p.name} collects ${n * thing.per.coins} coins.`);
  }
}

function passHands(G) {
  const dir = passDir(G.age);
  const next = {};
  for (const p of G.players) {
    const to = dir === 'left' ? leftOf(G, p.seat) : rightOf(G, p.seat);
    next[to] = p.hand;
  }
  for (const p of G.players) p.hand = next[p.seat] || [];
}

// ---------------------------------------------------------------- end of an age

// exported so a test can resolve a conflict without playing six turns first
export function forceEndAge(G) { return endAge(G); }

function endAge(G) {
  // the last card of the age goes in the bin unread
  for (const p of G.players) {
    for (const c of p.hand) G.discard.push(c);
    p.hand = [];
  }

  const win = MILITARY_WIN[G.age];

  // Diplomacy removes you from the table for one conflict: you take nothing,
  // and the two cities either side of you are treated as neighbours and fight
  // each other instead. So the conflict is fought around the circle of players
  // who are actually PRESENT, which is the whole rule in one line. A token must
  // be spent whenever you hold one, even when you would have won.
  const fight = (a, b, tokens) => {
    if (a.shields > b.shields) for (let i = 0; i < tokens; i++) a.tokens.push(win);
    else if (a.shields < b.shields) for (let i = 0; i < tokens; i++) a.tokens.push(MILITARY_LOSS);
  };
  const spend = (p) => { if (p.diplo > 0) { p.diplo -= 1; return true; } return false; };

  if (G.opts.teams) {
    // In team play a diplomat cannot simply leave — the seating is what pairs
    // everyone up, and removing a body would hand their partner two opponents.
    // So they stay and the single border they have pays one token instead of
    // two, for both sides of it.
    const quiet = new Set();
    for (const p of G.players) if (spend(p)) { quiet.add(p.seat); addLog(G, `${p.name} opens negotiations.`); }
    for (const p of G.players) {
      const b = playerBySeat(G, rightOf(G, p.seat));
      if (!b || b.seat === p.seat || b.team === p.team) continue;   // partners never fight
      const tokens = (quiet.has(p.seat) || quiet.has(b.seat)) ? 1 : 2;
      fight(p, b, tokens);
      fight(b, p, tokens);
    }
  } else {
    // Otherwise a diplomat is simply absent: they take nothing, and the two
    // cities either side of them are treated as neighbours and fight each
    // other. So the conflict runs around the circle of players still PRESENT,
    // which is the whole rule in one line.
    const present = [];
    for (const p of G.players) {
      if (spend(p)) addLog(G, `${p.name} sits out the conflict.`);
      else present.push(p);
    }
    if (present.length === 2) {
      // "they only face each other once and each take a single token"
      fight(present[0], present[1], 1);
      fight(present[1], present[0], 1);
    } else if (present.length > 2) {
      for (let i = 0; i < present.length; i++) {
        const a = present[i], b = present[(i + 1) % present.length];
        fight(a, b, 1);
        fight(b, a, 1);
      }
    }
  }
  addLog(G, `Age ${'I'.repeat(G.age)} conflicts resolved.`);
  bumpFx(G, { kind: 'military', age: G.age });

  if (G.age === 3) return endGame(G);
  G.age += 1;
  dealAge(G);
  addLog(G, `Age ${'I'.repeat(G.age)} begins. Cards pass to the ${passDir(G.age)}.`);
}

function bumpFx(G, fx) { G.fx = fx; G.fxSeq += 1; }

// ---------------------------------------------------------------- counting

// What a Cities loss card charges per: conflict victories, or wonder stages.
function countOwned(q, of) {
  if (of === 'victory') return q.tokens.filter((t) => t > 0).length;
  if (of === 'stage') return q.stagesBuilt.length;
  if (of === 'black') return q.built.filter((c) => c.c === 'black').length;
  return 0;
}

// Several cards score "one point per X in these cities". This is that X.
function countFor(G, seat, per) {
  const seats = [];
  if (per.from.includes('self')) seats.push(seat);
  if (per.from.includes('neighbours')) seats.push(leftOf(G, seat), rightOf(G, seat));
  let n = 0;
  for (const s of [...new Set(seats)]) {
    const q = playerBySeat(G, s);
    if (!q) continue;
    if (per.of === 'stage') n += q.stagesBuilt.length;
    else if (per.of === 'defeat') n += q.tokens.filter((t) => t < 0).length;
    else if (per.of === 'victory') n += q.tokens.filter((t) => t > 0).length;
    else {
      const colours = per.of.split('+');
      n += q.built.filter((c) => colours.includes(c.c)).length;
    }
  }
  return n;
}

// Science pays for both breadth and depth: every complete set of three is worth
// seven, and each symbol is worth the square of how many you have. A wildcard
// is worth whatever placing it earns, so try all three and keep the best.
const ALL_SYMBOLS = [0, 1, 2];

// Each entry of `choices` is one symbol you get to place, listed as the symbols
// it is allowed to be. A guild wildcard may be anything; a Cities mask may only
// copy a symbol a neighbour actually has, which is sometimes nothing at all.
function bestScienceOf(counts, choices) {
  if (!choices.length) {
    const [a, b, c] = counts;
    return a * a + b * b + c * c + SCIENCE_SET_BONUS * Math.min(a, b, c);
  }
  const [first, ...rest] = choices;
  if (!first.length) return bestScienceOf(counts, rest);
  let best = 0;
  for (const i of first) {
    counts[i] += 1;
    best = Math.max(best, bestScienceOf(counts, rest));
    counts[i] -= 1;
  }
  return best;
}

function bestScience(counts, wild) {
  return bestScienceOf(counts.slice(), new Array(Math.max(0, wild)).fill(ALL_SYMBOLS));
}

const SCI_INDEX = { compass: 0, gear: 1, tablet: 2 };

export function scoreFor(G, seat) {
  const p = playerBySeat(G, seat);
  const counts = [0, 0, 0];
  let wild = 0;
  const sci = (x) => { if (!x) return; if (x === 'any') wild++; else counts[SCI_INDEX[x]] += 1; };
  for (const c of p.built) sci(c.sci);
  for (const s of p.stagesBuilt) sci(s.sci);

  // Cities: a mask copies a symbol off a green card in one of the two cities
  // beside you — so it is a wildcard, but only over what your neighbours
  // actually own, and worth nothing if neither of them went for science.
  const masks = p.built.reduce((a, c) => a + (c.mask || 0), 0);
  const nearby = new Set();
  if (masks) {
    for (const nb of [leftOf(G, seat), rightOf(G, seat)]) {
      const q = playerBySeat(G, nb);
      if (!q || q.seat === seat) continue;
      for (const c of q.built) if (c.c === 'green' && c.sci && c.sci !== 'any') nearby.add(SCI_INDEX[c.sci]);
    }
  }
  const choices = new Array(wild).fill(ALL_SYMBOLS).concat(new Array(masks).fill([...nearby]));

  const perVp = (list) => list.reduce((a, c) => a + (c.per && c.per.vp ? countFor(G, seat, c.per) * c.per.vp : 0), 0);

  const parts = {
    military: p.tokens.reduce((a, b) => a + b, 0),
    coins: Math.floor(p.coins / 3),
    wonder: p.stagesBuilt.reduce((a, s) => a + (s.vp || 0), 0),
    civilian: p.built.filter((c) => c.c === 'blue').reduce((a, c) => a + (c.vp || 0), 0),
    commercial: perVp(p.built.filter((c) => c.c === 'yellow')),
    guild: perVp(p.built.filter((c) => c.c === 'purple')),
    science: bestScienceOf(counts.slice(), choices),
    debt: -p.debt,
  };
  parts.total = Object.values(parts).reduce((a, b) => a + b, 0);
  return { seat, name: p.name, team: p.team, coins: p.coins, ...parts };
}

function endGame(G) {
  G.phase = 'over';
  const scores = G.players.map((p) => scoreFor(G, p.seat));
  // Ties go to whoever still has the most money; anything still level is shared.
  const ranked = scores.slice().sort((a, b) => b.total - a.total || b.coins - a.coins);
  let teams = null;
  if (G.opts.teams) {
    const byTeam = new Map();
    for (const s of scores) {
      const t = byTeam.get(s.team) || { team: s.team, total: 0, coins: 0, members: [] };
      t.total += s.total; t.coins += s.coins; t.members.push(s.name);
      byTeam.set(s.team, t);
    }
    teams = [...byTeam.values()].sort((a, b) => b.total - a.total || b.coins - a.coins);
  }
  const top = teams ? teams[0].total : ranked[0].total;
  const winners = teams
    ? teams.filter((t) => t.total === top).map((t) => t.members.join(' & '))
    : ranked.filter((s) => s.total === top && s.coins === ranked[0].coins).map((s) => s.name);
  G.result = { scores, ranked, teams, winners };
  addLog(G, `Final: ${winners.join(' & ')} ${winners.length > 1 ? 'tie' : 'wins'} with ${top}.`);
  bumpFx(G, { kind: 'over' });
}

// ---------------------------------------------------------------- the view

// What one seat is allowed to know. Your own hand is yours; everybody's city,
// coins, shields and wonder are on the table for anyone to count.
export function viewFor(G, seat, code) {
  const me = playerBySeat(G, seat);
  return {
    proto: PROTO,
    code,
    mid: G.mid,
    opts: G.opts,
    phase: G.phase,
    age: G.age,
    turn: G.turn,
    turnsPerAge: (G.handSize || CARDS_PER_AGE) - 1,
    mySeat: seat,
    nPlayers: G.nPlayers,
    passDir: passDir(G.age),
    waiting: waitingOn(G),
    iPicked: !!G.picks[seat],
    hand: me ? me.hand : [],
    options: G.phase === 'play' && me && !G.picks[seat] ? optionsFor(G, seat) : [],
    players: G.players.map((p) => ({
      seat: p.seat, name: p.name, bot: p.bot, connected: p.connected, team: p.team,
      wonder: p.wonder, side: p.side, wonderRes: p.wonderRes,
      stages: p.stages, stagesBuilt: p.stagesBuilt.length,
      nextStageCost: nextStage(p) ? nextStage(p).cost : null,
      coins: p.coins, shields: p.shields, tokens: p.tokens, debt: p.debt, diplo: p.diplo,
      built: p.built, handCount: p.hand.length,
      picked: !!G.picks[p.seat],
    })),
    left: leftOf(G, seat), right: rightOf(G, seat), partner: partnerOf(G, seat),
    discardCount: G.discard.length,
    revealed: G.revealed,
    result: G.result,
    log: G.log.slice(-30),
    chatter: G.chatter,
    chatSeq: G.chatSeq,
    fx: G.fx, fxSeq: G.fxSeq,
  };
}

// ---------------------------------------------------------------- bots

// Not a solver — a club player. It values a card by what it would add to the
// final score if the game stopped soon, nudged by the things that only pay off
// later: resources are worth more in Age I than Age III, and shields are worth
// what they would actually win rather than a flat rate.
// Science is the one colour a card-by-card valuation cannot see the point of.
// The first compass is worth a single point — it loses to any blue card — so a
// bot that scores a card by what it adds TODAY never takes the first one, and
// therefore never reaches the second and third, where the squares and the
// seven-point sets actually live. Three of each is 48 points from nine cards;
// judged one at a time, none of those nine is ever worth playing.
//
// So value it the way a person does: assume you carry on collecting. Work out
// how many more symbols you could plausibly still pick up, let bestScience
// place them wherever they earn most, and ask what THIS card adds to that. The
// allowance shrinks as the game runs out, and in the last turns of Age III it
// is zero and this collapses back to the honest marginal.
// How far a bot trusts the projection over what a science card is worth today.
// Swept head-to-head against a bot that only counts today's value, 2000 games
// per setting at 4 and 6 players, with faith=0 as a control that correctly came
// back at 50%. At 0.3 a bot plays science (3 points a game becomes 9) without
// losing ground; at 0.45 it starts chasing sets it will not finish and drops to
// 46% at six players, where the green cards are spread thinnest. This buys
// variety and plausibility rather than strength — a bot that valued cards by
// what they add today was not weaker, it was just strange to play against,
// building libraries next to nobody and never a second compass.
export const BOT = { scienceFaith: 0.3 };

function scienceRoom(G) {
  const perAge = (G.handSize || CARDS_PER_AGE) - 1;
  const turnsLeft = (3 - G.age) * perAge + (perAge - G.turn);
  return Math.max(0, Math.min(3, Math.round(turnsLeft / 5)));
}

// Symbols you have not collected yet ARRIVE, they are not placed: you take
// whichever green card comes round, so the allowance has to be spread rather
// than handed to bestScience as wildcards. Left as wildcards it stacks all
// three onto one symbol — n squared beats the set bonus — and concludes you
// are heading for six compasses, which do not exist. Spreading onto whichever
// symbol you hold least of is both realistic and the thing that makes
// finishing a set look as good as it is.
function projectScience(counts, wild, room) {
  const c = counts.slice();
  for (let i = 0; i < room; i++) {
    let lo = 0;
    for (let k = 1; k < 3; k++) if (c[k] < c[lo]) lo = k;
    c[lo] += 1;
  }
  return bestScience(c, wild);
}

function scienceGain(G, seat, symbol) {
  const p = playerBySeat(G, seat);
  const counts = [0, 0, 0];
  let wild = 0;
  const add = (x) => { if (!x) return; if (x === 'any') wild += 1; else counts[SCI_INDEX[x]] += 1; };
  for (const c of p.built) add(c.sci);
  for (const s of p.stagesBuilt) add(s.sci);
  const room = scienceRoom(G);
  const flat = bestScience(counts, wild);
  const proj = projectScience(counts, wild, room);
  add(symbol);
  // How far to trust the projection over what the card is worth right now.
  // Swept against the previous bot head-to-head; see BOT.scienceFaith.
  const now = bestScience(counts, wild) - flat;
  const ahead = projectScience(counts, wild, room) - proj;
  return now + BOT.scienceFaith * (ahead - now);
}

function valueOf(G, seat, card) {
  const p = playerBySeat(G, seat);
  const age = G.age;
  let v = 0;
  v += (card.vp || 0);
  if (card.shield) v += card.shield * militaryWorth(G, seat);
  if (card.sci) v += scienceGain(G, seat, card.sci);
  if (card.give) v += (4 - age) * 1.6;                 // a mine is worth having early
  if (card.trade) v += (4 - age) * 0.9;
  if (card.coins) v += card.coins / 3;
  if (card.per) {
    const n = countFor(G, seat, card.per);
    v += n * (card.per.vp || 0) + n * (card.per.coins || 0) / 3;
  }
  if (card.chains && card.chains.length) v += 0.5;      // opens something later
  return v;
}

// A shield is worth the swing it causes, not a fixed number: pointless when you
// are already winning both sides by a mile, precious when one more would flip a
// loss into a win in Age III.
function militaryWorth(G, seat) {
  const p = playerBySeat(G, seat);
  const win = MILITARY_WIN[G.age];
  let worth = 0;
  for (const s of [leftOf(G, seat), rightOf(G, seat)]) {
    const o = playerBySeat(G, s);
    if (!o || o.seat === seat) continue;
    const gap = p.shields - o.shields;
    if (gap < 0) worth += (win + 1) / Math.max(1, -gap);   // catching up is worth a lot
    else if (gap === 0) worth += win * 0.8;
    else worth += 0.3;
  }
  return worth / 2;
}

export function botChoose(G, seat) {
  if (G.phase !== 'play') return null;
  const p = playerBySeat(G, seat);
  if (!p || G.picks[seat]) return null;
  const opts = optionsFor(G, seat);
  if (!opts.length) return null;

  const scored = [];
  for (const o of opts) {
    const card = p.hand.find((c) => c.id === o.id);
    if (o.play) {
      const spend = o.play.coins;
      scored.push({ how: 'play', cardId: o.id, v: valueOf(G, seat, card) - spend * 0.35 });
    }
    if (o.wonder) {
      const stage = nextStage(p);
      let v = (stage.vp || 0) + (stage.shield || 0) * militaryWorth(G, seat) + (stage.coins || 0) / 3;
      if (stage.sci) v += scienceGain(G, seat, stage.sci);
      if (stage.act || stage.give || stage.trade) v += 3;
      scored.push({ how: 'wonder', cardId: o.id, v: v - o.wonder.coins * 0.35 + 0.4 });
    }
    // selling is the floor: three coins and denying nobody anything
    scored.push({ how: 'discard', cardId: o.id, v: 1.0 - valueOf(G, seat, card) * 0.15 });
  }
  scored.sort((a, b) => b.v - a.v);
  const best = scored[0];
  return { kind: 'pick', how: best.how, cardId: best.cardId };
}

// ---------------------------------------------------------------- lifecycle

export function markReconnected(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p || p.connected) return false;
  p.connected = true; p.botFor = false;
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
  p.name = name; p.connected = true; p.botFor = false;
  addLog(G, `${name} takes over seat ${seat}.`);
  return true;
}
export function markSeatResigned(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p) return false;
  p.connected = false; p.botFor = false;
  addLog(G, `${p.name} resigned their seat.`);
  return true;
}
