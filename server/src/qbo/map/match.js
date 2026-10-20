// First-connect matching (docs/integrations/quickbooks.md 6.3). Pure: takes Fishtape records and
// QBO objects, returns candidates for qbo_candidates:
//   { kind, fishtapeId, qboId, qboLine?, score, reasons, status, choice, qboSummary, options?, needsConfirm?, netOfFee? }
// status: matched | ambiguous | fishtape_only | quickbooks_only; choice: link | create_in_qbo |
// create_in_fishtape | skip. A name-only match is never linked by itself: two "Dana Smith"s are
// common, and a wrong link would post invoices to the wrong customer's AR.
//
// The normalizers are copies of electrical-app/js/lib/importers.js (a parity test keeps them
// equal); QBO server code imports no other PWA lib.
import { docTotals } from '../../../../electrical-app/js/lib/money.js';
import { splitAddress } from '../../../../electrical-app/js/lib/qbo-export.js';
import { compareTax } from './tax.js';
import { localDay, toCents } from './canon.js';

export const normEmail = (s) => String(s ?? '').trim().toLowerCase().replace(/^mailto:/, '');
/** Last 10 digits of a phone number ("+1 (306) 555-0142" -> "3065550142"). */
export const phoneKey = (s) => String(s ?? '').replace(/\D/g, '').slice(-10);
/** Names compared loosely: case, accents, punctuation and extra spaces ignored. */
export const nameKey = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
export const skuKey = (s) => String(s ?? '').trim().toUpperCase().replace(/\s+/g, '');
/** Postal codes compared upper case without spaces. */
export const postalKey = (s) => String(s ?? '').toUpperCase().replace(/\s+/g, '');

const id = (x) => (x == null ? null : String(x));
const asSet = (v) => (v instanceof Set ? v : new Set((v || []).map(String)));
const cand = (kind, o) => ({ kind, fishtapeId: null, qboId: null, score: 0, reasons: [], qboSummary: {}, ...o });

// ---------------------------------------------------------------------------------------------
// Pairing: highest score wins; ties and contested QBO objects are ambiguous

/**
 * @param {object[]} lefts Fishtape records
 * @param {object[]} rights QBO objects
 * @param {(l, r) => { score: number, reasons: string[] }} scoreOf
 * @param {number} linkAt the lowest score that links by itself
 */
function pairUp(lefts, rights, scoreOf, linkAt) {
  const scores = lefts.map((l) => rights.map((r) => scoreOf(l, r)));
  const used = new Set();
  const results = lefts.map((l, i) => {
    const row = scores[i];
    const best = Math.max(0, ...row.map((s) => s.score));
    if (!best) return { left: l, status: 'fishtape_only' };
    const tops = rights.map((r, j) => ({ r, j, s: row[j] })).filter((x) => x.s.score === best);
    const top = tops[0];
    const contested = lefts.some((_, k) => k !== i && scores[k][top.j].score >= best);
    for (const t of tops) used.add(t.j);
    const reasons = [...top.s.reasons];
    if (tops.length > 1) reasons.push('tie');
    if (contested) reasons.push('contested');
    if (best < linkAt) reasons.push('name_only');
    const ambiguous = tops.length > 1 || contested || best < linkAt;
    return { left: l, right: top.r, score: best, reasons, status: ambiguous ? 'ambiguous' : 'matched', options: tops.length > 1 ? tops.map((t) => id(t.r.Id)) : undefined };
  });
  const qboOnly = rights.filter((_, j) => !used.has(j));
  return { results, qboOnly };
}

function nameScore(target, names, postalA, postalB, { withPostal = 75, alone = 70 } = {}) {
  const k = nameKey(target);
  if (!k || !names.some((n) => nameKey(n) === k)) return null;
  if (postalA && postalB && postalKey(postalA) === postalKey(postalB)) return { score: withPostal, reasons: ['name', 'postal'] };
  return { score: alone, reasons: ['name'] };
}

