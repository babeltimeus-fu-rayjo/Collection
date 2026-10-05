// game.js — the rules of Splendor and its expansions. No DOM, no network: the
// host holds the only copy of the state and every move goes through applyMove.
//
// Two to four Renaissance merchants buy Development cards with Gem tokens.
// Every card bought is a permanent bonus — one gem off every later card of its
// colour — and some carry Prestige points; a Noble visits whoever gathers the
// bonuses the tile asks for. On your turn, exactly one action: take three
// gems of different colours, take two of one colour (from a pile of four or
// more), reserve a card and take a Gold, or buy a card. Then you hand back
// tokens beyond ten, and a Noble may visit. Once someone reaches 15 Prestige
// points the round is played out, and the most prestigious merchant wins.
//
// Four modules from the two expansion boxes can be added, alone or together:
//   The Cities (The Silk Road)       replace the Nobles; the first to meet a
//                                    City's demands ends the round, and the
//                                    winner is among those who meet one
//   The Trading Posts (Silk Road)    five powers, each claimed once by meeting
//                                    its demand in cards
//   The Orient (The Sun Never Sets)  two more cards a row, with powers
//   The Strongholds (Sun Never Sets) three markers each, placed on the table's
//                                    cards to keep them, and to conquer one
//
// A purchase can set several things off, all before the table is refilled —
// a copy card's colour, a free card, a Trading Post's gem, a Stronghold — so
// they wait in `G.queue` and run in order, each asking its player when there
// is a choice; then the turn's end runs its checks one stage at a time.

import {
  GEMS, GOLD, TOKENS, GEM, CARDS, NOBLES, NOBLE_NAMES, EXTRA_NOBLES, NOBLE_POINTS, GEMS_FOR, GOLD_TOKENS, NOBLES_FOR, MARKET,
  WIN_POINTS, TOKEN_LIMIT, RESERVE_LIMIT, ORIENT, ORIENT_MARKET, CITIES, CITIES_IN_PLAY, TRADING_POSTS, STRONGHOLDS,
} from './cards.js';

export {
  GEMS, GOLD, TOKENS, GEM, CARDS, NOBLES, NOBLE_POINTS, GEMS_FOR, WIN_POINTS, TOKEN_LIMIT, RESERVE_LIMIT, ORIENT, CITIES,
  TRADING_POSTS, STRONGHOLDS, EXTRA_NOBLES,
} from './cards.js';

export const PROTO = 2;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;
export const LEVELS = [1, 2, 3];

// The modules, as the lobby offers them.
export const MODULES = [
  { key: 'cities', name: 'The Cities', box: 'The Silk Road', text: 'Three City tiles replace the Nobles. At the end of your turn, if you have the Prestige points and the cards a City asks for, the round is played out; then whoever meets a City wins — the most points among them if several do.' },
  { key: 'trading', name: 'The Trading Posts', box: 'The Silk Road', text: 'Five Trading Posts, each with a power. At the end of your turn, if you have the cards one asks for, you claim it — one a turn — and keep its power for the rest of the game.' },
  { key: 'orient', name: 'The Orient', box: 'The Sun Never Sets', text: 'Thirty Orient cards, two more face up on each row, with powers: cards that pay as Gold, that copy a colour you own, that bring two bonuses, that take a card for free, or that are bought by discarding two cards.' },
  { key: 'strongholds', name: 'The Strongholds', box: 'The Sun Never Sets', text: 'Three Strongholds each. Every purchase places or moves one of yours on a card on the table — which then only you may buy or reserve — or knocks off a lone rival one. With all three on one card, you may buy it at the end of your action.' },
  { key: 'nobles', name: 'Their two Nobles', box: 'both boxes', text: 'Adds the Noble tile from each box to the ten: Rani Chennabhairadevi and Hino Tomiko. Not with the Cities, which replace the Nobles.' },
];
export const defaultOpts = () => ({ cities: false, trading: false, orient: false, strongholds: false, nobles: false });

export const playerBySeat = (G, seat) => G.players.find((p) => p.seat === seat);
const zero = () => Object.fromEntries(TOKENS.map((t) => [t, 0]));
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const gemName = (g) => GEM[g].name;

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function note(G, text) {
  G.logSeq = (G.logSeq || 0) + 1;
  G.log.push({ id: G.logSeq, text });
  if (G.log.length > 150) G.log.shift();
}

// What just happened, for the table to show; one move can do several things
// (a purchase, then a Noble's visit), so they are kept in order.
function bump(G, fx) {
  G.fxSeq = (G.fxSeq || 0) + 1;
  G.fxs.push({ seq: G.fxSeq, ...fx });
  if (G.fxs.length > 16) G.fxs.shift();
}

// "2 Sapphires, an Emerald and a Gold"
const ONE = { diamond: 'a Diamond', sapphire: 'a Sapphire', emerald: 'an Emerald', ruby: 'a Ruby', onyx: 'an Onyx', gold: 'a Gold' };
const MANY = { diamond: 'Diamonds', sapphire: 'Sapphires', emerald: 'Emeralds', ruby: 'Rubies', onyx: 'Onyx', gold: 'Gold' };
const listWords = (parts) => (parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);
const tokenParts = (t) => TOKENS.filter((g) => t[g]).map((g) => (t[g] === 1 ? ONE[g] : `${t[g]} ${MANY[g]}`));
export const tokenWords = (t) => listWords(tokenParts(t));

// what a card is called in the log
function cardWords(G, id) {
  const c = G.cards[id];
  const colour = c.bonus ? gemName(c.bonus) : c.kind === 'gold' ? 'Gold' : 'copy';
  const what = c.orient ? `${colour}${c.kind === 'double' ? ' double-bonus' : ''} Orient card` : `${colour} card`;
  return `a level-${c.level} ${what}${c.points ? ` (${c.points} point${c.points === 1 ? '' : 's'})` : ''}`;
}

// ---------------------------------------------------------------- setup

export function canStart(n) {
  if (n < MIN_PLAYERS) return `Needs at least ${MIN_PLAYERS} players — add a bot to fill the table.`;
  if (n > MAX_PLAYERS) return `At most ${MAX_PLAYERS} players.`;
  return null;
}

export function newGame(roster, opts = {}) {
  const n = roster.length;
  const why = canStart(n);
  if (why) throw new Error(why);
  const o = { ...defaultOpts(), ...opts };
  if (o.cities) o.nobles = false;
  const cards = CARDS.map((c, id) => ({ id, ...c, kind: 'base' }));
  if (o.orient) for (const c of ORIENT) cards.push({ id: cards.length, ...c });
  const decks = { 1: [], 2: [], 3: [] };
  const odecks = { 1: [], 2: [], 3: [] };
  for (const c of cards) (c.orient ? odecks : decks)[c.level].push(c.id);
  for (const l of LEVELS) { shuffle(decks[l]); shuffle(odecks[l]); }
  // "Reveal 4 cards from each level deck" — and 2 from each Orient deck
  const market = { 1: [], 2: [], 3: [] };
  const omarket = { 1: [], 2: [], 3: [] };
  for (const l of LEVELS) {
    for (let i = 0; i < MARKET; i++) market[l].push(decks[l].length ? decks[l].pop() : null);
    if (o.orient) for (let i = 0; i < ORIENT_MARKET; i++) omarket[l].push(odecks[l].length ? odecks[l].pop() : null);
  }
  const nobles = NOBLES.map((req, id) => ({ id, req, points: NOBLE_POINTS, name: NOBLE_NAMES[id] }));
  if (o.nobles) for (const x of EXTRA_NOBLES) nobles.push({ id: nobles.length, req: x.req, points: NOBLE_POINTS, name: x.name, box: x.box });
  const bank = zero();
  for (const g of GEMS) bank[g] = GEMS_FOR[n];
  bank.gold = GOLD_TOKENS;
  // "The youngest player takes the First Player marker" — here, a random one
  const first = Math.floor(Math.random() * n);
  const G = {
    mid: Math.random().toString(36).slice(2, 10),
    phase: 'play',
    n,
    opts: o,
    cards,
    nobles,
    decks,
    odecks,
    market,
    omarket,
    // "Remove all Noble tiles during setup when using The Cities"
    nobleRow: o.cities ? [] : shuffle(nobles.map((x) => x.id)).slice(0, NOBLES_FOR(n)),
    // "randomly choose 3 of them ... each of these tiles with a random side face-up"
    cities: o.cities ? shuffle(CITIES.map((_, i) => i)).slice(0, CITIES_IN_PLAY).map((tile) => ({ tile, side: Math.floor(Math.random() * 2) })) : [],
    bank,
    holds: {},       // card id → the seats whose Strongholds are on it
    out: [],         // cards returned to the box: spent Gold cards, sacrificed ones
    vacant: [],      // places on the table waiting to be refilled
    look: null,      // the two cards a Trading Post lets its holder choose between
    players: roster.map((r) => ({
      seat: r.seat, name: r.name, bot: !!r.bot, connected: r.bot ? true : r.connected !== false,
      tokens: zero(), cards: [], reserved: [], nobles: [], turns: 0,
      assoc: {}, posts: [], holds: o.strongholds ? STRONGHOLDS : 0,
    })),
    first,
    turn: first,
    ask: null,
    stage: null,
    queue: [],
    conquered: false,
    ending: null,    // the seat whose 15 points (or City) triggered the end
    passes: 0,
    winners: null,
    why: '',
    log: [],
    fxs: [],
  };
  const parts = [`${n} players: ${GEMS_FOR[n]} tokens of each gem`];
  if (o.cities) parts.push(`the Cities of ${G.cities.map((c) => CITIES[c.tile].place).join(', ')}`);
  else parts.push(`${NOBLES_FOR(n)} Nobles`);
  note(G, `${parts.join(', ')}. ${G.players[first].name} plays first.`);
  bump(G, { kind: 'start' });
  beginTurn(G);
  return G;
}

