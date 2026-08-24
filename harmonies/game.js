// game.js — Harmonies rules engine (pure logic, no DOM, no network).
//
// An unofficial fan implementation of Harmonies by Johan Benvenuto
// (© Libellud). Mechanics follow the official rulebook (Side A boards):
//   - 23-hex personal board; a central board with 5 slots of 3 tokens drawn
//     from a 120-token pouch (23 gray, 23 blue, 21 brown, 19 green,
//     19 yellow, 15 red).
//   - Turn: take all tokens from one slot and place them (mandatory, once);
//     take 1 animal card (optional, once, hand limit 4); place animal cubes
//     (optional, any number, any time). Actions interleave freely. At end of
//     turn the slot refills with 3 tokens and the animal row refills to 5.
//   - Stacking: a token always goes on an empty space, or on top of 1-2
//     tokens ONLY to form a tree (green on 1-2 browns), a mountain (gray on
//     1-2 grays), or a building (red on exactly 1 brown/gray/red). Nothing
//     may be placed on a space whose top token holds an animal cube.
//   - Scoring: trees 1/3/5 by height; mountains 1/3/7 but 0 unless adjacent
//     to another mountain; each group of 2+ yellows is 5; buildings (red at
//     height 2) are 5 if at least 3 different colors top the adjacent
//     spaces; water scores your single best river — 0/2/5/8/11/15 for
//     lengths 1-6 measured end-to-end by shortest path, +4 per extra token.
//   - Animal cards: recreate the habitat pattern (any of the 6 rotations,
//     exact tree/mountain heights, buildings on any base) and move the
//     card's bottom cube onto the pattern's cube token, which must be
//     cube-free. A card scores the value of its topmost cube-free space.
//   - Side B boards score water differently: the blue tokens carve the board
//     into ISLANDS — each connected group of non-blue spaces (empty spaces
//     included) is worth 5 points, and an unseparated board is 1 island.
//   - End: the pouch is empty at refill time, or a player ends a turn with
//     2 or fewer empty spaces; the round is completed so turns are equal.
//     Ties: most cubes placed, then shared victory.
// The animal deck here is an ORIGINAL design (like the physical game's, each
// card is a pattern, a cube color, and an ascending point ladder).

export const PROTO = 1;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;
export const HAND_LIMIT = 4;
export const DISPLAY = 5;

export const TOKEN_COUNTS = { gray: 23, blue: 23, brown: 21, green: 19, yellow: 19, red: 15 };

// which side of the personal boards the table plays with (water scoring)
export const BOARD_SIDES = [
  {
    key: 'A',
    name: 'Side A — The River',
    blurb: 'Water scores your single best river: 2/5/8/11/15 points for 2-6 tokens measured end-to-end by the shortest path, then +4 per extra token.',
  },
  {
    key: 'B',
    name: 'Side B — The Islands',
    blurb: 'Water scores by division: every group of spaces your blue tokens cut off is an island worth 5 points — an unseparated board is a single island.',
  },
];

export function sideByKey(key) {
  return BOARD_SIDES.find((s) => s.key === key) || BOARD_SIDES[0];
}
export const COLORS = ['blue', 'gray', 'brown', 'green', 'yellow', 'red'];

// ---------------------------------------------------------------- board
// 23 hexes in columns of 5-4-5-4-5 (flat-top, odd columns shifted down).
// Everything runs on cube coordinates so pattern rotation is exact.

function offsetToCube(col, row) {
  const x = col;
  const z = row - (col - (col & 1)) / 2;
  return { x, z, y: -x - z };
}

export const CELLS = (() => {
  const cells = [];
  const heights = [5, 4, 5, 4, 5];
  let id = 0;
  for (let col = 0; col < 5; col++) {
    for (let row = 0; row < heights[col]; row++) {
      const c = offsetToCube(col, row);
      cells.push({ id: id++, col, row, x: c.x, y: c.y, z: c.z });
    }
  }
  return cells;
})();

const CELL_BY_XZ = new Map(CELLS.map((c) => [`${c.x},${c.z}`, c.id]));

const CUBE_DIRS = [
  [1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1], // (dx, dz)
];

export const NEIGHBORS = CELLS.map((c) =>
  CUBE_DIRS.map(([dx, dz]) => CELL_BY_XZ.get(`${c.x + dx},${c.z + dz}`)).filter((n) => n != null),
);

// rotate a cube-coordinate offset 60° clockwise, k times
function rotCube(dx, dz, k) {
  let x = dx;
  let z = dz;
  let y = -x - z;
  for (let i = 0; i < k; i++) {
    const nx = -z;
    const ny = -x;
    const nz = -y;
    x = nx;
    y = ny;
    z = nz;
  }
  return [x, z];
}

// ---------------------------------------------------------------- stacks

