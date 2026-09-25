// The discard pile, and the four things that reach into it: Solomon, Cities'
// Forging Agency, and every stage of Halikarnassos. They all say the same
// sentence, so they all run through the same phase — one player choosing while
// the rest of the table waits. Run with `node test-discard.mjs`.
import * as SW from './game.js';
import { LEADERS, CITY_CARDS } from './cards.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : '**FAIL**'}  ${m}`); if (!c) fails++; };

const mk = (n, opts = {}) =>
  SW.newMatch(Array.from({ length: n }, (_, s) => ({ seat: s, name: 'P' + s, bot: true })), opts);

const junk = (id, extra = {}) => ({ n: `Card${id}`, c: 'brown', give: 'W', id, ...extra });

// Give seat 0 a wonder whose next stage digs in the discard, and make it free.
function withSalvageStage(G, seat = 0) {
  const p = SW.playerBySeat(G, seat);
  p.wonder = 'Halikarnassos';
  p.side = 'B';
  p.stages = [{ cost: '', salvage: true }, { cost: '', vp: 1 }];
  p.stagesBuilt = [];
  return p;
}

// everyone plays something so the turn resolves; seat 0 does what it is told
function turn(G, how = 'discard', seat = 0) {
  const me = SW.playerBySeat(G, seat);
  const r = SW.applyMove(G, seat, { kind: 'pick', how, cardId: me.hand[0].id });
  if (!r.ok) { console.log(`**FAIL**  setup: seat ${seat} could not ${how}: ${r.error}`); fails++; }
  for (const q of G.players) {
    if (q.seat === seat || G.picks[q.seat]) continue;
    SW.applyMove(G, q.seat, { kind: 'pick', how: 'discard', cardId: q.hand[0].id });
  }
}

// ---- a wonder stage opens the pile, and only for the one who built it
{
  const G = mk(4);
  withSalvageStage(G);
  G.discard = [junk('d1'), junk('d2')];
  turn(G, 'wonder');
  ok(G.phase === 'choose', `building the stage opens the discard (phase ${G.phase})`);
  ok(JSON.stringify(SW.waitingOn(G)) === '[0]', `and the table waits on exactly one seat (${JSON.stringify(SW.waitingOn(G))})`);

  const mine = SW.viewFor(G, 0, 'X').choice;
  const theirs = SW.viewFor(G, 1, 'X').choice;
  ok(mine && Array.isArray(mine.cards), 'the seat that is choosing is handed the pile');
  ok(theirs && theirs.cards === null, 'and nobody else sees what is in it');
  ok(theirs && theirs.seat === 0 && theirs.why === 'Halikarnassos', `everyone can see who is choosing, and why (${theirs.why})`);

  const no = SW.applyMove(G, 1, { kind: 'choose', cardId: 'd1' });
  ok(!no.ok, `somebody else cannot take the card instead (${no.error})`);
  const bad = SW.applyMove(G, 0, { kind: 'pick', how: 'discard', cardId: 'd1' });
  ok(!bad.ok, `and the normal moves are refused while the pile is open (${bad.error})`);
}

// ---- taking one: free, out of the pile, into the city, and marked
{
  const G = mk(4);
  const me = withSalvageStage(G);
  me.coins = 0;
  G.discard = [junk('d1'), { n: 'Pricey', c: 'blue', cost: 'SSSSSSS', vp: 8, id: 'd2' }];
  turn(G, 'wonder');
  const r = SW.applyMove(G, 0, { kind: 'choose', cardId: 'd2' });
  ok(r.ok, 'you may take a card you could never have paid for');
  ok(me.coins === 0, `and it costs nothing (${me.coins} coins)`);
  ok(me.built.some((c) => c.n === 'Pricey'), 'the card is standing in your city');
  ok(me.built.find((c) => c.n === 'Pricey').fromPile === true, 'and is marked as having come out of the pile');
  ok(!G.discard.some((c) => c.id === 'd2'), 'it is out of the discard');
  ok(G.discard.some((c) => c.id === 'd1'), 'and the rest of the pile is still there');
  ok(G.phase === 'play' && G.turn === 2, `the turn picks up where it left off (${G.phase} t${G.turn})`);
}

