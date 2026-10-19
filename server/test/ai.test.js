// AI workstream: the assistant and CEC helper (streamed tool-use loop with a mocked
// Anthropic client), drafts that only change documents when a person accepts them, usage
// logging and the monthly cap, plan gates, tenant isolation and log hygiene.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { skip, createTestDatabase } from './support/db.js';
import { addMember, call, ownerTenant, startApp } from './support/app.js';
import { authError, mockAnthropic, restoreAnthropic, sse, text, toolUse, turn } from './support/anthropic-mock.js';
import { CEC_TOOLS } from '../src/ai/tools/cec.js';
import { historyContent } from '../src/ai/chat.js';
import { costMicroUsd } from '../src/ai/usage.js';
import { validateInput } from '../src/ai/validate.js';
import { setSecret } from '../src/services/secrets.js';
import { requestParams } from '../src/ai/client.js';
import { readAiConfig } from '../src/ai/config.js';

let t, app, logs, A, B, office;
const KEY_A = 'sk-ant-api03-companyA-test-key-AAAA';
const SECRET_PHRASE = 'Zanzibar-7731 panel swap';
const ids = {};

async function seedCompany(token, prefix, province = 'ON') {
  await call(app, { method: 'POST', url: '/api/v1/settings', token, body: { id: 'settings', company: { name: `${prefix} Electric`, province }, labourRateCents: 10000, nextNumbers: { job: 1001, estimate: 2001, invoice: 3001 } } });
  const item = (await call(app, { method: 'POST', url: '/api/v1/items', token, body: { sku: `${prefix}-REC15`, name: '15A decora receptacle, supplied and installed', category: 'Devices', unit: 'ea', costCents: 300, priceCents: 4500, labourHours: 0.4, reorderPoint: 0, stock: {} } })).body;
  const client = (await call(app, { method: 'POST', url: '/api/v1/clients', token, body: { name: `${prefix} Homeowner`, email: `${prefix.toLowerCase()}@example.test` } })).body;
  const job = (await call(app, { method: 'POST', url: '/api/v1/jobs', token, body: { number: 'J-1001', title: `${prefix} basement finish`, clientId: client.id, status: 'in-progress', changeOrders: [] } })).body;
  return { item, client, job };
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
  t = await createTestDatabase('ai');
  ({ app, logs } = await startApp(t));
  A = await ownerTenant(t, app, 'Alpha Wiring Ltd');
  B = await ownerTenant(t, app, 'Bravo Power Inc');
  Object.assign(ids, { A: await seedCompany(A.token, 'Alpha'), B: await seedCompany(B.token, 'Bravo', 'BC') });
  // The key is stored the way the integrations workstream stores it (services/secrets.js).
  await t.db.withTenant({ tenantId: A.tenantId }, (tx) => setSecret(tx, app.sealer, 'anthropic.api_key', KEY_A));
  office = await addMember(t, app, A.tenantId, { role: 'office' });
});
after(async () => { restoreAnthropic(); await app?.close(); await t?.close(); });

