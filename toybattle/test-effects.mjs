// Every Troop effect and every Terrain power, checked twice over: once by
// hand on a staged board, and once by watching thousands of bot turns to see
// that each one actually fires in play. The second half is the one that
// catches the failure this collection keeps producing — an effect that is
// declared in the data and read by nobody, which no unit test notices because
// the unit test calls it directly.
import * as TB from './game.js';

let fails = 0;
const bad = (m) => { console.log('  **FAIL** ' + m); fails++; };
const ok = (cond, m) => { if (!cond) bad(m); };

const ROSTER = [{ seat: 0, name: 'Blue', bot: false }, { seat: 1, name: 'Red', bot: false }];
let uid = 0;
const mk = (key, owner) => ({ id: `x${uid++}`, key, owner });
// Nodes are addressed by the label the board data gives them. On Castle Field
// the H.Q. are B and R, and each reaches only its two corner bases across a
// drawbridge: B to n and o, R to a and b. The shortest run between the two
// keeps is B-n-l-h-c-a-R, so n is the base beside blue's H.Q. and e is one of
// the special bases.
const at = (G, label) => G.terrain.nodes.find((n) => n.label === label).id;
const NODE = {};
for (const t of TB.TERRAINS) NODE[t.key] = (label) => t.nodes.find((n) => n.label === label).id;

// The shortest run of bases from blue's H.Q. to the nearest special base, so
// a test can hold the run and then step onto the special. Worked out from the
// board rather than named, because on the printed boards no special base sits
// beside an H.Q. and re-reading a board must not break the tests.
function approach(key, seat = 0) {
  const t = TB.terrainByKey(key);
  const start = t.nodes.filter((n) => n.hq === seat).map((n) => n.id);
  const prev = new Map(start.map((n) => [n, null]));
  const queue = [...start];
  while (queue.length) {
    const n = queue.shift();
    for (const m of t.adj[n]) {
      if (prev.has(m) || t.nodes[m].hq !== null) continue;
      prev.set(m, n);
      if (t.nodes[m].special) {
        const hold = [];
        for (let at = n; at !== null && t.nodes[at].hq === null; at = prev.get(at)) hold.push(at);
        return { hold, target: m };
      }
      queue.push(m);
    }
  }
  return null;
}
const holding = (ids) => Object.fromEntries(ids.map((id) => [id, [['roxy', 0]]]));

// A blank board with exactly the Troops we say, and nothing else.
function stage(terrainKey, { rack0 = [], rack1 = [], board = {}, turn = 0, discard = [] } = {}) {
  const G = TB.newMatch(ROSTER, { terrain: terrainKey });
  G.turn = turn;
  G.board = G.terrain.nodes.map(() => []);
  G.players[0].rack = rack0.map((k) => mk(k, 0));
  G.players[1].rack = rack1.map((k) => mk(k, 1));
  G.discard = discard.map(([k, o]) => mk(k, o));
  for (const [node, stack] of Object.entries(board)) G.board[node] = stack.map(([k, o]) => mk(k, o));
  G.log = [];
  return G;
}

console.log('— covering —');
ok(TB.canCover('roxy', 'skully'), '7 should cover 1');
ok(!TB.canCover('skully', 'roxy'), '1 should not cover 7');
ok(!TB.canCover('jumbo', 'jumbo'), 'equal strength should not cover — "strictly lower"');
ok(TB.canCover('kwak', 'roxy'), 'Kwak covers the strongest Troop');
ok(TB.canCover('skully', 'kwak'), 'anything covers Kwak, including the weakest Troop');
ok(TB.canCover('kwak', 'kwak'), 'Kwak covers Kwak');

console.log('— the connection rule —');
{
  const G = stage('castle', { rack0: ['roxy', 'hook'] });
  const near = at(G, 'n');   // across blue's drawbridge
  const far = at(G, 'c');    // right across the board, nothing of ours between
  ok(TB.canPlace(G, 0, near, 'roxy'), 'a base beside your own H.Q. is always open');
  ok(!TB.canPlace(G, 0, far, 'roxy'), 'a base with no chain back to your H.Q. is closed');
  ok(TB.canPlace(G, 0, far, 'hook'), 'Hook ignores the connection rule');
  const foeHq = at(G, 'R');
  ok(!TB.canPlace(G, 0, foeHq, 'hook'), 'Hook still needs a connection for the enemy H.Q. — it is not a base');
  ok(!TB.canPlace(G, 0, at(G, 'B'), 'roxy'), 'you may never place on your own H.Q.');
}
{
  // a chain only counts through bases you hold on top
  const G = stage('castle', { rack0: ['skully'], board: { [NODE.castle('n')]: [['roxy', 0]] } });
  const mid = at(G, 'l');
  ok(TB.canPlace(G, 0, mid, 'skully'), 'holding the base beyond the bridge extends the chain one step');
  const beyond = at(G, 'h');
  ok(!TB.canPlace(G, 0, beyond, 'skully'), 'the chain does not skip a base you do not hold');
}

