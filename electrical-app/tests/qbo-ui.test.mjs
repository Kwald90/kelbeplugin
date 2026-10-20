// QuickBooks in the PWA (docs/integrations/quickbooks.md section 8, W4): badge words and actions,
// status to text, who sees QuickBooks, mfa_required, the in-memory status cache (nothing stored on
// the device), tax situations and code fits, the "Why no tax?" rule, wizard helpers and the API
// wrapper (look-up terms in the body, never the URL).
// Run: node --test electrical-app/tests/*.test.mjs
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Q from '../js/lib/qbo-ui.js';
import { qboApi, query } from '../js/lib/qbo-api.js';
import { taxComponents } from '../js/lib/tax.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const ENT = (features) => ({ plan: 'pro', features });

describe('who sees QuickBooks', () => {
  const can = (role) => (p) => p === 'invoices' && ['owner', 'admin', 'office'].includes(role);
  const ent = ENT(['quickbooks', 'invoices']);

  test('office roles on a plan with QuickBooks, signed in', () => {
    for (const role of ['owner', 'admin', 'office']) assert.equal(Q.qboAllowed({ synced: true, role, can: can(role), entitlements: ent }), true, role);
  });

  test('field roles, crew sessions and the demo never do', () => {
    for (const role of ['foreman', 'electrician', 'apprentice']) assert.equal(Q.qboAllowed({ synced: true, role, can: can(role), entitlements: ent }), false, role);
    assert.equal(Q.qboAllowed({ synced: true, role: 'owner', crew: true, can: can('owner'), entitlements: ent }), false, 'crew PIN session');
    assert.equal(Q.qboAllowed({ synced: false, role: 'owner', can: can('owner'), entitlements: ent }), false, 'demo');
    assert.equal(Q.qboAllowed({ synced: true, role: 'office', can: () => false, entitlements: ent }), false, 'no invoices permission');
  });

  test('the plan (with HQ overrides, as /me lists them) decides; the module screen can skip it', () => {
    assert.equal(Q.qboAllowed({ synced: true, role: 'owner', can: can('owner'), entitlements: ENT(['invoices']) }), false);
    assert.equal(Q.qboAllowed({ synced: true, role: 'owner', can: can('owner'), entitlements: null }), false);
    assert.equal(Q.qboAllowed({ synced: true, role: 'owner', can: can('owner'), entitlements: null, plan: false }), true);
    assert.equal(Q.planHasQuickBooks(ENT(['quickbooks'])), true);
  });

  test('allowedFor reads a screen ctx', () => {
    const ctx = (role, features = ['quickbooks'], synced = true) => ({
      auth: { synced, role: () => role, isCrew: () => false, can: (p) => p === 'invoices' && Q.QBO_ROLES.includes(role) },
      app: { session: { me: { entitlements: ENT(features) } } },
    });
    assert.equal(Q.allowedFor(ctx('office')), true);
    assert.equal(Q.allowedFor(ctx('foreman')), false);
    assert.equal(Q.allowedFor(ctx('office', [])), false);
    assert.equal(Q.allowedFor(ctx('office', ['quickbooks'], false)), false);
    assert.equal(Q.allowedFor({}), false);
  });

  test('badges are null (not an empty host) for people who cannot use QuickBooks', () => {
    const ctx = { auth: { synced: true, role: () => 'foreman', isCrew: () => false, can: () => false }, app: { session: { me: { entitlements: ENT(['quickbooks']) } } }, ui: {} };
    assert.equal(Q.qboBadge(ctx, 'timeEntries', 't1'), null);
    assert.equal(Q.lookupAction(ctx, { entity: 'customers' }), null);
    const office = { ...ctx, auth: { ...ctx.auth, role: () => 'office', can: () => true } };
    assert.equal(Q.qboBadge(office, 'notACollection', 'x'), null);
    assert.equal(Q.qboBadge(office, 'invoices', ''), null);
  });
});

