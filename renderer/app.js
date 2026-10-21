const SITES = {
  yt: {
    name: 'YouTube Shorts',
    service: 'YouTube',
    url: 'https://www.youtube.com/shorts',
  },
  ig: {
    name: 'Instagram Reels',
    service: 'Instagram',
    url: 'https://www.instagram.com/reels/',
  },
  tt: {
    name: 'TikTok',
    service: 'TikTok',
    url: 'https://www.tiktok.com/',
  },
};

// Every tab: the feeds above plus a plain browser (no fill mode, no account).
const WEB = 'web';
const PAGES = {
  ...SITES,
  [WEB]: {
    name: 'Browser',
    // Blank underneath our own start page; going back to it brings the start page back.
    url: 'about:blank',
  },
};

const SHORTCUTS = [
  { name: 'YouTube', url: 'https://www.youtube.com/', color: '#ff2d2d' },
  { name: 'Twitch', url: 'https://www.twitch.tv/', color: '#9146ff' },
  { name: 'Reddit', url: 'https://www.reddit.com/', color: '#ff4500' },
  { name: 'Discord', url: 'https://discord.com/app', color: '#5865f2' },
  { name: 'Steam', url: 'https://store.steampowered.com/', color: '#1b6fa8' },
  { name: 'Spotify', url: 'https://open.spotify.com/', color: '#1ed760' },
  { name: 'Wikipedia', url: 'https://www.wikipedia.org/', color: '#8a8a99' },
  { name: 'X', url: 'https://x.com/', color: '#e7e7ee' },
];
const RECENT_KEY = 'ds.recent';
const RECENT_MAX = 5;

const $ = (sel) => document.querySelector(sel);
const appEl = $('#app');
const stage = $('#stage');
const progress = $('#progress');

let state = null;          // mirror of the main process settings
const views = {};          // site key -> <webview>
const ready = new Set();   // webviews that can run scripts
let current = null;        // active site key, null on the home screen
let hover = true;
let panel = null;          // 'settings' | 'accounts' | null
let accounts = {};         // site key -> connected?
let loginSite = null;      // site currently showing its login page
let browserLogin = null;   // { site, browser } while a real-browser login window is open
let recording = null;      // hotkey action being recorded
let muted = false;
let overlayVisible = true;
let editing = false;       // the last click landed in a text box
let wantFocus = false;     // what we last asked main for
const playing = {};        // site -> whether we last released (true) or held (false) it
const loading = {};        // site -> { progress, revealed, timer } for the loading cover

// ---------- Helpers ----------

function keyParts(accel) {
  if (!accel) return [];
  const names = { CommandOrControl: 'Ctrl', Control: 'Ctrl', Super: 'Win', Up: '↑', Down: '↓', Left: '←', Right: '→' };
  return accel.split('+').map((k) => names[k] || k);
}

function kbds(parts) {
  return `<span class="keys">${parts.map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join('')}</span>`;
}

