// Release mutations are separated from credentials so their boundaries can be tested offline.
import { randomUUID } from 'node:crypto';

export async function assignInternalBuild(call, appId, buildId, groupName) {
  const groups = await call('GET', `/betaGroups?filter[app]=${appId}&fields[betaGroups]=name,isInternalGroup,hasAccessToAllBuilds&limit=200`);
  let group = (groups.data || []).find((item) => item.attributes.name === groupName);
  if (!group) {
    // Never create a duplicate when a truncated response could hide the intended group.
    if (groups.links?.next) throw new Error('Beta group list is incomplete; locate the internal group in App Store Connect before continuing.');
    group = (await call('POST', '/betaGroups', {
      data: {
        type: 'betaGroups',
        attributes: { name: groupName, isInternalGroup: true, hasAccessToAllBuilds: true },
        relationships: { app: { data: { type: 'apps', id: appId } } },
      },
    })).data;
  }
  if (group.attributes.isInternalGroup !== true) {
    throw new Error(`TestFlight group "${groupName}" is not confirmed internal; refusing to distribute this build.`);
  }
  if (!group.attributes.hasAccessToAllBuilds) {
    await call('POST', `/betaGroups/${group.id}/relationships/builds`, { data: [{ type: 'builds', id: buildId }] });
  }
  return group;
}

export async function createDistributionProfile(call, bundleId, certificateId, name) {
  // Creating a new profile must never revoke other builds' signing inputs. A unique name also
  // avoids the former minute-level collision without deleting or replacing an existing profile.
  return (await call('POST', '/profiles', {
    data: {
      type: 'profiles',
      attributes: { name: name || `Fishtape App Store ${randomUUID()}`, profileType: 'IOS_APP_STORE' },
      relationships: {
        bundleId: { data: { type: 'bundleIds', id: bundleId } },
        certificates: { data: [{ type: 'certificates', id: certificateId }] },
      },
    },
  })).data;
}
