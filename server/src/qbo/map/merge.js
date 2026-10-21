// The three-way merge of a linked pair (docs/integrations/quickbooks.md 5.5, 5.6). Pure.
//
// B is the snapshot (the canonical form both sides last agreed on), L the Fishtape record's
// canonical form, R the QBO object's. Each field is decided on its own:
//
//   L = B, R = B          nothing to do
//   L = B, R ≠ B          take R (write Fishtape)
//   R = B, L ≠ B          take L (write QBO)
//   L = R ≠ B             both changed alike: the snapshot moves, nothing is written
//   both changed, auto    the later edit wins (per-field times); within 10 minutes or a time unknown: conflict
//   both changed, money   conflict
//   B = null (relink)     every field where L ≠ R is a conflict
//
// While any field is in conflict nothing is written for the record (5.6): toLocal and toRemote are
// then empty and `merged` is only informative.
import { createHash } from 'node:crypto';
import { canonEqual, compareKey, stableStringify } from './canon.js';
import { formatMoney } from '../../../../electrical-app/js/lib/money.js';

/**
 * Field classes per collection (5.5). `money` fields conflict when both sides changed; `auto`
 * fields go to the later edit; `pushOnly` fields are written to QBO and never read back.
 * The last four collections are push only: every field is written to QBO whenever L or R moved
 * (a QBO-side edit is overwritten), except a purchase order's status, which QBO closes.
 */
export const FIELD_RULES = {
  clients: { money: [], auto: ['name', 'type', 'email', 'phone', 'address', 'active'], pushOnly: ['notes'] },
  vendors: { money: [], auto: ['name', 'companyName', 'email', 'phone', 'address', 'accountNumber', 't5018', 'notes', 'active'], pushOnly: [] },
  items: { money: ['priceCents', 'costCents'], auto: ['name', 'sku', 'description', 'active'], pushOnly: [] },
  estimates: { money: ['number', 'clientRef', 'jobRef', 'date', 'lines', 'status'], auto: ['validUntil', 'notes'], pushOnly: ['title'] },
  invoices: { money: ['number', 'clientRef', 'jobRef', 'date', 'lines', 'status'], auto: ['dueDate', 'notes', 'estimateRef'], pushOnly: ['title'] },
  payments: { money: ['invoiceRef', 'amountCents', 'date'], auto: ['method', 'reference'], pushOnly: [] },
  bills: { money: ['vendorRef', 'number', 'date', 'lines', 'taxes', 'kind'], auto: ['dueDate', 'notes', 'paidWith'], pushOnly: [] },
  jobs: { money: [], auto: [], pushOnly: ['name', 'parentRef', 'address', 'active'] },
  purchaseOrders: { money: [], auto: ['status'], pushOnly: ['vendorRef', 'number', 'date', 'dueDate', 'lines', 'shipTo', 'notes'] },
  timeEntries: { money: [], auto: [], pushOnly: ['employeeRef', 'customerRef', 'itemRef', 'date', 'minutes', 'description'] },
  stripePayouts: { money: [], auto: [], pushOnly: ['amountCents', 'date', 'fromRef', 'toRef'] },
  paymentFee: { money: [], auto: [], pushOnly: ['amountCents', 'date'] },
  payoutFee: { money: [], auto: [], pushOnly: ['amountCents', 'date', 'lines'] },
  // A credit note applied to an invoice: the $0 QuickBooks payment Fishtape writes (r1-get-paid.md 9.2).
  creditApply: { money: [], auto: [], pushOnly: ['invoiceRef', 'memoRef', 'amountCents', 'date'] },
};

/** Collections Fishtape owns alone (5.5): L is written whenever L ≠ B or R ≠ B. */
export const PUSH_ONLY_COLLECTIONS = ['jobs', 'purchaseOrders', 'timeEntries', 'stripePayouts', 'paymentFee', 'payoutFee', 'creditApply'];

