// The drafting bot, on two counts: that it is honest, and that it is good.
//
// Honest first. Steady plays practice matches in its head, and a practice
// match needs an opponent — the lazy one would be the real opponent's deck,
// which is private in the real game. It uses benchmark decks drafted at
// random from the sets in play instead, and its practice matches draw from
// their own shuffled copy of the Level piles. So: pin Math.random, ask it the
// same question twice with every other player's deck swapped for something
// absurd, and the answer must not change; and the real piles must come out of
// its thinking exactly as they went in.
import * as CH from './game.js';

let fails = 0;
const bad = (m) => { console.log('  **FAIL** ' + m); fails++; };

function seeded(seed, fn) {
  const real = Math.random;
  let s = seed >>> 0;
  Math.random = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  try { return fn(); } finally { Math.random = real; }
}

function tourney(levels, opts) {
  const roster = levels.map((l, i) => ({ seat: i, name: l + i, bot: true }));
  const G = CH.newMatch(roster, opts);
  let guard = 0;
  while (G.phase !== 'over' && guard++ < 50000) {
    if (G.phase === 'deck' || G.phase === 'final-deck') {
      for (const seat of CH.waitingOn(G)) {
        const r = CH.applyMove(G, seat, CH.botChoose(G, seat, { level: levels[seat] }));
        if (!r.ok) { bad(`${levels[seat]} made an illegal draft move: ${r.error}`); return G; }
        if (G.phase === 'match') break;
      }
    } else {
      for (const M of G.matches) {
        if (M.over) continue;
        if (M.pending) {
          const r = CH.applyMove(G, M.pending.seat, CH.botChoose(G, M.pending.seat, { level: levels[M.pending.seat] }));
          if (!r.ok) { bad(`a bot gave an illegal answer: ${r.error}`); return G; }
        } else CH.stepMatch(G, M);
      }
      CH.afterMatches(G);
    }
  }
  return G;
}

console.log('— the bot drafts from what it is allowed to know —');
{
  let checked = 0, changed = 0;
  for (const box of ['base', 'beach']) {
    for (const round of [2, 4, 6]) {
      const G = CH.newMatch([0, 1, 2, 3].map((s) => ({ seat: s, name: 'P' + s, bot: true })), CH.defaultOpts(box));
      // bring the table to this round's Deck Phase with quick drafts
      while (G.round < round) {
        if (G.phase === 'deck') for (const s of CH.waitingOn(G)) CH.applyMove(G, s, CH.botChoose(G, s, { level: 'quick' }));
        else { for (const M of G.matches) { if (M.pending) CH.applyMove(G, M.pending.seat, CH.botChoose(G, M.pending.seat, { level: 'quick' })); else if (!M.over) CH.stepMatch(G, M); } CH.afterMatches(G); }
      }
      const p = G.players[0];
      if (p.draft.chosen === null) CH.applyMove(G, 0, { kind: 'option', option: 0 });
      const piles = JSON.stringify(G.piles);
      const ask = () => { delete G.bots; return seeded(4242, () => CH.botChoose(G, 0, { level: 'steady' })); };
      const a = ask();
      if (JSON.stringify(G.piles) !== piles) bad(`${box} round ${round}: thinking changed the real Level piles`);
      const saved = G.players.slice(1).map((q) => q.deck.slice());
      for (const q of G.players.slice(1)) q.deck = q.deck.map(() => G.cards.findIndex((c) => c.key === 'newcomer'));
      const b = ask();
      G.players.slice(1).forEach((q, i) => { q.deck = saved[i]; });
      if (JSON.stringify(a) !== JSON.stringify(b)) bad(`${box} round ${round}: the pick changed with the other players' decks — ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
      // the same machinery must notice a change it IS allowed to see, or the
      // comparison above proves nothing: offer it a draw worth taking
      const mine = p.deck.slice();
      p.draft.drawn = p.draft.drawn.map(() => G.cards.findIndex((c) => c.key === 'horse' || c.key === 'bat' || c.key === 'alien' || c.key === 'eagle' || c.key === 'snake'));
      const c = ask();
      p.deck = mine;
      if (JSON.stringify(c) !== JSON.stringify(a)) changed++;
      checked++;
    }
  }
  console.log(`  ${checked} decisions, none of them swayed by anyone else's deck, none of them touching the piles`);
  if (!changed) bad('changing the bot’s own draw never changed its decision — the check above is not measuring anything');
  else console.log(`  and ${changed} of them did change when its own draw did`);
}

console.log('\n— and Steady out-drafts Quick —');
{
  let steady = 0;
  const n = 32;
  for (let g = 0; g < n; g++) {
    const levels = g % 2 ? ['steady', 'quick'] : ['quick', 'steady'];
    const G = tourney(levels, CH.defaultOpts(g % 4 < 2 ? 'base' : 'beach'));
    if (G.phase !== 'over') bad('a tournament did not finish');
    else if (levels[G.winner] === 'steady') steady++;
  }
  console.log(`  Steady won ${steady} of ${n} two-player tournaments`);
  // measured 70-80% over 40; at 32 games one sigma is about 2.5 wins, so a
  // bar at 18 is more than two sigma clear of a bad night and still fails
  // loudly if the thinking ever stops helping
  if (steady < 18) bad(`Steady won only ${steady} of ${n}`);
}

console.log(fails ? `\n${fails} FAILURES` : '\nthe bot drafts honestly and well');
process.exit(fails ? 1 : 0);
