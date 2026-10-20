// The public site (fishtapehq.com): clean-URL mapping, plan facts from plans.js, the status page
// helpers, and that the generated pages in site/ are up to date and follow the rules (one h1,
// canonical + Open Graph tags, no inline styles or scripts, every internal link resolves, the
// "no caps" promise on pricing, features and the home page, and no invented social proof).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as plans from '../js/plans.js';
import { FEATURE_LABELS } from '../js/modules/billing.js';
import { fileForPath, pathForFile, localHref, isMarketingHost, planLabel, plansWith, planPrice, LEAD_SERVICES } from '../../site/site-lib.js';
import { dayClass, fmtPct, fromPublicStatus, fromLegacy, parseFragment, componentNames, COMPONENTS } from '../../site/status-lib.js';
import { buildAll, fillMarker } from '../../tools/site/build.mjs';
import { missingShots } from '../../tools/site/lib.mjs';
import { FEATURES } from '../../tools/site/features.mjs';
import { provinceFacts } from '../../tools/site/landing.mjs';
import { sampleStatus } from '../../tools/site/serve.mjs';
import { LEAD_SERVICES as SERVER_SERVICES } from '../../server/src/routes/hq-leads.js';

const SITE = new URL('../../site/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

test('clean paths map to files under site/ and back', () => {
  const cases = [['/', 'index.html'], ['/pricing', 'pricing.html'], ['/about', 'about.html'], ['/status', 'status.html'], ['/features', 'features/index.html'],
    ['/features/wire-runs', 'features/wire-runs.html'], ['/for/ontario', 'for/ontario.html'], ['/for/switching-from-jobber', 'for/switching-from-jobber.html']];
  for (const [path, file] of cases) {
    assert.equal(fileForPath(path), file, path);
    assert.equal(pathForFile(file), path, file);
    assert.equal(pathForFile(`/site/${file}`), path, file);
  }
  for (const bad of ['/nope', '/features/Wire-Runs', '/features/a/b', '/features/../x', '/for/', '/api/v1/status', '/site/about.html', '/features/-x', '/features/x--y'])
    assert.equal(fileForPath(bad), null, bad);
});

test('links: clean on the marketing hosts, /site/*.html elsewhere, the apex from the status host', () => {
  assert.equal(localHref('/pricing#talk', 'fishtapehq.com'), '/pricing#talk');
  assert.equal(localHref('/pricing#talk', 'tgelectrical.truecollarbuilt.com'), '/site/pricing.html#talk');
  assert.equal(localHref('/signup?plan=pro', 'localhost'), '/site/signup.html?plan=pro');
  assert.equal(localHref('/', 'localhost'), '/site/index.html');
  assert.equal(localHref('/features/safety', 'localhost'), '/site/features/safety.html');
  assert.equal(localHref('/about', 'status.fishtapehq.com'), 'https://fishtapehq.com/about');
  assert.equal(localHref('/status', 'status.fishtapehq.com'), '/');
  for (const keep of ['/.well-known/security.txt', '/api/v1/status', 'https://app.fishtapehq.com/', '#talk', '//evil.example/x', 'mailto:x@y.z'])
    assert.equal(localHref(keep, 'localhost'), keep, keep);
  assert.ok(isMarketingHost('FishtapeHQ.com') && !isMarketingHost('app.fishtapehq.com'));
});

test('plan labels come from plans.js', () => {
  assert.equal(planLabel('calcs', plans), 'Every plan');
  assert.equal(planLabel('drawings', plans), `${plans.PLANS.pro.name} and up`);
  assert.equal(planLabel('ai.assistant', plans), `${plans.PLANS.business.name} and up`);
  assert.equal(planLabel('sso', plans), plans.PLANS.enterprise.name);
  assert.equal(planLabel('not-a-feature', plans), 'Every plan');
  assert.deepEqual(plansWith('drawings', plans), ['pro', 'business', 'enterprise'].map((id) => plans.PLANS[id].name));
  assert.equal(planPrice('enterprise', plans), 'Custom');
  assert.match(planPrice('starter', plans), /^\$\d[\d,]*(\.\d\d)?\/month$/);
  // Every feature page's plan key is a real plans.js feature (or a module every plan has).
  for (const f of FEATURES) for (const [key] of f.plans) assert.ok(key in plans.FEATURE_PLAN, `${f.slug}: ${key}`);
});

test('the services list in the site matches the API\'s lead form', () => {
  assert.deepEqual([...LEAD_SERVICES].sort(), Object.keys(SERVER_SERVICES).sort());
});

test('status page: day colours, percentages and the page model', () => {
  assert.equal(dayClass({ pct: null, checks: 0 }), '');
  assert.equal(dayClass({ pct: 100, checks: 288, outages: 0, degraded: 0 }), 'up');
  assert.equal(dayClass({ pct: 99.65, checks: 288, outages: 1, degraded: 0 }), 'minor');
  assert.equal(dayClass({ pct: 100, checks: 288, outages: 0, degraded: 2 }), 'minor');
  assert.equal(dayClass({ pct: 97.2, checks: 288, outages: 8, degraded: 0 }), 'down');
  assert.equal(fmtPct(null), 'No data');
  assert.equal(fmtPct(100), '100 %');
  assert.equal(fmtPct(99.966), '99.97 %');

  const m = fromPublicStatus(sampleStatus());
  assert.equal(m.overall, 'operational');
  assert.deepEqual(m.components.map((c) => c.id), COMPONENTS.map(([id]) => id));
  for (const c of m.components) assert.equal(c.days.length, 90, c.id);
  assert.equal(m.components.find((c) => c.id === 'payments').status, 'unknown');
  assert.equal(m.notices.upcoming.length, 1);
  assert.equal(fromPublicStatus({ overall: 'weird', components: [{ id: 'api', status: 'exploded' }] }).components.find((c) => c.id === 'api').status, 'unknown');

  const ok = fromLegacy({ status: { ok: true, body: { status: 'ok' } }, ready: { body: { status: 'ready' } } });
  assert.equal(ok.overall, 'operational');
  assert.equal(ok.components.find((c) => c.id === 'email').status, 'unknown', 'no signal for email in the old endpoints');
  assert.equal(fromLegacy({ status: null, ready: null }).overall, 'outage');
  assert.equal(fromLegacy({ status: { ok: true, body: { status: 'ok' } }, ready: { body: { status: 'not_ready' } } }).overall, 'degraded');
  assert.equal(componentNames(['api', 'signin']), 'API and sync, Sign-in');
});

test('status email links: the token is read from the fragment only, strictly', () => {
  assert.deepEqual(parseFragment('#confirm=abcdefghijklmnop_-12'), { action: 'confirm', token: 'abcdefghijklmnop_-12' });
  assert.deepEqual(parseFragment('#unsubscribe=ABCDEFGHIJKLMNOP'), { action: 'unsubscribe', token: 'ABCDEFGHIJKLMNOP' });
  for (const bad of ['', '#confirm=short', '#confirm=<script>alert(1)</script>aaaaaaa', '#delete=abcdefghijklmnopq', '?confirm=abcdefghijklmnopq']) assert.equal(parseFragment(bad), null, bad);
});

test('province facts come from the app\'s code, tax and safety data', () => {
  const on = provinceFacts('ON');
  assert.match(on.authority.name, /ESA/);
  assert.equal(on.tax, 'HST 13%');
  assert.equal(on.wcb.name, 'WSIB');
  assert.ok(on.amendments.length > 0);
  assert.equal(provinceFacts('BC').tax, 'GST 5% + PST 7%');
  assert.match(provinceFacts('BC').taxTreatment, /Real property/);
  assert.equal(provinceFacts('MB').tax, 'GST 5% + RST 7%');
  assert.equal(provinceFacts('NS').tax, 'HST 14%');
  assert.equal(provinceFacts('AB').tax, 'GST 5%');
});

test('markers: only the marked part changes', () => {
  const src = 'a\n  <!-- @site:x (note) -->\n  old\n  <!-- /@site:x -->\nb';
  assert.equal(fillMarker(src, 'x', '  new'), 'a\n  <!-- @site:x (note) -->\n  new\n  <!-- /@site:x -->\nb');
  assert.equal(fillMarker(src, 'y', 'z'), src);
});

const out = buildAll();
const pages = out.filter((o) => o.file.endsWith('.html'));

test('the generated site is up to date (run node tools/site/build.mjs)', () => {
  assert.deepEqual([...missingShots], [], 'every screenshot the pages use exists in site/img/shots/');
  for (const { file, content } of out) {
    const p = join(SITE, file);
    assert.ok(existsSync(p), `site/${file} is missing`);
    assert.equal(readFileSync(p, 'utf8').replace(/\r\n/g, '\n'), content, `site/${file} is out of date`);
  }
});

test('every page: one h1, title, description, canonical and Open Graph on fishtapehq.com, shared header and footer', () => {
  assert.ok(pages.length >= 35);
  for (const { file, path, content } of pages) {
    const h1s = [...content.matchAll(/<h1\b/g)].length;
    assert.ok(file === 'signup.html' ? h1s === 2 : h1s === 1, `${file}: ${h1s} h1`); // signup: the form's and the hidden "check your email"
    assert.match(content, /<title>[^<]{10,}<\/title>/, file);
    const desc = /<meta name="description" content="([^"]+)">/.exec(content)?.[1] || '';
    assert.ok(desc.length >= 50 && desc.length <= 320, `${file}: description ${desc.length} chars`);
    assert.ok(content.includes(`<link rel="canonical" href="https://fishtapehq.com${path === '/' ? '/' : path}">`), `${file}: canonical`);
    for (const tag of ['og:title', 'og:description', 'og:image', 'og:url']) assert.ok(content.includes(`property="${tag}"`), `${file}: ${tag}`);
    assert.ok(content.includes('name="twitter:card" content="summary_large_image"'), `${file}: twitter card`);
    assert.ok(content.includes('<header class="site-head">') && content.includes('<footer class="site-foot">'), `${file}: header/footer`);
    assert.ok(content.includes('<script type="module" src="/site/site.js"></script>'), `${file}: site.js`);
    assert.doesNotMatch(content, /\sstyle\s*=|<style\b|\son[a-z]+\s*=|javascript:/i, `${file}: inline style/script`);
    for (const m of content.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) assert.ok(/\bsrc=/.test(m[1]) && !m[2].trim(), `${file}: inline script`);
    assert.match(content, /<html lang="en-CA">/, file);
  }
});

