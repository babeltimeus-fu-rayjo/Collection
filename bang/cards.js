// cards.js — the printed contents of BANG! (dV Giochi, 2002), as data.
//
// Where it came from:
//   cards       dV Giochi's own card list for the base game
//               (bang.dvgiochi.com/cardslist.php?id=1): every card, how many
//               copies, and the suit and value printed in each card's corner
//               — the ones a "draw!" reads. Their wording is the card list's
//               rules text (script/open_card.php).
//   weapons     the range in each weapon's sight, read off the card images
//               on the same site.
//   characters  their abilities from the same card list, their life points
//               from the bullets on the card images.
//   rules       the English rulebook and FAQ on dvgiochi.com.

// suits as the card list draws them: Picche, Quadri, Fiori, Cuori
export const SUITS = { S: '♠', D: '♦', C: '♣', H: '♥' };
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const rankValue = (r) => RANKS.indexOf(r) + 2;
export const RED = new Set(['H', 'D']);

// brown cards are played and discarded; blue cards stay in play in front of
// their owner (Jail in front of the jailed). `range` is a weapon's sight.
export const KINDS = {
  bang:        { name: 'BANG!', color: 'brown', text: 'Shoot a player you can reach with your weapon. They lose a life point unless they play a Missed!. Only one BANG! a turn.' },
  missed:      { name: 'Missed!', color: 'brown', text: 'Cancel a BANG! (or a Gatling) aimed at you — even out of your turn.' },
  beer:        { name: 'Beer', color: 'brown', text: 'Regain one life point. Out of turn only to save yourself from a lethal hit. No effect when only two players are left.' },
  saloon:      { name: 'Saloon', color: 'brown', text: 'Every player in play regains one life point.' },
  stagecoach:  { name: 'Stagecoach', color: 'brown', text: 'Draw two cards from the deck.' },
  wellsfargo:  { name: 'Wells Fargo', color: 'brown', text: 'Draw three cards from the deck.' },
  generalstore:{ name: 'General Store', color: 'brown', text: 'Turn up one card for each player in play; starting with you and going clockwise, each takes one.' },
  panic:       { name: 'Panic!', color: 'brown', text: 'Take a card from a player at distance 1 — a random one from their hand, or one they have in play. Weapons do not help; Mustang and Scope count.' },
  catbalou:    { name: 'Cat Balou', color: 'brown', text: 'Force any player to discard a card — a random one from their hand, or one they have in play — at any distance.' },
  gatling:     { name: 'Gatling', color: 'brown', text: 'A BANG! at every other player, at any distance. It is not a BANG! card.' },
  indians:     { name: 'Indians!', color: 'brown', text: 'Every other player discards a BANG! or loses a life point. Missed! and Barrel do not help.' },
  duel:        { name: 'Duel', color: 'brown', text: 'Challenge any player. Taking turns, starting with them, each discards a BANG!; the first who cannot loses a life point. Missed! and Barrel do not help.' },
  barrel:      { name: 'Barrel', color: 'blue', text: 'When you are the target of a BANG!, “draw!”: on a Heart you are missed.' },
  dynamite:    { name: 'Dynamite', color: 'blue', text: 'Play it in front of you. At the start of your next turn, “draw!”: Spades 2–9 and it explodes — lose 3 life points; otherwise pass it to the player on your left.' },
  jail:        { name: 'Jail', color: 'blue', text: 'Play it in front of any player but the Sheriff. At the start of their turn they “draw!”: on a Heart they escape and play on; otherwise they skip the turn. Either way the Jail is discarded.' },
  mustang:     { name: 'Mustang', color: 'blue', text: 'Other players see you at a distance increased by 1.' },
  scope:       { name: 'Scope', color: 'blue', text: 'You see all other players at a distance decreased by 1.' },
  volcanic:    { name: 'Volcanic', color: 'blue', weapon: true, range: 1, text: 'Weapon, range 1. You can play any number of BANG! cards.' },
  schofield:   { name: 'Schofield', color: 'blue', weapon: true, range: 2, text: 'Weapon, range 2.' },
  remington:   { name: 'Remington', color: 'blue', weapon: true, range: 3, text: 'Weapon, range 3.' },
  carabine:    { name: 'Rev. Carabine', color: 'blue', weapon: true, range: 4, text: 'Weapon, range 4.' },
  winchester:  { name: 'Winchester', color: 'blue', weapon: true, range: 5, text: 'Weapon, range 5.' },
};

