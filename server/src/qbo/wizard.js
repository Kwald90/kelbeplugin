// The first-connect matching wizard (docs/integrations/quickbooks.md section 6). Nothing is written to
// either side before apply. The scan reads QuickBooks' lists and documents and pairs them with
// Fishtape's records (W2 match.js) into qbo_candidates; the office changes choices; apply links the
// pairs with per-field baselines (no silent overwrite on the first reconcile), then creates what is
// missing on each side, phase by phase, in resumable chunks of at most 4 minutes. A crash resumes at
// the first candidate without applied_at; creates already sent are found by adopt-by-search.
import { ApiError, validationFailed } from '../errors.js';
import { appendAudit } from '../services/audit.js';
import { notify } from '../services/notify.js';
import { enqueue } from '../services/queue.js';
import { docTotals, KINDS } from '../../../electrical-app/js/lib/money.js';
import { amountDueCents } from '../integrations/payments.js';
import { writeLog } from './log.js';
import { QBO_RANK, upsertOutbox } from './hooks.js';
import { enqueueSync, loadConnection } from './connection.js';
import { assertEpoch } from './lease.js';
import {
  makeRun, txWrite, getLink, insertLink, updateLink, loadRecord, ctxFor, optionOf, taxFiledThrough, monthStart, timeUp, zoneOf, loadMappings,
} from './engine.js';
import { processRecord } from './push.js';
import { createFromRemote, settle } from './pull.js';
import { openReview } from './conflicts.js';
import { fishtapeToCanon, qboToCanon, toCents, localDay, str } from './map/canon.js';
import { linkMetaFromQbo } from './map/to-fishtape.js';
import { fieldLabel } from './map/merge.js';
import { wizardBaseline } from './map/baseline.js';
import { matchCustomers, matchJobs, matchItems, matchEmployees, matchVendors, matchDocs, matchPayments } from './map/match.js';
import { companyTaxKeys, NONE_REASON_KEYS, lineTaxKey, kindsUsed, needsTaxReason } from './map/tax.js';

export const CANDIDATE_KINDS = ['customers', 'jobs', 'items', 'employees', 'vendors', 'estimates', 'invoices', 'payments'];
const COLLECTION_OF = { customers: 'clients', jobs: 'jobs', items: 'items', employees: 'employees', vendors: 'vendors', estimates: 'estimates', invoices: 'invoices', payments: 'payments' };
const ENTITY_OF = { customers: 'Customer', jobs: 'Customer', items: 'Item', employees: 'Employee', vendors: 'Vendor', estimates: 'Estimate', invoices: 'Invoice', payments: 'Payment' };
const CHOICES_OF = {
  customers: ['link', 'create_in_qbo', 'create_in_fishtape', 'skip'], vendors: ['link', 'create_in_qbo', 'create_in_fishtape', 'skip'],
  items: ['link', 'create_in_qbo', 'create_in_fishtape', 'skip'], jobs: ['link', 'skip'], employees: ['link', 'skip'],
  estimates: ['link', 'create_in_qbo', 'create_in_fishtape', 'skip'], invoices: ['link', 'create_in_qbo', 'create_in_fishtape', 'skip'],
  payments: ['link', 'create_in_qbo', 'create_in_fishtape', 'skip'],
};
const SCAN_EVERY_MS = 15 * 60_000;
const DOC_KINDS = new Set(['estimates', 'invoices']);
const ref = (r) => (r && typeof r === 'object' ? str(r.value) : str(r));
const daysBefore = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

// ---- required mappings (7.6) -------------------------------------------------------------------------

/** The mappings that block setup or sync while missing (7.6). */
export async function requiredMappings(tx, conn, mappings) {
  const missing = [];
  const has = (kind, key) => mappings?.[kind]?.[key] != null && mappings[kind][key] !== '';
  const need = (kind, key) => { if (!has(kind, key)) missing.push({ kind, key }); };
  const settings = (await tx.query("SELECT data FROM settings WHERE tenant_id = $1 AND id = 'settings' AND deleted_at IS NULL", [tx.tenantId])).rows[0]?.data || {};
  const province = settings.company?.province || conn?.features?.province || null;
  if (conn?.features?.salesTax !== false) {
    for (const key of companyTaxKeys(province)) if (!key.startsWith('NONE|')) need('taxCode', key);
    const reasons = (await tx.query(
      `SELECT DISTINCT data->>'taxNoneReason' AS r FROM (SELECT data FROM invoices WHERE tenant_id = $1 AND deleted_at IS NULL UNION ALL SELECT data FROM estimates WHERE tenant_id = $1 AND deleted_at IS NULL) d
        WHERE data->>'taxNoneReason' IS NOT NULL`, [tx.tenantId])).rows.map((r) => r.r);
    for (const r of reasons) if (NONE_REASON_KEYS[r]) need('taxCode', `NONE|${NONE_REASON_KEYS[r]}`);
  }
  if (optionOf(mappings, 'syncTime', true) !== false && !['fishtape', 'quickbooks'].includes(optionOf(mappings, 'timeOwner', null))) need('option', 'timeOwner');
  for (const k of ['material', 'labour', 'other']) need('item', k);
  need('account', 'income.default');
  need('account', 'expense.default');
  const methods = (await tx.query("SELECT DISTINCT lower(data->>'method') AS m FROM payments WHERE tenant_id = $1 AND deleted_at IS NULL AND data->>'method' IS NOT NULL AND coalesce(data->>'source', '') <> 'quickbooks'", [tx.tenantId])).rows.map((r) => r.m);
  const { normMethod } = await import('./map/canon.js');
  for (const m of new Set(methods.map(normMethod).filter((m) => m && m !== 'credit'))) need('depositTo', m);
  const purchasing = (await tx.query('SELECT (SELECT count(*) FROM bills WHERE tenant_id = $1) + (SELECT count(*) FROM vendors WHERE tenant_id = $1) AS n', [tx.tenantId])).rows[0];
  if (Number(purchasing.n) > 0) need('account', 'jobCost.material');
  const stripe = (await tx.query("SELECT 1 FROM tenant_secrets WHERE tenant_id = $1 AND name = 'stripe.secret_key'", [tx.tenantId])).rows.length > 0;
  if (stripe && (optionOf(mappings, 'recordStripeFees', true) !== false || optionOf(mappings, 'recordStripePayouts', true) !== false)) {
    need('account', 'stripeClearing');
    if (optionOf(mappings, 'recordStripeFees', true) !== false) need('account', 'stripeFees');
    if (optionOf(mappings, 'recordStripePayouts', true) !== false) need('account', 'stripePayoutBank');
  }
  const paidWith = (await tx.query("SELECT DISTINCT data->>'paidWith' AS p FROM bills WHERE tenant_id = $1 AND deleted_at IS NULL AND data->>'kind' = 'receipt' AND data->>'paidWith' IS NOT NULL", [tx.tenantId])).rows.map((r) => r.p);
  for (const p of paidWith) need('paidFrom', p);
  return missing;
}

