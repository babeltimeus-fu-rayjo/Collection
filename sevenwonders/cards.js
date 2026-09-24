// cards.js — the printed content of 7 Wonders, as data. SECOND EDITION (2020),
// throughout: base game, Leaders and Cities.
//
// That matters, because the second edition is a rebalance and not a reprint.
// Against the first edition the base deck gains Well, Ludus and Castrum and
// loses the Pawnshop; three blue cards are worth a point more; the blue chains
// are rewired; the Strategists Guild becomes the Decorators; three guild costs
// change; 27 of the 44 figures on the wonder boards change, Babylon's night
// side losing a stage outright; and Olympia stops copying guilds. Mixing the
// two editions is the one thing that gives you neither.
//
// Where it came from, and how far it was checked:
//   base cards   the 7 Wonders wiki's List of Age Cards, whose per-player
//                columns are what the `at` arrays below are. Verified by
//                arithmetic rather than by eye: every Age deals exactly seven
//                cards a player at every count from three to seven, which the
//                numbers cannot do by accident.
//   chains       the wiki's Chains page, which agrees with the chain list the
//                publisher gives away as a PDF.
//   guilds       the wiki's guild table.
//   wonders      the wiki's wonder pages. Alexandria's day side is the only
//                board the publisher's own rulebook prints, and it matches.
//   Leaders      the Leader Cards page, diffed name-for-name and cost-for-cost.
//   Cities       the black cards on List of Cards, diffed the same way.
//
// Nothing in here knows how to play the game; game.js reads it. Keeping the
// deck as a table means an expansion is a block of rows rather than a branch in
// the engine, and it means the structural invariants (an Age deals exactly
// 7 cards per player, Age III holds player-count + 2 guilds) can be asserted in
// a test instead of trusted.
//
// Resources are single letters so a cost reads at a glance:
//   W wood   S stone   C clay   O ore        (raw, brown)
//   G glass  P papyrus T textile             (manufactured, grey)
//
// Card fields, all optional except n/c/at:
//   n        name
//   c        colour: brown grey blue yellow red green purple black white
//   at       player counts that each add one copy — [3,5] means one copy at a
//            3-player table and a second once there are 5
//   cost     resource letters, e.g. 'SSS'
//   coin     coins the card costs to build
//   give     what it produces: 'WW' for two wood, 'W/C' for a choice
//   vp       victory points at the end
//   shield   military strength
//   sci      science symbol: compass, gear, tablet, or any (a wildcard)
//   coins    coins paid immediately on build
//   trade    discounted trading: { with: 'left'|'right'|'both', kind: 'raw'|'man' }
//   per      a payout counted at build time or scored at the end — see game.js
//   free     name of a card that lets you build this one for nothing (chaining)
//   debt     Cities: coins of debt handed to each neighbour
//   diplo    Cities: diplomacy tokens gained

export const RAW = 'WSCO';
export const MANUFACTURED = 'GPT';
export const RESOURCES = RAW + MANUFACTURED;

export const RES_NAME = {
  W: 'Wood', S: 'Stone', C: 'Clay', O: 'Ore',
  G: 'Glass', P: 'Papyrus', T: 'Textile',
};

export const COLOUR_NAME = {
  brown: 'Raw materials', grey: 'Manufactured goods', blue: 'Civilian',
  yellow: 'Commercial', red: 'Military', green: 'Science', purple: 'Guild',
  black: 'City', white: 'Leader',
};

// ---------------------------------------------------------------- Age I

