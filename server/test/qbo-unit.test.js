// QuickBooks platform pieces that need no database (docs/integrations/quickbooks.md 11.2, W1): env
// parsing, the authorize URL, OAuth against the fake, webhook signatures and parsing, fault
// classification and the fixed message table, the name-safe scrub, limiter maths, budgets, log
// redaction, the realm mac, internal secret names, pages, roles, plans and the deploy kits.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { readQboConfig, qboCfg } from '../src/qbo/env.js';
import { readConfig } from '../src/config.js';
import { QBO_PKCE, authorizeUrl, codeChallengeFor, exchangeCode, refreshTokens, revokeToken } from '../src/qbo/oauth.js';
import { QBO_MESSAGES, QboError, budgetGate, classifyQboFault, faultOf, qboMessage } from '../src/qbo/client.js';
import { verifyIntuitSignature, parseWebhook } from '../src/qbo/webhook.js';
import { WindowLimit, createLimiter } from '../src/qbo/limiter.js';
import { QBO_ACTOR, canUseQbo, requireQboRole } from '../src/qbo/roles.js';
import { PAGE_HEADERS, RESULT_TEXT, disconnectedPage, donePage, interstitialHeaders, interstitialPage } from '../src/qbo/pages.js';
import { detectFeatures, flowCookieOptions, realmHashFor, resultUrl } from '../src/qbo/connection.js';
import { redactUrl } from '../src/logger.js';
import { scrub, setFetch } from '../src/integrations/http.js';
import { createSealer } from '../src/lib/crypto.js';
import { SECRETS, getSecret, isSecretName, setSecret, deleteSecret } from '../src/services/secrets.js';
import { FEATURE_PLAN } from '../../electrical-app/js/plans.js';
import { createFakeQbo } from './support/fake-qbo.js';

const ROOT = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const ENV = { APP_ENV: 'test', QBO_ENVIRONMENT: 'sandbox', QBO_CLIENT_ID: 'client-abc', QBO_CLIENT_SECRET: ['s', 'e', 'c'].join(''), PUBLIC_ORIGIN: 'https://app.fishtape.test' };

