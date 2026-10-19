// Integrations (#/integrations): each company connects its own Stripe, Resend, Twilio,
// Facebook Lead Ads and Anthropic accounts. Keys are typed once, sent to the server and
// never shown again (cards show hints like …abcd). Every card has a connection test, a
// setup guide (guides/<provider>.md, rendered by lib/markdown.js) and the "we set it up for
// you" offer. Plans: locked cards show which plan includes them.
//
// Also exported for other screens: invoiceOnlineTools (Pay online / Email on an invoice),
// payLinkBlock (the pay link on the printed invoice) and emailDocAction (Email in the
// invoice/estimate preview). They render nothing when the server or the feature is not there.
import * as UI from '../ui.js';
import { renderMarkdown } from '../lib/markdown.js';
import { PLANS, monthlyCents } from '../plans.js';
import { API_BASE, authInit } from '../session.js';

const PLUG = '<path d="M9 2v5M15 2v5"/><path d="M6 7h12v4a6 6 0 01-12 0z"/><path d="M12 17v5"/>';
const ICONS = { stripe: 'dollar', resend: 'mail', twilio: 'phone', facebook: 'funnel', anthropic: 'zap' };
const GUIDE_LABEL = { stripe: 'Stripe', resend: 'Resend (email)', twilio: 'Twilio (texts)', facebook: 'Facebook Lead Ads', anthropic: 'Anthropic (Claude)' };
// VERIFY with Kelvin: where "Ask us to set this up" requests should go.
export const SETUP_EMAIL = 'setup@fishtapehq.com';

const WEBHOOK_HINT = {
  stripe: 'Stripe > Developers > Webhooks > Add destination. Events: checkout.session.completed, checkout.session.async_payment_succeeded.',
  twilio: 'Twilio > Phone Numbers > your number > Messaging > "A message comes in" (HTTP POST). Used for STOP and START replies.',
  facebook: 'Meta app > Webhooks > Page > Callback URL, with the verify token below. Subscribe to the leadgen field.',
};

// ---- API -----------------------------------------------------------------------

/** Call the Fishtape API: same origin with the session cookie (the iOS app: its API origin and Keychain token). Throws Error with .status and .code. */
export async function api(path, { method = 'GET', body } = {}) {
  const { headers, credentials } = await authInit(
    { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-fishtape': '1' } : {}) },
    { webCredentials: 'same-origin' });
  let res;
  try {
    res = await fetch(`${API_BASE}/api/v1${path}`, {
      method, credentials, cache: 'no-store', headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw Object.assign(new Error('Could not reach the server. Check your connection.'), { status: 0, code: 'offline' });
  }
  let json = null;
  try { json = res.status === 204 ? null : await res.json(); } catch { json = null; }
  if (!res.ok) throw Object.assign(new Error(json?.error?.message || `The server answered ${res.status}.`), { status: res.status, code: json?.error?.code || null, details: json?.error?.details });
  return json;
}

let availability = null;
/** { payments, email, sms } for this company, or null when the server can't be asked (offline, signed out). Cached for a minute. */
export function available(force = false) {
  if (!force && availability && Date.now() - availability.at < 60_000) return availability.p;
  const p = api('/integrations/available').catch(() => null);
  availability = { at: Date.now(), p };
  return p;
}

// ---- setup guides ----------------------------------------------------------------

export function openGuide(provider, vars = {}) {
  const { h } = UI;
  const host = h('div', { class: 'int-guide', 'aria-live': 'polite' }, h('p', { class: 'muted' }, 'Loading the guide…'));
  const s = UI.openSheet({ title: `${GUIDE_LABEL[provider] || provider} setup guide`, wide: true, body: host,
    actions: [h('span', { class: 'grow' }), UI.button('Close', { variant: 'primary', onClick: () => s.close() })] });
  const url = new URL(`guides/${provider}.md`, document.baseURI);
  fetch(url, { cache: 'no-cache' }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status))))).then((text) => {
    // renderMarkdown escapes every piece of text and emits only a fixed set of tags and safe URLs.
    host.innerHTML = renderMarkdown(text, { base: url.href, origin: location.origin, vars });
    for (const a of host.querySelectorAll('a[href^="#/"]')) a.addEventListener('click', () => s.close());
  }).catch(() => {
    UI.clear(host).append(UI.empty({ icon: 'alert', title: 'The guide could not be loaded', text: 'Check your connection and try again.' }));
  });
  return s;
}

