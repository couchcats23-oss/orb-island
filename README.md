# ORB ISLAND · Last Signal

A fan-made, non-commercial, browser-based multiplayer survival game inspired by the anime *Btooom!*
Parachute onto a huge tropical island, scan with the chip in your left hand, throw explosive orbs, and take chips from the other players.
Desktop browsers only (keyboard + mouse). 2–12 players per match, matchmaking queue, proximity voice chat, full graphics settings.

> Not affiliated with, or endorsed by, the creators or publishers of the series. The name, characters, logos and audio are **not** used:
> everything here is original code; all textures are generated in the browser and all sound is synthesised with WebAudio.

---

## Run it

Requires **Node.js 18+**. No `npm install` is needed (zero dependencies).

```bash
node server.js            # then open http://localhost:8080
MIN_PLAYERS=1 node server.js   # solo test: a match starts with one player
```

Open the page, enter a callsign and press **PLAY**. The game joins the matchmaking queue; the match drops once 2+ players are
waiting (25 s countdown, or 6 s when the lobby is full). Use a **private lobby code** (same code = same lobby) to play with friends.
No one else online? Use **Practice** on the menu to play against computer players (see below).

The 3D engine ([three.js r170](https://threejs.org)) is loaded from the jsDelivr CDN, so players need internet access.

### Playing with friends over the internet

Browsers only allow **microphone access on HTTPS or localhost**, so voice chat needs a secure URL. Easiest options:

* **Tunnel your PC**: `cloudflared tunnel --url http://localhost:8080` or `ngrok http 8080`, then share the https link.
* **Deploy**: any Node host works (Render, Railway, Fly.io, a VPS). A `Dockerfile` is included; the host provides HTTPS and sets `PORT`.
* **Same Wi-Fi**: `http://<your-LAN-ip>:8080` works for gameplay but not for the mic (unless you whitelist the origin in
  `chrome://flags/#unsafely-treat-insecure-origin-as-secure`).

Voice uses WebRTC peer-to-peer (the server only relays signalling). It defaults to public Google STUN servers. If two players cannot hear
each other (strict NAT / corporate networks) add a TURN server:

| Variable | Meaning | Default |
|---|---|---|
| `PORT` / `HOST` | listen port / interface | `8080` / `0.0.0.0` |
| `MIN_PLAYERS` / `MAX_PLAYERS` | players needed to start / lobby size (max 12) | `2` / `12` |
| `COUNTDOWN` | seconds before a match starts once min players are in | `25` |
| `MAX_PRACTICE` | practice (bot) matches the server runs at once; extra requests are told it is busy | `4` |
| `STUN_URLS` | comma-separated STUN urls | Google STUN |
| `TURN_URL`, `TURN_USER`, `TURN_PASS` | optional TURN relay | none |

---

## How to play

Everyone has an **IC chip** in their left hand. Eliminate players and pick up the chips they drop. Collect **3 chips** (or be the last
survivor) to win. At 13:00 the most chips (then most health) wins. Falling in deep water far from shore drains health.

**Chip radar (Q)** – pulses a 150 m circle and shows **moving** players on your hand/HUD radar (heading-up). Everyone inside the circle
gets a warning with the direction of the scan, so scanning reveals you too. Two scans within half a second of each other cancel out.
Standing still keeps you off the radar. 4 s recharge.

**Orbs** – eight slots on your bandolier (3 Cracker, 2 Timer and 3 random specials at the start). Resupply from glowing caches at the
landmarks (village, compound, relay tower, plane wreck, pier, standing stones, survivor camp) or from fallen players.

| Orb | Behaviour |
|---|---|
| Cracker | Explodes on impact. |
| Timer | Fuse 1–10 s, adjust with Z / X. Bounces. |
| Implosion | Sticks, drags everything inward for ~2 s, then collapses and flattens trees. |
| Blazing Gas | Burst of burning toxic cloud that drifts with the wind (flushes people out of forest). |
| Homing | Small propeller orb that locks onto the nearest player in 40 m. Weak blast. |
| Remote | Sticks to any surface; detonate with **G** (oldest) or **Shift+G** (all). |
| Flame | 1300 °C oil that splits into four fire lines in a cross. |
| Barrier | Worn, not thrown: a 7 s energy barrier that stops blasts, gas and fire. |

Blast damage falls off with distance, and terrain or walls absorb most of it. Orbs can hurt you, so mind your throws.

### Controls

| Key | Action | Key | Action |
|---|---|---|---|
| W A S D | move (glide while parachuting) | Left mouse (hold) | wind up and throw |
| Shift | sprint (stamina) | Right mouse | short lob |
| Space | jump | 1–8 / mouse wheel | select orb |
| C (hold) | crouch | Z / X | timer fuse − / + |
| Q | chip radar | G / Shift+G | detonate remote orb(s) |
| V (hold) | push-to-talk | M | mute / unmute mic |
| Enter | text chat | Tab | scoreboard |

Dead players spectate (click or A / D to switch).

### Practice mode (play against bots)

The **Practice** box on the main menu starts a private match against computer players: pick a difficulty (**Easy / Normal / Hard / Mixed**)
and 3, 5, 7 or 11 bots, then press **Play vs bots**. The match starts a few seconds later, with the same island, rules, orbs, chips and win
conditions as an online game. Nobody else can join, and there is no voice chat.

It is called "practice" rather than "offline" because the bots live **in the server**, so you still need the server running and the page
open from it (on a free host that means the same URL you always use). Nothing extra to install.

The bots are meant to be opponents rather than target dummies. They only use information a human would have: they see inside a view cone with
line of sight, hear footsteps, read their own chip radar, and get the same scan warnings you do. Each has a play style:

| Style | Behaviour |
|---|---|
| Hunter | scans often, pushes toward contacts, fights at medium range |
| Ambusher | hides, scans rarely, lays remote orbs and gas traps, fights from range |
| Scavenger | grabs caches and dropped chips first, fights when it is well stocked |
| Flanker | circles round to attack from the side or behind, close-range fights |

In a fight they peek out of cover and strafe, lead moving targets, pick the orb for the situation (flat throws at distance, gas to flush you out
of cover, flame lines, implosion orbs on groups, remote orbs they detonate when you walk past, barriers when hurt), dodge incoming orbs and run
for the edge of a blast. They save their last orbs for good shots, and when nobody has met anyone for a while they start closing in (late in the match
they get more aggressive), so matches do not stall. **Easy** reacts slowly and misses a lot, **Normal** is a fair fight, **Hard** reacts fast,
aims tight and almost always dodges the first throw. **Mixed** gives each bot a random level.

Bots cost the server little (about 0.15 ms per bot tick when tested), so a free Render instance copes, but a practice match still
shares that small CPU with any human matches, which is why `MAX_PRACTICE` caps how many run at once.

### Voice chat

WebRTC mesh between everyone in the lobby. *Proximity* mode (default) is positional 3D audio that fades with distance (6–90 m);
*Global* mode lets the whole lobby hear each other. Push-to-talk or open mic. Press **Enable microphone** in the lobby or **V** in-game.

---

## Graphics settings

Settings → Graphics has **Potato / Low / Medium / High / Ultra** presets plus per-option control. The biggest wins for slow machines are
**Render scale**, **View distance**, **Shadows**, **Grass** and **Anti-aliasing**. Settings are saved in the browser.

| Setting | What it changes |
|---|---|
| Render scale | internal resolution (50–125 %) |
| View distance / Tree distance | terrain chunk and forest streaming radius, fog |
| Foliage detail | tree model detail switch distance |
| Grass & ferns | instanced ground cover density |
| Shadows / Shadow distance | sun shadow map size and range |
| Water quality | ocean mesh density, normal-map layers, shore foam |
| Effects | particle counts for explosions, gas, fire |
| Anti-aliasing | MSAA 2×–8× |
| Bloom, FOV, FPS limit, bob, FPS counter | as named |

### Low-end laptops and Chromebooks (e.g. Acer C740)

The game page only needs a browser, but **the server needs Node.js**, which a Chromebook can only run through *Linux (Beta)*
(Settings → About ChromeOS → Developers). Older models often don't offer it; Google's schedule lists the C740's ChromeOS updates as ending
in June 2021. If the option is missing, run the server somewhere else and just open its URL in Chrome:

1. **Free host** (Render, Railway, Koyeb, Fly.io…): put this folder in a GitHub repository (the website's *Upload files* button works), create a
   *Web Service* from it with start command `node server.js` (no build step needed; or use the included `Dockerfile`). You get an `https://` URL,
   which also fixes the microphone rule. Free tiers usually sleep when idle, so the first visit can take about a minute to wake up.
2. **A friend's PC** with Node.js: `node server.js` plus `cloudflared tunnel --url http://localhost:8080`, then share the link.

On dual-core / low-memory machines the game picks the **Potato** preset on first run (50 % render scale, short view distance, no shadows,
grass or bloom, 30 FPS cap). Expect modest frame rates on a Celeron-class chip; to squeeze out more, close other tabs, keep the laptop on
power, and lower *Render scale* or *View distance* further. Trackpad tips: **two-finger click** (or Alt + click) is the right mouse button;
a USB mouse makes charged throws easier. Use headphones so the microphone doesn't pick up the game and echo. The game needs WebGL2
(Chrome ~90 or newer; check `chrome://version`).

---

## Project layout

```
server.js            HTTP static server, WebSocket, matchmaking, authoritative orb/sonar/pickup simulation, voice signalling, practice lobbies
bot_brain.js         bot players: perception (sight/hearing/radar), difficulty levels, play styles, state machine
bot_think.js         bot decisions: where to drop, roam, loot, hide, ambush, flee, hunt   bot_combat.js  duels, orb choice, aiming, traps
bot_aim.js           ballistic solver that mirrors the server's orb physics              bot_nav.js     bot movement, steering, line of sight
bot_util.js          small helpers for the bot files
public/index.html    all UI screens          public/style.css
public/js/main.js    renderer, menu, lobby, settings, results, main loop
public/js/game.js    in-match client: input, movement, throwing, interpolation, events
public/js/world.js   chunked LOD terrain, forests, grass, ocean, sky, landmarks   (shared: terrain.js)
public/js/terrain.js deterministic height-field, trees, colliders: identical on server and client
public/js/effects.js particles, shock rings, scorch decals      public/js/orbmesh.js  orb / player / first-person models
public/js/hud.js     HUD and chip radar                         public/js/audio.js    synthesised sound
public/js/voice.js   WebRTC voice chat                          public/js/net.js      WebSocket client
public/js/rules.js   shared constants and orb stats             public/js/settings.js graphics presets / storage
```

Tuning gameplay is mostly editing `public/js/rules.js` (match length, chip goal, radar range, orb stats).

## Notes and limits

* Movement is client-authoritative with a server anti-teleport check: fine for friends, not hardened against cheaters.
* Matches are held in server memory; restarting the server drops all lobbies.
* Bot behaviour was tuned with headless simulations of full matches (and the practice screens were exercised in a browser with a stubbed 3D engine),
  not by playing every difficulty by hand. If a bot feels too easy or too hard, the numbers are in `LEVELS` and `PERSONAS` at the top of `bot_brain.js`.
* Needs a WebGL2 browser (current Chrome, Edge, Firefox).
* If the page stays black, an error box lists what failed (usually a blocked CDN or no WebGL2). `window.__orb` exposes the game objects in the console for debugging.
