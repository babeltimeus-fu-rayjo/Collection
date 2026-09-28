// The card data, checked by arithmetic rather than by eye: the rulebooks say
// every additional set holds 40 cards and each basic set 20, and a mistyped
// count or a card filed under the wrong set breaks that.
import { SETS, BOXES, CARDS, CARD, STARTER, DRAFT, TROPHIES } from './cards.js';

let fails = 0;
const bad = (m) => { console.log('  **FAIL** ' + m); fails++; };

const total = (set) => CARDS.filter((c) => c.set === set && c.level !== 'S').reduce((s, c) => s + c.copies, 0);
for (const [key, box] of Object.entries(BOXES)) {
  for (const set of box.sets) if (total(set) !== 40) bad(`${SETS[set].name} holds ${total(set)} cards, not 40`);
  if (total(box.basic) !== 20) bad(`${SETS[box.basic].name} holds ${total(box.basic)} cards, not 20`);
  console.log(`  ${box.name}: ${box.sets.map((s) => `${SETS[s].name} ${total(s)}`).join(', ')}, ${SETS[box.basic].name} ${total(box.basic)}`);
  if (STARTER[key].length !== 6) bad(`${box.name} starter deck has ${STARTER[key].length} cards`);
  for (const k of STARTER[key]) if (!CARD[k] || CARD[k].level !== 'S') bad(`starter card ${k} is not an S card`);
  if (DRAFT[key].length !== 7) bad(`${box.name} draft plan has ${DRAFT[key].length} rounds`);
}

// the printed limits: "Level A cards have a base power up to 3, Level B up to 5
// and Level C up to 10" in the first box; 4, 7 and 11 in Beach Cup
const LIMIT = { base: { A: 3, B: 5, C: 10 }, beach: { A: 4, B: 7, C: 11 } };
for (const c of CARDS) {
  if (!SETS[c.set]) bad(`${c.name} names a set that does not exist`);
  if (c.level === 'S') continue;
  const box = SETS[c.set].box;
  if (c.power > LIMIT[box][c.level]) bad(`${c.name} (${c.level}) has power ${c.power}, above the ${LIMIT[box][c.level]} its box allows`);
  if (!(c.copies >= 1)) bad(`${c.name} has no copies`);
}
const keys = new Set();
for (const c of CARDS) { if (keys.has(c.key)) bad(`two cards share the key ${c.key}`); keys.add(c.key); }

if (TROPHIES.length !== 7 || TROPHIES.some((r) => r.length !== 4)) bad('there should be four Trophies for each of seven rounds');
for (let r = 1; r < 7; r++) {
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  if (sum(TROPHIES[r]) < sum(TROPHIES[r - 1])) bad(`round ${r + 1} Trophies are worth less than round ${r}'s`);
}

const distinct = new Set(CARDS.filter((c) => c.level !== 'S').map((c) => c.name));
console.log(`  ${CARDS.length} card faces, ${distinct.size} distinct names in the Level piles`);
console.log(fails ? `\n${fails} FAILURES` : '\nthe card data adds up');
process.exit(fails ? 1 : 0);
