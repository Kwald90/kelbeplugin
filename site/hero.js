// Landing-page hero: 3–5 muted clips that hand over seamlessly, with a text overlay per slide.
// Vanilla, no dependencies; used by site/landing.js and by HQ > Promotions for the live preview.
//
// How the handover never shows a black frame:
//  - two stacked layers (A and B), ping-ponged; each holds a poster <img> under a <video>;
//  - the next clip is preloaded in the hidden layer while the current one plays;
//  - `handoverAtMs` before the current clip ends, the next one starts playing (still invisible)
//    and fades in on top only once it is producing frames; the outgoing clip stays fully opaque
//    underneath for the whole fade and, if it ends first, holds its last frame;
//  - inside a layer the video only becomes visible after its first frame, so until then the
//    poster (ideally the clip's first frame) shows, and behind everything a gradient.
// Reduced motion, Save-Data, slow connections or blocked autoplay: posters only, slow crossfade.
// Paused while the tab is hidden, the hero is off-screen, a button in the text has keyboard
// focus, or the visitor pressed pause.
//
// The top of this file is pure (exported for electrical-app/tests/site-hero.test.mjs); the DOM
// player is createHero().

export const DEFAULT_SETTINGS = Object.freeze({ transition: 'fade', transitionMs: 800, handoverAtMs: 1000, posterHoldMs: 6000 });
/** Reduced motion: posters, a slow crossfade, longer holds. */
export const REDUCED = Object.freeze({ transitionMs: 1600, minHoldMs: 8000 });
export const PORTRAIT_QUERY = '(orientation: portrait) and (max-width: 900px)';
const SLOW = new Set(['slow-2g', '2g', '3g']);

/**
 * Shown when the API can't be reached. Must equal the server's built-in DEFAULT_PROMOTION
 * (server/src/services/promotions.js) as the public endpoint returns it; a server test checks.
 */
export const FALLBACK_PROMOTION = Object.freeze({
  id: 'default',
  overlay: {
    eyebrow: 'CEC 2024 built in',
    headline: 'Built for Canadian electricians',
    subline: 'Quotes, jobs, drawings, crew time and invoices in one app, checked against the Canadian Electrical Code.',
    note: '$1 deposit, credited to your first month.',
    primaryCta: { label: 'Start your 14-day free trial', href: '/site/signup.html?plan=pro' },
    secondaryCta: { label: 'See pricing', href: '/site/pricing.html' },
  },
  slides: [
    { poster: '/site/img/hero/default-1.svg' },
    { poster: '/site/img/hero/default-2.svg', overlay: { eyebrow: 'Field tools', subline: 'Measure wire runs with AR, get marks for every conduit bend, and keep working offline on site.' } },
    { poster: '/site/img/hero/default-3.svg', overlay: { eyebrow: 'Estimate to invoice', subline: 'Quote it, schedule the crew, track time and get paid. AI drafts it, you approve it.' } },
  ],
  settings: { ...DEFAULT_SETTINGS },
});

const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);

/** Fill in and clamp timing; the fade always ends at least 100 ms before the clip does. */
export function normaliseSettings(s = {}) {
  const transitionMs = clamp(s.transitionMs, 200, 3000, DEFAULT_SETTINGS.transitionMs);
  return {
    transition: s.transition === 'slide' ? 'slide' : 'fade',
    transitionMs,
    handoverAtMs: Math.max(clamp(s.handoverAtMs, 300, 4000, DEFAULT_SETTINGS.handoverAtMs), transitionMs + 100),
    posterHoldMs: clamp(s.posterHoldMs, 2000, 20000, DEFAULT_SETTINGS.posterHoldMs),
  };
}

export const hasVideo = (s) => Boolean(s && (s.videoDesktop || s.videoMobile || s.webmDesktop || s.webmMobile));
export const hasPoster = (s) => Boolean(s && (s.poster || s.posterMobile));

/**
 * 'video' | 'posters' | 'static' (gradient + text only).
 * @param {{ slides: object[], reducedMotion?: boolean, saveData?: boolean, effectiveType?: string, autoplayBlocked?: boolean }} o
 */
export function playbackMode({ slides = [], reducedMotion = false, saveData = false, effectiveType = '', autoplayBlocked = false }) {
  if (!slides.length) return 'static';
  const lowData = saveData || SLOW.has(String(effectiveType));
  if (slides.some(hasVideo) && !reducedMotion && !lowData && !autoplayBlocked) return 'video';
  return slides.some(hasPoster) ? 'posters' : 'static';
}

