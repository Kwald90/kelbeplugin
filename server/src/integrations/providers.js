// The providers a company can connect, what each needs and which plan feature
// unlocks it. Secret names come from services/secrets.js (SECRETS); `config` fields are
// not secret and live in integration_settings.config.
import { SECRETS } from '../services/secrets.js';

export const EMAIL_RE = /^[^\s@<>"',;]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
/** "office@example.ca" or "TG Electrical <office@example.ca>" */
export const SENDER_RE = /^(?:[^<>@"\r\n]{1,100} <([^\s<>]+)>|([^\s<>]+))$/;

export function senderAddress(from) {
  const m = SENDER_RE.exec(String(from || '').trim());
  const addr = m && (m[1] || m[2]);
  return addr && EMAIL_RE.test(addr) ? addr : null;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * @typedef {object} SecretField
 * @property {string} name      key in SECRETS
 * @property {boolean} required needed before the integration counts as connected
 * @property {(v: string) => string|null} check  returns a problem, or null when the value looks right
 * @property {string} placeholder
 */

/** @type {Record<string, { id: string, label: string, feature: string, blurb: string, secrets: SecretField[], config: Record<string, (v: any) => string|null>, webhook: string|null }>} */
export const PROVIDERS = {
  stripe: {
    id: 'stripe', label: 'Stripe', feature: 'payments.online',
    blurb: 'Customers pay invoices online by card. Payments land in your Stripe account and are recorded on the invoice automatically.',
    secrets: [
      { name: 'stripe.secret_key', required: true, placeholder: 'rk_live_… or sk_live_…',
        check: (v) => (/^(sk|rk)_(live|test)_[A-Za-z0-9]{10,}$/.test(v) ? null : 'A Stripe key starts with rk_live_, sk_live_, rk_test_ or sk_test_.') },
      { name: 'stripe.webhook_secret', required: true, placeholder: 'whsec_…',
        check: (v) => (/^whsec_[A-Za-z0-9+/=_-]{10,}$/.test(v) ? null : 'The webhook signing secret starts with whsec_.') },
    ],
    config: {},
    webhook: 'stripe',
  },
  resend: {
    id: 'resend', label: 'Resend', feature: 'integrations.email',
    blurb: 'Sends follow-up sequences, invoices and estimates from your own address.',
    secrets: [
      { name: 'resend.api_key', required: true, placeholder: 're_…',
        check: (v) => (/^re_[A-Za-z0-9_]{10,}$/.test(v) ? null : 'A Resend API key starts with re_.') },
      { name: 'resend.from', required: true, placeholder: 'TG Electrical <office@yourdomain.ca>',
        check: (v) => (senderAddress(v) ? null : 'Use an address like office@yourdomain.ca, or a name and address: TG Electrical <office@yourdomain.ca>.') },
    ],
    config: {
      replyTo: (v) => (v === '' || v == null || (typeof v === 'string' && EMAIL_RE.test(v)) ? null : 'Reply-to must be an email address.'),
    },
    webhook: null,
  },
  // The alternative to Resend for company email. When both are connected, SendGrid sends.
  sendgrid: {
    id: 'sendgrid', label: 'SendGrid', feature: 'integrations.email',
    blurb: 'Another way to send follow-up sequences, invoices and estimates from your own address. Connect SendGrid or Resend, not both.',
    secrets: [
      { name: 'sendgrid.api_key', required: true, placeholder: 'SG.…',
        check: (v) => (/^SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/.test(v) ? null : 'A SendGrid API key starts with SG. and has two more parts separated by a dot.') },
      { name: 'sendgrid.from', required: true, placeholder: 'TG Electrical <office@yourdomain.ca>',
        check: (v) => (senderAddress(v) ? null : 'Use an address like office@yourdomain.ca, or a name and address: TG Electrical <office@yourdomain.ca>.') },
    ],
    config: {
      replyTo: (v) => (v === '' || v == null || (typeof v === 'string' && EMAIL_RE.test(v)) ? null : 'Reply-to must be an email address.'),
    },
    webhook: null,
  },
  twilio: {
    id: 'twilio', label: 'Twilio', feature: 'integrations.sms',
    blurb: 'Sends follow-up texts from your own number. Replies of STOP are honoured automatically.',
    secrets: [
      { name: 'twilio.account_sid', required: true, placeholder: 'AC…',
        check: (v) => (/^AC[0-9a-fA-F]{32}$/.test(v) ? null : 'The Account SID is AC followed by 32 letters and digits.') },
      { name: 'twilio.auth_token', required: true, placeholder: '32 characters',
        check: (v) => (/^[0-9a-fA-F]{32}$/.test(v) ? null : 'The auth token is 32 letters and digits.') },
      { name: 'twilio.from', required: true, placeholder: '+1 403 555 0100',
        check: (v) => (/^\+?[\d\s().-]{10,20}$/.test(v) ? null : 'Enter your Twilio number, e.g. +1 403 555 0100.') },
    ],
    config: {},
    webhook: 'twilio',
  },
  facebook: {
    id: 'facebook', label: 'Facebook Lead Ads', feature: 'integrations.facebook',
    blurb: 'New leads from your Facebook and Instagram lead forms appear on the Leads board within seconds.',
    secrets: [
      { name: 'facebook.page_token', required: true, placeholder: 'EAA…',
        check: (v) => (/^[A-Za-z0-9_-]{30,}$/.test(v) ? null : 'Paste the long-lived Page access token (it usually starts with EAA).') },
      { name: 'facebook.app_secret', required: true, placeholder: '32 characters',
        check: (v) => (/^[0-9a-fA-F]{32}$/.test(v) ? null : 'The app secret is 32 letters and digits (App settings > Basic).') },
      { name: 'facebook.verify_token', required: true, placeholder: 'any long random phrase',
        check: (v) => (/^[\x21-\x7e]{16,128}$/.test(v) ? null : 'Use 16 to 128 characters with no spaces. The Generate button makes one.') },
    ],
    config: {
      pageId: (v) => (v === '' || v == null || /^\d{5,30}$/.test(String(v)) ? null : 'The Page ID is a number (Page > About > Page transparency).'),
      sequenceId: (v) => (v === '' || v == null || (typeof v === 'string' && ID.test(v)) ? null : 'Pick a sequence.'),
    },
    webhook: 'facebook',
  },
  anthropic: {
    id: 'anthropic', label: 'Anthropic (Claude)', feature: 'ai.assistant',
    blurb: 'Your own Claude API key for the assistant, the CEC helper and background agents. Usage is billed to your Anthropic account.',
    secrets: [
      { name: 'anthropic.api_key', required: true, placeholder: 'sk-ant-…',
        check: (v) => (/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(v) ? null : 'An Anthropic API key starts with sk-ant-.') },
    ],
    config: {},
    webhook: null,
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

for (const p of Object.values(PROVIDERS)) {
  for (const s of p.secrets) if (!SECRETS[s.name]) throw new Error(`integrations: ${s.name} is not in SECRETS`);
}

export function providerFor(id) {
  return Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id] : null;
}

/** The URL a company pastes into the provider's dashboard. */
export function webhookUrl(publicOrigin, provider, tenantId) {
  const p = PROVIDERS[provider];
  return p?.webhook ? `${publicOrigin}/api/v1/webhooks/${p.webhook}/${tenantId}` : null;
}
