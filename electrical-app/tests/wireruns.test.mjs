// Run: node --test electrical-app/tests/
// Wire runs: totals, allowances, conversions, rolls, estimate lines, AR helpers and the PDF writer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as W from '../js/lib/wireruns.js';
import * as AR from '../js/lib/ar-measure.js';
import { createPdf, createFlow, textWidth, wrapText, toWinAnsi, pdfString, jpegInfo, dataUrlToBytes } from '../js/lib/pdf.js';
import { M_PER_FT, inToM } from '../js/lib/units.js';

const near = (a, b, tol = 1e-6, msg = '') => assert.ok(a != null && Math.abs(a - b) <= tol, `${msg} expected ${b}, got ${a}`);

// 8x6 RGB and 3x2 greyscale progressive JPEGs, made with Pillow.
const JPEG_RGB = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAGAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDP8Bf8v/8A2z/9mooor5TMv96l8vyR6mH/AIaP/9k=';
const JPEG_GREY = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//wgALCAACAAMBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oACAEBAAAAEH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==';

/** A run with numbers that are easy to check by hand. */
function sampleRun(extra = {}) {
  return W.normalizeRun({
    id: 'r1', name: 'Kitchen feed', jobId: 'j1', location: 'Kitchen', wiringMethod: 'cable',
    segments: [
      { id: 's1', label: 'Panel to kitchen', lengthM: 10, source: 'ar', note: '' },
      { id: 's2', label: 'Along counter', lengthM: 5.5, source: 'plan', note: '' },
      { id: 's3', label: 'Typed', lengthM: 2, source: 'manual', note: '' },
    ],
    allowances: { drops: [{ label: 'Receptacles', count: 4, lengthM: 1.2 }], boxCount: 5, boxMakeupM: 0.3, panelMakeupM: 0.9, wastePct: 10 },
    conductors: [{ id: 'c1', description: 'NMD90 14/2', size: '14/2', material: 'cu', type: 'NMD90', count: 1 }],
    photos: [], notes: '',
    ...extra,
  });
}

// ---------- defaults and the CEC value ----------
test('box makeup default comes from the CEC free-conductor rule (2 cable ends x 150 mm)', () => {
  assert.equal(W.CEC_FREE_CONDUCTOR_M, 0.15);
  assert.match(W.CEC_FREE_CONDUCTOR_REF, /12-3000/);
  near(W.DEFAULT_BOX_MAKEUP_M, 0.3);
  const r = W.newRun({ name: 'A' });
  near(r.allowances.boxMakeupM, 0.3);
  assert.equal(r.allowances.wastePct, W.DEFAULT_WASTE_PCT);
  assert.equal(r.conductors.length, 1);
  assert.equal(r.conduit, null);
  assert.deepEqual(W.newRun({ method: 'conduit' }).conduit, { type: 'EMT', tradeSize: '21' });
});

test('normalizeRun fills gaps without overwriting zeros', () => {
  const r = W.normalizeRun({ name: 'x', allowances: { boxMakeupM: 0, wastePct: 0 } });
  assert.equal(r.allowances.boxMakeupM, 0);
  assert.equal(r.allowances.wastePct, 0);
  near(r.allowances.panelMakeupM, W.DEFAULT_PANEL_MAKEUP_M);
  assert.deepEqual(r.segments, []);
  assert.equal(r.wiringMethod, 'cable');
  const bad = W.normalizeRun({ segments: [{ lengthM: -3, source: 'nope' }] });
  assert.equal(bad.segments[0].lengthM, 0);
  assert.equal(bad.segments[0].source, 'manual');
});

// ---------- totals ----------
test('run totals: segments, drops, boxes, panel, waste, per conductor', () => {
  const t = W.runTotals(sampleRun());
  near(t.runM, 17.5);
  near(t.dropsM, 4.8);           // 4 x 1.2
  near(t.boxesM, 1.5);           // 5 x 0.3
  near(t.panelM, 0.9);
  near(t.allowancesM, 7.2);
  near(t.subtotalM, 24.7);
  near(t.wasteM, 2.47);
  near(t.totalM, 27.17);
  assert.equal(t.conductors[0].lengthM, 27.17);
  near(t.bySource.ar, 10); near(t.bySource.plan, 5.5); near(t.bySource.manual, 2);
  assert.equal(t.segmentCount, 3);
  assert.equal(t.dropCount, 4);
});

