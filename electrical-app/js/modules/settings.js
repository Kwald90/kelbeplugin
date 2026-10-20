// Settings: company, code book and units, sales tax, defaults, numbering,
// theme, data backup/restore, about.
import { BRAND } from '../brand.js';
import { isBackupTag } from '../store.js';
import { getUnits, setUnits, parseLength, fmtLength } from '../lib/units.js';
import { PROVINCES, TREATMENTS, treatmentsFor, treatmentHint, taxSetup, newDocTax, describeTaxes, ratesOn, provinceName, isGstHstNumber } from '../lib/tax.js';
import { adoptionFor, CODE_BOOKS } from '../lib/cec/provinces.js';
import { placementSettings } from '../lib/placement-rules.js';
import { logoField } from './onboarding.js';

export const APP_VERSION = '0.3.0';

const CURRENCIES = ['CAD', 'USD'];

const KIND_LABEL = { material: 'Materials', labour: 'Labour', other: 'Other' };

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
    const provinceOptions = PROVINCES.map((p) => ({ value: p.code, label: p.name }));

    // company
    const company = h('form', { onSubmit: (e) => e.preventDefault() }, ui.formGrid([
      { label: 'Company name', name: 'name', value: s.company?.name, required: true, span: true },
      { label: 'Phone', name: 'phone', type: 'tel', value: s.company?.phone },
      { label: 'Email', name: 'email', type: 'email', value: s.company?.email },
      { label: 'Address', name: 'address', value: s.company?.address, span: true },
      { label: 'Province / territory', name: 'province', type: 'select', value: s.company?.province || 'ON', options: provinceOptions, hint: 'Sets code amendments, permit authority and sales tax' },
      { label: 'Contractor licence no.', name: 'licenceNo', value: s.company?.licenceNo, hint: 'e.g. ECRA/ESA licence in Ontario' },
      { label: 'GST/HST registration no.', name: 'gstHstNo', value: s.company?.gstHstNo, placeholder: '123456789 RT0001', hint: 'Printed on invoices' },
      { label: 'PST / RST no.', name: 'pstNo', value: s.company?.pstNo, hint: 'BC PST-1234-5678, SK vendor’s licence, MB RST number' },
    ]));
    const saveCompany = () => {
      if (!company.reportValidity()) return;
      const v = ui.readForm(company);
      if (v.gstHstNo && !isGstHstNumber(v.gstHstNo)) ui.toast('That GST/HST number does not look like 123456789 RT0001. Saved anyway.', 'info', 4000);
      store.saveSettings({ company: { ...store.settings().company, ...v } });
      syncLegacyTax();
      ui.toast('Company details saved', 'success');
      drawCode(); drawTax();
    };

    // code book and units
    const codeHost = h('div', { class: 'stack' });
    const drawCode = () => {
      ui.clear(codeHost);
      const cur = store.settings();
      const prov = cur.company?.province || 'ON';
      const a = adoptionFor(prov);
      const form = h('form', { onSubmit: (e) => e.preventDefault() }, ui.formGrid([
        { label: 'Code book', name: 'codeBook', type: 'select', value: cur.codeBook || 'CEC-2024', options: CODE_BOOKS.map((b) => ({ value: b.id, label: b.label })), hint: 'Calculators, panels and checklists follow this book' },
        { label: 'Company default units', name: 'units', type: 'select', value: cur.units || 'metric', options: [{ value: 'metric', label: 'Metric (m, mm)' }, { value: 'imperial', label: 'Imperial (ft, in)' }], hint: 'For people who have not picked their own' },
      ]));
      form.addEventListener('change', () => {
        const v = ui.readForm(form);
        store.saveSettings({ codeBook: v.codeBook, units: v.units });
        ui.toast('Saved', 'success');
        drawCode();
      });
      let mine = getUnits(cur.units);
      const unitsTabs = h('div');
      const drawUnits = () => {
        ui.clear(unitsTabs);
        unitsTabs.append(ui.tabs([{ id: 'metric', label: 'Metric' }, { id: 'imperial', label: 'Imperial' }], mine, (u) => { setUnits(u); mine = u; drawUnits(); ui.toast(u === 'metric' ? 'Lengths in metres and millimetres' : 'Lengths in feet and inches', 'success'); }));
      };
      drawUnits();
      codeHost.append(form,
        h('div', { class: 'stack', style: { gap: 'var(--s2)' } }, h('strong', null, 'Your units'), h('div', { class: 'muted' }, 'Only for you, on this device. Stored values are always metric.'), unitsTabs),
        (cur.codeBook || 'CEC-2024') === 'CEC-2024' && a ? h('div', { class: 'muted' },
          `${provinceName(prov)}: ${a.inForce}${a.authority ? ` · inspections by ${a.authority.name}` : ''}.`) : null);
    };

    // sales tax
    const taxHost = h('div', { class: 'stack' });
    function syncLegacyTax() {
      // Older screens and records read a single taxPct; keep it equal to the combined default.
      store.saveSettings({ taxPct: newDocTax(store.settings()).taxPct });
    }
    const drawTax = () => {
      ui.clear(taxHost);
      const cur = store.settings();
      const setup = taxSetup(cur);
      const custom = [0, 1, 2].map((i) => setup.custom[i] || { label: '', pct: '', applies: { material: true, labour: true, other: true } });
      const form = h('form', { onSubmit: (e) => e.preventDefault() }, ui.formGrid([
        { label: 'Rates', name: 'mode', type: 'select', value: setup.mode, options: [{ value: 'province', label: `${provinceName(setup.province)} rates (recommended)` }, { value: 'custom', label: 'Custom rates' }] },
        setup.mode === 'province'
          ? { label: 'Default treatment', name: 'treatment', type: 'select', value: setup.treatment, options: treatmentsFor(setup.province).map((id) => ({ value: id, label: TREATMENTS[id].label })) }
          : h('div'),
      ]));
      const customRows = setup.mode === 'custom' ? h('div', { class: 'stack' },
        h('div', { class: 'muted' }, 'Up to three taxes. Tick the line types each one applies to.'),
        custom.map((c, i) => h('div', { class: 'form-grid' },
          ui.field({ label: `Tax ${i + 1} name`, name: `label${i}`, value: c.label, placeholder: i === 0 ? 'GST' : i === 1 ? 'PST' : '' }),
          ui.field({ label: 'Rate %', name: `pct${i}`, type: 'number', step: '0.001', min: 0, value: c.pct }),
          ...['material', 'labour', 'other'].map((k) => ui.field({ label: KIND_LABEL[k], name: `${k}${i}`, type: 'checkbox', value: c.applies?.[k] !== false }))))) : null;
      const preview = newDocTax(cur);
      const today = ratesOn(setup.province);
      const hint = treatmentHint(setup.treatment, setup.province);
      const save = () => {
        const v = ui.readForm(form);
        const patch = { mode: v.mode, treatment: v.treatment || setup.treatment, custom: setup.custom };
        if (customRows) {
          const cv = ui.readForm(customRows);
          patch.custom = [0, 1, 2].map((i) => ({ id: `T${i + 1}`, label: (cv[`label${i}`] || '').trim(), pct: Number(cv[`pct${i}`]) || 0,
            applies: { material: !!cv[`material${i}`], labour: !!cv[`labour${i}`], other: !!cv[`other${i}`] } })).filter((c) => c.label && c.pct > 0);
        }
        store.saveSettings({ tax: patch });
        syncLegacyTax();
        ui.toast('Tax set-up saved. New estimates and invoices use it; existing ones keep theirs.', 'success', 3600);
        drawTax();
      };
      form.addEventListener('change', (e) => { if (e.target.name === 'mode') save(); });
      taxHost.append(form, customRows || '',
        h('div', { class: 'stack', style: { gap: '4px' } },
          h('div', null, h('strong', null, 'New documents: '), describeTaxes(preview.taxes)),
          setup.mode === 'province' ? h('div', { class: 'muted' }, `In force today in ${provinceName(setup.province)}: ${today.map((r) => `${r.label} ${r.pct}%`).join(' + ')}.`) : null,
          setup.mode === 'province' && hint ? h('div', { class: 'muted' }, hint) : null,
          h('div', { class: 'row muted', style: { flexWrap: 'nowrap', alignItems: 'flex-start' } }, ui.icon('info', 16),
            h('span', null, 'Whether PST/RST applies to contracting work depends on the province, the job and the customer. Each estimate and invoice can change its treatment. Check with your accountant.'))),
        saveRow('Save tax set-up', save));
    };

    // box placement on drawings (settings.placement); defaults live in lib/placement-rules.js
    const placementHost = h('div', { class: 'stack' });
    const drawPlacement = () => {
      ui.clear(placementHost);
      const cur = store.settings();
      const units = getUnits(cur.units);
      const pl = placementSettings(cur.placement);
      const unitLabel = units === 'imperial' ? 'ft-in' : 'm';
      const len = (m) => (units === 'imperial' ? fmtLength(m, { units, denom: 8 }) : String(m));
      const form = h('form', { onSubmit: (e) => e.preventDefault() }, ui.formGrid([
        { label: `Switch height (${unitLabel})`, name: 'switchHeight', value: len(pl.switchHeightM), hint: 'Centre of the switch box above the finished floor' },
        { label: `Switch from the latch-side jamb (${unitLabel})`, name: 'switchFromJamb', value: len(pl.switchFromJambM), hint: 'Door jamb to the centre of the switch box' },
        { label: `Receptacle height (${unitLabel})`, name: 'receptacleHeight', value: len(pl.receptacleHeightM), hint: 'Centre above the finished floor' },
        { label: 'Smoke/CO alarms in bedrooms', name: 'alarmBedrooms', type: 'checkbox', value: pl.alarms.bedrooms },
        { label: 'Smoke/CO alarms in hallways', name: 'alarmHallways', type: 'checkbox', value: pl.alarms.hallways },
        { label: 'Smoke/CO alarm in the basement', name: 'alarmBasement', type: 'checkbox', value: pl.alarms.basement },
      ]));
      const save = () => {
        const v = ui.readForm(form);
        const read = (s, max) => {
          const m = parseLength(s, { units, bare: units === 'imperial' ? 'in' : 'm' });
          return m != null && m >= 0 && m <= max ? Math.round(m * 1000) / 1000 : null;
        };
        const switchHeightM = read(v.switchHeight, 3);
        const switchFromJambM = read(v.switchFromJamb, 1);
        const receptacleHeightM = read(v.receptacleHeight, 3);
        if (!switchHeightM || switchFromJambM == null || !receptacleHeightM) { ui.toast(`Enter lengths like ${units === 'imperial' ? `48" or 4'` : '1.2 or 1200 mm'}`, 'error'); return; }
        store.saveSettings({ placement: { ...(store.settings().placement || {}), switchHeightM, switchFromJambM, receptacleHeightM,
          alarms: { bedrooms: !!v.alarmBedrooms, hallways: !!v.alarmHallways, basement: !!v.alarmBasement } } });
        ui.toast('Placement defaults saved', 'success');
        drawPlacement();
      };
      placementHost.append(form, saveRow('Save placement', save));
    };

    // defaults
    const defaults = h('form', { onSubmit: (e) => e.preventDefault() }, ui.formGrid([
      { label: 'Labour rate (per hour)', name: 'labourRateCents', type: 'money', value: s.labourRateCents },
      { label: 'Material markup %', name: 'markupPct', type: 'number', step: '0.1', min: 0, value: s.markupPct, hint: 'Used to suggest sell prices from cost' },
      { label: 'Currency', name: 'currency', type: 'select', value: s.currency || 'CAD', options: CURRENCIES },
    ]));
    const saveDefaults = () => {
      if (!defaults.reportValidity()) return;
      const v = ui.readForm(defaults);
      store.saveSettings({ labourRateCents: v.labourRateCents, markupPct: v.markupPct ?? 0, currency: v.currency });
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
      ui.download(`${BRAND.backupTag}-backup-${ui.today()}.json`, JSON.stringify(dump));
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

    const redownload = async () => {
      if (!(await ui.confirmDialog('Clear this device’s copy of the company data and download it again from the server? Changes waiting to sync stay queued and are sent afterwards.', { title: 'Download everything again', okLabel: 'Download again', danger: false }))) return;
      await store.clearAll();
      location.reload();
    };

    const counts = ['clients', 'jobs', 'drawings', 'estimates', 'invoices', 'employees', 'auditLog'].map((c) => `${store.count(c)} ${c === 'auditLog' ? 'log entries' : c}`).join(' · ');
    const storageStatus = store.offlineOnly
      ? ui.badge('Memory only: data is lost on reload', 'danger')
      : store.persistent ? ui.badge('Persistent storage', 'success') : ui.badge('Browser may clear data when low on space', 'warning');

    drawCode(); drawTax(); drawPlacement();
    root.append(ui.page({ title: 'Settings', subtitle: s.company?.name },
      h('div', { class: 'grid-2 settings-grid' },
        card('Company', 'Shown on estimates, invoices and printouts', company, saveRow('Save company', saveCompany), h('strong', null, 'Logo'), logoField(ctx)),
        card('Code book and units', 'Which electrical code the field tools follow, and how lengths show', codeHost),
        card('Sales tax', 'GST/HST and PST/RST for new estimates and invoices', taxHost),
        card('Defaults', 'Applied to new estimates and invoices', defaults, saveRow('Save defaults', saveDefaults)),
        card('Document numbering', 'The next number each new document gets', numbering, saveRow('Save numbering', saveNumbering)),
        card('Box placement', 'Used when placing boxes on drawings', placementHost),
        ctx.auth?.synced ? card('Your account', 'Password, two-step sign-in, your units and theme',
          ui.button('Password and sign-in', { icon: 'key', href: '#/account' })) : null,
        card('Appearance', null, themeHost),
        store.synced ? card('Data', 'Your company’s data lives on the server and syncs to this device.',
          h('div', { class: 'muted' }, counts),
          h('div', { class: 'row' }, ui.button('Export a copy', { icon: 'download', onClick: exportBackup })),
          h('div', { class: 'muted' }, 'A JSON copy of what is on this device, for your records. Restoring from a file only works in the demo; signed in, the server is the copy that counts.'),
          h('hr', { class: 'hr' }),
          h('div', { class: 'row' }, h('div', { class: 'grow' }, h('strong', null, 'Download everything again'), h('div', { class: 'muted' }, 'Clears this device’s copy and downloads it fresh from the server. Changes still waiting to sync are kept and sent.')),
            ui.button('Download again…', { icon: 'download', onClick: redownload })))
          : card('Data', 'Everything lives on this device. Export a backup regularly.',
          h('div', { class: 'row' }, storageStatus), h('div', { class: 'muted' }, counts),
          h('div', { class: 'row' },
            ui.button('Export backup', { icon: 'download', onClick: exportBackup }),
            ui.button('Restore from file', { icon: 'upload', onClick: restore })),
          h('hr', { class: 'hr' }),
          h('div', { class: 'row' }, h('div', { class: 'grow' }, h('strong', null, 'Wipe all data'), h('div', { class: 'muted' }, 'Clears this device and reloads the demo data.')),
            ui.button('Wipe…', { variant: 'danger', icon: 'trash', onClick: wipe }))),
        card('Accounting and imports', 'Bring records in from other software; send invoices and payments to QuickBooks Online',
          h('div', { class: 'row' }, ui.button('Import a file', { icon: 'upload', href: '#/import' }), ui.button('Export to QuickBooks', { icon: 'download', href: '#/import/export' })),
          h('div', { class: 'row' }, ui.button('Developer & API keys', { variant: 'ghost', icon: 'key', href: '#/developer' }), ui.button('Set-up checklist', { variant: 'ghost', icon: 'check', href: '#/onboarding' }))),
        card('About', null,
          h('div', null, h('strong', null, BRAND.name), ` v${APP_VERSION}`),
          h('p', { class: 'muted', style: { margin: 0 } }, 'A CRM/ERP for Canadian electrical contractors, with an infinite-canvas plan workspace.'),
          h('p', { class: 'muted', style: { margin: 0 } }, 'Calculators follow the Canadian Electrical Code (CSA C22.1:24) by default, or NEC 2023 if you choose it. They are estimating aids that cite rule and table numbers; always verify against the code and amendments in force where you work, and the inspection authority.')),
      )));
  },
};
