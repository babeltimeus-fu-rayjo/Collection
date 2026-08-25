// game.js — Decrypto rules engine (pure logic, no DOM, no network).
//
// An unofficial fan implementation of Decrypto by Thomas Dagenais-Lespérance
// (© Le Scorpion Masqué). Core rules follow the official English rulebook:
//   - Two teams (White and Black) of 2-4 players; each team has 4 secret
//     Keywords, fixed for the whole game, visible only to that team.
//   - Each round BOTH teams run an exchange: their Encryptor (rotating in
//     turn order) draws a 3-digit code — three DIFFERENT digits from 1-4 —
//     and gives 3 clues, one per digit, referring to the keywords in those
//     positions. Code cards are reshuffled, so the same code can come back.
//   - The encryptor's own team locks a guess to Decrypt it (a wrong guess is
//     a Miscommunication token); from Round 2 on the opposing team also locks
//     an Interception guess (a correct one earns an Interception token,
//     a wrong one costs nothing).
//   - 2 Interception tokens win the game; 2 Miscommunication tokens lose it;
//     checked at the END of a round — rounds always finish. 8 rounds max.
//   - Tiebreaker ladder (per rulebook): if a team both wins and loses at
//     once, both teams end in the same round, or the 8th round ends with no
//     decision: count points (interception +1, miscommunication -1); if
//     still tied, each team guesses the other's 4 keywords, most correct
//     wins; still tied = shared victory.
//   - Clue etiquette enforced where a program can: a clue may not be one of
//     your keywords (or contain/be contained by one), and no clue may be
//     used twice in a game by the same team.
//
// House rules for online play (how this table runs the round):
//   - The two exchanges run SIMULTANEOUSLY. As soon as a team's clues are
//     out, that team may decrypt them — no waiting on the other encryptor.
//     Once a team has locked its OWN answer it may start working on the
//     rival transmission (round 2+), if those clues are out. An exchange is
//     revealed once its decipher and (when due) the interception are locked;
//     the round ends when both exchanges are revealed.
//   - Everyone may SUGGEST a code to their team (non-binding opinions, shown
//     only to teammates), but the OFFICIAL call belongs to the round's
//     Decider: the player at the mirrored seat from their encryptor (first
//     clue-giver ↔ last decider, second ↔ second-to-last). On an odd-sized
//     team the middle player's mirror is themselves, so the duty shifts to
//     the next seat along.

export const PROTO = 3;
export const MIN_PER_TEAM = 2;
export const MAX_PER_TEAM = 4;
export const MAX_PLAYERS = MAX_PER_TEAM * 2;
export const MAX_ROUNDS = 8;

export const TEAM_META = [
  { key: 'white', name: 'Team White' },
  { key: 'black', name: 'Team Black' },
];

