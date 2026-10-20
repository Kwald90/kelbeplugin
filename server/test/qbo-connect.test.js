// The QuickBooks connection at service level against the fake QuickBooks and a real Postgres
// (docs/integrations/quickbooks.md section 2, 11.3 W1): ticket, interstitial, start, callback success
// and every failure, the same-company rule (purge_required, wrong_company), the revoke rule, takeover,
// token single-flight with the row lease and no transaction open during the call, rotation stored,
// invalid_grant after the re-read, the platform token breaker and the mass-revoke guard, the
// environment check, pause and resume, disconnect with and without purge, failed revokes, the
// housekeeping and purge jobs, and the realm re-hash script.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { skip, createTestDatabase } from './support/db.js';
import { createFakeQbo, connectViaFake } from './support/fake-qbo.js';
import { readConfig } from '../src/config.js';
import { createSealer } from '../src/lib/crypto.js';
import { setFetch } from '../src/integrations/http.js';
import { hashSecret } from '../src/auth/passwords.js';
import { createTenantWithOwner } from '../src/services/tenants.js';
import { getSecret, setSecret } from '../src/services/secrets.js';
import {
  SECRET_NAMES, completeCallback, createConnectTicket, disconnect, hasTakeoverOffer, loadConnection, qboRealmOwner, realmHash,
  resetTokenBreaker, setPaused, startFromTicket, startPage, takeover, tenantForRealm, tokenBreakerOpen, withAccessToken,
} from '../src/qbo/connection.js';
import { createQboPlatformHandlers, scheduleQboPlatformJobs } from '../src/qbo/platform-jobs.js';
import { refreshTokens } from '../src/qbo/oauth.js';
import { rehashRealms } from '../scripts/qbo-rehash.js';

const KEY = randomBytes(32).toString('base64');
const fake = createFakeQbo();
const mkConfig = (env = {}) => readConfig({
  APP_ENV: 'test', SECRETS_MASTER_KEY: KEY, PUBLIC_ORIGIN: 'https://app.fishtape.test', QBO_ENVIRONMENT: 'sandbox',
  QBO_CLIENT_ID: fake.app.clientId, QBO_CLIENT_SECRET: fake.app.clientSecret, QBO_WEBHOOK_VERIFIER: 'v1', ...env,
});
const config = mkConfig();
const sealer = createSealer(KEY);
const INTERNAL = { internal: true };
let t;
let realmN = 0;
const newRealm = (o) => { const id = `46208163${String(++realmN).padStart(8, '0')}`; fake.addCompany(id, o); return id; };

async function mkTenant(name) {
  const r = await createTenantWithOwner(t.db, { name, owner: { email: `${randomBytes(4).toString('hex')}@example.test`, password: 'pw-long-enough-123', displayName: `${name} Owner` } });
  return { tenantId: r.tenant.id, userId: r.userId, name };
}
async function addUser(tenantId, role) {
  const u = await t.superPool.query('INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id',
    [`${role}-${randomBytes(4).toString('hex')}@example.test`, `${role} person`, await hashSecret('pw-long-enough-123')]);
  await t.superPool.query('INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)', [tenantId, u.rows[0].id, role]);
  return u.rows[0].id;
}
const conn = (tenantId) => t.db.withTenant({ tenantId }, loadConnection);
const secret = (tenantId, name) => t.db.withTenant({ tenantId }, (tx) => getSecret(tx, sealer, name, INTERNAL));
const connect = (who, realmId, o = {}) => connectViaFake(fake, { db: t.db, sealer, config: o.config || config, tenantId: who.tenantId, userId: o.userId || who.userId, realmId, ...o });
const expire = (tenantId) => t.db.withTenant({ tenantId }, (tx) => tx.query("UPDATE qbo_connections SET access_expires_at = now() - interval '1 minute' WHERE tenant_id = $1", [tenantId]));
const audits = async (tenantId, action) => (await t.superPool.query('SELECT summary FROM audit_events WHERE tenant_id = $1 AND action = $2', [tenantId, action])).rows;
const notes = async (tenantId, like) => (await t.superPool.query('SELECT title, body, ref FROM notifications WHERE tenant_id = $1 AND ref LIKE $2', [tenantId, like])).rows;
const events = async (kind, tenantId) => (await t.superPool.query('SELECT count(*)::int AS n FROM qbo_platform_events WHERE kind = $1 AND tenant_id IS NOT DISTINCT FROM $2', [kind, tenantId])).rows[0].n;
const ticketOf = (url) => new URL(url).searchParams.get('ticket');
const resultOf = (url) => new URL(url).searchParams.get('result') ?? new URL(url.replace('#/quickbooks?', '?')).searchParams.get('connect');

before(async () => {
  if (skip) return;
  setFetch((u, i) => fake.fetch(u, i));
  t = await createTestDatabase('qboconnect');
});
after(async () => { setFetch(null); await t?.close(); });

