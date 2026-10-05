// game.js — the rules of BANG! No DOM, no network: the host holds the only
// copy of the state and every move goes through applyMove.
//
// Four to seven players sit round the table with a secret role — the Sheriff
// face up, the rest hidden: Deputies, Outlaws, a Renegade — and a character
// with an ability. On your turn: draw two, play what you like, discard down
// to your life points. A BANG! hits a player your weapon reaches unless they
// play a Missed!; Beer, Barrels, Mustangs, Jail, Dynamite and the rest do
// what their cards say. The Outlaws win when the Sheriff falls (unless the
// Renegade is the last one standing — then the Renegade does); the Sheriff
// and the Deputies win when every Outlaw and the Renegade are gone.
//
// Every effect that needs somebody's decision waits in `G.ask`; effects queue
// in `G.queue` and run in order — the FAQ: "Before playing any card you must
// wait for the previous one to end all its effects."

import { KINDS, DECK, CHARACTERS, ROLES_FOR, ROLES, RED } from './cards.js';

export { KINDS, DECK, CHARACTERS, ROLES, ROLES_FOR, SUITS, RANKS } from './cards.js';

export const PROTO = 1;
export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 7;

export const playerBySeat = (G, seat) => G.players.find((p) => p.seat === seat);
const kindOf = (G, id) => G.cards[id].kind;
const nameOfCard = (G, id) => KINDS[kindOf(G, id)].name;
const cardWord = (G, id) => `${nameOfCard(G, id)} (${G.cards[id].rank}${({ S: '♠', D: '♦', C: '♣', H: '♥' })[G.cards[id].suit]})`;

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function note(G, text) {
  G.logSeq = (G.logSeq || 0) + 1;
  G.log.push({ id: G.logSeq, text });
  if (G.log.length > 120) G.log.shift();
}

// What just happened, for the table to show: one move can set off several
// things — a BANG!, a Barrel, a wound, an elimination — so they are kept in
// order, and each view shows the ones it has not seen yet.
function bump(G, fx) {
  G.fxSeq = (G.fxSeq || 0) + 1;
  G.fxs.push({ seq: G.fxSeq, ...fx });
  if (G.fxs.length > 24) G.fxs.shift();
}

// ---------------------------------------------------------------- setup

export function canStart(n) {
  if (n < MIN_PLAYERS) return `Needs at least ${MIN_PLAYERS} players — add bots to fill the table.`;
  if (n > MAX_PLAYERS) return `At most ${MAX_PLAYERS} players.`;
  return null;
}

export function newGame(roster) {
  const n = roster.length;
  const why = canStart(n);
  if (why) throw new Error(why);
  const roles = shuffle(ROLES_FOR[n].slice());
  const chars = shuffle(Object.keys(CHARACTERS)).slice(0, n);
  const G = {
    mid: Math.random().toString(36).slice(2, 10),
    phase: 'play',
    n,
    cards: DECK.map(([kind, suit, rank], id) => ({ id, kind, suit, rank })),
    deck: [],
    discard: [],
    players: roster.map((r, i) => {
      const char = chars[i];
      const role = roles[i];
      // "The Sheriff plays the game with one additional bullet"
      const max = CHARACTERS[char].life + (role === 'sheriff' ? 1 : 0);
      return { seat: r.seat, name: r.name, bot: !!r.bot, connected: r.bot ? true : r.connected !== false, role, char, life: max, max, hand: [], table: [], alive: true };
    }),
    turn: 0,
    step: 'start',
    bangs: 0,
    queue: [],
    ask: null,
    store: null,
    look: null,       // Kit Carlson's three cards, while he chooses
    flips: null,      // the last "draw!": whose, what for, the cards turned
    fxs: [],
    winner: null,
    why: '',
    acts: [],         // who has aimed what at whom: the table's evidence about roles
    log: [],
  };
  G.deck = shuffle(G.cards.map((c) => c.id));
  // "give each player as many cards ... as the bullets he has"
  for (const p of G.players) p.hand = drawCards(G, p.max);
  // "The Sheriff begins"
  G.turn = G.players.findIndex((p) => p.role === 'sheriff');
  note(G, `${n} players. ${G.players[G.turn].name} is the Sheriff, playing ${CHARACTERS[G.players[G.turn].char].name}.`);
  bump(G, { kind: 'start' });
  advance(G);
  return G;
}

// ---------------------------------------------------------------- the deck

// "As soon as the draw pile is empty, shuffle the discard pile" into a new one.
function topCard(G) {
  if (!G.deck.length) {
    if (!G.discard.length) return null;
    G.deck = shuffle(G.discard.splice(0));
    note(G, 'The discard pile is shuffled into a new deck.');
  }
  return G.deck.pop();
}

function drawCards(G, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const id = topCard(G);
    if (id == null) break;
    out.push(id);
  }
  return out;
}

const discardCard = (G, id) => { G.discard.push(id); };

// "draw!": turn the top card, check it, discard it. Lucky Duke turns two and
// keeps the one he likes better.
function drawCheck(G, p, good, why) {
  const n = p.char === 'lucky' ? 2 : 1;
  const ids = drawCards(G, n);
  if (!ids.length) return false;
  let pick = ids[0];
  if (ids.length > 1 && !good(G.cards[ids[0]]) && good(G.cards[ids[1]])) pick = ids[1];
  for (const id of ids) discardCard(G, id);
  const ok = good(G.cards[pick]);
  const cards = ids.map((id) => ({ id, ...G.cards[id], picked: id === pick }));
  G.flips = { seat: p.seat, why, ok, cards };
  note(G, `${p.name} draws! for ${why}: ${ids.map((id) => cardWord(G, id)).join(' and ')}${ids.length > 1 ? ` — keeps ${cardWord(G, pick)}` : ''}.`);
  bump(G, { kind: 'draw!', seat: p.seat, why, cards, ok });
  return ok;
}

// ---------------------------------------------------------------- the table

export const alive = (G) => G.players.filter((p) => p.alive);
const has = (p, G, kind) => p.table.some((id) => kindOf(G, id) === kind);
const weaponOf = (G, p) => p.table.find((id) => KINDS[kindOf(G, id)].weapon);
export const rangeOf = (G, p) => { const w = weaponOf(G, p); return w != null ? KINDS[kindOf(G, w)].range : 1; };