describe('badges (8.5)', () => {
  test('every link state has its words from contract 3.4', () => {
    const cases = [
      [{ state: 'pending' }, 'Sending to QuickBooks', 'info'],
      [{ state: 'synced' }, 'In QuickBooks', 'success'],
      [{ state: 'synced', owner: 'quickbooks' }, 'Edit in QuickBooks', 'info'],
      [{ state: 'conflict' }, 'Needs a decision', 'warning'],
      [{ state: 'error', reason: 'tax_mismatch' }, 'Not in QuickBooks', 'danger'],
      [{ state: 'blocked', reason: 'tax_reason' }, 'Waiting: pick why this has no tax', 'warning'],
      [{ state: 'blocked', reason: 'dependency' }, 'Waiting: another record goes first', 'warning'],
      [{ state: 'blocked', reason: 'no_invoice' }, 'Not sent: no invoice', 'neutral'],
      [{ state: 'blocked', reason: 'totals_mismatch' }, "Bill total doesn't add up", 'warning'],
      [{ state: 'blocked', reason: 'something_new' }, 'Waiting', 'warning'],
      [{ state: 'needs_review', reason: 'origin' }, 'Check in QuickBooks', 'warning'],
      [{ state: 'deleted_remote' }, 'Removed in QuickBooks', 'neutral'],
      [{ state: 'unlinked' }, 'Not linked to QuickBooks', 'neutral'],
    ];
    for (const [rs, text, tone] of cases) {
      const b = Q.badgeFor(rs);
      assert.equal(b.text, text, JSON.stringify(rs));
      assert.equal(b.tone, tone, JSON.stringify(rs));
    }
    assert.equal(Q.badgeFor(null), null);
    assert.equal(Q.badgeFor({ state: 'deleted_local' }), null, 'the record is gone');
  });

  test('a record on the "Doesn\'t match" list says so', () => {
    const b = Q.badgeFor({ state: 'synced' }, { mismatch: { fishtapeCents: 100, quickbooksCents: 101 } });
    assert.equal(b.text, "Doesn't match QuickBooks");
    assert.equal(b.tone, 'danger');
    assert.equal(Q.badgeFor({ state: 'unlinked' }, { mismatch: {} }).text, 'Not linked to QuickBooks');
  });

  test('sheet actions follow the state', () => {
    assert.deepEqual(Q.badgeActions({ state: 'unlinked' }, { collection: 'invoices' }), ['asNew', 'link'], 'tombstone: send as new or link');
    assert.ok(Q.badgeActions({ state: 'needs_review', reason: 'origin', conflictId: 'c1' }, { collection: 'payments' }).includes('approve'), 'approve and send');
    assert.ok(Q.badgeActions({ state: 'needs_review', reason: 'filed_period', conflictId: 'c1' }, { collection: 'invoices' }).includes('conflict'));
    const err = Q.badgeActions({ state: 'error', reason: 'duplicate_number' }, { collection: 'invoices', url: 'https://app.sandbox.qbo.intuit.com/app/invoice?txnId=1' });
    for (const a of ['open', 'retry', 'renumber', 'unlink']) assert.ok(err.includes(a), a);
    assert.ok(!Q.badgeActions({ state: 'error', reason: 'duplicate_number' }, { collection: 'clients' }).includes('renumber'), 'only documents renumber');
    assert.ok(!Q.badgeActions({ state: 'blocked', reason: 'no_invoice' }, { collection: 'payments' }).includes('retry'));
    assert.deepEqual(Q.badgeActions(null, { collection: 'invoices', record: { status: 'draft' } }), ['sendNow'], 'Send to QuickBooks now for a draft');
    assert.deepEqual(Q.badgeActions(null, { collection: 'invoices', record: { status: 'sent' } }), []);
    assert.ok(Q.badgeActions({ state: 'deleted_remote' }, { collection: 'timeEntries' }).includes('asNew'), 'Send to QuickBooks again');
  });

  test('reason words for the sheet', () => {
    assert.match(Q.reasonText({ state: 'needs_review', reason: 'filed_period' }), /GST period already filed/);
    assert.match(Q.reasonText({ state: 'needs_review', reason: 'payroll_locked' }), /Hours already paid/);
    assert.match(Q.reasonText({ state: 'blocked', reason: 'books_closed' }), /books closed/);
    assert.equal(Q.reasonText({ state: 'synced' }), '');
  });
});

