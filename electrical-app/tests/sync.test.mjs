// Sync queue and conflict rules (js/sync.js) against the real store in memory (no DOM, no
// IndexedDB in Node). Run: node --test electrical-app/tests/*.test.mjs
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { store, dbNameFor, userDbPrefix, DEMO_DB } from '../js/store.js';
import { enqueue, nextBatch, toWire, applyPushResults, applyPullPage, queueCounts, createSync, BACKOFF_MS } from '../js/sync.js';

let n = 0;
const mid = () => `mid-${++n}`;
const track = () => store.track((c) => enqueue(store, c, { newMid: mid }));

beforeEach(async () => {
  await store.open({ kind: 'company', userId: 'u-1', tenantId: 't-1' });
  track();
});

/** A fake API: scripted pull pages, push answered by a function. Records every call. */
function fakeApi({ pages = [], push = (muts) => muts.map((m) => ({ mid: m.mid, status: 'ok', version: 1, changeSeq: 1 })) } = {}) {
  const calls = [];
  const api = {
    calls,
    pages,
    async get(path) {
      calls.push(['GET', path]);
      if (path.startsWith('/api/v1/sync/pull')) return api.pages.shift() || { changes: [], cursor: new URL(path, 'http://x').searchParams.get('since'), more: false };
      if (api.onGet) return api.onGet(path);
      throw Object.assign(new Error('not found'), { status: 404, code: 'not_found' });
    },
    async post(path, body) {
      calls.push(['POST', path, body]);
      if (api.fail) throw api.fail;
      return { results: push(body.mutations) };
    },
  };
  return api;
}
const manualTimers = () => {
  const t = { pending: [], setTimeout(fn, ms) { const h = { fn, ms }; t.pending.push(h); return h; }, clearTimeout(h) { t.pending = t.pending.filter((x) => x !== h); } };
  return t;
};

test('one database per company, a separate one for the demo', () => {
  const a = dbNameFor({ kind: 'company', userId: 'u-1', tenantId: 't-1' });
  const b = dbNameFor({ kind: 'company', userId: 'u-1', tenantId: 't-2' });
  const c = dbNameFor({ kind: 'company', userId: 'u-2', tenantId: 't-1' });
  assert.equal(new Set([a, b, c, DEMO_DB]).size, 4);
  assert.equal(dbNameFor({ kind: 'demo' }), DEMO_DB);
  assert.ok(a.startsWith(userDbPrefix('u-1')) && b.startsWith(userDbPrefix('u-1')) && !c.startsWith(userDbPrefix('u-1')));
  assert.throws(() => dbNameFor({ kind: 'company', userId: 'u-1' }));
});

test('switching scope clears memory: nothing from one company shows in another', async () => {
  store.add('clients', { name: 'Only in company 1' });
  await store.open({ kind: 'company', userId: 'u-1', tenantId: 't-2' });
  assert.equal(store.count('clients'), 0);
  assert.equal(store.queue.length, 0);
});

test('a burst of edits to one record is one mutation; fields accumulate', () => {
  const c = store.add('clients', { name: 'A' });
  store.update('clients', c.id, { phone: '555' });
  store.update('clients', c.id, { email: 'a@example.test' });
  assert.equal(store.queue.length, 1);
  const e = store.queue[0];
  assert.equal(e.op, 'upsert');
  assert.equal(e.baseVersion, null);
  assert.equal(e.data.email, 'a@example.test');
  assert.equal(e.fields, null, 'a create carries the whole record');
});

test('created and deleted before syncing leaves nothing to push', () => {
  const c = store.add('clients', { name: 'Temp' });
  store.remove('clients', c.id);
  assert.equal(store.queue.length, 0);
});

test('deleting a synced record queues a delete with its version', () => {
  store.applyRemote('clients', 'c1', { id: 'c1', name: 'Synced', version: 4 }, 4);
  assert.equal(store.get('clients', 'c1').version, undefined, 'server version is not stored in the record');
  assert.equal(store.version('clients', 'c1'), 4);
  store.update('clients', 'c1', { name: 'Renamed' });
  store.remove('clients', 'c1');
  assert.equal(store.queue.length, 1);
  assert.deepEqual([store.queue[0].op, store.queue[0].baseVersion], ['delete', 4]);
  const w = toWire(store.queue[0]);
  assert.equal(w.op, 'delete');
  assert.ok(w.data.deletedAt);
});

