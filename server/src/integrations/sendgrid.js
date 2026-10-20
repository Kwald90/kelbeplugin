// SendGrid v3 Mail Send with plain fetch (through http.js, so tests never reach the network).
// Used for Fishtape's own email (services/platform-email.js, HQ Mail) and, with each company's
// own key, as the alternative to Resend for company email (outbox.js).
//
// Checked against SendGrid's docs on 2026-10-19 (docs/email/README.md lists the pages):
// - POST https://api.sendgrid.com/v3/mail/send, Authorization: Bearer <key>, JSON body.
//   Success is 202 Accepted with no body; the X-Message-Id response header identifies the
//   message (the first part of sg_message_id in Event Webhook events).
// - personalizations[].custom_args is an object of strings, at most 10,000 bytes in total;
//   SendGrid copies each one onto every Event Webhook event as a top-level key.
// - categories: at most 10, each at most 255 characters.
// - The whole message, attachments included, must be under 30 MB; at most 1,000 recipients.
// - headers may not set x-sg-id, x-sg-eid, received, dkim-signature, Content-Type,
//   Content-Transfer-Encoding, To, From, Subject, Reply-To, CC or BCC.
// - Errors: { errors: [{ message, field, help }] }. 400 invalid, 401 bad key, 403 key not
//   allowed or From not a verified Sender Identity, 413 too large, 429 rate limited, 5xx.
// - There is no idempotency key: a retried request is a second email. Callers claim a row
//   before sending (see platform-email.js) so a send is never repeated by another worker.
import { ProviderError, httpFailure, request } from './http.js';
import { EMAIL_RE, senderAddress } from './providers.js';

export const SENDGRID_API = 'https://api.sendgrid.com';
const RESERVED_HEADERS = new Set(['x-sg-id', 'x-sg-eid', 'received', 'dkim-signature', 'content-type', 'content-transfer-encoding', 'to', 'from', 'subject', 'reply-to', 'cc', 'bcc']);
const MAX_RECIPIENTS = 1000;

/** "Name <a@b.ca>", "\"Name\" <a@b.ca>" or "a@b.ca" -> { email, name? }, or null. */
export function toAddress(value) {
  let email;
  let name = '';
  if (value && typeof value === 'object') {
    email = String(value.email || value.address || '').trim();
    name = String(value.name || '');
  } else {
    const s = String(value || '').trim();
    const m = /^(?:"((?:[^"\\\r\n]|\\.){0,200})"|([^"<>\r\n]{0,200}?))\s*<([^<>\s]+)>$/.exec(s);
    if (m) { email = m[3]; name = (m[1] ?? m[2] ?? '').replace(/\\(.)/g, '$1'); } else email = s;
  }
  if (!EMAIL_RE.test(email)) return null;
  name = name.replace(/[\r\n"<>]/g, ' ').trim().slice(0, 100);
  return name ? { email, name } : { email };
}

const list = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]).map(toAddress).filter(Boolean);

function failure(r) {
  const first = Array.isArray(r.json?.errors) ? r.json.errors[0] : null;
  const msg = String(first?.message || '');
  if (r.status === 401) return new ProviderError('sendgrid', 'SendGrid refused the API key. Check it in SendGrid > Settings > API Keys.', { status: 401, kind: 'auth' });
  if (r.status === 403) {
    if (/sender identity|verified sender|from address/i.test(msg)) {
      return new ProviderError('sendgrid', 'SendGrid will not send from this address: authenticate the domain (or verify the sender) in SendGrid > Settings > Sender Authentication.', { status: 403, kind: 'invalid' });
    }
    return new ProviderError('sendgrid', 'This SendGrid API key may not send mail. Give it the Mail Send permission.', { status: 403, kind: 'auth' });
  }
  if (r.status === 413) return new ProviderError('sendgrid', 'The email is too big for SendGrid (30 MB including attachments).', { status: 413, kind: 'invalid' });
  if (r.status === 429) return new ProviderError('sendgrid', 'SendGrid is rate limiting or the plan\'s sending limit is reached. We will try again shortly.', { status: 429, retry: true, kind: 'quota' });
  return httpFailure('sendgrid', r.status, msg || null, first?.field ? String(first.field).slice(0, 60) : null);
}

/**
 * Build the Mail Send request body. Exported for tests.
 * @param {object} m
 * @param {string|object} m.from
 * @param {string|string[]|object[]} m.to
 * @param {string|string[]} [m.cc]
 * @param {string|string[]} [m.bcc]
 * @param {string|object} [m.replyTo]
 * @param {string} m.subject
 * @param {string} [m.text]
 * @param {string} [m.html]
 * @param {Record<string, string>} [m.headers]
 * @param {{ content: string, filename: string, type?: string, disposition?: 'attachment'|'inline', contentId?: string }[]} [m.attachments] content is base64
 * @param {string[]} [m.categories]
 * @param {Record<string, string>} [m.customArgs]
 * @param {boolean} [m.trackOpens]
 */
