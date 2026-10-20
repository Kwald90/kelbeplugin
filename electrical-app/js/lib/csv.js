// CSV in and out, plus a small XLSX reader, for imports and accounting exports. Pure (no DOM):
// the XLSX reader uses DecompressionStream('deflate-raw') (Safari 16.4+, Chrome 103+, Node 18+).
//
// parseCSV follows RFC 4180: quoted fields may hold commas, quotes ("") and line breaks; CRLF,
// LF and lone CR all end a row; a UTF-8 byte-order mark is dropped; the delimiter (comma,
// semicolon or tab) is detected from the first line unless given.

const BOM = '﻿';

/** The delimiter used by the first line of `text` outside quotes: ',', ';' or '\t'. */
export function detectDelimiter(text) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (let i = 0; i < text.length && i < 20000; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === '\n' || c === '\r')) break;
    else if (!quoted && c in counts) counts[c]++;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ',';
}

/**
 * An incremental parser: push() text as it arrives, get back the rows it completed; end()
 * returns the last row. Lets a big file be parsed in slices without freezing the page.
 */
export function createCsvParser({ delimiter } = {}) {
  let delim = delimiter || null;
  let field = '';
  let row = [];
  let quoted = false;
  let quoteSeen = false; // inside quotes, a " that may be the first of ""
  let pendingCR = false;
  let first = true;
  let rowHasData = false;

  function endField() { row.push(field); field = ''; }
  function endRow(out) {
    endField();
    if (rowHasData || row.length > 1 || row[0] !== '') out.push(row);
    row = []; rowHasData = false;
  }

  return {
    push(chunk) {
      let text = String(chunk ?? '');
      if (first && text) {
        if (text.startsWith(BOM)) text = text.slice(1);
        if (!delim) delim = detectDelimiter(text);
        first = false;
      }
      const out = [];
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (pendingCR) { pendingCR = false; if (c === '\n') continue; }
        if (quoted) {
          if (quoteSeen) {
            quoteSeen = false;
            if (c === '"') { field += '"'; continue; }
            quoted = false; // closing quote; fall through to treat c normally
          } else if (c === '"') { quoteSeen = true; continue; } else { field += c; continue; }
        }
        if (c === '"' && field === '' ) { quoted = true; rowHasData = true; continue; }
        if (c === delim) { endField(); rowHasData = true; continue; }
        if (c === '\n' || c === '\r') { endRow(out); if (c === '\r') pendingCR = true; continue; }
        field += c;
        rowHasData = true;
      }
      return out;
    },
    end() {
      const out = [];
      if (quoteSeen) { quoteSeen = false; quoted = false; }
      if (field !== '' || row.length || rowHasData) endRow(out);
      return out;
    },
    get delimiter() { return delim; },
  };
}

/** Parse a whole CSV text into rows (arrays of strings). Blank lines are dropped. */
export function parseCSV(text, opts = {}) {
  const p = createCsvParser(opts);
  return [...p.push(text), ...p.end()];
}

/**
 * Header row + records: { headers, rows } where rows are arrays aligned with headers.
 * Headers are trimmed; empty or repeated header names get a suffix so each is unique.
 */
export function withHeaders(rows) {
  const raw = rows[0] || [];
  const seen = new Map();
  const headers = raw.map((h, i) => {
    let name = String(h ?? '').trim() || `Column ${i + 1}`;
    const n = seen.get(name.toLowerCase()) || 0;
    seen.set(name.toLowerCase(), n + 1);
    if (n) name = `${name} (${n + 1})`;
    return name;
  });
  const body = rows.slice(1).filter((r) => r.some((v) => String(v ?? '').trim() !== ''));
  return { headers, rows: body };
}

// ---- writing ----------------------------------------------------------------------

const FORMULA = /^[=+@\t\r]/;
const NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * One CSV cell. Quotes when needed. `guard` defuses spreadsheet formulas in text (a cell
 * starting with = + @ or a non-number starting with -) by prefixing an apostrophe.
 */
export function csvCell(v, { guard = true } = {}) {
  if (v == null) return '';
  let s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v);
  if (guard && typeof v === 'string' && (FORMULA.test(s) || (s.startsWith('-') && !NUMBER.test(s)))) s = `'${s}`;
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows (arrays) to CSV text with CRLF line ends (RFC 4180; Excel and QuickBooks read it). */
export function toCSV(rows, opts = {}) {
  return rows.map((r) => r.map((v) => csvCell(v, opts)).join(',')).join('\r\n') + '\r\n';
}