// The 80 playing cards: kind, suit, value — dV Giochi's list, card for card.
const run = (kind, suit, from, to) => RANKS.slice(RANKS.indexOf(from), RANKS.indexOf(to) + 1).map((r) => [kind, suit, r]);
export const DECK = [
  ['barrel', 'S', 'Q'], ['barrel', 'S', 'K'],
  ['dynamite', 'H', '2'],
  ['jail', 'S', 'J'], ['jail', 'H', '4'], ['jail', 'S', '10'],
  ['mustang', 'H', '8'], ['mustang', 'H', '9'],
  ['remington', 'C', 'K'],
  ['carabine', 'C', 'A'],
  ['schofield', 'C', 'J'], ['schofield', 'C', 'Q'], ['schofield', 'S', 'K'],
  ['scope', 'S', 'A'],
  ['volcanic', 'S', '10'], ['volcanic', 'C', '10'],
  ['winchester', 'S', '8'],
  ['bang', 'S', 'A'], ...run('bang', 'D', '2', 'A'), ...run('bang', 'C', '2', '9'), ...run('bang', 'H', 'Q', 'A'),
  ...run('beer', 'H', '6', 'J'),
  ['catbalou', 'H', 'K'], ...run('catbalou', 'D', '9', 'J'),
  ['duel', 'D', 'Q'], ['duel', 'S', 'J'], ['duel', 'C', '8'],
  ['gatling', 'H', '10'],
  ['generalstore', 'C', '9'], ['generalstore', 'S', 'Q'],
  ['indians', 'D', 'K'], ['indians', 'D', 'A'],
  ...run('missed', 'C', '10', 'A'), ...run('missed', 'S', '2', '8'),
  ...run('panic', 'H', 'J', 'Q'), ['panic', 'H', 'A'], ['panic', 'D', '8'],
  ['saloon', 'H', '5'],
  ['stagecoach', 'S', '9'], ['stagecoach', 'S', '9'],
  ['wellsfargo', 'H', '3'],
];

// The 16 characters: life points (the bullets on the card) and ability.
export const CHARACTERS = {
  bart:     { name: 'Bart Cassidy', life: 4, text: 'Each time he loses a life point, he immediately draws a card from the deck.' },
  blackjack:{ name: 'Black Jack', life: 4, text: 'During phase 1 of his turn, he must show the second card he draws: if it is a Heart or a Diamond, he draws one additional card.' },
  calamity: { name: 'Calamity Janet', life: 4, text: 'She can use BANG! cards as Missed! cards and vice versa. A Missed! played as a BANG! counts as her BANG! for the turn.' },
  gringo:   { name: 'El Gringo', life: 3, text: 'Each time he loses a life point due to a card played by another player, he draws a random card from that player’s hand (one card for each life point).' },
  jesse:    { name: 'Jesse Jones', life: 4, text: 'During phase 1 of his turn, he may draw the first card at random from another player’s hand instead of the deck; the second comes from the deck.' },
  jourdonnais: { name: 'Jourdonnais', life: 4, text: 'He is considered to have a Barrel in play at all times — with a real Barrel too, he gets two chances.' },
  kit:      { name: 'Kit Carlson', life: 4, text: 'During phase 1 of his turn, he looks at the top three cards of the deck, keeps two and puts the other back on top.' },
  lucky:    { name: 'Lucky Duke', life: 4, text: 'Each time he is required to “draw!”, he flips the top two cards and chooses the result he prefers.' },
  paul:     { name: 'Paul Regret', life: 3, text: 'He is considered to have a Mustang in play at all times: all other players see him at a distance increased by 1.' },
  pedro:    { name: 'Pedro Ramirez', life: 4, text: 'During phase 1 of his turn, he may draw the first card from the top of the discard pile; the second comes from the deck.' },
  rose:     { name: 'Rose Doolan', life: 4, text: 'She is considered to have a Scope in play at all times: she sees all other players at a distance decreased by 1.' },
  sid:      { name: 'Sid Ketchum', life: 4, text: 'At any time, he may discard two cards from his hand to regain one life point — more than once, if he can.' },
  slab:     { name: 'Slab the Killer', life: 4, text: 'Players trying to cancel his BANG! cards need two Missed!. A successful Barrel counts as one.' },
  suzy:     { name: 'Suzy Lafayette', life: 4, text: 'As soon as she has no cards in her hand, she draws one from the deck.' },
  vulture:  { name: 'Vulture Sam', life: 4, text: 'Whenever a character is eliminated, he takes all the cards that player had in hand and in play.' },
  willy:    { name: 'Willy the Kid', life: 4, text: 'He can play any number of BANG! cards during his turn.' },
};

// The roles for each table size, from the rulebook.
export const ROLES_FOR = {
  4: ['sheriff', 'renegade', 'outlaw', 'outlaw'],
  5: ['sheriff', 'renegade', 'outlaw', 'outlaw', 'deputy'],
  6: ['sheriff', 'renegade', 'outlaw', 'outlaw', 'outlaw', 'deputy'],
  7: ['sheriff', 'renegade', 'outlaw', 'outlaw', 'outlaw', 'deputy', 'deputy'],
};
export const ROLES = {
  sheriff:  { name: 'Sheriff', goal: 'Eliminate all the Outlaws and the Renegade.' },
  deputy:   { name: 'Deputy', goal: 'Help and protect the Sheriff: you win together when every Outlaw and the Renegade are gone.' },
  outlaw:   { name: 'Outlaw', goal: 'Kill the Sheriff. Whoever eliminates an Outlaw draws three cards.' },
  renegade: { name: 'Renegade', goal: 'Be the last one standing — the Sheriff last of all.' },
};
