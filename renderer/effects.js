// Scroll effects: what scroll cases drop. Each one changes how the next video
// arrives when you scroll (fx.t, a transition drawn by fill.js) and what flies
// across the screen while it does (fx.p, particles), in its colors (fx.c).
//
// fx: { t: transition, ms: duration, p: particle type(s), n: particle count,
//       c: colors, flash: screen flash color, glow: edge glow color }
//
// Rarities and odds follow CS:GO cases (blue 79.68%, purple 15.98%, pink 3.2%,
// red 0.64%), except gold: 0.5%, split between the two gold effects.

(function (root) {
  const RARITIES = {
    // CS:GO's Mil-Spec (#4b69ff) reads as purple next to Restricted, so a clearer blue.
    blue: { name: 'Mil-Spec', color: '#2f80ff', weight: 7968 },
    purple: { name: 'Restricted', color: '#8847ff', weight: 1598 },
    pink: { name: 'Classified', color: '#d32ce6', weight: 320 },
    red: { name: 'Covert', color: '#eb4b4b', weight: 64 },
    gold: { name: '★ Rare Special', color: '#e4ae39', weight: 50 },
  };

  const fx = (t, p, c, more = {}) => ({ t, p, c, n: 16, ms: 380, ...more });

  const ITEMS = [
    // Mil-Spec
    { id: 'ocean-spray', name: 'Slide | Ocean Spray', rarity: 'blue', icon: '🫧', fx: fx('slide', 'bubble', ['#7fd3ff', '#ffffff'], { n: 18 }) },
    { id: 'morning-mist', name: 'Fade | Morning Mist', rarity: 'blue', icon: '🌫️', fx: fx('fade', 'glow', ['#dfe8f5', '#ffffff'], { n: 12 }) },
    { id: 'breeze', name: 'Push | Breeze', rarity: 'blue', icon: '🍃', fx: fx('push', 'petal', ['#8fd18f', '#c6f0a0'], { n: 14 }) },
    { id: 'static', name: 'Zoom | Static', rarity: 'blue', icon: '📺', fx: fx('zoom', 'pixel', ['#d4d4d8', '#71717a'], { n: 22 }) },
    { id: 'pebble', name: 'Drop | Pebble', rarity: 'blue', icon: '🪨', fx: fx('drop', 'spark', ['#a8a29e'], { n: 10, ms: 520 }) },
    { id: 'snowfall', name: 'Slide | Snowfall', rarity: 'blue', icon: '❄️', fx: fx('slide', 'snow', ['#ffffff', '#dbeafe'], { n: 26 }) },
    { id: 'campfire', name: 'Fade | Campfire', rarity: 'blue', icon: '🔥', fx: fx('fade', 'ember', ['#ff9a3c', '#ffd27a'], { n: 16 }) },
    { id: 'chalkboard', name: 'Wipe | Chalkboard', rarity: 'blue', icon: '✏️', fx: fx('wipe', 'spark', ['#ffffff'], { n: 12, glow: '#ffffff' }) },
    { id: 'dusk', name: 'Blinds | Dusk', rarity: 'blue', icon: '🌆', fx: fx('blinds', 'glow', ['#ff9a8b', '#ffcf8b'], { n: 10 }) },
    { id: 'pastel', name: 'Iris | Pastel', rarity: 'blue', icon: '🎨', fx: fx('iris', 'confetti', ['#fbcfe8', '#bfdbfe', '#bbf7d0', '#fef08a'], { n: 18, glow: '#fbcfe8' }) },
    { id: 'bubblegum', name: 'Zoom | Bubblegum', rarity: 'blue', icon: '🍬', fx: fx('zoom', 'bubble', ['#ff9bd2', '#ffd1ea'], { n: 16 }) },
    { id: 'party-popper', name: 'Slide | Party Popper', rarity: 'blue', icon: '🎉', fx: fx('slide', 'confetti', ['#f43f5e', '#facc15', '#22d3ee', '#a3e635'], { n: 26 }) },
    { id: 'drizzle', name: 'Push | Drizzle', rarity: 'blue', icon: '🌧️', fx: fx('push', 'rain', ['#9ecbff'], { n: 34 }) },
    { id: 'fireflies', name: 'Fade | Fireflies', rarity: 'blue', icon: '✨', fx: fx('fade', 'glow', ['#e6ff7a', '#fde047'], { n: 16 }) },
    { id: 'autumn', name: 'Drop | Autumn', rarity: 'blue', icon: '🍂', fx: fx('drop', 'petal', ['#e8833a', '#c9541d', '#f2b84b'], { n: 18, ms: 520 }) },
    { id: 'ink', name: 'Wipe | Ink', rarity: 'blue', icon: '🖋️', fx: fx('wipe', null, ['#111827'], { glow: '#60a5fa' }) },

    // Restricted
    { id: 'vortex', name: 'Spin | Vortex', rarity: 'purple', icon: '🌀', fx: fx('spin', 'galaxy', ['#a78bfa', '#60a5fa'], { n: 40, ms: 420 }) },
    { id: 'card-trick', name: 'Flip | Card Trick', rarity: 'purple', icon: '🃏', fx: fx('flip', 'star', ['#ffffff', '#ff4d6d'], { n: 18, ms: 420 }) },
    { id: '8-bit', name: 'Pixelate | 8-Bit', rarity: 'purple', icon: '👾', fx: fx('pixelate', 'pixel', ['#4ade80', '#22d3ee', '#f472b6'], { n: 30, ms: 420 }) },
    { id: 'static-shock', name: 'Glitch | Static Shock', rarity: 'purple', icon: '⚡', fx: fx('glitch', 'bolt', ['#7dd3fc', '#ffffff'], { n: 3, ms: 400 }) },
    { id: 'ultraviolet', name: 'Iris | Ultraviolet', rarity: 'purple', icon: '🔮', fx: fx('iris', 'spark', ['#c084fc', '#e9d5ff'], { n: 26, glow: '#a855f7' }) },
    { id: 'neon-sign', name: 'Blinds | Neon Sign', rarity: 'purple', icon: '💡', fx: fx('blinds', 'ring', ['#f0abfc', '#22d3ee'], { n: 2, glow: '#f0abfc' }) },
    { id: 'starfield', name: 'Zoom | Starfield', rarity: 'purple', icon: '🌌', fx: fx('zoom', 'warp', ['#ffffff', '#93c5fd'], { n: 60 }) },
    { id: 'bassline', name: 'Push | Bassline', rarity: 'purple', icon: '🎵', fx: fx('push', 'note', ['#f472b6', '#a78bfa'], { n: 14 }) },
    { id: 'sakura', name: 'Slide | Sakura', rarity: 'purple', icon: '🌸', fx: fx('slide', 'petal', ['#ffc0d9', '#ffa3c4', '#ffe4ef'], { n: 28 }) },
    { id: 'frostbite', name: 'Flip | Frostbite', rarity: 'purple', icon: '🧊', fx: fx('flip', 'snow', ['#bfe9ff', '#ffffff'], { n: 32, ms: 420, flash: '#bfe9ff' }) },
    { id: 'meteor', name: 'Drop | Meteor', rarity: 'purple', icon: '☄️', fx: fx('drop', 'ember', ['#ff7a18', '#ffd166'], { n: 32, ms: 520, flash: '#ff7a18' }) },
    { id: 'laser', name: 'Wipe | Laser', rarity: 'purple', icon: '🔴', fx: fx('wipe', 'spark', ['#ff2d55', '#ff8fa3'], { n: 30, glow: '#ff2d55' }) },

    // Classified
    { id: 'glass', name: 'Shatter | Glass', rarity: 'pink', icon: '🪟', fx: fx('shatter', 'spark', ['#e0f2fe', '#ffffff'], { n: 22, ms: 460 }) },
    { id: 'hyperdrive', name: 'Glitch | Hyperdrive', rarity: 'pink', icon: '🚀', fx: fx('glitch', 'warp', ['#22d3ee', '#f472b6'], { n: 60, ms: 420 }) },
    { id: 'galaxy', name: 'Spin | Galaxy', rarity: 'pink', icon: '🪐', fx: fx('spin', 'galaxy', ['#f0abfc', '#818cf8', '#ffffff'], { n: 80, ms: 460 }) },
    { id: 'heartbreaker', name: 'Iris | Heartbreaker', rarity: 'pink', icon: '💘', fx: fx('iris', 'heart', ['#fe2c55', '#ff8fab'], { n: 26, glow: '#fe2c55' }) },
    { id: 'arcade', name: 'Pixelate | Arcade', rarity: 'pink', icon: '🕹️', fx: fx('pixelate', 'star', ['#facc15', '#f472b6', '#22d3ee'], { n: 26, ms: 420 }) },
    { id: 'aurora', name: 'Blinds | Aurora', rarity: 'pink', icon: '🌠', fx: fx('blinds', 'glow', ['#34d399', '#60a5fa', '#c084fc'], { n: 40, glow: '#34d399' }) },
    { id: 'bubble-burst', name: 'Zoom | Bubble Burst', rarity: 'pink', icon: '🫧', fx: fx('zoom', ['bubble', 'ring'], ['#a5f3fc', '#f0abfc'], { n: 40 }) },
    { id: 'synthwave', name: 'Flip | Synthwave', rarity: 'pink', icon: '🌇', fx: fx('flip', ['ring', 'spark'], ['#f472b6', '#22d3ee'], { n: 24, ms: 420, flash: '#f472b6' }) },
    { id: 'thunderstruck', name: 'Push | Thunderstruck', rarity: 'pink', icon: '🌩️', fx: fx('push', 'bolt', ['#fde68a', '#ffffff'], { n: 4, flash: '#fff7cc' }) },

    // Covert
    { id: 'inferno', name: 'Shatter | Inferno', rarity: 'red', icon: '🔥', fx: fx('shatter', 'ember', ['#ff4d00', '#ffb703', '#ffd166'], { n: 70, ms: 480, flash: '#ff4d00' }) },
    { id: 'overload', name: 'Glitch | Overload', rarity: 'red', icon: '💥', fx: fx('glitch', ['bolt', 'spark'], ['#ff2d55', '#22d3ee', '#ffffff'], { n: 30, ms: 440, flash: '#ff2d55' }) },
    { id: 'hyperspace', name: 'Zoom | Hyperspace', rarity: 'red', icon: '🛸', fx: fx('zoom', 'warp', ['#ffffff', '#7dd3fc', '#c4b5fd'], { n: 130, ms: 440, flash: '#e0f2fe' }) },
    { id: 'firestorm', name: 'Spin | Firestorm', rarity: 'red', icon: '🐉', fx: fx('spin', ['ember', 'galaxy'], ['#ff3d00', '#ff9100', '#ffd54f'], { n: 90, ms: 480 }) },
    { id: 'blood-moon', name: 'Iris | Blood Moon', rarity: 'red', icon: '🌕', fx: fx('iris', ['ring', 'ember'], ['#ef4444', '#b91c1c', '#fca5a5'], { n: 30, glow: '#ef4444', flash: '#7f1d1d' }) },
    { id: 'diamond', name: 'Shatter | Diamond', rarity: 'red', icon: '💎', fx: fx('shatter', 'star', ['#e0f2fe', '#a5f3fc', '#ffffff'], { n: 46, ms: 480, flash: '#e0f2fe' }) },
    { id: 'fallout', name: 'Drop | Fallout', rarity: 'red', icon: '☢️', fx: fx('drop', ['ring', 'spark'], ['#bef264', '#facc15'], { n: 40, ms: 540, flash: '#ecfccb' }) },

    { id: 'black-hole', name: 'Spin | Black Hole', rarity: 'red', icon: '🕳️', fx: fx('spin', ['galaxy', 'ring'], ['#facc15', '#a78bfa', '#ffffff'], { n: 140, ms: 540, glow: '#facc15' }) },
    { id: 'crown-jewels', name: 'Iris | Crown Jewels', rarity: 'red', icon: '💍', fx: fx('iris', ['star', 'confetti'], ['#facc15', '#f472b6', '#60a5fa', '#34d399'], { n: 90, ms: 500, flash: '#fef3c7', glow: '#facc15' }) },
    { id: 'golden-dragon', name: 'Push | Golden Dragon', rarity: 'red', icon: '🐲', fx: fx('push', ['ember', 'coin'], ['#facc15', '#f59e0b', '#fde68a'], { n: 110, ms: 500, flash: '#fde68a' }) },
    { id: 'jackpot', name: 'Flip | Jackpot', rarity: 'red', icon: '🎰', fx: fx('flip', ['coin', 'confetti'], ['#facc15', '#eab308', '#ffffff'], { n: 100, ms: 500, flash: '#fff7cc' }) },

    // Rare Special
    { id: 'midas-touch', name: '★ Midas Touch', rarity: 'gold', icon: '👑', fx: fx('shatter', ['coin', 'spark'], ['#facc15', '#eab308', '#fde68a'], { n: 80, ms: 520, flash: '#fde68a', glow: '#facc15' }) },
    { id: 'supernova', name: '★ Supernova', rarity: 'gold', icon: '🌟', fx: fx('zoom', ['warp', 'ring', 'star'], ['#fff7cc', '#facc15', '#ffffff'], { n: 150, ms: 520, flash: '#fffbe6' }) },
  ];

  const BY_ID = Object.fromEntries(ITEMS.map((i) => [i.id, i]));

  // The items filling the spinning reel around the prize. Like case reels do,
  // they're a richer mix than the real odds; what you win still uses those.
  const REEL_WEIGHTS = { blue: 50, purple: 27, pink: 14, red: 7, gold: 2 };

  // One random item, rarity first (by CS:GO odds, or `weights`), then evenly within it.
  function roll(rand = Math.random, weights = null) {
    const w = weights || Object.fromEntries(Object.entries(RARITIES).map(([k, r]) => [k, r.weight]));
    const total = Object.values(w).reduce((s, x) => s + x, 0);
    let x = rand() * total, rarity = 'blue';
    for (const [key, weight] of Object.entries(w)) {
      if ((x -= weight) < 0) { rarity = key; break; }
    }
    const pool = ITEMS.filter((i) => i.rarity === rarity);
    return pool[Math.floor(rand() * pool.length)];
  }

  const rollReel = () => roll(Math.random, REEL_WEIGHTS);

  root.EFFECTS = { RARITIES, ITEMS, BY_ID, roll, rollReel };
})(typeof window !== 'undefined' ? window : globalThis);
