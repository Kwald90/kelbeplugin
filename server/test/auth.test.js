// Identity and access: signup gate, MFA, lockouts, sessions, CSRF/CORS, role rules,
// shared-device PIN sign-in, API keys, OIDC (mocked), HQ, rate limits, log redaction.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { skip, createTestDatabase } from './support/db.js';
import { ORIGIN, addMember, apiKey, call, enrolTotp, login, ownerTenant, startApp, totpFor } from './support/app.js';
import { hashSecret } from '../src/auth/passwords.js';

let t, app, logs, A;
const mut = (o) => ({ mid: `m-${Math.random().toString(36).slice(2)}`, baseVersion: null, ...o });
const push = (token, mutations) => call(app, { method: 'POST', url: '/api/v1/sync/push', token, body: { mutations } });
const setSignup = (on) => t.ownerPool.query("UPDATE feature_flags SET enabled = $1 WHERE key = 'signup_open'", [on]);

// Mocked OIDC providers: same interface as src/auth/oidc.js, no network.
const idpUsers = new Map();
function mockProvider(name) {
  return {
    name,
    async authorizationUrl({ redirectUri, state }) { return `https://idp.${name}.test/auth?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`; },
    async callback({ currentUrl, state }) {
      const u = new URL(currentUrl);
      if (u.searchParams.get('state') !== state) throw new Error('state mismatch');
      const claims = idpUsers.get(u.searchParams.get('code'));
      if (!claims) throw new Error('bad code');
      return claims;
    },
  };
}

before(async () => {
  if (skip) return;
  t = await createTestDatabase('auth');
  ({ app, logs } = await startApp(t, { oidcProviders: { google: mockProvider('google'), microsoft: mockProvider('microsoft') } }));
  A = await ownerTenant(t, app, 'Auth Electric');
});
after(async () => { await app?.close(); await t?.close(); });

describe('signup and MFA enrolment', { skip }, () => {
  test('signup is closed by default', async () => {
    const r = await call(app, { method: 'POST', url: '/api/v1/auth/signup', body: { email: 'new@example.test', password: 'correct horse battery', name: 'N', companyName: 'New Co' } });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'signup_closed');
  });

  test('an owner from signup must enrol MFA before using the API', async () => {
    await setSignup(true);
    try {
      const weak = await call(app, { method: 'POST', url: '/api/v1/auth/signup', body: { email: 'weak@example.test', password: 'short', name: 'W', companyName: 'Weak Co' } });
      assert.equal(weak.body.error.code, 'weak_password');
      const r = await call(app, { method: 'POST', url: '/api/v1/auth/signup', body: { email: 'Founder@Example.test', password: 'correct horse battery', name: 'Founder', companyName: 'Founder Co', province: 'ON', mode: 'bearer' } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.mfa, 'enrol');
      assert.equal(r.body.me.tenant.role, 'owner');
      const token = r.body.token;
      const blocked = await call(app, { url: '/api/v1/jobs', token });
      assert.equal(blocked.status, 403);
      assert.equal(blocked.body.error.code, 'mfa_enrolment_required');
      assert.equal((await call(app, { method: 'POST', url: '/api/v1/sync/push', token, body: { mutations: [] } })).status, 403);
      assert.equal((await call(app, { url: '/api/v1/me', token })).status, 200);
      const { recoveryCodes } = await enrolTotp(app, token);
      assert.equal(recoveryCodes.length, 10);
      assert.equal((await call(app, { url: '/api/v1/jobs', token })).status, 200);
      const dup = await call(app, { method: 'POST', url: '/api/v1/auth/signup', body: { email: 'founder@example.test', password: 'correct horse battery', name: 'F', companyName: 'Dup Co' } });
      assert.equal(dup.status, 409);
    } finally {
      await setSignup(false);
    }
  });
});

