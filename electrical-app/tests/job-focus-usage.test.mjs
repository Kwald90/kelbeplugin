// Job focus (lib/job-focus.js) + usage ranking (lib/usage-rank.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';

class MemStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
globalThis.localStorage = new MemStorage();

const { jobFocus, setJobFocus, focusFilter, focusedJob, readFocus } = await import('../js/lib/job-focus.js');
const { noteUse, rankByUse, topUsed, score, HALF_LIFE_DAYS, resetUsage } = await import('../js/lib/usage-rank.js');

const jobs = { j1: { id: 'j1', status: 'in-progress' }, j2: { id: 'j2', status: 'complete' } };
const store = { dbName: 'fishtape:u:co', get: (c, id) => (c === 'jobs' ? jobs[id] || null : null) };
const auth = { current: () => ({ id: 'emp1' }) };

test('job focus: defaults to all jobs, saves per user + database', () => {
  assert.equal(jobFocus(store, auth), '');
  setJobFocus(store, auth, 'j1');
  assert.equal(jobFocus(store, auth), 'j1');
  assert.equal(focusedJob(store, auth).id, 'j1');
  // another person on the same device keeps their own choice
  assert.equal(jobFocus(store, { current: () => ({ id: 'emp2' }) }), '');
  // another company database too
  assert.equal(jobFocus({ ...store, dbName: 'other' }, auth), '');
  setJobFocus(store, auth, '');
  assert.equal(readFocus('emp1', store.dbName), '');
});

test('job focus: a closed-out or deleted job reads as all jobs', () => {
  setJobFocus(store, auth, 'j2');
  assert.equal(jobFocus(store, auth), '');
  setJobFocus(store, auth, 'gone');
  assert.equal(jobFocus(store, auth), '');
  setJobFocus(store, auth, '');
});

test('focusFilter keeps all with no focus, else only that job', () => {
  const rows = [{ jobId: 'j1' }, { jobId: 'j2' }, {}];
  assert.equal(rows.filter(focusFilter('')).length, 3);
  assert.deepEqual(rows.filter(focusFilter('j1')), [{ jobId: 'j1' }]);
  assert.equal([{ job: 'j1' }].filter(focusFilter('j1', 'job')).length, 1);
});

test('rankByUse: unused keep designed order, used move up by count', () => {
  const opts = { uid: 'u1' };
  resetUsage('calcs', opts);
  const items = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  assert.deepEqual(rankByUse('calcs', items, undefined, opts).map((x) => x.id), ['a', 'b', 'c', 'd']);
  noteUse('calcs', 'c', opts); noteUse('calcs', 'c', opts); noteUse('calcs', 'd', opts);
  assert.deepEqual(rankByUse('calcs', items, undefined, opts).map((x) => x.id), ['c', 'd', 'a', 'b']);
  assert.deepEqual(topUsed('calcs', 1, opts), ['c']);
  // limit: only the top one moves
  assert.deepEqual(rankByUse('calcs', items, undefined, { ...opts, limit: 1 }).map((x) => x.id), ['c', 'a', 'b', 'd']);
  // other users are unaffected
  assert.deepEqual(rankByUse('calcs', items, undefined, { uid: 'u2' }).map((x) => x.id), ['a', 'b', 'c', 'd']);
});

test('usage decays: old heavy use loses to recent use', () => {
  const day = 86400000;
  const now = Date.UTC(2026, 10, 25);
  assert.equal(score({ n: 4, t: now - HALF_LIFE_DAYS * day }, now), 2);
  const opts = { uid: 'u3' };
  for (let i = 0; i < 5; i++) noteUse('x', 'old', { ...opts, now: now - 120 * day });
  noteUse('x', 'new', { ...opts, now });
  noteUse('x', 'new', { ...opts, now });
  assert.deepEqual(rankByUse('x', [{ id: 'old' }, { id: 'new' }], undefined, { ...opts, now }).map((r) => r.id), ['new', 'old']);
});