describe('connection and plan', { skip }, () => {
  test('no Anthropic key: a friendly "connect Anthropic" error before any model call', async () => {
    const mock = mockAnthropic([turn([text('should not run')])]);
    const conv = await newConversation(B.token);
    const r = await say(B.token, conv.id, 'Hello');
    assert.equal(r.status, 409);
    assert.equal(r.error.code, 'ai_not_connected');
    assert.match(r.error.message, /Connect Anthropic in Integrations/);
    assert.equal(r.error.details.integration, 'anthropic');
    assert.equal(mock.calls.length, 0);
    const s = await call(app, { url: '/api/v1/ai/status', token: B.token });
    assert.equal(s.body.connected, false);
    assert.equal(JSON.stringify(s.body).includes('sk-ant'), false);
  });

  test('status reports the key as connected without revealing it', async () => {
    const s = await call(app, { url: '/api/v1/ai/status', token: A.token });
    assert.equal(s.status, 200);
    assert.equal(s.body.connected, true);
    assert.deepEqual(s.body.features, { assistant: true, cec: true, background: true, mcp: true });
    assert.ok(!JSON.stringify(s.body).includes(KEY_A));
  });

  test('plans without AI are refused (assistant, CEC helper, background run); HQ overrides apply', async () => {
    await t.superPool.query("UPDATE tenants SET plan = 'pro' WHERE id = $1", [B.tenantId]);
    try {
      for (const mode of ['assistant', 'cec']) {
        const r = await call(app, { method: 'POST', url: '/api/v1/ai/conversations', token: B.token, body: { mode } });
        assert.equal(r.status, 403);
        assert.equal(r.body.error.code, 'feature_not_in_plan');
        assert.equal(r.body.error.details.plan, 'business');
      }
      const bg = await call(app, { method: 'POST', url: '/api/v1/ai/background/run', token: B.token });
      assert.equal(bg.body.error.code, 'feature_not_in_plan');
      await t.superPool.query(`UPDATE tenants SET plan_overrides = '{"ai.cec": true}' WHERE id = $1`, [B.tenantId]);
      assert.equal((await call(app, { method: 'POST', url: '/api/v1/ai/conversations', token: B.token, body: { mode: 'cec' } })).status, 201);
      assert.equal((await call(app, { method: 'POST', url: '/api/v1/ai/conversations', token: B.token, body: { mode: 'assistant' } })).status, 403);
    } finally {
      await t.superPool.query("UPDATE tenants SET plan = 'trial', plan_overrides = '{}' WHERE id = $1", [B.tenantId]);
    }
  });

  test('API keys cannot use the chat endpoints', async () => {
    const k = await call(app, { method: 'POST', url: '/api/v1/api-keys', token: A.token, body: { name: 'agent', scopes: ['*:read'] } });
    const r = await call(app, { method: 'POST', url: '/api/v1/ai/conversations', token: k.body.key, body: {} });
    assert.equal(r.status, 403);
  });
});