describe('login, MFA, lockout, sessions', { skip }, () => {
  test('unknown email and wrong password look the same', async () => {
    const a = await call(app, { method: 'POST', url: '/api/v1/auth/login', body: { email: 'nobody@example.test', password: 'whatever whatever' } });
    const b = await call(app, { method: 'POST', url: '/api/v1/auth/login', body: { email: A.email, password: 'wrong wrong wrong' } });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(a.body.error.code, b.body.error.code);
    assert.equal(a.body.error.message, b.body.error.message);
  });

  test('five wrong passwords lock the account, even for the right password', async () => {
    const m = await addMember(t, app, A.tenantId, { role: 'office', signIn: false });
    for (let i = 0; i < 5; i++) {
      const r = await call(app, { method: 'POST', url: '/api/v1/auth/login', body: { email: m.email, password: 'not the password' } });
      assert.equal(r.status, 401);
    }
    const locked = await call(app, { method: 'POST', url: '/api/v1/auth/login', body: { email: m.email, password: m.password } });
    assert.equal(locked.status, 423);
    assert.equal(locked.body.error.code, 'account_locked');
    const ev = await t.superPool.query("SELECT count(*)::int AS n FROM audit_events WHERE tenant_id IS NULL AND action = 'auth.login_failed' AND actor_id = $1", [m.userId]);
    assert.ok(ev.rows[0].n >= 6);
    await t.superPool.query('UPDATE users SET locked_until = now() - interval \'1 second\' WHERE id = $1', [m.userId]);
    const ok = await call(app, { method: 'POST', url: '/api/v1/auth/login', body: { email: m.email, password: m.password, mode: 'bearer' } });
    assert.equal(ok.status, 200);
  });

  test('an owner must pass TOTP on every new session; recovery codes work once', async () => {
    const r = await call(app, { method: 'POST', url: '/api/v1/auth/login', body: { email: A.email, password: A.password, mode: 'bearer' } });
    assert.equal(r.body.mfa, 'verify');
    const token = r.body.token;
    const blocked = await call(app, { url: '/api/v1/clients', token });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'mfa_required');
    const bad = await call(app, { method: 'POST', url: '/api/v1/auth/mfa/verify', token, body: { code: '000000' } });
    assert.equal(bad.status, 400);
    const good = await call(app, { method: 'POST', url: '/api/v1/auth/mfa/verify', token, body: { code: await A.totp() } });
    assert.equal(good.status, 200);
    assert.equal((await call(app, { url: '/api/v1/clients', token })).status, 200);

    const codes = (await call(app, { method: 'POST', url: '/api/v1/auth/mfa/recovery-codes', token })).body.recoveryCodes;
    const s2 = (await call(app, { method: 'POST', url: '/api/v1/auth/login', body: { email: A.email, password: A.password, mode: 'bearer' } })).body.token;
    const rc = await call(app, { method: 'POST', url: '/api/v1/auth/mfa/verify', token: s2, body: { recoveryCode: codes[0].toLowerCase() } });
    assert.equal(rc.status, 200);
    assert.equal(rc.body.recoveryCodesLeft, 9);
    const s3 = (await call(app, { method: 'POST', url: '/api/v1/auth/login', body: { email: A.email, password: A.password, mode: 'bearer' } })).body.token;
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/auth/mfa/verify', token: s3, body: { recoveryCode: codes[0] } })).status, 400);
  });

  test('too many wrong MFA codes end the session', async () => {
    const token = (await call(app, { method: 'POST', url: '/api/v1/auth/login', body: { email: A.email, password: A.password, mode: 'bearer' } })).body.token;
    let last;
    for (let i = 0; i < 5; i++) last = await call(app, { method: 'POST', url: '/api/v1/auth/mfa/verify', token, body: { code: '123456' } });
    assert.equal(last.body.error.code, 'session_revoked');
    assert.equal((await call(app, { url: '/api/v1/me', token })).status, 401);
  });

  test('expired and idle sessions are refused', async () => {
    const m = await addMember(t, app, A.tenantId, { role: 'office' });
    assert.equal((await call(app, { url: '/api/v1/me', token: m.token })).status, 200);
    await t.superPool.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1", [m.userId]);
    const r = await call(app, { url: '/api/v1/me', token: m.token });
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'session_expired');
    const again = await login(app, m.email, m.password);
    await t.superPool.query("UPDATE sessions SET last_seen_at = now() - interval '30 days' WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()", [m.userId]);
    assert.equal((await call(app, { url: '/api/v1/me', token: again.token })).body.error.code, 'session_expired');
  });

  test('logout ends the session; garbage tokens are refused', async () => {
    const m = await addMember(t, app, A.tenantId, { role: 'office' });
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/auth/logout', token: m.token })).status, 204);
    assert.equal((await call(app, { url: '/api/v1/me', token: m.token })).status, 401);
    assert.equal((await call(app, { url: '/api/v1/me', token: 'fts_' + 'x'.repeat(43) })).status, 401);
    assert.equal((await call(app, { url: '/api/v1/me', headers: { authorization: 'Basic abc' } })).status, 401);
  });

  test('password change signs out other sessions', async () => {
    const m = await addMember(t, app, A.tenantId, { role: 'office' });
    const other = await login(app, m.email, m.password);
    const wrong = await call(app, { method: 'POST', url: '/api/v1/auth/password/change', token: m.token, body: { currentPassword: 'nope nope nope', newPassword: 'a brand new passphrase' } });
    assert.equal(wrong.status, 401);
    const ok = await call(app, { method: 'POST', url: '/api/v1/auth/password/change', token: m.token, body: { currentPassword: m.password, newPassword: 'a brand new passphrase' } });
    assert.equal(ok.status, 200);
    assert.equal((await call(app, { url: '/api/v1/me', token: other.token })).status, 401);
    assert.equal((await call(app, { url: '/api/v1/me', token: m.token })).status, 200);
  });

  test('an account with no password (Google/Microsoft only) is told so: /me says hasPassword false, change answers no_password', async () => {
    const m = await addMember(t, app, A.tenantId, { role: 'office' });
    assert.equal((await call(app, { url: '/api/v1/me', token: m.token })).body.user.hasPassword, true);
    await t.superPool.query('UPDATE users SET password_hash = NULL WHERE id = $1', [m.userId]);
    assert.equal((await call(app, { url: '/api/v1/me', token: m.token })).body.user.hasPassword, false);
    const r = await call(app, { method: 'POST', url: '/api/v1/auth/password/change', token: m.token, body: { currentPassword: 'anything at all', newPassword: 'a brand new passphrase' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'no_password');
    assert.doesNotMatch(r.body.error.message, /wrong/);
  });

  test('forgot/reset: emailed link sets a new password once and signs everything out', async () => {
    const m = await addMember(t, app, A.tenantId, { role: 'office' });
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/auth/password/forgot', body: { email: 'ghost@example.test' } })).status, 202);
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/auth/password/forgot', body: { email: m.email } })).status, 202);
    const mail = await t.superPool.query('SELECT text_body FROM email_outbox WHERE to_address = $1 ORDER BY created_at DESC LIMIT 1', [m.email]);
    const token = decodeURIComponent(/token=([^\s]+)/.exec(mail.rows[0].text_body)[1]);
    assert.ok(token.startsWith('ftr_'));
    const stored = await t.superPool.query('SELECT count(*)::int AS n FROM password_resets WHERE token_hash = $1', [Buffer.from(token)]);
    assert.equal(stored.rows[0].n, 0, 'the token itself is not stored');
    const r = await call(app, { method: 'POST', url: '/api/v1/auth/password/reset', body: { token, newPassword: 'reset passphrase here' } });
    assert.equal(r.status, 200);
    assert.equal((await call(app, { url: '/api/v1/me', token: m.token })).status, 401);
    await login(app, m.email, 'reset passphrase here');
    const reuse = await call(app, { method: 'POST', url: '/api/v1/auth/password/reset', body: { token, newPassword: 'another passphrase' } });
    assert.equal(reuse.body.error.code, 'invalid_token');
  });
});

