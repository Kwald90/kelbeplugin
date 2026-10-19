// Plan import (workstream D): PDF and image underlays, the page picker for multi-page PDFs,
// the page-at-a-time render with progress and Cancel, and the plan set dialogs. The pure parts
// (page ranges, names, grouping, scale transfer) are in js/lib/plansets.js.
//
// Memory: iPad Safari frees a canvas's pixels reliably only when the canvas is shrunk to 0x0,
// and kills the tab when they pile up. So every canvas here is released as soon as its pixels
// are encoded, each pdf.js page is cleaned up after use and the document destroyed at the end.
import {
  parsePageRange, formatPageRange, pageLabel, setNameFromFile, UNDERLAY_MAX_CHARS, ENCODE_STEPS,
} from '../lib/plansets.js';
import { LIGHT_PAPER } from './engine.js';

// pdf.js is vendored (vendor/pdfjs-4.10.38/README.md) so it works offline and under a 'self'-only CSP.
const PDFJS = new URL('../../vendor/pdfjs-4.10.38/', import.meta.url);
let pdfjsPromise = null;
export function loadPdfJs() {
  pdfjsPromise ||= import(new URL('pdf.min.mjs', PDFJS).href).then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', PDFJS).href;
    return lib;
  }).catch(() => {
    pdfjsPromise = null;
    throw new Error('Could not load the PDF reader. Reload the app, or import the plan as an image.');
  });
  return pdfjsPromise;
}

const THUMB_PX = 180; // longest side of a picker thumbnail, CSS px
const MAX_SIDE = 4096; // longest side of an underlay, px (and iPad Safari's canvas limit)
const pause = (ms = 30) => new Promise((r) => setTimeout(r, ms)); // let the sheet paint and the GC run

export const isPdf = (file) => file?.type === 'application/pdf' || /\.pdf$/i.test(file?.name || '');

/** Let go of a canvas's pixels now. */
export function release(c) { if (c) { c.width = 0; c.height = 0; } }

/**
 * Open a PDF: { pdf, numPages, name, labels, label(n), close() }. Always close() it.
 * @param {File} file
 */
export async function openPdf(file) {
  const lib = await loadPdfJs();
  // isEvalSupported: false keeps a crafted PDF from running script (CVE-2024-4367 class)
  const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  let labels = null;
  try { labels = await pdf.getPageLabels(); } catch { labels = null; }
  let closed = false;
  return {
    pdf, labels, numPages: pdf.numPages, name: setNameFromFile(file.name),
    /** The PDF's own label for page n ("E1.0"), or null. */
    label: (n) => pageLabel(labels, n),
    close() { if (closed) return Promise.resolve(); closed = true; return pdf.destroy().catch(() => {}); },
  };
}

/** A white canvas of w x h. */
function whiteCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  return { c, x };
}

/**
 * JPEG data URL of a canvas, stepping the quality (then the pixel size) down until it fits
 * `maxChars`. The caller keeps the canvas's own size as the underlay's world size, so a page
 * encoded smaller still lines up with the scale of its set.
 */
export function encodeUnderlay(c, maxChars = UNDERLAY_MAX_CHARS) {
  for (const step of ENCODE_STEPS) {
    let src = c;
    if (step.scale < 1) {
      src = whiteCanvas(c.width * step.scale, c.height * step.scale).c;
      const x = src.getContext('2d');
      x.imageSmoothingQuality = 'high';
      x.drawImage(c, 0, 0, src.width, src.height);
    }
    const url = src.toDataURL('image/jpeg', step.quality);
    if (src !== c) release(src);
    if (url.length <= maxChars) return { url, quality: step.quality, scale: step.scale };
  }
  throw new Error('This page is too detailed to import, even at low quality.');
}

/** A 360 x 240 gallery thumbnail of a rendered page (same size as the editor's). */
export function thumbOf(c) {
  const { c: t, x } = whiteCanvas(360, 240);
  x.fillStyle = LIGHT_PAPER.bg; x.fillRect(0, 0, t.width, t.height);
  const k = Math.min((t.width - 24) / c.width, (t.height - 24) / c.height);
  x.imageSmoothingQuality = 'high';
  x.drawImage(c, (t.width - c.width * k) / 2, (t.height - c.height * k) / 2, c.width * k, c.height * k);
  const url = t.toDataURL('image/jpeg', 0.72);
  release(t);
  return url;
}