describe('assistant turns', { skip }, () => {
  test('streams text and tool steps, uses the company key, caches the prefix and logs usage per call', async () => {
    const mock = mockAnthropic([
      turn([text('Checking the price book.'), toolUse('search_price_book', { query: 'receptacle' })]),
      (params) => {
        const results = params.messages.at(-1).content;
        assert.equal(results[0].type, 'tool_result');
        assert.match(results[0].content, /15A decora receptacle/);
        return turn([text(`The ${SECRET_PHRASE} needs 4 receptacles at $45.00 each.`)], { usage: { cache_read_input_tokens: 900 } });
      },
    ]);
    const conv = await newConversation(A.token);
    const r = await say(A.token, conv.id, `Price the ${SECRET_PHRASE} for me`);
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/event-stream/);
    assert.equal(r.headers['cache-control'], 'no-store');
    const names = r.events.map((e) => e.event);
    assert.equal(names[0], 'start');
    assert.equal(names.at(-1), 'done');
    assert.ok(r.events.some((e) => e.event === 'tool' && e.data.name === 'search_price_book' && e.data.status === 'done'));
    assert.match(textOf(r.events), /4 receptacles/);
    assert.deepEqual(mock.keys, [KEY_A, KEY_A].slice(0, mock.keys.length));
    assert.ok(mock.keys.every((k) => k === KEY_A));

    const p = mock.calls[0];
    assert.equal(p.model, 'claude-opus-5-5');
    assert.equal(p.thinking.type, 'adaptive');
    assert.equal(p.output_config.effort, 'medium');
    assert.equal(p.fallbacks, 'default');
    assert.ok(p.betas.includes('server-side-fallback-2026-07-01'));
    assert.deepEqual(p.cache_control, { type: 'ephemeral' });
    assert.deepEqual(p.system[0].cache_control, { type: 'ephemeral' });
    assert.match(p.system[1].text, /Ontario \(ON\)/);
    assert.equal(p.tool_choice, undefined, 'never forces tool use');
    const toolNames = p.tools.map((x) => x.name);
    assert.deepEqual(toolNames, [...toolNames].sort(), 'tools sorted for a stable cached prefix');
    assert.ok(p.tools.every((x) => x.eager_input_streaming === true));
    // The second call replays the first turn byte-for-byte (append-only history).
    assert.deepEqual(mock.calls[1].messages.slice(0, 2), [p.messages[0], { role: 'assistant', content: [text('Checking the price book.'), { type: 'tool_use', id: mock.calls[1].messages[1].content[1].id, name: 'search_price_book', input: { query: 'receptacle' } }] }]);
    assert.deepEqual(mock.calls[1].system, p.system);
    assert.deepEqual(mock.calls[1].tools, p.tools);

    const usage = await t.superPool.query('SELECT feature, model, input_tokens, output_tokens, cache_read_tokens, cost_micro_usd, actor FROM ai_usage WHERE tenant_id = $1 AND conversation_id = $2 ORDER BY id', [A.tenantId, conv.id]);
    assert.equal(usage.rows.length, 2);
    assert.equal(usage.rows[0].feature, 'assistant');
    assert.equal(usage.rows[0].actor, `user:${A.userId}`);
    assert.equal(usage.rows[1].cache_read_tokens, 900);
    assert.equal(Number(usage.rows[0].cost_micro_usd), costMicroUsd('claude-opus-5-5', { input_tokens: 1200, output_tokens: 150 }));

    const view = await call(app, { url: `/api/v1/ai/conversations/${conv.id}`, token: A.token });
    assert.equal(view.body.messages.length, 3);
    assert.equal(view.body.messages[1].tools[0].status, 'done');
  });

  test('a draft never changes estimates until a person accepts it', async () => {
    const before = (await call(app, { url: '/api/v1/estimates', token: A.token })).body.data.length;
    mockAnthropic([
      turn([toolUse('draft_estimate_lines', { title: 'Basement receptacles', clientId: ids.A.client.id, jobId: ids.A.job.id, lines: [{ itemId: ids.A.item.id, qty: 4, unitCents: 1 }, { kind: 'labour', description: 'Run new home run', qty: 2 }, { description: 'Permit fee allowance', kind: 'other', qty: 1, unitCents: 15000 }] })]),
      turn([text('Drafted. Review it below.')]),
    ]);
    const conv = await newConversation(A.token);
    const r = await say(A.token, conv.id, 'Draft an estimate for 4 receptacles and a home run');
    const draftEv = r.events.find((e) => e.event === 'draft');
    assert.ok(draftEv, 'a draft event was streamed');
    const d = draftEv.data;
    assert.equal(d.status, 'proposed');
    assert.equal(d.proposal.mode, 'new');
    const [rec, labour, other] = d.proposal.lines;
    assert.deepEqual([rec.unitCents, rec.source], [4500, 'price_book'], 'price book wins over the model');
    assert.deepEqual([labour.unitCents, labour.source], [10000, 'labour_rate']);
    assert.equal(other.source, 'ai_estimate');
    // 4 x 45.00 + 2 x 100.00 + 150.00 = 530.00; Ontario HST 13% = 68.90
    assert.equal(d.proposal.after.subtotalCents, 53000);
    assert.equal(d.proposal.after.taxCents, 6890);
    assert.equal(d.proposal.after.totalCents, 59890);
    assert.match(d.proposal.tax.description, /HST 13%/);
    assert.ok(d.proposal.warnings.some((w) => /price-book price/.test(w)));

    assert.equal((await call(app, { url: '/api/v1/estimates', token: A.token })).body.data.length, before, 'no estimate yet');
    const audit = await t.superPool.query("SELECT actor_type, actor_id FROM audit_events WHERE tenant_id = $1 AND action = 'ai.draft_create' AND record_id = $2", [A.tenantId, d.id]);
    assert.equal(audit.rows[0].actor_type, 'agent');

    const ok = await call(app, { method: 'POST', url: `/api/v1/ai/drafts/${d.id}/accept`, token: A.token });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.draft.status, 'accepted');
    const est = ok.body.record;
    assert.equal(est.status, 'draft');
    assert.equal(est.number, 'E-2001');
    assert.equal(est.lines.length, 3);
    assert.equal(est.lines[0].source, undefined, 'review-only fields are not stored on the estimate');
    assert.equal(est.clientId, ids.A.client.id);
    assert.equal((await call(app, { url: '/api/v1/estimates', token: A.token })).body.data.length, before + 1);
    const settings = (await call(app, { url: '/api/v1/settings/settings', token: A.token })).body;
    assert.equal(settings.nextNumbers.estimate, 2002);
    const again = await call(app, { method: 'POST', url: `/api/v1/ai/drafts/${d.id}/accept`, token: A.token });
    assert.equal(again.status, 409);
    const acceptAudit = await t.superPool.query("SELECT actor_type FROM audit_events WHERE tenant_id = $1 AND action = 'ai.draft_accept' AND record_id = $2", [A.tenantId, est.id]);
    assert.equal(acceptAudit.rows[0].actor_type, 'user');

    // Lines for an existing estimate: if the estimate changes after the draft, accepting fails and nothing is written.
    mockAnthropic([turn([toolUse('draft_estimate_lines', { estimateId: est.id, lines: [{ itemId: ids.A.item.id, qty: 2 }] })]), turn([text('Added.')])]);
    const r2 = await say(A.token, conv.id, 'Add two more receptacles');
    const d2 = r2.events.find((e) => e.event === 'draft').data;
    assert.equal(d2.proposal.mode, 'append');
    assert.equal(d2.proposal.before.totalCents, 59890);
    assert.equal(d2.proposal.after.totalCents, 59890 + Math.round(9000 * 1.13));
    await call(app, { method: 'PATCH', url: `/api/v1/estimates/${est.id}`, token: A.token, body: { title: 'Renamed meanwhile' } });
    const stale = await call(app, { method: 'POST', url: `/api/v1/ai/drafts/${d2.id}/accept`, token: A.token });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'version_conflict');
    assert.equal((await call(app, { url: `/api/v1/estimates/${est.id}`, token: A.token })).body.lines.length, 3);
    const dis = await call(app, { method: 'POST', url: `/api/v1/ai/drafts/${d2.id}/discard`, token: A.token });
    assert.equal(dis.body.status, 'discarded');
  });

  test('draft an invoice from a job: approved time at the labour rate, materials, change orders, provincial tax', async () => {
    const job = ids.A.job;
    await call(app, { method: 'PATCH', url: `/api/v1/jobs/${job.id}`, token: A.token, body: { changeOrders: [{ id: 'co-1', title: 'Extra pot lights', amountCents: 25000, status: 'approved' }, { id: 'co-2', title: 'Not yet', amountCents: 999, status: 'pending' }] } });
    await call(app, { method: 'POST', url: '/api/v1/timeEntries', token: A.token, body: { employeeId: 'emp-x', jobId: job.id, clockIn: '2026-10-01T08:00:00Z', clockOut: '2026-10-01T12:00:00Z', breakMins: 0, approved: true } });
    await call(app, { method: 'POST', url: '/api/v1/timeEntries', token: A.token, body: { employeeId: 'emp-x', jobId: job.id, clockIn: '2026-10-02T08:00:00Z', clockOut: '2026-10-02T10:00:00Z', breakMins: 0, approved: false } });
    await call(app, { method: 'POST', url: '/api/v1/stockMoves', token: A.token, body: { itemId: ids.A.item.id, jobId: job.id, qty: 3, date: '2026-10-01' } });
    const invoicesBefore = (await call(app, { url: '/api/v1/invoices', token: A.token })).body.data.length;
    mockAnthropic([turn([toolUse('draft_invoice_from_job', { jobId: job.id, basis: 'time_and_materials' })]), turn([text('Invoice drafted.')])]);
    const conv = await newConversation(A.token, { screen: { collection: 'jobs', id: job.id, label: 'J-1001' } });
    const r = await say(A.token, conv.id, 'Invoice this job');
    const d = r.events.find((e) => e.event === 'draft').data;
    const kinds = d.proposal.lines.map((l) => l.source);
    assert.deepEqual(kinds, ['time_entries', 'stock_moves', 'change_order']);
    assert.equal(d.proposal.lines[0].qty, 4, 'only approved hours');
    // 4 h x 100.00 + 3 x 45.00 + 250.00 = 785.00 + 13% HST
    assert.equal(d.proposal.after.subtotalCents, 78500);
    assert.equal(d.proposal.after.totalCents, 78500 + 10205);
    assert.ok(d.proposal.warnings.some((w) => /not approved/.test(w)));
    assert.equal((await call(app, { url: '/api/v1/invoices', token: A.token })).body.data.length, invoicesBefore);
    const ok = await call(app, { method: 'POST', url: `/api/v1/ai/drafts/${d.id}/accept`, token: A.token });
    assert.equal(ok.body.record.status, 'draft');
    assert.equal(ok.body.record.number, 'INV-3001');
    assert.equal(ok.body.record.lines.find((l) => l.changeOrderId === 'co-1').unitCents, 25000);
  });

  test('tools refuse other companies\' ids and never return their data', async () => {
    mockAnthropic([
      turn([
        toolUse('get_record', { collection: 'jobs', id: ids.B.job.id }),
        toolUse('draft_invoice_from_job', { jobId: ids.B.job.id }),
        toolUse('draft_estimate_lines', { lines: [{ itemId: ids.B.item.id, qty: 1 }], clientId: ids.B.client.id }),
      ]),
      (params) => {
        const results = params.messages.at(-1).content;
        assert.equal(results.length, 3, 'all parallel results in one message');
        assert.equal(results[0].is_error, true);
        assert.match(results[0].content, /Not found/);
        assert.equal(results[1].is_error, true);
        const draft = JSON.parse(results[2].content);
        assert.equal(draft.proposal.lines[0].source, 'unpriced');
        assert.equal(draft.proposal.clientId, null);
        for (const r of results) assert.ok(!r.content.includes('Bravo'), 'no data from the other company');
        return turn([text('I could not find that job.')]);
      },
    ]);
    const conv = await newConversation(A.token);
    const r = await say(A.token, conv.id, 'Look at job X');
    assert.ok(r.events.some((e) => e.event === 'tool' && e.data.status === 'error'));
    assert.equal(r.events.at(-1).event, 'done');
  });

  test('conversations are private to the person who started them', async () => {
    const conv = await newConversation(A.token);
    assert.equal((await call(app, { url: `/api/v1/ai/conversations/${conv.id}`, token: office.token })).status, 404);
    assert.equal((await call(app, { url: `/api/v1/ai/conversations/${conv.id}`, token: B.token })).status, 404);
    const r = await say(B.token, conv.id, 'hi');
    assert.equal(r.status, 404);
  });

  test('invalid tool input is refused before the tool runs; refusals are not stored', async () => {
    mockAnthropic([
      turn([toolUse('find_records', { collection: 'drawings' })]),
      (params) => {
        const res = params.messages.at(-1).content[0];
        assert.equal(res.is_error, true);
        assert.match(res.content, /Invalid input at \/collection/);
        return turn([text('partial answer')], { stop: 'refusal' });
      },
    ]);
    const conv = await newConversation(A.token);
    const r = await say(A.token, conv.id, 'Show drawings');
    const err = r.events.find((e) => e.event === 'error');
    assert.equal(err.data.code, 'ai_refused');
    const msgs = await t.superPool.query('SELECT role FROM ai_messages WHERE conversation_id = $1 ORDER BY seq', [conv.id]);
    assert.deepEqual(msgs.rows.map((x) => x.role), ['user', 'assistant', 'user'], 'the refused turn was not stored');
  });

  test('a rejected key comes back as a friendly error event', async () => {
    mockAnthropic([authError()]);
    const conv = await newConversation(A.token);
    const r = await say(A.token, conv.id, 'hello');
    const err = r.events.find((e) => e.event === 'error');
    assert.equal(err.data.code, 'ai_key_rejected');
    assert.match(err.data.message, /Integrations/);
    // The lock is released, so the next message is accepted.
    mockAnthropic([turn([text('ok')])]);
    assert.equal((await say(A.token, conv.id, 'again')).status, 200);
  });

  test('the CEC helper runs calculators and answers with references', async () => {
    mockAnthropic([
      turn([toolUse('cec_voltage_drop', { volts: 240, amps: 30, lengthFt: 150, size: '10', material: 'cu' })]),
      (params) => {
        assert.ok(params.tools.every((x) => x.name.startsWith('cec_')), 'CEC mode only has calculators');
        const res = JSON.parse(params.messages.at(-1).content[0].content);
        assert.equal(res.lengthM, 45.7);
        assert.ok(res.references.includes('Rule 8-102'));
        assert.match(res.note, /authority having jurisdiction/);
        return turn([text('About 3.1% drop on 10 AWG: go to 8 AWG (Rule 8-102). Verify with your inspector.')]);
      },
    ]);
    const conv = await newConversation(A.token, { mode: 'cec', units: 'imperial' });
    const r = await say(A.token, conv.id, 'Voltage drop on 150 ft of 10 AWG at 30 A, 240 V?');
    assert.match(textOf(r.events), /Rule 8-102/);
    const ctx = await t.superPool.query('SELECT system_context FROM ai_conversations WHERE id = $1', [conv.id]);
    assert.match(ctx.rows[0].system_context, /imperial/);
  });
});

