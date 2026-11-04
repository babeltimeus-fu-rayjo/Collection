// game.js — the rules of Space Base. No DOM, no network: the host holds the
// only copy of the state and every move goes through applyMove.
//
// Two to five commodores race to 40 victory points. Each console has twelve
// sectors, one ship stationed in each, and every ship a commodore replaces is
// deployed — tucked under the console at its sector, where it pays out on the
// other players' turns. A turn: the active player rolls two dice; then every
// player at once takes either each die's sector or the sector of their sum —
// the active player the station rewards (blue), everyone else the rewards of
// all the ships they have deployed there (red). Then the active player may
// buy one ship from the shipyard, or a colony, for no more than their
// credits — and buying spends all of them; the ship is stationed at its
// sector and the one it replaces is deployed. Credits below income are raised
// to it at the end of the turn. Ships with charge squares gain a cube instead
// of their written reward and spend cubes on abilities: rerolls, set dice,
// swapping two sectors, buying or claiming more cards, and — once five cubes
// are in place on the Armstrong — winning outright.
//
// The rules are AEG's Revised Field Manual (2023), with its 2018 Field Manual
// for the finer points the revision leaves out — the phases of a turn, the
// arrows' loops, what each ability may do. Where the two differ, the revision
// is followed: a tie at the end is played off with one more round and then
// shared (2018: extra rounds until someone leads), and a tie for the first
// turn is drawn at random (2018: a dice roll).
//
// At a distance, some things the people round a table would settle are
// settled here:
//   - Everyone allocates the dice at once. When one way to take them is
//     plainly as good as or better than every other — the same or more of
//     everything — it is taken for you and the table does not wait.
//   - A player's own choices within a way of taking the dice — which way a
//     two-way arrow points, which charged ships shift the sum, whether to
//     double a sector — are offered as whole outcomes to pick from.
//   - Abilities that may be used in phases 1, 5 and 7 of any turn (placing a
//     charge, the exchange, the Grissom's credits, the Armstrong's win) can
//     be used while the active player has yet to roll, and while they buy.
//     Between the roll and the rewards the consoles stand still.
//   - "Buy a card and place it in any sector 7–12" buys a ship, not a colony,
//     and the exchange never moves a colony, which "CANNOT be replaced".
//   - Placing a charge "anywhere" places it on another of your ships, in a
//     square that counts.
//   - The box's 30 charge cubes are not a limit.

import { STARTING, LEVEL1, LEVEL2, LEVEL3, COLONIES } from './cards.js';

export const PROTO = 1;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 5;
export const WIN_VP = 40;
export const YARD = 6;
export const LEVELS = [1, 2, 3];
export const SECTORS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
export const START_CREDITS = 5;

// Every card has one id for good: the twelve starting ships first (each
// console has its own copy of each), then the shipyard's three levels, then
// the colonies.
export const CARDS = [
  ...STARTING.map((c) => ({ ...c, kind: 'start', level: 0, cost: 0 })),
  ...LEVEL1.map((c) => ({ ...c, kind: 'ship', level: 1 })),
  ...LEVEL2.map((c) => ({ ...c, kind: 'ship', level: 2 })),
  ...LEVEL3.map((c) => ({ ...c, kind: 'ship', level: 3 })),
  ...COLONIES.map((c) => ({ ...c, kind: 'colony', level: null })),
].map((c, id) => ({ id, ...c }));

export const OPTIONS = [
  { key: 'lightspeed', name: 'Light-Speed', text: 'Skip the first few turns: everyone starts with 15 credits and 1 income, is dealt four level 1 ships and two level 2 ships, and buys as many of them as they like and can afford. Whoever keeps the most credits goes first. Not recommended for a first game.' },
];
export const defaultOpts = () => ({ lightspeed: false });

export const playerBySeat = (G, seat) => G.players.find((p) => p.seat === seat);
export const activePlayer = (G) => G.players[G.turn];
const isActive = (G, p) => G.players[G.turn] === p;

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const die = () => 1 + Math.floor(Math.random() * 6);

function note(G, text) {
  G.logSeq = (G.logSeq || 0) + 1;
  G.log.push({ id: G.logSeq, text });
  if (G.log.length > 150) G.log.shift();
}

