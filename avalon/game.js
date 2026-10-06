// game.js — the rules of The Resistance: Avalon, Big Box edition. No DOM, no
// network: the host holds the only copy of the state and every move goes
// through applyMove, which is what makes it testable.
//
// Five to ten players are dealt secret Characters, Good or Evil. Each round
// the Leader proposes a Team for the next Quest, everyone votes on it in the
// open, and an approved Team secretly plays Quest cards: one Fail and the
// Quest fails (two, on the fourth Quest at a table of seven or more). Three
// successful Quests and Good has one more hurdle: the Assassin names Merlin,
// and if that is right, Evil wins after all. Three failed Quests, or five
// Teams rejected in a single round, and Evil wins outright.
//
// With every option off this is the base game. The Big Box adds Characters
// (Percival, Morgana, Mordred, Oberon, Lancelot, the Lunatic, the Brute, the
// Revealer, the Cleric, the Trickster, the Troublemaker, the Untrustworthy
// Servant), modules with their own Characters and Quest cards (the Rogues,
// the Sorcerers, the Messengers) and optional rules (the Trapper, the Lady of
// the Lake, Excalibur, Plot cards).
//
// Where it comes from: the Avalon Big Box rulebook (Indie Boards & Cards),
// read from RulesPal's full transcription of it — its charts, its reveal
// script, every Character, module and optional rule. The Plot deck's
// make-up is The Resistance's (the consolidated rules, v1.1, with The Plot
// Thickens), whose nine cards the Big Box renamed one for one: 2 Are You the
// One? (Overheard Conversation), 2 Charge! (Opinion Maker), 1 Show Your
// Strength (Establish Confidence), 1 Show Your True Nature (Open Up), 3 The
// King Returns (No Confidence), 2 Ambush (Keeping a Close Eye on You), 2 Lead
// to Victory (Strong Leader), 1 We Found You! (In the Spotlight), 1 Restore
// Your Honor (Take Responsibility). Which seven of the fifteen a table of
// five or six uses is printed on the cards, and no source at hand shows all
// of them — so here Plot cards are played at seven or more only.

export const PROTO = 2;
export const MIN_PLAYERS = 5;
export const MAX_PLAYERS = 10;
export const QUESTS = 5;
export const MAX_REJECTS = 5;

// "Shuffle the appropriate number of Good and Evil character cards according
// to the chart"
export const SIDES = { 5: [3, 2], 6: [4, 2], 7: [4, 3], 8: [5, 3], 9: [6, 3], 10: [6, 4] };

// "the Leader takes the required number of Team tokens (using the following
// chart, or the numbers on the tableau)"
export const TEAM_SIZES = {
  5: [2, 3, 2, 3, 3],
  6: [2, 3, 4, 3, 4],
  7: [2, 3, 3, 4, 4],
  8: [3, 4, 4, 5, 5],
  9: [3, 4, 4, 5, 5],
  10: [3, 4, 4, 5, 5],
};

// "The 4th Quest (and only the 4th Quest) in games of seven or more players
// requires at least two Quest Fail cards to be a failed Quest."
export const failsNeeded = (n, quest) => (n >= 7 && quest === 3 ? 2 : 1);

// The Character cards, with the side each starts on. Merlin and the Assassin
// are in every game here; the rest of each side are Loyal Servants of Arthur
// and Minions of Mordred.
export const ROLES = {
  merlin: { name: 'Merlin', side: 'good', power: 'You see the agents of Evil — all but Mordred (and the Evil Rogue). Speak only in riddles: if the Assassin finds you at the end, Evil wins.' },
  percival: { name: 'Percival', side: 'good', power: 'You know Merlin. With Morgana at the table you see two players, and only one of them is Merlin.' },
  servant: { name: 'Loyal Servant of Arthur', side: 'good', power: 'You know nothing but your own loyalty. Find the agents of Evil from what the table does.' },
  cleric: { name: 'Cleric', side: 'good', power: 'At the start you learn whether the first Leader is Good or Evil.' },
  troublemaker: { name: 'Troublemaker', side: 'good', power: 'You are Good, but whenever your loyalty is checked you must show Evil.' },
  untrustworthy: { name: 'Untrustworthy Servant', side: 'good', power: 'You know the Assassin, and Merlin takes you for an agent of Evil. If three Quests succeed, the Assassin may recruit you: guessed, you turn Evil and name Merlin yourself.' },
  lancelotGood: { name: 'Good Lancelot', side: 'good', power: 'Lancelot has two cards, one Good and one Evil. With the Allegiance cards, the two Lancelots can switch sides during the game.' },
  rogueGood: { name: 'Good Rogue', side: 'good', power: 'You may play Rogue Success. Play it on the third successful Quest and on one before, and you win alone.' },
  sorcererGood: { name: 'Good Sorcerer', side: 'good', power: 'You may play Magic: an odd number of Magic cards turns a Quest’s result around.' },
  messengerSenior: { name: 'Senior Messenger', side: 'good', power: 'A Good Messenger: you may play a Good Message (it counts as Success) twice in the game. Three Good Messages by the fifth Quest let Good take one Fail off it.' },
  messengerJunior: { name: 'Junior Messenger', side: 'good', power: 'A Good Messenger: you may play a Good Message (it counts as Success) twice in the game. Three Good Messages by the fifth Quest let Good take one Fail off it.' },
  assassin: { name: 'Assassin', side: 'evil', power: 'You know your fellow agents of Evil. If three Quests succeed, you name one Good player as Merlin — name the right one and Evil wins.' },
  morgana: { name: 'Morgana', side: 'evil', power: 'You know your fellow agents of Evil, and you appear to Percival as Merlin.' },
  mordred: { name: 'Mordred', side: 'evil', power: 'You know your fellow agents of Evil, and Merlin does not see you.' },
  oberon: { name: 'Oberon', side: 'evil', power: 'You serve Evil alone: you do not know the other agents of Evil, and they do not know you. Merlin still sees you.' },
  minion: { name: 'Minion of Mordred', side: 'evil', power: 'You know your fellow agents of Evil.' },
  lunatic: { name: 'Lunatic', side: 'evil', power: 'You must Fail every Quest you are on.' },
  brute: { name: 'Brute', side: 'evil', power: 'You may Fail only the first three Quests; after that, Success.' },
  revealer: { name: 'Revealer', side: 'evil', power: 'After the second failed Quest you must reveal yourself to the table.' },
  trickster: { name: 'Trickster', side: 'evil', power: 'Whenever your loyalty is checked you may lie and show Good.' },
  lancelotEvil: { name: 'Evil Lancelot', side: 'evil', power: 'Lancelot has two cards, one Good and one Evil. With the Allegiance cards, the two Lancelots can switch sides during the game.' },
  rogueEvil: { name: 'Evil Rogue', side: 'evil', power: 'You serve Evil unseen — the other agents of Evil and Merlin do not know you. You may play Rogue Fail: play it on the third failed Quest and on one before, and you win alone.' },
  sorcererEvil: { name: 'Evil Sorcerer', side: 'evil', power: 'You may play Magic — an odd number of Magic cards turns a Quest’s result around — but never Fail.' },
  messengerEvil: { name: 'Evil Messenger', side: 'evil', power: 'You may play an Evil Message (it counts as Fail). Two Evil Messages by the fifth Quest let Evil add a Fail to it.' },
};
export const sideOf = (role) => ROLES[role].side;

// The options, as the lobby offers them: Characters that join a side,
// modules with their own Characters, and optional rules.
export const GOOD_CHARS = ['percival', 'cleric', 'troublemaker', 'untrustworthy'];
export const EVIL_CHARS = ['morgana', 'mordred', 'oberon', 'lunatic', 'brute', 'revealer', 'trickster'];
export const RULES = ['trapper', 'lady', 'excalibur', 'plot'];

export function defaultOpts() {
  return {
    percival: false, cleric: false, troublemaker: false, untrustworthy: false,
    morgana: false, mordred: false, oberon: false, lunatic: false, brute: false, revealer: false, trickster: false,
    lancelot: false, lancelotVariant: 0, // 0: the two know each other; 1, 2: the rulebook's variants
    rogueGood: false, rogueEvil: false,
    sorcerers: false, sorcererHidden: false,
    messengers: false, messengerSenior: false,
    trapper: false, lady: false, excalibur: false, plot: false,
  };
}
const BOOL_OPTS = Object.keys(defaultOpts()).filter((k) => k !== 'lancelotVariant');

export function checkOpts(opts) {
  if (!opts || typeof opts !== 'object') return 'No options.';
  for (const k of BOOL_OPTS) if (opts[k] !== undefined && typeof opts[k] !== 'boolean') return `${k} is on or off.`;
  if (opts.lancelotVariant !== undefined && ![0, 1, 2].includes(opts.lancelotVariant)) return 'Lancelot plays with no variant, Variant 1 or Variant 2.';
  return null;
}

// The Characters dealt at a table of n: the specials first, the rest of each
// side plain Servants and Minions.
export function castFor(n, opts) {
  const [good, evil] = SIDES[n];
  const g = ['merlin', ...GOOD_CHARS.filter((k) => opts[k])];
  const e = ['assassin', ...EVIL_CHARS.filter((k) => opts[k])];
  if (opts.lancelot) { g.push('lancelotGood'); e.push('lancelotEvil'); }
  if (opts.rogueGood) g.push('rogueGood');
  if (opts.rogueEvil) e.push('rogueEvil');
  if (opts.sorcerers) { g.push('sorcererGood'); e.push('sorcererEvil'); }
  if (opts.messengers) { g.push('messengerSenior', 'messengerJunior'); e.push('messengerEvil'); }
  while (g.length < good) g.push('servant');
  while (e.length < evil) e.push('minion');
  return [...g, ...e];
}

export function canStart(n, opts) {
  if (n < MIN_PLAYERS) return `Needs at least ${MIN_PLAYERS} players — add bots to fill the table.`;
  if (n > MAX_PLAYERS) return `At most ${MAX_PLAYERS} players.`;
  const why = checkOpts(opts);
  if (why) return why;
  const [good, evil] = SIDES[n];
  const cast = castFor(n, opts);
  const g = cast.filter((r) => r !== 'servant' && sideOf(r) === 'good').length;
  const e = cast.filter((r) => r !== 'minion' && sideOf(r) === 'evil').length;
  if (e > evil) return `A table of ${n} has only ${evil} agents of Evil — those Characters need ${e}.`;
  if (g > good) return `A table of ${n} has only ${good} Good players — those Characters need ${g}.`;
  if (opts.plot && n < 7) return 'Plot cards are played here at seven or more: which seven cards a table of five or six uses is printed on the cards, and that is not yet checked.';
  return null;
}

