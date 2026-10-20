// Live look-up of QuickBooks customers, invoices and estimates (docs/integrations/quickbooks.md 7.8),
// import into Fishtape, and Renumber (4.7). Search terms are names, so they arrive in POST bodies,
// never in a URL. Every value placed in query text goes through qboQuote (escapes \ and ', refuses %
// and _) or an id pattern. Look-ups are CorePlus reads: cached for 60 seconds per tenant and query,
// stopped by the budgets (client purpose 'lookup'), and never stored except by an import.
import { ApiError, validationFailed } from '../errors.js';
import { createQboClient } from './client.js';
import { qboQuote } from './map/names.js';
import { toCents, str } from './map/canon.js';
import { makeRun, txWrite, system, loadRecord } from './engine.js';
import { createFromRemote, settle } from './pull.js';
import { recordLabel, writeLog } from './log.js';

const ID = /^\d{1,20}$/;
const CACHE_MS = 60_000;
const cache = new Map();
/** Tests: forget cached look-ups. */
export function resetLookupCache() { cache.clear(); }

const ref = (r) => (r && typeof r === 'object' ? str(r.value) : str(r));
const name = (r) => (r && typeof r === 'object' ? str(r.name) : null);

function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const p = fn().then((value) => { cache.set(key, { at: Date.now(), value: Promise.resolve(value) }); return value; }, (e) => { cache.delete(key); throw e; });
  cache.set(key, { at: Date.now(), value: p });
  if (cache.size > 2000) for (const k of [...cache.keys()].slice(0, 500)) cache.delete(k);
  return p;
}

function checkId(v, what = 'qboId') {
  if (!ID.test(String(v ?? ''))) throw validationFailed(`${what} must be a QuickBooks id.`);
  return String(v);
}

/** q placed in a query: 2 to 100 characters (DocNumber prefixes up to 21), quoted, never a wildcard. */
function quoteQ(q, { min = 2, max = 100 } = {}) {
  const s = String(q ?? '').trim();
  if (s.length < min || s.length > max) throw validationFailed(`Search text is ${min} to ${max} characters.`);
  try { return qboQuote(s); } catch { throw validationFailed('Search text cannot contain % or _.'); }
}

/** Which Fishtape record a QuickBooks object is linked to, from the tenant's links. */
async function linkedMap(db, tenantId, entity, ids) {
  if (!ids.length) return new Map();
  return db.withTenant({ tenantId }, async (tx) => {
    const { rows } = await tx.query(
      "SELECT qbo_id, collection, record_id FROM qbo_links WHERE tenant_id = $1 AND qbo_entity = $2 AND qbo_id = ANY($3::text[]) AND role = 'main' AND state <> 'unlinked'",
      [tx.tenantId, entity, ids]);
    return new Map(rows.map((r) => [r.qbo_id, { collection: r.collection, id: r.record_id }]));
  });
}

const clampLimit = (v, d = 25) => Math.min(Math.max(Number.parseInt(v, 10) || d, 1), 25);

/**
 * @param {object} deps { db, sealer, config }
 * @param {'customers'|'invoices'|'estimates'|'customer'|'invoice'|'estimate'} entity search kinds are plural; a single object by id singular
 * @param {object} params search body, or { qboId }
 */
