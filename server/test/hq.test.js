// HQ console API: staff-only with MFA, the tenant lifecycle (create + invite, suspend,
// plan, export, two-step delete with grace and the worker purge), support access that the
// company's owner can see, flags, compliance and developer health.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skip, createTestDatabase } from './support/db.js';
import { call, login, ownerTenant, addMember } from './support/app.js';
import { hqUser, startHqApp } from './support/hq.js';
import { HANDLERS, runOnce } from '../src/services/queue.js';
import { HQ_HANDLERS } from '../src/services/hq-jobs.js';
import { hashSecret } from '../src/auth/passwords.js';

let t, app, A, B, admin, staff, tmp;

before(async () => {
  if (skip) return;
  t = await createTestDatabase('hq');
  tmp = mkdtempSync(join(tmpdir(), 'fishtape-hq-'));
  writeFileSync(join(tmp, 'backup.json'), JSON.stringify({ at: new Date(Date.now() - 3 * 3600e3).toISOString(), ok: true, sizeBytes: 12345, target: 's3://backups' }));
  writeFileSync(join(tmp, 'deploys.log'), [
    JSON.stringify({ at: '2026-10-18T10:00:00Z', sha: 'abc1234', env: 'staging', ok: true, message: 'first' }),
    '2026-10-19T09:00:00Z def5678 second deploy',
  ].join('\n'));
  writeFileSync(join(tmp, 'controls.yaml'), [
    'controls:',
    '  - id: CC6.1',
    '    title: MFA for owners, admins and HQ',
    '    tsc: [CC6.1]',
    '    owner: Kelvin',
    '    frequency: continuous',
    '    evidence: server/test/auth.test.js',
    '    status: implemented',
    '    links:',
    '      - docs/architecture/adr-003-auth-sessions.md',
  ].join('\n'));
  ({ app } = await startHqApp(t, {
    env: { BACKUP_STATUS_FILE: join(tmp, 'backup.json') },
    hq: { controlsFile: join(tmp, 'controls.yaml'), deployLogFile: join(tmp, 'deploys.log') },
  }));
  A = await ownerTenant(t, app, 'Alpha Wiring');
  B = await ownerTenant(t, app, 'Bravo Power');
  admin = await hqUser(t, app, 'hq_admin');
  staff = await hqUser(t, app, 'hq_staff');
  await call(app, { method: 'POST', url: '/api/v1/clients', token: A.token, body: { id: 'c-a1', name: 'Alpha Client', email: 'client@alpha.example' } });
});
after(async () => { await app?.close(); await t?.close(); });

const hq = (token, url, opts = {}) => call(app, { url, token, ...opts });
const events = async (tenantId, action) => (await t.superPool.query('SELECT * FROM audit_events WHERE tenant_id IS NOT DISTINCT FROM $1 AND action = $2 ORDER BY seq', [tenantId, action])).rows;

