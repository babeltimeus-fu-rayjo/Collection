// So Clover!, played out many times over by a table of simulated players at
// every size and with every number of cards added: Clues written, cards put
// back at random or by someone who knows the answer, players dropping out and
// coming back. After every move: every card is somewhere and only once, no
// clover is scored more than once or at 5, the score adds up, and no view
// shows what its seat should not see.
import * as M from './game.js';

let games = 0, moves = 0, problems = 0;
const scores = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
const bad = (what) => {
  problems++;
  if (problems < 12) console.log('  **PROBLEM**', what);
};
const pick = (a) => a[Math.floor(Math.random() * a.length)];

function check(G) {
  // every card of the clover being put back lies in one place
  const r = G.round;
  if (r) {
    const cl = G.clovers[r.seat];
    const ids = [...cl.cards, ...cl.extra].map((c) => c.id).sort();
    const where = [...r.tray.map((t) => t.id), ...r.board.filter(Boolean).map((b) => b.id)].sort();
    if (ids.join() !== where.join()) bad(`cards lost or doubled: ${ids.join()} vs ${where.join()}`);
    if (r.board.some((b) => b && (b.rot < 0 || b.rot > 3)) || r.tray.some((t) => t.rot < 0 || t.rot > 3)) bad('a card turned off the clock');
  }
  const sum = G.results.reduce((n, x) => n + x.points, 0);
  if (sum !== G.score) bad(`score ${G.score} but clovers add up to ${sum}`);
  if (new Set(G.results.map((x) => x.seat)).size !== G.results.length) bad('a clover scored twice');
  if (G.results.some((x) => x.points === 5 || x.points > 6 || (x.perfect && x.points !== 6))) bad('a clover scored 5, or more than 6');
  // what each seat sees
  for (const p of G.players) {
    const text = JSON.stringify(M.viewFor(G, p.seat, 'T'));
    for (const q of G.players) {
      if (q.seat === p.seat) continue;
      const cl = G.clovers[q.seat];
      const playing = r && r.seat === q.seat;
      const scored = G.results.some((x) => x.seat === q.seat);
      if (!playing && !scored && G.phase !== 'over') {
        // nobody's cards or Clues until their clover comes up
        for (const c of cl.cards) for (const w of c.words) if (text.includes(`"${w}"`)) bad(`seat ${p.seat} sees ${q.seat}'s Keyword ${w}`);
        for (const c of cl.clues) if (c && text.includes(`"${c}"`)) bad(`seat ${p.seat} sees ${q.seat}'s Clue ${c}`);
      }
    }
    if (r && !r.done && p.seat !== r.seat && M.viewFor(G, p.seat, 'T').round.solution) bad(`guesser ${p.seat} sees the solution`);
  }
  if (r && !r.done && M.viewFor(G, r.seat, 'T', { observer: true }).round.solution) bad('a watcher sees the solution');
  // a watcher sees nobody's cards while the Clues are written, whoever they stand behind
  if (G.phase === 'clues') {
    for (const p of G.players) {
      const text = JSON.stringify(M.viewFor(G, p.seat, 'T', { observer: true }));
      for (const c of G.clovers[p.seat].cards) for (const w of c.words) if (text.includes(`"${w}"`)) bad(`a watcher behind ${p.seat} sees ${w}`);
    }
  }
}

function play(G, seat, move) {
  const res = M.applyMove(G, seat, move);
  moves++;
  if (res.ok) check(G);
  return res.ok;
}

