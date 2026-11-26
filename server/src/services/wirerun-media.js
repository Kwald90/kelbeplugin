// Wire-run video (migration 0184): the camera recording made while measuring a wire run with the
// AR tape, or a clip picked later. It reuses the walkthrough video store (walkthrough_media rows
// with owner_kind 'wirerun', the same media volume, transcode job and /media/ playback), and adds a
// resumable, chunked upload so a large recording survives a job site's patchy signal:
//
//   create   a row 'uploading' with the expected size and an empty partial file (.upload-<hex>.part)
//   chunk    raw bytes written at an offset; a chunk resent after a lost reply just rewrites the
//            same bytes, a chunk past the end of what arrived is refused with the server's offset
//   finish   when every byte is in: the head is sniffed (MP4 or WebM only), the partial renamed to
//            a random 32-hex name, the row 'processing', and walkthrough_transcode queued
//
// Pure pieces (views, offset rules, names) are exported for unit tests; routes/v1/wirerun-media.js
// wires them to HTTP and the database.
import { randomBytes } from 'node:crypto';
import { open, rename, stat, unlink } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { ApiError } from '../errors.js';
import { MEDIA_TYPES, sniffMedia } from './promotions.js';
import { mediaRowView, removeMediaFiles } from './walkthrough-media.js';

/** Largest chunk one request may carry. Small enough to read into memory, big enough to be quick. */
export const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
/** What the client is told to send per request. */
export const CHUNK_BYTES = 4 * 1024 * 1024;
/** Videos one wire run may hold (a run is measured a few times at most). */
export const MAX_VIDEOS_PER_RUN = 12;
/** Uploads left unfinished this long are dropped (row and partial file) the next time the company uploads. */
export const STALE_UPLOAD_MS = 7 * 24 * 3600 * 1000;
export const UPLOAD_MIMES = ['video/mp4', 'video/webm'];

const SNIFF_BYTES = 64;
const PART_RE = /^\.upload-[a-f0-9]{32}\.part$/;

/** A fresh partial-upload file name. Starts with a dot: nginx serves only 32-hex media names. */
export function uploadPartName() {
  return `.upload-${randomBytes(16).toString('hex')}.part`;
}

/** Absolute path of a partial upload inside dir, or null for anything that isn't one. */
export function uploadPartPath(dir, name) {
  if (typeof name !== 'string' || !PART_RE.test(name)) return null;
  const root = resolve(dir);
  const p = resolve(root, name);
  return p.startsWith(root + sep) ? p : null;
}

