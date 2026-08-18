// game.js — Love Letter (Premium) rules engine. Pure logic, no DOM: the host
// runs it authoritatively, clients import the catalog + helpers for their UI.
//
// Unofficial fan implementation of Love Letter by Seiji Kanai (© Z-Man Games /
// Asmodee). The Premium edition plays 2–8 with a 32-card deck that adds a
// second character at most values; smaller counts use a trimmed deck.

export const PROTO = 1;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;

// value: strength at showdown. targets: how the card is aimed.
export const CARDS = {
  assassin: {
    name: 'Assassin', value: 0, targets: 0,
    text: 'No effect when played. If a Guard targets you while you hold it, the Guard’s player is out instead and you redraw.',
  },
  jester: {
    name: 'Jester', value: 0, targets: 'other',
    text: 'Name a player. If they win this round, you also gain a token.',
  },
  guard: {
    name: 'Guard', value: 1, targets: 'other', guess: 'card',
    text: 'Name a player and a card other than Guard. If they hold it, they are out.',
  },
  priest: {
    name: 'Priest', value: 2, targets: 'other',
    text: 'Look at another player’s hand.',
  },
  cardinal: {
    name: 'Cardinal', value: 2, targets: 'two',
    text: 'Two players swap hands, then you look at one of them.',
  },
  baron: {
    name: 'Baron', value: 3, targets: 'other',
    text: 'Compare hands with another player. The lower card is out.',
  },
  baroness: {
    name: 'Baroness', value: 3, targets: 'oneOrTwo',
    text: 'Look at the hand of one or two other players.',
  },
  handmaid: {
    name: 'Handmaid', value: 4, targets: 0,
    text: 'You cannot be targeted until your next turn.',
  },
  sycophant: {
    name: 'Sycophant', value: 4, targets: 'any',
    text: 'Name a player. The next card played that targets someone must target them, if legal.',
  },
  prince: {
    name: 'Prince', value: 5, targets: 'any',
    text: 'Choose a player (including yourself): they discard their hand and draw a new card.',
  },
  count: {
    name: 'Count', value: 5, targets: 0,
    text: 'No effect when played. At the showdown, add 1 to your card for each Count in your discard pile.',
  },
  king: {
    name: 'King', value: 6, targets: 'other',
    text: 'Trade hands with another player.',
  },
  constable: {
    name: 'Constable', value: 6, targets: 0,
    text: 'No effect when played. If you are knocked out this round, you gain a token.',
  },
  countess: {
    name: 'Countess', value: 7, targets: 0,
    text: 'No effect, but you must play her if you also hold the King or the Prince.',
  },
  dowager: {
    name: 'Dowager Queen', value: 7, targets: 'other',
    text: 'Compare hands with another player. The higher card is out.',
  },
  princess: {
    name: 'Princess', value: 8, targets: 0,
    text: 'If you ever discard the Princess — for any reason — you are out of the round.',
  },
  bishop: {
    name: 'Bishop', value: 9, targets: 'other', guess: 'value',
    text: 'Name a player and a number. If their card matches, you gain a token and they may redraw. The Bishop cannot win a showdown.',
  },
};

// Deck by player count: the 16-card classic core, expanded toward the full
// 32-card Premium deck as the table grows.
const DECK_BASE = { guard: 5, priest: 2, baron: 2, handmaid: 2, prince: 2, king: 1, countess: 1, princess: 1 };
const DECK_ADD_5 = { guard: 2, assassin: 1, jester: 1, cardinal: 1, baroness: 1, count: 1, bishop: 1 };
const DECK_ADD_7 = { guard: 1, cardinal: 1, baroness: 1, sycophant: 2, count: 1, constable: 1, dowager: 1 };

export const TOKENS_TO_WIN = { 2: 6, 3: 5, 4: 4, 5: 3, 6: 3, 7: 3, 8: 3 };

export const cardValue = (key) => CARDS[key].value;
export const cardName = (key) => CARDS[key].name;

export function deckCounts(playerCount) {
  const counts = { ...DECK_BASE };
  const add = (extra) => {
    for (const [k, n] of Object.entries(extra)) counts[k] = (counts[k] || 0) + n;
  };
  if (playerCount >= 5) add(DECK_ADD_5);
  if (playerCount >= 7) add(DECK_ADD_7);
  return counts;
}