const setupHref = (label, company) => `mailto:${SETUP_EMAIL}?subject=${encodeURIComponent(`Please set up ${label} for ${company || 'my company'}`)}&body=${encodeURIComponent(`Hi, we'd like help connecting ${label} to Fishtape.\n\nCompany: ${company || ''}\nBest time to reach me: `)}`;

function upgradeHref() {
  const ids = (globalThis.kelbe?.MODULES || []).map((m) => m.id);
  const id = ['billing', 'plan', 'account'].find((x) => ids.includes(x));
  return id ? `#/${id}` : `mailto:${SETUP_EMAIL}?subject=${encodeURIComponent('Upgrade my Fishtape plan')}`;
}

function randomToken() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); UI.toast('Copied', 'success'); } catch { UI.toast('Copy blocked by the browser. Select the text and copy it.', 'error', 4000); }
}

// ---- the screen ---------------------------------------------------------------------

function statusBadge(c) {
  if (!c.entitled) return UI.badge(`${c.planName || 'Upgrade'} plan`, 'neutral');
  if (c.status === 'not_connected') return UI.badge('Not connected', 'neutral');
  if (c.status === 'incomplete') return UI.badge('Incomplete', 'warning');
  if (c.status === 'error') return UI.badge('Error', 'danger');
  if (c.check.status === 'warning') return UI.badge('Check settings', 'warning');
  return UI.badge('Connected', 'success');
}

function connectedLine(c) {
  const key = c.fields.find((f) => f.set && !f.plain) || c.fields.find((f) => f.set);
  return key ? `${key.label} ${key.hint || ''}`.trim() : '';
}

function configFields(ctx, c) {
  const { h } = ctx.ui;
  if (c.provider === 'resend') {
    return [ctx.ui.field({ label: 'Reply-to address', name: 'config.replyTo', type: 'email', value: c.config.replyTo || '', hint: 'Replies go here. Blank uses the company email in Settings.' })];
  }
  if (c.provider === 'facebook') {
    const seqs = ctx.store.list('sequences').sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return [
      ctx.ui.field({ label: 'Facebook Page ID', name: 'config.pageId', value: c.config.pageId || '', placeholder: 'filled in by Test connection', hint: 'Only leads from this Page are imported.' }),
      ctx.ui.field({ label: 'Enrol new leads in', name: 'config.sequenceId', type: 'select', value: c.config.sequenceId || '',
        options: [{ value: '', label: '— no sequence —' }, ...seqs.map((s) => ({ value: s.id, label: `${s.name}${s.active ? '' : ' (paused)'}` }))],
        hint: 'The first step goes out within seconds of the lead arriving.' }),
      h('span'),
    ];
  }
  return [];
}

