// HTML sanitizer for mail. Received HTML is never trusted: it is parsed with parse5 (8.0.1,
// pinned; the WHATWG-conformant parser jsdom uses, so it builds the same tree a browser would)
// and written out again from an allow-list. Anything not on the list is dropped; text and
// attribute values are always re-escaped, so nothing the sender wrote is copied through raw.
//
// Mode 'view' (the HQ reading pane):
//   - inline style="" becomes data-ft-style="" with only safe declarations. The HQ page CSP
//     blocks style attributes, so the reading pane applies them through CSSOM (hq/js/mail).
//   - <style> blocks become one sanitized stylesheet (`css`), applied the same way.
//   - remote images: dropped (blocked) unless `images: 'allow'`; then they point at the
//     HQ image proxy (by index, never by URL). Tracking pixels are removed unless allowed.
//   - cid: images become data: URLs from the message's own attachments.
//   - links open in a new tab with rel="noopener noreferrer"; only http(s), mailto and tel.
// Mode 'compose' (HQ's own outgoing HTML, quotes and signatures): no styles, only data: images.
import { parse, parseFragment } from 'parse5';

const HTML_NS = 'http://www.w3.org/1999/xhtml';

/** Kept with their children. */
const ALLOWED = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br', 'caption', 'center', 'cite', 'code',
  'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'font', 'footer', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'main', 'mark', 'nav', 'ol', 'p', 'pre', 'q', 's', 'samp',
  'section', 'small', 'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time',
  'tr', 'tt', 'u', 'ul', 'var', 'wbr',
]);
const COMPOSE_ALLOWED = new Set(['a', 'b', 'blockquote', 'br', 'code', 'div', 'em', 'h1', 'h2', 'h3', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 's', 'span', 'strike', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul']);
/** Dropped together with everything inside them. */
const DROP = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'audio', 'video', 'source',
  'track', 'canvas', 'svg', 'math', 'input', 'button', 'select', 'textarea', 'option', 'optgroup', 'datalist', 'link', 'meta', 'base',
  'title', 'head', 'xmp', 'plaintext', 'noembed', 'noframes', 'param', 'map', 'area', 'dialog', 'slot', 'portal', 'output', 'progress',
  'meter', 'form', 'fencedframe', 'search', 'menu',
]);
const VOID = new Set(['br', 'hr', 'img', 'wbr', 'col']);

