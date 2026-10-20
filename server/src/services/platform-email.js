// Fishtape's own email (password resets, invites, HQ alerts, support confirmations and the mail
// HQ staff send from HQ Mail) drains from email_outbox through Fishtape's own provider account:
//   EMAIL_PROVIDER=sendgrid|resend (default sendgrid when SENDGRID_API_KEY is set),
//   SENDGRID_API_KEY or RESEND_API_KEY, and EMAIL_FROM.
// Company email never comes through here; it goes out with each company's own key
// (integrations/outbox.js). Without a key and EMAIL_FROM the queue just waits.
//
// Each message is sent at most once by one worker: claim (row lock, status 'sending',
// commit), send outside any transaction, then record the result. SendGrid has no
// idempotency key, so a row left in 'sending' by a worker that died is only re-queued when no
// SendGrid event shows it went out; Resend gets the row id as its idempotency key.
import { enqueue } from './queue.js';
import { sendEmail as resendSend } from '../integrations/resend.js';
import { sendMail as sendgridSend } from '../integrations/sendgrid.js';
import { mailSettings } from '../email/config.js';
import { createMailStore } from '../email/storage.js';

const BATCH = 20;
export const MAX_ATTEMPTS = 6;
const STUCK_MINUTES = 15;
const minuteKey = (d) => d.toISOString().slice(0, 16);

export function platformEmailConfig(env = process.env) {
  const s = mailSettings({}, env);
  return {
    provider: s.provider,
    apiKey: s.provider === 'sendgrid' ? s.sendgridApiKey : s.resendApiKey,
    from: s.from,
    trackOpens: s.trackOpens,
    appEnv: s.appEnv,
    store: createMailStore(s),
  };
}

/** The provider call for one claimed row. Attachments are read from MAIL_DIR here. */
async function providerSend(m, cfg) {
  const to = m.to_addresses?.length ? m.to_addresses : [m.to_address];
  const from = m.from_address || cfg.from;
  if (cfg.provider === 'sendgrid') {
    const attachments = [];
    for (const a of Array.isArray(m.attachments) ? m.attachments : []) {
      if (!cfg.store) throw Object.assign(new Error('MAIL_DIR is not set, so attachments cannot be read.'), { retry: true });
      attachments.push({ content: (await cfg.store.read(a.key)).toString('base64'), filename: a.filename, type: a.contentType, disposition: a.inline ? 'inline' : 'attachment', contentId: a.contentId });
    }
    return sendgridSend({
      apiKey: cfg.apiKey, from, to, cc: m.cc_addresses || [], bcc: m.bcc_addresses || [], replyTo: m.reply_to || undefined,
      subject: m.subject, text: m.text_body, html: m.html_body || undefined, headers: m.headers || undefined, attachments,
      categories: ['fishtape', m.mail_message_id ? 'hq-mail' : (m.template || 'system')],
      customArgs: { ft_outbox_id: m.id, ft_env: cfg.appEnv || '' },
      trackOpens: cfg.trackOpens,
    });
  }
  return resendSend({ apiKey: cfg.apiKey, from, to: to[0], subject: m.subject, text: m.text_body, html: m.html_body || undefined, replyTo: m.reply_to || undefined, idempotencyKey: `platform-email:${m.id}` });
}

/** Rows a dead worker left in 'sending': sent if SendGrid reported them, otherwise queued again. */
export async function recoverStuckEmail(db) {
  const { rowCount } = await db.query(
    `UPDATE email_outbox SET sending_at = NULL,
            status = CASE WHEN delivery_status IN ('bounce', 'blocked', 'dropped') THEN 'failed'
                          WHEN delivery_status IS NOT NULL THEN 'sent' ELSE 'queued' END,
            sent_at = CASE WHEN delivery_status IS NOT NULL AND delivery_status NOT IN ('bounce', 'blocked', 'dropped') THEN COALESCE(sent_at, now()) ELSE sent_at END
      WHERE status = 'sending' AND sending_at < now() - make_interval(mins => $1)`, [STUCK_MINUTES]);
  return rowCount;
}

