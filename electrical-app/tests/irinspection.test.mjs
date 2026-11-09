// Run: node --test electrical-app/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newInspection, newFinding, computeDelta, severityForDelta, findingSeverity, summarize, sortFindings, inspectionLabel } from '../js/lib/irinspection.js';

test('a new inspection links a job and an asset and starts with no findings', () => {
  const r = newInspection({ job: { id: 'j1', clientId: 'c1', title: 'MCC-1' }, asset: { id: 'a1', name: 'Main switchboard' }, by: 'u1' });
  assert.equal(r.jobId, 'j1');
  assert.equal(r.clientId, 'c1');
  assert.equal(r.assetId, 'a1');
  assert.equal(r.target, 'Main switchboard', 'asset name wins for the target');
  assert.deepEqual(r.findings, []);
});

test('computeDelta is measured minus reference, or null when either is missing', () => {
  assert.equal(computeDelta({ measuredC: 58, referenceC: 30 }), 28);
  assert.equal(computeDelta({ measuredC: 58.25, referenceC: 30 }), 28.3, 'rounded to 0.1');
  assert.equal(computeDelta({ measuredC: 58 }), null);
  assert.equal(computeDelta({ referenceC: 30 }), null);
});

test('severityForDelta walks the NETA-style bands (VERIFY against the standard)', () => {
  assert.equal(severityForDelta(0.5), 'none');
  assert.equal(severityForDelta(2), 'investigate');
  assert.equal(severityForDelta(3), 'investigate');
  assert.equal(severityForDelta(4), 'repair-scheduled');
  assert.equal(severityForDelta(15), 'repair-scheduled');
  assert.equal(severityForDelta(16), 'repair-immediate');
  assert.equal(severityForDelta(80), 'repair-immediate');
  assert.equal(severityForDelta(-5), 'none', 'negative ΔT is normal');
});

test('findingSeverity uses the ΔT band, or a manual override when set', () => {
  assert.equal(findingSeverity(newFinding()), 'none', 'blank finding has no ΔT');
  assert.equal(findingSeverity({ measuredC: 50, referenceC: 30 }), 'repair-immediate');
  assert.equal(findingSeverity({ measuredC: 50, referenceC: 30, severity: 'investigate' }), 'investigate', 'override wins');
  assert.equal(findingSeverity({ measuredC: 50, referenceC: 30, severity: '' }), 'repair-immediate', 'blank override = auto');
});

test('summarize counts by band and names the worst', () => {
  const findings = [
    { measuredC: 31, referenceC: 30 }, // none (ΔT 1 -> none at <1? 1 => investigate boundary)
    { measuredC: 34, referenceC: 30 }, // investigate (ΔT 4 -> scheduled). adjust below
  ];
  // Use explicit deltas for clarity:
  const s = summarize([
    { measuredC: 30, referenceC: 30 }, // 0 none
    { measuredC: 32, referenceC: 30 }, // 2 investigate
    { measuredC: 40, referenceC: 30 }, // 10 repair-scheduled
    { measuredC: 60, referenceC: 30 }, // 30 repair-immediate
  ]);
  assert.equal(s.total, 4);
  assert.equal(s.none, 1);
  assert.equal(s.investigate, 1);
  assert.equal(s['repair-scheduled'], 1);
  assert.equal(s['repair-immediate'], 1);
  assert.equal(s.worst, 'repair-immediate');
  void findings;
});

test('sortFindings puts the worst / hottest first', () => {
  const findings = [
    { id: 'a', measuredC: 32, referenceC: 30 }, // 2 investigate
    { id: 'b', measuredC: 60, referenceC: 30 }, // 30 immediate
    { id: 'c', measuredC: 45, referenceC: 30 }, // 15 scheduled
  ];
  assert.deepEqual(sortFindings(findings).map((f) => f.id), ['b', 'c', 'a']);
});

test('inspectionLabel reads the target and date', () => {
  assert.equal(inspectionLabel({ target: 'DP-2', date: '2026-11-09' }), 'DP-2 · 2026-11-09');
  assert.equal(inspectionLabel({}), 'IR inspection');
});
