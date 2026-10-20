// Onboarding (#/onboarding): the first-week checklist for owners and admins, plus the progress
// card on the dashboard (onboardingCard) and the logo picker Settings uses (logoField).
// Each step ticks itself off from real data (settings, records, members, integrations); a step
// can be skipped, and the whole list dismissed, for the company (settings.onboarding).
// detectSteps() is pure so tests can run it in Node; nothing here imports ui.js at load time.
import { isGstHstNumber, PROVINCES } from '../lib/tax.js';
import { CODE_BOOKS } from '../lib/cec/provinces.js';
import { DEFAULT_SETTINGS } from '../store.js';

const DEFAULT_RATE = DEFAULT_SETTINGS.labourRateCents;
const DEFAULT_MARKUP = DEFAULT_SETTINGS.markupPct;
const FACTS_META = 'onboarding.server';

/** Facts the steps are decided from. `server` holds what only the API knows (cached). */
export function collectFacts(store, { synced = false, server = null } = {}) {
  const s = store.settings();
  return {
    settings: s,
    synced,
    items: store.count('items'),
    jobs: store.count('jobs'),
    planSets: store.count('drawings', (d) => d.planSet || d.underlay),
    employees: store.count('employees', (e) => e.active !== false),
    server: server || store.meta?.(FACTS_META) || null,
  };
}

/**
 * The checklist: [{ id, title, text, done, skipped, detail, href }]. Pure.
 * @param {ReturnType<typeof collectFacts>} f
 */
export function detectSteps(f) {
  const s = f.settings || {};
  const co = s.company || {};
  const ob = s.onboarding || {};
  const skipped = ob.skipped || {};
  const server = f.server || {};
  const named = Boolean(co.name && co.name.trim() && co.name !== DEFAULT_SETTINGS.company.name);
  const gst = isGstHstNumber(co.gstHstNo);
  const contact = Boolean(co.address || co.phone || co.email);
  const missing = [!named && 'company name', !contact && 'address or phone', !gst && 'GST/HST number'].filter(Boolean);
  const members = server.members ?? null;
  const steps = [
    { id: 'company', title: 'Company details and GST/HST number', text: 'Shown on every estimate and invoice. CRA requires your GST/HST number on invoices of $100 or more.',
      done: named && contact && gst, detail: missing.length ? `Still needed: ${missing.join(', ')}` : co.name, href: '#/settings' },
    { id: 'province', title: 'Province and code book', text: 'Picks the CEC amendments, the inspection authority and sales tax.',
      done: Boolean(ob.provinceAt) || (co.province && co.province !== DEFAULT_SETTINGS.company.province) || (s.codeBook && s.codeBook !== DEFAULT_SETTINGS.codeBook),
      detail: co.province ? `${PROVINCES.find((p) => p.code === co.province)?.name || co.province} · ${s.codeBook === 'NEC-2023' ? 'NEC 2023' : 'CEC 2024'}` : '', href: '#/settings' },
    { id: 'logo', title: 'Your logo', text: 'A small copy goes on printed estimates and invoices.', done: Boolean(co.logo), detail: co.logo ? 'Logo added' : '', href: '#/settings' },
    { id: 'rates', title: 'Labour rate and markup', text: 'The defaults for new estimates.',
      done: Boolean(ob.ratesAt) || s.labourRateCents !== DEFAULT_RATE || s.markupPct !== DEFAULT_MARKUP,
      detail: `$${((s.labourRateCents ?? 0) / 100).toFixed(2)}/h · ${s.markupPct ?? 0}% markup`, href: '#/settings' },
    { id: 'pricebook', title: 'Import or add your price book', text: 'From QuickBooks, a supplier price list or any spreadsheet.',
      done: f.items > 0, detail: f.items ? `${f.items} item${f.items === 1 ? '' : 's'}` : '', href: '#/import?target=items' },
    { id: 'crew', title: 'Invite the crew', text: 'Each person signs in with their own account, or with a PIN on a shared iPad.',
      done: f.synced ? (members != null && members > 1) : f.employees > 1,
      detail: f.synced ? (members == null ? '' : `${members} member${members === 1 ? '' : 's'}${server.pins ? ` · ${server.pins} with a PIN` : ''}${server.devices ? ` · ${server.devices} shared iPad${server.devices === 1 ? '' : 's'}` : ''}`) : `${f.employees} employee${f.employees === 1 ? '' : 's'}`,
      href: f.synced ? '#/account' : '#/employees' },
    { id: 'connect', title: 'Connect payments, email and texts', text: 'Stripe for card payments, email from your own address, texts from your own number.',
      done: Boolean(server.payments || server.email || server.sms),
      detail: ['payments', 'email', 'sms'].filter((k) => server[k]).map((k) => ({ payments: 'Stripe', email: 'Email', sms: 'Texts' }[k])).join(', ') ? `Connected: ${['payments', 'email', 'sms'].filter((k) => server[k]).map((k) => ({ payments: 'Stripe', email: 'Email', sms: 'Texts' }[k])).join(', ')}` : '',
      href: '#/integrations' },
    { id: 'job', title: 'Create your first job', text: 'Jobs tie together the client, crew, drawings, time and invoices.', done: f.jobs > 0, detail: f.jobs ? `${f.jobs} job${f.jobs === 1 ? '' : 's'}` : '', href: '#/jobs?new=1' },
    { id: 'plans', title: 'Import a plan set', text: 'Drop in the PDF drawings; each sheet becomes a page you can mark up and take off from.', done: f.planSets > 0, detail: f.planSets ? `${f.planSets} sheet${f.planSets === 1 ? '' : 's'}` : '', href: '#/drawings' },
  ];
  for (const st of steps) { st.skipped = !st.done && Boolean(skipped[st.id]); }
  return steps;
}

