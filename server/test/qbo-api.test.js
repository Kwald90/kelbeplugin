// QuickBooks routes (docs/integrations/quickbooks.md section 7, 10.2, 11.3 W3) through the real app:
// who may call (office only, admin for connect and disconnect, two-step sign-in for every change),
// plan and server gates, the connect pages, the webhook, status, records, mappings, conflicts, the
// log and look-ups, plus the leak rules (no token, realm id or ticket in any response or log line).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { skip, createTestDatabase } from './support/db.js';
import { createFakeQbo, connectViaFake } from './support/fake-qbo.js';
import { addMember, apiKey, call, enrolTotp, ownerTenant, startApp } from './support/app.js';
import { setFetch } from '../src/integrations/http.js';
import { createRecords } from '../src/services/records.js';
import { createValidator } from '../src/schemas.js';
import { refreshReference } from '../src/qbo/reference.js';
import { acquireLease, releaseLease } from '../src/qbo/lease.js';
import { syncTenant } from '../src/qbo/engine.js';
import { resetLookupCache } from '../src/qbo/lookup.js';
import { resetSignatureEvents } from '../src/qbo/webhook.js';

const fake = createFakeQbo();
const QBO_ENV = { QBO_ENVIRONMENT: 'sandbox', QBO_CLIENT_ID: fake.app.clientId, QBO_CLIENT_SECRET: fake.app.clientSecret, QBO_WEBHOOK_VERIFIER: 'verifier-api-test' };
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Winnipeg' });
let t, app, config, logs, records, deps;
let A, office, officeMfa, foreman, electrician, apprentice, key, crewToken, B;
let realmN = 0;
const realms = {};

