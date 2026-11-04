// Space Base's rules, checked on tables set up by hand — the Field Manuals'
// own worked examples among them: the setup, taking the dice, arrows and
// their loops, charge squares and their pips, every kind of ability, buying,
// colonies, income, the end and its tie, Light-Speed, and what views show.
import * as M from './game.js';

let pass = 0, fail = 0;
const ok = (cond, what) => {
  if (cond) pass++;
  else {
    fail++;
    console.log('  FAIL', what);
  }
};
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const idOf = (name) => {
  const c = M.CARDS.find((x) => x.name.includes(name));
  if (!c) throw new Error(`no card ${name}`);
  return c.id;
};
const roster = (n) => Array.from({ length: n }, (_, i) => ({ seat: i, name: `P${i}` }));

// A table of n with every console back to its twelve starting ships, no
// credits, the first player to move and nothing rolled.
function table(n = 2, opts = {}) {
  const G = M.newGame(roster(n), opts);
  for (const p of G.players) {
    for (const s of M.SECTORS) {
      p.station[s] = s - 1;
      p.deployed[s] = [];
    }
    p.cubes = {};
    p.cr = 0;
    p.inc = 0;
    p.vp = 0;
  }
  G.turn = 0;
  G.first = 0;
  G.round = 1;
  G.phase = 'roll';
  G.set = [null, null];
  G.dice = null;
  G.bought = false;
  G.ending = null;
  G.log = [];
  return G;
}
// station a card at its sector (or another), deploying the one there
function put(G, p, name, sector = null) {
  const id = typeof name === 'number' ? name : idOf(name);
  const s = sector ?? M.CARDS[id].sector;
  if (p.station[s] != null) p.deployed[s].push(p.station[s]);
  p.station[s] = id;
  for (const l of M.LEVELS) G.yard[l] = G.yard[l].map((x) => (x === id ? null : x));
  for (const l of M.LEVELS) G.decks[l] = G.decks[l].filter((x) => x !== id);
  return id;
}
// a card deployed at its sector, under whatever is stationed there
function deploy(G, p, name, sector = null) {
  const id = idOf(name);
  p.deployed[sector ?? M.CARDS[id].sector].push(id);
  for (const l of M.LEVELS) G.decks[l] = G.decks[l].filter((x) => x !== id);
  for (const l of M.LEVELS) G.yard[l] = G.yard[l].map((x) => (x === id ? null : x));
  return id;
}
const roll = (G, a, b) => {
  G.set = [a, b];
  const r = M.applyMove(G, G.players[G.turn].seat, { kind: 'roll' });
  if (!r.ok) throw new Error(r.error);
};
const opts = (G, seat) => G.alloc[seat].options;
// everyone still choosing takes their first way, unless told otherwise
function settle(G, picks = {}) {
  if (G.phase !== 'alloc') return;
  for (const p of G.players) {
    if (G.alloc[p.seat].pick != null) continue;
    const r = M.applyMove(G, p.seat, { kind: 'alloc', pick: picks[p.seat] ?? 0 });
    if (!r.ok) throw new Error(r.error);
  }
}
const gains = (o) => ({ cr: o.gain.cr, inc: o.gain.inc, vp: o.gain.vp });
const move = (G, seat, m) => M.applyMove(G, seat, m);
// put a card in the shipyard, in place of one there
function toYard(G, name) {
  const id = idOf(name);
  const l = M.CARDS[id].level;
  if (G.yard[l].includes(id)) return id;
  G.decks[l] = G.decks[l].filter((x) => x !== id);
  G.yard[l][0] = id;
  return id;
}

// ---------------------------------------------------------------- the cards
{
  const levels = [0, 1, 2, 3].map((l) => M.CARDS.filter((c) => c.level === l).length);
  eq(levels, [12, 48, 48, 36], 'twelve starting ships, 48 + 48 + 36 in the shipyard');
  eq(M.CARDS.filter((c) => c.kind === 'colony').map((c) => [c.cost, c.sector, c.vp]).slice(0, 3), [[9, 1, 3], [12, 2, 4], [15, 3, 5]], 'colonies: 9 for 3 VP in sector 1, +3 and +1 a sector');
  eq(M.CARDS.filter((c) => c.kind === 'colony').map((c) => c.vp).at(-1), 14, 'the Friedman Colony, 14 VP');
  for (const l of [1, 2, 3]) {
    const bySector = M.SECTORS.map((s) => M.CARDS.filter((c) => c.level === l && c.sector === s).length);
    ok(bySector.every((k) => k >= 1), `level ${l} has a ship for every sector`);
  }
  const h = M.CARDS[idOf('Hartsfield')];
  eq([h.cost, h.sector, h.st.r.cr, h.dp.r.cr], [2, 9, 6, 4], 'the Field Manual’s buying example, the Hartsfield: 2, sector 9, 6 and 4 credits');
  const bl = M.CARDS[idOf('Bluford')];
  eq([bl.st.r.vp, bl.st.r.arrow, bl.dp.r.vp, bl.dp.r.arrow], [3, 'L', 1, 'L'], 'the Bluford: 3 VP and the sector to the left, 1 VP deployed');
}

