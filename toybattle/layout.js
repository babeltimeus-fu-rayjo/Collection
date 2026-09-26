// layout.js — where Toy Battle draws its board.
//
// The engine holds each Terrain as it is printed: bases in millimetres on the
// 40 x 24 cm card. That is the truth about what joins what, but it is not a
// drawing. The card's tiles are about 3 cm on paths that run 6 to 10, which
// reads well across a table and is far too small on a phone, so the screen
// draws its bases half again as big, relative to the paths, as the card does.
// That opens up collisions the card never had: two bases the card keeps a
// finger apart would overlap, and a path would run under a base it does not
// reach.
//
// So the layout starts from the printed positions and moves only what
// crowds: every base clears every other base by GAP, every path clears every
// base it does not end at by LANE, and every base stays as close to its
// printed spot as that allows. The Medals then go wherever their region has
// the most open ground. Pure geometry with no DOM, so the tests can run it.

export const BASE = 62;       // side of a base square, px
export const HQ = 74;         // side of an H.Q.
export const PATH = 10;       // width a path is drawn at
export const MEDAL = 8.5;     // radius of a Medal
export const STEP = 118;      // px a median-length path spans
export const GAP = 24;        // clear ground between any two bases
export const LANE = 14;       // a path's centreline to a base it does not reach
const PAD = 26;               // room round the edge for badges and glows
const ITER = 700;

const cache = new Map();

export function layoutTerrain(t) {
  const hit = cache.get(t.key);
  if (hit) return hit;
  const out = build(t);
  cache.set(t.key, out);
  return out;
}

function build(t) {
  const N = t.nodes.length;
  const lens = t.edges
    .map(([a, b]) => Math.hypot(t.nodes[a].x - t.nodes[b].x, t.nodes[a].y - t.nodes[b].y))
    .sort((p, q) => p - q);
  const k = STEP / (lens[Math.floor(lens.length / 2)] || 1);
  const home = t.nodes.map((n) => [n.x * k, n.y * k]);
  const half = t.nodes.map((n) => (n.hq === null ? BASE : HQ) / 2);
  const P = home.map((p) => p.slice());

  // Every step collects what each constraint wants from each node and moves
  // the node by the average, all at once. Updating in turn would let the
  // order of the node list skew a board the card prints symmetrical.
  for (let it = 0; it < ITER; it++) {
    const want = P.map(() => [0, 0, 0]);
    const ask = (i, x, y) => { want[i][0] += x; want[i][1] += y; want[i][2]++; };

    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const dx = P[j][0] - P[i][0];
        const dy = P[j][1] - P[i][1];
        // squares clear each other when either axis does
        const short = half[i] + half[j] + GAP - Math.max(Math.abs(dx), Math.abs(dy));
        if (short <= 0) continue;
        const d = Math.hypot(dx, dy) || 1e-6;
        const ux = dx / d;
        const uy = dy / d;
        const m = short / Math.max(Math.abs(ux), Math.abs(uy)) / 2;
        ask(i, -ux * m, -uy * m);
        ask(j, ux * m, uy * m);
      }
    }

    for (const [a, b] of t.edges) {
      const ex = P[b][0] - P[a][0];
      const ey = P[b][1] - P[a][1];
      const len2 = ex * ex + ey * ey || 1e-6;
      for (let c = 0; c < N; c++) {
        if (c === a || c === b) continue;
        const s = ((P[c][0] - P[a][0]) * ex + (P[c][1] - P[a][1]) * ey) / len2;
        // past either end it is a base beside a base, which GAP already keeps
        if (s <= 0 || s >= 1) continue;
        let vx = P[c][0] - (P[a][0] + s * ex);
        let vy = P[c][1] - (P[a][1] + s * ey);
        let d = Math.hypot(vx, vy);
        if (d < 1e-6) { vx = -ey; vy = ex; d = Math.hypot(vx, vy); }
        const ux = vx / d;
        const uy = vy / d;
        // how far the square reaches towards the path, plus the lane
        const short = half[c] * (Math.abs(ux) + Math.abs(uy)) + LANE - d;
        if (short <= 0) continue;
        const m = short / 2;
        ask(c, ux * m, uy * m);
        ask(a, -ux * m * (1 - s), -uy * m * (1 - s));
        ask(b, -ux * m * s, -uy * m * s);
      }
    }

    // a pull back towards the printed spot, easing off to nothing so the last
    // steps settle every constraint exactly
    const pull = 0.06 * Math.max(0, 1 - it / (ITER * 0.7));
    for (let i = 0; i < N; i++) {
      const [x, y, n] = want[i];
      if (n) { P[i][0] += x / n; P[i][1] += y / n; }
      P[i][0] += (home[i][0] - P[i][0]) * pull;
      P[i][1] += (home[i][1] - P[i][1]) * pull;
    }
  }

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < N; i++) {
    x0 = Math.min(x0, P[i][0] - half[i]); x1 = Math.max(x1, P[i][0] + half[i]);
    y0 = Math.min(y0, P[i][1] - half[i]); y1 = Math.max(y1, P[i][1] + half[i]);
  }
  const pos = P.map(([x, y]) => [round(x - x0 + PAD), round(y - y0 + PAD)]);
  const w = round(x1 - x0 + PAD * 2);
  const h = round(y1 - y0 + PAD * 2);
  const medals = t.regions.map((r) => medalSpots(r, pos, half, t.edges));
  return { pos, half, w, h, medals };
}

