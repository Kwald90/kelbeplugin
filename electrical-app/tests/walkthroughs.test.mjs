// Run: node --test electrical-app/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newWalkthrough, newCapture, newGroup, withCapture, withoutCapture, assignCapture, relabelCapture,
  withGroup, renameGroup, withoutGroup, groupsWithCaptures, setRecording, setTranscript, progress,
  canShare, captureCount, hasVideo, hasTranscript, walkthroughLabel, legacyCaptures, MAX_CAPTURES, MAX_GROUPS,
} from '../js/lib/walkthroughs.js';
import { appendPhrase } from '../js/lib/transcribe.js';

const job = { id: 'j1', number: 'J-1001', title: 'Panel change', clientId: 'c1' };
const pic = 'data:image/jpeg;base64,x';

test('a new walkthrough is empty, free-form, tied to job + client, internal and active', () => {
  const w = newWalkthrough({ job, by: 'u1', date: '2026-11-02', title: 'Service call at Main St' });
  assert.equal(w.jobId, 'j1');
  assert.equal(w.clientId, 'c1');
  assert.equal(w.status, 'active');
  assert.equal(w.sharedWithClient, false);
  assert.equal(w.createdBy, 'u1');
  assert.deepEqual(w.captures, []);
  assert.deepEqual(w.groups, []);
  assert.equal(w.recording, null);
  assert.equal(w.transcript, '');
  assert.ok(!('stops' in w)); // the old room-by-room model is gone
  assert.match(walkthroughLabel(w), /Service call at Main St · 2026-11-02/);
});

test('the title falls back when none is given', () => {
  assert.equal(newWalkthrough({ job }).title, 'Site walkthrough');
});

test('stills are added in order and capped at MAX_CAPTURES', () => {
  let w = newWalkthrough({ job });
  w = { ...w, captures: withCapture(w, newCapture({ photo: pic, atMs: 1200 })) };
  assert.equal(captureCount(w), 1);
  assert.equal(w.captures[0].kind, 'photo');
  assert.equal(w.captures[0].atMs, 1200);
  assert.equal(w.captures[0].groupId, null);
  // overflow drops the oldest
  for (let i = 0; i < MAX_CAPTURES + 5; i++) w = { ...w, captures: withCapture(w, newCapture({ photo: pic })) };
  assert.equal(captureCount(w), MAX_CAPTURES);
});

test('groups are created on the fly and stills assigned into them', () => {
  let w = newWalkthrough({ job });
  const c1 = newCapture({ photo: pic }); const c2 = newCapture({ photo: pic });
  w = { ...w, captures: [c1, c2] };
  w = { ...w, groups: withGroup(w, 'Panel room') };
  const g = w.groups[0];
  assert.equal(g.name, 'Panel room');
  w = { ...w, captures: assignCapture(w, c1.id, g.id) };
  assert.equal(w.captures.find((c) => c.id === c1.id).groupId, g.id);
  // an unknown group id is rejected (capture stays ungrouped)
  w = { ...w, captures: assignCapture(w, c2.id, 'nope') };
  assert.equal(w.captures.find((c) => c.id === c2.id).groupId, null);

  const view = groupsWithCaptures(w);
  assert.equal(view[0].group.id, g.id);
  assert.deepEqual(view[0].captures.map((c) => c.id), [c1.id]);
  const ungrouped = view.find((v) => v.group === null);
  assert.deepEqual(ungrouped.captures.map((c) => c.id), [c2.id]);
});

test('removing a group moves its stills back to ungrouped — never orphaned', () => {
  let w = newWalkthrough({ job });
  const c = newCapture({ photo: pic });
  w = { ...w, captures: [c], groups: withGroup(w, 'Attic') };
  w = { ...w, captures: assignCapture(w, c.id, w.groups[0].id) };
  const patch = withoutGroup(w, w.groups[0].id);
  assert.deepEqual(patch.groups, []);
  assert.equal(patch.captures[0].groupId, null);
});

