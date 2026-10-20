// Status notices: incidents and maintenance on the PUBLIC status page (status.fishtapehq.com),
// what the probes see right now, and the optional email subscriptions. Separate from
// Compliance -> incidents, which is HQ's internal record. HQ admins post and edit; other HQ
// staff read. Every change is audited. Everything here is plain text: the public page shows
// it with textContent.
import { del, get, patch, post, put } from '../api.js';
import { ago } from '../fmt.js';
import { card, kv, loader } from '../kit.js';

const COMPONENTS = [
  { id: 'app', name: 'Web app' }, { id: 'api', name: 'API and sync' }, { id: 'hq', name: 'HQ console' },
  { id: 'signin', name: 'Sign-in' }, { id: 'email', name: 'Email' }, { id: 'payments', name: 'Payments' },
];
const STATUSES = {
  incident: ['investigating', 'identified', 'monitoring', 'resolved'],
  maintenance: ['scheduled', 'in_progress', 'completed'],
};
const LABEL = {
  investigating: 'Investigating', identified: 'Identified', monitoring: 'Monitoring', resolved: 'Resolved',
  scheduled: 'Scheduled', in_progress: 'In progress', completed: 'Completed',
};
const IMPACT_LABEL = { none: 'No impact', minor: 'Minor', major: 'Major', maintenance: 'Maintenance' };
const COMPONENT_TONE = { operational: 'success', degraded: 'warning', outage: 'danger', unknown: 'neutral' };
const NOTICE_TONE = {
  investigating: 'danger', identified: 'warning', monitoring: 'info', resolved: 'success',
  scheduled: 'info', in_progress: 'warning', completed: 'success',
};
const IMPACT_TONE = { none: 'neutral', minor: 'warning', major: 'danger', maintenance: 'info' };
const nameOf = (id) => COMPONENTS.find((c) => c.id === id)?.name || id;
const localInput = (iso) => { if (!iso) return ''; const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const toIso = (v) => (v ? new Date(v).toISOString() : null);
const problemText = (e) => e.details?.errors?.map((x) => `${x.path.replace(/^\//, '')}: ${x.message}`).join('; ') || e.message;

export default {
  render(root, { ui, isAdmin }) {
    const { h } = ui;
    const body = h('div', { class: 'stack' });
    root.append(ui.page({
      title: 'Status notices',
      subtitle: 'Incidents and maintenance on the public status page (status.fishtapehq.com)',
      actions: isAdmin ? [ui.button('New notice', { variant: 'primary', icon: 'plus', onClick: () => create() })] : [],
    }, body));
    let data = null;

    function draw() {
      ui.clear(body);
      body.append(h('div', { class: 'hq-banner' }, ui.icon('info', 20), h('div', null,
        h('strong', null, 'This is the PUBLIC status page'),
        h('span', { class: 'hq-small' }, 'Anyone can read published notices at ', h('a', { href: data.publicUrl, target: '_blank', rel: 'noopener' }, data.publicUrl),
          '. Drafts stay here. Internal incident records belong in Compliance & security, not here.',
          isAdmin ? '' : ' HQ admins post and change notices; you can read them.'))));

      // What the probes see now.
      const probesOff = data.probes === 'off';
      body.append(card(ui, 'Components right now', 'activity',
        probesOff ? h('p', { class: 'muted hq-small' }, 'Network probes are off on this server (STATUS_PROBES=off): web components show unknown unless the host-status timer reports them.') : null,
        h('div', { class: 'hq-status-grid' }, data.components.map((c) => h('div', { class: 'hq-status-item' },
          h('div', { class: 'row' }, h('strong', { class: 'grow' }, c.name), ui.badge(c.status, COMPONENT_TONE[c.status] || 'neutral')),
          h('div', { class: 'muted hq-small' },
            c.checkedAt ? `Checked ${ago(c.checkedAt)}` : 'Never checked',
            data.uptime?.[c.id] != null ? ` · ${data.uptime[c.id]}% over 90 days` : '',
            c.changedAt && c.status !== 'unknown' ? ` · ${c.status} since ${ui.fmtDateTime(c.changedAt)}` : ''))))));

      body.append(h('h2', { class: 'section' }, 'Notices'));
      body.append(ui.table({
        columns: [
          { key: 'title', label: 'Notice', render: (n) => h('div', null, h('strong', null, n.title), n.updates[0] ? h('div', { class: 'muted hq-small' }, n.updates[0].body.slice(0, 140)) : null) },
          { key: 'kind', label: 'Kind', render: (n) => (n.kind === 'maintenance' ? 'Maintenance' : 'Incident') },
          { key: 'status', label: 'Status', render: (n) => h('div', { class: 'hq-pill-list' }, ui.badge(LABEL[n.status] || n.status, NOTICE_TONE[n.status]), n.published ? ui.badge('public', 'success') : ui.badge('draft', 'neutral')) },
          { key: 'impact', label: 'Impact', render: (n) => ui.badge(IMPACT_LABEL[n.impact] || n.impact, IMPACT_TONE[n.impact]) },
          { key: 'components', label: 'Affects', render: (n) => h('div', { class: 'hq-small' }, n.components.length ? n.components.map(nameOf).join(', ') : '—') },
          { key: 'when', label: 'Updated', render: (n) => h('div', { class: 'hq-small' }, ago(n.updates[0]?.at || n.updatedAt),
            n.kind === 'maintenance' && n.startsAt ? h('div', { class: 'muted' }, `Window ${ui.fmtDateTime(n.startsAt)}${n.endsAt ? ` – ${ui.fmtDateTime(n.endsAt)}` : ''}`) : null) },
        ],
        rows: data.data,
        onRowClick: (n) => open(n),
        empty: ui.empty({ icon: 'alert', title: 'No notices', text: 'Post one when something is down or slow, or to announce planned maintenance.' }),
      }));

      // Email subscriptions.
      const on = data.settings.subscribeEnabled;
      body.append(card(ui, 'Email subscriptions', 'mail',
        kv(ui, [
          ['Status', ui.badge(on ? 'On' : 'Off', on ? 'success' : 'neutral')],
          ['Confirmed subscribers', String(data.subscribers.confirmed)],
          ['Waiting to confirm', String(data.subscribers.pending)],
        ]),
        h('p', { class: 'muted hq-small' },
          'Off by default. When on, the public page offers "Get updates by email" (double opt-in: nothing is sent until the person confirms). ',
          'Notices go out only when you tick "Email subscribers". CASL applies: every email says who sent it and why and has a one-click unsubscribe; never add people yourself.'),
        isAdmin ? h('div', { class: 'row' }, ui.button(on ? 'Turn off' : 'Turn on', { variant: on ? 'secondary' : 'primary', onClick: () => toggleSubscriptions(!on) })) : null));
    }

    async function toggleSubscriptions(next) {
      if (!next && !(await ui.confirmDialog('The sign-up form disappears from the status page and no more notice emails go out. Existing subscribers are kept.', { title: 'Turn off email subscriptions?', okLabel: 'Turn off' }))) return;
      try { await put('/api/hq/status-settings', { subscribeEnabled: next }); ui.toast(`Email subscriptions ${next ? 'on' : 'off'} (audited)`, 'success'); load(); } catch (e) { ui.toast(e.message, 'error'); }
    }

    const statusOptions = (kind) => STATUSES[kind].map((s) => ({ value: s, label: LABEL[s] }));
    const impactOptions = (kind) => Object.entries(IMPACT_LABEL).filter(([k]) => kind === 'maintenance' || k !== 'maintenance').map(([value, label]) => ({ value, label }));
    const componentFields = (selected) => COMPONENTS.map((c) => ({ label: c.name, name: `c_${c.id}`, type: 'checkbox', value: selected.includes(c.id) }));
    const pickComponents = (v) => COMPONENTS.filter((c) => v[`c_${c.id}`]).map((c) => c.id);
    const fillSelect = (sel, options, value) => {
      ui.clear(sel);
      for (const o of options) sel.append(h('option', { value: o.value, selected: o.value === value }, o.label));
    };

    function create() {
      const subs = data.settings.subscribeEnabled;
      const sheet = ui.formSheet({
        title: 'New status notice',
        wide: true,
        fields: [
          { label: 'Kind', name: 'kind', type: 'select', value: 'incident', options: [{ value: 'incident', label: 'Incident (something is wrong)' }, { value: 'maintenance', label: 'Planned maintenance' }] },
          { label: 'Status', name: 'status', type: 'select', value: 'investigating', options: statusOptions('incident') },
          { label: 'Title (public)', name: 'title', value: '', required: true, span: true, placeholder: 'Sign-in is slow for some people' },
          { label: 'Impact', name: 'impact', type: 'select', value: 'minor', options: impactOptions('incident') },
          { label: 'Window starts', name: 'startsAt', type: 'datetime-local', value: '', hint: 'Maintenance: when it begins' },
          { label: 'Window ends', name: 'endsAt', type: 'datetime-local', value: '' },
          ...componentFields([]),
          { label: 'First update (public, plain text)', name: 'update', type: 'textarea', value: '', span: true, rows: 4, placeholder: 'We are looking into reports of slow sign-in.' },
          { label: 'Publish now (otherwise saved as a draft)', name: 'published', type: 'checkbox', value: false, span: true },
          subs ? { label: `Email subscribers (${data.subscribers.confirmed}) when published`, name: 'notify', type: 'checkbox', value: false, span: true } : null,
        ].filter(Boolean),
        extra: h('p', { class: 'muted hq-small' }, 'Affected components: tick the ones people would notice. A major incident shows the whole page as an outage; minor as degraded.'),
        submitLabel: 'Save',
        onSubmit: (v) => {
          const payload = {
            kind: v.kind, status: v.status, title: v.title.trim(), impact: v.impact, components: pickComponents(v),
            startsAt: toIso(v.startsAt), endsAt: toIso(v.endsAt), published: v.published, notify: Boolean(v.notify && v.published),
          };
          if (v.update.trim()) payload.update = v.update.trim();
          post('/api/hq/status-notices', payload)
            .then((r) => { ui.toast(r.notified?.sent ? `Saved; ${r.notified.sent} email(s) queued` : 'Saved (audited)', 'success'); load(); })
            .catch((e) => ui.toast(problemText(e), 'error', 6000));
        },
      });
      const form = sheet.el.querySelector('form');
      const kindSel = form.querySelector('[name="kind"]');
      kindSel.addEventListener('change', () => {
        const kind = kindSel.value;
        fillSelect(form.querySelector('[name="status"]'), statusOptions(kind), STATUSES[kind][0]);
        fillSelect(form.querySelector('[name="impact"]'), impactOptions(kind), kind === 'maintenance' ? 'maintenance' : 'minor');
      });
    }

    function edit(n) {
      ui.formSheet({
        title: 'Edit notice',
        wide: true,
        fields: [
          { label: 'Title (public)', name: 'title', value: n.title, required: true, span: true },
          { label: 'Status', name: 'status', type: 'select', value: n.status, options: statusOptions(n.kind) },
          { label: 'Impact', name: 'impact', type: 'select', value: n.impact, options: impactOptions(n.kind) },
          { label: 'Window starts', name: 'startsAt', type: 'datetime-local', value: localInput(n.startsAt) },
          { label: 'Window ends', name: 'endsAt', type: 'datetime-local', value: localInput(n.endsAt) },
          ...componentFields(n.components),
        ],
        extra: h('p', { class: 'muted hq-small' }, 'To tell people what changed, use "Post update" instead: it adds to the public timeline.'),
        submitLabel: 'Save',
        onSubmit: (v) => {
          patch(`/api/hq/status-notices/${n.id}`, {
            title: v.title.trim(), status: v.status, impact: v.impact, components: pickComponents(v), startsAt: toIso(v.startsAt), endsAt: toIso(v.endsAt),
          }).then(() => { ui.toast('Saved (audited)', 'success'); load(); }).catch((e) => ui.toast(problemText(e), 'error', 6000));
        },
      });
    }

    function postUpdate(n) {
      const subs = data.settings.subscribeEnabled && n.published;
      const next = STATUSES[n.kind].find((s) => s === n.status) || STATUSES[n.kind][0];
      ui.formSheet({
        title: `Post an update: ${n.title}`,
        fields: [
          { label: 'Status', name: 'status', type: 'select', value: next, options: statusOptions(n.kind) },
          { label: 'Update (public, plain text)', name: 'body', type: 'textarea', value: '', required: true, span: true, rows: 5 },
          subs ? { label: `Email subscribers (${data.subscribers.confirmed})`, name: 'notify', type: 'checkbox', value: false, span: true } : null,
        ].filter(Boolean),
        extra: n.published ? null : h('p', { class: 'muted hq-small' }, 'This notice is a draft: the update shows publicly once you publish it.'),
        submitLabel: 'Post',
        onSubmit: (v) => {
          post(`/api/hq/status-notices/${n.id}/updates`, { status: v.status, body: v.body.trim(), notify: Boolean(v.notify) })
            .then((r) => { ui.toast(r.notified?.sent ? `Posted; ${r.notified.sent} email(s) queued` : 'Posted (audited)', 'success'); load(); })
            .catch((e) => ui.toast(problemText(e), 'error', 6000));
        },
      });
    }

    async function setPublished(n, published) {
      let notify = false;
      if (published && data.settings.subscribeEnabled && data.subscribers.confirmed) {
        notify = await ui.confirmDialog(`Also email the ${data.subscribers.confirmed} confirmed subscriber(s) about "${n.title}"?`, { title: 'Email subscribers?', okLabel: 'Publish and email', danger: false });
      }
      try {
        const r = await patch(`/api/hq/status-notices/${n.id}`, { published, ...(notify ? { notify: true } : {}) });
        ui.toast(published ? (r.notified?.sent ? `Published; ${r.notified.sent} email(s) queued` : 'Published') : 'Unpublished: now a draft', 'success');
        load();
      } catch (e) { ui.toast(problemText(e), 'error'); }
    }

    async function remove(n) {
      if (!(await ui.confirmDialog(`"${n.title}" and its timeline are deleted${n.published ? ' and disappear from the public page' : ''}. Resolving keeps the record; delete only mistakes.`, { title: 'Delete the notice?', okLabel: 'Delete' }))) return;
      try { await del(`/api/hq/status-notices/${n.id}`); ui.toast('Deleted (audited)', 'success'); load(); } catch (e) { ui.toast(e.message, 'error'); }
    }

    function open(n) {
      const timeline = n.updates.length
        ? h('ol', { class: 'hq-timeline' }, n.updates.map((u) => h('li', null,
          h('div', { class: 'row' }, ui.badge(LABEL[u.status] || u.status, NOTICE_TONE[u.status]), h('span', { class: 'muted hq-small' }, `${ui.fmtDateTime(u.at)}${u.byName ? ` · ${u.byName}` : ''}`)),
          h('div', { class: 'hq-timeline-body' }, u.body))))
        : h('p', { class: 'muted' }, 'No updates yet.');
      const sheet = ui.openSheet({
        title: n.title,
        wide: true,
        body: h('div', { class: 'stack' },
          kv(ui, [
            ['Kind', n.kind === 'maintenance' ? 'Planned maintenance' : 'Incident'],
            ['Status', ui.badge(LABEL[n.status] || n.status, NOTICE_TONE[n.status])],
            ['Visibility', n.published ? ui.badge('public', 'success') : ui.badge('draft (HQ only)', 'neutral')],
            ['Impact', IMPACT_LABEL[n.impact] || n.impact],
            ['Affects', n.components.length ? n.components.map(nameOf).join(', ') : '—'],
            n.startsAt ? ['Window', `${ui.fmtDateTime(n.startsAt)}${n.endsAt ? ` – ${ui.fmtDateTime(n.endsAt)}` : ''}`] : null,
            n.resolvedAt ? [n.kind === 'maintenance' ? 'Completed' : 'Resolved', ui.fmtDateTime(n.resolvedAt)] : null,
            ['Created', `${ui.fmtDateTime(n.createdAt)}${n.createdByName ? ` by ${n.createdByName}` : ''}`],
          ]),
          h('h3', { class: 'hq-subhead' }, 'Public timeline'),
          timeline),
        actions: isAdmin ? [
          ui.button('Delete', { variant: 'ghost danger', icon: 'trash', onClick: () => { sheet.close(); remove(n); } }),
          h('span', { class: 'grow' }),
          ui.button(n.published ? 'Unpublish' : 'Publish', { variant: 'secondary', icon: n.published ? 'eye-off' : 'eye', onClick: () => { sheet.close(); setPublished(n, !n.published); } }),
          ui.button('Edit', { variant: 'secondary', icon: 'edit', onClick: () => { sheet.close(); edit(n); } }),
          ui.button('Post update', { variant: 'primary', icon: 'send', onClick: () => { sheet.close(); postUpdate(n); } }),
        ] : [h('span', { class: 'muted hq-small' }, 'HQ admins post and change notices.')],
      });
    }

    const load = () => loader(ui, body, async () => { data = await get('/api/hq/status-notices'); draw(); });
    load();
    return () => {};
  },
};
