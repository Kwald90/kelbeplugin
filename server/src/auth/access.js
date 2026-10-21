// Server-side access rules per collection. Same roles and permission keys as the PWA
// (auth/permissions.js), applied to every REST call and every sync mutation.
import { AUDIT_COLLECTION, collectionDef } from '../collections.js';
// Work tasks: the same rules the PWA applies offline (who may change what, photo evidence).
import { mergeTask, taskWriteProblem } from '../../../electrical-app/js/lib/workplan.js';
// Drawings: object-level merge (two people editing different parts both keep their work).
import { mergeDrawing } from '../../../electrical-app/js/lib/drawing-collab.js';
import { canSeeMoney } from '../../../electrical-app/js/lib/drawing-costs.js';
// Release 1 (docs/releases/r1-get-paid.md 2.5, 2.6, 2.9, 2.10, 7.3): posted collections, the
// exemption and holdback send blocks, where a line may turn tax off, money-free signature snapshots
// and company rule checks.
import { POSTED_COLLECTIONS } from '../../../electrical-app/js/lib/closing.js';
import { exemptionProblem, lineTaxOffProblem } from '../../../electrical-app/js/lib/exemption.js';
import { holdbackProblem } from '../../../electrical-app/js/lib/money.js';
import { snapshotWithoutMoney } from '../../../electrical-app/js/lib/signing.js';
import { ruleRecordProblem } from '../../../electrical-app/js/lib/rules.js';

/**
 * @typedef {object} Principal
 * @property {'session'|'api_key'} kind
 * @property {string} tenantId
 * @property {string|null} userId
 * @property {string|null} role             membership role (capped for crew sessions)
 * @property {Set<string>} perms             permission keys of the role
 * @property {boolean} isManager
 * @property {string|null} employeeId        the member's employees record id
 * @property {string[]|null} scopes          API key scopes
 * @property {boolean} [crew]                shared-device PIN session
 * @property {{ type: string, id: string|null, label?: string|null }} actor
 */

/** Scopes an API key may hold. */
export function validScopes(collections) {
  const out = new Set(['*:read', '*:write']);
  for (const c of collections) { out.add(`${c}:read`); out.add(`${c}:write`); }
  return out;
}

function hasScope(p, coll, mode) {
  const s = p.scopes || [];
  if (s.includes(`${coll}:write`) || s.includes('*:write')) return true;
  return mode === 'read' && (s.includes(`${coll}:read`) || s.includes('*:read'));
}

/** @param {Principal} p */
export function canRead(p, coll) {
  if (p.kind === 'api_key') return !collectionDef(coll)?.noApiKeys && hasScope(p, coll, 'read');
  if (coll === AUDIT_COLLECTION) return p.perms.has('security');
  const def = collectionDef(coll);
  if (!def) return false;
  if (def.readAll) return true;
  return def.read.some((k) => p.perms.has(k));
}

/** @param {Principal} p */
export function canWrite(p, coll) {
  if (p.kind === 'api_key') return !collectionDef(coll)?.noApiKeys && hasScope(p, coll, 'write');
  const def = collectionDef(coll);
  if (!def || coll === AUDIT_COLLECTION) return false;
  if (def.managerWrite && !p.isManager) return false;
  return def.write.some((k) => p.perms.has(k));
}

/**
 * Row filter for reads. Non-managers see only their own time entries and work tasks, and of
 * their tasks only the published ones (`exclude`: rows whose column holds one of `values`).
 * @returns {null | { column: string, value: string|null, exclude?: { column: string, field: string, values: string[] } }}
 */
export function rowFilter(p, coll) {
  const def = collectionDef(coll);
  if (def?.ownRows && p.kind !== 'api_key' && (!p.isManager || def.ownRowsAlways)) {
    const f = { column: 'employee_id', value: p.employeeId || null };
    const hide = def.ownRowsHide;
    const col = hide && def.gen.find((x) => x.field === hide.field)?.col;
    if (col) f.exclude = { column: col, field: hide.field, values: [...hide.values] };
    return f;
  }
  return null;
}

/** Does a row's data pass the row filter? (the same test as the SQL in services/records.js) */
export function rowVisible(f, data, def) {
  if (!f) return true;
  const field = def.gen.find((x) => x.col === f.column)?.field;
  if (f.value == null || data?.[field] !== f.value) return false;
  if (f.exclude && f.exclude.values.includes(data?.[f.exclude.field])) return false;
  return true;
}

/**
 * The data to store for a write, when a collection merges instead of replacing: work tasks
 * keep the foreman's fields from a worker's write and resolve progress by its own timestamp
 * (lib/workplan.js mergeTask); drawings merge item by item (lib/drawing-collab.js mergeDrawing).
 * Returns null for collections that store what was sent (last writer wins).
 * @param {{ itemMerge?: boolean }} [opts] itemMerge: the push said its app records deletions
 *   as tombstones (sync.js toWire)
 */
