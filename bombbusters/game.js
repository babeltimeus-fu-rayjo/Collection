// game.js — Bomb Busters rules engine (pure logic, no DOM, no network).
//
// An unofficial fan implementation of Bomb Busters by Hisashi Hayashi
// (© Cocktail Games / Pegasus Spiele). Rules follow the official rulebook:
//   - 48 blue wires, values 1-12, four copies each.
//   - Red wires ("1,5".."11,5") and yellow wires ("1,1".."11,1") join the mix
//     depending on the mission; their printed value is used ONLY to sort them
//     into a stand. In play they are simply "red" / "yellow".
//   - Everyone sees their own wires but not their teammates'; every stand is
//     sorted in ascending order, which is what makes deduction possible.
//   - Duo cut: point at a teammate's wire and call a value you hold yourself.
//     Right: both wires are cut. Wrong: the detonator advances and the wire's
//     real value is marked with an Info token. Red: BOOM.
//   - Solo cut: cut the last 2 or 4 copies of a value if they are all in your
//     hand (yellows: all remaining yellows).
//   - Reveal red wires: allowed when reds are ALL you have left.
//   - The team wins when every stand is empty (reds revealed, all else cut).
//
// Sort keys ("sv") are integers: blue v*10, yellow v*10+1, red v*10+5 — so a
// yellow 3.1 sits between the 3s and the 4s, exactly like the physical tiles.

export const PROTO = 1;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 5;

// Difficulty presets standing in for the campaign's mission cards. Red/yellow
// counts follow the mission-card system from the rulebook ("take the number of
// red and yellow wires shown on the Mission card"); "2 out of 3" reds use the
// official partial-information setup with "?" markers.
export const MISSIONS = [
  {
    key: 'training',
    name: 'Training Op',
    red: 0,
    redCandidates: 0,
    yellow: 0,
    equipment: false,
    blurb: 'Just the 48 blue wires. Learn to read the racks — no red wires, no equipment.',
  },
  {
    key: 'field',
    name: 'Field Exam',
    red: 1,
    redCandidates: 1,
    yellow: 0,
    equipment: true,
    blurb: 'One red wire is hiding in the bomb. Its value is known — never cut it.',
  },
  {
    key: 'standard',
    name: 'Standard Op',
    red: 1,
    redCandidates: 1,
    yellow: 1,
    equipment: true,
    blurb: 'One red wire and one yellow wire. Yellows must be cut too — by calling "yellow".',
  },
  {
    key: 'double',
    name: 'Double Trouble',
    red: 2,
    redCandidates: 2,
    yellow: 2,
    equipment: true,
    blurb: 'Two red wires, two yellow wires. Mind the gaps between the numbers.',
  },
  {
    key: 'codered',
    name: 'Code Red',
    red: 2,
    redCandidates: 3,
    yellow: 2,
    equipment: true,
    blurb: 'Three possible red values are marked "?" — only two of them are really in the bomb.',
  },
];

export function missionByKey(key) {
  return MISSIONS.find((m) => m.key === key) || MISSIONS[2];
}

// The five equipment cards implemented here follow the official FAQ. (The
// physical box has 12; the ones that move tiles between stands are omitted.)
export const EQUIPMENT = [
  {
    v: 3,
    key: 'triple',
    name: 'Triple Detector 3000',
    text: 'On your turn: name a value you hold and point at 3 wires in one stand. The cut succeeds if any of them matches.',
  },
  {
    v: 5,
    key: 'super',
    name: 'Super Detector',
    text: 'On your turn: name a value you hold and point at a whole stand. The cut succeeds if any wire there matches.',
  },
  {
    v: 8,
    key: 'radar',
    name: 'General Radar',
    text: 'Anytime, without using your turn: name a value 1-12 — every player says whether they hold at least one.',
  },
  {
    v: 9,
    key: 'stab',
    name: 'Stabilizator',
    text: 'Automatic: absorbs the blast once — when the bomb would explode, it doesn’t.',
  },
  {
    v: 10,
    key: 'xy',
    name: 'X or Y Ray',
    text: 'On your turn: name TWO values you hold and point at 1 wire. The cut succeeds if it matches either.',
  },
];

// ---------------------------------------------------------------- helpers

export function svKind(sv) {
  const r = sv % 10;
  return r === 0 ? 'blue' : r === 1 ? 'yellow' : 'red';
}

export function svBase(sv) {
  return Math.floor(sv / 10);
}

