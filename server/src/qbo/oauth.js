// Intuit OAuth 2.0 (docs/integrations/quickbooks.md 2.2-2.4): the authorize URL, the code exchange,
// refresh with rotation and revoke. Fishtape is a confidential client (client_secret_basic). Token
// values never reach a log, an error message or a response: failures are QboErrors from the fixed
// table, with nothing of Intuit's answer but its error code.
import { createHash } from 'node:crypto';
import { ProviderError, request } from '../integrations/http.js';
import { qboCfg } from './env.js';
import { QboError } from './client.js';

/**
 * PKCE for this confidential client. Intuit's discovery document
 * (https://developer.api.intuit.com/.well-known/openid_configuration, read 2026-10-20) lists no
 * code_challenge_methods_supported, so it is off; the ticket, flow cookie and state row are the
 * CSRF protection either way (2.2, 11.4 item 1).
 */
export const QBO_PKCE = false;

/** S256 code challenge for a PKCE verifier. */
export function codeChallengeFor(verifier) {
  return createHash('sha256').update(String(verifier)).digest('base64url');
}

/**
 * @param {object} cfg config or config.qbo
 * @param {{ state: string, redirectUri: string, codeChallenge?: string|null }} o
 */
export function authorizeUrl(cfg, { state, redirectUri, codeChallenge = null }) {
  const q = qboCfg(cfg);
  const params = new URLSearchParams({ client_id: q.clientId, response_type: 'code', scope: q.scope, redirect_uri: redirectUri, state });
  if (codeChallenge) { params.set('code_challenge', codeChallenge); params.set('code_challenge_method', 'S256'); }
  return `${q.oauth.authorize}?${params}`;
}

const basic = (q) => `Basic ${Buffer.from(`${q.clientId}:${q.clientSecret}`).toString('base64')}`;

/** POST to the token endpoint and map Intuit's answer. */
async function tokenCall(q, form) {
  let res;
  try {
    res = await request('qbo', q.oauth.token, {
      method: 'POST',
      headers: {
        authorization: basic(q),
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        // Ask for x_refresh_token_hard_expires_in (the 5-year limit, 2.3).
        'x-include-refresh-token-hard-expires-in': 'true',
      },
      body: new URLSearchParams(form).toString(),
      timeoutMs: q.tokenTimeoutMs,
    });
  } catch (e) {
    throw new QboError('unavailable', { retry: true, variant: e instanceof ProviderError && /in time/.test(e.message) ? 'timeout' : null });
  }
  const tid = res.headers?.get?.('intuit_tid') || null;
  if (res.ok && res.json?.access_token && res.json?.refresh_token) return toTokenSet(res.json);
  const err = String(res.json?.error || '');
  if (res.status >= 500 || res.status === 429) throw new QboError('unavailable', { status: res.status, intuitTid: tid, retry: true });
  // invalid_grant: this tenant's grant is gone (revoked in QuickBooks, expired, or a rotated token).
  if (res.status === 400 && err === 'invalid_grant') throw new QboError('auth', { status: 400, faultCode: 'invalid_grant', intuitTid: tid });
  // invalid_client, any 401, any other 400: Fishtape's own client id or secret is wrong (2.4 step 5).
  if (res.ok) throw new QboError('unavailable', { status: res.status, intuitTid: tid, retry: true });
  throw new QboError('platform', { status: res.status, faultCode: /^[a-z_]{1,40}$/.test(err) ? err : null, intuitTid: tid, retry: true });
}

function toTokenSet(j) {
  const n = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
  return {
    accessToken: String(j.access_token),
    refreshToken: String(j.refresh_token),
    expiresIn: n(j.expires_in) ?? 3600,
    refreshExpiresIn: n(j.x_refresh_token_expires_in) ?? 8_726_400,
    refreshHardExpiresIn: n(j.x_refresh_token_hard_expires_in),
  };
}

/**
 * Exchange an authorization code once.
 * @returns {Promise<TokenSet>}
 */
export async function exchangeCode(cfg, { code, redirectUri, codeVerifier = null }) {
  const form = { grant_type: 'authorization_code', code: String(code), redirect_uri: redirectUri };
  if (codeVerifier) form.code_verifier = codeVerifier;
  return tokenCall(qboCfg(cfg), form);
}

/**
 * Refresh. Intuit may rotate the refresh token: always store the one returned.
 * Throws QboError kind 'auth' (invalid_grant), 'platform' (client credentials) or 'unavailable'.
 * @returns {Promise<TokenSet>}
 */
export async function refreshTokens(cfg, refreshToken) {
  return tokenCall(qboCfg(cfg), { grant_type: 'refresh_token', refresh_token: String(refreshToken) });
}

/**
 * Revoke a refresh (or access) token. Revoking may end the whole grant for that app and realm
 * (2.2, 11.4 item 15), so callers follow the revoke rule. An already dead token counts as revoked.
 */
export async function revokeToken(cfg, token) {
  const q = qboCfg(cfg);
  let res;
  try {
    res = await request('qbo', q.oauth.revoke, {
      method: 'POST',
      headers: { authorization: basic(q), accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ token: String(token) }),
      timeoutMs: q.tokenTimeoutMs,
    });
  } catch {
    throw new QboError('unavailable', { retry: true });
  }
  if (res.ok) return;
  if (res.status === 400 && String(res.json?.error || '') === 'invalid_grant') return;
  if (res.status === 401 || res.status === 400) throw new QboError('platform', { status: res.status, retry: true });
  throw new QboError('unavailable', { status: res.status, retry: true });
}

/** @typedef {{ accessToken: string, refreshToken: string, expiresIn: number, refreshExpiresIn: number, refreshHardExpiresIn: number|null }} TokenSet */
