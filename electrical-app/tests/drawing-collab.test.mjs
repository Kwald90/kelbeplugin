// Run: node --test electrical-app/tests/
// Collaborative drawings: attribution stamping, history diffing, the object-level merge,
// cost delta pricing and change-order lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  baselineOf, stampChanges, recordChange, describeEntry, mergeDrawing, authors, itemMatches, groupHistory, attributionLines,
  countWords, entryCount, diffIsEmpty, itemsDiffer, UNTRACKED_ID, BEFORE_TRACKING, HISTORY_MAX,
} from '../js/lib/drawing-collab.js';
import {
  canSeeMoney, drawingCounts, estimateCounts, changeOrderCounts, jobEstimate, costDelta, describeDelta, changeOrderFrom,
  jobCostImpact, redactCostImpact, whoChanged,
} from '../js/lib/drawing-costs.js';

const JACKSON = { id: 'emp-j', name: 'Jackson Reid' };
const MANNY = { id: 'emp-m', name: 'Manny Ortiz' };
const OFFICE = { id: 'emp-o', name: 'Office' };
const T = (min) => new Date(Date.UTC(2026, 9, 19, 20, min)).toISOString();
const rec = (id, x = 0, y = 0, symbol = 'receptacle') => ({ id, layer: 'L2', symbol, x, y, rotation: 0, scale: 1 });
const drawing = (o = {}) => ({ id: 'd1', layers: [{ id: 'L1' }, { id: 'L2' }], strokes: [], objects: [], texts: [], rooms: [], tombstones: {}, ...o });

test('stamping: new items get by/at, edits get editBy/editAt, old drawings keep working', () => {
  const d = drawing({ objects: [rec('old', 10, 10, 'junction')] }); // from before tracking: no stamps
  let base = baselineOf(d);
  d.objects.push(rec('a', 100, 0), rec('b', 140, 0));
  d.strokes.push({ id: 's1', layer: 'L1', tool: 'wire', points: [[0, 0, 0.5], [50, 0, 0.5]], color: '#c62f2f', size: 2 });
  let r = stampChanges(d, base, JACKSON, T(14));
  base = r.baseline;
  assert.deepEqual(d.objects[1].by, { id: 'emp-j', name: 'Jackson Reid' });
  assert.equal(d.objects[1].at, T(14));
  assert.equal(d.strokes[0].by.name, 'Jackson Reid');
  assert.equal(d.objects[0].by, undefined, 'untouched old items stay untracked');
  assert.deepEqual(attributionLines(d.objects[0]), [{ label: BEFORE_TRACKING, who: null, at: null }]);
  assert.equal(r.diff.add.length, 3);

  // Manny moves one receptacle and edits the old junction box; nothing else changes
  d.objects[1].x += 30;
  d.objects[0].flags = { wp: true };
  r = stampChanges(d, base, MANNY, T(20));
  assert.equal(r.diff.move.length, 1);
  assert.equal(r.diff.edit.length, 1);
  assert.deepEqual(d.objects[1].by, { id: 'emp-j', name: 'Jackson Reid' }, 'the creator stays');
  assert.equal(d.objects[1].editBy.name, 'Manny Ortiz');
  assert.equal(d.objects[1].editAt, T(20));
  assert.equal(d.objects[0].editBy.name, 'Manny Ortiz');
  assert.equal(d.objects[2].editBy, undefined);

  // a save with no changes stamps nothing
  r = stampChanges(d, r.baseline, OFFICE, T(30));
  assert.ok(diffIsEmpty(r.diff));
});