function keysHtml(accel) {
  return kbds(keyParts(accel));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer = null;
function toast(html, ms = 1700) {
  const el = $('#toast');
  el.innerHTML = html;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

async function run(site, script) {
  const wv = views[site];
  if (!wv || !ready.has(site)) return null;
  try {
    return await wv.executeJavaScript(script, true);
  } catch {
    return null;
  }
}

// ---------- Webviews ----------

function ensureView(site, url = PAGES[site].url) {
  if (views[site]) return views[site];
  const wv = document.createElement('webview');
  wv.className = 'wv';
  wv.setAttribute('partition', state.partition);
  wv.setAttribute('allowpopups', '');
  wv.setAttribute('src', url);
  resetLoading(site);

  wv.addEventListener('dom-ready', () => {
    ready.add(site);
    // The blank page loading underneath grabs focus; give it back to the start page's search.
    if (site === WEB && site === current && onStartPage() && !panel) $('#ws-input').focus();
    bumpLoading(site, 0.55);
    const l = loading[site];
    if (!l.revealed) {
      // Fallback: pages without a video (login walls, fill mode off) still get shown.
      clearTimeout(l.timer);
      l.timer = setTimeout(() => site === current && reveal(site), revealTimeout(site));
    }
    run(site, PAGE_SCRIPTS.focusWatch);
    if (site !== WEB) {
      run(site, PAGE_SCRIPTS.fill(state.settings.fill));
      run(site, PAGE_SCRIPTS.skipAds(state.settings.skipAds));
    }
    // A fresh page has lost any hold we put on it; re-apply what it should be doing.
    delete playing[site];
    syncPlayback();
    updateNav();
  });
  wv.addEventListener('did-start-loading', () => {
    bumpLoading(site, 0.25);
    if (site === current) setLoading(true);
  });
  wv.addEventListener('did-stop-loading', () => {
    bumpLoading(site, 0.8);
    if (loginSite === site) reveal(site, 200);
    if (site === current) {
      setLoading(false);
      updateNav();
    }
  });
  wv.addEventListener('did-navigate', updateNav);
  wv.addEventListener('did-navigate-in-page', updateNav);
  if (site === WEB) {
    wv.addEventListener('did-navigate', (e) => rememberVisit(e.url));
    wv.addEventListener('page-title-updated', (e) => rememberVisit(wv.getURL(), e.title));
  }
  wv.addEventListener('console-message', (e) => {
    const f = /^__ds:focus:([01])$/.exec(e.message);
    if (f) return setEditing(f[1] === '1');
    if (e.message === '__ds:fill:1') return reveal(site, 250);
    const m = /^__ds:nav:(-?1)$/.exec(e.message);
    if (m && site === current) navigate(Number(m[1]), true);
  });
  wv.addEventListener('render-process-gone', () => {
    ready.delete(site);
    reveal(site);
    if (site === current) toast('Page crashed — hit reload');
  });

  stage.appendChild(wv);
  views[site] = wv;
  return wv;
}

// ---------- Loading cover ----------
// Each feed stays behind a cover until its video is actually filling the overlay,
// so you never see the site's desktop layout flash by while it loads.

function loadUrl(site, url) {
  if (!views[site]) return;
  resetLoading(site);
  views[site].src = url;
}

// How long to wait for a video before showing the page anyway (login walls, no video).
function revealTimeout(site) {
  return state.settings.fill && loginSite !== site ? 12000 : 600;
}

function resetLoading(site) {
  clearTimeout(loading[site]?.timer);
  // The browser shows pages as they load, like any browser; only feeds wait for a video.
  loading[site] = { progress: 0.06, revealed: site === WEB, timer: null };
  renderCover();
}

function bumpLoading(site, p) {
  const l = loading[site];
  if (!l || l.revealed) return;
  l.progress = Math.max(l.progress, p);
  if (site === current) renderCover();
}

function reveal(site, delay = 0) {
  const l = loading[site];
  if (!l || l.revealed) return;
  l.progress = 1;
  renderCover();
  clearTimeout(l.timer);
  l.timer = setTimeout(() => {
    l.revealed = true;
    renderCover();
  }, delay);
}

// Keep the bar inching forward while we wait, slowing as it nears the end.
function creepLoading() {
  const l = current && loading[current];
  if (!l || l.revealed || l.progress >= 1) return;
  l.progress += (0.94 - l.progress) * 0.05;
  renderCover();
}

function renderCover() {
  const l = current && loading[current];
  appEl.classList.toggle('covered', !!l && !l.revealed);
  if (!l) return;
  $('#cover-fill').style.width = (l.progress * 100).toFixed(1) + '%';
  $('#cover-use').setAttribute('href', '#i-' + current);
  $('#cover-name').textContent = PAGES[current].name;
}

function setLoading(on) {
  progress.classList.remove('loading', 'done');
  void progress.offsetWidth; // restart the transition
  progress.classList.add(on ? 'loading' : 'done');
}

function updateNav() {
  const wv = current && views[current];
  const live = !!(wv && ready.has(current));
  $('#btn-back').disabled = !(live && wv.canGoBack());
  $('#btn-reload').disabled = !wv;
  $('#btn-web-back').disabled = !(live && current === WEB && wv.canGoBack());
  $('#btn-web-forward').disabled = !(live && current === WEB && wv.canGoForward());
  const input = $('#url-input');
  if (live && current === WEB && document.activeElement !== input) input.value = wv.getURL();
  const start = current === WEB && onStartPage();
  if (start !== appEl.classList.contains('web-start')) {
    appEl.classList.toggle('web-start', start);
    if (start) renderStartPage();
  }
}

// ---------- Browser start page ----------

function onStartPage() {
  const wv = views[WEB];
  if (!wv || !ready.has(WEB)) return true;
  const url = wv.getURL();
  return !url || url === 'about:blank';
}

function loadRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; }
}

function saveRecent(list) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* storage unavailable: recents just don't persist */ }
}

// One entry per site, newest first, so the list reads like "where was I".
function rememberVisit(url, title) {
  let host;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return;
    host = u.hostname.replace(/^www\./, '');
  } catch { return; }
  const list = loadRecent();
  const old = list.find((r) => r.host === host);
  const entry = { host, url, title: title || (old && old.url === url ? old.title : '') || host };
  saveRecent([entry, ...list.filter((r) => r.host !== host)].slice(0, RECENT_MAX));
}

function favicon(url, color, label) {
  const box = document.createElement('span');
  box.className = 'fav';
  box.style.setProperty('--c', color || 'var(--muted)');
  box.textContent = (label || '?')[0].toUpperCase();
  const img = new Image();
  img.alt = '';
  img.onload = () => { if (img.naturalWidth > 16) box.replaceChildren(img); };
  img.src = `https://www.google.com/s2/favicons?sz=64&domain_url=${encodeURIComponent(url)}`;
  return box;
}

function renderStartPage() {
  const h = new Date().getHours();
  $('#ws-greeting').textContent = h < 5 ? 'Late night session' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';

  const tiles = $('#ws-tiles');
  if (!tiles.childElementCount) {
    for (const s of SHORTCUTS) {
      const b = document.createElement('button');
      b.className = 'ws-tile';
      b.dataset.url = s.url;
      b.title = s.url;
      b.append(favicon(s.url, s.color, s.name), Object.assign(document.createElement('span'), { textContent: s.name }));
      tiles.appendChild(b);
    }
  }

  const recent = loadRecent();
  $('#ws-recent-wrap').hidden = !recent.length;
  $('#ws-recent').replaceChildren(...recent.map((r) => {
    const row = document.createElement('div');
    row.className = 'ws-row';
    row.dataset.url = r.url;
    const text = document.createElement('span');
    text.className = 'ws-row-text';
    text.append(Object.assign(document.createElement('b'), { textContent: r.title }), Object.assign(document.createElement('small'), { textContent: r.host }));
    const x = document.createElement('button');
    x.className = 'ws-row-x';
    x.title = 'Remove';
    x.dataset.remove = r.host;
    x.innerHTML = '<svg><use href="#i-close" /></svg>';
    row.append(favicon(r.url, null, r.host), text, x);
    return row;
  }));

  const input = $('#ws-input');
  input.value = '';
  if (current === WEB && !panel) setTimeout(() => input.focus(), 0);
}

