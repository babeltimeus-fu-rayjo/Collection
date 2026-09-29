// game.js — the rules of Challengers! and Challengers! Beach Cup. No DOM, no
// network: the host holds the only copy of the state and every move goes
// through applyMove, which is what makes it testable.
//
// A tournament is seven rounds. Each round everyone drafts first, on their
// own — draw five cards from the Level pile the round offers, keep one, two
// or three, cut whatever they like — and then plays one match against the
// opponent the schedule gives them. After the seventh round the two players
// with the most fans play the final. (Two players play no final: most fans
// after seven rounds, or a lead of eleven at the end of any match.) At an odd
// table the Robot takes the spare seat, and a player alone plays the Robot.
//
// A match plays itself. Shuffle, and one player turns over their top card,
// which takes the flag. The other attacks: they turn over cards one at a time
// until the power of everything they turned over reaches the power of the
// card with the flag, and then their latest card takes the flag, the others
// slide under it, and the card that lost the flag goes to its owner's bench
// with everything under it — one seat per name, six seats. Roles swap. You
// lose if you must attack and have nothing left to turn over, or if you must
// bench a card with no seat for it. The only decisions in a match are the
// ones card effects ask for, so the match is a queue of small tasks that
// stops whenever one of them needs somebody to choose.

import {
  SETS, BOXES, CARDS, CARD, STARTER, ROBOT_DECK, DRAFT, TROPHIES,
  ROUNDS, BENCH_SEATS, DRAW, LEAD_WIN,
} from './cards.js';

export { SETS, BOXES, CARDS, CARD, ROBOT_DECK, ROUNDS, BENCH_SEATS } from './cards.js';

export const PROTO = 1;
export const MIN_PLAYERS = 1;
export const MAX_PLAYERS = 8;
export const ROBOT = 'Robot';

// ---------------------------------------------------------------- small helpers

export const playerBySeat = (G, seat) => G.players.find((p) => p.seat === seat);
const clone = (x) => JSON.parse(JSON.stringify(x));

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const cardOf = (G, id) => CARD[G.cards[id].key];

// A Rainbow card "has all set icons": it counts as every set for anything
// that asks about one.
export function hasSet(c, set) {
  return c.set === set || !!SETS[c.set].allIcons;
}

function note(G, text) {
  G.logId = (G.logId || 0) + 1;
  G.log.push({ id: G.logId, text });
  if (G.log.length > 80) G.log.shift();
}

function bump(G, fx) {
  G.fxSeq = (G.fxSeq || 0) + 1;
  G.fx = { seq: G.fxSeq, ...fx };
}

// ---------------------------------------------------------------- options

// What the lobby can set. `box` picks the basic set and the starter decks;
// `sets` is the five additional sets in play, from either box.
export function defaultOpts(box = 'base') {
  const b = BOXES[box];
  return { box, basic: b.basic, sets: b.sets.filter((s) => s !== b.suggestOut) };
}

export function checkOpts(opts) {
  if (!opts || !BOXES[opts.box]) return 'Pick which box to play.';
  if (!SETS[opts.basic] || !SETS[opts.basic].basic) return 'Pick a basic set.';
  if (!Array.isArray(opts.sets) || opts.sets.length !== 5) return 'Pick five additional sets.';
  for (const s of opts.sets) if (!SETS[s] || SETS[s].basic || SETS[s].robot) return `${s} is not an additional set.`;
  if (new Set(opts.sets).size !== 5) return 'Pick five different sets.';
  return null;
}

// Every round pairs the whole table off, so an odd table needs a spare
// player: "If you play with an odd number of players, the Robot substitutes
// for a missing player." A player alone plays the Robot — the solo game.
export function canStart(n, opts) {
  if (n < MIN_PLAYERS) return 'Needs at least one player.';
  if (n > MAX_PLAYERS) return `At most ${MAX_PLAYERS} players.`;
  return checkOpts(opts);
}

// A player alone against the Robot plays by the two-player rules, and there
// the Robot counts: "the Robot collects the Trophies it has won and can also
// win the game". At a table of three or more it only stands in: it keeps no
// Trophy, is never ranked, and never plays the final.
export const isSolo = (G) => G.players.length === 2 && G.players.some((p) => p.robot);
export const ranked = (G) => (isSolo(G) ? G.players.slice() : G.players.filter((p) => !p.robot));

// ---------------------------------------------------------------- setup

// Each round everyone meets someone new, for as long as there is someone new
// to meet: the circle method, which gives an eight-player table a full round
// robin in exactly seven rounds and smaller tables a cycle through theirs.
export function schedule(seats, rounds = ROUNDS) {
  const n = seats.length;
  const ring = seats.slice();
  const cycle = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) pairs.push([ring[i], ring[n - 1 - i]]);
    cycle.push(pairs);
    ring.splice(1, 0, ring.pop());
  }
  const out = [];
  for (let r = 0; r < rounds; r++) out.push(cycle[r % cycle.length].map((p) => p.slice()));
  return out;
}

export function newMatch(roster, opts = defaultOpts()) {
  const why = checkOpts(opts);
  if (why) throw new Error(why);
  const G = {
    mid: Math.random().toString(36).slice(2, 10),
    phase: 'deck',
    round: 1,
    opts: clone(opts),
    cards: [],
    piles: { A: [], B: [], C: [] },
    discard: { A: [], B: [], C: [] },
    players: [],
    parks: [],
    schedule: [],
    matches: [],
    history: [],
    final: null,
    log: [],
    result: null,
    winner: null,
  };
  const make = (key) => { G.cards.push({ id: G.cards.length, key }); return G.cards.length - 1; };

  // the Level piles: the basic set and the five chosen, split by Level
  for (const c of CARDS) {
    if (c.level === 'S') continue;
    if (c.set !== opts.basic && !opts.sets.includes(c.set)) continue;
    for (let i = 0; i < c.copies; i++) G.piles[c.level].push(make(c.key));
  }
  for (const L of 'ABC') shuffle(G.piles[L]);

  for (const r of roster) {
    G.players.push({
      seat: r.seat,
      name: r.name,
      bot: !!r.bot,
      connected: r.bot ? true : r.connected !== false,
      deck: STARTER[opts.box].map(make),
      fans: 0,
      trophies: [],
      lostLast: false,
      draft: null,
      ready: false,
    });
  }
  // an odd table, or a player alone: the Robot takes the spare seat, with its
  // own deck and no part in any Deck Phase
  if (roster.length % 2) {
    let seat = 0;
    while (roster.some((r) => r.seat === seat)) seat++;
    G.players.push({
      seat, name: ROBOT, bot: true, robot: true, connected: true,
      deck: ROBOT_DECK.map(make), fans: 0, trophies: [], lostLast: false, draft: null, ready: true,
    });
  }
  const seats = G.players.map((p) => p.seat);

  // one park per match, each with a face-down Trophy for every round
  const parks = seats.length / 2;
  const piles = TROPHIES.map((r) => shuffle(r.slice()));
  for (let k = 0; k < parks; k++) G.parks.push(piles.map((r) => r[k]));
  G.schedule = schedule(shuffle(seats.slice()));

  const who = roster.length === 1 ? `${roster[0].name} against the Robot`
    : `${roster.length} players${roster.length % 2 ? ' and the Robot' : ''}`;
  note(G, `The tournament begins: ${who}, ${[opts.basic, ...opts.sets].map((s) => SETS[s].name).join(', ')}.`);
  startDeckPhase(G);
  return G;
}

// ---------------------------------------------------------------- Level piles

// "When no additional card fits in the compartment, shuffle all cards in it
// and place them at the bottom of the corresponding Level Pile." A browser has
// no compartment to fill, so the discards go back under the pile when it runs
// short — the same cards return, a little later than a full tray would send them.
function drawPile(G, L) {
  if (!G.piles[L].length && G.discard[L].length) {
    G.piles[L].push(...shuffle(G.discard[L].splice(0)));
  }
  return G.piles[L].length ? G.piles[L].shift() : null;
}

// a card leaving play for good: Level cards go back to their tray's discard,
// starter cards back into the box
function toDiscard(G, id) {
  const L = cardOf(G, id).level;
  if (L === 'S') return;
  G.discard[L].push(id);
}

// ---------------------------------------------------------------- the Deck Phase

function startDeckPhase(G) {
  G.phase = 'deck';
  G.matches = [];
  const plan = DRAFT[G.opts.box][G.round - 1];
  for (const p of G.players) {
    // "The Robot does nothing in the Deck Phase."
    if (p.robot) { p.ready = true; p.draft = null; continue; }
    p.ready = false;
    p.draft = {
      options: plan.map((o) => ({ ...o })),
      chosen: plan.length === 1 ? 0 : null,
      drawn: [],
      picks: 0,
      extra: 0,
      redrawn: false,
      pending: null,        // a When picked effect waiting on a choice
      fans: 0,
    };
    if (plan.length === 1) drawFor(G, p, DRAW);
  }
  note(G, `Round ${G.round}: the Deck Phase. ${plan.map((o) => `${o.pick} from ${o.level}${o.fans ? ` (+${o.fans} fans)` : ''}`).join(' or ')}.`);
  bump(G, { kind: 'deck', round: G.round });
}

