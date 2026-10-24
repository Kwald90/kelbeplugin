// Offline QR codes for the panel schedule. The encoder is vendored (Kazuhiko Arase's
// qrcode-generator 2.0.4, MIT — see electrical-app/vendor/qrcode-generator-2.0.4/) so a code
// generates with no network and under the app's strict CSP (no eval, no external script). We read
// the module matrix ourselves and draw it as inline SVG of plain <rect>/<path> elements, never the
// library's own createSvgTag (that emits inline style="" attributes the CSP blocks).
import qrcode from '../../vendor/qrcode-generator-2.0.4/qrcode.mjs';
import { BRAND } from '../brand.js';

/** Canonical deep link to a panel: appOrigin (or a fallback) + the hash route the app uses.
 *  Accepts a panel object or a bare id. The URL is what the printed QR encodes, so scanning it a
 *  year later opens exactly this panel to view / edit / reprint. */
export function panelUrl(panel, origin) {
  const id = panel && typeof panel === 'object' ? panel.id : panel;
  let base = origin || BRAND.appOrigin || '';
  if (!base && typeof location !== 'undefined' && location.origin && location.origin !== 'null') base = location.origin;
  base = String(base || '').replace(/\/+$/, '');
  return `${base}/#/panels/${encodeURIComponent(String(id == null ? '' : id))}`;
}

/** Encode `text` and return the raw module matrix: { count, isDark(r,c), modules:[[bool]] }.
 *  errorCorrectionLevel 'M' balances density against damage tolerance for a label stuck in a panel. */
export function qrMatrix(text, { ecc = 'M' } = {}) {
  const qr = qrcode(0, ecc); // type 0 = auto-size to the data
  qr.addData(String(text == null ? '' : text));
  qr.make();
  const count = qr.getModuleCount();
  const modules = [];
  for (let r = 0; r < count; r++) {
    const row = [];
    for (let c = 0; c < count; c++) row.push(qr.isDark(r, c));
    modules.push(row);
  }
  return { count, modules, isDark: (r, c) => qr.isDark(r, c) };
}

/**
 * Inline SVG markup (a string) for the QR of `text`. The viewBox is in module units with a quiet
 * zone, so the code scales fluidly to whatever box the CSS gives it (screen sticker or print).
 * Dark modules are one <path> (compact, crisp); the light background is one <rect>. No inline
 * style attribute, no script, no event handlers — safe to drop into innerHTML under the CSP.
 */
export function qrSvg(text, { margin = 4, dark = '#000000', light = '#ffffff', label } = {}) {
  const { count, modules } = qrMatrix(text);
  const dim = count + margin * 2;
  let d = '';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (modules[r][c]) d += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }
  const title = label ? `<title>${escapeXml(label)}</title>` : '';
  const bg = `<rect width="${dim}" height="${dim}" fill="${light}"/>`;
  const fg = `<path d="${d}" fill="${dark}"/>`;
  const aria = label ? ` role="img" aria-label="${escapeXml(label)}"` : ' aria-hidden="true"';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges"${aria}>${title}${bg}${fg}</svg>`;
}

/** A live <svg> DOM node for the QR, built the same CSP-safe way icon() builds its icons. */
export function qrSvgNode(text, opts = {}) {
  const { count, modules } = qrMatrix(text);
  const margin = opts.margin ?? 4;
  const dim = count + margin * 2;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${dim} ${dim}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  if (opts.label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', opts.label); }
  else svg.setAttribute('aria-hidden', 'true');
  let d = '';
  for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (modules[r][c]) d += `M${c + margin} ${r + margin}h1v1h-1z`;
  // Inner markup is plain rect/path with presentation attributes only (no style=, no on*=).
  svg.innerHTML = `<rect width="${dim}" height="${dim}" fill="${opts.light || '#ffffff'}"/><path d="${d}" fill="${opts.dark || '#000000'}"/>`;
  return svg;
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