export function buildDeck(playerCount) {
  const deck = [];
  let i = 0;
  for (const [key, n] of Object.entries(deckCounts(playerCount))) {
    for (let c = 0; c < n; c++) deck.push({ id: `${key}-${i++}`, key });
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

// ------------------------------------------------------------ state helpers

const bySeat = (G, seat) => G.players.find((p) => p.seat === seat);
const nameOf = (G, seat) => (bySeat(G, seat) || {}).name || '?';
const alivePlayers = (G) => G.players.filter((p) => !p.out);

function note(G, text) {
  G.log.push({ n: ++G.logSeq, text });
  if (G.log.length > 60) G.log.shift();
}

function fx(G, kind, extra = {}) {
  G.fx = { seq: ++G.fxSeq, kind, ...extra };
}

// Which seats a given card may be aimed at, from `seat`.
export function targetOptions(players, seat, key) {
  const spec = CARDS[key];
  if (!spec || !spec.targets) return [];
  const selfOk = spec.targets === 'any' || spec.targets === 'two';
  return players
    .filter((p) => !p.out && (p.seat === seat ? selfOk : !p.immune))
    .map((p) => p.seat);
}

export function mustPlayCountess(hand) {
  const has = (k) => hand.some((c) => c.key === k);
  return has('countess') && (has('king') || has('prince'));
}

function drawFor(G, p) {
  if (G.deck.length) p.hand.push(G.deck.pop());
  else if (G.burn) {
    p.hand.push(G.burn); // official fallback: the set-aside card
    G.burn = null;
  }
}

function toDiscard(p, card) {
  p.discard.push(card);
}

function eliminate(G, p, reasonText) {
  if (p.out) return;
  p.out = true;
  while (p.hand.length) toDiscard(p, p.hand.pop());
  note(G, reasonText || `${p.name} is out of the round.`);
  if (p.discard.some((c) => c.key === 'constable')) {
    p.tokens++;
    note(G, `${p.name}'s Constable earns them a token anyway.`);
  }
  if (G.sycophant === p.seat) G.sycophant = null;
  fx(G, 'out', { seat: p.seat });
}

// A player's hand changed, so anyone's memory of it is stale.
function forgetHand(G, seat) {
  for (const q of G.players) delete q.memory[seat];
}

function peek(G, viewer, target) {
  viewer.reveals.push({ seat: target.seat, name: target.name, key: target.hand[0] ? target.hand[0].key : null });
  if (target.hand[0]) viewer.memory[target.seat] = target.hand[0].key;
}

// ------------------------------------------------------------ setup

export function newMatch(roster) {
  const G = {
    mid: Math.floor(Math.random() * 1e9),
    phase: 'playing',
    round: 0,
    tokensToWin: TOKENS_TO_WIN[roster.length] || 3,
    players: roster.map((p) => ({
      seat: p.seat,
      name: p.name,
      bot: !!p.bot,
      connected: p.connected !== false,
      hand: [],
      discard: [],
      tokens: 0,
      out: false,
      immune: false,
      reveals: [],
      memory: {},
      lastAction: null, // short summary shown to the other players
    })),
    deck: [],
    burn: null,
    faceUp: [],
    turn: 0,
    starter: null,
    sycophant: null,
    pending: null,
    jesterBets: [],
    roundResult: null,
    winner: null,
    log: [],
    logSeq: 0,
    fx: null,
    fxSeq: 0,
  };
  dealRound(G);
  return G;
}

export function dealRound(G) {
  G.round++;
  G.phase = 'playing';
  G.roundResult = null;
  G.sycophant = null;
  G.pending = null;
  G.jesterBets = [];
  G.deck = shuffled(buildDeck(G.players.length));
  G.burn = G.deck.pop();
  G.faceUp = G.players.length === 2 ? [G.deck.pop(), G.deck.pop(), G.deck.pop()] : [];
  for (const p of G.players) {
    p.hand = [];
    p.discard = [];
    p.out = !p.connected;
    p.immune = false;
    p.reveals = [];
    p.memory = {};
    p.lastAction = null;
    if (p.connected) drawFor(G, p);
  }
  let starter = G.starter;
  if (starter == null || !G.players.some((p) => p.seat === starter && !p.out)) {
    const alive = alivePlayers(G);
    starter = alive.length ? alive[Math.floor(Math.random() * alive.length)].seat : G.players[0].seat;
  }
  note(G, `Round ${G.round} — ${nameOf(G, starter)} starts.`);
  beginTurn(G, starter);
}

function beginTurn(G, seat) {
  G.turn = seat;
  const p = bySeat(G, seat);
  p.immune = false;
  p.reveals = [];
  p.lastAction = null;
  drawFor(G, p);
}

// ------------------------------------------------------------ turn flow

function finishTurn(G) {
  if (G.phase !== 'playing' || G.pending) return;
  const alive = alivePlayers(G);
  if (alive.length <= 1 || G.deck.length === 0) {
    endRound(G);
    return;
  }
  const order = G.players.map((p) => p.seat).sort((a, b) => a - b);
  const i = order.indexOf(G.turn);
  for (let k = 1; k <= order.length; k++) {
    const s = order[(i + k) % order.length];
    if (!bySeat(G, s).out) {
      beginTurn(G, s);
      return;
    }
  }
  endRound(G);
}

function showdownScore(p) {
  const base = p.hand[0] ? cardValue(p.hand[0].key) : -1;
  return base + p.discard.filter((c) => c.key === 'count').length;
}

const discardSum = (p) => p.discard.reduce((n, c) => n + cardValue(c.key), 0);

function endRound(G) {
  const alive = alivePlayers(G);
  let winners = [];
  let reason;
  if (alive.length <= 1) {
    winners = alive.slice();
    reason = 'last';
  } else {
    reason = 'showdown';
    // the Bishop cannot win a showdown
    const eligible = alive.filter((p) => p.hand[0] && p.hand[0].key !== 'bishop');
    const pool = eligible.length ? eligible : alive;
    const best = Math.max(...pool.map(showdownScore));
    winners = pool.filter((p) => showdownScore(p) === best);
    if (winners.length > 1) {
      const bestSum = Math.max(...winners.map(discardSum));
      winners = winners.filter((p) => discardSum(p) === bestSum);
    }
  }
  for (const w of winners) w.tokens++;
  if (winners.length === 1) note(G, `${winners[0].name} wins the round!`);
  else if (winners.length > 1) note(G, `Round tied — ${winners.map((w) => w.name).join(' & ')} each take a token.`);
  else note(G, 'Round ends with nobody left.');

  for (const bet of G.jesterBets) {
    if (!winners.some((w) => w.seat === bet.target)) continue;
    const owner = bySeat(G, bet.owner);
    if (!owner) continue;
    owner.tokens++;
    note(G, `${owner.name}'s Jester called it — a token for backing ${nameOf(G, bet.target)}.`);
  }

  G.roundResult = {
    reason,
    winners: winners.map((w) => w.seat),
    hands: G.players.map((p) => ({
      seat: p.seat,
      key: p.hand[0] ? p.hand[0].key : null,
      out: p.out,
      score: p.hand[0] ? showdownScore(p) : null,
    })),
  };
  G.starter = winners[0] ? winners[0].seat : G.turn;

  const champs = G.players.filter((p) => p.tokens >= G.tokensToWin);
  if (champs.length) {
    const best = champs.slice().sort((a, b) => b.tokens - a.tokens || a.seat - b.seat)[0];
    G.phase = 'over';
    G.winner = best.seat;
    note(G, `${best.name} wins the game with ${best.tokens} tokens!`);
  } else {
    G.phase = 'roundEnd';
  }
  fx(G, 'roundEnd');
}

// ------------------------------------------------------------ moves

export function applyMove(G, seat, move) {
  if (G.phase !== 'playing') return { ok: false, error: 'The round is over.' };
  const p = bySeat(G, seat);
  if (!p) return { ok: false, error: 'Unknown player.' };

  if (move && move.kind === 'bishopChoice') {
    if (!G.pending || G.pending.kind !== 'bishop' || G.pending.seat !== seat) {
      return { ok: false, error: 'Nothing to decide.' };
    }
    G.pending = null;
    if (move.discard && !p.out && p.hand[0]) {
      const card = p.hand.pop();
      toDiscard(p, card);
      forgetHand(G, p.seat);
      note(G, `${p.name} discards ${cardName(card.key)} and draws a new card.`);
      if (card.key === 'princess') {
        p.lastAction = 'out — discarded the Princess for the Bishop';
        eliminate(G, p, `${p.name} discarded the Princess — out of the round!`);
      } else {
        p.lastAction = `redrew after the Bishop (dropped ${cardName(card.key)})`;
        drawFor(G, p);
      }
    } else {
      p.lastAction = 'kept their card against the Bishop';
      note(G, `${p.name} keeps their card.`);
    }
    finishTurn(G);
    return { ok: true };
  }

  if (!move || move.kind !== 'play') return { ok: false, error: 'Unknown move.' };
  if (G.pending) return { ok: false, error: 'Waiting on another player.' };
  if (G.turn !== seat) return { ok: false, error: 'Not your turn.' };
  if (p.out) return { ok: false, error: 'You are out of this round.' };

  const idx = p.hand.findIndex((c) => c.id === move.cardId);
  if (idx < 0) return { ok: false, error: 'You do not have that card.' };
  const card = p.hand[idx];
  const spec = CARDS[card.key];
  if (card.key !== 'countess' && mustPlayCountess(p.hand)) {
    return { ok: false, error: 'You must play the Countess while you hold the King or Prince.' };
  }

  // ---- validate targets / guesses before mutating anything
  const options = targetOptions(G.players, seat, card.key);
  const forced = G.sycophant != null && options.includes(G.sycophant) ? G.sycophant : null;
  let targets = [];
  const badTarget = (t) => t != null && !options.includes(t);
  if (badTarget(move.target) || (Array.isArray(move.targets) && move.targets.some(badTarget))) {
    return { ok: false, error: 'That player cannot be targeted.' };
  }
  if (spec.targets === 'other' || spec.targets === 'any') {
    if (options.length) {
      if (move.target == null) return { ok: false, error: 'Choose a player.' };
      if (!options.includes(move.target)) return { ok: false, error: 'That player cannot be targeted.' };
      if (forced != null && move.target !== forced) {
        return { ok: false, error: `The Sycophant forces you to target ${nameOf(G, forced)}.` };
      }
      targets = [move.target];
    }
  } else if (spec.targets === 'oneOrTwo') {
    const wanted = Array.isArray(move.targets) ? [...new Set(move.targets)] : [];
    if (options.length) {
      if (!wanted.length || wanted.length > 2) return { ok: false, error: 'Choose one or two players.' };
      if (wanted.some((t) => !options.includes(t))) return { ok: false, error: 'That player cannot be targeted.' };
      if (forced != null && !wanted.includes(forced)) {
        return { ok: false, error: `The Sycophant forces you to include ${nameOf(G, forced)}.` };
      }
      targets = wanted;
    }
  } else if (spec.targets === 'two') {
    if (options.length >= 2) {
      const wanted = Array.isArray(move.targets) ? [...new Set(move.targets)] : [];
      if (wanted.length !== 2) return { ok: false, error: 'Choose exactly two players.' };
      if (wanted.some((t) => !options.includes(t))) return { ok: false, error: 'That player cannot be chosen.' };
      if (forced != null && !wanted.includes(forced)) {
        return { ok: false, error: `The Sycophant forces you to include ${nameOf(G, forced)}.` };
      }
      if (move.peek != null && !wanted.includes(move.peek)) return { ok: false, error: 'Peek at one of the two.' };
      targets = wanted;
    }
  }
  if (spec.guess === 'card' && targets.length) {
    const legalGuess = Object.keys(deckCounts(G.players.length)).filter((k) => k !== 'guard');
    if (!legalGuess.includes(move.guess)) return { ok: false, error: 'Name a card other than the Guard.' };
  }
  if (spec.guess === 'value' && targets.length) {
    if (!Number.isInteger(move.guess) || move.guess < 0 || move.guess > 9) {
      return { ok: false, error: 'Name a number from 0 to 9.' };
    }
  }

  // ---- commit: the card leaves the hand and hits the discard pile
  p.hand.splice(idx, 1);
  toDiscard(p, card);
  forgetHand(G, seat);
  note(G, `${p.name} plays ${spec.name}.`);
  fx(G, 'play', { seat, key: card.key });
  if (G.sycophant != null && spec.targets && spec.targets !== 0) G.sycophant = null;

  if (card.key === 'princess') {
    p.lastAction = 'out — played the Princess';
    eliminate(G, p, `${p.name} played the Princess — out of the round!`);
    finishTurn(G);
    return { ok: true };
  }

  const t0 = targets.length ? bySeat(G, targets[0]) : null;
  const noTarget = spec.targets && spec.targets !== 0 && !targets.length;
  if (noTarget) note(G, 'No one can be targeted — no effect.');

  switch (card.key) {
    case 'handmaid':
      p.immune = true;
      p.lastAction = 'played the Handmaid — protected';
      note(G, `${p.name} is protected until their next turn.`);
      break;

    case 'guard':
      if (t0) {
        if (t0.hand[0] && t0.hand[0].key === 'assassin') {
          const ass = t0.hand.pop();
          toDiscard(t0, ass);
          forgetHand(G, t0.seat);
          note(G, `${t0.name} held the Assassin — ${p.name} is struck down!`);
          t0.lastAction = `Assassin struck down ${p.name}`;
          drawFor(G, t0);
          eliminate(G, p, `${p.name} is out of the round.`);
          p.lastAction = `Guard hit ${t0.name}'s Assassin — out`;
        } else if (t0.hand[0] && t0.hand[0].key === move.guess) {
          note(G, `${p.name} guesses ${cardName(move.guess)} — correct!`);
          p.lastAction = `named ${cardName(move.guess)} on ${t0.name} — right`;
          eliminate(G, t0, `${t0.name} is out of the round.`);
          t0.lastAction = `out — held the ${cardName(move.guess)}`;
        } else {
          note(G, `${p.name} guesses ${cardName(move.guess)} — wrong.`);
          p.lastAction = `named ${cardName(move.guess)} on ${t0.name} — wrong`;
        }
      }
      break;

    case 'priest':
      if (t0) {
        peek(G, p, t0);
        p.lastAction = `looked at ${t0.name}'s hand`;
        note(G, `${p.name} looks at ${t0.name}'s hand.`);
      }
      break;

    case 'baroness':
      for (const s of targets) {
        const t = bySeat(G, s);
        peek(G, p, t);
      }
      if (targets.length) {
        const who = targets.map((s) => nameOf(G, s)).join(' and ');
        p.lastAction = `looked at ${who}'s hand${targets.length > 1 ? 's' : ''}`;
        note(G, `${p.name} looks at ${who}'s hand${targets.length > 1 ? 's' : ''}.`);
      }
      break;

    case 'cardinal':
      if (targets.length === 2) {
        const a = bySeat(G, targets[0]);
        const b = bySeat(G, targets[1]);
        const tmp = a.hand;
        a.hand = b.hand;
        b.hand = tmp;
        forgetHand(G, a.seat);
        forgetHand(G, b.seat);
        note(G, `${a.name} and ${b.name} swap hands.`);
        const look = move.peek != null ? bySeat(G, move.peek) : a;
        peek(G, p, look);
        p.lastAction = `swapped ${a.name} & ${b.name}, peeked at ${look.name}`;
        note(G, `${p.name} looks at ${look.name}'s new hand.`);
      }
      break;

    case 'baron':
      if (t0) {
        const mine = p.hand[0] ? cardValue(p.hand[0].key) : -1;
        const theirs = t0.hand[0] ? cardValue(t0.hand[0].key) : -1;
        p.memory[t0.seat] = t0.hand[0] ? t0.hand[0].key : undefined;
        t0.memory[p.seat] = p.hand[0] ? p.hand[0].key : undefined;
        if (mine > theirs) {
          eliminate(G, t0, `${t0.name} loses the comparison and is out.`);
          p.lastAction = `Baron beat ${t0.name}`;
          t0.lastAction = `out — lost the Baron to ${p.name}`;
        } else if (theirs > mine) {
          eliminate(G, p, `${p.name} loses the comparison and is out.`);
          p.lastAction = `out — lost their own Baron to ${t0.name}`;
          t0.lastAction = `survived ${p.name}'s Baron`;
        } else {
          note(G, 'The comparison is a tie — both survive.');
          p.lastAction = `Baron tied with ${t0.name}`;
        }
      }
      break;

    case 'dowager':
      if (t0) {
        const mine = p.hand[0] ? cardValue(p.hand[0].key) : -1;
        const theirs = t0.hand[0] ? cardValue(t0.hand[0].key) : -1;
        p.memory[t0.seat] = t0.hand[0] ? t0.hand[0].key : undefined;
        t0.memory[p.seat] = p.hand[0] ? p.hand[0].key : undefined;
        if (mine < theirs) {
          eliminate(G, t0, `${t0.name} holds the higher card and is out.`);
          p.lastAction = `Dowager Queen took out ${t0.name}`;
          t0.lastAction = `out — held the higher card`;
        } else if (theirs < mine) {
          eliminate(G, p, `${p.name} holds the higher card and is out.`);
          p.lastAction = `out — held the higher card`;
          t0.lastAction = `survived ${p.name}'s Dowager Queen`;
        } else {
          note(G, 'The comparison is a tie — both survive.');
          p.lastAction = `Dowager Queen tied with ${t0.name}`;
        }
      }
      break;

    case 'king':
      if (t0) {
        const mine = p.hand;
        p.hand = t0.hand;
        t0.hand = mine;
        forgetHand(G, p.seat);
        forgetHand(G, t0.seat);
        if (t0.hand[0]) p.memory[t0.seat] = t0.hand[0].key;
        if (p.hand[0]) t0.memory[p.seat] = p.hand[0].key;
        p.lastAction = `traded hands with ${t0.name}`;
        t0.lastAction = `traded hands with ${p.name}`;
        note(G, `${p.name} and ${t0.name} trade hands.`);
      }
      break;

    case 'prince':
      if (t0) {
        const dumped = t0.hand.pop();
        if (dumped) {
          toDiscard(t0, dumped);
          forgetHand(G, t0.seat);
          note(G, `${t0.name} discards ${cardName(dumped.key)}.`);
          const self = t0.seat === seat;
          if (dumped.key === 'princess') {
            eliminate(G, t0, `${t0.name} discarded the Princess — out of the round!`);
            p.lastAction = self
              ? 'out — Prince made them drop the Princess'
              : `Prince made ${t0.name} drop the Princess`;
            if (!self) t0.lastAction = 'out — forced to discard the Princess';
          } else {
            drawFor(G, t0);
            p.lastAction = self
              ? `Prince: dropped ${cardName(dumped.key)} and redrew`
              : `Prince made ${t0.name} drop ${cardName(dumped.key)}`;
            if (!self) t0.lastAction = `forced to drop ${cardName(dumped.key)}`;
          }
        }
      }
      break;

    case 'sycophant':
      if (t0) {
        G.sycophant = t0.seat;
        p.lastAction = `Sycophant: next card must hit ${t0.name}`;
        note(G, `The next targeted card must aim at ${t0.name}.`);
      }
      break;

    case 'jester':
      if (t0) {
        G.jesterBets.push({ owner: seat, target: t0.seat });
        p.lastAction = `Jester: betting on ${t0.name}`;
        note(G, `${p.name} bets on ${t0.name} to win the round.`);
      }
      break;

    case 'bishop':
      if (t0) {
        const theirs = t0.hand[0] ? cardValue(t0.hand[0].key) : -1;
        if (theirs === move.guess) {
          p.tokens++;
          p.memory[t0.seat] = t0.hand[0].key;
          note(G, `${p.name} names ${move.guess} — right! A token of affection.`);
          p.lastAction = `Bishop named ${move.guess} at ${t0.name} — right`;
          fx(G, 'token', { seat });
          if (p.tokens >= G.tokensToWin) {
            G.phase = 'over';
            G.winner = seat;
            G.roundResult = {
              reason: 'bishop',
              winners: [seat],
              hands: G.players.map((q) => ({
                seat: q.seat,
                key: q.hand[0] ? q.hand[0].key : null,
                out: q.out,
                score: q.hand[0] ? showdownScore(q) : null,
              })),
            };
            note(G, `${p.name} wins the game with ${p.tokens} tokens!`);
            return { ok: true };
          }
        } else {
          note(G, `${p.name} names ${move.guess} — no.`);
          p.lastAction = `Bishop named ${move.guess} at ${t0.name} — wrong`;
        }
        if (!t0.out && t0.hand[0]) {
          G.pending = { kind: 'bishop', seat: t0.seat, actor: seat };
          return { ok: true }; // the target decides whether to redraw
        }
      }
      break;

    default:
      p.lastAction = `played the ${spec.name}`;
      break; // assassin, count, constable, countess: no immediate effect
  }

  finishTurn(G);
  return { ok: true };
}

export function markDisconnected(G, seat) {
  const p = bySeat(G, seat);
  if (!p || !p.connected) return false;
  p.connected = false;
  note(G, `${p.name} disconnected.`);
  if (G.phase !== 'playing') return true;
  if (!p.out) {
    p.out = true;
    while (p.hand.length) toDiscard(p, p.hand.pop());
  }
  if (G.sycophant === seat) G.sycophant = null;
  const live = G.players.filter((q) => q.connected);
  if (live.length <= 1) {
    G.phase = 'over';
    G.winner = live.length ? live[0].seat : null;
    G.roundResult = { reason: 'forfeit', winners: live.map((q) => q.seat), hands: [] };
    note(G, live.length ? `${live[0].name} wins — everyone else left.` : 'Everyone left.');
    return true;
  }
  if (G.pending && G.pending.seat === seat) {
    G.pending = null;
    finishTurn(G);
  } else if (G.turn === seat) {
    finishTurn(G);
  } else {
    const alive = alivePlayers(G);
    if (alive.length <= 1) endRound(G);
  }
  return true;
}

export function standings(G) {
  return G.players
    .slice()
    .sort((a, b) => {
      if ((G.winner === a.seat) !== (G.winner === b.seat)) return G.winner === a.seat ? -1 : 1;
      if (a.tokens !== b.tokens) return b.tokens - a.tokens;
      return a.seat - b.seat;
    })
    .map((p) => ({ seat: p.seat, name: p.name, bot: p.bot, tokens: p.tokens, connected: p.connected }));
}

// ------------------------------------------------------------ bots

function unseenCounts(G, p) {
  const counts = deckCounts(G.players.length);
  const seen = {};
  const bump = (key) => {
    seen[key] = (seen[key] || 0) + 1;
  };
  for (const q of G.players) for (const c of q.discard) bump(c.key);
  for (const c of G.faceUp) bump(c.key);
  for (const c of p.hand) bump(c.key);
  for (const key of Object.keys(counts)) counts[key] = Math.max(0, counts[key] - (seen[key] || 0));
  return counts;
}

function pickGuess(G, p, targetSeat) {
  const known = p.memory[targetSeat];
  if (known && known !== 'guard') return known;
  const counts = unseenCounts(G, p);
  delete counts.guard;
  const pool = Object.entries(counts).filter(([, n]) => n > 0);
  if (!pool.length) return 'princess';
  pool.sort((a, b) => b[1] - a[1]);
  // usually the most likely card, sometimes the second, to stay unpredictable
  const pick = pool.length > 1 && Math.random() < 0.3 ? pool[1] : pool[0];
  return pick[0];
}

export function botChoose(G, seat) {
  const p = bySeat(G, seat);
  if (G.pending && G.pending.kind === 'bishop' && G.pending.seat === seat) {
    const v = p.hand[0] ? cardValue(p.hand[0].key) : 0;
    return { kind: 'bishopChoice', discard: p.hand[0] && p.hand[0].key !== 'princess' && v <= 3 };
  }
  const forcedCountess = mustPlayCountess(p.hand);
  const candidates = p.hand.filter((c) => (forcedCountess ? c.key === 'countess' : true));
  const scored = candidates.map((card) => {
    const options = targetOptions(G.players, seat, card.key);
    const others = options.filter((s) => s !== seat);
    const known = others.filter((s) => p.memory[s]);
    let score = 10 - cardValue(card.key); // keep the strong cards when possible
    switch (card.key) {
      case 'princess':
        score = -100;
        break;
      case 'guard':
        score += known.length ? 9 : 3;
        break;
      case 'baron': {
        const mine = p.hand.find((c) => c.id !== card.id);
        score += mine && cardValue(mine.key) >= 5 ? 6 : -2;
        break;
      }
      case 'dowager': {
        const mine = p.hand.find((c) => c.id !== card.id);
        score += mine && cardValue(mine.key) <= 3 ? 6 : -2;
        break;
      }
      case 'handmaid':
        score += 4;
        break;
      case 'priest':
      case 'baroness':
        score += 3;
        break;
      case 'bishop':
        score += known.length ? 8 : 1;
        break;
      case 'king': {
        const mine = p.hand.find((c) => c.id !== card.id);
        score += mine && cardValue(mine.key) <= 2 ? 4 : -3;
        break;
      }
      case 'prince':
        score += others.length ? 2 : -4;
        break;
      default:
        break;
    }
    return { card, score: score + Math.random() * 1.5, options, others, known };
  });
  scored.sort((a, b) => b.score - a.score);
  const choice = scored[0];
  const card = choice.card;
  const spec = CARDS[card.key];
  const move = { kind: 'play', cardId: card.id };

  const forced = G.sycophant != null && choice.options.includes(G.sycophant) ? G.sycophant : null;
  const pickTarget = () => {
    if (forced != null) return forced;
    const pool = choice.known.length && (card.key === 'guard' || card.key === 'bishop') ? choice.known : choice.others;
    if (!pool.length) return choice.options.length ? choice.options[0] : null;
    return pool[Math.floor(Math.random() * pool.length)];
  };

  if (spec.targets === 'other' || spec.targets === 'any') {
    if (choice.options.length) {
      let t = pickTarget();
      if (card.key === 'prince') {
        // never self-dump the Princess; otherwise prefer hitting someone else
        const mine = p.hand.find((c) => c.id !== card.id);
        const outsiders = choice.others;
        if (outsiders.length) t = forced != null ? forced : outsiders[Math.floor(Math.random() * outsiders.length)];
        else if (mine && mine.key === 'princess') t = seat; // forced, unavoidable
      }
      if (t == null) t = choice.options[0];
      move.target = t;
    }
  } else if (spec.targets === 'oneOrTwo') {
    if (choice.options.length) {
      const pool = forced != null ? [forced] : [];
      for (const s of choice.options) {
        if (pool.length >= 2) break;
        if (!pool.includes(s)) pool.push(s);
      }
      move.targets = pool.slice(0, 2);
    }
  } else if (spec.targets === 'two') {
    if (choice.options.length >= 2) {
      const pool = forced != null ? [forced] : [];
      for (const s of choice.options) {
        if (pool.length >= 2) break;
        if (!pool.includes(s)) pool.push(s);
      }
      move.targets = pool.slice(0, 2);
      // peeking at your own hand tells you nothing: look at the other player
      move.peek = move.targets.find((t) => t !== seat) ?? move.targets[0];
    }
  }

  if (spec.guess === 'card' && move.target != null) move.guess = pickGuess(G, p, move.target);
  if (spec.guess === 'value' && move.target != null) {
    const known = p.memory[move.target];
    if (known) move.guess = cardValue(known);
    else {
      const counts = unseenCounts(G, p);
      const pool = Object.entries(counts).filter(([, n]) => n > 0);
      pool.sort((a, b) => b[1] - a[1]);
      move.guess = pool.length ? cardValue(pool[0][0]) : 1;
    }
  }
  return move;
}

// ------------------------------------------------------------ views

// Personalized snapshot: public table info, plus this seat's own hand and the
// private peeks they've earned this turn.
export function viewFor(G, seat, code) {
  const me = bySeat(G, seat);
  return {
    code,
    mid: G.mid,
    you: seat,
    phase: G.phase,
    round: G.round,
    tokensToWin: G.tokensToWin,
    turn: G.turn,
    deckCount: G.deck.length,
    burnLeft: G.burn ? 1 : 0,
    faceUp: G.faceUp.map((c) => c.key),
    sycophant: G.sycophant,
    pending: G.pending ? { kind: G.pending.kind, seat: G.pending.seat } : null,
    players: G.players.map((p) => ({
      seat: p.seat,
      name: p.name,
      bot: p.bot,
      connected: p.connected,
      tokens: p.tokens,
      out: p.out,
      immune: p.immune,
      handCount: p.hand.length,
      lastAction: p.lastAction,
      discard: p.discard.map((c) => c.key),
    })),
    hand: me ? me.hand.map((c) => ({ id: c.id, key: c.key })) : [],
    reveals: me ? me.reveals.slice() : [],
    jesterBets: G.jesterBets.filter((b) => b.owner === seat),
    roundResult: G.roundResult,
    winner: G.winner,
    standings: G.phase === 'over' || G.phase === 'roundEnd' ? standings(G) : null,
    log: G.log.slice(-15),
    fx: G.fx,
  };
}
