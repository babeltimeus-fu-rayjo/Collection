// game.js — the rules of Coup, with the Reformation expansion. No DOM, no
// network: the host holds the only copy of the state and every move goes
// through applyMove, which is what makes it testable.
//
// Every player has two face-down character cards — their influence — and
// some coins. On a turn a player takes one action. A character action is a
// claim to hold that character, true or not, and any other player may
// challenge it; some actions can be blocked by claiming another character,
// and a block may be challenged in turn. Whoever loses a challenge, or is the
// target of a Coup or an assassination, turns a card face up; with both face
// up they are exiled. The last player with influence wins.
//
// Reformation adds Allegiances: Loyalists and Reformists may not Coup,
// Assassinate, Steal from, Examine or block the Foreign Aid of their own side
// unless everyone left is on one side. Conversion changes a side for coins
// paid onto the Treasury Reserve, and Embezzlement takes them all — by
// claiming *not* to hold the Duke. Its Inquisitor may replace the
// Ambassador, and its extra cards take the table up to ten.
//
// Where it comes from: the Coup rulebook (Indie Boards & Cards), read from
// RulesPal's transcription and checked against the publisher-verified rules
// on Dized, whose FAQ settles the order of things — a challenge to an action
// is resolved before anyone blocks it, and Steal needs a target "who has some
// coins"; the Reformation rulebook, read from UltraBoardGames' transcription.

// Coins come from and go back to the Treasury, which never runs out here —
// the box has 50, and the rulebook says nothing of running short.

export const PROTO = 1;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 10;
export const COUP_COST = 7;
export const MUST_COUP = 10;
export const ASSASSIN_COST = 3;

// ---------------------------------------------------------------- the cards

export const CHARS = {
  duke: { name: 'Duke', does: 'Tax: take 3 coins from the Treasury. Blocks Foreign Aid.' },
  assassin: { name: 'Assassin', does: 'Assassinate: pay 3 coins, and another player loses an influence. The Contessa blocks it.' },
  captain: { name: 'Captain', does: 'Steal: take 2 coins from another player. Blocks stealing.' },
  ambassador: { name: 'Ambassador', does: 'Exchange: draw 2 cards from the Court deck, keep what you like, return 2. Blocks stealing.' },
  contessa: { name: 'Contessa', does: 'Blocks an assassination aimed at you.' },
  inquisitor: { name: 'Inquisitor', does: 'Exchange: draw 1 card from the Court deck, keep what you like, return 1 — or Examine: look at one of another player’s cards and may make them exchange it. Blocks stealing.' },
};

// "Remove all the Ambassador character cards from the Court deck and replace
// with Inquisitor cards" (Reformation's Inquisitor variant)
export const exchangerOf = (o) => (o.inquisitor ? 'inquisitor' : 'ambassador');
export const charsFor = (o) => ['duke', 'assassin', 'captain', exchangerOf(o), 'contessa'];

// 15 cards, "3 each", in the box; Reformation's More Than Six Player
// Variant: "4 each of the selected character cards ... (20 cards total)" at
// seven or eight, "5 each ... (25 cards total)" at nine or ten
export const copiesFor = (n) => (n <= 6 ? 3 : n <= 8 ? 4 : 5);

export const ACTIONS = {
  income: { name: 'Income', text: 'Take 1 coin from the Treasury.' },
  foreignAid: { name: 'Foreign Aid', text: 'Take 2 coins from the Treasury. Any player claiming the Duke may block it.' },
  coup: { name: 'Coup', cost: COUP_COST, text: 'Pay 7 coins: another player loses an influence. A Coup is always successful.' },
  tax: { name: 'Tax', text: 'Claim the Duke: take 3 coins from the Treasury.' },
  assassinate: { name: 'Assassinate', cost: ASSASSIN_COST, text: 'Claim the Assassin and pay 3 coins: another player loses an influence. The target may block it with the Contessa.' },
  steal: { name: 'Steal', text: 'Claim the Captain: take 2 coins from another player (1 if that is all they have).' },
  exchange: { name: 'Exchange', text: 'Swap cards with the Court deck.' },
  examine: { name: 'Examine', text: 'Claim the Inquisitor: another player shows you one of their cards; hand it back, or make them draw a new one and return it to the Court deck.' },
  convert: { name: 'Conversion', text: 'Pay 1 coin onto the Treasury Reserve to change your Allegiance, or 2 to change another player’s.' },
  embezzle: { name: 'Embezzlement', text: 'Claim not to hold the Duke, and take all the coins on the Treasury Reserve.' },
};

// the character an action claims
export const claimOf = (o, type) => ({ tax: 'duke', assassinate: 'assassin', steal: 'captain', exchange: exchangerOf(o), examine: 'inquisitor' })[type] || null;
// the characters that block it
export const blockersOf = (o, type) => ({ foreignAid: ['duke'], assassinate: ['contessa'], steal: ['captain', exchangerOf(o)] })[type] || [];
const TARGETED = ['coup', 'assassinate', 'steal', 'examine'];

export const SIDES = { loyalist: 'Loyalist', reformist: 'Reformist' };
export const otherSide = (s) => (s === 'loyalist' ? 'reformist' : 'loyalist');

// ---------------------------------------------------------------- options

export function defaultOpts() {
  return {
    reformation: false, // Allegiances, Conversion, Embezzlement and the Treasury Reserve
    inquisitor: false,  // the Inquisitor in place of the Ambassador
    twoPlayer: false,   // the two-player variant's set-up, at a table of two
  };
}

export function checkOpts(opts) {
  if (!opts || typeof opts !== 'object') return 'No options.';
  for (const k of Object.keys(defaultOpts())) if (opts[k] !== undefined && typeof opts[k] !== 'boolean') return `${k} is on or off.`;
  return null;
}

export function canStart(n, opts) {
  if (n < MIN_PLAYERS) return 'Needs two players at least — add a bot to play.';
  if (n > MAX_PLAYERS) return `At most ${MAX_PLAYERS} players.`;
  return checkOpts(opts);
}

// what the rulebooks say about the table the lobby has
export function advice(n, opts) {
  const out = [];
  if (n > 6) out.push('Seven or more: “Playing with more than 6 players can significantly increase playing time, and may lead to long waits for those that are eliminated early.”');
  if (opts.twoPlayer && n !== 2) out.push('The two-player variant only changes a game of two.');
  return out;
}

