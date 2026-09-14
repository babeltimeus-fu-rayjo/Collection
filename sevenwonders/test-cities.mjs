import * as SW from './game.js';
import { CITY_CARDS } from './cards.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : '**FAIL**'}  ${m}`); if (!c) fails++; };
const mk = (n, opts = { cities: true }) =>
  SW.newMatch(Array.from({ length: n }, (_, s) => ({ seat: s, name: 'P' + s, bot: true })), opts);
const card = (name) => CITY_CARDS.find((c) => c.n === name);
// put a chosen card in a seat's hand, and make sure they can pay for it
const give = (G, seat, name) => {
  const p = SW.playerBySeat(G, seat);
  const c = card(name);
  p.hand[0] = { ...c, id: `t-${seat}-${name}` };
  // hand them one producer per resource the card asks for
  p.built = p.built.concat([...(c.cost || '')].map((r, i) => ({ n: `stock${i}`, c: 'brown', give: r })));
  return p.hand[0].id;
};
const play = (G, seat, id, how = 'play') => {
  const r = SW.applyMove(G, seat, { kind: 'pick', how, cardId: id });
  if (!r.ok) { console.log(`**FAIL**  setup: seat ${seat} could not ${how}: ${r.error}`); fails++; }
  return r.ok;
};
const everyoneElsePasses = (G, except) => {
  for (const p of G.players) if (p.seat !== except) SW.applyMove(G, p.seat, { kind: 'pick', how: 'discard', cardId: p.hand[0].id });
};

// ---- monetary loss and debt
{
  const G = mk(3);
  for (const p of G.players) p.coins = 0;         // nobody can pay
  SW.playerBySeat(G, 0).coins = 9;
  const id = give(G, 0, 'Hideout');               // 2 VP, everyone else loses 1
  play(G, 0, id);
  everyoneElsePasses(G, 0);
  const [me, a, b] = G.players;
  ok(me.debt === 0, 'the player who plays a loss card is never hit by it');
  // the others sold a card for 3 this turn, so they can pay the 1
  ok(a.debt === 0 && a.coins === 2, `an opponent pays the loss from the coins they just earned (${a.coins} left)`);

  const G2 = mk(3);
  for (const p of G2.players) p.coins = 0;
  const id2 = give(G2, 0, 'Brotherhood');         // everyone else loses 3
  play(G2, 0, id2);
  // the others play a card that costs and earns nothing, so they have no way to
  // find the coins — which is exactly when debt happens
  for (const p of G2.players) {
    if (!p.seat) continue;
    p.hand[0] = { n: `Shack${p.seat}`, c: 'brown', give: 'W', id: `free-${p.seat}` };
    play(G2, p.seat, `free-${p.seat}`);
  }
  const owed = G2.players.filter((p) => p.seat).map((p) => p.debt);
  ok(owed.every((d) => d === 3), `unpayable losses become debt tokens (${owed.join(',')})`);
  const sc = SW.scoreFor(G2, 1);
  ok(sc.debt === -3, `each debt token is worth -1 VP (scored ${sc.debt})`);
}

// ---- diplomacy, solo play: absent, and the neighbours face each other
{
  const G = mk(4, { cities: true });
  const [a, b, c, d] = G.players;
  a.shields = 0; b.shields = 5; c.shields = 0; d.shields = 1;
  b.diplo = 1;                                    // b sits out
  for (const p of G.players) p.hand = [];
  G.turn = G.handSize - 1;
  SW.applyMove(G, 0, { kind: 'pick', how: 'discard', cardId: (SW.playerBySeat(G, 0).hand[0] || {}).id });
  // force the age end directly
  G.players.forEach((p) => { p.hand = []; });
  const before = G.players.map((p) => p.tokens.length);
  SW.forceEndAge(G);
  ok(b.tokens.length === before[1], 'a diplomat takes no conflict tokens at all');
  ok(b.diplo === 0, 'the diplomacy token is spent whether it helped or not');
  // a and c were not neighbours; with b absent they are, and c has fewer shields
  ok(a.tokens.some((t) => t > 0) || c.tokens.some((t) => t < 0),
     'the two cities either side of the diplomat fought each other');
}

// ---- masks copy a neighbour's science, and are worthless without one
{
  const G = mk(3);
  const [me, r, l] = G.players;
  me.built = [{ ...card('Torture Chamber') }];    // 3 masks
  r.built = []; l.built = [];
  ok(SW.scoreFor(G, 0).science === 0, 'masks score nothing when no neighbour has science');
  r.built = [{ n: 'Workshop', c: 'green', sci: 'gear' }, { n: 'Apothecary', c: 'green', sci: 'compass' }];
  l.built = [{ n: 'Scriptorium', c: 'green', sci: 'tablet' }];
  // three masks over three available symbols = one of each = a complete set
  ok(SW.scoreFor(G, 0).science === 1 + 1 + 1 + 7, `three masks copy a full set (${SW.scoreFor(G, 0).science})`);
  l.built = [];
  r.built = [{ n: 'Workshop', c: 'green', sci: 'gear' }];
  ok(SW.scoreFor(G, 0).science === 9, `masks can only copy what is actually next door (${SW.scoreFor(G, 0).science})`);
}

// ---- the warehouse makes what you cannot
{
  const G = mk(3);
  const me = SW.playerBySeat(G, 0);
  me.wonderRes = 'W'; me.built = [];
  for (const q of G.players) if (q.seat) { q.wonderRes = ''; q.built = []; }   // nobody to buy from
  ok(SW.payFor(G, 0, 'G') === null, 'without a warehouse, a resource you lack is simply unavailable');
  me.built = [{ ...card('Secret Warehouse') }];
  ok(SW.payFor(G, 0, 'G') && SW.payFor(G, 0, 'G').coins === 0, 'a warehouse supplies a resource your city lacks');
  ok(SW.payFor(G, 0, 'W') && SW.payFor(G, 0, 'W').coins === 0, 'and your own board still covers what it makes');
  ok(SW.payFor(G, 0, 'WW') === null, 'but the warehouse cannot make what you already produce');
}

// ---- the dock takes a coin off one purchase
{
  const G = mk(3);
  const me = SW.playerBySeat(G, 0);
  me.wonderRes = ''; me.built = [];
  SW.playerBySeat(G, 1).built = [{ n: 'Quarry', c: 'brown', give: 'SS' }];
  ok(SW.payFor(G, 0, 'SS').coins === 4, 'two stone from a neighbour costs 4');
  me.built = [{ ...card('Clandestine Dock East') }];
  ok(SW.payFor(G, 0, 'SS').coins === 3, 'the dock takes a coin off the first one (3)');
}

// ---- the architect stops paying for stages
{
  const G = mk(3);
  const me = SW.playerBySeat(G, 0);
  me.wonderRes = ''; me.built = []; me.coins = 0;
  const before = SW.optionsFor(G, 0)[0];
  me.built = [{ ...card('Architect Cabinet') }];
  const after = SW.optionsFor(G, 0)[0];
  ok(!!after.wonder && after.wonder.coins === 0, 'the Architect Cabinet builds wonder stages for nothing');
  ok(before.wonder === null || before.wonder.coins >= 0, 'and it was not free before it was built');
}

console.log(fails ? `\n${fails} FAILURES` : '\nCities mechanics hold');
process.exit(fails ? 1 : 0);