function openWeb(text) {
  const url = toUrl(text);
  if (!url) return;
  if (!views[WEB]) ensureView(WEB, url);
  else loadUrl(WEB, url);
  views[WEB].focus();
}

// ---------- Focus ----------
// The overlay normally never takes keyboard focus, so clicking a video leaves
// your game focused. It grabs focus only while you need to type: in the browser
// tab, while logging in, or after clicking a text box (until you click anything
// else or go back to the game).

function setEditing(on) {
  editing = on;
  syncFocus();
  // Hand the keyboard to the page so the text box you clicked gets your typing.
  if (on && current) views[current].focus();
}

function syncFocus() {
  const want = current === WEB || !!loginSite || editing;
  if (want === wantFocus) return;
  wantFocus = want;
  ds.focusOverride(want);
}

// Typed into the address bar: a URL as-is, anything else as a search.
function toUrl(text) {
  const t = text.trim();
  if (!t) return null;
  if (/^[a-z][\w+.-]*:\/\//i.test(t) || /^(about|file):/i.test(t)) return t;
  if (!/\s/.test(t) && (/^[^/]+\.[a-z]{2,}(?::\d+)?(\/|$)/i.test(t) || /^localhost(:\d+)?(\/|$)/i.test(t))) return 'https://' + t;
  return 'https://www.google.com/search?q=' + encodeURIComponent(t);
}

// A page in fullscreen (a video in the browser tab) puts its webview in the top
// layer, above everything. Leaving it there after switching away would leave an
// invisible layer over the whole overlay that swallows every click.
function exitFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// ---------- Memory ----------
// Each feed is a whole YouTube / Instagram / TikTok page, 200-450 MB apiece. Only
// the tab you're on stays loaded; one you leave is unloaded a few minutes later
// (the browser tab remembers its page), unless "Keep feeds loaded" is on.

const UNLOAD_FEED_AFTER = 3 * 60 * 1000;
const UNLOAD_WEB_AFTER = 10 * 60 * 1000;
// Hidden that long (you're playing): free everything for the game. The tab you
// were on reloads when the overlay comes back.
const UNLOAD_ALL_HIDDEN_AFTER = 5 * 60 * 1000;
const unloadTimers = {};
let hiddenTimer = null;
let webResumeUrl = null;   // the browser tab's page while it's unloaded

function scheduleUnloads() {
  for (const site of Object.keys(views)) {
    clearTimeout(unloadTimers[site]);
    delete unloadTimers[site];
    if (site === current || site === loginSite || state.settings.keepFeedsLoaded) continue;
    unloadTimers[site] = setTimeout(() => unloadView(site), site === WEB ? UNLOAD_WEB_AFTER : UNLOAD_FEED_AFTER);
  }
}

function unloadView(site, evenCurrent = false) {
  clearTimeout(unloadTimers[site]);
  delete unloadTimers[site];
  const wv = views[site];
  if (!wv || (site === current && !evenCurrent)) return;
  if (site === WEB) {
    try {
      const url = wv.getURL();
      webResumeUrl = url && url !== 'about:blank' ? url : null;
    } catch { /* never loaded */ }
  }
  delete views[site];
  delete playing[site];
  ready.delete(site);
  clearTimeout(loading[site]?.timer);
  delete loading[site];
  wv.remove(); // its page and renderer process go with it
}

function onOverlayVisibility(visible) {
  clearTimeout(hiddenTimer);
  if (!visible) {
    if (state.settings.keepFeedsLoaded) return;
    hiddenTimer = setTimeout(() => {
      if (loginSite) return;
      for (const site of Object.keys(views)) unloadView(site, true);
    }, UNLOAD_ALL_HIDDEN_AFTER);
    return;
  }
  // Back from a long hide: bring the tab you were on back.
  if (current && !views[current]) {
    const url = current === WEB ? webResumeUrl || undefined : undefined;
    if (current === WEB) webResumeUrl = null;
    const wv = ensureView(current, url);
    wv.classList.add('active');
    setLoading(true);
    renderCover();
    syncPlayback();
    updateNav();
  }
}

function preloadFeeds() {
  for (const site of Object.keys(SITES)) ensureView(site);
}

// `url` navigates the site's view somewhere specific (e.g. its login page).
async function openSite(site, url = null) {
  if (!PAGES[site]) return;
  if (site === current) {
    if (url) loadUrl(site, url);
    return;
  }
  exitFullscreen();
  if (loginSite && loginSite !== site) cancelLogin();

  const isNew = !views[site];
  if (isNew && site === WEB && !url && webResumeUrl) url = webResumeUrl;
  if (site === WEB) webResumeUrl = null;
  const wv = ensureView(site, url || undefined);
  for (const [key, el] of Object.entries(views)) el.classList.toggle('active', key === site);
  current = site;
  syncPlayback();

  if (isNew) setLoading(true);
  else if (url) loadUrl(site, url);

  appEl.dataset.site = site;
  appEl.classList.remove('on-home');
  // Its video may have been on hold in the background; give it a fresh chance to show.
  const l = loading[site];
  if (l && !l.revealed && ready.has(site)) {
    clearTimeout(l.timer);
    l.timer = setTimeout(() => reveal(site), revealTimeout(site));
  }
  renderCover();
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.site === site);
  trackPill();
  updateNav();
  updateBar();
  editing = false;
  syncFocus();
  if (appEl.classList.contains('web-start')) $('#ws-input').focus();
  else wv.focus();
  scheduleUnloads();

  state = await ds.set({ lastSite: site });
}

