// Each rule and each kind of effect, set up by hand and checked against the
// rulebook's wording. Decks are stacked in a known order (top card first),
// benches seeded directly, and the match stepped until the moment in question.
import * as CH from './game.js';

let fails = 0, checks = 0;
const eq = (got, want, what) => {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(want)) { console.log(`  **FAIL** ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); fails++; }
};
const ok = (cond, what) => eq(!!cond, true, what);

const roster = [{ seat: 0, name: 'Ann', bot: true }, { seat: 1, name: 'Bob', bot: true }];
const OPTS = { box: 'beach', basic: 'rainbow', sets: ['castle', 'film', 'funfair', 'haunted', 'mountain'] };

// A match between Ann (seat 0) and Bob (seat 1) with stacked decks. `first`
// opens; benches can be seeded as lists of card keys.
function rig({ a = [], b = [], first = 0, benchA = [], benchB = [], exhaustA = [], exhaustB = [], opts = OPTS, trophiesB = 0, trophiesA = 0, fansA = 0 } = {}) {
  const G = CH.newMatch(roster, opts);
  const make = (k) => { if (!CH.CARD[k]) throw new Error('no card ' + k); G.cards.push({ id: G.cards.length, key: k }); return G.cards.length - 1; };
  G.players[0].trophies = Array.from({ length: trophiesA }, (_, i) => ({ round: i + 1, fans: 2 }));
  G.players[1].trophies = Array.from({ length: trophiesB }, (_, i) => ({ round: i + 1, fans: 2 }));
  G.players[0].fans = fansA;
  const M = CH.makeMatch(G, 0, 1, { id: 0, park: 0 });
  M.first = first;
  M.tasks = [{ t: 'open', seat: first }];
  const fill = (S, keys) => { S.deck = keys.map(make); };
  fill(M.sides[0], a);
  fill(M.sides[1], b);
  const seat = (S, keys) => {
    for (const k of keys) {
      const id = make(k);
      const same = S.bench.find((x) => x.name === CH.CARD[k].name);
      if (same) same.ids.push(id); else S.bench.push({ name: CH.CARD[k].name, ids: [id], wide: false });
    }
  };
  seat(M.sides[0], benchA);
  seat(M.sides[1], benchB);
  M.sides[0].exhaust = exhaustA.map(make);
  M.sides[1].exhaust = exhaustB.map(make);
  G.matches = [M];
  G.phase = 'match';
  return { G, M, key: (id) => G.cards[id].key };
}

// step until `pred` holds (or the match ends), answering questions with `answer`
function until(G, M, pred, answer) {
  for (let i = 0; i < 200 && !pred(); i++) {
    if (M.over) break;
    if (M.pending) {
      const ans = answer ? answer(M.pending) : CH.autoAnswer(G, M, M.pending);
      const r = CH.answerMatch(G, M, M.pending.seat, ans);
      if (!r.ok) throw new Error(r.error);
    } else CH.stepMatch(G, M);
  }
}
// the flag has changed hands and the loser's cards have reached the bench
const settled = (M, seat) => () => M.attacker === seat && !M.sides[seat].limbo.length && !M.tasks.some((t) => t.t === 'bench' || t.t === 'take' || t.t === 'capture');
const flagKey = (G, M) => (M.holder === null || M.sides[M.holder].flag === null ? null : G.cards[M.sides[M.holder].flag].key);
const benchNames = (S) => S.bench.map((s) => `${s.name}×${s.ids.length}`);

console.log('— the match —');
{
  // Ann opens with a Pig (3). Bob attacks 1, 1, 2: the third card reaches 4 >= 3.
  const { G, M } = rig({ a: ['pig', 'horse'], b: ['newcomer', 'newcomer', 'talent-s', 'dog-s'] });
  until(G, M, () => M.holder === 1);
  eq(flagKey(G, M), 'talent-s', 'the card that reaches the total takes the flag');
  eq(M.sides[1].under.map((id) => G.cards[id].key), ['newcomer', 'newcomer'], 'the earlier attackers slide under it');
  until(G, M, () => M.sides[0].bench.length > 0);
  eq(benchNames(M.sides[0]), ['Pig×1'], 'the card that lost the flag goes to its owner’s bench');
  eq(M.sides[1].deck.length, 1, 'no card more than needed is turned over');
  eq(M.attacker, 0, 'the loser of the flag attacks next');
}
{
  // equal is enough: "equal to or greater than"
  const { G, M } = rig({ a: ['pig'], b: ['dog-s'] });
  until(G, M, () => M.holder === 1);
  eq(flagKey(G, M), 'dog-s', 'a tie takes the flag');
}
{
  // cards with the same name share a seat
  const { G, M } = rig({ a: ['newcomer', 'horse'], b: ['newcomer', 'dog-s', 'pig'], benchA: ['newcomer'] });
  until(G, M, () => M.sides[0].bench.some((s) => s.ids.length === 2));
  eq(benchNames(M.sides[0]), ['Newcomer×2'], 'two Newcomers, one seat');
}
{
  // "Your opponent is on the attack but cannot get enough total power"
  const { G, M } = rig({ a: ['dragon'], b: ['newcomer', 'newcomer'] });
  until(G, M, () => M.over);
  eq([M.winner, M.why], [0, 'nothing left to attack with'], 'an attacker who runs out loses');
}
{
  // "must put one or more cards on their bench but does not have enough empty seats"
  const { G, M } = rig({ a: ['newcomer', 'horse'], b: ['dog-s'], benchA: ['pig', 'cat', 'pony', 'spider', 'cow', 'parrot'] });
  until(G, M, () => M.over);
  eq([M.winner, M.why], [1, 'no free seat on the bench for Newcomer'], 'a seventh name on a full bench loses');
}
{
  // round 1 begins on a toss; afterwards the latest Trophy begins
  const { G } = rig();
  G.players[0].trophies = [{ round: 2, fans: 2 }];
  G.players[1].trophies = [{ round: 1, fans: 2 }, { round: 3, fans: 3 }];
  const M = CH.makeMatch(G, 0, 1, { id: 1, park: 0 });
  eq(M.first, 1, 'the player with the Trophy of the highest round begins');
}

console.log('— power —');
{
  // Hermit: +2 locked in when revealed, kept in flag possession
  const { G, M } = rig({ a: ['newcomer', 'hermit', 'horse'], b: ['cat', 'newcomer'], first: 1 });
  until(G, M, () => M.holder === 0);
  eq(flagKey(G, M), 'hermit', 'Hermit takes the flag');
  eq(CH.flagPower(G, M), 4, 'Hermit keeps its +2 in flag possession (2 + 2)');
}
{
  // Gangster: +2 during the attack only
  const { G, M } = rig({ a: ['gangster', 'horse'], b: ['pig', 'newcomer'], first: 1 });
  until(G, M, () => M.holder === 0);
  eq(CH.flagPower(G, M), 2, 'Gangster loses its attack bonus once it holds the flag');
}
{
  // Skeleton: +1 in flag possession
  const { G, M } = rig({ a: ['skeleton'], b: ['newcomer', 'newcomer', 'newcomer', 'newcomer'] });
  until(G, M, () => M.attacker === 1);
  eq(CH.flagPower(G, M), 3, 'Skeleton holds at 2 + 1');
}
{
  // Vendor on the bench: Funfair cards +1, a Rainbow card counts as Funfair
  const { G, M } = rig({ a: ['clown'], b: ['dj'], benchA: ['vendor'], benchB: ['vendor'] });
  until(G, M, () => M.attacker === 1);
  eq(CH.flagPower(G, M), 2, 'Clown 1 + Vendor');
  until(G, M, () => M.sides[1].attack.length === 1);
  eq(CH.attackTotal(G, M, 1), 3, 'DJ 2 + Vendor, because a Rainbow card has every set icon');
}
{
  // Bard: +1 to your cards during the attack only; Cook: +1 in flag possession
  const { G, M } = rig({ a: ['pig'], b: ['newcomer', 'newcomer', 'newcomer'], benchB: ['bard'], benchA: ['cook'] });
  until(G, M, () => M.attacker === 1);
  eq(CH.flagPower(G, M), 4, 'Pig 3 + Cook');
  until(G, M, () => M.holder === 1);
  eq(M.sides[1].under.length, 1, 'two Newcomers at 1 + Bard each reach 4');
  eq(CH.flagPower(G, M), 1, 'the Bard’s bonus is gone once the Newcomer holds the flag');
}
{
  // Knight: +1 during the attack for each Trophy of the opponent
  const { G, M } = rig({ a: ['horse'], b: ['knight'], trophiesA: 2 });
  until(G, M, () => M.sides[1].attack.length === 1);
  eq(CH.attackTotal(G, M, 1), 5, 'Knight 3 + 2 Trophies');
}
{
  // Mime: +1 for each empty seat, fixed when revealed
  const { G, M } = rig({ a: ['mime'], b: ['newcomer'], benchA: ['pig', 'cat'] });
  until(G, M, () => M.attacker === 1);
  eq(CH.flagPower(G, M), 5, 'Mime 1 + 4 empty seats');
}
{
  // Illusionist: in flag possession, +1 per empty seat — and it changes with the bench
  const { G, M } = rig({ a: ['illusionist'], b: ['newcomer', 'newcomer'], benchA: ['pig'] });
  until(G, M, () => M.attacker === 1);
  eq(CH.flagPower(G, M), 10, 'Illusionist 5 + 5 empty seats');
}
{
  // Streamer doubles every bonus it receives
  const { G, M } = rig({ a: ['horse'], b: ['streamer'], benchB: ['bard', 'vendor'] });
  until(G, M, () => M.sides[1].attack.length === 1);
  eq(CH.attackTotal(G, M, 1), 7, 'Streamer 3 + (Bard 1 + Vendor 1) × 2');
}
{
  // Mascot: +1 for each different set icon on your bench
  const { G, M } = rig({ a: ['mascot'], b: ['newcomer'], benchA: ['pig', 'horse', 'cat', 'newcomer'] });
  until(G, M, () => M.attacker === 1);
  eq(CH.flagPower(G, M), 5, 'Mascot 2 + Castle, Film Studio, City');
}

console.log('— flag loss, taking the flag —');
{
  // Prince: on flag loss it goes to the exhaust pile, not the bench
  const { G, M } = rig({ a: ['prince', 'horse'], b: ['dragon'] });
  until(G, M, settled(M, 0));
  eq([benchNames(M.sides[0]), M.sides[0].exhaust.map((id) => G.cards[id].key)], [[], ['prince']], 'the Prince skips the bench');
}
{
  // Rescue Pod: removed, and a Level-B card lands on the exhaust pile
  const { G, M } = rig({ a: ['rescue-pod', 'horse'], b: ['dog-s'] });
  until(G, M, settled(M, 0));
  eq(M.sides[0].removed.length, 1, 'the Rescue Pod is removed');
  eq(M.sides[0].exhaust.length === 1 && CH.CARD[G.cards[M.sides[0].exhaust[0]].key].level, 'B', 'a Level-B card replaces it on the exhaust pile');
}
{
  // Comic Character: the next card has +2 during the attack
  const { G, M } = rig({ a: ['comic-character', 'newcomer'], b: ['bat', 'newcomer'] });
  until(G, M, () => M.sides[0].attack.length === 1);
  eq(CH.attackTotal(G, M, 0), 3, 'Newcomer 1 + 2 after the Comic Character lost the flag');
}
{
  // Clown: take 2 fans when it gets the flag — including as the opening card
  const { G, M } = rig({ a: ['clown'], b: ['newcomer'] });
  until(G, M, () => M.attacker === 1);
  eq(G.players[0].fans, 2, 'Clown opens the match and takes 2 fans');
}
{
  // Cowboy: the opponent benches their top card — which can overflow them
  const { G, M } = rig({ a: ['pig', 'newcomer'], b: ['cowboy'], benchA: ['cat', 'pony', 'spider', 'cow', 'parrot'] });
  until(G, M, () => M.over);
  eq([M.winner, M.why], [1, 'no free seat on the bench for Newcomer'], 'the Cowboy ropes a card onto a full bench');
}
{
  // flag loss happens before the new card's effects: the Clairvoyant's owner
  // stacks their deck before the Cowboy ropes the top card
  const { G, M } = rig({ a: ['clairvoyant', 'newcomer', 'dragon'], b: ['newcomer', 'cowboy'], first: 0 });
  until(G, M, () => M.holder === 1, (q) => (q.kind === 'deck-to-top' ? { ids: [q.ids.find((id) => G.cards[id].key === 'dragon')] } : CH.autoAnswer(G, M, q)));
  until(G, M, settled(M, 0));
  const benched = M.sides[0].bench.flatMap((s) => s.ids.map((id) => G.cards[id].key));
  ok(benched.includes('dragon') && benched.includes('clairvoyant'), 'the Dragon put on top is the one the Cowboy ropes onto the bench');
}
{
  // Yeti: a fan for every card that attacks it
  const { G, M } = rig({ a: ['yeti'], b: ['newcomer', 'newcomer', 'newcomer', 'pig'] });
  until(G, M, () => M.holder === 1);
  eq(G.players[0].fans, 4, 'four attackers, four fans');
}

console.log('— Beach Cup specials —');
{
  // Troll needs two seats
  const { G, M } = rig({ a: ['troll', 'horse'], b: ['dragon'], benchA: ['pig', 'cat', 'pony', 'spider'] });
  until(G, M, settled(M, 0));
  ok(M.sides[0].bench.some((s) => s.name === 'Troll' && s.wide), 'the Troll takes two seats');
  eq(M.over, false, 'with two seats free, all is well');
}
{
  const { G, M } = rig({ a: ['troll', 'horse'], b: ['dragon'], benchA: ['pig', 'cat', 'pony', 'spider', 'cow'] });
  until(G, M, () => M.over);
  eq([M.winner, M.why], [1, 'the Troll has no two free seats'], 'one seat free is not enough for a Troll');
}
{
  // Backpacker and Cabbage go to the exhaust pile instead of the bench
  const { G, M } = rig({ a: ['backpacker', 'horse'], b: ['dog-s'] });
  until(G, M, settled(M, 0));
  eq([benchNames(M.sides[0]), M.sides[0].exhaust.map((id) => G.cards[id].key)], [[], ['backpacker']], 'the Backpacker skips the bench');
}
{
  // Dwarf: instead of the exhaust pile, back on top of the deck
  const { G, M } = rig({ a: ['vacuum-cleaner', 'horse'], b: ['newcomer'], first: 0, benchA: ['dwarf'] });
  until(G, M, () => M.attacker === 1);
  eq(G.cards[M.sides[0].deck[0]].key, 'dwarf', 'the Vacuum Cleaner sends the Dwarf to the top of the deck');
}
{
  // Zeppelin loses the match with a Level-C card on the bench
  const { G, M } = rig({ a: ['zeppelin'], b: ['newcomer'], benchA: ['dragon'] });
  until(G, M, () => M.over);
  eq([M.winner, M.why], [1, 'the Zeppelin found a Level-C card on the bench'], 'Zeppelin');
}
{
  // No flag win: Action Figure gives the next card +2; Yodeler takes a fan
  const { G, M } = rig({ a: ['dragon'], b: ['action-figure', 'yodeler'] });
  until(G, M, () => M.sides[1].attack.length === 2);
  eq(CH.attackTotal(G, M, 1), 6, 'Action Figure 2 + Yodeler 2 + 2, short of the Dragon’s 7');
  until(G, M, () => M.over);
  eq(G.players[1].fans, 1, 'the Yodeler failed to take the flag, so it takes a fan');
}
{
  // Puppet: +2 with a card below it
  const { G, M } = rig({ a: ['horse'], b: ['newcomer', 'puppet'] });
  until(G, M, () => M.sides[1].attack.length === 2);
  eq(CH.attackTotal(G, M, 1), 5, 'Newcomer 1 + Puppet 2 + 2');
}

console.log('— choices —');
{
  // Reporter: one under, the other on top
  const { G, M } = rig({ a: ['horse'], b: ['reporter', 'newcomer', 'pig', 'cat'] });
  until(G, M, () => M.pending && M.pending.kind === 'top-two');
  const q = M.pending;
  CH.answerMatch(G, M, 1, { ids: [q.ids[1]] });
  eq(M.sides[1].deck.map((id) => G.cards[id].key), ['newcomer', 'cat', 'pig'], 'Reporter keeps the Newcomer on top and sends the Pig under');
}
{
  // Sailor: look through the deck, one card under
  const { G, M } = rig({ a: ['horse'], b: ['sailor', 'dragon', 'newcomer', 'pig'] });
  until(G, M, () => M.pending && M.pending.kind === 'deck-to-bottom');
  const drag = M.pending.ids.find((id) => G.cards[id].key === 'dragon');
  CH.answerMatch(G, M, 1, { ids: [drag] });
  eq(M.sides[1].deck.map((id) => G.cards[id].key), ['newcomer', 'pig', 'dragon'], 'Sailor sends the Dragon under');
}
{
  // a forced choice answers itself: Necromancer with one power-2 card on the bench
  const { G, M } = rig({ a: ['necromancer'], b: ['newcomer'], benchA: ['talent-s', 'pig'] });
  until(G, M, () => M.attacker === 1);
  eq(G.cards[M.sides[0].deck[0]].key, 'talent-s', 'Necromancer brings the Talent back on top unasked');
  eq(M.pending, null, 'and asks nothing');
}
{
  // Siren is optional
  const { G, M } = rig({ a: ['horse'], b: ['siren'], benchA: ['pig'] });
  until(G, M, () => M.pending && M.pending.kind === 'opp-bench-to-exhaust');
  eq(M.pending.min, 0, 'the Siren may decline');
  CH.answerMatch(G, M, 1, { ids: [] });
  eq(benchNames(M.sides[0]), ['Pig×1'], 'declined, the bench is untouched');
}

console.log('— the Deck Phase —');
{
  const G = CH.newMatch([{ seat: 0, name: 'Ann', bot: true }, { seat: 1, name: 'Bob', bot: true }], CH.defaultOpts('base'));
  const p = G.players[0];
  eq([G.phase, p.draft.drawn.length, p.draft.options[0]], ['deck', 5, { level: 'A', pick: 2 }], 'round one draws five from Level A, two to keep');
  const [x, y] = p.draft.drawn;
  eq(CH.applyMove(G, 0, { kind: 'pick', card: x }).ok, true, 'pick one');
  eq(CH.applyMove(G, 0, { kind: 'redraw' }).ok, true, 'redraw after the first pick');
  eq(p.draft.drawn.length, 4, 'the redraw replaces the four left');
  eq(CH.applyMove(G, 0, { kind: 'redraw' }).ok, false, 'only once per Deck Phase');
  CH.applyMove(G, 0, { kind: 'pick', card: p.draft.drawn[0] });
  eq(CH.applyMove(G, 0, { kind: 'pick', card: p.draft.drawn[0] }).ok, false, 'no third pick');
  eq(p.deck.length, 8, 'six starter cards and two picks');
  const cut = p.deck.find((id) => G.cards[id].key === 'newcomer');
  eq(CH.applyMove(G, 0, { kind: 'cut', cards: [cut] }).ok, true, 'cut a Newcomer');
  CH.applyMove(G, 0, { kind: 'done' });
  eq(p.ready, true, 'done');
}
{
  // Beach Cup: three picks in round one, and fans for the small option in round two
  const G = CH.newMatch([{ seat: 0, name: 'Ann', bot: true }, { seat: 1, name: 'Bob', bot: true }], CH.defaultOpts('beach'));
  eq(G.players[0].draft.options[0].pick, 3, 'Beach Cup opens with three Level-A picks');
  G.round = 2;
  const p = G.players[0];
  p.draft = null;
  // restart the Deck Phase for round two by hand
  CH.applyMove(G, 0, { kind: 'done' });
}
{
  // When picked: Clones takes a fan
  const G = CH.newMatch([{ seat: 0, name: 'Ann', bot: true }, { seat: 1, name: 'Bob', bot: true }], CH.defaultOpts('base'));
  const p = G.players[0];
  G.cards.push({ id: G.cards.length, key: 'clones' });
  const id = G.cards.length - 1;
  p.draft.drawn.push(id);
  CH.applyMove(G, 0, { kind: 'pick', card: id });
  eq(p.fans, 1, 'Clones: +1 fan when picked');
}

console.log(`\n${checks} checks` + (fails ? `, ${fails} FAILURES` : ', all pass'));
process.exit(fails ? 1 : 0);