// ---------------------------------------------------------------- reading the table

const isCopy = (c) => c.kind === 'copy' || c.kind === 'copytake';
export const hasPost = (p, power) => p.posts.some((i) => TRADING_POSTS[i].power === power);

// the colour a card of this player's counts as: its own, the one a copy card
// took, or none (a Gold card, a copy not yet matched)
export const colourOf = (G, p, id) => G.cards[id].bonus || p.assoc[id] || null;

// bonuses, for paying: a double-bonus card gives two
export function bonuses(G, p) {
  const b = Object.fromEntries(GEMS.map((g) => [g, 0]));
  for (const id of p.cards) {
    const g = colourOf(G, p, id);
    if (g) b[g] += G.cards[id].kind === 'double' ? 2 : 1;
  }
  return b;
}

// cards of each colour, for every condition — Nobles, Trading Posts, Cities:
// "This card only counts as one card of this color for all game conditions"
export function counts(G, p) {
  const n = Object.fromEntries(GEMS.map((g) => [g, 0]));
  for (const id of p.cards) {
    const g = colourOf(G, p, id);
    if (g) n[g]++;
  }
  return n;
}

export const score = (G, p) => p.cards.reduce((s, id) => s + G.cards[id].points, 0) + p.nobles.length * NOBLE_POINTS + (hasPost(p, 'points') ? p.posts.length : 0);

const marketIds = (G) => LEVELS.flatMap((l) => [...G.market[l], ...G.omarket[l]].filter((id) => id != null));
function slotOf(G, id) {
  for (const l of LEVELS) {
    let i = G.market[l].indexOf(id);
    if (i >= 0) return { row: 'market', l, i };
    i = G.omarket[l].indexOf(id);
    if (i >= 0) return { row: 'omarket', l, i };
  }
  return null;
}
const inMarket = (G, id) => slotOf(G, id) != null;
// "A card containing 1 or more Strongholds can only be purchased or reserved
// by the player who placed those Strongholds"
export const blockedFor = (G, p, id) => (G.holds[id] || []).some((s) => s !== p.seat);

// What a purchase costs: per colour, the gems after bonuses from the player's
// own tokens, Gold for the rest — with the Trading Post that makes each Gold
// worth two gems of one colour, as few Gold and then as few gems as will do.
// `k` Gold cards discarded bring 2 virtual Gold each, spent first: where the
// gems fall short, then in place of gems, the costliest colour first. "If you
// spend only 1 of these virtual tokens, the second is lost" — but each card
// must pay for something. Null if it cannot be paid.
export function payPlan(G, p, c, k = 0) {
  if (c.kind === 'sacrifice') return null;
  const b = bonuses(G, p);
  const per = hasPost(p, 'gold') ? 2 : 1;
  const goldCards = p.cards.filter((id) => G.cards[id].kind === 'gold');
  if (k > goldCards.length) return null;
  const rem = {};
  let total = 0;
  for (const g of GEMS) {
    rem[g] = Math.max(0, (c.cost[g] || 0) - b[g]);
    total += rem[g];
  }
  if (k > 0 && total <= 2 * (k - 1) * per) return null;
  const short = (g) => Math.max(0, rem[g] - p.tokens[g]);
  for (let v = 2 * k; v > 0; v--) {
    let pick = null;
    for (const g of GEMS) if (short(g) > 0 && (pick == null || short(g) > short(pick))) pick = g;
    if (pick == null) for (const g of GEMS) if (rem[g] > 0 && (pick == null || rem[g] > rem[pick])) pick = g;
    if (pick == null) break;
    rem[pick] = Math.max(0, rem[pick] - per);
  }
  const pay = zero();
  let need = 0;
  for (const g of GEMS) {
    const gold = Math.ceil(short(g) / per);
    pay[g] = Math.max(0, rem[g] - gold * per);
    need += gold;
  }
  if (need > p.tokens.gold) return null;
  pay.gold = need;
  return { pay, goldCards: goldCards.slice(0, k), need };
}

// the cards a sacrifice card may take: two of its colour, copies of that
// colour first ("they must be discarded before other cards of that color")
export function sacrificeFor(G, p, c) {
  const pool = p.cards.filter((id) => colourOf(G, p, id) === c.discard);
  const copies = pool.filter((id) => isCopy(G.cards[id]));
  return { colour: c.discard, pool, copies, must: Math.min(2, copies.length), ok: pool.length >= 2 };
}
function validSacrifice(G, p, c, ids) {
  const s = sacrificeFor(G, p, c);
  if (!s.ok || !Array.isArray(ids) || ids.length !== 2 || ids[0] === ids[1] || !ids.every((id) => s.pool.includes(id))) return false;
  return ids.filter((id) => s.copies.includes(id)).length === s.must;
}

// the first legal way to buy a card: its sacrifice, or its payment with as
// few Gold cards as will do — or null
export function buyPlan(G, p, id) {
  const c = G.cards[id];
  if (isCopy(c) && !p.cards.some((x) => colourOf(G, p, x))) return null;
  if (c.kind === 'sacrifice') {
    const s = sacrificeFor(G, p, c);
    if (!s.ok) return null;
    const rest = s.pool.filter((x) => !s.copies.includes(x)).sort((a, b) => G.cards[a].points - G.cards[b].points || (G.cards[a].kind === 'double') - (G.cards[b].kind === 'double'));
    return { discard: [...s.copies.slice(0, 2), ...rest].slice(0, 2) };
  }
  const goldCards = p.cards.filter((x) => G.cards[x].kind === 'gold').length;
  for (let k = 0; k <= goldCards; k++) {
    const plan = payPlan(G, p, c, k);
    if (plan) return { goldCards: k, pay: plan.pay };
  }
  return null;
}

// what a card costs in tokens, with no Gold cards — or null
export function payment(G, p, card) {
  const plan = payPlan(G, p, card, 0);
  return plan ? plan.pay : null;
}

// the cards this player could buy right now
export function affordable(G, p) {
  const table = marketIds(G).filter((id) => !blockedFor(G, p, id));
  return [...table, ...p.reserved.map((r) => r.id)].filter((id) => buyPlan(G, p, id));
}

const meetsReq = (n, req) => GEMS.every((g) => n[g] >= (req[g] || 0));
export const meets = (G, p, noble) => meetsReq(counts(G, p), noble.req);

export const citySide = (c) => ({ ...CITIES[c.tile].sides[c.side], place: CITIES[c.tile].place, ruler: CITIES[c.tile].ruler, tile: c.tile, side: c.side });
// "Have a number of Prestige points greater than or equal to the value shown
// on the tile" and "at least the quantity and type of cards indicated"; a
// demand for 4 4, 5 5 or 6 6 is that many of one colour the tile names nowhere else
export function meetsCity(G, p, c) {
  const side = CITIES[c.tile].sides[c.side];
  if (score(G, p) < side.points) return false;
  const n = counts(G, p);
  if (!meetsReq(n, side.req)) return false;
  if (side.any) {
    const named = GEMS.filter((g) => side.req[g]);
    if (!GEMS.some((g) => !named.includes(g) && n[g] >= side.any)) return false;
  }
  return true;
}

