// Accounting exports: CSV files QuickBooks Online (Canada) imports, plus a plain CSV for any
// other bookkeeping tool. Pure: takes records, returns rows; modules/import.js downloads them.
//
// Formats checked 2026-10-19 against Intuit's help (details and links in docs/code/imports.md):
//  - Customers: Settings > Import data > Customers. Fields Name, Company, Email, Phone, Mobile, Fax,
//    Website, Street, City, Province/Territory, Postal Code, Country, Opening Balance, Opening
//    Balance Date, Account Number, Business Number, Resale Number. Name required (max 100, unique,
//    no : or "). 1,000 rows or 2 MB per file. (L0fwkOCms_CA_en_CA, "updated 2 months ago")
//  - Invoices: Settings > Import data > Invoices. CSV only, 100 invoices and 1,000 rows per file,
//    one row per line with the invoice number repeated, no negative lines. Canada requires Invoice
//    number, Customer, Invoice date, Due date, Item amount and Item tax code; tax codes are matched
//    to the company's codes in the wizard, and amounts are marked Exclusive. The date format is
//    picked in the wizard. (L7E9Xrd8l_CA_en_CA, "updated 2 weeks ago"; sample headers from Intuit's
//    invoice import sample.) VERIFY the tax code names against the company's own list.
//  - Payments: QuickBooks Online has no native import for received payments. The file follows
//    SaasAnt's "Received Payments" template (support.saasant.com 14000052968, 2025-08-20); without
//    an add-on, record them with + New > Receive payment using the file as the list.
import { docTotals, docTaxes, lineCents, KINDS } from './money.js';

export const QBO_LIMITS = { customerRows: 1000, invoiceRows: 1000, invoicesPerFile: 100 };

/**
 * Default QBO Canada sales tax code names for a set of taxes charged on a line. These are the
 * names QuickBooks' automated sales tax creates; a company can rename them, so the export screen
 * lets them be changed. Keys: sorted tax ids plus province, e.g. 'HST|ON', 'GST+PST|BC'.
 */
export const DEFAULT_TAX_CODES = {
  'HST|ON': 'HST ON', 'HST|NS': 'HST NS', 'HST|NB': 'HST NB', 'HST|NL': 'HST NL', 'HST|PE': 'HST PE',
  'GST+PST|BC': 'GST/PST BC', 'GST+PST|SK': 'GST/PST SK', 'GST+RST|MB': 'GST/PST MB', 'GST+QST|QC': 'GST/QST QC',
  GST: 'GST', NONE: 'Exempt',
};

/** The taxes that apply to one line kind on a document: ['GST', 'PST'] (sorted). */
export function lineTaxIds(doc, kind) {
  // Same rule as docTotals (money.js): no `applies` means every line kind.
  return docTaxes(doc).filter((t) => (Number(t.pct) || 0) > 0 && Boolean((t.applies || { material: true, labour: true, other: true })[kind]))
    .map((t) => String(t.id).toUpperCase()).sort();
}

/** The key DEFAULT_TAX_CODES (and the user's own table) is looked up with. */
export function taxKey(ids, province) {
  if (!ids.length) return 'NONE';
  if (ids.length === 1 && ids[0] === 'GST') return 'GST';
  if (ids.length === 1 && ids[0] === 'TAX') return 'TAX';
  return `${ids.join('+')}|${province || ''}`;
}

/** The QBO tax code name for a line: the user's table first, then the defaults, else a readable guess. */
export function taxCodeFor(doc, kind, codes = {}) {
  const ids = lineTaxIds(doc, kind);
  const key = taxKey(ids, doc.taxProvince);
  if (codes[key]) return codes[key];
  if (DEFAULT_TAX_CODES[key]) return DEFAULT_TAX_CODES[key];
  if (ids.length === 1 && ids[0] === 'HST' && doc.taxProvince) return `HST ${doc.taxProvince}`;
  if (key === 'TAX') return `Tax ${docTaxes(doc)[0]?.pct ?? ''}%`.trim();
  return ids.join('/') + (doc.taxProvince ? ` ${doc.taxProvince}` : '');
}

