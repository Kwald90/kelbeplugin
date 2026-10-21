import test from 'node:test';
import assert from 'node:assert/strict';
import { fieldSyncStatus, personalShiftStatus, fieldSiteDetails } from '../js/lib/field-status.js';

test('sync feedback never calls a pending, rejected or failed queue synced', () => {
  const base = { state: 'synced', waiting: 0, rejected: 0, lastSyncAt: '2026-10-21T08:00:00Z' };
  assert.equal(fieldSyncStatus(base).title, 'Changes synced');
  assert.match(fieldSyncStatus({ ...base, waiting: 2 }).title, /waiting to sync/);
  for (const state of ['syncing', 'synced', 'offline', 'error']) {
    const result = fieldSyncStatus({ ...base, state, rejected: 1, waiting: 2 });
    assert.equal(result.tone, 'danger');
    assert.match(result.title, /not accepted/);
    assert.match(result.detail, /2 changes also waiting/);
    assert.doesNotMatch(result.detail, /saved on this device/);
  }
  assert.equal(fieldSyncStatus({ ...base, state: 'error' }).tone, 'danger');
  assert.equal(fieldSyncStatus({ ...base, state: 'offline' }).title, 'Offline');
  assert.match(fieldSyncStatus({ ...base, state: 'offline', waiting: 1 }).detail, /1 change waiting/);
  assert.equal(fieldSyncStatus({ ...base, state: 'syncing' }).title, 'Syncing');
});
test('no completed sync is not reported as synced and demo is explicit', () => {
  assert.equal(fieldSyncStatus({ state: 'synced' }).title, 'Waiting for first sync');
  assert.equal(fieldSyncStatus(null).title, 'Sync status unavailable');
  assert.equal(fieldSyncStatus(null, { demo: true }).title, 'Demo on this device');
});
test('shift summary exposes only the current employee open entry', () => {
  const entry = { employeeId: 'me', clockIn: '2026-10-21T08:00:00Z', jobId: 'job1' };
  assert.equal(personalShiftStatus(entry, 'me').title, 'Clocked in');
  assert.equal(personalShiftStatus({ ...entry, kind: 'travel' }, 'me').title, 'Clocked in: travelling');
  assert.equal(personalShiftStatus({ ...entry, breakStart: '2026-10-21T09:00:00Z' }, 'me').title, 'On break');
  assert.equal(personalShiftStatus({ ...entry, breakStart: '2026-10-21T09:00:00Z' }, 'me').since, '2026-10-21T09:00:00Z');
  assert.equal(personalShiftStatus({ ...entry, clockOut: '2026-10-21T10:00:00Z' }, 'me').title, 'Not clocked in');
  assert.equal(personalShiftStatus(entry, 'someone-else').jobId, undefined);
  assert.equal(personalShiftStatus(entry, null).jobId, undefined);
  assert.equal(personalShiftStatus(null, 'me').title, 'Not clocked in');
});
test('site and customer contact require their separate permissions', () => {
  const job = { id: 'job1', title: 'Site', address: '123 Main & First', clientId: 'customer' };
  const client = { name: 'Customer', phone: '+1 (780) 555-0100' };
  assert.equal(fieldSiteDetails(job, client), null);
  const siteOnly = fieldSiteDetails(job, client, { canSeeJobs: true });
  assert.equal(siteOnly.contactName, '');
  assert.equal(siteOnly.phone, '');
  assert.equal(siteOnly.phoneHref, null);
  assert.equal(new URL(siteOnly.directions).searchParams.get('daddr'), job.address);
  const permitted = fieldSiteDetails(job, client, { canSeeJobs: true, canSeeClients: true });
  assert.equal(permitted.contactName, 'Customer');
  assert.equal(permitted.phoneHref, 'tel:+17805550100');
  assert.equal(fieldSiteDetails({ id: 'job1' }, { phone: 'javascript:alert(1)' }, { canSeeJobs: true }).phoneHref, null);
});