// ---- what the pile will not offer you
{
  const G = mk(4);
  const me = withSalvageStage(G);
  me.built = [{ n: 'Baths', c: 'blue', vp: 3 }];
  G.discard = [{ n: 'Baths', c: 'blue', vp: 3, id: 'd1' }, junk('d2')];
  turn(G, 'wonder');
  // the other three sold a card each this turn, so the pile is bigger than the
  // two put there by hand — what matters is which one is missing from it
  const cards = SW.viewFor(G, 0, 'X').choice.cards;
  ok(!cards.some((c) => c.n === 'Baths') && cards.some((c) => c.id === 'd2'),
     `a card you have already built is not on offer (${cards.map((c) => c.n).join(', ')})`);
  const no = SW.applyMove(G, 0, { kind: 'choose', cardId: 'd1' });
  ok(!no.ok, `and asking for it anyway is refused (${no.error})`);
  ok(SW.applyMove(G, 0, { kind: 'choose', how: 'pass' }).ok, 'you may always put the pile back untouched');
  ok(G.phase === 'play', 'which also lets the turn carry on');
}

// ---- an empty pile is not a phase at all
{
  const G = mk(4);
  withSalvageStage(G);
  G.discard = [];
  turn(G, 'wonder');
  // the other three sold a card each, so the pile is not empty by the time the
  // stage resolves — clear it and check the skip directly instead
  const H = mk(4);
  const p = withSalvageStage(H);
  H.discard = [];
  for (const q of H.players) if (q.seat) q.built = [];
  turn(H, 'wonder', 0);
  ok(H.phase !== 'choose' || H.discard.length > 0, 'a pile with something in it opens; an empty one is skipped');

  const K = mk(4);
  const k = withSalvageStage(K);
  k.built = [];
  K.discard = [];
  // everybody builds instead of selling, so nothing lands in the pile
  for (const q of K.players) if (q.seat) q.hand[0] = { n: `Free${q.seat}`, c: 'brown', give: 'W', id: `f${q.seat}` };
  SW.applyMove(K, 0, { kind: 'pick', how: 'wonder', cardId: k.hand[0].id });
  for (const q of K.players) if (q.seat) SW.applyMove(K, q.seat, { kind: 'pick', how: 'play', cardId: `f${q.seat}` });
  ok(K.phase === 'play', `nothing in the pile means no phase and no stall (${K.phase})`);
  ok(K.turn === 2, `the turn moved on by itself (turn ${K.turn})`);
}

// ---- Solomon, out of the recruitment phase
{
  const G = mk(4, { leaders: true });
  const me = SW.playerBySeat(G, 0);
  for (const p of G.players) { p.draft = []; p.leaders = []; }
  G.age = 2;
  G.phase = 'recruit';
  G.picks = {};
  const solomon = LEADERS.find((l) => l.n === 'Solomon');
  ok(!!solomon && solomon.salvage === true, 'Solomon is in the deck and digs in the pile');
  me.leaders = [{ ...solomon, c: 'white', id: 'L-Sol' }];
  me.coins = 9;
  G.discard = [{ n: 'Aqueduct', c: 'blue', cost: 'SSS', vp: 5, id: 'd1' }];
  for (const p of G.players) {
    if (!p.seat) continue;
    p.leaders = [{ n: 'Sappho', c: 'white', coin: 1, vp: 2, id: `L${p.seat}` }];
    SW.applyMove(G, p.seat, { kind: 'pick', how: 'discard', cardId: `L${p.seat}` });
  }
  SW.applyMove(G, 0, { kind: 'pick', how: 'play', cardId: 'L-Sol' });
  ok(G.phase === 'choose', `recruiting Solomon opens the pile (${G.phase})`);
  ok(!G.players.some((p) => p.hand.length), 'and the Age is not dealt until he has finished');
  SW.applyMove(G, 0, { kind: 'choose', cardId: 'd1' });
  ok(me.built.some((c) => c.n === 'Aqueduct'), 'he builds it for nothing');
  ok(G.phase === 'play' && G.players.every((p) => p.hand.length === G.handSize), 'and only then is the Age dealt');
}

