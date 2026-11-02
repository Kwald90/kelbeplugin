// Platform keys: Fishtape's OWN SendGrid/Resend and Stripe keys, set by an HQ admin instead of only
// in the server .env. A key set here overrides the matching env var. The API never returns a secret
// value — only whether it's set and a short hint — so this page shows status, not the key itself.
import { get, put, del } from '../api.js';
import { ago } from '../fmt.js';
import { card, loader } from '../kit.js';

const ICON = { email: 'mail', sendgrid: 'mail', resend: 'mail', stripe: 'dollar' };

export default {
  render(root, { ui, isAdmin }) {
    const { h } = ui;
    const body = h('div', { class: 'stack' });
    root.append(ui.page({ title: 'Platform keys', subtitle: "Fishtape's own SendGrid and Stripe keys — not a company's" }, body));
    load();

    async function load() {
      await loader(ui, body, async () => {
        const { providers, keys } = await get('/api/hq/platform-keys');
        const frag = [h('p', { class: 'muted' },
          'These are Fishtape\'s own keys. A key set here overrides the server .env; remove it to fall back to the .env value. '
          + 'Email keys take effect within a minute; Stripe keys apply on the next deploy.')];
        if (!isAdmin) frag.push(h('p', { class: 'muted hq-small' }, 'HQ admins set these. You can see what is configured.'));
        for (const p of providers) {
          const rows = keys.filter((k) => k.provider === p.id);
          if (rows.length) frag.push(card(ui, p.label, ICON[p.id] || 'key', h('div', { class: 'stack' }, rows.map(keyRow))));
        }
        ui.clear(body);
        body.append(...frag);
      });
    }

    function keyRow(k) {
      const status = k.set
        ? h('span', null, ui.badge('set', 'success'), ' ', h('span', { class: 'mono hq-small' }, k.hint))
        : (k.envFallback
          ? h('span', null, ui.badge('from .env', 'info'), h('span', { class: 'hq-small muted' }, ' server environment'))
          : ui.badge('not set', 'danger'));
      const input = h('input', {
        type: k.plain ? 'text' : 'password', autocomplete: 'off', spellcheck: 'false',
        placeholder: k.hintNote || (k.plain ? '' : 'paste the value'),
      });
      if (k.plain && k.set) input.value = k.hint; // non-secret settings (provider, From) are shown in full
      const editor = h('div', { class: 'row', hidden: !isAdmin || (!k.plain && k.set) },
        input, ui.button('Save', { variant: 'primary', onClick: () => save(k, input) }));
      const controls = [];
      if (isAdmin && !k.plain && k.set) controls.push(ui.button('Replace', { onClick: () => { editor.hidden = false; input.focus(); } }));
      if (isAdmin && k.set) controls.push(ui.button('Remove', { variant: 'ghost', icon: 'trash', onClick: () => remove(k) }));
      return h('div', { class: 'hq-fieldset stack' },
        h('div', { class: 'row' }, h('strong', { class: 'grow' }, k.label), status),
        k.hintNote ? h('div', { class: 'muted hq-small' }, k.hintNote) : null,
        k.updatedAt ? h('div', { class: 'muted hq-small' }, `Set ${ago(k.updatedAt)}`) : null,
        editor,
        controls.length ? h('div', { class: 'row' }, ...controls) : null);
    }

    async function save(k, input) {
      const value = input.value.trim();
      if (!value) { ui.toast('Enter a value first', 'error'); return; }
      try {
        await put(`/api/hq/platform-keys/${encodeURIComponent(k.name)}`, { value });
        ui.toast(`${k.label} saved (audited)`, 'success');
        load();
      } catch (e) { ui.toast(e.message, 'error', 6000); }
    }

    async function remove(k) {
      if (!(await ui.confirmDialog(`Remove ${k.label}? The server .env value, if any, takes over.`, { title: 'Remove platform key?', okLabel: 'Remove', danger: true }))) return;
      try {
        await del(`/api/hq/platform-keys/${encodeURIComponent(k.name)}`);
        ui.toast(`${k.label} removed`, 'success');
        load();
      } catch (e) { ui.toast(e.message, 'error', 6000); }
    }

    return () => {};
  },
};
