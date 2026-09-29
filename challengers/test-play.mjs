// Whole tournaments played by bots, checked after every move: no card is ever
// lost or duplicated, every match ends, and every tournament crowns someone.
import * as CH from './game.js';

let fails = 0;
const bad = (m) => { console.log('  **FAIL** ' + m); fails++; };

// every card instance is in exactly one place: a pile, a discard, a deck, a
// draft, a match zone — or back in the box (removed starter cards)
function census(G) {
  const seen = new Map();
  const put = (id, where) => { if (seen.has(id)) bad(`card ${id} (${G.cards[id].key}) is both in ${seen.get(id)} and ${where}`); seen.set(id, where); };
  for (const L of 'ABC') { G.piles[L].forEach((id) => put(id, `pile ${L}`)); G.discard[L].forEach((id) => put(id, `discard ${L}`)); }
  for (const p of G.players) {
    const inMatch = G.phase === 'match' && G.matches.some((M) => !M.done && M.seats.includes(p.seat));
    if (!inMatch) p.deck.forEach((id) => put(id, `${p.name}'s deck`));
    if (p.draft) { p.draft.drawn.forEach((id) => put(id, `${p.name}'s draw`)); if (p.draft.pending && p.draft.pending.kind === 'surf') p.draft.pending.pool.forEach((id) => put(id, 'a surf draw')); }
  }
  if (G.phase === 'match') {
    for (const M of G.matches) {
      if (M.done) continue;
      for (const seat of M.seats) {
        const S = M.sides[seat];
        const all = [...S.deck, ...S.bench.flatMap((b) => b.ids), ...S.exhaust, ...S.attack, ...S.under, ...S.removed, ...S.limbo];
        if (S.flag !== null) all.push(S.flag);
        all.forEach((id) => put(id, `match ${M.id} seat ${seat}`));
      }
    }
  }
  // a Level card may only leave the game for its tray's discard; only starter
  // cards go back in the box
  for (const c of G.cards) {
    if (!seen.has(c.id) && CH.CARD[c.key].level !== 'S') bad(`Level card ${c.id} (${c.key}) has vanished`);
  }
}

function play(n, opts, level = 'quick') {
  const roster = Array.from({ length: n }, (_, i) => ({ seat: i, name: 'P' + i, bot: true }));
  const G = CH.newMatch(roster, opts);
  let guard = 0;
  while (G.phase !== 'over' && guard++ < 20000) {
    if (G.phase === 'deck' || G.phase === 'final-deck') {
      for (const seat of CH.waitingOn(G)) {
        const mv = CH.botChoose(G, seat, { level });
        const r = CH.applyMove(G, seat, mv);
        if (!r.ok) { bad(`deck move rejected: ${r.error} ${JSON.stringify(mv)}`); return G; }
        census(G);
        if (G.phase === 'match') break;
      }
    } else if (G.phase === 'match') {
      for (const M of G.matches) {
        if (M.over) continue;
        if (M.pending) {
          const mv = CH.botChoose(G, M.pending.seat, { level });
          const r = CH.applyMove(G, M.pending.seat, mv);
          if (!r.ok) { bad(`answer rejected: ${r.error} ${JSON.stringify(mv)} to ${M.pending.kind}`); return G; }
        } else CH.stepMatch(G, M);
        if (M.reveals > 300) { bad(`match ${M.id} of round ${G.round} ran past 300 reveals`); return G; }
      }
      census(G);
      CH.afterMatches(G);
      census(G);
    }
  }
  if (G.phase !== 'over') bad(`a ${n}-player tournament never finished (phase ${G.phase}, round ${G.round})`);
  return G;
}

// The Robot at an odd table: it never drafts, keeps its eight start cards, and
// only stands in — no Trophy, no ranking, no final. Alone against it, the
// two-player rules: no final, and the Robot may win.
let robotWins = 0, robotGames = 0, soloRobot = 0, solos = 0;
function robotChecks(G, n) {
  const R = G.players.filter((p) => p.robot);
  if (R.length !== n % 2) { bad(`a table of ${n} has ${R.length} Robots`); return; }
  if (!R.length) return;
  const r = R[0];
  if (r.draft) bad('the Robot drafted');
  const keys = r.deck.map((id) => G.cards[id].key);
  for (const k of new Set(CH.ROBOT_DECK)) {
    const want = CH.ROBOT_DECK.filter((x) => x === k).length;
    const have = keys.filter((x) => x === k).length;
    if (have !== want) bad(`the Robot ended with ${have} ${k}, not ${want}`);
  }
  const played = G.history.filter((h) => h.seats.includes(r.seat));
  robotGames += played.length;
  robotWins += played.filter((h) => h.winner === r.seat).length;
  if (n === 1) {
    solos++;
    if (G.winner === r.seat) soloRobot++;
    if (G.history.some((h) => h.final)) bad('the solo game played a final');
    const won = G.history.filter((h) => h.winner === r.seat).length;
    if (r.trophies.length !== won) bad(`alone, the Robot won ${won} matches but holds ${r.trophies.length} Trophies`);
    return;
  }
  if (r.trophies.length) bad(`the Robot kept a Trophy at a table of ${n}`);
  if (G.winner === r.seat) bad(`the Robot won a tournament of ${n}`);
  if (G.history.some((h) => h.final && h.seats.includes(r.seat))) bad('the Robot played the final');
  if (G.result.ranked.some((x) => x.seat === r.seat)) bad('the Robot is ranked');
  const won = G.history.filter((h) => !h.final && h.winner !== r.seat).length;
  const held = G.players.reduce((t, p) => t + p.trophies.length, 0);
  if (won !== held) bad(`the ranked players won ${won} matches but hold ${held} Trophies`);
}

const configs = [
  ['base', CH.defaultOpts('base')],
  ['beach', CH.defaultOpts('beach')],
  ['mixed', { box: 'base', basic: 'city', sets: ['castle', 'secret', 'mountain', 'funfair', 'forest'] }],
  ['mixed rainbow', { box: 'beach', basic: 'rainbow', sets: ['space', 'haunted', 'toystore', 'university', 'shipwreck'] }],
];
let games = 0, finals = 0, early = 0;
const t0 = Date.now();
for (const [label, opts] of configs) {
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
    for (let g = 0; g < 6; g++) {
      const G = play(n, opts);
      robotChecks(G, n);
      games++;
      if (G.history.some((h) => h.final)) finals++;
      if (n <= 2 && G.round < 7) early++;
      if (G.phase === 'over' && G.winner === null) bad('a finished game has no winner');
    }
  }
  console.log(`  ${label}: done`);
}
console.log(`  ${games} tournaments, ${finals} finals, ${early} two-player and solo games ended early on an 11-fan lead, ${Date.now() - t0}ms`);
console.log(`  the Robot won ${robotWins} of the ${robotGames} matches it played, and ${soloRobot} of ${solos} solo games`);
if (!robotWins) bad('the Robot never won a match — the rules for its wins went untested');
console.log(fails ? `\n${fails} FAILURES` : '\nall invariants held');
process.exit(fails ? 1 : 0);
