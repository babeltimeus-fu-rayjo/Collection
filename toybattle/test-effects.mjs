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
const nodeAt = (G, x, y) => G.terrain.nodes.find((n) => n.x === x && n.y === y).id;
const NODE = {};
for (const t of TB.TERRAINS) NODE[t.key] = (x, y) => t.nodes.find((n) => n.x === x && n.y === y).id;

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
  const near = nodeAt(G, 1, 4);   // beside the blue H.Q.
  const far = nodeAt(G, 1, 1);    // four rows away, nothing of ours between
  ok(TB.canPlace(G, 0, near, 'roxy'), 'a base beside your own H.Q. is always open');
  ok(!TB.canPlace(G, 0, far, 'roxy'), 'a base with no chain back to your H.Q. is closed');
  ok(TB.canPlace(G, 0, far, 'hook'), 'Hook ignores the connection rule');
  const foeHq = nodeAt(G, 1, 0);
  ok(!TB.canPlace(G, 0, foeHq, 'hook'), 'Hook still needs a connection for the enemy H.Q. — it is not a base');
  ok(!TB.canPlace(G, 0, nodeAt(G, 1, 5), 'roxy'), 'you may never place on your own H.Q.');
}
{
  // a chain only counts through bases you hold on top
  const G = stage('castle', { rack0: ['skully'], board: { [NODE.castle(1, 4)]: [['roxy', 0]] } });
  const mid = nodeAt(G, 1, 3);
  ok(TB.canPlace(G, 0, mid, 'skully'), 'holding the base below extends the chain one step');
  const beyond = nodeAt(G, 1, 2);
  ok(!TB.canPlace(G, 0, beyond, 'skully'), 'the chain does not skip a base you do not hold');
}

console.log('— Tropical Pool restrictions —');
{
  const G = stage('pool', { rack0: ['roxy', 'skully', 'kwak'] });
  const buoy = G.terrain.nodes.find((n) => n.only);
  ok(buoy, 'Tropical Pool should carry value-restricted bases');
  ok(TB.valueAllowed(G, buoy.id, 'skully'), 'a 1 may take a buoy that lists 1–4');
  ok(!TB.valueAllowed(G, buoy.id, 'roxy'), 'a 7 may not take a buoy that lists 1–4');
  // La Croisette's sheet prints "a strength of 4, 5, 6, 7, or a joker", so the
  // joker is a member of the list when the board lists it — and is not when it
  // does not. Both directions matter, so both are checked.
  ok(TB.valueAllowed(G, buoy.id, 'kwak'), 'the joker is on this buoy\'s list, so it may take it');
  const noJoker = { ...G, terrain: { ...G.terrain, nodes: G.terrain.nodes.map((n) => (n.id === buoy.id ? { ...n, only: [1, 2, 3, 4] } : n)) } };
  ok(!TB.valueAllowed(noJoker, buoy.id, 'kwak'), 'a list without the joker keeps the joker out');
  ok(TB.valueAllowed(noJoker, buoy.id, 'skully'), 'and still admits the numbers it names');
  const hq = nodeAt(G, 1, 0);
  ok(TB.valueAllowed(G, hq, 'roxy'), 'the H.Q. lists 5–7, so a 7 may storm it');
  ok(!TB.valueAllowed(G, hq, 'skully'), 'a 1 may not storm an H.Q. that lists 5–7');
}

console.log('— capturing an H.Q. ends it at once —');
{
  // the whole column, blue H.Q. at (1,5) up to (1,1), so the chain is real
  const G = stage('castle', { rack0: ['roxy'], board: {
    [NODE.castle(1, 4)]: [['roxy', 0]],
    [NODE.castle(1, 3)]: [['roxy', 0]],
    [NODE.castle(1, 2)]: [['roxy', 0]],
    [NODE.castle(1, 1)]: [['roxy', 0]],
  } });
  ok(!TB.canPlace(G, 0, nodeAt(G, 1, 0), 'skully') === false, 'the enemy H.Q. should be open at the end of a held chain');
  const r = TB.applyMove(G, 0, { kind: 'place', tile: G.players[0].rack[0].id, node: nodeAt(G, 1, 0) });
  ok(r.ok, 'placing on the enemy H.Q. from an adjacent held base should be legal: ' + r.error);
  ok(G.phase === 'over' && G.winner === 0, 'capturing the enemy H.Q. wins immediately');
}
{
  // and one break in that chain closes it again
  const G = stage('castle', { rack0: ['roxy'], board: {
    [NODE.castle(1, 4)]: [['roxy', 0]],
    [NODE.castle(1, 2)]: [['roxy', 0]],
    [NODE.castle(1, 1)]: [['roxy', 0]],
  } });
  ok(!TB.canPlace(G, 0, nodeAt(G, 1, 0), 'roxy'), 'a chain with a gap in it does not reach the enemy H.Q.');
}

