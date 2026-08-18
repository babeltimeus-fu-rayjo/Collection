# Collection

Small static web games served from GitHub Pages — browse them at
**https://babeltimeus-fu-rayjo.github.io/Collection/**

Both games share the same architecture: a pure rules engine (`game.js`), a
networking + UI layer (`app.js`), no build step, and no game server.

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