function drawFor(G, p, n) {
  const d = p.draft;
  const L = d.options[d.chosen].level;
  for (let i = 0; i < n; i++) {
    const id = drawPile(G, L);
    if (id !== null) d.drawn.push(id);
  }
}

const picksAllowed = (d) => (d.chosen === null ? 0 : d.options[d.chosen].pick + d.extra);

// the final: no drafting, but the two finalists may still cut their decks
function startFinalDeck(G, a, b) {
  G.phase = 'final-deck';
  G.final = { seats: [a, b] };
  G.matches = [];
  for (const p of G.players) {
    const finalist = p.seat === a || p.seat === b;
    p.ready = !finalist;
    p.draft = finalist ? { options: [], chosen: null, drawn: [], picks: 0, extra: 0, redrawn: true, pending: null, fans: 0, finalOnly: true } : null;
  }
  note(G, `${playerBySeat(G, a).name} and ${playerBySeat(G, b).name} meet in the final.`);
  bump(G, { kind: 'final', seats: [a, b] });
}

// When picked effects. Each either happens outright or leaves a choice on
// the draft that the next move answers.
function whenPicked(G, p, id) {
  const c = cardOf(G, id);
  const d = p.draft;
  switch (c.key) {
    case 'clones': p.fans += 1; d.fans += 1; note(G, `${p.name} picks Clones: +1 fan.`); break;
    case 'cheerleader': p.fans += 2; d.fans += 2; note(G, `${p.name} picks a Cheerleader: +2 fans.`); break;
    // "a card from your deck" — the card just picked is in your deck too
    case 'shapeshifter':
    case 'matryoshka':
      if (p.deck.length > 1) d.pending = { kind: 'cut-for-pick', card: c.key, need: 1, optional: true, pool: p.deck.slice() };
      break;
    case 'sci-fi-geek': {
      const pool = p.deck.filter((x) => hasSet(cardOf(G, x), 'space'));
      if (pool.length >= 2 && p.deck.length > 2) d.pending = { kind: 'cut-for-pick', card: c.key, need: 2, optional: true, pool };
      break;
    }
    case 'grandmother': {
      const pool = p.deck.filter((x) => cardOf(G, x).power >= 3);
      if (pool.length) d.pending = { kind: 'cut', card: c.key, need: 1, optional: false, pool };
      break;
    }
    case 'surf-teacher': {
      const three = [];
      for (let i = 0; i < 3; i++) { const x = drawPile(G, 'A'); if (x !== null) three.push(x); }
      if (three.length) d.pending = { kind: 'surf', card: c.key, need: 1, optional: false, pool: three };
      break;
    }
    default: break;
  }
}

function deckMove(G, p, move) {
  const d = p.draft;
  if (!d) return { ok: false, error: 'Nothing to draft now.' };
  if (p.ready) return { ok: false, error: 'You are already done.' };
  if (d.pending && move.kind !== 'answer') return { ok: false, error: 'Answer the card first.' };
  switch (move.kind) {
    case 'option': {
      if (d.finalOnly) return { ok: false, error: 'No drafting before the final.' };
      if (d.chosen !== null) return { ok: false, error: 'You have already chosen a pile.' };
      const k = Number(move.option);
      if (!d.options[k]) return { ok: false, error: 'No such option.' };
      d.chosen = k;
      drawFor(G, p, DRAW);
      return { ok: true };
    }
    case 'pick': {
      if (d.chosen === null) return { ok: false, error: 'Choose a pile first.' };
      if (d.picks >= picksAllowed(d)) return { ok: false, error: 'You have picked all you may.' };
      const i = d.drawn.indexOf(move.card);
      if (i < 0) return { ok: false, error: 'That card is not in your draw.' };
      d.drawn.splice(i, 1);
      p.deck.push(move.card);
      d.picks++;
      whenPicked(G, p, move.card);
      return { ok: true };
    }
    case 'redraw': {
      if (d.chosen === null || d.finalOnly) return { ok: false, error: 'Nothing to redraw.' };
      if (d.redrawn) return { ok: false, error: 'You may redraw once per Deck Phase.' };
      if (d.picks >= picksAllowed(d)) return { ok: false, error: 'You have already picked everything.' };
      const n = d.drawn.length;
      for (const x of d.drawn.splice(0)) toDiscard(G, x);
      drawFor(G, p, n);
      d.redrawn = true;
      return { ok: true };
    }
    case 'answer': {
      const q = d.pending;
      if (!q) return { ok: false, error: 'Nothing to answer.' };
      const ids = Array.isArray(move.cards) ? move.cards : [];
      if (!ids.length && !q.optional) return { ok: false, error: 'This one is not optional.' };
      if (ids.length && ids.length !== q.need) return { ok: false, error: `Choose ${q.need}.` };
      if (ids.some((x) => !q.pool.includes(x)) || new Set(ids).size !== ids.length) return { ok: false, error: 'Choose from the cards offered.' };
      d.pending = null;
      if (q.kind === 'surf') {
        const keep = ids[0];
        p.deck.push(keep);
        for (const x of q.pool) if (x !== keep) toDiscard(G, x);
        whenPicked(G, p, keep);
      } else if (ids.length) {
        for (const x of ids) { p.deck.splice(p.deck.indexOf(x), 1); toDiscard(G, x); }
        if (q.kind === 'cut-for-pick') d.extra += 1;
      }
      return { ok: true };
    }
    case 'cut': {
      const ids = Array.isArray(move.cards) ? move.cards : [move.card];
      if (!ids.every((x) => p.deck.includes(x))) return { ok: false, error: 'That card is not in your deck.' };
      if (p.deck.length - ids.length < 1) return { ok: false, error: 'Keep at least one card.' };
      for (const x of ids) { p.deck.splice(p.deck.indexOf(x), 1); toDiscard(G, x); }
      return { ok: true };
    }
    case 'done': {
      if (!d.finalOnly && d.chosen === null) return { ok: false, error: 'Choose a pile first.' };
      for (const x of d.drawn.splice(0)) toDiscard(G, x);
      if (!d.finalOnly && d.options[d.chosen].fans) {
        p.fans += d.options[d.chosen].fans;
        note(G, `${p.name} takes the smaller cards for ${d.options[d.chosen].fans} fans.`);
      }
      p.ready = true;
      if (G.players.every((q) => q.ready)) startMatches(G);
      return { ok: true };
    }
    default:
      return { ok: false, error: 'Unknown move.' };
  }
}

// ---------------------------------------------------------------- matches

function sideFor(G, p, opp) {
  return {
    seat: p.seat,
    deck: shuffle(p.deck.slice()),
    bench: [],            // [{ name, ids, wide }]
    exhaust: [],
    removed: [],
    flag: null,
    under: [],
    attack: [],
    limbo: [],            // cards on their way to the bench
    bonus: {},            // locked power bonuses, card id → n
    atk: {},              // bonuses that last only for this attack
    next: [],             // bonuses waiting for the next card turned over
    trophies: p.trophies.length,
    oppTrophies: opp.trophies.length,
    lostLast: p.lostLast,
    fans: 0,              // taken in this match
  };
}

// who begins: the player holding the Trophy from the latest round; a flag
// toss in round one or on a tie
function firstPlayer(G, a, b) {
  const best = (s) => Math.max(0, ...playerBySeat(G, s).trophies.map((t) => t.round));
  const x = best(a), y = best(b);
  if (x !== y) return x > y ? a : b;
  return Math.random() < 0.5 ? a : b;
}

export function makeMatch(G, a, b, extra = {}) {
  const A = playerBySeat(G, a), B = playerBySeat(G, b);
  const first = firstPlayer(G, a, b);
  const M = {
    id: extra.id ?? G.matches.length,
    round: G.round,
    park: extra.park ?? null,
    final: !!extra.final,
    seats: [a, b],
    sides: { [a]: sideFor(G, A, B), [b]: sideFor(G, B, A) },
    holder: null,
    attacker: null,
    first,
    tasks: [{ t: 'open', seat: first }],
    pending: null,
    over: false,
    winner: null,
    why: '',
    log: [],
    seq: 0,
    reveals: 0,
  };
  return M;
}

function startMatches(G) {
  G.phase = 'match';
  if (G.final) {
    const [a, b] = G.final.seats;
    G.matches = [makeMatch(G, a, b, { id: 0, final: true })];
  } else {
    G.matches = G.schedule[G.round - 1].map(([a, b], k) => makeMatch(G, a, b, { id: k, park: k }));
  }
  for (const p of G.players) p.draft = null;
  note(G, G.final ? 'The final begins.' : `Round ${G.round}: the matches begin.`);
  bump(G, { kind: 'matches', round: G.round });
}

