// The data leakage rule (docs/BUILD-PLAN.md): no customer details or secrets in response
// headers, URLs, error messages or logs; no-store on API responses; public health
// endpoints reveal nothing tenant-specific.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { skip, createTestDatabase } from './support/db.js';
import { call, ownerTenant, startApp } from './support/app.js';
import { hqUser, startHqApp } from './support/hq.js';
import { createFakeQbo } from './support/fake-qbo.js';
import { setFetch } from '../src/integrations/http.js';
import { createRecords } from '../src/services/records.js';
import { createValidator } from '../src/schemas.js';
import { enqueue, runOnce } from '../src/services/queue.js';
import { refreshReference } from '../src/qbo/reference.js';
import { createQboHandlers } from '../src/qbo/jobs.js';

let t, app, A, client;
const PII = { name: 'Jenna Leakwood', email: 'jenna.leak@example.com', phone: '780-555-0199' };

before(async () => {
  if (skip) return;
  t = await createTestDatabase('leaks');
  ({ app } = await startApp(t));
  A = await ownerTenant(t, app, 'Leakproof Electric Ltd');
  client = (await call(app, { method: 'POST', url: '/api/v1/clients', token: A.token, body: { ...PII, notes: 'Gate code 4471' } })).body;
});
after(async () => { await app?.close(); await t?.close(); });

const sensitive = () => [PII.name, PII.email, PII.phone, 'Leakproof Electric', A.email, A.tenantId, 'Gate code'];

function assertCleanHeaders(res, label) {
  for (const [k, v] of Object.entries(res.headers)) {
    if (k === 'set-cookie') continue;
    for (const s of sensitive()) assert.ok(!String(v).includes(s), `${label}: header ${k} contains ${s}`);
  }
  assert.equal(res.headers['x-powered-by'], undefined, `${label}: x-powered-by`);
  assert.equal(res.headers['cache-control'], 'no-store', `${label}: cache-control`);
  assert.ok(res.headers['x-request-id'], `${label}: x-request-id`);
}

describe('headers', { skip }, () => {
  test('responses carry no customer data in headers, no X-Powered-By, and no-store', async () => {
    const samples = {
      record: await call(app, { url: `/api/v1/clients/${client.id}`, token: A.token }),
      list: await call(app, { url: '/api/v1/clients', token: A.token }),
      me: await call(app, { url: '/api/v1/me', token: A.token }),
      pull: await call(app, { url: '/api/v1/sync/pull?since=0', token: A.token }),
      created: await call(app, { method: 'POST', url: '/api/v1/clients', token: A.token, body: PII }),
      notFound: await call(app, { url: '/api/v1/clients/nope', token: A.token }),
      unauthenticated: await call(app, { url: '/api/v1/clients' }),
      invalid: await call(app, { method: 'POST', url: '/api/v1/clients', token: A.token, body: { name: 5 } }),
      status: await call(app, { url: '/api/v1/status' }),
      readyz: await call(app, { url: '/api/readyz' }),
      unknownRoute: await call(app, { url: '/api/v1/whatever' }),
    };
    for (const [label, res] of Object.entries(samples)) assertCleanHeaders(res, label);
    assert.equal(samples.record.body.email, PII.email, 'the body itself is fine');
  });

  test('a cookie login only sets the session cookie', async () => {
    const r = await call(app, { method: 'POST', url: '/api/v1/auth/login', body: { email: A.email, password: A.password } });
    assertCleanHeaders(r, 'login');
    const cookies = r.cookies.map((c) => c.name);
    assert.deepEqual(cookies, ['ft_session']);
    assert.ok(!cookies.join().includes(A.email));
  });
});

