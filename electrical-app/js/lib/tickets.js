// Field tickets (docs/releases/r1-get-paid.md 4.1; docs/field/tickets.md): signed extra-work and T&M
// tickets taken on the phone, offline. A ticket carries no money: hours, material and equipment
// quantities, photos, what the customer agreed to (the pricing basis sentence) and the signature.
// The office prices it afterwards: on a fixed-price job into a change order (ticketToChangeOrder),
// on a T&M job through the T&M invoice builder (lib/tm.js), on a service job as a draft invoice the
// tickets sweep makes on the server (ticketToInvoiceLines). Pure (no DOM): the server's sweep
// imports it.
import { jobBillingMode, jobRates, isTravel } from './tm.js';
import { entryHours } from './money.js';

export const TICKET_STATUSES = ['draft', 'signed', 'refused', 'priced', 'billed', 'void'];
export const TICKET_KINDS = [{ id: 'tm', label: 'Time and material' }, { id: 'extra', label: 'Extra work' }];
export const PRICING_BASES = [
  { id: 'contract-rates', label: 'Our contract rates' },
  { id: 'quote-to-follow', label: 'Quote to follow' },
];
export const MAX_PHOTOS = 4;
export const PHOTO_MAX_BYTES = 250 * 1024;
export const MAX_BATCH = 30;
export const DEFAULT_AGREEMENT = 'I confirm the work listed above was requested and done.';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const dayOfIso = (iso) => String(iso || '').slice(0, 10);

/** The sentence the pricing basis adds to the agreement. */
export function pricingSentence(pricingBasis, rateSheetRef = '') {
  if (pricingBasis === 'quote-to-follow') return 'Price to follow by quote; this confirms the work only.';
  const ref = str(rateSheetRef);
  return ref ? `Billed at the ${ref.replace(/^the\s+/i, '')}.` : 'Billed at our contract rates.';
}

/** The agreement the signer sees: the company's text plus the pricing basis sentence. */
export function agreementTextFor(settings, { pricingBasis = 'contract-rates', rateSheetRef = '' } = {}) {
  const base = str(settings?.tickets?.agreementText) || DEFAULT_AGREEMENT;
  return `${base} ${pricingSentence(pricingBasis, rateSheetRef)}`.slice(0, 2000);
}

/** "T-1042", or "T-pending a3f9" until the server assigns the number. */
export const ticketLabel = (t) => t?.number || `T-pending ${String(t?.id || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 4)}`;

/**
 * A new draft ticket (number null: the server assigns T-#### on the first accepted write). T&M jobs
 * get a T&M ticket, others an extra-work ticket; the pricing basis defaults to contract rates.
 */
export function newTicket({ job, employee = null, settings = {}, date, kind = null, id = null, rateSheetRef = '' } = {}) {
  const pricingBasis = 'contract-rates';
  return {
    ...(id ? { id } : {}),
    number: null, jobId: job?.id || null, clientId: job?.clientId || null,
    kind: kind || (jobBillingMode(job) === 'tm' ? 'tm' : 'extra'), date, title: '', description: '', requestedBy: '',
    pricingBasis, rateSheetRef: rateSheetRef || '', labour: [], materials: [], equipment: [], photos: [],
    agreementText: agreementTextFor(settings, { pricingBasis, rateSheetRef }),
    status: 'draft', employeeId: employee?.id || null, costCodeId: job?.currentCostCodeId || null,
  };
}

/**
 * Labour rows from today's time entries on the job (mine; a foreman sees the crew's), including
 * the open entry counted to now, one row per person with the entries it came from.
 * @returns {{ employeeId, name, hours, travel, timeEntryIds }[]}
 */
export function prefillLabour({ jobId, day, timeEntries = [], employees = [], employeeId = null, crew = false, now = new Date(), dayOf = dayOfIso } = {}) {
  const names = new Map(employees.map((e) => [e.id, e.name]));
  const rows = new Map();
  for (const t of timeEntries) {
    if (!t || t.jobId !== jobId || !t.clockIn || t.kind === 'correction') continue;
    if (day && dayOf(t.clockIn) !== day) continue;
    if (!crew && employeeId && t.employeeId !== employeeId) continue;
    const travel = isTravel(t);
    const key = `${t.employeeId}|${travel}`;
    if (!rows.has(key)) rows.set(key, { employeeId: t.employeeId || null, name: names.get(t.employeeId) || 'Crew', hours: 0, travel, timeEntryIds: [] });
    const r = rows.get(key);
    r.hours += entryHours(t, now);
    r.timeEntryIds.push(t.id);
  }
  return [...rows.values()].map((r) => ({ ...r, hours: Math.min(24, round2(r.hours)) })).filter((r) => r.hours > 0)
    .sort((a, b) => Number(a.travel) - Number(b.travel) || a.name.localeCompare(b.name));
}