test('each conductor needs count x (run + allowances)', () => {
  const r = sampleRun({ wiringMethod: 'conduit', conduit: { type: 'EMT', tradeSize: '21' },
    conductors: [{ id: 'a', description: 'T90 12 black', size: '12', type: 'T90 Nylon', count: 2 }, { id: 'b', description: 'T90 12 green', size: '12', count: 1 }] });
  const t = W.runTotals(r);
  near(t.conductors[0].lengthM, 2 * 27.17);
  near(t.conductors[1].lengthM, 27.17);
  near(t.conductorM, 3 * 27.17);
  // conduit has no box or panel makeup: (run + drops) x (1 + waste)
  near(t.conduitM, (17.5 + 4.8) * 1.1, 1e-3);
  assert.equal(t.conduitSticks, Math.ceil(((17.5 + 4.8) * 1.1) / W.STICK_M));
});

test('empty run totals are zero, not NaN, even with default panel makeup', () => {
  const t = W.runTotals({});
  assert.equal(t.runM, 0);
  assert.equal(t.totalM, 0);
  assert.equal(t.conduitM, 0);
  assert.deepEqual(t.conductors, []);
  assert.equal(W.runTotals(W.newRun()).conductors[0].lengthM, 0);
  // drops alone are a path, so makeup counts
  const dropsOnly = W.runTotals({ allowances: { drops: [{ count: 1, lengthM: 2 }], boxCount: 1, boxMakeupM: 0.3, panelMakeupM: 0, wastePct: 0 } });
  near(dropsOnly.totalM, 2.3);
});

// ---------- rolls ----------
test('suggestRolls: least left over, then fewest rolls', () => {
  assert.deepEqual(W.suggestRolls(50).rolls, [{ sizeM: 75, count: 1 }]);
  assert.deepEqual(W.suggestRolls(75).rolls, [{ sizeM: 75, count: 1 }]);
  assert.deepEqual(W.suggestRolls(80).rolls, [{ sizeM: 150, count: 1 }]);
  assert.deepEqual(W.suggestRolls(160).rolls, [{ sizeM: 150, count: 1 }, { sizeM: 75, count: 1 }]);
  assert.deepEqual(W.suggestRolls(230).rolls, [{ sizeM: 300, count: 1 }]);
  assert.deepEqual(W.suggestRolls(700).rolls, [{ sizeM: 300, count: 2 }, { sizeM: 150, count: 1 }]); // 750 m in 3 rolls beats 4
  const r = W.suggestRolls(160);
  assert.equal(r.suppliedM, 225);
  near(r.leftoverM, 65);
  assert.equal(r.count, 2);
  assert.equal(W.suggestRolls(160).single, 300);
  assert.equal(W.suggestRolls(400).single, null);
  assert.deepEqual(W.suggestRolls(0).rolls, []);
});

test('suggestRolls works with odd sizes (feet coils)', () => {
  const ft = (n) => n * M_PER_FT;
  const r = W.suggestRolls(ft(300), [ft(250), ft(500), ft(1000)]);
  assert.equal(r.rolls.length, 1);
  near(r.rolls[0].sizeM, ft(500), 1e-9);
});

test('rolls label shows feet for imperial users', () => {
  const r = W.suggestRolls(160);
  assert.equal(W.rollsLabel(r, 'metric'), '1 × 150 m + 1 × 75 m');
  assert.equal(W.rollsLabel(r, 'imperial'), '1 × 150 m (492 ft) + 1 × 75 m (246 ft)');
  assert.equal(W.rollsLabel(null), 'Cut to length');
  assert.equal(W.leftoverLabel(r, 'metric'), '65.00 m left over');
});