describe('env', () => {
  test('off unless QBO_ENVIRONMENT and both app credentials are set', () => {
    assert.equal(readQboConfig({}).enabled, false);
    assert.equal(readQboConfig({}).environment, null);
    assert.equal(readQboConfig({ QBO_ENVIRONMENT: 'sandbox' }).enabled, false);
    assert.equal(readQboConfig({ QBO_ENVIRONMENT: 'sandbox', QBO_CLIENT_ID: 'x' }).enabled, false);
    assert.equal(readQboConfig(ENV).enabled, true);
    assert.throws(() => readQboConfig({ QBO_ENVIRONMENT: 'prod' }), /QBO_ENVIRONMENT/);
    assert.throws(() => readQboConfig({ QBO_WRITES: 'maybe' }), /QBO_WRITES/);
  });

  test('defaults, budgets, verifiers, write switch and fixed Intuit endpoints', () => {
    const q = readQboConfig({ ...ENV, QBO_WEBHOOK_VERIFIER: 'new', QBO_WEBHOOK_VERIFIER_PREVIOUS: 'old', QBO_WRITES: 'off', QBO_TENANT_READ_BUDGET: '100' });
    assert.deepEqual(q.webhookVerifiers, ['new', 'old']);
    assert.equal(q.writesEnabled, false);
    assert.equal(q.readBudget, 450000);
    assert.equal(q.tenantReadBudget, 100);
    assert.equal(q.trialReadBudget, 5000);
    assert.equal(q.minorVersion, 75);
    assert.equal(q.requestTimeoutMs, 30000);
    assert.equal(q.scope, 'com.intuit.quickbooks.accounting');
    assert.equal(q.apiBase, 'https://sandbox-quickbooks.api.intuit.com/v3/company');
    assert.equal(readQboConfig({ ...ENV, QBO_ENVIRONMENT: 'production' }).apiBase, 'https://quickbooks.api.intuit.com/v3/company');
    assert.equal(q.oauth.authorize, 'https://appcenter.intuit.com/connect/oauth2');
    assert.equal(q.oauth.token, 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer');
    assert.equal(q.oauth.revoke, 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke');
    assert.equal(q.redirectUri(), 'https://app.fishtape.test/api/v1/qbo/oauth/callback');
    assert.equal(readQboConfig({}).writesEnabled, true);
  });

  test('QBO_API_BASE and QBO_OAUTH_BASE only count in test and local', () => {
    const o = { ...ENV, QBO_API_BASE: 'http://127.0.0.1:4010/v3/company', QBO_OAUTH_BASE: 'http://127.0.0.1:4010/' };
    assert.equal(readQboConfig(o).apiBase, 'http://127.0.0.1:4010/v3/company');
    assert.equal(readQboConfig(o).oauth.token, 'http://127.0.0.1:4010/oauth2/v1/tokens/bearer');
    const staging = readQboConfig({ ...o, APP_ENV: 'staging' });
    assert.equal(staging.apiBase, 'https://sandbox-quickbooks.api.intuit.com/v3/company');
    assert.equal(staging.oauth.authorize, 'https://appcenter.intuit.com/connect/oauth2');
  });

  test('config.js carries qbo and the QuickBooks worker slots', () => {
    const c = readConfig({ ...ENV, SECRETS_MASTER_KEY: randomBytes(32).toString('base64'), WORKER_QBO_CONCURRENCY: '3' });
    assert.equal(c.qbo.enabled, true);
    assert.equal(c.worker.qboConcurrency, 3);
    assert.equal(readConfig({ APP_ENV: 'test' }).worker.qboConcurrency, 2);
    assert.equal(qboCfg(c), c.qbo);
    assert.equal(qboCfg(c.qbo), c.qbo);
  });
});

describe('oauth', () => {
  const q = readQboConfig(ENV);
  test('authorize URL: client, code flow, the accounting scope, redirect and state; PKCE recorded off', () => {
    const u = new URL(authorizeUrl(q, { state: 'st8', redirectUri: q.redirectUri() }));
    assert.equal(u.origin + u.pathname, 'https://appcenter.intuit.com/connect/oauth2');
    assert.equal(u.searchParams.get('client_id'), 'client-abc');
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.equal(u.searchParams.get('scope'), 'com.intuit.quickbooks.accounting');
    assert.equal(u.searchParams.get('redirect_uri'), 'https://app.fishtape.test/api/v1/qbo/oauth/callback');
    assert.equal(u.searchParams.get('state'), 'st8');
    assert.equal(u.searchParams.get('code_challenge'), null);
    const p = new URL(authorizeUrl(q, { state: 's', redirectUri: 'x', codeChallenge: codeChallengeFor('v') }));
    assert.equal(p.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(QBO_PKCE, false);
  });

  describe('against the fake', () => {
    const fake = createFakeQbo();
    const cfg = readQboConfig({ ...ENV, QBO_CLIENT_ID: fake.app.clientId, QBO_CLIENT_SECRET: fake.app.clientSecret });
    fake.addCompany('4620816365000001');
    setFetch((u, i) => fake.fetch(u, i));
    after(() => setFetch(null));

    test('code exchange once, hard expiry asked for, refresh rotates, revoke ends the grant', async () => {
      const back = await fake.authorize(authorizeUrl(cfg, { state: 's1', redirectUri: cfg.redirectUri() }), { realmId: '4620816365000001' });
      assert.equal(back.realmId, '4620816365000001');
      const t = await exchangeCode(cfg, { code: back.code, redirectUri: cfg.redirectUri() });
      assert.ok(t.accessToken && t.refreshToken);
      assert.equal(t.expiresIn, 3600);
      assert.ok(t.refreshHardExpiresIn > 0, 'x_refresh_token_hard_expires_in requested and read');
      await assert.rejects(exchangeCode(cfg, { code: back.code, redirectUri: cfg.redirectUri() }), (e) => e instanceof QboError && e.kind === 'auth');
      const t2 = await refreshTokens(cfg, t.refreshToken);
      assert.notEqual(t2.refreshToken, t.refreshToken);
      await assert.rejects(refreshTokens(cfg, t.refreshToken), (e) => e.kind === 'auth', 'a rotated token stops working');
      await revokeToken(cfg, t2.refreshToken);
      assert.equal(fake.grantAlive('4620816365000001'), false);
      await assert.rejects(refreshTokens(cfg, t2.refreshToken), (e) => e.kind === 'auth');
      await revokeToken(cfg, t2.refreshToken); // already dead: fine
    });

    test('invalid_client and wrong app secrets are platform errors; 5xx is retryable; no token in messages', async () => {
      const t = fake.issueTokens('4620816365000001');
      fake.failToken({ error: 'invalid_client' });
      await assert.rejects(refreshTokens(cfg, t.refreshToken), (e) => e.kind === 'platform' && e.retry && !e.message.includes(t.refreshToken));
      await assert.rejects(refreshTokens({ ...cfg, clientSecret: 'wrong' }, t.refreshToken), (e) => e.kind === 'platform');
      fake.failToken({ error: 'server_error', status: 503 });
      await assert.rejects(refreshTokens(cfg, t.refreshToken), (e) => e.kind === 'unavailable' && e.retry);
      assert.ok((await refreshTokens(cfg, t.refreshToken)).accessToken);
      fake.assertNoUnexpected();
    });
  });
});

describe('webhooks', () => {
  const raw = Buffer.from(JSON.stringify([{ id: 'e1', type: 'qbo.customer.updated.v1', time: '2026-10-20T10:00:00Z', intuitentityid: '58', intuitaccountid: '123', data: {} }]));
  const sig = (body, v) => createHmac('sha256', v).update(body).digest('base64');

  test('signature: valid, wrong, missing, tampered body, the previous verifier', () => {
    assert.equal(verifyIntuitSignature(raw, sig(raw, 'cur'), ['cur']), true);
    assert.equal(verifyIntuitSignature(raw, sig(raw, 'other'), ['cur']), false);
    assert.equal(verifyIntuitSignature(raw, undefined, ['cur']), false);
    assert.equal(verifyIntuitSignature(raw, '', ['cur']), false);
    assert.equal(verifyIntuitSignature(Buffer.concat([raw, Buffer.from(' ')]), sig(raw, 'cur'), ['cur']), false);
    assert.equal(verifyIntuitSignature(raw, sig(raw, 'old'), ['cur', 'old']), true);
    assert.equal(verifyIntuitSignature(raw, sig(raw, 'old'), ['cur']), false);
    assert.equal(verifyIntuitSignature(raw, sig(raw, 'cur'), []), false);
    assert.equal(verifyIntuitSignature(raw, 'not base64 !!', ['cur']), false);
  });

  test('CloudEvents: entity, op, ids, deleted id; unknown types and bad ids dropped', () => {
    const body = Buffer.from(JSON.stringify([
      { id: 'a', type: 'qbo.timeactivity.deleted.v1', time: '2026-10-20T10:00:00Z', intuitentityid: '7', intuitaccountid: '99' },
      { id: 'b', type: 'qbo.customer.merged.v1', time: '2026-10-20T10:01:00Z', intuitentityid: '58', intuitaccountid: '99', data: { deletedid: '61' } },
      { id: 'c', type: 'qbo.purchaseorder.created.v1', intuitentityid: '3', intuitaccountid: '99' },
      { id: 'd', type: 'qbo.spaceship.created.v1', intuitentityid: '3', intuitaccountid: '99' },
      { id: 'e', type: 'qbo.invoice.updated.v1', intuitentityid: "1' or 1=1", intuitaccountid: '99' },
      { id: 'f', type: 'something.else', intuitentityid: '3', intuitaccountid: '99' },
    ]));
    const ev = parseWebhook(body);
    assert.equal(ev.length, 3);
    assert.deepEqual(ev[0], { id: 'a', realmId: '99', entity: 'TimeActivity', op: 'deleted', qboId: '7', deletedId: null, time: '2026-10-20T10:00:00.000Z' });
    assert.equal(ev[1].op, 'merged');
    assert.equal(ev[1].deletedId, '61');
    assert.equal(ev[2].entity, 'PurchaseOrder');
    assert.deepEqual(parseWebhook(Buffer.from('not json')), []);
  });

  test('the legacy eventNotifications body becomes the same shape', () => {
    const body = Buffer.from(JSON.stringify({ eventNotifications: [{ realmId: '99', dataChangeEvent: { entities: [
      { name: 'Invoice', id: '130', operation: 'Void', lastUpdated: '2026-10-20T10:00:00Z' },
      { name: 'Customer', id: '58', operation: 'Merge', deletedId: '61', lastUpdated: '2026-10-20T10:00:00Z' },
      { name: 'Unknown', id: '1', operation: 'Create' },
    ] } }] }));
    const ev = parseWebhook(body);
    assert.deepEqual(ev.map((e) => [e.entity, e.op, e.qboId, e.deletedId]), [['Invoice', 'voided', '130', null], ['Customer', 'merged', '58', '61']]);
  });
});

describe('errors', () => {
  const cases = [
    [{ status: 400, faultCode: '5010' }, 'stale', true],
    [{ status: 400, faultCode: '6140' }, 'duplicate_number', false],
    [{ status: 400, faultCode: '6240' }, 'duplicate_name', false],
    [{ status: 400, faultCode: '610' }, 'not_found', false],
    [{ status: 403, faultCode: '5020' }, 'permission', false],
    [{ status: 400, faultCode: '5030' }, 'feature', false],
    [{ status: 400, faultCode: '140' }, 'unavailable', true],
    [{ status: 400, faultCode: '150' }, 'unavailable', true],
    [{ status: 401, faultCode: '3200' }, 'auth', false],
    [{ status: 400, faultCode: '6000', detail: 'Business Validation Error: The account period has closed and the books are locked for this date.' }, 'closed_books', false],
    [{ status: 400, faultCode: '6000', detail: 'This customer has an open balance and can not be made inactive.' }, 'open_balance', false],
    [{ status: 400, faultCode: '6000', detail: 'Amount is not equal to UnitPrice x Qty. Supplied value:12.5' }, 'validation', false],
    [{ status: 400, faultCode: '6000', detail: 'Something else' }, 'validation', false],
    [{ status: 429 }, 'throttled', true],
    [{ status: 429, faultCode: '003001' }, 'throttled', true],
    [{ status: 500 }, 'unavailable', true],
    [{ status: 503 }, 'unavailable', true],
    [{ status: 401 }, 'auth', false],
    [{ status: 403 }, 'permission', false],
    [{ status: 404 }, 'not_found', false],
    [{ status: 400 }, 'validation', false],
    [{ status: 418 }, 'other', false],
  ];
  test('every fault code the engine handles is classified (5.8)', () => {
    for (const [input, kind, retry] of cases) {
      const c = classifyQboFault(input);
      assert.equal(c.kind, kind, JSON.stringify(input));
      assert.equal(c.retry, retry, JSON.stringify(input));
    }
    assert.equal(classifyQboFault({ status: 400, faultCode: '6000', detail: 'Amount is not equal to UnitPrice x Qty' }).variant, 'amount');
    assert.equal(classifyQboFault({ status: 400, faultCode: '6000', detail: 'override not allowed (-37100)' }).variant, 'tax_override');
  });

  test('messages come from the fixed table and never carry Intuit detail; detail is kept apart', () => {
    for (const kind of ['auth', 'platform', 'stale', 'duplicate_number', 'duplicate_name', 'not_found', 'validation', 'throttled', 'unavailable', 'budget', 'feature', 'closed_books', 'permission', 'open_balance', 'other']) {
      const e = new QboError(kind, { detail: 'Duplicate Name Exists Error: name: Dana Smith', faultCode: '6240' });
      assert.equal(e.message, QBO_MESSAGES[kind]);
      assert.ok(!e.message.includes('Dana'));
    }
    assert.equal(new QboError('budget', { variant: 'lookup' }).code, 'lookup_budget');
    assert.equal(new QboError('throttled').code, 'qbo_throttled');
    assert.equal(new QboError('unavailable', { variant: 'writes_off' }).message, 'Sending to QuickBooks is paused by Fishtape.');
    assert.equal(qboMessage('nonsense'), QBO_MESSAGES.other);
    assert.deepEqual(faultOf({ fault: { error: [{ message: 'm', detail: 'd', code: '3200' }], type: 'AUTHENTICATION' } }), { code: '3200', message: 'm', detail: 'd', type: 'AUTHENTICATION' });
    assert.equal(faultOf({}), null);
  });

  test('scrub: name-safe rule (quotes, text after name:) and long tokens', () => {
    const d = scrub('Duplicate Name Exists Error: The name supplied already exists. : name: Pat O\'Brien Electric, Id=58', 300, { names: true });
    assert.ok(!d.includes('Brien'), d);
    assert.match(d, /name: \[…\]/);
    assert.equal(scrub('Customer "Dana Smith" is inactive', 200, { names: true }), 'Customer […] is inactive');
    assert.equal(scrub("Vendor 'Acme Supply' exists", 200, { names: true }), 'Vendor […] exists');
    assert.equal(scrub('Customer "Dana Smith"'), 'Customer "Dana Smith"', 'off by default');
    const tok = ['eyJlbmMiOiJBMTI4Q0JDLUhTMjU2IiwiYWxnIjoiZGlyIn0', 'abcdEFGHijkl', 'mnopQRST'].join('.');
    assert.ok(!scrub(`bad token ${tok} here`).includes('eyJ'));
    assert.match(scrub(`refresh AB11${'x'.repeat(40)}`), /\[token\]/);
  });
});

describe('limiter', () => {
  test('a sliding window allows `limit` starts per window', () => {
    const w = new WindowLimit(3, 1000);
    for (const t of [0, 10, 20]) { assert.equal(w.waitMs(t), 0); w.record(t); }
    assert.equal(w.waitMs(30), 970);
    assert.equal(w.waitMs(1000), 0);
  });

  test('8 a second and 400 a minute per tenant; tenants are independent', async () => {
    let clock = 0;
    const waits = [];
    const lim = createLimiter({ now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } });
    for (let i = 0; i < 8; i++) (await lim.acquire('a'))();
    assert.equal(waits.length, 0);
    (await lim.acquire('a'))();
    assert.equal(waits.length, 1);
    assert.ok(waits[0] > 0 && waits[0] <= 1000);
    assert.equal(lim.delayFor('b', clock), 0);
    clock = 0;
    const lim2 = createLimiter({ perSecond: 1000, now: () => clock, sleep: async (ms) => { clock += ms; } });
    for (let i = 0; i < 400; i++) (await lim2.acquire('t'))();
    assert.ok(lim2.delayFor('t', clock) > 0, 'the 401st call in a minute waits');
  });

  test('at most maxInFlight calls at once per tenant', async () => {
    const lim = createLimiter();
    let running = 0;
    let peak = 0;
    const work = async () => { const rel = await lim.acquire('t', { maxInFlight: 2 }); running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 5)); running--; rel(); };
    await Promise.all([work(), work(), work(), work(), work()]);
    assert.equal(peak, 2);
  });
});