/** The client's view of a wire-run media row: the walkthrough view plus the run id and upload progress. */
export function wireRunMediaView(row) {
  const { walkthroughId, transcript, transcribeStatus, transcribeError, transcribedAt, ...v } = mediaRowView(row);
  void walkthroughId; void transcript; void transcribeStatus; void transcribeError; void transcribedAt;
  const uploading = row.status === 'uploading';
  return {
    ...v,
    wireRunId: row.walkthrough_id,
    mimeType: row.original_mime || row.upload_mime || null,
    receivedBytes: row.bytes == null ? 0 : Number(row.bytes),
    totalBytes: uploading ? Number(row.upload_total) : (row.bytes == null ? null : Number(row.bytes)),
    chunkBytes: uploading ? CHUNK_BYTES : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

/**
 * Check a new upload's declared size and type. Returns { totalBytes, mime } or throws ApiError.
 * @param {{ bytes: unknown, mimeType: unknown }} body
 * @param {{ maxVideoBytes: number }} limits
 */
export function checkNewUpload(body, { maxVideoBytes }) {
  const total = Number(body?.bytes);
  if (!Number.isSafeInteger(total) || total < SNIFF_BYTES) throw new ApiError(400, 'bad_request', 'Say how many bytes the video is.');
  if (total > maxVideoBytes) throw new ApiError(413, 'too_large', `That video is too large (limit ${Math.round(maxVideoBytes / (1024 * 1024))} MB).`);
  const mime = String(body?.mimeType || '').split(';')[0].trim().toLowerCase();
  if (mime && !UPLOAD_MIMES.includes(mime)) throw new ApiError(415, 'unsupported_media', 'Upload an MP4 or WebM video.');
  return { totalBytes: total, mime: mime || null };
}

/**
 * Where a chunk at `offset` of `length` bytes stands against what the row has received.
 * 'write'   new bytes (or a resend overlapping what arrived): write them
 * 'gap'     starts past the end of what arrived: refuse with the server's offset so the client resumes there
 * 'over'    would run past the declared size
 * 'empty'   no bytes
 */
export function chunkVerdict({ offset, length, received, total }) {
  if (!Number.isSafeInteger(offset) || offset < 0) return 'gap';
  if (!length) return 'empty';
  if (offset > received) return 'gap';
  if (offset + length > total) return 'over';
  return 'write';
}

/** Read a request body into one Buffer, refusing more than `max` bytes. */
export function readChunk(stream, max = MAX_CHUNK_BYTES) {
  return new Promise((resolveP, rejectP) => {
    const parts = [];
    let n = 0, done = false;
    const fail = (e) => { if (done) return; done = true; stream.removeListener('data', onData); stream.resume(); rejectP(e); };
    function onData(c) {
      n += c.length;
      if (n > max) { fail(new ApiError(413, 'too_large', `Send at most ${Math.round(max / (1024 * 1024))} MB per chunk.`)); return; }
      parts.push(c);
    }
    stream.on('data', onData);
    stream.once('error', () => fail(new ApiError(400, 'upload_failed', 'The upload was interrupted.')));
    stream.once('aborted', () => fail(new ApiError(400, 'upload_failed', 'The upload was interrupted.')));
    stream.once('end', () => { if (done) return; done = true; resolveP(Buffer.concat(parts, n)); });
  });
}

/**
 * The video type the first bytes say, or throw 415. `expected` (if set) must agree.
 * A QuickTime movie (ftyp brand 'qt  ', what an iPhone saves when a video is recorded or picked in
 * Safari) is accepted as MP4: it is the same ISO container, ffmpeg transcodes it like any other, and
 * a wire-run original is only ever played back by the app. HQ media still refuses QuickTime.
 */
export function sniffVideoHead(head, expected = null) {
  const quickTime = head?.length >= 12 && head.toString('latin1', 4, 8) === 'ftyp' && head.toString('latin1', 8, 12) === 'qt  ';
  const mime = quickTime ? 'video/mp4' : sniffMedia(head);
  if (!mime || MEDIA_TYPES[mime].kind !== 'video') {
    throw new ApiError(415, 'unsupported_media', 'That file is not an MP4 or WebM video (checked by its contents, not its name).');
  }
  if (expected && expected !== mime) throw new ApiError(415, 'unsupported_media', 'The file contents do not match its type.');
  return mime;
}

/** Create the empty partial file for a new upload (0644, never executable). Returns its name. */
export async function createUploadPart(dir) {
  const name = uploadPartName();
  const fh = await open(uploadPartPath(dir, name), 'wx', 0o644);
  await fh.close();
  return name;
}

/** Write `buf` at `offset` into a partial upload. Rewriting bytes that already arrived is harmless. */
export async function writeChunk(dir, name, offset, buf) {
  const p = uploadPartPath(dir, name);
  if (!p) throw new Error('bad upload file name');
  const fh = await open(p, 'r+');
  try {
    let at = 0;
    while (at < buf.length) {
      const { bytesWritten } = await fh.write(buf, at, buf.length - at, offset + at);
      at += bytesWritten;
    }
  } finally {
    await fh.close();
  }
}

/**
 * Turn a complete partial upload into a media file: check its size and its first bytes, then
 * rename it to a random 32-hex name with the right extension. Returns { fileName, mime } or throws
 * (ApiError for a bad file; ENOENT if another request already finished it).
 */
export async function finishUploadPart(dir, name, { totalBytes, expectedMime = null }) {
  const p = uploadPartPath(dir, name);
  if (!p) throw new Error('bad upload file name');
  const s = await stat(p);
  if (s.size !== totalBytes) throw new ApiError(409, 'incomplete', 'Some of the video is missing. Resume the upload.');
  const fh = await open(p, 'r');
  let head;
  try {
    head = Buffer.alloc(Math.min(SNIFF_BYTES, totalBytes));
    await fh.read(head, 0, head.length, 0);
  } finally { await fh.close(); }
  const mime = sniffVideoHead(head, expectedMime);
  const fileName = `${randomBytes(16).toString('hex')}.${MEDIA_TYPES[mime].ext}`;
  await rename(p, resolve(dir, fileName));
  return { fileName, mime };
}

/** Remove a row's partial upload and media files from disk (ignores files already gone). */
export async function removeWireRunMediaFiles(dir, row) {
  const part = uploadPartPath(dir, row.upload_file);
  if (part) await unlink(part).catch(() => {});
  await removeMediaFiles(dir, row);
}