function bump(G, fx) {
  G.fxSeq = (G.fxSeq || 0) + 1;
  G.fxs.push({ seq: G.fxSeq, ...fx });
  if (G.fxs.length > 24) G.fxs.shift();
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listWords = (parts) => (parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);
// "U.E.S. Bobko 6010-E" → "Bobko"
export const shortName = (id) => CARDS[id].name.replace(/^U\.E\.[SC]\.\s+|^P\.S\.S\.\s+/, '').replace(/\s+\d{4}-[A-Z]$/, '');

// "4 credits, 1 income and 2 VP"
export function gainWords(g, more = []) {
  const parts = [];
  if (g.cr) parts.push(plural(g.cr, 'credit'));
  if (g.inc) parts.push(`${g.inc} income`);
  if (g.vp) parts.push(`${g.vp} VP`);
  return listWords([...parts, ...more]);
}

// ---------------------------------------------------------------- charge squares

// How many squares count at this table — a square with pips counts only at
// the table sizes its pips show — and how many cubes the ability takes:
// linked squares must all be filled and are all spent; separate squares are
// a reserve, one cube spent a use.
export function capOf(sq, n) {
  if (!sq) return 0;
  return sq.pips.filter((p) => !p.length || p.includes(n)).length;
}
export const needOf = (sq, n) => (!sq ? 0 : sq.linked ? capOf(sq, n) : 1);

// ---------------------------------------------------------------- the console

// Where one of a player's cards is: its sector and whether it is stationed
// there ('st') or deployed ('dp').
export function whereOf(p, id) {
  for (const s of SECTORS) {
    if (p.station[s] === id) return { sector: s, side: 'st' };
    if (p.deployed[s].includes(id)) return { sector: s, side: 'dp' };
  }
  return null;
}

// a console's cards with where they sit, stationed before deployed
function boardCards(p) {
  const out = [];
  for (const s of SECTORS) if (p.station[s] != null) out.push({ id: p.station[s], sector: s, side: 'st' });
  for (const s of SECTORS) for (const id of p.deployed[s]) out.push({ id, sector: s, side: 'dp' });
  return out;
}

const sideOf = (id, side) => CARDS[id][side] || null;
const cubesOn = (p, id) => p.cubes[id] || 0;
// A sector is closed for good once a colony is stationed in it.
export const closed = (p, s) => p.station[s] != null && CARDS[p.station[s]].kind === 'colony';

// A card leaves its side and takes up another: its cubes go along to the new
// side's squares if there is room, and are lost if there is none.
function settleCubes(G, p, id, side) {
  const cap = capOf((sideOf(id, side) || {}).sq, G.n);
  const have = cubesOn(p, id);
  if (have > cap) {
    if (cap) p.cubes[id] = cap;
    else delete p.cubes[id];
  }
}

// Station a card at a sector; the card there is deployed beneath it.
function station(G, p, id, sector) {
  const old = p.station[sector];
  if (old != null) {
    p.deployed[sector].push(old);
    settleCubes(G, p, old, 'dp');
  }
  p.station[sector] = id;
  delete p.cubes[id];
}

// ---------------------------------------------------------------- setup

export function canStart(n) {
  if (n < MIN_PLAYERS) return `Needs at least ${MIN_PLAYERS} players — add a bot to fill the table.`;
  if (n > MAX_PLAYERS) return `At most ${MAX_PLAYERS} players.`;
  return null;
}

function blankPlayer(r) {
  const station = Array(13).fill(null);
  STARTING.forEach((c, i) => { station[c.sector] = i; });
  return {
    seat: r.seat, name: r.name, bot: !!r.bot, connected: r.connected !== false, botFor: false, resigned: false,
    cr: START_CREDITS, inc: 0, vp: 0,
    station, deployed: Array.from({ length: 13 }, () => []), cubes: {},
    turns: 0,
  };
}

const levelIds = (l) => CARDS.filter((c) => c.level === l).map((c) => c.id);

function refill(G) {
  for (const l of LEVELS) {
    const row = G.yard[l];
    for (let i = 0; i < YARD; i++) if (row[i] == null) row[i] = G.decks[l].length ? G.decks[l].pop() : null;
  }
}

export function newGame(roster, opts = {}) {
  const n = roster.length;
  const why = canStart(n);
  if (why) throw new Error(why);
  const o = { ...defaultOpts(), ...opts };
  const G = {
    mid: Math.random().toString(36).slice(2, 10),
    opts: o, n,
    players: roster.map(blankPlayer),
    decks: { 1: shuffle(levelIds(1)), 2: shuffle(levelIds(2)), 3: shuffle(levelIds(3)) },
    yard: { 1: Array(YARD).fill(null), 2: Array(YARD).fill(null), 3: Array(YARD).fill(null) },
    colonies: CARDS.filter((c) => c.kind === 'colony').map((c) => c.id),
    phase: 'setup', turn: 0, first: 0, round: 1,
    dice: null, set: [null, null], rolls: 0,
    alloc: null, claim: null, bought: false,
    ending: null, tieRound: false, winners: null, why: null,
    log: [], fxs: [], logSeq: 0, fxSeq: 0,
  };
  refill(G);
  if (o.lightspeed) {
    // "draw four level 1 cards and two level 2 cards" each, with 15 credits and 1 income
    G.phase = 'light';
    G.light = {};
    for (const p of G.players) {
      p.cr = 15;
      p.inc = 1;
      G.light[p.seat] = { offer: [G.decks[1].pop(), G.decks[1].pop(), G.decks[1].pop(), G.decks[1].pop(), G.decks[2].pop(), G.decks[2].pop()], picks: null };
    }
    note(G, 'Light-Speed: everyone has 15 credits, 1 income and six ships to buy from.');
    return G;
  }
  // "draw a card from the top of the Level 1 ship deck and buy it for its cost"
  const drawn = G.players.map((p) => {
    const id = G.decks[1].pop();
    p.cr -= CARDS[id].cost;
    station(G, p, id, CARDS[id].sector);
    note(G, `${p.name} draws ${CARDS[id].name} and buys it for ${CARDS[id].cost}.`);
    return CARDS[id].sector;
  });
  const top = Math.max(...drawn);
  const tied = G.players.map((p, i) => i).filter((i) => drawn[i] === top);
  beginPlay(G, tied[Math.floor(Math.random() * tied.length)], tied.length > 1 ? `the highest sector, ${top}, drawn at random from the tie` : `the highest sector, ${top}`);
  return G;
}

// The starting player is set; the others gain their bonuses round the table
// and the first turn begins.
function beginPlay(G, first, because) {
  G.first = first;
  G.turn = first;
  const bonus = [null, { cr: 1 }, { cr: 2 }, { inc: 1 }, { inc: 1 }];
  for (let k = 1; k < G.n; k++) {
    const p = G.players[(first + k) % G.n];
    const b = bonus[k];
    p.cr += b.cr || 0;
    p.inc += b.inc || 0;
    note(G, `${p.name} plays ${['', '2nd', '3rd', '4th', '5th'][k]} and gains ${b.cr ? plural(b.cr, 'credit') : `${b.inc} income`}.`);
  }
  note(G, `${G.players[first].name} takes the first turn — ${because}.`);
  startTurn(G);
}

function startTurn(G) {
  G.phase = 'roll';
  G.dice = null;
  G.set = [null, null];
  G.rolls = 0;
  G.alloc = null;
  G.claim = null;
  G.bought = false;
}

// ---------------------------------------------------------------- the dice, allocated

// A sector's rewards for one player, following its arrows: every card in the
// sector — the station card for the active player, all the deployed ones for
// everyone else — pays out once, and an arrow pays out the sector next door
// as well. "You can't create infinite loops": in one die's activation each
// card pays at most once. A two-way arrow asks which way, through `choose`.
function runActivation(p, side, start, choose) {
  const g = { cr: 0, inc: 0, vp: 0, claim: {}, charge: {}, cards: [], arrows: [] };
  const seen = new Set();
  const visit = (sector) => {
    const ids = side === 'st' ? (p.station[sector] != null ? [p.station[sector]] : []) : p.deployed[sector];
    for (const id of ids) {
      if (seen.has(id) || CARDS[id].kind === 'colony') continue;
      seen.add(id);
      const sd = CARDS[id][side];
      const r = sd.r;
      g.cr += r.cr || 0;
      g.inc += r.inc || 0;
      g.vp += r.vp || 0;
      if (r.claim) for (const [l, k] of Object.entries(r.claim)) g.claim[l] = (g.claim[l] || 0) + k;
      if (sd.sq) g.charge[id] = (g.charge[id] || 0) + 1;
      g.cards.push(id);
      if (r.arrow) {
        const dirs = (r.arrow === 'LR' ? ['L', 'R'] : [r.arrow]).filter((d) => {
          const t = sector + (d === 'L' ? -1 : 1);
          return t >= 1 && t <= 12;
        });
        if (!dirs.length) continue;
        const dir = dirs.length > 1 ? choose(dirs) : dirs[0];
        const to = sector + (dir === 'L' ? -1 : 1);
        if (r.arrow === 'LR') g.arrows.push({ id, from: sector, to });
        visit(to);
      }
    }
  };
  visit(start);
  return g;
}

// every way a two-way arrow can point, each as its own outcome
function activationOutcomes(p, side, start) {
  const outs = [];
  const queue = [[]];
  while (queue.length) {
    const prefix = queue.pop();
    const path = [];
    const choose = (opts) => {
      let c = 0;
      if (path.length < prefix.length) c = prefix[path.length];
      else for (let j = opts.length - 1; j >= 1; j--) queue.push([...path, j]);
      path.push(c);
      return opts[c];
    };
    outs.push(runActivation(p, side, start, choose));
  }
  return outs;
}

// Charged abilities that change the allocation itself: the green dice and
// arrows that raise the sum, and the 2x that doubles one sector.
function allocAbilities(G, p) {
  const active = isActive(G, p);
  const shifts = [];
  let double = null;
  for (const { id, side } of boardCards(p)) {
    const sd = sideOf(id, side);
    if (!sd || !sd.ab) continue;
    const need = needOf(sd.sq, G.n);
    if (cubesOn(p, id) < need) continue;
    if (sd.ab.kind === 'shift') shifts.push({ id, by: sd.ab.by, need });
    if (sd.ab.kind === 'double' && (sd.ab.color === 'blue' ? active : !active)) double = double || { id, need };
  }
  return { shifts, double };
}

// The cheapest way to raise the sum by each amount: every subset of the
// charged shift ships, each at one of its sizes; fewest cubes, then fewest
// ships.
function shiftWays(shifts) {
  const best = {};
  const walk = (i, k, spend, cubes) => {
    if (i === shifts.length) {
      if (k > 0 && (!best[k] || cubes < best[k].cubes || (cubes === best[k].cubes && spend.length < best[k].spend.length))) best[k] = { spend, cubes };
      return;
    }
    walk(i + 1, k, spend, cubes);
    for (const by of shifts[i].by) walk(i + 1, k + by, [...spend, { id: shifts[i].id, n: shifts[i].need }], cubes + shifts[i].need);
  };
  walk(0, 0, [], 0);
  return best;
}

// The outcome as numbers to compare: resources, claims, and the cubes every
// touched card ends up with.
function outcomeKey(G, p, o, ids) {
  const spent = {};
  for (const s of o.spend) spent[s.id] = (spent[s.id] || 0) + s.n;
  const cubes = ids.map((id) => {
    const w = whereOf(p, id);
    const cap = w ? capOf((sideOf(id, w.side) || {}).sq, G.n) : 0;
    return Math.min(cap, cubesOn(p, id) - (spent[id] || 0) + (o.gain.charge[id] || 0));
  });
  return [o.gain.cr, o.gain.inc, o.gain.vp, o.gain.claim[1] || 0, o.gain.claim[2] || 0, o.gain.claim[3] || 0, ...cubes];
}

function addGain(t, g, skip = null) {
  t.cr += g.cr;
  t.inc += g.inc;
  t.vp += g.vp;
  for (const [l, k] of Object.entries(g.claim)) t.claim[l] = (t.claim[l] || 0) + k;
  for (const [id, k] of Object.entries(g.charge)) if (Number(id) !== skip) t.charge[id] = (t.charge[id] || 0) + k;
}

// Every way this player may take the dice this roll, the ones no other way
// matches or beats on everything, in the order they were found: each die,
// the sum, the sum raised, each with and without the 2x.
export function allocOptions(G, p) {
  const side = isActive(G, p) ? 'st' : 'dp';
  const [a, b] = G.dice;
  const { shifts, double } = allocAbilities(G, p);
  const modes = [{ mode: 'each', acts: a === b ? [a, a] : [a, b], shift: 0, spend: [] }, { mode: 'sum', acts: [a + b], shift: 0, spend: [] }];
  const ways = shiftWays(shifts);
  for (const k of Object.keys(ways).map(Number).sort((x, y) => x - y)) {
    if (a + b + k <= 12) modes.push({ mode: 'sum', acts: [a + b + k], shift: k, spend: ways[k].spend });
  }
  const all = [];
  for (const m of modes) {
    const outs = m.acts.map((s) => activationOutcomes(p, side, s));
    const dbls = [null];
    if (double) dbls.push(0);
    if (double && m.acts.length > 1 && m.acts[0] !== m.acts[1]) dbls.push(1);
    for (const dbl of dbls) {
      const combos = m.acts.length === 1 ? outs[0].map((x) => [x]) : outs[0].flatMap((x) => outs[1].map((y) => [x, y]));
      for (const combo of combos) {
        const gain = { cr: 0, inc: 0, vp: 0, claim: {}, charge: {} };
        combo.forEach((g) => addGain(gain, g));
        if (dbl != null) addGain(gain, combo[dbl], double.id);
        all.push({
          mode: m.mode, acts: m.acts, shift: m.shift,
          spend: dbl != null ? [...m.spend, { id: double.id, n: double.need }] : m.spend,
          dbl: dbl != null ? { id: double.id, sector: m.acts[dbl] } : null,
          arrows: combo.flatMap((g) => g.arrows),
          cards: combo.flatMap((g) => g.cards),
          gain,
        });
      }
    }
  }
  const ids = [...new Set(all.flatMap((o) => [...o.spend.map((s) => s.id), ...Object.keys(o.gain.charge).map(Number)]))];
  const keys = all.map((o) => outcomeKey(G, p, o, ids));
  const keep = [];
  for (let i = 0; i < all.length; i++) {
    let out = false;
    for (let j = 0; j < all.length && !out; j++) {
      if (i === j) continue;
      const ge = keys[j].every((v, k) => v >= keys[i][k]);
      const same = keys[j].every((v, k) => v === keys[i][k]);
      if (ge && (!same || j < i)) out = true;
    }
    if (!out) keep.push(all[i]);
  }
  return keep;
}

// How a way of taking the dice reads, for the log and the buttons.
export function allocWords(o) {
  let s;
  if (o.mode === 'each') s = o.acts[0] === o.acts[1] ? `each die: sector ${o.acts[0]} twice` : `each die: sectors ${o.acts[0]} and ${o.acts[1]}`;
  else if (o.shift) s = `the sum, raised by ${o.shift} to ${o.acts[0]}`;
  else s = `the sum: sector ${o.acts[0]}`;
  const bits = [];
  for (const a of o.arrows) bits.push(`${shortName(a.id)} points to ${a.to}`);
  if (o.dbl) bits.push(`${shortName(o.dbl.id)} doubles sector ${o.dbl.sector}`);
  return bits.length ? `${s} (${bits.join('; ')})` : s;
}

function openAlloc(G) {
  G.phase = 'alloc';
  G.alloc = {};
  for (const p of G.players) {
    const options = allocOptions(G, p);
    G.alloc[p.seat] = { options, pick: options.length === 1 ? 0 : null, auto: options.length === 1 };
  }
  if (G.players.every((p) => G.alloc[p.seat].pick != null)) resolveAlloc(G);
}

// Everyone has chosen: the active player's rewards first, then round the table.
function resolveAlloc(G) {
  const active = activePlayer(G);
  for (let k = 0; k < G.n; k++) {
    const p = G.players[(G.turn + k) % G.n];
    const a = G.alloc[p.seat];
    const o = a.options[a.pick];
    for (const s of o.spend) {
      p.cubes[s.id] = Math.max(0, cubesOn(p, s.id) - s.n);
      if (!p.cubes[s.id]) delete p.cubes[s.id];
    }
    p.cr += o.gain.cr;
    p.inc += o.gain.inc;
    p.vp += o.gain.vp;
    let cubes = 0;
    for (const [sid, k2] of Object.entries(o.gain.charge)) {
      const id = Number(sid);
      const w = whereOf(p, id);
      const cap = w ? capOf((sideOf(id, w.side) || {}).sq, G.n) : 0;
      const before = cubesOn(p, id);
      p.cubes[id] = Math.min(cap, before + k2);
      cubes += p.cubes[id] - before;
      if (!p.cubes[id]) delete p.cubes[id];
    }
    const claims = LEVELS.filter((l) => o.gain.claim[l]).map((l) => `${o.gain.claim[l]} level ${l}`);
    const got = gainWords(o.gain, [cubes ? plural(cubes, 'charge') : '', claims.length ? `a claim on ${listWords(claims)}` : ''].filter(Boolean));
    note(G, `${p.name} takes ${allocWords(o)} — ${got || 'nothing'}.`);
    if (o.gain.cr || o.gain.inc || o.gain.vp || cubes) bump(G, { kind: 'gain', seat: p.seat, cr: o.gain.cr, inc: o.gain.inc, vp: o.gain.vp, cubes });
    if (p === active && claims.length) G.claim = { ...o.gain.claim };
  }
  checkEnding(G);
  G.phase = 'claim';
  if (!G.claim || !claimable(G, active).length) {
    G.claim = null;
    G.phase = 'buy';
  }
}

// ---------------------------------------------------------------- buying and claiming

// a shipyard card's place, or null
function yardSlot(G, id) {
  for (const l of LEVELS) {
    const i = G.yard[l].indexOf(id);
    if (i >= 0) return { level: l, i };
  }
  return null;
}
const takeFromYard = (G, id) => {
  const s = yardSlot(G, id);
  G.yard[s.level][s.i] = null;
};
export const yardIds = (G) => LEVELS.flatMap((l) => G.yard[l]).filter((id) => id != null);

// Cards the active player could claim with what is left to claim.
export function claimable(G, p) {
  if (!G.claim) return [];
  return yardIds(G).filter((id) => (G.claim[CARDS[id].level] || 0) > 0 && !closed(p, CARDS[id].sector));
}

// Whether a card can be bought: in the shipyard or among the colonies, its
// sector not closed (or, for a ship placed in any sector 7–12, the sector
// chosen), and affordable.
function buyProblem(G, p, id, credits, sector = null) {
  const c = CARDS[id];
  if (!c) return 'No such card.';
  const inYard = !!yardSlot(G, id);
  const isColony = c.kind === 'colony' && G.colonies.includes(id);
  if (!inYard && !isColony) return 'That card is not for sale.';
  const s = sector ?? c.sector;
  if (closed(p, s)) return `Your sector ${s} has a colony — nothing more goes there.`;
  if (c.cost > credits) return `${shortName(id)} costs ${c.cost} — you have ${plural(credits, 'credit')}.`;
  return null;
}

// Buy and station a card; a colony scores at once.
function placeBought(G, p, id, sector = null) {
  const c = CARDS[id];
  if (c.kind === 'colony') {
    G.colonies = G.colonies.filter((x) => x !== id);
    p.vp += c.vp;
  } else {
    takeFromYard(G, id);
  }
  station(G, p, id, sector ?? c.sector);
  bump(G, { kind: 'buy', seat: p.seat, card: id, sector: sector ?? c.sector });
}

// Cards the active player could buy now with their normal buy.
export function buyable(G, p) {
  if (G.phase !== 'buy' || !isActive(G, p) || G.bought) return [];
  return [...yardIds(G), ...G.colonies].filter((id) => !buyProblem(G, p, id, p.cr));
}

// ---------------------------------------------------------------- abilities

// What stands in the way of using a card's ability now, or null. Phases 1, 5
// and 7 are the roll phase before the dice are rolled and the buy phase; the
// set-die abilities come just before the roll, the rerolls just after it, and
// the dice and arrows and the 2x only as part of taking the dice.
export function useProblem(G, p, id) {
  if (G.phase === 'over') return 'The game is over.';
  const w = whereOf(p, id);
  if (!w) return 'That card is not on your console.';
  const sd = sideOf(id, w.side);
  if (!sd || !sd.ab) return 'That card has no ability.';
  const ab = sd.ab;
  const active = isActive(G, p);
  if (ab.color === 'blue' && !active) return 'That ability is for your own turn.';
  if (ab.color === 'red' && active) return 'That ability is for the other players’ turns.';
  const need = needOf(sd.sq, G.n);
  if (cubesOn(p, id) < need) return `${shortName(id)} needs ${plural(need, 'charge cube')} to use it.`;
  if (ab.kind === 'shift' || ab.kind === 'double') return 'That ability is used when you take the dice.';
  if (ab.kind === 'setdie') {
    if (G.phase !== 'roll') return 'A die is set before the roll.';
    if (G.set[0] != null && G.set[1] != null) return 'Both dice are already set.';
    return null;
  }
  if (ab.kind === 'reroll') return G.phase === 'reroll' ? null : 'A reroll comes right after the roll.';
  if (G.phase !== 'roll' && G.phase !== 'buy') return 'Not now — wait for the rewards to be taken.';
  return null;
}

const abOf = (p, id) => {
  const w = whereOf(p, id);
  return w ? { ...w, ab: sideOf(id, w.side).ab, sq: sideOf(id, w.side).sq } : null;
};

// The abilities a player can use now, for the table to offer.
export function usable(G, p) {
  return boardCards(p).filter(({ id }) => !useProblem(G, p, id)).map(({ id, sector, side }) => ({ id, sector, side, kind: sideOf(id, side).ab.kind }));
}

function spend(G, p, id) {
  const a = abOf(p, id);
  p.cubes[id] = cubesOn(p, id) - needOf(a.sq, G.n);
  if (!p.cubes[id]) delete p.cubes[id];
}

// Use an ability. Every choice it needs comes with the move: the cards to
// buy or claim, where a charge goes, what to exchange with, a die's value.
function useAbility(G, p, move) {
  const id = Number(move.card);
  const why = useProblem(G, p, id);
  if (why) return why;
  const a = abOf(p, id);
  const ab = a.ab;
  const name = shortName(id);
  switch (ab.kind) {
    case 'gain': {
      spend(G, p, id);
      p.cr += ab.cr || 0;
      note(G, `${p.name} uses ${name}: ${plural(ab.cr, 'credit')}.`);
      bump(G, { kind: 'gain', seat: p.seat, cr: ab.cr || 0, inc: 0, vp: 0, cubes: 0 });
      break;
    }
    case 'swap': {
      spend(G, p, id);
      [p.station[ab.a], p.station[ab.b]] = [p.station[ab.b], p.station[ab.a]];
      [p.deployed[ab.a], p.deployed[ab.b]] = [p.deployed[ab.b], p.deployed[ab.a]];
      note(G, `${p.name} uses ${name}: sectors ${ab.a} and ${ab.b} trade places, every card in them.`);
      bump(G, { kind: 'swap', seat: p.seat, a: ab.a, b: ab.b });
      break;
    }
    case 'buy': {
      const targets = Array.isArray(move.cards) ? move.cards.map(Number) : [];
      if (targets.length > ab.n) return `${name} buys at most ${plural(ab.n, 'card')}.`;
      if (new Set(targets).size !== targets.length) return 'The same card twice.';
      const sector = ab.high ? Number(move.sector) : null;
      if (ab.high && targets.length && !(sector >= 7 && sector <= 12)) return 'Choose a sector from 7 to 12 for it.';
      if (ab.high && targets.some((t) => CARDS[t] && CARDS[t].kind === 'colony')) return 'A colony goes in its own sector — this buys a ship.';
      // the ability's own credits come first; each card costs just its price
      let credits = p.cr + (ab.cr || 0);
      const sim = { ...p, station: p.station.slice() };
      for (const t of targets) {
        const bad = buyProblem(G, sim, t, credits, sector);
        if (bad) return bad;
        credits -= CARDS[t].cost;
        sim.station[sector ?? CARDS[t].sector] = t;
      }
      spend(G, p, id);
      p.cr += ab.cr || 0;
      p.vp += ab.vp || 0;
      if (ab.loss) for (const q of G.players) if (q !== p) q.vp = Math.max(0, q.vp - ab.loss);
      for (const t of targets) {
        p.cr -= CARDS[t].cost;
        placeBought(G, p, t, sector);
      }
      const extra = [ab.cr ? plural(ab.cr, 'credit') : '', ab.vp ? `${ab.vp} VP` : '', ab.loss ? `every other player loses ${ab.loss} VP` : ''].filter(Boolean);
      note(G, `${p.name} uses ${name}${extra.length ? ` (${listWords(extra)})` : ''}: ${targets.length ? `buys ${listWords(targets.map((t) => `${CARDS[t].name} for ${CARDS[t].cost}${sector ? ` into sector ${sector}` : ''}`))}` : 'buys nothing'}.`);
      checkEnding(G);
      break;
    }
    case 'claim': {
      const targets = Array.isArray(move.cards) ? move.cards.map(Number) : [];
      const bad = claimProblem(G, p, targets, ab.claim);
      if (bad) return bad;
      spend(G, p, id);
      for (const t of targets) {
        takeFromYard(G, t);
        station(G, p, t, CARDS[t].sector);
        bump(G, { kind: 'buy', seat: p.seat, card: t, sector: CARDS[t].sector, free: true });
      }
      note(G, `${p.name} uses ${name}: ${targets.length ? `claims ${listWords(targets.map((t) => CARDS[t].name))}` : 'claims nothing'}.`);
      break;
    }
    case 'place': {
      // worked out on a copy, so a refusal leaves nothing half done
      const to = Number(move.target);
      const cubes = { ...p.cubes, [id]: cubesOn(p, id) - needOf(a.sq, G.n) };
      const bad = placeProblem(G, p, to, id, cubes);
      if (bad) return bad;
      cubes[to] = (cubes[to] || 0) + 1;
      let mv = null;
      if (ab.move && move.from != null) {
        // "then move 1 of your charges to another open charge spot"
        const from = Number(move.from);
        const dest = Number(move.to);
        if (!whereOf(p, from)) return 'Move a charge from one of your cards.';
        if (!(cubes[from] > 0)) return `There is no charge on ${shortName(from)} to move.`;
        const room = placeProblem(G, p, dest, id, cubes);
        if (room) return room;
        if (from === dest) return 'Move it to another card.';
        cubes[from]--;
        cubes[dest] = (cubes[dest] || 0) + 1;
        mv = { from, dest };
      }
      for (const k of Object.keys(cubes)) if (!cubes[k]) delete cubes[k];
      p.cubes = cubes;
      note(G, `${p.name} uses ${name}: a charge on ${shortName(to)}${mv ? `, and one moved from ${shortName(mv.from)} to ${shortName(mv.dest)}` : ''}.`);
      bump(G, { kind: 'charge', seat: p.seat, card: to });
      break;
    }
    case 'exchange': {
      const t = Number(move.target);
      const wt = whereOf(p, t);
      if (!wt || t === id) return 'Exchange it with another card on your console.';
      if (CARDS[t].kind === 'colony') return 'A colony cannot be moved.';
      const wa = whereOf(p, id);
      if (wa.side === 'dp' && wt.side === 'dp' && wa.sector === wt.sector) return 'Those two are deployed side by side already.';
      spend(G, p, id);
      // each takes the other's place: a station slot, or a place in a sector's deployed stack
      const putAt = (w, was, card) => {
        if (w.side === 'st') p.station[w.sector] = card;
        else p.deployed[w.sector][p.deployed[w.sector].indexOf(was)] = card;
      };
      putAt(wa, id, t);
      putAt(wt, t, id);
      settleCubes(G, p, id, wt.side);
      settleCubes(G, p, t, wa.side);
      note(G, `${p.name} uses ${name}: it trades places with ${shortName(t)}.`);
      bump(G, { kind: 'exchange', seat: p.seat, a: id, b: t });
      break;
    }
    case 'win': {
      spend(G, p, id);
      note(G, `${p.name} fires the ${name}’s ultra-core laser — and wins on the spot.`);
      finish(G, [p.seat], `${p.name} charged the ${name} and won outright`);
      break;
    }
    case 'setdie': {
      const v = Number(move.value);
      if (!(v >= 1 && v <= 6)) return 'Set the die to a number from 1 to 6.';
      spend(G, p, id);
      G.set[G.set[0] == null ? 0 : 1] = v;
      p.cr += ab.cr || 0;
      note(G, `${p.name} uses ${name}: one die set to ${v}${ab.cr ? `, and ${plural(ab.cr, 'credit')}` : ''}.`);
      bump(G, { kind: 'set', seat: p.seat, value: v });
      break;
    }
    case 'reroll': {
      const which = Array.isArray(move.dice) ? [...new Set(move.dice.map(Number))] : [];
      if (!which.length || which.some((i) => i !== 0 && i !== 1)) return 'Choose one die or both to roll again.';
      spend(G, p, id);
      for (const i of which) G.dice[i] = die();
      p.cr += ab.cr || 0;
      note(G, `${p.name} uses ${name} and rolls ${which.length === 2 ? 'both dice' : 'one die'} again: ${G.dice[0]} and ${G.dice[1]}.`);
      bump(G, { kind: 'roll', seat: p.seat, dice: G.dice.slice(), reroll: true });
      if (!canReroll(G, p)) openAlloc(G);
      break;
    }
    default:
      return 'That ability cannot be used.';
  }
  return null;
}

function claimProblem(G, p, targets, allowance) {
  if (new Set(targets).size !== targets.length) return 'The same card twice.';
  const used = {};
  const sim = p.station.slice();
  for (const t of targets) {
    const c = CARDS[t];
    if (!c || !yardSlot(G, t)) return 'Claim cards from the shipyard.';
    used[c.level] = (used[c.level] || 0) + 1;
    if (used[c.level] > (allowance[c.level] || 0)) return `That is more level ${c.level} cards than you may claim.`;
    if (sim[c.sector] != null && CARDS[sim[c.sector]].kind === 'colony') return `Your sector ${c.sector} has a colony — nothing more goes there.`;
    sim[c.sector] = t;
  }
  return null;
}

// Where a charge cube may go: a card on this console, not the one placing it,
// with an empty square that counts.
function placeProblem(G, p, to, self, cubes = p.cubes) {
  const w = whereOf(p, to);
  if (!w) return 'Place it on one of your cards.';
  if (to === self) return 'Place it on another card.';
  const cap = capOf((sideOf(to, w.side) || {}).sq, G.n);
  if (!cap) return `${shortName(to)} has no charge squares${w.side === 'dp' ? ' on its deployed side' : ''}.`;
  if ((cubes[to] || 0) >= cap) return `${shortName(to)} is full.`;
  return null;
}

// whether the active player still holds a charged reroll
function canReroll(G, p) {
  return boardCards(p).some(({ id, side }) => {
    const sd = sideOf(id, side);
    return sd && sd.ab && sd.ab.kind === 'reroll' && cubesOn(p, id) >= needOf(sd.sq, G.n);
  });
}

// ---------------------------------------------------------------- the end

// "When any player reaches at least 40, it triggers the end of the game, even
// if this happens on another player's turn."
function checkEnding(G) {
  if (G.ending || G.phase === 'over') return;
  const p = G.players.find((q) => q.vp >= WIN_VP);
  if (!p) return;
  G.ending = { seat: p.seat };
  note(G, `${p.name} reaches ${WIN_VP} VP — the round is played out, so everyone has as many turns.`);
  bump(G, { kind: 'ending', seat: p.seat });
}

function finish(G, winners, why) {
  G.phase = 'over';
  G.winners = winners;
  G.why = why;
  G.alloc = null;
  G.claim = null;
  bump(G, { kind: 'over' });
}

function endTurn(G) {
  const p = activePlayer(G);
  refill(G);
  if (p.cr < p.inc) {
    note(G, `${p.name}’s credits rise to their income, ${p.inc}.`);
    p.cr = p.inc;
  }
  p.turns++;
  checkEnding(G);
  const last = (G.first + G.n - 1) % G.n;
  if (G.ending && G.turn === last) {
    const top = Math.max(...G.players.map((q) => q.vp));
    const leaders = G.players.filter((q) => q.vp === top);
    if (leaders.length === 1) return finish(G, [leaders[0].seat], `${leaders[0].name} has the most VP, ${top}`);
    if (!G.tieRound) {
      // "If it's a tie, play one more round of turns."
      G.tieRound = true;
      note(G, `${listWords(leaders.map((q) => q.name))} are tied at ${top} — one more round.`);
      bump(G, { kind: 'tie' });
    } else {
      // "If it's still a tie, share the victory!"
      return finish(G, leaders.map((q) => q.seat), `${listWords(leaders.map((q) => q.name))} tie at ${top} VP after a round more`);
    }
  }
  G.turn = (G.turn + 1) % G.n;
  if (G.turn === G.first) G.round++;
  startTurn(G);
}

// ---------------------------------------------------------------- Light-Speed

function lightSpeed(G, p, move) {
  const L = G.light[p.seat];
  const picks = Array.isArray(move.cards) ? move.cards.map(Number) : null;
  if (!picks) return 'Choose the ships to buy.';
  if (new Set(picks).size !== picks.length || picks.some((id) => !L.offer.includes(id))) return 'Choose from the six ships you were dealt.';
  const cost = picks.reduce((s, id) => s + CARDS[id].cost, 0);
  if (cost > p.cr) return `Those cost ${cost} — you have ${p.cr}.`;
  L.picks = picks;
  if (G.players.some((q) => !G.light[q.seat].picks)) return null;
  // everyone has chosen: buy them all, in the order chosen
  for (const q of G.players) {
    const Lq = G.light[q.seat];
    for (const id of Lq.picks) {
      q.cr -= CARDS[id].cost;
      station(G, q, id, CARDS[id].sector);
    }
    // "Any unbought cards are placed at the bottom of their respective decks"
    for (const id of Lq.offer) if (!Lq.picks.includes(id)) G.decks[CARDS[id].level].unshift(id);
    note(G, `${q.name} buys ${Lq.picks.length ? listWords(Lq.picks.map((id) => CARDS[id].name)) : 'nothing'} and keeps ${plural(q.cr, 'credit')}.`);
  }
  // the most money kept goes first; then the highest sector bought; then a roll
  const high = (q) => Math.max(0, ...G.light[q.seat].picks.map((id) => CARDS[id].sector));
  const most = Math.max(...G.players.map((q) => q.cr));
  let tied = G.players.filter((q) => q.cr === most);
  let because = `the most credits kept, ${most}`;
  if (tied.length > 1) {
    const h = Math.max(...tied.map(high));
    tied = tied.filter((q) => high(q) === h);
    because += h ? `, and the highest sector bought, ${h}` : '';
    if (tied.length > 1) because += ', drawn at random from the tie';
  }
  const first = tied[Math.floor(Math.random() * tied.length)];
  G.lightDone = Object.fromEntries(G.players.map((q) => [q.seat, G.light[q.seat].picks.slice()]));
  beginPlay(G, G.players.indexOf(first), because);
  return null;
}

// ---------------------------------------------------------------- moves

export function applyMove(G, seat, move) {
  const p = playerBySeat(G, seat);
  if (!p) return { ok: false, error: 'You are not at this table.' };
  if (!move || typeof move !== 'object') return { ok: false, error: 'Bad move.' };
  if (G.phase === 'over') return { ok: false, error: 'The game is over.' };
  const err = (e) => ({ ok: false, error: e });
  const active = isActive(G, p);
  switch (move.kind) {
    case 'lightspeed': {
      if (G.phase !== 'light') return err('Light-Speed is over.');
      if (G.light[seat].picks) return err('You have already chosen.');
      const why = lightSpeed(G, p, move);
      return why ? err(why) : { ok: true };
    }
    case 'roll': {
      if (G.phase !== 'roll' || !active) return err('It is not your roll.');
      G.dice = G.set.map((v) => v ?? die());
      G.rolls++;
      const set = G.set.filter((v) => v != null).length;
      note(G, `${p.name} ${set === 2 ? 'sets both dice' : set ? 'sets a die and rolls the other' : 'rolls'}: ${G.dice[0]} and ${G.dice[1]}.`);
      bump(G, { kind: 'roll', seat, dice: G.dice.slice() });
      if (canReroll(G, p)) G.phase = 'reroll';
      else openAlloc(G);
      return { ok: true };
    }
    case 'keep': {
      if (G.phase !== 'reroll' || !active) return err('There is nothing to keep.');
      openAlloc(G);
      return { ok: true };
    }
    case 'use': {
      const why = useAbility(G, p, move);
      return why ? err(why) : { ok: true };
    }
    case 'alloc': {
      if (G.phase !== 'alloc') return err('The dice are not being taken now.');
      const a = G.alloc[seat];
      if (a.pick != null) return err('You have already taken the dice.');
      const i = Number(move.pick);
      if (!Number.isInteger(i) || i < 0 || i >= a.options.length) return err('No such choice.');
      a.pick = i;
      if (G.players.every((q) => G.alloc[q.seat].pick != null)) resolveAlloc(G);
      return { ok: true };
    }
    case 'claim': {
      if (G.phase !== 'claim' || !active) return err('There is nothing to claim.');
      const targets = Array.isArray(move.cards) ? move.cards.map(Number) : [];
      const bad = claimProblem(G, p, targets, G.claim);
      if (bad) return err(bad);
      for (const t of targets) {
        takeFromYard(G, t);
        station(G, p, t, CARDS[t].sector);
        bump(G, { kind: 'buy', seat, card: t, sector: CARDS[t].sector, free: true });
      }
      note(G, `${p.name} ${targets.length ? `claims ${listWords(targets.map((t) => CARDS[t].name))}` : 'claims nothing'}.`);
      G.claim = null;
      G.phase = 'buy';
      return { ok: true };
    }
    case 'buy': {
      if (G.phase !== 'buy' || !active) return err('You can buy after the rewards, on your turn.');
      if (G.bought) return err('You have made your buy this turn.');
      const id = Number(move.card);
      const bad = buyProblem(G, p, id, p.cr);
      if (bad) return err(bad);
      const spent = p.cr;
      p.cr = 0;
      placeBought(G, p, id);
      G.bought = true;
      const c = CARDS[id];
      note(G, `${p.name} buys ${c.name} for ${c.cost}${spent > c.cost ? `, spending all ${spent} credits` : ''}${c.kind === 'colony' ? ` — ${c.vp} VP, and sector ${c.sector} is closed` : ''}.`);
      checkEnding(G);
      return { ok: true };
    }
    case 'end': {
      if (G.phase !== 'buy' || !active) return err('It is not your turn to end.');
      if (!G.bought) note(G, `${p.name} buys nothing and keeps ${plural(p.cr, 'credit')}.`);
      endTurn(G);
      return { ok: true };
    }
    default:
      return err('Unknown move.');
  }
}

// Who the table is waiting on.
export function waitingOn(G) {
  switch (G.phase) {
    case 'light': return G.players.filter((p) => !G.light[p.seat].picks).map((p) => p.seat);
    case 'alloc': return G.players.filter((p) => G.alloc[p.seat].pick == null).map((p) => p.seat);
    case 'roll':
    case 'reroll':
    case 'claim':
    case 'buy': return [activePlayer(G).seat];
    default: return [];
  }
}

// ---------------------------------------------------------------- disconnection

export function markDisconnected(G, seat) { const p = playerBySeat(G, seat); if (!p || p.bot) return false; p.connected = false; return true; }
export function markReconnected(G, seat) { const p = playerBySeat(G, seat); if (p) { p.connected = true; p.botFor = false; } }
export function markBotTakeover(G, seat) { const p = playerBySeat(G, seat); if (!p || p.bot || p.connected) return false; p.botFor = true; note(G, `A bot takes over for ${p.name}.`); return true; }
export function markSeatClaimed(G, seat, name) { const p = playerBySeat(G, seat); if (!p) return; p.name = name; p.connected = true; p.botFor = false; p.resigned = false; }
export function markSeatResigned(G, seat) { const p = playerBySeat(G, seat); if (!p) return; p.connected = false; p.resigned = true; }

// ---------------------------------------------------------------- views

// Space Base hides nothing but the order of the decks: every console, every
// cube and the whole shipyard are on the table. While the dice are being
// taken, a view carries its own player's choices and only whether the others
// have chosen; Light-Speed's picks are kept until everyone has made them.
export function viewFor(G, seat, code, opts = {}) {
  const me = playerBySeat(G, seat);
  const over = G.phase === 'over';
  const active = G.players[G.turn];
  const mine = me && !opts.observer;
  const view = {
    code, mid: G.mid, you: seat, phase: G.phase, n: G.n, opts: { ...G.opts },
    turn: active.seat, first: G.players[G.first].seat, round: G.round,
    dice: G.dice ? G.dice.slice() : null, set: G.set.slice(), rolls: G.rolls,
    yard: { 1: G.yard[1].slice(), 2: G.yard[2].slice(), 3: G.yard[3].slice() },
    decks: { 1: G.decks[1].length, 2: G.decks[2].length, 3: G.decks[3].length },
    colonies: G.colonies.slice(),
    bought: G.bought,
    ending: G.ending ? { ...G.ending } : null,
    tieRound: G.tieRound,
    players: G.players.map((p) => ({
      seat: p.seat, name: p.name, bot: p.bot, connected: p.connected, botFor: !!p.botFor, resigned: !!p.resigned,
      cr: p.cr, inc: p.inc, vp: p.vp,
      station: p.station.slice(), deployed: p.deployed.map((d) => d.slice()), cubes: { ...p.cubes },
      turns: p.turns,
      chose: G.phase === 'alloc' ? G.alloc[p.seat].pick != null : G.phase === 'light' ? !!G.light[p.seat].picks : null,
      auto: G.phase === 'alloc' ? !!G.alloc[p.seat].auto : false,
    })),
    alloc: null,
    claim: G.phase === 'claim' ? { seat: active.seat, left: { ...G.claim }, cards: claimable(G, active) } : null,
    light: null,
    winners: over ? G.winners.slice() : null,
    why: G.why,
    log: G.log.slice(-60),
    fxs: G.fxs,
  };
  if (G.phase === 'alloc' && mine) {
    const a = G.alloc[seat];
    view.alloc = { options: a.options, pick: a.pick };
  }
  if (G.phase === 'light') {
    view.light = {
      offers: Object.fromEntries(G.players.map((p) => [p.seat, G.light[p.seat].offer.slice()])),
      mine: mine && G.light[seat].picks ? G.light[seat].picks.slice() : null,
    };
  }
  if (G.lightDone) view.lightDone = G.lightDone;
  if (mine && !over) {
    view.can = {
      roll: G.phase === 'roll' && active === me,
      keep: G.phase === 'reroll' && active === me,
      end: G.phase === 'buy' && active === me,
      buy: buyable(G, me),
      use: usable(G, me),
    };
  }
  return view;
}

// ---------------------------------------------------------------- bots
//
// A bot puts a number on a console: the VP it has, its credits at so much a
// VP, and what its ships will bring in over the turns it expects are left —
// the station rewards over its own rolls and the deployed ones over everyone
// else's, each roll taken the better of each die and the sum. Every choice
// it makes — how to take the dice, what to buy or claim, whether to save,
// where a die is set or a sector swapped — is the one that leaves that number
// highest. Charge cubes are worth a share of what their ability does, and it
// uses an ability as soon as it pays: credits at once, the Armstrong the
// moment it is charged.

export const BOT = {
  credit: 0.3,       // a credit in hand, in VP
  creditLate: 0.36,  // and once the end is near
  income: 0.55,      // a point of income, in credits, for each turn left
  claim: { 1: 2, 2: 4, 3: 6.5 }, // a card claimed free, in VP
  shift: 0.5, double: 1.2, reroll: 0.5, setdie: 0.8, swap: 0.6, buy: 1.6, place: 0.7, exchange: 0.2, win: 25,
  save: 0.9,         // how much a credit kept counts against spending it
  loss: 0.25,        // a VP an opponent loses
};

// turns each player can still expect after this one, from the leader's
// distance to 40; none once the last round is under way
function turnsLeft(G) {
  if (G.ending) return 0;
  const top = Math.max(...G.players.map((q) => q.vp));
  const pace = Math.max(1.2, (top + 4) / (G.round + 1.5));
  return Math.max(0, Math.min(22, (WIN_VP - top) / pace - 1));
}

// A credit is worth what it will buy later: less as the end draws near, and
// nothing on the last turn.
function context(G, w = BOT) {
  const T = turnsLeft(G);
  return { w, T, n: G.n, credit: (T < 4 ? w.creditLate : w.credit) * Math.min(1, T / 2) };
}

// what a cube on a card is worth to its owner
function cubeWorth(G, p, id, side, ctx) {
  const sd = sideOf(id, side);
  if (!sd || !sd.sq || !sd.ab) return 0;
  const cap = capOf(sd.sq, G.n);
  if (cubesOn(p, id) >= cap) return 0;
  const ab = sd.ab;
  const need = needOf(sd.sq, G.n);
  let v = ctx.w[ab.kind] ?? 0.5;
  if (ab.kind === 'gain') v = (ab.cr || 0) * ctx.credit;
  if (ab.kind === 'claim') v = Object.entries(ab.claim).reduce((s, [l, k]) => s + ctx.w.claim[l] * k, 0) * 0.8;
  if (ab.kind === 'buy') v = ctx.w.buy + (ab.cr || 0) * ctx.credit + (ab.vp || 0) + (ab.loss || 0) * ctx.w.loss * (G.n - 1);
  if (ab.kind === 'setdie') v = ctx.w.setdie + (ab.cr || 0) * ctx.credit;
  if (ab.kind === 'reroll') v = ctx.w.reroll + (ab.cr || 0) * ctx.credit;
  if (ab.kind === 'win') v = ctx.w.win * Math.min(1, (cubesOn(p, id) + 1) / need) ** 2;
  return v / need;
}

// One reward's worth, in VP, to a player whose console is `b`. An arrow is
// worth the sector next door, without following it further.
function rewardWorth(G, p, b, id, side, ctx, depth = 0) {
  const c = CARDS[id];
  if (c.kind === 'colony') return 0;
  const sd = c[side];
  const r = sd.r;
  let v = (r.vp || 0) + (r.cr || 0) * ctx.credit + (r.inc || 0) * ctx.credit * ctx.w.income * Math.max(1, ctx.T);
  if (r.claim) v += Object.entries(r.claim).reduce((s, [l, k]) => s + ctx.w.claim[l] * k, 0);
  if (sd.sq) v += cubeWorth(G, p, id, side, ctx);
  if (r.arrow && depth === 0) {
    const s = b.where[id];
    const sides = (r.arrow === 'LR' ? [-1, 1] : [r.arrow === 'L' ? -1 : 1]).map((d) => s + d).filter((t) => t >= 1 && t <= 12);
    v += Math.max(0, ...sides.map((t) => sectorWorth(G, p, b, t, side, ctx, 1)));
  }
  return v;
}

function sectorWorth(G, p, b, s, side, ctx, depth = 0) {
  const ids = side === 'st' ? (b.station[s] != null ? [b.station[s]] : []) : b.deployed[s];
  return ids.reduce((v, id) => v + rewardWorth(G, p, b, id, side, ctx, depth), 0);
}

// a console as a bot reasons about it, with every card's sector at hand
function boardOf(p) {
  const b = { station: p.station.slice(), deployed: p.deployed.map((d) => d.slice()), where: {} };
  for (const s of SECTORS) {
    if (b.station[s] != null) b.where[b.station[s]] = s;
    for (const id of b.deployed[s]) b.where[id] = s;
  }
  return b;
}

// a die face's value pair: the best of each die and the sum, over all 36 rolls
function rollRate(vals) {
  let t = 0;
  for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) t += Math.max(vals[a] + vals[b], vals[a + b]);
  return t / 36;
}

