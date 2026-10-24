// Run: node --test electrical-app/tests/*.test.mjs
// Job standards: the pure builders and the idempotent apply (lib/job-standards.js, docs/releases/job-standards.md).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isStandard, regionMatch, filterStandards, visibleRequirements,
  buildWorkTasks, buildMaterialRequests, buildBreakerCircuits, buildDraftEstimate, applyStandard,
} from '../js/lib/job-standards.js';
import { docTotals } from '../js/lib/money.js';

const ITEMS = [{ id: 'wire', name: '2/0 Al teck', unit: 'm', costCents: 3000, priceCents: 5000 }];

const rtm = {
  id: 'std-rtm', title: 'RTM hookup', isStandard: true, jobType: 'RTM hookup', scale: 'service', revision: 1,
  region: { provinces: ['MB'], authority: 'Manitoba Hydro' },
  regionRequirements: [
    { province: '', text: 'Confirm the service size with the customer.' },
    { province: 'MB', text: 'Underground service disconnect ahead of the meter.' },
    { province: 'MB', authority: 'Manitoba Hydro', text: 'Manitoba Hydro meter base approval.' },
    { province: 'SK', text: 'SaskPower rule that MB jobs must not see.' },
  ],
  materials: [{ itemId: 'wire', qty: 2, unit: 'm' }, { name: 'Misc fittings', qty: 1 }],
  breakers: [{ poles: 2, amps: 100, breakerType: 'standard', qty: 1, note: 'Service disconnect' }, { poles: 1, amps: 15, breakerType: 'afci', qty: 3 }],
  panelTemplateId: 'res-200',
  specs: [{ label: 'Service', value: '100A underground' }, { label: 'Conductor', value: '2/0 Al teck' }],
  tasks: [{ title: 'Set the disconnect', estHours: 3, priority: 'high' }, { title: 'Terminate the panel', estHours: 2 }],
};
const anywhere = { id: 'std-any', title: 'Lighting', isStandard: true, jobType: 'Lighting', revision: 1, region: { provinces: [], authority: '' }, tasks: [{ title: 'Trim out', estHours: 1 }] };
const skOnly = { id: 'std-sk', title: 'Grain dryer', isStandard: true, jobType: 'Grain dryer', revision: 1, region: { provinces: ['SK'], authority: '' } };
const plain = { id: 'sop-safety', title: 'Lockout/tagout', category: 'Safety', revision: 2, steps: [{ text: 'Isolate' }] };

describe('standard identification and region matching', () => {
  test('isStandard: flag or non-empty jobType, never a plain safety SOP', () => {
    assert.equal(isStandard(rtm), true);
    assert.equal(isStandard({ id: 'x', jobType: 'Hot tub' }), true);
    assert.equal(isStandard(plain), false);
    assert.equal(isStandard({ id: 'y', jobType: '   ' }), false);
    assert.equal(isStandard(null), false);
  });

  test('regionMatch: empty provinces matches all; MB matches MB not SK; blank province matches all', () => {
    assert.equal(regionMatch(anywhere, 'MB'), true);
    assert.equal(regionMatch(anywhere, 'SK'), true);
    assert.equal(regionMatch(rtm, 'MB'), true);
    assert.equal(regionMatch(rtm, 'mb'), true, 'case-insensitive');
    assert.equal(regionMatch(rtm, 'SK'), false);
    assert.equal(regionMatch(rtm, null), true, 'all regions');
  });

  test('filterStandards: only standards, by region, with an authority sort boost', () => {
    const all = [rtm, anywhere, skOnly, plain];
    const mb = filterStandards(all, { province: 'MB' });
    assert.deepEqual(mb.map((s) => s.id).sort(), ['std-any', 'std-rtm'], 'MB sees MB + anywhere, never SK-only or the plain SOP');
    assert.deepEqual(filterStandards(all, { province: 'SK' }).map((s) => s.id).sort(), ['std-any', 'std-sk']);
    assert.equal(filterStandards(all, { province: 'MB', q: 'rtm' }).length, 1);
    const boosted = filterStandards(all, { province: null, authority: 'Manitoba Hydro' });
    assert.equal(boosted[0].id, 'std-rtm', 'the Manitoba Hydro standard sorts first');
  });

  test('visibleRequirements: province-agnostic always, province match, authority only when known', () => {
    const mb = visibleRequirements(rtm, { province: 'MB' }).map((r) => r.text);
    assert.ok(mb.includes('Confirm the service size with the customer.'));
    assert.ok(mb.includes('Underground service disconnect ahead of the meter.'));
    assert.ok(mb.includes('Manitoba Hydro meter base approval.'));
    assert.ok(!mb.some((t) => t.includes('SaskPower')), 'MB job never sees SK-only rules');
    const winnipeg = visibleRequirements(rtm, { province: 'MB', authority: 'City of Winnipeg' }).map((r) => r.text);
    assert.ok(!winnipeg.includes('Manitoba Hydro meter base approval.'), 'a different known authority hides that rule');
  });
});