/**
 * Render one PDF page as an underlay: at most 4096 px on the long side (3x for small pages),
 * flattened on white. `signal.task` holds the pdf.js render task so Cancel can stop it.
 * @returns {Promise<{ url: string, w: number, h: number, pxPerPt: number, quality: number, scale: number, thumb: string }>}
 */
export async function renderSheet(doc, pageNo, signal = {}) {
  const page = await doc.pdf.getPage(pageNo);
  let c = null;
  try {
    const v1 = page.getViewport({ scale: 1 });
    const k = Math.min(3, MAX_SIDE / Math.max(v1.width, v1.height));
    const vp = page.getViewport({ scale: k });
    const w = whiteCanvas(vp.width, vp.height);
    c = w.c;
    signal.task = page.render({ canvasContext: w.x, viewport: vp });
    await signal.task.promise;
    signal.task = null;
    const enc = encodeUnderlay(c);
    return { url: enc.url, w: c.width, h: c.height, pxPerPt: c.width / v1.width, quality: enc.quality, scale: enc.scale, thumb: thumbOf(c) };
  } finally {
    signal.task = null;
    page.cleanup();
    release(c);
  }
}

const readAsDataURL = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(file); });
const loadImage = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not read that image')); i.src = src; });

/** An image file as an underlay: <= 4096 px on the long side, flattened on white, under the size budget. */
export async function renderImage(file) {
  const img = await loadImage(await readAsDataURL(file));
  const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const { c, x } = whiteCanvas(img.naturalWidth * k, img.naturalHeight * k);
  try {
    x.drawImage(img, 0, 0, c.width, c.height);
    const enc = encodeUnderlay(c);
    return { url: enc.url, w: c.width, h: c.height, pxPerPt: null };
  } finally {
    release(c);
    img.src = '';
  }
}

/**
 * Full-screen page picker for a PDF with more than one page. Thumbnails render small, one at
 * a time, the ones on screen first, so a 40-page set opens straight away.
 * Resolves to the chosen page numbers (sorted) or null when cancelled.
 * @param {object} ui  js/ui.js
 * @param {Awaited<ReturnType<typeof openPdf>>} doc
 * @param {{ title?: string, noun?: string, extra?: Node }} opts  `extra` sits above the pages (e.g. a job picker)
 */
