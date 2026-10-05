// Whole games played by bots at every table size and every mix of optional
// rules, checked after every move: every move a bot makes is legal, no view
// ever shows a Character it should not, and every game ends — with a tally
// of who won and how, to see that neither side walks it.
import * as A from './game.js';

let fails = 0;
const bad = (m) => { if (fails < 20) console.log('  **FAIL** ' + m); fails++; };

function views(G) {
  if (G.phase === 'over') return;
  for (const p of G.players) {
    const v = A.viewFor(G, p.seat, 'X');
    for (const q of v.players) if (q.seat !== p.seat && q.role !== undefined) bad(`seat ${p.seat} sees seat ${q.seat}'s Character mid-game`);
    if (G.phase === 'vote' && v.proposals.length !== G.proposals.length) bad('a view lost a proposal');
    if ('cards' in v || 'votes' in v) bad('a view carries hidden cards or votes');
  }
}

function playOut(n, opts) {
  const G = A.newGame(Array.from({ length: n }, (_, i) => ({ seat: i, name: 'P' + i, bot: true })), opts);
  let steps = 0;
  while (G.phase !== 'over') {
    if (++steps > 2000) { bad(`a game of ${n} never ended (phase ${G.phase})`); return G; }
    const waiting = A.waitingOn(G);
    if (!waiting.length) { bad(`nobody to wait on in phase ${G.phase}`); return G; }
    for (const seat of waiting) {
      if (G.phase === 'over') break;
      const mv = A.botChoose(G, seat);
      if (!mv) { bad(`seat ${seat} had no move in phase ${G.phase}`); return G; }
      const r = A.applyMove(G, seat, mv);
      if (!r.ok) { bad(`seat ${seat} made an illegal move in ${G.phase}: ${r.error} ${JSON.stringify(mv)}`); return G; }
    }
    if (G.rejects >= A.MAX_REJECTS && G.phase !== 'over') bad('five rejections did not end the game');
    if (G.results.length > A.QUESTS) bad('more than five Quests');
    if (steps % 3 === 0) views(G);
  }
  return G;
}

const optionSets = [
  {},
  { percival: true, morgana: true },
  { mordred: true },
  { percival: true, morgana: true, mordred: true, lady: true },
  { oberon: true, lady: true },
  { percival: true, morgana: true, mordred: true, oberon: true, lady: true },
];
const tally = { good: 0, evil: 0 };
const why = {};
const bySize = {};
let games = 0;
const t0 = Date.now();
for (let n = A.MIN_PLAYERS; n <= A.MAX_PLAYERS; n++) {
  for (const extra of optionSets) {
    const opts = { ...A.defaultOpts(), ...extra };
    if (A.canStart(n, opts)) continue;
    for (let g = 0; g < 40; g++) {
      const G = playOut(n, opts);
      if (G.phase !== 'over') continue;
      games++;
      tally[G.winner]++;
      (bySize[n] ||= { good: 0, evil: 0 })[G.winner]++;
      const key = G.why.replace(/:.*|—.*/, '').trim();
      why[key] = (why[key] || 0) + 1;
      // what the end must look like
      const won = G.results.filter((r) => r.success).length;
      const lost = G.results.length - won;
      if (G.winner === 'good' && (won !== 3 || !G.assassination || G.assassination.hit)) bad('Good won without three Quests and a missed Merlin');
      if (G.assassination && G.assassination.hit !== (G.players.find((p) => p.seat === G.assassination.target).role === 'merlin')) bad('the assassination misread its target');
      if (lost >= 3 && G.winner !== 'evil') bad('three failed Quests and Evil did not win');
    }
  }
}
console.log(`  ${games} games in ${Date.now() - t0}ms — Good won ${tally.good}, Evil ${tally.evil}`);
for (const [n, t] of Object.entries(bySize)) console.log(`    ${n} players: Good ${t.good}, Evil ${t.evil}`);
for (const [k, v] of Object.entries(why).sort((a, b) => b[1] - a[1])) console.log(`    ${v} × ${k}`);
const share = tally.good / Math.max(1, games);
if (share < 0.15 || share > 0.85) bad(`Good won ${Math.round(share * 100)}% — one side is walking it`);
console.log(fails ? `\n${fails} FAILURES` : '\nevery game ended, every move was legal, no view leaked');
process.exit(fails ? 1 : 0);
