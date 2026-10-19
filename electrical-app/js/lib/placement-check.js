// Code check over a drawing's rooms and placed symbols. Pure: give it a
// drawing record, get findings back. Each finding:
//   { id, ruleId, ruleRef ('CEC 26-722 a)'), book ('CEC'|'NBC'|'practice'),
//     severity ('error'|'warning'|'info'), message, at: { x, y } (world px),
//     roomId, verify (true when the rule is not confirmed for 2024), fix? }
// fix: { label, objectIds, symbol? , flags? } — the canvas can apply it in one tap.
import { RULES, ruleLabel } from './placement-rules.js';
import { fmtLength } from './units.js';
import {
  buildModel, usableRuns, runRel, maxDistOnSegment, perimeterPoint, featureSpan, featureDepth, subtractSpans,
  wallLocal, wallPoint, distToFeature, featureCentre, samplePoints, interiorPoint, latchSwitchPoint,
  wallReceptacles, carSpaces, pointInPoly, isRec, isSwitch, isLight, isAlarm,
} from './placement.js';

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };
const SLACK = 0.005; // 5 mm: drawing by hand is not that precise

const isGfci = (o) => o.symbol === 'receptacle-gfci' || !!o.flags?.gfci;

/**
 * Run every rule. opts: { settings (placement), codeOptions: { fuelBurning }, units ('metric'|'imperial') }.
 * Returns findings sorted errors first.
 */
export function checkDrawing(d, { settings, codeOptions = {}, units = 'metric' } = {}) {
  const model = buildModel(d, settings);
  const fmt = (m) => fmtLength(m, { units, denom: 2 });
  // code limits are metric; imperial users see both
  const lim = (m) => { const si = m < 1 ? `${Math.round(m * 1000)} mm` : `${m} m`; return units === 'imperial' ? `${fmt(m)} (${si})` : si; };
  const findings = [];
  const hasBedrooms = model.rooms.some((r) => r.type.sleeping);
  for (const rm of model.rooms) checkRoom(model, rm, findings, { fmt, lim, codeOptions, hasBedrooms });
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return findings;
}

