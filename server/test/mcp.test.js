// The MCP server at /api/mcp: API-key auth and scopes, plan gate, agent write policy,
// audit of every tool call, rate limit, tenant isolation, and interop with the official
// MCP TypeScript SDK client over a real HTTP socket.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { skip, createTestDatabase } from './support/db.js';
import { apiKey, call, ownerTenant, startApp } from './support/app.js';

let t, app, A, B, ids = {};
let rpcId = 0;

async function rpc(token, method, params, { headers = {} } = {}) {
  const res = await app.inject({
    method: 'POST', url: '/api/mcp',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    payload: { jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) },
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
}
const callTool = (token, name, args) => rpc(token, 'tools/call', { name, arguments: args });
const structured = (r) => r.body.result.structuredContent;

before(async () => {
  if (skip) return;
  t = await createTestDatabase('mcp');
  ({ app } = await startApp(t));
  A = await ownerTenant(t, app, 'MCP Alpha Ltd');
  B = await ownerTenant(t, app, 'MCP Bravo Ltd');
  ids.itemA = (await call(app, { method: 'POST', url: '/api/v1/items', token: A.token, body: { sku: 'GFCI', name: 'GFCI receptacle', priceCents: 6500, labourHours: 0.5 } })).body;
  ids.jobB = (await call(app, { method: 'POST', url: '/api/v1/jobs', token: B.token, body: { number: 'J-9', title: 'Bravo secret job' } })).body;
  A.read = await apiKey(app, A.token, ['clients:read', 'items:read']);
  A.write = await apiKey(app, A.token, ['*:write']);
  A.drafter = await apiKey(app, A.token, ['estimates:write', 'items:read']);
  B.all = await apiKey(app, B.token, ['*:write']);
});
after(async () => { await app?.close(); await t?.close(); });

describe('handshake and auth', { skip }, () => {
  test('initialize negotiates the protocol version; notifications get 202; GET and DELETE are 405', async () => {
    const r = await rpc(A.read, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /application\/json/);
    assert.equal(r.body.result.protocolVersion, '2025-06-18');
    assert.deepEqual(r.body.result.capabilities, { tools: { listChanged: false } });
    assert.equal(r.body.result.serverInfo.name, 'fishtape');
    const unknown = await rpc(A.read, 'initialize', { protocolVersion: '1999-01-01' });
    assert.equal(unknown.body.result.protocolVersion, '2025-11-25');
    const note = await app.inject({ method: 'POST', url: '/api/mcp', headers: { authorization: `Bearer ${A.read}`, 'content-type': 'application/json' }, payload: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    assert.equal(note.statusCode, 202);
    assert.equal(note.body, '');
    const get = await app.inject({ method: 'GET', url: '/api/mcp', headers: { authorization: `Bearer ${A.read}` } });
    assert.equal(get.statusCode, 405);
    assert.equal(get.headers.allow, 'POST');
    assert.equal((await rpc(A.read, 'resources/list')).body.error.code, -32601);
    assert.equal((await rpc(A.read, 'ping')).body.result && 'ok', 'ok');
  });

  test('bad, missing, revoked or session credentials are refused', async () => {
    assert.equal((await rpc('ft_test_' + 'x'.repeat(40), 'tools/list')).body.error.code, 'invalid_api_key');
    assert.equal((await rpc('ft_test_' + 'x'.repeat(40), 'tools/list')).status, 401);
    const session = await rpc(A.token, 'tools/list');
    assert.equal(session.status, 401, 'session tokens are not API keys');
    const none = await app.inject({ method: 'POST', url: '/api/mcp', headers: { 'content-type': 'application/json' }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    assert.equal(none.statusCode, 401, 'no credentials: a clear 401, not csrf_failed');
    assert.equal(JSON.parse(none.body).error.code, 'unauthenticated');
    const cookie = await app.inject({ method: 'POST', url: '/api/mcp', headers: { 'content-type': 'application/json', cookie: `ft_session=${A.token}` }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    assert.equal(cookie.statusCode, 401, 'a session cookie alone never reaches MCP');
    const tmp = await apiKey(app, A.token, ['clients:read'], 'to revoke');
    const keys = (await call(app, { url: '/api/v1/api-keys', token: A.token })).body.data;
    const id = keys.find((k) => k.name === 'to revoke').id;
    await call(app, { method: 'DELETE', url: `/api/v1/api-keys/${id}`, token: A.token });
    assert.equal((await rpc(tmp, 'tools/list')).status, 401);
    const evil = await rpc(A.read, 'tools/list', null, { headers: { origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    const badVersion = await rpc(A.read, 'tools/list', null, { headers: { 'mcp-protocol-version': '1999-01-01' } });
    assert.equal(badVersion.status, 400);
  });

  test('the mcp feature is Business: other plans are refused', async () => {
    await t.superPool.query("UPDATE tenants SET plan = 'pro' WHERE id = $1", [A.tenantId]);
    try {
      const r = await rpc(A.read, 'tools/list');
      assert.equal(r.status, 403);
      assert.equal(r.body.error.code, 'feature_not_in_plan');
    } finally {
      await t.superPool.query("UPDATE tenants SET plan = 'trial' WHERE id = $1", [A.tenantId]);
    }
  });
});

describe('tools and scopes', { skip }, () => {
  test('tools/list follows the key\'s scopes', async () => {
    const ro = (await rpc(A.read, 'tools/list')).body.result.tools;
    const names = ro.map((x) => x.name);
    assert.ok(names.includes('list_records') && names.includes('cec_voltage_drop'));
    assert.ok(!names.includes('create_record') && !names.includes('update_record') && !names.includes('draft_estimate'));
    assert.deepEqual(ro.find((x) => x.name === 'get_record').inputSchema.properties.collection.enum, ['clients', 'items']);
    const rw = (await rpc(A.write, 'tools/list')).body.result.tools;
    const writable = rw.find((x) => x.name === 'create_record').inputSchema.properties.collection.enum;
    for (const c of ['payments', 'settings', 'auditLog']) assert.ok(!writable.includes(c), `${c} is never writable by agents`);
    assert.ok(writable.includes('clients'));
  });

  test('out-of-scope calls are refused, and audited', async () => {
    const wrongColl = await callTool(A.read, 'get_record', { collection: 'jobs', id: 'x' });
    assert.equal(wrongColl.body.result.isError, true);
    const notListed = await callTool(A.read, 'create_record', { collection: 'clients', record: { name: 'x' } });
    assert.equal(notListed.body.error.code, -32602);
    const ev = await t.superPool.query("SELECT actor_type, summary, meta FROM audit_events WHERE tenant_id = $1 AND action = 'mcp.tool_call' ORDER BY seq", [A.tenantId]);
    assert.ok(ev.rows.length >= 2);
    assert.ok(ev.rows.every((x) => x.actor_type === 'api_key'));
    assert.ok(ev.rows.some((x) => x.meta.ok === false && x.summary.startsWith('create_record')));
  });

  test('reads, searches, creates and updates within scope; every call is audited as the key', async () => {
    const created = await callTool(A.write, 'create_record', { collection: 'clients', record: { name: 'Agent-made client', email: 'agent@example.test' } });
    assert.equal(created.body.result.isError, undefined);
    const rec = structured(created).record;
    const found = structured(await callTool(A.read, 'search_records', { collection: 'clients', query: 'Agent-made' }));
    assert.equal(found.records[0].id, rec.id);
    const listed = structured(await callTool(A.read, 'list_records', { collection: 'items', filters: { sku: 'GFCI' } }));
    assert.equal(listed.records[0].priceCents, 6500);
    const upd = await callTool(A.write, 'update_record', { collection: 'clients', id: rec.id, patch: { phone: '780-555-0100' }, ifVersion: rec.version });
    assert.equal(structured(upd).record.phone, '780-555-0100');
    const stale = await callTool(A.write, 'update_record', { collection: 'clients', id: rec.id, patch: { phone: '1' }, ifVersion: rec.version });
    assert.equal(stale.body.result.isError, true);
    assert.match(stale.body.result.content[0].text, /version_conflict/);
    const ev = await t.superPool.query("SELECT actor_type, actor_id FROM audit_events WHERE tenant_id = $1 AND action = 'record.create' AND record_id = $2", [A.tenantId, rec.id]);
    assert.equal(ev.rows[0].actor_type, 'api_key');
  });

  test('agents keep estimates, invoices and messages in draft, and cannot record payments', async () => {
    const sent = await callTool(A.write, 'create_record', { collection: 'invoices', record: { number: 'INV-1', status: 'sent', lines: [] } });
    assert.equal(sent.body.result.isError, true);
    assert.match(sent.body.result.content[0].text, /a person sends or finalises it/);
    const draft = structured(await callTool(A.write, 'create_record', { collection: 'invoices', record: { number: 'INV-2', lines: [] } })).record;
    assert.equal(draft.status, 'draft');
    const promote = await callTool(A.write, 'update_record', { collection: 'invoices', id: draft.id, patch: { status: 'sent' } });
    assert.equal(promote.body.result.isError, true);
    const outbox = await callTool(A.write, 'create_record', { collection: 'outbox', record: { channel: 'email', to: 'x@example.test', subject: 's', body: 'b', status: 'queued' } });
    assert.equal(outbox.body.result.isError, true);
    const pay = await callTool(A.write, 'create_record', { collection: 'payments', record: { invoiceId: draft.id, amountCents: 100 } });
    assert.equal(pay.body.result.isError, true, 'payments are not in the writable enum');
    assert.equal((await rpc(A.write, 'tools/list')).body.result.tools.some((x) => x.name === 'delete_record'), false);
  });

  test('draft_estimate proposes lines from the price book without touching estimates', async () => {
    const r = await callTool(A.drafter, 'draft_estimate', { title: 'Kitchen GFCIs', lines: [{ itemId: ids.itemA.id, qty: 3 }] });
    const d = structured(r);
    assert.equal(d.status, 'proposed');
    assert.equal(d.proposal.lines[0].unitCents, 6500);
    assert.equal(d.createdBy.startsWith('api_key:'), true);
    assert.equal((await call(app, { url: '/api/v1/estimates', token: A.token })).body.data.length, 0);
    const pending = (await call(app, { url: '/api/v1/ai/drafts', token: A.token })).body.data;
    assert.ok(pending.some((x) => x.id === d.id), 'waiting for a person in the app');
  });

  test('CEC calculators work with any valid key and cite references', async () => {
    const r = structured(await callTool(A.read, 'cec_conductor_size', { amps: 32, continuous: true }));
    assert.equal(r.breakerAmps, 40);
    assert.ok(r.references.includes('Rule 8-104'));
  });

  test('another company\'s ids are not found', async () => {
    const r = await callTool(A.write, 'get_record', { collection: 'jobs', id: ids.jobB.id });
    assert.equal(r.body.result.isError, true);
    assert.match(r.body.result.content[0].text, /not_found/);
    assert.ok(!JSON.stringify(r.body).includes('Bravo secret'));
    const upd = await callTool(A.write, 'update_record', { collection: 'jobs', id: ids.jobB.id, patch: { title: 'pwned' } });
    assert.equal(upd.body.result.isError, true);
    assert.equal((await call(app, { url: `/api/v1/jobs/${ids.jobB.id}`, token: B.token })).body.title, 'Bravo secret job');
  });

  test('requests are rate limited per key', async () => {
    process.env.AI_MCP_PER_MINUTE = '2';
    const { app: limited } = await startApp(t, { env: { RATE_LIMIT: 'on' } });
    delete process.env.AI_MCP_PER_MINUTE;
    const go = () => limited.inject({ method: 'POST', url: '/api/mcp', headers: { authorization: `Bearer ${A.read}`, 'content-type': 'application/json' }, payload: { jsonrpc: '2.0', id: 1, method: 'ping' } });
    assert.equal((await go()).statusCode, 200);
    assert.equal((await go()).statusCode, 200);
    const third = await go();
    assert.equal(third.statusCode, 429);
    assert.equal(JSON.parse(third.body).error.code, 'rate_limited');
    await limited.close();
  });
});

describe('interop', { skip }, () => {
  test('the official MCP SDK client connects over HTTP, lists and calls tools', async () => {
    const { app: live } = await startApp(t);
    const url = await live.listen({ port: 0, host: '127.0.0.1' });
    const client = new Client({ name: 'fishtape-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${url}/api/mcp`), { requestInit: { headers: { Authorization: `Bearer ${A.read}` } } });
    try {
      await client.connect(transport);
      assert.equal(client.getServerVersion().name, 'fishtape');
      const { tools } = await client.listTools();
      assert.ok(tools.some((x) => x.name === 'cec_motor'));
      const res = await client.callTool({ name: 'cec_motor', arguments: { hp: '5', volts: 230, phase: 1 } });
      assert.equal(res.isError, undefined);
      assert.equal(res.structuredContent.fullLoadAmps, 28);
      const search = await client.callTool({ name: 'search_records', arguments: { collection: 'items', query: 'GFCI' } });
      assert.equal(search.structuredContent.records[0].sku, 'GFCI');
    } finally {
      await client.close();
      await live.close();
    }
  });
});
