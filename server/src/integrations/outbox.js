// Sends queued outbox records (channel email or sms, dueAt <= now) with the company's own
// SendGrid or Resend (email) or Twilio (texts) account, and marks each one sent or failed through the records service
// so the change syncs to every device. Three steps per batch: claim (mark 'sending' and
// commit), call the provider outside any transaction, then record the result.
//
// Resend retries are safe (idempotency key per outbox id). A text, or a SendGrid email, that
// was being sent when a worker died is marked failed rather than resent: Twilio and SendGrid
// have no idempotency key, and a duplicate is worse than asking someone to check.
import { loadTenantPlan, tenantHas } from '../services/entitlements.js';
import { ProviderError, label } from './http.js';
import { EMAIL_RE } from './providers.js';
import { sendEmail } from './resend.js';
import { sendEmail as sendgridEmail } from './sendgrid.js';
import { sendSms, toE164 } from './twilio.js';
import { companySettings } from './payments.js';
import { getSettings, hasRequired, isOptedOut, optOut, providerSecrets, setStatus, systemPrincipal, systemWho } from './state.js';

export const MAX_ATTEMPTS = 5;
const STUCK_MS = 15 * 60 * 1000;
const CHANNEL_PROVIDER = { email: 'resend', sms: 'twilio' };
/** Email goes through SendGrid when the company connected it, otherwise Resend. */
const EMAIL_PROVIDERS = ['sendgrid', 'resend'];
const EMAIL_SENDERS = { sendgrid: sendgridEmail, resend: sendEmail };

const backoffMs = (attempts) => Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** Math.max(0, attempts - 1));

function due(data, now) {
  const at = (v) => (v ? Date.parse(v) : NaN);
  const dueAt = at(data.dueAt);
  const retryAt = at(data.retryAt);
  if (Number.isFinite(dueAt) && dueAt > now.getTime()) return false;
  if (Number.isFinite(retryAt) && retryAt > now.getTime()) return false;
  return true;
}

