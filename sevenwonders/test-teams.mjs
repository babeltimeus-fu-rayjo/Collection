import * as SW from './game.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : '**FAIL**'}  ${m}`); if (!c) fails++; };

for (const n of [4, 6]) {
  const roster = Array.from({ length: n }, (_, s) => ({ seat: s, name: 'P' + s, bot: true }));
  const G = SW.newMatch(roster, { teams: true });

  // the seating promise: exactly one neighbour is your partner
  let allGood = true;
  for (const p of G.players) {
    const nb = [SW.leftOf(G, p.seat), SW.rightOf(G, p.seat)].map((s) => SW.playerBySeat(G, s));
    const mates = nb.filter((q) => q.team === p.team).length;
    if (mates !== 1) allGood = false;
  }
  ok(allGood, `${n}p: every player has exactly one partner beside them and one opponent`);
  ok(new Set(G.players.map((p) => p.team)).size === n / 2, `${n}p: ${n / 2} teams of two`);

  // play it out and check the military consequences
  let guard = 0;
  while (G.phase !== 'over' && guard++ < 200) {
    for (const p of G.players) { const mv = SW.botChoose(G, p.seat); if (mv) SW.applyMove(G, p.seat, mv); }
  }
  ok(G.phase === 'over', `${n}p: a team game plays to the end`);
  // one border each, two tokens a time, three ages => at most 6 tokens
  const worst = Math.max(...G.players.map((p) => p.tokens.length));
  ok(worst <= 6, `${n}p: at most 6 conflict tokens each (got ${worst})`);
  ok(G.players.every((p) => p.tokens.length % 2 === 0), `${n}p: tokens come in doubled pairs`);
  ok(!!G.result.teams && G.result.teams.length === n / 2, `${n}p: the result is scored by team`);
  const t0 = G.result.teams[0];
  const sum = G.result.scores.filter((s) => s.team === t0.team).reduce((a, s) => a + s.total, 0);
  ok(t0.total === sum, `${n}p: a team score is its two members added up (${t0.total})`);
}

// and a non-team game is unchanged: two borders, single tokens
const G = SW.newMatch(Array.from({ length: 4 }, (_, s) => ({ seat: s, name: 'P' + s, bot: true })), {});
let guard = 0;
while (G.phase !== 'over' && guard++ < 200) for (const p of G.players) { const mv = SW.botChoose(G, p.seat); if (mv) SW.applyMove(G, p.seat, mv); }
ok(G.players.every((p) => p.tokens.length <= 6), 'solo play: still at most 6 tokens (two borders, three ages)');
ok(G.result.teams === null, 'solo play: no team table');

console.log(fails ? `\n${fails} FAILURES` : '\nteam rules hold');
process.exit(fails ? 1 : 0);