function cardView(ctx, c, refresh) {
  const { ui } = ctx;
  const { h } = ui;
  const company = ctx.store.settings().company?.name || '';
  const vars = { webhook_url: c.webhookUrl || '' };
  const guideBtn = ui.button('Setup guide', { size: 'sm', icon: 'book', onClick: () => openGuide(c.provider, vars) });
  const askBtn = ui.button('Ask us to set this up', { size: 'sm', variant: 'ghost', icon: 'wrench', href: setupHref(c.label, company) });
  const head = h('header', { class: 'int-head' },
    h('span', { class: 'int-logo', 'aria-hidden': 'true' }, ui.icon(ICONS[c.provider], 22)),
    h('div', { class: 'grow' }, h('h3', null, c.label), c.status !== 'not_connected' && c.entitled ? h('div', { class: 'muted int-sub mono' }, connectedLine(c)) : null),
    statusBadge(c));

  if (!c.entitled) {
    const price = monthlyCents(c.plan);
    const anySet = c.fields.some((f) => f.set);
    return h('article', { class: 'card int-card int-locked', dataset: { provider: c.provider } }, head,
      h('p', { class: 'int-blurb' }, c.blurb),
      h('div', { class: 'int-lock-note' }, ui.icon('lock', 16), h('span', null,
        `Included in the ${c.planName || 'next'} plan${price != null ? ` (from ${ui.fmtMoney(price, { whole: true })}/month)` : ''}.${PLANS[ctx.plan] ? ` You are on ${PLANS[ctx.plan].name}.` : ''}`)),
      h('footer', { class: 'int-foot' }, guideBtn, h('span', { class: 'grow' }),
        anySet ? ui.button('Remove saved keys', { size: 'sm', variant: 'ghost danger', onClick: () => disconnect(ctx, c, refresh) }) : null,
        ui.button(`Upgrade to ${c.planName || 'unlock'}`, { size: 'sm', variant: 'primary', icon: 'unlock', href: upgradeHref() })));
  }

  const inputs = c.fields.map((f) => {
    const input = h('input', {
      name: f.name, type: f.plain ? 'text' : 'password', autocomplete: f.plain ? 'off' : 'new-password', spellcheck: 'false', autocapitalize: 'off',
      value: f.plain && f.set ? f.hint || '' : '', placeholder: f.set && !f.plain ? `Saved ${f.hint || ''}. Leave blank to keep it.` : f.placeholder,
      'aria-label': f.label,
    });
    const extra = f.name === 'facebook.verify_token'
      ? ui.button('Generate', { size: 'sm', variant: 'ghost', onClick: () => { input.type = 'text'; input.value = randomToken(); input.select(); ui.toast('Copy it into Meta before you save. It is not shown again.', 'info', 4000); } })
      : null;
    return h('label', { class: 'field' }, h('span', null, f.label, f.required ? ' *' : ''),
      extra ? h('div', { class: 'int-inline' }, input, extra) : input,
      f.set && f.valid === false ? h('span', { class: 'hint int-bad' }, 'The saved value cannot be read. Enter it again.') : null);
  });
  const form = h('form', { class: 'form-grid int-form', autocomplete: 'off', onSubmit: (e) => { e.preventDefault(); save(); } },
    inputs, configFields(ctx, c), h('button', { type: 'submit', hidden: true }));

  const result = h('div', { class: 'int-result', role: 'status' });
  const showResult = (status, message) => {
    ui.clear(result);
    if (!message) return;
    result.className = `int-result ${status}`;
    result.append(ui.icon(status === 'ok' ? 'check' : status === 'warning' ? 'info' : 'alert', 16), h('span', null, message));
  };
  if (c.status === 'error' || c.status === 'incomplete') showResult(c.status === 'error' ? 'error' : 'warning', c.message);
  else if (c.check.message) showResult(c.check.status, c.check.message);

  const webhook = c.webhookUrl ? h('div', { class: 'int-webhook' },
    h('span', { class: 'int-label' }, c.provider === 'facebook' ? 'Callback URL' : 'Webhook URL'),
    h('div', { class: 'int-inline' },
      h('input', { class: 'input mono', readonly: true, value: c.webhookUrl, 'aria-label': `${c.label} webhook URL`, onFocus: (e) => e.target.select() }),
      ui.button('Copy', { size: 'sm', icon: 'copy', onClick: () => copy(c.webhookUrl) })),
    h('span', { class: 'hint muted' }, WEBHOOK_HINT[c.provider] || ''),
    c.lastEventAt ? h('span', { class: 'hint muted' }, `Last event received ${ui.fmtDateTime(c.lastEventAt)}`) : null) : null;

  const busy = (btn, on) => { btn.disabled = on; btn.classList.toggle('int-busy', on); };
  const saveBtn = ui.button('Save', { size: 'sm', variant: 'primary', icon: 'save', onClick: () => save() });
  const testBtn = ui.button('Test connection', { size: 'sm', icon: 'activity', disabled: c.status === 'not_connected' || c.status === 'incomplete', onClick: () => test() });
  const anySet = c.fields.some((f) => f.set);

  async function save() {
    const v = ui.readForm(form);
    const secrets = {};
    const config = {};
    for (const [k, val] of Object.entries(v)) {
      const text = String(val ?? '').trim();
      if (k.startsWith('config.')) { config[k.slice(7)] = text || null; continue; }
      const f = c.fields.find((x) => x.name === k);
      // Secret fields start empty (blank keeps the saved key); plain fields show their value.
      if (text && !(f?.plain && text === f.hint)) secrets[k] = text;
    }
    const changedConfig = Object.fromEntries(Object.entries(config).filter(([k, val]) => (val || '') !== (c.config[k] || '')));
    if (!Object.keys(secrets).length && !Object.keys(changedConfig).length) return ui.toast('Nothing changed', 'info');
    busy(saveBtn, true);
    try {
      const next = await api(`/integrations/${c.provider}`, { method: 'PUT', body: { ...(Object.keys(secrets).length ? { secrets } : {}), ...(Object.keys(changedConfig).length ? { config: changedConfig } : {}) } });
      ui.toast(`${c.label} saved`, 'success');
      if (next.status === 'connected' && Object.keys(secrets).length) {
        await refresh(c.provider);
        return runTest(next);
      }
      await refresh(c.provider);
    } catch (e) {
      busy(saveBtn, false);
      showResult('error', e.message);
    }
  }

  async function runTest(card) {
    try {
      const r = await api(`/integrations/${card.provider}/test`, { method: 'POST' });
      ui.toast(`${card.label}: ${r.message}`, r.status === 'ok' ? 'success' : r.status === 'warning' ? 'info' : 'error', 4500);
    } catch (e) {
      ui.toast(e.message, 'error', 4500);
    }
    await refresh(card.provider);
  }

  async function test() {
    busy(testBtn, true);
    showResult('warning', 'Testing…');
    await runTest(c);
  }

  const subscribeBtn = c.provider === 'facebook' && (c.status === 'connected' || c.status === 'error') ? ui.button('Subscribe Page', { size: 'sm', icon: 'link', onClick: async () => {
    busy(subscribeBtn, true);
    try {
      const r = await api('/integrations/facebook/subscribe', { method: 'POST' });
      ui.toast(r.message, r.ok ? 'success' : 'error', 4500);
    } catch (e) { ui.toast(e.message, 'error', 4500); }
    await refresh(c.provider);
  } }) : null;

  return h('article', { class: ['card', 'int-card', `int-${c.status}`], dataset: { provider: c.provider } }, head,
    h('p', { class: 'int-blurb' }, c.blurb),
    form, webhook, result,
    h('footer', { class: 'int-foot' }, guideBtn, askBtn, h('span', { class: 'grow' }),
      anySet ? ui.button('Disconnect', { size: 'sm', variant: 'ghost danger', onClick: () => disconnect(ctx, c, refresh) }) : null,
      subscribeBtn, testBtn, saveBtn));
}

