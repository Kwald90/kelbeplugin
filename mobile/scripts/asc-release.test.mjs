import test from 'node:test';
import assert from 'node:assert/strict';
import { assignInternalBuild, createDistributionProfile } from './asc-release.mjs';

const group = (attributes = {}) => ({ id: 'group-1', attributes: { name: 'TG Electrical', isInternalGroup: true, hasAccessToAllBuilds: false, ...attributes } });

test('external or unclassified same-name groups never receive a build', async () => {
  for (const isInternalGroup of [false, undefined]) {
    for (const hasAccessToAllBuilds of [false, true]) {
      const calls = [];
      await assert.rejects(assignInternalBuild(async (method, path) => {
        calls.push({ method, path });
        return { data: [group({ isInternalGroup, hasAccessToAllBuilds })] };
      }, 'app-1', 'build-1', 'TG Electrical'), /not confirmed internal/);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, 'GET');
    }
  }
});

test('existing internal groups receive only the requested build when needed', async () => {
  for (const hasAccessToAllBuilds of [false, true]) {
    const mutations = [];
    await assignInternalBuild(async (method, path, body) => {
      if (method === 'GET') return { data: [group({ hasAccessToAllBuilds })] };
      mutations.push({ method, path, body });
    }, 'app-1', 'build-1', 'TG Electrical');
    assert.deepEqual(mutations, hasAccessToAllBuilds ? [] : [{
      method: 'POST', path: '/betaGroups/group-1/relationships/builds', body: { data: [{ type: 'builds', id: 'build-1' }] },
    }]);
  }
});

test('missing group is created internal and its returned classification is checked', async () => {
  for (const confirmedInternal of [true, false]) {
    const calls = [];
    const operation = assignInternalBuild(async (method, path, body) => {
      calls.push({ method, path, body });
      if (method === 'GET') return { data: [] };
      assert.equal(path, '/betaGroups');
      assert.equal(body.data.attributes.isInternalGroup, true);
      assert.equal(body.data.relationships.app.data.id, 'app-1');
      return { data: group({ isInternalGroup: confirmedInternal, hasAccessToAllBuilds: true }) };
    }, 'app-1', 'build-1', 'TG Electrical');
    if (confirmedInternal) await operation;
    else await assert.rejects(operation, /not confirmed internal/);
    assert.equal(calls.length, 2);
  }
});

test('truncated group list cannot cause creation of a duplicate group', async () => {
  const calls = [];
  await assert.rejects(assignInternalBuild(async (method) => {
    calls.push(method);
    return { data: [], links: { next: 'https://api.appstoreconnect.apple.com/v1/betaGroups?cursor=next' } };
  }, 'app-1', 'build-1', 'TG Electrical'), /list is incomplete/);
  assert.deepEqual(calls, ['GET']);
});

test('creating distribution profiles preserves prior signing profiles and uses distinct names', async () => {
  const existing = { id: 'prior-profile', attributes: { name: 'Fishtape App Store previous' } };
  const profiles = new Map([[existing.id, existing]]);
  const call = async (method, path, body) => {
    assert.equal(method, 'POST', 'must not delete or modify an existing profile');
    assert.equal(path, '/profiles');
    assert.equal(body.data.attributes.profileType, 'IOS_APP_STORE');
    assert.equal(body.data.relationships.bundleId.data.id, 'bundle-1');
    assert.deepEqual(body.data.relationships.certificates.data, [{ type: 'certificates', id: 'cert-1' }]);
    assert.ok(![...profiles.values()].some((p) => p.attributes.name === body.data.attributes.name));
    const made = { id: `profile-${profiles.size}`, ...body.data };
    profiles.set(made.id, made);
    return { data: made };
  };
  await createDistributionProfile(call, 'bundle-1', 'cert-1');
  await createDistributionProfile(call, 'bundle-1', 'cert-1');
  assert.equal(profiles.size, 3);
  assert.equal(profiles.get(existing.id), existing);
});

test('profile creation failure performs no destructive retry', async () => {
  const calls = [];
  await assert.rejects(createDistributionProfile(async (method, path) => {
    calls.push({ method, path });
    throw new Error('Apple rejected new profile');
  }, 'bundle-1', 'cert-1', 'existing-name'), /Apple rejected/);
  assert.deepEqual(calls, [{ method: 'POST', path: '/profiles' }]);
});
