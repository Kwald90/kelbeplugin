// Walkthrough video store (migration 0168). The device uploads a recording; the bytes are
// streamed onto the media volume (reusing promotions.js receiveUpload, the same byte-sniffing and
// size cap as HQ media) and a row is inserted `processing`. The worker then transcodes it to a
// 720p H.264 MP4 with the moov atom up front (faststart, so it starts playing before it has fully
// downloaded) and grabs a poster frame, and marks the row `ready`.
//
// Pure, test-friendly pieces (views, ffmpeg arg building, probe parsing) are exported for unit
// tests; the route and the worker handler wire them to HTTP, the DB and ffmpeg.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { mediaPath, mediaSettings, receiveUpload } from './promotions.js';

/** Only video; posters are produced by ffmpeg, not uploaded. octet-stream is sniffed by bytes. */
export const WALKTHROUGH_UPLOAD_TYPES = ['video/mp4', 'video/webm', 'application/octet-stream'];
/** A generous ceiling so a stuck client can't fill the disk; one video per walkthrough in practice. */
export const MAX_MEDIA_PER_TENANT = 5000;
/** Longest side of the transcoded video. Portrait phone clips stay portrait; only the long edge is capped. */
export const MAX_DIMENSION = 1280;
/** Hard stop for a single transcode so a pathological file can't pin a worker slot forever. */
export const TRANSCODE_TIMEOUT_MS = 10 * 60_000;

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const execFileP = (cmd, args, opts) => new Promise((res, rej) => {
  execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
    if (err) { err.stderr = String(stderr || '').slice(-2000); rej(err); } else res({ stdout, stderr });
  });
});

/** Settings for the store (which dir, size caps). Shares MEDIA_DIR / MEDIA_MAX_VIDEO_MB with promotions. */
export function walkthroughMediaSettings(config, env = process.env) {
  return mediaSettings(config, env);
}

/** A random 32-hex media file name with the given extension (the only names nginx serves). */
export function randomMediaName(ext) {
  return `${randomBytes(16).toString('hex')}.${ext}`;
}

/**
 * What a media row looks like to the client. `url`/`posterUrl` are site-relative /media/ paths
 * (the client prefixes the API base in the iOS app); the caller never gets a path to anything but
 * an uploaded file. While still `processing`, an MP4 original can already play, so its url is
 * returned; a WebM original can't play on iOS, so url stays null until the MP4 output is ready.
 */
export function mediaRowView(row) {
  const out = {
    id: row.id,
    walkthroughId: row.walkthrough_id,
    status: row.status,
    durationMs: row.duration_ms ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    bytes: row.bytes == null ? null : Number(row.bytes),
    url: null,
    posterUrl: null,
    error: row.status === 'failed' ? (row.error || 'The video could not be processed.') : null,
  };
  if (row.status === 'ready' && row.output_file) {
    out.url = `/media/${row.output_file}`;
    if (row.poster_file) out.posterUrl = `/media/${row.poster_file}`;
  } else if (row.status === 'processing' && row.original_mime === 'video/mp4' && row.original_file) {
    out.url = `/media/${row.original_file}`; // iOS-recorded MP4 plays immediately while we optimise it
  }
  return out;
}

// ---- ffmpeg ----------------------------------------------------------------------------------

/**
 * ffmpeg args to transcode `input` to `output` as a web-friendly 720p-ish H.264/AAC MP4.
 * Downscales the long edge to MAX_DIMENSION without ever upscaling a smaller clip; +faststart
 * moves the index to the front for progressive playback. Exported so a test can assert the shape.
 */
export function transcodeArgs(input, output, { maxDim = MAX_DIMENSION } = {}) {
  // Escaped commas so the min() expressions aren't read as a filter separator (no shell here).
  const scale = `scale=min(${maxDim}\\,iw):min(${maxDim}\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2`;
  return [
    '-y', '-nostdin', '-i', input,
    '-vf', scale,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k',
    '-movflags', '+faststart', '-max_muxing_queue_size', '1024',
    output,
  ];
}

/** ffmpeg args to grab a single poster frame from `input` to `output` (a JPEG). */
export function posterArgs(input, output) {
  return ['-y', '-nostdin', '-ss', '0', '-i', input, '-frames:v', '1', '-q:v', '4', output];
}

/** Pull duration (ms) and the video stream's dimensions out of ffprobe -show_format -show_streams JSON. */
export function parseProbe(json) {
  let probe = json;
  if (typeof probe === 'string') { try { probe = JSON.parse(probe); } catch { return {}; } }
  const v = (probe?.streams || []).find((s) => s.codec_type === 'video') || {};
  const durationS = Number(probe?.format?.duration ?? v.duration);
  return {
    durationMs: Number.isFinite(durationS) ? Math.round(durationS * 1000) : null,
    width: Number.isFinite(Number(v.width)) ? Number(v.width) : null,
    height: Number.isFinite(Number(v.height)) ? Number(v.height) : null,
  };
}

