// game.js — the rules of So Clover!. No DOM, no network: the host holds the
// only copy of the state and every move goes through applyMove, which is what
// makes it testable.
//
// So Clover! is cooperative: the table scores together, and plays to beat its
// own high score.
//
// The clover. Four Keyword cards sit in the middle of a four-leaf clover, a
// Keyword printed along each edge of each card. Each leaf is a Clue Zone, and
// it touches one outer edge of each of the two cards beside it: those two
// Keywords are its Pair. So every card shows two Keywords outward, on the two
// edges at its corner of the clover, and two inward, which play no part.
//
// 1. Choosing Clues, all at once. Everyone is dealt four cards, laid at random
//    on their own clover, and writes one Clue for each of their four Pairs. A
//    Clue is a single word (compound words are allowed): a common noun, a
//    proper noun, an acronym, a number or an onomatopoeia — not one of your
//    Keywords or its translation, not a word of the same family as a Keyword,
//    not a made-up word. Then the cards come off, one more is drawn unseen and
//    shuffled in with them, and the five lie face down on the clover.
// 2. Resolution, one clover at a time. Its owner is the Spectator and "cannot
//    communicate in any way". The others use the Clues to put the cards back —
//    each in its spot, and turned the right way — and when they disagree, the
//    player to the Spectator's left has the final word.
//    Verification: all four right at the first attempt scores 1 point a card
//    and 2 more for finding them all at once — 6. Otherwise the wrong cards
//    come off, the right ones stay, and the team has a second and final
//    attempt: 1 point for each card right, 0 to 4.
//    The player to the Spectator's left is the next Spectator. When everyone
//    has been the Spectator, the points are added up.
// Add a challenge: the table may agree to add more than one card before the
// Resolution — the same number for every player.
//
// Where it comes from: the publisher's English rulebook (Repos Production,
// SC_Rules_EN, linked from the So Clover! page on rprod.com) — its text, and
// its pictures where the text leaves the detail to them. The pictures put a
// Keyword on every edge of a card and make a leaf's Pair the two edges facing
// it, and the Verification picture marks a card that is in the right spot but
// turned the wrong way as wrong: a card is right only in its spot, the right
// way round.
//
// Where the rulebook leaves it to the people at the table, this one decides:
//   - the first Spectator is drawn at random ("choose the first player");
//   - the guessers agree by each pressing Agree, and the placement is checked
//     the moment they all have; the player to the Spectator's left may lock it
//     in at any time, which is their final decision;
//   - the program checks the placement, in the Spectator's place;
//   - once a clover is scored, its true placement is shown to the table;
//   - of the Clue rules, what a program can check it checks: one word, and not
//     one of your Keywords nor its plural. Translations, word families and
//     made-up words stay with the players — clueWarning flags a Clue that
//     looks like a relative of a Keyword, and the writer decides;
//   - a player who is gone while the Clues are written may have their clover
//     set aside by the host, so the rest can go on without it.

import { WORDS } from './words.js';

export { WORDS };

export const PROTO = 1;
export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 6;
export const EXTRA_MAX = 4;
export const CLUE_MAX = 24;
// all four right at the first attempt: "1 point per card and an extra 2 points"
export const PERFECT = 6;

// The spots go round clockwise from the top left; the leaves, and a card's
// edges, clockwise from the top.
export const SPOT_NAME = ['top left', 'top right', 'bottom right', 'bottom left'];
export const LEAF_NAME = ['top', 'right', 'bottom', 'left'];
// A leaf touches the same edge of the two cards beside it — the top leaf the
// top edges of the two top cards, the right leaf the right edges of the two on
// the right, and so on round — listed here in reading order, left to right and
// top to bottom.
export const LEAF_SPOTS = [[0, 1], [1, 2], [3, 2], [0, 3]];

// A card's four words go round it clockwise from the top: words[0] is on its
// top edge when it lies square (rot 0), and each quarter turn clockwise moves
// every word on to the next edge round.
export const wordAt = (card, rot, edge) => card.words[(((edge - rot) % 4) + 4) % 4];

// The Pair facing a leaf, from what lies in the four spots — each spot
// {card, rot} or empty.
export function pairAt(placed, leaf) {
  return LEAF_SPOTS[leaf].map((s) => (placed[s] ? wordAt(placed[s].card, placed[s].rot, leaf) : null));
}

// ---------------------------------------------------------------- options

// extra: how many cards each player adds before the Resolution — 1, or more
// to add a challenge
export function defaultOpts() {
  return { extra: 1 };
}

