// Tenant records: REST CRUD and sync push/pull share this code, so validation, access
// rules, history and audit are the same on both paths. Every function takes a TenantTx
// from db.withTenant(); queries also filter on tenant_id explicitly (RLS is the backstop).
import { randomUUID } from 'node:crypto';
import { AUDIT_COLLECTION, TABLE_COLLECTIONS, collectionDef, isCollection } from '../collections.js';
import { ApiError, badRequest, conflict, forbidden, notFound, tooLarge, validationFailed } from '../errors.js';
import { ENTRY_COORDS, canRead, canWrite, checkWriteRules, mergeWrite, redactForReader, reviewMerge, restoreHiddenFields, rowFilter, rowVisible, sanitizeForStorage } from '../auth/access.js';
import { appendAudit, auditRowToRecord, describeRecord } from './audit.js';
import { assertCollectionWritable, loadTenantPlan } from './entitlements.js';
import { afterTaskWrite } from './workplan-events.js';
import { assertCollectionModuleOn, loadModuleSettings } from './modules.js';
import { QBO_COLLECTIONS, qboAfterDelete, qboAfterWrite } from '../qbo/hooks.js';
import { readQboConfig } from '../qbo/env.js';
import { MONEY_RECORD_KEYS } from '../qbo/map/merge.js';
import { runWriteGuards } from './write-guards.js';

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const META_KEYS = ['id', 'version', 'changeSeq', 'deleted', 'tenantId'];
/** Client clocks may run ahead; anything later than now + this is treated as now. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
/** Rough byte budget for one sync pull page (big drawings are paged one at a time). */
const PULL_BYTE_BUDGET = 8 * 1024 * 1024;
export const MAX_PULL_LIMIT = 1000;
export const MAX_LIST_LIMIT = 500;

const actorString = (actor) => `${actor.type}:${actor.id ?? ''}`;

/** Key-order-independent JSON, to tell whether a merged write stored what the device sent. */
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v ?? null));

/** Per-collection follow-ups after a write, in the same transaction (notification hooks). */
async function afterWrite(tx, coll, id, before, after, who) {
  if (coll === 'workTasks') await afterTaskWrite(tx, { id, before, after, who });
}

/** The engine's own writes (QuickBooks sync, docs/integrations/quickbooks.md 5.7). */
const isQboWriter = (who) => who?.actor?.type === 'system' && who?.actor?.id === 'qbo';

/** The QBO hook's view of a writer: the audit actor plus the principal's kind, role and crew flag (5.2). */
const hookWho = (p, who) => ({ ...who, kind: p?.kind ?? null, role: p?.role ?? null, crew: Boolean(p?.crew) });

/** Record keys behind the money fields of a QuickBooks-synced collection (5.2, W2 MONEY_RECORD_KEYS). */
function moneyKeysOf(coll) {
  return new Set(Object.values(MONEY_RECORD_KEYS[coll] || {}).flat());
}
const STALE_SKIP_KEYS = new Set(['updatedAt', 'createdAt']);

function assertCollection(coll) {
  if (!isCollection(coll)) throw notFound('Unknown collection.');
}

function assertId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw badRequest('Record ids are 1-128 characters: letters, digits, . _ : -');
}

/** Effective edit time of a client timestamp: parsed, and never later than now + skew. */
function clientTime(value, now) {
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(t)) return now;
  return Math.min(t, now + MAX_CLOCK_SKEW_MS);
}

/**
 * Foremen see prices and costs only when the company allows it (settings.foremanSeesCosts).
 * Read that once per request, before any record is shown to the principal or written by it
 * (auth/access.js seesMoney). Everyone else is decided by role.
 */
export async function loadMoneyAccess(tx, p) {
  if (!p || typeof p.seesMoney === 'boolean' || p.kind !== 'session' || p.role !== 'foreman' || p.perms?.has?.('estimates')) return;
  const { rows } = await tx.query(
    "SELECT data->'foremanSeesCosts' AS f FROM settings WHERE tenant_id = $1 AND id = 'settings' AND deleted_at IS NULL", [tx.tenantId]);
  p.seesMoney = rows[0]?.f === true;
}

/**
 * Refusals worth listing on Books (docs/releases/r1-get-paid.md 2.6): who, what and why, never the
 * data. Rows older than 90 days go on every insert.
 */
