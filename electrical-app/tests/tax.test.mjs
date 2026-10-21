// Run: node --test electrical-app/tests/
// Canadian sales tax and document totals. Expected values worked by hand in the comments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../js/lib/tax.js';
import { docTotals, pctOfCents, formatMoney, combinedPct } from '../js/lib/money.js';

const mat = (cents) => ({ description: 'Material', qty: 1, unitCents: cents, kind: 'material' });
const lab = (cents) => ({ description: 'Labour', qty: 1, unitCents: cents, kind: 'labour' });
const doc = (province, treatment, lines, extra = {}) => ({ lines, taxes: T.taxComponents({ province, treatment, date: '2026-10-19' }), ...extra });
const byId = (t, id) => t.taxes.find((x) => x.id === id);

test('rates in force by province and date', () => {
  assert.deepEqual(T.ratesOn('ON', '2026-10-19').map((r) => [r.id, r.pct]), [['HST', 13]]);
  assert.deepEqual(T.ratesOn('AB', '2026-10-19').map((r) => [r.id, r.pct]), [['GST', 5]]);
  assert.deepEqual(T.ratesOn('BC', '2026-10-19').map((r) => [r.id, r.pct]), [['GST', 5], ['PST', 7]]);
  assert.deepEqual(T.ratesOn('SK', '2026-10-19').map((r) => [r.id, r.pct]), [['GST', 5], ['PST', 6]]);
  assert.deepEqual(T.ratesOn('MB', '2026-10-19').map((r) => [r.id, r.pct]), [['GST', 5], ['RST', 7]]);
  assert.deepEqual(T.ratesOn('QC', '2026-10-19').map((r) => [r.id, r.pct]), [['GST', 5], ['QST', 9.975]]);
  for (const p of ['NB', 'NL', 'PE']) assert.equal(T.ratesOn(p, '2026-10-19')[0].pct, 15, p);
  // Nova Scotia HST dropped from 15% to 14% on 2025-04-01.
  assert.equal(T.ratesOn('NS', '2025-03-31')[0].pct, 15);
  assert.equal(T.ratesOn('NS', '2025-04-01')[0].pct, 14);
  // Manitoba RST dropped from 8% to 7% on 2019-07-01.
  assert.equal(T.ratesOn('MB', '2019-06-30')[1].pct, 8);
  assert.equal(T.ratesOn('MB', '2019-07-01')[1].pct, 7);
  assert.deepEqual(T.ratesOn('XX'), []);
});

test('default treatment per province', () => {
  assert.equal(T.treatmentsFor('ON')[0], 'standard');
  assert.equal(T.treatmentsFor('BC')[0], 'real-property'); // services to real property: no PST charged
  assert.equal(T.treatmentsFor('SK')[0], 'pst-all'); // PST-12: PST on the total charge
  assert.equal(T.treatmentsFor('MB')[0], 'pst-all'); // Bulletin 031: electrical work is taxable TPP
  assert.ok(T.treatmentHint('pst-all', 'MB').includes('Bulletin 031'));
});

test('rounding: half a cent rounds up, QST to 1/1000 %', () => {
  assert.equal(pctOfCents(10, 5), 1); // 0.5 ¢ -> 1 ¢
  assert.equal(pctOfCents(9, 5), 0); // 0.45 ¢ -> 0
  assert.equal(pctOfCents(15000, 9.975), 1496); // 1,496.25 ¢
  assert.equal(pctOfCents(-10, 5), -1); // credits round away from zero too
});

test('old records with only taxPct keep working', () => {
  // $100 material + $50 labour at 8% = $12.00 tax, one "Tax" line
  const t = docTotals({ lines: [mat(10000), lab(5000)], taxPct: 8 });
  assert.equal(t.taxCents, 1200);
  assert.equal(t.totalCents, 16200);
  assert.equal(t.taxes.length, 1);
  assert.equal(t.taxes[0].label, 'Tax');
  assert.equal(docTotals({ lines: [mat(10000)] }).taxCents, 0);
});