export function progress(steps) {
  const done = steps.filter((s) => s.done || s.skipped).length;
  return { done, total: steps.length, complete: done === steps.length, next: steps.find((s) => !s.done && !s.skipped) || null };
}

/** Should the checklist show for this person? Owners and admins, until done or dismissed. */
export function showFor(auth, settings, steps) {
  return auth.isAdmin() && !settings?.onboarding?.dismissedAt && !progress(steps).complete;
}

// ---- things only the server knows (cached in meta for offline starts) --------------

export async function loadServerFacts(store, auth) {
  if (!auth.synced || !store.synced) return null;
  const out = { ...(store.meta(FACTS_META) || {}) };
  const { api } = await import('../session.js');
  try {
    const { data } = await api.get('/api/v1/members');
    out.members = data.filter((m) => m.status !== 'disabled').length;
    out.pins = data.filter((m) => m.hasPin).length;
  } catch { /* offline or not a manager */ }
  try { const { data } = await api.get('/api/v1/devices'); out.devices = data.filter((d) => !d.revokedAt).length; } catch { /* ignore */ }
  try {
    const { available } = await import('./integrations.js');
    const a = await available(true);
    if (a) Object.assign(out, { payments: Boolean(a.payments), email: Boolean(a.email), sms: Boolean(a.sms) });
  } catch { /* ignore */ }
  out.at = new Date().toISOString();
  store.setMeta(FACTS_META, out);
  return out;
}

// ---- logo ---------------------------------------------------------------------------

/** Downscale an image file to at most `max` px and encode it small (PNG keeps transparency). */
export async function downscaleImage(file, { max = 320, maxChars = 120_000 } = {}) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That file is not an image this browser can read.')); i.src = url; });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    let out = c.toDataURL('image/png');
    for (const q of [0.9, 0.8, 0.7]) { if (out.length <= maxChars) break; out = c.toDataURL('image/jpeg', q); }
    if (out.length > maxChars) throw new Error('That image is too detailed to store as a logo. Try a simpler or smaller file.');
    return { dataUrl: out, width: c.width, height: c.height };
  } finally { URL.revokeObjectURL(url); }
}

/** The logo row: preview, Upload / Replace, Remove. Saves into settings.company.logo. */
export function logoField(ctx) {
  const { store, ui } = ctx;
  const { h } = ui;
  const host = h('div', { class: 'ob-logo' });
  const draw = () => {
    const logo = store.settings().company?.logo;
    ui.clear(host).append(
      h('div', { class: 'ob-logo-box' }, logo ? h('img', { src: logo, alt: 'Company logo' }) : h('span', { class: 'muted' }, 'No logo')),
      h('div', { class: 'stack', style: { gap: 'var(--s2)' } },
        h('div', { class: 'row' },
          ui.button(logo ? 'Replace logo' : 'Upload logo', { size: 'sm', icon: 'upload', onClick: async () => {
            const file = await ui.pickFile('image/png,image/jpeg,image/webp,image/gif,image/svg+xml');
            if (!file) return;
            try {
              const { dataUrl } = await downscaleImage(file);
              store.saveSettings({ company: { ...store.settings().company, logo: dataUrl } });
              ui.toast('Logo saved', 'success');
              draw();
            } catch (e) { ui.toast(e.message, 'error', 4500); }
          } }),
          logo ? ui.button('Remove', { size: 'sm', variant: 'ghost danger', onClick: () => { const c = { ...store.settings().company }; delete c.logo; store.saveSettings({ company: c }); draw(); } }) : null),
        h('span', { class: 'hint muted' }, 'PNG or JPEG. Stored small (up to 320 px).')));
  };
  draw();
  return host;
}