const postsFor = (G, p) => (G.opts.trading ? TRADING_POSTS.map((_, i) => i).filter((i) => !p.posts.includes(i) && meetsReq(counts(G, p), TRADING_POSTS[i].req)) : []);

const availableGems = (G) => GEMS.filter((g) => G.bank[g] > 0);

// whether this player has any action at all — the rulebook has no pass, but a
// table where nothing can be taken, reserved or bought needs one
export function hasAction(G, p) {
  if (availableGems(G).length) return true;
  if (p.reserved.length < RESERVE_LIMIT && (marketIds(G).some((id) => !blockedFor(G, p, id)) || LEVELS.some((l) => G.decks[l].length || G.odecks[l].length))) return true;
  return affordable(G, p).length > 0;
}

// ---------------------------------------------------------------- the turn

function beginTurn(G) {
  for (let guard = 0; guard < G.n + 1; guard++) {
    const p = G.players[G.turn];
    G.stage = 'action';
    G.conquered = false;
    if (hasAction(G, p)) {
      G.ask = { kind: 'turn', seat: p.seat };
      return;
    }
    note(G, `${p.name} can neither take, reserve nor buy, and passes.`);
    G.passes++;
    if (G.passes >= G.n) return finish(G, 'no one can do anything more', true);
    p.turns++;
    if (advanceSeat(G)) return;
  }
}

// to the next player — or the end, once the round that triggered it is complete
function advanceSeat(G) {
  const next = (G.turn + 1) % G.n;
  if (G.ending != null && next === G.first && finish(G, 'the round is complete')) return true;
  G.turn = next;
  return false;
}

function endTurn(G, p) {
  G.ask = null;
  G.stage = null;
  p.turns++;
  if (advanceSeat(G)) return;
  beginTurn(G);
}

// Run queued effects, then the end of the turn a stage at a time, until
// someone has a choice to make.
function advance(G) {
  for (let guard = 0; guard < 400; guard++) {
    if (G.phase === 'over' || G.ask) return;
    const p = G.players[G.turn];
    if (G.queue.length) {
      runTask(G, p, G.queue.shift());
      continue;
    }
    switch (G.stage) {
      case 'action':
        return;
      case 'conquest': {
        G.stage = 'limit';
        // "When all 3 of your Strongholds are on a single card, you may
        // purchase that card after performing your standard turn action"
        const id = G.opts.strongholds && !G.conquered ? conquestCard(G, p) : null;
        if (id != null && buyPlan(G, p, id)) {
          G.ask = { kind: 'conquest', seat: p.seat, card: id };
          return;
        }
        continue;
      }
      case 'limit': {
        G.stage = 'nobles';
        const over = sum(p.tokens) - TOKEN_LIMIT;
        if (over > 0) {
          G.ask = { kind: 'discard', seat: p.seat, n: over };
          return;
        }
        continue;
      }
      case 'nobles': {
        G.stage = 'posts';
        // "You may only acquire 1 Noble tile per turn. If you meet the swaying
        // requirements for several Noble tiles, you must choose 1."
        const options = G.nobleRow.filter((id) => meets(G, p, G.nobles[id]));
        if (options.length > 1) {
          G.ask = { kind: 'noble', seat: p.seat, options };
          return;
        }
        if (options.length === 1) takeNoble(G, p, options[0]);
        continue;
      }
      case 'posts': {
        G.stage = 'end';
        // "after checking whether you fulfill the requirements to acquire a
        // Noble ... You can only take 1 Trading Post tile per turn"
        const options = postsFor(G, p);
        if (options.length > 1) {
          G.ask = { kind: 'post', seat: p.seat, options };
          return;
        }
        if (options.length === 1) takePost(G, p, options[0]);
        continue;
      }
      case 'end':
        checkEnd(G, p);
        endTurn(G, p);
        return;
      default:
        return;
    }
  }
}

function takeNoble(G, p, id) {
  G.nobleRow = G.nobleRow.filter((x) => x !== id);
  p.nobles.push(id);
  note(G, `${G.nobles[id].name} visits ${p.name}: 3 Prestige points.`);
  bump(G, { kind: 'noble', seat: p.seat, noble: id });
}

function takePost(G, p, i) {
  p.posts.push(i);
  note(G, `${p.name} opens a Trading Post: ${TRADING_POSTS[i].text.replace(/\.$/, '')}.`);
  bump(G, { kind: 'post', seat: p.seat, post: i });
}

// "When a player reaches 15 or more Prestige points at the end of their turn,
// the end of the game is triggered" — or, with the Cities, "once a player
// fulfills the requirements of a City, finish the current round"
function checkEnd(G, p) {
  if (G.ending != null) return;
  if (G.opts.cities) {
    const c = G.cities.find((x) => meetsCity(G, p, x));
    if (!c) return;
    G.ending = p.seat;
    note(G, `${p.name} meets the demands of ${CITIES[c.tile].place} — this is the last round.`);
    bump(G, { kind: 'ending', seat: p.seat, city: c.tile });
    return;
  }
  if (score(G, p) < WIN_POINTS) return;
  G.ending = p.seat;
  note(G, `${p.name} reaches ${score(G, p)} Prestige points — this is the last round.`);
  bump(G, { kind: 'ending', seat: p.seat });
}

// The winner: the most Prestige points — with the Cities, among those who meet
// a City's demands — then the fewest Development cards; a tie past that is
// shared. With the Cities, if no one meets one any more, the game goes on.
function finish(G, why, force = false) {
  let pool = G.players;
  if (G.opts.cities && !force) {
    pool = G.players.filter((p) => G.cities.some((c) => meetsCity(G, p, c)));
    if (!pool.length) {
      note(G, 'No one meets a City’s demands any more — the game goes on.');
      G.ending = null;
      return false;
    }
  }
  G.phase = 'over';
  G.ask = null;
  G.queue = [];
  const scored = pool.map((p) => ({ seat: p.seat, points: score(G, p), cards: p.cards.length }));
  const best = Math.max(...scored.map((s) => s.points));
  let top = scored.filter((s) => s.points === best);
  const fewest = Math.min(...top.map((s) => s.cards));
  const tied = top.length > 1;
  top = top.filter((s) => s.cards === fewest);
  G.winners = top.map((s) => s.seat);
  const names = top.map((s) => playerBySeat(G, s.seat).name);
  G.why = `${why}${G.opts.cities && !force ? (pool.length > 1 ? `, and ${pool.length} merchants meet a City` : '') : ''}${tied ? (top.length === 1 ? ', and the tie goes to fewer cards bought' : ', and they bought as many cards each') : ''}`;
  note(G, `${names.length === 1 ? `${names[0]} wins` : `${names.join(' and ')} share the victory`} with ${best} Prestige points.`);
  bump(G, { kind: 'over', winners: G.winners });
  return true;
}

export const winners = (G) => G.winners || [];

// ---------------------------------------------------------------- moves

export function applyMove(G, seat, move) {
  const p = playerBySeat(G, seat);
  if (!p) return { ok: false, error: 'No such player.' };
  if (G.phase === 'over') return { ok: false, error: 'The game is over.' };
  if (!move || typeof move !== 'object') return { ok: false, error: 'No move.' };
  const a = G.ask;
  if (!a || a.seat !== seat) return { ok: false, error: 'It is not your move.' };
  const r = answer(G, p, a, move);
  if (r.ok) advance(G);
  return r;
}

