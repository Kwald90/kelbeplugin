// The daily balance check (docs/integrations/quickbooks.md 5.13): QuickBooks' balance and total of
// every open or recently changed invoice and bill against Fishtape's amount due and total, and the
// Stripe clearing account against what Fishtape booked. Differences above 2 cents go on the
// "Doesn't match" list (link meta.mismatch, read by GET /qbo/checks) and the record's badge. The
// check writes nothing else on either side. It also runs the daily sweep and the TaxAgency read
// behind taxFiledThrough (2.8, through the reference refresh).
import { docTotals } from '../../../electrical-app/js/lib/money.js';
import { amountDueCents } from '../integrations/payments.js';
import { notify } from '../services/notify.js';
import { writeLog, recordLabel } from './log.js';
import { makeRun, txWrite, optionOf } from './engine.js';
import { sweep } from './sweep.js';
import { refreshReference } from './reference.js';
import { toCents } from './map/canon.js';

const TOLERANCE = 2;
const ref = (r) => (r && typeof r === 'object' ? String(r.value ?? '') : String(r ?? ''));

/**
 * @param {object} deps { db, sealer, config, records }
 * @param {{ epoch: number }} o the lease epoch
 * @returns {Promise<{ mismatches: number, checked: number }>}
 */
export async function runCheck(deps, tenantId, { epoch } = {}) {
  const run = await makeRun(deps, tenantId, { epoch, purpose: 'check' });
  if (!run || run.conn.state !== 'active') return { mismatches: 0, checked: 0, skipped: run?.conn?.state || 'not_connected' };
  const checkedAt = new Date().toISOString();
  const since = new Date(Date.now() - 35 * 86_400_000).toISOString();
  const pages = async (entity) => {
    const open = await run.client.query(`select * from ${entity} where Balance > '0'`, { all: true, max: 20000 });
    const recent = await run.client.query(`select * from ${entity} where MetaData.LastUpdatedTime > '${since}'`, { all: true, max: 20000 });
    const byId = new Map();
    for (const o of [...open, ...recent]) byId.set(String(o.Id), o);
    return [...byId.values()];
  };
  const invoices = await pages('Invoice');
  const bills = run.ctx.features?.bills === false ? [] : await pages('Bill');
  let mismatches = 0;
  let checked = 0;

  await txWrite(run, async (tx) => {
    const compare = async (entity, collection, list) => {
      for (const o of list) {
        const { rows } = await tx.query(
          "SELECT * FROM qbo_links WHERE tenant_id = $1 AND qbo_entity = $2 AND qbo_id = $3 AND role = 'main' AND collection = $4 AND state NOT IN ('unlinked', 'deleted_local')",
          [tx.tenantId, entity, String(o.Id), collection]);
        const link = rows[0];
        if (!link) continue;
        const r = await tx.query(`SELECT id, data FROM ${collection} WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`, [tx.tenantId, link.record_id]);
        if (!r.rows[0]) continue;
        const doc = { ...r.rows[0].data, id: r.rows[0].id };
        checked++;
        const qboBalance = toCents(o.Balance ?? 0);
        const qboTotal = toCents(o.TotalAmt ?? 0);
        let ftTotal, ftDue;
        if (collection === 'invoices') {
          ftTotal = doc.status === 'void' ? 0 : docTotals(doc).totalCents + (Number(link.meta?.taxDeltaCents) || 0);
          ftDue = doc.status === 'void' ? 0 : await amountDueCents(tx, doc);
        } else {
          ftTotal = (doc.lines || []).reduce((s, l) => s + (Number(l.amountCents) || 0), 0) + (doc.taxes || []).reduce((s, t) => s + (Number(t.cents) || 0), 0);
          ftDue = doc.status === 'paid' ? 0 : ftTotal;
        }
        const found = [];
        if (Math.abs(qboBalance - ftDue) > TOLERANCE) found.push({ kind: 'balance', fishtapeCents: ftDue, quickbooksCents: qboBalance, checkedAt });
        if (Math.abs(Math.abs(qboTotal) - Math.abs(ftTotal)) > TOLERANCE) found.push({ kind: 'total', fishtapeCents: ftTotal, quickbooksCents: qboTotal, checkedAt });
        mismatches += found.length;
        const meta = { ...(link.meta || {}), qboBalanceCents: qboBalance, qboTotalCents: qboTotal, checkedAt };
        if (found.length) meta.mismatch = found.map((m) => ({ ...m, label: recordLabel(collection, doc) })); else delete meta.mismatch;
        await tx.query('UPDATE qbo_links SET meta = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2', [tx.tenantId, link.id, JSON.stringify(meta)]);
      }
    };
    await compare('Invoice', 'invoices', invoices);
    await compare('Bill', 'bills', bills);
  });

  // Stripe clearing: QuickBooks' balance against the opening balance plus what Fishtape booked (4.9).
  const clearing = run.ctx.mappings.account?.stripeClearing;
  let clearingRow = null;
  if (clearing) {
    const acct = await run.client.read('Account', clearing).catch(() => null);
    if (acct) {
      const expected = await run.db.withTenant({ tenantId }, async (tx) => {
        const { rows } = await tx.query(
          `SELECT collection, role, snapshot FROM qbo_links WHERE tenant_id = $1 AND state NOT IN ('unlinked', 'deleted_local', 'deleted_remote') AND qbo_id IS NOT NULL
             AND ((collection = 'payments' AND role IN ('main', 'fee')) OR collection = 'stripePayouts')`, [tx.tenantId]);
        let cents = Number(optionOf(run.ctx.mappings, 'stripeClearingOpeningCents', 0)) || 0;
        for (const r of rows) {
          const amt = Number(r.snapshot?.amountCents) || 0;
          if (r.collection === 'payments' && r.role === 'main') { if (r.snapshot?.extra?.source === 'stripe') cents += amt; } else cents -= amt;
        }
        return cents;
      });
      const actual = toCents(acct.CurrentBalance ?? 0);
      clearingRow = { kind: 'clearing', fishtapeCents: expected, quickbooksCents: actual, checkedAt, mismatch: Math.abs(actual - expected) > TOLERANCE };
      if (clearingRow.mismatch) mismatches++;
    }
  }

  await txWrite(run, async (tx) => {
    if (clearingRow) {
      await tx.query(
        `INSERT INTO qbo_mappings (tenant_id, realm_hash, kind, key, value, updated_by) VALUES ($1, $2, 'option', 'clearingCheck', $3, 'system:qbo')
         ON CONFLICT (tenant_id, kind, key) DO UPDATE SET value = EXCLUDED.value, realm_hash = EXCLUDED.realm_hash, updated_at = now()`,
        [tx.tenantId, run.conn.realm_hash, JSON.stringify(clearingRow)]);
    }
    await tx.query('UPDATE qbo_connections SET last_check_at = now(), updated_at = now() WHERE tenant_id = $1', [tenantId]);
    await writeLog(tx, { direction: 'system', outcome: mismatches ? 'warning' : 'info', action: 'balance_check', message: `Checked ${checked} records; ${mismatches} don't match QuickBooks.` });
    const counts = (await tx.query(
      `SELECT count(*) FILTER (WHERE state = 'error' AND updated_at > now() - interval '1 day')::int AS errors,
              (SELECT count(*)::int FROM qbo_conflicts c WHERE c.tenant_id = $1 AND c.status = 'open') AS open
         FROM qbo_links WHERE tenant_id = $1`, [tx.tenantId])).rows[0];
    if (counts.errors || counts.open || mismatches) {
      await notify(tx, {
        role: ['owner', 'admin', 'office'], kind: 'quickbooks', link: '#/quickbooks', ref: `qbo:summary:${checkedAt.slice(0, 10)}`,
        title: 'QuickBooks: things to check', body: `${counts.errors} new error(s), ${counts.open} open conflict(s) and review(s), ${mismatches} record(s) that don't match QuickBooks.`,
      });
    }
  });
  await sweep(deps, tenantId, { epoch });
  await refreshReference(deps, tenantId, { epoch, force: true }).catch(() => {});
  return { mismatches, checked };
}