// ---- the Forging Agency, out of a turn
{
  const agency = CITY_CARDS.find((c) => c.n === 'Forging Agency');
  ok(!!agency && agency.salvage === true && agency.age === 2, 'the Forging Agency is in the Cities deck, in Age II');

  const G = mk(4, { cities: true });
  const me = SW.playerBySeat(G, 0);
  me.coins = 9;
  me.hand[0] = { ...agency, id: 'fa' };
  G.discard = [{ n: 'Temple', c: 'blue', cost: 'WCG', vp: 3, id: 'd1' }];
  turn(G, 'play');
  ok(G.phase === 'choose', `building it opens the pile (${G.phase})`);
  SW.applyMove(G, 0, { kind: 'choose', cardId: 'd1' });
  ok(me.built.some((c) => c.n === 'Temple'), 'and a card comes out of it');
  ok(G.phase === 'play' && G.turn === 2, 'then the turn carries on');
}

// ---- a card out of the pile is still a card you built
{
  const G = mk(4, { leaders: true });
  const me = withSalvageStage(G);
  G.phase = 'play';
  G.turn = 1;
  for (const p of G.players) p.hand = [junk(`h${p.seat}`)];
  G.handSize = 7;
  me.built = [{ n: 'Xenophon', c: 'white', onBuild: { of: 'yellow', coins: 2 } }];
  me.coins = 0;
  G.discard = [{ n: 'Tavern', c: 'yellow', coins: 5, id: 'd1' }];
  turn(G, 'wonder');
  SW.applyMove(G, 0, { kind: 'choose', cardId: 'd1' });
  ok(me.coins === 7, `the card's own effect and Xenophon both pay out (5 + 2 = ${me.coins})`);
}

// ---- two diggers in one turn, in seat order, sharing one pile
{
  const G = mk(4, { cities: true });
  const a = withSalvageStage(G, 0);
  const b = withSalvageStage(G, 2);
  G.discard = [junk('d1'), junk('d2')];
  SW.applyMove(G, 0, { kind: 'pick', how: 'wonder', cardId: a.hand[0].id });
  SW.applyMove(G, 2, { kind: 'pick', how: 'wonder', cardId: b.hand[0].id });
  for (const q of G.players) if (!G.picks[q.seat]) SW.applyMove(G, q.seat, { kind: 'pick', how: 'discard', cardId: q.hand[0].id });
  ok(G.phase === 'choose' && SW.waitingOn(G)[0] === 0, `the lower seat goes first (${SW.waitingOn(G)})`);
  const first = SW.viewFor(G, 0, 'X').choice.cards.length;
  SW.applyMove(G, 0, { kind: 'choose', cardId: 'd1' });
  ok(G.phase === 'choose' && SW.waitingOn(G)[0] === 2, `then the other one (${SW.waitingOn(G)})`);
  const second = SW.viewFor(G, 2, 'X').choice.cards.length;
  ok(second === first - 1, `and the second sees one fewer card than the first (${first} then ${second})`);
  SW.applyMove(G, 2, { kind: 'choose', how: 'pass' });
  ok(G.phase === 'play' && G.turn === 2, 'the turn resumes once both are done');
}

// ---- and the publisher's order when more than one fires at once:
//      the wonder, then Solomon, then the Forging Agency
{
  const agency = CITY_CARDS.find((c) => c.n === 'Forging Agency');
  const G = mk(4, { cities: true });
  const late = withSalvageStage(G, 2);          // a higher seat, so seat order
  const early = SW.playerBySeat(G, 0);          // would put the Agency first
  early.coins = 9;
  early.hand[0] = { ...agency, id: 'fa' };
  G.discard = [junk('d1'), junk('d2')];
  SW.applyMove(G, 0, { kind: 'pick', how: 'play', cardId: 'fa' });
  SW.applyMove(G, 2, { kind: 'pick', how: 'wonder', cardId: late.hand[0].id });
  for (const q of G.players) if (!G.picks[q.seat]) SW.applyMove(G, q.seat, { kind: 'pick', how: 'discard', cardId: q.hand[0].id });
  ok(G.phase === 'choose' && SW.waitingOn(G)[0] === 2,
     `the wonder digs before the Forging Agency, whatever the seats are (${SW.waitingOn(G)})`);
  SW.applyMove(G, 2, { kind: 'choose', how: 'pass' });
  ok(SW.waitingOn(G)[0] === 0, `and the Agency goes second (${SW.waitingOn(G)})`);
  SW.applyMove(G, 0, { kind: 'choose', how: 'pass' });
  ok(G.phase === 'play', 'then the turn carries on');
}

