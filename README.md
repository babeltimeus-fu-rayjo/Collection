# Collection

Small static web games served from GitHub Pages.

## dnup

**Play:** https://babeltimeus-fu-rayjo.github.io/Collection/dnup/

An unofficial fan implementation of **dnup** by Kei Kajino & Gilles-Romain Fonteny (© Asmodee Group), following the [official rules](https://www.dnup.game/rules/rules_en.pdf). 2–5 players; the host can fill empty seats with bots.

- Every card has an **active value** (upright) and an **inactive value** (upside down). Anything you take from the table is rotated 180° as it enters your hand — *that's a dnup*.
- All cards are dealt out (8 each). On your turn you discard the set in front of you, then do exactly one action: **play a set** (must beat any same-size set on the table, which bounces back to its owner rotated), **add one matching card** to an opponent's set, **take an opponent's set** (rotated), or **rotate your whole hand**.
- First player out scores **+2** (their last set lingers one lap), second out scores **+1** and ends the round. First to **4 points** wins. Two players use the official duel variant: two play areas each, two consecutive turns, first to **2 round wins**.
- **Deck note:** the rulebook doesn't publish the 40-card pairing manifest, so [`dnup/game.js`](dnup/game.js) uses a reconstruction: all value pairs 1–10 minus five unseen ones, every value appearing exactly 8 times, every card shown in the rulebook examples present, and setup groups (base/3+/4+/5) sized so every player count deals exactly 8 cards. Swap the `DECK_*` arrays if the official list surfaces.
- **Bots:** the host adds/removes bot players in the lobby (🤖). Bots run in the host's browser and choose among all four actions with simple lookahead heuristics (`botChoose`).

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

Code layout: [`dnup/game.js`](dnup/game.js) is the pure rules engine (deck manifest, legality helpers shared with clients, bot brain); [`dnup/app.js`](dnup/app.js) is networking (PeerJS) + UI; no build step, no dependencies beyond the PeerJS CDN script. Engine invariants are fuzz-tested (random-legal and all-bot playouts across every player count).
