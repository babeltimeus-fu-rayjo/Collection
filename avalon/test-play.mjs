// Whole games played by bots at every table size and many mixes of the Big
// Box's Characters, modules and optional rules, checked after every move:
// every move a bot makes is legal, no view ever shows what it should not,
// and every game ends — with a tally of who won and how, to see that neither
// side walks it.
import * as A from './game.js';

let fails = 0;
const bad = (m) => { if (fails < 20) console.log('  **FAIL** ' + m); fails++; };

// what no view may carry mid-game
function views(G) {
  if (G.phase === 'over') return;
  for (const p of G.players) {
    const v = A.viewFor(G, p.seat, 'X');
    for (const q of v.players) if (q.seat !== p.seat && q.role !== undefined && !G.players.find((x) => x.seat === q.seat).revealed) bad(`seat ${p.seat} sees seat ${q.seat}'s Character mid-game`);
    if ('cards' in v || 'votes' in v) bad('a view carries hidden cards or votes');
    for (const l of v.me.looks) if (l.by !== p.seat) bad(`seat ${p.seat} sees someone else's look at a card`);
    for (const c of v.checks) if (c.reason === 'cleric' && c.checker !== p.seat) bad(`seat ${p.seat} learns who the Cleric is`);
    if (v.ask && v.ask.reason === 'cleric' && v.ask.checker !== undefined && v.ask.checker !== p.seat && v.ask.seat !== p.seat) bad(`seat ${p.seat} sees the Cleric at work`);
    for (const r of v.results) if (r.rogueBy !== undefined) bad('a view shows who played a Rogue card');
    if (v.me.loyalty && !(G.ask && G.ask.kind === 'loyalty' && G.ask.seat === p.seat)) bad('loyalty options shown to the wrong player');
    if (v.lady) for (const c of v.lady.checks) if (c.shown !== undefined && c.holder !== p.seat) bad('a Lady look shown to another');
    const hidden = Object.keys(v.faceUp || {}).filter((s) => !G.faceUp.includes(Number(s)));
    if (hidden.length) bad('a card shown face up that was not');
  }
}

function playOut(n, opts) {
  const G = A.newGame(Array.from({ length: n }, (_, i) => ({ seat: i, name: 'P' + i, bot: true })), opts);
  if (G.players.some((p) => p.role === 'merlin') === !!opts.noMerlin) bad('Merlin dealt, or not, against the options');
  if (G.players.some((p) => p.role === 'assassin') !== A.assassinIn(opts)) bad('an Assassin with no one to name, or none with someone');
  let steps = 0;
  while (G.phase !== 'over') {
    if (++steps > 4000) { bad(`a game of ${n} never ended (phase ${G.phase})`); return G; }
    const waiting = A.waitingOn(G);
    if (!waiting.length) { bad(`nobody to wait on in phase ${G.phase}`); return G; }
    const seat = waiting[0];
    const mv = A.botChoose(G, seat);
    if (!mv) { bad(`seat ${seat} had no move in phase ${G.phase} (${G.ask && G.ask.kind})`); return G; }
    const r = A.applyMove(G, seat, mv);
    if (!r.ok) { bad(`seat ${seat} made an illegal move in ${G.phase}: ${r.error} ${JSON.stringify(mv)}`); return G; }
    if (G.rejects >= A.MAX_REJECTS && G.phase !== 'over') bad('five rejections did not end the game');
    if (G.results.length > A.QUESTS) bad('more than five Quests');
    const sides = G.players.filter((p) => p.side === 'evil').length;
    if (G.phase !== 'over' && !(G.recruit && G.recruit.hit) && sides !== A.SIDES[n][1]) bad(`${sides} agents of Evil — Lancelot's switch should keep the count`);
    if (steps % 2 === 0) views(G);
  }
  return G;
}