const AGE1 = [
  // brown — raw materials
  { n: 'Lumber Yard',   c: 'brown', at: [3, 4],       give: 'W' },
  { n: 'Ore Vein',      c: 'brown', at: [3, 4],       give: 'O' },
  { n: 'Stone Pit',     c: 'brown', at: [3, 5],       give: 'S' },
  { n: 'Clay Pool',     c: 'brown', at: [3, 5],       give: 'C' },
  { n: 'Timber Yard',   c: 'brown', at: [3],    coin: 1, give: 'W/S' },
  { n: 'Clay Pit',      c: 'brown', at: [3],    coin: 1, give: 'O/C' },
  { n: 'Excavation',    c: 'brown', at: [4],    coin: 1, give: 'S/C' },
  { n: 'Forest Cave',   c: 'brown', at: [5],    coin: 1, give: 'W/O' },
  { n: 'Tree Farm',     c: 'brown', at: [6],    coin: 1, give: 'W/C' },
  { n: 'Mine',          c: 'brown', at: [6],    coin: 1, give: 'S/O' },

  // grey — manufactured goods
  { n: 'Glassworks', c: 'grey', at: [3, 6], give: 'G' },
  { n: 'Press',      c: 'grey', at: [3, 6], give: 'P' },
  { n: 'Loom',       c: 'grey', at: [3, 6], give: 'T' },

  // blue — civilian
  { n: 'Altar',   c: 'blue', at: [3, 5],           vp: 3, chains: ['Pantheon'] },
  { n: 'Theater', c: 'blue', at: [3, 6],           vp: 3, chains: ['Gardens'] },
  { n: 'Well',    c: 'blue', at: [4, 7],           vp: 3, chains: ['Statue'] },
  { n: 'Baths',   c: 'blue', at: [3, 7], cost: 'S', vp: 3, chains: ['Aqueduct'] },

  // yellow — commercial
  { n: 'Tavern',             c: 'yellow', at: [4, 5, 7], coins: 5 },
  { n: 'East Trading Post',  c: 'yellow', at: [3, 7], trade: { with: 'right', kind: 'raw' }, chains: ['Forum'] },
  { n: 'West Trading Post',  c: 'yellow', at: [3, 7], trade: { with: 'left',  kind: 'raw' }, chains: ['Forum'] },
  { n: 'Marketplace',        c: 'yellow', at: [3, 6], trade: { with: 'both',  kind: 'man' }, chains: ['Caravansery'] },

  // red — military
  { n: 'Guard Tower', c: 'red', at: [3, 4], cost: 'C', shield: 1 },
  { n: 'Barracks',    c: 'red', at: [3, 5], cost: 'O', shield: 1 },
  { n: 'Stockade',    c: 'red', at: [3, 7], cost: 'W', shield: 1 },

  // green — science
  { n: 'Scriptorium', c: 'green', at: [3, 4], cost: 'P', sci: 'tablet',  chains: ['Courthouse', 'Library'] },
  { n: 'Apothecary',  c: 'green', at: [3, 5], cost: 'T', sci: 'compass', chains: ['Stables', 'Dispensary'] },
  { n: 'Workshop',    c: 'green', at: [3, 7], cost: 'G', sci: 'gear',    chains: ['Archery Range', 'Laboratory'] },
];

// ---------------------------------------------------------------- Age II

const AGE2 = [
  // brown
  { n: 'Sawmill',   c: 'brown', at: [3, 4], coin: 1, give: 'WW' },
  { n: 'Foundry',   c: 'brown', at: [3, 4], coin: 1, give: 'OO' },
  { n: 'Quarry',    c: 'brown', at: [3, 4], coin: 1, give: 'SS' },
  { n: 'Brickyard', c: 'brown', at: [3, 4], coin: 1, give: 'CC' },

  // grey
  { n: 'Glassworks', c: 'grey', at: [3, 5], give: 'G' },
  { n: 'Press',      c: 'grey', at: [3, 5], give: 'P' },
  { n: 'Loom',       c: 'grey', at: [3, 5], give: 'T' },

  // blue
  { n: 'Courthouse', c: 'blue', at: [3, 5], cost: 'CCT', vp: 4, free: 'Scriptorium' },
  { n: 'Temple',     c: 'blue', at: [3, 6], cost: 'CGW', vp: 4 },
  { n: 'Statue',     c: 'blue', at: [3, 7], cost: 'OOW', vp: 4, free: 'Well' },
  { n: 'Aqueduct',   c: 'blue', at: [3, 7], cost: 'SSS', vp: 5, free: 'Baths' },

  // yellow
  { n: 'Forum',       c: 'yellow', at: [3, 6, 7], cost: 'CC', give: 'G/P/T', free: 'East Trading Post', free2: 'West Trading Post', chains: ['Haven'] },
  { n: 'Caravansery', c: 'yellow', at: [3, 5, 6], cost: 'WW', give: 'W/S/O/C', free: 'Marketplace', chains: ['Lighthouse'] },
  { n: 'Vineyard',    c: 'yellow', at: [3, 6],   per: { coins: 1, of: 'brown', from: 'neighbours+self' } },
  { n: 'Bazaar',      c: 'yellow', at: [4, 7],   per: { coins: 2, of: 'grey',  from: 'neighbours+self' } },

  // red
  { n: 'Stables',         c: 'red', at: [3, 5],    cost: 'COW', shield: 2, free: 'Apothecary' },
  { n: 'Archery Range',   c: 'red', at: [3, 6],    cost: 'OWW', shield: 2, free: 'Workshop' },
  { n: 'Walls',           c: 'red', at: [3, 7],    cost: 'SSS', shield: 2, chains: ['Fortifications'] },
  { n: 'Training Ground', c: 'red', at: [4, 6, 7], cost: 'OOW', shield: 2, chains: ['Circus'] },

  // green
  { n: 'Dispensary', c: 'green', at: [3, 4], cost: 'GOO', sci: 'compass', free: 'Apothecary',  chains: ['Arena', 'Lodge'] },
  { n: 'Laboratory', c: 'green', at: [3, 5], cost: 'CCP', sci: 'gear',    free: 'Workshop',    chains: ['Siege Workshop', 'Observatory'] },
  { n: 'Library',    c: 'green', at: [3, 6], cost: 'SST', sci: 'tablet',  free: 'Scriptorium', chains: ['Senate', 'University'] },
  { n: 'School',     c: 'green', at: [3, 7], cost: 'PW',  sci: 'tablet',  chains: ['Academy', 'Study'] },
];