// Short display for a sort value: 7 / Y3 / R5 — used in logs and post-mortems.
export function svLabel(sv) {
  const k = svKind(sv);
  if (k === 'blue') return String(svBase(sv));
  return `${k === 'yellow' ? 'Y' : 'R'}${svBase(sv)}`;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function drawDistinct(n, lo, hi) {
  const pool = [];
  for (let v = lo; v <= hi; v++) pool.push(v);
  shuffle(pool);
  return pool.slice(0, n).sort((a, b) => a - b);
}

export function playerBySeat(G, seat) {
  return G.players.find((p) => p.seat === seat);
}

export function standById(G, id) {
  return G.stands.find((s) => s.id === id);
}

export function tileById(G, id) {
  return G.tilesById[id] || null;
}

function ownsStand(G, seat, standId) {
  const s = standById(G, standId);
  return !!s && s.owner === seat;
}

// Tiles still standing (not cut, not revealed) in one player's whole hand.
export function hiddenTiles(G, seat) {
  const out = [];
  for (const s of G.stands) {
    if (s.owner !== seat) continue;
    for (const t of s.tiles) if (!t.cut && !t.revealed) out.push(t);
  }
  return out;
}

function uncutOfStand(stand) {
  return stand.tiles.filter((t) => !t.cut && !t.revealed);
}

// Own uncut tile matching an announced value (12 → blue 12, 'yellow' → yellow).
function ownMatches(G, seat, value) {
  return hiddenTiles(G, seat).filter((t) =>
    value === 'yellow' ? t.kind === 'yellow' : t.kind === 'blue' && t.v === value,
  );
}

function tileMatchesValues(t, values) {
  for (const v of values) {
    if (v === 'yellow' ? t.kind === 'yellow' : t.kind === 'blue' && t.v === v) return true;
  }
  return false;
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

function posLabel(G, stand, tile) {
  const i = stand.tiles.indexOf(tile);
  const n = i + 1;
  const ord = n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th';
  const owner = playerBySeat(G, stand.owner);
  const two = owner && owner.standIds.length > 1 ? ` (stand ${stand.label})` : '';
  return `${n}${ord} wire${two}`;
}

// ---------------------------------------------------------------- setup

export function newMatch(roster, missionKey, prevCaptain = null) {
  const mission = missionByKey(missionKey);
  const players = roster.map((r) => ({
    seat: r.seat,
    name: r.name,
    bot: !!r.bot,
    connected: r.connected !== false,
    standIds: [],
    usedChar: false,
    lastAction: null,
  }));
  players.sort((a, b) => a.seat - b.seat);

  const seats = players.map((p) => p.seat);
  let captain;
  if (prevCaptain == null || !seats.length) {
    captain = seats[Math.floor(Math.random() * seats.length)];
  } else {
    // failed or finished mission: the next player takes the captain card
    const i = seats.indexOf(prevCaptain);
    captain = seats[(i >= 0 ? i + 1 : 0) % seats.length];
  }

  const G = {
    proto: PROTO,
    mid: Math.random().toString(36).slice(2, 10),
    mission: mission.key,
    phase: 'setup',
    players,
    captain,
    turn: captain,
    stands: [],
    tilesById: {},
    dial: 0,
    dialSize: players.length,
    cutCount: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0, 11: 0, 12: 0 },
    yellowTotal: mission.yellow,
    yellowCut: 0,
    redTotal: mission.red,
    boardRed: [],
    boardYellow: [],
    equipment: [],
    radar: [],
    calls: [],
    negative: [],
    pending: null,
    setupQueue: [],
    setupIdx: 0,
    log: [],
    feedSeq: 0,
    fx: null,
    fxSeq: 0,
    stats: { errors: 0, saves: 0, turns: 0 },
    result: null,
  };

  // --- wires ------------------------------------------------------------
  const tiles = [];
  let nextId = 1;
  const mk = (kind, v) => {
    const sv = kind === 'blue' ? v * 10 : kind === 'yellow' ? v * 10 + 1 : v * 10 + 5;
    const t = { id: nextId++, kind, v, sv, cut: false, revealed: false, token: null, knownRed: false };
    G.tilesById[t.id] = t;
    tiles.push(t);
    return t;
  };
  for (let v = 1; v <= 12; v++) for (let c = 0; c < 4; c++) mk('blue', v);

  const yellowVals = drawDistinct(mission.yellow, 1, 11);
  for (const v of yellowVals) mk('yellow', v);
  G.boardYellow = yellowVals.map((v) => ({ v, sure: true }));

  // Reds: draw the candidates, then keep only `red` of them in the bomb.
  // With red == redCandidates the board shows exact values; otherwise every
  // candidate is marked "?" and one of them is quietly set aside.
  const redCand = drawDistinct(Math.max(mission.red, mission.redCandidates), 1, 11);
  const inPlay = shuffle(redCand.slice()).slice(0, mission.red).sort((a, b) => a - b);
  for (const v of inPlay) mk('red', v);
  const sure = mission.red >= redCand.length;
  G.boardRed = redCand.map((v) => ({ v, sure }));

  // --- stands ------------------------------------------------------------
  // 2 players: two stands each. 3 players: the captain takes two. 4-5: one.
  const n = players.length;
  let sid = 0;
  for (const p of players) {
    const two = n === 2 || (n === 3 && p.seat === captain);
    const count = two ? 2 : 1;
    for (let k = 0; k < count; k++) {
      const stand = { id: sid++, owner: p.seat, label: count > 1 ? (k === 0 ? 'A' : 'B') : '', tiles: [] };
      G.stands.push(stand);
      p.standIds.push(stand.id);
    }
  }

  shuffle(tiles);
  tiles.forEach((t, i) => {
    G.stands[i % G.stands.length].tiles.push(t);
  });
  for (const s of G.stands) s.tiles.sort((a, b) => a.sv - b.sv);

  // --- equipment ----------------------------------------------------------
  if (mission.equipment) {
    const pool = shuffle(EQUIPMENT.slice());
    G.equipment = pool
      .slice(0, Math.min(n, pool.length))
      .sort((a, b) => a.v - b.v)
      .map((e) => ({ v: e.v, key: e.key, name: e.name, text: e.text, unlocked: false, used: false }));
  }

  // --- setup marking (captain first, then clockwise) ----------------------
  const ci = seats.indexOf(captain);
  G.setupQueue = seats.slice(ci).concat(seats.slice(0, ci));

  const capName = playerBySeat(G, captain).name;
  addLog(G, `Mission: ${mission.name} — 48 blue wires, ${mission.red} red, ${mission.yellow} yellow.`);
  addLog(G, `${capName} is Captain. Everyone marks one blue wire for the team.`);
  return G;
}

// ---------------------------------------------------------------- win/loss

function allClear(G) {
  return G.stands.every((s) => s.tiles.every((t) => t.cut || t.revealed));
}

function winCheck(G) {
  if (G.phase !== 'playing') return;
  if (allClear(G)) {
    G.phase = 'won';
    G.result = { kind: 'won' };
    addLog(G, 'The bomb is defused — mission accomplished!');
    setFx(G, { kind: 'won' });
  }
}

function explode(G, reason, tile) {
  G.phase = 'lost';
  G.result = { kind: 'lost', reason, tileId: tile ? tile.id : null };
  addLog(G, reason === 'red' ? 'A RED wire was cut. BOOM.' : 'The detonator reached the skull. BOOM.');
  setFx(G, { kind: 'boom' });
}

// Consumes the Stabilizator if it is ready. Returns true if the blast was absorbed.
function tryStabilize(G) {
  const eq = G.equipment.find((e) => e.key === 'stab' && e.unlocked && !e.used);
  if (!eq) return false;
  eq.used = true;
  G.stats.saves += 1;
  return true;
}

function advanceDial(G) {
  G.stats.errors += 1;
  G.dial += 1;
  if (G.dial >= G.dialSize) {
    if (tryStabilize(G)) {
      G.dial -= 1;
      addLog(G, 'The Stabilizator absorbs the shock — the detonator holds!');
      setFx(G, { kind: 'save' });
      return true;
    }
    explode(G, 'dial', null);
    return false;
  }
  return true;
}

function cutTile(G, t) {
  t.cut = true;
  t.token = null;
  if (t.kind === 'blue') {
    G.cutCount[t.v] += 1;
    for (const eq of G.equipment) {
      if (!eq.unlocked && G.cutCount[eq.v] >= 2) {
        eq.unlocked = true;
        addLog(G, `Equipment unlocked: ${eq.name} (both ${eq.v}s are cut).`);
      }
    }
  } else if (t.kind === 'yellow') {
    G.yellowCut += 1;
  }
}

function nextTurn(G) {
  if (G.phase !== 'playing') return;
  G.stats.turns += 1;
  const seats = G.players.map((p) => p.seat);
  const i = seats.indexOf(G.turn);
  for (let k = 1; k <= seats.length; k++) {
    const s = seats[(i + k) % seats.length];
    if (hiddenTiles(G, s).length > 0) {
      G.turn = s;
      return;
    }
  }
  // nobody has wires left — winCheck already fired
}

function finishAction(G) {
  winCheck(G);
  if (G.phase === 'playing') nextTurn(G);
}

// ---------------------------------------------------------------- moves

export function applyMove(G, seat, move) {
  if (!G || !move || typeof move !== 'object') return { ok: false, error: 'Bad move' };
  if (G.phase === 'won' || G.phase === 'lost') return { ok: false, error: 'The mission is over' };
  const p = playerBySeat(G, seat);
  if (!p) return { ok: false, error: 'Not at the table' };

  if (G.phase === 'setup') return doMark(G, p, move);
  if (move.kind === 'radar') return doRadar(G, p, move);
  if (G.pending) {
    if (move.kind !== 'choose') return { ok: false, error: `Waiting for ${playerBySeat(G, G.pending.seat).name} to choose` };
    return doChoose(G, p, move);
  }
  if (move.kind === 'cut') return doCut(G, p, move);
  if (move.kind === 'solo') return doSolo(G, p, move);
  if (move.kind === 'reveal') return doReveal(G, p, move);
  return { ok: false, error: 'Unknown action' };
}

function doMark(G, p, move) {
  if (move.kind !== 'mark') return { ok: false, error: 'Mark one of your blue wires first' };
  if (G.setupQueue[G.setupIdx] !== p.seat) return { ok: false, error: 'Not your turn to mark' };
  const t = tileById(G, move.tileId);
  const stand = t && G.stands.find((s) => s.tiles.includes(t));
  if (!t || !stand || stand.owner !== p.seat) return { ok: false, error: 'Pick one of your own wires' };
  if (t.kind !== 'blue') return { ok: false, error: 'Setup marks go on a BLUE wire' };
  t.token = t.v;
  p.lastAction = `marked a ${t.v} for the team`;
  addLog(G, `${p.name} marks their ${posLabel(G, stand, t)} — it is a ${t.v}.`);
  G.setupIdx += 1;
  if (G.setupIdx >= G.setupQueue.length) {
    G.phase = 'playing';
    G.turn = G.captain;
    addLog(G, `Wires marked. Captain ${playerBySeat(G, G.captain).name} takes the first turn.`);
  }
  return { ok: true };
}

function doRadar(G, p, move) {
  if (G.phase !== 'playing') return { ok: false, error: 'Not now' };
  const eq = G.equipment.find((e) => e.key === 'radar');
  if (!eq || !eq.unlocked || eq.used) return { ok: false, error: 'The General Radar is not available' };
  const v = move.value;
  if (!Number.isInteger(v) || v < 1 || v > 12) return { ok: false, error: 'Radar needs a value from 1 to 12' };
  eq.used = true;
  const answers = G.players.map((q) => ({
    seat: q.seat,
    has: hiddenTiles(G, q.seat).some((t) => t.kind === 'blue' && t.v === v),
    cuts: cutsOfValueIn(G, q.seat, v),
  }));
  G.radar.push({ v, answers, by: p.seat });
  const yes = answers.filter((a) => a.has).map((a) => playerBySeat(G, a.seat).name);
  addLog(G, `${p.name} sweeps the General Radar on ${v}: ${yes.length ? yes.join(', ') : 'nobody'} still hold${yes.length === 1 ? 's' : ''} one.`);
  p.lastAction = `swept the Radar on ${v}`;
  setFx(G, { kind: 'radar', v });
  return { ok: true };
}

// how many wires of this value have been cut out of one player's stands —
// used to expire "they said they hold a 7" facts once a 7 leaves their hand
function cutsOfValueIn(G, seat, v) {
  let n = 0;
  for (const s of G.stands) {
    if (s.owner !== seat) continue;
    for (const t of s.tiles) {
      if (!t.cut) continue;
      if (v === 'yellow' ? t.kind === 'yellow' : t.kind === 'blue' && t.v === v) n += 1;
    }
  }
  return n;
}

function recordCall(G, seat, v) {
  G.calls.push({ seat, v, cuts: cutsOfValueIn(G, seat, v) });
  if (G.calls.length > 80) G.calls.shift();
}

function valueLabel(v) {
  return v === 'yellow' ? 'YELLOW' : String(v);
}

function doCut(G, p, move) {
  if (G.turn !== p.seat) return { ok: false, error: 'Not your turn' };
  const stand = standById(G, move.standId);
  if (!stand) return { ok: false, error: 'Pick a stand' };
  if (stand.owner === p.seat) return { ok: false, error: 'Point at a teammate’s wire, not your own' };

  const equip = move.equip || null;
  let values = Array.isArray(move.values) ? move.values.slice(0, 2) : [];
  values = values.filter((v) => v === 'yellow' || (Number.isInteger(v) && v >= 1 && v <= 12));

  const standUncut = uncutOfStand(stand);
  let targets;
  if (equip === 'super') {
    targets = standUncut;
  } else {
    const ids = Array.isArray(move.tileIds) ? move.tileIds : [];
    targets = ids.map((id) => tileById(G, id)).filter(Boolean);
    if (new Set(targets.map((t) => t.id)).size !== targets.length) return { ok: false, error: 'Duplicate wires' };
    for (const t of targets) {
      if (!stand.tiles.includes(t)) return { ok: false, error: 'Those wires are not in one stand' };
      if (t.cut || t.revealed) return { ok: false, error: 'That wire is already cut' };
    }
  }

  // shape + equipment checks
  const need = (n, msg) => (targets.length === n ? null : { ok: false, error: msg });
  let eqCard = null;
  if (equip === 'char') {
    if (p.usedChar) return { ok: false, error: 'Your Double Detector is spent for this mission' };
    if (values.length !== 1 || values[0] === 'yellow') return { ok: false, error: 'The Double Detector calls one value from 1 to 12' };
    const bad = need(2, 'Point at exactly 2 wires in one stand');
    if (bad) return bad;
  } else if (equip === 'triple' || equip === 'super' || equip === 'xy') {
    eqCard = G.equipment.find((e) => e.key === equip);
    if (!eqCard || !eqCard.unlocked || eqCard.used) return { ok: false, error: 'That equipment is not available' };
    if (equip === 'triple') {
      if (values.length !== 1 || values[0] === 'yellow') return { ok: false, error: 'The Triple Detector calls one value from 1 to 12' };
      const want = Math.min(3, standUncut.length);
      if (want < 2) return { ok: false, error: 'That stand is down to one wire — use a plain cut' };
      if (targets.length !== want) return { ok: false, error: `Point at ${want} wires in one stand` };
    } else if (equip === 'super') {
      if (values.length !== 1 || values[0] === 'yellow') return { ok: false, error: 'The Super Detector calls one value from 1 to 12' };
      if (!targets.length) return { ok: false, error: 'That stand is empty' };
    } else {
      if (values.length !== 2 || values[0] === values[1] || values.includes('yellow')) {
        return { ok: false, error: 'The X or Y Ray calls two different values from 1 to 12' };
      }
      const bad = need(1, 'Point at exactly 1 wire');
      if (bad) return bad;
    }
  } else {
    if (values.length !== 1) return { ok: false, error: 'Call exactly one value' };
    const bad = need(1, 'Point at exactly 1 wire');
    if (bad) return bad;
  }

  // you must hold every value you announce
  const ownPick = move.ownPick && typeof move.ownPick === 'object' ? move.ownPick : {};
  for (const v of values) {
    if (!ownMatches(G, p.seat, v).length) return { ok: false, error: `You need a ${valueLabel(v)} in your own hand to call it` };
  }

  // burn one-shot cards now — a detector is spent whether or not it finds anything
  if (equip === 'char') p.usedChar = true;
  if (eqCard) eqCard.used = true;

  // calling a value proves you hold it — that is public deduction fodder
  for (const v of values) recordCall(G, p.seat, v);

  const owner = playerBySeat(G, stand.owner);
  const how =
    equip === 'char' ? ' [Double Detector]'
    : equip === 'triple' ? ' [Triple Detector]'
    : equip === 'super' ? ' [Super Detector]'
    : equip === 'xy' ? ' [X or Y Ray]'
    : '';
  const called = values.map(valueLabel).join(' or ');

  const matches = targets.filter((t) => tileMatchesValues(t, values));
  if (matches.length > 0) {
    {
      // when more than one pointed wire matches, the owner picks which one is
      // cut (it shapes what the table learns about the neighbours)
      if (matches.length > 1 && !owner.bot) {
        // the stand's owner picks which matching wire is cut. Spectators only
        // ever see the POINTED set — how many of them matched stays secret,
        // exactly like at the table.
        G.pending = {
          type: 'chooseCut',
          seat: owner.seat,
          standId: stand.id,
          pointedIds: targets.map((t) => t.id),
          validIds: matches.map((m) => m.id),
          ctx: { actor: p.seat, values, ownPick, how, called },
        };
        addLog(G, `${p.name} points at ${targets.length} of ${owner.name}’s wires calling ${called}${how} — a hit! ${owner.name} cuts one of them.`);
        return { ok: true };
      }
      resolveCutSuccess(G, p, owner, stand, matches[0], values, ownPick, how, called, targets.length);
      finishAction(G);
      return { ok: true };
    }
  }

  // ---- failure ----------------------------------------------------------
  const reds = targets.filter((t) => t.kind === 'red');
  if (reds.length === targets.length) {
    // every pointed wire is red — that is the bomb, unless the Stabilizator eats it
    if (tryStabilize(G)) {
      for (const t of reds) t.knownRed = true;
      addLog(G, `${p.name} points at ${owner.name}’s ${posLabel(G, stand, reds[0])}${how} — it is RED! The Stabilizator absorbs the blast.`);
      p.lastAction = `hit a RED wire — saved by the Stabilizator`;
      setFx(G, { kind: 'save' });
      finishAction(G);
      return { ok: true };
    }
    explode(G, 'red', reds[0]);
    addLog(G, `${p.name} cut ${owner.name}’s ${posLabel(G, stand, reds[0])} calling ${called}${how}.`);
    p.lastAction = 'cut a RED wire';
    return { ok: true };
  }

  if (targets.length === 1) {
    addLog(G, `${p.name} calls ${called} on ${owner.name}’s ${posLabel(G, stand, targets[0])}${how} — wrong. The detonator ticks.`);
  } else {
    addLog(G, `${p.name} calls ${called} on ${targets.length} of ${owner.name}’s wires${how} — all wrong. The detonator ticks.`);
  }
  const alive = advanceDial(G);
  for (const t of targets) {
    for (const v of values) G.negative.push({ tileId: t.id, v });
  }
  if (G.negative.length > 300) G.negative.splice(0, G.negative.length - 300);
  p.lastAction = `called ${called} on ${owner.name}’s wire${targets.length > 1 ? 's' : ''} — wrong`;
  if (!alive) return { ok: true };

  const eligible = targets.filter((t) => t.kind !== 'red');
  if (eligible.length === 1 || owner.bot) {
    const pick = eligible.length === 1 ? eligible[0] : botPickToken(G, owner.seat, eligible);
    placeToken(G, p, owner, stand, pick);
    finishAction(G);
    return { ok: true };
  }
  G.pending = {
    type: 'chooseToken',
    seat: owner.seat,
    standId: stand.id,
    pointedIds: targets.map((t) => t.id),
    validIds: eligible.map((t) => t.id),
    ctx: { actor: p.seat, how, called },
  };
  addLog(G, `${owner.name} picks which of the pointed wires gets the Info token.`);
  return { ok: true };
}

function resolveCutSuccess(G, p, owner, stand, cutT, values, ownPick, how, called, pointedCount) {
  const matchedValue = cutT.kind === 'yellow' ? 'yellow' : cutT.v;
  cutTile(G, cutT);
  // the active player cuts their own copy of the matched value
  const mine = ownMatches(G, p.seat, matchedValue);
  let own = null;
  const pickId = ownPick ? ownPick[String(matchedValue)] : null;
  if (pickId != null) own = mine.find((t) => t.id === pickId) || null;
  if (!own) own = mine[0];
  cutTile(G, own);
  const ownStand = G.stands.find((s) => s.tiles.includes(own));
  const lbl = valueLabel(matchedValue);
  addLog(
    G,
    `${p.name} ${pointedCount > 1 ? `points at ${pointedCount} wires and ` : ''}cuts ${owner.name}’s ${posLabel(G, stand, cutT)}${how} — a ${lbl}! Their own ${lbl} goes too.`,
  );
  p.lastAction = `cut a ${lbl} with ${owner.name}`;
  setFx(G, { kind: 'cut', tiles: [cutT.id, own.id], standIds: [stand.id, ownStand.id] });
}

function placeToken(G, p, owner, stand, t) {
  t.token = t.kind === 'yellow' ? 'yellow' : t.v;
  const real = t.kind === 'yellow' ? 'YELLOW' : `a ${t.v}`;
  addLog(G, `${owner.name}’s ${posLabel(G, stand, t)} is marked with an Info token: it is really ${real}.`);
  setFx(G, { kind: 'fail', tiles: [t.id] });
}

function botPickToken(G, seat, eligible) {
  // prefer marking a wire that sits right next to a red — the mark then
  // fences the red in for the whole team
  const stand = G.stands.find((s) => eligible.some((t) => s.tiles.includes(t)));
  for (const t of eligible) {
    const i = stand.tiles.indexOf(t);
    const near = [stand.tiles[i - 1], stand.tiles[i + 1]];
    if (near.some((q) => q && q.kind === 'red' && !q.revealed)) return t;
  }
  return eligible[0];
}

function doChoose(G, p, move) {
  const pend = G.pending;
  if (!pend || pend.seat !== p.seat) return { ok: false, error: 'Nothing for you to choose' };
  const t = tileById(G, move.tileId);
  if (!t || !pend.validIds.includes(t.id)) {
    return { ok: false, error: pend.type === 'chooseCut' ? 'Cut one of the pointed wires that really matches' : 'The Info token cannot go on a red wire' };
  }
  const stand = standById(G, pend.standId);
  const actor = playerBySeat(G, pend.ctx.actor);
  G.pending = null;
  if (pend.type === 'chooseCut') {
    resolveCutSuccess(G, actor, p, stand, t, pend.ctx.values, pend.ctx.ownPick, pend.ctx.how, pend.ctx.called, pend.pointedIds.length);
  } else {
    placeToken(G, actor, p, stand, t);
  }
  finishAction(G);
  return { ok: true };
}

function doSolo(G, p, move) {
  if (G.turn !== p.seat) return { ok: false, error: 'Not your turn' };
  const v = move.value;
  const mine = ownMatches(G, p.seat, v);
  if (v === 'yellow') {
    const remaining = G.yellowTotal - G.yellowCut;
    if (!mine.length || mine.length !== remaining) {
      return { ok: false, error: 'Solo cut needs ALL remaining yellow wires in your own hand' };
    }
  } else if (Number.isInteger(v) && v >= 1 && v <= 12) {
    const remaining = 4 - G.cutCount[v];
    if (!mine.length || mine.length !== remaining || (remaining !== 2 && remaining !== 4)) {
      return { ok: false, error: 'Solo cut: the last 2 (or all 4) copies must all be in your hand' };
    }
  } else {
    return { ok: false, error: 'Pick a value to solo cut' };
  }
  for (const t of mine) cutTile(G, t);
  const lbl = valueLabel(v);
  addLog(G, `${p.name} solo cuts ${mine.length === 4 ? 'all four' : `the last ${mine.length === 1 ? '' : mine.length + ' '}`.trimEnd()} ${lbl}${mine.length > 1 ? 's' : ''} from their own hand.`);
  p.lastAction = `solo cut ${mine.length} × ${lbl}`;
  setFx(G, { kind: 'cut', tiles: mine.map((t) => t.id), standIds: p.standIds });
  finishAction(G);
  return { ok: true };
}

function doReveal(G, p, move) {
  if (G.turn !== p.seat) return { ok: false, error: 'Not your turn' };
  const mine = hiddenTiles(G, p.seat);
  if (!mine.length || mine.some((t) => t.kind !== 'red')) {
    return { ok: false, error: 'You can only reveal when reds are ALL you have left' };
  }
  for (const t of mine) t.revealed = true;
  addLog(G, `${p.name} reveals their last wire${mine.length > 1 ? 's' : ''}: ${mine.length === 1 ? 'it is' : 'all'} RED — left safely uncut.`);
  p.lastAction = 'revealed their red wires';
  setFx(G, { kind: 'reveal', tiles: mine.map((t) => t.id) });
  finishAction(G);
  return { ok: true };
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
  addLog(G, `${p.name} disconnected — the squad covers for them.`);
  return true;
}

// ---------------------------------------------------------------- views

function tileView(G, t, mine, over) {
  const out = { id: t.id };
  if (t.cut || t.revealed || over) {
    out.kind = t.kind;
    out.v = t.kind === 'blue' ? t.v : svBase(t.sv);
    out.cut = t.cut;
    out.revealed = t.revealed;
  }
  if (t.token != null) out.token = t.token;
  if (t.knownRed) out.knownRed = true;
  if (mine && !out.kind) {
    out.kind = t.kind;
    out.v = t.kind === 'blue' ? t.v : svBase(t.sv);
  }
  return out;
}

export function viewFor(G, seat, code) {
  const over = G.phase === 'won' || G.phase === 'lost';
  const mission = missionByKey(G.mission);
  return {
    t: 'state',
    code,
    you: seat,
    mid: G.mid,
    phase: G.phase,
    mission: { key: mission.key, name: mission.name, red: G.redTotal, yellow: G.yellowTotal },
    captain: G.captain,
    turn: G.turn,
    setupTurn: G.phase === 'setup' ? G.setupQueue[G.setupIdx] : null,
    dial: { pos: G.dial, size: G.dialSize },
    boardRed: G.boardRed,
    boardYellow: G.boardYellow,
    cutCount: G.cutCount,
    yellowCut: G.yellowCut,
    equipment: G.equipment.map((e) => ({ ...e })),
    radar: G.radar,
    pending: G.pending
      ? {
          type: G.pending.type,
          seat: G.pending.seat,
          standId: G.pending.standId,
          tileIds: G.pending.pointedIds,
          called: G.pending.ctx.called,
        }
      : null,
    players: G.players.map((p) => ({
      seat: p.seat,
      name: p.name,
      bot: p.bot,
      connected: p.connected,
      standIds: p.standIds,
      usedChar: p.usedChar,
      lastAction: p.lastAction,
      tilesLeft: hiddenTiles(G, p.seat).length,
    })),
    stands: G.stands.map((s) => ({
      id: s.id,
      owner: s.owner,
      label: s.label,
      tiles: s.tiles.map((t) => tileView(G, t, s.owner === seat, over)),
    })),
    log: G.log.slice(-60),
    fx: G.fx,
    result: G.result,
    stats: { ...G.stats },
  };
}

// ---------------------------------------------------------------- bot brain
//
// Bots reason exactly like a (good) human player: from public information
// plus their own rack. `sampleWorlds` draws random completions of all hidden
// wires that are consistent with everything publicly known — sorted stands,
// cut wires (which keep their position), Info tokens, the red/yellow values
// on the board, radar answers — and the bot's own tiles. Move quality is then
// just counting worlds.

function knowledgeFor(G, seat) {
  const yellowSvs = G.boardYellow.map((y) => y.v * 10 + 1);
  const redCandSvs = G.boardRed.map((r) => r.v * 10 + 5);
  const stands = G.stands.map((s) => ({
    id: s.id,
    owner: s.owner,
    slots: s.tiles.map((t) => {
      const mine = s.owner === seat;
      if (t.cut || t.revealed || mine) return { id: t.id, sv: t.sv, done: t.cut || t.revealed };
      if (t.token != null && t.token !== 'yellow') return { id: t.id, sv: t.token * 10, done: false };
      if (t.token === 'yellow') return { id: t.id, dom: 'yellow', done: false };
      if (t.knownRed) return { id: t.id, dom: 'red', done: false };
      return { id: t.id, done: false };
    }),
  }));
  const calls = [];
  for (const c of G.calls) {
    if (c.seat === seat) continue; // I know my own hand
    if (cutsOfValueIn(G, c.seat, c.v) !== c.cuts) continue; // a copy left their hand since
    if (!calls.some((q) => q.seat === c.seat && q.v === c.v)) calls.push({ seat: c.seat, v: c.v });
  }
  const negative = G.negative.filter((f) => {
    const t = G.tilesById[f.tileId];
    return t && !t.cut && !t.revealed && t.token == null;
  });
  const radar = G.radar.map((fact) => ({
    v: fact.v,
    answers: fact.answers.filter(
      (a) => a.seat !== seat && (!a.has || cutsOfValueIn(G, a.seat, fact.v) === a.cuts),
    ),
  }));
  return { stands, yellowSvs, redCandSvs, redTotal: G.redTotal, radar, calls, negative, me: seat };
}

function lowerBound(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function sampleOne(K, edf = false) {
  // pick which red candidates are really in play this world
  const reds = shuffle(K.redCandSvs.slice()).slice(0, K.redTotal);

  // pool = full multiset minus every exactly-known tile
  const pool = [];
  for (let v = 1; v <= 12; v++) for (let c = 0; c < 4; c++) pool.push(v * 10);
  for (const sv of K.yellowSvs) pool.push(sv);
  for (const sv of reds) pool.push(sv);
  const world = new Map();
  for (const s of K.stands) {
    for (const slot of s.slots) {
      if (slot.sv != null) {
        const i = pool.indexOf(slot.sv);
        if (i < 0) return null; // world contradicts a known tile (wrong red subset)
        pool.splice(i, 1);
        world.set(slot.id, slot.sv);
      }
    }
  }

  // unknown slots become gaps between known anchors: each gap needs `need`
  // values inside [lo, hi]; kind-restricted slots are pre-assigned first
  const gaps = [];
  for (const s of K.stands) {
    let i = 0;
    while (i < s.slots.length) {
      if (s.slots[i].sv != null) {
        i += 1;
        continue;
      }
      const start = i;
      while (i < s.slots.length && s.slots[i].sv == null) i += 1;
      const lo = start === 0 ? 0 : s.slots[start - 1].sv;
      const hi = i === s.slots.length ? 999 : s.slots[i].sv;
      gaps.push({ lo, hi, slots: s.slots.slice(start, i), vals: [] });
    }
  }

  // kind-restricted slots (yellow token / known red) grab a matching sv first
  for (const g of gaps) {
    for (const slot of g.slots) {
      if (!slot.dom) continue;
      const options = pool.filter((sv) => svKind(sv) === slot.dom && sv >= g.lo && sv <= g.hi);
      if (!options.length) return null;
      const sv = options[Math.floor(Math.random() * options.length)];
      pool.splice(pool.indexOf(sv), 1);
      world.set(slot.id, sv);
      slot.tmp = sv;
    }
  }
  // a restricted slot splits its gap around the value it took
  const finalGaps = [];
  for (const g of gaps) {
    let lo = g.lo;
    let run = [];
    for (const slot of g.slots) {
      if (slot.tmp != null) {
        if (run.length) finalGaps.push({ lo, hi: slot.tmp, need: run.length, slots: run });
        lo = slot.tmp;
        run = [];
        delete slot.tmp;
      } else {
        run.push(slot);
      }
    }
    if (run.length) finalGaps.push({ lo, hi: g.hi, need: run.length, slots: run });
  }

  // deal the pool into the gaps, smallest values first; a random eligible gap
  // takes each value, with a forced pick when a gap is about to starve
  pool.sort((a, b) => a - b);
  const open = finalGaps.filter((g) => g.need > 0);
  if (open.reduce((n, g) => n + g.need, 0) !== pool.length) return null;
  // the pool is sorted, so each gap's candidates are one contiguous index run
  for (const g of open) {
    g.got = [];
    g.L = lowerBound(pool, g.lo);
    g.R = upperBound(pool, g.hi);
  }
  for (let idx = 0; idx < pool.length; idx++) {
    const sv = pool[idx];
    let pick = null;
    const eligible = [];
    for (const g of open) {
      const needLeft = g.need - g.got.length;
      if (!needLeft) continue;
      const remaining = g.R - Math.max(g.L, idx); // candidates still ahead of us
      if (remaining < needLeft) return null; // dead end — retry the sample
      const fits = idx >= g.L && idx < g.R;
      if (fits) {
        eligible.push(g);
        if (remaining === needLeft) pick = g; // must take every remaining candidate
      }
    }
    if (!pick) {
      if (!eligible.length) return null;
      if (edf) {
        // earliest deadline first: complete whenever completion is possible
        pick = eligible.reduce((a, b) => (b.R < a.R ? b : a));
      } else {
        pick = eligible[Math.floor(Math.random() * eligible.length)];
      }
    }
    pick.got.push(sv);
  }
  for (const g of open) {
    if (g.got.length !== g.need) return null;
    g.slots.forEach((slot, i) => world.set(slot.id, g.got[i]));
  }

  // a pointed-and-missed wire is not the value that was called
  for (const f of K.negative) {
    const sv = world.get(f.tileId);
    if (sv == null) continue;
    if (f.v === 'yellow' ? svKind(sv) === 'yellow' : sv === f.v * 10) return null;
  }
  // whoever calls a value holds it (until a copy visibly leaves their hand)
  for (const c of K.calls) {
    let has = false;
    for (const s of K.stands) {
      if (s.owner !== c.seat) continue;
      for (const slot of s.slots) {
        if (slot.done) continue;
        const sv = world.get(slot.id);
        if (c.v === 'yellow' ? svKind(sv) === 'yellow' : sv === c.v * 10) has = true;
      }
    }
    if (!has) return null;
  }
  // radar facts: "seat has (no) uncut blue v" must hold in this world
  for (const fact of K.radar) {
    for (const a of fact.answers) {
      let has = false;
      for (const s of K.stands) {
        if (s.owner !== a.seat) continue;
        for (const slot of s.slots) {
          if (slot.done) continue;
          if (world.get(slot.id) === fact.v * 10) has = true;
        }
      }
      if (has !== a.has) return null;
    }
  }
  return world;
}

export function sampleWorlds(G, seat, n = 120) {
  const K = knowledgeFor(G, seat);
  const worlds = [];
  let tries = 0;
  while (worlds.length < n && tries < n * 30) {
    tries += 1;
    // every 7th attempt runs deadline-first, which cannot dead-end when a
    // consistent completion exists — so tight endgames still yield worlds
    const w = sampleOne(K, tries % 7 === 0);
    if (w) worlds.push(w);
  }
  return worlds;
}

function soloOptions(G, seat) {
  const opts = [];
  const mine = hiddenTiles(G, seat);
  const byV = {};
  for (const t of mine) {
    if (t.kind === 'blue') byV[t.v] = (byV[t.v] || 0) + 1;
  }
  for (const v of Object.keys(byV).map(Number)) {
    const remaining = 4 - G.cutCount[v];
    if (byV[v] === remaining && (remaining === 2 || remaining === 4)) opts.push(v);
  }
  const yellows = mine.filter((t) => t.kind === 'yellow').length;
  if (yellows > 0 && yellows === G.yellowTotal - G.yellowCut) opts.push('yellow');
  return opts;
}

export { soloOptions };

export function botChoose(G, seat) {
  const p = playerBySeat(G, seat);
  if (!p) return null;

  if (G.phase === 'setup') return botMark(G, seat);

  if (G.pending && G.pending.seat === seat) {
    const tiles = G.pending.validIds.map((id) => tileById(G, id));
    let pick = tiles[0];
    if (G.pending.type === 'chooseToken') pick = botPickToken(G, seat, tiles);
    return { kind: 'choose', tileId: pick.id };
  }

  if (G.turn !== seat) return null;

  const solos = soloOptions(G, seat);
  const mine = hiddenTiles(G, seat);
  if (mine.length && mine.every((t) => t.kind === 'red')) return { kind: 'reveal' };

  const worlds = sampleWorlds(G, seat, 320);
  if (!worlds.length) {
    if (solos.length) return { kind: 'solo', value: solos[0] };
    // sampling starved — fall back to reading the public board directly:
    // a tokened wire whose value we hold is still a guaranteed cut
    for (const s of G.stands) {
      if (s.owner === seat) continue;
      for (const t of s.tiles) {
        if (t.cut || t.revealed || t.token == null) continue;
        if (ownMatches(G, seat, t.token).length) {
          return { kind: 'cut', standId: s.id, tileIds: [t.id], values: [t.token] };
        }
      }
    }
    const t = firstForeignTile(G, seat);
    const held = mine.find((q) => q.kind !== 'red');
    if (t && held) {
      return { kind: 'cut', standId: t.standId, tileIds: [t.id], values: [held.kind === 'yellow' ? 'yellow' : held.v] };
    }
    return { kind: 'reveal' };
  }

  const myValues = [];
  for (const t of mine) {
    const v = t.kind === 'blue' ? t.v : t.kind === 'yellow' ? 'yellow' : null;
    if (v != null && !myValues.includes(v)) myValues.push(v);
  }

  // per-tile stats over the sampled worlds
  const foreign = [];
  for (const s of G.stands) {
    if (s.owner === seat) continue;
    for (const t of s.tiles) {
      if (t.cut || t.revealed) continue;
      foreign.push({ stand: s, t });
    }
  }
  const stat = new Map();
  for (const f of foreign) {
    const counts = new Map();
    let red = 0;
    for (const w of worlds) {
      const sv = w.get(f.t.id);
      counts.set(sv, (counts.get(sv) || 0) + 1);
      if (svKind(sv) === 'red') red += 1;
    }
    stat.set(f.t.id, { counts, red: red / worlds.length });
  }
  const pOf = (tileId, value) => {
    const st = stat.get(tileId);
    if (!st) return 0;
    let hit = 0;
    for (const [sv, c] of st.counts) {
      if (value === 'yellow' ? svKind(sv) === 'yellow' : sv === value * 10) hit += c;
    }
    return hit / worlds.length;
  };

  // single-wire candidates
  let best = null;
  for (const f of foreign) {
    for (const v of myValues) {
      const P = pOf(f.t.id, v);
      if (P <= 0) continue;
      const red = stat.get(f.t.id).red;
      const cand = { kind: 'cut', standId: f.stand.id, tileIds: [f.t.id], values: [v], P, red };
      if (!best || better(cand, best)) best = cand;
    }
  }

  // a certain plain cut is the best possible turn; otherwise a solo cut is a
  // guaranteed-safe one — bank it before risking anything uncertain
  if (best && best.P >= 0.999 && best.red === 0) return finalizeCut(G, seat, best);
  if (solos.length) return { kind: 'solo', value: solos[0] };

  // detectors widen the net when nothing is certain
  const dialLeft = G.dialSize - G.dial;
  const wantHelp = !best || best.P < 0.9 || best.red > 0;
  if (wantHelp) {
    const options = [];
    if (!p.usedChar) options.push({ equip: 'char', n: 2 });
    const trip = G.equipment.find((e) => e.key === 'triple' && e.unlocked && !e.used);
    if (trip) options.push({ equip: 'triple', n: 3 });
    for (const opt of options) {
      for (const s of G.stands) {
        if (s.owner === seat) continue;
        const uncut = uncutOfStand(s);
        const n = opt.equip === 'triple' ? Math.min(3, uncut.length) : 2;
        if (uncut.length < n || n < 2) continue;
        for (const v of myValues) {
          if (v === 'yellow') continue;
          // greedy: the n tiles with the best individual odds for v
          const ranked = uncut
            .map((t) => ({ t, p: pOf(t.id, v), red: stat.get(t.id).red }))
            .sort((a, b) => b.p - a.p)
            .slice(0, n);
          if (ranked.some((r) => r.p <= 0)) continue;
          let hit = 0;
          let allRed = 0;
          for (const w of worlds) {
            const svs = ranked.map((r) => w.get(r.t.id));
            if (svs.some((sv) => sv === v * 10)) hit += 1;
            if (svs.every((sv) => svKind(sv) === 'red')) allRed += 1;
          }
          const cand = {
            kind: 'cut',
            standId: s.id,
            tileIds: ranked.map((r) => r.t.id),
            values: [v],
            equip: opt.equip,
            P: hit / worlds.length,
            red: allRed / worlds.length,
          };
          if (!best || better(cand, best)) best = cand;
        }
      }
    }
    const xy = G.equipment.find((e) => e.key === 'xy' && e.unlocked && !e.used);
    const blues = myValues.filter((v) => v !== 'yellow');
    if (xy && blues.length >= 2) {
      for (const f of foreign) {
        for (let a = 0; a < blues.length; a++) {
          for (let b = a + 1; b < blues.length; b++) {
            const P = pOf(f.t.id, blues[a]) + pOf(f.t.id, blues[b]);
            if (P <= 0) continue;
            const cand = {
              kind: 'cut',
              standId: f.stand.id,
              tileIds: [f.t.id],
              values: [blues[a], blues[b]],
              equip: 'xy',
              P,
              red: stat.get(f.t.id).red,
            };
            if (!best || better(cand, best)) best = cand;
          }
        }
      }
    }
  }

  // radar is free and does not use the turn — sweep before a shaky cut
  const radar = G.equipment.find((e) => e.key === 'radar' && e.unlocked && !e.used);
  if (radar && (!best || best.P < 0.8)) {
    const v = bestRadarValue(G, seat, myValues, stat, foreign, worlds);
    if (v) return { kind: 'radar', value: v };
  }

  if (best && (best.red < 0.02 || dialLeft <= 1)) return finalizeCut(G, seat, best);

  // nothing safe: burn a detonator tick on a wire we KNOW is not the value —
  // an intentional miss is legal and never hits a red we know about
  if (best && best.red >= 0.02 && dialLeft >= 2) {
    const safe = foreign.filter((f) => stat.get(f.t.id).red === 0);
    if (safe.length) {
      let bluff = null;
      for (const f of safe) {
        for (const v of myValues) {
          const P = pOf(f.t.id, v);
          if (!bluff || P > bluff.P) bluff = { kind: 'cut', standId: f.stand.id, tileIds: [f.t.id], values: [v], P, red: 0 };
        }
      }
      if (bluff && bluff.P > 0.05) return finalizeCut(G, seat, bluff);
    }
  }
  if (best) return finalizeCut(G, seat, best);

  // no candidates at all (no teammate tiles?) — solo/reveal fallback
  const t = firstForeignTile(G, seat);
  if (t) {
    const v = myValues[0];
    return finalizeCut(G, seat, { kind: 'cut', standId: t.standId, tileIds: [t.id], values: [v == null ? 1 : v] });
  }
  return { kind: 'reveal' };
}

function better(a, b) {
  // avoid the bomb above all, then take the likeliest cut
  const ra = a.red >= 0.02 ? 1 : 0;
  const rb = b.red >= 0.02 ? 1 : 0;
  if (ra !== rb) return ra < rb;
  if (Math.abs(a.P - b.P) > 0.001) return a.P > b.P;
  return a.red < b.red;
}

function finalizeCut(G, seat, cand) {
  const move = { kind: 'cut', standId: cand.standId, tileIds: cand.tileIds, values: cand.values };
  if (cand.equip) move.equip = cand.equip;
  return move;
}

function firstForeignTile(G, seat) {
  for (const s of G.stands) {
    if (s.owner === seat) continue;
    for (const t of s.tiles) if (!t.cut && !t.revealed) return { id: t.id, standId: s.id };
  }
  return null;
}

function bestRadarValue(G, seat, myValues, stat, foreign, worlds) {
  // ask about the value whose location is most uncertain among our candidates
  let bestV = null;
  let bestH = 0.12; // only bother when meaningfully uncertain
  for (const v of myValues) {
    if (v === 'yellow') continue;
    if (4 - G.cutCount[v] <= ownMatches(G, seat, v).length) continue; // all copies are mine
    let h = 0;
    for (const f of foreign) {
      const P = (() => {
        const st = stat.get(f.t.id);
        let hit = 0;
        for (const [sv, c] of st.counts) if (sv === v * 10) hit += c;
        return hit / worlds.length;
      })();
      if (P > 0.05 && P < 0.95) h += P * (1 - P);
    }
    if (h > bestH) {
      bestH = h;
      bestV = v;
    }
  }
  return bestV;
}

function botMark(G, seat) {
  const mine = [];
  for (const s of G.stands) {
    if (s.owner !== seat) continue;
    s.tiles.forEach((t, i) => mine.push({ s, t, i }));
  }
  const blues = mine.filter((m) => m.t.kind === 'blue');
  // a red in hand: mark the blue right next to it, fencing it in for the team
  for (const m of mine) {
    if (m.t.kind !== 'red') continue;
    const near = mine.filter((q) => q.s === m.s && Math.abs(q.i - m.i) === 1 && q.t.kind === 'blue');
    if (near.length) return { kind: 'mark', tileId: near[near.length - 1].t.id };
  }
  // otherwise mark the middle of the longest same-stand stretch
  const pick = blues[Math.floor(blues.length / 2)] || blues[0];
  return { kind: 'mark', tileId: pick.t.id };
}
