// Material requests and module switches on the server: crew file their own requests (no prices),
// "Send now" and the daily send deliver one combined list grouped by job to the office (bell,
// platform email, audit), the daily send happens once per local day in the company's time zone,
// another company never sees or sends them, and a turned-off module refuses writes with
// module_turned_off while its data stays readable.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { skip, createTestDatabase } from './support/db.js';
import { addMember, apiKey, call, ownerTenant, startApp } from './support/app.js';
import { runScheduledSend, scheduleMaterialRequestSends, SEND_KIND } from '../src/services/materials.js';
import { nextSendAt } from '../../electrical-app/js/lib/materials.js';
import { nextModules } from '../../electrical-app/js/lib/modules.js';

let t, app, A, B, office, sam, ana, keyA;
const mut = (o) => ({ mid: `m-${Math.random().toString(36).slice(2)}`, baseVersion: null, ...o });
const push = (token, mutations) => call(app, { method: 'POST', url: '/api/v1/sync/push', token, body: { mutations } });
const pushOne = async (token, m) => (await push(token, [mut(m)])).body.results[0];
const req = (o) => ({ status: 'requested', qty: 1, unit: 'ea', urgent: false, note: '', updatedAt: new Date().toISOString(), ...o });
const settingsA = { company: { name: 'Alpha Electric', province: 'MB', email: 'office@alpha.example' }, materialRequests: { sendAt: '15:00', emailTo: 'orders@alpha.example, buyer@alpha.example' } };
const getSettings = async (token) => (await call(app, { url: '/api/v1/settings/settings', token })).body;
async function setModules(token, patch) {
  const cur = await getSettings(token);
  const r = await call(app, { method: 'PATCH', url: '/api/v1/settings/settings', token, body: { modules: nextModules(cur, patch) } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

before(async () => {
  if (skip) return;
  t = await createTestDatabase('materials');
  ({ app } = await startApp(t));
  A = await ownerTenant(t, app, 'Alpha Electric');
  B = await ownerTenant(t, app, 'Bravo Electric');
  for (const [id, name, role] of [['emp-sam', 'Sam Sparks', 'electrician'], ['emp-ana', 'Ana Apprentice', 'apprentice'], ['emp-off', 'Olive Office', 'office']]) {
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/employees', token: A.token, body: { id, name, role } })).status, 201);
  }
  office = await addMember(t, app, A.tenantId, { role: 'office', employeeId: 'emp-off' });
  sam = await addMember(t, app, A.tenantId, { role: 'electrician', employeeId: 'emp-sam' });
  ana = await addMember(t, app, A.tenantId, { role: 'apprentice', employeeId: 'emp-ana' });
  keyA = await apiKey(app, A.token, ['*:write']);
  const r = await push(A.token, [
    mut({ collection: 'settings', id: 'settings', op: 'upsert', data: settingsA }),
    mut({ collection: 'jobs', id: 'job-1', op: 'upsert', data: { number: 'J-1001', title: 'Shop rewire', status: 'in-progress', address: '1 Main St' } }),
    mut({ collection: 'jobs', id: 'job-2', op: 'upsert', data: { number: 'J-1002', title: 'Brewhouse', status: 'in-progress' } }),
    mut({ collection: 'items', id: 'item-strap', op: 'upsert', data: { name: 'Two-hole strap 3/4"', unit: 'ea', costCents: 25, priceCents: 80, stock: {} } }),
    mut({ collection: 'items', id: 'item-emt', op: 'upsert', data: { name: '3/4" EMT', unit: 'stick', costCents: 1000, priceCents: 2500, stock: {} } }),
  ]);
  for (const x of r.body.results) assert.equal(x.status, 'ok', JSON.stringify(x));
  await push(B.token, [mut({ collection: 'settings', id: 'settings', op: 'upsert', data: { company: { name: 'Bravo', province: 'ON', email: 'b@bravo.example' } } })]);
});
after(async () => { await app?.close(); await t?.close(); });

describe('crew file requests; crew never see money', { skip }, () => {
  test('three requests from the field sync in (as an offline device sends them later)', async () => {
    const r = await push(sam.token, [
      mut({ collection: 'materialRequests', id: 'mr-1', op: 'upsert', data: req({ jobId: 'job-1', itemId: 'item-strap', description: 'Two-hole strap 3/4"', qty: 50, employeeId: 'emp-sam' }) }),
      mut({ collection: 'materialRequests', id: 'mr-2', op: 'upsert', data: req({ jobId: 'job-1', itemId: 'item-emt', description: '3/4" EMT', qty: 20, unit: 'sticks', urgent: true, employeeId: 'emp-sam' }) }),
      mut({ collection: 'materialRequests', id: 'mr-3', op: 'upsert', data: req({ jobId: 'job-2', description: 'PVC 1in', qty: 3, unit: 'lengths', employeeId: 'emp-sam', costCents: 999 }) }),
    ]);
    for (const x of r.body.results) assert.equal(x.status, 'ok', JSON.stringify(x));
    const stored = await t.superPool.query("SELECT data FROM material_requests WHERE tenant_id = $1 AND id = 'mr-3'", [A.tenantId]);
    assert.equal(stored.rows[0].data.costCents, undefined, 'a crew member cannot set a cost');
    assert.equal((await pushOne(ana.token, { collection: 'materialRequests', id: 'mr-4', op: 'upsert', data: req({ jobId: 'job-2', description: 'Rags', employeeId: 'emp-ana' }) })).status, 'ok');
  });

  test('crew see only their own requests, and no prices on requests or the price book', async () => {
    const mine = await call(app, { url: '/api/v1/materialRequests?limit=50', token: sam.token });
    assert.equal(mine.status, 200);
    assert.equal(mine.headers['cache-control'], 'no-store');
    assert.deepEqual(mine.body.data.map((r) => r.id).sort(), ['mr-1', 'mr-2', 'mr-3']);
    // The office prices a free-text request; the crew still never see it.
    const priced = await call(app, { method: 'PATCH', url: '/api/v1/materialRequests/mr-3', token: office.token, body: { costCents: 450 } });
    assert.equal(priced.status, 200, JSON.stringify(priced.body));
    assert.equal(priced.body.costCents, 450);
    const g = await call(app, { url: '/api/v1/materialRequests/mr-3', token: sam.token });
    assert.equal(g.body.costCents, undefined);
    const items = await call(app, { url: '/api/v1/items?limit=50', token: sam.token });
    assert.ok(items.body.data.length >= 2);
    for (const it of items.body.data) assert.ok(!('costCents' in it) && !('priceCents' in it), 'no cost or price for the crew');
    const officeItems = await call(app, { url: '/api/v1/items?limit=50', token: office.token });
    assert.ok(officeItems.body.data.every((it) => 'costCents' in it));
    // A crew edit of their own request keeps the office's cost.
    assert.equal((await call(app, { method: 'PATCH', url: '/api/v1/materialRequests/mr-3', token: sam.token, body: { note: 'grey, schedule 40' } })).status, 200);
    const stored = await t.superPool.query("SELECT data FROM material_requests WHERE tenant_id = $1 AND id = 'mr-3'", [A.tenantId]);
    assert.equal(stored.rows[0].data.costCents, 450);
    assert.equal(stored.rows[0].data.note, 'grey, schedule 40');
    const pulled = await call(app, { url: '/api/v1/sync/pull?since=0&limit=1000', token: sam.token });
    assert.ok(!JSON.stringify(pulled.body.changes.filter((c) => ['materialRequests', 'items'].includes(c.collection))).match(/costCents|priceCents/));
  });

  test('crew can withdraw their own unsent request, but not mark it ordered or touch someone else’s', async () => {
    const ordered = await call(app, { method: 'PATCH', url: '/api/v1/materialRequests/mr-1', token: sam.token, body: { status: 'ordered' } });
    assert.equal(ordered.status, 403);
    const other = await call(app, { method: 'PATCH', url: '/api/v1/materialRequests/mr-1', token: ana.token, body: { note: 'x' } });
    assert.equal(other.status, 404, 'not even visible');
    const forged = await pushOne(ana.token, { collection: 'materialRequests', id: 'mr-forged', op: 'upsert', data: req({ jobId: 'job-1', description: 'x', employeeId: 'emp-sam' }) });
    assert.equal(forged.status, 'rejected');
    assert.equal(forged.error.code, 'forbidden');
  });
});

describe('send now: one combined list to the office', { skip }, () => {
  let batchId;
  test('the schedule: 3:00 pm Winnipeg time for a Manitoba company', async () => {
    const r = await call(app, { url: '/api/v1/material-requests/schedule', token: sam.token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.body.sendAt, '15:00');
    assert.equal(r.body.timeZone, 'America/Winnipeg');
    assert.equal(r.body.pending, 3, 'the crew member counts their own waiting requests');
    const expected = nextSendAt(new Date(), { sendAt: '15:00', timeZone: 'America/Winnipeg' });
    assert.ok(Math.abs(Date.parse(r.body.nextSendAt) - expected.at.getTime()) < 120_000);
    const office = (await call(app, { url: '/api/v1/material-requests/schedule', token: A.token })).body;
    assert.equal(office.pending, 4);
    assert.equal(office.emailConfigured, true);
  });

  test('a crew member taps Send now: every waiting request goes, grouped by job', async () => {
    const r = await call(app, { method: 'POST', url: '/api/v1/material-requests/send', token: sam.token, body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.body.count, 4);
    assert.equal(r.body.jobs, 2);
    assert.equal(r.body.emailed, true);
    batchId = r.body.batchId;
    const rows = (await t.superPool.query('SELECT id, data FROM material_requests WHERE tenant_id = $1 ORDER BY id', [A.tenantId])).rows;
    assert.ok(rows.every((x) => x.data.status === 'sent' && x.data.batchId === batchId && x.data.sentAt));
    const emails = (await t.superPool.query("SELECT to_address, subject, text_body FROM email_outbox WHERE tenant_id = $1 AND template = 'material-requests' ORDER BY to_address", [A.tenantId])).rows;
    assert.deepEqual(emails.map((e) => e.to_address), ['buyer@alpha.example', 'orders@alpha.example']);
    const body = emails[0].text_body;
    assert.match(emails[0].subject, /^4 material requests for 2 jobs \(1 urgent\)/);
    assert.match(body, /J-1001 · Shop rewire \(1 Main St\)\n {2}- 20 sticks {2}3\/4" EMT {2}\(Sam Sparks · URGENT\)\n {2}- 50 ea {2}Two-hole strap 3\/4"/);
    assert.match(body, /J-1002 · Brewhouse\n {2}- 3 lengths {2}PVC 1in {2}\(Sam Sparks · "grey, schedule 40"\)/);
    assert.match(body, /Rags {2}\(Ana Apprentice\)/);
    assert.doesNotMatch(body, /\$|4\.50|450|cost|price/i, 'no money in the list');
  });

  test('the office gets it in the bell; the crew do not', async () => {
    for (const who of [office, A]) {
      const n = (await call(app, { url: '/api/v1/notifications', token: who.token })).body.data.filter((x) => x.kind === 'materials');
      assert.equal(n.length, 1);
      assert.equal(n[0].title, '4 material requests for 2 jobs (1 urgent)');
      assert.equal(n[0].link, `#/materials?batch=${batchId}`);
      assert.equal(n[0].body, 'J-1001 (2), J-1002 (2)');
    }
    assert.equal((await call(app, { url: '/api/v1/notifications', token: sam.token })).body.data.filter((x) => x.kind === 'materials').length, 0);
  });

  test('audited; a second tap sends nothing; the crew can no longer change a sent request', async () => {
    const a = await t.superPool.query("SELECT actor_type, actor_id, summary FROM audit_events WHERE tenant_id = $1 AND action = 'material_requests.send'", [A.tenantId]);
    assert.equal(a.rows.length, 1);
    assert.equal(a.rows[0].actor_type, 'user');
    assert.match(a.rows[0].summary, /Sent now: 4 material requests/);
    const again = await call(app, { method: 'POST', url: '/api/v1/material-requests/send', token: A.token, body: {} });
    assert.equal(again.body.count, 0);
    assert.equal(again.body.batchId, null);
    const late = await call(app, { method: 'PATCH', url: '/api/v1/materialRequests/mr-2', token: sam.token, body: { qty: 200 } });
    assert.equal(late.status, 403);
    const handled = await call(app, { method: 'PATCH', url: '/api/v1/materialRequests/mr-2', token: office.token, body: { status: 'ordered', orderedAt: new Date().toISOString() } });
    assert.equal(handled.status, 200);
  });
});

describe('another company', { skip }, () => {
  test('never sees, counts or sends another company’s requests', async () => {
    assert.equal((await pushOne(A.token, { collection: 'materialRequests', id: 'mr-a5', op: 'upsert', data: req({ jobId: 'job-1', description: 'Wire nuts', employeeId: 'emp-off' }) })).status, 'ok');
    const list = await call(app, { url: '/api/v1/materialRequests?limit=50', token: B.token });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.data, []);
    assert.equal((await call(app, { url: '/api/v1/materialRequests/mr-a5', token: B.token })).status, 404);
    assert.equal((await call(app, { url: '/api/v1/material-requests/schedule', token: B.token })).body.pending, 0);
    const send = await call(app, { method: 'POST', url: '/api/v1/material-requests/send', token: B.token, body: {} });
    assert.equal(send.status, 200);
    assert.equal(send.body.count, 0);
    const a5 = await t.superPool.query("SELECT data FROM material_requests WHERE tenant_id = $1 AND id = 'mr-a5'", [A.tenantId]);
    assert.equal(a5.rows[0].data.status, 'requested', 'A’s request untouched');
    // B writing into A's id space lands in B (a different row), never A's.
    assert.equal((await pushOne(B.token, { collection: 'materialRequests', id: 'mr-a5', op: 'upsert', data: req({ description: 'B own', employeeId: null }) })).status, 'ok');
    const both = await t.superPool.query("SELECT tenant_id, data->>'description' AS d FROM material_requests WHERE id = 'mr-a5' ORDER BY d", []);
    assert.deepEqual(both.rows.map((r) => [r.tenant_id === A.tenantId ? 'A' : 'B', r.d]), [['B', 'B own'], ['A', 'Wire nuts']]);
    // RLS: the app role in B's context reads none of A's batches.
    const batches = await t.db.withTenant({ tenantId: B.tenantId }, (tx) => tx.query('SELECT count(*)::int AS n FROM material_request_batches'));
    assert.equal(batches.rows[0].n, 0);
    const { rows } = await t.superPool.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('material_requests', 'material_request_batches')");
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.relrowsecurity && r.relforcerowsecurity));
  });
});

describe('the daily send', { skip }, () => {
  test('queued once per company at its local send time', async () => {
    const now = new Date();
    const r1 = await scheduleMaterialRequestSends(t.db, now);
    const r2 = await scheduleMaterialRequestSends(t.db, now);
    assert.ok(r1.queued >= 2);
    assert.equal(r2.queued, 0, 'deduplicated');
    const jobs = (await t.superPool.query('SELECT tenant_id, run_at, payload FROM jobs_queue WHERE kind = $1', [SEND_KIND])).rows;
    const a = jobs.find((j) => j.tenant_id === A.tenantId);
    const b = jobs.find((j) => j.tenant_id === B.tenantId);
    assert.equal(a.run_at.toISOString(), nextSendAt(now, { sendAt: '15:00', timeZone: 'America/Winnipeg' }).at.toISOString());
    assert.equal(b.run_at.toISOString(), nextSendAt(now, { sendAt: '15:00', timeZone: 'America/Toronto' }).at.toISOString(), 'Ontario runs an hour earlier');
    assert.equal(a.payload.timeZone, 'America/Winnipeg');
  });

  test('runs once per local day however often the job runs, and stands down when the time changed', async () => {
    const day = '2031-05-05';
    const payload = { tenantId: A.tenantId, day, sendAt: '15:00', timeZone: 'America/Winnipeg' };
    const first = await runScheduledSend(t.db, payload, { now: new Date('2031-05-05T20:00:00Z') });
    assert.equal(first.count, 1, 'the waiting request goes');
    const second = await runScheduledSend(t.db, payload, { now: new Date('2031-05-05T20:00:05Z') });
    assert.equal(second.skipped, 'already sent today');
    const stale = await runScheduledSend(t.db, { ...payload, day: '2031-05-06', sendAt: '12:00' }, { now: new Date() });
    assert.equal(stale.skipped, 'send time changed');
    const batches = (await t.superPool.query("SELECT kind, local_date::text AS d, request_count, emailed, time_zone FROM material_request_batches WHERE tenant_id = $1 AND kind = 'scheduled'", [A.tenantId])).rows;
    assert.deepEqual(batches, [{ kind: 'scheduled', d: day, request_count: 1, emailed: true, time_zone: 'America/Winnipeg' }]);
    const audit = await t.superPool.query("SELECT actor_type FROM audit_events WHERE tenant_id = $1 AND action = 'material_requests.send' AND summary LIKE 'Daily send%'", [A.tenantId]);
    assert.deepEqual(audit.rows.map((r) => r.actor_type), ['system']);
  });
});

describe('module switches', { skip }, () => {
  test('invoicing off: writes refused with module_turned_off, reads still work, and it comes back', async () => {
    const inv = { number: 'INV-1', jobId: 'job-1', status: 'draft', lines: [{ description: 'x', qty: 1, unitCents: 100, kind: 'other' }] };
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/invoices', token: A.token, body: { ...inv, id: 'inv-1' } })).status, 201);
    await setModules(A.token, { invoices: false, inventory: false });
    const r = await call(app, { method: 'POST', url: '/api/v1/invoices', token: A.token, body: { ...inv, id: 'inv-2' } });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'module_turned_off');
    assert.equal(r.body.error.details.module, 'invoices');
    assert.match(r.body.error.message, /Invoices is turned off.*Settings → Modules/);
    const s = await pushOne(office.token, { collection: 'payments', id: 'pay-1', op: 'upsert', data: { invoiceId: 'inv-1', amountCents: 100 } });
    assert.equal(s.status, 'rejected');
    assert.equal(s.error.code, 'module_turned_off');
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/stockMoves', token: keyA, body: { itemId: 'item-emt', qty: 1 } })).body.error.code, 'module_turned_off', 'API keys too');
    // Reads never hide data.
    const list = await call(app, { url: '/api/v1/invoices', token: A.token });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.data.map((x) => x.id), ['inv-1']);
    assert.equal((await call(app, { url: '/api/v1/invoices/inv-1', token: office.token })).status, 200);
    // The price book stays writable while it is on.
    assert.equal((await call(app, { method: 'PATCH', url: '/api/v1/items/item-emt', token: office.token, body: { costCents: 1100 } })).status, 200);
    // One push that turns invoicing back on and writes an invoice: the second write sees the switch.
    const cur = await getSettings(A.token);
    const both = await push(A.token, [
      mut({ collection: 'settings', id: 'settings', op: 'upsert', baseVersion: cur.version, data: { ...cur, modules: nextModules(cur, { invoices: true, inventory: true }), updatedAt: new Date().toISOString() } }),
      mut({ collection: 'invoices', id: 'inv-2', op: 'upsert', data: { ...inv, number: 'INV-2' } }),
    ]);
    assert.deepEqual(both.body.results.map((x) => x.status), ['ok', 'ok'], JSON.stringify(both.body.results));
  });

  test('only owners and admins change the switches', async () => {
    const cur = await getSettings(office.token);
    const r = await call(app, { method: 'PATCH', url: '/api/v1/settings/settings', token: office.token, body: { modules: nextModules(cur, { estimates: false }) } });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'forbidden');
  });

  test('material requests off: no new requests, no sending, no daily job; the list stays readable', async () => {
    await setModules(A.token, { materials: false });
    const w = await pushOne(sam.token, { collection: 'materialRequests', id: 'mr-off', op: 'upsert', data: req({ jobId: 'job-1', description: 'x', employeeId: 'emp-sam' }) });
    assert.equal(w.error?.code, 'module_turned_off');
    const send = await call(app, { method: 'POST', url: '/api/v1/material-requests/send', token: A.token, body: {} });
    assert.equal(send.status, 403);
    assert.equal(send.body.error.code, 'module_turned_off');
    const run = await runScheduledSend(t.db, { tenantId: A.tenantId, day: '2031-06-01', sendAt: '15:00', timeZone: 'America/Winnipeg' });
    assert.equal(run.skipped, 'module turned off');
    await t.superPool.query('DELETE FROM jobs_queue WHERE kind = $1', [SEND_KIND]);
    await scheduleMaterialRequestSends(t.db);
    const queued = (await t.superPool.query('SELECT tenant_id FROM jobs_queue WHERE kind = $1', [SEND_KIND])).rows.map((r) => r.tenant_id);
    assert.ok(!queued.includes(A.tenantId) && queued.includes(B.tenantId));
    assert.ok((await call(app, { url: '/api/v1/materialRequests', token: A.token })).body.data.length >= 5);
    await setModules(A.token, { materials: true });
    assert.equal((await pushOne(sam.token, { collection: 'materialRequests', id: 'mr-on', op: 'upsert', data: req({ jobId: 'job-1', description: 'x', employeeId: 'emp-sam' }) })).status, 'ok');
  });

  test('AI assistant off: no new conversations', async () => {
    await setModules(A.token, { assistant: false });
    const r = await call(app, { method: 'POST', url: '/api/v1/ai/conversations', token: A.token, body: { mode: 'assistant' } });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'module_turned_off');
    // B's switches are its own.
    const b = await call(app, { method: 'POST', url: '/api/v1/ai/conversations', token: B.token, body: { mode: 'assistant' } });
    assert.notEqual(b.body?.error?.code, 'module_turned_off');
  });
});