// ---------------------------------------------------------------- basics

export const playerBySeat = (G, seat) => G.players.find((p) => p.seat === seat);
const clone = (x) => JSON.parse(JSON.stringify(x));

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
  if (G.log.length > 160) G.log.shift();
}

function bump(G, fx) {
  G.fxSeq = (G.fxSeq || 0) + 1;
  G.fx = { seq: G.fxSeq, ...fx };
}

const nameOf = (G, seat) => (playerBySeat(G, seat) || { name: '?' }).name;
const charName = (c) => CHARS[c].name;
const listWords = (a) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
const coins = (k) => `${k} coin${k === 1 ? '' : 's'}`;
const faceDown = (p) => p.cards.filter((c) => !c.up);
export const influence = (p) => faceDown(p).length;
const living = (G) => G.players.filter((p) => !p.out);
const err = (error) => ({ ok: false, error });
const OK = { ok: true };

// "A player cannot Coup, Assassinate, Steal from nor block a Foreign Aid
// attempt by another player of the same Allegiance unless all players are of
// the same Allegiance" — and "cannot Examine another player of the same
// Allegiance" either. All players: those still in the game.
export const oneSide = (G) => { const l = living(G); return l.every((p) => p.side === l[0].side); };
export const mayTarget = (G, a, b) => !G.opts.reformation || a.side !== b.side || oneSide(G);

// ---------------------------------------------------------------- setup

// `first`: the index in the roster of the player who starts — "The person
// who won the last game starts" — or a random one.
export function newGame(roster, opts = defaultOpts(), { first } = {}) {
  const n = roster.length;
  const o = { ...defaultOpts(), ...clone(opts) };
  const why = canStart(n, o);
  if (why) throw new Error(why);
  const variant = o.twoPlayer && n === 2;
  if (!variant) o.twoPlayer = false;
  const chars = charsFor(o);
  const copies = variant ? 3 : copiesFor(n);
  const cards = [];
  for (const c of chars) for (let i = 0; i < copies; i++) cards.push({ id: cards.length, char: c });
  const start = Number.isInteger(first) && first >= 0 && first < n ? first : Math.floor(Math.random() * n);
  const G = {
    mid: Math.random().toString(36).slice(2, 10),
    phase: 'setup',
    n,
    opts: o,
    copies,
    players: roster.map((r) => ({
      seat: r.seat,
      name: r.name,
      bot: !!r.bot,
      connected: r.bot ? true : r.connected !== false,
      coins: 2,
      cards: [],         // { id, char, up }: up = turned face up, an influence lost
      side: null,        // 'loyalist' | 'reformist', with Reformation
      out: false,        // exiled
    })),
    deck: [],            // the Court deck, kept shuffled
    reserve: 0,          // the Treasury Reserve, with Reformation
    start,
    turn: start,         // index into players of whoever is acting
    turns: 0,
    act: null,           // the action under way: { type, actor, target, claim, paid, block, pre }
    window: null,        // a question to several players: { kind, of, claimant, claim, waiting }
    ask: null,           // a question to one player: { kind, seat, ... }
    challenge: null,     // the challenge being settled
    todo: [],            // what happens next, in order
    claims: [],          // every claim made, and how it ended — public
    looks: [],           // cards the Inquisitor saw — each to the one who looked
    winner: null,
    why: '',
    log: [],
  };
  // "When playing Coup with two players, the starting player receives only 1
  // coin at the beginning of the game."
  if (n === 2) G.players[start].coins = 1;
  if (variant) {
    // "Divide the cards into a 3 sets of 5 (each set has one of each
    // character). Each player takes one set, secretly chooses one card and
    // discards the rest. Shuffle the third set and deal one card to each
    // player and then put the remaining three cards face down as the court deck."
    const sets = [0, 1, 2].map((k) => chars.map((c) => cards.filter((x) => x.char === c)[k]));
    G.players.forEach((p, i) => { p.set = sets[i]; });
    const third = shuffle(sets[2].slice());
    for (const p of G.players) p.cards.push({ ...third.shift(), up: false });
    G.deck = third;
    G.window = { kind: 'pick', waiting: G.players.map((p) => p.seat) };
  } else {
    G.deck = shuffle(cards);
    for (let r = 0; r < 2; r++) for (const p of G.players) p.cards.push({ ...G.deck.shift(), up: false });
  }
  note(G, `${n} players${variant ? ', with the two-player variant’s set-up' : ''}. ${G.players[start].name} starts${n === 2 ? ', with only 1 coin' : ''}.`);
  if (variant) note(G, 'Each player secretly chooses one card from a set of the five characters; the second is dealt from the third set.');
  if (o.reformation) G.todo.push({ t: 'side' });
  G.todo.push({ t: 'begin' });
  bump(G, { kind: 'start' });
  advance(G);
  return G;
}

// Deal these characters, two to each player in seat order, and start over
// with this player first — for tests that need a table set up just so.
export function redeal(G, hands, first = G.start, sides = null) {
  const all = [...G.deck, ...G.players.flatMap((p) => p.cards)].map(({ id, char }) => ({ id, char }));
  G.players.forEach((p, i) => {
    p.cards = hands[i].map((ch) => {
      const k = all.findIndex((c) => c.char === ch);
      if (k < 0) throw new Error(`no ${ch} left to deal`);
      return { ...all.splice(k, 1)[0], up: false };
    });
    p.coins = 2;
    p.out = false;
    p.set = null;
    if (sides) p.side = sides[i];
  });
  G.deck = shuffle(all);
  if (G.n === 2) G.players[first].coins = 1;
  G.start = first;
  G.turn = first;
  G.act = null;
  G.window = null;
  G.ask = null;
  G.challenge = null;
  G.todo = [{ t: 'begin' }];
  G.claims = [];
  G.looks = [];
  G.phase = 'setup';
  advance(G);
  return G;
}

// ---------------------------------------------------------------- the flow

// Run what comes next until someone has to decide something.
function advance(G) {
  for (let guard = 0; guard < 500; guard++) {
    if (G.phase === 'over' || G.ask || G.window) return;
    const step = G.todo.shift();
    if (!step) return;
    run(G, step);
  }
}

