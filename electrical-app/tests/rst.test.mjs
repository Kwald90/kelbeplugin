// Purchase tax per bill line and the RST self-assessment view (js/lib/rst.js, docs/releases/r1-get-paid.md
// 3.5): the single default for resale or own use (an M&E subtrade's work is resale), each line's share
// of the RST on the bill, the resale-credit flag and its write-off, and the worksheet: own-use moves and
// requests self-assessed at the rate on the day, out-of-province own-use bill lines, supplier credits to
// claim, and nothing counted twice.
// Run: node --test electrical-app/tests/*.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../js/lib/rst.js';

describe('tax use per bill line', () => {
  test('one default: material resale, an M&E subtrade resale, other subcontracts, equipment and other own use; the line wins', () => {
    assert.equal(R.billLineTaxUse({ costType: 'material' }), 'resale');
    assert.equal(R.billLineTaxUse({}), 'resale', 'missing cost type is material');
    assert.equal(R.billLineTaxUse({ costType: 'subcontract' }, { vendor: { meSubtrade: true } }), 'resale');
    assert.equal(R.billLineTaxUse({ costType: 'subcontract' }, { vendor: { meSubtrade: false } }), 'own-use');
    assert.equal(R.billLineTaxUse({ costType: 'equipment' }), 'own-use');
    assert.equal(R.billLineTaxUse({ costType: 'other' }), 'own-use');
    assert.equal(R.billLineTaxUse({ costType: 'material', taxUse: 'own-use' }), 'own-use');
  });

  test('each line carries its share of the RST; resale lines are flagged, own-use lines carry it in cost', () => {
    const bill = { lines: [{ costType: 'material', amountCents: 10000 }, { costType: 'other', amountCents: 5000 }, { costType: 'material', amountCents: 1 }],
      taxes: [{ id: 'GST', cents: 750 }, { id: 'RST', cents: 1051 }] };
    const c = R.billLineCosts(bill);
    assert.equal(c.reduce((s, x) => s + x.rstCents, 0), 1051, 'shares add up to the printed RST');
    assert.deepEqual(c.map((x) => [x.taxUse, x.flagged]), [['resale', true], ['own-use', false], ['resale', false]]);
    assert.equal(c[0].costCents, 10000, 'resale RST is recoverable, never cost');
    assert.equal(c[1].costCents, 5000 + c[1].rstCents);
    const off = R.billLineCosts({ ...bill, lines: [{ ...bill.lines[0], resaleCreditWrittenOff: { by: 'Dana', at: '2026-10-01' } }, ...bill.lines.slice(1)] });
    assert.equal(off[0].flagged, false);
    assert.equal(off[0].costCents, 10000 + off[0].rstCents);
  });

  test('spread keeps every cent', () => {
    assert.deepEqual(R.spread(100, [1, 1, 1]), [34, 33, 33]);
    assert.deepEqual(R.spread(-10, [1, 1, 1]), [-4, -3, -3]);
    assert.deepEqual(R.spread(5, [0, 0]), [0, 0]);
  });
});

