// Local-first data layer. Every record lives in memory and is persisted to IndexedDB, so
// screens keep a synchronous API (list/get/add/update/remove) and work offline.
//
// One IndexedDB database per scope, so data from different companies never mixes:
//   demo                  'kelbe-circuit' (the local-only demo; the old name keeps existing demo data)
//   company (user, co.)   'fishtape:<userId>:<tenantId>'
// Each database has three object stores: `records` ({ key, coll, value, v } where v is the
// server version), `meta` (sync cursor, cached /me...) and `queue` (the sync mutation queue,
// see sync.js). Local writes are reported to the tracker (sync.js) synchronously; nothing
// here talks to the network.
import { BRAND } from './brand.js';

export const isBackupTag = (tag) => tag === BRAND.backupTag || BRAND.legacyBackupTags.includes(tag);

export const DEMO_DB = 'kelbe-circuit';
const DB_VERSION = 2;
const OS = 'records';
const META = 'meta';
const QUEUE = 'queue';
const SILENT = new Set(['auditLog']); // collections that are not themselves audited
/**
 * Server bookkeeping in records that come from the API. `version` there is the row version
 * (kept in `versions`), not a record field. SOPs keep their document revision in `revision`.
 */
const SERVER_KEYS = ['version', 'changeSeq', 'deleted', 'tenantId'];

export const COLLECTIONS = [
  'clients', 'leads', 'sequences', 'enrolments', 'outbox', 'jobs', 'schedule',
  'estimates', 'invoices', 'payments', 'items', 'locations', 'stockMoves',
  'employees', 'timeEntries', 'drawings', 'sops', 'permits', 'inspections',
  'certifications', 'checklists', 'panels', 'auditLog', 'settings',
  'wireRuns', 'bends', 'benderProfiles',
  'flhas', 'toolboxTalks', 'incidents', 'correctiveActions', 'safetyInspections', 'siteOrientations', 'jobSafety',
  'workPlans', 'workTasks', 'taskTemplates', 'huddles',
];

export const DEFAULT_SETTINGS = {
  id: 'settings',
  // province drives the code book's amendments, the permit authority and sales tax.
  company: { name: 'Your company', phone: '', email: '', address: '', licenceNo: '', province: 'ON', gstHstNo: '', pstNo: '' },
  codeBook: 'CEC-2024', // 'CEC-2024' | 'NEC-2023'
  // tax.mode 'province' uses js/lib/tax.js rates for company.province with a treatment
  // preset; 'custom' uses tax.custom [{ label, pct, applies: { material, labour, other } }].
  tax: { mode: 'province', treatment: null, custom: [] },
  taxPct: 13, // legacy single rate (combined), kept for records and readers from before tax.js
  labourRateCents: 9500,
  markupPct: 20,
  units: 'metric', // company default; each user can switch (js/lib/units.js)
  currency: 'CAD',
  nextNumbers: { job: 1001, estimate: 2001, invoice: 3001 },
};

/**
 * IndexedDB name for a scope. Ids are UUIDs (no names or emails), so the name reveals nothing.
 * @param {{ kind: 'demo' } | { kind: 'company', userId: string, tenantId: string }} scope
 */
export function dbNameFor(scope) {
  if (!scope || scope.kind === 'demo') return DEMO_DB;
  const safe = (s) => String(s).replace(/[^A-Za-z0-9-]/g, '');
  if (!scope.userId || !scope.tenantId) throw new Error('A company scope needs userId and tenantId');
  return `fishtape:${safe(scope.userId)}:${safe(scope.tenantId)}`;
}

/** Prefix of every company database of one user (for wiping them all at sign-out). */
export const userDbPrefix = (userId) => `fishtape:${String(userId).replace(/[^A-Za-z0-9-]/g, '')}:`;

/** A record from the server as stored locally: server bookkeeping keys removed. */
export function cleanRecord(r) {
  if (!r || typeof r !== 'object') return r;
  const out = { ...r };
  for (const k of SERVER_KEYS) delete out[k];
  return out;
}