/** Every tax situation in a set of invoices (for the code table on the export screen). */
export function taxKeysUsed(invoices) {
  const out = new Map();
  for (const inv of invoices) {
    for (const kind of KINDS) {
      if (!(inv.lines || []).some((l) => (l.kind || 'material') === kind) && !(kind === 'material' && Number(inv.markupPct))) continue;
      const ids = lineTaxIds(inv, kind);
      const key = taxKey(ids, inv.taxProvince);
      if (!out.has(key)) out.set(key, { key, ids, province: inv.taxProvince || null, example: inv.number, default: taxCodeFor(inv, kind, {}) });
    }
  }
  return [...out.values()];
}

/** A QBO display name: no tabs, line breaks, colons or double quotes; at most 100 characters. */
export const qboName = (s) => String(s ?? '').replace(/[\t\r\n]+/g, ' ').replace(/[:"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);

/**
 * Display names per client, unique (QBO matches invoices to customers by name and refuses
 * duplicates across customers, suppliers and employees): a repeated name gets " (2)".
 */
export function customerNames(clients) {
  const used = new Map();
  const out = new Map();
  const sorted = [...clients].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)));
  for (const c of sorted) {
    const base = qboName(c.name) || `Customer ${String(c.id).slice(0, 8)}`;
    let name = base, n = used.get(base.toLowerCase()) || 0;
    while (n && used.has(name.toLowerCase())) { n++; name = `${base.slice(0, 94)} (${n})`; }
    used.set(base.toLowerCase(), Math.max(n, 1));
    used.set(name.toLowerCase(), 1);
    out.set(c.id, name);
  }
  return out;
}

const POSTAL = /\b([ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z])\s?(\d[ABCEGHJ-NPRSTV-Z]\d)\b/i;
const PROVINCES = /\b(AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)\b/;

/** "42 Harbour St, Regina, SK S4P 3Y2" -> { street, city, province, postal }. Best effort. */
export function splitAddress(address) {
  let s = String(address ?? '').replace(/\s*\n\s*/g, ', ').trim();
  const out = { street: '', city: '', province: '', postal: '', country: '' };
  if (!s) return out;
  const pc = POSTAL.exec(s);
  if (pc) { out.postal = `${pc[1]} ${pc[2]}`.toUpperCase(); s = (s.slice(0, pc.index) + s.slice(pc.index + pc[0].length)).trim(); }
  s = s.replace(/,?\s*(Canada|CA)\s*$/i, (m) => { out.country = 'Canada'; return ''; }).replace(/[,\s]+$/, '');
  const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length && PROVINCES.test(parts[parts.length - 1])) {
    const last = parts.pop();
    out.province = PROVINCES.exec(last)[1];
    const rest = last.replace(PROVINCES, '').trim();
    if (rest) parts.push(rest);
  }
  if (parts.length > 1) out.city = parts.pop();
  out.street = parts.join(', ');
  return out;
}

export const CUSTOMER_HEADERS = ['Name', 'Company', 'Email', 'Phone', 'Street', 'City', 'Province/Territory', 'Postal Code', 'Country'];

/** Customer import rows (header first) for clients. */
export function customerRows(clients) {
  const names = customerNames(clients);
  const rows = [CUSTOMER_HEADERS];
  for (const c of [...clients].sort((a, b) => names.get(a.id).localeCompare(names.get(b.id)))) {
    const a = splitAddress(c.address);
    rows.push([names.get(c.id), c.type === 'commercial' || c.type === 'industrial' ? qboName(c.name).slice(0, 50) : '', String(c.email || '').slice(0, 100),
      String(c.phone || '').slice(0, 21), a.street, a.city, a.province, a.postal, a.country || (a.province ? 'Canada' : '')]);
  }
  return rows;
}

/** A YYYY-MM-DD day in the format chosen in QBO's import wizard. */
export function fmtDay(day, format = 'DD/MM/YYYY') {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(day || ''));
  if (!m) return '';
  const [, y, mo, d] = m;
  if (format === 'MM/DD/YYYY') return `${mo}/${d}/${y}`;
  if (format === 'YYYY-MM-DD') return `${y}-${mo}-${d}`;
  return `${d}/${mo}/${y}`;
}