describe('status to text (8.2)', () => {
  test('every connection state gets its card', () => {
    assert.equal(Q.overviewKind(null), 'loading');
    assert.equal(Q.overviewKind({ available: false, state: 'not_connected' }), 'unavailable');
    assert.equal(Q.overviewKind({ available: true, plan: { entitled: false }, state: 'active' }), 'plan');
    for (const s of ['not_connected', 'setup', 'active', 'paused', 'reconnect_needed', 'disconnected']) assert.equal(Q.overviewKind({ available: true, plan: { entitled: true }, state: s }), s);
    assert.equal(Q.overviewKind({ available: true, state: 'weird' }), 'not_connected');
  });

  test('badges show only while the connection is active (shadow mode included)', () => {
    assert.equal(Q.connectionActive({ available: true, plan: { entitled: true }, state: 'active', writeMode: 'shadow' }), true);
    for (const s of ['setup', 'paused', 'reconnect_needed', 'disconnected', 'not_connected']) assert.equal(Q.connectionActive({ available: true, state: s }), false, s);
    assert.equal(Q.connectionActive({ available: false, state: 'active' }), false);
  });

  test('pause reasons: HQ never offers Resume; the brake asks for a count', () => {
    assert.deepEqual(Q.pauseInfo({ pauseReason: 'hq' }), { reason: 'hq', text: 'Paused by Fishtape support.', canResume: false, needsUpgrade: false, brake: false });
    assert.equal(Q.pauseInfo({ pauseReason: 'user' }).canResume, true);
    assert.equal(Q.pauseInfo({ pauseReason: 'plan' }).needsUpgrade, true);
    assert.equal(Q.pauseInfo({ pauseReason: 'brake' }).brake, true);
    for (const r of ['budget', 'tenant_budget', 'plan']) assert.equal(Q.pauseInfo({ pauseReason: r }).canResume, false, r);
    assert.equal(Q.brakeCount({ details: { count: 742 } }), 742);
    assert.equal(Q.brakeCount({}), null);
  });

  test('connect results and reconnect reasons in words', () => {
    assert.equal(Q.connectResultText('ok').title, 'QuickBooks is connected');
    assert.match(Q.connectResultText('realm_in_use').text, /another Fishtape company/);
    assert.match(Q.connectResultText('purge_required').text, /Delete them first/);
    assert.equal(Q.connectResultText('made_up').title, 'Something went wrong');
    assert.match(Q.reconnectText('environment'), /different QuickBooks environment/);
    assert.equal(Q.reconnectText('nope'), 'Reconnect to QuickBooks.');
  });

  test('counts become links, zeros left out', () => {
    const links = Q.countLinks({ pending: 0, error: 2, blocked: 1, conflict: 0, needsReview: 3, mismatch: 1, waitingOffline: 0 });
    assert.deepEqual(links.map((l) => [l.key, l.n]), [['error', 2], ['blocked', 1], ['needsReview', 3], ['mismatch', 1]]);
    assert.equal(links.find((l) => l.key === 'error').href, '#/quickbooks/activity?outcome=error');
    assert.deepEqual(Q.countLinks(undefined), []);
  });
});

