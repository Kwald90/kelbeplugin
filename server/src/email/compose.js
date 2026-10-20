// Mail HQ staff write: drafts, replies, forwards and new messages. A sent message is two rows
// in one transaction: the HQ copy (mail_messages, folder 'sent') and the queue entry
// (email_outbox, drained by the worker through SendGrid with ft_outbox_id in custom_args).
// Replies carry In-Reply-To and References, and every message gets a Message-ID on our own
// domain, so answers thread back into the same conversation.
import { randomUUID } from 'node:crypto';
import { EMAIL_RE } from '../integrations/providers.js';
import { htmlToText, sanitizeHtml } from './sanitize.js';
import { previewOf } from './mime.js';
import { findThread, newThread, touchThread } from './inbox.js';

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // total per message; SendGrid's limit is 30 MB with base64 overhead
const lower = (s) => String(s || '').trim().toLowerCase();

/** "Name <a@b>" or "a@b" -> { name, address }, or null. */
export function parseRecipient(v) {
  const s = String(v || '').trim();
  const m = /^(?:"?([^"<>]{0,200})"?\s*)?<([^<>\s]+)>$/.exec(s);
  const address = lower(m ? m[2] : s);
  if (!EMAIL_RE.test(address)) return null;
  return { name: m?.[1]?.trim() || '', address };
}

export function recipients(list, max = 100) {
  const out = [];
  for (const v of Array.isArray(list) ? list : String(list || '').split(/[,;]\s*/)) {
    if (!String(v).trim()) continue;
    const r = parseRecipient(v);
    if (!r) throw Object.assign(new Error(`"${String(v).slice(0, 80)}" is not an email address.`), { code: 'bad_recipient' });
    if (!out.some((x) => x.address === r.address)) out.push(r);
  }
  if (out.length > max) throw Object.assign(new Error(`At most ${max} recipients.`), { code: 'bad_recipient' });
  return out;
}

const fmt = (r) => (r.name ? `"${r.name.replace(/["\\]/g, '')}" <${r.address}>` : r.address);

/** The From line for a mailbox: its from_address (an authenticated domain) or its own address. */
export function mailboxSender(mb) {
  const address = mb.from_address || mb.address;
  return { name: mb.from_name || mb.name, address, header: fmt({ name: mb.from_name || mb.name, address }) };
}

/**
 * Save or send. `draftId` updates that draft; `send` queues it.
 * @param {import('pg').PoolClient} c HQ client
 * @param {object} o
 */
