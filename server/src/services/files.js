// Files store (migration 0185): where the bytes of each company's documents live, what may be stored,
// and how rows look to the PWA. The route (routes/v1/files.js) wires this to HTTP.
//
// Storage follows the HQ Mail store (email/storage.js), not the /media/ store: FILES_DIR must be
// outside the code checkout and is never under a web root or an nginx location. Files get random
// 128-bit names in 256 sub-folders, are written once with mode 600 and are only ever read back
// through the authenticated, company-scoped content route. Nothing here builds a URL to a file.
//
//   FILES_DIR          where files are written (locally/tests: a folder in the OS temp directory)
//   FILES_MAX_MB       largest single file, default 70 (under nginx's 72m /api/ request limit)
//   FILES_QUOTA_GB     a company's total, default 20 (Recently deleted counts until it is purged);
//                      FILES_QUOTA_MB instead, when set (small test servers)
//   FILES_TRASH_DAYS   days in Recently deleted before the worker purges a file, default 30
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { ApiError } from '../errors.js';
import { insideCheckout } from '../email/storage.js';
import { CATEGORY_IDS, MONEY_CATEGORIES, extOf, safeName } from '../../../electrical-app/js/lib/files-classify.js';

const MB = 1024 * 1024;
const GB = 1024 * MB;
export const STORAGE_KEY = /^[a-f0-9]{32}$/;
export const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Bytes read before deciding what a file is. */
export const SNIFF_BYTES = 8192;

const int = (v, d) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };

/**
 * Store settings. `problem` explains why uploads are off (FILES_DIR missing in staging/production,
 * relative, or inside the checkout).
 * @param {{ appEnv?: string, files?: object }} config
 */
export function filesSettings(config = {}, env = process.env) {
  let dir = env.FILES_DIR || '';
  if (!dir && ['local', 'test'].includes(config.appEnv)) dir = join(tmpdir(), 'fishtape-files');
  const s = {
    dir,
    maxFileBytes: int(env.FILES_MAX_MB, 70) * MB,
    // FILES_QUOTA_MB (when set) wins: small test and demo servers.
    quotaBytes: env.FILES_QUOTA_MB ? int(env.FILES_QUOTA_MB, 1) * MB : int(env.FILES_QUOTA_GB, 20) * GB,
    trashDays: int(env.FILES_TRASH_DAYS, 30),
    ...(config.files || {}),
  };
  s.problem = !s.dir ? 'FILES_DIR is not set, so file uploads are off.'
    : !isAbsolute(s.dir) ? 'FILES_DIR must be an absolute path.'
      : insideCheckout(s.dir) ? 'FILES_DIR must be outside the code checkout.' : null;
  return s;
}

export const fmtMb = (bytes) => `${Math.round(bytes / MB)} MB`;
export const fmtGb = (bytes) => (bytes < GB ? fmtMb(bytes) : `${Math.round((bytes / GB) * 10) / 10} GB`);
/** '820 KB', '12 MB' for audit summaries. */
export const fmtSize = (bytes) => (bytes < MB ? `${Math.max(1, Math.round(bytes / 1024))} KB` : fmtMb(bytes));

// ---- what may be stored --------------------------------------------------------------------------
// Checked by the first bytes, never by the name alone. Office documents are ZIP or OLE containers; the
// name picks which one. Text formats must be valid text with no markup that a browser would run.
// Anything a browser or OS could execute (HTML, SVG, scripts, programs) is refused.

const ZIP_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  zip: 'application/zip',
  pages: 'application/zip', numbers: 'application/zip', key: 'application/zip',
};
const OLE_TYPES = { doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint', msg: 'application/vnd.ms-outlook' };
const TEXT_TYPES = { txt: 'text/plain', csv: 'text/csv', eml: 'message/rfc822', md: 'text/plain', log: 'text/plain', dxf: 'image/vnd.dxf', rtf: 'application/rtf', json: 'application/json' };
/** Types a browser can show safely by itself (previews); everything else downloads. */
export const INLINE_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm', 'text/plain', 'text/csv']);

const startsWith = (b, sig, at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (b, from, to) => b.subarray(from, to).toString('latin1');

/** Does this text look like something a browser would run if it were ever rendered? */
export function looksActive(text) {
  return /<\s*(?:!doctype\s+html|html|head|body|script|iframe|svg|object|embed|meta|link|style|form)\b/i.test(text)
    || /\bjavascript\s*:/i.test(text);
}

function isText(head) {
  if (!head.length) return true;
  if (head.includes(0)) return false;
  // Valid UTF-8 (a truncated last character at the sniff boundary is fine).
  try { new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, Math.max(0, head.length - 4))); } catch { return false; }
  let ctrl = 0;
  for (const c of head) if (c < 9 || (c > 13 && c < 32)) ctrl++;
  return ctrl / head.length < 0.01;
}

/**
 * What a file is, from its first bytes and its name. Null when it may not be stored.
 * @param {Buffer} head the first SNIFF_BYTES (or the whole file if shorter)
 * @param {string} name
 * @returns {{ mime: string, ext: string } | null}
 */
