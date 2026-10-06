// The rules, one at a time, on tables set up by hand — each against the
// rulebook's wording.
import * as S from './game.js';
import { parseCost } from './cards.js';

let fails = 0, checks = 0;
const eq = (got, want, what) => {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(want)) { console.log(`  **FAIL** ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); fails++; }
};
const T = (s = '') => { const t = { diamond: 0, sapphire: 0, emerald: 0, ruby: 0, onyx: 0, gold: 0 }; for (const x of s.split(' ').filter(Boolean)) t[{ D: 'diamond', S: 'sapphire', E: 'emerald', R: 'ruby', O: 'onyx', G: 'gold' }[x[0]]] = Number(x.slice(1)); return t; };

// a card by its description: 'level bonus points cost'
const find = (G, level, bonus, points, cost) => G.cards.find((c) => c.level === level && c.bonus === bonus && c.points === points && JSON.stringify(c.cost) === JSON.stringify(parseCost(cost))).id;

// A table from a spec: everyone's tokens, cards bought, reserves and Nobles;
// the cards on the table are put there on request (the rest stay in the decks).
function rig(spec) {
  const n = spec.players.length;
  const G = S.newGame(Array.from({ length: n }, (_, i) => ({ seat: i, name: 'P' + i, bot: true })), spec.opts || {});
  // everything back into the decks, then dealt as asked
  G.decks = { 1: [], 2: [], 3: [] };
  G.odecks = { 1: [], 2: [], 3: [] };
  for (const c of G.cards) (c.orient ? G.odecks : G.decks)[c.level].push(c.id);
  G.market = { 1: [null, null, null, null], 2: [null, null, null, null], 3: [null, null, null, null] };
  G.omarket = G.opts.orient ? { 1: [null, null], 2: [null, null], 3: [null, null] } : { 1: [], 2: [], 3: [] };
  const deckOf = (id) => (G.cards[id].orient ? G.odecks : G.decks)[G.cards[id].level];
  const take = (id) => { const d = deckOf(id); d.splice(d.indexOf(id), 1); return id; };
  for (const [l, ids] of Object.entries(spec.market || {})) ids.forEach((id, i) => { G.market[l][i] = take(id); });
  for (const [l, ids] of Object.entries(spec.omarket || {})) ids.forEach((id, i) => { G.omarket[l][i] = take(id); });
  // fill the rest of the table from the decks unless told otherwise
  if (!spec.bare) for (const l of [1, 2, 3]) {
    for (let i = 0; i < 4; i++) if (G.market[l][i] == null && G.decks[l].length) G.market[l][i] = G.decks[l].shift();
    for (let i = 0; i < G.omarket[l].length; i++) if (G.omarket[l][i] == null && G.odecks[l].length) G.omarket[l][i] = G.odecks[l].shift();
  }
  spec.players.forEach((ps, i) => {
    const p = G.players[i];
    p.tokens = T(ps.tokens);
    p.cards = (ps.cards || []).map(take);
    p.reserved = (ps.reserved || []).map((id) => ({ id: take(id), blind: false }));
    p.nobles = ps.nobles || [];
    p.assoc = ps.assoc || {};
    p.posts = ps.posts || [];
  });
  if (spec.bank) G.bank = T(spec.bank);
  if (spec.nobles) G.nobleRow = spec.nobles;
  if (spec.cities) G.cities = spec.cities;
  for (const [l, ids] of Object.entries(spec.top || {})) for (const id of ids) { const d = deckOf(id); take(id); d.push(id); }
  G.turn = spec.turn ?? 0;
  G.first = spec.first ?? 0;
  G.ending = null;
  G.stage = 'action';
  G.ask = { kind: 'turn', seat: G.turn };
  return G;
}
const P = (G, s) => G.players[s];
const go = (G, seat, move) => { const r = S.applyMove(G, seat, move); if (!r.ok) throw new Error(`${JSON.stringify(move)}: ${r.error}`); return r; };
const no = (G, seat, move, what) => eq(S.applyMove(G, seat, move).ok, false, what);
// a level-1 card that costs a lot of one gem, as filler for bought cards
const L1 = (G, bonus) => G.cards.find((c) => c.level === 1 && c.bonus === bonus && c.points === 0 && Object.keys(c.cost).length === 4 && Object.values(c.cost).every((v) => v === 1)).id;

console.log('— setup —');
for (const [n, gems, nobles] of [[2, 4, 3], [3, 5, 4], [4, 7, 5]]) {
  const G = S.newGame(Array.from({ length: n }, (_, i) => ({ seat: i, name: 'P' + i })));
  eq([G.bank.diamond, G.bank.onyx, G.bank.gold, G.nobleRow.length], [gems, gems, 5, nobles], `${n} players: ${gems} of each gem, 5 Gold, ${nobles} Nobles`);
  eq([1, 2, 3].map((l) => G.market[l].filter((x) => x != null).length), [4, 4, 4], `${n} players: four cards of each level on the table`);
  eq([1, 2, 3].map((l) => G.decks[l].length), [36, 26, 16], `${n} players: the rest in the decks`);
}

console.log('— taking gems —');
{
  const G = rig({ players: [{}, {}] });
  no(G, 0, { kind: 'take', gems: ['diamond', 'sapphire'] }, 'three different, not two, while three colours are there');
  no(G, 0, { kind: 'take', gems: ['diamond', 'diamond', 'sapphire'] }, 'three different colours');
  no(G, 0, { kind: 'take', gems: ['diamond', 'sapphire', 'gold'] }, '"You can never take a Gold token with this action"');
  go(G, 0, { kind: 'take', gems: ['diamond', 'sapphire', 'onyx'] });
  eq([P(G, 0).tokens.diamond, G.bank.diamond, G.ask.seat], [1, 3, 1], 'one each, from the supply; then the next player');
  const H = rig({ players: [{}, {}], bank: 'D0 S0 E0 R2 O1 G5' });
  go(H, 0, { kind: 'take', gems: ['ruby'] });
  eq(P(H, 0).tokens.ruby, 1, 'with fewer than three colours left, "you may take 2 tokens or even 1"');
  const K = rig({ players: [{}, {}], bank: 'D4 S3 E7 R2 O1 G5' });
  no(K, 0, { kind: 'take2', gem: 'sapphire' }, 'two of a kind needs a pile of four or more');
  go(K, 0, { kind: 'take2', gem: 'diamond' });
  eq([P(K, 0).tokens.diamond, K.bank.diamond], [2, 2], 'two from a pile of exactly four');
  no(rig({ players: [{}, {}] }), 0, { kind: 'take2', gem: 'gold' }, 'never two Gold');
}

console.log('— reserving —');
{
  const c = (G) => G.market[3][0];
  const G = rig({ players: [{}, {}] });
  const id = c(G);
  const deckBefore = G.decks[3].length;
  go(G, 0, { kind: 'reserve', card: id });
  eq([P(G, 0).reserved.map((r) => r.id), P(G, 0).tokens.gold, G.bank.gold], [[id], 1, 4], 'a reserved card, and a Gold with it');
  eq([G.market[3][0] != null && G.market[3][0] !== id, G.decks[3].length], [true, deckBefore - 1], 'its place is filled from the deck');
  const B = rig({ players: [{}, {}], bank: 'D7 S7 E7 R7 O7 G0' });
  go(B, 0, { kind: 'reserve', card: c(B) });
  eq([P(B, 0).reserved.length, P(B, 0).tokens.gold], [1, 0], '"If no Gold tokens remain, you may still reserve a card"');
  const D = rig({ players: [{}, {}] });
  const top = D.decks[2][D.decks[2].length - 1];
  go(D, 0, { kind: 'reserve', level: 2 });
  eq(P(D, 0).reserved, [{ id: top, blind: true }], 'or the top card of a deck');
  const v1 = S.viewFor(D, 1, 'X');
  const v0 = S.viewFor(D, 0, 'X');
  eq([v1.players[0].reserved[0].hidden, v1.players[0].reserved[0].id, v1.players[0].reserved[0].level, v0.players[0].reserved[0].id], [true, undefined, 2, top], '"without showing it to the other players"');
  const F = rig({ players: [{ reserved: [0, 41, 71] }, {}] });
  no(F, 0, { kind: 'reserve', card: c(F) }, '"you cannot have more than 3 reserved cards"');
}

console.log('— buying —');
{
  // the level-1 Sapphire card for a Diamond, an Emerald, 2 Rubies
  const G0 = rig({ players: [{}, {}] });
  const card = find(G0, 1, 'sapphire', 0, 'D1 E2 R2');
  const G = rig({ players: [{ tokens: 'D1 E2 R1 G1' }, {}], market: { 1: [card] } });
  go(G, 0, { kind: 'buy', card });
  eq([P(G, 0).cards, P(G, 0).tokens, G.bank.ruby, G.bank.gold], [[card], T(''), 5, 6], 'Gold stands in for the missing Ruby, and everything spent goes back');
  const H = rig({ players: [{ tokens: 'D1 E2 R2 G1' }, {}], market: { 1: [card] } });
  go(H, 0, { kind: 'buy', card });
  eq(P(H, 0).tokens, T('G1'), 'gems first; the Gold is kept when it is not needed');
  const K = rig({ players: [{ tokens: 'D1 E1 R2' }, {}], market: { 1: [card] } });
  no(K, 0, { kind: 'buy', card }, 'not without enough');
  // bonuses: "Each such bonus provides a discount of 1 Gem matching the color of the card"
  // one Diamond, two Emerald and two Ruby bonuses
  const owned = [L1(G0, 'diamond'), L1(G0, 'emerald'), find(G0, 1, 'emerald', 0, 'R3'), L1(G0, 'ruby'), find(G0, 1, 'ruby', 0, 'D3')];
  const M = rig({ players: [{ cards: owned, tokens: 'S2' }, {}], market: { 1: [card] } });
  eq(S.payment(M, P(M, 0), M.cards[card]), T(''), '"you can even purchase a card without spending any tokens"');
  go(M, 0, { kind: 'buy', card });
  eq([P(M, 0).cards.length, P(M, 0).tokens], [6, T('S2')], 'bought on bonuses alone, the tokens untouched');
  const N = rig({ players: [{ cards: owned.slice(0, 3), tokens: 'R1 G1' }, {}], market: { 1: [card] } });
  go(N, 0, { kind: 'buy', card });
  eq(P(N, 0).tokens, T(''), 'a bonus covers one gem of its colour; tokens and Gold the rest');
  const Rz = rig({ players: [{ reserved: [card], tokens: 'D1 E2 R2' }, {}] });
  go(Rz, 0, { kind: 'buy', card });
  eq([P(Rz, 0).reserved, P(Rz, 0).cards], [[], [card]], 'a reserved card is bought from the hand');
  const O = rig({ players: [{ tokens: 'D1 E2 R2' }, { reserved: [card] }] });
  no(O, 0, { kind: 'buy', card }, 'never someone else’s reserved card');
  const Q = rig({ players: [{ tokens: 'D1 E2 R2' }, {}], market: { 1: [card] }, bare: true });
  Q.decks[1] = [];
  go(Q, 0, { kind: 'buy', card });
  eq(Q.market[1][0], null, 'an empty deck leaves the place empty');
}

console.log('— ten tokens —');
{
  const G = rig({ players: [{ tokens: 'D2 S2 E2 R2' }, {}] });
  go(G, 0, { kind: 'take', gems: ['diamond', 'sapphire', 'onyx'] });
  eq([G.ask.kind, G.ask.seat, G.ask.n], ['discard', 0, 1], 'eleven tokens: one must go back');
  no(G, 0, { tokens: { ruby: 2 } }, 'exactly as many as are over');
  no(G, 0, { tokens: { onyx: 2 } }, 'only tokens you hold');
  go(G, 0, { tokens: { diamond: 1 } });
  eq([Object.values(P(G, 0).tokens).reduce((a, b) => a + b), G.ask.seat], [10, 1], 'back to ten, and the turn passes');
  const H = rig({ players: [{ tokens: 'D2 S2 E2 R2 G2' }, {}] });
  go(H, 0, { kind: 'take', gems: ['diamond', 'sapphire', 'emerald'] });
  go(H, 0, { tokens: { gold: 1, emerald: 2 } });
  eq([P(H, 0).tokens.gold, H.bank.gold], [1, 6], 'Gold may go back too: "excess tokens of your choice"');
}

console.log('— Nobles —');
{
  const G0 = rig({ players: [{}, {}] });
  const nob = G0.nobles.findIndex((n) => n.req.diamond === 4 && n.req.sapphire === 4);
  const four = (bonus) => G0.cards.filter((c) => c.bonus === bonus && c.level === 1 && !c.points).slice(0, 4).map((c) => c.id);
  const lastD = find(G0, 1, 'diamond', 0, 'S3');
  const cards = [...four('sapphire'), ...four('diamond').filter((x) => x !== lastD).slice(0, 3)];
  const G = rig({ players: [{ cards, tokens: 'S3' }, {}], market: { 1: [lastD] }, nobles: [nob, (nob + 1) % 10] });
  go(G, 0, { kind: 'buy', card: lastD });
  eq([P(G, 0).nobles, G.nobleRow.includes(nob), S.score(G, P(G, 0))], [[nob], false, 3], 'four Diamond and four Sapphire bonuses: the Noble visits, for 3');
  const H = rig({ players: [{ cards: [...four('sapphire'), ...four('diamond').slice(0, 3)], tokens: 'D4 D4' }, {}], nobles: [nob] });
  go(H, 0, { kind: 'take', gems: ['emerald', 'ruby', 'onyx'] });
  eq(P(H, 0).nobles, [], 'tokens do not count toward a Noble — only bonuses');
  const both = H.nobles.findIndex((n) => n.req.diamond === 3 && n.req.sapphire === 3 && n.req.onyx === 3);
  const threes = (bonus) => G0.cards.filter((c) => c.bonus === bonus && c.level === 1 && !c.points).slice(0, 3).map((c) => c.id);
  const K = rig({ players: [{ cards: [...four('diamond'), ...four('sapphire'), ...threes('onyx')] }, {}], nobles: [nob, both] });
  go(K, 0, { kind: 'take', gems: ['emerald', 'ruby', 'onyx'] });
  eq([K.ask.kind, K.ask.options], ['noble', [nob, both]], 'two Nobles at once: "you must choose 1"');
  go(K, 0, { noble: both });
  eq([P(K, 0).nobles, K.nobleRow, K.ask.seat], [[both], [nob], 1], 'one per turn — the other may come next turn');
  go(K, 1, { kind: 'take', gems: ['diamond', 'sapphire', 'emerald'] });
  go(K, 0, { kind: 'take', gems: ['diamond', 'sapphire', 'emerald'] });
  eq(P(K, 0).nobles.length, 2, '…and does');
}

console.log('— the end —');
{
  const G0 = rig({ players: [{}, {}] });
  const five = ['diamond', 'sapphire', 'emerald', 'ruby', 'onyx'].map((b) => G0.cards.find((c) => c.level === 3 && c.bonus === b && c.points === 5).id);
  const four = ['diamond', 'sapphire', 'emerald'].map((b) => G0.cards.find((c) => c.level === 3 && c.bonus === b && c.points === 4).id);
  const G = rig({ players: [{}, { cards: [five[0], five[1]], tokens: 'R7 O3' }, {}], market: { 3: [five[4]] }, turn: 1, first: 0 });
  go(G, 1, { kind: 'buy', card: five[4] });
  eq([G.ending, G.phase, G.ask.seat], [1, 'play', 2], '15 points: the end is triggered, and the round goes on');
  go(G, 2, { kind: 'take', gems: ['diamond', 'sapphire', 'emerald'] });
  eq([G.phase, G.winners], ['over', [1]], 'the player before the first plays the last turn; then the most Prestige wins');
  const H = rig({ players: [{ cards: five.slice(0, 3) }, { cards: [five[3], five[4], four[0], L1(G0, 'ruby')] }], turn: 1, first: 0 });
  P(H, 1).cards.push(H.cards.find((c) => c.level === 1 && c.points === 1).id);
  go(H, 1, { kind: 'take', gems: ['diamond', 'sapphire', 'emerald'] });
  eq([S.score(H, P(H, 0)), S.score(H, P(H, 1)), H.phase, H.winners], [15, 15, 'over', [0]], 'tied: "the tied player who purchased the FEWEST Development cards wins"');
  const J = rig({ players: [{ cards: five.slice(0, 3) }, { cards: four, nobles: [0] }], turn: 1, first: 0 });
  go(J, 1, { kind: 'take', gems: ['diamond', 'sapphire', 'emerald'] });
  eq([S.score(J, P(J, 0)), S.score(J, P(J, 1)), J.winners], [15, 15, [0, 1]], '"If it\'s still tied, the tied players share the victory" — a Noble is not a card bought');
  const K = rig({ players: [{ cards: five.slice(0, 2) }, {}], turn: 0, first: 0 });
  go(K, 0, { kind: 'take', gems: ['diamond', 'sapphire', 'emerald'] });
  eq(K.ending, null, 'fewer than 15: no end');
}

console.log('— no action —');
{
  const G = rig({ players: [{ reserved: [0, 41, 71] }, {}], bank: 'D0 S0 E0 R0 O0 G0', turn: 1 });
  go(G, 1, { kind: 'reserve', card: G.market[1][0] });
  eq([P(G, 1).tokens.gold, G.ask.seat, G.log.some((l) => /passes/.test(l.text))], [0, 1, true], 'nothing to take, reserve or buy: the player passes');
}

// an Orient card by kind, colour and cost (or the colour a sacrifice takes)
const oc = (G, kind, bonus, cost) => G.cards.find((c) => c.orient && c.kind === kind && (bonus === undefined || c.bonus === bonus || c.discard === bonus) && (!cost || JSON.stringify(c.cost) === JSON.stringify(parseCost(cost)))).id;
const sorted = (a) => a.slice().sort((x, y) => x - y);

console.log('— the Orient —');
{
  const G = S.newGame([{ seat: 0, name: 'A' }, { seat: 1, name: 'B' }], { orient: true });
  eq([1, 2, 3].map((l) => G.omarket[l].filter((x) => x != null).length), [2, 2, 2], '"reveal 2 cards from each deck"');
  eq([1, 2, 3].map((l) => G.odecks[l].length), [8, 8, 8], 'the rest in the three Orient decks');
  const O = rig({ players: [{}, {}], opts: { orient: true } });
  const top = O.odecks[2][O.odecks[2].length - 1];
  go(O, 0, { kind: 'reserve', level: 2, orient: true });
  eq(P(O, 0).reserved, [{ id: top, blind: true }], 'the top of an Orient deck can be reserved');
}
{
  const G0 = rig({ players: [{}, {}], opts: { orient: true } });
  const gold = oc(G0, 'gold', null, 'R3');
  const card = find(G0, 1, 'sapphire', 0, 'D1 E2 R2');
  const G = rig({ players: [{ tokens: 'D1 E2', cards: [gold] }, {}], opts: { orient: true }, market: { 1: [card] } });
  no(G, 0, { kind: 'buy', card }, 'two Rubies short, and no Gold');
  go(G, 0, { kind: 'buy', card, goldCards: 1 });
  eq([P(G, 0).cards, G.out, P(G, 0).tokens], [[card], [gold], T('')], 'a Gold card, discarded, pays as 2 Gold — and goes back to the box');
  const H = rig({ players: [{ tokens: 'D1 E2 R1', cards: [gold] }, {}], opts: { orient: true }, market: { 1: [card] } });
  go(H, 0, { kind: 'buy', card, goldCards: 1 });
  eq([H.bank.gold, P(H, 0).tokens], [5, T('E1')], 'the second virtual Gold goes in place of a gem: the costliest colour');
  const K = rig({ players: [{ tokens: 'D1 E2 R2', cards: [gold] }, {}], opts: { orient: true }, market: { 1: [card] } });
  go(K, 0, { kind: 'buy', card, goldCards: 1 });
  eq(P(K, 0).tokens, T('E1 R1'), 'a Gold card may be spent with the gems in hand, to keep them');
  const emer = L1(G0, 'emerald'), emer2 = G0.cards.find((c) => !c.orient && c.level === 1 && c.bonus === 'emerald' && c.id !== emer).id;
  const rub = L1(G0, 'ruby'), rub2 = G0.cards.find((c) => !c.orient && c.level === 1 && c.bonus === 'ruby' && c.id !== rub).id;
  const M = rig({ players: [{ tokens: 'D1', cards: [gold, emer, emer2, rub, rub2] }, {}], opts: { orient: true }, market: { 1: [card] } });
  go(M, 0, { kind: 'buy', card, goldCards: 1 });
  eq([M.bank.gold, P(M, 0).tokens, M.out], [5, T('D1'), [gold]], '"If you spend only 1 of these virtual tokens, the second is lost"');
  const N = rig({ players: [{ tokens: 'D1', cards: [gold, H.cards.find((c) => c.kind === 'gold' && c.id !== gold).id, emer, emer2, rub, rub2] }, {}], opts: { orient: true }, market: { 1: [card] } });
  no(N, 0, { kind: 'buy', card, goldCards: 2 }, 'no Gold card spent that pays for nothing');
  const gold2 = G0.cards.find((c) => c.kind === 'gold' && c.id !== gold).id;
  const four = find(G0, 1, 'onyx', 0, 'D1 S1 E1 R1');
  const GP = rig({ players: [{ cards: [gold, gold2, L1(G0, 'sapphire')], posts: [2] }, {}], opts: { orient: true, trading: true }, market: { 1: [four] } });
  go(GP, 0, { kind: 'buy', card: four, goldCards: 2 });
  eq([P(GP, 0).cards.includes(four), sorted(GP.out)], [true, sorted([gold, gold2])], 'with the Gold Trading Post a virtual Gold still covers one colour: two Gold cards for Diamond, Emerald and Ruby');
  const NG = rig({ players: [{ tokens: 'D1 E2 R2', cards: [gold, gold2] }, {}], opts: { orient: true }, market: { 1: [card] } });
  no(NG, 0, { kind: 'buy', card, goldCards: -1 }, 'no negative count of Gold cards');
  eq(NG.out, [], '…and none thrown away');
  const EP = rig({ players: [{}, {}], bare: true });
  no(EP, 0, { kind: 'buy', card: null }, 'an empty place on the table is not a card');
  const Z = rig({ players: [{ cards: [gold] }, {}], opts: { orient: true } });
  eq([S.counts(Z, P(Z, 0)), S.bonuses(Z, P(Z, 0))], [{ diamond: 0, sapphire: 0, emerald: 0, ruby: 0, onyx: 0 }, { diamond: 0, sapphire: 0, emerald: 0, ruby: 0, onyx: 0 }], '"For all purposes, this card has no color"');
}
{
  const G0 = rig({ players: [{}, {}], opts: { orient: true } });
  const copy = oc(G0, 'copy', null, 'D3 R2');
  const ruby = L1(G0, 'ruby'), dia = L1(G0, 'diamond');
  const A = rig({ players: [{ tokens: 'D3 R2' }, {}], opts: { orient: true }, omarket: { 1: [copy] } });
  no(A, 0, { kind: 'buy', card: copy }, '"You cannot purchase this card if you don\'t already have a card with a bonus"');
  const B = rig({ players: [{ tokens: 'D2 R1', cards: [ruby, dia] }, {}], opts: { orient: true }, omarket: { 1: [copy] } });
  go(B, 0, { kind: 'buy', card: copy });
  eq([B.ask.kind, sorted(B.ask.options)], ['copy', sorted([ruby, dia])], 'buying a copy card: which card does it match?');
  go(B, 0, { target: ruby });
  eq([P(B, 0).assoc[copy], S.bonuses(B, P(B, 0)).ruby, S.counts(B, P(B, 0)).ruby], ['ruby', 2, 2], '"the color and the bonus of this card are considered to be the same as the chosen card"');
  const dbl = oc(G0, 'double', 'diamond');
  const copy2 = oc(G0, 'copy', null, 'S2 R3');
  const C = rig({ players: [{ tokens: 'S2 R2', cards: [dbl, ruby] }, {}], opts: { orient: true }, omarket: { 1: [copy2] } });
  go(C, 0, { kind: 'buy', card: copy2 });
  go(C, 0, { target: dbl });
  eq([S.bonuses(C, P(C, 0)).diamond, S.counts(C, P(C, 0)).diamond], [3, 2], 'a copy of a double-bonus card brings one bonus, as Board Game Arena has it');
  const D = rig({ players: [{ cards: [dbl] }, {}], opts: { orient: true } });
  eq([S.bonuses(D, P(D, 0)).diamond, S.counts(D, P(D, 0)).diamond], [2, 1], 'a double-bonus card: two bonuses to pay with, one card for every condition');
  const red = find(G0, 1, 'ruby', 0, 'D2 R2');
  eq(S.payment(D, P(D, 0), D.cards[red]), null, 'a card costing 2 Diamonds and 2 Rubies…');
  P(D, 0).tokens = T('R2');
  eq(S.payment(D, P(D, 0), D.cards[red]), T('R2'), '…is 2 Rubies to its holder');
  const noble = D.nobles.findIndex((x) => x.req.diamond === 4 && x.req.sapphire === 4);
  P(D, 0).cards.push(...D.cards.filter((c) => c.level === 1 && c.bonus === 'sapphire' && !c.points).slice(0, 4).map((c) => c.id), ...D.cards.filter((c) => c.level === 1 && c.bonus === 'diamond' && !c.points).slice(0, 2).map((c) => c.id));
  eq(S.meets(D, P(D, 0), D.nobles[noble]), false, 'four Sapphire and, with the double, five Diamond bonuses — but only three Diamond cards: no Noble');
}
{
  const G0 = rig({ players: [{}, {}], opts: { orient: true } });
  const ct = oc(G0, 'copytake', null, 'D1 E3 R4');
  const ruby = L1(G0, 'ruby'), dia = L1(G0, 'diamond');
  const free = find(G0, 1, 'onyx', 1, 'S4');
  const goldC = oc(G0, 'gold', null, 'E3');
  const E = rig({ players: [{ tokens: 'E3 R3', cards: [ruby, dia] }, {}], opts: { orient: true }, omarket: { 2: [ct], 1: [goldC] }, market: { 1: [free] } });
  go(E, 0, { kind: 'buy', card: ct });
  eq(E.ask.kind, 'copy', '"first associate it with another card"');
  go(E, 0, { target: dia });
  eq([E.ask.kind, E.ask.level, E.ask.options.includes(free), E.ask.options.includes(goldC)], ['take', 1, true, true], '"Then ... take 1 faceup base game or Orient card from the level ● row"');
  go(E, 0, { card: free });
  eq([P(E, 0).cards.includes(free), P(E, 0).tokens, S.score(E, P(E, 0))], [true, T(''), 2], '"Do not pay its cost" — and its point is yours');
  eq([E.market[1][0] != null && E.market[1][0] !== free, E.omarket[2][0] != null && E.omarket[2][0] !== ct], [true, true], '"replace both cards in the center of the table"');
  const tk = oc(G0, 'take', 'diamond');
  const l2 = find(G0, 2, 'onyx', 2, 'D5');
  const other = find(G0, 2, 'ruby', 2, 'O5');
  const F = rig({ players: [{ tokens: 'S6 E3 R1' }, {}], opts: { orient: true, strongholds: true }, omarket: { 3: [tk] }, market: { 2: [l2, other] } });
  F.holds[l2] = [1];
  P(F, 1).holds = 2;
  go(F, 0, { kind: 'buy', card: tk });
  eq([F.ask.kind, F.ask.level, F.ask.options.includes(l2), F.ask.options.includes(other)], ['take', 2, false, true], 'a level-3 card that takes a level-2 card — never one under a rival Stronghold');
  go(F, 0, { card: other });
  eq([F.ask.kind, P(F, 0).cards.length], ['hold', 2], 'a free card is not a purchase: one Stronghold, for the card bought');
}
{
  const G0 = rig({ players: [{}, {}], opts: { orient: true } });
  const sac = oc(G0, 'sacrifice', 'sapphire');
  const s1 = find(G0, 1, 'sapphire', 1, 'R4'), s2 = L1(G0, 'sapphire');
  const H = rig({ players: [{ cards: [s1, s2], nobles: [0] }, {}], opts: { orient: true }, omarket: { 3: [sac] } });
  no(H, 0, { kind: 'buy', card: sac, discard: [s1] }, '"discard 2 cards of the indicated color"');
  go(H, 0, { kind: 'buy', card: sac, discard: [s1, s2] });
  eq([P(H, 0).cards, sorted(H.out), S.score(H, P(H, 0)), P(H, 0).nobles], [[sac], sorted([s1, s2]), 6, [0]], 'paid with two Sapphire cards, which go back to the box; the Noble stays');
  const copy = oc(G0, 'copy', null, 'S2 R3');
  const K = rig({ players: [{ cards: [s1, s2, copy], assoc: { [copy]: 'sapphire' } }, {}], opts: { orient: true }, omarket: { 3: [sac] } });
  no(K, 0, { kind: 'buy', card: sac, discard: [s1, s2] }, '"cards that are considered to be that color ... must be discarded before other cards of that color"');
  go(K, 0, { kind: 'buy', card: sac, discard: [copy, s2] });
  eq(sorted(P(K, 0).cards), sorted([s1, sac]), '…and the copy goes first');
  const ct = oc(G0, 'copytake', null, 'D1 E3 R4'), copy2 = oc(G0, 'copy', null, 'D3 R2');
  const L = rig({ players: [{ cards: [s2, ct, copy, copy2], assoc: { [ct]: 'sapphire', [copy]: 'sapphire', [copy2]: 'sapphire' } }, {}], opts: { orient: true }, omarket: { 3: [sac] } });
  eq(sorted(S.buyPlan(L, P(L, 0), sac).discard), sorted([copy, copy2]), 'with three Sapphire copies, the two worth least are the ones to go');
}

console.log('— the Strongholds —');
{
  const G0 = rig({ players: [{}, {}] });
  const card = find(G0, 1, 'sapphire', 0, 'D1 E2 R2');
  const card2 = find(G0, 1, 'emerald', 0, 'D2 S1');
  const G = rig({ players: [{ tokens: 'D1 E2 R2' }, { tokens: 'D2 S1' }], opts: { strongholds: true }, market: { 1: [card, card2] } });
  go(G, 0, { kind: 'buy', card });
  eq(G.ask.kind, 'hold', '"Each time you purchase a card ... you must choose one of the following two options"');
  const tgt = G.market[2][0];
  no(G, 0, { to: card }, 'never on the card just bought');
  go(G, 0, { to: tgt });
  eq([G.holds[tgt], P(G, 0).holds, G.ask.seat], [[0], 2, 1], 'a Stronghold placed on a card on the table');
  no(G, 1, { kind: 'reserve', card: tgt }, '"can only be purchased or reserved by the player who placed those Strongholds"');
  go(G, 1, { kind: 'buy', card: card2 });
  go(G, 1, { remove: tgt });
  eq([G.holds[tgt], P(G, 0).holds], [undefined, 3], '"choose a card containing exactly 1 of an OPPONENT\'S Strongholds; remove the Stronghold"');
  const R = rig({ players: [{}, {}], opts: { strongholds: true } });
  const own = R.market[3][0];
  R.holds[own] = [0, 0];
  P(R, 0).holds = 1;
  go(R, 0, { kind: 'reserve', card: own });
  eq([P(R, 0).holds, R.holds[own]], [3, undefined], '"When you purchase or reserve a card occupied by your own Strongholds, you take back your Stronghold(s)"');
  const C = rig({ players: [{ tokens: 'E2 R1' }, {}], opts: { strongholds: true }, market: { 1: [card] } });
  C.holds[card] = [0, 0, 0];
  P(C, 0).holds = 0;
  go(C, 0, { kind: 'take', gems: ['ruby', 'diamond', 'onyx'] });
  eq([C.ask.kind, C.ask.card], ['conquest', card], '"Conquest: When all 3 of your Strongholds are on a single card, you may purchase that card after performing your standard turn action"');
  go(C, 0, { buy: true });
  eq([P(C, 0).cards, C.ask.kind, P(C, 0).holds], [[card], 'hold', 3], 'bought with the gems just taken — the Strongholds come back, and a purchase places one');
  const X = rig({ players: [{ tokens: 'D3 S1 E2 R2' }, {}], opts: { strongholds: true }, market: { 1: [card, card2] } });
  X.holds[card2] = [0, 0];
  P(X, 0).holds = 1;
  go(X, 0, { kind: 'buy', card });
  go(X, 0, { to: card2 });
  eq([X.ask.kind, X.market[1][0]], ['conquest', null], '"Finally, she ... replaces both purchased cards": not before the Conquest');
  go(X, 0, { buy: true });
  go(X, 0, { to: X.market[3][0] });
  eq([X.market[1][0] != null, X.market[1][1] != null], [true, true], '…but after it, both');
  const Y = rig({ players: [{ tokens: 'D2 S1' }, {}], opts: { strongholds: true }, market: { 1: [card, card2] } });
  Y.holds[card2] = [0, 0, 0];
  P(Y, 0).holds = 0;
  go(Y, 0, { kind: 'reserve', card });
  eq([Y.ask.kind, Y.market[1][0] != null], ['conquest', true], 'a reserved card is replaced at once, before the Conquest');
}

console.log('— the Trading Posts —');
{
  const G0 = rig({ players: [{}, {}] });
  const rubies = G0.cards.filter((c) => c.level === 1 && c.bonus === 'ruby' && !c.points).slice(0, 3).map((c) => c.id);
  const T1 = rig({ players: [{ cards: [...rubies, L1(G0, 'diamond')] }, {}], opts: { trading: true } });
  go(T1, 0, { kind: 'take', gems: ['diamond', 'sapphire', 'emerald'] });
  eq(P(T1, 0).posts, [0], 'three Ruby cards and a Diamond card: the Trading Post is claimed at the end of the turn');
  const card = find(G0, 1, 'sapphire', 0, 'D1 E2 R2');
  const T2 = rig({ players: [{ tokens: 'D1 E2 R2', posts: [0] }, {}], opts: { trading: true }, market: { 1: [card] } });
  go(T2, 0, { kind: 'buy', card });
  eq(T2.ask.kind, 'gem', '"Immediately after purchasing any card ... take any 1 piece (except a Gold piece)"');
  go(T2, 0, { gem: 'ruby' });
  eq(P(T2, 0).tokens, T('R1'), '"The piece you take can be one of those you just spent"');
  const T3 = rig({ players: [{ posts: [1] }, {}], opts: { trading: true } });
  go(T3, 0, { kind: 'take2', gem: 'onyx' });
  eq([T3.ask.kind, T3.ask.options.includes('onyx'), T3.ask.options.includes('ruby')], ['third', false, true], '"After taking 2 pieces of the same color, take 1 piece of another color"');
  go(T3, 0, { gem: 'ruby' });
  eq(P(T3, 0).tokens, T('O2 R1'), '…three tokens in all');
  const T4 = rig({ players: [{ tokens: 'D1 E2 G1', posts: [2] }, {}], opts: { trading: true }, market: { 1: [card] } });
  go(T4, 0, { kind: 'buy', card });
  eq(P(T4, 0).tokens, T(''), '"each Gold piece you spend is worth 2 pieces of the same color"');
  const T5 = rig({ players: [{ posts: [3] }, {}], opts: { trading: true } });
  const two = T5.decks[1].slice(-2).reverse();
  go(T5, 0, { kind: 'reserve', level: 1 });
  eq([T5.ask.kind, T5.ask.options], ['draw2', two], '"draw the first 2 cards from the chosen deck"');
  eq([S.viewFor(T5, 1, 'T').ask, S.viewFor(T5, 1, 'T').look], [{ kind: 'draw2', seat: 0, level: 1, orient: false }, null], '"without showing them to the other players"');
  go(T5, 0, { keep: two[1] });
  eq([P(T5, 0).reserved[0].id, T5.decks[1][0]], [two[1], two[0]], '"Keep 1 ... and return the other card to the bottom of its deck"');
  const T6 = rig({ players: [{ posts: [4] }, {}], opts: { trading: true } });
  eq(S.score(T6, P(T6, 0)), 1, '"1 Prestige point for each Trading Post you have (including this one)"');
  P(T6, 0).posts = [4, 0, 1];
  eq(S.score(T6, P(T6, 0)), 3, '…every one of them');
  const greens = G0.cards.filter((c) => c.level === 1 && c.bonus === 'emerald' && !c.points).slice(0, 5).map((c) => c.id);
  const T7 = rig({ players: [{ cards: [...greens, ...G0.cards.filter((c) => c.level === 1 && c.bonus === 'onyx' && !c.points).slice(0, 3).map((c) => c.id)] }, {}], opts: { trading: true } });
  go(T7, 0, { kind: 'take', gems: ['diamond', 'sapphire', 'emerald'] });
  eq([T7.ask.kind, sorted(T7.ask.options)], ['post', [3, 4]], '"You can only take 1 Trading Post tile per turn" — choose');
  go(T7, 0, { post: 4 });
  go(T7, 1, { kind: 'take', gems: ['diamond', 'sapphire', 'emerald'] });
  go(T7, 0, { kind: 'take', gems: ['diamond', 'sapphire', 'ruby'] });
  eq(sorted(P(T7, 0).posts), [3, 4], '…and the other next turn');
}

console.log('— the Cities —');
{
  const G = S.newGame([{ seat: 0, name: 'A' }, { seat: 1, name: 'B' }], { cities: true, nobles: true });
  eq([G.nobleRow.length, G.cities.length, new Set(G.cities.map((c) => c.tile)).size], [0, 3, 3], '"Remove all Noble tiles ... randomly choose 3" Cities');
  const G0 = rig({ players: [{}, {}] });
  const fives = ['diamond', 'sapphire', 'emerald', 'ruby', 'onyx'].map((b) => G0.cards.find((c) => c.level === 3 && c.bonus === b && c.points === 5).id);
  const krakow = [{ tile: 2, side: 0 }];
  const Q = rig({ players: [{ cards: fives.slice(0, 3) }, {}], opts: { cities: true }, cities: krakow, first: 0 });
  go(Q, 0, { kind: 'take', gems: ['diamond', 'sapphire', 'emerald'] });
  eq(Q.ending, null, 'with the Cities, 15 points alone end nothing');
  const four = G0.cards.find((c) => c.level === 3 && c.bonus === 'diamond' && c.points === 4).id;
  const R = rig({ players: [{ cards: [...fives.slice(0, 3), four], tokens: '' }, { cards: [fives[3], fives[4], G0.cards.find((c) => c.level === 3 && c.bonus === 'sapphire' && c.points === 4).id, G0.cards.find((c) => c.level === 2 && c.bonus === 'diamond' && c.points === 3).id] }], opts: { cities: true }, cities: krakow, first: 0 });
  go(R, 0, { kind: 'take', gems: ['diamond', 'sapphire', 'emerald'] });
  eq([R.ending, R.phase], [0, 'play'], '19 points: Krakow\'s 17 met — the round is finished');
  go(R, 1, { kind: 'take', gems: ['diamond', 'sapphire', 'emerald'] });
  eq([R.phase, R.winners], ['over', [0]], '"If several players fulfill the requirements ... whichever of them has the most Prestige points wins" — 19 against 17');
  const W = rig({ players: [{ cards: [...fives.slice(0, 2), four] }, { cards: [] }], opts: { cities: true }, cities: [{ tile: 4, side: 0 }], first: 0 });
  const whites = G0.cards.filter((c) => c.level === 1 && c.bonus === 'diamond' && !c.points).slice(0, 3).map((c) => c.id);
  P(W, 0).cards.push(...whites, ...G0.cards.filter((c) => c.level === 1 && c.bonus === 'onyx' && !c.points).slice(0, 4).map((c) => c.id));
  eq(S.meetsCity(W, P(W, 0), W.cities[0]), true, 'Samarkand: 14 points, 4 Diamond cards and 4 of another colour');
  P(W, 0).cards = P(W, 0).cards.filter((id) => W.cards[id].bonus !== 'onyx');
  P(W, 0).cards.push(...G0.cards.filter((c) => c.level === 1 && c.bonus === 'diamond' && c.points).map((c) => c.id), ...G0.cards.filter((c) => c.level === 2 && c.bonus === 'diamond' && c.points === 1).map((c) => c.id));
  eq([S.counts(W, P(W, 0)).diamond >= 8, S.meetsCity(W, P(W, 0), W.cities[0])], [true, false], '"this color cannot be the same as any other requirement on the tile"');
}

console.log(`\n${checks} checks` + (fails ? `, ${fails} FAILURES` : ', all pass'));
process.exit(fails ? 1 : 0);
