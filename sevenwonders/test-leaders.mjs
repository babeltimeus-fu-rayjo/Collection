// The Leaders expansion: the two extra phases, and the leaders whose effects
// are not just a number on a card. Run with `node test-leaders.mjs`.
import * as SW from './game.js';
import { LEADERS, START_COINS, START_COINS_LEADERS } from './cards.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : '**FAIL**'}  ${m}`); if (!c) fails++; };

const mk = (n, opts = {}) =>
  SW.newMatch(Array.from({ length: n }, (_, s) => ({ seat: s, name: 'P' + s, bot: true })), { leaders: true, ...opts });

const lead = (name) => {
  const l = LEADERS.find((x) => x.n === name);
  if (!l) { console.log(`**FAIL**  no such leader: ${name}`); fails++; return { n: name, c: 'white' }; }
  return { ...l, c: 'white', id: `L-${name}` };
};

// A game parked at the start of an Age's recruitment, with chosen leaders in
// hand instead of drafted ones.
function atRecruit(n, age, hands, opts = {}) {
  const G = mk(n, opts);
  for (const p of G.players) { p.draft = []; p.leaders = []; }
  G.age = age;
  G.phase = 'recruit';
  G.picks = {};
  hands.forEach((names, seat) => { SW.playerBySeat(G, seat).leaders = names.map(lead); });
  return G;
}

// everyone plays at once, so nothing resolves until the last player has chosen
function allRecruit(G, choices) {
  for (const p of G.players) {
    const c = choices[p.seat] || { name: p.leaders[0].n, how: 'discard' };
    const r = SW.applyMove(G, p.seat, { kind: 'pick', how: c.how || 'play', cardId: `L-${c.name}` });
    if (!r.ok) { console.log(`**FAIL**  setup: seat ${p.seat} could not ${c.how || 'play'} ${c.name}: ${r.error}`); fails++; }
  }
}

const drive = (G, until = () => G.phase === 'over') => {
  let guard = 0;
  while (!until() && G.phase !== 'over') {
    if (++guard > 5000) throw new Error('stuck in ' + G.phase);
    for (const seat of SW.waitingOn(G)) {
      const m = SW.botChoose(G, seat);
      if (m) SW.applyMove(G, seat, m);
      if (until() || G.phase === 'over') break;
    }
  }
  return G;
};

// ---- setup and the two new phases
{
  const G = mk(4);
  ok(G.phase === 'draft', 'a Leaders game opens on the draft, not on Age I');
  ok(G.players.every((p) => p.coins === START_COINS_LEADERS), `everyone starts on ${START_COINS_LEADERS} coins, not ${START_COINS}`);
  ok(G.players.every((p) => p.draft.length === 4), 'four leaders are dealt to each player');
  ok(G.players.every((p) => !p.hand.length), 'and no Age cards yet — recruitment comes first');

  // the draft passes to the RIGHT: after a round, your hand came from your left
  G.players.forEach((p) => p.draft.forEach((c) => { c.from = p.seat; }));
  for (const p of G.players) SW.applyMove(G, p.seat, { kind: 'draft', cardId: p.draft[0].id });
  const mine = SW.playerBySeat(G, 0);
  ok(mine.draft.length === 3 && mine.draft.every((c) => c.from === SW.leftOf(G, 0)),
     'what is left passes to the right, so your next hand comes from your left');
  ok(mine.leaders.length === 1, 'and the one you kept is yours');

  drive(G, () => G.phase === 'recruit');
  ok(G.players.every((p) => p.leaders.length === 4), 'the draft ends with four leaders each');
  ok(G.players.every((p) => !p.draft.length), 'and nothing left going round');
  ok(G.age === 1 && G.phase === 'recruit', 'Age I opens on recruitment');
  ok(G.players.every((p) => !p.hand.length), 'the Age cards are dealt after recruitment, not before');
  drive(G, () => G.phase === 'play');
  ok(G.players.every((p) => p.hand.length === G.handSize), 'and then the Age is dealt as usual');
}

// ---- three Ages against four leaders
{
  const G = drive(mk(4));
  ok(G.players.every((p) => p.leaders.length === 1), 'one leader is never played: three Ages, four leaders');
  ok(G.players.every((p) => p.built.filter((c) => c.c === 'white').length <= 3), 'and at most three are recruited');
}

// ---- the Cities six stay in the box unless Cities is on
{
  const cityLeaders = new Set(LEADERS.filter((l) => l.set === 'cities').map((l) => l.n));
  let seen = 0;
  for (let i = 0; i < 20; i++) {
    for (const p of mk(7).players) for (const c of p.draft) if (cityLeaders.has(c.n)) seen++;
  }
  ok(seen === 0, 'the six Cities leaders are not dealt in a game without Cities');
  let withCities = 0;
  for (let i = 0; i < 20; i++) {
    for (const p of mk(7, { cities: true }).players) for (const c of p.draft) if (cityLeaders.has(c.n)) withCities++;
  }
  ok(withCities > 0, `and they are dealt when it is (${withCities} sightings in 20 deals)`);
}

