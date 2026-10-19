// Offline-first sync with the API (docs/architecture/adr-002-sync-protocol.md).
//
// Every local add/update/remove becomes a mutation in a queue that lives in IndexedDB with
// the records (store.js). The engine pulls the company's changes by cursor, then pushes the
// queue in batches with client mutation ids (mids), so a retried push is never applied twice.
// Conflicts are last-writer-wins per record on the server; when the server copy wins, the
// device takes it and the app says "Updated from another device".
//
// The queue logic (enqueue, nextBatch, applyPushResults, applyPullPage) is pure and DOM-free
// so tests can run it in Node; createSync() adds timers and browser events.
import { COLLECTIONS, cleanRecord, uid } from './store.js';

export const BATCH_MAX = 200;
/** Rough byte budget per push. One bigger record (a drawing) still goes alone. */
export const BATCH_BYTES = 4 * 1024 * 1024;
export const PULL_LIMIT = 500;
export const POLL_MS = 30_000;
/** Retry delays after failures; the last one repeats. */
export const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
/** Pause after a local change before pushing, so a burst of edits goes in one request. */
export const PUSH_DELAY_MS = 1_500;

const AUDIT = 'auditLog';
const same = (e, coll, id) => e.collection === coll && e.id === id;
const nextSeq = (q) => q.reduce((m, e) => Math.max(m, e.seq || 0), 0) + 1;
const unionFields = (a, b) => (a == null || b == null ? null : [...new Set([...a, ...b])]);

/** Errors that mean "sign in again" rather than "try later". */
export const AUTH_ERRORS = new Set(['unauthenticated', 'session_expired', 'session_revoked', 'mfa_required', 'mfa_enrolment_required', 'no_tenant', 'tenant_inactive', 'membership_inactive']);

/**
 * Queue a local change. Coalesces into the record's last unsent mutation so a burst of edits
 * is one mutation; a record created and deleted before it ever reached the server leaves
 * nothing behind. Routine auditLog entries never get here (store.js only reports client events).
 * @param {typeof import('./store.js').store} store
 * @param {{ op: 'upsert'|'delete', coll: string, id: string, record: object|null, fields: string[]|null }} change
 */
export function enqueue(store, change, { newMid = uid, now = () => new Date().toISOString() } = {}) {
  const { op, coll, id, record, fields } = change;
  const q = store.queue;
  const at = now();
  if (coll === AUDIT) {
    // A device-only event (an export, a local sign-in): appended, never merged.
    store.putQueue({ mid: newMid(), seq: nextSeq(q), collection: coll, id, op: 'upsert', baseVersion: null, data: record, fields: null, at, sent: false, state: 'pending' });
    return;
  }
  const mine = q.filter((e) => same(e, coll, id) && e.state !== 'rejected');
  const last = mine[mine.length - 1];
  if (last && !last.sent) {
    if (op === 'delete') {
      if (last.op === 'upsert' && last.baseVersion == null && mine.length === 1 && store.version(coll, id) == null) {
        store.dropQueue(last.mid); // never reached the server: nothing to delete there
        return;
      }
      Object.assign(last, { op: 'delete', data: null, fields: null, at });
    } else {
      const merged = last.op === 'upsert' ? unionFields(last.fields, fields ?? null) : null;
      Object.assign(last, { op: 'upsert', data: record, fields: merged, at });
    }
    store.putQueue(last);
    return;
  }
  store.putQueue({
    mid: newMid(), seq: nextSeq(q), collection: coll, id, op,
    // The server version this device last saw; for a record behind an in-flight push it is
    // corrected when that push's result comes back (applyPushResults).
    baseVersion: store.version(coll, id),
    data: op === 'delete' ? null : record, fields: op === 'delete' ? null : (fields ?? null),
    at, sent: false, state: 'pending',
  });
}

/** The wire shape of a queued mutation (POST /api/v1/sync/push). */
export function toWire(e) {
  const m = { mid: e.mid, collection: e.collection, id: e.id, op: e.op, baseVersion: e.baseVersion ?? null };
  // Deletes carry their edit time so last-writer-wins can compare it.
  m.data = e.op === 'upsert' ? e.data : { deletedAt: e.at };
  return m;
}

const approxBytes = (e) => {
  try { return e.data ? JSON.stringify(e.data).length : 64; } catch { return 64; }
};

/**
 * The next push batch, oldest first: at most `max` mutations and about `maxBytes`, rejected
 * ones skipped, and at most one mutation per record (the next one needs this one's version).
 */
