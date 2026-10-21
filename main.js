const { app, BrowserWindow, globalShortcut, ipcMain, screen, session, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { drawIcon } = require('./icon');
const { displayModes } = require('./displays');

const PARTITION = 'persist:deskscroller';
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');

const DEFAULT_HOTKEYS = {
  toggle: 'CommandOrControl+Shift+Space',
  next: 'CommandOrControl+Shift+Down',
  prev: 'CommandOrControl+Shift+Up',
  playPause: 'CommandOrControl+Shift+K',
  mute: 'CommandOrControl+Shift+M',
  clickThrough: 'CommandOrControl+Shift+X',
};

const HOTKEY_LABELS = {
  toggle: 'Show / hide overlay',
  next: 'Next video',
  prev: 'Previous video',
  playPause: 'Play / pause',
  mute: 'Mute / unmute',
  clickThrough: 'Click-through mode',
};

// A service counts as "connected" when its login cookie exists in our persistent session.
const ACCOUNTS = {
  yt: {
    cookies: ['LOGIN_INFO', 'SAPISID'],
    domains: ['youtube.com', 'google.com'],
    origins: ['https://www.youtube.com', 'https://accounts.google.com'],
    login: 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue%26next%3D%252Fshorts',
  },
  ig: {
    cookies: ['sessionid'],
    domains: ['instagram.com'],
    origins: ['https://www.instagram.com'],
    login: 'https://www.instagram.com/accounts/login/?next=%2Freels%2F',
  },
  tt: {
    cookies: ['sessionid', 'sid_tt'],
    domains: ['tiktok.com'],
    origins: ['https://www.tiktok.com'],
    login: 'https://www.tiktok.com/login',
  },
};

const DEFAULTS = {
  bounds: null,
  opacity: 1,
  ghost: true,
  autoHideToolbar: true,
  pauseOnHide: true,
  fill: true,
  remoteDesktop: false,
  antiStretch: false,
  lastSite: null,
  hotkeys: { ...DEFAULT_HOTKEYS },
};

// Run a separate copy with its own profile (and its own single-instance lock),
// e.g. for testing without touching your logins: DESKSCROLLER_PROFILE=<folder>.
if (process.env.DESKSCROLLER_PROFILE) app.setPath('userData', path.resolve(process.env.DESKSCROLLER_PROFILE));

let settings = loadSettings();
let win = null;
const timers = [];
let tray = null;
let clickThrough = false;
let hotkeysSuspended = false;
let focusOverride = false;
let failedHotkeys = [];
let quitting = false;
let justUpdated = null;    // version we just updated to, for a one-time "Updated" toast

// An overlay must never get stuck behind Electron's blocking "JavaScript error"
// popup (it re-appears on every timer tick); log stray errors instead.
process.on('uncaughtException', (err) => console.error('[DeskScroller]', err));

// Chrome Remote Desktop (and other screen capture) can't see GPU-composited
// windows, so remote desktop mode draws the overlay in software instead.
if (settings.remoteDesktop) app.disableHardwareAcceleration();

// Reels autoplay without needing a click inside the page first.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showOverlay(true));
  app.whenReady().then(init);
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'));
    return { ...DEFAULTS, ...raw, hotkeys: { ...DEFAULT_HOTKEYS, ...(raw.hotkeys || {}) } };
  } catch {
    return { ...DEFAULTS, hotkeys: { ...DEFAULT_HOTKEYS } };
  }
}

let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeSettings, 300);
}

function writeSettings() {
  clearTimeout(saveTimer);
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('Could not save settings:', err);
  }
}

// Hardware acceleration can only change at startup, so toggling restarts the app.
function setRemoteDesktop(on) {
  if (settings.remoteDesktop === on) return;
  settings.remoteDesktop = on;
  writeSettings();
  app.relaunch();
  quit();
}

// Layered (semi-transparent) windows also drop out of remote capture.
function applyOpacity() {
  if (!settings.remoteDesktop) win.setOpacity(settings.opacity);
}