// ---- a cost that is the Age, and Maecenas paying it for you
{
  for (const age of [1, 2, 3]) {
    const G = atRecruit(3, age, [['Cynisca'], ['Cynisca'], ['Cynisca']]);
    const o = SW.leaderOptionsFor(G, 0)[0];
    ok(o.play.coins === age, `an Age-priced leader costs ${age} in Age ${'I'.repeat(age)}`);
  }
  const G = atRecruit(3, 2, [['Cleopatra'], ['Sappho'], ['Sappho']]);
  SW.playerBySeat(G, 0).built = [lead('Maecenas')];
  ok(SW.leaderOptionsFor(G, 0)[0].play.coins === 0, 'Maecenas recruits every later leader for nothing');
}

// ---- pay one fewer resource
{
  const G = atRecruit(3, 1, [[], [], []]);
  G.phase = 'play';
  const me = SW.playerBySeat(G, 0);
  me.wonderRes = ''; me.built = []; me.coins = 20;
  for (const q of G.players) if (q.seat) { q.built = [{ n: 'Quarry', c: 'brown', give: 'SS' }]; }
  me.hand = [{ n: 'Aqueduct', c: 'blue', cost: 'SSS', id: 'x1' }];
  ok(SW.optionsFor(G, 0)[0].play.coins === 6, 'three stone off the neighbours costs 6');
  me.built = [lead('Hammurabi')];
  ok(SW.optionsFor(G, 0)[0].play.coins === 4, 'Hammurabi takes one stone off a blue card (4)');
  me.hand = [{ n: 'Walls', c: 'red', cost: 'SSS', id: 'x2' }];
  ok(SW.optionsFor(G, 0)[0].play.coins === 6, 'and does nothing for a red one');

  // the dropped resource is the dearest, not the first
  me.built = [lead('Hammurabi'), { n: 'Pit', c: 'brown', give: 'C' }];
  me.hand = [{ n: 'Temple', c: 'blue', cost: 'CCS', id: 'x3' }];
  const bill = SW.optionsFor(G, 0)[0].play;
  ok(bill.coins === 2, `the discount drops the resource you would have had to buy (${bill.coins})`);
}

// ---- free colours
{
  const G = atRecruit(3, 1, [[], [], []]);
  G.phase = 'play';
  const me = SW.playerBySeat(G, 0);
  me.wonderRes = ''; me.built = []; me.coins = 0;
  me.hand = [{ n: 'Workers Guild', c: 'purple', cost: 'OOCSW', id: 'g1' }];
  ok(SW.optionsFor(G, 0)[0].play === null, 'a guild you cannot pay for is out of reach');
  me.built = [lead('Ramses')];
  ok(SW.optionsFor(G, 0)[0].play.coins === 0, 'Ramses builds every guild for nothing');
}

{
  const G = atRecruit(4, 1, [[], [], [], []], { cities: true });
  G.phase = 'play';
  const me = SW.playerBySeat(G, 0);
  me.wonderRes = ''; me.built = [lead('Caligula')]; me.coins = 0;
  const black = (id) => ({ n: `Lair${id}`, c: 'black', cost: 'GW', id });
  me.hand = [black('b1'), black('b2')];
  // the other three just need something to throw away so the turn resolves
  for (const q of G.players) if (q.seat) q.hand = [{ n: `Junk${q.seat}`, c: 'brown', give: 'W', id: `j${q.seat}` }];
  ok(SW.optionsFor(G, 0).every((o) => o.play && o.play.coins === 0), 'Caligula offers a free black card');
  SW.applyMove(G, 0, { kind: 'pick', how: 'play', cardId: 'b1' });
  for (const q of G.players) if (q.seat) SW.applyMove(G, q.seat, { kind: 'pick', how: 'discard', cardId: q.hand[0].id });
  me.hand = [black('b3')];                     // the turn passed the old hand on
  ok(SW.optionsFor(G, 0).every((o) => !o.play), 'but only one an Age');
  G.age = 2;
  ok(SW.optionsFor(G, 0).some((o) => o.play && o.play.coins === 0), 'and it comes back next Age');
}