test('8 AWG and bigger is cut to length, not sold in coils', () => {
  assert.equal(W.isCutToLength('14/2'), false);
  assert.equal(W.isCutToLength('12'), false);
  assert.equal(W.isCutToLength('10/3'), false);
  assert.equal(W.isCutToLength('8/3'), true);
  assert.equal(W.isCutToLength('6'), true);
  assert.equal(W.isCutToLength('1/0'), true);
  assert.equal(W.isCutToLength('250 kcmil'), true);
  assert.equal(W.isCutToLength(''), false);
  assert.deepEqual(W.gaugeOf('2/0'), { awg: -1, kcmil: null });
  const t = W.runTotals(sampleRun({ conductors: [{ id: 'x', size: '6/3', type: 'NMD90', count: 1 }] }));
  assert.equal(t.conductors[0].rolls, null);
  assert.equal(t.conductors[0].cut, true);
});

test('conductor descriptions build from type, size and material', () => {
  assert.equal(W.autoDescription({ type: 'NMD90', size: '14/2', material: 'cu' }), 'NMD90 14/2');
  assert.equal(W.autoDescription({ type: 'T90 Nylon', size: '12', material: 'cu' }), 'T90 Nylon 12 AWG');
  assert.equal(W.autoDescription({ type: 'RW90', size: '1/0', material: 'al' }), 'RW90 1/0 AWG Al');
  assert.equal(W.autoDescription({ type: 'RW90', size: '250', material: 'cu' }), 'RW90 250 kcmil');
  assert.equal(W.conductorLabel({ description: 'Feeder' }), 'Feeder');
  assert.equal(W.conductorLabel({}), 'Conductor');
});

// ---------- price-book units ----------
test('normUnit and parseItemLength read the ways units get written', () => {
  assert.equal(W.normUnit('ft'), 'ft');
  assert.equal(W.normUnit('Feet'), 'ft');
  assert.equal(W.normUnit('m'), 'm');
  assert.equal(W.normUnit('metre'), 'm');
  assert.equal(W.normUnit('C'), '100ft');
  assert.equal(W.normUnit('100 ft'), '100ft');
  assert.equal(W.normUnit('MFT'), '1000ft');
  assert.equal(W.normUnit('roll'), 'roll');
  assert.equal(W.normUnit('stick'), 'stick');
  assert.equal(W.normUnit('ea'), 'ea');
  assert.equal(W.parseItemLength('NMD90 14/2, 150 m (492\')'), 150);
  near(W.parseItemLength('3/4" EMT, 10 ft stick'), 3.048);
  assert.equal(W.parseItemLength('75m coil'), 75);
  assert.equal(W.parseItemLength('16 mm ENT'), null);
  assert.equal(W.parseItemLength('Duplex receptacle'), null);
});

test('qtyForItem converts metres into the item unit, rounded up', () => {
  near(W.qtyForItem(27.17, { unit: 'm' }).qty, 28);
  assert.equal(W.qtyForItem(27.17, { unit: 'ft' }).qty, Math.ceil(27.17 / M_PER_FT)); // 89.14 ft -> 90
  assert.equal(W.qtyForItem(27.17, { unit: 'ft' }).qty, 90);
  assert.equal(W.qtyForItem(30.48, { unit: 'ft' }).qty, 100); // exactly 100 ft stays 100
  assert.equal(W.qtyForItem(27.17, { unit: '100 ft' }).qty, 0.9);
  assert.equal(W.qtyForItem(27.17, { unit: 'roll', name: 'NMD90 14/2 75 m' }).qty, 1);
  assert.equal(W.qtyForItem(160, { unit: 'coil', name: 'NMD90 14/2, 150 m' }).qty, 2);
  assert.equal(W.qtyForItem(160, { unit: '75 m roll', name: 'NMD90 14/2' }).qty, 3);
  assert.equal(W.qtyForItem(20, { unit: 'stick', name: '3/4" EMT, 10 ft stick' }).qty, 7); // 20 / 3.048 = 6.56
  assert.equal(W.qtyForItem(20, { unit: 'stick', name: 'EMT 21' }).qty, Math.ceil(20 / W.STICK_M));
  assert.equal(W.qtyForItem(20, { unit: 'roll', name: 'Mystery roll' }), null);
  assert.equal(W.qtyForItem(20, { unit: 'ea', name: 'Receptacle' }), null);
});

