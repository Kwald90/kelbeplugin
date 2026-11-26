// Wire-run recordings on this device: saving a fresh recording, the Unattached recordings list,
// attaching one to a run (or detaching a video that never left the device), deleting, and how much
// room they take. The bytes go in the IndexedDB blob store (lib/local-blobs.js); the list of
// unattached recordings is device-local metadata in the company database (store meta), so it never
// syncs and never mixes companies. Rules and shapes are in lib/wirerun-video.js.
import { blobsSupported, deleteBlob, getBlob, putBlob } from './local-blobs.js';
import {
  META_KEY, MAX_VIDEOS_PER_RUN, fmtBytes, newRecording, normalizeRecordings, normalizeVideos, recordingFromVideo, roomFor, runVideoFrom,
} from './wirerun-video.js';

const EVENT = 'ft:wirerun-recordings';
const fail = (code, message) => Object.assign(new Error(message), { code });

export function listRecordings(store) {
  return normalizeRecordings(store.meta(META_KEY));
}

function writeRecordings(store, list) {
  store.setMeta(META_KEY, list.length ? list : undefined);
  try { globalThis.dispatchEvent?.(new CustomEvent(EVENT)); } catch { /* no DOM */ }
}

/** fn() whenever the unattached list changes. Returns an unsubscribe function. */
export function onRecordingsChange(fn) {
  try { globalThis.addEventListener?.(EVENT, fn); } catch { /* no DOM */ }
  return () => { try { globalThis.removeEventListener?.(EVENT, fn); } catch { /* ignore */ } };
}

/** navigator.storage.estimate(), or null when the browser can't say. */
export async function storageEstimate() {
  try { return (await globalThis.navigator?.storage?.estimate?.()) || null; } catch { return null; }
}

/**
 * Keep a fresh recording on this device as an unattached recording. Checks there is room first.
 * Throws an Error with code 'empty' | 'no_storage' | 'no_room' and a sentence to show.
 */
export async function saveRecording(store, blob, fields = {}) {
  if (!blob?.size) throw fail('empty', 'The recording is empty.');
  if (!blobsSupported()) throw fail('no_storage', "This browser can't keep videos (a private window, or storage is turned off).");
  const room = roomFor(blob.size, await storageEstimate());
  if (!room.ok) throw fail('no_room', room.message);
  let localId;
  try { localId = await putBlob(blob); } catch {
    throw fail('no_room', `This device couldn't store the ${fmtBytes(blob.size)} video. Free up space (delete old recordings) and try again.`);
  }
  const rec = newRecording({ ...fields, localId, bytes: blob.size, mimeType: blob.type || fields.mimeType || '' });
  writeRecordings(store, [rec, ...listRecordings(store)]);
  return rec;
}

export function getRecording(store, id) {
  return listRecordings(store).find((r) => r.id === id) || null;
}

/** Rename, or file under a job. */
export function updateRecording(store, id, patch) {
  writeRecordings(store, listRecordings(store).map((r) => (r.id === id ? { ...r, ...patch, id: r.id, localId: r.localId } : r)));
}

/** Delete an unattached recording and its bytes. */
export async function deleteRecording(store, id) {
  const rec = getRecording(store, id);
  writeRecordings(store, listRecordings(store).filter((r) => r.id !== id));
  if (rec) await deleteBlob(rec.localId);
}

/**
 * Attach an unattached recording to a run: it moves from the device list into run.videos (same
 * bytes, same markers). Returns the run's new video entry. Throws code 'gone' | 'no_run' | 'full'.
 */
export function attachRecording(store, recordingId, runId, { actorId = null } = {}) {
  const rec = getRecording(store, recordingId);
  if (!rec) throw fail('gone', 'That recording is no longer on this device.');
  const run = store.get('wireRuns', runId);
  if (!run) throw fail('no_run', 'That wire run no longer exists.');
  const videos = normalizeVideos(run.videos);
  if (videos.length >= MAX_VIDEOS_PER_RUN) throw fail('full', `A run holds ${MAX_VIDEOS_PER_RUN} videos. Remove one first.`);
  const v = runVideoFrom(rec, { attachedBy: actorId });
  if (!v.label) v.label = `Video ${videos.length + 1}`;
  store.update('wireRuns', runId, { videos: [...videos, v] }, { summary: `${run.name || 'Wire run'}: video attached` });
  writeRecordings(store, listRecordings(store).filter((r) => r.id !== recordingId));
  return v;
}

/** Move a video that never reached the server back to the unattached list. Throws code 'uploaded'. */
export function detachVideo(store, runId, videoId) {
  const run = store.get('wireRuns', runId);
  const v = normalizeVideos(run?.videos).find((x) => x.id === videoId);
  if (!v) return null;
  if (v.mediaId) throw fail('uploaded', 'This video is on the server already. Remove it instead.');
  const rec = recordingFromVideo(v, run);
  writeRecordings(store, [rec, ...listRecordings(store)]);
  store.update('wireRuns', runId, { videos: normalizeVideos(run.videos).filter((x) => x.id !== videoId) }, { summary: `${run.name || 'Wire run'}: video detached` });
  return rec;
}

/**
 * Remove a video from its run, with its bytes on this device and (through deleteServer) its copy on
 * the server. Server trouble is reported back but never blocks the removal.
 */
export async function removeVideo(store, runId, videoId, { deleteServer = null } = {}) {
  const run = store.get('wireRuns', runId);
  const v = normalizeVideos(run?.videos).find((x) => x.id === videoId);
  if (!v) return { serverError: null };
  store.update('wireRuns', runId, { videos: normalizeVideos(run.videos).filter((x) => x.id !== videoId) }, { summary: `${run.name || 'Wire run'}: video removed` });
  if (v.localId) await deleteBlob(v.localId);
  let serverError = null;
  if (v.mediaId && deleteServer) { try { await deleteServer(v.mediaId); } catch (e) { if (e?.status !== 404) serverError = e; } }
  return { serverError };
}

/** Free the device copy of a video the server already holds ('ready'). */
export async function dropLocalCopy(store, runId, videoId) {
  const run = store.get('wireRuns', runId);
  const v = normalizeVideos(run?.videos).find((x) => x.id === videoId);
  if (!v?.localId || v.status !== 'ready') return false;
  store.update('wireRuns', runId, { videos: normalizeVideos(run.videos).map((x) => (x.id === videoId ? { ...x, localId: null } : x)) }, { silent: true });
  await deleteBlob(v.localId);
  return true;
}

/** The ids, of those given, whose bytes are on this device. */
export async function presentLocally(localIds) {
  const out = new Set();
  await Promise.all([...new Set(localIds.filter(Boolean))].map(async (id) => { if (await getBlob(id)) out.add(id); }));
  return out;
}
