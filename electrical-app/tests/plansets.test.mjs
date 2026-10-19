// Run: node --test electrical-app/tests/
// Plan sets: page ranges, sheet names and labels, gallery grouping, scale transfer, takeoff merge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePageRange, formatPageRange, pageLabel, sheetLabel, setNameFromFile, sheetName, makePlanSet, sheetRecord,
  isDefaultDrawingName, renameSheet, sortSheets, groupDrawings, neighbours, hasOwnScale, transferScale, scaleTargets,
  mergeForTakeoff, DEFAULT_SCALE, UNDERLAY_MAX_CHARS, ENCODE_STEPS,
} from '../js/lib/plansets.js';

const pages = (text, max = 20, labels) => parsePageRange(text, max, labels);

test('page ranges: lists, ranges, spaces and dashes', () => {
  assert.deepEqual(pages('2-9, 12').pages, [2, 3, 4, 5, 6, 7, 8, 9, 12]);
  assert.deepEqual(pages(' 1 , 3 ,5 ').pages, [1, 3, 5]);
  assert.deepEqual(pages('2 - 4 7').pages, [2, 3, 4, 7]);
  assert.deepEqual(pages('3\u20135; 1').pages, [1, 3, 4, 5]); // en dash and semicolon
  assert.deepEqual(pages('9-2').pages, [2, 3, 4, 5, 6, 7, 8, 9]); // backwards still reads
  assert.deepEqual(pages('4, 4, 2-4').pages, [2, 3, 4]); // repeats collapse
  assert.deepEqual(pages('p.3, page7, P12').pages, [3, 7, 12]);
});

test('page ranges: all and open-ended', () => {
  assert.deepEqual(pages('all', 5).pages, [1, 2, 3, 4, 5]);
  assert.deepEqual(pages('*', 3).pages, [1, 2, 3]);
  assert.deepEqual(pages('18-', 20).pages, [18, 19, 20]);
  assert.deepEqual(pages('-3', 20).pages, [1, 2, 3]);
});