describe('connect', { skip }, () => {
  test('ticket: enabled server, owner or admin, plan, not already connected; 43-character single-use ticket', async () => {
    const A = await mkTenant('Ticket Electric');
    const office = await addUser(A.tenantId, 'office');
    await assert.rejects(createConnectTicket(t.db, mkConfig({ QBO_ENVIRONMENT: '' }), { tenantId: A.tenantId, userId: A.userId, returnTo: 'web' }), (e) => e.statusCode === 503 && e.code === 'qbo_unavailable');
    await assert.rejects(createConnectTicket(t.db, config, { tenantId: A.tenantId, userId: office, returnTo: 'web' }), (e) => e.statusCode === 403);
    await assert.rejects(createConnectTicket(t.db, config, { tenantId: A.tenantId, userId: A.userId, returnTo: 'mail' }), (e) => e.statusCode === 400);
    await assert.rejects(createConnectTicket(t.db, config, { tenantId: A.tenantId, userId: A.userId, returnTo: 'web', reconnect: true }), (e) => e.code === 'qbo_not_connected');
    await t.superPool.query("UPDATE tenants SET plan = 'starter' WHERE id = $1", [A.tenantId]);
    await assert.rejects(createConnectTicket(t.db, config, { tenantId: A.tenantId, userId: A.userId, returnTo: 'web' }), (e) => e.code === 'feature_not_in_plan');
    await t.superPool.query("UPDATE tenants SET plan = 'pro' WHERE id = $1", [A.tenantId]);
    const { url } = await createConnectTicket(t.db, config, { tenantId: A.tenantId, userId: A.userId, returnTo: 'app' });
    assert.match(url, /^https:\/\/app\.fishtape\.test\/api\/v1\/qbo\/oauth\/start\?ticket=[A-Za-z0-9_-]{43}$/);
    const { rows } = await t.superPool.query("SELECT expires_at - created_at AS ttl, stage FROM qbo_oauth_states WHERE tenant_id = $1", [A.tenantId]);
    assert.equal(rows[0].stage, 'ticket');
    assert.equal(rows[0].ttl.minutes * 60 + (rows[0].ttl.seconds || 0), 120);
    assert.equal((await connect(A, newRealm())).result, 'ok');
    await assert.rejects(createConnectTicket(t.db, config, { tenantId: A.tenantId, userId: A.userId, returnTo: 'web' }), (e) => e.code === 'qbo_already_connected');
  });

  test('interstitial: names the company and requester, does not consume the ticket; web tickets need the issuer session', async () => {
    const A = await mkTenant('Interstitial <Co>');
    const web = await createConnectTicket(t.db, config, { tenantId: A.tenantId, userId: A.userId, returnTo: 'web' });
    const ticket = ticketOf(web.url);
    const other = await addUser(A.tenantId, 'admin');
    assert.equal(resultOf((await startPage(t.db, config, ticket, { sessionUserId: null })).redirect), 'state_invalid');
    assert.equal(resultOf((await startPage(t.db, config, ticket, { sessionUserId: other })).redirect), 'state_invalid');
    const page = await startPage(t.db, config, ticket, { sessionUserId: A.userId });
    assert.ok(page.html.includes('Interstitial &lt;Co&gt;'));
    assert.match(page.headers['content-security-policy'], /form-action 'self' https:\/\/appcenter\.intuit\.com/);
    assert.ok(await startPage(t.db, config, ticket, { sessionUserId: A.userId }).then((p) => p.html), 'still usable');
    const app = await createConnectTicket(t.db, config, { tenantId: A.tenantId, userId: A.userId, returnTo: 'app' });
    assert.ok((await startPage(t.db, config, ticketOf(app.url), {})).html, 'app tickets open in the system browser without a session');
    assert.equal(resultOf((await startPage(t.db, config, 'x'.repeat(43), {})).redirect), 'state_invalid');
    assert.equal(resultOf((await startPage(t.db, config, '../etc', {})).redirect), 'state_invalid');
  });

  test('start: consumes the ticket once, stores only hashes, and sends the browser to Intuit', async () => {
    const A = await mkTenant('Start Electric');
    const { url } = await createConnectTicket(t.db, config, { tenantId: A.tenantId, userId: A.userId, returnTo: 'web' });
    const s = await startFromTicket(t.db, sealer, config, ticketOf(url));
    const to = new URL(s.redirect);
    assert.equal(to.origin + to.pathname, 'https://appcenter.intuit.com/connect/oauth2');
    assert.match(s.flowCookie, /^[A-Za-z0-9_-]{43}$/);
    const { rows } = await t.superPool.query('SELECT stage, state_hash, flow_hash, expires_at - now() AS left FROM qbo_oauth_states WHERE tenant_id = $1', [A.tenantId]);
    assert.equal(rows[0].stage, 'authorizing');
    assert.equal(rows[0].state_hash.length, 32);
    assert.ok(rows[0].left.minutes >= 9);
    assert.equal(resultOf((await startFromTicket(t.db, sealer, config, ticketOf(url))).redirect), 'state_invalid', 'single use');
    const late = await createConnectTicket(t.db, config, { tenantId: A.tenantId, userId: A.userId, returnTo: 'app' });
    await t.superPool.query("UPDATE qbo_oauth_states SET expires_at = now() - interval '1 second' WHERE stage = 'ticket' AND tenant_id = $1", [A.tenantId]);
    assert.equal(resultOf((await startFromTicket(t.db, sealer, config, ticketOf(late.url))).redirect), 'state_invalid', 'expired');
  });

  test('callback success: tokens sealed, realm row, setup state, audit, office notice, reference refresh queued; nothing secret in the redirect', async () => {
    const A = await mkTenant('Success Electric');
    const office = await addUser(A.tenantId, 'office');
    const realm = newRealm({ name: 'Success Books Inc.' });
    const r = await connect(A, realm, { returnTo: 'web' });
    assert.equal(r.result, 'ok');
    assert.equal(r.redirect, 'https://app.fishtape.test/#/quickbooks?connect=ok');
    assert.equal(r.tenantId, A.tenantId);
    const c = await conn(A.tenantId);
    assert.equal(c.state, 'setup');
    assert.equal(c.environment, 'sandbox');
    assert.equal(c.company_name, 'Success Books Inc.');
    assert.equal(c.features.edition, 'QuickBooks Online Plus');
    assert.ok(c.access_expires_at > new Date());
    assert.ok(c.refresh_hard_expires_at > new Date(Date.now() + 4 * 365 * 86400_000));
    assert.ok(Buffer.from(c.realm_hash).equals(realmHash(sealer, config, realm)));
    assert.equal(await qboRealmOwner(t.db, realmHash(sealer, config, realm)), A.tenantId);
    assert.equal(await tenantForRealm(t.db, sealer, config, realm), A.tenantId);
    assert.equal(await secret(A.tenantId, SECRET_NAMES.realm), realm);
    const raw = await t.superPool.query('SELECT name, value_enc FROM tenant_secrets WHERE tenant_id = $1 ORDER BY name', [A.tenantId]);
    assert.deepEqual(raw.rows.map((x) => x.name), ['qbo.access_token', 'qbo.realm_id', 'qbo.refresh_token']);
    for (const x of raw.rows) assert.ok(!x.value_enc.includes(realm) && !x.value_enc.includes('fake'), 'encrypted at rest');
    assert.equal((await audits(A.tenantId, 'qbo.connect')).length, 1);
    assert.ok(!(await audits(A.tenantId, 'qbo.connect'))[0].summary.includes(realm));
    const n = await t.superPool.query("SELECT title FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND kind = 'quickbooks'", [A.tenantId, office]);
    assert.match(n.rows[0].title, /Success Books Inc\./, 'every office user learns which company was connected');
    const jobs = await t.superPool.query("SELECT kind FROM jobs_queue WHERE tenant_id = $1 AND kind LIKE 'qbo%'", [A.tenantId]);
    assert.deepEqual(jobs.rows.map((j) => j.kind), ['qbo_reference_refresh']);
    assert.equal((await t.superPool.query('SELECT count(*)::int AS n FROM qbo_oauth_states WHERE tenant_id = $1', [A.tenantId])).rows[0].n, 0);
  });

  test('callback failures in order: state, flow cookie, session, role, plan, cancel, exchange', async () => {
    const A = await mkTenant('Failing Electric');
    const realm = newRealm();
    const begin = async (returnTo = 'web', userId = A.userId) => {
      const { url } = await createConnectTicket(t.db, config, { tenantId: A.tenantId, userId, returnTo });
      const s = await startFromTicket(t.db, sealer, config, ticketOf(url));
      const back = await fake.authorize(s.redirect, { realmId: realm });
      return { s, back, cb: (o = {}) => completeCallback(t.db, sealer, config, { code: back.code, state: back.state, realmId: back.realmId, flowCookie: s.flowCookie, sessionUserId: userId, ...o }) };
    };
    assert.equal((await completeCallback(t.db, sealer, config, { code: 'c', state: 'nope', realmId: realm, flowCookie: 'x' })).result, 'state_invalid');
    let f = await begin();
    assert.equal((await f.cb({ flowCookie: 'wrong'.padEnd(43, 'x') })).result, 'state_invalid');
    assert.equal((await f.cb()).result, 'state_invalid', 'the row went with the first try (single use)');
    f = await begin();
    assert.equal((await f.cb({ flowCookie: undefined })).result, 'state_invalid');
    f = await begin();
    assert.equal((await f.cb({ sessionUserId: await addUser(A.tenantId, 'admin') })).result, 'state_invalid', 'web: another session');
    const admin = await addUser(A.tenantId, 'admin');
    f = await begin('app', admin);
    await t.superPool.query("UPDATE memberships SET role = 'office' WHERE user_id = $1", [admin]);
    const demoted = await f.cb();
    assert.equal(demoted.result, 'forbidden');
    assert.equal(demoted.redirect, 'https://app.fishtape.test/api/v1/qbo/oauth/done?result=forbidden');
    f = await begin();
    await t.superPool.query("UPDATE tenants SET plan = 'starter' WHERE id = $1", [A.tenantId]);
    assert.equal((await f.cb()).result, 'plan');
    await t.superPool.query("UPDATE tenants SET plan = 'pro' WHERE id = $1", [A.tenantId]);
    f = await begin();
    assert.equal((await f.cb({ code: undefined, error: 'access_denied' })).result, 'denied');
    f = await begin();
    fake.failToken({ error: 'invalid_grant' });
    assert.equal((await f.cb()).result, 'exchange_failed');
    assert.equal(await conn(A.tenantId), null, 'nothing stored');
    assert.equal((await t.superPool.query('SELECT count(*)::int AS n FROM tenant_secrets WHERE tenant_id = $1', [A.tenantId])).rows[0].n, 0);
  });

  test('not a Canadian or CAD company: refused and the new grant revoked (no one holds the realm)', async () => {
    const A = await mkTenant('Border Electric');
    const us = newRealm({ country: 'US' });
    assert.equal((await connect(A, us)).result, 'not_canada');
    assert.equal(fake.grantAlive(us), false, 'revoked');
    const usd = newRealm({ currency: 'USD' });
    assert.equal((await connect(A, usd)).result, 'not_cad');
    assert.equal(fake.grantAlive(usd), false);
    assert.equal(await conn(A.tenantId), null);
  });

  test('realm_in_use: never revoked, the holder keeps working, and a takeover offer is kept for 10 minutes', async () => {
    const A = await mkTenant('Holder Electric');
    const B = await mkTenant('Squatter Trial');
    const realm = newRealm({ name: 'Holder Books' });
    assert.equal((await connect(A, realm)).result, 'ok');
    const r = await connect(B, realm);
    assert.equal(r.result, 'realm_in_use');
    assert.equal(fake.grantAlive(realm), true, 'no revoke: it would end A\'s grant too');
    await expire(A.tenantId);
    assert.ok((await withAccessToken(t.db, sealer, config, A.tenantId)).accessToken, 'A still refreshes');
    assert.equal(await hasTakeoverOffer(t.db, B.tenantId, B.userId), true);
    assert.equal(await conn(B.tenantId), null);
  });

  test('same company rule: another realm after a disconnect without purge is purge_required; a reconnect elsewhere is wrong_company', async () => {
    const A = await mkTenant('Same Company Electric');
    const first = newRealm();
    assert.equal((await connect(A, first)).result, 'ok');
    await t.db.withTenant({ tenantId: A.tenantId }, (tx) => tx.query(
      "INSERT INTO qbo_links (tenant_id, realm_hash, collection, record_id, qbo_entity, qbo_id, state) SELECT tenant_id, realm_hash, 'clients', 'c-1', 'Customer', '58', 'synced' FROM qbo_connections"));
    const other = newRealm();
    const wrong = await connect(A, other, { reconnect: true });
    assert.equal(wrong.result, 'wrong_company');
    assert.equal(fake.grantAlive(other), false, 'nobody holds the other realm: revoked');
    assert.equal(await secret(A.tenantId, SECRET_NAMES.realm), first, 'nothing replaced');
    await disconnect(t.db, sealer, config, A.tenantId, { purge: false });
    const third = newRealm();
    assert.equal((await connect(A, third)).result, 'purge_required');
    assert.equal(fake.grantAlive(third), false);
    const links = await t.db.withTenant({ tenantId: A.tenantId }, (tx) => tx.query('SELECT qbo_id FROM qbo_links'));
    assert.equal(links.rows.length, 1, 'old links untouched, never sent anywhere');
    const prod = mkConfig({ QBO_ENVIRONMENT: 'production' });
    assert.equal((await connect(A, first, { config: prod })).result, 'purge_required', 'the other environment counts as another company');
    assert.equal((await connect(A, first)).result, 'ok', 'the same company reconnects and keeps its links');
    assert.equal((await t.db.withTenant({ tenantId: A.tenantId }, (tx) => tx.query('SELECT 1 FROM qbo_links'))).rows.length, 1);
    assert.equal((await audits(A.tenantId, 'qbo.reconnect')).length, 1);
  });

  test('takeover: the old tenant is disconnected and purged without revoke; the caller is connected; both audited; owners emailed', async () => {
    const A = await mkTenant('Old Holder');
    const B = await mkTenant('Rightful Owner');
    const realm = newRealm({ name: 'Rightful Books' });
    assert.equal((await connect(A, realm)).result, 'ok');
    await t.db.withTenant({ tenantId: A.tenantId }, (tx) => tx.query(
      "INSERT INTO qbo_outbox (tenant_id, collection, record_id, op, rank) VALUES ($1, 'clients', 'c-9', 'upsert', 10)", [A.tenantId]));
    await assert.rejects(takeover(t.db, sealer, config, { tenantId: B.tenantId, userId: B.userId }), (e) => e.statusCode === 404);
    assert.equal((await connect(B, realm)).result, 'realm_in_use');
    const office = await addUser(B.tenantId, 'office');
    await assert.rejects(takeover(t.db, sealer, config, { tenantId: B.tenantId, userId: office }), (e) => e.statusCode === 404, 'only the caller\'s own offer');
    assert.deepEqual(await takeover(t.db, sealer, config, { tenantId: B.tenantId, userId: B.userId }), { ok: true });
    assert.equal(await qboRealmOwner(t.db, realmHash(sealer, config, realm)), B.tenantId);
    assert.equal(await conn(A.tenantId), null, 'purged');
    assert.equal((await t.db.withTenant({ tenantId: A.tenantId }, (tx) => tx.query('SELECT 1 FROM qbo_outbox'))).rows.length, 0);
    assert.equal((await t.superPool.query('SELECT count(*)::int AS n FROM tenant_secrets WHERE tenant_id = $1', [A.tenantId])).rows[0].n, 0);
    assert.equal(fake.grantAlive(realm), true, 'no revoke: the grant now belongs to B');
    assert.equal((await conn(B.tenantId)).state, 'setup');
    assert.ok((await withAccessToken(t.db, sealer, config, B.tenantId)).accessToken);
    assert.equal((await audits(A.tenantId, 'qbo.takeover')).length, 1);
    assert.equal((await audits(B.tenantId, 'qbo.takeover')).length, 1);
    const mail = await t.superPool.query("SELECT subject, text_body FROM email_outbox WHERE tenant_id = $1 AND template = 'qbo-takeover'", [A.tenantId]);
    assert.equal(mail.rows.length, 1);
    assert.match(mail.rows[0].text_body, /QuickBooks company Rightful Books was connected to another Fishtape company by a QuickBooks admin/);
    assert.ok(!mail.rows[0].text_body.includes('Rightful Owner'), 'the other tenant is never named');
    await assert.rejects(takeover(t.db, sealer, config, { tenantId: B.tenantId, userId: B.userId }), (e) => e.statusCode === 404, 'single use');
  });
});

