// Reading raw MIME (SendGrid Inbound Parse "POST the raw, full MIME message").
//
// Parser: postal-mime 2.7.6, pinned exactly in package.json. Why this one: it has no
// dependencies at all (nothing else enters the supply chain), it is written by the author of
// Nodemailer, it is MIT-0 licensed, it decodes charsets, quoted-printable, base64, encoded
// words and nested message/rfc822 parts, and it has nesting-depth and header-size limits.
// 2.7.6 is the last release of the 2.x line (2026-08-07); 3.x and 4.x were weeks old when
// this was written, so they were skipped.
import PostalMime from 'postal-mime';

export const LIMITS = { text: 1_000_000, html: 2_000_000, attachments: 100, subject: 1000 };

/** "<abc@example.com>" -> "abc@example.com"; null when it isn't a plausible Message-ID. */
export function normalizeMessageId(v) {
  const s = String(v || '').trim().replace(/^<+|>+$/g, '').trim();
  return s && s.length <= 998 && !/[\s<>]/.test(s) ? s : null;
}

/** All Message-IDs in a References / In-Reply-To header, oldest first (max 100). */
export function parseRefs(v) {
  const out = [];
  for (const m of String(v || '').matchAll(/<([^<>\s]{1,998})>/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  if (!out.length) { const one = normalizeMessageId(v); if (one) out.push(one); }
  return out.slice(-100);
}

const PREFIX = /^\s*(?:(?:re|fw|fwd|aw|sv|vs|antw|wg|tr|rv|ref|réf)(?:\s*\[\d+\])?\s*:\s*)+/i;

/** Thread key for a subject: lower case, without reply/forward prefixes or [tags] from lists. */
export function subjectKey(subject) {
  let s = String(subject || '');
  for (let i = 0; i < 5; i++) {
    const before = s;
    s = s.replace(PREFIX, '').replace(/^\s*\[[^\]]{1,40}\]\s*/, '');
    if (s === before) break;
  }
  return s.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 1000);
}

/** A file name that is safe to show and to put in Content-Disposition. */
export function safeFilename(name, contentType = '') {
  let s = String(name || '').normalize('NFC').replace(/[\x00-\x1f\x7f/\\:*?"<>|]+/g, '_').replace(/^[.\s]+/, '').trim();
  if (!s) {
    const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'application/pdf': '.pdf', 'text/plain': '.txt', 'text/calendar': '.ics', 'message/rfc822': '.eml' }[contentType] || '';
    s = `attachment${ext}`;
  }
  if (s.length > 200) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 12 ? s.slice(dot) : '';
    s = s.slice(0, 200 - ext.length) + ext;
  }
  return s;
}

const cleanType = (t) => (/^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,128}$/i.test(String(t || '')) ? String(t).toLowerCase() : 'application/octet-stream');

function flatten(list) {
  const out = [];
  for (const a of list || []) {
    if (a?.group) out.push(...flatten(a.group));
    else if (a?.address) out.push({ name: String(a.name || '').slice(0, 300), address: String(a.address).toLowerCase().slice(0, 320) });
  }
  return out.slice(0, 500);
}

const bytesOf = (c) => (c instanceof Uint8Array ? c : c instanceof ArrayBuffer ? new Uint8Array(c) : new TextEncoder().encode(String(c || '')));

/**
 * Parse one raw message.
 * @param {Buffer|Uint8Array|string} raw
 */
export async function parseMime(raw) {
  const e = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer', maxNestingDepth: 50, maxHeadersSize: 2 * 1024 * 1024 });
  const date = e.date ? new Date(e.date) : null;
  const text = typeof e.text === 'string' ? e.text : '';
  const html = typeof e.html === 'string' ? e.html : '';
  const header = (k) => e.headers?.find((h) => h.key === k)?.value || '';
  const attachments = (e.attachments || []).slice(0, LIMITS.attachments).map((a) => {
    const contentType = cleanType(a.mimeType);
    return {
      filename: safeFilename(a.filename, contentType),
      contentType,
      bytes: bytesOf(a.content),
      contentId: normalizeMessageId(a.contentId),
      inline: a.disposition === 'inline' || Boolean(a.related && a.contentId),
    };
  });
  const from = flatten(e.from ? [e.from] : [])[0] || null;
  return {
    messageId: normalizeMessageId(e.messageId),
    inReplyTo: parseRefs(e.inReplyTo).at(-1) || null,
    references: parseRefs(e.references),
    subject: String(e.subject || '').replace(/[\r\n]+/g, ' ').slice(0, LIMITS.subject),
    from,
    to: flatten(e.to),
    cc: flatten(e.cc),
    replyTo: flatten(e.replyTo),
    date: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
    text: text.slice(0, LIMITS.text),
    html: html.slice(0, LIMITS.html),
    truncated: text.length > LIMITS.text || html.length > LIMITS.html || (e.attachments || []).length > LIMITS.attachments,
    autoSubmitted: /^auto-/i.test(header('auto-submitted')) || /^(bulk|list|junk)$/i.test(header('precedence')),
    attachments,
  };
}

/** Up to 200 characters of plain text for the message list. */
export function previewOf(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}