test('page ranges: errors say what is wrong', () => {
  assert.match(pages('').error, /Type the pages/);
  assert.match(pages('0').error, /no page 0/);
  assert.match(pages('2-25', 20).error, /Page 25 is past the end: this PDF has 20 pages/);
  assert.match(pages('21', 20).error, /past the end/);
  assert.match(pages('abc').error, /Can't read "abc"/);
  assert.match(pages('-').error, /Can't read/);
  assert.equal(pages('2', 1).error, 'Page 2 is past the end: this PDF has 1 page.');
  assert.deepEqual(pages('abc').pages, []);
});

test('page ranges: the PDF\'s own labels work too', () => {
  const labels = ['A0.1', 'E1.0', 'E1.1', 'E-101', 'E-102', '6'];
  assert.deepEqual(pages('e1.0', 6, labels).pages, [2]);
  assert.deepEqual(pages('E1.0-E1.1, 6', 6, labels).pages, [2, 3, 6]);
  assert.deepEqual(pages('E-101', 6, labels).pages, [4], 'a label with a dash is one label, not a range');
  assert.deepEqual(pages('E-101-E-102', 6, labels).pages, [4, 5]);
  assert.match(pages('E9.9', 6, labels).error, /Can't read "E9.9"/);
});

test('formatPageRange compresses runs and round-trips', () => {
  assert.equal(formatPageRange([1, 2, 3, 5, 7, 8, 9]), '1-3, 5, 7-9');
  assert.equal(formatPageRange([12, 2, 3, 2]), '2-3, 12');
  assert.equal(formatPageRange([]), '');
  const sel = [1, 4, 5, 6, 10, 11, 20];
  assert.deepEqual(parsePageRange(formatPageRange(sel), 20).pages, sel);
});

test('labels: the PDF label when it adds something, else "Page n"', () => {
  assert.equal(pageLabel(['1', '2', 'E1.0'], 1), null, 'a label that is just the page number is not a label');
  assert.equal(pageLabel(['1', '2', 'E1.0'], 3), 'E1.0');
  assert.equal(pageLabel(null, 4), null);
  assert.equal(pageLabel(['  E 2.0  '], 1), 'E 2.0');
  assert.equal(sheetLabel({ page: 3, label: null }), 'Page 3');
  assert.equal(sheetLabel({ page: 3, label: 'E1.0' }), 'E1.0');
});

test('names: file name without .pdf, then the sheet label or p.N', () => {
  assert.equal(setNameFromFile('Smith Reno  IFC.PDF'), 'Smith Reno IFC');
  assert.equal(setNameFromFile('C:\\plans\\2024-118 Electrical.pdf'), '2024-118 Electrical');
  assert.equal(setNameFromFile('.pdf'), 'Plan set');
  assert.equal(sheetName('Smith Reno', 'E1.0', 2), 'Smith Reno · E1.0');
  assert.equal(sheetName('Smith Reno', null, 3), 'Smith Reno · p.3');
});

test('makePlanSet and sheetRecord: typed fields, job and paper copied, unscaled', () => {
  const ps = makePlanSet({ id: 'set1', name: 'Smith Reno', page: '3', label: '', pageCount: 20, pxPerPt: 1.5802469135 });
  assert.deepEqual(ps, { id: 'set1', name: 'Smith Reno', page: 3, label: null, pageCount: 20, pxPerPt: 1.580247 });
  const layers = [{ id: 'L1', name: 'Plan', visible: true, locked: false, opacity: 1 }, { id: 'L9', name: 'Lighting', visible: false, locked: true, opacity: 0.5 }];
  const rec = sheetRecord({ jobId: 'job1', paper: 'dots', layers, strokes: [{ id: 'x' }] }, ps, { url: 'data:image/jpeg;base64,AA', w: 4096, h: 2731, thumb: 'data:t' });
  assert.equal(rec.name, 'Smith Reno · p.3');
  assert.equal(rec.jobId, 'job1');
  assert.equal(rec.paper, 'dots');
  assert.equal(rec.scale, DEFAULT_SCALE);
  assert.equal(rec.scaleSet, undefined);
  assert.deepEqual(rec.layers, layers);
  assert.notEqual(rec.layers[0], layers[0], 'layers are copies');
  assert.deepEqual(rec.strokes, [], 'markup is not copied');
  assert.equal(rec.underlayW, 4096);
  assert.equal(rec.underlayLocked, true);
  assert.equal(rec.planSet, ps);
  const bare = sheetRecord(null, makePlanSet({ id: 's', name: 'X', page: 1, label: 'E1', pageCount: 2 }));
  assert.equal(bare.jobId, null);
  assert.equal(bare.paper, 'grid');
  assert.deepEqual(bare.layers.map((l) => l.name), ['Plan', 'Power']);
});

test('default names are the ones the app makes', () => {
  assert.ok(isDefaultDrawingName('Untitled plan 3'));
  assert.ok(isDefaultDrawingName('Kitchen reno — plan 2'));
  assert.ok(isDefaultDrawingName(''));
  assert.ok(!isDefaultDrawingName('Main floor power'));
  assert.equal(renameSheet('Old · E1.0', 'Old', 'New'), 'New · E1.0');
  assert.equal(renameSheet('My own name', 'Old', 'New'), 'My own name');
});

const sheet = (id, page, extra = {}) => ({ id, name: `Set · p.${page}`, updatedAt: extra.updatedAt || '2026-10-01T00:00:00Z', scale: 24, planSet: { id: extra.set || 'S', name: 'Set', page, label: null, pageCount: 20, pxPerPt: extra.pxPerPt ?? 1.58 }, ...extra.d });

test('grouping: one entry per set, sheets in page order, singles untouched', () => {
  const rows = [
    { id: 'a', name: 'Sketch', updatedAt: '2026-10-05' },
    sheet('s3', 3, { updatedAt: '2026-10-04' }),
    { id: 'b', name: 'Old plan', updatedAt: '2026-10-03' },
    sheet('s1', 1, { updatedAt: '2026-10-02' }),
    sheet('s2', 2, { updatedAt: '2026-10-01' }),
    sheet('t1', 1, { set: 'T' }),
  ];
  const g = groupDrawings(rows);
  assert.deepEqual(g.map((x) => x.kind), ['single', 'set', 'single', 'single']);
  assert.equal(g[0].drawing.id, 'a');
  assert.deepEqual(g[1].sheets.map((s) => s.id), ['s1', 's2', 's3']);
  assert.equal(g[1].updatedAt, '2026-10-04');
  assert.equal(g[1].name, 'Set');
  assert.equal(g[2].drawing.id, 'b');
  assert.equal(g[3].drawing.id, 't1', 'a set with one sheet left shows as a single drawing');
  assert.deepEqual(groupDrawings([]), []);
});

test('neighbours: prev and next within the set', () => {
  const sheets = sortSheets([sheet('c', 3), sheet('a', 1), sheet('b', 2)]);
  assert.deepEqual(sheets.map((s) => s.id), ['a', 'b', 'c']);
  const mid = neighbours(sheets, 'b');
  assert.equal(mid.index, 1); assert.equal(mid.count, 3); assert.equal(mid.prev.id, 'a'); assert.equal(mid.next.id, 'c');
  assert.equal(neighbours(sheets, 'a').prev, null);
  assert.equal(neighbours(sheets, 'c').next, null);
  assert.equal(neighbours(sheets, 'zz').index, -1);
});

test('scale: own scale, transfer across render sizes, targets', () => {
  assert.ok(!hasOwnScale({ scale: 24 }));
  assert.ok(!hasOwnScale({}));
  assert.ok(hasOwnScale({ scale: 24, scaleSet: true }), 'set on purpose to the default still counts');
  assert.ok(hasOwnScale({ scale: 31.5 }), 'older drawings with a changed scale count as scaled');
  assert.equal(transferScale(48, 1.5, 3), 96);
  assert.equal(transferScale(48, null, 3), 48, 'unknown render size: copy as is');
  const src = sheet('a', 1, { pxPerPt: 1.5, d: { scale: 60, scaleSet: true } });
  const sheets = [src, sheet('b', 2, { pxPerPt: 1.5 }), sheet('c', 3, { pxPerPt: 3 }), sheet('d', 4, { pxPerPt: 1.5, d: { scale: 12, scaleSet: true } })];
  assert.deepEqual(scaleTargets(sheets, src, 'unscaled'), [{ id: 'b', scale: 60 }, { id: 'c', scale: 120 }]);
  assert.deepEqual(scaleTargets(sheets, src, 'all').map((t) => t.id), ['b', 'c', 'd']);
});

// The estimate takeoff lives in modules/estimates.js, which pulls in ui.js; ui.js only adds a
// keydown listener when it loads, so a stub document is enough to use the real function here.
async function estimateTakeoff() {
  globalThis.document ??= { addEventListener() {} };
  return (await import('../js/modules/estimates.js')).takeoff;
}

test('takeoff for a whole set is the sum of its sheets', async () => {
  const takeoff = await estimateTakeoff();
  const items = [
    { id: 'i1', symbol: 'receptacle', name: 'Duplex receptacle', priceCents: 300, labourHours: 0.3 },
    { id: 'i2', symbol: 'switch', name: 'Switch', priceCents: 250, labourHours: 0.25 },
    { id: 'i3', category: 'Breakers', name: 'AFCI breaker 15A', priceCents: 6000 },
  ];
  const store = { list: (c) => (c === 'items' ? items : []) };
  const s1 = { id: 's1', objects: [{ symbol: 'receptacle' }, { symbol: 'receptacle', flags: { afci: true }, circuit: '3' }, { symbol: 'switch' }] };
  const s2 = { id: 's2', objects: [{ symbol: 'receptacle', flags: { afci: true }, circuit: '3' }, { symbol: 'receptacle', flags: { afci: true } }] };
  const merged = takeoff(store, mergeForTakeoff([s1, s2]));
  const qty = (name) => merged.lines.find((l) => l.description.startsWith(name))?.qty;
  assert.equal(qty('Duplex receptacle'), 4);
  assert.equal(qty('Switch'), 1);
  const sum = (name) => [s1, s2].reduce((a, s) => a + (takeoff(store, s).lines.find((l) => l.description.startsWith(name))?.qty || 0), 0);
  assert.equal(qty('AFCI breaker'), sum('AFCI breaker'), 'circuit 3 on two sheets is two circuits, like two takeoffs');
  assert.equal(qty('AFCI breaker'), 3);
  assert.equal(merged.symbols, 5);
  assert.deepEqual(mergeForTakeoff([]), { objects: [] });
});

test('store.list can leave heavy fields out of its copies (gallery, sheet bar)', async () => {
  const { store } = await import('../js/store.js');
  await store.open({ kind: 'demo' });
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(1000);
  const a = store.add('drawings', { name: 'Set · E1.0', underlay: big, objects: [{ id: 'o' }], planSet: { id: 'S', page: 1 } }, { silent: true });
  store.add('drawings', { name: 'Loose', underlay: null }, { silent: true });
  const slim = store.list('drawings', (d) => d.planSet?.id === 'S', { omit: ['underlay', 'strokes'] });
  assert.equal(slim.length, 1);
  assert.equal(slim[0].id, a.id);
  assert.ok(!('underlay' in slim[0]));
  assert.deepEqual(slim[0].objects, [{ id: 'o' }]);
  slim[0].objects.push({ id: 'x' });
  assert.equal(store.get('drawings', a.id).objects.length, 1, 'still copies, not the stored arrays');
  assert.equal(store.get('drawings', a.id).underlay, big, 'the record itself keeps its underlay');
  assert.equal(store.list('drawings').length, 2, 'without opts nothing changes');
  await store.close();
});

test('underlay budget sits under the drawings schema and record limits', async () => {
  const { readFile } = await import('node:fs/promises');
  const schema = JSON.parse(await readFile(new URL('../js/schema/drawings.json', import.meta.url), 'utf8'));
  assert.ok(UNDERLAY_MAX_CHARS < schema.properties.underlay.maxLength);
  assert.ok(UNDERLAY_MAX_CHARS + schema.properties.thumb.maxLength < 24 * 1024 * 1024, 'room left in a 24 MiB drawing record');
  assert.equal(ENCODE_STEPS[0].quality, 0.9, 'normal pages keep today\'s quality');
  assert.ok(ENCODE_STEPS.every((s, i) => i === 0 || s.quality * s.scale <= ENCODE_STEPS[i - 1].quality * ENCODE_STEPS[i - 1].scale));
  const ps = schema.properties.planSet;
  assert.ok(ps, 'drawings schema types planSet');
  assert.deepEqual(ps.type, ['object', 'null']);
  for (const k of ['id', 'name', 'page', 'label', 'pageCount', 'pxPerPt']) assert.ok(ps.properties[k], `planSet.${k} is typed`);
  assert.deepEqual(schema.properties.scaleSet.type, ['boolean', 'null']);
});
