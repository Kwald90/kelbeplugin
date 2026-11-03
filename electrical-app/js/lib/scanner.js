// Scan a QR sticker or barcode with the device camera and resolve it to an inventory item or bin.
// Works offline and under the strict CSP: a native BarcodeDetector is used where the browser has it
// (Android/desktop, also reads 1-D barcodes); elsewhere (iOS WKWebView) the vendored jsQR decodes
// QR codes from camera frames. Everything degrades to typing the code by hand, so there is always a
// way through. The camera path can only be verified on a real device — the resolve logic is tested.
import jsQR from '../../vendor/jsqr-1.4.0/jsQR.js';

/** Is a camera available to scan with? (Typing a code always works regardless.) */
export function scanSupported() {
  return typeof navigator !== 'undefined' && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

const norm = (s) => String(s == null ? '' : s).trim();

/**
 * Resolve a scanned string to an item or a location. Accepts a raw code (barcode / SKU) or one of
 * our printed QR urls (…?q=<sku> for an item, …?loc=<id> for a bin). Returns the matched item
 * (plain item object), or { kind: 'location', location }, or null.
 * @param {string} code
 * @param {object[]} items price-book items
 * @param {{ locations?: object[] }} [o]
 */
export function resolveScan(code, items = [], { locations = [] } = {}) {
  const raw = norm(code);
  if (!raw) return null;
  const loc = (raw.match(/[#?&]loc=([^&\s]+)/) || [])[1];
  if (loc) {
    const id = decodeURIComponent(loc);
    const location = (locations || []).find((l) => l.id === id);
    return location ? { kind: 'location', location } : null;
  }
  const q = (raw.match(/[#?&]q=([^&\s]+)/) || [])[1];
  const needle = q ? decodeURIComponent(q) : raw;
  const item = (items || []).find((i) => norm(i.barcode) === needle || norm(i.sku) === needle || norm(i.name) === needle)
    || (q ? null : (items || []).find((i) => norm(i.barcode) === raw || norm(i.sku) === raw));
  return item || null;
}

/**
 * Open a camera scanner in a sheet. `onCode(text)` fires for each distinct scan. In `continuous`
 * mode the sheet stays open (for counting many items); otherwise it closes on the first hit. Always
 * offers a type-it-in fallback. Returns the sheet handle.
 * @param {object} ui the app UI kit (from ctx.ui)
 * @param {{ title?: string, hint?: string, continuous?: boolean, onCode: (code:string)=>void }} opts
 */
export function openScanner(ui, { title = 'Scan a code', hint, continuous = false, onCode } = {}) {
  const { h } = ui;
  const supported = scanSupported();
  const video = h('video', { class: 'scan-video', playsinline: true, muted: true, autoplay: true });
  const status = h('div', { class: 'scan-status muted' }, supported ? 'Point the camera at a QR sticker or barcode…' : 'Camera not available here — type the code below.');
  const manual = h('input', { class: 'input', placeholder: 'Type a SKU or barcode', 'aria-label': 'Type a code', autocapitalize: 'characters' });
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  let stream = null, raf = null, detector = null, done = false, lastCode = '', lastAt = 0;

  function stop() {
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    if (stream) { for (const t of stream.getTracks()) { try { t.stop(); } catch { /* already stopped */ } } stream = null; }
  }
  function hit(code) {
    const c = norm(code);
    if (!c) return;
    const now = Date.now();
    if (c === lastCode && now - lastAt < 1500) return; // ignore the same sticker held in frame
    lastCode = c; lastAt = now;
    if (continuous) { status.textContent = `Scanned: ${c}`; onCode?.(c); }
    else { done = true; stop(); sheet.close(); onCode?.(c); }
  }
  async function start() {
    if (!supported) return;
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }); }
    catch { status.textContent = 'Could not open the camera — type the code instead.'; return; }
    video.srcObject = stream;
    try { await video.play(); } catch { /* autoplay may need no await */ }
    try { if (typeof window !== 'undefined' && 'BarcodeDetector' in window) detector = new window.BarcodeDetector({ formats: ['qr_code', 'code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_39'] }); } catch { detector = null; }
    loop();
  }
  async function loop() {
    if (done || !stream || !canvas) return;
    const w = video.videoWidth, ht = video.videoHeight;
    if (w && ht) {
      canvas.width = w; canvas.height = ht;
      const cx = canvas.getContext('2d', { willReadFrequently: true });
      cx.drawImage(video, 0, 0, w, ht);
      if (detector) {
        try { const codes = await detector.detect(canvas); if (codes && codes[0] && codes[0].rawValue) hit(codes[0].rawValue); }
        catch { detector = null; }
      } else {
        try { const img = cx.getImageData(0, 0, w, ht); const r = jsQR(img.data, w, ht, { inversionAttempts: 'dontInvert' }); if (r && r.data) hit(r.data); }
        catch { /* frame not ready */ }
      }
    }
    if (!done) raf = requestAnimationFrame(loop);
  }

  const sheet = ui.openSheet({
    title,
    body: h('div', { class: 'scan-wrap stack' },
      supported ? h('div', { class: 'scan-frame' }, video, h('div', { class: 'scan-reticle' })) : null,
      status,
      hint ? h('p', { class: 'hint' }, hint) : null,
      h('div', { class: 'row scan-manual' }, manual, ui.button('Use code', { variant: 'primary', onClick: () => hit(manual.value) }))),
    onClose: () => { done = true; stop(); },
  });
  manual.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); hit(manual.value); } });
  start();
  return sheet;
}