describe('usage and the monthly cap', { skip }, () => {
  test('usage is summed per company; at the cap new messages are refused', async () => {
    const set = await call(app, { method: 'PUT', url: '/api/v1/ai/settings', token: A.token, body: { monthlyCapCents: 1 } });
    assert.equal(set.status, 200);
    assert.equal(set.body.monthlyCapCents, 1);
    const r = await say(A.token, (await newConversation(A.token)).id, 'hello');
    assert.equal(r.status, 429);
    assert.equal(r.error.code, 'ai_cap_reached');
    const u = await call(app, { url: '/api/v1/ai/usage', token: A.token });
    assert.ok(u.body.month.calls >= 5);
    assert.ok(u.body.byFeature.some((f) => f.feature === 'cec'));
    assert.ok(u.body.month.costCents > 1);
    const other = await call(app, { url: '/api/v1/ai/status', token: B.token });
    assert.equal(other.body.usage.calls, 0, 'usage is per company');
    const office403 = await call(app, { method: 'PUT', url: '/api/v1/ai/settings', token: office.token, body: { monthlyCapCents: 99999 } });
    assert.equal(office403.status, 403, 'only owners and admins change the cap');
    await call(app, { method: 'PUT', url: '/api/v1/ai/settings', token: A.token, body: { monthlyCapCents: null } });
  });

  test('the cap is also checked between tool steps', async () => {
    await call(app, { method: 'PUT', url: '/api/v1/ai/settings', token: A.token, body: { monthlyCapCents: 100000 } });
    const conv = await newConversation(A.token);
    mockAnthropic([turn([toolUse('search_price_book', { query: 'x' })], { usage: { output_tokens: 60_000_000 } }), turn([text('never')])]);
    const r = await say(A.token, conv.id, 'expensive');
    const err = r.events.find((e) => e.event === 'error');
    assert.equal(err.data.code, 'ai_cap_reached');
    await call(app, { method: 'PUT', url: '/api/v1/ai/settings', token: A.token, body: { monthlyCapCents: 100_000_00 } });
  });
});

