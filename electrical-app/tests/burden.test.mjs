// Labour burden (js/lib/burden.js, docs/releases/r1-get-paid.md 6.4): CPP, CPP2, EI and WCB yearly
// maximums on earnings that include vacation and holiday pay, vacation after five years, the
// effective-dated wage, zero earnings, and the flat fallback with its warnings when a year's values
// are not loaded. The 2026 figures below are test values shaped like the real ones (HQ loads the
// real ones on HQ → Rules).
// Run: node --test electrical-app/tests/*.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as B from '../js/lib/burden.js';

const row = (key, value, o = {}) => ({ key, province: '', effectiveFrom: '2026-01-01', value, status: 'sourced', origin: 'platform', ...o });
const MB = { province: 'MB', effectiveFrom: '1900-01-01' };
const RULES = [
  row('payroll.CA.cpp.rate', 5.95), row('payroll.CA.cpp.ympe', 7_460_000), row('payroll.CA.cpp.basicExemption', 350_000),
  row('payroll.CA.cpp2.rate', 4), row('payroll.CA.cpp2.yampe', 8_500_000),
  row('payroll.CA.ei.rate', 1.63), row('payroll.CA.ei.mie', 6_890_000), row('payroll.CA.ei.employerFactor', 1.4, { effectiveFrom: '1900-01-01' }),
  row('payroll.MB.wcb.maxAssessableCents', 13_500_000, { province: 'MB' }),
  row('payroll.MB.vacationPct', 4, MB), row('payroll.MB.vacationPctLong', 6, MB), row('payroll.MB.vacationLongYears', 5, MB),
  row('payroll.MB.constructionHolidayPct', 4, MB),
  row('payroll.company.wcbRatePct', 2.5, { origin: 'company', effectiveFrom: '1900-01-01' }),
];
const settings = { company: { province: 'MB' }, costing: { annualHours: 2000, nonProductivePctDefault: 10, statutoryPctFallback: 12 } };
const sam = { id: 'e1', name: 'Sam', role: 'electrician', rateCents: 4000, hireDate: '2024-03-01' };

