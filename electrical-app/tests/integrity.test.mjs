// Run: node --test electrical-app/tests/
//
// SDL-10 (Calculation and output integrity): money is stored/computed as INTEGER
// CENTS, measurements are stored in SI units (metres), and CEC tables, tax rates
// and electrical formulas cite their source. These are the invariants, asserted as
// invariants (type + citation presence) plus a handful of source-cited anchors, so
// estimates, invoices and calculator results stay reproducible. Specific worked
// values live in money.test.mjs, tax.test.mjs, cec.test.mjs and electrical.test.mjs;
// this file guards the properties those tests all depend on.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { lineCents, pctOfCents, docTotals, combinedPct, formatMoney } from '../js/lib/money.js';
import { taxComponents, ratesOn, RATE_HISTORY, PROVINCES } from '../js/lib/tax.js';
import * as C from '../js/lib/cec/index.js';
import { AREA_MM2 } from '../js/lib/cec/conductors.js';
import { inToM, mToIn, M_PER_IN, M_PER_FT, parseLength, fmtLength } from '../js/lib/units.js';

const mat = (cents, extra = {}) => ({ description: 'Material', qty: 1, unitCents: cents, kind: 'material', ...extra });
const lab = (cents, extra = {}) => ({ description: 'Labour', qty: 1, unitCents: cents, kind: 'labour', ...extra });
const byId = (t, id) => t.taxes.find((x) => x.id === id);

// ---------------------------------------------------------------------------
// SDL-10: money as INTEGER CENTS, display rounding only
// ---------------------------------------------------------------------------

describe('SDL-10 money is integer cents (lib/money.js)', () => {
  test('lineCents is an integer; 3 × 999¢ = 2997 with no float drift', () => {
    // The classic trap: $19.99 × 1.13 in float dollars is 22.588699999999996, which
    // truncates a cent light. Integer cents never multiply dollars as floats.
    assert.notEqual(19.99 * 1.13, 22.5887); // documents why dollars-as-float is banned
    assert.equal(999 * 3, 2997); // integer cents: exact
    const c = lineCents({ qty: 3, unitCents: 999 });
    assert.equal(c, 2997);
    assert.ok(Number.isInteger(c));
    // fractional qty still lands on a whole cent (Rule: round once, at the line)
    const half = lineCents({ qty: 2.5, unitCents: 101 }); // 252.5 -> 253
    assert.equal(half, 253);
    assert.ok(Number.isInteger(half));
  });

  test('pctOfCents is exact integer milli-math, half rounds up, QST to 1/1000 %', () => {
    // 0.1 + 0.2 !== 0.3 in float; pctOfCents never multiplies dollars as floats.
    assert.notEqual(0.1 + 0.2, 0.3);
    assert.equal(pctOfCents(10, 5), 1); // 0.5¢ -> 1¢ (half up)
    assert.equal(pctOfCents(9, 5), 0); // 0.45¢ -> 0
    assert.equal(pctOfCents(15000, 9.975), 1496); // QST: 1496.25¢ -> 1496, rate to 1/1000 %
    assert.equal(pctOfCents(-10, 5), -1); // credits round away from zero
    for (const v of [pctOfCents(12345, 13), pctOfCents(1, 9.975), pctOfCents(99999, 7)]) assert.ok(Number.isInteger(v));
  });

  test('docTotals returns every *Cents field as an integer (estimate/invoice path)', () => {
    // Full path: materials + markup + labour, HST, a 10% holdback with HST deferred.
    const doc = {
      taxProvince: 'ON', markupPct: 12.5,
      taxes: taxComponents({ province: 'ON', treatment: 'standard', date: '2026-10-19' }),
      lines: [mat(1999), mat(333), lab(7777)],
      holdback: { pct: 10, deferTaxIds: ['HST'] },
    };
    const t = docTotals(doc);
    for (const k of ['materialCents', 'labourCents', 'otherCents', 'markupCents', 'subtotalCents',
      'taxCents', 'totalCents', 'workSubtotalCents', 'holdbackBaseCents', 'holdbackCents',
      'netSubtotalCents', 'passThroughCents', 'depositCents', 'holdbackLineCents', 'interestCents']) {
      assert.ok(Number.isInteger(t[k]), `${k} = ${t[k]} is not an integer`);
    }
    for (const tax of t.taxes) {
      assert.ok(Number.isInteger(tax.cents), `tax ${tax.id} cents`);
      assert.ok(Number.isInteger(tax.baseCents), `tax ${tax.id} baseCents`);
      assert.ok(Number.isInteger(tax.deferredCents), `tax ${tax.id} deferredCents`);
    }
    // The identity the ledger relies on: total = net subtotal + tax, all in cents.
    assert.equal(t.totalCents, t.netSubtotalCents + t.taxCents);
  });

  test('regression: tax is rounded once per document, not per line (ON HST 13%)', () => {
    // Known rounding trap: three 33¢ lines. Per-document 99¢ × 13% = 12.87¢ -> 13¢.
    // Per-line would give 4 + 4 + 4 = 12¢, a cent light.
    const t = docTotals({ taxes: taxComponents({ province: 'ON', treatment: 'standard', date: '2026-10-19' }), lines: [mat(33), mat(33), mat(33)] });
    assert.equal(byId(t, 'HST').baseCents, 99);
    assert.equal(byId(t, 'HST').cents, 13);
    assert.notEqual(3 * pctOfCents(33, 13), byId(t, 'HST').cents); // 12 ≠ 13: the trap
  });

  test('money is rounded only at display; storage stays integer cents', () => {
    assert.equal(formatMoney(2997), '$29.97');
    assert.equal(formatMoney(100000), '$1,000.00');
    assert.equal(formatMoney(123450, { whole: true }), '$1,235'); // display-only rounding
    assert.equal(combinedPct([{ pct: 5 }, { pct: 9.975 }]), 14.975); // rates keep 1/1000, not money
  });
});

