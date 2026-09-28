// cards.js — the printed content of Challengers! (2022) and Challengers!
// Beach Cup (2023), as data. Nothing here knows how to play; game.js reads it.
//
// Where it came from, and how far it was checked:
//
//   rules          the publisher's English rulebook for Challengers! (1 More
//                  Time Games / Z-Man, v3) and the Beach Cup rulebook (Pretzel
//                  / Next Move, French edition — the English one is not on the
//                  publisher's CDN).
//   characters     141 cards read off photographs and scans of the cards
//                  themselves, in the two community card galleries on
//                  TierMaker ("Challengers! of all the Cards", "Challengers
//                  Beach Cup Cards") and the publisher's own sample cards:
//                  every card of the twelve additional sets and the Rainbow,
//                  the City's Reporter, Mascot and Fan-Bus, and the starter
//                  Talent, Dog and Champion. The Newcomer is in no gallery;
//                  the Beach Cup rulebook pictures it. Names, sets,
//                  levels, base power, printed text and the "Rare 3x" /
//                  "Common 8x" counts are the cards' own. A card that prints no
//                  count has four copies ("Most of the cards are in 4 copies").
//                  That gives a check the numbers cannot pass by accident:
//                  every additional set in both boxes holds exactly 40 cards,
//                  and the rulebook says each one does. test-cards.mjs asserts it.
//   draft plans    read off the Tournament Plan cards printed in each rulebook
//                  (the 7-8 player plan): which Level piles each round offers,
//                  how many cards each option picks, and — Beach Cup only —
//                  the fans an option pays.
//   trophies       Board Game Arena's rules page for the game, which lists the
//                  fans on the back of the four Trophies of each round.
//
// NOT sourced yet, and marked where it is used:
//   - the City set's split of its 20 cards. Reporter, Mascot and Fan-Bus print
//     no count, so four each; the Level copies of Talent, Dog and Champion that
//     make up the other eight are taken to print like the starter ones, and
//     how many of each is PROVISIONAL (three, three and two below).
//   - the Beach Cup starter decks. The Beach Cup rulebook shows a City-blue
//     Newcomer of power 1 and a Dog that looks at the top card of your deck;
//     the rest of the deck is assumed to follow the first box (PROVISIONAL).
//   - the Robot's cards and the sixteen Trainers — not in the game yet.
//
// Card text keeps the printed wording. {city} and friends stand for the set
// icons the cards print inline; the page draws them.

export const SETS = {
  // Challengers! (2022)
  city:       { name: 'City',            box: 'base',  basic: true, color: '#7cc3e6', ink: '#0f3a52', icon: '🏙' },
  castle:     { name: 'Castle',          box: 'base',  color: '#3b82c4', ink: '#fff',    icon: '🏰' },
  film:       { name: 'Film Studio',     box: 'base',  color: '#6aa84f', ink: '#fff',    icon: '🎬' },
  funfair:    { name: 'Funfair',         box: 'base',  color: '#f2b52c', ink: '#3a2600', icon: '🎈' },
  haunted:    { name: 'Haunted House',   box: 'base',  color: '#ec8a2f', ink: '#fff',    icon: '🦇' },
  space:      { name: 'Outer Space',     box: 'base',  color: '#df3f3a', ink: '#fff',    icon: '🪐' },
  shipwreck:  { name: 'Shipwreck',       box: 'base',  color: '#8c3b95', ink: '#fff',    icon: '⚓' },
  // Challengers! Beach Cup (2023)
  rainbow:    { name: 'Rainbow',         box: 'beach', basic: true, color: 'rainbow', ink: '#fff', icon: '🌈', allIcons: true },
  secret:     { name: 'Secret Base',     box: 'beach', color: '#e5489a', ink: '#fff',    icon: '🔐' },
  beachclub:  { name: 'Beach Club',      box: 'beach', color: '#19a3a3', ink: '#fff',    icon: '🌴' },
  mountain:   { name: 'Mountain Top',    box: 'beach', color: '#6962b6', ink: '#fff',    icon: '🏔' },
  university: { name: 'University',      box: 'beach', color: '#7b4a2a', ink: '#fff',    icon: '🎓' },
  toystore:   { name: 'Toy Store',       box: 'beach', color: '#b3c21c', ink: '#2f3300', icon: '🧩' },
  forest:     { name: 'Fairytale Forest', box: 'beach', color: '#1d6a44', ink: '#fff',   icon: '🍄' },
};

