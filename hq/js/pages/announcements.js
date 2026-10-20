// Announcements ("What's new"): banners companies see at the top of the app. Write, schedule
// and target them (everyone, some plans, trials, some provinces). People dismiss them for
// themselves. HQ admins create and publish; every change is audited.
import { del, get, patch, post } from '../api.js';
import { planName } from '../fmt.js';
import { loader } from '../kit.js';

const PLANS = ['trial', 'starter', 'pro', 'business', 'enterprise'];
const PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'];
const STATUS_TONE = { draft: 'neutral', published: 'success', archived: 'neutral' };
const localInput = (iso) => { if (!iso) return ''; const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

export default {
  render(root, { ui, isAdmin }) {
    const { h } = ui;
    const body = h('div', { class: 'stack' });
    root.append(ui.page({ title: 'Announcements', subtitle: "What's new: banners in the app, by plan and province", actions: isAdmin ? [ui.button('New announcement', { variant: 'primary', icon: 'plus', onClick: () => edit(null) })] : [] }, body));
    let data = null;

    const audience = (a) => [
      a.targetPlans.length ? a.targetPlans.map((p) => (p === 'trial' ? 'on trial' : planName(p))).join(', ') : 'every plan',
      a.targetProvinces.length ? a.targetProvinces.join(', ') : 'every province',
    ].join(' · ');

    function preview(a) {
      return h('div', { class: ['hq-ann-preview', `tone-${a.tone || 'info'}`] }, ui.icon(a.tone === 'warning' ? 'alert' : 'info', 18),
        h('div', { class: 'grow' }, h('strong', null, a.title || 'Title'), a.body ? h('div', null, a.body) : null,
          a.linkUrl ? h('span', { class: 'hq-ann-link' }, a.linkLabel || 'Learn more') : null),
        a.dismissible !== false ? ui.icon('x', 16) : null);
    }

    function draw() {
      ui.clear(body);
      body.append(ui.table({
        columns: [
          { key: 'title', label: 'Announcement', render: (a) => h('div', null, h('strong', null, a.title), a.body ? h('div', { class: 'muted hq-small' }, a.body.slice(0, 120)) : null) },
          { key: 'status', label: 'Status', render: (a) => h('div', { class: 'hq-pill-list' }, ui.badge(a.status, STATUS_TONE[a.status]), a.live ? ui.badge('showing now', 'success') : a.status === 'published' && new Date(a.startsAt) > new Date() ? ui.badge('scheduled', 'info') : null) },
          { key: 'aud', label: 'Who sees it', render: (a) => h('div', { class: 'hq-small' }, audience(a), h('div', { class: 'muted' }, `${a.reach} of ${data.companies} companies`)) },
          { key: 'when', label: 'When', render: (a) => h('div', { class: 'hq-small' }, `from ${ui.fmtDateTime(a.startsAt)}`, a.endsAt ? h('div', null, `until ${ui.fmtDateTime(a.endsAt)}`) : null) },
          { key: 'dis', label: 'Dismissed', align: 'right', render: (a) => (a.dismissible ? String(a.dismissals) : 'stays') },
        ],
        rows: data.data,
        onRowClick: (a) => edit(a),
        empty: ui.empty({ icon: 'send', title: 'No announcements yet', text: 'Tell companies about new features, maintenance windows or code changes.' }),
      }));
    }

    function edit(a) {
      const cur = a || { title: '', body: '', tone: 'info', targetPlans: [], targetProvinces: [], status: 'draft', dismissible: true, startsAt: null, endsAt: null, linkUrl: '', linkLabel: '' };
      const pv = h('div');
      const fields = [
        { label: 'Title', name: 'title', value: cur.title, required: true, span: true },
        { label: 'Text', name: 'body', type: 'textarea', value: cur.body, span: true, rows: 3 },
        { label: 'Link (https://… or #/route)', name: 'linkUrl', value: cur.linkUrl || '' },
        { label: 'Link label', name: 'linkLabel', value: cur.linkLabel || '' },
        { label: 'Tone', name: 'tone', type: 'select', value: cur.tone, options: [{ value: 'info', label: 'Info' }, { value: 'success', label: 'Good news' }, { value: 'warning', label: 'Warning' }] },
        { label: 'Status', name: 'status', type: 'select', value: cur.status, options: [{ value: 'draft', label: 'Draft' }, { value: 'published', label: 'Published' }, { value: 'archived', label: 'Archived' }] },
        { label: 'Show from', name: 'startsAt', type: 'datetime-local', value: localInput(cur.startsAt), hint: 'Empty: now' },
        { label: 'Show until', name: 'endsAt', type: 'datetime-local', value: localInput(cur.endsAt), hint: 'Empty: until archived' },
        { label: 'People can dismiss it', name: 'dismissible', type: 'checkbox', value: cur.dismissible },
        ...PLANS.map((p) => ({ label: p === 'trial' ? 'Companies on a trial' : planName(p), name: `plan_${p}`, type: 'checkbox', value: cur.targetPlans.includes(p) })),
        { label: 'Provinces (comma separated, empty for all)', name: 'provinces', value: cur.targetProvinces.join(', '), span: true },
      ];
      const sheet = ui.formSheet({
        title: a ? 'Edit announcement' : 'New announcement',
        wide: true,
        fields,
        extra: h('div', { class: 'stack' }, h('p', { class: 'muted hq-small', style: { margin: 0 } }, 'Plans: none ticked means every plan. A running trial counts as Business too. Preview:'), pv),
        submitLabel: isAdmin ? 'Save' : 'Close',
        danger: isAdmin && a ? { label: 'Delete', onClick: () => remove(a) } : null,
        onSubmit: (v) => {
          if (!isAdmin) return;
          const provinces = v.provinces.split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
          const bad = provinces.filter((p) => !PROVINCES.includes(p));
          if (bad.length) { ui.toast(`Unknown province: ${bad.join(', ')}`, 'error'); return false; }
          const payload = {
            title: v.title.trim(), body: v.body.trim(), tone: v.tone, status: v.status, dismissible: v.dismissible,
            linkUrl: v.linkUrl.trim() || null, linkLabel: v.linkLabel.trim() || null,
            targetPlans: PLANS.filter((p) => v[`plan_${p}`]), targetProvinces: provinces,
            startsAt: v.startsAt ? new Date(v.startsAt).toISOString() : null, endsAt: v.endsAt ? new Date(v.endsAt).toISOString() : null,
          };
          (a ? patch(`/api/hq/announcements/${a.id}`, payload) : post('/api/hq/announcements', payload))
            .then(() => { ui.toast('Saved (audited)', 'success'); load(); }).catch((e) => ui.toast(e.message, 'error', 5000));
        },
      });
      const form = sheet.el.querySelector('form');
      const refresh = () => {
        const get = (n) => form.querySelector(`[name="${n}"]`);
        ui.clear(pv);
        pv.append(preview({ title: get('title').value, body: get('body').value, tone: get('tone').value, linkUrl: get('linkUrl').value, linkLabel: get('linkLabel').value, dismissible: get('dismissible').checked }));
      };
      form.addEventListener('input', refresh);
      form.addEventListener('change', refresh);
      refresh();
      if (!isAdmin) for (const el of form.querySelectorAll('input, select, textarea')) el.disabled = true;
    }

    async function remove(a) {
      if (!(await ui.confirmDialog(`"${a.title}" is deleted for everyone, with its dismissals. Archive it instead to keep the record.`, { title: 'Delete the announcement?', okLabel: 'Delete' }))) return;
      try { await del(`/api/hq/announcements/${a.id}`); ui.toast('Deleted', 'success'); load(); } catch (e) { ui.toast(e.message, 'error'); }
    }

    const load = () => loader(ui, body, async () => { data = await get('/api/hq/announcements'); draw(); });
    load();
    return () => {};
  },
};