export async function lookup(deps, tenantId, entity, params = {}) {
  const client = createQboClient({ db: deps.db, sealer: deps.sealer, config: deps.config, tenantId, purpose: 'lookup', log: deps.log });
  const key = `${tenantId}|${entity}|${JSON.stringify(params)}`;
  return cached(key, async () => {
    switch (entity) {
      case 'customers': {
        const q = quoteQ(params.q);
        const list = await client.query(`select * from Customer where DisplayName like '${q}%' maxresults ${clampLimit(params.limit)}`, { max: clampLimit(params.limit) });
        const links = await linkedMap(deps.db, tenantId, 'Customer', list.map((c) => String(c.Id)));
        return {
          data: list.map((c) => ({
            qboId: String(c.Id), name: c.DisplayName || null, companyName: c.CompanyName || null, email: c.PrimaryEmailAddr?.Address || null,
            phone: c.PrimaryPhone?.FreeFormNumber || null, balanceCents: toCents(c.Balance ?? 0), active: c.Active !== false, isJob: Boolean(c.Job || c.ParentRef),
            linked: links.get(String(c.Id)) || null,
          })),
        };
      }
      case 'invoices':
      case 'estimates': {
        const inv = entity === 'invoices';
        const E = inv ? 'Invoice' : 'Estimate';
        const where = [];
        let customer = params.qboCustomerId != null ? checkId(params.qboCustomerId, 'qboCustomerId') : null;
        if (!customer && params.clientId) {
          customer = await deps.db.withTenant({ tenantId }, async (tx) => (await tx.query(
            "SELECT qbo_id FROM qbo_links WHERE tenant_id = $1 AND collection = 'clients' AND record_id = $2 AND role = 'main' AND state <> 'unlinked'", [tx.tenantId, String(params.clientId)])).rows[0]?.qbo_id || null);
          if (!customer) return { data: [] };
        }
        if (customer) where.push(`CustomerRef = '${customer}'`);
        if (params.q) where.push(`DocNumber like '${quoteQ(params.q, { min: 1, max: 21 })}%'`);
        if (inv && params.status === 'open') where.push("Balance > '0'");
        if (!inv && params.status === 'pending') where.push("TxnStatus = 'Pending'");
        if (!where.length) throw validationFailed('Give a customer or a number to search for.');
        const lim = clampLimit(params.limit);
        const list = await client.query(`select * from ${E} where ${where.join(' and ')} maxresults ${lim}`, { max: lim });
        const links = await linkedMap(deps.db, tenantId, E, list.map((x) => String(x.Id)));
        return {
          data: list.map((x) => ({
            qboId: String(x.Id), docNumber: x.DocNumber || null, date: x.TxnDate || null, dueDate: x.DueDate || x.ExpirationDate || null,
            customer: name(x.CustomerRef), totalCents: toCents(x.TotalAmt ?? 0), balanceCents: x.Balance == null ? null : toCents(x.Balance),
            status: inv ? (toCents(x.Balance) > 0 ? 'open' : 'paid') : (x.TxnStatus || null), linked: links.get(String(x.Id)) || null,
          })),
        };
      }
      case 'customer':
      case 'invoice':
      case 'estimate': {
        const E = { customer: 'Customer', invoice: 'Invoice', estimate: 'Estimate' }[entity];
        const o = await client.read(E, checkId(params.qboId));
        const links = await linkedMap(deps.db, tenantId, E, [String(o.Id)]);
        const linked = links.get(String(o.Id)) || null;
        if (E === 'Customer') {
          return { qboId: String(o.Id), name: o.DisplayName || null, companyName: o.CompanyName || null, email: o.PrimaryEmailAddr?.Address || null, phone: o.PrimaryPhone?.FreeFormNumber || null, balanceCents: toCents(o.Balance ?? 0), active: o.Active !== false, linked };
        }
        return {
          qboId: String(o.Id), docNumber: o.DocNumber || null, date: o.TxnDate || null, customer: name(o.CustomerRef),
          lines: (o.Line || []).filter((l) => l.DetailType === 'SalesItemLineDetail' || l.DetailType === 'DescriptionOnly').map((l) => ({
            description: l.Description || null, qty: l.SalesItemLineDetail?.Qty ?? null, amountCents: toCents(l.Amount ?? 0), taxCode: ref(l.SalesItemLineDetail?.TaxCodeRef),
          })),
          taxCents: toCents(o.TxnTaxDetail?.TotalTax ?? 0), totalCents: toCents(o.TotalAmt ?? 0), balanceCents: o.Balance == null ? null : toCents(o.Balance),
          status: E === 'Invoice' ? (toCents(o.Balance) > 0 ? 'open' : 'paid') : (o.TxnStatus || null), linked,
        };
      }
      default:
        throw validationFailed('Unknown look-up.');
    }
  });
}

/**
 * Import a QuickBooks customer, invoice or estimate into Fishtape (7.8), with its dependencies; an
 * imported invoice gets its settlement payment (4.9). The caller holds the tenant lease.
 * @returns {Promise<{ collection: string, id: string }>}
 */