function run(G, step) {
  switch (step.t) {
    case 'side':
      // "The start player chooses an Allegiance (either Loyalist or Reformist)"
      G.ask = { kind: 'side', seat: G.players[G.start].seat };
      return;
    case 'begin':
      G.phase = 'play';
      return beginTurn(G);
    case 'next': {
      for (let k = 1; k <= G.n; k++) {
        const i = (G.turn + k) % G.n;
        if (!G.players[i].out) { G.turn = i; break; }
      }
      return beginTurn(G);
    }
    case 'lose': return loseStep(G, step);
    case 'after': return afterChallenge(G);
    case 'block': return openBlock(G);
    case 'resolve': return resolve(G);
    default:
  }
}

function beginTurn(G) {
  const p = G.players[G.turn];
  G.act = null;
  G.challenge = null;
  G.turns++;
  G.ask = { kind: 'act', seat: p.seat };
}

// the turn is over: on to the next player, after whatever is still queued
function endTurn(G) {
  G.todo.push({ t: 'next' });
}

// ---------------------------------------------------------------- moves

export function applyMove(G, seat, move) {
  const p = playerBySeat(G, seat);
  if (!p) return err('No such player.');
  if (!move || typeof move !== 'object') return err('No move.');
  if (G.phase === 'over') return err('The game is over.');
  let r;
  if (G.window) {
    if (!G.window.waiting.includes(seat)) return err('That is not yours to do now.');
    r = respond(G, p, G.window, move);
  } else {
    const a = G.ask;
    if (!a || a.seat !== seat || a.kind !== move.kind) return err('That is not yours to do now.');
    r = answer(G, p, a, move);
    if (r.ok && G.ask === a) G.ask = null;
  }
  if (r.ok) advance(G);
  return r;
}

function answer(G, p, a, move) {
  switch (a.kind) {
    case 'act': return declare(G, p, move);
    case 'side': {
      if (!SIDES[move.side]) return err('Choose Loyalist or Reformist.');
      // "Going clockwise around the table, each player alternates Allegiance
      // from the previous player"
      for (let k = 0; k < G.n; k++) G.players[(G.start + k) % G.n].side = k % 2 === 0 ? move.side : otherSide(move.side);
      note(G, `${p.name} chooses to be a ${SIDES[move.side]}; round the table the Allegiances alternate.`);
      bump(G, { kind: 'sides' });
      return OK;
    }
    case 'prove': return prove(G, p, move.show === true);
    case 'lose': {
      const c = p.cards.find((x) => x.id === move.card && !x.up);
      if (!c) return err('Choose one of your face-down cards.');
      reveal(G, p, c);
      return OK;
    }
    case 'exchange': return exchange(G, p, a, move.keep);
    case 'show': {
      // "the selected opponent chooses one of their face down cards to show to the Inquisitor"
      const c = p.cards.find((x) => x.id === move.card && !x.up);
      if (!c) return err('Show one of your face-down cards.');
      G.looks.push({ by: a.to, target: p.seat, char: c.char, turn: G.turns });
      note(G, `${p.name} shows a card to ${nameOf(G, a.to)}.`);
      G.ask = { kind: 'examine', seat: a.to, target: p.seat, card: c.id, char: c.char };
      return OK;
    }
    case 'examine': {
      const t = playerBySeat(G, a.target);
      const c = t.cards.find((x) => x.id === a.card);
      if (move.swap === true) {
        // "the Inquisitor may force the opponent to draw a new card randomly
        // from the Court deck before returning the given card to the Court deck"
        const i = t.cards.indexOf(c);
        t.cards[i] = { ...G.deck.shift(), up: false };
        G.deck.push({ id: c.id, char: c.char });
        shuffle(G.deck);
        note(G, `${p.name} makes ${t.name} draw a new card and return that one to the Court deck.`);
        bump(G, { kind: 'examined', seat: p.seat, target: t.seat, swap: true });
      } else if (move.swap === false) {
        note(G, `${p.name} hands the card back.`);
        bump(G, { kind: 'examined', seat: p.seat, target: t.seat, swap: false });
      } else return err('Hand the card back, or make them exchange it.');
      endTurn(G);
      return OK;
    }
    default:
      return err('Unknown move.');
  }
}

// ---------------------------------------------------------------- actions

function declare(G, p, move) {
  const o = G.opts;
  const type = move.action;
  if (!ACTIONS[type]) return err('Choose an action.');
  if ((type === 'convert' || type === 'embezzle') && !o.reformation) return err('Conversion and Embezzlement come with Reformation.');
  if (type === 'examine' && !o.inquisitor) return err('Examine is the Inquisitor’s.');
  // "If a player starts their turn with 10 (or more) coins they must launch a
  // Coup that turn as their only action."
  if (p.coins >= MUST_COUP && type !== 'coup') return err('With 10 coins or more you must launch a Coup.');
  let t = null;
  if (TARGETED.includes(type)) {
    t = playerBySeat(G, move.target);
    if (!t || t === p || t.out) return err('Choose another player still in the game.');
    if (!mayTarget(G, p, t)) return err(`${t.name} is a ${SIDES[t.side]} like you: not while both Allegiances are at the table.`);
  }
  if (type === 'coup' && p.coins < COUP_COST) return err('A Coup costs 7 coins.');
  if (type === 'assassinate' && p.coins < ASSASSIN_COST) return err('Assassination costs 3 coins.');
  // "Choose another player who has some coins" (Dized)
  if (type === 'steal' && t.coins === 0) return err(`${t.name} has no coins to steal.`);
  // "Pay 1 coin to change your Allegiance or pay 2 coins to change the
  // Allegiance of one other player."
  if (type === 'convert') {
    t = move.target == null || move.target === p.seat ? p : playerBySeat(G, move.target);
    if (!t || t.out) return err('Convert yourself, or another player still in the game.');
    if (p.coins < (t === p ? 1 : 2)) return err(`That Conversion costs ${coins(t === p ? 1 : 2)}.`);
  }
  const claim = claimOf(o, type);
  G.act = { type, actor: p.seat, target: t ? t.seat : null, claim, paid: 0, block: null, pre: null };
  const on = t ? ` on ${t.name}` : '';
  switch (type) {
    case 'income':
      p.coins += 1;
      note(G, `${p.name} takes Income: 1 coin.`);
      bump(G, { kind: 'act', seat: p.seat, type });
      endTurn(G);
      return OK;
    case 'coup':
      p.coins -= COUP_COST;
      note(G, `${p.name} pays 7 coins and launches a Coup against ${t.name}.`);
      bump(G, { kind: 'act', seat: p.seat, type, target: t.seat });
      G.todo.unshift({ t: 'lose', seat: t.seat, why: 'coup' });
      endTurn(G);
      return OK;
    case 'convert': {
      // "Coins paid for this action are placed on the Treasury Reserve card.
      // The relevant Allegiance card is then turned to the other side."
      const cost = t === p ? 1 : 2;
      p.coins -= cost;
      G.reserve += cost;
      t.side = otherSide(t.side);
      note(G, t === p ? `${p.name} pays 1 coin onto the Treasury Reserve and becomes a ${SIDES[p.side]}.` : `${p.name} pays 2 coins onto the Treasury Reserve: ${t.name} becomes a ${SIDES[t.side]}.`);
      bump(G, { kind: 'act', seat: p.seat, type, target: t.seat });
      endTurn(G);
      return OK;
    }
    case 'foreignAid':
      note(G, `${p.name} asks for Foreign Aid.`);
      bump(G, { kind: 'act', seat: p.seat, type });
      G.todo.unshift({ t: 'block' });
      return OK;
    case 'embezzle':
      // "take all the coins on the Treasury Reserve card" — even none: the
      // rulebook sets no minimum, and a claim may be worth making for itself
      note(G, `${p.name} claims not to hold the Duke, to Embezzle the ${coins(G.reserve)} on the Treasury Reserve.`);
      record(G, p.seat, 'duke', 'not');
      bump(G, { kind: 'act', seat: p.seat, type });
      openChallenge(G, 'action');
      return OK;
    default:
      if (type === 'assassinate') { p.coins -= ASSASSIN_COST; G.act.paid = ASSASSIN_COST; }
      note(G, `${p.name} claims the ${charName(claim)}: ${ACTIONS[type].name}${on}${type === 'assassinate' ? ', paying 3 coins' : ''}.`);
      record(G, p.seat, claim, 'action');
      bump(G, { kind: 'act', seat: p.seat, type, target: G.act.target, claim });
      openChallenge(G, 'action');
      return OK;
  }
}