async function goHome() {
  exitFullscreen();
  if (loginSite) cancelLogin();
  current = null;
  syncPlayback();
  renderCover();
  for (const el of Object.values(views)) el.classList.remove('active');
  delete appEl.dataset.site;
  appEl.classList.add('on-home');
  for (const t of document.querySelectorAll('.tab')) t.classList.remove('active');
  trackPill();
  updateNav();
  updateBar();
  editing = false;
  syncFocus();
  scheduleUnloads();
  state = await ds.set({ lastSite: null });
}

// fromPage: the page already started its slide animation itself (wheel on the video).
async function navigate(dir, fromPage = false) {
  if (!current || current === WEB) return;
  if (!fromPage) await run(current, PAGE_SCRIPTS.slide(dir));
  const how = await run(current, PAGE_SCRIPTS.navigate(dir));
  if (how) return;
  // Nothing scrollable found from script: fall back to a real wheel tick,
  // letting it through the fill canvas so it reaches the site underneath.
  const site = current;
  const wv = views[site];
  const r = wv.getBoundingClientRect();
  await run(site, PAGE_SCRIPTS.passThrough(true));
  // Give the page a frame so the change reaches hit-testing before the tick does.
  await new Promise((r) => setTimeout(r, 80));
  wv.sendInputEvent({ type: 'mouseWheel', x: Math.round(r.width / 2), y: Math.round(r.height / 2), deltaX: 0, deltaY: -dir * 120, canScroll: true });
  setTimeout(() => run(site, PAGE_SCRIPTS.passThrough(false)), 350);
}

// The single place that decides what may play: only the feed you're looking at,
// and only while no panel covers it and the overlay is on screen.
function syncPlayback() {
  for (const site of Object.keys(views)) {
    const want = site === current && !panel && (overlayVisible || !state.settings.pauseOnHide);
    if (playing[site] === want) continue;
    playing[site] = want;
    run(site, want ? PAGE_SCRIPTS.release : PAGE_SCRIPTS.hold);
  }
  applyAudio();
}

async function setFill(on) {
  state = await ds.set({ fill: on });
  for (const site of Object.keys(views)) {
    if (site === WEB) continue;
    run(site, PAGE_SCRIPTS.fill(on));
    if (!on) reveal(site);
  }
  $('#btn-fill').classList.toggle('on', on);
  toast(on ? 'Fill mode — video fills the overlay' : 'Site layout — likes, comments & captions');
}

// Only the visible feed may make sound; background tabs stay muted no matter what.
function applyAudio() {
  for (const [site, wv] of Object.entries(views)) {
    try { wv.setAudioMuted(muted || site !== current); } catch { /* not attached yet; applied on dom-ready */ }
  }
}

function setMuted(on) {
  muted = on;
  applyAudio();
  appEl.classList.toggle('muted', on);
}

// ---------- Toolbar ----------

let pillRaf = null;
function trackPill() {
  // The active tab's width animates as its label expands, so follow it for a moment.
  const pill = $('#tab-pill');
  const until = performance.now() + 380;
  cancelAnimationFrame(pillRaf);
  const step = () => {
    const tab = document.querySelector('.tab.active');
    pill.classList.toggle('on', !!tab);
    if (tab) {
      pill.style.left = tab.offsetLeft + 'px';
      pill.style.width = tab.offsetWidth + 'px';
    }
    if (performance.now() < until) pillRaf = requestAnimationFrame(step);
  };
  step();
}

function updateBar() {
  const auto = state.settings.autoHideToolbar;
  appEl.classList.toggle('docked', !auto);
  appEl.classList.toggle('bar-hidden', auto && !!current && current !== WEB && !hover && !panel && !recording && !loginSite);
}

function setPanel(name) {
  if (name) exitFullscreen();
  if (name !== 'settings' && recording) stopRecording();
  panel = name;
  for (const id of ['settings', 'accounts']) {
    appEl.classList.toggle(`${id}-open`, name === id);
    $('#' + id).setAttribute('aria-hidden', String(name !== id));
  }
  if (name === 'accounts') refreshAccounts();
  syncPlayback();
  updateBar();
}

// ---------- Accounts ----------

