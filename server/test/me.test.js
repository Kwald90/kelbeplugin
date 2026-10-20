// GET /api/v1/me and PATCH /api/v1/me/prefs (workstream G): own data only, plan
// entitlements for the active company, preferences, no-store, nothing secret.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { skip, createTestDatabase } from './support/db.js';
import { addMember, call, login, ownerTenant, startApp } from './support/app.js';
import { cleanPrefs } from '../src/routes/v1/me.js';
import { createTenantWithOwner } from '../src/services/tenants.js';

let t, app, A, B;

before(async () => {
  if (skip) return;
  t = await createTestDatabase('me');
  ({ app } = await startApp(t));
  A = await ownerTenant(t, app, 'Me Electric A');
  B = await ownerTenant(t, app, 'Me Electric B');
  // B is on Starter (no drawings); A stays on its trial (Business).
  await t.superPool.query("UPDATE tenants SET plan = 'starter' WHERE id = $1", [B.tenantId]);
});
after(async () => { await app?.close(); await t?.close(); });

/** Every key anywhere in a JSON value. */
function keysOf(v, out = new Set()) {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
  return out;
}

test('cleanPrefs keeps only known keys and values', () => {
  assert.deepEqual(cleanPrefs({ units: 'imperial', theme: 'dark', other: 1 }), { units: 'imperial', theme: 'dark' });
  assert.deepEqual(cleanPrefs({ units: 'furlongs' }), {});
  assert.deepEqual(cleanPrefs(null), {});
  assert.deepEqual(cleanPrefs({ twoFingerTap: 'redo', threeFingerTap: 'wheel', longPress: 'explode' }), { twoFingerTap: 'redo', threeFingerTap: 'wheel' });
});

