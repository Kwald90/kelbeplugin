// Run: node --test electrical-app/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LEVELS, newLevel, normalizeLevels, levelsOf, activeLevels, baselineLevel, levelById,
  effectiveHours, levelCostCents, levelChargeCents, labourByLevel, crewMix, apprenticeHours,
} from '../js/lib/labour-levels.js';
import { peopleFromEmployees } from '../js/modules/labour.js';

// A small settings object with three levels: apprentice 50%, journeyman 100%, foreman 125%.
const settings = {
  labourLevels: [
    { id: 'app1', name: '1st year', kind: 'apprentice', year: 1, productivityPct: 50, costCents: 2000, chargeCents: 6000 },
    { id: 'jw', name: 'Journeyman', kind: 'journeyman', productivityPct: 100, costCents: 4000, chargeCents: 9000 },
    { id: 'fm', name: 'Foreman', kind: 'foreman', productivityPct: 125, costCents: 5000, chargeCents: 11000 },
  ],
};
const jw = () => settings.labourLevels[1];
const app1 = () => settings.labourLevels[0];

test('defaults seed when settings have no levels, and the journeyman is the baseline', () => {
  assert.ok(levelsOf({}).length >= 5, 'the default roster seeds');
  assert.equal(normalizeLevels(DEFAULT_LEVELS).find((l) => l.kind === 'journeyman').productivityPct, 100);
  assert.equal(baselineLevel(settings).id, 'jw');
  // an explicit baseline wins
  assert.equal(baselineLevel({ ...settings, baselineLevelId: 'fm' }).id, 'fm');
});

test('default level ids are stable across reads, so an assignment keeps matching', () => {
  // The bug: defaults with no id got a fresh random id every read, so a level you assigned to a
  // person was orphaned the instant anything re-read the list (and on reload). Ids must be stable.
  const a = levelsOf({}), b = levelsOf({});
  assert.deepEqual(a.map((l) => l.id), b.map((l) => l.id), 'same ids every call');
  assert.ok(a.every((l) => l.id), 'every default level has an id');
  // every seeded default id resolves back to its level (what the apprentice-hours roll-up relies on)
  for (const l of activeLevels({})) assert.equal(levelById({}, l.id)?.id, l.id);
  // a person assigned the journeyman still resolves after a re-read
  const jw = activeLevels({}).find((l) => l.kind === 'journeyman');
  assert.equal(levelById({}, jw.id)?.kind, 'journeyman');
});

test('a slower level takes proportionally more hours than the journeyman baseline', () => {
  // 1.0 journeyman hour at 50% productivity = 2.0 hours.
  assert.equal(effectiveHours(1, app1(), settings), 2);
  // the journeyman takes exactly the baseline.
  assert.equal(effectiveHours(1, jw(), settings), 1);
  // a faster foreman (125%) takes less: 1 / 1.25 = 0.8.
  assert.equal(effectiveHours(1, settings.labourLevels[2], settings), 0.8);
});

test('cost and charge use the level rate on the effective hours', () => {
  // apprentice: 2 h * $20 cost = $40 ; 2 h * $60 charge = $120.
  assert.equal(levelCostCents(1, app1(), settings), 4000);
  assert.equal(levelChargeCents(1, app1(), settings), 12000);
  // journeyman: 1 h * $40 = $40 cost ; $90 charge.
  assert.equal(levelCostCents(1, jw(), settings), 4000);
  assert.equal(levelChargeCents(1, jw(), settings), 9000);
});

test('labourByLevel gives the per-level time + money table with margin', () => {
  const rows = labourByLevel(1, settings);
  assert.equal(rows.length, 3);
  const a = rows.find((r) => r.level.id === 'app1');
  assert.equal(a.hours, 2);
  assert.equal(a.costCents, 4000);
  assert.equal(a.chargeCents, 12000);
  assert.equal(a.marginCents, 8000);
  // the cheap-labour illusion: the apprentice bills more hours, so margin per unit can differ.
  const j = rows.find((r) => r.level.id === 'jw');
  assert.equal(j.marginCents, 5000);
});