/** What stops a ticket being signed (or saved, with forSigning false): messages for the screen. */
export function ticketProblems(t, { forSigning = true } = {}) {
  const out = [];
  if (!t?.jobId) out.push('Pick the job.');
  if (!str(t?.title)) out.push('Say what the work was (a short title).');
  if (forSigning && !str(t?.description) && !(t?.labour || []).length && !(t?.materials || []).length) out.push('Add a description, hours or material.');
  for (const l of t?.labour || []) {
    if (!(Number(l?.hours) >= 0) || Number(l.hours) > 24) out.push(`Hours for ${l?.name || 'a person'} must be between 0 and 24.`);
  }
  for (const m of t?.materials || []) if (!(Number(m?.qty) > 0)) out.push(`Give a quantity for ${m?.description || 'each material'}.`);
  if ((t?.photos || []).length > MAX_PHOTOS) out.push(`At most ${MAX_PHOTOS} photos.`);
  for (const p of t?.photos || []) {
    const bytes = Math.floor((String(p?.dataUrl || '').split(',')[1] || '').length * 3 / 4);
    if (bytes > PHOTO_MAX_BYTES) { out.push('A photo is too large (over 250 KB).'); break; }
  }
  return out;
}

/** The authorized-signer check: null when the job has no list, else whether the name is on it. */
export function signerOnList(job, name) {
  const list = (job?.contract?.authorizedSigners || []).map((s) => str(s?.name).toLowerCase()).filter(Boolean);
  if (!list.length) return null;
  return list.includes(str(name).toLowerCase());
}

/** Drafts older than settings.tickets.draftStaleDays: the office may send them as written notice. */
export function staleDrafts(tickets = [], { asOf, days = 3 } = {}) {
  const limit = Number(days) > 0 ? Number(days) : 3;
  return tickets.filter((t) => t?.status === 'draft' && t.date && asOf && (Date.parse(asOf) - Date.parse(t.date)) / 86400000 > limit);
}

/** The job's unsigned drafts a foreman or the office can have signed together (at most 30). */
export const batchCandidates = (tickets = [], jobId) => tickets.filter((t) => t?.jobId === jobId && t.status === 'draft').slice(0, MAX_BATCH);

/** How a ticket's quantities turn into priced lines. */
function pricedLines(ticket, { job, items = [], equipment = [], employees = [], settings = {} }) {
  const rates = jobRates(job, settings);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const eqById = new Map(equipment.map((e) => [e.id, e]));
  const empById = new Map(employees.map((e) => [e.id, e]));
  const label = ticketLabel(ticket);
  const lines = [];
  for (const l of ticket.labour || []) {
    const hours = round2(l?.hours);
    if (!hours) continue;
    const e = empById.get(l.employeeId);
    const rate = l.travel ? rates.travelRateCents : (Number(e?.billRateCents) > 0 && job?.labourRateCents == null ? Number(e.billRateCents) : rates.labourRateCents);
    lines.push({ itemId: null, kind: 'labour', description: `${l.travel ? 'Travel' : 'Labour'}: ${l.name || 'Crew'} (${label})`, qty: hours, unitCents: rate, labourHours: 0, costCodeId: ticket.costCodeId || null });
  }
  for (const m of ticket.materials || []) {
    const qty = round2(m?.qty);
    if (!qty) continue;
    const it = m.itemId ? itemById.get(m.itemId) : null;
    const price = Number.isInteger(it?.priceCents) && it.priceCents > 0 ? it.priceCents
      : Number.isInteger(it?.costCents) ? Math.round(it.costCents * (1 + rates.markupPct / 100)) : 0;
    lines.push({ itemId: it?.id || null, kind: 'material', description: `${it?.name || m.description || 'Material'}${price ? '' : ' (price needed)'}`, qty, unitCents: price, labourHours: 0, costCodeId: ticket.costCodeId || null });
  }
  for (const q of ticket.equipment || []) {
    const qty = round2(q?.qty);
    if (!qty) continue;
    const eq = q.equipmentId ? eqById.get(q.equipmentId) : null;
    const rate = Number.isInteger(eq?.billRateCents) ? eq.billRateCents : 0;
    lines.push({ itemId: null, kind: 'other', description: `${eq?.name || q.description || 'Equipment'} (${qty} ${q.unit || 'hour'}${qty === 1 ? '' : 's'})${rate ? '' : ' (rate needed)'}`, qty, unitCents: rate, labourHours: 0, costCodeId: ticket.costCodeId || null });
  }
  return lines;
}

/**
 * A change order priced from a ticket on a fixed-price job: labour at the job's T&M rates, material
 * at the price book price (else cost plus markup), equipment at its bill rate. The office edits it
 * before saving. Refused on T&M jobs (they bill tickets through the T&M builder). A refused ticket
 * carries the written-notice note.
 */
