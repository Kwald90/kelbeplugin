// /api/hq/mail/*: HQ Mail, the Outlook-style inbox in the HQ console (hq/js/pages/mail.js).
// HQ staff only (MFA verified), through the fishtape_hq role; mailbox and retention settings
// need an HQ admin. Search terms and addresses travel in bodies, never in URLs.
// docs/email/README.md describes the folders, the security model and every endpoint.
import { ApiError, badRequest, notFound } from '../errors.js';
import { hqAudit, iso, requireHqAdmin } from '../services/hq-common.js';
import { enqueue } from '../services/queue.js';
import { mailSettings } from '../email/config.js';
import { createMailStore } from '../email/storage.js';
import { syncMail } from '../email/inbox.js';
import { MAX_ATTACHMENT_BYTES, saveMessage } from '../email/compose.js';
import { remoteImageUrls, sanitizeHtml, textToSafeHtml } from '../email/sanitize.js';
import { fetchImage } from '../email/image-proxy.js';
import { safeFilename } from '../email/mime.js';

const MiB = 1024 * 1024;
const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } };
const FOLDERS = ['inbox', 'drafts', 'sent', 'outbox', 'not_sent', 'archive', 'junk', 'trash', 'all'];

/** Folder views. Outbox and Not sent are views of sent mail by its send/delivery state. */
const FOLDER_SQL = {
  inbox: "m.folder = 'inbox'",
  drafts: "m.folder = 'drafts'",
  sent: "m.folder = 'sent' AND COALESCE(m.send_status, 'sent') = 'sent' AND m.delivery_status IS DISTINCT FROM 'deferred'",
  outbox: "m.folder = 'sent' AND (m.send_status IN ('queued', 'sending') OR (m.send_status = 'sent' AND m.delivery_status = 'deferred'))",
  not_sent: "m.folder = 'sent' AND m.send_status = 'failed'",
  archive: "m.folder = 'archive'",
  junk: "m.folder = 'junk'",
  trash: "m.folder = 'trash'",
  all: "m.folder <> 'trash'",
};
const SYSTEM_SQL = {
  outbox: "(o.status IN ('queued', 'sending') OR (o.status = 'sent' AND o.delivery_status = 'deferred'))",
  not_sent: "o.status = 'failed'",
  sent: "o.status = 'sent' AND o.delivery_status IS DISTINCT FROM 'deferred'",
  all: 'true',
};

/** Downloads keep their type only when it is inert; everything else is a plain byte stream. */
const SAFE_TYPES = new Set([
  'application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain', 'text/csv', 'text/calendar', 'application/zip',
  'application/msword', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'audio/mpeg', 'video/mp4',
]);
const INLINE_IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function downloadHeaders(filename, contentType) {
  const name = safeFilename(filename, contentType);
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_');
  return {
    'content-type': SAFE_TYPES.has(contentType) ? contentType : 'application/octet-stream',
    'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'cache-control': 'no-store',
  };
}