function answer(G, p, a, move) {
  switch (a.kind) {
    case 'turn': {
      const r = act(G, p, move);
      if (!r.ok) return r;
      G.passes = 0;
      G.ask = null;
      G.stage = 'conquest';
      return r;
    }
    case 'conquest': {
      if (!move.buy) {
        G.ask = null;
        return { ok: true };
      }
      G.ask = null;
      const r = purchase(G, p, { ...move, card: a.card }, true);
      if (!r.ok) G.ask = a;
      else G.conquered = true;
      return r;
    }
    case 'discard': {
      const r = giveBack(G, p, move, a.n);
      if (r.ok) G.ask = null;
      return r;
    }
    case 'noble': {
      if (!a.options.includes(move.noble)) return { ok: false, error: 'Choose one of the Nobles who would visit you.' };
      G.ask = null;
      takeNoble(G, p, move.noble);
      return { ok: true };
    }
    case 'post': {
      if (!a.options.includes(move.post)) return { ok: false, error: 'Choose one of the Trading Posts you can open.' };
      G.ask = null;
      takePost(G, p, move.post);
      return { ok: true };
    }
    case 'copy': {
      if (!a.options.includes(move.target)) return { ok: false, error: 'Choose a card of yours with a bonus for it to match.' };
      p.assoc[a.card] = colourOf(G, p, move.target);
      G.ask = null;
      note(G, `${p.name}'s copy card takes the colour ${gemName(p.assoc[a.card])}.`);
      bump(G, { kind: 'copy', seat: p.seat, card: a.card, colour: p.assoc[a.card] });
      return { ok: true };
    }
    case 'take': {
      if (!a.options.includes(move.card)) return { ok: false, error: 'Choose one of the face-up cards of that level.' };
      G.ask = null;
      takeFree(G, p, move.card);
      return { ok: true };
    }
    case 'gem':
    case 'third': {
      if (!a.options.includes(move.gem)) return { ok: false, error: 'Choose a gem the supply still has.' };
      G.bank[move.gem]--;
      p.tokens[move.gem]++;
      G.ask = null;
      note(G, `${p.name}'s Trading Post brings ${ONE[move.gem]}.`);
      bump(G, { kind: 'take', seat: p.seat, tokens: { [move.gem]: 1 } });
      return { ok: true };
    }
    case 'draw2': {
      if (!a.options.includes(move.keep)) return { ok: false, error: 'Keep one of the two cards.' };
      const other = a.options.find((x) => x !== move.keep);
      // "return the other card to the bottom of its deck"
      if (other != null) (G.cards[other].orient ? G.odecks : G.decks)[G.cards[other].level].unshift(other);
      G.look = null;
      G.ask = null;
      p.reserved.push({ id: move.keep, blind: true });
      note(G, `${p.name} keeps one of the top two cards of the deck and puts the other at the bottom.`);
      return { ok: true };
    }
    case 'hold': {
      const r = placeHold(G, p, move);
      if (r.ok) G.ask = null;
      return r;
    }
    default:
      return { ok: false, error: 'Unknown question.' };
  }
}

// the four actions
function act(G, p, move) {
  switch (move.kind) {
    case 'take': {
      // "Take 3 Gem tokens of different colors. If there are not enough
      // available tokens to take 3 of different colors from the supply, you
      // may take 2 tokens or even 1. You can never take a Gold."
      const colors = move.gems;
      const avail = availableGems(G);
      if (!Array.isArray(colors) || new Set(colors).size !== colors.length || colors.some((g) => !avail.includes(g))) return { ok: false, error: 'Take gems of different colours from the piles that have some.' };
      if (avail.length >= 3 ? colors.length !== 3 : colors.length < 1) return { ok: false, error: avail.length >= 3 ? 'Take three gems of different colours.' : 'Take at least one gem.' };
      for (const g of colors) { G.bank[g]--; p.tokens[g]++; }
      const got = Object.fromEntries(colors.map((g) => [g, 1]));
      note(G, `${p.name} takes ${tokenWords(got)}.`);
      bump(G, { kind: 'take', seat: p.seat, tokens: got });
      return { ok: true };
    }
    case 'take2': {
      // "only available if there are at least 4 tokens available in that color"
      const g = move.gem;
      if (!GEMS.includes(g)) return { ok: false, error: 'Choose a gem colour.' };
      if (G.bank[g] < 4) return { ok: false, error: `Two of a kind only from a pile of four or more — the ${gemName(g)} pile has ${G.bank[g]}.` };
      G.bank[g] -= 2;
      p.tokens[g] += 2;
      note(G, `${p.name} takes ${tokenWords({ [g]: 2 })}.`);
      bump(G, { kind: 'take', seat: p.seat, tokens: { [g]: 2 } });
      // "After taking 2 pieces of the same color, take 1 piece of another color"
      if (hasPost(p, 'third')) G.queue.push({ t: 'third', not: g });
      return { ok: true };
    }
    case 'reserve': {
      if (p.reserved.length >= RESERVE_LIMIT) return { ok: false, error: `You already hold ${RESERVE_LIMIT} reserved cards.` };
      let id = null;
      let blind = false;
      let draw2 = null;
      if (move.card != null) {
        if (!inMarket(G, move.card)) return { ok: false, error: 'That card is not on the table.' };
        if (blockedFor(G, p, move.card)) return { ok: false, error: 'Another player’s Stronghold is on that card.' };
        id = move.card;
        leaveTable(G, p, id);
        G.queue.push({ t: 'refill' });
      } else if (LEVELS.includes(move.level)) {
        const deck = (move.orient ? G.odecks : G.decks)[move.level];
        if (move.orient && !G.opts.orient) return { ok: false, error: 'There are no Orient decks in this game.' };
        if (!deck.length) return { ok: false, error: 'That deck is empty.' };
        blind = true;
        // "When you reserve a card from 1 of the 3 decks, draw the first 2 cards"
        if (hasPost(p, 'draw2') && deck.length >= 2) draw2 = { level: move.level, orient: !!move.orient };
        else id = deck.pop();
      } else return { ok: false, error: 'Reserve a card on the table, or the top of a deck.' };
      if (id != null) p.reserved.push({ id, blind });
      // "Then, take 1 Gold token. If no Gold tokens remain, you may still reserve a card."
      const gold = G.bank.gold > 0;
      if (gold) { G.bank.gold--; p.tokens.gold++; }
      const what = blind ? `the top card of the level-${move.level}${move.orient ? ' Orient' : ''} deck` : cardWords(G, id);
      note(G, `${p.name} reserves ${what}${gold ? ' and takes a Gold' : ' — no Gold is left'}.`);
      bump(G, { kind: 'reserve', seat: p.seat, card: blind ? null : faceOf(G, p, id), level: blind ? move.level : G.cards[id].level, orient: blind ? !!move.orient : !!G.cards[id].orient, gold });
      if (draw2) G.queue.unshift({ t: 'draw2', ...draw2 });
      return { ok: true };
    }
    case 'buy':
      return purchase(G, p, move, false);
    default:
      return { ok: false, error: 'Take gems, reserve a card or buy one.' };
  }
}

// A card leaves the table: its place waits to be refilled, and any Strongholds
// on it go back to their owners ("you take back your Stronghold(s)").
function leaveTable(G, p, id) {
  const s = slotOf(G, id);
  if (!s) return;
  G[s.row][s.l][s.i] = null;
  G.vacant.push(s);
  for (const seat of G.holds[id] || []) playerBySeat(G, seat).holds++;
  delete G.holds[id];
}

function refill(G) {
  for (const s of G.vacant) {
    if (G[s.row][s.l][s.i] != null) continue;
    const deck = (s.row === 'omarket' ? G.odecks : G.decks)[s.l];
    G[s.row][s.l][s.i] = deck.length ? deck.pop() : null;
  }
  G.vacant = [];
}