const data = new Map(COLLECTIONS.map((c) => [c, new Map()]));
const versions = new Map(); // 'coll:id' -> server version
const metaCache = new Map();
const listeners = new Map();
let queue = []; // mutation queue entries, oldest first (sync.js owns the logic)
let db = null;
let dbName = null;
let scope = null;
let actorId = null;
let persistent = false;
let tracker = null;

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

const clone = (v) => (v === undefined ? v : structuredClone(v));
const keyOf = (coll, id) => coll + ':' + id;

function bucket(coll) {
  if (!data.has(coll)) data.set(coll, new Map());
  return data.get(coll);
}

function openDB(name) {
  return new Promise((resolve) => {
    if (!globalThis.indexedDB) return resolve(null);
    let req;
    try { req = indexedDB.open(name, DB_VERSION); } catch { return resolve(null); }
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(OS)) {
        const os = d.createObjectStore(OS, { keyPath: 'key' });
        os.createIndex('coll', 'coll');
      }
      if (!d.objectStoreNames.contains(META)) d.createObjectStore(META, { keyPath: 'key' });
      if (!d.objectStoreNames.contains(QUEUE)) d.createObjectStore(QUEUE, { keyPath: 'mid' });
    };
    req.onsuccess = () => {
      const d = req.result;
      // Another tab upgrading or deleting this database: let go of it.
      d.onversionchange = () => { try { d.close(); } catch { /* ignore */ } };
      resolve(d);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function readAll(storeName, each) {
  return new Promise((resolve) => {
    if (!db || !db.objectStoreNames.contains(storeName)) return resolve();
    const tx = db.transaction(storeName, 'readonly');
    const cur = tx.objectStore(storeName).openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return;
      each(c.value);
      c.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function loadAll() {
  await readAll(OS, ({ coll, value, v }) => {
    bucket(coll).set(value.id, value);
    if (v != null) versions.set(keyOf(coll, value.id), v);
  });
  await readAll(META, ({ key, value }) => metaCache.set(key, value));
  const q = [];
  await readAll(QUEUE, (e) => q.push(e));
  queue = q.sort((a, b) => a.seq - b.seq);
  if (scope?.kind === 'demo') upgradeDemoRecords();
}

// SOPs kept their document revision in `version` before sync. The server owns `version` (its
// row counter), so the field is `revision` now. Only the local demo can hold the old shape.
function upgradeDemoRecords() {
  for (const s of bucket('sops').values()) {
    if (s.revision == null && Number.isInteger(s.version)) {
      s.revision = s.version;
      delete s.version;
      persist('sops', s.id);
    }
  }
}

// Writes are batched per tick so a burst of updates costs one transaction.
let pending = new Map();
let pendingMeta = new Map();
let pendingQueue = new Map();
let flushTimer = null;
function schedule() { if (db && !flushTimer) flushTimer = setTimeout(flush, 0); }
function persist(coll, id) {
  if (!db) return;
  pending.set(keyOf(coll, id), { coll, id });
  schedule();
}
function flush() {
  flushTimer = null;
  if (!db || (!pending.size && !pendingMeta.size && !pendingQueue.size)) return Promise.resolve();
  const recs = pending, metas = pendingMeta, qs = pendingQueue;
  pending = new Map(); pendingMeta = new Map(); pendingQueue = new Map();
  const target = db;
  return new Promise((resolve) => {
    let tx;
    try { tx = target.transaction([OS, META, QUEUE], 'readwrite'); } catch (e) { console.error('store: write failed', e); return resolve(); }
    const os = tx.objectStore(OS), ms = tx.objectStore(META), qs2 = tx.objectStore(QUEUE);
    for (const [key, { coll, id }] of recs) {
      // Read the latest in-memory state at write time, so the last write in a tick wins.
      const value = bucket(coll).get(id);
      if (value === undefined) os.delete(key);
      else os.put({ key, coll, value, v: versions.get(key) ?? null });
    }
    for (const [key, value] of metas) {
      if (value === undefined) ms.delete(key); else ms.put({ key, value });
    }
    for (const [mid, entry] of qs) {
      if (entry === null) qs2.delete(mid); else qs2.put(entry);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => { console.error('store: write failed', tx.error); resolve(); };
  });
}

function emit(coll, type, record, remote = false) {
  for (const key of [coll, '*']) {
    const set = listeners.get(key);
    if (set) for (const fn of [...set]) { try { fn({ coll, type, record, remote }); } catch (e) { console.error(e); } }
  }
}

/** Tell the tracker (sync.js) about a local change. */
function track(change) {
  if (!tracker) return;
  try { tracker(change); } catch (e) { console.error('store: tracker failed', e); }
}

function audit(action, coll, record, summary, clientEvent = false) {
  if (SILENT.has(coll)) return;
  const now = new Date().toISOString();
  const entry = {
    id: uid(), createdAt: now, updatedAt: now,
    at: now, userId: actorId, action, collection: coll,
    recordId: record?.id ?? null, summary: summary || describe(record),
  };
  bucket('auditLog').set(entry.id, entry);
  persist('auditLog', entry.id);
  // Routine create/update/delete entries stay on the device: the server audits those itself.
  if (clientEvent) track({ op: 'upsert', coll: 'auditLog', id: entry.id, record: clone(entry), fields: null });
}

function describe(r) {
  if (!r) return '';
  return String(r.number || r.name || r.title || r.description || r.id).slice(0, 80);
}

function resetMemory() {
  for (const b of data.values()) b.clear();
  versions.clear();
  metaCache.clear();
  queue = [];
  pending = new Map(); pendingMeta = new Map(); pendingQueue = new Map();
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
}

/** Device-only actions worth sending to the server's audit log (adr-002: exports, local sign-ins). */
export const CLIENT_EVENTS = new Set(['export', 'restore', 'print', 'share', 'sign-in', 'sign-in-failed']);

let resolveReady;
export const store = {
  /** Resolves once a database is open (store.open). */
  ready: new Promise((r) => { resolveReady = r; }),
  get persistent() { return persistent; },
  get offlineOnly() { return !db; },
  /** { kind: 'demo' } or { kind: 'company', userId, tenantId }, or null before open(). */
  get scope() { return scope ? { ...scope } : null; },
  get dbName() { return dbName; },
  get synced() { return scope?.kind === 'company'; },

  /** Open the database for a scope (closing the current one first) and load it into memory. */
  async open(next = { kind: 'demo' }) {
    const name = dbNameFor(next);
    await this.close();
    dbName = name;
    scope = next.kind === 'company' ? { kind: 'company', userId: next.userId, tenantId: next.tenantId } : { kind: 'demo' };
    db = await openDB(name);
    await loadAll();
    if (!bucket('settings').has('settings')) {
      // Local defaults so screens and saveSettings work. Not tracked: untouched defaults are
      // never pushed (they would overwrite the company's real settings, adr-002).
      const s = { ...clone(DEFAULT_SETTINGS), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      bucket('settings').set('settings', s);
      persist('settings', 'settings');
    }
    try { persistent = (await globalThis.navigator?.storage?.persist?.()) || false; } catch { persistent = false; }
    resolveReady?.();
    return this;
  },

  /** Write what is pending and close the database; memory is cleared. */
  async close() {
    if (db) { await flush(); try { db.close(); } catch { /* ignore */ } }
    db = null; dbName = null; scope = null;
    resetMemory();
  },

  /** Close and delete this scope's database (sign-out on a personal device). */
  async destroy() {
    const name = dbName;
    await this.close();
    if (name) await deleteDatabase(name);
  },

  setActor(id) { actorId = id; },
  get actorId() { return actorId; },

  /** Register the one tracker (sync.js) that hears every local write. Pass null to stop. */
  track(fn) { tracker = fn; },

  /**
   * All records in a collection, newest first, optionally filtered. Returns copies.
   * `opts.omit` leaves heavy fields out of the copies (a plan set's underlays are megabytes each).
   */
  list(coll, pred, opts) {
    let rows = [...bucket(coll).values()];
    if (pred) rows = rows.filter(pred);
    rows.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    const omit = opts?.omit?.length ? new Set(opts.omit) : null;
    if (!omit) return rows.map(clone);
    return rows.map((r) => {
      const out = {};
      for (const k of Object.keys(r)) if (!omit.has(k)) out[k] = clone(r[k]);
      return out;
    });
  },

  get(coll, id) {
    if (id == null) return null;
    return clone(bucket(coll).get(id)) ?? null;
  },

  count(coll, pred) {
    if (!pred) return bucket(coll).size;
    let n = 0;
    for (const r of bucket(coll).values()) if (pred(r)) n++;
    return n;
  },

  add(coll, fields, opts = {}) {
    const now = new Date().toISOString();
    const record = { ...clone(fields), id: fields.id || uid(), createdAt: fields.createdAt || now, updatedAt: now };
    bucket(coll).set(record.id, record);
    persist(coll, record.id);
    if (!opts.silent) audit('create', coll, record);
    track({ op: 'upsert', coll, id: record.id, record: clone(record), fields: null });
    emit(coll, 'add', clone(record));
    return clone(record);
  },

  update(coll, id, patch, opts = {}) {
    const cur = bucket(coll).get(id);
    if (!cur) throw new Error(`store.update: ${coll}/${id} not found`);
    const next = { ...cur, ...clone(patch), id, updatedAt: new Date().toISOString() };
    bucket(coll).set(id, next);
    persist(coll, id);
    if (!opts.silent) audit('update', coll, next, opts.summary);
    track({ op: 'upsert', coll, id, record: clone(next), fields: Object.keys(patch || {}) });
    emit(coll, 'update', clone(next));
    return clone(next);
  },

  remove(coll, id, opts = {}) {
    const cur = bucket(coll).get(id);
    if (!cur) return false;
    bucket(coll).delete(id);
    persist(coll, id);
    if (!opts.silent) audit('delete', coll, cur);
    track({ op: 'delete', coll, id, record: null, fields: null });
    emit(coll, 'remove', clone(cur));
    return true;
  },

  /** Subscribe to changes in one collection, or '*' for all. Returns an unsubscribe function. */
  on(coll, fn) {
    if (!listeners.has(coll)) listeners.set(coll, new Set());
    listeners.get(coll).add(fn);
    return () => listeners.get(coll)?.delete(fn);
  },

  /** Write a custom audit entry (sign-in, export, permission change...). */
  log(action, summary, coll = 'app', recordId = null) {
    audit(action, coll, { id: recordId }, summary, CLIENT_EVENTS.has(action));
  },

  settings() { return clone(bucket('settings').get('settings')) || clone(DEFAULT_SETTINGS); },
  saveSettings(patch) { return this.update('settings', 'settings', patch, { summary: 'settings' }); },

  /** Reserve the next document number: nextNumber('job') -> 'J-1001'. */
  nextNumber(kind) {
    const prefix = { job: 'J', estimate: 'E', invoice: 'INV' }[kind] || kind.toUpperCase();
    const s = this.settings();
    const n = s.nextNumbers?.[kind] ?? 1;
    this.update('settings', 'settings', { nextNumbers: { ...s.nextNumbers, [kind]: n + 1 } }, { silent: true });
    return `${prefix}-${n}`;
  },

  isEmpty() {
    return COLLECTIONS.every((c) => c === 'settings' || c === 'auditLog' || bucket(c).size === 0);
  },

  // ---- sync support (sync.js) ---------------------------------------------

  /** Last server version this device saw for a record, or null. */
  version(coll, id) { return versions.get(keyOf(coll, id)) ?? null; },

  setVersion(coll, id, v) {
    const k = keyOf(coll, id);
    if (v == null) versions.delete(k); else versions.set(k, v);
    if (bucket(coll).has(id)) persist(coll, id);
  },

  /**
   * Apply a change that came from the server: no tracking, no audit entry. `record` null
   * deletes. Listeners get the event with remote: true, so open screens redraw.
   */
  applyRemote(coll, id, record, v) {
    const k = keyOf(coll, id);
    if (v == null) versions.delete(k); else versions.set(k, v);
    const had = bucket(coll).get(id);
    if (record == null) {
      if (!had) return;
      bucket(coll).delete(id);
      persist(coll, id);
      emit(coll, 'remove', clone(had), true);
      return;
    }
    const value = { ...cleanRecord(clone(record)), id };
    bucket(coll).set(id, value);
    persist(coll, id);
    emit(coll, had ? 'update' : 'add', clone(value), true);
  },

  /** Sync metadata (cursor, cached /me...), persisted with the records. */
  meta(key) { return clone(metaCache.get(key)); },
  setMeta(key, value) {
    if (value === undefined) metaCache.delete(key); else metaCache.set(key, clone(value));
    if (db) { pendingMeta.set(key, value === undefined ? undefined : clone(value)); schedule(); }
  },

  /** The mutation queue (live array; sync.js changes it and calls putQueue/dropQueue). */
  get queue() { return queue; },
  putQueue(entry) {
    if (!queue.includes(entry)) queue.push(entry);
    if (db) { pendingQueue.set(entry.mid, clone(entry)); schedule(); }
  },
  dropQueue(mid) {
    const i = queue.findIndex((e) => e.mid === mid);
    if (i >= 0) queue.splice(i, 1);
    if (db) { pendingQueue.set(mid, null); schedule(); }
  },

  // ---- backup ---------------------------------------------------------------

  exportAll() {
    const out = { app: BRAND.backupTag, version: DB_VERSION, exportedAt: new Date().toISOString(), data: {} };
    for (const c of COLLECTIONS) out.data[c] = [...bucket(c).values()].map(clone);
    return out;
  },

  async importAll(dump) {
    if (this.synced) throw new Error('Restoring a backup only works in the demo. Your company data syncs with the server.');
    if (!dump || !isBackupTag(dump.app) || !dump.data) throw new Error(`Not a ${BRAND.name} backup file`);
    await this.clearAll();
    for (const c of Object.keys(dump.data)) {
      for (const r of dump.data[c]) { bucket(c).set(r.id, r); persist(c, r.id); }
    }
    await flush();
    emit('*', 'reset', null);
  },

  /**
   * Clear every record on this device. For a synced company this means "download again":
   * the sync cursor and versions go too, so the next pull brings everything back. Changes
   * still waiting to sync stay queued.
   */
  async clearAll() {
    for (const c of data.keys()) {
      for (const id of [...bucket(c).keys()]) { bucket(c).delete(id); persist(c, id); }
    }
    versions.clear();
    if (this.synced) { this.setMeta('cursor', undefined); this.setMeta('pulledOnce', undefined); }
    await flush();
  },

  flush,
};

/** Delete one IndexedDB database (resolves even if it was blocked or missing). */
export function deleteDatabase(name) {
  return new Promise((resolve) => {
    if (!globalThis.indexedDB || !name) return resolve(false);
    let req;
    try { req = indexedDB.deleteDatabase(name); } catch { return resolve(false); }
    req.onsuccess = () => resolve(true);
    req.onerror = () => resolve(false);
    req.onblocked = () => resolve(false);
  });
}

/** Names of this user's company databases on this device (empty where the browser cannot list them). */
export async function userDatabases(userId) {
  try {
    const all = (await globalThis.indexedDB?.databases?.()) || [];
    return all.map((d) => d.name).filter((n) => n?.startsWith(userDbPrefix(userId)));
  } catch { return []; }
}
