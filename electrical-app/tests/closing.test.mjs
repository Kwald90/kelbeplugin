// The period lock (js/lib/closing.js, docs/releases/r1-get-paid.md 2.6).
// Run: node --test electrical-app/tests/*.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DOC_DATE_FIELD, POSTED_COLLECTIONS, LOCK_SAFE_FIELDS, lockDay, postingFor, lockProblem, isLocked, locksFrom, isLateHours, dayIn, zoneFor, endOfLastMonth, addDay } from '../js/lib/closing.js';

const zone = 'America/Winnipeg';
const locks = (o = {}) => ({ booksThrough: '2026-09-30', payrollThrough: null, payrollEntryIds: new Set(), qboBookCloseDate: null, ...o });

describe('lock days', () => {
  test('per collection: posting date first, then the document day in the company zone', () => {
    assert.equal(DOC_DATE_FIELD.invoices, 'issueDate');
    assert.deepEqual(POSTED_COLLECTIONS, ['payments', 'bills', 'stockMoves', 'timeEntries', 'equipmentUse', 'stockCounts']);
    assert.equal(lockDay('invoices', { issueDate: '2026-09-28' }, { zone }), '2026-09-28');
    assert.equal(lockDay('bills', { date: '2026-09-28', postedOn: '2026-10-01' }, { zone }), '2026-10-01');
    assert.equal(lockDay('bills', { date: '2026-09-28' }, { zone }), '2026-09-28', 'an old record without postedOn');
    // 23:30 in Winnipeg on 30 Sep is 1 Oct in UTC: the lock day is still 30 Sep.
    assert.equal(lockDay('timeEntries', { clockIn: '2026-10-01T04:30:00Z' }, { zone }), '2026-09-30');
    assert.equal(lockDay('timeEntries', { kind: 'correction', workDay: '2026-09-15' }, { zone }), '2026-09-15');
    assert.equal(lockDay('equipmentUse', { date: '2026-09-02' }, { zone }), '2026-09-02');
    assert.equal(lockDay('estimates', { issueDate: '2026-09-02' }, { zone }), null);
    assert.equal(zoneFor('mb'), 'America/Winnipeg');
    assert.equal(zoneFor(null), 'America/Toronto');
    assert.equal(dayIn('2026-09-30', zone), '2026-09-30');
    assert.equal(endOfLastMonth('2026-10-20'), '2026-09-30');
    assert.equal(endOfLastMonth('2026-03-05'), '2026-02-28');
    assert.equal(addDay('2026-09-30'), '2026-10-01');
  });

  test('postingFor moves late creates to the first open day and flags them', () => {
    assert.deepEqual(postingFor('timeEntries', { clockIn: '2026-09-30T20:00:00Z' }, locks(), { zone }), { postedOn: '2026-10-01', late: true });
    assert.deepEqual(postingFor('bills', { date: '2026-10-08' }, locks(), { zone }), { postedOn: '2026-10-08', late: false });
    assert.deepEqual(postingFor('payments', { date: '2026-09-30' }, locks({ booksThrough: null }), { zone }), { postedOn: '2026-09-30', late: false });
    assert.deepEqual(postingFor('payments', {}, locks(), { zone, today: '2026-10-20' }), { postedOn: '2026-10-20', late: false });
  });
});