function renderAccounts() {
  const list = $('#account-list');
  list.innerHTML = '';
  const browser = state.browser;
  for (const [site, info] of Object.entries(SITES)) {
    const on = !!accounts[site];
    const waiting = browserLogin?.site === site;
    let status = on ? 'Connected' : 'Not connected';
    let actions;
    if (on) {
      actions = `<button class="pill-btn small" data-open="${site}">Open</button>
                 <button class="pill-btn small ghost" data-logout="${site}">Log out</button>`;
    } else if (waiting) {
      status = browserLogin.status === 'checking'
        ? 'Checking login…'
        : `Log in, then close the ${browserLogin.browser} window`;
      actions = `<button class="pill-btn small ghost" data-cancel-browser>Cancel</button>`;
    } else if (site === 'yt' && browser) {
      // Google blocks sign-in inside apps, so YouTube goes straight to the real browser.
      actions = `<button class="pill-btn small primary" data-browser="${site}">Log in with ${browser}</button>`;
    } else {
      actions = `<button class="pill-btn small primary" data-login="${site}">Log in</button>` +
        (browser ? `<button class="pill-btn small ghost" data-browser="${site}" title="Log in in a real ${browser} window (use this for “Continue with Google”)">${browser}</button>` : '');
    }
    const row = document.createElement('div');
    row.className = 'row acct-row';
    row.innerHTML = `
      <span class="card-icon"><svg><use href="#i-${site}" /></svg></span>
      <div class="row-text">
        <b>${info.service}</b>
        <span class="status-pill${on ? ' on' : ''}${waiting ? ' waiting' : ''}">${status}</span>
      </div>
      <div class="acct-actions">${actions}</div>`;
    list.appendChild(row);
  }
  $('#browser-note').textContent = browser
    ? `Google blocks sign-in inside apps, so “${browser}” opens a real ${browser} window instead. Log in there, then close the window and DeskScroller picks up the login.`
    : 'Install Chrome or Edge to sign in with Google.';

  for (const card of document.querySelectorAll('.card')) {
    const on = !!accounts[card.dataset.site];
    const chip = card.querySelector('.conn');
    if (!chip) continue; // the browser card has no account
    chip.classList.toggle('on', on);
    chip.textContent = on ? 'Connected' : 'Not connected';
  }

  const count = Object.values(accounts).filter(Boolean).length;
  const total = Object.keys(SITES).length;
  const dot = $('#acct-dot');
  dot.classList.toggle('some', count > 0 && count < total);
  dot.classList.toggle('all', count === total);
  $('#acct-summary').textContent = `${count} of ${total} connected`;
}

async function refreshAccounts() {
  accounts = await ds.accounts();
  renderAccounts();
}

function setAccounts(status) {
  const was = accounts;
  accounts = status;
  renderAccounts();
  if (loginSite && status[loginSite]) finishLogin(loginSite);
  for (const site of Object.keys(SITES)) {
    if (was[site] && !status[site] && site !== loginSite) toast(`${SITES[site].service} disconnected`);
  }
}

function startLogin(site) {
  if (loginSite && loginSite !== site) cancelLogin();
  loginSite = site;
  setPanel(null);
  syncFocus();
  $('#lb-text').innerHTML = `Log in to <b>${SITES[site].service}</b> — you'll stay logged in.`;
  appEl.classList.add('logging-in');
  $('#btn-login-browser').textContent = state.browser ? `Use ${state.browser}` : '';
  $('#btn-login-browser').hidden = !state.browser;
  openSite(site, state.logins[site]);
  updateBar();
}

async function startBrowserLogin(site) {
  if (loginSite) cancelLogin();
  const res = await ds.browserLogin(site);
  if (!res.ok) toast(`⚠ ${escapeHtml(res.error)}`, 2600);
  else toast(`Log in in ${res.browser}, then close that window`, 3500);
}

function onBrowserLogin({ site, status, browser, error }) {
  const name = SITES[site].service;
  browserLogin = status === 'waiting' || status === 'checking' ? { site, browser, status } : null;
  renderAccounts();
  if (status === 'connected') {
    toast(`✓ Connected to ${name}`, 2200);
    setPanel(null);
    loadUrl(site, SITES[site].url);
    openSite(site);
  } else if (status === 'cancelled' && !accounts[site]) {
    toast(`Not logged in — the ${browser} window closed before the login finished`, 3000);
  } else if (status === 'error') {
    toast(`⚠ ${escapeHtml(error || 'Login failed')}`, 2600);
  }
}

function endLogin() {
  loginSite = null;
  appEl.classList.remove('logging-in');
  syncFocus();
  updateBar();
}

function finishLogin(site) {
  endLogin();
  toast(`✓ Connected to ${SITES[site].service}`, 2200);
  loadUrl(site, SITES[site].url);
}

function cancelLogin() {
  const site = loginSite;
  endLogin();
  if (site) loadUrl(site, SITES[site].url);
}

async function logout(site) {
  accounts = await ds.logout(site);
  renderAccounts();
  loadUrl(site, SITES[site].url);
  toast(`Logged out of ${SITES[site].service}`);
}

// ---------- Settings UI ----------

