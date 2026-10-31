// Breaker / panelboard interrupting-rating selector (lib/breaker-ka.js): a faithful port of the field
// tool's scoring. These tests pin the scoring to the original so the app gives the same answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommendBreakerKa, KA_STANDARD, KA_OPTIONS, KA_REFERENCE } from '../js/lib/breaker-ka.js';

// The exact weights and thresholds from breaker_ka_value_selector.html, reproduced here independently
// so the test fails if the library ever drifts from the field tool.
const W = {
  building: { res: 0, farm: 1, smallcomm: 2, comm: 3, ind: 4 },
  location: { branch_far: -2, branch: -1, feeder: 1, main: 2, xfmr: 4 },
  xfmr: { small: -1, med: 1, large: 2, xl: 3, xxl: 4, unknown: 1 },
  distance: { close: 2, mid: 0, far: -2, unknown: 1 },
  conductor: { small: -1, med: 0, large: 1, par: 2, unknown: 1 },
  source: { weak: -2, normal: 0, strong: 2, unknown: 1 },
  motor: { no: 0, some: 1, yes: 3, unknown: 1 },
};
const expectRating = (s) => (s <= 1 ? 10 : s <= 3 ? 22 : s <= 5 ? 25 : s <= 7 ? 35 : s <= 9 ? 50 : 65);

test('scoring matches the field tool for every option combination', () => {
  const keys = Object.keys(W);
  const walk = (i, sel) => {
    if (i === keys.length) {
      const score = keys.reduce((a, k) => a + W[k][sel[k]], 0);
      const r = recommendBreakerKa(sel);
      assert.equal(r.score, score, JSON.stringify(sel));
      assert.equal(r.ratingKa, expectRating(score), `rating for score ${score}`);
      return;
    }
    for (const o of KA_OPTIONS[keys[i]]) walk(i + 1, { ...sel, [keys[i]]: o.value });
  };
  walk(0, {});
});

test('the tool opening defaults (res / far branch / small xfmr / close / #6 / weak / none) give 10 kA', () => {
  const r = recommendBreakerKa({ building: 'res', location: 'branch_far', xfmr: 'small', distance: 'close', conductor: 'small', source: 'weak', motor: 'no' });
  assert.equal(r.ratingKa, 10);
  assert.equal(r.level, 'g');
});

test('a worst-case industrial service flags engineering review (65 kA)', () => {
  const r = recommendBreakerKa({ building: 'ind', location: 'xfmr', xfmr: 'xxl', distance: 'close', conductor: 'par', source: 'strong', motor: 'yes' });
  assert.equal(r.engineeringReview, true);
  assert.equal(r.ratingKa, 65);
  assert.equal(r.level, 'r');
});

test('reasons fire for the high-fault drivers, and a fallback when none do', () => {
  const hi = recommendBreakerKa({ building: 'comm', location: 'main', xfmr: 'xl', distance: 'close', conductor: 'par', source: 'strong', motor: 'yes' });
  assert.ok(hi.reasons.length >= 5);
  assert.ok(hi.reasons.some((r) => /high-fault-current location/.test(r)));
  const lo = recommendBreakerKa({ building: 'res', location: 'branch_far', xfmr: 'small', distance: 'far', conductor: 'small', source: 'weak', motor: 'no' });
  assert.deepEqual(lo.reasons, ['Selected conditions indicate a lower available fault-current location.']);
});

test('unknowns push toward a higher conservative rating with a note', () => {
  const r = recommendBreakerKa({ building: 'res', location: 'feeder', xfmr: 'unknown', distance: 'unknown', conductor: 'unknown', source: 'unknown', motor: 'unknown' });
  assert.ok(r.reasons.some((x) => /unknown/i.test(x)));
  assert.ok(KA_STANDARD.includes(r.ratingKa));
});

test('every reference row maps to a real standard rating', () => {
  for (const row of KA_REFERENCE) assert.ok(KA_STANDARD.includes(parseInt(row.rating, 10)), row.rating);
});
