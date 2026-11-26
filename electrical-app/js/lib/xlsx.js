// A small, dependency-free .xlsx (Office Open XML spreadsheet) writer and reader.
//
// Writer: builds the minimum set of parts Excel, Google Sheets, Numbers and LibreOffice all open —
// workbook, one or more worksheets, styles, shared strings, and an optional picture per sheet —
// and packs them in a STORED (uncompressed) zip with CRC-32s. Supports what a printed form needs:
// merged cells, solid fills, borders (thin/medium/double/dotted…), fonts, alignment and wrap,
// column widths, row heights, hidden gridlines, print area and a fit-to-one-page print setup.
//
// Reader: opens an .xlsx (stored or deflated, as Excel and Google Sheets write it) and returns the
// first sheet's cell text and merged ranges. Deflate uses the platform's DecompressionStream
// ('deflate-raw': Safari 16.4+, Chrome 103+, Node 18+), so nothing is vendored.
//
// Pure: no DOM. Rows and columns are 0-based in the API; cell references are 'A1' style in XML.

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------------------
// CRC-32 and the zip container
// ---------------------------------------------------------------------------

let CRC_TABLE = null;
/** CRC-32 (IEEE 802.3, as zip uses) of a byte array. Returns an unsigned 32-bit number. */
export function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const toBytes = (d) => (d instanceof Uint8Array ? d : enc.encode(String(d)));

/** DOS date/time words for a Date (zip timestamps have 2-second resolution, years from 1980). */
function dosTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date(1980, 0, 1);
  const y = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Pack files into a STORED zip (no compression). files: [{ name, data: Uint8Array|string }].
 * Names are UTF-8 (general-purpose flag bit 11). Returns a Uint8Array.
 */
export function zipStore(files, { date } = {}) {
  const { time, date: dday } = dosTime(date || new Date(1980, 0, 1));
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = toBytes(f.data);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);        // version needed
    lv.setUint16(6, 0x0800, true);    // UTF-8 names
    lv.setUint16(8, 0, true);         // method: stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, dday, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    parts.push(local, data);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);        // version made by
    cv.setUint16(6, 20, true);        // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, dday, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    // extra len, comment len, disk no, internal attrs = 0; external attrs = 0
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);
    offset += local.length + data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== 'function') throw new Error('This browser can’t open compressed spreadsheets. Update it, or use Chrome or Safari 16.4+.');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Read a zip (stored or deflated entries) into a Map name -> Uint8Array. Sizes and offsets come
 * from the central directory, so entries written with data descriptors read correctly. Async
 * because deflate goes through DecompressionStream.
 */
