// Facebook Lead Ads with the company's own Meta app and Page token: webhook signature
// checks (X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, raw body)), fetching
// a lead from the Graph API, mapping it to a leads record, and a connection test.
import { createHmac } from 'node:crypto';
import { safeEqual } from '../lib/crypto.js';
import { ProviderError, formEncode, httpFailure, request } from './http.js';

// Latest Graph API version on 2026-10-19 was v26.0 (released 2026-07-29).
export const GRAPH_VERSION = 'v26.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

export function verifyFacebook(rawBody, header, appSecret) {
  if (!rawBody || !appSecret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(Buffer.from(rawBody, 'utf8')).digest('hex');
  return safeEqual(`sha256=${expected}`, header.trim().toLowerCase());
}

/** appsecret_proof: proves the call comes from the app's own server (HMAC-SHA256 of the token). */
const proof = (token, secret) => createHmac('sha256', secret).update(token).digest('hex');

function failure(r) {
  const e = r.json?.error || {};
  const code = e.code ?? null;
  if (code === 190 || r.status === 401) return new ProviderError('facebook', 'The Page access token has expired or was revoked. Create a new long-lived token.', { status: r.status, code, kind: 'auth' });
  if (code === 10 || code === 200 || (code >= 200 && code < 300) || r.status === 403) {
    return new ProviderError('facebook', 'The token is missing a permission (leads_retrieval, pages_manage_metadata, pages_show_list, pages_read_engagement or ads_management).', { status: r.status, code, kind: 'auth' });
  }
  if ([4, 17, 32, 613].includes(code)) return new ProviderError('facebook', 'Facebook is rate limiting. We will try again shortly.', { status: r.status, code, retry: true, kind: 'quota' });
  return httpFailure('facebook', r.status, e.message, code);
}

const graph = (path, token, secret, opts = {}) => {
  const sep = path.includes('?') ? '&' : '?';
  return request('facebook', `${GRAPH}/${path}${sep}appsecret_proof=${proof(token, secret)}`, {
    method: opts.method || 'GET',
    headers: { authorization: `Bearer ${token}`, ...(opts.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: opts.body,
  });
};

/** GET /{leadgen_id}: { id, created_time, ad_id, form_id, field_data: [{ name, values }] } */
export async function fetchLead({ leadgenId, pageToken, appSecret }) {
  if (!/^\d{1,40}$/.test(String(leadgenId))) throw new ProviderError('facebook', 'Facebook sent a lead id we do not recognise.', { kind: 'invalid' });
  const r = await graph(`${leadgenId}?fields=id,created_time,ad_id,form_id,field_data`, pageToken, appSecret);
  if (!r.ok) throw failure(r);
  return r.json || {};
}

const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const STANDARD = new Set(['full_name', 'first_name', 'last_name', 'email', 'phone_number', 'phone']);

/** Facebook's field_data -> the fields of a leads record (source 'facebook'). */
export function mapLead(fb) {
  const answers = [];
  const f = {};
  for (const item of Array.isArray(fb.field_data) ? fb.field_data : []) {
    const name = clip(item?.name, 100);
    const value = (Array.isArray(item?.values) ? item.values : []).map((v) => clip(v, 1000)).filter(Boolean).join(', ');
    if (!name || !value) continue;
    f[name] = value;
    if (!STANDARD.has(name)) answers.push({ name, value });
  }
  const contactName = clip(f.full_name || [f.first_name, f.last_name].filter(Boolean).join(' '), 200);
  const firstAnswer = answers[0]?.value;
  const pretty = (n) => n.replace(/_/g, ' ').replace(/\?$/, '').replace(/^./, (c) => c.toUpperCase());
  return {
    title: clip(firstAnswer ? firstAnswer : `Facebook lead${contactName ? `: ${contactName}` : ''}`, 300),
    contactName: contactName || null,
    email: f.email ? clip(f.email, 254) : null,
    phone: clip(f.phone_number || f.phone, 40) || null,
    notes: clip([
      'From a Facebook lead form.',
      ...answers.map((a) => `${pretty(a.name)}: ${a.value}`),
    ].join('\n'), 20000),
    facebook: { leadId: clip(fb.id, 40), formId: clip(fb.form_id, 40) || null, adId: clip(fb.ad_id, 40) || null, createdTime: clip(fb.created_time, 40) || null },
  };
}

/** GET /me with the Page token, then check the Page has the app subscribed to leadgen. */
export async function testFacebook({ pageToken, appSecret, pageId }) {
  const me = await graph('me?fields=id,name', pageToken, appSecret);
  if (!me.ok) throw failure(me);
  const id = String(me.json?.id || '');
  if (pageId && id && String(pageId) !== id) return { status: 'warning', message: 'This token belongs to a different Page than the Page ID you entered.', pageId: id };
  const subs = await graph(`${pageId || id}/subscribed_apps`, pageToken, appSecret);
  if (!subs.ok) throw failure(subs);
  const leadgen = (subs.json?.data || []).some((a) => (a.subscribed_fields || []).includes('leadgen'));
  if (!leadgen) return { status: 'warning', message: 'Token works, but the Page is not sending leads to your app yet. Press "Subscribe Page".', pageId: id };
  return { status: 'ok', message: 'Connected. The Page sends new leads here.', pageId: id };
}

/** POST /{page-id}/subscribed_apps?subscribed_fields=leadgen (installs the app on the Page for lead webhooks). */
export async function subscribePage({ pageToken, appSecret, pageId }) {
  const r = await graph(`${pageId}/subscribed_apps`, pageToken, appSecret, { method: 'POST', body: formEncode({ subscribed_fields: 'leadgen' }) });
  if (!r.ok) throw failure(r);
  return { ok: r.json?.success === true || r.json?.success === 'true' };
}
