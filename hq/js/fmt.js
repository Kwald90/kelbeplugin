// Small formatters for HQ pages.
import { PLANS } from '/js/plans.js';

export function bytes(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n), i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function duration(seconds) {
  if (seconds == null) return '—';
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** "3 min ago", "in 5 days". */
export function ago(iso) {
  if (!iso) return '—';
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const [n, unit] = abs < 60 ? [abs, 'second'] : abs < 3600 ? [abs / 60, 'minute'] : abs < 86400 ? [abs / 3600, 'hour'] : abs < 86400 * 60 ? [abs / 86400, 'day'] : [abs / (86400 * 30), 'month'];
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round(diff < 0 ? -n : n), unit);
}

export const sha = (s) => (s ? String(s).slice(0, 8) : '—');
export const planName = (id) => (id === 'trial' ? 'Trial' : PLANS[id]?.name || id || '—');
export const pct = (v) => (v == null ? '—' : `${v}%`);
export const ms = (v) => (v == null ? '—' : `${v} ms`);
export const daysUntil = (iso) => (iso ? Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000) : null);

/** Badge tone for a company or billing status. */
export const TONE = {
  active: 'success', suspended: 'danger', closed: 'neutral', trialing: 'info', past_due: 'warning', unpaid: 'danger', canceled: 'neutral', none: 'neutral',
  incomplete: 'warning', incomplete_expired: 'neutral', paused: 'neutral',
  ok: 'success', degraded: 'warning', down: 'danger',
  sev1: 'danger', sev2: 'warning', sev3: 'info', sev4: 'neutral',
  open: 'danger', monitoring: 'warning', resolved: 'success',
  implemented: 'success', partial: 'warning', planned: 'info', 'not-started': 'neutral', unknown: 'neutral', gap: 'danger',
  new: 'info', contacted: 'accent', qualified: 'accent', proposal: 'warning', won: 'success', lost: 'neutral',
  low: 'success', medium: 'warning', high: 'danger', evaluating: 'info', retired: 'neutral',
};