const other = (M, seat) => (M.seats[0] === seat ? M.seats[1] : M.seats[0]);
const mlog = (M, text) => { M.log.push(text); if (M.log.length > 60) M.log.shift(); };

// printed power — except a Cyborg's, which "is equal to the current round"
const basePower = (G, M, id) => { const c = cardOf(G, id); return c.roundPower ? M.round : c.power; };

const benchIds = (S) => S.bench.flatMap((s) => s.ids);
const seatsUsed = (S) => S.bench.reduce((n, s) => n + (s.wide ? 2 : 1), 0);
const emptySeats = (S) => BENCH_SEATS - seatsUsed(S);

// the bonus every card on the bench lends the card in play
function auraFor(G, M, S, c, where) {
  let b = 0;
  const attacking = where === 'attack';
  const holding = where === 'flag';
  for (const x of benchIds(S)) {
    switch (cardOf(G, x).key) {
      case 'blacksmith': if (hasSet(c, 'city')) b += 1; break;
      case 'bard': if (attacking) b += 1; break;
      case 'make-up-artist': if (attacking && c.power === 1) b += 2; break;
      case 'director': if (attacking && hasSet(c, 'film')) b += 1; break;
      case 'vendor': if (hasSet(c, 'funfair')) b += 1; break;
      case 'ai': if (c.power === 2) b += 1; break;
      case 'band': if (hasSet(c, 'space')) b += 1; break;
      case 'cook': if (holding) b += 1; break;
      case 'animateur': if (c.name === 'Newcomer') b += 1; break;
      case 'ice-cream-truck': if (hasSet(c, 'beachclub')) b += 1; break;
      case 'vet': if (attacking && c.power === 3) b += 1; break;
      case 'ice-bob': if (holding && hasSet(c, 'mountain')) b += 1; break;
      case 'coffee-machine': if (attacking && hasSet(c, 'university')) b += 1; break;
      case 'gingerbread-man': if (holding && c.power === 4) b += 1; break;
      default: break;
    }
  }
  return b;
}

// A card's power where it stands now: its base, what it locked in when it was
// turned over, what its own keyword gives it there, and what the bench lends.
export function powerOf(G, M, seat, id) {
  const S = M.sides[seat];
  const c = cardOf(G, id);
  const where = S.flag === id ? 'flag' : S.attack.includes(id) ? 'attack' : null;
  let b = S.bonus[id] || 0;
  if (where === 'attack') {
    b += S.atk[id] || 0;
    if (c.key === 'gangster') b += 2;
    else if (c.key === 'knight') b += S.oppTrophies;
    else if (c.key === 'zombie') b += S.exhaust.length;
    else if (c.key === 'quarterback') b += fansOf(G, M, seat);
  } else if (where === 'flag') {
    if (c.key === 'skeleton') b += 1;
    else if (c.key === 'treasure') b += 2;
    else if (c.key === 'snowman') b += 3;
    else if (c.key === 'illusionist') b += emptySeats(S);
  }
  if (where) b += auraFor(G, M, S, c, where);
  if (c.key === 'streamer') b *= 2;
  return basePower(G, M, id) + b;
}

const fansOf = (G, M, seat) => (M.sim ? M.sim.fans[seat] : playerBySeat(G, seat).fans);

function giveFans(G, M, seat, n, why) {
  if (!n) return;
  M.sides[seat].fans += n;
  if (M.sim) M.sim.fans[seat] += n;
  else playerBySeat(G, seat).fans += n;
  mlog(M, `${nameOf(G, M, seat)} takes ${n} fan${n === 1 ? '' : 's'} (${why}).`);
}

const nameOf = (G, M, seat) => (M.sim ? `P${seat}` : playerBySeat(G, seat).name);

export function attackTotal(G, M, seat) {
  return M.sides[seat].attack.reduce((s, id) => s + powerOf(G, M, seat, id), 0);
}

export function flagPower(G, M) {
  if (M.holder === null) return 0;
  const S = M.sides[M.holder];
  return S.flag === null ? 0 : powerOf(G, M, M.holder, S.flag);
}

function lose(G, M, seat, why) {
  if (M.over) return;
  M.over = true;
  M.winner = other(M, seat);
  M.loser = seat;
  M.why = why;
  M.tasks = [];
  M.pending = null;
  mlog(M, `${nameOf(G, M, seat)} loses: ${why}.`);
}

// ---- moving cards

// A card going to the exhaust pile. The Dwarf never gets there: it climbs
// back on top of its owner's deck instead.
function toExhaust(G, M, seat, id) {
  const S = M.sides[seat];
  if (cardOf(G, id).key === 'dwarf') { S.deck.unshift(id); return; }
  S.exhaust.push(id);
}

function takeFromBench(S, id) {
  for (let i = 0; i < S.bench.length; i++) {
    const k = S.bench[i].ids.indexOf(id);
    if (k >= 0) {
      S.bench[i].ids.splice(k, 1);
      if (!S.bench[i].ids.length) S.bench.splice(i, 1);
      return true;
    }
  }
  return false;
}

// Putting cards on a bench. One seat per name; a new name needs a free seat,
// and a player who has none loses on the spot. Backpacker and Cabbage go to
// the exhaust pile instead, and the Troll needs two seats of its own unless
// another Troll is already sitting there.
function toBench(G, M, seat, ids) {
  const S = M.sides[seat];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    // the match is over, but the cards still belong somewhere
    if (M.over) { S.limbo.push(...ids.slice(i)); return; }
    const c = cardOf(G, id);
    if (c.key === 'backpacker' || c.key === 'cabbage') { toExhaust(G, M, seat, id); continue; }
    const same = S.bench.find((s) => s.name === c.name);
    if (same) { same.ids.push(id); continue; }
    if (c.key === 'troll') {
      if (emptySeats(S) >= 2) { S.bench.push({ name: c.name, ids: [id], wide: true }); continue; }
      S.bench.push({ name: c.name, ids: [id], wide: false, overflow: true });
      S.limbo.push(...ids.slice(i + 1));
      lose(G, M, seat, 'the Troll has no two free seats');
      return;
    }
    if (emptySeats(S) < 1) {
      S.bench.push({ name: c.name, ids: [id], wide: false, overflow: true });
      S.limbo.push(...ids.slice(i + 1));
      lose(G, M, seat, `no free seat on the bench for ${c.name}`);
      return;
    }
    S.bench.push({ name: c.name, ids: [id], wide: false });
  }
}

function removeForGood(G, M, seat, id) {
  M.sides[seat].removed.push(id);
}

function fromPile(G, M, L) {
  return drawPile(G, L);
}

// ---- the task queue

const front = (M, ...tasks) => M.tasks.unshift(...tasks);

function ask(M, seat, q) {
  // a question with nothing to choose from answers itself
  M.pending = { seat, ...q };
}

// turn over the top card of `seat`'s deck into play
function turnOver(G, M, seat) {
  const S = M.sides[seat];
  const id = S.deck.shift();
  S.attack.push(id);
  M.reveals++;
  for (const n of S.next.splice(0)) {
    if (n.attackOnly) S.atk[id] = (S.atk[id] || 0) + n.amount;
    else S.bonus[id] = (S.bonus[id] || 0) + n.amount;
  }
  return id;
}

