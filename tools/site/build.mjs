#!/usr/bin/env node
// Builds the public site's generated parts into site/ (no build step at deploy time: the output is
// committed and served as static files).
//
//   node tools/site/build.mjs           write the pages
//   node tools/site/build.mjs --check   exit 1 if any page is out of date (CI and the tests)
//
// What it writes:
//  - the feature pages (/features, /features/<slug>), landing pages (/for/<slug>), /services and
//    /about, from tools/site/{features,landing,pages}.mjs;
//  - in the hand-written pages (index, pricing, signup, status, terms, privacy), the parts
//    between <!-- @site:NAME --> and <!-- /@site:NAME --> markers: head metadata (canonical,
//    Open Graph, Twitter), the shared header and footer, the "no caps" section, the home page
//    screenshots, and the pricing plan cards and feature table (also drawn by pricing.js and
//    landing.js at runtime, so the first paint matches and nothing shifts);
//  - site/sitemap.xml and site/robots.txt.
// Plan facts come from electrical-app/js/plans.js, province facts from the app's code and tax
// data, so a change there shows up here as an out-of-date page until the build is re-run.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ORIGIN, SITE_ROOT, esc, footerBlock, headerBlock, html, limitsSection, metaBlock, missingShots, pageHtml, plans, shotImg, str } from './lib.mjs';
import { aboutPage, featurePage, featuresIndex, landingPages, servicesPage } from './pages.mjs';
import { FEATURES, bySlug } from './features.mjs';
import { FEATURE_LABELS } from '../../electrical-app/js/modules/billing.js';

const CHECK = process.argv.includes('--check');

/** Hand-written pages and their clean paths. */
export const HAND_WRITTEN = [
  { file: 'index.html', path: '/' },
  { file: 'pricing.html', path: '/pricing' },
  { file: 'signup.html', path: '/signup' },
  { file: 'status.html', path: '/status' },
  { file: 'terms.html', path: '/terms', noindex: true },
  { file: 'privacy.html', path: '/privacy', noindex: true },
];

const money = (cents) => (cents / 100).toLocaleString('en-CA', { style: 'currency', currency: plans.CURRENCY, maximumFractionDigits: cents % 100 ? 2 : 0 });

