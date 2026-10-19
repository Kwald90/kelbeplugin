// Platform email. For now every message is written to email_outbox; a sender (Resend,
// Phase 1) will drain it. The interface stays the same when that lands.

/**
 * @typedef {object} EmailMessage
 * @property {string} to
 * @property {string} subject
 * @property {string} text
 * @property {string} [html]
 * @property {string} [template]
 * @property {string|null} [tenantId]
 */

export function createEmail() {
  return {
    /**
     * Queue a message. Pass the transaction client so the email commits with the change.
     * @param {{ query: Function }} q
     * @param {EmailMessage} m
     */
    async send(q, m) {
      await q.query(
        `INSERT INTO email_outbox (tenant_id, to_address, subject, text_body, html_body, template) VALUES ($1, $2, $3, $4, $5, $6)`,
        [m.tenantId || null, m.to, m.subject, m.text, m.html || null, m.template || null]);
    },
  };
}

export function resetEmail({ to, link, appName, invite }) {
  return invite
    ? {
      to, template: 'invite', subject: `You're invited to ${appName}`,
      text: `You've been added to ${appName}. Set your password here (the link works for 7 days):\n\n${link}\n\nIf you weren't expecting this, ignore this email.`,
    }
    : {
      to, template: 'password-reset', subject: `Reset your ${appName} password`,
      text: `Someone asked to reset the password for this email. If it was you, use this link (it works for 1 hour):\n\n${link}\n\nIf it wasn't you, ignore this email; your password has not changed.`,
    };
}