function runTask(G, M, task) {
  const S = M.sides[task.seat];
  switch (task.t) {
    case 'open': {
      // the first card of the match takes the flag without a fight
      if (!S.deck.length) return lose(G, M, task.seat, 'an empty deck');
      const id = turnOver(G, M, task.seat);
      mlog(M, `${nameOf(G, M, task.seat)} opens with ${cardOf(G, id).name}.`);
      front(M, { t: 'now', seat: task.seat, id }, { t: 'take', seat: task.seat, id, opening: true });
      return;
    }
    case 'reveal': {
      if (!S.deck.length) return lose(G, M, task.seat, 'nothing left to attack with');
      const id = turnOver(G, M, task.seat);
      mlog(M, `${nameOf(G, M, task.seat)} turns over ${cardOf(G, id).name}.`);
      // the Yeti takes a fan for every card that attacks it
      const H = M.sides[M.holder];
      if (H && H.flag !== null && cardOf(G, H.flag).key === 'yeti') giveFans(G, M, M.holder, 1, 'Yeti');
      front(M, { t: 'now', seat: task.seat, id }, { t: 'check', seat: task.seat, id });
      return;
    }
    case 'now':
      return nowEffect(G, M, task.seat, task.id);
    case 'check': {
      // the pause people see: a card turned over, its effect done, the sum made
      if (attackTotal(G, M, task.seat) >= flagPower(G, M)) {
        front(M, { t: 'capture', seat: task.seat, id: task.id });
      } else {
        front(M, { t: 'nowin', seat: task.seat, id: task.id }, { t: 'reveal', seat: task.seat });
      }
      task.visible = true;
      return;
    }
    case 'nowin':
      return noFlagWin(G, M, task.seat, task.id);
    case 'capture': {
      // the flag moves: whatever the losing card does as it loses the flag
      // happens first, then what the winning card does as it takes it, and
      // only then does the loser clear its cards to the bench
      const def = other(M, task.seat);
      const D = M.sides[def];
      const lostCard = D.flag;
      const lost = [lostCard, ...D.under];
      D.flag = null;
      D.under = [];
      const toBenchIds = lost.slice();
      const loss = [];
      if (lostCard !== null) {
        const k = cardOf(G, lostCard).key;
        if (k === 'prince') { toBenchIds.shift(); toExhaust(G, M, def, lostCard); mlog(M, 'The Prince leaves for the exhaust pile.'); }
        else if (k === 'rescue-pod') {
          toBenchIds.shift();
          removeForGood(G, M, def, lostCard);
          const b = fromPile(G, M, 'B');
          if (b !== null) { toExhaust(G, M, def, b); mlog(M, `The Rescue Pod is gone; ${cardOf(G, b).name} arrives on the exhaust pile.`); }
        } else if (k === 'comic-character') D.next.push({ amount: 2, attackOnly: true });
        else if (k === 'clairvoyant') loss.push({ t: 'choice', seat: def, kind: 'deck-to-top', card: 'clairvoyant' });
        else if (k === 'navigator') loss.push({ t: 'choice', seat: def, kind: 'top-two', card: 'navigator' });
      }
      const A = M.sides[task.seat];
      A.under = A.attack.filter((x) => x !== task.id);
      A.attack = [];
      A.flag = task.id;
      A.atk = {};
      M.holder = task.seat;
      M.attacker = def;
      mlog(M, `${cardOf(G, task.id).name} takes the flag.`);
      D.limbo.push(...toBenchIds.filter((x) => x !== null));
      front(M, ...loss, { t: 'take', seat: task.seat, id: task.id }, { t: 'bench', seat: def }, { t: 'swap', seat: def });
      task.visible = true;
      return;
    }
    case 'take': {
      // the moment a card gets in flag possession
      if (task.opening) {
        S.flag = task.id;
        S.attack = [];
        S.atk = {};
        M.holder = task.seat;
        M.attacker = other(M, task.seat);
        front(M, ...gainEffect(G, M, task.seat, task.id), { t: 'reveal', seat: other(M, task.seat) });
        task.visible = true;
        return;
      }
      front(M, ...gainEffect(G, M, task.seat, task.id));
      return;
    }
    case 'bench':
      toBench(G, M, task.seat, S.limbo.splice(0));
      return;
    case 'swap':
      M.attacker = task.seat;
      front(M, { t: 'reveal', seat: task.seat });
      return;
    case 'lose':
      return lose(G, M, task.seat, task.why);
    case 'choice':
      return offerChoice(G, M, task);
    default:
      throw new Error('unknown task ' + task.t);
  }
}

// ---- effects that happen as a card is turned over

function lock(S, id, n) { if (n) S.bonus[id] = (S.bonus[id] || 0) + n; }

function nowEffect(G, M, seat, id) {
  const S = M.sides[seat];
  const opp = other(M, seat);
  const O = M.sides[opp];
  const c = cardOf(G, id);
  const bench = benchIds(S).map((x) => cardOf(G, x));
  switch (c.key) {
    case 'hermit': lock(S, id, bench.some((b) => hasSet(b, 'city')) ? 0 : 2); break;
    case 'jester': lock(S, id, bench.some((b) => b.power === 1) ? 3 : 0); break;
    case 'stable-boy': lock(S, id, bench.filter((b) => b.power === 3).length); break;
    case 'mascot': {
      const icons = new Set();
      const inPlay = [...new Set(['city', G.opts.basic, ...G.opts.sets])];
      for (const b of bench) {
        if (SETS[b.set].allIcons) for (const s of inPlay) icons.add(s);
        else icons.add(b.set);
      }
      lock(S, id, icons.size);
      break;
    }
    case 'teenager': lock(S, id, bench.filter((b) => hasSet(b, 'haunted')).length); break;
    case 'merman': lock(S, id, bench.some((b) => hasSet(b, 'shipwreck')) ? 3 : 0); break;
    case 'mime': lock(S, id, emptySeats(S)); break;
    case 'lifeguard': lock(S, id, S.deck.length <= 1 ? 2 : 0); break;
    case 'kid': lock(S, id, bench.some((b) => b.power >= 4) ? 0 : 4); break;
    case 'climber': lock(S, id, O.exhaust.length ? 2 : 0); break;
    case 'impostor': lock(S, id, new Set(bench.map((b) => b.power)).size); break;
    case 'final-exam': lock(S, id, bench.filter((b) => b.power <= 3).length); break;
    case 'personal-coach': lock(S, id, Math.floor(fansOf(G, M, seat) / 5)); break;
    case 'puppet': lock(S, id, S.attack.length > 1 ? 2 : 0); break;
    case 'pyrotechnician': if (S.deck.length <= 1) giveFans(G, M, seat, 2, 'Pyrotechnician'); break;
    case 'fan-bus': if (S.trophies <= 3) giveFans(G, M, seat, 2, 'Fan-Bus'); break;
    case 'professor': if (bench.some((b) => hasSet(b, 'university'))) giveFans(G, M, seat, 1, 'Professor'); break;
    case 'skater': if (S.lostLast) giveFans(G, M, seat, 2, 'Skater'); break;
    case 'ghost': if (O.deck.length) { const x = O.deck.shift(); toExhaust(G, M, opp, x); mlog(M, `The Ghost sends ${cardOf(G, x).name} to the exhaust pile.`); } break;
    case 'shop-clerk':
      if (bench.some((b) => hasSet(b, 'toystore')) && O.deck.length) { const x = O.deck.shift(); toExhaust(G, M, opp, x); mlog(M, `The Shop Clerk sends ${cardOf(G, x).name} to the exhaust pile.`); }
      break;
    case 'hologram': { const x = fromPile(G, M, 'B'); if (x !== null) { O.deck.unshift(x); mlog(M, 'The Hologram slips a Level-B card on top of the other deck.'); } break; }
    case 'villain': { const x = fromPile(G, M, 'A'); if (x !== null) { S.deck.unshift(x); mlog(M, 'The Villain puts a Level-A card on top of its deck.'); } break; }
    case 'ufo': for (let i = 0; i < 2; i++) { const x = fromPile(G, M, 'A'); if (x !== null) S.deck.push(x); } break;
    case 'thief': { const x = fromPile(G, M, 'A'); if (x !== null) toExhaust(G, M, seat, x); break; }
    case 'sandstorm': { const x = fromPile(G, M, 'C'); if (x !== null) S.deck.unshift(x); break; }
    case 'submarine': if (S.deck.length) toExhaust(G, M, seat, S.deck.pop()); break;
    case 'zeppelin': if (bench.some((b) => b.level === 'C')) front(M, { t: 'lose', seat, why: 'the Zeppelin found a Level-C card on the bench' }); break;
    // effects that ask the owner something
    case 'reporter': front(M, { t: 'choice', seat, kind: 'top-two', card: c.key }); break;
    case 'juggler':
    case 'bumper-car': front(M, { t: 'choice', seat, kind: 'order-top', card: c.key, n: 3 }); break;
    case 'sailor': front(M, { t: 'choice', seat, kind: 'deck-to-bottom', card: c.key }); break;
    case 'tutor': front(M, { t: 'choice', seat, kind: 'deck-to-top', card: c.key }); break;
    case 'dj':
    case 'dog-look': front(M, { t: 'choice', seat, kind: 'top-or-under', card: c.key, end: 'top' }); break;
    case 'diver': front(M, { t: 'choice', seat, kind: 'top-or-under', card: c.key, end: 'bottom' }); break;
    case 'hacker': front(M, { t: 'choice', seat, kind: 'hacker', card: c.key }); break;
    case 'movie-star': front(M, { t: 'choice', seat, kind: 'bench-to-top', card: c.key, max: 2, min: 0, filter: 'newcomer' }); break;
    case 'necromancer': front(M, { t: 'choice', seat, kind: 'bench-to-top', card: c.key, max: 1, min: 1, filter: 'power2' }); break;
    case 'vampire': front(M, { t: 'choice', seat, kind: 'bench-to-top', card: c.key, max: 1, min: 1, filter: 'levelB' }); break;
    case 'scientist': front(M, { t: 'choice', seat, kind: 'bench-to-top', card: c.key, max: 1, min: 1, filter: 'levelA' }); break;
    case 'butler':
    case 'vacuum-cleaner': front(M, { t: 'choice', seat, kind: 'bench-to-exhaust', card: c.key, max: 2, min: 0 }); break;
    case 'getaway-vehicle': front(M, { t: 'choice', seat, kind: 'bench-to-exhaust', card: c.key, max: 2, min: 0, filter: 'secret' }); break;
    case 'sorcerer': front(M, { t: 'choice', seat, kind: 'bench-to-exhaust', card: c.key, max: 1, min: 0, filter: 'power3down' }); break;
    case 'janitor': front(M, { t: 'choice', seat, kind: 'bench-to-exhaust', card: c.key, max: 1, min: 0, filter: 'lowest' }); break;
    case 'siren': front(M, { t: 'choice', seat, kind: 'opp-bench-to-exhaust', card: c.key, max: 1, min: 0 }); break;
    case 'skier': front(M, { t: 'choice', seat, kind: 'opp-bench-to-exhaust', card: c.key, max: 1, min: 1 }); break;
    case 'safecracker': front(M, { t: 'choice', seat, kind: 'exhaust-to-bottom', card: c.key }); break;
    case 'swimmer': front(M, { t: 'choice', seat, kind: 'seat-bonus', card: c.key, id }); break;
    case 'fairy':
    case 'carriage': front(M, { t: 'choice', seat, kind: 'seat-to-exhaust', card: c.key }); break;
    case 'wind-up-car': front(M, { t: 'choice', seat, kind: 'bench-remove', card: c.key, max: 1, min: 0, id }); break;
    case 'cauldron': front(M, { t: 'choice', seat, kind: 'bench-remove', card: c.key, max: 1, min: 1, filter: 'levelA' }); break;
    default: break;
  }
}