test('stamping: deletes leave tombstones; duplicates belong to whoever duplicated; undo restores the author', () => {
  const d = drawing();
  let base = baselineOf(d);
  d.objects.push(rec('a', 0, 0));
  base = stampChanges(d, base, JACKSON, T(1)).baseline;
  // Manny duplicates it (a JSON copy keeps Jackson's stamps, but it is a new id)
  d.objects.push({ ...JSON.parse(JSON.stringify(d.objects[0])), id: 'a2', x: 24 });
  let r = stampChanges(d, base, MANNY, T(2));
  assert.equal(d.objects[1].by.name, 'Manny Ortiz');
  assert.equal(d.objects[1].editBy, undefined);
  base = r.baseline;
  // Office deletes Jackson's
  const gone = d.objects.shift();
  r = stampChanges(d, base, OFFICE, T(3));
  assert.deepEqual(d.tombstones.a, { at: T(3), by: 'emp-o' });
  assert.equal(r.diff.del[0].tag, 'receptacle');
  base = r.baseline;
  // undo brings it back: still Jackson's, edited by whoever undid, after the tombstone
  d.objects.unshift(gone);
  r = stampChanges(d, base, OFFICE, T(4));
  assert.equal(d.objects[0].by.name, 'Jackson Reid');
  assert.equal(d.objects[0].editBy.name, 'Office');
  assert.ok(!d.tombstones.a);
  assert.ok(d.objects[0].editAt > T(3));
});

test('stamping: a clock behind the item still moves time forward', () => {
  const d = drawing({ objects: [{ ...rec('a'), by: JACKSON, at: T(50) }] });
  const base = baselineOf(d);
  d.objects[0].x = 99;
  stampChanges(d, base, MANNY, T(10)); // this device's clock says 40 minutes earlier
  assert.ok(d.objects[0].editAt > T(50));
  d.objects.pop();
  const r = stampChanges(d, baselineOf(drawing({ objects: [{ ...rec('a'), by: JACKSON, at: T(50) }] })), MANNY, T(10));
  assert.ok(d.tombstones.a.at > T(50), 'a tombstone always beats the edit it deletes');
  assert.equal(r.diff.del.length, 1);
});

test('history: counts per save, folded per person, in plain words', () => {
  const d = drawing();
  let base = baselineOf(d);
  let h = [];
  const save = (who, at) => { const r = stampChanges(d, base, who, at); base = r.baseline; h = recordChange(h, r.diff, who, at, { newId: () => `e${h.length + 1}-${at}` }); };
  d.objects.push(rec('r1', 0, 0), rec('r2', 40, 0));
  save(JACKSON, T(10));
  d.objects.push(rec('r3', 80, 0), rec('r4', 120, 0), { ...rec('g1', 160, 0), flags: { gfci: true } });
  save(JACKSON, T(14)); // within 15 minutes: same entry
  assert.equal(h.length, 1);
  assert.equal(describeEntry(h[0]), 'added 4 duplex receptacles and 1 GFCI');
  assert.equal(h[0].at, T(10));
  assert.equal(h[0].until, T(14));
  assert.ok(h[0].box[2] >= 160, 'the entry knows where to zoom');

  // added and deleted again inside the same entry cancels out
  d.objects.push(rec('oops', 300, 0));
  save(JACKSON, T(15));
  d.objects = d.objects.filter((o) => o.id !== 'oops');
  save(JACKSON, T(16));
  assert.equal(describeEntry(h[0]), 'added 4 duplex receptacles and 1 GFCI');

  // Manny moves two switches (moving one twice counts once)
  d.objects.push({ ...rec('s1', 0, 100, 'switch'), by: OFFICE, at: T(1) }, { ...rec('s2', 0, 140, 'switch'), by: OFFICE, at: T(1) });
  base = baselineOf(d);
  d.objects.find((o) => o.id === 's1').x = 20; d.objects.find((o) => o.id === 's2').x = 20;
  save(MANNY, T(20));
  d.objects.find((o) => o.id === 's1').x = 30;
  save(MANNY, T(21));
  assert.equal(h.length, 2);
  assert.equal(describeEntry(h[1]), 'moved 2 switches');

  // Office deletes a junction box an hour later: a new entry
  d.objects.push({ ...rec('j1', 0, 200, 'junction'), by: JACKSON, at: T(2) });
  base = baselineOf(d);
  d.objects = d.objects.filter((o) => o.id !== 'j1');
  save(OFFICE, T(80));
  assert.equal(h.length, 3);
  assert.equal(describeEntry(h[2]), 'deleted 1 junction box');
  assert.equal(entryCount(h[2]), 1);

  // grouped by day, then person, newest first
  const g = groupHistory(h.map((entry) => ({ entry, sheet: 'E1.0' })), { now: new Date(T(90)), dayKey: (iso) => iso.slice(0, 10) });
  assert.equal(g.length, 1);
  assert.equal(g[0].label, 'Today');
  assert.deepEqual(g[0].people.map((p) => p.by.name), ['Office', 'Manny Ortiz', 'Jackson Reid']);
});

