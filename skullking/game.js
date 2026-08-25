// game.js — Skull King rules engine (pure logic, no DOM, no network).
//
// An unofficial fan implementation of Skull King by Brent Beck
// (© Grandpa Beck's Games). Rules follow the official rule sheet:
//   - 10 rounds; round N deals N cards. Everyone secretly bids the number of
//     tricks they'll win, then bids are revealed together.
//   - 4 suits 1-14; black (Jolly Roger) outranks the other three but obeys
//     the same follow-suit duty. Specials may be played at any time.
//   - Pirates beat numbers, the Skull King beats pirates, and a Mermaid
//     beats the Skull King — if all three are in one trick, the mermaid wins.
//     First-played wins among equal specials. Escapes never win, except an
//     all-escape trick, which the first card takes.
//   - Lead rules: a number lead sets the suit; a pirate/mermaid/Skull King
//     lead frees the whole trick; an escape lead passes suit-setting on.
//   - Scoring: exact bid ≥1 → +20/trick; miss → −10 per trick off; a zero
//     bid pays ±10 × the round number. Bonuses only with an exact bid:
//     captured 14s +10 (black +20), Skull King +30 per pirate played before
//     him, a mermaid capturing the Skull King +50.
//   - Deck: the modern 70-card deck (mermaids included). The Legendary
//     expansion menu (Loot, Kraken, White Whale) is not implemented.

export const PROTO = 2;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
export const ROUNDS = 10;

// Official scoring systems, selectable when creating a room:
//   classic    — Skull King's scoring from the rule sheet (the default).
//   rascal     — The Rascal's Scoring: every round has the same potential,
//                10 points per card dealt; an exact bid earns all of it (and
//                all bonuses), off-by-one earns half of both, off by 2+ earns
//                nothing. No negative scores.
//   cannonball — the rulebook's high-stakes Rascal variant: 15 points per
//                card dealt and full bonuses, but ONLY on an exact bid;
//                off by even one earns nothing.
export const SCORING = [
  {
    key: 'classic',
    name: "Skull King's scoring",
    blurb: 'The classic: +20 per trick on an exact bid, −10 per trick off. Zero bids pay ±10 × the cards dealt. Bonuses only on exact bids.',
  },
  {
    key: 'rascal',
    name: "The Rascal's scoring",
    blurb: 'Even-keeled: every round is worth 10 × the cards dealt, whatever you bid. Exact = all of it, off-by-one = half (bonuses too), off by 2+ = nothing. Never negative.',
  },
  {
    key: 'cannonball',
    name: 'Cannonball',
    blurb: 'All or nothing: 15 × the cards dealt plus full bonuses on an exact bid — and zero if you are off, even by one.',
  },
];

export function scoringByKey(key) {
  return SCORING.find((s) => s.key === key) || SCORING[0];
}

export const SUITS = ['green', 'yellow', 'purple', 'black'];

export const SUIT_META = {
  green: { name: 'Parrot', short: 'green' },
  yellow: { name: 'Chest', short: 'yellow' },
  purple: { name: 'Map', short: 'purple' },
  black: { name: 'Jolly Roger', short: 'black' },
};

export const KIND_META = {
  pirate: { name: 'Pirate', icon: '⚔' },
  escape: { name: 'Escape', icon: '🏳' },
  sk: { name: 'Skull King', icon: '☠' },
  mermaid: { name: 'Mermaid', icon: '🧜' },
  tigress: { name: 'Tigress', icon: '🐯' },
};

export function buildDeck() {
  const deck = [];
  let id = 1;
  for (const suit of SUITS) {
    for (let v = 1; v <= 14; v++) deck.push({ id: id++, kind: 'num', suit, v });
  }
  for (let i = 0; i < 5; i++) deck.push({ id: id++, kind: 'pirate' });
  for (let i = 0; i < 5; i++) deck.push({ id: id++, kind: 'escape' });
  for (let i = 0; i < 2; i++) deck.push({ id: id++, kind: 'mermaid' });
  deck.push({ id: id++, kind: 'sk' });
  deck.push({ id: id++, kind: 'tigress' });
  return deck;
}