// ...as it takes the flag ("If this card gets in flag possession")
function gainEffect(G, M, seat, id) {
  const c = cardOf(G, id);
  const opp = other(M, seat);
  if (c.key === 'clown') giveFans(G, M, seat, 2, 'Clown');
  else if (c.key === 'heroine') giveFans(G, M, seat, 3, 'Heroine');
  else if (c.key === 'cowboy') {
    const O = M.sides[opp];
    if (O.deck.length) {
      const x = O.deck.shift();
      mlog(M, `The Cowboy ropes ${cardOf(G, x).name} onto the bench.`);
      O.limbo.push(x);
      return [{ t: 'bench', seat: opp }];
    }
  }
  return [];
}

// ...and when turning it over did not take the flag (Beach Cup)
function noFlagWin(G, M, seat, id) {
  const S = M.sides[seat];
  const c = cardOf(G, id);
  switch (c.key) {
    case 'yodeler': giveFans(G, M, seat, 1, 'Yodeler'); break;
    case 'action-figure': S.next.push({ amount: 2 }); break;
    case 'game-collector': S.next.push({ amount: 6 }); break;
    case 'karaoke-kit': { const x = fromPile(G, M, 'B'); if (x !== null) S.deck.push(x); break; }
    case 'model-railway': front(M, { t: 'choice', seat, kind: 'bench-to-top', card: c.key, max: 1, min: 1, filter: 'levelA' }); break;
    case 'mirror': front(M, { t: 'choice', seat, kind: 'bench-to-top', card: c.key, max: 1, min: 1, filter: 'forest' }); break;
    default: break;
  }
}

// ---- choices

const FILTER = {
  newcomer: (c) => c.name === 'Newcomer',
  power2: (c) => c.power === 2,
  power3down: (c) => c.power <= 3,
  levelA: (c) => c.level === 'A',
  levelB: (c) => c.level === 'B',
  secret: (c) => hasSet(c, 'secret'),
  forest: (c) => hasSet(c, 'forest'),
};

// Build the question a choice task asks: what can be chosen, how many, and
// what the answer means. A question with no possible answer is skipped, and
// one whose only answer is forced is answered for the player.
function offerChoice(G, M, task) {
  const S = M.sides[task.seat];
  const O = M.sides[other(M, task.seat)];
  const q = { kind: task.kind, card: task.card, task };
  switch (task.kind) {
    case 'top-two': {
      q.ids = S.deck.slice(0, 2);
      if (q.ids.length < 2) return;
      q.prompt = `${CARD[task.card].name}: pick the card to put under your deck — the other stays on top.`;
      q.min = 1; q.max = 1;
      break;
    }
    case 'order-top': {
      q.ids = S.deck.slice(0, task.n);
      if (q.ids.length < 2) return;
      q.prompt = `${CARD[task.card].name}: put your top ${q.ids.length} cards in the order you want them, first one on top.`;
      q.order = true;
      break;
    }
    case 'deck-to-top':
    case 'deck-to-bottom': {
      q.ids = S.deck.slice();
      if (q.ids.length < 2) return;
      q.prompt = task.kind === 'deck-to-top'
        ? `${CARD[task.card].name}: choose any card of your deck to put on top.`
        : `${CARD[task.card].name}: choose any card of your deck to put under it.`;
      q.min = 1; q.max = 1;
      break;
    }
    case 'top-or-under': {
      const id = task.end === 'top' ? S.deck[0] : S.deck[S.deck.length - 1];
      if (id === undefined) return;
      q.ids = [id];
      q.prompt = task.end === 'top'
        ? `${CARD[task.card].name}: your top card is ${cardOf(G, id).name}. Leave it on top, or put it under your deck?`
        : `${CARD[task.card].name}: your bottom card is ${cardOf(G, id).name}. Put it on top, or leave it under your deck?`;
      q.options = ['top', 'under'];
      break;
    }
    case 'hacker': {
      q.ids = S.deck.slice(0, 3);
      if (!q.ids.length) return;
      q.prompt = 'Hacker: of your top cards, choose one for under your deck, one for the top, one for your exhaust pile.';
      q.assign = ['under', 'top', 'exhaust'].slice(0, Math.max(1, q.ids.length));
      break;
    }
    case 'bench-to-top':
    case 'bench-to-exhaust':
    case 'bench-remove': {
      let pool = benchIds(S);
      const f = task.filter && FILTER[task.filter];
      if (f) pool = pool.filter((x) => f(cardOf(G, x)));
      if (task.filter === 'lowest' && pool.length) {
        const low = Math.min(...pool.map((x) => cardOf(G, x).power));
        pool = pool.filter((x) => cardOf(G, x).power === low);
      }
      if (!pool.length) return;
      q.ids = pool;
      q.min = Math.min(task.min, pool.length);
      q.max = Math.min(task.max, pool.length);
      const where = task.kind === 'bench-to-top' ? 'on top of your deck' : task.kind === 'bench-remove' ? 'out of your deck for good' : 'on your exhaust pile';
      q.prompt = `${CARD[task.card].name}: ${q.min === 0 ? 'you may ' : ''}choose ${q.max === 1 ? 'a card' : `up to ${q.max} cards`} from your bench to put ${where}.`;
      break;
    }
    case 'opp-bench-to-exhaust': {
      const pool = benchIds(O);
      if (!pool.length) return;
      q.ids = pool;
      q.min = Math.min(task.min, 1);
      q.max = 1;
      q.prompt = `${CARD[task.card].name}: ${q.min === 0 ? 'you may ' : ''}choose a card from your opponent’s bench to put on their exhaust pile.`;
      break;
    }
    case 'exhaust-to-bottom': {
      const pool = S.exhaust.slice();
      if (!pool.length) return;
      q.ids = pool;
      q.min = 1; q.max = 1;
      q.prompt = 'Safecracker: choose a card from your exhaust pile to put under your deck.';
      break;
    }
    case 'seat-bonus':
    case 'seat-to-exhaust': {
      if (!S.bench.length) return;
      q.seats = S.bench.map((s, i) => i);
      q.prompt = task.kind === 'seat-bonus'
        ? 'Swimmer: choose a seat of your bench — +1 for each card on it.'
        : `${CARD[task.card].name}: choose a seat of your bench to clear onto your exhaust pile.`;
      break;
    }
    default: throw new Error('unknown choice ' + task.kind);
  }
  // forced: exactly one legal answer
  if (q.ids && !q.order && !q.options && !q.assign && q.min === q.max && q.ids.length === q.min) {
    return resolveChoice(G, M, task.seat, q, { ids: q.ids.slice() });
  }
  M.pending = { seat: task.seat, ...q };
}

function validChoice(G, M, q, ans) {
  if (!ans || typeof ans !== 'object') return 'No answer.';
  if (q.order) {
    const ids = ans.ids || [];
    if (ids.length !== q.ids.length || ids.some((x) => !q.ids.includes(x)) || new Set(ids).size !== ids.length) return 'Order all of the cards.';
    return null;
  }
  if (q.options) return q.options.includes(ans.option) ? null : 'Choose one of the options.';
  if (q.assign) {
    const ids = ans.ids || [];
    if (ids.length !== q.ids.length || ids.some((x) => !q.ids.includes(x)) || new Set(ids).size !== ids.length) return 'Place every card.';
    return null;
  }
  if (q.seats) return q.seats.includes(Number(ans.seat)) ? null : 'Choose a seat.';
  const ids = ans.ids || [];
  if (ids.length < q.min || ids.length > q.max) return q.min === q.max ? `Choose ${q.min}.` : `Choose ${q.min} to ${q.max}.`;
  if (ids.some((x) => !q.ids.includes(x)) || new Set(ids).size !== ids.length) return 'Choose from the cards offered.';
  return null;
}