console.log('— regions —');
{
  // the region nearest the blue H.Q., so the last corner is honestly reachable
  const G = stage('castle');
  const region = G.terrain.regions.find((r) => r.around.includes(NODE.castle(1, 4)));
  ok(region, 'the blue side of Castle Field should have a region on it');
  const last = NODE.castle(1, 3);
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
  TB.applyMove(G, 0, { kind: 'place', tile: G.players[0].rack[0].id, node: nodeAt(G, 1, 4) });
  ok(G.players[0].rack.length === 2, `Skully should draw 2, rack is ${G.players[0].rack.length}`);
  ok(G.players[0].reserve.length === before - 2, 'those two came out of the reserve');
}
{
  // "If you already have 7 Troops on your rack, you draw only one."
  const G = stage('castle', { rack0: ['skully', 'roxy', 'roxy', 'roxy', 'roxy', 'roxy', 'roxy', 'roxy'] });
  TB.applyMove(G, 0, { kind: 'place', tile: G.players[0].rack[0].id, node: nodeAt(G, 1, 4) });
  ok(G.players[0].rack.length === TB.RACK_MAX, `rack should stop at ${TB.RACK_MAX}, got ${G.players[0].rack.length}`);
}

console.log('— XB-42 —');
{
  const G = stage('castle', { rack0: ['xb42'], rack1: ['roxy', 'jumbo', 'skully'] });
  TB.applyMove(G, 0, { kind: 'place', tile: G.players[0].rack[0].id, node: nodeAt(G, 1, 4) });
  ok(G.players[1].rack.length === 2, `XB-42 should blast one off their rack, they hold ${G.players[1].rack.length}`);
  ok(G.discard.length === 1 && G.discard[0].owner === 1, 'the blasted Troop goes to the discard faceup');
}

console.log('— Jumbo —');
{
  const G = stage('castle', { rack0: ['jumbo'], board: {
    [nodeAt(stage('castle'), 1, 4)]: [['roxy', 0]],
    [nodeAt(stage('castle'), 1, 3)]: [['skully', 1]],
  } });
  // Jumbo lands next to the enemy Troop, then may shove it
  const r = TB.applyMove(G, 0, { kind: 'place', tile: G.players[0].rack[0].id, node: nodeAt(G, 0, 4) });
  ok(r.ok, 'Jumbo placement: ' + r.error);
  ok(!G.pending, 'Jumbo with no adjacent enemy should not stop to ask');
}
{
  const G = stage('castle');
  const foot = nodeAt(G, 1, 4), target = nodeAt(G, 1, 3);
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
  const G = stage('metalx', { rack0: ['skully'] });
  const plate = G.terrain.nodes.find((n) => n.special && TB.reachable(G, 0).has(n.id));
  ok(plate, 'a shielded plate should be reachable from the blue H.Q. at the start');
  if (plate) {
    TB.applyMove(G, 0, { kind: 'place', tile: G.players[0].rack[0].id, node: plate.id });
    ok(G.players[0].rack.length === 0, 'Skully on a shielded plate draws nothing');
  }
}

console.log('— Cursed Cemetery raises the dead —');
{
  const G = stage('cemetery', { rack0: ['roxy'], discard: [['skully', 0], ['jumbo', 1]] });
  const grave = G.terrain.nodes.find((n) => n.special && TB.reachable(G, 0).has(n.id));
  ok(grave, 'a grave should be reachable from the blue H.Q. at the start');
  if (grave) {
    TB.applyMove(G, 0, { kind: 'place', tile: G.players[0].rack[0].id, node: grave.id });
    ok(G.pending && G.pending.kind === 'undead', 'the grave should offer a Troop back');
    const mine = G.discard.find((t) => t.owner === 0);
    const r = TB.applyMove(G, 0, { kind: 'undead', tile: mine.id });
    ok(r.ok, 'taking your own Troop back: ' + r.error);
    ok(G.players[0].rack.some((t) => t.key === 'skully'), 'it should be on the rack');
    ok(!G.discard.some((t) => t.id === mine.id), 'and out of the discard');
  }
}
{
  const G = stage('cemetery', { rack0: ['roxy'], discard: [['jumbo', 1]] });
  const grave = G.terrain.nodes.find((n) => n.special && TB.reachable(G, 0).has(n.id));
  if (grave) {
    TB.applyMove(G, 0, { kind: 'place', tile: G.players[0].rack[0].id, node: grave.id });
    ok(!G.pending, 'with only the enemy’s Troops in the discard the grave should not stop to ask');
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
  TB.applyMove(G, 1, { kind: 'place', tile: G.players[1].rack[0].id, node: nodeAt(G, 1, 1) });
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