export function mailSendBody(m) {
  const from = toAddress(m.from);
  if (!from) throw new ProviderError('sendgrid', 'The sender address is not valid.', { kind: 'invalid' });
  const to = list(m.to);
  const cc = list(m.cc).filter((a) => !to.some((t) => t.email.toLowerCase() === a.email.toLowerCase()));
  const bcc = list(m.bcc).filter((a) => ![...to, ...cc].some((t) => t.email.toLowerCase() === a.email.toLowerCase()));
  if (!to.length) throw new ProviderError('sendgrid', 'There is no valid recipient address.', { kind: 'invalid' });
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) throw new ProviderError('sendgrid', 'Too many recipients (SendGrid allows 1,000).', { kind: 'invalid' });
  const personalization = { to };
  if (cc.length) personalization.cc = cc;
  if (bcc.length) personalization.bcc = bcc;
  const args = Object.entries(m.customArgs || {}).filter(([, v]) => v != null && v !== '').map(([k, v]) => [String(k).slice(0, 100), String(v).slice(0, 500)]);
  if (args.length) personalization.custom_args = Object.fromEntries(args);

  const text = String(m.text ?? '').trim() ? String(m.text) : ' ';
  const content = [{ type: 'text/plain', value: text }];
  if (m.html) content.push({ type: 'text/html', value: String(m.html) });
  const body = {
    personalizations: [personalization],
    from,
    subject: String(m.subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 900) || '(no subject)',
    content,
    // Click tracking rewrites links (password reset links included) through SendGrid's
    // domain, so it stays off. Opens are reported only when asked for.
    tracking_settings: { click_tracking: { enable: false, enable_text: false }, open_tracking: { enable: Boolean(m.trackOpens) } },
  };
  const replyTo = m.replyTo ? toAddress(m.replyTo) : null;
  if (replyTo) body.reply_to = replyTo;
  const headers = Object.entries(m.headers || {})
    .filter(([k, v]) => /^[A-Za-z0-9-]{1,76}$/.test(k) && !RESERVED_HEADERS.has(k.toLowerCase()) && v != null && String(v) !== '')
    .map(([k, v]) => [k, String(v).replace(/[\r\n]+/g, ' ').slice(0, 2000)]);
  if (headers.length) body.headers = Object.fromEntries(headers);
  const cats = [...new Set((m.categories || []).map((c) => String(c).replace(/[^A-Za-z0-9 _.-]/g, '').slice(0, 255)).filter(Boolean))].slice(0, 10);
  if (cats.length) body.categories = cats;
  if (m.attachments?.length) {
    body.attachments = m.attachments.map((a) => ({
      content: a.content,
      filename: String(a.filename || 'attachment').replace(/[\r\n"\\/]/g, '_').slice(0, 255),
      type: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(a.type || '') ? a.type : 'application/octet-stream',
      disposition: a.disposition === 'inline' && a.contentId ? 'inline' : 'attachment',
      ...(a.disposition === 'inline' && a.contentId ? { content_id: String(a.contentId).slice(0, 200) } : {}),
    }));
  }
  return body;
}

/**
 * Send one email. Resolves to { id } (X-Message-Id), throws ProviderError.
 * @param {{ apiKey: string } & Parameters<typeof mailSendBody>[0]} m
 */
export async function sendMail(m) {
  const body = mailSendBody(m);
  const r = await request('sendgrid', `${SENDGRID_API}/v3/mail/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${m.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 30_000,
  });
  if (!r.ok) throw failure(r);
  const id = typeof r.headers?.get === 'function' ? r.headers.get('x-message-id') : null;
  return { id: id ? String(id).slice(0, 200) : '' };
}

/**
 * Same call shape as resend.sendEmail, for company email (outbox.js). Tags become
 * categories; SendGrid has no idempotency key, so the outbox id goes in custom_args.
 */
export function sendEmail({ apiKey, from, to, subject, text, html, replyTo, idempotencyKey, tags }) {
  return sendMail({
    apiKey, from, to, subject, text, html, replyTo,
    categories: (tags || []).map((t) => `${t.name}-${t.value}`),
    customArgs: idempotencyKey ? { fishtape_ref: String(idempotencyKey) } : undefined,
  });
}

/**
 * GET /v3/scopes (read-only): the permissions of the key. A Mail Send key can always call
 * it. The domain is checked only when the key may read Sender Authentication.
 */
export async function testSendgrid({ apiKey, from }) {
  const r = await request('sendgrid', `${SENDGRID_API}/v3/scopes`, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!r.ok) throw failure(r);
  const scopes = Array.isArray(r.json?.scopes) ? r.json.scopes : [];
  if (!scopes.includes('mail.send')) return { status: 'error', message: 'This SendGrid key cannot send mail. Create a key with the Mail Send permission.' };
  const addr = senderAddress(from);
  const domain = addr ? addr.split('@')[1].toLowerCase() : null;
  if (!scopes.includes('whitelabel.read')) {
    return { status: 'ok', message: `Key works and can send. It cannot read Sender Authentication, so we could not check that ${domain || 'your domain'} is authenticated. Send yourself a test to be sure.` };
  }
  const d = await request('sendgrid', `${SENDGRID_API}/v3/whitelabel/domains`, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!d.ok) return { status: 'ok', message: 'Key works and can send. The domain check did not answer; send yourself a test to be sure.' };
  const rows = Array.isArray(d.json) ? d.json : [];
  const match = domain && rows.find((x) => String(x.domain || '').toLowerCase() === domain || domain.endsWith(`.${String(x.domain || '').toLowerCase()}`));
  if (!match) return { status: 'warning', message: `Key works, but ${domain || 'the sender domain'} is not authenticated in this SendGrid account. See Settings > Sender Authentication.` };
  if (!match.valid) return { status: 'warning', message: `Key works, but ${domain} is not verified yet in SendGrid. Finish the DNS records and press Verify.` };
  return { status: 'ok', message: `Connected. ${domain} is authenticated.` };
}
