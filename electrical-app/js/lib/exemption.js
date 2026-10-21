// Provincial sales tax exemptions on documents (docs/releases/r1-get-paid.md 2.9 and 3.2).
//
// Manitoba (RST Bulletin 031, Mechanical and Electrical Trades): an electrical contractor charges
// RST on the whole selling price of its work unless the customer is exempt FOR THIS CONTRACT: another
// electrical or mechanical contractor subcontracting the work, a reseller, a general contractor
// passing on its exempt customer's exemption, the federal government (its RST number), a Status
// Indian or band on reserve, or farm use (certificate). A general contractor on an ordinary building
// job pays RST. The exemption is per contract, not per customer: the client card holds the evidence
// on file; the job (or a document with no job) says the exemption applies.
//
// Enforcement: a Manitoba invoice with RST off and the basis's evidence missing cannot leave draft
// (the server refuses with 422 exemption_required); Manitoba estimates and BC and SK documents warn.
// Pure (no DOM): the PWA, the server's write rules and the send routes import it.
import { treatmentsFor } from './tax.js';

export const EXEMPT_BASES = [
  { id: 'resale', label: 'Reseller buying for resale' },
  { id: 'subtrade', label: 'Electrical or mechanical subtrade' },
  { id: 'pass-on', label: "General contractor passing on its customer's exemption" },
  { id: 'federal', label: 'Federal government' },
  { id: 'first-nations', label: 'Status Indian or band, on reserve' },
  { id: 'farm', label: 'Farm use (certificate)' },
];
export const EXEMPT_BASIS_LABEL = Object.fromEntries(EXEMPT_BASES.map((b) => [b.id, b.label]));

/**
 * What each basis needs on the document. Keys: 'number' (taxExemptNumber), the rest are
 * taxExemptDetails fields; an array is "any one of these".
 */
export const EXEMPT_EVIDENCE = {
  resale: ['number'],
  subtrade: ['number'],
  'pass-on': ['number', 'endCustomer'],
  federal: ['department', 'number'],
  'first-nations': ['registryNo', ['band', 'reserve']],
  farm: ['farmCertNo'],
};
const FIELD_LABEL = {
  number: 'their RST or PST number', endCustomer: 'the end customer', department: 'the federal department',
  registryNo: 'the registry number', band: 'the band', reserve: 'the reserve', farmCertNo: 'the farm certificate number', basis: 'why the work is exempt',
};

/** Provinces with a separate provincial sales tax on this work. */
export const PST_PROVINCES = ['MB', 'SK', 'BC'];
const PROVINCIAL = new Set(['PST', 'RST']);
const KINDS = ['material', 'labour', 'other'];
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');

/**
 * Lines that count for the exemption: no lineType (deposit, holdback, interest) and not an
 * out-of-pocket pass-through. A work line that turns PST/RST off itself (taxOff) counts as not
 * charged: Bulletin 031 puts RST on the labour too, so taxOff on labour is no way around the evidence.
 */
const workLines = (doc) => (doc?.lines || []).filter((l) => l && !l.lineType && !l.passThrough);
const offIds = (line) => (Array.isArray(line?.taxOff) ? line.taxOff.map((x) => String(x).toUpperCase()) : []);

/** Does a provincial tax component charge this line? */
function provincialOn(line, taxes) {
  const off = offIds(line);
  if (off.includes('*') || off.some((x) => PROVINCIAL.has(x))) return false;
  const kind = KINDS.includes(line.kind) ? line.kind : 'material';
  return (taxes || []).some((t) => PROVINCIAL.has(String(t?.id || '').toUpperCase()) && Number(t.pct) > 0 && (t.applies ? Boolean(t.applies[kind]) : true));
}

/** PST/RST not charged on any work line (lines with a lineType and pass-through lines are not counted). */
export function provincialTaxOff(doc) {
  const lines = workLines(doc);
  if (!lines.length) return false;
  const taxes = Array.isArray(doc.taxes) ? doc.taxes : [];
  return lines.every((l) => !provincialOn(l, taxes));
}

/**
 * Where a line may turn tax off (the server's write rule; r1-get-paid.md 2.9, 3.4). A line with a
 * lineType (deposit, holdback release, interest) may carry any taxOff, '*' included: those are set
 * by money.js. An out-of-pocket pass-through (kind 'other', passThrough) may turn off PST and RST
 * only. Any other line may not turn off PST, RST or every tax ('*'): provincial tax comes off a
 * whole document through its treatment and exemption, never line by line. Returns null, or
 * { index, message } for the first line that breaks it.
 */
export function lineTaxOffProblem(doc) {
  const lines = Array.isArray(doc?.lines) ? doc.lines : [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const off = offIds(l);
    if (!off.length || l.lineType) continue;
    const n = i + 1;
    if (l.passThrough && l.kind === 'other') {
      if (off.some((x) => !PROVINCIAL.has(x))) return { index: i, message: `Line ${n} is an out-of-pocket disbursement: only PST or RST comes off it.` };
      continue;
    }
    if (off.includes('*')) return { index: i, message: `Line ${n} turns every tax off. Only deposit, holdback and interest lines do that.` };
    if (off.some((x) => PROVINCIAL.has(x))) {
      return { index: i, message: `Line ${n} turns ${off.includes('RST') ? 'RST' : 'PST'} off. Only an out-of-pocket disbursement line does that; for exempt work, record the exemption on the job or document.` };
    }
  }
  return null;
}