// The rulebook's advice on the options, for the lobby to pass on.
export function advice(n, opts) {
  const out = [];
  if (opts.percival && n === 5 && !opts.morgana && !opts.mordred) out.push('For games of 5, the rulebook says to add Mordred or Morgana when playing with Percival.');
  if (opts.morgana && !opts.percival) out.push('The rulebook says Morgana must be played with Percival — without him she plays as a plain Minion.');
  const seven = [['lancelot', 'Lancelot'], ['lunatic', 'the Lunatic'], ['brute', 'the Brute'], ['revealer', 'the Revealer'], ['cleric', 'the Cleric'], ['messengers', 'the Messengers'], ['lady', 'the Lady of the Lake']].filter(([k]) => opts[k] && n < 7).map(([, w]) => w);
  if (seven.length) out.push(`The rulebook recommends ${seven.join(', ')} for games of 7 or more.`);
  if (opts.trapper && n < 8) out.push('The rulebook recommends the Trapper for games of 8 or more.');
  const checks = opts.cleric || opts.lady || opts.plot;
  if ((opts.trickster || opts.troublemaker) && !checks) out.push('The Trickster and the Troublemaker only matter when loyalty is checked: with the Cleric, the Lady of the Lake or Plot cards.');
  if (opts.rogueGood !== opts.rogueEvil) out.push('One Rogue alone is allowed: "A game can include both Rogues or just one."');
  return out;
}

// ---------------------------------------------------------------- Quest cards

export const CARDS = {
  success: { name: 'Success', fail: false },
  fail: { name: 'Fail', fail: true },
  rogueSuccess: { name: 'Rogue Success', fail: false },
  rogueFail: { name: 'Rogue Fail', fail: true },
  magic: { name: 'Magic', fail: false },
  goodMessage: { name: 'Good Message', fail: false },
  evilMessage: { name: 'Evil Message', fail: true },
};

// ---------------------------------------------------------------- Plot cards

export const PLOTS = {
  one: { name: 'Are You the One?', use: 'now', count: 2, text: 'Check the loyalty of one adjacent player.' },
  charge: { name: 'Charge!', use: 'always', count: 2, text: 'For the rest of the game you select and reveal your vote before anyone else votes. Two Charge! holders reveal together.' },
  strength: { name: 'Show Your Strength', use: 'now', count: 1, text: 'The Leader must pass a Loyalty card to any other player for examination.' },
  nature: { name: 'Show Your True Nature', use: 'now', count: 1, text: 'You must pass a Loyalty card to any other player (the Leader included) for examination.' },
  king: { name: 'The King Returns', use: 'held', count: 3, text: 'Use it to reject an approved Team. It counts as a failed vote for the round — the fifth one hands Evil the game.' },
  ambush: { name: 'Ambush', use: 'held', count: 2, text: 'Use it to look at one played Quest card. No card is looked at twice on one Quest.' },
  lead: { name: 'Lead to Victory', use: 'held', count: 2, text: 'Use it to become the Leader, before the Leader acts. Another may not be played until a vote has been taken.' },
  spot: { name: 'We Found You!', use: 'held', count: 1, text: 'Before the Team picks its Quest cards, make one member play theirs face up.' },
  honor: { name: 'Restore Your Honor', use: 'now', count: 1, text: 'You must take one Plot card from any other player.' },
};
// "one for 5-6 players, two for 7-8 players, and three for 9-10 players"
export const PLOTS_DRAWN = { 5: 1, 6: 1, 7: 2, 8: 2, 9: 3, 10: 3 };

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
  if (G.log.length > 120) G.log.shift();
}

function bump(G, fx) {
  G.fxSeq = (G.fxSeq || 0) + 1;
  G.fx = { seq: G.fxSeq, ...fx };
}

const nameOf = (G, seat) => (playerBySeat(G, seat) || { name: '?' }).name;
const listWords = (a) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
const names = (G, seats) => listWords(seats.map((s) => nameOf(G, s)));
const seats = (G) => G.players.map((p) => p.seat);
const seatOfRole = (G, role) => (G.players.find((p) => p.role === role) || {}).seat;
const isLancelot = (r) => r === 'lancelotGood' || r === 'lancelotEvil';
const isMessenger = (r) => r === 'messengerSenior' || r === 'messengerJunior';
const hasPlot = (p, type) => p.plots.some((c) => c.type === type);

// ---------------------------------------------------------------- setup

export function newGame(roster, opts = defaultOpts()) {
  const n = roster.length;
  const o = { ...defaultOpts(), ...clone(opts) };
  const why = canStart(n, o);
  if (why) throw new Error(why);
  if (!o.lancelot) o.lancelotVariant = 0;
  if (!o.sorcerers) o.sorcererHidden = false;
  if (!o.messengers) o.messengerSenior = false;
  const roles = shuffle(castFor(n, o));
  const sizes = TEAM_SIZES[n].map((k) => k + (o.trapper ? 1 : 0));
  const G = {
    mid: Math.random().toString(36).slice(2, 10),
    phase: 'team',
    n,
    opts: o,
    sizes,
    players: roster.map((r, i) => ({
      seat: r.seat,
      name: r.name,
      bot: !!r.bot,
      connected: r.bot ? true : r.connected !== false,
      role: roles[i],
      side: sideOf(roles[i]),  // the side they are on now: Lancelot and the Untrustworthy Servant can change it
      revealed: false,         // the Revealer, once revealed
      plots: [],               // Plot cards in front of them
      messages: 0,             // Good Message cards played, two at most
    })),
    quest: 0,          // the Quest being decided, 0-4
    results: [],       // { quest, team, fails, needed, success, ... } — only counts are public
    rejects: 0,        // the Vote Track: Teams rejected this round
    // "Randomly select a Leader"
    leader: Math.floor(Math.random() * n),
    team: null,        // the proposed Team, while it is voted on and on its Quest
    excalibur: null,   // who the Leader gave Excalibur to
    watch: null,       // who the Leader gave the Watch token to
    votes: {},         // seat -> approve, hidden until everyone has voted
    cards: {},         // seat -> Quest card, never shown but face up
    faceUp: [],        // seats made to play face up (We Found You!)
    looks: [],         // private looks at played cards: Excalibur, Ambush, the Trapper
    switched: null,    // the card Excalibur switched, this Quest
    trapped: null,     // the card the Trapper set aside, this Quest
    proposals: [],     // every Team put to the vote, with the votes once revealed
    checks: [],        // loyalty checks: { checker, target, shown, reason, quest }
    lady: null,
    allegiance: null,  // Lancelot's Allegiance cards
    switches: 0,       // how many times the Lancelots have switched sides
    plot: null,        // the Plot deck, the cards drawn this round
    leadBlocked: false,
    recruit: null,
    assassination: null,
    winner: null,      // 'good' | 'evil' | 'rogueGood' | 'rogueEvil'
    partial: [],       // Rogues whose side won without their own victory
    why: '',
    ask: null,         // who must decide what now, when it is one player
    todo: [],          // what happens next, in order
    log: [],
  };
  // "At the beginning of the game, give the Lady of the Lake token to the
  // player on the Leader's right" — the player who would lead last
  if (o.lady) {
    const holder = G.players[(G.leader + n - 1) % n].seat;
    G.lady = { holder, held: [holder], checks: [] };
  }
  if (o.lancelot && o.lancelotVariant === 1) {
    // "four No Change (blank) cards and two Switch Allegiance cards"
    G.allegiance = { deck: shuffle(['none', 'none', 'none', 'none', 'switch', 'switch']), drawn: [] };
  } else if (o.lancelot && o.lancelotVariant === 2) {
    // "five No Change (blank) cards and two Switch Allegiance cards. Shuffle and
    // deal five Allegiance cards faceup above the tableau: one for each Quest."
    G.allegiance = { dealt: shuffle(['none', 'none', 'none', 'none', 'none', 'switch', 'switch']).slice(0, QUESTS) };
  }
  if (o.plot) {
    const deck = [];
    for (const [type, c] of Object.entries(PLOTS)) for (let i = 0; i < c.count; i++) deck.push({ id: deck.length, type });
    G.plot = { deck: shuffle(deck), hand: [], drawnFor: -1 };
  }
  const [good, evil] = SIDES[n];
  note(G, `${n} players: ${good} Good and ${evil} Evil.`);
  note(G, `${leaderName(G)} is the first Leader.`);
  if (G.allegiance && G.allegiance.dealt) note(G, `Lancelot's Allegiance cards, face up over the Quests: ${G.allegiance.dealt.map((c, i) => (c === 'switch' ? `Switch on Quest ${i + 1}` : null)).filter(Boolean).join(', ') || 'no Switch at all'}.`);
  bump(G, { kind: 'start' });
  begin(G);
  return G;
}

// The reveal, then the first round. "Leader, extend your thumb if you are
// Evil" / "Cleric, open your eyes": the Cleric's look is a loyalty check.
function begin(G) {
  const cleric = seatOfRole(G, 'cleric');
  if (cleric != null && cleric !== leaderSeat(G)) G.todo.push({ t: 'loyalty', checker: cleric, target: leaderSeat(G), reason: 'cleric' });
  G.todo.push({ t: 'round' });
  advance(G);
}

// Deal these Characters, in seat order, with this first Leader, and start
// over — for tests that need a table set up just so.
export function redeal(G, roles, leader = G.leader) {
  roles.forEach((r, i) => { G.players[i].role = r; G.players[i].side = sideOf(r); });
  G.leader = leader;
  if (G.lady) { const h = G.players[(leader + G.n - 1) % G.n].seat; G.lady = { holder: h, held: [h], checks: [] }; }
  if (G.plot) { G.plot.deck.unshift(...G.plot.hand); G.plot.hand = []; G.plot.drawnFor = -1; }
  if (G.allegiance && G.allegiance.drawn) { G.allegiance.deck.unshift(...G.allegiance.drawn); G.allegiance.drawn = []; }
  G.switches = 0;
  G.checks = [];
  G.ask = null;
  G.todo = [];
  G.phase = 'team';
  begin(G);
  return G;
}