async function disconnect(ctx, c, refresh) {
  if (!(await ctx.ui.confirmDialog(`Disconnect ${c.label}? Its saved keys are deleted from ${ctx.store.settings().company?.name || 'your company'} and anything that uses it stops.`, { okLabel: 'Disconnect' }))) return;
  try {
    await api(`/integrations/${c.provider}`, { method: 'DELETE' });
    ctx.ui.toast(`${c.label} disconnected`, 'success');
  } catch (e) { ctx.ui.toast(e.message, 'error'); }
  await refresh(c.provider);
}

function problemState(ctx, e) {
  const { ui } = ctx;
  const { h } = ui;
  const guides = h('div', { class: 'row int-guides' }, Object.keys(GUIDE_LABEL).map((p) => ui.button(GUIDE_LABEL[p], { size: 'sm', icon: 'book', onClick: () => openGuide(p) })));
  let title = 'Integrations are not available';
  let text = e.message;
  if (e.code === 'offline') { title = 'You are offline'; text = 'Connecting accounts needs the internet. The setup guides below still open.'; }
  else if (e.status === 401 || e.code === 'unauthenticated' || e.code === 'session_expired') { title = 'Sign in to your Fishtape account'; text = 'Integrations are saved on the server for your company. Sign in, then come back here.'; }
  else if (e.code === 'mfa_required' || e.code === 'mfa_enrolment_required') { title = 'Finish two-step sign-in first'; text = 'Owners and admins need an authenticator app before they can manage integrations.'; }
  else if (e.status === 403) { title = 'Owners and admins only'; text = 'Ask an owner or admin of your company to connect integrations.'; }
  else if (e.status === 404) { title = 'This server does not have integrations yet'; text = 'The setup guides below still open.'; }
  return h('div', { class: 'stack' }, ui.empty({ icon: 'lock', title, text }), h('h2', { class: 'section' }, 'Setup guides'), guides);
}