// Buying: the card on the table (not under a rival's Stronghold) or in hand,
// paid in tokens and Gold — Gold cards first, as the move says — or, for a
// sacrifice card, in two cards of its colour. Its effects follow, in order:
// a copy's colour, a free card, a Trading Post's gem, a Stronghold; then the
// table is refilled.
function purchase(G, p, move, conquest) {
  const id = move.card;
  const fromHand = p.reserved.findIndex((r) => r.id === id);
  if (fromHand < 0 && !inMarket(G, id)) return { ok: false, error: 'Buy a card on the table or one you have reserved.' };
  if (fromHand < 0 && blockedFor(G, p, id)) return { ok: false, error: 'Another player’s Stronghold is on that card.' };
  const c = G.cards[id];
  // "You cannot purchase this card if you don't already have a card with a bonus"
  if (isCopy(c) && !p.cards.some((x) => colourOf(G, p, x))) return { ok: false, error: 'A copy card needs a card of yours with a bonus to match.' };
  let paid = '';
  if (c.kind === 'sacrifice') {
    if (!validSacrifice(G, p, c, move.discard)) {
      const s = sacrificeFor(G, p, c);
      return { ok: false, error: !s.ok ? `It takes two ${gemName(c.discard)} cards to discard.` : s.must ? `Discard your ${gemName(c.discard)} copy card${s.must === 2 ? 's' : ''} first.` : `Choose two ${gemName(c.discard)} cards to discard.` };
    }
    for (const x of move.discard) discardCard(G, p, x);
    paid = ` by discarding two ${gemName(c.discard)} cards`;
  } else {
    const k = Number.isInteger(move.goldCards) ? move.goldCards : 0;
    const plan = payPlan(G, p, c, k);
    if (!plan) return { ok: false, error: k ? 'Those Gold cards do not settle it.' : 'You cannot afford that card yet.' };
    for (const t of TOKENS) { p.tokens[t] -= plan.pay[t]; G.bank[t] += plan.pay[t]; }
    for (const x of plan.goldCards) discardCard(G, p, x);
    const parts = tokenParts(plan.pay);
    if (plan.goldCards.length) parts.push(plan.goldCards.length === 1 ? 'a Gold card' : `${plan.goldCards.length} Gold cards`);
    paid = parts.length ? ` for ${listWords(parts)}` : ' with bonuses alone';
  }
  if (fromHand >= 0) p.reserved.splice(fromHand, 1);
  else leaveTable(G, p, id);
  p.cards.push(id);
  note(G, `${p.name} ${conquest ? 'conquers' : 'buys'} ${cardWords(G, id)}${fromHand >= 0 ? ' from their reserve' : ''}${paid}.`);
  bump(G, { kind: 'buy', seat: p.seat, card: faceOf(G, p, id), conquest });
  if (isCopy(c)) G.queue.push({ t: 'copy', card: id });
  if (c.take) G.queue.push({ t: 'take', level: c.take });
  if (hasPost(p, 'gem')) G.queue.push({ t: 'gem' });
  if (G.opts.strongholds) G.queue.push({ t: 'hold' });
  G.queue.push({ t: 'refill' });
  return { ok: true };
}

// a card returned to the box: a spent Gold card, a sacrificed one
function discardCard(G, p, id) {
  p.cards = p.cards.filter((x) => x !== id);
  delete p.assoc[id];
  G.out.push(id);
}

// "take 1 faceup base game or Orient card from the level row ... Do not pay
// its cost, but apply its effects ... This second card does not count as a
// card purchase."
function takeFree(G, p, id) {
  const c = G.cards[id];
  leaveTable(G, p, id);
  p.cards.push(id);
  note(G, `${p.name} takes ${cardWords(G, id)} for free.`);
  bump(G, { kind: 'buy', seat: p.seat, card: faceOf(G, p, id), free: true });
  const next = [];
  if (isCopy(c)) next.push({ t: 'copy', card: id });
  if (c.take) next.push({ t: 'take', level: c.take });
  G.queue.unshift(...next);
}

function freeOptions(G, p, level) {
  return [...G.market[level], ...G.omarket[level]].filter((id) => id != null && !blockedFor(G, p, id));
}

function copyOptions(G, p, card) {
  return p.cards.filter((x) => x !== card && colourOf(G, p, x));
}

function runTask(G, p, task) {
  switch (task.t) {
    case 'copy': {
      const options = copyOptions(G, p, task.card);
      if (!options.length) return;
      // every card of one colour is the same choice
      const colours = new Set(options.map((x) => colourOf(G, p, x)));
      if (colours.size === 1) {
        p.assoc[task.card] = [...colours][0];
        note(G, `${p.name}'s copy card takes the colour ${gemName(p.assoc[task.card])}.`);
        return;
      }
      G.ask = { kind: 'copy', seat: p.seat, card: task.card, options };
      return;
    }
    case 'take': {
      const options = freeOptions(G, p, task.level);
      if (!options.length) {
        note(G, `There is no level-${task.level} card for ${p.name} to take.`);
        return;
      }
      G.ask = { kind: 'take', seat: p.seat, level: task.level, options };
      return;
    }
    case 'gem': {
      const options = availableGems(G);
      if (options.length) G.ask = { kind: 'gem', seat: p.seat, options };
      return;
    }
    case 'third': {
      const options = availableGems(G).filter((g) => g !== task.not);
      if (options.length) G.ask = { kind: 'third', seat: p.seat, options, not: task.not };
      return;
    }
    case 'draw2': {
      const deck = (task.orient ? G.odecks : G.decks)[task.level];
      const options = [deck.pop(), deck.pop()].filter((x) => x != null);
      G.look = options;
      G.ask = { kind: 'draw2', seat: p.seat, options, level: task.level, orient: task.orient };
      return;
    }
    case 'hold': {
      if (holdOptions(G, p).any) G.ask = { kind: 'hold', seat: p.seat };
      return;
    }
    case 'refill':
      refill(G);
      return;
    default:
  }
}

// ---------------------------------------------------------------- the Strongholds

// "Place or move one of YOUR Strongholds onto one of the faceup cards on the
// table that is not already occupied by an opponent's Stronghold ... OR
// choose a card containing exactly 1 of an OPPONENT'S Strongholds; remove the
// Stronghold and return it to that player."
export function holdOptions(G, p) {
  const table = marketIds(G);
  const mine = table.filter((id) => (G.holds[id] || []).includes(p.seat));
  const to = table.filter((id) => !blockedFor(G, p, id));
  const remove = table.filter((id) => (G.holds[id] || []).length === 1 && G.holds[id][0] !== p.seat);
  const canPlace = to.length > 0 && (p.holds > 0 || mine.some((from) => to.some((t) => t !== from)));
  return { to, mine, remove, canPlace, any: canPlace || remove.length > 0 };
}

function placeHold(G, p, move) {
  const o = holdOptions(G, p);
  if (move.remove != null) {
    if (!o.remove.includes(move.remove)) return { ok: false, error: 'Knock off a lone rival Stronghold.' };
    const seat = G.holds[move.remove][0];
    delete G.holds[move.remove];
    const q = playerBySeat(G, seat);
    q.holds++;
    note(G, `${p.name} knocks ${q.name}'s Stronghold off ${cardWords(G, move.remove)}.`);
    bump(G, { kind: 'unhold', seat: p.seat, card: move.remove, owner: seat });
    return { ok: true };
  }
  if (!o.to.includes(move.to)) return { ok: false, error: 'Place it on a card on the table no rival holds.' };
  if (move.from != null) {
    if (!o.mine.includes(move.from) || move.from === move.to) return { ok: false, error: 'Move one of your Strongholds from another card.' };
    const list = G.holds[move.from];
    list.splice(list.indexOf(p.seat), 1);
    if (!list.length) delete G.holds[move.from];
  } else {
    if (p.holds <= 0) return { ok: false, error: 'All your Strongholds are on the table — move one.' };
    p.holds--;
  }
  (G.holds[move.to] = G.holds[move.to] || []).push(p.seat);
  note(G, `${p.name} ${move.from != null ? 'moves a Stronghold to' : 'places a Stronghold on'} ${cardWords(G, move.to)}.`);
  bump(G, { kind: 'hold', seat: p.seat, card: move.to });
  return { ok: true };
}

const conquestCard = (G, p) => marketIds(G).find((id) => (G.holds[id] || []).length === STRONGHOLDS && G.holds[id].every((s) => s === p.seat)) ?? null;

// "if you have more than 10 tokens, you must return excess tokens of your
// choice to the supply until you have 10"
function giveBack(G, p, move, n) {
  const t = move.tokens;
  if (!t || typeof t !== 'object') return { ok: false, error: `Return ${n} token${n === 1 ? '' : 's'}.` };
  let total = 0;
  for (const k of Object.keys(t)) {
    if (!TOKENS.includes(k) || !Number.isInteger(t[k]) || t[k] < 0 || t[k] > p.tokens[k]) return { ok: false, error: 'Return tokens you hold.' };
    total += t[k];
  }
  if (total !== n) return { ok: false, error: `Return exactly ${n} token${n === 1 ? '' : 's'}.` };
  for (const k of Object.keys(t)) { p.tokens[k] -= t[k]; G.bank[k] += t[k]; }
  note(G, `${p.name} returns ${tokenWords(t)} to keep ten.`);
  bump(G, { kind: 'return', seat: p.seat, tokens: t });
  return { ok: true };
}

export const waitingOn = (G) => (G.ask ? [G.ask.seat] : []);

// ---------------------------------------------------------------- disconnection

