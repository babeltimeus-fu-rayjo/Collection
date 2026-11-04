// cards.js — every card in the Space Base box: the twelve starting ships each
// commodore begins with, the 48 + 48 + 36 ships of the shipyard and the twelve
// colonies.
//
// Where it comes from:
//   - Names, serials and classes: the card list on pages 30–31 of AEG's Field
//     Manual (2018, uploaded 2020).
//   - Costs, sectors and rewards: Board Game Arena's licensed Space Base, as a
//     Japanese guide to it lists and pictures all 144 cards (kuribodo.com,
//     "スペースベース（BGA）"). Every card's picture was checked against the list.
//   - Charge squares — how many, which are linked, and the pips that say at
//     which table sizes a square counts — are the Field Manual's own pictures
//     of the cards (pages 21–27) wherever it pictures one, and otherwise the
//     guide's pictures, where Board Game Arena's name banner covers part of a
//     card's top half.
//   - The starting ships: the Field Manual's picture of one player's set
//     (page 14). The box has five sets of the same twelve ships under other
//     names; every console here carries that one set.
//
// Where the sources disagree or fall short:
//   - Kovalyonok 8127-H: the Field Manual lists a "U.E.S. … Roddenbury Class
//     Hypernet Gate", but the card shows a P.S.S. Modified Merritt Class Cargo
//     Tug, drawn as one; the card is followed.
//   - Volynov 3509-A: the guide says its deployed reroll costs 2 cubes, but
//     the Field Manual's picture shows two squares with no link between them —
//     a reserve of two, one spent a reroll — which is followed.
//   - Glenn 1817-C: its station squares sit under the name banner in the only
//     picture there is. Two linked squares, like its deployed side and as the
//     guide's text has it — PROVISIONAL.
//   - The colonies' small settlements are "Serling" in the Field Manual and
//     "Sterling" in the guide; the Field Manual is followed.
//
// A side of a card (`st` stationed, `dp` deployed) has:
//   r   its reward: { cr, inc, vp } (credits, income, victory points), arrow
//       ('L' or 'R' — the sector next door; 'LR' — the player picks one), and
//       claim { level: n } (take up to n cards of that level for free)
//   sq  its charge squares, if any — then its reward also places a cube:
//       { n, linked, pips } where pips lists, square by square, the table sizes
//       a square counts at ([] = always)
//   ab  the ability those cubes pay for: { color, kind, ... } — blue on your
//       own turn, red on the others', green on anyone's

const side = (r = {}, sq = null, ab = null) => ({ r, sq, ab });
const cr = (n) => ({ cr: n });
const vp = (n) => ({ vp: n });
const one = { n: 1, linked: false, pips: [[]] };
const loose = (n) => ({ n, linked: false, pips: Array.from({ length: n }, () => []) });
const linked = (...pips) => ({ n: pips.length, linked: true, pips });

// the twelve every console starts with — the Field Manual's pictured set
export const STARTING = [
  { name: 'U.E.S. McCandless II 3195-D', cls: 'Knight Class Cargo Vessel', sector: 1, st: side(cr(1)), dp: side(cr(1)) },
  { name: 'U.E.S. McNair 1232-H', cls: 'Knight Class Cargo Vessel', sector: 2, st: side(cr(1)), dp: side(cr(1)) },
  { name: 'U.E.S. Stewart 7936-F', cls: 'Knight Class Cargo Vessel', sector: 3, st: side(cr(1)), dp: side(cr(1)) },
  { name: 'U.E.S. Solovyov 2463-H', cls: 'Knight Class Cargo Vessel', sector: 4, st: side(cr(1)), dp: side(cr(1)) },
  { name: 'U.E.S. Atkov 1044-E', cls: 'Knight Class Cargo Vessel', sector: 5, st: side(cr(1)), dp: side(cr(1)) },
  { name: 'U.E.S. Sharma 7947-G', cls: 'Knight Class Cargo Vessel', sector: 6, st: side(cr(1)), dp: side(cr(1)) },
  { name: 'U.E.S. Scobee 9566-B', cls: 'Knight Class Cargo Vessel', sector: 7, st: side(cr(3)), dp: side(cr(2)) },
  { name: 'U.E.S. Nelson 7775-B', cls: 'Knight Class Cargo Vessel', sector: 8, st: side(cr(3)), dp: side(cr(2)) },
  { name: 'U.E.S. van Hoften 5906-B', cls: 'Scott Class Mining Vessel', sector: 9, st: side({ inc: 1 }), dp: side(cr(3)) },
  { name: 'U.E.S. Hart 2790-D', cls: 'Scott Class Mining Vessel', sector: 10, st: side({ inc: 1 }), dp: side(cr(3)) },
  { name: 'U.E.S. Volk 9084-B', cls: 'Scott Class Mining Vessel', sector: 11, st: side({ inc: 1 }), dp: side(cr(4)) },
  { name: 'U.E.S. Spring 3973-E', cls: 'Scott Class Mining Vessel', sector: 12, st: side({ inc: 1 }), dp: side(cr(5)) },
];

