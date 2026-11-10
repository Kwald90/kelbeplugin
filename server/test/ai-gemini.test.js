// The assistant running on Google Gemini instead of Anthropic: provider selection, a plain
// streamed answer, a function-calling tool round trip, usage logging with the Gemini model id,
// and error mapping. A scripted fake fetch (mockGemini) stands in for Gemini's REST API, so no
// test touches the real service or needs a key beyond the test placeholder.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { skip, createTestDatabase } from './support/db.js';
import { call, ownerTenant, startApp } from './support/app.js';
import { sse } from './support/anthropic-mock.js';
import { mockGemini, restoreGemini, geminiTurn, geminiText, geminiCall, geminiError } from './support/gemini-mock.js';
import { setSecret } from '../src/services/secrets.js';

let t, app, A;
const GEMINI_KEY = 'AIzaSyTEST-gemini-key-0000000000000000000';
const PHRASE = 'Tofino-4410 sub-panel';
let savedGeminiEnv;

async function seedCompany(token, prefix, provider = 'gemini') {
  await call(app, { method: 'POST', url: '/api/v1/settings', token, body: { id: 'settings', company: { name: `${prefix} Electric`, province: 'ON' }, labourRateCents: 10000, nextNumbers: { job: 1001, estimate: 2001, invoice: 3001 }, ai: { provider } } });
  await call(app, { method: 'POST', url: '/api/v1/items', token, body: { sku: `${prefix}-REC15`, name: '15A decora receptacle, supplied and installed', category: 'Devices', unit: 'ea', costCents: 300, priceCents: 4500, labourHours: 0.4, reorderPoint: 0, stock: {} } });
}