// ---- buying from the bank, and being paid for buying from a neighbour
{
  const G = atRecruit(3, 1, [[], [], []]);
  G.phase = 'play';
  const me = SW.playerBySeat(G, 0);
  for (const q of G.players) { q.wonderRes = ''; q.built = []; }   // nothing exists
  ok(SW.payFor(G, 0, 'S') === null, 'a resource nobody makes cannot be had');
  me.built = [lead('Bilkis')];
  ok(SW.payFor(G, 0, 'S').coins === 1, 'Bilkis buys it from the bank for 1');
  ok(SW.payFor(G, 0, 'SS') === null, 'but only one a turn');

  // Hapshepsut is a coin back per neighbour, so make the bill need both of
  // them: the left sells stone and the right sells clay, one each.
  const H = atRecruit(3, 1, [[], [], []]);
  H.phase = 'play';
  const you = SW.playerBySeat(H, 0);
  for (const q of H.players) { q.wonderRes = ''; q.built = []; }
  SW.playerBySeat(H, SW.leftOf(H, 0)).built = [{ n: 'Pit', c: 'brown', give: 'S' }];
  SW.playerBySeat(H, SW.rightOf(H, 0)).built = [{ n: 'Pool', c: 'brown', give: 'C' }];
  ok(SW.payFor(H, 0, 'SC').coins === 4, 'one resource from each neighbour costs 4');
  you.built = [lead('Hapshepsut')];
  const bill = SW.payFor(H, 0, 'SC');
  ok(bill.coins === 2, `Hapshepsut hands a coin back from each of them (${bill.coins})`);
}

// ---- Berenice takes one more, once
{
  const G = atRecruit(3, 1, [['Sappho'], ['Sappho'], ['Sappho']]);
  const me = SW.playerBySeat(G, 0);
  me.built = [lead('Berenice')];
  const before = me.coins;
  allRecruit(G, { 0: { name: 'Sappho', how: 'discard' } });
  ok(me.coins === before + 4, `selling for 3 pays Berenice's holder 4 (${me.coins - before})`);
}

// ---- military: a token for nothing, a fee for each one, and one posted back
{
  const G = atRecruit(3, 2, [['Nitocris'], ['Sappho'], ['Sappho']]);
  const me = SW.playerBySeat(G, 0);
  me.built = [lead('Nero')];
  const coins = me.coins;
  allRecruit(G, { 0: { name: 'Nitocris' } });
  ok(me.tokens.length === 1 && me.tokens[0] === 3, 'Nitocris takes an Age II victory token without a fight');
  ok(me.coins === coins - 2 + 2, `and Nero is paid 2 for it (cost 2, paid 2: ${me.coins - coins})`);
}

{
  const G = mk(3);
  const [a, b, c] = G.players;
  a.shields = 0; b.shields = 5; c.shields = 5;
  a.built = [lead('Tomyris')];
  for (const p of G.players) p.hand = [];
  SW.forceEndAge(G);
  ok(!a.tokens.some((t) => t < 0), 'Tomyris takes no defeat tokens');
  ok(b.tokens.filter((t) => t < 0).length + c.tokens.filter((t) => t < 0).length === 2,
     'the two who beat her hold them instead');
}

{
  const G = atRecruit(3, 3, [['Telesilla'], ['Sappho'], ['Sappho']]);
  const [me, x, y] = G.players;
  me.tokens = [-1, -1, 3];
  x.tokens = [1, 5]; y.tokens = [3];
  allRecruit(G, { 0: { name: 'Telesilla' } });
  ok(JSON.stringify(me.tokens) === '[3]', `Telesilla burns her own defeats (${JSON.stringify(me.tokens)})`);
  ok(JSON.stringify(x.tokens) === '[5]', `everyone else gives up a victory, the cheapest one (${JSON.stringify(x.tokens)})`);
  ok(y.tokens.length === 0, 'even when it is their only one');
}

// ---- everyone else pays
{
  const G = atRecruit(4, 2, [['Arsinoe'], ['Sappho'], ['Sappho'], ['Sappho']], { cities: true });
  for (const p of G.players) p.coins = 10;
  allRecruit(G, { 0: { name: 'Arsinoe' } });
  const [me, ...rest] = G.players;
  ok(me.coins === 10 - 2 + 4, `Arsinoe costs the Age and pays 4 (${me.coins})`);
  ok(rest.every((p) => p.coins === 10 + 3 - 2), `and everyone else loses the Age — 2 in Age II (${rest.map((p) => p.coins).join(',')})`);
}

// ---- scoring
const score = (build, extra = {}, nb = [[], []]) => {
  const G = mk(3, { cities: true });
  G.phase = 'over';
  const me = SW.playerBySeat(G, 0);
  me.built = build.map((x) => (typeof x === 'string' ? lead(x) : x));
  Object.assign(me, extra);
  SW.playerBySeat(G, SW.leftOf(G, 0)).built = nb[0];
  SW.playerBySeat(G, SW.rightOf(G, 0)).built = nb[1];
  return SW.scoreFor(G, 0);
};
const col = (c, n) => Array.from({ length: n }, (_, i) => ({ n: `${c}${i}`, c }));

