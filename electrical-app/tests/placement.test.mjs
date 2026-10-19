// Run: node --test electrical-app/tests/
// Box placement geometry, auto-place and the drawing code check (CEC 2024 rule numbers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pxPerM, rectPoints, roomGeometry, usableRuns, runRel, fillCoverage, maxDistOnSegment, normalizeIntervals,
  proposeRoom, proposeAll, projectToWalls, perimeterPoint, distToFeature, featureSpan, wallLocal, buildModel, polyArea,
} from '../js/lib/placement.js';
import { checkDrawing, summarize } from '../js/lib/placement-check.js';
import { RULES, placementSettings, ruleLabel } from '../js/lib/placement-rules.js';

const SCALE = 24; // px per foot, the editor's default
const M = pxPerM(SCALE);

function room(id, type, wM, hM, features = [], extra = {}) {
  const [ox, oy] = extra.origin || [0, 0];
  return { id, layer: 'R', name: extra.name || id, type, points: rectPoints([ox, oy], [ox + wM * M, oy + hM * M]), features, ...extra };
}
function drawing(rooms, objects = []) {
  return { scale: SCALE, layers: [{ id: 'R', name: 'Rooms', kind: 'rooms' }, { id: 'L1', name: 'Power' }], rooms, objects };
}
/** Accept proposals the way the canvas does: they become plain symbol objects. */
const accept = (props) => props.map((p) => ({ id: 'o-' + p.id, layer: 'L1', symbol: p.symbol, x: p.x, y: p.y, rotation: p.rotation, scale: 1, flags: { ...p.flags }, mountM: p.mountM }));
const rules = (findings) => findings.map((f) => f.ruleId);

/**
 * Independent check of 26-722 a): walk every usable run in 1 cm steps and
 * measure along the floor line to the nearest receptacle on that run.
 */
function worstWallDistance(d, r) {
  const geo = roomGeometry(r, M);
  const S = placementSettings();
  let worst = 0;
  for (const run of usableRuns(r, geo, S)) {
    if (run.len < 0.9) continue;
    const pos = d.objects.filter((o) => o.symbol.startsWith('receptacle')).map((o) => projectToWalls(geo, o.x, o.y))
      .filter((p) => p.dist < 0.5).map((p) => runRel(run, p.s, geo.P)).filter((x) => x >= -0.05 && x <= run.len + 0.05);
    for (let x = 0; x <= run.len + 1e-9; x += 0.01) {
      const dd = pos.length ? Math.min(...pos.map((p) => Math.abs(p - x))) : Infinity;
      worst = Math.max(worst, dd);
    }
  }
  return worst;
}

test('rule data cites CEC 2024 numbers', () => {
  assert.equal(RULES.wallSpacing.maxM, 1.8);
  assert.equal(RULES.usableWall.minM, 0.9);
  assert.equal(RULES.counter.maxM, 0.9);
  assert.equal(RULES.gfciWet.withinM, 1.5);
  assert.equal(RULES.hallway.maxM, 4.5);
  assert.equal(ruleLabel('wallSpacing'), 'CEC 26-722 a)');
  assert.equal(ruleLabel('smoke'), 'NBC 9.10.19.3');
  assert.equal(ruleLabel('latchSwitch'), 'Practice');
});

test('room geometry: lengths, perimeter and inward normals', () => {
  const r = room('a', 'bedroom', 4, 3.5);
  const g = roomGeometry(r, M);
  assert.deepEqual(g.walls.map((w) => +w.lenM.toFixed(6)), [4, 3.5, 4, 3.5]);
  assert.ok(Math.abs(g.P - 15) < 1e-9);
  assert.ok(Math.abs(g.areaM2 - 14) < 1e-9);
  // every inward normal points at the centre
  for (const w of g.walls) {
    const mx = (w.a[0] + w.b[0]) / 2 + w.n[0] * 10, my = (w.a[1] + w.b[1]) / 2 + w.n[1] * 10;
    assert.ok(Math.hypot(mx - g.centroid[0], my - g.centroid[1]) < Math.hypot((w.a[0] + w.b[0]) / 2 - g.centroid[0], (w.a[1] + w.b[1]) / 2 - g.centroid[1]));
  }
  // counter-clockwise points give the same answer
  const rev = { ...r, points: [...r.points].reverse() };
  assert.ok(polyArea(rev.points) < 0);
  const g2 = roomGeometry(rev, M);
  const w = g2.walls[0];
  const mx = (w.a[0] + w.b[0]) / 2 + w.n[0] * 10, my = (w.a[1] + w.b[1]) / 2 + w.n[1] * 10;
  assert.ok(mx > 0 && my > 0 && mx < 4 * M && my < 3.5 * M);
});

