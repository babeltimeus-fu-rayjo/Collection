// Space Base, played out many times over at every table size, with and
// without Light-Speed: bots, and players who do anything the rules allow at
// random — every ability with random targets, random buys, random ways of
// taking the dice — some of them on other players' turns. After every move:
// every card is in one place only, every cube sits in a square that counts,
// nothing runs below zero, every sector has one stationed card and no colony
// is ever deployed; and no view shows what it should not.
import * as M from './game.js';

let games = 0, moves = 0, refused = 0, problems = 0, overs = { vp: 0, win: 0, shared: 0 };
const kinds = {};
const bad = (what) => {
  problems++;
  if (problems < 15) console.log('  **PROBLEM**', what);
};
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const shipIds = M.CARDS.filter((c) => c.kind !== 'start').map((c) => c.id);

function where(p, id) {
  for (const s of M.SECTORS) {
    if (p.station[s] === id) return { sector: s, side: 'st' };
    if (p.deployed[s].includes(id)) return { sector: s, side: 'dp' };
  }
  return null;
}

function check(G) {
  // every shipyard card and colony in one place only
  const seen = new Map();
  const at = (id, place) => {
    if (seen.has(id)) bad(`${M.CARDS[id].name} both ${seen.get(id)} and ${place}`);
    seen.set(id, place);
  };
  for (const l of M.LEVELS) {
    if (G.yard[l].length !== M.YARD) bad(`a shipyard row of ${G.yard[l].length}`);
    G.decks[l].forEach((id) => at(id, `deck ${l}`));
    G.yard[l].forEach((id) => id != null && at(id, `yard ${l}`));
  }
  G.colonies.forEach((id) => at(id, 'the colonies'));
  if (G.phase === 'light') for (const p of G.players) G.light[p.seat].offer.forEach((id) => !G.light[p.seat].done && at(id, `${p.name}'s offer`));
  for (const p of G.players) {
    const own = new Map();
    for (const s of M.SECTORS) {
      const st = p.station[s];
      if (st == null) bad(`${p.name}'s sector ${s} has no stationed card`);
      for (const id of [st, ...p.deployed[s]]) {
        if (id == null) continue;
        if (M.CARDS[id].kind === 'start') {
          if (own.has(id)) bad(`${p.name} has starting ship ${id} twice`);
          own.set(id, s);
        } else at(id, `${p.name}'s sector ${s}`);
      }
      if (p.deployed[s].some((id) => M.CARDS[id].kind === 'colony')) bad(`${p.name} has a colony deployed`);
    }
    if (own.size !== 12) bad(`${p.name} has ${own.size} of the twelve starting ships`);
    for (const [sid, k] of Object.entries(p.cubes)) {
      const id = Number(sid);
      const w = where(p, id);
      if (!w) { bad(`${p.name} has cubes on a card not on the console`); continue; }
      const cap = M.capOf(M.CARDS[id][w.side].sq, G.n);
      if (!(k > 0) || k > cap) bad(`${p.name}: ${k} cubes on ${M.CARDS[id].name}, room for ${cap}`);
    }
    if (p.cr < 0 || p.inc < 0 || p.vp < 0) bad(`${p.name} below zero: ${p.cr} ${p.inc} ${p.vp}`);
  }
  // In the light phase the offers are held out of the decks until bought.
  const total = shipIds.length;
  const offerCount = G.phase === 'light' ? G.players.reduce((n, p) => n + G.light[p.seat].offer.length, 0) : 0;
  if (seen.size !== total && !(G.phase === 'light' && seen.size === total)) bad(`${seen.size} cards accounted for, of ${total} (${offerCount} on offer)`);
  // the views
  for (const p of G.players) {
    const v = M.viewFor(G, p.seat, 'T');
    const text = JSON.stringify(v);
    for (const l of M.LEVELS) if (typeof v.decks[l] !== 'number') bad('a view shows a deck');
    if (G.phase === 'alloc') {
      for (const q of G.players) {
        if (q === p) continue;
        const theirs = JSON.stringify(G.alloc[q.seat].options);
        if (theirs !== JSON.stringify(G.alloc[p.seat].options) && text.includes(theirs)) bad(`seat ${p.seat} sees ${q.seat}'s choices`);
      }
    }
    if (G.phase === 'light') {
      for (const q of G.players) {
        const picks = G.light[q.seat].picks;
        if (q !== p && picks && picks.length && v.light.mine && JSON.stringify(v.light.mine) === JSON.stringify(picks) && JSON.stringify(G.light[p.seat].picks) !== JSON.stringify(picks)) bad(`seat ${p.seat} sees ${q.seat}'s picks`);
      }
    }
    if (v.can && p !== G.players[G.turn] && (v.can.roll || v.can.end || v.can.buy.length)) bad(`seat ${p.seat} may act on another's turn`);
  }
  const watch = M.viewFor(G, G.players[0].seat, 'T', { observer: true });
  if (watch.alloc || watch.can) bad('a watcher could act');
}

function play(G, seat, move) {
  const r = M.applyMove(G, seat, move);
  moves++;
  if (r.ok) {
    if (move.kind === 'use') kinds[move._kind] = (kinds[move._kind] || 0) + 1;
    check(G);
  } else refused++;
  return r.ok;
}

