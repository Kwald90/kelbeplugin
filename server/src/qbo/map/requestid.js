// Stable QBO request ids (docs/integrations/quickbooks.md 5.3, 5.8): the same parts always give
// the same id, so a retried create or update is recognised by Intuit's requestid dedupe. Base32
// (RFC 4648, lower case) of SHA-256, cut to 36 characters, which also fits a batch item's bId.
import { createHash } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * requestIdFor([tenantId, linkId, 'create']) -> 36 characters. Parts are joined with a unit
 * separator, so ['a', 'bc'] and ['ab', 'c'] differ. null and undefined count as ''.
 */
export function requestIdFor(parts) {
  if (!Array.isArray(parts) || !parts.length) throw new TypeError('requestIdFor needs a non-empty array of parts');
  const text = parts.map((p) => (p == null ? '' : String(p))).join('\u001f');
  return base32(createHash('sha256').update(text, 'utf8').digest()).slice(0, 36);
}