export function checkOpts(o) {
  const extra = Math.round(Number(o && o.extra));
  return { extra: extra >= 1 && extra <= EXTRA_MAX ? extra : 1 };
}

export function canStart(n) {
  if (n < MIN_PLAYERS) return `So Clover! is for ${MIN_PLAYERS} to ${MAX_PLAYERS} players — ${MIN_PLAYERS - n} more to go.`;
  if (n > MAX_PLAYERS) return `So Clover! is for ${MIN_PLAYERS} to ${MAX_PLAYERS} players.`;
  return null;
}

// ---------------------------------------------------------------- helpers

export const playerBySeat = (G, seat) => G.players.find((p) => p.seat === seat);
const nameOf = (G, seat) => (playerBySeat(G, seat) || { name: '?' }).name;
const err = (error) => ({ ok: false, error });
const OK = { ok: true };
const roll = (n) => Math.floor(Math.random() * n);

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = roll(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function note(G, text) {
  G.logSeq += 1;
  G.log.push({ id: G.logSeq, text });
  if (G.log.length > 160) G.log.shift();
}

function bump(G, fx) {
  G.fxSeq += 1;
  G.fx = { seq: G.fxSeq, ...fx };
}

const plural = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

// ---------------------------------------------------------------- Clues

// The same letters, whatever the case and the accents: "Café" is "cafe".
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

// What keeps a Clue from being written down, or null. These are the rules a
// program can check: "a single word (compound words are allowed)", and not
// "one of your Keywords" — nor, as the same word, its plural.
export function clueProblem(text, keywords) {
  const t = String(text || '').trim();
  if (!t) return 'Write a Clue for this Pair.';
  if (/\s/.test(t)) return 'A Clue is a single word — a compound word is fine, two words are not.';
  if (t.length > CLUE_MAX) return `One word, ${CLUE_MAX} letters at most.`;
  if (!/[\p{L}\p{N}]/u.test(t)) return 'A Clue needs a letter or a number in it.';
  if (/[^\p{L}\p{N}\p{M}'’\-.&]/u.test(t)) return 'Letters and numbers only — and a hyphen or an apostrophe if the word has one.';
  const n = fold(t);
  for (const k of keywords || []) {
    const kn = fold(k);
    if (!kn) continue;
    if (n === kn || n === `${kn}s` || n === `${kn}es` || kn === `${n}s` || kn === `${n}es`) {
      return `${k} is one of your Keywords — the Clue has to be another word.`;
    }
  }
  return null;
}

// The rule no program can settle — "a word in the same family as a Keyword" —
// flagged when a Clue looks like a Keyword's relative: one inside the other,
// or the same first five letters. Princess and Prince, Station and Stationery.
// Only a warning: Spear is no relative of Pear, and the writer decides.
export function clueWarning(text, keywords) {
  const n = fold(text);
  if (n.length < 3) return null;
  for (const k of keywords || []) {
    const kn = fold(k);
    if (kn.length < 3 || kn === n) continue;
    const [short, long] = n.length <= kn.length ? [n, kn] : [kn, n];
    const inside = short.length >= 4 && (long.startsWith(short) || long.endsWith(short));
    const stem = n.length >= 5 && kn.length >= 5 && n.slice(0, 5) === kn.slice(0, 5);
    if (inside || stem) return `Is that the same family as ${k}? A Keyword's relatives are not allowed.`;
  }
  return null;
}

// ---------------------------------------------------------------- the cards

// A card is four words from the pool, which is shuffled once for the game, so
// no word turns up twice. Its id is random: ids go to every guesser, and one
// that counted up would tell them which card was dealt last — the extra one.
function newCard(G) {
  if (G.deck.length < 4) throw new Error('The Keyword pool has run out.');
  let id;
  do id = `k${Math.random().toString(36).slice(2, 8)}`; while (G.used[id] || id.length < 5);
  G.used[id] = true;
  return { id, words: G.deck.splice(0, 4) };
}

// "Everyone draws 4 Keyword cards and randomly places them on the recessed
// spots" — any card in any spot, any way round.
function dealClover(G, seat) {
  const cards = [newCard(G), newCard(G), newCard(G), newCard(G)];
  const where = shuffle([0, 1, 2, 3]);
  const spots = [];
  cards.forEach((c, i) => { spots[where[i]] = { id: c.id, rot: roll(4) }; });
  return { seat, cards, spots, clues: ['', '', '', ''], done: false, aside: false, extra: [] };
}

const cardOf = (cl, id) => cl.cards.find((c) => c.id === id) || cl.extra.find((c) => c.id === id) || null;

// a clover's four Pairs, in leaf order, each in reading order
export function pairsOf(cl) {
  const placed = cl.spots.map((s) => ({ card: cardOf(cl, s.id), rot: s.rot }));
  return [0, 1, 2, 3].map((leaf) => pairAt(placed, leaf));
}

// "your Keywords": the eight on the outside edges
export const keywordsOf = (cl) => pairsOf(cl).flat();

// ---------------------------------------------------------------- setup

export function newGame(roster, opts = defaultOpts()) {
  const why = canStart(roster.length);
  if (why) throw new Error(why);
  const G = {
    proto: PROTO,
    mid: Math.random().toString(36).slice(2, 10),
    phase: 'clues',
    opts: checkOpts(opts),
    players: roster
      .map((r) => ({ seat: r.seat, name: r.name, connected: r.connected !== false, resigned: false }))
      .sort((a, b) => a.seat - b.seat),
    deck: shuffle(WORDS.slice()),
    used: {},
    clovers: {},
    order: [],
    turn: -1,
    round: null,
    score: 0,
    results: [],
    log: [],
    logSeq: 0,
    fx: null,
    fxSeq: 0,
  };
  for (const p of G.players) G.clovers[p.seat] = dealClover(G, p.seat);
  note(G, 'Four Keyword cards on every clover: write a Clue for each of your four Pairs.');
  bump(G, { kind: 'deal' });
  return G;
}

// ---------------------------------------------------------------- moves

export function applyMove(G, seat, move) {
  if (!G || !move || typeof move !== 'object') return err('Bad move');
  if (!playerBySeat(G, seat)) return err('Not at the table');
  if (G.phase === 'over') return err('The game is over.');
  switch (move.kind) {
    case 'clue': return writeClue(G, seat, move);
    case 'done': return setDone(G, seat, move);
    case 'place': return place(G, seat, move);
    case 'turn': return turnCard(G, seat, move);
    case 'lift': return lift(G, seat, move);
    case 'agree': return agree(G, seat, move);
    case 'lock': return lockIn(G, seat);
    case 'next': return next(G, seat);
    default: return err('Unknown move');
  }
}

// ---- 1. Choosing Clues

function myClover(G, seat) {
  if (G.phase !== 'clues') return err('The Clues have all been written.');
  const cl = G.clovers[seat];
  if (!cl || cl.aside) return err('You have no clover this game.');
  return cl;
}

// A Clue as it is being written — kept as it stands, so a player who drops
// out and comes back finds it again. Only Done holds it to the rules.
function writeClue(G, seat, move) {
  const cl = myClover(G, seat);
  if (cl.ok === false) return cl;
  if (cl.done) return err('Press Edit to change your Clues.');
  const { leaf, text } = move;
  if (!Number.isInteger(leaf) || leaf < 0 || leaf > 3 || typeof text !== 'string') return err('Bad move');
  cl.clues[leaf] = text.replace(/\s+/g, ' ').trim().slice(0, CLUE_MAX + 8);
  return OK;
}

function setDone(G, seat, move) {
  const cl = myClover(G, seat);
  if (cl.ok === false) return cl;
  if (move.on === false) {
    cl.done = false;
    return OK;
  }
  if (cl.done) return OK;
  // the four Clues may come with it, as they stand in the writer's boxes
  if (move.clues !== undefined) {
    if (!Array.isArray(move.clues) || move.clues.length !== 4 || move.clues.some((c) => typeof c !== 'string')) return err('Bad move');
    cl.clues = move.clues.map((c) => c.replace(/\s+/g, ' ').trim().slice(0, CLUE_MAX + 8));
  }
  const kw = keywordsOf(cl);
  for (let leaf = 0; leaf < 4; leaf++) {
    const why = clueProblem(cl.clues[leaf], kw);
    if (why) return err(`The ${LEAF_NAME[leaf]} leaf: ${why}`);
  }
  cl.done = true;
  note(G, `${nameOf(G, seat)} has written their four Clues.`);
  maybeResolve(G);
  return OK;
}

// The host may set aside the clover of a player who is not there to finish
// it, and the table plays on without it.
export function setAside(G, seat) {
  if (G.phase !== 'clues') return false;
  const cl = G.clovers[seat];
  const p = playerBySeat(G, seat);
  if (!cl || cl.done || cl.aside || !p || p.connected) return false;
  cl.aside = true;
  note(G, `${p.name}'s clover is set aside — it will not be played.`);
  maybeResolve(G);
  return true;
}

function maybeResolve(G) {
  const all = G.players.map((p) => G.clovers[p.seat]);
  if (all.every((cl) => cl.done || cl.aside) && all.some((cl) => cl.done)) startResolution(G);
}

function startResolution(G) {
  const live = G.players.map((p) => p.seat).filter((s) => G.clovers[s].done && !G.clovers[s].aside);
  for (const s of live) {
    // one more card each, drawn unseen and shuffled in with the four
    G.clovers[s].extra = Array.from({ length: G.opts.extra }, () => newCard(G));
  }
  // "choose the first player to be the Spectator": the table draws one, and
  // from them it goes round to the left
  const first = roll(live.length);
  G.order = [...live.slice(first), ...live.slice(0, first)];
  G.phase = 'resolve';
  G.turn = 0;
  note(G, `Every Clue is written. ${plural(G.opts.extra, 'card')} added to each clover; ${nameOf(G, G.order[0])} is the first Spectator.`);
  beginRound(G);
}

// ---- 2. Resolution

function beginRound(G) {
  const seat = G.order[G.turn];
  const cl = G.clovers[seat];
  G.round = {
    seat,
    attempt: 1,
    board: [null, null, null, null],
    // face up in the middle of the table, each lying whichever way it fell
    tray: shuffle([...cl.cards, ...cl.extra]).map((c) => ({ id: c.id, rot: roll(4) })),
    agree: [],
    first: null,
    right: null,
    done: false,
    points: 0,
    perfect: false,
    ready: [],
  };
  note(G, `${nameOf(G, seat)}'s clover. ${nameOf(G, seat)} is the Spectator and says nothing; the others put the cards back.`);
  bump(G, { kind: 'round', seat });
}

// the player to the Spectator's left has the final word when the others
// disagree — or, if they are not there, the next one round who is
export function deciderOf(G) {
  const r = G.round;
  if (!r) return null;
  const seats = G.players.map((p) => p.seat);
  const i = seats.indexOf(r.seat);
  for (let k = 1; k < seats.length; k++) {
    const s = seats[(i + k) % seats.length];
    if (playerBySeat(G, s).connected) return s;
  }
  return seats[(i + 1) % seats.length];
}

// the players putting the cards back who are still at the table
const guessersIn = (G) => G.players.filter((p) => p.seat !== G.round.seat && p.connected).map((p) => p.seat);

// The Spectator "cannot communicate in any way" until their clover is checked.
export function silenced(G) {
  return G.phase === 'resolve' && G.round && !G.round.done ? G.round.seat : null;
}

function asGuesser(G, seat) {
  const r = G.round;
  if (G.phase !== 'resolve' || !r) return err('No clover is being put back.');
  if (r.done) return err('This clover has been checked.');
  if (seat === r.seat) return err('You are the Spectator: hands off, and not a word.');
  return null;
}

function findCard(r, id) {
  const t = r.tray.findIndex((x) => x.id === id);
  if (t >= 0) return { where: 'tray', i: t, it: r.tray[t] };
  const s = r.board.findIndex((x) => x && x.id === id);
  if (s >= 0) return { where: 'board', i: s, it: r.board[s] };
  return null;
}

const boardFull = (r) => r.board.every(Boolean);

// A card into a spot, from the middle of the table or from another spot. A
// card already there trades places with it — back to the middle, or into the
// spot the card came from. Any change to the clover takes back every Agree.
function place(G, seat, move) {
  const no = asGuesser(G, seat);
  if (no) return no;
  const r = G.round;
  const { spot } = move;
  if (!Number.isInteger(spot) || spot < 0 || spot > 3) return err('Bad move');
  const f = findCard(r, move.card);
  if (!f) return err('That card is not on the table.');
  if (f.it.fixed) return err('That card is right — it stays where it is.');
  const there = r.board[spot];
  if (there && there.fixed) return err('The card in that spot is right — it stays.');
  if (f.where === 'board' && f.i === spot) return OK;
  if (f.where === 'tray') r.tray.splice(f.i, 1);
  else r.board[f.i] = null;
  if (there) {
    if (f.where === 'board') r.board[f.i] = there;
    else r.tray.splice(f.i, 0, there);
  }
  r.board[spot] = { id: f.it.id, rot: f.it.rot };
  r.agree = [];
  return OK;
}

// A quarter turn, clockwise or back — in a spot or in the middle.
function turnCard(G, seat, move) {
  const no = asGuesser(G, seat);
  if (no) return no;
  const r = G.round;
  const f = findCard(r, move.card);
  if (!f) return err('That card is not on the table.');
  if (f.it.fixed) return err('That card is right — it stays as it is.');
  f.it.rot = (f.it.rot + (move.dir === -1 ? 3 : 1)) % 4;
  if (f.where === 'board') r.agree = [];
  return OK;
}

// A card out of its spot, back to the middle.
function lift(G, seat, move) {
  const no = asGuesser(G, seat);
  if (no) return no;
  const r = G.round;
  const f = findCard(r, move.card);
  if (!f || f.where !== 'board') return err('That card is not on the clover.');
  if (f.it.fixed) return err('That card is right — it stays where it is.');
  r.board[f.i] = null;
  r.tray.push(f.it);
  r.agree = [];
  return OK;
}

// Once the players agree on where the cards go, the clover is checked.
function agree(G, seat, move) {
  const no = asGuesser(G, seat);
  if (no) return no;
  const r = G.round;
  const on = move.on !== false;
  if (on && !boardFull(r)) return err('Put a card in all four spots first.');
  r.agree = r.agree.filter((s) => s !== seat);
  if (on) r.agree.push(seat);
  if (on && guessersIn(G).every((s) => r.agree.includes(s))) verify(G);
  return OK;
}

function lockIn(G, seat) {
  const no = asGuesser(G, seat);
  if (no) return no;
  const d = deciderOf(G);
  if (seat !== d) return err(`${nameOf(G, d)} sits to the Spectator's left and has the final say.`);
  if (!boardFull(G.round)) return err('Put a card in all four spots first.');
  verify(G);
  return OK;
}

// A card is right in its own spot, turned the way it was dealt.
function verify(G) {
  const r = G.round;
  const sol = G.clovers[r.seat].spots;
  const right = r.board.map((b, s) => !!b && b.id === sol[s].id && b.rot === sol[s].rot);
  const n = right.filter(Boolean).length;
  const spect = nameOf(G, r.seat);
  if (r.attempt === 1) {
    r.first = right.slice();
    if (n === 4) {
      note(G, `All four right at the first attempt — a perfect clover: 4 points and 2 more, 6.`);
      return finish(G, right, PERFECT, true);
    }
    // the Spectator, without a word, takes the wrong cards back to the middle
    // of the table; the right ones stay
    r.board = r.board.map((b, s) => {
      if (right[s]) return { ...b, fixed: true };
      r.tray.push({ id: b.id, rot: b.rot });
      return null;
    });
    r.attempt = 2;
    r.agree = [];
    note(G, `First attempt: ${plural(n, 'card')} right. ${spect} takes the other ${4 - n} off — a second and final attempt.`);
    bump(G, { kind: 'check', seat: r.seat, attempt: 1, right: n });
    return;
  }
  // after the second, the wrong ones come off and the right ones score
  r.board = r.board.map((b, s) => {
    if (right[s]) return b;
    r.tray.push({ id: b.id, rot: b.rot });
    return null;
  });
  note(G, `Second attempt: ${plural(n, 'card')} right — ${plural(n, 'point')}.`);
  finish(G, right, n, false);
}

function finish(G, right, points, perfect) {
  const r = G.round;
  const cl = G.clovers[r.seat];
  r.right = right.slice();
  r.done = true;
  r.points = points;
  r.perfect = perfect;
  r.agree = [];
  r.ready = [];
  G.score += points;
  G.results.push({ seat: r.seat, points, perfect, attempts: r.attempt, first: r.first.slice(), right: right.slice(), clues: cl.clues.slice(), pairs: pairsOf(cl) });
  bump(G, { kind: 'scored', seat: r.seat, points, perfect });
}

// Everyone at the table says when they have seen enough of a scored clover.
function next(G, seat) {
  const r = G.round;
  if (G.phase !== 'resolve' || !r || !r.done) return err('This clover has not been checked yet.');
  if (!r.ready.includes(seat)) r.ready.push(seat);
  settle(G);
  return OK;
}

// Whatever the table was waiting on that no longer waits on anybody: everyone
// left has agreed, or everyone left is ready for the next clover.
function settle(G) {
  const r = G.round;
  if (G.phase !== 'resolve' || !r) return;
  if (!r.done) {
    const left = guessersIn(G);
    if (left.length && boardFull(r) && r.agree.length && left.every((s) => r.agree.includes(s))) verify(G);
    return;
  }
  if (G.players.every((p) => !p.connected || r.ready.includes(p.seat))) advance(G);
}

function advance(G) {
  G.turn += 1;
  if (G.turn >= G.order.length) return endGame(G);
  beginRound(G);
}

function endGame(G) {
  G.phase = 'over';
  G.round = null;
  const max = PERFECT * G.order.length;
  note(G, `Every clover is back together: the team scores ${G.score} of a possible ${max}.`);
  bump(G, { kind: 'over', score: G.score });
}

// ---------------------------------------------------------------- the seats

export function markDisconnected(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p || !p.connected) return false;
  p.connected = false;
  settle(G);
  return true;
}

export function markReconnected(G, seat) {
  const p = playerBySeat(G, seat);
  if (p) p.connected = true;
}

export function markSeatClaimed(G, seat, name) {
  const p = playerBySeat(G, seat);
  if (!p) return;
  p.name = name;
  p.connected = true;
  p.resigned = false;
}

export function markSeatResigned(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p) return;
  p.connected = false;
  p.resigned = true;
  settle(G);
}

// What the table is waiting for, and on whom.
export function waitingOn(G) {
  if (G.phase === 'clues') return G.players.filter((p) => !G.clovers[p.seat].done && !G.clovers[p.seat].aside).map((p) => p.seat);
  const r = G.round;
  if (G.phase !== 'resolve' || !r) return [];
  if (r.done) return G.players.filter((p) => p.connected && !r.ready.includes(p.seat)).map((p) => p.seat);
  return guessersIn(G).filter((s) => !r.agree.includes(s));
}

// ---------------------------------------------------------------- views

// What one seat sees. While the Clues are written, a player sees their own
// cards and Clues and only whether the others are done. While a clover is put
// back, everyone sees its Clues and the cards on the table; its true placement
// only its Spectator — and the whole table once it is scored. Watchers see
// what anybody at the table sees, and nothing anybody keeps to themselves.
export function viewFor(G, seat, code, opts = {}) {
  const me = opts.observer ? null : playerBySeat(G, seat);
  const r = G.round;
  const played = G.phase === 'clues' ? G.players.filter((p) => !G.clovers[p.seat].aside).length : G.order.length;
  const v = {
    code,
    mid: G.mid,
    you: seat,
    phase: G.phase,
    opts: { ...G.opts },
    players: G.players.map((p) => {
      const cl = G.clovers[p.seat];
      return { seat: p.seat, name: p.name, connected: p.connected, resigned: !!p.resigned, done: !!cl.done, aside: !!cl.aside };
    }),
    order: G.order.slice(),
    turn: G.turn,
    score: G.score,
    max: PERFECT * played,
    results: G.results.map((x) => ({ ...x, first: x.first.slice(), right: x.right.slice(), clues: x.clues.slice(), pairs: x.pairs.map((p) => p.slice()) })),
    decider: r ? deciderOf(G) : null,
    silenced: silenced(G),
    waiting: waitingOn(G),
    log: G.log.slice(-60),
    fx: G.fx,
  };
  if (G.phase === 'clues' && me) {
    const cl = G.clovers[seat];
    v.mine = {
      cards: cl.cards.map((c) => ({ id: c.id, words: c.words.slice() })),
      spots: cl.spots.map((s) => ({ id: s.id, rot: s.rot })),
      clues: cl.clues.slice(),
      done: cl.done,
      aside: cl.aside,
    };
  }
  if (r) {
    const cl = G.clovers[r.seat];
    const words = (id) => cardOf(cl, id).words.slice();
    const open = r.done || (!!me && seat === r.seat);
    v.round = {
      seat: r.seat,
      attempt: r.attempt,
      done: r.done,
      points: r.points,
      perfect: r.perfect,
      clues: cl.clues.slice(),
      board: r.board.map((b) => (b ? { id: b.id, rot: b.rot, fixed: !!b.fixed, words: words(b.id) } : null)),
      tray: r.tray.map((t) => ({ id: t.id, rot: t.rot, words: words(t.id) })),
      agree: r.agree.slice(),
      ready: r.ready.slice(),
      first: r.first ? r.first.slice() : null,
      right: r.right ? r.right.slice() : null,
      solution: open ? cl.spots.map((s) => ({ id: s.id, rot: s.rot, words: words(s.id) })) : null,
      extra: r.done ? cl.extra.map((c) => c.id) : null,
    };
  }
  return v;
}
