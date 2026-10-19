// Audit events. Every write (REST, sync, auth, HQ, agents) appends one row to
// audit_events; the database assigns seq/at/prev_hash/hash (migrations/0002_audit.sql).

/**
 * @typedef {object} Actor
 * @property {'user'|'api_key'|'agent'|'system'|'hq'} type
 * @property {string|null} id
 * @property {string|null} [label]
 */

/**
 * @typedef {object} AuditEvent
 * @property {Actor} actor
 * @property {string} action           e.g. record.create, auth.login, auth.login_failed
 * @property {string|null} [collection]
 * @property {string|null} [recordId]
 * @property {string|null} [summary]
 * @property {object|null} [meta]
 * @property {{ ip?: string, userAgent?: string, requestId?: string }} [request]
 */

const clip = (s, n) => (s == null ? null : String(s).slice(0, n));

/**
 * Append an event. Pass a TenantTx (tenant chain) or a platform client plus tenantId null.
 * No RETURNING: platform rows are not readable by the app role.
 * @param {{ query: Function }} q TenantTx or pg client
 * @param {string|null} tenantId
 * @param {AuditEvent} e
 */
export async function appendAudit(q, tenantId, e) {
  await q.query(
    `INSERT INTO audit_events (tenant_id, actor_type, actor_id, actor_label, action, collection, record_id, summary, ip, user_agent, request_id, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      tenantId, e.actor.type, clip(e.actor.id, 200), clip(e.actor.label, 200), clip(e.action, 100),
      clip(e.collection, 60), clip(e.recordId, 200), clip(e.summary, 500),
      clip(e.request?.ip, 100), clip(e.request?.userAgent, 300), clip(e.request?.requestId, 100),
      e.meta ? JSON.stringify(e.meta) : null,
    ],
  );
}

/** Request facts worth keeping in the audit log. */
export function requestFacts(request) {
  if (!request) return {};
  return { ip: request.ip, userAgent: request.headers?.['user-agent'], requestId: request.id };
}

/** Short human summary for a record, like store.js describe(). */
export function describeRecord(r) {
  if (!r) return '';
  return String(r.number || r.name || r.title || r.description || r.id || '').slice(0, 80);
}

/** Map an audit_events row to the PWA's auditLog record shape. */
export function auditRowToRecord(row) {
  return {
    id: String(row.seq),
    at: row.at instanceof Date ? row.at.toISOString() : row.at,
    createdAt: row.at instanceof Date ? row.at.toISOString() : row.at,
    updatedAt: row.at instanceof Date ? row.at.toISOString() : row.at,
    userId: row.actor_id,
    actorType: row.actor_type,
    actorLabel: row.actor_label,
    action: row.action,
    collection: row.collection,
    recordId: row.record_id,
    summary: row.summary,
    requestId: row.request_id,
    hash: row.hash,
  };
}