// ---------------------------------------------------------------- charge squares and their pips
{
  const sq = (name, side = 'st') => M.CARDS[idOf(name)][side].sq;
  eq([2, 3, 4, 5].map((n) => M.capOf(sq('Kubasov'), n)), [4, 3, 2, 2], 'the Field Manual’s pips example (Kubasov): all four at 2, three at 3, the top two at 4 or 5');
  eq([2, 3, 4, 5].map((n) => M.needOf(sq('Kubasov'), n)), [4, 3, 2, 2], 'linked squares are all needed');
  eq([2, 3, 4, 5].map((n) => M.needOf(sq('Yeliseyev'), n)), [3, 3, 2, 2], 'three linked, the third at two or three players');
  eq([2, 3, 4, 5].map((n) => M.needOf(sq('Armstrong'), n)), [5, 4, 3, 3], 'the Armstrong: five at 2, four at 3, three at 4–5');
  eq([M.capOf(sq('Volynov'), 3), M.needOf(sq('Volynov'), 3)], [3, 1], 'separate squares: a reserve of three, one cube a use');
  eq([M.capOf(sq('Volynov', 'dp'), 3), M.needOf(sq('Volynov', 'dp'), 3)], [2, 1], 'the Volynov deployed: two separate squares, as pictured');
  eq(M.needOf(sq('Gardner', 'dp'), 4), 2, 'a Williamson deployed: two linked');
}

// ---------------------------------------------------------------- setup
for (const n of [2, 3, 4, 5]) {
  const G = M.newGame(roster(n));
  eq(G.phase, 'roll', `${n}: the first turn begins`);
  const drawn = G.players.map((p) => M.SECTORS.map((s) => p.station[s]).find((id) => M.CARDS[id].level === 1));
  ok(drawn.every((id) => id != null), `${n}: everyone has drawn and bought a level 1 ship`);
  const top = Math.max(...drawn.map((id) => M.CARDS[id].sector));
  eq(M.CARDS[drawn[G.first]].sector, top, `${n}: the highest sector goes first`);
  const bonus = [{ cr: 0, inc: 0 }, { cr: 1, inc: 0 }, { cr: 2, inc: 0 }, { cr: 0, inc: 1 }, { cr: 0, inc: 1 }];
  for (let k = 0; k < n; k++) {
    const i = (G.first + k) % n;
    const p = G.players[i];
    eq([p.cr, p.inc, p.vp], [5 - M.CARDS[drawn[i]].cost + bonus[k].cr, bonus[k].inc, 0], `${n}: player ${k + 1}'s credits, income and VP`);
  }
  eq(M.LEVELS.map((l) => G.yard[l].filter((x) => x != null).length), [6, 6, 6], `${n}: six face up a level`);
  eq(M.LEVELS.map((l) => G.decks[l].length), [42 - n, 42, 30], `${n}: the decks`);
  ok(G.players.every((p) => M.SECTORS.every((s) => p.station[s] != null)), `${n}: a ship in every sector`);
}
eq([M.canStart(1) != null, M.canStart(2), M.canStart(5), M.canStart(6) != null], [true, null, null, true], 'two to five players');

// ---------------------------------------------------------------- taking the dice
{
  // 2023: "This die roll is a 1, and a 5 or a total sum of 6. Gain 1 and 5 rewards... or sector 6 reward."
  const G = table(2);
  const [a, b] = G.players;
  roll(G, 1, 5);
  const o = opts(G, 0);
  eq(o.length, 1, 'starting ships: each die (2 credits) beats the sum (1) — taken for the active player');
  eq([o[0].mode, o[0].acts], ['each', [1, 5]], 'each die: sectors 1 and 5');
  eq(G.phase, 'buy', 'with every choice made for them, the rewards are taken and the buy follows');
  eq([a.cr, b.cr], [2, 0], 'the active player gains the station rewards; the other has nothing deployed');
}
{
  // doubles taken separately pay twice
  const G = table(2);
  put(G, G.players[0], 'Kizim'); // sector 4: 1 VP stationed
  roll(G, 4, 4);
  const o = opts(G, 0);
  const each = o.find((x) => x.mode === 'each');
  eq(each && gains(each), { cr: 0, inc: 0, vp: 2 }, 'a double 4 taken separately: sector 4 twice');
}
{
  // 2018: "If you are a passive player and the active player rolled a 5 and a 6,
  // you may choose to take the sector 11 reward for 4 or both the sector 5 and 6
  // rewards for a total of 3 — 2 from 5 and 1 from 6."
  const G = table(2);
  const b = G.players[1];
  deploy(G, b, 'Atkov', 5);
  deploy(G, b, 'Truly', 5);
  deploy(G, b, 'Sharma', 6);
  deploy(G, b, 'Volk', 11);
  roll(G, 5, 6);
  const o = opts(G, 1);
  eq(o.map((x) => [x.mode, gains(x).cr]), [['sum', 4]], 'the passive example: the sum (4) beats each die (3), and is taken');
  settle(G);
  eq(b.cr, 4, 'deployed rewards: every card deployed in the sector');
}
{
  // a real choice is left to the player
  const G = table(2);
  const b = G.players[1];
  deploy(G, b, 'Kizim', 4); // 1 credit deployed
  deploy(G, b, 'Bobko', 9); // 2 VP deployed
  deploy(G, b, 'Hartsfield', 3); // 4 credits deployed, at sector 3 here
  roll(G, 3, 6);
  const o = opts(G, 1);
  eq(o.map((x) => [x.mode, gains(x)]), [['each', { cr: 4, inc: 0, vp: 0 }], ['sum', { cr: 0, inc: 0, vp: 2 }]], 'credits or VP: both offered');
  eq(G.phase, 'alloc', 'the table waits for the choice');
  eq(M.waitingOn(G), [0, 1], 'on the players who have one — the active player too (2 credits, or 1 income)');
  move(G, 0, { kind: 'alloc', pick: 0 });
  eq(M.waitingOn(G), [1], 'then on the one left');
  ok(!move(G, 1, { kind: 'alloc', pick: 5 }).ok, 'no such choice');
  ok(move(G, 1, { kind: 'alloc', pick: 1 }).ok, 'the sum, chosen');
  eq([b.vp, b.cr, G.phase], [2, 0, 'buy'], '2 VP, and the turn moves on');
  ok(!move(G, 1, { kind: 'alloc', pick: 0 }).ok, 'no second choice');
}

