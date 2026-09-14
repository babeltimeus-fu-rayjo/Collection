// cards.js — the printed content of 7 Wonders, as data.
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
  { n: 'Stone Pit',     c: 'brown', at: [3, 5],       give: 'S' },
  { n: 'Clay Pool',     c: 'brown', at: [3, 5],       give: 'C' },
  { n: 'Ore Vein',      c: 'brown', at: [3, 4],       give: 'O' },
  { n: 'Tree Farm',     c: 'brown', at: [6],    coin: 1, give: 'W/C' },
  { n: 'Excavation',    c: 'brown', at: [4],    coin: 1, give: 'S/C' },
  { n: 'Clay Pit',      c: 'brown', at: [3],    coin: 1, give: 'C/O' },
  { n: 'Timber Yard',   c: 'brown', at: [3],    coin: 1, give: 'S/W' },
  { n: 'Forest Cave',   c: 'brown', at: [5],    coin: 1, give: 'W/O' },
  { n: 'Mine',          c: 'brown', at: [6],    coin: 1, give: 'O/S' },

  // grey — manufactured goods
  { n: 'Loom',       c: 'grey', at: [3, 6], give: 'T' },
  { n: 'Glassworks', c: 'grey', at: [3, 6], give: 'G' },
  { n: 'Press',      c: 'grey', at: [3, 6], give: 'P' },

  // blue — civilian
  { n: 'Pawnshop', c: 'blue', at: [4, 7],           vp: 3 },
  { n: 'Baths',    c: 'blue', at: [3, 7], cost: 'S', vp: 3, chains: ['Aqueduct'] },
  { n: 'Altar',    c: 'blue', at: [3, 5],           vp: 2, chains: ['Temple'] },
  { n: 'Theater',  c: 'blue', at: [3, 6],           vp: 2, chains: ['Statue'] },

  // yellow — commercial
  { n: 'Tavern',             c: 'yellow', at: [4, 5, 7], coins: 5 },
  { n: 'East Trading Post',  c: 'yellow', at: [3, 7], trade: { with: 'right', kind: 'raw' }, chains: ['Forum'] },
  { n: 'West Trading Post',  c: 'yellow', at: [3, 7], trade: { with: 'left',  kind: 'raw' }, chains: ['Forum'] },
  { n: 'Marketplace',        c: 'yellow', at: [3, 6], trade: { with: 'both',  kind: 'man' }, chains: ['Caravansery'] },

  // red — military
  { n: 'Stockade',    c: 'red', at: [3, 7], cost: 'W', shield: 1 },
  { n: 'Barracks',    c: 'red', at: [3, 5], cost: 'O', shield: 1 },
  { n: 'Guard Tower', c: 'red', at: [3, 4], cost: 'C', shield: 1 },

  // green — science
  { n: 'Apothecary',  c: 'green', at: [3, 5], cost: 'T', sci: 'compass', chains: ['Stables', 'Dispensary'] },
  { n: 'Workshop',    c: 'green', at: [3, 7], cost: 'G', sci: 'gear',    chains: ['Archery Range', 'Laboratory'] },
  { n: 'Scriptorium', c: 'green', at: [3, 4], cost: 'P', sci: 'tablet',  chains: ['Courthouse', 'Library'] },
];

// ---------------------------------------------------------------- Age II

const AGE2 = [
  // brown
  { n: 'Sawmill',   c: 'brown', at: [3, 4], coin: 1, give: 'WW' },
  { n: 'Quarry',    c: 'brown', at: [3, 4], coin: 1, give: 'SS' },
  { n: 'Brickyard', c: 'brown', at: [3, 4], coin: 1, give: 'CC' },
  { n: 'Foundry',   c: 'brown', at: [3, 4], coin: 1, give: 'OO' },

  // grey
  { n: 'Loom',       c: 'grey', at: [3, 5], give: 'T' },
  { n: 'Glassworks', c: 'grey', at: [3, 5], give: 'G' },
  { n: 'Press',      c: 'grey', at: [3, 5], give: 'P' },

  // blue
  { n: 'Aqueduct',   c: 'blue', at: [3, 7], cost: 'SSS',  vp: 5, free: 'Baths' },
  { n: 'Temple',     c: 'blue', at: [3, 6], cost: 'WCG',  vp: 3, free: 'Altar',       chains: ['Pantheon'] },
  { n: 'Statue',     c: 'blue', at: [3, 7], cost: 'OOW',  vp: 4, free: 'Theater',     chains: ['Gardens'] },
  { n: 'Courthouse', c: 'blue', at: [3, 5], cost: 'CCT',  vp: 4, free: 'Scriptorium' },

  // yellow
  { n: 'Forum',       c: 'yellow', at: [3, 6, 7], cost: 'CC', give: 'G/P/T', free: 'East Trading Post', free2: 'West Trading Post', chains: ['Haven'] },
  { n: 'Caravansery', c: 'yellow', at: [3, 5, 6], cost: 'WW', give: 'W/S/C/O', free: 'Marketplace', chains: ['Lighthouse'] },
  { n: 'Vineyard',    c: 'yellow', at: [3, 6],   per: { coins: 1, of: 'brown', from: 'neighbours+self' } },
  { n: 'Bazar',       c: 'yellow', at: [4, 7],   per: { coins: 2, of: 'grey',  from: 'neighbours+self' } },

  // red
  { n: 'Walls',           c: 'red', at: [3, 7],    cost: 'SSS', shield: 2, chains: ['Fortifications'] },
  { n: 'Training Ground', c: 'red', at: [4, 6, 7], cost: 'WOO', shield: 2, chains: ['Circus'] },
  { n: 'Stables',         c: 'red', at: [3, 5],    cost: 'OCW', shield: 2, free: 'Apothecary' },
  { n: 'Archery Range',   c: 'red', at: [3, 6],    cost: 'WWO', shield: 2, free: 'Workshop' },

  // green
  { n: 'Dispensary', c: 'green', at: [3, 4], cost: 'OOG', sci: 'compass', free: 'Apothecary',  chains: ['Arena', 'Lodge'] },
  { n: 'Laboratory', c: 'green', at: [3, 5], cost: 'CCP', sci: 'gear',    free: 'Workshop',    chains: ['Siege Workshop', 'Observatory'] },
  { n: 'Library',    c: 'green', at: [3, 6], cost: 'SST', sci: 'tablet',  free: 'Scriptorium', chains: ['Senate', 'University'] },
  { n: 'School',     c: 'green', at: [3, 7], cost: 'WP',  sci: 'tablet',  chains: ['Academy', 'Study'] },
];