test('perimeter intervals wrap and merge', () => {
  assert.deepEqual(normalizeIntervals([[14, 16]], 15), [[0, 1], [14, 15]]);
  assert.deepEqual(normalizeIntervals([[1, 2], [1.5, 3], [-1, 0.5]], 15), [[0, 0.5], [1, 3], [14, 15]]);
  assert.deepEqual(normalizeIntervals([[0, 20]], 15), [[0, 15]]);
});

test('coverage: fewest boxes, evenly spaced, none over the limit', () => {
  assert.deepEqual(fillCoverage(3.6, [], 1.8), [1.8]);
  assert.equal(fillCoverage(3.61, [], 1.8).length, 2);
  const p = fillCoverage(13.38, [], 1.8);
  assert.equal(p.length, 4);
  assert.ok(maxDistOnSegment(13.38, p).max <= 1.8);
  // an existing box at the start is kept and only the rest is filled
  // covered to 2.0 m by the existing box; 3 m left needs one more, 4 m needs two
  const q = fillCoverage(5, [0.2], 1.8);
  assert.ok(maxDistOnSegment(5, [0.2, ...q]).max <= 1.8 + 1e-9);
  assert.equal(q.length, 1);
  assert.equal(fillCoverage(6, [0.2], 1.8).length, 2);
  assert.equal(maxDistOnSegment(5, []).max, Infinity);
});

test('4 m × 3.5 m bedroom with one door: no point on usable wall more than 1.8 m from a receptacle', () => {
  const door = { id: 'd1', kind: 'door', wall: 2, atM: 0.3, widthM: 0.81, hinge: 'start', swing: 'in' };
  const r = room('bed', 'bedroom', 4, 3.5, [door]);
  const d = drawing([r]);
  const props = proposeRoom(d, 'bed');
  const recs = props.filter((p) => p.group === 'receptacle');
  // 15 m perimeter - 0.81 m door - 0.81 m swing = 13.38 m of usable wall -> 4 boxes
  assert.equal(recs.length, 4);
  for (const p of recs) {
    assert.equal(p.symbol, 'receptacle');
    assert.deepEqual({ tr: p.flags.tr, afci: p.flags.afci, gfci: p.flags.gfci }, { tr: true, afci: true, gfci: false });
    assert.ok(p.ruleRefs.includes('wallSpacing'));
  }
  d.objects = accept(props);
  assert.ok(worstWallDistance(d, r) <= 1.8 + 1e-6, `worst ${worstWallDistance(d, r)}`);
  // and nothing sits in the door opening or behind the open door
  const geo = roomGeometry(r, M);
  for (const p of recs) {
    const pr = projectToWalls(geo, p.x, p.y);
    assert.ok(!(pr.wall === 2 && pr.t > -0.51 && pr.t < 1.11), `receptacle at wall ${pr.wall} t=${pr.t}`);
  }
  // the rest of the room: latch-side switch, light, smoke alarm
  assert.equal(props.filter((p) => p.group === 'switch').length, 1);
  assert.equal(props.filter((p) => p.symbol === 'light-ceiling').length, 1);
  assert.equal(props.filter((p) => p.symbol === 'smoke').length, 1);
  const sw = props.find((p) => p.group === 'switch');
  const swAt = projectToWalls(geo, sw.x, sw.y);
  assert.equal(swAt.wall, 2);
  assert.ok(Math.abs(swAt.t - (0.3 + 0.81 + 0.15)) < 1e-6, 'switch 150 mm past the latch jamb');
  // the accepted layout passes the check
  const f = checkDrawing(d);
  assert.deepEqual(f.filter((x) => x.severity === 'error'), []);
});