describe('GET /api/v1/me', { skip }, () => {
  test('owner: user, company, role, perms, membership, entitlements, prefs; no-store', async () => {
    const r = await call(app, { url: '/api/v1/me', token: A.token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.headers['cache-control'], 'no-store');
    const me = r.body;
    assert.equal(me.user.id, A.userId);
    assert.equal(me.user.email, A.email);
    assert.equal(me.session.mfa, null);
    assert.equal(me.session.mfaEnrolled, true);
    assert.equal(me.tenant.id, A.tenantId);
    assert.equal(me.tenant.role, 'owner');
    assert.ok(me.tenant.perms.includes('settings'));
    assert.match(me.tenant.membershipId, /^[0-9a-f-]{36}$/);
    assert.equal(me.entitlements.plan, 'business');
    assert.equal(me.entitlements.onTrial, true);
    assert.ok(me.entitlements.features.includes('drawings'));
    assert.deepEqual(me.prefs, {});
    assert.deepEqual(me.memberships.map((m) => m.tenantId), [A.tenantId]);
  });

  test('nothing secret: no tokens, hashes, secrets or codes', async () => {
    const r = await call(app, { url: '/api/v1/me', token: A.token });
    const keys = [...keysOf(r.body)].map((k) => k.toLowerCase());
    for (const bad of ['password', 'passwordhash', 'password_hash', 'token', 'token_hash', 'secret', 'secret_enc', 'pin', 'pin_hash', 'recoverycodes', 'code_hash']) {
      assert.ok(!keys.includes(bad), `/me has a "${bad}" field`);
    }
    assert.ok(!r.raw.body.includes(A.token), '/me echoes the session token');
    assert.ok(!/argon2|fts_|ftd_/.test(r.raw.body));
  });

  test('own data only: another company never appears', async () => {
    const a = await call(app, { url: '/api/v1/me', token: A.token });
    const b = await call(app, { url: '/api/v1/me', token: B.token });
    assert.ok(!a.raw.body.includes(B.tenantId) && !a.raw.body.includes('Me Electric B'));
    assert.ok(!b.raw.body.includes(A.tenantId) && !b.raw.body.includes(A.email));
    assert.equal(b.body.entitlements.plan, 'starter');
    assert.ok(!b.body.entitlements.features.includes('drawings'));
  });

  test('before MFA enrolment /me answers, says what is needed, and holds back entitlements', async () => {
    const email = `fresh-${Date.now()}@example.test`;
    await createTenantWithOwner(t.db, { name: 'Fresh Co', owner: { email, password: 'fresh fresh fresh', displayName: 'Fresh' } });
    const s = await login(app, email, 'fresh fresh fresh');
    const r = await call(app, { url: '/api/v1/me', token: s.token });
    assert.equal(r.status, 200);
    assert.equal(r.body.session.mfa, 'enrol');
    assert.equal(r.body.entitlements, null);
    assert.equal((await call(app, { url: '/api/v1/me' })).status, 401);
  });

  test('a member of two companies sees both, and entitlements follow the active one', async () => {
    const m = await addMember(t, app, A.tenantId, { role: 'office' });
    await t.superPool.query("INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'electrician')", [B.tenantId, m.userId]);
    const before = await call(app, { url: '/api/v1/me', token: m.token });
    assert.equal(before.body.memberships.length, 2);
    assert.equal(before.body.tenant.id, A.tenantId);
    assert.equal(before.body.entitlements.plan, 'business');
    const sw = await call(app, { method: 'POST', url: '/api/v1/auth/switch-tenant', token: m.token, body: { tenantId: B.tenantId } });
    assert.equal(sw.status, 200);
    const after = await call(app, { url: '/api/v1/me', token: m.token });
    assert.equal(after.body.tenant.id, B.tenantId);
    assert.equal(after.body.tenant.role, 'electrician');
    assert.ok(!after.body.tenant.perms.includes('clients'));
    assert.equal(after.body.entitlements.plan, 'starter');
  });

  test('crew PIN sessions show the capped role', async () => {
    const d = await call(app, { method: 'POST', url: '/api/v1/devices', token: A.token, body: { name: 'Me iPad' } });
    const ownerMembership = (await call(app, { url: '/api/v1/me', token: A.token })).body.tenant.membershipId;
    assert.equal((await call(app, { method: 'PUT', url: `/api/v1/members/${ownerMembership}/pin`, token: A.token, body: { pin: '4826' } })).status, 204);
    const s = await call(app, { method: 'POST', url: '/api/v1/devices/crew/sign-in', headers: { 'x-fishtape-device': d.body.deviceToken }, body: { membershipId: ownerMembership, pin: '4826', mode: 'bearer' } });
    assert.equal(s.status, 200);
    const me = await call(app, { url: '/api/v1/me', token: s.body.token });
    assert.equal(me.body.session.kind, 'crew');
    assert.equal(me.body.tenant.role, 'foreman');
    assert.ok(!me.body.tenant.perms.includes('settings'));
  });
});

describe('PATCH /api/v1/me/prefs', { skip }, () => {
  test('saves units and theme, merges, and shows up in /me', async () => {
    const r = await call(app, { method: 'PATCH', url: '/api/v1/me/prefs', token: A.token, body: { units: 'imperial' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.deepEqual(r.body.prefs, { units: 'imperial' });
    const r2 = await call(app, { method: 'PATCH', url: '/api/v1/me/prefs', token: A.token, body: { theme: 'dark' } });
    assert.deepEqual(r2.body.prefs, { units: 'imperial', theme: 'dark' });
    assert.deepEqual((await call(app, { url: '/api/v1/me', token: A.token })).body.prefs, { units: 'imperial', theme: 'dark' });
  });

  test('saves the drawing canvas finger gestures, and refuses unknown actions', async () => {
    const r = await call(app, { method: 'PATCH', url: '/api/v1/me/prefs', token: A.token, body: { twoFingerTap: 'redo', threeFingerTap: 'fit', longPress: 'wheel' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.prefs.twoFingerTap, 'redo');
    assert.equal(r.body.prefs.longPress, 'wheel');
    assert.equal((await call(app, { url: '/api/v1/me', token: A.token })).body.prefs.threeFingerTap, 'fit');
    assert.equal((await call(app, { method: 'PATCH', url: '/api/v1/me/prefs', token: A.token, body: { twoFingerTap: 'explode' } })).status, 400);
  });

  test('only your own: another user is untouched', async () => {
    await call(app, { method: 'PATCH', url: '/api/v1/me/prefs', token: B.token, body: { units: 'metric' } });
    assert.equal((await call(app, { url: '/api/v1/me', token: A.token })).body.prefs.units, 'imperial');
    assert.equal((await call(app, { url: '/api/v1/me', token: B.token })).body.prefs.units, 'metric');
  });

  test('refuses unknown keys and values, empty bodies, no session and missing CSRF header', async () => {
    const bad = await call(app, { method: 'PATCH', url: '/api/v1/me/prefs', token: A.token, body: { units: 'furlongs' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'validation_failed');
    assert.ok(!JSON.stringify(bad.body).includes('furlongs'), 'error echoes input');
    assert.equal((await call(app, { method: 'PATCH', url: '/api/v1/me/prefs', token: A.token, body: { colour: 'red' } })).status, 400);
    assert.equal((await call(app, { method: 'PATCH', url: '/api/v1/me/prefs', token: A.token, body: {} })).status, 400);
    assert.equal((await call(app, { method: 'PATCH', url: '/api/v1/me/prefs', body: { units: 'metric' } })).status, 401);
    const s = await call(app, { method: 'POST', url: '/api/v1/auth/login', body: { email: A.email, password: A.password } });
    const cookie = s.cookies.find((c) => c.name === 'ft_session').value;
    const noCsrf = await call(app, { method: 'PATCH', url: '/api/v1/me/prefs', cookie, csrf: false, body: { units: 'metric' } });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.body.error.code, 'csrf_failed');
  });

  test('a session still waiting for its MFA code cannot change prefs', async () => {
    const s = await call(app, { method: 'POST', url: '/api/v1/auth/login', body: { email: A.email, password: A.password, mode: 'bearer' } });
    assert.equal(s.body.mfa, 'verify');
    const r = await call(app, { method: 'PATCH', url: '/api/v1/me/prefs', token: s.body.token, body: { units: 'metric' } });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'mfa_required');
  });

  test('changes are audited in the company chain', async () => {
    const { rows } = await t.superPool.query("SELECT actor_id, summary FROM audit_events WHERE tenant_id = $1 AND action = 'user.prefs'", [A.tenantId]);
    assert.ok(rows.length >= 2);
    assert.equal(rows[0].actor_id, A.userId);
  });
});
