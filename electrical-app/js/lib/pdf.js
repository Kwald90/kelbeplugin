// A small PDF writer with no dependencies. It does what field reports need:
// text in the two standard Helvetica faces (no font embedding, WinAnsi
// encoding), lines, rectangles and embedded JPEG photos (DCTDecode, so the
// JPEG bytes go in as they are). Pure: runs in the browser and in Node.
//
//   const doc = createPdf({ title: 'Kitchen feed' });
//   const flow = createFlow(doc);            // cursor layout with page breaks
//   flow.heading('Kitchen feed'); flow.table({ columns, rows });
//   const bytes = doc.toBytes();             // Uint8Array, starts with %PDF-1.4
//
// Coordinates in this API are points (1/72 in) from the TOP-LEFT of the page,
// y growing downwards; text y is the baseline. They are flipped on output.

export const PAGE_SIZES = { letter: [612, 792], a4: [595.28, 841.89], legal: [612, 1008] };

// Glyph widths (1/1000 em) for character codes 32..126, from Adobe's AFM files
// for the standard 14 fonts (Helvetica, Helvetica-Bold), WinAnsi order.
const W_REG = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const W_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
// WinAnsi codes above 126 that we map from Unicode, with [regular, bold] widths.
const HIGH = {
  0x20ac: [128, 556, 556], 0x2026: [133, 1000, 1000], 0x2022: [149, 350, 350], 0x2013: [150, 556, 556],
  0x2014: [151, 1000, 1000], 0x2018: [145, 222, 278], 0x2019: [146, 222, 278], 0x201c: [147, 333, 500],
  0x201d: [148, 333, 500], 0x2122: [153, 1000, 1000],
};
// Look-alikes with no WinAnsi glyph.
const SUBST = { 0x2032: "'", 0x2033: '"', 0x2212: '-', 0x2010: '-', 0x2011: '-', 0x00a0: ' ', 0x2009: ' ', 0x202f: ' ' };

const FONTS = { regular: { id: 'F1', base: 'Helvetica', w: W_REG }, bold: { id: 'F2', base: 'Helvetica-Bold', w: W_BOLD } };

/** Unicode string -> array of WinAnsi codes ('?' for anything it can't show). */
export function toWinAnsi(str) {
  const out = [];
  for (const ch of String(str ?? '')) {
    let cp = ch.codePointAt(0);
    if (SUBST[cp]) cp = SUBST[cp].charCodeAt(0);
    if (cp === 9) cp = 32;
    if (cp >= 32 && cp <= 126) out.push(cp);
    else if (HIGH[cp]) out.push(HIGH[cp][0]);
    else if (cp >= 160 && cp <= 255) out.push(cp); // Latin-1 block is the same in WinAnsi
    else if (cp >= 32) out.push(63);
  }
  return out;
}

const HIGH_BY_CODE = Object.fromEntries(Object.values(HIGH).map(([code, r, b]) => [code, [r, b]]));
// Latin-1 letters: use the width of the plain letter (é -> e). Close enough for layout.
const LATIN_BASE = 'AAAAAAACEEEEIIIIDNOOOOOxOUUUUYTsaaaaaaaceeeeiiiidnooooo/ouuuuyty';

function glyphWidth(code, bold) {
  const w = bold ? W_BOLD : W_REG;
  if (code >= 32 && code <= 126) return w[code - 32];
  if (HIGH_BY_CODE[code]) return HIGH_BY_CODE[code][bold ? 1 : 0];
  if (code === 176) return 400; // degree
  if (code === 183) return 278; // middle dot
  if (code === 215 || code === 177) return 584; // multiply, plus-minus
  if (code >= 192 && code <= 255) return w[LATIN_BASE.charCodeAt(code - 192) - 32];
  return 556;
}

/** Width of `str` in points at `size`. */
export function textWidth(str, size = 10, bold = false) {
  let t = 0;
  for (const c of toWinAnsi(str)) t += glyphWidth(c, bold);
  return (t * size) / 1000;
}

/** Break text into lines no wider than `width` (respects \n, splits long words). */
export function wrapText(str, width, size = 10, bold = false) {
  const lines = [];
  for (const para of String(str ?? '').split(/\r?\n/)) {
    const words = para.split(/ +/);
    let line = '';
    for (let word of words) {
      const tryLine = line ? `${line} ${word}` : word;
      if (textWidth(tryLine, size, bold) <= width) { line = tryLine; continue; }
      if (line) { lines.push(line); line = ''; }
      while (textWidth(word, size, bold) > width && word.length > 1) {
        let n = word.length - 1;
        while (n > 1 && textWidth(word.slice(0, n), size, bold) > width) n--;
        lines.push(word.slice(0, n));
        word = word.slice(n);
      }
      line = word;
    }
    lines.push(line);
  }
  return lines;
}

