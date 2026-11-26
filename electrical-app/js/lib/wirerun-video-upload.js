// Wire-run video to and from the server (/api/v1/wirerun-media, server/src/routes/v1/wirerun-media.js),
// and the background queue that sends attached videos up in chunks, resuming where the server got
// to after a dropped signal, a closed app or a reload. Same video store as walkthroughs: the server
// transcodes it (walkthrough_transcode) and streams it back for short-lived signed links only
// (/api/v1/media/..., renewed by keepMediaFresh; mediaUrl prefixes the API origin in the iOS app).
//
// Status lives on the run's video entry (synced, so other devices see "uploading"/"ready"); the
// progress of the upload running on this device is kept here in memory for the screen.
import { api, apiFetch, ApiError } from '../session.js';
import { getBlob } from './local-blobs.js';
import { MAX_UPLOAD_BYTES, normalizeVideos, patchVideoList, runChunkedUpload, unreachable } from './wirerun-video.js';

export { mediaUrl, keepMediaFresh } from './walkthrough-upload.js';

const PATH = '/api/v1/wirerun-media';
const enc = encodeURIComponent;

/** Start an upload: the server row ('uploading', receivedBytes 0, chunkBytes). */
export const startUpload = ({ wireRunId, bytes, mimeType, durationMs }) =>
  api.post(PATH, { wireRunId, bytes, ...(mimeType ? { mimeType } : {}), durationMs: Math.max(0, Math.round(durationMs || 0)) });
/** Status, resume offset and playback urls. */
export const fetchMedia = (id) => api.get(`${PATH}/${enc(id)}`);
/** Delete the video and its files on the server. */
export const deleteMedia = (id) => api.del(`${PATH}/${enc(id)}`);

/** MP4 and WebM go up as themselves; anything else (an iPhone .mov) is sniffed by the server. */
export function uploadMime(type) {
  const base = String(type || '').split(';')[0].trim().toLowerCase();
  return base === 'video/mp4' || base === 'video/webm' ? base : '';
}

/** Send one chunk. Resolves to the server view; throws ApiError (409 offset_mismatch carries details.receivedBytes). */
export async function putChunk(id, offset, blob) {
  let res;
  try {
    res = await apiFetch(`${PATH}/${enc(id)}/data`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Fishtape': '1', 'X-Upload-Offset': String(offset), Accept: 'application/json' },
      body: blob, credentials: 'include', cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'offline', "Can't reach the server to upload the video.");
  }
  const type = res.headers.get('content-type') || '';
  if (!type.includes('application/json')) throw new ApiError(res.status, res.status >= 500 ? 'unavailable' : 'no_api', "The server isn't answering right now.");
  let json = null;
  try { json = await res.json(); } catch { throw new ApiError(res.status, 'unavailable', 'The server sent an unreadable answer.'); }
  if (!res.ok) {
    const e = json?.error || {};
    throw new ApiError(res.status, e.code || 'error', e.message || 'Something went wrong.', e.details);
  }
  return json;
}

// ---------- the queue ----------
const running = new Map();   // videoId -> Promise
const progress = new Map();  // videoId -> { sent, total }
const EVENT = 'ft:wirerun-upload';
const emit = (videoId) => { try { globalThis.dispatchEvent?.(new CustomEvent(EVENT, { detail: { videoId } })); } catch { /* no DOM */ } };

/** { sent, total } for an upload running on this device, or null. */
export const uploadProgress = (videoId) => progress.get(videoId) || null;
export const isUploading = (videoId) => running.has(videoId);

/** fn(videoId) on upload progress or finish. Returns an unsubscribe function. */
export function onUploadChange(fn) {
  const handler = (e) => fn(e?.detail?.videoId || '');
  try { globalThis.addEventListener?.(EVENT, handler); } catch { /* no DOM */ }
  return () => { try { globalThis.removeEventListener?.(EVENT, handler); } catch { /* ignore */ } };
}

/** Write a video's new status into its run (no audit entry: it's bookkeeping). Returns the video. */
export function patchRunVideo(store, runId, videoId, patch) {
  const run = store.get('wireRuns', runId);
  if (!run) return null;
  const videos = patchVideoList(run.videos, videoId, patch);
  store.update('wireRuns', runId, { videos }, { silent: true });
  return videos.find((v) => v.id === videoId) || null;
}

/**
 * Upload one attached video in the background (a second call while it runs returns the same
 * promise). Resolves to the server view, or null when there is nothing to send from this device.
 * Network trouble leaves it queued for the next try; a refusal marks it failed with the reason.
 */
