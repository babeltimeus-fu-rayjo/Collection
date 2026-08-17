// game.js — DNUP rules engine. Pure logic, no DOM: the host runs it
// authoritatively, guests import it only to compute which cards are legal.

export const PROTO = 1; // bump when the message protocol changes

export const COLORS = ['red', 'amber', 'teal', 'violet'];
// Each color gets a shape so the game stays readable for colorblind players.
export const GLYPHS = { red: '▲', amber: '◆', teal: '●', violet: '■' };

export const HAND_SIZE = 7;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 5;

// 4 colors × ranks 1–10 × 2 copies = 80 cards.
export function buildDeck() {
  const deck = [];
  for (const color of COLORS) {
    for (let rank = 1; rank <= 10; rank++) {
      for (let copy = 0; copy < 2; copy++) {
        deck.push({ id: `${color[0]}${rank}-${copy}`, color, rank });
      }
    }
  }
  return deck;
}

export function shuffled(cards) {
  const a = cards.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const flip = (dir) => (dir === 'up' ? 'down' : 'up');

// A card is playable if it follows the direction (strictly higher when UP,
// strictly lower when DOWN), matches the top card's color, or matches its rank.
export function isLegal(card, top, dir) {
  if (!top) return true;
  if (card.color === top.color || card.rank === top.rank) return true;
  return dir === 'up' ? card.rank > top.rank : card.rank < top.rank;
}

// Direction after a play: a rank match flips it, then the extremes override —
// a 10 always points the game DOWN, a 1 always points it UP.
export function dirAfter(card, top, dir) {
  let d = dir;
  if (top && card.rank === top.rank) d = flip(d);
  if (card.rank === 10) d = 'down';
  else if (card.rank === 1) d = 'up';
  return d;
}

export function fmtCard(card) {
  return `${GLYPHS[card.color]}${card.rank}`;
}

function note(G, text) {
  G.feed.push(text);
  if (G.feed.length > 8) G.feed.shift();
}

const bySeat = (G, seat) => G.players.find((p) => p.seat === seat);
const alive = (G) => G.players.filter((p) => !p.finished && p.connected);

// roster: [{ seat, name, connected }]
export function newGame(roster) {
  const deck = shuffled(buildDeck());
  const players = roster.map((p) => ({
    seat: p.seat,
    name: p.name,
    bot: !!p.bot,
    connected: p.connected !== false,
    hand: [],
    finished: false,
  }));
  for (let i = 0; i < HAND_SIZE; i++) for (const p of players) p.hand.push(deck.pop());
  const top = deck.pop();
  const G = {
    phase: 'playing',
    players,
    deck,
    discard: [],
    top,
    dir: top.rank === 10 ? 'down' : 'up',
    turn: players[Math.floor(Math.random() * players.length)].seat,
    passStreak: 0,
    winner: null,
    stalemate: false,
    forfeit: false,
    feed: [],
    fx: null,
    fxSeq: 0,
  };
  note(G, `First card is ${fmtCard(top)} — direction ${G.dir.toUpperCase()}.`);
  note(G, `${bySeat(G, G.turn).name} goes first.`);
  return G;
}

// Ends the round when fewer than two live players remain. Returns true if over.
function endIfDepleted(G) {
  if (G.phase !== 'playing') return true;
  const active = alive(G);
  if (active.length === 0) {
    G.phase = 'over';
    G.stalemate = true;
    return true;
  }
  if (active.length === 1 && G.players.length > 1) {
    G.phase = 'over';
    G.winner = active[0].seat;
    G.forfeit = true;
    note(G, `${active[0].name} wins by default — everyone else left.`);
    return true;
  }
  return false;
}

export function advanceTurn(G) {
  if (endIfDepleted(G)) return;
  const order = G.players.map((p) => p.seat).sort((a, b) => a - b);
  const i = order.indexOf(G.turn);
  for (let k = 1; k <= order.length; k++) {
    const s = order[(i + k) % order.length];
    const p = bySeat(G, s);
    if (!p.finished && p.connected) {
      G.turn = s;
      return;
    }
  }
}

export function markDisconnected(G, seat) {
  const p = bySeat(G, seat);
  if (!p || !p.connected) return false;
  p.connected = false;
  note(G, `${p.name} disconnected.`);
  if (G.phase === 'playing') {
    if (G.turn === seat) advanceTurn(G);
    else endIfDepleted(G);
  }
  return true;
}

export function applyMove(G, seat, move) {
  if (G.phase !== 'playing') return { ok: false, error: 'The round is over.' };
  if (G.turn !== seat) return { ok: false, error: 'Not your turn.' };
  const p = bySeat(G, seat);
  if (!p) return { ok: false, error: 'Unknown player.' };

  if (move && move.kind === 'play') {
    const i = p.hand.findIndex((c) => c.id === move.cardId);
    if (i < 0) return { ok: false, error: 'You do not have that card.' };
    const card = p.hand[i];
    if (!isLegal(card, G.top, G.dir)) return { ok: false, error: 'That card cannot be played right now.' };
    p.hand.splice(i, 1);
    const before = G.dir;
    G.dir = dirAfter(card, G.top, G.dir);
    G.discard.push(G.top);
    G.top = card;
    G.passStreak = 0;
    const flipped = G.dir !== before;
    G.fx = { seq: ++G.fxSeq, kind: 'play', seat, card, flipped, dnup: p.hand.length === 1 };
    note(G, `${p.name} played ${fmtCard(card)}${flipped ? ` — now going ${G.dir.toUpperCase()}` : ''}.`);
    if (p.hand.length === 1) note(G, `${p.name} calls DNUP!`);
    if (p.hand.length === 0) {
      p.finished = true;
      G.phase = 'over';
      G.winner = seat;
      note(G, `${p.name} wins!`);
      return { ok: true };
    }
    advanceTurn(G);
    return { ok: true };
  }

  if (move && move.kind === 'draw') {
    if (G.deck.length === 0 && G.discard.length > 0) {
      G.deck = shuffled(G.discard);
      G.discard = [];
      note(G, 'Discards shuffled back into the draw pile.');
    }
    if (G.deck.length > 0) {
      p.hand.push(G.deck.pop());
      G.passStreak = 0;
      G.fx = { seq: ++G.fxSeq, kind: 'draw', seat };
      note(G, `${p.name} drew a card.`);
    } else {
      G.passStreak++;
      G.fx = { seq: ++G.fxSeq, kind: 'pass', seat };
      note(G, `${p.name} passed.`);
    }
    advanceTurn(G);
    if (
      G.phase === 'playing' &&
      G.deck.length === 0 &&
      G.discard.length === 0 &&
      G.passStreak >= alive(G).length
    ) {
      G.phase = 'over';
      G.stalemate = true;
      note(G, 'Deadlock — fewest cards wins.');
    }
    return { ok: true };
  }

  return { ok: false, error: 'Unknown move.' };
}

export function ranking(G) {
  return G.players
    .slice()
    .sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.hand.length !== b.hand.length) return a.hand.length - b.hand.length;
      return a.seat - b.seat;
    })
    .map((p) => ({ seat: p.seat, name: p.name, bot: !!p.bot, cardsLeft: p.hand.length, connected: p.connected }));
}