const money = (cents) => (Math.round(Number(cents) || 0) / 100).toFixed(2);
/** Quantities as plain decimals (QBO allows several decimals; trailing zeros dropped). */
const qty = (n) => String(Math.round((Number(n) || 0) * 10000) / 10000);

export const INVOICE_HEADERS = ['InvoiceNo', 'Customer', 'InvoiceDate', 'DueDate', 'Terms', 'Memo', 'Item(Product/Service)', 'ItemDescription', 'ItemQuantity', 'ItemRate', 'ItemAmount', 'ItemTaxCode', 'Service Date'];

/** Invoices in a date range (by issue date), ready to export: not draft, not void unless asked. */
export function invoicesInRange(invoices, { from, to, includeDrafts = false } = {}) {
  return invoices.filter((i) => i.status !== 'void' && (includeDrafts || i.status !== 'draft')
    && (!from || (i.issueDate || '') >= from) && (!to || (i.issueDate || '') <= to))
    .sort((a, b) => (a.issueDate || '').localeCompare(b.issueDate || '') || String(a.number).localeCompare(String(b.number)));
}

/**
 * QBO invoice import rows (header first). One row per line; a materials markup becomes its own
 * line. Lines QBO refuses (negative amounts) are reported in `problems` with the invoice left out.
 * @param {object} o
 * @param {object[]} o.invoices  already filtered (invoicesInRange)
 * @param {Map<string,string>} o.names  client id -> QBO customer name (customerNames)
 * @param {object} [o.items]  product/service names per line kind { material, labour, other }
 * @param {object} [o.codes]  tax code names by taxKey
 * @param {string} [o.dateFormat]
 * @returns {{ rows: string[][], problems: { number: string, message: string }[], count: number }}
 */
export function invoiceRows({ invoices, names, items = {}, codes = {}, dateFormat = 'DD/MM/YYYY', clientOf = (inv) => inv.clientId }) {
  const itemName = { material: 'Materials', labour: 'Labour', other: 'Other', ...items };
  const rows = [INVOICE_HEADERS];
  const problems = [];
  let count = 0;
  for (const inv of invoices) {
    const clientId = clientOf(inv);
    const customer = clientId ? names.get(clientId) : null;
    if (!customer) { problems.push({ number: inv.number, message: 'No client on this invoice; QuickBooks needs a customer.' }); continue; }
    const lines = (inv.lines || []).map((l) => ({ ...l, kind: KINDS.includes(l.kind) ? l.kind : 'material', cents: lineCents(l) }));
    const t = docTotals(inv);
    if (t.markupCents) lines.push({ kind: 'material', description: `Materials markup (${inv.markupPct}%)`, qty: 1, unitCents: t.markupCents, cents: t.markupCents });
    if (lines.some((l) => l.cents < 0)) { problems.push({ number: inv.number, message: 'Has a negative line (a discount or credit); QuickBooks import refuses those. Enter it by hand.' }); continue; }
    if (!lines.length) { problems.push({ number: inv.number, message: 'No lines.' }); continue; }
    count++;
    for (const l of lines) {
      const rate = Number(l.qty) ? l.cents / 100 / Number(l.qty) : l.cents / 100;
      rows.push([String(inv.number || ''), customer, fmtDay(inv.issueDate, dateFormat), fmtDay(inv.dueDate || inv.issueDate, dateFormat), '',
        String(inv.notes || inv.title || '').replace(/\s+/g, ' ').slice(0, 1000), itemName[l.kind], String(l.description || '').replace(/[\r\n]+/g, ' ').slice(0, 4000),
        qty(l.qty || 1), String(Math.round(rate * 10000) / 10000), money(l.cents), taxCodeFor(inv, l.kind, codes), '']);
    }
  }
  return { rows, problems, count };
}

/**
 * Split import rows (header first) into files QuickBooks accepts: at most `maxRows` data rows and
 * `maxInvoices` invoices each, never splitting one invoice (key column `keyIndex`) across files.
 */