// ---------------------------------------------------------------- arrows
{
  // 2018: "if you rolled a 7 you would gain 1 and then also gain your 8 sector
  // rewards. Your 8 sector reward lets you gain your 7 or 9 sector reward,
  // however, since you've already gained your 7 sector reward ... you would
  // want to gain your 9 sector rewards."
  const G = table(2);
  const a = G.players[0];
  put(G, a, 'Merbold'); // 7: 1 credit and the sector to the right
  put(G, a, 'Lichtenberg'); // 8: either side
  roll(G, 3, 4);
  const sum = opts(G, 0).filter((o) => o.mode === 'sum');
  eq(sum.length, 1, 'pointing back at 7 gains nothing again, so only the way to 9 is left');
  eq([gains(sum[0]), sum[0].arrows.map((x) => x.to)], [{ cr: 1, inc: 1, vp: 0 }, [9]], 'the loop example: 1 credit, then 8, which points to 9 (van Hoften, 1 income)');
}
{
  // 2018: deployed in sector 10, "you would gain the rewards for ALL cards
  // deployed in your 10 sector as usual ... and ... ALL the rewards for cards
  // deployed in your 9 sector or in your 11 sector"
  const G = table(2);
  const b = G.players[1];
  deploy(G, b, 'Shaw', 10); // both ways
  deploy(G, b, 'Serebrov', 10); // 5 credits deployed
  deploy(G, b, 'Bobko', 9); // 2 VP
  deploy(G, b, 'Savitskaya', 11); // 6 credits
  roll(G, 4, 6);
  const sum = opts(G, 1).filter((o) => o.mode === 'sum');
  eq(sum.map((o) => [gains(o), o.arrows[0].to]).sort(), [[{ cr: 11, inc: 0, vp: 0 }, 11], [{ cr: 5, inc: 0, vp: 2 }, 9]].sort(), 'a two-way arrow deployed: everything in 10, and everything in 9 or in 11 — both offered');
}
{
  // the Bluford at 12: 3 VP and the sector to its left
  const G = table(2);
  const a = G.players[0];
  put(G, a, 'Bluford');
  roll(G, 6, 6);
  const sum = opts(G, 0).find((o) => o.mode === 'sum');
  eq(gains(sum), { cr: 0, inc: 1, vp: 3 }, 'the Bluford: 3 VP, and sector 11’s station reward (1 income)');
}
{
  // arrows and separate dice: each die's chain pays a card once
  const G = table(2);
  const a = G.players[0];
  put(G, a, 'Lichtenberg'); // 8
  put(G, a, 'Parker'); // 9: either side
  // with each die, the two chains are separate: a card pays once in each
  roll(G, 4, 4);
  ok(opts(G, 0).every((o) => o.mode !== 'each' || gains(o).cr === 2), 'doubles 4: sector 4 twice, 1 credit each');
}

