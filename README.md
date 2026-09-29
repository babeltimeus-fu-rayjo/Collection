# Collection

Small static web games served from GitHub Pages — browse them at
**https://babeltimeus-fu-rayjo.github.io/Collection/**

Every game shares the same architecture: a pure rules engine (`game.js`), a
networking + UI layer (`app.js`), no build step, and no game server.

## Challengers!

**Play:** https://babeltimeus-fu-rayjo.github.io/Collection/challengers/

An unofficial fan implementation of **Challengers!** (2022) and **Challengers! Beach Cup** (2023) by Johannes Krenner & Markus Slawitscheck (© 1 More Time Games, Z-Man Games, Pretzel Games). 1–8 players; bots fill any empty seat, and the Robot takes the spare seat at an odd table.

- **Seven rounds, then a final.** Each round everyone drafts at once — draw five from the Level pile the round offers, keep what the plan says, redraw once, cut anything — and then plays one match against the next opponent on a round-robin schedule. The two players with the most fans (tokens plus the hidden fans on Trophies) play the final. Two players play no final and a lead of 11 fans ends it.
- **A match plays itself.** One card takes the flag; the other side turns cards over until their total equals or beats it; the card that loses the flag goes to its owner's bench with everything under it, one seat per name, six seats. Run out of cards on the attack, or have no seat for a new name, and you lose. The host steps every match of the round at once on a timer, and a card that asks its owner something — Reporter, Sailor, Clairvoyant, Butler, Hacker, Swimmer and the rest — pauses that match until they answer.
- **Both boxes, mixable.** The lobby picks a box (its basic set, starter decks and draft plan) and any five of the twelve additional sets. Beach Cup's Rainbow set counts as every set, *No flag win* and *Special* are in, round one keeps three, and two rounds pay 2 fans for taking the smaller option.
- **Provenance.** The rules follow the publishers' rulebooks: the [first box's](https://cdn.1j1ju.com/medias/33/f3/f9-challengers-rulebook.pdf) in English and Beach Cup's in [French](https://cdn.svc.asmodee.net/production-nextmove/uploads/2024/05/FR_ChallengersBC_RulesBooklet_lowres_compressed-1.pdf), the only language its full booklet is posted in. **Every character is read off pictures of the printed cards** — 141 cards from two community card galleries on TierMaker and the publisher's own samples, and the Newcomer from the Beach Cup rulebook: name, set, level, power, text and the printed *Rare 3x* / *Common 8x* counts, four copies when a card prints none. That gives an arithmetic check the transcription cannot pass by accident — **every one of the twelve additional sets holds exactly 40 cards, and each basic set 20**, as the rulebooks say — and [`test-cards.mjs`](challengers/test-cards.mjs) asserts it, along with each box's printed power limits (A ≤ 3, B ≤ 5, C ≤ 10 in the first box; 4, 7, 11 in Beach Cup). The draft each round is read off the Tournament Plans printed in the rulebooks (the first box: 2A, 2A, 2A or 1B, 2A or 2B, 2B, 2B or 1C, 2C); the Trophy fans are Board Game Arena's (2-2-2-3 in round one up to 9-9-10-10 in round seven).
- **The Robot, at level 1.** At an odd table the Robot takes the spare seat, as the rulebook has it: it does nothing in the Deck Phase and plays its own eight start cards — Alpha 1, Beta 2, Good Bot 3, C.H.A.M.P. 4 and four Cyborgs, whose base power is the round — and "if the Robot wins the match, place the Trophy of the current round back into the box": it is never ranked and never plays the final. A player alone plays it by the two-player rules, where it keeps its Trophies and can win. Its cards are read off two review photographs of them — [GeekDad's](https://geekdad.com/2023/04/assemble-your-team-for-challengers/) (the English edition, all nineteen Robot cards) and [Teilzeithelden's](https://www.teilzeithelden.de/2023/05/23/rezension-challengers-capture-the-flag-all-stars/) (the German edition, the start cards' text boxes in full). Alpha's text box is covered in both; like the other three it is taken to print none.
- **Not in yet, and provisional.** The Robot's harder levels — its eight R cards and three SOLO cards, only partly legible in the photograph — and Beach Cup's sixteen Trainers are not implemented. Bots are full players, who draft, play and score like anyone and can win. The split of the City set's twenty cards between Talent, Dog and Champion copies, and the Beach Cup starter decks beyond the Newcomer and the new Dog, are provisional and marked in [`challengers/cards.js`](challengers/cards.js). The printed Tournament Plans' exact pairings are replaced by a round-robin with the same effect: someone new every round while there is someone new.
- **Bots.** *Quick* drafts by instinct. *Steady* plays a hundred and sixty practice matches in its head for every candidate pick and every cut — a match takes about 0.02 ms to simulate — against benchmark decks drafted at random from the sets in play, never anyone's real deck, drawing from its own shuffled copy of the piles. It won 70–80% of two-player tournaments against Quick and took the championship in eight or nine of ten four-player ones with two of each. In a match every bot choice follows simple local rules: strongest card on top, weakest underneath, clear a seat that lends nothing, never free a seat on the other bench.
- **Tests:** `node challengers/test-cards.mjs` (the arithmetic above), `node challengers/test-effects.mjs` (each rule and each kind of effect on stacked decks: equal takes the flag, same names share a seat, the seventh name loses, immediate bonuses kept and attack bonuses dropped in flag possession, flag loss before flag gain, the Cowboy, the Yeti, the Troll, the Dwarf, the Zeppelin, No flag win, forced choices answering themselves, the Deck Phase's picks and single redraw), `node challengers/test-play.mjs` (192 bot tournaments across both boxes and mixed sets at every count from one to eight, with a census after every step that no card is ever lost or duplicated, and the Robot's rules checked after each: it never drafts, keeps its eight cards, and at a table of three or more never holds a Trophy, is never ranked and never plays the final) and `node challengers/test-bot.mjs` (that the bot's choice cannot see anyone else's deck and leaves the piles untouched, and that Steady beats Quick).

## Toy Battle

**Play:** https://babeltimeus-fu-rayjo.github.io/Collection/toybattle/

An unofficial fan implementation of **Toy Battle** by Paolo Mori & Alessandro Zucchini (© Repos Production). Exactly 2 players; the host can fill the second seat with a bot.

- Each turn is one action: **draw 2 Troops** onto your rack (cap 8), or **place 1 Troop** and apply its effect, then its base's effect if that base is special.
- You may place on an empty base, one of your own, an enemy Troop of **strictly lower** strength, or the enemy H.Q. — and every placement must sit at the end of a continuous path from your own H.Q. running only through bases **you** occupy.
- Win by capturing the enemy H.Q., by reaching the Terrain's Medals objective, or — if a player can neither draw nor place — on Medals, with **ties going against whoever ran dry**.
- **Provenance, and it is uneven.** The rules, all eight Troops (Kwak the joker, Skully 1, Cap'n 2, Jumbo 3, Hook 4, XB-42 5, Star 6, Roxy 7) with their effects and printed Notes, and all eight Terrain powers are transcribed from the publisher's English [rulebook](https://cdn.svc.asmodee.net/production-rprod/storage/games/toy_battle/rules/toy-en01-rules-1744030094a4kQo.pdf) and [player aid](https://cdn.svc.asmodee.net/production-rprod/storage/games/toy_battle/helpsheet/toy-en01-player-aid-mkt-1750679915Pm3l4.pdf). **All eight board layouts are transcribed from photographs of the physical boards**, taken and marked up by their owner, since Repos publishes no straight-down scan of them. Each Terrain in [`toybattle/game.js`](toybattle/game.js) records its `source` and the lobby shows it; every one reads from the board, and every detail has been checked against the board by its owner — paths, Medals, special bases, objectives and Tropical Pool's value triangles.

  | Terrain | Bases | H.Q. | Paths | Medals | Objective | Notes |
  | --- | --- | --- | --- | --- | --- | --- |
  | Castle Field | 15 | 2 | 24 | 14 | 7 | the apron by each keep is walled by the moat |
  | Tropical Pool | 13 | 4 | 24 | 12 | 6 | two H.Q. a side, one way into each; floats take 1/2, 3/4/5 or 6/7, all plus the joker |
  | City of Clouds | 14 | 2 | 28 | 16 | 8 | landscape, drawn turned |
  | Volcanic Jungle | 13 | 2 | 22 | 14 | 7 | blue's H.Q. at the top of the printed board |
  | Cursed Cemetery | 15 | 2 | 28 | 14 | 7 | landscape |
  | Caribbean Sea | 12 | 3 | 20 | 11 | 5 | asymmetric: two blue H.Q. against one red |
  | Station Metal-X | 13 | 2 | 26 | 14 | 7 | landscape |
  | Battlefield | 14 | 2 | 24 | 16 | 8 | landscape |

  Two patterns held on every board: **a region ringed by n bases holds n − 2 Medals**, an H.Q. on the ring not counted, and **the objective is half the board's Medals, rounded down**. `test-effects.mjs` enforces both, which makes the Medal counts a free check on the paths: a missed or invented path changes how many bases ring a region. The board is drawn turned so each player sees their own H.Q. at the bottom, whichever way the printed board puts it.

- **Boards are written as data** at the top of `game.js`: nodes tagged `hq0`/`hq1`/`special`/`only:…`, a list of path segments, and regions given as the nodes that bound them. Each board keeps the frame it was copied in off its photograph (`frame`, and which way up its `card` lies), and the parser turns every one into millimetres on the real 40 × 24 cm card — the frames did not share the card's proportions, and percentages had squashed Castle Field and Tropical Pool to three fifths of their height. The real boards needed all of that — regions ringed by three to six bases, regions walled by a moat rather than a path, two H.Q. a side, value limits on individual H.Q. — and the parser rejects a path to a node that does not exist or a region whose nodes are not even joined.
- **Drawn to be read.** The printed tiles are about 3 cm on paths of 6 to 10, which reads across a table and not on a phone, so the screen draws its bases half again as big relative to the paths — and [`toybattle/layout.js`](toybattle/layout.js) then nudges only what would crowd: every base at least 24px clear of every other, every path 14px clear of any base it does not reach, and nothing more than 26px from where the card prints it (most move under 8). Medals go wherever their region has the most open ground. On a landscape screen the board takes the full height with the scoreboard and your rack beside it.
- **Reading the table.** Hover anything — a Troop in your hand or on the board, a special base, an H.Q., a count — and it explains itself after a tenth of a second; on a phone, tap anything that is not a move. The Troop you pick up shows its card above the prompt. One scoreboard puts **Medals, Hand and Reserve** in columns, a row per player. For practice the host can **show the bot's hand** — the 👁 beside its name, or *Show the bot's hand* under ⚙ Testing; it is only ever a real bot's rack, never a disconnected player's that a bot is covering.
- **The bot searches.** It runs alpha-beta over the real engine with iterative deepening, and it is not allowed to cheat: the opponent's rack is hidden and both reserves are shuffled, so before searching it throws away everything it is not entitled to know and deals a plausible hand from what is public — its own rack, the stacks on the board (which the rules let anyone inspect), the discard, and how many Troops the opponent holds. Pointing at a Troop for the Battlefield sniper is blind by the rules, so it generates one move standing for all of them. Four skill levels are picked in the lobby; each carries a wall-clock ceiling as well as a node budget, so the same level plays the same way on a laptop and a phone and cannot freeze the tab.
- **What the search is worth, measured.** Every rung of the ladder beats the one below it over 100 games with seats swapped each game — Steady beats Quick 66%, Sharp beats Steady 59%, Ruthless beats Sharp 58%, and Ruthless beats Quick **78%**. The ladder stops at Ruthless because that is where it stopped separating: a search four times bigger than Ruthless scored 48% against it, so the extra thinking was buying nothing and the levels were rescaled down to where the difference is real. Ruthless costs about 25ms a move.
- **The sharper signal is blunders** — turns that leave your own H.Q. open to an immediate capture when another legal move would not have. The one-ply bot does that on about 0.16% of its turns; the searching bot runs at 0.0–0.4%, and the test fails if it ever exceeds 3%.
- **What did not work**, all measured and all reverted: weighting a region corner by the strength of the Troop holding it (46% over 200 games), averaging two or three determinized deals instead of searching one of them deeper (45–52%), and late-move pruning (51% over 400 games). Depth is what pays here, up to a point; the rest was complexity for nothing.
- **Tests:** `node toybattle/test-layout.mjs` (every board on the card, and drawn with no base touching another, no path under a base it does not reach, nothing far from its printed spot, and every Medal on open ground in its own region), `node toybattle/test-bot.mjs` (that the bot cannot see through the opponent's rack — the same position is put to it twice under a pinned RNG with the hidden rack swapped, and the answer has to match — plus that it takes an open H.Q., does not hang its own, and beats the shallow bot), `node toybattle/test-play.mjs` (tile conservation, Medal bookkeeping and turn passing over 320 bot games, one check per action) and `node toybattle/test-effects.mjs` (each rule by hand, then a sweep confirming every Troop and every Terrain power actually fires in play).

## dnup

**Play:** https://babeltimeus-fu-rayjo.github.io/Collection/dnup/

An unofficial fan implementation of **dnup** by Kei Kajino & Gilles-Romain Fonteny (© Asmodee Group), following the [official rules](https://www.dnup.game/rules/rules_en.pdf). 2–5 players; the host can fill empty seats with bots.

- Every card has an **active value** (upright) and an **inactive value** (upside down). Anything you take from the table is rotated 180° as it enters your hand — *that's a dnup*.
- All cards are dealt out (8 each). On your turn you discard the set in front of you, then do exactly one action: **play a set** (must beat any same-size set on the table, which bounces back to its owner rotated), **add one matching card** to an opponent's set, **take an opponent's set** (rotated), or **rotate your whole hand**.
- First player out scores **+2** (their last set lingers one lap), second out scores **+1** and ends the round. First to **4 points** wins. Two players use the official duel variant: two play areas each, two consecutive turns, first to **2 round wins**.
- **Deck:** the `DECK_*` arrays in [`dnup/game.js`](dnup/game.js) are the real 40-card manifest transcribed from the physical deck — 26 base cards plus setup groups of 4 (3+ players), 6 (4+), and 4 (5). All cards are always dealt, so hands are 13 / 10 / 9 / 8 at 2 / 3 / 4 / 5 players. High values are scarce by design: three 10s and five 9s in the whole deck.
- **Bots:** the host adds/removes bot players in the lobby (🤖). Bots run in the host's browser and choose among all four actions with simple lookahead heuristics (`botChoose`).

## Love Letter

**Play:** https://babeltimeus-fu-rayjo.github.io/Collection/loveletter/

An unofficial fan implementation of **Love Letter** by Seiji Kanai (© Z-Man Games / Asmodee), using the Premium edition's expanded cast. 2–8 players, bots included.

- Hold one card, draw one, play one, and use its effect to deduce what everyone else holds. Last player standing wins the round — or the highest card when the deck runs out.
- The full Premium cast is implemented: Assassin and Jester (0), Guard (1), Priest and Cardinal (2), Baron and Baroness (3), Handmaid and Sycophant (4), Prince and Count (5), King and Constable (6), Countess and Dowager Queen (7), Princess (8) and Bishop (9) — including the Assassin's counter-strike, the Sycophant's forced targeting, the Bishop's guess-and-redraw, and the Count's showdown bonus.
- **Deck note:** the deck grows with the table — the 16-card classic core at 2–4 players, 24 at 5–6, and the full 32 at 7–8. The 32-card composition matches the Premium box; how the intermediate tiers are trimmed is a reconstruction, kept as plain data at the top of [`loveletter/game.js`](loveletter/game.js).
- Token targets follow the printed rules: 6 to win at 2 players, 5 at 3, 4 at 4, 3 at 5+.

### How multiplayer works

No game server. The site is static (GitHub Pages) and play is peer-to-peer:

- **WebRTC data channels** carry all game traffic directly between browsers.
- **STUN servers** (Google's public ones, `stun.l.google.com:19302` etc.) are used for NAT traversal, configured in [`dnup/app.js`](dnup/app.js) (`RTC_CONFIG`).
- **Signaling** (how peers first find each other) uses the free [PeerJS](https://peerjs.com) cloud broker, because static hosting can't run a signaling server. Only handshake metadata passes through it.
- Topology is a **host-authoritative star**: the room creator's browser owns the game state, validates every move, and sends each player a personalized view (you never receive other players' hands). If the host closes the tab, the room ends.
- Players behind very strict/symmetric NATs may fail to connect with STUN alone; add a TURN server entry to `RTC_CONFIG` if you need one.

### Develop locally

Any static file server works:

```bash
python3 -m http.server 4179
```

then open `http://localhost:4179/dnup/`. Multiplayer works between two tabs.

Both games are fuzz-tested at the engine level (random-legal and all-bot playouts across every player count, checking card conservation, termination, and rules invariants).

Code layout: [`dnup/game.js`](dnup/game.js) is the pure rules engine (deck manifest, legality helpers shared with clients, bot brain); [`dnup/app.js`](dnup/app.js) is networking (PeerJS) + UI; no build step, no dependencies beyond the PeerJS CDN script. Engine invariants are fuzz-tested (random-legal and all-bot playouts across every player count).