console.log('— Tropical Pool restrictions —');
{
  // Written against whatever lists the board carries rather than particular
  // numbers, so re-reading the printed triangles cannot break it: for every
  // restricted node, each Troop is admitted exactly when the list names its
  // strength — or names the joker, for Kwak.
  const G = stage('pool');
  const restricted = G.terrain.nodes.filter((n) => n.only);
  ok(restricted.some((n) => n.hq === null), 'Tropical Pool should carry value-restricted bases');
  ok(restricted.some((n) => n.hq !== null), 'and at least one value-restricted H.Q.');
  for (const n of restricted) {
    for (const key of TB.TROOP_ORDER) {
      const s = TB.strengthOf(key);
      const want = n.only.includes(s === null ? 'joker' : s);
      ok(TB.valueAllowed(G, n.id, key) === want,
        `${n.label} lists ${n.only.join('/')}: ${TB.troopLabel(key)} should be ${want ? 'admitted' : 'refused'}`);
    }
  }
  // Both directions of the joker rule, on a list we control: La Croisette's
  // sheet prints "a strength of 4, 5, 6, 7, or a joker", so the joker is a
  // member of the list when the board names it and is kept out when it does not.
  const buoy = restricted.find((n) => n.hq === null);
  const withList = (only) => ({ ...G, terrain: { ...G.terrain, nodes: G.terrain.nodes.map((x) => (x.id === buoy.id ? { ...x, only } : x)) } });
  ok(TB.valueAllowed(withList([4, 5, 6, 7, 'joker']), buoy.id, 'kwak'), 'a list naming the joker admits Kwak');
  ok(!TB.valueAllowed(withList([4, 5, 6, 7]), buoy.id, 'kwak'), 'a list without the joker keeps Kwak out');
  // an unrestricted H.Q. takes anything, where the board has one
  const open = G.terrain.nodes.find((n) => n.hq !== null && !n.only);
  if (open) ok(TB.TROOP_ORDER.every((k) => TB.valueAllowed(G, open.id, k)), `${open.label} has no triangle and should take any Troop`);
}

console.log('— every printed board pays Medals = bases − 2 —');
{
  // Noticed by the boards' owner while marking them up, and it held on every
  // region of every board transcribed so far: a region ringed by n bases holds
  // n − 2 Medals, and an H.Q. on the ring is not counted. So the Medal count is
  // a free check on the paths — a missed or invented path changes how many
  // bases ring a region and breaks it. The invented boards never followed it.
  let checked = 0;
  for (const terrain of TB.TERRAINS.filter((x) => x.source === 'board')) {
    for (const r of terrain.regions) {
      const want = r.around.length - 2;
      ok(r.medals === want, `${terrain.name}: region ${r.ring.map((n) => terrain.nodes[n].label).join('-')} has ${r.medals} Medals, but ${r.around.length} bases means ${want}`);
      checked++;
    }
    const total = terrain.regions.reduce((s, r) => s + r.medals, 0);
    // and the printed objective is half the board's Medals, rounded down —
    // Caribbean Sea's 11 Medals give 5, the rest are even
    ok(terrain.target === Math.floor(total / 2),
      `${terrain.name}: objective ${terrain.target} is not half its ${total} Medals rounded down — check the badge`);
  }
  console.log(`  ${checked} regions on ${TB.TERRAINS.filter((x) => x.source === 'board').length} printed boards, all consistent`);
}

console.log('— capturing an H.Q. ends it at once —');
{
  // the whole column, blue H.Q. at (1,5) up to (1,1), so the chain is real
  const G = stage('castle', { rack0: ['roxy'], board: {
    [NODE.castle('n')]: [['roxy', 0]],
    [NODE.castle('l')]: [['roxy', 0]],
    [NODE.castle('h')]: [['roxy', 0]],
    [NODE.castle('c')]: [['roxy', 0]],
    [NODE.castle('a')]: [['roxy', 0]],
  } });
  ok(!TB.canPlace(G, 0, at(G, 'R'), 'skully') === false, 'the enemy H.Q. should be open at the end of a held chain');
  const r = TB.applyMove(G, 0, { kind: 'place', tile: G.players[0].rack[0].id, node: at(G, 'R') });
  ok(r.ok, 'placing on the enemy H.Q. from an adjacent held base should be legal: ' + r.error);
  ok(G.phase === 'over' && G.winner === 0, 'capturing the enemy H.Q. wins immediately');
}
{
  // and one break in that chain closes it again
  const G = stage('castle', { rack0: ['roxy'], board: {
    [NODE.castle('n')]: [['roxy', 0]],
    [NODE.castle('h')]: [['roxy', 0]],
    [NODE.castle('c')]: [['roxy', 0]],
    [NODE.castle('a')]: [['roxy', 0]],
  } });
  ok(!TB.canPlace(G, 0, at(G, 'R'), 'roxy'), 'a chain with a gap in it does not reach the enemy H.Q.');
}