export function mergeWrite(p, coll, existing, next, { itemMerge = false, stale = false } = {}) {
  if (!existing || !next) return null;
  // Jobs: a stale write keeps the change orders added or signed meanwhile (an iPad signing CO-3
  // offline and the office adding CO-4 both survive); the rest of the record is last-writer-wins.
  if (coll === 'jobs') return stale ? mergeJobWrite(existing, next) : null;
  if (coll === 'drawings') {
    // Only a copy from an app that tracks deletions merges. An older app deletes by leaving
    // items out: it may carry the stored tombstones over without adding its own, so a union
    // would undo its deletes, and a copy without tombstones would skip the stale-write check.
    // Both are last-writer-wins: a stale copy loses to the newer stored one.
    if (!itemMerge || !next.tombstones || typeof next.tombstones !== 'object') return null;
    return mergeDrawing(existing, next);
  }
  if (coll !== 'workTasks') return null;
  return mergeTask(existing, next, { worker: p.kind !== 'api_key' && !p.isManager });
}

const coTime = (co) => Date.parse(co?.updatedAt || co?.signedAt || co?.createdAt || '') || 0;

/**
 * Change orders merged by id (the mergeTask pattern, docs/releases/r1-get-paid.md 2.6). A change
 * order in both copies: the later one by its own updatedAt (the incoming copy on a tie or when
 * neither says). A stale write keeps change orders it did not know about; a signed change order is
 * never removed (it is voided). Order: the incoming list, then the kept ones.
 */
export function mergeChangeOrders(existingCos, nextCos, { stale = false } = {}) {
  const before = (Array.isArray(existingCos) ? existingCos : []).filter((c) => isObj(c) && c.id);
  const out = [];
  const seen = new Set();
  const prev = new Map(before.map((c) => [c.id, c]));
  for (const co of Array.isArray(nextCos) ? nextCos : []) {
    if (!isObj(co) || !co.id) { out.push(co); continue; }
    seen.add(co.id);
    const old = prev.get(co.id);
    out.push(old && stale && coTime(old) > coTime(co) ? old : co);
  }
  for (const co of before) if (!seen.has(co.id) && (stale || co.signatureId)) out.push(co);
  return out;
}

/** A stale job write: last-writer-wins on the record, change orders merged. Null when it changes nothing. */
function mergeJobWrite(existing, next) {
  const t = (iso) => Date.parse(iso) || 0;
  const base = t(next.updatedAt) > t(existing.updatedAt) ? next : existing;
  const cos = mergeChangeOrders(existing.changeOrders, next.changeOrders, { stale: true });
  // Nothing to merge: the plain last-writer-wins path decides (and keeps the loser in history).
  if (same(cos, base.changeOrders ?? [])) return null;
  const out = { ...base, changeOrders: cos };
  if (base === existing) out.updatedAt = existing.updatedAt;
  return out;
}

/** What a manager's review or approval of a time entry changes (PWA lib/clock.js reviewFlag, approveEntries). */
export const TIME_REVIEW_FIELDS = ['flag', 'approved', 'approvedAt', 'approvedBy'];
const FLAG_REVIEW_KEYS = ['reviewedAt', 'reviewedBy', 'reviewNote'];

/**
 * A stale write (made on an older copy) that only reviews or approves a time entry: `fields`, the
 * fields the device changed, are all review fields. Only those go onto the stored entry, so a
 * foreman's old copy never puts back clock times the worker changed since (a clock-out, a
 * corrected time). Returns the data to store, or null when this is not such a write.
 */
export function reviewMerge(coll, existing, next, fields) {
  if (coll !== 'timeEntries' || !existing || !next || !Array.isArray(fields) || !fields.length) return null;
  if (!fields.every((f) => TIME_REVIEW_FIELDS.includes(f))) return null;
  const t = (iso) => Date.parse(iso) || 0;
  const out = { ...existing, updatedAt: t(next.updatedAt) >= t(existing.updatedAt) ? next.updatedAt : existing.updatedAt };
  for (const f of fields) {
    if (f === 'flag' && existing.flag && next.flag) {
      out.flag = { ...existing.flag };
      for (const k of FLAG_REVIEW_KEYS) { if (k in next.flag) out.flag[k] = next.flag[k]; else delete out.flag[k]; }
    } else if (f in next) out[f] = next[f];
    else delete out[f];
  }
  return out;
}

// ---- money (prices, costs, rates) ---------------------------------------------
// Crew never see prices or costs. Money roles: owner, admin, office (the `estimates`
// permission), foremen when the company allows it (settings.foremanSeesCosts, loaded once per
// request by services/records.js loadMoneyAccess), API keys (a company admin scoped them) and
// background agents. Readers without money get records without these fields, and their
// writes cannot change them (restoreHiddenFields puts the stored values back).

/**
 * Price fields hidden from readers without money, per collection ('a.b' is field b of object a).
 * Job change orders are handled per change order (amountCents, line unitCents).
 */