// ---------------------------------------------------------------- Age III

const AGE3 = [
  // blue
  { n: 'Gardens',   c: 'blue', at: [3, 4], cost: 'CCW',     vp: 5, free: 'Theater' },
  { n: 'Senate',    c: 'blue', at: [3, 5], cost: 'OSWW',    vp: 6, free: 'Library' },
  { n: 'Town Hall', c: 'blue', at: [3, 6], cost: 'GSSS',    vp: 6 },
  { n: 'Pantheon',  c: 'blue', at: [3, 6], cost: 'CCGOPT',  vp: 7, free: 'Altar' },
  { n: 'Palace',    c: 'blue', at: [3, 7], cost: 'CGOPSTW', vp: 8 },

  // yellow
  { n: 'Haven',               c: 'yellow', at: [3, 4], cost: 'OTW', free: 'Forum',       per: { coins: 1, vp: 1, of: 'brown',  from: 'self' } },
  { n: 'Lighthouse',          c: 'yellow', at: [3, 6], cost: 'GS',  free: 'Caravansery', per: { coins: 1, vp: 1, of: 'yellow', from: 'self' } },
  { n: 'Chamber of Commerce', c: 'yellow', at: [4, 6], cost: 'CCP',                      per: { coins: 2, vp: 2, of: 'grey',   from: 'self' } },
  { n: 'Ludus',               c: 'yellow', at: [5, 7], cost: 'OS',                       per: { coins: 3, vp: 1, of: 'red',    from: 'self' } },
  { n: 'Arena',               c: 'yellow', at: [3, 5], cost: 'CCO', free: 'Dispensary',  per: { coins: 3, vp: 1, of: 'stage',  from: 'self' } },

  // red
  { n: 'Fortifications', c: 'red', at: [3, 7], cost: 'COOO', shield: 3, free: 'Walls' },
  { n: 'Circus',         c: 'red', at: [4, 6], cost: 'CCCO', shield: 3, free: 'Training Ground' },
  { n: 'Arsenal',        c: 'red', at: [3, 5], cost: 'OTWW', shield: 3 },
  { n: 'Siege Workshop', c: 'red', at: [3, 5], cost: 'CCCW', shield: 3, free: 'Laboratory' },
  { n: 'Castrum',        c: 'red', at: [4, 7], cost: 'CCPW', shield: 3 },

  // green
  { n: 'Lodge',       c: 'green', at: [3, 6], cost: 'CCPT', sci: 'compass', free: 'Dispensary' },
  { n: 'Observatory', c: 'green', at: [3, 7], cost: 'GOOT', sci: 'gear',    free: 'Laboratory' },
  { n: 'University',  c: 'green', at: [3, 4], cost: 'GPWW', sci: 'tablet',  free: 'Library' },
  { n: 'Academy',     c: 'green', at: [3, 7], cost: 'GSSS', sci: 'compass', free: 'School' },
  { n: 'Study',       c: 'green', at: [3, 5], cost: 'PTW',  sci: 'gear',    free: 'School' },
];

