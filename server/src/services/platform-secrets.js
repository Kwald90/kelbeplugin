// Fishtape's OWN platform keys (its SendGrid/Resend account and its Stripe account), set by an HQ
// admin in the HQ console instead of only in the server .env. Values live in platform_secrets
// (0163), envelope-encrypted with the secret name bound in as associated data. A set value
// overrides the matching environment variable; with nothing set the env value is used, so existing
// deployments keep working. These are platform-wide, never a company's key (those are tenant_secrets).
//
// How a DB value reaches the code: each key maps to the environment variable it overrides, and the
// overlay writes the value into process.env (DB over env). mailSettings() and billingSettings() read
// process.env lazily, so the API and worker call overlayPlatformSecrets(db, sealer) once at boot and
// the email worker re-reads per batch (platform-email.js), so a newly saved key sends without a
// restart. Nothing here (config.js) captures these vars, so overlaying env is enough and uniform.

const aad = (name) => `platform_secret:${name}`;
const MAX_LEN = 8192;

/**
 * Every platform key an HQ admin may set, mapped to the environment variable it overrides.
 * `plain: true` marks a non-secret setting (a provider name or From address) shown in full;
 * everything else shows only a `…1234` hint. Grouped by `provider` for the HQ page.
 */
export const PLATFORM_SECRETS = {
  'email.provider': { provider: 'email', label: 'Email provider', plain: true, env: 'EMAIL_PROVIDER', hintNote: 'sendgrid or resend' },
  'email.from': { provider: 'email', label: 'Sender (From) address', plain: true, env: 'EMAIL_FROM', hintNote: 'e.g. Fishtape <no-reply@fishtapehq.com>' },
  'sendgrid.api_key': { provider: 'sendgrid', label: 'SendGrid API key', env: 'SENDGRID_API_KEY', hintNote: 'Mail Send permission only' },
  'sendgrid.event_public_key': { provider: 'sendgrid', label: 'Event webhook verification key', env: 'SENDGRID_EVENT_PUBLIC_KEY' },
  'sendgrid.inbound_token': { provider: 'sendgrid', label: 'Inbound Parse URL token', env: 'SENDGRID_INBOUND_TOKEN' },
  'sendgrid.inbound_public_key': { provider: 'sendgrid', label: 'Inbound Parse signing key', env: 'SENDGRID_INBOUND_PUBLIC_KEY' },
  'resend.api_key': { provider: 'resend', label: 'Resend API key', env: 'RESEND_API_KEY' },
  'stripe.secret_key': { provider: 'stripe', label: 'Stripe secret key', env: 'STRIPE_SECRET_KEY', hintNote: 'sk_live_… or sk_test_…' },
  'stripe.webhook_secret': { provider: 'stripe', label: 'Stripe webhook signing secret', env: 'STRIPE_WEBHOOK_SECRET', hintNote: 'whsec_…' },
  'gemini.api_key': { provider: 'gemini', label: 'Gemini API key', env: 'GEMINI_API_KEY', hintNote: 'Google AI Studio key — powers walkthrough transcription' },
};

/** Providers in the order the HQ page shows them. */
export const PLATFORM_PROVIDERS = [
  { id: 'email', label: 'Email (sender)' },
  { id: 'sendgrid', label: 'SendGrid' },
  { id: 'resend', label: 'Resend' },
  { id: 'stripe', label: 'Stripe (subscriptions)' },
  { id: 'gemini', label: 'Gemini (transcription)' },
];

export function isPlatformSecret(name) {
  return Object.hasOwn(PLATFORM_SECRETS, name);
}

/** Last four characters for a secret, or the whole value for a `plain` setting. */
export function hintFor(name, value) {
  if (PLATFORM_SECRETS[name]?.plain) return String(value);
  const v = String(value);
  return v.length > 8 ? `…${v.slice(-4)}` : '…';
}

/**
 * Set (or replace) a platform key. HQ admin only; the route checks that. `actor` is the HQ user id.
 * @param {import('../db.js').Db} db
 * @param {ReturnType<import('../lib/crypto.js').createSealer>} sealer
 */
export async function setPlatformSecret(db, sealer, name, value, actor = null) {
  if (!isPlatformSecret(name)) throw Object.assign(new Error(`unknown platform key: ${name}`), { statusCode: 400, code: 'bad_request' });
  const v = String(value ?? '').trim();
  if (!v || v.length > MAX_LEN) throw Object.assign(new Error('value must be 1–8192 characters'), { statusCode: 400, code: 'bad_request' });
  const sealed = sealer.envelopeSeal(v, aad(name));
  const hint = hintFor(name, v);
  await db.withHq((c) => c.query(
    `INSERT INTO platform_secrets (name, value_enc, hint, updated_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (name) DO UPDATE SET value_enc = EXCLUDED.value_enc, hint = EXCLUDED.hint, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [name, sealed, hint, actor]));
  return { name, hint };
}

/** Remove a platform key (the env value, if any, takes over again). */
export async function deletePlatformSecret(db, name) {
  if (!isPlatformSecret(name)) throw Object.assign(new Error(`unknown platform key: ${name}`), { statusCode: 400, code: 'bad_request' });
  const { rowCount } = await db.withHq((c) => c.query('DELETE FROM platform_secrets WHERE name = $1', [name]));
  return { name, removed: rowCount > 0 };
}

/**
 * What the HQ page shows: every known key with whether it is set, a hint, and whether the
 * environment would supply it as a fallback. Never returns a secret value (plain settings aside).
 */
export async function listPlatformSecrets(db, env = process.env) {
  let rows = [];
  try { ({ rows } = await db.withHq((c) => c.query('SELECT name, hint, updated_at, updated_by FROM platform_secrets'))); } catch { rows = []; }
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  return Object.entries(PLATFORM_SECRETS).map(([name, def]) => {
    const row = byName[name];
    return {
      name, provider: def.provider, label: def.label, plain: Boolean(def.plain), hintNote: def.hintNote || '',
      set: Boolean(row), hint: row?.hint || '', updatedAt: row?.updated_at || null,
      envFallback: Boolean(env[def.env]),
    };
  });
}

/**
 * Every set platform key as { name: plaintext }, read on the app pool (SELECT grant) and decrypted
 * in-process. Returns {} if the table is missing (old database) or unreadable, so boot never fails.
 * @param {import('../db.js').Db} db
 */
export async function loadPlatformSecretsMap(db, sealer) {
  let rows = [];
  try { ({ rows } = await db.query('SELECT name, value_enc FROM platform_secrets')); } catch { return {}; }
  const out = {};
  for (const r of rows) {
    if (!isPlatformSecret(r.name)) continue;
    try { out[r.name] = sealer.envelopeOpen(r.value_enc, aad(r.name)); } catch { /* unreadable: fall back to env */ }
  }
  return out;
}

/** Write a loaded map onto an environment object (DB value overrides the matching env var). */
export function applyPlatformSecrets(env, map) {
  for (const [name, value] of Object.entries(map || {})) {
    if (value != null && isPlatformSecret(name)) env[PLATFORM_SECRETS[name].env] = String(value);
  }
  return env;
}

/** Convenience: read the DB and overlay it onto process.env (or a given env) in one call. */
export async function overlayPlatformSecrets(db, sealer, env = process.env) {
  return applyPlatformSecrets(env, await loadPlatformSecretsMap(db, sealer));
}
