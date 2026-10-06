// The rules, checked one at a time against the Big Box rulebook's wording:
// the two charts, who sees whom at the reveal, the vote, the Quest, the Lady
// of the Lake, the assassination; every Character, module and optional rule
// the Big Box adds — and that no player's view shows what it must not.
import * as A from './game.js';

let fails = 0, checks = 0;
const eq = (got, want, what) => {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(want)) { console.log(`  **FAIL** ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); fails++; }
};
const ok = (cond, what) => eq(!!cond, true, what);
const bad = (res, what) => eq(res.ok, false, what);

// a table with the Characters dealt as given (seat order), the first Leader as given
function table(roles, { leader = 0, ...opts } = {}) {
  const n = roles.length;
  const base = A.defaultOpts();
  for (const r of roles) if (r in base) base[r] = true;
  if (roles.includes('lancelotGood')) base.lancelot = true;
  if (roles.includes('rogueGood')) base.rogueGood = true;
  if (roles.includes('rogueEvil')) base.rogueEvil = true;
  if (roles.includes('sorcererGood')) base.sorcerers = true;
  if (roles.includes('messengerSenior')) base.messengers = true;
  const G = A.newGame(roles.map((_, i) => ({ seat: i, name: 'P' + i, bot: true })), { ...base, ...opts });
  return A.redeal(G, roles, leader);
}
const play = (G, seat, move) => { const r = A.applyMove(G, seat, move); if (!r.ok) throw new Error(`${JSON.stringify(move)} by ${seat}: ${r.error}`); return r; };
const asked = (G) => (G.ask ? G.ask.kind : G.phase);
const voteAll = (G, yes) => { for (let i = 0; i < 20 && G.phase === 'vote'; i++) for (const s of A.waitingOn(G)) play(G, s, { kind: 'vote', approve: yes.includes(s) }); };
const everyone = (G) => G.players.map((p) => p.seat);
// pass on every Plot-card window, the Watch token to the first on the Team
function skip(G) {
  for (let i = 0; i < 30 && G.ask; i++) {
    const a = G.ask;
    if (a.kind === 'lead' || a.kind === 'king') play(G, a.seat, { kind: a.kind, use: false });
    else if (a.kind === 'spot' || a.kind === 'ambush' || a.kind === 'excalibur') play(G, a.seat, { kind: a.kind, target: null });
    else if (a.kind === 'watch') play(G, a.seat, { kind: 'watch', target: G.team[0] });
    else return;
  }
}
// a whole Quest: the Leader proposes, everyone approves, the Team plays
function quest(G, team, cards = {}, extra = {}) {
  skip(G);
  play(G, A.waitingOn(G)[0], { kind: 'propose', team, ...extra });
  voteAll(G, everyone(G));
  skip(G);
  for (const s of G.team) if (G.phase === 'quest') play(G, s, { kind: 'quest', card: cards[s] || 'success' });
  skip(G);
}
const FIVE = ['merlin', 'servant', 'servant', 'assassin', 'minion'];
const SEVEN = ['merlin', 'servant', 'servant', 'servant', 'assassin', 'minion', 'minion'];

console.log('— the charts —');
eq(A.SIDES, { 5: [3, 2], 6: [4, 2], 7: [4, 3], 8: [5, 3], 9: [6, 3], 10: [6, 4] }, 'the Set Up chart');
eq(A.TEAM_SIZES, { 5: [2, 3, 2, 3, 3], 6: [2, 3, 4, 3, 4], 7: [2, 3, 3, 4, 4], 8: [3, 4, 4, 5, 5], 9: [3, 4, 4, 5, 5], 10: [3, 4, 4, 5, 5] }, 'the Team Building chart');
eq([5, 6, 7, 10].map((n) => [0, 1, 2, 3, 4].map((q) => A.failsNeeded(n, q))), [[1, 1, 1, 1, 1], [1, 1, 1, 1, 1], [1, 1, 1, 2, 1], [1, 1, 1, 2, 1]], 'two Fails on the 4th Quest at 7 or more, and only there');
for (let n = 5; n <= 10; n++) {
  const cast = A.castFor(n, { ...A.defaultOpts(), percival: true, morgana: true, mordred: n >= 7 });
  eq([cast.filter((r) => A.sideOf(r) === 'good').length, cast.filter((r) => A.sideOf(r) === 'evil').length], A.SIDES[n], `${n} players are dealt the chart's sides`);
  ok(cast.includes('merlin') && cast.includes('assassin'), `Merlin and the Assassin are in every game of ${n}`);
}
ok(A.canStart(5, { ...A.defaultOpts(), morgana: true, mordred: true }), 'two agents of Evil cannot hold the Assassin, Morgana and Mordred');
eq(A.canStart(10, { ...A.defaultOpts(), percival: true, morgana: true, mordred: true, oberon: true }), null, 'ten players can take every base Character');
ok(A.canStart(4, A.defaultOpts()), 'four players are too few');
eq(A.castFor(7, { ...A.defaultOpts(), lancelot: true }).filter((r) => r.startsWith('lancelot')).sort(), ['lancelotEvil', 'lancelotGood'], '"use both Lancelot character cards in place of one Good and one Evil character card"');
eq(A.castFor(7, { ...A.defaultOpts(), messengers: true }).filter((r) => r.startsWith('messenger')).sort(), ['messengerEvil', 'messengerJunior', 'messengerSenior'], '"Two Messengers are Good, and the other is Evil"');
eq(A.castFor(7, { ...A.defaultOpts(), sorcerers: true }).filter((r) => r.startsWith('sorcerer')).sort(), ['sorcererEvil', 'sorcererGood'], '"One Sorcerer is Good, and one is Evil"');
eq(A.castFor(7, { ...A.defaultOpts(), rogueEvil: true }).filter((r) => r.startsWith('rogue')), ['rogueEvil'], '"A game can include both Rogues or just one"');
eq(Object.values(A.PLOTS).reduce((t, c) => t + c.count, 0), 15, 'fifteen Plot cards');
eq(A.PLOTS_DRAWN, { 5: 1, 6: 1, 7: 2, 8: 2, 9: 3, 10: 3 }, '"one for 5-6 players, two for 7-8 players, and three for 9-10 players"');
ok(A.canStart(6, { ...A.defaultOpts(), plot: true }), 'Plot cards wait for seven or more, until the five-or-six deck is checked');

console.log('— the reveal —');
{
  const G = table(['merlin', 'percival', 'servant', 'servant', 'assassin', 'morgana', 'mordred', 'oberon', 'servant', 'servant']);
  const k = (s) => A.knowledge(G, s);
  eq(k(0), { 4: 'evil', 5: 'evil', 7: 'evil' }, 'Merlin sees the agents of Evil, Oberon too — but not Mordred');
  eq(k(1), { 0: 'merlin?', 5: 'merlin?' }, 'Percival sees Merlin and Morgana, and cannot tell them apart');
  eq(k(2), {}, 'a Loyal Servant sees nothing');
  eq(k(4), { 5: 'evil', 6: 'evil' }, 'the Assassin sees Morgana and Mordred — not Oberon');
  eq(k(7), {}, 'Oberon sees no one');
  const H = table(['merlin', 'percival', 'servant', 'assassin', 'minion']);
  eq(A.knowledge(H, 1), { 0: 'merlin' }, 'without Morgana, Percival knows Merlin for certain');
}
{
  const G = table(['merlin', 'untrustworthy', 'servant', 'servant', 'servant', 'assassin', 'minion', 'rogueEvil']);
  eq(A.knowledge(G, 0), { 1: 'evil', 5: 'evil', 6: 'evil' }, 'Merlin takes the Untrustworthy Servant for Evil, and does not see the Evil Rogue');
  eq(A.knowledge(G, 1), { 5: 'assassin' }, '"the Assassin is revealed to the Untrustworthy Servant"');
  eq(A.knowledge(G, 5), { 6: 'evil' }, '"the Evil Rogue does not open their eyes or extend their thumb"');
  eq(A.knowledge(G, 7), {}, '…and sees no one');
}
{
  const G = table(['merlin', 'lancelotGood', 'servant', 'servant', 'assassin', 'lancelotEvil', 'minion']);
  eq([A.knowledge(G, 1), A.knowledge(G, 5)], [{ 5: 'lancelot-evil' }, { 1: 'lancelot-good', 4: 'evil', 6: 'evil' }], '"These two Lancelots know each other, and each other\'s true allegiance"');
  const V = table(['merlin', 'lancelotGood', 'servant', 'servant', 'assassin', 'lancelotEvil', 'minion'], { lancelotVariant: 1 });
  eq([A.knowledge(V, 1), A.knowledge(V, 5), A.knowledge(V, 4)], [{}, {}, { 5: 'lancelot-evil', 6: 'evil' }], 'variants: the Lancelots do not know each other; Evil Lancelot is known to Evil but does not know them');
  eq(A.knowledge(V, 0)[5], 'evil', 'Merlin sees Evil Lancelot');
}
{
  const G = table(['merlin', 'sorcererGood', 'servant', 'servant', 'assassin', 'sorcererEvil', 'minion'], { sorcererHidden: true });
  eq([A.knowledge(G, 0), A.knowledge(G, 4), A.knowledge(G, 5)], [{ 4: 'evil', 6: 'evil' }, { 6: 'evil' }, {}], '"The Evil Sorcerer does not reveal themself in the Reveal stage" (the optional rule)');
  const M = table(['merlin', 'messengerSenior', 'messengerJunior', 'servant', 'assassin', 'messengerEvil', 'minion'], { messengerSenior: true });
  eq([A.knowledge(M, 1), A.knowledge(M, 2)], [{ 2: 'junior' }, {}], '"the Senior Messenger knows who the Junior Messenger is"');
}

console.log('— building and voting on a Team —');
{
  const G = table(FIVE, { leader: 2 });
  eq([asked(G), G.ask.seat], ['propose', 2], 'the Leader is asked for a Team');
  bad(A.applyMove(G, 0, { kind: 'propose', team: [0, 1] }), 'only the Leader proposes');
  bad(A.applyMove(G, 2, { kind: 'propose', team: [0, 1, 2] }), 'the first Quest at 5 needs two');
  bad(A.applyMove(G, 2, { kind: 'propose', team: [1, 1] }), 'a player takes one Team token');
  play(G, 2, { kind: 'propose', team: [4, 2] });
  eq([G.phase, G.team], ['vote', [2, 4]], 'a Team of two goes to the vote, in table order');
  play(G, 0, { kind: 'vote', approve: true });
  bad(A.applyMove(G, 0, { kind: 'vote', approve: false }), 'one vote each');
  for (const s of [1, 2, 3, 4]) play(G, s, { kind: 'vote', approve: s < 3 });
  eq([G.phase, G.proposals[0].approved, G.rejects], ['quest', true, 0], 'three of five approve: the Team goes on its Quest');

  const T = table(['merlin', 'servant', 'servant', 'servant', 'assassin', 'minion']);
  play(T, 0, { kind: 'propose', team: [0, 1] });
  voteAll(T, [0, 1, 2]);
  eq([asked(T), T.rejects, T.leader], ['propose', 1, 1], 'a tied vote is a rejection; the Vote Track moves and the Leader passes clockwise');

  const R = table(FIVE);
  for (let i = 0; i < 4; i++) { play(R, A.waitingOn(R)[0], { kind: 'propose', team: [0, 1] }); voteAll(R, []); }
  eq([asked(R), R.rejects], ['propose', 4], 'four rejections in a round and the game goes on');
  play(R, A.waitingOn(R)[0], { kind: 'propose', team: [0, 1] });
  voteAll(R, [0]);
  eq([R.phase, R.winner], ['over', 'evil'], '"Evil wins the game if five Teams are rejected in a single round"');
}

console.log('— the Quest —');
{
  const G = table(FIVE);
  play(G, 0, { kind: 'propose', team: [1, 3] });
  voteAll(G, everyone(G));
  bad(A.applyMove(G, 1, { kind: 'quest', card: 'fail' }), '"Good players must select a Success card"');
  bad(A.applyMove(G, 0, { kind: 'quest', card: 'success' }), 'only the Team plays Quest cards');
  bad(A.applyMove(G, 3, { kind: 'quest', card: 'magic' }), 'no Magic without the Sorcerers');
  play(G, 1, { kind: 'quest', card: 'success' });
  play(G, 3, { kind: 'quest', card: 'fail' });
  eq([G.results[0].success, G.results[0].fails, G.quest, G.leader, asked(G)], [false, 1, 1, 1, 'propose'], 'one Fail fails the Quest; the next round starts with the next Leader');
  const S = table(SEVEN);
  S.quest = 3;
  S.results = [true, false, false].map((success, q) => ({ quest: q, team: [0, 1], fails: success ? 0 : 1, needed: 1, success, magic: 0, messages: { good: 0, evil: 0 }, rogue: { success: 0, fail: 0 }, rogueBy: [] }));
  quest(S, [0, 1, 2, 4], { 4: 'fail' });
  eq([S.results[3].success, S.results[3].fails], [true, 1], 'one Fail does not fail the 4th Quest at 7 players');
}

console.log('— the assassination —');
for (const [target, winner] of [[0, 'evil'], [1, 'good']]) {
  const G = table(FIVE);
  quest(G, [0, 1]);
  quest(G, [0, 1, 2]);
  quest(G, [0, 1]);
  eq([G.phase, G.ask && G.ask.seat], ['assassin', 3], 'three successes call on the Assassin');
  bad(A.applyMove(G, 4, { kind: 'assassinate', target: 0 }), 'only the Assassin names Merlin');
  bad(A.applyMove(G, 3, { kind: 'assassinate', target: 4 }), 'the Assassin names a Good player, not a known agent of Evil');
  play(G, 3, { kind: 'assassinate', target });
  eq(G.winner, winner, target === 0 ? 'naming Merlin wins it for Evil' : 'missing Merlin wins it for Good');
}

console.log('— the Lady of the Lake —');
{
  const G = table(['merlin', 'servant', 'servant', 'assassin', 'minion', 'minion', 'servant'], { leader: 0, lady: true });
  eq(G.lady.holder, 6, '"give the Lady of the Lake token to the player on the Leader\'s right"');
  quest(G, [0, 1]);
  eq(asked(G), 'propose', 'no Lady after the first Quest');
  quest(G, [0, 1, 4], { 4: 'fail' });
  eq([asked(G), G.ask.seat], ['lady', 6], 'the Lady after the second Quest');
  bad(A.applyMove(G, 6, { kind: 'lady', target: 6 }), 'not oneself, who has held it');
  play(G, 6, { kind: 'lady', target: 4 });
  eq([asked(G), G.ask.seat, A.viewFor(G, 4, 'X').me.loyalty], ['loyalty', 4, ['evil']], 'the examined player passes their Loyalty card — the true one');
  bad(A.applyMove(G, 4, { kind: 'loyalty', card: 'good' }), 'a Minion cannot show Good');
  play(G, 4, { kind: 'loyalty', card: 'evil' });
  eq(A.knowledge(G, 6)[4], 'shown-evil', 'the holder sees the loyalty');
  eq(A.knowledge(G, 0)[4], 'evil', 'Merlin knew already; no one else learns it');
  play(G, 6, { kind: 'declare', says: 'good' });
  eq([G.lady.holder, G.lady.held, asked(G)], [4, [6, 4], 'propose'], 'the Lady passes to the examined player');
  eq(A.viewFor(G, 2, 'X').lady.checks[0].declared, 'good', 'the declaration — a lie here — is public');
  eq(A.viewFor(G, 2, 'X').lady.checks[0].shown, undefined, 'what she showed is not');
}

console.log('— Characters —');
{
  // the Lunatic and the Brute
  const G = table(['merlin', 'servant', 'servant', 'servant', 'assassin', 'lunatic', 'brute']);
  play(G, 0, { kind: 'propose', team: [0, 5] });
  voteAll(G, everyone(G));
  bad(A.applyMove(G, 5, { kind: 'quest', card: 'success' }), '"they must Fail every Quest that they are on"');
  play(G, 5, { kind: 'quest', card: 'fail' });
  play(G, 0, { kind: 'quest', card: 'success' });
  quest(G, [6, 1, 2], { 6: 'success' });
  quest(G, [6, 1, 2], { 6: 'fail' });
  eq(G.results.map((r) => r.success), [false, true, false], 'the Brute may Fail the first three Quests');
  play(G, A.waitingOn(G)[0], { kind: 'propose', team: [6, 1, 2, 3] });
  voteAll(G, everyone(G));
  bad(A.applyMove(G, 6, { kind: 'quest', card: 'fail' }), '"They may Fail only the first three Quests"');
}
{
  // the Revealer
  const G = table(['merlin', 'servant', 'servant', 'servant', 'assassin', 'revealer', 'minion']);
  quest(G, [0, 5], { 5: 'fail' });
  eq(A.viewFor(G, 0, 'X').players[5].role, undefined, 'the Revealer is hidden after one failed Quest');
  quest(G, [0, 1, 5], { 5: 'fail' });
  eq([G.players[5].revealed, A.viewFor(G, 2, 'X').players[5].role], [true, 'revealer'], '"They must reveal their identity after the second failed Quest"');
}
{
  // the Cleric, with a Trickster or a Troublemaker for first Leader
  const G = table(['merlin', 'cleric', 'servant', 'servant', 'assassin', 'trickster', 'minion'], { leader: 5 });
  eq([asked(G), G.ask.seat, A.viewFor(G, 5, 'X').me.loyalty], ['loyalty', 5, ['evil', 'good']], '"During the Reveal stage, they learn if the Leader is on the side of Good or on the side of Evil" — the Trickster "may lie"');
  eq(A.viewFor(G, 2, 'X').ask.checker, undefined, 'no one else learns who the Cleric is');
  eq(A.viewFor(G, 2, 'X').checks, [], '…not from the list of checks either');
  play(G, 5, { kind: 'loyalty', card: 'good' });
  eq([A.knowledge(G, 1)[5], asked(G)], ['shown-good', 'propose'], 'the Cleric is shown Good, and the first round begins');
  const T = table(['merlin', 'cleric', 'troublemaker', 'servant', 'assassin', 'minion', 'minion'], { leader: 2 });
  eq(A.viewFor(T, 2, 'X').me.loyalty, ['evil'], 'the Troublemaker "must lie"');
  play(T, 2, { kind: 'loyalty', card: 'evil' });
  eq(A.knowledge(T, 1)[2], 'shown-evil', 'the Cleric is shown Evil');
  const L = table(['cleric', 'merlin', 'servant', 'servant', 'assassin', 'minion', 'minion'], { leader: 0 });
  eq(asked(L), 'propose', 'a Cleric who leads first has nothing to look at');
}
{
  // the Untrustworthy Servant and the Recruitment stage
  for (const [guess, by] of [[1, 1], [2, 4]]) {
    const G = table(['merlin', 'untrustworthy', 'servant', 'servant', 'assassin', 'minion', 'minion']);
    bad(A.applyMove(G, 0, { kind: 'quest', card: 'fail' }), 'no Quest yet');
    quest(G, [0, 1]);
    bad(A.applyMove(G, 1, { kind: 'quest', card: 'fail' }), 'between Quests');
    quest(G, [0, 1, 2]);
    quest(G, [0, 1, 2]);
    eq([G.phase, G.ask.kind, G.ask.seat], ['recruit', 'recruit', 4], '"If three Quests succeed, enter the Recruitment stage before entering the Assassination stage"');
    play(G, 4, { kind: 'recruit', target: guess });
    eq([G.phase, G.ask.seat, G.players[1].side], ['assassin', by, guess === 1 ? 'evil' : 'good'], guess === 1 ? '"the Untrustworthy Servant ... is now an Evil player [and] performs the Assassination stage"' : 'a wrong guess: the Assassin names Merlin as usual');
    play(G, by, { kind: 'assassinate', target: 3 });
    eq([G.winner, A.won(G, G.players[1])], ['good', guess !== 1], guess === 1 ? '"They win alongside Evil if they correctly identify Merlin, and lose if they do not"' : 'the Untrustworthy Servant stayed Good and wins with Good');
  }
}

console.log('— Lancelot —');
{
  const G = table(['merlin', 'lancelotGood', 'servant', 'servant', 'assassin', 'lancelotEvil', 'minion'], { lancelotVariant: 1 });
  // a known deck: No Change, then Switch
  G.allegiance.deck = ['none', 'switch', 'none', 'switch', 'none', 'none'];
  G.allegiance.drawn = [];
  A.redeal(G, ['merlin', 'lancelotGood', 'servant', 'servant', 'assassin', 'lancelotEvil', 'minion'], 0);
  eq([G.allegiance.drawn, G.players[1].side, G.players[5].side], [['none'], 'good', 'evil'], 'Variant 1: a No Change card at the first Quest');
  quest(G, [0, 1]);
  eq([G.allegiance.drawn, G.players[1].side, G.players[5].side, G.switches], [['none', 'switch'], 'evil', 'good', 1], '"If a Switch Allegiance card is drawn ... The two Lancelot players secretly switch their allegiances"');
  play(G, A.waitingOn(G)[0], { kind: 'propose', team: [1, 2, 3] });
  voteAll(G, everyone(G));
  play(G, 1, { kind: 'quest', card: 'fail' });
  ok(true, 'the Good Lancelot card, now Evil, may Fail: "This switch applies to all aspects of gameplay"');
  for (const s of [2, 3]) play(G, s, { kind: 'quest', card: 'success' });
  eq(G.results[1].success, false, '…and the Quest fails');
  eq(A.viewFor(G, 2, 'X').allegiance.drawn, ['none', 'switch', 'none'], '"This card is not secret" — the third is drawn as the third Quest begins');
}
{
  const G = table(['merlin', 'lancelotGood', 'servant', 'servant', 'assassin', 'lancelotEvil', 'minion'], { lancelotVariant: 2 });
  G.allegiance.dealt = ['none', 'none', 'switch', 'none', 'none'];
  A.redeal(G, ['merlin', 'lancelotGood', 'servant', 'servant', 'assassin', 'lancelotEvil', 'minion'], 0);
  quest(G, [0, 5], { 5: 'fail' });
  play(G, A.waitingOn(G)[0], { kind: 'propose', team: [0, 1, 5] });
  voteAll(G, everyone(G));
  bad(A.applyMove(G, 5, { kind: 'quest', card: 'success' }), 'Variant 2: "Evil Lancelot may only play a Fail card"');
  play(G, 5, { kind: 'quest', card: 'fail' });
  for (const s of [0, 1]) play(G, s, { kind: 'quest', card: 'success' });
  eq([G.players[1].side, G.players[5].side], ['evil', 'good'], '"the two Lancelot players secretly switch their allegiances at the very beginning of the Quest"');
  play(G, A.waitingOn(G)[0], { kind: 'propose', team: [0, 1, 2] });
  voteAll(G, everyone(G));
  bad(A.applyMove(G, 1, { kind: 'quest', card: 'success' }), 'now the other Lancelot must Fail');
}

console.log('— the Rogues —');
{
  const roles = ['merlin', 'rogueGood', 'servant', 'servant', 'assassin', 'rogueEvil', 'minion'];
  const G = table(roles);
  eq(asked(G), 'propose', 'the Rogues need nothing before the first Team');
  play(G, 0, { kind: 'propose', team: [0, 1] });
  voteAll(G, everyone(G));
  eq([asked(G), G.ask.seat], ['watch', 0], '"The Leader must then give the Watch token to one player on the Team"');
  bad(A.applyMove(G, 0, { kind: 'watch', target: 3 }), 'to a member of the Team');
  play(G, 0, { kind: 'watch', target: 1 });
  bad(A.applyMove(G, 1, { kind: 'quest', card: 'rogueSuccess' }), '"If the Watch token was given to a Rogue, that Rogue may not play the Rogue Success"');
  play(G, 1, { kind: 'quest', card: 'success' });
  play(G, 0, { kind: 'quest', card: 'success' });
  bad(A.applyMove(G, 0, { kind: 'quest', card: 'rogueSuccess' }), 'between Quests no one plays');
  // a Good Rogue's own victory
  const R = table(roles);
  const rq = (team, cards) => { skip(R); play(R, A.waitingOn(R)[0], { kind: 'propose', team }); voteAll(R, everyone(R)); if (asked(R) === 'watch') play(R, R.ask.seat, { kind: 'watch', target: team.find((s) => s !== 1) }); for (const s of R.team) play(R, s, { kind: 'quest', card: cards[s] || 'success' }); };
  rq([1, 2], { 1: 'rogueSuccess' });
  eq([R.results[0].success, R.results[0].rogue], [true, { success: 1, fail: 0 }], '"A Rogue Success card acts as a regular Success card" and leaves a token');
  eq(A.viewFor(R, 3, 'X').results[0].rogueBy, undefined, 'the token shows that a Rogue card was played, not by whom');
  rq([0, 2, 3], {});
  rq([1, 2, 3], { 1: 'rogueSuccess' });
  eq([R.phase, R.winner, A.won(R, R.players[1]), A.won(R, R.players[0])], ['over', 'rogueGood', true, false], '"A Good Rogue wins immediately after the third successful Quest if they played the Rogue Success card on the third successful Quest and at least one more"');
  eq(R.assassination, null, '"The Assassination stage is skipped if a Rogue has won"');
  // five or six players: no Watch token on the first two Quests
  const F = table(['merlin', 'rogueGood', 'servant', 'assassin', 'minion']);
  play(F, 0, { kind: 'propose', team: [0, 1] });
  voteAll(F, everyone(F));
  eq(F.phase, 'quest', '"In games of five or six players, a Watch token is not used on the first two Quests"');
}

console.log('— the Sorcerers —');
{
  const G = table(['merlin', 'sorcererGood', 'servant', 'servant', 'assassin', 'sorcererEvil', 'minion']);
  play(G, 0, { kind: 'propose', team: [0, 5] });
  voteAll(G, everyone(G));
  bad(A.applyMove(G, 5, { kind: 'quest', card: 'fail' }), '"The Evil Sorcerer may only play Success or Magic"');
  play(G, 5, { kind: 'quest', card: 'magic' });
  play(G, 0, { kind: 'quest', card: 'success' });
  eq([G.results[0].success, G.results[0].magic], [false, 1], 'Success, Magic: "The Quest fails"');
  quest(G, [1, 2, 6], { 1: 'magic', 6: 'fail' });
  eq(G.results[1].success, true, '"If a Quest has a Fail card and one Magic card, the Quest succeeds"');
  quest(G, [1, 5, 2], { 1: 'magic', 5: 'magic' });
  eq(G.results[2].success, true, 'two Magic cards reverse it twice');
}

console.log('— the Messengers —');
{
  const G = table(['merlin', 'messengerSenior', 'messengerJunior', 'servant', 'assassin', 'messengerEvil', 'minion']);
  quest(G, [1, 2], { 1: 'goodMessage', 2: 'goodMessage' });
  eq([G.results[0].success, G.results[0].messages], [true, { good: 2, evil: 0 }], '"the Good Message card acts as a Success card"');
  quest(G, [1, 5, 6], { 1: 'goodMessage', 5: 'evilMessage' });
  eq([G.results[1].success, G.players[1].messages], [false, 2], '"The Evil Message card acts as a Fail card"');
  play(G, A.waitingOn(G)[0], { kind: 'propose', team: [1, 2, 3] });
  voteAll(G, everyone(G));
  bad(A.applyMove(G, 1, { kind: 'quest', card: 'goodMessage' }), '"Each Good Messenger may only play a Good Message Quest card up to twice"');
  for (const s of [1, 2, 3]) play(G, s, { kind: 'quest', card: 'success' });
  quest(G, [0, 3, 4, 6], { 4: 'fail', 6: 'fail' });
  // three Good Messages and one Evil: Good's backup on the fifth Quest
  quest(G, [0, 2, 3, 6], { 6: 'fail' });
  eq([G.results[4].backup, G.results[4].fails, G.results[4].success], ['good', 0, true], '"If there are 3 or more Good Messages, Good may remove one Fail card from the final Quest"');
  eq(G.phase, 'assassin', 'Good has three Quests');
  bad(A.applyMove(G, 4, { kind: 'assassinate', messengers: [1, 5] }), 'the Messengers named are two players not known to be Evil');
  play(G, 4, { kind: 'assassinate', messengers: [1, 2] });
  eq(G.winner, 'evil', '"they must correctly identify both Good Messengers for Evil to win"');
}

console.log('— the Trapper and Excalibur —');
{
  const G = table(SEVEN, { trapper: true, excalibur: true });
  eq(G.sizes, [3, 4, 4, 5, 5], '"the Leader takes one more Team token than normal"');
  bad(A.applyMove(G, 0, { kind: 'propose', team: [0, 1, 4], excalibur: 0 }), '"The Leader cannot assign Excalibur to themself"');
  bad(A.applyMove(G, 0, { kind: 'propose', team: [0, 1, 4], excalibur: 2 }), 'Excalibur goes to a member of the Team');
  play(G, 0, { kind: 'propose', team: [0, 1, 4], excalibur: 1 });
  voteAll(G, everyone(G));
  for (const s of [0, 1]) play(G, s, { kind: 'quest', card: 'success' });
  play(G, 4, { kind: 'quest', card: 'fail' });
  eq([asked(G), G.ask.seat], ['excalibur', 1], 'Excalibur, once the cards are played');
  bad(A.applyMove(G, 1, { kind: 'excalibur', target: 1 }), '"any one other player"');
  play(G, 1, { kind: 'excalibur', target: 4 });
  eq(A.viewFor(G, 1, 'X').me.looks.map((l) => [l.kind, l.target, l.card]), [['excalibur', 4, 'fail']], '"the player with Excalibur looks at the switched card (the card that was originally played)"');
  eq(A.viewFor(G, 0, 'X').me.looks, [], '…and no one else');
  eq([asked(G), G.ask.seat], ['trap', 0], 'then the Leader, the Trapper');
  play(G, 0, { kind: 'trap', target: 0 });
  eq([G.results[0].success, G.results[0].fails, G.results[0].trapped], [true, 0, 0], 'the switched Fail is now a Success; the card set aside "does not affect the results"');
}

console.log('— Plot cards —');
{
  const roles = ['merlin', 'servant', 'servant', 'servant', 'assassin', 'minion', 'minion'];
  const G = table(roles, { plot: true });
  eq(G.plot.deck.length + G.plot.hand.length, 15, 'seven players use all fifteen');
  const deck = (types) => { G.plot.deck = types.map((type, id) => ({ id, type })); G.plot.hand = []; G.plot.drawnFor = -1; A.redeal(G, roles, 0); };
  deck(['one', 'charge', 'king', 'lead', 'spot', 'ambush', 'honor', 'strength', 'nature']);
  eq([asked(G), G.plot.hand.map((c) => c.type)], ['give', ['one', 'charge']], 'the Leader draws two at seven players');
  bad(A.applyMove(G, 0, { kind: 'give', card: 0, to: 0 }), '"The Leader may not keep the Plot card for themself"');
  play(G, 0, { kind: 'give', card: 0, to: 1 });
  eq([asked(G), G.ask.seat], ['adjacent', 1], 'Are You the One? is resolved as soon as it is passed');
  bad(A.applyMove(G, 1, { kind: 'adjacent', target: 4 }), '"one adjacent player"');
  play(G, 1, { kind: 'adjacent', target: 2 });
  play(G, 2, { kind: 'loyalty', card: 'good' });
  play(G, 0, { kind: 'give', card: 1, to: 6 });
  eq([G.players[6].plots.map((c) => c.type), asked(G)], [['charge'], 'propose'], 'Charge! stays in play');
  play(G, 0, { kind: 'propose', team: [0, 1] });
  bad(A.applyMove(G, 0, { kind: 'vote', approve: true }), '"must select and reveal their vote token before any other players"');
  play(G, 6, { kind: 'vote', approve: false });
  eq(A.viewFor(G, 2, 'X').chargeVotes, { 6: false }, 'the Charge! vote is shown at once');
  voteAll(G, everyone(G));
  eq(asked(G), 'quest', 'no one holds a card for this Quest');
  for (const s of [0, 1]) play(G, s, { kind: 'quest', card: 'success' });
  // the next Leader draws The King Returns and Lead to Victory
  eq(G.plot.hand.map((c) => c.type), ['king', 'lead'], 'a new Quest, two more cards');
  play(G, 1, { kind: 'give', card: 2, to: 5 });
  play(G, 1, { kind: 'give', card: 3, to: 3 });
  play(G, 1, { kind: 'propose', team: [1, 2, 3] });
  voteAll(G, everyone(G));
  eq([asked(G), G.ask.seat], ['king', 5], 'The King Returns may follow an approved Team');
  play(G, 5, { kind: 'king', use: true });
  eq([G.rejects, G.leader, asked(G), G.ask.seat], [1, 2, 'lead', 3], '"Using this card counts as a failed vote for the round"; then Lead to Victory, before the Leader acts');
  play(G, 3, { kind: 'lead', use: true });
  eq([G.leader, asked(G), G.ask.seat], [3, 'propose', 3], '"use this card to become the Leader"');
  ok(G.proposals[G.proposals.length - 1].vetoed === 5, 'the vote record shows the Team was turned back');
}
{
  const roles = ['merlin', 'servant', 'servant', 'servant', 'assassin', 'minion', 'minion'];
  const G = table(roles, { plot: true });
  G.plot.deck = ['spot', 'ambush', 'honor', 'strength', 'nature', 'one'].map((type, id) => ({ id, type }));
  G.plot.hand = []; G.plot.drawnFor = -1;
  A.redeal(G, roles, 0);
  play(G, 0, { kind: 'give', card: 0, to: 3 });
  play(G, 0, { kind: 'give', card: 1, to: 2 });
  play(G, 0, { kind: 'propose', team: [1, 5] });
  voteAll(G, everyone(G));
  eq([asked(G), G.ask.seat], ['spot', 3], 'We Found You!, before the Team picks its cards');
  bad(A.applyMove(G, 3, { kind: 'spot', target: 2 }), '"force a player" on the Team');
  play(G, 3, { kind: 'spot', target: 5 });
  play(G, 5, { kind: 'quest', card: 'fail' });
  eq(A.viewFor(G, 2, 'X').faceUp, { 5: 'fail' }, 'a card played face up is seen by all');
  play(G, 1, { kind: 'quest', card: 'success' });
  eq([asked(G), G.ask.seat], ['ambush', 2], 'Ambush, once the cards are played');
  play(G, 2, { kind: 'ambush', target: 1 });
  eq(A.viewFor(G, 2, 'X').me.looks.map((l) => [l.target, l.card]), [[1, 'success']], '"examine a played Quest card"');
  eq(G.players.every((p) => !p.plots.some((c) => c.type === 'ambush' || c.type === 'spot')), true, 'used cards are gone');
  // the next round: Restore Your Honor and Show Your Strength
  G.players[6].plots.push({ id: 90, type: 'king' });
  play(G, 1, { kind: 'give', card: 2, to: 4 });
  eq([asked(G), G.ask.seat], ['take', 4], 'Restore Your Honor: "must take one Plot card from any other player"');
  play(G, 4, { kind: 'take', from: 6, card: 90 });
  eq([G.players[4].plots.map((c) => c.type), G.players[6].plots], [['king'], []], 'the card changes hands');
  play(G, 1, { kind: 'give', card: 3, to: 2 });
  eq([asked(G), G.ask.seat], ['showto', 1], 'Show Your Strength: "The Leader must pass a Loyalty card to any other player"');
  play(G, 1, { kind: 'showto', target: 6 });
  play(G, 1, { kind: 'loyalty', card: 'good' });
  eq(A.knowledge(G, 6)[1], 'shown-good', 'the player chosen examines the Leader');
}

console.log('— what each player may see —');
{
  const G = table(['merlin', 'percival', 'servant', 'servant', 'assassin', 'morgana', 'mordred'], { lady: true });
  play(G, 0, { kind: 'propose', team: [0, 1] });
  for (const s of [0, 1, 2]) play(G, s, { kind: 'vote', approve: s !== 1 });
  for (const p of G.players) {
    const v = A.viewFor(G, p.seat, 'X');
    eq(v.players.filter((q) => q.role !== undefined).map((q) => q.seat), [p.seat], `seat ${p.seat} sees only its own Character`);
    ok(v.proposals.length === 0 && !('votes' in v), `seat ${p.seat} sees no vote before the last is in`);
    eq(v.myVote, p.seat < 3 ? p.seat !== 1 : undefined, `seat ${p.seat} sees its own vote`);
  }
  for (const s of [3, 4, 5, 6]) play(G, s, { kind: 'vote', approve: true });
  play(G, 0, { kind: 'quest', card: 'success' });
  const v = A.viewFor(G, 3, 'X');
  eq(v.played, [0], 'who has played a Quest card is public');
  ok(!('cards' in v) && v.myCard === null && v.myCards === null, 'what they played is not');
  eq(A.viewFor(G, 1, 'X').myCards, ['success'], 'a member of the Team sees the cards they may play');
  G.phase = 'over';
  eq(A.viewFor(G, 3, 'X').players.every((q) => q.role), true, 'at the end every Character is shown');
}

console.log(`\n${checks} checks` + (fails ? `, ${fails} FAILURES` : ', all pass'));
process.exit(fails ? 1 : 0);
