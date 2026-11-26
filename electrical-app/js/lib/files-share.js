// "Send to Fishtape": files shared into the app from Mail, Messages, Files, Photos or another app.
//
//   PWA (Android Chrome, installed)  manifest.webmanifest share_target POSTs the files to ./share-target;
//                                    the service worker (sw.js) stores them in IndexedDB "fishtape-share"
//                                    and redirects to #/files?shared=1.
//   iOS app                          "Open in Fishtape" / Share → Fishtape: the FishtapeIncomingFiles
//                                    plugin (mobile/ios/App/App/Plugins) copies each file into the app and
//                                    hands it over here (takePending + the filesReceived event).
//   Android app                      ACTION_SEND / SEND_MULTIPLE / VIEW intents, the same plugin name
//                                    (mobile/android/.../FishtapeIncomingFilesPlugin.java).
//
// Whatever the route, the files wait in the same IndexedDB store until the Files screen takes them, so a
// share that arrives before sign-in, or while another screen is open, is not lost. The Files screen then
// opens the Import sheet with a customer/job picker and the AI files them.
import { isNativeApp } from './native.js';

export const SHARE_DB = 'fishtape-share';
export const SHARE_STORE = 'files';
export const SHARE_ROUTE = '#/files?shared=1';
const EVENT = 'ft:files-shared';
/** Shared files kept at most this long if nobody opens Files (the next take() drops older ones). */
export const SHARE_TTL_MS = 7 * 86400_000;

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no-indexeddb')); return; }
    const req = indexedDB.open(SHARE_DB, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(SHARE_STORE)) req.result.createObjectStore(SHARE_STORE, { autoIncrement: true }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexeddb-open'));
  });
}

/** Keep shared files until Files takes them. Entries: { name, type, blob, at, via }. */
export async function stashShared(files, via = 'share') {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const t = db.transaction(SHARE_STORE, 'readwrite');
      const s = t.objectStore(SHARE_STORE);
      for (const f of files) s.add({ name: f.name || 'Shared file', type: f.type || '', blob: f, at: Date.now(), via });
      t.oncomplete = resolve; t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
    });
  } finally { db.close(); }
}

/** Take (and clear) every waiting shared file, as File objects. Never throws. */
export async function takeShared(now = Date.now()) {
  let db;
  try { db = await openDb(); } catch { return []; }
  try {
    return await new Promise((resolve) => {
      const out = [];
      const t = db.transaction(SHARE_STORE, 'readwrite');
      const s = t.objectStore(SHARE_STORE);
      const req = s.openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        const v = c.value;
        if (v?.blob && now - (v.at || 0) < SHARE_TTL_MS) {
          out.push(v.blob instanceof File ? v.blob : new File([v.blob], v.name || 'Shared file', { type: v.type || v.blob.type || '' }));
        }
        c.delete();
        c.continue();
      };
      t.oncomplete = () => resolve(out);
      t.onerror = () => resolve(out);
    });
  } catch { return []; } finally { db.close(); }
}

/** How many shared files are waiting (for a banner), without taking them. */
export async function countShared() {
  let db;
  try { db = await openDb(); } catch { return 0; }
  try {
    return await new Promise((resolve) => {
      const r = db.transaction(SHARE_STORE, 'readonly').objectStore(SHARE_STORE).count();
      r.onsuccess = () => resolve(r.result || 0); r.onerror = () => resolve(0);
    });
  } finally { db.close(); }
}

/** base64 (no data: prefix) -> File */
export function base64ToFile(data, name, type) {
  const bin = atob(String(data || ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name || 'Shared file', { type: type || '' });
}

/** Native plugin items -> Files. Items over the size cap arrive without data and are reported. */
export function nativeItemsToFiles(items = []) {
  const files = [], skipped = [];
  for (const it of items) {
    if (!it || !it.data) { skipped.push({ name: it?.name || 'file', reason: it?.error || 'too large or unreadable' }); continue; }
    try { files.push(base64ToFile(it.data, it.name, it.mimeType)); } catch { skipped.push({ name: it.name || 'file', reason: 'unreadable' }); }
  }
  return { files, skipped };
}

/** Tell an open Files screen that shared files are waiting (it opens the Import sheet). */
function announce(n) {
  try { globalThis.dispatchEvent?.(new CustomEvent(EVENT, { detail: { count: n } })); } catch { /* no DOM */ }
}
export function onShared(fn) {
  const h = (e) => fn(e?.detail?.count || 0);
  try { globalThis.addEventListener?.(EVENT, h); } catch { /* no DOM */ }
  return () => { try { globalThis.removeEventListener?.(EVENT, h); } catch { /* ignore */ } };
}

let installed = false;

/**
 * In the iOS/Android app: take files handed over by "Open in" / Share, now and whenever more arrive,
 * stash them and open Files. Does nothing in a browser (the service worker covers the PWA).
 */
export function installNativeShareListener({ go = (href) => { globalThis.location.hash = href.slice(1); } } = {}) {
  if (installed || !isNativeApp()) return false;
  const plugin = globalThis.Capacitor?.Plugins?.FishtapeIncomingFiles;
  if (!plugin) return false;
  installed = true;
  const pull = async () => {
    try {
      const r = await plugin.takePending();
      const { files, skipped } = nativeItemsToFiles(r?.files || []);
      if (files.length) {
        await stashShared(files, 'native');
        announce(files.length);
        if (!/^#\/files\b/.test(globalThis.location?.hash || '')) go(SHARE_ROUTE);
      }
      if (skipped.length) {
        try { globalThis.dispatchEvent?.(new CustomEvent('ft:files-share-skipped', { detail: { skipped } })); } catch { /* ignore */ }
      }
    } catch (e) { console.warn('Shared files could not be read', e); }
  };
  try { plugin.addListener('filesReceived', pull); } catch { /* older app build */ }
  pull();
  return true;
}