// classify a stack of colors (bottom -> top); '' for empty
export function stackType(stack) {
  if (!stack.length) return 'empty';
  const top = stack[stack.length - 1];
  if (top === 'green') {
    if (stack.length === 1) return 'tree1';
    if (stack.length === 2 && stack[0] === 'brown') return 'tree2';
    if (stack.length === 3 && stack[0] === 'brown' && stack[1] === 'brown') return 'tree3';
  }
  if (top === 'gray' && stack.every((t) => t === 'gray')) return `mtn${stack.length}`;
  if (top === 'red') {
    if (stack.length === 1) return 'redg';
    if (stack.length === 2 && ['brown', 'gray', 'red'].includes(stack[0])) return 'bld';
  }
  if (top === 'blue' && stack.length === 1) return 'water';
  if (top === 'yellow' && stack.length === 1) return 'field';
  if (top === 'brown' && stack.length <= 2 && stack.every((t) => t === 'brown')) return `trunk${stack.length}`;
  return 'other';
}

// may `color` be placed on this stack? (cube-occupied is checked separately)
export function canPlaceOn(stack, color) {
  if (stack.length === 0) return true;
  if (stack.length >= 3) return false;
  const type = stackType(stack);
  if (color === 'gray') return type === 'mtn1' || type === 'mtn2';
  if (color === 'brown') return type === 'trunk1';
  if (color === 'green') return type === 'trunk1' || type === 'trunk2';
  if (color === 'red') return stack.length === 1 && ['brown', 'gray', 'red'].includes(stack[0]);
  return false; // blue and yellow live on the ground only
}

// ---------------------------------------------------------------- animals
// Original deck. Each card: cube color (which terrain the cube settles on),
// an ascending point ladder (one entry per cube), and a habitat pattern in
// cube-coordinate offsets from the cube cell. `t` is what the stack must be:
//   water · field · tree1/2/3 · mtn1/2/3 · bld (red on any single base)

const P = (dx, dz, t) => ({ dx, dz, t });

