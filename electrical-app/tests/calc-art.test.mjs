// Calculator hub pictures and ordering: every calculator has a line-art picture drawn in the shared
// style (one viewBox, one stroke width, currentColor + one accent, CSP-safe markup), and the hub puts
// the person's most-used calculators first while a fresh install keeps the designed sections.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ART, ART_VIEWBOX, ART_STROKE, artMarkup, hasArt } from '../js/lib/calc-art.js';
import { CALC_TABS, CALC_GROUPS, orderGroups } from '../js/modules/calcs.js';
import { noteUse, rankByUse, topUsed } from '../js/lib/usage-rank.js';

const ids = CALC_TABS.map((t) => t.id);
const memStorage = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

test('the hub sections list every calculator exactly once', () => {
  const inGroups = CALC_GROUPS.flatMap((g) => g.items.map(([id]) => id));
  assert.deepEqual([...inGroups].sort(), [...ids].sort());
  assert.equal(new Set(inGroups).size, inGroups.length);
  for (const g of CALC_GROUPS) for (const [id, desc] of g.items) assert.ok(desc && desc.length > 8, `${id} has a description for its tooltip / accessible name`);
});

test('every calculator has a picture, and there are no pictures without a calculator', () => {
  for (const id of ids) assert.ok(hasArt(id), `no picture for calculator "${id}"`);
  assert.equal(hasArt('nope'), false);
  assert.equal(artMarkup('nope'), '');
  // the set is reusable app-wide, but today it is the calculator set: nothing orphaned
  for (const id of Object.keys(ART)) assert.ok(ids.includes(id), `picture "${id}" has no calculator`);
});

test('the pictures named in the brief show the real thing', () => {
  assert.match(ART.expansion.alt, /expansion fitting/i);
  assert.match(ART.transformer.alt, /transformer/i);
  assert.match(ART.vd.alt, /meter on a wire/i);
  assert.match(ART.conduit.alt, /conduit.*conductors/i);
  assert.match(ART.box.alt, /device box.*wires/i);
  const alts = Object.values(ART).map((a) => a.alt);
  assert.equal(new Set(alts).size, alts.length, 'every picture has its own description');
});

test('every picture uses the shared style: one viewBox, one stroke width, currentColor + one accent', () => {
  for (const [id, { svg }] of Object.entries(ART)) {
    assert.ok(svg.length > 40, `${id} draws something`);
    // CSP: no style attributes, handlers, scripts or foreign content; no text (fonts vary by device)
    assert.doesNotMatch(svg, /\sstyle\s*=|\son[a-z]+\s*=|<script|<foreignObject|<text|<image|href=/i, `${id} markup`);
    // the stroke width is set once on the <svg>; pictures never override it
    assert.doesNotMatch(svg, /stroke-width/, `${id} overrides the stroke width`);
    // colour only from currentColor and the accent classes: no hex, rgb() or named paint
    for (const m of svg.matchAll(/\b(fill|stroke)="([^"]*)"/g)) {
      assert.ok(['currentColor', 'none'].includes(m[2]), `${id}: ${m[1]}="${m[2]}" (use currentColor or the accent class)`);
    }
    assert.doesNotMatch(svg, /#[0-9a-f]{3,8}\b|rgba?\(/i, `${id} hard-codes a colour`);
    for (const m of svg.matchAll(/class="([^"]*)"/g)) assert.ok(['a', 'af'].includes(m[1]), `${id}: unknown class "${m[1]}"`);
    assert.match(svg, /class="af?"/, `${id} uses the accent`);
    // drawn inside the 64 x 64 frame
    for (const m of svg.matchAll(/\b(x|y|cx|cy|width|height)="(-?[\d.]+)"/g)) {
      const v = Number(m[2]);
      assert.ok(v >= 0 && v <= 64, `${id}: ${m[1]}=${v} is outside the 64 x 64 frame`);
    }
    for (const m of svg.matchAll(/\sd="([^"]*)"/g)) assert.match(m[1], /^[MmLlHhVvCcSsQqTtAaZz\d\s.,-]+$/, `${id}: path data`);
  }
  const full = artMarkup('expansion', { size: 56 });
  assert.match(full, new RegExp(`viewBox="${ART_VIEWBOX}"`));
  assert.match(full, new RegExp(`stroke-width="${ART_STROKE}"`));
  assert.match(full, /stroke="currentColor"/);
  assert.match(full, /width="56" height="56"/);
  assert.match(full, /aria-hidden="true"/);
});

test('with no usage the hub is exactly the designed sections', () => {
  const opts = { storage: memStorage(), uid: 'u1' };
  const ranked = rankByUse('calcs', CALC_GROUPS.flatMap((g) => g.items.map(([id]) => id)), (id) => id, opts);
  assert.deepEqual(orderGroups(CALC_GROUPS, ranked), CALC_GROUPS.map((g) => ({ ...g, items: [...g.items] })));
  assert.deepEqual(topUsed('calcs', 4, opts), []);
});

test('the most-used calculators come first: their section rises and they lead it', () => {
  const opts = { storage: memStorage(), uid: 'u1', now: Date.UTC(2026, 10, 25) };
  const all = CALC_GROUPS.flatMap((g) => g.items.map(([id]) => id));
  for (let i = 0; i < 3; i++) noteUse('calcs', 'transformer', opts);
  noteUse('calcs', 'expansion', opts); noteUse('calcs', 'expansion', opts);
  noteUse('calcs', 'ground', opts);
  const ordered = orderGroups(CALC_GROUPS, rankByUse('calcs', all, (id) => id, opts));
  assert.deepEqual(ordered.map((g) => g.title), ['Loads & motors', 'Raceway & cable', 'Protection & testing', 'Conductors & circuits', 'Solar, storage & backup']);
  assert.deepEqual(ordered[0].items.map(([id]) => id), ['transformer', 'load', 'motor', 'potlight']);
  assert.deepEqual(ordered[1].items.map(([id]) => id), ['expansion', 'conduit', 'box', 'cablepull', 'ductbank', 'burial']);
  assert.deepEqual(ordered[2].items[0][0], 'ground');
  // untouched sections keep their designed order
  assert.deepEqual(ordered[3].items.map(([id]) => id), ['vd', 'wire', 'ohms', '3ph']);
  // every calculator is still there exactly once
  assert.deepEqual(ordered.flatMap((g) => g.items.map(([id]) => id)).sort(), [...all].sort());
  assert.deepEqual(topUsed('calcs', 4, opts), ['transformer', 'expansion', 'ground']);
  // the input is not mutated
  assert.equal(CALC_GROUPS[0].title, 'Conductors & circuits');
  assert.equal(CALC_GROUPS[2].items[0][0], 'load');
});
