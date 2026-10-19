// argon2id for passwords and crew PINs (@node-rs/argon2, prebuilt, no compiler needed).
import { hash, verify, Algorithm } from '@node-rs/argon2';

// OWASP Password Storage Cheat Sheet (2024): argon2id, m=19 MiB, t=2, p=1.
const OPTIONS = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

export function hashSecret(plain) {
  return hash(String(plain), OPTIONS);
}

export async function verifySecret(stored, plain) {
  if (!stored) return false;
  try { return await verify(stored, String(plain)); } catch { return false; }
}

// Verified against when the account does not exist, so a miss costs the same time as a hit.
let dummy = null;
export async function burnTime(plain) {
  dummy ??= await hashSecret('fishtape-timing-equaliser');
  await verifySecret(dummy, plain);
}

/** @returns {string|null} why the password is not acceptable, or null */
export function passwordProblem(password, email) {
  if (typeof password !== 'string') return 'Password is required.';
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (email && password.toLowerCase() === String(email).toLowerCase()) return 'The password cannot be your email address.';
  if (/^(.)\1+$/.test(password)) return 'The password cannot be one repeated character.';
  return null;
}

/** Crew PIN: 4-8 digits. */
export function pinProblem(pin) {
  if (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin)) return 'A PIN is 4 to 8 digits.';
  if (/^(\d)\1+$/.test(pin)) return 'A PIN cannot be one repeated digit.';
  return null;
}