export function cardLabel(card, as) {
  if (!card) return '?';
  if (card.kind === 'num') return `${SUIT_META[card.suit].short} ${card.v}`;
  if (card.kind === 'tigress') return `Tigress${as ? ` (as ${as === 'pirate' ? 'Pirate' : 'Escape'})` : ''}`;
  return KIND_META[card.kind].name;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function playerBySeat(G, seat) {
  return G.players.find((p) => p.seat === seat);
}

function addLog(G, text) {
  G.feedSeq += 1;
  G.log.push({ n: G.feedSeq, text });
  if (G.log.length > 250) G.log.shift();
}

function setFx(G, fx) {
  G.fxSeq += 1;
  G.fx = { seq: G.fxSeq, ...fx };
}

// effective kind of a played card (the Tigress becomes what was declared)
function effKind(play) {
  if (play.card.kind === 'tigress') return play.as === 'pirate' ? 'pirate' : 'escape';
  return play.card.kind;
}

// ---------------------------------------------------------------- setup

export function newMatch(roster, scoringKey) {
  const players = roster
    .map((r) => ({
      seat: r.seat,
      name: r.name,
      bot: !!r.bot,
      connected: r.connected !== false,
      hand: [],
      bid: null,
      tricksWon: 0,
      captured: [],
      score: 0,
      history: [],
      lastAction: null,
    }))
    .sort((a, b) => a.seat - b.seat);
  const G = {
    proto: PROTO,
    mid: Math.random().toString(36).slice(2, 10),
    scoring: scoringByKey(scoringKey).key,
    phase: 'bid',
    round: 0,
    dealt: 0,
    dealerIdx: Math.floor(Math.random() * players.length),
    players,
    trick: null,
    trickNo: 0,
    log: [],
    feedSeq: 0,
    fx: null,
    fxSeq: 0,
    roundResult: null,
  };
  dealRound(G);
  return G;
}

export function dealRound(G) {
  G.round += 1;
  G.phase = 'bid';
  G.trick = null;
  G.trickNo = 0;
  G.roundResult = null;
  G.dealerIdx = (G.dealerIdx + 1) % G.players.length;
  const deck = shuffle(buildDeck());
  // with a big crew the deck runs short late: everyone gets the same, capped
  // number of cards (official note: 8 players get 8 cards in rounds 9 and 10)
  G.dealt = Math.min(G.round, Math.floor(deck.length / G.players.length));
  for (const p of G.players) {
    p.hand = deck.splice(0, G.dealt).sort(handOrder);
    p.bid = null;
    p.tricksWon = 0;
    p.captured = [];
    p.lastAction = null;
  }
  const dealer = G.players[G.dealerIdx];
  const capped = G.dealt < G.round ? ` (the deck caps a crew of ${G.players.length} at ${G.dealt})` : '';
  addLog(G, `— Round ${G.round} of ${ROUNDS} — ${dealer.name} deals ${G.dealt} card${G.dealt === 1 ? '' : 's'}${capped}. Yo-ho-ho, place your bids!`);
  setFx(G, { kind: 'deal', round: G.round });
}

function handOrder(a, b) {
  const rank = (c) => (c.kind === 'num' ? SUITS.indexOf(c.suit) * 20 + c.v : 100 + ['escape', 'tigress', 'mermaid', 'pirate', 'sk'].indexOf(c.kind) * 5);
  return rank(a) - rank(b);
}

function leaderSeat(G) {
  // player left of the dealer opens the round; trick winners lead afterwards
  return G.players[(G.dealerIdx + 1) % G.players.length].seat;
}

// ---------------------------------------------------------------- legality

export function turnSeat(G) {
  if (G.phase !== 'play' || !G.trick) return null;
  const order = trickOrder(G);
  return order[G.trick.plays.length] ?? null;
}

function trickOrder(G) {
  const seats = G.players.map((p) => p.seat);
  const li = seats.indexOf(G.trick.leader);
  return seats.map((_, k) => seats[(li + k) % seats.length]);
}

// which of `seat`'s cards may legally be played right now
export function legalPlays(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p) return [];
  const t = G.trick;
  if (!t || !t.suit) return p.hand.slice(); // leading, or a suit-free trick
  const hasSuit = p.hand.some((c) => c.kind === 'num' && c.suit === t.suit);
  if (!hasSuit) return p.hand.slice();
  return p.hand.filter((c) => c.kind !== 'num' || c.suit === t.suit);
}

// ---------------------------------------------------------------- moves

export function applyMove(G, seat, move) {
  if (!G || !move || typeof move !== 'object') return { ok: false, error: 'Bad move' };
  const p = playerBySeat(G, seat);
  if (!p) return { ok: false, error: 'Not at the table' };
  if (G.phase === 'over') return { ok: false, error: 'The game is over' };
  if (move.kind === 'bid') return doBid(G, p, move);
  if (move.kind === 'play') return doPlay(G, p, move);
  return { ok: false, error: 'Unknown action' };
}

