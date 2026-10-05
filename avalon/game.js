// game.js — the rules of The Resistance: Avalon. No DOM, no network: the
// host holds the only copy of the state and every move goes through
// applyMove, which is what makes it testable.
//
// Five to ten players are dealt secret Characters, Good or Evil. Each round
// the Leader proposes a Team for the next Quest, everyone votes on it in the
// open, and an approved Team secretly plays Success or Fail: one Fail and the
// Quest fails (two, on the fourth Quest at a table of seven or more). Three
// successful Quests and Good has one more hurdle: the Assassin names Merlin,
// and if that is right, Evil wins after all. Three failed Quests, or five
// Teams rejected in a single round, and Evil wins outright.
//
// The rules and both charts are the publisher's rulebook (Indie Boards &
// Cards): its Set Up chart for the sides, its Team Building chart for the
// Quests, and its reveal scripts for who sees whom.

export const PROTO = 1;
export const MIN_PLAYERS = 5;
export const MAX_PLAYERS = 10;
export const QUESTS = 5;
export const MAX_REJECTS = 5;

// "Use the chart below to determine the number of Good and Evil players."
export const SIDES = { 5: [3, 2], 6: [4, 2], 7: [4, 3], 8: [5, 3], 9: [6, 3], 10: [6, 4] };

// "the Leader takes the required number of Team Tokens (using the following
// chart, or numbers on the tableau)"
export const TEAM_SIZES = {
  5: [2, 3, 2, 3, 3],
  6: [2, 3, 4, 3, 4],
  7: [2, 3, 3, 4, 4],
  8: [3, 4, 4, 5, 5],
  9: [3, 4, 4, 5, 5],
  10: [3, 4, 4, 5, 5],
};

// "The 4th Quest (and only the 4th Quest) in games of 7 or more players
// requires at least two Quest Fail cards to be a failed Quest."
export const failsNeeded = (n, quest) => (n >= 7 && quest === 3 ? 2 : 1);

// The Character cards. Merlin and the Assassin are in every game ("Merlin and
// the Assassin are included in all games and the remaining special character
// cards are optional"); the rest of each side are Loyal Servants of Arthur
// and Minions of Mordred.
export const ROLES = {
  merlin: { name: 'Merlin', side: 'good', power: 'You see the agents of Evil — all but Mordred. Speak only in riddles: if the Assassin finds you at the end, Evil wins.' },
  percival: { name: 'Percival', side: 'good', power: 'You know Merlin. With Morgana at the table you see two players, and only one of them is Merlin.' },
  servant: { name: 'Loyal Servant of Arthur', side: 'good', power: 'You know nothing but your own loyalty. Find the agents of Evil from what the table does.' },
  assassin: { name: 'Assassin', side: 'evil', power: 'You know your fellow agents of Evil. If three Quests succeed, you name one Good player as Merlin — name the right one and Evil wins.' },
  morgana: { name: 'Morgana', side: 'evil', power: 'You know your fellow agents of Evil, and you appear to Percival as Merlin.' },
  mordred: { name: 'Mordred', side: 'evil', power: 'You know your fellow agents of Evil, and Merlin does not see you.' },
  oberon: { name: 'Oberon', side: 'evil', power: 'You serve Evil alone: you do not know the other agents of Evil, and they do not know you. Merlin still sees you.' },
  minion: { name: 'Minion of Mordred', side: 'evil', power: 'You know your fellow agents of Evil.' },
};
export const OPTIONAL = ['percival', 'morgana', 'mordred', 'oberon'];
export const sideOf = (role) => ROLES[role].side;

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
  if (G.log.length > 80) G.log.shift();
}

function bump(G, fx) {
  G.fxSeq = (G.fxSeq || 0) + 1;
  G.fx = { seq: G.fxSeq, ...fx };
}

const nameOf = (G, seat) => (playerBySeat(G, seat) || { name: '?' }).name;
const names = (G, seats) => seats.map((s) => nameOf(G, s)).join(', ');

// ---------------------------------------------------------------- options

// What the lobby can set: which optional Characters join Merlin and the
// Assassin, and whether the Lady of the Lake is in play.
export function defaultOpts() {
  return { percival: false, morgana: false, mordred: false, oberon: false, lady: false };
}