const round = (v) => Math.round(v * 10) / 10;

// ------------------------------------------------------------ Medal spots

// How the Medals of a region can sit: a row for one to three, turned any of
// four ways, and a little triangle for three when a row will not fit.
function arrangements(n) {
  const turn = (pts, deg) => {
    const r = (deg * Math.PI) / 180;
    return pts.map(([x, y]) => [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)]);
  };
  if (n <= 1) return [[[0, 0]]];
  const sp = MEDAL * 2 + 3;
  const row = Array.from({ length: n }, (_, i) => [(i - (n - 1) / 2) * sp, 0]);
  const out = [0, 45, 90, 135].map((d) => turn(row, d));
  if (n === 3) {
    const tri = [[-sp / 2, sp * 0.29], [sp / 2, sp * 0.29], [0, -sp * 0.58]];
    for (const d of [0, 90, 180, 270]) out.push(turn(tri, d));
  }
  return out;
}

// Open ground at a point: how far to the nearest base square or path edge.
function openAt(x, y, pos, half, edges) {
  let best = Infinity;
  for (let i = 0; i < pos.length; i++) {
    const dx = Math.max(Math.abs(x - pos[i][0]) - half[i], 0);
    const dy = Math.max(Math.abs(y - pos[i][1]) - half[i], 0);
    best = Math.min(best, Math.hypot(dx, dy));
  }
  for (const [a, b] of edges) {
    const [ax, ay] = pos[a];
    const ex = pos[b][0] - ax;
    const ey = pos[b][1] - ay;
    const s = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey || 1)));
    best = Math.min(best, Math.hypot(x - ax - s * ex, y - ay - s * ey) - PATH / 2);
  }
  return best;
}

function inside(x, y, poly) {
  let yes = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) yes = !yes;
  }
  return yes;
}

// The spot inside the region's ring where its Medals have the most room,
// leaning to the middle once there is room enough, as a printed board would.
function medalSpots(r, pos, half, edges) {
  const ring = (r.ring || r.around).map((n) => pos[n]);
  const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  const shapes = arrangements(r.medals);
  let best = null;
  const stepPx = 3;
  for (let y = Math.min(...ys); y <= Math.max(...ys); y += stepPx) {
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += stepPx) {
      if (!inside(x, y, ring)) continue;
      for (const shape of shapes) {
        let room = Infinity;
        for (const [dx, dy] of shape) room = Math.min(room, openAt(x + dx, y + dy, pos, half, edges) - MEDAL);
        const score = Math.min(room, 10) - 0.04 * Math.hypot(x - cx, y - cy);
        if (!best || score > best.score) best = { score, room, x, y, shape };
      }
    }
  }
  if (!best) return { x: round(cx), y: round(cy), room: 0, dots: [[round(cx), round(cy)]] };
  return {
    x: round(best.x),
    y: round(best.y),
    room: round(best.room),
    dots: best.shape.map(([dx, dy]) => [round(best.x + dx), round(best.y + dy)]),
  };
}
