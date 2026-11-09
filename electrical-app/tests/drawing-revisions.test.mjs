// Run: node --test electrical-app/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newDrawing, newRevEntry, addRevision, markSupersededPatch, markVoidPatch, reinstatePatch,
  isCurrent, latestRev, sortRevHistory, filterDrawings, currentSet, sortDrawings, groupByDiscipline,
  summarize, statusLabel, statusTone, statusRank, disciplineLabel, drawingLabel, MAX_REVISIONS,
} from '../js/lib/drawing-revisions.js';

test('a new drawing is current, tied to a job, and seeds its first revision', () => {
  const d = newDrawing({ job: { id: 'j1', clientId: 'c1' }, number: 'E-101', title: 'Power plan', discipline: 'E', rev: '0', date: '2026-11-01', receivedFrom: 'Engineer' });
  assert.equal(d.jobId, 'j1');
  assert.equal(d.clientId, 'c1');
  assert.equal(d.number, 'E-101');
  assert.equal(d.status, 'current');
  assert.equal(d.currentRev, '0');
  assert.equal(d.revHistory.length, 1);
  assert.equal(d.revHistory[0].rev, '0');
  assert.equal(d.revHistory[0].receivedFrom, 'Engineer');
  assert.equal(d.revHistory[0].superseded, false);
  assert.equal(isCurrent(d), true);
});

test('a new drawing with no revision starts with an empty history', () => {
  const d = newDrawing({ number: 'E-200' });
  assert.deepEqual(d.revHistory, []);
  assert.equal(d.currentRev, '');
});

test('newRevEntry clamps and defaults fields', () => {
  const e = newRevEntry({ rev: 'A', date: '2026-11-02', description: 'Issued for construction', receivedFrom: 'Architect' });
  assert.equal(e.rev, 'A');
  assert.equal(e.superseded, false);
  assert.ok(e.id);
  assert.equal(newRevEntry({}).rev, '');
});

test('addRevision supersedes prior entries, adds the new live one, and bumps the current rev', () => {
  const d = newDrawing({ number: 'E-101', rev: '0', date: '2026-11-01' });
  const patch = addRevision(d, { rev: '1', date: '2026-11-05', description: 'Added panel', receivedFrom: 'Engineer' });
  assert.equal(patch.currentRev, '1');
  assert.equal(patch.status, 'current');
  assert.equal(patch.revHistory.length, 2);
  assert.equal(patch.revHistory[0].superseded, true, 'rev 0 now superseded');
  assert.equal(patch.revHistory[1].superseded, false, 'rev 1 is live');
  assert.equal(patch.revHistory[1].rev, '1');
});

test('addRevision brings a superseded drawing back to current', () => {
  const d = { ...newDrawing({ number: 'E-101', rev: '0' }), status: 'superseded' };
  const patch = addRevision(d, { rev: '1' });
  assert.equal(patch.status, 'current');
});

test('addRevision keeps at most MAX_REVISIONS entries', () => {
  let d = newDrawing({ number: 'E-1' });
  for (let i = 0; i <= MAX_REVISIONS + 5; i++) d = { ...d, ...addRevision(d, { rev: String(i) }) };
  assert.equal(d.revHistory.length, MAX_REVISIONS);
  assert.equal(d.currentRev, String(MAX_REVISIONS + 5), 'the latest rev is kept');
});

test('status patches flip the status only', () => {
  assert.deepEqual(markSupersededPatch(), { status: 'superseded' });
  assert.deepEqual(markVoidPatch(), { status: 'void' });
  assert.deepEqual(reinstatePatch(), { status: 'current' });
});

test('latestRev uses the stored current rev, else the newest live entry', () => {
  assert.equal(latestRev({ currentRev: '3', revHistory: [] }), '3');
  assert.equal(latestRev({ currentRev: '', revHistory: [newRevEntry({ rev: '0', superseded: true }), newRevEntry({ rev: '1' })] }), '1');
  assert.equal(latestRev({ revHistory: [] }), '');
});

