// Run: node --test electrical-app/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtLength, fmtInches, parseLength, inToM, getUnits } from '../js/lib/units.js';

const near = (a, b, tol = 1e-9) => assert.ok(a != null && Math.abs(a - b) <= tol, `expected ${b}, got ${a}`);

test('no browser storage falls back to the company default', () => {
  assert.equal(getUnits('imperial'), 'imperial');
  assert.equal(getUnits(), 'metric');
});

test('fmtInches rounds to 1/16 and reduces fractions', () => {
  assert.equal(fmtInches(3.625), '3 5/8"');
  assert.equal(fmtInches(0.5), '1/2"');
  assert.equal(fmtInches(12), '12"');
  assert.equal(fmtInches(2.03), '2"');
  assert.equal(fmtInches(-1.25), '-1 1/4"');
});

test('fmtLength imperial', () => {
  assert.equal(fmtLength(inToM(147.625), { units: 'imperial' }), `12' 3 5/8"`);
  assert.equal(fmtLength(inToM(147.625), { units: 'imperial', feet: false }), '147 5/8"');
  assert.equal(fmtLength(inToM(36), { units: 'imperial' }), `3'`);
  assert.equal(fmtLength(inToM(10.5), { units: 'imperial' }), '10 1/2"');
  assert.equal(fmtLength(null, { units: 'imperial' }), '—');
});

test('fmtLength metric', () => {
  assert.equal(fmtLength(0.45, { units: 'metric' }), '450 mm');
  assert.equal(fmtLength(3.254, { units: 'metric' }), '3.25 m');
  assert.equal(fmtLength(3.254, { units: 'metric', metric: 'mm' }), '3254 mm');
  assert.equal(fmtLength(0.45, { units: 'metric', metric: 'cm' }), '45 cm');
});

test('parseLength reads feet-inches the way people type them', () => {
  near(parseLength(`12' 3 5/8"`), inToM(147.625));
  near(parseLength(`12'3"`), inToM(147));
  near(parseLength('12 ft 3 in'), inToM(147));
  near(parseLength(`3-5/8"`), inToM(3.625));
  near(parseLength('5/8"'), inToM(0.625));
  near(parseLength('147.5"'), inToM(147.5));
  near(parseLength(`12'`), inToM(144));
  near(parseLength(`-2"`), inToM(-2));
  near(parseLength(`12' 3 5/8`), inToM(147.625)); // inch mark left off after feet
});

test('parseLength reads metric', () => {
  near(parseLength('3.2 m'), 3.2);
  near(parseLength('450mm'), 0.45);
  near(parseLength('45 cm'), 0.45);
});

test('bare numbers use the user units unless told otherwise', () => {
  near(parseLength('30 1/2', { units: 'imperial' }), inToM(30.5));
  near(parseLength('3.5', { units: 'metric' }), 3.5);
  near(parseLength('10', { units: 'imperial', bare: 'ft' }), inToM(120));
  near(parseLength('450', { bare: 'mm' }), 0.45);
});

test('parseLength rejects junk', () => {
  assert.equal(parseLength(''), null);
  assert.equal(parseLength('abc'), null);
  assert.equal(parseLength('3 5/'), null);
  assert.equal(parseLength(`12' abc"`), null);
});
