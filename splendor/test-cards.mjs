// The cards and Nobles against what the printed game shows: the counts on the
// box, the shapes every colour shares, and the four cards the public lists
// disagree on, as their photographs read.
import { CARDS, NOBLES, GEMS, GEMS_FOR, GOLD_TOKENS } from './cards.js';

let fails = 0;
const eq = (got, want, what) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) { console.log(`  **FAIL** ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); fails++; }
};
const count = (f) => CARDS.filter(f).length;

// "90 Development cards: 40 Level 1, 30 Level 2, 20 Level 3"
eq(CARDS.length, 90, '90 Development cards');
eq([1, 2, 3].map((l) => count((c) => c.level === l)), [40, 30, 20], '40, 30 and 20 cards a level');
for (const g of GEMS) eq([1, 2, 3].map((l) => count((c) => c.level === l && c.bonus === g)), [8, 6, 4], `${g}: 8, 6 and 4 cards a level`);

// every colour has the same cards, colour for colour: the same points and
// the same cost shape (the amounts, whichever gems they are in)
const shape = (c) => `${c.points}:${Object.values(c.cost).sort((a, b) => b - a).join('-')}`;
for (const l of [1, 2, 3]) {
  const ref = CARDS.filter((c) => c.level === l && c.bonus === 'diamond').map(shape).sort();
  for (const g of GEMS) eq(CARDS.filter((c) => c.level === l && c.bonus === g).map(shape).sort(), ref, `level ${l}: ${g} has the same shapes as diamond`);
}
eq([1, 2, 3].map((l) => [...new Set(CARDS.filter((c) => c.level === l).map((c) => c.points))].sort()), [[0, 1], [1, 2, 3], [3, 4, 5]], 'points by level');
eq(CARDS.every((c) => Object.values(c.cost).every((v) => v >= 1 && v <= 7)), true, 'every cost circle reads 1 to 7');

// the four cards two public lists get wrong, as the photographs show them
const has = (level, bonus, points, cost) => CARDS.some((c) => c.level === level && c.bonus === bonus && c.points === points && JSON.stringify(c.cost) === JSON.stringify(cost));
eq(has(2, 'onyx', 2, { diamond: 5 }), true, 'the 2-point Onyx card costs 5 Diamonds');
eq(has(2, 'emerald', 1, { diamond: 3, emerald: 2, ruby: 3 }), true, 'the 1-point Emerald card costs 3 Diamonds, 2 Emeralds and 3 Rubies');
eq(has(2, 'sapphire', 2, { diamond: 2, ruby: 1, onyx: 4 }), true, 'the 2-point Sapphire card costs 2 Diamonds, a Ruby and 4 Onyx');
eq(has(2, 'diamond', 2, { emerald: 1, ruby: 4, onyx: 2 }), true, 'the 2-point Diamond card costs an Emerald, 4 Rubies and 2 Onyx');

// "10 Noble tiles": five ask for 4 + 4 of two colours, five for 3 + 3 + 3 of
// three — neighbours in the order the cards print the gems, round the circle
eq(NOBLES.length, 10, '10 Noble tiles');
const idx = (n) => Object.keys(n).map((g) => GEMS.indexOf(g)).sort((a, b) => a - b);
const pairs = NOBLES.filter((n) => Object.values(n).every((v) => v === 4) && Object.keys(n).length === 2);
const triples = NOBLES.filter((n) => Object.values(n).every((v) => v === 3) && Object.keys(n).length === 3);
eq([pairs.length, triples.length], [5, 5], 'five 4 + 4 Nobles and five 3 + 3 + 3');
const circular = (n) => { const ix = idx(n); return ix.filter((i) => !ix.includes((i + 4) % 5)).length === 1; };
eq(NOBLES.every(circular), true, 'each Noble asks for neighbouring colours');
eq(new Set(NOBLES.map((n) => JSON.stringify(n))).size, 10, 'no two Nobles alike');

// "7 Diamond, 7 Sapphire, 7 Emerald, 7 Ruby, 7 Onyx, 5 Gold" — 2 fewer of
// each gem at three players, 3 fewer at two
eq([GEMS_FOR[4], GEMS_FOR[3], GEMS_FOR[2], GOLD_TOKENS], [7, 5, 4, 5], 'tokens by table size');

console.log(fails ? `${fails} FAILURES` : 'the deck and the Nobles are the printed ones');
process.exit(fails ? 1 : 0);
