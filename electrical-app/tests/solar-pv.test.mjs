// Solar PV sizing + CEC Section 64 interconnection (lib/solar-pv.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vocCold, maxModulesPerString, minModulesPerString, solarPv, ISC_FACTOR, CONT_FACTOR, BUSBAR_ALLOWANCE } from '../js/lib/solar-pv.js';

const near = (a, b, tol) => Math.abs(a - b) <= tol;

test('cold Voc rises below 25 degC', () => {
  // 40 Voc, -0.29 %/degC, at -40 degC: 40 * (1 + (-0.29/100)*(-65)) = 40 * 1.1885 = 47.54 V
  const v = vocCold({ vocStc: 40, betaPctPerC: -0.29, tMinC: -40 });
  assert.ok(near(v, 47.54, 0.05));
  // at STC (25 degC) it is unchanged
  assert.ok(near(vocCold({ vocStc: 40, betaPctPerC: -0.29, tMinC: 25 }), 40, 1e-9));
});

test('max modules per string keeps cold Voc under the inverter limit', () => {
  // cold Voc 47.54 V, inverter 600 V max -> floor(600/47.54) = 12
  const nMax = maxModulesPerString({ vocStc: 40, betaPctPerC: -0.29, tMinC: -40, inverterVmaxDc: 600 });
  assert.equal(nMax, 12);
});

test('min modules per string keeps warm Vmp above the MPPT floor', () => {
  // Vmp 33, -0.4 %/degC, at 65 degC: 33*(1 + (-0.4/100)*40) = 33*0.84 = 27.72; floor 200 -> ceil(200/27.72)=8
  const nMin = minModulesPerString({ vmpStc: 33, gammaPctPerC: -0.4, tMaxC: 65, inverterMpptMin: 200 });
  assert.equal(nMin, 8);
});

test('DC circuit current is 1.25 x Isc then 1.25 continuous', () => {
  const r = solarPv({
    moduleWp: 400, vocStc: 40, vmpStc: 33, iscStc: 10, betaPctPerC: -0.29, gammaPctPerC: -0.4,
    modulesPerString: 10, strings: 2,
    inverterVmaxDc: 600, inverterMpptMin: 200, inverterAcAmps: 40, acVolts: 240, acPhase: 1,
    tMinC: -40, tMaxC: 65, connection: 'loadside', busbarRating: 200, mainBreaker: 200,
  });
  // 2 strings x 10 A Isc x 1.25 = 25 A max circuit; x 1.25 continuous = 31.25 A design
  assert.ok(near(r.dc.maxCircuitAmps, 25, 1e-9));
  assert.ok(near(r.dc.designAmps, 31.25, 1e-9));
  assert.ok(r.dc.ocpd >= r.dc.designAmps, 'DC OCPD is a standard rating at or above design');
  assert.ok(r.dc.size, 'picks a DC conductor');
  assert.equal(r.array.moduleCount, 20);
  assert.ok(near(r.array.arrayKwDc, 8, 1e-9), '20 x 400 W = 8 kW');
});

test('AC conductor and OCPD sized at 125% of continuous output', () => {
  const r = solarPv({ iscStc: 10, modulesPerString: 10, strings: 1, inverterAcAmps: 40, acVolts: 240, acPhase: 1, connection: 'supplyside' });
  assert.ok(near(r.ac.designAmps, 50, 1e-9)); // 40 x 1.25
  assert.ok(r.ac.ocpd >= 50);
  assert.ok(r.ac.size, 'picks an AC conductor');
});

test('AC continuous amps derived from kW when amps not given', () => {
  const r = solarPv({ iscStc: 8, modulesPerString: 8, strings: 1, inverterAcKw: 7.6, acVolts: 240, acPhase: 1, connection: 'supplyside' });
  // 7600 / 240 = 31.67 A
  assert.ok(near(r.ac.continuousAmps, 31.67, 0.1));
});

test('120% busbar rule flags an over-loaded busbar', () => {
  // 200 A busbar, 200 A main, 40 A inverter continuous -> OCPD 50 A. 200 + 50 = 250 > 1.2*200 = 240 -> fail
  const r = solarPv({ iscStc: 10, modulesPerString: 10, strings: 1, inverterAcAmps: 40, acVolts: 240, acPhase: 1, connection: 'loadside', busbarRating: 200, mainBreaker: 200 });
  assert.equal(r.busbar120.pass, false);
  assert.ok(near(r.busbar120.allowedTotal, 240, 1e-9));
  assert.ok(r.warnings.some((w) => /120% rule fails/.test(w)));
});

test('120% busbar rule passes with a smaller main', () => {
  // 200 A busbar, 150 A main, 40 A inverter -> OCPD 50 A. 150 + 50 = 200 <= 240 -> pass
  const r = solarPv({ iscStc: 10, modulesPerString: 10, strings: 1, inverterAcAmps: 40, acVolts: 240, acPhase: 1, connection: 'loadside', busbarRating: 200, mainBreaker: 150 });
  assert.equal(r.busbar120.pass, true);
  assert.ok(near(r.busbar120.maxBackfeedBreaker, 90, 1e-9)); // 240 - 150
});

test('supply-side connection skips the 120% rule', () => {
  const r = solarPv({ iscStc: 10, modulesPerString: 10, strings: 1, inverterAcAmps: 40, acVolts: 240, acPhase: 1, connection: 'supplyside', busbarRating: 200, mainBreaker: 200 });
  assert.equal(r.busbar120, null);
});

test('string outside the window is flagged', () => {
  const r = solarPv({ iscStc: 10, modulesPerString: 15, strings: 1, vocStc: 40, betaPctPerC: -0.29, tMinC: -40, inverterVmaxDc: 600, inverterAcAmps: 40, acVolts: 240, acPhase: 1, connection: 'supplyside' });
  assert.equal(r.stringWindow.windowOk, false);
  assert.ok(r.warnings.some((w) => /exceeds/.test(w)));
});

test('exported factors are the expected conventions', () => {
  assert.equal(ISC_FACTOR, 1.25);
  assert.equal(CONT_FACTOR, 1.25);
  assert.equal(BUSBAR_ALLOWANCE, 1.20);
});