// "The distance between two players is the minimum number of places between
// them, counting clockwise or counter-clockwise" — among players still in play.
// A Mustang (or Paul Regret) adds one to how far others see you; a Scope (or
// Rose Doolan) takes one off how far you see them. Never less than 1.
export function distance(G, from, to) {
  const ring = alive(G).map((p) => p.seat);
  const a = ring.indexOf(from), b = ring.indexOf(to);
  if (a < 0 || b < 0 || a === b) return 0;
  const k = Math.abs(a - b);
  let d = Math.min(k, ring.length - k);
  const A = playerBySeat(G, from), B = playerBySeat(G, to);
  if (has(B, G, 'mustang')) d++;
  if (B.char === 'paul') d++;
  if (has(A, G, 'scope')) d--;
  if (A.char === 'rose') d--;
  return Math.max(1, d);
}

const current = (G) => G.players[G.turn];
// the next player in play, clockwise ("to your left")
function nextAlive(G, seat) {
  const i = G.players.findIndex((p) => p.seat === seat);
  for (let k = 1; k <= G.n; k++) {
    const q = G.players[(i + k) % G.n];
    if (q.alive) return q;
  }
  return null;
}
// everyone else in play, clockwise from the next player
function othersFrom(G, seat) {
  const out = [];
  let q = nextAlive(G, seat);
  while (q && q.seat !== seat) { out.push(q); q = nextAlive(G, q.seat); }
  return out;
}

const bangLike = (G, p) => p.hand.filter((id) => kindOf(G, id) === 'bang' || (p.char === 'calamity' && kindOf(G, id) === 'missed'));
const missedLike = (G, p) => p.hand.filter((id) => kindOf(G, id) === 'missed' || (p.char === 'calamity' && kindOf(G, id) === 'bang'));
const takeFromHand = (p, id) => { const i = p.hand.indexOf(id); if (i >= 0) p.hand.splice(i, 1); return i >= 0; };
const takeFromTable = (p, id) => { const i = p.table.indexOf(id); if (i >= 0) p.table.splice(i, 1); return i >= 0; };

// ---------------------------------------------------------------- the engine

// Run queued effects until someone has a decision to make.
function advance(G) {
  for (let guard = 0; guard < 500; guard++) {
    if (G.phase === 'over' || G.ask) return;
    if (G.queue.length) { runTask(G, G.queue.shift()); continue; }
    const p = current(G);
    if (!p.alive) { nextTurn(G); continue; }
    // "As soon as she has no cards in her hand, she draws a card" — once
    // everything under way is over
    const suzy = G.players.find((q) => q.alive && q.char === 'suzy' && !q.hand.length);
    if (suzy) {
      const got = drawCards(G, 1);
      if (got.length) { suzy.hand.push(...got); note(G, `${suzy.name} has run out of cards and draws one.`); continue; }
    }
    if (G.step === 'start') { startTurn(G); continue; }
    if (G.step === 'draw') { drawPhase(G); continue; }
    if (G.step === 'play') { G.ask = { kind: 'turn', seat: p.seat }; return; }
    if (G.step === 'discard') {
      const over = p.hand.length - Math.max(0, p.life);
      if (over > 0) { G.ask = { kind: 'discard', seat: p.seat, n: over }; return; }
      nextTurn(G);
      continue;
    }
  }
}

function nextTurn(G) {
  const p = current(G);
  const q = nextAlive(G, p.seat);
  G.turn = G.players.indexOf(q);
  G.step = 'start';
  G.bangs = 0;
}

// The start of a turn: "If you have both the Dynamite and a Jail in play,
// check the Dynamite first."
function startTurn(G) {
  const p = current(G);
  G.step = 'draw';
  note(G, `${p.name}'s turn.`);
  bump(G, { kind: 'turn', seat: p.seat });
  if (has(p, G, 'dynamite')) G.queue.push({ t: 'dynamite', seat: p.seat });
  if (has(p, G, 'jail')) G.queue.push({ t: 'jail', seat: p.seat });
}

function drawPhase(G) {
  const p = current(G);
  G.step = 'play';
  const others = alive(G).filter((q) => q.seat !== p.seat && q.hand.length);
  if (p.char === 'jesse' && others.length) { G.step = 'draw'; G.ask = { kind: 'jesse', seat: p.seat }; return; }
  if (p.char === 'pedro' && G.discard.length) { G.step = 'draw'; G.ask = { kind: 'pedro', seat: p.seat }; return; }
  if (p.char === 'kit') {
    const look = drawCards(G, 3);
    if (look.length > 2) { G.step = 'draw'; G.look = look; G.ask = { kind: 'kit', seat: p.seat }; return; }
    p.hand.push(...look);
    return;
  }
  const got = drawCards(G, 2);
  p.hand.push(...got);
  if (p.char === 'blackjack' && got.length === 2) {
    const second = G.cards[got[1]];
    note(G, `${p.name} shows the second card drawn: ${cardWord(G, got[1])}.`);
    if (RED.has(second.suit)) { p.hand.push(...drawCards(G, 1)); note(G, 'A red card — Black Jack draws one more.'); }
    bump(G, { kind: 'blackjack', seat: p.seat, card: { id: got[1], ...second } });
  }
}