describe('errors and two-step sign-in (7.1)', () => {
  test('mfa_required tells the person what to do, whatever the role', () => {
    const e = { status: 403, code: 'mfa_required', message: 'Turn on two-step sign-in to change QuickBooks data.', details: { mfa: 'enrol', link: '#/account' } };
    assert.equal(Q.isMfaError(e), true);
    assert.equal(Q.errorText(e), 'Turn on two-step sign-in to change QuickBooks data.');
    assert.equal(Q.isMfaError({ code: 'mfa_enrolment_required' }), true);
    assert.equal(Q.isMfaError({ code: 'forbidden' }), false);
  });

  test('other codes in words', () => {
    assert.match(Q.errorText({ code: 'qbo_throttled', details: { retryAfterS: 300 } }), /5 minutes/);
    assert.match(Q.errorText({ code: 'qbo_throttled', details: { retryAfterS: 30 } }), /30 seconds/);
    assert.match(Q.errorText({ code: 'offline', status: 0 }), /offline/);
    assert.match(Q.errorText({ code: 'lookup_budget' }), /Look-ups are off/);
    assert.match(Q.errorText({ code: 'qbo_unavailable', status: 503 }), /isn't available on this server/);
    assert.match(Q.errorText({ code: 'qbo_unavailable', status: 502 }), /isn't answering/);
    assert.match(Q.errorText({ code: 'qbo_busy' }), /busy/);
    assert.equal(Q.errorText({ code: 'x', message: 'Server words' }), 'Server words');
  });
});

describe('nothing from QuickBooks is stored on the device (8.7)', () => {
  const touched = [];
  const spy = (name) => new Proxy({}, { get: (_, k) => { touched.push(`${name}.${String(k)}`); return () => null; } });
  let saved;
  beforeEach(() => {
    touched.length = 0;
    saved = { localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage, indexedDB: globalThis.indexedDB };
    for (const k of Object.keys(saved)) Object.defineProperty(globalThis, k, { value: spy(k), configurable: true, writable: true });
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  });

  const fakeApi = () => {
    const calls = [];
    return {
      calls,
      status: async () => { calls.push('status'); return { available: true, plan: { entitled: true }, state: 'active', counts: { mismatch: 1 } }; },
      recordsStatus: async (c) => { calls.push(`records:${c}`); return { data: { 'inv-1': { state: 'synced', docNumber: 'INV-3001' } } }; },
      checks: async () => { calls.push('checks'); return { data: [{ collection: 'invoices', recordId: 'inv-2', fishtapeCents: 100, quickbooksCents: 99 }] }; },
    };
  };

  test('the status cache keeps everything in memory and never touches browser storage', async () => {
    let now = 1000;
    const api = fakeApi();
    const cache = Q.createStatusCache({ api, now: () => now });
    const a = await cache.recordState('invoices', 'inv-1');
    assert.equal(a.state.state, 'synced');
    const b = await cache.recordState('invoices', 'inv-2');
    assert.equal(b.state, null);
    assert.equal(b.mismatch.quickbooksCents, 99);
    assert.deepEqual(api.calls, ['status', 'records:invoices', 'checks'], 'one call per kind per 30 seconds');
    now += 31_000;
    await cache.recordState('invoices', 'inv-1');
    assert.equal(api.calls.filter((c) => c === 'records:invoices').length, 2, 'refreshed after 30 seconds');
    cache.clear();
    assert.equal(cache.size(), 0);
    assert.deepEqual(touched, [], `browser storage touched: ${touched.join(', ')}`);
  });

  test('no badge data unless the connection is active; failures are not cached', async () => {
    let fail = true;
    const api = {
      status: async () => { if (fail) throw Object.assign(new Error('x'), { code: 'offline' }); return { available: true, state: 'paused' }; },
      recordsStatus: async () => { throw new Error('must not be called'); },
      checks: async () => ({ data: [] }),
    };
    const cache = Q.createStatusCache({ api });
    await assert.rejects(cache.recordState('invoices', 'x'));
    fail = false;
    assert.equal(await cache.recordState('invoices', 'x'), null, 'paused: nothing to show');
  });

  test('QuickBooks code in the PWA never uses browser storage or the record store for QuickBooks data', () => {
    for (const f of ['../js/lib/qbo-ui.js', '../js/lib/qbo-api.js', '../js/modules/quickbooks.js']) {
      const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB|setMeta\(|store\.(add|update|saveSettings)\(/, f);
    }
  });
});

describe('tax situations, code fits and "Why no tax?" (4.8, 8.4, 8.5)', () => {
  test('a Manitoba company has GST + RST, GST only and the four no-tax reasons', () => {
    const keys = Q.companyTaxKeys('MB', '2026-10-20');
    for (const k of ['GST+RST|MB', 'GST', 'NONE|ZERO', 'NONE|EXEMPT', 'NONE|OOS', 'NONE|RELIEF']) assert.ok(keys.includes(k), k);
    assert.ok(!keys.includes('NONE'), 'a reason is always picked');
    assert.equal(Q.taxKeyLabel('GST+RST|MB', 'MB'), 'GST + Manitoba RST');
    assert.equal(Q.taxKeyLabel('GST', 'MB'), 'GST only (customer has an RST number)');
    assert.equal(Q.taxKeyLabel('GST', 'AB'), 'GST');
    assert.equal(Q.taxKeyLabel('HST|ON', 'MB'), 'HST (Ontario)');
    assert.equal(Q.taxKeyLabel('NONE|RELIEF'), 'No tax: Indian Act relief');
    assert.equal(Q.taxKeyLabel('NONE|OOS'), 'No tax: out of scope');
    assert.match(Q.taxKeyLabel('TAX'), /Old single tax rate/);
    assert.deepEqual(Q.companyPurchaseKeys('MB', '2026-10-20'), ['GST+RST|MB', 'GST', 'NONE', 'stripeFee']);
    assert.match(Q.purchaseKeyLabel('GST+RST|MB', 'MB'), /RST added to cost/);
  });

  test('codes are picked by rates, never by name: the old 8% PST code is refused', () => {
    const good = { id: '1', name: 'GST/PST MB', active: true, salesRates: [{ name: 'GST', pct: 5 }, { name: 'PST MB', pct: 7 }] };
    const old = { id: '2', name: 'GST/PST MB (old)', active: true, salesRates: [{ name: 'GST', pct: 5 }, { name: 'PST MB', pct: 8 }] };
    const zero = { id: '3', name: 'Zero-rated', active: true, salesRates: [{ name: 'GST ZR', pct: 0 }] };
    assert.deepEqual(Q.taxCodeFit('GST+RST|MB', good, { date: '2026-10-20' }), { ok: true, reason: null });
    const bad = Q.taxCodeFit('GST+RST|MB', old, { date: '2026-10-20' });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'QuickBooks code GST/PST MB (old) charges 5% + 8%; Fishtape charges 5% + 7%.');
    assert.equal(Q.taxCodeFit('NONE|ZERO', zero).ok, true);
    assert.equal(Q.taxCodeFit('NONE|ZERO', good).ok, false);
    assert.equal(Q.taxCodeFit('GST', { ...good, active: false }).ok, false);
    assert.equal(Q.taxCodeFit('TAX', old).ok, true, 'the legacy key accepts any code');
    assert.equal(Q.codeOptionLabel(good), 'GST/PST MB · 5% + 7%');
  });

  test('purchase codes may not claim PST or RST', () => {
    const claims = { id: '4', name: 'GST/PST MB', active: true, purchaseRates: [{ name: 'GST', pct: 5 }, { name: 'PST MB', pct: 7 }] };
    const gstOnly = { id: '5', name: 'GST', active: true, purchaseRates: [{ name: 'GST', pct: 5 }] };
    assert.equal(Q.purchaseCodeFit('GST+RST|MB', claims).ok, false);
    assert.match(Q.purchaseCodeFit('GST+RST|MB', claims).reason, /added to the cost/);
    assert.equal(Q.purchaseCodeFit('GST+RST|MB', gstOnly).ok, true);
    assert.equal(Q.purchaseCodeFit('GST', claims).ok, true);
  });

  test('"Why no tax?" shows for the No tax treatment and for any untaxed line kind, never for GST only', () => {
    const doc = (treatment, province = 'MB', lines = [{ kind: 'material' }, { kind: 'labour' }]) => ({ taxTreatment: treatment, taxProvince: province, taxes: taxComponents({ province, treatment, date: '2026-10-20' }), lines });
    assert.equal(Q.needsNoTaxReason(doc('none')), true);
    assert.equal(Q.needsNoTaxReason(doc('none', 'MB', [])), true, 'even before lines');
    assert.equal(Q.needsNoTaxReason(doc('gst-only')), false, 'GST is still charged');
    assert.equal(Q.needsNoTaxReason(doc('pst-all')), false);
    const custom = { taxTreatment: 'custom', taxes: [{ id: 'GST', pct: 5, applies: { material: true, labour: false, other: true } }], lines: [{ kind: 'labour' }] };
    assert.deepEqual(Q.noTaxKinds(custom), ['labour']);
    assert.equal(Q.needsNoTaxReason(custom), true);
    assert.equal(Q.needsNoTaxReason({ taxPct: 5, lines: [] }), false, 'an old single-rate document');
    assert.deepEqual(Q.TAX_NONE_REASONS.map((r) => r.id), ['zero', 'exempt', 'out_of_scope', 'relief']);
    assert.equal(Q.noneKeyFor('out_of_scope'), 'NONE|OOS');
    assert.equal(Q.noneKeyFor(null), 'NONE');
  });

  test('settlement payments are recognised (read-only on invoices)', () => {
    assert.equal(Q.isSettlementPayment({ method: 'credit', source: 'quickbooks' }), true);
    assert.equal(Q.isSettlementPayment({ method: 'credit', source: 'stripe' }), false);
    assert.equal(Q.isSettlementPayment({ method: 'cheque' }), false);
    assert.equal(Q.SETTLEMENT_LABEL, 'Credited or paid in QuickBooks');
  });
});

describe('wizard and mappings helpers (6, 8.3, 8.4)', () => {
  const cand = (o) => ({ id: 'c', kind: 'customers', choice: 'link', diffs: [], fieldChoices: {}, ...o });

  test('Apply waits until every difference on linked customers, jobs, products and suppliers has a side', () => {
    const cands = [
      cand({ id: 'a', diffs: [{ field: 'phone' }, { field: 'address' }], fieldChoices: { phone: 'fishtape' } }),
      cand({ id: 'b', kind: 'items', diffs: [{ field: 'name' }], fieldChoices: { name: 'quickbooks' } }),
      cand({ id: 'c', kind: 'invoices', diffs: [{ field: 'lines' }] }),
      cand({ id: 'd', choice: 'skip', diffs: [{ field: 'email' }] }),
    ];
    assert.deepEqual(Q.undecidedDiffs(cands).map((x) => `${x.cand.id}.${x.field}`), ['a.address'], 'documents go to review instead; skipped ones need nothing');
    assert.deepEqual(Q.applyReady({ cands }), { ok: false, why: '1 difference still to decide.' });
    cands[0].fieldChoices.address = 'quickbooks';
    assert.deepEqual(Q.applyReady({ cands }), { ok: true, why: null });
    assert.equal(Q.applyReady({ cands, plan: { warnings: [{ code: 'differences', count: 2 }] } }).ok, false, 'the plan has the last word');
  });

  test('choices per kind; possible duplicates and filed-period creates', () => {
    assert.deepEqual(Q.choicesFor('employees', { fishtapeId: 'e1', qboId: '55' }), ['link', 'skip']);
    assert.deepEqual(Q.choicesFor('employees', { fishtapeId: 'e1' }), ['skip']);
    assert.deepEqual(Q.choicesFor('customers', { fishtapeId: 'c1', qboId: '58' }), ['link', 'create_in_qbo', 'create_in_fishtape', 'skip']);
    assert.deepEqual(Q.choicesFor('invoices', { fishtapeId: 'i1' }), ['create_in_qbo', 'skip']);
    assert.equal(Q.isPossibleDuplicate({ reasons: ['possible_duplicate'] }), true);
    assert.equal(Q.needsFiledTick({ choice: 'create_in_qbo', needsConfirm: true }), true);
    assert.equal(Q.needsFiledTick({ choice: 'create_in_qbo', reasons: ['filed_period'] }), true);
    assert.equal(Q.needsFiledTick({ choice: 'skip', needsConfirm: true }), false);
    assert.equal(Q.MATCH_FILTERS.find((f) => f.id === 'duplicates').test({ reasons: ['possible_duplicate'] }), true);
  });

  test('settings: the payroll question must be answered when time syncs', () => {
    const d = Q.optionDefaults({ today: new Date('2026-10-20T12:00:00'), features: { customTxnNumbers: false } });
    assert.equal(d.syncFrom, '2026-10-01');
    assert.equal(d.numbering, 'quickbooks', 'custom numbers off in QuickBooks');
    assert.equal(d.writeMode, 'live');
    assert.deepEqual(Q.settingsProblems(d), ['Say which system holds payroll hours.']);
    assert.deepEqual(Q.settingsProblems({ ...d, timeOwner: 'fishtape' }), []);
    assert.deepEqual(Q.settingsProblems({ ...d, syncTime: false }), []);
  });

  test('mapping changes become the PUT body', () => {
    const before = { taxCode: { 'GST+RST|MB': '1', GST: '2' }, option: { syncFrom: '2026-10-01' } };
    const after = { taxCode: { 'GST+RST|MB': '1', GST: null, 'NONE|EXEMPT': '7' }, option: { syncFrom: '2026-10-01', writeMode: 'shadow' } };
    assert.deepEqual(Q.mappingDiff(before, after), {
      set: [{ kind: 'taxCode', key: 'NONE|EXEMPT', value: '7' }, { kind: 'option', key: 'writeMode', value: 'shadow' }],
      remove: [{ kind: 'taxCode', key: 'GST' }],
    });
    assert.deepEqual([...Q.requiredSet([{ kind: 'item', key: 'material' }, 'taxCode.GST'])], ['item.material', 'taxCode.GST']);
  });
});

describe('the API wrapper (section 7)', () => {
  let calls, savedFetch;
  beforeEach(() => {
    calls = [];
    savedFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
  });
  afterEach(() => { globalThis.fetch = savedFetch; });

  test('look-up search terms go in the body, never the URL', async () => {
    await qboApi.lookup('customers', { q: "O'Brien Electric", limit: 25 });
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, '/api/v1/qbo/lookup/customers');
    assert.doesNotMatch(calls[0].url, /Brien/);
    assert.equal(calls[0].body.q, "O'Brien Electric");
    assert.equal(calls[0].headers['X-Fishtape'], '1', 'writes carry the CSRF header');
    assert.throws(() => qboApi.lookup('vendors', {}), /Unknown look-up/);
  });

  test('QuickBooks ids must be digits; record routes only for QuickBooks collections', async () => {
    assert.throws(() => qboApi.link('clients', 'c1', '12 OR 1=1'), /Not a QuickBooks id/);
    assert.throws(() => qboApi.lookupOne('customers', '../x'), /Not a QuickBooks id/);
    assert.throws(() => qboApi.record('auditLog', 'x'), /Not a QuickBooks collection/);
    await qboApi.link('clients', 'c 1', '58');
    assert.equal(calls[0].url, '/api/v1/qbo/records/clients/c%201/link');
    assert.deepEqual(calls[0].body, { qboId: '58' });
  });

  test('routes and bodies match section 7', async () => {
    await qboApi.connect({ returnTo: 'web' });
    await qboApi.connect({ returnTo: 'app', reconnect: true });
    await qboApi.pause(false, { allowCount: 742 });
    await qboApi.disconnect();
    await qboApi.pushRecord('invoices', 'inv-1', { asNew: true });
    await qboApi.resolve('k1', { choice: 'fields', fields: { lines: 'quickbooks' } });
    await qboApi.recordsStatus('invoices', Array.from({ length: 250 }, (_, i) => `i${i}`));
    await qboApi.log({ outcome: 'shadow', collection: '' });
    await qboApi.bulkChoices({ kind: 'customers', fieldsFrom: 'fishtape' });
    await qboApi.apply({ raiseNumbers: true });
    const got = calls.map((c) => `${c.method} ${c.url.split('?')[0]} ${JSON.stringify(c.body ?? null)}`);
    assert.deepEqual(got.slice(0, 6), [
      'POST /api/v1/qbo/connect {"returnTo":"web"}',
      'POST /api/v1/qbo/connect {"returnTo":"app","reconnect":true}',
      'POST /api/v1/qbo/pause {"paused":false,"allowCount":742}',
      'POST /api/v1/qbo/disconnect {"purge":false}',
      'POST /api/v1/qbo/records/invoices/inv-1/sync {"asNew":true}',
      'POST /api/v1/qbo/conflicts/k1/resolve {"choice":"fields","fields":{"lines":"quickbooks"}}',
    ]);
    assert.equal(new URL(calls[6].url, 'http://x').searchParams.get('ids').split(',').length, 200, 'at most 200 ids');
    assert.equal(calls[7].url, '/api/v1/qbo/log?outcome=shadow');
    assert.deepEqual(calls[8].body, { bulk: { kind: 'customers', fieldsFrom: 'fishtape' } });
    assert.deepEqual(calls[9].body, { raiseNumbers: true });
    assert.equal(query({ a: 1, b: '', c: null, d: ['x', 'y'] }), '?a=1&d=x%2Cy');
  });
});

describe('words on screen (Intuit branding rules)', () => {
  test('screens and the guide say QuickBooks, never QB or QBO', () => {
    const strings = (src) => [...src.replace(/^\s*\/\/.*$/gm, '').matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]);
    for (const f of ['../js/lib/qbo-ui.js', '../js/modules/quickbooks.js']) {
      for (const s of strings(read(f))) {
        if (/^[a-z]+:\/\/|^#\/|^qbo[-_.]|^\.\.?\/|qbo-|qbo_|^[\w.-]+\.(js|css|md)$/i.test(s)) continue; // URLs, ids, class names, files
        assert.doesNotMatch(s, /\bQBO?\b/, `${f}: "${s}"`);
      }
    }
    const guide = read('../guides/quickbooks.md');
    assert.doesNotMatch(guide, /\bQBO?\b/);
    assert.ok(guide.trim().endsWith(Q.TRADEMARK), 'the guide ends with the trademark line');
    assert.match(read('../img/intuit/README.md'), /CONNECT_BUTTON_ASSET/);
    assert.equal(Q.CONNECT_BUTTON_ASSET, null, 'no Intuit artwork until Kelvin adds the licensed file');
  });
});