test('budget rules per purpose and level (5.11)', () => {
  assert.equal(budgetGate('sync', 10, 10), null);
  assert.deepEqual(budgetGate('lookup', 80, 0), { variant: 'lookup', pause: null });
  assert.equal(budgetGate('sync', 99, 0), null);
  assert.equal(budgetGate('check', 99, 0), null);
  assert.ok(budgetGate('check', 100, 0));
  assert.ok(budgetGate('scan', 100, 0));
  assert.ok(budgetGate('cdc', 100, 0));
  assert.equal(budgetGate('sync', 120, 0), null, 'webhook-driven pulls continue');
  assert.deepEqual(budgetGate('sync', 150, 0), { variant: null, pause: 'tenant_budget' });
  assert.ok(budgetGate('cdc', 0, 90));
  assert.ok(budgetGate('lookup', 0, 90));
  assert.equal(budgetGate('sync', 0, 90), null);
  assert.deepEqual(budgetGate('sync', 0, 100), { variant: null, pause: 'budget' });
  assert.equal(budgetGate('connect', 500, 500), null);
});

test('logger redacts realmId, realm_id and ticket in URLs', () => {
  assert.equal(redactUrl('/api/v1/qbo/oauth/callback?code=c1&state=s1&realmId=4620816365000001'),
    '/api/v1/qbo/oauth/callback?code=[REDACTED]&state=[REDACTED]&realmId=[REDACTED]');
  assert.equal(redactUrl('/api/v1/qbo/oauth/start?ticket=abcDEF123'), '/api/v1/qbo/oauth/start?ticket=[REDACTED]');
  assert.equal(redactUrl('/x?realm_id=99&page=2'), '/x?realm_id=[REDACTED]&page=2');
});

