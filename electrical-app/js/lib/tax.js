// Canadian sales tax: GST, HST and the provincial taxes (BC PST, SK PST, MB RST,
// QC QST), by province and date, plus how each tax applies to an electrical
// contractor's material, labour and other lines. Pure functions, no DOM.
//
// Rates and rules are dated and sourced in docs/code/tax.md. Sales tax on
// construction work is not simple: whether PST/RST is charged on a contract
// depends on whether the work becomes part of real property, on the province,
// and sometimes on the customer. The treatments below are presets to start
// from, not tax advice. Check with your accountant.
import { exemptionFor } from './exemption.js';

export const PROVINCES = [
  { code: 'AB', name: 'Alberta' },
  { code: 'BC', name: 'British Columbia' },
  { code: 'MB', name: 'Manitoba' },
  { code: 'NB', name: 'New Brunswick' },
  { code: 'NL', name: 'Newfoundland and Labrador' },
  { code: 'NS', name: 'Nova Scotia' },
  { code: 'NT', name: 'Northwest Territories' },
  { code: 'NU', name: 'Nunavut' },
  { code: 'ON', name: 'Ontario' },
  { code: 'PE', name: 'Prince Edward Island' },
  { code: 'QC', name: 'Quebec' },
  { code: 'SK', name: 'Saskatchewan' },
  { code: 'YT', name: 'Yukon' },
];
export const provinceName = (code) => PROVINCES.find((p) => p.code === code)?.name || code || '—';

const GST = { id: 'GST', label: 'GST', pct: 5 };
const hst = (pct) => [{ id: 'HST', label: 'HST', pct }];
const gstPlus = (id, label, pct) => [GST, { id, label, pct }];

// Sources (checked 2026-10-19; details and links in docs/code/tax.md):
//  - GST/HST: CRA "GST/HST rates" calculator page, canada.ca, modified 2025-04-01
//    https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-which-rate/calculator.html
//  - NS HST 15% -> 14% on 2025-04-01: NS news release 2024-10-23 and NS Finance transitional rules.
//  - BC PST 7%: gov.bc.ca/pst (updated 2026-09-21).  SK PST 6% since 2017-03-23: saskatchewan.ca, 2017 budget.
//  - MB RST 7% since 2019-07-01 (was 8%): Manitoba Bulletin 005 (rev. July 2019).
//  - QC QST 9.975% since 2013-01-01: Revenu Québec rate tables.
//  - Earlier rows (2008 GST cut to 5%, HST 13% in 2008, NS 15% from 2010-07-01, NB/NL 15% and
//    PE 15% in 2016, PE HST start 2013-04-01) are from CRA history; only current rates were re-fetched.
// PST, RST and QST are each charged on the price before GST (no tax on tax).
// Each list is newest first; `from` is the first day the rate applies.
export const RATE_HISTORY = {
  AB: [{ from: '2008-01-01', parts: [GST] }],
  BC: [{ from: '2013-04-01', parts: gstPlus('PST', 'PST', 7) }],
  MB: [
    { from: '2019-07-01', parts: gstPlus('RST', 'RST', 7) },
    { from: '2013-07-01', parts: gstPlus('RST', 'RST', 8) },
  ],
  NB: [{ from: '2016-07-01', parts: hst(15) }, { from: '2008-01-01', parts: hst(13) }],
  NL: [{ from: '2016-07-01', parts: hst(15) }, { from: '2008-01-01', parts: hst(13) }],
  NS: [{ from: '2025-04-01', parts: hst(14) }, { from: '2010-07-01', parts: hst(15) }, { from: '2008-01-01', parts: hst(13) }],
  NT: [{ from: '2008-01-01', parts: [GST] }],
  NU: [{ from: '2008-01-01', parts: [GST] }],
  ON: [{ from: '2010-07-01', parts: hst(13) }],
  PE: [{ from: '2016-10-01', parts: hst(15) }, { from: '2013-04-01', parts: hst(14) }],
  QC: [{ from: '2013-01-01', parts: gstPlus('QST', 'QST', 9.975) }],
  SK: [{ from: '2017-03-23', parts: gstPlus('PST', 'PST', 6) }],
  YT: [{ from: '2008-01-01', parts: [GST] }],
};

const ISO = (d) => (d instanceof Date ? d.toISOString() : String(d || new Date().toISOString())).slice(0, 10);

