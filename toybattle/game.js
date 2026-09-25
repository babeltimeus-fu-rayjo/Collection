// Toy Battle — engine.
//
// An unofficial implementation of TOY BATTLE by Paolo Mori and Alessandro
// Zucchini (© Repos Production, 2025). Two players, ~15 minutes.
//
// PROVENANCE, because it matters and the two halves are not equal:
//
//   The RULES are exact. Troop strengths, every troop effect and its printed
//   Note, the two turn actions, the placement and connection rules, region
//   control, the rack cap, the ordering of effects and all three end
//   conditions are transcribed from the publisher's own English rulebook
//   (toy-en01-rules) and English player aid (toy-en01-player-aid). The eight
//   Terrain powers are likewise transcribed word for word.
//
//   The BOARDS are being transcribed one at a time from photographs of the
//   physical boards, and each Terrain below says which it is in `source`:
//     'board'     read off the printed board and checked against it —
//                 bases, paths, regions, Medals and the printed objective
//     'invented'  our own layout in the game's grammar, carrying the
//                 Terrain's real name and real power but NOT its printed
//                 geometry; its Medals objective was picked by simulation.
//   Repos publishes no readable scan of the Terrains, so the photographs are
//   the only source. The lobby shows each board's source to the players.
//
// A Terrain is written out as its nodes, its paths and its regions, because
// the printed boards are irregular: the paths fork and run at angles, the
// bases are not on a lattice, and a region can be ringed by three bases or by
// five. An earlier grid format could not express any of that.
//
//   nodes    label: [x, y] — and a third entry of space-separated tags:
//              'hq0' blue H.Q.   'hq1' red H.Q.   'special' a special base
//              'only:4,5,6,7,joker' admits just those Troops — on a base or
//              on an H.Q., since Tropical Pool prints its value triangles
//              beside individual H.Q. and not across the whole board
//            x and y are in whatever units suit the board; only their
//            relative positions matter, and the renderer scales to fit.
//   paths    'a-b b-c ...', one pair per path segment, in either order
//   regions  [medals, 'a b c d'] — the bases that ring it, in any order
//
// The parser rejects a path to a node that does not exist, and a region whose
// bases do not actually form a closed ring, which is the mistake you make
// copying a board off a photograph.

export const PROTO = 1;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 2;

export const RACK_MAX = 8;       // "Your rack can hold up to 8 Troops maximum."
export const SET_ASIDE = 4;      // "Remove 4 Troops from your reserve"
export const COPIES = 3;         // "Each Troop, with 3 copies of each"

// ---------------------------------------------------------------- the troops
//
// `str: null` is Kwak's joker. Everything in `text` is the player aid's own
// wording; `note` is the Note printed under it.

export const TROOPS = {
  kwak: {
    key: 'kwak', name: 'Kwak', str: null, order: 0, glyph: '🦆',
    cry: 'You’ll never see me coming!',
    text: 'Kwak has no effect. As a joker, Kwak may be placed on top of any enemy Troop, but any enemy Troop may also cover it.',
  },
  skully: {
    key: 'skully', name: 'Skully', str: 1, order: 1, glyph: '💀',
    cry: 'Get ready for invasion…',
    text: 'You may draw 2 Troops from your reserve and place them on your rack.',
    note: 'If you already have 7 Troops on your rack, you draw only one.',
  },
  capn: {
    key: 'capn', name: 'Cap’n', str: 2, order: 2, glyph: '🪖',
    cry: 'You there… With me!',
    text: 'You may place 1 extra Troop on the Terrain and apply its effect.',
    note: 'First apply all the effects of Troops you just placed, then apply any special base effects.',
  },
  jumbo: {
    key: 'jumbo', name: 'Jumbo', str: 3, order: 3, glyph: '🤖',
    cry: 'Bit of advice: keep your distance…',
    text: 'You may choose 1 visible enemy Troop — adjacent to Jumbo — and discard it faceup.',
    note: 'Troops are adjacent if they are connected by a single section of path.',
  },
  hook: {
    key: 'hook', name: 'Hook', str: 4, order: 4, glyph: '🐵',
    cry: 'My specialty: jump straight across enemy lines.',
    text: 'You may ignore the connection rule and place Hook on any base whether or not it is connected to your H.Q.',
    note: 'To place Hook on the enemy H.Q. (which is not a base), it must be connected to your H.Q.',
  },
  xb42: {
    key: 'xb42', name: 'XB-42', str: 5, order: 5, glyph: '👾',
    cry: 'My blasters always hit their mark.',
    text: 'You may take, at random, 1 Troop from your opponent’s rack and discard it faceup.',
  },
  star: {
    key: 'star', name: 'Star', str: 6, order: 6, glyph: '🦄',
    cry: 'Who’s with me?',
    text: 'You may draw 1 Troop from your reserve and place it on your rack.',
  },
  roxy: {
    key: 'roxy', name: 'Roxy', str: 7, order: 7, glyph: '🦖',
    cry: 'It’s MY base!',
    text: 'Roxy has no effect.',
  },
};

export const TROOP_ORDER = Object.values(TROOPS).sort((a, b) => a.order - b.order).map((t) => t.key);

export const troop = (key) => TROOPS[key];
export const strengthOf = (key) => TROOPS[key].str;
export const troopLabel = (key) => {
  const t = TROOPS[key];
  return t.str === null ? `${t.name} (joker)` : `${t.name} (${t.str})`;
};

// A tile covers the one under it if it is stronger — or if either of them is
// the joker, which is the whole of Kwak: it climbs on anything, and anything
// climbs on it.
export function canCover(key, underKey) {
  if (underKey === null || underKey === undefined) return true;
  if (key === 'kwak' || underKey === 'kwak') return true;
  return strengthOf(key) > strengthOf(underKey);
}

// ------------------------------------------------------------- the terrains

// Each Terrain's `power` text is the player aid's, verbatim. `special` is the
// handler key the engine switches on.
export const POWERS = {
  retreat: { cry: 'The drums sound the retreat.', text: 'You may choose 1 of your other Troops, no matter where it is on the Terrain, and place it back on your rack.' },
  buoy: { cry: 'Get to your buoy!', text: 'Only Troops with the indicated values can be placed on these special bases and H.Q.' },
  splendor: { cry: 'How can we resist its splendor…', text: 'You may draw 1 Troop from your reserve and place it on your rack.' },
  eruption: { cry: 'Eruptiooooooooon!', text: 'You may choose 1 enemy Troop that is adjacent to this special base. Move it to a base that is adjacent to its starting base, ignoring the placement rules.' },
  undead: { cry: 'They’re back… Eek!', text: 'You may choose 1 of your Troops in the discard and place it on your rack.' },
  quarter: { cry: 'Give no quarter!', text: 'This Terrain has no special bases, but it is asymmetric with 2 blue H.Q. and 1 red H.Q.' },
  shield: { cry: 'Anti-effect shield activated!', text: 'Troop effects are not applied on these special bases.' },
  sniper: { cry: 'Snipers sighted, find cover!', text: 'Point to 1 Troop on your opponent’s rack, without looking at it. Your opponent lays it down, facedown, and cannot place it on their turn. At the end of their turn, your opponent places the Troop back on their rack: it’s available again.' },
};

