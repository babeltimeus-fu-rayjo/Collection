# Collection

Small static web games served from GitHub Pages — browse them at
**https://babeltimeus-fu-rayjo.github.io/Collection/**

Every game shares the same architecture: a pure rules engine (`game.js`), a
networking + UI layer (`app.js`), no build step, and no game server.

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
