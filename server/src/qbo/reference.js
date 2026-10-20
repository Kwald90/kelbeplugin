// QuickBooks reference lists (docs/integrations/quickbooks.md 2.8, 3.8, 5.4): accounts, items, tax
// codes, rates and agencies, payment methods, classes, departments, terms, employees and vendors,
// read whole (one query per kind) into qbo_reference with only the allow-listed fields, and the
// company's features from CompanyInfo and Preferences. TaxCode, TaxRate and TaxAgency send no
// webhooks, so this daily read is their only source; taxFiledThrough is the latest LastFileDate.
// At most once every 5 minutes per tenant (5.11).
import { writeLog } from './log.js';
import { QboError, createQboClient } from './client.js';
import { detectFeatures, loadConnection } from './connection.js';
import { assertEpoch } from './lease.js';
import { requeueStuck } from './engine.js';

export const REFERENCE_KINDS = ['Account', 'Item', 'TaxCode', 'TaxRate', 'TaxAgency', 'PaymentMethod', 'Class', 'Department', 'Term', 'Employee', 'Vendor'];
const NAMED = new Set(['Account', 'Item', 'PaymentMethod', 'Class', 'Department', 'Term', 'Employee', 'Vendor']);
const EVERY_MS = 5 * 60_000;

const idOf = (r) => (r && typeof r === 'object' ? String(r.value ?? r.Id ?? '') : String(r ?? ''));
const rateList = (list) => (Array.isArray(list) ? list : (list?.TaxRateDetail || [])).map((x) => idOf(x?.TaxRateRef ?? x)).filter(Boolean);
const keep = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined && o[k] !== null).map((k) => [k, o[k]]));

/**
 * The allow-listed fields of one reference object (3.8). Never birth dates, SIN, home addresses,
 * bill rates, tax identifiers or notes. A test checks that nothing else is kept.
 * @param {{ stripeClearing?: string }} [o] the clearing account keeps its CurrentBalance
 */
export function referenceData(kind, obj, { stripeClearing = null } = {}) {
  const o = obj || {};
  switch (kind) {
    case 'Account': {
      const d = keep(o, ['Id', 'Name', 'AccountType', 'AccountSubType', 'Active']);
      if (stripeClearing && String(o.Id) === String(stripeClearing) && o.CurrentBalance != null) d.CurrentBalance = o.CurrentBalance;
      return d;
    }
    case 'Item': return keep(o, ['Id', 'Name', 'Type', 'Active']);
    case 'TaxCode': return { ...keep(o, ['Id', 'Name', 'Active']), SalesTaxRateList: rateList(o.SalesTaxRateList), PurchaseTaxRateList: rateList(o.PurchaseTaxRateList) };
    case 'TaxRate': {
      const d = keep(o, ['Id', 'Name', 'RateValue', 'Active']);
      if (o.AgencyRef) d.AgencyRef = idOf(o.AgencyRef);
      if (Array.isArray(o.EffectiveTaxRate)) d.EffectiveTaxRate = o.EffectiveTaxRate.map((e) => keep(e, ['RateValue', 'EffectiveDate', 'EndDate']));
      return d;
    }
    case 'TaxAgency': return keep(o, ['Id', 'DisplayName', 'LastFileDate']);
    case 'Term': return keep(o, ['Id', 'Name', 'Active', 'DueDays']);
    case 'PaymentMethod': case 'Class': case 'Department': return keep(o, ['Id', 'Name', 'Active']);
    case 'Employee': {
      const d = keep(o, ['Id', 'DisplayName', 'GivenName', 'FamilyName', 'Active']);
      if (o.PrimaryEmailAddr?.Address) d.PrimaryEmailAddr = { Address: o.PrimaryEmailAddr.Address };
      return d;
    }
    case 'Vendor': {
      const d = keep(o, ['Id', 'DisplayName', 'Active']);
      if (o.PrimaryEmailAddr?.Address) d.PrimaryEmailAddr = { Address: o.PrimaryEmailAddr.Address };
      return d;
    }
    default: throw new Error(`no reference allow-list for ${kind}`);
  }
}

const nameOf = (kind, o) => String(o.Name || o.DisplayName || [o.GivenName, o.FamilyName].filter(Boolean).join(' ') || `#${o.Id}`).slice(0, 200);

/** The later of two YYYY-MM-DD dates. */
const later = (a, b) => (a && b ? (a > b ? a : b) : a || b || null);

