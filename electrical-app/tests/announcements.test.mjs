// Run: node --test electrical-app/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { safeLink, pending } from '../js/lib/announcements.js';
import { renderMarkdown } from '../js/lib/markdown.js';
import { FEATURE_PLAN } from '../js/plans.js';

test('announcement links: https and in-app routes only', () => {
  assert.deepEqual(safeLink('#/help/getting-started'), { href: '#/help/getting-started', external: false });
  assert.deepEqual(safeLink('https://fishtapehq.com/news'), { href: 'https://fishtapehq.com/news', external: true });
  for (const bad of ['javascript:alert(1)', 'http://plain.example', '//evil.example', '#/x"onmouseover=1', '', null]) assert.equal(safeLink(bad), null, String(bad));
});

test('pending banners: hidden and duplicate ids are skipped, order kept', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'a' }, null, { id: 'c' }];
  assert.deepEqual(pending(list, new Set(['b'])).map((x) => x.id), ['a', 'c']);
  assert.deepEqual(pending(undefined, new Set()), []);
});

test('help is in every plan', () => {
  assert.equal(FEATURE_PLAN.help, 'starter');
});

test('the starter help articles render with the safe renderer: no raw HTML, only in-app or https links', () => {
  const sql = readFileSync(new URL('../../server/migrations/0082_help_seed.sql', import.meta.url), 'utf8');
  const bodies = [...sql.matchAll(/\$md\$([\s\S]*?)\$md\$/g)].map((m) => m[1]).filter((b) => b.length > 500);
  assert.equal(bodies.length, 10);
  const modules = readFileSync(new URL('../js/modules/index.js', import.meta.url), 'utf8');
  for (const b of bodies) {
    const html = renderMarkdown(b, { origin: 'https://app.fishtape.test' });
    assert.ok(!/<(script|iframe|style|img)\b/i.test(html));
    for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
      assert.ok(href.startsWith('#/') || href.startsWith('https://') || href.startsWith('mailto:'), href);
      if (href.startsWith('#/')) {
        const id = href.slice(2).split(/[/?]/)[0];
        assert.ok(id === 'account' || new RegExp(`import ${id} from|import \\w+ from './${id}\\.js'`).test(modules) || ['help'].includes(id), `link to unknown screen ${href}`);
      }
    }
  }
});
