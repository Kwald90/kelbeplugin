// HQ Rules (docs/releases/r1-get-paid.md 2.7): the platform rows of the rules table. HQ staff read,
// HQ admins change; every row is checked against its definition (RULE_DEFS, ruleProblem); a
// verified row needs who confirmed it and when; yearly values start on 1 January; every change is
// in the platform audit chain.
//
// Until R1-A's electrical-app/js/lib/rules.js and migration 0160 are on the branch, this file uses
// a contract-shaped stand-in for the library and creates platform_rules with the contract's DDL.
// Both stand-ins switch off by themselves once the real ones exist.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { skip, createTestDatabase } from './support/db.js';
import { call, logCapture, ownerTenant, testConfig } from './support/app.js';
import { hqUser, NOTIFY_EMAIL } from './support/hq.js';
import { fakeStripe } from './support/fake-stripe.js';
import { buildApp } from '../src/app.js';
import hqRulesRoutes, { platformRuleProblems, ruleGaps } from '../src/routes/hq-rules.js';

const RULES_LIB = fileURLToPath(new URL('../../electrical-app/js/lib/rules.js', import.meta.url));

/** The contract's shape of lib/rules.js, for the checks this route makes. */
const STAND_IN = {
  RULE_STATUS: ['verified', 'sourced', 'verify'],
  RULE_DEFS: {
    'pp.MB.paymentDays': { label: 'Owner pays a proper invoice within', unit: 'days', kind: 'deadline', scope: 'province', province: 'MB', usedBy: ['prompt-payment alarms'], description: 'Prompt payment' },
    'holdback.excludePassThrough': { label: 'Out-of-pocket disbursements outside the holdback base', unit: 'bool', kind: 'policy', scope: 'national', usedBy: ['holdback'] },
    'payroll.CA.cpp.ympe': { label: 'CPP yearly maximum pensionable earnings', unit: 'cents', kind: 'rate', scope: 'national', yearly: true, usedBy: ['burden'] },
    'properInvoice.MB.fields': { label: 'Proper invoice contents', unit: 'list', kind: 'policy', scope: 'province', province: 'MB', usedBy: ['proper invoice'] },
    'payroll.company.wcbRatePct': { label: 'WCB rate', unit: 'pct', kind: 'rate', scope: 'company', usedBy: ['burden'] },
  },
  ruleProblem(def, value) {
    if (value === null) return null;
    switch (def.unit) {
      case 'days': case 'years': return Number.isInteger(value) && value >= 0 ? null : 'Use a whole number of days.';
      case 'cents': return Number.isInteger(value) && value >= 0 ? null : 'Use whole cents.';
      case 'pct': return typeof value === 'number' && value >= 0 && value <= 100 ? null : 'Use a percentage from 0 to 100.';
      case 'bool': return typeof value === 'boolean' ? null : 'Use yes or no.';
      case 'list': return Array.isArray(value) && value.every((v) => typeof v === 'string') ? null : 'Use a list of words.';
      default: return null;
    }
  },
};

const PLATFORM_RULES_DDL = `
CREATE TABLE platform_rules (
  key            text NOT NULL CHECK (key ~ '^[a-z][A-Za-z0-9]*(\\.[A-Za-z0-9]+){1,5}$'),
  province       text NOT NULL DEFAULT '' CHECK (province = '' OR province ~ '^[A-Z]{2}$'),
  effective_from date NOT NULL DEFAULT '1900-01-01',
  value          jsonb,
  status         text NOT NULL CHECK (status IN ('verified', 'sourced', 'verify')),
  source         text CHECK (source IS NULL OR length(source) <= 500),
  source_url     text CHECK (source_url IS NULL OR (source_url ~ '^https://' AND length(source_url) <= 500)),
  note           text CHECK (note IS NULL OR length(note) <= 1000),
  confirmed_by   text CHECK (confirmed_by IS NULL OR length(confirmed_by) <= 200),
  confirmed_at   timestamptz,
  updated_by     text NOT NULL CHECK (length(updated_by) <= 200),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, province, effective_from),
  CHECK (status <> 'verified' OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL))
);
GRANT SELECT ON platform_rules TO fishtape_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_rules TO fishtape_hq;
INSERT INTO platform_rules (key, province, effective_from, value, status, source, updated_by)
VALUES ('pp.MB.paymentDays', 'MB', '2025-04-01', '28', 'sourced', 'MHCA, MLT Aikins', 'migration:0160');
`;