// ---- dashboard card -------------------------------------------------------------------

/** The progress card for the dashboard, or null when it shouldn't show. */
export function onboardingCard(ctx) {
  const { store, ui, auth } = ctx;
  const { h } = ui;
  const steps = detectSteps(collectFacts(store, { synced: auth.synced }));
  if (!showFor(auth, store.settings(), steps)) return null;
  const p = progress(steps);
  return h('section', { class: 'card ob-card', 'aria-label': 'Set-up checklist' },
    h('div', { class: 'row' },
      h('div', { class: 'grow' }, h('h3', { style: { margin: 0 } }, `Set up ${store.settings().company?.name && store.settings().company.name !== DEFAULT_SETTINGS.company.name ? store.settings().company.name : 'your company'}`),
        h('div', { class: 'muted' }, `${p.done} of ${p.total} done${p.next ? ` · next: ${p.next.title.toLowerCase()}` : ''}`)),
      ui.button('Continue', { variant: 'primary', icon: 'chevron-right', href: '#/onboarding' }),
      ui.button('', { variant: 'ghost', icon: 'x', title: 'Hide the checklist', onClick: () => dismiss(ctx) })),
    h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(p.total), 'aria-valuenow': String(p.done) },
      h('i', { style: { width: `${Math.round((p.done / p.total) * 100)}%` } })));
}

async function dismiss(ctx) {
  const { store, ui } = ctx;
  if (!(await ui.confirmDialog('Hide the set-up checklist for everyone in the company? You can bring it back from Settings.', { title: 'Hide checklist', okLabel: 'Hide', danger: false }))) return;
  store.saveSettings({ onboarding: { ...(store.settings().onboarding || {}), dismissedAt: new Date().toISOString() } });
  ui.toast('Checklist hidden. Settings → Set-up checklist brings it back.');
}

// ---- inline forms per step ------------------------------------------------------------

function saveOb(store, patch) { store.saveSettings({ onboarding: { ...(store.settings().onboarding || {}), ...patch } }); }

