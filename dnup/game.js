// game.js — DNUP rules engine, implementing the official rules
// (Kei Kajino & Gilles-Romain Fonteny, © Asmodee Group — see dnup.game/rules).
// Pure logic, no DOM. The host runs it authoritatively; guests import it only
// for the shared legality helpers.
//
// Cards are double-ended: an active value (as held) and an inactive value
// (upside down). Rotating a card 180° — "a dnup" — swaps them. Cards taken
// from the table are ALWAYS rotated as they enter a hand (the golden rule).
//
// The 40-card manifest below is the real one, transcribed from the physical
// deck: 26 base cards, plus 4 added at 3+ players, 6 more at 4+, 4 more at 5.
// All cards are always dealt out, so hands are 13 / 10 / 9 / 8 cards at
// 2 / 3 / 4 / 5 players. High values are deliberately scarce (three 10s, five
// 9s in the whole deck) and no card pairs two high values together.

export const PROTO = 2;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 5;
export const TARGET_POINTS = 4; // standard (3-5p): first to 4+ points wins
export const TARGET_ROUNDS = 2; // duel (2p): first to 2 round wins

// [sideA, sideB] value pairs. base: always used; g3/g4/g5: added at 3+/4+/5
// players. Some pairings repeat (e.g. two 1/6 cards) — ids get an index.
const DECK_BASE = [
  [1, 5], [1, 6], [1, 6], [1, 7], [1, 7], [1, 8], [1, 9],
  [2, 4], [2, 4], [2, 5], [2, 5], [2, 6], [2, 9], [2, 10],
  [3, 4], [3, 5], [3, 6], [3, 7], [3, 8], [3, 9],
  [4, 6], [4, 7], [4, 8], [5, 7], [5, 8], [6, 7],
];
const DECK_G3 = [[1, 10], [2, 8], [3, 6], [4, 5]];
const DECK_G4 = [[1, 8], [1, 9], [2, 6], [2, 7], [3, 4], [3, 5]];
const DECK_G5 = [[3, 10], [4, 9], [5, 8], [6, 7]];

export function buildDeck(playerCount) {
  const groups = [
    [DECK_BASE, ''],
    [DECK_G3, '3'],
    [DECK_G4, '4'],
    [DECK_G5, '5'],
  ].slice(0, playerCount >= 5 ? 4 : playerCount - 1);
  const deck = [];
  let n = 0;
  for (const [pairs, sym] of groups) {
    for (const [a, b] of pairs) {
      deck.push({ id: `c${n++}-${a}-${b}`, a, b, sym, star: a === 1 && b === 5 });
    }
  }
  return deck; // 26 / 30 / 36 / 40 cards -> hands of 13 / 10 / 9 / 8
}