test('sortRevHistory puts the newest revision first by date', () => {
  const h = [
    newRevEntry({ rev: '0', date: '2026-11-01' }),
    newRevEntry({ rev: '2', date: '2026-11-10' }),
    newRevEntry({ rev: '1', date: '2026-11-05' }),
  ];
  assert.deepEqual(sortRevHistory(h).map((e) => e.rev), ['2', '1', '0']);
});

test('filterDrawings narrows by job, status and discipline', () => {
  const recs = [
    { id: 'a', jobId: 'j1', status: 'current', discipline: 'E' },
    { id: 'b', jobId: 'j1', status: 'superseded', discipline: 'E' },
    { id: 'c', jobId: 'j2', status: 'current', discipline: 'A' },
    { id: 'd', jobId: null, status: 'current', discipline: 'E' },
  ];
  assert.deepEqual(filterDrawings(recs, { jobId: 'j1' }).map((x) => x.id), ['a', 'b']);
  assert.deepEqual(filterDrawings(recs, { status: 'current' }).map((x) => x.id), ['a', 'c', 'd']);
  assert.deepEqual(filterDrawings(recs, { discipline: 'E' }).map((x) => x.id), ['a', 'b', 'd']);
  assert.deepEqual(filterDrawings(recs, { jobId: '__none' }).map((x) => x.id), ['d']);
});

test('currentSet selects only current drawings, sorted by discipline then number', () => {
  const recs = [
    { id: 'super', number: 'E-100', discipline: 'E', status: 'superseded' },
    { id: 'eTwo', number: 'E-102', discipline: 'E', status: 'current' },
    { id: 'arch', number: 'A-101', discipline: 'A', status: 'current' },
    { id: 'eTen', number: 'E-10', discipline: 'E', status: 'current' },
    { id: 'void', number: 'E-101', discipline: 'E', status: 'void' },
  ];
  assert.deepEqual(currentSet(recs).map((x) => x.id), ['arch', 'eTen', 'eTwo']);
});

test('sortDrawings orders numbers naturally (E-9 before E-10)', () => {
  const recs = [{ number: 'E-10', discipline: 'E' }, { number: 'E-9', discipline: 'E' }, { number: 'E-2', discipline: 'E' }];
  assert.deepEqual(sortDrawings(recs).map((x) => x.number), ['E-2', 'E-9', 'E-10']);
});

test('groupByDiscipline buckets and labels disciplines', () => {
  const recs = [
    { number: 'E-1', discipline: 'E', status: 'current' },
    { number: 'A-1', discipline: 'A', status: 'current' },
    { number: 'E-2', discipline: 'E', status: 'current' },
  ];
  const g = groupByDiscipline(recs);
  assert.deepEqual(g.map((x) => x.discipline), ['A', 'E']);
  assert.equal(g[1].label, 'Electrical');
  assert.deepEqual(g[1].items.map((x) => x.number), ['E-1', 'E-2']);
});

test('summarize counts statuses', () => {
  const s = summarize([{ status: 'current' }, { status: 'current' }, { status: 'superseded' }, { status: 'void' }, {}]);
  assert.equal(s.total, 5);
  assert.equal(s.current, 3);
  assert.equal(s.superseded, 1);
  assert.equal(s.void, 1);
});

test('labels fall back gracefully', () => {
  assert.equal(statusLabel('current'), 'Current');
  assert.equal(statusTone('superseded'), 'warning');
  assert.ok(statusRank('current') < statusRank('void'));
  assert.equal(disciplineLabel('E'), 'Electrical');
  assert.equal(disciplineLabel('XX'), 'XX');
  assert.equal(disciplineLabel(''), '');
  assert.equal(drawingLabel({ number: 'E-101', title: 'Power plan' }), 'E-101 — Power plan');
  assert.equal(drawingLabel({ number: 'E-101' }), 'E-101');
  assert.equal(drawingLabel({}), 'Drawing');
});
