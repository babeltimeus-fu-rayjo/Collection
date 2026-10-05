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
  const G = S.newGame(Array.from({ length: n }, (_, i) => ({ seat: i, name: 'P' + i, bot: true })));
  // everything back into the decks, then dealt as asked
  const all = G.cards.map((c) => c.id);
  G.decks = { 1: [], 2: [], 3: [] };
  for (const id of all) G.decks[G.cards[id].level].push(id);
  G.market = { 1: [null, null, null, null], 2: [null, null, null, null], 3: [null, null, null, null] };
  const take = (id) => { const d = G.decks[G.cards[id].level]; d.splice(d.indexOf(id), 1); return id; };
  for (const [l, ids] of Object.entries(spec.market || {})) ids.forEach((id, i) => { G.market[l][i] = take(id); });
  // fill the rest of the table from the decks unless told otherwise
  if (!spec.bare) for (const l of [1, 2, 3]) for (let i = 0; i < 4; i++) if (G.market[l][i] == null && G.decks[l].length) G.market[l][i] = G.decks[l].shift();
  spec.players.forEach((ps, i) => {
    const p = G.players[i];
    p.tokens = T(ps.tokens);
    p.cards = (ps.cards || []).map(take);
    p.reserved = (ps.reserved || []).map((id) => ({ id: take(id), blind: false }));
    p.nobles = ps.nobles || [];
  });
  if (spec.bank) G.bank = T(spec.bank);
  if (spec.nobles) G.nobleRow = spec.nobles;
  for (const [l, ids] of Object.entries(spec.top || {})) for (const id of ids) { take(id); G.decks[l].push(id); }
  G.turn = spec.turn ?? 0;
  G.first = spec.first ?? 0;
  G.ending = null;
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

console.log(`\n${checks} checks` + (fails ? `, ${fails} FAILURES` : ', all pass'));
process.exit(fails ? 1 : 0);