export function shuffled(cards) {
  const arr = cards.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export const activeVal = (c) => (c.flip ? c.b : c.a);
export const inactiveVal = (c) => (c.flip ? c.a : c.b);

// ------------------------------------------------------------ shared helpers
// These operate on plain data so guests can run them on view snapshots.

// Flatten all sets on the table: [{owner, area, value, size, cards}]
export function flatSets(players) {
  const sets = [];
  for (const p of players) {
    (p.areas || []).forEach((s, area) => {
      if (s) sets.push({ owner: p.seat, area, value: s.value, size: s.cards.length, cards: s.cards });
    });
  }
  return sets;
}

// Action A: a set of `size` cards of `value` may be played iff no same-size
// set of equal-or-higher value is on the table.
export function playConflict(sets, size, value) {
  const other = sets.find((s) => s.size === size);
  if (!other) return { ok: true, bounce: null };
  if (other.value >= value) return { ok: false, bounce: null };
  return { ok: true, bounce: other };
}

// Action B: one card may be added to an opponent set iff the card's active
// value matches the set's value, and the grown set doesn't tie/lose against
// another set of its new size.
export function addConflict(sets, target, cardValue) {
  if (cardValue !== target.value) return { ok: false, bounce: null };
  const grown = target.size + 1;
  const other = sets.find((s) => !(s.owner === target.owner && s.area === target.area) && s.size === grown);
  if (!other) return { ok: true, bounce: null };
  if (other.value >= target.value) return { ok: false, bounce: null };
  return { ok: true, bounce: other };
}

export function groupByValue(hand) {
  const m = new Map();
  for (const c of hand) {
    const v = activeVal(c);
    if (!m.has(v)) m.set(v, []);
    m.get(v).push(c);
  }
  return m;
}

// ------------------------------------------------------------ game state

function note(G, text) {
  G.feed.push(text);
  if (G.feed.length > 9) G.feed.shift();
}

const bySeat = (G, seat) => G.players.find((p) => p.seat === seat);

export function setLabel(s) {
  const size = s.cards ? s.cards.length : s.size;
  return size === 1 ? `a ${s.value}` : `${size}×${s.value}`;
}

// roster: [{seat, name, bot, connected}]
export function newMatch(roster) {
  const G = {
    mode: roster.length === 2 ? 'duel' : 'standard',
    phase: 'playing',
    players: roster.map((p) => ({
      seat: p.seat,
      name: p.name,
      bot: !!p.bot,
      connected: p.connected !== false,
      hand: [],
      areas: roster.length === 2 ? [null, null] : [null],
      points: 0,
      rounds: 0,
      out: false,
    })),
    round: 0,
    turn: { seat: 0, area: 0 },
    starterSeat: 0,
    discardCount: 0,
    firstOut: null,
    secondOut: null,
    roundResult: null,
    winner: null,
    unitCount: 0,
    feed: [],
    fx: null,
    fxSeq: 0,
  };
  dealRound(G);
  return G;
}

export function dealRound(G) {
  G.round++;
  G.phase = 'playing';
  G.firstOut = null;
  G.secondOut = null;
  G.roundResult = null;
  G.discardCount = 0;
  G.unitCount = 0;
  const deck = shuffled(buildDeck(G.players.length)).map((c) => ({
    ...c,
    flip: Math.random() < 0.5,
  }));
  for (const p of G.players) {
    p.hand = [];
    p.areas = p.areas.map(() => null);
    p.out = false;
  }
  let i = 0;
  while (deck.length) G.players[i++ % G.players.length].hand.push(deck.pop());
  const starter = G.players.find((p) => p.hand.some((c) => c.star)) || G.players[0];
  G.starterSeat = starter.seat;
  // Duel exception: the starter's first go is a single turn at Play Area 2.
  G.turn = { seat: starter.seat, area: G.mode === 'duel' ? 1 : 0 };
  note(G, `Round ${G.round} — ${starter.name} holds the ★ 1/5 and starts.`);
}

function nextUnit(G, seat, area) {
  const seats = G.players.map((p) => p.seat).sort((a, b) => a - b);
  if (G.mode === 'duel' && area === 0) return { seat, area: 1 };
  const other = seats[(seats.indexOf(seat) + 1) % seats.length];
  return { seat: other, area: 0 };
}

function discardArea(G, p, areaIdx) {
  const s = p.areas[areaIdx];
  if (s) {
    G.discardCount += s.cards.length;
    p.areas[areaIdx] = null;
  }
  return s;
}

// Move to the next actionable unit, performing turn-entry housekeeping:
// players discard the set in the area they are about to play from; players who
// are out (or gone) have their lingering sets discarded and are skipped.
export function advanceTurn(G) {
  if (G.phase !== 'playing') return;
  let { seat, area } = G.turn;
  for (let guard = 0; guard < 24; guard++) {
    ({ seat, area } = nextUnit(G, seat, area));
    const p = bySeat(G, seat);
    if (p.out || !p.connected) {
      let had = false;
      p.areas.forEach((s, i) => {
        if (s) {
          discardArea(G, p, i);
          had = true;
        }
      });
      if (had) note(G, `${p.name}'s remaining set is discarded.`);
      continue;
    }
    const s = discardArea(G, p, area);
    if (s) note(G, `${p.name} discards ${setLabel(s)}.`);
    G.turn = { seat, area };
    return;
  }
  // No one can act (everyone out or disconnected): close the game out.
  G.phase = 'over';
  const best = G.players.slice().sort((a, b) => b.points - a.points || b.rounds - a.rounds)[0];
  G.winner = best ? best.seat : null;
  note(G, 'No one left to act — the game ends.');
}

// A beaten or grown-past set leaves the table: back to its owner's hand
// (rotated — a dnup!), or straight to the discard pile if the owner is out.
function bounceSet(G, ref) {
  const owner = bySeat(G, ref.owner);
  const s = owner.areas[ref.area];
  if (!s) return;
  owner.areas[ref.area] = null;
  if (owner.out || !owner.connected) {
    G.discardCount += s.cards.length;
    note(G, `${owner.name}'s ${setLabel(s)} is beaten and discarded.`);
  } else {
    for (const c of s.cards) {
      c.flip = !c.flip;
      owner.hand.push(c);
    }
    note(G, `${owner.name} takes back ${setLabel(s)} rotated — dnup!`);
  }
}

function afterAction(G, p) {
  if (p.hand.length === 0) {
    if (G.mode === 'duel') {
      p.rounds += 1;
      note(G, `${p.name} empties their hand and wins round ${G.round}!`);
      G.roundResult = { kind: 'duel', winner: p.seat };
      if (p.rounds >= TARGET_ROUNDS) {
        G.phase = 'over';
        G.winner = p.seat;
        note(G, `${p.name} wins the game!`);
      } else {
        G.phase = 'roundEnd';
      }
      return;
    }
    if (G.firstOut == null) {
      G.firstOut = p.seat;
      p.out = true;
      p.points += 2;
      note(G, `${p.name} goes out first — +2 points!`);
      G.fx = { seq: ++G.fxSeq, kind: 'out', seat: p.seat };
      if (p.points >= TARGET_POINTS) {
        G.phase = 'over';
        G.winner = p.seat;
        note(G, `${p.name} reaches ${p.points} points and wins the game!`);
        return;
      }
    } else {
      G.secondOut = p.seat;
      p.out = true;
      p.points += 1;
      note(G, `${p.name} goes out second — +1 point. Round over!`);
      G.roundResult = { kind: 'standard', first: G.firstOut, second: p.seat };
      if (p.points >= TARGET_POINTS) {
        G.phase = 'over';
        G.winner = p.seat;
        note(G, `${p.name} reaches ${p.points} points and wins the game!`);
      } else {
        const leader = G.players.find((q) => q.points >= TARGET_POINTS);
        if (leader) {
          G.phase = 'over';
          G.winner = leader.seat;
        } else {
          G.phase = 'roundEnd';
        }
      }
      return;
    }
  }
  // Safety valve: a theoretically endless round (everyone rotating forever)
  // gets redealt. Unreachable in normal play.
  if (++G.unitCount > 600) {
    G.roundResult = { kind: 'stall' };
    G.phase = 'roundEnd';
    note(G, 'The round stalls — cards are redealt.');
    return;
  }
  advanceTurn(G);
}

export function applyMove(G, seat, move) {
  if (G.phase !== 'playing') return { ok: false, error: 'The round is over.' };
  if (G.turn.seat !== seat) return { ok: false, error: 'Not your turn.' };
  const p = bySeat(G, seat);
  if (!p) return { ok: false, error: 'Unknown player.' };
  const sets = flatSets(G.players);
  const areaIdx = G.turn.area;

  if (move && move.kind === 'play') {
    const ids = Array.isArray(move.cardIds) ? [...new Set(move.cardIds)] : [];
    if (!ids.length) return { ok: false, error: 'Select at least one card.' };
    const cards = ids.map((id) => p.hand.find((c) => c.id === id));
    if (cards.some((c) => !c)) return { ok: false, error: 'You do not have those cards.' };
    const v = activeVal(cards[0]);
    if (cards.some((c) => activeVal(c) !== v)) {
      return { ok: false, error: 'A set must be cards of one value.' };
    }
    const verdict = playConflict(sets, cards.length, v);
    if (!verdict.ok) {
      return { ok: false, error: `A set of ${cards.length} needs a value above ${sets.find((s) => s.size === cards.length).value}.` };
    }
    note(G, `${p.name} plays ${setLabel({ value: v, size: cards.length })}.`);
    if (verdict.bounce) bounceSet(G, verdict.bounce);
    p.hand = p.hand.filter((c) => !ids.includes(c.id));
    p.areas[areaIdx] = { value: v, cards };
    G.fx = { seq: ++G.fxSeq, kind: 'play', seat, area: areaIdx, bounced: !!verdict.bounce };
    afterAction(G, p);
    return { ok: true };
  }

  if (move && move.kind === 'add') {
    const t = move.target || {};
    if (t.seat === seat) return { ok: false, error: 'You can only add to an opponent’s set.' };
    const tp = bySeat(G, t.seat);
    const target = tp && tp.areas[t.area];
    if (!target) return { ok: false, error: 'That set is gone.' };
    const card = p.hand.find((c) => c.id === move.cardId);
    if (!card) return { ok: false, error: 'You do not have that card.' };
    const ref = { owner: t.seat, area: t.area, value: target.value, size: target.cards.length };
    const verdict = addConflict(sets, ref, activeVal(card));
    if (!verdict.ok) {
      return {
        ok: false,
        error: activeVal(card) !== target.value
          ? 'The card must match the set’s value.'
          : 'Growing that set would tie or lose against a same-size set.',
      };
    }
    note(G, `${p.name} adds a ${activeVal(card)} to ${tp.name}'s set.`);
    if (verdict.bounce) bounceSet(G, verdict.bounce);
    p.hand = p.hand.filter((c) => c.id !== card.id);
    target.cards.push(card);
    G.fx = { seq: ++G.fxSeq, kind: 'add', seat, targetSeat: t.seat, area: t.area, bounced: !!verdict.bounce };
    afterAction(G, p);
    return { ok: true };
  }

  if (move && move.kind === 'take') {
    const t = move.target || {};
    if (t.seat === seat) return { ok: false, error: 'You can only take an opponent’s set.' };
    const tp = bySeat(G, t.seat);
    const target = tp && tp.areas[t.area];
    if (!target) return { ok: false, error: 'That set is gone.' };
    tp.areas[t.area] = null;
    for (const c of target.cards) {
      c.flip = !c.flip;
      p.hand.push(c);
    }
    G.fx = { seq: ++G.fxSeq, kind: 'take', seat, targetSeat: t.seat };
    note(G, `${p.name} takes ${tp.name}'s ${setLabel(target)} rotated — dnup!`);
    afterAction(G, p);
    return { ok: true };
  }

  if (move && move.kind === 'rotate') {
    for (const c of p.hand) c.flip = !c.flip;
    G.fx = { seq: ++G.fxSeq, kind: 'rotate', seat };
    note(G, `${p.name} rotates their whole hand — dnup!`);
    afterAction(G, p);
    return { ok: true };
  }

  return { ok: false, error: 'Unknown move.' };
}

export function markDisconnected(G, seat) {
  const p = bySeat(G, seat);
  if (!p || !p.connected) return false;
  p.connected = false;
  note(G, `${p.name} disconnected.`);
  if (G.phase !== 'playing') return true;
  const live = G.players.filter((q) => q.connected);
  if (live.length === 1) {
    G.phase = 'over';
    G.winner = live[0].seat;
    G.roundResult = { kind: 'forfeit' };
    note(G, `${live[0].name} wins — everyone else left.`);
    return true;
  }
  if (G.turn.seat === seat) advanceTurn(G);
  return true;
}

// Standings: game winner first, then by points/rounds, fewest cards last tiebreak.
export function ranking(G) {
  return G.players
    .slice()
    .sort((a, b) => {
      if ((G.winner === a.seat) !== (G.winner === b.seat)) return G.winner === a.seat ? -1 : 1;
      if (a.points !== b.points) return b.points - a.points;
      if (a.rounds !== b.rounds) return b.rounds - a.rounds;
      if (a.hand.length !== b.hand.length) return a.hand.length - b.hand.length;
      return a.seat - b.seat;
    })
    .map((p) => ({
      seat: p.seat,
      name: p.name,
      bot: p.bot,
      points: p.points,
      rounds: p.rounds,
      cardsLeft: p.hand.length,
      connected: p.connected,
    }));
}

// ------------------------------------------------------------ bot brain

function maxGroupSize(hand) {
  let best = 0;
  for (const cards of groupByValue(hand).values()) best = Math.max(best, cards.length);
  return best;
}

export function botChoose(G, seat) {
  const p = bySeat(G, seat);
  if (!p) return { kind: 'rotate' };
  const sets = flatSets(G.players);
  const options = [];

  for (const [v, cards] of groupByValue(p.hand)) {
    for (let size = 1; size <= cards.length; size++) {
      const verdict = playConflict(sets, size, v);
      if (!verdict.ok) continue;
      let score = size * 12 + v * 0.4 + (size === cards.length ? 2 : 0) + (verdict.bounce ? 6 : 0);
      if (p.hand.length === size) score = 1000; // winning move
      options.push({ score, move: { kind: 'play', cardIds: cards.slice(0, size).map((c) => c.id) } });
    }
  }

  for (const st of sets) {
    if (st.owner === seat) continue;
    for (const c of p.hand) {
      const verdict = addConflict(sets, st, activeVal(c));
      if (!verdict.ok) continue;
      let score = 20 + (verdict.bounce ? 10 : 0);
      if (p.hand.length === 1) score = 1000; // winning move
      options.push({ score, move: { kind: 'add', cardId: c.id, target: { seat: st.owner, area: st.area } } });
      break; // one candidate card per set is enough
    }
  }

  const curMax = maxGroupSize(p.hand);
  if (p.hand.length <= 6) {
    for (const st of sets) {
      if (st.owner === seat) continue;
      const virtual = p.hand.concat(st.cards.map((c) => ({ ...c, flip: !c.flip })));
      const gain = maxGroupSize(virtual) - curMax;
      if (gain >= 2) {
        options.push({ score: 16 + gain * 4 - st.size * 2, move: { kind: 'take', target: { seat: st.owner, area: st.area } } });
      }
    }
  }

  const rotGain = maxGroupSize(p.hand.map((c) => ({ ...c, flip: !c.flip }))) - curMax;
  options.push({ score: 5 + Math.max(0, rotGain) * 5, move: { kind: 'rotate' } });

  let best = options[0];
  for (const o of options) if (o.score + Math.random() * 2 > best.score) best = o;
  return best.move;
}

// ------------------------------------------------------------ views

// Personalized snapshot: everything public (all table sets, both faces of
// table cards, counts, scores) plus this seat's own hand.
export function viewFor(G, seat, code) {
  const me = bySeat(G, seat);
  return {
    code,
    you: seat,
    mode: G.mode,
    phase: G.phase,
    round: G.round,
    targetPoints: TARGET_POINTS,
    targetRounds: TARGET_ROUNDS,
    turn: G.turn,
    starterSeat: G.starterSeat,
    discardCount: G.discardCount,
    players: G.players.map((p) => ({
      seat: p.seat,
      name: p.name,
      bot: p.bot,
      connected: p.connected,
      out: p.out,
      points: p.points,
      rounds: p.rounds,
      handCount: p.hand.length,
      areas: p.areas.map((s) =>
        s
          ? {
              value: s.value,
              size: s.cards.length,
              cards: s.cards.map((c) => ({ a: c.a, b: c.b, flip: c.flip, star: c.star })),
            }
          : null,
      ),
    })),
    hand: me ? me.hand.map((c) => ({ ...c })) : [],
    firstOut: G.firstOut,
    winner: G.winner,
    roundResult: G.roundResult,
    ranking: G.phase === 'over' || G.phase === 'roundEnd' ? ranking(G) : null,
    feed: G.feed.slice(-7),
    fx: G.fx,
  };
}