/** The evidence a document still lacks for its basis (field keys), [] when complete. */
export function missingEvidence(doc) {
  const basis = doc?.taxExemptBasis;
  if (!basis || !EXEMPT_EVIDENCE[basis]) return ['basis'];
  const details = doc.taxExemptDetails || {};
  const has = (k) => (k === 'number' ? str(doc.taxExemptNumber) : str(details[k]));
  const out = [];
  for (const need of EXEMPT_EVIDENCE[basis]) {
    if (Array.isArray(need)) { if (!need.some(has)) out.push(need[0]); } else if (!has(need)) out.push(need);
  }
  return out;
}

const taxName = (province) => (province === 'MB' ? 'RST' : 'PST');

/**
 * 'No tax' reasons that are about the supply, not the customer: a zero-rated, exempt or
 * out-of-scope supply needs no customer exemption. 'relief' (Indian Act) is the customer's, so it
 * still needs the First Nations evidence.
 */
export const SUPPLY_NONE_REASONS = ['zero', 'exempt', 'out_of_scope'];

/**
 * The exemption check before a document is sent (docType or collection 'estimates' for an
 * estimate; anything else is treated as an invoice): null, or
 * { level: 'block'|'warn', code: 'exemption_required', message, missing: [] }.
 * MB invoices block; MB estimates and BC and SK documents warn. Skipped: interest and credit
 * notes (a credit follows its original), holdback release invoices, security deposits, documents
 * with no work lines, BC real-property contracts (not an exemption), treatment 'none' for a
 * zero-rated, exempt or out-of-scope supply, and provinces without PST.
 */
export function exemptionProblem(doc, { docType, collection } = {}) {
  if (!doc) return null;
  const province = doc.taxProvince;
  if (!PST_PROVINCES.includes(province)) return null;
  const kind = doc.kind || 'standard';
  if (['interest', 'credit', 'holdback-release'].includes(kind)) return null;
  if (kind === 'deposit' && doc.depositModel === 'security') return null;
  // 'real-property' is a valid, RST-exempt-by-design treatment only where the province offers it
  // (BC services to real property). In Manitoba electrical work is goods, so an unexpected
  // 'real-property' treatment (a direct API or sync write) still needs evidence or is blocked.
  if (doc.taxTreatment === 'real-property' && treatmentsFor(province).includes('real-property')) return null;
  if (doc.taxTreatment === 'none' && SUPPLY_NONE_REASONS.includes(doc.taxNoneReason)) return null;
  if (!provincialTaxOff(doc)) return null;
  const missing = missingEvidence(doc);
  if (!missing.length) return null;
  const type = docType || collection;
  const isEstimate = type === 'estimates' || type === 'estimate';
  const level = province === 'MB' && !isEstimate ? 'block' : 'warn';
  const t = taxName(province);
  const what = missing.map((k) => FIELD_LABEL[k] || k).join(', ');
  const message = province === 'MB'
    ? `${t} is not charged on this work. Record why on the job (or this document): ${what}. A general contractor on an ordinary building job pays RST (Bulletin 031).`
    : `${t} is not charged on this work. Keep the customer's exemption on file: ${what}.`;
  return { level, code: 'exemption_required', message, missing };
}

/**
 * The exemption a new document starts with: the job's taxExempt, else nothing. The client's
 * evidence on file never applies by itself; it prefills the editor when the office ticks "This work
 * is exempt" (exemptionConfirmed).
 */
export function exemptionFor({ job, client, province } = {}) {
  void client;
  const x = job?.taxExempt;
  if (!x || !x.basis) return {};
  if (province && x.province && x.province !== province) return {};
  const details = { ...(x.details || {}) };
  if (x.endCustomer) details.endCustomer = x.endCustomer;
  return { taxExemptNumber: x.number || null, taxExemptBasis: x.basis, taxExemptDetails: details };
}

/** The client's evidence on file as document fields (the editor's prefill after the tick). */
export function exemptionFromClient(client) {
  if (!client?.taxExemptBasis) return {};
  return { taxExemptNumber: client.taxExemptNumber || null, taxExemptBasis: client.taxExemptBasis, taxExemptDetails: { ...(client.taxExemptDetails || {}) } };
}

/** Lines printed on the document, e.g. ['RST exemption: Electrical or mechanical subtrade, RST no. 1234567']. */
export function exemptionPrintLines(doc) {
  const basis = doc?.taxExemptBasis;
  if (!basis) return [];
  const t = taxName(doc.taxProvince);
  const d = doc.taxExemptDetails || {};
  const head = `${t} exemption: ${EXEMPT_BASIS_LABEL[basis] || basis}`;
  const lines = [str(doc.taxExemptNumber) ? `${head}, ${basis === 'federal' ? 'federal RST' : t} no. ${str(doc.taxExemptNumber)}` : head];
  if (basis === 'pass-on' && str(d.endCustomer)) lines.push(`End customer: ${str(d.endCustomer)}`);
  if (basis === 'federal' && str(d.department)) lines.push(`Department: ${str(d.department)}`);
  if (basis === 'first-nations') {
    const parts = [str(d.name) && `Name: ${str(d.name)}`, str(d.registryNo) && `registry no. ${str(d.registryNo)}`, str(d.band) && `band: ${str(d.band)}`, str(d.reserve) && `reserve: ${str(d.reserve)}`].filter(Boolean);
    if (parts.length) lines.push(parts.join(', '));
  }
  if (basis === 'farm' && str(d.farmCertNo)) lines.push(`Farm certificate no. ${str(d.farmCertNo)}`);
  return lines;
}