describe('tokens', { skip }, () => {
  let A, realm;
  before(async () => {
    A = await mkTenant('Token Electric');
    realm = newRealm();
    assert.equal((await connect(A, realm)).result, 'ok');
  });

  test('a fresh token is returned without calling Intuit; an expiring one is refreshed and the rotated token stored', async () => {
    const calls = fake.state.tokenCalls.length;
    const one = await withAccessToken(t.db, sealer, config, A.tenantId);
    assert.equal(one.realmId, realm);
    assert.equal(fake.state.tokenCalls.length, calls);
    const oldRefresh = await secret(A.tenantId, SECRET_NAMES.refresh);
    await expire(A.tenantId);
    const two = await withAccessToken(t.db, sealer, config, A.tenantId);
    assert.notEqual(two.accessToken, one.accessToken);
    assert.equal(fake.state.tokenCalls.length, calls + 1);
    assert.notEqual(await secret(A.tenantId, SECRET_NAMES.refresh), oldRefresh, 'rotation stored');
    const c = await conn(A.tenantId);
    assert.equal(c.refreshing_until, null);
    assert.ok(c.last_refresh_at > new Date(Date.now() - 60_000));
  });

  test('single flight: concurrent callers make one refresh, and no transaction is open during the call', async () => {
    await expire(A.tenantId);
    const calls = fake.state.tokenCalls.length;
    let idleInTx = null;
    fake.beforeToken(async () => {
      const { rows } = await t.superPool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'");
      idleInTx = rows[0].n;
    });
    const all = await Promise.all([1, 2, 3, 4].map(() => withAccessToken(t.db, sealer, config, A.tenantId)));
    fake.beforeToken(null);
    assert.equal(fake.state.tokenCalls.length, calls + 1);
    assert.equal(new Set(all.map((x) => x.accessToken)).size, 1);
    assert.equal(idleInTx, 0, 'no transaction held across the Intuit call');
  });

  test('another process holding the refresh lease: wait for it, then take over when it lapses', async () => {
    await expire(A.tenantId);
    await t.db.withTenant({ tenantId: A.tenantId }, (tx) => tx.query("UPDATE qbo_connections SET refreshing_until = now() + interval '700 milliseconds' WHERE tenant_id = $1", [A.tenantId]));
    const calls = fake.state.tokenCalls.length;
    const started = Date.now();
    assert.ok((await withAccessToken(t.db, sealer, config, A.tenantId)).accessToken);
    assert.ok(Date.now() - started >= 500, 'waited for the lease');
    assert.equal(fake.state.tokenCalls.length, calls + 1);
  });

  test('invalid_grant after a rotation elsewhere: the stored token is re-read and used once', async () => {
    const stale = await secret(A.tenantId, SECRET_NAMES.refresh);
    const rotated = await refreshTokens(config, stale); // "another process" rotated it; stale is now dead
    let first = true;
    fake.beforeToken(async () => {
      if (!first) return;
      first = false;
      await t.db.withTenant({ tenantId: A.tenantId }, (tx) => setSecret(tx, sealer, SECRET_NAMES.refresh, rotated.refreshToken, 'test', INTERNAL));
    });
    await t.db.withTenant({ tenantId: A.tenantId }, (tx) => setSecret(tx, sealer, SECRET_NAMES.refresh, stale, 'test', INTERNAL));
    await expire(A.tenantId);
    assert.ok((await withAccessToken(t.db, sealer, config, A.tenantId)).accessToken);
    fake.beforeToken(null);
    assert.equal((await conn(A.tenantId)).state, 'setup');
  });

  test('invalid_grant twice (disconnected inside QuickBooks): reconnect_needed/revoked, notice once a day, audit, event', async () => {
    const B = await mkTenant('Revoked Electric');
    const office = await addUser(B.tenantId, 'office');
    const r = newRealm();
    await connect(B, r);
    fake.revokeRealm(r);
    await expire(B.tenantId);
    await assert.rejects(withAccessToken(t.db, sealer, config, B.tenantId), (e) => e.kind === 'auth' && e.code === 'qbo_reconnect_needed');
    const c = await conn(B.tenantId);
    assert.equal(c.state, 'reconnect_needed');
    assert.equal(c.reconnect_reason, 'revoked');
    assert.equal(c.state_before, 'setup');
    const n = await t.superPool.query("SELECT ref FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND ref LIKE 'qbo:reconnect:%'", [B.tenantId, office]);
    assert.equal(n.rows.length, 1);
    assert.equal((await audits(B.tenantId, 'qbo.reconnect_needed')).length, 1);
    assert.equal(await events('invalid_grant', B.tenantId), 1);
    await assert.rejects(withAccessToken(t.db, sealer, config, B.tenantId), (e) => e.kind === 'auth');
    // Reconnecting the same company puts the state back.
    assert.equal((await connect(B, r, { reconnect: true })).result, 'ok');
    assert.equal((await conn(B.tenantId)).state, 'setup');
  });

  test('invalid_client: tenant states unchanged, the breaker opens for everyone, and HQ is told', async () => {
    resetTokenBreaker();
    await expire(A.tenantId);
    fake.failToken({ error: 'invalid_client' });
    await assert.rejects(withAccessToken(t.db, sealer, config, A.tenantId), (e) => e.kind === 'unavailable' && e.retry);
    assert.equal((await conn(A.tenantId)).state, 'setup');
    assert.equal(tokenBreakerOpen(), true);
    assert.equal(await events('platform_credentials', A.tenantId), 1);
    const calls = fake.state.tokenCalls.length;
    await assert.rejects(withAccessToken(t.db, sealer, config, A.tenantId), (e) => e.variant === 'breaker');
    assert.equal(fake.state.tokenCalls.length, calls, 'no token call while open');
    resetTokenBreaker();
    assert.ok((await withAccessToken(t.db, sealer, config, A.tenantId)).accessToken);
  });

  test('mass revoke guard: with 5 other tenants on invalid_grant in 15 minutes the next one is not marked', async () => {
    for (let i = 0; i < 5; i++) {
      const { rows } = await t.superPool.query("INSERT INTO tenants (slug, name) VALUES ($1, 'Guard') RETURNING id", [`guard-${randomBytes(4).toString('hex')}`]);
      await t.superPool.query("INSERT INTO qbo_platform_events (kind, environment, tenant_id) VALUES ('invalid_grant', 'sandbox', $1)", [rows[0].id]);
    }
    const C = await mkTenant('Guarded Electric');
    const r = newRealm();
    await connect(C, r);
    fake.revokeRealm(r);
    await expire(C.tenantId);
    await assert.rejects(withAccessToken(t.db, sealer, config, C.tenantId), (e) => e.kind === 'unavailable' && e.retry);
    assert.equal((await conn(C.tenantId)).state, 'setup', 'left for a person to look at');
    await t.superPool.query("DELETE FROM qbo_platform_events WHERE kind = 'invalid_grant'");
  });

  test('environment changed on the server: reconnect_needed/environment with no call to Intuit', async () => {
    const D = await mkTenant('Moved Electric');
    await connect(D, newRealm());
    const before = fake.calls.length;
    await assert.rejects(withAccessToken(t.db, sealer, mkConfig({ QBO_ENVIRONMENT: 'production' }), D.tenantId), (e) => e.kind === 'auth');
    assert.equal(fake.calls.length, before);
    const c = await conn(D.tenantId);
    assert.deepEqual([c.state, c.reconnect_reason], ['reconnect_needed', 'environment']);
  });
});

