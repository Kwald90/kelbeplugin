// The rules table (docs/releases/r1-get-paid.md 2.7, docs/office/rules-table.md): GET /api/v1/rules/effective
// returns Fishtape's seeded rows with the company's overrides applied (a company row wins a tie),
// overrides are typed, sourced and unique, only the office writes them, and one company never sees
// another's overrides.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { skip, createTestDatabase } from './support/db.js';
import { addMember, call, ownerTenant, testConfig } from './support/app.js';
import { buildApp } from '../src/app.js';
import { createRecords } from '../src/services/records.js';
import { createValidator } from '../src/schemas.js';
import rulesRoutes from '../src/routes/v1/rules.js';
import { RULE_DEFS } from '../../electrical-app/js/lib/rules.js';

async function startR1App(t) {
  const config = testConfig();
  const app = await buildApp({ config, db: t.db, oidcProviders: {}, logStream: new Writable({ write(c, e, cb) { cb(); } }) });
  if (!app.hasRoute({ method: 'GET', url: '/api/v1/rules/effective' })) await app.register(rulesRoutes, { db: t.db, records: createRecords({ validator: createValidator(), config, db: t.db }), config });
  await app.ready();
  return { app };
}

let t, app, A, B, sam, foreman;
const rules = (token, q = '') => call(app, { url: `/api/v1/rules/effective${q}`, token });
const override = (o = {}) => ({ key: 'pp.MB.paymentDays', province: 'MB', value: 25, effectiveFrom: '2025-04-01', status: 'sourced', source: "Our lawyer's letter of 2026-10-01", ...o });

before(async () => {
  if (skip) return;
  t = await createTestDatabase('rules');
  ({ app } = await startR1App(t));
  A = await ownerTenant(t, app, 'Rulebook Electric');
  B = await ownerTenant(t, app, 'Other Electric');
  for (const [id, name, role] of [['emp-sam', 'Sam Sparks', 'electrician'], ['emp-fore', 'Fred Foreman', 'foreman']]) {
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/employees', token: A.token, body: { id, name, role } })).status, 201);
  }
  sam = await addMember(t, app, A.tenantId, { role: 'electrician', employeeId: 'emp-sam' });
  foreman = await addMember(t, app, A.tenantId, { role: 'foreman', employeeId: 'emp-fore' });
  const s = await call(app, { method: 'POST', url: '/api/v1/settings', token: A.token, body: { id: 'settings', company: { name: 'Rulebook Electric', province: 'MB' } } });
  assert.equal(s.status, 201, JSON.stringify(s.body));
});
after(async () => { await app?.close(); await t?.close(); });

describe('reading the rules', { skip }, () => {
  test('the seeded platform rows, with definitions; the company province by default', async () => {
    const r = await rules(A.token);
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.body.province, 'MB');
    assert.equal(r.body.defs['pp.MB.paymentDays'].kind, 'deadline');
    assert.equal(Object.keys(r.body.defs).length, Object.keys(RULE_DEFS).length);
    const by = Object.fromEntries(r.body.rules.map((x) => [x.key, x]));
    assert.equal(by['pp.MB.paymentDays'].value, 28);
    assert.equal(by['pp.MB.paymentDays'].status, 'sourced');
    assert.equal(by['pp.MB.paymentDays'].origin, 'platform');
    assert.equal(by['holdback.MB.pct'].value, null);
    assert.equal(by['holdback.MB.pct'].status, 'verify');
    assert.equal(by['tax.CA.gstHoldbackAtRelease'].value, true);
    assert.deepEqual(by['properInvoice.MB.fields'].value.slice(0, 2), ['contractorName', 'contractorAddress']);
    assert.equal(by['payroll.CA.cpp.ympe'].status, 'verify');
    const sk = await rules(A.token, '?province=SK&on=2026-10-20');
    assert.equal(sk.body.rules.some((x) => x.key === 'pp.MB.paymentDays'), false);
    assert.equal(sk.body.rules.find((x) => x.key === 'tax.SK.pstHoldbackAtRelease').value, true);
    const early = await rules(A.token, '?province=MB&on=2025-01-15');
    assert.equal(early.body.rules.some((x) => x.key === 'pp.MB.paymentDays'), false, 'not in force yet');
  });

  test('any member may read them (no money in them)', async () => {
    assert.equal((await rules(sam.token)).status, 200);
    assert.equal((await rules(foreman.token)).status, 200);
    assert.equal((await rules(A.token, '?province=Manitoba')).status, 400);
  });
});