test('Ontario HST 13% on everything', () => {
  // $100.00 + $50.00 = $150.00 × 13% = $19.50 -> $169.50
  const t = docTotals(doc('ON', 'standard', [mat(10000), lab(5000)]));
  assert.equal(t.subtotalCents, 15000);
  assert.equal(byId(t, 'HST').cents, 1950);
  assert.equal(t.totalCents, 16950);
});

test('BC real property contract: GST only, PST line notes why', () => {
  // GST 5% × $150 = $7.50; PST not charged
  const t = docTotals(doc('BC', 'real-property', [mat(10000), lab(5000)]));
  assert.equal(byId(t, 'GST').cents, 750);
  assert.equal(byId(t, 'PST').cents, 0);
  assert.equal(byId(t, 'PST').baseCents, 0);
  assert.ok(byId(t, 'PST').note.length > 0);
  assert.equal(t.totalCents, 15750);
});

test('BC goods sold separately: PST on materials only; markup is taxed with materials', () => {
  // GST 5% × $150 = $7.50; PST 7% × $100 = $7.00 -> $164.50
  const t = docTotals(doc('BC', 'separate-goods', [mat(10000), lab(5000)]));
  assert.equal(byId(t, 'PST').cents, 700);
  assert.equal(t.totalCents, 16450);
  // 10% markup on $100 material = $10; PST base $110 -> $7.70; GST on $160 -> $8.00
  const m = docTotals(doc('BC', 'separate-goods', [mat(10000), lab(5000)], { markupPct: 10 }));
  assert.equal(m.markupCents, 1000);
  assert.equal(byId(m, 'PST').cents, 770);
  assert.equal(byId(m, 'GST').cents, 800);
});

test('Saskatchewan and Manitoba: PST/RST on the whole contract, separate lines', () => {
  // SK: GST $7.50 + PST 6% × $150 = $9.00 -> $166.50
  const sk = docTotals(doc('SK', 'pst-all', [mat(10000), lab(5000)]));
  assert.deepEqual(sk.taxes.map((x) => [x.id, x.cents]), [['GST', 750], ['PST', 900]]);
  assert.equal(sk.totalCents, 16650);
  // MB: GST $7.50 + RST 7% × $150 = $10.50 -> $168.00
  const mb = docTotals(doc('MB', 'pst-all', [mat(10000), lab(5000)]));
  assert.deepEqual(mb.taxes.map((x) => [x.id, x.cents]), [['GST', 750], ['RST', 1050]]);
  assert.equal(mb.totalCents, 16800);
});

test('Quebec: GST + QST 9.975%, QST not on GST', () => {
  // $150 × 5% = $7.50; $150 × 9.975% = $14.9625 -> $14.96; total $172.46
  const t = docTotals(doc('QC', 'standard', [mat(10000), lab(5000)]));
  assert.equal(byId(t, 'QST').cents, 1496);
  assert.equal(t.totalCents, 17246);
});

test('each tax is rounded once per document, not per line', () => {
  // three 33 ¢ lines: 99 ¢ × 13% = 12.87 ¢ -> 13 ¢ (per line would be 4 + 4 + 4 = 12 ¢)
  const t = docTotals(doc('ON', 'standard', [mat(33), mat(33), mat(33)]));
  assert.equal(t.taxCents, 13);
});

test('no tax treatment', () => {
  assert.deepEqual(T.taxComponents({ province: 'ON', treatment: 'none' }), []);
  assert.equal(docTotals(doc('ON', 'none', [mat(10000)])).totalCents, 10000);
});