// ---- scan (6.3) --------------------------------------------------------------------------------------

async function fishtapeRows(tx, table) {
  const { rows } = await tx.query(`SELECT id, data FROM ${table} WHERE tenant_id = $1 AND deleted_at IS NULL`, [tx.tenantId]);
  return rows.map((r) => ({ ...r.data, id: r.id }));
}

/**
 * Scan QuickBooks and Fishtape and write the candidates (6.3). The caller holds the lease.
 * @param {object} deps { db, sealer, config, records }
 */
export async function scan(deps, tenantId, { epoch } = {}) {
  const run = await makeRun(deps, tenantId, { epoch, purpose: 'scan', ignoreBrake: true });
  if (!run) throw new ApiError(409, 'qbo_not_connected', 'QuickBooks is not connected.');
  if (run.conn.state !== 'setup') return { skipped: run.conn.state };
  const started = new Date();
  const changeSeq = await run.db.withTenant({ tenantId }, async (tx) => {
    const tables = ['clients', 'jobs', 'items', 'vendors', 'estimates', 'invoices', 'payments', 'bills', 'purchase_orders', 'time_entries'];
    const { rows } = await tx.query(`SELECT GREATEST(${tables.map((t) => `(SELECT COALESCE(max(change_seq), 0) FROM ${t} WHERE tenant_id = $1)`).join(', ')})::bigint AS m`, [tx.tenantId]);
    return Number(rows[0].m || 0);
  });
  await setupProgress(run, { phase: 'scanning', startedAt: started.toISOString(), done: 0, total: 0, errors: 0 });
  const m = run.ctx.mappings;
  const syncFrom = str(optionOf(m, 'syncFrom', null)) || monthStart();
  const from = daysBefore(syncFrom, 14);
  const q = (text) => run.client.query(text, { all: true, max: 50000 });
  const customers = await q('select * from Customer where Active in (true, false)');
  const qboItems = await q('select * from Item where Active in (true, false)');
  const qboEmployees = await q('select * from Employee where Active in (true, false)');
  const qboVendors = run.ctx.features?.bills === false ? [] : await q('select * from Vendor where Active in (true, false)');
  const byId = (list) => new Map(list.map((o) => [String(o.Id), o]));
  const invMap = byId([...await q("select * from Invoice where Balance > '0'"), ...await q(`select * from Invoice where TxnDate >= '${from}'`)]);
  const estMap = byId([...await q(`select * from Estimate where TxnDate >= '${from}'`), ...await q("select * from Estimate where TxnStatus = 'Pending'"), ...await q("select * from Estimate where TxnStatus = 'Accepted'")]);
  const payMap = byId(await q(`select * from Payment where TxnDate >= '${syncFrom}'`));
  for (const c of customers) if (c.ParentRef) run.index.parents.set(String(c.Id), ref(c.ParentRef));

  const result = await run.db.withTenant({ tenantId }, async (tx) => {
    const F = {};
    for (const [k, table] of [['clients', 'clients'], ['jobs', 'jobs'], ['items', 'items'], ['employees', 'employees'], ['vendors', 'vendors'], ['estimates', 'estimates'], ['invoices', 'invoices'], ['payments', 'payments']]) F[k] = await fishtapeRows(tx, table);
    const linkedIds = (coll) => new Set((tx.__links || []).filter((l) => l.collection === coll).map((l) => l.record_id));
    tx.__links = (await tx.query("SELECT collection, record_id, qbo_entity, qbo_id FROM qbo_links WHERE tenant_id = $1 AND state <> 'unlinked'", [tx.tenantId])).rows;
    const linkedQbo = new Set(tx.__links.filter((l) => l.qbo_id).map((l) => `${l.qbo_entity}|${l.qbo_id}`));
    const free = (coll, list) => { const s = linkedIds(coll); return list.filter((r) => !s.has(r.id)); };
    const freeQ = (entity, list) => list.filter((o) => !linkedQbo.has(`${entity}|${o.Id}`));
    // Activity since syncFrom (customers to create on either side, 6.3).
    const activeClientIds = new Set();
    for (const d of [...F.estimates, ...F.invoices]) {
      const date = d.issueDate || String(d.createdAt || '').slice(0, 10);
      if ((date && date >= syncFrom) || ['sent', 'partial'].includes(d.status)) if (d.clientId) activeClientIds.add(d.clientId);
    }
    for (const j of F.jobs) if (String(j.createdAt || '').slice(0, 10) >= syncFrom && j.clientId) activeClientIds.add(j.clientId);
    const activeCustomerIds = new Set([...invMap.values(), ...estMap.values(), ...payMap.values()].map((o) => ref(o.CustomerRef)).filter(Boolean));

    const out = [];
    const custC = matchCustomers(free('clients', F.clients), freeQ('Customer', customers), { activeClientIds: [...activeClientIds], activeCustomerIds: [...activeCustomerIds], importCustomers: optionOf(m, 'importCustomers', 'active') });
    out.push(...custC);
    const clientToQbo = new Map(custC.filter((c) => c.choice === 'link' && c.fishtapeId && c.qboId).map((c) => [c.fishtapeId, c.qboId]));
    for (const l of tx.__links.filter((x) => x.collection === 'clients' && x.qbo_id)) clientToQbo.set(l.record_id, l.qbo_id);
    out.push(...matchJobs(free('jobs', F.jobs), freeQ('Customer', customers), clientToQbo));
    out.push(...matchItems(free('items', F.items), freeQ('Item', qboItems), { items: optionOf(m, 'items', 'on_use'), exclude: Object.values(m.item || {}) }));
    out.push(...matchEmployees(free('employees', F.employees), freeQ('Employee', qboEmployees)));
    out.push(...matchVendors(free('vendors', F.vendors), freeQ('Vendor', qboVendors)));
    const jobToClient = new Map(F.jobs.map((j) => [j.id, j.clientId]));
    const customerFor = (d) => clientToQbo.get(d.clientId || jobToClient.get(d.jobId)) || null;
    const opts = { taxFiledThrough: taxFiledThrough(run.ctx.features, m), syncFrom, zone: run.ctx.company.zone, ref: run.ctx.rates, pushDrafts: optionOf(m, 'pushDrafts', false) === true };
    const est = matchDocs('estimates', free('estimates', F.estimates), freeQ('Estimate', [...estMap.values()]), customerFor, opts);
    const inv = matchDocs('invoices', free('invoices', F.invoices), freeQ('Invoice', [...invMap.values()]), customerFor, opts);
    out.push(...est, ...inv);
    // Payments, per linked invoice pair (6.3).
    const pairs = [];
    for (const c of inv.filter((x) => x.choice === 'link' && x.fishtapeId && x.qboId)) {
      const qInv = invMap.get(String(c.qboId));
      const fInv = F.invoices.find((x) => x.id === c.fishtapeId);
      const fPays = F.payments.filter((p) => p.invoiceId === c.fishtapeId && p.source !== 'quickbooks');
      const qPays = [];
      for (const p of payMap.values()) {
        for (const l of p.Line || []) {
          if ((l.LinkedTxn || []).some((t) => t.TxnType === 'Invoice' && String(t.TxnId) === String(c.qboId))) qPays.push({ qboId: String(p.Id), amountCents: toCents(l.Amount), date: p.TxnDate });
        }
      }
      pairs.push({ invoice: { fishtapeId: c.fishtapeId, qboId: c.qboId, fishtapeDueCents: fInv ? await amountDueCents(tx, fInv) : 0, qboBalanceCents: toCents(qInv?.Balance ?? 0) }, fishtape: fPays, qbo: qPays });
    }
    const pays = matchPayments(pairs);
    out.push(...pays);
    return { candidates: out, F };
  });

  // Field differences of link candidates (shown in Review) and the documents that differ.
  const objects = { Customer: byId(customers), Item: byId(qboItems), Employee: byId(qboEmployees), Vendor: byId(qboVendors), Invoice: invMap, Estimate: estMap, Payment: payMap };
  await txWrite(run, async (tx) => {
    await tx.query('DELETE FROM qbo_candidates WHERE tenant_id = $1 AND applied_at IS NULL', [tx.tenantId]);
    let total = 0;
    for (const c of result.candidates) {
      const coll = COLLECTION_OF[c.kind];
      let diffs = [];
      if (c.fishtapeId && c.qboId && !['employees'].includes(c.kind)) {
        const rec = result.F[coll]?.find((x) => x.id === c.fishtapeId);
        const obj = objects[ENTITY_OF[c.kind]]?.get(String(c.qboId));
        if (rec && obj) {
          const ctx = ctxFor(run, { role: 'main', qbo_line: c.qboLine || '', meta: {} }, coll);
          try {
            const b = wizardBaseline(coll, fishtapeToCanon(coll, rec, ctx), qboToCanon(ENTITY_OF[c.kind], obj, { ...ctx, collection: coll }), {});
            diffs = b.diffs.map((d) => ({ ...d, label: fieldLabel(d.field) }));
          } catch { diffs = []; }
        }
      }
      const summary = { ...(c.qboSummary || {}), ...(c.options ? { alternatives: c.options.map((id) => ({ qboId: id, label: objects[ENTITY_OF[c.kind]]?.get(String(id))?.DisplayName || objects[ENTITY_OF[c.kind]]?.get(String(id))?.Name || null })) } : {}), ...(c.qboLine ? { qboLine: c.qboLine } : {}) };
      await tx.query(
        `INSERT INTO qbo_candidates (tenant_id, realm_hash, kind, fishtape_id, qbo_id, qbo_summary, score, reasons, status, choice, diffs, scanned_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [tx.tenantId, run.conn.realm_hash, c.kind, c.fishtapeId, c.qboId, JSON.stringify(summary), Math.min(100, Math.max(0, c.score || 0)), c.reasons || [], c.status, c.choice, JSON.stringify(diffs), started]);
      total++;
    }
    await tx.query(
      `UPDATE qbo_connections SET setup = setup || $2::jsonb, last_scan_at = now(), updated_at = now() WHERE tenant_id = $1`,
      [tenantId, JSON.stringify({ phase: 'scanned', scanStartedAt: started.toISOString(), scanChangeSeq: changeSeq, done: 0, total, errors: 0, finishedAt: new Date().toISOString() })]);
    await writeLog(tx, { direction: 'system', outcome: 'info', action: 'setup_scan', message: `Scan found ${total} records to match.` });
  });
  return { candidates: result.candidates.length };
}

/** Is a scan allowed now (at most once every 15 minutes, 5.11)? Returns seconds to wait, or 0. */
export function scanWaitS(conn) {
  if (!conn?.last_scan_at) return 0;
  const left = new Date(conn.last_scan_at).getTime() + SCAN_EVERY_MS - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

async function setupProgress(run, patch) {
  await run.db.withTenant({ tenantId: run.tenantId }, (tx) => tx.query(
    'UPDATE qbo_connections SET setup = setup || $2::jsonb, updated_at = now() WHERE tenant_id = $1', [run.tenantId, JSON.stringify(patch)]));
}

// ---- matches (6.4) ------------------------------------------------------------------------------------

function fishtapeSide(kind, rec) {
  if (!rec) return null;
  if (DOC_KINDS.has(kind)) {
    return { id: rec.id, number: rec.number || null, date: rec.issueDate || String(rec.createdAt || '').slice(0, 10) || null, totalCents: docTotals(rec).totalCents, status: rec.status || null };
  }
  if (kind === 'payments') return { id: rec.id, label: `$${((rec.amountCents || 0) / 100).toFixed(2)}`, date: rec.date || null, totalCents: rec.amountCents || 0 };
  return { id: rec.id, label: rec.name || rec.title || rec.number || rec.id, email: rec.email || null, phone: rec.phone || null };
}

function candidateView(row, rec) {
  const s = row.qbo_summary || {};
  const docs = DOC_KINDS.has(row.kind) || row.kind === 'payments';
  const quickbooks = row.qbo_id ? (docs
    ? { qboId: row.qbo_id, number: s.docNumber || null, date: s.date || null, totalCents: s.totalCents ?? null, balanceCents: s.balanceCents ?? null, status: s.status || null }
    : { qboId: row.qbo_id, label: s.name || null, email: s.email || null, phone: s.phone || null, active: s.active !== false }) : null;
  return {
    id: row.id, kind: row.kind, status: row.status, choice: row.choice, score: row.score, reasons: row.reasons || [],
    fishtape: fishtapeSide(row.kind, rec), quickbooks, alternatives: s.alternatives || [], diffs: row.diffs || [], fieldChoices: row.field_choices || {},
    confirmed: row.confirmed, appliedAt: row.applied_at ? new Date(row.applied_at).toISOString() : null, error: row.error || null,
  };
}

/** GET /qbo/setup/matches (6.4). Filters by kind, status and choice; names never go in the URL. */
export async function listMatches(tx, { kind = null, status = null, choice = null, cursor = null, limit = 100 } = {}) {
  if (kind && !CANDIDATE_KINDS.includes(kind)) throw validationFailed('Unknown kind.');
  const lim = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
  const offset = Math.max(0, Number.parseInt(cursor || '0', 10) || 0);
  const params = [tx.tenantId];
  const where = ['tenant_id = $1'];
  if (kind) { params.push(kind); where.push(`kind = $${params.length}`); }
  if (status) { params.push(String(status)); where.push(`status = $${params.length}`); }
  if (choice) { params.push(String(choice)); where.push(`choice = $${params.length}`); }
  params.push(offset, lim + 1);
  const { rows } = await tx.query(`SELECT * FROM qbo_candidates WHERE ${where.join(' AND ')} ORDER BY kind, status, score DESC, id OFFSET $${params.length - 1} LIMIT $${params.length}`, params);
  const page = rows.slice(0, lim);
  const recs = new Map();
  for (const k of CANDIDATE_KINDS) {
    const ids = page.filter((r) => r.kind === k && r.fishtape_id).map((r) => r.fishtape_id);
    if (!ids.length) continue;
    const table = COLLECTION_OF[k] === 'employees' ? 'employees' : COLLECTION_OF[k];
    const res = await tx.query(`SELECT id, data FROM ${table} WHERE tenant_id = $1 AND id = ANY($2)`, [tx.tenantId, ids]);
    for (const r of res.rows) recs.set(`${k}|${r.id}`, { ...r.data, id: r.id });
  }
  const counts = (await tx.query(
    `SELECT kind, status, choice, count(*)::int AS n FROM qbo_candidates WHERE tenant_id = $1 GROUP BY kind, status, choice`, [tx.tenantId])).rows;
  return {
    data: page.map((r) => candidateView(r, recs.get(`${r.kind}|${r.fishtape_id}`))),
    cursor: rows.length > lim ? String(offset + lim) : null, more: rows.length > lim,
    counts: counts.reduce((acc, r) => { ((acc[r.kind] ||= {})[r.status] ||= 0); acc[r.kind][r.status] += r.n; return acc; }, {}),
  };
}

/** PUT /qbo/setup/matches (6.4): choices one by one (max 500) or in bulk. */
export async function updateMatches(tx, body, chosenBy) {
  let updated = 0;
  const by = String(chosenBy || '').slice(0, 200);
  if (Array.isArray(body?.choices)) {
    if (body.choices.length > 500) throw validationFailed('At most 500 choices at a time.');
    for (const c of body.choices) {
      const row = (await tx.query('SELECT * FROM qbo_candidates WHERE tenant_id = $1 AND id = $2', [tx.tenantId, c?.id])).rows[0];
      if (!row) throw validationFailed('Unknown candidate.');
      if (row.applied_at) continue;
      const choice = c.choice ?? row.choice;
      if (!CHOICES_OF[row.kind].includes(choice)) throw validationFailed(`${choice} is not a choice for ${row.kind}.`);
      let qboId = row.qbo_id;
      if (c.qboId != null) {
        if (!/^\d{1,20}$/.test(String(c.qboId))) throw validationFailed('qboId must be a QuickBooks id.');
        const offered = (row.qbo_summary?.alternatives || []).some((a) => String(a.qboId) === String(c.qboId))
          || (await tx.query('SELECT 1 FROM qbo_candidates WHERE tenant_id = $1 AND kind = $2 AND qbo_id = $3', [tx.tenantId, row.kind, String(c.qboId)])).rows.length > 0;
        if (!offered) throw validationFailed('That QuickBooks record was not found by the scan.');
        qboId = String(c.qboId);
        await tx.query("UPDATE qbo_candidates SET choice = 'skip' WHERE tenant_id = $1 AND kind = $2 AND qbo_id = $3 AND fishtape_id IS NULL AND applied_at IS NULL", [tx.tenantId, row.kind, qboId]);
      }
      if (choice === 'link' && (!row.fishtape_id || !qboId)) throw validationFailed('Linking needs both sides.');
      if (choice === 'create_in_qbo' && !row.fishtape_id) throw validationFailed('Nothing in Fishtape to create from.');
      if (choice === 'create_in_fishtape' && !qboId) throw validationFailed('Nothing in QuickBooks to create from.');
      const fieldChoices = { ...(row.field_choices || {}) };
      for (const [f, side] of Object.entries(c.fieldChoices || {})) {
        if (!['fishtape', 'quickbooks'].includes(side)) throw validationFailed('Field choices are fishtape or quickbooks.');
        fieldChoices[f] = side;
      }
      await tx.query(
        'UPDATE qbo_candidates SET choice = $3, qbo_id = $4, field_choices = $5, confirmed = $6, chosen_by = $7 WHERE tenant_id = $1 AND id = $2',
        [tx.tenantId, row.id, choice, qboId, JSON.stringify(fieldChoices), typeof c.confirmed === 'boolean' ? c.confirmed : row.confirmed, by]);
      updated++;
    }
    return { updated };
  }
  const b = body?.bulk;
  if (!b || !CANDIDATE_KINDS.includes(b.kind)) throw validationFailed('Send choices or a bulk change.');
  if (b.fieldsFrom) {
    if (!['fishtape', 'quickbooks'].includes(b.fieldsFrom)) throw validationFailed('fieldsFrom is fishtape or quickbooks.');
    const rows = (await tx.query("SELECT id, diffs, field_choices FROM qbo_candidates WHERE tenant_id = $1 AND kind = $2 AND choice = 'link' AND applied_at IS NULL", [tx.tenantId, b.kind])).rows;
    for (const r of rows) {
      const fc = { ...(r.field_choices || {}) };
      for (const d of r.diffs || []) fc[d.field] = b.fieldsFrom;
      await tx.query('UPDATE qbo_candidates SET field_choices = $3, chosen_by = $4 WHERE tenant_id = $1 AND id = $2', [tx.tenantId, r.id, JSON.stringify(fc), by]);
      updated++;
    }
    return { updated };
  }
  if (!CHOICES_OF[b.kind].includes(b.choice)) throw validationFailed(`${b.choice} is not a choice for ${b.kind}.`);
  const sideOk = b.choice === 'create_in_qbo' ? 'fishtape_id IS NOT NULL' : b.choice === 'create_in_fishtape' ? 'qbo_id IS NOT NULL' : b.choice === 'link' ? 'fishtape_id IS NOT NULL AND qbo_id IS NOT NULL' : 'true';
  const res = await tx.query(
    `UPDATE qbo_candidates SET choice = $3, chosen_by = $5 WHERE tenant_id = $1 AND kind = $2 AND applied_at IS NULL AND ($4::text IS NULL OR status = $4) AND ${sideOk}`,
    [tx.tenantId, b.kind, b.choice, b.status || null, by]);
  return { updated: res.rowCount };
}

/** Link candidates with a differing field that has no side chosen yet (apply is refused, 6.4). */
async function undecided(tx) {
  const { rows } = await tx.query("SELECT kind, diffs, field_choices FROM qbo_candidates WHERE tenant_id = $1 AND choice = 'link' AND applied_at IS NULL", [tx.tenantId]);
  let n = 0;
  for (const r of rows) {
    if (DOC_KINDS.has(r.kind) || r.kind === 'payments' || r.kind === 'employees') continue;
    for (const d of r.diffs || []) {
      const emptyOne = d.fishtape === '(empty)' || d.quickbooks === '(empty)';
      if (!emptyOne && !r.field_choices?.[d.field] && !['notes', 'title'].includes(d.field)) n++;
    }
  }
  return n;
}

/** GET /qbo/setup/plan (6.4): counts per kind and action, warnings and numbers. */
export async function plan(deps, tenantId) {
  return deps.db.withTenant({ tenantId }, async (tx) => {
    const conn = await loadConnection(tx);
    const { mappings } = await loadMappings(tx, conn.realm_hash);
    const rows = (await tx.query('SELECT kind, choice, count(*)::int AS n FROM qbo_candidates WHERE tenant_id = $1 GROUP BY kind, choice', [tx.tenantId])).rows;
    const phases = CANDIDATE_KINDS.map((kind) => {
      const of = (c) => rows.find((r) => r.kind === kind && r.choice === c)?.n || 0;
      return { kind, link: of('link'), createInQbo: of('create_in_qbo'), createInFishtape: of('create_in_fishtape'), skip: of('skip') };
    });
    const warnings = [];
    const add = (code, message, count) => { if (count) warnings.push({ code, message, count }); };
    const missing = await requiredMappings(tx, conn, mappings);
    add('mappings_missing', 'Mappings still to set', missing.length);
    const docs = (await tx.query(
      `SELECT c.kind, d.data FROM qbo_candidates c JOIN (SELECT id, data, 'invoices' AS k FROM invoices WHERE tenant_id = $1 UNION ALL SELECT id, data, 'estimates' FROM estimates WHERE tenant_id = $1) d ON d.id = c.fishtape_id AND d.k = c.kind
        WHERE c.tenant_id = $1 AND c.choice IN ('create_in_qbo', 'link')`, [tx.tenantId])).rows.map((r) => r.data);
    const codes = mappings.taxCode || {};
    add('tax_unmapped', 'Documents using a tax situation with no QuickBooks code', docs.filter((d) => kindsUsed(d).some((k) => !codes[lineTaxKey(d, k)] && !lineTaxKey(d, k).startsWith('NONE') )).length);
    add('tax_reason', 'Documents with no tax and no reason', docs.filter((d) => needsTaxReason(d)).length);
    add('employees_unlinked', 'Crew not linked to QuickBooks employees', (await tx.query("SELECT count(*)::int AS n FROM qbo_candidates WHERE tenant_id = $1 AND kind = 'employees' AND choice <> 'link'", [tx.tenantId])).rows[0].n);
    add('possible_duplicates', 'Possible duplicates to check', (await tx.query("SELECT count(*)::int AS n FROM qbo_candidates WHERE tenant_id = $1 AND 'possible_duplicate' = ANY(reasons) AND applied_at IS NULL", [tx.tenantId])).rows[0].n);
    add('number_collisions', 'Same number with different totals', (await tx.query("SELECT count(*)::int AS n FROM qbo_candidates WHERE tenant_id = $1 AND 'totals_differ' = ANY(reasons) AND applied_at IS NULL", [tx.tenantId])).rows[0].n);
    add('differences', 'Differences still to decide', await undecided(tx));
    const filed = (await tx.query("SELECT confirmed, count(*)::int AS n FROM qbo_candidates WHERE tenant_id = $1 AND choice = 'create_in_qbo' AND 'filed_period' = ANY(reasons) GROUP BY confirmed", [tx.tenantId])).rows;
    add('filed_period_unticked', 'Creates in a filed GST period not ticked (skipped)', filed.find((r) => !r.confirmed)?.n || 0);
    add('filed_period_ticked', 'Creates in a filed GST period, ticked', filed.find((r) => r.confirmed)?.n || 0);
    const s = (await tx.query("SELECT data FROM settings WHERE tenant_id = $1 AND id = 'settings' AND deleted_at IS NULL", [tx.tenantId])).rows[0]?.data || {};
    const highest = async (kind, prefix) => {
      const r = (await tx.query("SELECT qbo_summary->>'docNumber' AS n FROM qbo_candidates WHERE tenant_id = $1 AND kind = $2 AND qbo_id IS NOT NULL", [tx.tenantId, kind])).rows;
      return r.map((x) => { const m = new RegExp(`^(?:${prefix}-)?(\\d+)$`).exec(String(x.n || '')); return m ? Number(m[1]) : 0; }).reduce((a, b) => Math.max(a, b), 0) || null;
    };
    return {
      phases, warnings, required: missing,
      numbers: {
        invoice: { qboHighest: await highest('invoices', 'INV'), fishtapeNext: s.nextNumbers?.invoice ?? null },
        estimate: { qboHighest: await highest('estimates', 'E'), fishtapeNext: s.nextNumbers?.estimate ?? null },
      },
    };
  });
}

/** Refuse apply while setup is incomplete (409 setup_incomplete, 6.4). */
export async function assertReadyToApply(tx, conn) {
  const { mappings } = await loadMappings(tx, conn.realm_hash);
  const missing = await requiredMappings(tx, conn, mappings);
  if (missing.length) throw new ApiError(409, 'setup_incomplete', 'Set the required QuickBooks mappings first.', { missing });
  const n = await undecided(tx);
  if (n) throw new ApiError(409, 'setup_incomplete', 'Choose a side for every difference first.', { differences: n });
  const scanned = (await tx.query('SELECT count(*)::int AS n FROM qbo_candidates WHERE tenant_id = $1', [tx.tenantId])).rows[0].n;
  if (!scanned && !conn.setup?.scanStartedAt) throw new ApiError(409, 'setup_incomplete', 'Run the scan first.');
}

// ---- apply (6.4) --------------------------------------------------------------------------------------

const PHASES = [
  { n: 1, name: 'links' },
  { n: 2, name: 'names', kinds: ['vendors', 'customers'] },
  { n: 3, name: 'jobs', kinds: ['jobs'] },
  { n: 4, name: 'items', kinds: ['items'] },
  { n: 5, name: 'documents', kinds: ['estimates', 'invoices'] },
  { n: 6, name: 'payments', kinds: ['payments'] },
  { n: 7, name: 'costs' },
  { n: 8, name: 'finish' },
];

/**
 * Apply the choices (6.4), phase by phase in chunks; each chunk ends by queuing the next while work
 * is left. The caller holds the lease. Shadow mode applies phase 1 only and goes active in shadow.
 * @returns {Promise<{ phase, done, total, errors, finished }>}
 */
export async function apply(deps, tenantId, { epoch, budgetMs } = {}) {
  const run = await makeRun(deps, tenantId, { epoch, purpose: 'sync', ignoreBrake: true, budgetMs });
  if (!run) throw new ApiError(409, 'qbo_not_connected', 'QuickBooks is not connected.');
  const setup = run.conn.setup || {};
  if (setup.cancelRequested) { await setupProgress(run, { phase: 'cancelled', cancelRequested: false, finishedAt: new Date().toISOString() }); return { phase: 'cancelled', finished: true }; }
  const shadowLinked = setup.phase === 'shadow_linked';
  if (run.conn.state !== 'setup' && !(run.conn.state === 'active' && shadowLinked && !run.shadow)) return { phase: setup.phase, finished: true, skipped: run.conn.state };
  let phase = Number(setup.applyPhase || 1);
  if (shadowLinked && phase < 2) phase = 2;
  const counts = await run.db.withTenant({ tenantId }, async (tx) => (await tx.query(
    "SELECT count(*) FILTER (WHERE choice <> 'skip')::int AS total, count(*) FILTER (WHERE choice <> 'skip' AND applied_at IS NOT NULL)::int AS done, count(*) FILTER (WHERE error IS NOT NULL)::int AS errors FROM qbo_candidates WHERE tenant_id = $1",
    [tx.tenantId])).rows[0]);
  await setupProgress(run, { phase: 'applying', applyPhase: phase, total: counts.total, done: counts.done, errors: counts.errors, startedAt: setup.startedAt || new Date().toISOString() });
  for (; phase <= 8; phase++) {
    await setupProgress(run, { applyPhase: phase });
    const p = PHASES[phase - 1];
    let left = false;
    if (p.n === 1) left = await applyLinks(run);
    else if (p.kinds) left = await applyCreates(run, p.kinds);
    else if (p.n === 7) left = await applyCosts(run);
    else if (p.n === 8) { await finishApply(run); return { phase: 'done', finished: true }; }
    if (left) return { phase: 'applying', finished: false, more: true };
    if (p.n === 1 && run.shadow) {
      // Practice week: links only; the rest runs when the office switches to live (5.8).
      await txWrite(run, async (tx) => {
        await tx.query(
          `UPDATE qbo_connections SET state = 'active', setup = setup || $2::jsonb, cdc_cursor = COALESCE(cdc_cursor, $3), updated_at = now() WHERE tenant_id = $1`,
          [tenantId, JSON.stringify({ phase: 'shadow_linked', applyPhase: 2 }), setup.scanStartedAt || new Date().toISOString()]);
        await writeLog(tx, { direction: 'system', outcome: 'info', action: 'setup_apply', message: 'Practice mode: records linked; nothing was written. Go live to finish setup.' });
      });
      return { phase: 'shadow_linked', finished: true };
    }
  }
  return { phase: 'done', finished: true };
}

async function pending(run, kinds, choices) {
  return run.db.withTenant({ tenantId: run.tenantId }, async (tx) => (await tx.query(
    `SELECT * FROM qbo_candidates WHERE tenant_id = $1 AND kind = ANY($2) AND choice = ANY($3) AND applied_at IS NULL AND error IS NULL AND realm_hash = $4
      ORDER BY array_position($2::text[], kind), (qbo_summary->>'date') NULLS FIRST, id LIMIT 500`, [tx.tenantId, kinds, choices, run.conn.realm_hash])).rows);
}

async function markCandidate(run, c, { error = null } = {}) {
  await txWrite(run, (tx) => tx.query(
    'UPDATE qbo_candidates SET applied_at = CASE WHEN $3::text IS NULL THEN now() ELSE applied_at END, error = $3 WHERE tenant_id = $1 AND id = $2',
    [tx.tenantId, c.id, error ? String(error).slice(0, 500) : null]));
  await run.db.withTenant({ tenantId: run.tenantId }, (tx) => tx.query(
    `UPDATE qbo_connections SET setup = setup || jsonb_build_object('done', COALESCE((setup->>'done')::int, 0) + CASE WHEN $2::boolean THEN 1 ELSE 0 END,
        'errors', COALESCE((setup->>'errors')::int, 0) + CASE WHEN $2::boolean THEN 0 ELSE 1 END) WHERE tenant_id = $1`, [run.tenantId, !error]));
}

/** Read QuickBooks objects by id, 50 per query. */
async function readMany(run, entity, ids) {
  const out = new Map();
  const list = [...new Set(ids.map(String))];
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    const found = await run.client.query(`select * from ${entity} where Id in (${chunk.map((x) => `'${x}'`).join(', ')})`, { max: 1000 });
    for (const o of found) out.set(String(o.Id), o);
  }
  return out;
}

/** Phase 1: links with per-field baselines; nothing is written to either side. */
async function applyLinks(run) {
  for (;;) {
    const rows = await pending(run, CANDIDATE_KINDS, ['link']);
    if (!rows.length) return false;
    for (const kind of CANDIDATE_KINDS) {
      const group = rows.filter((c) => c.kind === kind);
      if (!group.length) continue;
      const entity = ENTITY_OF[kind];
      const objs = await readMany(run, entity, group.map((c) => c.qbo_id));
      for (const c of group) {
        if (timeUp(run)) return true;
        const obj = objs.get(String(c.qbo_id));
        if (!obj) { await markCandidate(run, c, { error: 'Not found in QuickBooks any more.' }); continue; }
        try { await linkCandidate(run, c, obj); await markCandidate(run, c); } catch (e) {
          if (e?.name === 'FencedError') throw e;
          await markCandidate(run, c, { error: e.message });
        }
      }
    }
  }
}

async function linkCandidate(run, c, obj) {
  const collection = COLLECTION_OF[c.kind];
  const entity = ENTITY_OF[c.kind];
  const rec = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => loadRecord(tx, collection, c.fishtape_id));
  if (!rec || rec.deleted) throw new Error('The Fishtape record is gone.');
  const qboLine = c.kind === 'payments' ? String(c.qbo_summary?.qboLine || '') : '';
  await txWrite(run, async (tx) => {
    if (await getLink(tx, collection, c.fishtape_id)) return;
    if (c.kind === 'employees') {
      await insertLink(tx, run, { collection, record_id: c.fishtape_id, qbo_entity: entity, qbo_id: String(obj.Id), sync_token: String(obj.SyncToken), state: 'synced', owner: 'quickbooks', snapshot: {}, meta: { displayName: obj.DisplayName || null } });
      return;
    }
    const ctx = ctxFor(run, { role: 'main', qbo_line: qboLine, meta: {} }, collection);
    const L = fishtapeToCanon(collection, rec.data, ctx);
    const R = qboToCanon(entity, obj, { ...ctx, collection });
    const b = wizardBaseline(collection, L, R, c.field_choices || {});
    if (b.needsChoice.length) throw new Error(`Choose a side for: ${b.needsChoice.map(fieldLabel).join(', ')}`);
    const meta = { ...linkMetaFromQbo(entity, obj, ctx), ...(Object.keys(b.remoteAlias).length ? { remoteAlias: b.remoteAlias } : {}), ...(obj.CustomerRef ? { customerRef: ref(obj.CustomerRef) } : {}), wizard: true };
    if (collection === 'jobs' && obj.ParentRef) meta.parentRef = ref(obj.ParentRef);
    const owner = ['jobs'].includes(collection) ? 'fishtape' : (b.differs ? 'quickbooks' : 'both');
    const l = await insertLink(tx, run, {
      collection, record_id: c.fishtape_id, qbo_entity: entity, qbo_id: String(obj.Id), qbo_line: qboLine, sync_token: String(obj.SyncToken),
      qbo_updated_at: obj.MetaData?.LastUpdatedTime || null, fishtape_version: rec.version, state: b.differs ? 'needs_review' : 'synced', owner,
      snapshot: b.snapshot, meta, reason: b.differs ? 'wizard_differs' : null,
    });
    if (b.differs) await openReview(tx, run, l, { reason: 'wizard_differs', label: `${c.kind === 'invoices' ? 'Invoice' : c.kind === 'estimates' ? 'Estimate' : 'Payment'} ${rec.data.number || ''}`.trim(), message: 'Fishtape and QuickBooks differ. Nothing is written until you choose.' });
    // The first reconcile copies a value one side lacks, and writes the side chosen (6.4).
    if (!b.differs) await upsertOutbox(tx, { collection, recordId: c.fishtape_id, op: 'upsert', actorType: 'system', rank: QBO_RANK[collection], delayS: 0 });
  });
}

/** Phases 2 to 6: creates both ways, oldest first, each under the create protocol. */
async function applyCreates(run, kinds) {
  for (;;) {
    const rows = await pending(run, kinds, ['create_in_qbo', 'create_in_fishtape']);
    if (!rows.length) break;
    for (const c of rows) {
      if (timeUp(run)) return true;
      const collection = COLLECTION_OF[c.kind];
      try {
        if (c.choice === 'create_in_qbo') {
          if ((c.reasons || []).includes('filed_period') && !c.confirmed) { await markCandidate(run, c, { error: 'Not ticked: dated in a filed GST period.' }); continue; }
          const state = await processRecord(run, collection, c.fishtape_id, { asDependency: true, force: Boolean(c.confirmed), actorType: 'user', sendNow: true });
          const link = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => getLink(tx, collection, c.fishtape_id));
          if (link?.qbo_id) await markCandidate(run, c);
          else await markCandidate(run, c, { error: link?.last_error || `Not sent (${link?.reason || state}).` });
        } else {
          const entity = ENTITY_OF[c.kind];
          const obj = (await readMany(run, entity, [c.qbo_id])).get(String(c.qbo_id));
          if (!obj) { await markCandidate(run, c, { error: 'Not found in QuickBooks any more.' }); continue; }
          if (DOC_KINDS.has(c.kind) || c.kind === 'payments') {
            // Documents and payments come in through the pull rules (customer first, one payment per linked invoice, 4.9).
            const { processRemote } = await import('./pull.js');
            await processRemote(run, entity, obj);
          } else await createFromRemote(run, collection, entity, obj);
          const link = await run.db.withTenant({ tenantId: run.tenantId }, async (tx) => (await tx.query(
            "SELECT 1 FROM qbo_links WHERE tenant_id = $1 AND qbo_entity = $2 AND qbo_id = $3 AND role = 'main'", [tx.tenantId, entity, String(obj.Id)])).rows[0]);
          if (link) await markCandidate(run, c); else await markCandidate(run, c, { error: 'Could not be created in Fishtape.' });
        }
      } catch (e) {
        if (['FencedError', 'PassStop'].includes(e?.name)) throw e;
        await markCandidate(run, c, { error: e.message });
      }
    }
  }
  // After the payments: the settlement step for every linked invoice (4.9).
  if (kinds.includes('payments')) {
    const invLinks = await run.db.withTenant({ tenantId: run.tenantId }, async (tx) => (await tx.query(
      "SELECT * FROM qbo_links WHERE tenant_id = $1 AND collection = 'invoices' AND role = 'main' AND qbo_id IS NOT NULL AND state <> 'unlinked'", [tx.tenantId])).rows);
    const objs = await readMany(run, 'Invoice', invLinks.map((l) => l.qbo_id));
    for (const l of invLinks) {
      if (timeUp(run)) return true;
      const o = objs.get(String(l.qbo_id));
      if (o) await settle(run, l, o);
    }
  }
  return false;
}

/** Phase 7: bills, purchase orders and approved time go to the outbox for the first pass. */
async function applyCosts(run) {
  const syncFrom = str(optionOf(run.ctx.mappings, 'syncFrom', null)) || monthStart();
  const locked = str(optionOf(run.ctx.mappings, 'timeLockedThrough', null));
  await txWrite(run, async (tx) => {
    const q = async (table, coll, where, params) => {
      const { rows } = await tx.query(`SELECT id FROM ${table} WHERE tenant_id = $1 AND deleted_at IS NULL AND ${where}`, [tx.tenantId, ...params]);
      for (const r of rows) await upsertOutbox(tx, { collection: coll, recordId: r.id, op: 'upsert', actorType: 'system', rank: QBO_RANK[coll], delayS: 0 });
    };
    await q('bills', 'bills', "coalesce(data->>'status', 'draft') <> 'draft' AND coalesce(data->>'date', '') >= $2", [syncFrom]);
    await q('purchase_orders', 'purchaseOrders', "data->>'status' IN ('open', 'sent', 'closed') AND coalesce(data->>'date', '9999') >= $2", [syncFrom]);
    if (optionOf(run.ctx.mappings, 'timeOwner', null) === 'fishtape' && optionOf(run.ctx.mappings, 'syncTime', true) !== false) {
      await q('time_entries', 'timeEntries', "(data->>'approved')::boolean IS TRUE AND substr(coalesce(data->>'clockIn', ''), 1, 10) >= $2 AND substr(coalesce(data->>'clockIn', ''), 1, 10) > $3", [syncFrom, locked || '0000-00-00']);
    }
  });
  return false;
}

/** Phase 8: active, cursors from the scan, audit, notify; the first pass runs the sweep. */
async function finishApply(run) {
  const setup = (await run.db.withTenant({ tenantId: run.tenantId }, loadConnection))?.setup || {};
  await txWrite(run, async (tx) => {
    await tx.query(
      `UPDATE qbo_connections SET state = 'active', cdc_cursor = COALESCE($2, now()), fishtape_cursor = $3, sync_from = COALESCE(sync_from, $4::date),
          setup = setup || $5::jsonb, updated_at = now() WHERE tenant_id = $1`,
      [run.tenantId, setup.scanStartedAt || null, Number(setup.scanChangeSeq || 0), str(optionOf(run.ctx.mappings, 'syncFrom', null)) || monthStart(),
        JSON.stringify({ phase: 'done', finishedAt: new Date().toISOString() })]);
    await appendAudit(tx, run.tenantId, { actor: { type: 'system', id: 'qbo', label: 'QuickBooks sync' }, action: 'qbo.setup.apply', collection: 'qbo_connections', summary: `QuickBooks setup applied (${setup.done || 0} records, ${setup.errors || 0} failed)` });
    await notify(tx, { role: ['owner', 'admin', 'office'], kind: 'quickbooks', link: '#/quickbooks', ref: `qbo:setup:${Date.now()}`, title: 'QuickBooks setup finished', body: setup.errors ? `${setup.errors} record(s) need a look on the QuickBooks screen.` : 'Fishtape and QuickBooks are now in sync.' });
    await writeLog(tx, { direction: 'system', outcome: 'info', action: 'setup_apply', message: 'Setup applied; sync is on.' });
    await enqueueSync(tx, run.tenantId, { sweep: true });
  });
}

/** Queue the next apply chunk under its own key (the running job holds the plain one, 5.8). */
export function enqueueApply(q, tenantId, { next = false } = {}) {
  return enqueue(q, { kind: 'qbo_setup_apply', tenantId, dedupeKey: next ? `qbo_setup_apply:${tenantId}:cont` : `qbo_setup_apply:${tenantId}`, runAt: new Date(Date.now() + (next ? 5_000 : 0)), maxAttempts: 5 });
}

export { assertEpoch, KINDS, localDay, zoneOf };