export function markDisconnected(G, seat) { const p = playerBySeat(G, seat); if (!p || p.bot) return false; p.connected = false; return true; }
export function markReconnected(G, seat) { const p = playerBySeat(G, seat); if (p) { p.connected = true; p.botFor = false; } }
export function markBotTakeover(G, seat) { const p = playerBySeat(G, seat); if (!p || p.bot || p.connected) return false; p.botFor = true; note(G, `A bot takes over for ${p.name}.`); return true; }
export function markSeatClaimed(G, seat, name) { const p = playerBySeat(G, seat); if (!p) return; p.name = name; p.connected = true; p.botFor = false; p.resigned = false; }
export function markSeatResigned(G, seat) { const p = playerBySeat(G, seat); if (!p) return; p.connected = false; p.resigned = true; }

// ---------------------------------------------------------------- views

// a card as the table shows it; a copy card in someone's play area shows the
// colour it took
function faceOf(G, p, id) {
  const c = G.cards[id];
  const f = { id, level: c.level, bonus: c.bonus || (p && p.assoc[id]) || null, points: c.points, cost: { ...c.cost }, kind: c.kind };
  if (c.orient) f.orient = true;
  if (c.take) f.take = c.take;
  if (c.discard) f.discard = c.discard;
  return f;
}
const nobleOf = (G, id) => ({ id, req: { ...G.nobles[id].req }, points: G.nobles[id].points, name: G.nobles[id].name, box: G.nobles[id].box || null });

// Everything in Splendor is on the table but the decks and the cards reserved
// blind from them: those only their owner sees, until the game ends.
export function viewFor(G, seat, code, opts = {}) {
  const me = playerBySeat(G, seat);
  const over = G.phase === 'over';
  const mine = me && G.ask && G.ask.seat === seat;
  const buys = {};
  if (mine && (G.ask.kind === 'turn' || G.ask.kind === 'conquest')) {
    const ids = G.ask.kind === 'conquest' ? [G.ask.card] : affordable(G, me);
    for (const id of ids) {
      const c = G.cards[id];
      if (c.kind === 'sacrifice') {
        const s = sacrificeFor(G, me, c);
        buys[id] = { sacrifice: { colour: s.colour, pool: s.pool, copies: s.copies, must: s.must }, plan: buyPlan(G, me, id) };
      } else {
        const plans = [];
        const goldCards = me.cards.filter((x) => G.cards[x].kind === 'gold').length;
        for (let k = 0; k <= goldCards; k++) {
          const plan = payPlan(G, me, c, k);
          if (plan) plans.push({ goldCards: k, pay: plan.pay });
        }
        buys[id] = { plans };
      }
    }
  }
  return {
    code, mid: G.mid, you: seat, phase: G.phase, n: G.n, opts: { ...G.opts },
    turn: G.players[G.turn].seat,
    first: G.players[G.first].seat,
    ending: G.ending,
    bank: { ...G.bank },
    decks: Object.fromEntries(LEVELS.map((l) => [l, G.decks[l].length])),
    odecks: Object.fromEntries(LEVELS.map((l) => [l, G.odecks[l].length])),
    market: Object.fromEntries(LEVELS.map((l) => [l, G.market[l].map((id) => (id == null ? null : faceOf(G, null, id)))])),
    omarket: Object.fromEntries(LEVELS.map((l) => [l, G.omarket[l].map((id) => (id == null ? null : faceOf(G, null, id)))])),
    holds: Object.fromEntries(Object.entries(G.holds).map(([k, v]) => [k, v.slice()])),
    nobles: G.nobleRow.map((id) => nobleOf(G, id)),
    cities: G.cities.map((c) => ({ ...citySide(c), met: G.players.filter((p) => meetsCity(G, p, c)).map((p) => p.seat) })),
    posts: G.opts.trading ? TRADING_POSTS.map((tp, i) => ({ i, req: { ...tp.req }, power: tp.power, text: tp.text, owners: G.players.filter((p) => p.posts.includes(i)).map((p) => p.seat) })) : [],
    players: G.players.map((p) => {
      const peek = opts.revealBots && p.bot;
      return {
        seat: p.seat, name: p.name, bot: p.bot, connected: p.connected, botFor: !!p.botFor, resigned: !!p.resigned,
        tokens: { ...p.tokens },
        bonuses: bonuses(G, p),
        counts: counts(G, p),
        cards: p.cards.map((id) => faceOf(G, p, id)),
        points: score(G, p),
        nobles: p.nobles.map((id) => nobleOf(G, id)),
        posts: p.posts.slice(),
        holds: p.holds,
        reserved: p.reserved.map((r) => (p.seat === seat || !r.blind || over || peek ? { ...faceOf(G, null, r.id), blind: r.blind } : { level: G.cards[r.id].level, orient: !!G.cards[r.id].orient, blind: true, hidden: true })),
        turns: p.turns,
      };
    }),
    ask: G.ask ? { ...G.ask } : null,
    look: mine && G.ask.kind === 'draw2' ? G.ask.options.map((id) => faceOf(G, null, id)) : null,
    copyFaces: mine && G.ask.kind === 'copy' ? Object.fromEntries(G.ask.options.map((id) => [id, faceOf(G, me, id)])) : null,
    affordable: Object.keys(buys).map(Number),
    buys,
    holdOptions: mine && G.ask.kind === 'hold' ? (({ to, mine: m, remove, canPlace }) => ({ to, mine: m, remove, canPlace }))(holdOptions(G, me)) : null,
    winners: over ? winners(G) : null,
    why: G.why,
    log: G.log.slice(-50),
    fxs: G.fxs,
  };
}

// ---------------------------------------------------------------- bots
//
// A bot looks one move ahead. Every legal action — each set of gems it could
// take, each card it could reserve or buy — is tried on a copy of its own
// holdings, including the tokens it would then have to hand back, and the
// best it could do on its next turn is weighed in too. The result is scored:
// Prestige points above all; then bonuses, worth more early on and in the
// colours the table's cards and Nobles want; how close it stands to the best
// cards it could buy next — counting gems the supply has run out of as slow
// to come by — to each Noble, Trading Post and City; and a little for tokens
// in hand. A turn that leaves everything as it was scores worst of all, so two
// bots never trade the same gem back and forth for ever.

export const BOT = {
  point: 3,          // a Prestige point
  bonus: 1.3,        // a permanent bonus, at the start of the game
  token: 0.22,       // a gem in hand
  gold: 0.55,        // a Gold in hand
  decay: 0.55,       // what each turn of waiting takes off a card's worth
  reserve: 1.5,      // a reserved card's slot, held
  noble: 0.8,        // how strongly a Noble draws its colours
  idle: 4,           // a turn that changes nothing
  second: 0.5,       // the second-best card within reach, against the best
  third: 0.25,       // and the third
  deny: 0.7,         // a point kept from a rival by reserving the card
  buy: 1,            // a purchase, for its own sake
  ahead: 0.8,        // how much the best next turn counts, against this one
  post: 2.2,         // a Trading Post's power
  city: 6,           // how strongly a City draws, near the end
};

// a bot's holdings, abstracted: what it pays with, what it counts toward
// every condition, its points, its reserve, the supply as it would stand
function holdings(G, p) {
  return {
    tokens: { ...p.tokens }, bonus: bonuses(G, p), count: counts(G, p), points: score(G, p),
    reserved: p.reserved.map((r) => r.id), bank: { ...G.bank }, vgold: 2 * p.cards.filter((id) => G.cards[id].kind === 'gold').length,
    posts: p.posts.slice(), nobles: p.nobles.length, cards: p.cards.length, owns: p.cards.some((id) => colourOf(G, p, id)),
  };
}
const copyState = (s) => ({ ...s, tokens: { ...s.tokens }, bonus: { ...s.bonus }, count: { ...s.count }, reserved: s.reserved.slice(), bank: { ...s.bank }, posts: s.posts.slice() });
const sHasPost = (s, power) => s.posts.some((i) => TRADING_POSTS[i].power === power);

