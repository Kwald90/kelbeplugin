// Notifications: notify() fans out to the right members, each person reads and changes only their
// own, another company's people never see them (API and RLS), API keys have no bell, the digest
// setting is per person and audited, and the daily digest queues one platform email.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { skip, createTestDatabase } from './support/db.js';
import { addMember, apiKey, call, ownerTenant, startApp } from './support/app.js';
import { notify } from '../src/services/notify.js';
import { runNotificationDigest } from '../src/routes/v1/notifications.js';
import { recordStripePayment } from '../src/integrations/payments.js';
import { createRecords } from '../src/services/records.js';
import { createValidator } from '../src/schemas.js';

let t, app, config, A, B, officeA, crewA, keyA;
const list = (token, qs = '') => call(app, { url: `/api/v1/notifications${qs}`, token });

before(async () => {
  if (skip) return;
  t = await createTestDatabase('notifications');
  ({ app, config } = await startApp(t));
  A = await ownerTenant(t, app, 'Alpha Notify');
  B = await ownerTenant(t, app, 'Bravo Notify');
  officeA = await addMember(t, app, A.tenantId, { role: 'office' });
  crewA = await addMember(t, app, A.tenantId, { role: 'electrician' });
  keyA = await apiKey(app, A.token, ['*:read']);
});
after(async () => { await app?.close(); await t?.close(); });