const leaderSeat = (G) => G.players[G.leader].seat;
const leaderName = (G) => G.players[G.leader].name;
const nextLeader = (G) => { G.leader = (G.leader + 1) % G.n; };
// everyone, starting with the Leader and going clockwise
const fromLeader = (G) => G.players.map((_, i) => G.players[(G.leader + i) % G.n].seat);

// ---------------------------------------------------------------- knowledge

// What a player learns at the reveal, by the Big Box's script:
//   "Minions of Mordred - not Oberon - open your eyes and look around so that
//    you know all agents of Evil" — not the Evil Rogue, nor the Evil Sorcerer
//    with the optional rule; with Lancelot's variants Evil Lancelot instead
//    "extend[s] your thumb so that the other agents of Evil may know you";
//   "Minions of Mordred - not Mordred himself - extend your thumb so that
//    Merlin will know of you" — nor the Evil Rogue; and the Untrustworthy
//    Servant extends a thumb with them;
//   "Merlin & Morgana, extend your thumb so that Percival may know of you";
//   "Lancelot, open your eyes to reveal your counterpart" (not in the variants);
//   "Assassin, extend your thumb so that the Untrustworthy Servant may know you";
//   "Junior Messenger, extend your thumb so that the Senior Messenger may know
//    you" (the optional rule).
// Then what loyalty checks showed. Marks: 'evil', 'good', 'merlin',
// 'merlin?' (one of two is Merlin), 'assassin', 'junior', 'lancelot-good' /
// 'lancelot-evil' (holds that Lancelot card), 'shown-good' / 'shown-evil'
// (what a loyalty check showed — the Trickster may lie, the Troublemaker must).
export function knowledge(G, seat) {
  const me = playerBySeat(G, seat);
  const out = {};
  if (!me) return out;
  const o = G.opts;
  const mine = me.role;
  const variant = o.lancelot && o.lancelotVariant > 0;
  const unseen = (r) => r === 'oberon' || r === 'rogueEvil' || (r === 'sorcererEvil' && o.sorcererHidden);
  const evilCard = (r) => sideOf(r) === 'evil';
  const opensEyes = evilCard(mine) && !unseen(mine) && !(variant && mine === 'lancelotEvil');
  for (const p of G.players) {
    if (p.seat === seat) continue;
    const r = p.role;
    if (opensEyes && evilCard(r) && !unseen(r)) out[p.seat] = variant && r === 'lancelotEvil' ? 'lancelot-evil' : 'evil';
    if (mine === 'merlin' && ((evilCard(r) && r !== 'mordred' && r !== 'rogueEvil' && !(r === 'sorcererEvil' && o.sorcererHidden)) || r === 'untrustworthy')) out[p.seat] = 'evil';
    if (mine === 'percival' && (r === 'merlin' || r === 'morgana')) out[p.seat] = o.morgana ? 'merlin?' : 'merlin';
    if (o.lancelot && !variant && isLancelot(mine) && isLancelot(r)) out[p.seat] = r === 'lancelotGood' ? 'lancelot-good' : 'lancelot-evil';
    if (mine === 'untrustworthy' && r === 'assassin') out[p.seat] = 'assassin';
    if (o.messengerSenior && mine === 'messengerSenior' && r === 'messengerJunior') out[p.seat] = 'junior';
  }
  for (const c of G.checks) {
    if (c.checker !== seat || c.target === seat) continue;
    if (!out[c.target] || out[c.target] === 'merlin?' || out[c.target].startsWith('shown')) out[c.target] = c.shown === 'good' ? 'shown-good' : 'shown-evil';
  }
  return out;
}

// what a loyalty check of this player may show: the truth — but the
// Trickster "may lie" and the Troublemaker "must lie"
export function loyaltyOptions(p) {
  const other = p.side === 'good' ? 'evil' : 'good';
  if (p.role === 'trickster') return [p.side, other];
  if (p.role === 'troublemaker') return [other];
  return [p.side];
}

// ---------------------------------------------------------------- the flow

// Run what comes next until someone has to decide something.
function advance(G) {
  for (let guard = 0; guard < 500; guard++) {
    if (G.phase === 'over' || G.ask) return;
    if (G.phase === 'vote' || G.phase === 'quest') return;
    const step = G.todo.shift();
    if (!step) return;
    run(G, step);
  }
}

function run(G, step) {
  const o = G.opts;
  switch (step.t) {
    case 'round': return startRound(G);
    case 'lead': {
      // "Lead to Victory ... must be declared before the current Leader takes
      // any actions"; precedence "by proximity to the Leader (starting with
      // the Leader in a clockwise manner)"
      if (!o.plot || G.leadBlocked) return;
      const order = fromLeader(G).filter((s) => s !== leaderSeat(G) && hasPlot(playerBySeat(G, s), 'lead'));
      G.todo.unshift(...order.map((s) => ({ t: 'ask', kind: 'lead', seat: s })));
      return;
    }
    case 'ask': {
      const p = playerBySeat(G, step.seat);
      if (step.kind === 'lead' && (G.leadBlocked || !hasPlot(p, 'lead') || step.seat === leaderSeat(G))) return;
      if ((step.kind === 'king' || step.kind === 'ambush' || step.kind === 'spot') && !hasPlot(p, step.kind)) return;
      if (step.kind === 'ambush' && !G.team.some((s) => s !== step.seat && !ambushed(G, s))) return;
      G.ask = { kind: step.kind, seat: step.seat };
      return;
    }
    case 'plots': {
      if (!o.plot || G.plot.drawnFor === G.quest) return;
      G.plot.drawnFor = G.quest;
      const k = Math.min(PLOTS_DRAWN[G.n], G.plot.deck.length);
      G.plot.hand = G.plot.deck.splice(0, k);
      if (G.plot.hand.length) {
        note(G, `${leaderName(G)} draws ${listWords(G.plot.hand.map((c) => PLOTS[c.type].name))}.`);
        G.todo.unshift({ t: 'give' });
      }
      return;
    }
    case 'give':
      if (G.plot.hand.length) G.ask = { kind: 'give', seat: leaderSeat(G) };
      return;
    case 'effect': return plotEffect(G, step);
    case 'loyalty':
      G.ask = { kind: 'loyalty', seat: step.target, checker: step.checker, reason: step.reason };
      return;
    case 'propose':
      G.phase = 'team';
      G.ask = { kind: 'propose', seat: leaderSeat(G) };
      return;
    case 'king': {
      if (!o.plot) return;
      const order = fromLeader(G).filter((s) => hasPlot(playerBySeat(G, s), 'king'));
      G.todo.unshift(...order.map((s) => ({ t: 'ask', kind: 'king', seat: s })));
      return;
    }
    case 'watch':
      // "In games of five or six players, a Watch token is not used on the
      // first two Quests."
      if (!(o.rogueGood || o.rogueEvil) || (G.n <= 6 && G.quest < 2)) return;
      G.ask = { kind: 'watch', seat: leaderSeat(G) };
      return;
    case 'spot': {
      if (!o.plot) return;
      const order = fromLeader(G).filter((s) => hasPlot(playerBySeat(G, s), 'spot'));
      G.todo.unshift(...order.map((s) => ({ t: 'ask', kind: 'spot', seat: s })));
      return;
    }
    case 'play':
      G.phase = 'quest';
      G.cards = {};
      return;
    case 'excalibur':
      if (G.excalibur != null && G.team.includes(G.excalibur) && G.team.some((s) => s !== G.excalibur && !G.faceUp.includes(s))) G.ask = { kind: 'excalibur', seat: G.excalibur };
      return;
    case 'ambush': {
      if (!o.plot) return;
      const order = fromLeader(G).filter((s) => hasPlot(playerBySeat(G, s), 'ambush'));
      G.todo.unshift(...order.map((s) => ({ t: 'ask', kind: 'ambush', seat: s })));
      return;
    }
    case 'trap':
      if (o.trapper) G.ask = { kind: 'trap', seat: leaderSeat(G) };
      return;
    case 'resolve': return resolveQuest(G);
    case 'after': return afterQuest(G, step);
    case 'lady':
      G.phase = 'lady';
      G.ask = { kind: 'lady', seat: G.lady.holder };
      return;
    case 'declare':
      G.ask = { kind: 'declare', seat: step.holder, target: step.target };
      return;
    case 'recruit':
      G.phase = 'recruit';
      G.ask = { kind: 'recruit', seat: seatOfRole(G, 'assassin') };
      return;
    case 'assassinate':
      G.phase = 'assassin';
      G.ask = { kind: 'assassinate', seat: G.recruit && G.recruit.hit ? G.recruit.target : seatOfRole(G, 'assassin') };
      return;
    default:
      return;
  }
}

function startRound(G) {
  // "At the beginning of the first Quest, and at the beginning of each
  // subsequent Quest, someone draws a card from the Allegiance deck" (Variant
  // 1); "If a Switch Allegiance card has been dealt above a Quest, the two
  // Lancelot players secretly switch their allegiances at the very beginning
  // of the Quest" (Variant 2)
  if (G.allegiance) {
    let card;
    if (G.allegiance.deck) {
      card = G.allegiance.deck.shift();
      G.allegiance.drawn.push(card);
      note(G, card === 'switch' ? 'Quest ' + (G.quest + 1) + ': the Allegiance card is Switch Allegiance — the two Lancelots secretly change sides.' : `Quest ${G.quest + 1}: the Allegiance card is No Change.`);
    } else {
      card = G.allegiance.dealt[G.quest];
      if (card === 'switch') note(G, `Quest ${G.quest + 1} begins under a Switch Allegiance card: the two Lancelots secretly change sides.`);
    }
    if (card === 'switch') {
      for (const p of G.players) if (isLancelot(p.role)) p.side = p.side === 'good' ? 'evil' : 'good';
      G.switches++;
      bump(G, { kind: 'switch' });
    }
  }
  G.todo.unshift({ t: 'lead' }, { t: 'plots' }, { t: 'propose' });
}