export function pickPages(ui, doc, { title = 'Pick the sheets to import', noun = 'sheet', extra = null } = {}) {
  const { h, icon } = ui;
  const n = doc.numPages;
  return new Promise((resolve) => {
    let selected = new Set(Array.from({ length: n }, (_, i) => i + 1));
    let result = null;
    let stopped = false, inflight = null, pumping = null;

    const count = h('strong', { class: 'pp-count', 'aria-live': 'polite' });
    const rangeInput = h('input', {
      class: 'input', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'e.g. 2-9, 12', 'aria-label': 'Pages, e.g. 2-9, 12',
      onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); applyRange(); } },
    });
    const rangeErr = h('div', { class: 'pp-error', role: 'alert', hidden: true });
    const okBtn = ui.button('Import', { variant: 'primary', icon: 'upload', onClick: () => { result = [...selected].sort((a, b) => a - b); s.close(); } });
    const grid = h('div', { class: 'pp-grid', role: 'group', 'aria-label': 'Pages' });

    const tiles = [];
    for (let p = 1; p <= n; p++) {
      const label = doc.label(p);
      const name = label || `Page ${p}`;
      const thumb = h('span', { class: 'pp-thumb' }, h('span', { class: 'pp-num' }, String(p)));
      const btn = h('button', { class: 'pp-page', type: 'button', 'aria-pressed': 'true', 'aria-label': label ? `${label}, page ${p}` : name, onClick: () => toggle(p) },
        thumb, h('span', { class: 'pp-tick' }, icon('check', 16)));
      const tile = h('div', { class: 'pp-tile', dataset: { page: String(p) } }, btn,
        h('div', { class: 'pp-cap' },
          h('span', { class: 'pp-label' }, h('span', null, name), label ? h('small', { class: 'muted' }, `p.${p}`) : null),
          h('button', { class: 'pp-only', type: 'button', title: `Import only ${name}`, 'aria-label': `Only ${name}`, onClick: () => setSelection([p]) }, 'Only this')));
      tiles.push({ p, tile, btn, thumb, canvas: null, done: false, visible: p <= 12 });
      grid.append(tile);
    }

    const s = ui.openSheet({
      title, wide: true,
      body: h('div', { class: 'pp' },
        h('div', { class: 'pp-bar' },
          count,
          h('span', { class: 'grow' }),
          ui.button('Select all', { size: 'sm', icon: 'check', onClick: () => setSelection(tiles.map((t) => t.p)) }),
          ui.button('Clear', { size: 'sm', variant: 'ghost', onClick: () => setSelection([]) }),
          h('div', { class: 'pp-range' }, rangeInput, ui.button('Use range', { size: 'sm', onClick: () => applyRange() })),
          rangeErr),
        extra,
        grid),
      actions: [ui.button('Cancel', { variant: 'ghost', onClick: () => s.close() }), okBtn],
      onClose: () => finish(),
    });
    s.el.classList.add('cv-full');

    function paint() {
      for (const t of tiles) {
        const on = selected.has(t.p);
        t.btn.setAttribute('aria-pressed', String(on));
        t.tile.classList.toggle('off', !on);
      }
      count.textContent = `${selected.size} of ${n} selected`;
      okBtn.disabled = !selected.size;
      okBtn.lastChild.textContent = selected.size === 1 ? `Import 1 ${noun}` : `Import ${selected.size} ${noun}s`;
    }
    function setSelection(pages, fromRange = false) {
      selected = new Set(pages);
      if (!fromRange) { rangeInput.value = formatPageRange([...selected]); rangeErr.hidden = true; }
      paint();
    }
    function toggle(p) {
      if (selected.has(p)) selected.delete(p); else selected.add(p);
      setSelection([...selected]);
    }
    function applyRange() {
      const r = parsePageRange(rangeInput.value, n, doc.labels);
      rangeErr.textContent = r.error || '';
      rangeErr.hidden = !r.error;
      if (!r.error) setSelection(r.pages, true);
    }

    // thumbnails: one page at a time, visible tiles first
    const io = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => {
        for (const e of entries) { const t = tiles[Number(e.target.dataset.page) - 1]; if (t) t.visible = e.isIntersecting; }
        pump();
      }, { root: s.body, rootMargin: '300px 0px' })
      : null;
    for (const t of tiles) io?.observe(t.tile);

    async function renderThumb(t) {
      const page = await doc.pdf.getPage(t.p);
      try {
        if (stopped) return;
        const v1 = page.getViewport({ scale: 1 });
        const px = THUMB_PX * Math.min(2, globalThis.devicePixelRatio || 1);
        const vp = page.getViewport({ scale: px / Math.max(v1.width, v1.height) });
        const { c, x } = whiteCanvas(vp.width, vp.height);
        inflight = page.render({ canvasContext: x, viewport: vp });
        try { await inflight.promise; } catch (e) { release(c); throw e; }
        if (stopped) { release(c); return; }
        c.className = 'pp-canvas';
        t.canvas = c;
        ui.clear(t.thumb).append(c);
      } finally {
        inflight = null;
        page.cleanup();
      }
    }
    function pump() {
      if (pumping || stopped) return;
      pumping = (async () => {
        while (!stopped) {
          const t = tiles.find((x) => !x.done && x.visible) || tiles.find((x) => !x.done);
          if (!t) break;
          t.done = true;
          try { await renderThumb(t); } catch { if (!stopped) t.thumb.classList.add('failed'); }
        }
      })().finally(() => { pumping = null; });
    }

    async function finish() {
      stopped = true;
      io?.disconnect();
      try { inflight?.cancel(); } catch { /* already done */ }
      await pumping;
      for (const t of tiles) release(t.canvas);
      resolve(result);
    }

    setSelection(tiles.map((t) => t.p));
    pump();
  });
}

/**
 * Render the chosen pages one at a time behind a progress sheet with Cancel. Each rendered
 * page goes to `onSheet(sheet)` (store it and let it go); a page that fails is skipped and
 * listed at the end. Cancel stops after the page in hand and keeps the ones already done.
 * @returns {Promise<{ done: number[], failed: { page: number, name: string, error: string }[], cancelled: boolean }>}
 */
