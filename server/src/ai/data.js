// Data access for AI tools. Everything runs inside the caller's withTenant transaction
// with the caller's principal: the same canRead/canWrite rules, own-row filters and
// field redaction as the REST API, so a tool can never see more than its user or key.
import { collectionDef, isCollection, AUDIT_COLLECTION } from '../collections.js';
import { ENTRY_COORDS, canRead, redactForReader, rowFilter } from '../auth/access.js';
import { forbidden, notFound, badRequest } from '../errors.js';
import { docTotals } from '../../../electrical-app/js/lib/money.js';

/**
 * The PWA's settings defaults (electrical-app/js/store.js DEFAULT_SETTINGS), repeated
 * here so the server does not import the browser data layer.
 */
export const DEFAULT_SETTINGS = {
  company: { name: 'Your company', phone: '', email: '', address: '', licenceNo: '', province: 'ON', gstHstNo: '', pstNo: '' },
  codeBook: 'CEC-2024',
  tax: { mode: 'province', treatment: null, custom: [] },
  taxPct: 13,
  labourRateCents: 9500,
  markupPct: 20,
  units: 'metric',
  currency: 'CAD',
  nextNumbers: { job: 1001, estimate: 2001, invoice: 3001 },
};

/** Collections the chat assistant may look things up in (no drawings, wire-run photos or audit log). */
export const ASSISTANT_COLLECTIONS = ['clients', 'leads', 'jobs', 'schedule', 'estimates', 'invoices', 'payments', 'items', 'locations',
  'stockMoves', 'employees', 'timeEntries', 'permits', 'inspections', 'certifications', 'panels', 'checklists', 'sops'];

const MAX_STRING = 4000;
const MAX_ARRAY = 200;

/**
 * A copy that is safe and small enough to hand to a model: data URLs (drawing underlays,
 * photos) and huge strings are cut, long arrays are capped.
 */