test('sealer.mac: 32 bytes, stable per key and purpose, different with another key', () => {
  const a = createSealer(randomBytes(32).toString('base64'));
  const b = createSealer(randomBytes(32).toString('base64'));
  assert.equal(a.mac('qbo-realm', 'sandbox:1').length, 32);
  assert.ok(a.mac('qbo-realm', 'sandbox:1').equals(realmHashFor(a, 'sandbox', '1')));
  assert.ok(!a.mac('qbo-realm', 'sandbox:1').equals(a.mac('qbo-realm', 'production:1')));
  assert.ok(!a.mac('qbo-realm', 'sandbox:1').equals(b.mac('qbo-realm', 'sandbox:1')));
  assert.ok(!a.mac('qbo-realm', 'x').equals(a.mac('other', 'x')));
});

test('internal secret names: registered, refused by the generic routes, usable only with { internal: true }', async () => {
  const sealer = createSealer(randomBytes(32).toString('base64'));
  const tx = { tenantId: '00000000-0000-4000-8000-000000000001', query: async () => ({ rows: [], rowCount: 0 }) };
  for (const n of ['qbo.refresh_token', 'qbo.access_token', 'qbo.realm_id']) {
    assert.equal(SECRETS[n].internal, true);
    assert.equal(SECRETS[n].provider, 'qbo');
    assert.equal(isSecretName(n), false);
    await assert.rejects(getSecret(tx, sealer, n), /internal/);
    await assert.rejects(setSecret(tx, sealer, n, 'v'), /internal/);
    await assert.rejects(deleteSecret(tx, n), /internal/);
    assert.equal(await getSecret(tx, sealer, n, { internal: true }), null);
  }
  assert.equal(isSecretName('stripe.secret_key'), true);
  await assert.rejects(getSecret(tx, sealer, 'stripe.secret_key', { internal: true }), /not internal/);
});

