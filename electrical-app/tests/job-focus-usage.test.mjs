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

// ---- added with the Working-on dropdown and most-used ordering ----
const { rankJobs, focusChoices, usageFromChange, isOpenJob, jobLabel, startingJob, noteJobUse } = await import('../js/lib/job-focus.js');
const { rankOptions, setUsageUser, usageScores } = await import('../js/lib/usage-rank.js');

test('rankJobs: most-used first, the focused job leads, unused keep their order', () => {
  setUsageUser('rj');
  const list = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  assert.deepEqual(rankJobs(list).map((j) => j.id), ['a', 'b', 'c', 'd']);
  noteJobUse('c'); noteJobUse('c'); noteJobUse('b');
  assert.deepEqual(rankJobs(list).map((j) => j.id), ['c', 'b', 'a', 'd']);
  assert.deepEqual(rankJobs(list, { focus: 'd' }).map((j) => j.id), ['d', 'c', 'b', 'a']);
  assert.deepEqual(rankJobs(list, { focus: 'gone' }).map((j) => j.id), ['c', 'b', 'a', 'd']);
  setUsageUser('');
});

test('setUsageUser: calls without a uid count for the signed-in person only', () => {
  setUsageUser('p1');
  noteJobUse('x');
  assert.ok(usageScores('jobs').x > 0);
  assert.equal(usageScores('jobs', { uid: 'p2' }).x, undefined);
  setUsageUser('p2');
  assert.equal(usageScores('jobs').x, undefined);
  setUsageUser('');
});

test('focusChoices: All jobs first, closed jobs left out, open jobs most-used first', () => {
  setUsageUser('fc');
  const jobs = [
    { id: 'j1', number: '1001', title: 'Shop', status: 'in-progress' },
    { id: 'j2', number: '1002', title: 'Reno', status: 'scheduled' },
    { id: 'j3', number: '1003', title: 'Done', status: 'complete' },
    { id: 'j4', number: '1004', title: 'Lead', status: 'lead' },
  ];
  noteJobUse('j1');
  const c = focusChoices(jobs);
  assert.deepEqual(c[0], { value: '', label: 'All jobs' });
  assert.deepEqual(c.map((x) => x.value), ['', 'j1', 'j4', 'j2']);
  assert.equal(c[1].label, '1001 · Shop');
  assert.equal(isOpenJob(jobs[2]), false);
  assert.equal(isOpenJob(null), false);
  assert.equal(jobLabel({ title: 'No number' }), 'No number');
  setUsageUser('');
});

test('startingJob: an explicit ?jobId wins over the focus', () => {
  setJobFocus(store, auth, 'j1');
  assert.equal(startingJob(store, auth, ''), 'j1');
  assert.equal(startingJob(store, auth, 'other'), 'other');
  setJobFocus(store, auth, '');
  assert.equal(startingJob(store, auth, undefined), '');
});

test('usageFromChange: only this person\'s new records count, toward job, client and supplier', () => {
  assert.deepEqual(usageFromChange({ coll: 'dailyLogs', type: 'add', record: { id: 'l1', jobId: 'j1', clientId: 'c1' } }), [['jobs', 'j1'], ['clients', 'c1']]);
  assert.deepEqual(usageFromChange({ coll: 'bills', type: 'add', record: { id: 'b1', jobId: 'j1', vendorId: 'v1' } }), [['jobs', 'j1'], ['vendors', 'v1']]);
  assert.deepEqual(usageFromChange({ coll: 'jobs', type: 'add', record: { id: 'j9', clientId: 'c2' } }), [['jobs', 'j9'], ['clients', 'c2']]);
  assert.deepEqual(usageFromChange({ coll: 'clients', type: 'add', record: { id: 'c3' } }), [['clients', 'c3']]);
  // edits (drawings autosave constantly), synced-in changes, deletes and the audit log don't count
  assert.deepEqual(usageFromChange({ coll: 'drawings', type: 'update', record: { id: 'd', jobId: 'j1' } }), []);
  assert.deepEqual(usageFromChange({ coll: 'dailyLogs', type: 'add', remote: true, record: { id: 'l', jobId: 'j1' } }), []);
  assert.deepEqual(usageFromChange({ coll: 'dailyLogs', type: 'remove', record: { id: 'l', jobId: 'j1' } }), []);
  assert.deepEqual(usageFromChange({ coll: 'auditLog', type: 'add', record: { id: 'a', jobId: 'j1' } }), []);
  assert.deepEqual(usageFromChange({ coll: 'timeEntries', type: 'add', record: { id: 't', jobId: null } }), []);
  assert.deepEqual(usageFromChange(null), []);
});

test('rankOptions: blank choices stay on top, the rest most-used first', () => {
  const opts = { uid: 'ro' };
  resetUsage('clients', opts);
  const options = [{ value: '', label: '— none —' }, { value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }];
  noteUse('clients', 'c', opts);
  assert.deepEqual(rankOptions('clients', options, opts).map((o) => o.value), ['', 'c', 'a', 'b']);
  assert.deepEqual(rankOptions('clients', ['x', 'y'], opts), ['x', 'y']);
  assert.deepEqual(rankOptions('clients', null, opts), []);
});
