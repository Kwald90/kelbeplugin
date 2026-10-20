// Sign-up page: the form posts to POST /api/v1/public/signup, which answers with a Stripe
// Checkout URL (14-day trial + $1 deposit charged now). Stripe sends people back here with
// ?done=1 (check your email) or ?cancelled=1 (nothing charged; the form is filled in again).
// Tiers and prices come from the app's plans.js, the trial length and deposit from the API.
import { PLANS, EXTRA_USER_CENTS, CURRENCY, monthlyCents } from '/js/plans.js';
import { BRAND } from '/js/brand.js';

const API = document.querySelector('meta[name="fishtape-api"]')?.content.replace(/\/$/, '') || '';
const APP = document.querySelector('meta[name="fishtape-app"]')?.content.replace(/\/$/, '') || '';
const SELF_SERVE = ['starter', 'pro', 'business'];
const DRAFT_KEY = 'ft.signup.draft';
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,63}$/;
const $ = (id) => document.getElementById(id);
const money = (cents) => (cents / 100).toLocaleString('en-CA', { style: 'currency', currency: CURRENCY, minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 });

const params = new URLSearchParams(location.search);
const opts = { open: true, trialDays: 14, depositCents: 100 };

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}

const draft = {
  read() { try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null'); } catch { return null; } },
  // Never the password: only what saves retyping after a cancelled checkout.
  save(v) { try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ companyName: v.companyName, province: v.province, name: v.name, email: v.email, plan: v.plan, users: v.users })); } catch { /* storage blocked */ } },
  clear() { try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* storage blocked */ } },
};

for (const n of document.querySelectorAll('[data-brand]')) n.textContent = BRAND.name;
for (const a of document.querySelectorAll('[data-app-link]')) a.href = `${APP}/#/sign-in`;
$('year').textContent = String(new Date().getFullYear());
document.title = `Start your free trial · ${BRAND.name}`;

// ---- after Stripe: check your email ------------------------------------------------------
if (params.get('done') === '1') {
  const d = draft.read();
  draft.clear();
  $('su-start').hidden = true;
  $('su-done').hidden = false;
  if (d?.email) $('su-done-to').textContent = `We sent a link to ${d.email} to confirm your email and set up two-step sign-in.`;
  document.title = `Check your email · ${BRAND.name}`;
  $('su-done-title').focus();
} else {
  startForm();
}

