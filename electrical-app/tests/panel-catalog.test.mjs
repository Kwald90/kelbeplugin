// Run: node --test electrical-app/tests/
// Panel catalogue (manufacturer -> line -> size) and the breaker part-number generator. Pure data
// and pure functions; no DOM. The core SKU cases assert exact, known catalogue numbers from the
// research; GFCI/AFCI/dual assert only that they come back flagged for the tech to verify.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PANEL_MANUFACTURERS, DEFAULT, manufacturers, linesFor, sizesFor, catalogEntry,
} from '../js/lib/panel-catalog.js';
import { partNumber, breakerFamilyFor, TYPES } from '../js/lib/breaker-partnumbers.js';

// ---------------------------------------------------------------------------
// Catalogue shape
// ---------------------------------------------------------------------------

test('catalogue entries have the required shape', () => {
  const widths = new Set(['1in', '3/4in', '1/2in']);
  const tandemVals = new Set(['all', 'marked', 'none']);
  assert.ok(PANEL_MANUFACTURERS.length >= 9);
  for (const e of PANEL_MANUFACTURERS) {
    assert.equal(typeof e.manufacturer, 'string');
    assert.equal(typeof e.line, 'string');
    assert.equal(typeof e.breakerFamily, 'string');
    assert.ok(widths.has(e.breakerWidth), `bad width on ${e.manufacturer} ${e.line}`);
    assert.ok(tandemVals.has(e.tandems), `bad tandems on ${e.manufacturer} ${e.line}`);
    assert.equal(typeof e.quad, 'boolean');
    assert.equal(typeof e.region, 'string');
    assert.ok(Array.isArray(e.verify));
    assert.ok(Array.isArray(e.sizes) && e.sizes.length > 0);
    for (const s of e.sizes) {
      assert.equal(typeof s.amps, 'number');
      assert.equal(typeof s.spaces, 'number');
      assert.ok(s.mainType === 'MB' || s.mainType === 'MLO');
      assert.equal(typeof s.busAmps, 'number');
    }
  }
});

test('the required manufacturers and lines are present', () => {
  const pairs = PANEL_MANUFACTURERS.map((e) => `${e.manufacturer} / ${e.line}`);
  for (const want of [
    'Square D / Homeline', 'Square D / QO', 'Eaton / BR', 'Eaton / CH',
    'Siemens / QP', 'GE/ABB / Q-Line', 'Federal Pioneer / Stab-lok',
    'Murray / Murray', 'Leviton / Leviton',
  ]) assert.ok(pairs.includes(want), `missing ${want}`);
});

test('QO is the 3/4" frame, Homeline is 1"', () => {
  assert.equal(catalogEntry('Square D', 'QO').breakerWidth, '3/4in');
  assert.equal(catalogEntry('Square D', 'Homeline').breakerWidth, '1in');
});

test('Federal Pioneer Stab-lok carries a safety flag', () => {
  const fp = catalogEntry('Federal Pioneer', 'Stab-lok');
  assert.equal(typeof fp.safetyFlag, 'string');
  assert.ok(/replace|assess/i.test(fp.safetyFlag));
});

// ---------------------------------------------------------------------------
// Helpers + default
// ---------------------------------------------------------------------------

test('manufacturers() is unique and in order', () => {
  const m = manufacturers();
  assert.deepEqual(m, [...new Set(m)]);
  assert.equal(m[0], 'Square D');
  assert.ok(m.includes('Eaton') && m.includes('Siemens') && m.includes('GE/ABB'));
});

test('linesFor / sizesFor / catalogEntry', () => {
  assert.deepEqual(linesFor('Square D'), ['Homeline', 'QO']);
  assert.deepEqual(linesFor('Eaton'), ['BR', 'CH']);
  assert.deepEqual(linesFor('Nope'), []);
  const sizes = sizesFor('Square D', 'Homeline');
  assert.ok(sizes.some((s) => s.amps === 200 && s.spaces === 40 && s.mainType === 'MB'));
  // sizesFor returns a copy — mutating it must not touch the catalogue.
  sizes[0].amps = -1;
  assert.notEqual(sizesFor('Square D', 'Homeline')[0].amps, -1);
  assert.equal(catalogEntry('Nope', 'Nope'), null);
});

test('DEFAULT is Square D Homeline 200 A / 40 MB and exists in the catalogue', () => {
  assert.equal(DEFAULT.manufacturer, 'Square D');
  assert.equal(DEFAULT.line, 'Homeline');
  assert.equal(DEFAULT.amps, 200);
  assert.equal(DEFAULT.spaces, 40);
  assert.equal(DEFAULT.mainType, 'MB');
  const e = catalogEntry(DEFAULT.manufacturer, DEFAULT.line);
  assert.ok(e.sizes.some((s) => s.amps === DEFAULT.amps && s.spaces === DEFAULT.spaces && s.mainType === DEFAULT.mainType));
});

// ---------------------------------------------------------------------------
// Part-number generator: core cases (exact known SKUs)
// ---------------------------------------------------------------------------

const num = (spec) => partNumber(spec).number;