describe('pure builders', () => {
  test('buildWorkTasks: one draft per task, with jobId, estHours, link and stdRef', () => {
    const tasks = buildWorkTasks(rtm, { jobId: 'job-1' });
    assert.equal(tasks.length, 2);
    assert.ok(tasks.every((t) => t.jobId === 'job-1' && t.status === 'draft'));
    assert.deepEqual(tasks[0].stdRef, { sopId: 'std-rtm', rev: 1 });
    assert.deepEqual(tasks[0].link, { sopId: 'std-rtm' });
    assert.equal(tasks[0].title, 'Set the disconnect');
    assert.equal(tasks[0].estHours, 3);
    assert.equal(tasks[0].priority, 'high');
  });

  test('buildMaterialRequests: priced from items with money, no cost without, name fallback', () => {
    const withMoney = buildMaterialRequests(rtm, { jobId: 'job-1', items: ITEMS, seesMoney: true });
    assert.equal(withMoney.length, 2);
    assert.equal(withMoney[0].description, '2/0 Al teck', 'item name fallback');
    assert.equal(withMoney[0].costCents, 6000, '3000 cost × qty 2');
    assert.equal(withMoney[0].status, 'requested');
    assert.deepEqual(withMoney[0].stdRef, { sopId: 'std-rtm', rev: 1 });
    assert.equal(withMoney[1].description, 'Misc fittings', 'typed name');
    assert.ok(!('costCents' in withMoney[1]), 'no price-book item, no cost');

    const noMoney = buildMaterialRequests(rtm, { jobId: 'job-1', items: ITEMS, seesMoney: false });
    assert.ok(noMoney.every((m) => !('costCents' in m)), 'crew never see cost');
    assert.equal(noMoney[0].description, '2/0 Al teck');
  });

  test('buildBreakerCircuits: breaker rows expand by qty into circuits', () => {
    const circuits = buildBreakerCircuits(rtm, { settings: {} });
    assert.equal(circuits.length, 4, '1 disconnect + 3 AFCI');
    assert.equal(circuits[0].amps, 100);
    assert.equal(circuits[0].poles, 2);
    assert.equal(circuits[3].breakerType, 'afci');
    assert.equal(circuits[0].slot, 1);
    assert.equal(circuits[3].slot, 4);
  });

  test('buildDraftEstimate: material lines + one labour line; docTotals adds markup and tax', () => {
    const est = buildDraftEstimate(rtm, { job: { id: 'job-1', clientId: null }, items: ITEMS, settings: { company: { province: 'MB' }, labourRateCents: 9500 } });
    assert.equal(est.status, 'draft');
    assert.equal(est.markupPct, 0);
    const labour = est.lines.filter((l) => l.kind === 'labour');
    assert.equal(labour.length, 1);
    assert.equal(labour[0].qty, 5, 'sum of estHours 3 + 2');
    assert.equal(labour[0].unitCents, 9500);
    const unpriced = est.lines.find((l) => l.description.includes('Misc fittings'));
    assert.equal(unpriced.unitCents, 0);
    assert.ok(unpriced.description.startsWith('[set price]'));
    const totals = docTotals(est);
    assert.equal(totals.subtotalCents, 57500, '10000 wire + 0 misc + 47500 labour');
    assert.equal(totals.taxCents, 6900, 'MB GST 5% + RST 7% on 57500');
    assert.equal(totals.totalCents, 64400);
  });
});