function startForm() {
  const form = $('su-form');
  const errorsBox = $('su-errors');
  const notice = $('su-notice');
  const submit = $('su-submit');
  const fields = {
    companyName: $('su-company'), province: $('su-province'), name: $('su-name'), email: $('su-email'),
    password: $('su-password'), users: $('su-users'), acceptTerms: $('su-terms'),
  };
  const labels = { companyName: 'Company name', province: 'Province or territory', name: 'Your name', email: 'Work email', password: 'Password', plan: 'Plan', users: 'How many people', acceptTerms: 'Terms and privacy' };

  // ---- plan cards ----
  const wanted = SELF_SERVE.includes(params.get('plan')) ? params.get('plan') : 'pro';
  $('su-plan-list').replaceChildren(...SELF_SERVE.map((id) => {
    const p = PLANS[id];
    const input = el('input', { type: 'radio', name: 'plan', value: id, id: `su-plan-${id}`, class: 'su-radio' });
    if (id === wanted) input.checked = true;
    return el('label', { class: 'su-plan', for: `su-plan-${id}` }, input,
      el('span', { class: 'su-plan-body' },
        el('span', { class: 'su-plan-top' }, el('strong', {}, p.name), el('span', { class: 'su-plan-price' }, money(p.priceCents), el('small', {}, '/month'))),
        el('span', { class: 'su-plan-meta' }, `${p.includedUsers} users included · ${p.blurb}`)));
  }));
  const planValue = () => form.querySelector('input[name="plan"]:checked')?.value || '';

  function drawSummary() {
    const plan = planValue() || 'pro';
    const p = PLANS[plan];
    const users = Math.max(1, Math.min(500, Number.parseInt(fields.users.value, 10) || 1));
    const extra = Math.max(0, users - p.includedUsers);
    for (const n of document.querySelectorAll('[data-plan-name]')) n.textContent = p.name;
    $('su-price').textContent = `${money(monthlyCents(plan, users))}/month${extra ? ` (${p.name} plus ${extra} extra user${extra === 1 ? '' : 's'} at ${money(EXTRA_USER_CENTS)})` : ''}`;
    $('su-users-hint').textContent = `${p.name} includes ${p.includedUsers} users; more are ${money(EXTRA_USER_CENTS)}/month each. Office and field staff together; you can change this any time.`;
  }
  function drawOptions() {
    for (const n of document.querySelectorAll('[data-trial-days]')) n.textContent = String(opts.trialDays);
    for (const n of document.querySelectorAll('[data-deposit]')) n.textContent = money(opts.depositCents);
  }
  form.addEventListener('change', drawSummary);
  fields.users.addEventListener('input', drawSummary);

  $('su-show').addEventListener('click', (e) => {
    const show = fields.password.type === 'password';
    fields.password.type = show ? 'text' : 'password';
    e.currentTarget.textContent = show ? 'Hide' : 'Show';
    e.currentTarget.setAttribute('aria-pressed', String(show));
  });

  // ---- coming back from a cancelled checkout ----
  const back = draft.read();
  if (back) {
    for (const k of ['companyName', 'province', 'name', 'email']) if (typeof back[k] === 'string') fields[k].value = back[k];
    if (Number.isInteger(back.users)) fields.users.value = String(back.users);
    if (!SELF_SERVE.includes(params.get('plan')) && SELF_SERVE.includes(back.plan)) $(`su-plan-${back.plan}`).checked = true;
  }
  if (params.get('cancelled') === '1') showNotice('Payment cancelled. Nothing was charged. Your details are filled in again; enter your password to continue.', 'info');
  drawOptions();
  drawSummary();

  fetch(`${API}/api/v1/public/signup`, { credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((o) => {
      if (!o) return;
      Object.assign(opts, { open: o.open, trialDays: o.trialDays, depositCents: o.depositCents });
      drawOptions();
      if (!o.open) {
        showNotice(`Online sign-up isn't open yet. Talk to us and we'll set up your trial.`, 'warning');
        submit.disabled = true;
      }
    })
    .catch(() => { /* the POST reports problems */ });

  // ---- validation (the server checks the same things) ----
  function showNotice(text, tone) {
    notice.textContent = text;
    notice.className = `su-notice ${tone}`;
    notice.hidden = false;
  }
  function setError(key, message) {
    const input = key === 'plan' ? null : fields[key];
    const box = $(`su-${key === 'companyName' ? 'company' : key === 'acceptTerms' ? 'terms' : key}-err`);
    if (input) input.setAttribute('aria-invalid', message ? 'true' : 'false');
    if (!box) return;
    box.textContent = message || '';
    box.hidden = !message;
  }
  function clearErrors() {
    for (const k of [...Object.keys(fields), 'plan']) setError(k, '');
    errorsBox.hidden = true;
    errorsBox.querySelector('ul').replaceChildren();
  }
  function showErrors(list) {
    for (const [k, m] of list) setError(k, m);
    const ul = errorsBox.querySelector('ul');
    ul.replaceChildren(...list.map(([k, m]) => {
      const target = k === 'plan' ? `su-plan-${planValue() || 'pro'}` : fields[k]?.id;
      const a = el('a', { href: `#${target}` }, `${labels[k] || k}: ${m}`);
      a.addEventListener('click', (e) => { e.preventDefault(); $(target)?.focus(); });
      return el('li', {}, a);
    }));
    errorsBox.hidden = false;
    errorsBox.focus();
  }

  function values() {
    return {
      companyName: fields.companyName.value.trim(), province: fields.province.value, name: fields.name.value.trim(),
      email: fields.email.value.trim(), password: fields.password.value, plan: planValue(),
      users: Number.parseInt(fields.users.value, 10), acceptTerms: fields.acceptTerms.checked,
      website: form.elements.website.value,
    };
  }

  function check(v) {
    const errs = [];
    if (!v.companyName) errs.push(['companyName', 'Enter your company name.']);
    if (!v.province) errs.push(['province', 'Choose your province or territory.']);
    if (!v.name) errs.push(['name', 'Enter your name.']);
    if (!EMAIL_RE.test(v.email)) errs.push(['email', 'Enter an email address like you@company.ca.']);
    if (v.password.length < 12) errs.push(['password', 'Use at least 12 characters.']);
    else if (v.password.toLowerCase() === v.email.toLowerCase()) errs.push(['password', 'The password cannot be your email address.']);
    else if (/^(.)\1+$/.test(v.password)) errs.push(['password', 'The password cannot be one repeated character.']);
    if (!SELF_SERVE.includes(v.plan)) errs.push(['plan', 'Pick a plan.']);
    if (!Number.isInteger(v.users) || v.users < 1 || v.users > 500) errs.push(['users', 'Enter a number from 1 to 500.']);
    if (!v.acceptTerms) errs.push(['acceptTerms', 'Please accept the terms and privacy policy.']);
    return errs;
  }

  const FIELD_BY_PATH = { '/companyName': 'companyName', '/province': 'province', '/name': 'name', '/email': 'email', '/password': 'password', '/plan': 'plan', '/users': 'users', '/acceptTerms': 'acceptTerms' };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors();
    notice.hidden = true;
    const v = values();
    const errs = check(v);
    if (errs.length) { showErrors(errs); return; }
    submit.disabled = true;
    submit.textContent = 'Opening secure checkout…';
    try {
      const res = await fetch(`${API}/api/v1/public/signup`, {
        method: 'POST', credentials: 'omit', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Fishtape': '1' },
        body: JSON.stringify(v),
      });
      const body = await res.json().catch(() => null);
      if (res.status === 201 && typeof body?.url === 'string' && /^https:\/\/|^\/|^http:\/\/(localhost|127\.0\.0\.1)/.test(body.url)) {
        draft.save(v);
        location.assign(body.url);
        return; // the button stays busy while the browser leaves
      }
      const err = body?.error || {};
      const path = err.details?.errors?.[0]?.path;
      if (err.code === 'email_in_use') {
        showErrors([['email', 'An account already uses this email. Sign in instead, or use another email.']]);
      } else if (err.code === 'weak_password') {
        showErrors([['password', err.message || 'Choose a stronger password.']]);
      } else if (err.code === 'validation_failed' && FIELD_BY_PATH[path]) {
        showErrors([[FIELD_BY_PATH[path], err.message && err.message !== 'The request is not valid.' ? err.message : 'Check this field.']]);
      } else if (err.code === 'rate_limited') {
        showNotice('Too many tries from here. Please wait an hour, or contact us.', 'danger');
      } else if (err.code === 'signup_pending' || err.code === 'signup_unavailable') {
        showNotice(err.message, 'warning');
      } else {
        showNotice('Something went wrong. Please try again in a moment.', 'danger');
      }
    } catch {
      showNotice(`We couldn't reach ${BRAND.name}. Check your connection and try again.`, 'danger');
    }
    submit.disabled = false;
    submit.textContent = 'Continue to payment';
  });
}
