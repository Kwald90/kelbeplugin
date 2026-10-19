// Fishtape's own email (password resets, invites, HQ lead alerts) drains from email_outbox
// through Fishtape's Resend account: env RESEND_API_KEY and EMAIL_FROM. Company email never
// comes through here; it goes out with each company's own key (integrations/outbox.js).
// Without the env vars the queue just waits, so staging can run before email is set up.
import { enqueue } from './queue.js';
import { sendEmail } from '../integrations/resend.js';

const BATCH = 20;
export const MAX_ATTEMPTS = 6;
const minuteKey = (d) => d.toISOString().slice(0, 16);

export function platformEmailConfig(env = process.env) {
  return { apiKey: env.RESEND_API_KEY || '', from: env.EMAIL_FROM || '' };
}

/**
 * Send up to BATCH queued messages. Each one is sent while its row is locked, with the row id
 * as Resend's idempotency key, so two workers never send it twice and a retry is safe.
 * @param {{ tx: Function }} db
 */
export async function drainPlatformEmail(db, { send = sendEmail, cfg = platformEmailConfig() } = {}) {
  if (!cfg.apiKey || !cfg.from) return { skipped: 'not_configured' };
  const out = { sent: 0, failed: 0, retrying: 0 };
  for (let i = 0; i < BATCH; i++) {
    const done = await db.tx(async (client) => {
      const { rows } = await client.query(
        `SELECT id, to_address, subject, text_body, html_body, attempts FROM email_outbox
         WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`);
      const m = rows[0];
      if (!m) return false;
      try {
        await send({ apiKey: cfg.apiKey, from: cfg.from, to: m.to_address, subject: m.subject, text: m.text_body, html: m.html_body || undefined, idempotencyKey: `platform-email:${m.id}` });
        await client.query("UPDATE email_outbox SET status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1", [m.id]);
        out.sent++;
      } catch (e) {
        const attempts = m.attempts + 1;
        const giveUp = !e?.retry || attempts >= MAX_ATTEMPTS;
        // Provider messages are scrubbed (integrations/http.js); never store the address or body.
        await client.query('UPDATE email_outbox SET status = $2, attempts = $3, last_error = $4 WHERE id = $1',
          [m.id, giveUp ? 'failed' : 'queued', attempts, String(e?.message || 'send failed').slice(0, 300)]);
        if (giveUp) out.failed++; else out.retrying++;
        if (!giveUp) return false; // leave retries for the next run instead of spinning on them now
      }
      return true;
    });
    if (!done) break;
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