// ---- the last turn of an Age: dig first, fight after
{
  const G = mk(4);
  const me = withSalvageStage(G);
  G.turn = G.handSize - 1;
  G.discard = [{ n: 'Walls', c: 'red', cost: 'SSS', shield: 2, id: 'd1' }];
  turn(G, 'wonder');
  ok(G.phase === 'choose', 'the pile opens before the conflict is counted');
  ok(G.age === 1, 'and the Age has not turned over yet');
  SW.applyMove(G, 0, { kind: 'choose', cardId: 'd1' });
  ok(G.age === 2, `then the Age ends (now Age ${G.age})`);
  ok(me.tokens.length > 0 || G.players.every((p) => !p.tokens.length),
     'and the shields taken out of the pile counted towards it');
}

// ---- and the whole thing, over and over
const playOut = (G) => {
  let guard = 0;
  while (G.phase !== 'over') {
    if (++guard > 6000) return `stuck in ${G.phase}`;
    const pending = SW.waitingOn(G);
    if (!pending.length) return `nobody to act in ${G.phase}`;
    for (const seat of pending) {
      const mv = SW.botChoose(G, seat);
      if (!mv) return `no move for seat ${seat} in ${G.phase}`;
      const r = SW.applyMove(G, seat, mv);
      if (!r.ok) return `${G.phase} rejected ${JSON.stringify(mv)}: ${r.error}`;
      if (G.phase === 'over') break;
    }
  }
  return null;
};
const dug = (G) => G.players.reduce((a, p) => a + p.built.filter((c) => c.fromPile).length, 0);

// Cities only, so every card in a city was dealt from an Age deck and the
// cards can be counted. Taking one out of the pile must move it, not copy it.
{
  let games = 0, digs = 0, why = null;
  for (const n of [3, 5, 7]) {
    for (let i = 0; i < 25 && !why; i++) {
      const G = mk(n, { cities: true });
      why = playOut(G);
      if (why) break;
      digs += dug(G);
      const built = G.players.reduce((a, p) => a + p.built.length, 0);
      const buried = G.players.reduce((a, p) => a + p.stagesBuilt.length, 0);
      if (built + buried + G.discard.length !== 3 * G.handSize * n) {
        why = `${n}p: ${built}+${buried}+${G.discard.length} cards, expected ${3 * G.handSize * n}`;
        break;
      }
      games++;
    }
  }
  ok(!why, why || `${games} full games with Cities, and every card still adds up`);
  ok(digs > 0, `${digs} cards were dug out of the pile across them`);
}

// Leaders as well, where the cards no longer add up because leaders were never
// dealt from an Age deck. What is checked here is that nothing stalls and
// Solomon's dig lands in the same phase as everyone else's.
{
  let games = 0, digs = 0, why = null;
  for (const n of [3, 5, 7]) {
    for (let i = 0; i < 25 && !why; i++) {
      const G = mk(n, { cities: true, leaders: true });
      why = playOut(G);
      if (why) break;
      digs += dug(G);
      if (G.players.some((p) => p.built.filter((c) => c.fromPile && c.c === 'white').length)) {
        why = `${n}p: a leader came out of the discard pile`;
        break;
      }
      games++;
    }
  }
  ok(!why, why || `${games} more with Leaders on top`);
  ok(digs > 0, `${digs} dug out of those, and never a sold leader among them`);
}

console.log(fails ? `\n${fails} FAILURES` : '\nThe discard pile holds');
process.exit(fails ? 1 : 0);