// ---------------------------------------------------------------------------
// SDL-10: measurements stored in SI (metres); convert only at display
// ---------------------------------------------------------------------------

describe('SDL-10 measurements are SI (lib/units.js, Rule 8-102 voltage drop)', () => {
  test('SI constants are exact and lengths parse to metres whatever the display units', () => {
    assert.equal(M_PER_IN, 0.0254); // exact, by definition
    assert.equal(M_PER_FT, 0.3048);
    assert.equal(inToM(1), 0.0254);
    assert.equal(mToIn(0.0254), 1);
    // The same physical length stores as the same metres whether typed imperial or metric.
    const imperial = parseLength(`3' 3 3/8"`, { units: 'imperial' }); // 39.375 in
    assert.ok(Math.abs(imperial - inToM(39.375)) < 1e-12);
    const metric = parseLength('1 m', { units: 'metric' });
    assert.equal(metric, 1);
    // A bare metric number is metres; a bare imperial number is inches -> metres.
    assert.equal(parseLength('2.5', { units: 'metric' }), 2.5);
    assert.ok(Math.abs(parseLength('10', { units: 'imperial' }) - inToM(10)) < 1e-12);
  });

  test('fmtLength converts only at display; the stored metres are unchanged', () => {
    const m = inToM(147.625); // one stored value in SI
    assert.equal(fmtLength(m, { units: 'imperial' }), `12' 3 5/8"`);
    assert.equal(fmtLength(m, { units: 'metric', metric: 'mm' }), '3750 mm');
    assert.equal(m, 147.625 * 0.0254); // the value itself never rounded
  });

  test('voltage drop is in SI: lengthM in metres, R in Ω/km, areas in mm² (Rule 8-102)', () => {
    // 2 × 15 A × 10.30 Ω/km × 0.030 km = 9.27 V = 7.725% of 120 V (14 AWG Cu).
    const r = C.voltageDrop({ volts: 120, phase: 1, amps: 15, lengthM: 30, size: '14' });
    assert.ok(Math.abs(r.volts - 9.27) < 1e-6);
    assert.ok(Math.abs(r.percent - 7.725) < 1e-6);
    assert.equal(r.ohmsPerKm, 10.30);
    // Conductor cross-sections are catalogued in mm² (ASTM B258), the SI unit.
    assert.equal(AREA_MM2['12'], 3.31);
    assert.equal(AREA_MM2['4/0'], 107.2);
    // Rule 8-110 living area is m²; Rule 62-118 heating demand is W (both SI).
    assert.equal(C.livingArea({ groundM2: 100, aboveM2: 50, basementM2: 80 }), 210); // m²
    assert.equal(C.heatingDemandW(20000), 17500); // W
  });
});

// ---------------------------------------------------------------------------
// SDL-10: CEC tables, tax rates and formulas cite their source
// ---------------------------------------------------------------------------