function plotEffect(G, step) {
  const p = playerBySeat(G, step.seat);
  switch (step.type) {
    case 'one': G.ask = { kind: 'adjacent', seat: p.seat }; return;
    case 'strength': G.ask = { kind: 'showto', seat: leaderSeat(G), plot: 'strength' }; return;
    case 'nature': G.ask = { kind: 'showto', seat: p.seat, plot: 'nature' }; return;
    case 'honor':
      if (G.players.some((q) => q.seat !== p.seat && q.plots.length)) G.ask = { kind: 'take', seat: p.seat };
      else note(G, `No one else has a Plot card for ${p.name} to take.`);
      return;
    default:
  }
}

// ---------------------------------------------------------------- moves

export function applyMove(G, seat, move) {
  const p = playerBySeat(G, seat);
  if (!p) return { ok: false, error: 'No such player.' };
  if (!move || typeof move !== 'object') return { ok: false, error: 'No move.' };
  if (G.phase === 'over') return { ok: false, error: 'The game is over.' };
  let r;
  if (move.kind === 'vote') r = vote(G, p, move.approve);
  else if (move.kind === 'quest') r = questCard(G, p, move.card);
  else {
    const a = G.ask;
    if (!a || a.seat !== seat || a.kind !== move.kind) return { ok: false, error: 'That is not yours to do now.' };
    r = answer(G, p, a, move);
    if (r.ok && G.ask === a) G.ask = null;
  }
  if (r.ok) advance(G);
  return r;
}

const isSeat = (G, s) => Number.isInteger(s) && !!playerBySeat(G, s);

function answer(G, p, a, move) {
  switch (a.kind) {
    case 'propose': return propose(G, p, move.team, move.excalibur);
    case 'lead': {
      if (!move.use) return { ok: true };
      discardPlot(G, p, 'lead');
      G.leader = G.players.indexOf(p);
      G.leadBlocked = true;
      note(G, `${p.name} plays Lead to Victory and becomes the Leader.`);
      bump(G, { kind: 'plot', seat: p.seat, type: 'lead' });
      // the next Leader in line gets no turn of their own: a new window opens
      // for whoever holds the other card, after a vote
      return { ok: true };
    }
    case 'give': return give(G, p, move.card, move.to);
    case 'adjacent': {
      const i = G.players.indexOf(p);
      const near = [G.players[(i + 1) % G.n].seat, G.players[(i + G.n - 1) % G.n].seat];
      if (!near.includes(move.target)) return { ok: false, error: 'Pick the player to your left or right.' };
      note(G, `${p.name} checks the loyalty of ${nameOf(G, move.target)} (Are You the One?).`);
      G.todo.unshift({ t: 'loyalty', checker: p.seat, target: move.target, reason: 'one' });
      return { ok: true };
    }
    case 'showto': {
      if (!isSeat(G, move.target) || move.target === p.seat) return { ok: false, error: 'Pick another player.' };
      note(G, `${p.name} passes a Loyalty card to ${nameOf(G, move.target)} (${PLOTS[a.plot].name}).`);
      G.todo.unshift({ t: 'loyalty', checker: move.target, target: p.seat, reason: a.plot });
      return { ok: true };
    }
    case 'take': {
      const from = isSeat(G, move.from) ? playerBySeat(G, move.from) : null;
      if (!from || from === p || !Number.isInteger(move.card) || !from.plots.some((c) => c.id === move.card)) return { ok: false, error: 'Take a Plot card another player has.' };
      const c = from.plots.find((x) => x.id === move.card);
      from.plots = from.plots.filter((x) => x !== c);
      p.plots.push(c);
      note(G, `${p.name} takes ${PLOTS[c.type].name} from ${from.name} (Restore Your Honor).`);
      return { ok: true };
    }
    case 'loyalty': {
      if (!loyaltyOptions(p).includes(move.card)) return { ok: false, error: p.role === 'troublemaker' ? 'The Troublemaker must show the other loyalty.' : 'Pass the Loyalty card of your side.' };
      G.checks.push({ checker: a.checker, target: p.seat, shown: move.card, reason: a.reason, quest: G.quest });
      if (a.reason === 'lady') G.check = { holder: a.checker, target: p.seat, shown: move.card };
      return { ok: true };
    }
    case 'king': {
      if (!move.use) return { ok: true };
      discardPlot(G, p, 'king');
      G.proposals[G.proposals.length - 1].vetoed = p.seat;
      note(G, `${p.name} plays The King Returns: the approved Team is rejected.`);
      bump(G, { kind: 'plot', seat: p.seat, type: 'king' });
      G.todo = [];
      G.team = null;
      G.excalibur = null;
      rejected(G, 'The King Returns');
      return { ok: true };
    }
    case 'watch': {
      if (!G.team.includes(move.target)) return { ok: false, error: 'Give the Watch token to a member of the Team.' };
      G.watch = move.target;
      note(G, `${p.name} gives the Watch token to ${nameOf(G, move.target)}.`);
      return { ok: true };
    }
    case 'spot': {
      if (move.target == null) return { ok: true };
      if (!G.team.includes(move.target)) return { ok: false, error: 'Pick a member of the Team.' };
      discardPlot(G, p, 'spot');
      if (!G.faceUp.includes(move.target)) G.faceUp.push(move.target);
      note(G, `${p.name} plays We Found You!: ${nameOf(G, move.target)} must play their Quest card face up.`);
      bump(G, { kind: 'plot', seat: p.seat, type: 'spot', target: move.target });
      return { ok: true };
    }
    case 'excalibur': {
      if (move.target == null) { note(G, `${p.name} keeps Excalibur sheathed.`); return { ok: true }; }
      if (!G.team.includes(move.target) || move.target === p.seat) return { ok: false, error: 'Switch the card of another member of the Team.' };
      if (G.faceUp.includes(move.target)) return { ok: false, error: 'A card played face up cannot be switched.' };
      const was = G.cards[move.target];
      G.cards[move.target] = switchCard(was);
      G.switched = { by: p.seat, target: move.target };
      G.looks.push({ kind: 'excalibur', quest: G.quest, by: p.seat, target: move.target, card: was });
      note(G, `${p.name} wields Excalibur and switches ${nameOf(G, move.target)}'s Quest card.`);
      bump(G, { kind: 'excalibur', seat: p.seat, target: move.target });
      return { ok: true };
    }
    case 'ambush': {
      if (move.target == null) return { ok: true };
      if (!G.team.includes(move.target) || move.target === p.seat) return { ok: false, error: 'Look at the card of a member of the Team.' };
      if (ambushed(G, move.target)) return { ok: false, error: 'No more than one player may look at a player’s card on a Quest.' };
      discardPlot(G, p, 'ambush');
      G.looks.push({ kind: 'ambush', quest: G.quest, by: p.seat, target: move.target, card: G.cards[move.target] });
      note(G, `${p.name} plays Ambush and looks at ${nameOf(G, move.target)}'s Quest card.`);
      bump(G, { kind: 'plot', seat: p.seat, type: 'ambush', target: move.target });
      return { ok: true };
    }
    case 'trap': {
      if (!G.team.includes(move.target)) return { ok: false, error: 'Set aside the card of a member of the Team.' };
      G.trapped = { by: p.seat, target: move.target };
      G.looks.push({ kind: 'trap', quest: G.quest, by: p.seat, target: move.target, card: G.cards[move.target] });
      note(G, `${p.name} sets aside ${nameOf(G, move.target)}'s Quest card unrevealed.`);
      return { ok: true };
    }
    case 'lady': return ladyLook(G, p, move.target);
    case 'declare': return ladyDeclare(G, p, a, move.says);
    case 'recruit': return recruit(G, p, move.target);
    case 'assassinate': return assassinate(G, p, move);
    default:
      return { ok: false, error: 'Unknown move.' };
  }
}

// a player's card already looked at with Ambush on this Quest
const ambushed = (G, s) => G.looks.some((l) => l.kind === 'ambush' && l.quest === G.quest && l.target === s);

function discardPlot(G, p, type) {
  const c = p.plots.find((x) => x.type === type);
  p.plots = p.plots.filter((x) => x !== c);
}

// "the Leader draws Plot cards ... and chooses the player(s) to receive the
// card(s). The Leader may not keep the Plot card for themself. The Leader
// chooses the order in which Plot cards are distributed. Any immediate cards
// are resolved as soon as they are passed."
function give(G, p, cardId, to) {
  const c = G.plot.hand.find((x) => x.id === cardId);
  if (!c) return { ok: false, error: 'Give one of the Plot cards you drew.' };
  if (!isSeat(G, to) || to === p.seat) return { ok: false, error: 'The Leader may not keep a Plot card: give it to another player.' };
  G.plot.hand = G.plot.hand.filter((x) => x !== c);
  const q = playerBySeat(G, to);
  note(G, `${p.name} gives ${PLOTS[c.type].name} to ${q.name}.`);
  bump(G, { kind: 'plot', seat: to, type: c.type, given: true });
  const next = G.plot.hand.length ? [{ t: 'give' }] : [];
  if (PLOTS[c.type].use === 'now') G.todo.unshift({ t: 'effect', type: c.type, seat: to }, ...next);
  else { q.plots.push(c); G.todo.unshift(...next); }
  return { ok: true };
}

// Team Building: "the Leader takes the required number of Team tokens ... and
// assigns each Team token to any player. The Leader may be on the Team, but is
// not required to be so." Excalibur: "assigned by the Leader to one of the
// players on the Team ... The Leader cannot assign Excalibur to themself."
function propose(G, p, team, excalibur) {
  const k = G.sizes[G.quest];
  if (!Array.isArray(team) || team.length !== k) return { ok: false, error: `This Quest needs a Team of ${k}.` };
  if (new Set(team).size !== k || team.some((s) => !isSeat(G, s))) return { ok: false, error: 'Pick different players at the table.' };
  if (G.opts.excalibur) {
    if (!team.includes(excalibur) || excalibur === p.seat) return { ok: false, error: 'Give Excalibur to a member of the Team other than yourself.' };
  }
  G.team = seats(G).filter((s) => team.includes(s)); // table order
  G.excalibur = G.opts.excalibur ? excalibur : null;
  G.votes = {};
  G.phase = 'vote';
  note(G, `${p.name} proposes ${names(G, G.team)} for Quest ${G.quest + 1}${G.excalibur != null ? `, with Excalibur for ${nameOf(G, G.excalibur)}` : ''}.`);
  bump(G, { kind: 'team', leader: p.seat, team: G.team.slice() });
  return { ok: true };
}