export const MONEY_FIELDS = {
  items: ['priceCents', 'costCents', 'avgCostCents'],
  // the company's bill rates (lib/tm.js jobRates) and the job-costing rates (Release 1)
  settings: ['labourRateCents', 'markupPct', 'billing.travelRateCents', 'costing'],
  // a T&M job's own bill rates (lib/tm.js jobRates), the contract value and the costing block
  jobs: ['labourRateCents', 'travelRateCents', 'markupPct', 'contract.valueCents', 'costing'],
  // the office's cost on a material request (crew file requests, never with prices)
  materialRequests: ['costCents'],
  // Release 1 (docs/releases/r1-get-paid.md 2.5)
  clients: ['credit.limitCents'],
  equipment: ['rateCents', 'billRateCents', 'rateHistory'],
  employees: ['rateHistory'],
  stockMoves: ['unitCostCents'],
};
// Signatures: every key ending in Cents at any depth of the snapshot (stripMoney below).

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
function hasField(data, k) {
  const [a, b] = k.split('.');
  return b ? isObj(data?.[a]) && b in data[a] : Boolean(data) && a in data;
}
const getField = (data, k) => { const [a, b] = k.split('.'); return b ? data[a][b] : data[a]; };
/** Set or (value undefined) remove a field on `out`, a copy of the record; nested objects are copied too. */
function putField(out, k, value) {
  const [a, b] = k.split('.');
  if (!b) { if (value === undefined) delete out[a]; else out[a] = value; return; }
  if (!isObj(out[a])) { if (value === undefined) return; out[a] = {}; } else out[a] = { ...out[a] };
  if (value === undefined) delete out[a][b]; else out[a][b] = value;
}

/** Can this principal see prices and costs? */
export function seesMoney(p) {
  if (!p) return false;
  if (typeof p.seesMoney === 'boolean') return p.seesMoney;
  if (p.kind === 'api_key') return true;
  return canSeeMoney({ role: p.role, perms: p.perms });
}

/** The markup line drawing-costs.js changeOrderFrom wrote before the rate moved to markupPct. */
const OLD_MARKUP_LINE = /^Markup [\d.]+% on material$/;

/** A change order as a reader without money sees it (no amounts, unit prices or markup rate). */
function coWithoutMoney(co) {
  if (!co || typeof co !== 'object') return co;
  const { amountCents, estCostCents, lines, ...rest } = co;
  void amountCents; void estCostCents;
  return Array.isArray(lines)
    ? {
      ...rest,
      lines: lines.map((l) => {
        const { unitCents, markupPct, ...x } = l || {};
        void unitCents; void markupPct;
        if (typeof x.description === 'string' && OLD_MARKUP_LINE.test(x.description)) x.description = 'Markup on material';
        return x;
      }),
    }
    : rest;
}