// ---------------------------------------------------------------- dice and arrows, and the 2x
{
  const G = table(2);
  const b = G.players[1];
  const w = deploy(G, b, 'Gardner', 6); // deployed: two linked squares, sum +1
  b.cubes[w] = 2;
  deploy(G, b, 'Hartsfield', 10); // 4 credits deployed, here at 10
  roll(G, 4, 5);
  const o = opts(G, 1);
  const up = o.find((x) => x.shift === 1);
  ok(!!up, 'a charged Williamson raises the sum by 1');
  eq([up.acts, gains(up), up.spend], [[10], { cr: 4, inc: 0, vp: 0 }, [{ id: w, n: 2 }]], 'the sum 9 becomes 10, and its two linked cubes are spent');
  settle(G, { 1: o.indexOf(up) });
  eq([b.cr, b.cubes[w] || 0], [4, 0], 'paid, and spent');
}
{
  // 2018's example: double 4, two single arrows and a double one charged —
  // take the sum and spend one of each to go from 8 to 11
  const G = table(2);
  const b = G.players[1];
  const w1 = deploy(G, b, 'Fabian', 1);
  const w2 = deploy(G, b, 'Ride', 2);
  b.cubes[w1] = 2;
  b.cubes[w2] = 2;
  const h = put(G, b, 'Khrunov'); // stationed at 2: +1 or +2
  b.cubes[h] = 1;
  deploy(G, b, 'Volk', 11); // 4 credits deployed
  roll(G, 4, 4);
  const o = opts(G, 1);
  const eleven = o.find((x) => x.acts[0] === 11);
  ok(!!eleven && eleven.shift === 3, 'a shift of 3 is on offer, to sector 11');
  eq(gains(eleven), { cr: 4, inc: 0, vp: 0 }, 'and gains the 4 from sector 11');
  ok(!o.some((x) => x.mode === 'sum' && x.acts[0] > 12), 'never past 12');
  eq(eleven.spend.reduce((s, x) => s + x.n, 0), 3, 'the cheapest way: the double arrow (1 cube) and one single (2)');
}
{
  // 2018: "If a 2 and 3 were rolled ... you could choose to take the reward from
  // either your 2 or 3 sector a second time. If you took the sum for a 5, this
  // ability would let you gain your 5 sector reward twice."
  const G = table(2);
  const a = G.players[0];
  const ak = put(G, a, 'Aksyonov'); // 8: the 2x, stationed
  a.cubes[ak] = 1;
  put(G, a, 'Romanenko'); // 2: 2 credits
  put(G, a, 'Chang-Diaz'); // 3: 2 credits
  put(G, a, 'Strekalov'); // 5: 1 VP
  roll(G, 2, 3);
  const o = opts(G, 0);
  const each2 = o.find((x) => x.mode === 'each' && x.dbl && x.dbl.sector === 2);
  const sum2 = o.find((x) => x.mode === 'sum' && x.dbl);
  ok(!!each2 && gains(each2).cr === 6, 'each die, with sector 2 doubled: 2 + 2 + 2');
  ok(!!sum2 && gains(sum2).vp === 2, 'the sum 5, doubled: 1 VP twice');
  ok(!o.some((x) => x.mode === 'each' && x.dbl && x.dbl.sector === 3), 'doubling 3 instead is the same, and offered once');
  ok(o.every((x) => !x.dbl || x.spend.some((s) => s.id === ak)), 'the 2x spends its cube');
}
{
  // 2018: "If a 5 and 6 were rolled on your opponent's turn and you allocated the
  // dice individually, you could use this ability to gain the rewards for sector
  // 5 twice, thus placing a cube and gaining the 3 credits from sector 5 twice
  // (for a total of 6 credits and 2 cubes being placed), but you would not gain
  // the 2 credits from the 6 sector a second time."
  const G = table(2);
  const b = G.players[1];
  const ak = deploy(G, b, 'Aksyonov', 6); // deployed: the passive 2x
  b.cubes[ak] = 1;
  deploy(G, b, 'Scobee', 5); // 2 credits deployed... with another 1 below to make 3
  deploy(G, b, 'Atkov', 5); // 1 credit
  const w = deploy(G, b, 'Truly', 6); // 1 credit deployed
  deploy(G, b, 'Sharma', 6); // 1 credit
  const h = deploy(G, b, 'Khrunov', 5); // a cube on 5
  roll(G, 5, 6);
  const o = opts(G, 1);
  const d5 = o.find((x) => x.mode === 'each' && x.dbl && x.dbl.sector === 5);
  eq(d5 && [gains(d5).cr, d5.gain.charge[h]], [3 + 3 + 2, 2], 'the deployed 2x example: sector 5 twice (3 + 3 credits, two cubes), sector 6 once (2)');
  ok(w != null, 'set up');
}
{
  // the 2x doubling its own sector: the others there pay twice, and it is
  // charged once — it "can never be used to charge itself"
  const G = table(2);
  const b = G.players[1];
  const ak = deploy(G, b, 'Aksyonov', 8);
  b.cubes[ak] = 1;
  deploy(G, b, 'Lenoir', 8); // 2 credits and 1 VP deployed
  roll(G, 4, 4);
  const d = opts(G, 1).find((x) => x.mode === 'sum' && x.dbl);
  eq(d ? [gains(d), d.gain.charge[ak]] : 'none', [{ cr: 4, inc: 0, vp: 2 }, 1], 'sector 8 doubled: the Lenoir twice, one cube back on the Aksyonov');
  ok(!opts(G, 1).some((x) => x.mode === 'sum' && !x.dbl), 'which beats the sum undoubled, now the cube comes straight back');
}

// ---------------------------------------------------------------- charges
{
  const G = table(2);
  const a = G.players[0];
  const v = put(G, a, 'Volynov'); // 3: three separate squares
  roll(G, 3, 3);
  // each die: sector 3 twice
  const each = opts(G, 0).find((x) => x.mode === 'each');
  if (G.phase === 'alloc') move(G, 0, { kind: 'alloc', pick: opts(G, 0).indexOf(each) });
  eq(a.cubes[v], 2, 'two activations, two cubes');
}
{
  const G = table(2);
  const a = G.players[0];
  const k = put(G, a, 'Khrunov'); // 2: one square
  a.cubes[k] = 1;
  roll(G, 1, 1);
  eq(a.cubes[k], 1, 'a full card takes no more cubes');
}
{
  // 2018: "Your U.E.S Khrunov is being deployed and has one cube on its station
  // ability. After the card is deployed you may move that cube to its deploy ability."
  const G = table(2);
  const a = G.players[0];
  const k = put(G, a, 'Khrunov');
  a.cubes[k] = 1;
  G.phase = 'buy';
  a.cr = 10;
  const r = toYard(G, 'Romanenko'); // sector 2
  ok(move(G, 0, { kind: 'buy', card: r }).ok, 'bought over the Khrunov');
  eq([a.deployed[2].includes(k), a.cubes[k]], [true, 1], 'the Khrunov is deployed, its cube moved to the deployed side');
  const v = put(G, a, 'Volynov'); // three squares stationed, two deployed
  a.cubes[v] = 3;
  a.cr = 10;
  G.bought = false;
  const c = toYard(G, 'Chang-Diaz');
  move(G, 0, { kind: 'buy', card: c });
  eq(a.cubes[v], 2, 'a deployed side with less room keeps what fits');
}