// ---------------------------------------------------------------- Age III

const AGE3 = [
  // blue
  { n: 'Pantheon',  c: 'blue', at: [3, 6],    cost: 'CCOPTG', vp: 7, free: 'Temple' },
  { n: 'Gardens',   c: 'blue', at: [3, 4],    cost: 'CCW',    vp: 5, free: 'Statue' },
  { n: 'Town Hall', c: 'blue', at: [3, 5, 6], cost: 'SSOG',   vp: 6 },
  { n: 'Palace',    c: 'blue', at: [3, 7],    cost: 'WSCOGPT', vp: 8 },
  { n: 'Senate',    c: 'blue', at: [3, 5],    cost: 'WWSO',   vp: 6, free: 'Library' },

  // yellow
  { n: 'Haven',              c: 'yellow', at: [3, 4],    cost: 'WOT', free: 'Forum',      per: { coins: 1, vp: 1, of: 'brown',  from: 'self' } },
  { n: 'Lighthouse',         c: 'yellow', at: [3, 6],    cost: 'SG',  free: 'Caravansery', per: { coins: 1, vp: 1, of: 'yellow', from: 'self' } },
  { n: 'Chamber of Commerce', c: 'yellow', at: [4, 6],   cost: 'CCP',                      per: { coins: 2, vp: 2, of: 'grey',   from: 'self' } },
  { n: 'Arena',              c: 'yellow', at: [3, 5, 7], cost: 'SSO', free: 'Dispensary',  per: { coins: 3, vp: 1, of: 'stage',  from: 'self' } },

  // red
  { n: 'Fortifications', c: 'red', at: [3, 7],    cost: 'OOOS', shield: 3, free: 'Walls' },
  { n: 'Circus',         c: 'red', at: [4, 5, 6], cost: 'SSSO', shield: 3, free: 'Training Ground' },
  { n: 'Arsenal',        c: 'red', at: [3, 4, 7], cost: 'WWOT', shield: 3 },
  { n: 'Siege Workshop', c: 'red', at: [3, 5],    cost: 'CCCW', shield: 3, free: 'Laboratory' },

  // green
  { n: 'Lodge',       c: 'green', at: [3, 6], cost: 'CCPT', sci: 'compass', free: 'Dispensary' },
  { n: 'Observatory',  c: 'green', at: [3, 7], cost: 'OOGT', sci: 'gear',    free: 'Laboratory' },
  { n: 'University',  c: 'green', at: [3, 4], cost: 'WWPG', sci: 'tablet',  free: 'Library' },
  { n: 'Academy',     c: 'green', at: [3, 7], cost: 'SSSG', sci: 'compass', free: 'School' },
  { n: 'Study',       c: 'green', at: [3, 5], cost: 'WPT',  sci: 'gear',    free: 'School' },
];