function renderSettings() {
  const s = state.settings;
  const pct = Math.round(s.opacity * 100);
  const range = $('#opacity');
  range.value = pct;
  range.style.setProperty('--fill', ((pct - 25) / 75) * 100 + '%');
  $('#opacity-val').textContent = pct + '%';
  $('#opt-autohide').checked = s.autoHideToolbar;
  $('#opt-ghost').checked = s.ghost;
  $('#opt-pause').checked = s.pauseOnHide;
  $('#opt-remote').checked = s.remoteDesktop;
  $('#opt-stretch').checked = s.antiStretch;
  $('#opt-ads').checked = s.skipAds;
  $('#opt-keep').checked = s.keepFeedsLoaded;
  range.disabled = s.remoteDesktop;
  $('#btn-clickthrough').textContent = state.clickThrough ? 'Disable' : 'Enable';
  renderHotkeys();
  renderHints();
  renderClickThrough();
}

function renderHotkeys() {
  const list = $('#hotkey-list');
  list.innerHTML = '';
  for (const [action, label] of Object.entries(state.labels)) {
    const accel = state.settings.hotkeys[action];
    const failed = state.failedHotkeys.includes(action);
    const row = document.createElement('div');
    row.className = 'row hk-row' + (failed ? ' failed' : '');
    const sub = failed ? '<small>Taken by another app — pick a different combo</small>' : '';
    const isRec = recording === action;
    row.innerHTML = `
      <div class="row-text"><b>${escapeHtml(label)}</b>${sub}</div>
      <button class="hk-btn${isRec ? ' recording' : ''}" data-action="${action}" title="Click to change · Backspace to clear">
        ${isRec ? 'Press keys…' : accel ? keysHtml(accel) : '<span class="unset">Not set</span>'}
      </button>`;
    list.appendChild(row);
  }
}

function renderHints() {
  const hk = state.settings.hotkeys;
  const rows = [
    ['Show / hide', keyParts(hk.toggle)],
    ['Previous / next', navKeys(keyParts(hk.prev), keyParts(hk.next))],
    ['Click-through', keyParts(hk.clickThrough)],
  ];
  $('#hints').innerHTML = rows
    .filter(([, keys]) => keys.length)
    .map(([label, keys]) => `<li>${label}${kbds(keys)}</li>`)
    .join('');
}

// "Ctrl Shift ↑ ↓" when both hotkeys share their modifiers.
function navKeys(prev, next) {
  if (!prev.length || !next.length) return prev.length ? prev : next;
  if (prev.slice(0, -1).join() === next.slice(0, -1).join()) return [...prev, next.at(-1)];
  return [...prev, '/', ...next];
}

function renderClickThrough() {
  appEl.classList.toggle('click-through', state.clickThrough);
  const accel = state.settings.hotkeys.clickThrough;
  $('#ct-badge').innerHTML = accel ? `Click-through · ${keysHtml(accel)} to exit` : 'Click-through · use the tray icon to exit';
}

// ---------- Hotkey recording ----------

const CODE_KEYS = {
  Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backquote: '`', Minus: '-', Equal: '=',
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left',
  ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  Insert: 'Insert', Delete: 'Delete', Backspace: 'Backspace',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
};

function codeToKey(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return 'num' + code.slice(6);
  if (/^F\d{1,2}$/.test(code)) return code;
  return CODE_KEYS[code] || null;
}

function startRecording(action) {
  recording = action;
  ds.suspendHotkeys(true);
  renderHotkeys();
  updateBar();
}

function stopRecording() {
  if (!recording) return;
  recording = null;
  ds.suspendHotkeys(false);
  renderHotkeys();
  updateBar();
}

async function commitHotkey(accel) {
  const action = recording;
  const res = await ds.setHotkey(action, accel);
  if (res.ok) {
    state = res.state;
    toast(accel ? `${escapeHtml(state.labels[action])} ${keysHtml(accel)}` : `${escapeHtml(state.labels[action])} cleared`);
  } else {
    toast(`⚠ ${escapeHtml(res.error)}`, 2600);
  }
  stopRecording();
  // Main re-registers on resume and reports failures via state:failed-hotkeys.
  renderSettings();
}