function stripMoney(coll, data) {
  if (!data) return data;
  if (coll === 'signatures') {
    if (!isObj(data.snapshot) || !/Cents"/.test(JSON.stringify(data.snapshot))) return data;
    // The digest is SHA-256 of the money-bearing snapshot; handing it to a non-money reader lets
    // them brute-force the stripped *Cents amounts, so drop it with the money it protects.
    const { digest, ...rest } = data;
    void digest;
    return { ...rest, snapshot: snapshotWithoutMoney(data.snapshot), pricesHidden: true };
  }
  const found = (MONEY_FIELDS[coll] || []).filter((k) => hasField(data, k));
  const cos = coll === 'jobs' && Array.isArray(data.changeOrders) && data.changeOrders.length > 0;
  if (!found.length && !cos) return data;
  const rest = { ...data };
  for (const k of found) putField(rest, k, undefined);
  if (cos) rest.changeOrders = data.changeOrders.map(coWithoutMoney);
  rest.pricesHidden = true;
  return rest;
}

/** Put back the money a reader without it could not see (or change). */
function restoreMoney(coll, existing, next) {
  const out = { ...next };
  delete out.pricesHidden; // a read marker, never stored
  if (MONEY_FIELDS[coll]) {
    for (const k of MONEY_FIELDS[coll]) {
      // A new record from a reader without money carries none either (a crew member's material
      // request), so strip the field whenever the stored record does not have it — on edits and
      // on brand-new records alike, for every money collection.
      if (hasField(existing, k)) putField(out, k, getField(existing, k)); else putField(out, k, undefined);
    }
  }
  if (coll === 'jobs' && Array.isArray(out.changeOrders)) {
    const before = new Map((existing?.changeOrders || []).filter((c) => c?.id).map((c) => [c.id, c]));
    out.changeOrders = out.changeOrders.map((co) => {
      const old = co?.id && before.get(co.id);
      if (!old) { const { amountCents, estCostCents, ...rest } = co || {}; void amountCents; void estCostCents; return rest; }
      const keep = { ...co };
      if ('amountCents' in old) keep.amountCents = old.amountCents; else delete keep.amountCents;
      if ('estCostCents' in old) keep.estCostCents = old.estCostCents; else delete keep.estCostCents;
      if ('lines' in old) keep.lines = old.lines; else delete keep.lines;
      return keep;
    });
  }
  return out;
}

const coHasMoney = (co) => 'amountCents' in co || 'estCostCents' in co || (Array.isArray(co.lines) && co.lines.some((l) => l && typeof l === 'object' && 'unitCents' in l));

/**
 * A money reader writing a copy they were sent without prices (pricesHidden: they could not see
 * money when their device pulled it, and the record has not changed since). The fields that were
 * stripped from that copy come back from the stored record; anything money they set stays.
 */
function fillStrippedMoney(coll, existing, next) {
  const out = { ...next };
  delete out.pricesHidden;
  if (!existing) return out;
  for (const k of MONEY_FIELDS[coll] || []) {
    if (!hasField(out, k) && hasField(existing, k)) putField(out, k, getField(existing, k));
  }
  if (coll === 'jobs' && Array.isArray(out.changeOrders)) {
    const before = new Map((existing.changeOrders || []).filter((c) => c?.id).map((c) => [c.id, c]));
    out.changeOrders = out.changeOrders.map((co) => {
      const old = isObj(co) && co.id && before.get(co.id);
      if (!old || coHasMoney(co)) return co;
      const keep = { ...co };
      if ('amountCents' in old) keep.amountCents = old.amountCents;
      if ('estCostCents' in old) keep.estCostCents = old.estCostCents;
      if ('lines' in old) keep.lines = old.lines;
      return keep;
    });
  }
  return out;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const IGNORED = new Set(['updatedAt', 'createdAt', 'id']);
function changedKeys(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...keys].filter((k) => !IGNORED.has(k) && !same(before?.[k], after?.[k]));
}

/**
 * Rules that depend on the record itself. Returns an error message, or null when allowed.
 * @param {Principal} p
 * @param {string} coll
 * @param {object|null} existing  current record data (null when creating)
 * @param {object|null} next      new record data (null when deleting)
 */
export function checkWriteRules(p, coll, existing, next) {
  // Release 1 rules that hold for every writer, API keys included (docs/releases/r1-get-paid.md 2.6-2.10).
  const r1 = releaseOneRule(p, coll, existing, next);
  if (r1) return r1;
  // Evidence is required on every path, API keys included; the rest is per person.
  if (coll === 'workTasks') {
    if (p.kind === 'api_key') return taskWriteProblem({ isManager: true, employeeId: null }, existing, next);
    return taskWriteProblem({ isManager: p.isManager, employeeId: p.employeeId || null }, existing, next);
  }
  if (p.kind === 'api_key') return null;
  const def = collectionDef(coll);

  // Material requests: crew file their own, and change or withdraw them only until they are sent.
  if (coll === 'materialRequests' && !p.isManager) return materialRequestRule(p, existing, next);
  // Location points and consents belong to one person: only they record them, whatever their role
  // (a manager can't give consent or add points for someone else). Points never change once saved.
  if (coll === 'locationPoints' || coll === 'locationConsents') {
    if (!p.employeeId) return 'Your membership is not linked to an employee record, so location is not recorded.';
    if (existing && existing.employeeId !== p.employeeId) return 'Only the person it belongs to can change this.';
    if (next && next.employeeId !== p.employeeId) return 'Location records are only ever made by the person themselves.';
    if (coll === 'locationPoints' && existing && next) return 'Location points cannot be changed.';
    if (!next) return coll === 'locationPoints' ? 'Location points are removed by the retention schedule.' : 'Consent answers are kept; record a new answer instead.';
    return null;
  }

  // Field tickets: crews write their own drafts; after signing only the office prices, bills or voids.
  if (coll === 'fieldTickets') {
    const msg = ticketRule(p, existing, next);
    if (msg) return msg;
  }
  // Time corrections (a locked entry is changed by an adjustment) are made by whoever approves time.
  if (coll === 'timeEntries' && next?.kind === 'correction' && !same(existing, next)) {
    if (!p.perms.has('time-approve')) return 'Only whoever approves time can add a correction.';
    if (!Number.isInteger(next.adjustMinutes) || next.adjustMinutes === 0) return 'A correction adds or takes away some minutes (never 0).';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(next.workDay || ''))) return 'A correction needs the day it belongs to.';
  }

  // Time entries: non-managers write only their own, and cannot approve.
  if (def?.ownRows && !p.isManager) {
    if (!p.employeeId) return 'Your membership is not linked to an employee record, so you cannot record time.';
    if (existing && existing.employeeId !== p.employeeId) return 'You can only change your own time entries.';
    if (next && next.employeeId !== p.employeeId) return 'You can only record time for yourself.';
  }
  if (coll === 'timeEntries' && next && !p.perms.has('time-approve') && Boolean(next.approved) !== Boolean(existing?.approved)) {
    return 'Approving time needs the time-approve permission.';
  }
  // An approved entry is locked for everyone who can't approve (threat model TM-SYNC-04).
  if (coll === 'timeEntries' && existing?.approved && !p.perms.has('time-approve')) {
    return 'This time is approved. Ask your foreman or the office to change it.';
  }
  if (coll === 'timeEntries' && next && !p.isManager && !same(existing?.flag?.reviewedAt ?? null, next.flag?.reviewedAt ?? null)) {
    return 'Only a manager can review an off-site clock-in.';
  }

  // SOPs: managers edit; everyone else may only add their own acknowledgement.
  if (coll === 'sops' && !p.isManager) {
    if (!existing || !next) return 'Only managers can create or delete SOPs.';
    const changed = changedKeys(existing, next);
    if (changed.some((k) => k !== 'acks')) return 'You can only acknowledge an SOP.';
    const before = existing.acks || [];
    const after = next.acks || [];
    if (after.length < before.length || !before.every((a, i) => same(a, after[i]))) return 'Acknowledgements cannot be removed or changed.';
    if (after.slice(before.length).some((a) => a?.employeeId !== p.employeeId)) return 'You can only acknowledge for yourself.';
  }

  const safetyMsg = SAFETY_COLLECTIONS.has(coll) && !p.isManager ? safetyWriteRule(p, coll, existing, next) : null;
  if (safetyMsg) return safetyMsg;

  // Settings: the settings permission edits anything; document creators may only bump nextNumbers;
  // the office (invoices permission) also edits the Release 1 settings on its own screens (2.4).
  if (coll === 'settings' && !p.perms.has('settings')) {
    if (!existing || !next) return 'Only the settings permission can create or delete settings.';
    const allowed = p.perms.has('invoices') ? ['nextNumbers', ...OFFICE_SETTINGS] : ['nextNumbers'];
    const changed = changedKeys(existing, next);
    if (changed.some((k) => !allowed.includes(k))) return 'Changing settings needs the settings permission.';
  }
  return null;
}

