// The card data against dV Giochi's own list: 80 playing cards with the
// copies, suits and values it gives, the weapons' ranges, the 16 characters'
// life points, and the roles for each table size.
import { DECK, KINDS, CHARACTERS, ROLES_FOR, SUITS, RANKS } from './cards.js';

let fails = 0;
const bad = (m) => { console.log('  **FAIL** ' + m); fails++; };
const eq = (got, want, what) => { if (JSON.stringify(got) !== JSON.stringify(want)) bad(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };

// the card list as the publisher prints it (bang.dvgiochi.com/cardslist.php?id=1)
const LIST = {
  barrel: 'Q♠ K♠', dynamite: '2♥', jail: 'J♠ 4♥ 10♠', mustang: '8♥ 9♥', remington: 'K♣', carabine: 'A♣',
  schofield: 'J♣ Q♣ K♠', scope: 'A♠', volcanic: '10♠ 10♣', winchester: '8♠',
  bang: 'A♠ 2♦ 3♦ 4♦ 5♦ 6♦ 7♦ 8♦ 9♦ 10♦ J♦ Q♦ K♦ A♦ 2♣ 3♣ 4♣ 5♣ 6♣ 7♣ 8♣ 9♣ Q♥ K♥ A♥',
  beer: '6♥ 7♥ 8♥ 9♥ 10♥ J♥', catbalou: 'K♥ 9♦ 10♦ J♦', duel: 'Q♦ J♠ 8♣', gatling: '10♥', generalstore: '9♣ Q♠',
  indians: 'K♦ A♦', missed: '10♣ J♣ Q♣ K♣ A♣ 2♠ 3♠ 4♠ 5♠ 6♠ 7♠ 8♠', panic: 'J♥ Q♥ A♥ 8♦', saloon: '5♥',
  stagecoach: '9♠ 9♠', wellsfargo: '3♥',
};
eq(DECK.length, 80, 'the deck holds 80 playing cards');
const mine = {};
for (const [k, s, r] of DECK) {
  if (!KINDS[k]) bad(`unknown card ${k}`);
  if (!SUITS[s] || !RANKS.includes(r)) bad(`${k} has a bad suit or value: ${s} ${r}`);
  (mine[k] ||= []).push(`${r}${SUITS[s]}`);
}
for (const [k, want] of Object.entries(LIST)) eq((mine[k] || []).join(' '), want, `${KINDS[k].name}'s copies, suits and values`);
eq(Object.keys(mine).sort(), Object.keys(LIST).sort(), 'every kind of card, and no others');
eq(DECK.filter(([k]) => KINDS[k].color === 'blue').length, 17, 'seventeen blue cards');
eq(Object.fromEntries(Object.entries(KINDS).filter(([, k]) => k.weapon).map(([key, k]) => [key, k.range])), { volcanic: 1, schofield: 2, remington: 3, carabine: 4, winchester: 5 }, 'the weapons’ sights');
eq(Object.keys(CHARACTERS).length, 16, 'sixteen characters');
eq(Object.entries(CHARACTERS).filter(([, c]) => c.life === 3).map(([k]) => k).sort(), ['gringo', 'paul'], 'El Gringo and Paul Regret have three bullets, the rest four');
eq(Object.values(CHARACTERS).every((c) => c.life === 3 || c.life === 4), true, 'every character has three or four');
eq(Object.fromEntries(Object.entries(ROLES_FOR).map(([n, r]) => [n, { sheriff: r.filter((x) => x === 'sheriff').length, deputy: r.filter((x) => x === 'deputy').length, outlaw: r.filter((x) => x === 'outlaw').length, renegade: r.filter((x) => x === 'renegade').length }])),
  { 4: { sheriff: 1, deputy: 0, outlaw: 2, renegade: 1 }, 5: { sheriff: 1, deputy: 1, outlaw: 2, renegade: 1 }, 6: { sheriff: 1, deputy: 1, outlaw: 3, renegade: 1 }, 7: { sheriff: 1, deputy: 2, outlaw: 3, renegade: 1 } }, 'the roles for 4 to 7 players');
console.log(fails ? `\n${fails} FAILURES` : 'the cards are the publisher’s, card for card');
process.exit(fails ? 1 : 0);
