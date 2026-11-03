// Marketing hub: the content-model normalizer, the catalog seed, co-brand and code validation.
// Pure functions, no database (the HQ/public DB helpers are covered by the embedded route tests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeContent, normalizeCobrand, validCode, defaultCatalog } from '../src/services/marketing.js';

test('normalizeContent keeps good sections, drops junk, caps and shapes by kind', () => {
  const { sections } = normalizeContent({
    sections: [
      { kind: 'cover', title: 'Hi', subtitle: 'there', extra: 'dropped' },
      { kind: 'features', heading: 'H', intro: 'I', cards: [{ title: 'A', body: 'a' }, { title: '', body: '' }] },
      { kind: 'bogus', heading: 'still a features page' },
      'not an object',
      null,
    ],
  });
  assert.equal(sections.length, 3); // cover, features, bogus->features (the string and null are dropped)
  assert.equal(sections[0].kind, 'cover');
  assert.equal(sections[0].extra, undefined); // unknown fields stripped
  assert.equal(sections[1].cards.length, 1); // the empty card is dropped
  assert.equal(sections[2].kind, 'features'); // unknown kind falls back to features
  for (const s of sections) assert.match(s.id, /^[a-z0-9]{1,24}$/); // every section gets an id
});

test('normalizeContent bounds the section and card counts', () => {
  const many = { sections: Array.from({ length: 100 }, () => ({ kind: 'features', heading: 'x', cards: Array.from({ length: 50 }, (_, i) => ({ title: `c${i}`, body: 'b' })) })) };
  const { sections } = normalizeContent(many);
  assert.ok(sections.length <= 40);
  assert.ok(sections[0].cards.length <= 16);
});

test('normalizeContent tolerates garbage input', () => {
  assert.deepEqual(normalizeContent(null), { sections: [] });
  assert.deepEqual(normalizeContent({}), { sections: [] });
  assert.deepEqual(normalizeContent({ sections: 'nope' }), { sections: [] });
});

test('normalizeCobrand validates the accent and coerces types', () => {
  assert.deepEqual(normalizeCobrand({ enabled: 1, partner: ' EECOL ', tagline: 't', accent: '#1F6FEB' }),
    { enabled: true, partner: 'EECOL', tagline: 't', accent: '#1f6feb' });
  assert.equal(normalizeCobrand({ accent: 'red' }).accent, ''); // only #rrggbb is kept
  assert.equal(normalizeCobrand({}).enabled, false);
});

test('validCode accepts link codes and rejects the rest', () => {
  assert.ok(validCode('eecol-wpg'));
  assert.ok(validCode('spring_2026'));
  assert.equal(validCode('EECOL'), false); // upper-case not allowed
  assert.equal(validCode('-leading'), false);
  assert.equal(validCode('has space'), false);
  assert.equal(validCode(''), false);
  assert.equal(validCode(null), false);
});

test('defaultCatalog is a valid, non-empty block model with a cover and a CTA', () => {
  const cat = defaultCatalog();
  assert.ok(cat.sections.length >= 10);
  assert.equal(cat.sections[0].kind, 'cover');
  assert.equal(cat.sections.at(-1).kind, 'cta');
  // Every features page is well-formed and re-normalizing is a no-op (idempotent).
  assert.deepEqual(normalizeContent(cat), cat);
});
