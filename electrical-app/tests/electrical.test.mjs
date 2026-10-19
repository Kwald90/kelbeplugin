// Run: node --test electrical-app/tests/
// Expected values are textbook / NEC 2023 table answers, worked by hand in the comments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../js/lib/electrical.js';

const near = (actual, expected, tol = 0.01, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg || ''} expected ${expected} ±${tol}, got ${actual}`);

test('Table 310.16 ampacities', () => {
  assert.equal(E.ampacity('12', 'cu', 75), 25);
  assert.equal(E.ampacity('14', 'cu', 60), 15);
  assert.equal(E.ampacity('3/0', 'cu', 75), 200);
  assert.equal(E.ampacity('4/0', 'al', 75), 180);
  assert.equal(E.ampacity('2', 'al', 75), 90);
  assert.equal(E.ampacity('500', 'cu', 90), 430);
  assert.equal(E.ampacity('14', 'al', 75), null);
});

test('240.4(D) small conductor limits: 12 Cu is 25 A but protected at 20 A', () => {
  assert.equal(E.SMALL_CONDUCTOR_OCPD.cu['12'], 20);
  assert.equal(E.maxOCPDForConductor('12', 'cu', 25), 20);
  assert.equal(E.maxOCPDForConductor('14', 'cu', 20), 15);
  assert.equal(E.maxOCPDForConductor('10', 'al', 30), 25);
  // 240.4(B): 65 A conductor may take the next standard size up, 70 A
  assert.equal(E.maxOCPDForConductor('6', 'cu', 65), 70);
  assert.equal(E.maxOCPDForConductor('8', 'cu', 50), 50);
});

test('Ambient correction Table 310.15(B)(1)(1)', () => {
  assert.equal(E.ambientFactor(40, 90), 0.91);
  assert.equal(E.ambientFactor(35, 75), 0.94);
  assert.equal(E.ambientFactor(30, 60), 1.0);
  assert.equal(E.ambientFactor(50, 90), 0.82);
  assert.equal(E.ambientFactor(61, 60), null);
});

test('More than three CCC, Table 310.15(C)(1)', () => {
  assert.equal(E.cccFactor(3), 1);
  assert.equal(E.cccFactor(4), 0.8);
  assert.equal(E.cccFactor(6), 0.8);
  assert.equal(E.cccFactor(7), 0.7);
  assert.equal(E.cccFactor(9), 0.7);
  assert.equal(E.cccFactor(10), 0.5);
  assert.equal(E.cccFactor(20), 0.5);
  assert.equal(E.cccFactor(25), 0.45);
  assert.equal(E.cccFactor(41), 0.35);
});

test('Standard OCPD sizes 240.6(A)', () => {
  assert.equal(E.nextStandardOCPD(16), 20);
  assert.equal(E.nextStandardOCPD(20), 20);
  assert.equal(E.nextStandardOCPD(81), 90);
  assert.equal(E.nextStandardOCPD(101), 110);
  assert.equal(E.suggestBreaker(16), 20); // 16 × 1.25 = 20
  assert.equal(E.suggestBreaker(24), 30); // 30
  assert.equal(E.suggestBreaker(24, false), 25);
});

test('Voltage drop, single phase, K method and Table 8', () => {
  // 2 × 12.9 × 20 × 100 / 6530 = 7.902 V; 7.902 / 240 = 3.29%
  const r = E.voltageDrop({ volts: 240, phase: 1, amps: 20, lengthFt: 100, size: '12', material: 'cu' });
  near(r.volts, 7.902, 0.005);
  near(r.percent, 3.2925, 0.005);
  near(r.endVolts, 232.098, 0.005);
  // Table 8: 2 × 1.93 Ω/kft × 20 A × 0.1 kft = 7.72 V
  near(r.tableVolts, 7.72, 0.001);
});

test('Voltage drop, three phase', () => {
  // 1.732 × 12.9 × 100 × 300 / 105600 = 6.348 V
  const r = E.voltageDrop({ volts: 480, phase: 3, amps: 100, lengthFt: 300, size: '1/0', material: 'cu' });
  near(r.volts, 6.348, 0.005);
  near(r.percent, 1.3225, 0.005);
  // aluminum uses K = 21.2: 2 × 21.2 × 30 × 150 / 41740 = 4.571 V
  near(E.voltageDrop({ volts: 240, phase: 1, amps: 30, lengthFt: 150, size: '4', material: 'al' }).volts, 4.571, 0.005);
});

test('Minimum size and max length for voltage drop', () => {
  // 20 A @ 240 V, 200 ft: 12 → 6.59%, 10 → 4.14%, 8 → 2.60%
  assert.equal(E.minSizeForVoltageDrop({ volts: 240, amps: 20, lengthFt: 200, maxPct: 3 }), '8');
  // 12 AWG Cu, 20 A, 120 V, 3%: 0.03 × 120 × 6530 / (2 × 12.9 × 20) = 45.6 ft
  near(E.maxLengthForVoltageDrop({ volts: 120, amps: 20, size: '12', maxPct: 3 }), 45.56, 0.05);
});

test('sizeConductor: continuous load and 240.4(D)', () => {
  // 16 A continuous → 20 A required. 14 AWG has 20 A at 75 °C, but 240.4(D) caps it at 15 A < 20 A breaker.
  const r = E.sizeConductor({ amps: 16, continuous: true });
  assert.equal(r.size, '12');
  assert.equal(r.ocpd, 20);
  // 200 A noncontinuous: 3/0 Cu (200 A), 250 kcmil Al (205 A; 4/0 Al is 180 A)
  assert.equal(E.sizeConductor({ amps: 200 }).size, '3/0');
  assert.equal(E.sizeConductor({ amps: 200, material: 'al' }).size, '250');
});

test('sizeConductor: adjustment for 9 CCC', () => {
  // 40 A, 9 CCC → 70%. 8 AWG: 55 × 0.7 = 38.5 A < 40 fails; 6 AWG: 75 × 0.7 = 52.5 A passes.
  const r = E.sizeConductor({ amps: 40, ccc: 9 });
  assert.equal(r.size, '6');
  near(r.deratedAmpacity, 52.5, 0.001);
});

test('sizeConductor: ambient correction', () => {
  // 30 A noncontinuous at 45 °C, THHN (0.87). 10 AWG: 40 × 0.87 = 34.8 A ≥ 30, term 35 ≥ 30, OCPD 30 ≤ 30 → 10 AWG
  assert.equal(E.sizeConductor({ amps: 30, ambientC: 45 }).size, '10');
  // at 55 °C (0.76): 10 AWG 30.4 A ok, but usable ampacity 30.4 → 240.4(D) 30 A max ≥ 30 → still 10
  assert.equal(E.sizeConductor({ amps: 30, ambientC: 55 }).size, '10');
  // 60 °C terminations: 30 A needs 10 AWG (30 A @ 60 °C)
  assert.equal(E.sizeConductor({ amps: 30, tempRating: 60 }).size, '10');
});

test('sizeConductor: voltage drop governs', () => {
  const r = E.sizeConductor({ amps: 20, volts: 240, phase: 1, lengthFt: 200, maxVdPct: 3 });
  assert.equal(r.size, '8');
  assert.equal(r.governedBy, 'voltage drop');
});

test('Conduit fill: 3 × 12 THHN in 1/2" EMT passes', () => {
  // 3 × 0.0133 = 0.0399 in² / 0.304 in² = 13.1% ≤ 40%
  const r = E.conduitFill({ conduitType: 'EMT', tradeSize: '1/2', wires: [{ size: '12', insulation: 'THHN', count: 3 }] });
  assert.equal(r.pass, true);
  assert.equal(r.allowedPct, 40);
  near(r.fillPct, 13.125, 0.01);
});

test('Conduit fill: Annex C counts', () => {
  assert.equal(E.maxConductors({ conduitType: 'EMT', tradeSize: '1/2', size: '12' }), 9);
  assert.equal(E.maxConductors({ conduitType: 'EMT', tradeSize: '1/2', size: '14' }), 12);
  assert.equal(E.maxConductors({ conduitType: 'EMT', tradeSize: '3/4', size: '12' }), 16);
  assert.equal(E.maxConductors({ conduitType: 'EMT', tradeSize: '3/4', size: '10' }), 10);
});

test('Conduit fill: one and two conductor limits', () => {
  assert.equal(E.allowedFillPct(1), 53);
  assert.equal(E.allowedFillPct(2), 31);
  assert.equal(E.allowedFillPct(3), 40);
  // 10 × 12 THHN = 0.133 in² > 0.1216 in² (40% of 1/2" EMT) → fail
  assert.equal(E.conduitFill({ conduitType: 'EMT', tradeSize: '1/2', wires: [{ size: '12', count: 10 }] }).pass, false);
});

test('Conduit fill: minimum conduit', () => {
  // 4 × 3/0 THHN + 1 × 4 THHN = 4 × 0.2679 + 0.0824 = 1.154 in². 1-1/2" EMT 40% = 0.814; 2" = 1.342 → 2"
  const r = E.minConduit({ conduitType: 'EMT', wires: [{ size: '3/0', count: 4 }, { size: '4', count: 1 }] });
  assert.equal(r.tradeSize, '2');
});

test('Box fill 314.16(B)', () => {
  // 4" square × 1-1/2" (21.0 in³): 4 × #12 = 9.0, clamps 2.25, device 4.5, grounds 2.25 = 18.0 → pass
  const r = E.boxFill({ conductors: [{ size: '12', count: 4 }], clamps: true, devices: [{ size: '12' }], grounds: [{ size: '12', count: 2 }], boxVolume: 21.0 });
  near(r.required, 18.0, 0.001);
  assert.equal(r.pass, true);
  // six EGCs: 1 + 2 × 1/4 = 1.5 allowances × 2.25 = 3.375 in³
  const g = E.boxFill({ grounds: [{ size: '12', count: 6 }] });
  near(g.required, 3.375, 0.001);
  // 3 × 2 × 2-1/2 device box (12.5 in³) with 2 × 14/2 + device: 4 × 2 + 4 + 2 = 14 > 12.5 → fail
  const f = E.boxFill({ conductors: [{ size: '14', count: 4 }], devices: [{ size: '14' }], grounds: [{ size: '14', count: 2 }], boxVolume: 12.5 });
  near(f.required, 14, 0.001);
  assert.equal(f.pass, false);
});

test('Range demand Table 220.55 Column C', () => {
  assert.equal(E.rangeDemandVA(12), 8000);
  assert.equal(E.rangeDemandVA(10), 8000);
  assert.equal(E.rangeDemandVA(14), 8800); // 2 kW over → +10%
  assert.equal(E.rangeDemandVA(12.6), 8400); // major fraction counts
  assert.equal(E.rangeDemandVA(12.4), 8000);
});

const HOUSE = {
  sqft: 2000, smallApplianceCircuits: 2, laundryCircuits: 1,
  appliances: [{ name: 'Water heater', va: 4500 }, { name: 'Dishwasher', va: 1200 }, { name: 'Disposal', va: 900 }],
  dryerVA: 5000, rangeKW: 12, heatVA: 0, acVA: 5000,
};

test('Dwelling load, standard method', () => {
  // General lighting 2000 × 3 = 6000, SA 3000, laundry 1500 → 10,500
  // Demand: 3000 + (10,500 − 3000) × 35% = 3000 + 2625 = 5625
  // Appliances (3, so 100%): 4500 + 1200 + 900 = 6600
  // Dryer 5000, range 8000, A/C 5000
  // Total = 5625 + 6600 + 5000 + 8000 + 5000 = 30,225 VA → 125.9 A → 150 A service
  const r = E.dwellingLoadCalc(HOUSE);
  near(r.totalVA, 30225, 0.01);
  near(r.amps, 125.94, 0.01);
  assert.equal(r.service, 150);
});

test('Dwelling load: four appliances at 75%, EV and heat', () => {
  // + microwave 1500: (4500 + 1200 + 900 + 1500) × 0.75 = 6075
  // heat 10,000 > A/C 5000 → 10,000. EV 32 A × 240 = 7680 VA.
  // 5625 + 6075 + 5000 + 8000 + 10,000 + 7680 = 42,380 VA → 176.6 A → 200 A
  const r = E.dwellingLoadCalc({ ...HOUSE, appliances: [...HOUSE.appliances, { name: 'Microwave', va: 1500 }], heatVA: 10000, evVA: [7680] });
  near(r.totalVA, 42380, 0.01);
  assert.equal(r.service, 200);
  // small EVSE counts at least 7200 VA (220.57)
  const s = E.dwellingLoadCalc({ ...HOUSE, evVA: [5000] });
  near(s.totalVA, 30225 + 7200, 0.01);
  // a dryer below 5000 VA is taken at 5000
  near(E.dwellingLoadCalc({ ...HOUSE, dryerVA: 4000 }).totalVA, 30225, 0.01);
});

test('Dwelling load, optional method 220.82', () => {
  // General: 6000 + 4500 (3 circuits) + 6600 appliances + 5000 dryer + 12,000 range = 34,100
  // 10,000 + 24,100 × 40% = 19,640; + A/C 5000 = 24,640 VA → 102.7 A → 125 A
  const r = E.dwellingLoadOptional(HOUSE);
  near(r.totalVA, 24640, 0.01);
  assert.equal(r.service, 125);
  // central heat 10 kW at 65% = 6500 > A/C 5000
  near(E.dwellingLoadOptional({ ...HOUSE, heatVA: 10000 }).totalVA, 19640 + 6500, 0.01);
});

test("Ohm's law", () => {
  assert.deepEqual(E.ohmsLaw({ v: 120, i: 10 }), { v: 120, i: 10, r: 12, p: 1200 });
  const r = E.ohmsLaw({ v: 120, p: 1500 });
  near(r.i, 12.5, 1e-9); near(r.r, 9.6, 1e-9);
  const q = E.ohmsLaw({ r: 10, p: 1000 });
  near(q.v, 100, 1e-9); near(q.i, 10, 1e-9);
  assert.equal(E.ohmsLaw({ v: 120 }), null);
});

test('Three phase current', () => {
  // 30,000 / (1.732 × 208) = 83.27 A
  near(E.threePhase({ volts: 208, kva: 30 }).amps, 83.27, 0.01);
  // 100 kW @ 0.9 pf = 111.1 kVA → 111,111 / (1.732 × 480) = 133.65 A
  near(E.threePhase({ volts: 480, kw: 100, pf: 0.9 }).amps, 133.65, 0.01);
  near(E.threePhase({ volts: 480, amps: 100 }).kva, 83.14, 0.01);
});

test('Motor FLC Tables 430.248 / 430.250', () => {
  const m = E.motorFLC({ hp: '10', volts: 460, phase: 3 });
  assert.equal(m.flc, 14);
  near(m.conductorAmps, 17.5, 1e-9);
  assert.equal(m.conductor, '14'); // 20 A @ 75 °C; 240.4(G) lifts the 15 A limit
  assert.equal(m.breaker, 35); // 250% = 35 A
  assert.equal(m.fuse, 25); // 175% = 24.5 → 25 A
  assert.equal(E.motorFLC({ hp: '5', volts: 230, phase: 1 }).flc, 28);
  assert.equal(E.motorFLC({ hp: '25', volts: 208, phase: 3 }).flc, 74.8);
  assert.equal(E.motorFLC({ hp: '1', volts: 115, phase: 1 }).flc, 16);
  assert.equal(E.motorFLC({ hp: '7', volts: 230, phase: 3 }), null);
});

test('Panel slot phases', () => {
  const S3 = '208/120 3ph', S1 = '120/240 1ph';
  assert.equal(E.slotPhase(1, S3), 'A');
  assert.equal(E.slotPhase(2, S3), 'A');
  assert.equal(E.slotPhase(3, S3), 'B');
  assert.equal(E.slotPhase(5, S3), 'C');
  assert.equal(E.slotPhase(7, S3), 'A');
  assert.equal(E.slotPhase(3, S1), 'B');
  assert.equal(E.slotPhase(5, S1), 'A');
  assert.equal(E.circuitPhases(7, 2, S3), 'A-B');
  assert.equal(E.circuitPhases(5, 3, S3), 'C-A-B');
  assert.equal(E.circuitPhases(1, 2, S1), 'A-B');
});

test('Panel phase balance (seeded LP-2)', () => {
  const circuits = [
    { slot: 1, amps: 20, poles: 1, loadVA: 1440, phase: 'A' },
    { slot: 3, amps: 20, poles: 1, loadVA: 1440, phase: 'B' },
    { slot: 5, amps: 20, poles: 1, loadVA: 900, phase: 'C' },
    { slot: 7, amps: 30, poles: 2, loadVA: 4160, phase: 'A-B' },
    { slot: 2, amps: 20, poles: 1, loadVA: 1080, phase: 'A' },
    { slot: 4, amps: 20, poles: 1, loadVA: 1080, phase: 'B' },
    { slot: 6, amps: 20, poles: 1, loadVA: 800, phase: 'C' },
  ];
  // A = 1440 + 2080 + 1080 = 4600, B = 4600, C = 1700; avg 3633.3; max deviation 1933.3 → 53.2%
  const b = E.phaseBalance(circuits, '208/120 3ph');
  assert.equal(b.perPhase.A, 4600);
  assert.equal(b.perPhase.B, 4600);
  assert.equal(b.perPhase.C, 1700);
  assert.equal(b.totalVA, 10900);
  near(b.imbalancePct, 53.21, 0.01);
  near(b.amps.A, 38.33, 0.01);
  // phases derived from slots when not stored
  const d = E.phaseBalance(circuits.map(({ phase, ...c }) => c), '208/120 3ph');
  assert.deepEqual(d.perPhase, b.perPhase);
});
