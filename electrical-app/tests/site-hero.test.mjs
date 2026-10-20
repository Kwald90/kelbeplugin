// Landing-page hero (site/hero.js): the pure scheduling and selection logic, the app-link
// helper, and that the browser's fallback promotion matches the server's built-in default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FALLBACK_PROMOTION, DEFAULT_SETTINGS, REDUCED, normaliseSettings, playbackMode, pickVideo, pickPoster, nextIndex,
  handoverDelayMs, timingFor, progressFor, resolveOverlay, safeHref,
} from '../../site/hero.js';
import { appOriginFor } from '../../site/app-link.js';
import { DEFAULT_PROMOTION, publicView, selectActive } from '../../server/src/services/promotions.js';

const V = { videoDesktop: '/media/a.mp4', videoMobile: '/media/a-m.mp4', poster: '/media/a.jpg' };
const P = { poster: '/site/img/hero/default-1.svg' };

test('the fallback in the page is exactly what the server serves as its default', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(FALLBACK_PROMOTION)), publicView(DEFAULT_PROMOTION));
  assert.deepEqual({ ...DEFAULT_SETTINGS }, DEFAULT_PROMOTION.settings);
});

test('playback mode: video unless reduced motion, Save-Data, a slow link or blocked autoplay; posters; static', () => {
  const slides = [V, P, P];
  assert.equal(playbackMode({ slides }), 'video');
  assert.equal(playbackMode({ slides, reducedMotion: true }), 'posters');
  assert.equal(playbackMode({ slides, saveData: true }), 'posters');
  for (const effectiveType of ['slow-2g', '2g', '3g']) assert.equal(playbackMode({ slides, effectiveType }), 'posters', effectiveType);
  assert.equal(playbackMode({ slides, effectiveType: '4g' }), 'video');
  assert.equal(playbackMode({ slides, autoplayBlocked: true }), 'posters');
  assert.equal(playbackMode({ slides: [P, P, P] }), 'posters');
  assert.equal(playbackMode({ slides: [{ videoDesktop: '/media/x.mp4' }], reducedMotion: true }), 'static', 'reduced motion and no poster: gradient');
  assert.equal(playbackMode({ slides: [] }), 'static');
});

test('sources: phones in portrait get the 9:16 cut, desktop the 16:9; WebM only where it plays', () => {
  assert.equal(pickVideo(V, { portrait: false }), '/media/a.mp4');
  assert.equal(pickVideo(V, { portrait: true }), '/media/a-m.mp4');
  assert.equal(pickVideo({ videoDesktop: '/media/a.mp4' }, { portrait: true }), '/media/a.mp4', 'no phone cut: use the desktop one');
  assert.equal(pickVideo({ videoMobile: '/media/m.mp4' }, { portrait: false }), '/media/m.mp4');
  const w = { ...V, webmDesktop: '/media/a.webm', webmMobile: '/media/a-m.webm' };
  assert.equal(pickVideo(w, { canWebm: true }), '/media/a.webm');
  assert.equal(pickVideo(w, { canWebm: false }), '/media/a.mp4');
  assert.equal(pickVideo(w, { canWebm: true, portrait: true }), '/media/a-m.webm');
  assert.equal(pickVideo(P), null);
  assert.equal(pickPoster({ poster: 'd', posterMobile: 'm' }, { portrait: true }), 'm');
  assert.equal(pickPoster({ poster: 'd', posterMobile: 'm' }, { portrait: false }), 'd');
  assert.equal(pickPoster({ poster: 'd' }, { portrait: true }), 'd');
  assert.equal(pickPoster({}), null);
});

test('rotation wraps both ways', () => {
  assert.deepEqual([0, 1, 2, 3].map((i) => nextIndex(i, 3)), [1, 2, 0, 1]);
  assert.equal(nextIndex(0, 3, -1), 2);
  assert.equal(nextIndex(4, 5, 0), 4);
  assert.equal(nextIndex(0, 0), 0);
});

test('the handover starts handoverAtMs before the end, at the midpoint for short clips, never negative', () => {
  assert.equal(handoverDelayMs({ durationS: 8, currentTimeS: 0, handoverAtMs: 1000 }), 7000);
  assert.equal(handoverDelayMs({ durationS: 8, currentTimeS: 6.5, handoverAtMs: 1000 }), 500);
  assert.equal(handoverDelayMs({ durationS: 8, currentTimeS: 7.9, handoverAtMs: 1000 }), 0);
  assert.equal(handoverDelayMs({ durationS: 1.2, currentTimeS: 0, handoverAtMs: 1000 }), 600);
  assert.equal(handoverDelayMs({ durationS: 8, currentTimeS: 0, handoverAtMs: 1000, playbackRate: 2 }), 3500);
  assert.equal(handoverDelayMs({ durationS: Infinity, handoverAtMs: 1000 }), null, 'unknown duration: wait for durationchange');
  assert.equal(handoverDelayMs({ durationS: NaN, handoverAtMs: 1000 }), null);
});

