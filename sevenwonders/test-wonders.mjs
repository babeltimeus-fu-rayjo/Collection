// The abilities printed on the boards rather than bought with a card: the
// three free builds Olympia grants and Babylon's extra card. Second edition,
// so there is no copied guild here — see the Decorators Guild instead.
// Run with `node test-wonders.mjs`.
import * as SW from './game.js';
import { WONDERS, CITY_CARDS, GUILDS } from './cards.js';

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

// ---- the boards carry what the second edition prints on them
{
  const acts = {};
  for (const w of WONDERS) for (const side of ['A', 'B']) {
    for (const st of w.sides[side]) if (st.act) (acts[st.act] ||= []).push(`${w.n} ${side}`);
  }
  ok(String(acts.freeFirstOfColour) === 'Olympia A', `freeFirstOfColour is on ${acts.freeFirstOfColour}`);
  ok(String(acts.freeFirstOfAge) === 'Olympia B', `freeFirstOfAge is on ${acts.freeFirstOfAge}`);
  ok(String(acts.freeLastOfAge) === 'Olympia B', `freeLastOfAge is on ${acts.freeLastOfAge}`);
  ok(String(acts.playLast) === 'Babylon B', `playLast is on ${acts.playLast}`);
  ok(Object.keys(acts).length === 4, `and nothing else is waiting to be implemented (${Object.keys(acts).join(', ')})`);
  ok(WONDERS.find((w) => w.n === 'Babylon').sides.B.length === 2, "Babylon's night side has two stages");
}

// ---- Olympia's day side: the first card of each colour
{
  const G = mk(4);
  const me = grant(G, 0, 'freeFirstOfColour');
  me.wonderRes = ''; me.built = []; me.coins = 0;
  me.hand = [card('Palace', 'blue', { cost: 'CGOPSTW', vp: 8 }), card('Castrum', 'red', { cost: 'CCPW' })];
  ok(opt(G, 0, 'Palace').play && opt(G, 0, 'Palace').play.coins === 0, 'your first blue card is free however dear it is');
  ok(opt(G, 0, 'Castrum').play.coins === 0, 'and so is your first red one');
  ok(opt(G, 0, 'Palace').playFree === null, 'there is no allowance to spend — the card is simply free');

  me.built = [{ n: 'Baths', c: 'blue', vp: 3 }];
  ok(opt(G, 0, 'Palace').play === null, 'a second blue card is not');
  ok(opt(G, 0, 'Castrum').play.coins === 0, 'while the first red one still is');
}

// ---- Olympia's night side: the first card of an Age, and the last
{
  const G = mk(4);
  const me = grant(G, 0, 'freeFirstOfAge');
  me.wonderRes = ''; me.built = []; me.coins = 0;
  me.hand = [card('Palace', 'blue', { cost: 'CGOPSTW', vp: 8 })];
  G.turn = 1;
  ok(opt(G, 0, 'Palace').play.coins === 0, 'the first card of the Age is free');
  me.builtThisAge = 1;
  ok(opt(G, 0, 'Palace').play === null, 'the second is not');

  const H = mk(4);
  const you = grant(H, 0, 'freeLastOfAge');
  you.wonderRes = ''; you.built = []; you.coins = 0;
  you.hand = [card('Palace', 'blue', { cost: 'CGOPSTW', vp: 8 })];
  H.turn = 1;
  ok(opt(H, 0, 'Palace').play === null, 'the last card of the Age is not free on the first turn');
  H.turn = H.handSize - 1;
  ok(opt(H, 0, 'Palace').play.coins === 0, 'and is on the last');
}

// ---- and the one allowance that IS a choice still is
{
  const G = mk(4, { cities: true });
  const me = grant(G, 0, 'freeFirstOfAge');
  me.wonderRes = ''; me.built = [{ n: 'Caligula', c: 'white', freeColourAge: 'black' }]; me.coins = 0;
  me.builtThisAge = 1;                        // Olympia's is already spent
  me.hand = [card('Capitol', 'black', { cost: 'CCGPSS', vp: 8 })];
  ok(opt(G, 0, 'Capitol').play === null, 'Olympia does not help twice in an Age');
  ok(opt(G, 0, 'Capitol').playFree && opt(G, 0, 'Capitol').playFree.gift === 'black',
     'but Caligula is still offered, and still as a choice');
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

// ---- the Decorators want the wonder finished
{
  const G = mk(3);
  G.phase = 'over';
  const me = SW.playerBySeat(G, 0);
  const dec = GUILDS.find((g) => g.n === 'Decorators Guild');
  ok(!!dec && dec.vpIfWonder === 7, 'the Decorators Guild is in the base ten, and pays 7');
  ok(!GUILDS.some((g) => g.n === 'Strategists Guild'), 'and the Strategists Guild is not — it was a first edition card');
  me.built = [{ ...dec }];
  me.stages = [{ cost: '' }, { cost: '' }];
  me.stagesBuilt = [{ cost: '' }];
  ok(SW.scoreFor(G, 0).guild === 0, 'half a wonder is worth nothing to them');
  me.stagesBuilt = [{ cost: '' }, { cost: '' }];
  ok(SW.scoreFor(G, 0).guild === 7, 'a finished one is worth seven');
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