// Charge!: "must select and reveal their vote token before any other players
// have selected their vote tokens"
const chargers = (G) => (G.opts.plot ? G.players.filter((q) => hasPlot(q, 'charge')).map((q) => q.seat) : []);
const chargeDone = (G) => chargers(G).every((s) => G.votes[s] !== undefined);

// The Team Vote: "Each player, including the Leader, secretly selects one vote
// token ... The Team is approved if the majority accepts. If the vote is tied,
// or the majority rejects the Team, the Leader passes clockwise". "Evil wins
// the game if five Teams are rejected in a single round".
function vote(G, p, approve) {
  if (G.phase !== 'vote') return { ok: false, error: 'There is no Team to vote on.' };
  if (typeof approve !== 'boolean') return { ok: false, error: 'Approve or reject.' };
  if (G.votes[p.seat] !== undefined) return { ok: false, error: 'You have already voted.' };
  if (!chargers(G).includes(p.seat) && !chargeDone(G)) return { ok: false, error: 'The Charge! holders vote first.' };
  G.votes[p.seat] = approve;
  if (G.players.every((q) => G.votes[q.seat] !== undefined)) resolveVote(G);
  return { ok: true };
}

function resolveVote(G) {
  const yes = G.players.filter((q) => G.votes[q.seat]).length;
  const no = G.n - yes;
  const approved = yes > no;
  G.proposals.push({ quest: G.quest, attempt: G.rejects + 1, leader: leaderSeat(G), team: G.team.slice(), excalibur: G.excalibur, votes: { ...G.votes }, approved });
  G.leadBlocked = false;
  if (approved) {
    note(G, `The Team is approved, ${yes}–${no}. ${names(G, G.team)} go on Quest ${G.quest + 1}.`);
    bump(G, { kind: 'vote', approved, yes, no });
    G.phase = 'onquest';
    G.watch = null;
    G.faceUp = [];
    G.switched = null;
    G.trapped = null;
    G.todo.unshift({ t: 'king' }, { t: 'watch' }, { t: 'spot' }, { t: 'play' });
    return;
  }
  note(G, `The Team is rejected, ${yes}–${no}.`);
  bump(G, { kind: 'vote', approved, yes, no, rejects: G.rejects + 1 });
  rejected(G, null);
}

// a Team that does not go: the Vote Track moves, the Leader passes on
function rejected(G, how) {
  G.rejects++;
  if (G.rejects >= MAX_REJECTS) return endGame(G, 'evil', how ? `five Teams were rejected in a single round, the last by ${how}` : 'five Teams were rejected in a single round');
  note(G, `The Vote Track moves to ${G.rejects}.`);
  nextLeader(G);
  G.team = null;
  G.excalibur = null;
  G.phase = 'team';
  G.todo.unshift({ t: 'lead' }, { t: 'propose' });
}

// The cards a player may play on this Quest.
//   "Good players must select a Success card. Evil players may select a
//   Success or Fail card as they choose." The Lunatic "must Fail every Quest";
//   the Brute "may Fail only the first three Quests"; in Lancelot's Variant 2
//   "Evil Lancelot may only play a Fail card". "The Good Rogue is the only
//   player that may play the Rogue Success card, and the Evil Rogue is the
//   only player that may play the Rogue Fail card" — not while holding the
//   Watch token. "Only the Sorcerers may play a Magic Quest card. The Evil
//   Sorcerer may only play Success or Magic." "Good Messengers may play either
//   a Success card or a Good Message card. Evil Messengers may play a Success
//   card, a Fail card, or an Evil Message card" — a Good Messenger "only ...
//   up to twice over the course of the game".
export function allowedCards(G, p) {
  const r = p.role;
  const watched = G.watch === p.seat;
  if (p.side === 'good') {
    const out = ['success'];
    if (r === 'rogueGood' && !watched) out.push('rogueSuccess');
    if (r === 'sorcererGood') out.push('magic');
    if (isMessenger(r) && p.messages < 2) out.push('goodMessage');
    return out;
  }
  if (r === 'lunatic') return ['fail'];
  if (r === 'lancelotGood' || r === 'lancelotEvil') if (G.opts.lancelotVariant === 2) return ['fail'];
  if (r === 'brute' && G.quest >= 3) return ['success'];
  if (r === 'sorcererEvil') return ['success', 'magic'];
  const out = ['success', 'fail'];
  if (r === 'rogueEvil' && !watched) out.push('rogueFail');
  if (r === 'messengerEvil') out.push('evilMessage');
  return out;
}

function questCard(G, p, card) {
  if (G.phase !== 'quest') return { ok: false, error: 'No Quest is under way.' };
  if (!G.team.includes(p.seat)) return { ok: false, error: 'You are not on this Quest.' };
  if (G.cards[p.seat]) return { ok: false, error: 'You have already played your Quest card.' };
  if (!CARDS[card]) return { ok: false, error: 'Play one of your Quest cards.' };
  if (!allowedCards(G, p).includes(card)) return { ok: false, error: 'You may not play that card.' };
  G.cards[p.seat] = card;
  if (card === 'goodMessage') p.messages++;
  if (G.team.every((s) => G.cards[s])) {
    G.phase = 'onquest';
    G.todo.unshift({ t: 'excalibur' }, { t: 'ambush' }, { t: 'trap' }, { t: 'resolve' });
  }
  return { ok: true };
}

// Excalibur: "the unplayed card becomes the played card" — with more than two
// cards in a set, a Success of any kind becomes Fail and a Fail of any kind,
// or Magic, becomes Success.
export const switchCard = (c) => (CARDS[c].fail || c === 'magic' ? 'success' : 'fail');

function resolveQuest(G) {
  const q = G.quest;
  const o = G.opts;
  // the Trapper's card "does not affect the results"
  const counted = G.team.filter((s) => !(G.trapped && G.trapped.target === s));
  const played = counted.map((s) => G.cards[s]);
  let fails = played.filter((c) => CARDS[c].fail).length;
  const magic = played.filter((c) => c === 'magic').length;
  const messages = { good: played.filter((c) => c === 'goodMessage').length, evil: played.filter((c) => c === 'evilMessage').length };
  const rogue = { success: played.filter((c) => c === 'rogueSuccess').length, fail: played.filter((c) => c === 'rogueFail').length };
  const needed = failsNeeded(G.n, q);
  let backup = null;
  if (o.messengers && q === QUESTS - 1) {
    // "If there are 3 or more Good Messages, Good may remove one Fail card from
    // the final Quest. If there are 2 or more Evil Messages, Evil may add one
    // Fail card to the final Quest. If both occur, the effects cancel out"
    const good = G.results.reduce((t, r) => t + r.messages.good, 0) + messages.good;
    const evil = G.results.reduce((t, r) => t + r.messages.evil, 0) + messages.evil;
    const g = good >= 3, e = evil >= 2;
    backup = g && e ? 'cancel' : g ? 'good' : e ? 'evil' : null;
    if (backup === 'good' && fails > 0) fails--;
    if (backup === 'evil') fails++;
  }
  let success = fails < needed;
  // "An odd number of Magic cards reverses the outcome of a Quest"
  if (magic % 2 === 1) success = !success;
  const faceUp = Object.fromEntries(G.faceUp.filter((s) => G.cards[s]).map((s) => [s, G.cards[s]]));
  const res = {
    quest: q, team: G.team.slice(), leader: leaderSeat(G), fails, needed, success, magic, messages, rogue, backup,
    faceUp, switched: G.switched, trapped: G.trapped ? G.trapped.target : null, excalibur: G.excalibur, watch: G.watch,
    // the Rogue cards "played", for the Rogues' own victory — public, as tokens
    rogueBy: counted.filter((s) => G.cards[s] === 'rogueSuccess' || G.cards[s] === 'rogueFail'),
  };
  G.results.push(res);
  const bits = [];
  if (fails) bits.push(`${fails} Fail${fails === 1 ? '' : 's'}`);
  if (magic) bits.push(`${magic} Magic`);
  if (messages.good || messages.evil) bits.push([messages.good ? `${messages.good} Good Message${messages.good === 1 ? '' : 's'}` : '', messages.evil ? `${messages.evil} Evil Message${messages.evil === 1 ? '' : 's'}` : ''].filter(Boolean).join(', '));
  if (rogue.success || rogue.fail) bits.push([rogue.success ? 'a Rogue Success' : '', rogue.fail ? 'a Rogue Fail' : ''].filter(Boolean).join(', '));
  if (backup) bits.push(backup === 'cancel' ? 'both sides called for backup, which cancels out' : backup === 'good' ? 'Good’s backup took a Fail away' : 'Evil’s backup added a Fail');
  note(G, `Quest ${q + 1} ${success ? 'succeeds' : 'fails'} — ${bits.length ? listWords(bits) : 'all Success'}${needed === 2 && fails === 1 ? ', but it needed 2 Fails' : ''}.`);
  bump(G, { kind: 'quest', quest: q, success, fails, needed, magic });
  G.cards = {};
  G.faceUp = [];
  G.todo.unshift({ t: 'after', quest: q });
}

function afterQuest(G, step) {
  const q = step.quest;
  G.team = null;
  G.excalibur = null;
  G.watch = null;
  G.switched = null;
  G.trapped = null;
  // "After the Quest has been completed ... The Leader passes clockwise"
  G.rejects = 0;
  nextLeader(G);
  const won = G.results.filter((r) => r.success).length;
  const lost = G.results.length - won;
  const res = G.results[q];
  // "They must reveal their identity after the second failed Quest."
  if (!res.success && lost === 2) {
    const rv = G.players.find((p) => p.role === 'revealer');
    if (rv) { rv.revealed = true; note(G, `${rv.name} reveals themself: the Revealer, an agent of Evil.`); bump(G, { kind: 'reveal', seat: rv.seat }); }
  }
  if (lost >= 3) {
    // "An Evil Rogue wins immediately after the third failed Quest if they have
    // played a Rogue Fail card on the third failed Quest and at least one more
    // Rogue Fail card on a prior Quest."
    const er = G.players.find((p) => p.role === 'rogueEvil');
    if (er && rogueWin(G, er.seat, 'rogueFail')) return endGame(G, 'rogueEvil', `three Quests failed, and ${er.name}, the Evil Rogue, played Rogue Fail on the last and on one before`);
    return endGame(G, 'evil', 'three Quests failed');
  }
  if (won >= 3) {
    const gr = G.players.find((p) => p.role === 'rogueGood');
    if (gr && rogueWin(G, gr.seat, 'rogueSuccess')) return endGame(G, 'rogueGood', `three Quests succeeded, and ${gr.name}, the Good Rogue, played Rogue Success on the last and on one before`);
    note(G, 'Three Quests have succeeded. Evil has one last chance.');
    bump(G, { kind: 'assassin' });
    if (G.players.some((p) => p.role === 'untrustworthy')) G.todo.unshift({ t: 'recruit' });
    G.todo.push({ t: 'assassinate' });
    return;
  }
  G.quest++;
  // "Immediately after the second, third, and fourth Quest is resolved, the
  // player with the Lady of the Lake token will choose one player"
  if (G.lady && q >= 1 && q <= 3) G.todo.unshift({ t: 'lady' });
  G.todo.push({ t: 'round' });
}