function doBid(G, p, move) {
  if (G.phase !== 'bid') return { ok: false, error: 'Bidding is over' };
  if (p.bid != null) return { ok: false, error: 'Your bid is locked' };
  const n = move.n;
  if (!Number.isInteger(n) || n < 0 || n > G.dealt) {
    return { ok: false, error: `Bid between 0 and ${G.dealt}` };
  }
  p.bid = n;
  addLog(G, `${p.name} locks in a bid.`);
  if (G.players.every((q) => q.bid != null)) {
    G.phase = 'play';
    G.trick = { leader: leaderSeat(G), plays: [], suit: null, free: false };
    G.trickNo = 1;
    const bidLine = G.players.map((q) => `${q.name} ${q.bid}`).join(' · ');
    addLog(G, `Yo, ho, ho! Bids are up: ${bidLine}.`);
    addLog(G, `${playerBySeat(G, G.trick.leader).name} leads the first trick.`);
    setFx(G, { kind: 'bids' });
  }
  return { ok: true };
}

function doPlay(G, p, move) {
  if (G.phase !== 'play') return { ok: false, error: 'Not in the trick phase' };
  if (turnSeat(G) !== p.seat) return { ok: false, error: 'Not your turn' };
  const card = p.hand.find((c) => c.id === move.cardId);
  if (!card) return { ok: false, error: 'That card is not in your hand' };
  if (!legalPlays(G, p.seat).some((c) => c.id === card.id)) {
    return { ok: false, error: `You must follow ${G.trick.suit} — specials are always allowed` };
  }
  let as = null;
  if (card.kind === 'tigress') {
    as = move.as === 'pirate' ? 'pirate' : move.as === 'escape' ? 'escape' : null;
    if (!as) return { ok: false, error: 'Declare the Tigress: pirate or escape' };
  }
  p.hand = p.hand.filter((c) => c.id !== card.id);
  const t = G.trick;
  t.plays.push({ seat: p.seat, card, as });

  // suit-setting: a number sets the suit only while every earlier card was an
  // escape; once a pirate, mermaid, or the King appears first, the trick is free
  if (!t.suit && !t.free) {
    const k = effKind(t.plays[t.plays.length - 1]);
    if (card.kind === 'num') t.suit = card.suit;
    else if (k !== 'escape') t.free = true;
  }
  p.lastAction = `played ${cardLabel(card, as)}`;
  addLog(G, `${p.name} plays ${cardLabel(card, as)}.`);

  if (t.plays.length === G.players.length) resolveTrick(G);
  return { ok: true };
}

function resolveTrick(G) {
  const t = G.trick;
  const winnerPlay = trickWinner(t);
  const winner = playerBySeat(G, winnerPlay.seat);
  winner.tricksWon += 1;
  winner.captured.push(t.plays.map((pl) => ({ seat: pl.seat, card: pl.card, as: pl.as })));
  const withCard = cardLabel(winnerPlay.card, winnerPlay.as);
  addLog(G, `${winner.name} takes trick ${G.trickNo} with ${withCard} (${winner.tricksWon} so far, bid ${winner.bid}).`);
  winner.lastAction = `took trick ${G.trickNo} with ${withCard}`;
  setFx(G, { kind: 'trick', seat: winner.seat, trick: t.plays, winnerCard: winnerPlay.card.id });

  if (G.players.every((p) => p.hand.length === 0)) {
    scoreRound(G);
    return;
  }
  G.trickNo += 1;
  G.trick = { leader: winner.seat, plays: [], suit: null, free: false };
}

// exported for tests: decide who wins a completed trick
export function trickWinner(t) {
  const plays = t.plays;
  const sk = plays.find((pl) => effKind(pl) === 'sk');
  const mermaid = plays.find((pl) => effKind(pl) === 'mermaid');
  const pirate = plays.find((pl) => effKind(pl) === 'pirate');
  if (sk && mermaid) return mermaid; // the mermaid always snares the King
  if (sk) return sk;
  if (pirate) return pirate;
  if (mermaid) return mermaid;
  const nums = plays.filter((pl) => pl.card.kind === 'num');
  if (!nums.length) return plays[0]; // all escapes: the first card takes it
  const black = nums.filter((pl) => pl.card.suit === 'black');
  if (black.length) return black.reduce((a, b) => (b.card.v > a.card.v ? b : a));
  const led = nums.filter((pl) => pl.card.suit === t.suit);
  const pool = led.length ? led : nums; // suit is always set when numbers exist
  return pool.reduce((a, b) => (b.card.v > a.card.v ? b : a));
}