test('company set-up: defaults for old settings, custom rates, legacy taxPct', () => {
  // A settings record from before tax.js: no province, no tax block
  const old = T.taxSetup({ taxPct: 8 });
  assert.equal(old.province, 'ON');
  assert.equal(old.treatment, 'standard');
  const bc = T.newDocTax({ company: { province: 'BC' } }, '2026-10-19');
  assert.equal(bc.taxTreatment, 'real-property');
  assert.equal(bc.taxPct, 5); // PST taxes nothing under this treatment
  const custom = T.newDocTax({ company: { province: 'ON' }, tax: { mode: 'custom', custom: [{ label: 'GST', pct: 5 }, { label: 'Levy', pct: 2, applies: { labour: false } }] } });
  assert.equal(custom.taxTreatment, 'custom');
  assert.equal(custom.taxes.length, 2);
  // $100 material + $50 labour: GST $7.50, levy 2% × $100 = $2.00
  const t = docTotals({ lines: [mat(10000), lab(5000)], taxes: custom.taxes });
  assert.deepEqual(t.taxes.map((x) => x.cents), [750, 200]);
  assert.equal(combinedPct([{ pct: 5 }, { pct: 9.975 }]), 14.975);
});

test('describe taxes and registration numbers', () => {
  assert.equal(T.describeTaxes(T.taxComponents({ province: 'SK', treatment: 'pst-all' })), 'GST 5% + PST 6%');
  assert.equal(T.describeTaxes(T.taxComponents({ province: 'BC', treatment: 'real-property' })), 'GST 5%');
  assert.equal(T.describeTaxes([]), 'No tax');
  assert.ok(T.isGstHstNumber('123456789 RT0001'));
  assert.ok(T.isGstHstNumber('123456789RT0001'));
  assert.ok(!T.isGstHstNumber('12345678 RT0001'));
});

test('money prints Canadian English', () => {
  assert.equal(formatMoney(123450), '$1,234.50');
  assert.equal(formatMoney(123450, { whole: true }), '$1,235');
  assert.equal(formatMoney(123450, { currency: 'USD' }), 'US$1,234.50');
});

test('PST/RST exempt, GST charged: offered in every PST/RST province, GST on everything', () => {
  for (const p of ['BC', 'SK', 'MB']) {
    assert.ok(T.treatmentsFor(p).includes('gst-only'), p);
    assert.equal(T.treatmentsFor(p).at(-1), 'none', p); // "No tax" stays last
  }
  for (const p of ['ON', 'AB', 'QC', 'NS']) assert.ok(!T.treatmentsFor(p).includes('gst-only'), p);
  // MB: $100 material + $50 labour, GST 5% = $7.50, no RST -> $157.50
  const mb = docTotals(doc('MB', 'gst-only', [mat(10000), lab(5000)]));
  assert.deepEqual(mb.taxes.map((x) => [x.id, x.cents]), [['GST', 750], ['RST', 0]]);
  assert.equal(mb.totalCents, 15750);
  assert.ok(byId(mb, 'RST').note.length > 0); // says why RST is not charged
  assert.equal(T.describeTaxes(T.taxComponents({ province: 'SK', treatment: 'gst-only' })), 'GST 5%');
  assert.equal(T.describeTaxes(T.taxComponents({ province: 'BC', treatment: 'gst-only' })), 'GST 5%');
  // The default treatment is unchanged; a company may pick gst-only as its default
  assert.equal(T.taxSetup({ company: { province: 'MB' } }).treatment, 'pst-all');
  assert.equal(T.taxSetup({ company: { province: 'MB' }, tax: { treatment: 'gst-only' } }).treatment, 'gst-only');
  assert.equal(T.newDocTax({ company: { province: 'MB' }, tax: { treatment: 'gst-only' } }, '2026-10-19').taxPct, 5);
});

test('"No tax" no longer suggests it for PST/RST licence holders, and names the reasons', () => {
  for (const p of ['ON', 'BC', 'SK', 'MB']) {
    const hint = T.treatmentHint('none', p);
    assert.doesNotMatch(hint, /licensed contractor|quoting their PST/i, p);
    assert.match(hint, /zero-rated, exempt or out-of-scope/, p);
  }
  assert.match(T.treatmentHint('none', 'MB'), /still pays GST/);
  assert.deepEqual(T.TAX_NONE_REASONS.map((r) => r.id), ['zero', 'exempt', 'out_of_scope', 'relief']);
});

// ---- Release 1: RST fixes (docs/releases/r1-get-paid.md 3.1, 3.4) ----

