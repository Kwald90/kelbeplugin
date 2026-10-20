// Email settings from the environment (server/.env.example, deploy/*/.env.example).
// config.js does not read these, so they come from process.env; tests pass overrides as
// config.mail (an object merged over these values).
//
//   EMAIL_PROVIDER            sendgrid | resend. Default: sendgrid when SENDGRID_API_KEY is set.
//   SENDGRID_API_KEY          Fishtape's own SendGrid key (Mail Send permission only).
//   RESEND_API_KEY            the older provider, still supported.
//   EMAIL_FROM                "Fishtape <no-reply@fishtapehq.com>": sender of system email.
//   SENDGRID_EVENT_PUBLIC_KEY verification key of the Signed Event Webhook (base64 or PEM).
//   SENDGRID_EVENT_MAX_AGE_S  how old a signed event request may be (default 300 s).
//   SENDGRID_TRACK_OPENS      on | off (default off): ask SendGrid to report opens.
//   SENDGRID_INBOUND_TOKEN    the secret last path segment of the Inbound Parse URL.
//   SENDGRID_INBOUND_PUBLIC_KEY optional: verification key of an Inbound Parse security policy.
//   MAIL_DIR                  where attachments live, outside the code checkout and web root.
//   MAIL_INBOUND_MAX_BYTES    largest Inbound Parse request accepted (default 31 MiB).
//   MAIL_DOMAIN               the domain in Message-IDs Fishtape creates (default fishtapehq.com).
//   MAIL_SUPPORT_ADDRESS      where replies to support confirmations go (default support@inbox.<MAIL_DOMAIN>).
import { createPublicKey } from 'node:crypto';

const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));
const MiB = 1024 * 1024;

/** A SendGrid verification key as a KeyObject, or null when missing or unreadable. */
export function readPublicKey(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  try {
    if (v.includes('BEGIN PUBLIC KEY')) return createPublicKey(v);
    return createPublicKey({ key: Buffer.from(v.replace(/\s+/g, ''), 'base64'), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

/**
 * @param {{ mail?: object }} [config]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function mailSettings(config = {}, env = process.env) {
  const sendgridApiKey = env.SENDGRID_API_KEY || '';
  const provider = String(env.EMAIL_PROVIDER || (sendgridApiKey ? 'sendgrid' : 'resend')).toLowerCase() === 'resend' ? 'resend' : 'sendgrid';
  const base = {
    provider,
    sendgridApiKey,
    resendApiKey: env.RESEND_API_KEY || '',
    from: env.EMAIL_FROM || '',
    eventPublicKey: readPublicKey(env.SENDGRID_EVENT_PUBLIC_KEY),
    eventMaxAgeS: int(env.SENDGRID_EVENT_MAX_AGE_S, 300),
    trackOpens: env.SENDGRID_TRACK_OPENS === 'on',
    inboundToken: env.SENDGRID_INBOUND_TOKEN || '',
    inboundPublicKey: readPublicKey(env.SENDGRID_INBOUND_PUBLIC_KEY),
    mailDir: env.MAIL_DIR || '',
    inboundMaxBytes: int(env.MAIL_INBOUND_MAX_BYTES, 31 * MiB),
    domain: env.MAIL_DOMAIN || 'fishtapehq.com',
    supportAddress: (env.MAIL_SUPPORT_ADDRESS || `support@inbox.${env.MAIL_DOMAIN || 'fishtapehq.com'}`).toLowerCase(),
    appEnv: config.appEnv || env.APP_ENV || 'local',
    supportPerHour: int(env.SUPPORT_RATE_LIMIT_PER_HOUR, 5),
    supportPerDay: int(env.SUPPORT_RATE_LIMIT_PER_DAY, 20),
  };
  const out = { ...base, ...(config.mail || {}) };
  if (config.mail && typeof config.mail.eventPublicKey === 'string') out.eventPublicKey = readPublicKey(config.mail.eventPublicKey);
  if (config.mail && typeof config.mail.inboundPublicKey === 'string') out.inboundPublicKey = readPublicKey(config.mail.inboundPublicKey);
  return out;
}
