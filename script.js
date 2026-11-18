/* ==========================================================================
   Lucky Pixel Lounge — a cozy 8-bit casino RPG
   --------------------------------------------------------------------------
   Vanilla JS + Canvas 2D. No dependencies.

   Sections:
     1. Config & palette
     2. Pixel-art assets (sprite maps + pre-rendering)
     3. Utilities
     4. Input handler
     5. World (room layout, props, colliders)
     6. Entities (player, dealer)
     7. Collision & proximity
     8. Renderer
     9. Blackjack engine (pure rules + state machine, no DOM)
    10. Blackjack UI (DOM overlay bound to the engine)
    11. Game controller & main loop
   ========================================================================== */

(() => {
  'use strict';

  /* ========================================================================
     1. CONFIG & PALETTE
     ====================================================================== */

  const CONFIG = Object.freeze({
    WIDTH: 320, // logical canvas resolution (CSS scales it up)
    HEIGHT: 240,
    PLAYER_SPEED: 72, // logical pixels per second
    INTERACT_RADIUS: 48, // center-to-center distance to talk to the dealer
    STARTING_BALANCE: 15000,
    REBUY_AMOUNT: 500,
    BET_OPTIONS: Object.freeze([10, 20, 50, 100]),
    NUM_DECKS: 4,
    RESHUFFLE_THRESHOLD: 20, // reshuffle before a hand if fewer cards remain
    DEALER_STANDS_ON: 17, // dealer draws on 16, stands on all 17s (incl. soft)
    DEALER_STEP_MS: 650, // pause between dealer actions
    CARD_STAGGER_MS: 110, // delay between the four opening cards (animation + deal sounds)
    MAX_DT: 0.05, // clamp frame delta (seconds) after tab switches
  });

  /**
   * Audio facade (see audio.js). If audio.js failed to load, every call is a
   * harmless no-op so the game stays fully playable.
   */
  const sound = window.CasinoAudio ?? {
    sfx: { play() {} },
    music: { setTheme() {}, getTheme: () => 'casinoClassic', listThemes: () => [] },
    voice: { say() {}, stop() {} },
    footstep() {},
    isSettingsOpen: () => false,
    onSettingsToggle() {},
  };

  // Fare by destination town; only charged the first time a town is unlocked.
  const TRAIN_FARES = Object.freeze({ 2: 1500, 3: 10000 });
  const MAX_TOWNS = 3;
  const GRAND_CASINO_TOWN = 3; // from this town on, the lounge also has poker, roulette and plinko
  const TRAIN_STOP_OFFSET = 31; // engine and car sit this far either side of a platform's centre
  const TRAIN_HIDDEN_PAST = 92; // how far past a wall the engine must be for the whole train to be hidden
  const TUNNEL_COLLAPSE_DURATION = 3.2; // seconds of rumble, falling rock and settling dust
  const TUNNEL_COLLAPSE_SLAM = 1.6; // moment the roof gives way completely
  const SLOT_SPIN_COST = 50;
  const CLOVER_MATCH_CHANCE = 0.25; // each extra reel may copy the first reel's symbol
  const LUCKY_HAND_SAVE_CHANCE = 0.4; // a card that would bust you may be swapped out
  const PROGRESS_KEY = 'luckyPixelLounge.progress.v2';

  /* ----- Slot machine model ------------------------------------------------
     Results are rolled first (each reel picks a symbol uniformly, exactly as
     before), then every reel is steered so it physically lands on that
     symbol. The strips below are purely visual. */

  const SLOT_SYMBOLS = Object.freeze(['7', 'BAR', 'CHERRY', 'DIAMOND']);
  const SLOT_REEL_STRIPS = Object.freeze([
    Object.freeze(['CHERRY', 'BAR', 'DIAMOND', '7', 'CHERRY', 'DIAMOND', 'BAR', 'CHERRY', '7', 'BAR', 'DIAMOND', '7']),
    Object.freeze(['DIAMOND', 'CHERRY', 'BAR', '7', 'DIAMOND', 'BAR', 'CHERRY', '7', 'DIAMOND', 'CHERRY', 'BAR', '7']),
    Object.freeze(['BAR', '7', 'CHERRY', 'DIAMOND', 'BAR', 'CHERRY', '7', 'DIAMOND', 'CHERRY', 'BAR', 'DIAMOND', '7']),
    // 4th reel: only used once the Golden Plus extension is bolted on.
    Object.freeze(['7', 'DIAMOND', 'BAR', 'CHERRY', '7', 'BAR', 'DIAMOND', 'CHERRY', 'BAR', '7', 'CHERRY', 'DIAMOND']),
  ]);
  const SLOT_TIMING = Object.freeze({
    windup: 0.14, // reels kick back as the lever is pulled
    accel: 0.24,
    speed: 16, // symbols per second at full spin
    decel: 0.6,
    overshoot: 0.24, // how far (in symbols) a reel slides past before recoiling
    bounce: 0.36,
    firstStop: 1.05,
    stagger: 0.48,
    tease: 0.6, // extra suspense on the last reel when the first two match
  });

  /** Layout of the close-up slot machine view, in canvas pixels. */
  const SLOT_VIEW = Object.freeze({
    cab: { x: 76, y: 34, w: 168, h: 200 },
    marquee: { x: 84, y: 4, w: 152, h: 32 },
    window: { x: 90, y: 48, w: 140, h: 96 },
    reelW: 42,
    reelGap: 7,
    cell: 32,
    lcd: { x: 96, y: 154, w: 128, h: 18 },
    button: { x: 132, y: 196, w: 56, h: 14 },
    lever: { x: 244, y: 56, w: 22, h: 100 },
    tray: { x: 104, y: 216, w: 112, h: 12 },
  });

  /** The rickety black 4th-reel box hammered onto the left side of the cabinet. */
  const SLOT_EXT = Object.freeze({ x: 16, y: 38, w: 62, h: 118, reelX: 27 });

  const BIG_WIN_TIERS = new Set(['triple', 'jackpot', 'quad', 'mega']);
  const RAINBOW_TIERS = new Set(['jackpot', 'mega']);

  const wrapIndex = (i, n) => ((i % n) + n) % n;

  function rollSlotResult(reelCount = 3, lucky = false) {
    const pick = () => SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)];
    const symbols = [pick()];
    for (let i = 1; i < reelCount; i++) {
      symbols.push(lucky && Math.random() < CLOVER_MATCH_CHANCE ? symbols[0] : pick());
    }
    return symbols;
  }

  /** Four 7s = 24x, four alike = 12x (4-reel only), three 7s = 12x, three alike = 6x, pair = 2x. */
  function evaluateSlotResult(reels) {
    const counts = new Map();
    for (const sym of reels) counts.set(sym, (counts.get(sym) ?? 0) + 1);
    let bestSymbol = reels[0];
    let bestCount = 0;
    for (const [sym, count] of counts.entries()) {
      if (count > bestCount) {
        bestCount = count;
        bestSymbol = sym;
      }
    }

    let payout = 0;
    let tier = 'none';
    if (bestCount === 4 && bestSymbol === '7') {
      payout = SLOT_SPIN_COST * 24;
      tier = 'mega';
    } else if (bestCount === 4) {
      payout = SLOT_SPIN_COST * 12;
      tier = 'quad';
    } else if (bestCount === 3 && bestSymbol === '7') {
      payout = SLOT_SPIN_COST * 12;
      tier = 'jackpot';
    } else if (bestCount === 3) {
      payout = SLOT_SPIN_COST * 6;
      tier = 'triple';
    } else if (bestCount === 2) {
      payout = SLOT_SPIN_COST * 2;
      tier = 'pair';
    }
    const winningReels = reels.map((sym) => payout > 0 && sym === bestSymbol);
    return { payout, tier, bestSymbol, bestCount, winningReels };
  }

  /**
   * Plans one reel's motion so that it lands exactly on `symbol` at (or just
   * after) `stopTime`. Positions are measured in symbols; integer = centered.
   */
  function planSlotReel(strip, startPos, startTime, stopTime, symbol) {
    const T = SLOT_TIMING;
    const windEnd = startTime + T.windup;
    const accelEnd = windEnd + T.accel;
    const accelDist = (T.speed * T.accel) / 2;
    const decelDist = (T.speed * T.decel) / 3; // matches the cubic ease-out's initial velocity
    const cruiseStart = startPos + accelDist;

    const naturalEnd = cruiseStart + T.speed * (stopTime - T.decel - accelEnd) + decelDist;
    let target = Math.ceil(naturalEnd - T.overshoot);
    while (strip[wrapIndex(target, strip.length)] !== symbol) target++;

    const landPos = target + T.overshoot;
    const decelStart = accelEnd + (landPos - decelDist - cruiseStart) / T.speed;
    const landTime = decelStart + T.decel;
    return { startPos, startTime, windEnd, accelEnd, cruiseStart, decelStart, landTime, settleTime: landTime + T.bounce, target };
  }

  /** Position and motion-blur amount (0..1) of a planned reel at time t. */
  function slotReelAt(plan, t) {
    const T = SLOT_TIMING;
    if (t <= plan.startTime) return { pos: plan.startPos, blur: 0 };
    if (t < plan.windEnd) {
      const u = (t - plan.startTime) / T.windup;
      return { pos: plan.startPos - 0.3 * Math.sin(Math.PI * u), blur: 0 };
    }
    if (t < plan.accelEnd) {
      const tau = t - plan.windEnd;
      return { pos: plan.startPos + (T.speed * tau * tau) / (2 * T.accel), blur: tau / T.accel };
    }
    if (t < plan.decelStart) {
      return { pos: plan.cruiseStart + T.speed * (t - plan.accelEnd), blur: 1 };
    }
    if (t < plan.landTime) {
      const u = (t - plan.decelStart) / T.decel;
      const from = plan.cruiseStart + T.speed * (plan.decelStart - plan.accelEnd);
      const to = plan.target + T.overshoot;
      return { pos: from + (to - from) * (1 - (1 - u) ** 3), blur: (1 - u) ** 2 };
    }
    if (t < plan.settleTime) {
      const tau = t - plan.landTime;
      return { pos: plan.target + T.overshoot * Math.exp(-7 * tau) * Math.cos(tau * Math.PI * 2 * 2.4), blur: 0 };
    }
    return { pos: plan.target, blur: 0 };
  }

  const SONG_CATALOG = Object.freeze([
    Object.freeze({ id: 'townBreeze', name: 'Town Breeze', cost: 0 }),
    Object.freeze({ id: 'townNeon', name: 'Neon Night Walk', cost: 300 }),
    Object.freeze({ id: 'casinoClassic', name: 'Classic Lounge', cost: 450 }),
  ]);

  const COSMETICS_CATALOG = Object.freeze([
    Object.freeze({ id: 'hat-none', kind: 'hat', name: 'No Hat', cost: 0, theme: null }),
    Object.freeze({ id: 'hat-fedora', kind: 'hat', name: 'Plum Fedora', cost: 140, theme: null }),
    Object.freeze({ id: 'hat-crown', kind: 'hat', name: 'Gold Crown', cost: 260, theme: null }),
    Object.freeze({ id: 'outfit-classic', kind: 'outfit', name: 'Classic Blue', cost: 0, theme: null }),
    Object.freeze({ id: 'outfit-velvet', kind: 'outfit', name: 'Velvet Suit', cost: 190, theme: null }),
    Object.freeze({ id: 'outfit-angler', kind: 'outfit', name: 'Angler Vest', cost: 160, theme: null }),
    ...SONG_CATALOG.map((song) => ({ id: `song-${song.id}`, kind: 'song', name: song.name, cost: song.cost, theme: song.id })),
  ]);

  // The hooded dealer sells the curios on the shelf behind him (owned forever once bought).
  const BLACK_MARKET_STOCK = Object.freeze([
    Object.freeze({ id: 'clover', name: 'Four-Leaf Clover', cost: 6000, desc: 'Luckier slot machine spins.' }),
    Object.freeze({ id: 'plus', name: 'Golden Plus', cost: 10000, desc: 'Bolts a 4th reel onto the slots.' }),
    Object.freeze({ id: 'hand', name: 'Lucky Hand', cost: 8000, desc: 'Better odds at blackjack.' }),
  ]);

  const appearanceState = {
    hat: 'hat-none',
    outfit: 'outfit-classic',
  };

  const PAL = Object.freeze({
    ink: '#1b1024',
    wallpaper: '#2a1a3e',
    wallpaperStripe: '#33214d',
    molding: '#5d275d',
    wood: '#7a4a2a',
    woodDark: '#4a2a1a',
    woodLight: '#a0663a',
    wainscotPanel: '#5a341f',
    carpetA: '#5c1f33',
    carpetB: '#541c2f',
    carpetDot: '#c28d3a',
    carpetAccent: '#7d2a43',
    rugA: '#1e3a5f',
    rugB: '#24466f',
    felt: '#1f6e47',
    feltLight: '#2f8f5f',
    feltDark: '#17543a',
    gold: '#ffcd75',
    goldDark: '#c28d3a',
    cream: '#f4ecd8',
    red: '#b13e53',
    redLight: '#ef7d57',
    green: '#38b764',
    blue: '#41a6f6',
    steel: '#94b0c2',
    signBg: '#3b1f4f',
    plum: '#5d275d',
    shadow: 'rgba(0, 0, 0, 0.35)',
    lampGlow: 'rgba(255, 205, 117, 0.06)',
  });

  /* ========================================================================
     1b. TOWN WORLD — a wide, scrolling town with unique named stores and
     a two-car train that rides the rails between its two stations.
     ====================================================================== */

  const STORE_WIDTH = 86;
  const STORE_GAP = 14;
  const STORES_START_X = 170;
  const STATION_ZONE_W = 140;

  const STORE_DEFS = Object.freeze(
    [
      { id: 'casino', area: 'casino', name: 'LUCKY PIXEL LOUNGE', wall: '#3a1530', roof: '#7a2340', sign: PAL.gold, accent: PAL.redLight, glow: 'rgba(239,125,87,0.5)' },
      { id: 'bakery', area: 'bakery', name: 'MORNING CRUMBS', wall: '#6b3a28', roof: '#8a4a30', sign: '#f4c77a', accent: '#e8955c', glow: 'rgba(244,199,122,0.5)' },
      { id: 'supermarket', area: 'supermarket', name: 'GREEN BASKET', wall: '#204a30', roof: '#2d6b3e', sign: '#bdf27a', accent: '#5fae4a', glow: 'rgba(189,242,122,0.4)' },
      { id: 'cosmetics', area: 'cosmetics', name: 'VELVET THREADS', wall: '#3a234f', roof: '#4a2a63', sign: '#d9a6ff', accent: '#8a4fbf', glow: 'rgba(217,166,255,0.5)' },
      { id: 'toy', area: 'toy', name: 'TOY ORBIT', wall: '#1f3a6b', roof: '#274a85', sign: '#ffd75e', accent: '#f26a7d', glow: 'rgba(255,215,94,0.5)' },
      { id: 'restaurant', area: 'restaurant', name: 'NEON NOODLES', wall: '#5c1f33', roof: '#7d2a43', sign: '#ff8f5e', accent: '#ffd75e', glow: 'rgba(255,143,94,0.5)' },
      { id: 'electronics', area: 'electronics', name: 'SPARK CIRCUIT', wall: '#1a2b3d', roof: '#223b52', sign: '#6be3ff', accent: '#41a6f6', glow: 'rgba(107,227,255,0.5)' },
      { id: 'gift', area: 'gift', name: 'MOONLIGHT GIFTS', wall: '#2a2250', roof: '#362a66', sign: '#ffb3e6', accent: '#b98bff', glow: 'rgba(255,179,230,0.5)' },
      { id: 'butcher', area: 'butcher', name: 'PRIME CUTS', wall: '#5a2a2a', roof: '#6e3434', sign: '#ffcf9e', accent: '#c25b4a', glow: 'rgba(255,207,158,0.4)' },
      { id: 'fishing', area: 'fishing', name: 'TIDE & TACKLE', wall: '#1d3b4a', roof: '#244a5d', sign: '#9edcf0', accent: '#41a6f6', glow: 'rgba(158,220,240,0.4)' },
    ].map((def, i) => Object.freeze({ ...def, x: STORES_START_X + i * (STORE_WIDTH + STORE_GAP), w: STORE_WIDTH })),
  );

  // Town 2 onwards: the fishing store becomes a run-down black building with a crossed-out sign.
  const BLACK_MARKET_DEF = Object.freeze({
    ...STORE_DEFS.find((d) => d.id === 'fishing'),
    name: 'BLACK MARKET',
    wall: '#121214',
    roof: '#0a0a0c',
    sign: '#4a4a4e',
    accent: '#2c1a1c',
    glow: 'rgba(150,30,30,0.3)',
    rundown: true,
  });

  // Town 2 onwards: Prime Cuts is replaced by a stone bank that hands out loans.
  const BANK_DEF = Object.freeze({
    ...STORE_DEFS.find((d) => d.id === 'butcher'),
    name: 'THE BANK',
    wall: '#585d6b',
    roof: '#3a3e4a',
    sign: '#ecd9a0',
    accent: '#b8913a',
    glow: 'rgba(255,230,160,0.45)',
    bank: true,
  });

  const LOAN_LIMIT = 1000; // the most the bank will ever have out to you at once
  const SHARK_LOAN = 1000; // what the man in the back room lends once the bank cuts you off

  // Robbery cutscene timeline (seconds since it starts).
  const ROBBERY = Object.freeze({
    walkStart: 0.6, walkEnd: 3.0, goonsIn: 3.0, alarm: 3.4, backUp: 3.6, cornered: 4.8,
    line1: 4.8, line2: 6.6, line3: 8.2, hit: 9.4, scoop: 10.6, leave: 11.0, fade: 13.0,
    title: 14.0, prompt: 15.0, autoRestart: 24.0,
  });

  // Opening cutscene: scene start times (seconds after the player presses start).
  const INTRO = Object.freeze({
    site: 0, drive: 9, crash: 14.6, hospital: 18, fired: 27.5, evict: 36, street: 45, title: 56, end: 60,
  });
  const INTRO_BEAT = 0.9; // heart monitor period in the hospital scene

  /** The store definition to show in a given town (fishing becomes Black Market
   * and Prime Cuts becomes the Bank after town 1). */
  function storeDefForTown(def, townIndex) {
    if (townIndex <= 1) return def;
    if (def.id === 'fishing') return BLACK_MARKET_DEF;
    if (def.id === 'butcher') return BANK_DEF;
    return def;
  }

  const LAST_STORE = STORE_DEFS[STORE_DEFS.length - 1];
  const TOWN_WIDTH = LAST_STORE.x + LAST_STORE.w + 20 + STATION_ZONE_W + 8;

  const TOWN_WORLD = Object.freeze({
    width: TOWN_WIDTH,
    height: 240,
    trackY: 124,
    stationLeft: Object.freeze({ x: 8, w: STATION_ZONE_W, centerX: 8 + STATION_ZONE_W / 2 }),
    stationRight: Object.freeze({ x: TOWN_WIDTH - 8 - STATION_ZONE_W, w: STATION_ZONE_W, centerX: TOWN_WIDTH - 8 - STATION_ZONE_W / 2 }),
  });

  const TRAIN_LIVERY = Object.freeze({ body: '#b13e53', roof: '#7a2340', trim: PAL.gold, window: '#bfe9ff' });

  /* ========================================================================
     2. PIXEL-ART ASSETS
     Each sprite is a list of strings; each character maps to a color in
     SPRITE_COLORS ('.' = transparent). Sprites are pre-rendered once to
     offscreen canvases so drawing them each frame is a single drawImage.
     ====================================================================== */

  const SPRITE_COLORS = Object.freeze({
    k: PAL.ink, // outline
    s: '#f2c29b', // skin
    h: '#7a4426', // player hair
    b: '#3b7dd8', // player shirt
    p: '#3b2f4f', // player pants
    d: '#2b1a12', // dealer hair
    m: '#3a2416', // dealer mustache
    v: PAL.green, // dealer visor
    g: '#2e5e4e', // dealer vest
    w: '#f4f4f4', // white shirt / bubble
    r: PAL.red, // bow tie
    R: PAL.red, // bubble "!"
    L: '#3e8948', // leaf
    l: '#63c74d', // leaf highlight
    O: '#b86f50', // pot
    o: '#e4a672', // pot highlight
  });

  const PLAYER_BODY = [
    '...kkkkkk...',
    '..khhhhhhk..',
    '.khhhhhhhhk.',
    '.khsssssshk.',
    '.kssksskssk.',
    '.kssssssssk.',
    '..kssssssk..',
    '...kkkkkk...',
    '..kbbbbbbk..',
    '.kbbbbbbbbk.',
    'ksbbbbbbbbsk',
    'kskbbbbbbksk',
    '..kppppppk..',
  ];

  // Three leg poses -> a 4-step walk cycle (idle, left, idle, right)
  const PLAYER_LEGS = Object.freeze({
    idle: ['..kppkkppk..', '..kpk..kpk..', '..kkk..kkk..'],
    left: ['..kppkkppk..', '..kpk..kkk..', '..kkk.......'],
    right: ['..kppkkppk..', '..kkk..kpk..', '.......kkk..'],
  });

  const DEALER_SPRITE = [
    '...kkkkkk...',
    '..kddddddk..',
    '.kvvvvvvvvk.',
    '.kkkkkkkkkk.',
    '.kssksskssk.',
    '.kssssssssk.',
    '..ksmmmmsk..',
    '...kkkkkk...',
    '..kwwrrwwk..',
    '.kgwwrrwwgk.',
    'kgggwwwwgggk',
    'ksgggwwgggsk',
  ];

  const PLANT_SPRITE = [
    '....kk.kk...',
    '...kLLkLLk..',
    '..kLlLLlLLk.',
    '.kLlLLLLlLLk',
    '.kLLlLLlLLLk',
    'kLLLLlLLLlLk',
    '.kLlLLLLlLk.',
    '..kkLLLLkk..',
    '...kkkkkk...',
    '..kOOOOOOk..',
    '..kOooooOk..',
    '...kOOOOk...',
    '...kOOOOk...',
    '....kkkk....',
  ];

  // 16x20 loan shark: fedora, shades, cigar and trench coat (sits behind his desk).
  const SHARK_COLORS = Object.freeze({
    k: '#0a0810', F: '#2b2633', f: '#7a1f2a', s: '#b88a6e', G: '#050505',
    c: '#6b4a2a', C: '#ff7a3a', T: '#3d3529', w: '#d8d4c8', r: '#8a1a22',
  });
  const SHARK_SPRITE = [
    '.....kkkkkk.....',
    '....kFFFFFFk....',
    '....kFFFFFFk....',
    '....kffffffk....',
    '.kkkFFFFFFFFkkk.',
    'kFFFFFFFFFFFFFFk',
    '...kssssssssk...',
    '...kGGGssGGGk...',
    '...kssssssssk...',
    '...kssskkssskcC.',
    '....kssssssk....',
    '..kkTTwwwwTTkk..',
    '.kTTTTwrrwTTTTk.',
    'kTTTTTwrrwTTTTTk',
    'kTTTTTTrrTTTTTTk',
    'kTsTTTTTTTTTTsTk',
    'kTTTTTTTTTTTTTTk',
    'kTTTTTTTTTTTTTTk',
    '.kTTTTTTTTTTTTk.',
    '.kkkkkkkkkkkkkk.',
  ];

  // 12x16 street thug in a beanie and shades (the shark's collectors).
  const GOON_SPRITE = [
    '...kkkkkk...',
    '..kBBBBBBk..',
    '.kBBBBBBBBk.',
    '.kbbbbbbbbk.',
    '.kssssssssk.',
    '.kGGGssGGGk.',
    '.ksssmmsssk.',
    '..kssssssk..',
    '.kJJJJJJJJk.',
    'kJJJJwwJJJJk',
    'kJJJJwwJJJJk',
    'ksJJJJJJJJsk',
    '.kPPPPPPPPk.',
    '.kPPk..kPPk.',
    '.kPPk..kPPk.',
    '.kkkk..kkkk.',
  ];
  const goonColors = (skin, beanie) => Object.freeze({
    k: '#08070c', B: beanie, b: '#3c3c48', s: skin, G: '#050505', m: '#5a2a22',
    J: '#1a1a20', w: '#5a5a66', P: '#22222a',
  });

  // 12x16 townsfolk for the opening cutscene (foreman, doctor, boss, landlord).
  const NPC_SPRITE = [
    '...kkkkkk...',
    '..kHHHHHHk..',
    '.kHHHHHHHHk.',
    '.kHssssssHk.',
    '.kssksskssk.',
    '.kssssssssk.',
    '..ksssmssk..',
    '...kkkkkk...',
    '.kJJJwwJJJk.',
    'kJJJJwwJJJJk',
    'kJJJJwwJJJJk',
    'ksJJJJJJJJsk',
    '.kPPPPPPPPk.',
    '.kPPk..kPPk.',
    '.kPPk..kPPk.',
    '.kkkk..kkkk.',
  ];
  const npcColors = (hair, top, accent, pants, skin = '#f2c29b') => Object.freeze({
    k: PAL.ink, H: hair, s: skin, m: '#8a4a3a', J: top, w: accent, P: pants,
  });

  // 20x24 hooded figure; the face is an empty void (glowing eyes are drawn live).
  const HOODED_COLORS = Object.freeze({ k: '#050407', H: '#3a3447', h: '#25212f', f: '#1a1722' });
  const HOODED_DEALER_SPRITE = [
    '.......kkkkkk.......',
    '......kHHHHHHk......',
    '.....kHhhhhhhHk.....',
    '....kHhhhhhhhhHk....',
    '...kHhhhkkkkhhhHk...',
    '..kHhhkkkkkkkkhhHk..',
    '..kHhhkkkkkkkkhhHk..',
    '..kHhhkkkkkkkkhhHk..',
    '..kHhhhkkkkkkhhhHk..',
    '..kHhhhhkkkkhhhhHk..',
    '.kHhhhhhhhhhhhhhhHk.',
    'kHhhhhhhhhhhhhhhhhHk',
    'kHhhhhhhhffhhhhhhhHk',
    'kHhhhfhhhffhhhfhhhHk',
    'kHhhhhhhhffhhhhhhhHk',
    'kHhhhhhhhffhhhhhhhHk',
    'kHhhhfhhhffhhhfhhhHk',
    'kHhhhhhhhffhhhhhhhHk',
    'kHhhhhhhhffhhhhhhhHk',
    'kHhhhfhhhffhhhfhhhHk',
    'kHhhhhhhhffhhhhhhhHk',
    'kHhhhhhhhffhhhhhhhHk',
    'kHhhhfhhhffhhhfhhhHk',
    'kHhhhhhhhffhhhhhhhHk',
  ];

  // Black Market shelf curios.
  const CLOVER_SPRITE = [
    '.kkk.kkk.',
    'kLlLkLlLk',
    'kLLLLLLLk',
    '.kLLLLLk.',
    'kLLLLLLLk',
    'kLlLkLlLk',
    '.kkkLkkk.',
    '....Lk...',
    '....kL...',
    '.....k...',
  ];

  const GOLD_PLUS_COLORS = Object.freeze({ k: '#2a1a08', G: '#ffcd75', g: '#c28d3a', w: '#fff4c8' });
  const GOLD_PLUS_SPRITE = [
    '....kkk....',
    '...kwGGk...',
    '...kGGGk...',
    '.kkkGGGkkk.',
    'kwGGGGGGGgk',
    'kGGGGGGGGgk',
    'kgggGGGgggk',
    '.kkkGGgkkk.',
    '...kGGgk...',
    '...kgggk...',
    '....kkk....',
  ];

  const SEVERED_HAND_COLORS = Object.freeze({ k: '#050407', s: '#c9a88a', S: '#9c7a62', R: '#9a1c22', b: '#e8e0d0' });
  const SEVERED_HAND_SPRITE = [
    '......kkk.....',
    'kkkkksssskkkk.',
    'RbRsssssssssk.',
    'RRRssssSSSSSSk',
    'RbRsssssssssk.',
    '.kkkkkkkkkkk..',
  ];

  const BUBBLE_SPRITE = [
    '.kkkkkkk.',
    'kwwwwwwwk',
    'kwwwRwwwk',
    'kwwwRwwwk',
    'kwwwRwwwk',
    'kwwwwwwwk',
    'kwwwRwwwk',
    'kwwwwwwwk',
    '.kkkwkkk.',
    '....k....',
  ];

  // 7x7 suit icons, shared by the canvas decor and the DOM cards ('#' = filled)
  const SUIT_PIXELS = Object.freeze({
    spade: ['...#...', '..###..', '.#####.', '#######', '#######', '.#.#.#.', '..###..'],
    heart: ['.##.##.', '#######', '#######', '#######', '.#####.', '..###..', '...#...'],
    diamond: ['...#...', '..###..', '.#####.', '#######', '.#####.', '..###..', '...#...'],
    club: ['..###..', '..###..', '##.#.##', '#######', '##.#.##', '...#...', '..###..'],
  });

  // 3x5 digits for the "21" neon sign
  const DIGIT_PIXELS = Object.freeze({
    1: ['.#.', '##.', '.#.', '.#.', '###'],
    2: ['###', '..#', '###', '#..', '###'],
  });

  /** Rasterize a pixel map into an offscreen canvas. */
  function buildSprite(rows, colors) {
    const width = rows[0].length;
    const height = rows.length;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');

    rows.forEach((row, y) => {
      if (row.length !== width) {
        console.warn(`Sprite row ${y} has length ${row.length}, expected ${width}`);
      }
      [...row].forEach((ch, x) => {
        const color = colors[ch];
        if (!color) return; // transparent
        g.fillStyle = color;
        g.fillRect(x, y, 1, 1);
      });
    });
    return canvas;
  }

  /** Convert a pixel map into a crisp inline SVG (used for card suits). */
  function pixelsToSvg(rows, className = 'suit') {
    let d = '';
    rows.forEach((row, y) => {
      [...row].forEach((ch, x) => {
        if (ch === '#') d += `M${x} ${y}h1v1h-1z`;
      });
    });
    const w = rows[0].length;
    const h = rows.length;
    return (
      `<svg class="${className}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" aria-hidden="true">` +
      `<path fill="currentColor" d="${d}"/></svg>`
    );
  }

  const SUIT_SVG = Object.freeze(
    Object.fromEntries(Object.entries(SUIT_PIXELS).map(([suit, rows]) => [suit, pixelsToSvg(rows)])),
  );

  /* ========================================================================
     3. UTILITIES
     ====================================================================== */

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const rectsOverlap = (a, b) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  function fillRect(ctx, x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  }

  function createLayer(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    g.imageSmoothingEnabled = false;
    return { canvas, g };
  }

  /* ========================================================================
     4. INPUT HANDLER
     Tracks held keys (for smooth movement) and broadcasts keydown events
     (for one-shot actions like interacting).
     ====================================================================== */

  const Input = (() => {
    const held = new Set();
    const keyDownHandlers = new Set();

    const BINDINGS = Object.freeze({
      up: ['KeyW', 'ArrowUp'],
      down: ['KeyS', 'ArrowDown'],
      left: ['KeyA', 'ArrowLeft'],
      right: ['KeyD', 'ArrowRight'],
    });

    const isActionDown = (action) => BINDINGS[action].some((code) => held.has(code));

    function init(target = window) {
      target.addEventListener('keydown', (event) => {
        held.add(event.code);
        keyDownHandlers.forEach((handler) => handler(event));
      });
      target.addEventListener('keyup', (event) => held.delete(event.code));
      // Avoid "stuck" keys when the window loses focus mid-press
      target.addEventListener('blur', () => held.clear());
    }

    /** Normalized movement vector (diagonals are not faster). */
    function getMoveVector() {
      let x = (isActionDown('right') ? 1 : 0) - (isActionDown('left') ? 1 : 0);
      let y = (isActionDown('down') ? 1 : 0) - (isActionDown('up') ? 1 : 0);
      if (x !== 0 && y !== 0) {
        x *= Math.SQRT1_2;
        y *= Math.SQRT1_2;
      }
      return { x, y };
    }

    return {
      init,
      getMoveVector,
      onKeyDown: (handler) => keyDownHandlers.add(handler),
      clear: () => held.clear(),
    };
  })();

  /* ========================================================================
     5. WORLD — room layout, props and solid colliders
     ====================================================================== */

  /** Walkable floor area (inside the walls). */
  const ROOM = Object.freeze({ x: 8, y: 40, w: 304, h: 192 });

  /** Blackjack table, centered in the room. */
  const TABLE = Object.freeze({ x: 120, y: 108, w: 80, h: 28 });

  function makeProp(type, x, y) {
    if (type === 'slot') {
      // Only the base of the machine (on the floor) blocks movement
      return { type, x, y, w: 16, h: 26, collider: { x, y: ROOM.y, w: 16, h: y + 26 - ROOM.y } };
    }
    // plant: only the pot blocks movement
    return { type, x, y, w: 12, h: 14, collider: { x: x + 3, y: y + 9, w: 6, h: 5 } };
  }

  const PROPS = Object.freeze([
    makeProp('slot', 28, 22),
    makeProp('slot', 50, 22),
    makeProp('slot', 254, 22),
    makeProp('slot', 276, 22),
    makeProp('plant', 10, 28),
    makeProp('plant', 298, 28),
    makeProp('plant', 10, 216),
    makeProp('plant', 298, 216),
  ]);

  const SLOT_PROPS = Object.freeze(PROPS.filter((prop) => prop.type === 'slot'));

  /* ========================================================================
     6. ENTITIES
     ====================================================================== */

  const player = {
    x: 154, // top-left of sprite (float for smooth sub-pixel movement)
    y: 196,
    w: 12,
    h: 16,
    moving: false,
    walkTime: 0,
    /** Feet-only hitbox gives a nice top-down "depth" feel. */
    get hitbox() {
      return { x: this.x + 2, y: this.y + 12, w: 8, h: 4 };
    },
    get center() {
      return { x: this.x + this.w / 2, y: this.y + this.h / 2 };
    },
  };

  const dealer = {
    x: TABLE.x + TABLE.w / 2 - 6, // stands behind the table, centered
    y: TABLE.y - 10,
    w: 12,
    h: 12,
    get center() {
      return { x: this.x + this.w / 2, y: this.y + this.h / 2 };
    },
  };

  /** Everything that blocks movement. */
  const COLLIDERS = Object.freeze([
    TABLE,
    { x: TABLE.x, y: TABLE.y - 14, w: TABLE.w, h: 14 }, // dealer's side of the table
    ...PROPS.map((prop) => prop.collider),
  ]);

  /* Town 3's lounge: a poker table on the left, a roulette table on the right
     and a plinko machine standing against the back wall. */
  const POKER_TABLE = Object.freeze({ x: 24, y: 112, w: 72, h: 26 });
  const ROULETTE_TABLE = Object.freeze({ x: 224, y: 112, w: 72, h: 26 });
  const PLINKO_CABINET = Object.freeze({ x: 136, y: 6, w: 48, h: 56 });

  function croupierFor(table) {
    const x = table.x + table.w / 2 - 6;
    const y = table.y - 10;
    return Object.freeze({ x, y, w: 12, h: 12, center: Object.freeze({ x: x + 6, y: y + 6 }) });
  }

  const pokerDealer = croupierFor(POKER_TABLE);
  const rouletteDealer = croupierFor(ROULETTE_TABLE);

  const GRAND_COLLIDERS = Object.freeze([
    ...COLLIDERS,
    POKER_TABLE,
    { x: POKER_TABLE.x, y: POKER_TABLE.y - 14, w: POKER_TABLE.w, h: 14 },
    ROULETTE_TABLE,
    { x: ROULETTE_TABLE.x, y: ROULETTE_TABLE.y - 14, w: ROULETTE_TABLE.w, h: 14 },
    { x: PLINKO_CABINET.x + 2, y: ROOM.y, w: PLINKO_CABINET.w - 4, h: PLINKO_CABINET.y + PLINKO_CABINET.h - ROOM.y },
  ]);

  /* ========================================================================
     7. COLLISION & PROXIMITY
     Axis-separated movement: move X, resolve; move Y, resolve. This lets
     the player slide along walls instead of sticking to them.
     ====================================================================== */

  const Collision = {
    moveAndCollide(entity, dx, dy, colliders = COLLIDERS) {
      if (dx !== 0) {
        entity.x += dx;
        this.clampToRoom(entity);
        for (const solid of colliders) {
          const box = entity.hitbox;
          if (!rectsOverlap(box, solid)) continue;
          entity.x += dx > 0 ? solid.x - (box.x + box.w) : solid.x + solid.w - box.x;
        }
      }
      if (dy !== 0) {
        entity.y += dy;
        this.clampToRoom(entity);
        for (const solid of colliders) {
          const box = entity.hitbox;
          if (!rectsOverlap(box, solid)) continue;
          entity.y += dy > 0 ? solid.y - (box.y + box.h) : solid.y + solid.h - box.y;
        }
      }
    },

    clampToRoom(entity) {
      const box = entity.hitbox;
      entity.x += clamp(box.x, ROOM.x, ROOM.x + ROOM.w - box.w) - box.x;
      entity.y += clamp(box.y, ROOM.y, ROOM.y + ROOM.h - box.h) - box.y;
    },

    distance(a, b) {
      return Math.hypot(a.x - b.x, a.y - b.y);
    },

    isWithinRange(a, b, radius) {
      return this.distance(a, b) <= radius;
    },
  };

  /* ========================================================================
     8. RENDERER
     Static scenery is baked once into an offscreen "background" canvas.
     Dynamic objects are depth-sorted by their bottom edge each frame.
     ====================================================================== */

  const Renderer = (() => {
    let ctx;
    let background;
    let backgroundGrand;
    let townBackground;
    let townBackgroundBlackMarket;
    let alleyBackground;
    let introScenes;
    let cosmeticsBackground;
    let drawables;
    let grandDrawables;
    const sprites = {};
    const interiorBackgrounds = {};

    function init(canvas) {
      ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;

      for (const [pose, legs] of Object.entries(PLAYER_LEGS)) {
        sprites[`player_${pose}`] = buildSprite([...PLAYER_BODY, ...legs], SPRITE_COLORS);
      }
      sprites.dealer = buildSprite(DEALER_SPRITE, SPRITE_COLORS);
      sprites.plant = buildSprite(PLANT_SPRITE, SPRITE_COLORS);
      sprites.bubble = buildSprite(BUBBLE_SPRITE, SPRITE_COLORS);
      sprites.hooded = buildSprite(HOODED_DEALER_SPRITE, HOODED_COLORS);
      sprites.clover = buildSprite(CLOVER_SPRITE, SPRITE_COLORS);
      sprites.goldPlus = buildSprite(GOLD_PLUS_SPRITE, GOLD_PLUS_COLORS);
      sprites.severedHand = buildSprite(SEVERED_HAND_SPRITE, SEVERED_HAND_COLORS);
      sprites.shark = buildSprite(SHARK_SPRITE, SHARK_COLORS);
      sprites.goonA = buildSprite(GOON_SPRITE, goonColors('#c8946c', '#2a2a33'));
      sprites.goonB = buildSprite(GOON_SPRITE, goonColors('#8a5a3c', '#5a1f24'));
      sprites.foreman = buildSprite(NPC_SPRITE, npcColors('#5a3a22', '#f07a2a', '#f4e04a', '#3a4a6a'));
      sprites.doctor = buildSprite(NPC_SPRITE, npcColors('#2b2b2b', '#eef2f4', '#5aa0c8', '#5aa0c8'));
      sprites.boss = buildSprite(NPC_SPRITE, npcColors('#9a9aa4', '#4a4a5a', '#b13e53', '#2a2a33', '#e0b08a'));
      sprites.landlord = buildSprite(NPC_SPRITE, npcColors('#2b1a12', '#d8d0b8', '#d8d0b8', '#5a4a3a', '#d8a07a'));
      sprites.heart = buildSprite(SUIT_PIXELS.heart, { '#': PAL.red });
      sprites.spade = buildSprite(SUIT_PIXELS.spade, { '#': PAL.ink });
      sprites.digit1 = buildSprite(DIGIT_PIXELS[1], { '#': PAL.redLight });
      sprites.digit2 = buildSprite(DIGIT_PIXELS[2], { '#': PAL.redLight });
      buildSlotArt();

      background = renderBackground();
      backgroundGrand = renderBackground(true);
      townBackground = renderTownBackground();
      townBackgroundBlackMarket = renderTownBackground(true);
      interiorBackgrounds.fishingBlackMarket = renderBlackMarketInterior();
      interiorBackgrounds.butcherBank = renderBankInterior();
      interiorBackgrounds.backroom = renderBackroomInterior();
      alleyBackground = renderAlleyBackground();
      introScenes = {
        site: renderIntroSite(),
        hospital: renderIntroHospital(),
        office: renderIntroOffice(),
        apartment: renderIntroApartment(),
        street: renderIntroStreet(),
      };
      cosmeticsBackground = renderCosmeticsBackground();
      for (const def of STORE_DEFS) {
        if (def.id === 'casino' || def.id === 'cosmetics') continue;
        interiorBackgrounds[def.area] = renderGenericInteriorBackground(def);
      }

      // Depth-sorted drawables (sortY = bottom edge on screen)
      drawables = [
        { get sortY() { return player.y + player.h; }, draw: () => drawPlayer() },
        { sortY: TABLE.y + TABLE.h, draw: drawDealerStation },
        ...PROPS.map((prop) => ({
          sortY: prop.y + prop.h,
          draw: (time) => (prop.type === 'slot' ? drawSlotMachine(prop, time) : drawPlant(prop)),
        })),
      ];
      grandDrawables = [
        ...drawables,
        { sortY: POKER_TABLE.y + POKER_TABLE.h, draw: drawPokerStation },
        { sortY: ROULETTE_TABLE.y + ROULETTE_TABLE.h, draw: drawRouletteStation },
        { sortY: PLINKO_CABINET.y + PLINKO_CABINET.h, draw: drawPlinkoCabinet },
      ];
    }

    /* ----- Static background ------------------------------------------ */

    /** `grand` adds rugs and lamp glow for town 3's poker and roulette tables. */
    function renderBackground(grand = false) {
      const { canvas, g } = createLayer(CONFIG.WIDTH, CONFIG.HEIGHT);
      const W = CONFIG.WIDTH;
      const H = CONFIG.HEIGHT;

      // Outer walls
      fillRect(g, 0, 0, W, H, PAL.ink);

      // Back wall: striped wallpaper, crown molding, wainscot
      fillRect(g, 0, 0, W, ROOM.y, PAL.wallpaper);
      for (let x = 2; x < W; x += 8) fillRect(g, x, 6, 2, 24, PAL.wallpaperStripe);
      fillRect(g, 0, 0, W, 4, PAL.ink);
      fillRect(g, 0, 4, W, 2, PAL.molding);
      fillRect(g, 0, 30, W, 10, PAL.woodDark);
      fillRect(g, 0, 30, W, 1, PAL.wood);
      for (let x = 3; x < W; x += 16) fillRect(g, x, 32, 12, 6, PAL.wainscotPanel);
      fillRect(g, 0, 39, W, 1, PAL.ink);

      // Carpet: checker tiles with a little gold diamond motif
      for (let ty = 0; ty < ROOM.h / 16; ty++) {
        for (let tx = 0; tx < ROOM.w / 16; tx++) {
          const x = ROOM.x + tx * 16;
          const y = ROOM.y + ty * 16;
          fillRect(g, x, y, 16, 16, (tx + ty) % 2 === 0 ? PAL.carpetA : PAL.carpetB);
          const cx = x + 8;
          const cy = y + 8;
          fillRect(g, cx - 1, cy - 1, 2, 2, PAL.carpetDot);
          fillRect(g, cx - 5, cy - 1, 2, 2, PAL.carpetAccent);
          fillRect(g, cx + 3, cy - 1, 2, 2, PAL.carpetAccent);
          fillRect(g, cx - 1, cy - 5, 2, 2, PAL.carpetAccent);
          fillRect(g, cx - 1, cy + 3, 2, 2, PAL.carpetAccent);
        }
      }
      fillRect(g, ROOM.x, ROOM.y, ROOM.w, 3, 'rgba(0, 0, 0, 0.25)'); // wall shadow

      // Inner wall trim
      fillRect(g, ROOM.x - 2, ROOM.y, 2, ROOM.h + 2, PAL.molding);
      fillRect(g, ROOM.x + ROOM.w, ROOM.y, 2, ROOM.h + 2, PAL.molding);
      fillRect(g, ROOM.x - 2, ROOM.y + ROOM.h, ROOM.w + 4, 2, PAL.molding);

      // Rug under the table
      const rug = { x: TABLE.x - 20, y: TABLE.y - 20, w: TABLE.w + 40, h: TABLE.h + 40 };
      fillRect(g, rug.x, rug.y, rug.w, rug.h, PAL.goldDark);
      fillRect(g, rug.x + 2, rug.y + 2, rug.w - 4, rug.h - 4, PAL.rugA);
      for (let y = rug.y + 7; y < rug.y + rug.h - 7; y += 8) {
        for (let x = rug.x + 7; x < rug.x + rug.w - 7; x += 8) fillRect(g, x, y, 2, 2, PAL.rugB);
      }
      fillRect(g, rug.x + 4, rug.y + 4, rug.w - 8, 1, PAL.goldDark);
      fillRect(g, rug.x + 4, rug.y + rug.h - 5, rug.w - 8, 1, PAL.goldDark);
      fillRect(g, rug.x + 4, rug.y + 4, 1, rug.h - 8, PAL.goldDark);
      fillRect(g, rug.x + rug.w - 5, rug.y + 4, 1, rug.h - 8, PAL.goldDark);

      // Warm pendant-lamp glow over the table (stacked translucent rects)
      for (let i = 0; i < 3; i++) {
        const pad = 30 - i * 10;
        fillRect(g, TABLE.x - pad, TABLE.y - pad, TABLE.w + pad * 2, TABLE.h + pad * 2, PAL.lampGlow);
      }

      if (grand) {
        for (const t of [POKER_TABLE, ROULETTE_TABLE]) {
          const r = { x: t.x - 4, y: t.y - 16, w: t.w + 8, h: t.h + 28 };
          fillRect(g, r.x, r.y, r.w, r.h, PAL.goldDark);
          fillRect(g, r.x + 2, r.y + 2, r.w - 4, r.h - 4, '#3b1f4f');
          for (let y = r.y + 6; y < r.y + r.h - 6; y += 8) {
            for (let x = r.x + 6; x < r.x + r.w - 6; x += 8) fillRect(g, x, y, 2, 2, '#4a2a63');
          }
          fillRect(g, r.x + 4, r.y + 4, r.w - 8, 1, PAL.goldDark);
          fillRect(g, r.x + 4, r.y + r.h - 5, r.w - 8, 1, PAL.goldDark);
          for (let i = 0; i < 3; i++) {
            const pad = 20 - i * 7;
            fillRect(g, t.x - pad, t.y - pad, t.w + pad * 2, t.h + pad * 2, PAL.lampGlow);
          }
        }
      }

      // Wall decor: framed suits, sconces and a "21" neon sign
      drawFrame(g, 92, 10, sprites.heart);
      drawFrame(g, 213, 10, sprites.spade);
      drawSconce(g, 120);
      drawSconce(g, 196);
      fillRect(g, 140, 8, 40, 20, PAL.goldDark);
      fillRect(g, 141, 9, 38, 18, PAL.ink);
      fillRect(g, 142, 10, 36, 16, PAL.signBg);
      g.drawImage(sprites.digit2, 153, 13, 6, 10);
      g.drawImage(sprites.digit1, 161, 13, 6, 10);

      return canvas;
    }

    function drawFrame(g, x, y, icon) {
      fillRect(g, x, y, 15, 15, PAL.goldDark);
      fillRect(g, x + 1, y + 1, 13, 13, PAL.gold);
      fillRect(g, x + 2, y + 2, 11, 11, PAL.cream);
      g.drawImage(icon, x + 4, y + 4);
    }

    function drawSconce(g, x) {
      fillRect(g, x - 3, 11, 10, 12, PAL.lampGlow);
      fillRect(g, x, 14, 4, 2, PAL.gold);
      fillRect(g, x, 16, 4, 5, PAL.goldDark);
      fillRect(g, x + 1, 21, 2, 2, PAL.woodDark);
    }

    function drawStoreFacade(g, def, buildY, buildH) {
      const { x, w } = def;
      const id = def.id;
      const bodyTop = buildY + 6;
      const bodyH = buildH - 6;
      const awningY = buildY + 26;

      fillRect(g, x, buildY, w, buildH, PAL.ink);
      fillRect(g, x + 1, buildY + 1, w - 2, buildH - 2, def.roof);
      fillRect(g, x + 2, bodyTop, w - 4, bodyH - 1, def.wall);
      fillRect(g, x + 2, bodyTop, w - 4, 1, 'rgba(255,255,255,0.2)');

      // Store-specific wall treatments so each shop silhouette reads from a distance.
      switch (id) {
        case 'bakery':
          for (let yy = bodyTop + 3; yy < buildY + buildH - 2; yy += 5) {
            for (let xx = x + 4; xx < x + w - 5; xx += 10) {
              fillRect(g, xx, yy, 8, 2, '#9f5f40');
            }
          }
          break;
        case 'supermarket':
          for (let yy = bodyTop + 2; yy < buildY + buildH - 2; yy += 6) fillRect(g, x + 4, yy, w - 8, 2, '#2b6c3f');
          break;
        case 'cosmetics':
          for (let xx = x + 5; xx < x + w - 5; xx += 10) fillRect(g, xx, bodyTop + 2, 2, bodyH - 8, '#51326d');
          break;
        case 'toy':
          for (let xx = x + 4; xx < x + w - 4; xx += 8) {
            fillRect(g, xx, bodyTop + 3, 4, 3, ['#f26a7d', '#ffd75e', '#41a6f6'][((xx - x) / 8) % 3]);
          }
          break;
        case 'restaurant':
          for (let yy = bodyTop + 4; yy < buildY + buildH - 2; yy += 7) fillRect(g, x + 4, yy, w - 8, 1, '#8f3957');
          break;
        case 'electronics':
          for (let xx = x + 5; xx < x + w - 5; xx += 12) fillRect(g, xx, bodyTop + 3, 8, bodyH - 12, '#223f5a');
          break;
        case 'gift':
          for (let yy = bodyTop + 3; yy < buildY + buildH - 2; yy += 6) {
            for (let xx = x + 6; xx < x + w - 6; xx += 12) fillRect(g, xx, yy, 3, 3, '#4a3a82');
          }
          break;
        case 'butcher':
          if (def.bank) {
            // Cut-stone blocks with white columns flanking the door.
            for (let yy = bodyTop + 2, row = 0; yy < buildY + buildH - 2; yy += 5, row++) {
              fillRect(g, x + 3, yy, w - 6, 1, '#474b57');
              for (let xx = x + 3 + (row % 2) * 6; xx < x + w - 3; xx += 12) fillRect(g, xx, yy, 1, 5, '#474b57');
            }
            for (const cx of [x + 3, x + 26, x + w - 30, x + w - 7]) {
              fillRect(g, cx - 1, awningY + 3, 6, buildY + buildH - awningY - 4, PAL.ink);
              fillRect(g, cx, awningY + 4, 4, buildY + buildH - awningY - 6, '#e4e0d4');
              fillRect(g, cx + 1, awningY + 6, 1, buildY + buildH - awningY - 10, '#b9b4a6');
              fillRect(g, cx - 1, buildY + buildH - 4, 6, 2, '#b9b4a6');
            }
            break;
          }
          for (let yy = bodyTop + 2; yy < buildY + buildH - 2; yy += 6) fillRect(g, x + 4, yy, w - 8, 1, '#793f3f');
          for (let xx = x + 6; xx < x + w - 6; xx += 10) fillRect(g, xx, bodyTop + 3, 1, bodyH - 8, '#793f3f');
          break;
        case 'fishing':
          for (let yy = bodyTop + 2; yy < buildY + buildH - 2; yy += 6) fillRect(g, x + 4, yy, w - 8, 2, def.rundown ? '#1b1b1f' : '#2a5466');
          break;
        default:
          for (let xx = x + 5; xx < x + w - 5; xx += 8) fillRect(g, xx, bodyTop + 2, 2, bodyH - 10, 'rgba(0,0,0,0.18)');
          break;
      }

      fillRect(g, x + 4, buildY + 8, w - 8, 12, PAL.ink);
      fillRect(g, x + 5, buildY + 9, w - 10, 10, def.sign);
      fillRect(g, x + 5, buildY + 9, w - 10, 1, 'rgba(255,255,255,0.3)');
      g.save();
      g.fillStyle = def.rundown ? '#b4b4b8' : PAL.ink;
      g.font = 'bold 6px monospace';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(def.name, x + w / 2, buildY + 14, w - 14);
      g.restore();
      if (def.rundown) drawCrossOut(g, x + 5, buildY + 9, w - 10, 10);

      // Awning stripe + highlight
      fillRect(g, x + 4, awningY, w - 8, 4, PAL.ink);
      fillRect(g, x + 5, awningY + 1, w - 10, 2, def.accent);
      for (let xx = x + 6; xx < x + w - 6; xx += 8) fillRect(g, xx, awningY + 1, 4, 2, 'rgba(255,255,255,0.18)');

      const doorW = 14;
      const doorX = x + w / 2 - doorW / 2;
      fillRect(g, doorX - 1, buildY + 24, doorW + 2, buildH - 24, PAL.ink);
      fillRect(g, doorX, buildY + 26, doorW, buildH - 28, def.accent);
      fillRect(g, doorX, buildY + 26, doorW, 1, 'rgba(255,255,255,0.22)');
      fillRect(g, doorX + doorW / 2 - 1, buildY + buildH - 13, 2, 7, PAL.ink);

      fillRect(g, x + 8, buildY + 30, 14, 11, PAL.ink);
      fillRect(g, x + 9, buildY + 31, 12, 9, def.glow);
      fillRect(g, x + w - 22, buildY + 30, 14, 11, PAL.ink);
      fillRect(g, x + w - 21, buildY + 31, 12, 9, def.glow);

      // Window displays hint what each shop sells.
      switch (id) {
        case 'bakery':
          fillRect(g, x + 12, buildY + 36, 6, 2, '#f4c77a');
          fillRect(g, x + w - 18, buildY + 36, 6, 2, '#f4c77a');
          break;
        case 'supermarket':
          fillRect(g, x + 11, buildY + 34, 4, 4, '#5fae4a');
          fillRect(g, x + w - 15, buildY + 34, 4, 4, '#e8955c');
          break;
        case 'electronics':
          fillRect(g, x + 11, buildY + 34, 8, 5, '#6be3ff');
          fillRect(g, x + w - 19, buildY + 34, 8, 5, '#6be3ff');
          break;
        case 'butcher':
          if (!def.bank) break;
          // Stacks of gold coins in the windows.
          for (const wx of [x + 11, x + w - 19]) {
            fillRect(g, wx, buildY + 36, 3, 3, '#e0b84a');
            fillRect(g, wx + 4, buildY + 34, 3, 5, '#e0b84a');
            fillRect(g, wx + 4, buildY + 34, 3, 1, '#fff0a8');
          }
          break;
        case 'fishing':
          if (def.rundown) break;
          fillRect(g, x + 12, buildY + 35, 6, 2, '#9edcf0');
          fillRect(g, x + w - 18, buildY + 35, 6, 2, '#9edcf0');
          break;
        default:
          break;
      }

      if (def.rundown) drawRundownDecay(g, def, buildY, buildH, awningY, doorX, doorW);

      fillRect(g, x + 2, buildY + buildH - 1, w - 4, 1, 'rgba(0,0,0,0.45)');
    }

    /** Red X and strike-through over a sign plate. */
    function drawCrossOut(g, x, y, w, h) {
      const red = '#c4313a';
      for (let i = 0; i < w; i++) {
        const t = i / (w - 1);
        fillRect(g, x + i, y + Math.round(t * (h - 1)), 1, 1, red);
        fillRect(g, x + i, y + Math.round((1 - t) * (h - 1)), 1, 1, red);
      }
      fillRect(g, x, y + Math.floor(h / 2) - 1, w, 2, red);
    }

    /** Cracks, missing shingles, torn awning and boarded-up openings. */
    function drawRundownDecay(g, def, buildY, buildH, awningY, doorX, doorW) {
      const { x, w } = def;
      const wood = '#4a3a28';
      const woodLight = '#6a5338';

      // Missing shingles / broken roof edge.
      for (const [ox, ow] of [[6, 7], [28, 4], [49, 9], [70, 5]]) fillRect(g, x + ox, buildY + 1, ow, 3, PAL.ink);

      // Peeling grime patches and wall cracks.
      fillRect(g, x + 6, buildY + 44, 10, 6, '#1d1d21');
      fillRect(g, x + w - 18, buildY + 48, 12, 5, '#1d1d21');
      for (let i = 0; i < 8; i++) fillRect(g, x + 10 + (i % 2) * 2, buildY + 21 + i * 2, 1, 2, '#030303');
      for (let i = 0; i < 7; i++) fillRect(g, x + w - 12 - (i % 2) * 2, buildY + 44 + i * 2, 1, 2, '#030303');

      // Torn awning with dangling shreds.
      for (const [ox, ow] of [[10, 5], [34, 7], [58, 4]]) fillRect(g, x + ox, awningY + 1, ow, 2, PAL.ink);
      for (const [ox, oh] of [[8, 4], [26, 3], [44, 5], [62, 3]]) fillRect(g, x + ox, awningY + 4, 2, oh, def.accent);

      // Boarded windows: crossed planks over a faint red glow.
      for (const wx of [x + 8, x + w - 22]) {
        fillRect(g, wx - 1, buildY + 33, 16, 2, wood);
        fillRect(g, wx - 1, buildY + 33, 16, 1, woodLight);
        fillRect(g, wx - 1, buildY + 38, 16, 2, wood);
        for (let i = 0; i < 10; i++) fillRect(g, wx + 2 + i, buildY + 40 - i, 1, 2, wood);
        fillRect(g, wx, buildY + 33, 1, 1, '#c8c8c8');
        fillRect(g, wx + 13, buildY + 38, 1, 1, '#c8c8c8');
      }

      // Boarded door.
      fillRect(g, doorX - 2, buildY + 34, doorW + 4, 3, wood);
      fillRect(g, doorX - 2, buildY + 34, doorW + 4, 1, woodLight);
      fillRect(g, doorX - 2, buildY + 44, doorW + 4, 3, wood);
      fillRect(g, doorX - 2, buildY + 44, doorW + 4, 1, woodLight);
      fillRect(g, doorX - 1, buildY + 35, 1, 1, '#c8c8c8');
      fillRect(g, doorX + doorW, buildY + 45, 1, 1, '#c8c8c8');
    }

    function drawStreetlight(g, x, baseY) {
      fillRect(g, x - 2, baseY - 28, 4, 28, PAL.ink);
      fillRect(g, x - 1, baseY - 28, 2, 28, '#313d49');
      fillRect(g, x - 5, baseY - 34, 10, 6, PAL.ink);
      fillRect(g, x - 4, baseY - 33, 8, 4, '#495667');
      fillRect(g, x - 2, baseY - 32, 4, 3, '#fff0bc');
      fillRect(g, x - 4, baseY - 31, 8, 1, 'rgba(255, 240, 188, 0.5)');
      fillRect(g, x - 4, baseY, 8, 2, PAL.ink);
      fillRect(g, x - 3, baseY + 1, 6, 1, '#1c252d');
    }

    function drawBench(g, x, y) {
      fillRect(g, x, y - 5, 16, 2, PAL.ink);
      fillRect(g, x + 1, y - 4, 14, 1, '#9f7446');
      fillRect(g, x, y - 1, 16, 2, PAL.ink);
      fillRect(g, x + 1, y, 14, 1, '#805630');
      fillRect(g, x + 1, y + 1, 2, 6, '#3a2a18');
      fillRect(g, x + 13, y + 1, 2, 6, '#3a2a18');
      fillRect(g, x + 2, y + 6, 1, 1, PAL.shadow);
      fillRect(g, x + 13, y + 6, 1, 1, PAL.shadow);
    }

    function drawStationPlatform(g, station, trackY, trackH) {
      const { x, w } = station;
      const roofX = x + 6;
      const roofW = w - 12;

      fillRect(g, x, trackY - 4, w, trackH + 8, '#3e4b59');
      fillRect(g, x, trackY - 4, w, 1, '#7f90a2');
      fillRect(g, x, trackY - 3, w, 1, '#5a6a79');
      fillRect(g, x, trackY + trackH + 3, w, 1, '#2b3440');
      for (let xx = x + 2; xx < x + w - 2; xx += 12) fillRect(g, xx, trackY + trackH - 2, 8, 2, '#516071');

      // Canopy roof and support posts.
      fillRect(g, roofX, trackY - 38, roofW, 14, PAL.ink);
      fillRect(g, roofX + 1, trackY - 37, roofW - 2, 12, PAL.molding);
      fillRect(g, roofX + 2, trackY - 36, roofW - 4, 2, 'rgba(255,255,255,0.25)');
      for (let xx = roofX + 8; xx < roofX + roofW - 8; xx += 14) fillRect(g, xx, trackY - 31, 8, 1, '#6f3d6f');

      fillRect(g, x + 8, trackY - 24, 4, 20, PAL.ink);
      fillRect(g, x + 9, trackY - 24, 2, 20, PAL.steel);
      fillRect(g, x + w - 12, trackY - 24, 4, 20, PAL.ink);
      fillRect(g, x + w - 11, trackY - 24, 2, 20, PAL.steel);

      // Departure board + station sign.
      fillRect(g, x + w / 2 - 24, trackY - 34, 48, 12, PAL.ink);
      fillRect(g, x + w / 2 - 23, trackY - 33, 46, 10, PAL.gold);
      fillRect(g, x + w / 2 - 10, trackY - 37, 20, 3, PAL.ink);
      fillRect(g, x + w / 2 - 9, trackY - 36, 18, 2, '#2a2a3a');
      fillRect(g, x + w / 2 - 8, trackY - 35, 4, 1, '#f26a7d');
      fillRect(g, x + w / 2 - 2, trackY - 35, 4, 1, '#6be3ff');
      fillRect(g, x + w / 2 + 4, trackY - 35, 4, 1, '#ffd75e');
      g.save();
      g.fillStyle = PAL.ink;
      g.font = 'bold 6px monospace';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('STATION', x + w / 2, trackY - 26, 36);
      g.restore();

      // Small poster kiosk for local flavor.
      fillRect(g, x + 16, trackY - 22, 12, 18, PAL.ink);
      fillRect(g, x + 17, trackY - 21, 10, 16, '#223247');
      fillRect(g, x + 18, trackY - 19, 8, 6, '#6be3ff');
      fillRect(g, x + 18, trackY - 11, 8, 5, '#f4c77a');

      drawBench(g, x + w / 2 - 8, trackY - 10);
    }

    function drawPlanter(g, x, y) {
      fillRect(g, x, y, 14, 8, PAL.ink);
      fillRect(g, x + 1, y + 1, 12, 6, '#5b3b26');
      fillRect(g, x + 1, y + 1, 12, 1, '#8c613c');
      fillRect(g, x + 2, y + 3, 3, 3, '#3e8948');
      fillRect(g, x + 5, y + 2, 4, 4, '#63c74d');
      fillRect(g, x + 9, y + 3, 3, 3, '#3e8948');
    }

    function drawFountain(g, cx, y) {
      fillRect(g, cx - 20, y + 16, 40, 10, PAL.ink);
      fillRect(g, cx - 19, y + 17, 38, 8, '#5a6674');
      fillRect(g, cx - 17, y + 18, 34, 5, '#7d8a99');

      fillRect(g, cx - 11, y + 5, 22, 14, PAL.ink);
      fillRect(g, cx - 10, y + 6, 20, 12, '#6a7685');
      fillRect(g, cx - 9, y + 10, 18, 7, '#6be3ff');
      fillRect(g, cx - 8, y + 11, 16, 1, '#bfe9ff');

      fillRect(g, cx - 3, y + 1, 6, 8, PAL.ink);
      fillRect(g, cx - 2, y + 2, 4, 6, '#8c99a8');
      fillRect(g, cx - 1, y, 2, 2, '#bfe9ff');
    }

    /** A wide, left-to-right scrolling town: storefronts, sidewalks, a rail
     * line with platforms at both ends, and a lower plaza for strolling. */
    function renderTownBackground(blackMarket = false) {
      const W = TOWN_WORLD.width;
      const H = CONFIG.HEIGHT;
      const { canvas, g } = createLayer(W, H);
      fillRect(g, 0, 0, W, H, PAL.ink);

      const buildY = 20;
      const buildH = 62;
      const walkY = buildY + buildH; // 82
      const walkH = 30;
      const trackY = walkY + walkH; // 112
      const trackH = 30;
      const plazaY = trackY + trackH; // 142
      const plazaH = H - 10 - plazaY;

      // Night sky with distant skyline.
      fillRect(g, 8, buildY, W - 16, buildH, '#0f1a2a');
      fillRect(g, 8, buildY + 20, W - 16, buildH - 20, '#16253a');
      fillRect(g, 8, buildY + 36, W - 16, buildH - 36, '#1b2b40');

      for (let i = 0; i < 68; i++) {
        const sx = 10 + ((i * 53) % (W - 24));
        const sy = buildY + 3 + ((i * 17) % 15);
        fillRect(g, sx, sy, i % 4 === 0 ? 2 : 1, 1, i % 5 === 0 ? '#fff0bc' : '#d8e6ff');
      }

      for (let i = 0; i < 38; i++) {
        const tw = 10 + ((i * 7) % 16);
        const th = 10 + ((i * 11) % 22);
        const tx = 8 + ((i * 41) % (W - 16 - tw));
        const ty = buildY + buildH - th - 2;
        fillRect(g, tx, ty, tw, th, i % 2 ? '#1b2433' : '#222c3d');
        for (let wy = ty + 2; wy < ty + th - 1; wy += 4) {
          for (let wx = tx + 2; wx < tx + tw - 1; wx += 4) {
            if ((wx + wy + i) % 5 === 0) fillRect(g, wx, wy, 1, 1, '#f8d788');
          }
        }
      }

      for (const def of STORE_DEFS) drawStoreFacade(g, blackMarket ? storeDefForTown(def, 2) : def, buildY, buildH);

      // Sidewalk with paver motif and soft building shadow.
      fillRect(g, 8, walkY, W - 16, walkH, '#2c3a4c');
      for (let yy = walkY + 2; yy < walkY + walkH; yy += 6) {
        for (let xx = 10; xx < W - 10; xx += 14) {
          fillRect(g, xx, yy, 10, 3, (xx + yy) % 28 === 0 ? '#3b4c60' : '#34465a');
        }
      }
      fillRect(g, 8, walkY, W - 16, 1, '#4b5f77');
      fillRect(g, 8, walkY, W - 16, 3, 'rgba(0,0,0,0.22)');
      drawStreetlight(g, 44, walkY);
      drawStreetlight(g, W - 44, walkY);
      for (let i = 0; i < STORE_DEFS.length - 1; i++) {
        const gapX = STORE_DEFS[i].x + STORE_DEFS[i].w + STORE_GAP / 2;
        if (i % 2 === 0) drawStreetlight(g, gapX, walkY);
        else drawBench(g, gapX - 8, walkY + walkH - 10);
      }

      // Rail band: ballast, sleepers and dual steel rails.
      fillRect(g, 8, trackY, W - 16, trackH, '#2a3226');
      for (let yy = trackY + 2; yy < trackY + trackH - 1; yy += 4) {
        for (let xx = 9; xx < W - 9; xx += 5) fillRect(g, xx, yy, 2, 1, (xx + yy) % 3 ? '#3a4331' : '#46513a');
      }
      for (let x = 8; x < W - 8; x += 14) {
        fillRect(g, x, trackY + 7, 8, 4, '#564933');
        fillRect(g, x, trackY + 8, 8, 1, '#7a6748');
      }
      fillRect(g, 8, trackY + 11, W - 16, 2, '#9ca6ad');
      fillRect(g, 8, trackY + 12, W - 16, 1, '#d4dce2');
      fillRect(g, 8, trackY + 19, W - 16, 2, '#9ca6ad');
      fillRect(g, 8, trackY + 20, W - 16, 1, '#d4dce2');
      drawStationPlatform(g, TOWN_WORLD.stationLeft, trackY, trackH);
      drawStationPlatform(g, TOWN_WORLD.stationRight, trackY, trackH);

      // Plaza: tiled stones, central fountain, planters and lamps.
      for (let ty = 0; ty < plazaH / 12; ty++) {
        for (let tx = 0; tx < (W - 16) / 12; tx++) {
          const xx = 8 + tx * 12;
          const yy = plazaY + ty * 12;
          fillRect(g, xx, yy, 12, 12, (tx + ty) % 2 === 0 ? '#37485a' : '#314153');
          fillRect(g, xx + 3, yy + 3, 1, 1, '#42586e');
          fillRect(g, xx + 8, yy + 8, 1, 1, '#2a3746');
        }
      }

      const fountainX = Math.floor(W / 2);
      drawFountain(g, fountainX, plazaY + 26);
      drawPlanter(g, fountainX - 88, plazaY + 60);
      drawPlanter(g, fountainX + 74, plazaY + 60);
      drawStreetlight(g, fountainX - 118, plazaY + 18);
      drawStreetlight(g, fountainX + 118, plazaY + 18);
      drawBench(g, fountainX - 38, plazaY + 68);
      drawBench(g, fountainX + 24, plazaY + 68);

      // Outer trim
      fillRect(g, 8, buildY, W - 16, 2, PAL.molding);
      fillRect(g, 8, H - 10, W - 16, 2, PAL.molding);
      fillRect(g, 8, buildY, 2, H - 10 - buildY, PAL.molding);
      fillRect(g, W - 10, buildY, 2, H - 10 - buildY, PAL.molding);
      return canvas;
    }

    function drawTownAmbient(viewX, time, townIndex = 1) {
      // Star twinkle parallax.
      for (let i = 0; i < 22; i++) {
        const wx = 14 + ((i * 117) % (TOWN_WORLD.width - 28));
        const sx = Math.round(wx - viewX);
        if (sx < 8 || sx > CONFIG.WIDTH - 10) continue;
        const sy = 24 + ((i * 19) % 13);
        const pulse = (Math.floor(time * 4) + i) % 6;
        if (pulse <= 1) fillRect(ctx, sx, sy, 1, 1, '#fff0bc');
        if (pulse === 0) fillRect(ctx, sx - 1, sy, 3, 1, 'rgba(255, 240, 188, 0.35)');
      }

      // Sign bulbs blinking along awnings.
      for (const storeDef of STORE_DEFS) {
        const def = storeDefForTown(storeDef, townIndex);
        const baseX = Math.round(def.x - viewX);
        if (baseX > CONFIG.WIDTH || baseX + def.w < 0) continue;
        if (def.rundown) {
          // Mostly dead bulbs with one occasional red flicker.
          if (Math.floor(time * 6) % 9 === 0) fillRect(ctx, baseX + 10 + 18 * (Math.floor(time * 6 / 9) % 4), 50, 2, 2, '#8a2a2e');
          continue;
        }
        for (let i = 0; i < 4; i++) {
          const lit = ((Math.floor(time * 8) + i + Math.floor(def.x / 8)) % 4) <= 1;
          const bx = baseX + 10 + i * 18;
          fillRect(ctx, bx, 50, 2, 2, lit ? def.sign : '#4e4e4e');
        }
      }

      // Fountain shimmer.
      const fountainX = Math.floor(TOWN_WORLD.width / 2);
      const screenFountainX = Math.round(fountainX - viewX);
      if (screenFountainX > 24 && screenFountainX < CONFIG.WIDTH - 24) {
        const wave = Math.floor(time * 10) % 10;
        fillRect(ctx, screenFountainX - 8 + wave, 180, 4, 1, '#bfe9ff');
        fillRect(ctx, screenFountainX - 11 + ((wave + 5) % 10), 182, 3, 1, '#9fe4ff');
      }
    }

    function drawInteriorAmbient(areaType, time) {
      const t = Math.floor(time * 8);

      switch (areaType) {
        case 'bakery': {
          // Oven bloom, pastry-warmer pulse, and drifting flour motes.
          const flicker = (t % 4) <= 1;
          fillRect(ctx, 48, 58, 18, 4, flicker ? '#f8b06d' : '#e18c55');
          fillRect(ctx, 126, 61, 12, 2, (t % 6) < 3 ? '#ffdca8' : '#f3b777');
          for (let i = 0; i < 4; i++) {
            const sx = 38 + i * 8;
            const sy = 54 - ((t + i * 2) % 7);
            fillRect(ctx, sx, sy, 1, 1, 'rgba(255, 215, 130, 0.45)');
          }
          fillRect(ctx, 222, 50 + (t % 3), 1, 1, 'rgba(255,248,225,0.3)');
          break;
        }
        case 'supermarket': {
          // Checkout scanner pulse and cool aisle fluorescents shimmer.
          const pulse = (t % 6) < 3;
          fillRect(ctx, 252, 60, 14, 2, pulse ? '#ff6b6b' : '#6b1e1e');
          for (const x of [40, 92, 144, 196, 248]) {
            fillRect(ctx, x, 30, 18, 1, (t + x) % 5 < 3 ? 'rgba(220,242,255,0.28)' : 'rgba(160,190,220,0.16)');
          }
          fillRect(ctx, 58 + ((t * 2) % 152), 174, 10, 1, 'rgba(255,255,255,0.16)');
          break;
        }
        case 'cosmetics': {
          // Warm boutique lamp pulse + CRT scan flicker.
          const warm = (t % 6) < 3 ? '#ffd89d' : '#ffbf84';
          for (const x of [40, 88, 136, 184, 232, 280]) fillRect(ctx, x, 46, 4, 2, warm);
          fillRect(ctx, 170, 108, 12, 1, (t % 8) < 4 ? '#9ee6ff' : '#66bddc');

          // Mirror glints on side displays.
          const glintY = 60 + (t % 18);
          fillRect(ctx, 26, glintY, 18, 1, 'rgba(255,255,255,0.24)');
          fillRect(ctx, 276, 96 - (t % 18), 18, 1, 'rgba(255,255,255,0.2)');

          // Perfume sparkle along the counter accessories.
          const sparkle = 70 + ((t % 10) * 15);
          if (sparkle < 240) fillRect(ctx, sparkle, 111, 1, 1, '#ffe9f8');
          break;
        }
        case 'toy': {
          // Twinkling stars, marquee bulbs, and rocket porthole blink.
          for (let i = 0; i < 8; i++) {
            const sx = 30 + i * 30;
            const on = ((t + i) % 5) === 0;
            if (on) fillRect(ctx, sx, 30 + (i % 3) * 3, 1, 1, '#fff3ad');
          }
          for (let i = 0; i < 9; i++) {
            const lit = ((t + i) % 4) <= 1;
            fillRect(ctx, 34 + i * 24, 52, 2, 2, lit ? '#ffd75e' : '#7f5a2f');
          }
          fillRect(ctx, 267, 50, 4, 4, (t % 8) < 4 ? '#bcd9ff' : '#8ea9d8');
          break;
        }
        case 'restaurant': {
          // Lantern pulse, prep steam, and neon sign sweep.
          const warm = (t % 6) < 3 ? '#ffd89a' : '#ffbe78';
          for (const x of [54, 108, 162, 216, 270]) fillRect(ctx, x + 2, 35, 4, 2, warm);
          for (let i = 0; i < 4; i++) {
            const sx = 70 + i * 52;
            const sy = 44 - ((t + i) % 5);
            fillRect(ctx, sx, sy, 1, 1, 'rgba(230, 240, 255, 0.35)');
          }
          fillRect(ctx, 136 + (t % 34), 41, 8, 1, 'rgba(255,233,185,0.28)');
          break;
        }
        case 'electronics': {
          // TV wall scanline, kiosk LEDs, and floor reflection pulse.
          const scanY = 42 + (t % 18);
          for (let x = 32; x < 290; x += 44) fillRect(ctx, x + 2, scanY, 32, 1, 'rgba(255,255,255,0.2)');
          fillRect(ctx, 146, 60, 8, 2, (t % 10) < 5 ? '#9cf5ff' : '#62d1ec');
          fillRect(ctx, 80, 72, 3, 2, (t % 12) < 4 ? '#7dff9b' : '#355f41');
          fillRect(ctx, 236, 72, 3, 2, (t % 12) >= 6 ? '#ff7dcb' : '#5f324b');
          fillRect(ctx, 126 + ((t * 2) % 56), 176, 12, 1, 'rgba(107,227,255,0.16)');
          break;
        }
        case 'gift': {
          // Fairy-light sparkle, moon alcove shimmer, and ribbon glint.
          for (let i = 0; i < 10; i++) {
            const on = ((t + i * 2) % 9) === 0;
            if (!on) continue;
            fillRect(ctx, 42 + i * 24, 34 + (i % 2), 1, 1, '#ffe8a3');
          }
          fillRect(ctx, 267, 32, 3, 2, (t % 8) < 4 ? '#fff3c7' : '#f6d98f');
          fillRect(ctx, 84 + ((t * 2) % 118), 64, 8, 1, 'rgba(255,230,179,0.2)');
          break;
        }
        case 'butcher': {
          // Cold-case sheen, hanging lamp flicker, and steel sparkle.
          const sweep = 84 + ((t * 3) % 146);
          fillRect(ctx, sweep, 61, 8, 1, 'rgba(255,255,255,0.22)');
          fillRect(ctx, 148, 34, 6, 2, (t % 6) < 3 ? '#fff5de' : '#d7d0c2');
          fillRect(ctx, 226, 44 + (t % 2), 1, 1, 'rgba(255,255,255,0.4)');
          break;
        }
        case 'fishing': {
          // Tank bubbles, lure glint, and waterline caustic shimmer.
          for (let i = 0; i < 3; i++) {
            const sx = 236 + i * 15;
            const sy = 70 - ((t + i * 3) % 16);
            fillRect(ctx, sx, sy, 2, 2, 'rgba(210, 244, 255, 0.45)');
          }
          fillRect(ctx, 266, 58, 3, 1, (t % 6) < 3 ? '#ffe07f' : '#f4c77a');
          fillRect(ctx, 228 + ((t * 2) % 40), 52, 10, 1, 'rgba(196,241,255,0.2)');
          break;
        }
        default:
          break;
      }
    }

    function interiorStyle(def) {
      switch (def.id) {
        case 'bakery':
          return { wallA: '#6a3d2a', wallB: '#8b5337', molding: '#c28a57', floorA: '#5a3927', floorB: '#67422d', trim: '#402619', sign: '#f6d08a', panel: '#9b6642' };
        case 'supermarket':
          return { wallA: '#214f34', wallB: '#2e6a45', molding: '#b8f87d', floorA: '#d8e1e9', floorB: '#c7d1db', trim: '#748392', sign: '#ccff96', panel: '#3b7a4f' };
        case 'toy':
          return { wallA: '#203b73', wallB: '#2b4f90', molding: '#ffe06f', floorA: '#2a3160', floorB: '#343d73', trim: '#151d3a', sign: '#ffe58f', panel: '#4760a6' };
        case 'restaurant':
          return { wallA: '#602438', wallB: '#81304d', molding: '#ff9f67', floorA: '#202d36', floorB: '#2a3740', trim: '#111820', sign: '#ffc191', panel: '#974263' };
        case 'electronics':
          return { wallA: '#1b3049', wallB: '#264260', molding: '#73ebff', floorA: '#1c2734', floorB: '#263344', trim: '#101723', sign: '#8bf1ff', panel: '#315172' };
        case 'gift':
          return { wallA: '#2f2a58', wallB: '#3d3674', molding: '#ffbde9', floorA: '#4c3f81', floorB: '#584a91', trim: '#2b2550', sign: '#ffe0f5', panel: '#7464aa' };
        case 'butcher':
          return { wallA: '#d9dce1', wallB: '#eff2f5', molding: '#cc5f4e', floorA: '#c2c9d1', floorB: '#b0bac4', trim: '#8a94a3', sign: '#ffd7a7', panel: '#ffffff' };
        case 'fishing':
          return { wallA: '#2a4855', wallB: '#365d6d', molding: '#a5e1f4', floorA: '#5d4b35', floorB: '#71593f', trim: '#433525', sign: '#c2f0ff', panel: '#3f697c' };
        default:
          return { wallA: def.wall, wallB: def.roof, molding: def.accent, floorA: '#324050', floorB: '#2b3745', trim: '#1f2832', sign: def.sign, panel: def.roof };
      }
    }

    function drawInteriorWallFinish(g, def, style) {
      fillRect(g, 12, 24, 296, 56, style.wallB);
      for (let y = 24; y < 80; y += 8) fillRect(g, 12, y, 296, 1, 'rgba(255,255,255,0.06)');

      switch (def.id) {
        case 'bakery':
          for (let y = 27; y < 78; y += 8) {
            for (let x = 16; x < 304; x += 16) fillRect(g, x, y, 12, 4, style.panel);
          }
          break;
        case 'supermarket':
          for (let y = 26; y < 80; y += 10) fillRect(g, 14, y, 292, 4, style.panel);
          for (let x = 20; x < 302; x += 24) fillRect(g, x, 24, 2, 56, 'rgba(255,255,255,0.13)');
          break;
        case 'toy':
          for (let x = 16; x < 304; x += 18) {
            for (let y = 26; y < 78; y += 12) fillRect(g, x, y, 6, 6, style.panel);
          }
          for (let i = 0; i < 24; i++) fillRect(g, 20 + (i * 23) % 280, 28 + (i * 11) % 46, 1, 1, i % 2 ? '#dcefff' : '#ffe790');
          break;
        case 'restaurant':
          for (let y = 28; y < 78; y += 9) fillRect(g, 14, y, 292, 2, style.panel);
          for (let x = 16; x < 304; x += 16) fillRect(g, x, 24, 1, 56, 'rgba(255,195,150,0.16)');
          break;
        case 'electronics':
          for (let y = 26; y < 80; y += 8) {
            for (let x = 14; x < 306; x += 14) {
              fillRect(g, x, y, 10, 5, style.panel);
              fillRect(g, x + 8, y + 1, 1, 1, '#6be3ff');
            }
          }
          break;
        case 'gift':
          for (let y = 26; y < 80; y += 10) {
            for (let x = 18; x < 302; x += 20) fillRect(g, x, y, 8, 6, style.panel);
          }
          break;
        case 'butcher':
          for (let y = 26; y < 80; y += 8) {
            for (let x = 14; x < 306; x += 14) {
              fillRect(g, x, y, 12, 6, style.panel);
              fillRect(g, x + 11, y, 1, 6, '#c9cfd8');
            }
          }
          break;
        case 'fishing':
          for (let y = 27; y < 80; y += 10) fillRect(g, 14, y, 292, 5, style.panel);
          for (let x = 16; x < 304; x += 16) fillRect(g, x, 24, 1, 56, 'rgba(200,238,255,0.12)');
          break;
        default:
          for (let x = 16; x < 304; x += 18) fillRect(g, x, 24, 1, 56, 'rgba(255,255,255,0.08)');
          break;
      }
    }

    function drawInteriorFloorFinish(g, def, style) {
      for (let y = 90; y < 230; y += 12) {
        for (let x = 10; x < 310; x += 12) {
          fillRect(g, x, y, 12, 12, (Math.floor((x + y) / 12) % 2 === 0) ? style.floorA : style.floorB);
          fillRect(g, x + 4, y + 4, 1, 1, 'rgba(255,255,255,0.09)');
        }
      }

      switch (def.id) {
        case 'bakery':
          for (let y = 92; y < 228; y += 14) fillRect(g, 10, y, 300, 2, 'rgba(0,0,0,0.12)');
          break;
        case 'fishing':
          for (let y = 92; y < 228; y += 14) fillRect(g, 10, y, 300, 2, 'rgba(0,0,0,0.12)');
          for (let x = 14; x < 306; x += 18) fillRect(g, x, 92, 1, 134, 'rgba(190,228,240,0.08)');
          break;
        case 'supermarket':
        case 'butcher':
          for (let x = 12; x < 308; x += 24) fillRect(g, x, 92, 2, 136, 'rgba(255,255,255,0.14)');
          break;
        case 'electronics':
          for (let y = 96; y < 228; y += 16) {
            for (let x = 14; x < 306; x += 16) fillRect(g, x, y, 6, 1, 'rgba(107,227,255,0.16)');
          }
          break;
        case 'restaurant':
          for (let y = 92; y < 228; y += 18) fillRect(g, 12, y, 296, 2, 'rgba(255,143,94,0.14)');
          break;
        case 'gift':
          for (let x = 16; x < 304; x += 26) {
            for (let y = 96; y < 226; y += 26) fillRect(g, x, y, 2, 2, 'rgba(255,243,173,0.2)');
          }
          break;
        case 'toy':
          for (let y = 94; y < 226; y += 20) {
            for (let x = 16; x < 304; x += 20) fillRect(g, x, y, 2, 2, 'rgba(255,224,111,0.18)');
          }
          break;
        default:
          break;
      }
    }

    function drawInteriorMoodLighting(g, def) {
      switch (def.id) {
        case 'bakery': {
          for (let i = 0; i < 4; i++) {
            const pad = i * 7;
            fillRect(g, 24 + pad, 96 + pad / 2, 112 - pad * 2, 76 - pad, 'rgba(255, 178, 114, 0.05)');
          }
          fillRect(g, 224, 94, 68, 42, 'rgba(255, 215, 142, 0.06)');
          break;
        }
        case 'supermarket': {
          for (let i = 0; i < 3; i++) {
            const pad = i * 8;
            fillRect(g, 24 + pad, 98 + pad / 3, 272 - pad * 2, 56 - pad, 'rgba(198, 232, 255, 0.04)');
          }
          fillRect(g, 28, 154, 264, 38, 'rgba(190, 206, 220, 0.04)');
          break;
        }
        case 'toy': {
          for (let i = 0; i < 5; i++) {
            const pad = i * 6;
            fillRect(g, 74 + pad, 108 + pad / 2, 172 - pad * 2, 74 - pad, 'rgba(120, 156, 255, 0.045)');
          }
          fillRect(g, 240, 92, 58, 54, 'rgba(255, 130, 198, 0.05)');
          break;
        }
        case 'restaurant': {
          for (let i = 0; i < 4; i++) {
            const pad = i * 8;
            fillRect(g, 70 + pad, 108 + pad / 2, 178 - pad * 2, 76 - pad, 'rgba(255, 172, 120, 0.05)');
          }
          fillRect(g, 22, 98, 118, 50, 'rgba(255, 223, 171, 0.04)');
          break;
        }
        case 'electronics': {
          for (let i = 0; i < 4; i++) {
            const pad = i * 8;
            fillRect(g, 70 + pad, 104 + pad / 2, 180 - pad * 2, 80 - pad, 'rgba(122, 214, 255, 0.045)');
          }
          fillRect(g, 24, 136, 272, 70, 'rgba(68, 128, 176, 0.04)');
          break;
        }
        case 'gift': {
          for (let i = 0; i < 4; i++) {
            const pad = i * 7;
            fillRect(g, 78 + pad, 110 + pad / 2, 164 - pad * 2, 72 - pad, 'rgba(255, 190, 232, 0.05)');
          }
          fillRect(g, 240, 88, 58, 48, 'rgba(255, 241, 196, 0.05)');
          break;
        }
        case 'butcher': {
          fillRect(g, 20, 98, 276, 40, 'rgba(220, 232, 240, 0.055)');
          for (let i = 0; i < 3; i++) {
            const pad = i * 8;
            fillRect(g, 74 + pad, 118 + pad / 2, 172 - pad * 2, 68 - pad, 'rgba(196, 209, 222, 0.045)');
          }
          break;
        }
        case 'fishing': {
          for (let i = 0; i < 4; i++) {
            const pad = i * 8;
            fillRect(g, 72 + pad, 108 + pad / 2, 176 - pad * 2, 74 - pad, 'rgba(126, 198, 224, 0.045)');
          }
          fillRect(g, 220, 92, 72, 56, 'rgba(162, 226, 244, 0.05)');
          break;
        }
        default:
          break;
      }
    }

    function drawInteriorDecor(g, def) {
      switch (def.id) {
        case 'bakery': {
          // Rustic oven bay, pastry gallery, prep bench, and menu nook.
          fillRect(g, 24, 36, 74, 42, PAL.ink);
          fillRect(g, 26, 38, 70, 38, '#6f3f2b');
          fillRect(g, 32, 48, 58, 24, '#8c5338');
          fillRect(g, 40, 53, 42, 14, '#2c1e17');
          fillRect(g, 46, 57, 30, 8, '#f4a76b');
          fillRect(g, 30, 42, 62, 2, '#b77a4b');

          fillRect(g, 106, 36, 184, 42, PAL.ink);
          fillRect(g, 108, 38, 180, 10, '#925f3f');
          fillRect(g, 108, 50, 180, 8, '#6f462d');
          fillRect(g, 108, 60, 180, 16, '#5a3825');
          for (let x = 114; x < 286; x += 22) {
            fillRect(g, x, 40, 14, 6, '#f4d18a');
            fillRect(g, x + 2, 62, 10, 7, '#f2be7e');
          }

          fillRect(g, 182, 38, 46, 16, '#f5e5c1');
          fillRect(g, 184, 40, 42, 12, '#f4c77a');

          fillRect(g, 24, 80, 90, 18, PAL.ink);
          fillRect(g, 26, 82, 86, 14, '#7b4a31');
          fillRect(g, 28, 84, 82, 2, '#ba8154');
          for (let x = 34; x < 104; x += 18) {
            fillRect(g, x, 87, 12, 7, ['#e9c07a', '#f4d18a', '#d99e63'][(x / 18) % 3]);
          }

          fillRect(g, 246, 82, 44, 22, PAL.ink);
          fillRect(g, 248, 84, 40, 18, '#efe4d2');
          fillRect(g, 250, 86, 36, 4, '#c28a57');
          fillRect(g, 252, 92, 32, 8, '#8b5337');
          break;
        }
        case 'supermarket': {
          // Produce lanes, freezer wall, endcaps, and checkout lane.
          for (let row = 0; row < 2; row++) {
            fillRect(g, 24, 38 + row * 18, 272, 12, PAL.ink);
            fillRect(g, 26, 40 + row * 18, 268, 8, '#dce5ec');
            for (let x = 30; x < 292; x += 24) {
              const c = ['#63c74d', '#e4a672', '#41a6f6', '#ffd75e'][(x / 24 + row) % 4];
              fillRect(g, x, 41 + row * 18, 14, 6, c);
            }
          }

          fillRect(g, 30, 56, 56, 20, PAL.ink);
          fillRect(g, 32, 58, 52, 16, '#97d365');
          fillRect(g, 244, 50, 48, 26, PAL.ink);
          fillRect(g, 246, 52, 44, 22, '#c6d0da');
          fillRect(g, 250, 56, 20, 8, '#3f5364');
          fillRect(g, 272, 58, 14, 10, '#8696a8');

          for (let x = 90; x < 232; x += 34) {
            fillRect(g, x, 52, 24, 24, PAL.ink);
            fillRect(g, x + 2, 54, 20, 20, '#d5dee8');
            fillRect(g, x + 4, 58, 16, 4, ['#7ec5ff', '#f7b36b', '#8fd66f', '#f7e27b'][(x / 34) % 4]);
            fillRect(g, x + 6, 64, 12, 8, '#b9c8d6');
          }

          fillRect(g, 250, 32, 38, 16, PAL.ink);
          fillRect(g, 252, 34, 34, 12, '#8da3b6');
          fillRect(g, 254, 36, 30, 8, '#c4d4e2');
          break;
        }
        case 'toy': {
          // Space shelves, capsule rocket, plush wall, and arcade chest.
          fillRect(g, 26, 36, 216, 42, PAL.ink);
          fillRect(g, 28, 38, 212, 40, '#243d70');
          fillRect(g, 28, 38, 212, 12, '#304f8f');
          for (let i = 0; i < 24; i++) fillRect(g, 34 + (i * 17) % 198, 40 + (i * 9) % 8, 1, 1, i % 3 ? '#d8ecff' : '#ffe790');
          for (let x = 34; x < 234; x += 22) {
            fillRect(g, x, 52, 14, 4, ['#f26a7d', '#ffd75e', '#41a6f6', '#5fae4a'][(x / 22) % 4]);
            fillRect(g, x + 2, 60, 10, 10, ['#41a6f6', '#ffd75e', '#f26a7d', '#5fae4a'][(x / 22 + 1) % 4]);
          }

          fillRect(g, 248, 36, 44, 42, PAL.ink);
          fillRect(g, 250, 38, 40, 38, '#21365f');
          fillRect(g, 264, 42, 12, 20, '#f26a7d');
          fillRect(g, 262, 62, 16, 10, '#d6deea');
          fillRect(g, 254, 72, 32, 3, '#4565a8');

          fillRect(g, 22, 80, 94, 24, PAL.ink);
          fillRect(g, 24, 82, 90, 20, '#3d5896');
          for (let x = 30; x < 104; x += 16) {
            fillRect(g, x, 86, 10, 6, ['#ffb3e6', '#ffd75e', '#8ad8f0', '#7ed957'][(x / 16) % 4]);
            fillRect(g, x + 2, 94, 6, 6, '#f4ecd8');
          }

          fillRect(g, 248, 80, 44, 24, PAL.ink);
          fillRect(g, 250, 82, 40, 20, '#2a4374');
          fillRect(g, 254, 86, 32, 8, '#5aa3ff');
          fillRect(g, 260, 95, 20, 4, '#ffcf68');
          break;
        }
        case 'restaurant': {
          // Noodle bar, booth row, prep station, and bottle shelf.
          fillRect(g, 24, 40, 272, 18, PAL.ink);
          fillRect(g, 26, 42, 268, 14, '#2b2019');
          fillRect(g, 34, 45, 252, 2, '#f4ecd8');
          for (let x = 42; x < 286; x += 30) {
            fillRect(g, x, 58, 10, 6, '#8d5430');
            fillRect(g, x + 2, 60, 6, 12, '#5c3821');
          }

          for (const x of [34, 116, 198]) {
            fillRect(g, x, 64, 72, 12, '#7f3250');
            fillRect(g, x + 8, 68, 56, 3, '#f4ecd8');
          }

          for (let x = 50; x < 290; x += 48) {
            fillRect(g, x, 26, 10, 10, '#ffdca8');
            fillRect(g, x + 3, 34, 4, 4, '#ff8f5e');
          }

          fillRect(g, 24, 80, 118, 24, PAL.ink);
          fillRect(g, 26, 82, 114, 20, '#3b2921');
          fillRect(g, 30, 86, 106, 3, '#c9824f');
          for (let x = 34; x < 130; x += 18) {
            fillRect(g, x, 91, 10, 9, ['#f5d68a', '#d3e4f6', '#f5b9a8'][(x / 18) % 3]);
          }

          fillRect(g, 246, 80, 44, 24, PAL.ink);
          fillRect(g, 248, 82, 40, 20, '#4b2f26');
          fillRect(g, 252, 85, 32, 5, '#6d4335');
          fillRect(g, 254, 93, 28, 7, '#b17644');
          break;
        }
        case 'electronics': {
          // TV wall, display desk, demo kiosks, and component bay.
          fillRect(g, 22, 34, 276, 44, PAL.ink);
          fillRect(g, 24, 36, 272, 40, '#1b2838');
          for (let x = 28; x < 292; x += 44) {
            fillRect(g, x, 40, 36, 14, '#0b1420');
            fillRect(g, x + 2, 42, 32, 10, ['#6be3ff', '#8cf0ff', '#5fcff0'][(x / 44) % 3]);
            fillRect(g, x, 58, 36, 14, '#0b1420');
            fillRect(g, x + 2, 60, 32, 10, ['#4fb8ff', '#7be4ff', '#44a6f0'][(x / 44 + 1) % 3]);
          }

          fillRect(g, 126, 54, 68, 22, PAL.ink);
          fillRect(g, 128, 56, 64, 18, '#2d4256');
          fillRect(g, 138, 60, 44, 10, '#6be3ff');
          fillRect(g, 132, 72, 56, 2, '#3d5b72');

          for (const x of [28, 96, 224]) {
            fillRect(g, x, 80, 48, 24, PAL.ink);
            fillRect(g, x + 2, 82, 44, 20, '#223445');
            fillRect(g, x + 6, 86, 20, 10, '#0d1825');
            fillRect(g, x + 8, 88, 16, 6, ['#95f4ff', '#8fd7ff', '#9dffc7'][(x / 4) % 3]);
            fillRect(g, x + 30, 88, 10, 2, '#485f75');
            fillRect(g, x + 30, 92, 10, 2, '#485f75');
          }
          break;
        }
        case 'gift': {
          // Gift wall, ribbon stacks, card carousel, and moon alcove.
          fillRect(g, 30, 36, 260, 42, PAL.ink);
          fillRect(g, 32, 38, 256, 38, '#4f4488');
          for (let x = 40; x < 280; x += 26) {
            fillRect(g, x, 44, 20, 14, ['#b98bff', '#ffb3e6', '#ffd75e'][(x / 26) % 3]);
            fillRect(g, x + 8, 44, 4, 14, PAL.gold);
            fillRect(g, x, 60, 20, 10, ['#ffb3e6', '#ffd75e', '#b98bff'][(x / 26 + 1) % 3]);
            fillRect(g, x + 8, 60, 4, 10, PAL.gold);
          }
          fillRect(g, 256, 26, 20, 16, '#f4ecd8');
          fillRect(g, 260, 30, 12, 10, '#ffedb4');
          fillRect(g, 264, 30, 6, 10, '#f4ecd8');

          fillRect(g, 28, 80, 92, 24, PAL.ink);
          fillRect(g, 30, 82, 88, 20, '#5b4a92');
          for (let x = 34; x < 110; x += 18) {
            fillRect(g, x, 86, 12, 6, ['#ffd75e', '#ffb3e6', '#cfa4ff'][(x / 18) % 3]);
            fillRect(g, x + 4, 86, 2, 6, PAL.gold);
            fillRect(g, x + 2, 94, 8, 6, '#f4ecd8');
          }

          fillRect(g, 246, 80, 44, 24, PAL.ink);
          fillRect(g, 248, 82, 40, 20, '#6b5aa4');
          fillRect(g, 254, 86, 28, 10, '#f5e0f1');
          fillRect(g, 258, 90, 20, 2, '#d7b3ce');
          break;
        }
        case 'butcher': {
          // Tile prep wall, hanging hooks, deli case, and scale station.
          for (let y = 34; y < 76; y += 8) {
            for (let x = 22; x < 300; x += 12) {
              fillRect(g, x, y, 10, 6, '#f3f5f8');
              fillRect(g, x + 10, y, 1, 6, '#c9cfd8');
            }
          }
          for (let x = 58; x < 282; x += 34) {
            fillRect(g, x, 32, 2, 14, '#8d8d8d');
            fillRect(g, x - 2, 46, 6, 6, '#c25b4a');
          }

          fillRect(g, 74, 58, 170, 18, PAL.ink);
          fillRect(g, 76, 60, 166, 14, '#e9eef5');
          for (let x = 84; x < 236; x += 18) fillRect(g, x, 64, 12, 6, ['#c25b4a', '#da7d63', '#b95555'][(x / 18) % 3]);

          fillRect(g, 252, 58, 38, 18, PAL.ink);
          fillRect(g, 254, 60, 34, 14, '#6d4a33');
          fillRect(g, 260, 65, 22, 3, '#946749');

          fillRect(g, 26, 80, 96, 24, PAL.ink);
          fillRect(g, 28, 82, 92, 20, '#d2d9e1');
          fillRect(g, 30, 84, 88, 4, '#f2f5f8');
          fillRect(g, 36, 90, 30, 10, '#9aa6b5');
          fillRect(g, 72, 90, 42, 10, '#c5ccd4');
          fillRect(g, 86, 88, 14, 2, '#6f7d8c');

          fillRect(g, 246, 80, 44, 24, PAL.ink);
          fillRect(g, 248, 82, 40, 20, '#7f5a44');
          fillRect(g, 252, 86, 32, 4, '#9f7355');
          fillRect(g, 254, 92, 28, 8, '#5f4333');
          break;
        }
        case 'fishing': {
          // Rod rack, net wall, tackle bench, and fish tank showcase.
          fillRect(g, 26, 34, 188, 42, PAL.ink);
          fillRect(g, 28, 36, 184, 38, '#244d60');
          for (let x = 36; x < 206; x += 16) {
            fillRect(g, x, 40, 2, 28, '#8b7a5e');
            fillRect(g, x + 2, 42, 8, 2, '#9edcf0');
          }
          for (let x = 32; x < 210; x += 10) {
            for (let y = 38; y < 72; y += 8) fillRect(g, x, y, 1, 1, '#7bb2c4');
          }

          fillRect(g, 222, 40, 66, 36, PAL.ink);
          fillRect(g, 224, 42, 62, 32, '#193544');
          fillRect(g, 226, 50, 58, 22, '#5cb8d0');
          fillRect(g, 228, 52, 54, 1, '#b8ebff');
          fillRect(g, 238, 60, 10, 4, '#f4c77a');
          fillRect(g, 258, 58, 12, 5, '#ffd75e');
          fillRect(g, 228, 72, 54, 2, '#3b6073');

          fillRect(g, 24, 80, 108, 24, PAL.ink);
          fillRect(g, 26, 82, 104, 20, '#355f74');
          fillRect(g, 30, 86, 96, 4, '#4f7e93');
          for (let x = 34; x < 118; x += 16) {
            fillRect(g, x, 92, 10, 8, ['#c4a16f', '#9ec8d8', '#e0c48b'][(x / 16) % 3]);
          }

          fillRect(g, 246, 80, 44, 24, PAL.ink);
          fillRect(g, 248, 82, 40, 20, '#3e6a7d');
          fillRect(g, 252, 86, 32, 5, '#6f5a42');
          fillRect(g, 254, 93, 28, 7, '#24475a');
          break;
        }
        default:
          break;
      }
    }

    /** Shared layout for every walk-in store interior (counter position
     * matches the collider in AREAS so the look and the physics agree). */
    function renderGenericInteriorBackground(def) {
      const style = interiorStyle(def);
      const { canvas, g } = createLayer(CONFIG.WIDTH, CONFIG.HEIGHT);
      fillRect(g, 0, 0, CONFIG.WIDTH, CONFIG.HEIGHT, PAL.ink);
      fillRect(g, 8, 20, 304, 212, style.wallA);

      // Layered wall treatment.
      drawInteriorWallFinish(g, def, style);
      fillRect(g, 8, 20, 304, 2, PAL.ink);
      fillRect(g, 8, 22, 304, 2, 'rgba(255,255,255,0.1)');
      fillRect(g, 8, 80, 304, 3, PAL.ink);
      fillRect(g, 8, 83, 304, 4, style.molding);
      fillRect(g, 8, 87, 304, 3, style.trim);
      fillRect(g, 8, 90, 304, 1, PAL.ink);

      // Floor tiles / planks.
      drawInteriorFloorFinish(g, def, style);
      fillRect(g, 8, 90, 304, 3, 'rgba(0,0,0,0.25)');

      // Counter must stay at collider coords: x50,y58,w220,h20.
      fillRect(g, 48, 56, 224, 24, PAL.ink);
      fillRect(g, 49, 57, 222, 22, style.trim);
      fillRect(g, 50, 58, 220, 20, def.accent);
      fillRect(g, 50, 58, 220, 2, 'rgba(255,255,255,0.24)');
      fillRect(g, 50, 77, 220, 1, 'rgba(0,0,0,0.3)');
      for (let x = 52; x < 268; x += 20) fillRect(g, x, 70, 16, 6, 'rgba(0,0,0,0.16)');

      // Back sign and wall sconces.
      fillRect(g, 100, 28, 120, 14, PAL.ink);
      fillRect(g, 101, 29, 118, 12, style.sign);
      fillRect(g, 102, 30, 116, 2, 'rgba(255,255,255,0.22)');
      g.save();
      g.fillStyle = PAL.ink;
      g.font = 'bold 8px monospace';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(def.name, 160, 35, 116);
      g.restore();

      for (const sx of [40, 280]) {
        fillRect(g, sx - 4, 40, 8, 10, 'rgba(255, 205, 117, 0.12)');
        fillRect(g, sx - 1, 42, 2, 6, PAL.goldDark);
        fillRect(g, sx - 2, 41, 4, 2, PAL.gold);
      }

      // Framed wall accents for richer interior density.
      for (const fx of [24, 286]) {
        fillRect(g, fx - 8, 28, 16, 16, PAL.ink);
        fillRect(g, fx - 7, 29, 14, 14, style.molding);
        fillRect(g, fx - 5, 31, 10, 10, style.floorB);
      }

      // Soft central floor glow to echo lounge ambiance.
      for (let i = 0; i < 3; i++) {
        const pad = 8 + i * 8;
        fillRect(g, 86 + pad, 118 + pad / 2, 148 - pad * 2, 88 - pad, 'rgba(255, 215, 120, 0.03)');
      }

      drawInteriorMoodLighting(g, def);

      drawInteriorDecor(g, def);

      // Exit door remains x144-176, y210-230.
      fillRect(g, 142, 210, 36, 20, PAL.ink);
      fillRect(g, 144, 212, 32, 18, PAL.wainscotPanel);
      fillRect(g, 145, 213, 30, 2, 'rgba(255,255,255,0.18)');
      return canvas;
    }

    /** Black Market interior: bare dark room, a decrepit wooden counter and the hooded dealer.
     * The counter sits exactly on the shop collider (x50,y58,w220,h20). */
    function renderBlackMarketInterior() {
      const { canvas, g } = createLayer(CONFIG.WIDTH, CONFIG.HEIGHT);
      fillRect(g, 0, 0, CONFIG.WIDTH, CONFIG.HEIGHT, PAL.ink);
      fillRect(g, 8, 20, 304, 212, '#0e0e11');
      fillRect(g, 12, 24, 296, 56, '#141418');
      for (let x = 24; x < 304; x += 24) fillRect(g, x, 24, 1, 56, 'rgba(0,0,0,0.4)');
      fillRect(g, 8, 20, 304, 2, PAL.ink);
      fillRect(g, 8, 80, 304, 3, PAL.ink);
      fillRect(g, 8, 83, 304, 4, '#1a1a1e');
      fillRect(g, 8, 87, 304, 3, '#0b0b0d');
      fillRect(g, 8, 90, 304, 1, PAL.ink);

      // Bare floorboards.
      for (let y = 90, row = 0; y < 230; y += 12, row++) {
        fillRect(g, 10, y, 300, 12, row % 2 ? '#17171a' : '#1c1c20');
        fillRect(g, 10, y, 300, 1, 'rgba(0,0,0,0.35)');
        for (let x = 10 + ((row * 37) % 44); x < 310; x += 44) fillRect(g, x, y, 1, 12, 'rgba(0,0,0,0.35)');
      }
      fillRect(g, 8, 90, 304, 3, 'rgba(0,0,0,0.25)');

      // Faint pool of light around the counter.
      for (let i = 0; i < 3; i++) {
        const pad = i * 12;
        fillRect(g, 70 + pad, 82 + pad / 2, 180 - pad * 2, 60 - pad, 'rgba(150, 110, 90, 0.025)');
      }

      // Rickety wall shelf behind the dealer: clover, golden plus, severed hand.
      fillRect(g, 104, 47, 116, 2, 'rgba(0,0,0,0.45)');
      fillRect(g, 103, 43, 118, 5, PAL.ink);
      fillRect(g, 104, 44, 116, 3, '#4a3623');
      fillRect(g, 104, 44, 116, 1, '#6a5338');
      for (const bx of [110, 212]) {
        fillRect(g, bx, 47, 3, 6, PAL.ink);
        fillRect(g, bx + 1, 47, 1, 5, '#2a1c12');
      }
      fillRect(g, 132, 44, 5, 1, '#2a1c12'); // crack in the plank
      // (The curios on the shelf are drawn live so they vanish once sold.)

      // Hooded dealer (feet/robe hem are hidden behind the counter).
      fillRect(g, 144, 56, 32, 6, 'rgba(0,0,0,0.5)');
      g.drawImage(sprites.hooded, 150, 34);

      // Run-down wooden counter.
      const wood = ['#3d2c1e', '#46331f'];
      fillRect(g, 48, 56, 224, 24, PAL.ink);
      fillRect(g, 50, 58, 220, 6, '#5a4330');
      fillRect(g, 50, 58, 220, 1, '#7a5e42');
      fillRect(g, 50, 64, 220, 14, wood[0]);
      for (let x = 50, i = 0; x < 270; x += 22, i++) {
        fillRect(g, x, 64, Math.min(22, 270 - x), 14, wood[i % 2]);
        fillRect(g, x, 58, 1, 20, '#2a1c12');
        fillRect(g, x + 2, 65, 1, 1, '#8a8a8a');
        fillRect(g, x + 2, 76, 1, 1, '#8a8a8a');
      }
      fillRect(g, 50, 70, 220, 1, '#2a1c12');
      fillRect(g, 50, 77, 220, 1, 'rgba(0,0,0,0.5)');
      // Gouges, stains and chipped edge on the counter top.
      for (const [cx, cw] of [[96, 8], [205, 6], [248, 5]]) fillRect(g, cx, 58, cw, 2, '#14100c');
      fillRect(g, 180, 60, 10, 3, '#2e2016');
      fillRect(g, 112, 61, 14, 1, '#2a1c12');
      // Missing and hanging front planks.
      fillRect(g, 138, 64, 12, 14, '#0d0a08');
      fillRect(g, 136, 64, 2, 3, '#0d0a08');
      fillRect(g, 150, 71, 2, 3, '#0d0a08');
      fillRect(g, 229, 70, 3, 8, '#4a3623');
      fillRect(g, 231, 74, 3, 6, '#2a1c12');
      for (let i = 0; i < 6; i++) fillRect(g, 80 + (i % 2), 65 + i * 2, 1, 2, '#14100c');
      fillRect(g, 56, 82, 208, 3, 'rgba(0,0,0,0.3)');

      // Exit door remains x144-176, y210-230.
      fillRect(g, 142, 210, 36, 20, PAL.ink);
      fillRect(g, 144, 212, 32, 18, '#1b1612');
      fillRect(g, 145, 213, 30, 2, 'rgba(255,255,255,0.08)');
      return canvas;
    }

    /** Bank lobby: marble floor, round vault door, and a teller behind a barred
     * counter. The counter sits exactly on the shop collider (x50,y58,w220,h20). */
    function renderBankInterior() {
      const { canvas, g } = createLayer(CONFIG.WIDTH, CONFIG.HEIGHT);
      fillRect(g, 0, 0, CONFIG.WIDTH, CONFIG.HEIGHT, PAL.ink);
      fillRect(g, 8, 20, 304, 212, '#2a2c34');

      // Pale stone wall with pilasters and a crown molding.
      fillRect(g, 12, 24, 296, 56, '#cfc8b6');
      for (let y = 30; y < 80; y += 8) fillRect(g, 12, y, 296, 1, '#bdb5a2');
      fillRect(g, 8, 20, 304, 2, PAL.ink);
      fillRect(g, 8, 22, 304, 3, '#b8913a');
      fillRect(g, 8, 22, 304, 1, '#e8c86a');
      for (const px of [20, 290]) {
        fillRect(g, px, 25, 10, 55, '#e8e3d6');
        fillRect(g, px + 2, 25, 1, 55, '#c4bdad');
        fillRect(g, px + 7, 25, 1, 55, '#c4bdad');
      }
      fillRect(g, 8, 80, 304, 3, PAL.ink);
      fillRect(g, 8, 83, 304, 4, '#6b5a3a');
      fillRect(g, 8, 87, 304, 3, '#4a3e28');
      fillRect(g, 8, 90, 304, 1, PAL.ink);

      // Round vault door set into the wall, left of the teller.
      pxDisc(g, 74, 46, 17, PAL.ink);
      pxDisc(g, 74, 46, 15, '#8a8f9c');
      pxDisc(g, 74, 46, 11, '#a7acb8');
      pxDisc(g, 74, 46, 4, '#5a5f6b');
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        pxLine(g, 74, 46, Math.round(74 + Math.cos(a) * 9), Math.round(46 + Math.sin(a) * 9), 1, '#5a5f6b');
      }
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        fillRect(g, Math.round(74 + Math.cos(a) * 13), Math.round(46 + Math.sin(a) * 13), 1, 1, '#d8dce4');
      }

      // Brass "LOANS" plaque above the teller window.
      fillRect(g, 140, 26, 40, 11, PAL.ink);
      fillRect(g, 141, 27, 38, 9, '#b8913a');
      fillRect(g, 141, 27, 38, 1, '#e8c86a');
      drawPixelText(g, 'LOANS', 160, 29, PAL.ink, 1, 'center');

      // Framed gold coin on the right wall.
      fillRect(g, 236, 32, 24, 20, PAL.ink);
      fillRect(g, 237, 33, 22, 18, '#b8913a');
      fillRect(g, 239, 35, 18, 14, '#2e5e4e');
      pxDisc(g, 248, 42, 5, '#e0b84a');
      pxDisc(g, 248, 42, 3, '#c99a30');
      fillRect(g, 246, 39, 2, 1, '#fff0a8');

      // Checkered marble floor.
      for (let ty = 0; ty < 12; ty++) {
        for (let tx = 0; tx < 26; tx++) {
          const x = 8 + tx * 12;
          const y = 90 + ty * 12;
          if (x >= 312 || y >= 232) continue;
          fillRect(g, x, y, Math.min(12, 312 - x), Math.min(12, 232 - y), (tx + ty) % 2 ? '#d9d4c8' : '#3a3c44');
        }
      }
      fillRect(g, 8, 90, 304, 3, 'rgba(0,0,0,0.25)');
      // Red velvet runner from the door to the counter.
      fillRect(g, 146, 86, 28, 128, '#7a1f2a');
      fillRect(g, 148, 86, 24, 128, '#9a2a36');
      fillRect(g, 148, 86, 1, 128, '#b8913a');
      fillRect(g, 171, 86, 1, 128, '#b8913a');

      // Teller behind the counter.
      fillRect(g, 150, 54, 20, 4, 'rgba(0,0,0,0.35)');
      g.drawImage(sprites.dealer, 154, 44);

      // Mahogany counter with brass trim and teller bars.
      fillRect(g, 48, 56, 224, 24, PAL.ink);
      fillRect(g, 50, 58, 220, 5, '#e8e3d6');
      fillRect(g, 50, 58, 220, 1, '#ffffff');
      fillRect(g, 50, 63, 220, 15, '#5a2e1e');
      for (let x = 50; x < 270; x += 20) {
        fillRect(g, x + 3, 66, 14, 9, '#4a2416');
        fillRect(g, x + 3, 66, 14, 1, '#6e3a26');
      }
      fillRect(g, 50, 63, 220, 1, '#b8913a');
      fillRect(g, 50, 77, 220, 1, 'rgba(0,0,0,0.5)');
      for (let x = 54; x < 268; x += 4) {
        if (x > 142 && x < 178) continue; // open window for the teller
        fillRect(g, x, 42, 1, 16, '#b8913a');
      }
      fillRect(g, 52, 41, 216, 2, '#8a6a20');
      fillRect(g, 52, 41, 216, 1, '#e8c86a');
      fillRect(g, 56, 82, 208, 3, 'rgba(0,0,0,0.3)');

      // Exit door remains x144-176, y210-230.
      fillRect(g, 142, 210, 36, 20, PAL.ink);
      fillRect(g, 144, 212, 32, 18, '#5a2e1e');
      fillRect(g, 145, 213, 30, 2, 'rgba(255,255,255,0.18)');
      return canvas;
    }

    /** Brass glints sweeping across the teller bars and vault, plus the secret
     * door beside the counter (a faint seam until the back room opens up). */
    function drawBankAmbient(time, backroomOpen = false) {
      const t = Math.floor(time * 8);
      fillRect(ctx, 54 + ((t * 3) % 212), 41, 4, 1, 'rgba(255, 245, 200, 0.7)');
      if (t % 24 < 3) fillRect(ctx, 66, 38, 2, 2, '#ffffff');

      if (backroomOpen) {
        const glow = 0.16 + 0.06 * Math.sin(time * 3);
        fillRect(ctx, 273, 52, 17, 31, PAL.ink);
        fillRect(ctx, 274, 53, 15, 30, '#0a0507');
        fillRect(ctx, 274, 64, 15, 19, `rgba(170, 30, 40, ${glow.toFixed(3)})`);
        fillRect(ctx, 274, 74, 15, 9, `rgba(170, 30, 40, ${glow.toFixed(3)})`);
        fillRect(ctx, 270, 83, 23, 7, `rgba(170, 30, 40, ${(glow * 0.6).toFixed(3)})`);
        fillRect(ctx, 287, 53, 2, 30, '#bdb5a2'); // the wall panel swung inward
        fillRect(ctx, 287, 53, 1, 30, '#8a8270');
      } else {
        fillRect(ctx, 274, 54, 14, 1, '#b5ad98');
        fillRect(ctx, 274, 54, 1, 26, '#b5ad98');
        fillRect(ctx, 287, 54, 1, 26, '#b5ad98');
      }
    }

    /** The loan shark's back room: damp concrete, crates, a safe, one bare bulb
     * and a desk. The desk sits on the back-room collider (x116,y58,w88,h22). */
    function renderBackroomInterior() {
      const { canvas, g } = createLayer(CONFIG.WIDTH, CONFIG.HEIGHT);
      fillRect(g, 0, 0, CONFIG.WIDTH, CONFIG.HEIGHT, PAL.ink);
      fillRect(g, 8, 20, 304, 212, '#121512');

      // Damp concrete wall with cracks and water streaks.
      fillRect(g, 12, 24, 296, 56, '#2a2e2a');
      for (let y = 24; y < 80; y += 10) fillRect(g, 12, y, 296, 1, '#232723');
      for (let i = 0; i < 18; i++) fillRect(g, 14 + ((i * 61) % 288), 28 + ((i * 17) % 48), 2 + (i % 3), 1, '#1a1e1a');
      for (const sx of [44, 98, 236, 270]) fillRect(g, sx, 24, 3, 22 + (sx % 23), 'rgba(0,0,0,0.28)');
      fillRect(g, 8, 20, 304, 2, PAL.ink);
      fillRect(g, 8, 80, 304, 3, PAL.ink);
      fillRect(g, 8, 83, 304, 6, '#1a1d1a');
      fillRect(g, 8, 89, 304, 1, PAL.ink);

      // Stained concrete floor.
      for (let ty = 0; ty < 9; ty++) {
        for (let tx = 0; tx < 19; tx++) {
          const x = 8 + tx * 16;
          const y = 90 + ty * 16;
          fillRect(g, x, y, 16, Math.min(16, 232 - y), (tx + ty) % 2 ? '#1e211e' : '#222522');
        }
      }
      for (const [sx, sy, sw] of [[60, 130, 18], [212, 170, 24], [120, 196, 14], [250, 118, 12]]) {
        fillRect(g, sx, sy, sw, 4, 'rgba(0,0,0,0.35)');
        fillRect(g, sx + 2, sy - 1, sw - 4, 6, 'rgba(0,0,0,0.2)');
      }

      // Stacked crates on the left.
      const crate = (x, y, w, h) => {
        fillRect(g, x, y, w, h, PAL.ink);
        fillRect(g, x + 1, y + 1, w - 2, h - 2, '#5a4128');
        fillRect(g, x + 1, y + 1, w - 2, 1, '#7a5a38');
        pxLine(g, x + 2, y + 2, x + w - 3, y + h - 3, 1, '#3a2a18');
        pxLine(g, x + w - 3, y + 2, x + 2, y + h - 3, 1, '#3a2a18');
      };
      crate(22, 62, 30, 28);
      crate(26, 40, 22, 22);
      crate(54, 70, 20, 20);

      // Safe on the right.
      fillRect(g, 260, 50, 32, 40, PAL.ink);
      fillRect(g, 262, 52, 28, 36, '#3a3e46');
      fillRect(g, 262, 52, 28, 1, '#5a5f6b');
      pxDisc(g, 276, 68, 5, '#22252c');
      pxDisc(g, 276, 68, 3, '#8a8f9c');
      fillRect(g, 284, 64, 2, 8, '#8a8f9c');

      // The shark, then his desk in front of him.
      fillRect(g, 150, 56, 20, 4, 'rgba(0,0,0,0.4)');
      g.drawImage(sprites.shark, 152, 40);
      fillRect(g, 114, 56, 92, 24, PAL.ink);
      fillRect(g, 116, 58, 88, 5, '#4a3020');
      fillRect(g, 116, 58, 88, 1, '#6a4a30');
      fillRect(g, 116, 63, 88, 15, '#3a2418');
      for (const dx of [120, 184]) {
        fillRect(g, dx, 66, 16, 9, '#2e1c12');
        fillRect(g, dx + 6, 70, 4, 1, '#b8913a');
      }
      fillRect(g, 116, 77, 88, 1, 'rgba(0,0,0,0.5)');
      // Cash stacks, a ledger and an ashtray on the desk.
      for (const [mx, my] of [[122, 54], [126, 51], [134, 54]]) {
        fillRect(g, mx, my, 9, 4, PAL.ink);
        fillRect(g, mx + 1, my + 1, 7, 2, '#3f7a3a');
        fillRect(g, mx + 4, my + 1, 1, 2, '#d8d0a0');
      }
      fillRect(g, 176, 55, 12, 4, '#5a1f24');
      fillRect(g, 177, 55, 10, 1, '#e8e0c8');
      pxDisc(g, 196, 57, 2, '#55585f');
      fillRect(g, 195, 56, 2, 1, '#22252c');

      // Exit door remains x144-176, y210-230.
      fillRect(g, 142, 210, 36, 20, PAL.ink);
      fillRect(g, 144, 212, 32, 18, '#2a1a12');
      fillRect(g, 145, 213, 30, 2, 'rgba(255,255,255,0.08)');
      return canvas;
    }

    /** Swinging bare bulb, cigar ember and smoke, a glint off the shades. */
    function drawBackroomAmbient(time) {
      const swing = Math.sin(time * 1.3) * 6;
      const bx = Math.round(160 + swing);
      const flicker = Math.floor(time * 10) % 23 === 0;
      ctx.save();
      ctx.fillStyle = flicker ? 'rgba(255, 220, 140, 0.03)' : 'rgba(255, 220, 140, 0.09)';
      ctx.beginPath();
      ctx.moveTo(bx - 2, 30);
      ctx.lineTo(bx + 2, 30);
      ctx.lineTo(bx + 70, 150);
      ctx.lineTo(bx - 70, 150);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      pxLine(ctx, 160, 20, bx, 27, 1, '#0a0a0a');
      fillRect(ctx, bx - 1, 26, 3, 2, '#3a3a3a');
      fillRect(ctx, bx - 2, 28, 5, 4, flicker ? '#6a5a30' : '#ffe9a8');
      if (!flicker) fillRect(ctx, bx - 4, 26, 9, 8, 'rgba(255, 233, 168, 0.18)');

      const ember = 0.5 + 0.5 * Math.sin(time * 2.2);
      fillRect(ctx, 166, 49, 1, 1, ember > 0.6 ? '#ffd27a' : '#ff7a3a');
      if (ember > 0.6) fillRect(ctx, 165, 48, 3, 3, 'rgba(255, 140, 60, 0.25)');
      for (let i = 0; i < 4; i++) {
        const k = ((time * 0.5 + i * 0.25) % 1);
        const sx = Math.round(167 + Math.sin(time * 2 + i * 1.7) * 2 + k * 3);
        fillRect(ctx, sx, Math.round(47 - k * 22), 1 + (i % 2), 1, `rgba(200, 200, 210, ${(0.35 * (1 - k)).toFixed(3)})`);
      }
      if (time % 4 < 0.25) fillRect(ctx, 156 + Math.floor((time % 4) * 24), 47, 1, 1, '#ffffff');
    }

    /** Dead-end alley for the robbery cutscene. */
    function renderAlleyBackground() {
      const { canvas, g } = createLayer(CONFIG.WIDTH, CONFIG.HEIGHT);
      const W = CONFIG.WIDTH;
      fillRect(g, 0, 0, W, CONFIG.HEIGHT, '#0d1424');
      for (let i = 0; i < 16; i++) fillRect(g, (i * 47) % W, 3 + ((i * 13) % 14), 1, 1, '#b8c4dc');
      for (let i = 0; i < 9; i++) fillRect(g, i * 40 - 6, 16 + ((i * 7) % 12), 38, 20, '#080b14');

      // Grimy brick back wall.
      fillRect(g, 0, 34, W, 122, '#3a2226');
      for (let y = 34, row = 0; y < 156; y += 6, row++) {
        fillRect(g, 0, y, W, 1, '#24151a');
        for (let x = (row % 2) * 7; x < W; x += 14) fillRect(g, x, y, 1, 6, '#24151a');
      }
      for (let i = 0; i < 40; i++) fillRect(g, 1 + ((i * 71) % (W - 14)), 35 + ((i * 29) % 20) * 6, 13, 5, '#301b20');
      fillRect(g, 0, 34, W, 3, '#1a0e12');

      // Fire escape.
      fillRect(g, 30, 56, 70, 2, '#15151a');
      fillRect(g, 30, 96, 70, 2, '#15151a');
      for (let x = 30; x <= 100; x += 7) {
        fillRect(g, x, 48, 1, 8, '#15151a');
        fillRect(g, x, 88, 1, 8, '#15151a');
      }
      for (let i = 0; i < 6; i++) fillRect(g, 84 + i * 2, 58 + i * 6, 6, 1, '#15151a');

      // Boarded window and a drain pipe.
      fillRect(g, 176, 58, 32, 28, PAL.ink);
      fillRect(g, 178, 60, 28, 24, '#120c10');
      for (const [y, tilt] of [[64, 3], [74, -2]]) pxLine(g, 174, y, 210, y + tilt, 2, '#5a4128');
      fillRect(g, 152, 34, 4, 122, '#26262c');
      fillRect(g, 153, 34, 1, 122, '#3a3a44');
      for (let y = 50; y < 156; y += 30) fillRect(g, 151, y, 6, 2, '#1a1a20');

      // Graffiti tag.
      pxLine(g, 196, 120, 204, 108, 1, '#3a8a7a');
      pxLine(g, 204, 108, 210, 124, 1, '#3a8a7a');
      pxLine(g, 212, 112, 226, 112, 1, '#a23a7a');
      pxLine(g, 219, 112, 219, 126, 1, '#a23a7a');
      pxLine(g, 228, 124, 238, 108, 1, '#3a8a7a');

      // Wall lamp (its light cone is drawn live so it can flicker).
      fillRect(g, 118, 58, 2, 6, '#15151a');
      fillRect(g, 114, 62, 12, 4, '#15151a');
      fillRect(g, 116, 66, 8, 2, '#c8b878');

      // Wet asphalt with puddles.
      fillRect(g, 0, 156, W, 84, '#1b1c22');
      fillRect(g, 0, 156, W, 3, '#0e0e12');
      for (let i = 0; i < 70; i++) fillRect(g, (i * 37) % W, 162 + ((i * 23) % 74), 2, 1, '#26272e');
      for (const [px, py, pw] of [[70, 196, 34], [176, 214, 40], [20, 222, 22]]) {
        fillRect(g, px, py, pw, 4, '#22283a');
        fillRect(g, px + 2, py - 1, pw - 4, 6, 'rgba(34, 40, 58, 0.6)');
        fillRect(g, px + 6, py + 1, pw / 3, 1, '#4a5878');
      }

      // Dumpster and trash bags by the alley mouth.
      fillRect(g, 6, 128, 48, 32, PAL.ink);
      fillRect(g, 8, 132, 44, 26, '#2a4a32');
      fillRect(g, 6, 126, 50, 4, '#1e3424');
      for (let x = 12; x < 50; x += 8) fillRect(g, x, 134, 1, 22, '#1e3424');
      for (const [bx, by] of [[58, 148], [66, 152]]) {
        pxDisc(g, bx, by, 6, PAL.ink);
        pxDisc(g, bx, by, 5, '#16161c');
        fillRect(g, bx - 2, by - 3, 2, 1, '#2e2e38');
      }

      // Dead end: a tall wall closing off the alley, with a NO EXIT sign.
      fillRect(g, 250, 30, 70, 176, PAL.ink);
      fillRect(g, 252, 32, 68, 172, '#2a171b');
      for (let y = 32, row = 0; y < 204; y += 6, row++) {
        fillRect(g, 252, y, 68, 1, '#1a0e12');
        for (let x = 252 + (row % 2) * 7; x < W; x += 14) fillRect(g, x, y, 1, 6, '#1a0e12');
      }
      fillRect(g, 252, 32, 2, 172, '#3a2226');
      fillRect(g, 262, 96, 42, 14, PAL.ink);
      fillRect(g, 263, 97, 40, 12, '#a82a32');
      drawPixelText(g, 'NO EXIT', 283, 101, '#f4ecd8', 1, 'center');
      return canvas;
    }

    const ROBBERY_COINS = Array.from({ length: 22 }, (_, i) => ({
      vx: -110 + ((i * 37) % 128), // mostly spills back toward the goons, away from the dead-end wall
      vy: 70 + ((i * 53) % 80),
      floor: 186 + (i % 4) * 4,
    }));

    function drawCutscenePlayer(x, y, moving, walkTime) {
      const saved = { x: player.x, y: player.y, moving: player.moving, walkTime: player.walkTime };
      player.x = x;
      player.y = y;
      player.moving = moving;
      player.walkTime = walkTime;
      drawPlayer();
      Object.assign(player, saved);
    }

    function drawCutsceneDialogue(speaker, text, color = speaker === 'YOU' ? '#9ad0ff' : '#ff6a6a') {
      fillRect(ctx, 8, 194, 304, 40, PAL.ink);
      fillRect(ctx, 9, 195, 302, 38, PAL.goldDark);
      fillRect(ctx, 10, 196, 300, 36, '#14101c');
      drawPixelText(ctx, speaker, 18, 201, color);
      drawShadowText(ctx, text, 18, 212, PAL.cream, 2);
    }

    /** Cornered in an alley by the shark's collectors and robbed blind. */
    function drawRobberyCutscene(cs, now) {
      const R = ROBBERY;
      const t = now - cs.startedAt;
      const easeOut = (k) => 1 - (1 - k) * (1 - k);

      if (t >= R.title) {
        fillRect(ctx, 0, 0, CONFIG.WIDTH, CONFIG.HEIGHT, '#050307');
        const k = clamp((t - R.title) / 0.8, 0, 1);
        ctx.save();
        ctx.globalAlpha = k;
        drawShadowText(ctx, 'YOU GOT ROBBED', 160, 82, '#e04050', 3, 'center');
        drawPixelText(ctx, 'THEY TOOK EVERYTHING YOU HAD.', 160, 120, PAL.cream, 1, 'center');
        drawPixelText(ctx, 'THE SHARK ALWAYS COLLECTS.', 160, 132, '#8a7a8a', 1, 'center');
        ctx.restore();
        if (t >= R.prompt && Math.floor(t * 2) % 2 === 0) {
          drawShadowText(ctx, 'PRESS E TO START OVER', 160, 172, PAL.gold, 1, 'center');
        }
        return;
      }

      ctx.save();
      if (t >= R.hit && t < R.hit + 0.45) {
        const amp = 4 * (1 - (t - R.hit) / 0.45);
        ctx.translate(Math.round(Math.sin(t * 90) * amp), Math.round(Math.cos(t * 70) * amp * 0.6));
      }
      ctx.drawImage(alleyBackground, 0, 0);

      // Flickering wall lamp.
      if (Math.floor(now * 9) % 13 !== 0) {
        ctx.fillStyle = 'rgba(255, 226, 150, 0.1)';
        ctx.beginPath();
        ctx.moveTo(115, 68);
        ctx.lineTo(125, 68);
        ctx.lineTo(190, 196);
        ctx.lineTo(50, 196);
        ctx.closePath();
        ctx.fill();
        fillRect(ctx, 116, 66, 8, 2, '#ffe9a8');
      }

      // Player: walks in, spots the goons, backs into the dead end, gets knocked down.
      const walkK = clamp((t - R.walkStart) / (R.walkEnd - R.walkStart), 0, 1);
      const backK = clamp((t - R.backUp) / (R.cornered - R.backUp), 0, 1);
      const px = Math.round(20 + 130 * walkK + 86 * easeOut(backK));
      const py = 168;
      const playerWalking = (t > R.walkStart && t < R.walkEnd) || (t > R.backUp && t < R.cornered);
      if (t < R.hit) {
        drawCutscenePlayer(px, py, playerWalking, t);
        if (t >= R.alarm && t < R.line1) ctx.drawImage(sprites.bubble, px + 1, py - 16 - (Math.floor(t * 6) % 2));
      } else {
        fillRect(ctx, px - 2, py + 14, 18, 3, PAL.shadow);
        ctx.save();
        ctx.translate(px - 2, py + 15);
        ctx.rotate(-Math.PI / 2);
        drawCutscenePlayer(0, 0, false, 0);
        ctx.restore();
        for (let i = 0; i < 3; i++) {
          const a = t * 4 + (i * Math.PI * 2) / 3;
          fillRect(ctx, Math.round(px + 2 + Math.cos(a) * 7), Math.round(py - 1 + Math.sin(a) * 2), 2, 2, PAL.gold);
        }
      }

      // Goons: close in from the alley mouth, then stroll off with the loot.
      const inK = easeOut(clamp((t - R.goonsIn) / (R.cornered - R.goonsIn), 0, 1));
      const leaveK = clamp((t - R.leave) / (R.fade - R.leave), 0, 1);
      const goonsWalking = (t > R.goonsIn && t < R.cornered) || (t > R.leave && t < R.fade);
      const lunge = t > R.hit - 0.15 && t < R.hit + 0.1 ? 8 : 0;
      const goons = [
        { sprite: sprites.goonA, x: -30 + 226 * inK - 300 * leaveK + lunge, y: 158 },
        { sprite: sprites.goonB, x: -50 + 254 * inK - 320 * leaveK, y: 178 },
      ];
      if (t >= R.goonsIn) {
        for (const [i, goon] of goons.entries()) {
          const gx = Math.round(goon.x);
          const bob = goonsWalking && (Math.floor(t * 8) + i) % 2 === 0 ? 1 : 0;
          fillRect(ctx, gx + 2, goon.y + 15, 8, 2, PAL.shadow);
          ctx.drawImage(goon.sprite, gx, goon.y - bob);
          if (i === 1 && t >= R.scoop) {
            // Loot sack slung over his shoulder.
            pxDisc(ctx, gx + 12, goon.y + 4 - bob, 5, PAL.ink);
            pxDisc(ctx, gx + 12, goon.y + 4 - bob, 4, '#8a6a3a');
            fillRect(ctx, gx + 11, goon.y - 2 - bob, 3, 2, '#5a4128');
            fillRect(ctx, gx + 11, goon.y + 3 - bob, 2, 3, PAL.gold);
          }
        }
      }

      // Tokens burst out of your pockets and get scooped up.
      if (t >= R.hit && t < R.scoop + 0.6) {
        const dt = t - R.hit;
        for (const [i, coin] of ROBBERY_COINS.entries()) {
          if (t > R.scoop + i * 0.025) continue;
          const cx = Math.round(px + 6 + coin.vx * dt);
          const cy = Math.round(Math.min(coin.floor, py + 4 - coin.vy * dt + 170 * dt * dt));
          fillRect(ctx, cx - 1, cy - 1, 4, 4, PAL.ink);
          fillRect(ctx, cx, cy, 2, 2, Math.floor(t * 10 + i) % 3 ? PAL.gold : '#fff0a8');
        }
      }
      ctx.restore();

      if (t >= R.hit && t < R.hit + 0.12) fillRect(ctx, 0, 0, CONFIG.WIDTH, CONFIG.HEIGHT, 'rgba(255, 255, 255, 0.85)');

      const lines = [
        [R.line1, R.line2, 'GOON', 'THE SHARK SENDS HIS REGARDS.'],
        [R.line2, R.line3, 'YOU', 'I... I DONT HAVE IT.'],
        [R.line3, R.hit, 'GOON', 'THEN WE TAKE EVERYTHING.'],
      ];
      for (const [from, to, speaker, text] of lines) {
        if (t >= from && t < to) drawCutsceneDialogue(speaker, text.slice(0, Math.floor((t - from) * 30)));
      }

      if (t < 0.8) fillRect(ctx, 0, 0, CONFIG.WIDTH, CONFIG.HEIGHT, `rgba(5, 3, 7, ${(1 - t / 0.8).toFixed(3)})`);
      if (t >= R.fade) fillRect(ctx, 0, 0, CONFIG.WIDTH, CONFIG.HEIGHT, `rgba(5, 3, 7, ${clamp((t - R.fade) / (R.title - R.fade), 0, 1).toFixed(3)})`);
    }

    /** Unsold shelf curios, then the glowing white eyes inside the dealer's hood. */
    function drawBlackMarketAmbient(time, relics = []) {
      if (!relics.includes('clover')) {
        fillRect(ctx, 117, 39, 8, 5, PAL.ink); // little clay pot
        fillRect(ctx, 118, 40, 6, 3, '#6b3f2a');
        ctx.drawImage(sprites.clover, 116, 31);
      }
      if (!relics.includes('plus')) {
        fillRect(ctx, 177, 30, 17, 15, `rgba(255, 205, 117, ${(0.05 + 0.03 * Math.sin(time * 2)).toFixed(3)})`);
        ctx.drawImage(sprites.goldPlus, 180, 33);
      }
      if (!relics.includes('hand')) {
        ctx.drawImage(sprites.severedHand, 200, 38);
        fillRect(ctx, 199, 44, 5, 1, '#6e1218'); // blood pooled on the plank
        fillRect(ctx, 201, 47, 1, 3, '#6e1218'); // ...dripping off the edge
        if (time % 2.4 < 1.2) fillRect(ctx, 201, 50 + Math.floor((time % 1.2) * 5), 1, 1, '#8a1a22');
      }

      const blinking = time % 5.2 < 0.14;
      const pulse = 0.12 + 0.06 * Math.sin(time * 2.5);
      for (const ex of [157, 161]) {
        fillRect(ctx, ex - 1, 39, 4, 4, `rgba(255, 255, 255, ${pulse.toFixed(3)})`);
        fillRect(ctx, ex, blinking ? 41 : 40, 2, blinking ? 1 : 2, '#ffffff');
      }
    }

    function renderCosmeticsBackground() {
      const { canvas, g } = createLayer(CONFIG.WIDTH, CONFIG.HEIGHT);
      fillRect(g, 0, 0, CONFIG.WIDTH, CONFIG.HEIGHT, PAL.ink);
      fillRect(g, 8, 20, 304, 212, '#261d36');

      // Back wall architecture: layered crown, vertical panels, and wainscot.
      fillRect(g, 12, 24, 296, 84, '#3a2c50');
      fillRect(g, 12, 24, 296, 2, PAL.ink);
      fillRect(g, 12, 26, 296, 2, '#7a5a96');
      for (let x = 14; x < 306; x += 16) {
        fillRect(g, x, 30, 2, 74, '#5a4577');
        fillRect(g, x + 2, 30, 12, 74, '#463660');
        fillRect(g, x + 4, 34, 8, 66, 'rgba(255,255,255,0.04)');
      }
      fillRect(g, 8, 108, 304, 2, PAL.ink);
      fillRect(g, 8, 110, 304, 6, '#67367c');
      fillRect(g, 8, 116, 304, 2, '#2b1d3b');

      // Framed fashion artwork and wall signage.
      for (const fx of [34, 90, 230, 286]) {
        fillRect(g, fx - 8, 38, 16, 14, PAL.ink);
        fillRect(g, fx - 7, 39, 14, 12, '#f4ecd8');
        fillRect(g, fx - 4, 42, 8, 6, ['#f26a7d', '#41a6f6', '#ffd75e', '#ffb3e6'][(fx / 8) % 4]);
      }
      fillRect(g, 126, 34, 68, 14, PAL.ink);
      fillRect(g, 128, 36, 64, 10, '#f4ecd8');
      fillRect(g, 136, 39, 48, 4, '#6d4f87');

      // Floor: polished checkerboard with decorative border and center runner.
      for (let y = 116; y < 230; y += 12) {
        for (let x = 10; x < 310; x += 12) {
          const c = (Math.floor((x + y) / 12) % 2 === 0) ? '#5e4f81' : '#4d416d';
          fillRect(g, x, y, 12, 12, c);
          fillRect(g, x + 2, y + 2, 1, 1, 'rgba(255,255,255,0.1)');
        }
      }
      fillRect(g, 14, 120, 292, 2, '#7a5b95');
      fillRect(g, 14, 226, 292, 2, '#3a2b52');
      fillRect(g, 14, 120, 2, 108, '#7a5b95');
      fillRect(g, 304, 120, 2, 108, '#3a2b52');

      fillRect(g, 106, 134, 108, 74, '#4f416f');
      fillRect(g, 110, 138, 100, 66, '#5a4b7a');
      for (let y = 142; y < 202; y += 12) {
        for (let x = 114; x < 206; x += 12) fillRect(g, x, y, 8, 1, 'rgba(255,255,255,0.06)');
      }

      // Warm ambient pools to add depth.
      for (let i = 0; i < 4; i++) {
        const pad = i * 8;
        fillRect(g, 88 + pad, 126 + pad / 2, 144 - pad * 2, 82 - pad, 'rgba(255, 214, 150, 0.05)');
      }

      // Rear garment racks and garments behind counter.
      fillRect(g, 56, 56, 208, 26, PAL.ink);
      fillRect(g, 58, 58, 204, 22, '#332646');
      fillRect(g, 64, 62, 192, 2, '#d5ccbf');
      for (let x = 70; x < 248; x += 14) {
        fillRect(g, x, 64, 1, 11, '#cabcae');
        const palette = ['#f26a7d', '#41a6f6', '#ffd75e', '#5fae4a', '#ffb3e6', '#8ad8f0'];
        fillRect(g, x - 4, 66, 8, 9, palette[(x / 14) % palette.length]);
      }

      // Side displays and decorative plants in detailed pots.
      fillRect(g, 22, 56, 28, 50, PAL.ink);
      fillRect(g, 24, 58, 24, 46, '#8ca8c1');
      fillRect(g, 28, 64, 16, 14, '#f26a7d');
      fillRect(g, 30, 80, 12, 14, '#41a6f6');

      fillRect(g, 270, 56, 28, 50, PAL.ink);
      fillRect(g, 272, 58, 24, 46, '#8ca8c1');
      fillRect(g, 276, 64, 16, 14, '#ffd75e');
      fillRect(g, 278, 80, 12, 14, '#ffb3e6');

      fillRect(g, 56, 98, 12, 8, '#5e3e2a');
      fillRect(g, 57, 99, 10, 6, '#845637');
      fillRect(g, 58, 95, 8, 5, '#3e8948');
      fillRect(g, 60, 93, 4, 4, '#63c74d');

      fillRect(g, 252, 98, 12, 8, '#5e3e2a');
      fillRect(g, 253, 99, 10, 6, '#845637');
      fillRect(g, 254, 95, 8, 5, '#3e8948');
      fillRect(g, 256, 93, 4, 4, '#63c74d');

      // Reception counter aligned to collider: x54,y116,w212,h12.
      // Premium wood with gold trim and pseudo-isometric top edge.
      fillRect(g, 52, 111, 216, 5, PAL.ink);
      fillRect(g, 54, 112, 212, 1, '#cda679');
      fillRect(g, 56, 113, 208, 1, '#e6bf8f');
      fillRect(g, 54, 114, 212, 1, '#c28d59');

      fillRect(g, 52, 114, 216, 16, PAL.ink);
      fillRect(g, 54, 116, 212, 12, '#6f4a30');
      fillRect(g, 56, 118, 208, 8, '#8b6341');
      for (let x = 60; x < 260; x += 20) {
        fillRect(g, x, 119, 14, 4, '#7c5738');
        fillRect(g, x + 1, 120, 12, 1, 'rgba(255,255,255,0.08)');
      }
      fillRect(g, 54, 128, 212, 1, '#4f3323');

      // Folded garments and boutique objects on counter.
      fillRect(g, 72, 108, 18, 6, '#f4cfd7');
      fillRect(g, 74, 106, 14, 2, '#eab8c2');
      fillRect(g, 96, 108, 16, 6, '#b8d6f6');
      fillRect(g, 98, 106, 12, 2, '#95bfec');
      fillRect(g, 116, 108, 14, 6, '#ffe3a6');
      fillRect(g, 118, 106, 10, 2, '#f7cf73');

      fillRect(g, 138, 108, 4, 6, '#e9b1d6');
      fillRect(g, 144, 109, 3, 5, '#8ad8f0');
      fillRect(g, 149, 110, 3, 4, '#ffd75e');

      // Retro CRT register + tiny terminal.
      fillRect(g, 166, 104, 20, 12, PAL.ink);
      fillRect(g, 168, 106, 16, 8, '#566274');
      fillRect(g, 170, 108, 10, 4, '#8ad8f0');
      fillRect(g, 182, 110, 2, 2, '#d7d7d7');
      fillRect(g, 190, 109, 8, 5, '#2e3948');
      fillRect(g, 192, 110, 4, 2, '#9ee6ff');

      // Clerk silhouette near interaction center at (160,68).
      fillRect(g, 156, 70, 8, 8, PAL.ink);
      fillRect(g, 158, 72, 4, 4, '#f2c29b');
      fillRect(g, 156, 78, 8, 2, '#5d275d');

      // Soft shadows beneath fixtures and counter.
      fillRect(g, 56, 82, 208, 3, 'rgba(0,0,0,0.22)');
      fillRect(g, 24, 104, 24, 2, 'rgba(0,0,0,0.18)');
      fillRect(g, 272, 104, 24, 2, 'rgba(0,0,0,0.18)');
      fillRect(g, 56, 130, 208, 2, 'rgba(0,0,0,0.2)');

      // Exit door remains x144-176, y210-230.
      fillRect(g, 142, 210, 36, 20, PAL.ink);
      fillRect(g, 144, 212, 32, 18, PAL.wainscotPanel);
      fillRect(g, 145, 213, 30, 2, 'rgba(255,255,255,0.2)');
      return canvas;
    }

    /* ----- Dynamic objects -------------------------------------------- */

    function drawPlayer(viewX = 0) {
      const x = Math.round(player.x - viewX);
      const y = Math.round(player.y);
      const cycle = ['idle', 'left', 'idle', 'right'];
      const pose = player.moving ? cycle[Math.floor(player.walkTime * 8) % cycle.length] : 'idle';
      const bob = player.moving && pose !== 'idle' ? 1 : 0;

      fillRect(ctx, x + 2, y + 15, 8, 2, PAL.shadow);
      ctx.drawImage(sprites[`player_${pose}`], x, y - bob);

      if (appearanceState.outfit === 'outfit-velvet') {
        fillRect(ctx, x + 3, y + 8 - bob, 6, 4, PAL.plum);
      } else if (appearanceState.outfit === 'outfit-angler') {
        fillRect(ctx, x + 3, y + 8 - bob, 6, 4, PAL.feltLight);
      }

      if (appearanceState.hat === 'hat-fedora') {
        fillRect(ctx, x + 2, y - 1 - bob, 8, 1, PAL.ink);
        fillRect(ctx, x + 3, y - 3 - bob, 6, 2, PAL.plum);
      } else if (appearanceState.hat === 'hat-crown') {
        fillRect(ctx, x + 3, y - 2 - bob, 1, 2, PAL.gold);
        fillRect(ctx, x + 5, y - 3 - bob, 1, 3, PAL.gold);
        fillRect(ctx, x + 7, y - 2 - bob, 1, 2, PAL.gold);
        fillRect(ctx, x + 3, y - 1 - bob, 5, 1, PAL.goldDark);
      }
    }

    function drawDealerStation(time) {
      const bob = Math.floor(time * 1.6) % 2; // gentle idle breathing
      ctx.drawImage(sprites.dealer, dealer.x, dealer.y + bob);
      drawTable();
    }

    function drawTable() {
      const { x, y, w, h } = TABLE;
      const cx = x + w / 2;

      // Shadow + chamfered outline
      fillRect(ctx, x + 3, y + h, w - 4, 3, PAL.shadow);
      fillRect(ctx, x + 2, y, w - 4, h, PAL.ink);
      fillRect(ctx, x, y + 2, w, h - 4, PAL.ink);
      fillRect(ctx, x + 1, y + 1, w - 2, h - 2, PAL.ink);

      // Wooden rim
      fillRect(ctx, x + 2, y + 1, w - 4, h - 2, PAL.wood);
      fillRect(ctx, x + 1, y + 2, w - 2, h - 4, PAL.wood);
      fillRect(ctx, x + 2, y + 1, w - 4, 1, PAL.woodLight);
      fillRect(ctx, x + 2, y + h - 4, w - 4, 2, PAL.woodDark);

      // Felt
      fillRect(ctx, x + 4, y + 3, w - 8, h - 9, PAL.felt);
      fillRect(ctx, x + 4, y + 3, w - 8, 1, PAL.feltDark);

      // Stepped betting arc
      fillRect(ctx, x + 14, y + h - 10, w - 28, 1, PAL.feltLight);
      fillRect(ctx, x + 10, y + h - 11, 4, 1, PAL.feltLight);
      fillRect(ctx, x + w - 14, y + h - 11, 4, 1, PAL.feltLight);
      fillRect(ctx, x + 8, y + h - 13, 2, 2, PAL.feltLight);
      fillRect(ctx, x + w - 10, y + h - 13, 2, 2, PAL.feltLight);

      // Player betting spots
      for (const sx of [x + 16, cx - 3, x + w - 22]) {
        fillRect(ctx, sx, y + h - 9, 6, 3, PAL.feltLight);
        fillRect(ctx, sx + 1, y + h - 8, 4, 1, PAL.felt);
      }

      // Chip rack
      const chipColors = [PAL.blue, PAL.green, PAL.red, PAL.gold, PAL.ink];
      fillRect(ctx, cx - 11, y + 4, 22, 4, PAL.woodDark);
      chipColors.forEach((color, i) => fillRect(ctx, cx - 10 + i * 4, y + 5, 3, 2, color));

      // Card shoe + discard tray
      fillRect(ctx, x + w - 18, y + 5, 8, 6, PAL.ink);
      fillRect(ctx, x + w - 17, y + 6, 6, 4, PAL.red);
      fillRect(ctx, x + 10, y + 5, 6, 5, PAL.ink);
      fillRect(ctx, x + 11, y + 6, 4, 3, PAL.cream);

      // Two dealt cards
      fillRect(ctx, cx - 8, y + 11, 6, 7, PAL.cream);
      fillRect(ctx, cx - 7, y + 12, 4, 5, PAL.red);
      fillRect(ctx, cx + 2, y + 11, 6, 7, PAL.cream);
      fillRect(ctx, cx + 4, y + 13, 2, 3, PAL.ink);
    }

    /** Wooden rim and felt shared by the poker and roulette tables. */
    function drawSideTableShell({ x, y, w, h }, felt, feltDark) {
      fillRect(ctx, x + 3, y + h, w - 4, 3, PAL.shadow);
      fillRect(ctx, x + 2, y, w - 4, h, PAL.ink);
      fillRect(ctx, x, y + 2, w, h - 4, PAL.ink);
      fillRect(ctx, x + 1, y + 1, w - 2, h - 2, PAL.ink);
      fillRect(ctx, x + 2, y + 1, w - 4, h - 2, PAL.wood);
      fillRect(ctx, x + 1, y + 2, w - 2, h - 4, PAL.wood);
      fillRect(ctx, x + 2, y + 1, w - 4, 1, PAL.woodLight);
      fillRect(ctx, x + 2, y + h - 4, w - 4, 2, PAL.woodDark);
      fillRect(ctx, x + 4, y + 3, w - 8, h - 9, felt);
      fillRect(ctx, x + 4, y + 3, w - 8, 1, feltDark);
    }

    function drawPokerStation(time) {
      const bob = Math.floor(time * 1.6 + 1) % 2;
      ctx.drawImage(sprites.dealer, pokerDealer.x, pokerDealer.y + bob);
      const T = POKER_TABLE;
      const cx = T.x + T.w / 2;
      drawSideTableShell(T, '#1f4f7a', '#173d5f');
      fillRect(ctx, T.x + 8, T.y + T.h - 9, T.w - 16, 1, '#2f6c9f');

      // A five-card draw hand: three face up, two face down.
      for (let i = 0; i < 5; i++) {
        const x = cx - 17 + i * 7;
        fillRect(ctx, x, T.y + 6, 6, 8, PAL.ink);
        if (i < 3) {
          fillRect(ctx, x + 1, T.y + 7, 4, 6, PAL.cream);
          fillRect(ctx, x + 2, T.y + 9, 2, 2, i === 1 ? PAL.ink : PAL.red);
        } else {
          fillRect(ctx, x + 1, T.y + 7, 4, 6, PAL.red);
        }
      }

      // Chip stacks at the seats.
      for (const [sx, color] of [[T.x + 7, PAL.blue], [T.x + T.w - 11, PAL.red]]) {
        for (let k = 0; k < 3; k++) fillRect(ctx, sx, T.y + 12 - k * 2, 4, 2, k % 2 ? PAL.cream : color);
      }
    }

    function drawRouletteStation(time) {
      const bob = Math.floor(time * 1.6 + 0.5) % 2;
      ctx.drawImage(sprites.dealer, rouletteDealer.x, rouletteDealer.y + bob);
      const T = ROULETTE_TABLE;
      drawSideTableShell(T, PAL.felt, PAL.feltDark);

      // Wheel bowl at the left end, idling round with the ball riding the rim.
      const wx = T.x + 15;
      const wy = T.y + 12;
      pxDisc(ctx, wx, wy, 10, PAL.ink);
      pxDisc(ctx, wx, wy, 9, PAL.woodDark);
      pxDisc(ctx, wx, wy, 7, '#2a1a12');
      const spin = time * 1.4;
      for (let i = 0; i < 12; i++) {
        const a = spin + (i / 12) * Math.PI * 2;
        const color = i === 0 ? PAL.green : i % 2 ? PAL.red : PAL.ink;
        fillRect(ctx, Math.round(wx + Math.cos(a) * 6) - 1, Math.round(wy + Math.sin(a) * 6) - 1, 2, 2, color);
      }
      pxDisc(ctx, wx, wy, 3, PAL.goldDark);
      fillRect(ctx, wx - 1, wy - 1, 2, 2, PAL.gold);
      const ball = -time * 3.1;
      fillRect(ctx, Math.round(wx + Math.cos(ball) * 8) - 1, Math.round(wy + Math.sin(ball) * 8) - 1, 2, 2, PAL.cream);

      // Betting layout: zero plus a grid of red and black numbers.
      const gx = T.x + 30;
      const gy = T.y + 5;
      fillRect(ctx, gx - 1, gy - 1, 38, 14, PAL.cream);
      fillRect(ctx, gx, gy, 4, 12, PAL.green);
      for (let c = 0; c < 8; c++) {
        for (let r = 0; r < 3; r++) fillRect(ctx, gx + 5 + c * 4, gy + r * 4, 3, 3, (c + r) % 2 ? PAL.red : PAL.ink);
      }
      fillRect(ctx, gx + 14, gy + 4, 3, 3, PAL.gold);
      fillRect(ctx, gx + 26, gy + 8, 3, 3, PAL.blue);
    }

    function drawPlinkoCabinet(time) {
      const { x, y, w, h } = PLINKO_CABINET;
      const cx = x + w / 2;
      fillRect(ctx, x + 2, y + h, w - 4, 2, PAL.shadow);
      fillRect(ctx, x, y, w, h, PAL.ink);
      fillRect(ctx, x + 1, y + 1, w - 2, h - 2, '#3b1f5f');
      fillRect(ctx, x + 1, y + 1, 1, h - 2, '#5a3a8a');

      // Marquee.
      fillRect(ctx, x + 3, y + 2, w - 6, 9, PAL.ink);
      fillRect(ctx, x + 4, y + 3, w - 8, 7, PAL.red);
      drawPixelText(ctx, 'PLINKO', cx, y + 4, PAL.gold, 1, 'center');

      // Chasing lights down both sides of the board.
      const frame = Math.floor(time * 6);
      for (let i = 0; i < 10; i++) {
        const color = (frame + i) % 3 === 0 ? PAL.gold : PAL.goldDark;
        fillRect(ctx, x + 2, y + 13 + i * 3, 1, 1, color);
        fillRect(ctx, x + w - 3, y + 13 + i * 3, 1, 1, color);
      }

      // Peg board with a demo ball bouncing down it.
      const bx = x + 4;
      const by = y + 12;
      fillRect(ctx, bx, by, w - 8, 30, '#140c22');
      for (let r = 0; r < 6; r++) {
        const n = r + 3;
        for (let j = 0; j < n; j++) fillRect(ctx, Math.round(cx - (n - 1) * 2.5 + j * 5), by + 3 + r * 4, 1, 1, PAL.cream);
      }
      const bucketColors = [PAL.red, PAL.redLight, PAL.gold, PAL.green, PAL.green, PAL.gold, PAL.redLight, PAL.red];
      bucketColors.forEach((color, i) => fillRect(ctx, bx + i * 5, by + 26, 4, 3, color));

      const cycle = Math.floor(time / 2.4);
      const u = (time % 2.4) / 2.4;
      const row = Math.min(5, Math.floor(u * 6));
      let offset = 0;
      for (let r = 0; r < row; r++) offset += ((cycle * 7 + r * 3) % 5) % 2 ? 1 : -1;
      const ballX = Math.round(cx + offset * 2.5) - 1;
      const ballY = by + 1 + Math.round(u * 6 * 4);
      fillRect(ctx, ballX, Math.min(ballY, by + 24), 2, 2, PAL.gold);

      // Base with a coin slot and drop button.
      fillRect(ctx, x + 3, y + 43, w - 6, 11, PAL.woodDark);
      fillRect(ctx, x + 3, y + 43, w - 6, 1, PAL.wood);
      fillRect(ctx, cx - 4, y + 47, 8, 2, PAL.ink);
      pxDisc(ctx, cx + 12, y + 48, 2, PAL.redLight);
      pxDisc(ctx, cx - 12, y + 48, 2, PAL.gold);
    }

    function drawSlotMachine(prop, time) {
      const { x, y } = prop;
      const frame = Math.floor(time * 4);
      const reelColors = [PAL.gold, PAL.green, PAL.blue, PAL.red];

      fillRect(ctx, x + 1, y + 25, 15, 2, PAL.shadow);
      fillRect(ctx, x, y, 16, 26, PAL.ink);
      fillRect(ctx, x + 1, y + 1, 14, 24, PAL.red);
      fillRect(ctx, x + 1, y + 1, 14, 5, PAL.molding);
      fillRect(ctx, x + 1, y + 6, 1, 15, PAL.redLight);

      // Marquee lights
      for (let i = 0; i < 4; i++) {
        fillRect(ctx, x + 2 + i * 3, y + 2, 2, 2, (frame + i) % 2 ? PAL.gold : PAL.goldDark);
      }

      // Reel window
      fillRect(ctx, x + 3, y + 7, 10, 7, PAL.ink);
      fillRect(ctx, x + 4, y + 8, 8, 5, PAL.cream);
      for (let i = 0; i < 3; i++) {
        fillRect(ctx, x + 4 + i * 3, y + 9, 2, 3, reelColors[(frame + i * 2 + x) % reelColors.length]);
      }

      // Coin tray & base
      fillRect(ctx, x + 3, y + 16, 10, 3, PAL.ink);
      fillRect(ctx, x + 4, y + 17, 8, 1, PAL.goldDark);
      fillRect(ctx, x + 1, y + 21, 14, 1, PAL.ink);
      fillRect(ctx, x + 1, y + 22, 14, 3, PAL.molding);

      // Lever
      fillRect(ctx, x + 16, y + 9, 1, 7, PAL.steel);
      fillRect(ctx, x + 15, y + 6, 3, 3, PAL.ink);
      fillRect(ctx, x + 16, y + 7, 1, 1, PAL.redLight);
    }

    /* ----- Slot machine close-up -------------------------------------- */

    const FONT_3X5 = Object.freeze({
      A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110',
      E: '111100110100111', F: '111100110100100', G: '011100101101011', H: '101101111101101',
      I: '111010010010111', J: '001001001101010', K: '101101110101101', L: '100100100100111',
      M: '101111111101101', N: '110101101101101', O: '010101101101010', P: '110101110100100',
      Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
      U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101',
      Y: '101101010010010', Z: '111001010100111',
      0: '111101101101111', 1: '010110010010111', 2: '110001010100111', 3: '110001010001110',
      4: '101101111001001', 5: '111100110001110', 6: '011100111101111', 7: '111001010010010',
      8: '111101111101111', 9: '111101111001110',
      '+': '000010111010000', '-': '000000111000000', '.': '000000000000010', '!': '010010010000010',
      ':': '000010000010000', '=': '000111000111000', '?': '110001010000010',
      ',': '000000000010100', "'": '010010000000000',
    });

    const pixelTextWidth = (text, scale = 1) => (text.length ? text.length * 4 * scale - scale : 0);

    function drawPixelText(g, text, x, y, color, scale = 1, align = 'left') {
      const str = String(text).toUpperCase();
      let cx = x;
      if (align === 'center') cx = Math.round(x - pixelTextWidth(str, scale) / 2);
      else if (align === 'right') cx = x - pixelTextWidth(str, scale);
      g.fillStyle = color;
      for (const ch of str) {
        const glyph = FONT_3X5[ch];
        if (glyph) {
          for (let i = 0; i < 15; i++) {
            if (glyph[i] === '1') g.fillRect(cx + (i % 3) * scale, y + Math.floor(i / 3) * scale, scale, scale);
          }
        }
        cx += 4 * scale;
      }
    }

    function drawShadowText(g, text, x, y, color, scale = 1, align = 'left', shadow = PAL.ink) {
      drawPixelText(g, text, x, y + scale, shadow, scale, align);
      drawPixelText(g, text, x, y, color, scale, align);
    }

    function pxDisc(g, cx, cy, r, color) {
      g.fillStyle = color;
      for (let dy = -r; dy <= r; dy++) {
        const half = Math.round(Math.sqrt(r * r - dy * dy));
        g.fillRect(cx - half, cy + dy, half * 2 + 1, 1);
      }
    }

    function pxLine(g, x0, y0, x1, y1, size, color) {
      g.fillStyle = color;
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      for (let i = 0; i <= steps; i++) {
        const k = steps ? i / steps : 0;
        g.fillRect(Math.round(x0 + (x1 - x0) * k), Math.round(y0 + (y1 - y0) * k), size, size);
      }
    }

    const SLOT_SYM_W = 30;
    const SLOT_SYM_H = 28;
    const slotArt = { symbols: {}, reelShade: null };

    function buildSevenSymbol() {
      const { canvas, g } = createLayer(SLOT_SYM_W, SLOT_SYM_H);
      const shape = (e, color) => {
        fillRect(g, 5 - e, 3 - e, 20 + e * 2, 6 + e * 2, color);
        fillRect(g, 5 - e, 3 - e, 4 + e * 2, 9 + e * 2, color);
        for (let y = 9 - e; y <= 25 + e; y++) {
          const right = Math.round(25 - (clamp(y, 9, 25) - 9) * 0.6);
          fillRect(g, right - 8 - e, y, 8 + e * 2, 1, color);
        }
      };
      shape(2, PAL.ink);
      shape(1, PAL.gold);
      shape(0, '#e43b44');
      fillRect(g, 5, 3, 20, 1, '#ff9a8a');
      for (let y = 9; y <= 25; y++) {
        const right = Math.round(25 - (y - 9) * 0.6);
        fillRect(g, right - 8, y, 1, 1, '#ff7b7b');
        fillRect(g, right - 1, y, 1, 1, '#9e2835');
      }
      fillRect(g, 5, 8, 20, 1, '#9e2835');
      fillRect(g, 7, 4, 3, 1, PAL.cream);
      return canvas;
    }

    function buildBarSymbol() {
      const { canvas, g } = createLayer(SLOT_SYM_W, SLOT_SYM_H);
      fillRect(g, 1, 5, 28, 18, PAL.ink);
      fillRect(g, 2, 6, 26, 16, PAL.goldDark);
      fillRect(g, 2, 6, 26, 1, PAL.cream);
      fillRect(g, 2, 7, 26, 1, PAL.gold);
      fillRect(g, 3, 8, 24, 12, '#1b1024');
      fillRect(g, 3, 8, 24, 1, '#3a2450');
      drawPixelText(g, 'BAR', 4, 10, PAL.goldDark, 2);
      drawPixelText(g, 'BAR', 4, 9, PAL.gold, 2);
      fillRect(g, 4, 9, 1, 1, PAL.cream);
      return canvas;
    }

    function buildCherrySymbol() {
      const { canvas, g } = createLayer(SLOT_SYM_W, SLOT_SYM_H);
      pxLine(g, 8, 15, 17, 3, 2, PAL.ink);
      pxLine(g, 21, 13, 17, 3, 2, PAL.ink);
      pxLine(g, 9, 15, 18, 4, 1, '#3f8a3a');
      pxLine(g, 21, 13, 18, 4, 1, '#3f8a3a');
      fillRect(g, 18, 1, 8, 5, PAL.ink);
      fillRect(g, 19, 2, 6, 3, PAL.green);
      fillRect(g, 20, 3, 4, 1, '#2a7a3e');
      fillRect(g, 19, 2, 2, 1, '#8fe08a');
      const cherry = (cx, cy) => {
        pxDisc(g, cx, cy, 7, PAL.ink);
        pxDisc(g, cx, cy, 6, '#8a1a30');
        pxDisc(g, cx - 1, cy - 1, 5, '#d8304a');
        fillRect(g, cx - 4, cy - 4, 2, 2, '#ff8a9a');
        fillRect(g, cx - 4, cy - 4, 1, 1, PAL.cream);
      };
      cherry(21, 18);
      cherry(9, 20);
      return canvas;
    }

    function buildDiamondSymbol() {
      const { canvas, g } = createLayer(SLOT_SYM_W, SLOT_SYM_H);
      const cx = 15;
      const half = (y) => (y < 10 ? 6 + (y - 4) : Math.max(0, Math.round(12 * (1 - (y - 10) / 16))));
      for (let y = 3; y <= 27; y++) {
        const h = half(clamp(y, 4, 26)) + 1;
        fillRect(g, cx - h, y, h * 2 + 1, 1, PAL.ink);
      }
      for (let y = 4; y <= 26; y++) {
        const h = half(y);
        const w = h * 2 + 1;
        const third = Math.max(1, Math.round(w / 3));
        fillRect(g, cx - h, y, w, 1, '#3b8fe0');
        if (y < 10) {
          fillRect(g, cx - h, y, third, 1, '#8fd8ff');
          fillRect(g, cx - h + third, y, third, 1, '#c9f2ff');
        } else {
          fillRect(g, cx - h, y, third, 1, '#6cc4ff');
          fillRect(g, cx + h - third + 1, y, third, 1, '#25579e');
        }
      }
      fillRect(g, cx - 6, 4, 13, 1, PAL.cream);
      fillRect(g, cx - 12, 10, 25, 1, '#e8fbff');
      fillRect(g, 8, 6, 1, 3, '#ffffff');
      fillRect(g, 7, 7, 3, 1, '#ffffff');
      return canvas;
    }

    function buildSlotArt() {
      slotArt.symbols = {
        7: buildSevenSymbol(),
        BAR: buildBarSymbol(),
        CHERRY: buildCherrySymbol(),
        DIAMOND: buildDiamondSymbol(),
      };
      // Curved-drum shading so the reels read as spinning cylinders.
      const { reelW, window: win } = SLOT_VIEW;
      const { canvas, g } = createLayer(reelW, win.h);
      for (let y = 0; y < win.h; y++) {
        const d = Math.abs(y + 0.5 - win.h / 2) / (win.h / 2);
        g.fillStyle = `rgba(24, 8, 28, ${(0.78 * d ** 2.2).toFixed(3)})`;
        g.fillRect(0, y, reelW, 1);
      }
      g.fillStyle = 'rgba(255, 255, 255, 0.12)';
      g.fillRect(0, Math.round(win.h * 0.38), reelW, 2);
      g.fillStyle = 'rgba(0, 0, 0, 0.18)';
      g.fillRect(0, 0, 2, win.h);
      g.fillRect(reelW - 2, 0, 2, win.h);
      slotArt.reelShade = canvas;
    }

    const BULB_RAINBOW = ['#ff5a5a', '#ffcd75', '#7cf0a0', '#41a6f6', '#d9a6ff'];

    function drawBulb(x, y, lit, color = '#ffe08a') {
      if (lit) {
        fillRect(ctx, x - 1, y - 1, 5, 5, 'rgba(255, 205, 117, 0.28)');
        fillRect(ctx, x, y, 3, 3, color);
        fillRect(ctx, x, y, 1, 1, '#fffbe8');
      } else {
        fillRect(ctx, x, y, 3, 3, '#5a3a1a');
      }
    }

    function slotLightState(s, t) {
      const res = s.result;
      const since = s.resolvedAt > 0 ? t - s.resolvedAt : Infinity;
      if (s.spinning) return { mode: 'spin', since };
      if (res && res.payout > 0) {
        const span = res.tier === 'pair' ? 2.5 : 5;
        if (since < span) return { mode: res.tier, since };
      }
      return { mode: 'idle', since };
    }

    function bulbLit(i, t, light) {
      if (light.mode === 'spin') return (i + Math.floor(t * 14)) % 2 === 0;
      if (light.mode === 'idle') return (i + Math.floor(t * 5)) % 4 === 0;
      return (i + Math.floor(t * 8)) % 2 === 0;
    }

    function bulbColor(i, t, light) {
      return RAINBOW_TIERS.has(light.mode) ? BULB_RAINBOW[(i + Math.floor(t * 12)) % BULB_RAINBOW.length] : '#ffe08a';
    }

    function drawSlotCabinet(s, t, light) {
      const { cab, window: win } = SLOT_VIEW;
      const right = cab.x + cab.w;
      const bottom = cab.y + cab.h;

      fillRect(ctx, cab.x - 6, bottom - 4, cab.w + 12, 8, 'rgba(0, 0, 0, 0.5)');
      fillRect(ctx, cab.x - 1, cab.y - 1, cab.w + 2, cab.h + 2, PAL.ink);
      fillRect(ctx, cab.x, cab.y, cab.w, cab.h, '#6e1a2c');
      fillRect(ctx, cab.x, cab.y, 3, cab.h, '#9a2a40');
      fillRect(ctx, right - 3, cab.y, 3, cab.h, '#4a0f1e');
      for (let y = cab.y + 6; y < bottom - 4; y += 6) fillRect(ctx, cab.x + 5, y, cab.w - 10, 1, 'rgba(0, 0, 0, 0.08)');
      fillRect(ctx, cab.x, cab.y, cab.w, 2, PAL.gold);
      fillRect(ctx, cab.x, cab.y + 2, cab.w, 1, PAL.goldDark);
      fillRect(ctx, cab.x, 150, cab.w, 1, PAL.goldDark);
      fillRect(ctx, cab.x, 151, cab.w, 1, PAL.gold);
      fillRect(ctx, cab.x, 192, cab.w, 1, PAL.goldDark);
      fillRect(ctx, cab.x, bottom - 3, cab.w, 3, '#3a0a16');

      // Side bulb columns
      let i = 0;
      for (let y = win.y + 2; y < win.y + win.h - 2; y += 9, i++) {
        drawBulb(cab.x + 3, y, bulbLit(i, t, light), bulbColor(i, t, light));
        drawBulb(right - 6, y, bulbLit(i + 1, t, light), bulbColor(i + 1, t, light));
      }

      // Reel housing: chrome bezel around a dark well
      const hx = win.x - 6;
      const hy = win.y - 6;
      const hw = win.w + 12;
      const hh = win.h + 12;
      fillRect(ctx, hx - 1, hy - 1, hw + 2, hh + 2, PAL.ink);
      fillRect(ctx, hx, hy, hw, hh, PAL.steel);
      fillRect(ctx, hx, hy, hw, 1, '#d6e4ee');
      fillRect(ctx, hx, hy + hh - 1, hw, 1, '#566c7c');
      fillRect(ctx, hx + 2, hy + 2, hw - 4, hh - 4, '#566c7c');
      fillRect(ctx, hx + 3, hy + 3, hw - 6, hh - 6, '#1b1024');
    }

    /** Black, dented 4th-reel box crudely hammered onto the cabinet's left side. */
    function drawSlotExtension() {
      const e = SLOT_EXT;
      const { window: win, reelW } = SLOT_VIEW;
      const right = e.x + e.w;
      const bottom = e.y + e.h;
      const nail = (x, y) => {
        fillRect(ctx, x, y, 2, 2, '#6d6a72');
        fillRect(ctx, x, y, 1, 1, '#a8a4ae');
      };

      fillRect(ctx, e.x - 4, bottom - 2, e.w + 6, 6, 'rgba(0, 0, 0, 0.5)');
      // Body is slightly crooked: the lower half sits a pixel lower and to the left.
      fillRect(ctx, e.x - 1, e.y - 1, e.w + 2, e.h / 2 + 2, PAL.ink);
      fillRect(ctx, e.x - 2, e.y + e.h / 2, e.w + 2, e.h / 2 + 2, PAL.ink);
      fillRect(ctx, e.x, e.y, e.w, e.h / 2, '#141216');
      fillRect(ctx, e.x - 1, e.y + e.h / 2 + 1, e.w, e.h / 2, '#121014');
      // Warped plank sticking up off the top edge.
      fillRect(ctx, e.x - 3, e.y - 5, 30, 6, PAL.ink);
      fillRect(ctx, e.x - 2, e.y - 4, 28, 4, '#1c1a1f');
      fillRect(ctx, e.x - 2, e.y - 4, 28, 1, '#2a2730');
      // Uneven plank seams.
      for (let y = e.y + 12, k = 0; y < bottom - 4; y += 15, k++) fillRect(ctx, e.x + 1, y + (k % 2), e.w - 3, 1, '#060507');
      // Hammer dents.
      for (const [dx, dy] of [[6, 20], [44, 9], [52, 70], [9, 96], [35, 108], [55, 40], [4, 58]]) {
        fillRect(ctx, e.x + dx, e.y + dy, 4, 3, '#09080b');
        fillRect(ctx, e.x + dx, e.y + dy + 3, 4, 1, '#2a2730');
      }
      // Nails all around the edge (some bent).
      for (let y = e.y + 4; y < bottom - 4; y += 13) {
        nail(e.x + 2, y);
        nail(right - 4, y + 5);
      }
      fillRect(ctx, e.x + 1, e.y + 30, 3, 1, '#6d6a72'); // bent nail
      // Rusty straps nailed across onto the cabinet.
      for (const sy of [e.y + 8, bottom - 20]) {
        fillRect(ctx, right - 12, sy - 1, 24, 7, PAL.ink);
        fillRect(ctx, right - 11, sy, 22, 5, '#3a3840');
        fillRect(ctx, right - 11, sy, 22, 1, '#55525c');
        fillRect(ctx, right - 3, sy + 2, 4, 2, '#5a3020');
        nail(right - 9, sy + 1);
        nail(right + 6, sy + 1);
      }

      // Crude iron frame around the extra reel.
      const hx = e.reelX - 4;
      const hy = win.y - 4;
      const hw = reelW + 8;
      const hh = win.h + 8;
      fillRect(ctx, hx - 1, hy - 1, hw + 2, hh + 2, PAL.ink);
      fillRect(ctx, hx, hy, hw, hh, '#2a282e');
      fillRect(ctx, hx, hy, hw, 1, '#45424c');
      fillRect(ctx, hx + 2, hy + 2, hw - 4, hh - 4, '#08070a');
      for (const [bx, by] of [[hx + 1, hy + 1], [hx + hw - 3, hy + 1], [hx + 1, hy + hh - 3], [hx + hw - 3, hy + hh - 3]]) nail(bx, by);

      // Loose wire dangling from the box into the cabinet.
      pxLine(ctx, e.x + 20, bottom, e.x + 26, bottom + 8, 1, '#3a3840');
      pxLine(ctx, e.x + 26, bottom + 8, right + 4, bottom + 2, 1, '#3a3840');
    }

    /** Paytable lines gouged into the cabinet in black by whoever bolted the box on. */
    function drawScratchedPay(text, x, y, hot, t) {
      const w = pixelTextWidth(text);
      if (hot) fillRect(ctx, x - 2, y - 2, w + 4, 10, Math.floor(t * 8) % 2 ? '#c84a5c' : '#7a2340');
      for (let i = 0; i < text.length; i++) {
        const jy = (i * 5) % 3 === 0 ? 1 : 0;
        drawPixelText(ctx, text[i], x + i * 4, y + jy + 1, 'rgba(255, 190, 200, 0.3)');
        drawPixelText(ctx, text[i], x + i * 4, y + jy, '#0b0608');
      }
      pxLine(ctx, x - 2, y + 8, x + w + 1, y + 7, 1, '#0b0608');
    }

    function drawSlotMarquee(s, t, light) {
      const m = SLOT_VIEW.marquee;
      fillRect(ctx, m.x + 10, m.y, m.w - 20, 3, PAL.ink);
      fillRect(ctx, m.x + 4, m.y + 2, m.w - 8, 3, PAL.ink);
      fillRect(ctx, m.x, m.y + 4, m.w, m.h - 4, PAL.ink);
      fillRect(ctx, m.x + 11, m.y + 1, m.w - 22, 2, PAL.goldDark);
      fillRect(ctx, m.x + 5, m.y + 3, m.w - 10, 2, PAL.goldDark);
      fillRect(ctx, m.x + 1, m.y + 5, m.w - 2, m.h - 6, PAL.goldDark);
      fillRect(ctx, m.x + 3, m.y + 6, m.w - 6, m.h - 9, '#2a0b18');
      fillRect(ctx, m.x + 8, m.y + 9, m.w - 16, m.h - 14, PAL.signBg);

      let label = 'LUCKY 7';
      let color = PAL.gold;
      if (light.mode === 'mega') {
        label = 'MEGA WIN!';
        color = BULB_RAINBOW[Math.floor(t * 14) % BULB_RAINBOW.length];
      } else if (light.mode === 'jackpot') {
        label = 'JACKPOT!';
        color = BULB_RAINBOW[Math.floor(t * 10) % BULB_RAINBOW.length];
      } else if (light.mode === 'triple' || light.mode === 'quad') {
        label = 'BIG WIN!';
        color = Math.floor(t * 8) % 2 ? PAL.cream : PAL.gold;
      } else if (light.mode === 'pair') {
        color = Math.floor(t * 8) % 2 ? PAL.cream : PAL.gold;
      }
      const glow = light.mode === 'idle' ? 0.12 + 0.06 * Math.sin(t * 3) : 0.3;
      fillRect(ctx, m.x + 8, m.y + 9, m.w - 16, m.h - 14, `rgba(255, 205, 117, ${glow.toFixed(3)})`);
      drawShadowText(ctx, label, m.x + m.w / 2, m.y + 11, color, 3, 'center', '#7a2340');

      // Chasing bulbs around the sign
      let i = 0;
      for (let x = m.x + 12; x <= m.x + m.w - 15; x += 8, i++) {
        drawBulb(x, m.y + 5, bulbLit(i, t, light), bulbColor(i, t, light));
      }
      for (let y = m.y + 11; y <= m.y + m.h - 6; y += 6, i++) {
        drawBulb(m.x + 3, y, bulbLit(i, t, light), bulbColor(i, t, light));
        drawBulb(m.x + m.w - 6, y, bulbLit(i + 1, t, light), bulbColor(i + 1, t, light));
      }
    }

    function drawSlotReels(s, t, light) {
      const { window: win, reelW, reelGap, cell } = SLOT_VIEW;
      const payY = win.y + win.h / 2;
      const res = s.result;
      const celebrating = light.mode === 'pair' || BIG_WIN_TIERS.has(light.mode);
      const pulse = 0.5 + 0.5 * Math.sin(t * 10);

      for (let i = 0; i < s.reelCount; i++) {
        const rx = i < 3 ? win.x + i * (reelW + reelGap) : SLOT_EXT.reelX;
        const reel = s.reels[i];
        const { pos, blur } = reel.plan ? slotReelAt(reel.plan, t) : { pos: reel.rest, blur: 0 };
        const isWinner = celebrating && res.winningReels[i];

        ctx.save();
        ctx.beginPath();
        ctx.rect(rx, win.y, reelW, win.h);
        ctx.clip();
        fillRect(ctx, rx, win.y, reelW, win.h, i < 3 ? '#efe4cc' : '#d6c9a8');
        if (isWinner) fillRect(ctx, rx, payY - cell / 2, reelW, cell, `rgba(255, 205, 117, ${(0.35 + 0.35 * pulse).toFixed(3)})`);

        const strip = SLOT_REEL_STRIPS[i];
        const base = Math.floor(pos);
        const dx = rx + Math.floor((reelW - SLOT_SYM_W) / 2);
        for (let k = base - 2; k <= base + 2; k++) {
          const img = slotArt.symbols[strip[wrapIndex(k, strip.length)]];
          let dy = Math.round(payY + (pos - k) * cell - SLOT_SYM_H / 2);
          if (isWinner && k === Math.round(pos)) dy -= Math.round(pulse * 2);
          if (blur > 0.3) {
            ctx.globalAlpha = 0.2 * blur;
            ctx.drawImage(img, dx, dy - 11);
            ctx.globalAlpha = 0.38 * blur;
            ctx.drawImage(img, dx, dy - 5);
            ctx.globalAlpha = 1 - 0.3 * blur;
          }
          ctx.drawImage(img, dx, dy);
          ctx.globalAlpha = 1;
        }

        ctx.drawImage(slotArt.reelShade, rx, win.y);
        if (reel.landedAt > 0 && t - reel.landedAt < 0.2) {
          fillRect(ctx, rx, win.y, reelW, win.h, `rgba(255, 251, 232, ${(0.4 * (1 - (t - reel.landedAt) / 0.2)).toFixed(3)})`);
        }
        if (celebrating && !isWinner) fillRect(ctx, rx, win.y, reelW, win.h, 'rgba(10, 4, 16, 0.5)');
        if (i === 3) {
          // Grimy, cracked glass on the bolted-on reel.
          fillRect(ctx, rx, win.y, reelW, win.h, 'rgba(20, 16, 10, 0.12)');
          pxLine(ctx, rx + 4, win.y + 6, rx + 18, win.y + 30, 1, 'rgba(255, 255, 255, 0.35)');
          pxLine(ctx, rx + 18, win.y + 30, rx + 14, win.y + 44, 1, 'rgba(255, 255, 255, 0.3)');
          pxLine(ctx, rx + 18, win.y + 30, rx + 34, win.y + 36, 1, 'rgba(255, 255, 255, 0.25)');
        }
        ctx.restore();

        if (isWinner) {
          const c = Math.floor(t * 8) % 2 ? PAL.cream : PAL.gold;
          const fx = rx - 1;
          const fy = payY - cell / 2 - 1;
          fillRect(ctx, fx, fy, reelW + 2, 2, c);
          fillRect(ctx, fx, fy + cell, reelW + 2, 2, c);
          fillRect(ctx, fx, fy, 2, cell + 2, c);
          fillRect(ctx, fx + reelW, fy, 2, cell + 2, c);
        }
      }

      // Payline + side arrows
      const lineColor = celebrating ? (Math.floor(t * 8) % 2 ? PAL.cream : PAL.gold) : 'rgba(228, 59, 68, 0.6)';
      fillRect(ctx, win.x, payY, win.w, 1, lineColor);
      if (s.reelCount > 3) fillRect(ctx, SLOT_EXT.reelX, payY, reelW, 1, lineColor);
      for (let k = 0; k < 4; k++) {
        fillRect(ctx, win.x - 6 + k, payY - 3 + k, 1, 7 - k * 2, celebrating ? PAL.gold : '#e43b44');
        fillRect(ctx, win.x + win.w + 5 - k, payY - 3 + k, 1, 7 - k * 2, celebrating ? PAL.gold : '#e43b44');
      }

      // Sparkles for the big wins
      if (BIG_WIN_TIERS.has(light.mode)) {
        const rainbow = RAINBOW_TIERS.has(light.mode);
        const count = light.mode === 'mega' ? 22 : rainbow ? 14 : 8;
        const left = s.reelCount > 3 ? SLOT_EXT.reelX : win.x;
        const span = win.x + win.w - left;
        const step = Math.floor(t * 6);
        for (let n = 0; n < count; n++) {
          const h = Math.abs(Math.sin((n + 1) * 91.7 + step * 13.1));
          const h2 = Math.abs(Math.sin((n + 1) * 37.3 + step * 7.7));
          const sx = Math.round(left - 10 + h * (span + 20));
          const sy = Math.round(win.y - 10 + h2 * (win.h + 20));
          const col = rainbow ? BULB_RAINBOW[n % BULB_RAINBOW.length] : PAL.cream;
          fillRect(ctx, sx - 2, sy, 5, 1, col);
          fillRect(ctx, sx, sy - 2, 1, 5, col);
        }
      }
    }

    function drawSlotPanel(s, t, light) {
      const { lcd, button, tray, cab } = SLOT_VIEW;
      const res = s.result;

      // LCD readout (payout counts up here, right under the reels)
      fillRect(ctx, lcd.x - 1, lcd.y - 1, lcd.w + 2, lcd.h + 2, PAL.ink);
      fillRect(ctx, lcd.x, lcd.y, lcd.w, lcd.h, '#0b1710');
      let text = s.message;
      let color = '#7cf0a0';
      if (s.messageTone === 'win' && res) {
        const shown = Math.round(res.payout * Math.min(1, (t - s.resolvedAt) / 0.9));
        text = `WIN +${shown}`;
        color = Math.floor(t * 6) % 2 || shown < res.payout ? PAL.gold : PAL.cream;
      } else if (s.messageTone === 'lose') {
        color = '#4f8a62';
      } else if (s.messageTone === 'deny') {
        color = Math.floor(t * 6) % 2 ? '#ff5a5a' : '#a83038';
      } else if (s.messageTone === 'spin') {
        color = Math.floor(t * 4) % 2 ? '#7cf0a0' : '#4f8a62';
      }
      if (s.messageTone === 'win') fillRect(ctx, lcd.x, lcd.y, lcd.w, lcd.h, 'rgba(255, 205, 117, 0.12)');
      drawPixelText(ctx, text, lcd.x + lcd.w / 2, lcd.y + 4, color, 2, 'center');
      for (let y = lcd.y; y < lcd.y + lcd.h; y += 2) fillRect(ctx, lcd.x, y, lcd.w, 1, 'rgba(0, 0, 0, 0.28)');
      fillRect(ctx, lcd.x, lcd.y, lcd.w, 1, 'rgba(124, 240, 160, 0.15)');

      // Credits / bet line
      drawPixelText(ctx, `CREDITS ${s.balance}`, lcd.x + 1, 176, PAL.cream);
      drawPixelText(ctx, `BET ${SLOT_SPIN_COST}`, lcd.x + lcd.w - 1, 176, PAL.gold, 1, 'right');

      // Paytable — the winning row lights up
      const rows = [
        { label: '777 X12', tier: 'jackpot' },
        { label: '3 ALIKE X6', tier: 'triple' },
        { label: 'PAIR X2', tier: 'pair' },
      ];
      const gap = 8;
      const total = rows.reduce((sum, r) => sum + pixelTextWidth(r.label), 0) + gap * (rows.length - 1);
      let px = Math.round(cab.x + cab.w / 2 - total / 2);
      for (const row of rows) {
        const hot = light.mode === row.tier;
        const w = pixelTextWidth(row.label);
        if (hot) fillRect(ctx, px - 2, 183, w + 4, 9, Math.floor(t * 8) % 2 ? '#7a2340' : '#4a0f1e');
        drawPixelText(ctx, row.label, px, 185, hot ? PAL.cream : PAL.goldDark);
        px += w + gap;
      }
      if (s.reelCount > 3) {
        drawScratchedPay('4 ALIKE X12', cab.x + 6, 200, light.mode === 'quad', t);
        drawScratchedPay('7777 X24', button.x + button.w + 6, 200, light.mode === 'mega', t);
      }
      if (s.lucky) {
        // Clover tucked into the cabinet trim, beside the coin tray.
        fillRect(ctx, tray.x - 19, tray.y - 3, 13, 14, 'rgba(99, 199, 77, 0.12)');
        ctx.drawImage(sprites.clover, tray.x - 17, tray.y - 1);
      }

      // SPIN button
      const pressed = s.spinning || t - s.leverPulledAt < 0.15;
      const denyShake = t - s.deniedAt < 0.35 ? Math.round(Math.sin(t * 80) * 2) : 0;
      const bx = button.x + denyShake;
      const by = button.y + (pressed ? 1 : 0);
      fillRect(ctx, button.x - 1, button.y - 1, button.w + 2, button.h + 3, PAL.ink);
      const ready = !s.spinning && s.balance >= SLOT_SPIN_COST;
      if (ready && Math.floor(t * 2) % 2) fillRect(ctx, button.x - 2, button.y - 2, button.w + 4, button.h + 5, 'rgba(255, 205, 117, 0.35)');
      fillRect(ctx, bx, by, button.w, button.h, pressed ? '#8a1a30' : '#d8304a');
      if (!pressed) {
        fillRect(ctx, bx, by, button.w, 1, '#ff8a9a');
        fillRect(ctx, bx, by + button.h - 2, button.w, 2, '#8a1a30');
      }
      drawShadowText(ctx, 'SPIN', bx + button.w / 2, by + 2, pressed ? '#d7a0a8' : PAL.cream, 2, 'center', '#5a0f20');

      // Coin tray
      fillRect(ctx, tray.x - 1, tray.y - 1, tray.w + 2, tray.h + 2, PAL.ink);
      fillRect(ctx, tray.x, tray.y, tray.w, tray.h, '#2a0f1c');
      fillRect(ctx, tray.x, tray.y, tray.w, 2, PAL.steel);
      fillRect(ctx, tray.x, tray.y + 2, tray.w, 1, '#566c7c');
    }

    function drawSlotLever(s, t) {
      const { lever } = SLOT_VIEW;
      const top = lever.y + 8;
      const bottom = lever.y + lever.h - 8;
      const mountY = lever.y + 56;
      const dt = t - s.leverPulledAt;
      let knobY = top;
      if (dt >= 0 && dt < 0.14) {
        knobY = top + (bottom - top) * (dt / 0.14) ** 2;
      } else if (dt >= 0.14 && dt < 0.7) {
        const u = (dt - 0.14) / 0.56;
        knobY = bottom - (bottom - top) * (1 - (1 - u) ** 3) - Math.sin(u * Math.PI) * 4 * (1 - u);
      }
      knobY = Math.round(knobY);
      const rodX = lever.x + 10;

      // Mount
      fillRect(ctx, lever.x - 1, mountY - 9, 9, 20, PAL.ink);
      fillRect(ctx, lever.x, mountY - 8, 7, 18, PAL.steel);
      fillRect(ctx, lever.x, mountY - 8, 7, 1, '#d6e4ee');
      fillRect(ctx, lever.x + 5, mountY - 8, 2, 18, '#566c7c');

      // Rod
      const y0 = Math.min(knobY, mountY);
      const y1 = Math.max(knobY, mountY);
      fillRect(ctx, rodX - 1, y0, 5, y1 - y0 + 1, PAL.ink);
      fillRect(ctx, rodX, y0, 3, y1 - y0 + 1, PAL.steel);
      fillRect(ctx, rodX, y0, 1, y1 - y0 + 1, '#d6e4ee');
      pxDisc(ctx, rodX + 1, mountY, 4, PAL.ink);
      pxDisc(ctx, rodX + 1, mountY, 3, '#566c7c');

      // Knob
      pxDisc(ctx, rodX + 1, knobY, 7, PAL.ink);
      pxDisc(ctx, rodX + 1, knobY, 6, '#8a1a30');
      pxDisc(ctx, rodX, knobY - 1, 5, '#e43b44');
      fillRect(ctx, rodX - 3, knobY - 4, 2, 2, '#ff9a8a');
      fillRect(ctx, rodX - 3, knobY - 4, 1, 1, PAL.cream);

      if (!s.spinning && dt > 0.7 && s.balance >= SLOT_SPIN_COST) {
        const bob = Math.floor(t * 3) % 2;
        drawPixelText(ctx, 'PULL', rodX + 9, top + 12 + bob, PAL.gold);
        fillRect(ctx, rodX + 12, top + 19 + bob, 3, 1, PAL.gold);
        fillRect(ctx, rodX + 13, top + 20 + bob, 1, 1, PAL.gold);
      }
    }

    function drawSlotCoins(s, t) {
      for (const coin of s.coins) {
        if (coin.delay > 0) continue;
        const frameW = [4, 3, 1, 3][Math.floor(t * 12 + coin.seed) % 4];
        const x = Math.round(coin.x - frameW / 2);
        const y = Math.round(coin.y);
        fillRect(ctx, x - 1, y - 1, frameW + 2, 6, PAL.ink);
        fillRect(ctx, x, y, frameW, 4, PAL.gold);
        if (frameW > 1) fillRect(ctx, x + frameW - 1, y, 1, 4, PAL.goldDark);
      }
    }

    function drawSlotView(s, time) {
      const t = time;
      const light = slotLightState(s, t);

      fillRect(ctx, 0, 0, CONFIG.WIDTH, CONFIG.HEIGHT, 'rgba(8, 4, 14, 0.82)');
      const glowColor = light.mode === 'idle' || light.mode === 'spin' ? 'rgba(177, 62, 83, 0.3)' : 'rgba(255, 205, 117, 0.32)';
      const glow = ctx.createRadialGradient(160, 110, 10, 160, 110, 180);
      glow.addColorStop(0, glowColor);
      glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, CONFIG.WIDTH, CONFIG.HEIGHT);
      if (RAINBOW_TIERS.has(light.mode) && light.since < 1.6 && Math.floor(light.since * 10) % 2 === 0) {
        fillRect(ctx, 0, 0, CONFIG.WIDTH, CONFIG.HEIGHT, 'rgba(255, 205, 117, 0.22)');
      }

      // Camera jolt on reel stops and big wins
      let sx = 0;
      let sy = 0;
      for (const reel of s.reels) if (reel.landedAt > 0 && t - reel.landedAt < 0.08) sy = 1;
      if (BIG_WIN_TIERS.has(light.mode) && light.since < 0.6) {
        const amp = RAINBOW_TIERS.has(light.mode) ? 2 : 1;
        sx = Math.round(Math.sin(t * 97) * amp);
        sy = Math.round(Math.cos(t * 83) * amp);
      }

      ctx.save();
      ctx.translate(sx, sy);
      drawSlotCabinet(s, t, light);
      if (s.reelCount > 3) drawSlotExtension();
      drawSlotMarquee(s, t, light);
      drawSlotReels(s, t, light);
      drawSlotPanel(s, t, light);
      drawSlotLever(s, t);
      drawSlotCoins(s, t);
      ctx.restore();

      drawPixelText(ctx, 'SPACE SPIN', 6, 230, s.spinning ? '#6b5a70' : PAL.cream);
      drawPixelText(ctx, 'ESC LEAVE', CONFIG.WIDTH - 6, 230, s.spinning ? '#6b5a70' : PAL.cream, 1, 'right');
    }

    function drawPlant(prop) {
      fillRect(ctx, prop.x + 2, prop.y + prop.h - 1, 8, 2, PAL.shadow);
      ctx.drawImage(sprites.plant, prop.x, prop.y);
    }

    function drawInteractBubble(time, who = dealer) {
      const bounce = Math.floor(time * 3) % 2;
      ctx.drawImage(sprites.bubble, who.x + 1, who.y - 13 - bounce);
    }

    /* ----- Frame ------------------------------------------------------ */

    /* ----- Train ------------------------------------------------------- */

    function drawWheel(cx, cy, r, spin) {
      fillRect(ctx, cx - r, cy - r, r * 2, r * 2, '#161616');
      fillRect(ctx, cx - r + 1, cy - r + 1, r * 2 - 2, r * 2 - 2, '#2a2a2a');
      fillRect(ctx, cx - 1, cy - 1, 2, 2, '#cfcfcf');
      ctx.strokeStyle = '#cfcfcf';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(spin) * (r - 1), cy + Math.sin(spin) * (r - 1));
      ctx.stroke();
    }

    /** One train car at `centerX` (world space); returns its left screen x. */
    function drawTrainCar(centerX, y, w, h, viewX, lit, spin) {
      const x = Math.round(centerX - viewX - w / 2);
      const top = y - h;

      fillRect(ctx, x + 2, y + 2, w - 4, 3, PAL.shadow);
      fillRect(ctx, x, top, w, h, PAL.ink);
      fillRect(ctx, x + 1, top + 1, w - 2, 5, TRAIN_LIVERY.roof);
      fillRect(ctx, x + 1, top + 6, w - 2, h - 13, TRAIN_LIVERY.body);
      fillRect(ctx, x + 1, top + h - 7, w - 2, 2, TRAIN_LIVERY.trim);
      fillRect(ctx, x + 1, top + h - 5, w - 2, 3, '#3d252b');

      // Top edge highlight and rivet rhythm.
      fillRect(ctx, x + 2, top + 1, w - 4, 1, 'rgba(255,255,255,0.22)');
      for (let rx = x + 4; rx < x + w - 4; rx += 8) fillRect(ctx, rx, top + h - 8, 1, 1, '#d8b55f');

      // Side doors and panel seams.
      fillRect(ctx, x + 4, top + 8, 7, 12, '#6f2d3a');
      fillRect(ctx, x + w - 11, top + 8, 7, 12, '#6f2d3a');
      fillRect(ctx, x + 5, top + 9, 5, 10, TRAIN_LIVERY.body);
      fillRect(ctx, x + w - 10, top + 9, 5, 10, TRAIN_LIVERY.body);
      fillRect(ctx, x + 7, top + 14, 1, 2, PAL.ink);
      fillRect(ctx, x + w - 8, top + 14, 1, 2, PAL.ink);

      let wx = x + 5;
      let wi = 0;
      while (wx + 9 <= x + w - 5) {
        fillRect(ctx, wx, top + 8, 9, 7, '#0c1622');
        fillRect(ctx, wx + 1, top + 9, 7, 5, lit ? TRAIN_LIVERY.window : '#2a3744');
        if (lit) fillRect(ctx, wx + 1, top + 9, 7, 1, 'rgba(255,255,255,0.35)');
        if ((wi + Math.round(centerX / 10)) % 2 === 0) fillRect(ctx, wx + 3, top + 10, 3, 4, '#241c30');
        wx += 13;
        wi++;
      }

      // Roof vents.
      for (let vx = x + 10; vx < x + w - 10; vx += 14) {
        fillRect(ctx, vx, top - 1, 8, 2, '#2d1a24');
        fillRect(ctx, vx + 1, top, 6, 1, '#6c4050');
      }

      // Coupler stub (links cars visually).
      fillRect(ctx, x + w - 1, top + h - 5, 3, 3, '#1a1a1a');

      drawWheel(x + 10, y + 2, 4, spin);
      drawWheel(x + w - 10, y + 2, 4, spin);
      drawWheel(Math.round(x + w / 2), y + 2, 4, spin + Math.PI / 3);
      return x;
    }

    /** The moving train: an engine + trailing passenger car, with a
     * headlight, livery text and spinning wheels while it's underway. */
    function drawTrain(train, viewX, time) {
      const y = TOWN_WORLD.trackY + 10;
      const carW = 56;
      const carH = 24;
      const dir = train.direction >= 0 ? 1 : -1;
      const spin = time * (2 + train.vx / 30) * dir;

      const carX = drawTrainCar(train.worldX - dir * (carW + 6), y, carW, carH, viewX, true, spin);
      const engineX = drawTrainCar(train.worldX, y, carW, carH, viewX, true, spin);

      // Engine nose details and live destination display.
      const noseX = dir > 0 ? engineX + carW - 6 : engineX;
      fillRect(ctx, noseX, y - carH + 7, 6, 12, '#5f2b38');
      fillRect(ctx, noseX + (dir > 0 ? 1 : 0), y - carH + 8, 4, 10, TRAIN_LIVERY.body);
      fillRect(ctx, noseX + 1, y - carH + 9, 4, 1, 'rgba(255,255,255,0.25)');

      fillRect(ctx, engineX + 16, y - carH + 2, 24, 4, '#211a26');
      fillRect(ctx, engineX + 17, y - carH + 3, 22, 2, '#ffd75e');
      ctx.save();
      ctx.fillStyle = '#2b2031';
      ctx.font = 'bold 4px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('NXT STOP', engineX + 28, y - carH + 4.5, 20);
      ctx.restore();

      const frontX = dir > 0 ? engineX + carW : engineX;
      const glowAlpha = 0.3 + 0.15 * Math.sin(time * 6);
      ctx.save();
      ctx.globalAlpha = glowAlpha;
      ctx.fillStyle = '#ffe9a8';
      ctx.beginPath();
      ctx.ellipse(frontX + dir * 5, y - carH + 12, 9, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      fillRect(ctx, frontX + (dir > 0 ? -1 : -3), y - carH + 10, 4, 4, '#fff6c8');

      ctx.save();
      ctx.fillStyle = TRAIN_LIVERY.trim;
      ctx.font = 'bold 6px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('LUCKY EXPRESS', carX + carW / 2, y - carH + 3, carW - 4);
      ctx.restore();
    }

    /** A parked train idling at a station (gentle light flicker, no spin). */
    function drawParkedTrain(stationCenterX, viewX, time) {
      const y = TOWN_WORLD.trackY + 10;
      const carW = 56;
      const carH = 24;
      const lit = Math.floor(time * 1.5) % 7 < 6;
      drawTrainCar(stationCenterX - TRAIN_STOP_OFFSET, y, carW, carH, viewX, lit, 0);
      drawTrainCar(stationCenterX + TRAIN_STOP_OFFSET, y, carW, carH, viewX, lit, 0);

      // Subtle station idle steam pulse.
      const sx = Math.round(stationCenterX - viewX);
      const pulse = Math.floor(time * 5) % 8;
      fillRect(ctx, sx - 4, y - carH - 3 - (pulse % 3), 2, 2, 'rgba(220, 230, 240, 0.45)');
      fillRect(ctx, sx + 2, y - carH - 6 - ((pulse + 2) % 3), 2, 2, 'rgba(220, 230, 240, 0.32)');
    }

    /** A rail tunnel cut through the town's outer wall. The signal is green
     * when a route runs through it; the lintel names the town it leads to. */
    function drawTunnelPortal(side, viewX, time, label, open, collapsed = false) {
      const W = TOWN_WORLD.width;
      const wallX = side === 'left' ? -viewX : W - viewX; // outer edge of the wall on screen
      const inward = side === 'left' ? 1 : -1;
      if ((side === 'left' && wallX > CONFIG.WIDTH) || (side === 'right' && wallX < 0)) return;
      if ((side === 'left' && wallX + 40 < 0) || (side === 'right' && wallX - 40 > CONFIG.WIDTH)) return;

      const top = 106;
      const bottom = 144;
      const depth = 26;
      const inner = wallX + inward * depth;

      // Darkness swallowing the rails (and the train) as they enter the wall.
      const grad = ctx.createLinearGradient(wallX + inward * 8, 0, inner, 0);
      grad.addColorStop(0, 'rgba(4, 3, 8, 1)');
      grad.addColorStop(0.5, 'rgba(4, 3, 8, 0.75)');
      grad.addColorStop(1, 'rgba(4, 3, 8, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(Math.min(wallX, inner), top, depth, bottom - top);

      // Stone lintel with the destination plate.
      const lx = Math.min(wallX, wallX + inward * 26);
      fillRect(ctx, lx, top - 9, 26, 10, PAL.ink);
      fillRect(ctx, lx + 1, top - 8, 24, 8, '#4c5262');
      fillRect(ctx, lx + 1, top - 8, 24, 1, '#7a8296');
      fillRect(ctx, lx + 3, top - 6, 20, 5, '#23202c');
      drawPixelText(ctx, label, lx + 13, top - 6, open ? PAL.gold : '#8a7a8a', 1, 'center');
      // Side jamb on the town side of the opening.
      const jx = side === 'left' ? lx + 23 : lx;
      fillRect(ctx, jx, top, 3, 4, PAL.ink);
      fillRect(ctx, jx + (side === 'left' ? 0 : 1), top, 2, 3, '#4c5262');

      // Signal lamp above the lintel.
      const sx = Math.round(wallX + inward * 4) - 1;
      fillRect(ctx, sx, top - 17, 4, 8, PAL.ink);
      fillRect(ctx, sx + 1, top - 10, 2, 1, '#566c7c');
      const blink = !collapsed && (open || Math.floor(time * 2) % 2 === 0);
      const lamp = open ? '#7cf0a0' : '#ff5a5a';
      if (blink) fillRect(ctx, sx - 1, top - 17, 6, 6, open ? 'rgba(124, 240, 160, 0.3)' : 'rgba(255, 90, 90, 0.3)');
      fillRect(ctx, sx + 1, top - 16, 2, 4, blink ? lamp : '#3a2a2a');

      if (collapsed) {
        // Cracked lintel once the roof has come down.
        pxLine(ctx, lx + 6, top - 9, lx + 9, top - 4, 1, PAL.ink);
        pxLine(ctx, lx + 9, top - 4, lx + 7, top, 1, PAL.ink);
        pxLine(ctx, lx + 18, top - 9, lx + 16, top - 5, 1, PAL.ink);
      }
    }

    // Fixed rubble layout for a caved-in tunnel mouth, stacked bottom-up so it
    // can be revealed rock by rock as the roof comes down.
    const TUNNEL_RUBBLE = (() => {
      let seed = 1337;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      const colors = ['#4c5262', '#3a3f4c', '#5e6476', '#2e2b38', '#6b6458'];
      const rocks = [];
      const rows = 7;
      for (let r = 0; r < rows; r++) {
        const y = 144 - (r + 1) * 5 - Math.floor(rnd() * 2);
        const reach = 38 - r * 2; // pile slopes back toward the wall as it rises
        let x = 0;
        while (x < reach) {
          const w = 4 + Math.floor(rnd() * 5);
          rocks.push({ x, y, w: Math.min(w, reach - x + 2), h: 5 + Math.floor(rnd() * 3), color: colors[Math.floor(rnd() * colors.length)] });
          x += w - 1;
        }
      }
      return rocks.map((rock, i) => ({ ...rock, land: 0.35 + (i / rocks.length) * (TUNNEL_COLLAPSE_SLAM - 0.2) }));
    })();

    /** Rocks pile into the right-hand tunnel until it's sealed, then a dust
     * cloud rolls out. `t` is seconds since the collapse began (Infinity once
     * it's long over). */
    function drawTunnelCollapse(viewX, time, t) {
      const wallX = TOWN_WORLD.width - viewX;
      if (wallX + 4 < 0 || wallX - 60 > CONFIG.WIDTH) return;

      // Solid dark behind the rubble so nothing peeks through gaps.
      if (t >= TUNNEL_COLLAPSE_SLAM) fillRect(ctx, wallX - 26, 106, 26, 38, '#0c0a12');

      for (const rock of TUNNEL_RUBBLE) {
        const fallT = clamp((t - rock.land + 0.28) / 0.28, 0, 1);
        if (fallT <= 0) continue;
        const y = Math.round(96 + (rock.y - 96) * fallT * fallT);
        const x = Math.round(wallX - rock.x - rock.w);
        fillRect(ctx, x, y, rock.w, rock.h, PAL.ink);
        fillRect(ctx, x + 1, y + 1, rock.w - 2, rock.h - 2, rock.color);
        fillRect(ctx, x + 1, y + 1, rock.w - 2, 1, 'rgba(255, 255, 255, 0.16)');
      }

      // Pebbles still trickling down from the cracked roof.
      if (t < TUNNEL_COLLAPSE_DURATION) {
        for (let i = 0; i < 6; i++) {
          const phase = (t * 1.7 + i * 0.37) % 1;
          const px = Math.round(wallX - 4 - ((i * 7) % 24));
          fillRect(ctx, px, Math.round(98 + phase * 34), 2, 2, i % 2 ? '#7a8296' : '#5e6476');
        }
      }

      // Dust cloud billowing out after the slam.
      const dustT = (t - TUNNEL_COLLAPSE_SLAM) / (TUNNEL_COLLAPSE_DURATION - TUNNEL_COLLAPSE_SLAM);
      if (dustT > 0 && dustT < 1) {
        const alpha = 0.55 * (1 - dustT);
        for (let i = 0; i < 9; i++) {
          const spread = 10 + dustT * (40 + (i % 3) * 18);
          const cx = wallX - 14 - spread * (0.4 + (i % 4) * 0.25);
          const cy = 132 - (i % 3) * 9 - dustT * 10 + Math.sin(time * 3 + i) * 1.5;
          ctx.fillStyle = `rgba(${150 + (i % 2) * 20}, ${140 + (i % 2) * 15}, 128, ${alpha.toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(cx, cy, 6 + dustT * 12 + (i % 3) * 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    /** Camera shake while the tunnel comes down: a rumble that peaks at the slam. */
    function collapseShake(t, time) {
      if (!(t >= 0 && t < TUNNEL_COLLAPSE_DURATION)) return { x: 0, y: 0 };
      const amp = t < TUNNEL_COLLAPSE_SLAM
        ? 0.6 + t / TUNNEL_COLLAPSE_SLAM
        : 3.5 * Math.max(0, 1 - (t - TUNNEL_COLLAPSE_SLAM) / 0.9);
      return { x: Math.round(Math.sin(time * 71) * amp), y: Math.round(Math.cos(time * 53) * amp * 0.7) };
    }

    function render(state, time) {
      if (state.mode === MODE.INTRO && state.intro) {
        drawIntroCutscene(state.intro, performance.now() / 1000);
        return;
      }
      if (state.mode === MODE.CUTSCENE && state.cutscene) {
        // Cutscene timings are stamped with performance.now(), so draw on that clock.
        drawRobberyCutscene(state.cutscene, performance.now() / 1000);
        return;
      }
      if (state.areaType === 'town') {
        const viewX = Math.round(clamp(state.cameraX ?? 0, 0, TOWN_WORLD.width - CONFIG.WIDTH));
        const train = state.train;
        const townBg = state.townIndex > 1 ? townBackgroundBlackMarket : townBackground;
        const backCollapsed = state.collapsedTunnels.has(state.townIndex);
        const collapseT = backCollapsed
          ? (state.collapse?.town === state.townIndex ? time - state.collapse.startedAt : Infinity)
          : -1;
        const shake = collapseShake(collapseT, time);
        if (shake.x || shake.y) {
          fillRect(ctx, 0, 0, CONFIG.WIDTH, CONFIG.HEIGHT, PAL.ink);
          ctx.save();
          ctx.translate(shake.x, shake.y);
        }
        ctx.drawImage(townBg, viewX, 0, CONFIG.WIDTH, CONFIG.HEIGHT, 0, 0, CONFIG.WIDTH, CONFIG.HEIGHT);
        drawTownAmbient(viewX, time, state.townIndex);

        // A train idles at every platform in service, except the one in use.
        const platforms = state.townIndex > 1 ? ['left', 'right'] : ['left'];
        for (const key of platforms) {
          if (train.active && train.stationKey === key) continue;
          drawParkedTrain((key === 'left' ? TOWN_WORLD.stationLeft : TOWN_WORLD.stationRight).centerX, viewX, time);
        }

        if (train.active) {
          // Clip at the walls so the train really disappears into the tunnels.
          ctx.save();
          ctx.beginPath();
          ctx.rect(8 - viewX, 0, TOWN_WORLD.width - 16, CONFIG.HEIGHT);
          ctx.clip();
          drawTrain(train, viewX, time);
          ctx.restore();
          if (train.phase === 'alight') drawPlayer(viewX);
        } else {
          drawPlayer(viewX);
        }

        const forwardOpen = state.townIndex < MAX_TOWNS;
        drawTunnelPortal('left', viewX, time, forwardOpen ? `TOWN${state.townIndex + 1}` : 'SOON', forwardOpen);
        if (state.townIndex > 1) {
          drawTunnelPortal('right', viewX, time, backCollapsed ? 'CAVED' : `TOWN${state.townIndex - 1}`, !backCollapsed, backCollapsed);
          if (backCollapsed) drawTunnelCollapse(viewX, time, collapseT);
        }

        if (train.active && train.fade > 0) {
          fillRect(ctx, 0, 0, CONFIG.WIDTH, CONFIG.HEIGHT, `rgba(5, 3, 10, ${train.fade.toFixed(3)})`);
        }
        if (shake.x || shake.y) ctx.restore();
      } else if (state.areaType === 'cosmetics') {
        ctx.drawImage(cosmeticsBackground, 0, 0);
        drawInteriorAmbient('cosmetics', time);
        drawPlayer();
      } else if (interiorBackgrounds[state.areaType]) {
        const useBlackMarket = state.areaType === 'fishing' && state.townIndex > 1;
        const useBank = state.areaType === 'butcher' && state.townIndex > 1;
        const bgKey = useBlackMarket ? 'fishingBlackMarket' : useBank ? 'butcherBank' : state.areaType;
        ctx.drawImage(interiorBackgrounds[bgKey], 0, 0);
        if (useBlackMarket) drawBlackMarketAmbient(time, state.relics);
        else if (useBank) drawBankAmbient(time, state.backroomOpen);
        else if (state.areaType === 'backroom') drawBackroomAmbient(time);
        else drawInteriorAmbient(state.areaType, time);
        drawPlayer();
      } else {
        const grand = state.townIndex >= GRAND_CASINO_TOWN;
        ctx.drawImage(grand ? backgroundGrand : background, 0, 0);
        const list = grand ? grandDrawables : drawables;
        list.sort((a, b) => a.sortY - b.sortY);
        for (const drawable of list) drawable.draw(time);
        if (state.casinoTarget?.bubble && state.mode === MODE.OVERWORLD) drawInteractBubble(time, state.casinoTarget.bubble);
        // Slot timings are stamped with performance.now(), so draw on that same clock.
        if (state.mode === MODE.SLOTS && state.slots) drawSlotView(state.slots, performance.now() / 1000);
      }
    }

    return { init, render, pixelText: drawPixelText };
  })();

  /* ========================================================================
     9. BLACKJACK ENGINE
     Pure game rules + a small state machine. No DOM access; the UI
     subscribes through `onChange` and reads public state.

       BETTING --deal()--> PLAYER --hit()/stand()--> DEALER --> RESULT
          ^                   |  (bust / naturals)               |
          |                   +-------------> RESULT             |
          +------------------------newHand()---------------------+
     ====================================================================== */

  const SUITS = Object.freeze(['spade', 'heart', 'diamond', 'club']);
  const RED_SUITS = new Set(['heart', 'diamond']);
  const RANKS = Object.freeze(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']);
  const RANK_NAMES = Object.freeze({ A: 'Ace', J: 'Jack', Q: 'Queen', K: 'King' });

  const PHASE = Object.freeze({
    BETTING: 'betting',
    PLAYER: 'player',
    DEALER: 'dealer',
    RESULT: 'result',
  });

  const OUTCOME = Object.freeze({
    WIN: 'win',
    BLACKJACK: 'blackjack',
    PUSH: 'push',
    LOSE: 'lose',
  });

  /** Total amount returned to the player (stake included) for each outcome. */
  const PAYOUT = Object.freeze({
    [OUTCOME.WIN]: (bet) => bet * 2,
    [OUTCOME.BLACKJACK]: (bet) => bet + Math.floor(bet * 1.5), // 3:2
    [OUTCOME.PUSH]: (bet) => bet,
    [OUTCOME.LOSE]: () => 0,
  });

  function shuffle(array) {
    // Fisher–Yates
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  function createShoe(numDecks) {
    const cards = [];
    for (let d = 0; d < numDecks; d++) {
      for (const suit of SUITS) {
        for (const rank of RANKS) cards.push(Object.freeze({ rank, suit }));
      }
    }
    return shuffle(cards);
  }

  function rankValue(rank) {
    if (rank === 'A') return 11;
    if (rank === 'J' || rank === 'Q' || rank === 'K') return 10;
    return Number(rank);
  }

  /** Best total for a hand; `soft` = an ace is still being counted as 11. */
  function scoreHand(cards) {
    let total = 0;
    let aces = 0;
    for (const card of cards) {
      total += rankValue(card.rank);
      if (card.rank === 'A') aces++;
    }
    while (total > 21 && aces > 0) {
      total -= 10;
      aces--;
    }
    return { total, soft: aces > 0 };
  }

  const isBlackjack = (cards) => cards.length === 2 && scoreHand(cards).total === 21;

  class BlackjackGame {
    #shoe;
    #onChange;
    #onEvent;

    /**
     * @param {object} options
     * @param {(game: BlackjackGame) => void} [options.onChange]  state changed (re-render)
     * @param {(type: string, data: object) => void} [options.onEvent]  discrete moments
     *        (shuffle, card, flip, bet, deal, turn, hit, stand, dealerDraw, result,
     *        betting, broke, rebuy) for audio / effects. The engine never touches audio.
     */
    constructor({ startingBalance, onChange = () => {}, onEvent = () => {} }) {
      this.#shoe = createShoe(CONFIG.NUM_DECKS);
      this.#onChange = onChange;
      this.#onEvent = onEvent;
      this.balance = startingBalance;
      this.luckyHand = false; // set by the controller once the Lucky Hand is owned
      this.noRebuy = false; // town 2 onwards: the house won't spot you
      this.selectedBet = null;
      this.round = 0;
      this.#resetHand();
      this.phase = PHASE.BETTING;
      this.message = 'Place your bet!';
    }

    /* ----- Derived state ---------------------------------------------- */

    get minBet() {
      return Math.min(...CONFIG.BET_OPTIONS);
    }

    get isBroke() {
      return this.phase === PHASE.BETTING && this.balance < this.minBet;
    }

    get canDeal() {
      return this.phase === PHASE.BETTING && this.selectedBet !== null && this.selectedBet <= this.balance;
    }

    /** Leaving is only allowed when no tokens are on the table. */
    get canLeave() {
      return this.phase === PHASE.BETTING || this.phase === PHASE.RESULT;
    }

    /* ----- Actions ---------------------------------------------------- */

    selectBet(amount) {
      if (this.phase !== PHASE.BETTING) return false;
      if (!CONFIG.BET_OPTIONS.includes(amount) || amount > this.balance) return false;
      this.selectedBet = amount;
      this.message = `Bet ${amount} tokens. Ready to deal!`;
      this.#fire('bet', { amount });
      this.#emit();
      return true;
    }

    deal() {
      if (!this.canDeal) return false;

      let reshuffled = false;
      if (this.#shoe.length < CONFIG.RESHUFFLE_THRESHOLD) {
        this.#shoe = createShoe(CONFIG.NUM_DECKS);
        reshuffled = true;
        this.#fire('shuffle');
      }

      this.round++;
      this.#resetHand();
      this.bet = this.selectedBet;
      this.balance -= this.bet; // stake leaves the balance on confirmation
      this.#fire('deal', { bet: this.bet });

      // Deal alternately: player, dealer, player, dealer (hole card)
      this.#dealTo('player', 0);
      this.#dealTo('dealer', 1);
      this.#dealTo('player', 2);
      this.#dealTo('dealer', 3);
      this.holeHidden = true;

      // Naturals end the round immediately
      const playerNatural = isBlackjack(this.playerHand);
      const dealerNatural = isBlackjack(this.dealerHand);
      if (playerNatural || dealerNatural) {
        this.holeHidden = false;
        this.#fire('flip', { order: 4 });
        if (playerNatural && dealerNatural) return this.#settle(OUTCOME.PUSH, 'Both have Blackjack. Push!', 'push', true);
        if (playerNatural) return this.#settle(OUTCOME.BLACKJACK, 'BLACKJACK! Pays 3:2!', 'blackjack', true);
        return this.#settle(OUTCOME.LOSE, 'Dealer has Blackjack.', 'dealerBlackjack', true);
      }

      this.phase = PHASE.PLAYER;
      const { total } = scoreHand(this.playerHand);
      this.message = `${reshuffled ? 'Fresh shoe! ' : ''}You have ${total}. Hit or Stand?`;
      this.#fire('turn', { total });
      this.#emit();
      return true;
    }

    hit() {
      if (this.phase !== PHASE.PLAYER) return false;
      this.#dealTo('player');
      const { total } = scoreHand(this.playerHand);

      if (total > 21) {
        this.holeHidden = false;
        this.#fire('flip', { order: 1 });
        this.#settle(OUTCOME.LOSE, `Bust with ${total}!`, 'bust');
      } else if (total === 21) {
        this.stand(); // nothing better to do on 21
      } else {
        this.message = `You have ${total}. Hit or Stand?`;
        this.#fire('hit', { total });
        this.#emit();
      }
      return true;
    }

    stand() {
      if (this.phase !== PHASE.PLAYER) return false;
      this.#fire('stand');
      this.#playDealerTurn();
      return true;
    }

    newHand() {
      if (this.phase !== PHASE.RESULT) return false;
      this.#resetHand();
      this.phase = PHASE.BETTING;
      if (this.selectedBet !== null && this.selectedBet > this.balance) this.selectedBet = null;

      if (this.isBroke) this.message = this.noRebuy ? 'Out of tokens! No credit at this table.' : 'Out of tokens! The house can spot you.';
      else if (this.selectedBet !== null) this.message = `Bet ${this.selectedBet} again? Ready to deal!`;
      else this.message = 'Place your bet!';

      this.#fire(this.isBroke ? 'broke' : 'betting');
      this.#emit();
      return true;
    }

    rebuy() {
      if (!this.isBroke || this.noRebuy) return false;
      this.balance = CONFIG.REBUY_AMOUNT;
      this.message = `The house spots you ${CONFIG.REBUY_AMOUNT}. Good luck!`;
      this.#fire('rebuy');
      this.#emit();
      return true;
    }

    spendTokens(amount) {
      if (!Number.isFinite(amount) || amount <= 0) return false;
      if (this.phase === PHASE.PLAYER || this.phase === PHASE.DEALER) return false;
      if (this.balance < amount) return false;
      this.balance -= Math.floor(amount);
      if (this.selectedBet !== null && this.selectedBet > this.balance) this.selectedBet = null;
      this.#emit();
      return true;
    }

    addTokens(amount) {
      if (!Number.isFinite(amount) || amount <= 0) return false;
      this.balance += Math.floor(amount);
      this.#emit();
      return true;
    }

    /* ----- Internals -------------------------------------------------- */

    async #playDealerTurn() {
      const round = this.round;
      this.phase = PHASE.DEALER;
      this.holeHidden = false;
      this.message = 'Dealer flips the hole card...';
      this.#fire('flip', { order: 0 });
      this.#emit();
      await wait(CONFIG.DEALER_STEP_MS);

      // Dealer draws on 16 or less, stands on all 17s (including soft 17)
      while (scoreHand(this.dealerHand).total < CONFIG.DEALER_STANDS_ON) {
        if (round !== this.round) return; // safety: round changed underneath us
        this.#dealTo('dealer');
        this.message = 'Dealer draws...';
        this.#fire('dealerDraw');
        this.#emit();
        await wait(CONFIG.DEALER_STEP_MS);
      }
      if (round !== this.round) return;
      this.#resolveShowdown();
    }

    #resolveShowdown() {
      const player = scoreHand(this.playerHand).total;
      const house = scoreHand(this.dealerHand).total;

      if (house > 21) this.#settle(OUTCOME.WIN, `Dealer busts with ${house}!`, 'dealerBust');
      else if (player > house) this.#settle(OUTCOME.WIN, `You win, ${player} to ${house}!`, 'win');
      else if (player < house) this.#settle(OUTCOME.LOSE, `Dealer wins, ${house} to ${player}.`, 'lose');
      else this.#settle(OUTCOME.PUSH, `Push at ${player}.`, 'push');
    }

    /**
     * @param {string} outcome  one of OUTCOME
     * @param {string} text  message shown to the player
     * @param {string} reason  finer-grained cause (bust, dealerBust, ...) used by audio
     * @param {boolean} [natural]  true when the round ended straight after the deal
     */
    #settle(outcome, text, reason, natural = false) {
      const payout = PAYOUT[outcome](this.bet);
      const net = payout - this.bet;
      this.balance += payout;
      this.outcome = outcome;
      this.phase = PHASE.RESULT;
      const delta = net > 0 ? `+${net}` : net < 0 ? `${net}` : '+0';
      this.message = `${text} (${delta})`;
      this.#fire('result', {
        outcome,
        reason,
        net,
        natural,
        player: scoreHand(this.playerHand).total,
        dealer: scoreHand(this.dealerHand).total,
      });
      this.#emit();
      return true;
    }

    #resetHand() {
      this.playerHand = [];
      this.dealerHand = [];
      this.holeHidden = false;
      this.bet = 0;
      this.outcome = null;
    }

    /** Draw a card into a hand and announce it. `order` staggers the opening deal. */
    #dealTo(who, order = 0) {
      const hand = who === 'player' ? this.playerHand : this.dealerHand;
      let card = this.#draw();
      // Lucky Hand: sometimes a busting card slips back under the shoe and you get the next one.
      if (who === 'player' && this.luckyHand && scoreHand([...hand, card]).total > 21 && Math.random() < LUCKY_HAND_SAVE_CHANCE) {
        this.#shoe.unshift(card);
        card = this.#draw();
      }
      hand.push(card);
      this.#fire('card', { to: who, order });
    }

    #draw() {
      // Safety net: the pre-hand threshold makes this practically unreachable
      if (this.#shoe.length === 0) this.#shoe = createShoe(CONFIG.NUM_DECKS);
      return this.#shoe.pop();
    }

    #fire(type, data = {}) {
      this.#onEvent(type, data);
    }

    #emit() {
      this.#onChange(this);
    }
  }

  /* ========================================================================
     10. BLACKJACK UI
     Renders engine state into the DOM overlay and forwards user intent
     (clicks / keys) back to the engine. Holds no game rules itself.
     ====================================================================== */

  function createBlackjackUI({ root, game, onLeave, onDenied = () => {} }) {
    const $ = (selector) => root.querySelector(selector);
    const els = {
      panel: $('.bj-panel'),
      balance: $('#bj-balance'),
      bet: $('#bj-bet'),
      message: $('#bj-message'),
      playerCards: $('#player-cards'),
      dealerCards: $('#dealer-cards'),
      playerScore: $('#player-score'),
      dealerScore: $('#dealer-score'),
      chips: [...root.querySelectorAll('.chip')],
      deal: $('#btn-deal'),
      rebuy: $('#btn-rebuy'),
      hit: $('#btn-hit'),
      stand: $('#btn-stand'),
      newHand: $('#btn-new'),
    };

    /* ----- Event wiring ----------------------------------------------- */

    els.chips.forEach((chip) => chip.addEventListener('click', () => game.selectBet(Number(chip.dataset.bet))));
    els.deal.addEventListener('click', () => game.deal());
    els.rebuy.addEventListener('click', () => game.rebuy());
    els.hit.addEventListener('click', () => game.hit());
    els.stand.addEventListener('click', () => game.stand());
    els.newHand.addEventListener('click', () => game.newHand());
    root.querySelectorAll('[data-action="leave"]').forEach((btn) => btn.addEventListener('click', requestLeave));
    els.panel.addEventListener('animationend', (event) => {
      if (event.animationName === 'panel-shake') els.panel.classList.remove('is-shaking');
    });

    function requestLeave() {
      if (game.canLeave) onLeave();
      else nudge();
    }

    /** Little shake when an action isn't allowed right now. */
    function nudge() {
      onDenied();
      els.panel.classList.remove('is-shaking');
      void els.panel.offsetWidth; // restart animation
      els.panel.classList.add('is-shaking');
    }

    /* ----- Keyboard shortcuts (only while the overlay is open) -------- */

    function handleKey(event) {
      if (event.repeat) return;
      const target = event.target;
      const onChip = target instanceof HTMLElement && target.classList.contains('chip');
      const onButton = target instanceof HTMLButtonElement;

      switch (event.code) {
        case 'Escape':
        case 'KeyE':
          event.preventDefault();
          requestLeave();
          break;
        case 'KeyH':
          game.hit();
          break;
        case 'KeyS':
          game.stand();
          break;
        case 'Enter':
        case 'NumpadEnter':
          // Let focused buttons handle Enter natively, except chips (Enter = deal)
          if (onButton && !onChip) return;
          event.preventDefault();
          if (game.phase === PHASE.BETTING) game.deal();
          else if (game.phase === PHASE.RESULT) game.newHand();
          break;
        case 'Digit1':
        case 'Digit2':
        case 'Digit3':
        case 'Digit4': {
          const amount = CONFIG.BET_OPTIONS[Number(event.code.slice(-1)) - 1];
          game.selectBet(amount);
          break;
        }
        default:
          break;
      }
    }

    /* ----- Rendering -------------------------------------------------- */

    function formatScore(cards) {
      if (cards.length === 0) return '--';
      const { total, soft } = scoreHand(cards);
      return soft && total < 21 ? `${total - 10}/${total}` : String(total);
    }

    function setCardFace(el, card, hidden) {
      const key = hidden ? 'back' : `${card.rank}-${card.suit}`;
      if (el.dataset.key === key) return;

      const wasFaceDown = el.dataset.key === 'back';
      el.dataset.key = key;
      el.classList.toggle('card--back', hidden);
      el.classList.toggle('card--red', !hidden && RED_SUITS.has(card.suit));
      el.innerHTML = hidden
        ? ''
        : `<span class="card-rank">${card.rank}</span>` +
          `<span class="card-suit-sm">${SUIT_SVG[card.suit]}</span>` +
          `<span class="card-pip">${SUIT_SVG[card.suit]}</span>`;
      el.setAttribute('aria-label', hidden ? 'Face-down card' : `${RANK_NAMES[card.rank] ?? card.rank} of ${card.suit}s`);

      if (wasFaceDown) {
        el.style.animationDelay = '';
        el.classList.remove('is-flipping');
        void el.offsetWidth;
        el.classList.add('is-flipping');
      }
    }

    /**
     * Reconcile a hand's DOM with its cards: keep existing elements (so
     * their deal animation doesn't replay), append new ones, and flip the
     * hole card when revealed.
     */
    function renderHand(container, cards, { hiddenIndex = -1, dealOffset = 0 } = {}) {
      if (cards.length < container.children.length) container.replaceChildren();

      cards.forEach((card, i) => {
        let el = container.children[i];
        if (!el) {
          el = document.createElement('div');
          el.className = 'card';
          el.setAttribute('role', 'img');
          // Stagger the opening deal: P1, D1, P2, D2
          if (i < 2) el.style.animationDelay = `${(i * 2 + dealOffset) * CONFIG.CARD_STAGGER_MS}ms`;
          container.append(el);
        }
        setCardFace(el, card, i === hiddenIndex);
      });
    }

    function render() {
      root.dataset.phase = game.phase;

      els.balance.textContent = game.balance;
      els.bet.textContent = game.phase === PHASE.BETTING ? (game.selectedBet ?? 0) : game.bet;
      els.message.textContent = game.message;
      els.message.dataset.outcome = game.outcome ?? '';

      for (const chip of els.chips) {
        const amount = Number(chip.dataset.bet);
        chip.disabled = amount > game.balance;
        chip.setAttribute('aria-pressed', String(amount === game.selectedBet));
      }
      els.deal.disabled = !game.canDeal;
      els.rebuy.hidden = !game.isBroke || game.noRebuy;

      renderHand(els.playerCards, game.playerHand, { dealOffset: 0 });
      renderHand(els.dealerCards, game.dealerHand, {
        hiddenIndex: game.holeHidden ? 1 : -1,
        dealOffset: 1,
      });

      els.playerScore.textContent = formatScore(game.playerHand);
      els.dealerScore.textContent =
        game.holeHidden && game.dealerHand.length > 0
          ? `${formatScore(game.dealerHand.slice(0, 1))}+?`
          : formatScore(game.dealerHand);
    }

    /* ----- Visibility ------------------------------------------------- */

    function open() {
      render();
      root.inert = false;
      root.setAttribute('aria-hidden', 'false');
      root.classList.add('is-open');
      // Focus the panel (not a button) so the Space keyup that opened us can't click anything
      els.panel.focus({ preventScroll: true });
    }

    function close() {
      root.classList.remove('is-open');
      root.setAttribute('aria-hidden', 'true');
      if (root.contains(document.activeElement)) document.activeElement.blur();
      root.inert = true;
    }

    return { render, open, close, handleKey };
  }

  function createCosmeticsUI({ root, getBalance, onBuy, onEquip, onClose, getState }) {
    const panel = root.querySelector('.cos-panel');
    const balanceEl = root.querySelector('#cos-balance');
    const messageEl = root.querySelector('#cos-message');
    const grid = root.querySelector('#cos-grid');
    const closeBtn = root.querySelector('#btn-cos-close');

    closeBtn?.addEventListener('click', onClose);
    root.addEventListener('click', (event) => {
      if (event.target === root) onClose();
    });

    function render() {
      const state = getState();
      balanceEl.textContent = String(getBalance());
      messageEl.textContent = state.message;
      grid.replaceChildren();

      for (const item of COSMETICS_CATALOG) {
        const row = document.createElement('div');
        row.className = 'cos-item';
        const left = document.createElement('div');
        const name = document.createElement('div');
        name.className = 'cos-item-name';
        name.textContent = item.name;
        const meta = document.createElement('div');
        meta.className = 'cos-item-meta';

        const owned = state.owned.has(item.id);
        const equipped = state.equipped[item.kind] === item.id;
        meta.textContent = owned ? (equipped ? 'Equipped' : 'Owned') : `${item.cost} tokens`;
        left.append(name, meta);

        const actions = document.createElement('div');
        actions.className = 'cos-actions';
        const actionBtn = document.createElement('button');
        actionBtn.className = 'btn';

        if (!owned) {
          actionBtn.textContent = 'Buy';
          actionBtn.disabled = getBalance() < item.cost;
          actionBtn.addEventListener('click', () => onBuy(item));
        } else if (!equipped) {
          actionBtn.textContent = 'Equip';
          actionBtn.addEventListener('click', () => onEquip(item));
        } else {
          actionBtn.textContent = 'Equipped';
          actionBtn.disabled = true;
        }

        actions.append(actionBtn);
        row.append(left, actions);
        grid.append(row);
      }
    }

    function open() {
      render();
      root.inert = false;
      root.setAttribute('aria-hidden', 'false');
      root.classList.add('is-open');
      panel?.focus({ preventScroll: true });
    }

    function close() {
      root.classList.remove('is-open');
      root.setAttribute('aria-hidden', 'true');
      if (root.contains(document.activeElement)) document.activeElement.blur();
      root.inert = true;
    }

    return { open, close, render };
  }

  function createBlackMarketUI({ root, getBalance, isOwned, onBuy, onClose }) {
    const panel = root.querySelector('.cos-panel');
    const balanceEl = root.querySelector('#bm-balance');
    const messageEl = root.querySelector('#bm-message');
    const grid = root.querySelector('#bm-grid');
    const openBtn = root.querySelector('#btn-bm-open');
    const closeBtn = root.querySelector('#btn-bm-close');
    let shopOpen = false;
    let message = '';

    closeBtn?.addEventListener('click', onClose);
    root.addEventListener('click', (event) => {
      if (event.target === root) onClose();
    });
    openBtn?.addEventListener('click', () => {
      shopOpen = true;
      message = BLACK_MARKET_STOCK.every((item) => isOwned(item.id))
        ? '"You cleaned me out, kid. Nothing left."'
        : '"Rare goods. No questions. No refunds."';
      render();
    });

    function render() {
      balanceEl.textContent = String(getBalance());
      messageEl.textContent = message;
      openBtn.hidden = shopOpen;
      grid.hidden = !shopOpen;
      grid.replaceChildren();
      if (!shopOpen) return;

      for (const item of BLACK_MARKET_STOCK) {
        const owned = isOwned(item.id);
        const row = document.createElement('div');
        row.className = 'cos-item';
        const left = document.createElement('div');
        const name = document.createElement('div');
        name.className = 'cos-item-name';
        name.textContent = item.name;
        const meta = document.createElement('div');
        meta.className = 'cos-item-meta';
        meta.textContent = owned ? `Owned · ${item.desc}` : `${item.cost} tokens · ${item.desc}`;
        left.append(name, meta);

        const actions = document.createElement('div');
        actions.className = 'cos-actions';
        const buyBtn = document.createElement('button');
        buyBtn.className = 'btn';
        buyBtn.textContent = owned ? 'Sold' : 'Buy';
        buyBtn.disabled = owned || getBalance() < item.cost;
        if (!owned) buyBtn.addEventListener('click', () => onBuy(item));
        actions.append(buyBtn);
        row.append(left, actions);
        grid.append(row);
      }
    }

    function setMessage(text) {
      message = text;
      render();
    }

    function open() {
      shopOpen = false;
      message = '"Psst... looking for something... special?"';
      render();
      root.inert = false;
      root.setAttribute('aria-hidden', 'false');
      root.classList.add('is-open');
      panel?.focus({ preventScroll: true });
    }

    function close() {
      root.classList.remove('is-open');
      root.setAttribute('aria-hidden', 'true');
      if (root.contains(document.activeElement)) document.activeElement.blur();
      root.inert = true;
    }

    return { open, close, render, setMessage };
  }

  function createLoanUI({ root, prefix, limit, getBalance, getDebt, greeting, onBorrow, onRepay, onClose }) {
    const panel = root.querySelector('.cos-panel');
    const balanceEl = root.querySelector(`#${prefix}-balance`);
    const debtEl = root.querySelector(`#${prefix}-debt`);
    const messageEl = root.querySelector(`#${prefix}-message`);
    const borrowBtn = root.querySelector(`#btn-${prefix}-borrow`);
    const repayBtn = root.querySelector(`#btn-${prefix}-repay`);
    const closeBtn = root.querySelector(`#btn-${prefix}-close`);
    let message = '';

    closeBtn?.addEventListener('click', onClose);
    borrowBtn?.addEventListener('click', onBorrow);
    repayBtn?.addEventListener('click', onRepay);
    root.addEventListener('click', (event) => {
      if (event.target === root) onClose();
    });

    function render() {
      const debt = getDebt();
      balanceEl.textContent = String(getBalance());
      debtEl.textContent = `Loan: ${debt} / ${limit}`;
      messageEl.textContent = message;
      borrowBtn.disabled = debt >= limit;
      borrowBtn.textContent = debt >= limit ? 'Loan Maxed' : `Take Loan (${limit - debt})`;
      repayBtn.disabled = debt === 0 || getBalance() < debt;
      repayBtn.textContent = debt > 0 ? `Repay (${debt})` : 'Repay';
    }

    function setMessage(text) {
      message = text;
      render();
    }

    function open() {
      message = greeting(getDebt());
      render();
      root.inert = false;
      root.setAttribute('aria-hidden', 'false');
      root.classList.add('is-open');
      panel?.focus({ preventScroll: true });
    }

    function close() {
      root.classList.remove('is-open');
      root.setAttribute('aria-hidden', 'true');
      if (root.contains(document.activeElement)) document.activeElement.blur();
      root.inert = true;
    }

    return { open, close, render, setMessage };
  }

  /* ========================================================================
     10b. TOWN 3 TABLE GAMES — five card draw poker, roulette and plinko.
     Each is a DOM overlay; tokens move through a small `wallet` facade.
     ====================================================================== */

  /** Open/close/shake behaviour shared by the town 3 game overlays. */
  function createOverlayShell(root) {
    const panel = root.querySelector('.bj-panel');
    panel.addEventListener('animationend', (event) => {
      if (event.animationName === 'panel-shake') panel.classList.remove('is-shaking');
    });
    return {
      open() {
        root.inert = false;
        root.setAttribute('aria-hidden', 'false');
        root.classList.add('is-open');
        panel.focus({ preventScroll: true });
      },
      close() {
        root.classList.remove('is-open');
        root.setAttribute('aria-hidden', 'true');
        if (root.contains(document.activeElement)) document.activeElement.blur();
        root.inert = true;
      },
      shake() {
        panel.classList.remove('is-shaking');
        void panel.offsetWidth;
        panel.classList.add('is-shaking');
      },
    };
  }

  /** Wire up a group of .chip buttons; returns a function that syncs their state. */
  function bindChips(root, onPick) {
    const chips = [...root.querySelectorAll('.chip')];
    chips.forEach((chip) => chip.addEventListener('click', () => onPick(Number(chip.dataset.bet))));
    return (selected, balance, locked = false) => {
      for (const chip of chips) {
        const amount = Number(chip.dataset.bet);
        chip.disabled = locked || amount > balance;
        chip.setAttribute('aria-pressed', String(amount === selected));
      }
    };
  }

  /** Enter on a focused (non-chip) button should click it rather than trigger a shortcut. */
  const isOnPlainButton = (event) => event.target instanceof HTMLButtonElement && !event.target.classList.contains('chip');

  const cardFaceHTML = (card) =>
    `<span class="card-rank">${card.rank}</span>` +
    `<span class="card-suit-sm">${SUIT_SVG[card.suit]}</span>` +
    `<span class="card-pip">${SUIT_SVG[card.suit]}</span>`;

  /* ----- Five card draw (Jacks or Better) -------------------------------- */

  const POKER_VALUES = Object.freeze({ 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, J: 11, Q: 12, K: 13, A: 14 });

  /** [hand, name, total returned per token bet] */
  const POKER_PAYTABLE = Object.freeze([
    ['royal', 'Royal Flush', 250],
    ['straightFlush', 'Straight Flush', 50],
    ['four', 'Four of a Kind', 25],
    ['fullHouse', 'Full House', 9],
    ['flush', 'Flush', 6],
    ['straight', 'Straight', 4],
    ['three', 'Three of a Kind', 3],
    ['twoPair', 'Two Pair', 2],
    ['jacks', 'Jacks or Better', 1],
  ]);

  /** Best paying hand for five cards, or null if it pays nothing. */
  function evaluatePokerHand(cards) {
    const values = cards.map((card) => POKER_VALUES[card.rank]).sort((a, b) => a - b);
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    const groups = [...counts.values()].sort((a, b) => b - a);
    const flush = cards.every((card) => card.suit === cards[0].suit);
    const wheel = values.join() === '2,3,4,5,14';
    const straight = counts.size === 5 && (values[4] - values[0] === 4 || wheel);

    if (straight && flush) return values[0] === 10 ? 'royal' : 'straightFlush';
    if (groups[0] === 4) return 'four';
    if (groups[0] === 3 && groups[1] === 2) return 'fullHouse';
    if (flush) return 'flush';
    if (straight) return 'straight';
    if (groups[0] === 3) return 'three';
    if (groups[0] === 2 && groups[1] === 2) return 'twoPair';
    if (groups[0] === 2) {
      const [pairValue] = [...counts.entries()].find(([, n]) => n === 2);
      if (pairValue >= 11) return 'jacks';
    }
    return null;
  }

  function createPokerUI({ root, wallet, sfx, onClose }) {
    const shell = createOverlayShell(root);
    const $ = (selector) => root.querySelector(selector);
    const els = {
      balance: $('#pk-balance'),
      bet: $('#pk-bet'),
      message: $('#pk-message'),
      cards: $('#pk-cards'),
      paytable: $('#pk-paytable'),
      deal: $('#btn-pk-deal'),
      draw: $('#btn-pk-draw'),
      newHand: $('#btn-pk-new'),
    };
    const g = { phase: 'betting', selectedBet: null, bet: 0, hand: [], held: [], deck: [], made: null, outcome: '', message: 'Jacks or Better. Place your bet!' };
    const syncChips = bindChips(root, selectBet);

    const payRows = POKER_PAYTABLE.map(([key, name]) => {
      const li = document.createElement('li');
      li.dataset.hand = key;
      li.innerHTML = `<span>${name}</span><strong></strong>`;
      els.paytable.append(li);
      return li;
    });

    const cardEls = Array.from({ length: 5 }, (_, i) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'card pk-card';
      el.addEventListener('click', () => toggleHold(i));
      els.cards.append(el);
      return el;
    });

    els.deal.addEventListener('click', deal);
    els.draw.addEventListener('click', draw);
    els.newHand.addEventListener('click', newHand);
    root.querySelectorAll('[data-action="leave"]').forEach((btn) => btn.addEventListener('click', requestLeave));

    const handName = (key) => POKER_PAYTABLE.find(([k]) => k === key)[1];
    const handPays = (key) => (key ? POKER_PAYTABLE.find(([k]) => k === key)[2] : 0);
    const canLeave = () => g.phase !== 'player';

    function deny(text) {
      if (text) g.message = text;
      sfx('denied');
      shell.shake();
      render();
    }

    function requestLeave() {
      if (canLeave()) onClose();
      else deny('Finish the hand first: hold your cards and draw.');
    }

    function selectBet(amount) {
      if (g.phase !== 'betting' || amount > wallet.balance()) return;
      g.selectedBet = amount;
      g.message = `Bet ${amount}. Ready to deal!`;
      sfx('bet');
      render();
    }

    function deal() {
      if (g.phase !== 'betting') return;
      if (g.selectedBet === null) return deny('Pick a chip first.');
      if (!wallet.spend(g.selectedBet)) return deny(`Need ${g.selectedBet} tokens.`);
      g.bet = g.selectedBet;
      g.deck = createShoe(1);
      g.hand = g.deck.splice(-5);
      g.held = [false, false, false, false, false];
      g.made = null;
      g.outcome = '';
      g.phase = 'player';
      const made = evaluatePokerHand(g.hand);
      g.message = made ? `${handName(made)}! Hold cards, then draw.` : 'Click cards to hold, then draw.';
      sfx('chips');
      for (let i = 0; i < 5; i++) sfx('cardDeal', { delay: (i * CONFIG.CARD_STAGGER_MS) / 1000 });
      render();
    }

    function toggleHold(i) {
      if (g.phase !== 'player') return;
      g.held[i] = !g.held[i];
      sfx('uiClick');
      render();
    }

    function draw() {
      if (g.phase !== 'player') return;
      let swapped = 0;
      g.hand = g.hand.map((card, i) => {
        if (g.held[i]) return card;
        sfx('cardDeal', { delay: (swapped++ * CONFIG.CARD_STAGGER_MS) / 1000 });
        return g.deck.pop();
      });
      g.made = evaluatePokerHand(g.hand);
      const payout = g.bet * handPays(g.made);
      if (payout > 0) wallet.pay(payout);
      const net = payout - g.bet;
      g.held = [false, false, false, false, false];
      g.phase = 'result';
      g.outcome = net > 0 ? 'win' : net === 0 ? 'push' : 'lose';
      g.message = g.made ? `${handName(g.made)}! Pays ${payout} (${net > 0 ? '+' : ''}${net})` : `No winning hand. (-${g.bet})`;
      const delay = (swapped * CONFIG.CARD_STAGGER_MS) / 1000 + 0.15;
      sfx(net > 0 ? (handPays(g.made) >= 25 ? 'blackjack' : 'win') : net === 0 ? 'push' : 'lose', { delay });
      render();
    }

    function newHand() {
      if (g.phase !== 'result') return;
      g.phase = 'betting';
      g.hand = [];
      g.made = null;
      g.outcome = '';
      if (g.selectedBet !== null && g.selectedBet > wallet.balance()) g.selectedBet = null;
      g.message = g.selectedBet !== null ? `Bet ${g.selectedBet} again? Ready to deal!` : 'Place your bet!';
      render();
    }

    function renderCards() {
      let dealt = 0;
      cardEls.forEach((el, i) => {
        const card = g.hand[i];
        const key = card ? `${card.rank}-${card.suit}` : 'back';
        if (el.dataset.key !== key) {
          el.dataset.key = key;
          el.classList.toggle('card--back', !card);
          el.classList.toggle('card--red', Boolean(card) && RED_SUITS.has(card.suit));
          el.innerHTML = card ? cardFaceHTML(card) : '';
          el.setAttribute('aria-label', card ? `${RANK_NAMES[card.rank] ?? card.rank} of ${card.suit}s` : 'Face-down card');
          el.style.animation = 'none';
          void el.offsetWidth;
          el.style.animation = '';
          el.style.animationDelay = `${dealt++ * CONFIG.CARD_STAGGER_MS}ms`;
        }
        el.disabled = g.phase !== 'player';
        el.classList.toggle('is-held', Boolean(g.held[i]));
        el.setAttribute('aria-pressed', String(Boolean(g.held[i])));
      });
    }

    function render() {
      const balance = wallet.balance();
      root.dataset.phase = g.phase;
      els.balance.textContent = balance;
      els.bet.textContent = g.phase === 'betting' ? (g.selectedBet ?? 0) : g.bet;
      els.message.textContent = g.message;
      els.message.dataset.outcome = g.outcome;
      syncChips(g.selectedBet, balance, g.phase !== 'betting');
      els.deal.disabled = g.phase !== 'betting' || g.selectedBet === null || g.selectedBet > balance;

      const perToken = g.phase === 'betting' ? (g.selectedBet ?? CONFIG.BET_OPTIONS[0]) : g.bet;
      payRows.forEach((li, i) => {
        li.querySelector('strong').textContent = POKER_PAYTABLE[i][2] * perToken;
        li.classList.toggle('is-hit', g.phase === 'result' && g.made === li.dataset.hand);
      });
      renderCards();
    }

    function handleKey(event) {
      if (event.repeat) return;
      switch (event.code) {
        case 'Escape':
        case 'KeyE':
          event.preventDefault();
          requestLeave();
          break;
        case 'Enter':
        case 'NumpadEnter':
          if (isOnPlainButton(event)) return;
          event.preventDefault();
          if (g.phase === 'betting') deal();
          else if (g.phase === 'player') draw();
          else newHand();
          break;
        default: {
          const digit = /^Digit([1-5])$/.exec(event.code)?.[1];
          if (!digit) break;
          if (g.phase === 'player') toggleHold(Number(digit) - 1);
          else if (g.phase === 'betting' && CONFIG.BET_OPTIONS[Number(digit) - 1]) selectBet(CONFIG.BET_OPTIONS[Number(digit) - 1]);
          break;
        }
      }
    }

    function open() {
      render();
      shell.open();
    }

    function close() {
      if (g.phase === 'result') newHand();
      shell.close();
    }

    return { open, close, render, handleKey, canLeave };
  }

  /* ----- Roulette (single zero) ------------------------------------------ */

  const ROULETTE_WHEEL = Object.freeze([
    0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
  ]);
  const ROULETTE_REDS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
  const ROULETTE_SPIN_SECONDS = 4.6;
  const rouletteColor = (n) => (n === 0 ? 'green' : ROULETTE_REDS.has(n) ? 'red' : 'black');

  /** Outside bets; `pays` is the total returned per token (stake included). A single number pays 36 (35:1). */
  const ROULETTE_BETS = Object.freeze({
    low: { label: '1-18', pays: 2, col: 2, row: 5, span: 2, wins: (n) => n >= 1 && n <= 18 },
    even: { label: 'EVEN', pays: 2, col: 4, row: 5, span: 2, wins: (n) => n > 0 && n % 2 === 0 },
    red: { label: 'RED', pays: 2, col: 6, row: 5, span: 2, wins: (n) => ROULETTE_REDS.has(n) },
    black: { label: 'BLACK', pays: 2, col: 8, row: 5, span: 2, wins: (n) => n > 0 && !ROULETTE_REDS.has(n) },
    odd: { label: 'ODD', pays: 2, col: 10, row: 5, span: 2, wins: (n) => n % 2 === 1 },
    high: { label: '19-36', pays: 2, col: 12, row: 5, span: 2, wins: (n) => n >= 19 },
    d1: { label: '1st 12', pays: 3, col: 2, row: 4, span: 4, wins: (n) => n >= 1 && n <= 12 },
    d2: { label: '2nd 12', pays: 3, col: 6, row: 4, span: 4, wins: (n) => n >= 13 && n <= 24 },
    d3: { label: '3rd 12', pays: 3, col: 10, row: 4, span: 4, wins: (n) => n >= 25 },
  });

  function rouletteBet(target) {
    if (ROULETTE_BETS[target]) return ROULETTE_BETS[target];
    const n = Number(target);
    return { label: String(n), pays: 36, wins: (x) => x === n };
  }

  function createRouletteUI({ root, wallet, sfx, onClose }) {
    const shell = createOverlayShell(root);
    const $ = (selector) => root.querySelector(selector);
    const els = { balance: $('#rl-balance'), message: $('#rl-message'), board: $('#rl-board'), spin: $('#btn-rl-spin'), canvas: $('#rl-wheel') };
    const ctx = els.canvas.getContext('2d');
    const SIZE = els.canvas.width;
    const C = SIZE / 2;
    const STEP = (Math.PI * 2) / ROULETTE_WHEEL.length;
    const g = { selectedBet: null, target: null, spin: null, wheel: 0, ball: null, restIdx: null, lastNumber: null, lastTime: 0, outcome: '', message: 'Pick a spot on the layout, choose a chip and spin!' };
    const syncChips = bindChips(root, selectBet);

    // Build the betting layout: 0 down the left, numbers in three rows, dozens and even-money bets below.
    const cells = [];
    const addCell = (target, label, color, col, row, span = 1, rows = 1) => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'rl-cell';
      cell.dataset.target = target;
      cell.dataset.color = color;
      cell.textContent = label;
      cell.style.gridColumn = `${col} / span ${span}`;
      cell.style.gridRow = `${row} / span ${rows}`;
      cell.addEventListener('click', () => pickTarget(target));
      els.board.append(cell);
      cells.push(cell);
    };
    addCell('0', '0', 'green', 1, 1, 1, 3);
    for (let c = 0; c < 12; c++) {
      for (let r = 0; r < 3; r++) {
        const n = c * 3 + (3 - r);
        addCell(String(n), String(n), rouletteColor(n), c + 2, r + 1);
      }
    }
    for (const [key, bet] of Object.entries(ROULETTE_BETS)) addCell(key, bet.label, key === 'red' || key === 'black' ? key : 'outside', bet.col, bet.row, bet.span);

    els.spin.addEventListener('click', spin);
    root.querySelectorAll('[data-action="leave"]').forEach((btn) => btn.addEventListener('click', requestLeave));

    const canLeave = () => !g.spin;

    function deny(text) {
      if (text) g.message = text;
      g.outcome = '';
      sfx('denied');
      shell.shake();
      render();
    }

    function requestLeave() {
      if (canLeave()) onClose();
      else deny('Wait for the ball to land.');
    }

    function describeBet() {
      if (g.target === null) return g.selectedBet !== null ? `Chip: ${g.selectedBet}. Now pick a spot on the layout.` : 'Pick a spot on the layout.';
      const bet = rouletteBet(g.target);
      if (g.selectedBet === null) return `Betting on ${bet.label}. Pick a chip.`;
      return `${g.selectedBet} on ${bet.label} (pays ${bet.pays - 1}:1). Spin!`;
    }

    function pickTarget(target) {
      if (g.spin) return;
      g.target = target;
      g.outcome = '';
      g.message = describeBet();
      sfx('uiClick');
      render();
    }

    function selectBet(amount) {
      if (g.spin || amount > wallet.balance()) return;
      g.selectedBet = amount;
      g.outcome = '';
      g.message = describeBet();
      sfx('bet');
      render();
    }

    function spin() {
      if (g.spin) return;
      if (g.target === null || g.selectedBet === null) return deny(describeBet());
      if (!wallet.spend(g.selectedBet)) return deny(`Need ${g.selectedBet} tokens.`);

      const now = performance.now() / 1000;
      const idx = Math.floor(Math.random() * ROULETTE_WHEEL.length);
      const wheelTravel = Math.PI * 2 * (2 + Math.random());
      const ballFrom = g.ball?.angle ?? -Math.PI / 2;
      const ballTarget = g.wheel + wheelTravel + idx * STEP;
      const loop = Math.PI * 2;
      const ballTravel = ((((ballTarget - ballFrom) % loop) + loop) % loop) - loop * 5;
      g.spin = { start: now, idx, bet: g.selectedBet, target: g.target, wheelFrom: g.wheel, wheelTravel, ballFrom, ballTravel, nextTick: now + 0.3 };
      g.restIdx = null;
      g.lastNumber = null;
      g.outcome = '';
      g.message = 'No more bets...';
      sfx('chips');
      render();
    }

    function settle() {
      const { idx, bet, target } = g.spin;
      const n = ROULETTE_WHEEL[idx];
      const placed = rouletteBet(target);
      const won = placed.wins(n);
      const payout = won ? bet * placed.pays : 0;
      if (payout > 0) wallet.pay(payout);
      g.spin = null;
      g.restIdx = idx;
      g.lastNumber = n;
      g.outcome = won ? 'win' : 'lose';
      const call = `${n} ${rouletteColor(n).toUpperCase()}!`;
      g.message = won ? `${call} ${placed.label} wins ${payout} (+${payout - bet})` : `${call} ${placed.label} loses. (-${bet})`;
      if (g.selectedBet !== null && g.selectedBet > wallet.balance()) g.selectedBet = null;
      sfx('reelStop');
      sfx(won ? (placed.pays >= 36 ? 'blackjack' : 'win') : 'lose', { delay: 0.25 });
      render();
    }

    function disc(r, color) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(C, C, r, 0, Math.PI * 2);
      ctx.fill();
    }

    function drawWheel() {
      ctx.clearRect(0, 0, SIZE, SIZE);
      disc(47, '#1b1024');
      disc(46, '#7a4a2a');
      disc(43, '#4a2a1a');
      disc(41, '#2a1a12');
      ctx.strokeStyle = '#c28d3a';
      ctx.lineWidth = 1;
      ROULETTE_WHEEL.forEach((n, i) => {
        const a0 = g.wheel + (i - 0.5) * STEP;
        ctx.fillStyle = n === 0 ? '#38b764' : ROULETTE_REDS.has(n) ? '#b13e53' : '#1b1024';
        ctx.beginPath();
        ctx.arc(C, C, 35, a0, a0 + STEP);
        ctx.arc(C, C, 25, a0 + STEP, a0, true);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(C + Math.cos(a0) * 25, C + Math.sin(a0) * 25);
        ctx.lineTo(C + Math.cos(a0) * 35, C + Math.sin(a0) * 35);
        ctx.stroke();
      });
      disc(25, '#c28d3a');
      disc(23, '#7a4a2a');
      disc(16, '#a0663a');
      ctx.strokeStyle = '#ffcd75';
      ctx.lineWidth = 2;
      for (let i = 0; i < 4; i++) {
        const a = g.wheel + (i * Math.PI) / 2;
        ctx.beginPath();
        ctx.moveTo(C + Math.cos(a) * 4, C + Math.sin(a) * 4);
        ctx.lineTo(C + Math.cos(a) * 14, C + Math.sin(a) * 14);
        ctx.stroke();
      }
      disc(5, '#ffcd75');
      if (g.ball) {
        const bx = C + Math.cos(g.ball.angle) * g.ball.radius;
        const by = C + Math.sin(g.ball.angle) * g.ball.radius;
        ctx.fillStyle = '#f4ecd8';
        ctx.beginPath();
        ctx.arc(bx, by, 2.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(Math.round(bx - 1), Math.round(by - 2), 1, 1);
      }
    }

    /** Called every frame while the table is open. */
    function update(now) {
      const dt = Math.min(0.05, Math.max(0, now - (g.lastTime || now)));
      g.lastTime = now;
      const s = g.spin;
      if (s) {
        const u = clamp((now - s.start) / ROULETTE_SPIN_SECONDS, 0, 1);
        g.wheel = s.wheelFrom + s.wheelTravel * (1 - (1 - u) ** 3);
        const drop = clamp((u - 0.6) / 0.4, 0, 1);
        const radius = 30 + 8 * (1 - drop) ** 2 * Math.abs(Math.cos(drop * Math.PI * 2.5));
        g.ball = { angle: s.ballFrom + s.ballTravel * (1 - (1 - u) ** 2.4), radius };
        if (u > 0.5 && now >= s.nextTick) {
          sfx('reelTick');
          s.nextTick = now + 0.05 + (u - 0.5) * 0.5;
        }
        if (u >= 1) settle();
      } else {
        g.wheel += dt * 0.4;
        if (g.restIdx !== null) g.ball = { angle: g.wheel + g.restIdx * STEP, radius: 30 };
      }
      drawWheel();
    }

    function render() {
      const balance = wallet.balance();
      const spinning = Boolean(g.spin);
      root.dataset.phase = spinning ? 'dealer' : 'betting';
      els.balance.textContent = balance;
      els.message.textContent = g.message;
      els.message.dataset.outcome = g.outcome;
      syncChips(g.selectedBet, balance, spinning);
      els.spin.disabled = spinning || g.target === null || g.selectedBet === null || g.selectedBet > balance;
      for (const cell of cells) {
        cell.disabled = spinning;
        cell.classList.toggle('is-selected', cell.dataset.target === g.target);
        cell.classList.toggle('is-hit', g.lastNumber !== null && cell.dataset.target === String(g.lastNumber));
      }
    }

    function handleKey(event) {
      if (event.repeat) return;
      if (event.code === 'Escape' || event.code === 'KeyE') {
        event.preventDefault();
        requestLeave();
      } else if (event.code === 'Enter' || event.code === 'NumpadEnter') {
        if (isOnPlainButton(event)) return;
        event.preventDefault();
        spin();
      } else {
        const digit = /^Digit([1-4])$/.exec(event.code)?.[1];
        if (digit) selectBet(CONFIG.BET_OPTIONS[Number(digit) - 1]);
      }
    }

    function open() {
      g.lastTime = 0;
      render();
      drawWheel();
      shell.open();
    }

    return { open, close: shell.close, render, update, handleKey, canLeave };
  }

  /* ----- Plinko ---------------------------------------------------------- */

  const PLINKO_ROWS = 8;
  const PLINKO_MULTIPLIERS = Object.freeze([13, 3, 1.3, 0.7, 0.4, 0.7, 1.3, 3, 13]);
  const PLINKO_COLORS = Object.freeze(['#a7f070', '#38b764', '#ffcd75', '#ef7d57', '#b13e53']); // by distance from the middle
  const PLINKO_STEP_SECONDS = 0.17;
  const PLINKO_MAX_BALLS = 8;
  const PLINKO_GEOM = Object.freeze({ cx: 80, top: 14, rowGap: 12, half: 8, bucketY: 108, landY: 112 });

  const plinkoPegX = (row, j) => PLINKO_GEOM.cx + (2 * j - row - 2) * PLINKO_GEOM.half;
  const plinkoPegY = (row) => PLINKO_GEOM.top + row * PLINKO_GEOM.rowGap;
  const plinkoBucketX = (b) => PLINKO_GEOM.cx + (2 * b - PLINKO_ROWS) * PLINKO_GEOM.half;

  function createPlinkoUI({ root, wallet, sfx, onClose }) {
    const shell = createOverlayShell(root);
    const $ = (selector) => root.querySelector(selector);
    const els = { balance: $('#pl-balance'), bet: $('#pl-bet'), message: $('#pl-message'), drop: $('#btn-pl-drop'), canvas: $('#pl-board') };
    const ctx = els.canvas.getContext('2d');
    const g = { selectedBet: null, balls: [], pegFlash: new Map(), bucketFlash: [], outcome: '', message: 'Pick a chip and drop a ball!' };
    const syncChips = bindChips(root, selectBet);

    els.drop.addEventListener('click', drop);
    root.querySelectorAll('[data-action="leave"]').forEach((btn) => btn.addEventListener('click', requestLeave));

    const canLeave = () => g.balls.length === 0;

    function deny(text) {
      if (text) g.message = text;
      g.outcome = '';
      sfx('denied');
      shell.shake();
      render();
    }

    function requestLeave() {
      if (canLeave()) onClose();
      else deny('Wait for your balls to land.');
    }

    function selectBet(amount) {
      if (amount > wallet.balance()) return;
      g.selectedBet = amount;
      g.outcome = '';
      g.message = `${amount} per ball. Drop it!`;
      sfx('bet');
      render();
    }

    function drop() {
      if (g.selectedBet === null) return deny('Pick a chip first.');
      if (g.balls.length >= PLINKO_MAX_BALLS) return deny('Let a few land first!');
      if (!wallet.spend(g.selectedBet)) return deny(`Need ${g.selectedBet} tokens.`);

      // Each row knocks the ball left or right; the bucket is the number of rights.
      const points = [{ x: PLINKO_GEOM.cx, y: 2 }];
      let rights = 0;
      const pegs = [];
      for (let row = 0; row < PLINKO_ROWS; row++) {
        pegs.push({ row, j: rights + 1 });
        points.push({ x: PLINKO_GEOM.cx + (2 * rights - row) * PLINKO_GEOM.half, y: plinkoPegY(row) - 3 });
        if (Math.random() < 0.5) rights++;
      }
      points.push({ x: plinkoBucketX(rights), y: PLINKO_GEOM.landY });
      g.balls.push({ start: performance.now() / 1000, points, pegs, bucket: rights, bet: g.selectedBet, reached: 0 });
      sfx('chips');
      render();
    }

    function land(ball, now) {
      const mult = PLINKO_MULTIPLIERS[ball.bucket];
      const payout = Math.floor(ball.bet * mult);
      if (payout > 0) wallet.pay(payout);
      const net = payout - ball.bet;
      g.bucketFlash[ball.bucket] = now;
      g.outcome = net > 0 ? 'win' : net === 0 ? 'push' : 'lose';
      g.message = `${mult}x! ${payout} back (${net > 0 ? '+' : ''}${net})`;
      if (g.selectedBet !== null && g.selectedBet > wallet.balance()) g.selectedBet = null;
      sfx(mult >= 3 ? 'win' : mult > 1 ? 'payout' : 'reelStop');
      render();
    }

    function ballPosition(ball, now) {
      const e = (now - ball.start) / PLINKO_STEP_SECONDS;
      const k = Math.min(Math.floor(e), ball.points.length - 2);
      const u = Math.min(1, e - k);
      const a = ball.points[k];
      const b = ball.points[k + 1];
      const y = k === 0 ? a.y + (b.y - a.y) * u * u : a.y + (b.y - a.y) * u * u - 6 * u * (1 - u);
      return { x: a.x + (b.x - a.x) * u, y };
    }

    function drawBoard(now) {
      ctx.fillStyle = '#140c22';
      ctx.fillRect(0, 0, els.canvas.width, els.canvas.height);
      ctx.fillStyle = '#1d1230';
      ctx.fillRect(0, 0, els.canvas.width, 6);

      for (let row = 0; row < PLINKO_ROWS; row++) {
        for (let j = 0; j < row + 3; j++) {
          const x = plinkoPegX(row, j);
          const y = plinkoPegY(row);
          const lit = now - (g.pegFlash.get(`${row}:${j}`) ?? -9) < 0.18;
          if (lit) {
            ctx.fillStyle = 'rgba(255, 205, 117, 0.35)';
            ctx.fillRect(x - 3, y - 3, 6, 6);
          }
          ctx.fillStyle = lit ? '#ffcd75' : '#94b0c2';
          ctx.fillRect(x - 1, y - 1, 2, 2);
        }
      }

      PLINKO_MULTIPLIERS.forEach((mult, b) => {
        const x = plinkoBucketX(b);
        const hit = now - (g.bucketFlash[b] ?? -9) < 0.35;
        const y = PLINKO_GEOM.bucketY + (hit ? 2 : 0);
        ctx.fillStyle = hit ? '#f4ecd8' : PLINKO_COLORS[Math.abs(b - PLINKO_ROWS / 2)];
        ctx.fillRect(x - 7, y, 14, 12);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
        ctx.fillRect(x - 7, y + 10, 14, 2);
        Renderer.pixelText(ctx, String(mult), x, y + 3, '#1b1024', 1, 'center');
      });

      for (const ball of g.balls) {
        const { x, y } = ballPosition(ball, now);
        const bx = Math.round(x);
        const by = Math.round(y);
        ctx.fillStyle = '#c28d3a';
        ctx.fillRect(bx - 1, by - 2, 2, 4);
        ctx.fillRect(bx - 2, by - 1, 4, 2);
        ctx.fillStyle = '#ffcd75';
        ctx.fillRect(bx - 1, by - 1, 2, 2);
      }
    }

    /** Called every frame while the machine is open. */
    function update(now) {
      let ticked = false;
      for (const ball of g.balls) {
        const reached = Math.floor((now - ball.start) / PLINKO_STEP_SECONDS);
        while (ball.reached < reached && ball.reached < ball.pegs.length) {
          const peg = ball.pegs[ball.reached++];
          g.pegFlash.set(`${peg.row}:${peg.j}`, now);
          if (!ticked) sfx('reelTick');
          ticked = true;
        }
        if (reached >= ball.points.length - 1) ball.landed = true;
      }
      const landed = g.balls.filter((ball) => ball.landed);
      if (landed.length) {
        g.balls = g.balls.filter((ball) => !ball.landed);
        for (const ball of landed) land(ball, now);
      }
      drawBoard(now);
    }

    function render() {
      const balance = wallet.balance();
      root.dataset.phase = 'betting';
      els.balance.textContent = balance;
      els.bet.textContent = g.selectedBet ?? 0;
      els.message.textContent = g.message;
      els.message.dataset.outcome = g.outcome;
      syncChips(g.selectedBet, balance);
      els.drop.disabled = g.selectedBet === null || g.selectedBet > balance;
    }

    function handleKey(event) {
      if (event.repeat) return;
      if (event.code === 'Escape' || event.code === 'KeyE') {
        event.preventDefault();
        requestLeave();
      } else if (event.code === 'Enter' || event.code === 'NumpadEnter' || event.code === 'Space') {
        if (isOnPlainButton(event)) return;
        event.preventDefault();
        drop();
      } else {
        const digit = /^Digit([1-4])$/.exec(event.code)?.[1];
        if (digit) selectBet(CONFIG.BET_OPTIONS[Number(digit) - 1]);
      }
    }

    function open() {
      render();
      drawBoard(performance.now() / 1000);
      shell.open();
    }

    return { open, close: shell.close, render, update, handleKey, canLeave };
  }

  /* ========================================================================
     11. GAME CONTROLLER & MAIN LOOP
     ====================================================================== */

  const MODE = Object.freeze({ OVERWORLD: 'overworld', BLACKJACK: 'blackjack', COSMETICS: 'cosmetics', SLOTS: 'slots', BLACKMARKET: 'blackmarket', BANK: 'bank', SHARK: 'shark', CUTSCENE: 'cutscene', POKER: 'poker', ROULETTE: 'roulette', PLINKO: 'plinko' });
  const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

  function main() {
    const dom = {
      canvas: document.getElementById('game-canvas'),
      hudTokens: document.getElementById('hud-tokens'),
      hudBalance: document.getElementById('hud-balance'),
      prompt: document.getElementById('interact-prompt'),
      overlay: document.getElementById('blackjack'),
      cosmetics: document.getElementById('cosmetics'),
      blackMarket: document.getElementById('blackmarket'),
      bank: document.getElementById('bank'),
      shark: document.getElementById('shark'),
      poker: document.getElementById('poker'),
      roulette: document.getElementById('roulette'),
      plinko: document.getElementById('plinko'),
      help: document.getElementById('help'),
      songSelect: document.getElementById('song-select'),
      songValue: document.getElementById('song-value'),
      songCycle: document.getElementById('btn-song-cycle'),
    };

    const state = {
      mode: MODE.OVERWORLD,
      nearDealer: false,
      nearSlotMachine: false,
      nearStation: false,
      casinoTarget: null, // nearest casino game in reach: { kind, center, bubble?, prop? }
      nearCosmeticsClerk: false,
      nearBlackMarketDealer: false,
      nearBankTeller: false,
      loanDebt: 0,
      backroomOpen: false, // the bank's secret door, once you're maxed out and can't pay
      backroomAnnounced: false,
      nearShark: false,
      sharkDebt: 0,
      cutscene: null, // { startedAt, fired } while the robbery plays
      promptVisible: false,
      promptText: '',
      areaType: 'casino',
      townIndex: 1,
      maxUnlockedTown: 1,
      collapsedTunnels: new Set(), // towns whose tunnel back has caved in
      collapse: null, // { town, startedAt, announced } while the cave-in plays
      cameraX: 0,
      train: { active: false, worldX: 0, vx: 0, direction: 1, phase: 'idle', stationKey: 'left', timer: 0, fade: 0, destinationTown: 1 },
    };

    const GENERIC_SHOP_ROOM = Object.freeze({ x: 8, y: 20, w: 304, h: 212 });
    // Back wall plus the counter (x50,y58,w220,h20): nobody walks behind the desk.
    const SHOP_BACK_WALL = Object.freeze({ x: 8, y: 20, w: 304, h: 58 });
    const GENERIC_SHOP_SPAWN = Object.freeze({ x: 154, y: 194 });
    // Floor fixtures drawn in drawInteriorDecor (town 1 interiors).
    const SHOP_FLOOR_FIXTURES = Object.freeze({
      bakery: [{ x: 24, y: 80, w: 90, h: 18 }, { x: 246, y: 82, w: 44, h: 22 }],
      supermarket: [],
      toy: [{ x: 22, y: 80, w: 94, h: 24 }, { x: 248, y: 80, w: 44, h: 24 }],
      restaurant: [{ x: 24, y: 80, w: 118, h: 24 }, { x: 246, y: 80, w: 44, h: 24 }],
      electronics: [{ x: 28, y: 80, w: 48, h: 24 }, { x: 96, y: 80, w: 48, h: 24 }, { x: 224, y: 80, w: 48, h: 24 }],
      gift: [{ x: 28, y: 80, w: 92, h: 24 }, { x: 246, y: 80, w: 44, h: 24 }],
      butcher: [{ x: 26, y: 80, w: 96, h: 24 }, { x: 246, y: 80, w: 44, h: 24 }],
      fishing: [{ x: 24, y: 80, w: 108, h: 24 }, { x: 246, y: 80, w: 44, h: 24 }],
    });

    /** remodeled: in town 2+ this store is the Bank / Black Market, which have no floor fixtures. */
    function genericShopArea(id, remodeled = false) {
      return Object.freeze({
        room: GENERIC_SHOP_ROOM,
        colliders: [SHOP_BACK_WALL, ...SHOP_FLOOR_FIXTURES[id]],
        remodeledColliders: remodeled ? [SHOP_BACK_WALL] : null,
        spawn: GENERIC_SHOP_SPAWN,
      });
    }

    /** Storefront walls, the rails between the two platforms, and street furniture. */
    function townColliders() {
      const W = TOWN_WORLD.width;
      const { stationLeft: left, stationRight: right } = TOWN_WORLD;
      const walkY = 82;
      const trackY = 112;
      const fountainX = Math.floor(W / 2);
      const lamp = (x, baseY) => ({ x: x - 3, y: baseY - 3, w: 6, h: 5 });
      const bench = (x, y) => ({ x, y: y - 4, w: 16, h: 11 });
      const list = [
        { x: 8, y: 20, w: W - 16, h: 56 }, // buildings (door triggers at y74-82 stay reachable)
        { x: left.x + left.w, y: trackY, w: right.x - (left.x + left.w), h: 30 }, // rails: cross on the platforms
        lamp(44, walkY),
        lamp(W - 44, walkY),
        { x: fountainX - 20, y: 180, w: 40, h: 14 },
        { x: fountainX - 88, y: 203, w: 14, h: 7 },
        { x: fountainX + 74, y: 203, w: 14, h: 7 },
        lamp(fountainX - 118, 160),
        lamp(fountainX + 118, 160),
        bench(fountainX - 38, 210),
        bench(fountainX + 24, 210),
      ];
      for (let i = 0; i < STORE_DEFS.length - 1; i++) {
        const gapX = STORE_DEFS[i].x + STORE_DEFS[i].w + STORE_GAP / 2;
        list.push(i % 2 === 0 ? lamp(gapX, walkY) : bench(gapX - 8, walkY + 20));
      }
      for (const { x, w } of [left, right]) {
        list.push(
          { x: x + 8, y: trackY - 8, w: 4, h: 4 }, // canopy posts
          { x: x + w - 12, y: trackY - 8, w: 4, h: 4 },
          { x: x + 16, y: trackY - 10, w: 12, h: 6 }, // poster kiosk
          bench(x + w / 2 - 8, trackY - 10),
        );
      }
      return list;
    }

    const AREAS = Object.freeze({
      casino: Object.freeze({ room: { x: 8, y: 40, w: 304, h: 192 }, colliders: COLLIDERS, spawn: { x: 154, y: 196 } }),
      town: Object.freeze({
        room: { x: 8, y: 20, w: TOWN_WORLD.width - 16, h: 212 },
        colliders: [
          { x: 8, y: 229, w: TOWN_WORLD.width - 16, h: 3 },
          { x: 8, y: 20, w: 3, h: 212 },
          { x: TOWN_WORLD.width - 11, y: 20, w: 3, h: 212 },
          ...townColliders(),
        ],
        spawn: { x: STORE_DEFS[0].x + STORE_DEFS[0].w / 2, y: 150 },
      }),
      cosmetics: Object.freeze({
        room: { x: 8, y: 20, w: 304, h: 212 },
        // Back wall, side displays and the counter: the clerk's side is off limits.
        colliders: [{ x: 8, y: 20, w: 304, h: 96 }, { x: 54, y: 116, w: 212, h: 12 }],
        spawn: { x: 154, y: 194 },
      }),
      butcher: genericShopArea('butcher', true),
      fishing: genericShopArea('fishing', true),
      bakery: genericShopArea('bakery'),
      supermarket: genericShopArea('supermarket'),
      toy: genericShopArea('toy'),
      restaurant: genericShopArea('restaurant'),
      electronics: genericShopArea('electronics'),
      gift: genericShopArea('gift'),
      backroom: Object.freeze({
        room: GENERIC_SHOP_ROOM,
        colliders: [
          { x: 8, y: 20, w: 304, h: 60 }, // back wall + the shark's desk
          { x: 22, y: 20, w: 52, h: 70 }, // crates
          { x: 260, y: 20, w: 32, h: 70 }, // safe
        ],
        spawn: GENERIC_SHOP_SPAWN,
      }),
    });

    function defaultProgress() {
      return {
        owned: ['hat-none', 'outfit-classic', 'song-townBreeze'],
        equipped: { hat: 'hat-none', outfit: 'outfit-classic', song: 'song-townBreeze' },
        relics: [],
      };
    }

    function loadProgress() {
      try {
        const parsed = JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? 'null');
        if (!parsed || typeof parsed !== 'object') return defaultProgress();
        const base = defaultProgress();
        const owned = new Set(base.owned);
        if (Array.isArray(parsed.owned)) {
          for (const id of parsed.owned) {
            if (COSMETICS_CATALOG.some((item) => item.id === id)) owned.add(id);
          }
        }
        const equipped = { ...base.equipped };
        if (parsed.equipped && typeof parsed.equipped === 'object') {
          for (const key of ['hat', 'outfit', 'song']) {
            if (typeof parsed.equipped[key] === 'string' && owned.has(parsed.equipped[key])) equipped[key] = parsed.equipped[key];
          }
        }
        const relics = Array.isArray(parsed.relics)
          ? BLACK_MARKET_STOCK.filter((item) => parsed.relics.includes(item.id)).map((item) => item.id)
          : [];
        return { owned: [...owned], equipped, relics };
      } catch {
        return defaultProgress();
      }
    }

    function saveProgress(progress) {
      try {
        localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
      } catch {
        /* ignore storage failures */
      }
    }

    const progress = loadProgress();
    appearanceState.hat = progress.equipped.hat;
    appearanceState.outfit = progress.equipped.outfit;
    state.relics = progress.relics; // read by the renderer (shelf + slot extension)
    const hasRelic = (id) => progress.relics.includes(id);

    let lastBalance = CONFIG.STARTING_BALANCE;
    let ui = null;
    let cosmeticsUI = null;
    let blackMarketUI = null;
    let bankUI = null;
    let sharkUI = null;
    let pokerUI = null;
    let rouletteUI = null;
    let plinkoUI = null;
    let robberyArmedAt = 0;
    let hasVisitedTable = false;
    let lastStepIndex = 0;
    let cosmeticMessage = 'Buy and equip styles and area songs.';

    const blackjack = new BlackjackGame({
      startingBalance: CONFIG.STARTING_BALANCE,
      onChange: (game) => {
        ui?.render();
        cosmeticsUI?.render();
        blackMarketUI?.render();
        bankUI?.render();
        sharkUI?.render();
        pokerUI?.render();
        rouletteUI?.render();
        plinkoUI?.render();
        updateHudBalance(game.balance);
      },
      onEvent: handleGameEvent,
    });
    blackjack.luckyHand = hasRelic('hand');

    ui = createBlackjackUI({
      root: dom.overlay,
      game: blackjack,
      onLeave: closeBlackjack,
      onDenied: () => sound.sfx.play('denied'),
    });

    cosmeticsUI = createCosmeticsUI({
      root: dom.cosmetics,
      getBalance: () => blackjack.balance,
      getState: () => ({
        owned: new Set(progress.owned),
        equipped: progress.equipped,
        message: cosmeticMessage,
      }),
      onBuy(item) {
        if (progress.owned.includes(item.id)) return;
        if (!blackjack.spendTokens(item.cost)) {
          cosmeticMessage = `Need ${item.cost} tokens.`;
          sound.sfx.play('denied');
          cosmeticsUI.render();
          return;
        }
        progress.owned.push(item.id);
        cosmeticMessage = `Bought ${item.name}.`;
        sound.sfx.play('payout');
        if (item.kind === 'song') syncSongSelect(true);
        saveProgress(progress);
        cosmeticsUI.render();
      },
      onEquip(item) {
        if (!progress.owned.includes(item.id)) return;
        progress.equipped[item.kind] = item.id;
        if (item.kind === 'hat') appearanceState.hat = item.id;
        if (item.kind === 'outfit') appearanceState.outfit = item.id;
        if (item.kind === 'song') syncSongSelect(false);
        cosmeticMessage = `Equipped ${item.name}.`;
        sound.sfx.play('uiClick');
        applyAreaMusicTheme();
        saveProgress(progress);
        cosmeticsUI.render();
      },
      onClose: closeCosmetics,
    });

    blackMarketUI = createBlackMarketUI({
      root: dom.blackMarket,
      getBalance: () => blackjack.balance,
      isOwned: hasRelic,
      onBuy(item) {
        if (hasRelic(item.id)) return;
        if (!blackjack.spendTokens(item.cost)) {
          blackMarketUI.setMessage(`"Need ${item.cost} tokens. I don't do credit."`);
          sound.sfx.play('denied');
          return;
        }
        progress.relics.push(item.id);
        if (item.id === 'hand') blackjack.luckyHand = true;
        saveProgress(progress);
        const lines = {
          clover: '"The clover. Those machines won\'t know what hit \'em."',
          plus: '"The Golden Plus. Your slot\'s got an extra reel now. Don\'t ask how."',
          hand: '"The Lucky Hand. Keep it close at the table... it keeps you from going bust."',
        };
        blackMarketUI.setMessage(lines[item.id] ?? `"${item.name}. Pleasure doing business."`);
        sound.sfx.play('payout');
      },
      onClose: closeBlackMarket,
    });

    bankUI = createLoanUI({
      root: dom.bank,
      prefix: 'bank',
      limit: LOAN_LIMIT,
      getBalance: () => blackjack.balance,
      getDebt: () => state.loanDebt,
      greeting(debt) {
        if (debt === 0) return `"Welcome to the Bank. We can lend you up to ${LOAN_LIMIT} tokens."`;
        if (state.backroomOpen && state.sharkDebt === 0) {
          return '"We can\'t lend you another token... but the gentleman in the back room might. The door\'s open."';
        }
        return '"Welcome back. Here to settle up?"';
      },
      onBorrow() {
        const amount = LOAN_LIMIT - state.loanDebt;
        if (amount <= 0) {
          bankUI.setMessage(`"Sorry, ${LOAN_LIMIT} is the most we can lend you."`);
          sound.sfx.play('denied');
          return;
        }
        state.loanDebt += amount;
        blackjack.addTokens(amount);
        bankUI.setMessage(`"Here's ${amount} tokens. Don't lose it all in one place."`);
        sound.sfx.play('payout');
      },
      onRepay() {
        const debt = state.loanDebt;
        if (debt === 0) return;
        if (!blackjack.spendTokens(debt)) {
          bankUI.setMessage(`"You need ${debt} tokens to clear your loan."`);
          sound.sfx.play('denied');
          return;
        }
        state.loanDebt = 0;
        bankUI.setMessage('"Loan repaid in full. Pleasure doing business."');
        sound.sfx.play('chips');
      },
      onClose: closeBank,
    });

    sharkUI = createLoanUI({
      root: dom.shark,
      prefix: 'shark',
      limit: SHARK_LOAN,
      getBalance: () => blackjack.balance,
      getDebt: () => state.sharkDebt,
      greeting: (debt) =>
        debt === 0
          ? `"Bank cut you off, huh? I can do ${SHARK_LOAN}. But you pay me back... or my boys come find you."`
          : '"You got my money, or are you just visiting?"',
      onBorrow() {
        if (state.sharkDebt >= SHARK_LOAN) {
          sharkUI.setMessage('"One loan at a time, pal."');
          sound.sfx.play('denied');
          return;
        }
        const amount = SHARK_LOAN - state.sharkDebt;
        state.sharkDebt += amount;
        blackjack.addTokens(amount);
        sharkUI.setMessage(`"${amount} tokens. Lose it, and we'll be in touch."`);
        sound.sfx.play('payout');
      },
      onRepay() {
        const debt = state.sharkDebt;
        if (debt === 0) return;
        if (!blackjack.spendTokens(debt)) {
          sharkUI.setMessage(`"That's not ${debt}. Come back when it is."`);
          sound.sfx.play('denied');
          return;
        }
        state.sharkDebt = 0;
        sharkUI.setMessage('"Smart. You get to keep your kneecaps."');
        sound.sfx.play('chips');
      },
      onClose: closeShark,
    });

    // Town 3's extra lounge games all bet from the same token balance.
    const wallet = Object.freeze({
      balance: () => blackjack.balance,
      spend: (amount) => blackjack.spendTokens(amount),
      pay: (amount) => blackjack.addTokens(amount),
    });
    const playSfx = (name, opts) => sound.sfx.play(name, opts);
    pokerUI = createPokerUI({ root: dom.poker, wallet, sfx: playSfx, onClose: () => closeCasinoGame(pokerUI) });
    rouletteUI = createRouletteUI({ root: dom.roulette, wallet, sfx: playSfx, onClose: () => closeCasinoGame(rouletteUI) });
    plinkoUI = createPlinkoUI({ root: dom.plinko, wallet, sfx: playSfx, onClose: () => closeCasinoGame(plinkoUI) });

    const CASINO_GAMES = Object.freeze({
      poker: { mode: MODE.POKER, ui: pokerUI },
      roulette: { mode: MODE.ROULETTE, ui: rouletteUI },
      plinko: { mode: MODE.PLINKO, ui: plinkoUI },
    });
    const activeCasinoGame = () => Object.values(CASINO_GAMES).find((game) => game.mode === state.mode) ?? null;

    const CASINO_PROMPTS = Object.freeze({
      blackjack: 'to play blackjack',
      slots: 'to play slots',
      poker: 'to play poker',
      roulette: 'to play roulette',
      plinko: 'to play plinko',
    });

    const RESULT_AUDIO = Object.freeze({
      win: ['win', 'win'],
      dealerBust: ['win', 'dealerBust'],
      blackjack: ['blackjack', 'blackjack'],
      lose: ['lose', 'lose'],
      dealerBlackjack: ['lose', 'dealerBlackjack'],
      bust: ['bust', 'bust'],
      push: ['push', 'push'],
    });

    function handleGameEvent(type, data) {
      if (state.mode !== MODE.BLACKJACK) return;
      const stagger = CONFIG.CARD_STAGGER_MS / 1000;
      switch (type) {
        case 'shuffle':
          sound.sfx.play('shuffle');
          sound.voice.say('shuffle', {}, { priority: 1 });
          break;
        case 'bet':
          sound.sfx.play('bet');
          break;
        case 'deal':
          sound.sfx.play('chips');
          break;
        case 'card':
          sound.sfx.play('cardDeal', { delay: data.order * stagger });
          break;
        case 'flip':
          sound.sfx.play('cardFlip', { delay: data.order * stagger });
          break;
        case 'turn':
          sound.voice.say('yourMove', data, { delay: 700, chance: 0.7 });
          break;
        case 'hit':
          sound.voice.say('hit', data, { delay: 300, chance: 0.35 });
          break;
        case 'stand':
          sound.voice.say('stand', {}, { chance: 0.6 });
          break;
        case 'dealerDraw':
          sound.voice.say('dealerDraw', {}, { delay: 150, chance: 0.5 });
          break;
        case 'result': {
          const [sfxName, voiceKey] = RESULT_AUDIO[data.reason] ?? RESULT_AUDIO[data.outcome];
          const sfxDelay = data.natural ? 1.0 : 0.05;
          sound.sfx.play(sfxName, { delay: sfxDelay });
          sound.voice.say(voiceKey, { total: data.player, ...data }, { delay: data.natural ? 1100 : 500, priority: 2 });
          break;
        }
        case 'betting':
          sound.voice.say('placeBet', {}, { delay: 600, chance: 0.5 });
          break;
        case 'broke':
          sound.voice.say(blackjack.noRebuy ? 'brokeNoCredit' : 'broke', {}, { delay: 500, priority: 2 });
          break;
        case 'rebuy':
          sound.sfx.play('payout');
          sound.voice.say('rebuy', {}, { delay: 300, priority: 2 });
          break;
        default:
          break;
      }
    }

    function updateHudBalance(balance) {
      dom.hudBalance.textContent = balance;
      if (balance !== lastBalance) {
        dom.hudTokens.classList.remove('is-bumped');
        void dom.hudTokens.offsetWidth;
        dom.hudTokens.classList.add('is-bumped');
        lastBalance = balance;
      }
    }

    function setPrompt(visible, text = '') {
      if (visible !== state.promptVisible || text !== state.promptText) {
        state.promptVisible = visible;
        state.promptText = text;
        if (text) dom.prompt.innerHTML = text;
        dom.prompt.classList.toggle('is-visible', visible);
      }
    }

    function moveWithAreaColliders(dx, dy) {
      const area = AREAS[state.areaType];
      const colliders = state.townIndex > 1 && area.remodeledColliders ? area.remodeledColliders : area.colliders;
      const hitbox = () => player.hitbox;

      if (dx !== 0) {
        player.x += dx;
        let box = hitbox();
        player.x += clamp(box.x, area.room.x, area.room.x + area.room.w - box.w) - box.x;
        for (const solid of colliders) {
          box = hitbox();
          if (!rectsOverlap(box, solid)) continue;
          player.x += dx > 0 ? solid.x - (box.x + box.w) : solid.x + solid.w - box.x;
        }
      }
      if (dy !== 0) {
        player.y += dy;
        let box = hitbox();
        player.y += clamp(box.y, area.room.y, area.room.y + area.room.h - box.h) - box.y;
        for (const solid of colliders) {
          box = hitbox();
          if (!rectsOverlap(box, solid)) continue;
          player.y += dy > 0 ? solid.y - (box.y + box.h) : solid.y + solid.h - box.y;
        }
      }
    }

    let arrivalMessage = '';
    let arrivalMessageUntil = 0;
    let activeSlotMachine = null;

    /** Live state of the slot machine close-up (read by the renderer). */
    const slotSession = {
      machine: null,
      reels: SLOT_REEL_STRIPS.map(() => ({ rest: 0, plan: null, landedAt: 0 })),
      reelCount: 3, // 4 once the Golden Plus extension is owned
      lucky: false, // Four-Leaf Clover owned
      restByMachine: new Map(),
      spinning: false,
      result: null,
      resolvedAt: 0,
      leverPulledAt: -10,
      deniedAt: -10,
      message: '',
      messageTone: 'idle',
      balance: 0,
      coins: [],
      tickTimer: 0,
    };
    state.slots = slotSession;

    function setArea(areaType, spawn) {
      state.areaType = areaType;
      player.x = spawn.x;
      player.y = spawn.y;
      Input.clear();
      player.moving = false;
      setPrompt(false);
      if (areaType === 'town') {
        state.cameraX = clamp(player.x + player.w / 2 - CONFIG.WIDTH / 2, 0, TOWN_WORLD.width - CONFIG.WIDTH);
      }
      applyAreaMusicTheme();
    }

    function openBlackjack() {
      state.mode = MODE.BLACKJACK;
      player.moving = false;
      Input.clear();
      setPrompt(false);
      blackjack.noRebuy = state.townIndex > 1;
      if (blackjack.isBroke && blackjack.noRebuy) blackjack.message = 'Out of tokens! No credit at this table.';
      ui.open();
      sound.sfx.play('uiOpen');
      if (blackjack.isBroke) {
        hasVisitedTable = true;
        sound.voice.say(blackjack.noRebuy ? 'brokeNoCredit' : 'broke', {}, { priority: 3, delay: 250 });
      } else if (hasVisitedTable) {
        sound.voice.say('welcomeBack', {}, { priority: 3, delay: 250 });
      } else {
        hasVisitedTable = true;
        sound.sfx.play('shuffle', { delay: 0.3 });
        sound.voice.say('welcome', {}, { priority: 3, delay: 250 });
      }
    }

    function closeBlackjack() {
      if (!blackjack.canLeave) return;
      state.mode = MODE.OVERWORLD;
      if (blackjack.phase === PHASE.RESULT) blackjack.newHand();
      ui.close();
      Input.clear();
      sound.sfx.play('uiClose');
      sound.voice.say('goodbye', {}, { priority: 3, chance: 0.8 });
    }

    function openCosmetics() {
      state.mode = MODE.COSMETICS;
      player.moving = false;
      Input.clear();
      cosmeticMessage = 'Buy and equip styles and area songs.';
      cosmeticsUI.open();
      sound.sfx.play('uiOpen');
    }

    function closeCosmetics() {
      state.mode = MODE.OVERWORLD;
      cosmeticsUI.close();
      Input.clear();
      sound.sfx.play('uiClose');
    }

    function openBlackMarket() {
      state.mode = MODE.BLACKMARKET;
      player.moving = false;
      Input.clear();
      setPrompt(false);
      blackMarketUI.open();
      sound.sfx.play('uiOpen');
    }

    function closeBlackMarket() {
      state.mode = MODE.OVERWORLD;
      blackMarketUI.close();
      Input.clear();
      sound.sfx.play('uiClose');
    }

    function openBank() {
      state.mode = MODE.BANK;
      player.moving = false;
      Input.clear();
      setPrompt(false);
      bankUI.open();
      sound.sfx.play('uiOpen');
    }

    function closeBank() {
      state.mode = MODE.OVERWORLD;
      bankUI.close();
      Input.clear();
      sound.sfx.play('uiClose');
    }

    function openShark() {
      state.mode = MODE.SHARK;
      player.moving = false;
      Input.clear();
      setPrompt(false);
      sharkUI.open();
      sound.sfx.play('uiOpen');
    }

    function closeShark() {
      state.mode = MODE.OVERWORLD;
      sharkUI.close();
      Input.clear();
      sound.sfx.play('uiClose');
    }

    function openCasinoGame(kind) {
      const game = CASINO_GAMES[kind];
      state.mode = game.mode;
      player.moving = false;
      Input.clear();
      setPrompt(false);
      game.ui.open();
      sound.sfx.play('uiOpen');
    }

    function closeCasinoGame(gameUI) {
      if (!gameUI.canLeave()) return;
      state.mode = MODE.OVERWORLD;
      gameUI.close();
      Input.clear();
      sound.sfx.play('uiClose');
    }

    /** Nearest lounge game within reach (town 3 adds poker, roulette and plinko). */
    function nearestCasinoGame() {
      const candidates = [{ kind: 'blackjack', center: dealer.center, bubble: dealer }];
      const slot = nearestSlotMachine();
      if (slot) candidates.push({ kind: 'slots', center: slotCenter(slot.prop), prop: slot.prop });
      if (state.townIndex >= GRAND_CASINO_TOWN) {
        candidates.push(
          { kind: 'poker', center: pokerDealer.center, bubble: pokerDealer },
          { kind: 'roulette', center: rouletteDealer.center, bubble: rouletteDealer },
          { kind: 'plinko', center: { x: PLINKO_CABINET.x + PLINKO_CABINET.w / 2, y: PLINKO_CABINET.y + PLINKO_CABINET.h } },
        );
      }
      let best = null;
      let bestDist = CONFIG.INTERACT_RADIUS;
      for (const candidate of candidates) {
        const dist = Collision.distance(player.center, candidate.center);
        if (dist <= bestDist) {
          best = candidate;
          bestDist = dist;
        }
      }
      return best;
    }

    /** Maxed out at the bank and can't cover it: the door to the back room opens. */
    function updateBackroom() {
      if (!state.backroomOpen && state.townIndex > 1 && state.loanDebt >= LOAN_LIMIT && blackjack.balance < state.loanDebt) {
        state.backroomOpen = true;
      }
      if (state.backroomOpen && !state.backroomAnnounced && state.areaType === 'butcher' && state.mode === MODE.OVERWORLD) {
        state.backroomAnnounced = true;
        arrivalMessage = 'A hidden door creaks open beside the counter...';
        arrivalMessageUntil = performance.now() + 3200;
        sound.sfx.play('doorCreak');
      }
    }

    const BANK_SECRET_DOOR = Object.freeze({ x: 273, y: 84, w: 17, h: 6 });
    const BANK_BACKROOM_RETURN = Object.freeze({ x: 275, y: 92 });

    function handleBankSecretDoor() {
      if (state.areaType !== 'butcher' || state.townIndex <= 1 || !state.backroomOpen) return;
      if (rectsOverlap(player.hitbox, BANK_SECRET_DOOR)) setArea('backroom', AREAS.backroom.spawn);
    }

    /** Owing the shark with nothing left to bet: his collectors come calling. */
    function checkForRobbery() {
      if (state.sharkDebt === 0 || state.mode === MODE.CUTSCENE || state.train.active) return;
      const broke = blackjack.balance < blackjack.minBet && blackjack.canLeave && !slotSession.spinning && Object.values(CASINO_GAMES).every((game) => game.ui.canLeave());
      if (!broke) {
        robberyArmedAt = 0;
        return;
      }
      const now = performance.now();
      if (!robberyArmedAt) robberyArmedAt = now;
      if (now - robberyArmedAt >= 1500) startRobbery();
    }

    function startRobbery() {
      if (state.mode === MODE.BLACKJACK) ui.close();
      else if (state.mode === MODE.SLOTS) slotSession.coins.length = 0;
      else if (state.mode === MODE.COSMETICS) cosmeticsUI.close();
      else if (state.mode === MODE.BLACKMARKET) blackMarketUI.close();
      else if (state.mode === MODE.BANK) bankUI.close();
      else if (state.mode === MODE.SHARK) sharkUI.close();
      else activeCasinoGame()?.ui.close();
      state.mode = MODE.CUTSCENE;
      state.cutscene = { startedAt: performance.now() / 1000, fired: new Set() };
      player.moving = false;
      Input.clear();
      arrivalMessageUntil = 0;
      setPrompt(false);
      sound.music.setTheme('butcherLow');
    }

    function updateCutscene() {
      const cs = state.cutscene;
      const R = ROBBERY;
      const t = performance.now() / 1000 - cs.startedAt;
      const once = (key, at, fn) => {
        if (t >= at && !cs.fired.has(key)) {
          cs.fired.add(key);
          fn();
        }
      };
      if ((t > R.walkStart && t < R.walkEnd) || (t > R.backUp && t < R.cornered)) {
        const step = Math.floor(t * 4);
        once(`p${step}`, 0, () => sound.footstep(step % 2 ? 'left' : 'right'));
      }
      if ((t > R.goonsIn && t < R.cornered) || (t > R.leave && t < R.fade)) {
        const step = Math.floor(t * 3);
        once(`g${step}`, 0, () => sound.footstep(step % 2 ? 'left' : 'right'));
      }
      once('alarm', R.alarm, () => sound.sfx.play('denied'));
      once('hit', R.hit, () => {
        sound.sfx.play('bust');
        blackjack.spendTokens(blackjack.balance);
      });
      once('coins', R.hit + 0.1, () => sound.sfx.play('payout'));
      once('title', R.title, () => sound.sfx.play('lose'));
      once('restart', R.autoRestart, restartGame);
    }

    /** Wipe the save and start the whole game over from scratch. */
    function restartGame() {
      try {
        localStorage.removeItem(PROGRESS_KEY);
      } catch {
        /* ignore storage failures */
      }
      window.location.reload();
    }

    function openSlots() {
      if (!activeSlotMachine) return;
      const s = slotSession;
      state.mode = MODE.SLOTS;
      player.moving = false;
      Input.clear();
      setPrompt(false);

      s.machine = activeSlotMachine;
      if (!s.restByMachine.has(s.machine)) {
        s.restByMachine.set(s.machine, SLOT_REEL_STRIPS.map((strip) => Math.floor(Math.random() * strip.length)));
      }
      s.restByMachine.get(s.machine).forEach((rest, i) => {
        s.reels[i].rest = rest;
        s.reels[i].plan = null;
        s.reels[i].landedAt = 0;
      });
      s.result = null;
      s.resolvedAt = 0;
      s.coins.length = 0;
      s.reelCount = hasRelic('plus') ? 4 : 3;
      s.lucky = hasRelic('clover');
      s.balance = blackjack.balance;
      s.message = s.balance >= SLOT_SPIN_COST ? 'PULL THE LEVER' : `NEED ${SLOT_SPIN_COST} TOKENS`;
      s.messageTone = s.balance >= SLOT_SPIN_COST ? 'idle' : 'deny';
      sound.sfx.play('uiOpen');
    }

    function closeSlots() {
      const s = slotSession;
      if (s.spinning) return;
      s.restByMachine.set(s.machine, s.reels.map((reel) => reel.rest));
      s.coins.length = 0;
      state.mode = MODE.OVERWORLD;
      Input.clear();
      sound.sfx.play('uiClose');
    }

    function spinSlotMachine() {
      const s = slotSession;
      if (state.mode !== MODE.SLOTS || s.spinning) return;
      const now = performance.now() / 1000;
      if (!blackjack.spendTokens(SLOT_SPIN_COST)) {
        sound.sfx.play('denied');
        s.deniedAt = now;
        s.message = `NEED ${SLOT_SPIN_COST} TOKENS`;
        s.messageTone = 'deny';
        return;
      }

      // Decide the outcome up front, then choreograph the reels to land on it.
      const symbols = rollSlotResult(s.reelCount, s.lucky);
      s.result = { symbols, ...evaluateSlotResult(symbols) };
      let prevLand = now;
      s.reels.slice(0, s.reelCount).forEach((reel, i) => {
        let stopTime = now + SLOT_TIMING.firstStop + i * SLOT_TIMING.stagger;
        // Extra suspense on a reel when everything before it matched.
        if (i >= 2 && symbols.slice(0, i).every((sym) => sym === symbols[0])) stopTime += SLOT_TIMING.tease;
        stopTime = Math.max(stopTime, prevLand + 0.3);
        reel.plan = planSlotReel(SLOT_REEL_STRIPS[i], reel.rest, now, stopTime, symbols[i]);
        reel.landedAt = 0;
        prevLand = reel.plan.landTime;
      });

      s.spinning = true;
      s.resolvedAt = 0;
      s.leverPulledAt = now;
      s.tickTimer = SLOT_TIMING.windup;
      s.coins = s.coins.filter((coin) => !coin.resting);
      s.message = 'GOOD LUCK...';
      s.messageTone = 'spin';
      sound.sfx.play('slotLever');
    }

    function spawnSlotCoins(count, rain = false) {
      const { tray } = SLOT_VIEW;
      const rand = (a, b) => a + Math.random() * (b - a);
      for (let i = 0; i < count; i++) {
        slotSession.coins.push(
          rain
            ? { x: rand(70, 250), y: rand(-30, -4), vx: rand(-12, 12), vy: rand(20, 70), delay: i * 0.04, seed: rand(0, 4), resting: false }
            : { x: tray.x + tray.w / 2 + rand(-8, 8), y: tray.y - 2, vx: rand(-75, 75), vy: rand(-170, -90), delay: i * 0.035, seed: rand(0, 4), resting: false },
        );
      }
    }

    function resolveSlotSpin(now) {
      const s = slotSession;
      const res = s.result;
      s.spinning = false;
      s.resolvedAt = now;
      for (const reel of s.reels.slice(0, s.reelCount)) {
        reel.rest = wrapIndex(reel.plan.target, SLOT_REEL_STRIPS[0].length);
        reel.plan = null;
      }

      if (res.payout > 0) {
        blackjack.addTokens(res.payout);
        s.messageTone = 'win';
        if (RAINBOW_TIERS.has(res.tier)) {
          sound.sfx.play('slotJackpot');
          spawnSlotCoins(res.tier === 'mega' ? 45 : 30);
          spawnSlotCoins(res.tier === 'mega' ? 60 : 40, true);
        } else if (BIG_WIN_TIERS.has(res.tier)) {
          sound.sfx.play('win');
          spawnSlotCoins(res.tier === 'quad' ? 26 : 18);
        } else {
          sound.sfx.play('payout');
          spawnSlotCoins(8);
        }
      } else {
        s.message = 'NO WIN';
        s.messageTone = 'lose';
      }
    }

    function updateSlots(dt) {
      const s = slotSession;
      s.balance = blackjack.balance;
      if (state.mode !== MODE.SLOTS) return;
      const now = performance.now() / 1000;

      if (s.spinning) {
        let allSettled = true;
        let anySpinning = false;
        const active = s.reels.slice(0, s.reelCount);
        active.forEach((reel) => {
          if (!reel.landedAt && now >= reel.plan.landTime) {
            reel.landedAt = now;
            sound.sfx.play('reelStop');
          }
          if (!reel.landedAt) anySpinning = true;
          if (now < reel.plan.settleTime) allSettled = false;
        });

        const last = active.length - 1;
        const syms = s.result.symbols;
        if (active.slice(0, last).every((reel) => reel.landedAt) && !active[last].landedAt && syms.slice(0, last).every((sym) => sym === syms[0])) {
          s.message = 'ONE MORE...';
        }

        if (anySpinning) {
          s.tickTimer -= dt;
          if (s.tickTimer <= 0) {
            s.tickTimer = 0.07;
            sound.sfx.play('reelTick');
          }
        }
        if (allSettled) resolveSlotSpin(now);
      }

      // Coin physics: spill into the tray (or rain down on a jackpot)
      const { tray } = SLOT_VIEW;
      const floorY = tray.y + tray.h - 5;
      for (const coin of s.coins) {
        if (coin.delay > 0) {
          coin.delay -= dt;
          continue;
        }
        if (coin.resting) continue;
        coin.vy += 420 * dt;
        coin.x += coin.vx * dt;
        coin.y += coin.vy * dt;
        const overTray = coin.x > tray.x + 2 && coin.x < tray.x + tray.w - 2;
        if (overTray && coin.vy > 0 && coin.y >= floorY && coin.y - coin.vy * dt <= floorY + 2) {
          coin.y = floorY;
          if (coin.vy > 70) {
            coin.vy = -coin.vy * 0.35;
            coin.vx *= 0.6;
          } else {
            coin.vx = 0;
            coin.vy = 0;
            coin.resting = true;
          }
        }
      }
      s.coins = s.coins.filter((coin) => coin.y < CONFIG.HEIGHT + 10);
      while (s.coins.filter((coin) => coin.resting).length > 40) {
        s.coins.splice(s.coins.findIndex((coin) => coin.resting), 1);
      }
    }

    function handleCanvasPointer(event) {
      if (state.mode !== MODE.SLOTS || sound.isSettingsOpen()) return;
      const rect = dom.canvas.getBoundingClientRect();
      const x = ((event.clientX - rect.left) * CONFIG.WIDTH) / rect.width;
      const y = ((event.clientY - rect.top) * CONFIG.HEIGHT) / rect.height;
      const hit = (r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
      if (hit(SLOT_VIEW.lever) || hit(SLOT_VIEW.button)) spinSlotMachine();
    }

    const THEME_BY_AREA = Object.freeze({
      cosmetics: 'cosmeticsBoutique',
      butcher: 'butcherLow',
      fishing: 'fishingDrift',
      bakery: 'bakeryWarm',
      supermarket: 'marketHop',
      toy: 'toyBox',
      restaurant: 'dinerGlow',
      electronics: 'electroPulse',
      gift: 'giftWaltz',
      backroom: 'butcherLow',
    });

    function applyAreaMusicTheme() {
      let theme = 'casinoClassic';
      const equippedSong = COSMETICS_CATALOG.find((item) => item.id === progress.equipped.song)?.theme ?? 'townBreeze';
      if (state.areaType === 'town') theme = equippedSong;
      else if (THEME_BY_AREA[state.areaType]) theme = THEME_BY_AREA[state.areaType];
      if (state.areaType === 'town' && (state.nearStation || state.train.active)) theme = 'stationPulse';
      sound.music.setTheme(theme);
    }

    function syncSongSelect(fromPurchase = false) {
      if (!dom.songSelect) return;
      const ownedSongItems = COSMETICS_CATALOG.filter((item) => item.kind === 'song' && progress.owned.includes(item.id));
      dom.songSelect.replaceChildren();
      for (const item of ownedSongItems) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.name;
        option.selected = progress.equipped.song === item.id;
        dom.songSelect.append(option);
      }
      const selectedItem = ownedSongItems.find((item) => item.id === progress.equipped.song) ?? ownedSongItems[0];
      if (selectedItem) {
        progress.equipped.song = selectedItem.id;
        dom.songValue.textContent = selectedItem.name.slice(0, 8).toUpperCase();
      } else {
        dom.songValue.textContent = '--';
      }
      if (fromPurchase) sound.sfx.play('payout');
      applyAreaMusicTheme();
      saveProgress(progress);
    }

    dom.songSelect?.addEventListener('change', () => {
      const next = dom.songSelect.value;
      if (!next || !progress.owned.includes(next)) return;
      progress.equipped.song = next;
      sound.sfx.play('uiClick');
      syncSongSelect(false);
    });

    dom.songCycle?.addEventListener('click', () => {
      const options = [...dom.songSelect.options];
      if (options.length === 0) return;
      const idx = Math.max(0, options.findIndex((opt) => opt.selected));
      const next = options[(idx + 1) % options.length];
      dom.songSelect.value = next.value;
      dom.songSelect.dispatchEvent(new Event('change'));
    });

    const INTERIOR_AREAS = new Set(['cosmetics', 'butcher', 'fishing', 'bakery', 'supermarket', 'toy', 'restaurant', 'electronics', 'gift', 'backroom']);

    function storeDoorX(areaId) {
      const def = STORE_DEFS.find((d) => d.id === areaId || d.area === areaId);
      return def ? def.x + def.w / 2 : TOWN_WORLD.width / 2;
    }

    function handleTownDoors() {
      const box = player.hitbox;
      for (const def of STORE_DEFS) {
        const door = { x: def.x + def.w / 2 - 6, y: 74, w: 12, h: 8 };
        if (rectsOverlap(box, door)) {
          setArea(def.area, AREAS[def.area].spawn);
          return;
        }
      }
    }

    function handleIndoorExit() {
      const box = player.hitbox;
      const exitDoor = { x: 144, y: 220, w: 32, h: 10 };
      if (rectsOverlap(box, exitDoor)) {
        if (state.areaType === 'backroom') setArea('butcher', BANK_BACKROOM_RETURN);
        else setArea('town', { x: storeDoorX(state.areaType) - player.w / 2, y: 86 });
      }
    }

    function handleCasinoExit() {
      const box = player.hitbox;
      const exitDoor = { x: 144, y: 228, w: 32, h: 8 };
      if (rectsOverlap(box, exitDoor)) {
        setArea('town', { x: storeDoorX('casino') - player.w / 2, y: 86 });
      }
    }

    function nearestStation() {
      const stations = availableStationsForTown();
      if (stations.length === 0) return null;

      let nearest = stations[0];
      let bestDist = Math.abs(player.center.x - nearest.centerX);
      for (let i = 1; i < stations.length; i++) {
        const dist = Math.abs(player.center.x - stations[i].centerX);
        if (dist < bestDist) {
          bestDist = dist;
          nearest = stations[i];
        }
      }
      return nearest;
    }

    function slotCenter(prop) {
      return { x: prop.x + prop.w / 2, y: prop.y + prop.h / 2 };
    }

    function nearestSlotMachine() {
      if (SLOT_PROPS.length === 0) return null;

      let nearest = SLOT_PROPS[0];
      let bestDist = Collision.distance(player.center, slotCenter(nearest));
      for (let i = 1; i < SLOT_PROPS.length; i++) {
        const dist = Collision.distance(player.center, slotCenter(SLOT_PROPS[i]));
        if (dist < bestDist) {
          nearest = SLOT_PROPS[i];
          bestDist = dist;
        }
      }
      return { prop: nearest, dist: bestDist };
    }

    function availableStationsForTown() {
      // First town boards from the left station only.
      if (state.townIndex === 1) return [{ ...TOWN_WORLD.stationLeft, key: 'left' }];

      const stations = [{ ...TOWN_WORLD.stationRight, key: 'right' }];
      const nextTown = state.townIndex + 1;
      const canTravelForward = nextTown <= state.maxUnlockedTown || (state.townIndex === state.maxUnlockedTown && state.maxUnlockedTown < MAX_TOWNS);
      if (canTravelForward) stations.push({ ...TOWN_WORLD.stationLeft, key: 'left' });
      return stations;
    }

    function destinationTownForStation(stationKey) {
      if (stationKey === 'left') {
        const nextTown = state.townIndex + 1;
        if (nextTown > MAX_TOWNS) return null;
        const canTravelForward = nextTown <= state.maxUnlockedTown || (state.townIndex === state.maxUnlockedTown && state.maxUnlockedTown < MAX_TOWNS);
        return canTravelForward ? nextTown : null;
      }
      if (stationKey === 'right') {
        if (state.collapsedTunnels.has(state.townIndex)) return null;
        const prevTown = state.townIndex - 1;
        return prevTown >= 1 && prevTown <= state.maxUnlockedTown ? prevTown : null;
      }
      return null;
    }

    function nearStationDistance() {
      const station = nearestStation();
      if (!station) return { station: null, dist: Infinity };
      return { station, dist: Math.hypot(player.center.x - station.centerX, player.center.y - TOWN_WORLD.trackY) };
    }

    function updateCamera(dt) {
      if (state.train.active) return; // the camera already follows the train in updateTrain
      const desired = clamp(player.x + player.w / 2 - CONFIG.WIDTH / 2, 0, TOWN_WORLD.width - CONFIG.WIDTH);
      const smoothing = 1 - Math.exp(-dt * 6);
      state.cameraX += (desired - state.cameraX) * smoothing;
    }

    /** Ride sequence:
     *   depart  - doors close, the train pulls away toward the nearest wall
     *   tunnel  - it vanishes into the wall and the screen fades out
     *   arrive  - next town: it rolls out of the opposite wall and brakes
     *             into that town's platform
     *   alight  - the player hops off onto the plaza
     * Going left leads to the next town, going right leads back. The fare is
     * only paid the first time a town is unlocked; after that rides are free. */
    function showTrainNotice(text) {
      sound.sfx.play('denied');
      arrivalMessage = text;
      arrivalMessageUntil = performance.now() + 1800;
    }

    function closedLineMessage(stationKey) {
      return stationKey === 'right' && state.collapsedTunnels.has(state.townIndex)
        ? 'The tunnel back has collapsed'
        : 'This line is not open yet';
    }

    function trainFareFor(destinationTown) {
      return destinationTown > state.maxUnlockedTown ? TRAIN_FARES[destinationTown] : 0;
    }

    function beginTrainRide() {
      const { station } = nearStationDistance();
      if (!station) {
        showTrainNotice('No trains run from here');
        return;
      }

      const destinationTown = destinationTownForStation(station.key);
      if (!destinationTown) {
        showTrainNotice(closedLineMessage(station.key));
        return;
      }

      const fare = trainFareFor(destinationTown);
      if (fare > 0 && !blackjack.spendTokens(fare)) {
        showTrainNotice(`Need ${fare} tokens to unlock Town ${destinationTown}`);
        return;
      }

      const train = state.train;
      const dir = station.key === 'left' ? -1 : 1;
      train.active = true;
      train.direction = dir;
      train.stationKey = station.key;
      train.worldX = station.centerX + dir * TRAIN_STOP_OFFSET;
      train.vx = 0;
      train.phase = 'depart';
      train.timer = 0;
      train.fade = 0;
      train.townSwitched = false;
      train.destinationTown = destinationTown;
      Input.clear();
      player.moving = false;
      setPrompt(false);
      sound.sfx.play('trainWhistle');
    }

    function trainFollowCamera(train) {
      state.cameraX = clamp(train.worldX - CONFIG.WIDTH / 2, 0, TOWN_WORLD.width - CONFIG.WIDTH);
    }

    function updateTrain(dt) {
      const train = state.train;
      const W = TOWN_WORLD.width;
      const dir = train.direction;
      train.timer += dt;

      if (train.phase === 'depart') {
        if (train.timer > 0.45) {
          train.vx = Math.min(230, train.vx + 170 * dt);
          train.worldX += dir * train.vx * dt;
        }
        trainFollowCamera(train);
        const exitX = dir < 0 ? 8 - TRAIN_HIDDEN_PAST : W - 8 + TRAIN_HIDDEN_PAST;
        if ((train.worldX - exitX) * dir >= 0) {
          train.phase = 'tunnel';
          train.timer = 0;
          sound.sfx.play('trainTunnel');
        }
        return;
      }

      if (train.phase === 'tunnel') {
        train.fade = clamp(train.timer / 0.4, 0, 1);
        if (train.timer >= 0.6) {
          // Emerge from the opposite wall of the next town, still heading the same way.
          state.townIndex = clamp(train.destinationTown, 1, MAX_TOWNS);
          state.maxUnlockedTown = Math.max(state.maxUnlockedTown, state.townIndex);
          train.stationKey = dir < 0 ? 'right' : 'left';
          train.worldX = dir < 0 ? W - 8 + TRAIN_HIDDEN_PAST : 8 - TRAIN_HIDDEN_PAST;
          train.vx = 150;
          train.phase = 'arrive';
          train.timer = 0;
          trainFollowCamera(train);
        }
        return;
      }

      if (train.phase === 'arrive') {
        train.fade = clamp(1 - train.timer / 0.45, 0, 1);
        const station = train.stationKey === 'left' ? TOWN_WORLD.stationLeft : TOWN_WORLD.stationRight;
        const stopX = station.centerX + dir * TRAIN_STOP_OFFSET;
        const remaining = (stopX - train.worldX) * dir;
        const BRAKE = 70;
        train.vx = Math.min(train.vx, Math.max(6, Math.sqrt(2 * BRAKE * Math.max(remaining, 0))));
        const step = train.vx * dt;
        if (step >= remaining) {
          train.worldX = stopX;
          train.vx = 0;
          train.fade = 0;
          train.phase = 'alight';
          train.timer = 0;
          player.x = stopX - player.w / 2;
          player.y = TOWN_WORLD.trackY;
          player.moving = false;
          sound.sfx.play('trainBrake');
        } else {
          train.worldX += dir * step;
        }
        trainFollowCamera(train);
        return;
      }

      if (train.phase === 'alight') {
        // Step out of the door, hop down off the platform edge onto the plaza.
        const t = clamp((train.timer - 0.35) / 0.45, 0, 1);
        player.y = TOWN_WORLD.trackY + (150 - TOWN_WORLD.trackY) * t - Math.sin(t * Math.PI) * 6;
        if (train.timer >= 0.9) arriveTrain();
      }
    }

    function arriveTrain() {
      const train = state.train;
      train.active = false;
      train.vx = 0;
      train.fade = 0;
      train.phase = 'idle';
      player.y = 150;
      Input.clear();
      arrivalMessage = `Welcome to Town ${state.townIndex}`;
      arrivalMessageUntil = performance.now() + 2200;
      sound.sfx.play('prompt');

      // Arriving from the previous town: the tunnel caves in behind the train.
      if (train.direction < 0 && state.townIndex === 2 && !state.collapsedTunnels.has(state.townIndex)) {
        state.collapsedTunnels.add(state.townIndex);
        state.collapse = { town: state.townIndex, startedAt: performance.now() / 1000, announced: false };
        sound.sfx.play('tunnelCollapse');
      }
    }

    function updateTunnelCollapse() {
      const collapse = state.collapse;
      if (!collapse) return;
      const t = performance.now() / 1000 - collapse.startedAt;
      if (!collapse.announced && t >= TUNNEL_COLLAPSE_SLAM + 0.3) {
        collapse.announced = true;
        arrivalMessage = 'The tunnel collapsed behind you! There is no going back.';
        arrivalMessageUntil = performance.now() + 3200;
      }
      if (t >= TUNNEL_COLLAPSE_DURATION) state.collapse = null;
    }

    function handleKeyDown(event) {
      if (sound.isSettingsOpen()) return;
      if (state.mode === MODE.BLACKJACK) {
        ui.handleKey(event);
        return;
      }
      const casinoGame = activeCasinoGame();
      if (casinoGame) {
        casinoGame.ui.handleKey(event);
        return;
      }
      if (state.mode === MODE.SLOTS) {
        if (SCROLL_KEYS.has(event.code)) event.preventDefault();
        if (event.repeat) return;
        if (event.code === 'Space' || event.code === 'Enter' || event.code === 'NumpadEnter') {
          event.preventDefault();
          spinSlotMachine();
        } else if (event.code === 'Escape' || event.code === 'KeyE') {
          event.preventDefault();
          closeSlots();
        }
        return;
      }
      if (state.mode === MODE.COSMETICS) {
        if ((event.code === 'Escape' || event.code === 'KeyE') && !event.repeat) {
          event.preventDefault();
          closeCosmetics();
        }
        return;
      }

      if (state.mode === MODE.BLACKMARKET) {
        if ((event.code === 'Escape' || event.code === 'KeyE') && !event.repeat) {
          event.preventDefault();
          closeBlackMarket();
        }
        return;
      }

      if (state.mode === MODE.BANK) {
        if ((event.code === 'Escape' || event.code === 'KeyE') && !event.repeat) {
          event.preventDefault();
          closeBank();
        }
        return;
      }

      if (state.mode === MODE.SHARK) {
        if ((event.code === 'Escape' || event.code === 'KeyE') && !event.repeat) {
          event.preventDefault();
          closeShark();
        }
        return;
      }

      if (state.mode === MODE.CUTSCENE) {
        if (SCROLL_KEYS.has(event.code)) event.preventDefault();
        const t = performance.now() / 1000 - state.cutscene.startedAt;
        const restartKey = event.code === 'KeyE' || event.code === 'Space' || event.code === 'Enter';
        if (restartKey && !event.repeat && t >= ROBBERY.prompt) restartGame();
        return;
      }

      if (SCROLL_KEYS.has(event.code)) event.preventDefault();
      const isInteract = event.code === 'KeyE' || event.code === 'Space';
      if (!isInteract || event.repeat) return;

      if (state.areaType === 'casino' && state.nearDealer) {
        openBlackjack();
      } else if (state.areaType === 'casino' && state.nearSlotMachine) {
        openSlots();
      } else if (state.areaType === 'casino' && CASINO_GAMES[state.casinoTarget?.kind]) {
        openCasinoGame(state.casinoTarget.kind);
      } else if (state.areaType === 'cosmetics' && state.nearCosmeticsClerk) {
        openCosmetics();
      } else if (state.nearBlackMarketDealer) {
        openBlackMarket();
      } else if (state.nearBankTeller) {
        openBank();
      } else if (state.nearShark) {
        openShark();
      } else if (state.areaType === 'town' && state.nearStation) {
        beginTrainRide();
      }
    }

    function update(dt) {
      const frozen = sound.isSettingsOpen();

      if (state.mode === MODE.CUTSCENE) {
        updateCutscene();
        return;
      }

      if (state.areaType === 'town' && state.train.active) {
        if (!frozen) updateTrain(dt);
      } else if (state.mode === MODE.OVERWORLD && !frozen) {
        const move = Input.getMoveVector();
        player.moving = move.x !== 0 || move.y !== 0;
        if (player.moving) {
          player.walkTime += dt;
          const step = CONFIG.PLAYER_SPEED * dt;
          if (state.areaType === 'casino') {
            const colliders = state.townIndex >= GRAND_CASINO_TOWN ? GRAND_COLLIDERS : COLLIDERS;
            Collision.moveAndCollide(player, move.x * step, move.y * step, colliders);
          } else {
            moveWithAreaColliders(move.x * step, move.y * step);
          }

          const stepIndex = Math.floor(player.walkTime * 8);
          if (stepIndex !== lastStepIndex) {
            lastStepIndex = stepIndex;
            if (stepIndex % 2 === 1) sound.footstep(stepIndex % 4 === 1 ? 'left' : 'right');
          }
        } else {
          player.walkTime = 0;
          lastStepIndex = 0;
        }

        if (state.areaType === 'town') handleTownDoors();
        if (state.areaType === 'casino') handleCasinoExit();
        if (INTERIOR_AREAS.has(state.areaType)) handleIndoorExit();
        handleBankSecretDoor();
      } else if (frozen) {
        player.moving = false;
      }

      if (state.areaType === 'town') updateCamera(dt);
      updateTunnelCollapse();
      updateBackroom();
      checkForRobbery();
      if (state.mode === MODE.CUTSCENE) return;

      state.casinoTarget = state.areaType === 'casino' && !state.train.active ? nearestCasinoGame() : null;
      state.nearDealer = state.casinoTarget?.kind === 'blackjack';
      state.nearSlotMachine = state.casinoTarget?.kind === 'slots';
      activeSlotMachine = state.nearSlotMachine ? state.casinoTarget.prop : null;
      state.nearCosmeticsClerk = state.areaType === 'cosmetics' && Collision.distance(player.center, { x: 160, y: 100 }) <= 44;
      state.nearBlackMarketDealer = state.areaType === 'fishing' && state.townIndex > 1 && Collision.distance(player.center, { x: 160, y: 68 }) <= 44;
      state.nearBankTeller = state.areaType === 'butcher' && state.townIndex > 1 && Collision.distance(player.center, { x: 160, y: 68 }) <= 44;
      state.nearShark = state.areaType === 'backroom' && Collision.distance(player.center, { x: 160, y: 86 }) <= 40;
      if (state.areaType === 'town' && !state.train.active) {
        state.nearStation = nearStationDistance().dist <= CONFIG.INTERACT_RADIUS;
      } else {
        state.nearStation = false;
      }

      if (performance.now() < arrivalMessageUntil) {
        setPrompt(true, arrivalMessage);
      } else if (state.train.active) {
        setPrompt(false);
      } else if (state.mode !== MODE.OVERWORLD) {
        setPrompt(false);
      } else if (state.casinoTarget) {
        setPrompt(true, `Press <kbd>E</kbd> or <kbd>Space</kbd> ${CASINO_PROMPTS[state.casinoTarget.kind]}`);
      } else if (state.nearCosmeticsClerk) {
        setPrompt(true, 'Press <kbd>E</kbd> or <kbd>Space</kbd> to shop');
      } else if (state.nearBlackMarketDealer) {
        setPrompt(true, 'Press <kbd>E</kbd> or <kbd>Space</kbd> to talk to the dealer');
      } else if (state.nearBankTeller) {
        setPrompt(true, 'Press <kbd>E</kbd> or <kbd>Space</kbd> to talk to the teller');
      } else if (state.nearShark) {
        setPrompt(true, 'Press <kbd>E</kbd> or <kbd>Space</kbd> to talk to the man in the hat');
      } else if (state.nearStation) {
        const destination = destinationTownForStation(nearestStation()?.key);
        if (!destination) {
          setPrompt(true, closedLineMessage(nearestStation()?.key));
        } else {
          const fare = trainFareFor(destination);
          setPrompt(true, `Press <kbd>E</kbd> to ride to Town ${destination} (${fare > 0 ? fare : 'free'})`);
        }
      } else {
        setPrompt(false);
      }

      applyAreaMusicTheme();
      updateSlots(dt);
      activeCasinoGame()?.ui.update?.(performance.now() / 1000);
    }

    let lastTime = performance.now();

    function frame(now) {
      const dt = Math.min((now - lastTime) / 1000, CONFIG.MAX_DT);
      lastTime = now;
      update(dt);
      Renderer.render(state, now / 1000);
      requestAnimationFrame(frame);
    }

    function fitToWindow() {
      const availW = window.innerWidth - 32;
      const availH = window.innerHeight - dom.help.offsetHeight - 48;
      const fit = Math.min(availW / (CONFIG.WIDTH + 10), availH / (CONFIG.HEIGHT + 14));
      const scale = fit >= 2 ? Math.floor(fit) : Math.max(0.5, Math.floor(fit * 4) / 4);
      document.documentElement.style.setProperty('--scale', String(scale));
    }

    Renderer.init(dom.canvas);
    Input.init();
    Input.onKeyDown(handleKeyDown);
    dom.canvas.addEventListener('pointerdown', handleCanvasPointer);
    sound.onSettingsToggle(() => {
      Input.clear();
      player.moving = false;
    });
    window.addEventListener('resize', fitToWindow);

    syncSongSelect(false);
    fitToWindow();
    updateHudBalance(blackjack.balance);
    ui.render();
    cosmeticsUI.render();
    requestAnimationFrame(frame);
  }

  main();
})();