test('timing: clamped, the fade always ends before the clip; reduced motion is a slow crossfade', () => {
  assert.deepEqual(normaliseSettings({}), { ...DEFAULT_SETTINGS });
  const s = normaliseSettings({ transition: 'slide', transitionMs: 2000, handoverAtMs: 500, posterHoldMs: 999999 });
  assert.equal(s.transition, 'slide');
  assert.equal(s.handoverAtMs, 2100);
  assert.equal(s.posterHoldMs, 20000);
  assert.equal(normaliseSettings({ transition: 'spin' }).transition, 'fade');
  const r = timingFor({ transition: 'slide', transitionMs: 500, posterHoldMs: 3000 }, { mode: 'posters', reducedMotion: true });
  assert.equal(r.kind, 'fade');
  assert.equal(r.transitionMs, REDUCED.transitionMs);
  assert.equal(r.holdMs, REDUCED.minHoldMs);
  assert.equal(timingFor({ transition: 'slide' }, { mode: 'video' }).kind, 'slide');
});

test('progress through a slide', () => {
  assert.equal(progressFor({ video: true, currentTimeS: 3.5, durationS: 8, handoverAtMs: 1000 }), 0.5);
  assert.equal(progressFor({ video: true, currentTimeS: 9, durationS: 8, handoverAtMs: 1000 }), 1);
  assert.equal(progressFor({ video: true, currentTimeS: 1, durationS: Infinity, handoverAtMs: 1000 }), 0);
  assert.equal(progressFor({ video: false, elapsedMs: 1500, holdMs: 6000 }), 0.25);
});

test('slide text overrides the promotion text; a null secondary button hides it', () => {
  const p = { overlay: { eyebrow: 'A', headline: 'H', primaryCta: { label: 'Go', href: '/x' }, secondaryCta: { label: 'More', href: '/y' } },
    slides: [{}, { overlay: { eyebrow: 'B', secondaryCta: null, headline: '' } }] };
  assert.deepEqual(resolveOverlay(p, 0), p.overlay);
  const o = resolveOverlay(p, 1);
  assert.equal(o.eyebrow, 'B');
  assert.equal(o.headline, 'H', 'blank override keeps the promotion text');
  assert.equal(o.secondaryCta, null);
  assert.equal(resolveOverlay(FALLBACK_PROMOTION, 2).eyebrow, 'Estimate to invoice');
});

test('links in the overlay are re-checked in the browser', () => {
  for (const ok of ['/site/signup.html?plan=pro', '#features', 'mailto:sales@fishtapehq.com', 'https://fishtapehq.com/x']) assert.equal(safeHref(ok), ok);
  for (const bad of ['javascript:alert(1)', '//evil.example', 'data:text/html,x', 'http://x.example', '/x" onclick="y']) assert.equal(safeHref(bad), '#');
});

test('the server and the page agree on which promotion is live (shared selection rules)', () => {
  const now = new Date('2026-11-01T12:00:00Z');
  const rows = [
    { id: 'a', priority: 0, starts_at: null, ends_at: null, audience: null, updated_at: '2026-10-01' },
    { id: 'b', priority: 5, starts_at: '2026-11-02T00:00:00Z', ends_at: null, audience: null, updated_at: '2026-10-01' },
    { id: 'c', priority: 5, starts_at: '2026-10-01T00:00:00Z', ends_at: '2026-11-01T12:00:00Z', audience: null, updated_at: '2026-10-01' },
    { id: 'd', priority: 0, starts_at: '2026-10-20T00:00:00Z', ends_at: null, audience: 'province=ON', updated_at: '2026-10-01' },
  ];
  assert.equal(selectActive(rows, { now }).id, 'a', 'b not started, c ended exactly now');
  assert.equal(selectActive(rows, { now, tags: ['province=ON'] }).id, 'd', 'same priority: targeted wins');
  assert.equal(selectActive(rows, { now: new Date('2026-11-02T00:00:00Z') }).id, 'b', 'starts exactly now');
  assert.equal(selectActive([], { now }), null);
});

test('site app links: the apex goes to app.fishtapehq.com, one-host setups stay relative', () => {
  assert.equal(appOriginFor('fishtapehq.com'), 'https://app.fishtapehq.com');
  assert.equal(appOriginFor('www.fishtapehq.com'), 'https://app.fishtapehq.com');
  assert.equal(appOriginFor('WWW.FISHTAPEHQ.COM'), 'https://app.fishtapehq.com');
  assert.equal(appOriginFor('tgelectrical.truecollarbuilt.com'), '');
  assert.equal(appOriginFor('localhost'), '');
  assert.equal(appOriginFor('app.fishtapehq.com'), '');
  assert.equal(appOriginFor('fishtapehq.com', 'https://app.example.ca/'), 'https://app.example.ca', 'the meta tag wins');
  assert.equal(appOriginFor('localhost', 'javascript:alert(1)'), '', 'a bad meta value is ignored');
});