// ---------- estimates ----------
const ITEMS = [
  { id: 'nm14', sku: 'WR-NM-14-2', name: 'NM-B 14/2 w/G', category: 'Wire', unit: 'ft', priceCents: 140, labourHours: 0 },
  { id: 'nmd150', name: 'NMD90 12/2, 150 m', category: 'Wire', unit: 'coil', priceCents: 21900, labourHours: 0 },
  { id: 'rec', name: 'Duplex receptacle', category: 'Devices', unit: 'ea', priceCents: 1200, labourHours: 0.45 },
  { id: 'emt', name: '3/4" EMT, 10 ft stick', category: 'Conduit', unit: 'stick', priceCents: 2400, labourHours: 0.35 },
];

test('estimate lines: price-book match in the item unit, else a custom material line', () => {
  const run = sampleRun({ conductors: [
    { id: 'a', description: 'NMD90 14/2', size: '14/2', type: 'NMD90', count: 1, itemId: 'nm14' },
    { id: 'b', description: 'NMD90 12/2', size: '12/2', type: 'NMD90', count: 1, itemId: 'nmd150' },
    { id: 'c', description: 'Odd one', size: '14/3', count: 1 },
    { id: 'd', description: 'Wrong item', size: '14/2', count: 1, itemId: 'rec' },
  ] });
  const { lines, warnings } = W.estimateLines(run, ITEMS, { units: 'metric' });
  assert.equal(lines.length, 4);
  assert.deepEqual(lines[0], { itemId: 'nm14', description: 'NM-B 14/2 w/G (Kitchen feed)', qty: 90, unitCents: 140, labourHours: 0, kind: 'material' });
  assert.equal(lines[1].itemId, 'nmd150');
  assert.equal(lines[1].qty, 1);
  assert.deepEqual(lines[2], { itemId: null, description: 'Odd one, m (Kitchen feed)', qty: 28, unitCents: 0, labourHours: 0, kind: 'material' });
  assert.equal(lines[3].itemId, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ea/);
  // imperial users get custom lines in feet
  const imp = W.estimateLines(run, ITEMS, { units: 'imperial' });
  assert.equal(imp.lines[2].description, 'Odd one, ft (Kitchen feed)');
  assert.equal(imp.lines[2].qty, 90);
  // every line has the shape estimates.js uses
  for (const l of lines) assert.deepEqual(Object.keys(l).sort(), ['description', 'itemId', 'kind', 'labourHours', 'qty', 'unitCents']);
});

test('estimate lines add conduit sticks for conduit runs', () => {
  const run = sampleRun({ wiringMethod: 'conduit', conduit: { type: 'EMT', tradeSize: '21' }, conductors: [] });
  assert.equal(W.matchConduitItem(run, ITEMS)?.id, 'emt');
  const t = W.runTotals(run);
  const { lines } = W.estimateLines(run, ITEMS, { conduitItemId: 'emt' });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].itemId, 'emt');
  assert.equal(lines[0].qty, Math.ceil(t.conduitM / 3.048 - 1e-9));
  const custom = W.estimateLines(run, ITEMS, { conduitItemId: null }).lines[0];
  assert.equal(custom.itemId, null);
  assert.equal(custom.qty, t.conduitSticks);
  assert.equal(W.estimateLines(run, ITEMS, { includeConduit: false }).lines.length, 0);
  assert.equal(W.matchConduitItem({ ...run, conduit: { type: 'PVC', tradeSize: '53' } }, ITEMS), null);
});

test('a new estimate has the fields estimates.js writes', () => {
  const e = W.newEstimateRecord({ number: 'E-2005', settings: { labourRateCents: 9800, taxPct: 13 }, job: { id: 'j1', clientId: 'c1', title: 'Miller kitchen' }, run: { name: 'Kitchen feed' }, validUntil: '2026-11-18' });
  assert.deepEqual(e, { number: 'E-2005', clientId: 'c1', jobId: 'j1', title: 'Miller kitchen', status: 'draft', lines: [], labourRateCents: 9800, markupPct: 0, taxPct: 13, notes: '', validUntil: '2026-11-18' });
  const loose = W.newEstimateRecord({ number: 'E-1', run: { name: 'Shed' } });
  assert.equal(loose.jobId, null);
  assert.equal(loose.title, 'Wire: Shed');
  assert.equal(loose.labourRateCents, 9500);
});

