// Fill mode, injected into each feed page (YouTube Shorts, Instagram Reels, TikTok).
//
// A full-window canvas mirrors whichever video is in view, so the video fills
// the overlay without rearranging the site's own layout (which would break with
// every redesign). On top of it sits our own UI in a shadow root: like /
// comment / share / sound buttons that drive the site's real ones, and a
// comments sheet built from the site's comment list.
//
// This file is one expression: a function the overlay calls as install(on).
// It talks back to the overlay through console messages:
//   '__ds:nav:<1|-1>'  wheel tick on the video -> next / previous
//   '__ds:skip:<1|-1>' moving past an ad (not your scroll)
//   '__ds:ad:<why>'    what made that video look like an ad
//   '__ds:copy:<url>'  share: put this link on the clipboard
//   '__ds:focus:<1|0>' (page-scripts) clicked a text box / anything else
//   '__ds:fill:<1|0>'  started / stopped showing a video
(function install(on) {
  const ds = window.__dsFill || (window.__dsFill = {});
  ds.on = on;
  if (ds.installed) return 'updated';
  ds.installed = true;

  const SITE = /youtube/.test(location.hostname) ? 'yt'
    : /instagram/.test(location.hostname) ? 'ig'
    : /tiktok/.test(location.hostname) ? 'tt' : '';

  // ---------- small helpers ----------
  // Everything is built with DOM calls: YouTube's Trusted Types policy rejects innerHTML.

  const h = (tag, props = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    el.append(...kids);
    return el;
  };

  const icon = (...paths) => {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    for (const attrs of paths) {
      const el = document.createElementNS(NS, 'path');
      for (const k in attrs) el.setAttribute(k, attrs[k]);
      svg.appendChild(el);
    }
    return svg;
  };
  const line = { fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  const HEART = 'M12 20s-7.5-4.6-7.5-10.1A4.3 4.3 0 0 1 12 7.4a4.3 4.3 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z';
  const SPEAKER = { d: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4z', fill: 'currentColor' };
  const ICONS = {
    like: () => icon({ ...line, d: HEART }),
    comment: () => icon({ ...line, d: 'M20 11.5a7.5 7.5 0 0 1-11.1 6.6L4.5 19.5l1.4-4.1A7.5 7.5 0 1 1 20 11.5z' }),
    share: () => icon({ ...line, d: 'M20.5 3.5 10 14M20.5 3.5 14 20.5l-4-6.5-6.5-4z' }),
    soundOn: () => icon(SPEAKER, { ...line, d: 'M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11' }),
    soundOff: () => icon(SPEAKER, { ...line, d: 'M16 9.5l5 5M21 9.5l-5 5' }),
    close: () => icon({ ...line, d: 'M7 7l10 10M17 7 7 17' }),
    send: () => icon({ ...line, d: 'M4 12 20 4l-6 16-3-7z' }),
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const textOf = (el) => ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
  const imgOf = (el) => {
    const i = el && (el.tagName === 'IMG' ? el : el.querySelector('img'));
    return (i && (i.currentSrc || i.src)) || '';
  };
  const centerOf = (el) => {
    const r = el.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2, r.width * r.height];
  };
  const visibleArea = (r) =>
    Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) *
    Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
  const scrollable = (el) => {
    const s = getComputedStyle(el);
    return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 4;
  };
  const scrollParent = (el) => {
    for (let p = el && el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      if (scrollable(p)) return p;
    }
    return document.scrollingElement;
  };

  // ---------- page-level style: hide the site's scrollbars under the video ----------

  document.head.appendChild(h('style', { text: `
    html.__ds-filling ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
    html.__ds-filling, html.__ds-filling * { scrollbar-width: none !important; }
  ` }));

  // ---------- canvas ----------

  const canvas = ds.canvas = h('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483000;background:#000;display:none;cursor:pointer;';
  const ctx = canvas.getContext('2d');
  const snap = h('canvas');
  const snapCtx = snap.getContext('2d');

  // ---------- our UI, isolated from the site's CSS in a shadow root ----------

  const host = h('div');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483001;pointer-events:none;display:none;';
  const root = host.attachShadow({ mode: 'open' });
  root.appendChild(h('style', { text: `
    :host { all: initial; }
    * { box-sizing: border-box; }
    button { font: inherit; }

    .col {
      position: absolute; right: 10px; bottom: 16px;
      display: flex; flex-direction: column; align-items: center; gap: 12px;
      pointer-events: auto; transition: opacity .25s, transform .3s cubic-bezier(.2,.8,.2,1);
    }
    .col.away { opacity: 0; transform: translateX(20px); pointer-events: none; }
    .act {
      display: flex; flex-direction: column; align-items: center; gap: 4px;
      background: none; border: 0; padding: 0; margin: 0; color: #fff; cursor: pointer;
      font: 600 11px/1.1 system-ui, 'Segoe UI', sans-serif; text-shadow: 0 1px 3px rgba(0,0,0,.9);
    }
    .circ {
      width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center;
      background: rgba(10,10,15,.45); backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,.14); transition: transform .15s, background .15s, color .2s;
    }
    .act:hover .circ { background: rgba(10,10,15,.75); transform: scale(1.07); }
    .act:active .circ { transform: scale(.92); }
    .circ svg { width: 22px; height: 22px; }
    .count:empty { display: none; }
    .act.on .circ { color: #ff3b5c; }
    .act.on .circ path { fill: currentColor; }
    .act.pop .circ { animation: pop .4s cubic-bezier(.2,.8,.2,1); }
    @keyframes pop { 35% { transform: scale(1.28); } }


    .sheet {
      position: absolute; left: 0; right: 0; bottom: 0; height: 66%;
      display: flex; flex-direction: column; pointer-events: auto;
      background: rgba(17,17,24,.96); backdrop-filter: blur(24px) saturate(1.4);
      border-radius: 18px 18px 0 0; border-top: 1px solid rgba(255,255,255,.1);
      box-shadow: 0 -20px 50px rgba(0,0,0,.55);
      font: 13px/1.42 system-ui, 'Segoe UI', sans-serif; color: #f3f3f7;
      transform: translateY(105%); transition: transform .38s cubic-bezier(.2,.8,.2,1);
    }
    .sheet.open { transform: none; }
    .grab { width: 36px; height: 4px; border-radius: 2px; background: rgba(255,255,255,.22); margin: 8px auto 0; flex: none; }
    .head { display: flex; align-items: center; gap: 6px; padding: 8px 10px 10px 16px; border-bottom: 1px solid rgba(255,255,255,.07); flex: none; }
    .head b { font-size: 14.5px; font-weight: 700; }
    .head .n { color: #9797a8; font-weight: 600; }
    .x {
      margin-left: auto; width: 30px; height: 30px; border-radius: 9px; border: 0; cursor: pointer;
      background: rgba(255,255,255,.07); color: #ddd; display: grid; place-items: center;
    }
    .x:hover { background: rgba(255,255,255,.15); color: #fff; }
    .x svg { width: 16px; height: 16px; }
    .list { flex: 1; overflow-y: auto; padding: 4px 6px 8px 14px; overscroll-behavior: contain; }
    .list::-webkit-scrollbar { width: 6px; }
    .list::-webkit-scrollbar-thumb { background: rgba(255,255,255,.14); border-radius: 3px; }
    .c { display: flex; gap: 10px; padding: 10px 4px 10px 0; animation: rise .28s ease both; }
    @keyframes rise { from { opacity: 0; transform: translateY(6px); } }
    .av {
      width: 32px; height: 32px; border-radius: 50%; flex: none; background: rgba(255,255,255,.1) center / cover no-repeat;
      display: grid; place-items: center; font-weight: 700; font-size: 13px; color: #fff;
    }
    .body { flex: 1; min-width: 0; }
    .meta { display: flex; gap: 6px; align-items: baseline; font-size: 12px; color: #8d8d9e; }
    .meta b { color: #e8e8f0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 65%; }
    .txt { margin-top: 2px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .lk { flex: none; width: 34px; display: flex; flex-direction: column; align-items: center; gap: 2px; padding-top: 6px; color: #8d8d9e; font-size: 11px; }
    .lk svg { width: 15px; height: 15px; }
    .state { padding: 36px 20px; text-align: center; color: #9797a8; display: flex; flex-direction: column; align-items: center; gap: 12px; }
    .state button {
      padding: 8px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,.14);
      background: rgba(255,255,255,.08); color: #fff; cursor: pointer; font-weight: 600;
    }
    .spin { width: 22px; height: 22px; border-radius: 50%; border: 2.5px solid rgba(255,255,255,.15); border-top-color: #ff3d6e; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .more { display: flex; justify-content: center; padding: 10px; }
    .compose { display: flex; gap: 8px; align-items: center; padding: 10px 12px 12px; border-top: 1px solid rgba(255,255,255,.07); flex: none; }
    .compose input {
      flex: 1; min-width: 0; padding: 10px 14px; border-radius: 999px; outline: none;
      border: 1px solid rgba(255,255,255,.1); background: rgba(255,255,255,.06); color: #fff; font: inherit;
    }
    .compose input:focus { border-color: rgba(255,255,255,.28); background: rgba(255,255,255,.09); }
    .compose input::placeholder { color: #7d7d8e; }
    .send {
      width: 38px; height: 38px; border-radius: 50%; border: 0; cursor: pointer; flex: none;
      background: linear-gradient(135deg, #ff3d6e, #7c4dff); color: #fff; display: grid; place-items: center;
      transition: opacity .2s, transform .1s;
    }
    .send:disabled { opacity: .3; cursor: default; }
    .send:not(:disabled):active { transform: scale(.92); }
    .send svg { width: 17px; height: 17px; }

    .pager {
      position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%);
      display: none; align-items: center; gap: 2px; padding: 3px; border-radius: 999px; pointer-events: auto;
      background: rgba(10,10,15,.55); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,.14);
      color: #fff; font: 600 12px system-ui, 'Segoe UI', sans-serif; transition: opacity .25s;
    }
    .pager.on { display: flex; }
    .pager.away { opacity: 0; pointer-events: none; }
    .pager button {
      width: 28px; height: 28px; border-radius: 50%; border: 0; cursor: pointer; padding: 0;
      background: none; color: #fff; display: grid; place-items: center; font: 600 17px/1 system-ui, sans-serif;
    }
    .pager button:hover { background: rgba(255,255,255,.14); }
    .pager span { min-width: 38px; text-align: center; font-variant-numeric: tabular-nums; }

    .heart {
      position: absolute; width: 104px; height: 104px; margin: -52px 0 0 -52px; pointer-events: none;
      color: #fe2c55; filter: drop-shadow(0 6px 16px rgba(254, 44, 85, .45));
      animation: heart .95s cubic-bezier(.2,.8,.2,1) forwards;
    }
    .heart svg { width: 100%; height: 100%; }
    .heart path { fill: currentColor; }
    @keyframes heart {
      0%   { transform: rotate(var(--r)) scale(0);    opacity: 0; }
      14%  { transform: rotate(var(--r)) scale(1.25); opacity: 1; }
      26%  { transform: rotate(var(--r)) scale(.92); }
      38%  { transform: rotate(var(--r)) scale(1);    opacity: 1; }
      100% { transform: translateY(-130px) rotate(var(--r)) scale(1.6); opacity: 0; }
    }

    .toast {
      position: absolute; left: 50%; top: 14px; transform: translate(-50%, -8px); opacity: 0;
      padding: 8px 14px; border-radius: 999px; background: rgba(16,16,24,.92); color: #fff;
      border: 1px solid rgba(255,255,255,.14); font: 600 12.5px system-ui, 'Segoe UI', sans-serif;
      transition: opacity .2s, transform .3s cubic-bezier(.2,.8,.2,1); pointer-events: none; white-space: nowrap;
    }
    .toast.show { opacity: 1; transform: translate(-50%, 0); }
  ` }));

  let toastTimer = null;
  const toastEl = h('div', { class: 'toast' });
  const toast = (msg, ms = 1800) => {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  };

  // ---------- action column ----------

  const col = h('div', { class: 'col' });
  const makeAct = (title, svg) => {
    const circ = h('span', { class: 'circ' }, svg || '');
    const label = h('span', { class: 'count' });
    const b = h('button', { class: 'act', title }, circ, label);
    col.appendChild(b);
    return { b, circ, label };
  };
  const acts = {
    like: makeAct('Like', ICONS.like()),
    comment: makeAct('Comments', ICONS.comment()),
    share: makeAct('Share', ICONS.share()),
    sound: makeAct('Sound'),
  };

  // The site's own mute button is underneath the canvas, so we keep our own.
  let soundOn = true;
  try { soundOn = localStorage.getItem('__dsSound') !== '0'; } catch {}
  const paintSound = () => {
    acts.sound.circ.replaceChildren(soundOn ? ICONS.soundOn() : ICONS.soundOff());
    acts.sound.b.title = soundOn ? 'Mute' : 'Unmute';
  };
  paintSound();
  acts.sound.b.addEventListener('click', () => {
    soundOn = !soundOn;
    try { localStorage.setItem('__dsSound', soundOn ? '1' : '0'); } catch {}
    paintSound();
  });

  // ---------- comments sheet ----------

  const listEl = h('div', { class: 'list' });
  const countEl = h('span', { class: 'n' });
  const input = h('input', { type: 'text', placeholder: 'Add a comment…', maxlength: '2200' });
  const sendBtn = h('button', { class: 'send', title: 'Post' }, ICONS.send());
  sendBtn.disabled = true;
  const sheet = h('div', { class: 'sheet' },
    h('div', { class: 'grab' }),
    h('div', { class: 'head' }, h('b', { text: 'Comments' }), countEl,
      h('button', { class: 'x', title: 'Close', onclick: () => closeComments() }, ICONS.close())),
    listEl,
    h('div', { class: 'compose' }, input, sendBtn),
  );

  // Slideshows: which picture is up, and buttons to flip through them.
  const pagerText = h('span');
  const pager = h('div', { class: 'pager' },
    h('button', { title: 'Previous picture', text: '‹', onclick: () => video && video.isPhoto && video.slide(-1) }),
    pagerText,
    h('button', { title: 'Next picture', text: '›', onclick: () => video && video.isPhoto && video.slide(1) }));

  root.append(col, sheet, pager, toastEl);

  // ---------- TikTok slideshows ----------
  // Photo posts are a Swiper carousel of images that advances by itself, with the
  // music in a separate <audio>; there's no <video>. Each one is wrapped in an
  // object with the bits of the <video> interface the rest of this file uses
  // (play / pause / muted / paused / size / currentSrc ...), plus `frame`, the
  // image to draw, and `slide()` to flip through the pictures.

  const PHOTO = '[class*="PhotoPlayerContainer"]';
  const photos = new WeakMap();
  const asPhoto = (el) => {
    let m = photos.get(el);
    if (m) return m;
    const sw = () => el.querySelector('.swiper');
    const swiper = () => { const s = sw(); return s && s.swiper; };
    const autoplay = () => { const s = swiper(); return s && s.autoplay; };
    const img = () => { const s = sw(); return s && (s.querySelector('.swiper-slide-active img') || s.querySelector('img')); };
    const audio = () => {
      for (let x = el, i = 0; x && i < 6; x = x.parentElement, i++) { const a = x.querySelector('audio'); if (a) return a; }
      return null;
    };
    m = {
      isPhoto: true,
      get frame() { return img(); },
      get videoWidth() { const i = img(); return i && i.complete ? i.naturalWidth : 0; },
      get videoHeight() { const i = img(); return i && i.complete ? i.naturalHeight : 0; },
      get readyState() { return this.videoWidth ? 4 : 0; },
      get paused() { const a = autoplay(); return a ? !a.running : !!(audio() && audio().paused); },
      ended: false,
      get muted() { const a = audio(); return a ? a.muted : !soundOn; },
      set muted(on) { const a = audio(); if (a) a.muted = on; },
      // Stands in for the video's source and time: the post, and which picture is up.
      get currentSrc() { const s = sw(); const i = s && s.querySelector('.swiper-slide:not(.swiper-slide-duplicate) img'); return 'photo:' + (i ? i.src : ''); },
      get currentTime() { const s = swiper(); return s ? s.realIndex : 0; },
      get count() { const s = sw(); return s ? s.querySelectorAll('.swiper-slide:not(.swiper-slide-duplicate)').length : 1; },
      get isConnected() { return el.isConnected; },
      get parentElement() { return el.parentElement; },
      getBoundingClientRect: () => el.getBoundingClientRect(),
      closest: (sel) => el.closest(sel),
      play() {
        const a = autoplay(); if (a && !a.running) a.start();
        const au = audio(); return au ? au.play() : Promise.resolve();
      },
      pause() {
        const a = autoplay(); if (a && a.running) a.stop();
        const au = audio(); if (au) au.pause();
      },
      slide(dir) { const s = swiper(); if (s) (dir > 0 ? s.slideNext() : s.slidePrev()); },
    };
    photos.set(el, m);
    return m;
  };

  // ---------- picking and drawing the video ----------

  const pick = () => {
    let best = null, area = 0;
    for (const v of document.querySelectorAll('video')) {
      if (!v.videoWidth) continue;
      const a = visibleArea(v.getBoundingClientRect());
      if (a > area) { area = a; best = v; }
    }
    for (const el of document.querySelectorAll(PHOTO)) {
      const m = asPhoto(el);
      if (!m.videoWidth) continue;
      const a = visibleArea(el.getBoundingClientRect());
      if (a > area) { area = a; best = m; }
    }
    // Only take over when a video really is the main thing on screen
    // (not on login pages, profiles, or a tiny preview).
    return area > innerWidth * innerHeight * 0.12 ? best : null;
  };

  let video = null, identity = '', picked = 0, lostAt = 0, drawn = '', shown = false;
  let pending = null;   // { dir, at, from, fromId, fromSrc } after a navigation, until the next video appears
  let anim = null;      // { dir, start } while the slide transition runs
  let sheetP = 0;       // 0..1, how far the video has shrunk for the comments sheet
  const SLIDE_MS = 320;
  const SHEET_H = 0.66;

  const setShown = (v) => {
    if (v === shown) return;
    shown = v;
    canvas.style.display = v ? 'block' : 'none';
    col.style.display = v ? 'flex' : 'none';
    document.documentElement.classList.toggle('__ds-filling', v);
    console.debug('__ds:fill:' + (v ? 1 : 0));
  };

  const fit = () => {
    const dpr = devicePixelRatio || 1;
    const cw = Math.round(innerWidth * dpr), ch = Math.round(innerHeight * dpr);
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    return [cw, ch, dpr];
  };

  // Draw a video into the box (0, top, cw, bh): cover-fitted when the shapes are
  // close (vertical video, vertical overlay), contain-fitted when they aren't or
  // when the comments sheet has shrunk the box. Returns false if no frame yet.
  const drawVideo = (v, dy, cw, bh, alpha = 1) => {
    if (!v || v.readyState < 2 || !v.videoWidth) return false;
    const src = v.frame || v;
    const vw = v.videoWidth, vh = v.videoHeight;
    const ratio = (vw / vh) / (cw / bh);
    const cover = sheetP === 0 && Math.max(ratio, 1 / ratio) < 1.35;
    const scale = cover ? Math.max(cw / vw, bh / vh) : Math.min(cw / vw, bh / vh);
    const w = vw * scale, hh = vh * scale;
    ctx.globalAlpha = alpha;
    // A picture that doesn't fill the frame sits on a blurred, dimmed copy of itself.
    if (v.isPhoto && !cover) {
      const s = Math.max(cw / vw, bh / vh);
      ctx.filter = 'blur(28px) brightness(.55)';
      ctx.drawImage(src, (cw - vw * s) / 2, (bh - vh * s) / 2 + dy, vw * s, vh * s);
      ctx.filter = 'none';
    }
    ctx.drawImage(src, (cw - w) / 2, (bh - hh) / 2 + dy, w, hh);
    ctx.globalAlpha = 1;
    return true;
  };

  const drawPlayIcon = (cw, bh, dpr) => {
    const r = 34 * dpr, cx = cw / 2, cy = bh / 2;
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.moveTo(cx - r * .3, cy - r * .45); ctx.lineTo(cx - r * .3, cy + r * .45); ctx.lineTo(cx + r * .5, cy); ctx.fill();
  };

  // Called right before navigating: freeze what's on screen and start pushing it
  // away at once, so the scroll answers instantly; the next video slides in
  // behind it as soon as the site has it.
  let lastDir = 1;
  ds.slide = (dir) => {
    if (!shown) return;
    lastDir = dir;
    snap.width = canvas.width; snap.height = canvas.height;
    snapCtx.drawImage(canvas, 0, 0);
    const now = performance.now();
    pending = { dir, at: now, from: video, fromId: identity, fromSrc: video && video.currentSrc };
    anim = { dir, start: now };
    startEffect(dir, now);
  };

  // ---------- ad skipping ----------
  // Ads are skipped the moment they become the current video, in the direction
  // you were scrolling, so the next real video slides in instead. YouTube marks
  // them with its own ad elements; every site puts a "Sponsored" / "Ad" label on them.

  ds.skipAds = ds.skipAds !== false;
  const AD_ELEMENTS = 'ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer, reels-ad-metadata-view-model, ad-badge-view-model';
  const AD_LABEL = /^(sponsored|ad|promoted|patrocinado|publicidad|anuncio|gesponsert|sponsoris[ée]|sponsorizzato|реклама)$/i;

  // Returns why the video looks like an ad ('' if it doesn't), which goes into the
  // skip message so a wrong skip can be traced.
  const isAd = (v) => {
    if (!v || !v.isConnected) return '';
    if (v.closest('.ad-showing')) return 'ad-showing'; // YouTube player showing an ad
    const vr = v.getBoundingClientRect();
    const cx = vr.left + vr.width / 2, cy = vr.top + vr.height / 2;
    // An ad container counts only if it holds this video, not the one preloaded below.
    for (const el of document.querySelectorAll(AD_ELEMENTS)) {
      const r = el.getBoundingClientRect();
      if (r.left <= cx && cx <= r.right && r.top <= cy && cy <= r.bottom) return el.tagName.toLowerCase();
    }
    // A label on this video: over it, or just above it (a reel's header).
    for (const el of document.querySelectorAll('span, div, a, p, strong, b, badge-shape')) {
      if (el.children.length > 1 || !AD_LABEL.test((el.textContent || '').trim())) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (r.right > vr.left - 40 && r.left < vr.right + 40 && r.top >= vr.top - 150 && r.bottom <= vr.bottom + 20) return 'label "' + el.textContent.trim() + '"';
    }
    return '';
  };

  ds.isAd = isAd;
  let adStreak = 0, lastAdCheck = 0, gaveUp = '';
  // Moves on from an ad. While pending, the outgoing slide (or the spinner) stays up,
  // so the ad itself is never drawn.
  const skipAd = (v, id, dir, now, why) => {
    // A site that won't move past it (end of the feed) gets to show it after all.
    if (++adStreak > 5) { gaveUp = id; adStreak = 0; return false; }
    v.muted = true;
    v.pause();
    pending = { dir, at: now, from: v, fromId: id, fromSrc: v.currentSrc };
    toast('Skipped an ad', 1400);
    console.debug('__ds:ad:' + why);
    console.debug('__ds:skip:' + dir);
    return true;
  };

  // ---------- scroll effects ----------
  // The equipped scroll effect (won from a scroll case, set by the overlay as
  // ds.effect): how the next video arrives (a transition) and what flies across
  // the screen while it does (particles). Without one, it's the plain slide.
  // Everything is kept gentle (thinned-out, translucent particles, a faint flash,
  // small movements) since it plays on every scroll, over what you're watching.

  ds.effect = ds.effect || null;
  const fxCanvas = h('canvas');           // scratch copy for pixelate / glitch
  const fxCtx = fxCanvas.getContext('2d');
  let parts = [], partsAt = 0, flash = null, shards = null;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pickColor = (c) => c[Math.floor(Math.random() * c.length)];
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const effectsLive = () => parts.length > 0 || !!flash;

  const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const bounce = (x) => {
    const n = 7.5625, d = 2.75;
    if (x < 1 / d) return n * x * x;
    if (x < 2 / d) return n * (x -= 1.5 / d) * x + 0.75;
    if (x < 2.5 / d) return n * (x -= 2.25 / d) * x + 0.9375;
    return n * (x -= 2.625 / d) * x + 0.984375;
  };
  // Transforms about the middle of the screen.
  const scaleAt = (cw, ch, sx, sy = sx) => { ctx.translate(cw / 2, ch / 2); ctx.scale(sx, sy); ctx.translate(-cw / 2, -ch / 2); };
  const rotateAt = (cw, ch, a) => { ctx.translate(cw / 2, ch / 2); ctx.rotate(a); ctx.translate(-cw / 2, -ch / 2); };

  const edgeGlow = (f, dpr, draw) => {
    ctx.save();
    ctx.strokeStyle = f.glow || pickColor(f.c || ['#fff']);
    ctx.shadowColor = ctx.strokeStyle;
    ctx.globalAlpha = 0.7;
    ctx.shadowBlur = 10 * dpr;
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    draw();
    ctx.stroke();
    ctx.restore();
  };

  const pixelatePass = (cw, ch, block) => {
    const w = Math.max(1, Math.ceil(cw / block)), hh = Math.max(1, Math.ceil(ch / block));
    if (fxCanvas.width !== w || fxCanvas.height !== hh) { fxCanvas.width = w; fxCanvas.height = hh; }
    fxCtx.drawImage(canvas, 0, 0, cw, ch, 0, 0, w, hh);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(fxCanvas, 0, 0, w, hh, 0, 0, cw, ch);
    ctx.imageSmoothingEnabled = true;
  };

  // Each draws one moment (p: 0..1, e: eased) of the old frame (snap) leaving and
  // the next video arriving (incoming(alpha, transform)).
  const TRANSITIONS = {
    slide(p, e, dir, cw, ch, incoming) {
      const off = ch * e * dir;
      ctx.drawImage(snap, 0, -off);
      incoming(1, () => ctx.translate(0, ch * dir - off));
    },
    push(p, e, dir, cw, ch, incoming) {
      const off = cw * e * dir;
      ctx.drawImage(snap, -off, 0);
      incoming(1, () => ctx.translate(cw * dir - off, 0));
    },
    zoom(p, e, dir, cw, ch, incoming) {
      incoming(e, () => scaleAt(cw, ch, 0.94 + 0.06 * e));
      ctx.save();
      ctx.globalAlpha = 1 - e;
      scaleAt(cw, ch, 1 + 0.15 * e);
      ctx.drawImage(snap, 0, 0);
      ctx.restore();
    },
    fade(p, e, dir, cw, ch, incoming) {
      incoming(1);
      ctx.save();
      ctx.globalAlpha = 1 - e;
      ctx.filter = 'blur(' + (e * 6).toFixed(1) + 'px)';
      ctx.drawImage(snap, 0, 0);
      ctx.restore();
    },
    spin(p, e, dir, cw, ch, incoming) {
      incoming(e, () => { rotateAt(cw, ch, -(1 - e) * dir * 0.22); scaleAt(cw, ch, 0.8 + 0.2 * e); });
      ctx.save();
      ctx.globalAlpha = 1 - e;
      rotateAt(cw, ch, e * dir * 0.22);
      scaleAt(cw, ch, 1 - 0.25 * e);
      ctx.drawImage(snap, 0, 0);
      ctx.restore();
    },
    flip(p, e, dir, cw, ch, incoming) {
      // A card turning over: the old frame narrows to nothing, the new one widens back.
      if (p < 0.5) {
        ctx.save();
        scaleAt(cw, ch, Math.max(0.001, 1 - easeInOut(p * 2)), 1);
        ctx.drawImage(snap, 0, 0);
        ctx.restore();
      } else {
        incoming(1, () => scaleAt(cw, ch, Math.max(0.001, easeInOut(p * 2 - 1)), 1));
      }
    },
    drop(p, e, dir, cw, ch, incoming) {
      ctx.drawImage(snap, 0, 0);
      ctx.fillStyle = 'rgba(0,0,0,' + (0.35 * e).toFixed(3) + ')';
      ctx.fillRect(0, 0, cw, ch);
      incoming(1, () => ctx.translate(0, -dir * ch * (1 - bounce(p))));
    },
    wipe(p, e, dir, cw, ch, incoming, f, dpr) {
      ctx.drawImage(snap, 0, 0);
      const slope = 0.35 * cw, x = -slope + e * (cw + slope * 2);
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(x, 0); ctx.lineTo(x - slope, ch); ctx.lineTo(0, ch);
      ctx.closePath();
      ctx.clip();
      incoming(1);
      ctx.restore();
      if (p < 1) edgeGlow(f, dpr, () => { ctx.moveTo(x, 0); ctx.lineTo(x - slope, ch); });
    },
    iris(p, e, dir, cw, ch, incoming, f, dpr) {
      ctx.drawImage(snap, 0, 0);
      const r = e * Math.hypot(cw, ch) / 2 * 1.05;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cw / 2, ch / 2, r, 0, Math.PI * 2);
      ctx.clip();
      incoming(1);
      ctx.restore();
      if (p < 1) edgeGlow(f, dpr, () => ctx.arc(cw / 2, ch / 2, r, 0, Math.PI * 2));
    },
    blinds(p, e, dir, cw, ch, incoming) {
      ctx.drawImage(snap, 0, 0);
      const n = 9, sh = ch / n;
      ctx.save();
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const k = 1 - Math.pow(1 - clamp01(p * 1.6 - (dir > 0 ? i : n - 1 - i) * 0.07), 3);
        ctx.rect(0, i * sh, cw, sh * k + 1);
      }
      ctx.clip();
      incoming(1);
      ctx.restore();
    },
    pixelate(p, e, dir, cw, ch, incoming, f, dpr) {
      if (p < 0.5) ctx.drawImage(snap, 0, 0); else incoming(1);
      const k = p < 0.5 ? p * 2 : (1 - p) * 2;
      const block = 1 + Math.round(k * k * 16 * dpr);
      if (block > 1) pixelatePass(cw, ch, block);
    },
    glitch(p, e, dir, cw, ch, incoming, f, dpr) {
      if (p < 0.5) ctx.drawImage(snap, 0, 0); else incoming(1);
      const k = 1 - Math.abs(p - 0.5) * 2;   // strongest halfway through
      if (fxCanvas.width !== cw || fxCanvas.height !== ch) { fxCanvas.width = cw; fxCanvas.height = ch; }
      fxCtx.drawImage(canvas, 0, 0);
      for (let i = 0; i < 6; i++) {
        const y = rnd(0, ch), hh = rnd(4, 30) * dpr;
        ctx.drawImage(fxCanvas, 0, y, cw, hh, rnd(-1, 1) * 24 * dpr * k, y, cw, hh);
      }
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 2; i++) {
        ctx.globalAlpha = 0.12 * k;
        ctx.fillStyle = pickColor(f.c || ['#22d3ee']);
        ctx.fillRect(0, rnd(0, ch), cw, rnd(2, 12) * dpr);
      }
      ctx.restore();
    },
    shatter(p, e, dir, cw, ch, incoming, f, dpr) {
      incoming(1);
      if (!shards) return;
      const t = p * (f.ms || 450) / 1000;
      ctx.save();
      ctx.globalAlpha = 1 - p * p;
      for (const s of shards) {
        const x = s.x + s.vx * t, y = s.y + s.vy * t + 1300 * dpr * t * t;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.translate(x + s.w / 2, y + s.h / 2);
        ctx.rotate(s.vr * t);
        ctx.drawImage(snap, s.x, s.y, s.w, s.h, -s.w / 2, -s.h / 2, s.w, s.h);
      }
      ctx.restore();
    },
  };

  // The old frame broken into pieces that fly out from the middle.
  const makeShards = (cw, ch, dpr) => {
    const cols = 5, rows = 8, w = cw / cols, hh = ch / rows, out = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * w, y = r * hh;
        const dx = (x + w / 2 - cw / 2) / cw, dy = (y + hh / 2 - ch / 2) / ch;
        out.push({ x, y, w: Math.ceil(w) + 1, h: Math.ceil(hh) + 1, vx: dx * rnd(700, 1500) * dpr, vy: dy * rnd(700, 1500) * dpr - rnd(150, 450) * dpr, vr: rnd(-5, 5) });
      }
    }
    return out;
  };

  // Particles start at the scroll and live a second or so. Speeds are in px/s.
  const spawnParticles = (f, cw, ch, dpr) => {
    const types = [].concat(f.p || []);
    if (!types.length) return;
    const per = Math.ceil(Math.min(70, (f.n || 16) * 0.55) / types.length);
    const cx = cw / 2, cy = ch / 2, big = Math.min(cw, ch);
    for (const type of types) {
      const count = type === 'ring' || type === 'bolt' ? Math.min(per, 4) : per;
      for (let i = 0; i < count; i++) {
        const a = rnd(0, Math.PI * 2), sp = rnd(250, 900) * dpr;
        const q = { type, c: pickColor(f.c || ['#ffffff']), t: 0, delay: 0, rot: rnd(0, 6.28), vr: rnd(-6, 6), g: 0, vx: 0, vy: 0, x: cx, y: cy, life: 1, r: 6 * dpr };
        switch (type) {
          case 'bubble': Object.assign(q, { x: rnd(0, cw), y: ch + rnd(0, ch * 0.15), vx: rnd(-30, 30) * dpr, vy: -rnd(260, 560) * dpr, life: rnd(0.8, 1.3), r: rnd(6, 16) * dpr }); break;
          case 'snow': Object.assign(q, { x: rnd(0, cw), y: -rnd(0, ch * 0.3), vx: rnd(-40, 40) * dpr, vy: rnd(180, 420) * dpr, life: rnd(1, 1.5), r: rnd(2, 5) * dpr }); break;
          case 'petal': Object.assign(q, { x: rnd(-cw * 0.1, cw), y: -rnd(0, ch * 0.3), vx: rnd(40, 160) * dpr, vy: rnd(200, 420) * dpr, life: rnd(1.1, 1.6), r: rnd(5, 9) * dpr }); break;
          case 'pixel': Object.assign(q, { vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rnd(0.5, 0.8), r: rnd(4, 9) * dpr }); break;
          case 'ember': Object.assign(q, { x: rnd(0, cw), y: ch + rnd(0, 20) * dpr, vx: rnd(-80, 80) * dpr, vy: -rnd(320, 760) * dpr, life: rnd(0.8, 1.3), r: rnd(2, 5) * dpr }); break;
          case 'spark': Object.assign(q, { vx: Math.cos(a) * sp * 1.4, vy: Math.sin(a) * sp * 1.4, life: rnd(0.4, 0.75), r: rnd(10, 22) * dpr }); break;
          case 'confetti': { const left = i % 2 === 0; Object.assign(q, { x: left ? 0 : cw, y: ch, vx: (left ? 1 : -1) * rnd(200, 700) * dpr, vy: -rnd(800, 1400) * dpr, g: 1800 * dpr, life: rnd(1.1, 1.5), r: rnd(4, 8) * dpr }); break; }
          case 'rain': Object.assign(q, { x: rnd(0, cw * 1.1), y: -rnd(0, ch * 0.5), vx: -120 * dpr, vy: rnd(1500, 2100) * dpr, life: rnd(0.5, 0.8), r: rnd(14, 28) * dpr }); break;
          case 'glow': Object.assign(q, { x: rnd(0, cw), y: rnd(0, ch), vx: rnd(-25, 25) * dpr, vy: rnd(-40, 10) * dpr, life: rnd(0.8, 1.4), r: rnd(3, 7) * dpr }); break;
          case 'galaxy': Object.assign(q, { a, d: rnd(0.08, 0.55) * big, spin: rnd(2.5, 5.5) * (i % 2 ? 1 : 1), life: rnd(0.8, 1.2), r: rnd(1.5, 3.5) * dpr }); break;
          case 'star': Object.assign(q, { vx: Math.cos(a) * sp * 0.8, vy: Math.sin(a) * sp * 0.8, g: 400 * dpr, life: rnd(0.7, 1.1), r: rnd(6, 12) * dpr }); break;
          case 'note': Object.assign(q, { x: rnd(0, cw), y: ch, vy: -rnd(220, 440) * dpr, life: rnd(1, 1.4), r: rnd(16, 26) * dpr, sway: rnd(0, 6.28) }); break;
          case 'bolt': {
            const pts = [], x0 = rnd(0.15, 0.85) * cw, x1 = rnd(0.15, 0.85) * cw, y1 = rnd(0.55, 1) * ch;
            for (let k = 0; k <= 10; k++) pts.push([x0 + (x1 - x0) * k / 10 + (k && k < 10 ? rnd(-40, 40) * dpr : 0), y1 * k / 10]);
            Object.assign(q, { pts, life: 0.35, delay: i * 0.09, r: rnd(2, 4) * dpr });
            break;
          }
          case 'ring': Object.assign(q, { life: 0.75, delay: i * 0.12, r: Math.hypot(cw, ch) / 2 }); break;
          case 'warp': Object.assign(q, { a, d: rnd(0, 40) * dpr, v: rnd(500, 1500) * dpr, life: rnd(0.5, 0.8), r: rnd(1, 2.5) * dpr }); break;
          case 'heart': Object.assign(q, { vx: Math.cos(a) * sp * 0.5, vy: -rnd(300, 700) * dpr, life: rnd(0.9, 1.3), r: rnd(12, 24) * dpr }); break;
          case 'coin': Object.assign(q, { x: cx + rnd(-0.25, 0.25) * cw, y: ch, vx: rnd(-320, 320) * dpr, vy: -rnd(1000, 1600) * dpr, g: 2200 * dpr, life: rnd(1.1, 1.5), r: rnd(8, 14) * dpr }); break;
        }
        parts.push(q);
      }
    }
  };

  const shapes = {
    star(r) { ctx.beginPath(); for (let i = 0; i < 10; i++) { const a = i * Math.PI / 5 - Math.PI / 2, rr = i % 2 ? r * 0.45 : r; ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); } ctx.closePath(); ctx.fill(); },
    heart(r) { ctx.beginPath(); ctx.moveTo(0, r * 0.35); ctx.bezierCurveTo(-r * 1.2, -r * 0.45, -r * 0.45, -r * 1.25, 0, -r * 0.45); ctx.bezierCurveTo(r * 0.45, -r * 1.25, r * 1.2, -r * 0.45, 0, r * 0.35); ctx.fill(); },
  };

  const drawEffects = (now, cw, ch) => {
    const dt = Math.min(0.05, Math.max(0, (now - partsAt) / 1000));
    partsAt = now;
    if (flash) {
      const k = (now - flash.start) / 220;
      if (k >= 1) flash = null;
      else { ctx.save(); ctx.globalAlpha = 0.16 * (1 - k); ctx.fillStyle = flash.c; ctx.fillRect(0, 0, cw, ch); ctx.restore(); }
    }
    if (!parts.length) return;
    const cx = cw / 2, cy = ch / 2;
    ctx.save();
    parts = parts.filter((q) => {
      q.t += dt;
      const t = q.t - q.delay;
      if (t < 0) return true;
      if (t > q.life) return false;
      const k = t / q.life;
      q.vy += q.g * dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.rot += q.vr * dt;
      ctx.globalAlpha = 0.7 * Math.min(1, (1 - k) * 1.6) * Math.min(1, t * 12);
      ctx.fillStyle = ctx.strokeStyle = q.c;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      switch (q.type) {
        case 'bubble': ctx.lineWidth = q.r * 0.18; ctx.beginPath(); ctx.arc(q.x, q.y, q.r, 0, 6.29); ctx.stroke(); break;
        case 'snow': case 'glow': case 'ember':
          if (q.type !== 'snow') { ctx.shadowColor = q.c; ctx.shadowBlur = q.r * 2.5; }
          if (q.type === 'glow') ctx.globalAlpha *= 0.5 + 0.5 * Math.sin(t * 9 + q.rot);
          ctx.beginPath(); ctx.arc(q.x, q.y, q.r, 0, 6.29); ctx.fill(); ctx.shadowBlur = 0;
          break;
        case 'petal': ctx.translate(q.x + Math.sin(t * 4 + q.rot) * 20, q.y); ctx.rotate(q.rot); ctx.beginPath(); ctx.ellipse(0, 0, q.r, q.r * 0.55, 0, 0, 6.29); ctx.fill(); break;
        case 'pixel': ctx.fillRect(q.x - q.r / 2, q.y - q.r / 2, q.r, q.r); break;
        case 'spark': case 'rain': {
          const len = q.r, sp = Math.hypot(q.vx, q.vy) || 1;
          ctx.lineWidth = q.type === 'rain' ? q.r * 0.08 : q.r * 0.14; ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(q.x - q.vx / sp * len, q.y - q.vy / sp * len); ctx.stroke();
          break;
        }
        case 'confetti': ctx.translate(q.x, q.y); ctx.rotate(q.rot); ctx.scale(1, Math.cos(t * 10 + q.rot)); ctx.fillRect(-q.r, -q.r * 0.5, q.r * 2, q.r); break;
        case 'galaxy': {
          const d = q.d * (1 - k * 0.85), ang = q.a + q.spin * t;
          ctx.shadowColor = q.c; ctx.shadowBlur = q.r * 2.5;
          ctx.beginPath(); ctx.arc(cx + Math.cos(ang) * d, cy + Math.sin(ang) * d, q.r, 0, 6.29); ctx.fill(); ctx.shadowBlur = 0;
          break;
        }
        case 'star': ctx.translate(q.x, q.y); ctx.rotate(q.rot); shapes.star(q.r); break;
        case 'heart': ctx.translate(q.x, q.y); ctx.rotate(Math.sin(t * 6 + q.rot) * 0.3); shapes.heart(q.r); break;
        case 'note': ctx.font = '700 ' + Math.round(q.r) + 'px system-ui, sans-serif'; ctx.fillText(q.rot > 3 ? '♪' : '♫', q.x + Math.sin(t * 5 + q.sway) * 18, q.y); break;
        case 'bolt':
          // A single soft streak that fades, not a strobe.
          ctx.globalAlpha = 0.55 * (1 - k);
          ctx.shadowColor = q.c; ctx.shadowBlur = 8; ctx.lineWidth = q.r * 0.7; ctx.lineJoin = 'round';
          ctx.beginPath(); q.pts.forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); ctx.shadowBlur = 0;
          break;
        case 'ring': ctx.globalAlpha *= 0.6; ctx.lineWidth = 3 * (1 - k) + 1; ctx.shadowColor = q.c; ctx.shadowBlur = 8; ctx.beginPath(); ctx.arc(cx, cy, q.r * k, 0, 6.29); ctx.stroke(); ctx.shadowBlur = 0; break;
        case 'warp': {
          const d0 = q.d + q.v * t * (0.5 + t * 2), d1 = d0 + q.v * 0.08 * (1 + t * 4);
          ctx.lineWidth = q.r * 0.7; ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(cx + Math.cos(q.a) * d0, cy + Math.sin(q.a) * d0); ctx.lineTo(cx + Math.cos(q.a) * d1, cy + Math.sin(q.a) * d1); ctx.stroke();
          break;
        }
        case 'coin': {
          ctx.translate(q.x, q.y); ctx.scale(Math.max(0.15, Math.abs(Math.cos(t * 9 + q.rot))), 1);
          ctx.beginPath(); ctx.arc(0, 0, q.r, 0, 6.29); ctx.fill();
          ctx.globalAlpha *= 0.6; ctx.fillStyle = '#fff7cc'; ctx.beginPath(); ctx.arc(-q.r * 0.25, -q.r * 0.25, q.r * 0.35, 0, 6.29); ctx.fill();
          break;
        }
      }
      return true;
    });
    ctx.restore();
  };

  const startEffect = (dir, now) => {
    const f = ds.effect;
    shards = null;
    if (!f) return;
    const dpr = devicePixelRatio || 1;
    spawnParticles(f, canvas.width, canvas.height, dpr);
    partsAt = now;
    if (f.flash) flash = { c: f.flash, start: now };
    if (f.t === 'shatter') shards = makeShards(canvas.width, canvas.height, dpr);
  };

  const drawSpinner = (now, cw, ch, dpr) => {
    const r = 14 * dpr, a = (now / 130) % (Math.PI * 2);
    ctx.lineWidth = 3 * dpr;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,.15)';
    ctx.beginPath(); ctx.arc(cw / 2, ch / 2, r, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = '#fff';
    ctx.beginPath(); ctx.arc(cw / 2, ch / 2, r, a, a + 1.6); ctx.stroke();
  };

  // ---------- playback that stays in sync with the site ----------
  // Logged-in Instagram (and others) keep their own "playing" state and re-pause
  // a video that was played behind their back. So play/pause goes through the
  // site's own click target first, and falls back to the element.

  const siteTarget = (v) => {
    const [x, y] = centerOf(v);
    const el = document.elementsFromPoint(x, y).find((e) => e !== canvas && e !== host);
    return el ? [el, x, y] : null;
  };
  const siteClick = (v) => {
    const t = siteTarget(v);
    if (!t) return;
    const [el, x, y] = t;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  };
  const settle = async (v, wantPaused) => {
    await sleep(350);
    return v.paused === wantPaused;
  };
  ds.forcePlay = async (v) => {
    if (!v || !v.paused) return;
    v.play().catch(() => {});
    if (await settle(v, false)) return;
    siteClick(v);
    if (await settle(v, false)) return;
    v.play().catch(() => {});
  };
  const forcePause = async (v) => {
    if (!v || v.paused) return;
    v.pause();
    if (await settle(v, true)) return;
    siteClick(v);
    if (await settle(v, true)) return;
    v.pause();
  };
  ds.userPaused = false;
  ds.toggle = () => {
    const v = video || pick();
    if (!v || window.__dsHold) return null;
    if (v.paused) { ds.userPaused = false; ds.forcePlay(v); return 'play'; }
    ds.userPaused = true;
    forcePause(v);
    return 'pause';
  };
  // ---------- double-click to like ----------
  // A double-click likes the video (never un-likes it) and pops a heart where you
  // clicked, like TikTok. So a single click waits a moment before pausing, to be
  // sure it isn't the first half of a double-click.

  const heartAt = (x, y) => {
    const el = h('div', { class: 'heart' }, icon({ d: HEART }));
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.setProperty('--r', (Math.random() * 40 - 20).toFixed(1) + 'deg');
    el.addEventListener('animationend', () => el.remove());
    root.appendChild(el);
  };

  let clickTimer = null;
  canvas.addEventListener('click', (e) => {
    if (e.detail > 1) {
      clearTimeout(clickTimer);
      clickTimer = null;
      heartAt(e.clientX, e.clientY);
      likeOnce();
      return;
    }
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => { clickTimer = null; ds.toggle(); }, 230);
  });

  // ---------- like / comment / share: finding the site's real buttons ----------

  // YouTube Shorts (current and older layouts), Instagram, TikTok.
  const SEL = {
    like: 'like-button-view-model button, #like-button button, svg[aria-label="Like"], svg[aria-label="Unlike"], [data-e2e="like-icon"], [data-e2e="browse-like-icon"]',
    comment: 'reel-action-bar-view-model button[aria-label*="comment" i], #comments-button button, svg[aria-label="Comment"], [data-e2e="comment-icon"], [data-e2e="browse-comment-icon"]',
    share: 'reel-action-bar-view-model button[aria-label="Share"], #share-button button, svg[aria-label="Share"], svg[aria-label="Share Post"], svg[aria-label="Direct"], [data-e2e="share-icon"], [data-e2e="browse-share-icon"]',
  };

  // Walk up from the video to the first ancestor that holds such a button; if
  // it holds several (other reels), take the one nearest the video.
  const findAction = (kind) => {
    if (!video) return null;
    const [vx, vy] = centerOf(video);
    for (let el = video.parentElement; el && el !== document.documentElement; el = el.parentElement) {
      let best = null, dist = Infinity;
      for (const f of el.querySelectorAll(SEL[kind])) {
        const [x, y, area] = centerOf(f);
        if (!area) continue;
        const d = Math.hypot(x - vx, y - vy);
        if (d < dist) { dist = d; best = f; }
      }
      if (best) return best.closest('button, [role="button"], a') || best;
    }
    return null;
  };

  const likedState = (btn) => {
    const pressed = btn.getAttribute('aria-pressed');
    if (pressed === 'true' || pressed === 'false') return pressed === 'true';
    if (btn.querySelector('svg[aria-label="Unlike"]')) return true;
    if (btn.querySelector('svg[aria-label="Like"]')) return false;
    return null;
  };

  // The number printed under a button. Sites print each count *below* its icon,
  // so a number belongs to the nearest button above it.
  const COUNT = /^\d[\d.,]*\s*[KMB]?$/i;
  const countFor = (btn, all) => {
    const root = (btn.parentElement && btn.parentElement.parentElement) || btn;
    const centers = all.map((b) => [b, ...centerOf(b)]);
    let best = '', dist = 80;
    for (const el of root.querySelectorAll('span, strong, div')) {
      if (el.children.length) continue;
      const t = textOf(el);
      if (!COUNT.test(t)) continue;
      const [x, y, area] = centerOf(el);
      if (!area) continue;
      const above = centers.filter(([, bx, by]) => by < y && Math.abs(bx - x) < 60).sort((a, b) => b[2] - a[2])[0];
      const owner = above ? above[0] : centers.sort((a, b) => Math.hypot(a[1] - x, a[2] - y) - Math.hypot(b[1] - x, b[2] - y))[0][0];
      if (owner !== btn) continue;
      const [bx, by] = centerOf(btn);
      const d = Math.hypot(x - bx, y - by);
      if (d < dist) { dist = d; best = t; }
    }
    return best;
  };

  const liked = {}; // video identity -> our guess, for sites that don't expose the state
  let refreshed = 0;
  const refreshActions = () => {
    const found = { like: findAction('like'), comment: findAction('comment'), share: findAction('share') };
    // YouTube only builds its action bar once the player is hovered, and the
    // canvas keeps the real mouse off it, so hover it for them.
    if (!found.like && video) {
      const [x, y] = centerOf(video);
      for (const type of ['mouseover', 'mouseenter', 'mousemove']) {
        video.dispatchEvent(new MouseEvent(type, { bubbles: type !== 'mouseenter', clientX: x, clientY: y }));
      }
    }
    const all = Object.values(found).filter(Boolean);
    for (const kind of ['like', 'comment', 'share']) {
      const btn = found[kind];
      const a = acts[kind];
      a.b.style.display = btn ? '' : 'none';
      if (!btn) continue;
      a.label.textContent = countFor(btn, all);
      if (kind === 'like') {
        const st = likedState(btn);
        a.b.classList.toggle('on', st === null ? !!liked[identity] : st);
      }
    }
  };

  // A real login prompt (not a toast, not our own UI): dialogs and Google sign-in links.
  const promptCount = () => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], a[href*="ServiceLogin"], a[href*="accounts.google.com"]')]
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 40 && r.height > 20; }).length;

  const like = () => {
    const btn = findAction('like');
    if (!btn) return;
    const before = promptCount();
    const st = likedState(btn);
    btn.click();
    liked[identity] = !(st === null ? !!liked[identity] : st);
    const b = acts.like.b;
    b.classList.toggle('on', liked[identity]);
    b.classList.remove('pop');
    void b.offsetWidth;
    b.classList.add('pop');
    setTimeout(refreshActions, 600);
    // Not logged in? The site answers with a login prompt. Close it and say so,
    // rather than leaving fill mode to show the site.
    setTimeout(() => {
      if (promptCount() <= before) return;
      dismissPrompt();
      liked[identity] = false;
      b.classList.remove('on');
      toast('Log in to like here: Accounts, top right', 2600);
    }, 900);
  };

  const dismissPrompt = () => {
    for (const d of document.querySelectorAll('[role="dialog"], [role="alertdialog"]')) {
      const x = d.querySelector('[aria-label="Close" i], [aria-label*="close" i], [aria-label*="dismiss" i]');
      if (x) (x.closest('button, [role="button"]') || x).click();
    }
    const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document;
    for (const type of ['keydown', 'keyup']) target.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  };

  const likeOnce = () => {
    const btn = findAction('like');
    const st = btn ? likedState(btn) : null;
    if (!(st === null ? liked[identity] : st)) like();
  };

  // Share copies the video's link (the overlay puts it on the clipboard), so you
  // never leave the video for the site's share sheet.
  const share = () => {
    let url = location.href;
    for (let el = video && video.parentElement, i = 0; el && i < 8; el = el.parentElement, i++) {
      const a = el.querySelector('a[href*="/video/"], a[href*="/photo/"], a[href*="/reel/"], a[href*="/shorts/"]');
      if (a) { url = a.href; break; }
    }
    console.debug('__ds:copy:' + url);
    toast('Link copied');
  };

  acts.like.b.addEventListener('click', like);
  acts.share.b.addEventListener('click', share);
  acts.comment.b.addEventListener('click', () => (commentsOpen ? closeComments() : openComments()));

  // ---------- comments: read the site's comment list, show it in our sheet ----------

  // Each returns [{ el, author, text, time, likes, avatar }] from the site's open comments.
  const scrapers = {
    yt() {
      const panel = [...document.querySelectorAll('ytd-engagement-panel-section-list-renderer')]
        .find((p) => /comment/i.test(p.getAttribute('target-id') || '') && p.getAttribute('visibility') !== 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
      if (!panel) return [];
      return [...panel.querySelectorAll('ytd-comment-thread-renderer')].map((t) => {
        const c = t.querySelector('#comment, ytd-comment-view-model, ytd-comment-renderer') || t;
        return {
          el: t,
          author: textOf(c.querySelector('#author-text')),
          text: textOf(c.querySelector('#content-text')),
          time: textOf(c.querySelector('#published-time-text, .published-time-text')),
          likes: textOf(c.querySelector('#vote-count-middle')),
          avatar: imgOf(c.querySelector('#author-thumbnail')),
        };
      });
    },
    tt() {
      return [...document.querySelectorAll('[data-e2e="comment-level-1"]')].map((t) => {
        let item = t;
        while (item.parentElement && !item.querySelector('[data-e2e="comment-username-1"]')) item = item.parentElement;
        return {
          el: item,
          author: textOf(item.querySelector('[data-e2e="comment-username-1"]')),
          text: textOf(t),
          time: textOf(item.querySelector('[data-e2e="comment-time-1"]')),
          likes: textOf(item.querySelector('[data-e2e="comment-like-count"]')),
          avatar: imgOf(item.querySelector('[data-e2e="comment-avatar-1"]') || item),
        };
      });
    },
    // Instagram's markup is obfuscated, so go by shape: every comment has a
    // <time>, a link to the author's profile, an avatar and a text span. Only
    // <time>s that appeared after we opened the comments count.
    ig() {
      const out = [];
      for (const tm of document.querySelectorAll('time')) {
        if (seenTimes.has(tm)) continue;
        let item = tm;
        for (let i = 0; i < 8 && item.parentElement; i++) {
          item = item.parentElement;
          if (item.querySelector('img') && item.querySelector('a[href^="/"]') && textOf(item).length > textOf(tm).length + 6) break;
        }
        if (item.querySelector('video')) continue;
        const authorLink = [...item.querySelectorAll('a[href^="/"]')]
          .find((a) => textOf(a) && !a.querySelector('time') && !/\/(p|reel|reels|explore|stories)\//.test(a.getAttribute('href')));
        const author = textOf(authorLink);
        const time = textOf(tm);
        const parts = [...item.querySelectorAll('span')].map(textOf)
          .filter((t) => t && t !== author && t !== time && !/^(reply|replies|see translation|like|liked by.*|view (all )?\d+ repl.*|\d[\d,.]*[km]? likes?|·|verified)$/i.test(t));
        const text = parts.sort((a, b) => b.length - a.length)[0] || '';
        const likes = (textOf(item).match(/(\d[\d,.]*[KM]?) likes?/i) || [])[1] || '';
        if (author && text) out.push({ el: item, author, text, time, likes, avatar: imgOf(item) });
      }
      return out;
    },
  };

  let commentsOpen = false, seenTimes = new Set(), shownKeys = [], openedAt = 0, pollTimer = null, siteOpened = false, promptsBefore = 0;
  const keyOf = (c) => c.author + '|' + c.text.slice(0, 80);
  const scrape = () => {
    const seen = new Set();
    return (scrapers[SITE] ? scrapers[SITE]() : []).filter((c) => {
      const k = keyOf(c);
      if (!c.text || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  const commentRow = (c) => {
    const av = h('div', { class: 'av' });
    if (/^https?:/.test(c.avatar)) {
      av.style.backgroundImage = `url("${c.avatar.replace(/"/g, '%22')}")`;
    } else {
      // Sites lazy-load avatars only once they scroll into view, which theirs
      // never do under the canvas: fall back to a colored initial.
      const name = c.author.replace(/^@/, '');
      let hue = 0;
      for (const ch of name) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
      av.style.background = `hsl(${hue} 55% 42%)`;
      av.textContent = (name[0] || '?').toUpperCase();
    }
    const meta = h('div', { class: 'meta' }, h('b', { text: c.author }));
    if (c.time) meta.append(h('span', { text: c.time }));
    const lk = h('div', { class: 'lk' }, icon({ ...line, d: HEART }), h('span', { text: c.likes || '' }));
    return h('div', { class: 'c' }, av, h('div', { class: 'body' }, meta, h('div', { class: 'txt', text: c.text })), lk);
  };

  const showState = (msg) => {
    const box = h('div', { class: 'state' });
    if (!msg) box.append(h('div', { class: 'spin' }), h('div', { text: 'Loading comments…' }));
    else box.append(h('div', { text: msg }));
    listEl.replaceChildren(box);
    shownKeys = [];
  };

  let lastItems = [];
  const renderComments = () => {
    if (!commentsOpen) return;
    const items = scrape();
    lastItems = items;
    countEl.textContent = acts.comment.label.textContent;
    if (!items.length) {
      const waited = performance.now() - openedAt;
      if (promptCount() > promptsBefore) { dismissPrompt(); showState('Log in to see comments here: Accounts, top right.'); }
      else if (waited > 7000) showState(siteOpened ? 'No comments to show here.' : 'Couldn’t open comments for this video.');
      else if (shownKeys.length || !listEl.querySelector('.spin')) showState('');
      return;
    }
    const keys = items.map(keyOf);
    const prefix = shownKeys.length && shownKeys.every((k, i) => keys[i] === k);
    if (prefix && keys.length === shownKeys.length) return;
    if (prefix) {
      for (const c of items.slice(shownKeys.length)) listEl.insertBefore(commentRow(c), listEl.querySelector('.more'));
    } else {
      const top = listEl.scrollTop;
      listEl.replaceChildren(...items.map(commentRow), h('div', { class: 'more' }));
      listEl.scrollTop = top;
    }
    shownKeys = keys;
  };

  // Near the bottom of our list: scroll the site's list so it loads more.
  listEl.addEventListener('scroll', () => {
    if (listEl.scrollTop + listEl.clientHeight < listEl.scrollHeight - 160) return;
    const last = lastItems[lastItems.length - 1];
    if (!last) return;
    const sc = scrollParent(last.el);
    if (sc) sc.scrollTop = sc.scrollHeight;
    const more = listEl.querySelector('.more');
    if (more && !more.firstChild) {
      more.append(h('div', { class: 'spin' }));
      setTimeout(() => more.replaceChildren(), 1500);
    }
  });

  const openComments = () => {
    if (!video || commentsOpen) return;
    commentsOpen = true;
    openedAt = performance.now();
    siteOpened = false;
    seenTimes = new Set(document.querySelectorAll('time'));
    promptsBefore = promptCount();
    showState('');
    sheet.classList.add('open');
    col.classList.add('away');
    // Don't toggle the site's panel shut if it's already open.
    if (!scrape().length) {
      const btn = findAction('comment');
      if (btn) { btn.click(); siteOpened = true; }
    } else {
      siteOpened = true;
    }
    clearInterval(pollTimer);
    pollTimer = setInterval(renderComments, 500);
    renderComments();
  };

  const closeComments = () => {
    if (!commentsOpen) return;
    commentsOpen = false;
    clearInterval(pollTimer);
    sheet.classList.remove('open');
    col.classList.remove('away');
    input.blur();
    // Close the site's own panel too, via its close button near the comments,
    // or with Escape (which also dismisses a login popup it may have shown).
    let closed = false;
    const anchor = lastItems[0] && lastItems[0].el;
    for (let el = anchor; el && el !== document.documentElement; el = el.parentElement) {
      const x = el.querySelector('[aria-label="Close" i], [aria-label*="close" i], svg[aria-label="Close"]');
      if (x) { (x.closest('button, [role="button"]') || x).click(); closed = true; break; }
    }
    if (!closed && siteOpened) {
      const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document;
      for (const type of ['keydown', 'keyup']) target.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    }
    lastItems = [];
  };
  ds.closeComments = closeComments;

  // ---------- posting a comment through the site's own box ----------

  // Types into a site's input like a person would, so its framework notices.
  const typeInto = (el, msg) => {
    el.focus();
    if ('value' in el && el.tagName === 'TEXTAREA') el.select();
    document.execCommand('insertText', false, msg);
  };
  const findPostButton = (near) => {
    for (let el = near; el && el !== document.documentElement; el = el.parentElement) {
      const b = [...el.querySelectorAll('button, [role="button"]')].find((x) =>
        /^(post|comment|reply|send)$/i.test(textOf(x)) || x.matches('#submit-button button, [data-e2e="comment-post"]'));
      if (b) return b;
    }
    return null;
  };
  const posters = {
    async yt(msg) {
      const ph = document.querySelector('#simplebox-placeholder');
      if (ph) { ph.click(); await sleep(450); }
      const box = document.querySelector('#contenteditable-root');
      if (!box) return false;
      typeInto(box, msg);
      await sleep(300);
      const btn = document.querySelector('#submit-button button, #submit-button');
      if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
      btn.click();
      return true;
    },
    async tt(msg) {
      const box = document.querySelector('[data-e2e="comment-input"] [contenteditable="true"], [data-e2e="comment-text"] [contenteditable="true"]')
        || [...document.querySelectorAll('[contenteditable="true"]')].pop();
      if (!box) return false;
      typeInto(box, msg);
      await sleep(300);
      const btn = document.querySelector('[data-e2e="comment-post"]') || findPostButton(box);
      if (!btn) return false;
      btn.click();
      return true;
    },
    async ig(msg) {
      const box = document.querySelector('textarea[aria-label*="comment" i], textarea[placeholder*="comment" i]');
      if (!box) return false;
      typeInto(box, msg);
      await sleep(300);
      const btn = findPostButton(box);
      if (!btn) return false;
      btn.click();
      return true;
    },
  };

  let posting = false;
  const post = async () => {
    const msg = input.value.trim();
    if (!msg || posting || !posters[SITE]) return;
    posting = true;
    sendBtn.disabled = true;
    let ok = false;
    try { ok = await posters[SITE](msg); } catch { ok = false; }
    posting = false;
    if (ok) {
      input.value = '';
      toast('Comment posted');
      setTimeout(renderComments, 1200);
    } else {
      toast('Couldn’t post here — try “Open on the site”', 2600);
    }
    sendBtn.disabled = !input.value.trim();
    input.focus();
  };
  input.addEventListener('input', () => { sendBtn.disabled = !input.value.trim() || posting; });
  // Keep the site's keyboard shortcuts (k, m, j, l…) from firing while typing.
  for (const type of ['keydown', 'keyup', 'keypress']) {
    input.addEventListener(type, (e) => {
      e.stopPropagation();
      if (type === 'keydown' && e.key === 'Enter') { e.preventDefault(); post(); }
      if (type === 'keydown' && e.key === 'Escape') closeComments();
    });
  }
  sendBtn.addEventListener('click', post);

  // ---------- frame loop ----------

  let pausedSince = 0, lastKick = 0;
  let photoShown = null, photoFade = null;   // slideshow picture on screen / crossfade in progress
  let lastTick = 0;

  // Counts the frames a video actually presents (~30 a second), so the canvas is
  // redrawn per new frame, not per screen refresh (300 a second on a 300 Hz monitor).
  const frameCount = (v) => {
    if (v.isPhoto) return v.currentTime;
    if (!v.requestVideoFrameCallback) return Math.floor(v.currentTime * 30);
    if (!v.__dsFrames) {
      v.__dsFrames = 1;
      const tick = () => { v.__dsFrames++; v.requestVideoFrameCallback(tick); };
      v.requestVideoFrameCallback(tick);
    }
    return v.__dsFrames;
  };

  const frame = (now) => {
    requestAnimationFrame(frame);
    // Checks run at most ~60 times a second; transitions get every frame so they stay smooth.
    if (!anim && !photoFade && !effectsLive() && now - lastTick < 15) return;
    lastTick = now;
    if (!canvas.isConnected) (document.body || document.documentElement).append(canvas, host);
    if (!ds.on) {
      if (commentsOpen) closeComments();
      host.style.display = 'none';
      setShown(false);
      video = null;
      return;
    }
    host.style.display = 'block';

    if (pending && now - pending.at > 2500) pending = null;
    if (pending || anim || now - picked > 200 || !video || !video.isConnected) {
      picked = now;
      const v = pick();
      if (v) {
        lostAt = 0;
        const id = v.currentSrc + '|' + location.href;
        if (video && (v !== video || id !== identity)) {
          ds.userPaused = false;
          if (commentsOpen) closeComments();
        }
        // YouTube plays every video in one recycled element and updates the URL a
        // moment before the video itself: with the same element, wait for new media.
        if (pending && (v !== pending.from || (id !== pending.fromId && v.currentSrc !== pending.fromSrc))) {
          if (pending.from && pending.from !== v) pending.from.pause();
          const why = ds.skipAds && id !== gaveUp ? isAd(v) : '';
          if (why && skipAd(v, id, pending.dir, now, why)) {
            // Still pending: keep sliding toward the next real video.
          } else {
            // Start the new video right away instead of waiting on the site's autoplay.
            pending = null;
            adStreak = 0;
            if (!window.__dsHold) ds.forcePlay(v);
          }
        }
        video = v; identity = id;
      } else if (!lostAt) {
        lostAt = now;
      }
    }
    // Keep the last frame up through short gaps (the next video loading)
    // instead of flashing the site's layout.
    if (!video || (lostAt && now - lostAt > 1500 && !pending)) { setShown(false); video = null; drawn = ''; return; }
    if (!shown && video.readyState < 2) return;
    setShown(true);

    // Slideshow pager, and no flipping through pictures while held in the background.
    const pages = video.isPhoto ? video.count : 0;
    pager.classList.toggle('on', pages > 1 && !pending);
    pager.classList.toggle('away', commentsOpen);
    if (pages > 1) {
      const t = (video.currentTime + 1) + ' / ' + pages;
      if (pagerText.textContent !== t) pagerText.textContent = t;
    }
    if (window.__dsHold && video.isPhoto && !video.paused) video.pause();

    // Not while moving on: that would unmute an ad being skipped.
    if (!pending && soundOn === video.muted) video.muted = !soundOn;
    // Paused while comments are open: their little like hearts would confuse the lookup.
    if (!commentsOpen && now - refreshed > 400) { refreshed = now; refreshActions(); }

    // Ads that slipped through: labels that load late, an ad the site advanced to
    // by itself, or one that was current when you switched to this feed.
    if (ds.skipAds && !pending && !anim && !window.__dsHold && identity !== gaveUp && now - lastAdCheck > 400) {
      lastAdCheck = now;
      const why = adStreak < 5 ? isAd(video) : '';
      if (why) {
        ds.slide(lastDir);
        skipAd(video, identity, lastDir, now, 'late, ' + why);
      }
    }

    // Watchdog: a video that's paused although nobody asked for it (the site
    // re-paused it, or autoplay was lost) gets nudged back into playing.
    const wantPlay = !window.__dsHold && !ds.userPaused && !anim && !pending;
    if (wantPlay && video.paused && !video.ended) {
      if (!pausedSince) pausedSince = now;
      else if (now - pausedSince > 1200 && now - lastKick > 3000) { lastKick = now; ds.forcePlay(video); }
    } else {
      pausedSince = 0;
    }

    // Ease the video into the space above the comments sheet and back.
    const targetP = commentsOpen ? 1 : 0;
    const easing = sheetP !== targetP;
    if (easing) sheetP = Math.abs(targetP - sheetP) < 0.02 ? targetP : sheetP + (targetP - sheetP) * 0.2;

    const [cw, ch, dpr] = fit();
    const bh = Math.round(ch * (1 - SHEET_H * sheetP));
    if (anim) {
      const f = ds.effect || {};
      const p = Math.min(1, (now - anim.start) / (f.ms || SLIDE_MS));
      const e = 1 - Math.pow(1 - p, 3);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cw, ch);
      // Until the site has the next video, the slot behind the outgoing one stays dark.
      const incoming = (alpha = 1, transform) => {
        if (pending) return;
        ctx.save();
        if (transform) transform();
        drawVideo(video, 0, cw, ch, alpha);
        ctx.restore();
      };
      (TRANSITIONS[f.t] || TRANSITIONS.slide)(p, e, anim.dir, cw, ch, incoming, f, dpr);
      drawEffects(now, cw, ch);
      if (p >= 1) { anim = null; shards = null; }
      drawn = '';
      return;
    }
    if (pending) {
      // Slid out but the next video isn't here yet: show that it's coming.
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cw, ch);
      if (now - pending.at > SLIDE_MS + 120) drawSpinner(now, cw, ch, dpr);
      drawEffects(now, cw, ch);
      drawn = '';
      return;
    }
    // A slideshow moving to its next picture crossfades into it.
    if (video.isPhoto) {
      const img = video.frame;
      if (photoShown && img !== photoShown.img && photoShown.id === identity && img && img.complete && photoShown.img.complete) {
        photoFade = { from: photoShown.img, start: now };
      }
      photoShown = img ? { img, id: identity } : null;
    }
    const fading = photoFade && now - photoFade.start < 260;
    const live = effectsLive();
    const key = [identity, frameCount(video), video.paused, cw, ch, sheetP].join('|');
    if (key === drawn && !easing && !fading && !live) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);
    if (fading) {
      const f = photoFade.from;
      drawVideo({ isPhoto: true, frame: f, videoWidth: f.naturalWidth, videoHeight: f.naturalHeight, readyState: 4 }, 0, cw, bh);
    } else {
      photoFade = null;
    }
    if (!drawVideo(video, 0, cw, bh, fading ? (now - photoFade.start) / 260 : 1)) { ctx.drawImage(snap, 0, 0); return; }
    drawn = fading || live ? '' : key;
    if (video.paused && !commentsOpen) drawPlayIcon(cw, bh, dpr);
    // Particles from the last scroll keep going over the new video for a moment.
    if (live) drawEffects(now, cw, ch);
  };
  requestAnimationFrame(frame);

  // ---------- wheel: one navigation per gesture ----------

  let locked = false, unlock = null;
  const onWheel = (e) => {
    e.preventDefault();
    clearTimeout(unlock);
    unlock = setTimeout(() => { locked = false; }, 280);
    if (locked) return;
    // Sideways on a slideshow flips through its pictures.
    if (video && video.isPhoto && Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) >= 4) {
      locked = true;
      video.slide(e.deltaX > 0 ? 1 : -1);
      return;
    }
    if (Math.abs(e.deltaY) < 4) return;
    locked = true;
    const dir = e.deltaY > 0 ? 1 : -1;
    ds.slide(dir);
    console.debug('__ds:nav:' + dir);
  };
  canvas.addEventListener('wheel', onWheel, { passive: false });
  col.addEventListener('wheel', onWheel, { passive: false });
  return 'installed';
})