test('crewMix blends shares and normalises when they do not sum to 1', () => {
  // half apprentice (2h on 0.5 base) + half journeyman (0.5h) for 1 base hour.
  const m = crewMix(1, [{ levelId: 'app1', share: 1 }, { levelId: 'jw', share: 1 }], settings);
  // apprentice half: effectiveHours(0.5,50%) = 1.0 ; journeyman half: 0.5 -> total 1.5 h
  assert.equal(m.hours, 1.5);
  assert.equal(m.costCents, Math.round(1.0 * 2000) + Math.round(0.5 * 4000)); // 2000 + 2000
  assert.equal(m.parts.length, 2);
  // no mix falls back to the baseline level
  const none = crewMix(2, [], settings);
  assert.equal(none.hours, 2);
  assert.equal(none.costCents, 8000);
});

test('apprenticeHours rolls time up by level and gives the apprentice:journeyman ratio', () => {
  const entries = [
    { employeeId: 'e1', hours: 8 },   // apprentice
    { employeeId: 'e2', minutes: 480 }, // journeyman, 8h via minutes
    { employeeId: 'e3', hours: 4 },   // foreman (counts with journeyman side)
    { employeeId: 'e9', hours: 5 },   // no level -> unassigned
    { employeeId: 'e1', hours: 2 },   // more apprentice
  ];
  const employeeLevel = { e1: 'app1', e2: 'jw', e3: 'fm' };
  const r = apprenticeHours(entries, { employeeLevel, settings });
  assert.equal(r.apprenticeHours, 10);
  assert.equal(r.journeymanHours, 12); // 8 jw + 4 foreman
  assert.equal(r.totalHours, 27);      // includes 5 unassigned
  assert.equal(r.ratio, round2(10 / 12));
  // apprentice cost rolled at the level rate: 10h * $20 = $200
  const appRow = r.rows.find((x) => x.level?.id === 'app1');
  assert.equal(appRow.costCents, 20000);
  // the unassigned bucket keeps the orphan hours
  assert.ok(r.rows.some((x) => x.level === null && x.hours === 5));
});

test('normalizeLevels clamps junk and newLevel is well formed', () => {
  const n = normalizeLevels([{ name: 'X', productivityPct: 9999, costCents: '12.7', year: 7 }]);
  assert.equal(n[0].productivityPct, 400); // clamped
  assert.equal(n[0].year, null);           // 7 is not a valid apprentice year
  assert.equal(n[0].kind, 'other');
  assert.ok(newLevel().id && newLevel().productivityPct === 100);
  assert.deepEqual(normalizeLevels(null), []);
  assert.deepEqual(activeLevels({ labourLevels: [{ id: 'a', name: 'A', archived: true }] }), []);
});

test('peopleFromEmployees folds same-name records into one person, keeping every id', () => {
  const people = peopleFromEmployees([
    { id: 'a', name: 'Kelvin waldner', role: 'admin' },
    { id: 'b', name: 'Kelvin Waldner', role: 'electrician', labourLevelId: 'L1' },
    { id: 'c', name: 'Travis', role: 'owner' },
    { id: 'd', name: 'Travis Gross', role: 'electrician' },
  ]);
  assert.equal(people.length, 3); // the two Kelvins fold; Travis / Travis Gross are different names
  const kelvin = people.find((p) => /kelvin/i.test(p.name));
  assert.deepEqual(kelvin.ids.sort(), ['a', 'b']);
  assert.equal(kelvin.levelId, 'L1'); // the level from either record carries
  assert.ok(kelvin.role.includes('admin') && kelvin.role.includes('electrician'));
});

test('peopleFromEmployees keeps nameless records distinct (no accidental merge)', () => {
  const people = peopleFromEmployees([{ id: 'x', name: '' }, { id: 'y', name: '' }]);
  assert.equal(people.length, 2);
});

function round2(n) { return Math.round(n * 100) / 100; }