// Guilds: ten exist, a game uses player-count + 2 of them, drawn at random and
// shuffled into Age III. They are the only cards that read another player's
// city — except the Decorators, who only ever look at your own wonder.
export const GUILDS = [
  { n: 'Workers Guild',      c: 'purple', cost: 'COOSW',  per: { vp: 1, of: 'brown',  from: 'neighbours' } },
  { n: 'Craftsmens Guild',   c: 'purple', cost: 'OSS',    per: { vp: 2, of: 'grey',   from: 'neighbours' } },
  { n: 'Magistrates Guild',  c: 'purple', cost: 'STWWW',  per: { vp: 1, of: 'blue',   from: 'neighbours' } },
  { n: 'Traders Guild',      c: 'purple', cost: 'GPT',    per: { vp: 1, of: 'yellow', from: 'neighbours' } },
  { n: 'Spies Guild',        c: 'purple', cost: 'CCG',    per: { vp: 1, of: 'red',    from: 'neighbours' } },
  { n: 'Philosophers Guild', c: 'purple', cost: 'CCCPT',  per: { vp: 1, of: 'green',  from: 'neighbours' } },
  { n: 'Shipowners Guild',   c: 'purple', cost: 'GPWWW',  per: { vp: 1, of: 'brown+grey+purple', from: 'self' } },
  { n: 'Scientists Guild',   c: 'purple', cost: 'OOPWW',  sci: 'any' },
  { n: 'Decorators Guild',   c: 'purple', cost: 'OOST',   vpIfWonder: 7 },
  { n: 'Builders Guild',     c: 'purple', cost: 'CCGSSS', per: { vp: 1, of: 'stage',  from: 'neighbours+self' } },
];

export const BASE_AGES = [AGE1, AGE2, AGE3];

// ---------------------------------------------------------------- wonders
//
// Each board has a day side (A) and a night side (B). A-sides follow one shape:
// 3 VP, something in the middle, 7 VP. B-sides are where the boards get their
// character, and several of them grant an ability rather than points:
//
//   freeFirstOfColour  the first card you build of each colour costs nothing
//   freeFirstOfAge     the first card you build in each Age costs nothing
//   freeLastOfAge      ... and so does the last one
//   playLast           play the seventh card of an Age instead of binning it,
//                      as a turn of your own after everyone else has finished
//   salvage            take the discard pile and build one card out of it free
//
// A stage that produces a resource produces it for you only — wonder production
// can't be sold to a neighbour, which is what notTrade marks.
//
// These are the SECOND edition boards. Every cost here was read from the
// 7 Wonders wiki's wonder pages; Alexandria's day side is the one board the
// publisher's own 2020 rulebook prints (page 2), and it matches. Note that
// Babylon's night side has two stages, not three, and that Olympia no longer
// copies a guild — the first edition's Strategists Guild went the same way.

export const WONDERS = [
  { n: 'Gizah', res: 'S', sides: {
    A: [{ cost: 'WW', vp: 3 }, { cost: 'CCT', vp: 5 }, { cost: 'SSSS', vp: 7 }],
    B: [{ cost: 'WW', vp: 3 }, { cost: 'SSS', vp: 5 }, { cost: 'CCC', vp: 5 }, { cost: 'PSSSS', vp: 7 }],
  } },
  { n: 'Babylon', res: 'W', sides: {
    A: [{ cost: 'CC', vp: 3 }, { cost: 'OOT', sci: 'any' }, { cost: 'WWWW', vp: 7 }],
    B: [{ cost: 'SS', act: 'playLast' }, { cost: 'CCCG', sci: 'any' }],
  } },
  { n: 'Olympia', res: 'C', sides: {
    A: [{ cost: 'SS', vp: 3 }, { cost: 'WW', act: 'freeFirstOfColour' }, { cost: 'CCC', vp: 7 }],
    B: [{ cost: 'OO', vp: 2, act: 'freeFirstOfAge' }, { cost: 'CCC', vp: 3, act: 'freeLastOfAge' }, { cost: 'GPT', vp: 5 }],
  } },
  { n: 'Rhodos', res: 'O', sides: {
    A: [{ cost: 'WW', vp: 3 }, { cost: 'CCC', shield: 2 }, { cost: 'OOOO', vp: 7 }],
    B: [{ cost: 'SSS', vp: 3, shield: 1, coins: 3 }, { cost: 'OOOO', vp: 4, shield: 1, coins: 4 }],
  } },
  { n: 'Alexandria', res: 'G', sides: {
    A: [{ cost: 'SS', vp: 3 }, { cost: 'OO', give: 'W/S/O/C', notTrade: true }, { cost: 'PT', vp: 7 }],
    B: [{ cost: 'CC', give: 'W/S/O/C', notTrade: true }, { cost: 'OOO', give: 'G/P/T', notTrade: true }, { cost: 'WWWW', vp: 7 }],
  } },
  { n: 'Ephesos', res: 'P', sides: {
    A: [{ cost: 'CC', vp: 3 }, { cost: 'WW', coins: 9 }, { cost: 'GOO', vp: 7 }],
    B: [{ cost: 'SS', vp: 2, coins: 4 }, { cost: 'WW', vp: 3, coins: 4 }, { cost: 'OOT', vp: 5, coins: 4 }],
  } },
  { n: 'Halikarnassos', res: 'T', sides: {
    A: [{ cost: 'OO', vp: 3 }, { cost: 'GP', salvage: true }, { cost: 'SSS', vp: 7 }],
    B: [{ cost: 'CC', vp: 2, salvage: true }, { cost: 'GP', vp: 1, salvage: true }, { cost: 'WWW', salvage: true }],
  } },
];