window.addEventListener('keydown', (e) => {
  if (!recording) {
    if (e.key === 'Escape' && panel) setPanel(null);
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  const mods = [];
  if (e.ctrlKey) mods.push('CommandOrControl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');

  if (e.code === 'Escape' && !mods.length) return stopRecording();
  if ((e.code === 'Backspace' || e.code === 'Delete') && !mods.length) return commitHotkey('');

  const key = codeToKey(e.code);
  const btn = document.querySelector(`.hk-btn[data-action="${recording}"]`);
  if (!key) {
    // Only modifiers so far: show them live.
    if (btn) btn.innerHTML = mods.length ? keysHtml(mods.join('+') + '+…') : 'Press keys…';
    return;
  }
  // Bare keys would hijack typing in games, so require a modifier (F-keys excepted).
  if (!mods.length && !/^F\d+$/.test(key)) {
    toast('Add Ctrl, Alt or Shift so it won’t clash with your game', 2200);
    return;
  }
  commitHotkey([...mods, key].join('+'));
}, true);

window.addEventListener('blur', () => recording && stopRecording());

// ---------- Wiring ----------

for (const el of document.querySelectorAll('[data-site]')) {
  if (el.tagName === 'BUTTON') el.addEventListener('click', () => openSite(el.dataset.site));
}

$('#btn-home').addEventListener('click', () => { setPanel(null); goHome(); });
$('#btn-back').addEventListener('click', () => {
  const wv = current && views[current];
  if (wv && wv.canGoBack()) wv.goBack();
});
$('#btn-reload').addEventListener('click', () => {
  const wv = current && views[current];
  if (wv) {
    resetLoading(current);
    wv.reload();
  }
});
$('#btn-fill').addEventListener('click', () => setFill(!state.settings.fill));
$('#btn-web-back').addEventListener('click', () => views[WEB]?.goBack());
$('#btn-web-forward').addEventListener('click', () => views[WEB]?.goForward());
$('#btn-web-reload').addEventListener('click', () => views[WEB]?.reload());
$('#urlbar').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = toUrl($('#url-input').value);
  if (!url) return;
  $('#url-input').blur();
  loadUrl(WEB, url);
  views[WEB].focus();
});
$('#url-input').addEventListener('focus', (e) => e.target.select());
$('#btn-web-start').addEventListener('click', () => loadUrl(WEB, PAGES[WEB].url));
$('#ws-search').addEventListener('submit', (e) => {
  e.preventDefault();
  openWeb($('#ws-input').value);
});
$('#ws-tiles').addEventListener('click', (e) => {
  const tile = e.target.closest('.ws-tile');
  if (tile) openWeb(tile.dataset.url);
});
$('#ws-recent').addEventListener('click', (e) => {
  const x = e.target.closest('[data-remove]');
  if (x) {
    saveRecent(loadRecent().filter((r) => r.host !== x.dataset.remove));
    return renderStartPage();
  }
  const row = e.target.closest('.ws-row');
  if (row) openWeb(row.dataset.url);
});
$('#url-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.target.blur(); updateNav(); }
});
$('#btn-settings').addEventListener('click', () => setPanel(panel === 'settings' ? null : 'settings'));
$('#btn-settings-close').addEventListener('click', () => setPanel(null));
$('#btn-accounts').addEventListener('click', () => setPanel(panel === 'accounts' ? null : 'accounts'));
$('#btn-accounts-close').addEventListener('click', () => setPanel(null));
$('#btn-home-accounts').addEventListener('click', () => setPanel('accounts'));
$('#btn-login-cancel').addEventListener('click', () => cancelLogin());
$('#btn-login-browser').addEventListener('click', () => startBrowserLogin(loginSite));
$('#account-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.login) startLogin(btn.dataset.login);
  else if (btn.dataset.browser) startBrowserLogin(btn.dataset.browser);
  else if ('cancelBrowser' in btn.dataset) ds.cancelBrowserLogin();
  else if (btn.dataset.logout) logout(btn.dataset.logout);
  else if (btn.dataset.open) { setPanel(null); openSite(btn.dataset.open); }
});
$('#btn-close').addEventListener('click', () => ds.quit());

$('#opacity').addEventListener('input', async (e) => {
  state = await ds.set({ opacity: Number(e.target.value) / 100 });
  renderSettings();
});
$('#size-seg').addEventListener('click', (e) => {
  const size = e.target.closest('button')?.dataset.size;
  if (size) ds.sizePreset(size);
});
$('#opt-autohide').addEventListener('change', async (e) => {
  state = await ds.set({ autoHideToolbar: e.target.checked });
  updateBar();
});
$('#opt-ghost').addEventListener('change', async (e) => {
  state = await ds.set({ ghost: e.target.checked });
  toast(e.target.checked ? 'Overlay takes focus only when you need to type' : 'Overlay takes focus whenever you click it');
});
$('#opt-pause').addEventListener('change', async (e) => {
  state = await ds.set({ pauseOnHide: e.target.checked });
});
$('#opt-keep').addEventListener('change', async (e) => {
  state = await ds.set({ keepFeedsLoaded: e.target.checked });
  if (e.target.checked) preloadFeeds();
  scheduleUnloads();
});
$('#opt-ads').addEventListener('change', async (e) => {
  state = await ds.set({ skipAds: e.target.checked });
  for (const site of Object.keys(SITES)) run(site, PAGE_SCRIPTS.skipAds(e.target.checked));
  toast(e.target.checked ? 'Ads get skipped' : 'Ads play like normal');
});
$('#opt-stretch').addEventListener('change', async (e) => {
  state = await ds.set({ antiStretch: e.target.checked });
  applyStretchLayout();
  updateResized();
});
$('#opt-remote').addEventListener('change', async (e) => {
  toast('Restarting DeskScroller…');
  state = await ds.set({ remoteDesktop: e.target.checked });
});
$('#btn-clickthrough').addEventListener('click', () => {
  setPanel(null);
  ds.toggleClickThrough();
});
$('#hotkey-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.hk-btn');
  if (!btn) return;
  if (recording === btn.dataset.action) stopRecording();
  else {
    if (recording) stopRecording();
    startRecording(btn.dataset.action);
  }
});
$('#btn-reset-hotkeys').addEventListener('click', async () => {
  state = await ds.resetHotkeys();
  renderSettings();
  toast('Hotkeys reset');
});
$('#btn-reset-pos').addEventListener('click', () => ds.resetBounds());
$('#btn-quit').addEventListener('click', () => ds.quit());

ds.on('overlay:hover', (inside) => {
  hover = inside;
  updateBar();
});

ds.on('overlay:visibility', (visible) => {
  overlayVisible = visible;
  syncPlayback();
  onOverlayVisibility(visible);
});

// Clicked back into the game: done typing, so stop holding on to focus.
ds.on('overlay:blur', () => setEditing(false));