test('history: capped, and plain words for every kind', () => {
  let h = [];
  for (let i = 0; i < HISTORY_MAX + 20; i++) {
    h = recordChange(h, { add: [{ id: `x${i}`, kind: 'strokes', tag: '@wire', box: [0, 0, 1, 1] }], del: [], move: [], edit: [] }, { id: `p${i}`, name: `P${i}` }, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString());
  }
  assert.equal(h.length, HISTORY_MAX);
  assert.equal(h[0].by.name, 'P20');
  assert.equal(countWords('@wire', 2), '2 wire runs');
  assert.equal(countWords('light-recessed', 3), '3 recessed lights');
  assert.equal(countWords('switch-3way', 1), '1 3-way switch');
  assert.equal(countWords('@text', 1), '1 label');
});

test('merge: two devices editing different objects both survive', () => {
  const base = drawing({ objects: [{ ...rec('a'), by: JACKSON, at: T(1) }, { ...rec('b', 50), by: JACKSON, at: T(1) }] });
  // device 1 (Jackson, offline) adds c and moves a
  const one = structuredClone(base);
  let b1 = baselineOf(one);
  one.objects[0].x = 5; one.objects.push(rec('c', 100));
  stampChanges(one, b1, JACKSON, T(10));
  one.history = recordChange([], { add: [{ id: 'c', tag: 'receptacle', box: null }], del: [], move: [], edit: [] }, JACKSON, T(10), { newId: () => 'h1' });
  // device 2 (Manny) deletes b and adds d
  const two = structuredClone(base);
  const b2 = baselineOf(two);
  two.objects = two.objects.filter((o) => o.id !== 'b');
  two.objects.push(rec('d', 200, 0, 'switch'));
  stampChanges(two, b2, MANNY, T(12));
  two.history = recordChange([], { add: [], del: [{ id: 'b', tag: 'receptacle', box: null }], move: [], edit: [] }, MANNY, T(12), { newId: () => 'h2' });

  // server has device 2's write; device 1 pushes later
  const merged = mergeDrawing(two, one);
  assert.deepEqual(merged.objects.map((o) => o.id).sort(), ['a', 'c', 'd']);
  assert.equal(merged.objects.find((o) => o.id === 'a').x, 5, "Jackson's move kept");
  assert.ok(merged.tombstones.b, "Manny's delete kept");
  assert.deepEqual(merged.history.map((e) => e.id), ['h1', 'h2']);
  // the other order gives the same items
  assert.deepEqual(mergeDrawing(one, two).objects.map((o) => o.id).sort(), ['a', 'c', 'd']);
  // idempotent: merging again changes nothing
  const again = mergeDrawing(merged, merged);
  assert.equal(JSON.stringify(again), JSON.stringify(merged));
  assert.ok(!itemsDiffer(again, merged));
  assert.ok(itemsDiffer(merged, one));
});