/** Plan cards exactly as site/pricing.js draws them. */
function pricingCards() {
  const { PLANS, PLAN_IDS, FEATURE_PLAN } = plans;
  const added = (id) => Object.keys(FEATURE_PLAN).filter((f) => FEATURE_PLAN[f] === id);
  return PLAN_IDS.map((id, i) => {
    const p = PLANS[id];
    const contact = p.contactSales || p.priceCents == null;
    const feats = added(id).filter((f) => FEATURE_LABELS[f]).slice(0, 7);
    return str(html`<article class="site-plan"><h2>${p.name}</h2><p class="site-price">${contact ? 'Custom' : html`${money(p.priceCents)}<small> /month</small>`}</p><p class="site-muted">${p.blurb}</p><p class="site-users">${p.includedUsers == null ? 'Users to suit you' : `${p.includedUsers} users included`}</p><ul>${i > 0 ? html`<li class="site-muted">Everything in ${PLANS[PLAN_IDS[i - 1]].name}, plus:</li>` : ''}${feats.map((f) => html`<li>${FEATURE_LABELS[f]}</li>`)}</ul>${contact ? html`<a class="site-btn ghost" href="#talk">Let's talk</a>` : html`<a class="site-btn" href="/signup?plan=${id}">Start a free trial</a>`}</article>`);
  }).join('\n      ');
}

/** The features-by-plan table body, as site/pricing.js draws it. */
function featureTable() {
  const { PLANS, PLAN_IDS, FEATURE_PLAN, planRank } = plans;
  const rows = Object.keys(FEATURE_PLAN).filter((f) => FEATURE_LABELS[f]).sort((a, b) => planRank(FEATURE_PLAN[a]) - planRank(FEATURE_PLAN[b]));
  return str(html`<thead><tr><th scope="col">Feature</th>${PLAN_IDS.map((id) => html`<th scope="col" class="c">${PLANS[id].name}</th>`)}</tr></thead><tbody>${rows.map((f) => html`<tr><th scope="row">${FEATURE_LABELS[f]}</th>${PLAN_IDS.map((id) => {
    const yes = planRank(id) >= planRank(FEATURE_PLAN[f]);
    return html`<td class="c ${yes ? 'yes' : 'no'}"><span aria-hidden="true">${yes ? '✓' : '—'}</span><span class="sr-only">${yes ? 'Included' : 'Not included'}</span></td>`;
  })}</tr>`)}</tbody>`);
}

/** The home page's pricing teaser, as site/landing.js draws it. */
function teaserCards() {
  const { PLANS, PLAN_IDS } = plans;
  return PLAN_IDS.map((id) => {
    const p = PLANS[id];
    const contact = p.contactSales || p.priceCents == null;
    return str(html`<article class="site-plan"><h3>${p.name}</h3><p class="site-price">${contact ? 'Custom' : html`${money(p.priceCents)}<small> /month</small>`}</p><p class="site-muted">${p.blurb}</p><p class="site-users">${p.includedUsers == null ? 'Users to suit you' : `${p.includedUsers} users included`}</p><a class="${contact ? 'site-btn ghost' : 'site-btn'}" href="${contact ? '/pricing#talk' : `/signup?plan=${id}`}">${contact ? "Let's talk" : 'Start free trial'}</a></article>`);
  }).join('\n          ');
}

const HOME_SHOTS = ['plans-takeoff', 'box-placement', 'wire-runs', 'pipe-bending', 'estimating-invoicing', 'safety'];
function homeShots() {
  const items = HOME_SHOTS.map((slug) => {
    const f = bySlug[slug];
    return str(html`<figure class="land-feature"><a href="/features/${slug}">${shotImg(f.shot[0], f.shot[1], { sizes: '(min-width: 1120px) 350px, (min-width: 700px) 45vw, 100vw' })}<figcaption><strong>${f.name}.</strong> ${f.card}</figcaption></a></figure>`);
  });
  return `<div class="land-features">\n          ${items.join('\n          ')}\n        </div>`;
}

/** Replace what's between <!-- @site:NAME ... --> and <!-- /@site:NAME --> with `content`. */
export function fillMarker(text, name, content) {
  const re = new RegExp(`(<!-- @site:${name}(?: [^>]*)? -->\\n)([\\s\\S]*?)([ \\t]*<!-- /@site:${name} -->)`);
  if (!re.test(text)) return text;
  return text.replace(re, (_, open, _old, close) => `${open}${content ? `${content.replace(/\n+$/, '')}\n` : ''}${close}`);
}

function handWritten(page, source) {
  let s = source.replace(/\r\n/g, '\n');
  const title = /<title>([^<]*)<\/title>/.exec(s)?.[1] || 'Fishtape';
  const description = /<meta name="description" content="([^"]*)">/.exec(s)?.[1] || '';
  const decode = (v) => v.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  s = fillMarker(s, 'meta', metaBlock({ path: page.path, title: decode(title), description: decode(description) }));
  s = fillMarker(s, 'header', headerBlock(page.path));
  s = fillMarker(s, 'footer', footerBlock());
  s = fillMarker(s, 'limits', str(limitsSection()).split('\n').map((l) => `      ${l}`).join('\n'));
  s = fillMarker(s, 'shots', `        ${homeShots()}`);
  s = fillMarker(s, 'plans', `      ${pricingCards()}`);
  s = fillMarker(s, 'feature-table', featureTable());
  s = fillMarker(s, 'teaser', `          ${teaserCards()}`);
  s = fillMarker(s, 'extra-users', `      More users than your plan includes? Each extra user is ${money(plans.EXTRA_USER_CENTS)}/month. Taxes are added at checkout for your province.`);
  return s;
}

function sitemap(paths) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map((p) => `  <url><loc>${esc(`${ORIGIN}${p}`)}</loc></url>`).join('\n')}
</urlset>
`;
}

const ROBOTS = `# fishtapehq.com
User-agent: *
Allow: /
Disallow: /api/
Disallow: /hq/

Sitemap: ${ORIGIN}/sitemap.xml
`;

/** Everything the build produces: [{ file, content }]. */
export function buildAll() {
  const generated = [featuresIndex(), ...FEATURES.map(featurePage), ...landingPages(), servicesPage(), aboutPage()];
  const out = generated.map((p) => ({ file: p.file, path: p.path, content: pageHtml(p) }));
  for (const page of HAND_WRITTEN) {
    const p = join(SITE_ROOT, page.file);
    out.push({ file: page.file, path: page.path, noindex: page.noindex, content: handWritten(page, readFileSync(p, 'utf8')) });
  }
  const indexable = out.filter((o) => !o.noindex).map((o) => o.path).sort((a, b) => (a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b)));
  out.push({ file: 'sitemap.xml', content: sitemap(indexable) });
  out.push({ file: 'robots.txt', content: ROBOTS });
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = buildAll();
  if (missingShots.size && !process.argv.includes('--allow-missing-shots')) {
    console.error(`Missing screenshots in site/img/shots/: ${[...missingShots].sort().join(', ')}`);
    process.exit(1);
  }
  const stale = [];
  for (const { file, content } of out) {
    const p = join(SITE_ROOT, file);
    const cur = existsSync(p) ? readFileSync(p, 'utf8').replace(/\r\n/g, '\n') : null;
    if (cur === content) continue;
    if (CHECK) { stale.push(file); continue; }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    console.log(`wrote site/${file}`);
  }
  if (CHECK && stale.length) {
    console.error(`Out of date (run node tools/site/build.mjs): ${stale.map((f) => `site/${f}`).join(', ')}`);
    process.exit(1);
  }
  console.log(`site build: ${out.length} files${CHECK ? ' up to date' : ''}.`);
}