/**
 * Refresh the lists and the features. `force` skips the 5-minute cap (the daily job, connect).
 * @param {object} deps { db, sealer, config }
 * @returns {Promise<{ kinds: number, rows: number, skipped?: string }>}
 */
export async function refreshReference(deps, tenantId, { force = false, epoch = null } = {}) {
  const conn = await deps.db.withTenant({ tenantId }, loadConnection);
  if (!conn || !['setup', 'active', 'paused'].includes(conn.state)) return { kinds: 0, rows: 0, skipped: conn?.state || 'not_connected' };
  if (!force && conn.ref_refreshed_at && Date.now() - new Date(conn.ref_refreshed_at).getTime() < EVERY_MS) return { kinds: 0, rows: 0, skipped: 'recent' };
  const client = createQboClient({ db: deps.db, sealer: deps.sealer, config: deps.config, tenantId, purpose: 'reference', log: deps.log });
  const clearing = (await deps.db.withTenant({ tenantId }, async (tx) => (await tx.query(
    "SELECT value FROM qbo_mappings WHERE tenant_id = $1 AND kind = 'account' AND key = 'stripeClearing'", [tx.tenantId])).rows[0]?.value)) || null;
  const lists = {};
  for (const kind of REFERENCE_KINDS) {
    if (kind === 'Class' && !conn.features?.classes) { lists[kind] = []; continue; }
    if (kind === 'Department' && !conn.features?.locations) { lists[kind] = []; continue; }
    const q = NAMED.has(kind) ? `select * from ${kind} where Active in (true, false)` : `select * from ${kind}`;
    try {
      lists[kind] = await client.query(q, { all: true, max: 20000 });
    } catch (e) {
      // One list this company cannot read (not in its edition, no permission) keeps its stored rows;
      // the rest of the refresh goes on, so the reads already made are not spent for nothing.
      if (e instanceof QboError && ['feature', 'permission'].includes(e.kind)) { lists[kind] = null; continue; }
      throw e;
    }
  }
  const info = await client.companyInfo();
  const prefs = await client.preferences();
  const filed = (lists.TaxAgency || []).map((a) => String(a.LastFileDate || '').slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().at(-1) || null;
  let rows = 0;
  await deps.db.withTenant({ tenantId }, async (tx) => {
    if (epoch != null) await assertEpoch(tx, tenantId, epoch);
    for (const kind of REFERENCE_KINDS) {
      if (lists[kind] == null) continue;
      const seen = [];
      for (const o of lists[kind]) {
        if (!/^\d{1,20}$/.test(String(o.Id))) continue;
        seen.push(String(o.Id));
        await tx.query(
          `INSERT INTO qbo_reference (tenant_id, realm_hash, kind, qbo_id, name, active, data) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (tenant_id, kind, qbo_id) DO UPDATE SET realm_hash = EXCLUDED.realm_hash, name = EXCLUDED.name, active = EXCLUDED.active, data = EXCLUDED.data, updated_at = now()`,
          [tx.tenantId, conn.realm_hash, kind, String(o.Id), nameOf(kind, o), o.Active !== false, JSON.stringify(referenceData(kind, o, { stripeClearing: clearing }))]);
        rows++;
      }
      await tx.query('DELETE FROM qbo_reference WHERE tenant_id = $1 AND kind = $2 AND NOT (qbo_id = ANY($3::text[]))', [tx.tenantId, kind, seen]);
    }
    const before = conn.features || {};
    const features = { ...before, ...detectFeatures(info, prefs), taxFiledThrough: later(filed, before.taxFiledThrough || null) };
    // A 5030 answer turned a feature off (2.8); it stays off until the edition changes.
    if (before.edition === features.edition) for (const f of ['bills', 'purchaseOrders', 'timeTracking']) if (before[f] === false) features[f] = false;
    await tx.query('UPDATE qbo_connections SET features = $2, company_name = COALESCE($3, company_name), ref_refreshed_at = now(), updated_at = now() WHERE tenant_id = $1',
      [tenantId, JSON.stringify(features), info?.CompanyName ? String(info.CompanyName).slice(0, 200) : null]);
    // A feature that came back re-queues what waited for it (2.8).
    if (['bills', 'purchaseOrders', 'timeTracking'].some((f) => before[f] === false && features[f] !== false)) await requeueStuck(tx, { reasons: ['feature_missing'] });
    await writeLog(tx, { direction: 'system', outcome: 'info', action: 'reference_refresh', message: `QuickBooks lists refreshed (${rows} entries).` });
  });
  return { kinds: REFERENCE_KINDS.length, rows };
}
