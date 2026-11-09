// Online booking front door: the pure helpers (lead shape, public config, slug rules, embed page)
// and the public/authenticated routes end to end against a real database.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  SERVICE_TYPE_IDS, URGENCY_IDS, slugProblem, buildServiceLead, publicBookingConfig, renderBookingPage,
} from '../src/services/booking.js';
import { SERVICE_TYPES as PWA_TYPES, URGENCY as PWA_URGENCY } from '../../electrical-app/js/lib/service-requests.js';
import { skip, createTestDatabase } from './support/db.js';
import { startApp, call, ownerTenant } from './support/app.js';

// ---- pure helpers (no database) -------------------------------------------------------------

test('service-type and urgency ids match the PWA (lib/service-requests.js)', () => {
  assert.deepEqual(SERVICE_TYPE_IDS, PWA_TYPES.map((t) => t.id));
  assert.deepEqual(URGENCY_IDS, PWA_URGENCY.map((u) => u.id));
});

test('buildServiceLead makes a safe kind:service lead and nothing else', () => {
  const lead = buildServiceLead({ contactName: '  Jane  ', phone: '204-555-0100', serviceType: 'panel', urgency: 'urgent', description: 'x'.repeat(30000) });
  assert.equal(lead.kind, 'service');
  assert.equal(lead.stage, 'new');
  assert.equal(lead.contactName, 'Jane');
  assert.equal(lead.serviceType, 'panel');
  assert.equal(lead.notes.length, 20000); // capped
  assert.match(lead.title, /Panel or service upgrade — Jane/);
  // Unknown type / blank urgency fall back; no arbitrary fields ride along.
  const junk = buildServiceLead({ contactName: 'x', serviceType: 'hack', urgency: '', evil: 'DROP' });
  assert.equal(junk.serviceType, 'other');
  assert.equal(junk.urgency, 'flexible');
  assert.equal(junk.evil, undefined);
});

test('publicBookingConfig only exposes offered types and defaults fields on', () => {
  const c = publicBookingConfig({ company: { name: 'Acme', phone: '555' }, booking: { serviceTypes: ['ev', 'panel'], fields: { address: false }, confirmation: '' } });
  assert.deepEqual(c.serviceTypes.map((t) => t.id), ['panel', 'ev']); // canonical order
  assert.equal(c.fields.address, false);
  assert.equal(c.fields.email, true);
  assert.equal(c.businessName, 'Acme');
  assert.ok(c.confirmation.length > 0); // blank falls back
  const empty = publicBookingConfig({});
  assert.equal(empty.serviceTypes.length, PWA_TYPES.length); // all types when none chosen
});

test('slugProblem enforces 2-63 lower-case chars', () => {
  assert.equal(slugProblem('acme-electric'), null);
  assert.ok(slugProblem('a')); // too short
  assert.ok(slugProblem('Acme')); // upper-case
  assert.ok(slugProblem('')); // empty
});

