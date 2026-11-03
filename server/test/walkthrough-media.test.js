// Pure unit tests for the walkthrough video store (no DB, no ffmpeg). The route and worker are
// exercised against real Postgres by the embedded suite + migrations.test.js.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_DIMENSION, audioArgs, mediaRowView, parseProbe, posterArgs, randomMediaName, transcodeArgs,
} from '../src/services/walkthrough-media.js';

describe('walkthrough media views', () => {
  const base = { id: 'm1', walkthrough_id: 'wt1', duration_ms: 90500, width: 720, height: 1280, bytes: 12345 };

  test('a ready row exposes the optimised MP4 and its poster', () => {
    const v = mediaRowView({ ...base, status: 'ready', output_file: 'a'.repeat(32) + '.mp4', poster_file: 'b'.repeat(32) + '.jpg' });
    assert.equal(v.status, 'ready');
    assert.equal(v.url, `/media/${'a'.repeat(32)}.mp4`);
    assert.equal(v.posterUrl, `/media/${'b'.repeat(32)}.jpg`);
    assert.equal(v.durationMs, 90500);
    assert.equal(v.bytes, 12345);
    assert.equal(v.error, null);
  });

  test('a processing MP4 original plays immediately; a WebM original waits', () => {
    const mp4 = mediaRowView({ ...base, status: 'processing', original_mime: 'video/mp4', original_file: 'c'.repeat(32) + '.mp4' });
    assert.equal(mp4.url, `/media/${'c'.repeat(32)}.mp4`);
    assert.equal(mp4.posterUrl, null);
    const webm = mediaRowView({ ...base, status: 'processing', original_mime: 'video/webm', original_file: 'd'.repeat(32) + '.webm' });
    assert.equal(webm.url, null);
  });

  test('a failed row carries a message and no url', () => {
    const v = mediaRowView({ ...base, status: 'failed', error: 'ffmpeg exploded' });
    assert.equal(v.url, null);
    assert.equal(v.error, 'ffmpeg exploded');
    const v2 = mediaRowView({ ...base, status: 'failed', error: null });
    assert.match(v2.error, /could not be processed/);
  });

  test('transcript fields: ready exposes the text; failed exposes a message', () => {
    const ready = mediaRowView({ ...base, status: 'ready', output_file: 'a'.repeat(32) + '.mp4', transcript: 'Walked the panel room.', transcribe_status: 'ready', transcribed_at: '2026-11-03T00:00:00Z' });
    assert.equal(ready.transcript, 'Walked the panel room.');
    assert.equal(ready.transcribeStatus, 'ready');
    assert.equal(ready.transcribeError, null);
    assert.equal(ready.transcribedAt, '2026-11-03T00:00:00.000Z');
    const failed = mediaRowView({ ...base, status: 'ready', output_file: 'a'.repeat(32) + '.mp4', transcribe_status: 'failed', transcribe_error: 'too long' });
    assert.equal(failed.transcribeError, 'too long');
    const none = mediaRowView({ ...base, status: 'ready', output_file: 'a'.repeat(32) + '.mp4' });
    assert.equal(none.transcript, null);
    assert.equal(none.transcribeStatus, null);
  });
});

describe('ffmpeg argument building', () => {
  test('transcode downscales the long edge without upscaling and writes a faststart MP4', () => {
    const args = transcodeArgs('/m/in.mp4', '/m/out.mp4');
    assert.ok(args.includes('libx264'));
    assert.ok(args.includes('+faststart'));
    assert.ok(args.includes('/m/in.mp4') && args.includes('/m/out.mp4'));
    const vf = args[args.indexOf('-vf') + 1];
    assert.ok(vf.includes(`min(${MAX_DIMENSION}\\,iw)`), 'escapes the comma so min() is not read as a filter separator');
    assert.ok(vf.includes('force_original_aspect_ratio=decrease'));
  });

  test('poster grabs a single frame', () => {
    const args = posterArgs('/m/out.mp4', '/m/p.jpg');
    assert.ok(args.includes('-frames:v') && args[args.indexOf('-frames:v') + 1] === '1');
    assert.ok(args.includes('/m/p.jpg'));
  });

  test('audio extraction drops video and makes a small mono 16 kHz Opus clip', () => {
    const args = audioArgs('/m/out.mp4', '/m/a.ogg');
    assert.ok(args.includes('-vn'), 'no video');
    assert.equal(args[args.indexOf('-ac') + 1], '1'); // mono
    assert.equal(args[args.indexOf('-ar') + 1], '16000'); // 16 kHz
    assert.ok(args.includes('libopus'));
    assert.ok(args.includes('/m/out.mp4') && args.includes('/m/a.ogg'));
  });
});

describe('ffprobe parsing', () => {
  test('pulls duration (ms) and the video stream dimensions', () => {
    const json = JSON.stringify({ format: { duration: '12.5' }, streams: [{ codec_type: 'audio' }, { codec_type: 'video', width: 720, height: 1280 }] });
    assert.deepEqual(parseProbe(json), { durationMs: 12500, width: 720, height: 1280 });
  });
  test('survives missing or junk probe output', () => {
    assert.deepEqual(parseProbe('not json'), {});
    assert.deepEqual(parseProbe({ streams: [] }), { durationMs: null, width: null, height: null });
  });
});

test('random media names match the only pattern nginx serves', () => {
  assert.match(randomMediaName('mp4'), /^[a-f0-9]{32}\.mp4$/);
  assert.match(randomMediaName('jpg'), /^[a-f0-9]{32}\.jpg$/);
});