describe('HQ access', { skip }, () => {
  test('anonymous callers and company owners are refused', async () => {
    for (const url of ['/api/hq/overview', '/api/hq/tenants', '/api/hq/dev-health', '/api/hq/billing', '/api/hq/leads', '/api/hq/compliance/access-review']) {
      assert.equal((await call(app, { url })).status, 401, url);
      const r = await call(app, { url, token: A.token });
      assert.equal(r.status, 403, url);
      assert.equal(r.body.error.code, 'forbidden', url);
    }
  });

  test('HQ staff must enrol MFA, then verify it on every new session', async () => {
    const email = 'new-hq@fishtape.test';
    const password = 'a long hq passphrase';
    await t.superPool.query("INSERT INTO users (email, display_name, password_hash, platform_role) VALUES ($1, 'New HQ', $2, 'hq_staff')", [email, await hashSecret(password)]);
    const first = await call(app, { method: 'POST', url: '/api/v1/auth/login', body: { email, password, mode: 'bearer' } });
    assert.equal((await hq(first.body.token, '/api/hq/overview')).body.error.code, 'mfa_enrolment_required');
    const { enrolTotp } = await import('./support/app.js');
    const { totp } = await enrolTotp(app, first.body.token);
    assert.equal((await hq(first.body.token, '/api/hq/me')).status, 200);
    const second = await call(app, { method: 'POST', url: '/api/v1/auth/login', body: { email, password, mode: 'bearer' } });
    assert.equal((await hq(second.body.token, '/api/hq/me')).body.error.code, 'mfa_required');
    const verified = await login(app, email, password, { totp });
    const me = await hq(verified.token, '/api/hq/me');
    assert.equal(me.body.user.role, 'hq_staff');
  });

  test('HQ staff can look; only HQ admins change things', async () => {
    assert.equal((await hq(staff.token, '/api/hq/overview')).status, 200);
    const r = await hq(staff.token, `/api/hq/tenants/${A.tenantId}/status`, { method: 'POST', body: { status: 'suspended', reason: 'testing staff' } });
    assert.equal(r.status, 403);
    assert.equal((await hq(staff.token, '/api/hq/flags/signup_open', { method: 'PUT', body: { enabled: true } })).status, 403);
    assert.equal((await hq(staff.token, `/api/hq/tenants/${A.tenantId}/export`)).status, 403);
  });
});