function init() {
  // Present as plain Chrome so the sites don't serve "unsupported browser" pages.
  const ua = session.defaultSession.getUserAgent().replace(/\s(Electron|deskscroller)\/\S+/gi, '');
  app.userAgentFallback = ua;
  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(ua);
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['fullscreen', 'clipboard-sanitized-write', 'media'].includes(permission));
  });

  let cookieTimer = null;
  ses.cookies.on('changed', () => {
    clearTimeout(cookieTimer);
    cookieTimer = setTimeout(pushAccountStatus, 400);
  });

  if (settings.lastVersion && settings.lastVersion !== app.getVersion()) justUpdated = app.getVersion();
  if (settings.lastVersion !== app.getVersion()) {
    settings.lastVersion = app.getVersion();
    saveSettings();
  }

  createWindow();
  createTray();
  failedHotkeys = registerHotkeys();
  initUpdates();

  timers.push(setInterval(trackHover, 120));
  for (const ev of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(ev, onDisplaysChanged);
  if (!app.isPackaged) watchOwnFiles();
  // Some games re-assert topmost when they regain focus; keep reclaiming it.
  timers.push(setInterval(() => {
    if (win && win.isVisible() && !win.isFocused()) win.setAlwaysOnTop(true, 'screen-saver');
  }, 2000));
}

// Running from source: pick up edits instead of carrying on with stale code.
// Overlay files reload the window; main/preload changes need a full restart.
function watchOwnFiles() {
  let timer = null, restart = false;
  const changed = (needsRestart) => {
    restart = restart || needsRestart;
    clearTimeout(timer);
    // Edits land in bursts; wait for them to settle.
    timer = setTimeout(() => {
      if (restart) {
        app.relaunch();
        quit();
      } else if (win && !win.isDestroyed()) {
        win.webContents.reloadIgnoringCache();
      }
      restart = false;
    }, 1500);
  };
  for (const file of ['main.js', 'preload.js']) {
    fs.watch(path.join(__dirname, file), () => changed(true));
  }
  fs.watch(path.join(__dirname, 'renderer'), { recursive: true }, () => changed(false));
}

// Window bounds below are in "native" coordinates: where things are with every
// monitor at its normal resolution. They only differ from the window's actual
// bounds while anti-stretch is compensating (see toLogical / toNative).
function defaultBounds(width = 400, height = 720) {
  const primary = screen.getPrimaryDisplay();
  const wa = stretch && stretch.id === primary.id ? stretch.nat.workArea : primary.workArea;
  height = Math.min(height, wa.height - 48);
  return { width, height, x: wa.x + wa.width - width - 24, y: wa.y + wa.height - height - 24 };
}

function isOnScreen(nb) {
  const b = toLogical(nb);
  return screen.getAllDisplays().some(({ workArea: wa }) =>
    b.x + 80 > wa.x && b.x < wa.x + wa.width - 80 && b.y + 40 > wa.y && b.y < wa.y + wa.height - 40);
}