function runTask(G, task) {
  const p = playerBySeat(G, task.seat ?? task.to);
  switch (task.t) {
    case 'dynamite': {
      if (!p.alive) return;
      const dyn = p.table.find((id) => kindOf(G, id) === 'dynamite');
      if (dyn == null) return;
      // explodes on "Spades and a number between 2 and 9"
      const safe = (c) => !(c.suit === 'S' && ['2', '3', '4', '5', '6', '7', '8', '9'].includes(c.rank));
      if (drawCheck(G, p, safe, 'the Dynamite')) {
        const next = nextAlive(G, p.seat);
        takeFromTable(p, dyn);
        if (next.seat === p.seat || has(next, G, 'dynamite')) { p.table.push(dyn); return; }
        next.table.push(dyn);
        note(G, `The Dynamite passes to ${next.name}.`);
        return;
      }
      takeFromTable(p, dyn);
      discardCard(G, dyn);
      note(G, `The Dynamite explodes on ${p.name}!`);
      bump(G, { kind: 'boom', seat: p.seat });
      G.queue.unshift({ t: 'damage', to: p.seat, from: null, amount: 3, cause: 'the Dynamite' });
      return;
    }
    case 'jail': {
      if (!p.alive) return;
      const jail = p.table.find((id) => kindOf(G, id) === 'jail');
      if (jail == null) return;
      const free = drawCheck(G, p, (c) => c.suit === 'H', 'the Jail');
      takeFromTable(p, jail);
      discardCard(G, jail);
      if (free) { note(G, `${p.name} escapes from Jail.`); return; }
      note(G, `${p.name} stays in Jail and skips the turn.`);
      G.queue = [];
      G.step = 'skip';
      nextTurn(G);
      return;
    }
    case 'shot': return shot(G, task);
    case 'indians': {
      if (!p.alive) return;
      if (bangLike(G, p).length) { G.ask = { kind: 'indians', seat: p.seat, from: task.from }; return; }
      G.queue.unshift({ t: 'damage', to: p.seat, from: task.from, amount: 1, cause: 'the Indians' });
      return;
    }
    case 'duel': {
      const cur = playerBySeat(G, task.cur);
      if (!cur.alive || !playerBySeat(G, task.other).alive) return;
      if (bangLike(G, cur).length) { G.ask = { kind: 'duel', seat: cur.seat, from: task.from, other: task.other }; return; }
      note(G, `${cur.name} has no BANG! left and loses the Duel.`);
      G.queue.unshift({ t: 'damage', to: cur.seat, from: task.from, amount: 1, cause: 'the Duel' });
      return;
    }
    case 'store': {
      const left = G.store.cards;
      const order = G.store.order.filter((s) => playerBySeat(G, s).alive);
      const who = order[G.store.at];
      if (!left.length || who == null) { for (const id of left) discardCard(G, id); G.store = null; return; }
      const q = playerBySeat(G, who);
      if (left.length === 1) {
        q.hand.push(left[0]);
        note(G, `${q.name} takes the last card from the General Store: ${nameOfCard(G, left[0])}.`);
        G.store = null;
        return;
      }
      G.ask = { kind: 'store', seat: who };
      return;
    }
    case 'damage': return damage(G, task);
    // the rest of a hit that Sid Ketchum paused to answer
    case 'after-hit': return afterHit(G, p, task.from, task.amount);
    case 'eliminate': return eliminate(G, task);
    default: return;
  }
}

// A BANG! (or a Gatling) reaching its target. The Barrels go first — a real
// one and Jourdonnais's own, one "draw!" each — then Missed! cards. Slab the
// Killer's BANG! needs two Missed!; "the Barrel effect, if successfully used,
// only counts as one".
function shot(G, task) {
  const t = playerBySeat(G, task.to);
  if (!t.alive) return;
  if (task.need === undefined) {
    const shooter = playerBySeat(G, task.from);
    task.need = task.card === 'bang' && shooter.char === 'slab' ? 2 : 1;
    let barrels = (has(t, G, 'barrel') ? 1 : 0) + (t.char === 'jourdonnais' ? 1 : 0);
    while (barrels-- > 0 && task.need > 0) {
      if (drawCheck(G, t, (c) => c.suit === 'H', 'the Barrel')) { task.need--; note(G, `${t.name}'s Barrel turns the shot.`); }
    }
    if (task.need === 0) { bump(G, { kind: 'missed', seat: t.seat, by: 'barrel' }); return; }
  }
  if (missedLike(G, t).length >= task.need) {
    G.ask = { kind: 'shot', seat: t.seat, from: task.from, card: task.card, need: task.need };
    return;
  }
  G.queue.unshift({ t: 'damage', to: t.seat, from: task.from, amount: 1, cause: task.card === 'gatling' ? 'the Gatling' : 'a BANG!' });
}

// Losing life points. Out of turn, only a Beer saves you from the last one
// ("unless you immediately play a Beer") — and a Beer does nothing with two
// players left. Sid Ketchum may also discard two cards for each point.
function damage(G, task) {
  const p = playerBySeat(G, task.to);
  if (!p.alive) return;
  p.life -= task.amount;
  const from = task.from != null ? playerBySeat(G, task.from) : null;
  note(G, `${p.name} loses ${task.amount === 1 ? 'a life point' : `${task.amount} life points`} to ${task.cause}${from && from.seat !== p.seat ? ` from ${from.name}` : ''}.`);
  bump(G, { kind: 'hit', seat: p.seat, amount: task.amount, from: task.from });
  if (p.life <= 0 && alive(G).length > 2) {
    for (const id of p.hand.slice()) {
      if (p.life > 0) break;
      if (kindOf(G, id) !== 'beer') continue;
      takeFromHand(p, id);
      discardCard(G, id);
      p.life++;
      note(G, `${p.name} drinks a Beer to stay in the game.`);
    }
  }
  if (p.life <= 0 && p.char === 'sid' && p.hand.length >= 2) {
    G.ask = { kind: 'dying', seat: p.seat };
    G.queue.unshift({ t: 'after-hit', to: p.seat, from: task.from, amount: task.amount });
    return;
  }
  afterHit(G, p, task.from, task.amount);
}

function afterHit(G, p, from, amount) {
  if (p.life <= 0) {
    G.queue.unshift({ t: 'eliminate', seat: p.seat, by: from });
    return;
  }
  // "Each time he loses a life point, he immediately draws a card"
  if (p.char === 'bart') {
    const got = drawCards(G, amount);
    p.hand.push(...got);
    if (got.length) note(G, `${p.name} draws ${got.length === 1 ? 'a card' : `${got.length} cards`} for the wound.`);
  }
  // "he draws a random card from the hands of that player (one card for each life point)"
  if (p.char === 'gringo' && from != null && from !== p.seat) {
    const q = playerBySeat(G, from);
    let n = 0;
    for (let i = 0; i < amount && q.hand.length; i++) {
      const id = q.hand.splice(Math.floor(Math.random() * q.hand.length), 1)[0];
      p.hand.push(id);
      n++;
    }
    if (n) note(G, `${p.name} takes ${n === 1 ? 'a card' : `${n} cards`} from ${q.name}'s hand.`);
  }
}

const ROLE_A = { sheriff: 'the Sheriff', deputy: 'a Deputy', outlaw: 'an Outlaw', renegade: 'the Renegade' };