// A player who does any legal-looking thing at random; the engine refuses
// what does not fit, and that is counted, not a problem.
function randomMove(G, p) {
  const active = G.players[G.turn] === p;
  const uses = M.usable(G, p);
  const yard = M.yardIds(G);
  const board = [];
  for (const s of M.SECTORS) {
    board.push(p.station[s]);
    board.push(...p.deployed[s]);
  }
  const useMove = (u) => {
    const ab = M.CARDS[u.id][u.side].ab;
    const m = { kind: 'use', card: u.id, _kind: ab.kind };
    if (ab.kind === 'setdie') m.value = 1 + Math.floor(Math.random() * 6);
    if (ab.kind === 'reroll') m.dice = pick([[0], [1], [0, 1]]);
    if (ab.kind === 'buy') {
      m.cards = Math.random() < 0.8 ? [pick([...yard, ...G.colonies])] : [];
      if (ab.n > 1 && Math.random() < 0.4) m.cards.push(pick(yard));
      if (ab.high) m.sector = 6 + Math.floor(Math.random() * 7);
    }
    if (ab.kind === 'claim') m.cards = yard.filter(() => Math.random() < 0.3).slice(0, 3);
    if (ab.kind === 'place') {
      m.target = pick(board);
      if (ab.move && Math.random() < 0.6) { m.from = pick(board); m.to = pick(board); }
    }
    if (ab.kind === 'exchange') m.target = pick(board);
    return m;
  };
  switch (G.phase) {
    case 'light': {
      const offer = G.light[p.seat].offer;
      return { kind: 'lightspeed', cards: offer.filter(() => Math.random() < 0.4) };
    }
    case 'roll':
      if (active) {
        if (uses.length && Math.random() < 0.5) return useMove(pick(uses));
        return { kind: 'roll' };
      }
      return uses.length && Math.random() < 0.3 ? useMove(pick(uses)) : null;
    case 'reroll':
      if (!active) return null;
      if (uses.length && Math.random() < 0.6) return useMove(pick(uses));
      return { kind: 'keep' };
    case 'alloc': {
      const a = G.alloc[p.seat];
      if (a.pick != null) return null;
      return { kind: 'alloc', pick: Math.floor(Math.random() * a.options.length) };
    }
    case 'claim':
      if (!active) return null;
      return { kind: 'claim', cards: M.claimable(G, p).filter(() => Math.random() < 0.5).slice(0, 2) };
    case 'buy': {
      if (!active) return uses.length && Math.random() < 0.3 ? useMove(pick(uses)) : null;
      if (uses.length && Math.random() < 0.5) return useMove(pick(uses));
      const can = M.buyable(G, p);
      if (!G.bought && can.length && Math.random() < 0.6) return { kind: 'buy', card: pick(can) };
      if (Math.random() < 0.1) return { kind: 'buy', card: pick([...yard, ...G.colonies]) };
      return { kind: 'end' };
    }
    default:
      return null;
  }
}

const SIZES = [2, 3, 4, 5];
for (const n of SIZES) {
  for (const lightspeed of [false, true]) {
    for (let k = 0; k < 30; k++) {
      // a table of bots and random players, in every mix
      const randoms = new Set(SIZES.slice(0, n).map((_, i) => i).filter(() => Math.random() < 0.5));
      const G = M.newGame(Array.from({ length: n }, (_, i) => ({ seat: i, name: `P${i}`, bot: !randoms.has(i) })), { lightspeed });
      games++;
      check(G);
      let guard = 0;
      while (G.phase !== 'over' && guard++ < 6000) {
        // anyone may act aside: a bot's Armstrong, a random player's whim
        let acted = false;
        for (const p of G.players) {
          if (randoms.has(p.seat)) {
            if (Math.random() < 0.05) {
              const m = randomMove(G, p);
              if (m && m.kind === 'use') { play(G, p.seat, m); acted = true; break; }
            }
          } else {
            const m = M.botAsideMove(G, p.seat);
            if (m) { m._kind = 'win'; play(G, p.seat, m); acted = true; break; }
          }
        }
        if (acted) continue;
        const waiting = M.waitingOn(G);
        if (!waiting.length) { bad(`nobody to wait on in ${G.phase}`); break; }
        const seat = pick(waiting);
        const p = M.playerBySeat(G, seat);
        let m = randoms.has(seat) ? randomMove(G, p) : M.botChoose(G, seat);
        if (!m) { bad(`no move for seat ${seat} in ${G.phase}`); break; }
        if (!randoms.has(seat) && m.kind === 'use') m._kind = M.CARDS[m.card][where(p, m.card).side].ab.kind;
        const okd = play(G, seat, m);
        if (!okd && !randoms.has(seat)) bad(`a bot's move refused: ${JSON.stringify(m)} in ${G.phase}: ${M.applyMove(G, seat, m).error}`);
        // a random player whose move is refused still has to get on with it
        if (!okd && randoms.has(seat)) {
          const fallback = { light: { kind: 'lightspeed', cards: [] }, roll: { kind: 'roll' }, reroll: { kind: 'keep' }, claim: { kind: 'claim', cards: [] }, buy: { kind: 'end' } }[G.phase];
          if (fallback && (G.phase === 'light' || G.players[G.turn] === p)) play(G, seat, fallback);
        }
      }
      if (G.phase !== 'over') bad(`a game of ${n} never ended (${G.phase}, round ${G.round})`);
      else if (!G.winners || !G.winners.length) bad('a game ended with no winner');
      else if (/outright/.test(G.why)) overs.win++;
      else if (G.winners.length > 1) overs.shared++;
      else overs.vp++;
    }
  }
}

console.log(`${games} games, ${moves} moves (${refused} refused, as random players will be). Ended on VP ${overs.vp}, by the Armstrong ${overs.win}, shared ${overs.shared}.`);
console.log(`Abilities used: ${Object.entries(kinds).sort().map(([k, v]) => `${k} ${v}`).join(', ')}.`);
console.log(problems ? `${problems} PROBLEMS` : 'no problems');
process.exit(problems ? 1 : 0);