function createWindow() {
  stretch = computeStretch();
  const bounds = toLogical(settings.bounds && isOnScreen(settings.bounds) ? settings.bounds : defaultBounds());

  win = new BrowserWindow({
    ...bounds,
    minWidth: MIN_W,
    minHeight: MIN_H,
    frame: false,
    alwaysOnTop: true,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'DeskScroller',
    backgroundColor: '#0a0a0f',
    icon: makeIcon([32, 64]),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  applyOpacity();
  applyMinSize();
  if (settings.ghost) win.setFocusable(false);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  win.on('blur', () => {
    send('overlay:blur');
    setTimeout(() => {
      if (!win || !win.isVisible()) return;
      win.setAlwaysOnTop(true, 'screen-saver');
      win.moveTop();
    }, 60);
  });

  const persistBounds = () => {
    // Right after a resolution change these are Windows shuffling the window, not you.
    if (win.isMinimized() || Date.now() < boundsHeldUntil) return;
    settings.bounds = toNative(win.getBounds());
    saveSettings();
  };
  win.on('moved', persistBounds);
  win.on('resized', persistBounds);

  // Closing the window (× button, Alt+F4) quits; the show/hide hotkey only hides.
  win.on('close', () => {
    quitting = true;
  });
  // Forget the window once it's gone, so timers and hotkeys see "no window"
  // instead of touching a destroyed one.
  win.on('closed', () => {
    win = null;
  });
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function showOverlay(focus = false) {
  if (!win) return;
  // showInactive keeps the game focused when the overlay comes back.
  const wasHidden = !win.isVisible();
  if (focus && !settings.ghost) win.show();
  else win.showInactive();
  // A non-focusable window that was hidden comes back swallowing every mousedown
  // (mouseup still arrives) until it's resized; a 1px nudge resets it.
  if (wasHidden && settings.ghost && !focusOverride) {
    const b = win.getBounds();
    win.setBounds({ ...b, width: b.width + 1 });
    win.setBounds(b);
  }
  win.setAlwaysOnTop(true, 'screen-saver');
  send('overlay:visibility', true);
  refreshTray();
}

function hideOverlay() {
  if (!win || !win.isVisible()) return;
  send('overlay:visibility', false);
  win.hide();
  refreshTray();
}

function toggleOverlay() {
  if (!win) return;
  if (win.isVisible()) hideOverlay();
  else showOverlay();
}

function setClickThrough(on) {
  clickThrough = on;
  win.setIgnoreMouseEvents(on);
  send('state:click-through', on);
  refreshTray();
}

let lastInside = null;
function trackHover() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  const p = screen.getCursorScreenPoint();
  const b = win.getBounds();
  const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
  if (inside !== lastInside) {
    lastInside = inside;
    send('overlay:hover', inside);
  }
}

const ACTIONS = {
  toggle: () => toggleOverlay(),
  next: () => win && win.isVisible() && send('hotkey', 'next'),
  prev: () => win && win.isVisible() && send('hotkey', 'prev'),
  playPause: () => win && win.isVisible() && send('hotkey', 'playPause'),
  mute: () => send('hotkey', 'mute'),
  clickThrough: () => {
    if (!win) return;
    if (!win.isVisible()) showOverlay();
    setClickThrough(!clickThrough);
  },
};

function registerHotkeys() {
  globalShortcut.unregisterAll();
  if (hotkeysSuspended) return [];
  const failed = [];
  for (const [action, accel] of Object.entries(settings.hotkeys)) {
    if (!accel || !ACTIONS[action]) continue;
    try {
      if (!globalShortcut.register(accel, ACTIONS[action])) failed.push(action);
    } catch {
      failed.push(action);
    }
  }
  return failed;
}

function canRegister(accel) {
  try {
    const ok = globalShortcut.register(accel, () => {});
    if (ok) globalShortcut.unregister(accel);
    return ok;
  } catch {
    return false;
  }
}

function publicState() {
  return {
    settings,
    labels: HOTKEY_LABELS,
    defaults: DEFAULT_HOTKEYS,
    failedHotkeys,
    clickThrough,
    partition: PARTITION,
    logins: Object.fromEntries(Object.entries(ACCOUNTS).map(([site, acc]) => [site, acc.login])),
    browser: findBrowser()?.name || null,
    defaultSize: (({ width, height }) => ({ width, height }))(defaultBounds()),
    stretch: stretchInfo(),
    // Whether Windows told us the monitors' resolutions (anti-stretch needs them).
    modesReadable: settings.antiStretch ? displayModes().length > 0 : null,
    version: app.getVersion(),
    justUpdated,
    update: updateState,
  };
}

// ---------- Anti-stretch ----------
// In a stretched resolution (e.g. 1920x1440 on a 2560x1440 monitor, whether a game
// switched to it or it's the desktop resolution) the GPU or monitor stretches the
// picture to fill the panel, overlay included. Anti-stretch keeps the overlay's
// physical size, shape and place: its bounds are kept in native coordinates and
// mapped into the current mode, and the page lays out at its native size and is
// squeezed to fit, so the stretch puts it back to normal.

const MIN_W = 280, MIN_H = 420;
let stretch = null;        // { id, nat, cur, fx, fy, offX, offY, native, current } while compensating
let boundsHeldUntil = 0;

// How Windows says the picture is fitted to the panel (DISPLAYCONFIG_SCALING).
// Driver-level scaling (the usual way to stretch) reports identity, so anything
// that isn't centered or aspect-fit counts as stretched.
const SCALING_CENTERED = 2, SCALING_ASPECT = 4;

const phys = (d) => ({ width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) });
const near = (a, b) => Math.abs(a - b) <= 4;
const same = (a, b) => near(a.width, b.width) && near(a.height, b.height);

// Windows' modes for an Electron display, matched by its current physical size
// (and, between same-size monitors, the closest position).
function modeFor(d, modes) {
  const p = phys(d);
  const dist = (m) => Math.min(
    Math.hypot(m.current.x - d.nativeOrigin.x, m.current.y - d.nativeOrigin.y),
    Math.hypot(m.current.x - d.bounds.x * d.scaleFactor, m.current.y - d.bounds.y * d.scaleFactor));
  return modes.filter((m) => same(m.current, p)).sort((a, b) => dist(a) - dist(b))[0] || null;
}

function computeStretch() {
  if (!settings.antiStretch) return null;
  const modes = process.env.DESKSCROLLER_FAKE_NATIVE ? fakeModes() : displayModes();
  if (!modes.length) return null;
  // Remember each monitor as it looks at its native resolution (exact bounds and
  // taskbar) for mapping back later. A remembered layout from another resolution
  // is no use, so it only counts if its size matches the native one.
  const snaps = settings.nativeDisplays || {};
  for (const d of screen.getAllDisplays()) {
    const m = modeFor(d, modes);
    if (m && same(m.native, phys(d))) snaps[d.id] = { bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor };
  }
  settings.nativeDisplays = snaps;
  const snapFor = (d, native) => {
    const s = snaps[d.id];
    return s && same(native, phys(s)) && !process.env.DESKSCROLLER_FAKE_NATIVE ? s : null;
  };

  // The monitor the overlay lives on.
  const nb = settings.bounds || defaultBounds();
  const center = { x: nb.x + nb.width / 2, y: nb.y + nb.height / 2 };
  const cur = screen.getAllDisplays().find((d) => {
    const m = modeFor(d, modes);
    const r = ((m && snapFor(d, m.native)) || d).bounds;
    return center.x >= r.x && center.x < r.x + r.width && center.y >= r.y && center.y < r.y + r.height;
  }) || screen.getDisplayNearestPoint({ x: Math.round(center.x), y: Math.round(center.y) });

  const m = modeFor(cur, modes), p = phys(cur);
  if (!m || same(m.native, p) || m.native.scaling === SCALING_CENTERED) return null;

  // Never seen at its native resolution: assume the same scaling and taskbar.
  let nat = snapFor(cur, m.native);
  if (!nat) {
    const sf = cur.scaleFactor;
    const kx = m.native.width / sf / cur.bounds.width, ky = m.native.height / sf / cur.bounds.height;
    const b = cur.bounds, wa = cur.workArea;
    nat = {
      bounds: { x: b.x, y: b.y, width: Math.round(b.width * kx), height: Math.round(b.height * ky) },
      workArea: { x: Math.round(b.x + (wa.x - b.x) * kx), y: Math.round(b.y + (wa.y - b.y) * ky), width: Math.round(wa.width * kx), height: Math.round(wa.height * ky) },
      scaleFactor: sf,
    };
  }
  let fx = nat.bounds.width / cur.bounds.width, fy = nat.bounds.height / cur.bounds.height;
  let offX = 0, offY = 0;
  if (m.native.scaling === SCALING_ASPECT) {
    // Scaled evenly with black bars: same shape, just bigger and centered.
    fx = fy = Math.min(fx, fy);
    offX = (nat.bounds.width - cur.bounds.width * fx) / 2;
    offY = (nat.bounds.height - cur.bounds.height * fy) / 2;
  }
  return {
    id: cur.id,
    nat,
    cur: { bounds: cur.bounds },
    fx,
    fy,
    offX,
    offY,
    native: { width: m.native.width, height: m.native.height },
    current: p,
  };
}

// Testing without a game: DESKSCROLLER_FAKE_NATIVE=WxH pretends the primary
// monitor's native resolution is WxH, so its real mode looks like a stretched one.
function fakeModes() {
  const [width, height] = process.env.DESKSCROLLER_FAKE_NATIVE.split('x').map(Number);
  const d = screen.getPrimaryDisplay();
  return [{ device: 'fake', current: { x: d.nativeOrigin.x, y: d.nativeOrigin.y, ...phys(d) }, native: { width, height, scaling: 1 } }];
}

// Native -> actual window bounds, and back. Identity unless compensating.
function toLogical(r) {
  if (!stretch) return r;
  const { nat, cur, fx, fy, offX, offY } = stretch;
  return {
    x: Math.round(cur.bounds.x + (r.x - nat.bounds.x - offX) / fx),
    y: Math.round(cur.bounds.y + (r.y - nat.bounds.y - offY) / fy),
    width: Math.round(r.width / fx),
    height: Math.round(r.height / fy),
  };
}

function toNative(r) {
  if (!stretch) return r;
  const { nat, cur, fx, fy, offX, offY } = stretch;
  return {
    x: Math.round(nat.bounds.x + offX + (r.x - cur.bounds.x) * fx),
    y: Math.round(nat.bounds.y + offY + (r.y - cur.bounds.y) * fy),
    width: Math.round(r.width * fx),
    height: Math.round(r.height * fy),
  };
}

function setNativeBounds(nb) {
  settings.bounds = nb;
  saveSettings();
  win.setBounds(toLogical(nb));
}

function applyMinSize() {
  const fx = stretch ? stretch.fx : 1, fy = stretch ? stretch.fy : 1;
  win.setMinimumSize(Math.round(MIN_W / fx), Math.round(MIN_H / fy));
}

function stretchInfo() {
  if (!stretch) return null;
  return { fx: stretch.fx, fy: stretch.fy, native: stretch.native, current: stretch.current };
}

function applyStretch() {
  if (!win) return;
  const before = JSON.stringify(stretchInfo());
  stretch = computeStretch();
  saveSettings();
  const changed = JSON.stringify(stretchInfo()) !== before;
  if (!changed && !stretch) return;
  boundsHeldUntil = Date.now() + 2000;
  applyMinSize();
  const nb = settings.bounds && isOnScreen(settings.bounds) ? settings.bounds : defaultBounds();
  win.setBounds(toLogical(nb));
  if (changed) send('state:stretch', stretchInfo());
}

// Windows moves windows around for a moment after a resolution change, so
// settle the overlay a few times.
let displayTimers = [];
function onDisplaysChanged() {
  boundsHeldUntil = Date.now() + 2000;
  displayTimers.forEach(clearTimeout);
  displayTimers = [0, 400, 1200].map((ms) => setTimeout(applyStretch, ms));
}

// ---------- Updates ----------
// Installed copies check GitHub Releases at startup and every few hours. A new
// version downloads in the background; once it's ready the overlay says
// "Updating…" and DeskScroller restarts into it. Running from source never updates.

const UPDATE_EVERY = 3 * 60 * 60 * 1000;
let updater = null;
let updateState = { state: app.isPackaged ? 'idle' : 'dev' };

function setUpdateState(next) {
  updateState = next;
  send('update:status', next);
}

function initUpdates() {
  if (!app.isPackaged) return;
  ({ autoUpdater: updater } = require('electron-updater'));
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('update-available', (info) => setUpdateState({ state: 'downloading', version: info.version, percent: 0 }));
  updater.on('download-progress', (p) => setUpdateState({ ...updateState, state: 'downloading', percent: Math.round(p.percent) }));
  updater.on('update-not-available', () => setUpdateState({ state: 'latest' }));
  updater.on('update-downloaded', (info) => {
    setUpdateState({ state: 'installing', version: info.version });
    showOverlay();
    // Long enough to read "Updating…", then restart into the new version.
    setTimeout(() => {
      quitting = true;
      updater.quitAndInstall(true, true);
    }, 2500);
  });
  updater.on('error', (err) => {
    console.error('[DeskScroller] Update failed:', err);
    setUpdateState({ state: 'error', error: String((err && err.message) || err).split('\n')[0] });
  });
  checkForUpdates();
  timers.push(setInterval(checkForUpdates, UPDATE_EVERY));
}

function checkForUpdates() {
  if (!updater || updateState.state === 'downloading' || updateState.state === 'installing') return;
  setUpdateState({ state: 'checking' });
  // Failures (offline, no releases yet) arrive through the 'error' event.
  updater.checkForUpdates().catch(() => {});
}

// ---------- Accounts ----------

const onDomain = (cookieDomain, domain) => {
  const d = cookieDomain.replace(/^\./, '');
  return d === domain || d.endsWith('.' + domain);
};

// Works on both Electron cookies (expirationDate) and Chrome DevTools cookies (expires, -1 = session).
function hasLogin(site, cookies) {
  const acc = ACCOUNTS[site];
  const now = Date.now() / 1000;
  return cookies.some((c) => {
    const exp = c.expirationDate ?? (c.expires > 0 ? c.expires : undefined);
    return c.value && (!exp || exp > now) && acc.cookies.includes(c.name) && onDomain(c.domain, acc.domains[0]);
  });
}

async function accountStatus() {
  const cookies = await session.fromPartition(PARTITION).cookies.get({});
  return Object.fromEntries(Object.keys(ACCOUNTS).map((site) => [site, hasLogin(site, cookies)]));
}

let lastStatus = '';
async function pushAccountStatus() {
  const status = await accountStatus();
  const key = JSON.stringify(status);
  if (key !== lastStatus) {
    lastStatus = key;
    send('accounts:status', status);
  }
}

async function logout(site) {
  const acc = ACCOUNTS[site];
  if (!acc) return accountStatus();
  const ses = session.fromPartition(PARTITION);
  const cookies = await ses.cookies.get({});
  await Promise.all(cookies
    .filter((c) => acc.domains.some((d) => onDomain(c.domain, d)))
    .map((c) => ses.cookies.remove(`https://${c.domain.replace(/^\./, '')}${c.path || '/'}`, c.name).catch(() => {})));
  await Promise.all(acc.origins.map((origin) => ses.clearStorageData({
    origin,
    storages: ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage'],
  }).catch(() => {})));
  // Forget the real-browser profile too, or the next browser login would
  // silently reconnect the same account and switching accounts would be impossible.
  if (!browserJob) fs.rmSync(BROWSER_PROFILE(), { recursive: true, force: true });
  return accountStatus();
}

// ---------- Logging in through a real Chrome / Edge window ----------
// Google refuses sign-in inside embedded browsers, and also in real Chrome when
// it's started with a DevTools debugging port. So login is two steps:
//   1. a completely normal Chrome window on a dedicated profile; the user logs in
//      and closes it.
//   2. that profile is reopened headless with DevTools on, with no page loaded,
//      just long enough to read the cookies and copy the session into the overlay.

const BROWSER_PROFILE = () => path.join(app.getPath('userData'), 'browser-login');
const SAME_SITE = { Strict: 'strict', Lax: 'lax', None: 'no_restriction' };

function findBrowser() {
  const pf = process.env.ProgramFiles, pf86 = process.env['ProgramFiles(x86)'], local = process.env.LOCALAPPDATA;
  const candidates = [
    ['Chrome', pf, 'Google/Chrome/Application/chrome.exe'],
    ['Chrome', pf86, 'Google/Chrome/Application/chrome.exe'],
    ['Chrome', local, 'Google/Chrome/Application/chrome.exe'],
    ['Edge', pf86, 'Microsoft/Edge/Application/msedge.exe'],
    ['Edge', pf, 'Microsoft/Edge/Application/msedge.exe'],
  ];
  for (const [name, base, rel] of candidates) {
    const exe = base && path.join(base, rel);
    if (exe && fs.existsSync(exe)) return { name, exe };
  }
  return null;
}

function connectDevTools(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let id = 0;
    ws.onopen = () => resolve({
      call: (method, params = {}) => new Promise((res, rej) => {
        const i = ++id;
        pending.set(i, { res, rej });
        ws.send(JSON.stringify({ id: i, method, params }));
      }),
      close: () => ws.close(),
    });
    ws.onerror = () => reject(new Error('Could not connect to the browser'));
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.rej(new Error(msg.error.message));
      else p.res(msg.result);
    };
    ws.onclose = () => {
      for (const p of pending.values()) p.rej(new Error('Browser closed'));
      pending.clear();
    };
  });
}

