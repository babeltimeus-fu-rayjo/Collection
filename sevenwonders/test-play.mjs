import * as SW from './game.js';

let fails = 0;
const bad = (m) => { console.log('  **FAIL** ' + m); fails++; };

for (let n = 3; n <= 7; n++) {
  for (let g = 0; g < 40; g++) {
    const roster = Array.from({ length: n }, (_, s) => ({ seat: s, name: 'P' + s, bot: true }));
    const G = SW.newMatch(roster, {});
    const seenAgeCards = [];
    let guard = 0;
    while (G.phase !== 'over' && guard++ < 200) {
      if (G.age === 1 && G.turn === 1) seenAgeCards.push(G.players.map(p => p.hand.length));
      const before = { age: G.age, turn: G.turn };
      for (const p of G.players) {
        const mv = SW.botChoose(G, p.seat);
        if (!mv) { if (G.phase === 'play') bad(`${n}p g${g}: bot had no move at age${G.age} t${G.turn}`); continue; }
        const r = SW.applyMove(G, p.seat, mv);
        if (!r.ok) bad(`${n}p g${g}: bot move rejected: ${r.error}`);
      }
      if (G.phase === 'play' && G.age === before.age && G.turn === before.turn) {
        bad(`${n}p g${g}: stuck at age${G.age} turn${G.turn}`); break;
      }
    }
    if (G.phase !== 'over') { bad(`${n}p g${g}: never finished (guard ${guard})`); continue; }

    // ---- invariants
    for (const p of G.players) {
      if (p.coins < 0) bad(`${n}p g${g}: ${p.name} has ${p.coins} coins`);
      const names = p.built.map(c => c.n);
      if (new Set(names).size !== names.length) bad(`${n}p g${g}: ${p.name} built a duplicate`);
      if (p.stagesBuilt.length > p.stages.length) bad(`${n}p g${g}: ${p.name} overbuilt their wonder`);
      if (p.tokens.length > 6) bad(`${n}p g${g}: ${p.name} has ${p.tokens.length} military tokens`);
      if (p.hand.length) bad(`${n}p g${g}: ${p.name} still holds cards`);
    }
    // every card dealt is accounted for: built, buried under a wonder, or binned
    const built = G.players.reduce((a, p) => a + p.built.length, 0);
    const buried = G.players.reduce((a, p) => a + p.stagesBuilt.length, 0);
    const dealt = 3 * 7 * n;
    if (built + buried + G.discard.length !== dealt) {
      bad(`${n}p g${g}: ${built}+${buried}+${G.discard.length} != ${dealt} cards dealt`);
    }
    // six plays per age each; anything not standing in a city or buried under a
    // wonder was either sold or was the seventh card nobody got to
    if (G.discard.length < n * 3) bad(`${n}p g${g}: only ${G.discard.length} discards, expected at least ${n * 3}`);
    if (built + buried + (G.discard.length - n * 3) !== n * 18) {
      bad(`${n}p g${g}: ${built}+${buried}+sold != ${n * 18} plays`);
    }
    if (!G.result || !G.result.winners.length) bad(`${n}p g${g}: no result`);
    for (const s of G.result.scores) {
      if (!Number.isFinite(s.total)) bad(`${n}p g${g}: ${s.name} scored ${s.total}`);
    }
  }
  const roster = Array.from({ length: n }, (_, s) => ({ seat: s, name: 'P' + s, bot: true }));
  const G = SW.newMatch(roster, {});
  console.log(`${n}p: 40 games ok  (age I hands ${G.players.map(p => p.hand.length).join('/')})`);
}

// a sample final table
const roster = Array.from({ length: 4 }, (_, s) => ({ seat: s, name: ['Ada','Bo','Cy','Di'][s], bot: true }));
const G = SW.newMatch(roster, {});
while (G.phase !== 'over') for (const p of G.players) { const mv = SW.botChoose(G, p.seat); if (mv) SW.applyMove(G, p.seat, mv); }
console.log('\nsample 4-player result:');
console.log('  ' + 'name'.padEnd(6) + ['mil','coin','wndr','civ','com','guild','sci','TOTAL'].map(h => h.padStart(6)).join(''));
for (const s of G.result.ranked) {
  console.log('  ' + s.name.padEnd(6) + [s.military, s.coins, s.wonder, s.civilian, s.commercial, s.guild, s.science, s.total].map(v => String(v).padStart(6)).join(''));
}
console.log('  winner:', G.result.winners.join(' & '));
console.log(fails ? `\n${fails} FAILURES` : '\nall invariants held');
process.exit(fails ? 1 : 0);