function stepBody(ctx, st, redraw) {
  const { store, ui, auth } = ctx;
  const { h } = ui;
  const s = store.settings();
  const co = s.company || {};
  const form = (fields, onSave, label = 'Save') => {
    const f = h('form', { onSubmit: (e) => { e.preventDefault(); go(); } }, ui.formGrid(fields), h('button', { type: 'submit', hidden: true }));
    const go = () => { if (!f.reportValidity()) return; onSave(ui.readForm(f)); redraw(); };
    return h('div', { class: 'stack' }, f, h('div', { class: 'row' }, ui.button(label, { variant: 'primary', size: 'sm', icon: 'check', onClick: go })));
  };
  switch (st.id) {
    case 'company': return form([
      { label: 'Company name', name: 'name', value: co.name === DEFAULT_SETTINGS.company.name ? '' : co.name, required: true, span: true },
      { label: 'Phone', name: 'phone', type: 'tel', value: co.phone },
      { label: 'Email', name: 'email', type: 'email', value: co.email },
      { label: 'Address', name: 'address', value: co.address, span: true },
      { label: 'GST/HST registration no.', name: 'gstHstNo', value: co.gstHstNo, placeholder: '123456789 RT0001', hint: '9-digit business number, RT, 4 digits' },
      { label: 'Contractor licence no.', name: 'licenceNo', value: co.licenceNo },
    ], (v) => {
      if (v.gstHstNo && !isGstHstNumber(v.gstHstNo)) ui.toast('That GST/HST number does not look like 123456789 RT0001. Saved anyway.', 'info', 4000);
      store.saveSettings({ company: { ...store.settings().company, ...v } });
      ui.toast('Company details saved', 'success');
    });
    case 'province': return form([
      { label: 'Province / territory', name: 'province', type: 'select', value: co.province || 'ON', options: PROVINCES.map((p) => ({ value: p.code, label: p.name })) },
      { label: 'Code book', name: 'codeBook', type: 'select', value: s.codeBook || 'CEC-2024', options: CODE_BOOKS.map((b) => ({ value: b.id, label: b.label })) },
    ], (v) => {
      store.saveSettings({ company: { ...store.settings().company, province: v.province }, codeBook: v.codeBook });
      saveOb(store, { provinceAt: new Date().toISOString() });
      ui.toast('Saved. Check the sales tax set-up in Settings.', 'success', 3500);
    }, 'Confirm');
    case 'logo': return logoField({ ...ctx, ui: { ...ui, toast: (m, k, ms) => { ui.toast(m, k, ms); redraw(); } } });
    case 'rates': return form([
      { label: 'Labour rate (per hour)', name: 'labourRateCents', type: 'money', value: s.labourRateCents, required: true },
      { label: 'Material markup %', name: 'markupPct', type: 'number', step: '0.1', min: 0, value: s.markupPct },
    ], (v) => {
      store.saveSettings({ labourRateCents: v.labourRateCents, markupPct: v.markupPct ?? 0 });
      saveOb(store, { ratesAt: new Date().toISOString() });
      ui.toast('Rates saved', 'success');
    }, 'Confirm');
    case 'pricebook': return h('div', { class: 'row' },
      ui.button('Import a price list', { variant: 'primary', size: 'sm', icon: 'upload', href: '#/import?target=items' }),
      ui.button('Add items by hand', { size: 'sm', icon: 'plus', href: '#/inventory' }));
    case 'crew': return auth.synced
      ? h('div', { class: 'row' },
        ui.button('Invite someone', { variant: 'primary', size: 'sm', icon: 'plus', onClick: () => inviteSheet(ctx, redraw) }),
        ui.button('Shared iPad and PINs', { size: 'sm', icon: 'key', href: '#/account' }),
        ui.button('Import employees', { size: 'sm', icon: 'upload', href: '#/import?target=employees' }))
      : h('div', { class: 'row' },
        ui.button('Add employees', { variant: 'primary', size: 'sm', icon: 'plus', href: '#/employees' }),
        ui.button('Import employees', { size: 'sm', icon: 'upload', href: '#/import?target=employees' }),
        h('span', { class: 'muted' }, 'Sign in to your company to invite people.'));
    case 'connect': return h('div', { class: 'row' }, ui.button('Open Integrations', { variant: 'primary', size: 'sm', icon: 'link', href: '#/integrations' }),
      auth.synced ? null : h('span', { class: 'muted' }, 'Needs a signed-in company.'));
    case 'job': return h('div', { class: 'row' }, ui.button('New job', { variant: 'primary', size: 'sm', icon: 'plus', href: '#/jobs?new=1' }), ui.button('Import jobs', { size: 'sm', icon: 'upload', href: '#/import?target=jobs' }));
    case 'plans': return h('div', { class: 'row' }, ui.button('Open Drawings', { variant: 'primary', size: 'sm', icon: 'layers', href: '#/drawings' }),
      h('span', { class: 'muted' }, 'Use Import PDF; a multi-page set becomes one sheet per page.'));
    default: return null;
  }
}

const INVITE_ROLES = [['electrician', 'Electrician'], ['apprentice', 'Apprentice'], ['foreman', 'Foreman'], ['office', 'Office'], ['admin', 'Admin']];

/** Add a member: with an email they get an invite to set a password; without, they are PIN-only crew. */
function inviteSheet(ctx, done) {
  const { ui, store } = ctx;
  ui.formSheet({
    title: 'Invite someone', submitLabel: 'Invite',
    fields: [
      { label: 'Name', name: 'name', required: true, span: true },
      { label: 'Email', name: 'email', type: 'email', hint: 'Leave blank for crew who only sign in with a PIN on a shared iPad', span: true },
      { label: 'Role', name: 'role', type: 'select', value: 'electrician', options: INVITE_ROLES.map(([value, label]) => ({ value, label })) },
      { label: 'Also add to Employees', name: 'employee', type: 'checkbox', value: true },
    ],
    onSubmit: (v) => {
      (async () => {
        const { api } = await import('../session.js');
        let employeeId;
        if (v.employee) employeeId = store.add('employees', { name: v.name.trim(), role: v.role, email: v.email || '', phone: '', licenceNo: '', licenceExpiry: '', rateCents: 0, active: true, color: '#1f5fb8' }).id;
        try {
          await api.post('/api/v1/members', { name: v.name.trim(), role: v.role, ...(v.email ? { email: v.email.trim() } : {}), ...(employeeId ? { employeeId } : {}) });
          ui.toast(v.email ? `Invite sent to ${v.email}` : `${v.name} added. Set their PIN under Account → Shared iPad.`, 'success', 4500);
          await loadServerFacts(store, ctx.auth);
          done();
        } catch (e) { ui.toast(e.message, 'error', 5000); }
      })();
    },
  });
}

