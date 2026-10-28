// So Clover!, rule by rule, on tables set up by hand: the clover's geometry,
// the deal, what makes a Clue, the move from Clues to Resolution, putting the
// cards back, checking them and scoring — with the rulebook's own
// Verification picture as one of the tables — the Spectator and the final say,
// and what every view shows.
import * as M from './game.js';

let fails = 0, checks = 0;
const eq = (got, want, what) => {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    console.log(`  **FAIL** ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    fails++;
  }
};
const ok = (cond, what) => eq(!!cond, true, what);

const roster = (n) => Array.from({ length: n }, (_, i) => ({ seat: i, name: ['Ana', 'Bo', 'Cy', 'Di', 'Ed', 'Fay'][i] }));
const play = (G, seat, move) => {
  const r = M.applyMove(G, seat, move);
  if (!r.ok) throw new Error(`${JSON.stringify(move)} by ${seat}: ${r.error}`);
  return r;
};
const refused = (G, seat, move) => M.applyMove(G, seat, move).ok === false;

// The rulebook's Verification picture. Each card's words as they lie in the
// picture, clockwise from the top. The bottom-left card (Tail, Menu, Child,
// Shirt) is in the right spot but marked wrong: turned a quarter clockwise it
// puts Child against NIGHT-LIGHT beside Lamp, and Menu against EAT beside
// Banana. The fifth card is Memory, Down, Guide, Love.
const RULEBOOK = {
  cards: [
    { id: 'kHouse', words: ['House', 'Hood', 'Pear', 'Lamp'] },
    { id: 'kFire', words: ['Firefighter', 'Sheep', 'Climbing', 'Pond'] },
    { id: 'kDoe', words: ['Doe', 'Clothing', 'Banana', 'Tattoo'] },
    { id: 'kTail', words: ['Tail', 'Menu', 'Child', 'Shirt'] },
  ],
  spots: [{ id: 'kHouse', rot: 0 }, { id: 'kFire', rot: 0 }, { id: 'kDoe', rot: 0 }, { id: 'kTail', rot: 1 }],
  extra: [{ id: 'kMemory', words: ['Memory', 'Down', 'Guide', 'Love'] }],
  clues: ['Station', 'Wool', 'Eat', 'Night-light'],
};

// a game whose seat-0 clover is the rulebook's, with every Clue written
function rulebookGame(n = 3) {
  const G = M.newGame(roster(n));
  const cl = G.clovers[0];
  cl.cards = RULEBOOK.cards.map((c) => ({ ...c, words: c.words.slice() }));
  cl.spots = RULEBOOK.spots.map((s) => ({ ...s }));
  for (const s of G.players.map((p) => p.seat)) {
    const c = G.clovers[s];
    const kw = M.keywordsOf(c);
    // anything that is a word and none of theirs
    play(G, s, { kind: 'done', clues: s === 0 ? RULEBOOK.clues : ['Alpha', 'Bravo', 'Charlie', 'Delta'].map((w) => `${w}${s}`) });
  }
  // the extra card is drawn as the Resolution begins: make it the picture's
  const old = cl.extra.map((c) => c.id);
  cl.extra = RULEBOOK.extra.map((c) => ({ ...c, words: c.words.slice() }));
  if (G.round.seat === 0) G.round.tray = G.round.tray.map((t) => (old.includes(t.id) ? { id: 'kMemory', rot: t.rot } : t));
  return G;
}

// run the Resolution until seat 0 is the Spectator, scoring the others nothing
function toSpectator(G, seat) {
  for (let guard = 0; guard < 10 && G.round.seat !== seat; guard++) finishClover(G, 'wrong');
  eq(G.round.seat, seat, `the Resolution comes round to seat ${seat}`);
}

// put a clover back all right, or all wrong, and press Next for everyone
function finishClover(G, how) {
  const r = G.round;
  const sol = G.clovers[r.seat].spots;
  const guess = G.players.map((p) => p.seat).filter((s) => s !== r.seat);
  for (let attempt = 0; attempt < 2 && !r.done; attempt++) {
    for (let s = 0; s < 4; s++) {
      if (r.board[s] && r.board[s].fixed) continue;
      const card = how === 'right' ? sol[s].id : (r.tray[0] && r.tray[0].id);
      play(G, guess[0], { kind: 'place', card, spot: s });
      const placed = r.board[s];
      const want = how === 'right' ? sol[s].rot : (sol.find((x) => x.id === placed.id) ? (sol.find((x) => x.id === placed.id).rot + 2) % 4 : placed.rot);
      while (r.board[s].rot !== want) play(G, guess[0], { kind: 'turn', card: placed.id });
    }
    for (const s of guess) play(G, s, { kind: 'agree' });
  }
  for (const p of G.players) if (!G.round || G.round === r) play(G, p.seat, { kind: 'next' });
}

console.log('— the clover —');
{
  const cl = { cards: RULEBOOK.cards, extra: [], spots: RULEBOOK.spots };
  eq(M.pairsOf(cl), [['House', 'Firefighter'], ['Sheep', 'Clothing'], ['Menu', 'Banana'], ['Lamp', 'Child']],
    'the rulebook\'s clover: STATION over House and Firefighter, WOOL beside Sheep and Clothing, EAT under Menu and Banana, NIGHT-LIGHT beside Lamp and Child');
  eq(M.keywordsOf(cl).length, 8, 'eight Keywords on the outside edges');
  const card = { words: ['N', 'E', 'S', 'W'] };
  eq([0, 1, 2, 3].map((e) => M.wordAt(card, 1, e)), ['W', 'N', 'E', 'S'], 'a quarter turn clockwise moves every word on to the next edge round');
  eq([0, 1, 2, 3].map((e) => M.wordAt(card, 3, e)), ['E', 'S', 'W', 'N'], '…and three of them is a quarter turn back');
  eq(M.LEAF_SPOTS, [[0, 1], [1, 2], [3, 2], [0, 3]], 'each leaf touches its own edge of the two cards beside it');
}

console.log('— the deal —');
for (const n of [3, 4, 5, 6]) {
  const G = M.newGame(roster(n));
  const all = Object.values(G.clovers).flatMap((cl) => cl.cards.flatMap((c) => c.words));
  eq([Object.keys(G.clovers).length, all.length, new Set(all).size], [n, 16 * n, 16 * n], `${n} players: four cards each, four words to a card, no word twice`);
  ok(Object.values(G.clovers).every((cl) => cl.spots.map((s) => s.id).sort().join() === cl.cards.map((c) => c.id).sort().join() && cl.spots.every((s) => s.rot >= 0 && s.rot < 4)), `${n} players: every card in a spot of its own, some way round`);
  ok(G.phase === 'clues' && G.round === null, `${n} players: the game opens on Choosing Clues`);
}
{
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const G = M.newGame(roster(3));
    for (const cl of Object.values(G.clovers)) cl.spots.forEach((s, spot) => seen.add(`${cl.cards.findIndex((c) => c.id === s.id)}@${spot}/${s.rot}`));
  }
  eq(seen.size, 64, 'over many deals every card turns up in every spot, every way round: "randomly places them"');
  eq(M.canStart(2) !== null && M.canStart(7) !== null && M.canStart(3) === null && M.canStart(6) === null, true, 'three to six players');
  eq([M.checkOpts({ extra: 3 }).extra, M.checkOpts({ extra: 9 }).extra, M.checkOpts({}).extra], [3, 1, 1], 'one card added, or up to four to add a challenge');
}

console.log('— what makes a Clue —');
{
  const kw = ['House', 'Firefighter', 'Princess', 'Brother', 'Love', 'France', 'Café', 'Glass'];
  for (const c of ['Rabbit', 'Clooney', 'FBI', '13', 'Bzzzz', 'Night-light', 'Station', "O'Neill"]) eq(M.clueProblem(c, kw), null, `"${c}" is a Clue (the rulebook's examples, and a compound word)`);
  ok(M.clueProblem('night light', kw), 'two words are not a Clue');
  ok(M.clueProblem('', kw), 'nor is nothing');
  ok(M.clueProblem('House', kw) && M.clueProblem('house', kw) && M.clueProblem('Houses', kw) && M.clueProblem('CAFE', kw) && M.clueProblem('Glasses', kw), 'a Keyword is not a Clue, in any case, with or without its accent, nor its plural');
  eq(M.clueProblem('Amour', kw), null, 'a translation is the players\' to catch: "Amour" for Love and France gets through');
  ok(M.clueWarning('Prince', kw), '"Prince" for Princess and Brother is flagged as a likely relative');
  eq(M.clueWarning('Wool', ['Sheep', 'Clothing']), null, '"Wool" for Sheep and Clothing is not');
  ok(M.clueProblem('x'.repeat(M.CLUE_MAX + 1), kw), `one word, ${M.CLUE_MAX} letters at most`);
}

console.log('— Choosing Clues —');
{
  const G = M.newGame(roster(3));
  const kw0 = M.keywordsOf(G.clovers[0]);
  play(G, 0, { kind: 'clue', leaf: 2, text: '  half  written ' });
  eq(G.clovers[0].clues[2], 'half written', 'a Clue being written is kept as it stands');
  ok(refused(G, 0, { kind: 'done' }), 'Done needs four Clues');
  const r = M.applyMove(G, 0, { kind: 'done', clues: ['Alpha', 'Bravo', kw0[4], 'Delta'] });
  ok(!r.ok && /bottom leaf/.test(r.error), `a Keyword as a Clue is refused, and the leaf named: "${r.error}"`);
  play(G, 0, { kind: 'done', clues: ['Alpha', 'Bravo', 'Charlie', 'Delta'] });
  eq([G.clovers[0].done, G.phase], [true, 'clues'], 'done — and the table waits for the others');
  ok(refused(G, 0, { kind: 'clue', leaf: 0, text: 'Zulu' }), 'a Clue cannot change once done…');
  play(G, 0, { kind: 'done', on: false });
  play(G, 0, { kind: 'clue', leaf: 0, text: 'Zulu' });
  eq(G.clovers[0].clues[0], 'Zulu', '…until Edit');
  play(G, 0, { kind: 'done' });
  ok(refused(G, 1, { kind: 'place', card: G.clovers[0].cards[0].id, spot: 0 }), 'no cards are put back before everyone has written');
  play(G, 1, { kind: 'done', clues: ['Uno', 'Dos', 'Tres', 'Cuatro'].map((w) => (M.keywordsOf(G.clovers[1]).includes(w) ? `${w}z` : w)) });
  play(G, 2, { kind: 'done', clues: ['Eins', 'Zwei', 'Drei', 'Vier'].map((w) => (M.keywordsOf(G.clovers[2]).includes(w) ? `${w}z` : w)) });
  eq(G.phase, 'resolve', 'the last one done begins the Resolution');
  eq(Object.values(G.clovers).map((cl) => cl.extra.length), [1, 1, 1], 'each clover gets one more card, drawn unseen');
  const all = Object.values(G.clovers).flatMap((cl) => [...cl.cards, ...cl.extra].flatMap((c) => c.words));
  eq(new Set(all).size, all.length, 'still no word twice');
  const o = G.order;
  ok(o.length === 3 && [0, 1, 2].some((k) => [k, (k + 1) % 3, (k + 2) % 3].join() === o.join()), `the Spectators go round to the left from the first: ${o.join(' → ')}`);
  eq([G.round.seat, G.round.tray.length, G.round.board], [o[0], 5, [null, null, null, null]], 'the first Spectator\'s five cards lie in the middle, the clover empty');
}
{
  const G = M.newGame(roster(4), { extra: 3 });
  for (const s of [0, 1, 2, 3]) play(G, s, { kind: 'done', clues: ['Uno', 'Dos', 'Tres', 'Cuatro'].map((w) => (M.keywordsOf(G.clovers[s]).includes(w) ? `${w}z` : w)) });
  eq(G.round.tray.length, 7, 'add a challenge: with three cards added, seven lie in the middle');
}

console.log('— putting the cards back —');
{
  const G = rulebookGame(3);
  toSpectator(G, 0);
  const r = G.round;
  const [b, c] = [1, 2];
  eq(M.silenced(G), 0, 'the Spectator cannot communicate');
  eq(M.deciderOf(G), 1, 'the player to the Spectator\'s left has the final say');
  ok(refused(G, 0, { kind: 'place', card: 'kHouse', spot: 0 }), 'the Spectator keeps their hands off');
  play(G, b, { kind: 'place', card: 'kHouse', spot: 0 });
  play(G, c, { kind: 'place', card: 'kMemory', spot: 1 });
  play(G, b, { kind: 'place', card: 'kFire', spot: 1 });
  eq([r.board[1].id, r.tray.some((t) => t.id === 'kMemory')], ['kFire', true], 'a card put where another lies sends that one back to the middle');
  play(G, c, { kind: 'place', card: 'kHouse', spot: 1 });
  eq([r.board[0].id, r.board[1].id], ['kFire', 'kHouse'], 'two cards on the clover trade places');
  play(G, c, { kind: 'place', card: 'kHouse', spot: 0 });
  eq([r.board[0].id, r.board[1].id], ['kHouse', 'kFire'], '…and back');
  ok(refused(G, b, { kind: 'agree' }), 'agreeing needs all four spots filled');
  play(G, b, { kind: 'place', card: 'kDoe', spot: 2 });
  play(G, b, { kind: 'place', card: 'kTail', spot: 3 });
  for (const s of [0, 1, 2, 3]) while (r.board[s].rot !== [0, 0, 0, 0][s]) play(G, b, { kind: 'turn', card: r.board[s].id });
  eq(M.pairAt(r.board.map((x) => x && { card: G.clovers[0].cards.find((k) => k.id === x.id), rot: x.rot }), 3), ['Lamp', 'Shirt'], 'as in the picture: Shirt against NIGHT-LIGHT');
  play(G, b, { kind: 'agree' });
  eq([r.agree, r.attempt], [[1], 1], 'one guesser agrees — the other has not');
  play(G, c, { kind: 'turn', card: 'kMemory' });
  eq(r.agree, [1], 'turning a card in the middle changes nothing on the clover');
  play(G, c, { kind: 'turn', card: 'kDoe', dir: -1 });
  eq(r.agree, [], 'turning one on the clover takes every Agree back');
  play(G, c, { kind: 'turn', card: 'kDoe' });
  ok(refused(G, c, { kind: 'lock' }), 'only the player to the Spectator\'s left can lock it in');

  console.log('— the rulebook\'s Verification —');
  play(G, b, { kind: 'lock' });
  eq([r.attempt, r.first, r.board.map((x) => x && x.id), r.board.map((x) => !!(x && x.fixed))], [2, [true, true, true, false], ['kHouse', 'kFire', 'kDoe', null], [true, true, true, false]],
    'first attempt: the card in the right spot but turned wrong is wrong — it comes off, the three right ones stay');
  ok(r.tray.some((t) => t.id === 'kTail') && r.tray.some((t) => t.id === 'kMemory'), 'it goes back to the middle, beside the extra card');
  ok(refused(G, b, { kind: 'place', card: 'kHouse', spot: 3 }) && refused(G, b, { kind: 'turn', card: 'kHouse' }) && refused(G, b, { kind: 'lift', card: 'kHouse' }), 'a card found right stays as it is');
  ok(refused(G, b, { kind: 'place', card: 'kTail', spot: 0 }), 'and keeps its spot');
  play(G, c, { kind: 'place', card: 'kTail', spot: 3 });
  play(G, c, { kind: 'turn', card: 'kTail' });
  play(G, b, { kind: 'agree' });
  play(G, c, { kind: 'agree' });
  eq([r.done, r.points, r.perfect, r.right], [true, 4, false, [true, true, true, true]], 'second and final attempt: all four right — 1 point a card, 4');
  eq(G.score, 4, 'the team has 4');
}
{
  const G = rulebookGame(4);
  toSpectator(G, 0);
  finishClover(G, 'right');
  const res = G.results.find((x) => x.seat === 0);
  eq([res.points, res.perfect, res.attempts], [6, true, 1], 'all four right at the first attempt: 6');
}
{
  const G = rulebookGame(3);
  toSpectator(G, 0);
  const r = G.round;
  // two right, two wrong, then nothing more found
  play(G, 1, { kind: 'place', card: 'kHouse', spot: 0 });
  play(G, 1, { kind: 'place', card: 'kFire', spot: 1 });
  play(G, 1, { kind: 'place', card: 'kMemory', spot: 2 });
  play(G, 1, { kind: 'place', card: 'kTail', spot: 3 });
  for (const s of [0, 1]) while (r.board[s].rot !== 0) play(G, 1, { kind: 'turn', card: r.board[s].id });
  while (r.board[3].rot !== 0) play(G, 1, { kind: 'turn', card: 'kTail' });
  play(G, 1, { kind: 'lock' });
  eq([r.attempt, r.first], [2, [true, true, false, false]], 'two right at the first attempt');
  play(G, 2, { kind: 'place', card: 'kDoe', spot: 3 });
  play(G, 2, { kind: 'place', card: 'kTail', spot: 2 });
  play(G, 1, { kind: 'lock' });
  eq([r.done, r.points, r.right], [true, 2, [true, true, false, false]], 'the second attempt finds no more: 2 points, for the two that stayed');
  eq(r.board.map((x) => x && x.id), ['kHouse', 'kFire', null, null], 'and the wrong ones come off');
}

console.log('— round the table —');
{
  const G = rulebookGame(3);
  const order = G.order.slice();
  const s0 = G.round.seat;
  finishClover(G, 'right');
  ok(G.round && G.round.seat === order[1] && G.round.seat !== s0, 'once everyone has pressed Next, the player to the left is the next Spectator');
  finishClover(G, 'wrong');
  finishClover(G, 'right');
  eq([G.phase, G.results.map((x) => x.seat), G.score], ['over', order, 12], 'after every player has been the Spectator, the game ends: 6 + 0 + 6');
  ok(G.results.every((x) => [0, 1, 2, 3, 4, 6].includes(x.points)), 'a clover scores 0 to 4, or 6 — never 5');
  ok(refused(G, 0, { kind: 'next' }), 'nothing more to do');
}

console.log('— the table, one player short —');
{
  const G = rulebookGame(4);
  toSpectator(G, 0);
  const r = G.round;
  M.markDisconnected(G, 1);
  eq(M.deciderOf(G), 2, 'the player to the left is gone: the final say passes to the next one round');
  for (const [id, s] of [['kHouse', 0], ['kFire', 1], ['kDoe', 2], ['kTail', 3]]) play(G, 2, { kind: 'place', card: id, spot: s });
  while (r.board[3].rot !== 0) play(G, 2, { kind: 'turn', card: 'kTail' });
  play(G, 2, { kind: 'agree' });
  eq(r.attempt, 1, 'one of the two left has agreed');
  M.markDisconnected(G, 3);
  eq(r.attempt, 2, 'the other leaves: everyone still there has agreed, so it is checked');
}
{
  const G = M.newGame(roster(3));
  play(G, 0, { kind: 'done', clues: ['Uno', 'Dos', 'Tres', 'Cuatro'].map((w) => (M.keywordsOf(G.clovers[0]).includes(w) ? `${w}z` : w)) });
  play(G, 1, { kind: 'done', clues: ['Eins', 'Zwei', 'Drei', 'Vier'].map((w) => (M.keywordsOf(G.clovers[1]).includes(w) ? `${w}z` : w)) });
  eq(M.setAside(G, 2), false, 'a player still at the table keeps their clover');
  M.markDisconnected(G, 2);
  eq(M.waitingOn(G), [2], 'the table waits on the one who has gone');
  eq([M.setAside(G, 2), G.phase, G.order.includes(2)], [true, 'resolve', false], 'the host sets their clover aside, and the Resolution begins without it');
  eq(G.clovers[2].extra.length, 0, 'a clover set aside gets no extra card');
}

console.log('— what each seat sees —');
{
  const G = M.newGame(roster(3));
  const v1 = M.viewFor(G, 1, 'T');
  const text = JSON.stringify(v1);
  const mine = G.clovers[1].cards.flatMap((c) => c.words);
  const theirs = [0, 2].flatMap((s) => G.clovers[s].cards.flatMap((c) => c.words));
  ok(mine.every((w) => text.includes(`"${w}"`)), 'writing Clues, a player sees their own cards');
  ok(theirs.every((w) => !text.includes(`"${w}"`)), '…and nobody else\'s');
  const ob = JSON.stringify(M.viewFor(G, 1, 'T', { observer: true }));
  ok([...mine, ...theirs].every((w) => !ob.includes(`"${w}"`)), 'a watcher sees no one\'s cards');
}
{
  const G = rulebookGame(3);
  toSpectator(G, 0);
  const v = M.viewFor(G, 1, 'T');
  eq([v.round.solution, v.round.clues], [null, RULEBOOK.clues], 'a guesser sees the Clues and the cards on the table — not where they go');
  ok(M.viewFor(G, 0, 'T').round.solution, 'the Spectator knows their own clover');
  eq(M.viewFor(G, 0, 'T', { observer: true }).round.solution, null, 'a watcher of the Spectator does not');
  const later = G.order.filter((s) => s !== 0 && !G.results.some((x) => x.seat === s));
  const vtext = JSON.stringify(v);
  ok(later.every((s) => G.clovers[s].clues.every((c) => !vtext.includes(`"${c}"`))), 'nobody sees the Clues of a clover still to come');
  finishClover(G, 'wrong');
  const after = G.results.find((x) => x.seat === 0);
  eq(after.pairs, [['House', 'Firefighter'], ['Sheep', 'Clothing'], ['Menu', 'Banana'], ['Lamp', 'Child']], 'once scored, a clover\'s true Pairs are the table\'s');
}

console.log(`\n${checks} checks` + (fails ? `, ${fails} FAILURES` : ', all pass'));
process.exit(fails ? 1 : 0);