// exported for tests: bonus points for one captured trick won with `winnerPlay`
export function trickBonus(plays, winnerPlay) {
  let bonus = 0;
  for (const pl of plays) {
    if (pl.card.kind === 'num' && pl.card.v === 14) bonus += pl.card.suit === 'black' ? 20 : 10;
  }
  const wk = effKind(winnerPlay);
  if (wk === 'sk') {
    const skIdx = plays.indexOf(winnerPlay);
    for (let i = 0; i < skIdx; i++) {
      if (effKind(plays[i]) === 'pirate') bonus += 30;
    }
  }
  if (wk === 'mermaid' && plays.some((pl) => effKind(pl) === 'sk')) bonus += 50;
  return bonus;
}

function scoreRound(G) {
  const lines = [];
  for (const p of G.players) {
    const off = Math.abs(p.tricksWon - p.bid);
    const exact = off === 0;
    let rawBonus = 0;
    for (const trick of p.captured) {
      const winnerPlay = trick.find((pl) => pl.seat === p.seat);
      rawBonus += trickBonus(trick, winnerPlay);
    }
    let bidPts = 0;
    let bonusPts = 0;
    if (G.scoring === 'rascal') {
      // every round has the same potential: 10 x cards dealt; exact earns all
      // of it (and all bonuses), off-by-one earns half of both, else nothing
      bidPts = exact ? 10 * G.dealt : off === 1 ? 5 * G.dealt : 0;
      bonusPts = exact ? rawBonus : off === 1 ? rawBonus / 2 : 0;
    } else if (G.scoring === 'cannonball') {
      bidPts = exact ? 15 * G.dealt : 0;
      bonusPts = exact ? rawBonus : 0;
    } else {
      if (p.bid === 0) bidPts = exact ? 10 * G.dealt : -10 * G.dealt;
      else bidPts = exact ? 20 * p.bid : -10 * off;
      bonusPts = exact ? rawBonus : 0;
    }
    p.score += bidPts + bonusPts;
    p.history.push({ round: G.round, bid: p.bid, tricks: p.tricksWon, bidPts, bonusPts, total: p.score });
    lines.push({ seat: p.seat, bid: p.bid, tricks: p.tricksWon, bidPts, bonusPts, total: p.score });
  }
  G.roundResult = { round: G.round, lines };
  addLog(
    G,
    `Round ${G.round} scored: ` +
      lines.map((l) => `${playerBySeat(G, l.seat).name} ${l.bidPts + l.bonusPts >= 0 ? '+' : ''}${l.bidPts + l.bonusPts}`).join(' · '),
  );
  if (G.round >= ROUNDS) {
    G.phase = 'over';
    const best = Math.max(...G.players.map((p) => p.score));
    const winners = G.players.filter((p) => p.score === best);
    addLog(G, `Game over — ${winners.map((w) => w.name).join(' & ')} rule${winners.length === 1 ? 's' : ''} the seas with ${best} points!`);
    setFx(G, { kind: 'over' });
  } else {
    G.phase = 'roundEnd';
    setFx(G, { kind: 'roundEnd' });
  }
}

export function nextRound(G) {
  if (G.phase !== 'roundEnd') return false;
  dealRound(G);
  return true;
}

// ---------------------------------------------------------------- lifecycle

export function markReconnected(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p || p.connected) return false;
  p.connected = true;
  p.botFor = false;
  addLog(G, `${p.name} reconnected — welcome back!`);
  return true;
}

export function markDisconnected(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p || !p.connected) return false;
  p.connected = false;
  p.botFor = false;
  addLog(G, `${p.name} disconnected — the game waits for them.`);
  return true;
}

// An observer may adopt an abandoned seat: it becomes theirs, name and all.
export function markSeatClaimed(G, seat, name) {
  const p = playerBySeat(G, seat);
  if (!p || p.connected) return false;
  const old = p.name;
  p.name = name;
  p.connected = true;
  p.resigned = false;
  p.botFor = false;
  addLog(G, `${name} takes over ${old}'s seat.`);
  return true;
}

// A player may hand back their seat and keep watching; the seat then waits
// for a claimant (or, in games with bots, a host bot-takeover).
export function markSeatResigned(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p || !p.connected) return false;
  p.connected = false;
  p.botFor = false;
  p.resigned = true;
  addLog(G, `${p.name} hands back their seat — it is open for a taker.`);
  return true;
}

// Host-only remedy for a stalled seat: hand it to a bot until they return.
export function markBotTakeover(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p || p.connected || p.botFor) return false;
  p.botFor = true;
  addLog(G, `The host hands ${p.name}'s seat to a bot until they return.`);
  return true;
}

// ---------------------------------------------------------------- views

