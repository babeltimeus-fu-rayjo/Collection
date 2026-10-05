// game.js — the rules of Splendor. No DOM, no network: the host holds the
// only copy of the state and every move goes through applyMove.
//
// Two to four Renaissance merchants buy Development cards with Gem tokens.
// Every card bought is a permanent bonus — one gem off every later card of its
// colour — and some carry Prestige points; a Noble visits whoever gathers the
// bonuses the tile asks for. On your turn, exactly one action: take three
// gems of different colours, take two of one colour (from a pile of four or
// more), reserve a card and take a Gold, or buy a card. Then you hand back
// tokens beyond ten, and a Noble may visit. Once someone reaches 15 Prestige
// points the round is played out, and the most prestigious merchant wins.

import { GEMS, GOLD, TOKENS, GEM, CARDS, NOBLES, NOBLE_POINTS, GEMS_FOR, GOLD_TOKENS, NOBLES_FOR, MARKET, WIN_POINTS, TOKEN_LIMIT, RESERVE_LIMIT } from './cards.js';

export { GEMS, GOLD, TOKENS, GEM, CARDS, NOBLES, NOBLE_POINTS, GEMS_FOR, WIN_POINTS, TOKEN_LIMIT, RESERVE_LIMIT } from './cards.js';

export const PROTO = 1;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;
export const LEVELS = [1, 2, 3];

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
export function tokenWords(t) {
  const parts = [];
  for (const g of TOKENS) {
    const k = t[g] || 0;
    if (k) parts.push(k === 1 ? ONE[g] : `${k} ${MANY[g]}`);
  }
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
const cardWords = (c) => `a level-${c.level} ${gemName(c.bonus)} card${c.points ? ` (${c.points} point${c.points === 1 ? '' : 's'})` : ''}`;

// ---------------------------------------------------------------- setup

export function canStart(n) {
  if (n < MIN_PLAYERS) return `Needs at least ${MIN_PLAYERS} players — add a bot to fill the table.`;
  if (n > MAX_PLAYERS) return `At most ${MAX_PLAYERS} players.`;
  return null;
}

export function newGame(roster) {
  const n = roster.length;
  const why = canStart(n);
  if (why) throw new Error(why);
  const cards = CARDS.map((c, id) => ({ id, ...c }));
  const decks = { 1: [], 2: [], 3: [] };
  for (const c of cards) decks[c.level].push(c.id);
  for (const l of LEVELS) shuffle(decks[l]);
  // "Reveal 4 cards from each level deck"
  const market = { 1: [], 2: [], 3: [] };
  for (const l of LEVELS) for (let i = 0; i < MARKET; i++) market[l].push(decks[l].length ? decks[l].pop() : null);
  const nobles = NOBLES.map((req, id) => ({ id, req, points: NOBLE_POINTS }));
  const bank = zero();
  for (const g of GEMS) bank[g] = GEMS_FOR[n];
  bank.gold = GOLD_TOKENS;
  // "The youngest player takes the First Player marker" — here, a random one
  const first = Math.floor(Math.random() * n);
  const G = {
    mid: Math.random().toString(36).slice(2, 10),
    phase: 'play',
    n,
    cards,
    nobles,
    decks,
    market,
    nobleRow: shuffle(nobles.map((x) => x.id)).slice(0, NOBLES_FOR(n)),
    bank,
    players: roster.map((r) => ({
      seat: r.seat, name: r.name, bot: !!r.bot, connected: r.bot ? true : r.connected !== false,
      tokens: zero(), cards: [], reserved: [], nobles: [], turns: 0,
    })),
    first,
    turn: first,
    ask: null,
    ending: null,    // the seat whose 15 points triggered the end
    passes: 0,
    winners: null,
    why: '',
    log: [],
    fxs: [],
  };
  note(G, `${n} players: ${GEMS_FOR[n]} tokens of each gem, ${NOBLES_FOR(n)} Nobles. ${G.players[first].name} plays first.`);
  bump(G, { kind: 'start' });
  beginTurn(G);
  return G;
}

// ---------------------------------------------------------------- reading the table

export function bonuses(G, p) {
  const b = Object.fromEntries(GEMS.map((g) => [g, 0]));
  for (const id of p.cards) b[G.cards[id].bonus]++;
  return b;
}

export const score = (G, p) => p.cards.reduce((s, id) => s + G.cards[id].points, 0) + p.nobles.length * NOBLE_POINTS;

// What buying a card costs this player: the gems after their bonuses, from
// their own tokens first and Gold for the rest — or null if they cannot.
export function payment(G, p, card) {
  const b = bonuses(G, p);
  const pay = zero();
  let gold = 0;
  for (const g of GEMS) {
    const need = Math.max(0, (card.cost[g] || 0) - b[g]);
    const use = Math.min(need, p.tokens[g]);
    pay[g] = use;
    gold += need - use;
  }
  if (gold > p.tokens.gold) return null;
  pay.gold = gold;
  return pay;
}

const marketIds = (G) => LEVELS.flatMap((l) => G.market[l].filter((id) => id != null));
const inMarket = (G, id) => LEVELS.some((l) => G.market[l].includes(id));

// the cards this player could buy right now
export function affordable(G, p) {
  return [...marketIds(G), ...p.reserved.map((r) => r.id)].filter((id) => payment(G, p, G.cards[id]));
}

export const meets = (G, p, noble) => {
  const b = bonuses(G, p);
  return GEMS.every((g) => b[g] >= (noble.req[g] || 0));
};

const availableGems = (G) => GEMS.filter((g) => G.bank[g] > 0);

// whether this player has any action at all — the rulebook has no pass, but a
// table where nothing can be taken, reserved or bought needs one
export function hasAction(G, p) {
  if (availableGems(G).length) return true;
  if (p.reserved.length < RESERVE_LIMIT && (marketIds(G).length || LEVELS.some((l) => G.decks[l].length))) return true;
  return affordable(G, p).length > 0;
}

// ---------------------------------------------------------------- the turn

function beginTurn(G) {
  for (let guard = 0; guard < G.n + 1; guard++) {
    const p = G.players[G.turn];
    if (hasAction(G, p)) {
      G.ask = { kind: 'turn', seat: p.seat };
      return;
    }
    note(G, `${p.name} can neither take, reserve nor buy, and passes.`);
    G.passes++;
    if (G.passes >= G.n) return finish(G, 'no one can do anything more');
    p.turns++;
    if (advance(G)) return;
  }
}

// to the next player — or the end, once the round that reached 15 is complete
function advance(G) {
  const next = (G.turn + 1) % G.n;
  if (G.ending != null && next === G.first) {
    finish(G, 'the round is complete');
    return true;
  }
  G.turn = next;
  return false;
}

function endTurn(G, p) {
  G.ask = null;
  p.turns++;
  if (G.ending == null && score(G, p) >= WIN_POINTS) {
    G.ending = p.seat;
    note(G, `${p.name} reaches ${score(G, p)} Prestige points — this is the last round.`);
    bump(G, { kind: 'ending', seat: p.seat });
  }
  if (advance(G)) return;
  beginTurn(G);
}

// After the action: tokens beyond ten go back, then a Noble may visit.
function afterAction(G, p) {
  const over = sum(p.tokens) - TOKEN_LIMIT;
  if (over > 0) {
    G.ask = { kind: 'discard', seat: p.seat, n: over };
    return;
  }
  nobleVisit(G, p);
}

// "At the end of your turn, check if you meet the swaying requirement ... You
// may only acquire 1 Noble tile per turn. If you meet the swaying requirements
// for several Noble tiles, you must choose 1."
function nobleVisit(G, p) {
  const options = G.nobleRow.filter((id) => meets(G, p, G.nobles[id]));
  if (options.length > 1) {
    G.ask = { kind: 'noble', seat: p.seat, options };
    return;
  }
  if (options.length === 1) takeNoble(G, p, options[0]);
  endTurn(G, p);
}

function takeNoble(G, p, id) {
  G.nobleRow = G.nobleRow.filter((x) => x !== id);
  p.nobles.push(id);
  note(G, `A Noble visits ${p.name}: 3 Prestige points.`);
  bump(G, { kind: 'noble', seat: p.seat, noble: id });
}

function finish(G, why) {
  G.phase = 'over';
  G.ask = null;
  const scored = G.players.map((p) => ({ seat: p.seat, points: score(G, p), cards: p.cards.length }));
  const best = Math.max(...scored.map((s) => s.points));
  let top = scored.filter((s) => s.points === best);
  // "If there is a tie, the tied player who purchased the FEWEST Development
  // cards wins. If it's still tied, the tied players share the victory."
  const fewest = Math.min(...top.map((s) => s.cards));
  const tied = top.length > 1;
  top = top.filter((s) => s.cards === fewest);
  G.winners = top.map((s) => s.seat);
  const names = top.map((s) => playerBySeat(G, s.seat).name);
  G.why = `${why}${tied ? (top.length === 1 ? ', and the tie goes to fewer cards bought' : ', and they bought as many cards each') : ''}`;
  note(G, `${names.length === 1 ? `${names[0]} wins` : `${names.join(' and ')} share the victory`} with ${best} Prestige points.`);
  bump(G, { kind: 'over', winners: G.winners });
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
  let r;
  if (a.kind === 'turn') {
    r = act(G, p, move);
    if (r.ok) {
      G.passes = 0;
      afterAction(G, p);
    }
  } else if (a.kind === 'discard') {
    r = giveBack(G, p, move, a.n);
    if (r.ok) nobleVisit(G, p);
  } else if (a.kind === 'noble') {
    if (!a.options.includes(move.noble)) return { ok: false, error: 'Choose one of the Nobles who would visit you.' };
    takeNoble(G, p, move.noble);
    endTurn(G, p);
    r = { ok: true };
  } else r = { ok: false, error: 'Unknown question.' };
  return r;
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
      return { ok: true };
    }
    case 'reserve': {
      if (p.reserved.length >= RESERVE_LIMIT) return { ok: false, error: `You already hold ${RESERVE_LIMIT} reserved cards.` };
      let id;
      let blind = false;
      if (move.card != null) {
        if (!inMarket(G, move.card)) return { ok: false, error: 'That card is not on the table.' };
        id = move.card;
        takeFromMarket(G, id);
      } else if (LEVELS.includes(move.level)) {
        if (!G.decks[move.level].length) return { ok: false, error: 'That deck is empty.' };
        id = G.decks[move.level].pop();
        blind = true;
      } else return { ok: false, error: 'Reserve a card on the table, or the top of a deck.' };
      p.reserved.push({ id, blind });
      // "Then, take 1 Gold token. If no Gold tokens remain, you may still reserve a card."
      const gold = G.bank.gold > 0;
      if (gold) { G.bank.gold--; p.tokens.gold++; }
      const c = G.cards[id];
      note(G, `${p.name} reserves ${blind ? `the top card of the level-${c.level} deck` : cardWords(c)}${gold ? ' and takes a Gold' : ' — no Gold is left'}.`);
      bump(G, { kind: 'reserve', seat: p.seat, card: blind ? null : faceOf(G, id), level: c.level, gold });
      return { ok: true };
    }
    case 'buy': {
      const id = move.card;
      const fromHand = p.reserved.findIndex((r) => r.id === id);
      if (fromHand < 0 && !inMarket(G, id)) return { ok: false, error: 'Buy a card on the table or one you have reserved.' };
      const c = G.cards[id];
      const pay = payment(G, p, c);
      if (!pay) return { ok: false, error: 'You cannot afford that card yet.' };
      for (const t of TOKENS) { p.tokens[t] -= pay[t]; G.bank[t] += pay[t]; }
      if (fromHand >= 0) p.reserved.splice(fromHand, 1);
      else takeFromMarket(G, id);
      p.cards.push(id);
      const spent = sum(pay);
      note(G, `${p.name} buys ${cardWords(c)}${fromHand >= 0 ? ' from their reserve' : ''}${spent ? ` for ${tokenWords(pay)}` : ' with bonuses alone'}.`);
      bump(G, { kind: 'buy', seat: p.seat, card: faceOf(G, id), pay });
      return { ok: true };
    }
    default:
      return { ok: false, error: 'Take gems, reserve a card or buy one.' };
  }
}