// Pick a move for a bot. One-ply lookahead: prefer the legal card that leaves
// the most playable follow-ups in hand; tie-break by shedding the card that is
// hardest to play later (low ranks while UP, high ranks while DOWN).
export function botChoose(G, seat) {
  const p = bySeat(G, seat);
  if (!p) return { kind: 'draw' };
  const legal = p.hand.filter((c) => isLegal(c, G.top, G.dir));
  if (!legal.length) return { kind: 'draw' };
  let best = legal[0];
  let bestScore = -Infinity;
  for (const card of legal) {
    const nextDir = dirAfter(card, G.top, G.dir);
    const followups = p.hand.filter((c) => c.id !== card.id && isLegal(c, card, nextDir)).length;
    const shed = G.dir === 'up' ? 10 - card.rank : card.rank;
    const score = followups * 2 + shed / 10 + Math.random() * 0.01;
    if (score > bestScore) {
      bestScore = score;
      best = card;
    }
  }
  return { kind: 'play', cardId: best.id };
}

// Personalized snapshot: public info about everyone, plus this seat's own hand.
export function viewFor(G, seat, code) {
  const me = bySeat(G, seat);
  const myTurn = G.phase === 'playing' && G.turn === seat;
  return {
    code,
    you: seat,
    phase: G.phase,
    turn: G.turn,
    dir: G.dir,
    top: G.top,
    drawCount: G.deck.length,
    players: G.players.map((p) => ({
      seat: p.seat,
      name: p.name,
      bot: !!p.bot,
      handCount: p.hand.length,
      connected: p.connected,
      finished: p.finished,
    })),
    hand: me ? me.hand : [],
    legal: myTurn && me ? me.hand.filter((c) => isLegal(c, G.top, G.dir)).map((c) => c.id) : [],
    winner: G.winner,
    stalemate: G.stalemate,
    forfeit: G.forfeit,
    ranking: G.phase === 'over' ? ranking(G) : null,
    feed: G.feed.slice(-6),
    fx: G.fx,
  };
}
