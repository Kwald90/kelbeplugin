// Run: node --test electrical-app/tests/
// Panel catalogue wiring into the panel schedule (S26): the New-panel manufacturer → line → size
// picker's field mapping, the line-driven tandem/quad gating, and the per-slot breaker part number
// (auto-resolve, confident:false flagging, and a manual override that wins). Pure-function tests;
// the DOM wiring in js/modules/panels.js is exercised by the headless-Chrome render in the task.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  panelFromCatalog, tandemsModeOf, panelOffersTandems, panelOffersQuad,
  partSpecFor, circuitPartNumber, applyPartNumbers,
} from '../js/modules/panels.js';
import { catalogEntry, sizesFor, DEFAULT } from '../js/lib/panel-catalog.js';

// ---------------------------------------------------------------------------
// 1) Picker sets the panel fields from a catalogue size
// ---------------------------------------------------------------------------

test('panelFromCatalog maps the DEFAULT (Square D Homeline 200 A / 40 MB) onto the panel fields', () => {
  const entry = catalogEntry(DEFAULT.manufacturer, DEFAULT.line);
  const size = sizesFor(DEFAULT.manufacturer, DEFAULT.line).find((s) => s.amps === 200 && s.spaces === 40 && s.mainType === 'MB');
  const p = panelFromCatalog(entry, size, 'job-1');
  assert.equal(p.jobId, 'job-1');
  assert.equal(p.manufacturer, 'Square D');
  assert.equal(p.line, 'Homeline');
  assert.equal(p.breakerFamily, 'HOM');   // generator key, drives slot-fill SKUs
  assert.equal(p.breakerWidth, '1in');
  assert.equal(p.tandemsMode, 'all');
  assert.equal(p.quad, true);
  // the size implies spaces + main amps + bus + main type
  assert.equal(p.slots, 40);
  assert.equal(p.mainAmps, 200);
  assert.equal(p.busAmps, 200);
  assert.equal(p.mainType, 'MB');
  assert.equal(p.voltage, '120/240 1ph'); // system kept (editor still offers the full list)
  assert.deepEqual(p.circuits, []);
});

test('panelFromCatalog carries an MLO size, a QO 3/4" line, and a 3-phase-less default', () => {
  const entry = catalogEntry('Square D', 'QO');
  const mlo = sizesFor('Square D', 'QO').find((s) => s.mainType === 'MLO');
  const p = panelFromCatalog(entry, mlo);
  assert.equal(p.jobId, null);
  assert.equal(p.mainType, 'MLO');
  assert.equal(p.mainAmps, mlo.amps);
  assert.equal(p.busAmps, mlo.busAmps);
  assert.equal(p.slots, mlo.spaces);
  assert.equal(p.breakerFamily, 'QO');
  assert.equal(p.breakerWidth, '3/4in');
  assert.equal(p.tandemsMode, 'marked');
});

test('panelFromCatalog on a proprietary line (Stab-lok / Leviton) stores no breaker family', () => {
  const fp = catalogEntry('Federal Pioneer', 'Stab-lok');
  const p = panelFromCatalog(fp, sizesFor('Federal Pioneer', 'Stab-lok')[0]);
  assert.equal(p.breakerFamily, null);  // no auto part numbers
  assert.equal(p.tandemsMode, 'none');
  assert.equal(p.quad, false);
  const lev = catalogEntry('Leviton', 'Leviton');
  const pl = panelFromCatalog(lev, sizesFor('Leviton', 'Leviton')[0]);
  assert.equal(pl.breakerFamily, null);
  assert.equal(pl.tandemsMode, 'none');
});

// ---------------------------------------------------------------------------
// 2) The line drives the tandem / quad affordances
// ---------------------------------------------------------------------------

test('tandemsModeOf defaults a blank/legacy panel to "all" and reads the stored mode otherwise', () => {
  assert.equal(tandemsModeOf({}), 'all');          // blank panel — unchanged behaviour
  assert.equal(tandemsModeOf(null), 'all');
  assert.equal(tandemsModeOf({ tandemsMode: 'marked' }), 'marked');
  assert.equal(tandemsModeOf({ tandemsMode: 'none' }), 'none');
  assert.equal(tandemsModeOf({ tandemsMode: 'nonsense' }), 'all'); // unknown falls back
});

test('panelOffersTandems: gated by the system neutral AND the line mode', () => {
  // A line that takes tandems, on a system with a neutral, offers them.
  assert.equal(panelOffersTandems({ tandemsMode: 'all' }, true), true);
  assert.equal(panelOffersTandems({ tandemsMode: 'marked' }, true), true);
  // A 'none' line (Stab-lok / Leviton) never offers them.
  assert.equal(panelOffersTandems({ tandemsMode: 'none' }, true), false);
  // No neutral (a 3-phase, 3-wire system) blocks tandems regardless of the line.
  assert.equal(panelOffersTandems({ tandemsMode: 'all' }, false), false);
  // A blank panel on a neutral system still offers tandems (unchanged).
  assert.equal(panelOffersTandems({}, true), true);
});

test('panelOffersQuad: tandems offered and the line quad flag not false', () => {
  assert.equal(panelOffersQuad({ tandemsMode: 'all', quad: true }, true), true);
  assert.equal(panelOffersQuad({ tandemsMode: 'all', quad: false }, true), false); // line has no quad
  assert.equal(panelOffersQuad({ tandemsMode: 'none', quad: true }, true), false); // no tandems -> no quad
  assert.equal(panelOffersQuad({}, true), true);        // blank panel: quad flag absent -> allowed
  assert.equal(panelOffersQuad({ quad: true }, false), false); // no neutral
});

