// The three abilities printed on the boards rather than bought with a card:
// Olympia's free build, Babylon's extra card, and Olympia's copied guild.
// Run with `node test-wonders.mjs`.
import * as SW from './game.js';
import { WONDERS, CITY_CARDS } from './cards.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : '**FAIL**'}  ${m}`); if (!c) fails++; };

const mk = (n, opts = {}) =>
  SW.newMatch(Array.from({ length: n }, (_, s) => ({ seat: s, name: 'P' + s, bot: true })), opts);

// hand a seat a board that has already granted the ability
function grant(G, seat, act) {
  const p = SW.playerBySeat(G, seat);
  p.stagesBuilt = [{ cost: '', act }];
  p.stages = [{ cost: '', act }, { cost: 'SSSSSSS', vp: 1 }];
  return p;
}
const card = (n, c, extra = {}) => ({ n, c, id: n.replace(/\s/g, ''), ...extra });
const opt = (G, seat, name) => SW.optionsFor(G, seat).find((o) => o.name === name);

// everyone but `seat` throws a card away so the turn resolves
const others = (G, seat) => {
  for (const q of G.players) {
    if (q.seat === seat || G.picks[q.seat] || !q.hand.length) continue;
    SW.applyMove(G, q.seat, { kind: 'pick', how: 'discard', cardId: q.hand[0].id });
  }
};

// ---- the boards still carry all three, on the stages they were printed on
{
  const acts = {};
  for (const w of WONDERS) for (const side of ['A', 'B']) {
    for (const s of w.sides[side]) if (s.act) acts[s.act] = `${w.n} ${side}`;
  }
  ok(acts.freePerAge === 'Olympia A', `freePerAge is on ${acts.freePerAge}`);
  ok(acts.playLast === 'Babylon B', `playLast is on ${acts.playLast}`);
  ok(acts.copyGuild === 'Olympia B', `copyGuild is on ${acts.copyGuild}`);
  ok(Object.keys(acts).length === 3, `and there is nothing else waiting to be implemented (${Object.keys(acts).join(', ')})`);
}

// ---- Olympia: one card an Age, for nothing
{
  const G = mk(4);
  const me = grant(G, 0, 'freePerAge');
  me.wonderRes = ''; me.built = []; me.coins = 0;
  me.hand = [card('Palace', 'blue', { cost: 'WSCOGPT', vp: 8 }), card('Pawnshop', 'blue', { vp: 3 })];

  const dear = opt(G, 0, 'Palace');
  ok(dear.play === null, 'a card you cannot pay for is still not something you can pay for');
  ok(dear.playFree && dear.playFree.coins === 0, 'but the free build is offered beside it');

  const cheap = opt(G, 0, 'Pawnshop');
  ok(cheap.play && cheap.play.coins === 0, 'a card that costs nothing is simply free');
  ok(cheap.playFree === null, 'and does not waste the allowance');

  SW.applyMove(G, 0, { kind: 'pick', how: 'free', cardId: 'Palace' });
  others(G, 0);
  ok(me.built.some((c) => c.n === 'Palace'), 'the free build puts the card in your city');
  ok(me.coins === 0, `and takes no coins (${me.coins})`);

  me.hand = [card('Pantheon', 'blue', { cost: 'CCOPTG', vp: 7 })];
  ok(opt(G, 0, 'Pantheon').playFree === null, 'there is only one an Age');
  G.age = 2;
  ok(opt(G, 0, 'Pantheon').playFree !== null, 'and it comes back with the next one');
}

// ---- and it does not fight with Caligula over the same card
{
  const G = mk(4, { cities: true });
  const me = grant(G, 0, 'freePerAge');
  me.wonderRes = ''; me.built = [{ n: 'Caligula', c: 'white', freeColourAge: 'black' }]; me.coins = 0;
  me.hand = [card('Capitol', 'black', { cost: 'CCGPSS', vp: 8 })];
  ok(opt(G, 0, 'Capitol').playFree.gift === 'black',
     'a black card spends Caligula’s allowance, not the one that works on anything');
  me.freeAgeUsed = { 'black-1': true };
  ok(opt(G, 0, 'Capitol').playFree.gift === 'any', 'and falls back to Olympia’s once his is gone');
}