test('plans: quickbooks and purchasing are Pro features', () => {
  assert.equal(FEATURE_PLAN.quickbooks, 'pro');
  assert.equal(FEATURE_PLAN.purchasing, 'pro');
});

test('pages: escaped, no scripts, strict CSP; the interstitial may post and redirect to Intuit', () => {
  const html = interstitialPage({ tenantName: '<b>Alpha</b> & Co', userEmail: 'o"wner@example.test', ticket: 'T'.repeat(43), cancelUrl: 'https://app.fishtape.test/#/quickbooks?connect=denied' });
  assert.ok(html.includes('&lt;b&gt;Alpha&lt;/b&gt; &amp; Co'));
  assert.ok(html.includes('o&quot;wner@example.test'));
  assert.ok(!/<script/i.test(html));
  assert.match(html, /name="ticket" value="T{43}"/);
  const h = interstitialHeaders('https://appcenter.intuit.com/connect/oauth2');
  assert.match(h['content-security-policy'], /^default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:\/\/appcenter\.intuit\.com;/);
  assert.equal(h['cache-control'], 'no-store');
  assert.equal(PAGE_HEADERS['content-security-policy'].startsWith("default-src 'none'; style-src 'unsafe-inline'"), true);
  for (const r of Object.keys(RESULT_TEXT)) assert.ok(!/QBO|\bQB\b/.test(donePage(r)), r);
  assert.match(donePage('ok'), /QuickBooks is connected/);
  assert.match(donePage('<script>'), /did not finish connecting/);
  assert.match(disconnectedPage(), /To connect again, sign in to/);
});