test('routine audit entries stay local; exports go to the server as client events', () => {
  store.add('clients', { name: 'X' });
  assert.equal(store.queue.filter((e) => e.collection === 'auditLog').length, 0);
  assert.ok(store.count('auditLog') >= 1, 'local log still written');
  store.log('export', 'Timesheet CSV', 'timeEntries');
  store.log('approve', 'Approved week', 'timeEntries');
  const events = store.queue.filter((e) => e.collection === 'auditLog');
  assert.equal(events.length, 1);
  assert.equal(events[0].data.action, 'export');
  assert.deepEqual(queueCounts(store.queue), { waiting: 1, rejected: 0 });
});

test('default settings are never queued; real settings edits are', () => {
  assert.ok(store.get('settings', 'settings'));
  assert.equal(store.queue.length, 0);
  store.saveSettings({ markupPct: 25 });
  assert.equal(store.queue.length, 1);
  assert.deepEqual(store.queue[0].fields, ['markupPct']);
});

test('batches: one mutation per record, size and count limits, rejected skipped', () => {
  const a = store.add('clients', { name: 'A' });
  const b = store.add('clients', { name: 'B' });
  store.queue[0].sent = true; // in flight
  store.update('clients', a.id, { name: 'A2' }); // new entry behind the in-flight one
  const c = store.add('jobs', { title: 'C' });
  assert.equal(store.queue.length, 4);
  const batch = nextBatch(store.queue);
  assert.deepEqual(batch.map((e) => e.data.name || e.data.title), ['A', 'B'], 'stops before the second mutation of A');
  assert.equal(nextBatch(store.queue, { max: 1 }).length, 1);
  store.queue[1].state = 'rejected';
  assert.deepEqual(nextBatch(store.queue).map((e) => e.id), [a.id]);
  assert.ok(c.id && b.id);
  const big = nextBatch([{ collection: 'drawings', id: 'd1', data: { x: 'y'.repeat(100) } }, { collection: 'drawings', id: 'd2', data: { x: 'z' } }], { maxBytes: 50 });
  assert.equal(big.length, 1, 'a record bigger than the budget still goes, alone');
});

test('ok results store the version and hand it to later edits', () => {
  const c = store.add('clients', { name: 'A' });
  const first = store.queue[0];
  first.sent = true;
  store.update('clients', c.id, { name: 'A2' });
  const out = applyPushResults(store, [first], [{ mid: first.mid, status: 'ok', version: 1, changeSeq: 10 }]);
  assert.equal(out.matched, 1);
  assert.equal(store.version('clients', c.id), 1);
  assert.equal(store.queue.length, 1);
  assert.equal(store.queue[0].baseVersion, 1);
});

test('conflict: the server copy replaces the local one and is reported', () => {
  store.applyRemote('clients', 'c1', { id: 'c1', name: 'Old' }, 2);
  store.update('clients', 'c1', { name: 'Mine (older)' });
  const e = store.queue[0];
  const out = applyPushResults(store, [e], [{ mid: e.mid, status: 'conflict', server: { id: 'c1', version: 3, deleted: false, data: { id: 'c1', version: 3, name: 'Theirs (newer)' } } }]);
  assert.deepEqual(out.conflicts, [{ collection: 'clients', id: 'c1', deleted: false }]);
  assert.equal(store.get('clients', 'c1').name, 'Theirs (newer)');
  assert.equal(store.version('clients', 'c1'), 3);
  assert.equal(store.queue.length, 0);
});

test('conflict with a newer local edit queued: keep the local edit, rebase it on the winner', () => {
  store.applyRemote('clients', 'c1', { id: 'c1', name: 'Old' }, 2);
  store.update('clients', 'c1', { name: 'First' });
  const e = store.queue[0];
  e.sent = true;
  store.update('clients', 'c1', { name: 'Second' });
  const out = applyPushResults(store, [e], [{ mid: e.mid, status: 'conflict', server: { id: 'c1', version: 5, deleted: false, data: { name: 'Server' } } }]);
  assert.equal(out.conflicts.length, 0);
  assert.equal(store.get('clients', 'c1').name, 'Second');
  assert.equal(store.queue[0].baseVersion, 5);
});

test('conflict on a delete brings the record back when the server edit was newer', () => {
  store.applyRemote('clients', 'c1', { id: 'c1', name: 'Keep me' }, 2);
  store.remove('clients', 'c1');
  const e = store.queue[0];
  applyPushResults(store, [e], [{ mid: e.mid, status: 'conflict', server: { id: 'c1', version: 3, deleted: false, data: { name: 'Edited elsewhere' } } }]);
  assert.equal(store.get('clients', 'c1').name, 'Edited elsewhere');
});