test('merge: the later edit of the same object wins; an edit after a delete brings it back', () => {
  const a = drawing({ objects: [{ ...rec('x', 1), by: JACKSON, at: T(1), editBy: JACKSON, editAt: T(5) }] });
  const b = drawing({ objects: [{ ...rec('x', 2), by: JACKSON, at: T(1), editBy: MANNY, editAt: T(7) }] });
  assert.equal(mergeDrawing(a, b).objects[0].x, 2);
  assert.equal(mergeDrawing(b, a).objects[0].x, 2, 'newer stored copy wins over an older incoming edit');
  const deleted = drawing({ objects: [], tombstones: { x: { at: T(6), by: 'emp-o' } } });
  assert.equal(mergeDrawing(deleted, b).objects.length, 1, 'edited at 7 after the delete at 6');
  assert.equal(mergeDrawing(deleted, a).objects.length, 0, 'edited at 5, deleted at 6');
  // untracked items with a tombstone are deleted
  assert.equal(mergeDrawing(drawing({ objects: [rec('old')] }), drawing({ objects: [], tombstones: { old: { at: T(1), by: 'x' } } })).objects.length, 0);
  // a write from an app before tracking (no tombstones) replaces the stored copy as before
  const legacy = { ...drawing({ objects: [] }) };
  delete legacy.tombstones;
  assert.equal(mergeDrawing(b, legacy).objects.length, 0);
  // a layer only the other copy has stays while an item uses it
  const withLayer = drawing({ layers: [{ id: 'L1' }, { id: 'L2' }, { id: 'L9' }], objects: [{ ...rec('z'), layer: 'L9', by: MANNY, at: T(9) }] });
  assert.deepEqual(mergeDrawing(withLayer, drawing()).layers.map((l) => l.id), ['L1', 'L2', 'L9']);
});

test('who drew what: authors, filters by person and date', () => {
  const d = drawing({
    objects: [{ ...rec('a'), by: JACKSON, at: T(1) }, { ...rec('b'), by: JACKSON, at: T(2), editBy: MANNY, editAt: T(3) }, rec('old')],
    strokes: [{ id: 's', tool: 'pen', points: [[0, 0]], by: JACKSON, at: T(4) }],
  });
  const list = authors(d);
  assert.deepEqual(list.map((a) => [a.name, a.count]), [['Jackson Reid', 2], ['Manny Ortiz', 1], [BEFORE_TRACKING, 1]]);
  const jack = list[0].key;
  assert.ok(itemMatches(d.objects[0], { who: jack }));
  assert.ok(!itemMatches(d.objects[1], { who: jack }), 'last editor counts');
  assert.ok(itemMatches(d.objects[2], { who: UNTRACKED_ID }));
  const now = new Date(T(30));
  assert.ok(itemMatches(d.objects[0], { when: 'today' }, now));
  assert.ok(!itemMatches(d.objects[2], { when: 'today' }, now), 'untracked items have no date');
  assert.ok(!itemMatches(d.objects[0], { when: 'yesterday' }, now));
});

// ---------- cost impact ----------

const ITEMS = [
  { id: 'i-rec', sku: 'REC', name: 'Duplex receptacle', symbol: 'receptacle', priceCents: 1200, costCents: 245, labourHours: 0.45 },
  { id: 'i-gfci', sku: 'GFCI', name: 'GFCI receptacle', symbol: 'receptacle-gfci', priceCents: 4800, costCents: 2100, labourHours: 0.6 },
  { id: 'i-jb', sku: 'JB', name: 'Junction box', symbol: 'junction', priceCents: 900, costCents: 300, labourHours: 0.3 },
  { id: 'i-wire', sku: 'NMD', name: 'NMD90 14/2', symbol: null, priceCents: 460 },
];

test('money roles: owner, admin, office; foremen when the company allows; crew never', () => {
  for (const role of ['owner', 'admin', 'office']) assert.ok(canSeeMoney({ role, perms: [] }), role);
  assert.ok(canSeeMoney({ role: 'x', perms: new Set(['estimates']) }));
  assert.ok(!canSeeMoney({ role: 'foreman', perms: ['jobs', 'drawings'] }));
  assert.ok(canSeeMoney({ role: 'foreman', perms: [] }, { foremanSeesCosts: true }));
  for (const role of ['electrician', 'apprentice']) assert.ok(!canSeeMoney({ role, perms: ['drawings'] }, { foremanSeesCosts: true }), role);
});

