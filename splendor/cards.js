// cards.js — the printed contents of Splendor (Marc André, Space Cowboys,
// 2014), as data.
//
// Where it came from:
//   cards    read one by one off photographs of the 90 printed cards — crops
//            of two photographs of the original edition's deck laid out, as
//            published with the charliebepositive/splendor-original-offline
//            project on GitHub. Every card here was read off its photograph,
//            and the list agrees card for card with that project's own
//            transcription and with the monk-time/splendor-fastest-win list.
//            Two other public lists (daniman/splendor-server and
//            filipmlynarski/splendor-ai) each disagree on two level-2 cards;
//            the photographs settle all four in favour of the list here.
//   nobles   four independent transcriptions agree on the ten tiles; a
//            review photograph of the contents (Geeky Hobbies) shows six of
//            them in full and the other four in part, all consistent.
//   rules    Space Cowboys' English rulebook (the 10th anniversary edition,
//            which keeps the original's cards and rules).
//
// The expansions are the current ones — The Silk Road (the Cities and the
// Trading Posts) and The Sun Never Sets (the Orient and the Strongholds) —
// not the 2017 Cities of Splendor, which differs in its Orient cards, some
// Cities and one Trading Post:
//   rules    the two rulebooks on Space Cowboys' site.
//   Orient cards, City tiles, Noble names
//            Board Game Arena's licensed Splendor, released with the boxes in
//            2025 — the tables its game sends to every table. Its base deck
//            and its ten Nobles agree card for card with the ones above, every
//            Orient card in the publisher's product photographs agrees with
//            it, and so does every City side those photographs show (one side
//            of each tile, and the two new Nobles).
//   Trading Posts
//            the Silk Road rulebook, which gives each tile's requirement and
//            power; Board Game Arena's tiles and the product photographs agree.

// The five gems, in the order the cards print their cost circles, and Gold.
export const GEMS = ['diamond', 'sapphire', 'emerald', 'ruby', 'onyx'];
export const GOLD = 'gold';
export const TOKENS = [...GEMS, GOLD];
export const GEM = {
  diamond: { name: 'Diamond', color: 'white', letter: 'D' },
  sapphire: { name: 'Sapphire', color: 'blue', letter: 'S' },
  emerald: { name: 'Emerald', color: 'green', letter: 'E' },
  ruby: { name: 'Ruby', color: 'red', letter: 'R' },
  onyx: { name: 'Onyx', color: 'black', letter: 'O' },
  gold: { name: 'Gold', color: 'yellow', letter: 'G' },
};
const BY_LETTER = Object.fromEntries(GEMS.map((g) => [GEM[g].letter, g]));

// 'D3 S1 O1' → { diamond: 3, sapphire: 1, onyx: 1 }
export function parseCost(s) {
  const out = {};
  for (const t of s.split(' ')) out[BY_LETTER[t[0]]] = Number(t.slice(1));
  return out;
}

