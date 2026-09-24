import * as SW from './game.js';

let fails = 0;
const bad = (m) => { console.log('  **FAIL** ' + m); fails++; };

const CONFIGS = [];
for (let n = 3; n <= 7; n++) CONFIGS.push([n, {}]);
for (let n = 3; n <= 8; n++) CONFIGS.push([n, { cities: true }]);
for (const n of [4, 6, 8]) CONFIGS.push([n, { cities: true, teams: true }]);

for (const [n, opts] of CONFIGS) {
  for (let g = 0; g < 25; g++) {
    const roster = Array.from({ length: n }, (_, s) => ({ seat: s, name: 'P' + s, bot: true }));
    const G = SW.newMatch(roster, opts);
    const tag = `${n}p${opts.cities?"+c":""}${opts.teams?"+t":""}`;
    const seenAgeCards = [];
    let guard = 0;
    while (G.phase !== 'over' && guard++ < 200) {
      if (G.age === 1 && G.turn === 1) seenAgeCards.push(G.players.map(p => p.hand.length));
      const before = { age: G.age, turn: G.turn };
      for (const p of G.players) {
        const mv = SW.botChoose(G, p.seat);
        if (!mv) { if (G.phase === 'play') bad(`${tag} g${g}: bot had no move at age${G.age} t${G.turn}`); continue; }
        const r = SW.applyMove(G, p.seat, mv);
        if (!r.ok) bad(`${tag} g${g}: bot move rejected: ${r.error}`);
      }
      if (G.phase === 'play' && G.age === before.age && G.turn === before.turn) {
        bad(`${tag} g${g}: stuck at age${G.age} turn${G.turn}`); break;
      }
    }
    if (G.phase !== 'over') { bad(`${tag} g${g}: never finished (guard ${guard})`); continue; }

    // ---- invariants
    for (const p of G.players) {
      if (p.coins < 0) bad(`${tag} g${g}: ${p.name} has ${p.coins} coins`);
      const names = p.built.map(c => c.n);
      if (new Set(names).size !== names.length) bad(`${tag} g${g}: ${p.name} built a duplicate`);
      if (p.stagesBuilt.length > p.stages.length) bad(`${tag} g${g}: ${p.name} overbuilt their wonder`);
      if (p.tokens.length > 6) bad(`${tag} g${g}: ${p.name} has ${p.tokens.length} military tokens`);
      if (p.hand.length) bad(`${tag} g${g}: ${p.name} still holds cards`);
    }
    // every card dealt is accounted for: built, buried under a wonder, or binned
    const built = G.players.reduce((a, p) => a + p.built.length, 0);
    const buried = G.players.reduce((a, p) => a + p.stagesBuilt.length, 0);
    const plays = G.handSize - 1;
    const dealt = 3 * G.handSize * n;
    if (built + buried + G.discard.length !== dealt) {
      bad(`${tag} g${g}: ${built}+${buried}+${G.discard.length} != ${dealt} cards dealt`);
    }
    // six plays per age each; anything not standing in a city or buried under a
    // wonder was either sold or was the seventh card nobody got to. Two things
    // now bend that: Solomon, the Forging Agency and Halikarnassos take cards
    // back OUT of the pile, and Babylon plays its seventh card instead of
    // putting it in. Both are counted, so the floor is still exact.
    const fromPile = G.players.reduce((a, p) => a + p.built.filter((c) => c.fromPile).length, 0);
    if (G.discard.length + fromPile + G.lateCards < n * 3) {
      bad(`${tag} g${g}: ${G.discard.length} binned + ${fromPile} salvaged + ${G.lateCards} played late, expected at least ${n * 3}`);
    }
    if (built + buried + (G.discard.length - n * 3) !== n * plays * 3) {
      bad(`${tag} g${g}: ${built}+${buried}+sold != ${n * plays * 3} plays`);
    }
    if (!G.result || !G.result.winners.length) bad(`${tag} g${g}: no result`);
    for (const s of G.result.scores) {
      if (!Number.isFinite(s.total)) bad(`${tag} g${g}: ${s.name} scored ${s.total}`);
    }
  }
  const roster = Array.from({ length: n }, (_, s) => ({ seat: s, name: 'P' + s, bot: true }));
  const G = SW.newMatch(roster, opts);
  // The one structural fact the card table has to satisfy: an Age deals seven
  // cards a player, eight with Cities. handSize is derived by division, so a
  // deck that is short or long shows up here as a fraction of a card each and
  // nowhere else — which is how a wrong `at` column would hide.
  // ... and eight seats are not "the seven-player game plus one": the deck is
  // built at the seven-player scale and the seven black cards make 56, which
  // deals seven each again.
  const want = n >= 8 ? 7 : (opts.cities ? 8 : 7);
  if (G.handSize !== want) bad(`${n}p: deals ${G.handSize} a player, expected ${want}`);
  const label = `${n}p${opts.cities ? ' +cities' : ''}${opts.teams ? ' +teams' : ''}`;
  console.log(`${label.padEnd(20)} 25 games ok — deals ${G.handSize}, plays ${G.handSize - 1} an Age`);
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