/** PDF literal string body: WinAnsi bytes, with ( ) \ escaped and non-ASCII as octal. */
export function pdfString(str) {
  let s = '';
  for (const c of toWinAnsi(str)) {
    if (c === 40 || c === 41 || c === 92) s += '\\' + String.fromCharCode(c);
    else if (c < 32 || c > 126) s += '\\' + c.toString(8).padStart(3, '0');
    else s += String.fromCharCode(c);
  }
  return s;
}

/** Info-dictionary text string as UTF-16BE hex with a BOM (any language). */
function pdfTextHex(str) {
  let hex = 'FEFF';
  for (let i = 0; i < String(str).length; i++) hex += String(str).charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}

const num = (n) => {
  const v = Math.round(Number(n) * 100) / 100;
  return Object.is(v, -0) ? '0' : String(v);
};

function rgb(color) {
  if (Array.isArray(color)) return color.map((c) => num(c)).join(' ');
  const m = /^#?([0-9a-f]{6})$/i.exec(String(color || '#000000'));
  const n = m ? parseInt(m[1], 16) : 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => num(c / 255)).join(' ');
}

// ---------- JPEG ----------
/** data:image/jpeg;base64,... or base64 string -> Uint8Array. */
export function dataUrlToBytes(src) {
  const b64 = String(src).replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/** Read width, height and colour components from a JPEG's SOF marker, or null if it isn't a JPEG. */
export function jpegInfo(bytes) {
  if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2, adobe = false;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break;
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker === 0xee && bytes[i + 4] === 0x41 && bytes[i + 5] === 0x64) adobe = true; // APP14 "Adobe"
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF && i + 9 < bytes.length) {
      return {
        bits: bytes[i + 4],
        height: (bytes[i + 5] << 8) | bytes[i + 6],
        width: (bytes[i + 7] << 8) | bytes[i + 8],
        components: bytes[i + 9],
        adobe,
      };
    }
    i += 2 + len;
  }
  return null;
}

// ---------- document ----------
/**
 * createPdf({ size: 'letter'|'a4'|[w,h], title, author, subject, creator, date }) -> doc
 * doc.addPage(), doc.text(), doc.line(), doc.rect(), doc.image(), doc.addJpeg(), doc.toBytes()
 */