test('rejected: local copy kept, mutation flagged and not retried', () => {
  const c = store.add('clients', { name: 'Bad' });
  const e = store.queue[0];
  const out = applyPushResults(store, [e], [{ mid: e.mid, status: 'rejected', error: { code: 'validation_failed', message: 'The clients record is not valid.' } }]);
  assert.equal(out.rejected.length, 1);
  assert.equal(store.get('clients', c.id).name, 'Bad');
  assert.equal(store.queue[0].state, 'rejected');
  assert.deepEqual(queueCounts(store.queue), { waiting: 0, rejected: 1 });
  assert.equal(nextBatch(store.queue).length, 0);
  // A new edit queues a new mutation; when it succeeds the old refusal is cleared.
  store.update('clients', c.id, { name: 'Fixed' });
  const fresh = store.queue.find((x) => x.state === 'pending');
  assert.notEqual(fresh.mid, e.mid);
  applyPushResults(store, [fresh], [{ mid: fresh.mid, status: 'ok', version: 1 }]);
  assert.equal(store.queue.length, 0);
});

test('pull: applies changes and tombstones, skips known versions and records with queued edits', () => {
  store.applyRemote('clients', 'known', { id: 'known', name: 'K' }, 7);
  store.applyRemote('clients', 'gone', { id: 'gone', name: 'G' }, 1);
  store.applyRemote('clients', 'mine', { id: 'mine', name: 'M' }, 1);
  store.update('clients', 'mine', { name: 'My edit' });
  const res = applyPullPage(store, [
    { collection: 'clients', id: 'new', version: 1, deleted: false, data: { id: 'new', version: 1, name: 'New' } },
    { collection: 'clients', id: 'known', version: 7, deleted: false, data: { id: 'known', name: 'Stale echo' } },
    { collection: 'clients', id: 'gone', version: 2, deleted: true, data: null },
    { collection: 'clients', id: 'mine', version: 2, deleted: false, data: { id: 'mine', name: 'Theirs' } },
    { collection: 'nope', id: 'x', version: 1, deleted: false, data: {} },
  ]);
  assert.deepEqual(res, { applied: 2, skipped: 3 });
  assert.equal(store.get('clients', 'new').name, 'New');
  assert.equal(store.get('clients', 'new').version, undefined);
  assert.equal(store.get('clients', 'known').name, 'K');
  assert.equal(store.get('clients', 'gone'), null);
  assert.equal(store.get('clients', 'mine').name, 'My edit');
  assert.equal(store.version('clients', 'mine'), 1, 'version untouched while an edit is queued');
  assert.equal(store.queue.length, 1, 'pulled changes are never queued');
});

test('a settings edit made on defaults is re-based on the company settings, numbers only go up', () => {
  store.nextNumber('job'); // defaults: J-1001, queued as nextNumbers
  store.saveSettings({ markupPct: 30 });
  assert.equal(store.queue.length, 1);
  applyPullPage(store, [{ collection: 'settings', id: 'settings', version: 9, deleted: false,
    data: { id: 'settings', version: 9, company: { name: 'Real Co' }, markupPct: 15, nextNumbers: { job: 1050, estimate: 2001, invoice: 3001 } } }]);
  const s = store.settings();
  assert.equal(s.company.name, 'Real Co', 'server fields kept, not the local defaults');
  assert.equal(s.markupPct, 30, 'the local edit kept');
  assert.equal(s.nextNumbers.job, 1050, 'document numbers never go backwards');
  assert.equal(store.queue[0].baseVersion, 9);
  assert.equal(store.queue[0].data.company.name, 'Real Co');
});

test('engine: pulls before the first push, then pushes with mids; offline then back', async () => {
  const timers = manualTimers();
  let online = true;
  const api = fakeApi({ pages: [{ changes: [{ collection: 'clients', id: 'srv', version: 3, deleted: false, data: { name: 'From server' } }], cursor: '42', more: false }] });
  const statuses = [];
  const sync = createSync({ store, api, timers, isOnline: () => online, isVisible: () => true, newMid: mid, onStatus: (s) => statuses.push(s) });
  store.add('clients', { name: 'Typed offline' }); // before start: tracked by the test tracker
  await sync.start();
  const order = api.calls.map((c) => `${c[0]} ${c[1].split('?')[0]}`);
  assert.deepEqual(order, ['GET /api/v1/sync/pull', 'POST /api/v1/sync/push']);
  assert.equal(store.get('clients', 'srv').name, 'From server');
  assert.equal(store.meta('cursor'), '42');
  assert.equal(api.calls[1][2].mutations[0].data.name, 'Typed offline');
  assert.equal(store.queue.length, 0);
  assert.equal(sync.status().state, 'synced');

  // Offline: the change waits; status says how many.
  online = false;
  store.add('clients', { name: 'While offline' });
  await sync.syncNow();
  assert.deepEqual([sync.status().state, sync.status().waiting], ['offline', 1]);
  online = true;
  await sync.syncNow();
  assert.equal(sync.status().state, 'synced');
  assert.equal(store.queue.length, 0);
  assert.ok(statuses.some((s) => s.state === 'syncing'));
  sync.stop();
});