async function importCookies(site, cookies) {
  const ses = session.fromPartition(PARTITION);
  const { domains } = ACCOUNTS[site];
  let count = 0;
  for (const c of cookies) {
    if (c.partitionKey || !domains.some((d) => onDomain(c.domain, d))) continue;
    const details = {
      url: `https://${c.domain.replace(/^\./, '')}${c.path || '/'}`,
      name: c.name,
      value: c.value,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: SAME_SITE[c.sameSite] || 'unspecified',
    };
    // A leading dot means a domain cookie; without it the cookie is host-only.
    if (c.domain.startsWith('.')) details.domain = c.domain;
    if (c.expires > 0) details.expirationDate = c.expires;
    try {
      await ses.cookies.set(details);
      count++;
    } catch { /* Chromium rejects a few cookie shapes when set from outside; skip them */ }
  }
  await ses.cookies.flushStore();
  return count;
}

let browserJob = null;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function startBrowserLogin(site) {
  stopBrowserLogin();
  const browser = findBrowser();
  if (!browser) return { ok: false, error: 'Couldn’t find Chrome or Edge on this PC' };

  // Open beside the overlay so the overlay doesn't cover it.
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const w = 520, h = Math.min(780, wa.height - 40);
  const x = b.x - w - 16 >= wa.x ? b.x - w - 16 : Math.max(wa.x, b.x + b.width + 16 - w);
  const y = Math.max(wa.y, Math.min(b.y + b.height - h, wa.y + wa.height - h));

  const proc = spawn(browser.exe, [
    `--user-data-dir=${BROWSER_PROFILE()}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    `--window-size=${w},${h}`,
    `--window-position=${x},${y}`,
    ACCOUNTS[site].login,
  ], { stdio: 'ignore' });

  const job = { site, proc, browser, done: false };
  browserJob = job;
  proc.on('error', () => endBrowserLogin(job, 'error', `Couldn’t start ${browser.name}`));
  proc.on('exit', () => harvestLogin(job));
  send('accounts:browser-login', { site, status: 'waiting', browser: browser.name });
  return { ok: true, browser: browser.name };
}

async function harvestLogin(job) {
  if (job.done) return;
  send('accounts:browser-login', { site: job.site, status: 'checking', browser: job.browser.name });
  try {
    const cookies = await readProfileCookies(job.browser.exe);
    if (job.done) return;
    if (hasLogin(job.site, cookies)) {
      await importCookies(job.site, cookies);
      endBrowserLogin(job, 'connected');
      pushAccountStatus();
    } else {
      endBrowserLogin(job, 'cancelled');
    }
  } catch (err) {
    endBrowserLogin(job, 'error', err.message);
  }
}

async function readProfileCookies(exe) {
  const dir = BROWSER_PROFILE();
  const portFile = path.join(dir, 'DevToolsActivePort');
  fs.rmSync(portFile, { force: true });
  const proc = spawn(exe, [
    `--user-data-dir=${dir}`,
    '--headless=new',
    '--remote-debugging-port=0',
    '--no-first-run',
    'about:blank',
  ], { stdio: 'ignore' });
  let exited = false;
  proc.on('exit', () => { exited = true; });

  try {
    let port, wsPath;
    for (let i = 0; i < 80 && !wsPath; i++) {
      await wait(250);
      // Exiting right away means another window still has this profile open.
      if (exited) throw new Error('Close the DeskScroller browser window and try again');
      try {
        [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
      } catch { /* not written yet */ }
    }
    if (!wsPath) throw new Error('The browser didn’t respond — try again');
    const devtools = await connectDevTools(`ws://127.0.0.1:${port}${wsPath}`);
    try {
      const { cookies } = await devtools.call('Storage.getCookies');
      await devtools.call('Browser.close').catch(() => {});
      return cookies;
    } finally {
      devtools.close();
    }
  } finally {
    setTimeout(() => { if (proc.exitCode === null) proc.kill(); }, 3000);
  }
}

function endBrowserLogin(job, status, error) {
  if (job.done) return;
  job.done = true;
  if (browserJob === job) browserJob = null;
  send('accounts:browser-login', { site: job.site, status, browser: job.browser.name, error });
}

function stopBrowserLogin() {
  const job = browserJob;
  if (!job) return;
  endBrowserLogin(job, 'cancelled');
  if (job.proc.exitCode === null) job.proc.kill();
}

// ---------- IPC ----------

ipcMain.handle('accounts:get', () => accountStatus());
ipcMain.handle('page-script', (_e, name) => {
  if (!['fill'].includes(name)) throw new Error('Unknown page script');
  return fs.readFileSync(path.join(__dirname, 'renderer', 'inject', `${name}.js`), 'utf8');
});
ipcMain.handle('accounts:browser-login', (_e, site) => (ACCOUNTS[site] ? startBrowserLogin(site) : { ok: false, error: 'Unknown service' }));
ipcMain.on('accounts:browser-login-cancel', () => stopBrowserLogin());
ipcMain.handle('accounts:logout', (_e, site) => logout(site));

// The overlay asks for focus while you need to type (browser tab, logins, text
// boxes); smart focus keeps it unfocusable the rest of the time.
ipcMain.on('window:focus-override', (_e, on) => {
  focusOverride = on;
  if (on) {
    win.setFocusable(true);
    win.focus();
  } else if (settings.ghost && !hotkeysSuspended) {
    win.setFocusable(false);
  }
});

ipcMain.handle('state:get', () => publicState());

ipcMain.handle('settings:set', (_e, patch) => {
  if (typeof patch.opacity === 'number') {
    settings.opacity = Math.min(1, Math.max(0.25, patch.opacity));
    applyOpacity();
  }
  if (typeof patch.remoteDesktop === 'boolean') {
    // Let the reply reach the panel before restarting.
    setTimeout(() => setRemoteDesktop(patch.remoteDesktop), 400);
  }
  if (typeof patch.ghost === 'boolean') {
    settings.ghost = patch.ghost;
    win.setFocusable(!patch.ghost || focusOverride);
    win.setAlwaysOnTop(true, 'screen-saver');
  }
  if (typeof patch.autoHideToolbar === 'boolean') settings.autoHideToolbar = patch.autoHideToolbar;
  if (typeof patch.pauseOnHide === 'boolean') settings.pauseOnHide = patch.pauseOnHide;
  if (typeof patch.fill === 'boolean') settings.fill = patch.fill;
  if (typeof patch.antiStretch === 'boolean' && patch.antiStretch !== settings.antiStretch) {
    settings.antiStretch = patch.antiStretch;
    applyStretch();
  }
  if ('lastSite' in patch) settings.lastSite = patch.lastSite;
  saveSettings();
  return publicState();
});

ipcMain.handle('hotkey:set', (_e, action, accel) => {
  if (!(action in DEFAULT_HOTKEYS)) return { ok: false, error: 'Unknown action' };
  if (accel) {
    const dup = Object.entries(settings.hotkeys).find(([a, k]) => a !== action && k === accel);
    if (dup) return { ok: false, error: `Already used for "${HOTKEY_LABELS[dup[0]]}"` };
    globalShortcut.unregisterAll();
    if (!canRegister(accel)) {
      return { ok: false, error: 'Another app already owns that shortcut' };
    }
  }
  settings.hotkeys[action] = accel || '';
  saveSettings();
  return { ok: true, state: publicState() };
});

ipcMain.handle('hotkeys:reset', () => {
  settings.hotkeys = { ...DEFAULT_HOTKEYS };
  saveSettings();
  failedHotkeys = registerHotkeys();
  return publicState();
});

ipcMain.on('hotkeys:suspend', (_e, on) => {
  hotkeysSuspended = on;
  if (on) {
    globalShortcut.unregisterAll();
    // Recording needs keyboard focus, even in "don't steal focus" mode.
    win.setFocusable(true);
    win.focus();
  } else {
    if (settings.ghost && !focusOverride) win.setFocusable(false);
    failedHotkeys = registerHotkeys();
    send('state:failed-hotkeys', failedHotkeys);
  }
});

ipcMain.on('window:click-through', () => setClickThrough(!clickThrough));
ipcMain.on('window:reset-bounds', () => setNativeBounds(defaultBounds()));
ipcMain.on('window:size', (_e, preset) => {
  const def = defaultBounds();
  const sizes = { s: [300, 534], m: [380, 676], l: [460, 818], default: [def.width, def.height] };
  const [w, h] = sizes[preset] || sizes.m;
  const b = toNative(win.getBounds());
  const d = screen.getDisplayMatching(win.getBounds());
  const wa = stretch && stretch.id === d.id ? stretch.nat.workArea : d.workArea;
  const width = Math.min(w, wa.width), height = Math.min(h, wa.height);
  // Keep the bottom-right corner anchored, since that's where the overlay usually lives.
  const x = Math.max(wa.x, Math.min(b.x + b.width - width, wa.x + wa.width - width));
  const y = Math.max(wa.y, Math.min(b.y + b.height - height, wa.y + wa.height - height));
  setNativeBounds({ x, y, width, height });
});
ipcMain.on('app:quit', () => quit());
ipcMain.handle('update:check', () => {
  checkForUpdates();
  return updateState;
});

// ---------- Webview hardening & popups ----------

app.on('web-contents-created', (_e, contents) => {
  // Sites register "leave this page?" handlers (Instagram, TikTok when logged in)
  // that would otherwise silently block closing and restarting the app.
  contents.on('will-prevent-unload', (e) => e.preventDefault());

  contents.on('will-attach-webview', (_ev, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    params.partition = PARTITION;
  });

  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(({ url, disposition }) => {
      // Links meant for a new tab open in the browser tab instead.
      if (disposition === 'foreground-tab' || disposition === 'background-tab') {
        if (/^https?:/i.test(url)) send('browser:open', url);
        return { action: 'deny' };
      }
      return popupWindow();
    });
  }
});

