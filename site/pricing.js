// Pricing page: tiers and the features table come from the app's plans.js (one source of
// truth with the server's entitlements); the Enterprise form posts to the public lead API.
import { PLANS, PLAN_IDS, FEATURE_PLAN, EXTRA_USER_CENTS, CURRENCY, planRank } from '/js/plans.js';
import { FEATURE_LABELS } from '/js/modules/billing.js';
import { BRAND } from '/js/brand.js';

const API = document.querySelector('meta[name="fishtape-api"]')?.content.replace(/\/$/, '') || '';
const money = (cents) => (cents / 100).toLocaleString('en-CA', { style: 'currency', currency: CURRENCY, maximumFractionDigits: cents % 100 ? 2 : 0 });

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}

for (const n of document.querySelectorAll('[data-brand]')) n.textContent = BRAND.name;
document.getElementById('year').textContent = String(new Date().getFullYear());
document.title = `Pricing · ${BRAND.name}`;

// ---- plan cards ---------------------------------------------------------------
const added = (id) => Object.keys(FEATURE_PLAN).filter((f) => FEATURE_PLAN[f] === id);
const plansHost = document.getElementById('plans');
plansHost.replaceChildren(...PLAN_IDS.map((id, i) => {
  const p = PLANS[id];
  const contact = p.contactSales || p.priceCents == null;
  const feats = added(id).filter((f) => FEATURE_LABELS[f]).slice(0, 7);
  return el('article', { class: 'site-plan' },
    el('h2', {}, p.name),
    el('p', { class: 'site-price' }, contact ? 'Custom' : [money(p.priceCents), el('small', {}, ' /month')]),
    el('p', { class: 'site-muted' }, p.blurb),
    el('p', { class: 'site-users' }, p.includedUsers == null ? 'Users to suit you' : `${p.includedUsers} users included`),
    el('ul', {}, i > 0 ? el('li', { class: 'site-muted' }, `Everything in ${PLANS[PLAN_IDS[i - 1]].name}, plus:`) : null,
      feats.map((f) => el('li', {}, FEATURE_LABELS[f]))),
    contact
      ? el('a', { class: 'site-btn ghost', href: '#talk' }, "Let's talk")
      : el('a', { class: 'site-btn', href: `/site/signup.html?plan=${id}` }, 'Start a free trial'));
}));
document.getElementById('extra-users').textContent = `More users than your plan includes? Each extra user is ${money(EXTRA_USER_CENTS)}/month. Taxes are added at checkout for your province.`;

// ---- features table -------------------------------------------------------------
const table = document.getElementById('feature-table');
const rows = Object.keys(FEATURE_PLAN).filter((f) => FEATURE_LABELS[f]).sort((a, b) => planRank(FEATURE_PLAN[a]) - planRank(FEATURE_PLAN[b]));
table.append(
  el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Feature'), PLAN_IDS.map((id) => el('th', { scope: 'col', class: 'c' }, PLANS[id].name)))),
  el('tbody', {}, rows.map((f) => el('tr', {}, el('th', { scope: 'row' }, FEATURE_LABELS[f]),
    PLAN_IDS.map((id) => {
      const yes = planRank(id) >= planRank(FEATURE_PLAN[f]);
      return el('td', { class: `c ${yes ? 'yes' : 'no'}` }, el('span', { 'aria-hidden': 'true' }, yes ? '✓' : '—'), el('span', { class: 'sr-only' }, yes ? 'Included' : 'Not included'));
    })))));

// ---- Enterprise form ----------------------------------------------------------------
const form = document.getElementById('talk-form');
const errorBox = document.getElementById('talk-error');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorBox.hidden = true;
  if (!form.reportValidity()) return;
  const data = Object.fromEntries(new FormData(form).entries());
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  button.textContent = 'Sending…';
  try {
    const res = await fetch(`${API}/api/v1/public/enterprise-leads`, {
      method: 'POST', credentials: 'omit', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Fishtape': '1' },
      body: JSON.stringify(data),
    });
    if (res.status === 202) {
      form.hidden = true;
      document.getElementById('talk-done').hidden = false;
      return;
    }
    const body = await res.json().catch(() => null);
    const code = body?.error?.code;
    errorBox.textContent = code === 'rate_limited' ? 'Too many messages from here. Please try again in an hour, or email us.'
      : code === 'validation_failed' ? 'Please check your name, email and company.'
        : 'Something went wrong. Please try again in a moment.';
    errorBox.hidden = false;
  } catch {
    errorBox.textContent = 'We could not reach Fishtape. Check your connection and try again.';
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = 'Send';
  }
});
