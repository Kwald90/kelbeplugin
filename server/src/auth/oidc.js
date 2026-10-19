// Google and Microsoft sign-in (OpenID Connect, authorisation code + PKCE, openid-client).
// A provider is enabled only when its client id and secret are configured.
// Tests replace these with a mock that has the same two methods.
import * as oidc from 'openid-client';

/**
 * @typedef {object} OidcProvider
 * @property {string} name
 * @property {(o: { redirectUri: string, state: string, nonce: string, codeChallenge: string }) => Promise<string>} authorizationUrl
 * @property {(o: { currentUrl: string, state: string, nonce: string, codeVerifier: string }) => Promise<{ subject: string, email: string|null, emailVerified: boolean, name: string|null }>} callback
 */

/** @returns {Record<string, OidcProvider>} */
export function createOidcProviders(config) {
  const out = {};
  for (const name of ['google', 'microsoft']) {
    const c = config.oidc[name];
    if (!c) continue;
    let discovered = null;
    const conf = () => (discovered ??= oidc.discovery(new URL(c.issuer), c.clientId, c.clientSecret).catch((e) => { discovered = null; throw e; }));
    out[name] = {
      name,
      async authorizationUrl({ redirectUri, state, nonce, codeChallenge }) {
        const url = oidc.buildAuthorizationUrl(await conf(), {
          redirect_uri: redirectUri, scope: 'openid email profile', state, nonce,
          code_challenge: codeChallenge, code_challenge_method: 'S256',
          ...(name === 'microsoft' ? { prompt: 'select_account' } : {}),
        });
        return url.href;
      },
      async callback({ currentUrl, state, nonce, codeVerifier }) {
        const tokens = await oidc.authorizationCodeGrant(await conf(), new URL(currentUrl), {
          pkceCodeVerifier: codeVerifier, expectedState: state, expectedNonce: nonce, idTokenExpected: true,
        });
        const claims = tokens.claims() || {};
        return {
          subject: String(claims.sub),
          email: typeof claims.email === 'string' ? claims.email.toLowerCase() : null,
          // Only Google's email_verified is trusted for linking by email (see adr-003).
          emailVerified: name === 'google' && claims.email_verified === true,
          name: typeof claims.name === 'string' ? claims.name : null,
        };
      },
    };
  }
  return out;
}

export const pkce = {
  verifier: () => oidc.randomPKCECodeVerifier(),
  challenge: (v) => oidc.calculatePKCECodeChallenge(v),
  state: () => oidc.randomState(),
  nonce: () => oidc.randomNonce(),
};
