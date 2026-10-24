// Run: node --test electrical-app/tests/
// CEC 2024 (CSA C22.1:24) calculations. Expected values are worked by hand in the
// comments from the table values in js/lib/cec (sources there and in docs/code/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../js/lib/cec/index.js';
import * as NEC from '../js/lib/nec.js';

const near = (actual, expected, tol = 0.01, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg || ''} expected ${expected} ±${tol}, got ${actual}`);

test('Tables 1-4 ampacity', () => {
  assert.equal(C.ampacity('12', 'cu', 75), 25);
  assert.equal(C.ampacity('14', 'cu', 60), 15);
  assert.equal(C.ampacity('3/0', 'cu', 75), 200);
  assert.equal(C.ampacity('4/0', 'al', 75), 180);
  assert.equal(C.ampacity('1', 'al', 75), 100); // ESA: #1 Al = 100 A at 75 °C
  assert.equal(C.ampacity('6', 'cu', 90, true), 105); // Table 1, free air
  assert.equal(C.ampacity('14', 'al', 75), null); // no 14 AWG aluminum
  // 100 A at the 60 °C column: #2 is 95, #1 is 110 -> 1 AWG
  assert.equal(C.minConductorForAmps(100, 'cu', 60), '1');
  // 200 A at 75 °C: 3/0 Cu (200); Al 4/0 is 180, 250 kcmil 205
  assert.equal(C.minConductorForAmps(200, 'cu', 75), '3/0');
  assert.equal(C.minConductorForAmps(200, 'al', 75), '250');
});

test('Rule 14-104(2) small conductors and Table 13 next rating up', () => {
  assert.equal(C.maxOCPDForConductor('14', 'cu', 20), 15);
  assert.equal(C.maxOCPDForConductor('12', 'cu', 25), 20);
  assert.equal(C.maxOCPDForConductor('10', 'cu', 35), 30);
  assert.equal(C.maxOCPDForConductor('10', 'al', 30), 25);
  assert.equal(C.maxOCPDForConductor('6', 'cu', 65), 70); // 65 A isn't a rating: next is 70
  assert.equal(C.maxOCPDForConductor('8', 'cu', 50), 50);
  assert.equal(C.nextStandardRating(81), 90);
  assert.equal(C.prevStandardRating(27.5), 25);
});

test('Table 5A ambient and Table 5C bundling', () => {
  assert.equal(C.ambientFactor(40, 90), 0.91);
  assert.equal(C.ambientFactor(40, 75), 0.88);
  assert.equal(C.ambientFactor(50, 90), 0.82);
  assert.equal(C.ambientFactor(47, 90), 0.82); // between rows: use the next row up
  assert.equal(C.ambientFactor(25, 90), 1);
  assert.equal(C.ambientFactor(61, 60), null);
  assert.deepEqual([3, 4, 6, 7, 24, 25, 42, 43].map(C.cccFactor), [1, 0.8, 0.8, 0.7, 0.7, 0.6, 0.6, 0.5]);
});

test('Rule 4-006 terminations and Rule 8-104 continuous limits', () => {
  assert.equal(C.terminationTemp({ amps: 100 }), 60);
  assert.equal(C.terminationTemp({ amps: 101 }), 75);
  assert.equal(C.terminationTemp({ amps: 40, marked: 75 }), 75);
  assert.equal(C.continuousLimit(), 0.8);
  assert.equal(C.continuousLimit({ rated100: true }), 1);
  assert.equal(C.continuousLimit({ freeAir: true }), 0.7);
  assert.equal(C.continuousLimit({ rated100: true, freeAir: true }), 0.85);
});

test('sizeConductor: continuous load, 60 °C terminations', () => {
  // 16 A continuous ÷ 80% = 20 A; breaker 20 A, unmarked terminations -> 60 °C column.
  // 14 AWG: 15 A at 60 °C < 20 A. 12 AWG: 20 A at 60 °C, 30 A at 90 °C -> usable 20 A, OK.
  const r = C.sizeConductor({ amps: 16, continuous: true });
  assert.equal(r.size, '12');
  assert.equal(r.ocpd, 20);
  assert.equal(r.terminationC, 60);
});

test('sizeConductor: 9 conductors (Table 5C 70%)', () => {
  // 40 A continuous -> 50 A, breaker 50 A, 60 °C terminations.
  // 8 AWG: 55 × 0.7 = 38.5 A < 50. 6 AWG: 75 × 0.7 = 52.5 A, under the 55 A 60 °C limit, >= 50 -> OK.
  const r = C.sizeConductor({ amps: 40, continuous: true, ccc: 9 });
  assert.equal(r.size, '6');
  near(r.usableAmpacity, 52.5, 1e-9);
});

test('sizeConductor: ambient correction, 75 °C terminations', () => {
  // 30 A at 45 °C, 90 °C insulation (0.87). 10 AWG: 40 × 0.87 = 34.8 A, 75 °C limit 35 A,
  // breaker 30 A within the 30 A cap of Rule 14-104(2) -> 10 AWG.
  const r = C.sizeConductor({ amps: 30, ambientC: 45, terminationC: 75 });
  assert.equal(r.size, '10');
  near(r.correctedAmpacity, 34.8, 1e-9);
});

test('sizeConductor: voltage drop governs (Rule 8-102)', () => {
  // 20 A at 240 V, 60 m: VD = 2 × 20 × R × 0.06 km.
  // 12 AWG 6.50 Ω/km -> 15.6 V (6.5%); 10 AWG 4.07 -> 9.77 V (4.07%); 8 AWG 2.55 -> 6.12 V (2.55%).
  const vd = (size) => C.voltageDrop({ volts: 240, phase: 1, amps: 20, lengthM: 60, size });
  const r = C.sizeConductor({ amps: 20, vd, maxVdPct: 3 });
  assert.equal(r.size, '8');
  assert.equal(r.governedBy, 'voltage drop');
});

test('Voltage drop, single and three phase', () => {
  // 2 × 15 A × 10.30 Ω/km × 0.030 km = 9.27 V = 7.725% of 120 V
  const a = C.voltageDrop({ volts: 120, phase: 1, amps: 15, lengthM: 30, size: '14' });
  near(a.volts, 9.27, 0.001);
  near(a.percent, 7.725, 0.001);
  // √3 × 100 A × 0.400 Ω/km × 0.150 km = 10.392 V = 1.732% of 600 V
  const b = C.voltageDrop({ volts: 600, phase: 3, amps: 100, lengthM: 150, size: '1/0' });
  near(b.volts, 10.392, 0.001);
  near(b.percent, 1.732, 0.001);
  // longest #14 run at 15 A, 120 V, 3%: 0.03 × 120 × 1000 / (2 × 15 × 10.30) = 11.65 m
  near(C.maxLengthForVoltageDrop({ volts: 120, amps: 15, size: '14' }), 11.65, 0.01);
  // 30 A at 240 V over 50 m within 3% (7.2 V): VD = 3 × R; 8 AWG 7.65 V, 6 AWG 4.83 V -> 6 AWG
  assert.equal(C.minSizeForVoltageDrop({ volts: 240, amps: 30, lengthM: 50 }), '6');
  // load unknown: 80% of a 40 A breaker
  assert.equal(C.designCurrent({ loadAmps: 0, ocpdAmps: 40 }).amps, 32);
  assert.equal(C.designCurrent({ loadAmps: 12, ocpdAmps: 40 }).amps, 12);
});

test('Conduit fill, Rule 12-910 and Table 8', () => {
  assert.deepEqual([1, 2, 3, 10].map(C.allowedFillPct), [53, 31, 40, 40]);
  // ESA example: 3 × #10 RW90 (47.07 mm²) in 16 EMT (181.3 mm²; 40% = 72.52 mm²) -> 26.0%, passes
  const r = C.conduitFill({ conduitType: 'EMT', tradeSize: '16', wires: [{ size: '10', insulation: 'RW90 XLPE', count: 3 }] });
  near(r.wireArea, 47.07, 0.01);
  near(r.allowedArea, 72.52, 0.01);
  assert.equal(r.pass, true);
  // 4 fit (62.76 mm²), 5 don't (78.45 mm²)
  assert.equal(C.maxConductors({ conduitType: 'EMT', tradeSize: '16', size: '10', insulation: 'RW90 XLPE' }), 4);
  // IAEI example: 10 × #14 RW90 = 88.67 mm² > 80.92 mm² (40% of 16 RMC) -> 21 RMC
  assert.equal(C.minConduit({ conduitType: 'RMC', wires: [{ size: '14', insulation: 'RW90 XLPE', count: 10 }] }).tradeSize, '21');
  assert.throws(() => C.conduitFill({ conduitType: 'ENT', tradeSize: '78', wires: [] }), /isn't made/);
});

test('Box fill, Rule 12-3034 with Tables 22 and 23', () => {
  // Table 23 counts from the catalogue reproduce with 1 mL of rounding
  assert.equal(C.maxConductorsInBox(245, '14'), 10); // 4" octagon × 1-1/2"
  assert.equal(C.maxConductorsInBox(344, '14'), 14); // 4" square × 1-1/2"
  assert.equal(C.maxConductorsInBox(344, '12'), 12);
  assert.equal(C.maxConductorsInBox(491, '12'), 17);
  assert.equal(C.maxConductorsInBox(688, '14'), 28);
  assert.equal(C.maxConductorsInBox(204, '14'), 8); // 3 × 2 × 2-1/2" device box
  assert.equal(C.maxConductorsInBox(131, '8'), 2);
  // Device box (204 mL): 2 × 14/2 = 4 conductors + device 2 + 2 connectors (1 pair) 1 = 7 × 24.6 = 172.2 mL -> fits
  const a = C.boxFill({ conductors: [{ size: '14', count: 4 }], devices: 1, connectors: 2, boxML: 204 });
  assert.equal(a.count, 7);
  near(a.requiredML, 172.2, 1e-9);
  assert.equal(a.pass, true);
  // three cables: 6 + 2 + 4 connectors (2) = 10 × 24.6 = 246 mL > 204 -> too full
  assert.equal(C.boxFill({ conductors: [{ size: '14', count: 6 }], devices: 1, connectors: 4, boxML: 204 }).pass, false);
  // mixed sizes count at the largest: 4 conductors at 28.7 mL = 114.8 mL
  near(C.boxFill({ conductors: [{ size: '12', count: 2 }, { size: '14', count: 2 }], boxML: 204 }).requiredML, 114.8, 1e-9);
  // a fixture stud counts 1
  assert.equal(C.boxFill({ conductors: [{ size: '14', count: 4 }], studs: 1, boxML: 245 }).count, 5);
});

test('Rule 8-110 living area and Rule 62-118 heating demand', () => {
  // 100 + 50 + 75% × 80 = 210 m²
  assert.equal(C.livingArea({ groundM2: 100, aboveM2: 50, basementM2: 80 }), 210);
  // 20 kW baseboard: 10,000 + 75% × 10,000 = 17,500 W; central heat at 100%
  assert.equal(C.heatingDemandW(20000), 17500);
  assert.equal(C.heatingDemandW(20000, { central: true }), 20000);
  // range: 6000 W up to 12 kW, plus 40% above
  assert.equal(C.rangeDemandW(12000), 6000);
  assert.equal(C.rangeDemandW(16000), 7600);
  assert.equal(C.rangeDemandW(0), 0);
});

test('Rule 8-200 single dwelling: minimum governs', () => {
  // 150 m²: 5000 + 1 × 1000 (60 m² over 90) = 6000; A/C 3500; range 12 kW 6000;
  // dryer 5000 + tank heater 3000 at 25% = 2000. Total 17,500 W = 72.9 A.
  // 100 m² above grade >= 80 m² -> 24,000 W minimum (100 A) governs.
  const r = C.singleDwelling({ areaM2: 150, areaNoBasementM2: 100, acW: 3500, rangeW: 12000, otherW: [5000, 3000] });
  assert.equal(r.totalW, 17500);
  near(r.amps, 72.92, 0.01);
  assert.equal(r.minimumW, 24000);
  assert.equal(r.service, 100);
  assert.equal(r.governedBy, 'minimum');
});

test('Rule 8-200 single dwelling: electric heat, 14 kW range, EV', () => {
  // 200 m²: 5000 + 2 × 1000 = 7000; baseboard 15 kW: 10,000 + 75% × 5000 = 13,750;
  // range 14 kW: 6000 + 40% × 2000 = 6800; EV 7200 at 100%; dryer 5000 × 25% = 1250.
  // Total 36,000 W = 150 A -> 150 A service.
  const r = C.singleDwelling({ areaM2: 200, heatW: 15000, rangeW: 14000, evseW: [7200], otherW: [5000] });
  assert.equal(r.totalW, 36000);
  near(r.amps, 150, 1e-9);
  assert.equal(r.service, 150);
  assert.equal(r.governedBy, 'calculated load');
});

test('Rule 8-200 single dwelling: no range, small house, interlock, EVEMS', () => {
  // no range: dryer 5000 + tank 3000 = 8000 -> 6000 at 100% + 2000 × 25% = 6500; basic 5000 -> 11,500 W
  const a = C.singleDwelling({ areaM2: 80, areaNoBasementM2: 70, otherW: [5000, 3000] });
  assert.equal(a.totalW, 11500);
  assert.equal(a.minimumW, 14400); // under 80 m² without the basement -> 60 A
  assert.equal(a.service, 60);
  // heat 8 kW central and A/C 5 kW that can't run together: the larger, 8000
  const b = C.singleDwelling({ areaM2: 90, heatW: 8000, centralHeat: true, acW: 5000, interlocked: true, rangeW: 12000 });
  assert.equal(b.totalW, 5000 + 8000 + 6000);
  // 11,520 W charger capped at 7200 W by an EVEMS
  const c = C.singleDwelling({ areaM2: 90, rangeW: 12000, evseW: [11520], evems: true, evemsW: 7200 });
  assert.equal(c.totalW, 5000 + 6000 + 7200);
  // loads of 1500 W or less are in the basic load
  assert.equal(C.singleDwelling({ areaM2: 90, rangeW: 12000, otherW: [1500, 1200] }).totalW, 11000);
});

test('Rule 8-202 apartments', () => {
  // 70 m² unit: 3500 + 1500 (second 45 m²) = 5000; 100 m²: + 1000 for 10 m² past 90 = 6000
  assert.equal(C.dwellingUnitLoad({ areaM2: 70 }).basicW, 5000);
  assert.equal(C.dwellingUnitLoad({ areaM2: 100 }).basicW, 6000);
  assert.equal(C.dwellingUnitLoad({ areaM2: 40 }).basicW, 3500);
  // 6 units of 70 m² with a 12 kW range (11,000 W each), 5 kW heat each, 20 kW common loads:
  // 11,000 + 65% × 22,000 + 40% × 22,000 + 25% × 11,000 = 11,000 + 14,300 + 8,800 + 2,750 = 36,850
  // heat 30,000 -> 10,000 + 75% × 20,000 = 25,000; common 75% × 20,000 = 15,000. Total 76,850 W
  // at 120/208 V 3φ: 76,850 / (√3 × 208) = 213.3 A -> 225 A
  const units = Array.from({ length: 6 }, () => ({ areaM2: 70, rangeW: 12000, heatW: 5000 }));
  const r = C.apartmentService({ units, commonW: 20000, volts: 208, phase: 3 });
  near(r.totalW, 76850, 1e-6);
  near(r.amps, 213.31, 0.01);
  assert.equal(r.service, 225);
});

test('Provincial amendments as rule overrides', () => {
  // Ontario keeps Table 39 (Rule 4-004(26)); other provinces don't have it since 2021
  assert.deepEqual(C.table39(200, { province: 'ON' }), { amps: 200, cu: '2/0', maxCu: 175, al: '4/0', maxAl: 180 });
  assert.equal(C.table39(200, { province: 'BC' }), null);
  // Manitoba: voltage drop limit for branch circuits only
  assert.equal(C.ruleParams('8-102', 'MB').feeder, null);
  assert.equal(C.ruleParams('8-102', 'ON').feeder, 3);
  assert.equal(C.ruleParams('8-102', 'MB').branch, 3);
  assert.ok(C.amendmentsFor('SK', '26-').length >= 5);
  assert.deepEqual(C.amendmentsFor('BC'), []); // adopted with no deviations
  assert.deepEqual(C.amendmentsFor('NS'), []);
  assert.throws(() => C.ruleParams('99-999'), /No parameters/);
});

test('Motors: Table 44/45, Rules 28-106, 28-200, 28-306', () => {
  // 10 hp, 575 V: 11 A. Conductors 125% = 13.75 A -> 14 AWG (20 A at 75 °C).
  // Breaker 250% = 27.5 A -> 25 A (not above Table 29); time-delay fuse 175% = 19.25 -> 15 A;
  // non-time-delay fuse 300% = 33 A -> 30 A. Overload 125% = 13.75 A.
  const m = C.motor({ hp: '10', volts: 575, phase: 3 });
  assert.equal(m.flc, 11);
  near(m.conductorAmps, 13.75, 1e-9);
  assert.equal(m.conductor, '14');
  assert.equal(m.breaker, 25);
  assert.equal(m.tdFuse, 15);
  assert.equal(m.ntdFuse, 30);
  near(m.overloadMax, 13.75, 1e-9);
  near(m.wontStart.inverseTimeBreaker, 44, 1e-9); // 400% where the motor won't start
  assert.equal(C.motor({ hp: '10', volts: 575, phase: 3, serviceFactor115: false, nameplateA: 10.4 }).overloadMax, 11.96); // 115%
  assert.equal(C.motor({ hp: '5', volts: 230, phase: 1 }).flc, 28);
  assert.equal(C.motor({ hp: '25', volts: 575, phase: 3 }).flc, 27);
  // 1/2 hp at 575 V: 0.9 A × 250% = 2.25 A, but a 15 A device is always allowed
  assert.equal(C.motor({ hp: '1/2', volts: 575, phase: 3 }).breaker, 15);
  assert.equal(C.motor({ hp: '7', volts: 575, phase: 3 }), null);
});

test('Table 16 bonding conductors', () => {
  assert.deepEqual(C.bondingConductor(15), { upTo: 20, cu: '14', al: '12' });
  assert.deepEqual(C.bondingConductor(60), { upTo: 60, cu: '10', al: '8' });
  assert.equal(C.bondingConductor(100).cu, '8');
  assert.equal(C.bondingConductor(200).cu, '6');
  assert.deepEqual(C.bondingConductor(800), { upTo: 800, cu: '1/0', al: '3/0' });
  assert.equal(C.bondingConductor(7000), null);
});

test('Systems: 347/600 V and 600 V 3-wire panels, phase balance', () => {
  const S6 = '600 3ph 3w', S347 = '347/600 3ph';
  assert.equal(C.minPoles(S6), 2);
  assert.equal(C.minPoles(S347), 1);
  assert.equal(C.slotPhase(3, S347), 'B');
  // no neutral: phase voltage 600 / √3 = 346.4 V
  near(C.phaseVolts(S6), 346.41, 0.01);
  // a balanced 30 kVA three-phase load: 30,000 / (√3 × 600) = 28.87 A per phase
  const b = C.phaseBalance([{ slot: 1, poles: 3, loadVA: 30000 }], S6);
  near(b.perPhase.A, 10000, 1e-9);
  near(b.amps.A, 28.87, 0.01);
  near(C.totalAmps(30000, S6), 28.87, 0.01);
  // a 2-pole 6 kVA load line to line at 600 V draws 10 A
  near(C.circuitAmps({ loadVA: 6000, poles: 2 }, S6), 10, 1e-9);
  // 347 V lighting: 3470 VA on one pole = 10 A
  near(C.circuitAmps({ loadVA: 3470, poles: 1 }, S347), 10, 1e-9);
  // the NEC book shares the same systems and maths
  assert.ok('347/600 3ph' in NEC.PANEL_SYSTEMS);
  assert.equal(NEC.phaseBalance, C.phaseBalance);
  assert.deepEqual(C.systemsFor('CEC-2024').map((s) => s.value), ['120/240 1ph', '208/120 3ph', '347/600 3ph', '600 3ph 3w']);
  assert.ok(C.systemsFor('NEC-2023').some((s) => s.value === '480/277 3ph'));
});

test('Tandem (half-space) breakers: both halves on the space phase, counted in balance', () => {
  // On 120/240, space 1 is phase A and space 3 is phase B. A half circuit is always
  // single-pole and takes its space's phase, so two tandems in space 1 both land on A.
  assert.equal(C.slotPhase(1, '120/240 1ph'), 'A');
  assert.equal(C.slotPhase(3, '120/240 1ph'), 'B');
  const circuits = [
    { slot: 1, half: 'A', poles: 1, loadVA: 1200 },
    { slot: 1, half: 'B', poles: 1, loadVA: 600 },
    { slot: 3, half: 'A', poles: 1, loadVA: 1000 },
  ];
  const b = C.phaseBalance(circuits, '120/240 1ph');
  assert.equal(b.perPhase.A, 1800); // 1200 + 600, both halves of space 1
  assert.equal(b.perPhase.B, 1000);
  assert.equal(b.totalVA, 2800);
  // a half circuit draws line-to-neutral like any 1-pole: 1200 VA / 120 V = 10 A
  near(C.circuitAmps({ loadVA: 1200, poles: 1, half: 'A' }, '120/240 1ph'), 10, 1e-9);
  // even if a stray poles value were stored on a half, balance treats it as one pole on its space phase
  const strayPoles = C.phaseBalance([{ slot: 1, half: 'A', poles: 2, loadVA: 1000 }], '120/240 1ph');
  assert.equal(strayPoles.perPhase.A, 1000);
  assert.equal(strayPoles.perPhase.B, 0);
});

test('Checklists: CEC rule references plus provincial amendments', () => {
  const plain = C.cecTemplates(null);
  for (const t of plain) for (const [text, ref] of t.items) assert.ok(text && ref, `${t.title}: ${text}`);
  // no NEC article numbers (like 210.8) in the CEC templates
  assert.ok(!plain.some((t) => t.items.some(([, ref]) => /\d{3}\.\d/.test(ref))));
  const sk = C.cecTemplates('SK').find((t) => t.id === 'dwelling-rough-in');
  assert.ok(sk.items.some(([, ref]) => ref === '26-658 (SK)'));
  const on = C.cecTemplates('ON').find((t) => t.id === 'service');
  assert.ok(on.items.some(([, ref]) => ref === '4-004 (ON)'));
});

test('Adoption and inspection authorities', () => {
  assert.equal(Object.keys(C.ADOPTION).length, 13);
  assert.match(C.permitAuthority('ON'), /ESA/);
  assert.match(C.permitAuthority('SK'), /TSASK/);
  assert.match(C.permitAuthority('BC'), /Technical Safety BC/);
  assert.equal(C.adoptionFor('ON').effective, '2025-05-01');
  assert.equal(C.adoptionFor('NU').verify, true);
  assert.equal(C.codeBookOf({}), 'CEC-2024');
  assert.equal(C.codeBookOf({ codeBook: 'NEC-2023' }), 'NEC-2023');
});