export async function unzip(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file (no end-of-directory record).');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt zip central directory.');
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const localAt = v.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (v.getUint32(localAt, true) !== 0x04034b50) throw new Error('Corrupt zip local header.');
    const dataAt = localAt + 30 + v.getUint16(localAt + 26, true) + v.getUint16(localAt + 28, true);
    const raw = bytes.subarray(dataAt, dataAt + csize);
    if (method === 0) out.set(name, raw.slice());
    else if (method === 8) out.set(name, await inflateRaw(raw));
    else throw new Error(`Unsupported zip compression method ${method}.`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cell references
// ---------------------------------------------------------------------------

/** 0-based column index -> letters (0 -> A, 25 -> Z, 26 -> AA). */
export function colName(c) {
  let s = '';
  let n = c + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
/** 0-based row/col -> 'A1'. */
export const cellRef = (r, c) => `${colName(c)}${r + 1}`;
/** 'B12' -> { r: 11, c: 1 } (0-based); null for anything else. */
export function parseRef(ref) {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(String(ref || '').trim());
  if (!m) return null;
  let c = 0;
  for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { r: Number(m[2]) - 1, c: c - 1 };
}
/** 'A1:F3' -> { r1, c1, r2, c2 } (0-based, inclusive); a single ref is a 1×1 range. */
export function parseRange(ref) {
  const [a, b] = String(ref || '').split(':');
  const p = parseRef(a);
  const q = b ? parseRef(b) : p;
  if (!p || !q) return null;
  return { r1: Math.min(p.r, q.r), c1: Math.min(p.c, q.c), r2: Math.max(p.r, q.r), c2: Math.max(p.c, q.c) };
}
const rangeRef = (m) => `${cellRef(m.r1, m.c1)}:${cellRef(m.r2, m.c2)}`;

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

/** Escape text for XML element content / attribute values; drops characters XML 1.0 forbids. */
export function xmlEscape(s) {
  return String(s ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
export function xmlUnescape(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'amp') return '&';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** '#rgb' / '#rrggbb' -> 'FFRRGGBB' (opaque ARGB as SpreadsheetML wants), or null. */
export function argb(hex) {
  let m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (m) return 'FF' + m[1].toUpperCase();
  m = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(String(hex || ''));
  return m ? 'FF' + (m[1] + m[1] + m[2] + m[2] + m[3] + m[3]).toUpperCase() : null;
}

// ---------------------------------------------------------------------------
// Styles: a cell style is a plain object; the registry dedupes fonts/fills/borders/xfs.
//   { font: { bold, italic, size, color, name }, fill: '#d9d9d9',
//     border: { top, right, bottom, left } each 'thin'|'medium'|'thick'|'double'|'dotted'|'dashed'|'hair'
//             or { style, color },
//     align: { h: 'left'|'center'|'right', v: 'top'|'center'|'bottom', wrap: true } }
// ---------------------------------------------------------------------------

const BORDER_STYLES = new Set(['thin', 'medium', 'thick', 'double', 'dotted', 'dashed', 'hair', 'mediumDashed', 'dashDot']);

function styleRegistry(defaultFont) {
  const fonts = [];
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  const xfs = [];
  const idx = (list, xml) => { let i = list.indexOf(xml); if (i < 0) { list.push(xml); i = list.length - 1; } return i; };
  const fontXml = (f = {}) => {
    const g = { ...defaultFont, ...f };
    return `<font>${g.bold ? '<b/>' : ''}${g.italic ? '<i/>' : ''}<sz val="${Number(g.size) || 10}"/>`
      + `<color rgb="${argb(g.color) || 'FF000000'}"/><name val="${xmlEscape(g.name || 'Arial')}"/><family val="2"/></font>`;
  };
  idx(fonts, fontXml({}));
  const fillXml = (hex) => {
    const c = argb(hex);
    return c ? `<fill><patternFill patternType="solid"><fgColor rgb="${c}"/><bgColor indexed="64"/></patternFill></fill>` : null;
  };
  const edge = (tag, e) => {
    if (!e) return `<${tag}/>`;
    const style = typeof e === 'string' ? e : e.style;
    if (!BORDER_STYLES.has(style)) return `<${tag}/>`;
    const color = argb(typeof e === 'object' && e.color) || 'FF000000';
    return `<${tag} style="${style}"><color rgb="${color}"/></${tag}>`; // csp-ok: SpreadsheetML border XML inside the .xlsx, never inserted into the page
  };
  const borderXml = (b) => (b ? `<border>${edge('left', b.left)}${edge('right', b.right)}${edge('top', b.top)}${edge('bottom', b.bottom)}<diagonal/></border>` : null);
  idx(xfs, '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>');
  const cache = new Map();
  return {
    /** The cellXfs index for a style object (0 = default). */
    id(style) {
      if (!style) return 0;
      const key = JSON.stringify(style);
      if (cache.has(key)) return cache.get(key);
      const fontId = style.font ? idx(fonts, fontXml(style.font)) : 0;
      const fx = fillXml(style.fill);
      const fillId = fx ? idx(fills, fx) : 0;
      const bx = borderXml(style.border);
      const borderId = bx ? idx(borders, bx) : 0;
      const a = style.align || {};
      const align = (a.h || a.v || a.wrap || a.indent)
        ? `<alignment${a.h ? ` horizontal="${a.h}"` : ''}${a.v ? ` vertical="${a.v}"` : ''}${a.wrap ? ' wrapText="1"' : ''}${a.indent ? ` indent="${Number(a.indent) || 0}"` : ''}/>`
        : '';
      const xml = `<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"`
        + `${fontId ? ' applyFont="1"' : ''}${fillId ? ' applyFill="1"' : ''}${borderId ? ' applyBorder="1"' : ''}${align ? ' applyAlignment="1">' + align + '</xf>' : '/>'}`;
      const id = idx(xfs, xml);
      cache.set(key, id);
      return id;
    },
    xml() {
      return XML_HEAD + `<styleSheet xmlns="${NS_MAIN}">`
        + `<fonts count="${fonts.length}">${fonts.join('')}</fonts>`
        + `<fills count="${fills.length}">${fills.join('')}</fills>`
        + `<borders count="${borders.length}">${borders.join('')}</borders>`
        + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        + `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>`
        + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
        + '</styleSheet>';
    },
  };
}

// ---------------------------------------------------------------------------
// Images: size sniffing for the drawing anchor
// ---------------------------------------------------------------------------

/** { type: 'png'|'jpeg', width, height } for PNG / JPEG bytes, or null. */
export function imageInfo(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { type: 'png', width: v.getUint32(16), height: v.getUint32(20) };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = (b[i + 2] << 8) | b[i + 3];
      // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'jpeg', height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
      }
      i += 2 + len;
    }
  }
  return null;
}

/** 'data:image/png;base64,...' -> Uint8Array, or null for anything that isn't base64 PNG/JPEG. */
export function dataUrlBytes(url) {
  const m = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(url || ''));
  if (!m) return null;
  try {
    const bin = atob(m[2].replace(/\s+/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { return null; }
}

/** Excel column width (characters of the default font) -> pixels, as Excel lays it out. */
export const colWidthPx = (w) => Math.floor(((256 * w + Math.floor(128 / 7)) / 256) * 7);
const EMU_PER_PX = 9525;
const PT_PER_PX = 0.75;

// ---------------------------------------------------------------------------
// Workbook writer
// ---------------------------------------------------------------------------

/**
 * Build an .xlsx. spec:
 * {
 *   font: { name: 'Arial', size: 10 },            // workbook default font
 *   sheets: [{
 *     name,                                       // <= 31 chars, no []:*?/\
 *     cols: [width, ...],                         // character widths, by column
 *     rows: [{ height, cells: [{ v, s } | null] }],// v: string | number | null; s: style object
 *     merges: ['A1:B2' | { r1, c1, r2, c2 }],
 *     showGrid: false,
 *     print: { orientation: 'portrait', paper: 'letter'|'a4', fitToPage: true, area: true,
 *              margins: { left, right, top, bottom, header, footer }, centerH: true },
 *     images: [{ bytes, at: { col, row, xPx, yPx }, widthPx, heightPx, name }],
 *   }],
 * }
 * Every cell inside a merged range takes the range's top-left style, so borders draw on the
 * whole merged block in every app. Returns a Uint8Array (the zip).
 */
export function buildXlsx(spec) {
  const styles = styleRegistry(spec.font || { name: 'Arial', size: 10 });
  const strings = [];
  const stringIdx = new Map();
  const sst = (s) => { let i = stringIdx.get(s); if (i == null) { i = strings.length; strings.push(s); stringIdx.set(s, i); } return i; };
  const files = [];
  const sheetEntries = [];
  const contentOverrides = [];
  const usedNames = new Set();
  let imageNo = 0;
  let drawingNo = 0;

  (spec.sheets || []).forEach((sh, si) => {
    const n = si + 1;
    let name = String(sh.name || `Sheet${n}`).replace(/[[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || `Sheet${n}`;
    while (usedNames.has(name.toLowerCase())) name = `${name.slice(0, 28)} ${n}`;
    usedNames.add(name.toLowerCase());
    const rows = (sh.rows || []).map((r) => ({ height: r?.height, cells: (r?.cells || []).slice() }));
    const merges = (sh.merges || []).map((m) => (typeof m === 'string' ? parseRange(m) : m)).filter(Boolean);
    // Spread each merge's anchor style over the whole range (so the block's borders draw).
    for (const m of merges) {
      const anchor = rows[m.r1]?.cells?.[m.c1];
      const s = anchor ? anchor.s : null;
      for (let r = m.r1; r <= m.r2; r++) {
        if (!rows[r]) rows[r] = { cells: [] };
        for (let c = m.c1; c <= m.c2; c++) {
          if (r === m.r1 && c === m.c1) continue;
          rows[r].cells[c] = { v: null, s };
        }
      }
    }
    let maxC = (sh.cols || []).length - 1;
    for (const r of rows) if (r) maxC = Math.max(maxC, r.cells.length - 1);
    const maxR = rows.length - 1;
    const lastRef = cellRef(Math.max(0, maxR), Math.max(0, maxC));

    const rowXml = rows.map((r, ri) => {
      if (!r) return '';
      const cells = r.cells.map((cell, ci) => {
        if (!cell) return '';
        const s = styles.id(cell.s);
        const ref = cellRef(ri, ci);
        const sAttr = s ? ` s="${s}"` : '';
        if (cell.v == null || cell.v === '') return `<c r="${ref}"${sAttr}/>`;
        if (typeof cell.v === 'number' && Number.isFinite(cell.v)) return `<c r="${ref}"${sAttr}><v>${cell.v}</v></c>`;
        return `<c r="${ref}"${sAttr} t="s"><v>${sst(String(cell.v))}</v></c>`;
      }).join('');
      const ht = Number(r.height) > 0 ? ` ht="${Number(r.height)}" customHeight="1"` : '';
      return `<row r="${ri + 1}"${ht}>${cells}</row>`;
    }).join('');

    const pr = sh.print || {};
    const fit = pr.fitToPage !== false && !!sh.print;
    const cols = (sh.cols || []).map((w, ci) => (Number(w) > 0 ? `<col min="${ci + 1}" max="${ci + 1}" width="${Number(w)}" customWidth="1"/>` : '')).join('');
    const mg = { left: 0.4, right: 0.4, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2, ...(pr.margins || {}) };
    const images = (sh.images || []).filter((im) => im && imageInfo(im.bytes));
    const sheetRels = [];
    let drawingXml = '';
    if (images.length) {
      drawingNo += 1;
      const drawRels = [];
      const anchors = images.map((im, k) => {
        const info = imageInfo(im.bytes);
        imageNo += 1;
        const ext = info.type === 'png' ? 'png' : 'jpeg';
        files.push({ name: `xl/media/image${imageNo}.${ext}`, data: im.bytes });
        drawRels.push(`<Relationship Id="rId${k + 1}" Type="${REL_TYPE}/image" Target="../media/image${imageNo}.${ext}"/>`);
        const w = Math.round((Number(im.widthPx) || info.width) * EMU_PER_PX);
        const hgt = Math.round((Number(im.heightPx) || info.height) * EMU_PER_PX);
        const at = im.at || {};
        return '<xdr:oneCellAnchor>'
          + `<xdr:from><xdr:col>${at.col || 0}</xdr:col><xdr:colOff>${Math.round((at.xPx || 0) * EMU_PER_PX)}</xdr:colOff>`
          + `<xdr:row>${at.row || 0}</xdr:row><xdr:rowOff>${Math.round((at.yPx || 0) * EMU_PER_PX)}</xdr:rowOff></xdr:from>`
          + `<xdr:ext cx="${w}" cy="${hgt}"/>`
          + '<xdr:pic><xdr:nvPicPr>'
          + `<xdr:cNvPr id="${k + 2}" name="${xmlEscape(im.name || `Picture ${k + 1}`)}"/>`
          + '<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>'
          + `<xdr:blipFill><a:blip r:embed="rId${k + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>`
          + `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${w}" cy="${hgt}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>`
          + '</xdr:pic><xdr:clientData/></xdr:oneCellAnchor>';
      });
      files.push({
        name: `xl/drawings/drawing${drawingNo}.xml`,
        data: XML_HEAD + '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" '
          + `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS_REL}">${anchors.join('')}</xdr:wsDr>`,
      });
      files.push({ name: `xl/drawings/_rels/drawing${drawingNo}.xml.rels`, data: XML_HEAD + `<Relationships xmlns="${NS_PKG_REL}">${drawRels.join('')}</Relationships>` });
      contentOverrides.push(`<Override PartName="/xl/drawings/drawing${drawingNo}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);
      sheetRels.push(`<Relationship Id="rId1" Type="${REL_TYPE}/drawing" Target="../drawings/drawing${drawingNo}.xml"/>`);
      drawingXml = '<drawing r:id="rId1"/>';
    }

    // Element order is fixed by the schema (CT_Worksheet): sheetPr, dimension, sheetViews,
    // sheetFormatPr, cols, sheetData, mergeCells, printOptions, pageMargins, pageSetup, drawing.
    const xml = XML_HEAD + `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`
      + (fit ? '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' : '')
      + `<dimension ref="A1:${lastRef}"/>`
      + `<sheetViews><sheetView${sh.showGrid === false ? ' showGridLines="0"' : ''} workbookViewId="0"/></sheetViews>`
      + '<sheetFormatPr defaultRowHeight="15"/>'
      + (cols ? `<cols>${cols}</cols>` : '')
      + `<sheetData>${rowXml}</sheetData>`
      + (merges.length ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${rangeRef(m)}"/>`).join('')}</mergeCells>` : '')
      + (sh.print ? `<printOptions${pr.centerH !== false ? ' horizontalCentered="1"' : ''}/>` : '')
      + `<pageMargins left="${mg.left}" right="${mg.right}" top="${mg.top}" bottom="${mg.bottom}" header="${mg.header}" footer="${mg.footer}"/>`
      + (sh.print ? `<pageSetup paperSize="${pr.paper === 'a4' ? 9 : 1}" orientation="${pr.orientation === 'landscape' ? 'landscape' : 'portrait'}"${fit ? ' fitToWidth="1" fitToHeight="1"' : ''}/>` : '')
      + drawingXml
      + '</worksheet>';
    files.push({ name: `xl/worksheets/sheet${n}.xml`, data: xml });
    if (sheetRels.length) files.push({ name: `xl/worksheets/_rels/sheet${n}.xml.rels`, data: XML_HEAD + `<Relationships xmlns="${NS_PKG_REL}">${sheetRels.join('')}</Relationships>` });
    contentOverrides.push(`<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
    sheetEntries.push({ name, n, area: sh.print && pr.area !== false ? `'${name.replace(/'/g, "''")}'!$A$1:$${colName(Math.max(0, maxC))}$${Math.max(1, maxR + 1)}` : null });
  });

  const workbook = XML_HEAD + `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`
    + '<bookViews><workbookView/></bookViews>'
    + `<sheets>${sheetEntries.map((s) => `<sheet name="${xmlEscape(s.name)}" sheetId="${s.n}" r:id="rId${s.n}"/>`).join('')}</sheets>`
    + (sheetEntries.some((s) => s.area) ? `<definedNames>${sheetEntries.filter((s) => s.area).map((s) => `<definedName name="_xlnm.Print_Area" localSheetId="${s.n - 1}">${xmlEscape(s.area)}</definedName>`).join('')}</definedNames>` : '')
    + '</workbook>';
  const k = sheetEntries.length;
  const wbRels = XML_HEAD + `<Relationships xmlns="${NS_PKG_REL}">`
    + sheetEntries.map((s) => `<Relationship Id="rId${s.n}" Type="${REL_TYPE}/worksheet" Target="worksheets/sheet${s.n}.xml"/>`).join('')
    + `<Relationship Id="rId${k + 1}" Type="${REL_TYPE}/styles" Target="styles.xml"/>`
    + `<Relationship Id="rId${k + 2}" Type="${REL_TYPE}/sharedStrings" Target="sharedStrings.xml"/>`
    + '</Relationships>';
  const sstXml = XML_HEAD + `<sst xmlns="${NS_MAIN}" count="${strings.length}" uniqueCount="${strings.length}">`
    + strings.map((s) => `<si><t xml:space="preserve">${xmlEscape(s)}</t></si>`).join('') + '</sst>';
  const types = XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Default Extension="png" ContentType="image/png"/>'
    + '<Default Extension="jpeg" ContentType="image/jpeg"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + contentOverrides.join('')
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
    + '</Types>';
  const rootRels = XML_HEAD + `<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${REL_TYPE}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  return zipStore([
    { name: '[Content_Types].xml', data: types },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
    { name: 'xl/styles.xml', data: styles.xml() },
    { name: 'xl/sharedStrings.xml', data: sstXml },
    ...files,
  ], { date: spec.date });
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** A safe .xlsx file name from free text ("LP-2 / Garage" -> "LP-2 - Garage.xlsx"). */
export function xlsxFileName(name, fallback = 'Sheet') {
  const base = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '-').replace(/\s+/g, ' ').replace(/^[.\s-]+|[.\s-]+$/g, '').slice(0, 100);
  return `${base || fallback}.xlsx`;
}

// ---------------------------------------------------------------------------
// Reader (first sheet: cell text + merges)
// ---------------------------------------------------------------------------

const attr = (tagText, name) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tagText);
  return m ? xmlUnescape(m[1]) : null;
};
/** All <t> text inside a fragment (shared string items may be split into rich-text runs). */
const textOf = (frag) => {
  let s = '';
  const re = /<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>|<(?:\w+:)?t(?:\s[^>]*)?\/>/g;
  let m;
  while ((m = re.exec(frag))) s += m[1] ? xmlUnescape(m[1]) : '';
  return s;
};
const resolvePath = (base, target) => {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
};

/**
 * Read an .xlsx and return its first worksheet as
 *   { name, cells: Map('r:c' -> text), merges: [{ r1, c1, r2, c2 }], maxRow, maxCol }
 * (0-based). Numbers come back as their stored text ("15"); booleans as TRUE/FALSE.
 */
export async function readXlsx(input) {
  const files = await unzip(input);
  const text = (p) => (files.has(p) ? dec.decode(files.get(p)) : null);
  const wb = text('xl/workbook.xml');
  if (!wb) throw new Error('Not an Excel workbook (no xl/workbook.xml).');
  const firstSheet = /<(?:\w+:)?sheet\b([^>]*)\/?>/.exec(wb);
  if (!firstSheet) throw new Error('The workbook has no sheets.');
  const sheetName = attr(firstSheet[1], 'name') || 'Sheet1';
  const rid = attr(firstSheet[1], 'r:id') || attr(firstSheet[1], '[\\w]+:id');
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const rels = text('xl/_rels/workbook.xml.rels');
  if (rels && rid) {
    const re = /<Relationship\b([^>]*)\/?>/g;
    let m;
    while ((m = re.exec(rels))) {
      if (attr(m[1], 'Id') === rid) { sheetPath = resolvePath('xl/workbook.xml', attr(m[1], 'Target') || ''); break; }
    }
  }
  const sheet = text(sheetPath);
  if (!sheet) throw new Error('The first sheet could not be read.');
  const shared = [];
  const sstText = text('xl/sharedStrings.xml');
  if (sstText) {
    const re = /<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>|<(?:\w+:)?si\b[^>]*\/>/g;
    let m;
    while ((m = re.exec(sstText))) shared.push(m[1] ? textOf(m[1].replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '')) : '');
  }
  const cells = new Map();
  let maxRow = -1;
  let maxCol = -1;
  const cre = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
  let m;
  while ((m = cre.exec(sheet))) {
    const ref = parseRef(attr(m[1], 'r'));
    if (!ref || m[2] == null) continue;
    const t = attr(m[1], 't');
    const vm = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(m[2]);
    let v = '';
    if (t === 's') v = shared[Number(vm ? vm[1] : -1)] ?? '';
    else if (t === 'inlineStr') v = textOf(m[2]);
    else if (t === 'b') v = vm && vm[1] === '1' ? 'TRUE' : 'FALSE';
    else v = vm ? xmlUnescape(vm[1]) : '';
    if (v === '') continue;
    cells.set(`${ref.r}:${ref.c}`, v);
    maxRow = Math.max(maxRow, ref.r);
    maxCol = Math.max(maxCol, ref.c);
  }
  const merges = [];
  const mre = /<(?:\w+:)?mergeCell\b([^>]*)\/?>/g;
  while ((m = mre.exec(sheet))) {
    const r = parseRange(attr(m[1], 'ref'));
    if (r) { merges.push(r); maxRow = Math.max(maxRow, r.r2); maxCol = Math.max(maxCol, r.c2); }
  }
  return { name: sheetName, cells, merges, maxRow, maxCol };
}