// the last Quest of the three, and one more before it, with the Rogue's card
function rogueWin(G, seat, card) {
  const mine = G.results.filter((r) => r.rogueBy.includes(seat) && (card === 'rogueSuccess' ? r.rogue.success : r.rogue.fail));
  const last = G.results[G.results.length - 1];
  return mine.includes(last) && mine.length >= 2;
}

// The Lady of the Lake: "A player that used the Lady of the Lake ability
// cannot have the ability used on them." The holder sees the Loyalty card in
// private, may say what they like about it, and the token passes on.
export const ladyTargets = (G) => (G.lady ? seats(G).filter((s) => !G.lady.held.includes(s)) : []);

function ladyLook(G, p, target) {
  if (!ladyTargets(G).includes(target)) return { ok: false, error: 'Pick a player who has not held the Lady of the Lake.' };
  note(G, `${p.name}, the Lady of the Lake, examines ${nameOf(G, target)}'s loyalty.`);
  bump(G, { kind: 'lady', holder: p.seat, target });
  G.todo.unshift({ t: 'loyalty', checker: p.seat, target, reason: 'lady' }, { t: 'declare', holder: p.seat, target });
  return { ok: true };
}

function ladyDeclare(G, p, a, says) {
  if (says !== 'good' && says !== 'evil' && says !== null) return { ok: false, error: 'Declare Good, Evil, or nothing.' };
  const shown = G.check && G.check.target === a.target ? G.check.shown : null;
  G.lady.checks.push({ quest: G.quest - 1, holder: p.seat, target: a.target, shown, declared: says });
  G.lady.holder = a.target;
  G.lady.held.push(a.target);
  G.check = null;
  const t = nameOf(G, a.target);
  note(G, says ? `${p.name} declares that ${t} is ${says === 'good' ? 'Good' : 'Evil'}.` : `${p.name} keeps what the Lady showed to themselves.`);
  note(G, `${t} now holds the Lady of the Lake.`);
  bump(G, { kind: 'declare', holder: p.seat, target: a.target, says });
  G.phase = 'team';
  return { ok: true };
}

// "If three Quests succeed, enter the Recruitment stage before entering the
// Assassination stage. The Assassin has one chance to guess which player is
// the Untrustworthy Servant."
function recruit(G, p, target) {
  if (!isSeat(G, target) || target === p.seat) return { ok: false, error: 'Name another player.' };
  const t = playerBySeat(G, target);
  const hit = t.role === 'untrustworthy';
  G.recruit = { by: p.seat, target, hit };
  if (hit) {
    t.side = 'evil';
    note(G, `${p.name} recruits ${t.name} — the Untrustworthy Servant, who is now Evil and will name Merlin.`);
  } else note(G, `${p.name} tries to recruit ${t.name}, who is not the Untrustworthy Servant.`);
  bump(G, { kind: 'recruit', by: p.seat, target, hit });
  return { ok: true };
}

// "the Assassin names a Good player as Merlin. If the Assassin guesses
// correctly, Evil wins the day." With the Messengers "the Assassin may target
// either Merlin or the Messengers, but they must announce which before
// assassinating. If the Assassin chooses the latter, they must correctly
// identify both Good Messengers for Evil to win."
export const assassinSeat = (G) => (G.ask && G.ask.kind === 'assassinate' ? G.ask.seat : seatOfRole(G, 'assassin'));

function assassinate(G, p, move) {
  const known = new Set(Object.entries(knowledge(G, p.seat)).filter(([, m]) => m === 'evil' || m === 'assassin').map(([s]) => Number(s)));
  if (move.messengers !== undefined) {
    if (!G.opts.messengers) return { ok: false, error: 'There are no Messengers to name.' };
    const m = move.messengers;
    if (!Array.isArray(m) || m.length !== 2 || m[0] === m[1] || !m.every((s) => isSeat(G, s) && s !== p.seat && !known.has(s))) return { ok: false, error: 'Name two other players as the Good Messengers.' };
    const hit = m.every((s) => isMessenger(playerBySeat(G, s).role));
    G.assassination = { by: p.seat, messengers: m.slice(), hit };
    note(G, `${p.name} names ${names(G, m)} as the Good Messengers.`);
    if (hit) endGame(G, 'evil', `the Good Messengers were found: ${names(G, m)}`);
    else endGame(G, 'good', 'three Quests succeeded and the Good Messengers were not both found');
    return { ok: true };
  }
  const t = isSeat(G, move.target) ? playerBySeat(G, move.target) : null;
  if (!t || t.seat === p.seat) return { ok: false, error: 'Name another player.' };
  if (known.has(t.seat)) return { ok: false, error: 'Name a Good player — that one is an agent of Evil.' };
  G.assassination = { by: p.seat, target: t.seat, hit: t.role === 'merlin' };
  note(G, `${p.name} names ${t.name} as Merlin.`);
  if (t.role === 'merlin') endGame(G, 'evil', `Merlin was found: ${t.name}`);
  else endGame(G, 'good', `three Quests succeeded and Merlin stayed hidden — ${t.name} was not Merlin`);
  return { ok: true };
}

function endGame(G, winner, why) {
  G.phase = 'over';
  G.winner = winner;
  G.why = why;
  G.ask = null;
  G.todo = [];
  // "Either Rogue gets a partial victory if their Team wins ... but they were
  // not able to meet their individual victory conditions."
  G.partial = G.players.filter((p) => (p.role === 'rogueGood' || p.role === 'rogueEvil') && p.side === winner).map((p) => p.seat);
  const who = { good: 'Good', evil: 'Evil', rogueGood: 'The Good Rogue', rogueEvil: 'The Evil Rogue' }[winner];
  note(G, `${who} wins — ${why}.`);
  bump(G, { kind: 'over', winner });
}

// did this player win?
export const won = (G, p) => (G.winner === 'rogueGood' || G.winner === 'rogueEvil' ? p.role === G.winner : p.side === G.winner);

// who the table is waiting on
export function waitingOn(G) {
  if (G.phase === 'over') return [];
  if (G.ask) return [G.ask.seat];
  if (G.phase === 'vote') {
    const c = chargers(G).filter((s) => G.votes[s] === undefined);
    if (c.length) return c;
    return seats(G).filter((s) => G.votes[s] === undefined);
  }
  if (G.phase === 'quest') return G.team.filter((s) => !G.cards[s]);
  return [];
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

// A player's view of the table. Characters stay hidden — your own, and the
// marks your Character's reveal and loyalty checks give you, are all you get
// — until the game ends (the Revealer's is shown once revealed). Votes stay
// face down until the last one is in (a Charge! holder's as soon as the
// Charge! holders have voted); Quest cards are never shown but face up — only
// what each Quest's cards add up to — and a look at a card is for the looker.
export function viewFor(G, seat, code, opts = {}) {
  const me = playerBySeat(G, seat);
  const over = G.phase === 'over';
  const a = G.ask;
  const mine = !!(me && a && a.seat === seat);
  const charge = chargers(G);
  const chargeIn = G.phase === 'vote' && charge.length && chargeDone(G);
  return {
    code, mid: G.mid, you: seat,
    phase: G.phase, n: G.n, opts: G.opts,
    sides: SIDES[G.n], sizes: G.sizes, twoFail: G.n >= 7 ? 3 : null,
    quest: G.quest, rejects: G.rejects,
    results: G.results.map(({ rogueBy, ...r }) => ({ ...r, rogueBy: over ? rogueBy : undefined })),
    leader: leaderSeat(G),
    team: G.team, excalibur: G.excalibur, watch: G.watch,
    ask: a ? { kind: a.kind, seat: a.seat, checker: a.reason === 'cleric' && !mine && a.checker !== seat ? undefined : a.checker, reason: a.reason, plot: a.plot, target: a.target } : null,
    voted: G.phase === 'vote' ? seats(G).filter((s) => G.votes[s] !== undefined) : [],
    myVote: G.phase === 'vote' && me ? G.votes[seat] : undefined,
    chargers: charge,
    chargeVotes: chargeIn ? Object.fromEntries(charge.map((s) => [s, G.votes[s]])) : null,
    played: G.phase === 'quest' || G.phase === 'onquest' ? (G.team || []).filter((s) => G.cards[s]) : [],
    faceUp: G.team ? Object.fromEntries(G.faceUp.map((s) => [s, G.cards[s] || null])) : {},
    myCard: me && G.team && G.team.includes(seat) ? G.cards[seat] || null : null,
    myCards: me && G.phase === 'quest' && G.team.includes(seat) && !G.cards[seat] ? allowedCards(G, me) : null,
    switched: G.switched, trapped: G.trapped ? G.trapped.target : null,
    proposals: G.proposals,
    lady: G.lady ? {
      holder: G.lady.holder, held: G.lady.held,
      checks: G.lady.checks.map((c) => ({ quest: c.quest, holder: c.holder, target: c.target, declared: c.declared, shown: over || c.holder === seat ? c.shown : undefined })),
    } : null,
    allegiance: G.allegiance ? { drawn: G.allegiance.drawn || null, dealt: G.allegiance.dealt || null, left: G.allegiance.deck ? G.allegiance.deck.length : null } : null,
    switches: G.switches,
    plot: G.plot ? { deck: G.plot.deck.length, hand: G.plot.hand } : null,
    me: me ? {
      role: me.role, side: me.side, knows: knowledge(G, seat),
      checks: G.checks.filter((c) => c.checker === seat).map((c) => ({ target: c.target, shown: c.shown, reason: c.reason, quest: c.quest })),
      looks: G.looks.filter((l) => l.by === seat),
      loyalty: mine && a.kind === 'loyalty' ? loyaltyOptions(me) : null,
      messages: me.messages,
    } : null,
    players: G.players.map((p) => ({
      seat: p.seat, name: p.name, bot: p.bot, connected: p.connected, botFor: !!p.botFor, resigned: !!p.resigned,
      role: over || p.seat === seat || p.revealed ? p.role : undefined,
      side: over ? p.side : undefined,
      revealed: p.revealed,
      plots: p.plots,
    })),
    checks: G.checks.filter((c) => c.reason !== 'cleric' || over || c.checker === seat).map((c) => ({ checker: c.checker, target: c.target, reason: c.reason, quest: c.quest })),
    recruit: G.recruit,
    assassination: G.assassination,
    winner: G.winner, partial: G.partial, why: G.why,
    log: G.log.slice(-40),
    fx: G.fx,
    revealBots: opts.revealBots ? G.players.filter((p) => p.bot && p.seat !== seat).map((p) => ({ seat: p.seat, role: p.role })) : null,
  };
}

// ---------------------------------------------------------------- bots
//
// A bot keeps every possible answer to "who is Evil now?" that fits what it
// knows for certain — its own Character's reveal, loyalty checks it made —
// and weighs each by how well it explains what the table has done: a Quest
// with f Fails needs at least f agents of Evil on it, agents of Evil tend to
// Fail, to approve Teams with Evil on them and to reject the fifth Team of a
// round, and a Good Lady of the Lake tells the truth. With a Trickster or a
// Troublemaker in the game, what a loyalty check showed is strong evidence
// rather than certain. A table of ten has at most 210 such answers, so the
// bot can weigh them all at every decision.

const PF = 0.8;          // how often an agent of Evil on a Quest plays Fail
const VOTE_WEIGHT = 0.5; // votes are a softer tell than Quest results

function combos(arr, k) {
  const out = [];
  const pick = (start, acc) => {
    if (acc.length === k) { out.push(acc.slice()); return; }
    for (let i = start; i <= arr.length - (k - acc.length); i++) { acc.push(arr[i]); pick(i + 1, acc); acc.pop(); }
  };
  pick(0, []);
  return out;
}

const binom = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; };
const liars = (G) => G.opts.trickster || G.opts.troublemaker;