export async function recordRejection(q, tenantId, { actor, deviceId = null, collection, recordId, code, message }) {
  await q.query(
    `INSERT INTO sync_rejections (tenant_id, actor, device_id, collection, record_id, code, message) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, String(actor || 'unknown').slice(0, 200), deviceId ? String(deviceId).slice(0, 128) : null, String(collection || '').slice(0, 64),
      String(recordId || '').slice(0, 128), String(code || 'rejected').slice(0, 64), message ? String(message).slice(0, 500) : null]);
  await q.query("DELETE FROM sync_rejections WHERE tenant_id = $1 AND at < now() - interval '90 days'", [tenantId]);
}

/** Codes from the Release 1 guards: a REST or system write refused with one of these is recorded too. */
const GUARD_CODES = new Set(['period_locked', 'payroll_locked', 'signature_invalid', 'document_signed', 'exemption_required', 'closeout_required', 'duplicate_code', 'duplicate_rule']);

function rowTime(row) {
  if (row.deleted_at) return new Date(row.deleted_at).getTime();
  const t = Date.parse(row.data?.updatedAt);
  return Number.isFinite(t) ? t : new Date(row.updated_at).getTime();
}

/**
 * @param {{ validator: ReturnType<import('../schemas.js').createValidator> }} deps
 */
export function createRecords({ validator, config = null, db = null }) {
  const toRecord = (row) => ({ ...row.data, id: row.id, version: row.version });

  /**
   * The Release 1 guards (services/write-guards.js) for a REST or system write. A refusal is listed
   * on Books in its own transaction (the caller's rolls back), when this service was given the db.
   */
  async function guard(tx, p, coll, id, before, after, who) {
    try {
      return await runWriteGuards(tx, p, coll, before, after, who, { id });
    } catch (e) {
      if (db && e instanceof ApiError && GUARD_CODES.has(e.code)) {
        const ctx = { tenantId: tx.tenantId, userId: tx.userId || null };
        await db.withTenant(ctx, (t2) => recordRejection(t2, tx.tenantId, { actor: actorString(who.actor), collection: coll, recordId: id, code: e.code, message: e.message }))
          .catch(() => {});
      }
      throw e;
    }
  }

  // QuickBooks (docs/integrations/quickbooks.md 5.2): off unless the server's QBO_ENVIRONMENT and app
  // credentials are set; then the hook runs no query at all.
  const qboOn = config ? Boolean(config.qbo?.enabled) : null;
  const qboEnabled = () => (qboOn ?? Boolean(readQboConfig(process.env).enabled));
  const qboWrite = (tx, coll, id, before, after, p, who, opts = {}) =>
    qboAfterWrite(tx, coll, id, before, after, hookWho(p, who), { ...opts, enabled: qboEnabled() });
  const qboDelete = (tx, coll, id, before, p, who, opts = {}) =>
    qboAfterDelete(tx, coll, id, before, hookWho(p, who), { ...opts, enabled: qboEnabled() });
  async function hasQboConnection(tx) {
    const { rows } = await tx.query('SELECT 1 FROM qbo_connections WHERE tenant_id = $1', [tx.tenantId]);
    return rows.length > 0;
  }
  const view = (p, coll, row) => redactForReader(p, coll, toRecord(row));

  /**
   * Build the stored body: strip meta keys and server-never-stored fields, default the
   * timestamps, validate against the collection's JSON Schema and size limit.
   */
  function prepare(coll, id, body, existingData, now) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw validationFailed('The record must be a JSON object.');
    const data = { ...body };
    for (const k of META_KEYS) delete data[k];
    const nowIso = new Date(now).toISOString();
    data.createdAt = typeof existingData?.createdAt === 'string' ? existingData.createdAt
      : (typeof data.createdAt === 'string' && data.createdAt ? data.createdAt : nowIso);
    const edited = clientTime(data.updatedAt, now);
    data.updatedAt = typeof data.updatedAt === 'string' && Date.parse(data.updatedAt) === edited ? data.updatedAt : new Date(edited).toISOString();
    const clean = sanitizeForStorage(coll, data);
    const errors = validator.validate(coll, { ...clean, id });
    if (errors) throw validationFailed(`The ${coll} record is not valid.`, { errors });
    const bytes = Buffer.byteLength(JSON.stringify(clean));
    const max = collectionDef(coll).maxBytes;
    if (bytes > max) throw tooLarge(`The ${coll} record is ${bytes} bytes; the limit is ${max}.`);
    return clean;
  }

  async function lockRow(tx, def, id) {
    const { rows } = await tx.query(
      `SELECT id, data, version, change_seq, created_at, updated_at, deleted_at FROM ${def.table} WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tx.tenantId, id]);
    return rows[0] || null;
  }

  async function insertRow(tx, def, id, data, who) {
    const { rows } = await tx.query(
      `INSERT INTO ${def.table} (tenant_id, id, data, created_by, updated_by) VALUES ($1, $2, $3, $4, $4)
       RETURNING id, data, version, change_seq`,
      [tx.tenantId, id, data, actorString(who.actor)]);
    return rows[0];
  }

  async function updateRow(tx, def, id, data, who) {
    const { rows } = await tx.query(
      `UPDATE ${def.table} SET data = $3, deleted_at = NULL, updated_by = $4 WHERE tenant_id = $1 AND id = $2
       RETURNING id, data, version, change_seq`,
      [tx.tenantId, id, data, actorString(who.actor)]);
    return rows[0];
  }

  async function softDeleteRow(tx, def, id, who) {
    const { rows } = await tx.query(
      `UPDATE ${def.table} SET deleted_at = now(), updated_by = $3 WHERE tenant_id = $1 AND id = $2
       RETURNING id, data, version, change_seq`,
      [tx.tenantId, id, actorString(who.actor)]);
    return rows[0];
  }

  async function keepHistory(tx, coll, id, { version, deleted, data }, reason, who, mid) {
    // Raw location points are never copied into history (retention must be able to remove them),
    // and history copies of time entries leave the clock-in/out coordinates out for the same reason.
    if (collectionDef(coll)?.rls === 'employee') return;
    if (coll === 'timeEntries' && data) { data = { ...data }; for (const k of ENTRY_COORDS) delete data[k]; }
    await tx.query(
      `INSERT INTO record_history (tenant_id, collection, record_id, version, deleted, data, reason, mid, actor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [tx.tenantId, coll, id, version ?? null, Boolean(deleted), data ?? null, reason, mid ?? null, actorString(who.actor)]);
  }

  function audit(tx, who, action, coll, id, data, meta) {
    return appendAudit(tx, tx.tenantId, {
      actor: who.actor, action, collection: coll, recordId: id, summary: describeRecord({ ...data, id }), meta, request: who.request,
    });
  }

  // Plan entitlements: writes into a collection whose module is not in the company's plan
  // are refused (feature_not_in_plan); reads stay open. Loaded once per transaction, so a
  // sync push of 500 mutations reads the plan once.
  const planCache = new WeakMap();
  // Module switches (Settings → Modules): writes into a turned-off module are refused
  // (module_turned_off); reads stay open. Cached per transaction like the plan, and dropped when
  // the transaction writes settings, so a push that turns a module back on can then write to it.
  const moduleCache = new WeakMap();
  async function assertPlanAllows(tx, p, coll) {
    if (!planCache.has(tx)) planCache.set(tx, await loadTenantPlan(tx, tx.tenantId));
    assertCollectionWritable(planCache.get(tx), coll, p);
    if (coll === 'settings') { moduleCache.delete(tx); return; }
    if (!moduleCache.has(tx)) moduleCache.set(tx, await loadModuleSettings(tx));
    assertCollectionModuleOn(moduleCache.get(tx), coll);
  }

  function checkRules(p, coll, existing, next) {
    const msg = checkWriteRules(p, coll, existing, next);
    if (!msg) return;
    // Release 1 rules may answer with their own status and code (422 exemption_required...).
    if (typeof msg === 'object') throw new ApiError(msg.status || 403, msg.code || 'forbidden', msg.message, msg.details);
    throw forbidden(msg);
  }

  /** Is this existing row visible to the principal? (own-rows filter) */
  function visible(p, coll, row) {
    return rowVisible(rowFilter(p, coll), row.data, collectionDef(coll));
  }

  /** SQL for a row filter's hidden values (e.g. a worker's draft tasks); pushes its parameter. */
  function excludeSql(f, params) {
    if (!f?.exclude) return '';
    params.push(f.exclude.values);
    return ` AND (${f.exclude.column} IS NULL OR ${f.exclude.column} <> ALL($${params.length}::text[]))`;
  }

  // ---- reads ---------------------------------------------------------------

  async function getRecord(tx, p, coll, id) {
    await loadMoneyAccess(tx, p);
    assertCollection(coll);
    if (!canRead(p, coll)) throw forbidden(`You cannot read ${coll}.`);
    if (coll === AUDIT_COLLECTION) {
      if (!/^\d{1,18}$/.test(String(id))) throw notFound();
      const { rows } = await tx.query('SELECT * FROM audit_events WHERE tenant_id = $1 AND seq = $2', [tx.tenantId, id]);
      if (!rows[0]) throw notFound();
      return auditRowToRecord(rows[0]);
    }
    assertId(id);
    const def = collectionDef(coll);
    const { rows } = await tx.query(
      `SELECT id, data, version FROM ${def.table} WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`, [tx.tenantId, id]);
    if (!rows[0] || !visible(p, coll, rows[0])) throw notFound();
    return view(p, coll, rows[0]);
  }

  function decodeCursor(cursor) {
    if (cursor == null || cursor === '') return null;
    try {
      const c = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
      if (typeof c?.c === 'string' && typeof c?.i === 'string' && !Number.isNaN(Date.parse(c.c))) return c;
    } catch { /* fall through */ }
    throw badRequest('Invalid cursor.');
  }
  const encodeCursor = (c) => Buffer.from(JSON.stringify(c)).toString('base64url');

  /**
   * @param {{ limit?: number, cursor?: string, filters?: Record<string, string>, includeDeleted?: boolean }} q
   */
  async function listRecords(tx, p, coll, q = {}) {
    await loadMoneyAccess(tx, p);
    assertCollection(coll);
    if (!canRead(p, coll)) throw forbidden(`You cannot read ${coll}.`);
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), MAX_LIST_LIMIT);
    if (coll === AUDIT_COLLECTION) return listAudit(tx, q, limit);
    const def = collectionDef(coll);
    const params = [tx.tenantId];
    const where = ['tenant_id = $1'];
    if (!q.includeDeleted) where.push('deleted_at IS NULL');
    for (const g of def.gen) {
      const v = q.filters?.[g.field];
      if (v !== undefined) { params.push(String(v)); where.push(`${g.col} = $${params.length}`); }
    }
    const f = rowFilter(p, coll);
    if (f) {
      if (f.value == null) return { data: [], cursor: null, more: false };
      params.push(f.value); where.push(`${f.column} = $${params.length}${excludeSql(f, params)}`);
    }
    const cur = decodeCursor(q.cursor);
    if (cur) {
      params.push(cur.c, cur.i);
      where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length})`);
    }
    params.push(limit + 1);
    const { rows } = await tx.query(
      `SELECT id, data, version, deleted_at,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_key
         FROM ${def.table} WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params);
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      data: page.map((r) => (r.deleted_at ? { id: r.id, version: r.version, deleted: true } : view(p, coll, r))),
      cursor: more && last ? encodeCursor({ c: last.created_key, i: last.id }) : null,
      more,
    };
  }

  async function listAudit(tx, q, limit) {
    const params = [tx.tenantId];
    const where = ['tenant_id = $1'];
    if (q.cursor) {
      if (!/^\d{1,18}$/.test(String(q.cursor))) throw badRequest('Invalid cursor.');
      params.push(q.cursor); where.push(`seq < $${params.length}`);
    }
    for (const [field, col] of [['collection', 'collection'], ['recordId', 'record_id'], ['action', 'action']]) {
      const v = q.filters?.[field];
      if (v !== undefined) { params.push(String(v)); where.push(`${col} = $${params.length}`); }
    }
    params.push(limit + 1);
    const { rows } = await tx.query(
      `SELECT * FROM audit_events WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT $${params.length}`, params);
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    return { data: page.map(auditRowToRecord), cursor: more ? String(page[page.length - 1].seq) : null, more };
  }

  // ---- REST writes ---------------------------------------------------------

  async function createRecord(tx, p, coll, body, who) {
    await loadMoneyAccess(tx, p);
    assertCollection(coll);
    if (!canWrite(p, coll)) throw forbidden(`You cannot change ${coll}.`);
    await assertPlanAllows(tx, p, coll);
    const def = collectionDef(coll);
    const id = body?.id ?? randomUUID();
    assertId(id);
    if (await lockRow(tx, def, id)) throw conflict('A record with this id already exists.');
    let data = restoreHiddenFields(p, coll, null, prepare(coll, id, body, null, Date.now()));
    checkRules(p, coll, null, data);
    data = await guard(tx, p, coll, id, null, data, who);
    const row = await insertRow(tx, def, id, data, who);
    await audit(tx, who, 'record.create', coll, id, data, { via: 'rest' });
    await afterWrite(tx, coll, id, null, data, who);
    await qboWrite(tx, coll, id, null, data, p, who);
    return view(p, coll, row);
  }

  async function patchRecord(tx, p, coll, id, patch, opts, who) {
    await loadMoneyAccess(tx, p);
    assertCollection(coll);
    if (!canWrite(p, coll)) throw forbidden(`You cannot change ${coll}.`);
    await assertPlanAllows(tx, p, coll);
    assertId(id);
    const def = collectionDef(coll);
    const cur = await lockRow(tx, def, id);
    if (!cur || cur.deleted_at || !visible(p, coll, cur)) throw notFound();
    if (opts?.ifVersion != null && Number(opts.ifVersion) !== cur.version) {
      throw new ApiError(409, 'version_conflict', `The record changed (version ${cur.version}).`, { version: cur.version });
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw validationFailed('The patch must be a JSON object.');
    const merged = { ...cur.data, ...patch };
    if (patch.updatedAt === undefined) delete merged.updatedAt;
    let data = restoreHiddenFields(p, coll, cur.data, prepare(coll, id, merged, cur.data, Date.now()));
    checkRules(p, coll, cur.data, data);
    data = await guard(tx, p, coll, id, cur.data, data, who);
    // A QuickBooks pull keeps the version it replaced, so a device editing that version can still
    // tell which fields it changed (stale-write field merge, docs/integrations/quickbooks.md 5.2).
    if (isQboWriter(who)) await keepHistory(tx, coll, id, { version: cur.version, deleted: false, data: cur.data }, 'overwritten', who, null);
    const row = await updateRow(tx, def, id, data, who);
    await audit(tx, who, 'record.update', coll, id, data, { via: 'rest', fields: Object.keys(patch).slice(0, 30) });
    await afterWrite(tx, coll, id, cur.data, data, who);
    await qboWrite(tx, coll, id, cur.data, data, p, who);
    return view(p, coll, row);
  }

  async function deleteRecord(tx, p, coll, id, opts, who) {
    assertCollection(coll);
    if (!canWrite(p, coll)) throw forbidden(`You cannot change ${coll}.`);
    await assertPlanAllows(tx, p, coll);
    assertId(id);
    const def = collectionDef(coll);
    const cur = await lockRow(tx, def, id);
    if (!cur || cur.deleted_at || !visible(p, coll, cur)) throw notFound();
    if (opts?.ifVersion != null && Number(opts.ifVersion) !== cur.version) {
      throw new ApiError(409, 'version_conflict', `The record changed (version ${cur.version}).`, { version: cur.version });
    }
    checkRules(p, coll, cur.data, null);
    await guard(tx, p, coll, id, cur.data, null, who);
    if (isQboWriter(who)) await keepHistory(tx, coll, id, { version: cur.version, deleted: false, data: cur.data }, 'overwritten', who, null);
    const row = await softDeleteRow(tx, def, id, who);
    await audit(tx, who, 'record.delete', coll, id, cur.data, { via: 'rest' });
    await qboDelete(tx, coll, id, cur.data, p, who);
    return { id, version: row.version, deleted: true };
  }

  /**
   * Undo a soft delete (the QuickBooks sync puts back a record whose delete QuickBooks refused,
   * docs/integrations/quickbooks.md 4.7). The stored body is unchanged; the version moves on.
   */
  async function restoreRecord(tx, p, coll, id, who) {
    await loadMoneyAccess(tx, p);
    assertCollection(coll);
    if (!canWrite(p, coll)) throw forbidden(`You cannot change ${coll}.`);
    await assertPlanAllows(tx, p, coll);
    assertId(id);
    const def = collectionDef(coll);
    const cur = await lockRow(tx, def, id);
    if (!cur || !visible(p, coll, cur)) throw notFound();
    if (!cur.deleted_at) return view(p, coll, cur);
    checkRules(p, coll, null, cur.data);
    const data = await guard(tx, p, coll, id, null, cur.data, who);
    const row = await updateRow(tx, def, id, data, who);
    await audit(tx, who, 'record.restore', coll, id, data, { via: 'rest' });
    await afterWrite(tx, coll, id, null, data, who);
    await qboWrite(tx, coll, id, null, data, p, who);
    return view(p, coll, row);
  }

  // ---- sync ----------------------------------------------------------------

  function checkMutationShape(m) {
    if (!m || typeof m !== 'object') return 'A mutation must be an object.';
    if (typeof m.mid !== 'string' || m.mid.length < 1 || m.mid.length > 128) return 'mid must be a string of 1-128 characters.';
    if (!isCollection(m.collection)) return 'Unknown collection.';
    if (m.op !== 'upsert' && m.op !== 'delete') return "op must be 'upsert' or 'delete'.";
    if (typeof m.id !== 'string' || !ID_RE.test(m.id)) return 'id must be 1-128 characters: letters, digits, . _ : -';
    if (m.baseVersion != null && !(Number.isInteger(m.baseVersion) && m.baseVersion >= 0)) return 'baseVersion must be a non-negative integer or null.';
    if (m.op === 'upsert' && (!m.data || typeof m.data !== 'object' || Array.isArray(m.data))) return 'upsert needs a data object.';
    if (m.fields != null && !(Array.isArray(m.fields) && m.fields.length <= 200 && m.fields.every((f) => typeof f === 'string' && f.length >= 1 && f.length <= 64))) return 'fields must be a list of field names or null.';
    return null;
  }

  const serverView = (p, coll, row) => ({
    id: row.id, version: row.version, deleted: Boolean(row.deleted_at), data: row.deleted_at ? null : view(p, coll, row),
  });

  async function applyMutation(tx, p, m, who) {
    const coll = m.collection;
    const meta = { via: 'sync', mid: m.mid };

    if (coll === AUDIT_COLLECTION) {
      // The PWA's own log entries (sign-ins on a device, exports...). Appended, never edited.
      if (m.op !== 'upsert') throw forbidden('Audit entries cannot be deleted.');
      if (p.kind === 'api_key' && !canWrite(p, AUDIT_COLLECTION)) throw forbidden('This key cannot write auditLog.');
      const d = m.data;
      const errors = validator.validate(AUDIT_COLLECTION, { ...d, id: m.id });
      if (errors) throw validationFailed('The auditLog entry is not valid.', { errors });
      await appendAudit(tx, tx.tenantId, {
        actor: who.actor, action: `client.${String(d.action || 'event').slice(0, 60)}`, collection: d.collection ?? null,
        recordId: d.recordId ?? null, summary: d.summary ?? null, meta: { ...meta, clientId: m.id, clientAt: d.at ?? null }, request: who.request,
      });
      return { mid: m.mid, status: 'ok', version: 1, changeSeq: null };
    }

    if (!canWrite(p, coll)) throw forbidden(`You cannot change ${coll}.`);
    await assertPlanAllows(tx, p, coll);
    const def = collectionDef(coll);
    const now = Date.now();
    const cur = await lockRow(tx, def, m.id);

    if (m.op === 'upsert') {
      let data = restoreHiddenFields(p, coll, cur && !cur.deleted_at ? cur.data : null, prepare(coll, m.id, m.data, cur && !cur.deleted_at ? cur.data : null, now));
      if (!cur) {
        checkRules(p, coll, null, data);
        data = await runWriteGuards(tx, p, coll, null, data, who, { id: m.id });
        const row = await insertRow(tx, def, m.id, data, who);
        await audit(tx, who, 'record.create', coll, m.id, data, meta);
        await afterWrite(tx, coll, m.id, null, data, who);
        await qboWrite(tx, coll, m.id, null, data, p, who);
        return { mid: m.mid, status: 'ok', version: row.version, changeSeq: row.change_seq };
      }
      // Collections that merge (work tasks, drawings from an app that tracks deletions): field
      // groups or items resolve on their own, so an offline completion and a foreman's edit made
      // meanwhile both survive. Never a whole-record loss.
      // A time entry reviewed or approved on an older copy takes only those fields.
      const fresh = m.baseVersion === cur.version;
      const mergedData = !cur.deleted_at ? (mergeWrite(p, coll, cur.data, data, { itemMerge: m.itemMerge === true, stale: !fresh }) || (!fresh ? reviewMerge(coll, cur.data, data, m.fields) : null)) : null;
      if (mergedData) {
        let stored = prepare(coll, m.id, mergedData, cur.data, now);
        checkRules(p, coll, cur.data, stored);
        stored = await runWriteGuards(tx, p, coll, cur.data, stored, who, { id: m.id });
        if (!fresh) await keepHistory(tx, coll, m.id, { version: cur.version, deleted: false, data: cur.data }, 'overwritten', who, m.mid);
        const row = await updateRow(tx, def, m.id, stored, who);
        await audit(tx, who, 'record.update', coll, m.id, stored, fresh ? meta : { ...meta, conflict: 'merged' });
        await afterWrite(tx, coll, m.id, cur.data, stored, who);
        await qboWrite(tx, coll, m.id, cur.data, stored, p, who, { stale: !fresh });
        // The device's copy differs from what is stored now: answer as a conflict so it takes
        // the stored copy (with nothing lost: its own changes are in it).
        if (canon(stored) !== canon(data)) return { mid: m.mid, status: 'conflict', server: serverView(p, coll, row) };
        return { mid: m.mid, status: 'ok', version: row.version, changeSeq: row.change_seq };
      }
      // A stale write to a QuickBooks-synced record: the fields the device changed are stored over
      // the server copy, and a money value a QuickBooks pull changed meanwhile is held for a
      // conflict instead of being applied (docs/integrations/quickbooks.md 5.2, 5.10).
      if (!fresh && !cur.deleted_at && QBO_COLLECTIONS.includes(coll) && qboEnabled() && await hasQboConnection(tx)) {
        const q = await qboStaleMerge(tx, coll, m, cur, data, now);
        if (q) {
          let stored = prepare(coll, m.id, q.merged, cur.data, now);
          checkRules(p, coll, cur.data, stored);
          stored = await runWriteGuards(tx, p, coll, cur.data, stored, who, { id: m.id });
          await keepHistory(tx, coll, m.id, { version: cur.version, deleted: false, data: cur.data }, 'overwritten', who, m.mid);
          const row = await updateRow(tx, def, m.id, stored, who);
          await audit(tx, who, 'record.update', coll, m.id, stored, { ...meta, conflict: 'merged', ...(q.heldKeys.length ? { held: q.heldKeys } : {}) });
          await afterWrite(tx, coll, m.id, cur.data, stored, who);
          await qboWrite(tx, coll, m.id, cur.data, stored, p, who, { stale: true, held: q.held });
          if (canon(stored) !== canon(data)) return { mid: m.mid, status: 'conflict', server: serverView(p, coll, row) };
          return { mid: m.mid, status: 'ok', version: row.version, changeSeq: row.change_seq };
        }
      }
      checkRules(p, coll, cur.deleted_at ? null : cur.data, data);
      if (!fresh && clientTime(m.data.updatedAt, now) <= rowTime(cur)) {
        // Server copy is newer: it wins, the incoming change is kept in history.
        await keepHistory(tx, coll, m.id, { version: m.baseVersion, deleted: false, data }, 'rejected', who, m.mid);
        return { mid: m.mid, status: 'conflict', server: serverView(p, coll, cur) };
      }
      data = await runWriteGuards(tx, p, coll, cur.deleted_at ? null : cur.data, data, who, { id: m.id });
      if (!fresh) await keepHistory(tx, coll, m.id, { version: cur.version, deleted: Boolean(cur.deleted_at), data: cur.data }, 'overwritten', who, m.mid);
      const row = await updateRow(tx, def, m.id, data, who);
      await audit(tx, who, cur.deleted_at ? 'record.restore' : 'record.update', coll, m.id, data, fresh ? meta : { ...meta, conflict: 'client-won' });
      await afterWrite(tx, coll, m.id, cur.deleted_at ? null : cur.data, data, who);
      await qboWrite(tx, coll, m.id, cur.deleted_at ? null : cur.data, data, p, who, { stale: !fresh });
      return { mid: m.mid, status: 'ok', version: row.version, changeSeq: row.change_seq };
    }

    // delete
    if (!cur || cur.deleted_at) return { mid: m.mid, status: 'ok', version: cur?.version ?? null, changeSeq: cur?.change_seq ?? null };
    checkRules(p, coll, cur.data, null);
    const fresh = m.baseVersion === cur.version;
    const deleteAt = clientTime(m.data?.deletedAt ?? m.data?.updatedAt, now);
    if (!fresh && deleteAt < rowTime(cur)) {
      await keepHistory(tx, coll, m.id, { version: m.baseVersion, deleted: true, data: null }, 'rejected', who, m.mid);
      return { mid: m.mid, status: 'conflict', server: serverView(p, coll, cur) };
    }
    await runWriteGuards(tx, p, coll, cur.data, null, who, { id: m.id });
    if (!fresh) await keepHistory(tx, coll, m.id, { version: cur.version, deleted: false, data: cur.data }, 'overwritten', who, m.mid);
    const row = await softDeleteRow(tx, def, m.id, who);
    await audit(tx, who, 'record.delete', coll, m.id, cur.data, fresh ? meta : { ...meta, conflict: 'client-won' });
    await qboDelete(tx, coll, m.id, cur.data, p, who, { stale: !fresh });
    return { mid: m.mid, status: 'ok', version: row.version, changeSeq: row.change_seq };
  }

  /**
   * The stale-write field merge for QuickBooks-synced records (docs/integrations/quickbooks.md 5.2).
   * Changed fields: m.fields, else the keys where the device's copy differs from the record_history
   * row at its baseVersion (null when neither is known: the caller falls back to LWW). A money key
   * that a QuickBooks pull changed after baseVersion (qbo_links.meta.pulledKeys: the version each
   * key was last written by system:qbo) is held, not applied. The rest goes over the server copy.
   * @returns {Promise<{ merged: object, held: object, heldKeys: string[] } | null>}
   */
  async function qboStaleMerge(tx, coll, m, cur, data, now) {
    let changed = null;
    if (Array.isArray(m.fields) && m.fields.length) changed = m.fields.filter((f) => !META_KEYS.includes(f) && !STALE_SKIP_KEYS.has(f));
    else if (m.baseVersion != null) {
      const { rows } = await tx.query(
        `SELECT data FROM record_history WHERE tenant_id = $1 AND collection = $2 AND record_id = $3 AND version = $4 AND deleted = false AND data IS NOT NULL
          ORDER BY id DESC LIMIT 1`, [tx.tenantId, coll, m.id, m.baseVersion]);
      const base = rows[0]?.data;
      if (base) {
        const keys = new Set([...Object.keys(base), ...Object.keys(data)]);
        changed = [...keys].filter((k) => !META_KEYS.includes(k) && !STALE_SKIP_KEYS.has(k) && canon(base[k]) !== canon(data[k]));
      }
    }
    if (!changed) return null;
    const link = (await tx.query(
      "SELECT meta FROM qbo_links WHERE tenant_id = $1 AND collection = $2 AND record_id = $3 AND role = 'main'", [tx.tenantId, coll, m.id])).rows[0];
    const pulled = link?.meta?.pulledKeys && typeof link.meta.pulledKeys === 'object' ? link.meta.pulledKeys : {};
    const money = moneyKeysOf(coll);
    const held = {};
    const merged = { ...cur.data };
    for (const k of changed) {
      if (money.has(k) && Number(pulled[k] || 0) > Number(m.baseVersion ?? -1) && canon(cur.data[k]) !== canon(data[k])) {
        held[k] = data[k] === undefined ? null : data[k];
        continue;
      }
      if (k in data) merged[k] = data[k]; else delete merged[k];
    }
    const t = (iso) => Date.parse(iso) || 0;
    merged.updatedAt = clientTime(data.updatedAt, now) >= t(cur.data.updatedAt) ? data.updatedAt : cur.data.updatedAt;
    return { merged, held, heldKeys: Object.keys(held) };
  }

  /**
   * Apply a batch of mutations in order. Each runs in a savepoint: one rejected
   * mutation does not undo the others. Results are stored by mid, so a replayed
   * mutation returns its first result without being applied twice.
   */
  async function push(tx, p, mutations, who) {
    await loadMoneyAccess(tx, p);
    const results = [];
    for (const m of mutations) {
      const shapeError = checkMutationShape(m);
      if (shapeError) {
        results.push({ mid: typeof m?.mid === 'string' ? m.mid : null, status: 'rejected', error: { code: 'bad_mutation', message: shapeError } });
        continue;
      }
      const prev = await tx.query('SELECT result FROM sync_mutations WHERE tenant_id = $1 AND mid = $2', [tx.tenantId, m.mid]);
      if (prev.rows[0]) { results.push(prev.rows[0].result); continue; }
      let result;
      try {
        result = await tx.savepoint(() => applyMutation(tx, p, m, who));
      } catch (e) {
        if (e instanceof ApiError) {
          result = { mid: m.mid, status: 'rejected', error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } };
        } else if (typeof e?.code === 'string' && /^(22|23)/.test(e.code)) {
          result = { mid: m.mid, status: 'rejected', error: { code: 'invalid_record', message: 'The database refused this record.' } };
        } else {
          throw e;
        }
      }
      await tx.query(
        'INSERT INTO sync_mutations (tenant_id, mid, collection, record_id, result) VALUES ($1, $2, $3, $4, $5)',
        [tx.tenantId, m.mid, m.collection, m.id, result]);
      // Refused writes are listed on Books (who, what and why; never the data).
      if (result.status === 'rejected' && m.collection !== AUDIT_COLLECTION) {
        await recordRejection(tx, tx.tenantId, { actor: actorString(who.actor), deviceId: who.deviceId || null, collection: m.collection, recordId: m.id, code: result.error.code, message: result.error.message });
      }
      results.push(result);
    }
    return results;
  }

  /**
   * Changes after `since` (a change_seq), oldest first, across every collection the
   * principal may read. Run in a REPEATABLE READ transaction.
   */
  async function pull(tx, p, { since, limit }) {
    await loadMoneyAccess(tx, p);
    const lim = Math.min(Math.max(Number(limit) || 500, 1), MAX_PULL_LIMIT);
    const parts = [];
    const params = [tx.tenantId, since, lim + 1];
    for (const coll of TABLE_COLLECTIONS) {
      if (!canRead(p, coll)) continue;
      const def = collectionDef(coll);
      let extra = '';
      const f = rowFilter(p, coll);
      if (f) {
        if (f.value == null) continue;
        params.push(f.value);
        extra = ` AND ${f.column} = $${params.length}`;
        extra += excludeSql(f, params);
      }
      parts.push(`(SELECT '${coll}'::text AS collection, id, change_seq, pg_column_size(data) AS size
                   FROM ${def.table} WHERE tenant_id = $1 AND change_seq > $2${extra}
                  ORDER BY change_seq LIMIT $3)`);
    }
    if (!parts.length) return { changes: [], cursor: String(since), more: false };
    const { rows } = await tx.query(`SELECT * FROM (${parts.join(' UNION ALL ')}) AS changes ORDER BY change_seq LIMIT $3`, params);

    const picked = [];
    let bytes = 0;
    for (const r of rows.slice(0, lim)) {
      if (picked.length && bytes + r.size > PULL_BYTE_BUDGET) break;
      picked.push(r);
      bytes += r.size;
    }
    const more = rows.length > picked.length;

    const byColl = new Map();
    for (const r of picked) {
      if (!byColl.has(r.collection)) byColl.set(r.collection, []);
      byColl.get(r.collection).push(r.id);
    }
    const full = new Map();
    for (const [coll, ids] of byColl) {
      const def = collectionDef(coll);
      const res = await tx.query(
        `SELECT id, data, version, change_seq, deleted_at FROM ${def.table} WHERE tenant_id = $1 AND id = ANY($2)`, [tx.tenantId, ids]);
      for (const row of res.rows) full.set(`${coll}\u0000${row.id}`, row);
    }
    const changes = picked.map((r) => {
      const row = full.get(`${r.collection}\u0000${r.id}`);
      const deleted = Boolean(row.deleted_at);
      return { collection: r.collection, id: r.id, version: row.version, deleted, data: deleted ? null : view(p, r.collection, row) };
    });
    const last = picked[picked.length - 1];
    return { changes, cursor: String(last ? last.change_seq : since), more };
  }

  return { getRecord, listRecords, createRecord, patchRecord, deleteRecord, restoreRecord, push, pull, prepare };
}