export const BOXES = {
  base: { name: 'Challengers!', basic: 'city', sets: ['castle', 'film', 'funfair', 'haunted', 'space', 'shipwreck'], suggestOut: 'space' },
  beach: { name: 'Challengers! Beach Cup', basic: 'rainbow', sets: ['secret', 'beachclub', 'mountain', 'university', 'toystore', 'forest'], suggestOut: 'forest' },
};

// The keyword a card's text opens with, in bold on the card. "now" is a card
// without one: its effect happens the moment it is revealed.
//   attack   During the attack:     only in the attack that revealed it
//   bench    From the bench:        while it sits on its owner's bench
//   flag     In flag possession:    while the flag sits on it
//   loss     Flag loss:             as the flag is taken off it (first box)
//   picked   When picked:           once, in the Deck Phase that drafts it
//   nowin    No flag win:           when revealing it does not take the flag (Beach Cup)
//   special  Special:               breaks a rule, as the card says (Beach Cup)
const K = (key, name, set, level, power, copies, kw, text) => ({ key, name, set, level, power, copies, kw, text });

export const CARDS = [
  // ---------------------------------------------------------------- starter decks (S)
  K('newcomer', 'Newcomer', 'city', 'S', 1, 0, null, ''),
  K('talent-s', 'Talent', 'city', 'S', 2, 0, null, ''),
  K('dog-s', 'Dog', 'city', 'S', 3, 0, null, ''),
  K('champion-s', 'Champion', 'city', 'S', 4, 0, null, ''),
  // Beach Cup's starter Dog, a City card like the rest of the starter deck
  // (the box also carries eight of them to swap into the first box's decks)
  K('dog-look', 'Dog', 'city', 'S', 3, 0, 'now', 'Look at the top card of your deck. Put it on top of or under your deck.'),

  // ---------------------------------------------------------------- City (basic set, first box)
  K('reporter', 'Reporter', 'city', 'A', 2, 4, 'now', 'Look at the top two cards of your deck. Put one under your deck and the other on top.'),
  { ...K('talent-a', 'Talent', 'city', 'A', 2, 3, null, ''), unconfirmed: true },   // PROVISIONAL count
  K('mascot', 'Mascot', 'city', 'B', 2, 4, 'now', 'This card has +1 for each different Set icon on your bench.'),
  { ...K('dog-b', 'Dog', 'city', 'B', 3, 3, null, ''), unconfirmed: true },         // PROVISIONAL count
  { ...K('champion-c', 'Champion', 'city', 'C', 4, 2, null, ''), unconfirmed: true }, // PROVISIONAL count
  K('fan-bus', 'Fan-Bus', 'city', 'C', 6, 4, 'now', 'If you have three or fewer Trophies, take 2 fans.'),

  // ---------------------------------------------------------------- Castle
  K('hermit', 'Hermit', 'castle', 'A', 2, 4, 'now', 'If there are no {city}-cards on your bench, this card has +2.'),
  K('jester', 'Jester', 'castle', 'A', 1, 4, 'now', 'If there is at least one card with base power 1 on your bench, this card has +3.'),
  K('pig', 'Pig', 'castle', 'A', 3, 3, null, ''),
  K('stable-boy', 'Stable Boy', 'castle', 'A', 2, 4, 'now', 'This card has +1 for each card with base power 3 on your bench.'),
  K('blacksmith', 'Blacksmith', 'castle', 'B', 3, 4, 'bench', 'Your {city}-cards have +1.'),
  K('horse', 'Horse', 'castle', 'B', 5, 3, null, ''),
  K('knight', 'Knight', 'castle', 'B', 3, 4, 'attack', 'This card has +1 for each Trophy of your opponent.'),
  K('sorcerer', 'Sorcerer', 'castle', 'B', 4, 4, 'now', 'You may put one card with base power 3 or lower from your bench on your exhaust pile.'),
  K('bard', 'Bard', 'castle', 'C', 4, 4, 'bench', 'Your cards have +1 during the attack.'),
  K('dragon', 'Dragon', 'castle', 'C', 7, 2, null, ''),
  K('prince', 'Prince', 'castle', 'C', 5, 4, 'loss', 'Put this card on your exhaust pile.'),

  // ---------------------------------------------------------------- Film Studio
  K('cat', 'Cat', 'film', 'A', 3, 3, null, ''),
  K('gangster', 'Gangster', 'film', 'A', 2, 4, 'attack', 'This card has +2.'),
  K('make-up-artist', 'Make-Up Artist', 'film', 'A', 1, 4, 'bench', 'Your cards with base power 1 have +2 during the attack.'),
  K('movie-star', 'Movie Star', 'film', 'A', 2, 4, 'now', 'Put up to two Newcomer-cards from your bench on top of your deck.'),
  K('cowboy', 'Cowboy', 'film', 'B', 3, 4, 'now', 'If this card gets in flag possession, your opponent puts the top card of their deck on their bench.'),
  K('director', 'Director', 'film', 'B', 4, 4, 'bench', 'Your {film}-cards have +1 during the attack.'),
  K('lion', 'Lion', 'film', 'B', 5, 3, null, ''),
  K('comic-character', 'Comic Character', 'film', 'B', 4, 4, 'loss', 'Your next card has +2 during the attack.'),
  K('heroine', 'Heroine', 'film', 'C', 5, 4, 'now', 'If this card gets in flag possession, take 3 fans.'),
  K('t-rex', 'T-Rex', 'film', 'C', 7, 2, null, ''),
  K('villain', 'Villain', 'film', 'C', 10, 4, 'now', 'Put the top card from the Level-A-Pile on top of your deck, without looking at it.'),

  // ---------------------------------------------------------------- Funfair
  K('clown', 'Clown', 'funfair', 'A', 1, 4, 'now', 'If this card gets in flag possession, take 2 fans.'),
  K('juggler', 'Juggler', 'funfair', 'A', 2, 4, 'now', 'Look at the top three cards of your deck. Return them in any order on top of your deck.'),
  K('pony', 'Pony', 'funfair', 'A', 3, 3, null, ''),
  K('vendor', 'Vendor', 'funfair', 'A', 2, 4, 'bench', 'Your {funfair}-cards have +1.'),
  K('clairvoyant', 'Clairvoyant', 'funfair', 'B', 4, 4, 'loss', 'Look through your deck. Choose any card and put it on top of your deck.'),
  K('mime', 'Mime', 'funfair', 'B', 1, 4, 'now', 'This card has +1 for each empty seat on your bench.'),
  K('pyrotechnician', 'Pyrotechnician', 'funfair', 'B', 4, 4, 'now', 'If you have a single or no card left in your deck, take 2 fans.'),
  K('rubber-duck', 'Rubber Duck', 'funfair', 'B', 5, 3, null, ''),
  K('bumper-car', 'Bumper Car', 'funfair', 'C', 6, 4, 'now', 'Look at the top three cards of your deck. Return them in any order on top of your deck.'),
  K('illusionist', 'Illusionist', 'funfair', 'C', 5, 4, 'flag', 'This card has +1 for each empty seat on your bench.'),
  K('teddy-bear', 'Teddy Bear', 'funfair', 'C', 7, 2, null, ''),

  // ---------------------------------------------------------------- Haunted House
  K('butler', 'Butler', 'haunted', 'A', 1, 4, 'now', 'Put up to two cards from your bench on your exhaust pile.'),
  K('skeleton', 'Skeleton', 'haunted', 'A', 2, 8, 'flag', 'This card has +1.'),
  K('spider', 'Spider', 'haunted', 'A', 3, 3, null, ''),
  K('bat', 'Bat', 'haunted', 'B', 5, 3, null, ''),
  K('ghost', 'Ghost', 'haunted', 'B', 1, 4, 'now', 'Your opponent puts the top card of their deck on their exhaust pile.'),
  K('necromancer', 'Necromancer', 'haunted', 'B', 3, 4, 'now', 'Put one card with base power 2 from your bench on top of your deck.'),
  K('teenager', 'Teenager', 'haunted', 'B', 2, 4, 'now', 'This card has +1 for each {haunted}-card on your bench.'),
  K('vacuum-cleaner', 'Vacuum Cleaner', 'haunted', 'C', 5, 4, 'now', 'Put up to two cards from your bench on your exhaust pile.'),
  K('vampire', 'Vampire', 'haunted', 'C', 4, 4, 'now', 'Put one Level-B-Card from your bench on top of your deck.'),
  K('werewolf', 'Werewolf', 'haunted', 'C', 7, 2, null, ''),

  // ---------------------------------------------------------------- Outer Space
  K('ai', 'A.I.', 'space', 'A', 2, 3, 'bench', 'Your cards with base power 2 have +1.'),
  K('cow', 'Cow', 'space', 'A', 3, 3, null, ''),
  K('rescue-pod', 'Rescue Pod', 'space', 'A', 1, 4, 'loss', 'Remove this card. Put the top card from the Level-B-Pile on your exhaust pile.'),
  K('shapeshifter', 'Shapeshifter', 'space', 'A', 2, 4, 'picked', 'You may remove a card from your deck to pick an extra card.'),
  K('alien', 'Alien', 'space', 'B', 5, 3, null, ''),
  K('band', 'Band', 'space', 'B', 3, 4, 'bench', 'Your {space}-cards have +1.'),
  K('clones', 'Clones', 'space', 'B', 4, 5, 'picked', 'Take 1 fan.'),
  K('ufo', 'UFO', 'space', 'B', 3, 4, 'now', 'Put the top two cards from the Level-A-Pile under your deck, without looking at them.'),
  K('hologram', 'Hologram', 'space', 'C', 4, 4, 'now', 'Your opponent puts the top card from the Level-B-Pile on top of their deck, without looking at it.'),
  K('sci-fi-geek', 'Sci-Fi Geek', 'space', 'C', 6, 4, 'picked', 'You may remove two {space}-cards from your deck to pick an extra card.'),
  K('slime', 'Slime', 'space', 'C', 7, 2, null, ''),

  // ---------------------------------------------------------------- Shipwreck
  K('merman', 'Merman', 'shipwreck', 'A', 1, 4, 'now', 'If there is at least one {shipwreck}-card on your bench, this card has +3.'),
  K('parrot', 'Parrot', 'shipwreck', 'A', 3, 3, null, ''),
  K('sailor', 'Sailor', 'shipwreck', 'A', 2, 4, 'now', 'Look through your deck. Choose any card and put it under your deck.'),
  K('treasure', 'Treasure', 'shipwreck', 'A', 2, 4, 'flag', 'This card has +2.'),
  K('cook', 'Cook', 'shipwreck', 'B', 2, 4, 'bench', 'Your card in flag possession has +1.'),
  K('lifeguard', 'Lifeguard', 'shipwreck', 'B', 4, 4, 'now', 'If you have a single or no card left in your deck, this card has +2.'),
  K('navigator', 'Navigator', 'shipwreck', 'B', 4, 4, 'loss', 'Look at the top two cards of your deck. Put one under your deck and the other on top.'),
  K('shark', 'Shark', 'shipwreck', 'B', 5, 3, null, ''),
  K('kraken', 'Kraken', 'shipwreck', 'C', 7, 2, null, ''),
  K('siren', 'Siren', 'shipwreck', 'C', 6, 4, 'now', 'You may put a card from your opponent’s bench on their exhaust pile.'),
  K('submarine', 'Submarine', 'shipwreck', 'C', 9, 4, 'now', 'Put the bottom-most card of your deck on your exhaust pile.'),

  // ---------------------------------------------------------------- Rainbow (basic set, Beach Cup)
  // "This card has all set icons." — every Rainbow card
  K('backpacker', 'Backpacker', 'rainbow', 'A', 1, 4, 'special', 'When this card would be put on your bench, put it on your exhaust pile instead.'),
  K('dj', 'DJ', 'rainbow', 'A', 2, 4, 'now', 'Look at the top card of your deck. Put it on top of or under your deck.'),
  K('impostor', 'Impostor', 'rainbow', 'B', 2, 4, 'now', 'This card has +1 for each different base power on your bench.'),
  K('streamer', 'Streamer', 'rainbow', 'B', 3, 4, 'now', 'Double every power bonus this card receives.'),
  K('skater', 'Skater', 'rainbow', 'C', 5, 4, 'now', 'If you lost the previous match, take 2 fans.'),

  // ---------------------------------------------------------------- Secret Base
  K('thief', 'Thief', 'secret', 'A', 1, 4, 'now', 'Put the top card from the Level-A-Pile on your exhaust pile.'),
  K('zombie', 'Zombie', 'secret', 'A', 2, 8, 'attack', 'This card has +1 for each card in your exhaust pile.'),
  K('rat', 'Rat', 'secret', 'A', 3, 3, null, ''),
  K('safecracker', 'Safecracker', 'secret', 'B', 3, 4, 'now', 'Put a card from your exhaust pile under your deck.'),
  K('getaway-vehicle', 'Getaway Vehicle', 'secret', 'B', 3, 4, 'now', 'Put up to two {secret}-cards from your bench on your exhaust pile.'),
  K('hacker', 'Hacker', 'secret', 'B', 5, 4, 'now', 'Look at the top three cards of your deck. Put one under, one on the top of your deck and one on your exhaust pile.'),
  K('snake', 'Snake', 'secret', 'B', 5, 3, null, ''),
  K('cabbage', 'Cabbage', 'secret', 'C', 3, 4, 'special', 'When this card would be put on your bench, put it on your exhaust pile instead.'),
  K('scientist', 'Scientist', 'secret', 'C', 5, 4, 'now', 'Put a Level-A-Card from your bench on top of your deck.'),
  K('mole', 'Mole', 'secret', 'C', 7, 2, null, ''),

  // ---------------------------------------------------------------- Beach Club
  K('kid', 'Kid', 'beachclub', 'A', 1, 3, 'now', 'If there is no card with base power 4 or higher on your bench, this card has +4.'),
  K('animateur', 'Animateur', 'beachclub', 'A', 2, 4, 'bench', 'Your Newcomer cards have +1.'),
  K('newcomer-bc', 'Newcomer', 'beachclub', 'A', 2, 4, 'special', 'This card must share a seat with any Newcomer card.'),
  K('seagull', 'Seagull', 'beachclub', 'A', 3, 3, null, ''),
  K('ice-cream-truck', 'Ice Cream Truck', 'beachclub', 'B', 3, 4, 'bench', 'Your {beachclub}-cards have +1.'),
  K('swimmer', 'Swimmer', 'beachclub', 'B', 3, 4, 'now', 'Choose a seat on your bench. This card has +1 for each card on it.'),
  K('surf-teacher', 'Surf Teacher', 'beachclub', 'B', 4, 4, 'picked', 'Draw three Level-A-Cards. Pick one of them as an extra-pick and discard the others.'),
  K('monkey', 'Monkey', 'beachclub', 'B', 5, 3, null, ''),
  K('sandstorm', 'Sandstorm', 'beachclub', 'C', 4, 4, 'now', 'Put the top card from the Level-C-Pile on top of your deck, without looking at it.'),
  K('diver', 'Diver', 'beachclub', 'C', 6, 5, 'now', 'Look at the bottom-most card of your deck. Put it on top of or under your deck.'),
  K('crocodile', 'Crocodile', 'beachclub', 'C', 7, 2, null, ''),

  // ---------------------------------------------------------------- Mountain Top
  K('yodeler', 'Yodeler', 'mountain', 'A', 2, 4, 'nowin', 'Take 1 fan.'),
  K('climber', 'Climber', 'mountain', 'A', 2, 4, 'now', 'If there is at least one card in your opponent’s exhaust pile, this card has +2.'),
  K('skier', 'Skier', 'mountain', 'A', 3, 5, 'now', 'Put a card from your opponent’s bench on their exhaust pile.'),
  K('goat', 'Goat', 'mountain', 'A', 3, 3, null, ''),
  K('snowman', 'Snowman', 'mountain', 'B', 3, 4, 'flag', 'This card has +3.'),
  K('vet', 'Vet', 'mountain', 'B', 4, 4, 'bench', 'Your cards with base power 3 have +1 during the attack.'),
  K('ice-bob', 'Ice Bob', 'mountain', 'B', 4, 4, 'bench', 'Your {mountain}-cards in flag possession have +1.'),
  K('eagle', 'Eagle', 'mountain', 'B', 5, 3, null, ''),
  K('yeti', 'Yeti', 'mountain', 'C', 6, 4, 'flag', 'Take 1 fan for every card that attacks this card.'),
  K('zeppelin', 'Zeppelin', 'mountain', 'C', 11, 3, 'now', 'If there is a Level-C-Card on your bench, you lose this match immediately.'),
  K('mammoth', 'Mammoth', 'mountain', 'C', 7, 2, null, ''),

  // ---------------------------------------------------------------- University
  K('quarterback', 'Quarterback', 'university', 'A', 1, 4, 'attack', 'This card has +1 for each of your fans, excluding those on Trophies.'),
  K('coffee-machine', 'Coffee Machine', 'university', 'A', 2, 4, 'bench', 'Your {university}-cards have +1 during the attack.'),
  K('cheerleader', 'Cheerleader', 'university', 'A', 2, 4, 'picked', 'Take 2 fans.'),
  K('hamster', 'Hamster', 'university', 'A', 3, 3, null, ''),
  K('professor', 'Professor', 'university', 'B', 3, 4, 'now', 'If there is at least one {university}-card on your bench, take 1 fan.'),
  K('janitor', 'Janitor', 'university', 'B', 4, 4, 'now', 'You may put a card with the lowest base power from your bench on your exhaust pile.'),
  K('personal-coach', 'Personal Coach', 'university', 'B', 4, 4, 'now', 'This card has +1 for each set of 5 fans, excluding those on Trophies.'),
  K('owl', 'Owl', 'university', 'B', 5, 3, null, ''),
  K('final-exam', 'Final Exam', 'university', 'C', 3, 4, 'now', 'This card has +1 for each card with base power 3 or lower on your bench.'),
  K('tutor', 'Tutor', 'university', 'C', 5, 4, 'now', 'Look through your deck. Choose any card and put it on top of your deck.'),
  K('gargoyle', 'Gargoyle', 'university', 'C', 7, 2, null, ''),

  // ---------------------------------------------------------------- Toy Store
  K('model-railway', 'Model Railway', 'toystore', 'A', 1, 4, 'nowin', 'Put a Level-A-Card from your bench on top of your deck.'),
  K('action-figure', 'Action Figure', 'toystore', 'A', 2, 4, 'nowin', 'Your next card has +2.'),
  K('puppet', 'Puppet', 'toystore', 'A', 2, 4, 'now', 'If there is at least one card below it, this card has +2.'),
  K('rocking-horse', 'Rocking Horse', 'toystore', 'A', 3, 3, null, ''),
  K('shop-clerk', 'Shop Clerk', 'toystore', 'B', 2, 4, 'now', 'If there is a {toystore}-card on your bench, your opponent puts the top card of their deck on their exhaust pile.'),
  K('wind-up-car', 'Wind Up Car', 'toystore', 'B', 2, 4, 'now', 'You may remove a card from your bench permanently. If you do, this card has +4.'),
  K('karaoke-kit', 'Karaoke Kit', 'toystore', 'B', 4, 4, 'nowin', 'Put the top card from the Level-B-Pile under your deck, without looking at it.'),
  K('bunny', 'Bunny', 'toystore', 'B', 5, 3, null, ''),
  K('game-collector', 'Game Collector', 'toystore', 'C', 3, 4, 'nowin', 'Your next card has +6.'),
  K('matryoshka', 'Matryoshka', 'toystore', 'C', 4, 4, 'picked', 'You may remove a card from your deck permanently to pick an extra card.'),
  K('giraffe', 'Giraffe', 'toystore', 'C', 7, 2, null, ''),

  // ---------------------------------------------------------------- Fairytale Forest
  K('fairy', 'Fairy', 'forest', 'A', 1, 4, 'now', 'Choose one seat of your bench. Put all cards from that seat on your exhaust pile.'),
  K('dwarf', 'Dwarf', 'forest', 'A', 2, 7, 'special', 'When this card would be put on your exhaust pile, put it on top of your deck instead.'),
  K('frog', 'Frog', 'forest', 'A', 3, 3, null, ''),
  K('grandmother', 'Grandmother', 'forest', 'A', 4, 4, 'picked', 'You must remove a card with base power 3 or higher from your deck permanently.'),
  K('mirror', 'Mirror', 'forest', 'B', 1, 4, 'nowin', 'Put a {forest}-card from your bench on top of your deck.'),
  K('gingerbread-man', 'Gingerbread Man', 'forest', 'B', 4, 4, 'bench', 'Your cards with base power 4 have +1 in flag possession.'),
  K('deer', 'Deer', 'forest', 'B', 5, 3, null, ''),
  K('troll', 'Troll', 'forest', 'B', 7, 3, 'special', 'When this card is put on your bench, place it across two seats or on another Troll. Otherwise you immediately lose this match.'),
  K('carriage', 'Carriage', 'forest', 'C', 4, 4, 'now', 'Choose one seat of your bench. Put all cards from that seat on your exhaust pile.'),
  K('unicorn', 'Unicorn', 'forest', 'C', 7, 2, null, ''),
  K('cauldron', 'Cauldron', 'forest', 'C', 8, 2, 'now', 'Remove a Level-A-Card from your bench permanently.'),
];