export function nextBatch(queue, { max = BATCH_MAX, maxBytes = BATCH_BYTES } = {}) {
  const out = [];
  const seen = new Set();
  let bytes = 0;
  for (const e of queue) {
    if (e.state === 'rejected') continue;
    const k = e.collection + ':' + e.id;
    if (e.collection !== AUDIT && seen.has(k)) break;
    const size = approxBytes(e);
    if (out.length && (out.length >= max || bytes + size > maxBytes)) break;
    out.push(e);
    seen.add(k);
    bytes += size;
  }
  return out;
}

/**
 * Apply push results to the queue and the store.
 * ok: drop the mutation, remember the new version (and give it to later edits of the record).
 * conflict: the server copy won; take it unless newer local edits are still queued.
 * rejected: keep the local copy, flag the mutation and stop retrying it.
 * @returns {{ matched: number, conflicts: { collection: string, id: string, deleted: boolean }[], rejected: object[] }}
 */
export function applyPushResults(store, batch, results) {
  const byMid = new Map((results || []).filter((r) => r && r.mid).map((r) => [r.mid, r]));
  const out = { matched: 0, conflicts: [], rejected: [] };
  for (const e of batch) {
    const r = byMid.get(e.mid);
    if (!r) continue;
    out.matched++;
    const later = () => store.queue.filter((x) => x !== e && same(x, e.collection, e.id) && x.state !== 'rejected');
    if (e.collection === AUDIT) { store.dropQueue(e.mid); continue; } // client events: done either way
    if (r.status === 'ok') {
      store.dropQueue(e.mid);
      const v = r.version ?? null;
      store.setVersion(e.collection, e.id, v);
      for (const x of later()) if (!x.sent) { x.baseVersion = v; store.putQueue(x); }
      // An older edit of this record that the server refused is moot now.
      for (const x of store.queue.filter((x) => x.state === 'rejected' && same(x, e.collection, e.id) && x.seq < e.seq)) store.dropQueue(x.mid);
    } else if (r.status === 'conflict') {
      store.dropQueue(e.mid);
      const s = r.server || {};
      const rest = later();
      if (rest.length) {
        // Newer local edits are queued: keep them on screen; they push against the winner's version.
        store.setVersion(e.collection, e.id, s.version ?? null);
        for (const x of rest) if (!x.sent) { x.baseVersion = s.version ?? null; store.putQueue(x); }
      } else {
        store.applyRemote(e.collection, e.id, s.deleted ? null : (s.data || null), s.version ?? null);
        out.conflicts.push({ collection: e.collection, id: e.id, deleted: Boolean(s.deleted) });
      }
    } else {
      Object.assign(e, { state: 'rejected', error: { code: r.error?.code || 'rejected', message: r.error?.message || 'The server refused this change.' } });
      store.putQueue(e);
      out.rejected.push(e);
    }
  }
  return out;
}

/**
 * Settings are one record with a fixed id. A local settings edit made on top of older (or
 * default) settings is re-based on the server copy field by field, so it never drags stale
 * defaults over the company's real settings. Document numbers only move forward.
 */
function rebaseSettings(store, change, mine) {
  const open = mine.filter((x) => !x.sent && x.state === 'pending' && x.op === 'upsert');
  if (!open.length || open.some((x) => !x.fields)) return false;
  if (open.every((x) => x.baseVersion != null && x.baseVersion >= change.version)) return false;
  const fields = [...new Set(open.flatMap((x) => x.fields))];
  const server = cleanRecord(change.data);
  const local = store.get('settings', 'settings') || {};
  const merged = { ...server, id: 'settings' };
  for (const f of fields) if (f in local) merged[f] = local[f];
  if (fields.includes('nextNumbers')) {
    const a = server.nextNumbers || {}, b = local.nextNumbers || {};
    merged.nextNumbers = { ...a };
    for (const k of Object.keys(b)) merged.nextNumbers[k] = Math.max(Number(a[k]) || 0, Number(b[k]) || 0);
  }
  merged.updatedAt = local.updatedAt || server.updatedAt;
  store.applyRemote('settings', 'settings', merged, change.version);
  for (const x of open) { x.data = store.get('settings', 'settings'); x.baseVersion = change.version; store.putQueue(x); }
  return true;
}

/**
 * Apply one pull page. Records with queued local changes are left alone (the push decides,
 * by last writer wins); records this device already has at that version are skipped;
 * tombstones delete.
 * @returns {{ applied: number, skipped: number }}
 */