describe('CSRF and CORS', { skip }, () => {
  let m, cookie;
  before(async () => {
    m = await addMember(t, app, A.tenantId, { role: 'electrician', employeeId: 'emp-csrf', signIn: false });
    const r = await call(app, { method: 'POST', url: '/api/v1/auth/login', body: { email: m.email, password: m.password } });
    assert.equal(r.status, 200);
    const c = r.cookies.find((x) => x.name === 'ft_session');
    assert.ok(c.httpOnly);
    assert.equal(c.sameSite, 'Lax');
    assert.equal(r.body.token, undefined, 'cookie sessions never expose the token');
    cookie = c.value;
  });

  test('cookie writes need X-Fishtape: 1 and an allowed Origin', async () => {
    const body = { employeeId: 'emp-csrf', clockIn: new Date().toISOString() };
    const noHeader = await call(app, { method: 'POST', url: '/api/v1/timeEntries', cookie, body, csrf: false });
    assert.equal(noHeader.status, 403);
    assert.equal(noHeader.body.error.code, 'csrf_failed');
    const evil = await call(app, { method: 'POST', url: '/api/v1/timeEntries', cookie, body, headers: { origin: 'https://evil.example' } });
    assert.equal(evil.body.error.code, 'csrf_failed');
    const nullOrigin = await call(app, { method: 'POST', url: '/api/v1/timeEntries', cookie, body, headers: { origin: 'null' } });
    assert.equal(nullOrigin.status, 403);
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/timeEntries', cookie, body, headers: { origin: ORIGIN } })).status, 201);
    assert.equal((await call(app, { url: '/api/v1/timeEntries', cookie })).status, 200, 'reads need no header');
  });

  test('login itself is CSRF-guarded; bearer requests are not', async () => {
    const r = await call(app, { method: 'POST', url: '/api/v1/auth/login', body: { email: m.email, password: m.password }, csrf: false });
    assert.equal(r.body.error.code, 'csrf_failed');
  });

  test('CORS: capacitor://localhost and our origin are allowed, others are not', async () => {
    for (const origin of ['capacitor://localhost', ORIGIN]) {
      const r = await app.inject({ method: 'OPTIONS', url: '/api/v1/jobs', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type,x-fishtape' } });
      assert.equal(r.headers['access-control-allow-origin'], origin);
      assert.equal(r.headers['access-control-allow-credentials'], 'true');
    }
    const bad = await app.inject({ method: 'OPTIONS', url: '/api/v1/jobs', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    assert.equal(bad.headers['access-control-allow-origin'], undefined);
  });
});

describe('roles and record rules', { skip }, () => {
  let el, office, other;
  before(async () => {
    el = await addMember(t, app, A.tenantId, { role: 'electrician', employeeId: 'emp-el' });
    other = await addMember(t, app, A.tenantId, { role: 'apprentice', employeeId: 'emp-ap' });
    office = await addMember(t, app, A.tenantId, { role: 'office', employeeId: 'emp-off' });
  });

  test('an electrician writes only their own time, cannot approve, cannot manage jobs', async () => {
    const own = await call(app, { method: 'POST', url: '/api/v1/timeEntries', token: el.token, body: { employeeId: 'emp-el', clockIn: new Date().toISOString() } });
    assert.equal(own.status, 201);
    const forOther = await call(app, { method: 'POST', url: '/api/v1/timeEntries', token: el.token, body: { employeeId: 'emp-ap', clockIn: new Date().toISOString() } });
    assert.equal(forOther.status, 403);
    const approve = await call(app, { method: 'PATCH', url: `/api/v1/timeEntries/${own.body.id}`, token: el.token, body: { approved: true } });
    assert.equal(approve.status, 403);
    const theirs = await call(app, { method: 'POST', url: '/api/v1/timeEntries', token: other.token, body: { employeeId: 'emp-ap', clockIn: new Date().toISOString() } });
    assert.equal((await call(app, { method: 'PATCH', url: `/api/v1/timeEntries/${theirs.body.id}`, token: el.token, body: { note: 'x' } })).status, 404);
    const list = await call(app, { url: '/api/v1/timeEntries', token: el.token });
    assert.ok(list.body.data.every((x) => x.employeeId === 'emp-el'));
    const pulled = await call(app, { url: '/api/v1/sync/pull?since=0&limit=1000', token: el.token });
    assert.ok(pulled.body.changes.filter((c) => c.collection === 'timeEntries').every((c) => c.data.employeeId === 'emp-el'));
    const pushOther = await push(el.token, [mut({ collection: 'timeEntries', id: 'te-hijack', op: 'upsert', data: { employeeId: 'emp-ap' } })]);
    assert.equal(pushOther.body.results[0].status, 'rejected');
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/jobs', token: el.token, body: { title: 'x' } })).status, 403);
    assert.equal((await call(app, { url: '/api/v1/jobs', token: el.token })).status, 200);
    assert.equal((await call(app, { url: '/api/v1/invoices', token: el.token })).status, 403);
    const approved = await call(app, { method: 'PATCH', url: `/api/v1/timeEntries/${own.body.id}`, token: A.token, body: { approved: true } });
    assert.equal(approved.status, 200, 'owner can approve');
  });

  test('a non-manager can acknowledge an SOP for themselves and nothing else', async () => {
    const sop = await call(app, { method: 'POST', url: '/api/v1/sops', token: A.token, body: { title: 'LOTO', version: 2, steps: [{ text: 'Lock' }], acks: [] } });
    const ack = { employeeId: 'emp-el', version: 2, at: new Date().toISOString() };
    assert.equal((await call(app, { method: 'PATCH', url: `/api/v1/sops/${sop.body.id}`, token: el.token, body: { acks: [ack] } })).status, 200);
    assert.equal((await call(app, { method: 'PATCH', url: `/api/v1/sops/${sop.body.id}`, token: el.token, body: { title: 'Skip it' } })).status, 403);
    assert.equal((await call(app, { method: 'PATCH', url: `/api/v1/sops/${sop.body.id}`, token: el.token, body: { acks: [ack, { ...ack, employeeId: 'emp-ap' }] } })).status, 403);
    assert.equal((await call(app, { method: 'PATCH', url: `/api/v1/sops/${sop.body.id}`, token: el.token, body: { acks: [] } })).status, 403);
  });

  test('office may bump document numbers in settings but not change settings', async () => {
    await call(app, { method: 'POST', url: '/api/v1/settings', token: A.token, body: { id: 'settings', taxPct: 5, nextNumbers: { job: 1001 } } });
    assert.equal((await call(app, { method: 'PATCH', url: '/api/v1/settings/settings', token: office.token, body: { nextNumbers: { job: 1002 } } })).status, 200);
    assert.equal((await call(app, { method: 'PATCH', url: '/api/v1/settings/settings', token: office.token, body: { taxPct: 0 } })).status, 403);
    assert.equal((await call(app, { url: '/api/v1/settings/settings', token: el.token })).status, 200, 'everyone reads settings');
  });

  test('pay rates are hidden from members without the employees permission', async () => {
    await call(app, { method: 'POST', url: '/api/v1/employees', token: A.token, body: { id: 'emp-rate', name: 'Rated', rateCents: 4600 } });
    assert.equal((await call(app, { url: '/api/v1/employees/emp-rate', token: office.token })).body.rateCents, 4600);
    const seen = await call(app, { url: '/api/v1/employees/emp-rate', token: el.token });
    assert.equal(seen.status, 200);
    assert.equal(seen.body.rateCents, undefined);
  });

  test('admin-only endpoints refuse other roles', async () => {
    assert.equal((await call(app, { url: '/api/v1/api-keys', token: office.token })).status, 403);
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/members', token: office.token, body: { name: 'X', role: 'owner' } })).status, 403);
    assert.equal((await call(app, { url: '/api/v1/secrets', token: el.token })).status, 403);
    assert.equal((await call(app, { url: '/api/v1/members', token: el.token })).status, 403);
  });

  test('the last owner cannot be demoted or removed', async () => {
    const me = (await call(app, { url: '/api/v1/members', token: A.token })).body.data.find((x) => x.userId === A.userId);
    const r = await call(app, { method: 'PATCH', url: `/api/v1/members/${me.id}`, token: A.token, body: { role: 'admin' } });
    assert.equal(r.status, 409);
    assert.equal((await call(app, { method: 'DELETE', url: `/api/v1/members/${me.id}`, token: A.token })).status, 409);
  });

  test('adding a member by email sends an invite that activates the membership', async () => {
    const r = await call(app, { method: 'POST', url: '/api/v1/members', token: A.token, body: { name: 'New Hire', email: 'hire@example.test', role: 'apprentice', employeeId: 'emp-hire' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.status, 'invited');
    const mail = await t.superPool.query("SELECT text_body FROM email_outbox WHERE to_address = 'hire@example.test' AND template = 'invite'");
    const token = decodeURIComponent(/token=([^\s]+)/.exec(mail.rows[0].text_body)[1]);
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/auth/password/reset', body: { token, newPassword: 'hired and happy' } })).status, 200);
    const s = await login(app, 'hire@example.test', 'hired and happy');
    const me = await call(app, { url: '/api/v1/me', token: s.token });
    assert.equal(me.body.tenant.role, 'apprentice');
    assert.equal(me.body.tenant.employeeId, 'emp-hire');
  });
});

describe('shared device and crew PIN', { skip }, () => {
  let deviceToken, el, ownerMembership;
  before(async () => {
    const d = await call(app, { method: 'POST', url: '/api/v1/devices', token: A.token, body: { name: 'Shop iPad' } });
    assert.equal(d.status, 201);
    deviceToken = d.body.deviceToken;
    assert.ok(deviceToken.startsWith('ftd_'));
    el = await addMember(t, app, A.tenantId, { role: 'electrician', employeeId: 'emp-crew', signIn: false });
    ownerMembership = (await t.superPool.query('SELECT id FROM memberships WHERE user_id = $1 AND tenant_id = $2', [A.userId, A.tenantId])).rows[0].id;
  });
  const dev = (extra = {}) => ({ 'x-fishtape-device': deviceToken, ...extra });

  test('PINs: weak ones refused, managers set them, the crew list shows who can sign in', async () => {
    assert.equal((await call(app, { method: 'PUT', url: `/api/v1/members/${el.membershipId}/pin`, token: A.token, body: { pin: '1111' } })).body.error.code, 'weak_pin');
    assert.equal((await call(app, { method: 'PUT', url: `/api/v1/members/${el.membershipId}/pin`, token: A.token, body: { pin: '73051946' } })).status, 204);
    assert.equal((await call(app, { method: 'PUT', url: `/api/v1/members/${ownerMembership}/pin`, token: A.token, body: { pin: '9137' } })).status, 204);
    assert.equal((await call(app, { url: '/api/v1/devices/crew' })).status, 401);
    const crew = await call(app, { url: '/api/v1/devices/crew', headers: dev() });
    assert.equal(crew.status, 200);
    assert.ok(crew.body.crew.some((c) => c.membershipId === el.membershipId));
  });

  test('five wrong PINs lock that member out, even with the right PIN', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await call(app, { method: 'POST', url: '/api/v1/devices/crew/sign-in', headers: dev(), body: { membershipId: el.membershipId, pin: '0000' } });
      assert.equal(r.status, 401);
    }
    const locked = await call(app, { method: 'POST', url: '/api/v1/devices/crew/sign-in', headers: dev(), body: { membershipId: el.membershipId, pin: '73051946' } });
    assert.equal(locked.status, 423);
    assert.equal(locked.body.error.code, 'pin_locked');
    await t.superPool.query('UPDATE memberships SET pin_locked_until = NULL WHERE id = $1', [el.membershipId]);
  });

  test('a crew session works for own time, is tied to the device, and dies with it', async () => {
    const r = await call(app, { method: 'POST', url: '/api/v1/devices/crew/sign-in', headers: dev(), body: { membershipId: el.membershipId, pin: '73051946', mode: 'bearer' } });
    assert.equal(r.status, 200);
    const token = r.body.token;
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/timeEntries', token, body: { employeeId: 'emp-crew', clockIn: new Date().toISOString() } })).status, 201);
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/auth/password/change', token, body: { currentPassword: 'x', newPassword: 'y'.repeat(12) } })).status, 403);

    const ownerPin = await call(app, { method: 'POST', url: '/api/v1/devices/crew/sign-in', headers: dev(), body: { membershipId: ownerMembership, pin: '9137', mode: 'bearer' } });
    const me = await call(app, { url: '/api/v1/me', token: ownerPin.body.token });
    assert.equal(me.body.tenant.role, 'foreman', 'owner PIN sessions are capped at foreman');
    assert.equal((await call(app, { url: '/api/v1/invoices', token: ownerPin.body.token })).status, 403);
    assert.equal((await call(app, { url: '/api/v1/api-keys', token: ownerPin.body.token })).status, 403);

    const deviceId = (await call(app, { url: '/api/v1/devices', token: A.token })).body.data[0].id;
    assert.equal((await call(app, { method: 'DELETE', url: `/api/v1/devices/${deviceId}`, token: A.token })).status, 204);
    assert.equal((await call(app, { url: '/api/v1/me', token })).status, 401);
    assert.equal((await call(app, { url: '/api/v1/devices/crew', headers: dev() })).status, 401);
  });
});

describe('API keys', { skip }, () => {
  test('keys are prefixed, shown once, scoped, revocable, and kept off admin routes', async () => {
    const bad = await call(app, { method: 'POST', url: '/api/v1/api-keys', token: A.token, body: { name: 'x', scopes: ['jobs:delete'] } });
    assert.equal(bad.status, 400);
    const key = await apiKey(app, A.token, ['jobs:write', 'clients:read'], 'Zapier');
    assert.match(key, /^ft_test_/);
    const list = await call(app, { url: '/api/v1/api-keys', token: A.token });
    assert.ok(!JSON.stringify(list.body).includes(key));
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/jobs', token: key, body: { title: 'From Zapier' } })).status, 201);
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/clients', token: key, body: { name: 'x' } })).status, 403);
    assert.equal((await call(app, { url: '/api/v1/clients', token: key })).status, 200);
    assert.equal((await call(app, { url: '/api/v1/invoices', token: key })).status, 403);
    assert.equal((await call(app, { url: '/api/v1/api-keys', token: key })).status, 403);
    assert.equal((await call(app, { url: '/api/v1/me', token: key })).status, 401);
    const audit = await call(app, { url: '/api/v1/auditLog?action=record.create&collection=jobs', token: A.token });
    assert.ok(audit.body.data.some((e) => e.actorType === 'api_key'));
    const id = list.body.data.find((k) => k.name === 'Zapier').id;
    assert.equal((await call(app, { method: 'DELETE', url: `/api/v1/api-keys/${id}`, token: A.token })).status, 204);
    const after = await call(app, { url: '/api/v1/jobs', token: key });
    assert.equal(after.status, 401);
    assert.equal(after.body.error.code, 'invalid_api_key');
  });
});

describe('OIDC (mocked providers)', { skip }, () => {
  async function oidcLogin(provider, code) {
    const start = await app.inject({ method: 'GET', url: `/api/v1/auth/oidc/${provider}/start` });
    assert.equal(start.statusCode, 302);
    const state = new URL(start.headers.location).searchParams.get('state');
    const stateCookie = start.cookies.find((c) => c.name === 'ft_oidc').value;
    return app.inject({ method: 'GET', url: `/api/v1/auth/oidc/${provider}/callback?code=${code}&state=${state}`, headers: { cookie: `ft_oidc=${stateCookie}` } });
  }

  test('providers are reported', async () => {
    const r = await call(app, { url: '/api/v1/auth/providers' });
    assert.deepEqual(r.body, { password: true, google: true, microsoft: true, signupOpen: false });
  });

  test('a Google-verified email signs in to the matching account and links it', async () => {
    const m = await addMember(t, app, A.tenantId, { role: 'office', signIn: false });
    idpUsers.set('g1', { subject: 'google-sub-1', email: m.email, emailVerified: true, name: 'Office' });
    const cb = await oidcLogin('google', 'g1');
    assert.equal(cb.statusCode, 302);
    assert.equal(cb.headers.location, `${ORIGIN}/#/`);
    const session = cb.cookies.find((c) => c.name === 'ft_session').value;
    const me = await call(app, { url: '/api/v1/me', cookie: session });
    assert.equal(me.body.user.email, m.email);
    const link = await t.superPool.query("SELECT user_id FROM oauth_identities WHERE provider = 'google' AND subject = 'google-sub-1'");
    assert.equal(link.rows[0].user_id, m.userId);
  });

  test('an unverified email never links to an existing account', async () => {
    idpUsers.set('ms1', { subject: 'ms-sub-1', email: A.email, emailVerified: false, name: 'Imposter' });
    const cb = await oidcLogin('microsoft', 'ms1');
    assert.equal(cb.headers.location, `${ORIGIN}/#/sign-in?error=no_account`);
    assert.equal(cb.cookies.find((c) => c.name === 'ft_session'), undefined);
  });

  test('a forged state is refused', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/google/callback?code=g1&state=forged', headers: { cookie: 'ft_oidc=v1.a.b.c' } });
    assert.equal(r.headers.location, `${ORIGIN}/#/sign-in?error=expired`);
  });

  test('an owner signing in with Google still has to pass TOTP', async () => {
    idpUsers.set('g2', { subject: 'google-owner', email: A.email, emailVerified: true, name: 'Owner' });
    const cb = await oidcLogin('google', 'g2');
    assert.equal(cb.headers.location, `${ORIGIN}/#/sign-in?mfa=verify`);
  });
});

describe('several companies per user', { skip }, () => {
  test('a user switches between their companies', async () => {
    const C = await ownerTenant(t, app, 'Second Co');
    await t.superPool.query("INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'office')", [C.tenantId, A.userId]);
    const me = await call(app, { url: '/api/v1/me', token: A.token });
    assert.equal(me.body.memberships.length, 2);
    const sw = await call(app, { method: 'POST', url: '/api/v1/auth/switch-tenant', token: A.token, body: { tenantId: C.tenantId } });
    assert.equal(sw.status, 200);
    assert.equal(sw.body.tenant.id, C.tenantId);
    assert.equal(sw.body.tenant.role, 'office');
    assert.equal((await call(app, { url: '/api/v1/api-keys', token: A.token })).status, 403, 'office in this company');
    await call(app, { method: 'POST', url: '/api/v1/auth/switch-tenant', token: A.token, body: { tenantId: A.tenantId } });
  });
});

describe('HQ', { skip }, () => {
  test('HQ staff need MFA; owners are not HQ', async () => {
    const email = 'hq-staff@fishtape.test';
    const password = 'hq staff passphrase';
    await t.superPool.query("INSERT INTO users (email, display_name, password_hash, platform_role) VALUES ($1, 'HQ', $2, 'hq_staff')", [email, await hashSecret(password)]);
    const r = await call(app, { method: 'POST', url: '/api/v1/auth/login', body: { email, password, mode: 'bearer' } });
    assert.equal(r.body.mfa, 'enrol');
    const blocked = await call(app, { url: '/api/hq/health', token: r.body.token });
    assert.equal(blocked.body.error.code, 'mfa_enrolment_required');
    await enrolTotp(app, r.body.token);
    const h = await call(app, { url: '/api/hq/health', token: r.body.token });
    assert.equal(h.status, 200);
    for (const k of ['database', 'migrations', 'queue', 'errors', 'memory', 'uptimeSeconds', 'gitSha', 'disk']) assert.ok(k in h.body, k);
    assert.equal((await call(app, { url: '/api/hq/health', token: A.token })).status, 403);

    const v = await call(app, { url: `/api/hq/tenants/${A.tenantId}/audit/verify`, token: r.body.token });
    assert.equal(v.status, 200, JSON.stringify(v.body));
    assert.equal(v.body.ok, true);
    const ev = await t.superPool.query("SELECT actor_type FROM audit_events WHERE tenant_id = $1 AND action = 'hq.audit_verify'", [A.tenantId]);
    assert.deepEqual(ev.rows.map((x) => x.actor_type), ['hq']);
    const tenants = await call(app, { url: '/api/hq/tenants', token: r.body.token });
    assert.ok(tenants.body.data.some((x) => x.id === A.tenantId));
  });
});

describe('rate limits and logs', { skip }, () => {
  test('auth routes are rate limited per IP', async () => {
    const { app: limited } = await startApp(t, { env: { RATE_LIMIT: 'on', RATE_LIMIT_AUTH: '3' } });
    let last;
    for (let i = 0; i < 4; i++) last = await call(limited, { method: 'POST', url: '/api/v1/auth/login', body: { email: 'rl@example.test', password: 'whatever whatever' } });
    assert.equal(last.status, 429);
    assert.equal(last.body.error.code, 'rate_limited');
    await limited.close();
  });

  test('logs never contain passwords, tokens, cookies or PINs', async () => {
    const text = logs.text();
    assert.ok(text.length > 1000, 'logs were captured');
    assert.ok(!text.includes(A.password), 'password in logs');
    assert.ok(!text.includes(A.token), 'session token in logs');
    assert.ok(!/fts_[A-Za-z0-9_-]{20,}/.test(text), 'a session token in logs');
    assert.ok(!/ft_test_[A-Za-z0-9_-]{20,}/.test(text), 'an API key in logs');
    assert.ok(!/ftd_[A-Za-z0-9_-]{20,}/.test(text), 'a device token in logs');
    assert.ok(!text.includes('73051946'), 'a PIN in logs');
    assert.ok(!/ftr_[A-Za-z0-9_-]{20,}/.test(text), 'a reset token in logs');
  });
});

void totpFor;