/** Settings the office edits on Books, Invoices → Collections, Field tickets and Job costing (2.4). */
const OFFICE_SETTINGS = ['costCodes', 'payroll', 'tickets', 'deposits', 'collections', 'closeout', 'promptPayment', 'costing'];

// ---- Release 1 (docs/releases/r1-get-paid.md 2.6-2.10, 4.1, 4.8) ------------------------------

/** An ApiError-shaped refusal (records.js throws it with its own status and code). */
const refusal = (status, code, message, details) => ({ status, code, message, ...(details ? { details } : {}) });
const isSystem = (p) => p?.kind === 'system';
const fullSession = (p) => isSystem(p) || (p?.kind === 'session' && !p.crew);

/**
 * Rules for every writer: payroll runs only from the closing route, company rules typed per their
 * definition, signatures append-only, a job set invoiced only after its final-billing checklist,
 * PST/RST turned off line by line only on out-of-pocket lines, and an invoice never leaving draft
 * without its Manitoba exemption evidence or with a holdback that does not fit it.
 * Returns a message (403), a refusal object { status, code, message } or null.
 */
function releaseOneRule(p, coll, existing, next) {
  if (coll === 'payrollRuns' && !(isSystem(p) && p.actor?.id === 'closing')) {
    return 'Payroll runs are made by exporting payroll (Time clock → Timesheets) and reopened on Books.';
  }
  if (coll === 'rules' && next) {
    const msg = ruleRecordProblem(next);
    if (msg) return refusal(422, 'validation_failed', msg);
  }
  if (coll === 'signatures') return signatureRule(p, existing, next);
  // Payments: money back is a reversal (reversesId) or a refund, never a plain negative payment
  // (people and API keys; the system actors write what Stripe and QuickBooks recorded).
  if (coll === 'payments' && next && !isSystem(p) && Number(next.amountCents) < 0 && !next.reversesId && next.method !== 'refund') {
    return 'A negative payment must reverse an earlier payment or be a refund.';
  }
  if (coll === 'jobs' && next && !isSystem(p) && next.status === 'invoiced' && (existing?.status || null) !== 'invoiced') {
    const c = next.closeout;
    const open = Array.isArray(c?.open) ? c.open : null;
    if (!c?.checkedAt || !open) return refusal(422, 'closeout_required', 'Run the final-billing checklist before marking this job invoiced.');
    if (open.length && String(c.override?.reason || '').trim().length < 10) {
      return refusal(422, 'closeout_required', 'Items are still open on the final-billing checklist. Clear them, or record why (at least 10 characters).');
    }
  }
  if (coll === 'invoices' && next && !isSystem(p)) {
    const was = existing ? existing.status || 'draft' : null;
    const now = next.status || 'draft';
    const leavingDraft = now !== 'draft' && now !== 'void' && (was === null || was === 'draft');
    // Checked when the lines change and again when the invoice leaves draft.
    if (leavingDraft || !existing || !same(existing.lines, next.lines)) {
      const t = lineTaxOffProblem(next);
      if (t) return refusal(422, 'tax_off_invalid', t.message, { line: t.index });
    }
    // Once an invoice has left draft its tax treatment can still be edited (a sent invoice is not
    // locked). Changing it to drop RST — gst-only, none, a different exemption or holdback — must be
    // re-validated, not only on the draft→sent transition, or RST is silently dropped end to end.
    const TAX_SHAPE = ['taxTreatment', 'taxes', 'taxProvince', 'taxNoneReason', 'taxExemptBasis', 'taxExemptNumber', 'taxExemptDetails', 'holdback'];
    const taxShapeChanged = existing && TAX_SHAPE.some((k) => !same(existing[k], next[k]));
    if (leavingDraft || (now !== 'draft' && now !== 'void' && taxShapeChanged)) {
      const x = exemptionProblem(next, { docType: 'invoices' });
      if (x?.level === 'block') return refusal(422, 'exemption_required', x.message, { missing: x.missing });
      const h = holdbackProblem(next);
      if (h) return refusal(422, 'holdback_invalid', h.message, { reason: h.code, ...(h.taxId ? { taxId: h.taxId } : {}) });
    }
  }
  if (coll === 'estimates' && next && !isSystem(p) && (!existing || !same(existing.lines, next.lines))) {
    const t = lineTaxOffProblem(next);
    if (t) return refusal(422, 'tax_off_invalid', t.message, { line: t.index });
  }
  return null;
}