test('rename a group, relabel and remove a still', () => {
  let w = newWalkthrough({ job });
  const c = newCapture({ photo: pic });
  w = { ...w, captures: [c], groups: withGroup(w, 'A') };
  w = { ...w, groups: renameGroup(w, w.groups[0].id, 'Service entrance') };
  assert.equal(w.groups[0].name, 'Service entrance');
  w = { ...w, captures: relabelCapture(w, c.id, 'Burnt lug') };
  assert.equal(w.captures[0].label, 'Burnt lug');
  w = { ...w, captures: withoutCapture(w, c.id) };
  assert.equal(captureCount(w), 0);
});

test('empty group names and the group cap are refused', () => {
  let w = newWalkthrough({ job });
  assert.deepEqual(withGroup(w, '   '), []);
  w = { ...w, groups: Array.from({ length: MAX_GROUPS }, (_, i) => newGroup(`G${i}`)) };
  assert.equal(withGroup(w, 'one too many').length, MAX_GROUPS);
});

test('recording and transcript patches', () => {
  let w = newWalkthrough({ job });
  assert.equal(hasVideo(w), false);
  w = { ...w, ...setRecording({ localId: 'vid-1', durationMs: 90500, mimeType: 'video/mp4' }) };
  assert.equal(hasVideo(w), true);
  assert.equal(w.recording.durationMs, 90500);
  assert.equal(hasTranscript(w), false);
  w = { ...w, ...setTranscript('Walking the service entrance, the main lug is...', 'gemini') };
  assert.equal(hasTranscript(w), true);
  assert.equal(w.transcriptSource, 'gemini');
  // an unknown source is coerced to manual
  w = { ...w, ...setTranscript('x', 'bogus') };
  assert.equal(w.transcriptSource, 'manual');
});

test('sharing needs a client plus something to show; no client = no share', () => {
  let w = newWalkthrough({ job });
  assert.equal(canShare(w), false);
  w = { ...w, captures: withCapture(w, newCapture({ photo: pic })) };
  assert.equal(canShare(w), true);
  const noClient = newWalkthrough({ job: { id: 'j2', title: 'No client' } });
  assert.equal(canShare({ ...noClient, captures: [newCapture({ photo: pic })] }), false);
  // video alone is enough to share once there is a client
  assert.equal(canShare({ ...w, captures: [], ...setRecording({ localId: 'v' }) }), true);
});

test('progress summarises captures, groups, grouped/ungrouped, video, transcript', () => {
  let w = newWalkthrough({ job });
  const c1 = newCapture({ photo: pic }); const c2 = newCapture({ photo: pic });
  w = { ...w, captures: [c1, c2], groups: [newGroup('Panel')] };
  w = { ...w, captures: assignCapture(w, c1.id, w.groups[0].id) };
  w = { ...w, ...setRecording({ localId: 'v' }), ...setTranscript('hi', 'manual') };
  assert.deepEqual(progress(w), { captures: 2, groups: 1, grouped: 1, ungrouped: 1, hasVideo: true, hasTranscript: true });
});

test('appendPhrase spaces and capitalises dictated phrases, and caps length', () => {
  assert.equal(appendPhrase('', 'walking the service entrance'), 'Walking the service entrance');
  assert.equal(appendPhrase('Panel is open.', 'the main lug is loose'), 'Panel is open. The main lug is loose');
  assert.equal(appendPhrase('Note', 'done'), 'Note. Done');
  assert.equal(appendPhrase('x'.repeat(59999), 'tail').length, 60000);
});

test('legacyCaptures flattens an old room-by-room walkthrough into groups + captures', () => {
  const old = { stops: [
    { name: 'Panel', note: 'rusty', photos: [pic, pic] },
    { name: 'Attic', photos: [] },
    { name: 'Exterior', photos: [pic] },
  ] };
  const got = legacyCaptures(old);
  assert.equal(got.groups.length, 2); // empty stops contribute nothing
  assert.equal(got.captures.length, 3);
  assert.equal(got.captures[0].label, 'rusty');
  assert.ok(got.captures.every((c) => c.groupId));
  assert.equal(legacyCaptures(newWalkthrough({ job })), null);
});