describe('the RST self-assessment worksheet', () => {
  const jobs = [{ id: 'jw', kind: 'warranty' }, { id: 'jn', billable: false }, { id: 'j1', kind: 'standard' }];
  const items = [{ id: 'i1', name: 'Wire', costCents: 1000 }];
  const stockMoves = [
    { id: 'm-war', itemId: 'i1', fromLocationId: 'van', qty: 2, jobId: 'jw', date: '2026-09-10', unitCostCents: 1200 }, // warranty: own use
    { id: 'm-shop', itemId: 'i1', fromLocationId: 'shop', qty: 1, date: '2026-09-11', use: 'own-use', ownUseReason: 'shop', unitCostCents: 1000 },
    { id: 'm-job', itemId: 'i1', fromLocationId: 'van', qty: 5, jobId: 'j1', date: '2026-09-12', unitCostCents: 1000 }, // resale
    { id: 'm-adj', itemId: 'i1', fromLocationId: 'van', qty: 3, date: '2026-09-12', use: 'adjust', countId: 'c1' }, // shrinkage: never
    { id: 'm-old', itemId: 'i1', fromLocationId: 'van', qty: 1, jobId: 'jw', date: '2026-08-31', unitCostCents: 1000 }, // last month
  ];
  const materialRequests = [
    { id: 'r-war', jobId: 'jn', description: 'Fitting', qty: 4, costCents: 500, status: 'fulfilled', fulfilledAt: '2026-09-15T12:00:00Z' },
    { id: 'r-moved', jobId: 'jw', itemId: 'i1', qty: 2, status: 'fulfilled', fulfilledAt: '2026-09-10T12:00:00Z', stockMoveId: 'm-war' }, // counted by its move
    { id: 'r-billed', jobId: 'jw', itemId: 'i1', qty: 2, status: 'fulfilled', fulfilledAt: '2026-09-10T12:00:00Z' }, // covered by bill b-ab
  ];
  const bills = [
    { id: 'b-ab', vendorId: 'v-ab', status: 'open', date: '2026-09-14', materialRequestIds: ['r-billed'], lines: [{ costType: 'other', description: 'Shop heater (Alberta)', amountCents: 20000 }], taxes: [{ id: 'GST', cents: 1000 }] },
    { id: 'b-mb', vendorId: 'v-mb', status: 'open', date: '2026-09-15', lines: [{ costType: 'other', description: 'Ladder', amountCents: 10000 }], taxes: [{ id: 'GST', cents: 500 }, { id: 'RST', cents: 700 }] },
    { id: 'b-resale', vendorId: 'v-mb', status: 'paid', date: '2026-09-16', lines: [{ costType: 'material', description: 'Wire for J-1', amountCents: 30000 }], taxes: [{ id: 'GST', cents: 1500 }, { id: 'RST', cents: 2100 }] },
    { id: 'b-draft', vendorId: 'v-ab', status: 'draft', date: '2026-09-16', lines: [{ costType: 'other', amountCents: 99999 }], taxes: [] },
  ];
  const r = R.rstSelfAssessment({ stockMoves, materialRequests, bills, items, jobs, from: '2026-09-01', to: '2026-09-30', province: 'MB' });

  test('own-use stock and requests at cost x 7%, the out-of-province own-use bill line, never shrinkage', () => {
    assert.deepEqual(r.selfAssess.map((x) => [x.source, x.id, x.costCents, x.rstCents]), [
      ['move', 'm-war', 2400, 168], ['move', 'm-shop', 1000, 70], ['bill', 'b-ab', 20000, 1400], ['request', 'r-war', 2000, 140],
    ]);
    assert.equal(r.totals.selfAssessCents, 168 + 70 + 1400 + 140);
  });

  test('a bill line already charged RST is not self-assessed; a resale line charged RST is a credit to claim', () => {
    assert.ok(!r.selfAssess.some((x) => x.id === 'b-mb'));
    assert.deepEqual(r.resaleCredits.map((x) => [x.billId, x.lineIndex, x.rstCents]), [['b-resale', 0, 2100]]);
    assert.equal(r.totals.creditCents, 2100);
  });

  test('a province without a provincial sales tax self-assesses nothing; the CSV lists both sections', () => {
    assert.equal(R.rstSelfAssessment({ stockMoves, materialRequests, bills, items, jobs, from: '2026-09-01', to: '2026-09-30', province: 'ON' }).selfAssess.length, 0);
    const csv = R.rstCsv(r);
    assert.match(csv, /^Section,Date,Source/);
    assert.match(csv, /Supplier credit to claim/);
    assert.match(csv, /Self-assess total,,,,,,254\.00,17\.78/);
  });

  test('own use by job default: warranty, callback and unbilled jobs; a tag wins', () => {
    assert.equal(R.moveIsOwnUse({}, { kind: 'callback' }), true);
    assert.equal(R.moveIsOwnUse({ use: 'job' }, { kind: 'warranty' }), false);
    assert.equal(R.moveIsOwnUse({ use: 'adjust' }, { kind: 'warranty' }), false, 'count adjustments are never own use');
    assert.equal(R.moveIsOwnUse({}, { kind: 'standard' }), false);
  });
});