/** The tax parts in force in a province on a date (YYYY-MM-DD), e.g. [{ id: 'HST', pct: 13 }]. */
export function ratesOn(province, date = new Date()) {
  const hist = RATE_HISTORY[province];
  if (!hist) return [];
  const day = ISO(date);
  const row = hist.find((r) => r.from <= day) || hist[hist.length - 1];
  return row.parts.map((p) => ({ ...p }));
}

const ALL = { material: true, labour: true, other: true };
const NONE = { material: false, labour: false, other: false };
const GOODS = { material: true, labour: false, other: false };

/**
 * Treatments: which line kinds each tax applies to. GST/HST/QST apply to the
 * whole contract (materials and labour) everywhere. The PST provinces differ:
 *  - BC: services to real property are not subject to PST; the contractor pays PST on
 *    materials that become real property (lump sum or T&M) and charges PST on goods sold
 *    without install, or goods that stay goods plus their installation (gov.bc.ca
 *    "PST for Real Property Contractors", updated 2025-11-27; Bulletin PST 301).
 *  - SK: PST on the total charge for services to real property, residential and commercial,
 *    labour and materials included; no option to pay PST on materials instead
 *    (Bulletin PST-12 and PST-38, rev. July 2024).
 *  - MB: electrical systems are tangible personal property, so RST applies to the total
 *    selling price of electrical contracts and service work, labour included
 *    (Bulletin 031 Mechanical and Electrical Trades, rev. July 2019).
 *   applies: { [taxId]: { material, labour, other } }; taxes not listed apply to ALL.
 */
export const TREATMENTS = {
  standard: {
    label: 'Tax on everything',
    hint: 'GST/HST (and QST) on materials, labour and other lines.',
    applies: {},
  },
  'pst-all': {
    label: 'PST/RST on the whole contract',
    hint: 'PST/RST on materials, labour and other lines, shown as its own line.',
    applies: {},
    hints: {
      SK: 'Saskatchewan: PST applies to the total charge for services to real property, residential or commercial, labour included (Bulletin PST-12). Buy materials PST-exempt with your vendor’s licence.',
      MB: 'Manitoba: electrical systems count as goods, so RST applies to the whole contract, labour included (Bulletin 031). Buy wire and gear RST-exempt with your RST number.',
    },
  },
  'real-property': {
    label: 'Real property contract (no PST charged)',
    hint: 'Supply and install work that becomes part of the building (in-wall wiring, fixed lights, hardwired fans and alarms). You pay PST on the materials when you buy them and do not charge it.',
    applies: { PST: NONE, RST: NONE },
    note: 'Services to real property: PST is not charged. PST was paid on the materials.',
  },
  'separate-goods': {
    label: 'Goods sold without install (PST on materials)',
    hint: 'Materials or equipment sold supply-only. PST on material lines.',
    applies: { PST: GOODS, RST: GOODS },
  },
  'tpp-service': {
    label: 'Goods that stay goods, with install (PST on all)',
    hint: 'Supplying and installing, or repairing, things that do not become part of the building (plug-in equipment, freestanding appliances). PST on parts and labour (Bulletin PST 301).',
    applies: { PST: ALL, RST: ALL },
  },
  'gst-only': {
    label: 'PST/RST exempt, GST charged',
    hint: 'For a customer who quotes their PST/RST licence or exemption number for this work: GST on everything, no PST/RST. Record the number on the document.',
    // Per province (docs/code/tax.md, gap analysis section A): a general contractor on an ordinary
    // building job is not exempt in Manitoba or Saskatchewan.
    hints: {
      MB: 'Manitoba: only when the customer is another electrical or mechanical contractor subcontracting this work to you, a reseller, or a general contractor passing on an exempt customer’s exemption (federal government RST number, Status Indian or band on reserve, farm-use certificate). A general contractor on an ordinary building job pays RST (Bulletins 031, 005). The exemption is for this contract only: record it on the job and their 7-digit RST number on the invoice (Bulletin 004). Travel time and permits are part of the taxable price.',
      SK: 'Saskatchewan: only when the customer gives a PST vendor’s licence or exemption for this work (a licensed contractor buying for resale, or an exempt customer). A general contractor on an ordinary building job pays PST (Bulletin PST-12). Record their number on the invoice.',
      BC: 'British Columbia: only for a customer who gives a PST number for goods they will resell. Record the number on the invoice.',
    },
    applies: { PST: NONE, RST: NONE },
    note: 'PST/RST exempt: the customer’s licence or exemption number is on file.',
  },
  none: {
    label: 'No tax',
    hint: 'No GST/HST and no provincial tax: a zero-rated, exempt or out-of-scope supply, or a customer with Indian Act relief. Pick why on the document and keep the proof on file.',
    hints: {
      BC: 'No GST and no PST: a zero-rated, exempt or out-of-scope supply, or a customer with Indian Act relief. Pick why on the document and keep the proof on file. A customer with a PST number still pays GST: use “PST/RST exempt, GST charged”.',
      SK: 'No GST and no PST: a zero-rated, exempt or out-of-scope supply, or a Status Indian or band buying for use on reserve (Indian Act s.87). Pick why on the document and keep the proof on file. A customer with a PST number or another exemption still pays GST: use “PST/RST exempt, GST charged”.',
      MB: 'No GST and no RST: a zero-rated, exempt or out-of-scope supply, or a Status Indian or band buying for use on reserve (Indian Act s.87). Pick why on the document and keep the proof on file. A customer with an RST number, the federal government, a farm certificate or a general contractor passing on an exemption still pays GST: use “PST/RST exempt, GST charged”.',
    },
    applies: null,
  },
};

