// Drafts: estimate lines and invoices the assistant (or an MCP agent) proposes. A draft
// is a row in ai_drafts; estimates and invoices are untouched until a person accepts
// it in the app, and acceptance goes through the normal records service (permissions,
// validation, audit). Prices come from the company's price book and labour rate, tax
// from js/lib/tax.js for the company's province, totals from js/lib/money.js.
import { ApiError, conflict, forbidden, notFound } from '../errors.js';
import { canRead, canWrite } from '../auth/access.js';
import { appendAudit } from '../services/audit.js';
import { combinedPct, docTotals, entryHours, formatMoney, KINDS } from '../../../electrical-app/js/lib/money.js';
import { newDocTax, taxComponents, describeTaxes, TREATMENTS, provinceName } from '../../../electrical-app/js/lib/tax.js';
import { companySettings, readMany, readRecord } from './data.js';

const LINE_FIELDS = ['itemId', 'description', 'qty', 'unitCents', 'labourHours', 'kind'];
const MAX_LINES = 200;
const today = (offsetDays = 0, now = new Date()) => new Date(now.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const actorString = (actor) => `${actor.type}:${actor.id ?? ''}`;
const money = (c) => formatMoney(c);

export const LINE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    itemId: { type: 'string', maxLength: 128, description: 'Price-book item id from search_price_book. Prices and labour hours come from the price book.' },
    sku: { type: 'string', maxLength: 100, description: 'Price-book SKU, when you have it instead of the id.' },
    description: { type: 'string', maxLength: 500, description: 'Required for lines that are not in the price book.' },
    qty: { type: 'number', exclusiveMinimum: 0, maximum: 1000000 },
    unitCents: { type: 'integer', minimum: 0, maximum: 100000000, description: 'Only for lines not in the price book (your estimate, flagged for review). Labour lines default to the company labour rate.' },
    labourHours: { type: 'number', minimum: 0, maximum: 1000, description: 'Crew hours per unit, for scheduling (not added to the price).' },
    kind: { type: 'string', enum: KINDS, description: 'material (default), labour (qty = hours) or other.' },
  },
  required: ['qty'],
};

/** Plain-data view of a draft row for the app and the model. */
export function draftView(r) {
  return {
    id: r.id, kind: r.kind, status: r.status, target: { collection: r.target_collection, id: r.target_id, baseVersion: r.base_version },
    summary: r.summary, proposal: r.proposal, conversationId: r.conversation_id, createdBy: r.created_by,
    createdAt: r.created_at, decidedAt: r.decided_at, resultId: r.result_id,
  };
}

async function itemsFor(tx, p, lines) {
  if (!canRead(p, 'items')) return { byId: new Map(), bySku: new Map() };
  const ids = lines.map((l) => l.itemId).filter(Boolean);
  const skus = lines.map((l) => l.sku).filter(Boolean);
  const byId = new Map((await readMany(tx, p, 'items', ids)).map((i) => [i.id, i]));
  const bySku = new Map();
  if (skus.length) {
    const { rows } = await tx.query('SELECT id, data, version FROM items WHERE tenant_id = $1 AND sku = ANY($2) AND deleted_at IS NULL', [tx.tenantId, skus]);
    for (const r of rows) bySku.set(r.data.sku, { ...r.data, id: r.id });
  }
  return { byId, bySku };
}

/** Turn requested lines into priced document lines, noting where each price came from. */
function priceLines(input, items, labourRateCents) {
  const warnings = [];
  const lines = input.slice(0, MAX_LINES).map((l, i) => {
    const it = (l.itemId && items.byId.get(l.itemId)) || (l.sku && items.bySku.get(l.sku)) || null;
    const kind = KINDS.includes(l.kind) ? l.kind : 'material';
    if ((l.itemId || l.sku) && !it) warnings.push(`Line ${i + 1}: that item is not in your price book, so it needs a price.`);
    if (it) {
      if (l.unitCents != null && l.unitCents !== it.priceCents) warnings.push(`Line ${i + 1}: used the price-book price for ${it.name}.`);
      return { itemId: it.id, description: l.description || it.name, qty: l.qty, unitCents: Number(it.priceCents) || 0, labourHours: Number(it.labourHours) || 0, kind: 'material', source: 'price_book' };
    }
    const description = String(l.description || '').trim() || (kind === 'labour' ? 'Labour' : `Line ${i + 1}`);
    if (kind === 'labour' && l.unitCents == null) {
      return { itemId: null, description, qty: l.qty, unitCents: labourRateCents, labourHours: 1, kind, source: 'labour_rate' };
    }
    if (l.unitCents == null) warnings.push(`Line ${i + 1} (${description.slice(0, 40)}) has no price yet.`);
    return { itemId: null, description, qty: l.qty, unitCents: l.unitCents ?? 0, labourHours: l.labourHours ?? 0, kind, source: l.unitCents == null ? 'unpriced' : 'ai_estimate' };
  });
  if (input.length > MAX_LINES) warnings.push(`Only the first ${MAX_LINES} lines were drafted.`);
  return { lines, warnings };
}