function eliminate(G, task) {
  const p = playerBySeat(G, task.seat);
  if (!p.alive) return;
  p.alive = false;
  p.life = 0;
  const by = task.by != null ? playerBySeat(G, task.by) : null;
  note(G, `${p.name} is eliminated — ${ROLE_A[p.role]}.`);
  bump(G, { kind: 'dead', seat: p.seat, role: p.role, by: task.by });
  // "Sam takes all the cards that player had in his hand and in play"
  const sam = G.players.find((q) => q.alive && q.char === 'vulture');
  const all = [...p.hand, ...p.table];
  p.hand = [];
  p.table = [];
  if (sam && all.length) {
    sam.hand.push(...all);
    note(G, `${sam.name} takes ${p.name}'s cards.`);
  } else {
    for (const id of all) discardCard(G, id);
  }
  if (by && by.alive && by.seat !== p.seat) {
    // "Any player eliminating an Outlaw ... must draw a reward of 3 cards"
    if (p.role === 'outlaw') {
      by.hand.push(...drawCards(G, 3));
      note(G, `${by.name} draws three cards as the reward for an Outlaw.`);
    }
    // "If the Sheriff eliminates a Deputy, the Sheriff must discard all the
    // cards he has in hand and in play"
    if (p.role === 'deputy' && by.role === 'sheriff') {
      for (const id of [...by.hand, ...by.table]) discardCard(G, id);
      by.hand = [];
      by.table = [];
      note(G, `${by.name}, the Sheriff, has killed a Deputy and discards every card.`);
    }
  }
  checkEnd(G);
}

// "a) the Sheriff is killed. If the Renegade is the only one alive, then he
// wins. Otherwise, the Outlaws win; b) all the Outlaws and the Renegade are
// killed. The Sheriff and his Deputies win."
function checkEnd(G) {
  const live = alive(G);
  const sheriff = G.players.find((p) => p.role === 'sheriff');
  if (!sheriff.alive) {
    if (live.length === 1 && live[0].role === 'renegade') return endGame(G, 'renegade', `${live[0].name}, the Renegade, is the last one standing`);
    return endGame(G, 'outlaws', 'the Sheriff is dead');
  }
  if (!live.some((p) => p.role === 'outlaw' || p.role === 'renegade')) return endGame(G, 'law', 'every Outlaw and the Renegade are gone');
}

function endGame(G, winner, why) {
  G.phase = 'over';
  G.winner = winner;
  G.why = why;
  G.ask = null;
  G.queue = [];
  note(G, `${{ law: 'The Sheriff and the Deputies win', outlaws: 'The Outlaws win', renegade: 'The Renegade wins' }[winner]} — ${why}.`);
  bump(G, { kind: 'over', winner });
}

export const winners = (G) => G.players.filter((p) => (G.winner === 'law' ? p.role === 'sheriff' || p.role === 'deputy' : G.winner === 'outlaws' ? p.role === 'outlaw' : p.role === 'renegade')).map((p) => p.seat);

// ---------------------------------------------------------------- moves

export function applyMove(G, seat, move) {
  const p = playerBySeat(G, seat);
  if (!p) return { ok: false, error: 'No such player.' };
  if (G.phase === 'over') return { ok: false, error: 'The game is over.' };
  if (!move || typeof move !== 'object') return { ok: false, error: 'No move.' };
  const a = G.ask;
  if (!a || a.seat !== seat) return { ok: false, error: 'It is not your move.' };
  const res = answer(G, p, a, move);
  if (res.ok) advance(G);
  return res;
}