/** Signatures are kept: create once, then only void (invoices permission, full session). */
function signatureRule(p, existing, next) {
  if (!next) return existing ? 'Signatures are kept. Void it instead.' : null;
  const money = p.kind === 'api_key' || isSystem(p) || p.perms?.has?.('invoices') || p.perms?.has?.('estimates');
  if (!existing) {
    if (next.method === 'email-reply' && !(isSystem(p) || p.perms?.has?.('invoices'))) return 'Only the office records an acceptance by email.';
    if (['estimate', 'changeOrder'].includes(next.docType) && !money) return 'Estimates and change orders are signed with the office, who can see the price.';
    return null;
  }
  const changed = changedKeys(existing, next).filter((k) => k !== 'pricesHidden');
  if (!changed.length) return null;
  const was = existing.status || 'valid';
  if (was === 'void' || changed.some((k) => !['status', 'voidReason', 'voidedAt', 'voidedBy'].includes(k))) return 'A signature cannot be changed. Void it instead.';
  if (next.status !== 'void') return 'A signature can only be voided.';
  if (!(isSystem(p) || p.perms?.has?.('invoices'))) return 'Only the office can void a signature.';
  if (!fullSession(p)) return 'Voiding a signature needs a full sign-in, not a crew PIN.';
  if (String(next.voidReason || '').trim().length < 3) return 'Say why the signature is void.';
  return null;
}

/** Ticket fields the office may change after a ticket is signed or refused. */
const TICKET_OFFICE_FIELDS = ['status', 'changeOrderId', 'invoiceId', 'office', 'notice', 'costCodeId'];
const TICKET_DONE = ['signed', 'refused', 'priced', 'billed', 'void'];
const TICKET_MOVES = { signed: ['priced', 'billed', 'void'], refused: ['priced', 'billed', 'void'], priced: ['billed', 'void', 'signed', 'refused'], billed: ['priced', 'void'] };

/** Field tickets (4.1): who may change what, and when. */
function ticketRule(p, existing, next) {
  const office = isSystem(p) || p.kind === 'api_key' || p.perms?.has?.('invoices');
  const was = existing ? existing.status || 'draft' : null;
  if (!next) {
    if (existing && TICKET_DONE.includes(was) && was !== 'void') return 'A signed or refused ticket is kept. Void it instead.';
    // A void ticket that was signed or refused keeps its record, as its signature is kept.
    if (existing && was === 'void' && (existing.signatureId || existing.refusal)) return 'This ticket was signed or refused, so it is kept (void).';
    return null;
  }
  const now = next.status || 'draft';
  if (now === 'signed' && !next.signatureId) return 'A signed ticket needs its signature.';
  if (now === 'refused' && !next.refusal) return 'Record who refused to sign, and when.';
  if (!existing || was === 'draft') {
    if (!['draft', 'signed', 'refused'].includes(now) && !(office && now === 'void')) return 'A ticket is signed or refused before the office prices it.';
    return null;
  }
  const changed = changedKeys(existing, next).filter((k) => k !== 'pricesHidden');
  if (!changed.length) return null;
  if (changed.some((k) => !TICKET_OFFICE_FIELDS.includes(k))) return 'This ticket was signed or refused: its content cannot change. Add a new ticket instead.';
  if (!office) return 'Only the office prices, bills or voids a ticket.';
  if (was !== now) {
    if (was === 'void') return 'This ticket is void.';
    if (!(TICKET_MOVES[was] || []).includes(now)) return `A ${was} ticket cannot become ${now}.`;
    if (now === 'void' && ['signed', 'priced', 'billed'].includes(was) && !fullSession(p)) return 'Voiding a signed ticket needs a full sign-in, not a crew PIN.';
  }
  return null;
}

// ---- money and material requests ------------------------------------------------