export function uploadVideo(store, runId, videoId) {
  if (store.synced === false) return Promise.resolve(null); // the demo has no server: videos stay on the device
  if (running.has(videoId)) return running.get(videoId);
  const p = doUpload(store, runId, videoId)
    .catch((e) => {
      if (!unreachable(e) && e?.code !== 'aborted') patchRunVideo(store, runId, videoId, { status: 'failed', error: e?.message || 'Upload failed.' });
      throw e;
    })
    .finally(() => { running.delete(videoId); progress.delete(videoId); emit(videoId); });
  running.set(videoId, p);
  emit(videoId);
  return p;
}

async function doUpload(store, runId, videoId) {
  const find = () => normalizeVideos(store.get('wireRuns', runId)?.videos).find((v) => v.id === videoId) || null;
  let v = find();
  if (!v?.localId) return null;
  const blob = await getBlob(v.localId);
  if (!blob?.size) return null;              // recorded on another device
  if (blob.size > MAX_UPLOAD_BYTES) return null;
  let view = null;
  if (v.mediaId) {
    try { view = await fetchMedia(v.mediaId); } catch (e) {
      if (e?.status !== 404) throw e;
      v = patchRunVideo(store, runId, videoId, { mediaId: null, status: 'local' }); // deleted on the server: start again
    }
  }
  if (!view) {
    view = await startUpload({ wireRunId: runId, bytes: blob.size, mimeType: uploadMime(blob.type || v.mimeType), durationMs: v.durationMs });
    if (!find()) { await deleteMedia(view.id).catch(() => {}); return null; } // removed from the run meanwhile
    patchRunVideo(store, runId, videoId, { mediaId: view.id, status: 'uploading', error: null });
  }
  if (view.status === 'uploading') {
    const id = view.id;
    progress.set(videoId, { sent: view.receivedBytes || 0, total: blob.size });
    const last = await runChunkedUpload({
      blob, offset: view.receivedBytes || 0, chunkBytes: view.chunkBytes || undefined,
      putChunk: (offset, slice) => putChunk(id, offset, slice),
      onProgress: (sent, total) => { progress.set(videoId, { sent, total }); emit(videoId); },
    });
    view = last && last.status !== 'uploading' ? last : await fetchMedia(id);
  }
  if (!find()) return view;
  patchRunVideo(store, runId, videoId, { status: view.status, error: view.status === 'failed' ? (view.error || 'The server could not process the video.') : null });
  return view;
}

/**
 * Send every attached video this device still holds that hasn't reached the server. Called when the
 * wire runs screens open and when the connection comes back. Errors are left for the next try.
 */
export async function resumeUploads(store) {
  if (globalThis.navigator?.onLine === false || store.synced === false) return;
  for (const run of store.list('wireRuns')) {
    for (const v of normalizeVideos(run.videos)) {
      if (!v.localId || running.has(v.id)) continue;
      if (!(v.status === 'local' || v.status === 'uploading')) continue;
      uploadVideo(store, run.id, v.id).catch(() => { /* retried next time */ });
    }
  }
}

let resumeHooked = false;
/** Resume uploads whenever the device comes back online (once per page). */
export function hookResumeOnOnline(store) {
  if (resumeHooked) return;
  resumeHooked = true;
  try { globalThis.addEventListener?.('online', () => resumeUploads(store)); } catch { /* no DOM */ }
}

/**
 * Keep the server state of videos that are uploading or optimising in step (another device's upload,
 * or the transcode finishing). Returns how many are still in progress.
 */
export async function refreshServerStatus(store, runId) {
  const run = store.get('wireRuns', runId);
  let pending = 0;
  for (const v of normalizeVideos(run?.videos)) {
    if (!v.mediaId || !['uploading', 'processing'].includes(v.status) || running.has(v.id)) continue;
    try {
      const m = await fetchMedia(v.mediaId);
      if (m.status !== v.status) patchRunVideo(store, runId, v.id, { status: m.status, error: m.status === 'failed' ? m.error : null });
      if (['uploading', 'processing'].includes(m.status)) pending++;
    } catch (e) {
      if (e?.status === 404) patchRunVideo(store, runId, v.id, { mediaId: null, status: v.localId ? 'local' : 'failed', error: v.localId ? null : 'The server no longer has this video.' });
      else pending++;
    }
  }
  return pending;
}
