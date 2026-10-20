// Pure helpers for the public site (no DOM at import time; tested in
// electrical-app/tests/site-pages.test.mjs).
//
// Page links in the HTML are the clean production URLs (/about, /features/wire-runs,
// /signup?plan=pro), which nginx serves on fishtapehq.com. Staging and local servers serve the
// same files under /site/ (/site/about.html, /site/features/wire-runs.html), so site.js points
// the links there when the page isn't on a marketing host.

/** Hosts that serve the clean URLs (deploy/production/nginx/fishtape.conf). */
export const MARKETING_HOSTS = Object.freeze(['fishtapehq.com', 'www.fishtapehq.com', 'fishtapehq.ca', 'www.fishtapehq.ca', 'status.fishtapehq.com']);

/** Top-level pages that are one file each in site/. */
export const FLAT_PAGES = Object.freeze(['pricing', 'signup', 'about', 'services', 'status', 'terms', 'privacy']);

/** Folders of pages: /features/<slug> and /for/<slug>. */
export const PAGE_FOLDERS = Object.freeze(['features', 'for']);

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const isMarketingHost = (hostname) => MARKETING_HOSTS.includes(String(hostname || '').toLowerCase());

/**
 * The file under site/ that serves a clean path, or null if it isn't a site page.
 *   '/' -> 'index.html', '/pricing' -> 'pricing.html', '/features' -> 'features/index.html',
 *   '/features/wire-runs' -> 'features/wire-runs.html', '/for/ontario' -> 'for/ontario.html'
 */
export function fileForPath(path) {
  const p = String(path || '');
  if (p === '/' || p === '') return 'index.html';
  const parts = p.replace(/^\//, '').replace(/\/$/, '').split('/');
  if (parts.length === 1 && FLAT_PAGES.includes(parts[0])) return `${parts[0]}.html`;
  if (parts.length === 1 && parts[0] === 'features') return 'features/index.html';
  if (parts.length === 2 && PAGE_FOLDERS.includes(parts[0]) && SLUG.test(parts[1])) return `${parts[0]}/${parts[1]}.html`;
  return null;
}

/** The clean path for a file under site/ (the inverse of fileForPath), or null. */
export function pathForFile(file) {
  const f = String(file || '').replace(/^\/?(site\/)?/, '');
  if (f === 'index.html') return '/';
  const m = /^([a-z0-9-]+)(?:\/([a-z0-9-]+))?\.html$/.exec(f);
  if (!m) return null;
  if (!m[2]) return FLAT_PAGES.includes(m[1]) ? `/${m[1]}` : null;
  if (!PAGE_FOLDERS.includes(m[1])) return null;
  if (m[2] === 'index') return m[1] === 'features' ? '/features' : null;
  return `/${m[1]}/${m[2]}`;
}

/**
 * Where a link written as a clean URL should point on this host. Unchanged on marketing hosts
 * and for anything that isn't a site page (/api/, /.well-known/, #anchors, other origins).
 *   localHref('/pricing#talk', 'tgelectrical.truecollarbuilt.com') -> '/site/pricing.html#talk'
 */
export function localHref(href, hostname) {
  const s = String(href || '');
  const host = String(hostname || '').toLowerCase();
  if (!s.startsWith('/') || s.startsWith('//')) return s;
  const m = /^([^?#]*)(.*)$/.exec(s);
  const file = fileForPath(m[1]);
  if (!file) return s;
  // status.fishtapehq.com serves only the status page (at /); the other pages live on the apex.
  if (host === STATUS_HOST) return m[1] === '/status' ? `/${m[2]}` : `https://fishtapehq.com${s}`;
  if (isMarketingHost(host)) return s;
  return `/site/${file}${m[2]}`;
}

export const STATUS_HOST = 'status.fishtapehq.com';

/** "Every plan", "Pro and up", "Business and up", "Enterprise". plans: plans.js PLANS/PLAN_IDS. */
export function planLabel(feature, { PLANS, PLAN_IDS, FEATURE_PLAN }) {
  const need = FEATURE_PLAN[feature];
  if (!need || need === PLAN_IDS[0]) return 'Every plan';
  const i = PLAN_IDS.indexOf(need);
  if (i < 0) return 'Every plan';
  if (i === PLAN_IDS.length - 1) return PLANS[need].name;
  return `${PLANS[need].name} and up`;
}

/** Plan names that include a feature: ['Pro', 'Business', 'Enterprise']. */
export function plansWith(feature, { PLANS, PLAN_IDS, FEATURE_PLAN }) {
  const need = FEATURE_PLAN[feature];
  const from = need ? Math.max(0, PLAN_IDS.indexOf(need)) : 0;
  return PLAN_IDS.slice(from).map((id) => PLANS[id].name);
}

/** "$129/month" from plans.js, or "Custom" for Enterprise. */
export function planPrice(id, { PLANS, CURRENCY }) {
  const p = PLANS[id];
  if (!p) return '';
  if (p.contactSales || p.priceCents == null) return 'Custom';
  const cents = p.priceCents;
  return `${(cents / 100).toLocaleString('en-CA', { style: 'currency', currency: CURRENCY, maximumFractionDigits: cents % 100 ? 2 : 0 })}/month`;
}

/** Services a "Talk to us" button can name (server/src/routes/hq-leads.js keeps the same list). */
export const LEAD_SERVICES = Object.freeze(['setup-integrations', 'data-import', 'price-book', 'crew-training', 'plan-templates', 'enterprise', 'contact']);
