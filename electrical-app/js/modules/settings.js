// Settings: company, defaults, numbering, theme, data backup/restore, about.
import { BRAND } from '../brand.js';
import { isBackupTag } from '../store.js';

export const APP_VERSION = '0.2.0';

const CURRENCIES = ['USD', 'CAD', 'AUD', 'GBP', 'EUR', 'NZD'];

export default {
  id: 'settings',
  title: 'Settings',
  icon: 'settings',
  group: 'admin',
  perm: 'settings',
  render(root, ctx) {
    const { store, ui } = ctx;
    const { h } = ui;
    const s = store.settings();

    const card = (title, sub, ...kids) => h('section', { class: 'card stack settings-card' }, h('div', null, h('h3', null, title), sub ? h('div', { class: 'muted' }, sub) : null), ...kids);
    const saveRow = (label, onClick) => h('div', { class: 'row' }, h('span', { class: 'grow' }), ui.button(label, { variant: 'primary', icon: 'save', onClick }));

    // company
    const company = h('form', { onSubmit: (e) => e.preventDefault() }, ui.formGrid([
      { label: 'Company name', name: 'name', value: s.company?.name, required: true, span: true },
      { label: 'Phone', name: 'phone', type: 'tel', value: s.company?.phone },
      { label: 'Email', name: 'email', type: 'email', value: s.company?.email },
      { label: 'Address', name: 'address', value: s.company?.address, span: true },
      { label: 'Contractor licence no.', name: 'licenceNo', value: s.company?.licenceNo },
    ]));
    const saveCompany = () => {
      if (!company.reportValidity()) return;
      store.saveSettings({ company: { ...store.settings().company, ...ui.readForm(company) } });
      ui.toast('Company details saved', 'success');
    };

    // defaults
    const defaults = h('form', { onSubmit: (e) => e.preventDefault() }, ui.formGrid([
      { label: 'Sales tax %', name: 'taxPct', type: 'number', step: '0.01', min: 0, value: s.taxPct },
      { label: 'Labour rate (per hour)', name: 'labourRateCents', type: 'money', value: s.labourRateCents },
      { label: 'Material markup %', name: 'markupPct', type: 'number', step: '0.1', min: 0, value: s.markupPct, hint: 'Used to suggest sell prices from cost' },
      { label: 'Currency', name: 'currency', type: 'select', value: s.currency, options: CURRENCIES },
      { label: 'Units', name: 'units', type: 'select', value: s.units, options: [{ value: 'imperial', label: 'Imperial (ft, AWG)' }, { value: 'metric', label: 'Metric (m, mm²)' }] },
    ]));
    const saveDefaults = () => {
      if (!defaults.reportValidity()) return;
      const v = ui.readForm(defaults);
      store.saveSettings({ taxPct: v.taxPct ?? 0, labourRateCents: v.labourRateCents, markupPct: v.markupPct ?? 0, currency: v.currency, units: v.units });
      ui.setCurrency(v.currency);
      ui.toast('Defaults saved', 'success');
    };

    // numbering
    const numbering = h('form', { onSubmit: (e) => e.preventDefault() }, ui.formGrid([
      { label: 'Next job number', name: 'job', type: 'number', min: 1, step: 1, value: s.nextNumbers?.job, hint: 'J-####' },
      { label: 'Next estimate number', name: 'estimate', type: 'number', min: 1, step: 1, value: s.nextNumbers?.estimate, hint: 'E-####' },
      { label: 'Next invoice number', name: 'invoice', type: 'number', min: 1, step: 1, value: s.nextNumbers?.invoice, hint: 'INV-####' },
    ]));
    const saveNumbering = () => {
      if (!numbering.reportValidity()) return;
      const v = ui.readForm(numbering);
      const cur = store.settings().nextNumbers || {};
      store.saveSettings({ nextNumbers: { job: v.job || cur.job, estimate: v.estimate || cur.estimate, invoice: v.invoice || cur.invoice } });
      ui.toast('Numbering saved', 'success');
    };

    // theme
    let theme = 'system';
    try { theme = localStorage.getItem('kc.theme') || 'system'; } catch { /* ignore */ }
    const themeHost = h('div');
    const drawTheme = () => {
      ui.clear(themeHost);
      themeHost.append(ui.tabs([{ id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }, { id: 'system', label: 'Match device' }], theme, (t) => {
        theme = t;
        try {
          if (t === 'system') { delete document.documentElement.dataset.theme; localStorage.removeItem('kc.theme'); }
          else { document.documentElement.dataset.theme = t; localStorage.setItem('kc.theme', t); }
        } catch { /* storage blocked: theme still applies for this session */ }
        drawTheme();
      }));
    };
    drawTheme();

    // data
    const exportBackup = () => {
      const dump = store.exportAll();
      ui.download(`kelbe-circuit-backup-${ui.today()}.json`, JSON.stringify(dump));
      const n = Object.values(dump.data).reduce((a, r) => a + r.length, 0);
      store.log('export', `Backup exported (${n} records)`);
      ui.toast('Backup downloaded', 'success');
    };
    const restore = async () => {
      const file = await ui.pickFile('application/json,.json');
      if (!file) return;
      let dump;
      try { dump = JSON.parse(await file.text()); } catch { return ui.toast('That file is not valid JSON', 'error'); }
      if (!isBackupTag(dump?.app)) return ui.toast(`Not a ${BRAND.name} backup file`, 'error');
      const ok = await ui.confirmDialog(`Replace everything on this device with the backup from ${ui.fmtDateTime(dump.exportedAt)}? Current data will be lost unless you exported it.`, { title: 'Restore backup', okLabel: 'Restore' });
      if (!ok) return;
      try {
        await store.importAll(dump);
        store.log('restore', `Backup restored from ${dump.exportedAt}`);
        ui.toast('Backup restored', 'success');
      } catch (e) { ui.toast(e.message, 'error'); }
    };
    const wipe = async () => {
      if (!(await ui.confirmDialog('Delete every client, job, drawing and record on this device?', { title: 'Wipe all data', okLabel: 'Continue' }))) return;
      if (!(await ui.confirmDialog('This cannot be undone. Export a backup first if you might need it. Wipe now and reload the demo data?', { title: 'Really wipe?', okLabel: 'Wipe everything' }))) return;
      await store.clearAll();
      try { localStorage.removeItem('kc.currentUser'); } catch { /* ignore */ }
      location.reload();
    };

    const counts = ['clients', 'jobs', 'drawings', 'estimates', 'invoices', 'employees', 'auditLog'].map((c) => `${store.count(c)} ${c === 'auditLog' ? 'log entries' : c}`).join(' · ');
    const storageStatus = store.offlineOnly
      ? ui.badge('Memory only: data is lost on reload', 'danger')
      : store.persistent ? ui.badge('Persistent storage', 'success') : ui.badge('Browser may clear data when low on space', 'warning');

    root.append(ui.page({ title: 'Settings', subtitle: s.company?.name },
      h('div', { class: 'grid-2 settings-grid' },
        card('Company', 'Shown on estimates, invoices and printouts', company, saveRow('Save company', saveCompany)),
        card('Defaults', 'Applied to new estimates and invoices', defaults, saveRow('Save defaults', saveDefaults)),
        card('Document numbering', 'The next number each new document gets', numbering, saveRow('Save numbering', saveNumbering)),
        card('Appearance', null, themeHost),
        card('Data', 'Everything lives on this device. Export a backup regularly.',
          h('div', { class: 'row' }, storageStatus), h('div', { class: 'muted' }, counts),
          h('div', { class: 'row' },
            ui.button('Export backup', { icon: 'download', onClick: exportBackup }),
            ui.button('Restore from file', { icon: 'upload', onClick: restore })),
          h('hr', { class: 'hr' }),
          h('div', { class: 'row' }, h('div', { class: 'grow' }, h('strong', null, 'Wipe all data'), h('div', { class: 'muted' }, 'Clears this device and reloads the demo data.')),
            ui.button('Wipe…', { variant: 'danger', icon: 'trash', onClick: wipe }))),
        card('About', null,
          h('div', null, h('strong', null, BRAND.name), ` v${APP_VERSION}`),
          h('p', { class: 'muted', style: { margin: 0 } }, 'An electrical CRM/ERP with an infinite-canvas plan workspace. Built with the replica skill workflow: recon, architecture, design tokens, then a screen-by-screen build.'),
          h('p', { class: 'muted', style: { margin: 0 } }, 'Calculators and code checklists are estimating aids. Always verify against the code in force where you work and the authority having jurisdiction.')),
      )));
  },
};