function answer(G, p, a, move) {
  switch (a.kind) {
    case 'turn': {
      if (move.kind === 'end') { G.ask = null; G.step = 'discard'; return { ok: true }; }
      let r;
      G.ask = null;
      if (move.kind === 'sid') r = sidAbility(G, p, move.cards);
      else if (move.kind === 'play') r = playCard(G, p, move);
      else r = { ok: false, error: 'Play a card or end your turn.' };
      if (!r.ok) G.ask = a;
      return r;
    }
    case 'discard': {
      const ids = move.cards;
      if (move.kind === 'sid') {
        const r = sidAbility(G, p, move.cards);
        if (r.ok) { const over = p.hand.length - p.life; if (over > 0) G.ask = { ...a, n: over }; else G.ask = null; }
        return r;
      }
      if (!Array.isArray(ids) || ids.length !== a.n || new Set(ids).size !== ids.length || ids.some((id) => !p.hand.includes(id))) return { ok: false, error: `Discard ${a.n} card${a.n === 1 ? '' : 's'} from your hand.` };
      for (const id of ids) { takeFromHand(p, id); discardCard(G, id); }
      note(G, `${p.name} discards ${ids.length === 1 ? 'a card' : `${ids.length} cards`} at the end of the turn.`);
      G.ask = null;
      nextTurn(G);
      return { ok: true };
    }
    case 'shot': {
      if (move.kind === 'take') {
        G.ask = null;
        G.queue.unshift({ t: 'damage', to: p.seat, from: a.from, amount: 1, cause: a.card === 'gatling' ? 'the Gatling' : 'a BANG!' });
        return { ok: true };
      }
      const ids = move.cards;
      const ok = missedLike(G, p);
      if (!Array.isArray(ids) || ids.length !== a.need || new Set(ids).size !== ids.length || ids.some((id) => !ok.includes(id))) return { ok: false, error: a.need === 2 ? 'Slab the Killer takes two Missed! to stop.' : 'Play a Missed!.' };
      for (const id of ids) { takeFromHand(p, id); discardCard(G, id); }
      G.ask = null;
      note(G, `${p.name} plays ${ids.map((id) => nameOfCard(G, id)).join(' and ')} — missed!`);
      bump(G, { kind: 'missed', seat: p.seat, by: 'card' });
      return { ok: true };
    }
    case 'indians': {
      if (move.kind === 'take') { G.ask = null; G.queue.unshift({ t: 'damage', to: p.seat, from: a.from, amount: 1, cause: 'the Indians' }); return { ok: true }; }
      if (!bangLike(G, p).includes(move.card)) return { ok: false, error: 'Discard a BANG!.' };
      takeFromHand(p, move.card);
      discardCard(G, move.card);
      G.ask = null;
      note(G, `${p.name} discards a ${nameOfCard(G, move.card)} and the Indians pass by.`);
      return { ok: true };
    }
    case 'duel': {
      if (move.kind === 'take') {
        G.ask = null;
        note(G, `${p.name} gives up the Duel.`);
        G.queue.unshift({ t: 'damage', to: p.seat, from: a.from, amount: 1, cause: 'the Duel' });
        return { ok: true };
      }
      if (!bangLike(G, p).includes(move.card)) return { ok: false, error: 'Discard a BANG!.' };
      takeFromHand(p, move.card);
      discardCard(G, move.card);
      G.ask = null;
      note(G, `${p.name} fires back in the Duel.`);
      bump(G, { kind: 'duel-shot', seat: p.seat });
      G.queue.unshift({ t: 'duel', from: a.from, cur: a.other, other: p.seat });
      return { ok: true };
    }
    case 'store': {
      if (!G.store.cards.includes(move.card)) return { ok: false, error: 'Take one of the cards in the General Store.' };
      G.store.cards.splice(G.store.cards.indexOf(move.card), 1);
      p.hand.push(move.card);
      note(G, `${p.name} takes ${nameOfCard(G, move.card)} from the General Store.`);
      G.store.at++;
      G.ask = null;
      G.queue.unshift({ t: 'store' });
      return { ok: true };
    }
    case 'dying': {
      if (move.kind === 'sid') {
        const r = sidAbility(G, p, move.cards);
        if (!r.ok) return r;
        if (p.life > 0 || p.hand.length < 2) G.ask = null;
        return r;
      }
      if (move.kind === 'die') { G.ask = null; return { ok: true }; }
      return { ok: false, error: 'Discard two cards to regain a life point, or fall.' };
    }
    case 'jesse': {
      if (move.from != null && move.from !== 'deck') {
        const q = playerBySeat(G, move.from);
        if (!q || !q.alive || q.seat === p.seat || !q.hand.length) return { ok: false, error: 'Pick a player with cards in hand.' };
        const id = q.hand.splice(Math.floor(Math.random() * q.hand.length), 1)[0];
        p.hand.push(id);
        note(G, `${p.name} draws the first card from ${q.name}'s hand.`);
      } else p.hand.push(...drawCards(G, 1));
      p.hand.push(...drawCards(G, 1));
      G.ask = null;
      G.step = 'play';
      return { ok: true };
    }
    case 'pedro': {
      G.ask = null;
      G.step = 'play';
      if (move.from === 'discard' && G.discard.length) {
        const id = G.discard.pop();
        p.hand.push(id);
        note(G, `${p.name} draws the first card from the discard pile: ${nameOfCard(G, id)}.`);
      } else p.hand.push(...drawCards(G, 1));
      p.hand.push(...drawCards(G, 1));
      return { ok: true };
    }
    case 'kit': {
      const keep = move.keep;
      if (!Array.isArray(keep) || keep.length !== 2 || new Set(keep).size !== 2 || keep.some((id) => !G.look.includes(id))) return { ok: false, error: 'Keep two of the three cards.' };
      const back = G.look.find((id) => !keep.includes(id));
      p.hand.push(...keep);
      G.deck.push(back);
      G.look = null;
      G.ask = null;
      G.step = 'play';
      note(G, `${p.name} keeps two of the top three cards and puts one back.`);
      return { ok: true };
    }
    default: return { ok: false, error: 'Unknown question.' };
  }
}

// "At any time, he may discard 2 cards from his hand to regain one life point"
function sidAbility(G, p, ids) {
  if (p.char !== 'sid') return { ok: false, error: 'Only Sid Ketchum can do that.' };
  if (!Array.isArray(ids) || ids.length !== 2 || new Set(ids).size !== 2 || ids.some((id) => !p.hand.includes(id))) return { ok: false, error: 'Discard two cards from your hand.' };
  if (p.life >= p.max) return { ok: false, error: 'You are already at full life.' };
  for (const id of ids) { takeFromHand(p, id); discardCard(G, id); }
  p.life++;
  note(G, `${p.name} discards two cards to regain a life point.`);
  bump(G, { kind: 'heal', seat: p.seat });
  return { ok: true };
}

// what a card in hand can be played on, on your turn
export function targetsFor(G, p, id) {
  const kind = kindOf(G, id);
  const others = alive(G).filter((q) => q.seat !== p.seat);
  const asBang = kind === 'bang' || (kind === 'missed' && p.char === 'calamity');
  if (asBang) return others.filter((q) => distance(G, p.seat, q.seat) <= rangeOf(G, p)).map((q) => q.seat);
  if (kind === 'panic') return others.filter((q) => distance(G, p.seat, q.seat) <= 1 && (q.hand.length || q.table.length)).map((q) => q.seat);
  if (kind === 'catbalou') return others.filter((q) => q.hand.length || q.table.length).map((q) => q.seat);
  if (kind === 'duel') return others.map((q) => q.seat);
  if (kind === 'jail') return others.filter((q) => q.role !== 'sheriff' && !has(q, G, 'jail')).map((q) => q.seat);
  return null;
}

// why a card cannot be played now, or null
export function cannotPlay(G, p, id) {
  const kind = kindOf(G, id);
  const k = KINDS[kind];
  const asBang = kind === 'bang' || (kind === 'missed' && p.char === 'calamity');
  if (asBang) {
    if (G.bangs >= 1 && p.char !== 'willy' && !has(p, G, 'volcanic')) return 'Only one BANG! a turn — unless you have a Volcanic.';
    if (!targetsFor(G, p, id).length) return 'No one is within reach of your weapon.';
    return null;
  }
  if (kind === 'missed') return 'Missed! is played only to cancel a shot at you.';
  if (k.color === 'blue' && kind !== 'jail') {
    if (!k.weapon && has(p, G, kind)) return `You already have a ${k.name} in play.`;
    if (k.weapon && weaponOf(G, p) != null && kindOf(G, weaponOf(G, p)) === kind) return `You already have a ${k.name} in play.`;
    return null;
  }
  const t = targetsFor(G, p, id);
  if (t && !t.length) return kind === 'panic' ? 'No one with cards is at distance 1.' : kind === 'jail' ? 'There is no one you can put in Jail.' : 'No one to play it on.';
  return null;
}