// ---------------------------------------------------------------- buying
{
  const G = table(2);
  const a = G.players[0];
  G.phase = 'buy';
  a.cr = 9;
  const h = toYard(G, 'Hartsfield');
  ok(!move(G, 1, { kind: 'buy', card: h }).ok, 'only the active player buys');
  ok(move(G, 0, { kind: 'buy', card: h }).ok, 'the Hartsfield, for 2');
  eq([a.cr, a.station[9], a.deployed[9].length], [0, h, 1], '"you must spend all of your credits"; stationed at 9, and van Hoften deployed');
  eq(G.yard[1].includes(h), false, 'gone from the shipyard');
  ok(!move(G, 0, { kind: 'buy', card: G.yard[1].find((x) => x != null) }).ok, 'one buy a turn');
  const expensive = toYard(G, 'Shatalov');
  G.bought = false;
  a.cr = 5;
  ok(!move(G, 0, { kind: 'buy', card: expensive }).ok, 'not past your credits');
  // the gap stays until the end of the turn, then the row is refilled
  const gaps = G.yard[1].filter((x) => x == null).length;
  ok(gaps >= 1, 'the bought card leaves a gap');
  move(G, 0, { kind: 'end' });
  eq(G.yard[1].filter((x) => x == null).length, 0, 'refilled at the end of the turn');
  eq([G.turn, G.phase], [1, 'roll'], 'and the next player rolls');
}
{
  // income
  const G = table(2);
  const a = G.players[0];
  G.phase = 'buy';
  a.cr = 2;
  a.inc = 5;
  move(G, 0, { kind: 'end' });
  eq(a.cr, 5, 'credits below income rise to it at the end of your turn');
  const b = G.players[1];
  b.cr = 9;
  b.inc = 4;
  G.phase = 'buy';
  move(G, 1, { kind: 'end' });
  eq(b.cr, 9, 'credits above income are kept');
}
{
  // colonies
  const G = table(2);
  const a = G.players[0];
  const b = G.players[1];
  G.phase = 'buy';
  a.cr = 30;
  const myrdal = idOf('Myrdal');
  ok(move(G, 0, { kind: 'buy', card: myrdal }).ok, 'a colony, for 30');
  eq([a.vp, a.cr, a.station[8], a.deployed[8].length, G.colonies.includes(myrdal)], [10, 0, myrdal, 1, false], '10 VP at once; stationed, the Nelson deployed; never replaced');
  move(G, 0, { kind: 'end' });
  // on b's turn a's deployed ship in 8 still pays a
  roll(G, 4, 4);
  const sum = opts(G, 0).find((o) => o.mode === 'sum');
  eq(sum && gains(sum).cr, 2, 'the ships deployed in a colony’s sector still pay on others’ turns');
  if (G.phase === 'alloc') for (const p of G.players) if (G.alloc[p.seat].pick == null) move(G, p.seat, { kind: 'alloc', pick: 0 });
  move(G, 1, { kind: 'end' });
  roll(G, 4, 4);
  const mine = opts(G, 0).find((o) => o.mode === 'sum');
  ok(!mine || gains(mine).cr === 0, 'and the colony pays nothing on your own roll');
  if (G.phase === 'alloc') for (const p of G.players) if (G.alloc[p.seat].pick == null) move(G, p.seat, { kind: 'alloc', pick: 0 });
  a.cr = 20;
  const ship8 = toYard(G, 'Lenoir'); // sector 8
  eq(move(G, 0, { kind: 'buy', card: ship8 }).ok, false, 'nothing more goes into a colony’s sector');
  ok(b.vp === 0, 'set up');
}