// Keyword pool in the spirit of the physical cards: common, evocative,
// clue-able words.
export const WORDS = [
  'moon', 'pirate', 'robot', 'winter', 'circus', 'anchor', 'volcano', 'library',
  'honey', 'mirror', 'castle', 'jungle', 'rocket', 'violin', 'desert', 'shadow',
  'bridge', 'candle', 'dragon', 'island', 'ladder', 'magnet', 'needle', 'ocean',
  'pillow', 'ribbon', 'saddle', 'temple', 'umbrella', 'wagon', 'yogurt', 'zipper',
  'airport', 'balloon', 'cactus', 'diamond', 'engine', 'feather', 'garden', 'hammer',
  'igloo', 'jacket', 'kettle', 'lantern', 'mountain', 'napkin', 'orchestra', 'panther',
  'quarter', 'rainbow', 'sausage', 'theater', 'unicorn', 'vampire', 'whistle', 'xylophone',
  'yacht', 'zebra', 'armor', 'bakery', 'compass', 'dolphin', 'eclipse', 'forest',
  'glacier', 'harbor', 'ink', 'jewel', 'kayak', 'lemon', 'museum', 'ninja',
  'opera', 'parade', 'quilt', 'river', 'statue', 'tunnel', 'uniform', 'valley',
  'waffle', 'yarn', 'acid', 'beard', 'canyon', 'dice', 'elbow', 'fountain',
  'ghost', 'hotel', 'iceberg', 'judge', 'knight', 'laser', 'maze', 'nest',
  'oyster', 'piano', 'queen', 'radar', 'siren', 'tractor', 'urchin', 'velvet',
  'wizard', 'attic', 'butter', 'clown', 'dentist', 'emerald', 'falcon', 'guitar',
  'helmet', 'invoice', 'jockey', 'karate', 'lighthouse', 'mermaid', 'noodle', 'octopus',
  'pyramid', 'quicksand', 'referee', 'skeleton', 'trophy', 'utopia', 'viking', 'walnut',
  'yoga', 'zombie', 'arrow', 'blanket', 'coffee', 'drum', 'envelope', 'fireworks',
  'gravity', 'hurricane', 'incense', 'jigsaw', 'kitchen', 'lava', 'marble', 'nurse',
  'oxygen', 'pepper', 'quest', 'rust', 'sphinx', 'tattoo', 'ukulele', 'vinegar',
  'wheelchair', 'xenon', 'yeti', 'zoo', 'atlas', 'bubble', 'chess', 'daisy',
  'echo', 'fossil', 'goblin', 'hive', 'ivory', 'jelly', 'kiwi', 'lace',
  'meteor', 'nectar', 'orbit', 'pearl', 'quiver', 'reef', 'sandal', 'tiger',
  'undertow', 'vault', 'wax', 'yolk', 'zeppelin', 'apron', 'bell', 'cabin',
  'dew', 'ember', 'flute', 'grape', 'hedge', 'idol', 'jam', 'kite',
  'lock', 'mask', 'net', 'olive', 'plow', 'quartz', 'rope', 'silk',
  'tent', 'urn', 'vine', 'well', 'yard', 'zone', 'algae', 'bison',
  'coral', 'dune', 'eagle', 'fern', 'geyser', 'hawk', 'iris', 'jaguar',
  'kelp', 'lily', 'moss', 'newt', 'owl', 'pine', 'quail', 'raven',
  'seal', 'toad', 'viper', 'wolf', 'aisle', 'banjo', 'chalk', 'dome',
  'easel', 'forge', 'gears', 'harp', 'inn', 'jar', 'kiln', 'loom',
  'mill', 'nail', 'oar', 'pump', 'rack', 'sled', 'torch', 'vase',
  'wheel', 'anvil', 'badge', 'crown', 'debt', 'exam', 'fame', 'gold',
  'honor', 'income', 'jury', 'karma', 'luck', 'mercy', 'noise', 'order',
  'pride', 'quota', 'rhythm', 'sleep', 'truth', 'unity', 'vote', 'wisdom',
  'youth', 'zeal', 'autumn', 'breeze', 'cloud', 'dawn', 'evening', 'frost',
  'gale', 'hail', 'lightning', 'mist', 'north', 'polar', 'rain', 'summer',
  'thunder', 'wind', 'apple', 'bread', 'cheese', 'donut', 'egg', 'fudge',
  'garlic', 'ham', 'icing', 'juice', 'kebab', 'lobster', 'mango', 'nutmeg',
  'onion', 'pasta', 'radish', 'salmon', 'taco', 'vanilla', 'wasabi', 'banana',
  'circuit', 'dynamo', 'email', 'fuse', 'gadget', 'hologram', 'internet', 'joystick',
  'keyboard', 'lens', 'modem', 'neon', 'outlet', 'pixel', 'quantum', 'reactor',
  'satellite', 'telescope', 'upload', 'virus', 'wire', 'antenna', 'battery', 'code',
  'doctor', 'farmer', 'sheriff', 'tailor', 'actor', 'barber', 'chef', 'diver',
  'usher', 'waiter', 'pilot', 'sailor', 'miner', 'poet', 'spy', 'king',
  'ballet', 'carnival', 'derby', 'encore', 'festival', 'gala', 'holiday', 'joust',
  'lottery', 'marathon', 'olympics', 'picnic', 'regatta', 'safari', 'tournament', 'wedding',
  'ambulance', 'bicycle', 'canoe', 'dogsled', 'elevator', 'ferry', 'gondola', 'helicopter',
  'jet', 'limousine', 'metro', 'nozzle', 'parachute', 'rickshaw', 'submarine', 'trolley',
  'unicycle', 'van', 'wagonwheel', 'arch', 'basement', 'chimney', 'doorbell', 'escalator',
  'fence', 'gutter', 'hallway', 'ivy', 'jailhouse', 'kennel', 'lobby', 'mansion',
  'nook', 'office', 'porch', 'quay', 'roof', 'stairs', 'terrace', 'veranda',
];

// ---------------------------------------------------------------- helpers

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// a code is 3 DIFFERENT digits from 1-4; decks are reshuffled after every
// round, so each exchange is simply a fresh uniform draw
export function randomCode() {
  const digits = shuffle([1, 2, 3, 4]);
  return digits.slice(0, 3);
}

