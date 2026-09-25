// The bot, on two counts: that it is strong, and that it is honest.
//
// Honest first, because a searching bot has an obvious way to cheat — it can
// simply read the opponent's rack out of the state it is handed. The test
// pins Math.random to a fixed sequence, then asks the bot the same question
// twice with the opponent holding completely different Troops but every
// PUBLIC fact identical. `determinize` deals from public information only, so
// under a fixed seed it produces the same imagined hand both times and the
// answer must match. A bot that peeked would answer differently.
import * as TB from './game.js';

let fails = 0;
const bad = (m) => { console.log('  **FAIL** ' + m); fails++; };

function seeded(seed, fn) {
  const real = Math.random;
  let s = seed >>> 0;
  Math.random = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  try { return fn(); } finally { Math.random = real; }
}

const roster = () => [{ seat: 0, name: 'Blue', bot: true }, { seat: 1, name: 'Red', bot: true }];
const sameMove = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// a mid-game position both variants will share
function position(terrain, plies) {
  const G = TB.newMatch(roster(), { terrain });
  let guard = 0;
  while (G.phase !== 'over' && guard++ < plies) {
    const a = G.pending ? G.pending.seat : G.turn;
    const mv = TB.botChoose(G, a, { level: 'quick' });
    if (!mv) break;
    TB.applyMove(G, a, mv);
  }
  return G;
}

function withRack(G, seat, keys) {
  const H = JSON.parse(JSON.stringify(G));
  const p = H.players.find((x) => x.seat === seat);
  p.rack = keys.map((k, i) => ({ id: `fake${i}`, key: k, owner: seat }));
  p.frozen = null;
  return H;
}