// ---------------------------------------------------------------- abilities
{
  // set a die
  const G = table(2);
  const a = G.players[0];
  const g = put(G, a, 'Gagarin'); // two separate squares; +1 credit
  a.cubes[g] = 2;
  ok(move(G, 0, { kind: 'use', card: g, value: 6 }).ok, 'set a die to 6');
  eq([G.set, a.cr], [[6, null], 1], 'one die set, 1 credit');
  ok(move(G, 0, { kind: 'use', card: g, value: 6 }).ok, 'and the other');
  ok(!move(G, 0, { kind: 'use', card: g, value: 6 }).ok, 'no cube left');
  move(G, 0, { kind: 'roll' });
  eq(G.dice, [6, 6], 'both dice set');
  const b = G.players[1];
  const t = put(G, b, 'Titov');
  b.cubes[t] = 1;
  ok(!move(G, 1, { kind: 'use', card: t, value: 3 }).ok, 'a blue ability is for your own turn');
}
{
  // reroll
  const G = table(2);
  const a = G.players[0];
  const v = put(G, a, 'Volynov');
  a.cubes[v] = 2;
  roll(G, 1, 2);
  eq(G.phase, 'reroll', 'with a charged reroll, the roll waits');
  ok(move(G, 0, { kind: 'use', card: v, dice: [0, 1] }).ok, 'roll both again');
  eq([a.cubes[v], a.cr], [1, 1], 'one cube spent, 1 credit gained');
  ok(G.phase === 'reroll', 'still a cube: another reroll could follow');
  ok(move(G, 0, { kind: 'keep' }).ok, 'keep');
  ok(G.phase !== 'reroll', 'and the dice are taken');
}
{
  // swap sectors: at a table of four, the Yeliseyev's third square does not count
  const G = table(4);
  const a = G.players[0];
  const y = put(G, a, 'Yeliseyev'); // at 1
  deploy(G, a, 'Bobko', 6);
  a.cubes[y] = 2;
  const six = a.station[6];
  const seven = a.station[7];
  ok(move(G, 0, { kind: 'use', card: y }).ok, 'two cubes are enough at four players');
  eq([a.station[6], a.station[7], a.deployed[7].length, a.deployed[6].length], [seven, six, 1, 0], 'sectors 6 and 7 trade places, deployed cards too');
  // "Any cards you buy during future turns are still placed according to their sector number"
  G.phase = 'buy';
  a.cr = 10;
  const c = toYard(G, 'Ivanchenkov'); // printed sector 6
  move(G, 0, { kind: 'buy', card: c });
  eq([a.station[6], a.deployed[6]], [c, [seven]], 'a ship bought for 6 still goes to 6');
}
{
  // buy a card: the ability's credits first, then just the price
  const G = table(2);
  const a = G.players[0];
  const s = put(G, a, 'Sarafanov'); // +4 credits and a buy
  a.cubes[s] = 1;
  a.cr = 3;
  G.phase = 'buy';
  const c = toYard(G, 'Glazkov'); // costs 7
  ok(move(G, 0, { kind: 'use', card: s, cards: [c] }).ok, '3 + 4 buys a 7');
  eq([a.cr, a.station[11]], [0, c], 'only the price is spent');
  ok(!G.bought, 'and the normal buy is still to come');
}
{
  // Gordon: every other player loses 4 VP, never below 0; buy up to two
  const G = table(3);
  const [a, b, c] = G.players;
  const g = put(G, a, 'Gordon');
  a.cubes[g] = 1;
  b.vp = 10;
  c.vp = 2;
  a.cr = 8;
  G.phase = 'buy';
  const x = toYard(G, 'Hartsfield');
  const y = toYard(G, 'Worden');
  ok(!move(G, 0, { kind: 'use', card: g, cards: [x, y] }).ok, '2 + 7 is more than 8 credits');
  eq([b.vp, a.cubes[g]], [10, 1], 'and a refused use changes nothing');
  a.cr = 9;
  const r = move(G, 0, { kind: 'use', card: g, cards: [x, y] });
  ok(r.ok, `Gordon buys two: ${r.error || ''}`);
  eq([b.vp, c.vp, a.cr], [6, 0, 0], 'the others lose 4 VP — never below 0 — and 2 + 7 is spent');
}
{
  // Scott: a ship into any sector from 7 to 12, not a colony
  const G = table(2);
  const a = G.players[0];
  const sc = put(G, a, 'Scott');
  a.cubes[sc] = 1;
  a.cr = 5;
  G.phase = 'buy';
  const k = toYard(G, 'Kizim'); // printed for 4
  ok(!move(G, 0, { kind: 'use', card: sc, cards: [k], sector: 5 }).ok, 'only 7 to 12');
  ok(!move(G, 0, { kind: 'use', card: sc, cards: [idOf('Frisch')], sector: 7 }).ok, 'not a colony');
  ok(move(G, 0, { kind: 'use', card: sc, cards: [k], sector: 12 }).ok, 'the Kizim into 12');
  eq([a.station[12], a.cr], [k, 3], 'stationed at 12, for its price');
}
{
  // claim: Kovalyonok takes up to three level 1 ships, free
  const G = table(2);
  const a = G.players[0];
  const kv = put(G, a, 'Kovalyonok');
  a.cubes[kv] = 1;
  G.phase = 'buy';
  const ids = G.yard[1].slice(0, 3);
  const l2 = G.yard[2][0];
  ok(!move(G, 0, { kind: 'use', card: kv, cards: [l2] }).ok, 'only level 1');
  ok(move(G, 0, { kind: 'use', card: kv, cards: ids }).ok, 'three level 1 ships');
  ok(ids.every((id) => a.station.includes(id) || M.SECTORS.some((s) => a.deployed[s].includes(id))), 'on the console');
  eq([a.cr, G.bought], [0, false], 'free, and not a buy');
}
{
  // a claim as a reward: the Tereshkova stationed at 8
  const G = table(2);
  const a = G.players[0];
  put(G, a, 'Tereshkova');
  roll(G, 4, 4);
  const sum = opts(G, 0).find((o) => o.mode === 'sum');
  if (G.phase === 'alloc') move(G, 0, { kind: 'alloc', pick: opts(G, 0).indexOf(sum) });
  eq([G.phase, G.claim], ['claim', { 1: 2 }], 'a claim reward waits for the cards to be chosen');
  const two = G.yard[1].slice(0, 2);
  ok(!move(G, 0, { kind: 'claim', cards: [...two, G.yard[1][2]] }).ok, 'no more than allowed');
  ok(move(G, 0, { kind: 'claim', cards: two }).ok, 'two claimed');
  eq(G.phase, 'buy', 'then the buy');
}
{
  // place a charge: Glenn (two linked) puts one on another ship with room
  const G = table(2);
  const a = G.players[0];
  const gl = put(G, a, 'Glenn');
  const k = put(G, a, 'Khrunov');
  a.cubes[gl] = 2;
  G.phase = 'buy';
  ok(!move(G, 0, { kind: 'use', card: gl, target: gl }).ok, 'not on itself');
  ok(!move(G, 0, { kind: 'use', card: gl, target: a.station[1] }).ok, 'not on a ship without squares');
  ok(move(G, 0, { kind: 'use', card: gl, target: k }).ok, 'on the Khrunov');
  eq([a.cubes[gl] || 0, a.cubes[k]], [0, 1], 'both cubes spent, one placed');
  // it is green: on another player's turn too, before the roll
  G.turn = 1;
  G.phase = 'roll';
  a.cubes[gl] = 2;
  delete a.cubes[k];
  ok(move(G, 0, { kind: 'use', card: gl, target: k }).ok, 'green: on the other player’s turn');
  // not between the roll and the rewards
  a.cubes[gl] = 2;
  delete a.cubes[k];
  G.phase = 'alloc';
  ok(!move(G, 0, { kind: 'use', card: gl, target: k }).ok, 'not while the dice are being taken');
}
{
  // Collins: place one, then move one
  const G = table(2);
  const a = G.players[0];
  const co = put(G, a, 'Collins');
  const k = put(G, a, 'Khrunov');
  const v = put(G, a, 'Volynov');
  a.cubes[co] = 1;
  a.cubes[v] = 1;
  G.phase = 'buy';
  ok(!move(G, 0, { kind: 'use', card: co, target: k, from: v, to: co }).ok, 'not moved back onto itself');
  ok(move(G, 0, { kind: 'use', card: co, target: k, from: k, to: v }).ok, 'placed on the Khrunov and moved on to the Volynov');
  eq([a.cubes[co] || 0, a.cubes[k] || 0, a.cubes[v]], [0, 0, 2], 'net: one more cube, on the Volynov');
}
{
  // exchange: Zudov deployed trades places with a stationed card
  const G = table(2);
  const a = G.players[0];
  const z = deploy(G, a, 'Zudov', 9);
  a.cubes[z] = 1;
  const four = a.station[4];
  G.phase = 'roll';
  ok(move(G, 0, { kind: 'use', card: z, target: four }).ok, 'before the roll');
  eq([a.station[4], a.deployed[9].includes(four), a.deployed[9].includes(z)], [z, true, false], 'the Zudov is stationed at 4, the 4’s ship deployed at 9');
  ok(!move(G, 0, { kind: 'use', card: z, target: idOf('Frisch') }).ok, 'and no cube left');
}
{
  // the Armstrong
  const G = table(2);
  const [a, b] = G.players;
  const ar = put(G, b, 'Armstrong');
  b.cubes[ar] = 4;
  ok(!move(G, 1, { kind: 'use', card: ar }).ok, 'four cubes are not five, at two players');
  b.cubes[ar] = 5;
  ok(move(G, 1, { kind: 'use', card: ar }).ok, 'five: on the other player’s turn — it is green');
  eq([G.phase, G.winners], ['over', [1]], '"the game ends immediately and you win"');
  ok(a.vp === 0, 'set up');
}
{
  // colours: a red ability is for the others' turns; shifts and the 2x only with the dice
  const G = table(2);
  const b = G.players[1];
  const ak = deploy(G, b, 'Aksyonov', 8);
  b.cubes[ak] = 1;
  G.phase = 'roll';
  ok(!!M.useProblem(G, b, ak), 'the 2x is used as the dice are taken');
  const w = deploy(G, b, 'Gardner', 6);
  b.cubes[w] = 2;
  ok(!!M.useProblem(G, b, w), 'and so is the sum +1');
}