// Links a page opens in a new tab land in the browser tab.
ds.on('browser:open', (url) => {
  setPanel(null);
  if (current === WEB) loadUrl(WEB, url);
  else openSite(WEB, url);
});

ds.on('state:click-through', (on) => {
  state.clickThrough = on;
  renderSettings();
  if (on) {
    const accel = state.settings.hotkeys.clickThrough;
    toast(accel ? `Click-through on · ${keysHtml(accel)} to exit` : 'Click-through on', 2400);
  } else {
    toast('Click-through off');
  }
});

ds.on('accounts:status', setAccounts);
ds.on('accounts:browser-login', onBrowserLogin);

ds.on('state:failed-hotkeys', (failed) => {
  state.failedHotkeys = failed;
  renderHotkeys();
});

ds.on('hotkey', async (action) => {
  if (action === 'next' || action === 'prev') {
    navigate(action === 'next' ? 1 : -1);
  } else if (action === 'playPause') {
    const res = current && await run(current, PAGE_SCRIPTS.playPause);
    if (res) toast(res === 'play' ? '▶ Playing' : '❚❚ Paused', 900);
  } else if (action === 'mute') {
    setMuted(!muted);
    toast(muted ? '🔇 Muted' : '🔊 Sound on', 900);
  }
});

// ---------- Updates ----------

function renderUpdate(u) {
  state.update = u;
  const text = {
    dev: 'Running from source — updates are off',
    idle: '',
    checking: 'Checking for updates…',
    latest: 'You’re on the latest version',
    downloading: `Downloading v${u.version}… ${u.percent || 0}%`,
    installing: `Installing v${u.version}…`,
    error: 'Couldn’t check for updates',
  }[u.state] || '';
  $('#about-version').textContent = `DeskScroller v${state.version}`;
  $('#update-text').textContent = text;
  $('#update-text').title = u.state === 'error' ? u.error || '' : '';
  $('#btn-check-updates').disabled = ['dev', 'checking', 'downloading', 'installing'].includes(u.state);

  const installing = u.state === 'installing';
  appEl.classList.toggle('updating', installing);
  $('#update-screen').setAttribute('aria-hidden', String(!installing));
  if (installing) $('#update-screen-text').textContent = `Installing v${u.version} — back in a few seconds`;
}

ds.on('update:status', renderUpdate);
$('#btn-check-updates').addEventListener('click', async () => renderUpdate(await ds.checkUpdates()));

// ---------- Anti-stretch ----------
// While a game runs in a stretched resolution the monitor widens everything. The
// page then lays out at its normal size and is squeezed by the same amount, so it
// comes out looking normal.

function applyStretchLayout() {
  const s = state.stretch;
  if (!s) {
    appEl.style.cssText = '';
  } else {
    appEl.style.cssText = `right: auto; bottom: auto; width: ${innerWidth * s.fx}px; height: ${innerHeight * s.fy}px;` +
      ` transform: scale(${1 / s.fx}, ${1 / s.fy}); transform-origin: 0 0;`;
  }
  const res = (m) => `${m.width}×${m.height}`;
  $('#stretch-text').textContent = !state.settings.antiStretch ? ''
    : s ? `Compensating: ${res(s.current)} on a ${res(s.native)} monitor`
    : state.modesReadable === false ? 'Couldn’t read your monitor’s resolution' : 'Not needed right now (normal resolution)';
}

// The size the page lays out at, which is the window's size unless anti-stretch is on.
const layoutSize = () => ({ width: innerWidth * (state.stretch?.fx || 1), height: innerHeight * (state.stretch?.fy || 1) });

ds.on('state:stretch', (s) => {
  state.stretch = s;
  applyStretchLayout();
  updateResized();
  trackPill();
});

// The default-size button only shows up once the window has been resized.
function updateResized() {
  const d = state.defaultSize, size = layoutSize();
  const resized = Math.abs(size.width - d.width) > 2 || Math.abs(size.height - d.height) > 2;
  if (resized === appEl.classList.contains('resized')) return;
  appEl.classList.toggle('resized', resized);
  trackPill();
}

window.addEventListener('resize', () => {
  if (state) {
    applyStretchLayout();
    updateResized();
  }
  trackPill();
});
$('#btn-size-reset').addEventListener('click', () => ds.sizePreset('default'));

(async function boot() {
  state = await ds.getState();
  PAGE_SCRIPTS.useFillSource(await ds.pageScript('fill'));
  appEl.classList.add('on-home');
  renderSettings();
  updateBar();
  applyStretchLayout();
  updateResized();
  renderUpdate(state.update);
  updateNav();
  $('#btn-fill').classList.toggle('on', state.settings.fill);
  await refreshAccounts();
  if (state.settings.lastSite) openSite(state.settings.lastSite);
  // Otherwise feeds load when you open them (see Memory above).
  if (state.settings.keepFeedsLoaded) preloadFeeds();
  setInterval(creepLoading, 400);
  if (state.failedHotkeys.length) {
    const names = state.failedHotkeys.map((a) => state.labels[a]).join(', ');
    toast(`⚠ Couldn’t claim hotkey: ${escapeHtml(names)}`, 3500);
  } else if (state.justUpdated) {
    toast(`✓ Updated to v${escapeHtml(state.justUpdated)}`, 3000);
  }
})();