/** A non-manager's write to a material request: an error message, or null when allowed. */
function materialRequestRule(p, existing, next) {
  const me = p.employeeId;
  if (!me) return 'Your membership is not linked to an employee record, so you cannot request material.';
  if (existing && existing.employeeId !== me) return 'You can only change your own material requests.';
  if (next && next.employeeId !== me) return 'Request material as yourself.';
  if (existing && (existing.status || 'requested') !== 'requested') return 'This request has gone to the office; ask them to change it.';
  if (!next) return null;
  if (!['requested', 'cancelled'].includes(next.status || 'requested')) return 'Only the office marks requests sent, ordered or fulfilled.';
  if (!same(existing?.costCents ?? null, next.costCents ?? null)) return 'Only the office sets costs.';
  for (const k of ['batchId', 'sentAt', 'stockMoveId']) if (!same(existing?.[k] ?? null, next[k] ?? null)) return 'Only the office handles sent requests.';
  return null;
}

// ---- safety (docs/safety/README.md) ------------------------------------------
// Every role holds `safety`. Managers (owner, admin, office, foreman) do anything; everyone
// else files their own FLHAs, near misses, incidents and inspections, signs toolbox talks for
// themselves and closes corrective actions assigned to them.
const SAFETY_COLLECTIONS = new Set(['flhas', 'toolboxTalks', 'incidents', 'correctiveActions', 'safetyInspections']);

/** Incident fields only managers read: injury, body part, treatment, WCB claim. */
export const MEDICAL_FIELDS = ['medical'];

/** Can this principal see incident medical details? Session managers only (not API keys). */
export const seesMedical = (p) => p.kind === 'session' && Boolean(p.isManager);

const onlyKeys = (existing, next, allowed) => changedKeys(existing, next).filter((k) => !allowed.includes(k));

/** A non-manager's write to a safety collection: an error message, or null when allowed. */
function safetyWriteRule(p, coll, existing, next) {
  if (p.kind === 'api_key') return null;
  const me = p.employeeId;
  if (!me) return 'Your membership is not linked to an employee record, so you cannot file safety records.';
  if (coll === 'flhas') {
    if (!next) return 'Only managers can delete a hazard assessment.';
    if ((existing && existing.employeeId !== me) || next.employeeId !== me) return 'You can only file your own hazard assessment.';
    if (!same(existing?.review ?? null, next.review ?? null)) return 'Only a manager can sign off the review.';
    return null;
  }
  if (coll === 'toolboxTalks') {
    if (!existing || !next) return 'Only managers can schedule or delete toolbox talks.';
    if (onlyKeys(existing, next, ['attendees']).length) return 'You can only sign the attendance sheet.';
    const before = existing.attendees || [];
    const after = next.attendees || [];
    if (after.length < before.length || !before.every((a, i) => same(a, after[i]))) return 'Signatures cannot be removed or changed.';
    if (after.slice(before.length).some((a) => a?.employeeId !== me)) return 'You can only sign for yourself.';
    return null;
  }
  if (coll === 'incidents') {
    if (!next) return 'Only managers can delete an incident report.';
    if (!existing) return next.reportedBy === me ? null : 'File the report as yourself.';
    if (existing.reportedBy !== me) return "Only managers can change someone else's report.";
    if ((existing.status || 'reported') !== 'reported') return 'This report is under investigation; ask a manager to change it.';
    const locked = changedKeys(existing, next).filter((k) => ['status', 'investigation', 'reporting', 'reportedBy', 'closedAt'].includes(k));
    return locked.length ? 'Only managers investigate, close or report incidents.' : null;
  }
  if (coll === 'correctiveActions') {
    if (!next) return 'Only managers delete corrective actions.';
    if (!existing) {
      // A worker may raise an action from their own inspection or report: open, unassigned or theirs.
      if (next.createdBy !== me || (next.status || 'open') !== 'open' || (next.ownerId && next.ownerId !== me)) return 'Only managers assign corrective actions.';
      return null;
    }
    if (existing.ownerId !== me) return 'Only the owner of a corrective action can close it.';
    if (onlyKeys(existing, next, ['status', 'doneAt', 'doneBy', 'doneNote', 'evidence']).length) return 'You can only mark the action done with evidence.';
    if (!['open', 'done'].includes(next.status)) return 'Only a manager can verify a corrective action.';
    return null;
  }
  if (coll === 'safetyInspections') {
    if (!next) return 'Only managers can delete an inspection.';
    if ((existing && existing.inspectorId !== me) || next.inspectorId !== me) return 'You can only file inspections you did.';
    return null;
  }
  return null;
}

/** The manager's review of an off-site flag (time entries). */
const FLAG_REVIEW = ['reviewedAt', 'reviewedBy', 'reviewNote'];

/**
 * Hidden fields a reader could not see cannot be changed by their write either: put the
 * stored values back (a worker editing their own report never wipes the medical details).
 * Returns the record to store.
 */
export function restoreHiddenFields(p, coll, existing, next) {
  return restoreReaderFields(p, coll, existing, restoreServerFields(p, coll, existing, next));
}

