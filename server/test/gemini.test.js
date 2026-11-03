// Gemini transcription client: settings defaults, response parsing and error handling, with a
// fake fetch (no network). The platform-key wiring is covered by the embedded suite.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { geminiSettings, extractText, transcribeAudio, TRANSCRIBE_PROMPT } from '../src/services/gemini.js';

describe('geminiSettings', () => {
  test('sensible defaults, all overridable by env', () => {
    const d = geminiSettings({}, {});
    assert.equal(d.model, 'gemini-2.5-flash');
    assert.equal(d.apiBase, 'https://generativelanguage.googleapis.com/v1beta');
    assert.equal(d.apiKey, '');
    assert.ok(d.maxInlineBytes > 0 && d.maxInlineBytes < 20 * 1024 * 1024);
    const o = geminiSettings({}, { GEMINI_API_KEY: 'k', GEMINI_MODEL: 'gemini-x', GEMINI_API_BASE: 'https://example.test/v1/' });
    assert.equal(o.apiKey, 'k');
    assert.equal(o.model, 'gemini-x');
    assert.equal(o.apiBase, 'https://example.test/v1'); // trailing slash trimmed
  });
});

describe('extractText', () => {
  test('joins the candidate text parts and trims', () => {
    assert.equal(extractText({ candidates: [{ content: { parts: [{ text: ' Hello ' }, { text: 'world.' }] } }] }), 'Hello world.');
    assert.equal(extractText({}), '');
    assert.equal(extractText({ candidates: [{ content: {} }] }), '');
  });
});

describe('transcribeAudio', () => {
  const base = { model: 'gemini-2.5-flash', apiBase: 'https://x.test/v1beta', audioBase64: 'AAAA', mimeType: 'audio/ogg' };

  test('refuses without a key', async () => {
    await assert.rejects(() => transcribeAudio({ ...base, apiKey: '' }), /not configured/i);
  });

  test('posts inline audio with the key header and returns the transcript', async () => {
    let seen = null;
    const fetchImpl = async (url, opts) => {
      seen = { url, opts };
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'the panel is fed from a 200 amp main' }] } }] }) };
    };
    const text = await transcribeAudio({ ...base, apiKey: 'secret', fetchImpl });
    assert.equal(text, 'the panel is fed from a 200 amp main');
    assert.equal(seen.url, 'https://x.test/v1beta/models/gemini-2.5-flash:generateContent');
    assert.equal(seen.opts.headers['x-goog-api-key'], 'secret');
    const body = JSON.parse(seen.opts.body);
    assert.equal(body.contents[0].parts[0].text, TRANSCRIBE_PROMPT);
    assert.equal(body.contents[0].parts[1].inlineData.mimeType, 'audio/ogg');
    assert.equal(body.contents[0].parts[1].inlineData.data, 'AAAA');
  });

  test('turns an API error into a safe message and never echoes the key', async () => {
    const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'bad key secret123' } }) });
    await assert.rejects(() => transcribeAudio({ ...base, apiKey: 'secret123', fetchImpl }), (e) => {
      assert.ok(!e.message.includes('secret123'), 'key is redacted');
      assert.match(e.message, /\[key\]/);
      return true;
    });
  });

  test('a blocked, empty response is an error', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }) });
    await assert.rejects(() => transcribeAudio({ ...base, apiKey: 'k', fetchImpl }), /blocked/i);
  });
});
