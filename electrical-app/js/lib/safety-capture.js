// Signature pad and photo capture for the safety screens (browser only).
// Signatures are stored as a small JPEG data URL (white background, so the PDF writer in
// lib/pdf.js can embed it); photos are downscaled JPEG data URLs, size-capped.
import { h } from '../ui.js';
import { PHOTO_MAX_BYTES, SIGNATURE_MAX_BYTES, dataUrlBytes } from './safety.js';

const SIG_W = 480;
const SIG_H = 160;
const PHOTO_MAX_SIDE = 1600;

/**
 * signaturePad({ label, onChange }) -> { el, isEmpty(), toDataUrl(), clear() }
 * Finger, mouse or Apple Pencil (pressure changes the line width).
 */
export function signaturePad({ label = 'Sign here', onChange } = {}) {
  const canvas = h('canvas', { class: 'sf-sig-canvas', width: SIG_W * 2, height: SIG_H * 2, 'aria-label': label, role: 'img' });
  const g = canvas.getContext('2d');
  let strokes = 0;
  let last = null;
  const reset = () => {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.strokeStyle = '#e2ded5';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(24, canvas.height - 50); g.lineTo(canvas.width - 24, canvas.height - 50); g.stroke();
    strokes = 0;
  };
  reset();
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * canvas.width, y: ((e.clientY - r.top) / r.height) * canvas.height, p: e.pressure || 0.5 };
  };
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    canvas.setPointerCapture?.(e.pointerId);
    last = pos(e);
    g.fillStyle = '#1c1b19';
    g.beginPath(); g.arc(last.x, last.y, 2.5, 0, Math.PI * 2); g.fill();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!last) return;
    e.preventDefault();
    const p = pos(e);
    g.strokeStyle = '#1c1b19';
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.lineWidth = e.pointerType === 'pen' ? 2 + p.p * 6 : 5;
    g.beginPath(); g.moveTo(last.x, last.y); g.lineTo(p.x, p.y); g.stroke();
    last = p;
  });
  const up = () => { if (last) { strokes++; onChange?.(); } last = null; };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  const clearBtn = h('button', { type: 'button', class: 'btn ghost sm', onClick: () => { reset(); onChange?.(); } }, 'Clear');
  const el = h('div', { class: 'sf-sig' }, h('div', { class: 'sf-sig-head' }, h('span', null, label), clearBtn), canvas);
  return {
    el,
    isEmpty: () => strokes === 0,
    clear: () => { reset(); onChange?.(); },
    /** Small JPEG of the signature, or null if nothing was drawn. */
    toDataUrl() {
      if (!strokes) return null;
      const out = document.createElement('canvas');
      out.width = SIG_W; out.height = SIG_H;
      const o = out.getContext('2d');
      o.fillStyle = '#ffffff'; o.fillRect(0, 0, SIG_W, SIG_H);
      o.drawImage(canvas, 0, 0, SIG_W, SIG_H);
      let q = 0.7, url = out.toDataURL('image/jpeg', q);
      while (dataUrlBytes(url) > SIGNATURE_MAX_BYTES && q > 0.3) { q -= 0.1; url = out.toDataURL('image/jpeg', q); }
      return url;
    },
  };
}

/** A signature record for a person, or null. */
export function signatureOf(pad, { name, employeeId = null }) {
  const dataUrl = pad.toDataUrl();
  return dataUrl ? { dataUrl, name: name || '', employeeId, at: new Date().toISOString() } : null;
}

/** Pick images (camera on phones and iPads). Resolves to File[]. */
export function pickImages({ multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = multiple;
    input.className = 'sf-hidden';
    const done = (files) => { input.remove(); resolve(files); };
    input.addEventListener('change', () => done([...(input.files || [])]));
    input.addEventListener('cancel', () => done([]));
    document.body.append(input);
    input.click();
  });
}

/** Downscale an image file to a JPEG data URL under PHOTO_MAX_BYTES. */
export async function downscaleImage(file, maxBytes = PHOTO_MAX_BYTES) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    let side = PHOTO_MAX_SIDE, q = 0.72, out = null, w = 0, hgt = 0;
    for (let i = 0; i < 10; i++) {
      const k = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      w = Math.max(1, Math.round(img.naturalWidth * k));
      hgt = Math.max(1, Math.round(img.naturalHeight * k));
      const c = document.createElement('canvas');
      c.width = w; c.height = hgt;
      const g = c.getContext('2d');
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, hgt);
      g.drawImage(img, 0, 0, w, hgt);
      out = c.toDataURL('image/jpeg', q);
      if (dataUrlBytes(out) <= maxBytes) break;
      if (q > 0.5) q -= 0.1; else side = Math.round(side * 0.8);
    }
    return { dataUrl: out, width: w, height: hgt };
  } finally {
    URL.revokeObjectURL(url);
  }
}

const newId = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : 'p-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));

/**
 * photoStrip({ photos, max, onChange, readOnly }) -> element. Edits `photos` in place
 * (array of { id, dataUrl, caption, takenAt, width, height }).
 */
export function photoStrip({ photos, max = 4, onChange, readOnly = false, label = 'Add photo', toast }) {
  const host = h('div', { class: 'sf-photos' });
  const draw = () => {
    while (host.firstChild) host.firstChild.remove();
    photos.forEach((p, i) => host.append(h('figure', { class: 'sf-photo' },
      h('img', { src: p.dataUrl, alt: p.caption || `Photo ${i + 1}` }),
      readOnly ? null : h('button', { type: 'button', class: 'sf-photo-x', 'aria-label': `Remove photo ${i + 1}`, onClick: () => { photos.splice(i, 1); draw(); onChange?.(); } }, '×'))));
    if (!readOnly && photos.length < max) {
      host.append(h('button', { type: 'button', class: 'sf-photo-add', onClick: add }, '+ ', label));
    }
  };
  async function add() {
    const files = await pickImages({ multiple: max - photos.length > 1 });
    for (const f of files.slice(0, max - photos.length)) {
      try {
        const p = await downscaleImage(f);
        photos.push({ id: newId(), dataUrl: p.dataUrl, caption: '', takenAt: new Date().toISOString(), width: p.width, height: p.height });
      } catch { toast?.(`Couldn't read ${f.name}`, 'error'); }
    }
    draw(); onChange?.();
  }
  draw();
  return host;
}
