// A tiny device-local blob store (IndexedDB), for data too big to live in a synced record — today
// just walkthrough videos. The record keeps a small reference (localId); the bytes stay on this
// device until a server blob store is added. Everything is wrapped so a blocked/absent IndexedDB
// (private windows, old WebViews) degrades to "no video stored" rather than throwing.
//
// Pure of any import-time side effects: opening the DB happens on first use, never at load.

const DB = 'fishtape-blobs';
const STORE = 'blobs';
let dbp = null;

export function blobsSupported() {
  return typeof indexedDB !== 'undefined';
}

function open() {
  if (!blobsSupported()) return Promise.reject(new Error('no-indexeddb'));
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexeddb-open'));
  }).catch((e) => { dbp = null; throw e; });
  return dbp;
}

function tx(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let out;
    Promise.resolve(fn(store)).then((v) => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error || new Error('indexeddb-tx'));
    t.onabort = () => reject(t.error || new Error('indexeddb-abort'));
  }));
}

const newLocalId = () => `blob-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Store a Blob; resolves to its localId. Rejects if IndexedDB is unavailable. */
export async function putBlob(blob, id = newLocalId()) {
  await tx('readwrite', (store) => store.put(blob, id));
  return id;
}

/** Fetch a Blob by localId, or null if it isn't here (another device, cleared storage, …). */
export async function getBlob(id) {
  if (!id) return null;
  try {
    return (await tx('readonly', (store) => new Promise((res) => { const r = store.get(id); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); }))) || null;
  } catch { return null; }
}

/** Best-effort delete; never throws. */
export async function deleteBlob(id) {
  if (!id) return;
  try { await tx('readwrite', (store) => store.delete(id)); } catch { /* already gone / unavailable */ }
}

/** An object URL for a stored blob (caller revokes it), or null. */
export async function blobUrl(id) {
  const b = await getBlob(id);
  return b ? URL.createObjectURL(b) : null;
}