export default {
  id: 'integrations',
  title: 'Integrations',
  icon: PLUG,
  group: 'admin',
  perm: 'settings',
  render(root, ctx) {
    const { ui } = ctx;
    const { h } = ui;
    const grid = h('div', { class: 'int-grid', 'aria-busy': 'true' }, h('p', { class: 'muted' }, 'Loading your integrations…'));
    const company = ctx.store.settings().company?.name || '';
    root.append(ui.page({
      title: 'Integrations',
      subtitle: 'Connect your own payment, email, text, lead and AI accounts',
      actions: [ui.button('Ask us to set it up', { icon: 'wrench', href: setupHref('my integrations', company) })],
    },
    h('div', { class: 'card flat int-intro' }, ui.icon('shield-check', 20),
      h('p', null, 'Each account is yours: payments go to your Stripe, emails come from your address, texts from your number. Keys are encrypted on the server and never shown again after you save them. Each card has a step-by-step guide, or we can set everything up for you.')),
    grid));

    let cards = [];
    let alive = true;
    const draw = () => {
      ui.clear(grid);
      grid.removeAttribute('aria-busy');
      for (const c of cards) grid.append(cardView(ctx, c, refresh));
    };
    async function refresh() {
      try {
        const r = await api('/integrations');
        if (!alive) return;
        cards = r.data;
        ctx.plan = r.plan || null;
        available(true);
        draw();
      } catch (e) {
        if (!alive) return;
        ui.clear(grid).append(problemState(ctx, e));
        grid.removeAttribute('aria-busy');
      }
    }
    ctx.plan = null;
    refresh();
    return () => { alive = false; };
  },
};

// ---- hooks for invoices, estimates and the printout ---------------------------------

/** "Pay online" and "Email invoice" for the invoice status card. */
export function invoiceOnlineTools(ctx, inv, balanceCents) {
  const { ui, store } = ctx;
  const { h } = ui;
  const host = h('div', { class: 'int-doc-tools' });
  if (!inv || inv.status === 'void') return host;
  available().then((a) => {
    if (!a || !host.isConnected) return;
    const cur = store.get('invoices', inv.id) || inv;
    const link = cur.payLink?.url;
    h(host, null,
      a.payments && balanceCents > 0 ? h('div', { class: 'row' },
        ui.button(link ? 'Pay link' : 'Pay online', { size: 'sm', icon: 'link', onClick: () => payOnline(ctx, inv.id) }),
        link ? ui.button('', { size: 'sm', variant: 'ghost', icon: 'copy', title: 'Copy pay link', onClick: () => copy(link) }) : null) : null,
      a.email ? ui.button('Email invoice', { size: 'sm', icon: 'mail', onClick: () => emailDocument('invoices', cur, store) }) : null);
  });
  return host;
}