function resolveChoice(G, M, seat, q, ans) {
  const S = M.sides[seat];
  const opp = other(M, seat);
  const O = M.sides[opp];
  const task = q.task;
  M.pending = null;
  switch (task.kind) {
    case 'top-two': {
      const under = ans.ids[0];
      const top = q.ids.find((x) => x !== under);
      S.deck.splice(0, 2);
      S.deck.unshift(top);
      S.deck.push(under);
      break;
    }
    case 'order-top':
      S.deck.splice(0, q.ids.length, ...ans.ids);
      break;
    case 'deck-to-top':
    case 'deck-to-bottom': {
      const id = ans.ids[0];
      S.deck.splice(S.deck.indexOf(id), 1);
      if (task.kind === 'deck-to-top') S.deck.unshift(id); else S.deck.push(id);
      break;
    }
    case 'top-or-under': {
      const id = q.ids[0];
      S.deck.splice(S.deck.indexOf(id), 1);
      if (ans.option === 'top') S.deck.unshift(id); else S.deck.push(id);
      break;
    }
    case 'hacker': {
      // ans.ids lists the cards in q.assign order: under, top, exhaust
      S.deck.splice(0, q.ids.length);
      const dest = {};
      q.assign.forEach((where, i) => { dest[where] = ans.ids[i]; });
      if (dest.top !== undefined) S.deck.unshift(dest.top);
      if (dest.under !== undefined) S.deck.push(dest.under);
      if (dest.exhaust !== undefined) toExhaust(G, M, seat, dest.exhaust);
      break;
    }
    case 'bench-to-top':
      for (const id of ans.ids) { takeFromBench(S, id); S.deck.unshift(id); }
      break;
    case 'bench-to-exhaust':
      for (const id of ans.ids) { takeFromBench(S, id); toExhaust(G, M, seat, id); }
      break;
    case 'bench-remove':
      for (const id of ans.ids) { takeFromBench(S, id); removeForGood(G, M, seat, id); }
      if (task.card === 'wind-up-car' && ans.ids.length) lock(S, task.id, 4);
      break;
    case 'opp-bench-to-exhaust':
      for (const id of ans.ids) { takeFromBench(O, id); toExhaust(G, M, opp, id); }
      break;
    case 'exhaust-to-bottom': {
      const id = ans.ids[0];
      S.exhaust.splice(S.exhaust.indexOf(id), 1);
      S.deck.push(id);
      break;
    }
    case 'seat-bonus': {
      const s = S.bench[Number(ans.seat)];
      lock(S, task.id, s ? s.ids.length : 0);
      break;
    }
    case 'seat-to-exhaust': {
      const s = S.bench[Number(ans.seat)];
      if (s) {
        S.bench.splice(Number(ans.seat), 1);
        for (const id of s.ids) toExhaust(G, M, seat, id);
      }
      break;
    }
    default: break;
  }
  M.seq++;
}

// ---------------------------------------------------------------- running a match

// Advance a match to its next visible moment: a card turned over, a question
// asked, or the end. The host calls this on a timer so people can follow.
export function stepMatch(G, M) {
  let guard = 0;
  while (!M.over && !M.pending && M.tasks.length) {
    if (++guard > 500) throw new Error('match loop');
    const task = M.tasks.shift();
    runTask(G, M, task);
    if (task.visible) { M.seq++; break; }
  }
  if (!M.over && !M.pending && !M.tasks.length) front(M, { t: 'reveal', seat: M.attacker });
  return M;
}

export function answerMatch(G, M, seat, ans) {
  const q = M.pending;
  if (!q || q.seat !== seat) return { ok: false, error: 'Nothing is being asked of you.' };
  const why = validChoice(G, M, q, ans);
  if (why) return { ok: false, error: why };
  resolveChoice(G, M, seat, q, ans);
  return { ok: true };
}

// ---------------------------------------------------------------- ending matches and rounds

// every card a player owns after a match comes back to their deck — bench,
// park, exhaust pile, the lot — except the ones taken out for good
function collect(G, M, seat) {
  const S = M.sides[seat];
  const all = [...S.deck, ...benchIds(S), ...S.exhaust, ...S.attack, ...S.under, ...S.limbo];
  if (S.flag !== null) all.push(S.flag);
  for (const id of S.removed) toDiscard(G, id);
  return all;
}

export function finishMatch(G, M) {
  if (!M.over || M.done) return;
  M.done = true;
  for (const seat of M.seats) {
    const p = playerBySeat(G, seat);
    p.deck = collect(G, M, seat);
    p.lostLast = seat === M.loser;
  }
  const w = playerBySeat(G, M.winner);
  // "If the Robot wins the match, place the Trophy of the current round back
  // into the box" — unless it is the solo game, where it keeps them
  const boxed = w.robot && !isSolo(G);
  if (!M.final && !boxed) {
    const fans = G.parks[M.park][G.round - 1];
    w.trophies.push({ round: G.round, fans });
  }
  G.history.push({ round: G.round, final: M.final, seats: M.seats.slice(), winner: M.winner, why: M.why });
  note(G, `${w.name} beats ${playerBySeat(G, M.loser).name}${M.final ? ' in the final' : ''} — ${M.why}${boxed ? '; the Trophy goes back in the box' : ''}.`);
}

export function totalFans(p) {
  return p.fans + p.trophies.reduce((s, t) => s + t.fans, 0);
}

// most fans, then most Trophies, then the Trophy from the latest round —
// among the players who are ranked, which leaves out a Robot standing in
export function standings(G) {
  return ranked(G).sort((a, b) =>
    totalFans(b) - totalFans(a)
    || b.trophies.length - a.trophies.length
    || Math.max(0, ...b.trophies.map((t) => t.round)) - Math.max(0, ...a.trophies.map((t) => t.round)));
}

function endGame(G, winnerSeat, why) {
  G.phase = 'over';
  G.winner = winnerSeat;
  G.result = {
    why,
    ranked: standings(G).map((p) => ({ seat: p.seat, name: p.name, fans: totalFans(p), tokens: p.fans, trophies: p.trophies.slice() })),
  };
  note(G, `${playerBySeat(G, winnerSeat).name} wins Challengers! — ${why}.`);
  bump(G, { kind: 'over', winner: winnerSeat });
}

// once every match of the round is over, the tournament moves on
export function afterMatches(G) {
  if (G.phase !== 'match' || G.matches.some((M) => !M.over)) return false;
  for (const M of G.matches) finishMatch(G, M);
  if (G.final) {
    const M = G.matches[0];
    endGame(G, M.winner, 'won the final');
    return true;
  }
  const two = G.players.length === 2;
  if (two) {
    const [a, b] = G.players;
    const lead = totalFans(a) - totalFans(b);
    if (Math.abs(lead) >= LEAD_WIN) {
      endGame(G, lead > 0 ? a.seat : b.seat, `a lead of ${Math.abs(lead)} fans`);
      return true;
    }
  }
  if (G.round >= ROUNDS) {
    const top = standings(G);
    if (two) endGame(G, top[0].seat, 'the most fans after seven rounds');
    else startFinalDeck(G, top[0].seat, top[1].seat);
    return true;
  }
  G.round++;
  startDeckPhase(G);
  return true;
}

// ---------------------------------------------------------------- moves

export function applyMove(G, seat, move) {
  const p = playerBySeat(G, seat);
  if (!p) return { ok: false, error: 'No such player.' };
  if (!move || typeof move !== 'object') return { ok: false, error: 'No move.' };
  if (G.phase === 'deck' || G.phase === 'final-deck') {
    const res = deckMove(G, p, move);
    if (res.ok && G.phase === 'final-deck' && G.players.every((q) => q.ready)) startMatches(G);
    return res;
  }
  if (G.phase === 'match') {
    if (move.kind !== 'answer') return { ok: false, error: 'The matches are playing.' };
    const M = G.matches.find((m) => m.pending && m.pending.seat === seat);
    if (!M) return { ok: false, error: 'Nothing is being asked of you.' };
    return answerMatch(G, M, seat, move);
  }
  return { ok: false, error: 'The game is over.' };
}

// who the game is waiting on right now
export function waitingOn(G) {
  if (G.phase === 'deck' || G.phase === 'final-deck') return G.players.filter((p) => !p.ready).map((p) => p.seat);
  if (G.phase === 'match') return G.matches.filter((M) => M.pending).map((M) => M.pending.seat);
  return [];
}

// ---------------------------------------------------------------- disconnection

export function markDisconnected(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p || p.bot) return false;
  p.connected = false;
  return true;
}

export function markReconnected(G, seat) {
  const p = playerBySeat(G, seat);
  if (p) { p.connected = true; p.botFor = false; }
}

