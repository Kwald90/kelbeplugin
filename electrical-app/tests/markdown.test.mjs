// Run: node --test electrical-app/tests/*.test.mjs
// The setup-guide renderer (js/lib/markdown.js) must never let HTML or script through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { renderMarkdown, safeUrl } from '../js/lib/markdown.js';

const ORIGIN = 'https://app.fishtape.test';
const md = (s, vars) => renderMarkdown(s, { origin: ORIGIN, base: `${ORIGIN}/guides/stripe.md`, vars });

const TAGS = new Set(['h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'pre', 'code', 'strong', 'em', 'a', 'img', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div']);
const ATTRS = new Set(['href', 'rel', 'target', 'src', 'alt', 'loading', 'start', 'id', 'class']);

/** Every tag is on the allow list, every attribute is too, and no URL is script. */
function assertSafe(html, label) {
  for (const [, close, name, attrs] of html.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g)) {
    assert.ok(TAGS.has(name.toLowerCase()), `${label}: tag <${name}> in ${html}`);
    if (close) { assert.equal(attrs.trim(), '', label); continue; }
    for (const [, attr, value] of attrs.matchAll(/\s([^\s=]+)(?:="([^"]*)")?/g)) {
      assert.ok(ATTRS.has(attr.toLowerCase()), `${label}: attribute ${attr} in ${html}`);
      if (attr === 'href' || attr === 'src') assert.ok(!/^\s*(javascript|data|vbscript|file):/i.test(value.replace(/&[a-z#0-9]+;/gi, '')), `${label}: ${attr}=${value}`);
      if (attr === 'src') assert.ok(value.startsWith(`${ORIGIN}/`), `${label}: off-origin image ${value}`);
      if (attr === 'class') assert.equal(value, 'md-table', label);
    }
  }
  assert.ok(!/<script|<iframe|<svg|<style|<object|<embed|<form|<input|<math/i.test(html), `${label}: ${html}`);
}

const PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<a href="javascript:alert(1)">x</a>',
  '[click](javascript:alert(1))',
  '[click](JaVaScRiPt:alert(1))',
  '[click](java\tscript:alert(1))',
  '[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '[click](vbscript:msgbox(1))',
  '[click](file:///etc/passwd)',
  '[x](https://ok.test/"onmouseover="alert(1))',
  '[x" onclick="alert(1)](https://ok.test)',
  '![x](https://evil.test/track.png)',
  '![x](//evil.test/track.png)',
  '![x](data:image/svg+xml,<svg onload=alert(1)>)',
  '![x" onerror="alert(1)](/icons/icon.svg)',
  '![x](javascript:alert(1))',
  '**<b onmouseover=alert(1)>bold</b>**',
  '`<script>alert(1)</script>`',
  '```\n</code></pre><script>alert(1)</script>\n```',
  '# <svg onload=alert(1)>',
  '> <iframe src="https://evil.test"></iframe>',
  '- <style>body{display:none}</style>\n- [ok](https://ok.test)',
  '| a | <script>x</script> |\n|---|---|\n| <img src=x onerror=1> | [y](javascript:1) |',
  '<https://ok.test/"><script>alert(1)</script>>',
  '<javascript:alert(1)>',
  '[a](#/integrations"onmouseover="x)',
  '_<i onclick=x>i</i>_ and *<em onclick=x>*',
  '{{webhook_url}}',
  '&lt;script&gt; &amp; <!-- comment --> <![CDATA[x]]>',
];

test('XSS payloads come out as text, never as markup', () => {
  for (const p of PAYLOADS) assertSafe(md(p), p);
  assert.match(md('<script>alert(1)</script>'), /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.ok(!md('[click](javascript:alert(1))').includes('href'));
  assert.ok(!md('![x](https://evil.test/track.png)').includes('<img'));
  assert.equal(md('{{webhook_url}}', { webhook_url: '"><script>alert(1)</script>' }), '<p>{{webhook_url}}</p>', 'placeholder values with markup are not filled in');
});

test('the Markdown the guides use renders', () => {
  const html = md([
    '# Stripe setup', '', 'Intro with **bold**, *italic*, `code` and a [link](https://dashboard.stripe.com).', '',
    '1. First step', '   continued here', '2. Second step', '   - nested point', '', '- a', '- b', '',
    '> **Ask us to set this up.** [Email us](mailto:setup@fishtapehq.com?subject=Stripe)', '',
    '| Fee | Amount |', '| --- | ---: |', '| Cards | 2.9% + 30¢ |', '', '---', '',
    '![Screenshot](images/stripe-keys.png)', '', 'Webhook: `{{webhook_url}}`', '', '[Back to Integrations](#/integrations)',
  ].join('\n'), { webhook_url: `${ORIGIN}/api/v1/webhooks/stripe/0b8c6f6e-0000-4000-8000-000000000001` });
  assertSafe(html, 'guide');
  assert.match(html, /<h2 id="stripe-setup">Stripe setup<\/h2>/);
  assert.match(html, /<strong>bold<\/strong>, <em>italic<\/em>, <code>code<\/code>/);
  assert.match(html, /<a href="https:\/\/dashboard\.stripe\.com\/" rel="noopener noreferrer" target="_blank">link<\/a>/);
  assert.match(html, /<ol><li>First step continued here<\/li><li>Second step<ul><li>nested point<\/li><\/ul><\/li><\/ol>/);
  assert.match(html, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(html, /<blockquote><p><strong>Ask us to set this up\.<\/strong> <a href="mailto:setup@fishtapehq\.com\?subject=Stripe" rel="noopener noreferrer" target="_blank">Email us<\/a><\/p><\/blockquote>/);
  assert.match(html, /<th>Fee<\/th><th>Amount<\/th>.*<td>Cards<\/td><td>2\.9% \+ 30¢<\/td>/s);
  assert.match(html, /<img src="https:\/\/app\.fishtape\.test\/guides\/images\/stripe-keys\.png" alt="Screenshot" loading="lazy">/);
  assert.match(html, /<code>https:\/\/app\.fishtape\.test\/api\/v1\/webhooks\/stripe\/0b8c6f6e-0000-4000-8000-000000000001<\/code>/);
  assert.match(html, /<a href="#\/integrations" rel="noopener noreferrer">Back to Integrations<\/a>/);
  assert.match(md('3. three\n4. four'), /<ol start="3">/);
});

test('URL rules', () => {
  const ctx = { origin: ORIGIN, base: `${ORIGIN}/guides/x.md` };
  assert.equal(safeUrl('https://stripe.com', ctx), 'https://stripe.com/');
  assert.equal(safeUrl('mailto:a@b.test', ctx), 'mailto:a@b.test');
  assert.equal(safeUrl('javascript:alert(1)', ctx), null);
  assert.equal(safeUrl(' javascript:alert(1)', ctx), null);
  assert.equal(safeUrl('img.png', ctx, { image: true }), `${ORIGIN}/guides/img.png`);
  assert.equal(safeUrl('https://cdn.test/img.png', ctx, { image: true }), null);
  assert.equal(safeUrl('#/integrations', ctx, { image: true }), null);
});

test('every guide renders safely and has the parts a guide needs', () => {
  const dir = new URL('../guides/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  for (const p of ['stripe', 'resend', 'twilio', 'facebook', 'anthropic']) assert.ok(files.includes(`${p}.md`), `guides/${p}.md`);
  for (const f of files) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    const html = md(src, { webhook_url: `${ORIGIN}/api/v1/webhooks/x/y` });
    assertSafe(html, f);
    assert.match(src, /Ask us to set this up/i, `${f} offers the set-up service`);
    assert.match(src, /cost/i, `${f} says what it costs`);
    assert.match(src, /checked \d{4}-\d{2}-\d{2}/i, `${f} dates its prices`);
  }
});