const TERRAIN_DEFS = [
  {
    // Transcribed from a photograph of the printed board and confirmed against
    // it by the owner, 2026-09-25. The board is half-turn symmetric, so the
    // bottom half is the top half rotated; coordinates are percentages of the
    // board, origin top-left. Its Medals objective is printed in the corner.
    key: 'castle', name: 'Castle Field', power: 'retreat', target: 7, source: 'board',
    tag: 'Stone keeps on a green field, a moat at each end and a river across the middle.',
    nodes: {
      R: [50, 4, 'hq1'],
      a: [16, 12],
      b: [84, 12],
      c: [42, 26],
      d: [58, 26],
      e: [18, 33, 'special'],
      f: [82, 33, 'special'],
      g: [19, 50],
      h: [50, 50],
      i: [81, 50],
      j: [18, 67, 'special'],
      k: [82, 67, 'special'],
      l: [42, 74],
      m: [58, 74],
      n: [16, 88],
      o: [84, 88],
      B: [50, 96, 'hq0'],
    },
    // The keep's only ways out are the two drawbridges over its moat, and each
    // leads to a corner base. A corner base does not touch the winch tower
    // beside it, and neither does the inner base below it — the tower hangs
    // off the two bases on its own flank.
    paths: 'R-a R-b a-c b-d c-e d-f c-g c-h d-h d-i e-g f-i '
      + 'B-n B-o n-l o-m l-j m-k l-h l-g m-h m-i j-g k-i',
    regions: [
      // The big one at each end: the whole apron in front of a keep, walled
      // by its own moat between the two drawbridges. Five bases to close.
      [3, 'R b d h c a'],
      [3, 'B n l h m o'],
      // a triangle around each winch tower
      [1, 'c e g'],
      [1, 'd f i'],
      [1, 'g j l'],
      [1, 'i k m'],
      // and the river, either side of the middle bridge
      [2, 'c g l h'],
      [2, 'd h m i'],
    ],
  },
  {
    // Transcribed from a photograph of the printed board; paths and Medals
    // corrected and confirmed by its owner, 2026-09-25. Half-turn symmetric:
    // a↔m b↔l c↔k d↔j e↔i f↔h R1↔B2 R2↔B1, with g in the centre. Two H.Q. a
    // side, each with a single way in, and only R1 and B2 carry a triangle.
    // STILL PENDING: the numbers printed on the value triangles. The lists
    // below on d, e, g, i, j, R1 and B2 are placeholders, not the board's.
    key: 'pool', name: 'Tropical Pool', power: 'buoy', target: 6, source: 'board',
    tag: 'Tyres and floats across a pool. The floats only take the Troops their triangle names.',
    nodes: {
      R1: [25, 12, 'hq1 only:6,7'],
      a: [50, 14],
      R2: [75, 12, 'hq1'],
      b: [25, 26],
      c: [50, 28],
      d: [75, 26, 'only:1,2'],
      e: [25, 41, 'only:3,4,5'],
      f: [75, 40],
      g: [50, 50, 'only:6,7'],
      h: [25, 60],
      i: [75, 59, 'only:3,4,5'],
      j: [25, 74, 'only:1,2'],
      k: [50, 72],
      l: [75, 74],
      B1: [25, 88, 'hq0'],
      m: [50, 86],
      B2: [75, 88, 'hq0 only:6,7'],
    },
    // paths confirmed by the user against the board, 2026-09-25: every H.Q.
    // has a single way in, and the centre float is a six-way hub
    paths: 'a-R2 a-c b-c c-d b-e e-h h-j d-f f-i i-l c-g g-k b-g g-l j-k k-l k-m B1-m '
      + 'R1-c a-d h-g g-f j-m k-B2',
    // Medals as read off the board by its owner, 2026-09-25
    regions: [
      [1, 'a c d'],
      [1, 'b c g'],
      [2, 'c d f g'],
      [2, 'b e h g'],
      [2, 'f g i l'],
      [2, 'g h j k'],
      [1, 'g k l'],
      [1, 'j k m'],
    ],
  },
  {
    // Transcribed from a photograph of the printed board with its paths and
    // Medals marked on it by the board's owner, 2026-09-25. A landscape board:
    // blue's H.Q. at the left end of the rainbow, red's at the right, and the
    // renderer turns it so each player still sees their own at the bottom.
    // Laid out in a 150 x 100 frame to keep the board's proportions. Half-turn
    // symmetric: a↔n b↔m c↔l d↔k e↔j f↔i g↔h B↔R. f, g, h and i are the four
    // special bases on the rainbow, each with the draw icon. Nothing runs
    // along the rainbow itself. The objective, 8, is read from the corner
    // badge; the owner marked every Medal but l-m-h, which the pattern gives.
    key: 'clouds', name: 'City of Clouds', power: 'splendor', target: 8, source: 'board',
    tag: 'Cloud-bridges looping over a rainbow. Every base on the rainbow hands you a Troop.',
    nodes: {
      a: [15, 10], b: [45, 10], c: [75, 10], d: [105, 10], e: [135, 10],
      B: [5, 50, 'hq0'],
      f: [30, 50, 'special'], g: [60, 50, 'special'], h: [90, 50, 'special'], i: [120, 50, 'special'],
      R: [145, 50, 'hq1'],
      j: [15, 90], k: [45, 90], l: [75, 90], m: [105, 90], n: [135, 90],
    },
    paths: 'a-b b-c c-d d-e j-k k-l l-m m-n B-a B-j R-e R-n '
      + 'a-f b-f j-f k-f b-g c-g k-g l-g c-h d-h l-h m-h d-i e-i m-i n-i',
    regions: [
      [1, 'a b f'], [1, 'b c g'], [1, 'c d h'], [1, 'd e i'],
      [1, 'j k f'], [1, 'k l g'], [1, 'l m h'], [1, 'm n i'],
      [1, 'B a f j'], [2, 'f b g k'], [2, 'g c h l'], [2, 'h d i m'], [1, 'i e R n'],
    ],
  },
  {
    // Transcribed from a photograph of the printed board with its paths and
    // Medals marked by the board's owner, 2026-09-25. Blue's H.Q. is top-right
    // and red's bottom-left — the reverse of Castle Field. Laid out in a
    // 100 x 132 frame to keep the board's proportions. Half-turn symmetric
    // about the centre base g: a↔m b↔l c↔k d↔j e↔i f↔h B↔R. c and k are the
    // volcano platforms. The two triangles beside the H.Q. (b-B-e, i-l-R)
    // hold no Medals and are not listed.
    key: 'jungle', name: 'Volcanic Jungle', power: 'eruption', target: 7, source: 'board',
    tag: 'Two volcanoes and the jungle between them. Stand too close and you get thrown.',
    nodes: {
      a: [20, 10], b: [50, 10], B: [80, 10, 'hq0'],
      c: [16, 38, 'special'], d: [50, 38], e: [80, 38],
      f: [20, 66], g: [50, 66], h: [80, 66],
      i: [20, 94], j: [50, 94], k: [84, 94, 'special'],
      R: [20, 122, 'hq1'], l: [50, 122], m: [80, 122],
    },
    paths: 'a-b b-B a-c b-d b-e B-e c-d c-f d-g e-h f-g g-h f-i g-j h-k j-k i-R i-l j-l k-m R-l l-m',
    regions: [
      [2, 'a b d c'],
      [3, 'b e h g d'],
      [2, 'c d g f'],
      [3, 'f g j l i'],
      [2, 'g h k j'],
      [2, 'j k m l'],
    ],
  },
  {
    // Transcribed from a photograph of the printed board with its paths and
    // Medals marked by the board's owner, 2026-09-25. A landscape board: red's
    // H.Q. top-left, blue's bottom-right, the four pumpkins (the graves) near
    // the corners. Laid out in a 150 x 100 frame. Half-turn symmetric about the
    // centre base h: a↔o b↔n c↔m d↔l e↔k f↔j g↔i R↔B. The two triangles beside
    // the H.Q. (R-g-j, f-i-B) hold no Medals and are not listed.
    key: 'cemetery', name: 'Cursed Cemetery', power: 'undead', target: 7, source: 'board',
    tag: 'Nothing here stays buried. Four pumpkin graves hand your losses back.',
    nodes: {
      R: [13, 17, 'hq1'], a: [39, 16, 'special'], b: [81, 16], c: [120, 18, 'special'],
      d: [60, 33], e: [101, 34], f: [138, 34],
      g: [41, 47], h: [81, 50], i: [121, 53],
      j: [24, 66], k: [61, 67], l: [102, 67],
      m: [42, 84, 'special'], n: [81, 84], o: [123, 84, 'special'], B: [149, 83, 'hq0'],
    },
    paths: 'R-g R-j a-g a-d d-b d-g b-e e-c c-f e-f d-h d-k e-h e-l f-i f-B '
      + 'g-j h-k h-l i-l j-k j-m m-k k-n n-l l-o i-o i-B',
    regions: [
      [1, 'a d g'], [2, 'd b e h'], [1, 'e c f'], [2, 'e f i l'],
      [1, 'd h k'], [1, 'e h l'], [2, 'g d k j'],
      [1, 'j k m'], [2, 'k h l n'], [1, 'l i o'],
    ],
  },
  {
    key: 'caribbean', name: 'Caribbean Sea', power: 'quarter', target: 5, source: 'invented',
    tag: "Asymmetric: two blue H.Q. against one red. Red has to be quicker.",
    nodes: {
      R: [2, 0, 'hq1'],
      a: [0, 1],
      b: [1, 1],
      c: [2, 1],
      d: [3, 1],
      e: [4, 1],
      f: [0, 2],
      g: [1, 2],
      h: [2, 2],
      i: [3, 2],
      j: [4, 2],
      k: [0, 3],
      l: [1, 3],
      m: [2, 3],
      n: [3, 3],
      o: [4, 3],
      p: [0, 4],
      q: [1, 4],
      r: [2, 4],
      s: [3, 4],
      t: [4, 4],
      B: [0, 5, 'hq0'],
      B2: [4, 5, 'hq0'],
    },
    paths: 'R-c a-b b-c c-d d-e a-f b-g c-h d-i e-j f-g g-h h-i i-j f-k g-l h-m i-n j-o k-l l-m m-n n-o k-p l-q m-r n-s o-t p-q q-r r-s s-t p-B t-B2 R-b R-d q-B s-B2',
    regions: [
      [1, 'a b f g'],
      [2, 'b c g h'],
      [2, 'c d h i'],
      [1, 'd e i j'],
      [1, 'k l p q'],
      [2, 'l m q r'],
      [2, 'm n r s'],
      [1, 'n o s t'],
    ],
  },
  {
    key: 'metalx', name: 'Station Metal-X', power: 'shield', target: 4, source: 'invented',
    tag: "Shielded plates swallow a Troop’s effect. Land there and you land plain.",
    nodes: {
      R: [1, 0, 'hq1'],
      a: [0, 1],
      b: [1, 1],
      c: [2, 1, 'special'],
      d: [3, 1],
      e: [0, 2],
      f: [1, 2],
      g: [2, 2],
      h: [3, 2],
      i: [0, 3],
      j: [1, 3],
      k: [2, 3],
      l: [3, 3],
      m: [0, 4],
      n: [1, 4, 'special'],
      o: [2, 4],
      p: [3, 4],
      B: [2, 5, 'hq0'],
    },
    paths: 'R-b a-b b-c c-d a-e b-f c-g d-h e-f f-g g-h e-i f-j g-k h-l i-j j-k k-l i-m j-n k-o l-p m-n n-o o-p o-B R-a R-c n-B p-B',
    regions: [
      [2, 'a b e f'],
      [1, 'b c f g'],
      [1, 'c d g h'],
      [1, 'e f i j'],
      [1, 'g h k l'],
      [1, 'i j m n'],
      [1, 'j k n o'],
      [2, 'k l o p'],
    ],
  },
  {
    key: 'battlefield', name: 'Battlefield', power: 'sniper', target: 5, source: 'invented',
    tag: "Two nests overlooking the sand. Take a nest, pin a Troop on their rack.",
    nodes: {
      R: [2, 0, 'hq1'],
      a: [0, 1],
      b: [1, 1],
      c: [2, 1],
      d: [3, 1],
      e: [0, 2],
      f: [1, 2, 'special'],
      g: [2, 2],
      h: [3, 2],
      i: [0, 3],
      j: [1, 3],
      k: [2, 3, 'special'],
      l: [3, 3],
      m: [0, 4],
      n: [1, 4],
      o: [2, 4],
      p: [3, 4],
      B: [1, 5, 'hq0'],
    },
    paths: 'R-c a-b b-c c-d a-e b-f c-g d-h e-f f-g g-h e-i f-j g-k h-l i-j j-k k-l i-m j-n k-o l-p m-n n-o o-p n-B R-b R-d m-B o-B',
    regions: [
      [1, 'a b e f'],
      [1, 'b c f g'],
      [1, 'c d g h'],
      [2, 'e f i j'],
      [1, 'f g j k'],
      [2, 'g h k l'],
      [1, 'i j m n'],
      [1, 'j k n o'],
      [1, 'k l o p'],
    ],
  },
];

