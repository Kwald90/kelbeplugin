// Local-first data layer. Every record lives in memory and is persisted to
// IndexedDB. The function signatures match what a remote (e.g. Supabase) data
// layer would expose, so screens never touch storage directly.
import { BRAND } from './brand.js';

export const isBackupTag = (tag) => tag === BRAND.backupTag || BRAND.legacyBackupTags.includes(tag);

const DB_NAME = 'kelbe-circuit';
const DB_VERSION = 1;
const OS = 'records';
const SILENT = new Set(['auditLog']); // collections that are not themselves audited

export const COLLECTIONS = [
  'clients', 'leads', 'sequences', 'enrolments', 'outbox', 'jobs', 'schedule',
  'estimates', 'invoices', 'payments', 'items', 'locations', 'stockMoves',
  'employees', 'timeEntries', 'drawings', 'sops', 'permits', 'inspections',
  'certifications', 'checklists', 'panels', 'auditLog', 'settings',
  'wireRuns', 'bends', 'benderProfiles',
];

export const DEFAULT_SETTINGS = {
  id: 'settings',
  company: { name: 'Kelbe Electric', phone: '', email: '', address: '', licenceNo: '' },
  taxPct: 8,
  labourRateCents: 9500,
  markupPct: 20,
  units: 'imperial',
  currency: 'USD',
  nextNumbers: { job: 1001, estimate: 2001, invoice: 3001 },
};

const data = new Map(COLLECTIONS.map((c) => [c, new Map()]));
const listeners = new Map();
let db = null;
let actorId = null;
let persistent = false;

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

const clone = (v) => (v === undefined ? v : structuredClone(v));

function bucket(coll) {
  if (!data.has(coll)) data.set(coll, new Map());
  return data.get(coll);
}

function openDB() {
  return new Promise((resolve) => {
    if (!globalThis.indexedDB) return resolve(null);
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch { return resolve(null); }
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(OS)) {
        const os = d.createObjectStore(OS, { keyPath: 'key' });
        os.createIndex('coll', 'coll');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function loadAll() {
  return new Promise((resolve) => {
    if (!db) return resolve();
    const tx = db.transaction(OS, 'readonly');
    const cur = tx.objectStore(OS).openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return;
      const { coll, value } = c.value;
      bucket(coll).set(value.id, value);
      c.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

// Writes are batched per tick so a burst of updates costs one transaction.
let pending = new Map();
let flushTimer = null;
function persist(coll, id, value) {
  if (!db) return;
  pending.set(coll + ':' + id, { coll, id, value });
  if (!flushTimer) flushTimer = setTimeout(flush, 0);
}
function flush() {
  flushTimer = null;
  if (!db || !pending.size) return Promise.resolve();
  const batch = pending;
  pending = new Map();
  return new Promise((resolve) => {
    const tx = db.transaction(OS, 'readwrite');
    const os = tx.objectStore(OS);
    for (const [key, { coll, value }] of batch) {
      if (value === null) os.delete(key);
      else os.put({ key, coll, value });
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => { console.error('store: write failed', tx.error); resolve(); };
  });
}

function emit(coll, type, record) {
  for (const key of [coll, '*']) {
    const set = listeners.get(key);
    if (set) for (const fn of [...set]) { try { fn({ coll, type, record }); } catch (e) { console.error(e); } }
  }
}

function audit(action, coll, record, summary) {
  if (SILENT.has(coll)) return;
  const entry = {
    id: uid(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    at: new Date().toISOString(), userId: actorId, action, collection: coll,
    recordId: record?.id ?? null, summary: summary || describe(record),
  };
  bucket('auditLog').set(entry.id, entry);
  persist('auditLog', entry.id, entry);
}

function describe(r) {
  if (!r) return '';
  return String(r.number || r.name || r.title || r.description || r.id).slice(0, 80);
}

export const store = {
  ready: null,
  get persistent() { return persistent; },
  get offlineOnly() { return !db; },

  async init() {
    db = await openDB();
    await loadAll();
    if (!bucket('settings').has('settings')) {
      const s = { ...clone(DEFAULT_SETTINGS), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      bucket('settings').set('settings', s);
      persist('settings', 'settings', s);
    }
    try { persistent = (await navigator.storage?.persist?.()) || false; } catch { persistent = false; }
  },

  setActor(id) { actorId = id; },
  get actorId() { return actorId; },

  /** All records in a collection, newest first, optionally filtered. Returns copies. */
  list(coll, pred) {
    let rows = [...bucket(coll).values()];
    if (pred) rows = rows.filter(pred);
    rows.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return rows.map(clone);
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
    persist(coll, record.id, record);
    if (!opts.silent) audit('create', coll, record);
    emit(coll, 'add', clone(record));
    return clone(record);
  },

  update(coll, id, patch, opts = {}) {
    const cur = bucket(coll).get(id);
    if (!cur) throw new Error(`store.update: ${coll}/${id} not found`);
    const next = { ...cur, ...clone(patch), id, updatedAt: new Date().toISOString() };
    bucket(coll).set(id, next);
    persist(coll, id, next);
    if (!opts.silent) audit('update', coll, next, opts.summary);
    emit(coll, 'update', clone(next));
    return clone(next);
  },

  remove(coll, id, opts = {}) {
    const cur = bucket(coll).get(id);
    if (!cur) return false;
    bucket(coll).delete(id);
    persist(coll, id, null);
    if (!opts.silent) audit('delete', coll, cur);
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
    audit(action, coll, { id: recordId }, summary);
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

  exportAll() {
    const out = { app: BRAND.backupTag, version: DB_VERSION, exportedAt: new Date().toISOString(), data: {} };
    for (const c of COLLECTIONS) out.data[c] = [...bucket(c).values()].map(clone);
    return out;
  },

  async importAll(dump) {
    if (!dump || !isBackupTag(dump.app) || !dump.data) throw new Error(`Not a ${BRAND.name} backup file`);
    await this.clearAll();
    for (const c of Object.keys(dump.data)) {
      for (const r of dump.data[c]) { bucket(c).set(r.id, r); persist(c, r.id, r); }
    }
    await flush();
    emit('*', 'reset', null);
  },

  async clearAll() {
    for (const c of data.keys()) {
      for (const id of bucket(c).keys()) persist(c, id, null);
      bucket(c).clear();
    }
    await flush();
  },

  flush,
};

store.ready = store.init();