describe('pause, disconnect, housekeeping', { skip }, () => {
  test('pause and resume: reasons are locked to who set them; the brake needs the count; resuming to active queues the sweep', async () => {
    const A = await mkTenant('Pause Electric');
    await connect(A, newRealm());
    await t.db.withTenant({ tenantId: A.tenantId }, (tx) => tx.query("UPDATE qbo_connections SET state = 'active' WHERE tenant_id = $1", [A.tenantId]));
    const epoch = (await conn(A.tenantId)).lease_epoch;
    await setPaused(t.db, A.tenantId, true, 'hq');
    let c = await conn(A.tenantId);
    assert.deepEqual([c.state, c.pause_reason, c.state_before], ['paused', 'hq', 'active']);
    assert.ok(c.lease_epoch > epoch, 'fenced');
    await assert.rejects(setPaused(t.db, A.tenantId, false, 'user'), (e) => e.code === 'qbo_pause_locked');
    await setPaused(t.db, A.tenantId, false, 'hq');
    assert.equal((await conn(A.tenantId)).state, 'active');
    await setPaused(t.db, A.tenantId, true, 'brake', { allowCount: 742 });
    await assert.rejects(setPaused(t.db, A.tenantId, false, 'user', { allowCount: 10 }), (e) => e.code === 'qbo_brake_count' && e.details.count === 742);
    await t.superPool.query("DELETE FROM jobs_queue WHERE tenant_id = $1", [A.tenantId]);
    await setPaused(t.db, A.tenantId, false, 'user', { allowCount: 742 });
    c = await conn(A.tenantId);
    assert.equal(c.state, 'active');
    assert.equal(c.brake_allow_count, 742);
    assert.ok(c.brake_allow_until > new Date());
    const jobs = await t.superPool.query("SELECT payload, dedupe_key FROM jobs_queue WHERE tenant_id = $1 AND kind = 'qbo_sync'", [A.tenantId]);
    assert.deepEqual(jobs.rows[0].payload, { sweep: true });
    assert.equal(jobs.rows[0].dedupe_key, `qbo_sync:${A.tenantId}:sweep`);
  });

  test('disconnect without purge: revoked, secrets and realm row and queued jobs gone, the outbox kept, purge in 30 days', async () => {
    const A = await mkTenant('Leaving Electric');
    const realm = newRealm();
    await connect(A, realm);
    await t.db.withTenant({ tenantId: A.tenantId }, async (tx) => {
      await tx.query("INSERT INTO qbo_outbox (tenant_id, collection, record_id, op, rank) VALUES ($1, 'invoices', 'inv-1', 'upsert', 40)", [A.tenantId]);
      await tx.query("INSERT INTO jobs_queue (kind, tenant_id) VALUES ('qbo_sync', $1), ('integrations_send', $1)", [A.tenantId]);
    });
    const r = await disconnect(t.db, sealer, config, A.tenantId, { actor: { type: 'user', id: A.userId, label: 'Owner' } });
    assert.deepEqual(r, { purged: false });
    assert.equal(fake.grantAlive(realm), false, 'revoked at Intuit');
    const c = await conn(A.tenantId);
    assert.equal(c.state, 'disconnected');
    assert.ok(c.purge_after > new Date(Date.now() + 29 * 86400_000));
    assert.equal((await t.superPool.query('SELECT count(*)::int AS n FROM tenant_secrets WHERE tenant_id = $1', [A.tenantId])).rows[0].n, 0);
    assert.equal(await qboRealmOwner(t.db, realmHash(sealer, config, realm)), null);
    const jobs = await t.superPool.query('SELECT kind FROM jobs_queue WHERE tenant_id = $1 ORDER BY kind', [A.tenantId]);
    assert.ok(jobs.rows.every((j) => !j.kind.startsWith('qbo_')), 'queued qbo jobs deleted');
    assert.ok(jobs.rows.some((j) => j.kind === 'integrations_send'), 'other jobs kept');
    assert.equal((await t.db.withTenant({ tenantId: A.tenantId }, (tx) => tx.query('SELECT 1 FROM qbo_outbox'))).rows.length, 1, 'outbox kept');
    assert.match((await audits(A.tenantId, 'qbo.disconnect'))[0].summary, /links kept/);
    await assert.rejects(withAccessToken(t.db, sealer, config, A.tenantId), (e) => e.code === 'qbo_not_connected');
    // Purge later from the same state.
    assert.deepEqual(await disconnect(t.db, sealer, config, A.tenantId, { purge: true }), { purged: true });
    assert.equal(await conn(A.tenantId), null);
    assert.equal((await t.db.withTenant({ tenantId: A.tenantId }, (tx) => tx.query('SELECT 1 FROM qbo_outbox'))).rows.length, 0);
    await assert.rejects(disconnect(t.db, sealer, config, A.tenantId, {}), (e) => e.code === 'qbo_not_connected');
  });

  test('a failed revoke is kept sealed and retried by housekeeping; after 14 days it gives up', async () => {
    const A = await mkTenant('Revoke Retry Electric');
    const realm = newRealm();
    await connect(A, realm);
    const token = await secret(A.tenantId, SECRET_NAMES.refresh);
    fake.failToken({ kind: 'revoke', status: 503 });
    await disconnect(t.db, sealer, config, A.tenantId, { purge: true });
    assert.equal(fake.grantAlive(realm), true);
    const { rows } = await t.superPool.query('SELECT id, token_sealed FROM qbo_revoke_pending');
    assert.equal(rows.length, 1);
    assert.ok(!rows[0].token_sealed.includes(token));
    const handlers = createQboPlatformHandlers({ sealer, config });
    await t.superPool.query('UPDATE qbo_revoke_pending SET next_try_at = now()');
    const out = await handlers.qbo_token_housekeeping({ db: t.db, job: { payload: {} } });
    assert.equal(out.revoked, 1);
    assert.equal(fake.grantAlive(realm), false);
    assert.equal((await t.superPool.query('SELECT count(*)::int AS n FROM qbo_revoke_pending')).rows[0].n, 0);
    await t.superPool.query("INSERT INTO qbo_revoke_pending (environment, token_sealed, created_at) VALUES ('sandbox', 'v1.bad', now() - interval '15 days')");
    const out2 = await handlers.qbo_token_housekeeping({ db: t.db, job: { payload: {} } });
    assert.equal(out2.gaveUp, 1);
    assert.equal(await events('revoke_gave_up', null), 1);
  });

  test('housekeeping: rolling refresh, hard-expiry notice, plan-lapse pause and auto-disconnects', async () => {
    const handlers = createQboPlatformHandlers({ sealer, config });
    const run = (tenantId) => handlers.qbo_token_housekeeping({ db: t.db, job: { payload: { tenantId } } });

    const quiet = await mkTenant('Quiet Electric');
    await connect(quiet, newRealm());
    await t.db.withTenant({ tenantId: quiet.tenantId }, (tx) => tx.query(
      "UPDATE qbo_connections SET last_refresh_at = now() - interval '31 days', refresh_hard_expires_at = now() + interval '6 days' WHERE tenant_id = $1", [quiet.tenantId]));
    const r1 = await run(quiet.tenantId);
    assert.equal(r1.refreshed, 1);
    assert.ok((await conn(quiet.tenantId)).last_refresh_at > new Date(Date.now() - 60_000));
    assert.equal((await notes(quiet.tenantId, 'qbo:hard-expiry:%')).length, 0, 'the refresh stored the new hard expiry first');

    const hard = await mkTenant('Hard Expiry Electric');
    await connect(hard, newRealm());
    await t.db.withTenant({ tenantId: hard.tenantId }, (tx) => tx.query("UPDATE qbo_connections SET refresh_hard_expires_at = now() + interval '6 days' WHERE tenant_id = $1", [hard.tenantId]));
    await run(hard.tenantId);
    await run(hard.tenantId);
    const hn = await notes(hard.tenantId, 'qbo:hard-expiry:%');
    assert.equal(new Set(hn.map((n) => n.ref)).size, 1, 'one notice per step');
    assert.match(hn[0].ref, /:7$/);

    const lapsed = await mkTenant('Lapsed Trial');
    await connect(lapsed, newRealm());
    await t.superPool.query("UPDATE tenants SET trial_ends_at = now() - interval '1 day' WHERE id = $1", [lapsed.tenantId]);
    await run(lapsed.tenantId);
    let c = await conn(lapsed.tenantId);
    assert.deepEqual([c.state, c.pause_reason], ['paused', 'plan']);
    await t.db.withTenant({ tenantId: lapsed.tenantId }, (tx) => tx.query("UPDATE qbo_connections SET paused_since = now() - interval '61 days' WHERE tenant_id = $1", [lapsed.tenantId]));
    const lapsedRealm = await secret(lapsed.tenantId, SECRET_NAMES.realm);
    await run(lapsed.tenantId);
    assert.equal(await conn(lapsed.tenantId), null, 'disconnected with purge');
    assert.equal(fake.grantAlive(lapsedRealm), false, 'revoked');
    assert.equal((await audits(lapsed.tenantId, 'qbo.auto_disconnect')).length, 1);
    const mail = await t.superPool.query("SELECT text_body FROM email_outbox WHERE tenant_id = $1 AND template = 'qbo-auto-disconnect'", [lapsed.tenantId]);
    assert.match(mail.rows[0].text_body, /more than 60 days/);

    const closed = await mkTenant('Closed Electric');
    const closedRealm = newRealm();
    await connect(closed, closedRealm);
    await t.superPool.query("UPDATE tenants SET status = 'closed' WHERE id = $1", [closed.tenantId]);
    await run(closed.tenantId);
    assert.equal(await conn(closed.tenantId), null);
    assert.equal(fake.grantAlive(closedRealm), false, 'closing a tenant revokes');

    const susp = await mkTenant('Suspended Electric');
    await connect(susp, newRealm());
    await t.superPool.query("UPDATE tenants SET status = 'suspended', status_changed_at = now() - interval '10 days' WHERE id = $1", [susp.tenantId]);
    await run(susp.tenantId);
    assert.equal((await conn(susp.tenantId)).state, 'setup', 'not yet');
    await t.superPool.query("UPDATE tenants SET status_changed_at = now() - interval '61 days' WHERE id = $1", [susp.tenantId]);
    await run(susp.tenantId);
    assert.equal(await conn(susp.tenantId), null);

    const released = await mkTenant('Released Electric');
    const relRealm = newRealm();
    await connect(released, relRealm);
    await t.superPool.query("UPDATE qbo_connections SET state = 'disconnected', lease_epoch = lease_epoch + 1 WHERE tenant_id = $1", [released.tenantId]);
    await t.superPool.query('DELETE FROM qbo_realms WHERE tenant_id = $1', [released.tenantId]);
    const out = await run(released.tenantId);
    assert.equal(out.finished, 1);
    assert.equal(fake.grantAlive(relRealm), false);
    assert.equal((await t.superPool.query('SELECT count(*)::int AS n FROM tenant_secrets WHERE tenant_id = $1', [released.tenantId])).rows[0].n, 0);
    c = await conn(released.tenantId);
    assert.ok(c.purge_after, 'the 30-day purge clock starts');
  });

  test('qbo_purge: the 30-day disconnect purge and the retention rules; expired OAuth rows and old events go', async () => {
    const handlers = createQboPlatformHandlers({ sealer, config });
    const A = await mkTenant('Retention Electric');
    await connect(A, newRealm());
    await t.db.withTenant({ tenantId: A.tenantId }, async (tx) => {
      const h = "(SELECT realm_hash FROM qbo_connections WHERE tenant_id = $1)";
      await tx.query("INSERT INTO qbo_sync_log (tenant_id, at, direction, outcome, action) VALUES ($1, now() - interval '91 days', 'push', 'ok', 'old'), ($1, now(), 'push', 'ok', 'new')", [A.tenantId]);
      await tx.query(`INSERT INTO qbo_inbox (tenant_id, realm_hash, entity, qbo_id, op, event_time, processed_at) VALUES ($1, ${h}, 'TimeActivity', '1', 'updated', now(), now() - interval '31 days'), ($1, ${h}, 'TimeActivity', '2', 'updated', now(), NULL)`, [A.tenantId]);
      await tx.query(`INSERT INTO qbo_candidates (tenant_id, realm_hash, kind, qbo_id, status, choice, scanned_at) VALUES ($1, ${h}, 'customers', '5', 'quickbooks_only', 'skip', now() - interval '31 days')`, [A.tenantId]);
      await tx.query("INSERT INTO qbo_api_usage (month, tenant_id, environment) VALUES ((date_trunc('month', now()) - interval '14 months')::date, $1, 'sandbox')", [A.tenantId]);
    });
    await t.superPool.query("INSERT INTO qbo_platform_events (kind, at) VALUES ('webhook_signature', now() - interval '31 days')");
    const out = await handlers.qbo_purge({ db: t.db, job: {} });
    assert.ok(out.rows >= 4);
    const left = await t.db.withTenant({ tenantId: A.tenantId }, async (tx) => ({
      log: (await tx.query('SELECT action FROM qbo_sync_log')).rows.map((r) => r.action),
      inbox: (await tx.query('SELECT qbo_id FROM qbo_inbox')).rows.map((r) => r.qbo_id),
      cand: (await tx.query('SELECT 1 FROM qbo_candidates')).rows.length,
      usage: (await tx.query("SELECT 1 FROM qbo_api_usage WHERE month < date_trunc('month', now()) - interval '13 months'")).rows.length,
    }));
    assert.deepEqual(left, { log: ['new'], inbox: ['2'], cand: 0, usage: 0 });
    assert.equal((await t.superPool.query("SELECT count(*)::int AS n FROM qbo_platform_events WHERE at < now() - interval '30 days'")).rows[0].n, 0);
    await disconnect(t.db, sealer, config, A.tenantId, {});
    await t.db.withTenant({ tenantId: A.tenantId }, (tx) => tx.query("UPDATE qbo_connections SET purge_after = now() - interval '1 minute' WHERE tenant_id = $1", [A.tenantId]));
    const out2 = await handlers.qbo_purge({ db: t.db, job: {} });
    assert.ok(out2.purgedTenants >= 1);
    assert.equal(await conn(A.tenantId), null);
    assert.equal((await audits(A.tenantId, 'qbo.purge')).length, 1);
  });

  test('scheduling is deduplicated: one daily housekeeping and one purge per hour', async () => {
    await t.superPool.query("DELETE FROM jobs_queue WHERE kind IN ('qbo_token_housekeeping', 'qbo_purge')");
    await scheduleQboPlatformJobs(t.db);
    await scheduleQboPlatformJobs(t.db);
    const { rows } = await t.superPool.query("SELECT kind, count(*)::int AS n FROM jobs_queue WHERE kind IN ('qbo_token_housekeeping', 'qbo_purge') GROUP BY kind ORDER BY kind");
    assert.deepEqual(rows, [{ kind: 'qbo_purge', n: 1 }, { kind: 'qbo_token_housekeeping', n: 1 }]);
  });
});

