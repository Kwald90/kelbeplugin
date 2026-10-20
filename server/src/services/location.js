// Location while clocked in, server side (docs/compliance/privacy.md, "Location while clocked in").
//
// - Retention: raw location points older than the company's retention period (settings.location.
//   retentionDays, default 90, 7..730) are emptied and soft-deleted, so devices drop them on their
//   next sync; time entries that old lose their clock-in/out coordinates (distances, flags and hours
//   stay). Runs daily in the worker, one company at a time, under the 'system' location scope.
// - Live crew map: only when the company turned it on, only for managers, only people clocked in
//   right now, only their latest point from the last 12 hours. Every view is audited.
import { appendAudit } from './audit.js';
import { enqueue } from './queue.js';
import { clampRetention, locationSettings } from '../../../electrical-app/js/lib/location-policy.js';

const SYSTEM = { type: 'system', id: 'retention', label: 'location retention' };
export const LIVE_MAX_AGE_HOURS = 12;

/** Run under one of the narrow location scopes (0140_location_access.sql). */
export const setLocationScope = (tx, scope) => tx.query("SELECT set_config('app.location_scope', $1, true)", [scope]);

/** The company's location settings (defaults filled in) inside a tenant transaction. */
export async function tenantLocationSettings(tx) {
  const { rows } = await tx.query("SELECT data FROM settings WHERE tenant_id = $1 AND id = 'settings' AND deleted_at IS NULL", [tx.tenantId]);
  return locationSettings(rows[0]?.data || {});
}

/**
 * Apply retention for one company. Returns { days, points, entries }.
 * @param {import('../db.js').TenantTx} tx
 */
export async function purgeTenantLocation(tx) {
  await setLocationScope(tx, 'system');
  const s = await tenantLocationSettings(tx);
  const days = clampRetention(s.retentionDays);
  const at = new Date().toISOString();
  const points = await tx.query(
    `UPDATE location_points SET data = jsonb_build_object('purgedAt', $3::text), deleted_at = COALESCE(deleted_at, now()), updated_by = 'system:retention'
      WHERE tenant_id = $1
        AND (data ? 'lat' OR data ? 'lng' OR data ? 'employeeId')
        AND COALESCE((data->>'at')::timestamptz, created_at) < now() - make_interval(days => $2)`,
    [tx.tenantId, days, at]);
  const entries = await tx.query(
    `UPDATE time_entries SET data = (data - 'clockInLoc' - 'clockOutLoc') || jsonb_build_object('locScrubbedAt', $3::text), updated_by = 'system:retention'
      WHERE tenant_id = $1
        AND (data ? 'clockInLoc' OR data ? 'clockOutLoc')
        AND COALESCE((NULLIF(data->>'clockIn', ''))::timestamptz, created_at) < now() - make_interval(days => $2)`,
    [tx.tenantId, days, at]);
  if (points.rowCount || entries.rowCount) {
    await appendAudit(tx, tx.tenantId, {
      actor: SYSTEM, action: 'location.retention', collection: 'locationPoints',
      summary: `Removed ${points.rowCount} location point${points.rowCount === 1 ? '' : 's'} and cleared coordinates on ${entries.rowCount} time entr${entries.rowCount === 1 ? 'y' : 'ies'} older than ${days} days`,
      meta: { days, points: points.rowCount, entries: entries.rowCount },
    });
  }
  return { days, points: points.rowCount, entries: entries.rowCount };
}

/** Worker job: retention for every company (RLS: one company per transaction). */
export async function purgeLocationAll(db) {
  const tenants = (await db.query('SELECT id FROM tenants')).rows;
  const out = { tenants: 0, points: 0, entries: 0 };
  for (const t of tenants) {
    const r = await db.withTenant({ tenantId: t.id }, (tx) => purgeTenantLocation(tx));
    out.tenants++; out.points += r.points; out.entries += r.entries;
  }
  return out;
}

export const LOCATION_HANDLERS = {
  location_retention: ({ db }) => purgeLocationAll(db),
};

/** Daily, deduplicated across workers. */
export function scheduleLocationJobs(db) {
  const tomorrow = new Date(Date.now() + 23 * 3600_000);
  return enqueue(db, { kind: 'location_retention', dedupeKey: 'location_retention', maxAttempts: 3, runAt: tomorrow });
}

/**
 * Latest point per person clocked in now (live crew map). Caller checks the role and the setting.
 * @returns {Promise<{ employeeId: string, at: string, lat: number, lng: number, accuracyM: number|null, timeEntryId: string|null, jobId: string|null, kind: string }[]>}
 */
export async function liveCrew(tx) {
  await setLocationScope(tx, 'crew');
  const { rows } = await tx.query(
    `SELECT DISTINCT ON (p.employee_id) p.employee_id, p.data, e.data AS entry, e.id AS entry_id
       FROM location_points p
       JOIN time_entries e ON e.tenant_id = p.tenant_id AND e.employee_id = p.employee_id AND e.deleted_at IS NULL
                          AND COALESCE(e.data->>'clockOut', '') = '' AND COALESCE(e.data->>'clockIn', '') <> ''
      WHERE p.tenant_id = $1 AND p.deleted_at IS NULL
        AND (p.data->>'at')::timestamptz > now() - make_interval(hours => $2)
        AND (p.data->>'at')::timestamptz >= NULLIF(e.data->>'clockIn', '')::timestamptz - interval '5 minutes'
      ORDER BY p.employee_id, (p.data->>'at')::timestamptz DESC`,
    [tx.tenantId, LIVE_MAX_AGE_HOURS]);
  // Back to the member's own scope for anything else in this transaction.
  await setLocationScope(tx, '');
  return rows.map((r) => ({
    employeeId: r.employee_id, at: r.data.at, lat: r.data.lat, lng: r.data.lng, accuracyM: r.data.accuracyM ?? null,
    timeEntryId: r.entry_id, jobId: r.entry?.jobId ?? null, kind: r.entry?.kind === 'travel' ? 'travel' : 'work',
  }));
}
