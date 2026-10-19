# ADR-003: Authentication, sessions, MFA, crew devices and API keys

- Status: accepted (2026-10-19)
- Deciders: Kelvin (product), workstream A (backend)

## Context

People sign in from a browser (the PWA, same origin as the API), from the iOS app
(`capacitor://localhost`, cross-origin), and on shared site iPads where a crew member taps
their name and a PIN. Integrations and AI agents need keys. Owners and admins can see money,
staff pay and customer data, and HQ staff can see across companies, so their accounts must
be hard to take over. SOC 2-aligned controls are the target.

## Decision

**Server-side sessions with opaque tokens.** A session is a row in `sessions`; the client
holds a random 256-bit token (`fts_…`) and the server stores only its sha-256. We can revoke
any session instantly (logout, password change, member removal, device revocation), which JWTs
cannot do without the same lookup.

- Web: httpOnly, Secure, SameSite=Lax cookie `ft_session`. The token never reaches page
  JavaScript. iOS: `Authorization: Bearer` (sign in with `"mode": "bearer"`).
- Lifetimes: 30 days absolute and 7 days idle for web/bearer; 12 hours and 2 hours for crew.
- A session has an active company (`tenant_id`). A user with several memberships switches with
  `POST /api/v1/auth/switch-tenant`; the role comes from `memberships`, never from the PWA's
  `employees.role`.

**Passwords:** argon2id (m = 19 MiB, t = 2, p = 1, per OWASP), 12–256 characters. Five failures
lock the account for 15 minutes. Unknown emails get the same answer and the same argon2 work.
Reset and invite links are random tokens (stored hashed), 1 hour / 7 days, single use; using
one signs out every session. Per-IP rate limits on every route that checks a credential
(sign-up, sign-in, MFA, password change/forgot/reset, OIDC, PIN sign-in, PIN changes).

**MFA: TOTP (RFC 6238) with 10 single-use recovery codes.** Required for owners and admins (in
any of their companies) and HQ staff; optional for others. Until enrolled, those users can
only reach `/me`, logout and the enrolment routes (`403 mfa_enrolment_required`). Anyone with
TOTP must verify each new session (`403 mfa_required`). Codes are checked with ±30 s
tolerance, and a code's time step is accepted only once (replay guard). TOTP secrets are
encrypted with AES-256-GCM under `SECRETS_MASTER_KEY`, bound to the user id. Five wrong codes
end the session. Google/Microsoft sign-in does not exempt owners from TOTP: we cannot see
whether the provider enforced MFA.

**Google and Microsoft (OIDC):** authorisation code + PKCE + state + nonce via `openid-client`,
enabled per provider by configuration. Short-lived state lives in an encrypted cookie scoped
to `/api/v1/auth/oidc`. An identity signs in to the account it is linked to. It is linked
automatically only when **Google** says the email is verified and it matches an existing
account; Microsoft emails are not treated as verified (the "nOAuth" class of takeover), so
Microsoft accounts are linked from a signed-in session (`start?link=1`). New accounts from
OIDC are created only while signup is open.

**CSRF:** cookie requests that change state must send `X-Fishtape: 1` (a custom header forces a
CORS preflight cross-origin, which only our origins pass) and, when an `Origin` is present,
it must be ours. SameSite=Lax adds a second layer. Bearer requests are exempt; browsers never
add `Authorization` on their own. Sign-in itself is guarded too (login CSRF).

**CORS:** `PUBLIC_ORIGIN`, `CORS_ORIGINS` and always `capacitor://localhost`, with credentials.

**Shared iPads (crew mode).** A manager registers the device; it gets a long-lived device token
(`ftd_…`, hashed, revocable; httpOnly cookie scoped to `/api/v1/devices` for browsers). The
device lists crew who have a PIN; a crew member signs in with membership + PIN (argon2id, 4–8
digits, not all one digit). Five wrong PINs lock that member for 15 minutes; 20 on one device
lock the device. A crew session works only while its device is registered, cannot change
passwords, PINs, keys or members, and its role is **capped at foreman**: a PIN is not MFA, so
owner/admin powers need a full sign-in.

**API keys:** `ft_live_…` in production, `ft_test_…` elsewhere (each environment refuses the
other's), shown once, stored as sha-256, scoped (`jobs:read`, `invoices:write`, `*:read`, …),
optional expiry, revocable, rate-limited per key. Managed by owners/admins only. Keys act for
one company, never reach identity or admin endpoints, and show up in the audit log as
`api_key` actors. Keys are not subject to MFA (they are created by an MFA-verified admin).

**Server-side authorisation.** The PWA's roles and permission keys (`electrical-app/js/auth.js`)
are copied in `server/src/auth/permissions.js` (a test fails if they drift) and applied per
collection on every REST call and sync mutation, with record rules: own time entries only for
non-managers, approval needs `time-approve`, SOP acknowledgements only for yourself, settings
limited to document numbering without the `settings` permission.

**Nothing secret in logs or responses.** Logs redact `Authorization`, cookies, device tokens,
passwords, tokens, PINs, recovery codes and secret query values (OIDC `code`/`state`), and drop
Postgres error `detail`. Error bodies never echo input. Every auth event is in the audit log
(failures for unknown emails in the platform chain).

## Consequences

- One indexed lookup per request (session + membership + MFA state in one query). Fine.
- Rate limits are per process and in memory; with several API processes they need a shared
  store.
- `SECRETS_MASTER_KEY` must be backed up separately from the database: without it, TOTP
  secrets and tenant secrets are unreadable (users would re-enrol MFA).
- PIN-only crew members are users without an email (they cannot sign in anywhere but a
  registered device).
- WebAuthn/passkeys would be a good second factor later; the session model does not change.

## Alternatives considered

- **JWT access + refresh tokens:** stateless checks, but revocation needs a denylist (a lookup
  anyway) and tokens in JS storage are exposed to XSS. Rejected.
- **SMS codes for MFA:** SIM-swap risk and cost; TOTP is free and stronger.
- **Crew sign-in without a registered device:** a PIN alone is far too weak on the open
  internet; tying it to an enrolled device makes it a second factor of sorts.
