// Wire-run video: the camera recording made while the AR tape measures a run (or a clip recorded or
// picked afterwards), kept so the run can be re-checked later. Pure rules and shapes, tested in Node;
// js/modules/wireruns.js draws the screens and js/lib/wirerun-video-upload.js talks to the server.
//
// Where a recording lives:
//  - its bytes, on this device, in the IndexedDB blob store (lib/local-blobs.js), and once uploaded
//    on the server's video store (/api/v1/wirerun-media, the walkthrough pipeline);
//  - unattached: a small entry in the device-local list (store meta 'wireRunRecordings', per
//    company database, never synced), until someone attaches it to a run;
//  - attached: an entry in the run's `videos` array (synced). It carries the markers (when each
//    point was dropped) and mediaId once the upload has started, never the bytes.
//
// Small recordings are attached as soon as the measurement is added. Big ones, or ones made offline
// or on a device short of memory, stay unattached so the run stays light, and are attached later
// from the run or the Unattached recordings list.

const MB = 1024 * 1024;
/** Attach straight away up to this size; bigger recordings are kept on the device to attach later. */
export const ATTACH_NOW_MAX_BYTES = 40 * MB;
/** The server's per-video cap (MEDIA_MAX_VIDEO_MB, default 150). Bigger recordings stay on the device only. */
export const MAX_UPLOAD_BYTES = 150 * MB;
/** Devices reporting this much memory or less (navigator.deviceMemory, GB) keep recordings unattached. */
export const LOW_MEMORY_GB = 2;
/** Keep this much free space after storing a recording, so the app itself never runs out. */
export const STORAGE_HEADROOM_BYTES = 100 * MB;
/** Same cap as the server (services/wirerun-media.js). */
export const MAX_VIDEOS_PER_RUN = 12;
export const MAX_MARKERS = 500;
/** Recording bitrate the AR recorders aim for (~15 MB a minute). */
export const RECORD_VIDEO_BPS = 2_000_000;
export const META_KEY = 'wireRunRecordings';

export const VIDEO_SOURCES = {
  'ar-native': 'AR tape (iOS)',
  'ar-webxr': 'AR tape',
  camera: 'Camera',
  file: 'Picked video',
};
export const VIDEO_STATUSES = ['local', 'uploading', 'processing', 'ready', 'failed'];

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pos = (v) => Math.max(0, num(v));
const str = (v, max = 200) => String(v ?? '').slice(0, max);
const iso = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? v : new Date().toISOString());

