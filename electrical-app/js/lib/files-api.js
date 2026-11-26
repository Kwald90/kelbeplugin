// Files data: one interface over two backends, plus the offline upload queue.
//
//   signed in (store.synced)   the company's server store (/api/v1/files, routes/v1/files.js). The last
//                              listing is kept on this device so Files opens offline; uploads made
//                              offline wait in a queue (bytes in IndexedDB via local-blobs.js) and go
//                              up, then get filed, as soon as the connection is back.
//   demo                       everything stays on this device; filing uses the keyword rules.
//
// session.js apiFetch adds the credentials (cookie on the web, Keychain bearer in the iOS app). Uploads
// are raw bodies (application/octet-stream) with the name and place in headers, like walkthrough video.
import { apiFetch, api, ApiError } from '../session.js';
import { putBlob, getBlob, deleteBlob } from './local-blobs.js';
import { rulesClassify, safeName, extOf, AUTO_FILE_CONFIDENCE } from './files-classify.js';

export const MAX_FILE_BYTES_DEFAULT = 70 * 1024 * 1024;
const PATH = '/api/v1/files';
const FOLDERS = '/api/v1/file-folders';
const cacheKey = (db) => `files-cache:${db || 'local'}`;
const queueKey = (db) => `files-queue:${db || 'local'}`;
const localKey = (db) => `files-local:${db || 'demo'}`;

const MIME_BY_EXT = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', txt: 'text/plain', csv: 'text/csv', eml: 'message/rfc822',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', doc: 'application/msword', xls: 'application/vnd.ms-excel', zip: 'application/zip',
  dwg: 'image/vnd.dwg', dxf: 'image/vnd.dxf',
};
export const mimeOf = (file) => String(file?.type || '').split(';')[0] || MIME_BY_EXT[extOf(file?.name)] || 'application/octet-stream';