// ---- the page ---------------------------------------------------------------------------

export default {
  id: 'onboarding',
  title: 'Set-up checklist',
  icon: 'check',
  group: 'admin',
  perm: 'settings',
  hidden: true,
  render(root, ctx) {
    const { store, ui, auth } = ctx;
    const { h } = ui;
    let open = ctx.query.step || null;
    const host = h('div', { class: 'stack' });
    const head = h('div');
    const draw = () => {
      const steps = detectSteps(collectFacts(store, { synced: auth.synced }));
      const p = progress(steps);
      if (!open || steps.find((s) => s.id === open)?.done) open = p.next?.id || null;
      ui.clear(head).append(h('div', { class: 'card ob-card' },
        h('div', { class: 'row' }, h('strong', { class: 'grow' }, p.complete ? 'All set. Nice work.' : `${p.done} of ${p.total} done`),
          store.settings().onboarding?.dismissedAt
            ? ui.button('Show on the dashboard', { size: 'sm', variant: 'ghost', onClick: () => { saveOb(store, { dismissedAt: null }); draw(); } })
            : ui.button('Hide checklist', { size: 'sm', variant: 'ghost', icon: 'eye-off', onClick: () => dismiss(ctx) })),
        h('div', { class: 'progress' }, h('i', { style: { width: `${Math.round((p.done / p.total) * 100)}%` } }))));
      ui.clear(host).append(h('ol', { class: 'ob-steps' }, steps.map((st, i) => {
        const isOpen = open === st.id;
        return h('li', { class: ['card', 'ob-step', st.done ? 'done' : st.skipped ? 'skipped' : null, isOpen ? 'open' : null], dataset: { step: st.id } },
          h('button', { type: 'button', class: 'ob-step-head', 'aria-expanded': String(isOpen), onClick: () => { open = isOpen ? null : st.id; draw(); } },
            h('span', { class: 'ob-tick', 'aria-hidden': 'true' }, st.done ? ui.icon('check', 16) : st.skipped ? ui.icon('minus', 16) : String(i + 1)),
            h('span', { class: 'grow' }, h('span', { class: 'ob-title' }, st.title), st.detail ? h('span', { class: 'ob-detail muted' }, st.detail) : null),
            st.done ? ui.badge('Done', 'success') : st.skipped ? ui.badge('Skipped') : null,
            ui.icon(isOpen ? 'chevron-down' : 'chevron-right', 16)),
          isOpen ? h('div', { class: 'ob-step-body stack' },
            h('p', { class: 'muted', style: { margin: '0' } }, st.text),
            stepBody(ctx, st, draw),
            st.done ? null : h('div', { class: 'row' }, h('span', { class: 'grow' }),
              ui.button(st.skipped ? 'Undo skip' : 'Skip this step', { size: 'sm', variant: 'ghost', onClick: () => {
                const sk = { ...(store.settings().onboarding?.skipped || {}) };
                if (st.skipped) delete sk[st.id]; else sk[st.id] = true;
                saveOb(store, { skipped: sk }); draw();
              } }))) : null);
      })));
    };
    root.append(ui.page({ title: 'Set-up checklist', subtitle: 'The few things that make your first week smooth' }, head, host));
    draw();
    loadServerFacts(store, auth).then(() => { if (root.isConnected) draw(); });
    let t = null;
    const off = store.on('*', (e) => { if (e.coll === 'auditLog') return; clearTimeout(t); t = setTimeout(() => { const typing = host.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
      if (!document.querySelector('.sheet, .dialog') && !typing) draw(); }, 300); });
    return () => { off(); clearTimeout(t); };
  },
};