/** Email 100, last-10-digit phone 80, name and postal code 75, name only 70 (customers and vendors). */
function partyScore(rec, q) {
  const out = [];
  const email = normEmail(rec.email);
  if (email && email === normEmail(q.PrimaryEmailAddr?.Address)) out.push({ score: 100, reasons: ['email'] });
  const phone = phoneKey(rec.phone);
  if (phone.length === 10 && [q.PrimaryPhone?.FreeFormNumber, q.Mobile?.FreeFormNumber].some((p) => phoneKey(p) === phone)) out.push({ score: 80, reasons: ['phone'] });
  const names = [q.DisplayName, q.CompanyName, [q.GivenName, q.FamilyName].filter(Boolean).join(' ')].filter(Boolean);
  const n = nameScore(rec.name, names, splitAddress(rec.address).postal, q.BillAddr?.PostalCode);
  if (n) out.push(n);
  return out.sort((a, b) => b.score - a.score)[0] || { score: 0, reasons: [] };
}

const partySummary = (q) => ({
  name: q.DisplayName || null, email: q.PrimaryEmailAddr?.Address || null, phone: q.PrimaryPhone?.FreeFormNumber || null,
  type: q.CompanyName ? 'business' : 'residential', balanceCents: q.Balance == null ? null : toCents(q.Balance), active: q.Active !== false,
});

function finish(kind, { results, qboOnly }, { onMatched = 'link', onFishtapeOnly, onQboOnly, summary }) {
  const out = results.map((x) => {
    if (x.status === 'fishtape_only') return cand(kind, { fishtapeId: id(x.left.id), status: 'fishtape_only', choice: onFishtapeOnly(x.left) });
    return cand(kind, {
      fishtapeId: id(x.left.id), qboId: id(x.right.Id), score: x.score, reasons: x.reasons, status: x.status,
      choice: x.status === 'matched' ? onMatched : 'skip', qboSummary: summary(x.right), ...(x.options ? { options: x.options } : {}),
    });
  });
  for (const q of qboOnly) out.push(cand(kind, { qboId: id(q.Id), status: 'quickbooks_only', choice: onQboOnly(q), qboSummary: summary(q) }));
  return out;
}

const topLevel = (c) => c.Job !== true && !c.ParentRef && c.IsProject !== true;

/**
 * Clients and QBO top-level customers.
 * @param {object} [opts] { activeClientIds: client ids with an estimate, invoice or job on or after syncFrom
 *   or an open invoice; activeCustomerIds: QBO ids with a transaction on or after syncFrom; importCustomers }
 */
export function matchCustomers(clients, customers, { activeClientIds = [], activeCustomerIds = [], importCustomers = 'active' } = {}) {
  const activeC = asSet(activeClientIds), activeQ = asSet(activeCustomerIds);
  const qs = (customers || []).filter(topLevel);
  return finish('customers', pairUp(clients || [], qs, partyScore, 75), {
    onFishtapeOnly: (c) => (activeC.has(String(c.id)) ? 'create_in_qbo' : 'skip'),
    onQboOnly: (q) => (q.Active === false ? 'skip' : (importCustomers === 'all' || activeQ.has(String(q.Id)) || toCents(q.Balance) > 0 ? 'create_in_fishtape' : 'skip')),
    summary: partySummary,
  });
}

/** Suppliers: rules as customers; one side only and active is created on the other side. */
export function matchVendors(vendors, qboVendors) {
  return finish('vendors', pairUp(vendors || [], qboVendors || [], partyScore, 75), {
    onFishtapeOnly: (v) => (v.active === false ? 'skip' : 'create_in_qbo'),
    onQboOnly: (q) => (q.Active === false ? 'skip' : 'create_in_fishtape'),
    summary: partySummary,
  });
}

/**
 * Jobs and QBO sub-customers or projects whose parent is the job's (matched) client: the job
 * number in the name 90, the title as the name 70. Jobs are never created in Fishtape, and in QBO
 * only when first used.
 * @param {object|Function|Map} links client id -> the QBO customer id it is matched (or about to be linked) to
 */