/**
 * Send up to BATCH queued messages.
 * @param {{ tx: Function, query: Function }} db
 * @param {{ send?: Function, cfg?: ReturnType<typeof platformEmailConfig> }} [o] tests pass their own
 */
export async function drainPlatformEmail(db, { send, cfg = platformEmailConfig() } = {}) {
  if (!cfg.apiKey || !cfg.from) return { skipped: 'not_configured' };
  const doSend = send || ((m) => providerSend(m, cfg));
  const out = { sent: 0, failed: 0, retrying: 0 };
  await recoverStuckEmail(db);
  for (let i = 0; i < BATCH; i++) {
    // 1. claim
    const m = await db.tx(async (client) => {
      const { rows } = await client.query(
        `SELECT id, to_address, to_addresses, cc_addresses, bcc_addresses, from_address, reply_to, subject, text_body, html_body,
                headers, attachments, template, mail_message_id, attempts
           FROM email_outbox WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`);
      const row = rows[0];
      if (!row) return null;
      await client.query("UPDATE email_outbox SET status = 'sending', sending_at = now(), attempts = attempts + 1, provider = $2 WHERE id = $1",
        [row.id, cfg.provider === 'resend' ? 'resend' : cfg.provider === 'sendgrid' ? 'sendgrid' : null]);
      return { ...row, attempts: row.attempts + 1 };
    });
    if (!m) break;
    // 2. send, 3. record
    try {
      const sent = await doSend({ ...m, apiKey: cfg.apiKey, from: m.from_address || cfg.from, to: m.to_address, text: m.text_body, html: m.html_body || undefined, idempotencyKey: `platform-email:${m.id}` });
      // An event may already have reported a bounce while we waited for the API's answer.
      await db.query(
        `UPDATE email_outbox SET status = CASE WHEN delivery_status IN ('bounce', 'blocked', 'dropped') THEN 'failed' ELSE 'sent' END,
                sent_at = now(), sending_at = NULL, provider_message_id = NULLIF($2, ''), last_error = CASE WHEN delivery_status IN ('bounce', 'blocked', 'dropped') THEN last_error END
          WHERE id = $1`, [m.id, String(sent?.id || '')]);
      out.sent++;
    } catch (e) {
      const giveUp = !e?.retry || m.attempts >= MAX_ATTEMPTS;
      // Provider messages are scrubbed (integrations/http.js); never store the address or body.
      await db.query('UPDATE email_outbox SET status = $2, sending_at = NULL, last_error = $3 WHERE id = $1',
        [m.id, giveUp ? 'failed' : 'queued', String(e?.message || 'send failed').slice(0, 300)]);
      if (giveUp) out.failed++; else out.retrying++;
      if (!giveUp) break; // leave retries for the next run instead of spinning on them now
    }
  }
  return out;
}

export function createPlatformEmailHandlers(deps = {}) {
  return {
    async platform_email({ db, job }) {
      const at = deps.now ? deps.now() : new Date();
      try {
        return await drainPlatformEmail(db, deps);
      } finally {
        if (!job?.payload?.once) {
          const next = new Date(at.getTime() + 60_000);
          await enqueue(db, { kind: 'platform_email', runAt: next, dedupeKey: `platform_email:${minuteKey(next)}`, maxAttempts: 1 });
        }
      }
    },
  };
}

export const PLATFORM_EMAIL_HANDLERS = createPlatformEmailHandlers();

/** Start the minute-by-minute chain (idempotent). */
export function schedulePlatformEmail(db, at = new Date()) {
  return enqueue(db, { kind: 'platform_email', dedupeKey: `platform_email:${minuteKey(at)}`, maxAttempts: 1 });
}

/** Ask the worker to drain now (HQ Mail "Send", support confirmations). Deduplicated. */
export function nudgePlatformEmail(q) {
  return enqueue(q, { kind: 'platform_email', payload: { once: true }, dedupeKey: 'platform_email:now', maxAttempts: 1 });
}