export function sniffFile(head, name) {
  const ext = extOf(name);
  const b = head;
  if (startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { mime: 'application/pdf', ext: 'pdf' }; // %PDF-
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', ext: ext === 'jpeg' ? 'jpeg' : 'jpg' };
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', ext: 'png' };
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') return { mime: 'image/gif', ext: 'gif' };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a])) return { mime: 'image/tiff', ext: ext === 'tif' ? 'tif' : 'tiff' };
  if (ascii(b, 0, 2) === 'BM' && ext === 'bmp') return { mime: 'image/bmp', ext: 'bmp' };
  if (ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12).toLowerCase();
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return { mime: 'image/heic', ext: ext === 'heif' ? 'heif' : 'heic' };
    if (brand === 'avif') return { mime: 'image/avif', ext: 'avif' };
    if (brand.startsWith('qt')) return { mime: 'video/quicktime', ext: 'mov' };
    if (brand.startsWith('m4a') || ext === 'm4a') return { mime: 'audio/mp4', ext: 'm4a' };
    return { mime: 'video/mp4', ext: ext === 'm4v' ? 'm4v' : ext === 'mov' ? 'mov' : 'mp4' };
  }
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return { mime: 'video/webm', ext: 'webm' };
  if (ascii(b, 0, 3) === 'ID3' || startsWith(b, [0xff, 0xfb]) || startsWith(b, [0xff, 0xf3])) return { mime: 'audio/mpeg', ext: 'mp3' };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE') return { mime: 'audio/wav', ext: 'wav' };
  if (ascii(b, 0, 4) === 'OggS') return { mime: 'audio/ogg', ext: 'ogg' };
  if (ascii(b, 0, 4) === 'AC10' && ['dwg', ''].includes(ext)) return { mime: 'image/vnd.dwg', ext: 'dwg' };
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06])) {
    // ZIP containers: Office/OpenDocument files by name; a ZIP holding a program is still just a ZIP
    // (never opened by the server, always downloaded).
    if (ZIP_TYPES[ext]) return { mime: ZIP_TYPES[ext], ext };
    return { mime: 'application/zip', ext: 'zip' };
  }
  if (startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    if (OLE_TYPES[ext]) return { mime: OLE_TYPES[ext], ext };
    return null; // an unnamed OLE file could be anything (an .msi)
  }
  // Programs are refused whatever they are called: Windows, ELF, Mach-O, Java classes.
  if (ascii(b, 0, 2) === 'MZ' || startsWith(b, [0x7f, 0x45, 0x4c, 0x46]) || startsWith(b, [0xcf, 0xfa, 0xed, 0xfe])
    || startsWith(b, [0xfe, 0xed, 0xfa, 0xce]) || startsWith(b, [0xca, 0xfe, 0xba, 0xbe])) return null;
  if (ascii(b, 0, 5) === '{\\rtf') return { mime: 'application/rtf', ext: 'rtf' };
  if (TEXT_TYPES[ext] && isText(b)) {
    const text = b.toString('utf8');
    if (looksActive(text) && ext !== 'eml') return null;
    if (ext === 'json') return { mime: 'text/plain', ext: 'json' }; // never served as JSON
    return { mime: TEXT_TYPES[ext], ext };
  }
  return null;
}

/** The message for a refused type. */
export const UNSUPPORTED = 'That kind of file can’t be stored here. Files takes PDFs, photos and videos, Office documents, drawings (DWG/DXF), emails, text and ZIP files. It checks the contents, not just the name.';

// ---- the store -----------------------------------------------------------------------------------

/** Absolute path of a stored file, or throws on a bad key (no path built from anything else). */
export function storagePath(dir, key) {
  if (!STORAGE_KEY.test(String(key))) throw new Error('bad storage key');
  return join(dir, key.slice(0, 2), key);
}

/**
 * Stream an upload to FILES_DIR: size-capped while it arrives, sniffed from its first bytes, hashed.
 * Resolves to { key, path, bytes, sha256, mime, ext }. On any refusal nothing is left on disk.
 * @param {import('node:stream').Readable} stream
 * @param {{ dir: string, name: string, maxBytes: number, contentLength?: number|null }} o
 */