test('connect results go to the PWA for web and the done page for the iOS app', () => {
  const q = readQboConfig(ENV);
  assert.equal(resultUrl(q, 'web', 'ok'), 'https://app.fishtape.test/#/quickbooks?connect=ok');
  assert.equal(resultUrl(q, 'app', 'denied'), 'https://app.fishtape.test/api/v1/qbo/oauth/done?result=denied');
  assert.equal(resultUrl(q, null, 'state_invalid'), 'https://app.fishtape.test/api/v1/qbo/oauth/done?result=state_invalid');
  assert.deepEqual(flowCookieOptions({ secureCookies: true }), { httpOnly: true, secure: true, sameSite: 'lax', path: '/api/v1/qbo/oauth', maxAge: 600 });
});

test('features from CompanyInfo and Preferences, by edition (2.8)', () => {
  const fake = createFakeQbo();
  const c = fake.addCompany('1', { edition: 'QuickBooks Online Essentials' });
  const f = detectFeatures(c.info, c.prefs);
  assert.equal(f.edition, 'QuickBooks Online Essentials');
  assert.equal(f.salesTax, true);
  assert.equal(f.customTxnNumbers, true);
  assert.equal(f.bills, true);
  assert.equal(f.timeTracking, true);
  assert.equal(f.purchaseOrders, false);
  assert.equal(f.province, 'MB');
  assert.equal(f.multicurrency, false);
  const plus = detectFeatures(fake.addCompany('2').info, c.prefs);
  assert.equal(plus.purchaseOrders, true);
});