export function markBotTakeover(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p || p.bot || p.connected) return false;
  p.botFor = true;
  note(G, `A bot takes over for ${p.name}.`);
  return true;
}

export function markSeatClaimed(G, seat, name) {
  const p = playerBySeat(G, seat);
  if (!p) return;
  p.name = name;
  p.connected = true;
  p.botFor = false;
  p.resigned = false;
}

export function markSeatResigned(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p) return;
  p.connected = false;
  p.resigned = true;
}

// ---------------------------------------------------------------- views

const face = (G, id) => ({ id, key: G.cards[id].key });

function sideView(G, M, seat, viewer) {
  const S = M.sides[seat];
  return {
    seat,
    deck: S.deck.length,
    bench: S.bench.map((s) => ({ name: s.name, wide: !!s.wide, overflow: !!s.overflow, cards: s.ids.map((id) => face(G, id)) })),
    exhaust: S.exhaust.map((id) => face(G, id)),
    flag: S.flag === null ? null : { ...face(G, S.flag), power: powerOf(G, M, seat, S.flag) },
    under: S.under.map((id) => face(G, id)),
    limbo: S.limbo.map((id) => face(G, id)),
    attack: S.attack.map((id) => ({ ...face(G, id), power: powerOf(G, M, seat, id) })),
    fans: S.fans,
    next: S.next.reduce((n, x) => n + x.amount, 0),
    empty: emptySeats(S),
  };
}

// Everything in a match is public except the order of the decks — which the
// player an effect lets look gets to see, in the question it asks them.
export function matchView(G, M, viewer) {
  const q = M.pending;
  let pending = null;
  if (q) {
    pending = { seat: q.seat };
    if (q.seat === viewer) {
      pending = {
        seat: q.seat, kind: q.kind, card: q.card, prompt: q.prompt,
        ids: q.ids ? q.ids.map((id) => face(G, id)) : null,
        min: q.min, max: q.max, order: !!q.order, options: q.options || null,
        assign: q.assign || null, seats: q.seats || null,
      };
    }
  }
  return {
    id: M.id, final: M.final, park: M.park, round: M.round,
    seats: M.seats.slice(),
    sides: Object.fromEntries(M.seats.map((s) => [s, sideView(G, M, s, viewer)])),
    holder: M.holder, attacker: M.attacker, first: M.first,
    attackTotal: M.attacker === null ? 0 : attackTotal(G, M, M.attacker),
    flagPower: flagPower(G, M),
    over: M.over, winner: M.winner, why: M.why,
    pending, seq: M.seq, reveals: M.reveals,
    log: M.log.slice(-14),
  };
}

export function viewFor(G, seat, code, opts = {}) {
  const me = playerBySeat(G, seat);
  const two = G.players.length === 2;
  const d = me && me.draft;
  return {
    code, mid: G.mid, you: seat,
    phase: G.phase, round: G.round, rounds: ROUNDS,
    opts: G.opts,
    plan: DRAFT[G.opts.box],
    players: G.players.map((p) => {
      // Trophies keep their fans hidden from everyone else — until the final,
      // and always at a table of two, where the totals are the whole game
      const open = two || p.seat === seat || G.phase === 'over' || G.phase === 'final-deck' || !!G.final;
      return {
        seat: p.seat, name: p.name, bot: p.bot, robot: !!p.robot, connected: p.connected, botFor: !!p.botFor, resigned: !!p.resigned,
        fans: p.fans,
        trophies: p.trophies.map((t) => (open ? { ...t } : { round: t.round })),
        total: open || !p.trophies.length ? totalFans(p) : null,
        ready: p.ready,
        deckSize: p.deck.length,
        opponent: opponentOf(G, p.seat),
      };
    }),
    deck: me ? me.deck.map((id) => face(G, id)) : [],
    draft: d ? {
      options: d.options, chosen: d.chosen, finalOnly: !!d.finalOnly,
      drawn: d.drawn.map((id) => face(G, id)),
      picks: d.picks, allowed: picksAllowed(d), redrawn: d.redrawn, fans: d.fans,
      pending: d.pending ? { kind: d.pending.kind, card: d.pending.card, need: d.pending.need, optional: d.pending.optional, pool: d.pending.pool.map((id) => face(G, id)) } : null,
    } : null,
    piles: { A: G.piles.A.length, B: G.piles.B.length, C: G.piles.C.length },
    matches: G.matches.map((M) => matchView(G, M, seat)),
    final: G.final,
    history: G.history.slice(),
    log: G.log.slice(-25),
    fx: G.fx,
    result: G.result,
    winner: G.winner,
    revealBots: opts.revealBots ? G.players.filter((p) => p.bot && p.seat !== seat).map((p) => ({ seat: p.seat, deck: p.deck.map((id) => face(G, id)) })) : null,
  };
}

// who a player meets this round (or next, during the Deck Phase)
function opponentOf(G, seat) {
  if (G.final) return G.final.seats.includes(seat) ? G.final.seats.find((s) => s !== seat) : null;
  const pairs = G.schedule[G.round - 1] || [];
  const pair = pairs.find((pr) => pr.includes(seat));
  return pair ? pair.find((s) => s !== seat) : null;
}

// ---------------------------------------------------------------- simulation

// A whole match played out in memory, every choice answered by the bot, to
// tell a bot what a deck is worth. It draws from its own shuffled copy of the
// Level piles, so it neither peeks at nor disturbs the real ones.
function simWorld(G) {
  return {
    cards: G.cards,
    opts: G.opts,
    piles: { A: shuffle(G.piles.A.slice()), B: shuffle(G.piles.B.slice()), C: shuffle(G.piles.C.slice()) },
    discard: { A: [], B: [], C: [] },
    players: [],
    matches: [],
    round: G.round,
    sim: true,
  };
}

export function simulate(G, deckA, deckB, info = {}) {
  const W = info.world || simWorld(G);
  W.players = [
    { seat: 0, name: 'A', deck: deckA, trophies: info.trophiesA || [], lostLast: false, fans: info.fansA || 0 },
    { seat: 1, name: 'B', deck: deckB, trophies: info.trophiesB || [], lostLast: false, fans: info.fansB || 0 },
  ];
  const M = makeMatch(W, 0, 1, { id: 0 });
  M.sim = { fans: { 0: info.fansA || 0, 1: info.fansB || 0 } };
  let guard = 0;
  while (!M.over) {
    if (++guard > 400) break;
    stepMatch(W, M);
    if (M.pending) resolveChoice(W, M, M.pending.seat, M.pending, autoAnswer(W, M, M.pending));
  }
  return M.over ? M.winner : null;
}

// ---------------------------------------------------------------- bots

// Two drafters. Quick goes by instinct; Steady plays out practice matches
// in its head — against benchmark decks, never anyone's real one — before
// every pick and every cut. A match only takes a few hundredths of a
// millisecond to simulate, so Steady can afford a couple of hundred.
export const BOT_LEVELS = {
  quick: { label: 'Quick', trials: 0, blurb: 'Drafts by instinct: the strongest card, or a second copy of one it already has.' },
  steady: { label: 'Steady', trials: 160, blurb: 'Plays out a few hundred practice matches in its head before every pick and every cut.' },
};
export const DEFAULT_LEVEL = 'steady';

const pw = (G, id) => { const c = cardOf(G, id); return c.roundPower ? G.round : c.power; };

// what a bench card is worth leaving where it is: the cards that lend power
const AURA = new Set(['blacksmith', 'bard', 'make-up-artist', 'director', 'vendor', 'ai', 'band', 'cook', 'animateur', 'ice-cream-truck', 'vet', 'ice-bob', 'coffee-machine', 'gingerbread-man']);