// Each line: the card's colour (the bonus it gives), its level, then every
// card of that colour and level as [cost, Prestige points].
const CARD_ROWS = [
  ['diamond', 1, [['S3', 0], ['E4', 1], ['R2 O1', 0], ['S2 O2', 0], ['D3 S1 O1', 0], ['S2 E2 O1', 0], ['S1 E1 R1 O1', 0], ['S1 E2 R1 O1', 0]]],
  ['sapphire', 1, [['O3', 0], ['R4', 1], ['D1 O2', 0], ['E2 O2', 0], ['S1 E3 R1', 0], ['D1 E2 R2', 0], ['D1 E1 R1 O1', 0], ['D1 E1 R2 O1', 0]]],
  ['emerald', 1, [['R3', 0], ['O4', 1], ['D2 S1', 0], ['S2 R2', 0], ['D1 S3 E1', 0], ['S1 R2 O2', 0], ['D1 S1 R1 O1', 0], ['D1 S1 R1 O2', 0]]],
  ['ruby', 1, [['D3', 0], ['D4', 1], ['S2 E1', 0], ['D2 R2', 0], ['D1 R1 O3', 0], ['D2 E1 O2', 0], ['D1 S1 E1 O1', 0], ['D2 S1 E1 O1', 0]]],
  ['onyx', 1, [['E3', 0], ['S4', 1], ['E2 R1', 0], ['D2 E2', 0], ['E1 R3 O1', 0], ['D2 S2 R1', 0], ['D1 S1 E1 R1', 0], ['D1 S2 E1 R1', 0]]],
  ['diamond', 2, [['R5', 2], ['D6', 3], ['R5 O3', 2], ['E1 R4 O2', 2], ['E3 R2 O2', 1], ['D2 S3 R3', 1]]],
  ['sapphire', 2, [['S5', 2], ['S6', 3], ['D5 S3', 2], ['D2 R1 O4', 2], ['S2 E2 R3', 1], ['S2 E3 O3', 1]]],
  ['emerald', 2, [['E5', 2], ['E6', 3], ['S5 E3', 2], ['D4 S2 O1', 2], ['D2 S3 O2', 1], ['D3 E2 R3', 1]]],
  ['ruby', 2, [['O5', 2], ['R6', 3], ['D3 O5', 2], ['D1 S4 E2', 2], ['D2 R2 O3', 1], ['S3 R2 O3', 1]]],
  ['onyx', 2, [['D5', 2], ['O6', 3], ['E5 R3', 2], ['S1 E4 R2', 2], ['D3 S2 E2', 1], ['D3 E3 O2', 1]]],
  ['diamond', 3, [['O7', 4], ['D3 R3 O6', 4], ['S3 E3 R5 O3', 3], ['D3 O7', 5]]],
  ['sapphire', 3, [['D7', 4], ['D6 S3 O3', 4], ['D3 E3 R3 O5', 3], ['D7 S3', 5]]],
  ['emerald', 3, [['S7', 4], ['D3 S6 E3', 4], ['D5 S3 R3 O3', 3], ['S7 E3', 5]]],
  ['ruby', 3, [['E7', 4], ['S3 E6 R3', 4], ['D3 S5 E3 O3', 3], ['E7 R3', 5]]],
  ['onyx', 3, [['R7', 4], ['E3 R6 O3', 4], ['D3 S3 E5 R3', 3], ['R7 O3', 5]]],
];

export const CARDS = CARD_ROWS.flatMap(([bonus, level, list]) => list.map(([cost, points]) => ({ level, bonus, points, cost: parseCost(cost) })));

// The ten Noble tiles: the bonuses each one asks for. Each is worth 3.
export const NOBLE_POINTS = 3;
export const NOBLES = ['E4 R4', 'D3 R3 O3', 'D4 S4', 'D4 O4', 'S4 E4', 'S3 E3 R3', 'D3 S3 E3', 'R4 O4', 'D3 S3 O3', 'E3 R3 O3'].map(parseCost);
// who each one is in the current edition
export const NOBLE_NAMES = ['Qaitbay', 'Catherine de Medicis', 'Mariam Uz Zamani', 'Louise de Savoie', 'Queen Munjeong', 'Askia Muhammad I', 'Ang Chan', 'Zhu Houzong', 'Charles Quint', 'Roxelana'];
// the Noble each expansion box adds
export const EXTRA_NOBLES = [
  { req: parseCost('S3 E3 O3'), name: 'Rani Chennabhairadevi', box: 'The Silk Road' },
  { req: parseCost('D4 R4'), name: 'Hino Tomiko', box: 'The Sun Never Sets' },
];