const paul = (name, cost, sector, s, d) => ({ name: `U.E.S. ${name}`, cls: 'Paul Class Cargo Vessel', cost, sector, st: side(cr(s)), dp: side(cr(d)) });
const williamson = (name, sector) => ({
  name: `U.E.S. ${name}`, cls: 'Williamson Class Command Ship', cost: 4, sector,
  st: side({}, one, { color: 'green', kind: 'shift', by: [1] }),
  dp: side({}, linked([], []), { color: 'green', kind: 'shift', by: [1] }),
});
const wells = (name, sector) => ({ name: `U.E.S. ${name}`, cls: 'Wells Class Star Cruiser', cost: 5, sector, st: side({ arrow: 'LR' }), dp: side({ arrow: 'LR' }) });
const bradbury = (name, cost, sector, s, d) => ({ name: `U.E.S. ${name}`, cls: 'Bradbury Class Carrier', cost, sector, st: side(vp(s)), dp: side(vp(d)) });
const tolkien = (name, cost, sector, st, dp) => ({ name: `U.E.S. ${name}`, cls: 'Tolkien Class Cargo Carrier', cost, sector, st: side(st), dp: side(dp) });
const herbert = (name, sector, s, d) => ({ name: `U.E.S. ${name}`, cls: 'Herbert Class Mining Vessel', cost: 3, sector, st: side(s), dp: side(d) });

