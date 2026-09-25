// Bot-vs-bot across every Terrain, checking the invariants that would break
// silently. The important one is tile conservation: 24 Troops a player, four
// of them boxed at setup, and every remaining one is on a rack, in a reserve,
// somewhere in a stack on the board, or in the discard. A tile that gets
// duplicated by a careless effect or dropped on the floor shows up here and
// nowhere else.
import * as TB from './game.js';

let fails = 0;
const bad = (m) => { console.log('  **FAIL** ' + m); fails++; };

const GAMES = 40;
// the shallow bot is the cheap way to generate a lot of legal traffic
const QUICK = { level: 'quick' };
const seen = { draw: 0, place: 0, hq: 0, medals: 0, stuck: 0 };

for (const terrain of TB.TERRAINS) {
  let turns = 0, longest = 0;
  for (let g = 0; g < GAMES; g++) {
    const roster = [{ seat: 0, name: 'Blue', bot: true }, { seat: 1, name: 'Red', bot: true }];
    const G = TB.newMatch(roster, { terrain: terrain.key });
    const tag = `${terrain.key} g${g}`;

    // the tiles each player owns, fixed for the whole game
    const owned = new Map();
    for (const p of G.players) owned.set(p.seat, TB.TROOP_ORDER.length * TB.COPIES - TB.SET_ASIDE);

    let guard = 0;
    let lastTurn = G.turn;
    while (G.phase !== 'over' && guard++ < 4000) {
      const actor = G.pending ? G.pending.seat : G.turn;
      const mv = TB.botChoose(G, actor, QUICK);
      if (!mv) { bad(`${tag}: bot had no move (pending ${G.pending && G.pending.kind})`); break; }
      if (!G.pending) { if (mv.kind === 'draw') seen.draw++; else seen.place++; }
      const r = TB.applyMove(G, actor, mv);
      if (!r.ok) { bad(`${tag}: move rejected — ${r.error} (${JSON.stringify(mv)})`); break; }

      // ---- tile conservation, every single step
      for (const p of G.players) {
        const onBoard = G.board.reduce((a, st) => a + st.filter((t) => t.owner === p.seat).length, 0);
        const inBin = G.discard.filter((t) => t.owner === p.seat).length;
        const total = p.rack.length + p.reserve.length + onBoard + inBin;
        if (total !== owned.get(p.seat)) {
          bad(`${tag}: ${p.name} accounts for ${total} Troops, should be ${owned.get(p.seat)}`);
          guard = 1e9;
        }
        if (p.rack.length > TB.RACK_MAX) bad(`${tag}: ${p.name} has ${p.rack.length} on the rack, cap is ${TB.RACK_MAX}`);
      }
      // ---- medals only ever come from claimed regions
      for (const p of G.players) {
        const want = G.terrain.regions.filter((r) => r.owner === p.seat).reduce((a, r) => a + r.medals, 0);
        if (p.medals !== want) bad(`${tag}: ${p.name} holds ${p.medals} Medals, claimed regions total ${want}`);
      }
      // ---- nobody ever stands on their own H.Q.
      for (const n of G.terrain.nodes) {
        if (n.hq === null) continue;
        const top = TB.topOf(G, n.id);
        if (top && top.owner === n.hq) bad(`${tag}: ${top.owner} occupies its own H.Q.`);
      }
      if (!G.pending && G.turn === lastTurn && G.phase !== 'over') {
        // a turn must change hands once nothing is pending
        bad(`${tag}: turn did not pass (${JSON.stringify(mv)})`);
        break;
      }
      if (!G.pending) lastTurn = G.turn;
      turns++;
    }

    if (G.phase !== 'over') { bad(`${tag}: never finished (guard ${guard})`); continue; }
    longest = Math.max(longest, turns);
    if (!G.result) { bad(`${tag}: no result`); continue; }
    if (G.winner !== 0 && G.winner !== 1) bad(`${tag}: winner is ${G.winner}`);
    const why = G.endedBy || '';
    if (/H\.Q\./.test(why)) seen.hq++;
    else if (/Medals objective/.test(why)) seen.medals++;
    else seen.stuck++;
    // the stated reason has to match the state it left behind
    if (/Medals objective/.test(why) && TB.bySeat(G, G.winner).medals < G.terrain.targets[G.winner]) {
      bad(`${tag}: claims the Medals objective with ${TB.bySeat(G, G.winner).medals}/${G.terrain.targets[G.winner]}`);
    }
  }
  console.log(`${terrain.name.padEnd(18)} ${GAMES} games ok — ${terrain.nodes.filter((n) => n.hq === null).length} bases, ${terrain.regions.length} regions, objective ${terrain.targets.join('/')}`);
}

const total = seen.hq + seen.medals + seen.stuck;
console.log(`\nendings over ${total} games: ${seen.hq} by H.Q. capture, ${seen.medals} by Medals objective, ${seen.stuck} by a player running dry`);
console.log(`actions taken: ${seen.place} placements, ${seen.draw} draws`);
if (!seen.hq) bad('no game ever ended by capturing an H.Q. — the win condition may be unreachable');
if (!seen.medals) bad('no game ever ended on the Medals objective — the targets may be out of reach');
// ---- and a smaller pass driven by the searching bot, which reaches states
// the greedy one does not: it will spend a Cap'n to stack two placements, it
// will decline a special base, and it plays on to the very last legal Troop.
{
  let games = 0, moves = 0;
  for (const terrain of TB.TERRAINS) {
    for (let g = 0; g < 4; g++) {
      const roster = [{ seat: 0, name: 'Blue', bot: true }, { seat: 1, name: 'Red', bot: true }];
      const G = TB.newMatch(roster, { terrain: terrain.key });
      let guard = 0;
      while (G.phase !== 'over' && guard++ < 4000) {
        const actor = G.pending ? G.pending.seat : G.turn;
        const mv = TB.botChoose(G, actor, { level: 'steady' });
        if (!mv) { bad(`${terrain.key}: searching bot had no move`); break; }
        const r = TB.applyMove(G, actor, mv);
        if (!r.ok) bad(`${terrain.key}: searching bot move rejected — ${r.error}`);
        moves++;
        for (const pl of G.players) {
          if (pl.rack.length > TB.RACK_MAX) bad(`${terrain.key}: rack overflowed to ${pl.rack.length}`);
          const onBoard = G.board.reduce((a, st) => a + st.filter((t) => t.owner === pl.seat).length, 0);
          const inBin = G.discard.filter((t) => t.owner === pl.seat).length;
          if (pl.rack.length + pl.reserve.length + onBoard + inBin !== 20) {
            bad(`${terrain.key}: searching bot lost or duplicated a Troop`);
            guard = 1e9;
          }
        }
      }
      if (G.phase !== 'over') bad(`${terrain.key}: searching bot never finished`);
      games++;
    }
  }
  console.log(`\nsearching bot: ${games} games, ${moves} moves, every move legal`);
}

console.log(fails ? `\n${fails} FAILURES` : '\nall invariants held');
process.exit(fails ? 1 : 0);
