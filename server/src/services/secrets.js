// Per-company secrets: each company brings its own Stripe, Resend or SendGrid, Twilio, Anthropic and
// Facebook keys. Values live in tenant_secrets, envelope-encrypted with a fresh data key
// each, and the tenant id and name are bound in as associated data, so a sealed value
// can't be copied to another company or another name. Plaintext never leaves the
// server: callers outside the integration code only ever see names and a short hint.

/**
 * Every secret a company can set. `guide` is the slug of the in-app setup guide.
 * Add names here; anything not listed is refused.
 */
export const SECRETS = {
  'anthropic.api_key': { provider: 'anthropic', label: 'Anthropic API key', guide: 'anthropic' },
  'stripe.secret_key': { provider: 'stripe', label: 'Stripe secret key', guide: 'stripe' },
  'stripe.webhook_secret': { provider: 'stripe', label: 'Stripe webhook signing secret', guide: 'stripe' },
  'resend.api_key': { provider: 'resend', label: 'Resend API key', guide: 'resend' },
  'resend.from': { provider: 'resend', label: 'Resend sender address', guide: 'resend', plain: true },
  'sendgrid.api_key': { provider: 'sendgrid', label: 'SendGrid API key', guide: 'sendgrid' },
  'sendgrid.from': { provider: 'sendgrid', label: 'SendGrid sender address', guide: 'sendgrid', plain: true },
  'twilio.account_sid': { provider: 'twilio', label: 'Twilio account SID', guide: 'twilio', plain: true },
  'twilio.auth_token': { provider: 'twilio', label: 'Twilio auth token', guide: 'twilio' },
  'twilio.from': { provider: 'twilio', label: 'Twilio sending number', guide: 'twilio', plain: true },
  'facebook.page_token': { provider: 'facebook', label: 'Facebook Page access token', guide: 'facebook' },
  'facebook.app_secret': { provider: 'facebook', label: 'Facebook app secret', guide: 'facebook' },
  'facebook.verify_token': { provider: 'facebook', label: 'Facebook webhook verify token', guide: 'facebook' },
  // Internal: written and read only by the QuickBooks code with { internal: true }. The generic
  // secret routes refuse them (isSecretName is false) and listSecrets never shows them.
  'qbo.refresh_token': { provider: 'qbo', label: 'QuickBooks refresh token', guide: 'quickbooks', internal: true },
  'qbo.access_token': { provider: 'qbo', label: 'QuickBooks access token', guide: 'quickbooks', internal: true },
  'qbo.realm_id': { provider: 'qbo', label: 'QuickBooks company id', guide: 'quickbooks', internal: true },
};

const MAX_LEN = 4096;
const aad = (tenantId, name) => `tenant_secret:${tenantId}:${name}`;

/** envelopeOpen throws when a value isn't authentic; here that just means "no usable secret". */
function open(sealer, sealed, tenantId, name) {
  try { return sealer.envelopeOpen(sealed, aad(tenantId, name)); } catch { return null; }
}

/** A name a company may set, read or delete through the generic secret routes (never an internal one). */
export function isSecretName(name) {
  return Object.hasOwn(SECRETS, name) && !SECRETS[name].internal;
}

/** Internal names (QuickBooks tokens) need { internal: true }; everything else must be a public name. */
function check(name, opts = {}) {
  if (!Object.hasOwn(SECRETS, name)) throw new Error(`unknown secret name: ${name}`);
  if (Boolean(SECRETS[name].internal) !== Boolean(opts.internal)) throw new Error(`secret ${name} is ${SECRETS[name].internal ? 'internal' : 'not internal'}`);
}

/** Last four characters for display, or the whole value for non-secret settings like a sender address. */
export function hintFor(name, value) {
  if (SECRETS[name]?.plain) return value;
  return value.length > 8 ? `…${value.slice(-4)}` : '…';
}

/**
 * @param {import('../db.js').TenantTx} tx
 * @param {ReturnType<import('../lib/crypto.js').createSealer>} sealer
 */
export async function setSecret(tx, sealer, name, value, actor = null, opts = {}) {
  check(name, opts);
  const v = String(value ?? '').trim();
  if (!v || v.length > MAX_LEN) throw new Error('secret value must be 1-4096 characters');
  const sealed = sealer.envelopeSeal(v, aad(tx.tenantId, name));
  await tx.query(
    `INSERT INTO tenant_secrets (tenant_id, name, value_enc, created_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, name) DO UPDATE SET value_enc = EXCLUDED.value_enc, updated_at = now()`,
    [tx.tenantId, name, sealed, actor]);
}

/** The plaintext, or null when unset or not authentic. Only integration code should call this. */
export async function getSecret(tx, sealer, name, opts = {}) {
  check(name, opts);
  const { rows } = await tx.query('SELECT value_enc FROM tenant_secrets WHERE tenant_id = $1 AND name = $2', [tx.tenantId, name]);
  if (!rows[0]) return null;
  return open(sealer, rows[0].value_enc, tx.tenantId, name);
}

/** Several secrets at once, e.g. getSecrets(tx, sealer, ['twilio.account_sid', 'twilio.auth_token']). */
export async function getSecrets(tx, sealer, names, opts = {}) {
  const out = {};
  for (const n of names) out[n] = await getSecret(tx, sealer, n, opts);
  return out;
}

export async function deleteSecret(tx, name, opts = {}) {
  check(name, opts);
  const { rowCount } = await tx.query('DELETE FROM tenant_secrets WHERE tenant_id = $1 AND name = $2', [tx.tenantId, name]);
  return rowCount > 0;
}

/** What the settings screen may show: name, label, provider, guide, hint, updatedAt. Never the value. */
export async function listSecrets(tx, sealer) {
  const { rows } = await tx.query('SELECT name, value_enc, updated_at FROM tenant_secrets WHERE tenant_id = $1 ORDER BY name', [tx.tenantId]);
  return rows.filter((r) => isSecretName(r.name)).map((r) => {
    const value = open(sealer, r.value_enc, tx.tenantId, r.name);
    return { name: r.name, ...SECRETS[r.name], hint: value == null ? null : hintFor(r.name, value), valid: value != null, updatedAt: r.updated_at };
  });
}