describe('roles', () => {
  const session = (role, extra = {}) => ({ kind: 'session', role, crew: false, ...extra });
  const req = (principal, mfa = true) => ({ principal, auth: { session: { mfa_verified_at: mfa ? new Date() : null } } });
  test('office roles only; never crew sessions, API keys or system principals', () => {
    for (const r of ['owner', 'admin', 'office']) assert.equal(canUseQbo(session(r)), true);
    for (const r of ['foreman', 'electrician', 'apprentice']) assert.equal(canUseQbo(session(r)), false);
    assert.equal(canUseQbo(session('owner', { crew: true })), false);
    assert.equal(canUseQbo({ kind: 'api_key', role: null }), false);
    assert.equal(canUseQbo({ kind: 'system', role: 'owner' }), false);
    assert.equal(canUseQbo(null), false);
    assert.deepEqual(QBO_ACTOR, { type: 'system', id: 'qbo', label: 'QuickBooks sync' });
  });

  test('requireQboRole: office and admin levels, and two-step sign-in on writes', async () => {
    const office = requireQboRole('office');
    const admin = requireQboRole('admin');
    const write = requireQboRole('office', { write: true });
    await office(req(session('office')));
    await assert.rejects(office(req(session('foreman'))), (e) => e.statusCode === 403 && e.code === 'forbidden');
    await assert.rejects(admin(req(session('office'))), (e) => e.statusCode === 403);
    await admin(req(session('admin')));
    await write(req(session('office')));
    await assert.rejects(write(req(session('owner'), false)), (e) => e.statusCode === 403 && e.code === 'mfa_required' && /two-step/.test(e.message));
    await office(req(session('office'), false), 'reads do not need it');
    assert.throws(() => requireQboRole('boss'));
  });
});

test('deploy kits: env names, set-env plain names and the nginx webhook zone', () => {
  const names = ['QBO_ENVIRONMENT', 'QBO_CLIENT_ID', 'QBO_CLIENT_SECRET', 'QBO_WEBHOOK_VERIFIER', 'QBO_WEBHOOK_VERIFIER_PREVIOUS', 'QBO_WRITES',
    'QBO_READ_BUDGET', 'QBO_TENANT_READ_BUDGET', 'QBO_TRIAL_READ_BUDGET', 'WORKER_QBO_CONCURRENCY'];
  for (const f of ['server/.env.example', 'deploy/staging/.env.example', 'deploy/production/.env.example']) {
    const text = read(f);
    for (const n of names) assert.match(text, new RegExp(`^${n}=`, 'm'), `${f}: ${n}`);
  }
  assert.ok(!/^QBO_API_BASE=/m.test(read('deploy/staging/.env.example')), 'test-only names stay out of the deploy kits');
  const setEnv = read('deploy/set-env.sh');
  const plain = /QBO_ENVIRONMENT\|QBO_CLIENT_ID\|QBO_WRITES[^)]*\) PLAIN=1/.exec(setEnv);
  assert.ok(plain, 'QBO_ENVIRONMENT, QBO_CLIENT_ID and QBO_WRITES are shown plain');
  assert.ok(!/QBO_CLIENT_SECRET|QBO_WEBHOOK_VERIFIER/.test(plain[0]), 'secrets stay hidden');
  assert.match(read('deploy/staging/nginx-http.conf'), /limit_req_zone \$fishtape_staging_webhook_key zone=fishtape_staging_webhooks/);
  assert.match(read('deploy/staging/nginx-api.conf.snippet'), /location \^~ \/api\/v1\/webhooks\/ \{\n[^}]*limit_req zone=fishtape_staging_webhooks/);
  const prod = read('deploy/production/nginx/fishtape.conf');
  assert.match(prod, /limit_req_zone \$fishtape_webhook_key zone=fishtape_webhooks/);
  assert.match(prod, /location \^~ \/api\/v1\/webhooks\/ \{\n\s*limit_req zone=fishtape_webhooks/);
});