// the side a mark says a player is on now
function markSide(G, mark) {
  const odd = G.switches % 2 === 1;
  switch (mark) {
    case 'evil': case 'assassin': return 'evil';
    case 'good': case 'merlin': case 'junior': return 'good';
    case 'lancelot-evil': return odd ? 'good' : 'evil';
    case 'lancelot-good': return odd ? 'evil' : 'good';
    case 'shown-evil': return liars(G) ? null : 'evil';
    case 'shown-good': return liars(G) ? null : 'good';
    default: return null;
  }
}

// The possible Evil sets now, weighted. `known` is what the bot treats as certain.
export function worlds(G, seat, known = knowledge(G, seat)) {
  const me = playerBySeat(G, seat);
  const E = SIDES[G.n][1];
  const evil = new Set();
  const good = new Set();
  if (me.side === 'evil') evil.add(seat); else good.add(seat);
  const pair = [];
  for (const [k, mark] of Object.entries(known)) {
    const s = Number(k);
    if (mark === 'merlin?') { pair.push(s); continue; }
    const side = markSide(G, mark);
    if (side === 'evil' && !good.has(s)) evil.add(s);
    else if (side === 'good' && !evil.has(s)) good.add(s);
  }
  // the Revealer is Evil for all to see
  for (const p of G.players) if (p.revealed && !good.has(p.seat)) evil.add(p.seat);
  const free = seats(G).filter((s) => !evil.has(s) && !good.has(s));
  const need = E - evil.size;
  const out = [];
  if (need < 0 || need > free.length) return [{ S: evil, w: 1 }];
  for (const extra of combos(free, need)) {
    const S = new Set([...evil, ...extra]);
    // with Morgana, exactly one of Percival's two is Evil
    if (pair.length === 2 && S.has(pair[0]) === S.has(pair[1])) continue;
    out.push({ S, w: weigh(G, seat, S, known) });
  }
  const total = out.reduce((t, x) => t + x.w, 0);
  if (total > 0) for (const x of out) x.w /= total;
  else for (const x of out) x.w = 1 / out.length;
  return out.length ? out : [{ S: evil, w: 1 }];
}

function weigh(G, seat, S, known) {
  let w = 1;
  for (const r of G.results) {
    const team = r.team.filter((s) => s !== r.trapped);
    const k = team.filter((s) => S.has(s)).length;
    // Magic and backup blur what the Fails say; count what was seen
    const f = Math.min(r.fails, team.length);
    if (r.magic === 0 && !r.backup && f > k) return 0;
    if (f <= k) w *= binom(k, f) * PF ** f * (1 - PF) ** (k - f);
    else w *= 0.05;
  }
  for (const pr of G.proposals) {
    const dirty = pr.team.some((s) => S.has(s));
    const hammer = pr.attempt === MAX_REJECTS;
    for (const [k, yes] of Object.entries(pr.votes)) {
      const v = Number(k);
      if (v === seat) continue;
      const p = S.has(v) ? (hammer ? 0.1 : dirty ? 0.85 : 0.3) : hammer ? 0.95 : 0.55;
      w *= (yes ? p : 1 - p) ** VOTE_WEIGHT;
    }
  }
  if (G.lady) {
    for (const c of G.lady.checks) {
      if (c.holder === seat || !c.declared) continue;
      const truth = S.has(c.target) ? 'evil' : 'good';
      const p = S.has(c.holder) ? 0.5 : 0.95;
      w *= c.declared === truth ? p : 1 - p;
    }
  }
  // what loyalty checks showed, when someone might have lied
  if (liars(G)) {
    for (const [k, mark] of Object.entries(known)) {
      if (mark !== 'shown-good' && mark !== 'shown-evil') continue;
      const truth = S.has(Number(k)) ? 'evil' : 'good';
      w *= (mark === 'shown-good') === (truth === 'good') ? 0.9 : 0.1;
    }
  }
  return w;
}

const pEvil = (W, s) => W.reduce((t, x) => t + (x.S.has(s) ? x.w : 0), 0);
const pClean = (W, team) => W.reduce((t, x) => t + (team.some((s) => x.S.has(s)) ? 0 : x.w), 0);
const rand = (a) => a[Math.floor(Math.random() * a.length)];

// Merlin plays with what he sees most of the time, and now and then as if he
// saw nothing — a Merlin who never puts a foot wrong is the Assassin's easiest pick.
function goodModel(G, seat) {
  const me = playerBySeat(G, seat);
  let known = knowledge(G, seat);
  if (me.role === 'merlin' && Math.random() < 0.3) {
    known = {};
    for (const c of G.checks) if (c.checker === seat) known[c.target] = c.shown === 'good' ? 'shown-good' : 'shown-evil';
  }
  return worlds(G, seat, known);
}

// the best Team a Good bot can see, with its chance of being clean
function bestTeam(G, seat, W) {
  const k = G.sizes[G.quest];
  const others = seats(G).filter((s) => s !== seat);
  let best = null;
  for (const c of combos(others, k - 1)) {
    const team = [seat, ...c];
    const score = pClean(W, team) + Math.random() * 1e-6;
    if (!best || score > best.score) best = { team, score };
  }
  return best;
}

// who an agent of Evil knows to be with them now
function evilKnown(G, seat) {
  const me = playerBySeat(G, seat);
  const out = new Set([seat]);
  if (me.side !== 'evil') return out;
  for (const [k, m] of Object.entries(knowledge(G, seat))) if (markSide(G, m) === 'evil' || m === 'shown-evil') out.add(Number(k));
  for (const p of G.players) if (p.revealed) out.add(p.seat);
  return out;
}

// how much the table has reason to trust a player, as anyone can see it:
// on Quests that succeeded, not on Quests that failed
function publicTrust(G, s) {
  let t = 0;
  for (const r of G.results) if (r.team.includes(s)) t += r.success ? 1 : -2;
  for (const p of G.players) if (p.revealed && p.seat === s) t -= 10;
  return t + Math.random() * 0.5;
}

// how a bot sees the others: the chance each is Evil now
function suspicion(G, seat) {
  const me = playerBySeat(G, seat);
  if (me.side === 'evil') {
    const mine = evilKnown(G, seat);
    return (s) => (mine.has(s) ? 1 : 0);
  }
  const W = goodModel(G, seat);
  return (s) => pEvil(W, s);
}

export function botChoose(G, seat) {
  const me = playerBySeat(G, seat);
  if (!me || G.phase === 'over') return null;
  if (G.ask) return G.ask.seat === seat ? botAsk(G, me, G.ask) : null;
  if (G.phase === 'vote') return waitingOn(G).includes(seat) ? { kind: 'vote', approve: botVote(G, me) } : null;
  if (G.phase === 'quest') return G.team.includes(seat) && !G.cards[seat] ? { kind: 'quest', card: botCard(G, me) } : null;
  return null;
}