export function ticketToChangeOrder(ticket, { job, items = [], equipment = [], employees = [], settings = {}, id = null, today = null } = {}) {
  if (jobBillingMode(job) === 'tm') throw new Error('This is a time and material job: bill its tickets with "Build invoice from time & material", not as a change order.');
  const lines = pricedLines(ticket, { job, items, equipment, employees, settings });
  const amountCents = lines.reduce((s, l) => s + Math.round(l.qty * l.unitCents), 0);
  const refused = ticket.status === 'refused';
  const noticeDay = dayOfIso(ticket.notice?.queuedAt) || dayOfIso(ticket.refusal?.at);
  return {
    id: id || `co-${String(ticket.id || '').slice(0, 40)}`,
    title: `${ticketLabel(ticket)}: ${ticket.title || 'Extra work'}`.slice(0, 300), lines, amountCents,
    date: today || ticket.date || null, status: 'pending', ticketIds: [ticket.id], costCodeId: ticket.costCodeId || null, source: 'ticket',
    ...(refused ? { note: `Unsigned: written notice given ${noticeDay || 'on refusal'}` } : {}),
  };
}

/** Invoice lines for a service call ticket (the tickets sweep's draft invoice). */
export function ticketToInvoiceLines(ticket, opts = {}) {
  return pricedLines(ticket, opts);
}

/**
 * Hours billed (time entries on the invoice) against hours signed (tickets) per day, for a T&M
 * invoice. Days where billed exceeds signed are flagged; the office gives a reason before saving.
 * Nothing to reconcile (an empty list) when no signed or refused ticket falls in the range: the job
 * is not billed against tickets. Used when lib/tm.js buildTmInvoice returns no ticketReconciliation.
 * @returns {{ day, billedMinutes, signedMinutes, flagged }[]}
 */
export function ticketReconciliation({ tickets = [], labour = [], from = '', to = '' } = {}) {
  const inRange = tickets.filter((t) => t && ['signed', 'refused', 'priced'].includes(t.status) && t.date && (!from || t.date >= from) && (!to || t.date <= to));
  if (!inRange.length) return [];
  const days = new Map();
  const at = (d) => { if (!days.has(d)) days.set(d, { day: d, billedMinutes: 0, signedMinutes: 0 }); return days.get(d); };
  for (const l of labour) if (l?.day && (!from || l.day >= from) && (!to || l.day <= to)) at(l.day).billedMinutes += Math.round((Number(l.hours) || 0) * 60);
  for (const t of inRange) {
    at(t.date).signedMinutes += Math.round((t.labour || []).reduce((s, l) => s + (Number(l?.hours) || 0), 0) * 60);
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).map((r) => ({ ...r, flagged: r.billedMinutes > r.signedMinutes }));
}

/** Signed or refused tickets on a job in a date range that a T&M invoice picks up. */
export const billableTickets = (tickets = [], jobId, { from = '', to = '' } = {}) => tickets.filter((t) => t?.jobId === jobId
  && ['signed', 'refused', 'priced'].includes(t.status) && !t.invoiceId && (!from || t.date >= from) && (!to || t.date <= to));

/** A ticket's content as the customer saw it, for the office (no money). */
export function ticketSummary(t) {
  const hours = round2((t?.labour || []).reduce((s, l) => s + (Number(l?.hours) || 0), 0));
  return [`${ticketLabel(t)} ${t?.title || ''}`.trim(), t?.date || '', hours ? `${hours} h` : null,
    (t?.materials || []).length ? `${t.materials.length} material` : null].filter(Boolean).join(' · ');
}

/** The written notice text (refusal or an unsigned draft), with no money. */
export function noticeText(ticket, { job, company, kind = 'refusal', zoneTime = (iso) => iso } = {}) {
  const label = ticketLabel(ticket);
  const head = kind === 'refusal'
    ? `Written notice of extra work: ${label} on ${job?.number || ''} ${job?.title || ''}, done ${ticket.date}, refused by ${ticket.refusal?.by || 'the customer'} at ${zoneTime(ticket.refusal?.at)}.`
    : `Written notice of extra work: ${label} on ${job?.number || ''} ${job?.title || ''}, done ${ticket.date}. It was not signed on site.`;
  return [head.replace(/\s+/g, ' '), '', ...ticketBodyLines(ticket), '', company?.name || ''].join('\n').trim();
}

/** The ticket's content as plain lines (copies and notices; never prices). */
export function ticketBodyLines(t) {
  return [
    `Work: ${t.title || ''}`, t.description ? `Details: ${t.description}` : null, t.requestedBy ? `Requested by: ${t.requestedBy}` : null,
    ...(t.labour || []).map((l) => `Labour: ${l.name || 'Crew'} ${round2(l.hours)} h${l.travel ? ' (travel)' : ''}`),
    ...(t.materials || []).map((m) => `Material: ${m.qty} ${m.unit || ''} ${m.description || ''}`.replace(/\s+/g, ' ')),
    ...(t.equipment || []).map((q) => `Equipment: ${q.description || ''} ${q.qty} ${q.unit || ''}`.replace(/\s+/g, ' ')),
    (t.photos || []).length ? `Photos: ${t.photos.length} (kept with the ticket)` : null,
    t.agreementText ? `Agreement: ${t.agreementText}` : null,
  ].filter(Boolean);
}