test('qbo-rehash: after a master-key change every realm hash is recomputed and the realm still routes', { skip }, async () => {
  const A = await mkTenant('Rehash Electric');
  const realm = newRealm();
  await connect(A, realm);
  await t.db.withTenant({ tenantId: A.tenantId }, (tx) => tx.query(
    "INSERT INTO qbo_links (tenant_id, realm_hash, collection, record_id, qbo_entity, qbo_id, state) SELECT tenant_id, realm_hash, 'clients', 'c-r', 'Customer', '7', 'synced' FROM qbo_connections"));
  const newKey = randomBytes(32).toString('base64');
  const next = createSealer(newKey);
  // The re-wrap step of the rotation (rotate-secrets.md): every tenant secret sealed with the new key.
  const tenants = (await t.superPool.query('SELECT DISTINCT tenant_id FROM tenant_secrets')).rows.map((r) => r.tenant_id);
  for (const tenantId of tenants) {
    await t.db.withTenant({ tenantId }, async (tx) => {
      for (const n of Object.values(SECRET_NAMES)) {
        const v = await getSecret(tx, sealer, n, INTERNAL);
        if (v) await setSecret(tx, next, n, v, 'rewrap', INTERNAL);
      }
    });
  }
  const r = await rehashRealms(t.db, next);
  assert.ok(r.rehashed >= 1);
  const nextCfg = { ...config.qbo };
  const h = realmHash(next, nextCfg, realm);
  assert.equal(await qboRealmOwner(t.db, h), A.tenantId);
  const c = await conn(A.tenantId);
  assert.ok(Buffer.from(c.realm_hash).equals(h));
  const link = await t.db.withTenant({ tenantId: A.tenantId }, (tx) => tx.query("SELECT realm_hash FROM qbo_links WHERE record_id = 'c-r'"));
  assert.ok(Buffer.from(link.rows[0].realm_hash).equals(h));
  assert.equal((await rehashRealms(t.db, next)).rehashed, 0, 'idempotent');
});

test('nothing outside the fake was called, and no token or realm id reached a redirect or audit row', { skip }, async () => {
  fake.assertNoUnexpected();
  const { rows } = await t.superPool.query("SELECT summary FROM audit_events WHERE action LIKE 'qbo.%'");
  for (const r of rows) assert.ok(!/46208163\d{8}|fake\.access|fakerefresh/.test(r.summary || ''), r.summary);
});