export function checkOpts(opts) {
  if (!opts || typeof opts !== 'object') return 'No options.';
  for (const k of [...OPTIONAL, 'lady']) if (opts[k] !== undefined && typeof opts[k] !== 'boolean') return `${k} is on or off.`;
  return null;
}

// The Characters dealt at a table of n: the specials first, the rest of each
// side plain Servants and Minions.
export function castFor(n, opts) {
  const [good, evil] = SIDES[n];
  const g = ['merlin', ...(opts.percival ? ['percival'] : [])];
  const e = ['assassin', ...['morgana', 'mordred', 'oberon'].filter((k) => opts[k])];
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
  const e = 1 + ['morgana', 'mordred', 'oberon'].filter((k) => opts[k]).length;
  if (e > evil) return `A table of ${n} has only ${evil} agents of Evil — the Assassin and ${e - 1} more is too many.`;
  if (1 + (opts.percival ? 1 : 0) > good) return `A table of ${n} has too few Good players for that.`;
  return null;
}

// The rulebook's advice on the optional rules, for the lobby to pass on.
export function advice(n, opts) {
  const out = [];
  if (opts.percival && n === 5 && !opts.morgana && !opts.mordred) out.push('For games of 5, the rulebook says to add Mordred or Morgana when playing with Percival.');
  if (opts.morgana && !opts.percival) out.push('Morgana only fools Percival — without him at the table she plays as a plain Minion.');
  if (opts.lady && n < 7) out.push('The rulebook says the Lady of the Lake is best saved for games of 7 or more.');
  return out;
}

// ---------------------------------------------------------------- setup

export function newGame(roster, opts = defaultOpts()) {
  const n = roster.length;
  const why = canStart(n, opts);
  if (why) throw new Error(why);
  const roles = shuffle(castFor(n, opts));
  const G = {
    mid: Math.random().toString(36).slice(2, 10),
    phase: 'team',
    n,
    opts: clone(opts),
    sizes: TEAM_SIZES[n].slice(),
    players: roster.map((r, i) => ({
      seat: r.seat,
      name: r.name,
      bot: !!r.bot,
      connected: r.bot ? true : r.connected !== false,
      role: roles[i],
    })),
    quest: 0,          // the Quest being decided, 0-4
    results: [],       // { quest, team, fails, needed, success }
    rejects: 0,        // the Vote Track: Teams rejected this round
    // "Randomly select a Leader"
    leader: Math.floor(Math.random() * n),
    team: null,        // the proposed Team, while it is voted on and on its Quest
    votes: {},         // seat -> approve, hidden until everyone has voted
    cards: {},         // seat -> 'success' | 'fail', never shown
    proposals: [],     // every Team put to the vote, with the votes once revealed
    lady: null,
    check: null,       // the Lady of the Lake's look, before it is passed on
    assassination: null,
    winner: null,
    why: '',
    log: [],
  };
  // "At the beginning of the game, give the Lady of the Lake token to the
  // player on the Leader's right" — the player who would lead last
  if (G.opts.lady) {
    const holder = G.players[(G.leader + n - 1) % n].seat;
    G.lady = { holder, held: [holder], checks: [] };
  }
  const [good, evil] = SIDES[n];
  note(G, `${n} players: ${good} Loyal Servants of Arthur and ${evil} Minions of Mordred.`);
  note(G, `${leaderName(G)} is the first Leader.`);
  bump(G, { kind: 'start' });
  return G;
}

const leaderSeat = (G) => G.players[G.leader].seat;
const leaderName = (G) => G.players[G.leader].name;
const nextLeader = (G) => { G.leader = (G.leader + 1) % G.n; };

// ---------------------------------------------------------------- knowledge

