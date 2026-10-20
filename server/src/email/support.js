// In-app support requests (POST /api/v1/support/requests). The tenant API files the request
// into the mail_inbound drop box (HQ files it into the Support mailbox with the company,
// user and app version attached) and queues a confirmation email to the user. HQ answers
// from the Support mailbox like any other mail; the reply goes to the user's address.
import { randomBytes } from 'node:crypto';

export const CATEGORIES = ['question', 'problem', 'billing', 'idea', 'other'];
const CATEGORY_LABEL = { question: 'Question', problem: 'Something is not working', billing: 'Billing', idea: 'Idea', other: 'Other' };
const SCREENSHOT = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/;
export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

/** Short reference people can quote: FT-7K2M9Q. */
export function supportReference() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = randomBytes(6);
  return `FT-${Array.from(b, (x) => alphabet[x % alphabet.length]).join('')}`;
}

/** Decode the optional screenshot data URL; null when absent, throws when it isn't an image. */
export function decodeScreenshot(dataUrl) {
  if (!dataUrl) return null;
  const m = SCREENSHOT.exec(String(dataUrl));
  if (!m) throw Object.assign(new Error('The screenshot must be a PNG, JPEG or WebP image.'), { code: 'bad_screenshot' });
  const bytes = Buffer.from(m[2], 'base64');
  if (!bytes.length || bytes.length > MAX_SCREENSHOT_BYTES) throw Object.assign(new Error('The screenshot must be under 5 MB.'), { code: 'bad_screenshot' });
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  return { bytes, contentType: `image/${m[1]}`, filename: `screenshot.${ext}` };
}

/**
 * The drop-box payload for a support request.
 * @param {{ reference: string, user: { id: string, name: string, email: string|null }, tenant: { id: string, name: string, plan: string|null },
 *   role: string|null, body: { subject: string, message: string, category?: string, appVersion?: string, page?: string }, userAgent: string,
 *   screenshot: { key: string, size: number, sha256: string, contentType: string, filename: string }|null, domain: string, now: Date }} o
 */
export function supportPayload(o) {
  const b = o.body;
  const category = CATEGORIES.includes(b.category) ? b.category : 'other';
  const context = [
    '',
    '--',
    `Reference: ${o.reference}`,
    `Company: ${o.tenant.name} (${o.tenant.id})${o.tenant.plan ? `, plan ${o.tenant.plan}` : ''}`,
    `From: ${o.user.name}${o.user.email ? ` <${o.user.email}>` : ' (no email address)'}${o.role ? `, ${o.role}` : ''}`,
    `Category: ${CATEGORY_LABEL[category]}`,
    `App version: ${b.appVersion || 'unknown'}`,
    b.page ? `Screen: ${b.page}` : null,
    `Browser: ${String(o.userAgent || 'unknown').slice(0, 300)}`,
  ].filter((x) => x !== null).join('\n');
  const subject = `[${o.reference}] ${String(b.subject).trim()}`.slice(0, 900);
  const from = o.user.email ? { name: o.user.name, address: o.user.email } : { name: o.user.name, address: `no-reply@${o.domain}` };
  return {
    message: {
      messageId: `support-${o.reference.toLowerCase()}@${o.domain}`,
      inReplyTo: null,
      references: [],
      subject,
      from,
      to: [],
      cc: [],
      replyTo: o.user.email ? [from] : [],
      date: o.now.toISOString(),
      text: `${String(b.message).trim()}\n${context}`,
      html: null,
    },
    attachments: o.screenshot ? [{ key: o.screenshot.key, filename: o.screenshot.filename, contentType: o.screenshot.contentType, size: o.screenshot.size, sha256: o.screenshot.sha256, contentId: null, inline: false }] : [],
    size: Buffer.byteLength(String(b.message)) + (o.screenshot?.size || 0),
    meta: {
      kind: 'support', reference: o.reference, category, tenantId: o.tenant.id, tenantName: o.tenant.name, plan: o.tenant.plan || null,
      userId: o.user.id, userName: o.user.name, role: o.role || null, appVersion: b.appVersion || null, page: b.page || null,
    },
  };
}

/** The confirmation the user gets (platform email). Threads with the request by References. */
export function confirmationEmail({ reference, user, subject, appName, domain, replyTo }) {
  return {
    to: user.email,
    template: 'support-confirmation',
    subject: `We got your message [${reference}]`,
    text: [
      `Hi ${String(user.name || '').split(/\s+/)[0] || 'there'},`,
      '',
      `Thanks for writing to ${appName} support. We got your message "${String(subject).slice(0, 120)}" and will answer by email, usually within one business day.`,
      '',
      `Your reference is ${reference}. To add anything, reply to this email.`,
      '',
      `${appName} Support`,
    ].join('\n'),
    replyTo,
    headers: { 'In-Reply-To': `<support-${reference.toLowerCase()}@${domain}>`, References: `<support-${reference.toLowerCase()}@${domain}>` },
  };
}
