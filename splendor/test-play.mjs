// Whole games between bots at two, three and four players: every move legal,
// every token and every card accounted for after every move, nothing hidden
// shown to anyone it is hidden from, and every game over.
import * as S from './game.js';

const GAMES = Number(process.argv[2] || 300);
let fails = 0;
const fail = (what) => { if (fails++ < 12) console.log('  **FAIL** ' + what); };

function census(G, start) {
  // tokens: the supply and everyone's hands always add up to the box
  for (const t of S.TOKENS) {
    const total = G.bank[t] + G.players.reduce((a, p) => a + p.tokens[t], 0);
    if (total !== start[t]) fail(`${t}: ${total} tokens, not ${start[t]}`);
    if (G.bank[t] < 0 || G.players.some((p) => p.tokens[t] < 0)) fail(`${t}: a negative pile`);
  }
  // cards: each of the 90 in exactly one place
  const seen = new Map();
  const put = (id, where) => { if (seen.has(id)) fail(`card ${id} in ${seen.get(id)} and ${where}`); seen.set(id, where); };
  for (const l of S.LEVELS) {
    G.decks[l].forEach((id) => put(id, `deck ${l}`));
    G.market[l].forEach((id) => id != null && put(id, `table ${l}`));
    if (G.market[l].length !== 4) fail(`level ${l} has ${G.market[l].length} places`);
    if (G.decks[l].length && G.market[l].includes(null)) fail(`an empty place on level ${l} while its deck has cards`);
  }
  for (const p of G.players) {
    p.cards.forEach((id) => put(id, `${p.name}'s cards`));
    p.reserved.forEach((r) => put(r.id, `${p.name}'s reserve`));
    if (p.reserved.length > S.RESERVE_LIMIT) fail(`${p.name} holds ${p.reserved.length} reserved cards`);
  }
  if (seen.size !== 90) fail(`${seen.size} cards accounted for`);
  // Nobles: one more than players, on the table or with someone
  const nob = G.nobleRow.length + G.players.reduce((a, p) => a + p.nobles.length, 0);
  if (nob !== G.n + 1) fail(`${nob} Nobles in the game`);
  for (const p of G.players) for (const id of p.nobles) if (!S.meets(G, p, G.nobles[id])) fail(`${p.name} has a Noble without the bonuses`);
}

function invariants(G) {
  if (G.phase === 'over') return;
  if (!G.ask) return fail('no one to move');
  const p = S.playerBySeat(G, G.ask.seat);
  const held = Object.values(p.tokens).reduce((a, b) => a + b, 0);
  if (G.ask.kind === 'turn' && held > S.TOKEN_LIMIT) fail(`${p.name} starts a turn with ${held} tokens`);
  if (G.ask.kind === 'discard' && held - G.ask.n !== S.TOKEN_LIMIT) fail('asked to give back the wrong number');
}

function noLeaks(G) {
  for (const viewer of G.players) {
    const v = S.viewFor(G, viewer.seat, 'T');
    v.players.forEach((q, i) => {
      const real = G.players[i];
      q.reserved.forEach((r, k) => {
        const blind = real.reserved[k].blind;
        if (blind && q.seat !== viewer.seat && G.phase !== 'over' && (r.id !== undefined || r.cost)) fail(`${viewer.name} sees ${real.name}'s blind reserve`);
        if (!blind && r.id !== real.reserved[k].id) fail('a face-up reserve hidden');
      });
    });
    if (JSON.stringify(v).includes('"decks":{"1":[')) fail('a deck’s order in a view');
  }
}

const stats = { 2: [], 3: [], 4: [] };
let moves = 0;
const firstWins = { 2: 0, 3: 0, 4: 0 };
for (let g = 0; g < GAMES; g++) {
  const n = 2 + (g % 3);
  const G = S.newGame(Array.from({ length: n }, (_, i) => ({ seat: i, name: 'Bot' + i, bot: true })));
  const start = { ...G.bank };
  census(G, start);
  let k = 0;
  while (G.phase !== 'over' && k < 2000) {
    const a = G.ask;
    const m = S.botChoose(G, a.seat);
    if (!m) { fail(`game ${g}: no answer to ${a.kind}`); break; }
    const r = S.applyMove(G, a.seat, m);
    if (!r.ok) { fail(`game ${g}: illegal ${JSON.stringify(m)}: ${r.error}`); break; }
    k++;
    census(G, start);
    invariants(G);
    if (k % 20 === 0) noLeaks(G);
  }
  if (G.phase !== 'over') { fail(`game ${g} (${n} players) never ended`); continue; }
  noLeaks(G);
  // "continue playing until all players have had the same number of turns"
  if (new Set(G.players.map((p) => p.turns)).size !== 1) fail(`game ${g}: turns ${G.players.map((p) => p.turns)}`);
  if (G.ending != null && S.score(G, S.playerBySeat(G, G.ending)) < S.WIN_POINTS) fail(`game ${g}: ended by someone under 15`);
  const best = Math.max(...G.players.map((p) => S.score(G, p)));
  for (const w of G.winners) if (S.score(G, S.playerBySeat(G, w)) !== best) fail(`game ${g}: a winner without the most points`);
  moves += k;
  const turns = Math.max(...G.players.map((p) => p.turns));
  const top = Math.max(...G.players.map((p) => S.score(G, p)));
  stats[n].push({ turns, top });
  if (G.winners.includes(G.players[G.first].seat)) firstWins[n]++;
}

const avg = (a, f) => (a.reduce((s, x) => s + f(x), 0) / a.length).toFixed(1);
console.log(`${GAMES} games, ${moves} moves`);
for (const n of [2, 3, 4]) console.log(`  ${n} players: ${avg(stats[n], (x) => x.turns)} turns each on average (longest ${Math.max(...stats[n].map((x) => x.turns))}), winning score ${avg(stats[n], (x) => x.top)}, first player won ${Math.round((100 * firstWins[n]) / stats[n].length)}%`);
console.log(fails ? `${fails} FAILURES` : 'every move legal, every token and card accounted for, every game over');
process.exit(fails ? 1 : 0);