describe('company overrides', { skip }, () => {
  test('an override wins the tie with the platform row and is audited', async () => {
    const c = await call(app, { method: 'POST', url: '/api/v1/rules', token: A.token, body: { id: 'r-pay', ...override() } });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const by = Object.fromEntries((await rules(A.token)).body.rules.map((x) => [x.key, x]));
    assert.equal(by['pp.MB.paymentDays'].value, 25);
    assert.equal(by['pp.MB.paymentDays'].origin, 'company');
    assert.equal(by['pp.MB.paymentDays'].id, 'r-pay');
    const a = await t.superPool.query("SELECT action FROM audit_events WHERE tenant_id = $1 AND collection = 'rules'", [A.tenantId]);
    assert.ok(a.rows.some((x) => x.action === 'record.create'));
    // Another company never sees it.
    const other = Object.fromEntries((await rules(B.token, '?province=MB')).body.rules.map((x) => [x.key, x]));
    assert.equal(other['pp.MB.paymentDays'].value, 28);
  });

  test('one override per key, province and date (409 duplicate_rule)', async () => {
    const d = await call(app, { method: 'POST', url: '/api/v1/rules', token: A.token, body: { id: 'r-pay-2', ...override({ value: 21 }) } });
    assert.equal(d.status, 409);
    assert.equal(d.body.error.code, 'duplicate_rule');
    const later = await call(app, { method: 'POST', url: '/api/v1/rules', token: A.token, body: { id: 'r-pay-3', ...override({ value: 21, effectiveFrom: '2027-01-01' }) } });
    assert.equal(later.status, 201, 'a later effective date is a new row');
  });

  test('typed, sourced and confirmed per the definition', async () => {
    const bad = async (o) => (await call(app, { method: 'POST', url: '/api/v1/rules', token: A.token, body: override(o) })).body.error;
    assert.equal((await bad({ key: 'pp.MB.nonPaymentNoticeDays', value: '14' })).code, 'validation_failed');
    assert.match((await bad({ key: 'made.up.key' })).message, /Pick a rule/);
    assert.match((await bad({ key: 'pp.MB.subPaymentDays', source: '' })).message, /source/);
    assert.match((await bad({ key: 'pp.MB.subPaymentDays', status: 'verified' })).message, /who confirmed/);
    const ok = await call(app, { method: 'POST', url: '/api/v1/rules', token: A.token, body: { id: 'r-wcb', key: 'payroll.company.wcbRatePct', province: null, value: 2.71, status: 'verified', source: 'WCB assessment notice 2026', confirmedBy: { name: 'Travis', role: 'owner' }, confirmedAt: '2026-10-20T00:00:00.000Z' } });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const by = Object.fromEntries((await rules(A.token)).body.rules.map((x) => [x.key, x]));
    assert.equal(by['payroll.company.wcbRatePct'].value, 2.71);
    assert.equal(by['payroll.company.wcbRatePct'].status, 'verified');
  });

  test('only the office writes overrides', async () => {
    for (const token of [sam.token, foreman.token]) {
      const r = await call(app, { method: 'POST', url: '/api/v1/rules', token, body: { id: 'r-x', ...override({ key: 'pp.MB.subPaymentDays', value: 5 }) } });
      assert.equal(r.status, 403);
    }
  });
});
