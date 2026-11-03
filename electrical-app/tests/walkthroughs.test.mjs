// Run: node --test electrical-app/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newWalkthrough, newStop, progress, canShare, allStopsDone, templatesFrom, templateById, walkthroughLabel, MAX_STOPS } from '../js/lib/walkthroughs.js';

const job = { id: 'j1', number: 'J-1001', title: 'Panel change', clientId: 'c1' };
const photo = () => ({ id: 'p', dataUrl: 'data:image/jpeg;base64,x' });

test('a new walkthrough copies the template stops, tied to the job and client, internal and active', () => {
  const t = templateById(null, 'builtin:panel');
  const w = newWalkthrough({ job, template: t, by: 'u1', date: '2026-11-02' });
  assert.equal(w.jobId, 'j1');
  assert.equal(w.clientId, 'c1');
  assert.equal(w.status, 'active');
  assert.equal(w.sharedWithClient, false);
  assert.equal(w.createdBy, 'u1');
  assert.equal(w.stops.length, t.stops.length);
  assert.ok(w.stops.every((s) => s.id && Array.isArray(s.photos) && s.photos.length === 0 && s.doneAt === null));
  assert.match(walkthroughLabel(w), /Panel change · 2026-11-02/);
});

test('a blank template makes an empty walkthrough; the title falls back', () => {
  const w = newWalkthrough({ job });
  assert.equal(w.stops.length, 0);
  assert.equal(w.title, 'Site walkthrough');
});

test('progress counts stops with a photo or a done mark, plus total photos', () => {
  const w = newWalkthrough({ job, template: templateById(null, 'builtin:service') }); // 5 stops
  assert.deepEqual(progress(w), { done: 0, total: 5, photos: 0, pct: 0 });
  w.stops[0].photos.push(photo());
  w.stops[1].doneAt = '2026-11-02T10:00:00Z';
  const p = progress(w);
  assert.deepEqual([p.done, p.total, p.photos, p.pct], [2, 5, 1, 40]);
});

test('sharing needs a client and at least one photo; complete needs every stop done', () => {
  const w = newWalkthrough({ job, template: { id: 't', name: 'x', stops: ['A', 'B'] } });
  assert.equal(canShare(w), false);
  w.stops[0].photos.push(photo());
  assert.equal(canShare(w), true);
  assert.equal(allStopsDone(w), false);
  w.stops[1].doneAt = 'now';
  assert.equal(allStopsDone(w), true);
  // No client on the job: nothing to share with, even with a photo.
  const w2 = newWalkthrough({ job: { id: 'j2', title: 'No client' } });
  w2.stops = [newStop('A')];
  w2.stops[0].photos.push(photo());
  assert.equal(canShare(w2), false);
});

test('company templates come before the built-ins, which are always present', () => {
  const settings = { walkthroughTemplates: [{ id: 'co:1', name: 'My template', stops: ['X'] }] };
  const ts = templatesFrom(settings);
  assert.equal(ts[0].id, 'co:1');
  assert.ok(ts.some((t) => t.id === 'builtin:blank'));
  assert.equal(templateById(settings, 'co:1').name, 'My template');
  assert.equal(templateById(settings, 'nope'), null);
  assert.ok(templateById(null, 'builtin:final').stops.length > 0);
});

test('a template is capped at MAX_STOPS stops', () => {
  const many = { id: 'big', name: 'Big', stops: Array.from({ length: 50 }, (_, i) => `S${i}`) };
  assert.equal(newWalkthrough({ job, template: many }).stops.length, MAX_STOPS);
});