test('cost delta: +4 receptacles, -1 junction box, priced with markup and labour', () => {
  const current = { receptacle: 16, junction: 1, 'receptacle-gfci': 2 };
  const baseline = { receptacle: 12, junction: 2, 'receptacle-gfci': 2 };
  const r = costDelta({ current, baseline, items: ITEMS, labourRateCents: 9500, markupPct: 10, labourSeparate: false });
  assert.deepEqual(r.lines.map((l) => [l.symbol, l.diff]), [['receptacle', 4], ['junction', -1]]);
  assert.equal(r.lines[0].materialCents, 4800);
  assert.equal(r.lines[0].labourHours, 1.8);
  assert.equal(r.lines[0].labourCents, 17100);
  assert.equal(r.lines[1].materialCents, -900);
  assert.equal(r.totals.materialCents, 3900);
  assert.equal(r.totals.markupCents, 390);
  assert.equal(r.totals.labourHours, 1.5);
  assert.equal(r.totals.totalCents, 4290, 'labour is in the price-book price');
  const sep = costDelta({ current, baseline, items: ITEMS, labourRateCents: 9500, markupPct: 10, labourSeparate: true });
  assert.equal(sep.totals.totalCents, 4290 + 14250, 'labour charged at 1.5 h x $95');
  assert.equal(describeDelta(r.lines), '+4 duplex receptacles (+$48.00 material, +1.8 labour h), −1 junction box (−$9.00 material, −0.3 labour h)');
  assert.equal(describeDelta(r.lines, undefined, { prices: false }), '+4 duplex receptacles, −1 junction box');
  const un = costDelta({ current: { fan: 1 }, baseline: {}, items: ITEMS, labourRateCents: 9500 });
  assert.deepEqual(un.unpriced, ['fan']);
  assert.equal(un.totals.totalCents, 0);
});