console.log('— the bot cannot see through the rack —');
{
  let checked = 0;
  for (const terrain of TB.TERRAINS) {
    const G = position(terrain.key, 16);
    if (G.phase === 'over' || G.pending) continue;
    const me = G.turn;
    const foe = me === 0 ? 1 : 0;
    const n = G.players.find((x) => x.seat === foe).rack.length;
    if (n < 3) continue;
    const weak = withRack(G, foe, Array.from({ length: n }, () => 'skully'));
    const strong = withRack(G, foe, Array.from({ length: n }, () => 'roxy'));
    for (const seed of [7, 99, 12345]) {
      const a = seeded(seed, () => TB.botChoose(weak, me, { level: 'steady' }));
      const b = seeded(seed, () => TB.botChoose(strong, me, { level: 'steady' }));
      if (!sameMove(a, b)) {
        bad(`${terrain.key} seed ${seed}: the move changed with the opponent's hidden rack — ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
      }
      checked++;
    }
  }
  if (!checked) bad('no position was suitable for the hidden-rack check');
  else console.log(`  ${checked} paired decisions, none of them swayed by what the opponent was holding`);
}

console.log('— but it does read its own rack —');
{
  // the same machinery must be able to notice a difference, or the test above
  // proves nothing at all
  let differed = 0, tried = 0;
  for (const terrain of TB.TERRAINS) {
    const G = position(terrain.key, 16);
    if (G.phase === 'over' || G.pending) continue;
    const me = G.turn;
    const n = G.players.find((x) => x.seat === me).rack.length;
    if (n < 2) continue;
    const a = seeded(11, () => TB.botChoose(withRack(G, me, Array.from({ length: n }, () => 'skully')), me, { level: 'steady' }));
    const b = seeded(11, () => TB.botChoose(withRack(G, me, Array.from({ length: n }, () => 'roxy')), me, { level: 'steady' }));
    tried++;
    if (!sameMove(a, b)) differed++;
  }
  if (!differed) bad(`changing the bot's OWN rack never changed its move across ${tried} positions — the comparison above is not measuring anything`);
  else console.log(`  own rack swapped in ${tried} positions, move changed in ${differed}`);
}

console.log('\n— and it takes a win when one is there —');
{
  // build the chain out of whatever the board actually is, rather than naming
  // coordinates a re-transcribed board would not have: walk from blue's H.Q.
  // to red's and hold every base along the way
  const castle = TB.terrainByKey('castle');
  const chainToRed = (() => {
    const adj = castle.nodes.map(() => []);
    for (const [x, y] of castle.edges) { adj[x].push(y); adj[y].push(x); }
    const goal = castle.nodes.find((n) => n.hq === 1).id;
    const from = castle.nodes.filter((n) => n.hq === 0).map((n) => n.id);
    const prev = new Map(from.map((n) => [n, null]));
    const queue = [...from];
    while (queue.length) {
      const n = queue.shift();
      for (const m of adj[n]) {
        if (prev.has(m)) continue;
        prev.set(m, n);
        if (m === goal) { const path = []; let at = n; while (at !== null && castle.nodes[at].hq === null) { path.push(at); at = prev.get(at); } return path; }
        if (castle.nodes[m].hq === null) queue.push(m);
      }
    }
    return [];
  })();
  let took = 0;
  for (const level of ['quick', 'steady', 'sharp']) {
    const G = TB.newMatch(roster(), { terrain: 'castle' });
    G.turn = 0;
    G.board = G.terrain.nodes.map(() => []);
    chainToRed.forEach((n, i) => { G.board[n] = [{ id: 'x' + i, key: 'roxy', owner: 0 }]; });
    G.players[0].rack = [{ id: 'w', key: 'skully', owner: 0 }];
    const mv = TB.botChoose(G, 0, { level });
    const isWin = mv && mv.kind === 'place' && G.terrain.nodes[mv.node].hq === 1;
    if (isWin) took++;
    else bad(`${level} did not march into an open enemy H.Q. — played ${JSON.stringify(mv)}`);
  }
  if (took === 3) console.log('  all three levels walk into an undefended H.Q.');
}

console.log('\n— it does not hang its own H.Q. —');
{
  // The sharpest quality signal there is: a turn that leaves your H.Q. open
  // to an immediate capture when some other legal move would not have. The
  // shallow bot does this because one ply cannot see the reply; the searching
  // bot should essentially never do it.
  const clone = (G) => JSON.parse(JSON.stringify(G));
  const canWinNow = (G, seat) => {
    if (G.pending || G.phase !== 'playing') return false;
    const p = G.players.find((x) => x.seat === seat);
    if (!p) return false;
    const hq = G.terrain.nodes.filter((n) => n.hq !== null && n.hq !== seat).map((n) => n.id);
    for (const key of new Set(p.rack.filter((x) => x.id !== p.frozen).map((x) => x.key))) {
      if (TB.placeOptions(G, seat, key).some((n) => hq.includes(n))) return true;
    }
    return false;
  };
  const everyMove = (G, actor) => {
    if (G.pending) return null;
    const p = G.players.find((x) => x.seat === actor);
    const out = [];
    const seen = new Set();
    for (const x of p.rack) {
      if (x.id === p.frozen || seen.has(x.key)) continue;
      seen.add(x.key);
      for (const n of TB.placeOptions(G, actor, x.key)) out.push({ kind: 'place', tile: x.id, node: n });
    }
    if (p.reserve.length && p.rack.length < TB.RACK_MAX) out.push({ kind: 'draw' });
    return out;
  };

  let judged = 0, avoidable = 0;
  for (let g = 0; g < 14; g++) {
    const G = TB.newMatch(roster(), {});
    let guard = 0;
    while (G.phase !== 'over' && guard++ < 4000) {
      const actor = G.pending ? G.pending.seat : G.turn;
      const foe = actor === 0 ? 1 : 0;
      const options = everyMove(G, actor);
      const before = options && options.length > 1 ? clone(G) : null;
      const mv = TB.botChoose(G, actor, { level: 'steady' });
      if (!mv) break;
      TB.applyMove(G, actor, mv);
      if (!before || G.phase === 'over' || G.pending || G.turn !== foe) continue;
      judged++;
      if (!canWinNow(G, foe)) continue;
      const hadSafe = options.some((alt) => {
        const H = clone(before);
        const r = TB.applyMove(H, actor, alt);
        if (!r.ok || H.phase === 'over' || H.pending) return false;
        return !canWinNow(H, foe);
      });
      if (hadSafe) avoidable++;
    }
  }
  const rate = avoidable / Math.max(1, judged);
  console.log(`  ${judged} turns judged, ${avoidable} left the H.Q. open when something else would not have (${(rate * 100).toFixed(2)}%)`);
  // measured around 0.0–0.4%; the shallow bot sits at 0.16%. A bar at 3% is
  // far enough above the noise to mean something has actually broken, and
  // "a safe move existed" is only an approximation anyway — the safe move
  // might lose for some other reason the search could see and this cannot.
  if (rate > 0.03) bad(`the searching bot hung its H.Q. avoidably on ${(rate * 100).toFixed(1)}% of turns`);
}

console.log('\n— and it beats the shallow bot by a wide margin —');
{
  // Seats swap every game so the opening advantage cannot be read as skill.
  // A cheap search config is used on purpose: it keeps the suite quick, and
  // if even this beats the shallow bot handily then the deeper levels do too.
  // the shipped 'steady' level, so the test guards what people actually play
  const SEARCH = { level: 'steady' };
  const games = 150;
  let wins = 0;
  for (let g = 0; g < games; g++) {
    const aSeat = g % 2;
    const G = TB.newMatch(roster(), {});
    let guard = 0;
    while (G.phase !== 'over' && guard++ < 4000) {
      const actor = G.pending ? G.pending.seat : G.turn;
      const mv = TB.botChoose(G, actor, actor === aSeat ? SEARCH : { level: 'quick' });
      if (!mv) break;
      const r = TB.applyMove(G, actor, mv);
      if (!r.ok) { bad('illegal move in the duel: ' + r.error); guard = 1e9; }
    }
    if (G.phase === 'over' && G.winner === aSeat) wins++;
  }
  const rate = wins / games;
  console.log(`  ${wins} of ${games} games`);
  // Measured in the high sixties across runs. At 150 games one sigma is
  // about 3.8 points, so a bar at 55% is three sigma clear of a bad night
  // while still failing loudly if search ever drops back to parity.
  if (rate < 0.55) bad(`search won only ${(rate * 100).toFixed(0)}% against the shallow bot — the bar is 55%`);
}

console.log(fails ? `\n${fails} FAILURES` : '\nthe bot is strong and does not peek');
process.exit(fails ? 1 : 0);