// ---------- files ----------
test('file names: run name and job number, safe for every OS', () => {
  assert.equal(W.runFileName({ name: 'Kitchen feed' }, { number: 'J-1004' }), 'Kitchen feed - J-1004.pdf');
  assert.equal(W.runFileName({ name: 'Kitchen feed' }, null), 'Kitchen feed.pdf');
  assert.equal(W.runFileName({ name: 'A/B: "panel" <2>' }, { number: 'J-1' }, 'csv'), 'A B panel 2 - J-1.csv');
  assert.equal(W.runFileName({ name: '   ' }, null), 'Wire run.pdf');
});

test('CSV has metres and display lengths, quotes commas and blocks formulas', () => {
  const run = sampleRun({ notes: 'Pull, then "label"', segments: [{ id: 's', label: '=HYPERLINK("x")', lengthM: 3.5, source: 'manual', note: 'a,b' }] });
  const csv = W.runToCsv(run, { units: 'imperial', jobLabel: 'J-1004 · Miller' });
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'Wire run,Kitchen feed');
  assert.ok(lines.includes(`1,"'=HYPERLINK(""x"")",Typed,3.500,"11' 5 3/4""","a,b"`), csv);
  assert.ok(csv.includes('Notes,"Pull, then ""label"""'));
  assert.ok(csv.includes('Total per conductor'));
});

// ---------- paths and lists ----------
test('segmentsFromPath: one segment, or one per leg', () => {
  const path = AR.pathFromPoints([{ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, { x: 3, y: 4, z: 0 }]);
  near(path.totalM, 7);
  const one = W.segmentsFromPath(path, { source: 'ar', label: 'Hall' });
  assert.equal(one.length, 1);
  assert.equal(one[0].lengthM, 7);
  assert.equal(one[0].points.length, 3);
  assert.equal(one[0].source, 'ar');
  const legs = W.segmentsFromPath(path, { source: 'plan', label: 'Hall', split: true });
  assert.deepEqual(legs.map((s) => [s.label, s.lengthM, s.points.length]), [['Hall 1', 3, 2], ['Hall 2', 4, 2]]);
  assert.notEqual(legs[0].id, legs[1].id);
});

test('plan pixels to metres use the drawing scale (px per foot)', () => {
  near(W.pxToM(24, 24), M_PER_FT);
  near(W.pxToM(240, 24), 10 * M_PER_FT);
  assert.ok(Number.isNaN(W.pxToM(10, 0)));
});

test('filterRuns by job and search text', () => {
  const runs = [
    { id: '1', name: 'Kitchen feed', jobId: 'j1', conductors: [{ description: 'NMD90 14/2' }] },
    { id: '2', name: 'Garage', jobId: null, location: 'Detached garage' },
    { id: '3', name: 'Basement', jobId: 'j2' },
  ];
  const jobs = [{ id: 'j1', number: 'J-1004', title: 'Miller' }, { id: 'j2', number: 'J-1005', title: 'Alvarez' }];
  assert.deepEqual(W.filterRuns(runs, { jobId: 'j1' }).map((r) => r.id), ['1']);
  assert.deepEqual(W.filterRuns(runs, { jobId: '__none' }).map((r) => r.id), ['2']);
  assert.deepEqual(W.filterRuns(runs, { q: 'j-1005', jobs }).map((r) => r.id), ['3']);
  assert.deepEqual(W.filterRuns(runs, { q: 'nmd90' }).map((r) => r.id), ['1']);
  assert.deepEqual(W.filterRuns(runs, { q: 'detached' }).map((r) => r.id), ['2']);
});

test('duplicateRun copies everything with new ids', () => {
  const run = sampleRun({ createdAt: 'x', updatedAt: 'y', photos: [{ id: 'p1', dataUrl: JPEG_RGB, caption: 'c' }] });
  const c = W.duplicateRun(run);
  assert.equal(c.name, 'Kitchen feed (copy)');
  assert.equal(c.id, undefined);
  assert.equal(c.createdAt, undefined);
  assert.equal(c.segments.length, 3);
  assert.notEqual(c.segments[0].id, run.segments[0].id);
  assert.notEqual(c.conductors[0].id, run.conductors[0].id);
  assert.notEqual(c.photos[0].id, 'p1');
  c.segments[0].lengthM = 99;
  assert.equal(run.segments[0].lengthM, 10);
});

test('display: segments to 1/8", totals to the inch, both systems', () => {
  assert.equal(W.fmtSeg(inToM(147.625), 'imperial'), `12' 3 5/8"`);
  assert.equal(W.fmtTotal(inToM(147.625), 'imperial'), `12' 4"`);
  assert.equal(W.fmtTotal(27.17, 'metric'), '27.17 m');
  assert.equal(W.fmtBoth(30.48, 'metric'), `30.48 m (100')`);
  assert.equal(W.methodLabel(sampleRun({ wiringMethod: 'conduit', conduit: { type: 'EMT', tradeSize: '21' } })), 'Conduit, EMT 21 (3/4")');
});

// ---------- AR helpers ----------
test('normalizeResult tidies what the native plugin sends', () => {
  const fromPoints = AR.normalizeResult({ points: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 2.5, z: 0 }, { x: 1, y: 2.5, z: 0 }] });
  near(fromPoints.totalM, 3.5);
  assert.deepEqual(fromPoints.segments.map((s) => s.lengthM), [2.5, 1]);
  const fromSegs = AR.normalizeResult({ segments: [{ lengthM: 1.2 }, { lengthM: 0.8 }] });
  near(fromSegs.totalM, 2);
  const explicit = AR.normalizeResult({ totalM: 5, segments: [{ lengthM: 5 }], snapshot: JPEG_RGB });
  assert.equal(explicit.snapshot, JPEG_RGB);
  assert.equal(AR.normalizeResult({ totalM: 5, snapshot: 'data:image/png;base64,AAA' }).snapshot, undefined);
  assert.throws(() => AR.normalizeResult(null));
  assert.throws(() => AR.normalizeResult({ totalM: 0, segments: [] }));
});

