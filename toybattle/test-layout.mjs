// The drawing, on every board: that it can be read. The board data is the
// printed card; layout.js spaces it out for a screen, and these are the
// promises it makes — bases never touch, paths never run under a base they
// do not reach, nothing wanders far from where the card prints it, and every
// Medal sits in its own region on open ground.
import * as TB from './game.js';
import { layoutTerrain, STEP, GAP, LANE, PATH, MEDAL } from './layout.js';

let fails = 0;
const bad = (m) => { console.log('  **FAIL** ' + m); fails++; };

// the distance from a point to an axis-aligned square
const toSquare = (x, y, [cx, cy], h) => Math.hypot(Math.max(Math.abs(x - cx) - h, 0), Math.max(Math.abs(y - cy) - h, 0));

function inside(x, y, poly) {
  let yes = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) yes = !yes;
  }
  return yes;
}

console.log('— every board is on the real card —');
for (const t of TB.TERRAINS) {
  const [w, h] = t.w > t.h ? [400, 240] : [240, 400];
  const off = t.nodes.filter((n) => n.x < 0 || n.x > w || n.y < 0 || n.y > h);
  if (off.length) bad(`${t.key}: ${off.map((n) => n.label).join(' ')} lie off the 40 x 24 cm card`);
}
console.log(`  ${TB.TERRAINS.length} boards, every base inside the card`);

console.log('\n— and drawn so it can be read —');
for (const t of TB.TERRAINS) {
  const L = layoutTerrain(t);
  const { pos, half } = L;
  const N = t.nodes.length;
  let closest = Infinity;
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const gap = Math.max(Math.abs(pos[i][0] - pos[j][0]), Math.abs(pos[i][1] - pos[j][1])) - half[i] - half[j];
      closest = Math.min(closest, gap);
      if (gap < GAP - 0.5) bad(`${t.key}: ${t.nodes[i].label} and ${t.nodes[j].label} are ${gap.toFixed(1)}px apart, under the ${GAP}px gap`);
    }
  }
  // every path, sampled along its length, against every base it does not end at
  let lane = Infinity;
  for (const [a, b] of t.edges) {
    for (let c = 0; c < N; c++) {
      if (c === a || c === b) continue;
      let d = Infinity;
      for (let q = 0; q <= 400; q++) {
        const x = pos[a][0] + ((pos[b][0] - pos[a][0]) * q) / 400;
        const y = pos[a][1] + ((pos[b][1] - pos[a][1]) * q) / 400;
        d = Math.min(d, toSquare(x, y, pos[c], half[c]));
      }
      lane = Math.min(lane, d);
      if (d < LANE - 0.5) bad(`${t.key}: path ${t.nodes[a].label}-${t.nodes[b].label} runs ${d.toFixed(1)}px from ${t.nodes[c].label}, which it does not reach`);
    }
  }
  // how far anything moved from the printed spot, with the two drawings laid
  // over each other at their centres
  const lens = t.edges.map(([a, b]) => Math.hypot(t.nodes[a].x - t.nodes[b].x, t.nodes[a].y - t.nodes[b].y)).sort((p, q) => p - q);
  const k = STEP / lens[Math.floor(lens.length / 2)];
  const mx = t.nodes.reduce((s, n, i) => s + n.x * k - pos[i][0], 0) / N;
  const my = t.nodes.reduce((s, n, i) => s + n.y * k - pos[i][1], 0) / N;
  let moved = 0;
  for (let i = 0; i < N; i++) {
    const d = Math.hypot(t.nodes[i].x * k - mx - pos[i][0], t.nodes[i].y * k - my - pos[i][1]);
    moved = Math.max(moved, d);
    if (d > STEP * 0.3) bad(`${t.key}: ${t.nodes[i].label} moved ${d.toFixed(0)}px from where the card prints it`);
  }
  // Medals: inside their own region, clear of every base and path, and of
  // each other
  t.regions.forEach((r, ri) => {
    const spot = L.medals[ri];
    const ring = (r.ring || r.around).map((n) => pos[n]);
    if (spot.dots.length !== r.medals) bad(`${t.key}: region ${ri} draws ${spot.dots.length} Medals but holds ${r.medals}`);
    spot.dots.forEach(([x, y], di) => {
      if (!inside(x, y, ring)) bad(`${t.key}: a Medal of region ${ri} sits outside its region`);
      for (let i = 0; i < N; i++) {
        if (toSquare(x, y, pos[i], half[i]) < MEDAL) bad(`${t.key}: a Medal of region ${ri} is under ${t.nodes[i].label}`);
      }
      for (const [a, b] of t.edges) {
        const ex = pos[b][0] - pos[a][0];
        const ey = pos[b][1] - pos[a][1];
        const s = Math.max(0, Math.min(1, ((x - pos[a][0]) * ex + (y - pos[a][1]) * ey) / (ex * ex + ey * ey)));
        const d = Math.hypot(x - pos[a][0] - s * ex, y - pos[a][1] - s * ey);
        if (d < MEDAL + PATH / 2) bad(`${t.key}: a Medal of region ${ri} sits on path ${t.nodes[a].label}-${t.nodes[b].label}`);
      }
      spot.dots.slice(di + 1).forEach(([x2, y2]) => {
        if (Math.hypot(x - x2, y - y2) < MEDAL * 2) bad(`${t.key}: two Medals of region ${ri} overlap`);
      });
    });
  });
  console.log(`  ${t.name.padEnd(16)} bases ${closest.toFixed(0)}px apart at the closest, paths ${lane.toFixed(0)}px clear, nothing moved more than ${moved.toFixed(0)}px`);
}

console.log(fails ? `\n${fails} FAILURES` : '\nevery board can be read');
process.exit(fails ? 1 : 0);