/** The FIELD_RULES key for a link: Stripe fee objects and credit-note applications have their own rules. */
export function canonCollection(collection, role = 'main') {
  if (role === 'fee' && collection === 'payments') return 'paymentFee';
  if (role === 'fee' && collection === 'stripePayouts') return 'payoutFee';
  if (role === 'apply' && collection === 'payments') return 'creditApply';
  return collection;
}

/**
 * The record keys behind each money field (5.2): a stale device write that changes one of these
 * after a `system:qbo` version changed it is held, not applied.
 */
export const MONEY_RECORD_KEYS = {
  items: { priceCents: ['priceCents'], costCents: ['costCents'] },
  estimates: {
    number: ['number'], clientRef: ['clientId'], jobRef: ['jobId'], date: ['issueDate', 'createdAt'],
    lines: ['lines', 'markupPct', 'taxes', 'taxPct', 'taxProvince', 'taxTreatment', 'taxNoneReason'], status: ['status'],
  },
  invoices: {
    number: ['number'], clientRef: ['clientId'], jobRef: ['jobId'], date: ['issueDate'],
    lines: ['lines', 'markupPct', 'taxes', 'taxPct', 'taxProvince', 'taxTreatment', 'taxNoneReason', 'holdback'], status: ['status'],
  },
  payments: { invoiceRef: ['invoiceId'], amountCents: ['amountCents'], date: ['date'] },
  bills: {
    vendorRef: ['vendorId'], number: ['number'], date: ['date'], lines: ['lines', 'jobId', 'taxes', 'taxProvince'],
    taxes: ['taxes', 'taxProvince'], kind: ['kind'],
  },
};

const TEN_MINUTES = 10 * 60 * 1000;

/** Every field of a collection, money first. */
export function fieldsOf(collection) {
  const r = FIELD_RULES[collection];
  if (!r) throw new Error(`no field rules for ${collection}`);
  return [...r.money, ...r.auto, ...r.pushOnly];
}
export function fieldClass(collection, field) {
  const r = FIELD_RULES[collection];
  if (r.money.includes(field)) return 'money';
  if (r.auto.includes(field)) return 'auto';
  return 'pushOnly';
}

/** sha256 of a value's stable JSON (the remoteAlias hashes, 6.4). */
export function canonHash(value) {
  return createHash('sha256').update(stableStringify(value ?? null), 'utf8').digest('hex');
}
/** The remoteAlias hash of a field's canonical value: the hash of what is compared. */
export const aliasHash = (collection, field, value) => canonHash(compareKey(collection, field, value));