/**
 * Transcode one uploaded file in `dir` to an optimised MP4 + poster. Returns the new file names
 * and the probed metadata. Does not touch the database; the caller records the result and removes
 * the original. Throws if ffmpeg/ffprobe fail or produce nothing.
 * @param {{ dir: string, inputFile: string }} o
 */
export async function transcodeWalkthrough({ dir, inputFile }) {
  const input = mediaPath(dir, inputFile);
  if (!input) throw new Error('bad input file name');
  const outputFile = randomMediaName('mp4');
  const posterFile = randomMediaName('jpg');
  const output = join(dir, outputFile);
  const poster = join(dir, posterFile);
  try {
    await execFileP(FFMPEG, transcodeArgs(input, output), { timeout: TRANSCODE_TIMEOUT_MS });
    const outStat = await stat(output);
    if (!outStat.size) throw new Error('ffmpeg produced an empty file');
    // Poster is best-effort: a missing one must not fail the whole video.
    let posterOk = true;
    try {
      await execFileP(FFMPEG, posterArgs(output, poster), { timeout: 60_000 });
      posterOk = (await stat(poster)).size > 0;
    } catch { posterOk = false; }
    let meta = {};
    try { meta = parseProbe((await execFileP(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', output])).stdout); } catch { /* keep nulls */ }
    return { outputFile, posterFile: posterOk ? posterFile : null, ...meta };
  } catch (e) {
    await unlink(output).catch(() => {});
    await unlink(poster).catch(() => {});
    throw e;
  }
}

/**
 * Stream an upload into the media dir as a walkthrough original (video only). Thin wrapper over
 * promotions.receiveUpload that rejects images (a walkthrough recording is always a video).
 */
export async function receiveWalkthroughUpload(stream, { dir, declaredType, contentLength, maxVideoBytes }) {
  const file = await receiveUpload(stream, { dir, declaredType, contentLength, maxVideoBytes, maxImageBytes: 0 });
  if (file.kind !== 'video') {
    await unlink(file.path).catch(() => {});
    const err = new Error('A walkthrough recording must be a video.');
    err.statusCode = 415; err.code = 'unsupported_media';
    throw err;
  }
  return file;
}

/** Remove a row's files from disk (ignore ENOENT). */
export async function removeMediaFiles(dir, row) {
  for (const name of [row.original_file, row.output_file, row.poster_file]) {
    if (!name) continue;
    const p = mediaPath(dir, name);
    if (p) await unlink(p).catch(() => {});
  }
}

// ---- worker ----------------------------------------------------------------------------------

/**
 * Worker handler for `walkthrough_transcode` jobs (queued by the upload route). Transcodes the
 * uploaded original into an optimised MP4 + poster and marks the row `ready`; on failure the row
 * is marked `failed` and the job is retried a couple of times. Runs in the general pool.
 * @param {{ config: object }} deps
 */
export function createWalkthroughMediaHandlers({ config }) {
  const media = walkthroughMediaSettings(config);
  return {
    walkthrough_transcode: async ({ db, job, log }) => {
      if (media.problem) throw new Error(`walkthrough media store unavailable: ${media.problem}`);
      const tenantId = job.tenant_id;
      const mediaId = job.payload?.mediaId;
      if (!tenantId || !mediaId) return { skipped: 'missing tenant or media id' };
      const row = await db.withTenant({ tenantId }, async (tx) =>
        (await tx.query('SELECT * FROM walkthrough_media WHERE id = $1', [mediaId])).rows[0]);
      if (!row) return { skipped: 'row gone' };
      if (row.status === 'ready') return { skipped: 'already ready' };
      if (!row.original_file) {
        await db.withTenant({ tenantId }, async (tx) =>
          tx.query("UPDATE walkthrough_media SET status = 'failed', error = 'No uploaded file to process.', updated_at = now() WHERE id = $1", [mediaId]), { write: true }).catch(() => {});
        return { skipped: 'no original' };
      }
      try {
        const res = await transcodeWalkthrough({ dir: media.dir, inputFile: row.original_file });
        await db.withTenant({ tenantId }, async (tx) => tx.query(
          `UPDATE walkthrough_media
              SET status = 'ready', output_file = $2, poster_file = $3,
                  duration_ms = COALESCE($4, duration_ms), width = $5, height = $6, error = NULL, updated_at = now()
            WHERE id = $1`,
          [mediaId, res.outputFile, res.posterFile, res.durationMs, res.width, res.height]), { write: true });
        // The optimised MP4 now stands in for the upload; drop the original to save disk.
        await removeMediaFiles(media.dir, { original_file: row.original_file });
        log?.info?.(`walkthrough_transcode ready ${mediaId}`);
        return { ok: true, outputFile: res.outputFile };
      } catch (e) {
        const message = String(e?.message || e).slice(0, 1000);
        await db.withTenant({ tenantId }, async (tx) =>
          tx.query("UPDATE walkthrough_media SET status = 'failed', error = $2, updated_at = now() WHERE id = $1 AND status <> 'ready'", [mediaId, message]), { write: true }).catch(() => {});
        throw e; // retried by the queue; after max_attempts the row stays `failed`
      }
    },
  };
}