// ---- Babylon: the seventh card is played, not binned
{
  const G = mk(4);
  const me = grant(G, 0, 'playLast');
  me.coins = 9;
  G.turn = G.handSize - 1;
  for (const p of G.players) {
    p.hand = [card(`Play${p.seat}`, 'brown', { give: 'W' }), card(`Last${p.seat}`, 'brown', { give: 'S' })];
  }
  // resolve the final turn of the Age, which leaves everybody holding one card
  for (const p of G.players) SW.applyMove(G, p.seat, { kind: 'pick', how: 'discard', cardId: `Play${p.seat}` });
  ok(G.phase === 'lastcard', `the Age stops for the last card (${G.phase})`);
  ok(JSON.stringify(SW.waitingOn(G)) === '[0]', `and waits on exactly the one seat (${JSON.stringify(SW.waitingOn(G))})`);
  ok(G.players.filter((p) => p.seat).every((p) => !p.hand.length), 'everybody else has already binned theirs');
  ok(me.hand.length === 1, 'and the one who may play it still holds it');
  ok(G.age === 1, 'the conflict has not been counted yet');

  const no = SW.applyMove(G, 1, { kind: 'pick', how: 'discard', cardId: 'Play1' });
  ok(!no.ok, `nobody else gets a turn out of it (${no.error})`);

  const before = G.discard.length;
  SW.applyMove(G, 0, { kind: 'pick', how: 'play', cardId: 'Last0' });
  ok(me.built.some((c) => c.n === 'Last0'), 'the card is built like any other');
  ok(G.discard.length === before, 'and never reaches the bin');
  ok(G.lateCards === 1, `which is counted, so the cards still add up (${G.lateCards})`);
  ok(G.age === 2, `then the Age turns over (Age ${G.age})`);
}

// ---- ... and it is a real turn: sell it, or spend it on the wonder
{
  const G = mk(4);
  const me = grant(G, 0, 'playLast');
  me.coins = 0;
  G.turn = G.handSize - 1;
  for (const p of G.players) p.hand = [card(`K${p.seat}`, 'brown', { give: 'W' }), card(`L${p.seat}`, 'brown', { give: 'S' })];
  for (const p of G.players) SW.applyMove(G, p.seat, { kind: 'pick', how: 'discard', cardId: `K${p.seat}` });
  const purse = me.coins;                       // it already sold one this turn
  SW.applyMove(G, 0, { kind: 'pick', how: 'discard', cardId: 'L0' });
  ok(me.coins === purse + 3, `selling the last card pays the usual three (${me.coins - purse})`);
  ok(G.age === 2, 'and the Age moves on');

  const H = mk(4);
  const you = grant(H, 0, 'playLast');
  you.stages = [{ cost: '', act: 'playLast' }, { cost: '', vp: 4 }];
  H.turn = H.handSize - 1;
  for (const p of H.players) p.hand = [card(`J${p.seat}`, 'brown', { give: 'W' }), card(`M${p.seat}`, 'brown', { give: 'S' })];
  for (const p of H.players) SW.applyMove(H, p.seat, { kind: 'pick', how: 'discard', cardId: `J${p.seat}` });
  SW.applyMove(H, 0, { kind: 'pick', how: 'wonder', cardId: 'M0' });
  ok(you.stagesBuilt.length === 2 && you.stagesBuilt[1].buried === 'M0', 'or it goes under the wonder');
}

// ---- a last card that reaches into the pile still gets to
{
  const agency = CITY_CARDS.find((c) => c.n === 'Forging Agency');
  const G = mk(4, { cities: true });
  const me = grant(G, 0, 'playLast');
  me.coins = 9;
  G.turn = G.handSize - 1;
  for (const p of G.players) p.hand = [card(`P${p.seat}`, 'brown', { give: 'W' }), card(`N${p.seat}`, 'brown', { give: 'S' })];
  me.hand = [card('P0', 'brown', { give: 'W' }), { ...agency, id: 'N0' }];
  for (const p of G.players) SW.applyMove(G, p.seat, { kind: 'pick', how: 'discard', cardId: `P${p.seat}` });
  SW.applyMove(G, 0, { kind: 'pick', how: 'play', cardId: 'N0' });
  ok(G.phase === 'salvage', `the pile opens off the back of the last card (${G.phase})`);
  ok(G.age === 1, 'and the Age still has not turned over');
  const take = SW.viewFor(G, 0, 'X').salvage.cards[0];
  SW.applyMove(G, 0, { kind: 'salvage', cardId: take.id });
  ok(G.age === 2, `then everything finishes in order (Age ${G.age})`);
}