describe('lockProblem', () => {
  const sentSept = { id: 'i1', status: 'sent', issueDate: '2026-09-20', lines: [{ qty: 1, unitCents: 100 }] };

  test('drafts are never locked: edit, re-date, delete, void', () => {
    const draft = { id: 'i2', status: 'draft', issueDate: '2026-09-20', lines: [] };
    assert.equal(lockProblem(locks(), 'invoices', draft, { ...draft, lines: [{ qty: 2 }] }, { zone }), null);
    assert.equal(lockProblem(locks(), 'invoices', draft, null, { zone }), null);
    assert.equal(lockProblem(locks(), 'invoices', draft, { ...draft, status: 'void' }, { zone }), null);
    assert.equal(lockProblem(locks(), 'invoices', draft, { ...draft, issueDate: '2026-10-20', status: 'sent' }, { zone }), null, 're-dated and sent');
    assert.equal(isLocked(locks(), 'invoices', draft, { zone }), false);
  });

  test('draft to sent is refused while the issue date is in the closed period', () => {
    const draft = { id: 'i2', status: 'draft', issueDate: '2026-09-20' };
    const p = lockProblem(locks(), 'invoices', draft, { ...draft, status: 'sent' }, { zone });
    assert.equal(p.code, 'period_locked');
    assert.match(p.message, /Re-date this invoice to today/);
    assert.equal(lockProblem(locks(), 'invoices', null, { ...draft, status: 'sent' }, { zone }).code, 'period_locked', 'a device cannot create one sent');
    // The QuickBooks import of history dated on or before QuickBooks' own close date.
    assert.equal(lockProblem(locks({ qboBookCloseDate: '2026-09-30' }), 'invoices', null, { ...draft, status: 'sent' }, { zone, actor: { type: 'system', id: 'qbo' } }), null);
    assert.equal(lockProblem(locks({ qboBookCloseDate: '2026-08-31' }), 'invoices', null, { ...draft, status: 'sent' }, { zone, actor: { type: 'system', id: 'qbo' } }).code, 'period_locked');
  });

  test('locked records: only safe fields change; deletes are refused', () => {
    assert.equal(isLocked(locks(), 'invoices', sentSept, { zone }), true);
    assert.equal(lockProblem(locks(), 'invoices', sentSept, { ...sentSept, lines: [] }, { zone }).code, 'period_locked');
    assert.match(lockProblem(locks(), 'invoices', sentSept, { ...sentSept, lines: [] }, { zone }).message, /closed period \(through 2026-09-30\)\. Record a reversal dated today instead\./);
    assert.equal(lockProblem(locks(), 'invoices', sentSept, null, { zone }).code, 'period_locked');
    assert.equal(lockProblem(locks(), 'invoices', sentSept, { ...sentSept, sentAt: '2026-10-02T00:00:00Z', payLink: 'x', updatedAt: 'later' }, { zone }), null);
    assert.equal(lockProblem(locks(), 'invoices', sentSept, { ...sentSept, holdback: { retainedByCustomerCents: 500 } }, { zone }), null, 'holdback the GC kept');
    assert.equal(lockProblem(locks(), 'invoices', { ...sentSept, holdback: { pct: 10, cents: 10 } }, { ...sentSept, holdback: { pct: 5, cents: 10 } }, { zone }).code, 'period_locked');
    assert.ok(LOCK_SAFE_FIELDS.payments.includes('stripe'));
    const pay = { id: 'p1', date: '2026-09-29', postedOn: '2026-09-29', amountCents: 100 };
    assert.equal(lockProblem(locks(), 'payments', pay, { ...pay, stripe: { feeCents: 30 } }, { zone }), null, 'the Stripe fee still lands');
    assert.equal(lockProblem(locks(), 'payments', pay, { ...pay, amountCents: 50 }, { zone }).code, 'period_locked');
    // An open record (posted after the lock) can be edited, re-dated included.
    const late = { id: 'b1', date: '2026-09-28', postedOn: '2026-10-01', lines: [] };
    assert.equal(lockProblem(locks(), 'bills', late, { ...late, date: '2026-09-25', lines: [{ qty: 1 }] }, { zone }), null);
    // Creates in posted collections are never refused.
    assert.equal(lockProblem(locks(), 'payments', null, pay, { zone }), null);
  });

  test('status moves: invoices only among sent, partial, paid; bills only open and paid (no overdue)', () => {
    assert.equal(lockProblem(locks(), 'invoices', sentSept, { ...sentSept, status: 'paid' }, { zone }), null);
    assert.equal(lockProblem(locks(), 'invoices', { ...sentSept, status: 'paid' }, { ...sentSept, status: 'partial' }, { zone }), null);
    assert.equal(lockProblem(locks(), 'invoices', sentSept, { ...sentSept, status: 'void' }, { zone }).code, 'period_locked');
    assert.equal(lockProblem(locks(), 'invoices', sentSept, { ...sentSept, status: 'draft' }, { zone }).code, 'period_locked');
    assert.equal(lockProblem(locks(), 'invoices', sentSept, { ...sentSept, status: 'overdue' }, { zone }).code, 'period_locked');
    const bill = { id: 'b', date: '2026-09-02', status: 'open' };
    assert.equal(lockProblem(locks(), 'bills', bill, { ...bill, status: 'paid' }, { zone }), null);
    assert.equal(lockProblem(locks(), 'bills', bill, { ...bill, status: 'void' }, { zone }).code, 'period_locked');
  });

  test('number is safe only for the QuickBooks push', () => {
    const noNum = { ...sentSept, number: null };
    assert.equal(lockProblem(locks(), 'invoices', noNum, { ...noNum, number: 'INV-3001' }, { zone, actor: { type: 'system', id: 'qbo' } }), null);
    assert.equal(lockProblem(locks(), 'invoices', noNum, { ...noNum, number: 'INV-3001' }, { zone, actor: { type: 'user', id: 'u' } }).code, 'period_locked');
  });

  test('change orders approved in the closed period are frozen; new ones may be added', () => {
    const job = { id: 'j', changeOrders: [{ id: 'co1', title: 'Extra pots', amountCents: 1000, approvedOn: '2026-09-15', status: 'approved' }, { id: 'co2', title: 'Later', amountCents: 5, approvedOn: '2026-10-02' }] };
    const edit = { ...job, changeOrders: [{ ...job.changeOrders[0], amountCents: 900 }, job.changeOrders[1]] };
    assert.equal(lockProblem(locks(), 'jobs', job, edit, { zone }).code, 'period_locked');
    assert.equal(lockProblem(locks(), 'jobs', job, { ...job, changeOrders: [job.changeOrders[1]] }, { zone }).code, 'period_locked', 'removed');
    assert.equal(lockProblem(locks(), 'jobs', job, { ...job, changeOrders: [job.changeOrders[0], { ...job.changeOrders[1], amountCents: 9 }] }, { zone }), null);
    assert.equal(lockProblem(locks(), 'jobs', job, { ...job, title: 'renamed', changeOrders: [...job.changeOrders, { id: 'co3', amountCents: -1000 }] }, { zone }), null);
  });

  test('payroll lock is by entry id only, approval included; the date does not lock', () => {
    const e = { id: 'e1', employeeId: 'p', clockIn: '2026-10-05T13:00:00Z', clockOut: '2026-10-05T21:00:00Z', approved: true };
    const l = locks({ booksThrough: null, payrollThrough: '2026-10-10', payrollEntryIds: new Set(['e1']), payrollEntryDates: new Map([['e1', '2026-10-12']]) });
    const p = lockProblem(l, 'timeEntries', e, { ...e, approved: false }, { zone });
    assert.equal(p.code, 'payroll_locked');
    assert.equal(p.message, 'These hours were exported to payroll on 2026-10-12. Add a correction instead.');
    assert.equal(lockProblem(l, 'timeEntries', e, null, { zone }).code, 'payroll_locked');
    assert.equal(lockProblem(l, 'timeEntries', e, { ...e, updatedAt: 'x' }, { zone }), null, 'nothing changed');
    const other = { ...e, id: 'e2', approved: false };
    assert.equal(lockProblem(l, 'timeEntries', other, { ...other, approved: true }, { zone }), null, 'same day, not in a run: editable');
    assert.equal(isLocked(l, 'timeEntries', e, { zone }), true);
    assert.equal(isLocked(l, 'timeEntries', other, { zone }), false);
  });
});

