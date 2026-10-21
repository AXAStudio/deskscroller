// Scroll cases: every 15 scrolls a CS:GO-style case opens. A reel of scroll
// effects (effects.js) spins past a marker, slows down and lands on what you won,
// which joins your collection; the collection screen equips one.
//
// The sounds are synthesized here (Web Audio), in the style of case-opening reels
// (not Valve's own audio): a short, crisp click each time an item crosses the
// marker, a whoosh when the case unlocks, and a reveal sting that gets bigger
// with rarity.
//
// Uses the overlay's globals from app.js (state, ds, $, toast, gain, muted,
// views, run, PAGE_SCRIPTS, syncPlayback, setPanel) and gives app.js `Cases`.
// Everything else stays inside, so nothing here can clash with app.js's names.

const Cases = (() => {
const CASE_EVERY = 15;
const CARD_W = 100;        // card width + gap in the reel, px
const REEL_ITEMS = 60;
const WIN_AT = 50;         // where the winning item sits in the reel
let caseOpen = false;

// ---------- sound ----------

let audio = null, noise = null;
function sound() {
  if (!audio) {
    audio = new AudioContext();
    noise = audio.createBuffer(1, audio.sampleRate * 0.5, audio.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return audio;
}

// Follows the overlay's volume and mute.
function sfxOut(level = 1) {
  const a = sound(), g = a.createGain();
  g.gain.value = muted ? 0 : level * Math.max(0.05, gain());
  g.connect(a.destination);
  return g;
}

function envelope(a, node, t, peak, decay) {
  const g = a.createGain();
  g.gain.setValueAtTime(peak, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  node.connect(g);
  return g;
}

// The reel's click: a 12 ms burst of bright, filtered noise for the snap, plus a
// faint resonant ping that gives it the hollow plastic sound of a case reel.
function tick(pitch = 1) {
  const a = sound(), t = a.currentTime, out = sfxOut(0.7);
  const n = a.createBufferSource();
  n.buffer = noise;
  const hp = a.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 1800;
  const peak = a.createBiquadFilter();
  peak.type = 'peaking';
  peak.frequency.value = 4600 * pitch;
  peak.Q.value = 1.2;
  peak.gain.value = 9;
  n.connect(hp).connect(peak);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(1, t + 0.0006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
  peak.connect(g).connect(out);
  n.start(t, Math.random() * 0.4, 0.02);
  const o = a.createOscillator();
  o.type = 'sine';
  o.frequency.value = 2350 * pitch;
  envelope(a, o, t, 0.12, 0.016).connect(out);
  o.start(t);
  o.stop(t + 0.03);
}

function whoosh() {
  const a = sound(), t = a.currentTime, out = sfxOut(0.5);
  const n = a.createBufferSource();
  n.buffer = noise;
  n.loop = true;
  const bp = a.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 1.5;
  bp.frequency.setValueAtTime(300, t);
  bp.frequency.exponentialRampToValueAtTime(2600, t + 0.4);
  n.connect(bp);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.7, t + 0.12);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
  bp.connect(g).connect(out);
  n.start(t);
  n.stop(t + 0.5);
}

const STINGS = {
  blue: [659, 988],
  purple: [587, 880, 1175],
  pink: [523, 784, 1047, 1319],
  red: [440, 659, 880, 1319, 1760],
  gold: [523, 659, 784, 1047, 1319, 1568, 2093],
};

function reveal(rarity) {
  const a = sound(), t0 = a.currentTime, out = sfxOut(0.45);
  STINGS[rarity].forEach((f, i) => {
    const t = t0 + i * (rarity === 'gold' ? 0.06 : 0.08);
    for (const [type, mult, vol] of [['sine', 1, 0.5], ['triangle', 2, 0.12]]) {
      const o = a.createOscillator();
      o.type = type;
      o.frequency.value = f * mult;
      envelope(a, o, t, vol, rarity === 'gold' ? 1.4 : 0.9).connect(out);
      o.start(t);
      o.stop(t + 1.5);
    }
  });
  // Covert and gold land with a low boom too.
  if (rarity === 'red' || rarity === 'gold') {
    const o = a.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(140, t0);
    o.frequency.exponentialRampToValueAtTime(45, t0 + 0.5);
    envelope(a, o, t0, 0.9, 0.7).connect(out);
    o.start(t0);
    o.stop(t0 + 0.8);
  }
}

// ---------- cards ----------

function card(item, cls = '') {
  const r = EFFECTS.RARITIES[item.rarity];
  const el = document.createElement('div');
  el.className = `case-card ${item.rarity} ${cls}`;
  el.style.setProperty('--rc', r.color);
  const icon = document.createElement('span');
  icon.className = 'cc-icon';
  icon.textContent = item.icon;
  const [kind, finish] = item.name.includes('|') ? item.name.split(' | ') : ['', item.name];
  const name = document.createElement('span');
  name.className = 'cc-name';
  name.innerHTML = `<small>${escapeHtml(kind)}</small>${escapeHtml(finish)}`;
  el.append(icon, name);
  return el;
}

// ---------- counting scrolls ----------

let caseSave = null;
function saveCases(patch) {
  Object.assign(state.settings, patch);
  clearTimeout(caseSave);
  caseSave = setTimeout(async () => {
    const { scrolls, inventory, effect, cases } = state.settings;
    state = await ds.set({ scrolls, inventory, effect, cases });
    renderCaseButton();
  }, 300);
}

function countScroll() {
  if (!state.settings.cases || caseOpen) return;
  const scrolls = (state.settings.scrolls || 0) + 1;
  saveCases({ scrolls });
  renderCaseButton();
  // Let the scroll's own transition finish first.
  if (scrolls % CASE_EVERY === 0) setTimeout(openCase, 550);
}

function renderCaseButton() {
  const left = CASE_EVERY - ((state.settings.scrolls || 0) % CASE_EVERY);
  const done = (CASE_EVERY - left) / CASE_EVERY;
  $('#case-ring').style.strokeDashoffset = String(100 - done * 100);
  $('#btn-case').classList.toggle('off', !state.settings.cases);
  $('#btn-case').title = state.settings.cases
    ? `Scroll cases · ${left} scroll${left === 1 ? '' : 's'} to the next case · click for your collection`
    : 'Scroll cases are off · click for your collection';
}

// ---------- opening a case ----------

let spin = null;   // { strip, target, won, raf, done }

function openCase() {
  if (caseOpen) return;
  caseOpen = true;
  syncPlayback();
  const won = EFFECTS.roll();
  const strip = $('#case-strip');
  strip.replaceChildren(...Array.from({ length: REEL_ITEMS }, (_, i) => card(i === WIN_AT ? won : EFFECTS.rollReel())));
  strip.style.transition = 'none';
  strip.style.transform = 'translateX(0)';
  $('#case').classList.remove('revealed', 'gold');
  $('#case').setAttribute('aria-hidden', 'false');
  appEl.classList.add('case-open');
  $('#case-num').textContent = `Case #${Math.floor((state.settings.scrolls || 0) / CASE_EVERY)}`;
  whoosh();

  // Land somewhere inside the winning card, not always dead center.
  const view = $('#case-reel').clientWidth;
  const target = WIN_AT * CARD_W + 12 + Math.random() * (CARD_W - 36) - view / 2;
  spin = { strip, target, won, raf: 0, done: false, lastIdx: -1, lastTickAt: 0 };
  requestAnimationFrame(() => requestAnimationFrame(() => {
    strip.style.transition = 'transform 5.8s cubic-bezier(.08, .62, .1, 1)';
    strip.style.transform = `translateX(${-target}px)`;
    watchReel(view);
  }));
  strip.addEventListener('transitionend', finishSpin, { once: true });
}

// Ticks as each card crosses the marker, like the case reel.
function watchReel(view) {
  if (!spin || spin.done) return;
  const m = new DOMMatrixReadOnly(getComputedStyle(spin.strip).transform);
  const idx = Math.floor((-m.m41 + view / 2) / CARD_W);
  if (idx !== spin.lastIdx) {
    const now = performance.now();
    if (spin.lastIdx >= 0 && now - spin.lastTickAt > 28) {
      tick(0.92 + Math.random() * 0.16);
      spin.lastTickAt = now;
    }
    spin.lastIdx = idx;
  }
  spin.raf = requestAnimationFrame(() => watchReel(view));
}

function finishSpin() {
  if (!spin || spin.done) return;
  spin.done = true;
  cancelAnimationFrame(spin.raf);
  const { won, strip, target } = spin;
  strip.style.transition = 'none';
  strip.style.transform = `translateX(${-target}px)`;
  strip.children[WIN_AT].classList.add('won');

  const inventory = { ...(state.settings.inventory || {}) };
  const isNew = !inventory[won.id];
  inventory[won.id] = (inventory[won.id] || 0) + 1;
  saveCases({ inventory });

  const r = EFFECTS.RARITIES[won.rarity];
  $('#case-result').replaceChildren(card(won, 'big'));
  $('#case-rarity').textContent = r.name + (isNew ? ' · New!' : ` · ×${inventory[won.id]}`);
  $('#case-rarity').style.color = r.color;
  $('#case-name').textContent = won.name;
  $('#case-equip').textContent = state.settings.effect === won.id ? 'Equipped' : 'Equip';
  $('#case-equip').disabled = state.settings.effect === won.id;
  $('#case').classList.add('revealed');
  $('#case').classList.toggle('gold', won.rarity === 'gold');
  reveal(won.rarity);
}

function skipSpin() {
  if (!spin || spin.done) return;
  finishSpin();
}

function closeCase() {
  if (spin && !spin.done) finishSpin();
  spin = null;
  caseOpen = false;
  $('#case').setAttribute('aria-hidden', 'true');
  appEl.classList.remove('case-open');
  syncPlayback();
}

// ---------- equipping and the collection ----------

function effectFx() {
  const item = state.settings.effect && EFFECTS.BY_ID[state.settings.effect];
  return item ? item.fx : null;
}

function applyEffect(site) {
  const sites = site ? [site] : Object.keys(SITES);
  for (const s of sites) run(s, PAGE_SCRIPTS.effect(effectFx()));
}

function equip(id) {
  saveCases({ effect: id });
  applyEffect();
  renderCollection();
  const item = id && EFFECTS.BY_ID[id];
  toast(item ? `Equipped ${escapeHtml(item.name)}` : 'Back to the plain slide');
}

function renderCollection() {
  const inv = state.settings.inventory || {};
  const owned = EFFECTS.ITEMS.filter((i) => inv[i.id]).length;
  $('#coll-count').textContent = `${owned} / ${EFFECTS.ITEMS.length} collected · ${state.settings.scrolls || 0} scrolls`;
  const grid = $('#coll-grid');
  const plain = card({ id: '', name: 'Plain | Slide', rarity: 'blue', icon: '↕️' }, 'plain');
  plain.dataset.id = '';
  const cards = [plain];
  // Rarest first, like an inventory sorted by quality.
  for (const rarity of ['gold', 'red', 'pink', 'purple', 'blue']) {
    for (const item of EFFECTS.ITEMS.filter((i) => i.rarity === rarity)) {
      const el = card(item, inv[item.id] ? '' : 'locked');
      el.dataset.id = item.id;
      if (inv[item.id] > 1) el.dataset.count = '×' + inv[item.id];
      cards.push(el);
    }
  }
  for (const el of cards) el.classList.toggle('equipped', (state.settings.effect || '') === el.dataset.id);
  grid.replaceChildren(...cards);
}

function openCollection() {
  renderCollection();
  setPanel('collection');
}

$('#case-skip').addEventListener('click', skipSpin);
$('#case-close').addEventListener('click', closeCase);
$('#case-equip').addEventListener('click', () => {
  if (spin) equip(spin.won.id);
  closeCase();
});
$('#btn-case').addEventListener('click', () => (panel === 'collection' ? setPanel(null) : openCollection()));
$('#btn-collection-close').addEventListener('click', () => setPanel(null));
$('#btn-open-collection').addEventListener('click', openCollection);
$('#coll-grid').addEventListener('click', (e) => {
  const el = e.target.closest('.case-card');
  if (!el || el.classList.contains('locked')) return;
  equip(el.dataset.id || null);
});

return { countScroll, renderCaseButton, applyEffect, openCase, isOpen: () => caseOpen };
})();
