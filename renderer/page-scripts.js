// Snippets injected into the site webviews. Kept as strings because they run
// inside the guest page, not in the overlay's own document.

(function (root) {
  let fillSource = '() => "fill.js not loaded"';

  // The video taking up the most visible area is "the one you're watching".
  const FIND_VIDEO = `(() => {
    let best = null, bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      if (w * h > bestArea) { bestArea = w * h; best = v; }
    }
    return best;
  })()`;

  // Same, counting TikTok slideshows (a carousel of pictures, no <video>) as posts too.
  const MEDIA = `'video, [class*="PhotoPlayerContainer"]'`;
  const FIND_MEDIA = FIND_VIDEO.replace("querySelectorAll('video')", `querySelectorAll(${MEDIA})`);

  root.PAGE_SCRIPTS = {
    // Returns how it navigated, or null so the caller can fall back to a wheel event.
    navigate: (dir) => `(() => {
      const dir = ${dir > 0 ? 1 : -1};
      const btn = document.querySelector(dir > 0 ? '#navigation-button-down button' : '#navigation-button-up button');
      if (btn && btn.offsetParent) { btn.click(); return 'button'; }

      // Feeds that keep several <video>s stacked: scroll exactly to the neighbour.
      // Feeds that recycle one player (YouTube) return null and get a real wheel tick.
      const current = ${FIND_MEDIA};
      if (!current) return null;
      // The feed's scroller. TikTok locks it (overflow: hidden) behind its login
      // prompt, but a script can still scroll it, so a locked one does as a fallback.
      const scrollerOf = (from) => {
        let locked = null;
        for (let el = from; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
          if (el.scrollHeight <= el.clientHeight + 4) continue;
          const o = getComputedStyle(el).overflowY;
          if (/(auto|scroll)/.test(o)) return el;
          if (o === 'hidden' && !locked && el.scrollHeight > el.clientHeight * 1.5) locked = el;
        }
        return locked;
      };

      const { top, height } = current.getBoundingClientRect();
      const gap = height * 0.6;
      const others = [...document.querySelectorAll(${MEDIA})]
        .map((v) => v.getBoundingClientRect())
        .filter((r) => r.height > 50 && (dir > 0 ? r.top > top + gap : r.top < top - gap))
        .sort((a, b) => dir * (a.top - b.top));

      if (!others.length) {
        // Feeds that recycle one player (YouTube) still lay out one snap item per
        // video: find the item holding the player and scroll to its neighbour.
        for (let item = current; item && item !== document.body; item = item.parentElement) {
          if (getComputedStyle(item).scrollSnapAlign === 'none') continue;
          let sib = dir > 0 ? item.nextElementSibling : item.previousElementSibling;
          while (sib && getComputedStyle(sib).scrollSnapAlign === 'none') sib = dir > 0 ? sib.nextElementSibling : sib.previousElementSibling;
          if (!sib) return null;
          const el = scrollerOf(item.parentElement);
          if (!el) return null;
          el.scrollBy({ top: sib.getBoundingClientRect().top - item.getBoundingClientRect().top, behavior: 'instant' });
          return 'snap';
        }
        return null;
      }
      const delta = others[0].top - top;

      const el = scrollerOf(current.parentElement);
      if (el) {
        el.scrollBy({ top: delta, behavior: 'instant' });
        return 'container';
      }
      const page = document.scrollingElement;
      if (page && page.scrollHeight > page.clientHeight + 4) {
        page.scrollBy({ top: delta, behavior: 'instant' });
        return 'page';
      }
      return null;
    })()`,

    playPause: `(() => {
      const f = window.__dsFill;
      if (f && f.on && f.toggle) return f.toggle();
      const v = ${FIND_VIDEO};
      if (!v) return null;
      if (v.paused) { v.play().catch(() => {}); return 'play'; }
      v.pause();
      return 'pause';
    })()`,

    // Pause everything and keep it paused: sites like YouTube restart playback on
    // their own (autoplaying the next short), so block any 'play' until release.
    hold: `(() => {
      if (!window.__dsHoldInstalled) {
        window.__dsHoldInstalled = true;
        // Media events don't bubble, but a capturing listener on document still sees them.
        document.addEventListener('play', (e) => {
          if (!window.__dsHold || !(e.target instanceof HTMLMediaElement)) return;
          e.target.pause();
          // Remember blocked autoplays: a feed preloaded in the background never got
          // to start, so release has to start it.
          if (!window.__dsBlocked.includes(e.target)) window.__dsBlocked.push(e.target);
        }, true);
      }
      window.__dsHold = true;
      window.__dsBlocked = [];
      window.__dsResume = [];
      for (const v of document.querySelectorAll('video, audio')) {
        if (!v.paused) { v.pause(); window.__dsResume.push(v); }
      }
      return window.__dsResume.length;
    })()`,

    release: `(() => {
      window.__dsHold = false;
      let list = (window.__dsResume || []).filter((v) => v.isConnected);
      if (!list.length) {
        // Nothing was playing when we held it; start the blocked autoplay you'd see.
        const blocked = (window.__dsBlocked || []).filter((v) => v.isConnected);
        const current = ${FIND_VIDEO};
        if (current && blocked.includes(current)) list = [current];
      }
      window.__dsResume = [];
      window.__dsBlocked = [];
      // fill.js's forcePlay keeps sites like Instagram in sync instead of fighting them.
      const f = window.__dsFill;
      for (const v of list) {
        if (f && f.forcePlay) f.forcePlay(v); else v.play().catch(() => {});
      }
      return list.length;
    })()`,

    // Fill mode lives in inject/fill.js (too big for a string); the overlay
    // hands its source over once at startup via useFillSource().
    fill: (on) => `(${fillSource})(${on ? 'true' : 'false'})`,
    useFillSource: (src) => { fillSource = src; },
    // Holds every video and audio on the page at our volume (0..1). Sites set their
    // own volume on each new video, so it's re-applied whenever one loads or changes.
    volume: (v) => `(() => {
      window.__dsVolume = ${v};
      if (!window.__dsVolumeInstalled) {
        window.__dsVolumeInstalled = true;
        // Media events don't bubble, but a capturing listener on document sees them.
        const apply = (e) => {
          const m = e.target;
          if (m instanceof HTMLMediaElement && Math.abs(m.volume - window.__dsVolume) > 0.001) m.volume = window.__dsVolume;
        };
        for (const t of ['loadeddata', 'play', 'volumechange']) document.addEventListener(t, apply, true);
      }
      for (const m of document.querySelectorAll('video, audio')) m.volume = ${v};
    })()`,
    // The equipped scroll effect's settings (effects.js), or null for the plain slide.
    effect: (fx) => `window.__dsFill && (window.__dsFill.effect = ${JSON.stringify(fx)})`,
    skipAds: (on) => `window.__dsFill && (window.__dsFill.skipAds = ${on ? 'true' : 'false'})`,
    // Whether you're signed in to this site (actions like repost need it).
    signedIn: (on) => `window.__dsFill && (window.__dsFill.signedIn = ${on ? 'true' : 'false'})`,

    slide: (dir) => `(() => {
      if (window.__dsFill && window.__dsFill.slide) window.__dsFill.slide(${dir > 0 ? 1 : -1});
    })()`,

    // Reports every click as '__ds:focus:1' (a text box: the overlay needs the
    // keyboard) or '__ds:focus:0' (anything else: leave the game focused).
    focusWatch: `(() => {
      if (window.__dsFocusWatch) return;
      window.__dsFocusWatch = true;
      const NOT_TEXT = /^(button|submit|reset|checkbox|radio|range|color|file|image|hidden)$/i;
      const editable = (el) => !!el && el.nodeType === 1 && (el.isContentEditable || el.tagName === 'TEXTAREA' ||
        el.tagName === 'SELECT' || (el.tagName === 'INPUT' && !NOT_TEXT.test(el.type)));
      addEventListener('pointerdown', (e) => {
        console.debug('__ds:focus:' + (editable(e.composedPath()[0]) ? 1 : 0));
      }, true);
    })()`,

    // Lets one synthetic wheel event reach the page underneath the fill canvas.
    passThrough: (on) => `(() => {
      const c = window.__dsFill && window.__dsFill.canvas;
      if (c) c.style.pointerEvents = ${on ? "'none'" : "''"};
      return !!c;
    })()`,
  };
})(typeof window !== 'undefined' ? window : globalThis);