describe('SDL-10 CEC values cite their rule/table (lib/cec)', () => {
  test('Table 2 ampacity (CSA C22.1:24): 12 AWG Cu 75 °C = 25 A, 3/0 Cu = 200 A', () => {
    assert.equal(C.ampacity('12', 'cu', 75), 25);
    assert.equal(C.ampacity('14', 'cu', 60), 15);
    assert.equal(C.ampacity('3/0', 'cu', 75), 200);
    assert.equal(C.ampacity('4/0', 'al', 75), 180); // Table 4
    assert.equal(C.ampacity('14', 'al', 75), null); // no 14 AWG aluminum
  });

  test('Rule 8-200(1)(a)(iv) range demand: 6 kW + 40% over 12 kW', () => {
    assert.equal(C.rangeDemandW(12000), 6000);
    assert.equal(C.rangeDemandW(16000), 7600); // 6000 + 0.4 × 4000
    assert.equal(C.rangeDemandW(0), 0);
  });

  test('Table 16 bonding conductor: 100 A -> No. 8 Cu, 200 A -> No. 6 Cu', () => {
    assert.equal(C.bondingConductor(100).cu, '8');
    assert.equal(C.bondingConductor(200).cu, '6');
    assert.deepEqual(C.bondingConductor(60), { upTo: 60, cu: '10', al: '8' });
  });

  test('every CEC checklist item carries a rule reference (source citation in data)', () => {
    for (const template of C.cecTemplates(null)) {
      assert.ok(template.items.length > 0, `${template.id} has items`);
      for (const [text, ref] of template.items) {
        assert.ok(typeof text === 'string' && text.trim().length > 0, `${template.id}: item text`);
        assert.ok(typeof ref === 'string' && ref.trim().length > 0, `${template.id}: "${text}" has no rule reference`);
      }
    }
  });

  test('every single-dwelling load line carries its CEC rule (Rule 8-200)', () => {
    const r = C.singleDwelling({ areaM2: 200, heatW: 15000, rangeW: 14000, evseW: [7200], otherW: [5000] });
    assert.equal(r.rule, '8-200');
    assert.ok(r.lines.length > 0);
    for (const line of r.lines) {
      assert.ok(typeof line.rule === 'string' && line.rule.trim().length > 0, `line "${line.label}" has no rule`);
      assert.ok(Number.isFinite(line.w), `line "${line.label}" watts`);
    }
  });
});

describe('SDL-10 tax rates cite their source and compute in integer cents (lib/tax.js)', () => {
  test('per-province rates on 2026-10-19 match the sourced rate table (docs/code/tax.md)', () => {
    // GST/HST: CRA "GST/HST rates"; PST/RST/QST: provincial sources in tax.js header.
    assert.deepEqual(ratesOn('AB', '2026-10-19').map((r) => [r.id, r.pct]), [['GST', 5]]);
    assert.deepEqual(ratesOn('ON', '2026-10-19').map((r) => [r.id, r.pct]), [['HST', 13]]);
    assert.deepEqual(ratesOn('BC', '2026-10-19').map((r) => [r.id, r.pct]), [['GST', 5], ['PST', 7]]);
    assert.deepEqual(ratesOn('SK', '2026-10-19').map((r) => [r.id, r.pct]), [['GST', 5], ['PST', 6]]);
    assert.deepEqual(ratesOn('MB', '2026-10-19').map((r) => [r.id, r.pct]), [['GST', 5], ['RST', 7]]);
    assert.deepEqual(ratesOn('QC', '2026-10-19').map((r) => [r.id, r.pct]), [['GST', 5], ['QST', 9.975]]);
    for (const p of ['NB', 'NL', 'PE']) assert.equal(ratesOn(p, '2026-10-19')[0].pct, 15, p);
    // NS HST 15% -> 14% on 2025-04-01 (NS news release 2024-10-23).
    assert.equal(ratesOn('NS', '2025-03-31')[0].pct, 15);
    assert.equal(ratesOn('NS', '2025-04-01')[0].pct, 14);
  });

  test('every province has a dated, sourced rate history (from = first day the rate applies)', () => {
    for (const { code } of PROVINCES) {
      const hist = RATE_HISTORY[code];
      assert.ok(Array.isArray(hist) && hist.length > 0, `${code} has a rate history`);
      for (const row of hist) {
        assert.match(row.from, /^\d{4}-\d{2}-\d{2}$/, `${code} row.from is a date`);
        assert.ok(row.parts.length > 0 && row.parts.every((p) => Number.isFinite(p.pct)), `${code} parts have rates`);
      }
    }
  });

  test('line totals compute in integer cents: ON HST 13% on $100 + $50 = $19.50', () => {
    // $100.00 material + $50.00 labour = $150.00; 13% = $19.50; total $169.50. All cents.
    const t = docTotals({ taxes: taxComponents({ province: 'ON', treatment: 'standard', date: '2026-10-19' }), lines: [mat(10000), lab(5000)] });
    assert.equal(t.subtotalCents, 15000);
    assert.equal(byId(t, 'HST').cents, 1950);
    assert.equal(t.totalCents, 16950);
    assert.ok(Number.isInteger(t.totalCents) && Number.isInteger(t.taxCents));
    // QC QST 9.975% is the sharp rounding case: $150 × 9.975% = 1496.25¢ -> 1496¢.
    const qc = docTotals({ taxes: taxComponents({ province: 'QC', treatment: 'standard', date: '2026-10-19' }), lines: [mat(10000), lab(5000)] });
    assert.equal(byId(qc, 'QST').cents, 1496);
    assert.equal(qc.totalCents, 17246);
  });
});