{
  ok(score(['Sappho', 'Zenobia']).leaders === 5, 'flat leader points are their own line on the scoresheet');
  ok(score(['Phidias', ...col('brown', 4)]).leaders === 4, 'Phidias pays 1 a brown card');
  ok(score(['Praxiteles', ...col('grey', 3)]).leaders === 6, 'Praxiteles pays 2 a grey one');

  const j = score(['Justinian', ...col('blue', 2), ...col('red', 2), ...col('green', 1)]);
  ok(j.leaders === 3, `Justinian pays per complete blue-red-green set, not per card (${j.leaders})`);
  const p7 = score(['Plato', ...col('brown', 1), ...col('grey', 1), ...col('blue', 1), ...col('yellow', 1), ...col('red', 1), ...col('green', 1), ...col('purple', 1)]);
  ok(p7.leaders === 7, `Plato wants one of every colour (${p7.leaders})`);
  ok(score(['Plato', ...col('brown', 9)]).leaders === 0, 'and pays nothing for nine of one');

  const m = score(['Midas'], { coins: 11 });
  ok(m.coins === 3 && m.leaders === 3, `Midas is a second helping of the coin score (${m.coins} + ${m.leaders})`);

  ok(score(['Cynisca'], { tokens: [1, 3] }).leaders === 6, 'Cynisca pays for a clean sheet');
  ok(score(['Cynisca'], { tokens: [1, -1] }).leaders === 0, 'and nothing if you ever lost');
  ok(score(['Agrippina']).leaders === 7, 'Agrippina pays if she is your only leader');
  ok(score(['Agrippina', 'Sappho']).leaders === 2 + 0, 'and not a point if she is not');
  ok(score(['Gorgo'], { tokens: [3, 3, 5] }).leaders === 3, 'Gorgo pays per matching pair, at the value of the pair');
  ok(score(['Gorgo'], { tokens: [5, 5, 5, 5] }).leaders === 10, 'two pairs of fives is ten');
  ok(score(['Alexander'], { tokens: [1, 3, -1] }).leaders === 2, 'Alexander counts victories, not defeats');

  const ahead = score(['Phryne', ...col('blue', 3)], {}, [col('blue', 2), col('blue', 2)]);
  const level = score(['Phryne', ...col('blue', 2)], {}, [col('blue', 2), col('blue', 1)]);
  ok(ahead.leaders === 5, 'Phryne pays for more blue than both neighbours');
  ok(level.leaders === 0, 'and a tie with either of them is not more');
  ok(score(['Makeda'], { coins: 9 }, [[], []]).leaders === 5, 'Makeda counts coins the same way');
}

// ---- science
const sci = (n, sym) => Array.from({ length: n }, (_, i) => ({ n: `${sym}${i}`, c: 'green', sci: sym }));
{
  const plain = score([...sci(2, 'compass'), ...sci(2, 'gear'), ...sci(2, 'tablet')]);
  ok(plain.science === 4 + 4 + 4 + 14, `two of each is 26 (${plain.science})`);
  const ari = score(['Aristotle', ...sci(2, 'compass'), ...sci(2, 'gear'), ...sci(2, 'tablet')]);
  ok(ari.science === plain.science + 6, `Aristotle adds 3 a set (${ari.science - plain.science})`);

  const lop = score([...sci(3, 'compass'), ...sci(1, 'gear')]);
  const swapped = score(['Aganice', ...sci(3, 'compass'), ...sci(1, 'gear')]);
  ok(swapped.science > lop.science, `Aganice moves a symbol where it is worth more (${lop.science} → ${swapped.science})`);
  // 3+1 becomes 4+0: sixteen, which beats the 13 of filling the set out
  ok(swapped.science === 16, `and she picks the best move, not the tidiest (${swapped.science})`);

  const more = score(['Enheduania', ...sci(2, 'compass'), ...sci(1, 'gear')]);
  ok(more.science === 9 + 1, `Enheduania adds one of whatever you have most of (${more.science})`);
}

// ---- and the whole thing, over and over
{
  let games = 0;
  for (const n of [3, 5, 8]) {
    for (let i = 0; i < 20; i++) {
      const G = drive(mk(n, { cities: true }));
      if (G.players.some((p) => p.leaders.length !== 1)) { ok(false, `${n}p: leftover leaders`); break; }
      if (G.result.scores.some((s) => !Number.isFinite(s.total))) { ok(false, `${n}p: bad score`); break; }
      games++;
    }
  }
  ok(games === 60, `${games} full games at 3, 5 and 8 players, with Cities as well`);
}

console.log(fails ? `\n${fails} FAILURES` : '\nLeader rules hold');
process.exit(fails ? 1 : 0);
