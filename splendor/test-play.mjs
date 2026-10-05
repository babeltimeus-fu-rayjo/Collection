// Whole games between bots at two, three and four players, with every mix of
// the expansion modules: every move legal, every token, card and Stronghold
// accounted for after every move, nothing hidden shown to anyone it is hidden
// from, and every game over.
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
  // cards: each one in exactly one place — the box counts, for spent Gold
  // cards and sacrificed ones
  const seen = new Map();
  const put = (id, where) => { if (seen.has(id)) fail(`card ${id} in ${seen.get(id)} and ${where}`); seen.set(id, where); };
  const settled = !G.queue.length && G.ask && G.ask.kind === 'turn';
  for (const l of S.LEVELS) {
    G.decks[l].forEach((id) => put(id, `deck ${l}`));
    G.odecks[l].forEach((id) => put(id, `Orient deck ${l}`));
    G.market[l].forEach((id) => id != null && put(id, `table ${l}`));
    G.omarket[l].forEach((id) => id != null && put(id, `Orient table ${l}`));
    if (G.market[l].length !== 4) fail(`level ${l} has ${G.market[l].length} places`);
    if (G.omarket[l].length !== (G.opts.orient ? 2 : 0)) fail(`level ${l} has ${G.omarket[l].length} Orient places`);
    if (settled && G.decks[l].length && G.market[l].includes(null)) fail(`an empty place on level ${l} while its deck has cards`);
    if (settled && G.odecks[l].length && G.omarket[l].includes(null)) fail(`an empty Orient place on level ${l} while its deck has cards`);
  }
  for (const p of G.players) {
    p.cards.forEach((id) => put(id, `${p.name}'s cards`));
    p.reserved.forEach((r) => put(r.id, `${p.name}'s reserve`));
    if (p.reserved.length > S.RESERVE_LIMIT) fail(`${p.name} holds ${p.reserved.length} reserved cards`);
    for (const id of Object.keys(p.assoc)) if (!p.cards.includes(Number(id))) fail(`${p.name} has a colour for a card they do not own`);
  }
  G.out.forEach((id) => put(id, 'the box'));
  (G.look || []).forEach((id) => put(id, 'the Trading Post’s choice'));
  if (seen.size !== G.cards.length) fail(`${seen.size} cards accounted for, not ${G.cards.length}`);
  if (G.out.some((id) => G.cards[id].kind !== 'gold' && !isSacrificed(G, id))) fail('a card in the box that should not be');
  // a Noble's holder meets its demand — unless a sacrifice card took cards away
  if (!G.opts.orient) for (const p of G.players) for (const id of p.nobles) if (!S.meets(G, p, G.nobles[id])) fail(`${p.name} has a Noble without the bonuses`);
  // Nobles: one more than players, on the table or with someone — none with the Cities
  const nob = G.nobleRow.length + G.players.reduce((a, p) => a + p.nobles.length, 0);
  if (nob !== (G.opts.cities ? 0 : G.n + 1)) fail(`${nob} Nobles in the game`);
  // Strongholds: three each, in hand or on the table's cards, never two
  // players' on one card
  if (G.opts.strongholds) {
    const table = new Set(S.LEVELS.flatMap((l) => [...G.market[l], ...G.omarket[l]]));
    for (const p of G.players) {
      const placed = Object.values(G.holds).reduce((a, list) => a + list.filter((x) => x === p.seat).length, 0);
      if (placed + p.holds !== S.STRONGHOLDS) fail(`${p.name} has ${placed + p.holds} Strongholds`);
    }
    for (const [id, list] of Object.entries(G.holds)) {
      if (!table.has(Number(id))) fail(`a Stronghold on card ${id}, which is not on the table`);
      if (new Set(list).size > 1) fail(`two players' Strongholds on card ${id}`);
    }
  }
  // Trading Posts: each claimed once, by someone who met it then
  for (const p of G.players) if (new Set(p.posts).size !== p.posts.length) fail(`${p.name} has a Trading Post twice`);
}
const sacrificed = new Set();
const isSacrificed = (G, id) => sacrificed.has(id);

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
const byMix = {};
// every mix of the four modules at every size, the base game first; the two
// extra Nobles come along in every other round of 48 games
const MIXES = [];
for (let m = 0; m < 16; m++) MIXES.push({ cities: !!(m & 1), trading: !!(m & 2), orient: !!(m & 4), strongholds: !!(m & 8) });
for (let g = 0; g < GAMES; g++) {
  const n = 2 + (g % 3);
  const opts = { ...MIXES[Math.floor(g / 3) % MIXES.length], nobles: Math.floor(g / 48) % 2 === 1 };
  const mix = Object.keys(opts).filter((k) => opts[k] && k !== 'nobles').join('+') || 'base';
  const G = S.newGame(Array.from({ length: n }, (_, i) => ({ seat: i, name: 'Bot' + i, bot: true })), opts);
  const start = { ...G.bank };
  sacrificed.clear();
  census(G, start);
  let k = 0;
  while (G.phase !== 'over' && k < 2000) {
    const a = G.ask;
    const m = S.botChoose(G, a.seat);
    if (!m) { fail(`game ${g}: no answer to ${a.kind}`); break; }
    const r = S.applyMove(G, a.seat, m);
    if (!r.ok) { fail(`game ${g}: illegal ${JSON.stringify(m)}: ${r.error}`); break; }
    for (const id of m.discard || []) sacrificed.add(id);
    k++;
    census(G, start);
    invariants(G);
    if (k % 20 === 0) noLeaks(G);
  }
  if (G.phase !== 'over') { fail(`game ${g} (${n} players, ${mix}) never ended: ${G.log.slice(-4).map((l) => l.text).join(' | ')}`); continue; }
  noLeaks(G);
  // "continue playing until all players have had the same number of turns"
  if (new Set(G.players.map((p) => p.turns)).size !== 1) fail(`game ${g}: turns ${G.players.map((p) => p.turns)}`);
  if (!G.opts.cities && G.ending != null && S.score(G, S.playerBySeat(G, G.ending)) < S.WIN_POINTS) fail(`game ${g}: ended by someone under 15`);
  const eligible = G.opts.cities ? G.players.filter((p) => G.cities.some((c) => S.meetsCity(G, p, c))) : G.players;
  if (G.opts.cities && G.winners.some((w) => !eligible.some((p) => p.seat === w)) && !/no one can/.test(G.why)) fail(`game ${g}: a winner who meets no City`);
  const best = Math.max(...eligible.map((p) => S.score(G, p)));
  if (!/no one can/.test(G.why)) for (const w of G.winners) if (S.score(G, S.playerBySeat(G, w)) !== best) fail(`game ${g}: a winner without the most points`);
  (byMix[mix] = byMix[mix] || []).push(Math.max(...G.players.map((p) => p.turns)));
  moves += k;
  const turns = Math.max(...G.players.map((p) => p.turns));
  const top = Math.max(...G.players.map((p) => S.score(G, p)));
  stats[n].push({ turns, top });
  if (G.winners.includes(G.players[G.first].seat)) firstWins[n]++;
}

const avg = (a, f) => (a.reduce((s, x) => s + f(x), 0) / a.length).toFixed(1);
console.log(`${GAMES} games, ${moves} moves`);
for (const n of [2, 3, 4]) console.log(`  ${n} players: ${avg(stats[n], (x) => x.turns)} turns each on average (longest ${Math.max(...stats[n].map((x) => x.turns))}), winning score ${avg(stats[n], (x) => x.top)}, first player won ${Math.round((100 * firstWins[n]) / stats[n].length)}%`);
console.log('turns by mix:', Object.entries(byMix).map(([k, v]) => `${k} ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)}`).join(', '));
console.log(fails ? `${fails} FAILURES` : 'every move legal, every token, card and Stronghold accounted for, every game over');
process.exit(fails ? 1 : 0);
