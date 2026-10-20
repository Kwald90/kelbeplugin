// Building blocks for the public site pages (tools/site/build.mjs). Every page gets the same
// <head> metadata, header and footer. Output is plain HTML with no inline styles or scripts
// (the CSP allows neither), so pages work with JavaScript off; site/site.js adds the extras.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as plans from '../../electrical-app/js/plans.js';
import { planLabel, plansWith } from '../../site/site-lib.js';

export const ORIGIN = 'https://fishtapehq.com';
export const OG_IMAGE = { path: '/site/img/og/fishtape-og.png', width: 1200, height: 630, alt: 'Fishtape: software for Canadian electrical contractors' };
export const SITE_ROOT = new URL('../../site/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** Escape text for HTML (attributes and text). */
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A tagged template that escapes interpolated values unless they are raw() or arrays of raw(). */
const RAW = Symbol('raw');
export const raw = (s) => ({ [RAW]: String(s ?? '') });
const val = (v) => {
  if (v == null || v === false) return '';
  if (Array.isArray(v)) return v.map(val).join('');
  if (typeof v === 'object' && RAW in v) return v[RAW];
  return esc(v);
};
export const html = (strings, ...vals) => raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? val(vals[i]) : ''), ''));
export const str = (r) => val(r);

export const NAV = [
  { href: '/features', label: 'Features', match: /^\/features/ },
  { href: '/pricing', label: 'Pricing', match: /^\/pricing$/ },
  { href: '/services', label: 'Services', match: /^\/services$/ },
  { href: '/about', label: 'About', match: /^\/about$/ },
  { href: '/status', label: 'Status', match: /^\/status$/ },
];
export const APP_URL = 'https://app.fishtapehq.com/';
export const TRIAL_HREF = '/signup?plan=pro';