const val = (side, f) => (side && side[f] !== undefined ? side[f] : null);
function timeOf(at, field) {
  const t = at && typeof at === 'object' && !(at instanceof Date) ? at[field] : at;
  if (t == null || t === '') return null;
  const ms = new Date(t).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** Fields whose record keys a `held` object touches (keys may also be field names). */
function heldFields(collection, held) {
  const keys = held && typeof held === 'object' ? Object.keys(held) : [];
  if (!keys.length) return new Set();
  const out = new Set();
  const map = MONEY_RECORD_KEYS[collection] || {};
  for (const [field, recordKeys] of Object.entries(map)) if (recordKeys.some((k) => keys.includes(k)) || keys.includes(field)) out.add(field);
  return out;
}

/**
 * Decide each field of a linked pair.
 * @param {string} collection a FIELD_RULES key (canonCollection for fee links)
 * @param {object|null} base the snapshot (null after a relink)
 * @param {object} local L
 * @param {object} remote R
 * @param {object} [opts]
 * @param {object|string} [opts.localAt]  { field: time } of the first Fishtape edit after the snapshot (or one time for all)
 * @param {object|string} [opts.remoteAt] { field: time } from meta.fieldSeenAt (or one time for all)
 * @param {object} [opts.prevValues] { field: canonical value a pull replaced in Fishtape } (stale revert guard)
 * @param {boolean} [opts.stale] the outbox row came from a stale device write
 * @param {object} [opts.held] device money values records.js held back ({ recordKey: value }); L must be
 *   built from the record with those values applied, so the conflict shows the device's value
 * @param {object} [opts.remoteAlias] { field: aliasHash } R values that count as equal to B (6.4)
 * @returns {{ merged, toLocal: string[], toRemote: string[], conflicts: { field, base, fishtape, quickbooks }[], autoResolved: { field, winner }[], aliasDropped: string[] }}
 */
export function threeWayMerge(collection, base, local, remote, { localAt = null, remoteAt = null, prevValues = null, stale = false, held = null, remoteAlias = null } = {}) {
  const pushOnlyColl = PUSH_ONLY_COLLECTIONS.includes(collection);
  const same = (f, a, b) => canonEqual(collection, f, a, b);
  const heldSet = heldFields(collection, held);
  const merged = { ...(base || {}), ...(local?.extra !== undefined ? { extra: local.extra } : {}) };
  const toLocal = [], toRemote = [], conflicts = [], autoResolved = [], aliasDropped = [];
  const conflict = (f, B, L, R) => conflicts.push({ field: f, base: B, fishtape: L, quickbooks: R });

  for (const f of fieldsOf(collection)) {
    const cls = fieldClass(collection, f);
    const L = val(local, f), R = val(remote, f);
    const B = base ? val(base, f) : null;

    if (cls === 'pushOnly') {
      // Written to QBO when Fishtape moved (or, for push-only collections, when either moved).
      // After a relink nothing is overwritten: the next Fishtape edit sends it.
      merged[f] = L;
      if (base === null) { if (pushOnlyColl && !same(f, L, R)) toRemote.push(f); continue; }
      if (!same(f, L, B) || (pushOnlyColl && !same(f, R, B))) {
        toRemote.push(f);
        if (pushOnlyColl && same(f, L, B)) autoResolved.push({ field: f, winner: 'fishtape' });
      }
      continue;
    }

    if (base === null) {
      if (same(f, L, R)) merged[f] = L;
      else { merged[f] = L; conflict(f, null, L, R); }
      continue;
    }

    let rEqB = same(f, R, B);
    if (!rEqB && remoteAlias && remoteAlias[f] != null) {
      if (aliasHash(collection, f, R) === remoteAlias[f]) rEqB = true;
      else aliasDropped.push(f);
    }
    const lEqB = same(f, L, B);

    if (heldSet.has(f) && !same(f, L, R)) { merged[f] = B; conflict(f, B, L, R); continue; }

    // Stale revert guard (5.5): a device that never saw the pull put the old value back.
    const reverted = stale && prevValues && Object.prototype.hasOwnProperty.call(prevValues, f) && !lEqB && same(f, L, prevValues[f]);
    if (reverted) {
      if (cls === 'money') { merged[f] = B; conflict(f, B, L, R); }
      else { merged[f] = R; if (!same(f, L, R)) toLocal.push(f); autoResolved.push({ field: f, winner: 'quickbooks' }); }
      continue;
    }

    if (lEqB && rEqB) { merged[f] = B; continue; }
    if (lEqB) { merged[f] = R; toLocal.push(f); continue; }
    if (rEqB) { merged[f] = L; toRemote.push(f); continue; }
    if (same(f, L, R)) { merged[f] = L; continue; }
    if (cls === 'money') { merged[f] = B; conflict(f, B, L, R); continue; }
    // auto: the later edit wins, unless the times are close or unknown
    const lt = timeOf(localAt, f), rt = timeOf(remoteAt, f);
    if (lt == null || rt == null || Math.abs(lt - rt) <= TEN_MINUTES) { merged[f] = B; conflict(f, B, L, R); continue; }
    if (lt > rt) { merged[f] = L; toRemote.push(f); autoResolved.push({ field: f, winner: 'fishtape' }); }
    else { merged[f] = R; toLocal.push(f); autoResolved.push({ field: f, winner: 'quickbooks' }); }
  }

  if (conflicts.length) return { merged, toLocal: [], toRemote: [], conflicts, autoResolved: [], aliasDropped };
  return { merged, toLocal, toRemote, conflicts, autoResolved, aliasDropped };
}

// ---------------------------------------------------------------------------------------------
// Display values for conflict and review screens (money in dollars, lines as a short list)

const LABELS = {
  name: 'Name', type: 'Type', email: 'Email', phone: 'Phone', address: 'Address', active: 'Active', notes: 'Notes',
  companyName: 'Company', accountNumber: 'Account number', t5018: 'T5018 subcontractor', sku: 'SKU', description: 'Description',
  priceCents: 'Price', costCents: 'Cost', number: 'Number', clientRef: 'Customer', jobRef: 'Job', date: 'Date', lines: 'Lines',
  status: 'Status', validUntil: 'Valid until', dueDate: 'Due date', estimateRef: 'Estimate', title: 'Title',
  invoiceRef: 'Invoice', amountCents: 'Amount', method: 'Method', reference: 'Reference', vendorRef: 'Supplier', taxes: 'Tax',
  kind: 'Kind', paidWith: 'Paid with', parentRef: 'Client', shipTo: 'Ship to', employeeRef: 'Employee', customerRef: 'Customer or job',
  itemRef: 'Item', minutes: 'Hours', fromRef: 'From account', toRef: 'To account', memoRef: 'Credit memo',
};
/** The label of a field for conflict screens. */
export const fieldLabel = (field) => LABELS[field] || field;

const MONEY_FIELDS = new Set(['priceCents', 'costCents', 'amountCents']);
const REF_FIELDS = new Set(['clientRef', 'jobRef', 'estimateRef', 'invoiceRef', 'vendorRef', 'parentRef', 'customerRef', 'itemRef', 'fromRef', 'toRef', 'memoRef']);
const STATUS_WORDS = { open: 'Open', void: 'Void', pending: 'Pending', accepted: 'Accepted', rejected: 'Declined', closed: 'Closed', draft: 'Draft', cancelled: 'Cancelled' };

/** A canonical value as people read it: "3 lines, $1,065.00", "$12.50", "Yes", "(empty)". */
export function displayValue(collection, field, value) {
  if (value === null || value === undefined || value === '') return '(empty)';
  if (field === 'lines' && Array.isArray(value)) {
    const total = value.reduce((s, l) => s + (Number(l.amountCents) || 0), 0);
    return `${value.length} line${value.length === 1 ? '' : 's'}, ${formatMoney(total)}`;
  }
  if (field === 'taxes' && Array.isArray(value)) {
    if (!value.length) return 'No tax';
    return value.map((t) => `${t.id} ${formatMoney(t.cents)}`).join(' + ');
  }
  if (MONEY_FIELDS.has(field)) return formatMoney(value);
  if (field === 'method' || field === 'paidWith') return value.key || (value.ref ? `QuickBooks #${value.ref}` : '(empty)');
  if (field === 'employeeRef') return value.ref ? `${value.nameOf} #${value.ref}` : '(empty)';
  if (field === 'minutes') return `${Math.floor(value / 60)} h ${String(value % 60).padStart(2, '0')} min`;
  if (REF_FIELDS.has(field)) return `QuickBooks #${value}`;
  if (field === 'status') return STATUS_WORDS[value] || String(value);
  if (field === 'type' && collection === 'clients') return value === 'business' ? 'Business (company name)' : 'Residential';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

/** Conflict rows for storage: [{ field, label, base, fishtape, quickbooks }] in display values (5.6). */
export function conflictRows(collection, conflicts) {
  return (conflicts || []).map((c) => ({
    field: c.field, label: fieldLabel(c.field), base: displayValue(collection, c.field, c.base),
    fishtape: displayValue(collection, c.field, c.fishtape), quickbooks: displayValue(collection, c.field, c.quickbooks),
  }));
}