/** The "Doesn't match" list (7.5 GET /qbo/checks), newest check first. */
export async function checkList(tx, { cursor = null, limit = 50 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const offset = Math.max(0, Number.parseInt(cursor || '0', 10) || 0);
  const { rows } = await tx.query(
    `SELECT collection, record_id, meta FROM qbo_links WHERE tenant_id = $1 AND meta ? 'mismatch' ORDER BY updated_at DESC, id OFFSET $2 LIMIT $3`,
    [tx.tenantId, offset, lim + 1]);
  const data = [];
  if (!offset) {
    const c = (await tx.query("SELECT value FROM qbo_mappings WHERE tenant_id = $1 AND kind = 'option' AND key = 'clearingCheck'", [tx.tenantId])).rows[0]?.value;
    if (c?.mismatch) data.push({ collection: null, recordId: null, label: 'Stripe clearing account', kind: 'clearing', fishtapeCents: c.fishtapeCents, quickbooksCents: c.quickbooksCents, checkedAt: c.checkedAt });
  }
  for (const r of rows.slice(0, lim)) {
    for (const m of r.meta.mismatch || []) data.push({ collection: r.collection, recordId: r.record_id, label: m.label || null, kind: m.kind, fishtapeCents: m.fishtapeCents, quickbooksCents: m.quickbooksCents, checkedAt: m.checkedAt });
  }
  return { data, cursor: rows.length > lim ? String(offset + lim) : null, more: rows.length > lim };
}

export { ref };