export const LEVEL1 = [
  { name: 'U.E.S. Merbold 6865-D', cls: 'Gunn Class Cargo Cruiser', cost: 4, sector: 7, st: side({ cr: 1, arrow: 'R' }), dp: side({ cr: 1, arrow: 'R' }) },
  paul('Ryumin 4713-C', 3, 1, 2, 1),
  paul('Romanenko 8599-H', 3, 2, 2, 1),
  paul('Chang-Diaz 3555-H', 3, 3, 2, 1),
  paul('Dzhanibekov 1999-G', 3, 4, 2, 1),
  paul('Remek 8252-H', 4, 5, 2, 1),
  paul('Ivanchenkov 2754-H', 4, 6, 2, 1),
  paul('Gürragchaa 3972-D', 2, 1, 1, 1),
  paul('Crippen 7733-C', 2, 2, 1, 1),
  paul('Prunariu 7750-G', 2, 3, 1, 1),
  paul('Engle 1913-A', 2, 4, 1, 1),
  paul('Truly 9239-H', 3, 5, 1, 1),
  paul('Fullerton 2005-A', 3, 6, 1, 1),
  paul('Brergovoy 9890-C', 2, 7, 4, 3),
  paul('Chrétien 3182-C', 2, 8, 5, 3),
  paul('Hartsfield 5562-G', 2, 9, 6, 4),
  paul('Serebrov 1243-G', 2, 10, 7, 5),
  paul('Savitskaya 6659-G', 2, 11, 8, 6),
  paul('Overmyer 3792-A', 2, 12, 9, 7),
  { name: 'U.E.S. Bluford 5120-E', cls: 'Modified Bradbury Class Carrier', cost: 4, sector: 12, st: side({ vp: 3, arrow: 'L' }), dp: side({ vp: 1, arrow: 'L' }) },
  williamson('Fabian 4787-B', 1),
  williamson('Ride 3066-E', 2),
  williamson('Thagard 4684-B', 3),
  williamson('Brandenstein 3161-C', 4),
  williamson('Aleksandrov 5155-G', 5),
  williamson('Gardner 7506-E', 6),
  wells('Thornton 8524-G', 11),
  wells('Shaw 1873-C', 10),
  wells('Parker 8635-F', 9),
  wells('Lichtenberg 9384-H', 8),
  bradbury('Bobko 6010-E', 4, 9, 3, 2),
  bradbury('Peterson 5325-H', 3, 10, 3, 2),
  bradbury('Musgrave 5650-E', 4, 11, 4, 3),
  bradbury('Hauck 5084-D', 3, 12, 4, 3),
  tolkien('Malyshev 9767-E', 2, 1, vp(1), cr(1)),
  tolkien('Tuân 8623-B', 2, 2, vp(1), cr(1)),
  tolkien('Tamayo-Mendez 4759-G', 2, 3, vp(1), cr(1)),
  tolkien('Kizim 1379-H', 2, 4, vp(1), cr(1)),
  tolkien('Strekalov 7422-E', 2, 5, vp(1), cr(1)),
  tolkien('Savinykh 8526-G', 2, 6, vp(1), cr(1)),
  tolkien('Allen 4004-C', 3, 7, vp(2), { cr: 2, vp: 1 }),
  tolkien('Lenoir 7021-B', 2, 8, vp(2), { cr: 2, vp: 1 }),
  herbert('Ivanov 8387-E', 9, { cr: 3, inc: 1 }, { inc: 1 }),
  herbert('Popov 3919-A', 8, { cr: 2, inc: 1 }, cr(4)),
  herbert('Farkas 3405-F', 7, { cr: 2, inc: 1 }, cr(3)),
  herbert('Hermaszewski 5586-E', 12, { cr: 6, inc: 1 }, { cr: 4, inc: 1 }),
  herbert('Jähn 8920-C', 11, { cr: 5, inc: 1 }, { cr: 2, inc: 1 }),
  herbert('Lyakhov 4181-D', 10, { cr: 4, inc: 1 }, { cr: 1, inc: 1 }),
];

const fate = (name, cost, sector, s, d) => ({ name: `U.E.S. ${name}`, cls: 'Fate Class Cargo Vessel', cost, sector, st: side(cr(s)), dp: side(cr(d)) });
const giger = (name, cost, sector, s, d) => ({ name: `U.E.S. ${name}`, cls: 'Giger Class Carrier', cost, sector, st: side(vp(s)), dp: side(vp(d)) });
const heinlein = (name, sector) => ({
  name: `U.E.S. ${name}`, cls: 'Heinlein Class Command Cruiser', cost: 9, sector,
  st: side({}, one, { color: 'green', kind: 'shift', by: [1, 2] }),
  dp: side({}, one, { color: 'green', kind: 'shift', by: [1] }),
});
const asimov = (name, cost, sector, s, d) => ({ name: `U.E.S. ${name}`, cls: 'Asimov Class Exploration Carrier', cost, sector, st: side(cr(s)), dp: side(vp(d)) });
const harry = (name, cost, sector, s, d) => ({ name: `U.E.S. ${name}`, cls: 'Harryhausen Class Mining Vessel', cost, sector, st: side(s), dp: side(d) });
// three linked squares, the third counting only at a table of two or three
const swap3 = linked([], [], [2, 3]);
// four, two by two: the bottom pair at two players, one of them at three
const swap4 = linked([], [], [2], [2, 3]);