export function applyPullPage(store, changes) {
  let applied = 0, skipped = 0;
  for (const c of changes || []) {
    if (!c || !COLLECTIONS.includes(c.collection) || c.collection === AUDIT || typeof c.id !== 'string') { skipped++; continue; }
    const mine = store.queue.filter((x) => same(x, c.collection, c.id));
    if (mine.length) {
      if (c.collection === 'settings' && !c.deleted && c.data && rebaseSettings(store, c, mine)) applied++;
      else skipped++;
      continue;
    }
    const known = store.version(c.collection, c.id);
    if (known != null && c.version != null && known >= c.version) { skipped++; continue; }
    store.applyRemote(c.collection, c.id, c.deleted ? null : (c.data || null), c.version ?? null);
    applied++;
  }
  return { applied, skipped };
}

/** Record changes waiting to sync, and refused ones (client audit events are not counted). */
export function queueCounts(queue) {
  let waiting = 0, rejected = 0;
  for (const e of queue) {
    if (e.collection === AUDIT) continue;
    if (e.state === 'rejected') rejected++; else waiting++;
  }
  return { waiting, rejected };
}

/**
 * The sync engine.
 * @param {object} o
 * @param {typeof import('./store.js').store} o.store
 * @param {{ get: (path: string) => Promise<any>, post: (path: string, body: any) => Promise<any> }} o.api
 * @param {(status: object) => void} [o.onStatus]
 * @param {(conflicts: object[]) => void} [o.onConflicts]
 * @param {(err: Error) => void} [o.onAuthError] the session ended or needs MFA: sign in again
 * @param {() => void} [o.onSynced] after every cycle that reached the server
 */
