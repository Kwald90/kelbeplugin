// The final-billing checklist (docs/releases/r1-get-paid.md 4.8, 7.6): what is still open on a job
// before it is called invoiced. Setting a job to `complete` shows every item as a warning; setting it
// to `invoiced` blocks on the items marked block until they are cleared or the office records why
// (at least 10 characters; the server refuses the status change without a checked closeout,
// server/src/auth/access.js). Pure: the job screen and the daily job (closeout_due) share it.
import { docTotals, invoiceKind } from './money.js';
import { jobBillingMode, unbilledTm } from './tm.js';
import { depositsAvailable, holdbackLedger, balanceCents, unbilledChangeOrders, ticketBilled, billedRevenueCents, daysBetween } from './receivables.js';

export const CLOSEOUT_ITEMS = [
  { key: 'co_unbilled', label: 'Approved change orders not billed', severity: 'block', tab: 'changes' },
  { key: 'tickets_open', label: 'Field tickets not priced or billed', severity: 'block', link: '#/tickets' },
  { key: 'tm_unbilled', label: 'Time and material not billed', severity: 'block', tab: 'overview' },
  { key: 'time_unapproved', label: 'Time waiting for approval', severity: 'warn', tab: 'time' },
  { key: 'holdback_unreleased', label: 'Holdback not released', severity: 'warn', tab: 'money' },
  { key: 'deposits_unapplied', label: 'Paid deposits not applied, refunded or kept', severity: 'block', tab: 'money' },
  { key: 'deposit_unpaid', label: 'Deposit invoices not paid (void or collect them)', severity: 'warn', tab: 'money' },
  { key: 'disputes_open', label: 'Open disputes on invoices', severity: 'warn', tab: 'money' },
  { key: 'drafts', label: 'Draft invoices', severity: 'warn', tab: 'money' },
  { key: 'po_open', label: 'Open purchase orders, or received material with no bill', severity: 'warn', link: '#/purchasing' },
  { key: 'permit_open', label: 'Permits without a passed final inspection', severity: 'warn', tab: 'compliance' },
  { key: 'gst_substantial', label: 'Substantial performance recorded with contract value unbilled (GST may be due: Excise Tax Act s.168(3)(c))', severity: 'warn', tab: 'money' },
];
export const CLOSEOUT_LABEL = Object.fromEntries(CLOSEOUT_ITEMS.map((i) => [i.key, i.label]));
export const OVERRIDE_MIN = 10;

const day = (d) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null);

/** Contract value: the job's contract value plus approved change orders (null without a value). */
export function contractValueCents(job) {
  const v = job?.contract?.valueCents;
  if (!Number.isInteger(v)) return null;
  return v + (job.changeOrders || []).filter((c) => c?.status === 'approved').reduce((s, c) => s + (Number(c.amountCents) || 0), 0);
}

/**
 * The checklist for one job. sources: { invoices, payments, fieldTickets, timeEntries, stockMoves,
 * materialRequests, items, employees, purchaseOrders, bills, permits, inspections, settings, dayOf }.
 * at 'complete': everything is a warning; at 'invoiced': the severities above (holdback blocks once
 * holdbackReleaseOn has passed). Only items with something open are returned.
 * @returns {{ key, label, count, link, severity: 'block'|'warn' }[]}
 */
