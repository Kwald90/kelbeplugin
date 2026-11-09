// Online booking config helpers (lib/booking.js): normalization, offered types, slug rules, and
// the hosted link + iframe embed snippet the shop pastes on its own website.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BOOKING, OPTIONAL_FIELDS, normalizeBooking, offeredServiceTypes,
  slugProblem, validSlug, suggestSlug, hostedLink, embedSnippet,
} from '../js/lib/booking.js';
import { SERVICE_TYPES } from '../js/lib/service-requests.js';

test('DEFAULT_BOOKING offers every service type and every intake field', () => {
  assert.deepEqual(DEFAULT_BOOKING.serviceTypes, SERVICE_TYPES.map((t) => t.id));
  for (const f of OPTIONAL_FIELDS) assert.equal(DEFAULT_BOOKING.fields[f.id], true);
  assert.ok(DEFAULT_BOOKING.confirmation.length > 0);
});

test('normalizeBooking caps strings, bounds the type list and defaults fields on', () => {
  const b = normalizeBooking({
    businessName: '  Acme Electric  ', intro: 'x'.repeat(1000),
    serviceTypes: ['panel', 'ev', 'bogus'], fields: { address: false }, confirmation: '',
  });
  assert.equal(b.businessName, 'Acme Electric');
  assert.equal(b.intro.length, 600);
  assert.deepEqual(b.serviceTypes, ['panel', 'ev']); // junk dropped
  assert.equal(b.fields.address, false); // explicitly off
  assert.equal(b.fields.email, true); // default on
  assert.equal(b.confirmation, DEFAULT_BOOKING.confirmation); // blank falls back
});

test('normalizeBooking tolerates garbage and an empty type list falls back to all', () => {
  assert.deepEqual(normalizeBooking(null).serviceTypes, SERVICE_TYPES.map((t) => t.id));
  assert.deepEqual(normalizeBooking({ serviceTypes: [] }).serviceTypes, SERVICE_TYPES.map((t) => t.id));
  assert.deepEqual(normalizeBooking({ serviceTypes: ['none-known'] }).serviceTypes, SERVICE_TYPES.map((t) => t.id));
});

test('offeredServiceTypes returns {id,label} in canonical order', () => {
  const offered = offeredServiceTypes({ serviceTypes: ['ev', 'panel'] });
  assert.deepEqual(offered.map((t) => t.id), ['panel', 'ev']); // canonical order, not input order
  assert.ok(offered.every((t) => t.id && t.label));
});

test('slug rules: 2-63 chars, lower-case, dashes', () => {
  assert.equal(slugProblem('acme-electric'), null);
  assert.ok(validSlug('ab'));
  assert.ok(!validSlug('a')); // too short
  assert.ok(!validSlug('Acme')); // upper-case
  assert.ok(!validSlug('-lead')); // leading dash
  assert.ok(!validSlug('has space'));
  assert.ok(!validSlug(''));
});

test('suggestSlug turns a company name into a valid slug', () => {
  assert.equal(suggestSlug('Acme Electric Ltd.'), 'acme-electric-ltd');
  assert.equal(suggestSlug('   Bright & Co   '), 'bright-co');
  assert.equal(suggestSlug('!'), ''); // nothing usable
});

test('hostedLink and embedSnippet point at the public embed route', () => {
  assert.equal(hostedLink('https://app.example.com/', 'acme'), 'https://app.example.com/api/v1/public/book/acme/embed');
  const snip = embedSnippet('https://app.example.com', 'acme');
  assert.match(snip, /^<iframe /);
  assert.match(snip, /src="https:\/\/app\.example\.com\/api\/v1\/public\/book\/acme\/embed"/);
  assert.match(snip, /title="Book a service call"/);
});