test('cancel is recognised however the back end reports it', () => {
  assert.ok(AR.isCancelled('cancelled'));
  assert.ok(AR.isCancelled(new Error('cancelled')));
  assert.ok(AR.isCancelled(AR.cancelledError()));
  assert.ok(AR.isCancelled({ code: 'cancelled' }));
  assert.ok(!AR.isCancelled(new Error('camera denied')));
});

test('no AR in Node: support says none with a reason', async () => {
  const s = await AR.getArSupport({ refresh: true });
  assert.equal(s.mode, 'none');
  assert.ok(s.reason.length > 10);
});

test('AR geometry: ribbons face the eye, rings sit in the surface plane', () => {
  const r = AR.ribbon({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0.5, y: 0, z: 2 }, 0.01);
  assert.equal(r.length, 18);
  // strip is offset along y (perpendicular to the line and to the view direction)
  near(Math.abs(r[1]), 0.01); near(r[2], 0);
  assert.deepEqual(AR.ribbon({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 0.01), []);
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 3, 4, 1];
  assert.deepEqual(AR.transformPoint(T, 1, 1, 1), [3, 4, 5]);
  const ring = AR.ring(I, 0.03, 0.04, 16);
  assert.equal(ring.length, 16 * 18);
  for (let i = 1; i < ring.length; i += 3) near(ring[i], 0); // y stays 0: flat on the surface
  const sq = AR.billboard({ x: 0, y: 0, z: 0 }, I, 0.5);
  assert.equal(sq.length, 18);
  const scene = AR.sceneGeometry([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], { matrix: I, position: { x: 1, y: 1, z: 0 } }, { position: { x: 0, y: 0, z: 2 }, matrix: I });
  assert.equal(scene.lines.length, 18);
  assert.equal(scene.dots.length, 36);
  assert.equal(scene.live.length, 18);
  assert.ok(scene.ring.length > 0 && scene.ringActive);
});

// ---------- PDF writer ----------
const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');