// "Each time a card from the middle of the table is reserved or purchased,
// draw the top card from the corresponding deck to replace it ... unless the
// deck becomes depleted."
function takeFromMarket(G, id) {
  for (const l of LEVELS) {
    const i = G.market[l].indexOf(id);
    if (i >= 0) {
      G.market[l][i] = G.decks[l].length ? G.decks[l].pop() : null;
      return;
    }
  }
}

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

const faceOf = (G, id) => { const c = G.cards[id]; return { id, level: c.level, bonus: c.bonus, points: c.points, cost: { ...c.cost } }; };
const nobleOf = (G, id) => ({ id, req: { ...G.nobles[id].req }, points: G.nobles[id].points });

// Everything in Splendor is on the table but the decks and the cards reserved
// blind from them: those only their owner sees, until the game ends.
export function viewFor(G, seat, code, opts = {}) {
  const me = playerBySeat(G, seat);
  const over = G.phase === 'over';
  return {
    code, mid: G.mid, you: seat, phase: G.phase, n: G.n,
    turn: G.players[G.turn].seat,
    first: G.players[G.first].seat,
    ending: G.ending,
    bank: { ...G.bank },
    decks: Object.fromEntries(LEVELS.map((l) => [l, G.decks[l].length])),
    market: Object.fromEntries(LEVELS.map((l) => [l, G.market[l].map((id) => (id == null ? null : faceOf(G, id)))])),
    nobles: G.nobleRow.map((id) => nobleOf(G, id)),
    players: G.players.map((p) => {
      const peek = opts.revealBots && p.bot;
      return {
        seat: p.seat, name: p.name, bot: p.bot, connected: p.connected, botFor: !!p.botFor, resigned: !!p.resigned,
        tokens: { ...p.tokens },
        bonuses: bonuses(G, p),
        cards: p.cards.map((id) => faceOf(G, id)),
        points: score(G, p),
        nobles: p.nobles.map((id) => nobleOf(G, id)),
        reserved: p.reserved.map((r) => (p.seat === seat || !r.blind || over || peek ? { ...faceOf(G, r.id), blind: r.blind } : { level: G.cards[r.id].level, blind: true, hidden: true })),
        turns: p.turns,
      };
    }),
    ask: G.ask ? { ...G.ask } : null,
    affordable: me && G.ask && G.ask.kind === 'turn' && G.ask.seat === seat ? affordable(G, me) : [],
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
// result scored: Prestige points above all; then bonuses, worth more early on
// and in the colours the table's cards and Nobles want; then how close it
// stands to the best cards it could buy next — counting gems the supply has
// run out of as slow to come by — and to each Noble; and a little for tokens
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
};

const holdings = (G, p) => ({ tokens: { ...p.tokens }, bonus: bonuses(G, p), points: score(G, p), reserved: p.reserved.map((r) => r.id), bank: { ...G.bank } });

// how many turns of taking gems until a card can be bought: three gems a
// turn at best, two of one colour, Gold filling the scarcest gaps first, and
// every gem the supply cannot give counting as a turn of its own
function turnsTo(c, s) {
  const miss = {};
  for (const g of GEMS) miss[g] = Math.max(0, (c.cost[g] || 0) - s.bonus[g] - s.tokens[g]);
  let gold = s.tokens.gold;
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

// what owning one more bonus of this colour is worth now
function bonusWorth(G, s, g, ctx) {
  const W = ctx.w;
  let w = W.bonus * (1 - ctx.stage * 0.7) * (0.6 + ctx.demand[g]);
  for (const id of G.nobleRow) {
    const req = G.nobles[id].req;
    if ((req[g] || 0) <= s.bonus[g]) continue;
    const left = GEMS.reduce((a, x) => a + Math.max(0, (req[x] || 0) - s.bonus[x]), 0);
    w += (W.noble * NOBLE_POINTS * W.point) / (left * left + 2);
  }
  return w;
}

function evaluate(G, s, pool, ctx) {
  const W = ctx.w;
  let v = s.points * W.point;
  for (const g of GEMS) v += s.bonus[g] * W.bonus * (1 - ctx.stage * 0.5);
  for (const id of G.nobleRow) {
    const req = G.nobles[id].req;
    const left = GEMS.reduce((a, x) => a + Math.max(0, (req[x] || 0) - s.bonus[x]), 0);
    v += (W.noble * NOBLE_POINTS * W.point) / (left + 1.5);
  }
  // the best cards within reach, the nearest counting most
  const reach = [];
  for (const id of pool) {
    const c = G.cards[id];
    const worth = c.points * W.point + bonusWorth(G, s, c.bonus, ctx);
    reach.push(worth * W.decay ** (turnsTo(c, s) + 1));
  }
  reach.sort((a, b) => b - a);
  v += (reach[0] || 0) + W.second * (reach[1] || 0) + W.third * (reach[2] || 0);
  v += (sum(s.tokens) - s.tokens.gold) * W.token + s.tokens.gold * W.gold;
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
    for (const id of marketIds(G)) out.push({ kind: 'reserve', card: id });
    for (const l of LEVELS) if (G.decks[l].length) out.push({ kind: 'reserve', level: l });
  }
  for (const id of affordable(G, p)) out.push({ kind: 'buy', card: id });
  return out;
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
  return { stage: Math.min(1, Math.max(...G.players.map((q) => score(G, q))) / WIN_POINTS), demand: demandOf(G), w };
}

// the bot's holdings after a move, and anything the move is worth beyond them
function simulate(G, p, m, base, ctx) {
  const s = { tokens: { ...base.tokens }, bonus: { ...base.bonus }, points: base.points, reserved: base.reserved.slice(), bank: { ...base.bank } };
  let pool = marketIds(G);
  let extra = 0;
  if (m.kind === 'take') for (const g of m.gems) { s.tokens[g]++; s.bank[g]--; }
  else if (m.kind === 'take2') { s.tokens[m.gem] += 2; s.bank[m.gem] -= 2; }
  else if (m.kind === 'reserve') {
    if (m.card == null) return null; // a blind reserve is a gamble the bot leaves alone
    s.reserved.push(m.card);
    if (s.bank.gold > 0) { s.tokens.gold++; s.bank.gold--; }
    // a card someone else could buy at once is also a card kept from them
    const c = G.cards[m.card];
    if (c.points >= 2 && G.players.some((q) => q !== p && payment(G, q, c))) extra += c.points * ctx.w.deny;
  } else if (m.kind === 'buy') {
    const c = G.cards[m.card];
    const pay = payment(G, p, c);
    for (const t of TOKENS) { s.tokens[t] -= pay[t]; s.bank[t] += pay[t]; }
    s.bonus[c.bonus]++;
    s.points += c.points;
    s.reserved = s.reserved.filter((x) => x !== m.card);
    pool = pool.filter((x) => x !== m.card);
    // a Noble who would visit at once
    if (G.nobleRow.some((id) => GEMS.every((g) => s.bonus[g] >= (G.nobles[id].req[g] || 0)))) s.points += NOBLE_POINTS;
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
  for (const id of pool) {
    const c = G.cards[id];
    const pay = { gold: 0 };
    let ok = true;
    for (const g of GEMS) {
      const need = Math.max(0, (c.cost[g] || 0) - s.bonus[g]);
      pay[g] = Math.min(need, s.tokens[g]);
      pay.gold += need - pay[g];
    }
    if (pay.gold > s.tokens.gold) ok = false;
    if (!ok) continue;
    const t = { ...s, tokens: { ...s.tokens }, bonus: { ...s.bonus }, bank: { ...s.bank }, reserved: s.reserved.filter((x) => x !== id) };
    for (const x of TOKENS) { t.tokens[x] -= pay[x] || 0; t.bank[x] += pay[x] || 0; }
    t.bonus[c.bonus]++;
    t.points += c.points;
    best = Math.max(best, evaluate(G, t, pool.filter((x) => x !== id), ctx) + ctx.w.buy);
  }
  return best;
}

export function botChoose(G, seat, weights = BOT) {
  const p = playerBySeat(G, seat);
  const a = G.ask;
  if (!p || !a || a.seat !== seat) return null;
  const ctx = context(G, weights);
  if (a.kind === 'noble') return { noble: a.options[0] };
  if (a.kind === 'discard') {
    const s = holdings(G, p);
    return { tokens: chooseReturn(G, s, [...marketIds(G), ...s.reserved], ctx, a.n) };
  }
  if (a.kind !== 'turn') return null;
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