// ---------------------------------------------------------------- the end
{
  const G = table(3);
  const [a, b, c] = G.players;
  G.first = 1;
  G.turn = 1;
  b.vp = 41;
  G.phase = 'buy';
  move(G, 1, { kind: 'end' });
  ok(G.ending && G.ending.seat === 1, 'reaching 40 triggers the end');
  eq([G.phase, G.turn], ['roll', 2], 'the round goes on');
  G.phase = 'buy';
  move(G, 2, { kind: 'end' });
  eq(G.phase, 'roll', 'still on');
  a.vp = 39;
  G.phase = 'buy';
  move(G, 0, { kind: 'end' });
  eq([G.phase, G.winners], ['over', [1]], '"the player sitting to the right of the starting player will take the last turn"');
}
{
  // reached on another player's turn
  const G = table(2);
  const b = G.players[1];
  const bob = deploy(G, b, 'Bobko', 9);
  b.vp = 38;
  roll(G, 4, 5);
  const sum = opts(G, 1).find((o) => o.mode === 'sum');
  settle(G, { 1: opts(G, 1).indexOf(sum) });
  ok(G.ending && G.ending.seat === 1, '"even if this happens on another player\'s turn"');
  ok(bob != null, 'set up');
}
{
  // a tie: one more round, then shared
  const G = table(2);
  const [a, b] = G.players;
  a.vp = 40;
  b.vp = 40;
  G.phase = 'buy';
  move(G, 0, { kind: 'end' });
  G.phase = 'buy';
  move(G, 1, { kind: 'end' });
  eq([G.phase, G.tieRound], ['roll', true], 'tied at the end: one more round');
  G.phase = 'buy';
  move(G, 0, { kind: 'end' });
  G.phase = 'buy';
  move(G, 1, { kind: 'end' });
  eq([G.phase, G.winners], ['over', [0, 1]], 'still tied: the victory is shared');
}
{
  const G = table(2);
  const [a, b] = G.players;
  a.vp = 40;
  b.vp = 40;
  G.phase = 'buy';
  move(G, 0, { kind: 'end' });
  G.phase = 'buy';
  move(G, 1, { kind: 'end' });
  a.vp = 44;
  G.phase = 'buy';
  move(G, 0, { kind: 'end' });
  G.phase = 'buy';
  move(G, 1, { kind: 'end' });
  eq(G.winners, [0], 'the round more breaks the tie');
}

