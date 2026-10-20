// Importers: turn rows from another system's CSV into Fishtape records. Pure (no DOM, no store
// writes) so the logic is tested in Node; modules/import.js does the UI, chunking and writes.
//
// A target (clients, items, jobs, employees) lists its fields with header aliases. A preset
// (Jobber clients, QuickBooks Online customers / products and services, Housecall Pro
// customers, generic) adds the headers that system's export uses, combined fields (address
// parts, first + last name) and defaults. Formats verified 2026-10-19: see docs/code/imports.md.
import { normUnit } from './wireruns.js';

// ---- value normalisation -----------------------------------------------------------

/**
 * Money text to integer cents: "$1,234.56", "CA$12", "(45.00)" (negative), "1 234,56 $"
 * (French Canadian), "1.234,56", "12.5". Exact (no floating point). { cents, ok }.
 */
export function parseMoneyCents(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? { cents: Math.round(input * 100), ok: true } : { cents: 0, ok: false };
  let s = String(input ?? '').trim();
  if (!s) return { cents: 0, ok: true, empty: true };
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[\s  ]/g, '').replace(/^(CA|US|C)?\$|\$$|CAD|USD/gi, '').replace(/\$/g, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1); }
  if (!/^[\d.,']+$/.test(s) || !/\d/.test(s)) return { cents: 0, ok: false };
  s = s.replace(/'/g, '');
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  let intPart, frac = '';
  if (lastComma > lastDot) {
    // Comma is the decimal mark when 1-2 digits follow it and it's the only comma ("12,5", "1.234,56").
    const after = s.slice(lastComma + 1);
    if (after.length <= 2 && s.indexOf(',') === lastComma) { intPart = s.slice(0, lastComma).replace(/\./g, ''); frac = after; } else { intPart = s.replace(/[.,]/g, ''); }
  } else if (lastDot >= 0) {
    // One dot is the decimal mark ("1,234.56"); several are thousands marks ("1.234.567").
    if (s.indexOf('.') === lastDot) { intPart = s.slice(0, lastDot).replace(/,/g, ''); frac = s.slice(lastDot + 1); } else { intPart = s.replace(/[.,]/g, ''); }
  } else intPart = s.replace(/,/g, '');
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(frac)) return { cents: 0, ok: false };
  const f = (frac + '000').slice(0, 3);
  let cents = Number(intPart || '0') * 100 + Number(f.slice(0, 2));
  if (Number(f[2]) >= 5) cents += 1; // half up on the third decimal
  return { cents: neg ? -cents : cents, ok: Number.isSafeInteger(cents) };
}

/** A plain number ("1,200.5", "3,5", "12 ft" -> 12). null when there is none. */
export function parseNumber(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  const s = String(input ?? '').trim().replace(/[\s ]/g, '');
  if (!s) return null;
  const m = /^-?[\d.,]+/.exec(s);
  if (!m) return null;
  let t = m[0];
  if (/,\d{1,2}$/.test(t) && !t.includes('.')) t = t.replace(',', '.');
  else t = t.replace(/,/g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Price-book units to the tokens the app understands (lib/wireruns.js normUnit): lengths become
 * m, ft, 100ft, 1000ft, 100m, 1000m; counts become ea; plus h, box, roll, stick, pkg, pr, set.
 */
export function normalizeUnit(raw) {
  const u = String(raw ?? '').trim().toLowerCase().replace(/\.$/, '').replace(/^per\s+/, '');
  if (!u) return 'ea';
  if (['each', 'ea', 'e', 'unit', 'units', 'pc', 'pcs', 'piece', 'pieces', 'item', 'items', 'qty', 'count', 'ct', 'no', 'nos'].includes(u)) return 'ea';
  if (['h', 'hr', 'hrs', 'hour', 'hours'].includes(u)) return 'h';
  if (['bx', 'box', 'boxes', 'carton', 'ctn'].includes(u)) return 'box';
  if (['pkg', 'pk', 'pack', 'package', 'packs'].includes(u)) return 'pkg';
  if (['pr', 'pair', 'pairs'].includes(u)) return 'pr';
  if (['set', 'sets', 'kit'].includes(u)) return 'set';
  if (['lot', 'ls', 'lump sum', 'job'].includes(u)) return 'lot';
  if (['meter', 'meters', 'metre', 'metres', 'mtr', 'mtrs', 'lin m', 'lm', 'm'].includes(u)) return 'm';
  if (['foot', 'feet', 'ft', 'lf', 'lin ft', 'linear ft', 'linear feet', "'"].includes(u)) return 'ft';
  const n = normUnit(u);
  if (['m', 'ft', '100ft', '1000ft', '100m', '1000m', 'roll', 'stick'].includes(n)) return n;
  return u.slice(0, 20);
}

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i;
export const normEmail = (s) => String(s ?? '').trim().toLowerCase().replace(/^mailto:/, '');
export const isEmail = (s) => EMAIL_RE.test(normEmail(s));
/** Last 10 digits of a phone number, for matching ("+1 (306) 555-0142" -> "3065550142"). */
export const phoneKey = (s) => String(s ?? '').replace(/\D/g, '').slice(-10);
/** Names compared loosely: case, accents, punctuation and extra spaces ignored. */
export const nameKey = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
export const skuKey = (s) => String(s ?? '').trim().toUpperCase().replace(/\s+/g, '');

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
function validDay(y, m, d) {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= last ? `${y}-${pad(m)}-${pad(d)}` : null;
}

/**
 * A date in a CSV to YYYY-MM-DD. Takes ISO, a/b/yyyy (order from `order`: 'mdy' or 'dmy'),
 * "Oct 19, 2026", "19-Oct-2026", "2026/10/19" and Excel serial numbers. null when unreadable.
 */
export function parseDate(input, { order = 'mdy' } = {}) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) return validDay(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:\s.*)?$/.exec(s);
  if (m) {
    let y = +m[3]; if (y < 100) y += y < 70 ? 2000 : 1900;
    const [a, b] = [+m[1], +m[2]];
    if (a > 12) return validDay(y, b, a);
    if (b > 12) return validDay(y, a, b);
    return order === 'dmy' ? validDay(y, b, a) : validDay(y, a, b);
  }
  m = /^([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/i.exec(s);
  const mon = (w) => MONTHS[w.slice(0, 4).toLowerCase()] ?? MONTHS[w.slice(0, 3).toLowerCase()];
  if (m && mon(m[1])) return validDay(+m[3], mon(m[1]), +m[2]);
  m = /^(\d{1,2})[-\s]([a-z]{3,9})\.?[-\s,]+(\d{2}|\d{4})$/i.exec(s);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) { let y = +m[3]; if (y < 100) y += 2000; return validDay(y, MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]); }
  if (/^\d{5}(\.\d+)?$/.test(s)) { const d = new Date(Math.round((Number(s) - 25569) * 86400000)); return validDay(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); }
  return null;
}

/** Which date order a column uses: 'dmy' if any first part is over 12, 'mdy' if any second is, else null. */
export function detectDateOrder(values) {
  for (const v of values) {
    const m = /^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/.exec(String(v ?? '').trim());
    if (!m) continue;
    if (+m[1] > 12) return 'dmy';
    if (+m[2] > 12) return 'mdy';
  }
  return null;
}

const TRUE = new Set(['true', 'yes', 'y', '1', 'active', 'x', 'oui']);
const FALSE = new Set(['false', 'no', 'n', '0', 'inactive', 'archived', 'disabled', 'non']);
export function parseBool(s) {
  const v = String(s ?? '').trim().toLowerCase();
  if (TRUE.has(v)) return true;
  if (FALSE.has(v)) return false;
  return null;
}

/** Map a role written any way to an employees role. */
export function normalizeRole(s) {
  const v = String(s ?? '').trim().toLowerCase();
  if (!v) return 'electrician';
  if (/owner|president|principal/.test(v)) return 'owner';
  if (/admin|manager/.test(v)) return 'admin';
  if (/office|dispatch|reception|book|account|estimator|sales/.test(v)) return 'office';
  if (/foreman|forem|lead|supervisor|super/.test(v)) return 'foreman';
  if (/apprentice|helper|labou?rer|\bapp\b|1st|2nd|3rd|4th|year/.test(v)) return 'apprentice';
  return 'electrician';
}

/** Job status from another system's words. */
export function normalizeJobStatus(s) {
  const v = String(s ?? '').trim().toLowerCase();
  if (!v) return 'scheduled';
  if (/invoic|billed/.test(v) && !/requires|to be|needs/.test(v)) return 'invoiced';
  if (/complete|done|closed|finished|archiv|requires invoic|to be invoic|needs invoic/.test(v)) return 'complete';
  if (/hold|paus|wait/.test(v)) return 'on-hold';
  if (/progress|active|started|late|underway|open|dispatch|en route/.test(v)) return 'in-progress';
  if (/lead|quote|estimate|request|draft/.test(v)) return 'lead';
  return 'scheduled';
}

/** Client type from words like "Commercial" or a company name being present. */
export function normalizeClientType(s, { company } = {}) {
  const v = String(s ?? '').trim().toLowerCase();
  const b = parseBool(v); // Jobber's "Is Company?" TRUE/FALSE
  if (b === true) return 'commercial';
  if (b === false && !company) return 'residential';
  if (/indus|plant|factory|manufact/.test(v)) return 'industrial';
  if (/comm|business|company|corp|gc|contractor|property manag/.test(v)) return 'commercial';
  if (/resid|home|house|private|individual/.test(v)) return 'residential';
  return company ? 'commercial' : 'residential';
}

// ---- targets -----------------------------------------------------------------------

/** Header text compared loosely: "Sales Price / Rate" -> "salespricerate". */
export const headerKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Fields per target. type: text | money | number | date | email | phone | bool | tags | unit | role | status | clientType.
 * aliases are matched with headerKey (exact first, then "contains").
 */
export const TARGETS = {
  clients: {
    label: 'Clients', collection: 'clients', perm: 'clients',
    fields: [
      { key: 'name', label: 'Name', required: true, type: 'text', max: 200, aliases: ['name', 'client name', 'customer name', 'customer', 'display name', 'full name', 'client', 'contact name'] },
      { key: 'company', label: 'Company', type: 'text', max: 200, aliases: ['company', 'company name', 'business name', 'organization'] },
      { key: 'firstName', label: 'First name', type: 'text', aliases: ['first name', 'given name', 'firstname'] },
      { key: 'lastName', label: 'Last name', type: 'text', aliases: ['last name', 'surname', 'family name', 'lastname'] },
      { key: 'email', label: 'Email', type: 'email', aliases: ['email', 'e-mail', 'email address', 'primary email', 'main email', 'emails'] },
      { key: 'phone', label: 'Phone', type: 'phone', aliases: ['phone', 'phone number', 'primary phone', 'main phone', 'mobile', 'mobile number', 'cell', 'mobile phone', 'home number', 'work number', 'phone numbers'] },
      { key: 'address', label: 'Address', type: 'text', max: 500, aliases: ['address', 'billing address', 'service address', 'property address', 'full address'] },
      { key: 'street', label: 'Street', type: 'text', aliases: ['street', 'street address', 'address line 1', 'billing street', 'street 1', 'address 1', 'billing address street', 'street1'] },
      { key: 'street2', label: 'Street line 2', type: 'text', aliases: ['street 2', 'address line 2', 'address 2', 'unit', 'suite', 'street2'] },
      { key: 'city', label: 'City', type: 'text', aliases: ['city', 'town', 'billing city', 'billing address city'] },
      { key: 'province', label: 'Province', type: 'text', aliases: ['province', 'state', 'province state', 'state province', 'region', 'billing province', 'billing state', 'billing address state'] },
      { key: 'postal', label: 'Postal code', type: 'text', aliases: ['postal code', 'zip', 'zip code', 'postcode', 'postal', 'billing zip', 'billing postal code', 'billing address postal code'] },
      { key: 'type', label: 'Type', type: 'clientType', aliases: ['type', 'client type', 'customer type', 'property type'] },
      { key: 'tags', label: 'Tags', type: 'tags', aliases: ['tags', 'labels', 'groups', 'tag'] },
      { key: 'notes', label: 'Notes', type: 'text', max: 20000, aliases: ['notes', 'note', 'comments', 'description', 'memo'] },
    ],
  },
  items: {
    label: 'Price book', collection: 'items', perm: 'inventory',
    fields: [
      { key: 'name', label: 'Name', required: true, type: 'text', max: 300, aliases: ['name', 'item name', 'product service name', 'product service', 'product', 'item', 'description', 'service name'] },
      { key: 'sku', label: 'SKU', type: 'text', max: 80, aliases: ['sku', 'part number', 'part no', 'item code', 'code', 'catalog number', 'cat no', 'mfr part', 'product code', 'upc'] },
      { key: 'description', label: 'Description', type: 'text', max: 2000, aliases: ['sales description', 'long description', 'details'] },
      { key: 'category', label: 'Category', type: 'text', max: 100, aliases: ['category', 'group', 'type', 'class', 'department'] },
      { key: 'unit', label: 'Unit', type: 'unit', aliases: ['unit', 'uom', 'unit of measure', 'units', 'per'] },
      { key: 'costCents', label: 'Cost', type: 'money', aliases: ['cost', 'purchase cost', 'unit cost', 'your cost', 'net', 'net price', 'cost price'] },
      { key: 'priceCents', label: 'Sell price', type: 'money', aliases: ['price', 'sales price rate', 'sales price', 'sell price', 'rate', 'unit price', 'list price', 'retail'] },
      { key: 'labourHours', label: 'Labour hours', type: 'number', aliases: ['labour hours', 'labor hours', 'labour', 'labor', 'hours', 'install hours', 'labor units'] },
      { key: 'reorderPoint', label: 'Reorder point', type: 'number', aliases: ['reorder point', 'reorder', 'min qty', 'minimum'] },
      { key: 'qtyOnHand', label: 'Quantity on hand', type: 'number', aliases: ['quantity on hand', 'qty on hand', 'on hand', 'stock', 'qty'] },
    ],
  },
  jobs: {
    label: 'Jobs', collection: 'jobs', perm: 'jobs',
    fields: [
      { key: 'title', label: 'Title', required: true, type: 'text', max: 300, aliases: ['title', 'job title', 'job name', 'name', 'description', 'job description', 'service'] },
      { key: 'number', label: 'Job number', type: 'text', max: 40, aliases: ['job number', 'job no', 'job', 'number', 'job id'] },
      { key: 'client', label: 'Client name', type: 'text', aliases: ['client', 'client name', 'customer', 'customer name'] },
      { key: 'clientEmail', label: 'Client email', type: 'email', aliases: ['client email', 'customer email', 'email'] },
      { key: 'address', label: 'Site address', type: 'text', max: 500, aliases: ['address', 'site address', 'service address', 'property address', 'job address', 'location'] },
      { key: 'status', label: 'Status', type: 'status', aliases: ['status', 'job status', 'state', 'stage'] },
      { key: 'startDate', label: 'Start date', type: 'date', aliases: ['start date', 'start', 'scheduled', 'scheduled date', 'date', 'start at'] },
      { key: 'endDate', label: 'End date', type: 'date', aliases: ['end date', 'end', 'completed', 'completion date', 'due date', 'end at'] },
      { key: 'description', label: 'Scope / notes', type: 'text', max: 20000, aliases: ['scope', 'notes', 'instructions', 'details'] },
    ],
  },
  employees: {
    label: 'Employees', collection: 'employees', perm: 'employees',
    fields: [
      { key: 'name', label: 'Full name', required: true, type: 'text', max: 200, aliases: ['name', 'full name', 'employee', 'employee name'] },
      { key: 'firstName', label: 'First name', type: 'text', aliases: ['first name', 'given name'] },
      { key: 'lastName', label: 'Last name', type: 'text', aliases: ['last name', 'surname'] },
      { key: 'role', label: 'Role', type: 'role', aliases: ['role', 'title', 'position', 'job title', 'trade'] },
      { key: 'email', label: 'Email', type: 'email', aliases: ['email', 'e-mail', 'work email'] },
      { key: 'phone', label: 'Phone', type: 'phone', aliases: ['phone', 'mobile', 'cell', 'phone number'] },
      { key: 'licenceNo', label: 'Licence no.', type: 'text', max: 60, aliases: ['licence', 'license', 'licence number', 'license number', 'licence no', 'license no', 'certificate', 'ticket'] },
      { key: 'licenceExpiry', label: 'Licence expiry', type: 'date', aliases: ['licence expiry', 'license expiry', 'expiry', 'expiration', 'license expiration', 'expires'] },
      { key: 'rateCents', label: 'Hourly rate (cost)', type: 'money', aliases: ['rate', 'hourly rate', 'wage', 'pay rate', 'cost rate'] },
      { key: 'active', label: 'Active', type: 'bool', aliases: ['active', 'status', 'enabled'] },
    ],
  },
};

// ---- presets -------------------------------------------------------------------------

/**
 * Exports from other systems. `headers` are that export's own column names, mapped to fields
 * (several names per field where versions differ). `signature` headers identify the file.
 * Each preset was checked against the vendor's help page on the date in `verified`.
 */
export const PRESETS = [
  {
    id: 'generic-clients', target: 'clients', label: 'Clients (any spreadsheet)', source: 'Generic', headers: {}, signature: [],
  },
  {
    // Jobber: Clients > More Actions > Export Clients (CSV by email). Jobber publishes only some export
    // columns (J-ID, Is Company?, Archived, Tags...); the rest follow its import headers (help articles
    // 360045644734 and 360034980534, updated 2026-08-06).
    id: 'jobber-clients', target: 'clients', label: 'Jobber clients export', source: 'Jobber', verified: '2026-10-19',
    signature: ['J-ID', 'Is Company?', 'Archived', 'Billing Street', 'Main Phone'],
    headers: {
      name: ['Display Name', 'Full Name', 'Name', 'Client Name'], company: ['Company Name', 'Company', 'Organization Name'], firstName: ['First Name', 'Given Name'], lastName: ['Last Name', 'Family Name'],
      email: ['Email', 'E-mails', 'Emails'], phone: ['Main Phone', 'Mobile Phone', 'Home Phone', 'Work Phone', 'Other Phone', 'Main Phone #s', 'Mobile Phone #s'],
      street: ['Billing Street', 'Billing Street 1', 'Street', 'Address'], street2: ['Billing Street 2'], city: ['Billing City', 'City'],
      province: ['Billing Province', 'Billing State', 'Province', 'State'], postal: ['Billing Postal Code', 'Billing Zip', 'Billing Zip code', 'Postal Code', 'Zip Code'],
      tags: ['Tags'], notes: ['Note', 'Notes'], type: ['Is Company?'],
    },
    typeFrom: 'company',
  },
  {
    // QuickBooks Online: Sales > Customers > Export, or the Customer Contact List report. Intuit doesn't
    // publish the export headers; these are the report's column names (several sources, 2025-2026).
    id: 'qbo-customers', target: 'clients', label: 'QuickBooks Online customers', source: 'QuickBooks Online', verified: '2026-10-19',
    signature: ['Customer', 'Full Name', 'Billing Address', 'Phone Numbers', 'Customer Type', 'Billing Street'],
    headers: {
      name: ['Customer', 'Name', 'Full Name', 'Display Name As', 'Customer full name'], company: ['Company Name', 'Company'],
      firstName: ['First Name'], lastName: ['Last Name'],
      email: ['Email', 'Email Address'], phone: ['Phone Numbers', 'Phone', 'Phone number', 'Mobile'],
      address: ['Billing Address', 'Address'], street: ['Billing Street', 'Street'],
      city: ['Billing City', 'City'], province: ['Billing State', 'Province/Territory', 'Province/State', 'Province'], postal: ['Billing Zip', 'Postal Code', 'ZIP'],
      type: ['Customer Type', 'Customer type'], notes: ['Notes', 'Note'],
    },
    typeFrom: 'company',
  },
  {
    // Housecall Pro: Customers > Actions > Export (columns follow the list view); field names from its
    // import wizard (help article 6584603, 2026-01-23).
    id: 'hcp-customers', target: 'clients', label: 'Housecall Pro customers', source: 'Housecall Pro', verified: '2026-10-19',
    signature: ['Display name', 'Mobile number', 'Home number', 'Work number', 'Service address', 'Customer notes'],
    headers: {
      name: ['Display name', 'Display Name'], company: ['Company'], firstName: ['First name'], lastName: ['Last name'],
      email: ['Emails', 'Email'], phone: ['Mobile number', 'Home number', 'Work number', 'Additional phone numbers', 'Phone'],
      address: ['Service address', 'Billing address', 'Address'], street: ['Street'], city: ['City'], province: ['State', 'Province'], postal: ['Zip', 'Postal code'],
      tags: ['Tags'], notes: ['Customer notes', 'Notes'], type: ['Type'],
    },
    typeFrom: 'company',
  },
  { id: 'generic-items', target: 'items', label: 'Price book (any spreadsheet)', source: 'Generic', headers: {}, signature: [] },
  {
    id: 'qbo-products', target: 'items', label: 'QuickBooks Online products and services', source: 'QuickBooks Online', verified: '2026-10-19',
    // Import template columns (Intuit help L4o3mXx2u, updated 2026-05-26); the list export uses
    // shorter names (Product/Service, Description, Price, Cost, Qty On Hand), also matched.
    signature: ['Product/Service Name', 'Product/Service', 'Sales Price / Rate', 'Income Account', 'Purchase Cost', 'Expense Account', 'Qty On Hand'],
    headers: {
      name: ['Product/Service Name', 'Product/Service', 'Name'], sku: ['SKU'], description: ['Sales Description', 'Description'],
      category: ['Category', 'Type'], costCents: ['Purchase Cost', 'Cost'], priceCents: ['Sales Price / Rate', 'Sales Price/Rate', 'Price', 'Rate'],
      qtyOnHand: ['Quantity On Hand', 'Qty On Hand', 'Quantity on hand'], reorderPoint: ['Reorder Point', 'Reorder point'],
      unit: ['Unit', 'UOM'],
    },
  },
  { id: 'generic-jobs', target: 'jobs', label: 'Jobs (any spreadsheet)', source: 'Generic', headers: {}, signature: [] },
  { id: 'generic-employees', target: 'employees', label: 'Employees (any spreadsheet)', source: 'Generic', headers: {}, signature: [] },
];

export const presetById = (id) => PRESETS.find((p) => p.id === id) || null;
export const presetsFor = (target) => PRESETS.filter((p) => p.target === target);

/** The preset whose signature best matches these headers, for a target (or any). */
export function detectPreset(headers, target = null) {
  const keys = new Set(headers.map(headerKey));
  let best = null, bestScore = 0;
  for (const p of PRESETS) {
    if (target && p.target !== target) continue;
    if (!p.signature.length) continue;
    const score = p.signature.filter((s) => keys.has(headerKey(s))).length / p.signature.length;
    if (score > bestScore) { best = p; bestScore = score; }
  }
  if (best && bestScore >= 0.5) return best;
  return target ? presetsFor(target).find((p) => !p.signature.length) || null : null;
}

/**
 * Column for each field: { [fieldKey]: headerIndex | -1 }. Preset header names first, then the
 * field's aliases (exact match, then a header that contains the alias). A column is used once.
 */
export function autoMap(headers, targetId, presetId = null) {
  const target = TARGETS[targetId];
  const preset = presetById(presetId);
  const keys = headers.map(headerKey);
  const used = new Set();
  const map = {};
  const take = (i) => { used.add(i); return i; };
  for (const f of target.fields) {
    let idx = -1;
    for (const name of preset?.headers?.[f.key] || []) {
      const i = keys.indexOf(headerKey(name));
      if (i >= 0 && !used.has(i)) { idx = take(i); break; }
    }
    if (idx < 0 && !preset?.headers?.[f.key]?.length) {
      for (const a of f.aliases) { const i = keys.indexOf(headerKey(a)); if (i >= 0 && !used.has(i)) { idx = take(i); break; } }
    }
    map[f.key] = idx;
  }
  // Second pass: "contains" matches for fields still unmapped (e.g. "Customer Email Address").
  for (const f of target.fields) {
    if (map[f.key] >= 0) continue;
    for (const a of f.aliases) {
      const ak = headerKey(a);
      if (ak.length < 4) continue;
      const i = keys.findIndex((k, j) => !used.has(j) && k.includes(ak));
      if (i >= 0) { map[f.key] = take(i); break; }
    }
  }
  // A full name or display name makes split first/last names redundant, and vice versa.
  return map;
}

// ---- rows to records -----------------------------------------------------------------

const clip = (s, n) => (n ? String(s).slice(0, n) : String(s));
const PROV = /^(AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)$/i;

/**
 * One file row to a record for the target.
 * @returns {{ record: object|null, errors: string[], warnings: string[], extra: object }}
 *   extra carries values that are not record fields (client name for jobs, quantity on hand).
 */
export function normalizeRow(row, map, targetId, { dateOrder = 'mdy', presetId = null } = {}) {
  const target = TARGETS[targetId];
  const preset = presetById(presetId);
  const errors = [], warnings = [];
  const raw = {};
  for (const f of target.fields) {
    const i = map[f.key];
    let v = i >= 0 ? String(row[i] ?? '').trim() : '';
    // Presets can list several columns for one field (Jobber's phone columns): take the first non-empty.
    if (!v && preset?.headers?.[f.key] && map.__alts?.[f.key]) for (const j of map.__alts[f.key]) { v = String(row[j] ?? '').trim(); if (v) break; }
    raw[f.key] = v;
  }
  const out = {};
  const extra = {};
  for (const f of target.fields) {
    const v = raw[f.key];
    if (!v) continue;
    switch (f.type) {
      case 'money': {
        const m = parseMoneyCents(v);
        if (!m.ok) errors.push(`${f.label} "${v.slice(0, 30)}" is not an amount`);
        else out[f.key] = m.cents;
        break;
      }
      case 'number': {
        const n = parseNumber(v);
        if (n == null) errors.push(`${f.label} "${v.slice(0, 30)}" is not a number`); else out[f.key] = n;
        break;
      }
      case 'date': {
        const d = parseDate(v, { order: dateOrder });
        if (!d) errors.push(`${f.label} "${v.slice(0, 30)}" is not a date`); else out[f.key] = d;
        break;
      }
      case 'email': {
        // Some exports list several addresses in one cell; keep the first valid one.
        const first = v.split(/[;,\s]+/).find((x) => isEmail(x));
        if (first) out[f.key] = normEmail(first);
        else errors.push(`Email "${v.slice(0, 40)}" doesn't look right`);
        break;
      }
      case 'phone': {
        const first = v.split(/[;,/]|\s{2,}/).map((x) => x.replace(/^[a-z ]+:\s*/i, '').trim()).find((x) => x.replace(/\D/g, '').length >= 7);
        if (first) out[f.key] = first.slice(0, 40);
        else warnings.push(`Phone "${v.slice(0, 30)}" has too few digits; left out`);
        break;
      }
      case 'bool': { const b = parseBool(v); if (b == null) warnings.push(`${f.label} "${v}" read as yes`); out[f.key] = b ?? true; break; }
      case 'tags': out[f.key] = v.split(/[,;|]/).map((t) => t.trim().slice(0, 60)).filter(Boolean).slice(0, 50); break;
      case 'unit': out[f.key] = normalizeUnit(v); break;
      case 'role': out[f.key] = normalizeRole(v); break;
      case 'status': out[f.key] = normalizeJobStatus(v); break;
      case 'clientType': out[f.key] = normalizeClientType(v); break;
      default: out[f.key] = clip(v, f.max);
    }
  }

  let record;
  if (targetId === 'clients') {
    const person = [out.firstName, out.lastName].filter(Boolean).join(' ');
    const name = out.name || out.company || person;
    const lines = out.address ? [out.address] : [];
    if (!out.address) {
      const street = [out.street, out.street2].filter(Boolean).join(' ');
      const prov = out.province ? (PROV.test(out.province) ? out.province.toUpperCase() : out.province) : '';
      const cityLine = [out.city, [prov, out.postal ? out.postal.toUpperCase() : ''].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      if (street) lines.push(street);
      if (cityLine) lines.push(cityLine);
    }
    const notes = [out.notes, out.company && out.name && nameKey(out.company) !== nameKey(out.name) ? `Company: ${out.company}` : null, person && name !== person && out.name ? `Contact: ${person}` : null].filter(Boolean).join('\n');
    record = {
      name: clip(name || '', 200), type: out.type || normalizeClientType('', { company: preset?.typeFrom === 'company' ? out.company : null }),
      email: out.email || '', phone: out.phone || '', address: clip(lines.join(', '), 500), notes: clip(notes, 20000), tags: out.tags || [],
    };
    if (!record.name) errors.push('No name (or company) for this client');
  } else if (targetId === 'items') {
    record = {
      sku: out.sku || '', name: out.name || out.description || '', category: out.category || '', unit: out.unit || 'ea',
      costCents: out.costCents ?? 0, priceCents: out.priceCents ?? 0, labourHours: out.labourHours ?? 0, reorderPoint: out.reorderPoint ?? 0,
      stock: {}, symbol: null,
    };
    if (out.description && out.description !== record.name) record.description = out.description;
    if (out.qtyOnHand != null) extra.qtyOnHand = out.qtyOnHand;
    if (!record.name) errors.push('No name for this item');
    if (record.costCents < 0 || record.priceCents < 0) errors.push('Negative cost or price');
    if (!out.priceCents && out.costCents) warnings.push('No sell price; set one before quoting');
  } else if (targetId === 'jobs') {
    record = {
      title: out.title || '', address: out.address || '', status: out.status || 'scheduled', startDate: out.startDate || '', endDate: out.endDate || '',
      crewIds: [], estimateId: null, description: out.description || '', changeOrders: [], clientId: null,
    };
    if (out.number) record.number = out.number;
    extra.client = out.client || '';
    extra.clientEmail = out.clientEmail || '';
    if (!record.title) errors.push('No title for this job');
    if (record.startDate && record.endDate && record.endDate < record.startDate) warnings.push('End date is before the start date');
  } else if (targetId === 'employees') {
    const name = out.name || [out.firstName, out.lastName].filter(Boolean).join(' ');
    record = {
      name: clip(name, 200), role: out.role || 'electrician', email: out.email || '', phone: out.phone || '', licenceNo: out.licenceNo || '',
      licenceExpiry: out.licenceExpiry || '', rateCents: out.rateCents ?? 0, active: out.active ?? true,
    };
    if (!record.name) errors.push('No name for this person');
    if (record.role === 'owner' || record.role === 'admin') warnings.push(`Role ${record.role}: employee records don't grant access; members do (Account)`);
  }
  return { record: errors.length ? null : record, errors, warnings, extra };
}

/** Extra columns a preset lists for one field (all of Jobber's phone columns), as indexes. */
export function altColumns(headers, presetId) {
  const preset = presetById(presetId);
  const keys = headers.map(headerKey);
  const alts = {};
  for (const [field, names] of Object.entries(preset?.headers || {})) {
    const idx = names.map((n) => keys.indexOf(headerKey(n))).filter((i) => i >= 0);
    if (idx.length > 1) alts[field] = idx;
  }
  return alts;
}

// ---- duplicates ----------------------------------------------------------------------

/**
 * Keys a record is matched on. Clients: email, phone, then name. Items: SKU, else name.
 * Jobs: number, else title + client. Employees: email, else name.
 */
export function matchKeys(targetId, r, extra = {}) {
  const k = [];
  if (targetId === 'clients') {
    if (r.email) k.push(`e:${normEmail(r.email)}`);
    if (phoneKey(r.phone).length >= 7) k.push(`p:${phoneKey(r.phone)}`);
    if (r.name) k.push(`n:${nameKey(r.name)}`);
  } else if (targetId === 'items') {
    if (r.sku) k.push(`s:${skuKey(r.sku)}`); else if (r.name) k.push(`n:${nameKey(r.name)}`);
  } else if (targetId === 'jobs') {
    if (r.number) k.push(`#:${skuKey(r.number)}`);
    else if (r.title) k.push(`t:${nameKey(r.title)}|${r.clientId || nameKey(extra.client)}`);
  } else if (targetId === 'employees') {
    if (r.email) k.push(`e:${normEmail(r.email)}`);
    if (r.name) k.push(`n:${nameKey(r.name)}`);
  }
  return k;
}

/** An index of existing records by match key: Map key -> id. */
export function buildIndex(targetId, records) {
  const idx = new Map();
  for (const r of records) for (const k of matchKeys(targetId, r)) if (!idx.has(k)) idx.set(k, r.id);
  return idx;
}

/** Fields an "update existing" import may fill in: only values the file has, never ids or stock. */
export function mergePatch(targetId, existing, incoming) {
  const patch = {};
  const skip = new Set(['id', 'stock', 'symbol', 'crewIds', 'changeOrders', 'estimateId', 'tags', 'clientId']);
  for (const [k, v] of Object.entries(incoming)) {
    if (skip.has(k)) continue;
    if (v === '' || v == null) continue;
    if (typeof v === 'number' && v === 0 && (targetId === 'items' ? ['labourHours', 'reorderPoint'].includes(k) : false)) continue;
    if (JSON.stringify(existing[k]) !== JSON.stringify(v)) patch[k] = v;
  }
  if (incoming.tags?.length) {
    const tags = [...new Set([...(existing.tags || []), ...incoming.tags])].slice(0, 50);
    if (tags.length !== (existing.tags || []).length) patch.tags = tags;
  }
  return patch;
}

/**
 * Plan an import: validate every row, find duplicates (in the file and against existing
 * records) and decide create / update / skip. Pure and synchronous for one slice of rows;
 * modules/import.js runs it in chunks. `state` carries the index across chunks.
 * @returns {{ items: Array<{ line, action: 'create'|'update'|'skip'|'error', record, id?, patch?, errors, warnings, extra }> }}
 */
export function planRows(rows, { targetId, map, dateOrder, presetId, mode = 'skip', state, startLine = 2 }) {
  const items = [];
  rows.forEach((row, i) => {
    const line = startLine + i;
    const r = normalizeRow(row, map, targetId, { dateOrder, presetId });
    if (!r.record) { items.push({ line, action: 'error', record: null, errors: r.errors, warnings: r.warnings, extra: r.extra }); return; }
    const keys = matchKeys(targetId, r.record, r.extra);
    const inFile = keys.find((k) => state.fileKeys.has(k));
    if (inFile) {
      items.push({ line, action: 'skip', record: r.record, errors: [], warnings: [...r.warnings, `Same as row ${state.fileKeys.get(inFile)} in this file`], extra: r.extra });
      return;
    }
    for (const k of keys) state.fileKeys.set(k, line);
    const hit = keys.map((k) => state.existing.get(k)).find(Boolean);
    if (hit) {
      if (mode === 'update') items.push({ line, action: 'update', id: hit, record: r.record, errors: [], warnings: r.warnings, extra: r.extra });
      else items.push({ line, action: 'skip', id: hit, record: r.record, errors: [], warnings: [...r.warnings, 'Already in Fishtape'], extra: r.extra });
      return;
    }
    items.push({ line, action: 'create', record: r.record, errors: [], warnings: r.warnings, extra: r.extra });
  });
  return { items };
}

export const newPlanState = (targetId, existingRecords) => ({ fileKeys: new Map(), existing: buildIndex(targetId, existingRecords) });

/** Counts of a plan by action. */
export function planSummary(items) {
  const s = { create: 0, update: 0, skip: 0, error: 0, warnings: 0 };
  for (const it of items) { s[it.action]++; if (it.warnings.length) s.warnings++; }
  return s;
}

/** Header row and an example row for a target's template CSV. */
export function templateRows(targetId) {
  const ex = {
    clients: ['Harbour Dental Clinic', '', '', '', 'ops@harbourdental.example', '306-555-0142', '', '42 Harbour St', '', 'Regina', 'SK', 'S4P 3Y2', 'commercial', 'repeat', 'Gate code 1234'],
    items: ['Duplex receptacle 15A TR', 'DEV-REC-15', '', 'Devices', 'ea', '2.45', '12.00', '0.45', '40', ''],
    jobs: ['Panel upgrade 100A to 200A', '', 'Linden Residence', 'home@example.com', '9 Linden Ct, Regina, SK', 'scheduled', '2026-11-03', '2026-11-04', 'Permit applied'],
    employees: ['Sam Rivera', '', '', 'Foreman', 'sam@example.com', '306-555-0199', 'ME-12345', '2027-03-31', '52.00', 'yes'],
  }[targetId];
  return [TARGETS[targetId].fields.map((f) => f.label), ex];
}
