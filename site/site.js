// Every public page: brand name, year, "Sign in" links, the phone menu, plan facts from the
// app's plans.js, and (off the marketing hosts) page links pointed at /site/*.html.
// Pages with a "Talk to us" form also load lead-form.js.
import { BRAND } from '/js/brand.js';
import { wireAppLinks } from '/site/app-link.js';
import { localHref, planLabel, planPrice } from '/site/site-lib.js';

for (const n of document.querySelectorAll('[data-brand]')) n.textContent = BRAND.name;
for (const n of document.querySelectorAll('[data-year]')) n.textContent = String(new Date().getFullYear());
wireAppLinks();

// Staging and local servers serve the pages under /site/; production serves clean URLs.
const host = location.hostname;
for (const a of document.querySelectorAll('a[href^="/"]')) {
  const next = localHref(a.getAttribute('href'), host);
  if (next !== a.getAttribute('href')) a.setAttribute('href', next);
}

// Phone menu: a <details>. Close it on Escape, on a click outside and after following a link.
const menu = document.querySelector('.site-menu');
if (menu) {
  const close = () => { if (menu.open) menu.open = false; };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu.open) { close(); menu.querySelector('summary')?.focus(); } });
  document.addEventListener('click', (e) => { if (menu.open && !menu.contains(e.target)) close(); });
  for (const a of menu.querySelectorAll('a')) a.addEventListener('click', close);
}

// Plan facts: the HTML carries the text from build time (tools/site/build.mjs); refresh it from
// plans.js so a page never shows a plan the app no longer has.
if (document.querySelector('[data-plan-feature], [data-plan-price], [data-plan-users]')) {
  import('/js/plans.js').then((plans) => {
    for (const n of document.querySelectorAll('[data-plan-feature]')) n.textContent = planLabel(n.dataset.planFeature, plans);
    for (const n of document.querySelectorAll('[data-plan-price]')) n.textContent = planPrice(n.dataset.planPrice, plans);
    for (const n of document.querySelectorAll('[data-plan-users]')) {
      const u = plans.PLANS[n.dataset.planUsers]?.includedUsers;
      n.textContent = u == null ? 'as many users as you need' : `${u} users`;
    }
  }).catch(() => { /* the build-time text stays */ });
}

if (document.querySelector('form[data-lead-form]')) import('/site/lead-form.js');