const lib = existsSync(RULES_LIB) ? await import(RULES_LIB) : STAND_IN;
const YEAR = new Date().getUTCFullYear();

describe('platform rule checks (no database)', () => {
  const row = (o) => ({ key: 'pp.MB.paymentDays', province: 'MB', effectiveFrom: '2025-04-01', value: 28, status: 'sourced', source: 'MHCA', sourceUrl: null, confirmedBy: null, confirmedAt: null, ...o });

  test('a good row passes; each field is checked against its definition', () => {
    assert.deepEqual(platformRuleProblems(lib, row()), {});
    assert.ok(platformRuleProblems(lib, row({ key: 'pp.MB.notARule' })).key);
    assert.ok(platformRuleProblems(lib, row({ value: 'twenty-eight' })).value);
    assert.ok(platformRuleProblems(lib, row({ province: 'ON' })).province, 'an MB rule is for MB only');
    assert.ok(platformRuleProblems(lib, row({ effectiveFrom: '2025-02-30' })).effectiveFrom, 'a real calendar day');
    assert.ok(platformRuleProblems(lib, row({ status: 'maybe' })).status);
    assert.ok(platformRuleProblems(lib, row({ sourceUrl: 'http://example.test' })).sourceUrl, 'https only');
    assert.ok(platformRuleProblems(lib, row({ source: null })).source, 'a sourced value names its source');
    assert.deepEqual(platformRuleProblems(lib, row({ value: null, status: 'verify', source: null })), {}, 'a verify row may be empty');
  });

  test('verified needs who and when; company-only keys and mid-year yearly values are refused', () => {
    const v = platformRuleProblems(lib, row({ status: 'verified' }));
    assert.ok(v.confirmedBy && v.confirmedAt);
    assert.deepEqual(platformRuleProblems(lib, row({ status: 'verified', confirmedBy: 'J. Smith, lawyer', confirmedAt: '2026-10-01T00:00:00.000Z' })), {});
    assert.ok(platformRuleProblems(lib, row({ key: 'payroll.company.wcbRatePct', province: '', value: 4 })).key);
    const cpp = { key: 'payroll.CA.cpp.ympe', province: '', value: 7130000, source: 'canada.ca' };
    assert.ok(platformRuleProblems(lib, row({ ...cpp, effectiveFrom: `${YEAR}-03-01` })).effectiveFrom);
    assert.deepEqual(platformRuleProblems(lib, row({ ...cpp, effectiveFrom: `${YEAR}-01-01` })), {});
  });

  test('gaps: no row, no value for this year, and deadlines or rates still at verify', () => {
    const defs = { a: { kind: 'deadline' }, b: { kind: 'rate', yearly: true }, c: { kind: 'policy' }, d: { kind: 'rate', scope: 'company' } };
    const gaps = ruleGaps(defs, [
      { key: 'a', effectiveFrom: '2025-04-01', value: null, status: 'verify' },
      { key: 'b', effectiveFrom: '2025-01-01', value: 100, status: 'sourced' },
    ], 2026);
    assert.deepEqual(gaps.map((g) => `${g.key}:${g.code}`), ['a:verify', 'b:missing_year', 'c:missing']);
  });
});

let t, app, owner, admin, staff;

