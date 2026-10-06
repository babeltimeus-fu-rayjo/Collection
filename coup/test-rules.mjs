// The rules, checked one at a time against the rulebooks' wording: the deck
// and the set-up, every action, challenges and blocks in their order, losing
// influence and exile; Reformation's Allegiances, Conversion and
// Embezzlement; the Inquisitor; the two-player rules — and that no player's
// view shows what it must not.
import * as A from './game.js';

let fails = 0, checks = 0;
const eq = (got, want, what) => {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(want)) { console.log(`  **FAIL** ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); fails++; }
};
const ok = (cond, what) => eq(!!cond, true, what);
const bad = (res, what) => eq(res.ok, false, what);

// a table with these hands, dealt in seat order, this player first
function table(hands, { first = 0, sides = null, ...opts } = {}) {
  const G = A.newGame(hands.map((_, i) => ({ seat: i, name: 'P' + i, bot: true })), { ...A.defaultOpts(), ...opts });
  return A.redeal(G, hands, first, sides);
}
const play = (G, seat, move) => { const r = A.applyMove(G, seat, move); if (!r.ok) throw new Error(`${JSON.stringify(move)} by ${seat}: ${r.error}`); return r; };
const asked = (G) => (G.window ? G.window.kind : G.ask ? G.ask.kind : G.phase);
const allow = (G) => { for (const s of A.waitingOn(G)) play(G, s, { kind: 'allow' }); };
const hand = (G, s) => G.players[s].cards.filter((c) => !c.up).map((c) => c.char).sort();
const up = (G, s) => G.players[s].cards.filter((c) => c.up).map((c) => c.char).sort();
const coinsOf = (G) => G.players.map((p) => p.coins);
const cardId = (G, s, char) => G.players[s].cards.find((c) => !c.up && c.char === char).id;
const total = (G) => G.deck.length + G.players.reduce((t, p) => t + p.cards.length, 0);

console.log('— the deck and the set-up —');
eq(A.charsFor(A.defaultOpts()), ['duke', 'assassin', 'captain', 'ambassador', 'contessa'], '"3 each of Duke, Assassin, Captain, Ambassador, Contessa"');
eq([2, 6, 7, 8, 9, 10].map(A.copiesFor), [3, 3, 4, 4, 5, 5], '"4 each ... (20 cards total)" at 7–8, "5 each ... (25 cards total)" at 9–10');
for (const n of [2, 3, 6, 7, 10]) {
  const G = A.newGame(Array.from({ length: n }, (_, i) => ({ seat: i, name: 'P' + i })));
  eq([total(G), G.players.every((p) => p.cards.length === 2 && p.cards.every((c) => !c.up))], [5 * A.copiesFor(n), true], `${n} players: ${5 * A.copiesFor(n)} cards, two face down each`);
  eq(G.players.map((p) => p.coins).sort(), n === 2 ? [1, 2] : Array(n).fill(2), n === 2 ? '"When playing Coup with two players, the starting player receives only 1 coin"' : `${n} players: "Give each player 2 coins"`);
}
{
  const G = A.newGame([0, 1, 2].map((i) => ({ seat: i, name: 'P' + i })), { ...A.defaultOpts(), inquisitor: true });
  const all = [...G.deck, ...G.players.flatMap((p) => p.cards)].map((c) => c.char);
  eq([all.filter((c) => c === 'inquisitor').length, all.includes('ambassador')], [3, false], '"Remove all the Ambassador character cards ... and replace with Inquisitor cards"');
  const W = A.newGame([0, 1, 2].map((i) => ({ seat: i, name: 'P' + i })), A.defaultOpts(), { first: 2 });
  eq([W.turn, W.ask.kind, W.ask.seat], [2, 'act', 2], '"The person who won the last game starts"');
}
ok(A.canStart(1, A.defaultOpts()), 'one player is too few');
ok(A.canStart(11, A.defaultOpts()), 'eleven too many');
eq(A.canStart(10, A.defaultOpts()), null, 'ten may play');

console.log('— general actions —');
{
  const G = table([['duke', 'captain'], ['assassin', 'contessa'], ['captain', 'ambassador']]);
  play(G, 0, { kind: 'act', action: 'income' });
  eq([G.players[0].coins, asked(G), G.ask.seat], [3, 'act', 1], 'Income: "Take 1 coin from the Treasury", and no one can stop it');
  bad(A.applyMove(G, 1, { kind: 'act', action: 'coup', target: 0 }), '"Pay 7 coins": a Coup needs them');
  play(G, 1, { kind: 'act', action: 'foreignAid' });
  eq([asked(G), A.waitingOn(G)], ['block', [0, 2]], 'Foreign Aid: anyone may claim the Duke to block it');
  allow(G);
  eq([G.players[1].coins, G.ask.seat], [4, 2], '"Take 2 coins from the Treasury"');
  play(G, 2, { kind: 'act', action: 'foreignAid' });
  play(G, 0, { kind: 'block', claim: 'duke' });
  eq([asked(G), A.waitingOn(G)], ['challenge', [1, 2]], 'a block is a claim: anyone else may challenge it, the actor too');
  allow(G);
  eq([G.players[2].coins, G.ask.seat], [2, 0], '"The player trying to gain foreign aid receives no coins that turn"');
}
{
  const G = table([['duke', 'captain'], ['assassin', 'contessa'], ['captain', 'ambassador']]);
  G.players[0].coins = 7;
  play(G, 0, { kind: 'act', action: 'coup', target: 1 });
  eq([G.players[0].coins, asked(G), G.ask.seat], [0, 'lose', 1], 'a Coup: pay 7, and "That player immediately loses an influence" — no challenge, no block');
  bad(A.applyMove(G, 1, { kind: 'lose', card: cardId(G, 2, 'captain') }), 'one loses one of one’s own cards');
  play(G, 1, { kind: 'lose', card: cardId(G, 1, 'assassin') });
  eq([up(G, 1), hand(G, 1), G.ask.seat], [['assassin'], ['contessa'], 1], '"Each player always chooses which of their own cards they wish to reveal"');
  G.players[1].coins = 10;
  bad(A.applyMove(G, 1, { kind: 'act', action: 'income' }), '"If you start your turn with 10 (or more) coins you are required to launch a Coup"');
  play(G, 1, { kind: 'act', action: 'coup', target: 0 });
  play(G, 0, { kind: 'lose', card: cardId(G, 0, 'captain') });
  G.players[2].coins = 7;
  play(G, 2, { kind: 'act', action: 'coup', target: 1 });
  eq([G.players[1].out, up(G, 1), G.players[1].coins, G.ask.seat], [true, ['assassin', 'contessa'], 0, 0], 'the last influence lost: exiled, cards face up, coins back to the Treasury; the turn skips them');
  G.players[0].coins = 7;
  play(G, 0, { kind: 'act', action: 'coup', target: 2 });
  play(G, 2, { kind: 'lose', card: cardId(G, 2, 'captain') });
  G.players[2].coins = 7;
  play(G, 2, { kind: 'act', action: 'coup', target: 0 });
  eq([G.phase, G.winner], ['over', 2], '"The game ends when there is only one player left"');
}

console.log('— challenges —');
{
  // a true claim, challenged by a player it does not touch
  const G = table([['duke', 'captain'], ['assassin', 'contessa'], ['captain', 'ambassador']]);
  play(G, 0, { kind: 'act', action: 'tax' });
  eq([asked(G), A.waitingOn(G)], ['challenge', [1, 2]], '"Any other player can issue a challenge to a player regardless of whether they are the involved in the action"');
  play(G, 2, { kind: 'challenge' });
  eq([asked(G), G.ask.seat], ['prove', 0], 'the challenged player may prove it');
  play(G, 0, { kind: 'prove', show: true });
  eq([G.players[0].cards.length, total(G)], [2, 15], '…so they still have two cards');
  // the shown card goes back into the deck — and a new one comes out at random
  let away = 0;
  for (let i = 0; i < 30; i++) {
    const T = table([['duke', 'captain'], ['assassin', 'contessa'], ['captain', 'ambassador']]);
    const id = cardId(T, 0, 'duke');
    play(T, 0, { kind: 'act', action: 'tax' });
    play(T, 1, { kind: 'challenge' });
    play(T, 0, { kind: 'prove', show: true });
    if (T.deck.some((c) => c.id === id)) away++;
  }
  ok(away > 15, '"they first return that card to the Court deck, re-shuffle the Court deck and take a random replacement card"');
  eq([asked(G), G.ask.seat], ['lose', 2], '"Whoever loses the challenge immediately loses an influence"');
  play(G, 2, { kind: 'lose', card: cardId(G, 2, 'ambassador') });
  eq([G.players[0].coins, G.ask.seat], [5, 1], '"Then the action ... is resolved": Tax is taken');
  eq(G.claims.map((c) => [c.seat, c.char, c.result]), [[0, 'duke', 'shown']], 'the record keeps the claim, shown');
}
{
  // a bluff, caught; and a true claim conceded
  const G = table([['captain', 'contessa'], ['assassin', 'duke'], ['captain', 'ambassador']]);
  play(G, 0, { kind: 'act', action: 'tax' });
  play(G, 1, { kind: 'challenge' });
  eq([asked(G), G.ask.seat], ['lose', 0], 'no Duke to show: the bluff loses the challenge');
  play(G, 0, { kind: 'lose', card: cardId(G, 0, 'captain') });
  eq([G.players[0].coins, G.ask.seat], [2, 1], '"If an action is successfully challenged the entire action fails"');
  play(G, 1, { kind: 'act', action: 'tax' });
  play(G, 2, { kind: 'challenge' });
  play(G, 1, { kind: 'prove', show: false });
  eq([asked(G), G.ask.seat, G.players[1].coins], ['lose', 1, 2], '"If they can\'t, or do not wish to, prove it, they lose the challenge"');
}
{
  // the assassination's refund, and its block
  const G = table([['assassin', 'duke'], ['contessa', 'captain'], ['captain', 'ambassador']]);
  G.players[0].coins = 3;
  play(G, 0, { kind: 'act', action: 'assassinate', target: 1 });
  eq(G.players[0].coins, 0, '"Pay 3 coins to the Treasury and launch an assassination"');
  bad(A.applyMove(G, 2, { kind: 'block', claim: 'contessa' }), '"The player who is being assassinated may claim the Contessa" — they alone');
  play(G, 2, { kind: 'allow' });
  play(G, 1, { kind: 'block', claim: 'contessa' });
  eq([asked(G), A.waitingOn(G), G.act.block], ['challenge', [0, 2], { by: 1, claim: 'contessa' }], 'the target blocks, and the block may be challenged');
  allow(G);
  eq([hand(G, 1), G.players[0].coins, G.ask.seat], [['captain', 'contessa'], 0, 1], '"The assassination fails but the fee paid by the player for the assassin remains spent"');
  const R = table([['captain', 'duke'], ['contessa', 'captain'], ['captain', 'ambassador']]);
  R.players[0].coins = 3;
  play(R, 0, { kind: 'act', action: 'assassinate', target: 1 });
  play(R, 2, { kind: 'challenge' });
  play(R, 0, { kind: 'lose', card: cardId(R, 0, 'captain') });
  eq([R.players[0].coins, hand(R, 1)], [3, ['captain', 'contessa']], '"any coins paid as the cost of the action are returned to the player"');
}
{
  // "Double Dangers of Assassination"
  const G = table([['assassin', 'duke'], ['captain', 'ambassador'], ['captain', 'contessa']]);
  G.players[0].coins = 3;
  play(G, 0, { kind: 'act', action: 'assassinate', target: 1 });
  play(G, 1, { kind: 'challenge' });
  play(G, 0, { kind: 'prove', show: true });
  play(G, 1, { kind: 'lose', card: cardId(G, 1, 'captain') });
  eq([asked(G), A.waitingOn(G)], ['block', [1]], 'a challenge lost, the target may still block: "(if the challenge fails) counter-acted"');
  play(G, 1, { kind: 'allow' });
  eq([G.players[1].out, up(G, 1)], [true, ['ambassador', 'captain']], '"if you challenge an assassin used against you and lose the challenge, you will lose 1 influence for the lost challenge and then 1 influence for the successful assassination"');
  const H = table([['assassin', 'duke'], ['captain', 'ambassador'], ['captain', 'contessa']]);
  H.players[0].coins = 3;
  play(H, 0, { kind: 'act', action: 'assassinate', target: 1 });
  play(H, 2, { kind: 'allow' });
  play(H, 1, { kind: 'block', claim: 'contessa' });
  play(H, 0, { kind: 'challenge' });
  play(H, 1, { kind: 'lose', card: cardId(H, 1, 'captain') });
  eq(H.players[1].out, true, '"if you bluff about having the Contessa to block an assassination attempt and are challenged, you will lose 1 influence for the lost challenge and then lose 1 influence for the successful assassination"');
}
{
  // the target answers early, and the block waits for the challenge question to close
  const G = table([['assassin', 'duke'], ['contessa', 'ambassador'], ['captain', 'captain']]);
  G.players[0].coins = 3;
  play(G, 0, { kind: 'act', action: 'assassinate', target: 1 });
  play(G, 1, { kind: 'block', claim: 'contessa' });
  bad(A.applyMove(G, 2, { kind: 'block', claim: 'contessa' }), 'only the target may block an assassination');
  eq([G.act.block, A.viewFor(G, 2, 'X').act.pre, A.viewFor(G, 1, 'X').act.pre], [null, null, 'contessa'], '"You must announce your counter-action after any challenge to the action has been resolved" — a block said early stays the target’s own until then');
  play(G, 2, { kind: 'allow' });
  eq([asked(G), G.act.block], ['challenge', { by: 1, claim: 'contessa' }], 'no challenge: the block is declared, and may be challenged');
}

console.log('— Steal and Exchange —');
{
  const G = table([['captain', 'duke'], ['assassin', 'contessa'], ['ambassador', 'captain']]);
  G.players[1].coins = 1;
  play(G, 0, { kind: 'act', action: 'steal', target: 1 });
  allow(G);
  eq(coinsOf(G).slice(0, 2), [3, 0], 'no challenge, no block: "If they only have one coin, take only one"');
  play(G, 1, { kind: 'act', action: 'income' });
  play(G, 2, { kind: 'act', action: 'income' });
  G.players[1].coins = 0;
  bad(A.applyMove(G, 0, { kind: 'act', action: 'steal', target: 1 }), '"Choose another player who has some coins" (Dized)');
  play(G, 0, { kind: 'act', action: 'steal', target: 2 });
  play(G, 1, { kind: 'allow' });
  bad(A.applyMove(G, 2, { kind: 'block', claim: 'contessa' }), 'the Contessa does not block stealing');
  play(G, 2, { kind: 'block', claim: 'ambassador' });
  allow(G);
  eq(coinsOf(G), [3, 0, 3], '"claim either the Ambassador or the Captain and counteract to block the steal"');
}
{
  const G = table([['ambassador', 'duke'], ['assassin', 'contessa'], ['captain', 'captain']]);
  play(G, 0, { kind: 'act', action: 'exchange' });
  allow(G);
  eq([asked(G), G.ask.drawn.length, G.deck.length], ['exchange', 2, 7], '"First take 2 random cards from the Court deck"');
  eq(A.viewFor(G, 1, 'X').ask.drawn, undefined, '…seen by no one else');
  const drawn = G.ask.drawn.map((c) => c.id);
  bad(A.applyMove(G, 0, { kind: 'exchange', keep: [drawn[0]] }), 'keep as many as one has face down');
  play(G, 0, { kind: 'exchange', keep: drawn });
  eq([G.players[0].cards.map((c) => c.id).sort(), G.deck.length, total(G)], [drawn.slice().sort(), 9, 15], '"Then return two cards to the Court deck"');
  ok(G.log.slice(-1)[0].text.includes('returns 2 cards'), 'and the table hears only that two went back');
}

console.log('— Reformation —');
{
  const G = A.newGame([0, 1, 2, 3].map((i) => ({ seat: i, name: 'P' + i, bot: true })), { ...A.defaultOpts(), reformation: true }, { first: 1 });
  eq([G.ask.kind, G.ask.seat], ['side', 1], '"The start player chooses an Allegiance"');
  play(G, 1, { kind: 'side', side: 'reformist' });
  eq(G.players.map((p) => p.side), ['loyalist', 'reformist', 'loyalist', 'reformist'], '"Going clockwise around the table, each player alternates Allegiance from the previous player"');
}
{
  const sides = ['loyalist', 'reformist', 'loyalist', 'reformist'];
  const G = table([['assassin', 'captain'], ['duke', 'contessa'], ['duke', 'captain'], ['ambassador', 'contessa']], { reformation: true, sides });
  G.players[0].coins = 7;
  bad(A.applyMove(G, 0, { kind: 'act', action: 'coup', target: 2 }), '"A player cannot Coup ... another player of the same Allegiance"');
  bad(A.applyMove(G, 0, { kind: 'act', action: 'assassinate', target: 2 }), '…nor Assassinate');
  bad(A.applyMove(G, 0, { kind: 'act', action: 'steal', target: 2 }), '…nor Steal from');
  play(G, 0, { kind: 'act', action: 'foreignAid' });
  eq(A.waitingOn(G), [1, 3], '…"nor block a Foreign Aid attempt by another player of the same Allegiance"');
  allow(G);
  eq([G.players[0].coins, G.ask.seat], [9, 1], 'Foreign Aid taken');
  play(G, 1, { kind: 'act', action: 'convert' });
  eq([G.players[1].side, G.players[1].coins, G.reserve], ['loyalist', 1, 1], '"Pay 1 coin to change your Allegiance ... placed on the Treasury Reserve card"');
  play(G, 2, { kind: 'act', action: 'convert', target: 3 });
  eq([G.players[3].side, G.players[2].coins, G.reserve], ['loyalist', 0, 3], '"or pay 2 coins to change the Allegiance of one other player"');
  eq(A.mayTarget(G, G.players[0], G.players[2]), true, '"unless all players are of the same Allegiance"');
  play(G, 3, { kind: 'act', action: 'embezzle' });
  eq([asked(G), A.waitingOn(G)], ['challenge', [0, 1, 2]], 'Embezzlement: "Anyone can challenge that the player attempting to Embezzle has the Duke"');
  allow(G);
  eq([G.players[3].coins, G.reserve], [5, 0], '"you may take all the coins on the Treasury Reserve card"');
}
{
  // the challenge turned round
  const G = table([['captain', 'contessa'], ['duke', 'assassin'], ['captain', 'ambassador']], { reformation: true, sides: ['loyalist', 'reformist', 'loyalist'] });
  G.reserve = 4;
  play(G, 0, { kind: 'act', action: 'embezzle' });
  play(G, 1, { kind: 'challenge' });
  eq([asked(G), G.ask.seat], ['prove', 0], 'without the Duke, the Embezzler may show it');
  play(G, 0, { kind: 'prove', show: true });
  eq([G.players[0].cards.length, G.players[0].cards.every((c) => !c.up), total(G)], [2, true, 15], '"the revealed influence cards are shuffled back into the court deck and replaced randomly (this does not cause a loss or gain in the number of influence cards)"');
  eq([asked(G), G.ask.seat], ['lose', 1], '"the challenger loses"');
  play(G, 1, { kind: 'lose', card: cardId(G, 1, 'assassin') });
  eq([G.players[0].coins, G.reserve], [6, 0], 'and the Embezzlement goes ahead');
  // with the Duke, there is no way out
  const D = table([['duke', 'contessa'], ['captain', 'assassin'], ['captain', 'ambassador']], { reformation: true, sides: ['loyalist', 'reformist', 'loyalist'] });
  D.reserve = 4;
  play(D, 0, { kind: 'act', action: 'embezzle' });
  play(D, 2, { kind: 'challenge' });
  eq([asked(D), D.ask.seat], ['lose', 0], '"If the challenged player does have the Duke, they must concede and lose the challenge"');
  play(D, 0, { kind: 'lose', card: cardId(D, 0, 'contessa') });
  eq([D.players[0].coins, D.reserve, D.ask.seat], [2, 4, 1], '"return the coins taken to the Treasury Reserve card and lose one influence card"');
}

console.log('— the Inquisitor —');
{
  const sides = ['loyalist', 'reformist', 'loyalist'];
  const G = table([['inquisitor', 'duke'], ['captain', 'assassin'], ['contessa', 'captain']], { inquisitor: true, reformation: true, sides });
  bad(A.applyMove(G, 0, { kind: 'act', action: 'examine', target: 2 }), '"A player cannot Examine another player of the same Allegiance"');
  play(G, 0, { kind: 'act', action: 'examine', target: 1 });
  allow(G);
  eq([asked(G), G.ask.seat], ['show', 1], '"First the selected opponent chooses one of their face down cards to show to the Inquisitor"');
  play(G, 1, { kind: 'show', card: cardId(G, 1, 'assassin') });
  eq([asked(G), G.ask.seat, A.viewFor(G, 0, 'X').ask.card.char, A.viewFor(G, 2, 'X').ask.card], ['examine', 0, 'assassin', undefined], 'the Inquisitor looks at it — no one else');
  const was = cardId(G, 1, 'assassin');
  play(G, 0, { kind: 'examine', swap: true });
  eq([G.players[1].cards.some((c) => c.id === was), G.deck.some((c) => c.id === was), total(G)], [false, true, 15], '"force the opponent to draw a new card randomly from the Court deck before returning the given card"');
  play(G, 1, { kind: 'act', action: 'steal', target: 0 });
  play(G, 2, { kind: 'allow' });
  bad(A.applyMove(G, 0, { kind: 'block', claim: 'ambassador' }), 'no Ambassador with the Inquisitor');
  play(G, 0, { kind: 'block', claim: 'inquisitor' });
  allow(G);
  eq(G.players[0].coins, 2, '"As a counteraction the Inquisitor may Block Stealing"');
  const X = table([['inquisitor', 'duke'], ['captain', 'assassin'], ['contessa', 'captain']], { inquisitor: true });
  play(X, 0, { kind: 'act', action: 'exchange' });
  allow(X);
  eq([X.ask.drawn.length, X.ask.drawn[0].char !== undefined], [1, true], '"First take one random card from the Court deck"');
  play(X, 0, { kind: 'exchange', keep: [X.ask.drawn[0].id, cardId(X, 0, 'duke')] });
  eq([X.players[0].cards.length, X.deck.length, total(X)], [2, 9, 15], '"Then return one card to the Court deck"');
}

console.log('— the two-player variant —');
{
  const G = A.newGame([{ seat: 0, name: 'A' }, { seat: 1, name: 'B' }], { ...A.defaultOpts(), twoPlayer: true }, { first: 0 });
  eq([asked(G), A.waitingOn(G), G.players.map((p) => p.set.map((c) => c.char).sort())], ['pick', [0, 1], [['ambassador', 'assassin', 'captain', 'contessa', 'duke'], ['ambassador', 'assassin', 'captain', 'contessa', 'duke']]], '"Divide the cards into a 3 sets of 5 (each set has one of each character). Each player takes one set"');
  eq(A.viewFor(G, 1, 'X').me.set.length === 5 && A.viewFor(G, 0, 'X').players[1].cards[0].char === undefined, true, 'each sees only their own set and card');
  play(G, 0, { kind: 'pick', card: G.players[0].set.find((c) => c.char === 'duke').id });
  play(G, 1, { kind: 'pick', card: G.players[1].set.find((c) => c.char === 'assassin').id });
  eq([G.players[0].cards.length, G.players[1].cards.length, G.deck.length, coinsOf(G), asked(G)], [2, 2, 3, [1, 2], 'act'], '"deal one card to each player and then put the remaining three cards face down as the court deck"; the starter has 1 coin');
  eq([G.players[0].cards[0].char, G.players[1].cards[0].char], ['duke', 'assassin'], 'the chosen card is kept');
}

console.log('— what each player may see —');
{
  const G = table([['duke', 'captain'], ['assassin', 'contessa'], ['captain', 'ambassador']]);
  for (const p of G.players) {
    const v = A.viewFor(G, p.seat, 'X');
    for (const q of v.players) {
      if (q.seat === p.seat) eq(q.cards.map((c) => c.char).sort(), hand(G, p.seat), `seat ${p.seat} sees its own cards`);
      else eq(q.cards, [{ up: false }, { up: false }], `seat ${p.seat} sees only the backs of seat ${q.seat}'s — no id`);
    }
    ok(!('deck' in v && Array.isArray(v.deck)), 'the Court deck is a count');
  }
  G.phase = 'over';
  eq(A.viewFor(G, 0, 'X').players[1].cards.map((c) => c.char), ['assassin', 'contessa'], 'at the end every card is shown');
}

console.log(`\n${checks} checks` + (fails ? `, ${fails} FAILURES` : ', all pass'));
process.exit(fails ? 1 : 0);