export const LEVEL2 = [
  fate('Worden 8663-H', 7, 1, 3, 2),
  fate('Irwin 8339-H', 7, 2, 3, 2),
  fate('Mattingly 4618-C', 7, 3, 3, 2),
  fate('Duke 6222-C', 7, 4, 3, 2),
  fate('Evans 7316-E', 8, 5, 3, 2),
  fate('Schmitt 9828-E', 8, 6, 3, 2),
  fate('Weitz 3134-C', 7, 12, 11, 8),
  fate('Kerwin 8426-A', 7, 11, 10, 7),
  fate('Lousma 6040-C', 7, 10, 9, 6),
  fate('Garriott 6531-E', 7, 9, 8, 6),
  fate('Lazarev 4784-B', 7, 8, 7, 5),
  fate('Makarov 6674-G', 7, 7, 6, 5),
  giger('Sevastyanov 6862-D', 8, 1, 2, 1),
  giger('Roosa 1689-A', 8, 2, 2, 1),
  giger('Mitchell 6176-D', 8, 3, 2, 1),
  giger('Rukavishnikov 3402-C', 8, 4, 2, 1),
  giger('Dobrovolsky 5643-E', 8, 5, 2, 1),
  giger('Patsayev 6859-H', 8, 6, 2, 1),
  giger('Carr 7510-H', 9, 7, 4, 2),
  giger('Pogue 5353-G', 8, 8, 4, 2),
  giger('Gibson 4003-B', 9, 9, 5, 3),
  giger('Lebedev 5128-B', 8, 10, 5, 3),
  giger('Klimuk 6800-G', 9, 11, 6, 4),
  giger('Artyukhin 7727-D', 9, 12, 7, 4),
  heinlein('Khrunov 6194-G', 2),
  heinlein('Shonin 2938-F', 5),
  heinlein('Demin 5091-F', 1),
  heinlein('Gubarev 1743-B', 4),
  {
    name: 'U.E.S. Volynov 3509-A', cls: 'Campbell Class Command Cruiser', cost: 6, sector: 3,
    st: side({}, loose(3), { color: 'blue', kind: 'reroll', cr: 1 }),
    dp: side({}, loose(2), { color: 'blue', kind: 'reroll' }),
  },
  {
    name: 'U.E.S. Aksyonov 7525-G', cls: 'Clement Class Dreadnaught', cost: 7, sector: 8,
    st: side({}, one, { color: 'blue', kind: 'double' }),
    dp: side({}, one, { color: 'red', kind: 'double' }),
  },
  asimov('Grechko 1421-A', 8, 3, 3, 1),
  asimov('Brand 5208-D', 8, 5, 3, 1),
  asimov('Slayton 5363-B', 8, 6, 3, 1),
  asimov('Glazkov 3371-B', 7, 11, 10, 4),
  harry('Schweickart 5209-E', 8, 4, { inc: 1 }, { inc: 1 }),
  harry('Bean 1925-D', 7, 9, { cr: 6, inc: 1 }, { cr: 2, inc: 1 }),
  harry('Swigert 2715-C', 7, 8, { cr: 5, inc: 1 }, { cr: 1, inc: 1 }),
  harry('Haise 3712-D', 7, 7, { cr: 4, inc: 1 }, { cr: 1, inc: 1 }),
  harry('Filipchenko 9745-C', 7, 12, { cr: 9, inc: 1 }, { cr: 4, inc: 1 }),
  harry('Volkov 9103-G', 7, 11, { cr: 8, inc: 1 }, { cr: 3, inc: 1 }),
  { name: 'U.E.S. Gorbatko 2007-F', cls: 'Clarke Class Mining Vessel', cost: 7, sector: 10, st: side({ inc: 3 }), dp: side({ inc: 2 }) },
  {
    name: 'U.E.S. Yeliseyev 6380-D', cls: 'Merritt Class Cargo Tug', cost: 9, sector: 1,
    st: side(cr(1), swap3, { color: 'blue', kind: 'swap', a: 6, b: 7 }),
    dp: side({ inc: 1 }),
  },
  {
    name: 'U.E.S. Kubasov 3192-G', cls: 'Merritt Class Cargo Tug', cost: 9, sector: 6,
    st: side(cr(1), swap4, { color: 'blue', kind: 'swap', a: 5, b: 8 }),
    dp: side({ inc: 1 }),
  },
  {
    name: 'P.S.S. Zholobov 1830-F', cls: 'Modified Merritt Class Cargo Tug', cost: 7, sector: 7,
    st: side(cr(2), swap3, { color: 'blue', kind: 'swap', a: 4, b: 9 }),
    dp: side({}, one, { color: 'blue', kind: 'buy', n: 1, vp: 2 }),
  },
  {
    name: 'P.S.S. Sarafanov 6334-C', cls: 'Norton Class Cargo Tug', cost: 8, sector: 2,
    st: side({}, one, { color: 'blue', kind: 'buy', n: 1, cr: 4 }),
    dp: side({}, one, { color: 'blue', kind: 'buy', n: 1, cr: 3 }),
  },
  {
    name: 'U.E.S. Rozhdestvensky 6723-C', cls: 'Silverberg Class Command Tug', cost: 7, sector: 10,
    st: side(cr(4), swap3, { color: 'blue', kind: 'swap', a: 2, b: 11 }),
    dp: side({}, one, { color: 'blue', kind: 'setdie', cr: 4 }),
  },
  {
    name: 'P.S.S. Kovalyonok 8127-H', cls: 'Modified Merritt Class Cargo Tug', cost: 7, sector: 12,
    st: side({}, one, { color: 'blue', kind: 'claim', claim: { 1: 3 } }),
    dp: side({}, one, { color: 'blue', kind: 'claim', claim: { 2: 1 } }),
  },
  {
    name: 'U.E.S. Zudov 2056-G', cls: 'Verne Class Hypernet Gate', cost: 7, sector: 9,
    st: side({}, one, { color: 'green', kind: 'exchange' }),
    dp: side({}, one, { color: 'green', kind: 'exchange' }),
  },
];