before(async () => {
  if (skip) return;
  t = await createTestDatabase('hqrules');
  if (!(await t.superPool.query("SELECT to_regclass('public.platform_rules') IS NOT NULL AS ok")).rows[0].ok) {
    await t.superPool.query(PLATFORM_RULES_DDL);
  }
  const config = testConfig();
  config.hq = { notifyEmail: NOTIFY_EMAIL, tlsCheck: false, ...(lib === STAND_IN ? { ruleLib: STAND_IN } : {}) };
  config.billing = { stripe: fakeStripe(), webhookSecret: 'whsec_fishtape_test_secret', graceDays: 7 };
  config.signup = {};
  app = await buildApp({ config, db: t.db, oidcProviders: {}, logStream: logCapture().stream });
  // The Lead registers the route in app.js; until then this test does.
  if (!app.hasRoute({ method: 'GET', url: '/api/hq/rules' })) await app.register(hqRulesRoutes, { config, db: t.db });
  await app.ready();
  owner = await ownerTenant(t, app, 'Alpha Wiring');
  admin = await hqUser(t, app, 'hq_admin');
  staff = await hqUser(t, app, 'hq_staff');
});
after(async () => { await app?.close(); await t?.close(); });

const hq = (token, url, opts = {}) => call(app, { url, token, ...opts });
const put = (token, body) => hq(token, '/api/hq/rules', { method: 'PUT', body });
const audit = async (action) => (await t.superPool.query('SELECT * FROM audit_events WHERE tenant_id IS NULL AND action = $1 ORDER BY seq', [action])).rows;