/** The system actor a principal writes as ('closing', 'receivables', 'receiving', 'qbo'), or null. */
const systemId = (p) => (p?.kind === 'system' || p?.actor?.type === 'system' ? p?.actor?.id ?? null : null);

/** Keep the stored value of a field ('a.b' nested) or drop it when there is none. */
function keepStored(out, existing, k) {
  if (hasField(existing, k)) putField(out, k, getField(existing, k)); else putField(out, k, undefined);
}

/**
 * Fields only the server writes (docs/releases/r1-get-paid.md 2.5): device writes keep the stored
 * value. settings.closing (system:closing), clients.credit.hold (system:receivables), postedOn and
 * late (the write guards stamp them on create), stock move unit costs and item averages
 * (system:receiving; other moves are stamped by the guards), field ticket numbers.
 */
export function restoreServerFields(p, coll, existing, next) {
  if (!next) return next;
  const sys = systemId(p);
  const keys = [];
  if (coll === 'settings' && sys !== 'closing') keys.push('closing');
  if (coll === 'clients' && sys !== 'receivables') keys.push('credit.hold');
  if (POSTED_COLLECTIONS.includes(coll)) keys.push('postedOn', 'late');
  if (coll === 'stockMoves' && sys !== 'receiving') keys.push('unitCostCents');
  if (coll === 'items' && sys !== 'receiving') keys.push('avgCostCents');
  if (coll === 'fieldTickets') keys.push('number');
  if (!keys.length) return next;
  const out = { ...next };
  for (const k of keys) {
    // A client's credit object may be new in this write: keep the rest of it, put back only the hold.
    if (k === 'credit.hold' && !isObj(out.credit) && !hasField(existing, k)) continue;
    keepStored(out, existing, k);
  }
  return out;
}

function restoreReaderFields(p, coll, existing, next) {
  if (coll === 'timeEntries' && next && p.kind === 'api_key') {
    // An API key never saw the coordinates, so its write keeps the stored ones.
    const out = { ...next };
    for (const k of ENTRY_COORDS) { if (existing && k in existing) out[k] = existing[k]; else delete out[k]; }
    return out;
  }
  if (coll === 'timeEntries' && next && !p.isManager && isObj(next.flag) && existing?.flag?.reviewedAt) {
    // A manager reviewed the off-site flag after the worker's device last pulled the entry: the
    // worker's write (an offline clock-out) keeps the stored review instead of being refused for
    // undoing it. Setting a review the server doesn't have is still refused (checkWriteRules).
    const out = { ...next, flag: { ...next.flag } };
    for (const k of FLAG_REVIEW) { if (k in existing.flag) out.flag[k] = existing.flag[k]; else delete out.flag[k]; }
    return out;
  }
  if (next && MONEY_FIELDS[coll]) {
    if (!seesMoney(p)) return restoreMoney(coll, existing, next);
    if ('pricesHidden' in next) return fillStrippedMoney(coll, existing, next);
    return next;
  }
  if (coll !== 'incidents' || !next) return next;
  const out = { ...next };
  delete out.medicalHidden; // a read marker (redactForReader), never stored
  if (!existing || seesMedical(p)) return out;
  for (const k of MEDICAL_FIELDS) {
    if (k in existing) out[k] = existing[k]; else delete out[k];
  }
  return out;
}

/** Fields hidden from some readers. Returns a copy when anything is removed. */
/** Coordinates on time entries; API keys and AI tools get the distances and flags without them. */
export const ENTRY_COORDS = ['clockInLoc', 'clockOutLoc'];

/** Wages, bill rates and burden stay with whoever manages employees. */
const EMPLOYEE_PAY = ['rateCents', 'billRateCents', 'rateHistory', 'burden'];

export function redactForReader(p, coll, data) {
  if (coll === 'timeEntries' && data && p.kind === 'api_key' && ENTRY_COORDS.some((k) => k in data)) {
    const rest = { ...data };
    for (const k of ENTRY_COORDS) delete rest[k];
    return rest;
  }
  if (data && (MONEY_FIELDS[coll] || coll === 'signatures') && !seesMoney(p)) data = stripMoney(coll, data);
  // Pay rate, bill rate, wage history and burden (lib/tm.js, lib/burden.js) stay with whoever manages employees.
  if (coll === 'employees' && data && p.kind !== 'api_key' && !p.perms.has('employees') && EMPLOYEE_PAY.some((k) => k in data)) {
    const rest = { ...data };
    for (const k of EMPLOYEE_PAY) delete rest[k];
    return rest;
  }
  if (coll === 'incidents' && data && !seesMedical(p) && MEDICAL_FIELDS.some((k) => k in data)) {
    const rest = { ...data };
    for (const k of MEDICAL_FIELDS) delete rest[k];
    rest.medicalHidden = true;
    return rest;
  }
  return data;
}

/** Fields the server never stores. */
export function sanitizeForStorage(coll, data) {
  if (coll === 'employees' && data && 'pin' in data) {
    const { pin, ...rest } = data;
    return rest;
  }
  return data;
}