export async function receiveFile(stream, { dir, name, maxBytes, contentLength = null }) {
  const tooBig = () => new ApiError(413, 'too_large', `That file is too large. Each file can be up to ${fmtMb(maxBytes)}.`);
  if (contentLength != null && contentLength > maxBytes) throw tooBig();
  const key = randomBytes(16).toString('hex');
  const sub = join(dir, key.slice(0, 2));
  await mkdir(sub, { recursive: true, mode: 0o700 });
  const tmp = join(sub, `.upload-${key}.part`);
  const fh = await open(tmp, 'wx', 0o600);
  const hash = createHash('sha256');
  let bytes = 0, head = Buffer.alloc(0), type = null, done = false;

  const result = await new Promise((resolveP, rejectP) => {
    let writing = Promise.resolve();
    const fail = (e) => {
      if (done) return;
      done = true;
      stream.removeListener('data', onData);
      stream.pause();
      writing.finally(() => rejectP(e));
    };
    const write = (chunk) => {
      hash.update(chunk);
      writing = writing.then(() => fh.write(chunk));
      writing.catch(fail);
    };
    const decide = () => {
      type = sniffFile(head, name);
      if (!type) { fail(new ApiError(415, 'unsupported_media', UNSUPPORTED)); return false; }
      return true;
    };
    function onData(chunk) {
      if (done) return;
      bytes += chunk.length;
      if (bytes > maxBytes) { fail(tooBig()); return; }
      if (!type) {
        head = Buffer.concat([head, chunk]);
        if (head.length < SNIFF_BYTES) return;
        if (!decide()) return;
        write(head);
      } else write(chunk);
    }
    stream.on('data', onData);
    stream.once('error', () => fail(new ApiError(400, 'upload_failed', 'The upload was interrupted.')));
    stream.once('aborted', () => fail(new ApiError(400, 'upload_failed', 'The upload was interrupted.')));
    stream.once('end', () => {
      if (done) return;
      if (!bytes) { fail(new ApiError(400, 'empty_file', 'That file is empty.')); return; }
      if (!type) { if (!decide()) return; write(head); }
      done = true;
      writing.then(() => resolveP(type), rejectP);
    });
  }).catch(async (e) => {
    await fh.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw e;
  });

  await fh.close();
  await chmod(tmp, 0o600).catch(() => {});
  const path = storagePath(dir, key);
  await rename(tmp, path);
  return { key, path, bytes, sha256: hash.digest('hex'), mime: result.mime, ext: result.ext, head: head.subarray(0, SNIFF_BYTES) };
}

/** A read stream for a stored file plus its size (throws ENOENT when the bytes are gone). */
export async function openStored(dir, key) {
  const path = storagePath(dir, key);
  const s = await stat(path);
  return { stream: createReadStream(path), size: s.size };
}

export async function removeStored(dir, key) {
  try { await unlink(storagePath(dir, key)); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

/** Plain text of a text-like upload, for search and filing (the device sends PDF/Office text itself). */
export function textOf(head, mime) {
  if (!/^text\/|^message\/rfc822$|^application\/rtf$/.test(mime || '')) return '';
  let s = head.toString('utf8');
  if (mime === 'application/rtf') s = s.replace(/\\[a-z]+-?\d* ?|[{}]/gi, ' ');
  return s.replace(/\s+/g, ' ').trim().slice(0, 8000);
}

// ---- names, places and views ---------------------------------------------------------------------

/** The name from the X-File-Name header (URI-encoded UTF-8), made safe. */
export function headerName(raw, fallback = 'File') {
  let s = String(raw || '');
  try { s = decodeURIComponent(s); } catch { /* keep as sent */ }
  return safeName(s.slice(0, 400), fallback);
}

/** Can this person open files in this category? Quotes, invoices and contracts hold prices. */
export function canSeeCategory(p, category) {
  if (!MONEY_CATEGORIES.includes(category)) return true;
  return p.isManager || p.perms.has('invoices') || p.perms.has('estimates');
}
/** Company-level files (insurance, licences…) are for the office and foremen. */
export function canSeeCompanyFiles(p) {
  return p.isManager || p.perms.has('invoices') || p.perms.has('settings');
}
/** May this person see a row (file or folder)? */
export function canSeeRow(p, row) {
  if (row.category && !canSeeCategory(p, row.category)) return false;
  if (!row.client_id && !row.job_id && row.category && !canSeeCompanyFiles(p)) return false;
  return true;
}

export const validCategory = (c) => c == null || CATEGORY_IDS.includes(c);

const iso = (d) => (d ? new Date(d).toISOString() : null);

/** A files row as the PWA sees it. The storage key never leaves the server. */
export function fileView(r) {
  return {
    id: r.id, name: r.name, originalName: r.original_name, mime: r.mime, ext: r.ext, bytes: Number(r.bytes),
    sha256: r.sha256, clientId: r.client_id, jobId: r.job_id, category: r.category, folderId: r.folder_id,
    ai: r.ai || null, source: r.source, hasText: Boolean(r.text_excerpt), text: r.text_excerpt ? r.text_excerpt.slice(0, 600) : '',
    createdBy: r.created_by, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
    deletedAt: iso(r.deleted_at), deletedBy: r.deleted_by || null,
  };
}

export function folderView(r) {
  return {
    id: r.id, name: r.name, clientId: r.client_id, jobId: r.job_id, category: r.category, parentId: r.parent_id,
    createdBy: r.created_by, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

/** Content-Disposition with an ASCII fallback and the UTF-8 name (RFC 6266 / 5987). */
export function contentDisposition(kind, name) {
  const ascii = String(name || 'file').replace(/[^\x20-\x7e]+/g, '_').replace(/["\\]/g, '_').slice(0, 150) || 'file';
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(String(name || 'file')).slice(0, 600)}`;
}