function record(G, seat, char, as) {
  G.claims.push({ seat, char, as, type: G.act.type, turn: G.turns, result: null });
}

// ---------------------------------------------------------------- challenges and blocks

// "Once an action or counteraction is declared other players must be given
// an opportunity to challenge" — everyone else still in, each says so.
function openChallenge(G, of) {
  const a = G.act;
  const claimant = of === 'action' ? a.actor : a.block.by;
  const claim = of === 'action' ? a.claim || 'duke' : a.block.claim;
  G.window = { kind: 'challenge', of, claimant, claim, inverse: of === 'action' && a.type === 'embezzle', waiting: living(G).map((p) => p.seat).filter((s) => s !== claimant) };
}

// who may block this action: the target of an assassination or a steal;
// anyone (of the other Allegiance) against Foreign Aid
function blockersFor(G) {
  const a = G.act;
  const actor = playerBySeat(G, a.actor);
  if (a.type === 'foreignAid') return living(G).filter((q) => q !== actor && mayTarget(G, q, actor)).map((q) => q.seat);
  if (a.type === 'assassinate' || a.type === 'steal') {
    const t = playerBySeat(G, a.target);
    return t && !t.out ? [t.seat] : [];
  }
  return [];
}

function openBlock(G) {
  const waiting = blockersFor(G);
  if (!waiting.length) { G.todo.unshift({ t: 'resolve' }); return; }
  G.window = { kind: 'block', waiting };
}

function respond(G, p, w, move) {
  const a = G.act;
  const drop = () => { w.waiting = w.waiting.filter((s) => s !== p.seat); };
  if (w.kind === 'pick') {
    if (move.kind !== 'pick') return err('Choose your card.');
    const c = (p.set || []).find((x) => x.id === move.card);
    if (!c) return err('Choose one card from your set.');
    p.cards.unshift({ ...c, up: false });
    p.aside = p.set.filter((x) => x !== c);
    p.set = null;
    drop();
    note(G, `${p.name} has chosen.`);
    if (!w.waiting.length) G.window = null;
    return OK;
  }
  if (w.kind === 'challenge') {
    if (move.kind === 'challenge') {
      G.window = null;
      startChallenge(G, p.seat, w.of);
      return OK;
    }
    if (move.kind === 'block') {
      // the target of an assassination or a steal may say now that they will
      // block it if no one challenges — it is declared when the question closes
      if (w.of !== 'action' || a.target !== p.seat || !blockersOf(G.opts, a.type).includes(move.claim)) return err('Challenge, or let it go.');
      a.pre = move.claim;
      drop();
    } else if (move.kind === 'allow') drop();
    else return err('Challenge, or let it go.');
    if (!w.waiting.length) {
      G.window = null;
      if (w.of === 'block') {
        note(G, `No one challenges: ${nameOf(G, a.actor)}’s ${ACTIONS[a.type].name} is blocked.`);
        bump(G, { kind: 'blocked', seat: a.actor });
        endTurn(G);
      } else if (a.pre) declareBlock(G, playerBySeat(G, a.target), a.pre);
      else G.todo.unshift({ t: 'resolve' });
    }
    return OK;
  }
  if (w.kind === 'block') {
    // the first block answers for everyone: once one is declared the question
    // closes, and if that block fails to a challenge the action goes ahead
    if (move.kind === 'block') {
      if (!blockersOf(G.opts, a.type).includes(move.claim)) return err(`Block with ${listWords(blockersOf(G.opts, a.type).map((c) => `the ${charName(c)}`)).replace(' and ', ' or ')}.`);
      G.window = null;
      declareBlock(G, p, move.claim);
      return OK;
    }
    if (move.kind !== 'allow') return err('Block it, or let it go.');
    drop();
    if (!w.waiting.length) { G.window = null; G.todo.unshift({ t: 'resolve' }); }
    return OK;
  }
  return err('That is not yours to do now.');
}

// "Counteractions operate like character actions" — a claim, open to challenge
function declareBlock(G, p, claim) {
  const a = G.act;
  a.block = { by: p.seat, claim };
  a.pre = null;
  record(G, p.seat, claim, 'block');
  note(G, `${p.name} claims the ${charName(claim)} to block ${nameOf(G, a.actor)}’s ${ACTIONS[a.type].name}.`);
  bump(G, { kind: 'block', seat: p.seat, claim });
  openChallenge(G, 'block');
}

