/* ==========================================================================
   Lucky Pixel Lounge — audio system
   --------------------------------------------------------------------------
   Zero asset files: everything is synthesized at runtime.
     - Music + SFX  -> Web Audio API (procedural, scheduled with look-ahead)
     - Dealer voice -> Web Speech API (speechSynthesis)

   Loaded before script.js and exposes a single global: window.CasinoAudio

   Sections:
     1. Config
     2. Settings store (volume / mute, persisted in localStorage)
     3. Core (AudioContext, buses, reverb, noise buffers)
     4. Synthesis helpers (tone / noise)
     5. SFX library
     6. Music (generative ambient classical, seamless by construction)
     7. Ambience (room tone + distant casino sounds)
     8. Dealer voice (line bank + speech queue)
     9. Settings UI (DOM panel, keyboard shortcuts, UI sounds)
    10. Public API & unlock
   ========================================================================== */

(() => {
  'use strict';

  /* ========================================================================
     1. CONFIG
     ====================================================================== */

  const STORAGE_KEY = 'luckyPixelLounge.audio.v1';
  const CHANNELS = Object.freeze(['master', 'music', 'sfx', 'voice']);

  /** Subtle music by default so effects and the dealer stay in front. */
  const DEFAULT_SETTINGS = Object.freeze({
    master: Object.freeze({ volume: 0.8, muted: false }),
    music: Object.freeze({ volume: 0.5, muted: false }),
    sfx: Object.freeze({ volume: 0.8, muted: false }),
    voice: Object.freeze({ volume: 1, muted: false }),
  });

  const MUSIC_TRIM = 0.55; // extra headroom on the music bus
  const MUSIC_BPM = 62; // slow waltz
  const MUSIC_LOOKAHEAD_S = 2.0; // how far ahead notes are scheduled
  const MUSIC_TICK_MS = 400; // scheduler wake-up interval

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const rand = (min, max) => min + Math.random() * (max - min);
  const midiToHz = (midi) => 440 * 2 ** ((midi - 69) / 12);
  /** Perceptual volume curve: slider position -> linear gain. */
  const taper = (v) => v ** 1.5;

  /* ========================================================================
     2. SETTINGS STORE
     ====================================================================== */

  const Settings = (() => {
    const listeners = new Set();
    const state = load();

    function load() {
      const next = Object.fromEntries(CHANNELS.map((ch) => [ch, { ...DEFAULT_SETTINGS[ch] }]));
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
        if (saved && typeof saved === 'object') {
          for (const ch of CHANNELS) {
            const entry = saved[ch];
            if (!entry || typeof entry !== 'object') continue;
            if (Number.isFinite(entry.volume)) next[ch].volume = clamp01(entry.volume);
            if (typeof entry.muted === 'boolean') next[ch].muted = entry.muted;
          }
        }
      } catch {
        /* storage unavailable or corrupt: fall back to defaults */
      }
      return next;
    }

    function save() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        /* private mode / quota: settings just won't persist */
      }
    }

    /** Linear gain for one channel on its own (0 when muted). */
    const level = (channel) => (state[channel].muted ? 0 : taper(state[channel].volume));

    /** Gain actually heard: channel level scaled by master. */
    const effective = (channel) => (channel === 'master' ? level('master') : level('master') * level(channel));

    function set(channel, patch) {
      const entry = state[channel];
      if (!entry) return;
      if (Number.isFinite(patch.volume)) entry.volume = clamp01(patch.volume);
      if (typeof patch.muted === 'boolean') entry.muted = patch.muted;
      save();
      listeners.forEach((fn) => fn(channel));
    }

    return {
      get: (channel) => ({ ...state[channel] }),
      set,
      level,
      effective,
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
  })();

  /* ========================================================================
     3. CORE — AudioContext, buses and shared buffers

        music ──┬──────────────► master ─► limiter ─► speakers
                └─► reverb ─► wet ─►┘
        sfx ───────────────────►┘
     ====================================================================== */

  const Core = (() => {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    const supported = typeof Ctor === 'function';

    let ctx = null;
    let nodes = null;
    let noiseBuffer = null;
    let brownBuffer = null;

    function makeNoise(seconds, kind) {
      const length = Math.floor(ctx.sampleRate * seconds);
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      let last = 0;
      for (let i = 0; i < length; i++) {
        const white = Math.random() * 2 - 1;
        if (kind === 'brown') {
          last = (last + 0.02 * white) / 1.02;
          data[i] = last * 3.5;
        } else {
          data[i] = white;
        }
      }
      return buffer;
    }

    /** Synthetic room impulse response: decaying stereo noise. */
    function makeImpulse(seconds, decay) {
      const length = Math.floor(ctx.sampleRate * seconds);
      const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
      for (let c = 0; c < 2; c++) {
        const data = buffer.getChannelData(c);
        for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** decay;
      }
      return buffer;
    }

    function create() {
      ctx = new Ctor({ latencyHint: 'interactive' });

      const master = ctx.createGain();
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -12;
      limiter.knee.value = 24;
      limiter.ratio.value = 6;
      limiter.attack.value = 0.005;
      limiter.release.value = 0.25;
      master.connect(limiter);
      limiter.connect(ctx.destination);

      const music = ctx.createGain();
      const sfx = ctx.createGain();
      const reverb = ctx.createConvolver();
      reverb.buffer = makeImpulse(2.8, 2.4);
      const wet = ctx.createGain();
      wet.gain.value = 0.45;

      music.connect(master);
      music.connect(reverb);
      reverb.connect(wet);
      wet.connect(master);
      sfx.connect(master);

      noiseBuffer = makeNoise(2, 'white');
      brownBuffer = makeNoise(6, 'brown');
      nodes = { master, music, sfx };
      applyVolumes(true);
    }

    function applyVolumes(immediate = false) {
      if (!ctx) return;
      const set = (param, value) =>
        immediate ? param.setValueAtTime(value, ctx.currentTime) : param.setTargetAtTime(value, ctx.currentTime, 0.04);
      set(nodes.master.gain, Settings.level('master'));
      set(nodes.music.gain, Settings.level('music') * MUSIC_TRIM);
      set(nodes.sfx.gain, Settings.level('sfx'));
    }

    /** Create/resume the context. Must run inside a user gesture. */
    async function unlock() {
      if (!supported) return false;
      if (!ctx) create();
      if (ctx.state === 'suspended') {
        try {
          await ctx.resume();
        } catch {
          return false;
        }
      }
      return ctx.state === 'running';
    }

    return {
      supported,
      unlock,
      applyVolumes,
      get ctx() { return ctx; },
      get nodes() { return nodes; },
      get noise() { return noiseBuffer; },
      get brown() { return brownBuffer; },
      get ready() { return ctx !== null; },
      now: () => ctx.currentTime,
      suspend: () => ctx?.state === 'running' && ctx.suspend().catch(() => {}),
      resume: () => ctx?.state === 'suspended' && ctx.resume().catch(() => {}),
    };
  })();

  Settings.subscribe(() => Core.applyVolumes());

  /* ========================================================================
     4. SYNTHESIS HELPERS
     ====================================================================== */

  /** One-shot oscillator with an attack/exponential-decay envelope. */
  function tone(t, { freq, freqEnd, dur = 0.1, type = 'sine', gain = 0.2, attack = 0.003, out }) {
    const ctx = Core.ctx;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (freqEnd) osc.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.linearRampToValueAtTime(gain, t + attack);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(amp).connect(out ?? Core.nodes.sfx);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }

  /** One-shot filtered noise burst (cards, footsteps, whooshes). */
  function noise(t, { dur = 0.05, type = 'bandpass', freq = 3000, freqEnd, q = 1, gain = 0.3, attack = 0.002, out }) {
    const ctx = Core.ctx;
    const src = ctx.createBufferSource();
    src.buffer = Core.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(freq, t);
    if (freqEnd) filter.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.linearRampToValueAtTime(gain, t + attack);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(amp).connect(out ?? Core.nodes.sfx);
    const offset = Math.random() * (Core.noise.duration - dur - 0.1);
    src.start(t, offset, dur + 0.03);
  }

  /** A metallic chip "clink": three inharmonic partials + a tiny click. */
  function clink(t, { pitch = 1, gain = 1, out } = {}) {
    const partials = [
      [2400, 0.09, 0.16],
      [3550, 0.06, 0.11],
      [5200, 0.035, 0.07],
    ];
    for (const [freq, g, dur] of partials) {
      tone(t, { freq: freq * pitch, dur, type: 'sine', gain: g * gain, attack: 0.001, out });
    }
    noise(t, { dur: 0.012, type: 'highpass', freq: 5000, gain: 0.06 * gain, attack: 0.0005, out });
  }

  function chipStack(t, count, spacing = 0.055, gain = 1) {
    tone(t, { freq: 170, freqEnd: 90, dur: 0.05, type: 'sine', gain: 0.07 * gain, attack: 0.001 });
    for (let i = 0; i < count; i++) {
      clink(t + i * spacing + rand(0, 0.01), { pitch: rand(0.9, 1.2), gain: rand(0.7, 1) * gain });
    }
  }

  function cardTap(t, gain = 1) {
    noise(t, { dur: 0.04, type: 'lowpass', freq: 900, gain: 0.2 * gain, attack: 0.001 });
    tone(t, { freq: 160, freqEnd: 80, dur: 0.05, type: 'sine', gain: 0.1 * gain, attack: 0.001 });
  }

  function footstep(t, freq) {
    noise(t, { dur: 0.09, type: 'lowpass', freq: freq * rand(0.9, 1.1), q: 0.7, gain: 0.2, attack: 0.004 });
    tone(t, { freq: 110, freqEnd: 70, dur: 0.06, type: 'sine', gain: 0.1, attack: 0.002 });
  }

  /* ========================================================================
     5. SFX LIBRARY
     Each entry receives the (absolute) start time on the audio clock.
     ====================================================================== */

  const SOUNDS = {
    /* ----- UI ----- */
    uiClick(t) {
      tone(t, { freq: 900, freqEnd: 600, dur: 0.05, type: 'square', gain: 0.045 });
      noise(t, { dur: 0.02, type: 'highpass', freq: 3000, gain: 0.05 });
    },
    uiHover(t) {
      tone(t, { freq: 1400, dur: 0.025, type: 'square', gain: 0.016 });
    },
    uiOpen(t) {
      noise(t, { dur: 0.2, type: 'bandpass', freq: 500, freqEnd: 2200, q: 1.2, gain: 0.12, attack: 0.05 });
      tone(t, { freq: 520, freqEnd: 780, dur: 0.12, type: 'triangle', gain: 0.07 });
    },
    uiClose(t) {
      noise(t, { dur: 0.2, type: 'bandpass', freq: 2200, freqEnd: 500, q: 1.2, gain: 0.12, attack: 0.03 });
      tone(t, { freq: 780, freqEnd: 520, dur: 0.12, type: 'triangle', gain: 0.07 });
    },
    denied(t) {
      tone(t, { freq: 150, dur: 0.09, type: 'sawtooth', gain: 0.07 });
      tone(t + 0.1, { freq: 120, dur: 0.12, type: 'sawtooth', gain: 0.07 });
    },
    prompt(t) {
      tone(t, { freq: 988, dur: 0.07, type: 'square', gain: 0.035 });
      tone(t + 0.07, { freq: 1319, dur: 0.1, type: 'square', gain: 0.035 });
    },

    /* ----- Movement ----- */
    footstepLeft: (t) => footstep(t, 420),
    footstepRight: (t) => footstep(t, 520),

    /* ----- Cards ----- */
    cardDeal(t) {
      noise(t, { dur: 0.075, type: 'highpass', freq: rand(1800, 2600), gain: 0.3, attack: 0.001 });
      noise(t, { dur: 0.05, type: 'bandpass', freq: 1100, q: 0.7, gain: 0.14, attack: 0.001 });
      tone(t, { freq: 200, freqEnd: 90, dur: 0.05, type: 'sine', gain: 0.1, attack: 0.001 });
    },
    cardFlip(t) {
      noise(t, { dur: 0.11, type: 'bandpass', freq: 2000, freqEnd: 5500, q: 0.8, gain: 0.22, attack: 0.004 });
      cardTap(t + 0.1, 0.6);
    },
    shuffle(t) {
      // Riffle: dense rising bursts
      const riffle = 22;
      for (let i = 0; i < riffle; i++) {
        const k = i / riffle;
        noise(t + i * 0.034 + rand(0, 0.008), {
          dur: 0.04,
          type: 'bandpass',
          freq: 2600 + k * 2600,
          q: 0.9,
          gain: 0.14 + 0.08 * Math.sin(k * Math.PI),
          attack: 0.001,
        });
      }
      // Bridge: cards cascading down
      for (let i = 0; i < 14; i++) {
        noise(t + 0.85 + i * 0.028 + rand(0, 0.006), {
          dur: 0.035,
          type: 'bandpass',
          freq: 4800 - i * 150,
          q: 0.9,
          gain: 0.1,
          attack: 0.001,
        });
      }
      // Square up the deck
      cardTap(t + 1.35);
      cardTap(t + 1.47, 0.8);
    },

    /* ----- Chips ----- */
    bet: (t) => chipStack(t, 2),
    chips: (t) => chipStack(t, 3),
    payout: (t) => chipStack(t, 6, 0.05),

    /* ----- Results ----- */
    win(t) {
      chipStack(t, 7, 0.05);
      [1047, 1319, 1568].forEach((freq, i) => tone(t + 0.05 + i * 0.09, { freq, dur: 0.35, type: 'triangle', gain: 0.08 }));
    },
    blackjack(t) {
      [523, 659, 784, 1047, 1319, 1568].forEach((freq, i) =>
        tone(t + i * 0.07, { freq, dur: 0.45, type: 'triangle', gain: 0.09 }),
      );
      chipStack(t + 0.35, 9, 0.05);
    },
    lose(t) {
      tone(t, { freq: 262, freqEnd: 196, dur: 0.45, type: 'triangle', gain: 0.11 });
      tone(t + 0.2, { freq: 196, freqEnd: 147, dur: 0.6, type: 'triangle', gain: 0.1 });
    },
    bust(t) {
      tone(t, { freq: 130, freqEnd: 55, dur: 0.35, type: 'sine', gain: 0.3 });
      noise(t, { dur: 0.15, type: 'lowpass', freq: 400, gain: 0.25 });
      SOUNDS.lose(t + 0.15);
    },
    push(t) {
      tone(t, { freq: 523, dur: 0.12, type: 'triangle', gain: 0.08 });
      tone(t + 0.14, { freq: 523, dur: 0.2, type: 'triangle', gain: 0.08 });
    },

    /* ----- Distant ambience (quiet, low-passed) ----- */
    distantSlot(t) {
      const far = Core.ctx.createBiquadFilter();
      far.type = 'lowpass';
      far.frequency.value = 2200;
      far.connect(Core.nodes.sfx);
      const scale = [784, 988, 1175, 1319, 1568];
      const count = 3 + Math.floor(Math.random() * 3);
      for (let i = 0; i < count; i++) {
        tone(t + i * 0.09, { freq: scale[Math.floor(Math.random() * scale.length)], dur: 0.2, type: 'triangle', gain: 0.03, out: far });
      }
    },
    distantChips(t) {
      const far = Core.ctx.createBiquadFilter();
      far.type = 'lowpass';
      far.frequency.value = 3000;
      far.connect(Core.nodes.sfx);
      const count = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < count; i++) clink(t + i * 0.07, { pitch: rand(0.9, 1.1), gain: 0.25, out: far });
    },
  };

  const Sfx = {
    /**
     * @param {string} name   key in SOUNDS
     * @param {{delay?: number}} [opts]  delay in seconds
     */
    play(name, opts = {}) {
      if (!Core.ready) return;
      const sound = SOUNDS[name];
      if (!sound) {
        console.warn(`[audio] unknown sfx "${name}"`);
        return;
      }
      if (Settings.effective('sfx') <= 0) return;
      sound(Core.now() + (opts.delay ?? 0) + 0.01);
    },
  };

  /* ========================================================================
     6. MUSIC — generative ambient classical
     A slow 3/4 piece in the spirit of Satie's Gymnopédies: a low bass note,
     soft chords on beats 2 and 3, a sparse wandering melody and a faint
     string pad, over an 8-bar chord loop. Notes are scheduled continuously
     with a look-ahead timer, so the loop never has an audible seam, and
     the melody differs a little every pass.
     ====================================================================== */

  const Music = (() => {
    const CHORDS = Object.freeze({
      Gmaj7: { bass: 43, pad: [59, 62, 66], melody: [71, 74, 76, 78, 79] },
      Dmaj7: { bass: 38, pad: [57, 61, 66], melody: [69, 73, 74, 76, 78] },
      Em7: { bass: 40, pad: [55, 59, 62], melody: [71, 74, 76, 78, 79] },
      A7: { bass: 45, pad: [55, 61, 64], melody: [69, 71, 73, 74, 76] },
      Bm7: { bass: 47, pad: [57, 62, 66], melody: [71, 73, 74, 76, 78] },
      Fmaj7: { bass: 41, pad: [57, 60, 64], melody: [69, 72, 74, 76, 77] },
      Cmaj7: { bass: 36, pad: [55, 59, 64], melody: [67, 71, 72, 74, 76] },
      Am7: { bass: 45, pad: [57, 60, 64], melody: [69, 71, 72, 74, 76] },
      Dm7: { bass: 38, pad: [53, 57, 60], melody: [65, 69, 70, 72, 74] },
      E7: { bass: 40, pad: [56, 59, 64], melody: [68, 71, 73, 74, 76] },
      Amaj7: { bass: 45, pad: [57, 61, 64], melody: [69, 73, 76, 78, 80] },
      C7: { bass: 36, pad: [52, 58, 62], melody: [67, 70, 72, 74, 76] },
      Fm7: { bass: 41, pad: [56, 60, 63], melody: [68, 71, 73, 75, 76] },
      Bb7: { bass: 46, pad: [58, 62, 65], melody: [70, 72, 74, 75, 77] },
      Gm7: { bass: 43, pad: [58, 62, 65], melody: [70, 72, 74, 75, 77] },
    });

    const THEMES = Object.freeze({
      casinoClassic: Object.freeze({ bpm: 62, progression: ['Gmaj7', 'Dmaj7', 'Gmaj7', 'Dmaj7', 'Em7', 'A7', 'Dmaj7', 'Bm7'] }),
      townBreeze: Object.freeze({ bpm: 74, progression: ['Dmaj7', 'Bm7', 'Gmaj7', 'A7', 'Dmaj7', 'A7', 'Gmaj7', 'Dmaj7'] }),
      townNeon: Object.freeze({ bpm: 68, progression: ['Am7', 'Em7', 'Fmaj7', 'Cmaj7', 'Am7', 'Em7', 'Fmaj7', 'E7'] }),
      cosmeticsBoutique: Object.freeze({ bpm: 82, progression: ['Cmaj7', 'Am7', 'Fmaj7', 'Gmaj7', 'Cmaj7', 'Am7', 'Dm7', 'Gmaj7'] }),
      butcherLow: Object.freeze({ bpm: 58, progression: ['Fm7', 'C7', 'Fm7', 'Bb7', 'Fm7', 'C7', 'Gm7', 'C7'] }),
      fishingDrift: Object.freeze({ bpm: 64, progression: ['Amaj7', 'Em7', 'Dmaj7', 'Amaj7', 'Bm7', 'Em7', 'Amaj7', 'Dmaj7'] }),
      stationPulse: Object.freeze({ bpm: 92, progression: ['Em7', 'A7', 'Dmaj7', 'Bm7', 'Em7', 'A7', 'Gmaj7', 'A7'] }),
      bakeryWarm: Object.freeze({ bpm: 70, progression: ['Fmaj7', 'Cmaj7', 'Dm7', 'Fmaj7', 'Cmaj7', 'Am7', 'Fmaj7', 'Cmaj7'] }),
      marketHop: Object.freeze({ bpm: 96, progression: ['Cmaj7', 'Am7', 'Dm7', 'Gmaj7', 'Cmaj7', 'Am7', 'Fmaj7', 'Gmaj7'] }),
      toyBox: Object.freeze({ bpm: 104, progression: ['Gmaj7', 'Em7', 'Cmaj7', 'Dmaj7', 'Gmaj7', 'Em7', 'Am7', 'Dmaj7'] }),
      dinerGlow: Object.freeze({ bpm: 88, progression: ['Am7', 'Dm7', 'E7', 'Am7', 'Fmaj7', 'Dm7', 'E7', 'Am7'] }),
      electroPulse: Object.freeze({ bpm: 112, progression: ['Em7', 'Cmaj7', 'Gmaj7', 'Dmaj7', 'Am7', 'Cmaj7', 'Em7', 'Dmaj7'] }),
      giftWaltz: Object.freeze({ bpm: 78, progression: ['Amaj7', 'Dmaj7', 'Bm7', 'Em7', 'Amaj7', 'Dmaj7', 'Em7', 'A7'] }),
    });

    const DEFAULT_THEME = 'casinoClassic';
    let currentTheme = DEFAULT_THEME;

    /** Soft piano-ish note: sine fundamental + quiet overtones, low-passed. */
    function piano(freq, t, dur, vel) {
      const ctx = Core.ctx;
      const out = ctx.createGain();
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = Math.min(freq * 5, 4500);
      out.gain.setValueAtTime(0.0001, t);
      out.gain.linearRampToValueAtTime(vel, t + 0.012);
      out.gain.exponentialRampToValueAtTime(vel * 0.35, t + 0.4);
      out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      out.connect(lp).connect(Core.nodes.music);

      for (const [mult, level, type] of [[1, 1, 'sine'], [2, 0.3, 'sine'], [3, 0.1, 'sine'], [1, 0.25, 'triangle']]) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = type;
        osc.frequency.value = freq * mult;
        g.gain.value = level;
        osc.connect(g).connect(out);
        osc.start(t);
        osc.stop(t + dur + 0.05);
      }
    }

    /** Slow-attack pad: two slightly detuned sines per note. */
    function pad(freq, t, dur, vel) {
      const ctx = Core.ctx;
      const out = ctx.createGain();
      out.gain.setValueAtTime(0.0001, t);
      out.gain.linearRampToValueAtTime(vel, t + 0.9);
      out.gain.setValueAtTime(vel, t + dur - 0.9);
      out.gain.linearRampToValueAtTime(0.0001, t + dur + 0.6);
      out.connect(Core.nodes.music);
      for (const detune of [-5, 5]) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;
        osc.detune.value = detune;
        osc.connect(out);
        osc.start(t);
        osc.stop(t + dur + 0.7);
      }
    }

    let melodyIndex = 2;

    function scheduleBar(chordName, t, beat) {
      const chord = CHORDS[chordName];
      if (!chord) return;
      const human = () => rand(-0.012, 0.012);
      const bar = beat * 3;

      // Beat 1: bass
      piano(midiToHz(chord.bass), t, beat * 2.8, 0.3);

      // Beats 2 & 3: soft chord, slightly rolled
      chord.pad.forEach((note, i) => {
        piano(midiToHz(note), t + beat + i * 0.014 + human(), beat * 2, 0.09);
        piano(midiToHz(note), t + beat * 2 + i * 0.014 + human(), beat * 1.6, 0.055);
      });

      // Sustained pad (an octave below the chord for warmth)
      chord.pad.forEach((note) => pad(midiToHz(note - 12), t, bar, 0.025));

      // Melody: stepwise wander through the chord's note pool
      const pool = chord.melody;
      const playMelody = (beatOffset, chance, vel) => {
        if (Math.random() > chance) return;
        melodyIndex = Math.max(0, Math.min(pool.length - 1, melodyIndex + Math.floor(rand(-2, 3))));
        piano(midiToHz(pool[melodyIndex]), t + beatOffset * beat + human(), beat * 2.4, vel);
      };
      playMelody(0, 0.85, 0.16);
      playMelody(2, 0.5, 0.12);
    }

    let timer = null;
    let nextBar = 0;
    let barIndex = 0;

    function barDuration(theme) {
      return (60 / theme.bpm) * 3;
    }

    function tick() {
      while (nextBar < Core.now() + MUSIC_LOOKAHEAD_S) {
        const theme = THEMES[currentTheme] ?? THEMES[DEFAULT_THEME];
        const beat = 60 / theme.bpm;
        const progression = theme.progression;
        const chordName = progression[barIndex % progression.length];
        // Skip creating notes while muted; the clock still advances so
        // un-muting rejoins the loop on the next bar boundary.
        if (Settings.effective('music') > 0) scheduleBar(chordName, nextBar, beat);
        nextBar += barDuration(theme);
        barIndex++;
      }
    }

    return {
      start() {
        if (timer || !Core.ready) return;
        nextBar = Core.now() + 0.3;
        timer = setInterval(tick, MUSIC_TICK_MS);
        tick();
      },

      /** Short rolled Dmaj7 so the music slider has something to audition. */
      preview() {
        if (!Core.ready || Settings.effective('music') <= 0) return;
        const t = Core.now() + 0.02;
        [50, 57, 61, 66].forEach((note, i) => piano(midiToHz(note), t + i * 0.05, 1.6, 0.14));
      },

      setTheme(themeId) {
        if (!THEMES[themeId]) return false;
        currentTheme = themeId;
        return true;
      },

      getTheme() {
        return currentTheme;
      },

      listThemes() {
        return Object.keys(THEMES);
      },
    };
  })();

  /* ========================================================================
     7. AMBIENCE — room tone + occasional distant casino sounds
     ====================================================================== */

  const Ambience = (() => {
    let started = false;

    function startRoomTone() {
      const ctx = Core.ctx;
      const src = ctx.createBufferSource();
      src.buffer = Core.brown;
      src.loop = true;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 600;
      band.Q.value = 0.3;
      const amp = ctx.createGain();
      amp.gain.value = 0.02;

      // Slow swell, like a crowd murmuring in another room
      const lfo = ctx.createOscillator();
      const lfoDepth = ctx.createGain();
      lfo.frequency.value = 0.13;
      lfoDepth.gain.value = 0.008;
      lfo.connect(lfoDepth).connect(amp.gain);

      src.connect(band).connect(amp).connect(Core.nodes.sfx);
      src.start();
      lfo.start();
    }

    function scheduleDistant() {
      setTimeout(() => {
        if (!document.hidden && Core.ready && Settings.effective('sfx') > 0) {
          Sfx.play(Math.random() < 0.6 ? 'distantSlot' : 'distantChips');
        }
        scheduleDistant();
      }, rand(5000, 13000));
    }

    return {
      start() {
        if (started || !Core.ready) return;
        started = true;
        startRoomTone();
        scheduleDistant();
      },
    };
  })();

  /* ========================================================================
     8. DEALER VOICE
     A bank of lines keyed by game event. Lines may be strings or functions
     of a context object (e.g. the player's total). The speaker picks a
     random variant (never the same twice in a row), supports delays for
     natural pacing, and uses priorities so important lines interrupt
     idle chatter but not the other way around.
     ====================================================================== */

  const LINES = Object.freeze({
    welcome: [
      'Welcome to the Lucky Pixel Lounge. Take a seat, and place your bet.',
      'Good evening! Care for a hand of blackjack? Place your bet.',
      'Ah, a new face. Pull up a chair, and place your bet.',
    ],
    welcomeBack: [
      'Welcome back. Feeling lucky? Place your bet.',
      'Back for more? The cards are warm. Place your bet.',
      'Good to see you again. Bets, please.',
    ],
    placeBet: ['Place your bets.', 'Bets, please.', "What'll it be?", 'Whenever you are ready.'],
    shuffle: ['Fresh shoe. Shuffling.', 'Let me shuffle these up.', 'New cards coming up.'],
    yourMove: [
      ({ total }) => `You have ${total}. Hit or stand?`,
      ({ total }) => `${total}. Your move.`,
      ({ total }) => `Showing ${total}. Hit, or stand?`,
    ],
    hit: [({ total }) => `${total}.`, ({ total }) => `That makes ${total}.`, 'Card for the player.'],
    stand: ['Player stands. My turn.', 'Standing. Let us see what I have.', 'Alright. Turning over my card.'],
    dealerDraw: ['Dealer draws.', 'I will take a card.', 'One more card for the house.'],
    win: [
      ({ player, dealer }) => `You win, ${player} to ${dealer}. Well played.`,
      'Winner! Congratulations.',
      'The house pays. Nicely done.',
    ],
    dealerBust: ['Dealer busts! You win.', 'I bust. Congratulations.', 'Over twenty-one. The house loses this one.'],
    blackjack: [
      'Blackjack! Three to two.',
      'A natural twenty-one! Beautiful.',
      'Blackjack! The house pays three to two.',
    ],
    dealerBlackjack: ['Blackjack. The house takes it.', 'I have a natural. Sorry about that.'],
    lose: [
      ({ dealer, player }) => `The house wins, ${dealer} to ${player}.`,
      'Better luck next hand.',
      'Ooh, tough break.',
    ],
    bust: [
      ({ total }) => `Bust. ${total} is too many.`,
      'That is a bust. Tough luck.',
      'Too many, I am afraid.',
    ],
    push: ['Push. Your bet is returned.', 'A push. Nobody wins.', 'Tie. You keep your bet.'],
    broke: ['Out of tokens! Let me spot you a stack.', 'Tapped out? The house can help.'],
    rebuy: ['Here is a fresh stack. Do not spend it all at once.', 'On the house. Good luck.'],
    goodbye: ['Thanks for playing. Come back soon.', 'Good luck out there.', 'Take care. The table will be here.'],
    preview: ['Place your bets.'],
  });

  const Voice = (() => {
    const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
    const supported = Boolean(synth) && 'SpeechSynthesisUtterance' in window;

    const lastPicked = new Map();
    let voice = null;
    let pending = null; // { timer, priority }
    let current = null; // { utterance, priority }

    /** Prefer local, English, male-sounding voices for the dealer. */
    function chooseVoice() {
      if (!supported) return;
      const candidates = synth.getVoices().filter((v) => /^en([-_]|$)/i.test(v.lang));
      if (candidates.length === 0) return;
      const preferred = /daniel|alex|fred|george|arthur|david|mark|guy|james|oliver|male/i;
      const score = (v) =>
        (preferred.test(v.name) ? 10 : 0) + (v.localService ? 3 : 0) + (/^en[-_](US|GB)/i.test(v.lang) ? 1 : 0);
      voice = candidates.reduce((best, v) => (score(v) > score(best) ? v : best));
    }

    if (supported) {
      chooseVoice();
      synth.addEventListener?.('voiceschanged', chooseVoice);
    }

    function pickLine(key, args) {
      const pool = LINES[key];
      if (!pool || pool.length === 0) return null;
      let index = Math.floor(Math.random() * pool.length);
      if (pool.length > 1 && index === lastPicked.get(key)) {
        index = (index + 1 + Math.floor(Math.random() * (pool.length - 1))) % pool.length;
      }
      lastPicked.set(key, index);
      const line = pool[index];
      return typeof line === 'function' ? line(args) : line;
    }

    function clearPending() {
      if (pending) clearTimeout(pending.timer);
      pending = null;
    }

    function speak(text, priority) {
      if (synth.speaking && current && current.priority > priority) return; // don't talk over something important
      synth.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      }
      utterance.rate = 0.95;
      utterance.pitch = 0.8;
      utterance.volume = Settings.effective('voice');
      utterance.onend = utterance.onerror = () => {
        if (current?.utterance === utterance) current = null;
      };
      current = { utterance, priority };
      synth.speak(utterance);
    }

    return {
      supported,

      /**
       * @param {string} key  line bank key
       * @param {object} [args]  values for dynamic lines (e.g. {total: 17})
       * @param {{delay?: number, priority?: number, chance?: number}} [opts]
       *        delay in ms; priority 1 = chatter, 2 = results, 3 = greetings;
       *        chance 0..1 probability that the line is spoken at all.
       */
      say(key, args = {}, { delay = 0, priority = 1, chance = 1 } = {}) {
        if (!supported || !Core.ready) return;
        if (Settings.effective('voice') <= 0) return;
        if (Math.random() > chance) return;
        if (pending && pending.priority > priority) return;

        const text = pickLine(key, args);
        if (!text) return;

        clearPending();
        if (delay > 0) {
          const timer = setTimeout(() => {
            pending = null;
            speak(text, priority);
          }, delay);
          pending = { timer, priority };
        } else {
          speak(text, priority);
        }
      },

      stop() {
        if (!supported) return;
        clearPending();
        current = null;
        synth.cancel();
      },
    };
  })();

  Settings.subscribe(() => {
    if (Settings.effective('voice') <= 0) Voice.stop();
  });

  /* ========================================================================
     9. SETTINGS UI
     Wires the #settings dialog, the gear buttons ([data-open-settings]),
     global UI sounds (click / hover) and the M mute shortcut.
     ====================================================================== */

  const SettingsUI = (() => {
    const toggleListeners = new Set();
    let root = null;
    let panel = null;
    let isOpen = false;
    let lastFocus = null;

    const PREVIEW = {
      master: () => Sfx.play('cardDeal'),
      sfx: () => Sfx.play('chips'),
      voice: () => Voice.say('preview', {}, { priority: 3 }),
      music: () => Music.preview(),
    };

    function render(rows) {
      for (const { channel, row, slider, output, mute } of rows) {
        if (!slider || !output || !mute || !CHANNELS.includes(channel)) continue;
        const { volume, muted } = Settings.get(channel);
        slider.value = String(Math.round(volume * 100));
        output.textContent = muted ? 'OFF' : String(Math.round(volume * 100));
        mute.setAttribute('aria-pressed', String(muted));
        row.classList.toggle('is-muted', muted);
      }
      const masterMuted = Settings.get('master').muted;
      document.querySelectorAll('[data-open-settings]').forEach((btn) => btn.classList.toggle('is-muted', masterMuted));
    }

    function setOpen(next) {
      if (!root || next === isOpen) return;
      isOpen = next;
      if (next) {
        lastFocus = document.activeElement;
        root.inert = false;
        root.setAttribute('aria-hidden', 'false');
        root.classList.add('is-open');
        panel.focus({ preventScroll: true });
        Sfx.play('uiOpen');
      } else {
        root.classList.remove('is-open');
        root.setAttribute('aria-hidden', 'true');
        // Return focus only to the blackjack panel; anything else is blurred so
        // a held Space/Enter can't re-activate a button behind the dialog.
        if (lastFocus?.classList?.contains('bj-panel') && !lastFocus.closest('[inert]')) lastFocus.focus();
        else document.activeElement?.blur();
        root.inert = true;
        Sfx.play('uiClose');
      }
      toggleListeners.forEach((fn) => fn(isOpen));
    }

    function trapTab(event) {
      const focusable = [...panel.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    function init() {
      root = document.getElementById('settings');
      if (!root) return;
      panel = root.querySelector('.settings-panel');

      const rows = [...root.querySelectorAll('.setting-row')].map((row) => ({
        row,
        channel: row.dataset.channel,
        slider: row.querySelector('input[type="range"]'),
        output: row.querySelector('output'),
        mute: row.querySelector('.mute-toggle'),
      }));

      for (const { channel, slider, mute } of rows) {
        if (!slider || !mute || !CHANNELS.includes(channel)) continue;
        slider.addEventListener('input', () => {
          // Moving a slider also un-mutes its channel
          Settings.set(channel, { volume: Number(slider.value) / 100, muted: false });
        });
        slider.addEventListener('change', () => PREVIEW[channel]?.()); // audition on release
        mute.addEventListener('click', () => Settings.set(channel, { muted: !Settings.get(channel).muted }));
      }

      if (!Voice.supported) {
        const voiceRow = rows.find((r) => r.channel === 'voice');
        voiceRow?.slider.setAttribute('disabled', '');
        voiceRow?.mute.setAttribute('disabled', '');
        root.querySelector('#audio-note')?.removeAttribute('hidden');
      }

      Settings.subscribe(() => render(rows));
      render(rows);

      document.querySelectorAll('[data-open-settings]').forEach((btn) => btn.addEventListener('click', () => setOpen(true)));
      root.querySelector('#btn-settings-close')?.addEventListener('click', () => setOpen(false));
      root.addEventListener('click', (event) => {
        if (event.target === root) setOpen(false); // click on the backdrop
      });
    }

    /* Global keys. Registered before script.js, so Escape can be consumed here. */
    window.addEventListener('keydown', (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (isOpen && event.code === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        setOpen(false);
      } else if (isOpen && event.code === 'Tab') {
        trapTab(event);
      } else if (event.code === 'KeyM' && !event.repeat) {
        const muted = Settings.get('master').muted;
        Settings.set('master', { muted: !muted });
        if (muted) Sfx.play('uiClick'); // audible confirmation when turning sound back on
      }
    });

    /* Global UI feedback for every button in the page */
    document.addEventListener('click', (event) => {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      // Chips have their own clink via the game's bet event
      if (!button || button.disabled || button.classList.contains('chip')) return;
      Sfx.play('uiClick');
    });

    let lastHover = 0;
    document.addEventListener('mouseover', (event) => {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      if (!button || button.disabled || button.contains(event.relatedTarget)) return;
      const now = performance.now();
      if (now - lastHover < 60) return;
      lastHover = now;
      Sfx.play('uiHover');
    });

    init();

    return {
      get isOpen() { return isOpen; },
      onToggle: (fn) => toggleListeners.add(fn),
    };
  })();

  /* ========================================================================
     10. PUBLIC API & UNLOCK
     Browsers block audio until a user gesture. The first key press or
     click creates/resumes the context and starts music + ambience.
     ====================================================================== */

  const GESTURE_EVENTS = ['keydown', 'pointerdown', 'touchend'];

  async function onGesture(event) {
    if (event.type === 'keydown' && event.code === 'Escape') return; // Esc isn't an activation event
    const running = await Core.unlock();
    Music.start();
    Ambience.start();
    if (running) GESTURE_EVENTS.forEach((name) => window.removeEventListener(name, onGesture, true));
  }
  GESTURE_EVENTS.forEach((name) => window.addEventListener(name, onGesture, true));

  // Save battery and avoid talking to a hidden tab
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      Core.suspend();
      Voice.stop();
    } else {
      Core.resume();
    }
  });

  window.CasinoAudio = Object.freeze({
    supported: Core.supported,
    sfx: Object.freeze({ play: Sfx.play }),
    music: Object.freeze({ setTheme: Music.setTheme, getTheme: Music.getTheme, listThemes: Music.listThemes }),
    voice: Object.freeze({ say: Voice.say, stop: Voice.stop, supported: Voice.supported }),
    /** Alternating left/right footstep (call from the walk cycle). */
    footstep: (foot) => Sfx.play(foot === 'left' ? 'footstepLeft' : 'footstepRight'),
    isSettingsOpen: () => SettingsUI.isOpen,
    onSettingsToggle: SettingsUI.onToggle,
    settings: Object.freeze({ get: Settings.get, set: Settings.set, effective: Settings.effective }),
  });
})();