export async function importPages(ui, doc, pages, onSheet, { title = 'Importing plan set' } = {}) {
  const { h } = ui;
  const signal = { cancelled: false, task: null };
  let open = true;
  const msg = h('p', { class: 'pp-progress-msg', 'aria-live': 'polite' }, 'Getting ready…');
  const bar = h('i');
  const meter = h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Import progress', 'aria-valuemin': '0', 'aria-valuemax': String(pages.length), 'aria-valuenow': '0' }, bar);
  const note = h('p', { class: 'muted pp-progress-note' }, 'Sheets already imported stay if you cancel.');
  const s = ui.openSheet({
    title, dialog: true,
    body: h('div', { class: 'stack' }, msg, meter, note),
    actions: [ui.button('Cancel', { variant: 'ghost', onClick: () => s.close() })],
    onClose: () => { open = false; cancel(); },
  });
  function cancel() {
    if (signal.cancelled) return;
    signal.cancelled = true;
    msg.textContent = 'Stopping…';
    try { signal.task?.cancel(); } catch { /* finished */ }
  }

  const done = [], failed = [];
  for (let i = 0; i < pages.length && !signal.cancelled; i++) {
    const p = pages[i];
    const label = doc.label(p);
    const name = label || `Page ${p}`;
    msg.textContent = `Importing sheet ${i + 1} of ${pages.length}${label ? ` (${label})` : ''}…`;
    await pause();
    try {
      const r = await renderSheet(doc, p, signal);
      await onSheet({ page: p, label, ...r });
      done.push(p);
    } catch (e) {
      if (signal.cancelled) break; // the render in hand was stopped: not a failure
      failed.push({ page: p, name, error: e?.message || 'Could not read this page' });
    }
    bar.style.width = `${Math.round(((i + 1) / pages.length) * 100)}%`;
    meter.setAttribute('aria-valuenow', String(i + 1));
  }
  await pause(0);

  const cancelled = signal.cancelled && done.length + failed.length < pages.length;
  if (!failed.length && !cancelled) { if (open) s.close(); return { done, failed, cancelled }; }
  // Report what happened, in the same sheet if it's still open.
  const lines = [h('p', { class: 'pp-progress-msg' }, `Imported ${done.length} of ${pages.length} sheet${pages.length === 1 ? '' : 's'}${cancelled ? ' before you cancelled' : ''}.`)];
  if (failed.length) {
    lines.push(h('p', { class: 'muted' }, `Skipped ${failed.length} that couldn't be read:`),
      h('ul', { class: 'pp-failed' }, failed.map((f) => h('li', null, h('strong', null, f.name), ` · ${f.error}`))));
  }
  if (cancelled) lines.push(h('p', { class: 'muted' }, 'Import the rest later with a page range, e.g. ' + formatPageRange(pages.filter((p) => !done.includes(p) && !failed.some((f) => f.page === p))) + '.'));
  const summary = open ? s : ui.openSheet({ title, dialog: true, body: h('div'), actions: [] });
  ui.clear(summary.body).append(h('div', { class: 'stack' }, lines));
  const foot = summary.el.querySelector('.sheet-foot') || summary.el.appendChild(h('footer', { class: 'sheet-foot' }));
  ui.clear(foot).append(ui.button('Done', { variant: 'primary', onClick: () => summary.close() }));
  return { done, failed, cancelled };
}

/**
 * A dialog with several answers. Resolves to the chosen id, or null for Cancel.
 * choices: [{ id, label, variant }]
 */
export function chooseDialog(ui, { title, message, choices, cancelLabel = 'Cancel' }) {
  const { h } = ui;
  return new Promise((resolve) => {
    let picked = null;
    const s = ui.openSheet({
      title, dialog: true,
      body: h('div', { class: 'stack' }, typeof message === 'string' ? h('p', { class: 'pp-dialog-msg' }, message) : message),
      actions: [
        ui.button(cancelLabel, { variant: 'ghost', onClick: () => s.close() }),
        ...choices.map((c) => ui.button(c.label, { variant: c.variant || 'secondary', onClick: () => { picked = c.id; s.close(); } })),
      ],
      onClose: () => resolve(picked),
    });
    s.el.classList.add('pp-choice');
  });
}