function playCard(G, p, move) {
  const id = move.card;
  if (!p.hand.includes(id)) return { ok: false, error: 'That card is not in your hand.' };
  const why = cannotPlay(G, p, id);
  if (why) return { ok: false, error: why };
  const kind = kindOf(G, id);
  const k = KINDS[kind];
  const targets = targetsFor(G, p, id);
  let t = null;
  if (targets) {
    if (!targets.includes(move.target)) return { ok: false, error: 'Pick a player that card can reach.' };
    t = playerBySeat(G, move.target);
  }
  // Panic! and Cat Balou: a random card from the hand, or a card in play
  let pick = null;
  if (kind === 'panic' || kind === 'catbalou') {
    if (move.from === 'hand') { if (!t.hand.length) return { ok: false, error: 'They have no cards in hand.' }; pick = 'hand'; }
    else if (t.table.includes(move.pick)) pick = move.pick;
    else return { ok: false, error: 'Pick a card they have in play, or their hand.' };
  }
  takeFromHand(p, id);
  if (t && ['bang', 'missed', 'duel', 'panic', 'catbalou', 'jail'].includes(kind)) G.acts.push({ from: p.seat, to: t.seat, kind });
  const asBang = kind === 'bang' || (kind === 'missed' && p.char === 'calamity');
  const say = (text) => { note(G, text); bump(G, { kind: 'play', seat: p.seat, card: { id, ...G.cards[id] }, target: t ? t.seat : null }); };

  if (k.color === 'blue') {
    if (kind === 'jail') { t.table.push(id); say(`${p.name} puts ${t.name} in Jail.`); return { ok: true }; }
    if (k.weapon) {
      const old = weaponOf(G, p);
      if (old != null) { takeFromTable(p, old); discardCard(G, old); }
    }
    p.table.push(id);
    say(`${p.name} puts ${k.name} in play.`);
    return { ok: true };
  }
  discardCard(G, id);
  if (asBang) {
    G.bangs++;
    say(`${p.name} shoots ${t.name}${kind === 'missed' ? ' with a Missed! as a BANG!' : ''}: BANG!`);
    G.queue.push({ t: 'shot', from: p.seat, to: t.seat, card: 'bang' });
    return { ok: true };
  }
  switch (kind) {
    case 'beer': {
      const before = p.life;
      if (alive(G).length > 2) p.life = Math.min(p.max, p.life + 1);
      say(p.life > before ? `${p.name} drinks a Beer and regains a life point.` : `${p.name} drinks a Beer${alive(G).length <= 2 ? ' — with two players left, it does nothing' : ''}.`);
      return { ok: true };
    }
    case 'saloon':
      for (const q of alive(G)) q.life = Math.min(q.max, q.life + 1);
      say(`${p.name} plays Saloon: everyone in play regains a life point.`);
      return { ok: true };
    case 'stagecoach': p.hand.push(...drawCards(G, 2)); say(`${p.name} plays Stagecoach and draws two cards.`); return { ok: true };
    case 'wellsfargo': p.hand.push(...drawCards(G, 3)); say(`${p.name} plays Wells Fargo and draws three cards.`); return { ok: true };
    case 'generalstore': {
      const live = alive(G);
      const cards = drawCards(G, live.length);
      const i = G.players.indexOf(p);
      const order = [];
      for (let k2 = 0; k2 < G.n; k2++) { const q = G.players[(i + k2) % G.n]; if (q.alive) order.push(q.seat); }
      G.store = { cards, order, at: 0 };
      say(`${p.name} opens the General Store: ${cards.map((c) => nameOfCard(G, c)).join(', ')}.`);
      G.queue.push({ t: 'store' });
      return { ok: true };
    }
    case 'panic': case 'catbalou': {
      let got;
      if (pick === 'hand') got = t.hand.splice(Math.floor(Math.random() * t.hand.length), 1)[0];
      else { takeFromTable(t, pick); got = pick; }
      if (kind === 'panic') {
        p.hand.push(got);
        say(`${p.name} plays Panic! on ${t.name} and takes ${pick === 'hand' ? 'a card from their hand' : nameOfCard(G, got)}.`);
      } else {
        discardCard(G, got);
        say(`${p.name} plays Cat Balou: ${t.name} discards ${nameOfCard(G, got)}${pick === 'hand' ? ' from their hand' : ''}.`);
      }
      return { ok: true };
    }
    case 'gatling':
      say(`${p.name} opens fire with the Gatling!`);
      for (const q of othersFrom(G, p.seat)) G.queue.push({ t: 'shot', from: p.seat, to: q.seat, card: 'gatling' });
      return { ok: true };
    case 'indians':
      say(`${p.name} sends the Indians!`);
      for (const q of othersFrom(G, p.seat)) G.queue.push({ t: 'indians', from: p.seat, to: q.seat });
      return { ok: true };
    case 'duel':
      say(`${p.name} challenges ${t.name} to a Duel.`);
      G.queue.push({ t: 'duel', from: p.seat, cur: t.seat, other: p.seat });
      return { ok: true };
    default: return { ok: false, error: 'That card cannot be played.' };
  }
}

// who the table is waiting on
export const waitingOn = (G) => (G.ask ? [G.ask.seat] : []);

// ---------------------------------------------------------------- disconnection

export function markDisconnected(G, seat) { const p = playerBySeat(G, seat); if (!p || p.bot) return false; p.connected = false; return true; }
export function markReconnected(G, seat) { const p = playerBySeat(G, seat); if (p) { p.connected = true; p.botFor = false; } }
export function markBotTakeover(G, seat) { const p = playerBySeat(G, seat); if (!p || p.bot || p.connected) return false; p.botFor = true; note(G, `A bot takes over for ${p.name}.`); return true; }
export function markSeatClaimed(G, seat, name) { const p = playerBySeat(G, seat); if (!p) return; p.name = name; p.connected = true; p.botFor = false; p.resigned = false; }
export function markSeatResigned(G, seat) { const p = playerBySeat(G, seat); if (!p) return; p.connected = false; p.resigned = true; }

// ---------------------------------------------------------------- views