test('TYPES lists the understood breaker types', () => {
  for (const t of ['standard', 'tandem', 'quad', 'gfci', 'afci', 'dual']) assert.ok(TYPES.includes(t));
});

test('Square D QO core', () => {
  assert.equal(num({ family: 'QO', poles: 1, amps: 20 }), 'QO120');
  assert.equal(num({ family: 'QO', poles: 2, amps: 20 }), 'QO220');
  assert.equal(num({ family: 'QO', breakerType: 'tandem', tandemAmps: [15, 15] }), 'QO1515');
  assert.ok(partNumber({ family: 'QO', poles: 1, amps: 20 }).confident);
});

test('Square D Homeline core + quad', () => {
  assert.equal(num({ family: 'HOM', poles: 1, amps: 20 }), 'HOM120');
  assert.equal(num({ family: 'HOM', breakerType: 'tandem', tandemAmps: [15, 15] }), 'HOMT1515');
  assert.equal(num({ family: 'HOM', breakerType: 'quad', tandemAmps: [20, 20], amps: 30 }), 'HOMT2020230');
});

test('Eaton BR core + tandem + quad', () => {
  assert.equal(num({ family: 'BR', poles: 1, amps: 20 }), 'BR120');
  assert.equal(num({ family: 'BR', breakerType: 'tandem', tandemAmps: [15, 15] }), 'BD1515');
  assert.equal(num({ family: 'BR', breakerType: 'quad', tandemAmps: [20, 30] }), 'BRD220230');
});

test('Eaton CH core + tandem', () => {
  assert.equal(num({ family: 'CH', poles: 1, amps: 20 }), 'CH120');
  assert.equal(num({ family: 'CH', breakerType: 'tandem', tandemAmps: [20, 20] }), 'CHT2020');
});

test('Siemens Q core + tandem + Canadian dual suffix', () => {
  assert.equal(num({ family: 'Q', poles: 1, amps: 20 }), 'Q120');
  assert.equal(num({ family: 'Q', breakerType: 'tandem', tandemAmps: [15, 15] }), 'Q1515');
  // Dual-function keeps its exact Canadian string but is flagged for verification.
  const df = partNumber({ family: 'Q', poles: 1, amps: 20, breakerType: 'dual' });
  assert.equal(df.number, 'Q120DFCSA');
  assert.equal(df.confident, false);
});

test('GE/ABB THQL + THQP core', () => {
  assert.equal(num({ family: 'THQL', poles: 1, amps: 20 }), 'THQL1120');
  assert.equal(num({ family: 'THQL', poles: 2, amps: 20 }), 'THQL2120');
  assert.equal(num({ family: 'THQL', breakerType: 'tandem', tandemAmps: [15, 15] }), 'THQLT1515');
  assert.equal(num({ family: 'THQP', poles: 1, amps: 20 }), 'THQP120');
});

test('GFCI / AFCI / dual come back confident:false with a note', () => {
  for (const type of ['gfci', 'afci', 'dual']) {
    const r = partNumber({ family: 'QO', poles: 1, amps: 20, breakerType: type });
    assert.equal(r.confident, false, `${type} should not be confident`);
    assert.ok(r.note.length > 0, `${type} should carry a note`);
    assert.ok(r.number.length > 0, `${type} should still suggest a SKU`);
  }
});

test('never crosses families + unknown family is handled', () => {
  assert.ok(num({ family: 'QO', poles: 1, amps: 20 }).startsWith('QO'));
  assert.ok(num({ family: 'BR', poles: 1, amps: 20 }).startsWith('BR'));
  const bad = partNumber({ family: 'ACME', poles: 1, amps: 20 });
  assert.equal(bad.confident, false);
  assert.equal(bad.number, '');
});

test('THQP has no combined tandem body', () => {
  const r = partNumber({ family: 'THQP', breakerType: 'tandem', tandemAmps: [15, 15] });
  assert.equal(r.confident, false);
});

// ---------------------------------------------------------------------------
// breakerFamilyFor: catalogue entry -> generator key
// ---------------------------------------------------------------------------

test('breakerFamilyFor maps lines to generator keys; proprietary lines map to null', () => {
  assert.equal(breakerFamilyFor(catalogEntry('Square D', 'QO')), 'QO');
  assert.equal(breakerFamilyFor(catalogEntry('Square D', 'Homeline')), 'HOM');
  assert.equal(breakerFamilyFor(catalogEntry('Eaton', 'BR')), 'BR');
  assert.equal(breakerFamilyFor(catalogEntry('Eaton', 'CH')), 'CH');
  assert.equal(breakerFamilyFor(catalogEntry('Siemens', 'QP')), 'Q');
  assert.equal(breakerFamilyFor(catalogEntry('Murray', 'Murray')), 'Q');
  assert.equal(breakerFamilyFor(catalogEntry('GE/ABB', 'Q-Line')), 'THQL');
  assert.equal(breakerFamilyFor(catalogEntry('Federal Pioneer', 'Stab-lok')), null);
  assert.equal(breakerFamilyFor(catalogEntry('Leviton', 'Leviton')), null);
  assert.equal(breakerFamilyFor(null), null);
});
