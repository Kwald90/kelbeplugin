// The tenant's QuickBooks sync log (docs/integrations/quickbooks.md 3.2 qbo_sync_log, 5.8, 7.5).
// Office users read it; HQ sees only the columns granted to it (no label, no message, no record id).
// Messages are Intuit's detail after scrub (W1's QboError.detail is already name-scrubbed) or text
// the engine writes itself; nothing here ever leaves the tenant (job errors carry fixed text only).
import { scrub } from '../integrations/http.js';

const ACTION_RE = /^[a-z_]{2,40}$/;
const OUTCOMES = new Set(['ok', 'skipped', 'conflict', 'error', 'warning', 'info', 'shadow']);
const DIRECTIONS = new Set(['push', 'pull', 'system']);
const ACTORS = new Set(['user', 'field_user', 'api_key', 'agent', 'stripe', 'system', 'sweep']);

/** Log actions that write to either side; the safety brake counts them per rolling hour (5.8). */
export const WRITE_ACTIONS = ['create', 'update', 'delete', 'void', 'deactivate', 'tax_override', 'pull_create', 'pull_update', 'pull_delete', 'settlement'];

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

/**
 * One log row.
 * @param {{ query: Function, tenantId: string }} tx
 * @param {{ direction: 'push'|'pull'|'system', outcome: string, action: string, actorType?: string|null, collection?: string|null,
 *   recordId?: string|null, qboEntity?: string|null, label?: string|null, message?: string|null, errorCode?: string|null, intuitTid?: string|null }} e
 */
export async function writeLog(tx, e) {
  const action = ACTION_RE.test(String(e.action || '')) ? e.action : 'other';
  await tx.query(
    `INSERT INTO qbo_sync_log (tenant_id, direction, outcome, action, actor_type, collection, record_id, qbo_entity, label, message, error_code, intuit_tid)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [tx.tenantId, DIRECTIONS.has(e.direction) ? e.direction : 'system', OUTCOMES.has(e.outcome) ? e.outcome : 'info', action,
      ACTORS.has(e.actorType) ? e.actorType : null, clip(e.collection, 40), clip(e.recordId, 128), clip(e.qboEntity, 40), clip(e.label, 200),
      e.message == null ? null : scrub(String(e.message), 500), clip(e.errorCode, 60), clip(e.intuitTid, 100)]);
}

/**
 * A shadow-mode "would change" row (5.8), written at most once a day for the same change, since
 * nothing moves in shadow and every pass would otherwise log it again.
 */
export async function writeShadowLog(tx, e) {
  const { rows } = await tx.query(
    `SELECT 1 FROM qbo_sync_log WHERE tenant_id = $1 AND outcome = 'shadow' AND action = $2 AND collection IS NOT DISTINCT FROM $3
        AND record_id IS NOT DISTINCT FROM $4 AND message IS NOT DISTINCT FROM $5 AND at > now() - interval '1 day' LIMIT 1`,
    [tx.tenantId, e.action, clip(e.collection, 40), clip(e.recordId, 128), e.message == null ? null : scrub(String(e.message), 500)]);
  if (rows.length) return false;
  await writeLog(tx, { ...e, outcome: 'shadow' });
  return true;
}

/** Writes logged in the last hour (the safety brake's count, 5.8). */
export async function writesLastHour(tx) {
  const { rows } = await tx.query(
    `SELECT count(*)::int AS n FROM qbo_sync_log WHERE tenant_id = $1 AND outcome = 'ok' AND action = ANY($2) AND at > now() - interval '1 hour'`,
    [tx.tenantId, WRITE_ACTIONS]);
  return rows[0].n;
}

/** A short label for log rows and conflicts: "Invoice INV-3001", "Client Dana Smith". */
export function recordLabel(collection, record) {
  const r = record || {};
  const word = {
    clients: 'Client', jobs: 'Job', items: 'Item', vendors: 'Supplier', estimates: 'Estimate', invoices: 'Invoice', payments: 'Payment',
    bills: r.kind === 'receipt' ? 'Receipt' : 'Bill', purchaseOrders: 'Purchase order', timeEntries: 'Time entry', stripePayouts: 'Stripe payout', employees: 'Employee',
  }[collection] || collection;
  const name = r.number || r.name || r.title || (collection === 'payments' && Number.isInteger(r.amountCents) ? `$${(r.amountCents / 100).toFixed(2)}` : null)
    || r.payout_id || (collection === 'timeEntries' && r.clockIn ? String(r.clockIn).slice(0, 10) : null) || r.id || '';
  return `${word} ${String(name)}`.trim().slice(0, 200);
}

/** The API shape of a log row (7.5 LogEntry). */
export function logEntry(row) {
  return {
    id: String(row.id), at: row.at instanceof Date ? row.at.toISOString() : row.at, direction: row.direction, outcome: row.outcome,
    action: row.action, actorType: row.actor_type, collection: row.collection, recordId: row.record_id, label: row.label,
    message: row.message, errorCode: row.error_code, intuitTid: row.intuit_tid,
  };
}

/** Intuit's scrubbed detail for a link's last_error and the log (never Intuit's raw text). */
export function errorText(e) {
  if (!e) return null;
  const detail = e.detail ? String(e.detail) : null;
  return scrub(detail ? `${e.message} ${detail}` : String(e.message || e), 500, { names: true });
}