// What a player knows from the reveal at the start, and from the Lady of the
// Lake. The scripts: "Minions of Mordred, not Oberon — open your eyes and look
// around so that you know all agents of Evil"; "Minions of Mordred, not
// Mordred himself — extend your thumb so that Merlin will know of you";
// "Merlin & Morgana — extend your thumb so that Percival may know of you".
// Marks: 'evil', 'good', 'merlin' (Percival without Morgana) and 'merlin?'
// (Percival with Morgana: one of the two is Merlin).
export function knowledge(G, seat) {
  const me = playerBySeat(G, seat);
  const out = {};
  if (!me) return out;
  const mine = me.role;
  for (const p of G.players) {
    if (p.seat === seat) continue;
    const r = p.role;
    if (sideOf(mine) === 'evil' && mine !== 'oberon' && sideOf(r) === 'evil' && r !== 'oberon') out[p.seat] = 'evil';
    if (mine === 'merlin' && sideOf(r) === 'evil' && r !== 'mordred') out[p.seat] = 'evil';
    if (mine === 'percival' && (r === 'merlin' || r === 'morgana')) out[p.seat] = G.opts.morgana ? 'merlin?' : 'merlin';
  }
  // the Lady shows a loyalty for certain, whatever the reveal suggested
  if (G.lady) for (const c of G.lady.checks) if (c.holder === seat) out[c.target] = c.loyalty;
  if (G.check && G.check.holder === seat) out[G.check.target] = G.check.loyalty;
  return out;
}

// ---------------------------------------------------------------- moves

export function applyMove(G, seat, move) {
  const p = playerBySeat(G, seat);
  if (!p) return { ok: false, error: 'No such player.' };
  if (!move || typeof move !== 'object') return { ok: false, error: 'No move.' };
  if (G.phase === 'over') return { ok: false, error: 'The game is over.' };
  switch (move.kind) {
    case 'propose': return propose(G, p, move.team);
    case 'vote': return vote(G, p, move.approve);
    case 'quest': return questCard(G, p, move.card);
    case 'lady': return ladyLook(G, p, move.target);
    case 'declare': return ladyDeclare(G, p, move.says);
    case 'assassinate': return assassinate(G, p, move.target);
    default: return { ok: false, error: 'Unknown move.' };
  }
}

// Team Building: "the Leader takes the required number of Team Tokens ... and
// assigns each Team Token to any player. The Leader can be on the Team, but is
// not required to be so. Note a player may only be assigned one Team Token."
function propose(G, p, team) {
  if (G.phase !== 'team') return { ok: false, error: 'It is not time to propose a Team.' };
  if (p.seat !== leaderSeat(G)) return { ok: false, error: 'Only the Leader proposes the Team.' };
  const k = G.sizes[G.quest];
  if (!Array.isArray(team) || team.length !== k) return { ok: false, error: `This Quest needs a Team of ${k}.` };
  if (new Set(team).size !== k || team.some((s) => !playerBySeat(G, s))) return { ok: false, error: 'Pick different players at the table.' };
  G.team = G.players.map((q) => q.seat).filter((s) => team.includes(s)); // table order
  G.votes = {};
  G.phase = 'vote';
  note(G, `${p.name} proposes ${names(G, G.team)} for Quest ${G.quest + 1}.`);
  bump(G, { kind: 'team', leader: p.seat, team: G.team.slice() });
  return { ok: true };
}

// The Team Vote: "Each player, including the Leader, secretly selects one Vote
// card ... All Vote tokens are flipped over so everyone can see how you voted.
// The Team is approved if the majority accepts ... (a tied Vote is also
// rejection)". "Evil wins the game if five Teams are rejected in a single round."
function vote(G, p, approve) {
  if (G.phase !== 'vote') return { ok: false, error: 'There is no Team to vote on.' };
  if (typeof approve !== 'boolean') return { ok: false, error: 'Approve or reject.' };
  if (G.votes[p.seat] !== undefined) return { ok: false, error: 'You have already voted.' };
  G.votes[p.seat] = approve;
  if (G.players.every((q) => G.votes[q.seat] !== undefined)) resolveVote(G);
  return { ok: true };
}

