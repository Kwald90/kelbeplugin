// Module switches (js/lib/modules.js): what shows when a company turns modules off.
// Run: node --test electrical-app/tests/*.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../js/lib/modules.js';
import { COLLECTIONS } from '../js/store.js';
import { FEATURE_PLAN } from '../js/plans.js';
import { detectSteps } from '../js/modules/onboarding.js';
import { DEFAULT_SETTINGS } from '../js/store.js';

const withModules = (modules) => ({ modules });

describe('module switches', () => {
  test('a company from before switches (no settings.modules) has everything on', () => {
    for (const s of [undefined, null, {}, { modules: null }]) {
      for (const sw of M.SWITCHES) assert.equal(M.switchOn(s, sw.id), true, sw.id);
      assert.equal(M.moduleOn(s, 'invoices'), true);
      assert.equal(M.blockingSwitch(s, 'invoices'), null);
    }
  });

  test('new companies start with the recommended core set: less on by default', () => {
    const s = { modules: { ...DEFAULT_SETTINGS.modules } };
    assert.equal(M.presetOf(s), 'core');
    for (const id of ['schedule', 'drawings', 'estimates', 'invoices', 'time', 'materials', 'pricebook']) assert.ok(M.switchOn(s, id), id);
    for (const id of ['leads', 'sequences', 'workplan', 'bending', 'panels', 'wireruns', 'inventory', 'assistant', 'sops', 'compliance']) assert.equal(M.switchOn(s, id), false, id);
    assert.ok(M.SWITCHES.filter((sw) => M.switchOn(s, sw.id)).length < M.SWITCHES.length / 2 + 4, 'core is a short list');
  });

  test('a switch added later takes its default; known switches keep the stored value', () => {
    const s = withModules({ invoices: false });
    assert.equal(M.switchOn(s, 'invoices'), false);
    assert.equal(M.switchOn(s, 'estimates'), true, 'core default');
    assert.equal(M.switchOn(s, 'leads'), false, 'not core');
    assert.equal(M.switchOn(s, 'no-such-switch'), true);
  });

  test('simple mode: jobs, schedule, time, drawings, estimates, invoices only', () => {
    const s = withModules(M.presetModules('simple'));
    const on = M.SWITCHES.filter((sw) => M.switchOn(s, sw.id)).map((sw) => sw.id).sort();
    assert.deepEqual(on, ['drawings', 'estimates', 'invoices', 'schedule', 'time']);
    assert.equal(M.presetOf(s), 'simple');
    // Screens: jobs and the dashboard can't be turned off; everything else outside the set is hidden.
    for (const id of ['jobs', 'dashboard', 'settings', 'schedule', 'time', 'drawings', 'estimates', 'invoices', 'help', 'billing', 'notifications']) assert.ok(M.moduleOn(s, id), id);
    for (const id of ['leads', 'sequences', 'inventory', 'materials', 'panels', 'bending', 'wireruns', 'safety', 'workplan', 'today', 'kpis', 'assistant', 'clients', 'employees']) assert.equal(M.moduleOn(s, id), false, id);
  });

  test('inventory: the screen stays for the price book alone; stock needs its own switch', () => {
    assert.ok(M.moduleOn(withModules({ inventory: false, pricebook: true }), 'inventory'));
    assert.ok(M.moduleOn(withModules({ inventory: true, pricebook: false }), 'inventory'));
    assert.equal(M.moduleOn(withModules({ inventory: false, pricebook: false }), 'inventory'), false);
  });

  test('turning inventory and invoicing off hides their links, and turning them on brings them back', () => {
    const off = withModules(M.nextModules(null, { inventory: false, pricebook: false, invoices: false }));
    for (const href of ['#/invoices', '#/invoices/abc', '#/invoices/new?jobId=j1', '#/inventory/stock', '#/inventory?low=1']) assert.equal(M.linkOn(off, href), false, href);
    for (const href of ['#/jobs/j1', '#/estimates/new', '#/dashboard', 'https://maps.apple.com/?q=x', 'mailto:a@b.ca', '', null]) assert.ok(M.linkOn(off, href), String(href));
    const back = withModules(M.nextModules(off, { inventory: true, pricebook: true, invoices: true }));
    assert.ok(M.linkOn(back, '#/invoices/abc') && M.linkOn(back, '#/inventory'));
    assert.equal(M.presetOf(back), 'all', 'everything on again');
  });

  test('nextModules writes every switch explicitly, so later defaults never flip a company', () => {
    const m = M.nextModules(withModules({ leads: true }), { invoices: false, bogus: true });
    assert.deepEqual(Object.keys(m).sort(), M.SWITCHES.map((s) => s.id).sort());
    assert.equal(m.leads, true);
    assert.equal(m.invoices, false);
    assert.equal(m.bogus, undefined);
  });

  test('writes are blocked by the switch that owns the collection; shared collections never are', () => {
    const s = withModules(M.nextModules(null, { invoices: false, inventory: false, materials: false }));
    assert.equal(M.blockingSwitch(s, 'invoices'), 'invoices');
    assert.equal(M.blockingSwitch(s, 'payments'), 'invoices');
    assert.equal(M.blockingSwitch(s, 'stockMoves'), 'inventory');
    assert.equal(M.blockingSwitch(s, 'items'), null, 'the price book is still on');
    assert.equal(M.blockingSwitch(s, 'materialRequests'), 'materials');
    for (const c of ['jobs', 'clients', 'settings', 'employees', 'outbox', 'auditLog']) assert.equal(M.blockingSwitch(s, c), null, c);
    assert.match(M.turnedOffMessage('invoices'), /Invoices is turned off.*Settings → Modules/);
  });

  test('every collection the switches name exists, and every switch names real screens', () => {
    for (const c of Object.keys(M.COLLECTION_SWITCHES)) assert.ok(COLLECTIONS.includes(c), c);
    for (const ids of Object.values(M.COLLECTION_SWITCHES)) for (const id of ids) assert.ok(M.SWITCH_BY_ID[id], id);
    // The purchasing screen's plan entry comes with plans.js (QuickBooks contract 12.2, merged first);
    // until then only it may be missing, and once plans.js has it the full check applies again.
    const planPending = Object.hasOwn(FEATURE_PLAN, 'purchasing') ? [] : ['purchasing'];
    for (const sw of M.SWITCHES) for (const m of sw.modules) assert.ok(Object.hasOwn(FEATURE_PLAN, m) || planPending.includes(m), `${sw.id} → ${m}`);
    assert.equal(new Set(M.SWITCHES.map((s) => s.id)).size, M.SWITCHES.length);
    for (const g of new Set(M.SWITCHES.map((s) => s.group))) assert.ok(M.SWITCH_GROUPS.some((x) => x.id === g), g);
  });

  test('hrefModule reads the route', () => {
    assert.equal(M.hrefModule('#/invoices/abc?x=1'), 'invoices');
    assert.equal(M.hrefModule('#invoices'), 'invoices');
    assert.equal(M.hrefModule('https://x'), null);
  });

  test('onboarding leaves out steps for turned-off modules', () => {
    const facts = (modules) => ({ settings: { ...DEFAULT_SETTINGS, modules }, synced: false, items: 0, jobs: 0, planSets: 0, employees: 1, server: null });
    const all = detectSteps(facts(null)).map((s) => s.id);
    assert.ok(all.includes('pricebook') && all.includes('plans') && all.includes('connect'));
    const few = detectSteps(facts(M.nextModules(null, { inventory: false, pricebook: false, drawings: false, integrations: false }))).map((s) => s.id);
    assert.ok(!few.includes('pricebook') && !few.includes('plans') && !few.includes('connect'));
    assert.ok(few.includes('job') && few.includes('company'));
  });
});