export const ANIMALS = [
  // -- water dwellers ------------------------------------------------------
  { key: 'otter', name: 'River Otter', color: 'blue', cubes: [2, 4, 6, 9], cube: 'water', pattern: [P(0, 0, 'water'), P(1, 0, 'water')] },
  { key: 'heron', name: 'Gray Heron', color: 'blue', cubes: [3, 6, 10], cube: 'water', pattern: [P(0, 0, 'water'), P(1, 0, 'field')] },
  { key: 'trout', name: 'Brook Trout', color: 'blue', cubes: [4, 8, 13], cube: 'water', pattern: [P(0, 0, 'water'), P(1, 0, 'water'), P(2, -1, 'water')] },
  { key: 'kingfisher', name: 'Kingfisher', color: 'blue', cubes: [5, 10, 16], cube: 'water', pattern: [P(0, 0, 'water'), P(1, 0, 'tree2')] },
  { key: 'newt', name: 'Crested Newt', color: 'blue', cubes: [6, 12], cube: 'water', pattern: [P(0, 0, 'water'), P(1, -1, 'mtn2'), P(1, 0, 'water')] },
  { key: 'dragonfly', name: 'Dragonfly', color: 'blue', cubes: [4, 7, 11], cube: 'water', pattern: [P(0, 0, 'water'), P(0, 1, 'field'), P(1, 0, 'field')] },
  // -- field roamers -------------------------------------------------------
  { key: 'harvestmouse', name: 'Harvest Mouse', color: 'yellow', cubes: [2, 4, 6, 8], cube: 'field', pattern: [P(0, 0, 'field'), P(1, 0, 'field')] },
  { key: 'hare', name: 'Brown Hare', color: 'yellow', cubes: [3, 6, 10], cube: 'field', pattern: [P(0, 0, 'field'), P(1, 0, 'field'), P(2, 0, 'field')] },
  { key: 'pheasant', name: 'Pheasant', color: 'yellow', cubes: [4, 8, 12], cube: 'field', pattern: [P(0, 0, 'field'), P(1, -1, 'tree1'), P(1, 0, 'field')] },
  { key: 'beeeater', name: 'Bee-eater', color: 'yellow', cubes: [5, 9, 14], cube: 'field', pattern: [P(0, 0, 'field'), P(1, 0, 'water'), P(0, 1, 'water')] },
  { key: 'partridge', name: 'Partridge', color: 'yellow', cubes: [7, 13], cube: 'field', pattern: [P(0, 0, 'field'), P(1, -1, 'mtn1'), P(1, 0, 'mtn1')] },
  // -- tree dwellers -------------------------------------------------------
  { key: 'squirrel', name: 'Red Squirrel', color: 'green', cubes: [2, 5, 8], cube: 'tree1', pattern: [P(0, 0, 'tree1'), P(1, 0, 'tree1')] },
  { key: 'woodpecker', name: 'Woodpecker', color: 'green', cubes: [4, 8, 12], cube: 'tree2', pattern: [P(0, 0, 'tree2'), P(1, 0, 'field')] },
  { key: 'owl', name: 'Tawny Owl', color: 'green', cubes: [5, 10, 15], cube: 'tree3', pattern: [P(0, 0, 'tree3'), P(1, 0, 'tree1')] },
  { key: 'marten', name: 'Pine Marten', color: 'green', cubes: [6, 11, 17], cube: 'tree2', pattern: [P(0, 0, 'tree2'), P(1, 0, 'tree2')] },
  { key: 'lynx', name: 'Shadow Lynx', color: 'green', cubes: [9, 17], cube: 'tree3', pattern: [P(0, 0, 'tree3'), P(1, -1, 'mtn1'), P(1, 0, 'tree1')] },
  { key: 'nightingale', name: 'Nightingale', color: 'green', cubes: [3, 6, 9, 12], cube: 'tree1', pattern: [P(0, 0, 'tree1'), P(1, 0, 'water')] },
  { key: 'stagbeetle', name: 'Stag Beetle', color: 'green', cubes: [5, 9, 13], cube: 'tree2', pattern: [P(0, 0, 'tree2'), P(0, 1, 'tree1'), P(1, 0, 'field')] },
  // -- mountain climbers ---------------------------------------------------
  { key: 'ibex', name: 'Alpine Ibex', color: 'gray', cubes: [2, 5, 8], cube: 'mtn1', pattern: [P(0, 0, 'mtn1'), P(1, 0, 'mtn1')] },
  { key: 'eagle', name: 'Golden Eagle', color: 'gray', cubes: [5, 10, 15], cube: 'mtn2', pattern: [P(0, 0, 'mtn2'), P(1, 0, 'mtn1')] },
  { key: 'condor', name: 'Cliff Condor', color: 'gray', cubes: [8, 16], cube: 'mtn3', pattern: [P(0, 0, 'mtn3'), P(1, 0, 'mtn1')] },
  { key: 'marmot', name: 'Marmot', color: 'gray', cubes: [3, 6, 10], cube: 'mtn1', pattern: [P(0, 0, 'mtn1'), P(1, 0, 'field')] },
  { key: 'salamander', name: 'Fire Salamander', color: 'gray', cubes: [4, 8, 13], cube: 'mtn1', pattern: [P(0, 0, 'mtn1'), P(1, 0, 'water'), P(2, -1, 'water')] },
  { key: 'wolf', name: 'Gray Wolf', color: 'gray', cubes: [6, 12, 18], cube: 'mtn2', pattern: [P(0, 0, 'mtn2'), P(1, -1, 'tree1'), P(1, 0, 'tree1')] },
  // -- town visitors -------------------------------------------------------
  { key: 'swallow', name: 'Barn Swallow', color: 'red', cubes: [3, 6, 9], cube: 'bld', pattern: [P(0, 0, 'bld'), P(1, 0, 'field')] },
  { key: 'stork', name: 'White Stork', color: 'red', cubes: [5, 10, 15], cube: 'bld', pattern: [P(0, 0, 'bld'), P(1, 0, 'water')] },
  { key: 'housecat', name: 'House Cat', color: 'red', cubes: [4, 8, 12], cube: 'bld', pattern: [P(0, 0, 'bld'), P(1, 0, 'tree1')] },
  { key: 'raccoondog', name: 'Raccoon Dog', color: 'red', cubes: [7, 14], cube: 'bld', pattern: [P(0, 0, 'bld'), P(1, -1, 'bld')] },
  { key: 'bat', name: 'Bell-tower Bat', color: 'red', cubes: [6, 11, 16], cube: 'bld', pattern: [P(0, 0, 'bld'), P(1, 0, 'mtn1'), P(1, -1, 'mtn1')] },
  { key: 'hedgehog', name: 'Hedgehog', color: 'yellow', cubes: [4, 7, 10], cube: 'field', pattern: [P(0, 0, 'field'), P(1, 0, 'tree1'), P(0, 1, 'tree1')] },
];

export function animalByKey(key) {
  return ANIMALS.find((a) => a.key === key);
}

// all board cells where `card`'s cube could legally be placed right now
export function cubeTargetsFor(board, cardKey) {
  const card = animalByKey(cardKey);
  if (!card) return [];
  const targets = new Set();
  for (const anchor of CELLS) {
    for (let rot = 0; rot < 6; rot++) {
      let ok = true;
      for (const part of card.pattern) {
        const [dx, dz] = rotCube(part.dx, part.dz, rot);
        const cid = CELL_BY_XZ.get(`${anchor.x + dx},${anchor.z + dz}`);
        if (cid == null || stackType(board[cid].stack) !== part.t) {
          ok = false;
          break;
        }
      }
      if (ok && !board[anchor.id].cube) targets.add(anchor.id);
    }
  }
  return [...targets];
}