// -------------------------------------------------------------- map parsing

// Order a region's nodes along the boundary they actually form. A region is
// usually ringed by paths all the way round, but not always: the grass beside
// Castle Field's keep is closed on one side by the moat, and water is not a
// path you can walk. So a closed ring is tried first and an open chain second
// — either is a real boundary, and anything else is a mistyped board.
// Regions are three to six nodes, so backtracking is instant.
function ringOrder(members, adj) {
  const n = members.length;
  if (n < 2) return null;
  const set = new Set(members);
  const attempt = (closed) => {
    for (const start of members) {
      const path = [start];
      const used = new Set([start]);
      const walk = () => {
        if (path.length === n) return closed ? adj[path[path.length - 1]].includes(start) : true;
        for (const next of adj[path[path.length - 1]]) {
          if (!set.has(next) || used.has(next)) continue;
          used.add(next);
          path.push(next);
          if (walk()) return true;
          path.pop();
          used.delete(next);
        }
        return false;
      };
      if (walk()) return { order: path, closed };
    }
    return null;
  };
  return attempt(true) || attempt(false);
}

function parseTerrain(def) {
  const nodes = [];
  const idOf = new Map();
  for (const [label, spec] of Object.entries(def.nodes)) {
    const [x, y, tagText = ''] = spec;
    if (idOf.has(label)) throw new Error(`${def.key}: two nodes called ${label}`);
    idOf.set(label, nodes.length);
    const tags = tagText.split(/\s+/).filter(Boolean);
    for (const t of tags) {
      if (!/^(hq0|hq1|special|only:[\w,]+)$/.test(t)) throw new Error(`${def.key}: node ${label} has an unknown tag ${t}`);
    }
    const hq = tags.includes('hq0') ? 0 : tags.includes('hq1') ? 1 : null;
    const onlyTag = tags.find((t) => t.startsWith('only:'));
    const only = onlyTag
      ? onlyTag.slice(5).split(',').map((v) => {
        if (v === 'joker') return 'joker';
        const s = Number(v);
        if (!Number.isInteger(s) || s < 1 || s > 7) throw new Error(`${def.key}: node ${label} lists a strength ${v} that no Troop has`);
        return s;
      })
      : null;
    nodes.push({
      id: nodes.length,
      label,
      x,
      y,
      hq,
      // a restricted base is a special base; a restricted H.Q. is still an H.Q.
      special: hq === null && (tags.includes('special') || only !== null),
      only,
    });
  }

  const edges = new Set();
  for (const pair of def.paths.trim().split(/\s+/)) {
    const [p, q] = pair.split('-');
    const a = idOf.get(p);
    const b = idOf.get(q);
    if (a === undefined || b === undefined) throw new Error(`${def.key}: path ${pair} names a node that does not exist`);
    if (a === b) throw new Error(`${def.key}: path ${pair} joins a node to itself`);
    edges.add(a < b ? `${a}|${b}` : `${b}|${a}`);
  }

  const adj = nodes.map(() => []);
  for (const e of edges) {
    const [a, b] = e.split('|').map(Number);
    adj[a].push(b);
    adj[b].push(a);
  }

  // A region is listed as the ring that encloses it, which on the printed
  // boards can run along an H.Q. as well as along bases — the grass beside
  // Castle Field's keep is walled by the moat on one side. An H.Q. is not a
  // base, though ("the H.Q. is not a base"), and nobody can stand on their
  // own, so it bounds the region without being part of what you must hold.
  // `ring` is the shape; `around` is the bases you have to occupy.
  const regions = def.regions.map(([medals, members], i) => {
    const ids = members.trim().split(/\s+/).map((l) => {
      const id = idOf.get(l);
      if (id === undefined) throw new Error(`${def.key}: region ${i} names ${l}, which does not exist`);
      return id;
    });
    const found = ringOrder(ids, adj);
    if (!found) throw new Error(`${def.key}: region ${i} (${members}) is not a boundary — those nodes are not even joined in a line`);
    const ring = found.order;
    const around = ring.filter((n) => nodes[n].hq === null);
    if (!around.length) throw new Error(`${def.key}: region ${i} is walled only by H.Q. and could never be taken`);
    return {
      id: i,
      medals,
      ring,
      closed: found.closed,
      around,
      x: ring.reduce((a, n) => a + nodes[n].x, 0) / ring.length,
      y: ring.reduce((a, n) => a + nodes[n].y, 0) / ring.length,
      owner: null,
    };
  });

  for (const seat of [0, 1]) {
    if (!nodes.some((n) => n.hq === seat)) throw new Error(`${def.key}: no H.Q. for seat ${seat}`);
  }

  if (def.source !== 'board' && def.source !== 'invented') {
    throw new Error(`${def.key}: source must be 'board' or 'invented', so nobody mistakes one for the other`);
  }

  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  return {
    key: def.key, name: def.name, tag: def.tag, power: def.power, target: def.target,
    source: def.source,
    nodes, regions, adj,
    x0: Math.min(...xs), y0: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
    edges: [...edges].map((e) => e.split('|').map(Number)),
  };
}

export const TERRAINS = TERRAIN_DEFS.map(parseTerrain);
export const terrainByKey = (key) => TERRAINS.find((t) => t.key === key) || TERRAINS[0];

// ------------------------------------------------------------------ helpers

