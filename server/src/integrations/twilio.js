// Twilio SMS with the company's own account: E.164 numbers, opt-out keywords, sending,
// a read-only connection test and X-Twilio-Signature checks for inbound messages.
import { createHmac } from 'node:crypto';
import { safeEqual } from '../lib/crypto.js';
import { ProviderError, formEncode, httpFailure, request } from './http.js';

const API = 'https://api.twilio.com/2010-04-01';

/**
 * Canadian/US numbers to E.164: "(403) 555-0100", "403.555.0100", "1-403-555-0100" -> "+14035550100".
 * Numbers written with a leading + keep their country code. Returns null when it can't be a valid number.
 */
export function toE164(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  if (s.startsWith('+')) return /^[1-9]\d{7,14}$/.test(digits) && (!digits.startsWith('1') || nanp(digits.slice(1))) ? `+${digits}` : null;
  if (digits.length === 10 && nanp(digits)) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1') && nanp(digits.slice(1))) return `+${digits}`;
  return null;
}

/** North American Numbering Plan: NXX-NXX-XXXX (area code and exchange start 2-9). */
function nanp(ten) {
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten);
}

// Twilio's default opt-out handling for long codes in the US and Canada (Twilio help
// article 223134027, checked 2026-10-19): single-word replies, case-insensitive.
export const OPT_OUT_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
export const OPT_IN_WORDS = new Set(['START', 'YES', 'UNSTOP']);

/** 'out' | 'in' | null for an inbound message body. */
export function optKeyword(body) {
  const w = String(body ?? '').trim().replace(/[.!]+$/, '').toUpperCase();
  if (OPT_OUT_WORDS.has(w)) return 'out';
  if (OPT_IN_WORDS.has(w)) return 'in';
  return null;
}

const auth = (sid, token) => `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;

function failure(r) {
  const code = r.json?.code ?? null;
  if (code === 21610) return new ProviderError('twilio', 'This person replied STOP, so texts to them are blocked until they reply START.', { status: r.status, code, kind: 'optout' });
  if (code === 21211 || code === 21614) return new ProviderError('twilio', 'The phone number is not a valid mobile number.', { status: r.status, code, kind: 'invalid' });
  if (code === 21408) return new ProviderError('twilio', 'Your Twilio account is not allowed to text this country. Turn it on in Messaging > Settings > Geo permissions.', { status: r.status, code, kind: 'invalid' });
  if (code === 21606 || code === 21659 || code === 21212) return new ProviderError('twilio', 'Twilio will not send from this number. Check the sending number in Integrations.', { status: r.status, code, kind: 'auth' });
  if (code === 20003 || r.status === 401) return new ProviderError('twilio', 'Twilio refused the Account SID or auth token.', { status: r.status, code, kind: 'auth' });
  if (code === 20429 || r.status === 429) return new ProviderError('twilio', 'Twilio is rate limiting. We will try again shortly.', { status: r.status, code, retry: true, kind: 'quota' });
  return httpFailure('twilio', r.status, r.json?.message, code);
}

/** @returns {Promise<{ sid: string, status: string }>} */
export async function sendSms({ accountSid, authToken, from, to, body }) {
  const r = await request('twilio', `${API}/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
    method: 'POST',
    headers: { authorization: auth(accountSid, authToken), 'content-type': 'application/x-www-form-urlencoded' },
    body: formEncode({ To: to, From: from, Body: body }),
  });
  if (!r.ok) throw failure(r);
  return { sid: String(r.json?.sid || ''), status: String(r.json?.status || '') };
}

/** Fetch the account (read-only), then check the sending number belongs to it. */
export async function testTwilio({ accountSid, authToken, from }) {
  const a = await request('twilio', `${API}/Accounts/${encodeURIComponent(accountSid)}.json`, { headers: { authorization: auth(accountSid, authToken) } });
  if (!a.ok) throw failure(a);
  if (a.json?.status && a.json.status !== 'active') return { status: 'warning', message: `The Twilio account is ${String(a.json.status).slice(0, 20)}.` };
  const e164 = toE164(from);
  if (!e164) return { status: 'warning', message: 'Credentials work, but the sending number does not look right.' };
  const n = await request('twilio', `${API}/Accounts/${encodeURIComponent(accountSid)}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(e164)}&PageSize=1`, { headers: { authorization: auth(accountSid, authToken) } });
  if (!n.ok) throw failure(n);
  const owned = Array.isArray(n.json?.incoming_phone_numbers) && n.json.incoming_phone_numbers.length > 0;
  if (!owned) return { status: 'warning', message: 'Credentials work, but the sending number is not on this Twilio account.' };
  const trial = a.json?.type === 'Trial';
  return { status: trial ? 'warning' : 'ok', message: trial ? 'Connected, but this is a Twilio trial account: it can only text verified numbers and adds a trial notice.' : 'Connected.' };
}

/**
 * X-Twilio-Signature: base64(HMAC-SHA1(authToken, url + each POST param name+value, sorted by name)).
 * @param {string} url the full URL Twilio called
 * @param {Record<string, string>} params the form fields
 */
export function twilioSignature(authToken, url, params) {
  const data = Object.keys(params).sort().reduce((s, k) => s + k + (params[k] ?? ''), url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function verifyTwilio(authToken, url, params, header) {
  if (!authToken || !header) return false;
  return safeEqual(twilioSignature(authToken, url, params), String(header));
}