describe('burden', () => {
  test('CPP and EI stop at their yearly maximums; earnings include vacation and holiday pay', () => {
    const b = B.burdenRate(sam, { rules: RULES, settings, on: '2026-09-15' });
    assert.equal(b.wageCents, 4000);
    assert.equal(b.vacationPct, 4);
    assert.equal(b.holidayPct, 4);
    // $40 × 2000 h × 1.08 = $86,400 of earnings, above the YMPE and the MIE.
    assert.equal(b.earningsCents, 8_640_000);
    const cpp = Math.min(0.0595 * (8_640_000 - 350_000), 0.0595 * (7_460_000 - 350_000)) + 0.04 * (8_500_000 - 7_460_000);
    assert.ok(Math.abs(b.cppPct - (cpp / 8_640_000) * 100) < 0.001, `cpp ${b.cppPct}`);
    assert.ok(b.cppPct < 5.95, 'a flat 5.95% would overstate the cost of a high earner');
    assert.ok(Math.abs(b.eiPct - ((6_890_000 * 0.0163 * 1.4) / 8_640_000) * 100) < 0.001);
    assert.equal(b.wcbPct, 2.5, 'under the WCB maximum: the full rate');
    assert.equal(b.fallbackUsed, false);
    assert.deepEqual(b.warnings, []);
    const statutory = b.cppPct + b.eiPct + b.wcbPct;
    assert.ok(Math.abs(b.statutoryPct - statutory) < 0.001);
    assert.equal(b.costPerPaidHourCents, Math.round(4000 * 1.08 * (1 + b.statutoryPct / 100)));
    assert.equal(b.costPerProductiveHourCents, Math.round((4000 * 1.08 * (1 + b.statutoryPct / 100)) / 0.9));
  });

  test('a low earner pays CPP on everything above the basic exemption, EI on everything', () => {
    const low = { ...sam, rateCents: 1700, burden: { annualHours: 1000 } };
    const b = B.burdenRate(low, { rules: RULES, settings, on: '2026-09-15' });
    const earnings = 1700 * 1000 * 1.08;
    assert.ok(Math.abs(b.cppPct - ((0.0595 * (earnings - 350_000)) / earnings) * 100) < 0.001);
    assert.ok(Math.abs(b.eiPct - 1.63 * 1.4) < 0.001);
  });

  test('vacation goes to 6% at the fifth anniversary; an employee override wins', () => {
    const long = { ...sam, hireDate: '2021-09-15' };
    assert.equal(B.burdenRate(long, { rules: RULES, settings, on: '2026-09-14' }).vacationPct, 4, 'the day before the anniversary');
    assert.equal(B.burdenRate(long, { rules: RULES, settings, on: '2026-09-15' }).vacationPct, 6);
    assert.equal(B.burdenRate({ ...sam, burden: { vacationPct: 8 } }, { rules: RULES, settings, on: '2026-09-15' }).vacationPct, 8);
  });

  test('the wage is the rate on the day: a raise in November leaves September alone', () => {
    const raised = { ...sam, rateCents: 5000, rateHistory: [{ from: '2026-01-01', rateCents: 4000 }, { from: '2026-11-01', rateCents: 5000 }] };
    assert.equal(B.burdenRate(raised, { rules: RULES, settings, on: '2026-09-30' }).wageCents, 4000);
    assert.equal(B.burdenRate(raised, { rules: RULES, settings, on: '2026-11-01' }).wageCents, 5000);
    assert.equal(B.rateOn(raised.rateHistory, '2025-12-31'), null, 'before the history: the caller uses rateCents');
    assert.equal(B.wageOn(raised, '2025-12-31'), 5000);
  });

  test('zero earnings: zero burden and a warning, never a division by zero', () => {
    const b = B.burdenRate({ id: 'x', rateCents: 0 }, { rules: RULES, settings, on: '2026-09-15' });
    assert.equal(b.costPerPaidHourCents, 0);
    assert.equal(b.statutoryPct, 0);
    assert.ok(b.warnings.some((w) => /No wage/.test(w)));
    assert.ok(Number.isFinite(b.costPerProductiveHourCents));
  });

  test('a year whose values are not loaded uses the flat fallback, with a warning naming the year', () => {
    const b = B.burdenRate(sam, { rules: RULES, settings, on: '2027-02-01' });
    assert.equal(b.fallbackUsed, true);
    assert.equal(b.statutoryPct, 12);
    assert.ok(b.warnings.some((w) => /CPP\/EI\/WCB maximum 2027 values not loaded; using your flat 12%/.test(w)), b.warnings.join(' | '));
    // Last year's maximums are never reused: CPP is not computed at all.
    assert.equal(b.cppPct, null);
  });

  test('a rule marked verify is not used; without a fallback the warning says the cost is understated', () => {
    const verify = RULES.map((x) => (x.key === 'payroll.CA.ei.rate' ? { ...x, status: 'verify' } : x));
    const b = B.burdenRate(sam, { rules: verify, settings, on: '2026-09-15' });
    assert.equal(b.statutoryPct, 12);
    assert.ok(b.warnings.some((w) => /^EI 2026/.test(w)));
    const none = B.burdenRate(sam, { rules: verify, settings: { ...settings, costing: { ...settings.costing, statutoryPctFallback: null } }, on: '2026-09-15' });
    assert.ok(none.warnings.some((w) => /understated/.test(w)));
    assert.ok(none.statutoryPct > 0, 'the parts that are loaded still count');
  });

  test('no rules and no fallback: the bare wage (old companies see the same numbers)', () => {
    const b = B.burdenRate({ id: 'e', rateCents: 4000 }, {});
    assert.equal(b.costPerPaidHourCents, 4000);
    assert.equal(b.nonProductivePct, 10);
  });

  test('rules arrive in any shape: a resolved Map, the /rules/effective envelope, platform and company rows', () => {
    const env = B.burdenRate(sam, { rules: { rules: RULES }, settings, on: '2026-09-15' });
    const split = B.burdenRate(sam, { rules: { platform: RULES.filter((x) => x.origin === 'platform'), company: RULES.filter((x) => x.origin === 'company') }, settings, on: '2026-09-15' });
    const map = B.burdenRate(sam, { rules: B.rulesFor(RULES, { province: 'MB', on: '2026-09-15' }), settings, on: '2026-09-15' });
    assert.equal(env.costPerPaidHourCents, split.costPerPaidHourCents);
    assert.equal(env.costPerPaidHourCents, map.costPerPaidHourCents);
  });

  test('years of service', () => {
    assert.equal(B.yearsOfService('2021-09-15', '2026-09-14'), 4);
    assert.equal(B.yearsOfService('2021-09-15', '2026-09-15'), 5);
    assert.equal(B.yearsOfService(null, '2026-09-15'), null);
  });
});
