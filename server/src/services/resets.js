// Password reset and invite links. The token is emailed once; only its hash is stored.
import { BRAND } from '../brand.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { resetEmail } from '../lib/email.js';

export const RESET_TTL_S = 3600;
export const INVITE_TTL_S = 7 * 24 * 3600;

/**
 * Create a reset (or invite) token for a user and queue the email, in the given
 * transaction client. Earlier unused links for the user stop working.
 */
export async function issuePasswordLink(q, { config, email }, { userId, to, invite = false }) {
  const token = randomToken('ftr_');
  await q.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId]);
  await q.query(
    'INSERT INTO password_resets (user_id, token_hash, purpose, expires_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4))',
    [userId, sha256(token), invite ? 'invite' : 'reset', invite ? INVITE_TTL_S : RESET_TTL_S]);
  const link = `${config.publicOrigin}/#/reset-password?token=${encodeURIComponent(token)}`;
  await email.send(q, resetEmail({ to, link, appName: BRAND.name, invite }));
}