function shuffle(a) {
  const out = a.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const bySeat = (G, seat) => G.players.find((p) => p.seat === seat);
const other = (seat) => (seat === 0 ? 1 : 0);

export const topOf = (G, node) => {
  const st = G.board[node];
  return st.length ? st[st.length - 1] : null;
};
const occupant = (G, node) => {
  const t = topOf(G, node);
  return t ? t.owner : null;
};

function note(G, text) {
  G.logSeq += 1;
  G.log.push({ id: G.logSeq, text });
  if (G.log.length > 60) G.log.shift();
}
function bumpFx(G, fx) {
  G.fxSeq += 1;
  G.fx = { seq: G.fxSeq, ...fx };
}

// ------------------------------------------------------------- the rule core

// Every H.Q. belonging to `seat`. Caribbean Sea gives blue two of them, so
// connection has to start from any one.
const hqsOf = (G, seat) => G.terrain.nodes.filter((n) => n.hq === seat).map((n) => n.id);

// The connection rule: "you must always follow a continuous path from your
// H.Q. (starting point) to the Troop you are placing, passing only through
// bases you occupy." The destination itself is not required to be occupied —
// only everything strictly between.
export function reachable(G, seat) {
  const seen = new Set();
  const out = new Set();
  const stack = hqsOf(G, seat);
  for (const h of stack) seen.add(h);
  while (stack.length) {
    const n = stack.pop();
    for (const m of G.terrain.adj[n]) {
      if (!out.has(m)) out.add(m);
      if (seen.has(m)) continue;
      // you may only keep walking through a base you occupy — and an H.Q. is
      // not a base, so a chain may never run through one
      if (G.terrain.nodes[m].hq === null && occupant(G, m) === seat) {
        seen.add(m);
        stack.push(m);
      }
    }
  }
  return out;
}

// Does this Terrain let this tile stand on this node at all? Tropical Pool's
// buoys and H.Q. list the values they accept, and the list can name the joker
// as well as numbers — La Croisette's restricted bases read "a strength of 4,
// 5, 6, 7, or a joker", so 'joker' is a member of the list like any other.
export function valueAllowed(G, node, key) {
  const n = G.terrain.nodes[node];
  const only = n.only;
  if (!only) return true;
  const s = strengthOf(key);
  return only.includes(s === null ? 'joker' : s);
}

// The four slots the rulebook lists, plus the connection rule. `hook` is the
// one exception it grants: Hook ignores connection, but only onto a base —
// the enemy H.Q. is not a base, so Hook still has to be connected for that.
// `reach` is the caller's cached reachable(G, seat). It is only ever an
// optimisation — leave it out and the answer is the same, just slower.
export function canPlace(G, seat, node, key, reach) {
  const n = G.terrain.nodes[node];
  if (n.hq === seat) return false;                       // never your own H.Q.
  if (!valueAllowed(G, node, key)) return false;
  const top = topOf(G, node);
  if (n.hq === null) {
    if (top && top.owner !== seat && !canCover(key, top.key)) return false;
  }
  if (key === 'hook' && n.hq === null) return true;      // Hook skips the walk
  return (reach || reachable(G, seat)).has(node);
}

export function placeOptions(G, seat, key, reach) {
  const r = reach || reachable(G, seat);
  const out = [];
  for (const n of G.terrain.nodes) if (canPlace(G, seat, n.id, key, r)) out.push(n.id);
  return out;
}

const adjacentTo = (G, node) => G.terrain.adj[node];

// "as soon as you occupy all bases surrounding a region, you take control of
// this region" — so this runs after every single mutation, not at end of turn.
function claimRegions(G) {
  for (const r of G.terrain.regions) {
    if (r.owner !== null) continue;
    const who = occupant(G, r.around[0]);
    if (who === null) continue;
    if (!r.around.every((n) => occupant(G, n) === who)) continue;
    r.owner = who;
    const p = bySeat(G, who);
    p.medals += r.medals;
    note(G, `${p.name} takes control of a region — ${r.medals} Medal${r.medals === 1 ? '' : 's'}.`);
    bumpFx(G, { kind: 'medals', seat: who, region: r.id, medals: r.medals });
  }
}

function discardTile(G, tile) {
  G.discard.push(tile);
}

// ------------------------------------------------------------------- setup

export function newMatch(roster, opts = {}) {
  const terrain = terrainByKey(opts.terrain || TERRAINS[Math.floor(Math.random() * TERRAINS.length)].key);
  // the boards carry their own colours: blue is seat 0, red is seat 1
  const starter = Math.floor(Math.random() * 2);
  let uid = 0;

  const G = {
    mid: Math.floor(Math.random() * 1e9),
    proto: PROTO,
    phase: 'playing',
    terrain: JSON.parse(JSON.stringify(terrain)),
    turn: starter,
    starter,
    board: terrain.nodes.map(() => []),
    discard: [],
    pending: null,
    troopQ: [],
    baseQ: [],
    placedThisTurn: [],
    winner: null,
    result: null,
    endedBy: null,
    log: [],
    logSeq: 0,
    fx: null,
    fxSeq: 0,
    players: roster.map((p) => ({
      seat: p.seat,
      name: p.name,
      bot: !!p.bot,
      connected: p.connected !== false,
      rack: [],
      reserve: [],
      medals: 0,
      frozen: null,          // tile id pinned by a sniper, for one turn
      lastAction: null,
    })),
  };

  for (const p of G.players) {
    const bag = [];
    for (const key of TROOP_ORDER) for (let i = 0; i < COPIES; i++) bag.push({ id: `t${uid++}`, key, owner: p.seat });
    // "Remove 4 Troops from your reserve and return them to the box, without
    // looking at them; they will not be used this game."
    p.reserve = shuffle(bag).slice(SET_ASIDE);
  }
  // "This player takes 3 Troops from their reserve... Their opponent does the
  // same, but with 4 Troops."
  for (const p of G.players) {
    const n = p.seat === starter ? 3 : 4;
    for (let i = 0; i < n; i++) p.rack.push(p.reserve.pop());
  }

  note(G, `${terrain.name}. ${bySeat(G, starter).name} opens — first to ${terrain.target} Medals, or take the enemy H.Q.`);
  return G;
}

// ------------------------------------------------------------- turn actions

const rackFull = (p) => p.rack.length >= RACK_MAX;
export const canDraw = (p) => p.reserve.length > 0 && !rackFull(p);

function drawUpTo(G, p, want) {
  let got = 0;
  while (got < want && p.reserve.length && !rackFull(p)) {
    p.rack.push(p.reserve.pop());
    got++;
  }
  return got;
}

// A Troop that a sniper pinned cannot be placed this turn.
const playable = (p) => p.rack.filter((t) => t.id !== p.frozen);

function canAct(G, seat) {
  const p = bySeat(G, seat);
  if (!p) return false;
  if (canDraw(p)) return true;
  return playable(p).some((t) => placeOptions(G, seat, t.key).length > 0);
}

function endTurn(G) {
  const p = bySeat(G, G.turn);
  p.frozen = null;                       // "At the end of their turn... it's available again."
  G.placedThisTurn = [];
  G.turn = other(G.turn);
  const next = bySeat(G, G.turn);
  if (!canAct(G, G.turn)) {
    // "The game also ends if a player cannot draw or place a Troop."
    finish(G, null, `${next.name} can neither draw nor place.`, G.turn);
  }
}

function finish(G, winnerSeat, why, stuckSeat = null) {
  G.phase = 'over';
  G.pending = null;
  G.troopQ = [];
  G.baseQ = [];
  let winner = winnerSeat;
  if (winner === null) {
    const [a, b] = G.players;
    // "compare your Medals... In case of tie, the player who ended the game
    // loses and their opponent wins."
    if (a.medals > b.medals) winner = a.seat;
    else if (b.medals > a.medals) winner = b.seat;
    else winner = other(stuckSeat);
  }
  G.winner = winner;
  G.endedBy = why;
  G.result = {
    winner,
    why,
    scores: G.players.map((p) => ({ seat: p.seat, name: p.name, medals: p.medals, rack: p.rack.length, reserve: p.reserve.length })),
  };
  note(G, `${why} ${bySeat(G, winner).name} wins.`);
  bumpFx(G, { kind: 'over', seat: winner });
}

// Put a tile on a node, then run every consequence the rulebook attaches.
function putTile(G, seat, node, tile) {
  const p = bySeat(G, seat);
  const n = G.terrain.nodes[node];
  G.board[node].push(tile);
  p.rack = p.rack.filter((t) => t.id !== tile.id);
  G.placedThisTurn.push(node);
  note(G, n.hq !== null ? `${p.name} marches ${troopLabel(tile.key)} into the enemy H.Q.` : `${p.name} places ${troopLabel(tile.key)}.`);
  bumpFx(G, { kind: 'place', seat, node, key: tile.key });

  if (n.hq !== null && n.hq !== seat) {
    // "If you place one of your Troops on the enemy H.Q., you immediately win."
    finish(G, seat, `${p.name} captured the enemy H.Q.`);
    return;
  }
  claimRegions(G);
  if (checkMedals(G, p)) return;

  // Station Metal-X: "Troop effects are not applied on these special bases."
  const shielded = G.terrain.power === 'shield' && n.special;
  if (!shielded) G.troopQ.push({ node, key: tile.key, seat });
  if (n.special && G.terrain.power !== 'shield' && G.terrain.power !== 'buoy') G.baseQ.push({ node, seat });
}

function checkMedals(G, p) {
  if (G.phase === 'over') return true;
  if (p.medals >= G.terrain.target) {
    finish(G, p.seat, `${p.name} reached the Medals objective (${G.terrain.target}).`);
    return true;
  }
  return false;
}

// --------------------------------------------------------- effect resolution
//
// The aid's ordering, from Cap'n's Note: "First apply all the effects of
// Troops you just placed, then apply any special base effects." So the troop
// queue drains completely — including anything Cap'n adds to it — before the
// base queue starts.

function pump(G) {
  while (G.phase !== 'over' && !G.pending) {
    if (G.troopQ.length) {
      const step = G.troopQ.shift();
      troopEffect(G, step);
      continue;
    }
    if (G.baseQ.length) {
      const step = G.baseQ.shift();
      baseEffect(G, step);
      continue;
    }
    endTurn(G);
    return;
  }
}

function troopEffect(G, { node, key, seat }) {
  const p = bySeat(G, seat);
  const foe = bySeat(G, other(seat));
  if (key === 'skully') {
    const n = drawUpTo(G, p, 2);
    if (n) note(G, `Skully calls up ${n} more.`);
  } else if (key === 'star') {
    if (drawUpTo(G, p, 1)) note(G, 'Star brings a friend.');
  } else if (key === 'xb42') {
    if (foe.rack.length) {
      const i = Math.floor(Math.random() * foe.rack.length);
      const [hit] = foe.rack.splice(i, 1);
      if (foe.frozen === hit.id) foe.frozen = null;
      discardTile(G, hit);
      note(G, `XB-42 blasts ${troopLabel(hit.key)} off ${foe.name}'s rack.`);
      bumpFx(G, { kind: 'blast', seat, key: hit.key });
    }
  } else if (key === 'capn') {
    if (playable(p).some((t) => placeOptions(G, seat, t.key).length)) {
      G.pending = { kind: 'capn', seat, node };
    }
  } else if (key === 'jumbo') {
    const targets = adjacentTo(G, node).filter((m) => {
      const t = topOf(G, m);
      return t && t.owner !== seat && G.terrain.nodes[m].hq === null;
    });
    if (targets.length) G.pending = { kind: 'jumbo', seat, node, options: targets };
  }
}

function baseEffect(G, { node, seat }) {
  const p = bySeat(G, seat);
  const power = G.terrain.power;
  if (power === 'splendor') {
    if (drawUpTo(G, p, 1)) note(G, `${p.name} draws from the clouds.`);
    return;
  }
  // "You can only have a maximum of 8 Troops on your rack. If you were to
  // exceed this limit with the effect of a special base, you cannot apply
  // this effect."
  if (power === 'retreat') {
    if (rackFull(p)) return;
    const opts = visibleOwn(G, seat).filter((m) => m !== node);
    if (opts.length) G.pending = { kind: 'retreat', seat, node, options: opts };
  } else if (power === 'undead') {
    if (rackFull(p)) return;
    if (G.discard.some((t) => t.owner === seat)) G.pending = { kind: 'undead', seat, node };
  } else if (power === 'eruption') {
    const opts = adjacentTo(G, node).filter((m) => {
      const t = topOf(G, m);
      return t && t.owner !== seat && G.terrain.nodes[m].hq === null;
    }).filter((m) => eruptionTargets(G, m).length);
    if (opts.length) G.pending = { kind: 'eruption', seat, node, options: opts };
  } else if (power === 'sniper') {
    const foe = bySeat(G, other(seat));
    if (foe.rack.length) G.pending = { kind: 'sniper', seat, node, count: foe.rack.length };
  }
}

// Your own Troops that are actually on top of their stack — "you may only
// interact with visible Troops."
function visibleOwn(G, seat) {
  const out = [];
  for (const n of G.terrain.nodes) {
    if (n.hq !== null) continue;
    const t = topOf(G, n.id);
    if (t && t.owner === seat) out.push(n.id);
  }
  return out;
}

// The volcano throws a Troop to "a base that is adjacent to its starting
// base, ignoring the placement rules" — any base, whoever holds it.
const eruptionTargets = (G, from) => adjacentTo(G, from).filter((m) => G.terrain.nodes[m].hq === null);

// ------------------------------------------------------------------- moves

export function applyMove(G, seat, move) {
  if (G.phase === 'over') return { ok: false, error: 'The battle is over.' };
  const p = bySeat(G, seat);
  if (!p) return { ok: false, error: 'Unknown player.' };

  if (G.pending) {
    if (G.pending.seat !== seat) return { ok: false, error: 'Not your decision.' };
    const r = resolvePending(G, seat, move);
    if (!r.ok) return r;
    pump(G);
    return { ok: true };
  }

  if (G.turn !== seat) return { ok: false, error: 'Not your turn.' };

  if (move && move.kind === 'draw') {
    if (!canDraw(p)) return { ok: false, error: 'You cannot draw — reserve empty or rack full.' };
    const n = drawUpTo(G, p, 2);
    p.lastAction = `drew ${n}`;
    note(G, `${p.name} draws ${n} Troop${n === 1 ? '' : 's'}.`);
    bumpFx(G, { kind: 'draw', seat, n });
    endTurn(G);
    return { ok: true };
  }

  if (move && move.kind === 'place') {
    const tile = p.rack.find((t) => t.id === move.tile);
    if (!tile) return { ok: false, error: 'You do not hold that Troop.' };
    if (p.frozen === tile.id) return { ok: false, error: 'A sniper has that Troop pinned this turn.' };
    if (!canPlace(G, seat, move.node, tile.key)) return { ok: false, error: 'That slot is not open to you.' };
    p.lastAction = `played ${TROOPS[tile.key].name}`;
    putTile(G, seat, move.node, tile);
    pump(G);
    return { ok: true };
  }

  return { ok: false, error: 'Unknown move.' };
}

function resolvePending(G, seat, move) {
  const pend = G.pending;
  const p = bySeat(G, seat);
  const foe = bySeat(G, other(seat));

  if (move && move.kind === 'skip') {
    G.pending = null;
    return { ok: true };
  }

  if (pend.kind === 'capn') {
    if (!move || move.kind !== 'place') return { ok: false, error: 'Place the extra Troop, or skip.' };
    const tile = p.rack.find((t) => t.id === move.tile);
    if (!tile) return { ok: false, error: 'You do not hold that Troop.' };
    if (p.frozen === tile.id) return { ok: false, error: 'A sniper has that Troop pinned this turn.' };
    if (!canPlace(G, seat, move.node, tile.key)) return { ok: false, error: 'That slot is not open to you.' };
    G.pending = null;
    putTile(G, seat, move.node, tile);
    return { ok: true };
  }

  if (pend.kind === 'jumbo') {
    if (!move || !pend.options.includes(move.node)) return { ok: false, error: 'Pick a neighbouring enemy Troop.' };
    const hit = G.board[move.node].pop();
    discardTile(G, hit);
    note(G, `Jumbo shoves ${troopLabel(hit.key)} off the board.`);
    bumpFx(G, { kind: 'shove', seat, node: move.node, key: hit.key });
    G.pending = null;
    claimRegions(G);
    checkMedals(G, p);
    return { ok: true };
  }

  if (pend.kind === 'retreat') {
    if (!move || !pend.options.includes(move.node)) return { ok: false, error: 'Pick one of your own Troops.' };
    const back = G.board[move.node].pop();
    p.rack.push(back);
    note(G, `${p.name} sounds the retreat — ${troopLabel(back.key)} returns to the rack.`);
    G.pending = null;
    claimRegions(G);
    checkMedals(G, p);
    return { ok: true };
  }

  if (pend.kind === 'undead') {
    const i = G.discard.findIndex((t) => t.id === (move && move.tile));
    if (i < 0 || G.discard[i].owner !== seat) return { ok: false, error: 'Pick one of your own discarded Troops.' };
    const [back] = G.discard.splice(i, 1);
    p.rack.push(back);
    note(G, `${troopLabel(back.key)} claws its way out of the discard.`);
    G.pending = null;
    return { ok: true };
  }

  if (pend.kind === 'eruption') {
    if (!move || !pend.options.includes(move.from)) return { ok: false, error: 'Pick an enemy Troop beside the volcano.' };
    if (!eruptionTargets(G, move.from).includes(move.to)) return { ok: false, error: 'It can only be thrown to a neighbouring base.' };
    const flung = G.board[move.from].pop();
    G.board[move.to].push(flung);
    note(G, `The volcano hurls ${troopLabel(flung.key)} to the next base.`);
    bumpFx(G, { kind: 'erupt', seat, node: move.to, key: flung.key });
    G.pending = null;
    claimRegions(G);
    checkMedals(G, p);
    if (G.phase !== 'over') checkMedals(G, foe);
    return { ok: true };
  }

  if (pend.kind === 'sniper') {
    const i = Number(move && move.index);
    if (!Number.isInteger(i) || i < 0 || i >= foe.rack.length) return { ok: false, error: 'Point at one of their Troops.' };
    foe.frozen = foe.rack[i].id;
    note(G, `${p.name} pins a Troop on ${foe.name}'s rack.`);
    bumpFx(G, { kind: 'pin', seat });
    G.pending = null;
    return { ok: true };
  }

  return { ok: false, error: 'Nothing to decide.' };
}

// ------------------------------------------------------------------- the bot
//
// Alpha-beta search over the real engine, not a pile of heuristics. The first
// version of this file scored each placement on its own and played the best
// one, which meant it could not see the obvious: that taking a base hands the
// opponent a cover, or that the Troop it just played opens a lane to its own
// H.Q. One ply cannot see a reply, and this game is all replies.
//
// Two things make searching honest here rather than clairvoyant:
//
//   The opponent's rack is hidden and both reserves are shuffled, so the bot
//   may not read them. `determinize` throws away everything it is not
//   entitled to know and deals a plausible hand from what is public — its own
//   rack, the stacks on the board (which the rules let anyone inspect), the
//   discard, and how many Troops the opponent is holding. The search then
//   runs on that guess. Sampling more than one guess costs depth, so the
//   trade is a knob.
//
//   Pointing at a Troop on the opponent's rack is blind by the rules, so the
//   sniper generates a single move standing for all of them. In a
//   determinized world the bot could otherwise "see" which one to pin.

const WIN = 1e7;

// ------------------------------------------------------- the quick heuristic
//
// Still here, and still earning its keep: it orders moves so alpha-beta gets
// its cuts early, and it is what `botChoose` falls back to when the node
// budget is set to zero.

// Distances only mean something relative to how far apart neighbouring bases
// are. The transcribed boards are written in percentages of the printed board
// and the invented ones in lattice cells, so a raw distance term was twenty
// times stronger on one than the other. Measure in path-lengths instead: the
// median distance between joined nodes on that board. The Terrain never
// changes shape, so the step is cached per board.
const stepCache = new WeakMap();
function boardStep(G) {
  let step = stepCache.get(G.terrain.nodes);
  if (step === undefined) {
    const { nodes, edges } = G.terrain;
    const lens = edges.map(([a, b]) => Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y)).sort((p, q) => p - q);
    step = (lens.length && lens[Math.floor(lens.length / 2)]) || 1;
    stepCache.set(nodes, step);
  }
  return step;
}

