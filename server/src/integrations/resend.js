// Resend with the company's own key and sender. Error names from
// https://resend.com/docs/api-reference/errors (checked 2026-10-19).
import { ProviderError, httpFailure, request, scrub } from './http.js';
import { senderAddress } from './providers.js';

const API = 'https://api.resend.com';

function failure(r) {
  const name = r.json?.name || '';
  const msg = r.json?.message;
  if (name === 'restricted_api_key' && r.status === 403) return new ProviderError('resend', 'This Resend API key is not active. Create a new one.', { status: r.status, code: name, kind: 'auth' });
  if (name === 'missing_api_key' || name === 'suspended_api_key' || (name === 'validation_error' && /api key/i.test(msg || ''))) {
    return new ProviderError('resend', 'Resend refused the key. Check it in Resend > API Keys.', { status: r.status, code: name, kind: 'auth' });
  }
  if (name === 'daily_quota_exceeded' || name === 'monthly_quota_exceeded' || name === 'email_above_quota') {
    return new ProviderError('resend', 'Your Resend sending quota is used up. Sending resumes when it resets, or upgrade your Resend plan.', { status: r.status, code: name, retry: true, kind: 'quota' });
  }
  if (name === 'rate_limit_exceeded') return new ProviderError('resend', 'Resend is rate limiting. We will try again shortly.', { status: r.status, code: name, retry: true, kind: 'quota' });
  if (name === 'validation_error' && /domain/i.test(msg || '')) {
    return new ProviderError('resend', 'Resend will not send from this address: the domain is not verified in Resend yet.', { status: r.status, code: name, kind: 'invalid' });
  }
  return httpFailure('resend', r.status, msg, name || null);
}

/**
 * Send one email. The idempotency key makes a retry within 24 hours safe (Resend keeps keys 24 h).
 * @returns {Promise<{ id: string }>}
 */
export async function sendEmail({ apiKey, from, to, subject, text, html, replyTo, idempotencyKey, tags }) {
  const r = await request('resend', `${API}/emails`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      ...(idempotencyKey ? { 'idempotency-key': String(idempotencyKey).slice(0, 256) } : {}),
    },
    body: JSON.stringify({ from, to: [to], subject, text, ...(html ? { html } : {}), ...(replyTo ? { reply_to: replyTo } : {}), ...(tags ? { tags } : {}) }),
  });
  if (!r.ok) throw failure(r);
  return { id: String(r.json?.id || '') };
}

/**
 * GET /domains (read-only). A sending-only key answers 401 restricted_api_key, which still
 * proves the key is real: we report that and skip the domain check.
 */
export async function testResend({ apiKey, from }) {
  const r = await request('resend', `${API}/domains`, { headers: { authorization: `Bearer ${apiKey}` } });
  const addr = senderAddress(from);
  const domain = addr ? addr.split('@')[1].toLowerCase() : null;
  if (r.status === 401 && r.json?.name === 'restricted_api_key') {
    return { status: 'ok', message: `Key works (sending only), so we could not check that ${domain || 'your domain'} is verified. Send yourself a test to be sure.` };
  }
  if (!r.ok) throw failure(r);
  const list = Array.isArray(r.json?.data) ? r.json.data : [];
  const match = domain && list.find((d) => String(d.name).toLowerCase() === domain);
  if (!match) return { status: 'warning', message: `Key works, but ${domain || 'the sender domain'} is not in this Resend account. Add and verify it in Resend > Domains.` };
  if (match.status !== 'verified') return { status: 'warning', message: `Key works, but ${domain} is ${scrub(match.status, 40) || 'not verified'} in Resend. Finish the DNS records.` };
  return { status: 'ok', message: `Connected. ${domain} is verified.` };
}