export function matchJobs(jobs, customers, links) {
  const parentFor = typeof links === 'function' ? links : (links instanceof Map ? (c) => links.get(c) : (c) => links?.[c]);
  const subs = (customers || []).filter((c) => !topLevel(c) && c.ParentRef);
  const score = (job, q) => {
    const parent = parentFor(job.clientId);
    if (!parent || String(parent) !== String(q.ParentRef?.value)) return { score: 0, reasons: [] };
    const names = [q.DisplayName, String(q.FullyQualifiedName || '').split(':').pop()].map(nameKey).filter(Boolean);
    const num = nameKey(job.number);
    if (num && names.some((n) => ` ${n} `.includes(` ${num} `))) return { score: 90, reasons: ['number'] };
    const title = nameKey(job.title);
    if (title && names.includes(title)) return { score: 70, reasons: ['title'] };
    return { score: 0, reasons: [] };
  };
  const r = pairUp(jobs || [], subs, score, 70);
  return finish('jobs', r, {
    onFishtapeOnly: () => 'skip', onQboOnly: () => 'skip',
    summary: (q) => ({ name: q.DisplayName || null, type: q.IsProject ? 'project' : 'sub-customer', balanceCents: q.Balance == null ? null : toCents(q.Balance), active: q.Active !== false }),
  });
}

/**
 * Items: SKU 100, name 70 (Category and Group items left out, and the generic items of the
 * mappings, `exclude`, which never become Fishtape items).
 */
export function matchItems(items, qboItems, { items: mode = 'on_use', exclude = [] } = {}) {
  const skip = asSet(exclude);
  const qs = (qboItems || []).filter((q) => q.Type !== 'Category' && q.Type !== 'Group' && !skip.has(String(q.Id)));
  const score = (it, q) => {
    const sku = skuKey(it.sku);
    if (sku && sku === skuKey(q.Sku)) return { score: 100, reasons: ['sku'] };
    if (nameKey(it.name) && nameKey(it.name) === nameKey(q.Name)) return { score: 70, reasons: ['name'] };
    return { score: 0, reasons: [] };
  };
  const r = pairUp(items || [], qs, score, 70);
  return finish('items', r, {
    onFishtapeOnly: () => (mode === 'all' ? 'create_in_qbo' : 'skip'),
    onQboOnly: (q) => (q.Active === false ? 'skip' : 'create_in_fishtape'),
    summary: (q) => ({ name: q.Name || null, type: q.Type || null, active: q.Active !== false }),
  });
}

/** Crew to QBO employees: email 100, name 70. Only link or skip: Fishtape never creates employees. */
export function matchEmployees(employees, qboEmployees) {
  const score = (e, q) => {
    const email = normEmail(e.email);
    if (email && email === normEmail(q.PrimaryEmailAddr?.Address)) return { score: 100, reasons: ['email'] };
    const names = [q.DisplayName, [q.GivenName, q.FamilyName].filter(Boolean).join(' ')].map(nameKey).filter(Boolean);
    if (nameKey(e.name) && names.includes(nameKey(e.name))) return { score: 70, reasons: ['name'] };
    return { score: 0, reasons: [] };
  };
  const r = pairUp(employees || [], (qboEmployees || []).filter((q) => q.Active !== false), score, 70);
  return finish('employees', r, {
    onFishtapeOnly: () => 'skip', onQboOnly: () => 'skip',
    summary: (q) => ({ name: q.DisplayName || [q.GivenName, q.FamilyName].filter(Boolean).join(' ') || null, email: q.PrimaryEmailAddr?.Address || null, active: q.Active !== false }),
  });
}

// ---------------------------------------------------------------------------------------------
// Estimates and invoices