const like = (s) => `%${String(s).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const addr = (list) => (Array.isArray(list) ? list : []).map((a) => ({ name: a.name || '', address: a.address || '' }));

function listItem(r) {
  return {
    id: r.id, threadId: r.thread_id, mailboxId: r.mailbox_id, folder: r.folder, direction: r.direction, source: r.source,
    from: { name: r.from_name || '', address: r.from_address || '' }, to: addr(r.to_list), subject: r.subject, preview: r.preview,
    date: iso(r.received_at), read: r.is_read, flagged: r.is_flagged || Boolean(r.thread_flagged), hasAttachments: r.has_attachments || Boolean(r.thread_attachments),
    spam: r.is_spam, sendStatus: r.send_status, deliveryStatus: r.delivery_status, deliveryDetail: r.delivery_detail,
    threadCount: r.thread_count ?? 1, threadUnread: r.thread_unread ?? (r.is_read ? 0 : 1),
    assignedTo: r.assigned_to || null, assignedName: r.assigned_name || null,
  };
}

/** @param {import('fastify').FastifyInstance} app */
export default async function hqMailRoutes(app, { config, db }) {
  const settings = mailSettings(config);
  const store = createMailStore(settings);
  const getImage = settings.fetchImage || fetchImage;
  const hq = { auth: 'hq' };
  const sync = () => syncMail(db, { store }).catch((e) => { app.log.error({ err: { message: e.message, code: e.code } }, 'mail sync failed'); return null; });

  async function mailboxOf(c, id) {
    const { rows } = await c.query('SELECT * FROM mail_mailboxes WHERE id = $1', [id]);
    if (!rows[0]) throw notFound('No such mailbox.');
    return rows[0];
  }

  // ---- folders, counts, staff, settings ----------------------------------------------------------
  app.get('/api/hq/mail/overview', { config: hq, schema: { tags: ['hq-mail'], summary: 'Mailboxes with folder counts, system email counts, staff and settings' } }, async () => {
    await sync();
    return db.withHq(async (c) => {
      const boxes = (await c.query('SELECT * FROM mail_mailboxes ORDER BY sort, name')).rows;
      const counts = new Map((await c.query(
        `SELECT mailbox_id,
                count(*) FILTER (WHERE folder = 'inbox' AND NOT is_read)::int AS inbox_unread,
                count(*) FILTER (WHERE folder = 'inbox')::int AS inbox,
                count(*) FILTER (WHERE folder = 'drafts')::int AS drafts,
                count(*) FILTER (WHERE ${FOLDER_SQL.outbox.replace(/m\./g, '')})::int AS outbox,
                count(*) FILTER (WHERE ${FOLDER_SQL.not_sent.replace(/m\./g, '')})::int AS not_sent,
                count(*) FILTER (WHERE folder = 'archive' AND NOT is_read)::int AS archive_unread,
                count(*) FILTER (WHERE folder = 'junk' AND NOT is_read)::int AS junk_unread,
                count(*) FILTER (WHERE folder = 'trash')::int AS trash
           FROM mail_messages GROUP BY mailbox_id`)).rows.map((r) => [r.mailbox_id, r]));
      const sys = (await c.query(
        `SELECT count(*) FILTER (WHERE ${SYSTEM_SQL.outbox})::int AS outbox, count(*) FILTER (WHERE ${SYSTEM_SQL.not_sent})::int AS not_sent,
                count(*) FILTER (WHERE ${SYSTEM_SQL.sent})::int AS sent
           FROM email_outbox o WHERE o.mail_message_id IS NULL`)).rows[0];
      const staff = (await c.query("SELECT id, display_name FROM users WHERE platform_role IS NOT NULL AND status = 'active' ORDER BY display_name")).rows;
      const s = (await c.query('SELECT retention_days, cleanup_days, spam_threshold, last_cleanup_at FROM mail_settings')).rows[0];
      const backlog = (await c.query(`SELECT count(*) FILTER (WHERE attempts = 0)::int AS pending, count(*) FILTER (WHERE attempts > 0)::int AS failing FROM mail_inbound`)).rows[0];
      return {
        mailboxes: boxes.map((b) => {
          const n = counts.get(b.id) || {};
          return {
            id: b.id, name: b.name, address: b.address, aliases: b.aliases, fromName: b.from_name, fromAddress: b.from_address, signatureHtml: b.signature_html,
            isDefault: b.is_default,
            counts: { inboxUnread: n.inbox_unread || 0, inbox: n.inbox || 0, drafts: n.drafts || 0, outbox: n.outbox || 0, notSent: n.not_sent || 0, archiveUnread: n.archive_unread || 0, junkUnread: n.junk_unread || 0, trash: n.trash || 0 },
          };
        }),
        system: { outbox: sys.outbox, notSent: sys.not_sent, sent: sys.sent },
        staff: staff.map((u) => ({ id: u.id, name: u.display_name })),
        settings: { retentionDays: s.retention_days, cleanupDays: s.cleanup_days, spamThreshold: s.spam_threshold, lastCleanupAt: iso(s.last_cleanup_at) },
        inbound: { pending: backlog.pending, failing: backlog.failing },
        setup: {
          provider: settings.provider, sending: Boolean(settings.from && (settings.provider === 'sendgrid' ? settings.sendgridApiKey : settings.resendApiKey)),
          eventsSigned: Boolean(settings.eventPublicKey), inbound: Boolean(settings.inboundToken), storage: Boolean(store),
        },
      };
    });
  });

  // ---- the message list ----------------------------------------------------------------------------
  app.post('/api/hq/mail/list', {
    config: hq,
    schema: {
      tags: ['hq-mail'], summary: 'Messages in a folder (conversations grouped), with search filters',
      body: {
        type: 'object', required: ['mailboxId', 'folder'], additionalProperties: false,
        properties: {
          mailboxId: { type: 'string', maxLength: 36 }, folder: { type: 'string', enum: FOLDERS },
          q: { type: 'string', maxLength: 200 }, from: { type: 'string', maxLength: 200 }, to: { type: 'string', maxLength: 200 }, subject: { type: 'string', maxLength: 200 },
          hasAttachment: { type: 'boolean' }, unread: { type: 'boolean' }, flagged: { type: 'boolean' }, group: { type: 'boolean' },
          cursor: { type: 'string', maxLength: 100 }, limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
      },
    },
  }, async (req) => {
    const b = req.body;
    const limit = b.limit || 50;
    let cur = null;
    if (b.cursor) {
      const [at, id] = String(b.cursor).split('|');
      if (!at || Number.isNaN(Date.parse(at)) || !new RegExp(UUID).test(id || '')) throw badRequest('Bad cursor.');
      cur = { at, id };
    }
    if (b.mailboxId === 'system') return systemList(b, limit, cur);
    if (!new RegExp(UUID).test(b.mailboxId)) throw badRequest('Pick a mailbox.');
    await sync();
    return db.withHq(async (c) => {
      const params = [b.mailboxId];
      const where = ['m.mailbox_id = $1', FOLDER_SQL[b.folder]];
      const add = (sql, v) => { params.push(v); where.push(sql.replace(/\$\?/g, `$${params.length}`)); };
      if (b.q?.trim()) add("(m.search @@ websearch_to_tsquery('simple', $?) OR m.subject ILIKE '%' || $? || '%')", b.q.trim());
      if (b.from?.trim()) add('(m.from_address ILIKE $? OR m.from_name ILIKE $?)', like(b.from.trim()));
      if (b.to?.trim()) add(`EXISTS (SELECT 1 FROM jsonb_array_elements(m.to_list || m.cc_list) e WHERE e->>'address' ILIKE $? OR e->>'name' ILIKE $?)`, like(b.to.trim()));
      if (b.subject?.trim()) add('m.subject ILIKE $?', like(b.subject.trim()));
      if (b.hasAttachment) where.push('m.has_attachments');
      if (b.unread) where.push('NOT m.is_read');
      if (b.flagged) where.push('m.is_flagged');
      const searching = Boolean(b.q || b.from || b.to || b.subject || b.hasAttachment || b.unread || b.flagged);
      const group = b.group !== false && !searching && b.folder !== 'drafts';
      const cols = `m.id, m.thread_id, m.mailbox_id, m.folder, m.direction, m.source, m.from_name, m.from_address, m.to_list, m.subject, m.preview, m.received_at,
                    m.is_read, m.is_flagged, m.has_attachments, m.is_spam, m.send_status, m.delivery_status, m.delivery_detail`;
      const inner = group
        ? `SELECT DISTINCT ON (m.thread_id) ${cols},
                  count(*) OVER (PARTITION BY m.thread_id)::int AS thread_count,
                  (count(*) FILTER (WHERE NOT m.is_read) OVER (PARTITION BY m.thread_id))::int AS thread_unread,
                  bool_or(m.is_flagged) OVER (PARTITION BY m.thread_id) AS thread_flagged,
                  bool_or(m.has_attachments) OVER (PARTITION BY m.thread_id) AS thread_attachments
             FROM mail_messages m WHERE ${where.join(' AND ')} ORDER BY m.thread_id, m.received_at DESC, m.id DESC`
        : `SELECT ${cols} FROM mail_messages m WHERE ${where.join(' AND ')}`;
      let page = '';
      if (cur) { params.push(cur.at, cur.id); page = `WHERE (x.received_at, x.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`; }
      params.push(limit + 1);
      const { rows } = await c.query(
        `SELECT x.*, t.assigned_to, u.display_name AS assigned_name FROM (${inner}) x
           JOIN mail_threads t ON t.id = x.thread_id LEFT JOIN users u ON u.id = t.assigned_to
           ${page} ORDER BY x.received_at DESC, x.id DESC LIMIT $${params.length}`, params);
      const more = rows.length > limit;
      const items = rows.slice(0, limit).map(listItem);
      const last = rows[limit - 1];
      return { items, grouped: group, nextCursor: more && last ? `${iso(last.received_at)}|${last.id}` : null };
    });
  });

  async function systemList(b, limit, cur) {
    if (b.folder !== 'all' && !SYSTEM_SQL[b.folder]) return { items: [], grouped: false, nextCursor: null };
    return db.withHq(async (c) => {
      const params = [];
      const where = ['o.mail_message_id IS NULL', SYSTEM_SQL[b.folder]];
      const text = [b.q, b.to, b.subject].map((x) => String(x || '').trim()).find(Boolean);
      if (text) { params.push(like(text)); where.push(`(o.to_address ILIKE $${params.length} OR o.subject ILIKE $${params.length} OR o.template ILIKE $${params.length})`); }
      if (cur) { params.push(cur.at, cur.id); where.push(`(o.created_at, o.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`); }
      params.push(limit + 1);
      const { rows } = await c.query(
        `SELECT o.id, o.to_address, o.subject, o.template, o.status, o.attempts, o.last_error, o.delivery_status, o.delivery_detail, o.created_at, o.sent_at, o.provider
           FROM email_outbox o WHERE ${where.join(' AND ')} ORDER BY o.created_at DESC, o.id DESC LIMIT $${params.length}`, params);
      const more = rows.length > limit;
      const items = rows.slice(0, limit).map((r) => ({
        id: r.id, system: true, to: [{ name: '', address: r.to_address }], from: { name: 'Fishtape', address: settings.from || '' }, subject: r.subject,
        preview: r.status === 'failed' ? (r.last_error || 'Not sent') : `${r.template || 'system'} email`, template: r.template, date: iso(r.created_at), read: true,
        sendStatus: r.status, deliveryStatus: r.delivery_status, deliveryDetail: r.status === 'failed' ? r.last_error : r.delivery_detail, attempts: r.attempts, provider: r.provider,
        threadCount: 1, threadUnread: 0, folder: b.folder, direction: 'out',
      }));
      const last = rows[limit - 1];
      return { items, grouped: false, nextCursor: more && last ? `${iso(last.created_at)}|${last.id}` : null };
    });
  }

  app.get('/api/hq/mail/system/:id', { config: hq, schema: { tags: ['hq-mail'], summary: 'A system email: who, what, status and delivery events (never the body)', params: idParams } }, async (req) => {
    return db.withHq(async (c) => {
      const { rows } = await c.query(
        `SELECT id, to_address, subject, template, status, attempts, last_error, delivery_status, delivery_detail, delivery_at, opened_at, created_at, sent_at, provider, provider_message_id
           FROM email_outbox WHERE id = $1 AND mail_message_id IS NULL`, [req.params.id]);
      const o = rows[0];
      if (!o) throw notFound('No such email. Sent system email is kept for 7 days.');
      const events = (await c.query('SELECT event, recipient, reason, occurred_at FROM email_events WHERE outbox_id = $1 ORDER BY occurred_at, id', [o.id])).rows;
      return {
        id: o.id, to: o.to_address, subject: o.subject, template: o.template, status: o.status, attempts: o.attempts, error: o.last_error,
        deliveryStatus: o.delivery_status, deliveryDetail: o.delivery_detail, deliveryAt: iso(o.delivery_at), openedAt: iso(o.opened_at),
        createdAt: iso(o.created_at), sentAt: iso(o.sent_at), provider: o.provider, providerMessageId: o.provider_message_id,
        events: events.map((e) => ({ event: e.event, recipient: e.recipient, reason: e.reason, at: iso(e.occurred_at) })),
        note: 'System email bodies are not shown: they can hold sign-in and password reset links.',
      };
    });
  });

  // ---- one message ------------------------------------------------------------------------------
  /** Inline cid: images of a message as data: URLs (raster only, 2 MB each, 8 MB in all). */
  async function cidImages(c, messageId) {
    const map = new Map();
    if (!store) return map;
    const { rows } = await c.query('SELECT storage_key, content_type, size_bytes, content_id FROM mail_attachments WHERE message_id = $1 AND content_id IS NOT NULL ORDER BY created_at', [messageId]);
    let total = 0;
    for (const a of rows) {
      if (!INLINE_IMAGE.has(a.content_type) || a.size_bytes > 2 * MiB || total + a.size_bytes > 8 * MiB) continue;
      try { map.set(a.content_id, `data:${a.content_type};base64,${(await store.read(a.storage_key)).toString('base64')}`); total += a.size_bytes; } catch { /* file missing */ }
    }
    return map;
  }

  app.get('/api/hq/mail/messages/:id', {
    config: hq,
    schema: { tags: ['hq-mail'], summary: 'A message: sanitized HTML for the sandboxed reading pane, attachments, conversation and delivery events', params: idParams,
      querystring: { type: 'object', properties: { images: { type: 'string', enum: ['0', '1'] } } } },
  }, async (req) => {
    const id = req.params.id;
    return db.withHq(async (c) => {
      const { rows } = await c.query(
        `SELECT m.*, t.assigned_to, u.display_name AS assigned_name, mb.name AS mailbox_name, mb.address AS mailbox_address
           FROM mail_messages m JOIN mail_threads t ON t.id = m.thread_id JOIN mail_mailboxes mb ON mb.id = m.mailbox_id LEFT JOIN users u ON u.id = t.assigned_to
          WHERE m.id = $1`, [id]);
      const m = rows[0];
      if (!m) throw notFound('No such message.');
      const attachments = (await c.query('SELECT id, filename, content_type, size_bytes, content_id, is_inline FROM mail_attachments WHERE message_id = $1 ORDER BY created_at, filename', [id])).rows;
      const thread = (await c.query(
        `SELECT id, folder, direction, from_name, from_address, to_list, subject, preview, received_at, is_read, send_status, delivery_status, has_attachments
           FROM mail_messages WHERE thread_id = $1 AND (folder <> 'trash' OR id = $2) ORDER BY received_at, id`, [m.thread_id, id])).rows;
      const events = m.outbox_id
        ? (await c.query('SELECT event, recipient, reason, occurred_at FROM email_events WHERE outbox_id = $1 ORDER BY occurred_at, id', [m.outbox_id])).rows : [];
      const outbox = m.outbox_id
        ? (await c.query('SELECT status, attempts, last_error, delivery_status, delivery_detail, sent_at, opened_at FROM email_outbox WHERE id = $1', [m.outbox_id])).rows[0] || null : null;
      const cids = await cidImages(c, id);
      const images = req.query?.images === '1' ? 'allow' : 'block';
      const view = m.html_body
        ? sanitizeHtml(m.html_body, { images, imageUrl: (n) => `/api/hq/mail/messages/${id}/images/${n}`, cid: (cid) => cids.get(cid) || null })
        : { html: textToSafeHtml(m.text_body || ''), css: '', bodyStyle: '', blockedImages: 0, trackers: 0 };
      const quote = m.html_body ? sanitizeHtml(m.html_body, { mode: 'compose' }).html : textToSafeHtml(m.text_body || '');
      return {
        id: m.id, threadId: m.thread_id, mailbox: { id: m.mailbox_id, name: m.mailbox_name, address: m.mailbox_address },
        folder: m.folder, direction: m.direction, source: m.source,
        from: { name: m.from_name || '', address: m.from_address || '' }, to: addr(m.to_list), cc: addr(m.cc_list), bcc: addr(m.bcc_list), replyTo: addr(m.reply_to_list),
        subject: m.subject, date: iso(m.received_at), sentAt: iso(m.sent_at), read: m.is_read, flagged: m.is_flagged, spam: m.is_spam, spamScore: m.spam_score,
        auth: m.auth_results || null, meta: m.meta || null, messageId: m.message_id,
        assignedTo: m.assigned_to, assignedName: m.assigned_name || null,
        sendStatus: m.send_status, deliveryStatus: m.delivery_status, deliveryDetail: m.delivery_detail,
        delivery: outbox ? { status: outbox.status, attempts: outbox.attempts, error: outbox.last_error, deliveryStatus: outbox.delivery_status, detail: outbox.delivery_detail, sentAt: iso(outbox.sent_at), openedAt: iso(outbox.opened_at) } : null,
        events: events.map((e) => ({ event: e.event, recipient: e.recipient, reason: e.reason, at: iso(e.occurred_at) })),
        attachments: attachments.map((a) => ({ id: a.id, filename: a.filename, contentType: a.content_type, size: a.size_bytes, inline: a.is_inline && Boolean(a.content_id && cids.has(a.content_id)) })),
        render: { html: view.html, css: view.css, bodyStyle: view.bodyStyle, blockedImages: view.blockedImages, trackers: view.trackers, images },
        quoteHtml: quote,
        draft: m.folder === 'drafts' ? { html: m.html_body || '', inReplyTo: m.in_reply_to } : null,
        rawAvailable: Boolean(m.raw_key),
        thread: thread.map((t) => ({ id: t.id, folder: t.folder, direction: t.direction, from: { name: t.from_name || '', address: t.from_address || '' }, to: addr(t.to_list), subject: t.subject, preview: t.preview, date: iso(t.received_at), read: t.is_read, sendStatus: t.send_status, deliveryStatus: t.delivery_status, hasAttachments: t.has_attachments })),
      };
    });
  });

  app.get('/api/hq/mail/messages/:id/images/:n', {
    config: hq,
    schema: { tags: ['hq-mail'], summary: 'A remote image of a message, fetched by the server (after "Show images")',
      params: { type: 'object', required: ['id', 'n'], properties: { id: { type: 'string', pattern: UUID }, n: { type: 'integer', minimum: 0, maximum: 99 } } } },
  }, async (req, reply) => {
    const html = await db.withHq(async (c) => (await c.query('SELECT html_body FROM mail_messages WHERE id = $1', [req.params.id])).rows[0]?.html_body);
    const url = html ? remoteImageUrls(html)[req.params.n] : null;
    if (!url) throw notFound('No such image.');
    let img;
    try { img = await getImage(url); } catch { throw notFound('The image could not be loaded.'); }
    reply.headers({ 'content-type': img.contentType, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'no-store' });
    return img.body;
  });

  app.get('/api/hq/mail/messages/:id/raw', { config: hq, schema: { tags: ['hq-mail'], summary: 'The original message as received (.eml download)', params: idParams } }, async (req, reply) => {
    const key = await db.withHq(async (c) => (await c.query('SELECT raw_key FROM mail_messages WHERE id = $1', [req.params.id])).rows[0]?.raw_key);
    if (!key || !store) throw notFound('The original is not available.');
    let bytes;
    try { bytes = await store.read(key); } catch { throw notFound('The original is not available.'); }
    reply.headers(downloadHeaders('message.eml', 'message/rfc822'));
    return bytes;
  });

  app.get('/api/hq/mail/attachments/:id', { config: hq, schema: { tags: ['hq-mail'], summary: 'Download an attachment (always as a download, with a safe content type)', params: idParams } }, async (req, reply) => {
    const a = await db.withHq(async (c) => (await c.query('SELECT storage_key, filename, content_type FROM mail_attachments WHERE id = $1', [req.params.id])).rows[0]);
    if (!a || !store) throw notFound('No such attachment.');
    let bytes;
    try { bytes = await store.read(a.storage_key); } catch { throw notFound('The file is missing.'); }
    reply.headers(downloadHeaders(a.filename, a.content_type));
    return bytes;
  });

  // ---- changes ---------------------------------------------------------------------------------
  app.patch('/api/hq/mail/messages', {
    config: hq,
    schema: {
      tags: ['hq-mail'], summary: 'Mark read/unread, flag, move (archive, junk, trash, inbox, restore) or assign the conversation',
      body: {
        type: 'object', required: ['ids'], additionalProperties: false,
        properties: {
          ids: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'string', pattern: UUID } },
          read: { type: 'boolean' }, flagged: { type: 'boolean' },
          folder: { type: 'string', enum: ['inbox', 'archive', 'junk', 'trash', 'restore'] },
          assignedTo: { anyOf: [{ type: 'string', pattern: UUID }, { type: 'null' }] },
          thread: { type: 'boolean' },
        },
      },
    },
  }, async (req) => {
    const b = req.body;
    return db.withHq(async (c) => {
      // `thread: true` applies the change to whole conversations (Outlook's conversation view).
      const ids = b.thread
        ? (await c.query("SELECT id FROM mail_messages WHERE thread_id IN (SELECT thread_id FROM mail_messages WHERE id = ANY($1)) AND (folder <> 'trash' OR id = ANY($1))", [b.ids])).rows.map((r) => r.id)
        : b.ids;
      let changed = 0;
      if (b.read !== undefined) changed = (await c.query('UPDATE mail_messages SET is_read = $2 WHERE id = ANY($1) AND is_read <> $2', [ids, b.read])).rowCount;
      if (b.flagged !== undefined) changed += (await c.query('UPDATE mail_messages SET is_flagged = $2, updated_at = now() WHERE id = ANY($1)', [ids, b.flagged])).rowCount;
      if (b.folder === 'restore') {
        changed += (await c.query("UPDATE mail_messages SET folder = COALESCE(prev_folder, CASE WHEN direction = 'out' THEN 'sent' ELSE 'inbox' END), prev_folder = NULL, updated_at = now() WHERE id = ANY($1) AND folder = 'trash'", [ids])).rowCount;
      } else if (b.folder) {
        // Sent mail and drafts keep their folder when moved back; incoming mail can't become "sent".
        const r = await c.query(
          `UPDATE mail_messages SET prev_folder = CASE WHEN $2 = 'trash' THEN folder ELSE NULL END,
                  folder = CASE WHEN $2 = 'inbox' AND direction = 'out' THEN 'sent' ELSE $2 END,
                  is_spam = CASE WHEN $2 = 'junk' THEN true WHEN $2 = 'inbox' THEN false ELSE is_spam END, updated_at = now()
            WHERE id = ANY($1) AND folder <> $2 AND NOT (folder = 'drafts' AND $2 IN ('archive', 'junk'))`, [ids, b.folder]);
        changed += r.rowCount;
        await hqAudit(c, req, null, { action: `mail.move_${b.folder}`, collection: 'mail_messages', summary: `Moved ${r.rowCount} message(s) to ${b.folder}` });
      }
      if (b.assignedTo !== undefined) {
        if (b.assignedTo) {
          const ok = (await c.query("SELECT 1 FROM users WHERE id = $1 AND platform_role IS NOT NULL AND status = 'active'", [b.assignedTo])).rows.length;
          if (!ok) throw badRequest('Assign to an active HQ staff member.');
        }
        const r = await c.query('UPDATE mail_threads SET assigned_to = $2 WHERE id IN (SELECT thread_id FROM mail_messages WHERE id = ANY($1))', [ids, b.assignedTo]);
        changed += r.rowCount;
        await hqAudit(c, req, null, { action: 'mail.assign', collection: 'mail_threads', summary: b.assignedTo ? `Assigned ${r.rowCount} conversation(s)` : `Unassigned ${r.rowCount} conversation(s)` });
      }
      return { changed };
    });
  });

  app.delete('/api/hq/mail/messages', {
    config: hq,
    schema: { tags: ['hq-mail'], summary: 'Delete for good: only messages already in Deleted items, or drafts',
      body: { type: 'object', required: ['ids'], additionalProperties: false, properties: { ids: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'string', pattern: UUID } } } } },
  }, async (req) => {
    const { keys, n } = await db.withHq(async (c) => {
      const { rows } = await c.query("SELECT id, raw_key FROM mail_messages WHERE id = ANY($1) AND folder IN ('trash', 'drafts')", [req.body.ids]);
      const ids = rows.map((r) => r.id);
      if (!ids.length) return { keys: [], n: 0 };
      const files = (await c.query('SELECT storage_key FROM mail_attachments WHERE message_id = ANY($1)', [ids])).rows.map((r) => r.storage_key);
      await c.query('DELETE FROM mail_messages WHERE id = ANY($1)', [ids]);
      await c.query('DELETE FROM mail_threads t WHERE NOT EXISTS (SELECT 1 FROM mail_messages m WHERE m.thread_id = t.id)');
      await hqAudit(c, req, null, { action: 'mail.delete', collection: 'mail_messages', summary: `Deleted ${ids.length} message(s) for good` });
      return { keys: [...files, ...rows.map((r) => r.raw_key).filter(Boolean)], n: ids.length };
    });
    if (store) for (const k of keys) await store.remove(k).catch(() => {});
    return { deleted: n };
  });

  // ---- writing ---------------------------------------------------------------------------------
  const composeBody = {
    type: 'object', required: ['mailboxId'], additionalProperties: false,
    properties: {
      mailboxId: { type: 'string', pattern: UUID }, draftId: { type: 'string', pattern: UUID },
      to: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 320 } },
      cc: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 320 } },
      bcc: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 320 } },
      subject: { type: 'string', maxLength: 900 }, html: { type: 'string', maxLength: 2_000_000 },
      replyToId: { type: 'string', pattern: UUID }, forwardOfId: { type: 'string', pattern: UUID },
      attachmentIds: { type: 'array', maxItems: 50, items: { type: 'string', pattern: UUID } },
    },
  };

  async function write(req, send) {
    const b = req.body;
    try {
      return await db.withHq(async (c) => {
        const mailbox = await mailboxOf(c, b.mailboxId);
        const r = await saveMessage(c, { ...b, mailbox, userId: req.principal.userId, domain: settings.domain, send });
        if (send) {
          await enqueue(c, { kind: 'platform_email', payload: { once: true }, dedupeKey: 'platform_email:now', maxAttempts: 1 });
          await hqAudit(c, req, null, { action: 'mail.send', collection: 'mail_messages', recordId: r.id, summary: `Sent a message from ${mailbox.name}` });
        }
        return r;
      });
    } catch (e) {
      if (e.code === 'bad_recipient') throw new ApiError(400, 'bad_recipient', e.message);
      if (e.code === 'not_found') throw notFound(e.message);
      if (e.code === 'too_large') throw new ApiError(413, 'too_large', e.message);
      throw e;
    }
  }

  app.post('/api/hq/mail/drafts', { config: hq, schema: { tags: ['hq-mail'], summary: 'Save a draft (new, reply or forward)', body: composeBody } }, async (req) => {
    const r = await write(req, false);
    return { id: r.id, threadId: r.threadId };
  });

  // Without SENDGRID_API_KEY and EMAIL_FROM it stays in the Outbox until they are set.
  app.post('/api/hq/mail/send', { config: hq, schema: { tags: ['hq-mail'], summary: 'Send from a mailbox through SendGrid (queued; the worker sends within seconds)', body: composeBody } }, async (req, reply) => {
    const r = await write(req, true);
    reply.code(202);
    return { id: r.id, threadId: r.threadId, queued: true };
  });

  app.post('/api/hq/mail/messages/:id/to-drafts', {
    config: hq, schema: { tags: ['hq-mail'], summary: 'Stop a queued message, or take a failed one back to Drafts to fix and send again', params: idParams },
  }, async (req) => db.withHq(async (c) => {
    const { rows } = await c.query("SELECT id, outbox_id, send_status FROM mail_messages WHERE id = $1 AND folder = 'sent' FOR UPDATE", [req.params.id]);
    const m = rows[0];
    if (!m) throw notFound('No such message.');
    if (m.outbox_id) {
      const o = (await c.query('SELECT status FROM email_outbox WHERE id = $1 FOR UPDATE', [m.outbox_id])).rows[0];
      if (o && o.status === 'queued') await c.query("UPDATE email_outbox SET status = 'failed', last_error = 'Cancelled in HQ Mail' WHERE id = $1", [m.outbox_id]);
      else if (o && o.status !== 'failed') throw new ApiError(409, 'already_sent', 'It has already gone to SendGrid.');
    } else if (m.send_status !== 'failed') throw new ApiError(409, 'already_sent', 'It has already been sent.');
    await c.query("UPDATE mail_messages SET folder = 'drafts', send_status = NULL, delivery_status = NULL, delivery_detail = NULL, outbox_id = NULL, sent_at = NULL, updated_at = now() WHERE id = $1", [m.id]);
    await hqAudit(c, req, null, { action: 'mail.to_drafts', collection: 'mail_messages', recordId: m.id, summary: 'Moved an unsent message back to Drafts' });
    return { id: m.id, folder: 'drafts' };
  }));

  app.post('/api/hq/mail/uploads', {
    config: hq,
    bodyLimit: 28 * MiB,
    schema: {
      tags: ['hq-mail'], summary: 'Upload an attachment for a message being written (base64, 20 MB)',
      body: {
        type: 'object', required: ['filename', 'data'], additionalProperties: false,
        properties: { filename: { type: 'string', minLength: 1, maxLength: 255 }, contentType: { type: 'string', maxLength: 255 }, data: { type: 'string', maxLength: 28 * MiB } },
      },
    },
  }, async (req, reply) => {
    if (!store) throw new ApiError(503, 'mail_storage_unavailable', 'Attachments need MAIL_DIR on the server.');
    if (!/^[A-Za-z0-9+/=\s]*$/.test(req.body.data)) throw badRequest('The file is not base64.');
    const bytes = Buffer.from(req.body.data, 'base64');
    if (!bytes.length) throw badRequest('The file is empty.');
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new ApiError(413, 'too_large', 'Attachments are limited to 20 MB.');
    const type = /^[a-z0-9.+-]{1,64}\/[a-z0-9.+-]{1,128}$/i.test(req.body.contentType || '') ? req.body.contentType.toLowerCase() : 'application/octet-stream';
    const filename = safeFilename(req.body.filename, type);
    const f = await store.save(bytes);
    try {
      const id = await db.withHq(async (c) => (await c.query(
        'INSERT INTO mail_attachments (storage_key, filename, content_type, size_bytes, sha256, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [f.key, filename, type, f.size, f.sha256, req.principal.userId])).rows[0].id);
      reply.code(201);
      return { id, filename, contentType: type, size: f.size };
    } catch (e) {
      await store.remove(f.key).catch(() => {});
      throw e;
    }
  });

  app.post('/api/hq/mail/messages/:id/forward-attachments', {
    config: hq, schema: { tags: ['hq-mail'], summary: 'Copy a message\'s attachments for a forward', params: idParams },
  }, async (req, reply) => {
    if (!store) throw new ApiError(503, 'mail_storage_unavailable', 'Attachments need MAIL_DIR on the server.');
    const rows = await db.withHq(async (c) => (await c.query('SELECT storage_key, filename, content_type, size_bytes, content_id, is_inline FROM mail_attachments WHERE message_id = $1 ORDER BY created_at', [req.params.id])).rows);
    const out = [];
    for (const a of rows) {
      let bytes;
      try { bytes = await store.read(a.storage_key); } catch { continue; }
      const f = await store.save(bytes);
      const id = await db.withHq(async (c) => (await c.query(
        'INSERT INTO mail_attachments (storage_key, filename, content_type, size_bytes, sha256, content_id, is_inline, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
        [f.key, a.filename, a.content_type, f.size, f.sha256, a.content_id, a.is_inline, req.principal.userId])).rows[0].id);
      out.push({ id, filename: a.filename, contentType: a.content_type, size: f.size, inline: a.is_inline });
    }
    reply.code(201);
    return { data: out };
  });

  // ---- mailboxes and settings (HQ admin) ----------------------------------------------------------
  const mailboxBody = {
    type: 'object', additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 80 }, address: { type: 'string', minLength: 3, maxLength: 254 },
      aliases: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 254 } },
      fromName: { type: ['string', 'null'], maxLength: 80 }, fromAddress: { type: ['string', 'null'], maxLength: 254 },
      signatureHtml: { type: 'string', maxLength: 20000 }, isDefault: { type: 'boolean' },
    },
  };
  const EMAIL = /^[^\s@<>"',;]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
  function mailboxValues(b) {
    const out = {};
    if (b.name !== undefined) out.name = b.name.trim();
    if (b.address !== undefined) { out.address = b.address.trim().toLowerCase(); if (!EMAIL.test(out.address)) throw badRequest('The mailbox address is not valid.'); }
    if (b.aliases !== undefined) {
      out.aliases = [...new Set(b.aliases.map((a) => a.trim().toLowerCase()).filter(Boolean))];
      if (out.aliases.some((a) => !EMAIL.test(a))) throw badRequest('An alias is not a valid address.');
    }
    if (b.fromName !== undefined) out.from_name = b.fromName?.trim() || null;
    if (b.fromAddress !== undefined) { out.from_address = b.fromAddress?.trim().toLowerCase() || null; if (out.from_address && !EMAIL.test(out.from_address)) throw badRequest('The From address is not valid.'); }
    if (b.signatureHtml !== undefined) out.signature_html = sanitizeHtml(b.signatureHtml, { mode: 'compose' }).html;
    if (b.isDefault !== undefined) out.is_default = b.isDefault;
    return out;
  }
  async function saveMailbox(c, id, v) {
    if (v.is_default) await c.query('UPDATE mail_mailboxes SET is_default = false WHERE is_default AND id IS DISTINCT FROM $1', [id]);
    const keys = Object.keys(v);
    try {
      if (id) {
        if (!keys.length) return id;
        await c.query(`UPDATE mail_mailboxes SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [id, ...keys.map((k) => v[k])]);
        return id;
      }
      return (await c.query(`INSERT INTO mail_mailboxes (${keys.join(', ')}) VALUES (${keys.map((k, i) => `$${i + 1}`).join(', ')}) RETURNING id`, keys.map((k) => v[k]))).rows[0].id;
    } catch (e) {
      if (e.code === '23505') throw new ApiError(409, 'conflict', 'Another mailbox already uses that address.');
      throw e;
    }
  }

  app.post('/api/hq/mail/mailboxes', { config: hq, schema: { tags: ['hq-mail'], summary: 'Add a mailbox (HQ admin)', body: { ...mailboxBody, required: ['name', 'address'] } } }, async (req, reply) => {
    requireHqAdmin(req);
    const v = mailboxValues(req.body);
    const id = await db.withHq(async (c) => {
      const newId = await saveMailbox(c, null, v);
      await hqAudit(c, req, null, { action: 'mail.mailbox_create', collection: 'mail_mailboxes', recordId: newId, summary: `Added mailbox ${v.name}` });
      return newId;
    });
    reply.code(201);
    return { id };
  });

  app.put('/api/hq/mail/mailboxes/:id', { config: hq, schema: { tags: ['hq-mail'], summary: 'Change a mailbox: name, addresses, sender, signature (HQ admin)', params: idParams, body: mailboxBody } }, async (req) => {
    requireHqAdmin(req);
    const v = mailboxValues(req.body);
    await db.withHq(async (c) => {
      await mailboxOf(c, req.params.id);
      await saveMailbox(c, req.params.id, v);
      await hqAudit(c, req, null, { action: 'mail.mailbox_update', collection: 'mail_mailboxes', recordId: req.params.id, summary: `Changed mailbox settings (${Object.keys(v).join(', ')})` });
    });
    return { id: req.params.id };
  });

  app.delete('/api/hq/mail/mailboxes/:id', { config: hq, schema: { tags: ['hq-mail'], summary: 'Remove an empty mailbox (HQ admin)', params: idParams } }, async (req, reply) => {
    requireHqAdmin(req);
    await db.withHq(async (c) => {
      const mb = await mailboxOf(c, req.params.id);
      if (mb.is_default) throw new ApiError(409, 'conflict', 'Make another mailbox the default first.');
      if ((await c.query('SELECT 1 FROM mail_messages WHERE mailbox_id = $1 LIMIT 1', [mb.id])).rows.length) throw new ApiError(409, 'conflict', 'The mailbox still has messages. Delete or move them first.');
      await c.query('DELETE FROM mail_mailboxes WHERE id = $1', [mb.id]);
      await hqAudit(c, req, null, { action: 'mail.mailbox_delete', collection: 'mail_mailboxes', recordId: mb.id, summary: `Removed mailbox ${mb.name}` });
    });
    reply.code(204);
  });

  app.put('/api/hq/mail/settings', {
    config: hq,
    schema: { tags: ['hq-mail'], summary: 'Retention and spam settings (HQ admin)',
      body: { type: 'object', additionalProperties: false, properties: {
        retentionDays: { type: 'integer', minimum: 30, maximum: 3650 }, cleanupDays: { type: 'integer', minimum: 1, maximum: 365 }, spamThreshold: { type: 'number', minimum: 0, maximum: 100 } } } },
  }, async (req) => {
    requireHqAdmin(req);
    const b = req.body;
    return db.withHq(async (c) => {
      await c.query(
        `UPDATE mail_settings SET retention_days = COALESCE($1, retention_days), cleanup_days = COALESCE($2, cleanup_days),
                spam_threshold = COALESCE($3, spam_threshold), updated_at = now()`, [b.retentionDays ?? null, b.cleanupDays ?? null, b.spamThreshold ?? null]);
      await hqAudit(c, req, null, { action: 'mail.settings', collection: 'mail_settings', summary: `Mail settings changed (${Object.keys(b).join(', ') || 'nothing'})` });
      const s = (await c.query('SELECT retention_days, cleanup_days, spam_threshold FROM mail_settings')).rows[0];
      return { retentionDays: s.retention_days, cleanupDays: s.cleanup_days, spamThreshold: s.spam_threshold };
    });
  });
}