test('every internal link and image points at something that exists', () => {
  const assets = (p) => {
    if (p.startsWith('/site/')) return existsSync(join(SITE, p.slice(6)));
    if (/^\/(js|css|icons)\//.test(p)) return existsSync(new URL(`..${p}`, import.meta.url));
    return ['/.well-known/security.txt', '/sitemap.xml', '/robots.txt'].includes(p);
  };
  for (const { file, content } of pages) {
    for (const m of content.matchAll(/\s(?:href|src)="(\/[^"#?]*)/g)) {
      const p = m[1];
      if (p.startsWith('//') || p.startsWith('/api/')) continue;
      assert.ok(fileForPath(p) ? existsSync(join(SITE, fileForPath(p))) : assets(p), `${file}: ${p}`);
    }
    for (const m of content.matchAll(/srcset="([^"]+)"/g)) for (const part of m[1].split(',')) assert.ok(assets(part.trim().split(' ')[0]), `${file}: ${part}`);
    for (const m of content.matchAll(/<img\b[^>]*>/g)) assert.match(m[0], /\swidth="\d+" height="\d+"/, `${file}: image size`);
  }
});

test('sitemap and robots', () => {
  const sitemap = out.find((o) => o.file === 'sitemap.xml').content;
  const locs = [...sitemap.matchAll(/<loc>https:\/\/fishtapehq\.com([^<]*)<\/loc>/g)].map((m) => m[1]);
  assert.ok(locs.includes('/') && locs.includes('/about') && locs.includes('/features/wire-runs') && locs.includes('/for/ontario') && locs.includes('/services') && locs.includes('/status'));
  assert.ok(!locs.includes('/terms') && !locs.includes('/privacy'), 'noindex drafts stay out');
  for (const l of locs) assert.ok(fileForPath(l), l);
  assert.equal(new Set(locs).size, locs.length);
  const robots = out.find((o) => o.file === 'robots.txt').content;
  assert.match(robots, /^Disallow: \/api\/$/m);
  assert.match(robots, /^Disallow: \/hq\/$/m);
  assert.match(robots, /^Sitemap: https:\/\/fishtapehq\.com\/sitemap\.xml$/m);
});

test('pricing, features and home say there are no caps, and plans differ by features and users', () => {
  for (const file of ['pricing.html', 'features/index.html', 'index.html']) {
    const c = pages.find((p) => p.file === file).content;
    assert.match(c, /No caps on your work/, file);
    for (const thing of ['Invoices', 'Estimates and quotes', 'Jobs', 'Clients and leads', 'Drawings and plan sheets']) assert.ok(c.includes(`<li>${thing}</li>`), `${file}: ${thing}`);
    assert.match(c, /Plans differ by features and by how many users are included/, file);
  }
  // The pricing table is pre-rendered from plans.js, so it matches what pricing.js draws.
  const pricing = pages.find((p) => p.file === 'pricing.html').content;
  for (const id of plans.PLAN_IDS) assert.ok(pricing.includes(`<h2>${plans.PLANS[id].name}</h2>`), id);
  for (const f of Object.keys(plans.FEATURE_PLAN).filter((k) => FEATURE_LABELS[k])) assert.ok(pricing.includes(`<th scope="row">${FEATURE_LABELS[f].replace(/&/g, '&amp;')}</th>`), f);
});

test('honesty: no testimonials, ratings, customer counts or partner claims; pending things say coming', () => {
  const banned = /testimonial|★|\b\d[\d,]*\+? (?:contractors|electricians|customers|companies) (?:use|trust)|trusted by|rated \d|award-winning|#1\b|5-star|five-star|official partner|certified partner|SOC 2 (?:certified|compliant)/i;
  for (const { file, content } of pages) assert.doesNotMatch(content.replace(/<[^>]+>/g, ' '), banned, file);
  const ios = pages.find((p) => p.file === 'features/ios-app.html').content;
  assert.match(ios, /App Store listing coming/);
  const qbo = pages.find((p) => p.file === 'for/switching-from-quickbooks.html').content;
  assert.match(qbo, /Coming\.<\/strong> A live QuickBooks Online connection/);
  const sec = pages.find((p) => p.file === 'features/security-privacy.html').content;
  assert.match(sec, /has not had a formal SOC 2 audit/);
  // Service prices: quoted, never invented.
  const services = pages.find((p) => p.file === 'services.html').content;
  assert.doesNotMatch(services.replace(/<[^>]+>/g, ' '), /\$\s?\d/, 'no prices on services');
  assert.match(services, /Quoted per job/);
});