test('PST/RST exempt hints say who qualifies, per province', () => {
  const mb = T.treatmentHint('gst-only', 'MB');
  assert.match(mb, /^Manitoba: only when the customer is another electrical or mechanical contractor subcontracting this work to you/);
  assert.match(mb, /A general contractor on an ordinary building job pays RST \(Bulletins 031, 005\)/);
  assert.match(mb, /record it on the job and their 7-digit RST number on the invoice \(Bulletin 004\)/);
  assert.match(mb, /Travel time and permits are part of the taxable price\./);
  assert.match(T.treatmentHint('gst-only', 'SK'), /^Saskatchewan: only when the customer gives a PST vendor’s licence or exemption for this work.*Bulletin PST-12/);
  assert.equal(T.treatmentHint('gst-only', 'BC'), 'British Columbia: only for a customer who gives a PST number for goods they will resell. Record the number on the invoice.');
  assert.doesNotMatch(mb, /buying for resale\)/, 'the old "for example a contractor buying for resale" hint is gone in MB');
  // "No tax" in Manitoba is for First Nations relief; everyone else exempt still pays GST.
  assert.match(T.treatmentHint('none', 'MB'), /Indian Act s\.87/);
  assert.match(T.treatmentHint('none', 'MB'), /federal government, a farm certificate or a general contractor passing on an exemption still pays GST/);
});

test('job exemptions store who confirmed them as a name (jobs.taxExempt.confirmedBy is a string)', () => {
  const client = { taxExemptBasis: 'pass-on', taxExemptNumber: '1234567', taxExemptDetails: { endCustomer: 'Canada Post', note: 'cert on file' } };
  const x = T.jobTaxExemptFrom({ client, by: { id: 'u1', name: 'Pat Office' }, province: 'MB', at: '2026-10-20T10:00:00Z' });
  assert.equal(x.confirmedBy, 'Pat Office', 'the name, never the { id, name } object');
  assert.equal(typeof x.confirmedBy, 'string');
  assert.equal(x.province, 'MB');
  assert.deepEqual({ basis: x.basis, number: x.number, endCustomer: x.endCustomer, at: x.confirmedAt }, { basis: 'pass-on', number: '1234567', endCustomer: 'Canada Post', at: '2026-10-20T10:00:00Z' });
  assert.deepEqual(Object.keys(x.details).sort(), ['band', 'department', 'farmCertNo', 'name', 'registryNo', 'reserve'], 'only the schema detail fields');
  assert.equal(T.jobTaxExemptFrom({}).basis, null, 'no evidence on file: the office fills it in');
  // Older copies kept the object; both read as the name, capped at the schema's 128.
  assert.equal(T.confirmedByName({ id: 'u1', name: 'Pat' }), 'Pat');
  assert.equal(T.confirmedByName('  Pat  '), 'Pat');
  assert.equal(T.confirmedByName(null), null);
  assert.equal(T.confirmedByName('x'.repeat(200)).length, 128);
  const job = { taxExempt: { ...x, confirmedBy: { name: 'Lee' } } };
  assert.deepEqual(T.exemptionConfirmedFromJob(job), { by: 'Lee', at: '2026-10-20T10:00:00Z', from: 'job' });
});