test('engine: a lost response is retried with the same mid (idempotent)', async () => {
  const timers = manualTimers();
  const api = fakeApi();
  const sync = createSync({ store, api, timers, isOnline: () => true, isVisible: () => true, newMid: mid });
  await sync.start();
  store.add('clients', { name: 'Once' });
  api.fail = Object.assign(new Error('network'), { status: 0, code: 'offline' });
  await sync.syncNow();
  assert.equal(sync.status().state, 'offline');
  assert.ok(timers.pending.some((t) => t.ms <= BACKOFF_MS[0]), 'a retry is planned');
  const firstMid = api.calls.at(-1)[2].mutations[0].mid;
  assert.equal(store.queue[0].sent, true);
  store.update('clients', store.queue[0].id, { name: 'Edited after' }); // must not change the sent mutation
  assert.equal(store.queue.length, 2);
  api.fail = null;
  await sync.syncNow();
  const pushes = api.calls.filter((c) => c[0] === 'POST');
  assert.equal(pushes.at(-2)[2].mutations[0].mid, firstMid, 'same mid resent');
  assert.equal(pushes.at(-2)[2].mutations[0].data.name, 'Once');
  assert.equal(pushes.at(-1)[2].mutations[0].baseVersion, 1, 'the next edit pushes against the new version');
  assert.equal(store.queue.length, 0);
  sync.stop();
});

test('engine: conflicts are reported; an ended session stops sync and asks to sign in', async () => {
  const conflicts = [];
  let authErr = null;
  store.applyRemote('clients', 'c1', { id: 'c1', name: 'Old' }, 1);
  const api = fakeApi({ push: (muts) => muts.map((m) => ({ mid: m.mid, status: 'conflict', server: { id: m.id, version: 2, deleted: false, data: { name: 'Newer elsewhere' } } })) });
  const sync = createSync({ store, api, timers: manualTimers(), isOnline: () => true, newMid: mid, onConflicts: (c) => conflicts.push(...c), onAuthError: (e) => { authErr = e; } });
  await sync.start();
  store.update('clients', 'c1', { name: 'Mine' });
  await sync.syncNow();
  assert.equal(conflicts.length, 1);
  assert.equal(store.get('clients', 'c1').name, 'Newer elsewhere');
  api.pages.push(null);
  api.get = async () => { throw Object.assign(new Error('Your session has expired.'), { status: 401, code: 'session_expired' }); };
  await sync.syncNow();
  assert.equal(authErr?.code, 'session_expired');
  assert.equal(sync.status().state, 'error');
  sync.stop();
});

test('engine: retry sends a refused change again under a new mid; discard takes the server copy', async () => {
  let refuse = true;
  const api = fakeApi({ push: (muts) => muts.map((m) => (refuse ? { mid: m.mid, status: 'rejected', error: { code: 'forbidden', message: 'No.' } } : { mid: m.mid, status: 'ok', version: 2 })) });
  const sync = createSync({ store, api, timers: manualTimers(), isOnline: () => true, newMid: mid });
  await sync.start();
  store.applyRemote('clients', 'c1', { id: 'c1', name: 'Server' }, 1);
  store.update('clients', 'c1', { name: 'Refused' });
  await sync.syncNow();
  const bad = store.queue[0];
  assert.equal(bad.state, 'rejected');
  refuse = false;
  await sync.retry(bad.mid);
  assert.equal(store.queue.length, 0);
  assert.notEqual(api.calls.filter((c) => c[0] === 'POST').at(-1)[2].mutations[0].mid, bad.mid);

  refuse = true;
  store.update('clients', 'c1', { name: 'Refused again' });
  await sync.syncNow();
  api.onGet = async () => ({ id: 'c1', version: 4, name: 'Server truth' });
  await sync.discard(store.queue[0].mid);
  assert.equal(store.get('clients', 'c1').name, 'Server truth');
  assert.equal(store.version('clients', 'c1'), 4);
  assert.equal(store.queue.length, 0);
  sync.stop();
});