// How far a node is from the NEAREST H.Q. that `seat` owns, in path-lengths.
// A side can hold two — Tropical Pool gives both sides two, Caribbean Sea
// gives blue two — and aiming at whichever happened to be listed first sent
// one bot at a restricted H.Q. and the other at an open one.
function hqDistance(G, seat, node) {
  const n = G.terrain.nodes[node];
  let best = Infinity;
  for (const h of G.terrain.nodes) {
    if (h.hq === seat) best = Math.min(best, Math.hypot(n.x - h.x, n.y - h.y));
  }
  return best / boardStep(G);
}

function regionValue(G, seat, node) {
  let v = 0;
  for (const r of G.terrain.regions) {
    if (r.owner !== null || !r.around.includes(node)) continue;
    const mine = r.around.filter((n) => occupant(G, n) === seat).length;
    v += r.medals * (mine + 1) * (mine + 1);
  }
  return v;
}

// The enemy Troops standing next to one of our H.Q. on a chain that already
// reaches it — i.e. the tiles that are one turn from ending the game.
function siegeBases(G, seat) {
  const foe = other(seat);
  const mine = G.terrain.nodes.filter((n) => n.hq === seat).map((n) => n.id);
  const theirReach = reachable(G, foe);
  const out = new Set();
  if (!mine.some((h) => theirReach.has(h))) return out;
  for (const h of mine) {
    for (const m of G.terrain.adj[h]) {
      if (G.terrain.nodes[m].hq !== null) continue;
      if (occupant(G, m) === foe) out.add(m);
    }
  }
  return out;
}