/**
 * Why a document charges no tax (`taxNoneReason` on estimates and invoices). Each lands on
 * different GST return lines, so the QuickBooks sync maps each to its own tax code.
 */
export const TAX_NONE_REASONS = [
  { id: 'zero', label: 'Zero-rated supply' },
  { id: 'exempt', label: 'Exempt supply' },
  { id: 'out_of_scope', label: 'Out of scope (not a taxable supply in Canada)' },
  { id: 'relief', label: 'Indian Act relief (or similar)' },
];

/** Treatments that make sense in a province, the first being the default. */
export function treatmentsFor(province) {
  if (province === 'BC') return ['real-property', 'tpp-service', 'separate-goods', 'gst-only', 'none'];
  if (province === 'SK' || province === 'MB') return ['pst-all', 'gst-only', 'none'];
  return ['standard', 'none'];
}

/** The hint for a treatment in a province. */
export function treatmentHint(treatment, province) {
  const t = TREATMENTS[treatment];
  return t?.hints?.[province] || t?.hint || '';
}

/**
 * taxComponents({ province, treatment, date }) -> the components to snapshot on a
 * document: [{ id, label, pct, applies: { material, labour, other }, note }].
 */
export function taxComponents({ province, treatment, date = new Date() }) {
  const t = TREATMENTS[treatment] || TREATMENTS[treatmentsFor(province)[0]];
  if (!t.applies) return [];
  return ratesOn(province, date).map((p) => {
    const applies = { ...(t.applies[p.id] || ALL) };
    const exempt = !applies.material && !applies.labour && !applies.other;
    return { id: p.id, label: p.label, pct: p.pct, applies, note: exempt ? (t.note || '') : '' };
  });
}

/** "GST 5% + PST 7%" (components that tax nothing are left out). */
export function describeTaxes(taxes) {
  const on = (taxes || []).filter((t) => !t.applies || t.applies.material || t.applies.labour || t.applies.other);
  if (!on.length) return 'No tax';
  return on.map((t) => `${t.label} ${fmtPct(t.pct)}%`).join(' + ');
}

export function fmtPct(p) {
  return String(Math.round((Number(p) || 0) * 1000) / 1000);
}

/** The company's tax set-up with defaults filled in (old settings records have only taxPct). */
export function taxSetup(settings = {}) {
  const province = settings.company?.province || 'ON';
  const tax = settings.tax || {};
  const allowed = treatmentsFor(province);
  return {
    mode: tax.mode === 'custom' ? 'custom' : 'province',
    province,
    treatment: allowed.includes(tax.treatment) ? tax.treatment : allowed[0],
    custom: Array.isArray(tax.custom) ? tax.custom : [],
  };
}

/**
 * Tax fields for a new estimate or invoice:
 * { taxProvince, taxTreatment, taxes, taxPct } (taxPct = combined, for older readers).
 *
 * With a job whose taxExempt applies (lib/exemption.js exemptionFor, contract r1-get-paid.md 3.1),
 * the default treatment is 'gst-only' ('none' with taxNoneReason 'relief' for First Nations on
 * reserve) and the result carries the exemption snapshot (taxExemptNumber, taxExemptBasis,
 * taxExemptDetails). A client's evidence alone never changes the default: the office ticks
 * "This work is exempt" on the document. Callers without a job or client are unchanged.
 */