// A player's view: their own hand and role; everyone's character, life,
// hand size and cards in play; the Sheriff, and the dead, face up. Kit
// Carlson alone sees the three cards he is choosing from.
export function viewFor(G, seat, code, opts = {}) {
  const me = playerBySeat(G, seat);
  const over = G.phase === 'over';
  const face = (id) => ({ id, ...G.cards[id] });
  const myTurn = G.ask && G.ask.kind === 'turn' && G.ask.seat === seat;
  return {
    code, mid: G.mid, you: seat, phase: G.phase, n: G.n,
    turn: current(G).seat, step: G.step,
    deck: G.deck.length,
    discardTop: G.discard.length ? face(G.discard[G.discard.length - 1]) : null,
    discardCount: G.discard.length,
    players: G.players.map((p) => ({
      seat: p.seat, name: p.name, bot: p.bot, connected: p.connected, botFor: !!p.botFor, resigned: !!p.resigned,
      char: p.char, life: p.life, max: p.max, alive: p.alive,
      role: p.role === 'sheriff' || !p.alive || over || p.seat === seat ? p.role : undefined,
      hand: p.hand.length,
      table: p.table.map(face),
      range: rangeOf(G, p),
      dist: me && me.alive && p.alive && p.seat !== seat ? distance(G, seat, p.seat) : null,
    })),
    hand: me ? me.hand.map(face) : [],
    ask: G.ask ? { ...G.ask } : null,
    store: G.store ? { cards: G.store.cards.map(face), order: G.store.order, at: G.store.at } : null,
    look: G.look && G.ask && G.ask.kind === 'kit' && G.ask.seat === seat ? G.look.map(face) : null,
    flips: G.flips,
    bangs: G.bangs,
    fxs: G.fxs,
    playable: myTurn ? Object.fromEntries(me.hand.map((id) => [id, { why: cannotPlay(G, me, id), targets: targetsFor(G, me, id) }])) : null,
    winner: G.winner, why: G.why, winners: over ? winners(G) : null,
    log: G.log.slice(-40),
    revealBots: opts.revealBots ? G.players.filter((p) => p.bot && p.seat !== seat).map((p) => ({ seat: p.seat, role: p.role })) : null,
  };
}

// ---------------------------------------------------------------- bots
//
// A bot knows its own role and the Sheriff's, and reads the rest off what
// the table has done: who has aimed BANG!s, Duels, Panic!, Cat Balou and Jail
// at whom. Shooting the Sheriff marks an Outlaw; shooting the ones who shoot
// the Sheriff marks a friend of the law. The Sheriff and Deputies go after
// the marked; Outlaws go after the Sheriff and his friends; the Renegade
// plays the Sheriff's friend until the two of them are all that is left.

const VALUE = { missed: 6, beer: 6, bang: 5, panic: 5, catbalou: 4, wellsfargo: 6, stagecoach: 5, gatling: 5, indians: 4, duel: 3, generalstore: 3, saloon: 3, barrel: 6, mustang: 5, scope: 4, jail: 4, dynamite: 1, volcanic: 3, schofield: 3, remington: 4, carabine: 4, winchester: 5 };
const value = (G, id) => VALUE[kindOf(G, id)] || 1;

// how much each player has looked like an Outlaw (positive) or a friend of
// the law (negative), as anyone at the table could judge it
function outlawish(G) {
  const sheriff = G.players.find((p) => p.role === 'sheriff').seat;
  const s = {};
  for (const p of G.players) s[p.seat] = 0;
  for (const a of G.acts) if (a.to === sheriff) s[a.from] += 3;
  const first = { ...s };
  for (const a of G.acts) {
    if (a.to === sheriff || a.from === sheriff) continue;
    if (first[a.to] > 0) s[a.from] -= 1.5;
    else if (first[a.to] < 0) s[a.from] += 1;
  }
  // a dead player's role is known
  for (const p of G.players) if (!p.alive) s[p.seat] = p.role === 'outlaw' ? 9 : p.role === 'renegade' ? 4 : -9;
  s[sheriff] = -99;
  return s;
}

// how many of each role are still in play — public: the roles dealt depend
// only on the table's size, and the dead show theirs
function rolesLeft(G) {
  const left = { sheriff: 0, deputy: 0, outlaw: 0, renegade: 0 };
  for (const r of ROLES_FOR[G.n]) left[r]++;
  for (const p of G.players) if (!p.alive) left[p.role]--;
  return left;
}

// whom this bot wants hurt, most wanted first
function enemies(G, me) {
  const s = outlawish(G);
  const others = alive(G).filter((q) => q.seat !== me.seat);
  const sheriff = others.find((q) => q.role === 'sheriff');
  const left = rolesLeft(G);
  const byMark = (list) => list.sort((a, b) => s[b.seat] - s[a.seat]);
  if (me.role === 'outlaw') {
    // the Sheriff above all, then whoever has stood by him
    return others.filter((q) => q.role === 'sheriff' || s[q.seat] < 0).sort((a, b) => (b.role === 'sheriff') - (a.role === 'sheriff') || s[a.seat] - s[b.seat]);
  }
  if (me.role === 'renegade') {
    // help the law against the Outlaws; then the Deputies; the Sheriff last
    if (left.outlaw > 0) return byMark(others.filter((q) => q.role !== 'sheriff' && s[q.seat] > 0));
    const rest = others.filter((q) => q.role !== 'sheriff');
    if (rest.length) return byMark(rest);
    return sheriff ? [sheriff] : [];
  }
  // the law: anyone marked as an Outlaw first
  const foes = left.outlaw + left.renegade;
  if (foes <= 0) return [];
  const suspects = byMark(others.filter((q) => q.role !== 'sheriff'));
  const marked = suspects.filter((q) => s[q.seat] > 0);
  if (marked.length) return marked;
  // nothing marked: the Sheriff, with most of the table against him, goes
  // after the least trustworthy; a Deputy does once every unknown must be a foe
  if (me.role === 'sheriff') return suspects;
  return foes >= suspects.length ? suspects : [];
}

const isFriend = (G, me, q) => {
  if (q.seat === me.seat) return true;
  if (me.role === 'sheriff' || me.role === 'deputy') return q.role === 'sheriff' || outlawish(G)[q.seat] < 0;
  if (me.role === 'renegade') return alive(G).length > 2 && q.role === 'sheriff';
  return false;
};

// the card to take from someone: their best in play, or a blind pick
function bestTake(G, q) {
  const inPlay = q.table.slice().sort((a, b) => value(G, b) - value(G, a));
  const top = inPlay.find((id) => kindOf(G, id) !== 'jail' && kindOf(G, id) !== 'dynamite');
  if (top != null && (value(G, top) >= 4 || !q.hand.length)) return { pick: top };
  if (q.hand.length) return { from: 'hand' };
  return top != null ? { pick: top } : null;
}