function scorePlacement(G, seat, node, key, reach, siege) {
  const n = G.terrain.nodes[node];
  const foe = other(seat);
  if (n.hq === foe) return 1e6;                       // the game ends here
  const top = topOf(G, node);
  const already = top && top.owner === seat;
  let s = siege.has(node) ? 5000 : 0;                 // break the siege first

  for (const r of G.terrain.regions) {
    if (r.owner !== null || !r.around.includes(node)) continue;
    const mine = r.around.filter((m) => occupant(G, m) === seat).length;
    const after = already ? mine : mine + 1;
    if (after === r.around.length) s += 400 * r.medals;
    else s += 3 * r.medals * after * after;
    if (top && top.owner === foe) {
      const theirs = r.around.filter((m) => occupant(G, m) === foe).length;
      s += 4 * r.medals * theirs * theirs;
    }
  }

  if (already) {
    s -= 30;
  } else {
    s += top ? 10 : 8;
    let opened = 0;
    for (const m of G.terrain.adj[node]) if (!reach.has(m)) opened++;
    s += opened * 6;
  }

  s -= (strengthOf(key) === null ? 3 : strengthOf(key)) * 1.5;
  if (key === 'kwak' && top && top.owner === foe) s += 14;

  const far = hqDistance(G, foe, node);
  if (Number.isFinite(far)) s -= far * 1.5;
  return s;
}

function greedyChoose(G, seat) {
  const p = bySeat(G, seat);
  if (!p) return null;
  if (G.pending && G.pending.seat === seat) return pendingFallback(G, seat);
  if (G.turn !== seat) return null;
  const mv = bestPlacement(G, seat);
  if (!mv) return canDraw(p) ? { kind: 'draw' } : null;
  if (canDraw(p) && p.rack.length < 5 && mv.score < 120) return { kind: 'draw' };
  return { kind: 'place', tile: mv.tile, node: mv.node };
}

function bestPlacement(G, seat) {
  const p = bySeat(G, seat);
  const reach = reachable(G, seat);
  const siege = siegeBases(G, seat);
  let best = null;
  for (const tile of playable(p)) {
    for (const node of placeOptions(G, seat, tile.key)) {
      const s = scorePlacement(G, seat, node, tile.key, reach, siege);
      if (!best || s > best.score) best = { score: s, tile: tile.id, node, kind: 'place' };
    }
  }
  return best;
}

// A sane answer to any question the engine can ask, used by the shallow bot
// and as the safety net if the search somehow returns nothing.
function pendingFallback(G, seat) {
  const pend = G.pending;
  const p = bySeat(G, seat);
  if (pend.kind === 'jumbo') {
    const best = pend.options.slice().sort((a, b) =>
      (regionValue(G, other(seat), b) * 10 + (strengthOf(topOf(G, b).key) || 0)) -
      (regionValue(G, other(seat), a) * 10 + (strengthOf(topOf(G, a).key) || 0)))[0];
    return { kind: 'jumbo', node: best };
  }
  if (pend.kind === 'retreat') {
    if (rackFull(p)) return { kind: 'skip' };
    const idle = pend.options.filter((n) => regionValue(G, seat, n) === 0);
    if (!idle.length) return { kind: 'skip' };
    const best = idle.slice().sort((a, b) => (strengthOf(topOf(G, b).key) || 0) - (strengthOf(topOf(G, a).key) || 0))[0];
    return { kind: 'retreat', node: best };
  }
  if (pend.kind === 'undead') {
    const mine = G.discard.filter((t) => t.owner === seat);
    if (!mine.length) return { kind: 'skip' };
    const best = mine.slice().sort((a, b) => (strengthOf(b.key) ?? 8) - (strengthOf(a.key) ?? 8))[0];
    return { kind: 'undead', tile: best.id };
  }
  if (pend.kind === 'eruption') {
    let best = null;
    for (const from of pend.options) {
      for (const to of eruptionTargets(G, from)) {
        const gain = regionValue(G, other(seat), from) - regionValue(G, other(seat), to);
        if (!best || gain > best.gain) best = { gain, from, to };
      }
    }
    return best ? { kind: 'eruption', from: best.from, to: best.to } : { kind: 'skip' };
  }
  if (pend.kind === 'sniper') return { kind: 'sniper', index: Math.floor(Math.random() * pend.count) };
  if (pend.kind === 'capn') {
    const mv = bestPlacement(G, seat);
    return mv ? { kind: 'place', tile: mv.tile, node: mv.node } : { kind: 'skip' };
  }
  return { kind: 'skip' };
}

