// Exercise the Xcode parser's actual UUID consumer when its dependency override changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const xcode = require('xcode');
const xcodeRequire = createRequire(require.resolve('xcode'));
const uuid = xcodeRequire('uuid');

test('Xcode generates valid unique IDs and round-trips a changed project', () => {
  const project = xcode.project(fileURLToPath(new URL('../ios/App/App.xcodeproj/project.pbxproj', import.meta.url)));
  project.parseSync();
  const root = project.hash.project.rootObject;
  const seen = new Set(project.allUuids());
  for (let i = 0; i < 1000; i++) {
    const id = project.generateUuid();
    assert.match(id, /^[0-9A-F]{24}$/);
    assert.ok(!seen.has(id), 'new identifier does not collide with an existing project object');
    seen.add(id);
  }
  const group = project.addPbxGroup([], 'DependencyValidation', 'DependencyValidation');
  assert.match(group.uuid, /^[0-9A-F]{24}$/);
  const scratch = mkdtempSync(join(tmpdir(), 'fishtape-xcode-uuid-'));
  const output = join(scratch, 'project.pbxproj');
  try {
    writeFileSync(output, project.writeSync());
    const roundtrip = xcode.project(output);
    roundtrip.parseSync();
    assert.equal(roundtrip.hash.project.rootObject, root);
    assert.equal(roundtrip.hash.project.objects.PBXGroup[group.uuid].name, 'DependencyValidation');
  } finally {
    unlinkSync(output);
    rmdirSync(scratch);
  }
});

test('the UUID dependency used by Xcode rejects an undersized output buffer', () => {
  // GHSA-w5hq-g745-h8pq: v5 must reject partial writes into caller-provided buffers.
  assert.throws(() => uuid.v5('test', uuid.v5.DNS, new Uint8Array(8), 4), RangeError);
});