// ---------------------------------------------------------------------------
// 3) Slot-fill part number
// ---------------------------------------------------------------------------

const homePanel = { breakerFamily: 'HOM', line: 'Homeline' };
const qoPanel = { breakerFamily: 'QO', line: 'QO' };
const blankPanel = { breakerFamily: null };

test('circuitPartNumber resolves a confident core SKU for a standard breaker', () => {
  const r = circuitPartNumber(homePanel, { slot: 1, poles: 1, amps: 20, breakerType: 'standard' }, []);
  assert.equal(r.number, 'CHOM120');
  assert.equal(r.confident, true);
  const r2 = circuitPartNumber(qoPanel, { slot: 3, poles: 2, amps: 30, breakerType: 'standard' }, []);
  assert.equal(r2.number, 'CQO230');
  assert.equal(r2.confident, true);
});

test('circuitPartNumber returns null when the panel has no breaker family', () => {
  assert.equal(circuitPartNumber(blankPanel, { slot: 1, poles: 1, amps: 20 }, []), null);
});

test('circuitPartNumber: a GFCI/AFCI/dual type comes back confident:false with a note', () => {
  const r = circuitPartNumber(qoPanel, { slot: 1, poles: 1, amps: 20, breakerType: 'gfci' }, []);
  assert.equal(r.confident, false);
  assert.ok(r.number.length > 0);
  assert.ok(r.note.length > 0);
  const d = circuitPartNumber({ breakerFamily: 'Q' }, { slot: 1, poles: 1, amps: 20, breakerType: 'dual' }, []);
  assert.equal(d.number, 'Q120DFCSA');
  assert.equal(d.confident, false);
});

test('circuitPartNumber: a tandem passes BOTH halves’ amps as the combined body SKU', () => {
  // Space 1 holds two tandem halves: 15 A (A) over 20 A (B). The device SKU is HOMT1520.
  const circuits = [
    { slot: 1, half: 'A', poles: 1, amps: 15, breakerType: 'tandem' },
    { slot: 1, half: 'B', poles: 1, amps: 20, breakerType: 'tandem' },
  ];
  const r = circuitPartNumber(homePanel, circuits[0], circuits);
  assert.equal(r.number, 'CHOMT1520');
  assert.equal(r.confident, true);
  // both halves resolve to the same physical body
  assert.equal(circuitPartNumber(homePanel, circuits[1], circuits).number, 'CHOMT1520');
});

test('circuitPartNumber: a quad inner 2-pole uses the inner amp plus the two outer amps', () => {
  // Quad at 5 & 7 on a Homeline panel: outer singles 15 A (5A) and 20 A (7B), inner 2-pole 30 A.
  const circuits = [
    { slot: 5, half: 'A', poles: 1, amps: 15, breakerType: 'tandem' },
    { slot: 5, half: 'B', poles: 2, amps: 30, breakerType: 'quad' },
    { slot: 7, half: 'B', poles: 1, amps: 20, breakerType: 'tandem' },
  ];
  const inner = circuits[1];
  const r = circuitPartNumber(homePanel, inner, circuits);
  assert.equal(r.number, 'CHOMT1520230'); // HOMT{A}{B}2{inner}
  assert.equal(r.confident, true);
  // a quad's outer single is part of the one quad device — it carries no SKU of its own
  assert.equal(partSpecFor(homePanel, circuits[0], circuits), null);
  assert.equal(partSpecFor(homePanel, circuits[2], circuits), null);
});

test('applyPartNumbers stamps auto SKUs, clears them without a family, and NEVER overwrites a manual value', () => {
  const circuits = [
    { slot: 1, poles: 1, amps: 20, breakerType: 'standard' },
    { slot: 3, poles: 2, amps: 40, breakerType: 'standard', partNo: 'CUSTOM-ABC', partNoManual: true },
  ];
  const out = applyPartNumbers(homePanel, circuits);
  assert.equal(out[0].partNo, 'CHOM120');            // auto-resolved
  assert.equal(out[1].partNo, 'CUSTOM-ABC');        // manual override wins
  assert.equal(out[1].partNoManual, true);

  // On a panel with no family, auto part numbers are cleared but the manual one stays.
  const cleared = applyPartNumbers(blankPanel, out);
  assert.equal('partNo' in cleared[0], false);
  assert.equal(cleared[1].partNo, 'CUSTOM-ABC');

  // A circuit that resolves to no SKU (no amps) carries no partNo.
  const none = applyPartNumbers(homePanel, [{ slot: 1, poles: 1, amps: 0, breakerType: 'standard' }]);
  assert.equal('partNo' in none[0], false);
});

test('applyPartNumbers is stable: re-running with the same inputs keeps the same numbers (manual persists)', () => {
  const once = applyPartNumbers(homePanel, [
    { slot: 1, poles: 1, amps: 15, breakerType: 'standard' },
    { slot: 2, poles: 1, amps: 15, breakerType: 'standard', partNo: 'OVERRIDE1', partNoManual: true },
  ]);
  const twice = applyPartNumbers(homePanel, once);
  assert.equal(twice[0].partNo, 'CHOM115');
  assert.equal(twice[1].partNo, 'OVERRIDE1');
  assert.equal(twice[1].partNoManual, true);
});