console.log('— regions —');
{
  // the region nearest the blue H.Q., so the last corner is honestly reachable
  const G = stage('castle');
  const region = G.terrain.regions.find((r) => r.around.includes(NODE.castle('n')));
  ok(region, 'the blue side of Castle Field should have a region on it');
  const last = NODE.castle('l');
  for (const n of region.around) if (n !== last) G.board[n] = [mk('roxy', 0)];
  G.players[0].rack = [mk('skully', 0)];
  const [a] = region.around.filter((n) => n !== last);
  const r = TB.applyMove(G, 0, { kind: 'place', tile: G.players[0].rack[0].id, node: last });
  ok(r.ok, 'closing the fourth corner should be legal: ' + r.error);
  ok(G.players[0].medals === region.medals, `closing a region pays its ${region.medals} Medal(s), got ${G.players[0].medals}`);
  const held = G.players[0].medals;
  // "You will keep them until the end of the game, even if you lose control"
  G.board[a] = [mk('roxy', 1)];
  ok(G.players[0].medals === held, 'Medals already taken are never given back');
  ok(region.owner === 0, 'a claimed region stays claimed');
}

console.log('— Skully, Star and the rack cap —');
{
  const G = stage('castle', { rack0: ['skully'] });
  const before = G.players[0].reserve.length;
  TB.applyMove(G, 0, { kind: 'place', tile: G.players[0].rack[0].id, node: at(G, 'n') });
  ok(G.players[0].rack.length === 2, `Skully should draw 2, rack is ${G.players[0].rack.length}`);
  ok(G.players[0].reserve.length === before - 2, 'those two came out of the reserve');
}
{
  // "If you already have 7 Troops on your rack, you draw only one."
  const G = stage('castle', { rack0: ['skully', 'roxy', 'roxy', 'roxy', 'roxy', 'roxy', 'roxy', 'roxy'] });
  TB.applyMove(G, 0, { kind: 'place', tile: G.players[0].rack[0].id, node: at(G, 'n') });
  ok(G.players[0].rack.length === TB.RACK_MAX, `rack should stop at ${TB.RACK_MAX}, got ${G.players[0].rack.length}`);
}

console.log('— XB-42 —');
{
  const G = stage('castle', { rack0: ['xb42'], rack1: ['roxy', 'jumbo', 'skully'] });
  TB.applyMove(G, 0, { kind: 'place', tile: G.players[0].rack[0].id, node: at(G, 'n') });
  ok(G.players[1].rack.length === 2, `XB-42 should blast one off their rack, they hold ${G.players[1].rack.length}`);
  ok(G.discard.length === 1 && G.discard[0].owner === 1, 'the blasted Troop goes to the discard faceup');
}

console.log('— Jumbo —');
{
  const G = stage('castle', { rack0: ['jumbo'], board: {
    [NODE.castle('n')]: [['roxy', 0]],
    [NODE.castle('j')]: [['skully', 1]],
  } });
  // Jumbo lands next to the enemy Troop, then may shove it
  const r = TB.applyMove(G, 0, { kind: 'place', tile: G.players[0].rack[0].id, node: at(G, 'o') });
  ok(r.ok, 'Jumbo placement: ' + r.error);
  ok(!G.pending, 'Jumbo with no adjacent enemy should not stop to ask');
}
{
  const G = stage('castle');
  const foot = at(G, 'n'), target = at(G, 'l');
  G.board[foot] = [mk('roxy', 0)];
  G.board[target] = [mk('skully', 1)];
  G.players[0].rack = [mk('jumbo', 0)];
  // place Jumbo onto a base adjacent to the enemy: cover our own at foot
  TB.applyMove(G, 0, { kind: 'place', tile: G.players[0].rack[0].id, node: foot });
  ok(G.pending && G.pending.kind === 'jumbo', 'Jumbo should offer the shove');
  ok(G.pending.options.includes(target), 'the adjacent enemy Troop should be on the list');
  TB.applyMove(G, 0, { kind: 'jumbo', node: target });
  ok(G.board[target].length === 0, 'the shoved Troop leaves the board');
  ok(G.discard.some((t) => t.key === 'skully'), 'and lands in the discard');
}

console.log('— Station Metal-X shields Troop effects —');
{
  const way = approach('metalx');
  ok(way, 'blue should be able to reach a shielded plate');
  if (way) {
    const G = stage('metalx', { rack0: ['skully'], board: holding(way.hold) });
    const r = TB.applyMove(G, 0, { kind: 'place', tile: G.players[0].rack[0].id, node: way.target });
    ok(r.ok, 'stepping onto the plate: ' + r.error);
    ok(G.players[0].rack.length === 0, 'Skully on a shielded plate draws nothing');
  }
}