function botAsk(G, me, a) {
  const seat = me.seat;
  const evil = me.side === 'evil';
  const sus = suspicion(G, seat);
  const others = seats(G).filter((s) => s !== seat);
  const leastSus = (list) => list.slice().sort((x, y) => sus(x) - sus(y) || Math.random() - 0.5)[0];
  const mostSus = (list) => list.slice().sort((x, y) => sus(y) - sus(x) || Math.random() - 0.5)[0];
  switch (a.kind) {
    case 'propose': {
      let team;
      if (!evil) team = bestTeam(G, seat, goodModel(G, seat)).team;
      else {
        // an agent of Evil leads with itself and the players the table trusts most
        const mine = evilKnown(G, seat);
        const k = G.sizes[G.quest];
        const rest = others.filter((s) => !mine.has(s)).sort((x, y) => publicTrust(G, y) - publicTrust(G, x));
        team = [seat, ...rest.slice(0, k - 1)];
      }
      const move = { kind: 'propose', team };
      if (G.opts.excalibur) {
        const cands = team.filter((s) => s !== seat);
        move.excalibur = evil ? (cands.find((s) => evilKnown(G, seat).has(s)) ?? rand(cands)) : leastSus(cands);
      }
      return move;
    }
    case 'lead': {
      const l = leaderSeat(G);
      return { kind: 'lead', use: evil ? !evilKnown(G, seat).has(l) && Math.random() < 0.7 : sus(l) > 0.45 };
    }
    case 'give': {
      const c = G.plot.hand[0];
      const mine = evilKnown(G, seat);
      const friends = others.filter((s) => (evil ? mine.has(s) : sus(s) < 0.35));
      return { kind: 'give', card: c.id, to: friends.length ? rand(friends) : leastSus(others) };
    }
    case 'adjacent': {
      const i = G.players.indexOf(me);
      const near = [G.players[(i + 1) % G.n].seat, G.players[(i + G.n - 1) % G.n].seat];
      const known = knowledge(G, seat);
      const unknown = near.filter((s) => !known[s]);
      return { kind: 'adjacent', target: rand(unknown.length ? unknown : near) };
    }
    case 'showto': {
      // a Good player shows the one they trust; an agent of Evil, a fellow agent
      const mine = evilKnown(G, seat);
      const pool = evil ? others.filter((s) => mine.has(s)) : [];
      return { kind: 'showto', target: pool.length ? rand(pool) : leastSus(others) };
    }
    case 'take': {
      const rank = { king: 5, lead: 4, ambush: 3, spot: 2, charge: 0 };
      let best = null;
      for (const q of G.players) {
        if (q.seat === seat) continue;
        for (const c of q.plots) {
          const score = (rank[c.type] ?? 1) + (evil ? (evilKnown(G, seat).has(q.seat) ? -3 : 1) : sus(q.seat) * 2) + Math.random() * 0.1;
          if (!best || score > best.score) best = { from: q.seat, card: c.id, score };
        }
      }
      return { kind: 'take', from: best.from, card: best.card };
    }
    case 'loyalty': {
      const ops = loyaltyOptions(me);
      return { kind: 'loyalty', card: ops.includes('good') && me.role === 'trickster' ? 'good' : ops[0] };
    }
    case 'king': {
      const hammer = G.rejects === MAX_REJECTS - 1;
      if (evil) return { kind: 'king', use: hammer || (!G.team.some((s) => evilKnown(G, seat).has(s)) && Math.random() < 0.6) };
      if (hammer) return { kind: 'king', use: false };
      return { kind: 'king', use: pClean(goodModel(G, seat), G.team) < 0.3 };
    }
    case 'watch': {
      // the Watch token keeps a Rogue from playing their own card: a Leader
      // who is not a Rogue gives it to whoever has been on every Quest that
      // showed a Rogue token — and failing that, to whom it trusts least
      const cands = G.team.filter((s) => s !== seat);
      if (!cands.length) return { kind: 'watch', target: seat };
      const marked = G.results.filter((r) => r.rogue.success || r.rogue.fail);
      const rogueish = cands.filter((s) => marked.length && marked.every((r) => r.team.includes(s)));
      if (rogueish.length && me.role !== 'rogueGood' && me.role !== 'rogueEvil') return { kind: 'watch', target: rand(rogueish) };
      return { kind: 'watch', target: evil ? rand(cands) : mostSus(cands) };
    }
    case 'spot': {
      const cands = G.team.filter((s) => s !== seat && !G.faceUp.includes(s));
      if (!cands.length || evil) return { kind: 'spot', target: null };
      const t = mostSus(cands);
      return { kind: 'spot', target: sus(t) > 0.4 ? t : null };
    }
    case 'excalibur': {
      const cands = G.team.filter((s) => s !== seat && !G.faceUp.includes(s));
      if (evil) {
        const mine = evilKnown(G, seat);
        const partner = G.team.some((s) => s !== seat && mine.has(s));
        const goods = cands.filter((s) => !mine.has(s));
        return { kind: 'excalibur', target: !partner && goods.length && Math.random() < 0.8 ? rand(goods) : null };
      }
      const t = mostSus(cands);
      return { kind: 'excalibur', target: t != null && sus(t) > 0.65 ? t : null };
    }
    case 'ambush': {
      const cands = G.team.filter((s) => s !== seat && !ambushed(G, s));
      if (!cands.length) return { kind: 'ambush', target: null };
      return { kind: 'ambush', target: evil ? rand(cands) : mostSus(cands) };
    }
    case 'trap': {
      if (evil) {
        const mine = evilKnown(G, seat);
        const goods = G.team.filter((s) => !mine.has(s));
        return { kind: 'trap', target: rand(goods.length ? goods : G.team) };
      }
      return { kind: 'trap', target: mostSus(G.team.filter((s) => s !== seat).length ? G.team.filter((s) => s !== seat) : G.team) };
    }
    case 'lady': {
      const targets = ladyTargets(G);
      if (evil) {
        const mine = evilKnown(G, seat);
        const goods = targets.filter((s) => !mine.has(s));
        return { kind: 'lady', target: rand(goods.length ? goods : targets) };
      }
      // a Good bot looks where it is least sure
      const W = worlds(G, seat);
      let best = null;
      for (const s of targets) {
        const u = Math.abs(pEvil(W, s) - 0.5) + Math.random() * 1e-6;
        if (!best || u < best.u) best = { s, u };
      }
      return { kind: 'lady', target: best.s };
    }
    case 'declare': {
      const shown = G.check ? G.check.shown : null;
      if (!evil) return { kind: 'declare', says: shown };
      // an agent of Evil covers for its own and now and then slanders the Good
      if (evilKnown(G, seat).has(a.target)) return { kind: 'declare', says: 'good' };
      return { kind: 'declare', says: Math.random() < 0.4 ? 'evil' : shown };
    }
    case 'recruit': {
      const mine = evilKnown(G, seat);
      return { kind: 'recruit', target: rand(others.filter((s) => !mine.has(s))) };
    }
    case 'assassinate':
      return { kind: 'assassinate', target: merlinGuess(G, seat) };
    default:
      return null;
  }
}

function botVote(G, me) {
  const seat = me.seat;
  const hammer = G.rejects === MAX_REJECTS - 1;
  if (me.side === 'evil') {
    // a fifth rejection hands Evil the game
    if (hammer) return false;
    const dirty = G.team.some((s) => evilKnown(G, seat).has(s));
    return Math.random() < (dirty ? 0.9 : 0.2);
  }
  if (hammer) return true;
  // a Good bot approves a Team nearly as clean as the best it could pick
  const W = goodModel(G, seat);
  const p = pClean(W, G.team);
  const best = bestTeam(G, seat, W).score;
  const bar = (G.rejects >= 3 ? 0.5 : 0.75) - (G.team.includes(seat) ? 0.05 : 0);
  return p >= best * bar - 1e-9;
}

function botCard(G, me) {
  const ok = allowedCards(G, me);
  if (ok.length === 1) return ok[0];
  if (me.side === 'good') {
    if (ok.includes('rogueSuccess')) return 'rogueSuccess';
    if (ok.includes('goodMessage') && Math.random() < 0.7) return 'goodMessage';
    if (ok.includes('magic')) {
      // a Good Sorcerer turns a Quest round when it expects a Fail on it
      const W = goodModel(G, me.seat);
      return pClean(W, G.team.filter((s) => s !== me.seat)) < 0.3 ? 'magic' : 'success';
    }
    return 'success';
  }
  const want = evilCard(G, me.seat);
  if (me.role === 'sorcererEvil') {
    // no Fail for the Evil Sorcerer: Magic turns a clean Quest into a failure,
    // but would undo a partner's Fail
    const partner = G.team.some((s) => s !== me.seat && evilKnown(G, me.seat).has(s));
    return want === 'fail' && !partner ? 'magic' : 'success';
  }
  if (want === 'fail' && ok.includes('rogueFail')) return 'rogueFail';
  if (want === 'fail' && ok.includes('evilMessage') && Math.random() < 0.7) return 'evilMessage';
  return ok.includes(want) ? want : ok[0];
}

// An agent of Evil on a Quest. Two Fails from one Team give two agents away,
// so when several know each other only the first of them Fails; on the
// fourth Quest at seven or more a lone Fail does nothing but tell, so it
// plays Success unless a partner is there to make two.
function evilCard(G, seat) {
  const me = playerBySeat(G, seat);
  const won = G.results.filter((r) => r.success).length;
  const lost = G.results.length - won;
  const needed = failsNeeded(G.n, G.quest);
  if (me.role === 'oberon' || me.role === 'rogueEvil') return Math.random() < 0.85 ? 'fail' : 'success';
  const mine = G.team.filter((s) => evilKnown(G, seat).has(s)).sort((a, b) => a - b);
  if (won === 2 || lost === 2) return mine.indexOf(seat) < needed ? 'fail' : 'success';
  if (needed === 2) return mine.length >= 2 && mine.indexOf(seat) < 2 ? 'fail' : 'success';
  if (mine.indexOf(seat) > 0) return 'success';
  // on a first Quest of two, a Fail names you to your teammate — sometimes lie low
  if (G.quest === 0 && G.team.length === 2) return Math.random() < 0.5 ? 'fail' : 'success';
  return 'fail';
}

// The Assassin reads the table for the Good player whose votes and Teams kept
// clear of the agents of Evil best.
function merlinGuess(G, seat) {
  const mine = evilKnown(G, seat);
  for (const [k, m] of Object.entries(knowledge(G, seat))) if (m === 'assassin') mine.add(Number(k));
  const cands = seats(G).filter((s) => !mine.has(s));
  let best = null;
  for (const c of cands) {
    let score = Math.random() * 0.75;
    for (const pr of G.proposals) {
      const dirty = pr.team.some((s) => mine.has(s));
      const yes = pr.votes[c];
      if (pr.attempt === MAX_REJECTS) continue;
      if (dirty) score += yes ? -2 : 2;
      else score += yes ? 0.5 : -0.5;
      if (pr.leader === c) score += dirty ? -2 : 1.5;
    }
    if (!best || score > best.score) best = { c, score };
  }
  return best.c;
}