// ---------------------------------------------------------------- constants

export const START_COINS = 3;
export const START_COINS_LEADERS = 6;   // Leaders: you need money to hire them
export const CARDS_PER_AGE = 7;

// Winning a conflict is worth more as the ages go on; losing always costs one,
// and the defeat tokens stay on your board — Cynisca pays for a board with none
// on it, Telesilla sweeps yours away, and Tomyris posts hers to the winner.
export const MILITARY_WIN = { 1: 1, 2: 3, 3: 5 };
export const MILITARY_LOSS = -1;

// Science: three of a kind squared, plus seven for every complete set.
export const SCIENCE_SET_BONUS = 7;

// ---------------------------------------------------------------- Cities
//
// Source: the 7 Wonders wiki's List of Cards, read as wikitext rather than as
// the rendered page — the tables draw every cost as an icon, and the icons are
// lazy-loaded, so scraping the page gives you names and nothing else. In the
// wikitext they are file links ([[File:Coin-2.png]], [[File:Resource-Wood.png]],
// [[File:Victory-4.png]]) and map straight onto the fields below. Costs are
// written in sorted letter order so they are easy to diff against that source.
//
// The expansion has 42 black cards, fourteen per Age. Thirty-two are here: the
// ten missing ones need mechanics the engine does not have yet, and are listed
// at the bottom of this block rather than faked. What was here before was a
// third-party table whose costs were visibly filler — every Age II card cost
// papyrus+textile, every Age III card glass+papyrus+textile — plus five cards
// (Villa, Smugglers' Wharf, Hidden Cache, Tribute, Treasury) that are not in
// the expansion at all.
//
// A fan wiki is not the publisher, and on three base-game guilds it disagrees
// with what is already here — Craftsmens (1 ore + 2 stone against 2 and 2),
// Spies (2 clay against 3), Builders (3 stone against 2). Each is one repeated
// resource, but not all in the same direction, so it is not one extraction bug
// either. They are unresolved: this wiki has no per-card pages to check against
// — searching a guild's name returns only this one list — so there is no second
// opinion on it anywhere on the site. Nothing outside this block was changed on
// its say-so, and that disagreement is the reason.
//
// What protects this block is that the engine still asserts its own structure —
// an Age deals seven cards per player, and at most seven black cards are drawn
// into each Age, so every Age here needs at least seven and has ten or more.
//
// Effect keys, all handled in game.js:
//   mask           copy one science symbol off a neighbour's green card
//   loss           every OTHER player pays this many coins, or takes the debt;
//                  a NEGATIVE loss hands coins out instead (Customs, Mint)
//   perLoss        every other player pays per something they own
//   diplo          take a diplomacy token: sit out one conflict
//   nbCoins        each of your neighbours also takes this from the bank
//   rebate         one coin off resources bought from that side
//   produceMissing produces any resource your city does not already make
//   freeStages     wonder stages stop costing resources
//   salvage        take the discard pile, build one card out of it for nothing