// ------------------------------------------------------------- search plumbing

// Only the parts that move. The Terrain's nodes, paths and adjacency never
// change, so every node of the search tree shares one copy of them; its
// regions do change hands, so those are copied. Tiles are immutable once
// minted, so the stacks copy their arrays and share their contents.
function cloneState(G) {
  return {
    phase: G.phase,
    terrain: { ...G.terrain, regions: G.terrain.regions.map((r) => ({ ...r })) },
    turn: G.turn,
    board: G.board.map((st) => st.slice()),
    discard: G.discard.slice(),
    pending: G.pending ? { ...G.pending, options: G.pending.options ? G.pending.options.slice() : undefined } : null,
    troopQ: G.troopQ.slice(),
    baseQ: G.baseQ.slice(),
    placedThisTurn: [],
    winner: G.winner,
    result: null,
    endedBy: null,
    log: [],
    logSeq: 0,
    fx: null,
    fxSeq: 0,
    players: G.players.map((p) => ({ ...p, rack: p.rack.slice(), reserve: p.reserve.slice() })),
  };
}

// Deal a game consistent with everything `seat` is entitled to see, and with
// nothing it is not. Each side owns three copies of all eight Troops; four of
// them went back in the box unseen at setup. Whatever is visible in a stack
// or lying in the discard is known to both players, so the rest is the pool
// the hidden tiles are drawn from.
function determinize(G, seat) {
  const H = cloneState(G);
  let uid = 0;
  for (const p of H.players) {
    const seen = new Map();
    const bump = (k) => seen.set(k, (seen.get(k) || 0) + 1);
    for (const st of H.board) for (const t of st) if (t.owner === p.seat) bump(t.key);
    for (const t of H.discard) if (t.owner === p.seat) bump(t.key);
    if (p.seat === seat) for (const t of p.rack) bump(t.key);
    const pool = [];
    for (const key of TROOP_ORDER) {
      for (let i = COPIES - (seen.get(key) || 0); i > 0; i--) pool.push(key);
    }
    const bag = shuffle(pool);
    const mint = (k) => ({ id: `d${p.seat}_${uid++}`, key: k, owner: p.seat });
    if (p.seat === seat) {
      // our own rack is real; only the order of our reserve is a guess
      p.reserve = bag.slice(SET_ASIDE).map(mint);
    } else {
      const held = p.rack.length;
      p.rack = bag.slice(0, held).map(mint);
      p.reserve = bag.slice(held + SET_ASIDE).map(mint);
      // a pinned Troop is still pinned; which one it is was never ours to know
      p.frozen = p.frozen && p.rack.length ? p.rack[0].id : null;
    }
  }
  return H;
}

// Fewest placements `attacker` needs before it can walk into the defender's
// H.Q.: ground it already holds is free, empty ground costs one Troop, and
// ground the defender holds costs two, because taking it needs a Troop
// strictly stronger than whatever is standing there.
function hqSteps(G, attacker) {
  const defender = other(attacker);
  const nodes = G.terrain.nodes;
  const dist = new Array(nodes.length).fill(Infinity);
  const queue = [];
  for (const h of hqsOf(G, attacker)) { dist[h] = 0; queue.push(h); }
  let best = Infinity;
  while (queue.length) {
    // small graph, small weights: a scan beats a heap
    let at = 0;
    for (let i = 1; i < queue.length; i++) if (dist[queue[i]] < dist[queue[at]]) at = i;
    const n = queue.splice(at, 1)[0];
    if (dist[n] > best) continue;
    for (const m of G.terrain.adj[n]) {
      const node = nodes[m];
      if (node.hq === defender) { best = Math.min(best, dist[n] + 1); continue; }
      if (node.hq !== null) continue;                 // never route through an H.Q.
      const held = occupant(G, m);
      const cost = held === attacker ? 0 : held === null ? 1 : 2;
      if (dist[n] + cost < dist[m]) { dist[m] = dist[n] + cost; queue.push(m); }
    }
  }
  return best;
}

// How much a Troop on the rack is worth to hold: the big ones are the only
// answer to a big one already standing on a base.
const handStrength = (p) => p.rack.reduce((a, t) => a + (strengthOf(t.key) ?? 4), 0);

const W = {
  medal: 260,
  corner: [0, 6, 22, 70, 0],   // by corners of an unclaimed region held, × its Medals
  hqStep: 40,
  hqPanic: 1200,
  base: 8,
  reach: 2,
  buried: 7,
  rack: 6,
  reserve: 1.5,
  strength: 0.8,
};

function evaluate(G, seat) {
  if (G.phase === 'over') return G.winner === seat ? WIN : -WIN;
  const foe = other(seat);
  const me = bySeat(G, seat);
  const them = bySeat(G, foe);
  const target = G.terrain.target;

  let v = (me.medals - them.medals) * W.medal;
  // the last Medal is the one that ends the game, so the curve steepens
  v += (Math.pow(me.medals / target, 2) - Math.pow(them.medals / target, 2)) * 500;

  for (const r of G.terrain.regions) {
    if (r.owner !== null) continue;
    let mine = 0, theirs = 0;
    for (const n of r.around) {
      const o = occupant(G, n);
      if (o === seat) mine++;
      else if (o === foe) theirs++;
    }
    v += r.medals * (W.corner[mine] - W.corner[theirs]);
  }

  let myBases = 0, theirBases = 0, myBuried = 0, theirBuried = 0;
  for (const n of G.terrain.nodes) {
    if (n.hq !== null) continue;
    const st = G.board[n.id];
    if (!st.length) continue;
    if (st[st.length - 1].owner === seat) myBases++; else theirBases++;
    for (let i = 0; i < st.length - 1; i++) {
      if (st[i].owner === seat) myBuried++; else theirBuried++;
    }
  }
  v += (myBases - theirBases) * W.base;
  v -= (myBuried - theirBuried) * W.buried;
  v += (reachable(G, seat).size - reachable(G, foe).size) * W.reach;

  const mine = hqSteps(G, seat);
  const yours = hqSteps(G, foe);
  if (Number.isFinite(mine) || Number.isFinite(yours)) {
    const a = Number.isFinite(mine) ? mine : 40;
    const b = Number.isFinite(yours) ? yours : 40;
    v += (b - a) * W.hqStep;
  }
  // one Troop away, and it is their turn: that is not a positional detail
  if (yours <= 1 && G.turn === foe) v -= W.hqPanic;
  if (mine <= 1 && G.turn === seat) v += W.hqPanic;

  v += (me.rack.length - them.rack.length) * W.rack;
  v += (me.reserve.length - them.reserve.length) * W.reserve;
  v += (handStrength(me) - handStrength(them)) * W.strength;
  return v;
}

// Three copies of a Troop are interchangeable, so only the first of each key
// is generated — otherwise the branching factor triples for nothing.
function placementMoves(G, actor, reach) {
  const p = bySeat(G, actor);
  const r = reach || reachable(G, actor);
  const out = [];
  const seen = new Set();
  for (const t of playable(p)) {
    if (seen.has(t.key)) continue;
    seen.add(t.key);
    for (const node of placeOptions(G, actor, t.key, r)) out.push({ kind: 'place', tile: t.id, node });
  }
  return out;
}

function movesFor(G, actor, reach) {
  const pend = G.pending;
  if (pend) {
    const out = [];
    if (pend.kind === 'capn') out.push(...placementMoves(G, actor, reach));
    else if (pend.kind === 'jumbo') for (const n of pend.options) out.push({ kind: 'jumbo', node: n });
    else if (pend.kind === 'retreat') for (const n of pend.options) out.push({ kind: 'retreat', node: n });
    else if (pend.kind === 'eruption') {
      for (const from of pend.options) for (const to of eruptionTargets(G, from)) out.push({ kind: 'eruption', from, to });
    } else if (pend.kind === 'undead') {
      const seen = new Set();
      for (const t of G.discard) {
        if (t.owner !== actor || seen.has(t.key)) continue;
        seen.add(t.key);
        out.push({ kind: 'undead', tile: t.id });
      }
    } else if (pend.kind === 'sniper') {
      // you point without looking, so every index is the same move
      out.push({ kind: 'sniper', index: 0 });
    }
    out.push({ kind: 'skip' });
    return out;
  }
  const out = placementMoves(G, actor, reach);
  if (canDraw(bySeat(G, actor))) out.push({ kind: 'draw' });
  return out;
}

