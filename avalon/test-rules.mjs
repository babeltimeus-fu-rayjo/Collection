// The rules, checked one at a time against the rulebook's wording: the two
// charts, who sees whom at the reveal, the vote, the Quest, the Lady of the
// Lake, the assassination — and that no player's view shows what it must not.
import * as A from './game.js';

let fails = 0, checks = 0;
const eq = (got, want, what) => {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(want)) { console.log(`  **FAIL** ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); fails++; }
};
const ok = (cond, what) => eq(!!cond, true, what);
const bad = (res, what) => eq(res.ok, false, what);

// a table with the Characters dealt as given, the first Leader as given
function table(roles, { leader = 0, lady = false, ...opts } = {}) {
  const n = roles.length;
  const base = { ...A.defaultOpts(), lady };
  for (const r of roles) if (A.OPTIONAL.includes(r)) base[r] = true;
  const G = A.newGame(roles.map((_, i) => ({ seat: i, name: 'P' + i, bot: true })), { ...base, ...opts });
  roles.forEach((r, i) => { G.players[i].role = r; });
  G.leader = leader;
  if (G.lady) { const h = (leader + n - 1) % n; G.lady = { holder: h, held: [h], checks: [] }; }
  return G;
}
const play = (G, seat, move) => { const r = A.applyMove(G, seat, move); if (!r.ok) throw new Error(`${JSON.stringify(move)} by ${seat}: ${r.error}`); return r; };
const voteAll = (G, yes) => { for (const p of G.players) play(G, p.seat, { kind: 'vote', approve: yes.includes(p.seat) }); };
const everyone = (G) => G.players.map((p) => p.seat);
const FIVE = ['merlin', 'servant', 'servant', 'assassin', 'minion'];
const SEVEN = ['merlin', 'servant', 'servant', 'servant', 'assassin', 'minion', 'minion'];

console.log('— the charts —');
eq(A.SIDES, { 5: [3, 2], 6: [4, 2], 7: [4, 3], 8: [5, 3], 9: [6, 3], 10: [6, 4] }, 'the Set Up chart');
eq(A.TEAM_SIZES, { 5: [2, 3, 2, 3, 3], 6: [2, 3, 4, 3, 4], 7: [2, 3, 3, 4, 4], 8: [3, 4, 4, 5, 5], 9: [3, 4, 4, 5, 5], 10: [3, 4, 4, 5, 5] }, 'the Team Building chart');
eq([5, 6, 7, 10].map((n) => [0, 1, 2, 3, 4].map((q) => A.failsNeeded(n, q))), [[1, 1, 1, 1, 1], [1, 1, 1, 1, 1], [1, 1, 1, 2, 1], [1, 1, 1, 2, 1]], 'two Fails on the 4th Quest at 7 or more, and only there');
for (let n = 5; n <= 10; n++) {
  const cast = A.castFor(n, { percival: true, morgana: true, mordred: n >= 7, oberon: false });
  eq([cast.filter((r) => A.sideOf(r) === 'good').length, cast.filter((r) => A.sideOf(r) === 'evil').length], A.SIDES[n], `${n} players are dealt the chart's sides`);
  ok(cast.includes('merlin') && cast.includes('assassin'), `Merlin and the Assassin are in every game of ${n}`);
}
ok(A.canStart(5, { ...A.defaultOpts(), morgana: true, mordred: true }), 'two agents of Evil cannot hold the Assassin, Morgana and Mordred');
eq(A.canStart(10, { ...A.defaultOpts(), percival: true, morgana: true, mordred: true, oberon: true }), null, 'ten players can take every Character');
ok(A.canStart(4, A.defaultOpts()), 'four players are too few');

console.log('— the reveal —');
{
  const G = table(['merlin', 'percival', 'servant', 'servant', 'assassin', 'morgana', 'mordred', 'oberon', 'servant', 'servant']);
  const k = (s) => A.knowledge(G, s);
  eq(k(0), { 4: 'evil', 5: 'evil', 7: 'evil' }, 'Merlin sees the agents of Evil, Oberon too — but not Mordred');
  eq(k(1), { 0: 'merlin?', 5: 'merlin?' }, 'Percival sees Merlin and Morgana, and cannot tell them apart');
  eq(k(2), {}, 'a Loyal Servant sees nothing');
  eq(k(4), { 5: 'evil', 6: 'evil' }, 'the Assassin sees Morgana and Mordred — not Oberon');
  eq(k(6), { 4: 'evil', 5: 'evil' }, 'Mordred sees his fellows');
  eq(k(7), {}, 'Oberon sees no one');
  const H = table(['merlin', 'percival', 'servant', 'assassin', 'minion']);
  eq(A.knowledge(H, 1), { 0: 'merlin' }, 'without Morgana, Percival knows Merlin for certain');
}

console.log('— building and voting on a Team —');
{
  const G = table(FIVE, { leader: 2 });
  bad(A.applyMove(G, 0, { kind: 'propose', team: [0, 1] }), 'only the Leader proposes');
  bad(A.applyMove(G, 2, { kind: 'propose', team: [0, 1, 2] }), 'the first Quest at 5 needs two');
  bad(A.applyMove(G, 2, { kind: 'propose', team: [1, 1] }), 'a player takes one Team Token');
  play(G, 2, { kind: 'propose', team: [4, 2] });
  eq([G.phase, G.team], ['vote', [2, 4]], 'a Team of two goes to the vote, in table order');
  play(G, 0, { kind: 'vote', approve: true });
  bad(A.applyMove(G, 0, { kind: 'vote', approve: false }), 'one vote each');
  for (const s of [1, 2, 3, 4]) play(G, s, { kind: 'vote', approve: s < 3 });
  eq([G.phase, G.proposals[0].approved, G.rejects], ['quest', true, 0], 'three of five approve: the Team goes on its Quest');

  const T = table(['merlin', 'servant', 'servant', 'servant', 'assassin', 'minion']);
  play(T, 0, { kind: 'propose', team: [0, 1] });
  voteAll(T, [0, 1, 2]);
  eq([T.phase, T.rejects, T.leader], ['team', 1, 1], 'a tied vote is a rejection; the Vote Track moves and the Leader passes clockwise');

  const R = table(FIVE);
  for (let i = 0; i < 4; i++) { play(R, A.waitingOn(R)[0], { kind: 'propose', team: [0, 1] }); voteAll(R, []); }
  eq([R.phase, R.rejects], ['team', 4], 'four rejections in a round and the game goes on');
  play(R, A.waitingOn(R)[0], { kind: 'propose', team: [0, 1] });
  voteAll(R, [0]);
  eq([R.phase, R.winner], ['over', 'evil'], '"Evil wins the game if five Teams are rejected in a single round"');
}

console.log('— the Quest —');
{
  const G = table(FIVE);
  play(G, 0, { kind: 'propose', team: [1, 3] });
  voteAll(G, everyone(G));
  bad(A.applyMove(G, 1, { kind: 'quest', card: 'fail' }), 'Loyal Servants of Arthur must play Success');
  bad(A.applyMove(G, 0, { kind: 'quest', card: 'success' }), 'only the Team plays Quest cards');
  play(G, 1, { kind: 'quest', card: 'success' });
  play(G, 3, { kind: 'quest', card: 'fail' });
  eq([G.results[0].success, G.results[0].fails, G.quest, G.leader, G.phase], [false, 1, 1, 1, 'team'], 'one Fail fails the Quest; the next round starts with the next Leader');

  // the Vote Track starts over after a Quest
  const V = table(FIVE);
  play(V, 0, { kind: 'propose', team: [0, 1] }); voteAll(V, []);
  play(V, 1, { kind: 'propose', team: [0, 1] }); voteAll(V, everyone(V));
  play(V, 0, { kind: 'quest', card: 'success' }); play(V, 1, { kind: 'quest', card: 'success' });
  eq([V.rejects, V.results[0].success], [0, true], 'the Vote Track is cleared once a Quest is done');

  // the 4th Quest at seven players
  const S = table(SEVEN);
  S.quest = 3;
  S.results = [{ quest: 0, team: [0, 1], fails: 0, needed: 1, success: true }, { quest: 1, team: [0, 1, 2], fails: 1, needed: 1, success: false }, { quest: 2, team: [0, 1, 2], fails: 1, needed: 1, success: false }];
  play(S, 0, { kind: 'propose', team: [0, 1, 2, 4] });
  voteAll(S, everyone(S));
  for (const s of [0, 1, 2]) play(S, s, { kind: 'quest', card: 'success' });
  play(S, 4, { kind: 'quest', card: 'fail' });
  eq([S.results[3].success, S.results[3].fails, S.phase], [true, 1, 'team'], 'one Fail does not fail the 4th Quest at 7 players');
  const S2 = table(SEVEN);
  S2.quest = 3;
  S2.results = S.results.slice(0, 3);
  play(S2, 0, { kind: 'propose', team: [0, 4, 5, 6] });
  voteAll(S2, everyone(S2));
  play(S2, 0, { kind: 'quest', card: 'success' });
  for (const s of [4, 5]) play(S2, s, { kind: 'quest', card: 'fail' });
  play(S2, 6, { kind: 'quest', card: 'success' });
  eq([S2.results[3].success, S2.phase, S2.winner], [false, 'over', 'evil'], 'two Fails do — the third failed Quest, and Evil wins');
}

console.log('— the assassination —');
for (const [target, winner] of [[0, 'evil'], [1, 'good']]) {
  const G = table(FIVE);
  G.results = [0, 1].map((q) => ({ quest: q, team: [0, 1], fails: 0, needed: 1, success: true }));
  G.quest = 2;
  play(G, 0, { kind: 'propose', team: [0, 1] });
  voteAll(G, everyone(G));
  play(G, 0, { kind: 'quest', card: 'success' });
  play(G, 1, { kind: 'quest', card: 'success' });
  eq(G.phase, 'assassin', 'three successes call on the Assassin');
  bad(A.applyMove(G, 4, { kind: 'assassinate', target: 0 }), 'only the Assassin names Merlin');
  bad(A.applyMove(G, 3, { kind: 'assassinate', target: 4 }), 'the Assassin names a Good player, not a known agent of Evil');
  play(G, 3, { kind: 'assassinate', target });
  eq(G.winner, winner, target === 0 ? 'naming Merlin wins it for Evil' : 'missing Merlin wins it for Good');
}
{
  const G = table(['merlin', 'servant', 'servant', 'servant', 'assassin', 'oberon', 'minion']);
  G.phase = 'assassin';
  eq(A.applyMove(G, 4, { kind: 'assassinate', target: 5 }).ok, true, 'Oberon, unknown to the Assassin, can be named — and is not Merlin');
  eq(G.winner, 'good', 'naming Oberon misses Merlin');
}

console.log('— the Lady of the Lake —');
{
  const G = table(SEVEN, { leader: 0, lady: true });
  eq(G.lady.holder, 6, 'the Lady starts on the Leader’s right');
  const quest = (team, card = 'success') => {
    play(G, A.waitingOn(G)[0], { kind: 'propose', team });
    voteAll(G, everyone(G));
    for (const s of team) play(G, s, { kind: 'quest', card: A.sideOf(G.players[s].role) === 'evil' ? card : 'success' });
  };
  quest([0, 1]);
  eq(G.phase, 'team', 'no Lady after the first Quest');
  quest([0, 1, 4], 'fail');
  eq(G.phase, 'lady', 'the Lady after the second Quest');
  bad(A.applyMove(G, 0, { kind: 'lady', target: 1 }), 'only the holder examines');
  bad(A.applyMove(G, 6, { kind: 'lady', target: 6 }), 'not oneself, who has held it');
  play(G, 6, { kind: 'lady', target: 4 });
  eq(A.viewFor(G, 6, 'X').check.loyalty, 'evil', 'the holder sees the loyalty');
  eq(A.viewFor(G, 0, 'X').check.loyalty, undefined, 'no one else does');
  play(G, 6, { kind: 'declare', says: 'good' });
  eq([G.lady.holder, G.lady.held, G.phase], [4, [6, 4], 'team'], 'the Lady passes to the examined player');
  eq(A.knowledge(G, 6)[4], 'evil', 'the holder remembers what the Lady showed');
  eq(A.viewFor(G, 2, 'X').lady.checks[0].declared, 'good', 'the declaration — a lie here — is public');
  quest([0, 1, 2]);
  bad(A.applyMove(G, 4, { kind: 'lady', target: 6 }), 'a player who used the Lady cannot be examined');
  play(G, 4, { kind: 'lady', target: 0 });
  play(G, 4, { kind: 'declare', says: null });
  eq(G.lady.holder, 0, 'saying nothing still passes the Lady on');
}

console.log('— what each player may see —');
{
  const G = table(['merlin', 'percival', 'servant', 'servant', 'assassin', 'morgana', 'mordred'], { lady: true });
  play(G, 0, { kind: 'propose', team: [0, 1] });
  for (const s of [0, 1, 2]) play(G, s, { kind: 'vote', approve: s !== 1 });
  for (const p of G.players) {
    const v = A.viewFor(G, p.seat, 'X');
    const shown = v.players.filter((q) => q.role !== undefined).map((q) => q.seat);
    eq(shown, [p.seat], `seat ${p.seat} sees only its own Character`);
    ok(!JSON.stringify(v).includes('"votes":{"0"') && v.proposals.length === 0, `seat ${p.seat} sees no vote before the last is in`);
    eq(v.voted, [0, 1, 2], `seat ${p.seat} sees who has voted`);
    eq(v.myVote, p.seat < 3 ? p.seat !== 1 : undefined, `seat ${p.seat} sees its own vote`);
  }
  for (const s of [3, 4, 5, 6]) play(G, s, { kind: 'vote', approve: true });
  play(G, 0, { kind: 'quest', card: 'success' });
  const v = A.viewFor(G, 3, 'X');
  eq(v.played, [0], 'who has played a Quest card is public');
  ok(!('cards' in v) && v.myCard === null, 'what they played is not');
  play(G, 1, { kind: 'quest', card: 'success' });
  const done = A.viewFor(G, 3, 'X');
  eq([Object.keys(done.results[0]).sort(), done.played, 'cards' in done], [['fails', 'needed', 'quest', 'success', 'team'], [], false], 'a finished Quest shows how many Fails, never whose cards');
  G.phase = 'over';
  eq(A.viewFor(G, 3, 'X').players.every((q) => q.role), true, 'at the end every Character is shown');
}

console.log(`\n${checks} checks` + (fails ? `, ${fails} FAILURES` : ', all pass'));
process.exit(fails ? 1 : 0);