export function createPdf(opts = {}) {
  const [W, H] = Array.isArray(opts.size) ? opts.size : PAGE_SIZES[opts.size || 'letter'] || PAGE_SIZES.letter;
  const pages = [];
  const images = [];
  const jpegCache = new Map();
  let page = null;

  const doc = {
    width: W,
    height: H,
    get pages() { return pages; },
    get page() { return page; },
    get pageIndex() { return pages.indexOf(page); },

    addPage() {
      page = { ops: [], images: new Set() };
      pages.push(page);
      return page;
    },
    /** Switch drawing to an existing page (e.g. to add footers at the end). */
    usePage(i) { page = pages[i]; return page; },

    textWidth,
    wrap: wrapText,

    /** text(str, x, y, { size, bold, color, align: 'left'|'right'|'center' }); y is the baseline. */
    text(str, x, y, { size = 10, bold = false, color = '#1c1b19', align = 'left' } = {}) {
      if (str == null || str === '') return doc;
      const s = String(str);
      const w = textWidth(s, size, bold);
      const dx = align === 'right' ? -w : align === 'center' ? -w / 2 : 0;
      const f = bold ? FONTS.bold : FONTS.regular;
      cur().ops.push(`BT /${f.id} ${num(size)} Tf ${rgb(color)} rg ${num(x + dx)} ${num(H - y)} Td (${pdfString(s)}) Tj ET`);
      return doc;
    },

    /** line(x1, y1, x2, y2, { width, color, dash: [on, off] }) */
    line(x1, y1, x2, y2, { width = 0.75, color = '#1c1b19', dash = null } = {}) {
      const d = dash ? `[${dash.map(num).join(' ')}] 0 d ` : '';
      cur().ops.push(`q ${num(width)} w ${rgb(color)} RG ${d}${num(x1)} ${num(H - y1)} m ${num(x2)} ${num(H - y2)} l S Q`);
      return doc;
    },

    /** rect(x, y, w, h, { fill, stroke, width }); x, y is the top-left corner. */
    rect(x, y, w, h, { fill = null, stroke = null, width = 0.75 } = {}) {
      if (!fill && !stroke) stroke = '#1c1b19';
      const op = fill && stroke ? 'B' : fill ? 'f' : 'S';
      const parts = ['q'];
      if (fill) parts.push(`${rgb(fill)} rg`);
      if (stroke) parts.push(`${num(width)} w ${rgb(stroke)} RG`);
      parts.push(`${num(x)} ${num(H - y - h)} ${num(w)} ${num(h)} re ${op} Q`);
      cur().ops.push(parts.join(' '));
      return doc;
    },

    /**
     * Register a JPEG (bytes or data URL). Returns { id, width, height } or null if it
     * isn't a baseline/progressive JPEG we can embed. Reuse the result to draw it twice.
     */
    addJpeg(src) {
      if (typeof src === 'string' && jpegCache.has(src)) return jpegCache.get(src);
      const bytes = src instanceof Uint8Array ? src : dataUrlToBytes(src);
      const info = jpegInfo(bytes);
      if (!info || !info.width || !info.height || ![1, 3, 4].includes(info.components)) return null;
      const img = { id: `Im${images.length + 1}`, bytes, ...info };
      images.push(img);
      const ref = { id: img.id, width: info.width, height: info.height };
      if (typeof src === 'string') jpegCache.set(src, ref); // the same photo twice is embedded once
      return ref;
    },

    /** image(ref, x, y, w, h): draw a registered JPEG with its top-left at x, y. */
    image(ref, x, y, w, h) {
      if (!ref) return doc;
      const p = cur();
      p.images.add(ref.id);
      p.ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(H - y - h)} cm /${ref.id} Do Q`);
      return doc;
    },

    /** Serialise to bytes. */
    toBytes() {
      if (!pages.length) doc.addPage();
      const chunks = [];
      let length = 0;
      const offsets = [];
      const pushStr = (s) => { const b = ascii(s); chunks.push(b); length += b.length; };
      const pushBytes = (b) => { chunks.push(b); length += b.length; };

      // object numbers: 1 catalog, 2 pages, 3-4 fonts, 5 info, then images, then page + content pairs
      const imgNum = new Map(images.map((im, i) => [im.id, 6 + i]));
      const firstPage = 6 + images.length;
      const pageNums = pages.map((_, i) => firstPage + i * 2);
      const total = firstPage + pages.length * 2 - 1;

      const obj = (n, body) => { offsets[n] = length; pushStr(`${n} 0 obj\n${body}\nendobj\n`); };
      const streamObj = (n, dict, data) => {
        offsets[n] = length;
        pushStr(`${n} 0 obj\n<< ${dict} /Length ${data.length} >>\nstream\n`);
        pushBytes(data);
        pushStr('\nendstream\nendobj\n');
      };

      pushStr('%PDF-1.4\n');
      pushBytes(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary marker comment
      obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
      obj(2, `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`);
      obj(3, `<< /Type /Font /Subtype /Type1 /BaseFont /${FONTS.regular.base} /Encoding /WinAnsiEncoding >>`);
      obj(4, `<< /Type /Font /Subtype /Type1 /BaseFont /${FONTS.bold.base} /Encoding /WinAnsiEncoding >>`);
      const info = [`/Producer ${pdfTextHex('Fishtape pdf.js')}`, `/CreationDate (${pdfDate(opts.date || new Date())})`];
      if (opts.title) info.push(`/Title ${pdfTextHex(opts.title)}`);
      if (opts.author) info.push(`/Author ${pdfTextHex(opts.author)}`);
      if (opts.subject) info.push(`/Subject ${pdfTextHex(opts.subject)}`);
      if (opts.creator) info.push(`/Creator ${pdfTextHex(opts.creator)}`);
      obj(5, `<< ${info.join(' ')} >>`);
      for (const im of images) {
        const cs = im.components === 1 ? '/DeviceGray' : im.components === 4 ? '/DeviceCMYK' : '/DeviceRGB';
        const decode = im.components === 4 && im.adobe ? ' /Decode [1 0 1 0 1 0 1 0]' : '';
        streamObj(imgNum.get(im.id), `/Type /XObject /Subtype /Image /Width ${im.width} /Height ${im.height} /ColorSpace ${cs} /BitsPerComponent ${im.bits || 8} /Filter /DCTDecode${decode}`, im.bytes);
      }
      pages.forEach((p, i) => {
        const n = pageNums[i];
        const xo = [...p.images].map((id) => `/${id} ${imgNum.get(id)} 0 R`).join(' ');
        const res = `<< /Font << /F1 3 0 R /F2 4 0 R >>${xo ? ` /XObject << ${xo} >>` : ''} /ProcSet [/PDF /Text /ImageB /ImageC] >>`;
        obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(W)} ${num(H)}] /Resources ${res} /Contents ${n + 1} 0 R >>`);
        streamObj(n + 1, '', ascii(p.ops.join('\n')));
      });

      const xref = length;
      let x = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
      for (let n = 1; n <= total; n++) x += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
      x += `trailer\n<< /Size ${total + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
      pushStr(x);

      const out = new Uint8Array(length);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    },

    /** Browser only: the PDF as a Blob. */
    toBlob() { return new Blob([doc.toBytes()], { type: 'application/pdf' }); },
  };

  function cur() { return page || doc.addPage(); }
  return doc;
}

function ascii(s) {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); b[i] = c < 128 ? c : 63; }
  return b;
}

function pdfDate(d) {
  const x = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `D:${x.getUTCFullYear()}${p(x.getUTCMonth() + 1)}${p(x.getUTCDate())}${p(x.getUTCHours())}${p(x.getUTCMinutes())}${p(x.getUTCSeconds())}Z`;
}

// ---------- flow layout ----------
const INK = '#1c1b19', MUTED = '#5f5a51', RULE = '#e2ded5', FILL = '#f6f4ef', ACCENT = '#f5b301';

/**
 * createFlow(doc, { margin, footer(pageNo, pageCount) -> string }) -> a cursor that
 * stacks blocks down the page and starts a new page when the next block won't fit.
 */
export function createFlow(doc, { margin = 40, footer = null, top = margin, bottom = margin + 18 } = {}) {
  const left = margin, right = doc.width - margin, width = right - left;
  const maxY = doc.height - bottom;
  let y = top;
  if (!doc.page) doc.addPage();

  const flow = {
    doc, left, right, width,
    get y() { return y; },
    set y(v) { y = v; },
    newPage() { doc.addPage(); y = top; return flow; },
    /** Make sure `h` points fit below the cursor, else start a new page. */
    ensure(h) { if (y + h > maxY && y > top) flow.newPage(); return flow; },
    space(h = 8) { y += h; return flow; },

    heading(text, { size = 14, color = INK, rule = true } = {}) {
      flow.ensure(size + 30);
      y += size;
      doc.text(text, left, y, { size, bold: true, color });
      y += 6;
      if (rule) { doc.line(left, y, right, y, { width: 0.75, color: RULE }); y += 10; }
      return flow;
    },

    paragraph(text, { size = 10, bold = false, color = INK, gap = 4, indent = 0 } = {}) {
      const lh = size * 1.3;
      for (const line of wrapText(text, width - indent, size, bold)) {
        flow.ensure(lh);
        y += lh;
        doc.text(line, left + indent, y - size * 0.25, { size, bold, color });
      }
      y += gap;
      return flow;
    },

    /** Label/value pairs in `columns` columns. */
    fields(pairs, { columns = 2, size = 10 } = {}) {
      const list = pairs.filter((p) => p && p[1] != null && p[1] !== '');
      const colW = width / columns;
      for (let i = 0; i < list.length; i += columns) {
        const row = list.slice(i, i + columns);
        const valueLines = row.map(([, v]) => wrapText(String(v), colW - 12, size));
        const h = 12 + Math.max(...valueLines.map((l) => l.length)) * size * 1.3 + 6;
        flow.ensure(h);
        row.forEach(([k], j) => {
          const x = left + j * colW;
          doc.text(String(k).toUpperCase(), x, y + 8, { size: 7.5, bold: true, color: MUTED });
          valueLines[j].forEach((line, li) => doc.text(line, x, y + 12 + (li + 1) * size * 1.3 - size * 0.3, { size, color: INK }));
        });
        y += h;
      }
      return flow;
    },

    /**
     * table({ columns: [{ label, width (fraction or pt), align }], rows: [[cells]], size, total: [cells] })
     * Cells wrap; the header repeats on each new page.
     */
    table({ columns, rows, size = 9, total = null, zebra = true }) {
      const sum = columns.reduce((s, c) => s + (c.width || 1), 0);
      const widths = columns.map((c) => ((c.width || 1) / sum) * width);
      const pad = 4, lh = size * 1.3;
      const header = () => {
        const hh = lh + pad * 2;
        doc.rect(left, y, width, hh, { fill: FILL });
        let x = left;
        columns.forEach((c, i) => {
          const tx = c.align === 'right' ? x + widths[i] - pad : x + pad;
          doc.text(String(c.label).toUpperCase(), tx, y + pad + size * 0.95, { size: size - 1.5, bold: true, color: MUTED, align: c.align === 'right' ? 'right' : 'left' });
          x += widths[i];
        });
        y += hh;
        doc.line(left, y, right, y, { width: 0.75, color: INK });
      };
      const drawRow = (cells, { bold = false, shade = false } = {}) => {
        const lines = cells.map((cell, i) => wrapText(cell == null ? '' : String(cell), widths[i] - pad * 2, size, bold));
        const rh = Math.max(1, ...lines.map((l) => l.length)) * lh + pad * 2;
        if (y + rh > maxY) { flow.newPage(); header(); }
        if (shade) doc.rect(left, y, width, rh, { fill: FILL });
        let x = left;
        lines.forEach((ls, i) => {
          const c = columns[i] || {};
          ls.forEach((line, li) => {
            const tx = c.align === 'right' ? x + widths[i] - pad : x + pad;
            doc.text(line, tx, y + pad + (li + 1) * lh - size * 0.3, { size, bold, color: INK, align: c.align === 'right' ? 'right' : 'left' });
          });
          x += widths[i];
        });
        y += rh;
        doc.line(left, y, right, y, { width: 0.5, color: bold ? INK : RULE });
      };
      flow.ensure(lh * 2 + pad * 4 + 4);
      header();
      rows.forEach((r, i) => drawRow(r, { shade: zebra && i % 2 === 1 }));
      if (total) drawRow(total, { bold: true });
      y += 10;
      return flow;
    },

    /** Photos in a grid: [{ src (JPEG data URL or bytes), caption }]. Skips anything that isn't a JPEG. */
    images(list, { perRow = 2, gap = 12, maxH = 220, captionSize = 8.5 } = {}) {
      const cellW = (width - gap * (perRow - 1)) / perRow;
      let col = 0, rowH = 0;
      for (const item of list) {
        let ref = null;
        try { ref = doc.addJpeg(item.src); } catch { ref = null; }
        const scale = ref ? Math.min(cellW / ref.width, maxH / ref.height) : 1;
        const iw = ref ? ref.width * scale : cellW, ih = ref ? ref.height * scale : 40;
        const capLines = item.caption ? wrapText(item.caption, cellW, captionSize) : [];
        const h = ih + (capLines.length ? capLines.length * captionSize * 1.3 + 4 : 0);
        if (col === 0) flow.ensure(h);
        const x = left + col * (cellW + gap);
        if (ref) doc.image(ref, x, y, iw, ih);
        else { doc.rect(x, y, cellW, ih, { stroke: RULE }); doc.text('Photo could not be embedded', x + 8, y + 24, { size: 8, color: MUTED }); }
        capLines.forEach((line, i) => doc.text(line, x, y + ih + 4 + (i + 1) * captionSize * 1.3 - 2, { size: captionSize, color: MUTED }));
        rowH = Math.max(rowH, h);
        col++;
        if (col === perRow) { y += rowH + gap; col = 0; rowH = 0; }
      }
      if (col) y += rowH + gap;
      return flow;
    },

    rule({ color = RULE, width: lw = 0.75 } = {}) { flow.ensure(8); y += 4; doc.line(left, y, right, y, { width: lw, color }); y += 6; return flow; },

    /** Write `footer(pageNo, pageCount)` at the foot of every page. Call once at the end. */
    finish() {
      if (!footer) return flow;
      const n = doc.pages.length;
      const keep = doc.pageIndex;
      for (let i = 0; i < n; i++) {
        doc.usePage(i);
        const fy = doc.height - margin + 6;
        doc.line(left, fy - 12, right, fy - 12, { width: 0.5, color: RULE });
        const text = footer(i + 1, n);
        if (Array.isArray(text)) {
          doc.text(text[0], left, fy, { size: 8, color: MUTED });
          doc.text(text[1], right, fy, { size: 8, color: MUTED, align: 'right' });
        } else doc.text(text, right, fy, { size: 8, color: MUTED, align: 'right' });
      }
      doc.usePage(keep);
      return flow;
    },
  };
  return flow;
}

export const PDF_COLORS = { INK, MUTED, RULE, FILL, ACCENT };