export function codeLabel(code) {
  return code ? code.join('·') : '?·?·?';
}

function fold(s) {
  return String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();
}

export function cleanClue(s) {
  return String(s == null ? '' : s).trim().replace(/\s+/g, ' ').slice(0, 40);
}

function sameCode(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === 3 && a.every((d, i) => d === b[i]);
}

function validCode(code) {
  return (
    Array.isArray(code) &&
    code.length === 3 &&
    code.every((d) => Number.isInteger(d) && d >= 1 && d <= 4) &&
    new Set(code).size === 3
  );
}

export function playerBySeat(G, seat) {
  return G.players.find((p) => p.seat === seat);
}

export function teamOf(G, seat) {
  const p = playerBySeat(G, seat);
  return p ? p.team : -1;
}

function connectedSeats(G, ti) {
  return G.teams[ti].seats.filter((s) => {
    const p = playerBySeat(G, s);
    return p && p.connected;
  });
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

// ---------------------------------------------------------------- setup

export function newMatch(roster) {
  const players = roster
    .map((r) => ({ seat: r.seat, name: r.name, connected: r.connected !== false, team: r.team ? 1 : 0 }))
    .sort((a, b) => a.seat - b.seat);

  const pool = shuffle(WORDS.slice());
  const G = {
    proto: PROTO,
    mid: Math.random().toString(36).slice(2, 10),
    phase: 'playing', // playing | showdown | over
    round: 1,
    players,
    teams: TEAM_META.map((t, i) => ({
      key: t.key,
      name: t.name,
      seats: players.filter((p) => p.team === i).map((p) => p.seat),
      keywords: pool.splice(0, 4),
      encPtr: 0,
      intercepts: 0,
      miscomms: 0,
      clueLog: [],
      showdownWords: null,
      showdownHits: null,
    })),
    exchanges: null, // [white exchange, black exchange] — both run at once
    history: [],
    result: null,
    log: [],
    feedSeq: 0,
    fx: null,
    fxSeq: 0,
  };
  addLog(G, `The keywords are set. ${G.teams[0].name} and ${G.teams[1].name}, to your screens!`);
  startRound(G);
  return G;
}

function pickEncryptor(G, ti) {
  const team = G.teams[ti];
  // strict turn order — if the duty lands on a disconnected player the game
  // waits for them (the host can hand the code to a teammate instead)
  const seat = team.seats[team.encPtr % team.seats.length];
  team.encPtr = (team.encPtr + 1) % team.seats.length;
  return seat;
}

// The official-call seat mirrors the encryptor's position in team order:
// first clue-giver ↔ last decider, second ↔ second-to-last. On an odd team
// the middle player's mirror is themselves, so the duty shifts one seat on.
function deciderFor(team, encSeat) {
  const n = team.seats.length;
  const i = Math.max(0, team.seats.indexOf(encSeat));
  let d = n - 1 - i;
  if (d === i) d = (i + 1) % n;
  return team.seats[d];
}

function startRound(G) {
  addLog(G, `— Round ${G.round} of ${MAX_ROUNDS} — both encryptors receive a code.`);
  G.exchanges = [0, 1].map((ti) => {
    const team = G.teams[ti];
    const enc = pickEncryptor(G, ti);
    const dec = deciderFor(team, enc);
    addLog(G, `${team.name}: ${playerBySeat(G, enc).name} encrypts — ${playerBySeat(G, dec).name} has the final say.`);
    return {
      team: ti,
      encryptor: enc,
      decider: dec,
      code: randomCode(),
      clues: null,
      decipher: null,
      decipherBy: null,
      opinions: {}, // seat -> suggested code (own team, non-binding)
      needIntercept: G.round >= 2,
      intercept: null,
      interceptBy: null,
      intOpinions: {}, // seat -> suggested code (rival team, non-binding)
      resolved: false,
      hitI: false,
      missD: false,
    };
  });
}

// ---------------------------------------------------------------- moves

export function applyMove(G, seat, move) {
  if (!G || !move || typeof move !== 'object') return { ok: false, error: 'Bad move' };
  const p = playerBySeat(G, seat);
  if (!p) return { ok: false, error: 'Not at the table' };
  if (G.phase === 'over') return { ok: false, error: 'The game is over' };
  if (G.phase === 'showdown') {
    if (move.kind !== 'showdown') return { ok: false, error: 'The tiebreaker is on — guess their keywords!' };
    return doShowdown(G, p, move);
  }
  if (move.kind === 'clues') return doClues(G, p, move);
  if (move.kind === 'opinion') return doOpinion(G, p, move);
  if (move.kind === 'guess') return doGuess(G, p, move);
  return { ok: false, error: 'Unknown action' };
}

function doClues(G, p, move) {
  const E = G.exchanges && G.exchanges[p.team];
  if (!E) return { ok: false, error: 'No exchange running' };
  if (E.clues) return { ok: false, error: 'Clues are already out' };
  if (p.seat !== E.encryptor) return { ok: false, error: 'Only the encryptor writes the clues' };
  const team = G.teams[E.team];
  const raw = Array.isArray(move.words) ? move.words.slice(0, 3) : [];
  const words = raw.map(cleanClue);
  if (words.length !== 3 || words.some((w) => !w)) return { ok: false, error: 'Give exactly 3 clues' };
  const folded = words.map(fold);
  if (new Set(folded).size !== 3) return { ok: false, error: 'A clue may only be used once per game — even within a round' };
  for (const w of folded) {
    for (const kw of team.keywords) {
      const k = fold(kw);
      if (w === k || (k.length >= 3 && w.includes(k)) || (w.length >= 3 && k.includes(w))) {
        return { ok: false, error: 'A clue may not use one of your keywords (or a piece of it)' };
      }
    }
    if (team.clueLog.some((c) => fold(c) === w)) {
      return { ok: false, error: `“${w}” has already been used — a clue may only be used once per game` };
    }
  }
  E.clues = words;
  team.clueLog.push(...words);
  addLog(G, `${p.name} transmits: “${words[0]}” · “${words[1]}” · “${words[2]}”.`);
  setFx(G, { kind: 'clues', team: E.team });
  return { ok: true };
}

// Which official guess is `p` allowed to make on exchange E right now?
// Returns null when allowed, or an error string.
function guessGate(G, p, E, official) {
  if (!E) return 'No exchange running';
  if (E.resolved) return 'That code is already revealed';
  if (!E.clues) return 'Wait for the clues';
  if (p.team === E.team) {
    if (p.seat === E.encryptor) return 'You wrote that code — poker face!';
    if (E.decipher) return 'Your team has already locked its answer';
    if (official && p.seat !== E.decider) {
      return `${playerBySeat(G, E.decider).name} makes the official call — suggest your code to the team instead`;
    }
  } else {
    if (!E.needIntercept) return 'No interception in Round 1 — take notes!';
    const mine = G.exchanges[p.team];
    if (!mine.decipher) return 'Decrypt your own transmission first';
    if (E.intercept) return 'Your team has already locked its interception';
    if (official && p.seat !== mine.decider) {
      return `${playerBySeat(G, mine.decider).name} makes the official call — suggest your code to the team instead`;
    }
  }
  return null;
}

// Non-binding suggestion, visible only to the suggester's own team.
function doOpinion(G, p, move) {
  const t = move.target;
  if (t !== 0 && t !== 1) return { ok: false, error: 'Bad target' };
  const E = G.exchanges && G.exchanges[t];
  const gateErr = guessGate(G, p, E, false);
  if (gateErr) return { ok: false, error: gateErr };
  if (!validCode(move.code)) return { ok: false, error: 'A code is 3 different digits from 1 to 4' };
  const store = p.team === t ? E.opinions : E.intOpinions;
  store[p.seat] = move.code.slice(0, 3);
  return { ok: true };
}

// The official call — decider only.
function doGuess(G, p, move) {
  const t = move.target;
  if (t !== 0 && t !== 1) return { ok: false, error: 'Bad target' };
  const E = G.exchanges && G.exchanges[t];
  const gateErr = guessGate(G, p, E, true);
  if (gateErr) return { ok: false, error: gateErr };
  if (!validCode(move.code)) return { ok: false, error: 'A code is 3 different digits from 1 to 4' };
  const code = move.code.slice(0, 3);
  if (p.team === t) {
    E.decipher = code;
    E.decipherBy = p.seat;
    addLog(G, `${G.teams[t].name} lock in their answer.`);
  } else {
    E.intercept = code;
    E.interceptBy = p.seat;
    addLog(G, `${G.teams[p.team].name} lock in an interception attempt.`);
  }
  setFx(G, { kind: 'lock', team: p.team });
  maybeResolve(G, E);
  return { ok: true };
}

function maybeResolve(G, E) {
  if (E.resolved || !E.decipher || (E.needIntercept && !E.intercept)) return;
  resolveExchange(G, E);
  if (G.exchanges && G.exchanges.every((x) => x.resolved)) endOfRound(G);
}

function resolveExchange(G, E) {
  const team = G.teams[E.team];
  const opp = G.teams[1 - E.team];
  E.hitI = E.needIntercept && sameCode(E.intercept, E.code);
  E.missD = !sameCode(E.decipher, E.code);
  E.resolved = true;
  if (E.hitI) opp.intercepts += 1;
  if (E.missD) team.miscomms += 1;

  G.history.push({
    round: G.round,
    team: E.team,
    encryptor: E.encryptor,
    decider: E.decider,
    clues: E.clues,
    code: E.code,
    decipher: E.decipher,
    intercept: E.needIntercept ? E.intercept : null,
    hitI: E.hitI,
    missD: E.missD,
  });

  addLog(G, `${team.name}'s code was ${codeLabel(E.code)}.`);
  if (E.hitI) addLog(G, `${opp.name} INTERCEPT — that's ${opp.intercepts === 1 ? 'their first white token' : 'their second white token!'}`);
  else if (E.needIntercept && E.intercept) addLog(G, `${opp.name} guessed ${codeLabel(E.intercept)} — no interception.`);
  if (E.missD) addLog(G, `${team.name} miscommunicate (they guessed ${codeLabel(E.decipher)}) — a black token.`);
  else addLog(G, `${team.name} decrypt it cleanly.`);
  setFx(G, { kind: 'reveal', team: E.team, hitI: E.hitI, missD: E.missD, code: E.code });
}

function endOfRound(G) {
  const decided = G.teams.some((t) => t.intercepts >= 2 || t.miscomms >= 2);
  if (!decided && G.round < MAX_ROUNDS) {
    G.round += 1;
    startRound(G);
    return;
  }
  G.exchanges = null;
  const scores = G.teams.map((t) => t.intercepts - t.miscomms);
  if (scores[0] !== scores[1]) {
    finish(G, scores[0] > scores[1] ? 0 : 1, decided ? 'tokens' : 'timeout');
    return;
  }
  // tied on points: each team guesses the other's keywords
  G.phase = 'showdown';
  addLog(
    G,
    decided
      ? 'Both teams end the game with the same score — tiebreaker! Each team now guesses the other team’s 4 keywords.'
      : `Eight rounds and no decision — tiebreaker! Each team now guesses the other team's 4 keywords.`,
  );
  setFx(G, { kind: 'showdown' });
}

function doShowdown(G, p, move) {
  const team = G.teams[p.team];
  if (team.showdownWords) return { ok: false, error: 'Your team has already answered' };
  const raw = Array.isArray(move.words) ? move.words.slice(0, 4) : [];
  const words = raw.map(cleanClue);
  if (words.length !== 4 || words.some((w) => !w)) return { ok: false, error: 'Guess all 4 keywords' };
  team.showdownWords = words;
  addLog(G, `${team.name} lock in their keyword guesses.`);
  if (G.teams.every((t) => t.showdownWords)) {
    for (let i = 0; i < 2; i++) {
      const guesser = G.teams[i];
      const target = G.teams[1 - i];
      const remaining = target.keywords.map(fold);
      let hits = 0;
      for (const w of guesser.showdownWords.map(fold)) {
        const at = remaining.indexOf(w);
        if (at >= 0) {
          hits += 1;
          remaining.splice(at, 1);
        }
      }
      guesser.showdownHits = hits;
      addLog(G, `${guesser.name} name ${hits} of ${target.name}'s keywords correctly.`);
    }
    const [a, b] = G.teams.map((t) => t.showdownHits);
    finish(G, a === b ? null : a > b ? 0 : 1, a === b ? 'shared' : 'showdown');
  }
  return { ok: true };
}

function finish(G, winner, reason) {
  G.phase = 'over';
  G.exchanges = null;
  G.result = {
    winner,
    reason,
    scores: G.teams.map((t) => t.intercepts - t.miscomms),
  };
  if (winner == null) addLog(G, 'Still tied — both teams share the victory!');
  else {
    const why = {
      tokens: 'on tokens',
      timeout: 'on points after 8 rounds',
      showdown: 'in the keyword showdown',
      forfeit: 'by forfeit',
    }[reason];
    addLog(G, `${G.teams[winner].name} win ${why ? why : ''}! The keywords are revealed.`);
  }
  setFx(G, { kind: 'over', winner });
}

// ---------------------------------------------------------------- lifecycle

export function markReconnected(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p || p.connected) return false;
  p.connected = true;
  addLog(G, `${p.name} reconnected — welcome back!`);
  return true;
}

