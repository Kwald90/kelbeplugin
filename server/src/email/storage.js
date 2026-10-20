// Mail files on disk: attachments, uploads and the original .eml of each inbound message.
// MAIL_DIR must be outside the code checkout and the web root; nginx never serves it. Files
// get random 128-bit names (mail_attachments.storage_key) in 256 sub-folders, are written
// once with mode 600, and are only ever read through the authenticated HQ endpoints.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STORAGE_KEY = /^[a-f0-9]{32}$/;
const REPO_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

/** Is `dir` inside the code checkout (and so maybe under a web root)? */
export function insideCheckout(dir) {
  const rel = relative(REPO_ROOT, resolve(dir));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The mail store, or null when MAIL_DIR is missing or unsafe. Locally and in tests an unset
 * MAIL_DIR falls back to a folder in the OS temp directory.
 * @param {{ mailDir: string, appEnv: string }} settings
 */
export function createMailStore(settings) {
  let dir = settings.mailDir;
  if (!dir && (settings.appEnv === 'local' || settings.appEnv === 'test')) dir = join(tmpdir(), 'fishtape-mail');
  if (!dir || !isAbsolute(dir) || insideCheckout(dir)) return null;
  const pathOf = (key) => {
    if (!STORAGE_KEY.test(String(key))) throw new Error('bad storage key');
    return join(dir, key.slice(0, 2), key);
  };
  return {
    dir,
    /** @param {Uint8Array} bytes @returns {Promise<{ key: string, size: number, sha256: string }>} */
    async save(bytes) {
      const key = randomBytes(16).toString('hex');
      await mkdir(join(dir, key.slice(0, 2)), { recursive: true, mode: 0o700 });
      await writeFile(pathOf(key), bytes, { flag: 'wx', mode: 0o600 });
      return { key, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
    },
    read(key) {
      return readFile(pathOf(key));
    },
    async remove(key) {
      try { await unlink(pathOf(key)); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
    },
    /** Every stored key with its modification time (the orphan sweep in inbox.js). */
    async list() {
      const out = [];
      let subs = [];
      try { subs = await readdir(dir); } catch { return out; }
      for (const s of subs) {
        if (!/^[a-f0-9]{2}$/.test(s)) continue;
        for (const name of await readdir(join(dir, s)).catch(() => [])) {
          if (!STORAGE_KEY.test(name)) continue;
          const st = await stat(join(dir, s, name)).catch(() => null);
          if (st) out.push({ key: name, mtimeMs: st.mtimeMs });
        }
      }
      return out;
    },
  };
}