const numKey = (s) => String(s ?? '').trim().toUpperCase();
const daysApart = (a, b) => Math.abs((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

/** Totals within 2 cents, and every tax rate within 2 cents (6.3). */
export function totalsAgree(doc, q, ref) {
  const t = docTotals(doc);
  if (Math.abs(t.totalCents - toCents(q.TotalAmt)) > 2) return false;
  return compareTax(t, q.TxnTaxDetail, ref, q.TxnDate || undefined).withinTolerance;
}

const QBO_PENDING = new Set(['Pending', 'Accepted']);
const isVoidish = (q) => toCents(q.TotalAmt) === 0 && /^Voided/i.test(String(q.PrivateNote || ''));

/**
 * Fishtape documents and QBO documents of one kind (6.3).
 * Pass 1: the same number, customer matched and totals within 2 cents per tax rate: 100, linked.
 * The same number otherwise: ambiguous with both totals. Pass 2 (both still unmatched): customer
 * matched, totals agree and dates within 14 days: ambiguous `possible_duplicate` (a document keyed
 * into QBO by hand under another number); it is never created by default.
 * @param {'invoices'|'estimates'} kind
 * @param {object|Function} links doc -> the QBO customer id its client or job matches, or { customerFor(doc) }
 * @param {object} opts { taxFiledThrough, syncFrom, zone, ref (tax reference lists), pushDrafts }
 */
export function matchDocs(kind, docs, qboDocs, links, { taxFiledThrough = null, syncFrom = null, zone = 'America/Toronto', ref = null, pushDrafts = false } = {}) {
  const inv = kind === 'invoices';
  const customerFor = typeof links === 'function' ? links : (d) => links?.customerFor?.(d) ?? null;
  const dateOf = (d) => (inv ? d.issueDate : (d.issueDate || localDay(d.createdAt, zone))) || null;
  const openF = (d) => (inv ? ['sent', 'partial'].includes(d.status) : ['sent', 'accepted'].includes(d.status));
  const summary = (q) => ({
    docNumber: q.DocNumber || null, date: q.TxnDate || null, totalCents: toCents(q.TotalAmt), balanceCents: q.Balance == null ? null : toCents(q.Balance),
    status: inv ? (toCents(q.Balance) > 0 ? 'open' : 'paid') : (q.TxnStatus || null), name: q.CustomerRef?.name || null,
  });
  const fts = (docs || []).filter((d) => d.status !== 'void' && (pushDrafts || d.status !== 'draft'));
  const qs = (qboDocs || []).filter((q) => !isVoidish(q));
  const out = [];
  const usedQ = new Set(), usedF = new Set();
  const byNumber = new Map();
  for (const q of qs) { const k = numKey(q.DocNumber); if (k) (byNumber.get(k) || byNumber.set(k, []).get(k)).push(q); }

  for (const d of fts) {
    const same = (byNumber.get(numKey(d.number)) || []).filter((q) => !usedQ.has(String(q.Id)));
    if (!numKey(d.number) || !same.length) continue;
    const cust = id(customerFor(d));
    const q = same.find((x) => cust && id(x.CustomerRef?.value) === cust) || same[0];
    const custOk = cust && id(q.CustomerRef?.value) === cust;
    const agree = totalsAgree(d, q, ref);
    usedQ.add(String(q.Id)); usedF.add(String(d.id));
    const t = docTotals(d);
    if (custOk && agree) out.push(cand(kind, { fishtapeId: id(d.id), qboId: id(q.Id), score: 100, reasons: ['number', 'customer', 'totals'], status: 'matched', choice: 'link', qboSummary: summary(q) }));
    else {
      out.push(cand(kind, {
        fishtapeId: id(d.id), qboId: id(q.Id), score: 90, reasons: ['number', ...(custOk ? [] : ['customer_differs']), ...(agree ? [] : ['totals_differ'])],
        status: 'ambiguous', choice: 'skip', qboSummary: { ...summary(q), fishtapeTotalCents: t.totalCents },
      }));
    }
  }

  for (const d of fts) {
    if (usedF.has(String(d.id))) continue;
    const cust = id(customerFor(d));
    const dDate = dateOf(d);
    if (!cust || !dDate) continue;
    const near = qs.filter((q) => !usedQ.has(String(q.Id)) && id(q.CustomerRef?.value) === cust && q.TxnDate && daysApart(q.TxnDate, dDate) <= 14 && totalsAgree(d, q, ref))
      .sort((a, b) => daysApart(a.TxnDate, dDate) - daysApart(b.TxnDate, dDate));
    if (!near.length) continue;
    const q = near[0];
    usedQ.add(String(q.Id)); usedF.add(String(d.id));
    out.push(cand(kind, { fishtapeId: id(d.id), qboId: id(q.Id), score: 80, reasons: ['possible_duplicate'], status: 'ambiguous', choice: 'skip', qboSummary: { ...summary(q), fishtapeTotalCents: docTotals(d).totalCents } }));
  }

  for (const d of fts) {
    if (usedF.has(String(d.id))) continue;
    const dDate = dateOf(d);
    const inScope = openF(d) || (syncFrom && dDate && dDate >= syncFrom) || (!syncFrom);
    const filed = Boolean(taxFiledThrough && dDate && dDate <= taxFiledThrough);
    out.push(cand(kind, {
      fishtapeId: id(d.id), status: 'fishtape_only', choice: inScope ? 'create_in_qbo' : 'skip',
      reasons: inScope && filed ? ['filed_period'] : [], ...(inScope && filed ? { needsConfirm: true } : {}),
    }));
  }
  for (const q of qs) {
    if (usedQ.has(String(q.Id))) continue;
    const open = inv ? toCents(q.Balance) > 0 : QBO_PENDING.has(q.TxnStatus);
    const inScope = open || !syncFrom || (q.TxnDate && q.TxnDate >= syncFrom);
    out.push(cand(kind, { qboId: id(q.Id), status: 'quickbooks_only', choice: inScope ? 'create_in_fishtape' : 'skip', qboSummary: summary(q) }));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Payments

/**
 * Payments per linked invoice pair (6.3). Pairs by equal amount in any order (dates ignored); a
 * Stripe payment also pairs with a QBO payment of its gross minus stripe.feeCents (entered net by
 * the bookkeeper; `netOfFee` asks for meta.remoteAlias.amountCents). When the balances agree the
 * leftovers are skipped; otherwise a leftover is created on the other side unless that would take
 * the other side's balance below 0 (then ambiguous: never a double payment).
 * @param {{ invoice: { fishtapeId, qboId, fishtapeDueCents, qboBalanceCents },
 *           fishtape: { id, amountCents, date?, source?, stripe? }[], qbo: { qboId, amountCents, date? }[] }[]} pairs
 */
export function matchPayments(pairs) {
  const out = [];
  for (const p of pairs || []) {
    const inv = p.invoice || {};
    const agree = Number(inv.fishtapeDueCents) === Number(inv.qboBalanceCents);
    const qLeft = [...(p.qbo || [])].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
    const fLeft = [];
    const base = { qboLine: id(inv.qboId) };
    for (const f of [...(p.fishtape || [])].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))) {
      let k = qLeft.findIndex((q) => q.amountCents === f.amountCents);
      let net = false;
      const fee = Number(f.stripe?.feeCents) || 0;
      if (k < 0 && f.source === 'stripe' && fee > 0) { k = qLeft.findIndex((q) => q.amountCents === f.amountCents - fee); net = k >= 0; }
      if (k < 0) { fLeft.push(f); continue; }
      const [q] = qLeft.splice(k, 1);
      out.push(cand('payments', { ...base, fishtapeId: id(f.id), qboId: id(q.qboId), score: 100, reasons: [net ? 'net_of_fee' : 'amount'], status: 'matched', choice: 'link', qboSummary: { date: q.date || null, totalCents: q.amountCents }, ...(net ? { netOfFee: true } : {}) }));
    }
    let qboBal = Number(inv.qboBalanceCents) || 0, ftDue = Number(inv.fishtapeDueCents) || 0;
    for (const f of fLeft) {
      if (agree) { out.push(cand('payments', { ...base, fishtapeId: id(f.id), status: 'fishtape_only', choice: 'skip', reasons: ['balances_agree'] })); continue; }
      if (qboBal - f.amountCents >= 0) { qboBal -= f.amountCents; out.push(cand('payments', { ...base, fishtapeId: id(f.id), status: 'fishtape_only', choice: 'create_in_qbo' })); }
      else out.push(cand('payments', { ...base, fishtapeId: id(f.id), status: 'ambiguous', choice: 'skip', reasons: ['would_overpay'] }));
    }
    for (const q of qLeft) {
      const summary = { date: q.date || null, totalCents: q.amountCents };
      if (agree) { out.push(cand('payments', { ...base, qboId: id(q.qboId), status: 'quickbooks_only', choice: 'skip', reasons: ['balances_agree'], qboSummary: summary })); continue; }
      if (ftDue - q.amountCents >= 0) { ftDue -= q.amountCents; out.push(cand('payments', { ...base, qboId: id(q.qboId), status: 'quickbooks_only', choice: 'create_in_fishtape', qboSummary: summary })); }
      else out.push(cand('payments', { ...base, qboId: id(q.qboId), status: 'ambiguous', choice: 'skip', reasons: ['would_overpay'], qboSummary: summary }));
    }
  }
  return out;
}