// ---------- an in-memory store, enough for applyStandard ----------
function makeStore({ settings, items = [] } = {}) {
  const data = { jobs: new Map(), workTasks: new Map(), materialRequests: new Map(), panels: new Map(), estimates: new Map(), items: new Map(items.map((i) => [i.id, i])), clients: new Map(), permits: new Map() };
  let seq = 0;
  const S = {
    _settings: settings || { company: { province: 'MB' }, labourRateCents: 9500, nextNumbers: { estimate: 1001 } },
    add(coll, fields) { const id = fields.id || `${coll}-${++seq}`; const rec = { ...fields, id, createdAt: new Date().toISOString() }; data[coll].set(id, rec); return { ...rec }; },
    update(coll, id, patch) { const cur = data[coll].get(id) || { id }; const next = { ...cur, ...patch, id }; data[coll].set(id, next); return { ...next }; },
    list(coll, pred) { const rows = [...(data[coll]?.values() || [])]; return (pred ? rows.filter(pred) : rows).map((r) => ({ ...r })); },
    get(coll, id) { return data[coll]?.has(id) ? { ...data[coll].get(id) } : null; },
    settings() { return this._settings; },
    nextNumber(kind) { const n = this._settings.nextNumbers[kind]++; return `E-${n}`; },
  };
  return { S, data };
}

describe('applyStandard: writes records, idempotent per job+sop, money-gated', () => {
  const ctx = (S, seesMoney = true) => ({ store: S, auth: { seesMoney: () => seesMoney, who: () => ({ name: 'Office' }) }, ui: { today: () => '2026-10-23' } });

  test('first apply seeds everything; a second apply adds nothing', () => {
    const { S, data } = makeStore({ items: ITEMS });
    const job = S.add('jobs', { id: 'job-1', number: 'J-1001', clientId: null });
    const first = applyStandard(ctx(S), job, rtm, { createPanel: true, buildEstimate: true });
    assert.equal(first.addedTasks, 2);
    assert.equal(first.addedMaterials, 2);
    assert.equal(first.panel, 'added');
    assert.equal(first.estimate, 'added');
    assert.equal(data.workTasks.size, 2);
    assert.equal(data.materialRequests.size, 2);
    assert.equal(data.panels.size, 1);
    assert.equal(data.estimates.size, 1);
    assert.equal(S.get('jobs', 'job-1').appliedStandards.length, 1);

    const second = applyStandard(ctx(S), S.get('jobs', 'job-1'), rtm, { createPanel: true, buildEstimate: true });
    assert.equal(second.addedTasks, 0);
    assert.equal(second.skippedTasks, 2);
    assert.equal(second.addedMaterials, 0);
    assert.equal(second.skippedMaterials, 2);
    assert.equal(second.panel, 'skipped');
    assert.equal(second.estimate, 'skipped');
    assert.equal(data.workTasks.size, 2, 'no duplicate tasks');
    assert.equal(data.materialRequests.size, 2, 'no duplicate materials');
    assert.equal(data.panels.size, 1);
    assert.equal(data.estimates.size, 1);
    assert.equal(S.get('jobs', 'job-1').appliedStandards.length, 1, 'applied-standard link de-duplicated by sopId');
  });

  test('a bumped revision adds only the new task', () => {
    const { S, data } = makeStore({ items: ITEMS });
    const job = S.add('jobs', { id: 'job-2', number: 'J-1002', clientId: null });
    applyStandard(ctx(S), job, rtm, {});
    assert.equal(data.workTasks.size, 2);
    const v2 = { ...rtm, revision: 2, tasks: [...rtm.tasks, { title: 'Label the panel', estHours: 1 }] };
    const res = applyStandard(ctx(S), S.get('jobs', 'job-2'), v2, {});
    assert.equal(res.addedTasks, 1);
    assert.equal(res.skippedTasks, 2);
    assert.equal(data.workTasks.size, 3);
  });

  test('money gate: no cost on materials and the estimate is blocked when seesMoney is false', () => {
    const { S, data } = makeStore({ items: ITEMS });
    const job = S.add('jobs', { id: 'job-3', number: 'J-1003', clientId: null });
    const res = applyStandard(ctx(S, false), job, rtm, { createPanel: true, buildEstimate: true });
    assert.equal(res.estimate, 'blocked');
    assert.equal(data.estimates.size, 0, 'no estimate for a crew role');
    assert.equal(res.addedMaterials, 2);
    assert.ok([...data.materialRequests.values()].every((m) => !('costCents' in m)), 'crew material requests carry no cost');
    assert.equal(res.panel, 'added', 'the breaker list itself is crew-safe');
  });
});