export function closeoutChecklist(job, sources = {}, { at = 'invoiced', asOf = null } = {}) {
  const s = { invoices: [], payments: [], fieldTickets: [], timeEntries: [], stockMoves: [], materialRequests: [], items: [], employees: [], purchaseOrders: [], bills: [], permits: [], inspections: [], settings: {}, ...sources };
  const today = asOf || new Date().toISOString().slice(0, 10);
  const invoices = s.invoices.filter((i) => i?.jobId === job.id);
  const live = invoices.filter((i) => i.status !== 'void');
  const tm = jobBillingMode(job) === 'tm';
  const counts = {};
  counts.co_unbilled = unbilledChangeOrders(job, s.invoices).length;
  const stale = Number(s.settings?.tickets?.draftStaleDays) > 0 ? Number(s.settings.tickets.draftStaleDays) : 3;
  counts.tickets_open = s.fieldTickets.filter((t) => {
    if (t?.jobId !== job.id) return false;
    if (t.status === 'draft') return (daysBetween(day(t.date) || day(t.createdAt), today) ?? 0) > stale;
    if (!['signed', 'refused', 'priced'].includes(t.status)) return false;
    if (ticketBilled(t, s.invoices)) return false;
    return tm || job.kind === 'service' ? true : t.status !== 'priced';
  }).length;
  if (tm) {
    const u = unbilledTm({ job, settings: s.settings, timeEntries: s.timeEntries, stockMoves: s.stockMoves, materialRequests: s.materialRequests, items: s.items, employees: s.employees, invoices: s.invoices, dayOf: s.dayOf });
    counts.tm_unbilled = u.labour.length + u.materials.length;
  }
  counts.time_unapproved = s.timeEntries.filter((t) => t?.jobId === job.id && t.clockOut && !t.approved && t.kind !== 'correction').length;
  const led = holdbackLedger(s.invoices, { jobId: job.id });
  counts.holdback_unreleased = led.outstandingCents > 0 ? 1 : 0;
  counts.deposits_unapplied = depositsAvailable(s.invoices, s.payments, { jobId: job.id }).filter((d) => d.jobId === job.id && d.availableCents > 0).length;
  counts.deposit_unpaid = live.filter((i) => i.status !== 'draft' && invoiceKind(i) === 'deposit' && !i.forfeitedOn && balanceCents(i, s.payments) > 0).length;
  counts.disputes_open = live.reduce((n, i) => n + (i.disputes || []).filter((d) => (d?.status || 'open') === 'open').length, 0);
  counts.drafts = invoices.filter((i) => i.status === 'draft').length;
  const billedPo = new Set(s.bills.filter((b) => b && b.status !== 'void').flatMap((b) => [b.poId, ...(b.lines || []).map((l) => l?.poId)]).filter(Boolean));
  counts.po_open = s.purchaseOrders.filter((p) => p?.jobId === job.id && (['open', 'sent'].includes(p.status)
    || (p.status !== 'cancelled' && (p.lines || []).some((l) => Number(l?.receivedQty) > 0) && !billedPo.has(p.id)))).length;
  const passedFinal = (permit) => s.inspections.some((x) => x && (x.permitId === permit.id || (!x.permitId && x.jobId === job.id)) && /final/i.test(String(x.type || '')) && x.result === 'passed');
  counts.permit_open = s.permits.filter((p) => p?.jobId === job.id && p.status !== 'closed' && !passedFinal(p)).length;
  const value = contractValueCents(job);
  counts.gst_substantial = day(job.contract?.substantialPerformanceOn) && value != null && billedRevenueCents(s.invoices, job.id) < value ? 1 : 0;

  const out = [];
  for (const item of CLOSEOUT_ITEMS) {
    const count = counts[item.key] || 0;
    if (!count) continue;
    let severity = at === 'complete' ? 'warn' : item.severity;
    if (item.key === 'holdback_unreleased' && at !== 'complete') {
      const rel = day(job.contract?.holdbackReleaseOn);
      severity = rel && rel < today ? 'block' : 'warn';
    }
    out.push({ key: item.key, label: item.label, count, link: item.link || `#/jobs/${job.id}?tab=${item.tab}`, severity });
  }
  return out;
}

/**
 * What to save on the job: closeout { checkedAt, checkedBy, open, override? }. At 'complete' open lists
 * every item (all warnings); at 'invoiced' only the blocking ones, so a job with warnings only is
 * saved with open [] (the server needs open empty or an override reason).
 */
export function closeoutRecord(checklist, { by, at = new Date().toISOString(), stage = 'invoiced', override = null } = {}) {
  const open = stage === 'complete' ? checklist : checklist.filter((i) => i.severity === 'block');
  return {
    checkedAt: at, checkedBy: by || null, open: open.map((i) => i.key),
    ...(override && String(override.reason || '').trim().length >= OVERRIDE_MIN ? { override: { by: override.by || by || null, at, reason: String(override.reason).trim().slice(0, 500) } } : {}),
  };
}

/** Can the job be set invoiced with this checklist (and override)? */
export function closeoutBlocks(checklist) { return checklist.filter((i) => i.severity === 'block'); }

/** The release invoice's dates default to holdbackReleaseOn (never pushed early). */
export const releaseDue = (job, asOf) => Boolean(day(job?.contract?.holdbackReleaseOn)) && job.contract.holdbackReleaseOn <= asOf;

/** Unbilled contract value for the GST notice (null without a contract value). */
export function unbilledContractCents(job, invoices = []) {
  const v = contractValueCents(job);
  return v == null ? null : v - billedRevenueCents(invoices, job.id);
}

/** Sum of an invoice set's totals (for the closeout summary on screen). */
export const totalOf = (invoices) => invoices.reduce((s, i) => s + docTotals(i).totalCents, 0);