/** The <head> metadata block (between the @site:meta markers). */
export function metaBlock(page) {
  const url = `${ORIGIN}${page.path === '/' ? '/' : page.path}`;
  const image = `${ORIGIN}${OG_IMAGE.path}`;
  const lines = [
    `<link rel="canonical" href="${esc(url)}">`,
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="Fishtape">',
    '<meta property="og:locale" content="en_CA">',
    `<meta property="og:title" content="${esc(page.ogTitle || page.title)}">`,
    `<meta property="og:description" content="${esc(page.description)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    `<meta property="og:image:width" content="${OG_IMAGE.width}">`,
    `<meta property="og:image:height" content="${OG_IMAGE.height}">`,
    `<meta property="og:image:alt" content="${esc(OG_IMAGE.alt)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${esc(page.ogTitle || page.title)}">`,
    `<meta name="twitter:description" content="${esc(page.description)}">`,
    `<meta name="twitter:image" content="${esc(image)}">`,
  ];
  return lines.map((l) => `  ${l}`).join('\n');
}

const navLink = (n, path) => `<a href="${n.href}"${n.match.test(path) ? ' aria-current="page"' : ''}>${n.label}</a>`;

/** The shared header (between the @site:header markers). */
export function headerBlock(path) {
  return `  <a class="site-skip" href="#main">Skip to content</a>
  <header class="site-head">
    <div class="site-head-in">
      <a class="site-brand" href="/"><span class="site-mark" aria-hidden="true">⚡</span> <span data-brand>Fishtape</span></a>
      <nav class="site-nav" aria-label="Main">
        ${NAV.map((n) => navLink(n, path)).join('\n        ')}
      </nav>
      <div class="site-head-actions">
        <a class="site-signin" data-app-link href="${APP_URL}">Sign in</a>
        <a class="site-btn ghost" data-app-link="/#/demo" href="${APP_URL}#/demo">Try the demo</a>
        <a class="site-btn" href="${TRIAL_HREF}">Start free trial</a>
        <details class="site-menu">
          <summary><span class="site-burger" aria-hidden="true"></span><span class="sr-only">Menu</span></summary>
          <nav class="site-menu-panel" aria-label="Main (menu)">
            ${NAV.map((n) => navLink(n, path)).join('\n            ')}
            <span class="site-menu-sep" aria-hidden="true"></span>
            <a data-app-link href="${APP_URL}">Sign in</a>
          </nav>
        </details>
      </div>
    </div>
  </header>`;
}

export const FOOTER_COLS = [
  { title: 'Product', links: [['/features', 'Features'], ['/pricing', 'Pricing'], ['/services', 'Services'], ['/features/ios-app', 'iPad and iPhone'], ['/features/security-privacy', 'Security'], ['/status', 'Service status']] },
  { title: 'Who it\'s for', links: [['/for/residential-electricians', 'Residential electricians'], ['/for/commercial-industrial', 'Commercial and industrial'], ['/for/solo-electricians', 'Solo electricians'], ['/for/switching-from-jobber', 'Switching from Jobber'], ['/for/switching-from-housecall-pro', 'Switching from Housecall Pro'], ['/for/switching-from-quickbooks', 'Switching from QuickBooks']] },
  { title: 'By province', links: [['/for/ontario', 'Ontario'], ['/for/british-columbia', 'British Columbia'], ['/for/alberta', 'Alberta'], ['/for/saskatchewan', 'Saskatchewan'], ['/for/manitoba', 'Manitoba'], ['/for/atlantic-canada', 'Atlantic Canada']] },
  { title: 'Company', links: [['/about', 'About'], ['/about#contact', 'Contact'], ['/terms', 'Terms'], ['/privacy', 'Privacy'], ['/.well-known/security.txt', 'security.txt']] },
];

/** The shared footer (between the @site:footer markers). */
export function footerBlock() {
  return `  <footer class="site-foot">
    <div class="site-foot-in">
      <div class="site-foot-brand">
        <a class="site-brand" href="/"><span class="site-mark" aria-hidden="true">⚡</span> <span data-brand>Fishtape</span></a>
        <p>Jobs, quotes, drawings, crew time and invoices for Canadian electrical contractors. Built by a working electrical contractor.</p>
      </div>
      <div class="site-foot-cols">
${FOOTER_COLS.map((c) => `        <nav aria-label="${esc(c.title)}">
          <h2>${esc(c.title)}</h2>
          <ul>
${c.links.map(([href, label]) => `            <li><a href="${href}">${esc(label)}</a></li>`).join('\n')}
          </ul>
        </nav>`).join('\n')}
      </div>
    </div>
    <div class="site-foot-base">
      <span>© <span id="year" data-year>2026</span> <span data-brand>Fishtape</span>. Prices in Canadian dollars.</span>
      <span>Built for the Canadian electrical trade.</span>
    </div>
  </footer>`;
}

/** A whole page from its parts. */
export function pageHtml(page) {
  const css = ['/css/tokens.css', '/site/site.css', ...(page.css || [])];
  const scripts = ['/site/site.js', ...(page.scripts || [])];
  return `<!doctype html>
<html lang="en-CA">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(page.title)}</title>
  <meta name="description" content="${esc(page.description)}">
  <meta name="referrer" content="strict-origin-when-cross-origin">
  <meta name="theme-color" content="#16171a">
  <!-- Where the API lives. Empty = this origin. -->
  <meta name="fishtape-api" content="">
  <!-- Where "Sign in" goes. Empty = worked out by site/app-link.js. -->
  <meta name="fishtape-app" content="">
  <!-- @site:meta (tools/site/build.mjs) -->
${metaBlock(page)}
  <!-- /@site:meta -->
  <link rel="icon" href="/icons/icon.svg" type="image/svg+xml">
${css.map((h) => `  <link rel="stylesheet" href="${h}">`).join('\n')}
</head>
<body>
  <!-- @site:header -->
${headerBlock(page.path)}
  <!-- /@site:header -->

  <main id="main"${page.mainClass ? ` class="${page.mainClass}"` : ''}>
${str(page.body).trim().split('\n').map((l) => (l ? `    ${l}` : l)).join('\n')}
  </main>

  <!-- @site:footer -->
${footerBlock()}
  <!-- /@site:footer -->

${scripts.map((s) => `  <script type="module" src="${s}"></script>`).join('\n')}
</body>
</html>
`;
}

// ---- screenshots ----------------------------------------------------------------------

/** Pixel sizes of the captures in site/img/shots/ (tools: see docs/marketing/landing.md). */
const SHOT_SIZE = { tablet: { full: [1366, 1024], sm: [683, 512] }, phone: { full: [780, 1688], sm: [390, 844] } };
export const missingShots = new Set();

function checkShot(name) {
  for (const f of [`${name}.webp`, `${name}.jpg`, `${name}-sm.webp`, `${name}-sm.jpg`]) {
    if (!existsSync(join(SITE_ROOT, 'img', 'shots', f))) missingShots.add(f);
  }
}

/** A responsive screenshot: WebP with a JPEG fallback, card size first, full size on wide screens. */
export function shotImg(name, alt, { eager = false, sizes = '(min-width: 900px) 560px, 100vw', phone = false } = {}) {
  checkShot(name);
  const s = SHOT_SIZE[phone ? 'phone' : 'tablet'];
  const base = `/site/img/shots/${name}`;
  const set = (ext) => `${base}-sm.${ext} ${s.sm[0]}w, ${base}.${ext} ${s.full[0]}w`;
  return html`<picture><source type="image/webp" srcset="${set('webp')}" sizes="${sizes}"><img src="${base}-sm.jpg" srcset="${set('jpg')}" sizes="${sizes}" width="${s.sm[0]}" height="${s.sm[1]}" alt="${alt}"${raw(eager ? ' fetchpriority="high" decoding="async"' : ' loading="lazy" decoding="async"')}></picture>`;
}

export function shotFigure(name, alt, caption, opts = {}) {
  return html`<figure class="shot${opts.phone ? ' phone' : ''}">${shotImg(name, alt, opts)}${caption ? html`<figcaption>${caption}</figcaption>` : ''}</figure>`;
}

// ---- plans ---------------------------------------------------------------------------------

/** "Included in: Pro and up" with the plan names, refreshed by site.js from plans.js. */
export function planBadge(feature, label = 'Included in') {
  return html`<p class="mk-plan">${label}: <span data-plan-feature="${feature}">${planLabel(feature, plans)}</span> <a href="/pricing#features">Compare plans</a></p>`;
}

/** A list of the plan features a page covers, each with the plans that include it. */
export function planList(items) {
  return html`<ul class="mk-plans">${items.map(([feature, label]) => html`<li><span>${label}</span><span data-plan-feature="${feature}">${planLabel(feature, plans)}</span></li>`)}</ul>`;
}

export const plansIncluding = (feature) => plansWith(feature, plans);
export { plans };

// ---- shared sections -----------------------------------------------------------------------

/** "Pricing says what you get": no record caps. Used on pricing, features and the home page. */
export function limitsSection(headingId = 'limits-title') {
  return html`<section class="site-section mk-limits" aria-labelledby="${headingId}">
  <h2 id="${headingId}">No caps on your work</h2>
  <p>Every plan, trial included, lets you make as many as you need of:</p>
  <ul>
    <li>Invoices</li>
    <li>Estimates and quotes</li>
    <li>Jobs</li>
    <li>Clients and leads</li>
    <li>Drawings and plan sheets</li>
  </ul>
  <p class="site-fine">Plans differ by features and by how many users are included, nothing else. Downgrading never deletes anything: you keep reading everything you made.</p>
</section>`;
}

export function ctaBand({ title = 'Try it on your next job', text = '14 days free on the plan you pick. A $1 deposit confirms your card and comes off your first month. Cancel before the trial ends and the plan is never charged.', primary = ['Start free trial', TRIAL_HREF], secondary = ['See pricing', '/pricing'] } = {}) {
  return html`<section class="mk-cta" aria-label="Get started">
  <h2>${title}</h2>
  <p>${text}</p>
  <div class="mk-ctas"><a class="site-btn big" href="${primary[1]}">${primary[0]}</a>${secondary ? html` <a class="site-btn ghost big" href="${secondary[1]}">${secondary[0]}</a>` : ''}</div>
</section>`;
}

export function faq(items) {
  return html`<div class="mk-faq">${items.map(([q, a]) => html`<details><summary>${q}</summary><div>${(Array.isArray(a) ? a : [a]).map((p) => html`<p>${p}</p>`)}</div></details>`)}</div>`;
}