async function payOnline(ctx, invoiceId) {
  const { ui, store } = ctx;
  const { h } = ui;
  let r;
  try {
    r = await api('/integrations/stripe/pay-link', { method: 'POST', body: { invoiceId } });
  } catch (e) {
    return ui.toast(e.status === 404 ? 'This invoice is not on the server yet. Let it sync, then try again.' : e.message, 'error', 5000);
  }
  if (store.get('invoices', invoiceId)) store.update('invoices', invoiceId, { payLink: { url: r.payUrl, createdAt: new Date().toISOString() } }, { summary: 'Pay link created' });
  const s = ui.openSheet({
    title: 'Pay online', dialog: true,
    body: h('div', { class: 'stack' },
      h('p', { style: { margin: 0 } }, `Your customer pays ${ui.fmtMoney(r.amountCents)} by card through Stripe. The payment is recorded on this invoice automatically.`),
      h('div', { class: 'int-inline' }, h('input', { class: 'input mono', readonly: true, value: r.payUrl, 'aria-label': 'Pay link', onFocus: (e) => e.target.select() }),
        ui.button('Copy', { size: 'sm', icon: 'copy', onClick: () => copy(r.payUrl) })),
      h('p', { class: 'muted', style: { margin: 0 } }, 'This link is printed on the invoice. It keeps working and always asks for the balance owing at the time.')),
    actions: [ui.button('Close', { variant: 'ghost', onClick: () => s.close() }), h('span', { class: 'grow' }),
      h('a', { class: 'btn primary', href: r.checkoutUrl, target: '_blank', rel: 'noopener noreferrer' }, ui.icon('dollar', 18), h('span', null, 'Open payment page'))],
  });
}

function emailDocument(collection, doc, store) {
  const client = doc.clientId ? store.get('clients', doc.clientId) : null;
  const what = collection === 'invoices' ? 'invoice' : 'estimate';
  UI.formSheet({
    title: `Email ${what} ${doc.number || ''}`.trim(),
    submitLabel: 'Send',
    fields: [
      { label: 'To', name: 'to', type: 'email', value: client?.email || '', required: true, span: true },
      { label: 'Message (optional)', name: 'message', type: 'textarea', rows: 3, span: true, placeholder: `Here is ${what} ${doc.number || ''}…` },
    ],
    onSubmit: (v) => {
      api('/integrations/email/document', { method: 'POST', body: { collection, id: doc.id, to: v.to, ...(v.message?.trim() ? { message: v.message.trim() } : {}) } })
        .then(() => {
          UI.toast(`Sending ${what} to ${v.to}`, 'success');
          if (doc.status === 'draft' && store.get(collection, doc.id)?.status === 'draft') store.update(collection, doc.id, { status: 'sent' }, { summary: `${doc.number} emailed` });
        })
        .catch((e) => UI.toast(e.status === 404 ? `This ${what} is not on the server yet. Let it sync, then try again.` : e.message, 'error', 5000));
    },
  });
}

/** "Email" in the invoice/estimate preview (lib/doc-view.js). An empty span until we know email is connected. */
export function emailDocAction(opts) {
  const host = UI.h('span', { class: 'int-doc-action' });
  const collection = opts.kind === 'Invoice' ? 'invoices' : opts.kind === 'Estimate' ? 'estimates' : null;
  if (!collection || !opts.doc?.id) return host;
  available().then((a) => {
    if (a?.email) host.append(UI.button('Email', { icon: 'mail', onClick: () => emailDocument(collection, opts.store.get(collection, opts.doc.id) || opts.doc, opts.store) }));
  });
  return host;
}

/** The pay link on the printed invoice, or null when there is nothing to pay or no link. */
export function payLinkBlock(store, invoiceId, balanceCents) {
  const url = store.get('invoices', invoiceId)?.payLink?.url;
  if (!url || !(balanceCents > 0)) return null;
  const { h } = UI;
  return h('section', { class: 'doc-notes int-paylink' }, h('div', { class: 'doc-label' }, 'Pay online'),
    h('p', null, 'Pay by card at ', h('a', { href: url, rel: 'noopener noreferrer' }, url)));
}