/** Shallow-merge a change into the company settings (the record already exists). */
async function setProvider(token, provider) {
  const r = await call(app, { method: 'PATCH', url: '/api/v1/settings/settings', token, body: { ai: { provider } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

async function newConversation(token, body = {}) {
  const r = await call(app, { method: 'POST', url: '/api/v1/ai/conversations', token, body: { mode: 'assistant', units: 'metric', ...body } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

async function say(token, convId, message) {
  const res = await app.inject({ method: 'POST', url: `/api/v1/ai/conversations/${convId}/messages`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: { text: message } });
  if (res.statusCode !== 200) return { status: res.statusCode, error: JSON.parse(res.body).error, events: [] };
  return { status: 200, headers: res.headers, events: sse(res.body) };
}

const textOf = (events) => events.filter((e) => e.event === 'text').map((e) => e.data.delta).join('');

before(async () => {
  if (skip) return;
  savedGeminiEnv = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = GEMINI_KEY;
  t = await createTestDatabase('aigemini');
  ({ app } = await startApp(t));
  A = await ownerTenant(t, app, 'Gemini Wiring Ltd');
  await seedCompany(A.token, 'Gem');
});
after(async () => {
  restoreGemini();
  if (savedGeminiEnv === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedGeminiEnv;
  await app?.close();
  await t?.close();
});

describe('provider selection', { skip }, () => {
  test('status reports Gemini as the provider when set, without revealing the key', async () => {
    const s = await call(app, { url: '/api/v1/ai/status', token: A.token });
    assert.equal(s.status, 200);
    assert.equal(s.body.provider, 'gemini');
    assert.equal(s.body.gemini.available, true);
    assert.match(s.body.model, /^gemini-/);
    assert.ok(!JSON.stringify(s.body).includes(GEMINI_KEY));
  });

  test('auto picks Gemini when there is no Anthropic key but a Gemini key is set', async () => {
    await setProvider(A.token, 'auto');
    const s = await call(app, { url: '/api/v1/ai/status', token: A.token });
    assert.equal(s.body.provider, 'gemini');
    await setProvider(A.token, 'gemini'); // put the explicit setting back
  });

  test('auto keeps Anthropic when the company has its own Anthropic key', async () => {
    await t.db.withTenant({ tenantId: A.tenantId }, (tx) => setSecret(tx, app.sealer, 'anthropic.api_key', 'sk-ant-api03-gemtest'), { write: true });
    await setProvider(A.token, 'auto');
    const s = await call(app, { url: '/api/v1/ai/status', token: A.token });
    assert.equal(s.body.provider, 'anthropic', 'Anthropic stays the default under auto when both exist');
    assert.equal(s.body.connected, true);
    // Remove the Anthropic key and force Gemini again for the chat tests below.
    await t.db.withTenant({ tenantId: A.tenantId }, (tx) => tx.query("DELETE FROM tenant_secrets WHERE tenant_id = $1 AND name = 'anthropic.api_key'", [tx.tenantId]), { write: true });
    await setProvider(A.token, 'gemini');
  });
});

describe('gemini chat', { skip }, () => {
  test('a plain answer streams as one text delta and logs usage with the Gemini model id', async () => {
    const mock = mockGemini([geminiTurn([geminiText(`Your ${PHRASE} looks fine.`)], { usage: { promptTokenCount: 800, candidatesTokenCount: 40 } })]);
    const conv = await newConversation(A.token);
    const r = await say(A.token, conv.id, `Is my ${PHRASE} okay?`);
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/event-stream/);
    const names = r.events.map((e) => e.event);
    assert.equal(names[0], 'start');
    assert.equal(names.at(-1), 'done');
    assert.match(textOf(r.events), new RegExp(PHRASE));
    // The key goes only in the x-goog-api-key header, never the URL or body.
    assert.equal(mock.calls[0].headers['x-goog-api-key'], GEMINI_KEY);
    assert.ok(!mock.calls[0].url.includes(GEMINI_KEY));
    assert.equal(mock.calls[0].body.systemInstruction.parts[0].text.includes('assistant'), true);

    const usage = await t.superPool.query('SELECT feature, model, input_tokens, output_tokens FROM ai_usage WHERE tenant_id = $1 AND conversation_id = $2 ORDER BY id', [A.tenantId, conv.id]);
    assert.equal(usage.rows.length, 1);
    assert.equal(usage.rows[0].feature, 'assistant');
    assert.match(usage.rows[0].model, /^gemini-/);
    assert.equal(usage.rows[0].input_tokens, 800);
    assert.equal(usage.rows[0].output_tokens, 40);
  });

  test('a function call round trip: the tool runs and its result is fed back as a functionResponse', async () => {
    const mock = mockGemini([
      geminiTurn([geminiText('Checking the price book.'), geminiCall('search_price_book', { query: 'receptacle' })]),
      geminiTurn([geminiText('Found a 15A decora receptacle at $45.00.')]),
    ]);
    const conv = await newConversation(A.token);
    const r = await say(A.token, conv.id, 'What receptacles are in the price book?');
    assert.equal(r.status, 200, JSON.stringify(r.events));
    assert.ok(r.events.some((e) => e.event === 'tool' && e.data.name === 'search_price_book' && e.data.status === 'running'));
    assert.ok(r.events.some((e) => e.event === 'tool' && e.data.name === 'search_price_book' && e.data.status === 'done'));
    assert.match(textOf(r.events), /45\.00/);
    assert.equal(mock.pending(), 0, 'both scripted turns were used');

    // Our tools were declared to Gemini on the first call.
    const decls = mock.calls[0].body.tools[0].functionDeclarations.map((d) => d.name);
    assert.ok(decls.includes('search_price_book') && decls.includes('find_records') && decls.includes('get_record'));
    // The second request carried our tool output back as a functionResponse keyed by name.
    const parts = mock.calls[1].body.contents.flatMap((c) => c.parts);
    const fr = parts.find((p) => p.functionResponse);
    assert.ok(fr, 'a functionResponse part was sent back');
    assert.equal(fr.functionResponse.name, 'search_price_book');
    assert.ok(JSON.stringify(fr.functionResponse.response).includes('15A decora receptacle'), 'price-book item in the response');
    // The model turn before it carried the functionCall.
    assert.ok(parts.some((p) => p.functionCall?.name === 'search_price_book'));

    // Two model calls -> two usage rows.
    const usage = await t.superPool.query('SELECT count(*)::int AS n FROM ai_usage WHERE tenant_id = $1 AND conversation_id = $2', [A.tenantId, conv.id]);
    assert.equal(usage.rows[0].n, 2);
  });

  test('HTTP errors map to friendly error events and never leak the key', async () => {
    const cases = [
      [401, 'ai_key_rejected'],
      [429, 'ai_rate_limited'],
      [400, 'ai_bad_request'],
      [404, 'ai_model_missing'],
      [500, 'ai_unavailable'],
    ];
    for (const [status, code] of cases) {
      mockGemini([geminiError(status, `boom ${GEMINI_KEY}`)]);
      const conv = await newConversation(A.token);
      const r = await say(A.token, conv.id, 'hello');
      const err = r.events.find((e) => e.event === 'error');
      assert.ok(err, `an error event for ${status}`);
      assert.equal(err.data.code, code, `status ${status} -> ${code}`);
      assert.ok(!JSON.stringify(r.events).includes(GEMINI_KEY), 'the key never appears in any event');
    }
    // After a mapped error the per-conversation lock is released, so the next message is accepted.
    mockGemini([geminiTurn([geminiText('ok now')])]);
    const conv = await newConversation(A.token);
    assert.equal((await say(A.token, conv.id, 'again')).status, 200);
  });
});