export async function saveMessage(c, o) {
  const { mailbox, userId, domain, send } = o;
  const to = recipients(o.to);
  const cc = recipients(o.cc);
  const bcc = recipients(o.bcc);
  if (send && !to.length && !cc.length && !bcc.length) throw Object.assign(new Error('Add at least one recipient.'), { code: 'bad_recipient' });
  if (to.length + cc.length + bcc.length > 100) throw Object.assign(new Error('At most 100 recipients.'), { code: 'bad_recipient' });
  const subject = String(o.subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 900);
  const html = sanitizeHtml(String(o.html || ''), { mode: 'compose' }).html;
  const text = htmlToText(html);

  // Reply / forward context.
  let parent = null;
  if (o.replyToId || o.forwardOfId) {
    const { rows } = await c.query('SELECT id, thread_id, mailbox_id, message_id, refs FROM mail_messages WHERE id = $1', [o.replyToId || o.forwardOfId]);
    parent = rows[0] || null;
    if (!parent) throw Object.assign(new Error('The original message is gone.'), { code: 'not_found' });
  }

  let draft = null;
  if (o.draftId) {
    const { rows } = await c.query("SELECT id, thread_id, message_id, in_reply_to, refs FROM mail_messages WHERE id = $1 AND folder = 'drafts' FOR UPDATE", [o.draftId]);
    draft = rows[0] || null;
    if (!draft) throw Object.assign(new Error('That draft was sent or deleted.'), { code: 'not_found' });
  }

  const messageId = draft?.message_id || `${randomUUID()}@${domain}`;
  const inReplyTo = draft ? draft.in_reply_to : (o.replyToId && parent?.message_id) || null;
  const refs = draft ? draft.refs : (o.replyToId && parent ? [...(parent.refs || []), parent.message_id].filter(Boolean).slice(-20) : []);
  const now = new Date();
  let threadId = draft?.thread_id || (o.replyToId && parent && parent.mailbox_id === mailbox.id ? parent.thread_id : null);
  if (!threadId && !o.forwardOfId) threadId = await findThread(c, mailbox.id, { subject, participants: [...to, ...cc].map((r) => r.address) });
  if (!threadId) threadId = await newThread(c, mailbox.id, subject, now);
  await touchThread(c, threadId, now);
  const sender = mailboxSender(mailbox);

  // Attachments: uploads by this user not yet on a message, plus ones already on the draft.
  const ids = [...new Set((o.attachmentIds || []).filter((x) => typeof x === 'string'))].slice(0, 50);
  const { rows: files } = ids.length
    ? await c.query('SELECT id, storage_key, filename, content_type, size_bytes, content_id, is_inline, message_id FROM mail_attachments WHERE id = ANY($1) AND (message_id IS NULL OR message_id = $2)', [ids, draft?.id || null])
    : { rows: [] };
  if (files.length !== ids.length) throw Object.assign(new Error('An attachment is missing. Attach it again.'), { code: 'not_found' });
  if (files.reduce((n, f) => n + f.size_bytes, 0) > MAX_ATTACHMENT_BYTES) throw Object.assign(new Error('Attachments are limited to 20 MB per message.'), { code: 'too_large' });

  const fields = [
    mailbox.id, threadId, send ? 'sent' : 'drafts', messageId, inReplyTo, refs, sender.name, sender.address,
    JSON.stringify(to), JSON.stringify(cc), JSON.stringify(bcc), subject, text, html, previewOf(text), files.some((f) => !f.is_inline),
    Buffer.byteLength(html) + files.reduce((n, f) => n + f.size_bytes, 0), send ? 'queued' : null, userId, send ? now : null, now,
  ];
  let id;
  if (draft) {
    id = draft.id;
    await c.query(
      `UPDATE mail_messages SET mailbox_id = $1, thread_id = $2, folder = $3, message_id = $4, in_reply_to = $5, refs = $6, from_name = $7, from_address = $8,
          to_list = $9, cc_list = $10, bcc_list = $11, subject = $12, text_body = $13, html_body = $14, preview = $15, has_attachments = $16,
          size_bytes = $17, send_status = $18, created_by = $19, sent_at = $20, received_at = $21, updated_at = now(), is_read = true
        WHERE id = $22`, [...fields, id]);
    await c.query('UPDATE mail_attachments SET message_id = NULL WHERE message_id = $1 AND NOT (id = ANY($2))', [id, ids]);
  } else {
    const { rows } = await c.query(
      `INSERT INTO mail_messages (mailbox_id, thread_id, direction, folder, source, message_id, in_reply_to, refs, from_name, from_address,
          to_list, cc_list, bcc_list, subject, text_body, html_body, preview, has_attachments, size_bytes, send_status, created_by, sent_at, received_at, is_read)
       VALUES ($1, $2, 'out', $3, 'compose', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, true) RETURNING id`, fields);
    id = rows[0].id;
  }
  if (ids.length) await c.query('UPDATE mail_attachments SET message_id = $1 WHERE id = ANY($2)', [id, ids]);

  let outboxId = null;
  if (send) {
    const headers = { 'Message-ID': `<${messageId}>` };
    if (inReplyTo) headers['In-Reply-To'] = `<${inReplyTo}>`;
    if (refs.length) headers.References = refs.map((r) => `<${r}>`).join(' ');
    const replyTo = sender.address !== mailbox.address ? fmt({ name: sender.name, address: mailbox.address }) : null;
    const all = [...to, ...cc, ...bcc];
    const ob = await c.query(
      `INSERT INTO email_outbox (to_address, to_addresses, cc_addresses, bcc_addresses, from_address, reply_to, subject, text_body, html_body, template,
          headers, attachments, mail_message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'hq-mail', $10, $11, $12) RETURNING id`,
      [all[0].address, to.map(fmt), cc.map(fmt), bcc.map(fmt), sender.header, replyTo, subject || '(no subject)', text || ' ', html || null,
        JSON.stringify(headers), JSON.stringify(files.map((f) => ({ key: f.storage_key, filename: f.filename, contentType: f.content_type, size: f.size_bytes, inline: f.is_inline, contentId: f.content_id }))), id]);
    outboxId = ob.rows[0].id;
    await c.query('UPDATE mail_messages SET outbox_id = $2 WHERE id = $1', [id, outboxId]);
  }
  return { id, threadId, outboxId, messageId };
}