export function createSync({
  store, api, onStatus = () => {}, onConflicts = () => {}, onRejected = () => {}, onAuthError = () => {}, onSynced = () => {},
  timers = globalThis, isOnline = () => globalThis.navigator?.onLine !== false,
  isVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  newMid = uid,
} = {}) {
  let running = null;
  let again = false;
  let stopped = true;
  let timer = null;
  let timerAt = 0;
  let failures = 0;
  let offline = false;
  let lastError = null;
  let lastSyncAt = store.meta('lastSyncAt') || null;
  let busy = false;
  let checking = true; // until the first cycle of this run has an answer
  const off = [];

  function snapshot() {
    const { waiting, rejected } = queueCounts(store.queue);
    let state = 'synced';
    if (busy || (checking && !offline && !lastError)) state = 'syncing';
    else if (offline) state = 'offline';
    else if (lastError) state = 'error';
    return { state, waiting, rejected, lastSyncAt, error: lastError ? { code: lastError.code, message: lastError.message } : null, pulledOnce: Boolean(store.meta('pulledOnce')) };
  }
  const publish = () => { try { onStatus(snapshot()); } catch (e) { console.error(e); } };

  function schedule(ms) {
    if (stopped) return;
    const at = Date.now() + ms;
    if (timer && timerAt <= at) return; // something sooner is already planned
    if (timer) timers.clearTimeout(timer);
    timerAt = at;
    timer = timers.setTimeout(() => { timer = null; cycle(); }, ms);
  }

  async function pullAll() {
    let since = store.meta('cursor') ?? '0';
    for (let page = 0; page < 10_000; page++) {
      const res = await api.get(`/api/v1/sync/pull?since=${encodeURIComponent(since)}&limit=${PULL_LIMIT}`);
      applyPullPage(store, res?.changes);
      if (res?.cursor != null) since = String(res.cursor);
      store.setMeta('cursor', since);
      if (!res?.more) break;
    }
    if (!store.meta('pulledOnce')) store.setMeta('pulledOnce', true);
    await store.flush();
  }

  async function pushAll() {
    if (!store.meta('pulledOnce')) return; // adr-002: pull before the first push on a device
    let max = BATCH_MAX;
    for (let round = 0; round < 10_000; round++) {
      const batch = nextBatch(store.queue, { max });
      if (!batch.length) return;
      if (!busy) { busy = true; publish(); }
      for (const e of batch) if (!e.sent) { e.sent = true; store.putQueue(e); }
      await store.flush(); // durable before sending: a retry after a crash reuses the same mids
      let res;
      try {
        res = await api.post('/api/v1/sync/push', { mutations: batch.map(toWire) });
      } catch (err) {
        if (err?.status === 413 && batch.length > 1) { max = Math.max(1, Math.floor(batch.length / 2)); continue; }
        if (err?.status === 413) {
          applyPushResults(store, batch, [{ mid: batch[0].mid, status: 'rejected', error: { code: 'too_large', message: 'This record is too large to sync.' } }]);
          continue;
        }
        throw err;
      }
      const out = applyPushResults(store, batch, res?.results);
      await store.flush();
      if (out.conflicts.length) onConflicts(out.conflicts);
      if (out.rejected.length) onRejected(out.rejected);
      if (!out.matched) return; // nothing resolved: try again on the next cycle, not in a tight loop
    }
  }

  function handleError(err) {
    const code = err?.code || 'error';
    if (AUTH_ERRORS.has(code) || err?.status === 401) {
      lastError = err; offline = false; stopped = true;
      try { onAuthError(err); } catch (e) { console.error(e); }
      return;
    }
    failures++;
    const transient = code === 'offline' || code === 'no_api' || err?.status === 0 || err?.status >= 500 || err?.status === 429;
    offline = code === 'offline' || code === 'no_api' || err?.status === 0 || err?.status === 502 || err?.status === 503 || err?.status === 504;
    lastError = offline ? null : err;
    let delay = BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)];
    if (err?.status === 429) delay = Math.max(delay, 30_000);
    if (!transient) delay = Math.max(delay, 60_000);
    schedule(delay);
  }

  async function run() {
    if (!isOnline()) { offline = true; checking = false; publish(); return; }
    const { waiting } = queueCounts(store.queue);
    busy = waiting > 0 || !store.meta('pulledOnce');
    publish();
    try {
      await pullAll();
      await pushAll();
      failures = 0; offline = false; lastError = null;
      lastSyncAt = new Date().toISOString();
      store.setMeta('lastSyncAt', lastSyncAt);
      if (isVisible()) schedule(POLL_MS);
      checking = false;
      try { onSynced(); } catch (e) { console.error(e); }
    } catch (err) {
      checking = false;
      handleError(err);
    } finally {
      busy = false;
      publish();
    }
  }

  /** One sync cycle (pull, then push). Calls during a cycle run once more afterwards. */
  function cycle() {
    if (stopped) return Promise.resolve();
    if (running) { again = true; return running; }
    running = run().finally(() => {
      running = null;
      if (again && !stopped) { again = false; return cycle(); }
      return undefined;
    });
    return running;
  }

  const listen = (target, ev, fn) => { target.addEventListener(ev, fn); off.push(() => target.removeEventListener(ev, fn)); };

  return {
    /** Start: track local writes, pull now, then every 30 s while visible, on focus and when back online. */
    start() {
      if (!stopped) return cycle();
      stopped = false;
      store.track((change) => {
        enqueue(store, change, { newMid });
        publish();
        if (isOnline()) schedule(PUSH_DELAY_MS);
      });
      if (typeof document !== 'undefined' && typeof addEventListener === 'function') {
        listen(document, 'visibilitychange', () => { if (isVisible()) cycle(); });
        listen(globalThis, 'focus', () => cycle());
        listen(globalThis, 'online', () => { failures = 0; cycle(); });
        listen(globalThis, 'offline', () => { offline = true; publish(); });
      }
      publish();
      return cycle();
    },
    stop() {
      stopped = true;
      store.track(null);
      if (timer) timers.clearTimeout(timer);
      timer = null;
      while (off.length) off.pop()();
    },
    /** Sync now (the "Sync now" / "Retry" buttons). Resolves when the cycle is done. */
    syncNow() { failures = 0; return cycle(); },
    status: snapshot,
    get running() { return Boolean(running); },
    /** Try a refused change again as a new mutation (the old mid's answer is stored on the server). */
    retry(mid) {
      const e = store.queue.find((x) => x.mid === mid && x.state === 'rejected');
      if (!e) return false;
      store.dropQueue(mid);
      const rec = store.get(e.collection, e.id);
      enqueue(store, rec ? { op: 'upsert', coll: e.collection, id: e.id, record: rec, fields: null } : { op: 'delete', coll: e.collection, id: e.id, record: null, fields: null }, { newMid });
      publish();
      return cycle();
    },
    /** Drop a refused change and take the server's copy of the record. */
    async discard(mid) {
      const e = store.queue.find((x) => x.mid === mid && x.state === 'rejected');
      if (!e) return false;
      let server = null;
      try {
        server = await api.get(`/api/v1/${encodeURIComponent(e.collection)}/${encodeURIComponent(e.id)}`);
      } catch (err) {
        if (err?.status !== 404) throw err;
      }
      store.dropQueue(mid);
      if (!store.queue.some((x) => same(x, e.collection, e.id))) {
        store.applyRemote(e.collection, e.id, server, server?.version ?? null);
      }
      await store.flush();
      publish();
      return true;
    },
  };
}