function resolveVote(G) {
  const yes = G.players.filter((q) => G.votes[q.seat]).length;
  const no = G.n - yes;
  const approved = yes > no;
  G.proposals.push({ quest: G.quest, attempt: G.rejects + 1, leader: leaderSeat(G), team: G.team.slice(), votes: { ...G.votes }, approved });
  if (approved) {
    G.phase = 'quest';
    G.cards = {};
    note(G, `The Team is approved, ${yes}–${no}. ${names(G, G.team)} go on Quest ${G.quest + 1}.`);
    bump(G, { kind: 'vote', approved, yes, no });
    return;
  }
  G.rejects++;
  if (G.rejects >= MAX_REJECTS) {
    note(G, `The Team is rejected, ${yes}–${no} — the fifth rejection this round.`);
    bump(G, { kind: 'vote', approved, yes, no });
    endGame(G, 'evil', 'five Teams were rejected in a single round');
    return;
  }
  note(G, `The Team is rejected, ${yes}–${no}. The Vote Track moves to ${G.rejects}.`);
  nextLeader(G);
  G.team = null;
  G.phase = 'team';
  bump(G, { kind: 'vote', approved, yes, no, rejects: G.rejects });
}

// The Quest: "The Good players must select the Quest Success card; Evil may
// select either ... The Quest is completed successfully only if all the cards
// revealed are Success cards." Only the count of Fails is ever shown.
function questCard(G, p, card) {
  if (G.phase !== 'quest') return { ok: false, error: 'No Quest is under way.' };
  if (!G.team.includes(p.seat)) return { ok: false, error: 'You are not on this Quest.' };
  if (G.cards[p.seat]) return { ok: false, error: 'You have already played your Quest card.' };
  if (card !== 'success' && card !== 'fail') return { ok: false, error: 'Play Success or Fail.' };
  if (card === 'fail' && sideOf(p.role) === 'good') return { ok: false, error: 'Loyal Servants of Arthur must play Success.' };
  G.cards[p.seat] = card;
  if (G.team.every((s) => G.cards[s])) resolveQuest(G);
  return { ok: true };
}

function resolveQuest(G) {
  const q = G.quest;
  const fails = G.team.filter((s) => G.cards[s] === 'fail').length;
  const needed = failsNeeded(G.n, q);
  const success = fails < needed;
  G.results.push({ quest: q, team: G.team.slice(), fails, needed, success });
  note(G, `Quest ${q + 1} ${success ? 'succeeds' : 'fails'} — ${fails ? `${fails} Fail card${fails === 1 ? '' : 's'}` : 'all Success'}${!success || needed === 1 || !fails ? '' : `, but it needed ${needed}`}.`);
  bump(G, { kind: 'quest', quest: q, success, fails, needed });
  G.cards = {};
  G.team = null;
  // "After the Quest has been completed ... The Leader passes clockwise and
  // the next Round begins in Team building phase."
  G.rejects = 0;
  nextLeader(G);
  const won = G.results.filter((r) => r.success).length;
  const lost = G.results.length - won;
  if (lost >= 3) return endGame(G, 'evil', 'three Quests failed');
  if (won >= 3) {
    G.phase = 'assassin';
    note(G, 'Three Quests have succeeded. Evil has one last chance: the Assassin names Merlin.');
    bump(G, { kind: 'assassin' });
    return;
  }
  G.quest++;
  // "Immediately after the 2nd, 3rd, and 4th Quest is resolved, the player
  // with the Lady of the Lake token will choose one player to examine."
  if (G.lady && q >= 1 && q <= 3) {
    G.phase = 'lady';
    G.check = null;
    return;
  }
  G.phase = 'team';
}

// The Lady of the Lake: "A player that used the Lady of the Lake cannot have
// the Lady used on them." The holder sees the loyalty in private, may say
// what they like about it ("The Lady of the Lake may discuss, but cannot
// reveal the Loyalty card passed"), and the token passes to that player.
export const ladyTargets = (G) => (G.lady ? G.players.map((q) => q.seat).filter((s) => !G.lady.held.includes(s)) : []);

function ladyLook(G, p, target) {
  if (G.phase !== 'lady' || G.check) return { ok: false, error: 'The Lady of the Lake is not called for now.' };
  if (p.seat !== G.lady.holder) return { ok: false, error: 'Only the Lady of the Lake examines.' };
  if (!ladyTargets(G).includes(target)) return { ok: false, error: 'Pick a player who has not held the Lady of the Lake.' };
  const t = playerBySeat(G, target);
  G.check = { quest: G.quest - 1, holder: p.seat, target, loyalty: sideOf(t.role), declared: null };
  note(G, `${p.name}, the Lady of the Lake, examines ${t.name}'s loyalty.`);
  bump(G, { kind: 'lady', holder: p.seat, target });
  return { ok: true };
}

