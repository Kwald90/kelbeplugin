// A small, safe Markdown renderer for the in-app setup guides (electrical-app/guides/*.md).
// It returns an HTML string built only from escaped text and a fixed set of tags:
// headings, paragraphs, lists, block quotes, code, tables, rules, links and images.
// Raw HTML in the source is shown as text, never parsed. Links must be http(s), mailto,
// tel or an in-app #/route and get rel="noopener noreferrer"; images must come from the
// app's own origin. No DOM needed, so tests run it in Node.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const LINK_PROTOCOLS = new Set(['https:', 'http:', 'mailto:', 'tel:']);

/**
 * @param {string} href
 * @param {{ base: string, origin: string }} ctx
 * @returns {string|null} the absolute URL to use, or null when it is not allowed
 */
export function safeUrl(href, ctx, { image = false } = {}) {
  const raw = String(href ?? '').trim();
  if (!raw || /[\u0000-\u001f\u007f\s]/.test(raw)) return null;
  if (raw.startsWith('#')) return !image && /^#\/[A-Za-z0-9/_?=&.-]*$/.test(raw) ? raw : null; // in-app route
  let u;
  try { u = new URL(raw, ctx.base); } catch { return null; }
  if (image) return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === ctx.origin ? u.href : null;
  return LINK_PROTOCOLS.has(u.protocol) ? u.href : null;
}

function link(textHtml, href, ctx) {
  const url = safeUrl(href, ctx);
  if (!url) return textHtml;
  const external = !url.startsWith('#') && !(url.startsWith(ctx.origin + '/'));
  return `<a href="${escapeHtml(url)}" rel="noopener noreferrer"${external ? ' target="_blank"' : ''}>${textHtml}</a>`;
}

function image(alt, src, ctx) {
  const url = safeUrl(src, ctx, { image: true });
  if (!url) return escapeHtml(alt);
  return `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy">`;
}

const INLINE = /`([^`]+)`|!\[([^\]]*)\]\(([^()\s]+)\)|\[([^\]]+)\]\(([^()\s]+)\)|\*\*(.+?)\*\*|(?<![\w*])\*(?!\s)([^*]+?)\*(?![\w*])|(?<![\w_])_(?!\s)([^_]+?)_(?![\w_])|<((?:https?:\/\/|mailto:)[^>\s]+)>/g;

/** Inline Markdown to HTML. Every piece of source text goes through escapeHtml. */
export function inline(src, ctx) {
  let out = '';
  let last = 0;
  const re = new RegExp(INLINE.source, 'g');
  let m;
  while ((m = re.exec(src))) {
    out += escapeHtml(src.slice(last, m.index));
    if (m[1] != null) out += `<code>${escapeHtml(m[1])}</code>`;
    else if (m[3] != null) out += image(m[2], m[3], ctx);
    else if (m[5] != null) out += link(inline(m[4], ctx), m[5], ctx);
    else if (m[6] != null) out += `<strong>${inline(m[6], ctx)}</strong>`;
    else if (m[7] != null) out += `<em>${inline(m[7], ctx)}</em>`;
    else if (m[8] != null) out += `<em>${inline(m[8], ctx)}</em>`;
    else if (m[9] != null) out += link(escapeHtml(m[9]), m[9], ctx);
    last = re.lastIndex;
  }
  return out + escapeHtml(src.slice(last));
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const isTableSep = (l) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l);
const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const startsBlock = (l) => /^(#{1,6}\s|```|>|\s*([-*+]|\d{1,3}[.)])\s+|(-{3,}|\*{3,}|_{3,})\s*$)/.test(l);

function list(lines, i, ctx) {
  const indent = LIST.exec(lines[i])[1].length;
  const ordered = /\d/.test(LIST.exec(lines[i])[2]);
  const start = ordered ? parseInt(LIST.exec(lines[i])[2], 10) : 1;
  const items = [];
  while (i < lines.length) {
    const m = LIST.exec(lines[i]);
    if (!m || m[1].length < indent) break;
    if (m[1].length > indent) { // nested list belongs to the previous item
      const [html, next] = list(lines, i, ctx);
      if (items.length) items[items.length - 1].nested += html;
      i = next;
      continue;
    }
    if (/\d/.test(m[2]) !== ordered) break;
    const item = { text: [m[3]], nested: '' };
    i++;
    // continuation lines indented under the item
    while (i < lines.length && lines[i].trim() && !LIST.test(lines[i]) && /^\s{2,}/.test(lines[i])) { item.text.push(lines[i].trim()); i++; }
    items.push(item);
  }
  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered && start !== 1 ? ` start="${start}"` : '';
  return [`<${tag}${startAttr}>${items.map((it) => `<li>${inline(it.text.join(' '), ctx)}${it.nested}</li>`).join('')}</${tag}>`, i];
}

function blocks(lines, ctx) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^\s*```/.exec(line);
    if (fence) {
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const level = Math.min(h[1].length + 1, 6); // the sheet title is the h1/h2
      out.push(`<h${level} id="${slug(h[2])}">${inline(h[2], ctx)}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${blocks(quote, ctx)}</blockquote>`);
      continue;
    }
    if (LIST.test(line)) {
      const [html, next] = list(lines, i, ctx);
      out.push(html);
      i = next;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(`<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${inline(c, ctx)}</th>`).join('')}</tr></thead><tbody>${
        rows.map((r) => `<tr>${head.map((_, k) => `<td>${inline(r[k] ?? '', ctx)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const para = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) para.push(lines[i++].trim());
    out.push(`<p>${inline(para.join(' '), ctx)}</p>`);
  }
  return out.join('\n');
}

/**
 * Render Markdown to a safe HTML string.
 * @param {string} src
 * @param {{ base?: string, origin?: string, vars?: Record<string, string> }} [opts]
 *   base: URL the guide was loaded from (relative links and images resolve against it);
 *   vars: {{name}} placeholders to fill (e.g. webhook_url); values are escaped like any text.
 */
export function renderMarkdown(src, opts = {}) {
  const origin = opts.origin || (typeof location !== 'undefined' ? location.origin : 'https://app.invalid');
  const ctx = { origin, base: opts.base || `${origin}/` };
  const vars = opts.vars || {};
  const text = String(src ?? '').replace(/\r\n?/g, '\n').replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => {
    const v = vars[k];
    // Values are plain text: anything that could start Markdown or HTML syntax is dropped.
    return typeof v === 'string' && /^[A-Za-z0-9:/._?=&%#@+-]{1,500}$/.test(v) ? v : m;
  });
  return blocks(text.split('\n'), ctx);
}