// Login flows (Google, Facebook…) open popups; keep them above the overlay.
function popupWindow() {
  return {
    action: 'allow',
    overrideBrowserWindowOptions: {
      parent: win,
      width: 500,
      height: 720,
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: { partition: PARTITION },
    },
  };
}

// ---------- Tray ----------

function createTray() {
  tray = new Tray(makeIcon([16, 32]));
  tray.setToolTip('DeskScroller');
  tray.on('click', () => toggleOverlay());
  refreshTray();
}

function prettyAccel(accel) {
  return (accel || '').replace('CommandOrControl', 'Ctrl');
}

function refreshTray() {
  if (!tray || !win) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: win.isVisible() ? 'Hide overlay' : 'Show overlay', accelerator: prettyAccel(settings.hotkeys.toggle) || undefined, click: toggleOverlay },
    { label: 'Click-through', type: 'checkbox', checked: clickThrough, click: () => setClickThrough(!clickThrough) },
    { label: 'Remote desktop mode (restarts)', type: 'checkbox', checked: settings.remoteDesktop, click: () => setRemoteDesktop(!settings.remoteDesktop) },
    { label: 'Reset position', click: () => { showOverlay(); setNativeBounds(defaultBounds()); } },
    { type: 'separator' },
    { label: 'Quit DeskScroller', click: quit },
  ]));
}

function quit() {
  quitting = true;
  app.quit();
  // Backstop: never get stuck half-closed.
  setTimeout(() => app.exit(0), 3000).unref();
}

app.on('will-quit', () => {
  timers.forEach(clearInterval);
  globalShortcut.unregisterAll();
  stopBrowserLogin();
});
app.on('window-all-closed', () => app.quit());

// ---------- Icon (drawn in code, see icon.js) ----------

function makeIcon([base, hi]) {
  const img = nativeImage.createEmpty();
  img.addRepresentation({ scaleFactor: 1, width: base, height: base, buffer: drawIcon(base) });
  img.addRepresentation({ scaleFactor: 2, width: hi, height: hi, buffer: drawIcon(hi) });
  return img;
}
