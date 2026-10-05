// Whole games between bots, four to seven players: every move the bots make
// must be legal, every one of the 80 cards must be somewhere exactly once
// after every move, and every game must end.
import * as B from './game.js';

const GAMES = Number(process.argv[2] || 600);
let fails = 0;
const fail = (what) => { if (fails++ < 12) console.log('  **FAIL** ' + what); };

function census(G) {
  const seen = new Map();
  const put = (id, where) => { if (seen.has(id)) fail(`card ${id} (${G.cards[id].kind}) in ${seen.get(id)} and ${where}`); seen.set(id, where); };
  G.deck.forEach((id) => put(id, 'deck'));
  G.discard.forEach((id) => put(id, 'discard'));
  for (const p of G.players) { p.hand.forEach((id) => put(id, p.name + ' hand')); p.table.forEach((id) => put(id, p.name + ' table')); }
  if (G.store) G.store.cards.forEach((id) => put(id, 'store'));
  if (G.look) G.look.forEach((id) => put(id, 'look'));
  if (seen.size !== G.cards.length) fail(`${seen.size} cards accounted for, not ${G.cards.length}`);
}

function invariants(G) {
  for (const p of G.players) {
    if (p.life > p.max) fail(`${p.name} at ${p.life} of ${p.max}`);
    if (!p.alive && (p.hand.length || p.table.length)) fail(`${p.name} is out but still holds cards`);
    if (p.alive && p.life <= 0 && G.phase !== 'over' && !(G.ask && G.ask.kind === 'dying')) fail(`${p.name} alive at ${p.life}`);
    const names = p.table.map((id) => G.cards[id].kind);
    if (new Set(names).size !== names.length) fail(`${p.name} has two of a card in play: ${names}`);
    if (names.filter((k) => B.KINDS[k].weapon).length > 1) fail(`${p.name} has two weapons`);
  }
  if (G.phase !== 'over') {
    if (!G.ask) fail('no one to move');
    else if (!B.playerBySeat(G, G.ask.seat).alive) fail(`waiting on ${G.ask.seat}, who is out`);
  }
}

// what a player's view may show of others
function noLeaks(G) {
  for (const p of G.players) {
    const v = B.viewFor(G, p.seat, 'TEST');
    for (const q of v.players) {
      const real = B.playerBySeat(G, q.seat);
      if (typeof q.hand !== 'number') fail('a hand shown to another player');
      const shown = real.role === 'sheriff' || !real.alive || G.phase === 'over' || q.seat === p.seat;
      if (!shown && q.role !== undefined) fail(`${p.name} sees ${real.name}'s role`);
      if (shown && q.role !== real.role) fail(`${p.name} cannot see ${real.name}'s role`);
    }
    if (v.look && !(G.ask && G.ask.kind === 'kit' && G.ask.seat === p.seat)) fail('Kit Carlson’s cards shown to someone else');
  }
}

const tally = { law: 0, outlaws: 0, renegade: 0 };
const byN = {};
let moves = 0, longest = 0, turns = 0;
const askKinds = {};
for (let g = 0; g < GAMES; g++) {
  const n = 4 + (g % 4);
  const G = B.newGame(Array.from({ length: n }, (_, i) => ({ seat: i, name: 'Bot' + i, bot: true })));
  census(G);
  let k = 0;
  let lastTurn = -1;
  while (G.phase !== 'over' && k < 4000) {
    const a = G.ask;
    askKinds[a.kind] = (askKinds[a.kind] || 0) + 1;
    const move = B.botChoose(G, a.seat);
    if (!move) { fail(`game ${g}: the bot has no answer to ${a.kind}`); break; }
    const r = B.applyMove(G, a.seat, move);
    if (!r.ok) { fail(`game ${g}: illegal ${JSON.stringify(move)} for ${a.kind}: ${r.error}`); break; }
    k++;
    if (G.turn !== lastTurn) { turns++; lastTurn = G.turn; }
    census(G);
    invariants(G);
    if (k % 25 === 0) noLeaks(G);
  }
  if (G.phase !== 'over') { fail(`game ${g} (${n} players) never ended`); continue; }
  noLeaks(G);
  tally[G.winner]++;
  byN[n] = byN[n] || { law: 0, outlaws: 0, renegade: 0 };
  byN[n][G.winner]++;
  moves += k;
  longest = Math.max(longest, k);
}

console.log(`${GAMES} games, ${moves} moves (${Math.round(moves / GAMES)} a game, longest ${longest})`);
console.log('winners:', JSON.stringify(tally));
for (const n of Object.keys(byN)) console.log(`  ${n} players:`, JSON.stringify(byN[n]));
console.log('decisions:', JSON.stringify(askKinds));
console.log(fails ? `${fails} FAILURES` : 'every move legal, every card accounted for, every game over');
process.exit(fails ? 1 : 0);