describe('notifications', { skip }, () => {
  test('notify() reaches the members a permission, role or user id names, once per ref', async () => {
    const n = await t.db.withTenant({ tenantId: A.tenantId }, (tx) => notify(tx, { perm: 'invoices', kind: 'payment', title: 'Card payment of $12.00 received online', link: '#/invoices/i1', ref: 'payment:p1' }), { write: true });
    assert.equal(n, 2, 'owner and office have invoices; the electrician does not');
    const again = await t.db.withTenant({ tenantId: A.tenantId }, (tx) => notify(tx, { perm: 'invoices', kind: 'payment', title: 'dup', ref: 'payment:p1' }), { write: true });
    assert.equal(again, 0, 'same ref is once-only');
    const one = await t.db.withTenant({ tenantId: A.tenantId }, (tx) => notify(tx, { userId: crewA.userId, kind: 'job_assigned', title: 'You are on J-1', link: '#/jobs/j1' }), { write: true });
    assert.equal(one, 1);
    const roles = await t.db.withTenant({ tenantId: A.tenantId }, (tx) => notify(tx, { role: ['owner'], kind: 'system', title: 'Owners only' }), { write: true });
    assert.equal(roles, 1);
    // B's owner is not a member of A: a user id from another company reaches nobody.
    const cross = await t.db.withTenant({ tenantId: A.tenantId }, (tx) => notify(tx, { userId: B.userId, kind: 'system', title: 'Sneaky' }), { write: true });
    assert.equal(cross, 0);
    // Bad input never throws, and never breaks the caller's transaction.
    const bad = await t.db.withTenant({ tenantId: A.tenantId }, async (tx) => {
      const r = await notify(tx, { userId: 'not-a-uuid', kind: 'system', title: 'x' });
      const still = await tx.query('SELECT 1 AS ok');
      return [r, still.rows[0].ok];
    }, { write: true });
    assert.deepEqual(bad, [0, 1]);
    assert.equal(await t.db.withTenant({ tenantId: A.tenantId }, (tx) => notify(tx, { userId: crewA.userId, kind: 'Bad Kind', title: 'x' })), 0);
    assert.equal(await t.db.withTenant({ tenantId: A.tenantId }, (tx) => notify(tx, { userId: crewA.userId, kind: 'system', title: 'x', link: 'https://evil.example' })), 1, 'outside links are dropped, the notification kept');
  });

  test('each person sees only their own', async () => {
    const owner = await list(A.token);
    assert.equal(owner.status, 200);
    assert.deepEqual(owner.body.data.map((n) => n.title).sort(), ['Card payment of $12.00 received online', 'Owners only']);
    assert.equal(owner.body.unread, 2);
    assert.equal(owner.headers['cache-control'], 'no-store');
    const office = await list(officeA.token);
    assert.deepEqual(office.body.data.map((n) => n.title), ['Card payment of $12.00 received online']);
    const crew = await list(crewA.token);
    assert.deepEqual(crew.body.data.map((n) => n.title).sort(), ['You are on J-1', 'x']);
    assert.equal(crew.body.data.find((n) => n.title === 'x').link, null);
    const other = await list(B.token);
    assert.deepEqual(other.body.data, [], 'another company sees nothing');
  });

  test('marking read: own rows only, by id or all', async () => {
    const officeRow = (await list(officeA.token)).body.data[0];
    // The owner sends the office person's id: nothing changes.
    const r = await call(app, { method: 'PATCH', url: '/api/v1/notifications', token: A.token, body: { ids: [officeRow.id], read: true } });
    assert.equal(r.status, 200);
    assert.equal(r.body.updated, 0);
    assert.equal((await list(officeA.token)).body.unread, 1);
    // B tries the same.
    const rb = await call(app, { method: 'PATCH', url: '/api/v1/notifications', token: B.token, body: { all: true, read: true } });
    assert.equal(rb.body.updated, 0);
    assert.equal((await list(officeA.token)).body.unread, 1);
    const mine = await call(app, { method: 'PATCH', url: '/api/v1/notifications', token: officeA.token, body: { ids: [officeRow.id], read: true } });
    assert.equal(mine.body.updated, 1);
    assert.equal(mine.body.unread, 0);
    const all = await call(app, { method: 'PATCH', url: '/api/v1/notifications', token: A.token, body: { all: true, read: true } });
    assert.equal(all.body.updated, 2);
    assert.equal((await list(A.token, '?unread=true')).body.data.length, 0);
    const back = await call(app, { method: 'PATCH', url: '/api/v1/notifications', token: A.token, body: { ids: [(await list(A.token)).body.data[0].id], read: false } });
    assert.equal(back.body.unread, 1);
    const empty = await call(app, { method: 'PATCH', url: '/api/v1/notifications', token: A.token, body: { read: true } });
    assert.equal(empty.status, 400);
  });

  test('API keys have no bell', async () => {
    assert.equal((await list(keyA)).status, 403);
    assert.equal((await call(app, { method: 'PATCH', url: '/api/v1/notifications', token: keyA, body: { all: true, read: true } })).status, 403);
  });

  test('paging with a cursor', async () => {
    for (let i = 0; i < 5; i++) await t.db.withTenant({ tenantId: A.tenantId }, (tx) => notify(tx, { userId: A.userId, kind: 'system', title: `Page ${i}` }), { write: true });
    const first = await list(A.token, '?limit=3');
    assert.equal(first.body.data.length, 3);
    assert.ok(first.body.more && first.body.cursor);
    const second = await list(A.token, `?limit=3&cursor=${encodeURIComponent(first.body.cursor)}`);
    const ids = new Set([...first.body.data, ...second.body.data].map((n) => n.id));
    assert.equal(ids.size, first.body.data.length + second.body.data.length, 'no repeats');
    assert.equal((await list(A.token, '?cursor=nope')).status, 400);
  });

  test('RLS: the app role sees only the person and company set on the transaction', async () => {
    const asCrew = await t.db.withTenant({ tenantId: A.tenantId, userId: crewA.userId }, (tx) => tx.query('SELECT title FROM notifications'));
    assert.ok(asCrew.rows.every((r) => ['You are on J-1', 'x'].includes(r.title)));
    const noUser = await t.db.withTenant({ tenantId: A.tenantId }, (tx) => tx.query('SELECT count(*)::int AS n FROM notifications'));
    assert.equal(noUser.rows[0].n, 0, 'no person set: no rows');
    const wrongCo = await t.db.withTenant({ tenantId: B.tenantId, userId: crewA.userId }, (tx) => tx.query('SELECT count(*)::int AS n FROM notifications'));
    assert.equal(wrongCo.rows[0].n, 0);
    // Writing a row into another company is refused by WITH CHECK.
    await assert.rejects(t.db.withTenant({ tenantId: B.tenantId }, (tx) => tx.query(
      "INSERT INTO notifications (tenant_id, user_id, kind, title) VALUES ($1, $2, 'system', 'x')", [A.tenantId, A.userId])), /row-level security/);
    const upd = await t.db.withTenant({ tenantId: A.tenantId, userId: officeA.userId }, (tx) => tx.query("UPDATE notifications SET title = 'hacked' WHERE user_id = $1", [crewA.userId]));
    assert.equal(upd.rowCount, 0);
    const { rows } = await t.superPool.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('notifications', 'notification_prefs')");
    assert.equal(rows.length, 2);
    for (const r of rows) assert.ok(r.relrowsecurity && r.relforcerowsecurity);
  });

  test('a Stripe payment notifies the people who handle invoices', async () => {
    const records = createRecords({ validator: createValidator() });
    const p = { kind: 'session', tenantId: A.tenantId, userId: null, role: 'owner', perms: new Set(['invoices']), isManager: true, scopes: null, actor: { type: 'system', id: 'stripe', label: 'Stripe' } };
    const who = { actor: p.actor, request: {} };
    await t.db.withTenant({ tenantId: A.tenantId }, async (tx) => {
      await records.createRecord(tx, p, 'invoices', { id: 'inv-n1', number: 'INV-9001', status: 'sent', lines: [{ description: 'Work', qty: 1, unitCents: 10000, kind: 'labour' }], taxes: [] }, who);
      const r = await recordStripePayment(tx, records, p, who, { id: 'cs_1', payment_intent: 'pi_n1', amount_total: 10000, metadata: { fishtape_invoice: 'inv-n1' }, currency: 'cad' }, 'evt_1');
      assert.equal(r.recorded, true);
    }, { write: true });
    const office = await list(officeA.token);
    const pay = office.body.data.find((n) => n.kind === 'payment' && n.link === '#/invoices/inv-n1');
    assert.ok(pay, 'office got the payment');
    assert.equal(pay.title, 'Card payment of $100.00 received online');
    assert.ok(!(await list(crewA.token)).body.data.some((n) => n.kind === 'payment'));
  });

  test('digest setting is per person, audited, and the digest queues one email', async () => {
    assert.equal((await call(app, { url: '/api/v1/notifications/prefs', token: officeA.token })).body.digest, false, 'off by default');
    const on = await call(app, { method: 'PUT', url: '/api/v1/notifications/prefs', token: officeA.token, body: { digest: true } });
    assert.equal(on.status, 200);
    assert.equal((await call(app, { url: '/api/v1/notifications/prefs', token: crewA.token })).body.digest, false);
    const audit = await t.superPool.query("SELECT summary FROM audit_events WHERE action = 'notifications.digest' AND tenant_id = $1", [A.tenantId]);
    assert.equal(audit.rows.length, 1);
    await t.superPool.query("UPDATE notifications SET read_at = NULL WHERE user_id = $1", [officeA.userId]);
    const r = await runNotificationDigest(t.db, { config });
    assert.equal(r.sent, 1);
    const mail = await t.superPool.query("SELECT to_address, subject, text_body FROM email_outbox WHERE template = 'notifications-digest'");
    assert.equal(mail.rows.length, 1);
    assert.equal(mail.rows[0].to_address, officeA.email);
    assert.match(mail.rows[0].text_body, /Card payment/);
    assert.match(mail.rows[0].text_body, /#\/notifications/);
    assert.equal((await runNotificationDigest(t.db, { config })).sent, 0, 'nothing new, nothing sent');
  });
});