/** Sequence follow-ups are marketing under CASL; invoices and estimates are transactional. */
const isMarketing = (item) => !item.kind || item.kind === 'sequence';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Plain text to simple HTML: escaped, line breaks kept, https links clickable. */
export function textToHtml(text) {
  const safe = escapeHtml(text).replace(/https:\/\/[^\s<>"']+/g, (u) => `<a href="${u}">${u}</a>`).replace(/\r?\n/g, '<br>\n');
  return `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#1c1b19">${safe}</body></html>`;
}

/** CASL: identify the sender and give a way to unsubscribe in every commercial message. */
export function emailFooter(company) {
  const who = [company?.name, company?.address, company?.phone].filter(Boolean).join(' · ');
  return `\n\n--\n${who || 'Sent on behalf of your contractor'}\nTo stop these emails, reply with "unsubscribe".`;
}

export function smsBody(item) {
  const body = String(item.body || '').trim();
  return isMarketing(item) && !/\bSTOP\b/i.test(body) ? `${body}\nReply STOP to opt out.` : body;
}

class Permanent extends Error {}

function buildEmail(item, secrets, cfg, company, provider = 'resend') {
  const to = String(item.to || '').trim();
  if (!EMAIL_RE.test(to)) throw new Permanent('There is no valid email address on this message.');
  const text = `${String(item.body || '').trim()}${isMarketing(item) ? emailFooter(company) : ''}`;
  return {
    apiKey: secrets[`${provider}.api_key`], from: secrets[`${provider}.from`], to,
    subject: String(item.subject || '').trim() || `Message from ${company?.name || 'your contractor'}`,
    text, html: textToHtml(text),
    replyTo: cfg.replyTo || (company?.email && EMAIL_RE.test(company.email) ? company.email : undefined),
    idempotencyKey: `fishtape-outbox-${item.id}`,
    tags: [{ name: 'source', value: 'fishtape' }, { name: 'kind', value: String(item.kind || 'sequence').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'sequence' }],
  };
}

/**
 * Send what is due for one company. `outboxId` limits it to one record (send-now jobs).
 * @returns {Promise<{ sent: number, failed: number, retrying: number }>}
 */
export async function dispatchTenant({ db, records, sealer, tenantId, outboxId = null, now = new Date(), limit = 25 }) {
  const result = { sent: 0, failed: 0, retrying: 0 };
  const plan = await loadTenantPlan(db, tenantId);
  if (!plan) return result;
  const allowed = { email: tenantHas(plan, 'integrations.email', now), sms: tenantHas(plan, 'integrations.sms', now) };
  if (!allowed.email && !allowed.sms) return result;
  const p = systemPrincipal(tenantId, 'outbox-sender', 'Outbox sender');
  const who = systemWho(p);

  // 1. claim
  const batch = await db.withTenant({ tenantId }, async (tx) => {
    const secrets = {};
    const channels = [];
    let emailProvider = null;
    if (allowed.email) {
      for (const prov of EMAIL_PROVIDERS) {
        secrets[prov] = await providerSecrets(tx, sealer, prov);
        if (hasRequired(prov, secrets[prov])) { emailProvider = prov; break; }
      }
      if (emailProvider) channels.push('email');
    }
    if (allowed.sms) {
      secrets.twilio = await providerSecrets(tx, sealer, 'twilio');
      if (hasRequired('twilio', secrets.twilio)) channels.push('sms');
    }
    if (!channels.length) return null;
    const params = [tx.tenantId, channels];
    if (outboxId) params.push(outboxId);
    const { rows } = await tx.query(
      `SELECT id, data FROM outbox WHERE tenant_id = $1 AND status = 'queued' AND deleted_at IS NULL AND data->>'channel' = ANY($2)
       ${outboxId ? 'AND id = $3' : ''} ORDER BY created_at LIMIT 200 FOR UPDATE SKIP LOCKED`, params);
    const picked = rows.filter((r) => due(r.data, now)).slice(0, limit);
    if (!picked.length) return null;
    const settings = await companySettings(tx);
    const emailCfg = emailProvider ? (await getSettings(tx, emailProvider)).config || {} : {};
    const items = [];
    for (const r of picked) {
      const attempts = (Number(r.data.attempts) || 0) + 1;
      let problem = null;
      if (r.data.channel === 'sms') {
        const to = toE164(r.data.to);
        if (!to) problem = 'The phone number is not a valid Canadian or US number.';
        else if (await isOptedOut(tx, to)) problem = 'This person replied STOP, so they get no more texts. They can reply START to opt back in.';
      }
      // A record the records service refuses (e.g. old data that no longer validates) is skipped, not fatal.
      const patch = (fields) => tx.savepoint(() => records.patchRecord(tx, p, 'outbox', r.id, fields, {}, who)).catch(() => null);
      if (problem) {
        if (await patch({ status: 'failed', error: problem, failedAt: now.toISOString(), attempts })) result.failed++;
        continue;
      }
      const rec = await patch({ status: 'sending', sendingAt: now.toISOString(), attempts, error: null, provider: r.data.channel === 'email' ? emailProvider : 'twilio' });
      if (rec) items.push(rec);
    }
    return { items, secrets, company: settings.company || {}, emailCfg, emailProvider };
  }, { write: true });
  if (!batch) return result;

  // 2. send, 3. record
  const statusFixed = new Set();
  for (const item of batch.items) {
    const provider = item.channel === 'email' ? batch.emailProvider : CHANNEL_PROVIDER[item.channel];
    let patch;
    let providerProblem = null;
    let optedOut = null;
    try {
      if (item.channel === 'email') {
        const sent = await EMAIL_SENDERS[provider](buildEmail(item, batch.secrets[provider], batch.emailCfg, batch.company, provider));
        patch = { status: 'sent', sentAt: new Date().toISOString(), provider, providerMessageId: sent.id, error: null, retryAt: null, sendingAt: null };
      } else {
        const s = batch.secrets.twilio;
        const sent = await sendSms({ accountSid: s['twilio.account_sid'], authToken: s['twilio.auth_token'], from: toE164(s['twilio.from']) || s['twilio.from'], to: toE164(item.to), body: smsBody(item) });
        patch = { status: 'sent', sentAt: new Date().toISOString(), provider, providerMessageId: sent.sid, error: null, retryAt: null, sendingAt: null };
      }
      result.sent++;
    } catch (e) {
      const message = e instanceof ProviderError || e instanceof Permanent ? e.message : `${label(provider)} could not be reached. We will try again.`;
      const retry = !(e instanceof Permanent) && (!(e instanceof ProviderError) || e.retry) && item.attempts < MAX_ATTEMPTS;
      if (e instanceof ProviderError && e.kind === 'auth') providerProblem = e.message;
      if (e instanceof ProviderError && e.kind === 'optout') optedOut = toE164(item.to);
      patch = retry
        ? { status: 'queued', retryAt: new Date(now.getTime() + backoffMs(item.attempts)).toISOString(), error: message, sendingAt: null }
        : { status: 'failed', failedAt: new Date().toISOString(), error: message, sendingAt: null };
      if (retry) result.retrying++; else result.failed++;
    }
    await db.withTenant({ tenantId }, async (tx) => {
      await records.patchRecord(tx, p, 'outbox', item.id, patch, {}, who);
      if (optedOut) await optOut(tx, optedOut, 'provider');
      if (providerProblem) await setStatus(tx, provider, 'error', providerProblem);
      else if (patch.status === 'sent' && !statusFixed.has(provider)) {
        statusFixed.add(provider);
        const cur = await getSettings(tx, provider);
        if (cur.status === 'error') await setStatus(tx, provider, 'ok', 'Sending works again.');
      }
    }, { write: true });
  }
  return result;
}

/** Outbox rows left in 'sending' by a worker that died: Resend email goes back to the queue; a text or SendGrid email is marked failed. */
export async function recoverStuck({ db, records, tenantId, now = new Date() }) {
  const p = systemPrincipal(tenantId, 'outbox-sender', 'Outbox sender');
  const who = systemWho(p);
  return db.withTenant({ tenantId }, async (tx) => {
    const { rows } = await tx.query("SELECT id, data FROM outbox WHERE tenant_id = $1 AND status = 'sending' AND deleted_at IS NULL FOR UPDATE SKIP LOCKED", [tx.tenantId]);
    let n = 0;
    for (const r of rows) {
      const since = Date.parse(r.data.sendingAt);
      if (Number.isFinite(since) && now.getTime() - since < STUCK_MS) continue;
      const patch = r.data.channel === 'email' && r.data.provider !== 'sendgrid'
        ? { status: 'queued', sendingAt: null }
        : { status: 'failed', sendingAt: null, failedAt: now.toISOString(), error: r.data.channel === 'email'
          ? 'Sending was interrupted. Check SendGrid > Activity before sending it again.'
          : 'Sending was interrupted. Check your Twilio message log before sending it again.' };
      await records.patchRecord(tx, p, 'outbox', r.id, patch, {}, who);
      n++;
    }
    return n;
  }, { write: true });
}
