// Sending a document checks the tax exemption (docs/releases/r1-get-paid.md 2.9, 3.2): the
// email-document and pay-link routes refuse a Manitoba invoice that leaves RST off without the
// customer's exemption evidence (422 exemption_required), and send it once the evidence is on the
// invoice. Estimates, BC and SK only warn in the PWA, so the server sends them. Stripe is faked.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { skip, createTestDatabase } from './support/db.js';
import { call, ownerTenant, startApp, addMember } from './support/app.js';
import { setFetch } from '../src/integrations/http.js';
import { taxComponents } from '../../electrical-app/js/lib/tax.js';

const hex = (n) => randomBytes(n).toString('hex');
const net = {
  calls: [], unexpected: [],
  async fetch(url, init = {}) {
    const u = String(url);
    net.calls.push(u);
    if ((init.method || 'GET') === 'POST' && /api\.stripe\.com\/v1\/checkout\/sessions$/.test(u)) {
      return new Response(JSON.stringify({ id: `cs_test_${hex(4)}`, url: 'https://checkout.stripe.com/c/pay/cs_test_x', expires_at: 1900000000 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    net.unexpected.push(u);
    throw new Error('no network in tests');
  },
};

let t, app, A, office;
const DAY = '2026-10-20';
const taxes = (province, treatment) => taxComponents({ province, treatment, date: DAY });

before(async () => {
  if (skip) return;
  setFetch((u, i) => net.fetch(u, i));
  t = await createTestDatabase('exemption_send');
  ({ app } = await startApp(t));
  A = await ownerTenant(t, app, 'TG Electrical');
  await t.superPool.query("UPDATE tenants SET plan = 'pro' WHERE id = $1", [A.tenantId]);
  office = await addMember(t, app, A.tenantId, { role: 'office' });
  const s = await call(app, { method: 'POST', url: '/api/v1/settings', token: A.token, body: { id: 'settings', currency: 'CAD', company: { name: 'TG Electrical', province: 'MB', phone: '204-555-0100', email: 'office@tg.test', address: '1 Main St, Winnipeg' } } });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const stripe = await call(app, { method: 'PUT', url: '/api/v1/integrations/stripe', token: A.token, body: { secrets: { 'stripe.secret_key': `sk_test_${hex(12)}`, 'stripe.webhook_secret': `whsec_${hex(16)}` } } });
  assert.equal(stripe.status, 200, JSON.stringify(stripe.body));
  const resend = await call(app, { method: 'PUT', url: '/api/v1/integrations/resend', token: A.token, body: { secrets: { 'resend.api_key': `re_${hex(12)}`, 'resend.from': 'TG Electrical <office@tg.test>' } } });
  assert.equal(resend.status, 200, JSON.stringify(resend.body));
  const c = await call(app, { method: 'POST', url: '/api/v1/clients', token: A.token, body: { id: 'gc-1', name: 'Prairie Builders (GC)', email: 'ap@prairie.example', type: 'commercial' } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
});
after(async () => { setFetch(null); await app?.close(); await t?.close(); });

async function invoice(id, { province = 'MB', treatment = 'gst-only', extra = {} } = {}) {
  const tx = taxes(province, treatment);
  const r = await call(app, { method: 'POST', url: '/api/v1/invoices', token: A.token, body: {
    id, number: `INV-${id}`, clientId: 'gc-1', status: 'draft', issueDate: DAY, dueDate: '2026-11-03',
    lines: [{ description: 'Rough-in, level 2', qty: 1, unitCents: 250000, kind: 'labour' }],
    taxProvince: province, taxTreatment: treatment, taxes: tx, taxPct: tx.filter((x) => x.applies.labour).reduce((s, x) => s + x.pct, 0), ...extra,
  } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
const email = (who, collection, id) => call(app, { method: 'POST', url: '/api/v1/integrations/email/document', token: who.token, body: { collection, id } });
const payLink = (who, invoiceId) => call(app, { method: 'POST', url: '/api/v1/integrations/stripe/pay-link', token: who.token, body: { invoiceId } });
const outboxFor = async (id) => (await t.superPool.query("SELECT count(*)::int AS n FROM outbox WHERE tenant_id = $1 AND data->>'relatedId' = $2", [A.tenantId, id])).rows[0].n;

describe('sending checks the RST exemption', { skip }, () => {
  test('a Manitoba invoice with RST off and no exemption is refused by email and pay link', async () => {
    await invoice('mb-1');
    const e = await email(office, 'invoices', 'mb-1');
    assert.equal(e.status, 422, JSON.stringify(e.body));
    assert.equal(e.body.error.code, 'exemption_required');
    assert.match(e.body.error.message, /RST/);
    assert.ok(Array.isArray(e.body.error.details?.missing) && e.body.error.details.missing.length, JSON.stringify(e.body.error));
    const p = await payLink(A, 'mb-1');
    assert.equal(p.status, 422, JSON.stringify(p.body));
    assert.equal(p.body.error.code, 'exemption_required');
    assert.equal(await outboxFor('mb-1'), 0, 'nothing was queued');
    const inv = await call(app, { url: '/api/v1/invoices/mb-1', token: A.token });
    assert.equal(inv.body.status, 'draft', 'the invoice stays a draft');
    assert.equal(inv.body.payLink, undefined, 'no pay link was made');
    assert.equal(net.calls.length, 0, 'Stripe was not called');
  });

  test('a number alone is not enough for a basis that needs more evidence', async () => {
    await invoice('mb-2', { extra: { taxExemptBasis: 'pass-on', taxExemptNumber: '1234567' } });
    const e = await email(office, 'invoices', 'mb-2');
    assert.equal(e.status, 422, 'a GC passing on an exemption also names the end customer');
    assert.ok(e.body.error.details.missing.some((m) => /endCustomer/.test(m)), JSON.stringify(e.body.error.details));
    assert.ok(!e.body.error.details.missing.some((m) => /number/.test(m)), 'the number is there');
    const fixed = await call(app, { method: 'PATCH', url: '/api/v1/invoices/mb-2', token: A.token, body: { taxExemptDetails: { endCustomer: 'Public Services and Procurement Canada' } } });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
    assert.equal((await email(office, 'invoices', 'mb-2')).status, 201);
  });

  test('with the exemption on the invoice it sends, by email and with a pay link', async () => {
    const patch = await call(app, { method: 'PATCH', url: '/api/v1/invoices/mb-1', token: A.token, body: { taxExemptBasis: 'subtrade', taxExemptNumber: '1234567', exemptionConfirmed: { by: 'Office', at: `${DAY}T15:00:00Z` } } });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));
    const e = await email(office, 'invoices', 'mb-1');
    assert.equal(e.status, 201, JSON.stringify(e.body));
    assert.equal(e.body.outbox.kind, 'invoice');
    assert.equal((await call(app, { url: '/api/v1/invoices/mb-1', token: A.token })).body.status, 'sent');
    const p = await payLink(A, 'mb-1');
    assert.equal(p.status, 201, JSON.stringify(p.body));
    assert.equal(p.body.amountCents, 262500, 'labour $2,500 + GST 5%, no RST');
    assert.deepEqual(net.unexpected, []);
  });

  test('RST charged, estimates, other provinces and credit notes are not refused', async () => {
    await invoice('mb-rst', { treatment: 'pst-all' });
    assert.equal((await email(office, 'invoices', 'mb-rst')).status, 201, 'RST is charged: nothing to prove');
    // BC and SK only warn (in the PWA).
    await invoice('bc-1', { province: 'BC' });
    assert.equal((await email(office, 'invoices', 'bc-1')).status, 201);
    await invoice('sk-1', { province: 'SK' });
    assert.equal((await payLink(A, 'sk-1')).status, 201);
    // A Manitoba estimate only warns.
    const tx = taxes('MB', 'gst-only');
    const est = await call(app, { method: 'POST', url: '/api/v1/estimates', token: A.token, body: {
      id: 'est-mb', number: 'E-2001', clientId: 'gc-1', status: 'draft', issueDate: DAY, validUntil: '2026-11-20',
      lines: [{ description: 'Service upgrade', qty: 1, unitCents: 100000, kind: 'labour' }], taxProvince: 'MB', taxTreatment: 'gst-only', taxes: tx, taxPct: 5,
    } });
    assert.equal(est.status, 201, JSON.stringify(est.body));
    assert.equal((await email(office, 'estimates', 'est-mb')).status, 201);
    // A credit note follows its original invoice; an interest invoice is exempt by nature.
    await invoice('cr-1', { extra: { kind: 'credit', creditsInvoiceId: 'mb-1', creditReason: 'price', lines: [{ description: 'Price adjustment', qty: 1, unitCents: -10000, kind: 'labour' }] } });
    assert.equal((await email(office, 'invoices', 'cr-1')).status, 201);
    // "No tax" for an out-of-scope supply is not an exemption either.
    await invoice('mb-none', { treatment: 'none', extra: { taxNoneReason: 'out_of_scope' } });
    assert.equal((await email(office, 'invoices', 'mb-none')).status, 201);
  });

  test('"No tax" for First Nations relief needs the registry number and band or reserve', async () => {
    await invoice('mb-fn', { treatment: 'none', extra: { taxNoneReason: 'relief', taxExemptBasis: 'first-nations', taxExemptDetails: { registryNo: '1234567890' } } });
    const e = await email(office, 'invoices', 'mb-fn');
    assert.equal(e.status, 422);
    assert.ok(e.body.error.details.missing.some((m) => /band|reserve/.test(m)), JSON.stringify(e.body.error.details));
    await call(app, { method: 'PATCH', url: '/api/v1/invoices/mb-fn', token: A.token, body: { taxExemptDetails: { registryNo: '1234567890', reserve: 'Peguis 1B' } } });
    assert.equal((await email(office, 'invoices', 'mb-fn')).status, 201);
  });
});