export function cubeTargets(G, seat, cardKey) {
  const p = playerBySeat(G, seat);
  return p ? cubeTargetsFor(p.board, cardKey) : [];
}

// What extra tokens would turn this cell into stack type `t`? Returns null
// when the cell can never become `t` (stacks only grow, cubes freeze cells,
// pattern heights are exact). A building built from scratch needs its red
// plus one base of brown/gray/red — returned as a flexible unit `bldBase`.
export function deltaToBecome(cell, t) {
  const cur = stackType(cell.stack);
  if (cur === t) return {};
  if (cell.cube) return null; // frozen: nothing may be added
  switch (t) {
    case 'water':
      return cur === 'empty' ? { blue: 1 } : null;
    case 'field':
      return cur === 'empty' ? { yellow: 1 } : null;
    case 'tree1':
      return cur === 'empty' ? { green: 1 } : null;
    case 'tree2':
      if (cur === 'empty') return { brown: 1, green: 1 };
      if (cur === 'trunk1') return { green: 1 };
      return null;
    case 'tree3':
      if (cur === 'empty') return { brown: 2, green: 1 };
      if (cur === 'trunk1') return { brown: 1, green: 1 };
      if (cur === 'trunk2') return { green: 1 };
      return null;
    case 'mtn1':
      return cur === 'empty' ? { gray: 1 } : null;
    case 'mtn2':
      if (cur === 'empty') return { gray: 2 };
      if (cur === 'mtn1') return { gray: 1 };
      return null;
    case 'mtn3':
      if (cur === 'empty') return { gray: 3 };
      if (cur === 'mtn1') return { gray: 2 };
      if (cur === 'mtn2') return { gray: 1 };
      return null;
    case 'bld':
      if (cur === 'empty') return { red: 1, bldBase: 1 };
      if (cur === 'redg' || cur === 'mtn1' || cur === 'trunk1') return { red: 1 };
      return null;
    default:
      return null;
  }
}