function ladyDeclare(G, p, says) {
  if (G.phase !== 'lady' || !G.check) return { ok: false, error: 'There is nothing to declare.' };
  if (p.seat !== G.check.holder) return { ok: false, error: 'Only the Lady of the Lake declares.' };
  if (says !== 'good' && says !== 'evil' && says !== null) return { ok: false, error: 'Declare Good, Evil, or nothing.' };
  const c = { ...G.check, declared: says };
  G.lady.checks.push(c);
  G.lady.holder = c.target;
  G.lady.held.push(c.target);
  G.check = null;
  const t = nameOf(G, c.target);
  note(G, says ? `${p.name} declares that ${t} is ${says === 'good' ? 'a Loyal Servant of Arthur' : 'a Minion of Mordred'}.` : `${p.name} keeps what the Lady showed to themselves.`);
  note(G, `${t} now holds the Lady of the Lake.`);
  bump(G, { kind: 'declare', holder: p.seat, target: c.target, says });
  G.phase = 'team';
  return { ok: true };
}

// "Without revealing any Character cards, the Evil players discuss and the
// player with the Assassin character card will name one Good player as
// Merlin. If the named player is Merlin, then Evil players win."
export const assassinSeat = (G) => (G.players.find((q) => q.role === 'assassin') || {}).seat;

function assassinate(G, p, target) {
  if (G.phase !== 'assassin') return { ok: false, error: 'It is not time to name Merlin.' };
  if (p.role !== 'assassin') return { ok: false, error: 'Only the Assassin names Merlin.' };
  const t = playerBySeat(G, target);
  if (!t || t.seat === p.seat) return { ok: false, error: 'Name another player.' };
  if (sideOf(t.role) === 'evil' && t.role !== 'oberon') return { ok: false, error: 'Name a Good player — that one is an agent of Evil.' };
  G.assassination = { by: p.seat, target, hit: t.role === 'merlin' };
  note(G, `The Assassin, ${p.name}, names ${t.name} as Merlin.`);
  if (t.role === 'merlin') endGame(G, 'evil', `the Assassin found Merlin: ${t.name}`);
  else endGame(G, 'good', `three Quests succeeded and Merlin stayed hidden — ${t.name} was not Merlin`);
  return { ok: true };
}

function endGame(G, winner, why) {
  G.phase = 'over';
  G.winner = winner;
  G.why = why;
  note(G, `${winner === 'good' ? 'Good' : 'Evil'} wins — ${why}.`);
  bump(G, { kind: 'over', winner });
}

