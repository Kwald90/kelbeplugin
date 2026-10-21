// The rules table (js/lib/rules.js, docs/releases/r1-get-paid.md 2.7).
// Run: node --test electrical-app/tests/*.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RULE_DEFS, RULE_KEY_RE, resolveRules, ruleValue, ruleUnconfirmed, ruleProblem, ruleRecordProblem, ruleIdentity, ruleValueText } from '../js/lib/rules.js';

const P = (key, value, status, extra = {}) => ({ key, province: 'MB', effective_from: '1900-01-01', value, status, source: 'test', ...extra });

describe('rules table', () => {
  test('every definition has a valid key, unit and kind', () => {
    for (const [k, d] of Object.entries(RULE_DEFS)) {
      assert.match(k, RULE_KEY_RE, k);
      assert.ok(['deadline', 'rate', 'policy'].includes(d.kind), k);
      assert.ok(d.label && d.unit, k);
      if (d.scope === 'province') assert.match(d.province, /^[A-Z]{2}$/, k);
    }
  });

  test('the newest effectiveFrom on or before the day wins; a tie goes to the company row', () => {
    const platform = [P('pp.MB.paymentDays', 28, 'sourced', { effective_from: '2025-04-01' }), P('pp.MB.paymentDays', 30, 'sourced', { effective_from: '2027-01-01' })];
    let r = resolveRules(platform, [], { province: 'MB', on: '2026-10-20' });
    assert.equal(r.get('pp.MB.paymentDays').value, 28, 'the 2027 row is not in force yet');
    assert.equal(resolveRules(platform, [], { province: 'MB', on: '2027-02-01' }).get('pp.MB.paymentDays').value, 30);
    const company = [{ id: 'r1', key: 'pp.MB.paymentDays', province: 'MB', value: 25, effectiveFrom: '2025-04-01', status: 'verified', source: 'our lawyer', confirmedBy: { name: 'A. Lawyer', role: 'lawyer' }, confirmedAt: '2026-10-01' }];
    r = resolveRules(platform, company, { province: 'MB', on: '2026-10-20' });
    assert.equal(r.get('pp.MB.paymentDays').value, 25, 'company wins the tie');
    assert.equal(r.get('pp.MB.paymentDays').origin, 'company');
    assert.equal(r.get('pp.MB.paymentDays').staleOverride, undefined);
  });

  test('a newer platform row beats an older company override, flagged stale', () => {
    const platform = [P('pp.MB.paymentDays', 30, 'sourced', { effective_from: '2026-06-01' })];
    const company = [{ key: 'pp.MB.paymentDays', province: 'MB', value: 25, effectiveFrom: '2025-04-01', status: 'sourced', source: 'x' }];
    const r = resolveRules(platform, company, { province: 'MB', on: '2026-10-20' }).get('pp.MB.paymentDays');
    assert.equal(r.value, 30);
    assert.equal(r.origin, 'platform');
    assert.equal(r.staleOverride, true);
  });

  test('other provinces do not see a province row; all-province rows apply everywhere', () => {
    const platform = [P('pp.MB.paymentDays', 28, 'sourced'), { key: 'tax.CA.gstHoldbackAtRelease', province: '', effective_from: '1900-01-01', value: true, status: 'sourced' }];
    const r = resolveRules(platform, [], { province: 'ON', on: '2026-10-20' });
    assert.equal(r.has('pp.MB.paymentDays'), false);
    assert.equal(r.get('tax.CA.gstHoldbackAtRelease').value, true);
  });

  test('a yearly value from an earlier year comes back as verify with the missing year', () => {
    const platform = [{ key: 'payroll.CA.cpp.ympe', province: '', effective_from: '2025-01-01', value: 7130000, status: 'verified', confirmed_by: 'HQ', confirmed_at: '2025-01-02' }];
    const r = resolveRules(platform, [], { province: 'MB', on: '2026-03-01' }).get('payroll.CA.cpp.ympe');
    assert.equal(r.status, 'verify');
    assert.equal(r.missingYear, 2026);
    const map = resolveRules(platform, [], { province: 'MB', on: '2026-03-01' });
    assert.equal(ruleValue(map, 'payroll.CA.cpp.ympe'), null, 'a rate on verify is not used');
    assert.equal(ruleValue(map, 'payroll.CA.cpp.ympe', { allowVerify: true }), 7130000, 'unless the caller shows "unconfirmed"');
    assert.equal(resolveRules(platform, [], { province: 'MB', on: '2025-06-01' }).get('payroll.CA.cpp.ympe').status, 'verified');
  });

  test('statuses: a deadline never runs on verify; a policy applies on any status', () => {
    const platform = [
      P('pp.MB.paymentDays', 28, 'sourced'), P('pp.MB.nonPaymentNoticeDays', 14, 'verify'), P('holdback.MB.releaseDays', null, 'verify'),
      P('tax.MB.rstHoldbackAtRelease', true, 'verify'), P('payroll.MB.vacationPct', 4, 'sourced'),
    ];
    const map = resolveRules(platform, [], { province: 'MB', on: '2026-10-20' });
    assert.equal(ruleValue(map, 'pp.MB.paymentDays'), 28);
    assert.equal(ruleValue(map, 'pp.MB.nonPaymentNoticeDays'), null);
    assert.equal(ruleValue(map, 'pp.MB.nonPaymentNoticeDays', { allowVerify: true }), null, 'deadlines ignore allowVerify');
    assert.equal(ruleValue(map, 'holdback.MB.releaseDays'), null);
    assert.equal(ruleValue(map, 'tax.MB.rstHoldbackAtRelease'), true, 'policy on verify still applies');
    assert.equal(ruleUnconfirmed(map, 'tax.MB.rstHoldbackAtRelease'), true);
    assert.equal(ruleValue(map, 'payroll.MB.vacationPct'), 4);
    assert.equal(ruleUnconfirmed(map, 'payroll.MB.vacationPct'), true, 'sourced is still unconfirmed');
    assert.equal(ruleValue(map, 'no.such.key'), null);
    // A company override to verify stops a deadline.
    const off = resolveRules(platform, [{ key: 'pp.MB.paymentDays', province: 'MB', value: 28, status: 'verify', source: 'unsure' }], { province: 'MB', on: '2026-10-20' });
    assert.equal(ruleValue(off, 'pp.MB.paymentDays'), null);
  });

  test('value checks per unit, and the company override rules', () => {
    assert.equal(ruleProblem(RULE_DEFS['pp.MB.paymentDays'], 28), null);
    assert.ok(ruleProblem(RULE_DEFS['pp.MB.paymentDays'], 2.5));
    assert.ok(ruleProblem(RULE_DEFS['pp.MB.paymentDays'], '28'));
    assert.equal(ruleProblem(RULE_DEFS['pp.MB.inForceFrom'], '2025-04-01'), null);
    assert.ok(ruleProblem(RULE_DEFS['pp.MB.inForceFrom'], '2025-4-1'));
    assert.equal(ruleProblem(RULE_DEFS['properInvoice.MB.fields'], ['a', 'b']), null);
    assert.ok(ruleProblem(RULE_DEFS['properInvoice.MB.fields'], 'a,b'));
    assert.equal(ruleProblem(RULE_DEFS['tax.MB.rstHoldbackAtRelease'], false), null);
    assert.equal(ruleProblem(RULE_DEFS['payroll.CA.cpp.ympe'], null), null, 'null is "not set"');
    assert.ok(ruleProblem(undefined, 1));
    const ok = { key: 'payroll.company.wcbRatePct', province: null, value: 3.2, status: 'sourced', source: 'WCB assessment 2026' };
    assert.equal(ruleRecordProblem(ok), null);
    assert.match(ruleRecordProblem({ ...ok, source: '' }), /source/);
    assert.match(ruleRecordProblem({ ...ok, status: 'verified' }), /who confirmed/);
    assert.equal(ruleRecordProblem({ ...ok, status: 'verified', confirmedBy: { name: 'Travis' }, confirmedAt: '2026-10-20' }), null);
    assert.match(ruleRecordProblem({ ...ok, key: 'made.up' }), /Pick a rule/);
    assert.match(ruleRecordProblem({ key: 'pp.MB.paymentDays', province: 'SK', value: 28, status: 'sourced', source: 'x' }), /MB only/);
    assert.equal(ruleIdentity({ key: 'a.b', province: null }), 'a.b||1900-01-01');
    assert.equal(ruleValueText(RULE_DEFS['pp.MB.paymentDays'], 28), '28 days');
    assert.equal(ruleValueText(RULE_DEFS['tax.MB.rstHoldbackAtRelease'], true), 'Yes');
    assert.equal(ruleValueText(RULE_DEFS['payroll.CA.cpp.ympe'], null), 'Not set');
  });
});