describe('error bodies', { skip }, () => {
  test('validation errors name fields but never echo submitted values', async () => {
    const r = await call(app, {
      method: 'POST', url: '/api/v1/clients', token: A.token,
      body: { name: { first: PII.name }, email: [PII.email], phone: 7805550199, tags: PII.phone },
    });
    assert.equal(r.status, 400);
    const text = JSON.stringify(r.body);
    for (const s of [PII.name, PII.email, '7805550199', PII.phone]) assert.ok(!text.includes(s), `echoed ${s}`);
    assert.ok(r.body.error.details.errors.some((e) => e.path === '/email'));

    const login = await call(app, { method: 'POST', url: '/api/v1/auth/login', body: { email: `${'x'.repeat(300)}${PII.email}`, password: 12 } });
    assert.equal(login.status, 400);
    assert.ok(!JSON.stringify(login.body).includes(PII.email));

    const sync = await call(app, { method: 'POST', url: '/api/v1/sync/push', token: A.token, body: { mutations: [
      { mid: 'leak-1', collection: PII.email, id: 'x', op: 'upsert', data: {} },
      { mid: 'leak-2', collection: 'clients', id: 'c-leak', op: 'upsert', data: { name: 12, email: { v: PII.email } } },
    ] } });
    assert.equal(sync.status, 200);
    assert.ok(!JSON.stringify(sync.body).includes(PII.email));
  });

  test('malformed JSON is refused without repeating it', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/clients',
      headers: { authorization: `Bearer ${A.token}`, 'content-type': 'application/json' },
      payload: `{"email": "${PII.email}", "phone": ${PII.phone}`,
    });
    assert.equal(res.statusCode, 400);
    assert.ok(!res.body.includes(PII.email));
    assert.ok(!res.body.includes(PII.phone));
    assert.equal(JSON.parse(res.body).error.code, 'bad_json');
  });

  test('conflicts and lookups do not repeat ids or names that were sent', async () => {
    const dup = await call(app, { method: 'POST', url: '/api/v1/clients', token: A.token, body: { id: client.id, name: 'x' } });
    assert.equal(dup.status, 409);
    assert.ok(!JSON.stringify(dup.body).includes(client.id));
  });

  test('a server error in production shows no SQL, stack or data; logs keep no row values', async () => {
    const failing = {
      ...t.db,
      withTenant: async () => {
        const e = new Error(`duplicate key value violates unique constraint; SELECT * FROM clients WHERE email = '${PII.email}'`);
        Object.assign(e, { code: '23505', detail: `Key (email)=(${PII.email}) already exists.`, where: 'SQL statement' });
        throw e;
      },
    };
    const env = { APP_ENV: 'production', DATABASE_URL: 'postgres://unused', SECRETS_MASTER_KEY: randomBytes(32).toString('base64') };
    const { app: prod, logs } = await startApp(t, { env, db: failing });
    const r = await call(prod, { url: '/api/v1/clients', token: A.token });
    assert.equal(r.status, 500);
    assert.deepEqual(Object.keys(r.body.error).sort(), ['code', 'message', 'requestId']);
    assert.equal(r.body.error.code, 'internal');
    const text = JSON.stringify(r.body);
    for (const s of [PII.email, 'SELECT', 'duplicate key', 'at ', '.js']) assert.ok(!text.includes(s), `500 body contains ${s}`);
    assertCleanHeaders(r, '500');
    assert.ok(!logs.text().includes(`Key (email)=(${PII.email})`), 'pg detail kept out of logs');
    await prod.close();

    const { app: local } = await startApp(t, { env: { APP_ENV: 'local' }, db: failing });
    const l = await call(local, { url: '/api/v1/clients', token: A.token });
    assert.equal(l.status, 500);
    assert.ok(l.body.error.details.debug, 'local development shows the cause');
    await local.close();
  });
});

describe('public endpoints and URLs', { skip }, () => {
  test('status and readiness reveal nothing about tenants', async () => {
    for (const url of ['/api/v1/status', '/api/readyz', '/api/healthz']) {
      const r = await call(app, { url });
      const text = JSON.stringify(r.body);
      for (const s of sensitive()) assert.ok(!text.includes(s), `${url} contains ${s}`);
      assert.ok(!/tenant|email|client/i.test(text), `${url} mentions tenant data`);
    }
  });

  test('list filters are ids and codes only (no names, emails or phones in query strings)', async () => {
    const spec = (await call(app, { url: '/api/v1/openapi.json' })).body;
    const allowed = new Set(['limit', 'cursor', 'includeDeleted', 'version', 'since', 'link', 'collection', 'recordId', 'action',
      'clientId', 'jobId', 'status', 'stage', 'number', 'employeeId', 'leadId', 'sequenceId', 'relatedId', 'invoiceId', 'sku',
      'itemId', 'permitId', 'result', 'date', 'drawingId',
      // HQ console: periods, export kinds, a company id, dates, a help category id, a check toggle.
      'days', 'months', 'tenantId', 'category', 'live',
      // safety: an incident kind code and employee / record ids
      'kind', 'ownerId', 'sourceId',
      // work plans: GET /api/v1/workTasks?planId=, GET /api/v1/kpis?from=&to= (ids and YYYY-MM-DD only)
      'planId', 'from', 'to',
      // material requests: GET /api/v1/materialRequests?batchId= (a send's uuid)
      'batchId',
      // location points (own rows only): a time entry id and an ISO time
      'timeEntryId', 'at',
      // purchasing: GET /api/v1/bills?vendorId=&purchaseOrderId= (record ids)
      'vendorId', 'purchaseOrderId',
      // QuickBooks: record ids (comma list), log outcomes and match choices are codes; searches are POST bodies (7.8)
      'ids', 'outcome', 'choice',
      // HQ Mail: "Show images" for one message (0|1), not data.
      'images']);
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const op of Object.values(ops)) {
        for (const p of op.parameters || []) {
          if (p.in === 'query') assert.ok(allowed.has(p.name), `${path} query parameter ${p.name} is not on the safe list`);
        }
      }
    }
  });
});