// who the table is waiting on
export function waitingOn(G) {
  switch (G.phase) {
    case 'team': return [leaderSeat(G)];
    case 'vote': return G.players.map((q) => q.seat).filter((s) => G.votes[s] === undefined);
    case 'quest': return G.team.filter((s) => !G.cards[s]);
    case 'lady': return [G.check ? G.check.holder : G.lady.holder];
    case 'assassin': return [assassinSeat(G)];
    default: return [];
  }
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
// marks your Character's reveal and the Lady give you, are all you get —
// until the game ends. Votes stay face down until the last one is in; Quest
// cards are never shown, only how many Fails were played.
export function viewFor(G, seat, code, opts = {}) {
  const me = playerBySeat(G, seat);
  const over = G.phase === 'over';
  const check = G.check ? { holder: G.check.holder, target: G.check.target, loyalty: G.check.holder === seat ? G.check.loyalty : undefined } : null;
  return {
    code, mid: G.mid, you: seat,
    phase: G.phase, n: G.n, opts: G.opts,
    sides: SIDES[G.n], sizes: G.sizes, twoFail: G.n >= 7 ? 3 : null,
    quest: G.quest, results: G.results, rejects: G.rejects,
    leader: leaderSeat(G),
    team: G.team,
    voted: G.phase === 'vote' ? G.players.map((q) => q.seat).filter((s) => G.votes[s] !== undefined) : [],
    myVote: G.phase === 'vote' && me ? G.votes[seat] : undefined,
    played: G.phase === 'quest' ? G.team.filter((s) => G.cards[s]) : [],
    myCard: G.phase === 'quest' && me ? G.cards[seat] || null : null,
    proposals: G.proposals,
    lady: G.lady ? {
      holder: G.lady.holder, held: G.lady.held,
      checks: G.lady.checks.map((c) => ({ quest: c.quest, holder: c.holder, target: c.target, declared: c.declared, loyalty: over || c.holder === seat ? c.loyalty : undefined })),
    } : null,
    check,
    me: me ? { role: me.role, side: sideOf(me.role), knows: knowledge(G, seat) } : null,
    players: G.players.map((p) => ({
      seat: p.seat, name: p.name, bot: p.bot, connected: p.connected, botFor: !!p.botFor, resigned: !!p.resigned,
      role: over || p.seat === seat ? p.role : undefined,
    })),
    // the Assassin shows their hand by naming Merlin
    assassin: G.phase === 'assassin' || over ? assassinSeat(G) : null,
    assassination: G.assassination,
    winner: G.winner, why: G.why,
    log: G.log.slice(-40),
    fx: G.fx,
    revealBots: opts.revealBots ? G.players.filter((p) => p.bot && p.seat !== seat).map((p) => ({ seat: p.seat, role: p.role })) : null,
  };
}

// ---------------------------------------------------------------- bots
//
// A bot keeps every possible answer to "who is Evil?" that fits what it knows
// for certain — its own Character's reveal, the Lady's looks — and weighs each
// by how well it explains what the table has done: a Quest with f Fails needs
// at least f agents of Evil on it, agents of Evil tend to Fail, to approve
// Teams with Evil on them and to reject the fifth Team of a round, and a Lady
// of the Lake tells the truth if Good. A table of ten has at most 126 such
// answers, so the bot can weigh them all at every decision.

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

// The possible Evil sets, weighted. `known` is what the bot treats as certain.
export function worlds(G, seat, known = knowledge(G, seat)) {
  const me = playerBySeat(G, seat);
  const E = SIDES[G.n][1];
  const evil = new Set();
  const good = new Set();
  if (sideOf(me.role) === 'evil') evil.add(seat); else good.add(seat);
  const pair = [];
  for (const [k, mark] of Object.entries(known)) {
    const s = Number(k);
    if (mark === 'evil') evil.add(s);
    else if (mark === 'good' || mark === 'merlin') good.add(s);
    else if (mark === 'merlin?') pair.push(s);
  }
  const free = G.players.map((p) => p.seat).filter((s) => !evil.has(s) && !good.has(s));
  const need = E - evil.size;
  const out = [];
  if (need < 0) return out;
  for (const extra of combos(free, need)) {
    const S = new Set([...evil, ...extra]);
    // with Morgana, exactly one of Percival's two is Evil
    if (pair.length === 2 && S.has(pair[0]) === S.has(pair[1])) continue;
    out.push({ S, w: weigh(G, seat, S) });
  }
  const total = out.reduce((t, x) => t + x.w, 0);
  if (total > 0) for (const x of out) x.w /= total;
  else for (const x of out) x.w = 1 / out.length;
  return out;
}

function weigh(G, seat, S) {
  let w = 1;
  for (const r of G.results) {
    const k = r.team.filter((s) => S.has(s)).length;
    if (r.fails > k) return 0;
    w *= binom(k, r.fails) * PF ** r.fails * (1 - PF) ** (k - r.fails);
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
  return w;
}

const pEvil = (W, s) => W.reduce((t, x) => t + (x.S.has(s) ? x.w : 0), 0);
const pClean = (W, team) => W.reduce((t, x) => t + (team.some((s) => x.S.has(s)) ? 0 : x.w), 0);

// Merlin plays with what he sees most of the time, and now and then as if he
// saw nothing — a Merlin who never puts a foot wrong is the Assassin's easiest pick.
function goodModel(G, seat) {
  const me = playerBySeat(G, seat);
  let known = knowledge(G, seat);
  if (me.role === 'merlin' && Math.random() < 0.3) {
    known = {};
    if (G.lady) for (const c of G.lady.checks) if (c.holder === seat) known[c.target] = c.loyalty;
  }
  return worlds(G, seat, known);
}

// the best Team a Good bot can see, with its chance of being clean
function bestTeam(G, seat, W) {
  const k = G.sizes[G.quest];
  const others = G.players.map((p) => p.seat).filter((s) => s !== seat);
  let best = null;
  for (const c of combos(others, k - 1)) {
    const team = [seat, ...c];
    const score = pClean(W, team) + Math.random() * 1e-6;
    if (!best || score > best.score) best = { team, score };
  }
  return best;
}

const evilKnown = (G, seat) => {
  const known = knowledge(G, seat);
  const me = playerBySeat(G, seat);
  const out = new Set([seat]);
  if (me.role !== 'oberon') for (const [k, m] of Object.entries(known)) if (m === 'evil') out.add(Number(k));
  return out;
};

// how much the table has reason to trust a player, as anyone can see it:
// on Quests that succeeded, not on Quests that failed
function publicTrust(G, s) {
  let t = 0;
  for (const r of G.results) if (r.team.includes(s)) t += r.success ? 1 : -2;
  return t + Math.random() * 0.5;
}

export function botChoose(G, seat) {
  const me = playerBySeat(G, seat);
  if (!me) return null;
  const evil = sideOf(me.role) === 'evil';
  switch (G.phase) {
    case 'team': {
      if (seat !== leaderSeat(G)) return null;
      if (!evil) return { kind: 'propose', team: bestTeam(G, seat, goodModel(G, seat)).team };
      // an agent of Evil leads with itself and the players the table trusts most
      const mine = evilKnown(G, seat);
      const k = G.sizes[G.quest];
      const others = G.players.map((p) => p.seat).filter((s) => !mine.has(s)).sort((a, b) => publicTrust(G, b) - publicTrust(G, a));
      return { kind: 'propose', team: [seat, ...others.slice(0, k - 1)] };
    }
    case 'vote': {
      if (G.votes[seat] !== undefined) return null;
      const hammer = G.rejects === MAX_REJECTS - 1;
      if (evil) {
        // a fifth rejection hands Evil the game
        if (hammer) return { kind: 'vote', approve: false };
        const dirty = G.team.some((s) => evilKnown(G, seat).has(s));
        return { kind: 'vote', approve: Math.random() < (dirty ? 0.9 : 0.2) };
      }
      if (hammer) return { kind: 'vote', approve: true };
      // a Good bot approves a Team nearly as clean as the best it could pick
      const W = goodModel(G, seat);
      const p = pClean(W, G.team);
      const best = bestTeam(G, seat, W).score;
      const bar = (G.rejects >= 3 ? 0.5 : 0.75) - (G.team.includes(seat) ? 0.05 : 0);
      return { kind: 'vote', approve: p >= best * bar - 1e-9 };
    }
    case 'quest': {
      if (!G.team.includes(seat) || G.cards[seat]) return null;
      if (!evil) return { kind: 'quest', card: 'success' };
      return { kind: 'quest', card: evilCard(G, seat) };
    }
    case 'lady': {
      if (!G.check) {
        if (seat !== G.lady.holder) return null;
        const targets = ladyTargets(G);
        if (evil) {
          const mine = evilKnown(G, seat);
          const goods = targets.filter((s) => !mine.has(s));
          const pool = goods.length ? goods : targets;
          return { kind: 'lady', target: pool[Math.floor(Math.random() * pool.length)] };
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
      if (seat !== G.check.holder) return null;
      if (!evil) return { kind: 'declare', says: G.check.loyalty };
      // an agent of Evil covers for its own and now and then slanders the Good
      if (G.check.loyalty === 'evil') return { kind: 'declare', says: 'good' };
      return { kind: 'declare', says: Math.random() < 0.4 ? 'evil' : 'good' };
    }
    case 'assassin': {
      if (me.role !== 'assassin') return null;
      return { kind: 'assassinate', target: merlinGuess(G, seat) };
    }
    default: return null;
  }
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
  if (me.role === 'oberon') return Math.random() < 0.85 ? 'fail' : 'success';
  const mine = G.team.filter((s) => evilKnown(G, seat).has(s)).sort((a, b) => a - b);
  if (won === 2 || lost === 2) {
    // the game rides on this one
    return mine.indexOf(seat) < needed ? 'fail' : 'success';
  }
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
  const cands = G.players.map((p) => p.seat).filter((s) => !mine.has(s));
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
