// The rules, one at a time, on tables set up by hand: distance, every card,
// every character, the penalties and rewards, and the end of the game — each
// against the rulebook's or the FAQ's wording.
import * as B from './game.js';

let fails = 0, checks = 0;
const eq = (got, want, what) => {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(want)) { console.log(`  **FAIL** ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); fails++; }
};
const ok = (c, what) => eq(!!c, true, what);

// A table from a spec. Cards are named 'kind', 'kind:S' (suit) or
// 'kind:S:Q' (suit and value); `top` lists the deck's next cards in order.
function rig(spec) {
  const n = spec.seats.length;
  const G = B.newGame(Array.from({ length: n }, (_, i) => ({ seat: i, name: 'P' + i, bot: true })));
  for (const p of G.players) { p.hand = []; p.table = []; }
  Object.assign(G, { discard: [], deck: [], queue: [], ask: null, store: null, look: null, acts: [], flips: [] });
  const free = new Set(G.cards.map((c) => c.id));
  const take = (s) => {
    const [kind, suit, rank] = s.split(':');
    const id = [...free].find((x) => G.cards[x].kind === kind && (!suit || G.cards[x].suit === suit) && (!rank || G.cards[x].rank === rank));
    if (id == null) throw new Error('no free card ' + s);
    free.delete(id);
    return id;
  };
  spec.seats.forEach((s, i) => {
    const p = G.players[i];
    p.role = s.role || 'outlaw';
    p.char = s.char || 'willy';
    p.max = B.CHARACTERS[p.char].life + (p.role === 'sheriff' ? 1 : 0);
    p.life = s.life ?? p.max;
    p.alive = s.alive !== false;
    p.hand = (s.hand || []).map(take);
    p.table = (s.table || []).map(take);
  });
  const top = (spec.top || []).map(take);
  G.discard = (spec.discard || []).map(take);
  G.deck = [...free, ...top.reverse()];
  G.turn = spec.turn ?? 0;
  G.step = spec.step || 'play';
  G.bangs = 0;
  if (G.step === 'play') G.ask = { kind: 'turn', seat: G.players[G.turn].seat };
  return G;
}
const P = (G, s) => G.players[s];
const card = (G, s, kind) => P(G, s).hand.find((id) => G.cards[id].kind === kind);
const kinds = (G, ids) => ids.map((id) => G.cards[id].kind);
const go = (G, seat, move) => { const r = B.applyMove(G, seat, move); if (!r.ok) throw new Error(`${JSON.stringify(move)} by ${seat}: ${r.error}`); return r; };
const no = (G, seat, move, what) => eq(B.applyMove(G, seat, move).ok, false, what);
const shoot = (G, from, to, kind = 'bang') => go(G, from, { kind: 'play', card: card(G, from, kind), target: to });
const SEAT5 = () => [{ role: 'sheriff' }, { role: 'deputy' }, { role: 'outlaw' }, { role: 'outlaw' }, { role: 'renegade' }];

console.log('— distance —');
{
  const G = rig({ seats: SEAT5() });
  eq([1, 2, 2, 1].map((t) => B.distance(G, 0, t)), [1, 2, 2, 1], 'seats one and two places away, either way round');
  P(G, 2).table.push(G.cards.find((c) => c.kind === 'mustang').id);
  eq(B.distance(G, 0, 2), 3, 'a Mustang adds one to how far others see you');
  eq(B.distance(G, 2, 0), 2, '…but not to how far you see them');
  P(G, 0).table.push(G.cards.find((c) => c.kind === 'scope').id);
  eq([B.distance(G, 0, 1), B.distance(G, 0, 3)], [1, 1], 'a Scope takes one off — never below 1');
  const D = rig({ seats: [{ role: 'sheriff' }, {}, {}, {}, {}, {}] });
  eq(B.distance(D, 0, 3), 3, 'across a table of six: 3');
  P(D, 1).alive = false;
  eq(B.distance(D, 0, 3), 2, 'the eliminated no longer count');
  const H = rig({ seats: [{ role: 'sheriff', char: 'rose' }, { char: 'paul' }, {}, {}, {}] });
  eq([B.distance(H, 0, 2), B.distance(H, 2, 1), B.distance(H, 0, 1)], [1, 2, 1], 'Rose Doolan has a Scope built in, Paul Regret a Mustang');
}

console.log('— BANG! and Missed! —');
{
  const G = rig({ seats: [{ role: 'sheriff', char: 'bart', hand: ['bang', 'bang'] }, { hand: ['missed'] }, { hand: [] }, {}, {}] });
  no(G, 0, { kind: 'play', card: card(G, 0, 'bang'), target: 2 }, 'the Colt .45 reaches distance 1 only');
  shoot(G, 0, 1);
  eq(G.ask && G.ask.kind, 'shot', 'the target is asked for a Missed!');
  go(G, 1, { kind: 'cards', cards: [card(G, 1, 'missed')] });
  eq(P(G, 1).life, 4, 'a Missed! cancels the shot');
  no(G, 0, { kind: 'play', card: card(G, 0, 'bang'), target: 4 }, 'one BANG! a turn');
  const H = rig({ seats: [{ role: 'sheriff', hand: ['bang', 'bang'], table: ['schofield'] }, {}, { hand: [] }, {}, {}] });
  shoot(H, 0, 2);
  eq(P(H, 2).life, 3, 'a Schofield reaches distance 2, and no Missed! means a lost life point');
  const V = rig({ seats: [{ role: 'sheriff', hand: ['bang', 'bang', 'bang'], table: ['volcanic'] }, { hand: [] }, {}, {}, { hand: [] }] });
  shoot(V, 0, 1); shoot(V, 0, 4); shoot(V, 0, 1);
  eq([P(V, 1).life, P(V, 4).life], [2, 3], 'the Volcanic fires any number of BANG!s, at distance 1');
  const W = rig({ seats: [{ role: 'sheriff', char: 'willy', hand: ['bang', 'bang'] }, { hand: [] }, {}, {}, {}] });
  shoot(W, 0, 1); shoot(W, 0, 1);
  eq(P(W, 1).life, 2, 'Willy the Kid fires any number of BANG!s');
  const S = rig({ seats: [{ role: 'sheriff', char: 'slab', hand: ['bang'] }, { hand: ['missed'] }, {}, {}, {}] });
  shoot(S, 0, 1);
  eq([S.ask.kind, P(S, 1).life], ['turn', 3], 'against Slab the Killer one Missed! is not enough');
  const S2 = rig({ seats: [{ role: 'sheriff', char: 'slab', hand: ['bang'] }, { hand: ['missed', 'missed'] }, {}, {}, {}] });
  shoot(S2, 0, 1);
  no(S2, 1, { kind: 'cards', cards: [card(S2, 1, 'missed')] }, 'Slab takes two Missed! to stop');
  go(S2, 1, { kind: 'cards', cards: P(S2, 1).hand.slice() });
  eq(P(S2, 1).life, 4, 'two Missed! stop him');
  const C = rig({ seats: [{ role: 'sheriff', char: 'calamity', hand: ['missed', 'bang'] }, { hand: [] }, { char: 'calamity', hand: ['bang'] }, {}, {}] });
  go(C, 0, { kind: 'play', card: card(C, 0, 'missed'), target: 1 });
  eq(P(C, 1).life, 3, 'Calamity Janet shoots a Missed! as a BANG!');
  no(C, 0, { kind: 'play', card: card(C, 0, 'bang'), target: 1 }, '…and it is her BANG! for the turn');
}

console.log('— Barrel —');
{
  const G = rig({ seats: [{ role: 'sheriff', hand: ['bang'] }, { table: ['barrel'], hand: [] }, {}, {}, {}], top: ['beer:H'] });
  shoot(G, 0, 1);
  eq(P(G, 1).life, 4, 'a Heart from the Barrel and the shot misses');
  const H = rig({ seats: [{ role: 'sheriff', hand: ['bang'] }, { table: ['barrel'], hand: ['missed'] }, {}, {}, {}], top: ['bang:D'] });
  shoot(H, 0, 1);
  eq(H.ask && H.ask.kind, 'shot', 'otherwise a Missed! is still called for');
  const J = rig({ seats: [{ role: 'sheriff', hand: ['bang'] }, { char: 'jourdonnais', table: ['barrel'], hand: [] }, {}, {}, {}], top: ['bang:D', 'beer:H'] });
  shoot(J, 0, 1);
  eq(P(J, 1).life, 4, 'Jourdonnais with a real Barrel draws twice');
  const S = rig({ seats: [{ role: 'sheriff', char: 'slab', hand: ['bang'] }, { table: ['barrel'], hand: ['missed'] }, {}, {}, {}], top: ['beer:H'] });
  shoot(S, 0, 1);
  eq(S.ask && S.ask.need, 1, 'against Slab a lucky Barrel counts as one Missed! (FAQ Q02)');
  const L = rig({ seats: [{ role: 'sheriff', hand: ['bang'] }, { char: 'lucky', table: ['barrel'], hand: [] }, {}, {}, {}], top: ['bang:D', 'beer:H'] });
  shoot(L, 0, 1);
  eq(P(L, 1).life, 4, 'Lucky Duke draws two and keeps the Heart');
}

console.log('— Beer and Saloon —');
{
  const G = rig({ seats: [{ role: 'sheriff', life: 3, hand: ['beer', 'beer', 'beer'] }, {}, {}, {}, {}] });
  go(G, 0, { kind: 'play', card: card(G, 0, 'beer') });
  eq(P(G, 0).life, 4, 'a Beer gives back a life point');
  go(G, 0, { kind: 'play', card: card(G, 0, 'beer') });
  go(G, 0, { kind: 'play', card: card(G, 0, 'beer') });
  eq(P(G, 0).life, 5, 'never above the starting amount');
  const H = rig({ seats: [{ role: 'sheriff', hand: ['bang'] }, { life: 1, hand: ['beer'] }, {}, {}, {}] });
  shoot(H, 0, 1);
  eq([P(H, 1).alive, P(H, 1).life], [true, 1], 'a Beer out of turn saves you from the last life point');
  const T = rig({ seats: [{ role: 'sheriff', hand: ['bang'] }, { life: 1, hand: ['beer'] }, { alive: false }, { alive: false }, { alive: false, role: 'renegade' }] });
  shoot(T, 0, 1);
  eq(P(T, 1).alive, false, 'with two players left a Beer does nothing');
  const S = rig({ seats: [{ role: 'sheriff', life: 2, hand: ['saloon'] }, { life: 1 }, { life: 4 }, {}, {}] });
  go(S, 0, { kind: 'play', card: card(S, 0, 'saloon') });
  eq([P(S, 0).life, P(S, 1).life, P(S, 2).life], [3, 2, 4], 'Saloon: everyone in play regains a point, up to their limit');
}

console.log('— Indians!, Gatling, Duel —');
{
  const G = rig({ seats: [{ role: 'sheriff', hand: ['indians'] }, { hand: ['bang'] }, { hand: ['missed'] }, { char: 'calamity', hand: ['missed'] }, { hand: [] }] });
  go(G, 0, { kind: 'play', card: card(G, 0, 'indians') });
  eq(G.ask && [G.ask.kind, G.ask.seat], ['indians', 1], 'the Indians ask each other player in turn');
  go(G, 1, { kind: 'card', card: card(G, 1, 'bang') });
  go(G, 3, { kind: 'card', card: card(G, 3, 'missed') });
  eq([1, 2, 3, 4].map((s) => P(G, s).life), [4, 3, 4, 3], 'a BANG! turns them away; a Missed! does not — unless you are Calamity Janet');
  const H = rig({ seats: [{ role: 'sheriff', char: 'slab', hand: ['gatling', 'bang'] }, { hand: ['missed'] }, { hand: [] }, {}, {}] });
  go(H, 0, { kind: 'play', card: card(H, 0, 'gatling') });
  go(H, 1, { kind: 'cards', cards: [card(H, 1, 'missed')] });
  eq([P(H, 1).life, P(H, 2).life, P(H, 3).life], [4, 3, 3], 'the Gatling hits everyone else; Slab’s Gatling needs only one Missed! (FAQ Q19)');
  shoot(H, 0, 1);
  eq(P(H, 1).life, 3, 'and a BANG! can still follow it (FAQ Q03)');
  const D = rig({ seats: [{ role: 'sheriff', hand: ['duel', 'bang'] }, {}, {}, { hand: ['bang', 'bang'] }, {}] });
  go(D, 0, { kind: 'play', card: card(D, 0, 'duel'), target: 3 });
  go(D, 3, { kind: 'card', card: card(D, 3, 'bang') });
  go(D, 0, { kind: 'card', card: card(D, 0, 'bang') });
  go(D, 3, { kind: 'card', card: card(D, 3, 'bang') });
  eq([P(D, 0).life, P(D, 3).life], [4, 4], 'the first who cannot discard a BANG! loses the Duel');
  const E = rig({ seats: [{ role: 'sheriff', hand: ['duel', 'bang'] }, {}, { char: 'gringo', hand: [] }, {}, {}] });
  go(E, 0, { kind: 'play', card: card(E, 0, 'duel'), target: 2 });
  eq([P(E, 2).life, P(E, 2).hand.length, P(E, 0).hand.length], [2, 1, 0], 'losing a Duel he was challenged to, El Gringo draws from the challenger');
  const I = rig({ seats: [{ role: 'sheriff', hand: ['indians'] }, { table: ['barrel'] }, {}, {}, {}], top: ['beer:H'] });
  go(I, 0, { kind: 'play', card: card(I, 0, 'indians') });
  eq(P(I, 1).life, 3, 'a Barrel is no help against the Indians — they are not a BANG!');
}

console.log('— General Store, Panic!, Cat Balou, Stagecoach, Wells Fargo —');
{
  const G = rig({ seats: [{ role: 'sheriff', hand: ['generalstore'] }, {}, {}, {}], top: ['bang:D:2', 'beer:H:6', 'missed:C:10', 'panic:H:J'] });
  go(G, 0, { kind: 'play', card: card(G, 0, 'generalstore') });
  eq([G.ask.kind, G.ask.seat, G.store.cards.length], ['store', 0, 4], 'one card per player, the player who opened it choosing first');
  go(G, 0, { kind: 'card', card: G.store.cards.find((id) => G.cards[id].kind === 'beer') });
  eq(G.ask.seat, 1, 'then clockwise');
  go(G, 1, { kind: 'card', card: G.store.cards[0] });
  go(G, 2, { kind: 'card', card: G.store.cards[0] });
  eq([G.store, P(G, 3).hand.length], [null, 1], 'the last card goes to the last player');
  const H = rig({ seats: [{ role: 'sheriff', hand: ['panic', 'panic'], table: ['winchester'] }, { table: ['barrel'] }, { hand: ['beer'] }, {}, {}] });
  no(H, 0, { kind: 'play', card: card(H, 0, 'panic'), target: 2, from: 'hand' }, 'Panic! reaches distance 1, whatever the weapon (FAQ Q04)');
  go(H, 0, { kind: 'play', card: card(H, 0, 'panic'), target: 1, pick: P(H, 1).table[0] });
  eq([kinds(H, P(H, 0).hand).includes('barrel'), P(H, 1).table.length], [true, 0], 'Panic! takes a card in play into your hand');
  const C = rig({ seats: [{ role: 'sheriff', hand: ['catbalou'] }, {}, { hand: ['beer'] }, {}, {}] });
  go(C, 0, { kind: 'play', card: card(C, 0, 'catbalou'), target: 2, from: 'hand' });
  eq([P(C, 2).hand.length, C.cards[C.discard[C.discard.length - 1]].kind], [0, 'beer'], 'Cat Balou discards, at any distance');
  const S = rig({ seats: [{ role: 'sheriff', hand: ['stagecoach', 'wellsfargo'] }, {}, {}, {}] });
  go(S, 0, { kind: 'play', card: card(S, 0, 'stagecoach') });
  go(S, 0, { kind: 'play', card: card(S, 0, 'wellsfargo') });
  eq(P(S, 0).hand.length, 5, 'Stagecoach draws two, Wells Fargo three');
}

console.log('— cards in play —');
{
  const G = rig({ seats: [{ role: 'sheriff', hand: ['barrel', 'barrel', 'remington', 'carabine', 'schofield'] }, {}, {}, {}, {}] });
  go(G, 0, { kind: 'play', card: card(G, 0, 'barrel') });
  no(G, 0, { kind: 'play', card: card(G, 0, 'barrel') }, 'never two cards of the same name in play');
  go(G, 0, { kind: 'play', card: card(G, 0, 'remington') });
  go(G, 0, { kind: 'play', card: card(G, 0, 'carabine') });
  eq([kinds(G, P(G, 0).table), B.rangeOf(G, P(G, 0))], [['barrel', 'carabine'], 4], 'one weapon at a time: a new one replaces the old');
  go(G, 0, { kind: 'play', card: card(G, 0, 'schofield') });
  eq(B.rangeOf(G, P(G, 0)), 2, 'even for a shorter one');
}

console.log('— Jail and Dynamite —');
{
  const G = rig({ seats: [{ role: 'sheriff', hand: ['jail', 'jail'] }, {}, {}, {}, {}] });
  no(G, 0, { kind: 'play', card: card(G, 0, 'jail'), target: 0 }, 'not on yourself');
  go(G, 0, { kind: 'play', card: card(G, 0, 'jail'), target: 3 });
  no(G, 0, { kind: 'play', card: card(G, 0, 'jail'), target: 3 }, 'one Jail per player');
  const S = rig({ seats: [{ role: 'outlaw', hand: ['jail'] }, { role: 'sheriff' }, {}, {}, {}] });
  no(S, 0, { kind: 'play', card: card(S, 0, 'jail'), target: 1 }, '"Jail cannot be played on the Sheriff"');
  const J = rig({ seats: [{ role: 'sheriff' }, { table: ['jail'] }, {}, {}, {}], top: ['bang:D'] });
  go(J, 0, { kind: 'end' });
  eq([J.turn, P(J, 1).table.length], [2, 0], 'no Heart: the Jail is discarded and the turn skipped');
  const K = rig({ seats: [{ role: 'sheriff' }, { table: ['jail'] }, {}, {}, {}], top: ['beer:H'] });
  go(K, 0, { kind: 'end' });
  eq([K.turn, K.ask.seat, P(K, 1).table.length], [1, 1, 0], 'a Heart: out of Jail, and the turn goes on');
  const D = rig({ seats: [{ role: 'sheriff' }, { table: ['dynamite'], hand: [] }, {}, {}, {}], top: ['missed:S:4'] });
  go(D, 0, { kind: 'end' });
  eq([P(D, 1).life, P(D, 1).table.length], [1, 0], 'Spades 2–9: the Dynamite explodes for 3');
  const E = rig({ seats: [{ role: 'sheriff' }, { table: ['dynamite'] }, {}, {}, {}], top: ['beer:H'] });
  go(E, 0, { kind: 'end' });
  eq([P(E, 1).life, kinds(E, P(E, 2).table)], [4, ['dynamite']], 'otherwise it passes to the left');
  const F = rig({ seats: [{ role: 'sheriff' }, { table: ['dynamite', 'jail'] }, {}, {}, {}], top: ['beer:H', 'missed:S:3'] });
  go(F, 0, { kind: 'end' });
  eq([P(F, 1).life, F.turn], [4, 2], 'with both, the Dynamite is checked first');
  const B2 = rig({ seats: [{ role: 'sheriff' }, { char: 'bart', table: ['dynamite'], hand: [] }, {}, {}, {}], top: ['missed:S:5'] });
  go(B2, 0, { kind: 'end' });
  eq(P(B2, 1).hand.length >= 3, true, 'Bart Cassidy draws three for a Dynamite he survives (FAQ Q24)');
}

console.log('— elimination, rewards and penalties —');
{
  const G = rig({ seats: [{ role: 'sheriff', hand: ['bang'] }, { role: 'outlaw', life: 1, hand: ['missed'], table: ['scope'] }, {}, {}, {}] });
  shoot(G, 0, 1);
  go(G, 1, { kind: 'take' });
  eq([P(G, 1).alive, P(G, 1).hand.length + P(G, 1).table.length, P(G, 0).hand.length], [false, 0, 3], 'killing an Outlaw: their cards are discarded and the killer draws three');
  const H = rig({ seats: [{ role: 'sheriff', hand: ['bang', 'beer'], table: ['scope'] }, { role: 'deputy', life: 1, hand: [] }, {}, {}, {}] });
  shoot(H, 0, 1);
  eq([P(H, 0).hand.length, P(H, 0).table.length], [0, 0], 'the Sheriff who kills a Deputy discards everything');
  const V = rig({ seats: [{ role: 'sheriff', hand: ['bang'] }, { role: 'outlaw', life: 1, hand: ['beer:H:6'].slice(0, 0), table: ['barrel'] }, {}, { char: 'vulture' }, {}], top: ['bang:D'] });
  shoot(V, 0, 1);
  eq(kinds(V, P(V, 3).hand).includes('barrel'), true, 'Vulture Sam takes the eliminated player’s cards');
  const Q = rig({ seats: [{ role: 'sheriff' }, { role: 'outlaw', life: 2, table: ['dynamite'], hand: [] }, {}, { char: 'vulture' }, {}], top: ['missed:S:6'] });
  go(Q, 0, { kind: 'end' });
  eq([P(Q, 1).alive, kinds(Q, P(Q, 3).hand).includes('dynamite')], [false, false], 'the exploded Dynamite is discarded before Vulture Sam gets there (FAQ Q14)');
  eq(P(Q, 0).hand.length, 0, 'no one is rewarded for a Dynamite death');
  const O = rig({ seats: [{ role: 'outlaw', hand: ['duel'] }, { role: 'sheriff', hand: ['bang'] }, {}, {}, {}] });
  P(O, 0).life = 1;
  go(O, 0, { kind: 'play', card: card(O, 0, 'duel'), target: 1 });
  go(O, 1, { kind: 'card', card: card(O, 1, 'bang') });
  eq([P(O, 0).alive, O.log.some((l) => /reward/.test(l.text))], [false, false], 'an Outlaw who loses his own Duel rewards no one (FAQ Q23)');
  const N = rig({ seats: [{ role: 'deputy', hand: ['indians'] }, { role: 'sheriff' }, { role: 'outlaw', life: 1 }, {}, {}] });
  go(N, 0, { kind: 'play', card: card(N, 0, 'indians') });
  eq([P(N, 2).alive, P(N, 0).hand.length], [false, 3], 'whoever played the Indians collects for the Outlaw they kill (FAQ Q05)');
  const Vs = rig({ seats: [{ role: 'sheriff', char: 'vulture', hand: ['bang'] }, { role: 'deputy', life: 1, hand: ['beer:H:6'].slice(0, 0), table: ['mustang:H:8'].slice(0, 0) }, {}, {}, {}] });
  P(Vs, 1).hand = [Vs.deck.pop()];
  shoot(Vs, 0, 1);
  eq([P(Vs, 1).alive, P(Vs, 0).hand.length, P(Vs, 0).table.length], [false, 0, 0], 'Vulture Sam as Sheriff takes the Deputy’s cards, then discards everything (FAQ Q18)');
  const Bt = rig({ seats: [{ role: 'sheriff', hand: ['bang'] }, { char: 'bart', life: 1, hand: ['beer'] }, {}, {}, {}] });
  shoot(Bt, 0, 1);
  eq([P(Bt, 1).alive, P(Bt, 1).life, P(Bt, 1).hand.length], [true, 1, 1], 'Bart Cassidy saved by a Beer still draws for the wound (FAQ Q17)');
}

console.log('— the end —');
{
  const G = rig({ seats: [{ role: 'outlaw', hand: ['bang'] }, { role: 'sheriff', life: 1, hand: [] }, { role: 'renegade' }, {}, {}] });
  shoot(G, 0, 1);
  eq([G.phase, G.winner], ['over', 'outlaws'], 'the Sheriff dead and others alive: the Outlaws win');
  const R = rig({ seats: [{ role: 'renegade', hand: ['bang'] }, { role: 'sheriff', life: 1, hand: [] }, { alive: false }, { alive: false }, { alive: false, role: 'deputy' }] });
  shoot(R, 0, 1);
  eq(R.winner, 'renegade', 'the Sheriff dead with only the Renegade alive: the Renegade wins');
  const L = rig({ seats: [{ role: 'sheriff', hand: ['bang'] }, { role: 'renegade', life: 1, hand: [] }, { role: 'outlaw', alive: false }, { role: 'outlaw', alive: false }, { role: 'deputy' }] });
  shoot(L, 0, 1);
  eq(L.winner, 'law', 'every Outlaw and the Renegade dead: the Sheriff and his Deputies win');
  const Z = rig({ seats: [{ role: 'renegade', hand: ['bang'] }, { role: 'sheriff', life: 1, hand: [] }, { role: 'outlaw', alive: false }, { role: 'outlaw', alive: false }, { role: 'deputy' }] });
  shoot(Z, 0, 1);
  eq(Z.winner, 'outlaws', 'the Sheriff dead with a Deputy still standing: the Outlaws win, though every one of them is dead');
}

console.log('— characters —');
{
  const G = rig({ seats: [{ role: 'sheriff', hand: ['bang'] }, { char: 'bart', hand: [] }, {}, {}, {}] });
  shoot(G, 0, 1);
  eq(P(G, 1).hand.length, 1, 'Bart Cassidy draws a card for each life point lost');
  const E = rig({ seats: [{ role: 'sheriff', hand: ['bang', 'beer'] }, { char: 'gringo', hand: [] }, {}, {}, {}] });
  shoot(E, 0, 1);
  eq([P(E, 1).hand.length, P(E, 0).hand.length], [1, 0], 'El Gringo draws a card from the shooter’s hand');
  const J = rig({ seats: [{ role: 'sheriff' }, { char: 'blackjack', hand: [] }, {}, {}, {}], top: ['bang:C', 'beer:H'] });
  go(J, 0, { kind: 'end' });
  eq(P(J, 1).hand.length, 3, 'Black Jack shows a red second card and draws one more');
  const K = rig({ seats: [{ role: 'sheriff' }, { char: 'kit', hand: [] }, {}, {}, {}], top: ['bang:C', 'beer:H', 'missed:S'] });
  go(K, 0, { kind: 'end' });
  eq([K.ask.kind, K.look.length], ['kit', 3], 'Kit Carlson looks at the top three');
  const back = K.look.find((id) => K.cards[id].kind === 'bang');
  go(K, 1, { keep: K.look.filter((id) => id !== back) });
  eq([kinds(K, P(K, 1).hand).sort(), K.deck[K.deck.length - 1]], [['beer', 'missed'], back], 'keeps two, and the third goes back on top');
  const Jj = rig({ seats: [{ role: 'sheriff', hand: ['beer'] }, { char: 'jesse', hand: [] }, {}, {}, {}] });
  go(Jj, 0, { kind: 'end' });
  go(Jj, 1, { from: 0 });
  eq([P(Jj, 1).hand.length, P(Jj, 0).hand.length], [2, 0], 'Jesse Jones draws his first card from another player’s hand');
  const Pe = rig({ seats: [{ role: 'sheriff' }, { char: 'pedro', hand: [] }, {}, {}, {}], discard: ['beer'] });
  go(Pe, 0, { kind: 'end' });
  go(Pe, 1, { from: 'discard' });
  eq(kinds(Pe, P(Pe, 1).hand).includes('beer'), true, 'Pedro Ramirez draws his first card from the discard pile');
  const Sd = rig({ seats: [{ role: 'sheriff', char: 'sid', life: 3, hand: ['bang', 'missed'] }, {}, {}, {}, {}] });
  go(Sd, 0, { kind: 'sid', cards: P(Sd, 0).hand.slice() });
  eq([P(Sd, 0).life, P(Sd, 0).hand.length], [4, 0], 'Sid Ketchum discards two cards for a life point');
  const Sd2 = rig({ seats: [{ role: 'sheriff', hand: ['bang'] }, { char: 'sid', life: 1, hand: ['panic', 'duel', 'gatling'] }, {}, {}, {}] });
  shoot(Sd2, 0, 1);
  eq(Sd2.ask && Sd2.ask.kind, 'dying', 'Sid can save himself out of turn, too (FAQ Q26)');
  go(Sd2, 1, { kind: 'sid', cards: P(Sd2, 1).hand.slice(0, 2) });
  eq([P(Sd2, 1).alive, P(Sd2, 1).life], [true, 1], '…and does');
  const Su = rig({ seats: [{ role: 'sheriff', hand: ['bang'] }, { char: 'suzy', hand: ['missed'] }, {}, {}, {}] });
  shoot(Su, 0, 1);
  go(Su, 1, { kind: 'cards', cards: [card(Su, 1, 'missed')] });
  eq(P(Su, 1).hand.length, 1, 'Suzy Lafayette draws as soon as her hand is empty');
  const Su2 = rig({ seats: [{ role: 'sheriff', char: 'suzy', hand: ['duel'] }, {}, { hand: ['bang'] }, {}, {}] });
  go(Su2, 0, { kind: 'play', card: card(Su2, 0, 'duel'), target: 2 });
  eq(Su2.ask && Su2.ask.kind === 'duel' && P(Su2, 0).hand.length, 0, 'but not in the middle of her own Duel (FAQ Q22)');
}

console.log('— the turn —');
{
  const G = rig({ seats: [{ role: 'sheriff', life: 2, hand: ['bang', 'beer', 'missed', 'panic', 'duel'] }, {}, {}, {}, {}] });
  go(G, 0, { kind: 'end' });
  eq([G.ask.kind, G.ask.n], ['discard', 3], 'discard down to your life points at the end of the turn');
  go(G, 0, { cards: P(G, 0).hand.slice(0, 3) });
  eq([P(G, 0).hand.length, G.turn], [2, 1], 'then the next player clockwise');
  const D = rig({ seats: [{ role: 'sheriff', hand: ['stagecoach'] }, {}, {}, {}, {}] });
  D.discard = D.deck.splice(0, D.deck.length - 1);
  go(D, 0, { kind: 'play', card: card(D, 0, 'stagecoach') });
  eq(P(D, 0).hand.length, 2, 'an empty draw pile is made again from the discards');
}

console.log(`\n${checks} checks` + (fails ? `, ${fails} FAILURES` : ', all pass'));
process.exit(fails ? 1 : 0);