console.log('— Cursed Cemetery raises the dead —');
{
  const way = approach('cemetery');
  ok(way, 'blue should be able to reach a grave');
  if (way) {
    const G = stage('cemetery', { rack0: ['roxy'], discard: [['skully', 0], ['jumbo', 1]], board: holding(way.hold) });
    TB.applyMove(G, 0, { kind: 'place', tile: G.players[0].rack[0].id, node: way.target });
    ok(G.pending && G.pending.kind === 'undead', 'the grave should offer a Troop back');
    const mine = G.discard.find((x) => x.owner === 0);
    const r = TB.applyMove(G, 0, { kind: 'undead', tile: mine.id });
    ok(r.ok, 'taking your own Troop back: ' + r.error);
    ok(G.players[0].rack.some((x) => x.key === 'skully'), 'it should be on the rack');
    ok(!G.discard.some((x) => x.id === mine.id), 'and out of the discard');

    const H = stage('cemetery', { rack0: ['roxy'], discard: [['jumbo', 1]], board: holding(way.hold) });
    TB.applyMove(H, 0, { kind: 'place', tile: H.players[0].rack[0].id, node: way.target });
    ok(!H.pending, 'with only the enemy’s Troops in the discard the grave should not stop to ask');
  }
}

console.log('— the tie goes against whoever ran dry —');
{
  const G = stage('castle', { rack0: [], rack1: [] });
  G.players[0].reserve = [];
  G.players[1].reserve = [];
  G.turn = 1;
  // blue has nothing at all; ending the turn hands the turn to blue, who is stuck
  G.players[1].rack = [mk('roxy', 1)];
  TB.applyMove(G, 1, { kind: 'place', tile: G.players[1].rack[0].id, node: at(G, 'a') });
  ok(G.phase === 'over', 'a player who can neither draw nor place ends the game');
  ok(G.winner === 1, 'on a Medals tie the player who ran dry loses, so Red should win');
}

console.log('\n— every effect actually fires in play —');
{
  const firedTroop = new Set();
  const firedPending = new Set();
  const firedPower = new Set();
  const placedKey = new Set();
  for (const t of TB.TERRAINS) {
    for (let g = 0; g < 60; g++) {
      const G = TB.newMatch([{ seat: 0, name: 'B', bot: true }, { seat: 1, name: 'R', bot: true }], { terrain: t.key });
      let guard = 0;
      while (G.phase !== 'over' && guard++ < 4000) {
        const actor = G.pending ? G.pending.seat : G.turn;
        const mv = TB.botChoose(G, actor, { level: 'quick' });
        if (!mv) break;
        const rackBefore = G.players.map((p) => p.rack.length);
        const binBefore = G.discard.length;
        if (!G.pending && mv.kind === 'place') {
          placedKey.add(G.players[actor].rack.find((x) => x.id === mv.tile).key);
        }
        const wasPlace = !G.pending && mv.kind === 'place'
          ? G.players[actor].rack.find((x) => x.id === mv.tile).key : null;
        TB.applyMove(G, actor, mv);
        if (wasPlace === 'skully' && G.players[actor].rack.length > rackBefore[actor] - 1) firedTroop.add('skully');
        if (wasPlace === 'star' && G.players[actor].rack.length > rackBefore[actor] - 1) firedTroop.add('star');
        if (wasPlace === 'xb42' && G.discard.length > binBefore) firedTroop.add('xb42');
        if (G.pending) { firedPending.add(G.pending.kind); firedPower.add(t.power + ':' + G.pending.kind); }
      }
    }
  }
  for (const k of TB.TROOP_ORDER) ok(placedKey.has(k), `${TB.TROOPS[k].name} was never placed in ${TB.TERRAINS.length * 60} games`);
  for (const k of ['skully', 'star', 'xb42']) ok(firedTroop.has(k), `${TB.TROOPS[k].name}'s effect never did anything`);
  for (const k of ['capn', 'jumbo']) ok(firedPending.has(k), `${TB.TROOPS[k].name} never offered its choice`);
  // every Terrain power that asks a question should have asked one
  for (const [power, kind] of [['retreat', 'retreat'], ['undead', 'undead'], ['eruption', 'eruption'], ['sniper', 'sniper']]) {
    ok(firedPower.has(power + ':' + kind), `the ${power} power never fired`);
  }
  console.log('  troops placed:', [...placedKey].length, 'of', TB.TROOP_ORDER.length);
  console.log('  choices offered:', [...firedPending].sort().join(', '));
}

console.log(fails ? `\n${fails} FAILURES` : '\nevery effect checked and firing');
process.exit(fails ? 1 : 0);