export const CARD = Object.fromEntries(CARDS.map((c) => [c.key, c]));

// Each player's six starting cards. The first box's is read off its S cards —
// three Newcomers, the Talent, the Dog and the Champion ("his Talent and his 3
// Newcomers", in the rulebook's example). The Beach Cup deck swaps in the Dog
// that looks at your top card; the rest is PROVISIONAL.
export const STARTER = {
  base: ['newcomer', 'newcomer', 'newcomer', 'talent-s', 'dog-s', 'champion-s'],
  beach: ['newcomer', 'newcomer', 'newcomer', 'talent-s', 'dog-look', 'champion-s'],
};

// What each round of the Deck Phase offers, top line of the Tournament Plan to
// the bottom. Each option is a Level pile, how many of the five cards drawn
// you keep, and (Beach Cup) the fans taking it pays.
export const DRAFT = {
  base: [
    [{ level: 'A', pick: 2 }],
    [{ level: 'A', pick: 2 }],
    [{ level: 'A', pick: 2 }, { level: 'B', pick: 1 }],
    [{ level: 'A', pick: 2 }, { level: 'B', pick: 2 }],
    [{ level: 'B', pick: 2 }],
    [{ level: 'B', pick: 2 }, { level: 'C', pick: 1 }],
    [{ level: 'C', pick: 2 }],
  ],
  beach: [
    [{ level: 'A', pick: 3 }],
    [{ level: 'A', pick: 2, fans: 2 }, { level: 'B', pick: 1 }],
    [{ level: 'A', pick: 2 }, { level: 'B', pick: 1 }],
    [{ level: 'A', pick: 2 }, { level: 'B', pick: 2 }],
    [{ level: 'B', pick: 2, fans: 2 }, { level: 'C', pick: 1 }],
    [{ level: 'B', pick: 2 }, { level: 'C', pick: 1 }],
    [{ level: 'C', pick: 2 }],
  ],
};

// The fans on the backs of the four Trophies of each round (one per park).
export const TROPHIES = [
  [2, 2, 2, 3],
  [2, 2, 3, 3],
  [3, 3, 4, 4],
  [5, 5, 6, 6],
  [6, 6, 6, 7],
  [7, 7, 7, 8],
  [9, 9, 10, 10],
];

export const ROUNDS = 7;
export const BENCH_SEATS = 6;
export const DRAW = 5;                 // cards drawn in the Deck Phase
export const LEAD_WIN = 11;            // two players: a lead this big ends it
