// Feature flags: platform-wide switches (signup_open) and per-company flags.
import { get, put } from '../api.js';
import { ago } from '../fmt.js';

export default {
  render(root, { ui, isAdmin }) {
    const { h } = ui;
    const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading…'));
    root.append(ui.page({
      title: 'Feature flags', subtitle: 'Changes take effect immediately and are audited',
      actions: isAdmin ? [ui.button('New flag', { icon: 'plus', onClick: addFlag })] : [],
    }, body));

    async function setFlag(f, enabled) {
      try {
        await put(`/api/hq/flags/${encodeURIComponent(f.key)}`, { enabled, ...(f.tenantId ? { tenantId: f.tenantId } : {}) });
        ui.toast(`${f.key} ${enabled ? 'on' : 'off'}`, 'success');
      } catch (e) { ui.toast(e.message, 'error'); }
      load();
    }

    async function load() {
      let r;
      try { r = await get('/api/hq/flags'); } catch (e) { ui.clear(body); body.append(ui.empty({ icon: 'alert', title: 'Could not load', text: e.message })); return; }
      ui.clear(body);
      body.append(ui.table({
        columns: [
          { key: 'key', label: 'Flag', render: (f) => h('div', null, h('strong', { class: 'mono' }, f.key), f.description ? h('div', { class: 'muted hq-small' }, f.description) : null) },
          { key: 'scope', label: 'Scope', render: (f) => (f.tenantId ? h('a', { href: `#/tenants/${f.tenantId}` }, f.tenantName || 'a company') : 'Platform-wide') },
          { key: 'updated', label: 'Changed', render: (f) => (f.updatedAt ? ago(f.updatedAt) : 'never') },
          { key: 'enabled', label: 'State', render: (f) => h('label', { class: 'field check' },
            h('input', { type: 'checkbox', checked: f.enabled, disabled: !isAdmin, 'aria-label': `${f.key} ${f.tenantName || 'platform'}`, onChange: (e) => setFlag(f, e.target.checked) }),
            h('span', null, f.enabled ? 'On' : 'Off')) },
        ],
        rows: r.data,
      }));
      if (!isAdmin) body.append(h('p', { class: 'muted hq-small' }, 'HQ admins change flags.'));
    }

    async function addFlag() {
      let tenants = [];
      try { tenants = (await get('/api/hq/tenants')).data; } catch { /* platform-wide only */ }
      ui.formSheet({
        title: 'New flag',
        fields: [
          { label: 'Key (a-z, 0-9, _)', name: 'key', required: true },
          { label: 'Scope', name: 'tenantId', type: 'select', options: [{ value: '', label: 'Platform-wide' }, ...tenants.map((t) => ({ value: t.id, label: t.name }))] },
          { label: 'On', name: 'enabled', type: 'checkbox', value: true },
        ],
        submitLabel: 'Save',
        onSubmit: (v) => {
          if (!/^[a-z0-9_]{1,64}$/.test(v.key)) { ui.toast('Use a-z, 0-9 and _ only', 'error'); return false; }
          setFlag({ key: v.key, tenantId: v.tenantId || null }, v.enabled);
        },
      });
    }

    load();
    return () => {};
  },
};