// "If a player is challenged they must prove they had the required influence
// by showing the relevant character is one of their face down cards. If they
// can't, or do not wish to, prove it, they lose the challenge." Embezzlement
// turns it round: "If the challenged player does have the Duke, they must
// concede and lose the challenge (a player that does not have the Duke may
// concede and lose the challenge)".
function startChallenge(G, by, of) {
  const a = G.act;
  const w = { of, claimant: of === 'action' ? a.actor : a.block.by, claim: of === 'action' ? a.claim || 'duke' : a.block.claim, inverse: of === 'action' && a.type === 'embezzle' };
  G.challenge = { by, ...w, result: null };
  const p = playerBySeat(G, w.claimant);
  note(G, w.inverse ? `${nameOf(G, by)} challenges ${p.name}’s Embezzlement, saying ${p.name} holds the Duke.` : `${nameOf(G, by)} challenges ${p.name}’s claim to the ${charName(w.claim)}.`);
  bump(G, { kind: 'challenge', by, claimant: p.seat, claim: w.claim, inverse: w.inverse });
  const holds = faceDown(p).some((c) => c.char === w.claim);
  if (w.inverse ? holds : !holds) return concede(G, p);
  G.ask = { kind: 'prove', seat: p.seat };
}

function prove(G, p, show) {
  const ch = G.challenge;
  if (!show) { concede(G, p); return OK; }
  if (ch.inverse) {
    // "they must show their influence card(s), the challenger loses; the
    // revealed influence cards are shuffled back into the court deck and
    // replaced randomly" — shown, like any card that wins a challenge, to
    // the whole table
    const shown = faceDown(p);
    note(G, `${p.name} shows ${listWords(shown.map((c) => `the ${charName(c.char)}`))}: no Duke. ${nameOf(G, ch.by)} loses the challenge.`);
    bump(G, { kind: 'proved', seat: p.seat, chars: shown.map((c) => c.char), inverse: true });
    for (const c of shown) G.deck.push({ id: c.id, char: c.char });
    shuffle(G.deck);
    for (const c of shown) p.cards[p.cards.indexOf(c)] = { ...G.deck.shift(), up: false };
    note(G, `${p.name} shuffles them into the Court deck and draws ${shown.length === 1 ? 'a new card' : `${shown.length} new cards`}.`);
  } else {
    // "they first return that card to the Court deck, re-shuffle the Court
    // deck and take a random replacement card"
    const c = faceDown(p).find((x) => x.char === ch.claim);
    note(G, `${p.name} shows the ${charName(ch.claim)}. ${nameOf(G, ch.by)} loses the challenge.`);
    bump(G, { kind: 'proved', seat: p.seat, chars: [ch.claim] });
    G.deck.push({ id: c.id, char: c.char });
    shuffle(G.deck);
    p.cards[p.cards.indexOf(c)] = { ...G.deck.shift(), up: false };
    note(G, `${p.name} shuffles it into the Court deck and draws a new card.`);
  }
  settle(G, 'shown');
  ch.result = 'claimant';
  // "Whoever loses the challenge immediately loses an influence."
  G.todo.unshift({ t: 'lose', seat: ch.by, why: 'challenge' }, { t: 'after' });
  return OK;
}

function concede(G, p) {
  const ch = G.challenge;
  note(G, ch.inverse ? `${p.name} concedes the challenge.` : `${p.name} does not show the ${charName(ch.claim)}, and loses the challenge.`);
  bump(G, { kind: 'caught', seat: p.seat, claim: ch.claim, inverse: ch.inverse });
  settle(G, 'conceded');
  ch.result = 'challenger';
  G.todo.unshift({ t: 'lose', seat: p.seat, why: 'challenge' }, { t: 'after' });
}

// how the claim that was challenged ended, for the record
function settle(G, result) {
  const ch = G.challenge;
  for (let i = G.claims.length - 1; i >= 0; i--) {
    const c = G.claims[i];
    if (c.seat === ch.claimant && c.turn === G.turns && c.result === null) { c.result = result; break; }
  }
}

function afterChallenge(G) {
  const ch = G.challenge;
  const a = G.act;
  G.challenge = null;
  const actor = playerBySeat(G, a.actor);
  if (ch.of === 'action') {
    if (ch.result === 'challenger') {
      // "If an action is successfully challenged the entire action fails, and
      // any coins paid as the cost of the action are returned to the player."
      // Embezzlement: "return the coins taken to the Treasury Reserve card"
      if (a.paid && !actor.out) { actor.coins += a.paid; note(G, `${actor.name}’s ${ACTIONS[a.type].name} fails, and the 3 coins come back.`); }
      else note(G, `${actor.name}’s ${ACTIONS[a.type].name} fails.`);
      endTurn(G);
      return;
    }
    // the action stands — and now the target may block it: "You must announce
    // your counter-action after any challenge to the action has been resolved"
    if (blockersOf(G.opts, a.type).length) G.todo.unshift({ t: 'block' });
    else G.todo.unshift({ t: 'resolve' });
    return;
  }
  if (ch.result === 'challenger') {
    note(G, `The block fails: ${actor.name}’s ${ACTIONS[a.type].name} goes ahead.`);
    G.todo.unshift({ t: 'resolve' });
  } else {
    note(G, `${actor.name}’s ${ACTIONS[a.type].name} is blocked.`);
    bump(G, { kind: 'blocked', seat: a.actor });
    endTurn(G);
  }
}

