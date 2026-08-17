# Collection

Small static web games served from GitHub Pages.

## DNUP

**Play:** https://babeltimeus-fu-rayjo.github.io/Collection/dnup/

DNUP is a "down-up" shedding card game for **2–5 players**:

- Deck: numbers 1–10 in four colors, two copies of each (80 cards). Everyone starts with 7 cards; first to empty their hand wins.
- The pile always has a direction, **UP** or **DOWN**. Play a card that follows the direction (strictly higher when UP, strictly lower when DOWN), matches the top card's color, or matches its number.
- A number match **flips the direction**. A 10 always turns the game DOWN, a 1 always turns it UP.
- Can't play? Draw one card and your turn ends. The discards get reshuffled when the draw pile runs out.

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

Code layout: [`dnup/game.js`](dnup/game.js) is the pure rules engine (host-authoritative, also used by guests to highlight legal cards); [`dnup/app.js`](dnup/app.js) is networking (PeerJS) + UI; no build step, no dependencies beyond the PeerJS CDN script.