export function markDisconnected(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p || !p.connected) return false;
  p.connected = false;
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
  addLog(G, `${name} takes over ${old}'s seat.`);
  return true;
}

// A player may hand back their seat and keep watching; the seat then waits
// for a claimant (or, in games with bots, a host bot-takeover).
export function markSeatResigned(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p || !p.connected) return false;
  p.connected = false;
  p.resigned = true;
  addLog(G, `${p.name} hands back their seat — it is open for a taker.`);
  return true;
}

// Host-only remedy when a pending encryptor is disconnected: hand their
// team's exchange (same code) to a connected teammate.
export function passEncryptor(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p || p.connected || G.phase !== 'playing' || !G.exchanges) return false;
  const E = G.exchanges[p.team];
  if (E.encryptor !== seat || E.clues) return false;
  const conn = connectedSeats(G, p.team).filter((s) => s !== seat);
  if (!conn.length) return false;
  const pick = conn.find((s) => s !== E.decider);
  const next = pick != null ? pick : conn[0];
  E.encryptor = next;
  delete E.opinions[next]; // they know the code now — any old suggestion is moot
  if (E.decider === next) {
    // keep the roles apart when another teammate is available
    const dec2 = conn.find((s) => s !== next);
    if (dec2 != null) E.decider = dec2;
  }
  addLog(G, `The host hands the code to ${playerBySeat(G, next).name} — they take over as encryptor.`);
  return true;
}

