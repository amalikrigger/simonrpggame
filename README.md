# Lucky Pixel Lounge

A story-driven 8-bit casino RPG built with vanilla JavaScript, Canvas 2D, and HTML/CSS overlays.

The latest build includes a full opening cutscene arc: construction job, crash, hospital recovery, getting fired, eviction, and finally your choice to gamble at the casino to win your life back.

## Run

Open `index.html` in a browser, or serve the folder with any static server:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## Controls

| Where | Keys |
| --- | --- |
| Overworld | `WASD` / arrow keys move, `E` / `Space` interact |
| Blackjack | `1`-`4` bet, `Enter` deal/new hand, `H` hit, `S` stand, `Esc` leave |
| Slots | `Space` / `Enter` spin lever, `Esc` leave |
| Poker | `1`-`5` hold cards, `Enter` deal/draw/new hand, `Esc` leave |
| Roulette | choose a chip, click board, `Enter` spin, `Esc` leave |
| Plinko | choose chip, `Enter` drop, `Esc` leave |
| Anywhere | `M` mute/unmute master audio, speaker icon opens sound settings |

## Story And World Loop

1. The game opens with a multi-scene intro cutscene.
2. You enter the casino world and can play to build cash.
3. Town progression unlocks station travel and higher-stakes districts.
4. Later towns add the Black Market, loan systems, and robbery consequences.
5. The grand lounge unlocks additional game tables and machines.

## Major Features

- Opening narrative cutscene with cinematic scene transitions.
- Core casino loop with blackjack and slots.
- Extended games in the grand lounge: draw poker, roulette, and plinko.
- Walkable multi-town overworld with station travel.
- Black Market relic upgrades.
- Bank and back-room loan shark systems.
- Dynamic events including robbery cutscene outcomes.
- Cosmetics and song unlock economy.

## Blackjack Rules

- You start with a token balance and can bet 10, 20, 50, or 100 per hand.
- The shoe has 4 decks. It is reshuffled before a hand when fewer than 20 cards remain.
- Aces count as 11 or 1. A natural (a two-card 21) ends the round straight away.
- You can Hit or Stand. Reaching 21 stands automatically, and going over 21 is a bust.
- The dealer draws on 16 and stands on all 17s, including soft 17.
- A win pays 1:1, a natural blackjack pays 3:2, and a push returns your bet.
- You can only leave the table between hands.

## Economy And Upgrades

- Cosmetics and songs are bought with tokens.
- Black Market relics add mechanical bonuses.
- Bank and shark loans change your risk profile and progression path.

## Audio

No audio files are needed. Everything is generated in the browser by `audio.js`:

- **Music:** generative looping tracks and unlockable themes.
- **Area themes:** per-area music switching across casino, town, shops, station, and lounge scenes.
- **Effects:** cards, chips, slots, train, cutscene cues, crowd ambience, and UI sounds.
- **Dealer voice:** browser speech synthesis for table interactions.
- **Settings:** the speaker button opens independent Master, Music, Effects and Dealer sliders, each with a mute toggle. They are saved in `localStorage`.

Browsers block audio until you interact with the page, so sound starts on your first key press or click.

## File Layout

- `index.html`: app shell, overlays, HUD, and canvas mount
- `style.css`: pixel-art UI styles and overlay layouts
- `script.js`: core gameplay state, rendering, world systems, minigames, and cutscenes
- `audio.js`: generated music/effects engine and audio settings
- `qa_smoke.mjs`: basic smoke automation flow