/** Check the cross-reference table and every stream length. Returns the PDF as a string. */
function checkStructure(bytes) {
  const s = latin1(bytes);
  assert.ok(s.startsWith('%PDF-1.4\n'), 'header');
  assert.ok(s.endsWith('%%EOF\n'), 'trailer end');
  const startxref = Number(s.match(/startxref\n(\d+)\n%%EOF\n$/)[1]);
  assert.equal(s.slice(startxref, startxref + 4), 'xref');
  const [, first, count] = s.slice(startxref).match(/^xref\n(\d+) (\d+)\n/);
  assert.equal(Number(first), 0);
  const entries = s.slice(startxref).split('\n').slice(2, 2 + Number(count));
  assert.equal(entries[0], '0000000000 65535 f ');
  for (let n = 1; n < entries.length; n++) {
    const off = Number(entries[n].slice(0, 10));
    assert.ok(s.startsWith(`${n} 0 obj\n`, off), `object ${n} at ${off}`);
  }
  assert.match(s, new RegExp(`trailer\\n<< /Size ${count} /Root 1 0 R /Info 5 0 R >>`));
  const re = /\/Length (\d+) >>\nstream\n/g;
  let m, streams = 0;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    assert.equal(s.slice(start + Number(m[1]), start + Number(m[1]) + 10), '\nendstream', 'stream length');
    streams++;
  }
  assert.ok(streams > 0);
  return s;
}

test('JPEG headers: size and colour components', () => {
  assert.deepEqual(jpegInfo(dataUrlToBytes(JPEG_RGB)), { bits: 8, height: 6, width: 8, components: 3, adobe: false });
  const g = jpegInfo(dataUrlToBytes(JPEG_GREY)); // progressive (SOF2)
  assert.equal(g.width, 3); assert.equal(g.height, 2); assert.equal(g.components, 1);
  assert.equal(jpegInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null);
});

test('Helvetica metrics, wrapping and WinAnsi text', () => {
  near(textWidth('Hello', 10), 22.78, 1e-9);           // 722+556+222+222+556
  near(textWidth('Hello', 10, true), 24.45, 1e-9);     // 722+556+278+278+611 (bold)
  near(textWidth('é', 10), 5.56, 1e-9);
  const lines = wrapText('The quick brown fox jumps over the lazy dog', 60, 10);
  assert.ok(lines.length > 1);
  for (const l of lines) assert.ok(textWidth(l, 10) <= 60);
  assert.equal(lines.join(' '), 'The quick brown fox jumps over the lazy dog');
  assert.deepEqual(wrapText('a\nb', 100), ['a', 'b']);
  assert.ok(wrapText('Supercalifragilistic', 30, 10).length > 1); // long words break
  assert.deepEqual(toWinAnsi('—’€×é中'), [151, 146, 128, 215, 233, 63]);
  assert.deepEqual(toWinAnsi('12′ 3″'), [49, 50, 39, 32, 51, 34]);
  assert.equal(pdfString('a(b)c\\'), 'a\\(b\\)c\\\\');
  assert.equal(pdfString('café — ok'), 'caf\\351 \\227 ok');
});