const bowie = (name, cost, sector, s, d) => ({ name: `U.E.S. ${name}`, cls: 'Bowie Class Cargo Vessel', cost, sector, st: side(cr(s)), dp: side(cr(d)) });
const frazetta = (name, sector, s, d) => ({ name: `U.E.S. ${name}`, cls: 'Frazetta Class Carrier', cost: 14, sector, st: side(vp(s)), dp: side(vp(d)) });
const burroughs = (name, sector) => ({
  name: `U.E.S. ${name}`, cls: 'Burroughs Class Command Ship', cost: 12, sector,
  st: side({}, loose(2), { color: 'blue', kind: 'setdie', cr: 1 }),
  dp: side({}, one, { color: 'blue', kind: 'setdie' }),
});
const pohl = (name, sector, claim, deployed) => ({
  name: `P.S.S. ${name}`, cls: 'Modified Pohl Class Tug', cost: 13, sector,
  st: side({ claim }),
  dp: side({}, one, { color: 'blue', kind: 'claim', claim: deployed }),
});

export const LEVEL3 = [
  {
    name: 'U.E.S. Shepard 3592-G', cls: 'Gunn Class Cargo Carrier', cost: 13, sector: 2,
    st: side({}, swap4, { color: 'blue', kind: 'gain', cr: 20 }),
    dp: side({ cr: 2, vp: 1 }),
  },
  bowie('Carpenter 2967-E', 14, 12, 18, 10),
  bowie('Young 6740-G', 12, 1, 4, 4),
  bowie('McDivitt 2121-A', 12, 2, 4, 4),
  bowie('White 4448-C', 12, 3, 4, 4),
  bowie('Conrad 5602-E', 12, 4, 4, 4),
  bowie('Borman 3060-D', 12, 5, 4, 4),
  bowie('Lovell 1948-A', 12, 6, 4, 4),
  bowie('Stafford 4286-G', 13, 11, 14, 8),
  frazetta('Walker 3930-D', 1, 3, 2),
  frazetta('Komarov 9388-G', 2, 3, 2),
  frazetta('Feoktistov 1804-D', 3, 3, 2),
  frazetta('Yegorov 1205-H', 4, 3, 2),
  frazetta('Leonov 4621-E', 5, 3, 2),
  frazetta('Belyayev 1657-D', 6, 3, 2),
  frazetta('Aldrin 4775-F', 7, 6, 3),
  frazetta('Eisele 7639-F', 8, 6, 3),
  frazetta('Cunningham 9172-H', 9, 7, 4),
  frazetta('Beregovoy 8603-A', 10, 7, 4),
  frazetta('Anders 4253-F', 11, 8, 5),
  frazetta('Shatalov 3516-B', 12, 9, 5),
  burroughs('Gagarin 4879-F', 1),
  burroughs('Titov 9072-F', 4),
  {
    name: 'U.E.S. Armstrong 6927-D', cls: 'Lucas Class Gun Carriage', cost: 14, sector: 12,
    st: side({}, linked([], [], [], [2], [2, 3]), { color: 'green', kind: 'win' }),
    dp: side({}, one, { color: 'blue', kind: 'gain', cr: 10 }),
  },
  { name: 'U.E.S. Cooper 6412-D', cls: 'Clarke Class Mining Vessel', cost: 13, sector: 7, st: side({ cr: 3, inc: 3 }), dp: side({ cr: 3, inc: 2 }) },
  {
    name: 'U.E.S. Gordon 7981-G', cls: 'Gernsback Class Destroyer', cost: 13, sector: 7,
    st: side({}, one, { color: 'blue', kind: 'buy', n: 2, loss: 4 }),
    dp: side({}, one, { color: 'blue', kind: 'buy', n: 1, loss: 3 }),
  },
  {
    name: 'U.E.S. Grissom 8139-H', cls: 'Tucker Class Cargo Train', cost: 13, sector: 3,
    st: side({}, loose(3), { color: 'blue', kind: 'gain', cr: 3 }),
    dp: side({}, loose(2), { color: 'green', kind: 'gain', cr: 3 }),
  },
  {
    name: 'U.E.S. Glenn 1817-C', cls: 'Russel Class Tanker', cost: 13, sector: 6,
    st: side({}, linked([], []), { color: 'green', kind: 'place' }),
    dp: side({}, linked([], []), { color: 'green', kind: 'place' }),
    provisional: 'station squares hidden in every picture',
  },
  {
    name: 'U.E.S. Collins 2064-F', cls: 'Moore Class Fast Tanker', cost: 14, sector: 8,
    st: side({}, one, { color: 'green', kind: 'place', move: true }),
    dp: side({}, one, { color: 'green', kind: 'place' }),
  },
  {
    name: 'U.E.S. Schirra 9069-D', cls: 'Sturgeon Class Defender Tug', cost: 14, sector: 5,
    st: side(cr(2), swap3, { color: 'blue', kind: 'swap', a: 4, b: 10 }),
    dp: side({ cr: 2, vp: 1 }),
  },
  {
    name: 'U.E.S. Cernan 9131-H', cls: 'Sturgeon Class Defender Tug', cost: 13, sector: 9,
    st: side(cr(6), swap3, { color: 'blue', kind: 'swap', a: 1, b: 12 }),
    dp: side(vp(3)),
  },
  pohl('Nikolayev 5815-B', 11, { 3: 1, 1: 1 }, { 3: 1 }),
  pohl('Popovich 8867-G', 10, { 2: 2 }, { 3: 1 }),
  pohl('Bykovsky 4498-A', 9, { 2: 1, 1: 1 }, { 2: 1 }),
  pohl('Tereshkova 5875-A', 8, { 1: 2 }, { 2: 1 }),
  {
    name: 'U.E.S. Scott 4406-C', cls: 'Roddenbury Class Hypernet Gate', cost: 13, sector: 10,
    st: side({}, loose(3), { color: 'blue', kind: 'buy', n: 1, high: true }),
    dp: side({}, one, { color: 'blue', kind: 'buy', n: 1, high: true }),
  },
];

const colony = (name, cls, sector) => ({ name: `U.E.C. ${name}`, cls, cost: 6 + 3 * sector, sector, vp: sector + 2 });
export const COLONIES = [
  colony('Frisch Outpost', 'Serling Star Settlement', 1),
  colony('Tinbergen Outpost', 'Serling Star Settlement', 2),
  colony('Samuelson Outpost', 'Serling Star Settlement', 3),
  colony('Kuznets Outpost', 'Serling Star Settlement', 4),
  colony('Hicks Base', 'Cameron Class Star Settlement', 5),
  colony('Arrow Base', 'Cameron Class Star Settlement', 6),
  colony('Leontief Base', 'Cameron Class Star Settlement', 7),
  colony('Myrdal Base', 'Cameron Class Star Settlement', 8),
  colony('Hayek Colony', 'Kubrick Class Star Settlement', 9),
  colony('Kantorovich Colony', 'Kubrick Class Star Settlement', 10),
  colony('Koopmans Colony', 'Kubrick Class Star Settlement', 11),
  colony('Friedman Colony', 'Kubrick Class Star Settlement', 12),
];