function checkRoom(model, rm, findings, { fmt, lim, codeOptions, hasBedrooms }) {
  const { room, geo, type } = rm;
  const S = model.S;
  const ppm = geo.ppm;
  const objs = model.byRoom.get(room.id) || [];
  const recs = objs.filter(isRec);
  const features = room.features || [];
  const name = room.name || type.label;
  let n = 0;
  const add = (ruleId, severity, message, at, extra = {}) => {
    const r = RULES[ruleId];
    findings.push({
      id: `${ruleId}:${room.id}:${n++}`, ruleId, ruleRef: ruleLabel(ruleId), book: r.book, severity,
      message: `${name}: ${message}`, at: { x: at[0], y: at[1] }, roomId: room.id, verify: !!r.verify, ...extra,
    });
  };
  const centre = () => interiorPoint(geo);
  const recWithin = (f, m) => recs.some((o) => distToFeature(geo, f, o.x, o.y) <= m + SLACK);

  // ----- 26-722 a), c): usable wall in finished rooms (kitchens: d) vi)) -----
  if (type.wallRule) {
    const onWall = wallReceptacles(model, rm, objs);
    for (const run of usableRuns(room, geo, S)) {
      if (run.len < RULES.usableWall.minM - 1e-6) continue;
      const rel = onWall.map((p) => runRel(run, p.s, geo.P)).filter((r) => r >= -0.05 && r <= run.len + 0.05).map((r) => Math.max(0, Math.min(run.len, r)));
      if (!rel.length) {
        const p = perimeterPoint(geo, run.s0 + run.len / 2, model.inset);
        add('usableWall', 'error', `${fmt(run.len)} of usable wall has no receptacle.`, [p.x, p.y]);
        continue;
      }
      // a room with no doors is one loop, so distance wraps round the corner where the loop starts
      const g = maxDistOnSegment(run.len, run.closed ? rel.flatMap((r) => [r - run.len, r, r + run.len]) : rel);
      if (g.max > RULES.wallSpacing.maxM + SLACK) {
        const p = perimeterPoint(geo, run.s0 + g.at, model.inset);
        add(type.kitchen ? 'kitchenWalls' : 'wallSpacing', 'error', `a point on the wall is ${fmt(g.max)} from the nearest receptacle, measured along the floor (limit ${lim(RULES.wallSpacing.maxM)}).`, [p.x, p.y]);
      }
    }
  }

  // ----- kitchens: 26-722 d), e) -----
  if (type.kitchen) {
    for (const c of features.filter((f) => f.kind === 'counter')) {
      const sp = featureSpan(geo, c);
      if (!sp) continue;
      const holeFs = features.filter((f) => f !== c && f.wall === c.wall && ['sink', 'cooktop', 'range'].includes(f.kind));
      const segs = subtractSpans(sp, holeFs.map((f) => featureSpan(geo, f)).filter(Boolean)).filter(([a, b]) => b - a >= RULES.counter.minSegmentM - 1e-6);
      const along = recs.map((o) => ({ o, ...wallLocal(geo, c.wall, o.x, o.y) }))
        .filter((q) => q.v <= featureDepth(c) + 0.05 && q.v >= -model.tolM && q.u >= sp.a - 0.05 && q.u <= sp.b + 0.05);
      for (const [a, b] of segs) {
        const g = maxDistOnSegment(b - a, along.map((q) => q.u - a));
        if (g.max > RULES.counter.maxM + SLACK) {
          const at = wallPoint(geo, c.wall, a + g.at, model.inset / ppm);
          add('counter', 'error', Number.isFinite(g.max) ? `a point on the counter wall is ${fmt(g.max)} from a receptacle (limit ${lim(RULES.counter.maxM)}).` : 'this counter has no receptacle.', at);
        }
      }
      for (const s of holeFs.filter((f) => f.kind === 'sink')) {
        const ss = featureSpan(geo, s);
        for (const q of along) if (q.u > ss.a + 0.02 && q.u < ss.b - 0.02 && q.u >= sp.a && q.u <= sp.b) {
          add('sinkFront', 'warning', 'receptacle directly behind the sink.', [q.o.x, q.o.y]);
        }
      }
    }
    for (const f of features.filter((q) => q.kind === 'island')) {
      const rule = f.peninsula ? 'peninsula' : 'island';
      const L = Math.max(Number(f.lengthM) || 0, Number(f.depthM) || 0), D = Math.min(Number(f.lengthM) || 0, Number(f.depthM) || 0);
      if (f.fixed === false || L < RULES[rule].minLongM - 1e-6 || D < RULES[rule].minShortM - 1e-6) continue;
      if (!recWithin(f, 0.3)) add(rule, 'error', `${f.peninsula ? 'peninsula' : 'island'} counter (${fmt(L)} × ${fmt(D)}) needs at least one receptacle.`, [f.x, f.y]);
    }
    for (const f of features.filter((q) => q.kind === 'fridge')) {
      if (!recWithin(f, RULES.fridge.withinM)) add('fridge', 'error', 'no receptacle for the refrigerator.', featureCentre(geo, f));
    }
    for (const f of features.filter((q) => q.kind === 'range' && q.gas)) {
      if (!recWithin(f, RULES.gasRange.withinM)) add('gasRange', 'error', 'no receptacle behind the gas range (centre not over 130 mm above the floor).', featureCentre(geo, f));
    }
  }

  // ----- GFCI: 26-704 -----
  const wet = features.filter((f) => ['sink', 'tub', 'shower'].includes(f.kind) || (f.kind === 'island' && f.sink));
  const outdoorGfci = type.outdoor && !((Number(room.aboveGradeM) || 0) > RULES.gfciOutdoor.gradeM);
  for (const o of recs) {
    if (isGfci(o)) continue;
    let near = null;
    for (const f of wet) { const dd = distToFeature(geo, f, o.x, o.y); if (dd <= RULES.gfciWet.withinM + SLACK && (!near || dd < near.dd)) near = { f, dd }; }
    const fix = { label: 'Make GFCI', objectIds: [o.id], symbol: 'receptacle-gfci' };
    if (near) {
      const what = near.f.kind === 'island' ? 'island sink' : near.f.kind === 'sink' ? (type.bathroom ? 'basin' : 'sink') : near.f.kind === 'tub' ? 'bathtub' : 'shower';
      add('gfciWet', 'error', `receptacle ${fmt(near.dd)} from the ${what} needs Class A GFCI protection.`, [o.x, o.y], { fix });
    } else if (outdoorGfci) {
      add('gfciOutdoor', 'error', 'outdoor receptacle within 2.5 m of grade needs Class A GFCI protection.', [o.x, o.y], { fix });
    }
  }
  if (type.outdoor) {
    const open = recs.filter((o) => !o.flags?.wp);
    if (open.length) add('weather', 'warning', `${open.length === 1 ? 'receptacle needs' : `${open.length} receptacles need`} a weatherproof (in-use) cover.`, [open[0].x, open[0].y],
      { fix: { label: 'Mark WP cover', objectIds: open.map((o) => o.id), flags: { wp: true } } });
    if (!recs.length) add('balcony', 'error', 'needs at least one receptacle.', centre());
  }

  // ----- bathrooms: 26-720 f), g) -----
  if (type.bathroom) {
    for (const b of features.filter((f) => f.kind === 'sink')) {
      if (!recWithin(b, RULES.basin.withinM)) add('basin', 'error', 'no receptacle within 1 m of the basin.', featureCentre(geo, b));
    }
    const tubs = features.filter((f) => f.kind === 'tub' || f.kind === 'shower');
    for (const o of recs) {
      const dd = tubs.reduce((m, f) => Math.min(m, distToFeature(geo, f, o.x, o.y)), Infinity);
      if (dd < RULES.tub.minM - SLACK) add('tub', 'error', `receptacle is ${fmt(dd)} from the tub or shower (never under ${lim(RULES.tub.minM)}).`, [o.x, o.y]);
      else if (dd < RULES.tub.preferM - SLACK) add('tub', 'warning', `receptacle is ${fmt(dd)} from the tub or shower; keep ${lim(RULES.tub.preferM)} where practicable.`, [o.x, o.y]);
    }
  }

  // ----- hallways: 26-722 g) -----
  if (type.hallway) {
    if (!recs.length) add('hallway', 'error', 'needs a receptacle (no point more than 4.5 m from one).', centre());
    else {
      let worst = null;
      for (const [x, y] of samplePoints(geo, 0.3)) {
        const dd = recs.reduce((m, o) => Math.min(m, Math.hypot(o.x - x, o.y - y)), Infinity) / ppm;
        if (!worst || dd > worst.dd) worst = { x, y, dd };
      }
      if (worst && worst.dd > RULES.hallway.maxM + SLACK) add('hallway', 'error', `a point in the hallway is ${fmt(worst.dd)} from a receptacle (limit ${lim(RULES.hallway.maxM)}).`, [worst.x, worst.y]);
    }
  }

  // ----- laundry 26-720 e) i), ii); basement e) iv); garage 26-724 b) -----
  if (type.laundry) {
    const washers = features.filter((f) => f.kind === 'washer');
    for (const w of washers) if (!recWithin(w, RULES.laundry.withinM)) add('laundry', 'error', 'no receptacle for the washing machine.', featureCentre(geo, w));
    if (recs.length < washers.length + 1) add('laundry', 'error', 'needs at least one receptacle besides the washer\'s.', centre());
    if (!washers.length) add('laundry', 'info', 'mark the washer so its receptacle can be checked.', centre());
  }
  if (type.basement && !recs.length) add('basement', 'error', 'unfinished basement area needs at least one receptacle.', centre());
  if (type.garage) {
    const need = carSpaces(room, geo);
    if (recs.length < need) add('garage', 'error', `${need} car space${need === 1 ? '' : 's'} need${need === 1 ? 's' : ''} ${need} receptacle${need === 1 ? '' : 's'}; ${recs.length} placed.`, centre());
  }

  // ----- 26-720 j): receptacles required by 26-720 not over 1.7 m -----
  if (type.bathroom || type.laundry || type.basement) {
    for (const o of recs) if (Number(o.mountM) > RULES.maxHeight.maxM + SLACK) add('maxHeight', 'warning', `receptacle mounted at ${fmt(Number(o.mountM))}; required receptacles go no higher than ${lim(RULES.maxHeight.maxM)}.`, [o.x, o.y]);
  }

  // ----- building code: smoke and CO alarms, lighting outlets -----
  const alarms = objs.filter((o) => isAlarm(o) && o.flags?.smoke !== false);
  if (type.sleeping && S.alarms.bedrooms && !alarms.length) add('smoke', 'error', 'bedroom has no smoke alarm.', centre());
  if (type.hallway && S.alarms.hallways && hasBedrooms && !alarms.length) add('smoke', 'warning', 'no smoke alarm in the hallway (between the bedrooms and the rest of the storey).', centre());
  if (type.basement && S.alarms.basement && !alarms.length) add('smoke', 'warning', 'no smoke alarm on this storey.', centre());
  if (type.sleeping && codeOptions.fuelBurning) {
    const coAlarms = model.objects.filter((o) => isAlarm(o) && o.flags?.co !== false);
    const doors = features.filter((f) => f.kind === 'door');
    const inside = coAlarms.some((o) => pointInPoly(o.x, o.y, room.points));
    const nearDoor = doors.some((f) => { const [x, y] = featureCentre(geo, f); return coAlarms.some((o) => Math.hypot(o.x - x, o.y - y) / ppm <= RULES.co.withinM); });
    if (!inside && !nearDoor) add('co', 'warning', 'no CO alarm in the bedroom or within 5 m of its door.', centre());
  }
  if (type.needsLight && room.lighting !== 'none') {
    const lit = objs.some(isLight) || (type.switchedReceptacleOk && recs.some((o) => o.flags?.switched));
    if (!lit) add('lighting', 'warning', 'no lighting outlet (a switched receptacle is allowed in bedrooms and living rooms).', centre());
  }

  // ----- practice: a switch on the latch side of each entry -----
  if (!type.outdoor && (objs.some(isLight) || type.needsLight)) {
    const switches = objs.filter(isSwitch);
    for (const f of features.filter((q) => (q.kind === 'door' && q.entry !== false))) {
      const pt = latchSwitchPoint(geo, f, S.switchFromJambM, model.inset);
      if (!pt) continue;
      if (!switches.some((o) => Math.hypot(o.x - pt.x, o.y - pt.y) / ppm <= 0.75)) add('latchSwitch', 'info', 'no switch on the latch side of this door.', [pt.x, pt.y]);
    }
  }

  // ----- protection marks: 26-658 AFCI, 26-706 TR -----
  const exempt = (o) => {
    if (o.flags?.counter || o.flags?.dedicated) return true;
    for (const f of features) {
      if (f.kind === 'counter') {
        const q = wallLocal(geo, f.wall, o.x, o.y), sp = featureSpan(geo, f);
        if (sp && q.u >= sp.a - 0.05 && q.u <= sp.b + 0.05 && q.v <= featureDepth(f) + 0.05 && q.v >= -model.tolM && type.kitchen) return true;
      }
      if (f.kind === 'island' && type.kitchen && distToFeature(geo, f, o.x, o.y) <= 0.3) return true;
      if (f.kind === 'fridge' && type.kitchen && distToFeature(geo, f, o.x, o.y) <= 0.6) return true;
    }
    return false;
  };
  const noAfci = recs.filter((o) => !o.flags?.afci && !exempt(o));
  if (noAfci.length) add('afci', 'info', `${noAfci.length} receptacle${noAfci.length === 1 ? '' : 's'} not marked AFCI (combination type on the circuit).`, [noAfci[0].x, noAfci[0].y],
    { fix: { label: 'Mark AFCI', objectIds: noAfci.map((o) => o.id), flags: { afci: true } } });
  const noTr = recs.filter((o) => !o.flags?.tr);
  if (noTr.length) add('tamper', 'info', `${noTr.length} receptacle${noTr.length === 1 ? '' : 's'} not marked tamper-resistant.`, [noTr[0].x, noTr[0].y],
    { fix: { label: 'Mark TR', objectIds: noTr.map((o) => o.id), flags: { tr: true } } });
}

/** Counts by severity: { error, warning, info }. */
export function summarize(findings) {
  const out = { error: 0, warning: 0, info: 0 };
  for (const f of findings) out[f.severity]++;
  return out;
}

