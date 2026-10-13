// Riichi scoring, checked hand by hand: the fu of every wait and set, Pinfu
// only with a two-sided wait and a pair worth nothing, the reading of a hand
// that pays most, Chiitoitsu's flat 25 fu, the open hand counted 30, Kokushi
// for the dealer; who pays what — a self-draw in shares rounded one by one, and
// the honba from the payers — Ippatsu, which lasts from a riichi to that
// player's next discard and is broken by any call, and the lock a riichi puts
// on the hand: the drawn tile goes back out unless it wins or makes a kan that
// keeps the wait, and nothing can be called but a Ron.
import * as M from './game.js';

let fails = 0, checks = 0;
const eq = (got, want, what) => {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(want)) { console.log(`  **FAIL** ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); fails++; }
};

let nextId = 5000;
const tile = (key) => {
  const kp = M.keyParts(key);
  return { id: nextId++, key, ...kp, ...('mps'.includes(kp.kind) ? { suit: kp.kind } : {}) };
};
const tiles = (s) => s.trim().split(/\s+/).map(tile);

// a four-player Riichi table, seat 0 dealing in the East round, no dora
function table() {
  const G = M.newMatch([0, 1, 2, 3].map((seat) => ({ seat, name: `P${seat}` })), 'jp');
  G.dealer = 0;
  G.roundWind = 'E';
  G.dora = [];
  G.uraDora = [];
  G.honba = 0;
  G.riichiSticks = 0;
  return G;
}

// Score `hand` (every concealed tile, the winning one included) for `seat`,
// won on `win` — by Ron from the next seat, or by Tsumo.
function scored(hand, win, { seat = 1, tsumo = false, riichi = false, ippatsu = false, melds = [] } = {}) {
  const G = table();
  const p = G.players[seat];
  p.hand = tiles(hand);
  p.melds = melds;
  p.riichi = riichi;
  p.ippatsu = ippatsu;
  const w = p.hand.find((t) => t.key === win);
  if (tsumo) { G.lastDraw = w; G.lastDiscard = null; }
  else { G.lastDiscard = w; G.lastDiscardSeat = (seat + 1) % 4; G.lastDraw = null; }
  return M.scoreHand(G, seat, tsumo ? null : (seat + 1) % 4, tsumo);
}
const score = (...a) => { const s = scored(...a); return { yaku: s.yaku.map((y) => y.name), han: s.han, fu: s.fu, points: s.points }; };
// what each payer hands over: the dealer's and the others' shares and the
// total, or the Ron
const shares = (...a) => { const s = scored(...a); return s.payments.mode === 'ron' ? [s.payments.amount] : [s.payments.dealer, s.payments.nonDealer, s.points]; };

console.log('— waits and Pinfu —');
const RUNS = 'm2 m3 m4 m6 m7 m8 p4 p5 p6 s6 s7 s8 p9 p9';
eq(score(RUNS, 'm4'), { yaku: ['Pinfu'], han: 1, fu: 30, points: 1000 }, 'two-sided wait (2-3 on 1 or 4), four runs, a plain pair: Pinfu, 30 fu on a discard');
eq(score(RUNS, 'm4', { tsumo: true }).fu, 20, 'Pinfu by self-draw is 20 fu — no 2 for the self-draw');
eq(score(RUNS, 'm3', { riichi: true }), { yaku: ['Riichi'], han: 1, fu: 40, points: 1300 }, 'the middle of a run (kanchan): no Pinfu, and 2 fu for the wait — 20 + 10 + 2 = 32, rounded to 40');
eq(score(RUNS, 'm3').points, 0, 'with no Pinfu and no riichi there is no yaku at all');
const EDGE = 'm1 m2 m3 m6 m7 m8 p4 p5 p6 s6 s7 s8 p9 p9';
eq(score(EDGE, 'm3', { riichi: true }), { yaku: ['Riichi'], han: 1, fu: 40, points: 1300 }, 'the 3 of 1-2-3 (penchan): a one-tile wait, 2 fu');
eq(score(EDGE, 'm1', { riichi: true }), { yaku: ['Riichi', 'Pinfu'], han: 2, fu: 30, points: 2000 }, 'the 1 of 1-2-3 is the other side of 2-3: two-sided, Pinfu');
const TANKI = 'm2 m3 m4 m5 m6 m7 p2 p3 p4 s3 s4 s5 p8 p8';
eq(score(TANKI, 'p8', { riichi: true }), { yaku: ['Riichi', 'Tanyao'], han: 2, fu: 40, points: 2600 }, 'a wait on the pair (tanki): 2 fu, no Pinfu');
eq(score('m2 m3 m4 m6 m7 m8 p4 p5 p6 s6 s7 s8 dR dR', 'm4', { riichi: true }), { yaku: ['Riichi'], han: 1, fu: 40, points: 1300 }, 'a pair of dragons scores 2 fu, so no Pinfu');
eq(score('m2 m3 m4 m6 m7 m8 p4 p5 p6 s6 s7 s8 wS wS', 'm4', { riichi: true }).yaku, ['Riichi'], 'nor with a pair of the seat wind (South, for seat 1)');
eq(score('m2 m3 m4 m6 m7 m8 p4 p5 p6 s6 s7 s8 wW wW', 'm4', { riichi: true }).yaku, ['Riichi', 'Pinfu'], 'a pair of a wind that is neither seat nor round wind scores nothing: Pinfu stands');

console.log('— the reading that pays most —');
eq(score('m1 m2 m3 m3 m4 m5 p2 p3 p4 s6 s7 s8 s2 s2', 'm3', { riichi: true }), { yaku: ['Riichi', 'Pinfu'], han: 2, fu: 30, points: 2000 }, 'the 3 completes 1-2-3 (penchan) or 3-4-5 (two-sided): read the way that pays, Pinfu');
eq(score('m2 m3 m4 m2 m3 m4 p7 p7 p7 s5 s6 s7 s9 s9', 's7', { riichi: true }), { yaku: ['Riichi', 'Iipeiko'], han: 2, fu: 40, points: 2600 }, 'Iipeiko beside a triplet — 20 + 10 + 4 for the concealed triplet, rounded to 40');

console.log('— triplets —');
const TRIP = 'm2 m3 m4 m5 m6 m7 s3 s4 s5 p5 p5 p5 p8 p8';
eq(score(TRIP, 'p5', { tsumo: true }), { yaku: ['Menzen Tsumo', 'Tanyao'], han: 2, fu: 30, points: 2000 }, 'a concealed triplet of simples is 4 fu: 20 + 2 + 4 = 26, rounded to 30');
eq(score(TRIP, 'p5'), { yaku: ['Tanyao'], han: 1, fu: 40, points: 1300 }, 'completed by a discard it counts as an open triplet, 2 fu: 20 + 10 + 2 = 32, rounded to 40');
eq(score('m9 m9 m9 m2 m3 m4 p2 p3 p4 s6 s7 s8 p5 p5', 'm4', { tsumo: true, riichi: true }).fu, 30, 'a concealed triplet of terminals is 8 fu: 20 + 2 + 8 = 30, on a two-sided wait');
eq(score('m9 m9 m9 m2 m3 m4 p2 p3 p4 s6 s7 s8 p5 p5', 'm4', { riichi: true }).fu, 40, '…and with the 10 of a concealed win on a discard, 38 rounds to 40');
eq(score('m9 m9 m9 m2 m3 m4 p2 p3 p4 s6 s7 s8 p5 p5', 'm3', { tsumo: true, riichi: true }).fu, 40, '…while the middle of 2-3-4 adds 2 more: 32 rounds to 40');

console.log('— the fixed counts —');
eq(score('m2 m2 m5 m5 p3 p3 p7 p7 s4 s4 s6 s6 s8 s8', 's8'), { yaku: ['Tanyao', 'Chiitoitsu'], han: 3, fu: 25, points: 3200 }, 'Chiitoitsu is a flat 25 fu, never rounded');
const OPEN = { melds: [{ type: 'chi', tiles: tiles('p2 p3 p4'), open: true }] };
eq(score('m2 m3 m4 m5 m6 m7 s3 s4 s5 s7 s7', 'm4', OPEN), { yaku: ['Tanyao'], han: 1, fu: 30, points: 1000 }, 'an open hand worth only the base 20 counts 30');
const KOKUSHI = 'm1 m9 p1 p9 s1 s9 wE wS wW wN dR dG dW dW';
eq(score(KOKUSHI, 'dW', { seat: 0 }).points, 48000, 'Kokushi musou for the dealer: a yakuman, 48000');
eq(score(KOKUSHI, 'dW', { seat: 1 }).points, 32000, '…and 32000 for anybody else');
eq(M.isWinningHand(tiles('m1 m9 p1 p9 s1 s9 wE wS wW wN dR dG dW m5'), 'jp', []), false, 'the thirteen orphans and a 5 Man is not Kokushi: the fourteenth tile has to be an orphan too');

console.log('— the planner —');
{
  // seat 1 (South, in the East round) is tenpai for Pinfu on a pair of North,
  // a wind worth nothing to it; with a pair of Chun instead it is not
  const pinfuRoute = (hand) => {
    const G = table();
    G.players[1].hand = tiles(hand);
    const out = M.outlookFor(M.positionFromView(M.viewFor(G, 1, 'T')));
    return out.routes.find((r) => r.parts.some((p) => p.term === 'pinfu'));
  };
  const guest = pinfuRoute('m2 m3 m4 m6 m7 m8 p4 p5 p6 s3 s4 wN wN');
  eq([guest.away, guest.wins.map((w) => w.k)], [0, ['s2', 's5']], 'a pair of a guest wind can be the Pinfu pair: tenpai, on 2 or 5 Sou');
  eq(pinfuRoute('m2 m3 m4 m6 m7 m8 p4 p5 p6 s3 s4 dR dR').away > 0, true, 'a pair of Chun cannot: that Pinfu is still some way off');
}

console.log('— who pays what —');
eq(shares(RUNS, 'm4', { tsumo: true }), [700, 400, 1500], '2 han 20 fu by self-draw: 700 from the dealer, 400 from each of the others — each share rounded on its own, 1500 in all');
eq(shares('m1 m2 m3 m5 m6 m7 s3 s4 s5 p5 p5 p5 p8 p8', 'p5', { tsumo: true }), [500, 300, 1100], '1 han 30 fu by self-draw: 500 and 300');
eq(shares(RUNS, 'm4', { tsumo: true, seat: 0 }), [700, 700, 2100], 'the dealer\'s 2 han 20 fu by self-draw: 700 from each');
eq(shares('m2 m3 m4 m2 m3 m4 p3 p4 p5 s5 s6 s7 p8 p8', 's7', { tsumo: true, riichi: true }), [4000, 2000, 8000], 'a mangan by self-draw (Riichi, Menzen Tsumo, Tanyao, Pinfu, Iipeiko): 4000 and 2000');
eq(shares(RUNS, 'm4', { seat: 0 }), [1500], 'the dealer\'s 1 han 30 fu by Ron: six times 240, rounded up — 1500');

console.log('— Ippatsu —');
// Seat 0 deals, discards s9 into riichi and waits on s5 alone; nobody else can
// claim anything, so each draws a North and throws it straight back.
function riichiTable(wall, others = ['m1 m1 m1 p1 p1 p1 s1 s1 s1 dR dR dG dG', 'm1 m1 m1 p1 p1 p1 s1 s1 s1 dW dW dG dG', 'm1 m1 m1 p1 p1 p1 s1 s1 s1 dR dR dW dW']) {
  const G = table();
  G.turn = 0;
  G.phase = 'discard';
  G.players[0].hand = tiles('m1 m2 m3 m4 m5 m6 m7 m8 m9 p2 p3 p4 s5 s9');
  others.forEach((h, i) => { G.players[i + 1].hand = tiles(h); });
  G.wall = tiles(wall);
  G.lastDraw = G.players[0].hand[13];
  return G;
}
const play = (G, seat, move) => { const r = M.applyMove(G, seat, move); if (!r.ok) throw new Error(`${JSON.stringify(move)} by ${seat}: ${r.error}`); };
const throwBack = (G, seat) => play(G, seat, { kind: 'discard', tileId: G.lastDraw.id });
{
  const G = riichiTable('wN wN wN s5 m1');
  play(G, 0, { kind: 'riichi', tileId: G.players[0].hand.find((t) => t.key === 's9').id });
  eq([G.turn, G.players[0].ippatsu], [1, true], 'the next player draws, and the riichi still has its Ippatsu');
  throwBack(G, 1);
  throwBack(G, 2);
  throwBack(G, 3);
  eq([G.turn, G.lastDraw.key, G.players[0].ippatsu], [0, 's5', true], 'round to the riichi player again with no call: Ippatsu stands');
  play(G, 0, { kind: 'tsumo' });
  eq(G.handResult.scoring.yaku.map((y) => y.name), ['Riichi', 'Ippatsu', 'Menzen Tsumo'], 'a self-draw within the go-around: Riichi, Ippatsu, Menzen Tsumo');
}
{
  const G = riichiTable('dR wN wN s5 m1');
  play(G, 0, { kind: 'riichi', tileId: G.players[0].hand.find((t) => t.key === 's9').id });
  throwBack(G, 1);
  eq([G.phase, G.claimPhase && G.claimPhase.eligible.map((e) => e.seat)], ['claim', [3]], 'seat 1 throws a Chun that seat 3 can Pon');
  play(G, 3, { kind: 'pon' });
  eq(G.players[0].ippatsu, false, 'a call at the table breaks the Ippatsu');
}
{
  const G = riichiTable('wN wN wN m1 s5');
  play(G, 0, { kind: 'riichi', tileId: G.players[0].hand.find((t) => t.key === 's9').id });
  throwBack(G, 1);
  throwBack(G, 2);
  throwBack(G, 3);
  throwBack(G, 0);
  eq(G.players[0].ippatsu, false, 'the riichi player\'s own next discard ends it');
}

console.log('— the riichi lock —');
// Seat 0 declares riichi on `hand` by throwing `out`; each of the others then
// draws and throws straight back, so the next tile off `wall` is seat 0's.
// The dead wall is fixed, so a kan's replacement is known: a 9 Man.
function lockTable(hand, out, wall) {
  const G = riichiTable(wall);
  G.deadWall = tiles('wE wE wE wE wS wS wS wN wN wN wW wW wW m9');
  G.players[0].hand = tiles(hand);
  G.lastDraw = G.players[0].hand[13];
  play(G, 0, { kind: 'riichi', tileId: G.players[0].hand.find((t) => t.key === out).id });
  throwBack(G, 1);
  throwBack(G, 2);
  throwBack(G, 3);
  return G;
}
// three 9 Pin and a wait on Haku alone
const LOCKED = 'p9 p9 p9 m2 m3 m4 m6 m7 m8 s3 s4 s5 dW wS';
{
  const G = lockTable(LOCKED, 'wS', 'wN wN wN p7 m1');
  const drawn = G.lastDraw;
  eq([G.turn, drawn.key], [0, 'p7'], 'round to the riichi player, who draws a 7 Pin');
  eq(M.applyMove(G, 0, { kind: 'discard', tileId: G.players[0].hand.find((t) => t.key === 'm2').id }).ok, false, 'any tile but the one drawn is refused: the hand is locked');
  eq(M.forcedMove(G, 0), { kind: 'discard', tileId: drawn.id }, 'with nothing to decide, the move is the drawn tile going straight back out');
  eq([M.viewFor(G, 0, 'T').actions.forced, M.viewFor(G, 0, 'T').actions.lockedTile], [true, drawn.id], '…and the view says the table will play it');
  eq([1, 2, 3].map((s) => M.forcedMove(G, s)), [null, null, null], 'nobody else has a forced move');
  play(G, 0, M.forcedMove(G, 0));
  eq(G.players[0].discards[G.players[0].discards.length - 1].key, 'p7', 'played, the 7 Pin lands in the discards');
}
{
  const G = lockTable(LOCKED, 'wS', 'wN wN wN dW m1');
  const a = M.viewFor(G, 0, 'T').actions;
  eq([M.forcedMove(G, 0), a.canTsumo, a.forced, a.lockedTile === G.lastDraw.id], [null, true, false, true], 'a draw that wins is a choice, not a forced discard: Tsumo, or letting the drawn tile go');
}
{
  const G = lockTable(LOCKED, 'wS', 'wN wN wN p9 m1');
  const a = M.viewFor(G, 0, 'T').actions;
  eq([a.canClosedKan, a.closedKanKeys, a.forced], [true, ['p9'], false], 'the fourth 9 Pin makes a kan that leaves the wait on Haku as it was: allowed, so nothing is forced');
  play(G, 0, { kind: 'kan', type: 'closed', tileKey: 'p9' });
  eq([G.lastDraw.key, M.forcedMove(G, 0)], ['m9', { kind: 'discard', tileId: G.lastDraw.id }], 'the replacement, a 9 Man, wins nothing and goes straight back out');
}
{
  // 2-2-2-3-4 Man and a pair of Haku wait on 2 or 5 Man — or on Haku, the 2s
  // read as a pair and a run. A kan of the fourth 2 would lose the Haku.
  const G = lockTable('m2 m2 m2 m3 m4 p3 p4 p5 s6 s7 s8 dW dW wS', 'wS', 'wN wN wN m2 m1');
  const a = M.viewFor(G, 0, 'T').actions;
  eq([a.canTsumo, a.canClosedKan, a.closedKanKeys], [true, false, []], 'a kan that would change the wait is not offered — the fourth 2 Man is a Tsumo');
  eq(M.applyMove(G, 0, { kind: 'kan', type: 'closed', tileKey: 'm2' }).ok, false, '…and asked for anyway, it is refused');
}
{
  // waits on 6 or 9 Sou, with a pair of 5 Sou and 6-7 Man beside it
  const G = riichiTable('s5 wN m5 p7 m1');
  G.players[0].hand = tiles('m2 m3 m4 m6 m7 m8 p4 p5 p6 s5 s5 s7 s8 wS');
  G.lastDraw = G.players[0].hand[13];
  play(G, 0, { kind: 'riichi', tileId: G.players[0].hand.find((t) => t.key === 'wS').id });
  throwBack(G, 1);
  eq([G.phase, G.turn], ['discard', 2], 'a 5 Sou is not offered to the riichi hand as a Pon: seat 2 simply draws');
  throwBack(G, 2);
  throwBack(G, 3);
  eq([G.phase, G.turn, G.lastDraw.key], ['discard', 0, 'p7'], 'nor the 5 Man from the left as a Chi: the riichi player draws');
}
{
  const G = riichiTable('s6 wN wN wN m1');
  G.players[0].hand = tiles('m2 m3 m4 m6 m7 m8 p4 p5 p6 s5 s5 s7 s8 wS');
  G.lastDraw = G.players[0].hand[13];
  play(G, 0, { kind: 'riichi', tileId: G.players[0].hand.find((t) => t.key === 'wS').id });
  throwBack(G, 1);
  eq(G.claimPhase && G.claimPhase.eligible.map((e) => [e.seat, e.opts]), [[0, ['ron']]], 'a winning tile is still offered — as a Ron');
}

console.log('— honba —');
{
  // the dealer's Riichi, Ippatsu, Menzen Tsumo: 3 han 30 fu, 2000 from each
  const G = riichiTable('wN wN wN s5 m1');
  G.honba = 2;
  play(G, 0, { kind: 'riichi', tileId: G.players[0].hand.find((t) => t.key === 's9').id });
  throwBack(G, 1);
  throwBack(G, 2);
  throwBack(G, 3);
  play(G, 0, { kind: 'tsumo' });
  const d = G.handResult.delta;
  eq([G.handResult.payments, G.handResult.scoring.payments], [{ mode: 'tsumo', dealer: 2000, nonDealer: 2000, points: 6000 }, undefined], 'the result carries the shares once, as its payments');
  eq([d[1], d[2], d[3]], [-2200, -2200, -2200], 'on a self-draw each of the three pays 100 a honba on top of their share');
  eq(d[0], 6600 + 1000, '…and the winner takes it all, with the riichi stick');
  eq(d[0] + d[1] + d[2] + d[3], 1000, 'no point is made from nothing: all that changes hands is the stick staked at the riichi');
}
{
  // the same wait, won on seat 1's discard: Riichi, Ippatsu, 2 han 40 fu, 3900 for the dealer
  const G = riichiTable('s5 wN wN wN m1');
  G.honba = 2;
  play(G, 0, { kind: 'riichi', tileId: G.players[0].hand.find((t) => t.key === 's9').id });
  throwBack(G, 1);
  play(G, 0, { kind: 'ron' });
  const d = G.handResult.delta;
  eq([d[0], d[1], d[2], d[3]], [3900 + 600 + 1000, -(3900 + 600), 0, 0], 'on a Ron the discarder pays the hand and 300 a honba');
  eq(G.handResult.payments, { mode: 'ron', amount: 3900, points: 3900, from: 1 }, '…and the result says who: seat 1');
}

console.log(`\n${checks} checks` + (fails ? `, ${fails} FAILURES` : ', all pass'));
process.exit(fails ? 1 : 0);
