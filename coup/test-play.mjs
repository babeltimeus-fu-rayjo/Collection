// Whole games played by bots at every table size from two to ten, with and
// without Reformation, the Inquisitor and the two-player variant, checked
// after every move: every move a bot makes is legal, no card is made or
// lost, no view shows a card it should not, and every game ends — with a
// tally of how the games went.
import * as A from './game.js';

let fails = 0;
const bad = (m) => { if (fails < 20) console.log('  **FAIL** ' + m); fails++; };

// every card: the Court deck, the players' cards, the cards drawn to
// exchange, and the two-player variant's sets and set-aside cards
function cardsIn(G) {
  const drawn = G.ask && G.ask.drawn ? G.ask.drawn.length : 0;
  return drawn + G.deck.length + G.players.reduce((t, p) => t + p.cards.length + (p.aside ? p.aside.length : 0) + (p.set ? p.set.length : 0), 0);
}

// what no view may carry mid-game
function views(G) {
  if (G.phase === 'over') return;
  for (const p of G.players) {
    const v = A.viewFor(G, p.seat, 'X');
    for (const q of v.players) {
      if (q.seat === p.seat) continue;
      for (const c of q.cards) if (!c.up && (c.char !== undefined || c.id !== undefined)) bad(`seat ${p.seat} sees seat ${q.seat}'s face-down card`);
    }
    if (v.ask && v.ask.drawn && v.ask.seat !== p.seat) bad('a view shows the cards drawn to exchange to another');
    if (v.ask && v.ask.card && v.ask.seat !== p.seat) bad('a view shows the examined card to another');
    if (v.act && v.act.pre && v.act.target !== p.seat) bad('a view shows a block said early to another');
    if (v.me.set && G.players.find((x) => x.seat === p.seat).set !== null && v.me.set !== G.players.find((x) => x.seat === p.seat).set) bad('a view shows another set');
    if ('deck' in v && typeof v.deck !== 'number') bad('a view carries the Court deck');
  }
}

function playOut(n, opts) {
  const G = A.newGame(Array.from({ length: n }, (_, i) => ({ seat: i, name: 'P' + i, bot: true })), opts);
  const all = cardsIn(G);
  if (all !== (G.opts.twoPlayer ? 15 : 5 * A.copiesFor(n))) bad(`${n} players were dealt ${all} cards`);
  let steps = 0;
  while (G.phase !== 'over') {
    if (++steps > 20000) { bad(`a game of ${n} never ended (${G.turns} turns)`); return G; }
    const waiting = A.waitingOn(G);
    if (!waiting.length) { bad(`nobody to wait on (${G.phase})`); return G; }
    const seat = waiting[Math.floor(Math.random() * waiting.length)];
    const mv = A.botChoose(G, seat);
    if (!mv) { bad(`seat ${seat} had no move (${G.ask && G.ask.kind}, ${G.window && G.window.kind})`); return G; }
    const r = A.applyMove(G, seat, mv);
    if (!r.ok) { bad(`seat ${seat} made an illegal move: ${r.error} ${JSON.stringify(mv)}`); return G; }
    if (cardsIn(G) !== all) bad('a card was made or lost');
    for (const p of G.players) {
      if (p.coins < 0) bad('a player has fewer than no coins');
      if (p.out && (p.coins || p.cards.some((c) => !c.up))) bad('an exiled player kept coins or influence');
      if (!p.out && G.phase === 'play' && !p.cards.some((c) => !c.up)) bad('a player without influence is still in');
    }
    if (G.reserve < 0) bad('the Treasury Reserve went below nothing');
    if (steps % 3 === 0) views(G);
  }
  return G;
}

const MIXES = [{}, { reformation: true }, { inquisitor: true }, { reformation: true, inquisitor: true }, { twoPlayer: true }, { twoPlayer: true, reformation: true, inquisitor: true }];
const GAMES = Number(process.argv[2] || 40);
const wins = {};
const first = { won: 0, games: 0 };
const acts = {};
let games = 0;
let turns = 0;
const t0 = Date.now();
for (let n = A.MIN_PLAYERS; n <= A.MAX_PLAYERS; n++) {
  for (const extra of MIXES) {
    if (extra.twoPlayer && n !== 2) continue;
    const opts = { ...A.defaultOpts(), ...extra };
    for (let g = 0; g < GAMES; g++) {
      const G = playOut(n, opts);
      if (G.phase !== 'over') continue;
      games++;
      turns += G.turns;
      const w = G.players.find((p) => p.seat === G.winner);
      if (!w || w.out || G.players.filter((p) => !p.out).length !== 1) bad('the winner is not the one left');
      wins[n] = (wins[n] || 0) + 1;
      first.games++;
      if (G.winner === G.players[G.start].seat) first.won++;
      for (const c of G.claims) acts[c.result || 'unchallenged'] = (acts[c.result || 'unchallenged'] || 0) + 1;
    }
  }
}
console.log(`  ${games} games in ${Date.now() - t0}ms — ${Math.round(turns / games)} turns on average; the first player won ${Math.round((100 * first.won) / first.games)}%`);
console.log(`  claims: ${acts.unchallenged || 0} unchallenged, ${acts.shown || 0} shown when challenged, ${acts.conceded || 0} lost`);
console.log(fails ? `\n${fails} FAILURES` : '\nevery game ended, every move was legal, no card was made or lost, no view leaked');
process.exit(fails ? 1 : 0);