/** The video URL for this screen: portrait phones get the 9:16 / 4:5 cut when there is one; WebM when it plays. */
export function pickVideo(slide, { portrait = false, canWebm = false } = {}) {
  if (!slide) return null;
  const desk = [canWebm && slide.webmDesktop, slide.videoDesktop];
  const mob = [canWebm && slide.webmMobile, slide.videoMobile];
  return [...(portrait ? [...mob, ...desk] : [...desk, ...mob])].find(Boolean) || null;
}

export function pickPoster(slide, { portrait = false } = {}) {
  if (!slide) return null;
  return (portrait ? slide.posterMobile || slide.poster : slide.poster || slide.posterMobile) || null;
}

export const nextIndex = (i, n, step = 1) => (n > 0 ? (((i + step) % n) + n) % n : 0);

/**
 * Milliseconds until the handover should start, or null while the duration is unknown.
 * Short clips hand over at their midpoint at the latest.
 */
export function handoverDelayMs({ durationS, currentTimeS = 0, handoverAtMs, playbackRate = 1 }) {
  if (!Number.isFinite(durationS) || durationS <= 0) return null;
  const lead = Math.min(handoverAtMs, (durationS * 1000) / 2);
  return Math.max(0, ((durationS - currentTimeS) * 1000 - lead) / (playbackRate > 0 ? playbackRate : 1));
}

/** How a slide hands over and how long a poster stays, for the mode and motion preference. */
export function timingFor(settings, { mode = 'video', reducedMotion = false } = {}) {
  const s = normaliseSettings(settings);
  if (reducedMotion) return { kind: 'fade', transitionMs: Math.max(REDUCED.transitionMs, s.transitionMs), holdMs: Math.max(REDUCED.minHoldMs, s.posterHoldMs), handoverAtMs: s.handoverAtMs };
  return { kind: mode === 'video' ? s.transition : s.transition, transitionMs: s.transitionMs, holdMs: s.posterHoldMs, handoverAtMs: s.handoverAtMs };
}

/** 0..1 through the current slide, for the progress bar under its dot. */
export function progressFor({ video, currentTimeS, durationS, handoverAtMs, elapsedMs, holdMs }) {
  if (video) {
    if (!Number.isFinite(durationS) || durationS <= 0) return 0;
    const usable = Math.max(0.1, durationS - Math.min(handoverAtMs, (durationS * 1000) / 2) / 1000);
    return Math.min(1, Math.max(0, currentTimeS / usable));
  }
  return holdMs > 0 ? Math.min(1, Math.max(0, elapsedMs / holdMs)) : 0;
}

/** The promotion's overlay with the slide's overrides on top (a null secondary button hides it). */
export function resolveOverlay(promotion, i) {
  const out = { ...(promotion?.overlay || {}) };
  for (const [k, v] of Object.entries(promotion?.slides?.[i]?.overlay || {})) if (v !== undefined && v !== '') out[k] = v;
  return out;
}

/** Links the overlay may use (the server checks too): /path, #anchor, mailto:, https:. */
export function safeHref(href) {
  const s = String(href || '');
  return /^(\/(?!\/)|#|mailto:|https:\/\/)/.test(s) && !/[\s"'<>`\\]/.test(s) ? s : '#';
}

// ---------------------------------------------------------------------------------------------
// DOM player

function el(tag, cls, attrs = {}) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
  return e;
}

/** What this browser and visitor allow. */
export function detectEnv(win = globalThis) {
  const mm = (q) => Boolean(win.matchMedia?.(q).matches);
  const c = win.navigator?.connection;
  let canWebm = false;
  try { canWebm = Boolean(document.createElement('video').canPlayType('video/webm; codecs="vp9"')); } catch { /* no DOM */ }
  return { reducedMotion: mm('(prefers-reduced-motion: reduce)'), saveData: Boolean(c?.saveData), effectiveType: c?.effectiveType || '', canWebm };
}