// Guilds: ten exist, a game uses player-count + 2 of them, drawn at random and
// shuffled into Age III. They are the only cards that read another player's city.
export const GUILDS = [
  { n: 'Workers Guild',      c: 'purple', cost: 'OOCSW', per: { vp: 1, of: 'brown',  from: 'neighbours' } },
  { n: 'Craftsmens Guild',   c: 'purple', cost: 'OOSS',  per: { vp: 2, of: 'grey',   from: 'neighbours' } },
  { n: 'Traders Guild',      c: 'purple', cost: 'GPT',   per: { vp: 1, of: 'yellow', from: 'neighbours' } },
  { n: 'Philosophers Guild', c: 'purple', cost: 'CCCPT', per: { vp: 1, of: 'green',  from: 'neighbours' } },
  { n: 'Spies Guild',        c: 'purple', cost: 'CCCG',  per: { vp: 1, of: 'red',    from: 'neighbours' } },
  { n: 'Strategists Guild',  c: 'purple', cost: 'OOST',  per: { vp: 1, of: 'defeat', from: 'neighbours' } },
  { n: 'Shipowners Guild',   c: 'purple', cost: 'WWWGP', per: { vp: 1, of: 'brown+grey+purple', from: 'self' } },
  { n: 'Scientists Guild',   c: 'purple', cost: 'WWOOP', sci: 'any' },
  { n: 'Magistrates Guild',  c: 'purple', cost: 'WWWST', per: { vp: 1, of: 'blue',   from: 'neighbours' } },
  { n: 'Builders Guild',     c: 'purple', cost: 'SSCCG', per: { vp: 1, of: 'stage',  from: 'neighbours+self' } },
];

export const BASE_AGES = [AGE1, AGE2, AGE3];

// ---------------------------------------------------------------- wonders
//
// Each board has a day side (A) and a night side (B). A-sides follow one shape:
// 3 VP, something in the middle, 7 VP. B-sides are where the boards get their
// character, and several of them grant an ability rather than points:
//
//   freePerAge   build one card per age without paying for it
//   fromDiscard  build a card out of the discard pile for nothing
//   playLast     play the seventh card of an age instead of discarding it
//   copyGuild    at the end, count one neighbour's guild as your own
//
// A stage that produces a resource produces it for you only — wonder production
// can't be sold to a neighbour, which is what notTrade marks.

export const WONDERS = [
  { n: 'Gizah', res: 'S', sides: {
    A: [{ cost: 'SS', vp: 3 }, { cost: 'WWW', vp: 5 }, { cost: 'SSSS', vp: 7 }],
    B: [{ cost: 'WW', vp: 3 }, { cost: 'SSS', vp: 5 }, { cost: 'CCC', vp: 5 }, { cost: 'SSSSP', vp: 7 }],
  } },
  { n: 'Babylon', res: 'C', sides: {
    A: [{ cost: 'CC', vp: 3 }, { cost: 'WWW', sci: 'any' }, { cost: 'CCCC', vp: 7 }],
    B: [{ cost: 'CT', vp: 3 }, { cost: 'WWG', act: 'playLast' }, { cost: 'CCCP', sci: 'any' }],
  } },
  { n: 'Olympia', res: 'W', sides: {
    A: [{ cost: 'WW', vp: 3 }, { cost: 'SS', act: 'freePerAge' }, { cost: 'OO', vp: 7 }],
    B: [{ cost: 'WW', trade: { with: 'both', kind: 'raw' } }, { cost: 'SS', vp: 5 }, { cost: 'OOT', act: 'copyGuild' }],
  } },
  { n: 'Rhodos', res: 'O', sides: {
    A: [{ cost: 'WW', vp: 3 }, { cost: 'CCC', shield: 2 }, { cost: 'OOOO', vp: 7 }],
    B: [{ cost: 'SSS', vp: 3, shield: 1, coins: 3 }, { cost: 'OOOO', vp: 4, shield: 1, coins: 4 }],
  } },
  { n: 'Alexandria', res: 'G', sides: {
    A: [{ cost: 'SS', vp: 3 }, { cost: 'OO', give: 'W/S/C/O', notTrade: true }, { cost: 'GG', vp: 7 }],
    B: [{ cost: 'CC', give: 'W/S/C/O', notTrade: true }, { cost: 'WW', give: 'G/P/T', notTrade: true }, { cost: 'SSS', vp: 7 }],
  } },
  { n: 'Ephesos', res: 'P', sides: {
    A: [{ cost: 'SS', vp: 3 }, { cost: 'WW', coins: 9 }, { cost: 'PP', vp: 7 }],
    B: [{ cost: 'SS', vp: 2, coins: 4 }, { cost: 'WW', vp: 3, coins: 4 }, { cost: 'GPT', vp: 5, coins: 4 }],
  } },
  { n: 'Halikarnassos', res: 'T', sides: {
    A: [{ cost: 'CC', vp: 3 }, { cost: 'OOO', act: 'fromDiscard' }, { cost: 'TT', vp: 7 }],
    B: [{ cost: 'OO', vp: 2, act: 'fromDiscard' }, { cost: 'CCC', vp: 1, act: 'fromDiscard' }, { cost: 'GPT', act: 'fromDiscard' }],
  } },
];

// ---------------------------------------------------------------- constants

export const START_COINS = 3;
export const START_COINS_LEADERS = 6;   // Leaders: you need money to hire them
export const CARDS_PER_AGE = 7;

// Winning a conflict is worth more as the ages go on; losing always costs one,
// and the defeat tokens stay on your board for the Strategists Guild to count.
export const MILITARY_WIN = { 1: 1, 2: 3, 3: 5 };
export const MILITARY_LOSS = -1;

// Science: three of a kind squared, plus seven for every complete set.
export const SCIENCE_SET_BONUS = 7;
