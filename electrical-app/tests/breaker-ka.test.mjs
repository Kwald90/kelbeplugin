// Breaker / panelboard interrupting-rating selector (lib/breaker-ka.js): the conservative kA
// recommendation from categorical install conditions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommendBreakerKa, KA_STANDARD, KA_OPTIONS, KA_REFERENCE } from '../js/lib/breaker-ka.js';

test('the recommended rating is always one of the standard ratings', () => {
  for (const b of KA_OPTIONS.building) for (const x of KA_OPTIONS.xfmr) {
    const r = recommendBreakerKa({ building: b.value, xfmr: x.value, location: 'service', distance: '25', conductor: '250', source: 'typical', motor: 'no' });
    assert.ok(KA_STANDARD.includes(r.rating), `${b.value}/${x.value} -> ${r.rating}`);
  }
});

test('a far residential branch on a weak rural source lands at 10 kA', () => {
  const r = recommendBreakerKa({ building: 'res', location: 'branch-far', xfmr: '50', distance: '25', conductor: '6', source: 'weak', motor: 'no' });
  assert.equal(r.rating, 10);
  assert.ok(r.estimateKa < 10);
});

test('a typical residential service lands at 22 kA', () => {
  const r = recommendBreakerKa({ building: 'res', location: 'service', xfmr: 'unknown', distance: '25', conductor: '4/0', source: 'typical', motor: 'no' });
  assert.equal(r.rating, 22);
});

test('a service close to a 150–300 kVA transformer lands at 25 kA', () => {
  const r = recommendBreakerKa({ building: 'comm', location: 'service', xfmr: '300', distance: '25', conductor: '250', source: 'typical', motor: 'no' });
  assert.equal(r.rating, 25);
});

test('a very large transformer with major motors flags an engineering review', () => {
  const r = recommendBreakerKa({ building: 'ind', location: 'service', xfmr: '1500', distance: '25', conductor: 'parallel', source: 'strong', motor: 'big' });
  assert.equal(r.engineeringReview, true);
  assert.equal(r.rating, 65);
  assert.ok(r.estimateKa > 65);
});

test('impedance monotonicity: more distance never raises the recommendation', () => {
  const at = (distance) => recommendBreakerKa({ building: 'comm', location: 'service', xfmr: '500', distance, conductor: '4/0', source: 'typical', motor: 'no' }).estimateKa;
  assert.ok(at('25') >= at('50') && at('50') >= at('100') && at('100') >= at('200'));
});

test('unknown inputs fall back to conservative defaults, not NaN', () => {
  const r = recommendBreakerKa({});
  assert.ok(Number.isFinite(r.estimateKa) && KA_STANDARD.includes(r.rating));
});

test('every reference row maps to a real standard rating', () => {
  for (const row of KA_REFERENCE) assert.ok(KA_STANDARD.includes(parseInt(row.rating, 10)), row.rating);
});