function orderMoves(G, actor, moves, reach) {
  const siege = siegeBases(G, actor);
  const p = bySeat(G, actor);
  const keyOf = (id) => {
    const t = p.rack.find((x) => x.id === id);
    return t ? t.key : 'roxy';
  };
  return moves
    .map((mv) => {
      let s = 0;
      if (mv.kind === 'place') s = scorePlacement(G, actor, mv.node, keyOf(mv.tile), reach, siege);
      else if (mv.kind === 'draw') s = p.rack.length < 4 ? 60 : 20;
      else if (mv.kind === 'skip') s = -20;
      else s = 40;
      return { mv, s };
    })
    .sort((a, b) => b.s - a.s)
    .map((x) => x.mv);
}

function search(G, rootSeat, depth, alpha, beta, ctx, ply) {
  if (G.phase === 'over') {
    // a win now beats the same win three moves later, and a loss later beats
    // a loss now — otherwise the bot dithers in won positions
    return G.winner === rootSeat ? WIN - ply : -WIN + ply;
  }
  if (depth <= 0) return evaluate(G, rootSeat);
  if (ctx.nodes >= ctx.budget) { ctx.out = true; return evaluate(G, rootSeat); }
  // Date.now() is not free, so only look every so often
  if ((ctx.nodes & 255) === 0 && ctx.until && Date.now() > ctx.until) { ctx.out = true; return evaluate(G, rootSeat); }

  const actor = G.pending ? G.pending.seat : G.turn;
  const maxing = actor === rootSeat;
  const reach = reachable(G, actor);
  const raw = movesFor(G, actor, reach);
  if (!raw.length) return evaluate(G, rootSeat);
  const moves = depth > 1 ? orderMoves(G, actor, raw, reach) : raw;

  let best = maxing ? -Infinity : Infinity;
  for (const mv of moves) {
    ctx.nodes++;
    const H = cloneState(G);
    if (!applyMove(H, actor, mv).ok) continue;
    const v = search(H, rootSeat, depth - 1, alpha, beta, ctx, ply + 1);
    if (maxing) {
      if (v > best) best = v;
      if (best > alpha) alpha = best;
    } else {
      if (v < best) best = v;
      if (best < beta) beta = best;
    }
    if (alpha >= beta) break;
    if (ctx.out) break;
  }
  return Number.isFinite(best) ? best : evaluate(G, rootSeat);
}

// ------------------------------------------------------------------ the root

// `ms` is a wall-clock ceiling on one move's thinking, so the same level
// plays the same way on a laptop and a phone — the phone just searches less
// deeply inside it. The search runs on the main thread, so this doubles as
// the longest the tab can be frozen.
export const BOT_LEVELS = {
  quick: { label: 'Quick', blurb: 'No search at all — plays the first decent move it sees.', nodes: 0, depth: 0, samples: 1, ms: 0 },
  steady: { label: 'Steady', blurb: 'Looks a move or two ahead. A fair game.', nodes: 900, depth: 4, samples: 1, ms: 60 },
  sharp: { label: 'Sharp', blurb: 'Searches deeper and guards its H.Q. Will punish a loose Troop.', nodes: 2600, depth: 6, samples: 1, ms: 150 },
  ruthless: { label: 'Ruthless', blurb: 'As deep as the search is still worth anything. Expect to lose.', nodes: 8000, depth: 9, samples: 1, ms: 400 },
};
export const DEFAULT_LEVEL = 'sharp';

export function botChoose(G, seat, opts = {}) {
  const p = bySeat(G, seat);
  if (!p) return null;
  const actor = G.pending ? G.pending.seat : G.turn;
  if (actor !== seat) return null;
  if (G.phase !== 'playing') return null;

  const level = BOT_LEVELS[opts.level] || BOT_LEVELS[DEFAULT_LEVEL];
  const budget = opts.nodes ?? level.nodes;
  const maxDepth = opts.depth ?? level.depth;
  const samples = opts.samples ?? level.samples;
  const totalMs = opts.ms ?? level.ms ?? 0;
  const perMs = totalMs ? Math.max(20, Math.floor(totalMs / samples)) : 0;
  const started = Date.now();
  if (budget <= 0 || maxDepth <= 0) return greedyChoose(G, seat);

  const moves = movesFor(G, seat);
  if (!moves.length) return G.pending ? { kind: 'skip' } : null;
  if (moves.length === 1) return moves[0];
  // an H.Q. in reach needs no thinking about
  for (const mv of moves) {
    if (mv.kind === 'place' && G.terrain.nodes[mv.node].hq === other(seat)) return mv;
  }

  const total = new Array(moves.length).fill(0);
  const onePass = samples === 1;
  let searched = false;
  for (let s = 0; s < samples; s++) {
    const D = determinize(G, seat);
    const ctx = {
      nodes: 0,
      budget: Math.max(200, Math.floor(budget / samples)),
      until: perMs ? started + perMs * (s + 1) : 0,
      out: false,
    };
    let done = null;
    // Iterative deepening: each sweep orders the next, and a sweep that runs
    // out of budget is thrown away rather than half-believed.
    for (let depth = 2; depth <= maxDepth; depth++) {
      const vals = new Array(moves.length).fill(-Infinity);
      const order = done
        ? moves.map((_, i) => i).sort((a, b) => done[b] - done[a])
        : orderIndices(D, seat, moves);
      ctx.out = false;
      let alpha = -Infinity;
      for (const i of order) {
        const H = cloneState(D);
        if (!applyMove(H, seat, moves[i]).ok) continue;
        vals[i] = search(H, seat, depth - 1, onePass ? alpha : -Infinity, Infinity, ctx, 1);
        if (onePass && vals[i] > alpha) alpha = vals[i];
        if (ctx.out) break;
      }
      if (ctx.out) break;
      done = vals;
      searched = true;
      if (done.some((v) => v >= WIN - 100)) break;    // forced win found
    }
    if (done) for (let i = 0; i < moves.length; i++) total[i] += done[i];
  }
  if (!searched) return greedyChoose(G, seat);

  let bestI = 0;
  for (let i = 1; i < moves.length; i++) if (total[i] > total[bestI]) bestI = i;
  if (!Number.isFinite(total[bestI])) return greedyChoose(G, seat);
  return moves[bestI];
}

function orderIndices(G, seat, moves) {
  const ranked = orderMoves(G, seat, moves, reachable(G, seat));
  return ranked.map((mv) => moves.indexOf(mv));
}

// -------------------------------------------------------------- the seat view

// The opponent's rack is theirs: a viewer learns how many Troops are on it and
// nothing else. Stacks are public in the real game — "You may look at the tile
// stacks on the Terrain" — so they go out whole.
export function viewFor(G, seat, code) {
  const me = bySeat(G, seat);
  return {
    code,
    mid: G.mid,
    you: seat,
    phase: G.phase,
    turn: G.turn,
    terrain: {
      key: G.terrain.key, name: G.terrain.name, tag: G.terrain.tag,
      power: G.terrain.power, target: G.terrain.target,
      nodes: G.terrain.nodes, edges: G.terrain.edges, regions: G.terrain.regions,
      x0: G.terrain.x0, y0: G.terrain.y0, w: G.terrain.w, h: G.terrain.h,
    },
    board: G.board.map((st) => st.map((t) => ({ id: t.id, key: t.key, owner: t.owner }))),
    discard: G.discard.map((t) => ({ id: t.id, key: t.key, owner: t.owner })),
    pending: G.pending ? { ...G.pending } : null,
    players: G.players.map((p) => ({
      seat: p.seat,
      name: p.name,
      bot: p.bot,
      connected: p.connected,
      botFor: !!p.botFor,
      resigned: !!p.resigned,
      medals: p.medals,
      rackCount: p.rack.length,
      reserveCount: p.reserve.length,
      frozen: p.seat === seat ? p.frozen : !!p.frozen,
      lastAction: p.lastAction,
    })),
    rack: me ? me.rack.map((t) => ({ id: t.id, key: t.key })) : [],
    canDraw: me ? canDraw(me) : false,
    result: G.result,
    winner: G.winner,
    log: G.log.slice(-15),
    fx: G.fx,
  };
}

// ------------------------------------------------- seat bookkeeping for the shell

export function markReconnected(G, seat) {
  const p = bySeat(G, seat);
  if (p) { p.connected = true; p.botFor = false; }
}
export function markDisconnected(G, seat) {
  const p = bySeat(G, seat);
  if (p) p.connected = false;
}
export function markSeatClaimed(G, seat, name) {
  const p = bySeat(G, seat);
  if (!p) return;
  p.name = name;
  p.connected = true;
  p.bot = false;
  p.botFor = false;
  p.resigned = false;
}
export function markSeatResigned(G, seat) {
  const p = bySeat(G, seat);
  if (p) { p.resigned = true; p.connected = false; p.botFor = true; }
}
export function markBotTakeover(G, seat) {
  const p = bySeat(G, seat);
  if (p) p.botFor = true;
}
