import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const xcode = require('xcode');
const xcodeRequire = createRequire(require.resolve('xcode'));
const plist = xcodeRequire('plist');
const manifestUrl = new URL('../ios/App/App/PrivacyInfo.xcprivacy', import.meta.url);

test('app privacy manifest declares the geofence app-private UserDefaults reason', () => {
  const manifest = plist.parse(readFileSync(manifestUrl, 'utf8'));
  const defaults = manifest.NSPrivacyAccessedAPITypes.find(
    (entry) => entry.NSPrivacyAccessedAPIType === 'NSPrivacyAccessedAPICategoryUserDefaults',
  );
  assert.ok(defaults, 'direct native UserDefaults use requires an app declaration');
  assert.ok(defaults.NSPrivacyAccessedAPITypeReasons.includes('CA92.1'));
});

test('App target copies its privacy manifest into the app bundle', () => {
  const project = xcode.project(fileURLToPath(new URL('../ios/App/App.xcodeproj/project.pbxproj', import.meta.url)));
  project.parseSync();
  const objects = project.hash.project.objects;
  const app = Object.values(objects.PBXNativeTarget).find((target) => target.name === 'App');
  assert.ok(app, 'App target exists');
  const resources = app.buildPhases.flatMap(({ value }) => objects.PBXResourcesBuildPhase[value]?.files ?? []);
  const manifests = resources.map(({ value }) => objects.PBXBuildFile[value]?.fileRef)
    .filter((ref) => objects.PBXFileReference[ref]?.path === 'PrivacyInfo.xcprivacy');
  assert.equal(manifests.length, 1, 'manifest must be in App Copy Bundle Resources exactly once');
  const appGroup = Object.values(objects.PBXGroup).find((group) => group.path === 'App');
  assert.ok(appGroup.children.some(({ value }) => value === manifests[0]), 'resource resolves from App directory');
  assert.equal(objects.PBXFileReference[manifests[0]].sourceTree, '"<group>"');
});