test('a 600 mm wall stub between two doors gets no receptacle', () => {
  const doors = [
    { id: 'a', kind: 'door', wall: 0, atM: 0.5, widthM: 0.81, hinge: 'start', swing: 'out' },
    { id: 'b', kind: 'door', wall: 0, atM: 1.91, widthM: 0.81, hinge: 'end', swing: 'out' },
  ];
  const r = room('liv', 'living', 3, 3, doors);
  const geo = roomGeometry(r, M);
  const runs = usableRuns(r, geo, placementSettings());
  const stub = runs.find((x) => Math.abs(x.len - 0.6) < 1e-6);
  assert.ok(stub, 'the 600 mm stub is a run of its own');
  const d = drawing([r]);
  const props = proposeRoom(d, 'liv').filter((p) => p.group === 'receptacle');
  for (const p of props) {
    const pr = projectToWalls(geo, p.x, p.y);
    assert.ok(!(pr.wall === 0 && pr.t > 1.31 - 1e-6 && pr.t < 1.91 + 1e-6), 'no box on the stub');
  }
  d.objects = accept(proposeRoom(d, 'liv'));
  assert.ok(!rules(checkDrawing(d)).includes('usableWall'), 'the stub is not flagged either');
  // two entries: 3-way switches
  assert.deepEqual(proposeRoom(d, 'liv').filter((p) => p.group === 'switch').map((p) => p.symbol), []); // already placed
  assert.deepEqual(accept(proposeRoom(drawing([r]), 'liv')).filter((o) => o.symbol.startsWith('switch')).map((o) => o.symbol), ['switch-3way', 'switch-3way']);
});

test('a room with no doors is one loop: distance wraps round', () => {
  const r = room('loop', 'living', 4, 3.5);
  const geo = roomGeometry(r, M);
  const one = perimeterPoint(geo, 1, 10);
  const d = drawing([r], [{ id: 'x', layer: 'L1', symbol: 'receptacle', x: one.x, y: one.y, flags: { tr: true, afci: true } }]);
  const f = checkDrawing(d, { units: 'metric' }).find((x) => x.ruleId === 'wallSpacing');
  assert.match(f.message, /7\.50 m/, 'half the 15 m loop, not 14 m');
  // filling it keeps the existing box and wraps: a 15 m loop needs ceil(15 / 3.6) = 5, so four more
  const props = proposeRoom(d, 'loop').filter((p) => p.group === 'receptacle');
  assert.equal(props.length, 4);
  d.objects.push(...accept(props));
  assert.ok(!rules(checkDrawing(d)).includes('wallSpacing'));
});

test('existing receptacles are respected: a compliant room gets no new ones', () => {
  const r = room('bed', 'bedroom', 4, 3.5, [{ id: 'd1', kind: 'door', wall: 2, atM: 0.3, widthM: 0.81, hinge: 'start', swing: 'in' }]);
  const d = drawing([r]);
  d.objects = accept(proposeRoom(d, 'bed'));
  const again = proposeRoom(d, 'bed');
  assert.deepEqual(again, []);
});

test('kitchen counter: 900 mm rule, nothing behind the sink, GFCI within 1.5 m of it, no AFCI on counter circuits', () => {
  const feats = [
    { id: 'c1', kind: 'counter', wall: 0, atM: 0.5, widthM: 4.5, depthM: 0.635 },
    { id: 's1', kind: 'sink', wall: 0, atM: 1.9, widthM: 0.8, depthM: 0.5 },
    { id: 'f1', kind: 'fridge', wall: 1, atM: 0.2, widthM: 0.91 },
    { id: 'r1', kind: 'range', wall: 2, atM: 1.5, widthM: 0.76, gas: true },
    { id: 'i1', kind: 'island', x: 2.5 * M, y: 2 * M, lengthM: 1.8, depthM: 0.9, rotation: 0 },
    { id: 'd1', kind: 'door', wall: 3, atM: 1, widthM: 0.91, hinge: 'start', swing: 'in' },
  ];
  const r = room('k', 'kitchen', 6, 4, feats); // counter ends 1 m short of the fridge wall
  const d = drawing([r]);
  const props = proposeRoom(d, 'k');
  const counter = props.filter((p) => p.ruleRefs.includes('counter'));
  const geo = roomGeometry(r, M);
  const sink = featureSpan(geo, feats[1]);
  const along = counter.map((p) => wallLocal(geo, 0, p.x, p.y).u);
  for (const u of along) assert.ok(!(u > sink.a && u < sink.b), 'not behind the sink');
  // every point of the counter (minus the sink) within 900 mm of a box, along the wall line
  for (let u = 0.5; u <= 5.0; u += 0.01) {
    if (u > sink.a && u < sink.b) continue;
    assert.ok(Math.min(...along.map((a) => Math.abs(a - u))) <= 0.9 + 1e-6, `counter point ${u.toFixed(2)}`);
  }
  for (const p of counter) {
    assert.equal(p.flags.afci, false, 'kitchen counter circuits are exempt from 26-658');
    assert.equal(p.flags.gfci, distToFeature(geo, feats[1], p.x, p.y) <= 1.5);
    assert.equal(p.symbol, p.flags.gfci ? 'receptacle-gfci' : 'receptacle');
  }
  assert.ok(counter.some((p) => p.flags.gfci) && counter.some((p) => !p.flags.gfci));
  assert.equal(props.filter((p) => p.ruleRefs.includes('fridge')).length, 1);
  const gas = props.find((p) => p.ruleRefs.includes('gasRange'));
  assert.ok(gas && gas.mountM <= 0.13);
  assert.equal(props.filter((p) => p.ruleRefs.includes('island')).length, 1);
  assert.ok(props.filter((p) => p.symbol === 'light-recessed').length >= 4);
  d.objects = accept(props);
  const errs = checkDrawing(d).filter((f) => f.severity === 'error');
  assert.deepEqual(errs, []);
});