describe('PWA side', () => {
  test('locksFrom reads settings.closing and exported runs; isLateHours', () => {
    const l = locksFrom({ closing: { booksThrough: '2026-09-30', payrollThrough: '2026-10-10' } }, [
      { id: 'r1', status: 'exported', exportedAt: '2026-10-12T15:00:00Z', entryIds: ['e1'], lateEntryIds: ['e0'] },
      { id: 'r2', status: 'reopened', entryIds: ['e9'] },
    ]);
    assert.equal(l.booksThrough, '2026-09-30');
    assert.deepEqual([...l.payrollEntryIds].sort(), ['e0', 'e1']);
    assert.equal(l.payrollEntryDates.get('e1'), '2026-10-12');
    assert.equal(isLateHours({ id: 'e5', clockIn: '2026-10-09T14:00:00Z' }, l, { zone }), true);
    assert.equal(isLateHours({ id: 'e1', clockIn: '2026-10-09T14:00:00Z' }, l, { zone }), false, 'in a run');
    assert.equal(isLateHours({ id: 'e6', clockIn: '2026-10-11T14:00:00Z' }, l, { zone }), false, 'after the run');
    assert.equal(isLateHours({ id: 'c1', kind: 'correction', workDay: '2026-10-03' }, l, { zone }), true);
    assert.equal(locksFrom(null, null).booksThrough, null);
  });
});