// ---------------------------------------------------------------- Light-Speed
{
  const G = M.newGame(roster(3), { lightspeed: true });
  eq(G.phase, 'light', 'Light-Speed begins with the buying');
  ok(G.players.every((p) => p.cr === 15 && p.inc === 1), '15 credits and 1 income each');
  const offers = G.players.map((p) => G.light[p.seat].offer);
  ok(offers.every((o) => o.length === 6 && o.filter((id) => M.CARDS[id].level === 1).length === 4), 'four level 1 and two level 2 each');
  const v0 = M.viewFor(G, 1, 'X');
  ok(v0.light.offers[0].length === 6 && v0.light.mine === null, 'the offers are open; no picks yet');
  const pricey = offers[0].slice().sort((x, y) => M.CARDS[y].cost - M.CARDS[x].cost);
  const total = (ids) => ids.reduce((s, id) => s + M.CARDS[id].cost, 0);
  ok(!move(G, 0, { kind: 'lightspeed', cards: offers[1].slice(0, 1) }).ok, 'only your own offer');
  const p0 = pricey.filter((id, i, arr) => total(arr.slice(0, i + 1)) <= 15);
  ok(move(G, 0, { kind: 'lightspeed', cards: p0 }).ok, 'seat 0 buys');
  eq(M.viewFor(G, 1, 'X').players[0].chose, true, 'the others see that seat 0 has chosen');
  ok(!JSON.stringify(M.viewFor(G, 1, 'X').light).includes(JSON.stringify(p0)), 'but not what');
  ok(move(G, 1, { kind: 'lightspeed', cards: [] }).ok, 'seat 1 buys nothing and keeps 15');
  const l1 = M.CARDS[offers[2].find((id) => M.CARDS[id].level === 1)];
  ok(move(G, 2, { kind: 'lightspeed', cards: [l1.id] }).ok, 'seat 2 buys one');
  eq(G.phase, 'roll', 'then the game begins');
  eq(G.players[G.first].seat, 1, 'whoever kept the most credits goes first');
  eq(G.players[1].cr, 15, 'no bonus for the first');
  eq(G.players[2].cr, 15 - l1.cost + 1, 'the 2nd gains 1 credit');
  eq(G.players[0].cr, 15 - total(p0) + 2, 'the 3rd gains 2');
  const unbought = offers.flat().filter((id) => !G.players.some((p) => p.station.includes(id) || M.SECTORS.some((s) => p.deployed[s].includes(id))));
  ok(M.LEVELS.every((l) => unbought.filter((id) => M.CARDS[id].level === l).every((id, _, arr) => G.decks[l].indexOf(id) >= 0 && G.decks[l].indexOf(id) < arr.length)), 'unbought ships go to the bottom of their decks');
}

// ---------------------------------------------------------------- views
{
  const G = table(3);
  const [a, b, c] = G.players;
  deploy(G, b, 'Kizim', 4);
  deploy(G, b, 'Bobko', 9);
  deploy(G, c, 'Kizim', 4);
  roll(G, 4, 5);
  const vb = M.viewFor(G, 1, 'X');
  const vc = M.viewFor(G, 2, 'X');
  ok(vb.alloc && vb.alloc.options.length > 1, 'a view carries its own choices');
  ok(!JSON.stringify(vc).includes('"options"') || JSON.stringify(vc.alloc.options) !== JSON.stringify(vb.alloc.options), 'and not another’s');
  const watch = M.viewFor(G, 1, 'X', { observer: true });
  ok(!watch.alloc && !watch.can, 'a watcher can choose nothing');
  ok(vb.players.every((p) => typeof p.chose === 'boolean'), 'everyone sees who has chosen');
  ok(a && JSON.stringify(vb).indexOf('decks') > 0 && typeof vb.decks[1] === 'number', 'the decks are counts, not cards');
}

console.log(`${pass} checks passed${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
