// The HQ inbox, as seen from hq-api (fishtape_hq). syncMail() runs at the start of HQ Mail
// requests (at most one at a time, across processes):
//   1. files new mail from the mail_inbound drop box into mailboxes, threads and messages,
//   2. copies send and delivery state from email_outbox onto HQ's sent messages,
//   3. once an hour, applies retention: Junk and Trash after `cleanup_days`, everything else
//      (except flagged mail) after `retention_days`, orphan uploads after a day, delivery
//      events after 180 days. Files are deleted after the transaction commits.
import { htmlToText } from './sanitize.js';
import { previewOf, subjectKey } from './mime.js';

const MAX_FILE_ATTEMPTS = 5;
const lower = (s) => String(s || '').trim().toLowerCase();

/** The mailbox for a message: envelope recipients first, then To/Cc; else the default one. */
export async function resolveMailbox(c, candidates) {
  const list = [...new Set(candidates.map(lower).filter(Boolean))].slice(0, 200);
  const { rows } = await c.query('SELECT id, address, aliases, is_default FROM mail_mailboxes ORDER BY sort, name');
  for (const addr of list) {
    const hit = rows.find((m) => m.address === addr || (m.aliases || []).map(lower).includes(addr));
    if (hit) return hit;
  }
  return rows.find((m) => m.is_default) || rows[0] || null;
}

/** The support mailbox: the one whose address starts with support@, else the default. */
export async function supportMailbox(c) {
  const { rows } = await c.query("SELECT id, address, name, from_name, from_address FROM mail_mailboxes ORDER BY (address LIKE 'support@%') DESC, is_default DESC, sort LIMIT 1");
  return rows[0] || null;
}

/**
 * The conversation a message belongs to: a known Message-ID in In-Reply-To/References, else
 * a recent thread in the same mailbox with the same subject and a shared participant.
 */
export async function findThread(c, mailboxId, { inReplyTo, references = [], subject, participants = [] }) {
  const refs = [...new Set([inReplyTo, ...references].filter(Boolean))].slice(-100);
  if (refs.length) {
    const { rows } = await c.query(
      'SELECT thread_id FROM mail_messages WHERE mailbox_id = $1 AND message_id = ANY($2) ORDER BY received_at DESC LIMIT 1', [mailboxId, refs]);
    if (rows[0]) return rows[0].thread_id;
  }
  const key = subjectKey(subject);
  // Our own addresses are in every conversation, so they don't count as a shared participant.
  const own = new Set((await c.query('SELECT address, aliases, from_address FROM mail_mailboxes')).rows
    .flatMap((m) => [m.address, m.from_address, ...(m.aliases || [])]).filter(Boolean).map(lower));
  const people = [...new Set(participants.map(lower).filter((a) => a && !own.has(a)))].slice(0, 100);
  if (!key || !people.length) return null;
  const { rows } = await c.query(
    `SELECT t.id FROM mail_threads t
      WHERE t.mailbox_id = $1 AND t.subject_key = $2 AND t.last_message_at > now() - interval '30 days'
        AND EXISTS (SELECT 1 FROM mail_messages m WHERE m.thread_id = t.id AND (lower(m.from_address) = ANY($3)
              OR EXISTS (SELECT 1 FROM jsonb_array_elements(m.to_list) e WHERE lower(e->>'address') = ANY($3))))
      ORDER BY t.last_message_at DESC LIMIT 1`, [mailboxId, key, people]);
  return rows[0]?.id || null;
}

export async function newThread(c, mailboxId, subject, at = new Date()) {
  const { rows } = await c.query(
    'INSERT INTO mail_threads (mailbox_id, subject, subject_key, last_message_at) VALUES ($1, $2, $3, $4) RETURNING id',
    [mailboxId, String(subject || '').slice(0, 1000), subjectKey(subject), at]);
  return rows[0].id;
}

export function touchThread(c, threadId, at = new Date()) {
  return c.query('UPDATE mail_threads SET last_message_at = GREATEST(last_message_at, $2) WHERE id = $1', [threadId, at]);
}