// Could this card's habitat still be built (and its cube placed) somewhere on
// `board`, given the tokens still obtainable (`supply` = pouch + central
// slots, per color)? Optimistic about which tokens you get — so a `false`
// is a proof of impossibility, never a guess.
export function cardFeasible(board, cardKey, supply) {
  const card = animalByKey(cardKey);
  if (!card) return false;
  for (const anchor of CELLS) {
    if (board[anchor.id].cube) continue; // the cube cell must be cube-free
    rotations: for (let rot = 0; rot < 6; rot++) {
      const need = {};
      let flex = 0;
      for (const part of card.pattern) {
        const [dx, dz] = rotCube(part.dx, part.dz, rot);
        const cid = CELL_BY_XZ.get(`${anchor.x + dx},${anchor.z + dz}`);
        if (cid == null) continue rotations;
        const delta = deltaToBecome(board[cid], part.t);
        if (delta == null) continue rotations;
        for (const [color, n] of Object.entries(delta)) {
          if (color === 'bldBase') flex += n;
          else need[color] = (need[color] || 0) + n;
        }
      }
      let ok = true;
      for (const [color, n] of Object.entries(need)) {
        if ((supply[color] || 0) < n) {
          ok = false;
          break;
        }
      }
      if (ok && flex > 0) {
        // building bases may be brown, gray, or red — spend the spare supply
        const spare =
          Math.max(0, (supply.brown || 0) - (need.brown || 0)) +
          Math.max(0, (supply.gray || 0) - (need.gray || 0)) +
          Math.max(0, (supply.red || 0) - (need.red || 0));
        if (spare < flex) ok = false;
      }
      if (ok) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- scoring

export function scoreBoard(board, side = 'A') {
  const s = { trees: 0, mountains: 0, fields: 0, water: 0, buildings: 0 };
  const type = board.map((c) => stackType(c.stack));

  for (let i = 0; i < board.length; i++) {
    const t = type[i];
    if (t === 'tree1') s.trees += 1;
    else if (t === 'tree2') s.trees += 3;
    else if (t === 'tree3') s.trees += 5;
    else if (t.startsWith('mtn')) {
      const near = NEIGHBORS[i].some((n) => type[n].startsWith('mtn'));
      if (near) s.mountains += { mtn1: 1, mtn2: 3, mtn3: 7 }[t];
    } else if (t === 'bld') {
      const tops = new Set();
      for (const n of NEIGHBORS[i]) {
        const st = board[n].stack;
        if (st.length) tops.add(st[st.length - 1]);
      }
      if (tops.size >= 3) s.buildings += 5;
    }
  }

  // fields: 5 per connected group of 2+ yellows
  const seen = new Set();
  for (let i = 0; i < board.length; i++) {
    if (type[i] !== 'field' || seen.has(i)) continue;
    const group = [i];
    seen.add(i);
    for (let k = 0; k < group.length; k++) {
      for (const n of NEIGHBORS[group[k]]) {
        if (type[n] === 'field' && !seen.has(n)) {
          seen.add(n);
          group.push(n);
        }
      }
    }
    if (group.length >= 2) s.fields += 5;
  }

  if (side === 'B') {
    // Side B: the blue tokens carve the board into islands — each connected
    // group of non-blue spaces (empty spaces included) is worth 5 points
    let islands = 0;
    const iseen = new Set();
    for (let i = 0; i < board.length; i++) {
      if (type[i] === 'water' || iseen.has(i)) continue;
      islands += 1;
      const group = [i];
      iseen.add(i);
      for (let k = 0; k < group.length; k++) {
        for (const n of NEIGHBORS[group[k]]) {
          if (type[n] !== 'water' && !iseen.has(n)) {
            iseen.add(n);
            group.push(n);
          }
        }
      }
    }
    s.water = islands * 5;
  } else {
    // Side A: best river = longest shortest-path between two blues in a group
    const RIVER = [0, 0, 2, 5, 8, 11, 15];
    let best = 0;
    const groups = [];
    const gseen = new Set();
    for (let i = 0; i < board.length; i++) {
      if (type[i] !== 'water' || gseen.has(i)) continue;
      const group = [i];
      gseen.add(i);
      for (let k = 0; k < group.length; k++) {
        for (const n of NEIGHBORS[group[k]]) {
          if (type[n] === 'water' && !gseen.has(n)) {
            gseen.add(n);
            group.push(n);
          }
        }
      }
      groups.push(group);
    }
    for (const group of groups) {
      let diameter = 1;
      const inGroup = new Set(group);
      for (const start of group) {
        const dist = new Map([[start, 1]]);
        const q = [start];
        while (q.length) {
          const cur = q.shift();
          for (const n of NEIGHBORS[cur]) {
            if (inGroup.has(n) && !dist.has(n)) {
              dist.set(n, dist.get(cur) + 1);
              q.push(n);
            }
          }
        }
        for (const d of dist.values()) diameter = Math.max(diameter, d);
      }
      const pts = diameter <= 6 ? RIVER[diameter] : 15 + 4 * (diameter - 6);
      best = Math.max(best, pts);
    }
    s.water = best;
  }

  s.landscape = s.trees + s.mountains + s.fields + s.water + s.buildings;
  return s;
}

export function scoreAnimals(p) {
  let total = 0;
  const rows = [];
  for (const c of p.cards.concat(p.done)) {
    const card = animalByKey(c.key);
    const placed = c.placed;
    const pts = placed > 0 ? card.cubes[placed - 1] : 0;
    total += pts;
    rows.push({ key: c.key, placed, pts });
  }
  return { total, rows };
}

export function scoreFor(G, seat) {
  const p = playerBySeat(G, seat);
  const land = scoreBoard(p.board, G.side);
  const animals = scoreAnimals(p);
  return { ...land, animals: animals.total, total: land.landscape + animals.total, animalRows: animals.rows };
}

// ---------------------------------------------------------------- setup

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function playerBySeat(G, seat) {
  return G.players.find((p) => p.seat === seat);
}

function addLog(G, text) {
  G.feedSeq += 1;
  G.log.push({ n: G.feedSeq, text });
  if (G.log.length > 250) G.log.shift();
}

function setFx(G, fx) {
  G.fxSeq += 1;
  G.fx = { seq: G.fxSeq, ...fx };
}

export function newMatch(roster, sideKey) {
  const pouch = [];
  for (const [color, n] of Object.entries(TOKEN_COUNTS)) {
    for (let i = 0; i < n; i++) pouch.push(color);
  }
  shuffle(pouch);
  const deck = shuffle(ANIMALS.map((a) => a.key));
  const G = {
    proto: PROTO,
    mid: Math.random().toString(36).slice(2, 10),
    side: sideByKey(sideKey).key,
    phase: 'playing',
    players: roster
      .map((r) => ({
        seat: r.seat,
        name: r.name,
        bot: !!r.bot,
        connected: r.connected !== false,
        board: CELLS.map(() => ({ stack: [], cube: null })),
        tray: [],
        tookTokens: false,
        tookCard: false,
        cards: [], // {key, placed}
        done: [],
        cubesPlaced: 0,
        lastAction: null,
      }))
      .sort((a, b) => a.seat - b.seat),
    pouch,
    slots: [[], [], [], [], []],
    deck,
    display: [],
    turn: null,
    first: null,
    turnNo: 0,
    endAfter: null, // seat whose turn is the game's last
    result: null,
    log: [],
    feedSeq: 0,
    fx: null,
    fxSeq: 0,
  };
  for (let i = 0; i < 5; i++) G.slots[i] = G.pouch.splice(0, 3);
  G.display = G.deck.splice(0, DISPLAY);
  G.first = G.players[Math.floor(Math.random() * G.players.length)].seat;
  G.turn = G.first;
  addLog(G, `The pouch holds 120 tokens — playing ${sideByKey(G.side).name}. ${playerBySeat(G, G.first).name} saw the most magnificent landscape and starts.`);
  return G;
}

// ---------------------------------------------------------------- legality

export function legalCellsFor(board, color) {
  const out = [];
  for (const c of CELLS) {
    const cell = board[c.id];
    if (cell.cube) continue;
    if (canPlaceOn(cell.stack, color)) out.push(c.id);
  }
  return out;
}

export function legalCells(G, seat, color) {
  const p = playerBySeat(G, seat);
  return p ? legalCellsFor(p.board, color) : [];
}

function emptyCount(p) {
  return p.board.filter((c) => c.stack.length === 0).length;
}

// ---------------------------------------------------------------- moves

export function applyMove(G, seat, move) {
  if (!G || !move || typeof move !== 'object') return { ok: false, error: 'Bad move' };
  if (G.phase !== 'playing') return { ok: false, error: 'The game is over' };
  const p = playerBySeat(G, seat);
  if (!p) return { ok: false, error: 'Not at the table' };
  if (G.turn !== seat) return { ok: false, error: 'Not your turn' };
  if (move.kind === 'take') return doTake(G, p, move);
  if (move.kind === 'place') return doPlace(G, p, move);
  if (move.kind === 'discard') return doDiscard(G, p, move);
  if (move.kind === 'card') return doCard(G, p, move);
  if (move.kind === 'cube') return doCube(G, p, move);
  if (move.kind === 'end') return doEnd(G, p);
  return { ok: false, error: 'Unknown action' };
}

function doTake(G, p, move) {
  if (p.tookTokens) return { ok: false, error: 'You already took tokens this turn' };
  const slot = G.slots[move.slot];
  if (!slot || !slot.length) return { ok: false, error: 'That spot is empty' };
  p.tray = slot.slice();
  G.slots[move.slot] = [];
  p.tookSlot = move.slot;
  p.tookTokens = true;
  addLog(G, `${p.name} takes ${p.tray.join(', ')} from the central board.`);
  return { ok: true };
}

function doPlace(G, p, move) {
  const i = move.tokenIdx;
  if (!p.tray.length || i == null || i < 0 || i >= p.tray.length) return { ok: false, error: 'Pick a token from your tray' };
  const color = p.tray[i];
  const cell = p.board[move.cell];
  if (!cell) return { ok: false, error: 'Pick a space' };
  if (cell.cube) return { ok: false, error: 'An animal has settled there' };
  if (!canPlaceOn(cell.stack, color)) {
    return { ok: false, error: 'That token cannot go there — stacks only form trees, mountains, or buildings' };
  }
  cell.stack.push(color);
  p.tray.splice(i, 1);
  setFx(G, { kind: 'place', seat: p.seat, cell: move.cell, color });
  return { ok: true };
}

function doDiscard(G, p, move) {
  const i = move.tokenIdx;
  if (!p.tray.length || i == null || i < 0 || i >= p.tray.length) return { ok: false, error: 'Pick a token from your tray' };
  const color = p.tray[i];
  if (legalCells(G, p.seat, color).length > 0) {
    return { ok: false, error: 'That token still has a legal space — it must be placed' };
  }
  p.tray.splice(i, 1);
  addLog(G, `${p.name} has no legal space for a ${color} token — it is returned to the box.`);
  return { ok: true };
}

function doCard(G, p, move) {
  if (p.tookCard) return { ok: false, error: 'You already took an animal card this turn' };
  if (p.cards.length >= HAND_LIMIT) return { ok: false, error: `You already have ${HAND_LIMIT} animal cards in progress` };
  const idx = G.display.indexOf(move.card);
  if (idx < 0) return { ok: false, error: 'That card is not on display' };
  G.display.splice(idx, 1);
  p.cards.push({ key: move.card, placed: 0 });
  p.tookCard = true;
  const a = animalByKey(move.card);
  addLog(G, `${p.name} takes the ${a.name} card.`);
  p.lastAction = `took the ${a.name}`;
  return { ok: true };
}

function doCube(G, p, move) {
  const held = p.cards.find((c) => c.key === move.card);
  if (!held) return { ok: false, error: 'That card is not in front of you' };
  const card = animalByKey(move.card);
  if (held.placed >= card.cubes.length) return { ok: false, error: 'That card is already complete' };
  const targets = cubeTargets(G, p.seat, move.card);
  if (!targets.includes(move.cell)) return { ok: false, error: 'That habitat is not complete there' };
  p.board[move.cell].cube = { color: card.color, key: card.key };
  held.placed += 1;
  p.cubesPlaced += 1;
  addLog(G, `${p.name} settles a ${card.name} (${held.placed}/${card.cubes.length}).`);
  p.lastAction = `settled a ${card.name}`;
  setFx(G, { kind: 'cube', seat: p.seat, cell: move.cell });
  if (held.placed >= card.cubes.length) {
    p.cards = p.cards.filter((c) => c !== held);
    p.done.push(held);
    addLog(G, `${p.name}'s ${card.name} card is complete!`);
  }
  return { ok: true };
}

function doEnd(G, p) {
  if (!p.tookTokens) return { ok: false, error: 'You must take tokens from the central board first' };
  if (p.tray.length) return { ok: false, error: 'Place (or return) all your tokens first' };

  // refill the taken slot and the animal row
  const refill = Math.min(3, G.pouch.length);
  G.slots[p.tookSlot] = G.pouch.splice(0, refill);
  const pouchEmpty = G.pouch.length === 0;
  while (G.display.length < DISPLAY && G.deck.length) G.display.push(G.deck.shift());

  const empties = emptyCount(p);
  p.tookTokens = false;
  p.tookCard = false;
  p.tookSlot = null;
  G.turnNo += 1;

  // end triggers: pouch drained at refill, or the board is nearly full
  if (G.endAfter == null && (pouchEmpty || empties <= 2)) {
    const seats = G.players.map((q) => q.seat);
    const fi = seats.indexOf(G.first);
    G.endAfter = seats[(fi + seats.length - 1) % seats.length]; // complete the round
    addLog(
      G,
      pouchEmpty ? 'The pouch is empty — this is the final round!' : `${p.name}'s landscape is nearly full — this is the final round!`,
    );
    setFx(G, { kind: 'lastround' });
  }
  if (G.endAfter != null && p.seat === G.endAfter) {
    finish(G);
    return { ok: true };
  }
  const seats = G.players.map((q) => q.seat);
  G.turn = seats[(seats.indexOf(p.seat) + 1) % seats.length];
  return { ok: true };
}

function finish(G) {
  G.phase = 'over';
  const scores = G.players.map((p) => ({ seat: p.seat, ...scoreFor(G, p.seat), cubes: p.cubesPlaced }));
  const best = Math.max(...scores.map((s) => s.total));
  let winners = scores.filter((s) => s.total === best);
  if (winners.length > 1) {
    const mostCubes = Math.max(...winners.map((w) => w.cubes));
    winners = winners.filter((w) => w.cubes === mostCubes);
  }
  G.result = { scores, winners: winners.map((w) => w.seat) };
  const names = winners.map((w) => playerBySeat(G, w.seat).name).join(' & ');
  addLog(G, `The landscapes are complete — ${names} win${winners.length === 1 ? 's' : ''} with ${best} points!`);
  setFx(G, { kind: 'over' });
}

// ---------------------------------------------------------------- lifecycle

export function markDisconnected(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p || !p.connected) return false;
  p.connected = false;
  addLog(G, `${p.name} disconnected — the wind tends their landscape.`);
  return true;
}

// ---------------------------------------------------------------- views
// Harmonies is an open-information game: every board, tray, and card is
// public. Only the pouch order is secret (and it lives host-side anyway).

export function viewFor(G, seat, code) {
  return {
    t: 'state',
    code,
    you: seat,
    mid: G.mid,
    phase: G.phase,
    side: G.side,
    turn: G.turn,
    first: G.first,
    turnNo: G.turnNo,
    lastRound: G.endAfter != null,
    pouchCount: G.pouch.length,
    pouchColors: G.pouch.reduce((m, c) => {
      m[c] = (m[c] || 0) + 1;
      return m;
    }, {}),
    deckCount: G.deck.length,
    slots: G.slots,
    display: G.display,
    players: G.players.map((p) => ({
      seat: p.seat,
      name: p.name,
      bot: p.bot,
      connected: p.connected,
      board: p.board,
      tray: p.tray,
      tookTokens: p.tookTokens,
      tookCard: p.tookCard,
      cards: p.cards,
      done: p.done,
      cubesPlaced: p.cubesPlaced,
      lastAction: p.lastAction,
      score: scoreFor(G, p.seat),
      empties: emptyCount(p),
    })),
    result: G.result,
    log: G.log.slice(-60),
    fx: G.fx,
  };
}

// ---------------------------------------------------------------- bots
// Greedy with lookahead on the tray: for each central slot, simulate the
// best greedy placement of its 3 tokens and pick the slot with the best
// score delta (terrain + animal ladders + small shaping heuristics).

function boardScoreWithPotential(G, p) {
  const land = scoreBoard(p.board, G.side);
  let potential = 0;
  // nudge toward finishing held cards: partial credit per matched pattern cell
  for (const held of p.cards) {
    const card = animalByKey(held.key);
    const remaining = card.cubes.length - held.placed;
    if (remaining <= 0) continue;
    const next = card.cubes[held.placed];
    let bestFrac = 0;
    for (const anchor of CELLS) {
      for (let rot = 0; rot < 6; rot++) {
        let hit = 0;
        let possible = true;
        for (const part of card.pattern) {
          const [dx, dz] = rotCube(part.dx, part.dz, rot);
          const cid = CELL_BY_XZ.get(`${anchor.x + dx},${anchor.z + dz}`);
          if (cid == null) {
            possible = false;
            break;
          }
          if (stackType(p.board[cid].stack) === part.t) hit += 1;
        }
        if (possible && hit > 0) bestFrac = Math.max(bestFrac, hit / card.pattern.length);
      }
    }
    potential += next * 0.35 * bestFrac;
  }
  return land.landscape + potential;
}

function botPlaceOne(G, p, color) {
  // choose the legal cell that maximizes score-with-potential
  const cells = legalCells(G, p.seat, color);
  if (!cells.length) return null;
  let best = cells[0];
  let bestVal = -Infinity;
  for (const cid of cells) {
    p.board[cid].stack.push(color);
    const v = boardScoreWithPotential(G, p) + Math.random() * 0.01;
    p.board[cid].stack.pop();
    if (v > bestVal) {
      bestVal = v;
      best = cid;
    }
  }
  return best;
}

export function botChoose(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p || G.turn !== seat || G.phase !== 'playing') return null;

  // settle any cube that fits (ladders only go up)
  for (const held of p.cards) {
    const card = animalByKey(held.key);
    if (held.placed >= card.cubes.length) continue;
    const targets = cubeTargets(G, seat, held.key);
    if (targets.length) return { kind: 'cube', card: held.key, cell: targets[0] };
  }

  if (!p.tookTokens) {
    // pick the slot whose greedy placement gains the most
    let bestSlot = null;
    let bestVal = -Infinity;
    for (let s = 0; s < 5; s++) {
      const slot = G.slots[s];
      if (!slot.length) continue;
      const placed = [];
      let val = 0;
      for (const color of slot) {
        const cid = botPlaceOne(G, p, color);
        if (cid == null) continue;
        p.board[cid].stack.push(color);
        placed.push(cid);
      }
      val = boardScoreWithPotential(G, p);
      for (let k = placed.length - 1; k >= 0; k--) p.board[placed[k]].stack.pop();
      if (val > bestVal) {
        bestVal = val;
        bestSlot = s;
      }
    }
    if (bestSlot == null) bestSlot = G.slots.findIndex((s) => s.length);
    return { kind: 'take', slot: bestSlot };
  }

  if (p.tray.length) {
    // place the most constrained token first
    let bestIdx = 0;
    let bestCell = null;
    let fewest = Infinity;
    for (let i = 0; i < p.tray.length; i++) {
      const cells = legalCells(G, seat, p.tray[i]);
      if (cells.length === 0) return { kind: 'discard', tokenIdx: i };
      if (cells.length < fewest) {
        fewest = cells.length;
        bestIdx = i;
      }
    }
    bestCell = botPlaceOne(G, p, p.tray[bestIdx]);
    if (bestCell == null) return { kind: 'discard', tokenIdx: bestIdx };
    return { kind: 'place', tokenIdx: bestIdx, cell: bestCell };
  }

  if (!p.tookCard && p.cards.length < HAND_LIMIT && G.display.length) {
    // take the display card whose pattern best matches the board's direction
    let bestCard = null;
    let bestVal = 2.2; // only bother if it beats indifference
    for (const key of G.display) {
      const card = animalByKey(key);
      const avg = card.cubes.reduce((a, b) => a + b, 0) / card.cubes.length;
      let frac = 0;
      for (const anchor of CELLS) {
        for (let rot = 0; rot < 6; rot++) {
          let hit = 0;
          let possible = true;
          for (const part of card.pattern) {
            const [dx, dz] = rotCube(part.dx, part.dz, rot);
            const cid = CELL_BY_XZ.get(`${anchor.x + dx},${anchor.z + dz}`);
            if (cid == null) {
              possible = false;
              break;
            }
            if (stackType(p.board[cid].stack) === part.t) hit += 1;
          }
          if (possible) frac = Math.max(frac, hit / card.pattern.length);
        }
      }
      const val = avg * (0.3 + frac);
      if (val > bestVal) {
        bestVal = val;
        bestCard = key;
      }
    }
    if (bestCard) return { kind: 'card', card: bestCard };
  }

  return { kind: 'end' };
}
