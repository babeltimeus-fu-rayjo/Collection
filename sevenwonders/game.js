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
  BASE_AGES, GUILDS, WONDERS, CITY_CARDS, DEBT_VP,
  LEADERS, LEADERS_PER_PLAYER,
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
    // guilds: player count + 2 of the ten, drawn at random
    for (const g of shuffle(GUILDS.slice(), rnd).slice(0, scale + 2)) out.push({ ...g, age: 3 });
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

  // Cities: the Black Market makes whatever your city cannot, and the Secret
  // Warehouse one more of something it can. "Can" means your brown and grey
  // cards and the board itself — the ones above — so both have to be worked out
  // after them, and both are yours alone to use.
  const missingCount = p.built.filter((c) => c.produceMissing).length;
  const ownCount = p.built.filter((c) => c.produceOwn).length;
  if (missingCount || ownCount) {
    const own = new Set();
    if (p.wonderRes) own.add(p.wonderRes);
    for (const c of p.built) {
      if (!c.give || (c.c !== 'brown' && c.c !== 'grey')) continue;
      for (const o of c.give.split('/')) for (const ch of o) own.add(ch);
    }
    const missing = RESOURCES.split('').filter((r) => !own.has(r));
    if (missing.length) for (let i = 0; i < missingCount; i++) gens.push({ opts: missing, n: 1, sellable: false, why: 'black market' });
    if (own.size) for (let i = 0; i < ownCount; i++) gens.push({ opts: [...own], n: 1, sellable: false, why: 'warehouse' });
  }
  return sellableOnly ? gens.filter((g) => g.sellable) : gens;
}

const isRaw = (r) => RAW.includes(r);

// What one unit of a given resource costs from a given neighbour, after
// trading posts and Olympia's B-side discount.
function tradePrice(p, side, resource, theirBoardRes) {
  const kind = isRaw(resource) ? 'raw' : 'man';
  let price = 2;
  const consider = (t) => {
    if (!t || t.kind !== kind) return;
    if (t.with === 'both' || t.with === side) price = Math.min(price, 1);
  };
  for (const c of p.built) consider(c.trade);
  for (const s of p.stagesBuilt) consider(s.trade);
  // Cities: the Smuggler's Cache takes a coin off the resource that neighbour's
  // own board makes, from either side, EVERY time — where the wharves take one
  // off whatever you happened to buy first from one side, once a turn. It lives
  // in here rather than on the finished bill because it is exact: the flow can
  // see which neighbour a unit is coming from and what it is.
  //
  // It stacks with a trading post down to nothing, which is what the publisher
  // says the wharves do and is the same wording. Read as the resource TYPE
  // printed on their board, not as the single unit the board itself makes:
  // resources are fungible once bought, and the table has no way to say which
  // of a neighbour's two stones came off the board.
  if (theirBoardRes && resource === theirBoardRes && p.built.some((c) => c.smuggle)) price -= 1;
  return Math.max(0, price);
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
      supplies.push({ opts: g.opts, cap: g.n, from: side, price: (r) => tradePrice(me, side, r, nb.wonderRes) });
    }
  }
  // Leaders: Bilkis sells you one resource a turn out of the bank, at a coin
  // each. It is a supply like any other — the flow decides whether it is worth
  // using — and the coin goes to nobody, so it never shows up in the split.
  const bank = me.built.reduce((a, c) => a + (c.bankBuy || 0), 0);
  if (bank) supplies.push({ opts: RESOURCES.split(''), cap: bank, from: 'bank', price: () => 1 });

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

// "Pay 1 fewer resource" — Imhotep on wonder stages, Hammurabi, Leonidas and
// Archimedes on a colour each. WHICH resource you drop is yours to choose, and
// the cheapest choice is not always the dearest letter: a stone you already
// quarry is free, so dropping it saves nothing. There are at most seven
// distinct letters in a cost, so ask the flow about each and keep the best.
export function payWithDiscount(G, seat, cost, on) {
  const me = playerBySeat(G, seat);
  if (!cost || !me.built.some((c) => c.discount && c.discount.of === on)) return payFor(G, seat, cost);
  let best = payFor(G, seat, cost);
  for (const r of new Set(cost)) {
    const bill = payFor(G, seat, cost.replace(r, ''));
    if (bill && (!best || bill.coins < best.coins)) best = bill;
  }
  return best;
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
        freeAgeUsed: {},       // Olympia, and Caligula: one free build an age
        leaders: [],           // Leaders: recruited one an Age, four drafted
        draft: [],             // ... and what is still going round the table
        bonusUsed: false,      // Berenice: her extra coin, once a turn
        builtThisAge: 0,       // Olympia: whether the first one is still to come
        hand: [],
      };
    }),
    hands: {},
    discard: [],
    salvage: null,             // who is digging through it right now
    salvageAsk: [],            // ... and who has earned the right to
    lastCard: [],              // Babylon: who still owes the Age one more card
    lateCards: 0,              // ... and how many it has played rather than binned
    picks: {},
    revealed: null,            // last turn's plays, for the feed
    result: null,
    log: [], logN: 0,
    chatter: [], chatSeq: 0,
    fx: null, fxSeq: 0,
  };
  if (o.leaders) dealLeaders(G);
  else beginAge(G);
  return G;
}

// ---------------------------------------------------------------- leaders
//
// Two phases the base game does not have. Before Age I everyone is dealt four
// leaders and drafts four, keeping one and passing the rest to the right; then
// at the start of every Age one of those four is recruited, spent on a wonder
// stage, or sold for three coins. Three Ages against four leaders is why the
// fourth is never played.
//
// Both phases are simultaneous, like an ordinary turn, so they reuse G.picks
// and the same "everybody has chosen" trigger.

const leaderDeck = (opts) => LEADERS
  .map((l, i) => ({ ...l, c: 'white', id: `L${i}` }))
  .filter((l) => l.set !== 'cities' || opts.cities);

function dealLeaders(G) {
  const deck = shuffle(leaderDeck(G.opts));
  for (const p of G.players) p.draft = deck.splice(0, LEADERS_PER_PLAYER);
  G.draftRound = 1;
  G.phase = 'draft';
  G.picks = {};
  addLog(G, `Leader draft: keep one, pass the rest to the right.`);
}

function doDraft(G, p, move) {
  if (G.picks[p.seat]) return { ok: false, error: 'You have already chosen' };
  const card = p.draft.find((c) => c.id === move.cardId);
  if (!card) return { ok: false, error: 'That leader is not in your hand' };
  G.picks[p.seat] = { seat: p.seat, cardId: card.id };
  if (Object.keys(G.picks).length === G.nPlayers) resolveDraft(G);
  return { ok: true };
}