export function newDocTax(settings, date = new Date(), { client = null, job = null } = {}) {
  const s = taxSetup(settings);
  if (s.mode === 'custom') {
    const taxes = s.custom.map((c, i) => ({ id: c.id || `T${i + 1}`, label: c.label || `Tax ${i + 1}`, pct: Number(c.pct) || 0, applies: { ...ALL, ...(c.applies || {}) }, note: '' }));
    return { taxProvince: null, taxTreatment: 'custom', taxes, taxPct: combinedRate(taxes) };
  }
  const ex = (job || client) ? exemptionFor({ job, client, province: s.province }) : {};
  let treatment = s.treatment;
  let extra = {};
  if (ex.taxExemptBasis && treatmentsFor(s.province).includes('gst-only')) {
    const onReserve = ex.taxExemptBasis === 'first-nations' && Boolean(String(ex.taxExemptDetails?.reserve || '').trim());
    treatment = onReserve ? 'none' : 'gst-only';
    extra = {
      taxExemptNumber: ex.taxExemptNumber ?? null,
      taxExemptBasis: ex.taxExemptBasis,
      taxExemptDetails: { ...(ex.taxExemptDetails || {}) },
      ...(onReserve ? { taxNoneReason: 'relief' } : {}),
    };
  }
  const taxes = taxComponents({ province: s.province, treatment, date });
  return { taxProvince: s.province, taxTreatment: treatment, taxes, taxPct: combinedRate(taxes), ...extra };
}

/**
 * Line presets that switch some taxes off on one line (`taxOff`, only on labour and other lines).
 * The out-of-pocket disbursement (Bulletin 031 section 3: hotel and meals billed at cost) carries
 * GST but no PST/RST and, while the rule holdback.excludePassThrough holds, sits outside the
 * holdback base. Offered in Manitoba while tax.MB.passThroughAllowed holds (a VERIFY policy).
 * Travel time and permits are part of the taxable price: they are never pass-through.
 */
export const TAX_OFF_PRESETS = [
  {
    id: 'pass-through',
    label: 'Out-of-pocket disbursement at cost (hotel, meals; not travel time or permits)',
    kind: 'other',
    passThrough: true,
    taxOff: ['PST', 'RST'],
    warning: 'Travel time and permits are taxable. Use a normal line for them.',
    printSuffix: '(at cost, no RST)',
  },
];

/** The provincial sales tax's short name in a province: 'RST' (MB), 'PST' (BC, SK), 'QST', or null. */
export function provincialTaxId(province) {
  if (province === 'MB') return 'RST';
  if (province === 'BC' || province === 'SK') return 'PST';
  if (province === 'QC') return 'QST';
  return null;
}

/**
 * A warning (never a refusal) when an exemption number does not look like the province's format.
 * Formats are VERIFY (docs/code/tax.md, Registration numbers): Manitoba RST numbers have 7 digits
 * (Bulletin 004; often written 123456-7), Saskatchewan vendor's licences 7 digits, BC PST numbers
 * PST-1234-5678.
 */
export function exemptNumberProblem({ province, basis, number } = {}) {
  const v = String(number ?? '').trim();
  if (!v) return null;
  if (basis === 'first-nations' || basis === 'farm') return null; // their evidence is not a tax number
  const digits = v.replace(/\D/g, '');
  if (province === 'MB' && !/^[\d\s-]+$/.test(v)) return 'A Manitoba RST number is 7 digits. Check it against the customer’s certificate.';
  if (province === 'MB' && digits.length !== 7) return `A Manitoba RST number is 7 digits; this has ${digits.length}. Check it against the customer’s certificate.`;
  if (province === 'SK' && digits.length !== 7) return `A Saskatchewan PST vendor’s licence is 7 digits; this has ${digits.length}. Check it.`;
  if (province === 'BC' && !/^(PST-?)?\d{4}-?\d{4}$/i.test(v)) return 'A BC PST number looks like PST-1234-5678. Check it.';
  return null;
}

function combinedRate(taxes) {
  return Math.round(taxes.filter((t) => t.applies.material || t.applies.labour || t.applies.other)
    .reduce((s, t) => s + t.pct, 0) * 1000) / 1000;
}

/**
 * Registration numbers: GST/HST is the 9-digit business number + RT + 4 digits
 * (CRA RC4022, which also requires it on invoices of $100 or more). BC PST numbers
 * look like PST-1234-5678 (gov.bc.ca).
 */
export function isGstHstNumber(v) {
  return /^\d{9}\s?RT\s?\d{4}$/i.test(String(v || '').trim());
}