// ---- QuickBooks (docs/integrations/quickbooks.md 10.2) ------------------------------------------

describe('QuickBooks: no token, realm id, verifier, ticket or customer name escapes', { skip }, () => {
  const fake = createFakeQbo();
  const VERIFIER = 'verifier-LEAKCHECK-7731';
  const REALM = '9876543219876543';
  const NAME = 'Zebulon Quixotic-Leakname';
  const env = { QBO_ENVIRONMENT: 'sandbox', QBO_CLIENT_ID: fake.app.clientId, QBO_CLIENT_SECRET: fake.app.clientSecret, QBO_WEBHOOK_VERIFIER: VERIFIER };
  let qapp, qconfig, qlogs, L, seen;
  const tokens = () => [...fake.state.refresh.keys(), ...fake.state.access.keys()];
  // The ticket is in the connect URL and the interstitial's form by design; it must never reach a log.
  const forbiddenText = () => [REALM, VERIFIER, fake.app.clientSecret, ...tokens()];

  before(async () => {
    if (skip) return;
    setFetch((u, i) => fake.fetch(u, i));
    ({ app: qapp, config: qconfig, logs: qlogs } = await startHqApp(t, { env: { ...env, LOG_LEVEL: 'info' } }));
    L = await ownerTenant(t, qapp, 'Leakcheck Books Ltd');
    fake.addCompany(REALM, { name: 'Leakcheck QBO' });
    seen = [];
  });
  after(async () => { setFetch(null); await qapp?.close(); });

  test('connect, start, callback, status, look-ups and failures carry no secret in bodies, headers or logs', async () => {
    const bodies = [];
    const keep = (r) => { bodies.push(JSON.stringify(r.headers), r.body); return r; };
    const tk = keep(await qapp.inject({ method: 'POST', url: '/api/v1/qbo/connect', headers: { authorization: `Bearer ${L.token}`, 'content-type': 'application/json' }, payload: { returnTo: 'app' } }));
    const startUrl = new URL(JSON.parse(tk.body).url);
    const ticket = startUrl.searchParams.get('ticket');
    seen.push(ticket);
    const page = keep(await qapp.inject({ method: 'GET', url: `${startUrl.pathname}${startUrl.search}` }));
    const pre = page.cookies.find((c) => c.name === 'ft_qbo_pre').value;
    seen.push(pre);
    const post = keep(await qapp.inject({ method: 'POST', url: '/api/v1/qbo/oauth/start', headers: { 'content-type': 'application/x-www-form-urlencoded' }, cookies: { ft_qbo_pre: pre }, payload: `ticket=${ticket}` }));
    const flow = post.cookies.find((c) => c.name === 'ft_qbo_flow').value;
    seen.push(flow);
    const back = await fake.authorize(post.headers.location, { realmId: REALM });
    seen.push(back.code, back.state);
    const code = back.code;
    const cb = new URL(back.url);
    keep(await qapp.inject({ method: 'GET', url: `${cb.pathname}${cb.search}`, cookies: { ft_qbo_flow: flow } }));
    // A failing callback (replayed state) and a failing start (a made-up ticket) log no realm and no ticket.
    keep(await qapp.inject({ method: 'GET', url: `${cb.pathname}${cb.search}`, cookies: { ft_qbo_flow: flow } }));
    const bogus = randomBytes(32).toString('base64url');
    seen.push(bogus);
    keep(await qapp.inject({ method: 'GET', url: `/api/v1/qbo/oauth/start?ticket=${bogus}` }));
    keep(await qapp.inject({ method: 'POST', url: '/api/v1/qbo/oauth/start', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `ticket=${bogus}` }));
    keep(await qapp.inject({ method: 'GET', url: '/api/v1/qbo/status', headers: { authorization: `Bearer ${L.token}` } }));
    await t.superPool.query("UPDATE qbo_connections SET state = 'active', setup = '{\"phase\":\"done\"}'::jsonb, cdc_cursor = now() WHERE tenant_id = $1", [L.tenantId]);
    keep(await qapp.inject({ method: 'POST', url: '/api/v1/qbo/lookup/customers', headers: { authorization: `Bearer ${L.token}`, 'content-type': 'application/json' }, payload: { q: 'Le' } }));
    keep(await qapp.inject({ method: 'POST', url: '/api/v1/webhooks/qbo', headers: { 'content-type': 'application/json', 'intuit-signature': 'bad' }, payload: '[]' }));
    const text = bodies.join('\n') + qlogs.text();
    for (const s of [...forbiddenText(), code]) assert.ok(s && !text.includes(s), `leaked: ${String(s).slice(0, 12)}...`);
    for (const s of seen) assert.ok(s && !qlogs.text().includes(s), `logged: ${String(s).slice(0, 12)}...`);
    assert.ok(!qlogs.text().includes('realmId='), 'no realmId in a logged request line');
  });

  test("a forced duplicate-name failure never puts the customer's name in jobs_queue, worker output or HQ", async () => {
    const records = createRecords({ validator: createValidator(), config: qconfig });
    const handlers = createQboHandlers({ sealer: qapp.sealer, config: qconfig, records });
    await refreshReference({ db: t.db, sealer: qapp.sealer, config: qconfig }, L.tenantId, { force: true });
    await call(qapp, { method: 'POST', url: '/api/v1/clients', token: L.token, body: { id: 'leak-client', name: NAME } });
    const detail = `The name supplied already exists. : Another customer is using "${NAME}"`;
    fake.failNext({ count: 30, status: 400, code: '6240', message: 'Duplicate Name Exists Error', detail, match: (c) => c.method === 'POST' && c.path === 'customer' });
    // Then the CDC call itself fails with the name in Intuit's text, failing the whole job.
    fake.failNext({ count: 30, status: 400, code: '6000', message: 'A business validation error', detail: `Bad name ${NAME}`, match: (c) => c.path === 'cdc' });
    await t.superPool.query("UPDATE qbo_outbox SET not_before = now() - interval '1 second' WHERE tenant_id = $1", [L.tenantId]);
    await t.superPool.query("DELETE FROM jobs_queue WHERE kind LIKE 'qbo\\_%'");
    await enqueue(t.db, { kind: 'qbo_sync', tenantId: L.tenantId, dedupeKey: `leak-sync-${Date.now()}` });
    const out = [];
    const r = await runOnce(t.db, { workerId: 'leak', handlers, kinds: ['qbo\\_%'], log: { info: (m) => out.push(m), error: (m) => out.push(m) } });
    assert.ok(r, 'a job ran');
    out.push(JSON.stringify(r));
    const lastErrors = (await t.superPool.query("SELECT last_error FROM jobs_queue WHERE kind LIKE 'qbo\\_%'")).rows.map((x) => x.last_error || '');
    assert.ok(lastErrors.some((e) => e.length), 'the job failed with a message');
    assert.ok(lastErrors.every((e) => !e.includes('Zebulon') && !e.includes('Leakname')), lastErrors.join(' | '));
    assert.ok(!out.join(' ').includes('Leakname'), 'worker output');
    fake.state.faults.length = 0;
    const staff = await hqUser(t, qapp, 'hq_staff');
    const hq = await call(qapp, { url: `/api/hq/tenants/${L.tenantId}`, token: staff.token });
    assert.equal(hq.status, 200, JSON.stringify(hq.body));
    assert.ok(!JSON.stringify(hq.body).includes('Leakname'));
    assert.ok(!JSON.stringify(hq.body).includes(REALM));
  });
});
