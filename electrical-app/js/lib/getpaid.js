// Close-the-sale ("Get paid") flow logic: pure helpers that read estimates, invoices and payments
// and compute the four-step state. No DOM and no store mutation here — modules/getpaid.js owns the
// actions and reuses the existing estimate-sign, invoice-from-estimate and Stripe pay-link code.
// The steps, in order: quote -> customer approval (signature) -> invoice -> get paid.
import { balanceCents } from './receivables.js';

// A live estimate is one still in play (not declined, not superseded by a revision).
const EST_LIVE = ['draft', 'sent', 'accepted'];

/** Estimates attached to a job, newest first (createdAt, then id as a stable tiebreak). */
export function jobEstimates(estimates, jobId) {
  if (!jobId) return [];
  return (estimates || [])
    .filter((e) => e && e.jobId === jobId && !e.deletedAt)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(b.id).localeCompare(String(a.id)));
}

/**
 * The estimate this flow acts on: the accepted one if there is one, else the newest live estimate,
 * else the newest of whatever is attached. null when the job has no estimate yet.
 */
export function pickEstimate(estimates, jobId) {
  const list = jobEstimates(estimates, jobId);
  return list.find((e) => e.status === 'accepted')
    || list.find((e) => EST_LIVE.includes(e.status))
    || list[0] || null;
}

/** The non-void invoice created from an estimate (newest first if several), or null. */
export function invoiceForEstimate(invoices, estimateId) {
  if (!estimateId) return null;
  const hits = (invoices || [])
    .filter((i) => i && i.estimateId === estimateId && i.status !== 'void' && !i.deletedAt)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return hits[0] || null;
}

/** Amount still owing on an invoice given all payment records, or null when there is no invoice. */
export function owing(invoice, payments) {
  if (!invoice) return null;
  return balanceCents(invoice, (payments || []).filter((p) => p && p.invoiceId === invoice.id));
}

/**
 * The four ordered steps and their state: 'done', 'now' (the one active step), 'todo' (reachable but
 * not yet active) or 'blocked' (a prior step is not done). Exactly one step is 'now' unless the flow
 * is complete. bal is the invoice balance in cents (ignored until an invoice exists).
 */
export function steps({ estimate, invoice, bal } = {}) {
  const raw = [
    { key: 'quote', label: 'Quote', done: Boolean(estimate) },
    { key: 'sign', label: 'Customer approval', done: Boolean(estimate && estimate.status === 'accepted') },
    { key: 'invoice', label: 'Invoice', done: Boolean(invoice) },
    { key: 'pay', label: 'Get paid', done: Boolean(invoice && typeof bal === 'number' && bal <= 0) },
  ];
  let activeTaken = false;
  return raw.map((s, i) => {
    if (s.done) return { ...s, state: 'done' };
    const prevDone = i === 0 || raw[i - 1].done;
    if (prevDone && !activeTaken) { activeTaken = true; return { ...s, state: 'now' }; }
    return { ...s, state: prevDone ? 'todo' : 'blocked' };
  });
}

/** True when every step is done. */
export function flowComplete(stepList) { return (stepList || []).length > 0 && stepList.every((s) => s.done); }

/** The single active step, or null when the flow is complete. */
export function currentStep(stepList) { return (stepList || []).find((s) => s.state === 'now') || null; }

/** How far along, as done/total, for a compact progress label. */
export function progress(stepList) {
  const done = (stepList || []).filter((s) => s.done).length;
  return { done, total: (stepList || []).length };
}
