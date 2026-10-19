// Lengths. Every length is stored in metres; each user chooses whether it is
// shown metric or imperial (feet-inches to the 1/16"). Pure functions, plus a
// per-device preference that moves to the user's profile once accounts sync.

const KEY = 'ft.units';
export const UNITS = ['metric', 'imperial'];
export const M_PER_IN = 0.0254;
export const M_PER_FT = 0.3048;
export const inToM = (inches) => inches * M_PER_IN;
export const mToIn = (m) => m / M_PER_IN;

/** The current user's choice, or `fallback` (company default) if they have not picked yet. */
export function getUnits(fallback = 'metric') {
  try {
    const v = localStorage.getItem(KEY);
    if (UNITS.includes(v)) return v;
  } catch { /* storage blocked or not a browser */ }
  return UNITS.includes(fallback) ? fallback : 'metric';
}

export function hasUnitsChoice() {
  try { return UNITS.includes(localStorage.getItem(KEY)); } catch { return false; }
}

export function setUnits(units) {
  if (!UNITS.includes(units)) throw new Error(`Unknown units: ${units}`);
  try { localStorage.setItem(KEY, units); } catch { /* ignore */ }
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/** 3.625 -> '3 5/8"' (rounded to 1/denom inch). */
export function fmtInches(inches, denom = 16) {
  const n = Math.round(Math.abs(inches) * denom);
  const whole = Math.floor(n / denom);
  const f = n - whole * denom;
  const sign = inches < 0 && n ? '-' : '';
  if (!f) return `${sign}${whole}"`;
  const g = gcd(f, denom);
  const frac = `${f / g}/${denom / g}`;
  return `${sign}${whole ? whole + ' ' : ''}${frac}"`;
}

/**
 * fmtLength(metres, { units, denom, feet, metric }) -> display string.
 * imperial: 12' 3 5/8" (feet: false gives 147 5/8"); metric: 450 mm under a metre, 3.25 m above
 * (metric: 'mm' | 'cm' | 'm' forces one).
 */
export function fmtLength(m, { units = getUnits(), denom = 16, feet = true, metric = 'auto' } = {}) {
  if (m == null || !Number.isFinite(m)) return '—';
  if (units === 'imperial') {
    const inches = mToIn(m);
    if (!feet) return fmtInches(inches, denom);
    const n = Math.round(Math.abs(inches) * denom);
    const ft = Math.floor(n / (12 * denom));
    const rem = (n - ft * 12 * denom) / denom;
    const sign = m < 0 && n ? '-' : '';
    if (!ft) return sign + fmtInches(rem, denom);
    return rem ? `${sign}${ft}' ${fmtInches(rem, denom)}` : `${sign}${ft}'`;
  }
  const unit = metric === 'auto' ? (Math.abs(m) < 1 ? 'mm' : 'm') : metric;
  if (unit === 'mm') return `${Math.round(m * 1000)} mm`;
  if (unit === 'cm') return `${(m * 100).toFixed(1).replace(/\.0$/, '')} cm`;
  return `${m.toFixed(2)} m`;
}

const NUM = String.raw`\d+(?:\.\d+)?|\.\d+`;
const INCH_PART = new RegExp(String.raw`^(?:(${NUM})(?:[\s-]+(\d+)\/(\d+))?|(\d+)\/(\d+))$`);

function parseInchPart(t) {
  t = t.trim();
  if (!t) return 0;
  const m = t.match(INCH_PART);
  if (!m) return null;
  if (m[4]) return Number(m[4]) / Number(m[5]);
  return Number(m[1]) + (m[2] ? Number(m[2]) / Number(m[3]) : 0);
}

/**
 * Parse what someone types into metres, or null if it can't be read.
 * Takes 12' 3 5/8", 12'3", 12 ft 3 in, 3-5/8", 147.5", 3.2 m, 450mm, 45 cm.
 * A bare number is read in `bare` units: 'in' | 'ft' | 'mm' | 'cm' | 'm'
 * (default: inches for imperial users, metres for metric).
 */
export function parseLength(input, { units = getUnits(), bare } = {}) {
  if (input == null) return null;
  let s = String(input).trim().toLowerCase()
    .replace(/[′’]/g, "'").replace(/[″”]/g, '"').replace(/''/g, '"')
    .replace(/\s*(feet|foot|ft)\b\.?/g, "'").replace(/\s*(inches|inch|in)\b\.?/g, '"');
  if (!s) return null;
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1).trim();
  const out = (v) => (v == null || !Number.isFinite(v) ? null : neg ? -v : v);

  const metric = s.match(new RegExp(String.raw`^(${NUM})\s*(mm|cm|m)$`));
  if (metric) return out(Number(metric[1]) * { mm: 0.001, cm: 0.01, m: 1 }[metric[2]]);

  if (/['"]/.test(s)) {
    const m = s.match(new RegExp(String.raw`^(?:(${NUM})\s*')?\s*-?\s*(.*?)\s*(")?$`));
    if (!m) return null;
    const [, ft, rest, quote] = m;
    if (rest && !quote && ft == null) return null;
    const inches = parseInchPart(rest);
    if (inches == null) return null;
    return out(inToM((ft ? Number(ft) * 12 : 0) + inches));
  }

  const unit = bare || (units === 'imperial' ? 'in' : 'm');
  if (unit === 'in') { const v = parseInchPart(s); return v == null ? null : out(inToM(v)); }
  if (!new RegExp(String.raw`^(${NUM})$`).test(s)) return null;
  const k = { ft: M_PER_FT, mm: 0.001, cm: 0.01, m: 1 }[unit];
  return k ? out(Number(s) * k) : null;
}