test('job cost impact: estimate takeoff + change orders vs the drawings, who added them, change order lines', () => {
  const job = { id: 'job-1', number: 'J-1001', estimateId: 'est-1', changeOrders: [{ id: 'co-old', status: 'rejected', lines: [{ symbol: 'receptacle', qty: 99 }] }] };
  const estimate = { id: 'est-1', number: 'E-2001', jobId: 'job-1', status: 'accepted', labourRateCents: 9500, markupPct: 0,
    lines: [{ itemId: 'i-rec', qty: 2, unitCents: 1200, kind: 'material' }, { itemId: 'i-jb', qty: 1, unitCents: 900, kind: 'material' }, { itemId: null, qty: 1, unitCents: 5000, kind: 'other' }] };
  assert.deepEqual(estimateCounts(estimate, ITEMS), { receptacle: 2, junction: 1 });
  assert.equal(jobEstimate(job, [{ id: 'other', jobId: 'job-1', status: 'accepted' }, estimate]).id, 'est-1');
  assert.equal(jobEstimate({ id: 'job-1' }, [{ id: 'a', jobId: 'job-1', status: 'draft', createdAt: '2026-01-02' }, { id: 'b', jobId: 'job-1', status: 'accepted', createdAt: '2026-01-01' }]).id, 'b');
  const d1 = drawing({
    objects: [
      { ...rec('o1'), by: { id: 'emp-o', name: 'Office' }, at: T(1) }, { ...rec('o2'), by: { id: 'emp-o', name: 'Office' }, at: T(1) },
      ...[1, 2, 3, 4].map((i) => ({ ...rec(`n${i}`, i * 40), by: JACKSON, at: T(10 + i) })),
    ],
    history: [{ id: 'h', by: OFFICE, at: T(30), until: T(30), del: { junction: 1 }, add: {}, move: {}, edit: {} }],
  });
  assert.deepEqual(drawingCounts([d1]), { receptacle: 6 });
  const r = jobCostImpact({ job, drawings: [d1], estimates: [estimate], items: ITEMS, settings: { labourRateCents: 8000 } });
  assert.ok(r.ready);
  assert.deepEqual(r.lines.map((l) => [l.symbol, l.diff]), [['receptacle', 4], ['junction', -1]]);
  assert.equal(r.totals.totalCents, 4800 - 900);
  assert.deepEqual(r.who.receptacle.map((g) => [g.who.name, g.n]), [['Jackson Reid', 4]]);
  assert.deepEqual(r.who.junction.map((g) => [g.who.name, g.n]), [['Office', 1]]);

  const co = changeOrderFrom(r, { id: 'co-1', date: '2026-10-19', createdBy: OFFICE, createdAt: T(40), drawingIds: ['d1'], estimate, who: r.who, when: (iso) => iso.slice(11, 16) });
  assert.equal(co.amountCents, 3900);
  assert.equal(co.status, 'pending');
  assert.equal(co.title, 'Drawing changes: +4 duplex receptacles, −1 junction box');
  assert.deepEqual(co.lines.map((l) => [l.symbol, l.qty, l.unitCents, l.kind]), [['receptacle', 4, 1200, 'material'], ['junction', -1, 900, 'material']]);
  assert.equal(co.lines[0].labourHours, 0.45);
  assert.match(co.note, /4 duplex receptacles added by Jackson Reid 20:14/);
  assert.match(co.note, /1 junction box removed by Office 20:30/);

  // once raised, the same changes count as covered: nothing left to price
  const after = jobCostImpact({ job: { ...job, changeOrders: [...job.changeOrders, co] }, drawings: [d1], estimates: [estimate], items: ITEMS });
  assert.deepEqual(after.lines, []);
  assert.deepEqual(changeOrderCounts({ changeOrders: [co] }), { receptacle: 4, junction: -1 });

  // crew see what changed and who, never a price
  const crew = redactCostImpact(r);
  assert.ok(!/Cents|Hours|markup|labour/i.test(JSON.stringify(crew)), JSON.stringify(crew));
  assert.deepEqual(crew.lines.map((l) => l.diff), [4, -1]);
  assert.equal(whoChanged([d1], [{ symbol: 'switch', diff: -2 }]).switch[0].who, null, 'unknown deletions say so');

  // no estimate: nothing to compare
  assert.equal(jobCostImpact({ job: { id: 'j2' }, drawings: [], estimates: [], items: ITEMS }).reason, 'no-estimate');
});

test('area eraser: cutting a stroke is one edit by the eraser; the pieces keep its author', async () => {
  const { eraseStrokes } = await import('../js/canvas/erase.js');
  const line = { id: 'ln', layer: 'L1', tool: 'pen', color: '#1c1b19', size: 2, points: [] };
  for (let x = 0; x <= 400; x += 10) line.points.push([x, 0, 0.5]);
  const d = drawing();
  const empty = baselineOf(d);
  d.strokes.push(line);
  let r = stampChanges(d, empty, JACKSON, T(1)); // Jackson draws it
  let base = r.baseline;
  let n = 0;
  d.strokes = eraseStrokes(d.strokes, [200, 0], [200, 0], 8, { newId: () => `p${++n}` }).strokes;
  assert.equal(d.strokes.length, 2);
  r = stampChanges(d, base, MANNY, T(2)); // Manny rubs out the middle
  base = r.baseline;
  assert.equal(r.diff.add.length, 0, 'a cut is not a new mark');
  assert.equal(r.diff.del.length, 0);
  assert.equal(r.diff.edit.length, 1, 'one edit of the line');
  assert.equal(r.diff.edit[0].id, 'ln');
  for (const s of d.strokes) {
    assert.deepEqual(s.by, { id: 'emp-j', name: 'Jackson Reid' }, 'still drawn by Jackson');
    assert.equal(s.at, T(1));
    assert.equal(s.editBy.id, 'emp-m', 'erased by Manny');
  }
  assert.equal(d.strokes[1].splitFrom, 'ln');
  // rubbing out the whole second piece: still an edit of the line, since the first piece remains
  d.strokes = eraseStrokes(d.strokes, [215, 0], [420, 0], 8, { newId: () => `p${++n}` }).strokes;
  assert.equal(d.strokes.length, 1);
  r = stampChanges(d, base, MANNY, T(3));
  base = r.baseline;
  assert.deepEqual([r.diff.add.length, r.diff.edit.length, r.diff.del.length], [0, 1, 0]);
  assert.ok(d.tombstones.p1, 'the gone piece leaves a tombstone for the merge');
  // and erasing what is left deletes the line
  d.strokes = eraseStrokes(d.strokes, [-20, 0], [200, 0], 20).strokes;
  r = stampChanges(d, base, MANNY, T(4));
  assert.deepEqual([r.diff.add.length, r.diff.edit.length, r.diff.del.length], [0, 0, 1]);
});

