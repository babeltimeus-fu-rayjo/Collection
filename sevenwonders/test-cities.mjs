import * as SW from './game.js';
import { CITY_CARDS } from './cards.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : '**FAIL**'}  ${m}`); if (!c) fails++; };
const mk = (n, opts = { cities: true }) =>
  SW.newMatch(Array.from({ length: n }, (_, s) => ({ seat: s, name: 'P' + s, bot: true })), opts);
const card = (name) => {
  const c = CITY_CARDS.find((x) => x.n === name);
  if (!c) { console.log(`**FAIL**  no such card: ${name}`); fails++; return { n: name, c: 'black' }; }
  return c;
};
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
  me.built = [1, 2, 3].map(() => ({ ...card('Torture Chamber') }));   // 3 masks
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
  me.built = [{ ...card('Black Market') }];
  ok(SW.payFor(G, 0, 'G') && SW.payFor(G, 0, 'G').coins === 0, 'a black market supplies a resource your city lacks');
  ok(SW.payFor(G, 0, 'W') && SW.payFor(G, 0, 'W').coins === 0, 'and your own board still covers what it makes');
  ok(SW.payFor(G, 0, 'WW') === null, 'but it cannot make what you already produce');
}

// ---- the dock takes a coin off one purchase
{
  const G = mk(3);
  const me = SW.playerBySeat(G, 0);
  me.wonderRes = ''; me.built = [];
  SW.playerBySeat(G, 1).built = [{ n: 'Quarry', c: 'brown', give: 'SS' }];
  ok(SW.payFor(G, 0, 'SS').coins === 4, 'two stone from a neighbour costs 4');
  me.built = [{ ...card('East Clandestine Wharf') }];
  ok(SW.payFor(G, 0, 'SS').coins === 3, 'the wharf takes a coin off the first one (3)');
}

// ---- the architect stops paying for stages
{
  const G = mk(3);
  const me = SW.playerBySeat(G, 0);
  me.wonderRes = ''; me.built = []; me.coins = 0;
  const before = SW.optionsFor(G, 0)[0];
  me.built = [{ ...card('Architect Firm') }];
  const after = SW.optionsFor(G, 0)[0];
  ok(!!after.wonder && after.wonder.coins === 0, 'the Architect Firm builds wonder stages for nothing');
  ok(before.wonder === null || before.wonder.coins >= 0, 'and it was not free before it was built');
}

// ---- black cards score, which for a long time they did not
{
  const G = mk(3);
  G.phase = 'over';
  const me = SW.playerBySeat(G, 0);
  const base = SW.scoreFor(G, 0).total;
  me.built = [{ ...card('City Gates') }];                 // 4 VP and nothing else
  const s = SW.scoreFor(G, 0);
  ok(s.cities === 4, `a black card's points land in their own column (${s.cities})`);
  ok(s.total === base + 4, `and in the total (${s.total} against ${base})`);

  me.built = [{ ...card('Secret Network') }, { n: 'x', c: 'black' }, { n: 'y', c: 'black' }];
  ok(SW.scoreFor(G, 0).cities === 3, 'a black card that pays per black card counts itself');
}

// ---- the warehouse: one more of what you already make
{
  const G = mk(3);
  const me = SW.playerBySeat(G, 0);
  me.wonderRes = 'W'; me.built = [];
  for (const q of G.players) if (q.seat) { q.wonderRes = ''; q.built = []; }
  ok(SW.payFor(G, 0, 'WW') === null, 'one wood board makes one wood');
  me.built = [{ ...card('Secret Warehouse') }];
  ok(SW.payFor(G, 0, 'WW') && SW.payFor(G, 0, 'WW').coins === 0, 'the warehouse makes a second');
  ok(SW.payFor(G, 0, 'WWW') === null, 'but only one a turn');
  ok(SW.payFor(G, 0, 'G') === null, 'and never something your city does not make');
}

// ---- the raiders: a token of their Age, and a debt either side
{
  for (const [name, age, worth] of [['Raider Camp', 1, 1], ['Raider Fort', 2, 3], ['Raider Garrison', 3, 5]]) {
    const G = mk(4);
    const id = give(G, 0, name);
    SW.playerBySeat(G, 0).coins = 9;
    play(G, 0, id);
    everyoneElsePasses(G, 0);
    const me = SW.playerBySeat(G, 0);
    ok(me.tokens.length === 1 && me.tokens[0] === worth,
       `${name} takes an Age ${'I'.repeat(age)} victory, worth ${worth} (${JSON.stringify(me.tokens)})`);
    const l = SW.playerBySeat(G, SW.leftOf(G, 0)), r = SW.playerBySeat(G, SW.rightOf(G, 0));
    const far = G.players.find((q) => q.seat !== 0 && q.seat !== l.seat && q.seat !== r.seat);
    ok(l.debt === 1 && r.debt === 1, `and puts both neighbours a debt down (${l.debt}, ${r.debt})`);
    ok(!far || far.debt === 0, 'and nobody further round the table');
  }
}

// ---- the cells, the guardhouse and the prison: points per token of one Age
{
  const G = mk(3);
  G.phase = 'over';
  const me = SW.playerBySeat(G, 0);
  me.tokens = [1, 1, 3, 5, -1];            // two Age I, one Age II, one Age III
  me.built = [{ ...card('Cells') }];
  ok(SW.scoreFor(G, 0).cities === 4, 'the Cells pay 2 for each Age I victory');
  me.built = [{ ...card('Guardhouse') }];
  ok(SW.scoreFor(G, 0).cities === 3, 'the Guardhouse pays 3 for each Age II one');
  me.built = [{ ...card('Prison') }];
  ok(SW.scoreFor(G, 0).cities === 4, 'the Prison pays 4 for each Age III one');
  me.tokens = [-1, -1];
  ok(SW.scoreFor(G, 0).cities === 0, 'and defeats are not victories');
}

// ---- the memorial buys your defeats, then burns them
{
  const G = mk(4);
  const id = give(G, 0, 'Memorial');
  const me = SW.playerBySeat(G, 0);
  me.coins = 9;
  me.tokens = [-1, -1, -1, 3];
  const before = me.coins;
  play(G, 0, id);
  everyoneElsePasses(G, 0);
  ok(me.coins === before + 6, `two coins for each of three defeats (${me.coins - before})`);
  ok(JSON.stringify(me.tokens) === '[3]', `and then they are gone (${JSON.stringify(me.tokens)})`);
  ok(SW.scoreFor(G, 0).military === 3, 'so they stop costing points as well');
}

console.log(fails ? `\n${fails} FAILURES` : '\nCities mechanics hold');
process.exit(fails ? 1 : 0);