export function newVideoId() {
  if (globalThis.crypto?.randomUUID) return 'vid-' + crypto.randomUUID();
  return 'vid-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/** '12.4 MB', '850 KB'. */
export function fmtBytes(n) {
  const b = pos(n);
  if (b >= 1024 * MB) return `${(b / (1024 * MB)).toFixed(1)} GB`;
  if (b >= 10 * MB) return `${Math.round(b / MB)} MB`;
  if (b >= MB) return `${(b / MB).toFixed(1)} MB`;
  return b ? `${Math.max(1, Math.round(b / 1024))} KB` : '0 KB';
}

/** m:ss (or h:mm:ss) from milliseconds; { tenths: true } adds a decimal, for markers a second apart. */
export function fmtClock(ms, { tenths = false } = {}) {
  const s = Math.max(0, Math.floor(pos(ms) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const out = h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  return tenths ? `${out}.${Math.floor((pos(ms) % 1000) / 100)}` : out;
}

// ---------- markers ----------
/**
 * Markers from an AR result: one per point dropped, at the moment it was dropped. `segIds` are the
 * ids of the segments the path became (one per leg when split, else one for the whole path), so a
 * marker can say which segment the leg it closes belongs to.
 * -> [{ atMs, pointIndex, label, segId, legM }]
 */
export function markersFromPath(path, { segIds = [], startIndex = 0 } = {}) {
  const times = Array.isArray(path?.pointTimesMs) ? path.pointTimesMs : [];
  const legs = (path?.segments || []).map((s) => pos(s.lengthM));
  const split = segIds.length > 1 && segIds.length === legs.length;
  const out = [];
  times.forEach((t, i) => {
    if (!Number.isFinite(Number(t))) return;
    const leg = i - 1;
    out.push({
      atMs: Math.round(pos(t)),
      pointIndex: startIndex + i,
      label: i === 0 ? 'Start' : `Point ${i + 1}`,
      segId: (split ? segIds[Math.max(0, leg)] : segIds[0]) || null,
      legM: i === 0 ? null : (legs[leg] ?? null),
    });
  });
  return normalizeMarkers(out);
}

/** Valid, time-ordered markers, at most MAX_MARKERS, clipped to the video length when known. */
export function normalizeMarkers(list, durationMs = null) {
  const end = durationMs > 0 ? durationMs : Infinity;
  return (Array.isArray(list) ? list : [])
    .filter((m) => m && Number.isFinite(Number(m.atMs)))
    .map((m) => ({
      atMs: Math.round(Math.min(end, pos(m.atMs))),
      pointIndex: Number.isInteger(m.pointIndex) ? m.pointIndex : null,
      label: str(m.label) || 'Marker',
      segId: m.segId ? str(m.segId, 128) : null,
      legM: m.legM == null || !Number.isFinite(Number(m.legM)) ? null : pos(m.legM),
    }))
    .sort((a, b) => a.atMs - b.atMs)
    .slice(0, MAX_MARKERS);
}

/** Index of the marker playing at `tMs` (the last one at or before it, within `slackMs`), or -1. */
export function markerAt(markers, tMs, slackMs = 250) {
  let at = -1;
  (markers || []).forEach((m, i) => { if (m.atMs <= tMs + slackMs) at = i; });
  return at;
}

/** The marker to jump to from `tMs`: the next one (dir 1) or the previous one (dir -1), or -1. */
export function stepMarker(markers, tMs, dir) {
  const list = markers || [];
  if (dir > 0) return list.findIndex((m) => m.atMs > tMs + 150);
  for (let i = list.length - 1; i >= 0; i--) if (list[i].atMs < tMs - 600) return i;
  return -1;
}

/** Add a marker someone set by hand while watching. Returns the new list. */
export function withMarker(markers, { atMs, label }, durationMs = null) {
  return normalizeMarkers([...(markers || []), { atMs, label: str(label).trim() || 'Marker' }], durationMs);
}

// ---------- recordings (device-local, unattached) ----------
/** An unattached recording for the device-local list. */
export function newRecording({ localId, bytes, durationMs = 0, mimeType = '', source = 'camera', markers = [], jobId = null, runId = null, label = '', totalM = null, recordedAt = null }) {
  return {
    id: newVideoId(),
    localId: String(localId),
    bytes: pos(bytes),
    durationMs: Math.round(pos(durationMs)),
    mimeType: str(mimeType, 80),
    source: VIDEO_SOURCES[source] ? source : 'camera',
    markers: normalizeMarkers(markers, durationMs),
    jobId: jobId || null,
    runId: runId || null,
    label: str(label).trim(),
    totalM: totalM == null ? null : pos(totalM),
    recordedAt: iso(recordedAt),
  };
}

export function normalizeRecordings(list) {
  return (Array.isArray(list) ? list : [])
    .filter((r) => r && r.id && r.localId)
    .map((r) => ({ ...newRecording(r), id: r.id }))
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
}

/**
 * Recordings for the "Working on" job: with a focus, only that job's (recordings with no job are
 * counted as hidden too). -> { shown, hidden }
 */
export function recordingsForFocus(list, focusJobId) {
  const all = list || [];
  if (!focusJobId) return { shown: all, hidden: 0 };
  const shown = all.filter((r) => r.jobId === focusJobId);
  return { shown, hidden: all.length - shown.length };
}

// ---------- videos on a run (synced) ----------
/** A run's video entry from a recording (same bytes, same markers). */
export function runVideoFrom(rec, { attachedBy = null } = {}) {
  return {
    id: newVideoId(),
    label: str(rec.label).trim(),
    localId: rec.localId || null,
    mediaId: null,
    status: 'local',
    bytes: pos(rec.bytes),
    durationMs: Math.round(pos(rec.durationMs)),
    mimeType: str(rec.mimeType, 80),
    source: VIDEO_SOURCES[rec.source] ? rec.source : 'camera',
    markers: normalizeMarkers(rec.markers, rec.durationMs),
    recordedAt: iso(rec.recordedAt),
    attachedAt: new Date().toISOString(),
    attachedBy: attachedBy || null,
  };
}

/** Back to an unattached recording (a video that never reached the server, detached from its run). */
export function recordingFromVideo(v, run) {
  return { ...newRecording({ ...v, jobId: run?.jobId || null, runId: run?.id || null }), id: newVideoId() };
}

export function normalizeVideos(list) {
  return (Array.isArray(list) ? list : []).filter((v) => v && v.id).slice(0, MAX_VIDEOS_PER_RUN).map((v) => ({
    id: str(v.id, 128),
    label: str(v.label),
    localId: v.localId ? str(v.localId, 128) : null,
    mediaId: v.mediaId ? str(v.mediaId, 64) : null,
    status: VIDEO_STATUSES.includes(v.status) ? v.status : (v.mediaId ? 'processing' : 'local'),
    bytes: pos(v.bytes),
    durationMs: Math.round(pos(v.durationMs)),
    mimeType: str(v.mimeType, 80),
    source: VIDEO_SOURCES[v.source] ? v.source : 'camera',
    markers: normalizeMarkers(v.markers, v.durationMs),
    recordedAt: iso(v.recordedAt),
    attachedAt: v.attachedAt || null,
    attachedBy: v.attachedBy || null,
    ...(v.error ? { error: str(v.error, 300) } : {}),
  }));
}

/** Replace one video in a list with a patched copy. */
export function patchVideoList(list, videoId, patch) {
  return normalizeVideos(list).map((v) => (v.id === videoId ? normalizeVideos([{ ...v, ...patch }])[0] : v));
}

/** Can this video still go up? Not when the server already has it or the bytes are not here. */
export function needsUpload(v, { hasLocal = !!v?.localId } = {}) {
  if (!v || !hasLocal) return false;
  if (v.bytes > MAX_UPLOAD_BYTES) return false;
  return v.status === 'local' || v.status === 'uploading' || (v.status === 'failed' && !v.mediaId);
}

/** Short words for a video's state, for badges. tone fits ui.badge. */
export function videoStatus(v, { hasLocal = false } = {}) {
  if (!v) return { label: 'missing', tone: 'neutral' };
  if (v.status === 'ready') return { label: 'on the server', tone: 'success' };
  if (v.status === 'processing') return { label: 'optimising', tone: 'warning' };
  if (v.status === 'uploading') return { label: hasLocal ? 'uploading' : 'uploading from another device', tone: 'warning' };
  if (v.status === 'failed') return { label: v.mediaId ? 'server could not process it' : 'upload failed', tone: 'danger' };
  if (!hasLocal) return { label: 'on another device', tone: 'neutral' };
  if (v.bytes > MAX_UPLOAD_BYTES) return { label: 'this device only (too big to upload)', tone: 'info' };
  return { label: 'on this device', tone: 'info' };
}

// ---------- size and memory ----------
/**
 * What to do with a fresh recording when its measurement is added.
 * -> { action: 'attach' | 'keep', reason, message }
 * 'keep' saves it on the device as an unattached recording, to attach from the run later.
 */
export function attachDecision({ bytes, online = true, deviceMemoryGb = null }) {
  const size = fmtBytes(bytes);
  if (bytes > MAX_UPLOAD_BYTES) {
    return { action: 'keep', reason: 'too-big', message: `This video is ${size}, over the ${fmtBytes(MAX_UPLOAD_BYTES)} the server takes. It is kept on this device, where you can still play it and re-check the run. Record shorter runs to share them.` };
  }
  if (bytes > ATTACH_NOW_MAX_BYTES) {
    return { action: 'keep', reason: 'big', message: `This video is ${size}. It is saved on this device so the run stays quick to open. Attach it from the run's Videos when you want to re-check the run, and it uploads then.` };
  }
  if (deviceMemoryGb != null && deviceMemoryGb > 0 && deviceMemoryGb <= LOW_MEMORY_GB) {
    return { action: 'keep', reason: 'memory', message: `This device is short of memory, so the ${size} video is saved to attach later instead of being loaded into the run now.` };
  }
  if (!online) {
    return { action: 'keep', reason: 'offline', message: `You're offline. The ${size} video is saved on this device; attach it when you have signal and it uploads then.` };
  }
  return { action: 'attach', reason: 'ok', message: `The ${size} video is attached to this run and uploads in the background.` };
}

/**
 * Is there room to store `bytes` more? `estimate` is navigator.storage.estimate()'s answer (or null
 * when the browser can't say). -> { ok, freeBytes, message }
 */
export function roomFor(bytes, estimate) {
  const quota = Number(estimate?.quota), usage = Number(estimate?.usage);
  if (!(quota > 0) || !Number.isFinite(usage)) return { ok: true, freeBytes: null, message: '' };
  const free = Math.max(0, quota - usage);
  if (bytes + STORAGE_HEADROOM_BYTES > free) {
    return { ok: false, freeBytes: free, message: `Not enough room on this device for the ${fmtBytes(bytes)} video (${fmtBytes(free)} free for the app). Delete old recordings under Wire runs > Videos on this device, then try again.` };
  }
  return { ok: true, freeBytes: free, message: '' };
}

/**
 * What the videos on this device add up to.
 * -> { unattachedBytes, unattachedCount, attachedBytes, attachedCount, totalBytes }
 */
export function storageUse(recordings, runs, hasLocal = () => true) {
  let unattachedBytes = 0, unattachedCount = 0, attachedBytes = 0, attachedCount = 0;
  for (const r of recordings || []) { unattachedBytes += pos(r.bytes); unattachedCount++; }
  for (const run of runs || []) {
    for (const v of run.videos || []) {
      if (!v.localId || !hasLocal(v.localId)) continue;
      attachedBytes += pos(v.bytes); attachedCount++;
    }
  }
  return { unattachedBytes, unattachedCount, attachedBytes, attachedCount, totalBytes: unattachedBytes + attachedBytes };
}

// ---------- chunked upload ----------
/** The server could not be reached (as opposed to a refusal): worth retrying later. */
export const unreachable = (e) => ['offline', 'no_api', 'unavailable'].includes(e?.code) || e?.status === 0 || e?.status >= 500;

/**
 * Send `blob` from `offset` in chunks with putChunk(offset, slice) -> server view
 * ({ receivedBytes, status }). A 409 offset_mismatch (err.details.receivedBytes) moves to the
 * server's offset; a network error is retried `retries` times with a growing pause, then thrown so
 * the queue can try again later. Resolves to the last server view.
 */
export async function runChunkedUpload({ blob, offset = 0, chunkBytes = 4 * MB, putChunk, onProgress, signal, retries = 3, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const size = blob.size;
  let at = Math.max(0, offset), last = null, failures = 0;
  const step = Math.max(64 * 1024, chunkBytes);
  onProgress?.(at, size);
  while (at < size) {
    if (signal?.aborted) throw Object.assign(new Error('Upload paused.'), { code: 'aborted' });
    const end = Math.min(size, at + step);
    try {
      last = await putChunk(at, blob.slice(at, end));
      failures = 0;
      const got = Number(last?.receivedBytes);
      if (last?.status && last.status !== 'uploading') { onProgress?.(size, size); return last; }
      at = Number.isFinite(got) && got > at ? got : end;
    } catch (e) {
      const server = Number(e?.details?.receivedBytes);
      if (e?.code === 'offset_mismatch' && Number.isFinite(server)) { at = server; continue; }
      if (!unreachable(e)) throw e;
      if (++failures > retries) throw e;
      await wait(1000 * 2 ** (failures - 1));
    }
    onProgress?.(at, size);
  }
  return last;
}