// ---------------------------------------------------------------- The Sun Never Sets: the Orient
//
// Thirty Orient cards, ten a level, each a kind:
//   gold       no colour and no bonus; discarded during a purchase, it pays
//              as 2 Gold for that purchase alone
//   copy       takes the colour and bonus of a card you own, chosen when you
//              buy it (you must own a card with a bonus to buy it)
//   copytake   a copy card that also takes a face-up level-1 card for free
//   double     two bonuses of its colour — still one card for every condition
//   take       takes a face-up level-2 card for free
//   sacrifice  paid by discarding two cards of the colour shown, not in gems
const ORIENT_ROWS = [
  ['copy', 1, null, [['D3 R2', 0], ['S2 R3', 0], ['S3 E2', 0], ['E3 O2', 0], ['D2 O3', 0]]],
  ['gold', 1, null, [['R3', 0], ['E3', 0], ['S3', 0], ['D3', 0], ['O3', 0]]],
  ['double', 2, 'diamond', [['E3 R4', 1]]],
  ['double', 2, 'sapphire', [['R3 O4', 1]]],
  ['double', 2, 'emerald', [['D4 O3', 1]]],
  ['double', 2, 'ruby', [['D3 S4', 1]]],
  ['double', 2, 'onyx', [['S3 E4', 1]]],
  ['copytake', 2, null, [['D1 E3 R4', 1], ['S4 R1 O3', 1], ['E1 R3 O4', 1], ['D3 S1 E4', 1], ['D4 S3 O1', 1]]],
  ['sacrifice', 3, 'onyx', [['S2', 3]]],
  ['sacrifice', 3, 'emerald', [['O2', 3]]],
  ['sacrifice', 3, 'ruby', [['D2', 3]]],
  ['sacrifice', 3, 'diamond', [['E2', 3]]],
  ['sacrifice', 3, 'sapphire', [['R2', 3]]],
  ['take', 3, 'diamond', [['S6 E3 R1', 1]]],
  ['take', 3, 'sapphire', [['E6 R3 O1', 1]]],
  ['take', 3, 'emerald', [['D1 R6 O3', 1]]],
  ['take', 3, 'ruby', [['D3 S1 O6', 1]]],
  ['take', 3, 'onyx', [['D6 S3 E1', 1]]],
];
export const ORIENT = ORIENT_ROWS.flatMap(([kind, level, bonus, list]) => list.map(([cost, points]) => {
  const c = { level, bonus, points, kind, orient: true, cost: kind === 'sacrifice' ? {} : parseCost(cost) };
  if (kind === 'sacrifice') c.discard = BY_LETTER[cost[0]];
  if (kind === 'copytake') c.take = 1;
  if (kind === 'take') c.take = 2;
  return c;
}));
export const ORIENT_MARKET = 2;

// ---------------------------------------------------------------- The Silk Road
//
// Seven double-sided City tiles. `any` asks for that many cards of one
// colour — a colour none of the tile's other demands names.
const city = (points, cost, any = 0) => ({ points, req: cost ? parseCost(cost) : {}, any });
export const CITIES = [
  { place: 'Amboise', ruler: 'François Ier', sides: [city(13, 'E3 O4'), city(13, 'R4 O3')] },
  { place: 'Timbuktu', ruler: 'Al-Qadi Aqib ibn Mahmud ibn Umar', sides: [city(13, 'D3 S4'), city(13, 'D4 R3')] },
  { place: 'Krakow', ruler: 'Elisabeth von Habsburg', sides: [city(17, ''), city(16, 'D1 S1 E1 R1 O1')] },
  // the second side is the one City side no photograph of the tiles has
  // shown; Board Game Arena has it twice — text and code agree on this one
  { place: 'Madrid', ruler: 'Isabella the Catholic', sides: [city(12, 'S3 E3 R3 O3'), city(12, 'D3 S3 E3 R3')] },
  { place: 'Samarkand', ruler: 'Muhammad Shaybani Khan', sides: [city(14, 'D4', 4), city(14, 'O4', 4)] },
  { place: 'Seoul', ruler: 'Sejong the Great', sides: [city(15, '', 5), city(13, '', 6)] },
  { place: 'Delhi', ruler: 'Bega Begum', sides: [city(13, 'S3 E4'), city(14, 'D2 S2 E2 R2 O2')] },
];
export const CITIES_IN_PLAY = 3;

// The five Trading Posts: the cards each asks for, and its power.
export const TRADING_POSTS = [
  { req: parseCost('D1 R3'), power: 'gem', text: 'After you buy a card, take 1 gem of any colour — not Gold. It may be one you just spent.' },
  { req: parseCost('D2'), power: 'third', text: 'After you take 2 gems of one colour, take 1 gem of another colour — not Gold.' },
  { req: parseCost('S3 O1'), power: 'gold', text: 'Each Gold you spend when you buy a card is worth 2 gems of one colour.' },
  { req: parseCost('O3'), power: 'draw2', text: 'When you reserve the top card of a deck, draw 2, keep 1 and put the other at the bottom of that deck.' },
  { req: parseCost('E5'), power: 'points', text: '1 Prestige point for every Trading Post you have, this one included.' },
];

// The Strongholds: three for each player.
export const STRONGHOLDS = 3;

// Setup by the number of players: Gem tokens of each colour (7, less 2 at
// three players, less 3 at two), Gold always 5, Nobles one more than players.
export const GEMS_FOR = { 2: 4, 3: 5, 4: 7 };
export const GOLD_TOKENS = 5;
export const NOBLES_FOR = (n) => n + 1;
export const MARKET = 4;
export const WIN_POINTS = 15;
export const TOKEN_LIMIT = 10;
export const RESERVE_LIMIT = 3;