const docLine = (l) => Object.fromEntries(LINE_FIELDS.map((k) => [k, l[k] ?? (k === 'itemId' ? null : k === 'labourHours' ? 0 : l[k])]));

function totalsView(t) {
  return {
    materialCents: t.materialCents, labourCents: t.labourCents, otherCents: t.otherCents, markupCents: t.markupCents,
    subtotalCents: t.subtotalCents, taxes: t.taxes.map((x) => ({ label: x.label, pct: x.pct, baseCents: x.baseCents, cents: x.cents, note: x.note || undefined })),
    taxCents: t.taxCents, totalCents: t.totalCents, hours: Math.round(t.hours * 100) / 100,
  };
}

function taxView(doc) {
  return {
    province: doc.taxProvince || null, provinceName: doc.taxProvince ? provinceName(doc.taxProvince) : null,
    treatment: doc.taxTreatment || null, treatmentLabel: TREATMENTS[doc.taxTreatment]?.label || null,
    description: describeTaxes(doc.taxes), taxes: doc.taxes, taxPct: doc.taxPct,
  };
}

/** Optional client/job links: kept only when they exist in this company. */
async function linkIfExists(tx, p, coll, id, warnings) {
  if (!id) return null;
  try { await readRecord(tx, p, coll, id); return id; } catch {
    warnings.push(`The ${coll === 'clients' ? 'client' : 'job'} given was not found, so it was left blank.`);
    return null;
  }
}

