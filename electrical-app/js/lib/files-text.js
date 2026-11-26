// Text for filing: the first few thousand characters of a document, read on the device before it is
// uploaded, so the AI (or the keyword rules) can see "Notification of work… 12 Maple Cres" and not
// just "scan0001.pdf". Never throws: a file it can't read simply has no text.
//
//   PDF          the vendored pdf.js (vendor/pdfjs-4.10.38, isEvalSupported off), first pages only
//   DOCX / XLSX  their XML inside the ZIP, inflated with the browser's DecompressionStream
//   text, CSV, EML, RTF   read directly
import { TEXT_LIMIT, extOf } from './files-classify.js';

const PDFJS = new URL('../../vendor/pdfjs-4.10.38/', import.meta.url);
const PDF_PAGES = 4;
let pdfjsPromise = null;

/** The vendored pdf.js, loaded once (also used by the Files preview). */
export function loadPdfJs() {
  pdfjsPromise ||= import(new URL('pdf.min.js', PDFJS).href).then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.js', PDFJS).href;
    return lib;
  }).catch((e) => { pdfjsPromise = null; throw e; });
  return pdfjsPromise;
}

/** Collapse whitespace and cut to the limit. */
export const tidyText = (s, limit = TEXT_LIMIT) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, limit);

async function pdfText(file) {
  const lib = await loadPdfJs();
  // isEvalSupported: false keeps a crafted PDF from running script (CVE-2024-4367 class)
  const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  try {
    let out = '';
    for (let n = 1; n <= Math.min(pdf.numPages, PDF_PAGES) && out.length < TEXT_LIMIT; n++) {
      const page = await pdf.getPage(n);
      const tc = await page.getTextContent();
      out += ` ${tc.items.map((i) => i.str || '').join(' ')}`;
      page.cleanup();
    }
    return tidyText(out);
  } finally { pdf.destroy().catch(() => {}); }
}

// ---- a minimal ZIP reader (central directory + deflate), enough for Office XML -----------------

/** Entries of a ZIP: [{ name, method, size, offset }] from its central directory. */
export function zipEntries(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return [];
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = [];
  const dec = new TextDecoder();
  for (let k = 0; k < count && p + 46 <= bytes.length; k++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true);
    const size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
    const offset = v.getUint32(p + 42, true);
    out.push({ name: dec.decode(bytes.subarray(p + 46, p + 46 + nameLen)), method, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** The uncompressed bytes of one entry (stored or deflated). */
export async function zipRead(bytes, entry) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const p = entry.offset;
  if (v.getUint32(p, true) !== 0x04034b50) throw new Error('bad zip entry');
  const start = p + 30 + v.getUint16(p + 26, true) + v.getUint16(p + 28, true);
  const data = bytes.subarray(start, start + entry.size);
  if (entry.method === 0) return data;
  if (entry.method !== 8 || typeof DecompressionStream === 'undefined') throw new Error('unsupported compression');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Text runs out of Office XML (w:t, a:t, t elements and shared strings). */
export function xmlText(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<(?:w:t|a:t|t)(?:\s[^>]*)?>([^<]*)<\/(?:w:t|a:t|t)>/g)) out.push(m[1]);
  return out.join(' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

const OFFICE_PARTS = { docx: [/^word\/document\.xml$/], xlsx: [/^xl\/sharedStrings\.xml$/], pptx: [/^ppt\/slides\/slide\d+\.xml$/] };

async function officeText(file, ext) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const want = OFFICE_PARTS[ext];
  const entries = zipEntries(bytes).filter((e) => want.some((re) => re.test(e.name)) && e.size < 20 * 1024 * 1024).slice(0, 6);
  let out = '';
  for (const e of entries) {
    if (out.length >= TEXT_LIMIT) break;
    out += ` ${xmlText(new TextDecoder().decode(await zipRead(bytes, e)))}`;
  }
  return tidyText(out);
}

/**
 * Up to TEXT_LIMIT characters of a File's text, or '' when it has none we can read.
 * @param {File|Blob & { name?: string }} file
 */
export async function extractText(file) {
  try {
    const ext = extOf(file?.name);
    const type = String(file?.type || '');
    if (type === 'application/pdf' || ext === 'pdf') return await pdfText(file);
    if (OFFICE_PARTS[ext]) return await officeText(file, ext);
    if (/^text\//.test(type) || ['txt', 'csv', 'eml', 'md', 'log'].includes(ext)) return tidyText(await file.slice(0, 64 * 1024).text());
    if (ext === 'rtf') return tidyText((await file.slice(0, 64 * 1024).text()).replace(/\\[a-z]+-?\d* ?|[{}]/gi, ' '));
  } catch { /* unreadable: no text */ }
  return '';
}