test('newDocTax: a job exemption defaults to gst-only with its snapshot; client evidence alone does not', () => {
  const s = { company: { province: 'MB' } };
  const job = { id: 'j1', taxExempt: { basis: 'subtrade', number: '1234567', confirmedBy: { name: 'Pat' }, confirmedAt: '2026-10-20T10:00:00Z' } };
  const t = T.newDocTax(s, '2026-10-20', { job });
  assert.equal(t.taxTreatment, 'gst-only');
  assert.equal(t.taxPct, 5);
  assert.equal(t.taxExemptBasis, 'subtrade');
  assert.equal(t.taxExemptNumber, '1234567');
  assert.deepEqual(t.taxExemptDetails, {});
  assert.deepEqual(t.exemptionConfirmed, { by: 'Pat', at: '2026-10-20T10:00:00Z', from: 'job' }, 'who said the job is exempt comes along');
  // A GC passing on its customer's exemption: the end customer comes with it.
  const passOn = T.newDocTax(s, '2026-10-20', { job: { taxExempt: { basis: 'pass-on', number: '7654321', endCustomer: 'Canada Post' } } });
  assert.equal(passOn.taxTreatment, 'gst-only');
  assert.equal(passOn.taxExemptDetails.endCustomer, 'Canada Post');
  // First Nations on reserve: no GST and no RST, reason relief.
  const fn = T.newDocTax(s, '2026-10-20', { job: { taxExempt: { basis: 'first-nations', details: { registryNo: '1234567890', band: 'Peguis', reserve: 'Peguis 1B' } } } });
  assert.equal(fn.taxTreatment, 'none');
  assert.equal(fn.taxNoneReason, 'relief');
  assert.deepEqual(fn.taxes, []);
  // The client has evidence on file, but the job does not say the work is exempt: RST is charged.
  const client = { id: 'c1', taxExemptBasis: 'subtrade', taxExemptNumber: '1234567', taxExemptProvince: 'MB' };
  const plain = T.newDocTax(s, '2026-10-20', { client, job: { id: 'j2' } });
  assert.equal(plain.taxTreatment, 'pst-all');
  assert.equal(plain.taxPct, 12);
  assert.equal(plain.taxExemptBasis, undefined);
  assert.equal(T.newDocTax(s, '2026-10-20', { client }).taxTreatment, 'pst-all');
  // Without a job or client nothing changes; outside the PST provinces an exemption is ignored.
  assert.deepEqual(T.newDocTax(s, '2026-10-20'), T.newDocTax(s, '2026-10-20', {}));
  assert.equal(T.newDocTax({ company: { province: 'ON' } }, '2026-10-20', { job }).taxTreatment, 'standard');
  // Custom rates stay custom.
  assert.equal(T.newDocTax({ company: { province: 'MB' }, tax: { mode: 'custom', custom: [{ label: 'GST', pct: 5 }] } }, '2026-10-20', { job }).taxTreatment, 'custom');
});

test('the out-of-pocket preset and the provincial tax names', () => {
  const p = T.TAX_OFF_PRESETS.find((x) => x.id === 'pass-through');
  assert.equal(p.label, 'Out-of-pocket disbursement at cost (hotel, meals; not travel time or permits)');
  assert.equal(p.kind, 'other');
  assert.equal(p.passThrough, true);
  assert.deepEqual(p.taxOff, ['PST', 'RST']);
  assert.equal(p.warning, 'Travel time and permits are taxable. Use a normal line for them.');
  assert.equal(p.printSuffix, '(at cost, no RST)');
  assert.deepEqual(['MB', 'BC', 'SK', 'QC', 'ON'].map((p) => T.provincialTaxId(p)), ['RST', 'PST', 'PST', 'QST', null]);
});

test('exemption number formats are warnings only', () => {
  assert.equal(T.exemptNumberProblem({ province: 'MB', basis: 'subtrade', number: '123456-7' }), null);
  assert.equal(T.exemptNumberProblem({ province: 'MB', basis: 'subtrade', number: '1234567' }), null);
  assert.match(T.exemptNumberProblem({ province: 'MB', basis: 'subtrade', number: '12345' }), /7 digits; this has 5/);
  assert.match(T.exemptNumberProblem({ province: 'MB', basis: 'resale', number: 'RST1234567' }), /7 digits/);
  assert.equal(T.exemptNumberProblem({ province: 'SK', basis: 'resale', number: '7654321' }), null);
  assert.equal(T.exemptNumberProblem({ province: 'BC', basis: 'resale', number: 'PST-1234-5678' }), null);
  assert.match(T.exemptNumberProblem({ province: 'BC', basis: 'resale', number: '1234' }), /PST-1234-5678/);
  assert.equal(T.exemptNumberProblem({ province: 'MB', basis: 'farm', number: 'anything' }), null);
  assert.equal(T.exemptNumberProblem({ province: 'MB', basis: 'subtrade', number: '' }), null);
});