export function viewFor(G, seat, code) {
  const allBids = G.phase !== 'bid';
  return {
    t: 'state',
    code,
    you: seat,
    mid: G.mid,
    phase: G.phase,
    round: G.round,
    rounds: ROUNDS,
    dealt: G.dealt,
    scoring: G.scoring,
    dealer: G.players[G.dealerIdx].seat,
    turn: turnSeat(G),
    trickNo: G.trickNo,
    trick: G.trick
      ? {
          leader: G.trick.leader,
          suit: G.trick.suit,
          free: G.trick.free,
          plays: G.trick.plays.map((pl) => ({ seat: pl.seat, card: pl.card, as: pl.as })),
        }
      : null,
    players: G.players.map((p) => ({
      seat: p.seat,
      name: p.name,
      bot: p.bot,
      connected: p.connected,
      botFor: !!p.botFor,
      resigned: !!p.resigned,
      handCount: p.hand.length,
      bid: allBids ? p.bid : p.seat === seat ? p.bid : null,
      hasBid: p.bid != null,
      tricksWon: p.tricksWon,
      score: p.score,
      lastAction: p.lastAction,
      history: p.history,
    })),
    hand: playerBySeat(G, seat) ? playerBySeat(G, seat).hand : [],
    legal: G.phase === 'play' && turnSeat(G) === seat ? legalPlays(G, seat).map((c) => c.id) : [],
    roundResult: G.roundResult,
    log: G.log.slice(-60),
    fx: G.fx,
  };
}

// ---------------------------------------------------------------- bots

// rough expected tricks for a single card
function cardStrength(c) {
  if (c.kind === 'sk') return 1.0;
  if (c.kind === 'pirate') return 0.8;
  if (c.kind === 'tigress') return 0.65; // flexible either way
  if (c.kind === 'mermaid') return 0.55;
  if (c.kind === 'escape') return 0;
  if (c.suit === 'black') {
    if (c.v >= 12) return 0.75;
    if (c.v >= 8) return 0.5;
    return 0.25;
  }
  if (c.v === 14) return 0.5;
  if (c.v >= 12) return 0.3;
  if (c.v >= 10) return 0.12;
  return 0.02;
}

// would `cand` beat the current best play if the trick ended here?
function beatsSoFar(t, plays, cand, as) {
  const virt = { seat: -1, card: cand, as };
  const test = { suit: t.suit, plays: [...plays, virt] };
  return trickWinner(test) === virt;
}

export function botChoose(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p) return null;

  if (G.phase === 'bid') {
    if (p.bid != null) return null;
    let est = p.hand.reduce((s, c) => s + cardStrength(c), 0);
    // crowded tables split the tricks more ways
    est *= 5 / (3 + G.players.length * 0.5);
    let n = Math.round(est + (Math.random() * 0.5 - 0.25));
    n = Math.max(0, Math.min(G.dealt, n));
    return { kind: 'bid', n };
  }

  if (G.phase !== 'play' || turnSeat(G) !== seat) return null;
  const legal = legalPlays(G, seat);
  const t = G.trick;
  const need = p.bid - p.tricksWon;
  const isLast = t.plays.length === G.players.length - 1;

  const options = [];
  for (const c of legal) {
    if (c.kind === 'tigress') {
      options.push({ c, as: 'pirate' }, { c, as: 'escape' });
    } else {
      options.push({ c, as: null });
    }
  }
  const winning = options.filter((o) => beatsSoFar(t, t.plays, o.c, o.as));
  const losing = options.filter((o) => !winning.includes(o));
  const power = (o) => (o.c.kind === 'tigress' ? (o.as === 'pirate' ? 0.7 : 0) : cardStrength(o.c)) * 100 + (o.c.kind === 'num' ? o.c.v : 50);

  let pick = null;
  if (need > 0) {
    if (winning.length) {
      // cheapest card that currently wins; when not last, prefer some muscle
      winning.sort((a, b) => power(a) - power(b));
      pick = isLast ? winning[0] : winning[Math.min(winning.length - 1, Math.floor(winning.length / 2))];
    } else {
      // can't win this one: dump the weakest
      losing.sort((a, b) => power(a) - power(b));
      pick = losing[0];
    }
  } else {
    if (losing.length) {
      // ditch the most dangerous card that still loses
      losing.sort((a, b) => power(b) - power(a));
      pick = losing[0];
    } else {
      winning.sort((a, b) => power(a) - power(b));
      pick = winning[0];
    }
  }
  if (!pick) pick = options[0];
  const move = { kind: 'play', cardId: pick.c.id };
  if (pick.as) move.as = pick.as;
  return move;
}
