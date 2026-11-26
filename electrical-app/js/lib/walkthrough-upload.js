// Uploads a walkthrough recording to the server video store and reads its status back. The bytes
// go up as a raw body (not JSON, not the sync queue); session.js apiFetch adds the credentials
// (cookie on the web, Keychain bearer in the iOS app). The server streams it onto the media volume,
// transcodes it (worker) and serves the result from /media/. See routes/v1/walkthrough-media.js.
//
// Playback URLs are short-lived signed API paths (/api/v1/media/<id>/<video|poster>?c=&e=&s=, see
// server/src/services/media-url.js): job-site video is private and never served from disk. They come
// back with every media row (with urlExpiresAt); fetch the row again for a fresh one, and
// keepMediaFresh() does that by itself when a link expires mid-playback. mediaUrl() prefixes the
// API base in the iOS app, where the page is capacitor://localhost but the media is on the API origin.
import { apiFetch, API_BASE, ApiError } from '../session.js';

const PATH = '/api/v1/walkthrough-media';

/** Parse a JSON API response, throwing ApiError on failure (mirrors session.js request()). */
async function readJson(res) {
  const type = res.headers.get('content-type') || '';
  if (res.status === 204) return null;
  if (!type.includes('application/json')) {
    throw new ApiError(res.status, res.status >= 500 ? 'unavailable' : 'no_api', "The server isn't answering right now.");
  }
  let json = null;
  try { json = await res.json(); } catch { throw new ApiError(res.status, 'unavailable', 'The server sent an unreadable answer.'); }
  if (!res.ok) {
    const e = json?.error || {};
    throw new ApiError(res.status, e.code || 'error', e.message || 'Something went wrong.', e.details);
  }
  return json;
}

/**
 * Upload a recorded video. Returns the media row ({ id, status, url, posterUrl, durationMs, ... }).
 * The Content-Type is narrowed to video/mp4 or video/webm (the server matches on the base type).
 * @param {Blob} blob
 * @param {{ walkthroughId: string, durationMs?: number }} o
 */
export async function uploadWalkthroughVideo(blob, { walkthroughId, durationMs = 0 }) {
  if (!blob || !blob.size) throw new ApiError(0, 'no_video', 'There is nothing to upload.');
  const base = String(blob.type || '').split(';')[0].toLowerCase();
  const contentType = base === 'video/mp4' || base === 'video/webm' ? base : 'application/octet-stream';
  let res;
  try {
    res = await apiFetch(PATH, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'X-Fishtape': '1',
        'X-Walkthrough-Id': walkthroughId,
        'X-Duration-Ms': String(Math.max(0, Math.round(durationMs || 0))),
      },
      body: blob,
      credentials: 'include',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'offline', "Can't reach the server to upload the video.");
  }
  return readJson(res);
}

/** Current status + playback urls for an uploaded video. */
export async function fetchWalkthroughMedia(mediaId) {
  let res;
  try { res = await apiFetch(`${PATH}/${encodeURIComponent(mediaId)}`, { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'include', cache: 'no-store' }); }
  catch { throw new ApiError(0, 'offline', "Can't reach the server."); }
  return readJson(res);
}

/**
 * Ask the server to AI-transcribe a stored video (Gemini). Returns the media row with
 * transcribeStatus "processing"; poll fetchWalkthroughMedia() for the finished transcript.
 */
export async function transcribeWalkthroughVideo(mediaId) {
  let res;
  try {
    res = await apiFetch(`${PATH}/${encodeURIComponent(mediaId)}/transcribe`, {
      method: 'POST', headers: { 'X-Fishtape': '1', Accept: 'application/json' }, credentials: 'include', cache: 'no-store',
    });
  } catch { throw new ApiError(0, 'offline', "Can't reach the server to transcribe."); }
  return readJson(res);
}

/** Delete an uploaded video (its files and row). */
export async function deleteWalkthroughMedia(mediaId) {
  let res;
  try { res = await apiFetch(`${PATH}/${encodeURIComponent(mediaId)}`, { method: 'DELETE', headers: { 'X-Fishtape': '1', Accept: 'application/json' }, credentials: 'include', cache: 'no-store' }); }
  catch { throw new ApiError(0, 'offline', "Can't reach the server."); }
  return readJson(res);
}

/** Resolve a server media path (a signed /api/v1/media/... link) to a URL the page can load. */
export function mediaUrl(path) {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  return API_BASE ? API_BASE + path : path;
}

/**
 * Keep a <video> playing a signed server link past its expiry: when loading fails (an expired link
 * answers 401), fetch a fresh link with refetch() (a media row: { url }) and carry on from the same
 * moment, playing or paused as it was. At most one retry every 10 s, so a real failure still shows.
 * Returns a function that stops watching.
 * @param {HTMLVideoElement} video
 * @param {() => Promise<{ url?: string } | null>} refetch
 */
export function keepMediaFresh(video, refetch) {
  let last = 0;
  const onError = async () => {
    if (Date.now() - last < 10_000) return;
    last = Date.now();
    const at = video.currentTime || 0;
    const wasPlaying = !video.paused;
    let m = null;
    try { m = await refetch(); } catch { return; }
    if (!m?.url) return;
    video.addEventListener('loadedmetadata', () => {
      try { video.currentTime = at; } catch { /* not seekable yet */ }
      if (wasPlaying) video.play().catch(() => {});
    }, { once: true });
    video.src = mediaUrl(m.url);
  };
  video.addEventListener('error', onError);
  return () => video.removeEventListener('error', onError);
}