// what a console brings in: per own turn, and per other player's turn
function rates(G, p, b, ctx) {
  const st = [0], dp = [0];
  for (const s of SECTORS) {
    st.push(sectorWorth(G, p, b, s, 'st', ctx));
    dp.push(sectorWorth(G, p, b, s, 'dp', ctx));
  }
  return { own: rollRate(st), opp: rollRate(dp), st, dp };
}

const engineWorth = (G, p, b, ctx) => {
  const r = rates(G, p, b, ctx);
  return ctx.T * r.own + ctx.T * (G.n - 1) * r.opp;
};

// a console after stationing a card at a sector
function boardWith(b, id, sector) {
  const nb = { station: b.station.slice(), deployed: b.deployed.map((d) => d.slice()), where: { ...b.where } };
  const old = nb.station[sector];
  if (old != null) nb.deployed[sector].push(old);
  nb.station[sector] = id;
  nb.where[id] = sector;
  return nb;
}

// What buying (or claiming) a card adds to a console, in VP.
function cardGain(G, p, b, id, ctx, sector = null) {
  const c = CARDS[id];
  const s = sector ?? c.sector;
  const before = engineWorth(G, p, b, ctx);
  const after = engineWorth(G, p, boardWith(b, id, s), ctx);
  return after - before + (c.kind === 'colony' ? c.vp : 0);
}