test('a stroke drawn and cut before a save counts as one new mark', async () => {
  const { eraseStrokes } = await import('../js/canvas/erase.js');
  const d = drawing();
  const base = baselineOf(d);
  d.strokes.push({ id: 'ln', layer: 'L1', tool: 'pen', size: 2, points: [[0, 0, 0.5], [400, 0, 0.5]] });
  d.strokes = eraseStrokes(d.strokes, [200, 0], [200, 0], 8, { newId: () => 'p1' }).strokes;
  const r = stampChanges(d, base, JACKSON, T(1));
  assert.deepEqual([r.diff.add.length, r.diff.edit.length], [1, 0]);
  assert.ok(d.strokes.every((s) => s.by?.id === 'emp-j'));
});

test('merge: pieces of a cut stroke go with a whole-stroke delete or redraw made without seeing the cut', async () => {
  const { eraseStrokes } = await import('../js/canvas/erase.js');
  const line = { id: 'S', layer: 'L1', tool: 'pen', color: '#1c1b19', size: 2, points: [] };
  for (let x = 0; x <= 400; x += 10) line.points.push([x, 0, 0.5]);
  const base = drawing();
  const empty = baselineOf(base);
  base.strokes.push(line);
  stampChanges(base, empty, JACKSON, T(1)); // Jackson draws S
  const ids = (d) => d.strokes.map((s) => s.id).sort();

  // device A erases the middle at 10: S (left) and S2 (right, cut from S)
  const A = structuredClone(base);
  const cutA = (() => {
    const b = baselineOf(A);
    A.strokes = eraseStrokes(A.strokes, [200, 0], [200, 0], 8, { newId: () => 'S2' }).strokes;
    return stampChanges(A, b, MANNY, T(10));
  })();
  assert.deepEqual(ids(A), ['S', 'S2']);
  assert.equal(A.strokes[1].cutFrom, 'S', 'the piece remembers the stroke it was cut from');

  // device B, offline with the uncut S, deletes it at 20: nothing of the line survives either way
  const B = structuredClone(base);
  B.strokes = [];
  stampChanges(B, baselineOf(base), OFFICE, T(20));
  assert.deepEqual(ids(mergeDrawing(A, B)), []);
  assert.deepEqual(ids(mergeDrawing(B, A)), []);

  // device C, offline with the uncut S, moves it at 20: C's whole stroke, no leftover piece drawn twice
  const C = structuredClone(base);
  C.strokes[0].points = C.strokes[0].points.map(([x, y, p]) => [x, y + 50, p]);
  stampChanges(C, baselineOf(base), OFFICE, T(20));
  for (const m of [mergeDrawing(A, C), mergeDrawing(C, A)]) {
    assert.deepEqual(ids(m), ['S']);
    assert.equal(m.strokes[0].points.length, line.points.length, 'the full-length moved stroke');
  }

  // a delete made before the cut loses to it: both pieces stay
  const early = structuredClone(base);
  early.strokes = [];
  stampChanges(early, baselineOf(base), OFFICE, T(5));
  assert.deepEqual(ids(mergeDrawing(early, A)), ['S', 'S2']);
  assert.deepEqual(ids(mergeDrawing(A, early)), ['S', 'S2']);

  // device A's own later changes know the cut: deleting or recolouring the left piece keeps the right one
  const del = structuredClone(A);
  del.strokes = del.strokes.filter((s) => s.id !== 'S');
  stampChanges(del, cutA.baseline, MANNY, T(15));
  assert.deepEqual(ids(mergeDrawing(A, del)), ['S2']);
  assert.deepEqual(ids(mergeDrawing(del, A)), ['S2']);
  const recol = structuredClone(A);
  recol.strokes[0].color = '#b42318';
  const recolBase = stampChanges(recol, cutA.baseline, MANNY, T(15)).baseline;
  assert.deepEqual(ids(mergeDrawing(A, recol)), ['S', 'S2']);
  assert.deepEqual(ids(mergeDrawing(C, recol)), ['S'], "C's move at 20 is later than the cut and the recolour");

  // ...and once A changes the left piece again after C's unaware move, A's cut stands
  const again = structuredClone(recol);
  again.strokes[0].color = '#1f5fb8';
  stampChanges(again, recolBase, MANNY, T(30));
  for (const m of [mergeDrawing(C, again), mergeDrawing(again, C)]) {
    assert.deepEqual(ids(m), ['S', 'S2']);
    assert.equal(m.strokes.find((s) => s.id === 'S').color, '#1f5fb8');
  }
  // A deletes the left piece at 30, after C's unaware move at 20: the delete beats the move,
  // so S goes and A's right piece stays (the move it lost to doesn't take S2 with it)
  const late = structuredClone(A);
  late.strokes = late.strokes.filter((s) => s.id !== 'S');
  stampChanges(late, cutA.baseline, MANNY, T(30));
  assert.deepEqual(ids(mergeDrawing(late, C)), ['S2']);
  assert.deepEqual(ids(mergeDrawing(C, late)), ['S2']);

  // a piece of a piece: a second pass cuts S2 at 15 into S2 and S3; B's unaware delete of S at 20
  // takes every piece, and A's own later delete of the left piece S leaves S2 and S3 alone
  const twice = structuredClone(A);
  const twiceBase = baselineOf(twice);
  twice.strokes = eraseStrokes(twice.strokes, [300, 0], [300, 0], 8, { newId: () => 'S3' }).strokes;
  stampChanges(twice, twiceBase, MANNY, T(15));
  assert.deepEqual(ids(twice), ['S', 'S2', 'S3']);
  assert.deepEqual([twice.strokes[2].cutFrom, twice.strokes[2].splitFrom], ['S2', 'S']);
  assert.deepEqual(ids(mergeDrawing(twice, B)), []);
  assert.deepEqual(ids(mergeDrawing(B, twice)), []);
  assert.deepEqual(ids(mergeDrawing(A, twice)), ['S', 'S2', 'S3'], 'A knew S2, so the second cut stands');
  const left = structuredClone(A);
  left.strokes = left.strokes.filter((s) => s.id !== 'S');
  stampChanges(left, cutA.baseline, MANNY, T(30));
  assert.deepEqual(ids(mergeDrawing(left, twice)), ['S2', 'S3']);
  assert.deepEqual(ids(mergeDrawing(twice, left)), ['S2', 'S3']);

  // merging copies that both know the cut changes nothing
  const both = mergeDrawing(A, recol);
  assert.equal(JSON.stringify(mergeDrawing(both, both)), JSON.stringify(both));
});

test('change order from drawings: the markup line keeps its rate out of the description', () => {
  const r = costDelta({ current: { receptacle: 4 }, baseline: {}, items: ITEMS, labourRateCents: 9500, markupPct: 20 });
  const co = changeOrderFrom(r, { id: 'co-m', date: '2026-10-19' });
  const markup = co.lines.find((l) => l.kind === 'other');
  assert.equal(markup.description, 'Markup on material');
  assert.equal(markup.markupPct, 20);
  assert.equal(markup.unitCents, 960);
  assert.ok(!co.lines.some((l) => /\d\s*%/.test(l.description)), 'no percentage in any line text');
});