function resolve(G) {
  const a = G.act;
  const p = playerBySeat(G, a.actor);
  const t = a.target != null ? playerBySeat(G, a.target) : null;
  // an exiled player's action comes to nothing, and so does one aimed at the exiled
  if (p.out || (t && t.out)) { endTurn(G); return; }
  switch (a.type) {
    case 'foreignAid':
      p.coins += 2;
      note(G, `${p.name} takes 2 coins of Foreign Aid.`);
      break;
    case 'tax':
      p.coins += 3;
      note(G, `${p.name} takes 3 coins in Tax.`);
      break;
    case 'steal': {
      // "If they only have one coin, take only one."
      const k = Math.min(2, t.coins);
      t.coins -= k;
      p.coins += k;
      note(G, `${p.name} steals ${coins(k)} from ${t.name}.`);
      break;
    }
    case 'assassinate':
      note(G, `The assassination goes ahead: ${t.name} loses an influence.`);
      G.todo.unshift({ t: 'lose', seat: t.seat, why: 'assassinate' });
      break;
    case 'exchange': {
      // "First take 2 random cards from the Court deck" — the Inquisitor, one
      const k = G.opts.inquisitor ? 1 : 2;
      const drawn = G.deck.splice(0, k);
      note(G, `${p.name} draws ${k === 1 ? 'a card' : `${k} cards`} from the Court deck.`);
      G.ask = { kind: 'exchange', seat: p.seat, drawn };
      return;
    }
    case 'examine':
      note(G, `${t.name} must show one card to ${p.name}.`);
      G.ask = { kind: 'show', seat: t.seat, to: p.seat };
      return;
    case 'embezzle': {
      const k = G.reserve;
      p.coins += k;
      G.reserve = 0;
      note(G, `${p.name} Embezzles the ${coins(k)} on the Treasury Reserve.`);
      break;
    }
    default:
  }
  bump(G, { kind: 'done', seat: p.seat, type: a.type });
  endTurn(G);
}

// "Choose which, if any, to exchange with your face down cards. Then return
// two cards to the Court deck" — and no one sees which were kept.
function exchange(G, p, a, keep) {
  const mine = faceDown(p);
  const pool = [...mine.map(({ id, char }) => ({ id, char })), ...a.drawn];
  if (!Array.isArray(keep) || keep.length !== mine.length || new Set(keep).size !== keep.length || !keep.every((id) => pool.some((c) => c.id === id))) return err(`Keep ${mine.length === 1 ? 'one card' : 'two cards'}.`);
  const kept = keep.map((id) => pool.find((c) => c.id === id));
  const back = pool.filter((c) => !keep.includes(c.id));
  mine.forEach((c, i) => { p.cards[p.cards.indexOf(c)] = { ...kept[i], up: false }; });
  G.deck.push(...back);
  shuffle(G.deck);
  note(G, `${p.name} returns ${back.length === 1 ? 'a card' : `${back.length} cards`} to the Court deck.`);
  bump(G, { kind: 'done', seat: p.seat, type: 'exchange' });
  endTurn(G);
  return OK;
}

// ---------------------------------------------------------------- losing influence

// "Each player always chooses which of their own cards they wish to reveal
// when they lose an influence."
function loseStep(G, step) {
  const p = playerBySeat(G, step.seat);
  if (!p || p.out) return;
  const down = faceDown(p);
  if (down.length === 1) { reveal(G, p, down[0]); return; }
  G.ask = { kind: 'lose', seat: p.seat, why: step.why };
}

function reveal(G, p, c) {
  c.up = true;
  note(G, `${p.name} loses an influence and turns the ${charName(c.char)} face up.`);
  bump(G, { kind: 'lose', seat: p.seat, char: c.char });
  if (faceDown(p).length) return;
  // "When a player has lost all their influence ... they are immediately out
  // of the game. They leave their cards face up and return all their coins to
  // the Treasury."
  p.out = true;
  const k = p.coins;
  p.coins = 0;
  note(G, `${p.name} has no influence left and is exiled${k ? `; ${coins(k)} ${k === 1 ? 'goes' : 'go'} back to the Treasury` : ''}.`);
  const left = living(G);
  if (left.length === 1) endGame(G, left[0]);
}

function endGame(G, p) {
  G.phase = 'over';
  G.winner = p.seat;
  G.why = `${p.name} is the last with influence`;
  G.ask = null;
  G.window = null;
  G.todo = [];
  note(G, `${p.name} wins — the last player with influence at court.`);
  bump(G, { kind: 'over', winner: p.seat });
}

// who the table is waiting on
export function waitingOn(G) {
  if (G.phase === 'over') return [];
  if (G.window) return G.window.waiting.slice();
  if (G.ask) return [G.ask.seat];
  return [];
}

// what the player whose turn it is may do, and to whom
export function legalActions(G, seat) {
  const p = playerBySeat(G, seat);
  const o = G.opts;
  const others = living(G).filter((q) => q !== p);
  const aim = (type) => others.filter((t) => mayTarget(G, p, t) && (type !== 'steal' || t.coins > 0)).map((t) => t.seat);
  const out = {};
  if (p.coins >= MUST_COUP) return { coup: aim('coup') };
  out.income = true;
  out.foreignAid = true;
  if (p.coins >= COUP_COST) out.coup = aim('coup');
  out.tax = true;
  if (p.coins >= ASSASSIN_COST) out.assassinate = aim('assassinate');
  out.steal = aim('steal');
  out.exchange = true;
  if (o.inquisitor) out.examine = aim('examine');
  if (o.reformation) {
    if (p.coins >= 1) out.convert = p.coins >= 2 ? [p.seat, ...others.map((q) => q.seat)] : [p.seat];
    out.embezzle = true;
  }
  for (const k of Object.keys(out)) if (Array.isArray(out[k]) && !out[k].length) delete out[k];
  return out;
}

// ---------------------------------------------------------------- disconnection

export function markDisconnected(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p || p.bot) return false;
  p.connected = false;
  return true;
}

export function markReconnected(G, seat) {
  const p = playerBySeat(G, seat);
  if (p) { p.connected = true; p.botFor = false; }
}

export function markBotTakeover(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p || p.bot || p.connected) return false;
  p.botFor = true;
  note(G, `A bot takes over for ${p.name}.`);
  return true;
}

export function markSeatClaimed(G, seat, name) {
  const p = playerBySeat(G, seat);
  if (!p) return;
  p.name = name;
  p.connected = true;
  p.botFor = false;
  p.resigned = false;
}

export function markSeatResigned(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p) return;
  p.connected = false;
  p.resigned = true;
}

// ---------------------------------------------------------------- views