/** Objects to CSV with the given columns: [{ key, label }] or header strings (key = label). */
export function objectsToCSV(objects, columns, opts = {}) {
  const cols = columns.map((c) => (typeof c === 'string' ? { key: c, label: c } : c));
  return toCSV([cols.map((c) => c.label), ...objects.map((o) => cols.map((c) => o[c.key]))], opts);
}

// ---- XLSX (first worksheet as rows) -----------------------------------------------

const td = new TextDecoder();

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot open .xlsx files. Save the sheet as CSV and import that.');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Entries of a zip file: Map name -> async () => Uint8Array. Stored and deflated entries only. */
export function unzipEntries(buffer) {
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This is not an .xlsx file (no zip directory found).');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = td.decode(u8.subarray(p + 46, p + 46 + nameLen));
    out.set(name, async () => {
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const data = u8.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflateRaw(data);
      throw new Error('This .xlsx uses a compression this app cannot read. Save it as CSV instead.');
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const xmlText = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENT[e] ?? m;
});
const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
const colIndex = (ref) => {
  const letters = /^[A-Z]+/.exec(ref || '')?.[0] || '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};
const BUILTIN_DATES = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Excel serial day (1900 system) to YYYY-MM-DD (plus time when there is one). */
export function excelSerialToISO(serial) {
  const ms = Math.round((Number(serial) - 25569) * 86400000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const iso = d.toISOString();
  return Number(serial) % 1 ? iso.slice(0, 16).replace('T', ' ') : iso.slice(0, 10);
}

/** Strings, date styles and first worksheet of an .xlsx as rows of strings. */
export async function readXlsx(buffer) {
  const zip = unzipEntries(buffer);
  const read = async (name) => (zip.has(name) ? td.decode(await zip.get(name)()) : null);
  const shared = [];
  const ss = await read('xl/sharedStrings.xml');
  if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push([...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => xmlText(t[1])).join(''));
  // Which cell styles are dates: built-in date formats, or custom ones with d/m/y in them.
  const dateStyles = new Set();
  const styles = await read('xl/styles.xml');
  if (styles) {
    const custom = new Map([...styles.matchAll(/<numFmt\s[^>]*>/g)].map((m) => [Number(attr(m[0], 'numFmtId')), xmlText(attr(m[0], 'formatCode') || '')]));
    const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] || '';
    [...xfs.matchAll(/<xf\s[^>]*?\/?>/g)].forEach((m, i) => {
      const id = Number(attr(m[0], 'numFmtId'));
      const code = custom.get(id) || '';
      if (BUILTIN_DATES.has(id) || (code && /[dmy]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]/g, '')) && !/^[#0.,%\s]*$/.test(code))) dateStyles.add(i);
    });
  }
  let sheetName = 'xl/worksheets/sheet1.xml';
  if (!zip.has(sheetName)) sheetName = [...zip.keys()].filter((k) => /^xl\/worksheets\/[^/]+\.xml$/.test(k)).sort()[0];
  if (!sheetName) throw new Error('No worksheet found in this .xlsx file.');
  const sheet = await read(sheetName);
  const rows = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    let next = 0;
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = `<c${cm[1]}>`;
      const ref = attr(tag, 'r');
      const idx = ref ? colIndex(ref) : next;
      next = idx + 1;
      const t = attr(tag, 't');
      const body = cm[2] || '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let val = '';
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((x) => xmlText(x[1])).join('');
      else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else if (v != null) {
        val = xmlText(v);
        const s = Number(attr(tag, 's'));
        if ((t === undefined || t === 'n') && dateStyles.has(s) && val !== '') val = excelSerialToISO(val);
      }
      while (row.length < idx) row.push('');
      row[idx] = val;
    }
    if (row.some((x) => x !== '')) rows.push(row);
  }
  return rows;
}

/** Is this file an .xlsx (zip) rather than text? Checks the PK signature. */
export function looksLikeXlsx(buffer) {
  const u8 = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  return u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04;
}

/** Text of a CSV file: UTF-8, falling back to Windows-1252 when the bytes are not valid UTF-8 (old Excel). */
export function decodeText(buffer) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { return new TextDecoder('windows-1252').decode(buffer); }
}

/** File bytes (CSV, TSV or XLSX) to rows. */
export async function rowsFromBuffer(buffer) {
  if (looksLikeXlsx(buffer)) return readXlsx(buffer);
  return parseCSV(decodeText(buffer));
}

/** Let the page breathe between chunks of work (iPad stays responsive on big files). */
export const yieldToUI = () => new Promise((r) => setTimeout(r, 0));