export function botChoose(G, seat) {
  const me = playerBySeat(G, seat);
  const a = G.ask;
  if (!me || !a || a.seat !== seat) return null;
  const byValue = (ids) => ids.slice().sort((x, y) => value(G, x) - value(G, y));
  switch (a.kind) {
    case 'shot': {
      const ok = missedLike(G, me);
      // Calamity spends whichever kind she holds more of
      const sorted = ok.slice().sort((x, y) => (kindOf(G, x) === 'missed' ? 0 : 1) - (kindOf(G, y) === 'missed' ? 0 : 1));
      return ok.length >= a.need ? { kind: 'cards', cards: sorted.slice(0, a.need) } : { kind: 'take' };
    }
    case 'indians': case 'duel': {
      const ok = bangLike(G, me);
      if (!ok.length) return { kind: 'take' };
      const real = ok.find((id) => kindOf(G, id) === 'bang');
      return { kind: 'card', card: real != null ? real : ok[0] };
    }
    case 'store': {
      const best = G.store.cards.slice().sort((x, y) => value(G, y) - value(G, x))[0];
      return { kind: 'card', card: best };
    }
    case 'dying': {
      if (me.life <= 0 && me.hand.length >= 2) return { kind: 'sid', cards: byValue(me.hand).slice(0, 2) };
      return { kind: 'die' };
    }
    case 'jesse': {
      const foes = enemies(G, me).filter((q) => q.hand.length >= 2).sort((x, y) => y.hand.length - x.hand.length);
      return foes.length ? { from: foes[0].seat } : { from: 'deck' };
    }
    case 'pedro': {
      const top = G.discard[G.discard.length - 1];
      return { from: top != null && value(G, top) >= 5 ? 'discard' : 'deck' };
    }
    case 'kit': return { keep: G.look.slice().sort((x, y) => value(G, y) - value(G, x)).slice(0, 2) };
    case 'discard': {
      if (me.char === 'sid' && me.life < me.max && me.hand.length >= 2 && a.n >= 2) return { kind: 'sid', cards: byValue(me.hand).slice(0, 2) };
      return { cards: byValue(me.hand).slice(0, a.n) };
    }
    case 'turn': return botTurn(G, me);
    default: return null;
  }
}

function botTurn(G, me) {
  const play = (id, extra = {}) => ({ kind: 'play', card: id, ...extra });
  const hand = me.hand.slice().sort((x, y) => value(G, y) - value(G, x));
  const can = (id) => !cannotPlay(G, me, id);
  const of = (kind) => hand.filter((id) => kindOf(G, id) === kind && can(id));
  const foes = enemies(G, me);
  const others = alive(G).filter((q) => q.seat !== me.seat);
  const friendsHurt = others.filter((q) => isFriend(G, me, q) && q.life < q.max).length;
  const foesHurt = others.filter((q) => !isFriend(G, me, q) && q.life < q.max).length;

  // heal, keeping a Beer back for a lethal hit when there is room to
  const beers = of('beer');
  if (beers.length && me.life < me.max && alive(G).length > 2 && (me.life <= 2 || beers.length > 1)) return play(beers[0]);
  if (of('saloon').length && (me.life < me.max || friendsHurt) && friendsHurt + (me.life < me.max ? 1 : 0) > foesHurt) return play(of('saloon')[0]);
  // more cards first
  for (const k of ['wellsfargo', 'stagecoach']) if (of(k).length) return play(of(k)[0]);
  // things to put in play
  for (const k of ['barrel', 'mustang', 'scope']) if (of(k).length) return play(of(k)[0]);
  const bangsInHand = bangLike(G, me).length;
  const myRange = rangeOf(G, me);
  const weapons = hand.filter((id) => KINDS[kindOf(G, id)].weapon && can(id));
  for (const w of weapons) {
    const r = KINDS[kindOf(G, w)].range;
    if (kindOf(G, w) === 'volcanic') { if (bangsInHand >= 2 && foes.some((q) => distance(G, me.seat, q.seat) <= 1)) return play(w); continue; }
    if (r > myRange) return play(w);
  }
  if (of('jail').length) {
    const t = foes.find((q) => targetsFor(G, me, of('jail')[0]).includes(q.seat));
    if (t) return play(of('jail')[0], { target: t.seat });
  }
  if (of('dynamite').length && me.life >= 3 && Math.random() < 0.5) return play(of('dynamite')[0]);
  // take and spoil what the enemy holds
  for (const k of ['panic', 'catbalou']) {
    for (const id of of(k)) {
      const t = foes.find((q) => targetsFor(G, me, id).includes(q.seat));
      if (!t) continue;
      const take = bestTake(G, t);
      if (take) return play(id, { target: t.seat, ...take });
    }
  }
  if (of('duel').length && bangsInHand >= 2 && foes.length) return play(of('duel')[0], { target: foes[0].seat });
  // shoot the most wanted within reach
  const shots = hand.filter((id) => (kindOf(G, id) === 'bang' || (me.char === 'calamity' && kindOf(G, id) === 'missed')) && can(id));
  const realFirst = shots.sort((x, y) => (kindOf(G, x) === 'bang' ? 0 : 1) - (kindOf(G, y) === 'bang' ? 0 : 1));
  for (const id of realFirst) {
    const t = foes.find((q) => targetsFor(G, me, id).includes(q.seat));
    if (t) return play(id, { target: t.seat });
  }
  const crowd = others.filter((q) => !isFriend(G, me, q)).length - others.filter((q) => isFriend(G, me, q)).length;
  if (of('gatling').length && crowd > 0) return play(of('gatling')[0]);
  if (of('indians').length && crowd > 0) return play(of('indians')[0]);
  if (of('generalstore').length) return play(of('generalstore')[0]);
  // turn surplus cards into life before they are discarded anyway
  if (me.char === 'sid' && me.life < me.max && me.hand.length - me.life >= 2) {
    const spare = me.hand.slice().sort((x, y) => value(G, x) - value(G, y)).slice(0, 2);
    return { kind: 'sid', cards: spare };
  }
  return { kind: 'end' };
}