// Each player sees their own cards, every card face up, the coins, the
// Allegiances and every claim; the cards they draw to exchange and the card
// they Examine are theirs alone. Hidden cards carry no id: ids are dealt in
// character order and would give them away.
export function viewFor(G, seat, code, opts = {}) {
  const me = playerBySeat(G, seat);
  const over = G.phase === 'over';
  const a = G.ask;
  const mine = !!(me && a && a.seat === seat);
  const w = G.window;
  const act = G.act;
  return {
    code, mid: G.mid, you: seat,
    phase: G.phase, n: G.n, opts: G.opts,
    chars: charsFor(G.opts), copies: G.copies,
    turn: G.players[G.turn].seat, turns: G.turns,
    deck: G.deck.length, reserve: G.reserve,
    act: act ? { type: act.type, actor: act.actor, target: act.target, claim: act.claim, paid: act.paid, block: act.block, pre: me && act.target === seat ? act.pre : null } : null,
    window: w ? { kind: w.kind, of: w.of, claimant: w.claimant, claim: w.claim, inverse: !!w.inverse, waiting: w.waiting.slice() } : null,
    challenge: G.challenge ? { by: G.challenge.by, of: G.challenge.of, claimant: G.challenge.claimant, claim: G.challenge.claim, inverse: G.challenge.inverse } : null,
    ask: a ? {
      kind: a.kind, seat: a.seat, why: a.why, to: a.to, target: a.target,
      drawn: mine && a.kind === 'exchange' ? a.drawn : undefined,
      card: mine && a.kind === 'examine' ? { id: a.card, char: a.char } : undefined,
    } : null,
    players: G.players.map((p) => ({
      seat: p.seat, name: p.name, bot: p.bot, connected: p.connected, botFor: !!p.botFor, resigned: !!p.resigned,
      coins: p.coins, side: p.side, out: p.out,
      cards: p.cards.map((c) => (c.up || p.seat === seat || over ? { id: c.id, char: c.char, up: c.up } : { up: false })),
    })),
    me: me ? {
      set: w && w.kind === 'pick' && me.set ? me.set : null,
      looks: G.looks.filter((l) => l.by === seat),
    } : null,
    claims: G.claims,
    winner: G.winner, why: G.why,
    log: G.log.slice(-60),
    fx: G.fx,
    revealBots: opts.revealBots ? G.players.filter((p) => p.bot && p.seat !== seat).map((p) => ({ seat: p.seat, chars: faceDown(p).map((c) => c.char) })) : null,
  };
}

// ---------------------------------------------------------------- bots
//
// A bot knows its own cards, every card face up and every claim made — no
// more. Whether a claim is true it weighs by counting: how many copies of
// that character it cannot account for, and how many unknown cards there are
// for them to hide among; a claim made before and never caught is likelier
// true, and a player once caught is likelier to bluff again. It challenges
// when a claim looks unlikely and the stakes are its own, blocks with what it
// holds, and bluffs now and then — always the Contessa, when an assassination
// would take its last card anyway.

const VALUE = { duke: 5, assassin: 4.6, captain: 4.2, contessa: 3.8, inquisitor: 3.4, ambassador: 3 };
const rand = (a) => a[Math.floor(Math.random() * a.length)];