describe('tenant lifecycle', { skip }, () => {
  let created;

  test('create a company and invite its owner', async () => {
    const r = await hq(admin.token, '/api/hq/tenants', { method: 'POST', body: { name: 'Charlie Electric', province: 'SK', ownerEmail: 'Owner@Charlie.example', ownerName: 'Char Lee' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.ownerInvited, true);
    created = r.body.tenant;
    const row = (await t.superPool.query('SELECT plan, trial_ends_at FROM tenants WHERE id = $1', [created.id])).rows[0];
    assert.equal(row.plan, 'trial');
    const days = (new Date(row.trial_ends_at) - Date.now()) / 86_400_000;
    assert.ok(days > 29 && days <= 30, `trial ends in ${days} days`);
    const m = (await t.superPool.query("SELECT m.status FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1 AND u.email = 'owner@charlie.example'", [created.id])).rows[0];
    assert.equal(m.status, 'invited');
    const mail = (await t.superPool.query("SELECT template FROM email_outbox WHERE to_address = 'owner@charlie.example'")).rows;
    assert.deepEqual(mail.map((x) => x.template), ['invite']);
    const ev = await events(created.id, 'tenant.create');
    assert.equal(ev[0].actor_type, 'hq');
  });

  test('list, search (term in the body) and detail', async () => {
    const list = await hq(staff.token, '/api/hq/tenants');
    const alpha = list.body.data.find((x) => x.id === A.tenantId);
    assert.equal(alpha.effectivePlan, 'business');
    assert.equal(alpha.seats.used, 1);
    const s = await hq(staff.token, '/api/hq/tenants/search', { method: 'POST', body: { q: 'charlie.example' } });
    assert.deepEqual(s.body.data.map((x) => x.id), [created.id]);
    const d = await hq(staff.token, `/api/hq/tenants/${A.tenantId}`);
    assert.equal(d.status, 200);
    assert.equal(d.body.members[0].role, 'owner');
    assert.equal(d.body.members[0].mfaEnrolled, true);
    assert.equal(d.body.recordCounts.clients, 1);
    assert.ok(!JSON.stringify(d.body).includes('password'), 'no password fields');
    assert.ok((await events(null, 'hq.tenant_view')).length >= 1);
  });

  test('suspend needs a reason, blocks the company, shows in its log; reactivate restores', async () => {
    const noReason = await hq(admin.token, `/api/hq/tenants/${B.tenantId}/status`, { method: 'POST', body: { status: 'suspended' } });
    assert.equal(noReason.status, 400);
    const s = await hq(admin.token, `/api/hq/tenants/${B.tenantId}/status`, { method: 'POST', body: { status: 'suspended', reason: 'Unpaid for 60 days' } });
    assert.equal(s.body.status, 'suspended');
    assert.equal((await call(app, { url: '/api/v1/clients', token: B.token })).body.error.code, 'tenant_inactive');
    const r = await hq(admin.token, `/api/hq/tenants/${B.tenantId}/status`, { method: 'POST', body: { status: 'active' } });
    assert.equal(r.body.status, 'active');
    assert.equal((await call(app, { url: '/api/v1/clients', token: B.token })).status, 200);
    const ev = await events(B.tenantId, 'hq.tenant_suspend');
    assert.match(ev[0].summary, /Unpaid for 60 days/);
    assert.equal((await events(B.tenantId, 'hq.tenant_reactivate')).length, 1);
  });

  test('plan, trial end and overrides are validated and audited in the company log', async () => {
    const bad = await hq(admin.token, `/api/hq/tenants/${created.id}/plan`, { method: 'PATCH', body: { overrides: { teleport: true } } });
    assert.equal(bad.status, 400);
    const r = await hq(admin.token, `/api/hq/tenants/${created.id}/plan`, { method: 'PATCH', body: { plan: 'starter', overrides: { drawings: true } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.plan, 'starter');
    assert.deepEqual(r.body.overrides, { drawings: true });
    const ev = await events(created.id, 'hq.plan_change');
    assert.match(ev[0].summary, /trial -> starter/);
    assert.match(ev[0].summary, /drawings:on/);
  });

  test('export is all of the company\'s data and none of its secrets', async () => {
    await call(app, { method: 'PUT', url: '/api/v1/secrets/stripe.secret_key', token: A.token, body: { value: 'sk_test_SUPERSECRETVALUE' } });
    await call(app, { method: 'POST', url: '/api/v1/drawings', token: A.token, body: { id: 'd-1', name: 'Plan' } });
    await call(app, { method: 'DELETE', url: '/api/v1/drawings/d-1', token: A.token });
    const r = await hq(admin.token, `/api/hq/tenants/${A.tenantId}/export`);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-disposition'], undefined, 'no filename (and so no company detail) in headers');
    assert.equal(r.body.company.id, A.tenantId);
    assert.equal(r.body.collections.clients[0].name, 'Alpha Client');
    assert.deepEqual(r.body.collections.drawings[0].deleted, true);
    assert.equal(r.body.members[0].email, A.email);
    const text = JSON.stringify(r.body);
    for (const s of ['SUPERSECRETVALUE', 'password_hash', 'pin_hash', 'secret_enc', 'value_enc', 'key_hash']) assert.ok(!text.includes(s), s);
    assert.ok(r.body.auditLog.length > 3);
    assert.equal((await events(A.tenantId, 'hq.tenant_export')).length, 1);
  });

  test('delete is two steps: export first, then close with a grace period and a queued purge', async () => {
    const noExport = await hq(admin.token, `/api/hq/tenants/${B.tenantId}/delete`, { method: 'POST', body: { confirmSlug: 'bravo-power', reason: 'Customer asked to close' } });
    assert.equal(noExport.status, 409);
    assert.equal(noExport.body.error.code, 'export_required');
    await hq(admin.token, `/api/hq/tenants/${B.tenantId}/export`);
    const wrongSlug = await hq(admin.token, `/api/hq/tenants/${B.tenantId}/delete`, { method: 'POST', body: { confirmSlug: 'bravo', reason: 'Customer asked to close' } });
    assert.equal(wrongSlug.status, 400);
    const r = await hq(admin.token, `/api/hq/tenants/${B.tenantId}/delete`, { method: 'POST', body: { confirmSlug: 'bravo-power', reason: 'Customer asked to close' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'closed');
    const days = (new Date(r.body.deleteAfter) - Date.now()) / 86_400_000;
    assert.ok(days > 29.9 && days < 30.1, `${days} days (calendar days, so a DST change moves it by an hour)`);
    const job = (await t.superPool.query("SELECT payload, run_at, tenant_id FROM jobs_queue WHERE kind = 'tenant_purge'")).rows;
    assert.equal(job.length, 1);
    assert.equal(job[0].payload.tenantId, B.tenantId);
    assert.equal(job[0].tenant_id, null, 'the job survives the purge it runs');
    assert.equal(new Date(job[0].run_at).getTime(), new Date(r.body.deleteAfter).getTime());
    assert.equal((await call(app, { url: '/api/v1/clients', token: B.token })).body.error.code, 'tenant_inactive');
    assert.equal((await hq(admin.token, `/api/hq/tenants/${B.tenantId}/status`, { method: 'POST', body: { status: 'active' } })).status, 409);

    const restored = await hq(admin.token, `/api/hq/tenants/${B.tenantId}/restore`, { method: 'POST' });
    assert.equal(restored.body.status, 'active');
    assert.equal(restored.body.deleteAfter, null);
    // The old job is now stale: running it early leaves the company alone.
    await t.superPool.query("UPDATE jobs_queue SET run_at = now() WHERE kind = 'tenant_purge'");
    const stale = await runOnce(t.db, { handlers: { ...HANDLERS, ...HQ_HANDLERS } });
    assert.deepEqual(stale.result, { purged: false });
    assert.equal((await t.superPool.query('SELECT count(*)::int AS n FROM tenants WHERE id = $1', [B.tenantId])).rows[0].n, 1);
  });

  test('after the grace period the worker purges the company; its audit chain stays', async () => {
    await call(app, { method: 'POST', url: '/api/v1/clients', token: B.token, body: { id: 'c-b1', name: 'Bravo Client' } });
    const crew = await addMember(t, app, B.tenantId, { role: 'electrician' });
    const r = await hq(admin.token, `/api/hq/tenants/${B.tenantId}/delete`, { method: 'POST', body: { confirmSlug: 'bravo-power', reason: 'Customer asked to close' } });
    assert.equal(r.body.status, 'closed');
    await t.superPool.query("UPDATE tenants SET delete_after = now() - interval '1 minute' WHERE id = $1", [B.tenantId]);
    await t.superPool.query("UPDATE jobs_queue SET run_at = now() WHERE kind = 'tenant_purge' AND status = 'queued'");
    const res = await runOnce(t.db, { handlers: { ...HANDLERS, ...HQ_HANDLERS } });
    assert.equal(res.outcome, 'done', JSON.stringify(res));
    assert.deepEqual(res.result, { purged: true });
    const q = async (sql) => (await t.superPool.query(sql, [B.tenantId])).rows[0].n;
    assert.equal(await q('SELECT count(*)::int AS n FROM tenants WHERE id = $1'), 0);
    assert.equal(await q('SELECT count(*)::int AS n FROM clients WHERE tenant_id = $1'), 0);
    assert.equal(await q('SELECT count(*)::int AS n FROM memberships WHERE tenant_id = $1'), 0);
    assert.ok(await q('SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1') > 3, 'audit chain kept');
    const users = await t.superPool.query('SELECT id FROM users WHERE id = ANY($1)', [[B.userId, crew.userId]]);
    assert.equal(users.rows.length, 0, 'accounts that only belonged to this company are gone');
    assert.equal((await t.superPool.query('SELECT 1 FROM users WHERE id = $1', [admin.userId])).rows.length, 1);
    assert.equal((await events(null, 'tenant.purged')).length, 1);
    assert.equal((await call(app, { url: '/api/v1/clients', token: B.token })).status, 401, 'sessions went with the accounts');
  });
});

describe('support access', { skip }, () => {
  let grant;

  test('no grant, no data', async () => {
    const r = await hq(staff.token, `/api/hq/tenants/${A.tenantId}/support/clients`);
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'support_access_required');
  });

  test('a grant needs a real reason and is time-boxed', async () => {
    assert.equal((await hq(staff.token, `/api/hq/tenants/${A.tenantId}/support-access`, { method: 'POST', body: { reason: 'help' } })).status, 400);
    assert.equal((await hq(staff.token, `/api/hq/tenants/${A.tenantId}/support-access`, { method: 'POST', body: { reason: 'Owner reported a sync problem', minutes: 600 } })).status, 400);
    const r = await hq(staff.token, `/api/hq/tenants/${A.tenantId}/support-access`, { method: 'POST', body: { reason: 'Owner reported a sync problem, ticket 42', minutes: 30 } });
    assert.equal(r.status, 201);
    grant = r.body;
    const mins = (new Date(grant.expiresAt) - new Date(grant.createdAt)) / 60000;
    assert.equal(Math.round(mins), 30);
  });

  test('the owner sees support access and every support read in their security log', async () => {
    const r = await hq(staff.token, `/api/hq/tenants/${A.tenantId}/support/clients`);
    assert.equal(r.status, 200);
    assert.equal(r.body.readOnly, true);
    assert.equal(r.body.data[0].name, 'Alpha Client');
    const log = await call(app, { url: '/api/v1/auditLog?action=hq.support_access', token: A.token });
    assert.equal(log.status, 200);
    assert.equal(log.body.data.length, 1);
    assert.equal(log.body.data[0].actorType, 'hq');
    assert.match(log.body.data[0].summary, /ticket 42/);
    const reads = await call(app, { url: '/api/v1/auditLog?action=hq.support_read', token: A.token });
    assert.match(reads.body.data[0].summary, /clients/);
  });

  test('a grant covers one company and one staff member, and only for reading', async () => {
    assert.equal((await hq(admin.token, `/api/hq/tenants/${A.tenantId}/support/clients`)).status, 403, 'another staff member');
    const other = await ownerTenant(t, app, 'Delta Lighting');
    assert.equal((await hq(staff.token, `/api/hq/tenants/${other.tenantId}/support/clients`)).status, 403, 'another company');
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      const r = await hq(staff.token, `/api/hq/tenants/${A.tenantId}/support/clients`, { method, body: {} });
      assert.equal(r.status, 404, method);
    }
    const unknown = await hq(staff.token, `/api/hq/tenants/${A.tenantId}/support/tenant_secrets`);
    assert.equal(unknown.status, 404);
  });

  test('ending it early, or letting it expire, closes access', async () => {
    const end = await hq(staff.token, `/api/hq/support-access/${grant.id}`, { method: 'DELETE' });
    assert.equal(end.status, 204);
    assert.equal((await hq(staff.token, `/api/hq/tenants/${A.tenantId}/support/clients`)).status, 403);
    assert.equal((await events(A.tenantId, 'hq.support_access_end')).length, 1);
    await t.superPool.query(
      "INSERT INTO support_grants (tenant_id, hq_user_id, reason, created_at, expires_at) VALUES ($1, $2, 'expired grant for the test', now() - interval '2 hours', now() - interval '1 hour')",
      [A.tenantId, staff.userId]);
    assert.equal((await hq(staff.token, `/api/hq/tenants/${A.tenantId}/support/clients`)).status, 403);
  });
});

describe('flags, overview and activity', { skip }, () => {
  test('signup_open is switched by HQ admins and audited', async () => {
    const before = await call(app, { url: '/api/v1/auth/providers' });
    assert.equal(before.body.signupOpen, false);
    const r = await hq(admin.token, '/api/hq/flags/signup_open', { method: 'PUT', body: { enabled: true } });
    assert.equal(r.status, 200);
    assert.equal((await call(app, { url: '/api/v1/auth/providers' })).body.signupOpen, true);
    await hq(admin.token, '/api/hq/flags/signup_open', { method: 'PUT', body: { enabled: false } });
    const flags = await hq(staff.token, '/api/hq/flags');
    assert.equal(flags.body.data.find((f) => f.key === 'signup_open' && !f.tenantId).enabled, false);
    const tf = await hq(admin.token, '/api/hq/flags/beta_bending', { method: 'PUT', body: { enabled: true, tenantId: A.tenantId } });
    assert.equal(tf.status, 200);
    assert.equal((await events(A.tenantId, 'hq.flag_set')).length, 1);
    assert.equal((await events(null, 'hq.flag_set')).length, 2);
  });

  test('overview has the numbers', async () => {
    const r = await hq(staff.token, '/api/hq/overview');
    assert.equal(r.status, 200);
    assert.ok(r.body.tenants.total >= 3);
    assert.ok(r.body.activeUsers.month >= 2);
    assert.ok('mrrCents' in r.body && Array.isArray(r.body.trialsEnding));
    assert.ok(['ok', 'degraded', 'down'].includes(r.body.health.level));
  });

  test('HQ activity lists what staff did', async () => {
    const r = await hq(staff.token, '/api/hq/activity?limit=200');
    const actions = new Set(r.body.data.map((e) => e.action));
    for (const a of ['hq.tenant_suspend', 'hq.plan_change', 'hq.tenant_export', 'hq.support_access', 'hq.flag_set', 'tenant.purged']) assert.ok(actions.has(a), a);
  });
});

describe('compliance & security', { skip }, () => {
  test('controls come from the YAML file; a missing file is a clear state', async () => {
    const r = await hq(staff.token, '/api/hq/compliance/controls');
    assert.equal(r.body.found, true);
    assert.equal(r.body.controls[0].id, 'CC6.1');
    assert.deepEqual(r.body.controls[0].tsc, ['CC6.1']);
    assert.deepEqual(r.body.controls[0].links, ['docs/architecture/adr-003-auth-sessions.md']);
    const { app: other } = await startHqApp(t, { hq: { controlsFile: join(tmp, 'nope.yaml') } });
    const m = await call(other, { url: '/api/hq/compliance/controls', token: staff.token });
    assert.equal(m.body.found, false);
    assert.deepEqual(m.body.controls, []);
    await other.close();
  });

  test('access review: HQ staff and company owners/admins with MFA and last sign-in', async () => {
    const r = await hq(staff.token, '/api/hq/compliance/access-review');
    assert.equal(r.status, 200);
    const me = r.body.staff.find((s) => s.userId === staff.userId);
    assert.equal(me.mfaEnrolled, true);
    const owner = r.body.tenantAdmins.find((x) => x.tenantId === A.tenantId);
    assert.equal(owner.role, 'owner');
    assert.equal(owner.mfaEnrolled, true);
    const invited = r.body.tenantAdmins.find((x) => x.email === 'owner@charlie.example');
    assert.deepEqual(invited.findings, ['Invite not accepted yet']);
    const done = await hq(staff.token, '/api/hq/compliance/access-review/complete', { method: 'POST', body: { notes: 'Q4 review' } });
    assert.equal(done.status, 200);
    const again = await hq(staff.token, '/api/hq/compliance/access-review');
    assert.match(again.body.lastCompleted.summary, /Q4 review/);
  });

  test('incidents: open, timeline, severity, close', async () => {
    const r = await hq(staff.token, '/api/hq/compliance/incidents', { method: 'POST', body: { title: 'Sync errors for one company', severity: 'sev3', summary: '5xx on push' } });
    assert.equal(r.status, 201);
    const id = r.body.id;
    await hq(staff.token, `/api/hq/compliance/incidents/${id}/events`, { method: 'POST', body: { body: 'Found the cause' } });
    await hq(staff.token, `/api/hq/compliance/incidents/${id}/events`, { method: 'POST', body: { severity: 'sev2' } });
    await hq(staff.token, `/api/hq/compliance/incidents/${id}/events`, { method: 'POST', body: { status: 'closed', body: 'Fixed in abc1234' } });
    const d = await hq(staff.token, `/api/hq/compliance/incidents/${id}`);
    assert.equal(d.body.status, 'closed');
    assert.equal(d.body.severity, 'sev2');
    assert.ok(d.body.closedAt && d.body.resolvedAt);
    assert.deepEqual(d.body.timeline.map((e) => e.kind), ['opened', 'note', 'severity', 'status']);
    const closedNote = await hq(staff.token, `/api/hq/compliance/incidents/${id}/events`, { method: 'POST', body: { body: 'late note' } });
    assert.equal(closedNote.status, 409);
    const open = await hq(staff.token, '/api/hq/compliance/incidents?status=open');
    assert.ok(!open.body.data.some((i) => i.id === id));
    assert.equal((await events(null, 'hq.incident_update')).length, 3);
  });

  test('vendors and policy acknowledgements', async () => {
    const v = await hq(staff.token, '/api/hq/compliance/vendors');
    assert.ok(v.body.data.some((x) => x.name === 'Stripe'));
    assert.equal((await hq(staff.token, '/api/hq/compliance/vendors', { method: 'POST', body: { name: 'Acme Backups' } })).status, 403);
    const add = await hq(admin.token, '/api/hq/compliance/vendors', { method: 'POST', body: { name: 'Acme Backups', risk: 'high', dataShared: 'Encrypted database dumps' } });
    assert.equal(add.status, 201);
    const rev = await hq(admin.token, `/api/hq/compliance/vendors/${add.body.id}`, { method: 'PATCH', body: { reviewed: true, dpaSigned: true } });
    assert.equal(rev.body.dpaSigned, true);
    assert.ok(rev.body.lastReviewedAt);
    assert.ok(rev.body.reviewDue > new Date().toISOString().slice(0, 10));

    const p = await hq(staff.token, '/api/hq/compliance/policies');
    assert.ok(p.body.policies.length >= 8);
    const pol = p.body.policies[0];
    assert.equal(pol.mine, null);
    await hq(staff.token, `/api/hq/compliance/policies/${pol.id}/ack`, { method: 'POST' });
    const after = await hq(staff.token, '/api/hq/compliance/policies');
    assert.ok(after.body.policies.find((x) => x.id === pol.id).mine);
    await hq(admin.token, `/api/hq/compliance/policies/${pol.id}`, { method: 'PUT', body: { title: pol.title, version: '2.0' } });
    const bumped = await hq(staff.token, '/api/hq/compliance/policies');
    assert.equal(bumped.body.policies.find((x) => x.id === pol.id).mine, null, 'a new version needs a new acknowledgement');
  });
});

describe('developer health', { skip }, () => {
  test('reports versions, database, queue, backup, deploys, errors, disk and memory', async () => {
    await call(app, { url: '/api/v1/definitely-not-here' });
    const r = await hq(staff.token, '/api/hq/dev-health');
    assert.equal(r.status, 200);
    const h = r.body;
    for (const k of ['environment', 'version', 'gitSha', 'uptimeSeconds', 'database', 'migrations', 'queue', 'backup', 'deploys', 'errors', 'tls', 'disk', 'memory', 'environments', 'summary']) assert.ok(k in h, k);
    assert.equal(h.database.ok, true);
    assert.ok(h.database.latencyMs >= 0);
    assert.deepEqual(h.migrations.pending, []);
    assert.equal(h.migrations.current, '0022');
    assert.equal(h.backup.ok, true);
    assert.equal(h.backup.stale, false);
    assert.deepEqual(h.deploys.items.map((d) => d.sha), ['def5678', 'abc1234']);
    assert.ok(h.errors.lastHour.requests > 0);
    assert.ok(h.errors.lastHour.errors4xx >= 1);
    assert.equal(h.tls.checked, false);
    assert.ok(h.memory.rssBytes > 0);
    assert.ok(h.disk[0].totalBytes > 0);
    assert.ok(!JSON.stringify(h).includes('definitely-not-here'), 'metrics keep route patterns, not URLs');
  });

  test('the public status page endpoint stays tenant-free', async () => {
    const r = await call(app, { url: '/api/v1/status' });
    assert.equal(r.status, 200);
    assert.ok(!/tenant|email|Alpha/i.test(JSON.stringify(r.body)));
  });
});