// how much an outcome of the dice is worth — to the active player, credits
// can still be spent this very turn, even on the last one
function allocWorth(G, p, o, ctx) {
  const credit = isActive(G, p) ? Math.max(ctx.credit, ctx.w.creditLate) : ctx.credit;
  let v = o.gain.vp + o.gain.cr * credit + o.gain.inc * ctx.credit * ctx.w.income * Math.max(1, ctx.T);
  for (const [l, k] of Object.entries(o.gain.claim)) v += ctx.w.claim[l] * k;
  for (const [sid, k] of Object.entries(o.gain.charge)) {
    const id = Number(sid);
    const w = whereOf(p, id);
    if (w) v += Math.min(k, capOf(sideOf(id, w.side).sq, G.n) - cubesOn(p, id) + o.spend.filter((s) => s.id === id).reduce((t, s) => t + s.n, 0)) * cubeWorth(G, p, id, w.side, ctx);
  }
  for (const s of o.spend) {
    const w = whereOf(p, s.id);
    if (w) v -= s.n * Math.max(0.15, cubeWorth(G, { ...p, cubes: { ...p.cubes, [s.id]: 0 } }, s.id, w.side, ctx));
  }
  return v;
}

// the best of each die and the sum for a roll, by station rewards
const rollWorth = (st, a, b) => Math.max(st[a] + st[b], st[a + b]);