export const CITY_CARDS = [
  // ---- Age I
  { n: 'West Clandestine Wharf', c: 'black', age: 1, coin: 1,              rebate: { with: 'left' } },
  { n: 'East Clandestine Wharf', c: 'black', age: 1, coin: 1,              rebate: { with: 'right' } },
  { n: 'City Gates',             c: 'black', age: 1, coin: 1, cost: 'W',   vp: 4 },
  { n: 'Customs',                c: 'black', age: 1,                       vp: 4, loss: -1 },
  { n: 'Dive',                   c: 'black', age: 1,                       coins: 6, nbCoins: 1 },
  { n: 'Opium Stash',            c: 'black', age: 1,                       coins: 3, loss: 1 },
  { n: 'Hideout',                c: 'black', age: 1,                       vp: 2, loss: 1 },
  { n: 'Militia',                c: 'black', age: 1, coin: 3,              shield: 2 },
  { n: 'Residence',              c: 'black', age: 1, cost: 'C',            vp: 1, diplo: 1 },
  { n: 'Pigeonhole',             c: 'black', age: 1, coin: 1, cost: 'O',   mask: 1 },

  // ---- Age II
  { n: 'Black Market',    c: 'black', age: 2,          cost: 'OT',    produceMissing: true },
  { n: 'Architect Firm',  c: 'black', age: 2, coin: 1, cost: 'P',     vp: 2, freeStages: true },
  { n: 'Tabularium',      c: 'black', age: 2, coin: 2, cost: 'OTW',   vp: 6 },
  { n: 'Trade Center',    c: 'black', age: 2,          cost: 'CPS',   vp: 6, loss: -2 },
  { n: 'Gambling Den',    c: 'black', age: 2, coin: 1,                coins: 9, nbCoins: 2 },
  { n: 'Opium Den',       c: 'black', age: 2,          cost: 'P',     coins: 4, loss: 3 },
  { n: 'Lair',            c: 'black', age: 2,          cost: 'GW',    vp: 3, loss: 2 },
  { n: 'Sepulcher',       c: 'black', age: 2,          cost: 'GST',   vp: 4, perLoss: { of: 'victory', coins: 1 } },
  { n: 'Mercenaries',     c: 'black', age: 2, coin: 4, cost: 'P',     shield: 3 },
  { n: 'Consulate',       c: 'black', age: 2,          cost: 'CP',    vp: 2, diplo: 1 },
  { n: 'Band of Spies',   c: 'black', age: 2, coin: 2, cost: 'CS',    mask: 1 },
  { n: 'Forging Agency',  c: 'black', age: 2, coin: 2,                salvage: true },

  // ---- Age III
  { n: 'Capitol',             c: 'black', age: 3, coin: 2, cost: 'CCGPSS', vp: 8 },
  { n: 'Mint',                c: 'black', age: 3,          cost: 'CGTWW',  vp: 8, loss: -3 },
  { n: 'Opium Distillery',    c: 'black', age: 3,          cost: 'GW',     coins: 5, loss: 5 },
  { n: 'Brotherhood',         c: 'black', age: 3,          cost: 'OTWW',   vp: 4, loss: 3 },
  { n: 'Chamber of Builders', c: 'black', age: 3,          cost: 'CGPW',   vp: 4, perLoss: { of: 'stage', coins: 1 } },
  { n: 'Cenotaph',            c: 'black', age: 3,          cost: 'CCGST',  vp: 5, perLoss: { of: 'victory', coins: 1 } },
  { n: 'Secret Network',      c: 'black', age: 3,          cost: 'PS',     per: { coins: 1, vp: 1, of: 'black', from: 'self' } },
  { n: 'Slave Market',        c: 'black', age: 3,          cost: 'OOWW',   per: { coins: 1, vp: 1, of: 'victory', from: 'self' } },
  { n: 'Contingent',          c: 'black', age: 3, coin: 5, cost: 'T',      shield: 5 },
  { n: 'Embassy',             c: 'black', age: 3,          cost: 'PST',    vp: 2, diplo: 1 },
  { n: 'Torture Chamber',     c: 'black', age: 3, coin: 3, cost: 'GOO',    mask: 1 },
];

// The nine black cards NOT above, and the mechanic each one is waiting on. They
// are left out rather than approximated, because a card that silently does
// nothing is worse than a card that is not in the deck.
//
//   Smuggler's Cache  I    a rebate on the STARTING resource, not a bought one
//   Secret Warehouse  I    an extra copy of a resource you already produce
//                          (produceMissing covers the opposite case)
//   Raider Camp       I    grant yourself an Age I military victory token, and
//   Raider Fort       II   hand each neighbour a debt — no card grants a token
//   Raider Garrison   III  today, and debt is only ever taken, never given
//   Cells             I    end-game points per victory token OF A GIVEN AGE;
//   Guardhouse        II   tokens are currently counted but not dated
//   Prison            III
//   Memorial          III  cash in your defeat tokens and discard them: the
//                          first card that would REMOVE tokens from a board

// Cities adds no guilds. Its contents are 42 black cards, diplomacy tokens,
// debt tokens and coins — the first edition's Counterfeiters Guild, Guild Of
// Shadows and Mourners Guild are not part of the second edition box. Mourners,
// along with the Architects and Gamers guilds, is a promo the publisher still
// hands out as a separate card with its own rules sheet; none of the three is
// in here.

