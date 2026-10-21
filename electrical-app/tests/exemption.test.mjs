// Tax exemptions on documents (js/lib/exemption.js, docs/releases/r1-get-paid.md 2.9).
// Run: node --test electrical-app/tests/*.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EXEMPT_BASES, EXEMPT_EVIDENCE, provincialTaxOff, exemptionProblem, exemptionFor, exemptionPrintLines, missingEvidence } from '../js/lib/exemption.js';

const NONE = { material: false, labour: false, other: false };
const ALL = { material: true, labour: true, other: true };
const mbTaxes = (rst) => [{ id: 'GST', pct: 5, applies: ALL }, { id: 'RST', pct: 7, applies: rst }];
const mbInvoice = (o = {}) => ({ taxProvince: 'MB', taxTreatment: 'gst-only', taxes: mbTaxes(NONE), lines: [{ kind: 'labour', qty: 8, unitCents: 9500 }, { kind: 'material', qty: 1, unitCents: 5000 }], ...o });

describe('provincialTaxOff', () => {
  test('RST off on every work line; special and pass-through lines are not counted', () => {
    assert.equal(provincialTaxOff(mbInvoice()), true);
    assert.equal(provincialTaxOff(mbInvoice({ taxes: mbTaxes(ALL), taxTreatment: 'pst-all' })), false);
    // RST on, but one pass-through line with taxOff: still charged on the work.
    assert.equal(provincialTaxOff(mbInvoice({ taxes: mbTaxes(ALL), lines: [{ kind: 'labour', qty: 1, unitCents: 1 }, { kind: 'other', passThrough: true, taxOff: ['PST', 'RST'] }] })), false);
    // Only special lines: nothing to judge.
    assert.equal(provincialTaxOff(mbInvoice({ lines: [{ kind: 'other', lineType: 'deposit', qty: 1, unitCents: -100 }] })), false);
    assert.equal(provincialTaxOff(mbInvoice({ lines: [{ kind: 'other', passThrough: true, taxOff: ['PST', 'RST'] }] })), false);
  });
});

describe('exemptionProblem', () => {
  test('Manitoba invoices block without evidence; estimates warn', () => {
    const p = exemptionProblem(mbInvoice({ taxExemptBasis: 'subtrade' }));
    assert.equal(p.level, 'block');
    assert.equal(p.code, 'exemption_required');
    assert.deepEqual(p.missing, ['number']);
    assert.equal(exemptionProblem(mbInvoice({ taxExemptBasis: 'subtrade', taxExemptNumber: '1234567' })), null);
    assert.deepEqual(exemptionProblem(mbInvoice()).missing, ['basis']);
    assert.equal(exemptionProblem(mbInvoice(), { docType: 'estimates' }).level, 'warn');
    assert.equal(exemptionProblem(mbInvoice({ taxes: mbTaxes(ALL) })), null, 'RST charged');
  });

  test('BC and SK warn; other provinces and BC real-property contracts are not checked', () => {
    const bc = { taxProvince: 'BC', taxTreatment: 'gst-only', taxes: [{ id: 'GST', pct: 5, applies: ALL }, { id: 'PST', pct: 7, applies: NONE }], lines: [{ kind: 'material', qty: 1, unitCents: 1 }] };
    assert.equal(exemptionProblem(bc).level, 'warn');
    assert.equal(exemptionProblem({ ...bc, taxProvince: 'SK' }).level, 'warn');
    assert.match(exemptionProblem(bc).message, /PST is not charged/);
    assert.equal(exemptionProblem({ ...bc, taxTreatment: 'real-property' }), null, 'real property is not an exemption');
    assert.equal(exemptionProblem({ ...bc, taxProvince: 'ON', taxes: [{ id: 'HST', pct: 13, applies: ALL }] }), null);
  });

  test('evidence per basis, First Nations registry number included', () => {
    const fn = (d) => exemptionProblem(mbInvoice({ taxTreatment: 'none', taxes: [], taxNoneReason: 'relief', taxExemptBasis: 'first-nations', taxExemptDetails: d }));
    assert.deepEqual(fn({}).missing, ['registryNo', 'band']);
    assert.deepEqual(fn({ registryNo: '1234567890' }).missing, ['band']);
    assert.equal(fn({ registryNo: '1234567890', reserve: 'Peguis 1B' }), null);
    assert.equal(fn({ registryNo: '1234567890', band: 'Peguis First Nation' }), null);
    assert.deepEqual(missingEvidence({ taxExemptBasis: 'pass-on', taxExemptNumber: '7654321' }), ['endCustomer']);
    assert.deepEqual(missingEvidence({ taxExemptBasis: 'federal', taxExemptNumber: '1' }), ['department']);
    assert.deepEqual(missingEvidence({ taxExemptBasis: 'farm' }), ['farmCertNo']);
    assert.deepEqual(missingEvidence({ taxExemptBasis: 'resale', taxExemptNumber: ' ' }), ['number']);
    for (const b of EXEMPT_BASES) assert.ok(EXEMPT_EVIDENCE[b.id], b.id);
  });

  test('interest, credit notes, release invoices and security deposits are skipped', () => {
    for (const kind of ['interest', 'credit', 'holdback-release']) assert.equal(exemptionProblem(mbInvoice({ kind })), null, kind);
    assert.equal(exemptionProblem(mbInvoice({ kind: 'deposit', depositModel: 'security' })), null);
    assert.equal(exemptionProblem(mbInvoice({ kind: 'deposit', depositModel: 'prepayment' })).level, 'block');
    assert.equal(exemptionProblem(mbInvoice({ lines: [] })), null);
    assert.equal(exemptionProblem(null), null);
  });
});

describe('the job says, the client card is evidence', () => {
  test('exemptionFor takes the job, never the client alone', () => {
    const job = { taxExempt: { basis: 'pass-on', number: '7654321', endCustomer: 'Canada Post', details: { name: 'x' } } };
    assert.deepEqual(exemptionFor({ job, client: {}, province: 'MB' }), { taxExemptNumber: '7654321', taxExemptBasis: 'pass-on', taxExemptDetails: { name: 'x', endCustomer: 'Canada Post' } });
    assert.deepEqual(exemptionFor({ job: {}, client: { taxExemptBasis: 'subtrade', taxExemptNumber: '1' }, province: 'MB' }), {});
    assert.deepEqual(exemptionFor({}), {});
  });

  test('print lines', () => {
    assert.deepEqual(exemptionPrintLines({ taxProvince: 'MB', taxExemptBasis: 'subtrade', taxExemptNumber: '1234567' }), ['RST exemption: Electrical or mechanical subtrade, RST no. 1234567']);
    assert.deepEqual(exemptionPrintLines({ taxProvince: 'MB', taxExemptBasis: 'pass-on', taxExemptNumber: '7654321', taxExemptDetails: { endCustomer: 'Canada Post' } }),
      ["RST exemption: General contractor passing on its customer's exemption, RST no. 7654321", 'End customer: Canada Post']);
    assert.deepEqual(exemptionPrintLines({ taxProvince: 'SK', taxExemptBasis: 'farm', taxExemptDetails: { farmCertNo: 'F-9' } }), ['PST exemption: Farm use (certificate)', 'Farm certificate no. F-9']);
    assert.deepEqual(exemptionPrintLines({}), []);
  });
});