function resolveDraft(G) {
  for (const p of G.players) {
    const id = G.picks[p.seat].cardId;
    p.leaders.push(p.draft.find((c) => c.id === id));
    p.draft = p.draft.filter((c) => c.id !== id);
  }
  G.picks = {};
  if (G.draftRound >= LEADERS_PER_PLAYER) {
    addLog(G, `Everyone has four leaders.`);
    return beginAge(G);
  }
  const next = {};
  for (const p of G.players) next[rightOf(G, p.seat)] = p.draft;
  for (const p of G.players) p.draft = next[p.seat] || [];
  G.draftRound += 1;
  bumpFx(G, { kind: 'draft', round: G.draftRound });
}

// A leader whose cost is the Age costs 1, 2 or 3 — cheap early, dear late.
export function coinCost(card, age) {
  return card.coin === 'age' ? age : (card.coin || 0);
}

// The same shape optionsFor returns, so one renderer draws both. The
// difference is that a leader's price is always coins and never resources.
export function leaderOptionsFor(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p) return [];
  const free = p.built.some((c) => c.freeLeaders);          // Maecenas
  const stage = nextStage(p);
  const freeStages = p.built.some((c) => c.freeStages);
  const stagePay = stage
    ? (freeStages ? { coins: 0, left: 0, right: 0 } : payWithDiscount(G, seat, stage.cost, 'stage'))
    : null;
  const canStage = !!(stage && stagePay && stagePay.coins <= p.coins);
  return p.leaders.map((card) => {
    const price = free ? 0 : coinCost(card, G.age);
    return {
      id: card.id, name: card.n, colour: 'white',
      play: price <= p.coins ? { coins: price, left: 0, right: 0, coin: price } : null,
      why: price <= p.coins ? null : 'You cannot pay for it',
      wonder: canStage ? { ...stagePay } : null,
      wonderWhy: !stage ? 'Your wonder is finished' : (canStage ? null : 'You cannot pay for it'),
    };
  });
}

function doRecruit(G, p, move) {
  if (G.picks[p.seat]) return { ok: false, error: 'You have already chosen' };
  const card = p.leaders.find((c) => c.id === move.cardId);
  if (!card) return { ok: false, error: 'That leader is not in your hand' };
  if (!['play', 'wonder', 'discard'].includes(move.how)) return { ok: false, error: 'Unknown action' };
  const opt = leaderOptionsFor(G, p.seat).find((o) => o.id === card.id);
  if (move.how === 'play' && !opt.play) return { ok: false, error: opt.why || 'You cannot recruit that' };
  if (move.how === 'wonder' && !opt.wonder) return { ok: false, error: opt.wonderWhy || 'You cannot build a stage' };
  G.picks[p.seat] = {
    seat: p.seat, how: move.how, cardId: card.id,
    pay: move.how === 'play' ? opt.play : move.how === 'wonder' ? opt.wonder : { coins: 0, left: 0, right: 0 },
  };
  if (Object.keys(G.picks).length === G.nPlayers) resolveRecruit(G);
  return { ok: true };
}

function resolveRecruit(G) {
  for (const q of G.players) q.bonusUsed = false;
  const shown = [];
  const charges = [];
  for (const p of G.players) {
    const pick = G.picks[p.seat];
    if (!pick) continue;
    const card = p.leaders.find((c) => c.id === pick.cardId);
    p.leaders = p.leaders.filter((c) => c.id !== pick.cardId);
    shown.push({ seat: p.seat, how: pick.how, name: card.n, colour: 'white' });
    if (pick.how === 'discard') {
      gainCoins(G, p, 3);
      addLog(G, `${p.name} sends a leader away for 3 coins.`);
      continue;
    }
    p.coins -= pick.pay.coins;
    if (pick.pay.left) playerBySeat(G, leftOf(G, p.seat)).coins += pick.pay.left;
    if (pick.pay.right) playerBySeat(G, rightOf(G, p.seat)).coins += pick.pay.right;
    if (pick.how === 'wonder') {
      buildStage(G, p, card, charges);
    } else {
      p.built.push(card);
      applyImmediate(G, p, card);
      recruitEffects(G, p, card);
      chargeFor(G, p, card, charges);
      addLog(G, `${p.name} recruits ${card.n}${pick.pay.coins ? ` for ${pick.pay.coins}` : ''}.`);
    }
  }
  applyCharges(G, charges);
  G.revealed = shown;
  G.picks = {};
  bumpFx(G, { kind: 'recruited', plays: shown });
  finishRecruit(G);
}

// Solomon is recruited before the Age is dealt, so his dig through the pile
// happens on last Age's leavings — which is the whole point of him.
function finishRecruit(G) {
  if (G.salvageAsk.length) return openSalvage(G, 'recruit');
  dealAge(G);
}

// The things a leader does the moment it arrives and never again.
function recruitEffects(G, p, card) {
  if (card.purge) {
    // Telesilla: your defeats are struck off, and everyone else gives up a
    // victory "of their choice" — which is always their cheapest one.
    p.tokens = p.tokens.filter((t) => t > 0);
    for (const q of G.players) {
      if (q.seat === p.seat) continue;
      let lo = -1;
      q.tokens.forEach((t, i) => { if (t > 0 && (lo < 0 || t < q.tokens[lo])) lo = i; });
      if (lo >= 0) q.tokens.splice(lo, 1);
    }
    addLog(G, `${p.name} rewrites the histories: their defeats are gone, everyone else loses a victory.`);
  }
}

// The start of an Age. With Leaders, recruitment comes before the cards are
// dealt — so the coins a leader costs are coins you do not have for the first
// card of the Age, which is the whole tension of the phase.
function beginAge(G) {
  addLog(G, `Age ${'I'.repeat(G.age)} begins. Cards pass to the ${passDir(G.age)}.`);
  if (G.opts.leaders) {
    G.phase = 'recruit';
    G.picks = {};
    addLog(G, `Recruitment: play one of your leaders.`);
    bumpFx(G, { kind: 'recruit', age: G.age });
    return;
  }
  dealAge(G);
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
  for (const p of G.players) p.builtThisAge = 0;
}

// ---------------------------------------------------------------- what you may do

const chainUnlocks = (p) => {
  const s = new Set();
  for (const c of p.built) for (const n of c.chains || []) s.add(n);
  return s;
};

export const alreadyBuilt = (p, name) => p.built.some((c) => c.n === name);