function bestBuys(G, p, ids, ctx, credits, sector = null) {
  const b = boardOf(p);
  return ids
    .filter((id) => !buyProblem(G, p, id, credits, sector))
    .map((id) => ({ id, v: cardGain(G, p, b, id, ctx, sector) }))
    .sort((x, y) => y.v - x.v);
}

// the best cards to claim within an allowance, one at a time
function bestClaims(G, p, allowance, ctx) {
  const left = { ...allowance };
  const picks = [];
  let b = boardOf(p);
  for (;;) {
    let best = null;
    for (const id of yardIds(G)) {
      const c = CARDS[id];
      if (picks.includes(id) || !(left[c.level] > 0)) continue;
      if (b.station[c.sector] != null && CARDS[b.station[c.sector]].kind === 'colony') continue;
      const before = engineWorth(G, p, b, ctx);
      const v = engineWorth(G, p, boardWith(b, id, c.sector), ctx) - before;
      if (v > 0.05 && (!best || v > best.v)) best = { id, v };
    }
    if (!best) break;
    picks.push(best.id);
    left[CARDS[best.id].level]--;
    b = boardWith(b, best.id, CARDS[best.id].sector);
  }
  return picks;
}

// a passive bot's moves: only the Armstrong, the moment it is charged
function botAside(G, p) {
  for (const u of usable(G, p)) if (u.kind === 'win') return { kind: 'use', card: u.id };
  return null;
}