// ---- Olympia again: a copy of somebody else's guild
const score = (mine, left, right, act = 'copyGuild') => {
  const G = mk(3);
  G.phase = 'over';
  const me = grant(G, 0, act);
  me.built = mine;
  SW.playerBySeat(G, SW.leftOf(G, 0)).built = left;
  SW.playerBySeat(G, SW.rightOf(G, 0)).built = right;
  return SW.scoreFor(G, 0);
};
const col = (c, n) => Array.from({ length: n }, (_, i) => ({ n: `${c}${i}`, c }));
const WORKERS = { n: 'Workers Guild', c: 'purple', per: { vp: 1, of: 'brown', from: 'neighbours' } };
const SCIENTISTS = { n: 'Scientists Guild', c: 'purple', sci: 'any' };

{
  ok(score([], [], []).guild === 0, 'no guild next door, nothing to copy');
  ok(score([], [WORKERS], []).guild === 0, 'a Workers Guild copied beside two empty cities is worth nothing');

  // the copy counts MY neighbours, not the neighbours of whoever built it
  const s = score([], [WORKERS, ...col('brown', 2)], col('brown', 3));
  ok(s.guild === 5, `the copy scores from your chair, not theirs (${s.guild} for 2 + 3 brown)`);

  const two = score([], [WORKERS, ...col('brown', 1)], [{ n: 'Magistrates Guild', c: 'purple', per: { vp: 1, of: 'blue', from: 'neighbours' } }, ...col('blue', 4)]);
  ok(two.guild === 4, `the better of the two is taken (${two.guild})`);

  const noAct = score([], [WORKERS, ...col('brown', 2)], col('brown', 3), 'playLast');
  ok(noAct.guild === 0, 'and only Olympia gets to do it');
}

// ---- including the one that is a symbol rather than points
{
  const sci = (n, sym) => Array.from({ length: n }, (_, i) => ({ n: `${sym}${i}`, c: 'green', sci: sym }));
  const plain = score([...sci(2, 'compass'), ...sci(2, 'gear'), ...sci(2, 'tablet')], [], []);
  const copied = score([...sci(2, 'compass'), ...sci(2, 'gear'), ...sci(2, 'tablet')], [SCIENTISTS], []);
  ok(plain.science === 26, `two of each is 26 (${plain.science})`);
  // a fourth symbol on a 2/2/2 row is 9 - 4, and the set bonus is already paid
  ok(copied.science === plain.science + 5 && copied.guild === 0,
     `copying the Scientists Guild is a symbol, and lands in the science column (+${copied.science - plain.science})`);

  // ... but only when it beats the points on offer
  const rich = { n: 'Big Guild', c: 'purple', vp: 20 };
  const both = score([...sci(2, 'compass')], [SCIENTISTS, rich], []);
  ok(both.guild === 20 && both.science === score([...sci(2, 'compass')], [], []).science,
     `a fat points guild beats a symbol when it is worth more (${both.guild})`);
}

// ---- and the whole thing, over and over
{
  let games = 0, why = null, frees = 0, lates = 0;
  for (const n of [3, 5, 7]) {
    for (let i = 0; i < 25 && !why; i++) {
      const G = mk(n, { cities: true, leaders: true });
      let guard = 0;
      while (G.phase !== 'over') {
        if (++guard > 8000) { why = `${n}p: stuck in ${G.phase}`; break; }
        const pending = SW.waitingOn(G);
        if (!pending.length) { why = `${n}p: nobody to act in ${G.phase}`; break; }
        for (const seat of pending) {
          const mv = SW.botChoose(G, seat);
          if (!mv) { why = `${n}p: no move for seat ${seat} in ${G.phase}`; break; }
          if (mv.how === 'free') frees++;
          const r = SW.applyMove(G, seat, mv);
          if (!r.ok) { why = `${n}p: ${G.phase} rejected ${JSON.stringify(mv)}: ${r.error}`; break; }
          if (G.phase === 'over') break;
        }
      }
      if (why) break;
      lates += G.lateCards;
      games++;
    }
  }
  ok(!why, why || `${games} full games at 3, 5 and 7 players with everything switched on`);
  ok(frees > 0, `${frees} free builds were taken`);
  ok(lates > 0, `${lates} last cards were played instead of binned`);
}

console.log(fails ? `\n${fails} FAILURES` : '\nThe boards hold');
process.exit(fails ? 1 : 0);
