// TOTP MFA (RFC 6238 via otplib) and single-use recovery codes.
import { generateSecret, generateURI, verify } from 'otplib';
import { normaliseRecoveryCode, recoveryCode, sha256 } from '../lib/crypto.js';

export const RECOVERY_CODE_COUNT = 10;
const PURPOSE = 'mfa-totp';
// One 30 s step either side for phone clock drift.
const TOLERANCE_S = 30;

/**
 * Start (or restart) enrolment: a new unconfirmed factor. Returns the secret once.
 * @param {{ query: Function }} q
 * @param {ReturnType<import('../lib/crypto.js').createSealer>} sealer
 */
export async function startTotpEnrolment(q, sealer, user, issuer) {
  await q.query('DELETE FROM mfa_factors WHERE user_id = $1 AND confirmed_at IS NULL', [user.id]);
  const secret = generateSecret();
  await q.query('INSERT INTO mfa_factors (user_id, type, secret_enc) VALUES ($1, $2, $3)',
    [user.id, 'totp', sealer.seal(PURPOSE, secret, user.id)]);
  const otpauthUri = generateURI({ issuer, label: user.email || user.display_name || user.id, secret });
  return { secret, otpauthUri };
}

async function checkCode(q, sealer, factor, userId, code) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return false;
  const secret = sealer.open(PURPOSE, factor.secret_enc, userId);
  if (!secret) return false;
  const res = await verify({
    secret, token: code.trim(), epochTolerance: TOLERANCE_S,
    ...(factor.last_time_step != null ? { afterTimeStep: Number(factor.last_time_step) } : {}),
  });
  if (!res.valid) return false;
  await q.query('UPDATE mfa_factors SET last_time_step = $2 WHERE id = $1', [factor.id, res.timeStep]);
  return true;
}

/** Confirm the pending factor with a code from the app. */
export async function confirmTotp(q, sealer, userId, code) {
  const { rows } = await q.query(
    'SELECT * FROM mfa_factors WHERE user_id = $1 AND type = $2 AND confirmed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE', [userId, 'totp']);
  const factor = rows[0];
  if (!factor || !(await checkCode(q, sealer, factor, userId, code))) return false;
  await q.query('DELETE FROM mfa_factors WHERE user_id = $1 AND id <> $2', [userId, factor.id]);
  await q.query('UPDATE mfa_factors SET confirmed_at = now() WHERE id = $1', [factor.id]);
  return true;
}

/** Verify a code against the confirmed factor. */
export async function verifyTotp(q, sealer, userId, code) {
  const { rows } = await q.query(
    'SELECT * FROM mfa_factors WHERE user_id = $1 AND type = $2 AND confirmed_at IS NOT NULL FOR UPDATE', [userId, 'totp']);
  return rows[0] ? checkCode(q, sealer, rows[0], userId, code) : false;
}

/** Replace the user's recovery codes; returns the plaintext codes (shown once). */
export async function newRecoveryCodes(q, userId) {
  await q.query('DELETE FROM recovery_codes WHERE user_id = $1', [userId]);
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, recoveryCode);
  for (const c of codes) {
    await q.query('INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)', [userId, sha256(normaliseRecoveryCode(c))]);
  }
  return codes;
}

/** Use a recovery code (each works once). */
export async function useRecoveryCode(q, userId, code) {
  const norm = normaliseRecoveryCode(code);
  if (norm.length !== 12) return false;
  const { rowCount } = await q.query(
    'UPDATE recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL', [userId, sha256(norm)]);
  return rowCount === 1;
}

export async function remainingRecoveryCodes(q, userId) {
  const { rows } = await q.query('SELECT count(*)::int AS n FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL', [userId]);
  return rows[0].n;
}