function comb(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

// copies of a character this bot cannot place
function unplaced(G, seat, char) {
  const me = playerBySeat(G, seat);
  let k = G.copies;
  for (const p of G.players) for (const c of p.cards) if (c.char === char && (c.up || p === me)) k--;
  for (const c of me.aside || []) if (c.char === char) k--;
  return Math.max(0, k);
}

// the chance, as this bot sees it, that a player holds a character
function pHolds(G, seat, who, char) {
  const me = playerBySeat(G, seat);
  const q = playerBySeat(G, who);
  const k = influence(q);
  const m = unplaced(G, seat, char);
  if (!k || !m) return 0;
  // the cards this bot cannot see: the deck, the others' face-down cards and,
  // in the two-player variant, the cards the other set aside
  let u = G.deck.length;
  for (const p of G.players) if (p !== me) u += influence(p) + (p.aside ? p.aside.length : 0);
  let pr = 1 - comb(u - m, k) / comb(u, k);
  const said = G.claims.filter((c) => c.seat === who && c.char === char && c.as !== 'not');
  if (said.filter((c) => c.result === null).length >= 2) pr += (1 - pr) * 0.3;
  if (G.claims.some((c) => c.seat === who && c.result === 'conceded')) pr *= 0.85;
  return Math.min(1, pr);
}

// a claim no one has challenged: a card shown is shuffled away, and one not
// shown was a bluff
const claimed = (G, seat, chars) => G.claims.some((c) => c.seat === seat && chars.includes(c.char) && c.as !== 'not' && c.result === null);

export function botChoose(G, seat) {
  const me = playerBySeat(G, seat);
  if (!me || G.phase === 'over') return null;
  if (G.window) return G.window.waiting.includes(seat) ? botWindow(G, me, G.window) : null;
  if (G.ask && G.ask.seat === seat) return botAsk(G, me, G.ask);
  return null;
}

function botWindow(G, me, w) {
  const a = G.act;
  const hand = faceDown(me).map((c) => c.char);
  if (w.kind === 'pick') {
    const order = ['duke', 'assassin', 'captain', 'contessa', exchangerOf(G.opts)];
    const pick = Math.random() < 0.7 ? order[0] : rand(order.slice(0, 3));
    return { kind: 'pick', card: me.set.find((c) => c.char === pick).id };
  }
  if (w.kind === 'block') {
    const b = blockChoice(G, me);
    return b ? { kind: 'block', claim: b } : { kind: 'allow' };
  }
  // a challenge — first, the target of an assassination
  if (w.of === 'action' && a.type === 'assassinate' && a.target === me.seat) {
    const p = pHolds(G, me.seat, a.actor, 'assassin');
    if (hand.includes('contessa')) return p < 0.15 ? { kind: 'challenge' } : { kind: 'block', claim: 'contessa' };
    if (influence(me) === 1) return p < 0.5 ? { kind: 'challenge' } : { kind: 'block', claim: 'contessa' };
    if (p < 0.2) return { kind: 'challenge' };
    return Math.random() < 0.1 ? { kind: 'block', claim: 'contessa' } : { kind: 'allow' };
  }
  if (wantsChallenge(G, me, w)) return { kind: 'challenge' };
  if (w.of === 'action' && a.target === me.seat && blockersOf(G.opts, a.type).length) {
    const b = blockChoice(G, me);
    if (b) return { kind: 'block', claim: b };
  }
  return { kind: 'allow' };
}

function wantsChallenge(G, me, w) {
  const a = G.act;
  const claimant = playerBySeat(G, w.claimant);
  const mine = influence(me);
  if (w.inverse) {
    // Embezzlement: challenge when they likely do hold the Duke
    const p = pHolds(G, me.seat, w.claimant, 'duke');
    return p > (G.reserve >= 3 ? 0.55 : 0.65) + (Math.random() - 0.5) * 0.1 && (mine > 1 || p > 0.8);
  }
  const p = pHolds(G, me.seat, w.claimant, w.claim);
  if (p === 0) return true;
  let thr;
  if (w.of === 'action') {
    if (a.target === me.seat) thr = a.type === 'steal' ? (me.coins >= 2 ? 0.25 : 0.12) : 0.2;
    else if (a.type === 'tax') thr = claimant.coins >= 4 ? 0.2 : 0.14;
    else if (a.type === 'exchange') thr = 0.08;
    else thr = 0.1;
  } else if (a.actor === me.seat) thr = a.type === 'assassinate' ? 0.34 : a.type === 'steal' ? 0.28 : 0.22;
  else thr = 0.1;
  if (mine === 1) thr -= 0.07;
  return p < thr + (Math.random() - 0.5) * 0.1;
}

function blockChoice(G, me) {
  const a = G.act;
  const can = blockersOf(G.opts, a.type);
  const hand = faceDown(me).map((c) => c.char);
  const real = can.find((c) => hand.includes(c));
  const actor = playerBySeat(G, a.actor);
  if (real) {
    if (a.type === 'foreignAid') return actor.coins + 2 >= COUP_COST - 1 || Math.random() < 0.5 ? real : null;
    return real;
  }
  const believable = can.filter((c) => unplaced(G, me.seat, c) > 0);
  if (!believable.length) return a.type === 'assassinate' && influence(me) === 1 ? 'contessa' : null;
  if (a.type === 'assassinate') return influence(me) === 1 || Math.random() < 0.1 ? 'contessa' : null;
  if (a.type === 'steal') return me.coins >= 2 && Math.random() < 0.12 ? rand(believable) : null;
  if (a.type === 'foreignAid') return actor.coins + 2 >= COUP_COST && Math.random() < 0.1 ? 'duke' : null;
  return null;
}

function botAsk(G, me, a) {
  const hand = faceDown(me);
  switch (a.kind) {
    case 'act': return botAct(G, me);
    case 'side': return { kind: 'side', side: Math.random() < 0.5 ? 'loyalist' : 'reformist' };
    case 'prove': return { kind: 'prove', show: true };
    case 'lose': return { kind: 'lose', card: hand.slice().sort((x, y) => VALUE[x.char] - VALUE[y.char])[0].id };
    case 'exchange': {
      // keep the strongest cards, a second copy of one worth less
      const pool = [...hand.map(({ id, char }) => ({ id, char })), ...a.drawn];
      const keep = [];
      for (let i = 0; i < hand.length; i++) {
        const score = (c) => VALUE[c.char] - (keep.some((k) => k.char === c.char) ? 1.8 : 0) + Math.random() * 0.3;
        const best = pool.filter((c) => !keep.includes(c)).sort((x, y) => score(y) - score(x))[0];
        keep.push(best);
      }
      return { kind: 'exchange', keep: keep.map((c) => c.id) };
    }
    case 'show': return { kind: 'show', card: hand.slice().sort((x, y) => VALUE[x.char] - VALUE[y.char])[0].id };
    case 'examine': return { kind: 'examine', swap: VALUE[a.char] >= VALUE.contessa };
    default: return null;
  }
}

function botAct(G, me) {
  const o = G.opts;
  const legal = legalActions(G, me.seat);
  const hand = faceDown(me).map((c) => c.char);
  const has = (c) => hand.includes(c);
  const believable = (c) => has(c) || unplaced(G, me.seat, c) > 0;
  const threat = (s) => { const t = playerBySeat(G, s); return influence(t) * 4 + t.coins + Math.random() * 2; };
  const best = (list) => list.slice().sort((x, y) => threat(y) - threat(x))[0];
  const go = (action, target) => ({ kind: 'act', action, ...(target != null ? { target } : {}) });
  if (legal.coup && (me.coins >= MUST_COUP || Math.random() < 0.85)) return go('coup', best(legal.coup));
  // Reformation: an agent of the other side with a Coup or an Assassin in
  // hand is a reason to change sides — unless that leaves everyone on one
  if (legal.convert && me.coins < COUP_COST) {
    const others = living(G).filter((q) => q !== me);
    const danger = others.some((q) => q.side !== me.side && (q.coins >= COUP_COST || (q.coins >= ASSASSIN_COST && claimed(G, q.seat, ['assassin']))));
    const lone = others.every((q) => q.side === otherSide(me.side));
    if (danger && !lone && Math.random() < 0.3) return go('convert');
  }
  // no assassin pays 3 coins again and again into a Contessa
  const soft = (legal.assassinate || []).filter((s) => !claimed(G, s, ['contessa']));
  if (soft.length && (has('assassin') ? Math.random() < 0.85 : believable('assassin') && Math.random() < 0.07)) return go('assassinate', best(soft));
  if (has('duke') ? Math.random() < 0.9 : believable('duke') && Math.random() < 0.22) return go('tax');
  if (legal.steal) {
    const rich = legal.steal.filter((s) => playerBySeat(G, s).coins >= 2 && !claimed(G, s, blockersOf(o, 'steal')));
    if (rich.length && (has('captain') ? Math.random() < 0.85 : believable('captain') && Math.random() < 0.1)) return go('steal', rich.sort((x, y) => playerBySeat(G, y).coins - playerBySeat(G, x).coins)[0]);
  }
  if (legal.examine && has('inquisitor') && Math.random() < 0.35) return go('examine', best(legal.examine));
  if (legal.embezzle && G.reserve >= 2 && !has('duke') && Math.random() < 0.85) return go('embezzle');
  const ex = exchangerOf(o);
  const weak = !hand.some((c) => c === 'duke' || c === 'assassin' || c === 'captain');
  if (weak && (has(ex) ? Math.random() < 0.7 : believable(ex) && Math.random() < 0.15)) return go('exchange');
  // Foreign Aid, unless a Duke who may block it has shown themself
  const dukes = living(G).filter((q) => q !== me && mayTarget(G, q, me) && claimed(G, q.seat, ['duke']));
  if (!dukes.length && Math.random() < 0.7) return go('foreignAid');
  // pay to make a rich player of one's own side a target
  if (legal.convert && me.coins >= 4 && Math.random() < 0.15) {
    const mates = living(G).filter((q) => q !== me && q.side === me.side && q.coins >= 5);
    if (mates.length && !oneSide(G)) return go('convert', mates[0].seat);
  }
  return go('income');
}
