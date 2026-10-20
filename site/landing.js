// Landing page: the video hero with the live promotion, and the pricing teaser from plans.js.
// The promotion comes from GET /api/v1/public/promotions/active (managed in HQ > Promotions);
// if the API is slow or down, the built-in default (hero.js FALLBACK_PROMOTION) is used.
import { PLANS, PLAN_IDS, CURRENCY } from '/js/plans.js';
import { BRAND } from '/js/brand.js';
import { createHero, FALLBACK_PROMOTION } from '/site/hero.js';
import { wireAppLinks } from '/site/app-link.js';

const API = document.querySelector('meta[name="fishtape-api"]')?.content.replace(/\/$/, '') || '';
const PROVINCES = new Set(['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT']);

for (const n of document.querySelectorAll('[data-brand]')) n.textContent = BRAND.name;
document.getElementById('year').textContent = String(new Date().getFullYear());
wireAppLinks();

/**
 * Audience tags from this page's address, e.g. /site/?province=ON&utm_campaign=spring-show
 * -> province=ON, campaign=spring-show. Codes only; nothing else from the URL is sent on.
 */
function audienceTags(search = location.search) {
  const q = new URLSearchParams(search);
  const tags = [];
  const prov = (q.get('province') || '').toUpperCase();
  if (PROVINCES.has(prov)) tags.push(`province=${prov}`);
  const campaign = (q.get('campaign') || q.get('utm_campaign') || '').toLowerCase();
  if (/^[a-z0-9_-]{1,64}$/.test(campaign)) tags.push(`campaign=${campaign}`);
  return tags;
}

async function activePromotion() {
  const tags = audienceTags();
  const url = `${API}/api/v1/public/promotions/active${tags.length ? `?audience=${encodeURIComponent(tags.join(','))}` : ''}`;
  try {
    const res = await fetch(url, { credentials: 'omit', cache: 'no-cache', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(2500) });
    if (!res.ok) return FALLBACK_PROMOTION;
    const body = await res.json();
    return Array.isArray(body?.promotion?.slides) && body.promotion.overlay ? body.promotion : FALLBACK_PROMOTION;
  } catch {
    return FALLBACK_PROMOTION;
  }
}

// ---- hero ----
const heroRoot = document.getElementById('hero');
activePromotion().then((promotion) => {
  heroRoot.heroPlayer = createHero(heroRoot, promotion);
});

// ---- pricing teaser ----
const money = (cents) => (cents / 100).toLocaleString('en-CA', { style: 'currency', currency: CURRENCY, maximumFractionDigits: cents % 100 ? 2 : 0 });
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
document.getElementById('land-plans').replaceChildren(...PLAN_IDS.map((id) => {
  const p = PLANS[id];
  const contact = p.contactSales || p.priceCents == null;
  const card = el('article', 'site-plan');
  const price = el('p', 'site-price', contact ? 'Custom' : money(p.priceCents));
  if (!contact) price.append(el('small', null, ' /month'));
  const cta = el('a', contact ? 'site-btn ghost' : 'site-btn', contact ? "Let's talk" : 'Start free trial');
  cta.href = contact ? '/site/pricing.html#talk' : `/site/signup.html?plan=${encodeURIComponent(id)}`;
  card.append(el('h3', null, p.name), price, el('p', 'site-muted', p.blurb),
    el('p', 'site-users', p.includedUsers == null ? 'Users to suit you' : `${p.includedUsers} users included`), cta);
  return card;
}));