// Debt is measured in victory points, one per coin you could not pay.
export const DEBT_VP = -1;

// ---------------------------------------------------------------- Leaders
//
// Source: the same wiki, read the same way — Leader_Cards?action=raw, whose
// table is three columns of name, {{Coin|N}} and effect text. Its contents page
// for the expansion gives the deck as 55 cards in three labelled groups —
// 34 Standard, 15 Expert, 6 Cities bonus — and the table turns out to be in
// exactly that order, 34 then 15 then 6, which is what `set` below records. The
// six Cities cards are the ones that read black cards, debt and diplomacy, so
// the split is corroborated by what the cards actually do rather than only by
// where they sit in a table.
//
// A leader is a white card that costs coins and nothing else. Four are dealt to
// each player and drafted before Age I; one is played at the start of each Age,
// so the fourth is never played. {{Coin|A}} means the cost is the current Age:
// 1, 2 or 3 — written here as coin: 'age'.
//
// The Cities six are dealt only when Cities is switched on. They are printed as
// bonus cards for that box, and three of them (Caligula, Diocletian, Darius)
// read a colour that is not in the deck without it.
//
// Effect keys beyond the ones the Age cards already use:
//   discount     pay one fewer resource for that colour, or for wonder stages;
//                which resource is yours to choose, so the engine drops the one
//                that makes the bill cheapest
//   freeColour   that colour costs no resources at all
//   freeColourAge  ... once per Age
//   freeLeaders  later leaders are recruited for nothing
//   bankBuy      buy this many resources a turn from the bank at 1 coin each
//   bonusCoin    once a turn, take an extra coin whenever the bank pays you
//   onBuild      coins each time you build a card of that colour
//   onChain      coins each time a chain makes a card free
//   onStage      coins each time you finish a wonder stage; others may pay
//   onWin        coins each time you take a military victory token
//   token        take a victory token now, worth the current Age
//   purge        throw away your defeat tokens; everyone else loses a victory
//   deflect      a defeat token you would take goes to the winner instead
//   sciSwap      at the end, one science symbol may become another
//   sciMost      at the end, one more of whichever symbol you have most of
//   sciSetVp     extra points per complete set of three symbols
//   setVp        points per complete set of one card of each listed colour
//   vpPerCoins   points per this many coins — a second helping of the usual one
//   mostVp       points for having strictly more than BOTH neighbours
//   cleanVp      points for holding no defeat tokens
//   loneVp       points for this being your only leader
//   pairVp       points per matching pair of victory tokens, worth their value
//   lossAge      everyone else loses coins equal to the current Age

export const LEADERS_PER_PLAYER = 4;