const ATTRS = new Set(['align', 'valign', 'bgcolor', 'width', 'height', 'border', 'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'dir', 'lang', 'title', 'nowrap', 'scope', 'abbr', 'span']);
const TAG_ATTRS = {
  a: new Set(['href']), img: new Set(['src', 'alt']), font: new Set(['color', 'face', 'size']), ol: new Set(['start', 'type', 'reversed']),
  ul: new Set(['type']), li: new Set(['value', 'type']), td: new Set(['headers']), th: new Set(['headers']), time: new Set(['datetime']),
  del: new Set(['datetime']), ins: new Set(['datetime']), details: new Set(['open']),
};
const COMPOSE_ATTRS = { a: new Set(['href']), img: new Set(['src', 'alt', 'width', 'height']), ol: new Set(['start']), td: new Set(['colspan', 'rowspan']), th: new Set(['colspan', 'rowspan']) };

const SIZE = /^\d{1,4}(?:\.\d{1,2})?%?$/;
const COLOR = /^(?:#[0-9a-f]{3,8}|[a-z]{3,20}|rgba?\(\s*[\d.\s,%]{5,40}\))$/i;
const ATTR_CHECK = {
  width: (v) => SIZE.test(v), height: (v) => SIZE.test(v), border: (v) => /^\d{1,3}$/.test(v), cellpadding: (v) => /^\d{1,3}$/.test(v),
  cellspacing: (v) => /^\d{1,3}$/.test(v), colspan: (v) => /^\d{1,3}$/.test(v), rowspan: (v) => /^\d{1,3}$/.test(v), span: (v) => /^\d{1,3}$/.test(v),
  start: (v) => /^-?\d{1,6}$/.test(v), value: (v) => /^-?\d{1,6}$/.test(v), size: (v) => /^[+-]?\d$/.test(v),
  type: (v) => /^(?:1|a|A|i|I|disc|circle|square)$/.test(v), align: (v) => /^(?:left|right|center|justify|top|middle|bottom)$/i.test(v),
  valign: (v) => /^(?:top|middle|bottom|baseline)$/i.test(v), dir: (v) => /^(?:ltr|rtl|auto)$/i.test(v), lang: (v) => /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(v),
  bgcolor: (v) => COLOR.test(v), color: (v) => COLOR.test(v), face: (v) => /^[\w\s,'-]{1,100}$/.test(v), scope: (v) => /^(?:row|col|rowgroup|colgroup)$/.test(v),
  nowrap: () => true, reversed: () => true, open: () => true, datetime: (v) => /^[\dT:.+\-Z ]{4,40}$/.test(v), headers: (v) => /^[\w\s-]{1,200}$/.test(v),
};

// ---- CSS ---------------------------------------------------------------------------------

const CSS_PROPS = new Set([
  'color', 'background-color', 'background', 'font', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'text-align',
  'text-decoration', 'text-decoration-line', 'text-decoration-color', 'text-transform', 'text-indent', 'line-height', 'letter-spacing',
  'word-spacing', 'white-space', 'vertical-align', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-color', 'border-style', 'border-width', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style', 'border-top-width', 'border-right-width',
  'border-bottom-width', 'border-left-width', 'border-radius', 'border-collapse', 'border-spacing', 'width', 'min-width', 'max-width',
  'height', 'min-height', 'max-height', 'display', 'list-style', 'list-style-type', 'list-style-position', 'table-layout', 'caption-side',
  'empty-cells', 'direction', 'overflow', 'overflow-x', 'overflow-y', 'visibility', 'opacity', 'box-sizing', 'float', 'clear', 'word-break',
  'word-wrap', 'overflow-wrap', 'text-overflow', 'position', 'top', 'right', 'bottom', 'left', 'gap', 'flex', 'flex-direction', 'flex-wrap',
  'align-items', 'justify-content', 'outline', 'mso-line-height-rule',
]);
const CSS_BAD = /url\s*\(|expression|javascript|vbscript|behaviou?r|-moz-binding|@|\\|<|>|\/\*|image-set|image\s*\(|element\s*\(|var\s*\(|attr\s*\(|env\s*\(|src\s*\(|paint\s*\(/i;

/** Split "a: b; c: d" on semicolons outside quotes and brackets. */
function declarations(text) {
  const out = [];
  let cur = '', depth = 0, quote = null;
  for (const ch of String(text)) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ';' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Only allowed properties with harmless values. Returns "prop: value; …" or ''. */
export function sanitizeDeclarations(text) {
  const out = [];
  for (const d of declarations(String(text || '').slice(0, 8000))) {
    const i = d.indexOf(':');
    if (i < 1) continue;
    const prop = d.slice(0, i).trim().toLowerCase();
    let value = d.slice(i + 1).trim();
    if (!CSS_PROPS.has(prop) || !value || value.length > 300 || CSS_BAD.test(value) || /[\x00-\x1f\x7f]/.test(value)) continue;
    value = value.replace(/\s*!important\s*$/i, '');
    if (prop === 'position' && !/^(?:static|relative)$/i.test(value)) continue;
    if (prop === 'display' && !/^(?:block|inline|inline-block|none|flex|inline-flex|list-item|table|table-row|table-cell|table-row-group|table-header-group|table-footer-group|table-column|table-caption)$/i.test(value)) continue;
    out.push(`${prop}: ${value}`);
  }
  return out.join('; ');
}

const SELECTOR = /^[\w\s.#\-,:>*+~[\]="'()^$|%]{1,500}$/;

/** A <style> sheet reduced to plain rules (and @media around them) with safe declarations. */
export function sanitizeStylesheet(css) {
  const src = String(css || '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--|-->/g, ' ').slice(0, 200_000);
  function block(text, depth) {
    let out = '', i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const semi = text.indexOf(';', i);
      if (semi >= 0 && semi < open) { i = semi + 1; continue; } // a statement such as @import "x";
      const prelude = text.slice(i, open).trim();
      let d = 1, j = open + 1;
      while (j < text.length && d > 0) { if (text[j] === '{') d++; else if (text[j] === '}') d--; j++; }
      const inner = text.slice(open + 1, j - 1);
      i = j;
      if (prelude.startsWith('@')) {
        const m = /^@media\s+([a-z0-9\s(),:.-]{1,200})$/i.exec(prelude);
        if (m && depth === 0) { const body = block(inner, 1); if (body) out += `@media ${m[1].trim()}{${body}}`; }
        continue; // @import, @font-face, @keyframes, @charset, ... are dropped
      }
      if (!SELECTOR.test(prelude) || /url|expression|javascript/i.test(prelude)) continue;
      const decls = sanitizeDeclarations(inner);
      if (decls) out += `${prelude.replace(/\s+/g, ' ')}{${decls}}`;
    }
    return out;
  }
  return block(src, 0);
}

// ---- URLs --------------------------------------------------------------------------------

/** A link target we allow (normalized), or null. */
export function safeHref(v) {
  const s = String(v || '').replace(/[\x00-\x20\x7f]+/g, '');
  if (!s || s.length > 4096) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  return ['http:', 'https:', 'mailto:', 'tel:'].includes(u.protocol) ? u.href : null;
}

function remoteUrl(v) {
  const s = String(v || '').trim();
  if (s.length > 2048) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
}

const DATA_IMAGE = /^data:image\/(?:png|gif|jpeg|webp);base64,[A-Za-z0-9+/=\s]{1,700000}$/;

// ---- tree walk -----------------------------------------------------------------------------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attrOf = (node, name) => node.attrs?.find((a) => a.name === name)?.value;

function isTrackingPixel(node, style) {
  const w = attrOf(node, 'width'), hgt = attrOf(node, 'height');
  const tiny = (v) => v != null && /^\s*[0-3](?:px)?\s*$/.test(String(v));
  if (tiny(w) || tiny(hgt)) return true;
  if (/(?:^|;)\s*(?:width|height)\s*:\s*[0-3](?:px)?\s*(?:;|$)/i.test(style) || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return true;
  return false;
}

/** Every remote image URL in the order the 'view' sanitizer numbers them. */
export function remoteImageUrls(html) {
  const urls = [];
  const walk = (node) => {
    for (const c of node.childNodes || []) {
      if (c.namespaceURI && c.namespaceURI !== HTML_NS) continue;
      if (c.tagName && DROP.has(c.tagName)) continue;
      if (c.tagName === 'img') { const u = remoteUrl(attrOf(c, 'src')); if (u && urls.length < 100) urls.push(u); }
      walk(c);
    }
  };
  walk(bodyOf(parse(String(html || '').slice(0, 3_000_000))));
  return urls;
}

function bodyOf(doc) {
  const html = doc.childNodes.find((n) => n.tagName === 'html');
  return html?.childNodes.find((n) => n.tagName === 'body') || html || doc;
}

function collectStyles(node, out) {
  for (const c of node.childNodes || []) {
    if (c.tagName === 'style' && (!c.namespaceURI || c.namespaceURI === HTML_NS)) out.push((c.childNodes || []).map((t) => t.value || '').join(''));
    else if (c.childNodes) collectStyles(c, out);
  }
}

/**
 * @param {string} html
 * @param {{ mode?: 'view'|'compose', images?: 'block'|'allow', imageUrl?: (n: number) => string, cid?: (id: string) => string|null }} [o]
 * @returns {{ html: string, css: string, bodyStyle: string, blockedImages: number, trackers: number }}
 */
export function sanitizeHtml(html, o = {}) {
  const mode = o.mode || 'view';
  const compose = mode === 'compose';
  const allowImages = o.images === 'allow';
  const tags = compose ? COMPOSE_ALLOWED : ALLOWED;
  const state = { blockedImages: 0, trackers: 0, remote: 0 };
  const source = String(html || '').slice(0, 3_000_000);
  const doc = compose ? parseFragment(source) : parse(source);
  const root = compose ? doc : bodyOf(doc);
  let css = '';
  if (!compose) {
    const sheets = [];
    collectStyles(doc, sheets);
    css = sanitizeStylesheet(sheets.join('\n'));
  }

  function attrs(node, tag) {
    const out = [];
    let style = '';
    for (const a of node.attrs || []) {
      const name = a.name.toLowerCase();
      const value = a.value;
      if (name === 'style') { style = value; continue; }
      if (name === 'class' && !compose) {
        const cls = value.split(/\s+/).filter((c) => /^[A-Za-z_][\w-]{0,60}$/.test(c)).slice(0, 10).join(' ');
        if (cls) out.push(['class', cls]);
        continue;
      }
      const allowed = compose ? COMPOSE_ATTRS[tag]?.has(name) : ATTRS.has(name) || TAG_ATTRS[tag]?.has(name);
      if (!allowed || name === 'href' || name === 'src') continue;
      const check = ATTR_CHECK[name];
      if (check && !check(value.trim())) continue;
      out.push([name, value.trim().slice(0, 500)]);
    }
    return { list: out, style };
  }

  function element(node) {
    const tag = node.tagName;
    if (node.namespaceURI && node.namespaceURI !== HTML_NS) return '';
    if (DROP.has(tag)) return '';
    if (!tags.has(tag)) return children(node); // unknown or not allowed here: keep the content
    const { list, style } = attrs(node, tag);
    if (tag === 'a') {
      const href = safeHref(attrOf(node, 'href'));
      if (href) list.unshift(['href', href], ['target', '_blank'], ['rel', 'noopener noreferrer nofollow']);
    }
    if (tag === 'img') {
      const src = String(attrOf(node, 'src') || '').trim();
      let out = null;
      if (/^cid:/i.test(src)) {
        out = o.cid ? o.cid(src.slice(4).replace(/^<|>$/g, '')) : null;
      } else if (DATA_IMAGE.test(src)) {
        out = src.replace(/\s+/g, '');
      } else if (!compose && remoteUrl(src)) {
        const n = state.remote++;
        if (allowImages && o.imageUrl && n < 100) out = o.imageUrl(n);
        else if (isTrackingPixel(node, style)) { state.trackers++; return ''; }
        else state.blockedImages++;
      }
      if (out) list.unshift(['src', out]);
      else list.push(['data-ft-blocked', '1']);
    }
    if (!compose && style) {
      const s = sanitizeDeclarations(style);
      if (s) list.push(['data-ft-style', s]);
    }
    const open = `<${tag}${list.map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('')}>`;
    if (VOID.has(tag)) return open;
    return `${open}${children(node)}</${tag}>`;
  }

  function children(node) {
    let s = '';
    for (const c of node.childNodes || []) {
      if (c.nodeName === '#text') s += esc(c.value);
      else if (c.tagName) s += element(c);
      // comments, doctypes, processing instructions: dropped
    }
    return s;
  }

  let bodyStyle = '';
  if (!compose && root.tagName === 'body') {
    const bg = attrOf(root, 'bgcolor');
    bodyStyle = [bg && COLOR.test(bg.trim()) ? `background-color: ${bg.trim()}` : '', sanitizeDeclarations(attrOf(root, 'style'))].filter(Boolean).join('; ');
  }
  return { html: children(root), css, bodyStyle, blockedImages: state.blockedImages, trackers: state.trackers };
}

/** Plain text from HTML (search, previews and the text/plain part of HQ replies). */
export function htmlToText(html) {
  const doc = parse(String(html || '').slice(0, 3_000_000));
  const BLOCK = /^(?:p|div|br|tr|h[1-6]|blockquote|pre|table|ul|ol|section|article|header|footer|hr)$/;
  let out = '';
  const walk = (node) => {
    for (const c of node.childNodes || []) {
      if (c.nodeName === '#text') out += c.value;
      else if (c.tagName && !DROP.has(c.tagName)) {
        if (c.tagName === 'li') out += '\n- ';
        walk(c);
        if (c.tagName === 'a') {
          const href = safeHref(attrOf(c, 'href'));
          const label = (c.childNodes || []).map((t) => t.value || '').join('').trim();
          if (href && !href.startsWith('mailto:') && label && label !== href) out += ` (${href})`;
        }
        if (BLOCK.test(c.tagName)) out += '\n';
      }
    }
  };
  walk(bodyOf(doc));
  return out.replace(/[ \t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Plain-text mail as safe HTML: escaped, line breaks kept, http(s) links clickable. */
export function textToSafeHtml(text) {
  const safe = esc(String(text || '').slice(0, 1_000_000)).replace(/\bhttps?:\/\/[^\s<>"']{1,2000}/g, (u) => {
    const href = safeHref(u.replace(/&amp;/g, '&'));
    return href ? `<a href="${escAttr(href)}" target="_blank" rel="noopener noreferrer nofollow">${u}</a>` : u;
  });
  return `<div class="ft-text">${safe}</div>`;
}