// how many turns of taking gems until a card can be bought: three gems a
// turn at best, two of one colour, Gold filling the scarcest gaps first, and
// every gem the supply cannot give counting as a turn of its own
function turnsTo(c, s) {
  if (c.kind === 'sacrifice') return (s.count[c.discard] || 0) >= 2 ? 0 : 6;
  const per = sHasPost(s, 'gold') ? 2 : 1;
  const miss = {};
  for (const g of GEMS) miss[g] = Math.max(0, (c.cost[g] || 0) - s.bonus[g] - s.tokens[g]);
  let gold = (s.tokens.gold + s.vgold) * per;
  const scarce = GEMS.filter((g) => miss[g]).sort((a, b) => (s.bank[a] - miss[a]) - (s.bank[b] - miss[b]));
  for (const g of scarce) { const k = Math.min(gold, miss[g]); miss[g] -= k; gold -= k; }
  let short = 0, worst = 0, stuck = 0;
  for (const g of GEMS) { short += miss[g]; worst = Math.max(worst, miss[g]); stuck += Math.max(0, miss[g] - s.bank[g]); }
  if (!short) return 0;
  return Math.max(Math.ceil(short / 3), Math.ceil(worst / 2)) + stuck;
}

function demandOf(G) {
  const d = Object.fromEntries(GEMS.map((g) => [g, 0]));
  let total = 0;
  for (const id of marketIds(G)) for (const g of GEMS) { d[g] += G.cards[id].cost[g] || 0; total += G.cards[id].cost[g] || 0; }
  for (const g of GEMS) d[g] = total ? (d[g] * GEMS.length) / total / 2 : 0.5;
  return d;
}

// how far a set of card demands stands from a holding
const shortOf = (count, req) => GEMS.reduce((a, g) => a + Math.max(0, (req[g] || 0) - count[g]), 0);
function cityShort(s, side) {
  let short = shortOf(s.count, side.req);
  if (side.any) {
    const named = GEMS.filter((g) => side.req[g]);
    short += Math.min(...GEMS.filter((g) => !named.includes(g)).map((g) => Math.max(0, side.any - s.count[g])));
  }
  return short;
}

// what owning one more bonus of this colour is worth now
function bonusWorth(G, s, g, ctx) {
  const W = ctx.w;
  let w = W.bonus * (1 - ctx.stage * 0.7) * (0.6 + ctx.demand[g]);
  for (const id of G.nobleRow) {
    const req = G.nobles[id].req;
    if ((req[g] || 0) <= s.count[g]) continue;
    const left = shortOf(s.count, req);
    w += (W.noble * NOBLE_POINTS * W.point) / (left * left + 2);
  }
  if (G.opts.trading) for (let i = 0; i < TRADING_POSTS.length; i++) {
    const tp = TRADING_POSTS[i];
    if (s.posts.includes(i) || (tp.req[g] || 0) <= s.count[g]) continue;
    const left = shortOf(s.count, tp.req);
    w += (W.post * W.point) / (left * left + 2);
  }
  return w;
}

// a card's worth to a holding, its powers included
function cardWorth(G, s, c, ctx) {
  const W = ctx.w;
  let w = c.points * W.point;
  if (c.kind === 'gold') return w + 2 * W.gold;
  if (isCopy(c)) {
    if (!s.owns) return -5;
    w += Math.max(...GEMS.filter((g) => s.count[g] > 0).map((g) => bonusWorth(G, s, g, ctx)));
  } else if (c.bonus) {
    w += bonusWorth(G, s, c.bonus, ctx) * (c.kind === 'double' ? 1.8 : 1);
  }
  if (c.take) w += (c.take === 2 ? 2.2 : 1.2) * W.point;
  if (c.kind === 'sacrifice') w -= 2 * (W.bonus * (1 - ctx.stage * 0.7));
  return w;
}

function evaluate(G, s, pool, ctx) {
  const W = ctx.w;
  let v = s.points * W.point;
  for (const g of GEMS) v += s.bonus[g] * W.bonus * (1 - ctx.stage * 0.5);
  for (const id of G.nobleRow) v += (W.noble * NOBLE_POINTS * W.point) / (shortOf(s.count, G.nobles[id].req) + 1.5);
  if (G.opts.trading) {
    for (let i = 0; i < TRADING_POSTS.length; i++) if (!s.posts.includes(i)) v += (W.post * W.point) / (shortOf(s.count, TRADING_POSTS[i].req) + 2.5);
    v += s.posts.length * W.post * W.point * 0.5;
  }
  if (G.opts.cities) {
    // a City draws harder the nearer the end: its cards, and the points it asks
    let best = 0;
    for (const c of G.cities) {
      const side = CITIES[c.tile].sides[c.side];
      const gap = cityShort(s, side) + Math.max(0, side.points - s.points) / 3;
      best = Math.max(best, (W.city * W.point) / (gap + 1));
    }
    v += best * (0.4 + ctx.stage);
  }
  const reach = [];
  for (const id of pool) {
    const c = G.cards[id];
    reach.push(cardWorth(G, s, c, ctx) * W.decay ** (turnsTo(c, s) + 1));
  }
  reach.sort((a, b) => b - a);
  v += (reach[0] || 0) + W.second * (reach[1] || 0) + W.third * (reach[2] || 0);
  v += (sum(s.tokens) - s.tokens.gold) * W.token + s.tokens.gold * W.gold + s.vgold * W.gold * 0.8;
  v -= s.reserved.length * W.reserve;
  return v;
}

// every action this player could take, as moves
export function legalActions(G, p) {
  const out = [];
  const avail = availableGems(G);
  if (avail.length >= 3) {
    for (let i = 0; i < avail.length; i++) for (let j = i + 1; j < avail.length; j++) for (let k = j + 1; k < avail.length; k++) out.push({ kind: 'take', gems: [avail[i], avail[j], avail[k]] });
  } else if (avail.length) {
    out.push({ kind: 'take', gems: avail.slice() });
    if (avail.length === 2) for (const g of avail) out.push({ kind: 'take', gems: [g] });
  }
  for (const g of GEMS) if (G.bank[g] >= 4) out.push({ kind: 'take2', gem: g });
  if (p.reserved.length < RESERVE_LIMIT) {
    for (const id of marketIds(G)) if (!blockedFor(G, p, id)) out.push({ kind: 'reserve', card: id });
    for (const l of LEVELS) {
      if (G.decks[l].length) out.push({ kind: 'reserve', level: l });
      if (G.odecks[l].length) out.push({ kind: 'reserve', level: l, orient: true });
    }
  }
  for (const id of affordable(G, p)) out.push({ kind: 'buy', card: id, ...buyMoveFor(G, p, id) });
  return out;
}

// how the bot pays: Gold cards only when tokens and Gold fall short
function buyMoveFor(G, p, id) {
  const plan = buyPlan(G, p, id);
  if (!plan) return {};
  return plan.discard ? { discard: plan.discard } : { goldCards: plan.goldCards };
}

// the tokens to hand back from s: one at a time, whichever costs least
function chooseReturn(G, s, pool, ctx, n) {
  const back = {};
  for (let k = 0; k < n; k++) {
    let best = null;
    let bestV = -Infinity;
    for (const t of TOKENS) {
      if (s.tokens[t] <= 0) continue;
      s.tokens[t]--;
      const v = evaluate(G, s, pool, ctx) - (t === GOLD ? 1 : 0);
      s.tokens[t]++;
      if (v > bestV) { bestV = v; best = t; }
    }
    s.tokens[best]--;
    s.bank[best]++;
    back[best] = (back[best] || 0) + 1;
  }
  return back;
}

function context(G, w = BOT) {
  return { stage: Math.min(1, Math.max(...G.players.map((q) => score(G, q))) / (G.opts.cities ? 14 : WIN_POINTS)), demand: demandOf(G), w };
}

// add a card to a holding, its powers included as best the bot can tell
function gain(G, s, c, ctx) {
  s.points += c.points;
  s.cards++;
  if (c.kind === 'gold') { s.vgold += 2; return; }
  let g = c.bonus;
  if (isCopy(c)) {
    const owned = GEMS.filter((x) => s.count[x] > 0);
    g = owned.length ? owned.reduce((a, b) => (bonusWorth(G, s, b, ctx) > bonusWorth(G, s, a, ctx) ? b : a)) : null;
  }
  if (g) {
    s.bonus[g] += c.kind === 'double' ? 2 : 1;
    s.count[g]++;
    s.owns = true;
  }
  if (c.take) s.points += c.take === 2 ? 1.5 : 0.8;
}

