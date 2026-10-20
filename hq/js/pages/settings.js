// Platform settings: support address, sender name and legal documents (editable by HQ
// admins, audited); everything from the environment shown read-only with where to change
// it; and checks for the Stripe account (which business it is, fishtape_* prices, webhook)
// and system email.
import { get, put } from '../api.js';
import { ago } from '../fmt.js';
import { banner, card, kv, loader } from '../kit.js';

export default {
  render(root, { ui, isAdmin }) {
    const { h } = ui;
    const body = h('div', { class: 'stack' });
    root.append(ui.page({ title: 'Settings', subtitle: 'Platform settings, Stripe and email' }, body));
    const stripeHost = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Checking Stripe…'));
    const emailHost = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Checking email…'));

    function editable(s) {
      const f = (label, name, value, extra = {}) => h('label', { class: ['field', extra.span ? 'span-2' : null] }, h('span', null, label),
        h('input', { name, value: value ?? '', disabled: !isAdmin, ...(extra.type ? { type: extra.type } : {}), ...(extra.placeholder ? { placeholder: extra.placeholder } : {}) }), extra.hint ? h('span', { class: 'hint' }, extra.hint) : null);
      const check = (label, name, checked) => h('label', { class: 'field check span-2' }, h('input', { type: 'checkbox', name, checked, disabled: !isAdmin }), h('span', null, label));
      const doc = (key, title) => {
        const d = s.legal[key];
        return h('fieldset', { class: 'hq-fieldset' }, h('legend', null, title),
          h('div', { class: 'form-grid' },
            f('Version', `${key}.version`, d.version, { hint: 'Change it when the text changes, e.g. 2026-11-01' }),
            f('Link', `${key}.url`, d.url, { hint: 'https://… or a path such as /site/terms.html' }),
            check('Everyone must accept this version again (asked in the app until they do)', `${key}.requireReacceptance`, d.requireReacceptance)),
          h('p', { class: 'muted hq-small', style: { margin: 0 } }, d.updatedAt ? `Changed ${ago(d.updatedAt)}` : 'Default from the code (signup.js TERMS_VERSION)'));
      };
      const form = h('form', { class: 'stack', onSubmit: async (e) => {
        e.preventDefault();
        const v = Object.fromEntries([...form.querySelectorAll('[name]')].map((el) => [el.name, el.type === 'checkbox' ? el.checked : el.value.trim()]));
        const legal = Object.fromEntries(['terms', 'privacy'].map((k) => [k, { version: v[`${k}.version`], url: v[`${k}.url`], requireReacceptance: v[`${k}.requireReacceptance`] }]));
        const asks = ['terms', 'privacy'].filter((k) => legal[k].requireReacceptance && (legal[k].version !== s.legal[k].version || !s.legal[k].requireReacceptance));
        if (asks.length && !(await ui.confirmDialog(`Every signed-in person will be asked to accept the new ${asks.join(' and ')} before they carry on.`, { title: 'Ask everyone to accept again?', okLabel: 'Save and ask', danger: false }))) return;
        try {
          const r = await put('/api/hq/settings', { support: { email: v.email, senderName: v.senderName }, legal });
          ui.toast(r.changed ? 'Settings saved (audited)' : 'Nothing changed', 'success');
          load();
        } catch (err) { ui.toast(err.details?.errors?.map((x) => `${x.path}: ${x.message}`).join('; ') || err.message, 'error', 6000); }
      } },
      h('fieldset', { class: 'hq-fieldset' }, h('legend', null, 'Support'),
        h('div', { class: 'form-grid' },
          f('Support email', 'email', s.support.email, { type: 'email', hint: 'Shown in the app\'s Help center' }),
          f('Sender name', 'senderName', s.support.senderName, { hint: 'For support replies' }))),
      doc('terms', 'Terms of service'), doc('privacy', 'Privacy policy'),
      isAdmin ? h('div', { class: 'row' }, h('span', { class: 'grow' }), ui.button('Save settings', { variant: 'primary', type: 'submit', icon: 'save' })) : h('p', { class: 'muted hq-small' }, 'HQ admins change these.'));
      return form;
    }

    async function checkStripe() {
      ui.clear(stripeHost);
      stripeHost.append(h('p', { class: 'muted' }, 'Checking Stripe…'));
      try {
        const s = await get('/api/hq/settings/stripe');
        ui.clear(stripeHost);
        if (s.problems.length) stripeHost.append(h('div', { class: 'hq-banner degraded' }, ui.icon('alert', 20), h('div', null, h('strong', null, 'Needs attention'), h('ul', null, s.problems.map((p) => h('li', null, p))))));
        else stripeHost.append(banner(ui, 'ok', 'Stripe is ready for Fishtape'));
        stripeHost.append(kv(ui, [
          ['Account', s.account ? h('span', null, h('strong', null, s.account.name || 'unnamed'), ` · ${s.account.id} · ${s.account.country || ''}`) : '—'],
          ['Key mode', s.mode ? ui.badge(s.mode, s.mode === 'live' ? 'success' : 'info') : 'not set'],
          ['Charges', s.account ? (s.account.chargesEnabled ? ui.badge('enabled', 'success') : ui.badge('disabled', 'danger')) : '—'],
          ['Webhook endpoint', s.webhook.endpoint ? h('span', null, ui.badge(s.webhook.endpoint.status, s.webhook.endpoint.status === 'enabled' ? 'success' : 'danger'), ' ', h('span', { class: 'mono hq-small' }, s.webhook.endpoint.url)) : ui.badge('missing', 'danger')],
          ['Signing secret', s.webhook.secretSet ? ui.badge('set', 'success') : ui.badge('not set', 'danger')],
          ['Events received', `${s.webhook.eventsLast7Days} in 7 days${s.webhook.lastEventAt ? `, last ${ago(s.webhook.lastEventAt)}` : ''}${s.webhook.unknownCustomerLast7Days ? ` · ${s.webhook.unknownCustomerLast7Days} for unknown customers` : ''}`],
        ]));
        if (s.prices.length) {
          stripeHost.append(ui.table({
            columns: [
              { key: 'label', label: 'Price', render: (p) => h('div', null, p.label, h('div', { class: 'mono hq-small muted' }, p.key)) },
              { key: 'amount', label: 'On Stripe', align: 'right', render: (p) => (p.amountCents == null ? '—' : ui.fmtMoney(p.amountCents)) },
              { key: 'want', label: 'plans.js', align: 'right', render: (p) => ui.fmtMoney(p.expectedCents) },
              { key: 'ok', label: '', render: (p) => (p.ok ? ui.badge('OK', 'success') : ui.badge(p.found ? (p.active ? 'differs' : 'archived') : 'missing', 'danger')) },
            ],
            rows: s.prices,
          }));
        }
      } catch (e) { ui.clear(stripeHost); stripeHost.append(banner(ui, 'danger', 'Could not check Stripe', e.message)); }
    }

    async function checkEmail(live = false) {
      try {
        const m = await get(`/api/hq/settings/email${live ? '?live=true' : ''}`);
        ui.clear(emailHost);
        if (m.problems.length) emailHost.append(h('div', { class: 'hq-banner degraded' }, ui.icon('alert', 20), h('div', null, h('strong', null, 'Needs attention'), h('ul', null, m.problems.map((p) => h('li', null, p))))));
        if (m.live) emailHost.append(banner(ui, m.live.status === 'ok' ? 'ok' : m.live.status === 'warning' ? 'degraded' : 'danger', `Resend: ${m.live.status}`, m.live.message));
        emailHost.append(kv(ui, [
          ['Provider', m.provider], ['Key', m.keySet ? ui.badge('set', 'success') : ui.badge('not set', 'danger')], ['From', m.from || '—'],
          ['Waiting', `${m.outbox.queued}${m.outbox.oldestQueuedAt ? ` (oldest ${ago(m.outbox.oldestQueuedAt)})` : ''}`],
          ['Failed (7 d)', m.outbox.failedLast7Days ? ui.badge(String(m.outbox.failedLast7Days), 'danger') : '0'],
          ['Last sent', m.outbox.lastSentAt ? ago(m.outbox.lastSentAt) : 'never'],
        ]), h('div', { class: 'row' }, ui.button('Test connection', { size: 'sm', disabled: !m.keySet, onClick: () => checkEmail(true) })));
      } catch (e) { ui.clear(emailHost); emailHost.append(banner(ui, 'danger', 'Could not check email', e.message)); }
    }

    async function load() {
      const r = await get('/api/hq/settings');
      ui.clear(body);
      body.append(h('div', { class: 'grid-2 hq-settings' },
        h('div', null, ...ui.section('Editable', h('div', { class: 'card' }, editable(r.settings)))),
        h('div', null,
          ...ui.section('Stripe', h('div', { class: 'card stack' }, stripeHost, h('div', { class: 'row' }, ui.button('Check again', { size: 'sm', onClick: checkStripe })))),
          ...ui.section('System email', h('div', { class: 'card stack' }, emailHost)))));
      body.append(...ui.section('From the environment (read-only)', ui.table({
        columns: [
          { key: 'label', label: 'Setting', render: (e) => h('div', null, h('strong', null, e.label), h('div', { class: 'mono hq-small muted' }, e.key)) },
          { key: 'value', label: 'Value', render: (e) => (e.secret ? ui.badge(e.value, e.value.startsWith('set') ? 'success' : 'danger') : h('span', { class: 'hq-wrap' }, e.value)) },
          { key: 'where', label: 'Change it in', render: (e) => h('span', { class: 'hq-small muted' }, e.where) },
        ],
        rows: r.env,
      })));
      checkStripe();
      checkEmail();
    }

    loader(ui, body, load);
    return () => {};
  },
};