test('renderBookingPage embeds the slug and nonce, no inline handlers', () => {
  const html = renderBookingPage({ slug: 'acme', nonce: 'NONCE123' });
  assert.match(html, /<style nonce="NONCE123">/);
  assert.match(html, /<script nonce="NONCE123">/);
  assert.match(html, /"acme"/); // the slug is embedded for the page's fetch
  assert.match(html, /book\//);
  assert.doesNotMatch(html, /\son\w+=/i); // no inline event handlers
});

// ---- routes (real database) -----------------------------------------------------------------

describe('booking routes', { skip }, () => {
  let t, app, owner;
  before(async () => {
    t = await createTestDatabase('booking');
    ({ app } = await startApp(t));
    owner = await ownerTenant(t, app, 'Acme Electric');
  });
  after(async () => { await app?.close(); await t?.close(); });

  const leadCount = async () => (await t.superPool.query("SELECT count(*)::int AS n FROM leads WHERE tenant_id = $1 AND data->>'kind' = 'service'", [owner.tenantId])).rows[0].n;

  test('an unknown slug is a generic 404 on config and POST', async () => {
    const c = await call(app, { url: '/api/v1/public/book/nobody-here/config' });
    assert.equal(c.status, 404);
    const p = await call(app, { method: 'POST', url: '/api/v1/public/book/nobody-here', body: { contactName: 'x', phone: '1' }, csrf: false });
    assert.equal(p.status, 404);
  });

  test('owner claims a slug (admin + feature gated), uniqueness enforced', async () => {
    const r = await call(app, { method: 'PUT', url: '/api/v1/booking', token: owner.token, body: { slug: 'acme-electric', enabled: true } });
    assert.equal(r.status, 200);
    assert.equal(r.body.page.slug, 'acme-electric');
    assert.equal(r.body.page.enabled, true);
    // A second tenant cannot take the same slug.
    const other = await ownerTenant(t, app, 'Beta Electric');
    const taken = await call(app, { method: 'PUT', url: '/api/v1/booking', token: other.token, body: { slug: 'acme-electric', enabled: true } });
    assert.equal(taken.status, 409);
    assert.equal(taken.body.error.code, 'slug_taken');
  });

  test('an unauthenticated request cannot claim a slug', async () => {
    // With the X-Fishtape header (default) auth runs and rejects (401); without it CSRF rejects (403).
    const r = await call(app, { method: 'PUT', url: '/api/v1/booking', body: { slug: 'anon-shop' } });
    assert.equal(r.status, 401);
    const noCsrf = await call(app, { method: 'PUT', url: '/api/v1/booking', body: { slug: 'anon-shop' }, csrf: false });
    assert.equal(noCsrf.status, 403);
  });

  test('public config returns the shop\'s offered form', async () => {
    const c = await call(app, { url: '/api/v1/public/book/acme-electric/config' });
    assert.equal(c.status, 200);
    assert.ok(Array.isArray(c.body.serviceTypes) && c.body.serviceTypes.length);
    assert.ok(c.body.confirmation);
  });

  test('a valid submission creates exactly one service lead', async () => {
    const before = await leadCount();
    const r = await call(app, {
      method: 'POST', url: '/api/v1/public/book/acme-electric', csrf: false,
      body: { contactName: 'Jane Doe', phone: '204-555-0100', serviceType: 'panel', urgency: 'urgent', description: 'Upgrade to 200A' },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.ok, true);
    assert.equal(await leadCount(), before + 1);
    const { rows } = await t.superPool.query("SELECT data FROM leads WHERE tenant_id = $1 AND data->>'kind' = 'service' ORDER BY created_at DESC LIMIT 1", [owner.tenantId]);
    assert.equal(rows[0].data.stage, 'new');
    assert.equal(rows[0].data.serviceType, 'panel');
    assert.equal(rows[0].data.contactName, 'Jane Doe');
  });

  test('the honeypot looks accepted but stores nothing', async () => {
    const before = await leadCount();
    const r = await call(app, {
      method: 'POST', url: '/api/v1/public/book/acme-electric', csrf: false,
      body: { contactName: 'Bot', phone: '1', website: 'http://spam.example' },
    });
    assert.equal(r.status, 201);
    assert.equal(await leadCount(), before); // nothing created
  });

  test('a disabled page 404s the public side', async () => {
    await call(app, { method: 'PUT', url: '/api/v1/booking', token: owner.token, body: { slug: 'acme-electric', enabled: false } });
    const c = await call(app, { url: '/api/v1/public/book/acme-electric/config' });
    assert.equal(c.status, 404);
    await call(app, { method: 'PUT', url: '/api/v1/booking', token: owner.token, body: { slug: 'acme-electric', enabled: true } });
  });

  test('the embed page is frameable: CSP frame-ancestors *, no X-Frame-Options', async () => {
    const r = await call(app, { url: '/api/v1/public/book/acme-electric/embed' });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/html/);
    assert.match(r.headers['content-security-policy'], /frame-ancestors \*/);
    assert.equal(r.headers['x-frame-options'], undefined);
  });
});