export async function importRemote(deps, tenantId, entity, qboId, { epoch }) {
  const E = { customer: 'Customer', invoice: 'Invoice', estimate: 'Estimate' }[entity];
  if (!E) throw validationFailed('Unknown look-up.');
  const run = await makeRun(deps, tenantId, { epoch, purpose: 'lookup', ignoreBrake: true });
  if (!run) throw new ApiError(409, 'qbo_not_connected', 'QuickBooks is not connected.');
  const o = await run.client.read(E, checkId(qboId));
  if (E === 'Customer') {
    if (o.Job || o.ParentRef) throw validationFailed('Jobs in QuickBooks are not imported; import the customer.');
    const made = await createFromRemote(run, 'clients', 'Customer', o);
    if (!made) throw new ApiError(409, 'qbo_import_refused', 'This could not be imported.');
    return { collection: 'clients', id: made.id };
  }
  const { processRemote } = await import('./pull.js');
  const cust = ref(o.CustomerRef);
  if (cust && !run.ctx.refs.fishtapeIdFor('clients', cust) && !run.ctx.refs.fishtapeIdFor('jobs', cust)) {
    const c = await run.client.read('Customer', cust);
    const top = c.ParentRef ? await run.client.read('Customer', ref(c.ParentRef)) : c;
    if (c.ParentRef) run.index.parents.set(String(c.Id), ref(c.ParentRef));
    await createFromRemote(run, 'clients', 'Customer', top);
  }
  const collection = E === 'Invoice' ? 'invoices' : 'estimates';
  const made = await createFromRemote(run, collection, E, o);
  if (!made) throw new ApiError(409, 'qbo_import_refused', 'This could not be imported.');
  if (E === 'Invoice' && made.link) await settle(run, made.link, o);
  else if (E === 'Invoice') await processRemote(run, 'Invoice', o);
  return { collection, id: made.id };
}

/**
 * Renumber (4.7): the next number on the server, the highest of settings.nextNumbers and every
 * Fishtape and QuickBooks number of that kind plus one; the record and the setting are patched.
 * @returns {Promise<{ number: string }>}
 */
export async function renumber(run, collection, id) {
  if (!['invoices', 'estimates'].includes(collection)) throw validationFailed('Only invoices and estimates are renumbered.');
  const kind = collection === 'invoices' ? 'invoice' : 'estimate';
  const prefix = kind === 'invoice' ? 'INV' : 'E';
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  const qboNumbers = await run.client.query(`select * from ${kind === 'invoice' ? 'Invoice' : 'Estimate'} where DocNumber like '${prefix}-%'`, { all: true, max: 50000 });
  return txWrite(run, async (tx) => {
    const rec = await loadRecord(tx, collection, id);
    if (!rec || rec.deleted) throw new ApiError(404, 'not_found', 'Not found.');
    const sRow = (await tx.query("SELECT data FROM settings WHERE tenant_id = $1 AND id = 'settings' AND deleted_at IS NULL", [tx.tenantId])).rows[0];
    const s = sRow?.data || {};
    const own = (await tx.query(`SELECT number FROM ${collection} WHERE tenant_id = $1 AND number IS NOT NULL`, [tx.tenantId])).rows.map((r) => r.number);
    let top = Number(s.nextNumbers?.[kind]) || 0;
    for (const n of [...own, ...qboNumbers.map((o) => o.DocNumber)]) { const m = re.exec(String(n || '')); if (m) top = Math.max(top, Number(m[1]) + 1); }
    const number = `${prefix}-${top}`;
    await system.patch(tx, run, collection, id, { number });
    const nextNumbers = { ...(s.nextNumbers || {}), [kind]: top + 1 };
    if (sRow) await system.patch(tx, run, 'settings', 'settings', { nextNumbers });
    else await system.create(tx, run, 'settings', { id: 'settings', nextNumbers });
    await tx.query(
      `UPDATE qbo_links SET state = CASE WHEN state IN ('error', 'blocked') THEN 'pending' ELSE state END, reason = NULL WHERE tenant_id = $1 AND collection = $2 AND record_id = $3 AND role = 'main' AND reason IN ('duplicate_number', 'duplicate_number_local')`,
      [tx.tenantId, collection, id]);
    await writeLog(tx, { direction: 'system', outcome: 'info', action: 'renumber', collection, recordId: id, label: recordLabel(collection, { ...rec.data, number }), message: `Renumbered ${rec.data.number || ''} to ${number}`.trim() });
    return { number };
  });
}
