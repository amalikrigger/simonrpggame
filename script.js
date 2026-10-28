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
    STARTING_BALANCE: 500,
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

  const TRAIN_FARE = 1500;
  const PROGRESS_KEY = 'luckyPixelLounge.progress.v2';

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
    { x: dealer.x - 2, y: TABLE.y - 4, w: dealer.w + 4, h: 4 }, // dealer's feet
    ...PROPS.map((prop) => prop.collider),
  ]);

  /* ========================================================================
     7. COLLISION & PROXIMITY
     Axis-separated movement: move X, resolve; move Y, resolve. This lets
     the player slide along walls instead of sticking to them.
     ====================================================================== */

  const Collision = {
    moveAndCollide(entity, dx, dy) {
      if (dx !== 0) {
        entity.x += dx;
        this.clampToRoom(entity);
        for (const solid of COLLIDERS) {
          const box = entity.hitbox;
          if (!rectsOverlap(box, solid)) continue;
          entity.x += dx > 0 ? solid.x - (box.x + box.w) : solid.x + solid.w - box.x;
        }
      }
      if (dy !== 0) {
        entity.y += dy;
        this.clampToRoom(entity);
        for (const solid of COLLIDERS) {
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
    let townBackground;
    let cosmeticsBackground;
    let drawables;
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
      sprites.heart = buildSprite(SUIT_PIXELS.heart, { '#': PAL.red });
      sprites.spade = buildSprite(SUIT_PIXELS.spade, { '#': PAL.ink });
      sprites.digit1 = buildSprite(DIGIT_PIXELS[1], { '#': PAL.redLight });
      sprites.digit2 = buildSprite(DIGIT_PIXELS[2], { '#': PAL.redLight });

      background = renderBackground();
      townBackground = renderTownBackground();
      cosmeticsBackground = renderCosmeticsBackground();
      for (const def of STORE_DEFS) {
        if (def.id === 'casino' || def.id === 'cosmetics') continue;
        interiorBackgrounds[def.area] = renderGenericInteriorBackground(def);
      }

      // Depth-sorted drawables (sortY = bottom edge on screen)
      drawables = [
        { get sortY() { return player.y + player.h; }, draw: drawPlayer },
        { sortY: TABLE.y + TABLE.h, draw: drawDealerStation },
        ...PROPS.map((prop) => ({
          sortY: prop.y + prop.h,
          draw: (time) => (prop.type === 'slot' ? drawSlotMachine(prop, time) : drawPlant(prop)),
        })),
      ];
    }

    /* ----- Static background ------------------------------------------ */

    function renderBackground() {
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
      fillRect(g, x, buildY, w, buildH, def.roof);
      fillRect(g, x + 2, buildY + 6, w - 4, buildH - 6, def.wall);
      fillRect(g, x, buildY, w, 4, def.accent);

      // Sign band with the store's name (canvas text auto-fits via maxWidth)
      fillRect(g, x + 4, buildY + 8, w - 8, 12, def.sign);
      fillRect(g, x + 4, buildY + 8, w - 8, 2, 'rgba(255,255,255,0.25)');
      g.save();
      g.fillStyle = PAL.ink;
      g.font = 'bold 6px monospace';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(def.name, x + w / 2, buildY + 14, w - 10);
      g.restore();

      // Glowing windows either side of the door
      fillRect(g, x + 8, buildY + 26, 14, 14, '#101820');
      fillRect(g, x + 9, buildY + 27, 12, 12, def.glow);
      fillRect(g, x + w - 22, buildY + 26, 14, 14, '#101820');
      fillRect(g, x + w - 21, buildY + 27, 12, 12, def.glow);

      // Door
      const doorW = 14;
      const doorX = x + w / 2 - doorW / 2;
      fillRect(g, doorX - 1, buildY + 24, doorW + 2, buildH - 24, '#101820');
      fillRect(g, doorX, buildY + 26, doorW, buildH - 28, def.accent);
      fillRect(g, doorX + doorW / 2 - 1, buildY + buildH - 14, 2, 8, PAL.ink);
    }

    function drawStreetlight(g, x, baseY) {
      fillRect(g, x - 1, baseY - 26, 2, 26, '#232a33');
      fillRect(g, x - 4, baseY - 32, 8, 6, '#3a4350');
      fillRect(g, x - 2, baseY - 30, 4, 4, '#ffe9a8');
      fillRect(g, x - 3, baseY, 6, 2, PAL.ink);
    }

    function drawBench(g, x, y) {
      fillRect(g, x, y - 4, 16, 2, '#8a623a');
      fillRect(g, x, y, 16, 2, '#6b4a2a');
      fillRect(g, x, y + 2, 2, 5, '#3a2a18');
      fillRect(g, x + 14, y + 2, 2, 5, '#3a2a18');
    }

    function drawStationPlatform(g, station, trackY, trackH) {
      const { x, w } = station;
      fillRect(g, x, trackY - 4, w, trackH + 8, '#4a5560');
      fillRect(g, x, trackY - 4, w, 4, '#5f6b78');
      fillRect(g, x + 6, trackY - 34, w - 12, 10, PAL.molding);
      fillRect(g, x + 6, trackY - 24, 4, 20, PAL.steel);
      fillRect(g, x + w - 10, trackY - 24, 4, 20, PAL.steel);
      fillRect(g, x + w / 2 - 20, trackY - 30, 40, 8, PAL.gold);
      g.save();
      g.fillStyle = PAL.ink;
      g.font = 'bold 6px monospace';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('STATION', x + w / 2, trackY - 26, 36);
      g.restore();
    }

    /** A wide, left-to-right scrolling town: storefronts, sidewalks, a rail
     * line with platforms at both ends, and a lower plaza for strolling. */
    function renderTownBackground() {
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

      // Night-sky backdrop behind the buildings
      fillRect(g, 8, buildY, W - 16, buildH, '#17202e');
      for (let x = 8; x < W - 8; x += 40) fillRect(g, x, buildY + 4, 2, buildH - 10, 'rgba(255,255,255,0.03)');

      for (const def of STORE_DEFS) drawStoreFacade(g, def, buildY, buildH);

      // Sidewalk
      fillRect(g, 8, walkY, W - 16, walkH, '#283240');
      for (let x = 8; x < W - 8; x += 16) fillRect(g, x, walkY, 1, walkH, 'rgba(0,0,0,0.15)');
      fillRect(g, 8, walkY, W - 16, 2, 'rgba(255,255,255,0.05)');
      drawStreetlight(g, 44, walkY);
      drawStreetlight(g, W - 44, walkY);
      for (let i = 0; i < STORE_DEFS.length - 1; i++) {
        const gapX = STORE_DEFS[i].x + STORE_DEFS[i].w + STORE_GAP / 2;
        if (i % 2 === 0) drawStreetlight(g, gapX, walkY);
        else drawBench(g, gapX - 8, walkY + walkH - 10);
      }

      // Rail band: sleepers + two rails, with a platform at each end
      fillRect(g, 8, trackY, W - 16, trackH, '#232a1c');
      for (let x = 8; x < W - 8; x += 14) fillRect(g, x, trackY + 6, 8, 4, '#4a4030');
      fillRect(g, 8, trackY + 11, W - 16, 2, '#8a8a8a');
      fillRect(g, 8, trackY + 19, W - 16, 2, '#8a8a8a');
      drawStationPlatform(g, TOWN_WORLD.stationLeft, trackY, trackH);
      drawStationPlatform(g, TOWN_WORLD.stationRight, trackY, trackH);

      // Plaza: checker stone floor + scattered decor
      for (let ty = 0; ty < plazaH / 16; ty++) {
        for (let tx = 0; tx < (W - 16) / 16; tx++) {
          const x = 8 + tx * 16;
          const y = plazaY + ty * 16;
          fillRect(g, x, y, 16, 16, (tx + ty) % 2 === 0 ? '#324050' : '#2b3745');
        }
      }
      for (let x = 60; x < W - 60; x += 170) {
        drawStreetlight(g, x, plazaY + 12);
        g.drawImage(sprites.plant, x + 70, plazaY + plazaH - 20);
      }

      // Outer trim
      fillRect(g, 8, buildY, W - 16, 2, PAL.molding);
      fillRect(g, 8, H - 10, W - 16, 2, PAL.molding);
      fillRect(g, 8, buildY, 2, H - 10 - buildY, PAL.molding);
      fillRect(g, W - 10, buildY, 2, H - 10 - buildY, PAL.molding);
      return canvas;
    }

    function drawInteriorDecor(g, def) {
      switch (def.id) {
        case 'bakery':
          for (let i = 0; i < 5; i++) {
            fillRect(g, 60 + i * 40, 90, 24, 14, '#8a4a30');
            fillRect(g, 62 + i * 40, 92, 20, 6, '#f4c77a');
          }
          break;
        case 'supermarket':
          for (let row = 0; row < 2; row++) {
            for (let i = 0; i < 7; i++) {
              fillRect(g, 40 + i * 34, 86 + row * 20, 26, 14, ['#5fae4a', '#e8955c', '#41a6f6', '#ffd75e'][(i + row) % 4]);
            }
          }
          break;
        case 'toy':
          for (let i = 0; i < 6; i++) {
            fillRect(g, 40 + i * 40, 90, 20, 20, ['#f26a7d', '#ffd75e', '#41a6f6', '#5fae4a'][i % 4]);
          }
          break;
        case 'restaurant':
          for (const x of [90, 190]) {
            fillRect(g, x, 100, 40, 24, '#3a2416');
            fillRect(g, x + 4, 102, 32, 4, '#f4ecd8');
          }
          break;
        case 'electronics':
          for (let i = 0; i < 5; i++) {
            fillRect(g, 50 + i * 46, 88, 36, 22, '#0c1622');
            fillRect(g, 52 + i * 46, 90, 32, 18, '#6be3ff');
          }
          break;
        case 'gift':
          for (let i = 0; i < 6; i++) {
            fillRect(g, 50 + i * 36, 92, 24, 20, ['#b98bff', '#ffb3e6', '#ffd75e'][i % 3]);
            fillRect(g, 50 + i * 36 + 10, 92, 4, 20, PAL.gold);
          }
          break;
        case 'butcher':
          for (let i = 0; i < 6; i++) {
            fillRect(g, 50 + i * 36, 86, 4, 10, '#8a8a8a');
            fillRect(g, 46 + i * 36, 96, 12, 16, '#c25b4a');
          }
          break;
        case 'fishing':
          for (let i = 0; i < 4; i++) {
            fillRect(g, 50 + i * 60, 90, 40, 18, '#1d3b4a');
            fillRect(g, 60 + i * 60, 96, 20, 8, '#9edcf0');
          }
          break;
        default:
          break;
      }
    }

    /** Shared layout for every walk-in store interior (counter position
     * matches the collider in AREAS so the look and the physics agree). */
    function renderGenericInteriorBackground(def) {
      const { canvas, g } = createLayer(CONFIG.WIDTH, CONFIG.HEIGHT);
      fillRect(g, 0, 0, CONFIG.WIDTH, CONFIG.HEIGHT, PAL.ink);
      fillRect(g, 8, 20, 304, 212, def.wall);
      for (let y = 24; y < 228; y += 12) fillRect(g, 12, y, 296, 6, def.roof);

      fillRect(g, 48, 56, 224, 24, PAL.ink);
      fillRect(g, 50, 58, 220, 20, def.accent);
      fillRect(g, 50, 58, 220, 3, 'rgba(255,255,255,0.2)');

      fillRect(g, 100, 28, 120, 14, def.sign);
      g.save();
      g.fillStyle = PAL.ink;
      g.font = 'bold 8px monospace';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(def.name, 160, 35, 116);
      g.restore();

      drawInteriorDecor(g, def);

      fillRect(g, 142, 210, 36, 20, PAL.ink);
      fillRect(g, 144, 212, 32, 18, PAL.wainscotPanel);
      return canvas;
    }

    function renderCosmeticsBackground() {
      const { canvas, g } = createLayer(CONFIG.WIDTH, CONFIG.HEIGHT);
      fillRect(g, 0, 0, CONFIG.WIDTH, CONFIG.HEIGHT, PAL.ink);
      fillRect(g, 8, 20, 304, 212, '#35254a');
      for (let y = 26; y < 228; y += 14) {
        for (let x = 14; x < 306; x += 14) fillRect(g, x, y, 5, 5, '#4b3466');
      }
      fillRect(g, 56, 62, 208, 16, PAL.plum);
      fillRect(g, 58, 64, 204, 12, PAL.goldDark);
      fillRect(g, 54, 118, 212, 10, PAL.woodDark);
      fillRect(g, 56, 120, 208, 8, PAL.wood);
      fillRect(g, 142, 210, 36, 20, PAL.ink);
      fillRect(g, 144, 212, 32, 18, PAL.wainscotPanel);
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

    function drawPlant(prop) {
      fillRect(ctx, prop.x + 2, prop.y + prop.h - 1, 8, 2, PAL.shadow);
      ctx.drawImage(sprites.plant, prop.x, prop.y);
    }

    function drawInteractBubble(time) {
      const bounce = Math.floor(time * 3) % 2;
      ctx.drawImage(sprites.bubble, dealer.x + 1, dealer.y - 13 - bounce);
    }

    /* ----- Frame ------------------------------------------------------ */

    /* ----- Train ------------------------------------------------------- */

    function drawWheel(cx, cy, r, spin) {
      fillRect(ctx, cx - r, cy - r, r * 2, r * 2, '#161616');
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
      fillRect(ctx, x + 2, top + h - 6, w - 4, 6, '#2a1a1f');
      fillRect(ctx, x, top + 4, w, h - 10, TRAIN_LIVERY.body);
      fillRect(ctx, x, top, w, 6, TRAIN_LIVERY.roof);
      fillRect(ctx, x, top + h - 10, w, 3, TRAIN_LIVERY.trim);

      let wx = x + 5;
      let wi = 0;
      while (wx + 9 <= x + w - 5) {
        fillRect(ctx, wx, top + 8, 9, 7, '#0c1622');
        fillRect(ctx, wx + 1, top + 9, 7, 5, lit ? TRAIN_LIVERY.window : '#2a3744');
        if ((wi + Math.round(centerX / 10)) % 2 === 0) fillRect(ctx, wx + 3, top + 10, 3, 4, '#241c30');
        wx += 13;
        wi++;
      }

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
      drawTrainCar(stationCenterX - 32, y, carW, carH, viewX, lit, 0);
      drawTrainCar(stationCenterX + 32, y, carW, carH, viewX, lit, 0);
    }

    function render(state, time) {
      if (state.areaType === 'town') {
        const viewX = Math.round(clamp(state.cameraX ?? 0, 0, TOWN_WORLD.width - CONFIG.WIDTH));
        ctx.drawImage(townBackground, viewX, 0, CONFIG.WIDTH, CONFIG.HEIGHT, 0, 0, CONFIG.WIDTH, CONFIG.HEIGHT);
        if (state.train && state.train.active) {
          drawTrain(state.train, viewX, time);
        } else {
          drawParkedTrain(TOWN_WORLD.stationLeft.centerX, viewX, time);
          drawParkedTrain(TOWN_WORLD.stationRight.centerX, viewX, time);
          drawPlayer(viewX);
        }
      } else if (state.areaType === 'cosmetics') {
        ctx.drawImage(cosmeticsBackground, 0, 0);
        drawPlayer();
      } else if (interiorBackgrounds[state.areaType]) {
        ctx.drawImage(interiorBackgrounds[state.areaType], 0, 0);
        drawPlayer();
      } else {
        ctx.drawImage(background, 0, 0);
        drawables.sort((a, b) => a.sortY - b.sortY);
        for (const drawable of drawables) drawable.draw(time);
        if (state.nearDealer && state.mode === MODE.OVERWORLD) drawInteractBubble(time);
      }
    }

    return { init, render };
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

      if (this.isBroke) this.message = 'Out of tokens! The house can spot you.';
      else if (this.selectedBet !== null) this.message = `Bet ${this.selectedBet} again? Ready to deal!`;
      else this.message = 'Place your bet!';

      this.#fire(this.isBroke ? 'broke' : 'betting');
      this.#emit();
      return true;
    }

    rebuy() {
      if (!this.isBroke) return false;
      this.balance = CONFIG.STARTING_BALANCE;
      this.message = `The house spots you ${CONFIG.STARTING_BALANCE}. Good luck!`;
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
      hand.push(this.#draw());
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
      els.rebuy.hidden = !game.isBroke;

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

  /* ========================================================================
     11. GAME CONTROLLER & MAIN LOOP
     ====================================================================== */

  const MODE = Object.freeze({ OVERWORLD: 'overworld', BLACKJACK: 'blackjack', COSMETICS: 'cosmetics' });
  const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

  function main() {
    const dom = {
      canvas: document.getElementById('game-canvas'),
      hudTokens: document.getElementById('hud-tokens'),
      hudBalance: document.getElementById('hud-balance'),
      prompt: document.getElementById('interact-prompt'),
      overlay: document.getElementById('blackjack'),
      cosmetics: document.getElementById('cosmetics'),
      help: document.getElementById('help'),
      songSelect: document.getElementById('song-select'),
      songValue: document.getElementById('song-value'),
      songCycle: document.getElementById('btn-song-cycle'),
    };

    const state = {
      mode: MODE.OVERWORLD,
      nearDealer: false,
      nearStation: false,
      nearCosmeticsClerk: false,
      promptVisible: false,
      promptText: '',
      areaType: 'casino',
      townIndex: 1,
      cameraX: 0,
      train: { active: false, worldX: 0, vx: 0, direction: 1, targetX: 0, phase: 'idle' },
    };

    const GENERIC_SHOP_ROOM = Object.freeze({ x: 8, y: 20, w: 304, h: 212 });
    const GENERIC_SHOP_COLLIDERS = Object.freeze([{ x: 50, y: 58, w: 220, h: 20 }]);
    const GENERIC_SHOP_SPAWN = Object.freeze({ x: 154, y: 194 });

    function genericShopArea() {
      return Object.freeze({ room: GENERIC_SHOP_ROOM, colliders: GENERIC_SHOP_COLLIDERS, spawn: GENERIC_SHOP_SPAWN });
    }

    const AREAS = Object.freeze({
      casino: Object.freeze({ room: { x: 8, y: 40, w: 304, h: 192 }, colliders: COLLIDERS, spawn: { x: 154, y: 196 } }),
      town: Object.freeze({
        room: { x: 8, y: 20, w: TOWN_WORLD.width - 16, h: 212 },
        colliders: [
          { x: 8, y: 20, w: TOWN_WORLD.width - 16, h: 3 },
          { x: 8, y: 229, w: TOWN_WORLD.width - 16, h: 3 },
          { x: 8, y: 20, w: 3, h: 212 },
          { x: TOWN_WORLD.width - 11, y: 20, w: 3, h: 212 },
        ],
        spawn: { x: STORE_DEFS[0].x + STORE_DEFS[0].w / 2, y: 150 },
      }),
      cosmetics: Object.freeze({
        room: { x: 8, y: 20, w: 304, h: 212 },
        colliders: [{ x: 54, y: 116, w: 212, h: 12 }],
        spawn: { x: 154, y: 194 },
      }),
      butcher: genericShopArea(),
      fishing: genericShopArea(),
      bakery: genericShopArea(),
      supermarket: genericShopArea(),
      toy: genericShopArea(),
      restaurant: genericShopArea(),
      electronics: genericShopArea(),
      gift: genericShopArea(),
    });

    function defaultProgress() {
      return {
        owned: ['hat-none', 'outfit-classic', 'song-townBreeze'],
        equipped: { hat: 'hat-none', outfit: 'outfit-classic', song: 'song-townBreeze' },
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
        return { owned: [...owned], equipped };
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

    let lastBalance = CONFIG.STARTING_BALANCE;
    let ui = null;
    let cosmeticsUI = null;
    let hasVisitedTable = false;
    let lastStepIndex = 0;
    let cosmeticMessage = 'Buy and equip styles and area songs.';

    const blackjack = new BlackjackGame({
      startingBalance: CONFIG.STARTING_BALANCE,
      onChange: (game) => {
        ui?.render();
        cosmeticsUI?.render();
        updateHudBalance(game.balance);
      },
      onEvent: handleGameEvent,
    });

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
          sound.voice.say('broke', {}, { delay: 500, priority: 2 });
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
      const hitbox = () => player.hitbox;

      if (dx !== 0) {
        player.x += dx;
        let box = hitbox();
        player.x += clamp(box.x, area.room.x, area.room.x + area.room.w - box.w) - box.x;
        for (const solid of area.colliders) {
          box = hitbox();
          if (!rectsOverlap(box, solid)) continue;
          player.x += dx > 0 ? solid.x - (box.x + box.w) : solid.x + solid.w - box.x;
        }
      }
      if (dy !== 0) {
        player.y += dy;
        let box = hitbox();
        player.y += clamp(box.y, area.room.y, area.room.y + area.room.h - box.h) - box.y;
        for (const solid of area.colliders) {
          box = hitbox();
          if (!rectsOverlap(box, solid)) continue;
          player.y += dy > 0 ? solid.y - (box.y + box.h) : solid.y + solid.h - box.y;
        }
      }
    }

    let arrivalMessage = '';
    let arrivalMessageUntil = 0;

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
      ui.open();
      sound.sfx.play('uiOpen');
      if (blackjack.isBroke) {
        hasVisitedTable = true;
        sound.voice.say('broke', {}, { priority: 3, delay: 250 });
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

    const INTERIOR_AREAS = new Set(['cosmetics', 'butcher', 'fishing', 'bakery', 'supermarket', 'toy', 'restaurant', 'electronics', 'gift']);

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
        setArea('town', { x: storeDoorX(state.areaType) - player.w / 2, y: 110 });
      }
    }

    function handleCasinoExit() {
      const box = player.hitbox;
      const exitDoor = { x: 144, y: 228, w: 32, h: 8 };
      if (rectsOverlap(box, exitDoor)) {
        setArea('town', { x: storeDoorX('casino') - player.w / 2, y: 110 });
      }
    }

    function nearestStation() {
      const left = TOWN_WORLD.stationLeft;
      const right = TOWN_WORLD.stationRight;
      const distLeft = Math.abs(player.center.x - left.centerX);
      const distRight = Math.abs(player.center.x - right.centerX);
      return distLeft <= distRight ? { ...left, key: 'left' } : { ...right, key: 'right' };
    }

    function nearStationDistance() {
      const station = nearestStation();
      return { station, dist: Math.hypot(player.center.x - station.centerX, player.center.y - TOWN_WORLD.trackY) };
    }

    function updateCamera(dt) {
      if (state.train.active) return; // the camera already follows the train in updateTrain
      const desired = clamp(player.x + player.w / 2 - CONFIG.WIDTH / 2, 0, TOWN_WORLD.width - CONFIG.WIDTH);
      const smoothing = 1 - Math.exp(-dt * 6);
      state.cameraX += (desired - state.cameraX) * smoothing;
    }

    /** Depart from the nearest station, accelerate down the line, brake
     * smoothly into the opposite platform, then flip towns on arrival. */
    function beginTrainRide() {
      if (blackjack.balance < TRAIN_FARE) {
        sound.sfx.play('denied');
        setPrompt(true, `Need ${TRAIN_FARE} tokens for train`);
        return;
      }
      if (!blackjack.spendTokens(TRAIN_FARE)) {
        sound.sfx.play('denied');
        return;
      }
      const { station } = nearStationDistance();
      const target = station.key === 'left' ? TOWN_WORLD.stationRight : TOWN_WORLD.stationLeft;
      state.train.active = true;
      state.train.worldX = station.centerX;
      state.train.vx = 0;
      state.train.direction = target.centerX >= station.centerX ? 1 : -1;
      state.train.targetX = target.centerX;
      state.train.phase = 'depart';
      Input.clear();
      player.moving = false;
      setPrompt(false);
      sound.sfx.play('shuffle');
    }

    function updateTrain(dt) {
      const train = state.train;
      const MAX_SPEED = 260; // world px/sec
      const ACCEL = 220;
      const BRAKE = 260;
      const remaining = (train.targetX - train.worldX) * train.direction;
      const brakingDistance = (train.vx * train.vx) / (2 * BRAKE) + 20;

      if (remaining <= brakingDistance) {
        train.phase = 'brake';
        train.vx = Math.max(0, train.vx - BRAKE * dt);
      } else {
        train.phase = train.vx < MAX_SPEED ? 'depart' : 'cruise';
        train.vx = Math.min(MAX_SPEED, train.vx + ACCEL * dt);
      }

      train.worldX += train.direction * train.vx * dt;
      state.cameraX = clamp(train.worldX - CONFIG.WIDTH / 2, 0, TOWN_WORLD.width - CONFIG.WIDTH);

      if (remaining - train.vx * dt <= 1.5 && train.vx <= 4) arriveTrain();
    }

    function arriveTrain() {
      const train = state.train;
      const arrivedAtLeft = train.direction < 0;
      train.active = false;
      train.vx = 0;
      state.townIndex = state.townIndex === 1 ? 2 : 1;
      const spawnX = arrivedAtLeft ? TOWN_WORLD.stationLeft.centerX + 26 : TOWN_WORLD.stationRight.centerX - 26;
      player.x = spawnX - player.w / 2;
      player.y = 150;
      state.cameraX = clamp(player.x + player.w / 2 - CONFIG.WIDTH / 2, 0, TOWN_WORLD.width - CONFIG.WIDTH);
      arrivalMessage = `Arrived at Town ${state.townIndex}`;
      arrivalMessageUntil = performance.now() + 2200;
      sound.sfx.play('payout');
    }

    function handleKeyDown(event) {
      if (sound.isSettingsOpen()) return;
      if (state.mode === MODE.BLACKJACK) {
        ui.handleKey(event);
        return;
      }
      if (state.mode === MODE.COSMETICS) {
        if ((event.code === 'Escape' || event.code === 'KeyE') && !event.repeat) {
          event.preventDefault();
          closeCosmetics();
        }
        return;
      }

      if (SCROLL_KEYS.has(event.code)) event.preventDefault();
      const isInteract = event.code === 'KeyE' || event.code === 'Space';
      if (!isInteract || event.repeat) return;

      if (state.areaType === 'casino' && state.nearDealer) {
        openBlackjack();
      } else if (state.areaType === 'cosmetics' && state.nearCosmeticsClerk) {
        openCosmetics();
      } else if (state.areaType === 'town' && state.nearStation) {
        beginTrainRide();
      }
    }

    function update(dt) {
      const frozen = sound.isSettingsOpen();

      if (state.areaType === 'town' && state.train.active) {
        if (!frozen) updateTrain(dt);
      } else if (state.mode === MODE.OVERWORLD && !frozen) {
        const move = Input.getMoveVector();
        player.moving = move.x !== 0 || move.y !== 0;
        if (player.moving) {
          player.walkTime += dt;
          const step = CONFIG.PLAYER_SPEED * dt;
          if (state.areaType === 'casino') Collision.moveAndCollide(player, move.x * step, move.y * step);
          else moveWithAreaColliders(move.x * step, move.y * step);

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
      } else if (frozen) {
        player.moving = false;
      }

      if (state.areaType === 'town') updateCamera(dt);

      state.nearDealer = state.areaType === 'casino' && Collision.isWithinRange(player.center, dealer.center, CONFIG.INTERACT_RADIUS);
      state.nearCosmeticsClerk = state.areaType === 'cosmetics' && Collision.distance(player.center, { x: 160, y: 68 }) <= 44;
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
      } else if (state.nearDealer) {
        setPrompt(true, 'Press <kbd>E</kbd> or <kbd>Space</kbd> to play');
      } else if (state.nearCosmeticsClerk) {
        setPrompt(true, 'Press <kbd>E</kbd> or <kbd>Space</kbd> to shop');
      } else if (state.nearStation) {
        setPrompt(true, `Press <kbd>E</kbd> to board (${TRAIN_FARE})`);
      } else {
        setPrompt(false);
      }

      applyAreaMusicTheme();
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