/** Write the overlay into the copy block (eyebrow, heading, sub-line, buttons, note), reusing nodes. */
export function renderCopy(copy, overlay, { headingTag = 'h1' } = {}) {
  const part = (cls, tag) => copy.querySelector(`:scope > .${cls}`) || copy.appendChild(el(tag, cls));
  const eyebrow = part('hero-eyebrow', 'p');
  const heading = part('hero-headline', headingTag);
  const sub = part('hero-sub', 'p');
  const ctas = part('hero-ctas', 'div');
  const note = part('hero-note', 'p');
  copy.append(eyebrow, heading, sub, ctas, note); // fixed order
  for (const [node, text] of [[eyebrow, overlay.eyebrow], [heading, overlay.headline], [sub, overlay.subline], [note, overlay.note]]) {
    node.textContent = text || '';
    node.hidden = !text;
  }
  const btn = (cls, c) => {
    const a = ctas.querySelector(`.${cls}`) || ctas.appendChild(el('a', `site-btn ${cls}`));
    a.hidden = !c?.label;
    if (c?.label) { a.textContent = c.label; a.href = safeHref(c.href); }
    return a;
  };
  ctas.append(btn('hero-primary', overlay.primaryCta), btn('hero-secondary', overlay.secondaryCta));
  ctas.hidden = !overlay.primaryCta?.label && !overlay.secondaryCta?.label;
}

const ICON_PAUSE = 'M7 5h4v14H7zM13 5h4v14h-4z';
const ICON_PLAY = 'M8 5v14l11-7z';
function icon(path) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '20'); svg.setAttribute('height', '20'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  const p = document.createElementNS(ns, 'path'); p.setAttribute('d', path); p.setAttribute('fill', 'currentColor');
  svg.append(p);
  return svg;
}

/**
 * Start the hero in `root` (a .hero element with .hero-stage, .hero-copy and .hero-controls;
 * missing parts are created).
 * @param {HTMLElement} root
 * @param {{ overlay: object, slides: object[], settings?: object }} promotion
 * @param {{ env?: object, mode?: 'video'|'posters'|'static', headingTag?: string, observe?: boolean, label?: string }} [opts]
 *   mode forces a mode (HQ preview); observe: false skips the off-screen/visibility pausing.
 */