export const LEADERS = [
  // ---- Standard (34)
  { n: 'Maecenas',       set: 'standard', coin: 1, freeLeaders: true },
  { n: 'Imhotep',        set: 'standard', coin: 3, discount: { of: 'stage' } },
  { n: 'Hammurabi',      set: 'standard', coin: 2, discount: { of: 'blue' } },
  { n: 'Leonidas',       set: 'standard', coin: 2, discount: { of: 'red' } },
  { n: 'Archimedes',     set: 'standard', coin: 4, discount: { of: 'green' } },
  { n: 'Ramses',         set: 'standard', coin: 5, freeColour: 'purple' },
  { n: 'Croesus',        set: 'standard', coin: 1, coins: 6 },
  { n: 'Xenophon',       set: 'standard', coin: 2, onBuild: { of: 'yellow', coins: 2 } },
  { n: 'Vitruvius',      set: 'standard', coin: 1, onChain: { coins: 2 } },
  { n: 'Nero',           set: 'standard', coin: 1, onWin: { coins: 2 } },
  { n: 'Bilkis',         set: 'standard', coin: 4, bankBuy: 1 },
  { n: 'Hannibal',       set: 'standard', coin: 2, shield: 1 },
  { n: 'Caesar',         set: 'standard', coin: 5, shield: 2 },
  { n: 'Solomon',        set: 'standard', coin: 3, salvage: true },
  { n: 'Euclid',         set: 'standard', coin: 5, sci: 'compass' },
  { n: 'Ptolemy',        set: 'standard', coin: 5, sci: 'tablet' },
  { n: 'Pythagoras',     set: 'standard', coin: 5, sci: 'gear' },
  { n: 'Sappho',         set: 'standard', coin: 1, vp: 2 },
  { n: 'Zenobia',        set: 'standard', coin: 2, vp: 3 },
  { n: 'Nefertiti',      set: 'standard', coin: 3, vp: 4 },
  { n: 'Cleopatra',      set: 'standard', coin: 4, vp: 5 },
  { n: 'Phidias',        set: 'standard', coin: 3, per: { vp: 1, of: 'brown',  from: 'self' } },
  { n: 'Praxiteles',     set: 'standard', coin: 3, per: { vp: 2, of: 'grey',   from: 'self' } },
  { n: 'Nebuchadnezzar', set: 'standard', coin: 4, per: { vp: 1, of: 'blue',   from: 'self' } },
  { n: 'Varro',          set: 'standard', coin: 3, per: { vp: 1, of: 'yellow', from: 'self' } },
  { n: 'Pericles',       set: 'standard', coin: 6, per: { vp: 2, of: 'red',    from: 'self' } },
  { n: 'Hypatia',        set: 'standard', coin: 4, per: { vp: 1, of: 'green',  from: 'self' } },
  { n: 'Hiram',          set: 'standard', coin: 3, per: { vp: 2, of: 'purple', from: 'self' } },
  { n: 'Midas',          set: 'standard', coin: 3, vpPerCoins: 3 },
  { n: 'Amytis',         set: 'standard', coin: 4, per: { vp: 2, of: 'stage',  from: 'self' } },
  { n: 'Alexander',      set: 'standard', coin: 3, per: { vp: 1, of: 'victory', from: 'self' } },
  { n: 'Justinian',      set: 'standard', coin: 3, setVp: { of: ['blue', 'red', 'green'], vp: 3 } },
  { n: 'Plato',          set: 'standard', coin: 3, setVp: { of: ['brown', 'grey', 'blue', 'yellow', 'red', 'green', 'purple'], vp: 7 } },
  { n: 'Aristotle',      set: 'standard', coin: 3, sciSetVp: 3 },

  // ---- Expert (15)
  { n: 'Berenice',   set: 'expert', coin: 2,     bonusCoin: 1 },
  { n: 'Hapshepsut', set: 'expert', coin: 2,     rebate: { with: 'both' } },
  { n: 'Nitocris',   set: 'expert', coin: 'age', token: 'age' },
  { n: 'Telesilla',  set: 'expert', coin: 3,     purge: true },
  { n: 'Tomyris',    set: 'expert', coin: 4,     deflect: true },
  { n: 'Aganice',    set: 'expert', coin: 'age', sciSwap: true },
  { n: 'Enheduania', set: 'expert', coin: 4,     sciMost: true },
  { n: 'Phryne',     set: 'expert', coin: 'age', mostVp: { of: 'blue',   vp: 5 } },
  { n: 'Cornelia',   set: 'expert', coin: 'age', mostVp: { of: 'yellow', vp: 5 } },
  { n: 'Euryptyle',  set: 'expert', coin: 'age', mostVp: { of: 'red',    vp: 5 } },
  { n: 'Theano',     set: 'expert', coin: 'age', mostVp: { of: 'green',  vp: 5 } },
  { n: 'Makeda',     set: 'expert', coin: 'age', mostVp: { of: 'coins',  vp: 5 } },
  { n: 'Cynisca',    set: 'expert', coin: 'age', cleanVp: 6 },
  { n: 'Gorgo',      set: 'expert', coin: 5,     pairVp: true },
  { n: 'Agrippina',  set: 'expert', coin: 1,     loneVp: 7 },

  // ---- Cities bonus (6) — dealt only when Cities is switched on
  { n: 'Caligula',   set: 'cities', coin: 3,     freeColourAge: 'black' },
  { n: 'Diocletian', set: 'cities', coin: 2,     onBuild: { of: 'black', coins: 2 } },
  { n: 'Octavia',    set: 'cities', coin: 1,     onStage: { coins: 2, others: 1 } },
  { n: 'Arsinoe',    set: 'cities', coin: 'age', coins: 4, lossAge: true },
  { n: 'Aspasia',    set: 'cities', coin: 3,     vp: 2, diplo: 1 },
  { n: 'Darius',     set: 'cities', coin: 4,     per: { vp: 1, of: 'black', from: 'self' } },
];

// All fifty-five are here. Solomon was the last one out, because "take all the
// cards in the discard, choose 1 and construct it for free" is not a row in a
// table — it is a phase in which one player is choosing and everybody else is
// waiting. Cities' Forging Agency says the same sentence word for word, and so
// does every stage of Halikarnassos, so the four of them share one `salvage`
// flag and one phase in game.js.