// Host-only remedy when a decider with a pending official call is
// disconnected: hand the final say to a connected teammate.
export function passDecider(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p || p.connected || G.phase !== 'playing' || !G.exchanges) return false;
  const E = G.exchanges[p.team];
  if (E.decider !== seat) return false;
  const rival = G.exchanges[1 - p.team];
  const ownPending = !E.resolved && E.clues && !E.decipher;
  const intPending = !rival.resolved && rival.needIntercept && rival.clues && E.decipher && !rival.intercept;
  if (!ownPending && !intPending) return false;
  const conn = connectedSeats(G, p.team).filter((s) => s !== seat);
  if (!conn.length) return false;
  const pick = conn.find((s) => s !== E.encryptor);
  E.decider = pick != null ? pick : conn[0];
  addLog(G, `The host hands the final say to ${playerBySeat(G, E.decider).name}.`);
  return true;
}

// ---------------------------------------------------------------- views

export function viewFor(G, seat, code) {
  const me = playerBySeat(G, seat);
  const myTeam = me ? me.team : -1;
  const over = G.phase === 'over';
  return {
    t: 'state',
    code,
    you: seat,
    myTeam,
    mid: G.mid,
    phase: G.phase,
    round: G.round,
    maxRounds: MAX_ROUNDS,
    players: G.players.map((p) => ({ seat: p.seat, name: p.name, connected: p.connected, resigned: !!p.resigned, team: p.team })),
    teams: G.teams.map((t, i) => ({
      key: t.key,
      name: t.name,
      seats: t.seats,
      intercepts: t.intercepts,
      miscomms: t.miscomms,
      keywords: i === myTeam || over ? t.keywords : null,
      showdownDone: !!t.showdownWords,
      showdownWords: over || i === myTeam ? t.showdownWords : null,
      showdownHits: t.showdownHits,
    })),
    exchanges: G.exchanges
      ? G.exchanges.map((E) => {
          const mine = myTeam === E.team; // it's my team's code
          const open = E.resolved || over;
          return {
            team: E.team,
            encryptor: E.encryptor,
            decider: E.decider,
            clues: E.clues,
            needIntercept: E.needIntercept,
            haveDecipher: !!E.decipher,
            haveIntercept: !!E.intercept,
            decipherBy: E.decipherBy,
            interceptBy: E.interceptBy,
            resolved: E.resolved,
            hitI: open ? E.hitI : null,
            missD: open ? E.missD : null,
            // the code is the encryptor's secret until the reveal; locked
            // guesses are visible to the side that made them
            code: seat === E.encryptor || open ? E.code : null,
            decipher: mine || open ? E.decipher : null,
            intercept: !mine || open ? E.intercept : null,
            opinions: mine ? E.opinions : null,
            intOpinions: !mine ? E.intOpinions : null,
          };
        })
      : null,
    history: G.history,
    result: G.result,
    log: G.log.slice(-60),
    fx: G.fx,
  };
}