test('PDF writer: valid structure with text, lines, rectangles and a JPEG', () => {
  const doc = createPdf({ title: 'Test (1)', author: 'Kelvin', date: new Date('2026-10-19T12:00:00Z') });
  doc.addPage();
  doc.text('Hello (world)', 40, 60, { size: 12, bold: true });
  doc.text('Right', 572, 80, { align: 'right' });
  doc.line(40, 90, 572, 90, { width: 1, color: '#f5b301', dash: [3, 2] });
  doc.rect(40, 100, 200, 50, { fill: '#f6f4ef', stroke: '#1c1b19' });
  const img = doc.addJpeg(JPEG_RGB);
  assert.deepEqual(img, { id: 'Im1', width: 8, height: 6 });
  doc.image(img, 40, 160, 80, 60);
  doc.addPage();
  doc.text('Page two', 40, 60);
  assert.equal(doc.addJpeg('data:image/jpeg;base64,AAAA'), null);
  const s = checkStructure(doc.toBytes());
  assert.match(s, /\/Type \/Pages \/Kids \[\d+ 0 R \d+ 0 R\] \/Count 2/);
  assert.match(s, /\/BaseFont \/Helvetica \/Encoding \/WinAnsiEncoding/);
  assert.match(s, /\/BaseFont \/Helvetica-Bold/);
  assert.match(s, /\/Subtype \/Image \/Width 8 \/Height 6 \/ColorSpace \/DeviceRGB \/BitsPerComponent 8 \/Filter \/DCTDecode/);
  assert.ok(s.includes('(Hello \\(world\\)) Tj'));
  assert.ok(s.includes('/F2 12 Tf'));
  assert.ok(s.includes('40 732 Td')); // y flipped: 792 - 60
  assert.ok(s.includes('[3 2] 0 d'));
  assert.ok(s.includes('re B'));
  assert.ok(s.includes('80 0 0 60 40 572 cm /Im1 Do'));
  assert.ok(s.includes('/XObject << /Im1 6 0 R >>'));
  assert.ok(s.includes('/CreationDate (D:20261019120000Z)'));
  assert.ok(s.includes('/Title <FEFF00540065007300740020002800310029>'));
  // the JPEG bytes are embedded unchanged
  const jpeg = latin1(dataUrlToBytes(JPEG_RGB));
  assert.ok(s.includes(`stream\n${jpeg}\nendstream`));
});

test('flow layout breaks pages, repeats table headers and numbers pages', () => {
  const doc = createPdf();
  const flow = createFlow(doc, { footer: (i, n) => `Page ${i} of ${n}` });
  flow.heading('Long table');
  flow.table({ columns: [{ label: 'Item', width: 3 }, { label: 'Qty', align: 'right' }], rows: Array.from({ length: 120 }, (_, i) => [`Row ${i + 1}`, i]) });
  flow.paragraph('Done.');
  flow.finish();
  assert.ok(doc.pages.length >= 3);
  const s = checkStructure(doc.toBytes());
  assert.equal((s.match(/\(ITEM\) Tj/g) || []).length, doc.pages.length); // header on every page
  assert.ok(s.includes(`(Page 1 of ${doc.pages.length}) Tj`));
  assert.ok(s.includes(`(Page ${doc.pages.length} of ${doc.pages.length}) Tj`));
  assert.ok(s.includes('(Row 120) Tj'));
});

test('the wire-run report PDF has the run, totals, rolls and photos', () => {
  const run = sampleRun({ notes: 'Pull from the panel end.', photos: [{ id: 'p', dataUrl: JPEG_RGB, caption: 'Panel' }, { id: 'q', dataUrl: JPEG_GREY, caption: '' }] });
  const bytes = W.buildRunPdf(run, {
    company: { name: 'TG Electrical', phone: '555-0100' }, job: { number: 'J-1004', title: 'Miller kitchen', address: '9 Linden Ct' },
    client: { name: 'Jenna Miller' }, dateLabel: 'Oct 19, 2026', units: 'metric', brand: 'Fishtape',
  });
  const s = checkStructure(bytes);
  for (const text of ['TG Electrical', 'Kitchen feed', 'J-1004 \\267 Miller kitchen', 'Jenna Miller', 'Oct 19, 2026', 'Panel to kitchen', 'Run length', '17.50 m', '27.17 m', 'NMD90 14/2', 'Pull from the panel end.', 'Panel']) {
    assert.ok(s.includes(`(${text}) Tj`), `missing ${text}`);
  }
  assert.ok(s.includes('(1 \\327 75 m, 47.83 m left over) Tj'), 'rolls');
  assert.ok(s.includes('12-3000'));
  assert.ok(s.includes('AR tape lengths are estimates'));
  assert.equal((s.match(/\/Filter \/DCTDecode/g) || []).length, 2);
  assert.ok(s.includes('/ColorSpace /DeviceGray'));
  assert.match(s, /\(Page 1 of \d+\) Tj/);
  // imperial report shows feet and coil sizes in feet
  const imp = latin1(W.buildRunPdf(run, { units: 'imperial' }));
  assert.ok(imp.includes(`(89' 2") Tj`), 'per-conductor total in feet'); // 27.17 m
  assert.ok(imp.includes('(1 \\327 75 m \\(246 ft\\)'));
});
