import { payFor } from './game.js';

// three seats: 0 = me, left = 2, right = 1  (left is seat-1 mod n)
const mk = (specs) => ({
  nPlayers: 3,
  players: specs.map((s, i) => ({
    seat: i, wonderRes: s.res || '', built: (s.built || []), stagesBuilt: s.stages || [],
  })),
});
const card = (n, give, c = 'brown', trade) => ({ n, give, c, trade });

let pass = 0, fail = 0;
const t = (label, G, cost, want) => {
  const got = payFor(G, 0, cost);
  const s = got ? `${got.coins} (L${got.left}/R${got.right})` : 'IMPOSSIBLE';
  const ok = want === null ? got === null : got && got.coins === want.coins
    && (want.left === undefined || got.left === want.left)
    && (want.right === undefined || got.right === want.right);
  console.log(`${ok ? 'PASS' : '**FAIL**'}  ${label.padEnd(56)} ${s}${ok ? '' : `   wanted ${want === null ? 'IMPOSSIBLE' : JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

// --- own production
t('free card costs nothing', mk([{ res: 'S' }, {}, {}]), '', { coins: 0 });
t('wonder resource covers its own cost', mk([{ res: 'S' }, {}, {}]), 'S', { coins: 0 });
t('two of a resource, only one source', mk([{ res: 'S' }, {}, {}]), 'SS', null);
t('double generator covers two', mk([{ res: '', built: [card('Quarry', 'SS')] }, {}, {}]), 'SS', { coins: 0 });

// --- the choice trap: one generator cannot be both things
const treeFarm = mk([{ res: '', built: [card('Tree Farm', 'W/C')] }, {}, {}]);
t('choice generator gives either one', treeFarm, 'W', { coins: 0 });
t('choice generator gives the other one', treeFarm, 'C', { coins: 0 });
t('choice generator cannot be spent twice', treeFarm, 'WC', null);
const twoWood = mk([{ res: 'W', built: [card('Tree Farm', 'W/C')] }, {}, {}]);
t('board + choice covers wood and clay', twoWood, 'WC', { coins: 0 });
t('choice steered so both are paid', twoWood, 'WW', { coins: 0 });

// --- buying from neighbours
const nb = (mine, rightBuilt, leftBuilt) => mk([mine, { res: '', built: rightBuilt }, { res: '', built: leftBuilt }]);
t('buy one from a neighbour at 2', nb({ res: '' }, [card('Stone Pit', 'S')], []), 'S', { coins: 2, right: 2 });
t('buy two from a neighbour at 2 each', nb({ res: '' }, [card('Quarry', 'SS')], []), 'SS', { coins: 4, right: 4 });
t('nobody has it', nb({ res: '' }, [card('Stone Pit', 'S')], []), 'G', null);

// --- trading posts
const east = card('East Trading Post', null, 'yellow', { with: 'right', kind: 'raw' });
const west = card('West Trading Post', null, 'yellow', { with: 'left', kind: 'raw' });
const market = card('Marketplace', null, 'yellow', { with: 'both', kind: 'man' });
t('East Trading Post halves the price to the right',
  nb({ res: '', built: [east] }, [card('Stone Pit', 'S')], []), 'S', { coins: 1, right: 1 });
t('East post does not discount the left',
  nb({ res: '', built: [east] }, [], [card('Stone Pit', 'S')]), 'S', { coins: 2, left: 2 });
t('West post discounts the left',
  nb({ res: '', built: [west] }, [], [card('Stone Pit', 'S')]), 'S', { coins: 1, left: 1 });
t('Marketplace does not discount raw materials',
  nb({ res: '', built: [market] }, [card('Stone Pit', 'S')], []), 'S', { coins: 2, right: 2 });
t('Marketplace discounts manufactured goods',
  nb({ res: '', built: [market] }, [card('Press', 'P', 'grey')], []), 'P', { coins: 1, right: 1 });

// --- choosing the cheaper neighbour
t('buys from whichever side is cheaper',
  nb({ res: '', built: [west] }, [card('Stone Pit', 'S')], [card('Stone Pit', 'S')]), 'S', { coins: 1, left: 1, right: 0 });
t('spreads across both when it must',
  nb({ res: '', built: [west] }, [card('Stone Pit', 'S')], [card('Stone Pit', 'S')]), 'SS', { coins: 3, left: 1, right: 2 });

// --- own production is always preferred over buying
t('uses free production before paying',
  nb({ res: 'S' }, [card('Stone Pit', 'S')], []), 'S', { coins: 0 });

// --- wonder-stage production is usable but not sellable
t('my wonder stage feeds me',
  mk([{ res: '', stages: [{ give: 'W/S/C/O' }] }, {}, {}]), 'S', { coins: 0 });
t('a neighbour wonder stage is not for sale',
  mk([{ res: '' }, { res: '', stages: [{ give: 'S' }] }, {}]), 'S', null);
t('a neighbour yellow card is not for sale',
  nb({ res: '' }, [card('Caravansery', 'W/S/C/O', 'yellow')], []), 'S', null);

// --- a nasty one: two choice generators, three demands, one purchase
t('two choices plus a buy, cheapest split',
  nb({ res: '', built: [card('Tree Farm', 'W/C'), card('Timber Yard', 'S/W')] },
     [card('Clay Pool', 'C')], []),
  'WSC', { coins: 2, right: 2 });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
