# Lucky Pixel Lounge

A cozy 8-bit casino RPG built with vanilla JavaScript, Canvas 2D, and HTML/CSS overlays. It now includes a walkable town loop, a cosmetics economy, and train travel between two towns.

## Run

Open `index.html` in a browser, or serve the folder with any static server:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## Controls

| Where      | Keys |
| ---------- | ---- |
| Overworld  | `WASD` / arrow keys move, `E` / `Space` interact near dealer, station, or cosmetics counter |
| Blackjack  | `1`–`4` bet 10/20/50/100, `Enter` deal/new hand, `H` hit, `S` stand, `Esc` / `E` leave |
| Cosmetics  | Click Buy/Equip buttons, `Esc` leaves the shop panel |
| Anywhere   | `M` mutes/unmutes master audio; speaker button opens Sound settings (`Esc` closes) |

## World Loop

- Start inside the casino; walk out through the bottom exit into town.
- Town has four shops: casino, cosmetics, butcher, fishing.
- Butcher and fishing shops are walk-in only (no interactions yet).
- Cosmetics shop sells hats, outfits, and unlockable songs.
- At the edge train station, boarding costs **1500 tokens**.
- The train moves you between Town 1 and Town 2 (currently mirrored layouts), with return travel from the opposite-side station.

## Rules

- You start with **500 tokens**. Bets are 10, 20, 50 or 100, and the bet is taken from your balance when you deal.
- The shoe has 4 decks. It is reshuffled before a hand when fewer than 20 cards remain.
- Aces count as 11 or 1. A natural (a two-card 21) ends the round straight away.
- You can Hit or Stand. Reaching 21 stands automatically, and going over 21 is a bust.
- The dealer draws on 16 and stands on all 17s, including soft 17.
- A win pays 1:1, a natural blackjack pays 3:2, and a push returns your bet.
- You can only leave the table between hands. If you run out of tokens, the house lets you rebuy.

## Cosmetics & Songs

- Cosmetics are purchased with the same token balance used at blackjack.
- Owned cosmetics can be equipped from the cosmetics panel.
- Songs are also unlockables; equipped songs are selected in the Sound menu and affect town-area music.

## Audio

No audio files are needed. Everything is generated in the browser by `audio.js`:

- **Music:** a slow, generative piece in the style of a Gymnopédie. It is scheduled continuously, so the loop never has a seam, and the melody varies on each pass.
- **Area themes:** music themes switch by area (casino, town, cosmetics, butcher, fishing, station).
- **Effects:** card shuffle, deal and flip, chip clinks, footsteps on the carpet, UI clicks and hover ticks, win/lose/bust/blackjack stingers, and a quiet room tone with occasional distant slot machines.
- **Dealer voice:** spoken with the browser's built-in speech synthesis. The dealer greets you, prompts you to hit or stand, and reacts to wins, busts and blackjacks. Voice quality depends on the voices installed on your system.
- **Settings:** the speaker button opens independent Master, Music, Effects and Dealer sliders, each with a mute toggle. They are saved in `localStorage`.

Browsers block audio until you interact with the page, so sound starts on your first key press or click.

## Files

- `index.html`: the canvas, HUD, blackjack overlay and sound settings dialog
- `style.css`: the retro palette and pixel-scaled UI. All sizes use `--px`, so the UI scales together with the canvas.
- `script.js`: the game, split into config, sprites, input, world, collision, renderer, the blackjack engine (pure logic that emits events), the blackjack UI, and the main loop, which maps game events to sound
- `audio.js`: the audio system (`window.CasinoAudio`): settings store, Web Audio core, effects, themed music, ambience, dealer voice and settings UI