describe('tables', { skip }, () => {
  const TABLES = ['ai_settings', 'ai_conversations', 'ai_messages', 'ai_drafts', 'ai_suggestions', 'ai_usage', 'ai_agent_runs'];
  test('every AI table has RLS enabled and forced; without a tenant the app role sees nothing', async () => {
    const { rows } = await t.superPool.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = ANY($1)`, [TABLES]);
    assert.equal(rows.length, TABLES.length);
    for (const r of rows) assert.ok(r.relrowsecurity && r.relforcerowsecurity, r.relname);
    for (const tbl of TABLES) assert.equal((await t.appPool.query(`SELECT count(*)::int AS n FROM ${tbl}`)).rows[0].n, 0, tbl);
    const other = await t.db.withTenant({ tenantId: B.tenantId }, (tx) => tx.query('SELECT count(*)::int AS n FROM ai_usage'));
    assert.equal(other.rows[0].n, 0, 'company B cannot see company A usage');
  });

  test('usage rows are insert-only for the app role', async () => {
    await assert.rejects(t.db.withTenant({ tenantId: A.tenantId }, (tx) => tx.query('DELETE FROM ai_usage WHERE tenant_id = $1', [tx.tenantId])), /permission denied/);
    await assert.rejects(t.db.withTenant({ tenantId: A.tenantId }, (tx) => tx.query('UPDATE ai_usage SET cost_micro_usd = 0 WHERE tenant_id = $1', [tx.tenantId])), /permission denied/);
  });
});

describe('logs', { skip }, () => {
  test('server logs never contain message text, record contents or the key', () => {
    const text = logs.text();
    assert.ok(text.length > 1000);
    for (const s of [SECRET_PHRASE, KEY_A, 'Alpha Homeowner', 'alpha@example.test', '4 receptacles']) assert.ok(!text.includes(s), `logs contain ${s}`);
  });
});

describe('units (no database)', () => {
  test('history after a mid-output fallback keeps text and drops the declined attempt\'s thinking and tool calls', () => {
    const c = [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'Start' }, { type: 'tool_use', id: 't1', name: 'x', input: {} }, { type: 'fallback', from: {}, to: {} }, { type: 'text', text: 'Rest' }];
    assert.deepEqual(historyContent(c).map((b) => b.text), ['Start', 'Rest'], 'the fallback marker itself is dropped (an ignored audit marker)');
    assert.equal(historyContent([text('a')]).length, 1);
  });

  test('tool input validation names the field and never echoes the value', () => {
    const msg = validateInput(CEC_TOOLS.find((x) => x.name === 'cec_motor').input_schema, { hp: 'secret-value', volts: 575 });
    assert.match(msg, /\/hp/);
    assert.ok(!msg.includes('secret-value'));
  });

  test('CEC calculators give rule and table references from the app\'s data', () => {
    const run = (name, input) => { const tool = CEC_TOOLS.find((x) => x.name === name); assert.equal(validateInput(tool.input_schema, input), null); return tool.run({ context: { province: 'ON' } }, input); };
    const size = run('cec_conductor_size', { amps: 40 });
    assert.equal(size.size, '8 AWG');
    assert.ok(size.references.includes('Rule 14-104'));
    const fill = run('cec_conduit_fill', { conduitType: 'EMT', wires: [{ size: '12', insulation: 'T90 Nylon', count: 6 }] });
    assert.equal(fill.smallest, true);
    assert.ok(fill.pass);
    const box = run('cec_box_fill', { conductors: [{ size: '14', count: 6 }], devices: 1, boxId: 'dev-2.5' });
    assert.equal(box.conductorEquivalents, 8);
    assert.equal(box.pass, true);
    const load = run('cec_dwelling_load', { groundArea: 120, basementArea: 80, rangeW: 12000, otherW: [5000] });
    assert.ok(load.suggestedServiceAmps >= 100);
    assert.ok(load.lines.some((l) => l.rule.startsWith('Rule 8-200')));
    const m = run('cec_motor', { hp: '10', volts: 575, phase: 3 });
    assert.equal(m.fullLoadAmps, 11);
    assert.equal(m.table, 'Table 44');
    const info = run('cec_province_info', { province: 'ON', rule: '26-' });
    assert.equal(info.adoption.edition, 'CEC 2024');
    assert.ok(info.amendments.every((a) => a.rule.startsWith('Rule 26-')));
    for (const out of [size, fill, box, load, m, info]) assert.match(out.note, /authority having jurisdiction/);
  });

  test('request options follow the skill: adaptive thinking, explicit effort, fallbacks, no forced tool choice', () => {
    const cfg = readAiConfig({});
    const p = requestParams(cfg, { system: [], messages: [] });
    assert.equal(p.model, 'claude-opus-5-5');
    assert.equal(p.thinking.type, 'adaptive');
    assert.equal(p.output_config.effort, 'medium');
    assert.equal(p.fallbacks, 'default');
    assert.equal(p.tool_choice, undefined);
    assert.equal(p.temperature, undefined);
    const off = requestParams(readAiConfig({ AI_FALLBACKS: 'off', AI_THINKING_DISPLAY: 'omitted' }), { system: [], messages: [] });
    assert.equal(off.fallbacks, undefined);
    assert.equal(off.thinking.display, undefined);
  });
});