export function createHero(root, promotion, opts = {}) {
  const win = root.ownerDocument.defaultView;
  const env = { ...detectEnv(win), ...(opts.env || {}) };
  if (!root.querySelector('.hero-stage')) root.prepend(el('div', 'hero-stage', { 'aria-hidden': 'true' }));
  const stage = root.querySelector('.hero-stage');
  if (!root.querySelector('.hero-copy')) {
    const inner = el('div', 'hero-inner');
    inner.append(el('div', 'hero-copy'));
    stage.after(el('div', 'hero-scrim', { 'aria-hidden': 'true' }), inner);
  }
  const copy = root.querySelector('.hero-copy');
  const controls = root.querySelector('.hero-controls') || root.appendChild(el('div', 'hero-controls'));
  const portraitMq = win.matchMedia?.(PORTRAIT_QUERY);
  const reducedMq = win.matchMedia?.('(prefers-reduced-motion: reduce)');

  let promo = promotion, slides = [], n = 0, timing = null, mode = 'static';
  let layers = [], front = 0, cur = 0, transitioning = false, pendingJump = null, gen = 0;
  let timer = null, holdStart = 0, holdLeft = 0, raf = 0, autoplayBlocked = false;
  const reasons = new Set();
  const cleanups = [];
  let dots = [], pauseBtn = null, dotsBox = null;

  const on = (target, type, fn, o) => { target?.addEventListener(type, fn, o); cleanups.push(() => target?.removeEventListener(type, fn, o)); };
  const paused = () => reasons.size > 0;
  const clearTimer = () => { clearTimeout(timer); timer = null; };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // env.portrait forces the phone cut (the HQ phone preview); otherwise the viewport decides, clip by clip.
  const portrait = () => (typeof env.portrait === 'boolean' ? env.portrait : Boolean(portraitMq?.matches));

  // ---- layers ----
  function makeVideo() {
    const v = el('video', 'hero-video', { muted: true, playsinline: true, 'webkit-playsinline': true, preload: 'auto', 'aria-hidden': 'true', tabindex: '-1', disablepictureinpicture: true, disableremoteplayback: true });
    v.muted = true; v.defaultMuted = true; v.playsInline = true;
    return v;
  }
  function makeLayer(adoptImg) {
    const box = el('div', 'hero-layer');
    const img = adoptImg || el('img', 'hero-poster', { alt: '', decoding: 'async' });
    img.alt = '';
    box.append(img);
    const L = { el: box, img, video: mode === 'video' ? makeVideo() : null, index: -1, broken: false };
    if (L.video) {
      box.append(L.video);
      const v = L.video;
      on(v, 'loadeddata', () => { if (v.paused && v.currentTime === 0) v.classList.add('has-frame'); });
      on(v, 'durationchange', () => { if (layers[front] === L && !transitioning) arm(); });
      on(v, 'waiting', () => { if (layers[front] === L) clearTimer(); });
      on(v, 'playing', () => { if (layers[front] === L && !transitioning) arm(); });
      on(v, 'ended', () => {
        if (layers[front] !== L || transitioning || paused()) return;
        if (n > 1) go(nextIndex(cur, n)); else { v.currentTime = 0; play(L); }
      });
      on(v, 'error', () => { L.broken = true; v.classList.remove('has-frame'); if (layers[front] === L && !transitioning) arm(); });
    }
    return L;
  }
  const videoOn = (L) => Boolean(L?.video && !L.broken && L.video.getAttribute('src'));

  function load(L, i) {
    L.index = i;
    L.broken = false;
    const s = slides[i];
    const poster = pickPoster(s, { portrait: portrait() });
    if (poster) { if (L.img.getAttribute('src') !== poster) L.img.src = poster; L.img.hidden = false; } else { L.img.removeAttribute('src'); L.img.hidden = true; }
    if (!L.video) return;
    const src = pickVideo(s, { portrait: portrait(), canWebm: env.canWebm });
    L.video.classList.remove('has-frame');
    if (!src) { if (L.video.getAttribute('src')) { L.video.removeAttribute('src'); L.video.load(); } return; }
    if (L.video.getAttribute('src') !== src) L.video.src = src; // starts preloading
    else { try { L.video.currentTime = 0; } catch { /* not loaded yet */ } }
  }

  /** Play a layer's clip; resolves true once frames are coming (or false after a timeout). */
  function play(L) {
    if (!videoOn(L)) return Promise.resolve(false);
    const v = L.video;
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        v.removeEventListener('timeupdate', onTime);
        clearTimeout(t);
        if (ok) v.classList.add('has-frame');
        resolve(ok);
      };
      const onTime = () => { if (v.currentTime > 0.02) finish(true); };
      v.addEventListener('timeupdate', onTime);
      if (typeof v.requestVideoFrameCallback === 'function') v.requestVideoFrameCallback(() => finish(true));
      const t = setTimeout(() => finish(false), 3000);
      const p = v.play();
      p?.catch?.((e) => {
        finish(false);
        if (e?.name === 'NotAllowedError' && !autoplayBlocked) { autoplayBlocked = true; restart(); }
      });
    });
  }

  function hideNow(L) {
    L.el.classList.add('no-anim');
    L.el.classList.remove('is-visible', 'is-front', 'is-leaving');
    void L.el.offsetWidth; // apply without a transition
    L.el.classList.remove('no-anim');
  }

  // ---- copy, dots, pause ----
  function showCopy(i, animate) {
    const o = resolveOverlay(promo, i);
    if (!animate || env.reducedMotion || !copy.classList.contains('is-ready')) { renderCopy(copy, o, opts); copy.classList.add('is-ready'); return; }
    const sameText = copy.textContent === (() => { const d = el('div'); renderCopy(d, o, opts); return d.textContent; })();
    if (sameText) { renderCopy(copy, o, opts); return; }
    copy.classList.add('is-swapping');
    setTimeout(() => { renderCopy(copy, o, opts); copy.classList.remove('is-swapping'); }, 180);
  }

  function buildControls() {
    controls.replaceChildren();
    dots = [];
    if (n < 2 || mode === 'static') { controls.hidden = true; return; }
    controls.hidden = false;
    dotsBox = el('div', 'hero-dots', { role: 'group', 'aria-label': 'Choose a slide' });
    for (let i = 0; i < n; i++) {
      const o = resolveOverlay(promo, i);
      const b = el('button', 'hero-dot', { type: 'button', 'aria-label': `Slide ${i + 1} of ${n}${o.eyebrow ? `: ${o.eyebrow}` : ''}` });
      const fill = el('span', 'hero-dot-fill');
      b.append(el('span', 'hero-dot-bar'));
      b.firstChild.append(fill);
      b.addEventListener('click', () => jump(i));
      dots.push({ b, fill });
      dotsBox.append(b);
    }
    dotsBox.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const i = nextIndex(dots.findIndex((d) => d.b === document.activeElement), n, e.key === 'ArrowRight' ? 1 : -1);
      dots[i].b.focus();
      jump(i);
    });
    pauseBtn = el('button', 'hero-pause', { type: 'button' });
    pauseBtn.addEventListener('click', () => (reasons.has('user') ? resume('user') : pause('user')));
    controls.append(dotsBox, pauseBtn);
    renderPause();
    markDot(cur);
  }
  function renderPause() {
    if (!pauseBtn) return;
    const user = reasons.has('user');
    const what = mode === 'video' ? 'background video' : 'slideshow';
    pauseBtn.setAttribute('aria-label', user ? `Play ${what}` : `Pause ${what}`);
    pauseBtn.title = user ? `Play ${what}` : `Pause ${what}`;
    pauseBtn.replaceChildren(icon(user ? ICON_PLAY : ICON_PAUSE));
    root.dataset.state = paused() ? 'paused' : 'playing';
    copy.setAttribute('aria-live', user ? 'polite' : 'off');
  }
  function markDot(i) {
    dots.forEach((d, k) => {
      if (k === i) d.b.setAttribute('aria-current', 'true'); else d.b.removeAttribute('aria-current');
      d.fill.style.transform = 'scaleX(0)';
    });
    root.dataset.index = String(i);
  }

  // ---- progress ----
  function tick() {
    raf = 0;
    if (paused() || !dots[cur]) return;
    const L = layers[front];
    const v = videoOn(L) ? L.video : null;
    const p = progressFor({ video: Boolean(v), currentTimeS: v?.currentTime, durationS: v?.duration, handoverAtMs: timing.handoverAtMs, elapsedMs: timing.holdMs - holdLeft + (performance.now() - holdStart), holdMs: timing.holdMs });
    dots[cur].fill.style.transform = `scaleX(${p.toFixed(3)})`;
    raf = win.requestAnimationFrame(tick);
  }
  const startTick = () => { if (!raf && dots.length && !paused()) raf = win.requestAnimationFrame(tick); };
  const stopTick = () => { if (raf) win.cancelAnimationFrame(raf); raf = 0; };

  // ---- scheduling ----
  function arm() {
    clearTimer();
    if (paused() || n < 2 || transitioning || mode === 'static') return;
    const L = layers[front];
    if (videoOn(L)) {
      const d = handoverDelayMs({ durationS: L.video.duration, currentTimeS: L.video.currentTime, handoverAtMs: timing.handoverAtMs, playbackRate: L.video.playbackRate });
      if (d != null) timer = setTimeout(() => go(nextIndex(cur, n)), d); // else: durationchange re-arms; `ended` is the backstop
    } else {
      holdStart = performance.now();
      timer = setTimeout(() => go(nextIndex(cur, n)), holdLeft);
    }
    startTick();
  }

  /** Hand over to slide `to`. */
  async function go(to) {
    if (transitioning) { pendingJump = to; return; }
    if (to === cur || n < 2) return;
    const g = ++gen;
    clearTimer();
    transitioning = true;
    const incoming = layers[1 - front];
    const outgoing = layers[front];
    if (incoming.index !== to) load(incoming, to);
    if (videoOn(incoming) && !paused()) await play(incoming);
    if (g !== gen) return;
    root.style.setProperty('--hero-fade', `${timing.transitionMs}ms`);
    incoming.el.classList.add('is-front');
    outgoing.el.classList.remove('is-front');
    if (timing.kind === 'slide') outgoing.el.classList.add('is-leaving');
    incoming.el.classList.add('is-visible');
    cur = to;
    markDot(to);
    showCopy(to, true);
    await wait(timing.transitionMs + 40);
    if (g !== gen) return;
    if (outgoing.video) { outgoing.video.pause(); }
    hideNow(outgoing);
    front = 1 - front;
    transitioning = false;
    holdLeft = timing.holdMs;
    load(outgoing, nextIndex(to, n)); // preload the one after
    if (pendingJump != null) { const j = pendingJump; pendingJump = null; if (j !== cur) { go(j); return; } }
    arm();
  }

  function jump(i) {
    if (i === cur && !transitioning) return;
    holdLeft = timing.holdMs;
    go(i);
  }

  // ---- pause / resume ----
  function pause(reason) {
    const was = paused();
    reasons.add(reason);
    if (!was) {
      clearTimer();
      stopTick();
      if (layers[front] && !videoOn(layers[front])) holdLeft = Math.max(0, holdLeft - (performance.now() - holdStart));
      for (const L of layers) L.video?.pause();
    }
    renderPause();
  }
  function resume(reason) {
    if (!reasons.delete(reason)) return;
    renderPause();
    if (paused()) return;
    const L = layers[front];
    if (videoOn(L)) play(L).then(() => arm()); else arm();
    if (transitioning && videoOn(layers[1 - front])) play(layers[1 - front]);
  }

  // ---- (re)start ----
  function teardownLayers() {
    gen++;
    clearTimer(); stopTick();
    for (const L of layers) {
      if (L.video) { L.video.pause(); L.video.removeAttribute('src'); try { L.video.load(); } catch { /* ignore */ } }
    }
    layers = [];
    transitioning = false;
    pendingJump = null;
  }

  function start(startAt = 0) {
    teardownLayers();
    slides = Array.isArray(promo?.slides) ? promo.slides.slice(0, 5) : [];
    n = slides.length;
    mode = opts.mode || playbackMode({ slides, reducedMotion: env.reducedMotion, saveData: env.saveData, effectiveType: env.effectiveType, autoplayBlocked });
    timing = timingFor(promo?.settings, { mode, reducedMotion: env.reducedMotion });
    holdLeft = timing.holdMs;
    cur = Math.min(startAt, Math.max(0, n - 1));
    root.dataset.mode = mode;
    root.dataset.transition = timing.kind;
    root.style.setProperty('--hero-fade', `${timing.transitionMs}ms`);
    const adopt = stage.querySelector('img.hero-poster');
    const keep = adopt && slides[cur] && adopt.getAttribute('src') === pickPoster(slides[cur], { portrait: portrait() }) ? adopt : null;
    stage.replaceChildren();
    if (mode !== 'static') {
      layers = [makeLayer(keep), makeLayer(null)];
      stage.append(layers[0].el, layers[1].el);
      front = 0;
      load(layers[0], cur);
      layers[0].el.classList.add('is-visible', 'is-front');
      if (n > 1) load(layers[1], nextIndex(cur, n));
      if (n === 1 && layers[0].video) layers[0].video.loop = true;
    }
    showCopy(cur, false);
    buildControls();
    renderPause();
    if (!paused() && videoOn(layers[0])) play(layers[0]).then(() => arm()); else arm();
  }
  const restart = () => start(cur);

  // ---- outside world ----
  if (opts.observe !== false) {
    on(root.ownerDocument, 'visibilitychange', () => (root.ownerDocument.hidden ? pause('hidden') : resume('hidden')));
    if ('IntersectionObserver' in win) {
      const io = new win.IntersectionObserver((entries) => {
        for (const e of entries) (e.isIntersecting ? resume('offscreen') : pause('offscreen'));
      }, { threshold: 0.15 });
      io.observe(root);
      cleanups.push(() => io.disconnect());
    }
  }
  on(copy, 'focusin', (e) => { if (e.target.matches?.(':focus-visible')) pause('focus'); });
  on(copy, 'focusout', (e) => { if (!copy.contains(e.relatedTarget)) resume('focus'); });
  if (!opts.env?.reducedMotion && !opts.mode) on(reducedMq, 'change', () => { env.reducedMotion = reducedMq.matches; restart(); });

  if (root.ownerDocument.hidden && opts.observe !== false) reasons.add('hidden');
  start(0);

  return {
    get state() { return { mode, index: cur, paused: paused(), reasons: [...reasons], slides: n, transitioning }; },
    pause: () => pause('user'),
    play: () => resume('user'),
    goTo: (i) => jump(nextIndex(i, n, 0)),
    /** New promotion: only the text changes if the slides and timing are the same. */
    update(next) {
      const same = JSON.stringify([next?.slides?.map((s) => ({ ...s, overlay: undefined })), next?.settings]) === JSON.stringify([promo?.slides?.map((s) => ({ ...s, overlay: undefined })), promo?.settings]);
      promo = next;
      if (same && next?.slides?.length === n) { showCopy(cur, false); buildControls(); renderPause(); } else start(0);
    },
    destroy() {
      teardownLayers();
      for (const fn of cleanups.splice(0)) fn();
    },
  };
}