export function compact(value, depth = 0) {
  if (typeof value === 'string') {
    if (value.startsWith('data:') && value.length > 200) return '[image or file data omitted]';
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… [truncated]` : value;
  }
  if (Array.isArray(value)) {
    const arr = value.slice(0, MAX_ARRAY).map((v) => compact(v, depth + 1));
    if (value.length > MAX_ARRAY) arr.push(`[${value.length - MAX_ARRAY} more omitted]`);
    return arr;
  }
  if (value && typeof value === 'object') {
    if (depth > 8) return '[nested data omitted]';
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = compact(v, depth + 1);
    return out;
  }
  return value;
}

function assertReadable(p, coll) {
  if (!isCollection(coll) || coll === AUDIT_COLLECTION) throw badRequest('Unknown collection.');
  if (!canRead(p, coll)) throw forbidden(`You do not have access to ${coll}.`);
}

const visibleWhere = (p, coll, params) => {
  const f = rowFilter(p, coll);
  if (!f) return '';
  params.push(f.value);
  return ` AND ${f.column} = $${params.length}`;
};

// Clock-in coordinates never go to the AI provider (docs/compliance/privacy.md); distances and flags do.
const view = (p, coll, row) => {
  const out = redactForReader(p, coll, { ...row.data, id: row.id, version: row.version });
  if (coll !== 'timeEntries' || !out) return out;
  const rest = { ...out };
  for (const k of ENTRY_COORDS) delete rest[k];
  return rest;
};

/** One record (or 404 for missing, deleted, hidden or another company's id). */
export async function readRecord(tx, p, coll, id) {
  assertReadable(p, coll);
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw notFound();
  const def = collectionDef(coll);
  const params = [tx.tenantId, id];
  if (rowFilter(p, coll)?.value === null) throw notFound();
  const { rows } = await tx.query(
    `SELECT id, data, version FROM ${def.table} WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL${visibleWhere(p, coll, params)}`, params);
  if (!rows[0]) throw notFound();
  return view(p, coll, rows[0]);
}

/** Several records by id (missing ones are left out). */
export async function readMany(tx, p, coll, ids) {
  assertReadable(p, coll);
  const clean = [...new Set((ids || []).filter((x) => typeof x === 'string' && x.length <= 128))];
  if (!clean.length || rowFilter(p, coll)?.value === null) return [];
  const params = [tx.tenantId, clean];
  const { rows } = await tx.query(
    `SELECT id, data, version FROM ${collectionDef(coll).table} WHERE tenant_id = $1 AND id = ANY($2) AND deleted_at IS NULL${visibleWhere(p, coll, params)}`, params);
  return rows.map((r) => view(p, coll, r));
}

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Text search over the usual descriptive fields plus exact filters on generated columns.
 * @param {{ query?: string, filters?: Record<string,string>, limit?: number }} q
 */
export async function searchRecords(tx, p, coll, q = {}) {
  assertReadable(p, coll);
  const def = collectionDef(coll);
  const limit = Math.min(Math.max(Number(q.limit) || 10, 1), 50);
  const params = [tx.tenantId];
  const where = ['tenant_id = $1', 'deleted_at IS NULL'];
  if (rowFilter(p, coll)?.value === null) return [];
  const text = String(q.query || '').trim().slice(0, 100);
  if (text) {
    for (const word of text.split(/\s+/).slice(0, 5)) {
      params.push(`%${escapeLike(word)}%`);
      where.push(`concat_ws(' ', data->>'name', data->>'title', data->>'number', data->>'sku', data->>'category', data->>'description',
        data->>'email', data->>'phone', data->>'contactName', data->>'address', data->>'authority', data->>'issuer', data->>'type') ILIKE $${params.length}`);
    }
  }
  for (const g of def.gen) {
    const v = q.filters?.[g.field];
    if (v != null && v !== '') { params.push(String(v)); where.push(`${g.col} = $${params.length}`); }
  }
  const own = visibleWhere(p, coll, params);
  params.push(limit);
  const { rows } = await tx.query(
    `SELECT id, data, version FROM ${def.table} WHERE ${where.join(' AND ')}${own} ORDER BY updated_at DESC, id LIMIT $${params.length}`, params);
  return rows.map((r) => view(p, coll, r));
}

/** A short line per record for search results; the model fetches the full record when it needs it. */
export function summarize(coll, r) {
  const base = { id: r.id };
  const pickKeys = (...keys) => { for (const k of keys) if (r[k] != null && r[k] !== '') base[k] = r[k]; return base; };
  switch (coll) {
    case 'estimates':
    case 'invoices': {
      pickKeys('number', 'title', 'status', 'clientId', 'jobId', 'estimateId', 'issueDate', 'dueDate', 'validUntil');
      const t = docTotals(r);
      return { ...base, lineCount: (r.lines || []).length, subtotalCents: t.subtotalCents, taxCents: t.taxCents, totalCents: t.totalCents };
    }
    case 'items': {
      pickKeys('sku', 'name', 'category', 'unit', 'priceCents', 'labourHours', 'reorderPoint');
      const stock = Object.values(r.stock || {}).reduce((s, n) => s + (Number(n) || 0), 0);
      return { ...base, inStock: stock };
    }
    case 'clients': return pickKeys('name', 'type', 'email', 'phone', 'address');
    case 'jobs': return pickKeys('number', 'title', 'status', 'clientId', 'address', 'startDate', 'endDate', 'estimateId');
    case 'leads': return pickKeys('title', 'stage', 'clientId', 'contactName', 'valueCents', 'nextActionAt');
    case 'permits': return pickKeys('number', 'jobId', 'authority', 'type', 'status', 'expiryDate');
    case 'certifications': return pickKeys('name', 'employeeId', 'issuer', 'number', 'expiry');
    case 'employees': return pickKeys('name', 'role', 'licenceNo', 'licenceExpiry', 'active');
    case 'timeEntries': return pickKeys('employeeId', 'jobId', 'clockIn', 'clockOut', 'breakMins', 'approved');
    case 'payments': return pickKeys('invoiceId', 'amountCents', 'date', 'method');
    default: return pickKeys('number', 'name', 'title', 'status', 'jobId', 'clientId', 'date');
  }
}

/** The company's settings record merged over the PWA defaults, plus the tenant's province. */
export async function companySettings(tx) {
  const { rows } = await tx.query("SELECT data FROM settings WHERE tenant_id = $1 AND id = 'settings' AND deleted_at IS NULL", [tx.tenantId]);
  const t = await tx.query('SELECT name, province FROM tenants WHERE id = $1', [tx.tenantId]);
  const data = rows[0]?.data || {};
  const company = { ...DEFAULT_SETTINGS.company, ...(data.company || {}) };
  if (!data.company?.province && t.rows[0]?.province) company.province = t.rows[0].province;
  if (!data.company?.name && t.rows[0]?.name) company.name = t.rows[0].name;
  return { ...DEFAULT_SETTINGS, ...data, company, exists: Boolean(rows[0]) };
}