export function botChoose(G, seat, weights = BOT) {
  const p = playerBySeat(G, seat);
  if (!p || G.phase === 'over') return null;
  const ctx = context(G, weights);
  const active = isActive(G, p);
  const aside = botAside(G, p);
  if (aside) return aside;
  switch (G.phase) {
    case 'light': {
      if (G.light[seat].picks) return null;
      // buy the ships worth most for their price, while the credits last
      let b = boardOf(p);
      let credits = p.cr;
      const picks = [];
      for (;;) {
        let best = null;
        for (const id of G.light[seat].offer) {
          if (picks.includes(id) || CARDS[id].cost > credits) continue;
          const v = engineWorth(G, p, boardWith(b, id, CARDS[id].sector), ctx) - engineWorth(G, p, b, ctx) - CARDS[id].cost * ctx.credit * 0.7;
          if (v > 0 && (!best || v > best.v)) best = { id, v };
        }
        if (!best) break;
        picks.push(best.id);
        credits -= CARDS[best.id].cost;
        b = boardWith(b, best.id, CARDS[best.id].sector);
      }
      return { kind: 'lightspeed', cards: picks };
    }
    case 'alloc': {
      const a = G.alloc[seat];
      if (a.pick != null) return null;
      let best = 0, bestV = -Infinity;
      a.options.forEach((o, i) => {
        const v = allocWorth(G, p, o, ctx);
        if (v > bestV) { bestV = v; best = i; }
      });
      return { kind: 'alloc', pick: best };
    }
    case 'roll': {
      if (!active) return null;
      // set a die where the rolls are richest
      const sets = usable(G, p).filter((u) => u.kind === 'setdie');
      if (sets.length) {
        const { st } = rates(G, p, boardOf(p), ctx);
        const fixed = G.set.find((v) => v != null);
        let best = null;
        for (let v = 1; v <= 6; v++) {
          let e = 0;
          if (fixed != null) e = rollWorth(st, fixed, v);
          else for (let d = 1; d <= 6; d++) e += rollWorth(st, v, d) / 6;
          if (!best || e > best.e) best = { v, e };
        }
        let free = 0;
        if (fixed != null) for (let d = 1; d <= 6; d++) free += rollWorth(st, fixed, d) / 6;
        else free = rollRate(st);
        if (best.e - free > 0.05) return { kind: 'use', card: sets[0].id, value: best.v };
      }
      return { kind: 'roll' };
    }
    case 'reroll': {
      if (!active) return null;
      const re = usable(G, p).find((u) => u.kind === 'reroll');
      if (re) {
        const { st } = rates(G, p, boardOf(p), ctx);
        const [a, b] = G.dice;
        const now = rollWorth(st, a, b);
        let one = [0, 0];
        for (let d = 1; d <= 6; d++) { one[0] += rollWorth(st, d, b) / 6; one[1] += rollWorth(st, a, d) / 6; }
        const both = rollRate(st);
        const cost = ctx.w.reroll * 0.6;
        const best = Math.max(one[0], one[1], both);
        if (best - now > cost) return { kind: 'use', card: re.id, dice: best === both ? [0, 1] : best === one[0] ? [0] : [1] };
      }
      return { kind: 'keep' };
    }
    case 'claim': {
      if (!active) return null;
      return { kind: 'claim', cards: bestClaims(G, p, G.claim, ctx) };
    }
    case 'buy': {
      if (!active) return null;
      // credits first, so the buys after them can spend them
      const order = ['gain', 'claim', 'place', 'swap', 'buy'];
      const use = usable(G, p).filter((u) => order.includes(u.kind)).sort((x, y) => order.indexOf(x.kind) - order.indexOf(y.kind));
      const b = boardOf(p);
      for (const u of use) {
        const ab = abOf(p, u.id).ab;
        if (u.kind === 'gain') return { kind: 'use', card: u.id };
        if (u.kind === 'claim') {
          const picks = bestClaims(G, p, ab.claim, ctx);
          if (picks.length) return { kind: 'use', card: u.id, cards: picks };
        }
        if (u.kind === 'swap') {
          const nb = { station: b.station.slice(), deployed: b.deployed.map((d) => d.slice()), where: { ...b.where } };
          [nb.station[ab.a], nb.station[ab.b]] = [nb.station[ab.b], nb.station[ab.a]];
          [nb.deployed[ab.a], nb.deployed[ab.b]] = [nb.deployed[ab.b], nb.deployed[ab.a]];
          for (const s of [ab.a, ab.b]) {
            if (nb.station[s] != null) nb.where[nb.station[s]] = s;
            for (const id of nb.deployed[s]) nb.where[id] = s;
          }
          if (engineWorth(G, p, nb, ctx) - engineWorth(G, p, b, ctx) > 0.8) return { kind: 'use', card: u.id };
        }
        if (u.kind === 'place') {
          let best = null;
          for (const { id, side } of boardCards(p)) {
            if (id === u.id || placeProblem(G, p, id, u.id)) continue;
            const v = cubeWorth(G, p, id, side, ctx);
            if (v > 0.2 && (!best || v > best.v)) best = { id, v };
          }
          if (best) return { kind: 'use', card: u.id, target: best.id };
        }
        if (u.kind === 'buy') {
          const credits = p.cr + (ab.cr || 0);
          const sectors = ab.high ? [7, 8, 9, 10, 11, 12] : [null];
          let best = null;
          for (const s of sectors) {
            const ids = [...yardIds(G), ...(ab.high ? [] : G.colonies)];
            const top = bestBuys(G, p, ids, ctx, credits, s)[0];
            if (top && top.v - CARDS[top.id].cost * ctx.credit * 0.5 > 0.3 && (!best || top.v > best.v)) best = { ...top, s };
          }
          if (best) return { kind: 'use', card: u.id, cards: [best.id], ...(ab.high ? { sector: best.s } : {}) };
          if (ab.loss && G.n > 1) return { kind: 'use', card: u.id, cards: [] };
        }
      }
      if (!G.bought) {
        const top = bestBuys(G, p, [...yardIds(G), ...G.colonies], ctx, p.cr)[0];
        // buying spends every credit: worth it if the card brings more than
        // the credits would be worth kept for a better one
        if (top && top.v > p.cr * ctx.credit * ctx.w.save) return { kind: 'buy', card: top.id };
      }
      return { kind: 'end' };
    }
    default:
      return null;
  }
}

// whether a bot not being waited on has something to do anyway
export function botAsideMove(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p || G.phase === 'over') return null;
  return botAside(G, p);
}