async function connect(T) {
  const realmId = `55501000${String(++realmN).padStart(8, '0')}`;
  fake.addCompany(realmId, { name: `${T.name} Books` });
  const r = await connectViaFake(fake, { db: t.db, sealer: app.sealer, config, tenantId: T.tenantId, userId: T.userId, realmId });
  assert.equal(r.result, 'ok');
  await refreshReference(deps, T.tenantId, { force: true });
  realms[T.tenantId] = realmId;
  return realmId;
}
async function activate(T, options = {}) {
  const s = fake.seed(realms[T.tenantId]);
  const { rows } = await t.superPool.query('SELECT realm_hash FROM qbo_connections WHERE tenant_id = $1', [T.tenantId]);
  const maps = {
    item: { material: s.items.materials.Id, labour: s.items.labour.Id, other: s.items.materials.Id },
    taxCode: { 'GST+RST|MB': s.taxCodes.gstPst.Id, GST: s.taxCodes.gst.Id },
    account: { 'income.default': s.accounts.income.Id, 'expense.default': s.accounts.cogs.Id },
    option: { syncFrom: '2000-01-01', timeOwner: 'fishtape', ...options },
  };
  for (const [kind, kv] of Object.entries(maps)) for (const [k, v] of Object.entries(kv)) {
    await t.superPool.query(`INSERT INTO qbo_mappings (tenant_id, realm_hash, kind, key, value) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, kind, key) DO UPDATE SET value = EXCLUDED.value`, [T.tenantId, rows[0].realm_hash, kind, k, JSON.stringify(v)]);
  }
  await t.superPool.query(`UPDATE qbo_connections SET state = 'active', setup = '{"phase":"done"}'::jsonb, cdc_cursor = now() - interval '1 minute', time_cursor = now() WHERE tenant_id = $1`, [T.tenantId]);
}
async function pass(T) {
  await t.superPool.query("UPDATE qbo_outbox SET not_before = now() - interval '1 second', claimed_until = NULL WHERE tenant_id = $1", [T.tenantId]);
  const lease = await acquireLease(t.db, T.tenantId, 'test');
  try { return await syncTenant(deps, T.tenantId, { epoch: lease.epoch }); } finally { await releaseLease(t.db, T.tenantId, lease.epoch); }
}
const membershipOf = async (tenantId, userId) => (await t.superPool.query('SELECT id FROM memberships WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId])).rows[0].id;

before(async () => {
  if (skip) return;
  setFetch((u, i) => fake.fetch(u, i));
  t = await createTestDatabase('qboapi');
  ({ app, config, logs } = await startApp(t, { env: QBO_ENV }));
  records = createRecords({ validator: createValidator(), config });
  deps = { db: t.db, sealer: app.sealer, config, records };
  A = await ownerTenant(t, app, 'Alpha QBO Electric');
  A.name = 'Alpha';
  await call(app, { method: 'PUT', url: '/api/v1/settings/settings', token: A.token, body: { company: { name: 'Alpha', province: 'MB' } } });
  office = await addMember(t, app, A.tenantId, { role: 'office' });
  officeMfa = await addMember(t, app, A.tenantId, { role: 'office' });
  await enrolTotp(app, officeMfa.token);
  foreman = await addMember(t, app, A.tenantId, { role: 'foreman' });
  electrician = await addMember(t, app, A.tenantId, { role: 'electrician' });
  apprentice = await addMember(t, app, A.tenantId, { role: 'apprentice' });
  key = await apiKey(app, A.token, ['*:write']);
  // A crew (PIN) session of the owner on a shared device: still not an office session.
  const d = await call(app, { method: 'POST', url: '/api/v1/devices', token: A.token, body: { name: 'Shop iPad' } });
  await call(app, { method: 'PUT', url: `/api/v1/members/${await membershipOf(A.tenantId, A.userId)}/pin`, token: A.token, body: { pin: '73051946' } });
  const crew = await call(app, { method: 'POST', url: '/api/v1/devices/crew/sign-in', headers: { 'x-fishtape-device': d.body.deviceToken }, body: { membershipId: await membershipOf(A.tenantId, A.userId), pin: '73051946', mode: 'bearer' } });
  crewToken = crew.body.token;
  await connect(A);
  await activate(A);
  B = await ownerTenant(t, app, 'Bravo QBO Electric');
  B.name = 'Bravo';
  await connect(B);
  await activate(B);
});
after(async () => { setFetch(null); await app?.close(); await t?.close(); });

const READS = [
  ['GET', '/api/v1/qbo/status'], ['GET', '/api/v1/qbo/setup/matches'], ['GET', '/api/v1/qbo/setup/plan'], ['GET', '/api/v1/qbo/records/status?collection=clients'],
  ['GET', '/api/v1/qbo/records/clients/c-1'], ['GET', '/api/v1/qbo/checks'], ['GET', '/api/v1/qbo/log'], ['GET', '/api/v1/qbo/mappings'],
  ['GET', '/api/v1/qbo/conflicts'], ['GET', '/api/v1/qbo/conflicts/00000000-0000-4000-8000-000000000000'], ['POST', '/api/v1/qbo/lookup/customers', { q: 'Da' }],
  ['GET', '/api/v1/qbo/lookup/customer/1'],
];
const WRITES = [
  ['POST', '/api/v1/qbo/pause', { paused: true }], ['POST', '/api/v1/qbo/sync', { direction: 'push' }], ['POST', '/api/v1/qbo/setup/scan'],
  ['PUT', '/api/v1/qbo/setup/matches', { choices: [] }], ['POST', '/api/v1/qbo/setup/apply', {}], ['POST', '/api/v1/qbo/setup/cancel'],
  ['POST', '/api/v1/qbo/records/clients/c-1/sync', {}], ['POST', '/api/v1/qbo/records/invoices/i-1/renumber'], ['PUT', '/api/v1/qbo/records/clients/c-1/link', { qboId: '1' }],
  ['DELETE', '/api/v1/qbo/records/clients/c-1/link'], ['PUT', '/api/v1/qbo/mappings', { set: [] }], ['POST', '/api/v1/qbo/reference/refresh'],
  ['POST', '/api/v1/qbo/conflicts/00000000-0000-4000-8000-000000000000/resolve', { choice: 'fishtape' }], ['POST', '/api/v1/qbo/lookup/customer/1/import'],
];
const ADMIN = [['POST', '/api/v1/qbo/connect', { returnTo: 'web' }], ['POST', '/api/v1/qbo/disconnect', { purge: false }], ['POST', '/api/v1/qbo/connect/takeover', { confirm: true }]];

describe('who may call (7.1, 10.2)', { skip }, () => {
  test('field roles, crew sessions and API keys get 403 from every QuickBooks route', async () => {
    for (const [method, url, body] of [...READS, ...WRITES, ...ADMIN]) {
      for (const [who, token] of [['foreman', foreman.token], ['electrician', electrician.token], ['apprentice', apprentice.token], ['crew', crewToken], ['api key', key]]) {
        const r = await call(app, { method, url, token, body });
        assert.equal(r.status, 403, `${who} ${method} ${url}: ${r.status} ${JSON.stringify(r.body)}`);
        assert.ok(!JSON.stringify(r.body).match(/realm|qbo_id/i), 'nothing about QuickBooks leaks');
      }
    }
  });

  test('office: reads without two-step sign-in, every change needs it (403 mfa_required); connect and disconnect are admin only', async () => {
    for (const [method, url, body] of READS) {
      const r = await call(app, { method, url, token: office.token, body });
      assert.notEqual(r.status, 403, `${method} ${url}: ${JSON.stringify(r.body)}`);
    }
    for (const [method, url, body] of WRITES) {
      const r = await call(app, { method, url, token: office.token, body });
      assert.equal(r.status, 403, `${method} ${url}`);
      assert.equal(r.body.error.code, 'mfa_required', `${method} ${url}`);
    }
    for (const [method, url, body] of ADMIN) {
      const r = await call(app, { method, url, token: officeMfa.token, body });
      assert.equal(r.status, 403, `${method} ${url}`);
      assert.equal(r.body.error.code, 'forbidden');
    }
    const ok = await call(app, { method: 'POST', url: '/api/v1/qbo/pause', token: officeMfa.token, body: { paused: false } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  test('the plan gate: below Pro every route but status and disconnect answers feature_not_in_plan', async () => {
    const C = await ownerTenant(t, app, 'Starter Electric');
    await t.superPool.query("UPDATE tenants SET plan = 'starter', trial_ends_at = now() - interval '1 day' WHERE id = $1", [C.tenantId]);
    const st = await call(app, { url: '/api/v1/qbo/status', token: C.token });
    assert.equal(st.status, 200);
    assert.equal(st.body.plan.entitled, false);
    for (const [method, url, body] of [...READS.filter(([, u]) => u !== '/api/v1/qbo/status'), ...WRITES, ['POST', '/api/v1/qbo/connect', { returnTo: 'web' }]]) {
      const r = await call(app, { method, url, token: C.token, body });
      assert.equal(r.status, 403, `${method} ${url}`);
      assert.equal(r.body.error.code, 'feature_not_in_plan', `${method} ${url}: ${JSON.stringify(r.body)}`);
    }
    const d = await call(app, { method: 'POST', url: '/api/v1/qbo/disconnect', token: C.token, body: {} });
    assert.equal(d.body.error.code, 'qbo_not_connected', 'disconnect is not plan-gated');
  });

  test('a server without QuickBooks: 503 from every route but status', async () => {
    const off = await startApp(t);
    try {
      const st = await call(off.app, { url: '/api/v1/qbo/status', token: A.token });
      assert.equal(st.status, 200);
      assert.equal(st.body.available, false);
      for (const [method, url, body] of [...READS.filter(([, u]) => u !== '/api/v1/qbo/status'), ...WRITES]) {
        const r = await call(off.app, { method, url, token: A.token, body });
        assert.equal(r.status, 503, `${method} ${url}`);
        assert.equal(r.body.error.code, 'qbo_unavailable');
      }
    } finally { await off.app.close(); }
  });
});

describe('connect pages and webhook (7.2, 7.3)', { skip }, () => {
  test('ticket, interstitial, start, callback: 302 only, the flow cookie, no realm or ticket anywhere', async () => {
    const C = await ownerTenant(t, app, 'Connect Route Electric');
    const realmId = '5550199900000001';
    fake.addCompany(realmId, { name: 'Connect Books' });
    const tk = await call(app, { method: 'POST', url: '/api/v1/qbo/connect', token: C.token, body: { returnTo: 'app' } });
    assert.equal(tk.status, 200, JSON.stringify(tk.body));
    const startUrl = new URL(tk.body.url);
    const ticket = startUrl.searchParams.get('ticket');
    const page = await app.inject({ method: 'GET', url: `${startUrl.pathname}${startUrl.search}` });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers['content-security-policy'], /form-action 'self'/);
    assert.match(page.body, /Connect Route Electric/);
    const post = await app.inject({ method: 'POST', url: '/api/v1/qbo/oauth/start', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `ticket=${ticket}` });
    assert.equal(post.statusCode, 302);
    const flow = post.cookies.find((c) => c.name === 'ft_qbo_flow');
    assert.ok(flow && flow.httpOnly && flow.path === '/api/v1/qbo/oauth');
    const back = await fake.authorize(post.headers.location, { realmId });
    const cb = new URL(back.url);
    const done = await app.inject({ method: 'GET', url: `${cb.pathname}${cb.search}`, cookies: { ft_qbo_flow: flow.value } });
    assert.equal(done.statusCode, 302);
    assert.equal(done.body, '');
    assert.match(done.headers.location, /\/api\/v1\/qbo\/oauth\/done\?result=ok$/);
    const cleared = done.cookies.find((c) => c.name === 'ft_qbo_flow');
    assert.ok(cleared && (cleared.maxAge === 0 || new Date(cleared.expires) < new Date()));
    const donePage = await app.inject({ method: 'GET', url: '/api/v1/qbo/oauth/done?result=ok' });
    assert.equal(donePage.statusCode, 200);
    assert.match(donePage.headers['content-security-policy'], /default-src 'none'/);
    for (const odd of ['constructor', 'toString', '__proto__']) {
      const r = await app.inject({ method: 'GET', url: `/api/v1/qbo/oauth/done?result=${odd}` });
      assert.equal(r.statusCode, 200, `${odd} shows the generic page`);
    }
    const st = await call(app, { url: '/api/v1/qbo/status', token: C.token });
    assert.equal(st.body.state, 'setup');
    assert.equal(st.body.companyName, 'Connect Books');
    const all = JSON.stringify([tk.body, st.body, done.headers, post.headers]) + logs.text();
    assert.ok(!all.includes(realmId), 'no realm id');
    assert.ok(!logs.text().includes(ticket), 'no ticket in logs');
    assert.ok(!all.includes(back.code), 'no code');
    const launch = await app.inject({ method: 'GET', url: '/api/v1/qbo/launch?connect=1' });
    assert.equal(launch.statusCode, 302);
    assert.match(launch.headers.location, /#\/quickbooks\?connect=1$/);
    const dis = await app.inject({ method: 'GET', url: '/api/v1/qbo/disconnected' });
    assert.equal(dis.statusCode, 200);
  });

  test('the webhook route: 401 on a bad signature, 200 and the dirty flag for a good one, raw body, no CSRF', async () => {
    resetSignatureEvents();
    const bad = await app.inject({ method: 'POST', url: '/api/v1/webhooks/qbo', headers: { 'content-type': 'application/json', 'intuit-signature': 'AAAA' }, payload: '[]' });
    assert.equal(bad.statusCode, 401);
    assert.equal(JSON.parse(bad.body).error.code, 'invalid_signature');
    const realmId = realms[A.tenantId];
    fake.company(realmId).events.length = 0;
    fake.create(realmId, 'Customer', { DisplayName: 'Webhook Person' });
    const h = fake.signedWebhook(realmId, QBO_ENV.QBO_WEBHOOK_VERIFIER);
    const ok = await app.inject({ method: 'POST', url: '/api/v1/webhooks/qbo', headers: { 'content-type': 'application/json', 'intuit-signature': h.signature }, payload: h.raw });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.deepEqual(JSON.parse(ok.body), { received: 1 });
    const dirty = (await t.superPool.query('SELECT dirty_at FROM qbo_connections WHERE tenant_id = $1', [A.tenantId])).rows[0].dirty_at;
    assert.ok(dirty);
    const other = (await t.superPool.query('SELECT dirty_at FROM qbo_connections WHERE tenant_id = $1', [B.tenantId])).rows[0].dirty_at;
    assert.equal(other, null, "the other tenant's connection is untouched");
  });
});

describe('records, log, mappings, conflicts (7.5 to 7.7)', { skip }, () => {
  test('status counts, record states and views, sync now with its rate cap, unlink and relink', async () => {
    await call(app, { method: 'POST', url: '/api/v1/clients', token: A.token, body: { id: 'c-api', name: 'Api Client', email: 'api@example.ca' } });
    await pass(A);
    const st = await call(app, { url: '/api/v1/qbo/records/status?collection=clients&ids=c-api', token: office.token });
    assert.equal(st.status, 200);
    assert.equal(st.body.data['c-api'].state, 'synced');
    assert.equal(st.body.data['c-api'].owner, 'both', "owner 'quickbooks' shows Edit in QuickBooks");
    const view = await call(app, { url: '/api/v1/qbo/records/clients/c-api', token: office.token });
    assert.equal(view.body.state.state, 'synced');
    // Retry / Send now: JSON, so the PWA reads it like the other 202s (7.5).
    const send = await call(app, { method: 'POST', url: '/api/v1/qbo/records/clients/c-api/sync', token: A.token, body: {} });
    assert.equal(send.status, 202, JSON.stringify(send.body));
    assert.deepEqual(send.body, { queued: true, state: 'synced' });
    assert.match(view.body.quickbooks.url, /^https:\/\/app\.sandbox\.qbo\.intuit\.com\/app\/customerdetail\?nameId=\d+$/);
    assert.ok(view.body.log.some((l) => l.action === 'create'));
    const s1 = await call(app, { method: 'POST', url: '/api/v1/qbo/sync', token: A.token, body: { direction: 'push' } });
    assert.equal(s1.status, 202);
    const s2 = await call(app, { method: 'POST', url: '/api/v1/qbo/sync', token: A.token, body: { direction: 'push' } });
    assert.equal(s2.status, 429);
    assert.equal(s2.body.error.code, 'qbo_throttled');
    assert.ok(s2.body.error.details.retryAfterS > 0);
    const un = await call(app, { method: 'DELETE', url: '/api/v1/qbo/records/clients/c-api/link', token: A.token });
    assert.equal(un.status, 200, JSON.stringify(un.body));
    assert.equal(un.body.state.state, 'unlinked');
    const qboId = (await t.superPool.query("SELECT qbo_id FROM qbo_links WHERE tenant_id = $1 AND record_id = 'c-api'", [A.tenantId])).rows[0].qbo_id;
    const other = fake.create(realms[A.tenantId], 'Customer', { DisplayName: 'Other Customer', PrimaryEmailAddr: { Address: 'api@example.ca' } });
    const re = await call(app, { method: 'PUT', url: '/api/v1/qbo/records/clients/c-api/link', token: A.token, body: { qboId: other.Id } });
    assert.equal(re.status, 200, JSON.stringify(re.body));
    assert.equal(re.body.state.state, 'conflict', 'B = null: the name differs');
    const taken = await call(app, { method: 'PUT', url: '/api/v1/qbo/records/clients/c-api/link', token: A.token, body: { qboId: '999999' } });
    assert.equal(taken.status, 404);
    assert.ok(qboId);
    const status = await call(app, { url: '/api/v1/qbo/status', token: office.token });
    assert.equal(status.body.state, 'active');
    assert.equal(status.body.counts.conflict, 1);
    assert.equal(status.body.writesEnabled, true);
    // 2.8: the filed-through date and province reach the mappings screen.
    assert.ok('taxFiledThrough' in status.body.features && 'province' in status.body.features, JSON.stringify(status.body.features));
    assert.ok(!JSON.stringify(status.body).includes(realms[A.tenantId]));
  });

  test('conflicts are listed, read and resolved through the API with the lease', async () => {
    const list = await call(app, { url: '/api/v1/qbo/conflicts?status=open', token: office.token });
    const c = list.body.data.find((x) => x.recordId === 'c-api');
    assert.ok(c, JSON.stringify(list.body));
    const one = await call(app, { url: `/api/v1/qbo/conflicts/${c.id}`, token: office.token });
    assert.equal(one.body.kind, 'fields');
    const bad = await call(app, { method: 'POST', url: `/api/v1/qbo/conflicts/${c.id}/resolve`, token: A.token, body: { choice: 'nope' } });
    assert.equal(bad.status, 400);
    const badCursor = await call(app, { url: '/api/v1/qbo/conflicts?cursor=2026-01-01T00:00:00Z%7Cx', token: office.token });
    assert.equal(badCursor.status, 400, 'a cursor id that is not a uuid is a 400, not a 500');
    // Paused by HQ (or by anyone): a choice that writes to QuickBooks waits for the resume (2.5).
    const prev = (await t.superPool.query('SELECT state, pause_reason FROM qbo_connections WHERE tenant_id = $1', [A.tenantId])).rows[0];
    await t.superPool.query("UPDATE qbo_connections SET state = 'paused', pause_reason = 'hq' WHERE tenant_id = $1", [A.tenantId]);
    const paused = await call(app, { method: 'POST', url: `/api/v1/qbo/conflicts/${c.id}/resolve`, token: A.token, body: { choice: 'quickbooks' } });
    // Relinking reads QuickBooks: refused while paused too.
    const relinkPaused = await call(app, { method: 'PUT', url: '/api/v1/qbo/records/clients/c-api/link', token: A.token, body: { qboId: '1' } });
    await t.superPool.query('UPDATE qbo_connections SET state = $2, pause_reason = $3 WHERE tenant_id = $1', [A.tenantId, prev.state, prev.pause_reason]);
    assert.equal(paused.status, 409);
    assert.equal(paused.body.error.code, 'qbo_paused', JSON.stringify(paused.body));
    assert.equal(relinkPaused.status, 409, JSON.stringify(relinkPaused.body));
    assert.equal(relinkPaused.body.error.code, 'qbo_paused');
    const r = await call(app, { method: 'POST', url: `/api/v1/qbo/conflicts/${c.id}/resolve`, token: A.token, body: { choice: 'quickbooks' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'resolved');
    const cl = (await t.superPool.query("SELECT data FROM clients WHERE tenant_id = $1 AND id = 'c-api'", [A.tenantId])).rows[0].data;
    assert.equal(cl.name, 'Other Customer', "QuickBooks' values written to Fishtape");
    // A held lease answers 409 qbo_busy after 10 seconds' wait; here the lease is free again.
    const log = await call(app, { url: '/api/v1/qbo/log?collection=clients&recordId=c-api', token: office.token });
    assert.ok(log.body.data.some((l) => l.action === 'resolve'));
  });

  test('mappings: ids checked against QuickBooks lists and types; a code claiming RST refused; options validated and locked', async () => {
    const s = fake.seed(realms[A.tenantId]);
    const get = await call(app, { url: '/api/v1/qbo/mappings', token: office.token });
    assert.equal(get.status, 200);
    assert.ok(get.body.choices.taxCodes.some((c) => c.name === 'GST/PST MB' && c.salesRates.length === 2));
    assert.equal(get.body.suggestions.taxCode['GST+RST|MB'], String(s.taxCodes.gstPst.Id));
    const put = (set) => call(app, { method: 'PUT', url: '/api/v1/qbo/mappings', token: A.token, body: { set } });
    assert.equal((await put([{ kind: 'purchaseTaxCode', key: 'GST+RST|MB', value: s.taxCodes.gstPst.Id }])).status, 400, 'claims RST back');
    assert.equal((await put([{ kind: 'purchaseTaxCode', key: 'GST+RST|MB', value: s.taxCodes.gst.Id }])).status, 200);
    assert.equal((await put([{ kind: 'taxCode', key: 'GST+RST|MB', value: s.taxCodes.old8.Id }])).status, 400, 'the 8% code');
    assert.equal((await put([{ kind: 'account', key: 'income.default', value: s.accounts.bank.Id }])).status, 400, 'a bank is not income');
    assert.equal((await put([{ kind: 'account', key: 'stripeClearing', value: s.accounts.stripe.Id }])).status, 200);
    assert.equal((await put([{ kind: 'option', key: 'stripeCutover', value: TODAY }])).status, 200);
    const opening = (await t.superPool.query("SELECT value FROM qbo_mappings WHERE tenant_id = $1 AND kind = 'option' AND key = 'stripeClearingOpeningCents'", [A.tenantId])).rows[0];
    assert.equal(opening?.value, 0, "the clearing account's balance at the cutover");
    assert.equal((await put([{ kind: 'option', key: 'syncFrom', value: 'yesterday' }])).status, 400);
    assert.equal((await put([{ kind: 'option', key: 'stripeVendorId', value: '1' }])).status, 400, 'engine-set options');
    assert.equal((await put([{ kind: 'item', key: 'material', value: '999999' }])).status, 400);
    // jobsAsSubCustomers is locked once a document went to QuickBooks.
    const made = await call(app, { method: 'POST', url: '/api/v1/invoices', token: A.token, body: { id: 'inv-api', number: 'INV-7001', clientId: 'c-api', issueDate: TODAY, status: 'sent', taxProvince: 'MB', taxTreatment: 'pst-all', taxes: [{ id: 'GST', label: 'GST', pct: 5, applies: { material: true, labour: true, other: true } }, { id: 'RST', label: 'RST', pct: 7, applies: { material: true, labour: true, other: true } }], taxPct: 12, lines: [{ description: 'Work', qty: 1, unitCents: 10000, kind: 'labour' }] } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    await pass(A);
    const locked = await put([{ kind: 'option', key: 'jobsAsSubCustomers', value: false }]);
    assert.equal(locked.status, 409, JSON.stringify(locked.body));
    assert.equal(locked.body.error.code, 'qbo_option_locked');
    // Removing an option is setting it back to its default: engine-set options cannot be removed.
    const rm = await call(app, { method: 'PUT', url: '/api/v1/qbo/mappings', token: A.token, body: { remove: [{ kind: 'option', key: 'stripeVendorId' }] } });
    assert.equal(rm.status, 400, JSON.stringify(rm.body));
    // Practice mode and Go live are owner or admin only (8.2): an office user may not set or remove writeMode.
    for (const body of [{ set: [{ kind: 'option', key: 'writeMode', value: 'shadow' }] }, { remove: [{ kind: 'option', key: 'writeMode' }] }]) {
      const r = await call(app, { method: 'PUT', url: '/api/v1/qbo/mappings', token: officeMfa.token, body });
      assert.equal(r.status, 403, JSON.stringify(r.body));
    }
    assert.equal((await t.superPool.query("SELECT count(*)::int AS n FROM qbo_mappings WHERE tenant_id = $1 AND kind = 'option' AND key = 'writeMode'", [A.tenantId])).rows[0].n, 0);
    assert.equal((await call(app, { method: 'PUT', url: '/api/v1/qbo/mappings', token: officeMfa.token, body: { set: [{ kind: 'option', key: 'pushDrafts', value: false }] } })).status, 200, 'other options stay office level');
    assert.equal((await put([{ kind: 'option', key: 'writeMode', value: 'live' }])).status, 200, 'the owner may');
    const audit = (await t.superPool.query("SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND action = 'qbo.mappings'", [A.tenantId])).rows[0].n;
    assert.ok(audit >= 2);
  });

  test('renumber gives a document the next free number above Fishtape and QuickBooks', async () => {
    fake.create(realms[A.tenantId], 'Invoice', { CustomerRef: { value: (await t.superPool.query("SELECT qbo_id FROM qbo_links WHERE tenant_id = $1 AND record_id = 'c-api'", [A.tenantId])).rows[0].qbo_id }, DocNumber: 'INV-7500', TxnDate: '2001-01-01', Line: [{ DetailType: 'SalesItemLineDetail', Amount: 1, SalesItemLineDetail: { ItemRef: { value: fake.seed(realms[A.tenantId]).items.labour.Id }, Qty: 1, UnitPrice: 1 } }] });
    const r = await call(app, { method: 'POST', url: '/api/v1/qbo/records/invoices/inv-api/renumber', token: A.token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.number, 'INV-7501');
  });
});

describe('look-ups (7.8)', { skip }, () => {
  test('searches go in POST bodies, wildcards are refused, results show links, import creates the record', async () => {
    resetLookupCache();
    const realmId = realms[A.tenantId];
    const cust = fake.create(realmId, 'Customer', { DisplayName: "Dana O'Neil", PrimaryEmailAddr: { Address: 'dana@example.ca' } });
    const r = await call(app, { method: 'POST', url: '/api/v1/qbo/lookup/customers', token: office.token, body: { q: "Dana O'N" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.length, 1);
    assert.equal(r.body.data[0].qboId, cust.Id);
    assert.equal(r.body.data[0].linked, null);
    for (const q of ['50%', 'a_b']) {
      const bad = await call(app, { method: 'POST', url: '/api/v1/qbo/lookup/customers', token: office.token, body: { q } });
      assert.equal(bad.status, 400, q);
    }
    const one = await call(app, { url: `/api/v1/qbo/lookup/customer/${cust.Id}`, token: office.token });
    assert.equal(one.body.name, "Dana O'Neil");
    const inv = fake.create(realmId, 'Invoice', { CustomerRef: { value: cust.Id }, DocNumber: 'Q-900', TxnDate: '2001-02-03', Line: [{ DetailType: 'SalesItemLineDetail', Amount: 100, SalesItemLineDetail: { ItemRef: { value: fake.seed(realmId).items.labour.Id }, Qty: 1, UnitPrice: 100, TaxCodeRef: { value: fake.seed(realmId).taxCodes.gst.Id } } }] });
    const imp = await call(app, { method: 'POST', url: `/api/v1/qbo/lookup/invoice/${inv.Id}/import`, token: A.token });
    assert.equal(imp.status, 200, JSON.stringify(imp.body));
    assert.equal(imp.body.collection, 'invoices');
    const made = (await t.superPool.query('SELECT data FROM invoices WHERE tenant_id = $1 AND id = $2', [A.tenantId, imp.body.id])).rows[0].data;
    assert.equal(made.number, 'Q-900');
    const cl = (await t.superPool.query('SELECT data FROM clients WHERE tenant_id = $1 AND id = $2', [A.tenantId, made.clientId])).rows[0].data;
    assert.equal(cl.name, "Dana O'Neil");
    resetLookupCache();
    const again = await call(app, { method: 'POST', url: '/api/v1/qbo/lookup/customers', token: office.token, body: { q: 'Dana' } });
    assert.deepEqual(again.body.data.find((c) => c.qboId === cust.Id).linked, { collection: 'clients', id: made.clientId });
  });
});

describe('field roles never see QuickBooks data (10.2)', { skip }, () => {
  test('a pull and record reads by an electrician carry no QBO keys and no QuickBooks Notes', async () => {
    const realmId = realms[A.tenantId];
    const l = (await t.superPool.query("SELECT qbo_id FROM qbo_links WHERE tenant_id = $1 AND record_id = 'c-api'", [A.tenantId])).rows[0];
    fake.edit(realmId, 'Customer', l.qbo_id, { Notes: 'SECRET-COLLECTIONS-NOTE' });
    await pass(A);
    const pull = await call(app, { url: '/api/v1/sync/pull?since=0&limit=1000', token: electrician.token });
    assert.equal(pull.status, 200);
    const text = JSON.stringify(pull.body);
    for (const bad of ['qbo', 'SyncToken', 'realm', 'SECRET-COLLECTIONS-NOTE', 'Fishtape ref']) assert.ok(!text.includes(bad), bad);
    const st = await call(app, { url: '/api/v1/qbo/status', token: electrician.token });
    assert.equal(st.status, 403);
  });
});

describe('reference lists keep only allow-listed fields (3.8, 10.2)', { skip }, () => {
  test('an Employee or Vendor keeps no birth date, address, SIN, bill rate, tax id or notes', async () => {
    const realmId = realms[A.tenantId];
    fake.create(realmId, 'Employee', { GivenName: 'Riley', FamilyName: 'Watt', DisplayName: 'Riley Watt', BirthDate: '1990-04-01', SSN: '046454286', BillRate: 95, PrimaryAddr: { Line1: '1 Home St' }, PrimaryEmailAddr: { Address: 'riley@example.ca' }, Notes: 'private' });
    fake.create(realmId, 'Vendor', { DisplayName: 'Guillevin', TaxIdentifier: '123456789', BillAddr: { Line1: '2 Supply Rd' }, Notes: 'net 30', PrimaryEmailAddr: { Address: 'ar@guillevin.example' } });
    await t.superPool.query('UPDATE qbo_connections SET ref_refreshed_at = NULL WHERE tenant_id = $1', [A.tenantId]);
    await refreshReference(deps, A.tenantId, { force: true });
    const allowed = {
      Employee: ['Id', 'DisplayName', 'GivenName', 'FamilyName', 'PrimaryEmailAddr', 'Active'],
      Vendor: ['Id', 'DisplayName', 'PrimaryEmailAddr', 'Active'],
      Account: ['Id', 'Name', 'AccountType', 'AccountSubType', 'Active', 'CurrentBalance'],
      Item: ['Id', 'Name', 'Type', 'Active'],
      TaxCode: ['Id', 'Name', 'Active', 'SalesTaxRateList', 'PurchaseTaxRateList'],
      TaxRate: ['Id', 'Name', 'RateValue', 'AgencyRef', 'Active', 'EffectiveTaxRate'],
      TaxAgency: ['Id', 'DisplayName', 'LastFileDate'],
      PaymentMethod: ['Id', 'Name', 'Active'], Term: ['Id', 'Name', 'Active', 'DueDays'],
    };
    const rows = (await t.superPool.query('SELECT kind, data FROM qbo_reference WHERE tenant_id = $1', [A.tenantId])).rows;
    assert.ok(rows.some((r) => r.kind === 'Employee' && r.data.DisplayName === 'Riley Watt'));
    for (const r of rows) for (const k of Object.keys(r.data)) assert.ok(allowed[r.kind]?.includes(k), `${r.kind}.${k} stored`);
    assert.ok(!JSON.stringify(rows).match(/046454286|1990-04-01|Home St|123456789|private|net 30/));
  });
});

describe('setup routes (7.4)', { skip }, () => {
  test('scan at most every 15 minutes; apply refused until the mappings are set', async () => {
    const C = await ownerTenant(t, app, 'Setup Route Electric');
    C.name = 'Setup';
    await connect(C);
    const s1 = await call(app, { method: 'POST', url: '/api/v1/qbo/setup/scan', token: C.token });
    assert.equal(s1.status, 202, JSON.stringify(s1.body));
    const s2 = await call(app, { method: 'POST', url: '/api/v1/qbo/setup/scan', token: C.token });
    assert.equal(s2.status, 429);
    const ap = await call(app, { method: 'POST', url: '/api/v1/qbo/setup/apply', token: C.token, body: {} });
    assert.equal(ap.status, 409);
    assert.equal(ap.body.error.code, 'setup_incomplete');
    assert.ok(ap.body.error.details.missing.some((m) => m.kind === 'item' && m.key === 'material'));
    const sync = await call(app, { method: 'POST', url: '/api/v1/qbo/sync', token: C.token, body: {} });
    assert.equal(sync.body.error.code, 'qbo_not_ready');
    // A finished scan waits for choices: the PWA stops polling on setup.finishedAt.
    const at = '2026-10-20T15:00:00.000Z';
    await t.superPool.query(`UPDATE qbo_connections SET setup = jsonb_build_object('phase', 'scanned', 'finishedAt', $2::text) WHERE tenant_id = $1`, [C.tenantId, at]);
    const st = await call(app, { url: '/api/v1/qbo/status', token: C.token });
    assert.equal(st.body.setup.phase, 'scanned');
    assert.equal(st.body.setup.finishedAt, at);
  });
});