export function splitFiles(rows, { maxRows = QBO_LIMITS.invoiceRows, maxInvoices = Infinity, keyIndex = null } = {}) {
  const [header, ...body] = rows;
  const files = [];
  let cur = [], keys = new Set();
  const flush = () => { if (cur.length) files.push([header, ...cur]); cur = []; keys = new Set(); };
  let i = 0;
  while (i < body.length) {
    let j = i + 1;
    if (keyIndex != null) while (j < body.length && body[j][keyIndex] === body[i][keyIndex]) j++;
    const group = body.slice(i, j);
    const newKey = keyIndex != null && !keys.has(body[i][keyIndex]);
    if (cur.length && (cur.length + group.length > maxRows || (newKey && keys.size >= maxInvoices))) flush();
    cur.push(...group);
    if (keyIndex != null) keys.add(body[i][keyIndex]);
    i = j;
  }
  flush();
  return files.length ? files : [[header]];
}

export const PAYMENT_HEADERS = ['Ref No', 'Customer', 'Payment Date', 'Payment method', 'Deposit To Account Name', 'Invoice No', 'Amount', 'Reference No', 'Memo', 'Currency Code'];
const METHOD = { 'e-transfer': 'E-Transfer', cheque: 'Cheque', check: 'Cheque', card: 'Credit Card', cash: 'Cash', transfer: 'Direct Deposit' };

/** Received-payment rows (SaasAnt layout) for payments in a date range. */
export function paymentRows({ payments, invoicesById, names, clientOf = (inv) => inv.clientId, from, to, depositTo = 'Undeposited Funds', dateFormat = 'DD/MM/YYYY', currency = 'CAD' }) {
  const rows = [PAYMENT_HEADERS];
  const problems = [];
  const list = payments.filter((p) => (!from || (p.date || '') >= from) && (!to || (p.date || '') <= to))
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  let n = 0;
  for (const p of list) {
    const inv = invoicesById.get(p.invoiceId);
    const customer = inv ? names.get(clientOf(inv)) : null;
    if (!inv || !customer) { problems.push({ number: inv?.number || '?', message: `Payment of ${money(p.amountCents)} on ${p.date}: invoice or client missing.` }); continue; }
    n++;
    rows.push([`P-${String(n).padStart(4, '0')}`, customer, fmtDay(p.date, dateFormat), METHOD[p.method] || (p.method ? String(p.method) : ''), depositTo,
      String(inv.number || ''), money(p.amountCents), String(p.reference || '').slice(0, 100), p.source === 'stripe' ? 'Paid online (Stripe)' : '', currency]);
  }
  return { rows, problems, count: n };
}

/**
 * A plain CSV for any bookkeeping tool: one row per invoice with each tax as its own column,
 * what was paid and the balance. Tax columns are named after the components used.
 */
export function genericInvoiceRows({ invoices, names, clientOf = (inv) => inv.clientId, paidOf = () => 0 }) {
  const taxCols = [];
  for (const inv of invoices) for (const t of docTotals(inv).taxes) if (!taxCols.includes(t.label)) taxCols.push(t.label);
  const rows = [['Invoice', 'Customer', 'Issue date', 'Due date', 'Status', 'Province', 'Materials', 'Labour', 'Other', 'Markup', 'Subtotal', ...taxCols.map((c) => `${c}`), 'Tax total', 'Total', 'Paid', 'Balance']];
  for (const inv of invoices) {
    const t = docTotals(inv);
    const paid = paidOf(inv);
    rows.push([String(inv.number || ''), names.get(clientOf(inv)) || '', inv.issueDate || '', inv.dueDate || '', inv.status || '', inv.taxProvince || '',
      money(t.materialCents), money(t.labourCents), money(t.otherCents), money(t.markupCents), money(t.subtotalCents),
      ...taxCols.map((c) => money(t.taxes.filter((x) => x.label === c).reduce((s, x) => s + x.cents, 0))), money(t.taxCents), money(t.totalCents), money(paid), money(t.totalCents - paid)]);
  }
  return rows;
}