const MIXES = [
  {},
  { percival: true, morgana: true },
  { mordred: true },
  { percival: true, morgana: true, mordred: true, lady: true },
  { oberon: true, lady: true },
  { cleric: true, trickster: true, lady: true },
  { troublemaker: true, cleric: true },
  { untrustworthy: true, percival: true },
  { lunatic: true, brute: true },
  { revealer: true, mordred: true },
  { lancelot: true },
  { lancelot: true, lancelotVariant: 1 },
  { lancelot: true, lancelotVariant: 2 },
  { rogueGood: true, rogueEvil: true },
  { rogueEvil: true, oberon: true },
  { sorcerers: true },
  { sorcerers: true, sorcererHidden: true },
  { messengers: true },
  { messengers: true, messengerSenior: true, lady: true },
  { trapper: true },
  { excalibur: true },
  { plot: true },
  { plot: true, excalibur: true, trapper: true, lady: true },
  { percival: true, morgana: true, cleric: true, trickster: true, lancelot: true, lancelotVariant: 1, rogueGood: true, plot: true, excalibur: true },
  { noMerlin: true },
  { noMerlin: true, mordred: true, lady: true },
  { noMerlin: true, messengers: true },
  { noMerlin: true, messengers: true, untrustworthy: true, messengerSenior: true },
  { noMerlin: true, rogueGood: true, rogueEvil: true, sorcerers: true },
  { noMerlin: true, lancelot: true, lancelotVariant: 2, cleric: true, troublemaker: true, plot: true, excalibur: true },
];
const tally = {};
const why = {};
let games = 0;
const GAMES = Number(process.argv[2] || 12);
const t0 = Date.now();
for (let n = A.MIN_PLAYERS; n <= A.MAX_PLAYERS; n++) {
  for (const extra of MIXES) {
    const opts = { ...A.defaultOpts(), ...extra };
    if (A.canStart(n, opts)) continue;
    for (let g = 0; g < GAMES; g++) {
      const G = playOut(n, opts);
      if (G.phase !== 'over') continue;
      games++;
      tally[G.winner] = (tally[G.winner] || 0) + 1;
      const key = G.why.replace(/:.*|—.*|, and.*|, the last.*/, '').trim();
      why[key] = (why[key] || 0) + 1;
      // what the end must look like
      const won = G.results.filter((r) => r.success).length;
      const lost = G.results.length - won;
      const named = A.assassinIn(G.opts) ? !G.assassination || G.assassination.hit : !!G.assassination;
      if (G.winner === 'good' && (won !== 3 || named)) bad('Good won without three Quests and a miss (or, with no one to name, no assassination)');
      if (G.assassination && G.assassination.target !== undefined && (G.opts.noMerlin || G.assassination.hit !== (G.players.find((p) => p.seat === G.assassination.target).role === 'merlin'))) bad('the assassination misread its target');
      if (G.assassination && G.assassination.messengers && G.assassination.hit !== G.assassination.messengers.every((s) => /^messenger(Senior|Junior)$/.test(G.players.find((p) => p.seat === s).role))) bad('the Messengers were misread');
      if (lost >= 3 && G.winner !== 'evil' && G.winner !== 'rogueEvil') bad('three failed Quests and Evil did not win');
      if (G.winner === 'rogueGood' && (won !== 3 || G.assassination)) bad('a Good Rogue won without three Quests, or after an assassination');
      if (G.recruit && G.recruit.hit !== (G.players.find((p) => p.seat === G.recruit.target).role === 'untrustworthy')) bad('the recruitment misread its target');
      for (const p of G.players) if (p.role === 'servant' || p.role === 'merlin') if (p.side !== 'good') bad('a Loyal Servant changed sides');
    }
  }
}
const pct = (k) => `${Math.round((100 * (tally[k] || 0)) / Math.max(1, games))}%`;
console.log(`  ${games} games in ${Date.now() - t0}ms — Good ${pct('good')}, Evil ${pct('evil')}, Good Rogue alone ${pct('rogueGood')}, Evil Rogue alone ${pct('rogueEvil')}`);
for (const [k, v] of Object.entries(why).sort((a, b) => b[1] - a[1])) console.log(`    ${v} × ${k}`);
const share = (tally.good || 0) / Math.max(1, games);
if (share < 0.15 || share > 0.85) bad(`Good won ${Math.round(share * 100)}% — one side is walking it`);
console.log(fails ? `\n${fails} FAILURES` : '\nevery game ended, every move was legal, no view leaked');
process.exit(fails ? 1 : 0);