/** File one drop-box row. Returns the new message id, or null for a duplicate delivery. */
export async function fileInbound(c, row, { spamThreshold = 5 } = {}) {
  const p = row.payload || {};
  const m = p.message || {};
  const support = row.source === 'support';
  const mailbox = support ? await supportMailbox(c) : await resolveMailbox(c, [
    ...(Array.isArray(p.envelope?.to) ? p.envelope.to : []), ...(m.to || []).map((a) => a.address), ...(m.cc || []).map((a) => a.address)]);
  if (!mailbox) throw new Error('no mailbox to file into');
  if (m.messageId) {
    const dup = await c.query('SELECT 1 FROM mail_messages WHERE mailbox_id = $1 AND message_id = $2 LIMIT 1', [mailbox.id, m.messageId]);
    if (dup.rows.length) return null;
  }
  const receivedAt = row.received_at ? new Date(row.received_at) : new Date();
  const participants = [m.from?.address, ...(m.to || []).map((a) => a.address), ...(m.cc || []).map((a) => a.address)];
  const threadId = (await findThread(c, mailbox.id, { inReplyTo: m.inReplyTo, references: m.references || [], subject: m.subject, participants }))
    || await newThread(c, mailbox.id, m.subject, receivedAt);
  await touchThread(c, threadId, receivedAt);
  const spamScore = Number.isFinite(Number(p.spamScore)) && p.spamScore !== null && p.spamScore !== '' ? Number(p.spamScore) : null;
  const isSpam = spamScore != null && spamScore >= spamThreshold;
  const text = m.text || (m.html ? htmlToText(m.html) : '');
  const attachments = Array.isArray(p.attachments) ? p.attachments : [];
  const { rows } = await c.query(
    `INSERT INTO mail_messages (mailbox_id, thread_id, direction, folder, source, message_id, in_reply_to, refs, from_name, from_address,
        to_list, cc_list, reply_to_list, subject, text_body, html_body, preview, has_attachments, size_bytes, spam_score, is_spam,
        auth_results, meta, raw_key, sent_at, received_at)
     VALUES ($1, $2, 'in', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
     RETURNING id`,
    [mailbox.id, threadId, isSpam ? 'junk' : 'inbox', support ? 'support' : 'parse', m.messageId || null, m.inReplyTo || null,
      (m.references || []).slice(-100), m.from?.name || null, m.from?.address || null, JSON.stringify(m.to || []), JSON.stringify(m.cc || []),
      JSON.stringify(m.replyTo || []), String(m.subject || '').slice(0, 1000), text, m.html || null, previewOf(text),
      attachments.some((a) => !a.inline), Number(p.size) || 0, spamScore, isSpam,
      p.auth ? JSON.stringify(p.auth) : null, p.meta ? JSON.stringify(p.meta) : null, p.rawKey || null, m.date || null, receivedAt]);
  const id = rows[0].id;
  for (const a of attachments) {
    await c.query(
      `INSERT INTO mail_attachments (message_id, storage_key, filename, content_type, size_bytes, sha256, content_id, is_inline)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, a.key, a.filename, a.contentType, a.size, a.sha256 || null, a.contentId || null, Boolean(a.inline)]);
  }
  return id;
}

/** Storage keys a drop-box payload refers to (to delete them when the row is abandoned). */
const payloadKeys = (p) => [p?.rawKey, ...(Array.isArray(p?.attachments) ? p.attachments.map((a) => a.key) : [])].filter(Boolean);

async function cleanup(c, store, now) {
  const s = (await c.query('SELECT retention_days, cleanup_days, last_cleanup_at FROM mail_settings')).rows[0];
  if (!s || (s.last_cleanup_at && now - new Date(s.last_cleanup_at) < 3_600_000)) return null;
  await c.query('UPDATE mail_settings SET last_cleanup_at = $1', [now]);
  const keys = [];
  const doomed = await c.query(
    `SELECT id, raw_key FROM mail_messages
      WHERE (folder IN ('junk', 'trash') AND updated_at < $1::timestamptz - make_interval(days => $2))
         OR (NOT is_flagged AND folder <> 'drafts' AND received_at < $1::timestamptz - make_interval(days => $3))`,
    [now, s.cleanup_days, s.retention_days]);
  const ids = doomed.rows.map((r) => r.id);
  keys.push(...doomed.rows.map((r) => r.raw_key).filter(Boolean));
  if (ids.length) {
    keys.push(...(await c.query('SELECT storage_key FROM mail_attachments WHERE message_id = ANY($1)', [ids])).rows.map((r) => r.storage_key));
    await c.query('DELETE FROM mail_messages WHERE id = ANY($1)', [ids]);
  }
  const orphans = await c.query("DELETE FROM mail_attachments WHERE message_id IS NULL AND created_at < $1::timestamptz - interval '1 day' RETURNING storage_key", [now]);
  keys.push(...orphans.rows.map((r) => r.storage_key));
  await c.query('DELETE FROM mail_threads t WHERE NOT EXISTS (SELECT 1 FROM mail_messages m WHERE m.thread_id = t.id)');
  const events = await c.query("DELETE FROM email_events WHERE received_at < $1::timestamptz - interval '180 days'", [now]);
  const stale = await c.query(`DELETE FROM mail_inbound WHERE attempts >= ${MAX_FILE_ATTEMPTS} AND received_at < $1::timestamptz - interval '30 days' RETURNING payload`, [now]);
  for (const r of stale.rows) keys.push(...payloadKeys(r.payload));
  // Files nobody refers to (a request that failed after saving its files), older than a day.
  if (store) {
    const known = new Set([
      ...(await c.query('SELECT storage_key AS k FROM mail_attachments UNION ALL SELECT raw_key FROM mail_messages WHERE raw_key IS NOT NULL')).rows.map((r) => r.k),
      ...(await c.query('SELECT payload FROM mail_inbound')).rows.flatMap((r) => payloadKeys(r.payload)),
    ]);
    for (const f of await store.list()) if (!known.has(f.key) && now - f.mtimeMs > 86_400_000) keys.push(f.key);
  }
  return { messages: ids.length, uploads: orphans.rowCount, events: events.rowCount, keys };
}

/**
 * @param {import('../db.js').Db} db
 * @param {{ store?: ReturnType<typeof import('./storage.js').createMailStore>, now?: Date }} [o]
 */
export async function syncMail(db, { store = null, now = new Date() } = {}) {
  const result = await db.withHq(async (c) => {
    const lock = await c.query("SELECT pg_try_advisory_xact_lock(hashtext('fishtape:mail-sync')) AS ok");
    if (!lock.rows[0].ok) return { busy: true };
    const r = { filed: 0, duplicates: 0, failed: 0, updated: 0, cleaned: null };
    const settings = (await c.query('SELECT spam_threshold FROM mail_settings')).rows[0] || { spam_threshold: 5 };
    const { rows } = await c.query(`SELECT id, source, payload, received_at FROM mail_inbound WHERE attempts < ${MAX_FILE_ATTEMPTS} ORDER BY id LIMIT 100`);
    for (const row of rows) {
      await c.query('SAVEPOINT file_one');
      try {
        const id = await fileInbound(c, row, { spamThreshold: settings.spam_threshold });
        await c.query('DELETE FROM mail_inbound WHERE id = $1', [row.id]);
        await c.query('RELEASE SAVEPOINT file_one');
        if (id) r.filed++; else r.duplicates++;
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT file_one');
        // The error text comes from our own code or Postgres (no message content).
        await c.query('UPDATE mail_inbound SET attempts = attempts + 1, last_error = $2 WHERE id = $1', [row.id, String(e?.message || 'filing failed').slice(0, 300)]);
        r.failed++;
      }
    }
    const up = await c.query(
      `UPDATE mail_messages m
          SET send_status = o.status, delivery_status = o.delivery_status,
              delivery_detail = CASE WHEN o.status = 'failed' THEN COALESCE(o.last_error, o.delivery_detail) ELSE o.delivery_detail END,
              sent_at = COALESCE(o.sent_at, m.sent_at), updated_at = now()
         FROM email_outbox o
        WHERE m.outbox_id = o.id AND (m.send_status IS DISTINCT FROM o.status OR m.delivery_status IS DISTINCT FROM o.delivery_status
              OR m.delivery_detail IS DISTINCT FROM (CASE WHEN o.status = 'failed' THEN COALESCE(o.last_error, o.delivery_detail) ELSE o.delivery_detail END))`);
    r.updated = up.rowCount;
    r.cleaned = await cleanup(c, store, now);
    return r;
  });
  if (store && result.cleaned?.keys?.length) {
    for (const k of result.cleaned.keys) await store.remove(k).catch(() => {});
  }
  if (result.cleaned) result.cleaned = { messages: result.cleaned.messages, uploads: result.cleaned.uploads, events: result.cleaned.events, files: result.cleaned.keys.length };
  return result;
}