test('hallway: no point more than 4.5 m from a receptacle', () => {
  const r = room('h', 'hallway', 10, 1.1, [{ id: 'd', kind: 'door', wall: 3, atM: 0.1, widthM: 0.81, swing: 'in' }]);
  const d = drawing([r, room('b', 'bedroom', 3, 3, [], { origin: [0, 3 * M] })]);
  const props = proposeRoom(d, 'h');
  const recs = props.filter((p) => p.group === 'receptacle');
  assert.ok(recs.length >= 2 && recs.length <= 3, `${recs.length} hallway receptacles`);
  d.objects = accept(props);
  const f = checkDrawing(d).filter((x) => x.roomId === 'h');
  assert.ok(!rules(f).includes('hallway'));
  assert.ok(props.some((p) => p.symbol === 'smoke'), 'hallway alarm by default');
});

test('outdoor balcony: GFCI within 2.5 m of grade, weatherproof cover', () => {
  const r = room('o', 'outdoor', 3, 2, [{ id: 'd', kind: 'door', wall: 0, atM: 1, widthM: 0.91, swing: 'out' }]);
  const d = drawing([r]);
  const rec = proposeRoom(d, 'o').find((p) => p.group === 'receptacle');
  assert.equal(rec.symbol, 'receptacle-gfci');
  assert.equal(rec.flags.wp, true);
  assert.equal(projectToWalls(roomGeometry(r, M), rec.x, rec.y).wall, 0, 'on the house wall with the door');
  const high = room('o2', 'outdoor', 3, 2, [], { aboveGradeM: 6 });
  const rec2 = proposeRoom(drawing([high]), 'o2').find((p) => p.group === 'receptacle');
  assert.equal(rec2.flags.gfci, false);
});

test('bathroom: basin receptacle is GFCI, within 1 m of the basin and 1 m from the tub', () => {
  const feats = [
    { id: 't', kind: 'tub', wall: 0, atM: 0, widthM: 1.52, depthM: 0.76 },
    { id: 's', kind: 'sink', wall: 2, atM: 0.4, widthM: 0.5, depthM: 0.5 },
    { id: 'v', kind: 'counter', wall: 2, atM: 0.2, widthM: 0.9, depthM: 0.55 },
    { id: 'd', kind: 'door', wall: 1, atM: 0.4, widthM: 0.76, hinge: 'end', swing: 'in' },
  ];
  const r = room('ba', 'bathroom', 2.4, 2.2, feats);
  const geo = roomGeometry(r, M);
  const props = proposeRoom(drawing([r]), 'ba');
  const rec = props.find((p) => p.ruleRefs.includes('basin'));
  assert.ok(rec);
  assert.equal(rec.symbol, 'receptacle-gfci');
  assert.ok(distToFeature(geo, feats[1], rec.x, rec.y) <= 1);
  assert.ok(distToFeature(geo, feats[0], rec.x, rec.y) >= 1);
});