async function insertDraft(tx, { kind, target, baseVersion, proposal, summary, conversationId, actor, request }) {
  const { rows } = await tx.query(
    `INSERT INTO ai_drafts (tenant_id, kind, target_collection, target_id, base_version, proposal, summary, conversation_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [tx.tenantId, kind, kind === 'estimate' ? 'estimates' : 'invoices', target, baseVersion, proposal, summary.slice(0, 500), conversationId || null, actorString(actor)]);
  await appendAudit(tx, tx.tenantId, {
    actor, action: 'ai.draft_create', collection: 'ai_drafts', recordId: rows[0].id, summary: summary.slice(0, 200),
    meta: { kind, target: target || null, lines: proposal.lines.length }, request,
  });
  return rows[0];
}

/**
 * Propose estimate lines: a new draft estimate, or lines added to an existing estimate.
 * @param {import('../db.js').TenantTx} tx
 * @param {{ actor: object, conversationId?: string|null, request?: object }} who
 */
export async function proposeEstimate(tx, p, input, who) {
  if (!canWrite(p, 'estimates')) throw forbidden('You cannot draft estimates (needs the estimates permission or an estimates:write key).');
  const settings = await companySettings(tx);
  const warnings = [];
  let existing = null;
  if (input.estimateId) {
    existing = await readRecord(tx, p, 'estimates', input.estimateId);
    if (existing.status && existing.status !== 'draft') warnings.push(`Estimate ${existing.number || ''} is ${existing.status}; accepting adds lines to it anyway.`);
  }
  const labourRateCents = existing?.labourRateCents ?? settings.labourRateCents ?? 9500;
  const items = await itemsFor(tx, p, input.lines);
  const priced = priceLines(input.lines, items, labourRateCents);
  warnings.push(...priced.warnings);

  let doc;
  if (existing) {
    doc = { ...existing, lines: [...(existing.lines || []), ...priced.lines.map(docLine)] };
  } else {
    const tax = input.treatment && TREATMENTS[input.treatment]
      ? (() => { const taxes = taxComponents({ province: settings.company.province, treatment: input.treatment }); return { taxProvince: settings.company.province, taxTreatment: input.treatment, taxes, taxPct: combinedPct(taxes) }; })()
      : newDocTax(settings);
    doc = {
      title: String(input.title || '').slice(0, 200), clientId: await linkIfExists(tx, p, 'clients', input.clientId, warnings),
      jobId: await linkIfExists(tx, p, 'jobs', input.jobId, warnings), labourRateCents, markupPct: 0, ...tax,
      notes: String(input.notes || '').slice(0, 5000), lines: priced.lines.map(docLine),
    };
  }
  const after = docTotals(doc);
  const before = existing ? docTotals(existing) : null;
  const proposal = {
    mode: existing ? 'append' : 'new', title: existing ? existing.title || '' : doc.title, number: existing?.number || null,
    clientId: doc.clientId || null, jobId: doc.jobId || null, notes: existing ? undefined : doc.notes,
    labourRateCents, lines: priced.lines, tax: taxView(doc), before: before ? totalsView(before) : null, after: totalsView(after),
    warnings, ...(existing ? {} : { docFields: { taxProvince: doc.taxProvince, taxTreatment: doc.taxTreatment, taxes: doc.taxes, taxPct: doc.taxPct } }),
  };
  const summary = existing
    ? `Add ${priced.lines.length} line${priced.lines.length === 1 ? '' : 's'} to ${existing.number || 'estimate'}: total ${money(before.totalCents)} → ${money(after.totalCents)}`
    : `New estimate${doc.title ? ` "${doc.title.slice(0, 60)}"` : ''}: ${priced.lines.length} line${priced.lines.length === 1 ? '' : 's'}, ${money(after.totalCents)} incl. ${describeTaxes(doc.taxes)}`;
  const row = await insertDraft(tx, { kind: 'estimate', target: existing?.id || null, baseVersion: existing?.version ?? null, proposal, summary, conversationId: who.conversationId, actor: who.actor, request: who.request });
  return draftView(row);
}

/** Lines already billed on the job's other invoices (by change order id). */
async function billedChangeOrders(tx, jobId) {
  const { rows } = await tx.query("SELECT data FROM invoices WHERE tenant_id = $1 AND job_id = $2 AND deleted_at IS NULL AND coalesce(status, '') <> 'void'", [tx.tenantId, jobId]);
  return { ids: new Set(rows.flatMap((r) => (r.data.lines || []).map((l) => l.changeOrderId).filter(Boolean))), invoices: rows.length };
}

/**
 * Propose an invoice for a job: from its accepted estimate (plus approved change orders
 * not yet billed), or time and materials (approved hours at the labour rate, materials
 * moved to the job at price-book prices).
 */
export async function proposeInvoiceFromJob(tx, p, input, who, now = new Date()) {
  if (!canWrite(p, 'invoices')) throw forbidden('You cannot draft invoices (needs the invoices permission or an invoices:write key).');
  const job = await readRecord(tx, p, 'jobs', input.jobId);
  const settings = await companySettings(tx);
  const warnings = [];
  let estimate = null;
  if (canRead(p, 'estimates')) {
    if (job.estimateId) { try { estimate = await readRecord(tx, p, 'estimates', job.estimateId); } catch { /* deleted */ } }
    if (!estimate) {
      const { rows } = await tx.query(
        "SELECT id, data, version FROM estimates WHERE tenant_id = $1 AND job_id = $2 AND status = 'accepted' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1", [tx.tenantId, job.id]);
      if (rows[0]) estimate = { ...rows[0].data, id: rows[0].id, version: rows[0].version };
    }
  }
  const basis = input.basis === 'estimate' || input.basis === 'time_and_materials' ? input.basis : (estimate && estimate.status === 'accepted' ? 'estimate' : 'time_and_materials');
  if (basis === 'estimate' && !estimate) throw new ApiError(400, 'bad_request', 'That job has no estimate to invoice from. Try time and materials.');
  const billed = await billedChangeOrders(tx, job.id);
  if (billed.invoices) warnings.push(`${job.number || 'This job'} already has ${billed.invoices} invoice${billed.invoices === 1 ? '' : 's'}; check nothing is billed twice.`);

  const lines = [];
  let tax;
  if (basis === 'estimate') {
    for (const l of estimate.lines || []) lines.push({ ...docLine(l), source: 'estimate' });
    const t = docTotals(estimate);
    if (t.markupCents) lines.push({ itemId: null, description: `Materials markup (${estimate.markupPct}%)`, qty: 1, unitCents: t.markupCents, labourHours: 0, kind: 'other', source: 'estimate' });
    if (Array.isArray(estimate.taxes) && estimate.taxProvince && TREATMENTS[estimate.taxTreatment]) {
      const taxes = taxComponents({ province: estimate.taxProvince, treatment: estimate.taxTreatment, date: today(0, now) });
      tax = { taxes, taxProvince: estimate.taxProvince, taxTreatment: estimate.taxTreatment, taxPct: combinedPct(taxes.filter((x) => x.applies.material || x.applies.labour || x.applies.other)) };
    }
  } else {
    const rate = settings.labourRateCents ?? 9500;
    if (canRead(p, 'timeEntries')) {
      const { rows } = await tx.query('SELECT data FROM time_entries WHERE tenant_id = $1 AND job_id = $2 AND deleted_at IS NULL', [tx.tenantId, job.id]);
      const closed = rows.map((r) => r.data).filter((e) => e.clockIn && e.clockOut);
      const approved = closed.filter((e) => e.approved);
      const hours = Math.round(approved.reduce((s, e) => s + entryHours(e), 0) * 4) / 4;
      if (closed.length > approved.length) warnings.push(`${closed.length - approved.length} time entr${closed.length - approved.length === 1 ? 'y is' : 'ies are'} not approved yet and were left out.`);
      if (hours > 0) lines.push({ itemId: null, description: `Labour, ${approved.length} approved time entr${approved.length === 1 ? 'y' : 'ies'}`, qty: hours, unitCents: rate, labourHours: 1, kind: 'labour', source: 'time_entries' });
    } else warnings.push('You cannot read time entries, so labour was left out.');
    if (canRead(p, 'stockMoves') && canRead(p, 'items')) {
      const { rows } = await tx.query('SELECT data FROM stock_moves WHERE tenant_id = $1 AND job_id = $2 AND deleted_at IS NULL', [tx.tenantId, job.id]);
      const qtyByItem = new Map();
      for (const m of rows.map((r) => r.data)) if (m.itemId) qtyByItem.set(m.itemId, (qtyByItem.get(m.itemId) || 0) + (Number(m.qty) || 0));
      const items = new Map((await readMany(tx, p, 'items', [...qtyByItem.keys()])).map((i) => [i.id, i]));
      for (const [id, qty] of qtyByItem) {
        const it = items.get(id);
        if (!it || qty <= 0) continue;
        lines.push({ itemId: it.id, description: it.name, qty, unitCents: Number(it.priceCents) || 0, labourHours: Number(it.labourHours) || 0, kind: 'material', source: 'stock_moves' });
      }
    }
    if (!lines.length) warnings.push('No approved hours or materials were found for this job; add lines before sending.');
  }
  for (const c of job.changeOrders || []) {
    if (c.status === 'approved' && !billed.ids.has(c.id)) {
      lines.push({ itemId: null, changeOrderId: c.id, description: `Change order: ${c.title || ''}`.trim(), qty: 1, unitCents: Number(c.amountCents) || 0, labourHours: 0, kind: 'other', source: 'change_order' });
    }
  }
  tax ||= newDocTax(settings, today(0, now));
  const doc = { lines: lines.map((l) => ({ ...docLine(l), ...(l.changeOrderId ? { changeOrderId: l.changeOrderId } : {}) })), ...tax };
  const after = docTotals(doc);
  const dueInDays = Number.isInteger(input.dueInDays) ? input.dueInDays : 14;
  const proposal = {
    mode: 'new', basis, title: job.title || '', jobId: job.id, jobNumber: job.number || null, clientId: job.clientId || null,
    estimateId: estimate?.id || null, issueDate: today(0, now), dueDate: today(dueInDays, now),
    lines, tax: taxView(doc), before: null, after: totalsView(after), warnings,
    docFields: { taxProvince: doc.taxProvince ?? null, taxTreatment: doc.taxTreatment ?? null, taxes: doc.taxes, taxPct: doc.taxPct },
  };
  const summary = `Invoice for ${job.number || 'job'}${job.title ? ` "${job.title.slice(0, 50)}"` : ''} (${basis === 'estimate' ? 'from the estimate' : 'time and materials'}): ${lines.length} line${lines.length === 1 ? '' : 's'}, ${money(after.totalCents)}`;
  const row = await insertDraft(tx, { kind: 'invoice', target: null, baseVersion: null, proposal, summary, conversationId: who.conversationId, actor: who.actor, request: who.request });
  return draftView(row);
}

async function lockDraft(tx, id) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
  const { rows } = await tx.query('SELECT * FROM ai_drafts WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tx.tenantId, id]);
  if (!rows[0]) throw notFound();
  return rows[0];
}

/** Reserve the next document number from settings.nextNumbers (same format as store.nextNumber). */
async function nextNumber(tx, p, records, kind, who) {
  const prefix = { estimate: 'E', invoice: 'INV' }[kind];
  const s = await companySettings(tx);
  const n = s.nextNumbers?.[kind] ?? (kind === 'estimate' ? 2001 : 3001);
  if (s.exists) await records.patchRecord(tx, p, 'settings', 'settings', { nextNumbers: { ...s.nextNumbers, [kind]: n + 1 } }, {}, who);
  return `${prefix}-${n}`;
}

/**
 * A person accepts a draft: the estimate lines or invoice are written through the
 * records service as that person. Fails with 409 when the draft was already decided or
 * the target estimate changed since the draft was made.
 */
export async function acceptDraft(tx, p, records, id, who, now = new Date()) {
  const d = await lockDraft(tx, id);
  if (d.status !== 'proposed') throw conflict(`This draft was already ${d.status}.`);
  const pr = d.proposal;
  const lines = (pr.lines || []).map((l) => ({ ...docLine(l), ...(l.changeOrderId ? { changeOrderId: l.changeOrderId } : {}) }));
  let record;
  if (d.kind === 'estimate' && d.target_id) {
    const cur = await readRecord(tx, p, 'estimates', d.target_id);
    record = await records.patchRecord(tx, p, 'estimates', d.target_id, { lines: [...(cur.lines || []), ...lines] }, { ifVersion: d.base_version }, who);
  } else if (d.kind === 'estimate') {
    const number = await nextNumber(tx, p, records, 'estimate', who);
    record = await records.createRecord(tx, p, 'estimates', {
      number, clientId: pr.clientId || null, jobId: pr.jobId || null, title: pr.title || '', status: 'draft', lines,
      labourRateCents: pr.labourRateCents, markupPct: 0, ...pr.docFields, notes: pr.notes || '', validUntil: today(30, now), aiDraftId: d.id,
    }, who);
  } else {
    const number = await nextNumber(tx, p, records, 'invoice', who);
    record = await records.createRecord(tx, p, 'invoices', {
      number, clientId: pr.clientId || null, jobId: pr.jobId || null, estimateId: pr.estimateId || null, title: pr.title || '', status: 'draft',
      lines, ...pr.docFields, issueDate: today(0, now), dueDate: pr.dueDate || today(14, now), notes: '', aiDraftId: d.id,
    }, who);
  }
  const { rows } = await tx.query(
    "UPDATE ai_drafts SET status = 'accepted', decided_by = $3, decided_at = now(), result_id = $4 WHERE tenant_id = $1 AND id = $2 RETURNING *",
    [tx.tenantId, d.id, actorString(who.actor), record.id]);
  await appendAudit(tx, tx.tenantId, {
    actor: who.actor, action: 'ai.draft_accept', collection: d.target_collection, recordId: record.id, summary: d.summary.slice(0, 200),
    meta: { draftId: d.id, kind: d.kind, lines: lines.length }, request: who.request,
  });
  return { draft: draftView(rows[0]), record };
}

export async function discardDraft(tx, p, id, who) {
  const d = await lockDraft(tx, id);
  if (!canWrite(p, d.target_collection)) throw forbidden();
  if (d.status !== 'proposed') throw conflict(`This draft was already ${d.status}.`);
  const { rows } = await tx.query(
    "UPDATE ai_drafts SET status = 'discarded', decided_by = $3, decided_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING *",
    [tx.tenantId, d.id, actorString(who.actor)]);
  await appendAudit(tx, tx.tenantId, { actor: who.actor, action: 'ai.draft_discard', collection: 'ai_drafts', recordId: d.id, summary: d.summary.slice(0, 200), request: who.request });
  return draftView(rows[0]);
}

export async function getDraft(tx, p, id) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
  const { rows } = await tx.query('SELECT * FROM ai_drafts WHERE tenant_id = $1 AND id = $2', [tx.tenantId, id]);
  if (!rows[0] || !canRead(p, rows[0].target_collection)) throw notFound();
  return draftView(rows[0]);
}

export async function listDrafts(tx, p, { status = 'proposed', limit = 50 } = {}) {
  const colls = ['estimates', 'invoices'].filter((c) => canRead(p, c));
  if (!colls.length) return [];
  const { rows } = await tx.query(
    `SELECT * FROM ai_drafts WHERE tenant_id = $1 AND status = $2 AND target_collection = ANY($3) ORDER BY created_at DESC LIMIT $4`,
    [tx.tenantId, status, colls, Math.min(Math.max(Number(limit) || 50, 1), 200)]);
  return rows.map(draftView);
}