for (let n = 3; n <= 6; n++) {
  for (let extra = 1; extra <= 4; extra++) {
    for (let k = 0; k < 40; k++) {
      const G = M.newGame(Array.from({ length: n }, (_, i) => ({ seat: i, name: `P${i}` })), { extra });
      games++;
      // Choosing Clues, sometimes with a false start and an Edit
      for (const p of G.players) {
        const kw = M.keywordsOf(G.clovers[p.seat]);
        if (Math.random() < 0.3) play(G, p.seat, { kind: 'clue', leaf: 0, text: 'two words' });
        const clues = [0, 1, 2, 3].map((l) => `Clue${p.seat}x${l}`);
        if (Math.random() < 0.2) {
          if (play(G, p.seat, { kind: 'done', clues: [kw[0], ...clues.slice(1)] })) bad('a Keyword taken as a Clue');
        }
        // the last one may drop out instead, and be set aside
        if (p === G.players[G.players.length - 1] && Math.random() < 0.1) {
          M.markDisconnected(G, p.seat);
          if (!M.setAside(G, p.seat)) bad('could not set aside an absent player');
          M.markReconnected(G, p.seat);
          continue;
        }
        if (!play(G, p.seat, { kind: 'done', clues })) bad(`valid Clues refused for ${p.seat}`);
        if (Math.random() < 0.1 && G.phase === 'clues') {
          play(G, p.seat, { kind: 'done', on: false });
          play(G, p.seat, { kind: 'done' });
        }
      }
      if (G.phase !== 'resolve') bad(`phase ${G.phase} once every Clue is in`);
      // the Resolution
      for (let guard = 0; guard < 4000 && G.phase === 'resolve'; guard++) {
        const r = G.round;
        if (r.done) {
          for (const p of G.players) if (G.round === r) play(G, p.seat, { kind: 'next' });
          continue;
        }
        const guessers = G.players.filter((p) => p.seat !== r.seat && p.connected).map((p) => p.seat);
        const who = pick(guessers);
        const sol = G.clovers[r.seat].spots;
        const knows = Math.random() < 0.35; // someone who has read the Clues well
        const roll = Math.random();
        if (roll < 0.03 && guessers.length > 1) {
          // someone drops out for a moment
          M.markDisconnected(G, who);
          check(G);
          if (G.round === r) M.markReconnected(G, who);
          continue;
        }
        if (roll < 0.06) {
          // the Spectator tries to touch, and cannot
          if (play(G, r.seat, { kind: 'place', card: r.tray[0] ? r.tray[0].id : sol[0].id, spot: 0 })) bad('the Spectator moved a card');
          continue;
        }
        const empty = r.board.map((b, s) => (b ? null : s)).filter((s) => s !== null);
        if (empty.length) {
          const s = pick(empty);
          const card = knows && r.tray.some((t) => t.id === sol[s].id) ? sol[s].id : pick(r.tray).id;
          play(G, who, { kind: 'place', card, spot: s });
          if (knows && card === sol[s].id) while (r.board[s] && r.board[s].id === card && r.board[s].rot !== sol[s].rot) play(G, who, { kind: 'turn', card });
          else if (Math.random() < 0.5) play(G, who, { kind: 'turn', card, dir: pick([1, -1]) });
          continue;
        }
        // a full clover: change something, or agree, or lock it in
        if (Math.random() < 0.15) {
          const loose = r.board.filter((b) => b && !b.fixed);
          if (loose.length) {
            const b = pick(loose);
            if (Math.random() < 0.5) play(G, who, { kind: 'lift', card: b.id });
            else play(G, who, { kind: 'turn', card: b.id });
            continue;
          }
        }
        const d = M.deciderOf(G);
        if (Math.random() < 0.3 && guessers.includes(d)) play(G, d, { kind: 'lock' });
        else for (const s of guessers) if (G.round === r && !r.done && !r.agree.includes(s)) play(G, s, { kind: 'agree' });
      }
      if (G.phase !== 'over') bad(`a game of ${n} with ${extra} added never ended`);
      for (const x of G.results) scores[x.points]++;
    }
  }
}

console.log(`${games} games, ${moves} moves. Clovers scored: ${Object.entries(scores).map(([k, v]) => `${k}: ${v}`).join(', ')}.`);
console.log(problems ? `${problems} PROBLEMS` : 'no problems');
process.exit(problems ? 1 : 0);