test('findings on a hand-placed bad layout', () => {
  const bath = room('ba', 'bathroom', 2.4, 2.2, [
    { id: 't', kind: 'tub', wall: 0, atM: 0, widthM: 1.52, depthM: 0.76 },
    { id: 's', kind: 'sink', wall: 2, atM: 0.4, widthM: 0.5, depthM: 0.5 },
  ], { name: 'Main bath' });
  const bed = room('bed', 'bedroom', 4, 3.5, [{ id: 'd', kind: 'door', wall: 2, atM: 0.3, widthM: 0.81, hinge: 'start', swing: 'in' }], { origin: [5 * M, 0] });
  const geo = roomGeometry(bath, M);
  const nearTub = perimeterPoint(geo, 1.52 + 0.4, 10); // on wall 0, 0.4 m past the tub
  const d = drawing([bath, bed], [
    { id: 'r1', layer: 'L1', symbol: 'receptacle', x: nearTub.x, y: nearTub.y, rotation: 0, scale: 1 },
    { id: 'r2', layer: 'L1', symbol: 'receptacle', x: 5 * M + 2 * M, y: 10, rotation: 0, scale: 1 },
  ]);
  const f = checkDrawing(d);
  const ids = rules(f);
  assert.ok(ids.includes('gfciWet'), 'receptacle near the tub without GFCI');
  const tub = f.find((x) => x.ruleId === 'tub');
  assert.equal(tub.severity, 'error', 'closer than 500 mm to the tub');
  assert.ok(ids.includes('basin'), 'no receptacle within 1 m of the basin');
  assert.ok(ids.includes('wallSpacing'), 'one receptacle cannot cover a 4 m × 3.5 m bedroom');
  assert.ok(ids.includes('smoke'), 'bedroom without a smoke alarm');
  assert.ok(ids.includes('afci') && ids.includes('tamper'));
  for (const x of f) {
    assert.ok(Number.isFinite(x.at.x) && Number.isFinite(x.at.y));
    assert.match(x.ruleRef, /^(CEC|NBC|Practice)/);
    assert.ok(['error', 'warning', 'info'].includes(x.severity));
  }
  assert.equal(new Set(f.map((x) => x.id)).size, f.length, 'finding ids are unique');
  // the GFCI finding carries a one-tap fix
  const g = f.find((x) => x.ruleId === 'gfciWet');
  assert.deepEqual(g.fix.objectIds, ['r1']);
  assert.equal(g.fix.symbol, 'receptacle-gfci');
  const s = summarize(f);
  assert.ok(s.error >= 4);
  // fixing it removes that finding
  d.objects[0].symbol = 'receptacle-gfci';
  assert.ok(!rules(checkDrawing(d)).includes('gfciWet'));
});

test('imperial users get feet and inches in messages', () => {
  const r = room('bed', 'bedroom', 4, 3.5, []);
  const f = checkDrawing(drawing([r]), { units: 'imperial' });
  const wall = f.find((x) => x.ruleId === 'usableWall');
  assert.match(wall.message, /49' 2 1\/2"|49' 2"|49' 3"/);
});

test('old drawings without rooms still work', () => {
  const d = { scale: 24, layers: [{ id: 'L1' }], objects: [{ id: 'x', layer: 'L1', symbol: 'receptacle', x: 1, y: 1 }] };
  assert.deepEqual(checkDrawing(d), []);
  assert.deepEqual(proposeAll(d), []);
  assert.equal(buildModel(d).rooms.length, 0);
});

test('smoke and CO rules follow the settings', () => {
  const r = room('bed', 'bedroom', 3, 3, [{ id: 'd', kind: 'door', wall: 2, atM: 0.3, widthM: 0.81, hinge: 'start' }]);
  const off = proposeRoom(drawing([r]), 'bed', { settings: { alarms: { bedrooms: false } } });
  assert.ok(!off.some((p) => p.symbol === 'smoke'));
  assert.ok(!rules(checkDrawing(drawing([r]), { settings: { alarms: { bedrooms: false } } })).includes('smoke'));
  const co = proposeRoom(drawing([r]), 'bed', { codeOptions: { fuelBurning: true } }).find((p) => p.symbol === 'smoke');
  assert.equal(co.flags.co, true);
  assert.ok(rules(checkDrawing(drawing([r]), { codeOptions: { fuelBurning: true } })).includes('co'));
});

test('garage gets a receptacle per car space; unfinished basement at least one', () => {
  const g = room('g', 'garage', 6.5, 6.5, [], { carSpaces: 2 });
  const props = proposeRoom(drawing([g]), 'g').filter((p) => p.group === 'receptacle');
  assert.equal(props.length, 2);
  const b = room('b', 'basement', 8, 6);
  assert.equal(proposeRoom(drawing([b]), 'b').filter((p) => p.group === 'receptacle').length, 1);
  assert.ok(rules(checkDrawing(drawing([b]))).includes('basement'));
});
