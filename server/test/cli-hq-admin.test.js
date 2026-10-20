// The command-line tools that make the first HQ admin and company in production (no seed there):
// secrets only to a terminal (or an explicit --secret-to-stdout), the set-password link works
// once and leads to an HQ that still demands TOTP, and promoting a company owner keeps their
// password and is audited.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { skip, createTestDatabase } from './support/db.js';
import { call, enrolTotp, ORIGIN } from './support/app.js';
import { startHqApp } from './support/hq.js';
import { createHqAdmin } from '../src/cli/create-hq-admin.js';
import { secretOutputProblem } from '../src/cli/reveal.js';
import { createTenantWithOwner } from '../src/services/tenants.js';
import { sha256 } from '../src/lib/crypto.js';

const SERVER = fileURLToPath(new URL('..', import.meta.url));

describe('secret output guard', () => {
  test('a terminal or an explicit --secret-to-stdout is required', () => {
    assert.equal(secretOutputProblem({ isTTY: true, allowPipe: false }), null);
    assert.equal(secretOutputProblem({ isTTY: false, allowPipe: true }), null);
    assert.match(secretOutputProblem({ isTTY: false, allowPipe: false }), /not a terminal/);
  });

  test('the CLIs refuse a piped stdout before touching the database', () => {
    // DATABASE_URL points nowhere: the guard must stop them first.
    const env = { ...process.env, APP_ENV: 'test', DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' };
    for (const args of [
      ['src/cli/create-hq-admin.js', '--email', 'hq@fishtape.test', '--name', 'HQ Person'],
      ['src/cli/create-tenant.js', '--name', 'Pipe Co', '--email', 'pipe@fishtape.test'],
    ]) {
      const r = spawnSync(process.execPath, args, { cwd: SERVER, env, encoding: 'utf8' });
      assert.equal(r.status, 2, `${args[0]}: ${r.stderr}`);
      assert.equal(r.stdout, '', `${args[0]} wrote to stdout`);
      assert.match(r.stderr, /--secret-to-stdout/);
    }
  });
});

let t, app;
before(async () => {
  if (skip) return;
  t = await createTestDatabase('clihq');
  ({ app } = await startHqApp(t));
});
after(async () => { await app?.close(); await t?.close(); });

describe('create-hq-admin', { skip }, () => {
  test('a new HQ admin gets no password, a one-time link, and HQ only after TOTP', async () => {
    const r = await createHqAdmin(t.db, { email: 'First.Admin@Fishtape.test', name: 'First Admin', origin: ORIGIN });
    assert.equal(r.action, 'created');
    const m = r.link.match(/^https:\/\/app\.fishtape\.test\/#\/reset-password\?token=(ftr_[A-Za-z0-9_-]+)$/);
    assert.ok(m, r.link);
    const token = decodeURIComponent(m[1]);

    const user = (await t.superPool.query('SELECT email, platform_role, password_hash FROM users WHERE id = $1', [r.userId])).rows[0];
    assert.deepEqual(user, { email: 'first.admin@fishtape.test', platform_role: 'hq_admin', password_hash: null });
    const reset = (await t.superPool.query('SELECT token_hash, purpose, used_at FROM password_resets WHERE user_id = $1', [r.userId])).rows;
    assert.equal(reset.length, 1);
    assert.equal(reset[0].purpose, 'invite');
    assert.deepEqual(reset[0].token_hash, sha256(token), 'only the hash is stored');
    const audit = (await t.superPool.query("SELECT tenant_id, actor_type, summary FROM audit_events WHERE action = 'hq.staff_created' AND record_id = $1", [r.userId])).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].tenant_id, null);
    assert.equal(audit[0].actor_type, 'system');
    assert.ok(!audit[0].summary.includes('first.admin'), 'no email in the audit summary');

    const password = 'a long first admin passphrase';
    const set = await call(app, { method: 'POST', url: '/api/v1/auth/password/reset', body: { token, newPassword: password } });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const again = await call(app, { method: 'POST', url: '/api/v1/auth/password/reset', body: { token, newPassword: 'another long passphrase' } });
    assert.equal(again.status, 400, 'the link works once');

    const signIn = await call(app, { method: 'POST', url: '/api/v1/auth/login', body: { email: 'first.admin@fishtape.test', password, mode: 'bearer' } });
    assert.equal(signIn.status, 200);
    assert.equal(signIn.body.mfa, 'enrol');
    const before = await call(app, { url: '/api/hq/me', token: signIn.body.token });
    assert.equal(before.body.error.code, 'mfa_enrolment_required');
    await enrolTotp(app, signIn.body.token);
    const me = await call(app, { url: '/api/hq/me', token: signIn.body.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.role, 'hq_admin');
  });

  test('an existing account is refused without --promote, then promoted keeping its password', async () => {
    const password = 'company owner passphrase';
    const { userId } = await createTenantWithOwner(t.db, {
      name: 'CLI Electric', province: 'AB', owner: { email: 'owner@cli-electric.test', password, displayName: 'Owner' },
      actor: { type: 'system', id: 'test' },
    });
    await assert.rejects(createHqAdmin(t.db, { email: 'owner@cli-electric.test', origin: ORIGIN }), /--promote/);
    const hashBefore = (await t.superPool.query('SELECT password_hash FROM users WHERE id = $1', [userId])).rows[0].password_hash;

    const r = await createHqAdmin(t.db, { email: 'OWNER@cli-electric.test', promote: true, origin: ORIGIN });
    assert.deepEqual(r, { userId, action: 'promoted', link: null });
    const u = (await t.superPool.query('SELECT platform_role, password_hash FROM users WHERE id = $1', [userId])).rows[0];
    assert.equal(u.platform_role, 'hq_admin');
    assert.equal(u.password_hash, hashBefore);
    assert.equal((await t.superPool.query('SELECT count(*)::int AS n FROM password_resets WHERE user_id = $1', [userId])).rows[0].n, 0);
    const audit = (await t.superPool.query("SELECT meta FROM audit_events WHERE action = 'hq.staff_role_set' AND record_id = $1", [userId])).rows;
    assert.equal(audit.length, 1);
    assert.deepEqual(audit[0].meta, { role: 'hq_admin', previousRole: null });

    assert.equal((await createHqAdmin(t.db, { email: 'owner@cli-electric.test', promote: true, origin: ORIGIN })).action, 'unchanged');
    // Still the company's owner, and still able to sign in with the same password.
    const signIn = await call(app, { method: 'POST', url: '/api/v1/auth/login', body: { email: 'owner@cli-electric.test', password, mode: 'bearer' } });
    assert.equal(signIn.status, 200);
  });

  test('bad input changes nothing', async () => {
    const users = async () => (await t.superPool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
    const n = await users();
    await assert.rejects(createHqAdmin(t.db, { email: 'nobody@fishtape.test', promote: true, origin: ORIGIN }), /No account/);
    await assert.rejects(createHqAdmin(t.db, { email: 'x@fishtape.test', role: 'owner', origin: ORIGIN }), /--role/);
    await assert.rejects(createHqAdmin(t.db, { email: 'not-an-email', origin: ORIGIN }), /--email/);
    assert.equal(await users(), n);
  });
});
