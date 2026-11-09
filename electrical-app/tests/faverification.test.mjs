// Run: node --test electrical-app/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newVerification, newDevice, deviceResult, summarizeDevices, resultFrom, verificationLabel, deviceTypeOf, DEVICE_CHECKS } from '../js/lib/faverification.js';

test('a new verification is tied to a job and starts incomplete with no devices', () => {
  const v = newVerification({ job: { id: 'j1', clientId: 'c1', title: 'Tower A' }, by: 'u1' });
  assert.equal(v.jobId, 'j1');
  assert.equal(v.clientId, 'c1');
  assert.equal(v.building, 'Tower A');
  assert.equal(v.overallResult, 'incomplete');
  assert.deepEqual(v.devices, []);
  assert.equal(v.stage, 'initial');
});

test('a new device carries every check blank and a valid type', () => {
  const d = newDevice('pull');
  assert.equal(d.type, 'pull');
  for (const c of DEVICE_CHECKS) assert.equal(d.checks[c.id], '');
  assert.equal(newDevice('nope').type, deviceTypeOf('nope').id, 'unknown type falls back to other');
});

test('deviceResult: fail wins over pass, pass needs a recorded pass, else pending', () => {
  assert.equal(deviceResult({ checks: {} }), 'pending');
  assert.equal(deviceResult({ checks: { installed: 'pass' } }), 'pass');
  assert.equal(deviceResult({ checks: { installed: 'pass', alarmAtPanel: 'fail' } }), 'fail');
  assert.equal(deviceResult({ checks: { installed: 'na', correctType: 'na' } }), 'pending', 'n/a alone is not a pass');
});

test('summarizeDevices counts pass, fail and pending', () => {
  const devices = [
    { checks: { installed: 'pass' } },
    { checks: { installed: 'fail' } },
    { checks: {} },
    { checks: { installed: 'pass', annunciation: 'pass' } },
  ];
  assert.deepEqual(summarizeDevices(devices), { total: 4, pass: 2, fail: 1, pending: 1 });
});

test('resultFrom: fail if any device or the standby/alarm test fails; incomplete while pending; else pass', () => {
  assert.equal(resultFrom({ devices: [] }), 'incomplete', 'no devices');
  assert.equal(resultFrom({ devices: [{ checks: {} }] }), 'incomplete', 'a pending device');
  assert.equal(resultFrom({ devices: [{ checks: { installed: 'pass' } }] }), 'pass');
  assert.equal(resultFrom({ devices: [{ checks: { installed: 'fail' } }] }), 'fail');
  assert.equal(resultFrom({ devices: [{ checks: { installed: 'pass' } }], battery: { standbyOk: 'fail' } }), 'fail', 'standby fail fails it');
  assert.equal(resultFrom({ devices: [{ checks: { installed: 'pass' } }], battery: { alarmOk: 'fail' } }), 'fail', 'alarm-load fail fails it');
});

test('verificationLabel reads the building and date', () => {
  assert.equal(verificationLabel({ building: 'City Hall', date: '2026-11-09' }), 'City Hall · 2026-11-09');
  assert.equal(verificationLabel({}), 'Fire-alarm verification');
});
