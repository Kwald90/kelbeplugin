// Cost codes (js/lib/cost-codes.js, docs/releases/r1-get-paid.md 2.8).
// Run: node --test electrical-app/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STANDARD_COST_CODES, costCodeLabel, activeCostCodes, defaultCostCode, missingStandardCodes, costCodeProblem } from '../js/lib/cost-codes.js';
import { clockIn, switchTo, closeEntry, setEntryJob, clockCoding } from '../js/lib/clock.js';

const codes = STANDARD_COST_CODES.map((c) => ({ ...c, active: true }));

test('the standard nine, with fixed ids and the callback code not billable', () => {
  assert.equal(STANDARD_COST_CODES.length, 9);
  assert.deepEqual(STANDARD_COST_CODES.map((c) => c.code), ['100', '200', '300', '400', '500', '600', '700', '800', '900']);
  assert.equal(new Set(STANDARD_COST_CODES.map((c) => c.id)).size, 9);
  const cb = STANDARD_COST_CODES.find((c) => c.id === 'cc-callback');
  assert.equal(cb.billable, false);
  assert.equal(cb.ownUse, 'callback');
  assert.equal(costCodeLabel(STANDARD_COST_CODES[0]), '100 Rough-in');
  assert.equal(costCodeLabel(null), 'Uncoded');
});

test('clock-in takes the phase the office set on the job, without asking', () => {
  assert.equal(defaultCostCode({ id: 'j', currentCostCodeId: 'cc-trim' }, codes), 'cc-trim');
  assert.equal(defaultCostCode({ id: 'j', currentCostCodeId: 'cc-trim' }, codes.map((c) => (c.id === 'cc-trim' ? { ...c, active: false } : c))), null, 'an inactive phase is not used');
  assert.equal(defaultCostCode({ id: 'j', kind: 'warranty' }, codes), 'cc-callback');
  assert.equal(defaultCostCode({ id: 'j', kind: 'callback', currentCostCodeId: 'cc-service' }, codes), 'cc-service', 'the phase wins');
  assert.equal(defaultCostCode({ id: 'j' }, codes), null);
  assert.equal(defaultCostCode(null, codes), null);
  assert.equal(defaultCostCode({ id: 'j', currentCostCodeId: 'cc-trim' }, []), null);
});

test('clock-in sets the cost code and the truck without asking; switching jobs follows the job', () => {
  const data = {
    jobs: new Map([['j1', { id: 'j1', currentCostCodeId: 'cc-trim' }], ['j2', { id: 'j2', kind: 'warranty' }], ['j3', { id: 'j3' }]]),
    employees: new Map([['e1', { id: 'e1', name: 'Jo', defaultEquipmentId: 'truck-7' }]]),
    costCodes: new Map(codes.map((c) => [c.id, c])), timeEntries: new Map(),
  };
  let n = 0;
  const store = {
    get: (c, id) => (data[c]?.get(id) ? structuredClone(data[c].get(id)) : null),
    list: (c, pred) => [...(data[c]?.values() || [])].filter(pred || (() => true)).map((x) => structuredClone(x)),
    add: (c, f) => { const r = { ...f, id: `r${++n}` }; data[c].set(r.id, r); return structuredClone(r); },
    update: (c, id, p) => { const r = { ...data[c].get(id), ...p }; data[c].set(id, r); return structuredClone(r); },
  };
  const e1 = clockIn(store, { employeeId: 'e1', jobId: 'j1', at: '2026-10-20T13:00:00Z' });
  assert.equal(e1.costCodeId, 'cc-trim');
  assert.equal(e1.equipmentId, 'truck-7');
  const e2 = switchTo(store, e1, { kind: 'work', jobId: 'j2', at: '2026-10-20T16:00:00Z' });
  assert.equal(e2.costCodeId, 'cc-callback', 'a warranty job takes the callback code');
  assert.equal(e2.equipmentId, 'truck-7');
  assert.equal(setEntryJob(store, e2.id, 'j3').costCodeId, null, 'a job with no phase: no code');
  closeEntry(store, e2.id, { at: '2026-10-20T20:00:00Z' });
  const e3 = clockIn(store, { employeeId: 'e1', jobId: 'j1', costCodeId: 'cc-general', equipmentId: null, at: '2026-10-21T13:00:00Z' });
  assert.equal(e3.costCodeId, 'cc-general', 'the person changed it');
  assert.equal(e3.equipmentId, null);
  assert.deepEqual(clockCoding(store, { employeeId: 'e1', jobId: 'j1' }), { costCodeId: 'cc-trim', equipmentId: 'truck-7' });
});

test('active codes sort by order; adding the standard set twice never duplicates', () => {
  const list = [{ id: 'x', code: '050', name: 'Design', order: 0 }, { id: 'y', code: '999', name: 'Old', active: false }, ...codes.slice(0, 3)];
  assert.deepEqual(activeCostCodes(list).map((c) => c.code), ['050', '100', '200', '300']);
  const missing = missingStandardCodes(list);
  assert.equal(missing.length, 6);
  assert.deepEqual(missingStandardCodes([...list, ...missing]), []);
});

test('codes are unique among active codes', () => {
  assert.equal(costCodeProblem({ id: 'n', code: '150', name: 'Rough-in L2' }, codes), null);
  assert.match(costCodeProblem({ id: 'n', code: '100', name: 'Dup' }, codes), /Another active cost code uses 100/);
  assert.equal(costCodeProblem({ id: 'n', code: '100', name: 'Dup', active: false }, codes), null, 'an inactive copy is fine');
  assert.equal(costCodeProblem({ id: 'cc-rough-in', code: '100', name: 'Rough-in' }, codes), null, 'itself');
  assert.match(costCodeProblem({ code: '', name: 'x' }), /Enter a code/);
  assert.match(costCodeProblem({ code: 'x'.repeat(21), name: 'x' }), /20 characters/);
});