/** Kinds of file the server refuses (checked properly there, by the bytes); caught early for a clear message. */
const BLOCKED_EXT = new Set(['exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'js', 'mjs', 'vbs', 'ps1', 'sh', 'app', 'dmg', 'apk', 'jar', 'html', 'htm', 'svg', 'xhtml', 'php']);
/** Why a file can't be imported before even trying, or null. */
export function importProblem(file, maxBytes = MAX_FILE_BYTES_DEFAULT) {
  if (!file || !file.size) return 'This file is empty.';
  if (file.size > maxBytes) return `Too large: each file can be up to ${Math.round(maxBytes / 1024 / 1024)} MB.`;
  if (BLOCKED_EXT.has(extOf(file.name))) return 'Programs, web pages and scripts can’t be stored in Files.';
  return null;
}

/** Turn a fetch Response into JSON or an ApiError (mirrors session.js request()). */
async function readJson(res) {
  if (res.status === 204) return null;
  const type = res.headers.get('content-type') || '';
  if (!type.includes('application/json')) throw new ApiError(res.status, res.status >= 500 ? 'unavailable' : 'no_api', "The server isn't answering right now.");
  let json = null;
  try { json = await res.json(); } catch { throw new ApiError(res.status, 'unavailable', 'The server sent an unreadable answer.'); }
  if (!res.ok) { const e = json?.error || {}; throw new ApiError(res.status, e.code || 'error', e.message || 'Something went wrong.', e.details); }
  return json;
}

const offline = (what) => new ApiError(0, 'offline', `Can't reach the server${what ? ` to ${what}` : ''}. Check your connection.`);
export const isOfflineError = (e) => e?.code === 'offline' || e?.status === 0 || e?.code === 'no_api';

// ---- the server ----------------------------------------------------------------------------------

function serverBackend(store) {
  const db = () => store.dbName;
  return {
    kind: 'server',
    async load() {
      try {
        const data = await api.get(PATH);
        putBlob(data, cacheKey(db())).catch(() => {});
        return { ...data, offline: false };
      } catch (e) {
        if (!isOfflineError(e)) throw e;
        const cached = await getBlob(cacheKey(db()));
        return { files: [], folders: [], usage: null, companyFiles: true, canPurge: false, ...(cached || {}), offline: true };
      }
    },
    async upload(file, place = {}, { source = 'upload' } = {}) {
      const headers = { 'Content-Type': 'application/octet-stream', 'X-Fishtape': '1', Accept: 'application/json', 'X-File-Name': encodeURIComponent(safeName(file.name || 'File')), 'X-Source': source };
      if (place.clientId) headers['X-Client-Id'] = place.clientId;
      if (place.jobId) headers['X-Job-Id'] = place.jobId;
      if (place.category) headers['X-Category'] = place.category;
      if (place.folderId) headers['X-Folder-Id'] = place.folderId;
      let res;
      try { res = await apiFetch(PATH, { method: 'POST', headers, body: file, credentials: 'include', cache: 'no-store' }); } catch { throw offline('upload'); }
      return readJson(res);
    },
    organize: (id, body = {}) => api.post(`${PATH}/${encodeURIComponent(id)}/organize`, body),
    move: (id, place) => api.patch(`${PATH}/${encodeURIComponent(id)}`, { move: true, clientId: place.clientId || null, jobId: place.jobId || null, category: place.category || null, folderId: place.folderId || null }),
    rename: (id, name) => api.patch(`${PATH}/${encodeURIComponent(id)}`, { name }),
    trash: (id) => api.del(`${PATH}/${encodeURIComponent(id)}`),
    purge: (id) => api.del(`${PATH}/${encodeURIComponent(id)}?forever=1`),
    restore: (id) => api.post(`${PATH}/${encodeURIComponent(id)}/restore`, {}),
    async content(id, { inline = false } = {}) {
      let res;
      try { res = await apiFetch(`${PATH}/${encodeURIComponent(id)}/content${inline ? '?inline=1' : ''}`, { method: 'GET', credentials: 'include', cache: 'no-store' }); } catch { throw offline('open the file'); }
      if (!res.ok) await readJson(res);
      return res.blob();
    },
    createFolder: (f) => api.post(FOLDERS, { name: f.name, clientId: f.clientId || null, jobId: f.jobId || null, category: f.category || null, parentId: f.parentId || null }),
    renameFolder: (id, name) => api.patch(`${FOLDERS}/${encodeURIComponent(id)}`, { name }),
    deleteFolder: (id) => api.del(`${FOLDERS}/${encodeURIComponent(id)}`),
  };
}

// ---- this device (demo) --------------------------------------------------------------------------

function localBackend(store) {
  const key = () => localKey(store.dbName);
  const read = async () => (await getBlob(key())) || { files: [], folders: [] };
  const write = (d) => putBlob(d, key());
  const now = () => new Date().toISOString();
  const newId = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const notFound = () => new ApiError(404, 'not_found', 'No such file.');
  async function edit(id, fn) {
    const d = await read();
    const f = d.files.find((x) => x.id === id);
    if (!f) throw notFound();
    fn(f, d);
    f.updatedAt = now();
    await write(d);
    return { file: { ...f } };
  }
  const usage = (d) => ({ count: d.files.length, bytes: d.files.reduce((n, f) => n + (f.bytes || 0), 0), quotaBytes: null, maxFileBytes: MAX_FILE_BYTES_DEFAULT, trashDays: null });
  return {
    kind: 'local',
    async load() { const d = await read(); return { ...d, usage: usage(d), companyFiles: true, canPurge: true, offline: false, local: true }; },
    async upload(file, place = {}, { source = 'upload' } = {}) {
      const d = await read();
      const buf = await file.arrayBuffer();
      const digest = globalThis.crypto?.subtle ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('') : '';
      const dup = digest && d.files.find((f) => f.sha256 === digest && !f.deletedAt);
      if (dup) return { file: { ...dup }, duplicate: true };
      const id = newId('file');
      await putBlob(new Blob([buf], { type: mimeOf(file) }), `fl-${id}`);
      const name = safeName(file.name || 'File');
      const row = {
        id, name, originalName: name, mime: mimeOf(file), ext: extOf(name), bytes: file.size, sha256: digest,
        clientId: place.clientId || null, jobId: place.jobId || null, category: place.category || null, folderId: place.folderId || null,
        ai: null, source, text: '', createdBy: store.actorId || null, createdAt: now(), updatedAt: now(), deletedAt: null,
      };
      if (row.jobId && !row.clientId) row.clientId = store.get('jobs', row.jobId)?.clientId || null;
      d.files.unshift(row);
      await write(d);
      return { file: { ...row }, duplicate: false };
    },
    async organize(id, { text = '', company = false, date = '' } = {}) {
      const d = await read();
      const f = d.files.find((x) => x.id === id);
      if (!f) throw notFound();
      const fixed = { clientId: f.clientId, jobId: f.jobId, category: f.category, folderId: f.folderId, company: company && !f.clientId && !f.jobId };
      const clients = store.list('clients').map((c) => ({ id: c.id, name: c.name }));
      const jobs = store.list('jobs').map((j) => ({ id: j.id, clientId: j.clientId || null, number: j.number, title: j.title, address: j.address, status: j.status }));
      const r = rulesClassify({ name: f.originalName || f.name, mime: f.mime, text }, { clients, jobs, fixed, date: date || now().slice(0, 10) });
      const done = fixed.category || fixed.folderId;
      const apply = !done && r.category && r.confidence >= AUTO_FILE_CONFIDENCE;
      const result = {
        by: 'rules', provider: null, confidence: done ? 1 : r.confidence, reason: done ? 'Filed where you put it.' : r.reason, note: 'On this device files are sorted by keywords.',
        suggestedName: r.suggestedName, at: now(), applied: Boolean(apply),
        suggestion: { clientId: r.clientId ?? r.suggestion?.clientId ?? null, jobId: r.jobId ?? r.suggestion?.jobId ?? null, category: r.category ?? r.suggestion?.category ?? null },
        from: { clientId: f.clientId, jobId: f.jobId, category: f.category, folderId: f.folderId },
      };
      if (apply) Object.assign(f, { clientId: r.clientId, jobId: r.jobId, category: r.category });
      if (text) f.text = String(text).slice(0, 600);
      f.ai = result; f.updatedAt = now();
      await write(d);
      return { file: { ...f }, result };
    },
    move: (id, place) => edit(id, (f) => Object.assign(f, {
      clientId: place.jobId ? (store.get('jobs', place.jobId)?.clientId || null) : (place.clientId || null), jobId: place.jobId || null,
      category: place.category || null, folderId: place.folderId || null, ai: f.ai ? { ...f.ai, by: 'person' } : f.ai,
    })),
    rename: (id, name) => edit(id, (f) => { const ext = extOf(f.name); f.name = safeName(ext && extOf(name) !== ext ? `${name}.${ext}` : name); }),
    trash: (id) => edit(id, (f) => { f.deletedAt = now(); }).then(() => null),
    restore: (id) => edit(id, (f, d) => { f.deletedAt = null; if (f.folderId && !d.folders.some((x) => x.id === f.folderId)) f.folderId = null; }),
    async purge(id) { const d = await read(); d.files = d.files.filter((f) => f.id !== id); await write(d); await deleteBlob(`fl-${id}`); return null; },
    async content(id) { const b = await getBlob(`fl-${id}`); if (!b) throw notFound(); return b; },
    async createFolder(f) {
      const d = await read();
      const parent = f.parentId ? d.folders.find((x) => x.id === f.parentId) : null;
      const row = {
        id: newId('folder'), name: String(f.name).trim().slice(0, 120), parentId: f.parentId || null, createdAt: now(), updatedAt: now(),
        clientId: parent ? parent.clientId : (f.clientId || null), jobId: parent ? parent.jobId : (f.jobId || null), category: parent ? parent.category : (f.category || null),
      };
      d.folders.push(row); await write(d); return { folder: row };
    },
    async renameFolder(id, name) { const d = await read(); const f = d.folders.find((x) => x.id === id); if (!f) throw notFound(); f.name = String(name).trim().slice(0, 120); await write(d); return { folder: f }; },
    async deleteFolder(id) {
      const d = await read(); const f = d.folders.find((x) => x.id === id); if (!f) throw notFound();
      for (const x of d.files) if (x.folderId === id) x.folderId = f.parentId || null;
      for (const x of d.folders) if (x.parentId === id) x.parentId = f.parentId || null;
      d.folders = d.folders.filter((x) => x.id !== id); await write(d); return null;
    },
  };
}

/** The backend for the open company (server when signed in, this device in the demo). */
export function filesBackend(store) {
  return store?.synced ? serverBackend(store) : localBackend(store);
}

// ---- the offline queue ---------------------------------------------------------------------------

/**
 * Imports that could not go up yet. Each entry keeps the bytes in IndexedDB and what to do with them:
 * { id, name, size, type, place, source, text, auto, company, at, status: 'queued'|'failed', error }.
 */
export function createQueue(store) {
  const key = () => queueKey(store.dbName);
  const read = async () => (await getBlob(key())) || [];
  const write = (q) => putBlob(q, key());
  return {
    list: read,
    async add(file, { place = {}, source = 'upload', text = '', auto = true, company = false } = {}) {
      const id = `queued-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      await putBlob(file, id);
      const q = await read();
      q.push({ id, name: safeName(file.name || 'File'), size: file.size, type: mimeOf(file), place, source, text, auto, company, at: new Date().toISOString(), status: 'queued', error: null });
      await write(q);
      return id;
    },
    async remove(id) { await write((await read()).filter((e) => e.id !== id)); await deleteBlob(id); },
    async mark(id, patch) { const q = await read(); const e = q.find((x) => x.id === id); if (e) Object.assign(e, patch); await write(q); },
    /**
     * Send what is waiting, one at a time. `each(entry, outcome)` runs after every attempt with
     * { ok, file, result, duplicate } or { ok: false, error }. Stops at the first offline error.
     */
    async flush(backend, each = () => {}) {
      let sent = 0;
      for (const e of await read()) {
        const blob = await getBlob(e.id);
        if (!blob) { await this.remove(e.id); continue; }
        const file = blob instanceof File ? blob : new File([blob], e.name, { type: e.type });
        try {
          const up = await backend.upload(file, e.place, { source: e.source });
          let org = null;
          if (e.auto && !up.duplicate && !(e.place.category || e.place.folderId)) {
            org = await backend.organize(up.file.id, { text: e.text || undefined, company: Boolean(e.company) }).catch(() => null);
          }
          await this.remove(e.id);
          sent++;
          each(e, { ok: true, file: org?.file || up.file, result: org?.result || null, duplicate: up.duplicate });
        } catch (err) {
          if (isOfflineError(err)) { each(e, { ok: false, error: err, offline: true }); break; }
          await this.mark(e.id, { status: 'failed', error: err?.message || 'Upload failed.' });
          each(e, { ok: false, error: err });
        }
      }
      return sent;
    },
  };
}

/** Queue entries as pseudo-files for the folder views ("Waiting to upload"). */
export function queuedAsFiles(entries) {
  return entries.map((e) => ({
    id: e.id, name: e.name, originalName: e.name, mime: e.type, ext: extOf(e.name), bytes: e.size,
    clientId: e.place?.clientId || null, jobId: e.place?.jobId || null, category: e.place?.category || null, folderId: e.place?.folderId || null,
    createdAt: e.at, deletedAt: null, pending: true, status: e.status, error: e.error,
  }));
}