describe('HQ Rules routes', { skip }, () => {
  test('HQ only: anonymous and company owners are refused; staff read; only admins write', async () => {
    assert.equal((await call(app, { url: '/api/hq/rules' })).status, 401);
    assert.equal((await hq(owner.token, '/api/hq/rules')).status, 403);
    const r = await hq(staff.token, '/api/hq/rules');
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.ok(r.body.defs['pp.MB.paymentDays']);
    assert.deepEqual(r.body.statuses, ['verified', 'sourced', 'verify']);
    const seeded = r.body.rows.find((x) => x.key === 'pp.MB.paymentDays' && x.effectiveFrom === '2025-04-01');
    assert.equal(seeded.value, 28);
    assert.equal(seeded.province, 'MB');
    const w = await put(staff.token, { key: 'pp.MB.paymentDays', province: 'MB', effectiveFrom: '2027-01-01', value: 30, status: 'verify' });
    assert.equal(w.status, 403);
    assert.equal((await hq(owner.token, '/api/hq/rules', { method: 'PUT', body: { key: 'pp.MB.paymentDays', status: 'verify' } })).status, 403);
    assert.equal((await hq(staff.token, '/api/hq/rules?key=pp.MB.paymentDays&province=MB&effectiveFrom=2025-04-01', { method: 'DELETE' })).status, 403);
  });

  test('validation against the definitions: unknown key, wrong type, wrong province, company-only, bad link', async () => {
    const bad = async (body, field) => {
      const r = await put(admin.token, { province: 'MB', effectiveFrom: '2027-01-01', status: 'sourced', source: 'test', ...body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error.code, 'validation_failed');
      assert.ok(r.body.error.details.errors[field], `${field}: ${JSON.stringify(r.body.error.details)}`);
    };
    await bad({ key: 'pp.MB.madeUp', value: 1 }, 'key');
    await bad({ key: 'pp.MB.paymentDays', value: 'twenty' }, 'value');
    await bad({ key: 'pp.MB.paymentDays', value: 28, province: 'ON' }, 'province');
    await bad({ key: 'payroll.company.wcbRatePct', value: 4, province: '' }, 'key');
    await bad({ key: 'pp.MB.paymentDays', value: 28, sourceUrl: 'http://not-https.example' }, 'sourceUrl');
    await bad({ key: 'pp.MB.paymentDays', value: 28, status: 'probably' }, 'status');
    assert.equal(await t.superPool.query("SELECT count(*)::int AS n FROM platform_rules WHERE effective_from = '2027-01-01'").then((x) => x.rows[0].n), 0, 'nothing written');
  });

  test('verified needs who and when; the confirmation is stored and shown', async () => {
    const body = { key: 'holdback.excludePassThrough', province: '', value: true, status: 'verified', source: 'Construction lawyer, written opinion' };
    const r = await put(admin.token, body);
    assert.equal(r.status, 400);
    assert.ok(r.body.error.details.errors.confirmedBy);
    assert.ok(r.body.error.details.errors.confirmedAt);
    const ok = await put(admin.token, { ...body, confirmedBy: 'A. Lawyer (construction lawyer)', confirmedAt: '2026-10-15' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.rule.status, 'verified');
    assert.equal(ok.body.rule.confirmedBy, 'A. Lawyer (construction lawyer)');
    assert.equal(ok.body.rule.confirmedAt, '2026-10-15T00:00:00.000Z');
    // Back to verify: the confirmation is dropped (it no longer applies).
    const back = await put(admin.token, { ...body, status: 'verify', confirmedBy: 'A. Lawyer', confirmedAt: '2026-10-15' });
    assert.equal(back.body.rule.confirmedBy, null);
    assert.equal(back.body.rule.confirmedAt, null);
  });

  test('add, change and remove a dated row; each change is in the platform audit chain with before and after', async () => {
    const row = { key: 'pp.MB.paymentDays', province: 'MB', effectiveFrom: '2027-01-01', value: 30, status: 'verify', note: 'Proposed amendment' };
    const a = await put(admin.token, row);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.created, true);
    assert.equal(a.body.rule.updatedBy.length > 0, true);
    const b = await put(admin.token, { ...row, value: 35 });
    assert.equal(b.body.created, false);
    const sets = (await audit('hq.rule_set')).filter((e) => e.meta.key === 'pp.MB.paymentDays' && e.meta.effectiveFrom === '2027-01-01');
    assert.equal(sets.length, 2);
    assert.equal(sets[0].meta.from, null);
    assert.deepEqual(sets[1].meta.from.value, 30);
    assert.deepEqual(sets[1].meta.to.value, 35);
    assert.equal(sets[1].actor_type, 'hq');
    assert.equal(sets[1].tenant_id, null);
    const listed = await hq(staff.token, '/api/hq/rules');
    assert.equal(listed.body.rows.filter((x) => x.key === 'pp.MB.paymentDays').length, 2, 'the 2025 row is untouched');

    const url = '/api/hq/rules?key=pp.MB.paymentDays&province=MB&effectiveFrom=2027-01-01';
    assert.equal((await hq(admin.token, url, { method: 'DELETE' })).status, 200);
    assert.equal((await hq(admin.token, url, { method: 'DELETE' })).status, 404);
    const del = await audit('hq.rule_delete');
    assert.equal(del.at(-1).meta.from.value, 35);
  });

  test('yearly values: 1 January only, and the gap for this year closes once it is set', async () => {
    const before = await hq(staff.token, '/api/hq/rules');
    assert.ok(before.body.gaps.some((g) => g.key === 'payroll.CA.cpp.ympe' && ['missing', 'missing_year'].includes(g.code)));
    const midYear = await put(admin.token, { key: 'payroll.CA.cpp.ympe', province: '', effectiveFrom: `${YEAR}-03-01`, value: 7130000, status: 'sourced', source: 'canada.ca' });
    assert.equal(midYear.status, 400);
    assert.ok(midYear.body.error.details.errors.effectiveFrom);
    const ok = await put(admin.token, { key: 'payroll.CA.cpp.ympe', province: '', effectiveFrom: `${YEAR}-01-01`, value: 7130000, status: 'sourced', source: 'canada.ca', sourceUrl: 'https://www.canada.ca/' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const after = await hq(staff.token, '/api/hq/rules');
    assert.ok(!after.body.gaps.some((g) => g.key === 'payroll.CA.cpp.ympe' && g.code === 'missing_year'));
  });

  test('the database refuses a verified row without its confirmation even if a route forgot', async () => {
    await assert.rejects(t.superPool.query(
      "INSERT INTO platform_rules (key, province, effective_from, value, status, updated_by) VALUES ('pp.MB.paymentDays', 'MB', '2030-01-01', '28', 'verified', 'test')"));
  });
});
