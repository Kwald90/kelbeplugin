// QuickBooks names, addresses and query quoting (docs/integrations/quickbooks.md 4.2, 4.3, 7.8).
// Pure: no database, no network. The name and address rules are the CSV export's own
// (electrical-app/js/lib/qbo-export.js), so a client exported by CSV and later synced looks the same.
import { qboName as exportName, splitAddress } from '../../../../electrical-app/js/lib/qbo-export.js';

/** A QBO DisplayName/Name: no tab, line break, `:` or `"`; at most 100 characters. */
export const qboName = exportName;

const MAX_SUFFIX = 9;

/**
 * The name to try on attempt n of a create or rename that hit "duplicate name" (6240):
 * attempt 1 is the name itself, 2..9 add " (2)".." (9)" (cut so the whole stays within 100).
 * After 9 there is no name left to try: null (the link goes to error/duplicate_name).
 */
export function nextDisplayName(base, attempt = 1) {
  const name = qboName(base);
  const n = Number(attempt) || 1;
  if (n <= 1) return name;
  if (n > MAX_SUFFIX) return null;
  const suffix = ` (${n})`;
  return `${name.slice(0, 100 - suffix.length).trimEnd()}${suffix}`;
}

/** The name without a " (2)".." (9)" suffix nextDisplayName added. */
export function stripNameSuffix(name) {
  return String(name ?? '').replace(/ \([2-9]\)$/, '');
}

/** A job's sub-customer name: "J-1042 Panel upgrade 12 Elm". */
export function jobDisplayName(job) {
  return qboName([job?.number, job?.title].map((s) => String(s ?? '').trim()).filter(Boolean).join(' '))
    || qboName(`Job ${String(job?.id ?? '').slice(0, 8)}`);
}

/** Fishtape's one-string address to a QBO PhysicalAddress (Canada). Null for an empty address. */
export function addressToQbo(s) {
  const a = splitAddress(s);
  if (!a.street && !a.city && !a.province && !a.postal) return null;
  const out = {};
  if (a.street) out.Line1 = a.street.slice(0, 500);
  if (a.city) out.City = a.city.slice(0, 255);
  if (a.province) out.CountrySubDivisionCode = a.province;
  if (a.postal) out.PostalCode = a.postal;
  out.Country = 'CA';
  return out;
}

/** A QBO address back to one string: "42 Harbour St, Regina, SK S4P 3Y2". */
export function addressFromQbo(addr) {
  if (!addr || typeof addr !== 'object') return '';
  const lines = ['Line1', 'Line2', 'Line3', 'Line4', 'Line5'].map((k) => String(addr[k] ?? '').trim()).filter(Boolean);
  const city = String(addr.City ?? '').trim();
  const tail = [String(addr.CountrySubDivisionCode ?? '').trim(), String(addr.PostalCode ?? '').trim()].filter(Boolean).join(' ');
  return [...lines, city, tail].filter(Boolean).join(', ');
}

const POSTAL = /\b([a-z]\d[a-z])\s?(\d[a-z]\d)\b/g;

/**
 * Addresses compared loosely: lower case, punctuation and repeated spaces removed, postal codes
 * without their space, and a trailing "Canada" dropped (QBO keeps the country apart).
 */
export function addressKey(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(POSTAL, '$1$2')
    .replace(/\s+/g, ' ').trim().replace(/\s*\b(canada|ca)$/, '').trim();
}

/**
 * A value placed inside a QBO query string literal: backslash and single quote escaped.
 * `%` and `_` are refused (they are LIKE wildcards; a search term never needs them), so a
 * customer name can never widen a query (7.8).
 */
export function qboQuote(s) {
  const v = String(s ?? '');
  if (/[%_]/.test(v)) throw Object.assign(new Error('Search text cannot contain % or _.'), { code: 'validation_failed', statusCode: 400 });
  return v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