// The bot's answer to anything a match asks. Simple, local rules — strongest
// card on top, weakest underneath, never free a seat on the other bench.
export function autoAnswer(G, M, q) {
  const S = M.sides[q.seat];
  const O = M.sides[other(M, q.seat)];
  const byPower = (ids, dir = -1) => ids.slice().sort((a, b) => dir * (pw(G, a) - pw(G, b)));
  const seatSize = (side, id) => { const s = side.bench.find((x) => x.ids.includes(id)); return s ? s.ids.length : 0; };
  switch (q.kind) {
    case 'top-two': return { ids: [byPower(q.ids, 1)[0]] };
    case 'order-top': return { ids: byPower(q.ids) };
    case 'deck-to-top': return { ids: [byPower(q.ids)[0]] };
    case 'deck-to-bottom': return { ids: [byPower(q.ids, 1)[0]] };
    case 'top-or-under': {
      const id = q.ids[0];
      const avg = S.deck.reduce((s, x) => s + pw(G, x), 0) / Math.max(1, S.deck.length);
      return { option: pw(G, id) >= avg ? 'top' : 'under' };
    }
    case 'hacker': {
      // the strongest on top, the weakest on the exhaust pile
      const sorted = byPower(q.ids);
      const out = { under: sorted[1], top: sorted[0], exhaust: sorted[2] };
      if (q.ids.length === 2) { out.under = sorted[1]; delete out.exhaust; }
      if (q.ids.length === 1) return { ids: q.ids.slice() };
      return { ids: q.assign.map((w) => out[w]).filter((x) => x !== undefined) };
    }
    case 'bench-to-top': return { ids: byPower(q.ids).slice(0, q.max) };
    case 'bench-to-exhaust': {
      // clear seats: cards alone on their seat first, and never an aura
      const pool = q.ids.filter((id) => !AURA.has(cardOf(G, id).key));
      pool.sort((a, b) => seatSize(S, a) - seatSize(S, b));
      return { ids: pool.slice(0, q.max).length >= q.min ? pool.slice(0, q.max) : q.ids.slice(0, q.min) };
    }
    case 'bench-remove': {
      const weak = q.ids.filter((id) => pw(G, id) <= 2 && !AURA.has(cardOf(G, id).key));
      if (q.min === 0) return { ids: weak.length ? [byPower(weak, 1)[0]] : [] };
      return { ids: [byPower(q.ids, 1)[0]] };
    }
    case 'opp-bench-to-exhaust': {
      const aura = q.ids.filter((id) => AURA.has(cardOf(G, id).key));
      if (aura.length) return { ids: [aura[0]] };
      if (q.min === 0) return { ids: [] };
      // forced: take one from a crowded seat, so no seat comes free
      const crowded = q.ids.slice().sort((a, b) => seatSize(O, b) - seatSize(O, a));
      return { ids: [crowded[0]] };
    }
    case 'exhaust-to-bottom': return { ids: [byPower(q.ids)[0]] };
    case 'seat-bonus': {
      let best = 0;
      S.bench.forEach((s, i) => { if (s.ids.length > S.bench[best].ids.length) best = i; });
      return { seat: best };
    }
    case 'seat-to-exhaust': {
      // clear the seat that lends nothing
      let best = 0, score = -Infinity;
      S.bench.forEach((s, i) => {
        const v = -s.ids.filter((id) => AURA.has(cardOf(G, id).key)).length * 10 + (s.wide ? 3 : 0);
        if (v > score) { score = v; best = i; }
      });
      return { seat: best };
    }
    default: return {};
  }
}

// Benchmark decks: what an opponent at this point of the tournament might be
// holding, drafted at random from the sets in play — never anyone's real deck.
function benchmarks(G, n = 4) {
  const key = `${G.mid}:${G.round}`;
  G.bots = G.bots || {};
  if (G.bots.key === key) return G.bots.bench;
  const pool = { A: [], B: [], C: [] };
  for (const c of CARDS) {
    if (c.level === 'S') continue;
    if (c.set !== G.opts.basic && !G.opts.sets.includes(c.set)) continue;
    for (let i = 0; i < c.copies; i++) pool[c.level].push(c.key);
  }
  const plan = DRAFT[G.opts.box];
  const bench = [];
  for (let k = 0; k < n; k++) {
    const keys = STARTER[G.opts.box].slice();
    for (let r = 0; r < G.round - 1; r++) {
      const o = plan[r][plan[r].length - 1];
      // a lukewarm drafter: the best-powered of the five, each time
      const five = shuffle(pool[o.level].slice()).slice(0, DRAW);
      five.sort((a, b) => CARD[b].power - CARD[a].power);
      keys.push(...five.slice(0, o.pick));
      // and cutting a Newcomer or two once the deck fills out
      if (r >= 1 && keys.includes('newcomer')) keys.splice(keys.indexOf('newcomer'), 1);
    }
    bench.push(keys);
  }
  G.bots = { key, bench, ids: {} };
  return bench;
}

// the benchmark decks need card ids to be simulated; they borrow fresh ones
// from a private card table the simulations use
function simDeck(G, keys, W) {
  return keys.map((k) => { W.cards.push({ id: W.cards.length, key: k }); return W.cards.length - 1; });
}

// How often `keys` beats the benchmark field, played out `trials` times.
export function deckStrength(G, keys, trials = 24) {
  const bench = benchmarks(G);
  let wins = 0, games = 0;
  for (let t = 0; t < trials; t++) {
    const W = simWorld(G);
    W.cards = G.cards.slice();
    const opp = bench[t % bench.length];
    const a = simDeck(G, keys, W);
    const b = simDeck(G, opp, W);
    const w = simulate(G, a, b, { world: W });
    if (w === 0) wins++;
    games++;
  }
  return wins / Math.max(1, games);
}

const keysOf = (G, ids) => ids.map((id) => G.cards[id].key);

// A quick drafter, for tests and for the lowest bot level: the card that
// matches something already in the deck, else the strongest.
function quickPickValue(G, deck, id) {
  const c = cardOf(G, id);
  const names = new Set(deck.map((k) => CARD[k].name));
  return c.power + (names.has(c.name) ? 2 : 0) - (names.size >= 6 && !names.has(c.name) ? 2 : 0);
}

export function botChoose(G, seat, opts = {}) {
  const lvl = BOT_LEVELS[opts.level] || BOT_LEVELS[DEFAULT_LEVEL];
  const quick = !lvl.trials;
  const T = lvl.trials;
  const p = playerBySeat(G, seat);
  if (!p) return null;
  if (G.phase === 'match') {
    const M = G.matches.find((m) => m.pending && m.pending.seat === seat);
    if (!M) return null;
    return { kind: 'answer', ...autoAnswer(G, M, M.pending) };
  }
  if (G.phase !== 'deck' && G.phase !== 'final-deck') return null;
  const d = p.draft;
  if (!d || p.ready) return null;
  const deck = keysOf(G, p.deck);

  if (d.pending) {
    const q = d.pending;
    if (q.kind === 'surf') {
      const best = q.pool.slice().sort((a, b) => pw(G, b) - pw(G, a))[0];
      return { kind: 'answer', cards: [best] };
    }
    // cut the weakest cards the question allows; skip an optional cut that
    // would take anything worth keeping
    const weakest = q.pool.slice().sort((a, b) => pw(G, a) - pw(G, b)).slice(0, q.need);
    if (q.optional && weakest.some((x) => pw(G, x) > 2) && !(q.kind === 'cut-for-pick' && d.drawn.length)) return { kind: 'answer', cards: [] };
    return { kind: 'answer', cards: weakest };
  }

  if (!d.finalOnly && d.chosen === null) {
    // choose the pile by what a typical draw from it adds
    let best = 0, bestScore = -Infinity;
    d.options.forEach((o, i) => {
      const sample = CARDS.filter((c) => c.level === o.level && (c.set === G.opts.basic || G.opts.sets.includes(c.set)));
      const avg = sample.reduce((s, c) => s + c.power * c.copies, 0) / Math.max(1, sample.reduce((s, c) => s + c.copies, 0));
      const score = avg * o.pick + (o.fans || 0) * 0.6;
      if (score > bestScore) { bestScore = score; best = i; }
    });
    return { kind: 'option', option: best };
  }

  if (!d.finalOnly && d.picks < picksAllowed(d) && d.drawn.length && quick) {
    const best = d.drawn.slice().sort((a, b) => quickPickValue(G, deck, b) - quickPickValue(G, deck, a))[0];
    return { kind: 'pick', card: best };
  }
  if (quick) {
    const newcomer = p.deck.find((id) => G.cards[id].key === 'newcomer');
    if (newcomer !== undefined && G.round >= 3 && p.deck.length > 8) return { kind: 'cut', cards: [newcomer] };
    return { kind: 'done' };
  }

  if (!d.finalOnly && d.picks < picksAllowed(d) && d.drawn.length) {
    const base = deckStrength(G, deck, T);
    let bestId = null, bestV = base + 0.02;
    for (const id of d.drawn) {
      const v = deckStrength(G, [...deck, G.cards[id].key], T);
      if (v > bestV) { bestV = v; bestId = id; }
    }
    if (bestId !== null) return { kind: 'pick', card: bestId };
    if (!d.redrawn && d.picks === 0) return { kind: 'redraw' };
  }

  // cut: the starter cards and anything that makes the deck worse
  const cuts = [];
  for (const id of p.deck) {
    const k = G.cards[id].key;
    if (cardOf(G, id).level !== 'S' && pw(G, id) > 2) continue;
    if (cuts.some((x) => G.cards[x].key === k)) continue;
    cuts.push(id);
  }
  if (cuts.length && p.deck.length > 6) {
    const base = deckStrength(G, deck, T);
    let bestId = null, bestV = base + 0.04;
    for (const id of cuts) {
      const rest = deck.slice();
      rest.splice(rest.indexOf(G.cards[id].key), 1);
      const v = deckStrength(G, rest, T);
      if (v > bestV) { bestV = v; bestId = id; }
    }
    if (bestId !== null) return { kind: 'cut', cards: [bestId] };
  }
  return { kind: 'done' };
}