// The abilities printed on the boards rather than bought with a card.
const hasAct = (p, act) => p.stagesBuilt.some((s) => s.act === act);

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
  const freeStages = p.built.some((c) => c.freeStages);   // Cities: Architect Firm
  const stagePay = stage
    ? (freeStages ? { coins: 0, left: 0, right: 0 } : payWithDiscount(G, seat, stage.cost, 'stage'))
    : null;

  // Ramses waives a whole colour for good, so there is nothing to save and it
  // is applied without asking. Caligula waives one black card an Age and
  // Olympia one card of ANY colour an Age — those are allowances, and spending
  // one on a card you could have paid for is usually a mistake. So they are
  // offered as a second way to build rather than quietly taken.
  const freeCol = new Set(), freeOnce = new Set();
  for (const c of p.built) {
    if (c.freeColour) freeCol.add(c.freeColour);
    if (c.freeColourAge && !p.freeAgeUsed[`${c.freeColourAge}-${G.age}`]) freeOnce.add(c.freeColourAge);
  }

  // Olympia. Unlike Caligula's, these are conditions and not allowances —
  // there is nothing to spend or save, so they apply themselves.
  const lastTurn = G.turn >= (G.handSize || CARDS_PER_AGE) - 1;
  const gratis = (card) => {
    if (hasAct(p, 'freeFirstOfColour') && !p.built.some((c) => c.c === card.c)) return 'colour';
    if (hasAct(p, 'freeFirstOfAge') && !p.builtThisAge) return 'age';
    if (hasAct(p, 'freeLastOfAge') && lastTurn) return 'last';
    return null;
  };

  return p.hand.map((card) => {
    const dup = alreadyBuilt(p, card.n);
    let play = null, playFree = null;
    if (!dup) {
      const olympia = gratis(card);
      if (unlocked.has(card.n)) play = { coins: 0, left: 0, right: 0, chain: true };
      else if (freeCol.has(card.c)) play = { coins: 0, left: 0, right: 0, gift: card.c };
      else if (olympia) play = { coins: 0, left: 0, right: 0, gift: olympia };
      else {
        const pay = payWithDiscount(G, seat, card.cost, card.c);
        if (pay) {
          const total = pay.coins + (card.coin || 0);
          if (total <= p.coins) play = { ...pay, coin: card.coin || 0, coins: total };
        }
      }
      // ... and the allowance, when there is actually something to save on.
      // A colour-specific one goes first, so the general one keeps its options.
      if (!play || play.coins > 0) {
        const gift = freeOnce.has(card.c) ? card.c : freeOnce.has('any') ? 'any' : null;
        if (gift) playFree = { coins: 0, left: 0, right: 0, gift, once: true };
      }
    }
    return {
      id: card.id, name: card.n, colour: card.c,
      play, playFree,
      why: dup ? 'You have already built that' : (play || playFree ? null : 'You cannot pay for it'),
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
  if (G.phase === 'salvage') {
    return move.kind === 'salvage'
      ? doSalvage(G, p, move)
      : { ok: false, error: 'Somebody is choosing from the discard' };
  }
  if (G.phase === 'lastcard') {
    return move.kind === 'pick' ? doLastCard(G, p, move) : { ok: false, error: 'One last card to play' };
  }
  if (G.phase === 'draft') {
    return move.kind === 'draft' || move.kind === 'pick'
      ? doDraft(G, p, move) : { ok: false, error: 'Pick a leader to keep' };
  }
  if (G.phase === 'recruit') {
    return move.kind === 'pick' ? doRecruit(G, p, move) : { ok: false, error: 'Play one of your leaders' };
  }
  if (move.kind === 'pick') return doPick(G, p, move);
  return { ok: false, error: 'Unknown action' };
}

// The four things you can do with a card in hand, priced. Shared by an
// ordinary turn and by Babylon's extra one at the end of an Age.
function pickFrom(G, p, card, how) {
  const opt = optionsFor(G, p.seat).find((o) => o.id === card.id);
  if (how === 'play' && !opt.play) return { error: opt.why || 'You cannot build that' };
  if (how === 'free' && !opt.playFree) return { error: 'You have no free build left this Age' };
  if (how === 'wonder' && !opt.wonder) return { error: opt.wonderWhy || 'You cannot build a stage' };
  if (!['play', 'free', 'wonder', 'discard'].includes(how)) return { error: 'Unknown action' };
  return {
    pay: how === 'play' ? opt.play : how === 'free' ? opt.playFree
      : how === 'wonder' ? opt.wonder : { coins: 0, left: 0, right: 0 },
  };
}

function doPick(G, p, move) {
  if (G.phase !== 'play') return { ok: false, error: 'Not choosing right now' };
  if (G.picks[p.seat]) return { ok: false, error: 'You have already chosen' };
  const card = p.hand.find((c) => c.id === move.cardId);
  if (!card) return { ok: false, error: 'That card is not in your hand' };

  const pick = pickFrom(G, p, card, move.how);
  if (pick.error) return { ok: false, error: pick.error };

  G.picks[p.seat] = { seat: p.seat, how: move.how, cardId: card.id, pay: pick.pay };
  if (Object.keys(G.picks).length === G.nPlayers) resolveTurn(G);
  return { ok: true };
}

const SIMULTANEOUS = ['play', 'draft', 'recruit'];

export function waitingOn(G) {
  if (G.phase === 'salvage') return G.salvage ? [G.salvage.queue[0].seat] : [];
  if (G.phase === 'lastcard') return G.lastCard.slice();
  if (!SIMULTANEOUS.includes(G.phase)) return [];
  return G.players.filter((p) => !G.picks[p.seat]).map((p) => p.seat);
}

// ---------------------------------------------------------------- resolution

// Everybody's choice lands at once. Payments are worked out from the state as
// it was at the start of the turn and only then applied, so nobody can spend a
// coin their neighbour is paying them in the same breath.
function resolveTurn(G) {
  const picks = G.players.map((p) => G.picks[p.seat]).filter(Boolean);
  const shown = [];
  const charges = [];                       // "everyone else pays", settled below
  for (const q of G.players) q.bonusUsed = false;

  for (const pick of picks) {
    const p = playerBySeat(G, pick.seat);
    const card = p.hand.find((c) => c.id === pick.cardId);
    shown.push(settlePick(G, p, card, pick, charges));
  }

  applyCharges(G, charges);

  G.revealed = shown;
  G.picks = {};
  bumpFx(G, { kind: 'reveal', plays: shown });
  finishTurn(G);
}

// The tail of a turn. Anyone digging through the discard interrupts here —
// they choose while the rest of the table waits — and the turn resumes from
// this same function once the pile has been put back.
function finishTurn(G) {
  if (G.salvageAsk.length) return openSalvage(G, 'turn');
  // shields and immediate coins are settled; now pass the hands on
  if (G.turn >= G.handSize - 1) return endAge(G);
  passHands(G);
  G.turn += 1;
  G.phase = 'play';
}

// ---------------------------------------------------------------- the discard
//
// Four things in the box reach into the discard pile and they all say the same
// sentence: take the whole pile, choose one card, construct it for nothing.
// Solomon and Cities' Forging Agency are word-for-word identical, and every
// stage of Halikarnassos does it too. What they need from the engine is not a
// field but a PHASE — one player choosing while everybody else waits — which
// is why all four arrived together.
//
// The pile is not public. The rules have you pick it up, look through it,
// take one and put the rest back without showing anyone, so viewFor hands the
// list to the seat that is choosing and to nobody else.
//
// Leaders sold during Recruitment are NOT in here. They are set aside rather
// than discarded, so a leader somebody threw away cannot be salvaged; the
// discard pile is the Age-card pile.

// What this seat may take. Not the whole pile: you can never hold two cards of
// the same name, so your own city thins it before you ever see it.
export function salvageOptions(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p) return [];
  return G.discard.filter((c) => !alreadyBuilt(p, c.n));
}

const byRank = (a, b) => a.rank - b.rank;   // stable, so ties stay in seat order

function openSalvage(G, resume) {
  G.salvage = { queue: G.salvageAsk.sort(byRank), resume };
  G.salvageAsk = [];
  G.phase = 'salvage';
  bumpFx(G, { kind: 'salvage', seat: G.salvage.queue[0].seat });
  nextSalvage(G);
}

// Hand the pile to the next person owed a look, skipping anyone it holds
// nothing for, and resume the turn once nobody is left. A card taken out of
// the pile can itself reach back into it — the Forging Agency is in there —
// so the queue is drained rather than walked.
function nextSalvage(G) {
  for (;;) {
    if (G.salvageAsk.length) {
      G.salvage.queue.push(...G.salvageAsk.sort(byRank));
      G.salvageAsk = [];
    }
    const head = G.salvage.queue[0];
    if (!head) break;
    if (salvageOptions(G, head.seat).length) return;
    G.salvage.queue.shift();
    addLog(G, `${playerBySeat(G, head.seat).name} finds nothing to take from the discard.`);
  }
  const resume = G.salvage.resume;
  G.salvage = null;
  if (resume === 'recruit') finishRecruit(G);
  else if (resume === 'age') resolveAge(G);
  else finishTurn(G);
}

function takeFromDiscard(G, p, card, why) {
  G.discard = G.discard.filter((c) => c.id !== card.id);
  // marked, because a card that came out of the pile was never played from
  // anybody's hand — which is the one thing that stops the cards adding up
  p.built.push({ ...card, fromPile: true });
  const charges = [];
  applyImmediate(G, p, card);
  buildEffects(G, p, card, { pay: {} });    // free, but not free THROUGH a chain
  chargeFor(G, p, card, charges);
  applyCharges(G, charges);
  addLog(G, `${p.name} builds ${card.n} out of the discard for nothing (${why}).`);
}

function doSalvage(G, p, move) {
  const head = G.salvage && G.salvage.queue[0];
  if (!head || head.seat !== p.seat) return { ok: false, error: 'Somebody else is choosing' };
  if (move.how === 'pass') {
    addLog(G, `${p.name} puts the discard back untouched.`);
  } else {
    const card = G.discard.find((c) => c.id === move.cardId);
    if (!card) return { ok: false, error: 'That card is not in the discard' };
    if (alreadyBuilt(p, card.n)) return { ok: false, error: 'You have already built that' };
    takeFromDiscard(G, p, card, head.why);
  }
  G.salvage.queue.shift();
  nextSalvage(G);
  return { ok: true };
}

// Every coin the BANK hands you arrives through here, because Berenice takes
// one more the first time that happens each turn. Coins a neighbour pays you
// for a trade are not the bank's and do not count.
function gainCoins(G, p, n) {
  if (!n) return;
  p.coins += n;
  if (n > 0 && !p.bonusUsed && p.built.some((c) => c.bonusCoin)) {
    p.coins += 1;
    p.bonusUsed = true;
  }
}

// Military victory tokens are handed out in exactly two places — the end of an
// Age, and Nitocris — and Nero is paid for both.
function winToken(G, p, value) {
  p.tokens.push(value);
  const fee = p.built.reduce((a, c) => a + (c.onWin ? c.onWin.coins : 0), 0);
  if (fee) gainCoins(G, p, fee);
}

// One player's choice, carried out. Pulled out of the turn loop because
// Babylon plays a card of its own after everybody else has finished theirs,
// and it has to mean exactly the same thing when it does.
function settlePick(G, p, card, pick, charges) {
  p.hand = p.hand.filter((c) => c.id !== card.id);
  const shown = { seat: p.seat, how: pick.how, name: card.n, colour: card.c };
  if (pick.how === 'discard') {
    G.discard.push(card);
    gainCoins(G, p, 3);
    addLog(G, `${p.name} sells a card for 3 coins.`);
    return shown;
  }
  // pay the bank and the neighbours
  p.coins -= pick.pay.coins;
  if (pick.pay.left) playerBySeat(G, leftOf(G, p.seat)).coins += pick.pay.left;
  if (pick.pay.right) playerBySeat(G, rightOf(G, p.seat)).coins += pick.pay.right;

  if (pick.how === 'wonder') {
    buildStage(G, p, card, charges);
    return shown;
  }
  if (pick.pay.once) p.freeAgeUsed[`${pick.pay.gift}-${G.age}`] = true;
  p.builtThisAge += 1;
  p.built.push(card);
  applyImmediate(G, p, card);
  buildEffects(G, p, card, pick);
  chargeFor(G, p, card, charges);
  addLog(G, `${p.name} builds ${card.n}${pick.pay.coins ? ` for ${pick.pay.coins}` : pick.pay.once ? ' for nothing' : ''}.`);
  return shown;
}

function applyImmediate(G, p, thing) {
  // A card, or a wonder stage, that reaches into the discard pile. It cannot
  // be settled here — the turn everybody else is in the middle of has to
  // finish first — so it joins a queue that finishTurn picks up.
  // The publisher's clarification: when more than one of these fires in the
  // same turn, the wonder goes first, then Solomon, then the Forging Agency.
  // A stage has no name of its own, a leader is white and a black card is not.
  if (thing.salvage) {
    const rank = !thing.n ? 0 : thing.c === 'white' ? 1 : 2;
    G.salvageAsk.push({ seat: p.seat, why: thing.n || p.wonder, rank });
  }
  if (thing.shield) p.shields += thing.shield;
  if (thing.coins) gainCoins(G, p, thing.coins);
  if (thing.diplo) p.diplo += thing.diplo;
  // Cities: the raiders take a victory token of their own Age and hand each
  // neighbour a debt for the trouble. Leaders' Nitocris takes one for whichever
  // Age it happens to be, which is the same thing with the Age left open.
  if (thing.token) {
    const age = thing.token === 'age' ? G.age : thing.token;
    winToken(G, p, MILITARY_WIN[age]);
    addLog(G, `${p.name} takes an Age ${'I'.repeat(age)} victory without a fight.`);
  }
  if (thing.nbDebt) {
    for (const sn of [leftOf(G, p.seat), rightOf(G, p.seat)]) {
      const q = playerBySeat(G, sn);
      if (q && q.seat !== p.seat) q.debt += thing.nbDebt;
    }
    addLog(G, `${p.name} leaves both neighbours in debt.`);
  }
  // ... and the Memorial buys your defeats off you before burning them, so the
  // counting has to happen before the burning.
  if (thing.coinsPerDefeat) {
    const n = p.tokens.filter((t) => t < 0).length;
    if (n) {
      gainCoins(G, p, n * thing.coinsPerDefeat);
      addLog(G, `${p.name} is paid ${n * thing.coinsPerDefeat} for ${n} defeat${n > 1 ? 's' : ''}.`);
    }
  }
  if (thing.purgeDefeats) p.tokens = p.tokens.filter((t) => t >= 0);
  if (thing.nbCoins) {
    // a gambling den pays the house AND the people either side of it
    for (const s of [leftOf(G, p.seat), rightOf(G, p.seat)]) {
      const q = playerBySeat(G, s);
      if (q && q.seat !== p.seat) gainCoins(G, q, thing.nbCoins);
    }
  }
  if (thing.per && thing.per.coins) {
    const n = countFor(G, p.seat, thing.per);
    gainCoins(G, p, n * thing.per.coins);
    if (n) addLog(G, `${p.name} collects ${n * thing.per.coins} coins.`);
  }
}

// A wonder stage, however it was paid for and whatever card was buried under
// it. The card goes face down under the board — out of the game, and NOT into
// the discard pile, which Halikarnassos is allowed to dig through.
function buildStage(G, p, card, charges) {
  const stage = nextStage(p);
  p.stagesBuilt.push({ ...stage, buried: card.n });
  applyImmediate(G, p, stage);
  for (const c of p.built) {            // Leaders: Octavia throws a parade
    if (!c.onStage) continue;
    gainCoins(G, p, c.onStage.coins);
    if (c.onStage.others) charges.push({ by: p, name: c.n, flat: c.onStage.others });
  }
  addLog(G, `${p.name} completes stage ${p.stagesBuilt.length} of ${p.wonder}.`);
}

// Leaders who are paid for what you build rather than for being built.
function buildEffects(G, p, card, pick) {
  let fee = 0;
  for (const c of p.built) {
    if (c === card) continue;
    if (c.onBuild && c.onBuild.of === card.c) fee += c.onBuild.coins;
    if (c.onChain && pick.pay.chain) fee += c.onChain.coins;
  }
  if (fee) {
    gainCoins(G, p, fee);
    addLog(G, `${p.name} takes ${fee} coins for building ${card.n}.`);
  }
}

// "Everyone else loses N." Cities puts them on black cards, Leaders on Octavia
// and Arsinoe; they are collected while the turn resolves and settled after it,
// so the money you earned this turn is money you can be made to lose.
function chargeFor(G, p, card, charges) {
  if (card.loss) charges.push({ by: p, name: card.n, flat: card.loss });
  if (card.lossAge) charges.push({ by: p, name: card.n, flat: G.age });
  if (card.perLoss) charges.push({ by: p, name: card.n, per: card.perLoss });
}

function applyCharges(G, charges) {
  for (const ch of charges) {
    for (const q of G.players) {
      if (q.seat === ch.by.seat) continue;      // never the player who played it
      const owed = ch.flat != null ? ch.flat : countOwned(q, ch.per.of) * ch.per.coins;
      if (owed === 0) continue;
      // A negative charge is the mirror of the usual one: Customs, Trade Center
      // and the Mint are paid for by putting money into everybody ELSE's hand.
      // Nobody goes into debt over a card that gives them coins, so that is the
      // whole of that case.
      if (owed < 0) {
        gainCoins(G, q, -owed);
        addLog(G, `${q.name} gains ${-owed} from ${ch.name}.`);
        continue;
      }
      const paid = Math.min(q.coins, owed);
      q.coins -= paid;
      const short = owed - paid;
      if (short > 0) q.debt += short;           // one debt token per coin unpaid
      addLog(G, `${q.name} loses ${owed} to ${ch.name}${short ? ` (${short} as debt)` : ''}.`);
    }
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

// Babylon's night side does not throw the last card of an Age away, it plays
// it. That is its own little turn, taken after everyone else has finished with
// theirs, and the card is paid for like any other — so it can be built, sold
// for three, or spent on a wonder stage.
function endAge(G) {
  const late = G.players.filter((p) => p.hand.length && hasAct(p, 'playLast')).map((p) => p.seat);
  // everybody else's last card goes in the bin unread, and goes in FIRST, so
  // it is in the pile if the card Babylon plays happens to reach into it
  for (const p of G.players) {
    if (late.includes(p.seat)) continue;
    for (const c of p.hand) G.discard.push(c);
    p.hand = [];
  }
  if (late.length) {
    G.lastCard = late;
    G.phase = 'lastcard';
    for (const seat of late) addLog(G, `${playerBySeat(G, seat).name} keeps the last card of the Age to play.`);
    bumpFx(G, { kind: 'lastcard', seats: late });
    return;
  }
  return resolveAge(G);
}

function doLastCard(G, p, move) {
  if (!G.lastCard.includes(p.seat)) return { ok: false, error: 'Not your card to play' };
  const card = p.hand.find((c) => c.id === move.cardId);
  if (!card) return { ok: false, error: 'That card is not in your hand' };
  const chosen = pickFrom(G, p, card, move.how);
  if (chosen.error) return { ok: false, error: chosen.error };
  const charges = [];
  // counted, because this card did not go in the bin with everybody else's —
  // which is the one thing that stops the seventh cards adding up
  G.lateCards += 1;
  const shown = [settlePick(G, p, card, { how: move.how, pay: chosen.pay }, charges)];
  applyCharges(G, charges);
  G.revealed = shown;
  bumpFx(G, { kind: 'reveal', plays: shown });
  G.lastCard = G.lastCard.filter((s) => s !== p.seat);
  if (G.lastCard.length) return { ok: true };
  // that card may have been the Forging Agency, or raised a stage that digs
  if (G.salvageAsk.length) openSalvage(G, 'age');
  else resolveAge(G);
  return { ok: true };
}

function resolveAge(G) {
  // anything still in a hand — a last card nobody was allowed to play, or one
  // whose owner left the table — goes in the bin now
  for (const p of G.players) {
    for (const c of p.hand) G.discard.push(c);
    p.hand = [];
  }

  const win = MILITARY_WIN[G.age];
  for (const p of G.players) p.bonusUsed = false;   // the conflict is its own event

  // Diplomacy removes you from the table for one conflict: you take nothing,
  // and the two cities either side of you are treated as neighbours and fight
  // each other instead. So the conflict is fought around the circle of players
  // who are actually PRESENT, which is the whole rule in one line. A token must
  // be spent whenever you hold one, even when you would have won.
  // Leaders: Tomyris does not take defeats, she posts them to whoever won.
  const lose = (a, b) => {
    if (b && a.built.some((c) => c.deflect)) { b.tokens.push(MILITARY_LOSS); return; }
    a.tokens.push(MILITARY_LOSS);
  };
  const fight = (a, b, tokens) => {
    if (a.shields > b.shields) for (let i = 0; i < tokens; i++) winToken(G, a, win);
    else if (a.shields < b.shields) for (let i = 0; i < tokens; i++) lose(a, b);
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
  beginAge(G);
}

// Every other engine in the collection stamps the counter onto the effect
// itself, and every client compares fx.seq to decide whether an effect is new.
// This one did not, so `fx.seq !== seen` was undefined !== undefined — false,
// forever — and the host's hold on the reveal never once fired.
function bumpFx(G, fx) { G.fxSeq += 1; G.fx = { seq: G.fxSeq, ...fx }; }

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
function bestScienceOf(counts, choices, opt = {}) {
  if (!choices.length) return scienceValue(counts, opt);
  const [first, ...rest] = choices;
  if (!first.length) return bestScienceOf(counts, rest, opt);
  let best = 0;
  for (const i of first) {
    counts[i] += 1;
    best = Math.max(best, bestScienceOf(counts, rest, opt));
    counts[i] -= 1;
  }
  return best;
}

// What a finished row of symbols is worth, and the three Leaders who get to
// argue with it after the fact: Aristotle pays more for a complete set,
// Enheduania adds one more of whatever you have most of, and Aganice turns any
// one symbol into any other. Enheduania goes first because she reads what you
// have; Aganice edits the result.
function scienceValue(counts, opt) {
  const bonus = SCIENCE_SET_BONUS + (opt.setBonus || 0);
  const flat = (c) => c[0] * c[0] + c[1] * c[1] + c[2] * c[2] + bonus * Math.min(c[0], c[1], c[2]);
  const cands = [counts];
  if (opt.most) {
    const top = Math.max(...counts);
    for (let i = 0; i < 3; i++) if (counts[i] === top) cands.push(counts.map((v, k) => (k === i ? v + 1 : v)));
  }
  if (opt.swap) {
    for (const c of cands.slice()) {
      for (let i = 0; i < 3; i++) {
        if (!c[i]) continue;
        for (let j = 0; j < 3; j++) {
          if (i !== j) cands.push(c.map((v, k) => v - (k === i ? 1 : 0) + (k === j ? 1 : 0)));
        }
      }
    }
  }
  return Math.max(...cands.map(flat));
}

function bestScience(counts, wild, opt) {
  return bestScienceOf(counts.slice(), new Array(Math.max(0, wild)).fill(ALL_SYMBOLS), opt);
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

  // Leaders. Most of them are ordinary cards that happen to be white, but a
  // dozen score off conditions no other card has: a complete set of colours, a
  // strict lead over BOTH neighbours, a clean sheet of defeats.
  const whites = p.built.filter((c) => c.c === 'white');
  const sciOpt = {
    setBonus: whites.reduce((a, c) => a + (c.sciSetVp || 0), 0),
    most: whites.some((c) => c.sciMost),
    swap: whites.some((c) => c.sciSwap),
  };
  const countOf = (q, of) => (of === 'coins' ? q.coins : q.built.filter((c) => c.c === of).length);
  const aheadOfBoth = (of) => [leftOf(G, seat), rightOf(G, seat)].every((sn) => {
    const q = playerBySeat(G, sn);
    return !q || q.seat === seat || countOf(p, of) > countOf(q, of);
  });
  let lead = perVp(whites);
  for (const c of whites) {
    lead += c.vp || 0;
    if (c.setVp) lead += c.setVp.vp * Math.min(...c.setVp.of.map((col) => countOf(p, col)));
    if (c.vpPerCoins) lead += Math.floor(p.coins / c.vpPerCoins);
    if (c.mostVp && aheadOfBoth(c.mostVp.of)) lead += c.mostVp.vp;
    if (c.cleanVp && !p.tokens.some((t) => t < 0)) lead += c.cleanVp;
    if (c.loneVp && whites.length === 1) lead += c.loneVp;
    if (c.pairVp) {
      const seen = {};
      for (const t of p.tokens) if (t > 0) seen[t] = (seen[t] || 0) + 1;
      for (const v of Object.keys(seen)) lead += Math.floor(seen[v] / 2) * Number(v);
    }
  }

  // Cities: black cards score like every other colour — flat points, points per
  // something, and the three that pay per victory token of one named Age. A
  // token carries its Age in its value, 1, 3 and 5, so there is nothing else to
  // look up. None of this was counted at all until now: black fell between the
  // colour buckets below and was quietly dropped.
  const blacks = p.built.filter((c) => c.c === 'black');
  const cityVp = blacks.reduce((a, c) => a + (c.vp || 0), 0) + perVp(blacks)
    + p.built.reduce((a, c) => a + (c.vpPerToken
        ? p.tokens.filter((t) => t === MILITARY_WIN[c.vpPerToken.age]).length * c.vpPerToken.vp : 0), 0);

  // The Decorators want the whole wonder finished and nothing else.
  const wonderDone = p.stagesBuilt.length >= p.stages.length;
  const guildBonus = p.built.reduce((a, c) => a + (c.vpIfWonder && wonderDone ? c.vpIfWonder : 0), 0);

  const parts = {
    military: p.tokens.reduce((a, b) => a + b, 0),
    coins: Math.floor(p.coins / 3),
    wonder: p.stagesBuilt.reduce((a, s) => a + (s.vp || 0), 0),
    civilian: p.built.filter((c) => c.c === 'blue').reduce((a, c) => a + (c.vp || 0), 0),
    commercial: perVp(p.built.filter((c) => c.c === 'yellow')),
    guild: perVp(p.built.filter((c) => c.c === 'purple')) + guildBonus,
    cities: cityVp,
    leaders: lead,
    science: bestScienceOf(counts.slice(), choices, sciOpt),
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
export function viewFor(G, seat, code, opts = {}) {
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
    options: me && ((G.phase === 'play' && !G.picks[seat]) || (G.phase === 'lastcard' && G.lastCard.includes(seat)))
      ? optionsFor(G, seat) : [],
    lastCard: G.lastCard.slice(),
    draftRound: G.draftRound || 0,
    draftHand: G.phase === 'draft' && me ? me.draft : [],
    myLeaders: me ? me.leaders : [],
    leaderOptions: G.phase === 'recruit' && me && !G.picks[seat] ? leaderOptionsFor(G, seat) : [],
    salvage: G.salvage ? {
      seat: G.salvage.queue[0].seat,
      why: G.salvage.queue[0].why,
      // You pick the pile up, look through it and put the rest back without
      // showing anyone — so only the seat that is choosing gets the list.
      cards: G.salvage.queue[0].seat === seat ? salvageOptions(G, seat) : null,
    } : null,
    players: G.players.map((p) => ({
      seat: p.seat, name: p.name, bot: p.bot, connected: p.connected, team: p.team,
      wonder: p.wonder, side: p.side, wonderRes: p.wonderRes,
      stages: p.stages, stagesBuilt: p.stagesBuilt.length,
      nextStageCost: nextStage(p) ? nextStage(p).cost : null,
      coins: p.coins, shields: p.shields, tokens: p.tokens, debt: p.debt, diplo: p.diplo,
      leaders: p.leaders.length,
      // Testing: the host may turn the bots' hands face up. Nobody else can —
      // only the host builds views, so this is the host's decision for the
      // whole table, and it is off unless they say otherwise.
      peek: opts.revealBots && (p.bot || p.botFor) && p.seat !== seat
        ? { hand: p.hand.map((c) => c.n), leaders: p.leaders.map((c) => c.n), draft: p.draft.map((c) => c.n) }
        : null,
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
// How keen a bot is to sell a leader rather than recruit it: the sell option is
// worth three coins times this. Swept head-to-head at 0, 0.5, 1 and 1.5, 500
// games each at 4 and 6 players with a same-against-same control — every
// setting came back inside noise of even, so it does not change how well a bot
// plays. It changes what you SEE: at 1 a bot sells anything it values under a
// point and a half, and a third of the deck never reaches a table. 0.5 sells
// only the leaders that are genuinely no use, which costs nothing and means
// most of the fifty-four turn up.
export const BOT = { scienceFaith: 0.3, leaderSell: 0.5 };

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
  if (card.token) v += MILITARY_WIN[card.token === 'age' ? G.age : card.token];
  if (card.nbDebt) v += card.nbDebt * 0.8;             // a point off each of two rivals
  if (card.vpPerToken) {
    const p3 = playerBySeat(G, seat);
    v += p3.tokens.filter((t) => t === MILITARY_WIN[card.vpPerToken.age]).length * card.vpPerToken.vp;
  }
  if (card.coinsPerDefeat) {
    const p4 = playerBySeat(G, seat);
    v += p4.tokens.filter((t) => t < 0).length * (card.coinsPerDefeat / 3 + 1);
  }
  if (card.produceOwn) v += (4 - G.age) * 1.2;
  if (card.smuggle) v += (4 - G.age) * 1.1;
  if (card.vpIfWonder) {
    const p2 = playerBySeat(G, seat);
    v += card.vpIfWonder * (p2.stagesBuilt.length + 1) / (p2.stages.length + 1);
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

// ---------------------------------------------------------------- leader bots

// How much of the game is still ahead, as a fraction: 1 while drafting, 0 on
// the last turn. A leader is bought for what it will be worth later, so nearly
// every judgement below leans on this.
function gameLeft(G) {
  const perAge = (G.handSize || CARDS_PER_AGE) - 1;
  if (G.phase === 'draft') return 1;
  const done = (G.age - 1) * perAge + (G.phase === 'play' ? G.turn - 1 : 0);
  return Math.max(0, 1 - done / (3 * perAge));
}

// What a city of this kind actually finishes with — measured over four hundred
// bot cities rather than guessed, because a leader that pays per card is bought
// on exactly this number and nothing else. In Age I your city is empty and
// Phidias is worth nothing yet; what he is worth is this table.
const TYPICAL = { brown: 3.0, grey: 1.6, blue: 3.3, yellow: 2.8, red: 2.2, green: 2.1, purple: 1.0, black: 1.4, stage: 2.1, victory: 1.5 };

// A city comes out of a game with no defeat tokens at all about a quarter of
// the time, which over three conflicts is a shade under two thirds each. That
// is the price of Cynisca's promise, and it gets better as the conflicts you
// have already survived come off the count.
const CLEAN_ODDS = 0.62;

// What a coin is worth in points. Three coins are a point at the end, but a
// coin in Age I buys a card you could not otherwise build, so it is worth more
// than a coin in Age III — which is also why leaders are expensive early.
const coinWorth = (left) => 0.33 + 0.17 * left;

// The honest half of a leader's worth: what it would add to the final score if
// the game ended now. Add it, score, take it away again — which is exact for
// everything that counts what is already on the table, and blind to everything
// still to come. The rest of leaderValue is that blind spot, priced by hand.
function scoreDelta(G, seat, card) {
  const p = playerBySeat(G, seat);
  const before = scoreFor(G, seat).total;
  p.built.push(card);
  const after = scoreFor(G, seat).total;
  p.built.pop();
  return after - before;
}

function leaderValue(G, seat, card) {
  const p = playerBySeat(G, seat);
  const left = gameLeft(G);
  const ages = Math.max(1, 4 - G.age);          // conflicts still to be fought
  const cw = coinWorth(left);
  const ahead = (of) => (TYPICAL[of] || 1) * left;   // more of these still to come

  // Three fields are held back from scoreDelta: a science symbol is worth more
  // than it looks because you keep collecting, and the two conditional leaders
  // are worth LESS than they look because today's clean sheet is not the end of
  // the game. Everything else scoreDelta prices exactly.
  const { sci, cleanVp, loneVp, ...rest } = card;
  let v = scoreDelta(G, seat, rest);
  if (sci) v += scienceGain(G, seat, sci);
  if (cleanVp && !p.tokens.some((t) => t < 0)) v += cleanVp * Math.pow(CLEAN_ODDS, 4 - G.age);
  if (loneVp && !p.built.some((c) => c.c === 'white')) v += loneVp * (0.25 + 0.5 * (1 - left));

  if (card.shield) v += card.shield * militaryWorth(G, seat) * ages;
  if (card.token) v += MILITARY_WIN[G.age];
  if (card.coins) v += card.coins * cw;
  if (card.per && card.per.vp) v += ahead(card.per.of) * card.per.vp;
  if (card.setVp) {
    const now = Math.min(...card.setVp.of.map((c) => p.built.filter((x) => x.c === c).length));
    const then = Math.min(...card.setVp.of.map((c) => p.built.filter((x) => x.c === c).length + ahead(c)));
    v += card.setVp.vp * (then - now);
  }
  if (card.vpPerCoins) v += 2 * left;
  if (card.sciSetVp) v += card.sciSetVp * 0.7 * left;
  if (card.sciMost || card.sciSwap) v += 1.2 * left;
  if (card.mostVp) v += card.mostVp.vp * 0.35 * left;
  if (card.pairVp) v += 1.5 * left;

  // The coin engines: how often the thing happens, times what it pays. The
  // counts are measured too — a bot city pays its neighbours about 14 coins a
  // game, spread over 6 of its 18 turns, and follows a chain 2.6 times.
  if (card.onBuild) v += ahead(card.onBuild.of) * card.onBuild.coins * cw;
  if (card.onChain) v += 2.6 * left * card.onChain.coins * cw;
  if (card.onStage) v += ahead('stage') * card.onStage.coins * cw + (card.onStage.others || 0) * (G.nPlayers - 1) * 0.15 * left;
  if (card.onWin) v += ahead('victory') * card.onWin.coins * cw;
  if (card.bonusCoin) v += 6 * left * cw;
  if (card.bankBuy) v += 8 * left * cw;
  if (card.rebate) v += (card.rebate.with === 'both' ? 6 : 3.5) * left * cw;
  if (card.lossAge) v += (G.nPlayers - 1) * G.age * cw * 0.25;

  // and the ones that stop you paying at all: a resource saved is two coins
  if (card.discount) v += ahead(card.discount.of) * 2 * cw;
  if (card.freeColour) v += 4.0 * left;
  if (card.freeColourAge) v += 3.5 * left;
  if (card.freeLeaders) v += 6 * left * cw;
  if (card.purge) v += p.tokens.filter((t) => t < 0).length + 0.3 * (G.nPlayers - 1);
  if (card.deflect) v += 1.0 * ages;
  return v;
}

function botDraft(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p || !p.draft.length) return null;
  let best = null;
  for (const card of p.draft) {
    const v = leaderValue(G, seat, card) - coinCost(card, 1) * 0.3;
    if (!best || v > best.v) best = { v, cardId: card.id };
  }
  return { kind: 'draft', cardId: best.cardId };
}

function botRecruit(G, seat) {
  const p = playerBySeat(G, seat);
  const opts = leaderOptionsFor(G, seat);
  if (!opts.length) return null;
  const cw = coinWorth(gameLeft(G));
  const scored = [];
  for (const o of opts) {
    const card = p.leaders.find((c) => c.id === o.id);
    const worth = leaderValue(G, seat, card);
    // Coins spent on a leader are coins not spent on the Age about to start,
    // which is dearer than the same coin mid-turn.
    if (o.play) scored.push({ how: 'play', cardId: o.id, v: worth - o.play.coins * cw * 1.15 });
    if (o.wonder) {
      const stage = nextStage(p);
      let v = (stage.vp || 0) + (stage.shield || 0) * militaryWorth(G, seat) * Math.max(1, 4 - G.age) + (stage.coins || 0) * cw;
      if (stage.sci) v += scienceGain(G, seat, stage.sci);
      if (stage.act || stage.salvage || stage.give || stage.trade) v += 3;
      // Which leader goes under the stage matters; that a leader does is the
      // same value whichever one it is, so the subtraction is a tiebreak only.
      scored.push({ how: 'wonder', cardId: o.id, v: v - o.wonder.coins * cw * 1.15 - worth * 0.02 });
    }
    // Selling is the floor: three coins, the same three coins whichever leader
    // it was. So the value does not depend on the card at all, and the tiny
    // subtraction is only there to make the worst one in hand the one that goes.
    scored.push({ how: 'discard', cardId: o.id, v: 3 * cw * BOT.leaderSell - worth * 0.02 });
  }
  scored.sort((a, b) => b.v - a.v);
  return { kind: 'pick', how: scored[0].how, cardId: scored[0].cardId };
}

// Nothing clever: the best card in the pile by the same yardstick the bot
// uses on its own hand, and never a pass while anything is left worth taking.
function botSalvage(G, seat) {
  const opts = salvageOptions(G, seat);
  if (!opts.length) return { kind: 'salvage', how: 'pass' };
  let best = null;
  for (const c of opts) {
    const v = valueOf(G, seat, c);
    if (!best || v > best.v) best = { v, cardId: c.id };
  }
  return { kind: 'salvage', cardId: best.cardId };
}

export function botChoose(G, seat) {
  if (G.phase === 'salvage') {
    return G.salvage && G.salvage.queue[0].seat === seat ? botSalvage(G, seat) : null;
  }
  if (G.phase === 'lastcard') return G.lastCard.includes(seat) ? botPlay(G, seat) : null;
  if (G.phase === 'draft') return G.picks[seat] ? null : botDraft(G, seat);
  if (G.phase === 'recruit') return G.picks[seat] ? null : botRecruit(G, seat);
  if (G.phase !== 'play') return null;
  return G.picks[seat] ? null : botPlay(G, seat);
}

function botPlay(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p) return null;
  const opts = optionsFor(G, seat);
  if (!opts.length) return null;
  // A once-an-Age free build is worth keeping for something dear, and the Age
  // is likelier to bring one the earlier it is — so spending it costs more at
  // the start of an Age than at the end of one.
  const perAge = (G.handSize || CARDS_PER_AGE) - 1;
  const hold = 1.6 * Math.max(0, perAge - G.turn) / perAge;

  const scored = [];
  for (const o of opts) {
    const card = p.hand.find((c) => c.id === o.id);
    if (o.play) {
      const spend = o.play.coins;
      scored.push({ how: 'play', cardId: o.id, v: valueOf(G, seat, card) - spend * 0.35 });
    }
    if (o.playFree) scored.push({ how: 'free', cardId: o.id, v: valueOf(G, seat, card) - hold });
    if (o.wonder) {
      const stage = nextStage(p);
      let v = (stage.vp || 0) + (stage.shield || 0) * militaryWorth(G, seat) + (stage.coins || 0) / 3;
      if (stage.sci) v += scienceGain(G, seat, stage.sci);
      if (stage.act || stage.salvage || stage.give || stage.trade) v += 3;
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