// the bot's holdings after a move, and anything the move is worth beyond them
function simulate(G, p, m, base, ctx) {
  const s = copyState(base);
  let pool = marketIds(G).filter((id) => !blockedFor(G, p, id));
  let extra = 0;
  if (m.kind === 'take') for (const g of m.gems) { s.tokens[g]++; s.bank[g]--; }
  else if (m.kind === 'take2') {
    s.tokens[m.gem] += 2;
    s.bank[m.gem] -= 2;
    if (sHasPost(s, 'third')) { const o = GEMS.find((g) => g !== m.gem && s.bank[g] > 0); if (o) { s.tokens[o]++; s.bank[o]--; } }
  } else if (m.kind === 'reserve') {
    if (m.card == null) return null; // a blind reserve is a gamble the bot leaves alone
    s.reserved.push(m.card);
    if (s.bank.gold > 0) { s.tokens.gold++; s.bank.gold--; }
    const c = G.cards[m.card];
    if (c.points >= 2 && G.players.some((q) => q !== p && buyPlan(G, q, m.card))) extra += c.points * ctx.w.deny;
  } else if (m.kind === 'buy') {
    const c = G.cards[m.card];
    if (c.kind === 'sacrifice') {
      for (const x of m.discard) {
        const d = G.cards[x];
        s.points -= d.points;
        const g = colourOf(G, p, x);
        if (g) { s.bonus[g] -= d.kind === 'double' ? 2 : 1; s.count[g]--; }
        s.cards--;
      }
    } else {
      const plan = payPlan(G, p, c, m.goldCards || 0);
      for (const t of TOKENS) { s.tokens[t] -= plan.pay[t]; s.bank[t] += plan.pay[t]; }
      s.vgold -= 2 * plan.goldCards.length;
      s.cards -= plan.goldCards.length;
    }
    gain(G, s, c, ctx);
    s.reserved = s.reserved.filter((x) => x !== m.card);
    pool = pool.filter((x) => x !== m.card);
    if (sHasPost(s, 'gem')) { const o = GEMS.filter((g) => s.bank[g] > 0).sort((a, b) => s.tokens[a] - s.tokens[b])[0]; if (o) { s.tokens[o]++; s.bank[o]--; } }
    // a Noble who would visit at once
    if (G.nobleRow.some((id) => meetsReq(s.count, G.nobles[id].req))) s.points += NOBLE_POINTS;
    // in the last round only points count
    if (G.ending != null) extra += c.points * 4;
    extra += ctx.w.buy;
  }
  const full = [...pool.filter((x) => !s.reserved.includes(x)), ...s.reserved];
  const over = sum(s.tokens) - TOKEN_LIMIT;
  if (over > 0) chooseReturn(G, s, full, ctx, over);
  const same = m.kind !== 'buy' && s.reserved.length === base.reserved.length && TOKENS.every((t) => s.tokens[t] === base.tokens[t]);
  if (same) extra -= ctx.w.idle;
  return { s, pool: full, extra };
}

// the bot's best next turn after s, as if no one else moved in between:
// gems it could take from what the supply would hold, cards it could buy
function followUp(G, s, pool, ctx) {
  let best = evaluate(G, s, pool, ctx);
  const avail = GEMS.filter((g) => s.bank[g] > 0);
  const tryTokens = (add) => {
    const t = { ...s, tokens: { ...s.tokens }, bank: { ...s.bank } };
    for (const [g, k] of add) { t.tokens[g] += k; t.bank[g] -= k; }
    if (sum(t.tokens) > TOKEN_LIMIT) return;
    best = Math.max(best, evaluate(G, t, pool, ctx));
  };
  for (let i = 0; i < avail.length; i++) for (let j = i + 1; j < avail.length; j++) for (let k = j + 1; k < avail.length; k++) tryTokens([[avail[i], 1], [avail[j], 1], [avail[k], 1]]);
  for (const g of GEMS) if (s.bank[g] >= 4) tryTokens([[g, 2]]);
  const per = sHasPost(s, 'gold') ? 2 : 1;
  for (const id of pool) {
    const c = G.cards[id];
    if (c.kind === 'sacrifice' || (isCopy(c) && !s.owns)) continue;
    const pay = { gold: 0 };
    let need = 0;
    for (const g of GEMS) {
      const n = Math.max(0, (c.cost[g] || 0) - s.bonus[g]);
      const gold = Math.ceil(Math.max(0, n - s.tokens[g]) / per);
      pay[g] = Math.max(0, n - gold * per);
      need += gold;
    }
    if (need > s.tokens.gold + s.vgold) continue;
    const t = copyState(s);
    for (const g of GEMS) { t.tokens[g] -= pay[g]; t.bank[g] += pay[g]; }
    const fromV = Math.min(need, t.vgold);
    t.vgold -= fromV;
    t.tokens.gold -= need - fromV;
    gain(G, t, c, ctx);
    t.reserved = t.reserved.filter((x) => x !== id);
    best = Math.max(best, evaluate(G, t, pool.filter((x) => x !== id), ctx) + ctx.w.buy);
  }
  return best;
}

// the best of the table's cards by the bot's own measure
function bestCard(G, p, ids, ctx) {
  const s = holdings(G, p);
  return ids.slice().sort((a, b) => cardWorth(G, s, G.cards[b], ctx) - cardWorth(G, s, G.cards[a], ctx))[0];
}

export function botChoose(G, seat, weights = BOT) {
  const p = playerBySeat(G, seat);
  const a = G.ask;
  if (!p || !a || a.seat !== seat) return null;
  const ctx = context(G, weights);
  switch (a.kind) {
    case 'noble': return { noble: a.options[0] };
    case 'post': {
      // the Trading Post whose power is worth most: points first late on
      const order = ctx.stage > 0.6 ? ['points', 'gem', 'gold', 'third', 'draw2'] : ['gem', 'gold', 'third', 'points', 'draw2'];
      return { post: a.options.slice().sort((x, y) => order.indexOf(TRADING_POSTS[x].power) - order.indexOf(TRADING_POSTS[y].power))[0] };
    }
    case 'discard': {
      const s = holdings(G, p);
      return { tokens: chooseReturn(G, s, [...marketIds(G), ...s.reserved], ctx, a.n) };
    }
    case 'copy': {
      const s = holdings(G, p);
      return { target: a.options.slice().sort((x, y) => bonusWorth(G, s, colourOf(G, p, y), ctx) - bonusWorth(G, s, colourOf(G, p, x), ctx))[0] };
    }
    case 'take': return { card: bestCard(G, p, a.options, ctx) };
    case 'gem':
    case 'third': {
      // the gem its best cards lack most
      const s = holdings(G, p);
      const pool = [...marketIds(G), ...s.reserved];
      let best = a.options[0], bestV = -Infinity;
      for (const g of a.options) {
        const t = copyState(s);
        t.tokens[g]++;
        const v = evaluate(G, t, pool, ctx);
        if (v > bestV) { bestV = v; best = g; }
      }
      return { gem: best };
    }
    case 'draw2': return { keep: bestCard(G, p, a.options, ctx) };
    case 'hold': {
      const o = holdOptions(G, p);
      const table = marketIds(G);
      // knock a lone rival off the card the bot wants most
      const top = bestCard(G, p, table, ctx);
      if (o.remove.includes(top)) return { remove: top };
      if (o.canPlace) {
        // pile onto a card it already holds, toward a conquest, or start on
        // the one it wants
        const want = bestCard(G, p, o.to, ctx);
        const target = o.mine.find((id) => o.to.includes(id) && (G.holds[id] || []).length < STRONGHOLDS) ?? want;
        if (p.holds > 0) return { to: target };
        const from = o.mine.find((x) => x !== target);
        if (from != null) return { to: target, from };
        // every Stronghold already on the target: move one anywhere else
        for (const f of o.mine) for (const t of o.to) if (t !== f) return { to: t, from: f };
      }
      return o.remove.length ? { remove: o.remove[0] } : null;
    }
    case 'conquest': {
      const plan = buyPlan(G, p, a.card);
      return plan ? { buy: true, ...(plan.discard ? { discard: plan.discard } : { goldCards: plan.goldCards }) } : { buy: false };
    }
    case 'turn': break;
    default: return null;
  }
  const base = holdings(G, p);
  let best = null;
  let bestV = -Infinity;
  for (const m of legalActions(G, p)) {
    const sim = simulate(G, p, m, base, ctx);
    if (!sim) continue;
    const now = evaluate(G, sim.s, sim.pool, ctx);
    const v = (ctx.w.ahead ? (1 - ctx.w.ahead) * now + ctx.w.ahead * followUp(G, sim.s, sim.pool, ctx) : now) + sim.extra + Math.random() * 0.05;
    if (v > bestV) { bestV = v; best = m; }
  }
  return best || legalActions(G, p)[0] || null;
}