describe('fake QuickBooks maths and faults', () => {
  const fake = createFakeQbo();
  const c = fake.addCompany('77');
  const cust = fake.create('77', 'Customer', { DisplayName: 'Kenora Hydro' });
  const s = c.seed;
  const line = (amount, code, qty = 1) => ({ DetailType: 'SalesItemLineDetail', Amount: amount, SalesItemLineDetail: { ItemRef: { value: s.items.materials.Id }, Qty: qty, UnitPrice: amount / qty, TaxCodeRef: { value: code } } });

  test('GST/PST MB: two tax lines, rounded per rate on summed amounts', () => {
    const inv = fake.create('77', 'Invoice', { CustomerRef: { value: cust.Id }, DocNumber: 'INV-1', Line: [line(10.05, s.taxCodes.gstPst.Id), line(10.05, s.taxCodes.gstPst.Id)] });
    assert.equal(inv.TxnTaxDetail.TaxLine.length, 2);
    assert.deepEqual(inv.TxnTaxDetail.TaxLine.map((t) => t.Amount).sort(), [1.01, 1.41]);
    assert.equal(inv.TotalAmt, 22.52);
    assert.equal(inv.Balance, 22.52);
    assert.throws(() => fake.create('77', 'Invoice', { CustomerRef: { value: cust.Id }, DocNumber: 'INV-1', Line: [line(1, s.taxCodes.gst.Id)] }), (e) => e.code === '6140');
  });

  test('overrides accepted unless the rate is read-only; amount rule; duplicate names', () => {
    const over = fake.create('77', 'Invoice', { CustomerRef: { value: cust.Id }, Line: [line(100, s.taxCodes.gst.Id)], TxnTaxDetail: { TaxLine: [{ Amount: 5.01, TaxLineDetail: { TaxRateRef: { value: s.taxRates.gst.Id } } }] } });
    assert.equal(over.TxnTaxDetail.TotalTax, 5.01);
    fake.company('77').objects.TaxRate.get(s.taxRates.gst.Id).ReadOnly = true;
    assert.throws(() => fake.create('77', 'Invoice', { CustomerRef: { value: cust.Id }, Line: [line(100, s.taxCodes.gst.Id)], TxnTaxDetail: { TaxLine: [{ Amount: 5.01, TaxLineDetail: { TaxRateRef: { value: s.taxRates.gst.Id } } }] } }), (e) => /-37100/.test(e.detail));
    fake.company('77').objects.TaxRate.get(s.taxRates.gst.Id).ReadOnly = false;
    assert.throws(() => fake.create('77', 'Invoice', { CustomerRef: { value: cust.Id }, Line: [{ DetailType: 'SalesItemLineDetail', Amount: 248.33, SalesItemLineDetail: { ItemRef: { value: '1' }, Qty: 2.6667, UnitPrice: 95, TaxCodeRef: { value: s.taxCodes.gst.Id } } }] }),
      (e) => e.code === '6000' && /UnitPrice x Qty/.test(e.detail));
    assert.throws(() => fake.create('77', 'Vendor', { DisplayName: 'kenora hydro' }), (e) => e.code === '6240');
  });

  test('payments over several invoices, a credit memo and an unapplied amount; void unapplies', () => {
    const a = fake.create('77', 'Invoice', { CustomerRef: { value: cust.Id }, Line: [line(100, s.taxCodes.oos.Id)] });
    const b = fake.create('77', 'Invoice', { CustomerRef: { value: cust.Id }, Line: [line(50, s.taxCodes.oos.Id)] });
    const cm = fake.create('77', 'CreditMemo', { CustomerRef: { value: cust.Id }, Line: [line(20, s.taxCodes.oos.Id)] });
    const p = fake.create('77', 'Payment', { CustomerRef: { value: cust.Id }, TotalAmt: 640, Line: [
      { Amount: 100, LinkedTxn: [{ TxnId: a.Id, TxnType: 'Invoice' }] },
      { Amount: 50, LinkedTxn: [{ TxnId: b.Id, TxnType: 'Invoice' }] },
      { Amount: 10, LinkedTxn: [{ TxnId: cm.Id, TxnType: 'CreditMemo' }] },
    ] });
    assert.equal(fake.get('77', 'Invoice', a.Id).Balance, 0);
    assert.equal(fake.get('77', 'CreditMemo', cm.Id).RemainingCredit, 10);
    assert.equal(fake.get('77', 'Payment', p.Id).UnappliedAmt, 500);
    fake.void('77', 'Invoice', a.Id);
    assert.equal(fake.get('77', 'Payment', p.Id).Line.length, 2, 'the void unapplied the payment line');
    assert.equal(fake.get('77', 'Payment', p.Id).UnappliedAmt, 600);
    assert.equal(fake.get('77', 'Invoice', a.Id).PrivateNote.startsWith('Voided'), true);
    fake.create('77', 'Deposit', { Line: [{ Amount: 640, LinkedTxn: [{ TxnId: p.Id, TxnType: 'Payment' }] }] });
    assert.throws(() => fake.void('77', 'Payment', p.Id), (e) => /deposit/.test(e.detail));
    assert.throws(() => fake.edit('77', 'Customer', cust.Id, { Active: false }), (e) => /open balance/.test(e.detail));
  });

  test('webhook events for the changes it made, signed with a verifier', () => {
    const r = fake.create('77', 'Customer', { DisplayName: "O'Hara Electric" });
    fake.destroy('77', 'Customer', r.Id);
    const events = fake.webhookEvents('77');
    assert.ok(events.some((e) => e.type === 'qbo.customer.deleted.v1' && e.intuitentityid === r.Id));
    assert.ok(events.every((e) => e.intuitaccountid === '77'));
    const raw = Buffer.from(JSON.stringify(events));
    assert.equal(verifyIntuitSignature(raw, fake.sign(raw, 'v1'), ['v1']), true);
    assert.equal(parseWebhook(raw).length, events.length);
  });
});
