// Compliance & security: controls (compliance/controls.yaml), the access review, incidents,
// vendors, HQ staff policy acknowledgements and the HQ activity log.
import { get, patch, post, put } from '../api.js';
import { TONE, ago } from '../fmt.js';

const TABS = [
  { id: 'controls', label: 'Controls' }, { id: 'access', label: 'Access review' }, { id: 'incidents', label: 'Incidents' },
  { id: 'vendors', label: 'Vendors' }, { id: 'policies', label: 'Policies' }, { id: 'activity', label: 'HQ activity' },
];
const EXPECTED_SHAPE = `controls:
  - id: CC6.1
    title: MFA for owners, admins and HQ staff
    tsc: [CC6.1]
    owner: Kelvin
    frequency: continuous
    evidence: server/test/auth.test.js
    status: implemented
    links: [docs/architecture/adr-003-auth-sessions.md]`;

export default {
  render(root, { ui, params, nav, isAdmin }) {
    const { h } = ui;
    const tab = TABS.some((t) => t.id === params[0]) ? params[0] : 'controls';
    const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading…'));
    root.append(ui.page({ title: 'Compliance & security', subtitle: 'SOC 2-aligned controls and the evidence HQ keeps' },
      h('div', { class: 'hq-toolbar' }, ui.tabs(TABS, tab, (id) => nav(`compliance/${id}`))), body));

    const fail = (e) => { ui.clear(body); body.append(ui.empty({ icon: 'alert', title: 'Could not load', text: e.message })); };
    const done = (msg) => { ui.toast(msg, 'success'); render(); };
    const err = (e) => ui.toast(e.message, 'error');

    // ---- controls ---------------------------------------------------------------
    async function controls() {
      const r = await get('/api/hq/compliance/controls');
      ui.clear(body);
      if (!r.found) {
        body.append(ui.empty({ icon: 'shield-check', title: `${r.file} not found`, text: 'The platform workstream writes the controls list. Until it lands there is nothing to show. HQ expects this shape:' }),
          h('pre', { class: 'hq-json' }, EXPECTED_SHAPE));
        return;
      }
      if (r.error) { body.append(h('div', { class: 'hq-banner danger' }, ui.icon('alert', 20), h('div', null, h('strong', null, `${r.file}`), h('span', { class: 'hq-small' }, r.error)))); return; }
      const by = r.summary.byStatus;
      body.append(h('div', { class: 'grid hq-stats' },
        ui.stat({ label: 'Controls', value: r.summary.total, hint: `${r.file} · updated ${ago(r.updatedAt)}` }),
        ...Object.entries(by).map(([k, n]) => ui.stat({ label: k.replace(/[-_]/g, ' '), value: n, tone: k === 'implemented' ? 'success' : ['gap', 'not-started'].includes(k) ? 'danger' : null }))));
      body.append(ui.table({
        columns: [
          { key: 'id', label: 'Control', render: (c) => h('strong', { class: 'mono' }, c.id), sort: (c) => c.id },
          { key: 'title', label: 'Title', render: (c) => h('div', null, c.title, c.description ? h('div', { class: 'muted hq-small' }, c.description.slice(0, 200)) : null) },
          { key: 'tsc', label: 'TSC', render: (c) => h('div', { class: 'hq-pill-list' }, c.tsc.map((x) => ui.badge(x, 'info'))) },
          { key: 'owner', label: 'Owner', render: (c) => c.owner || '—', sort: (c) => c.owner || '' },
          { key: 'frequency', label: 'Frequency', render: (c) => c.frequency || '—' },
          { key: 'status', label: 'Status', render: (c) => ui.badge(c.status, TONE[c.status] || 'neutral'), sort: (c) => c.status },
          { key: 'evidence', label: 'Evidence and links', render: (c) => h('div', { class: 'hq-small' }, [...c.evidence, ...c.links].map((x) => h('div', { class: 'mono' }, /^https:\/\//.test(x) ? h('a', { href: x, target: '_blank', rel: 'noopener noreferrer' }, x) : x))) },
        ],
        rows: r.controls,
      }));
    }

    // ---- access review ------------------------------------------------------------
    async function access() {
      const r = await get('/api/hq/compliance/access-review');
      ui.clear(body);
      body.append(h('div', { class: 'grid hq-stats' },
        ui.stat({ label: 'HQ staff', value: r.summary.staff }),
        ui.stat({ label: 'Company owners & admins', value: r.summary.tenantAdmins }),
        ui.stat({ label: 'Without two-step', value: r.summary.withoutMfa, tone: r.summary.withoutMfa ? 'danger' : 'success' }),
        ui.stat({ label: 'Flagged', value: r.summary.flagged, tone: r.summary.flagged ? 'accent' : 'success' }),
        ui.stat({ label: 'Last review', value: r.lastCompleted ? ago(r.lastCompleted.at) : 'Never', hint: r.lastCompleted ? `by ${r.lastCompleted.by}` : 'Do one each quarter' })));
      body.append(h('div', { class: 'row' }, h('span', { class: 'muted hq-small grow' }, 'Viewing this list is logged. Mark the review complete when you have checked everyone below; that is the evidence for the quarter.'),
        ui.button('Mark review complete', { variant: 'primary', icon: 'check', onClick: async () => {
          const notes = await ui.promptDialog('Notes (optional): what you changed or followed up', { title: 'Complete the access review', okLabel: 'Record' });
          if (notes == null) return;
          post('/api/hq/compliance/access-review/complete', { notes }).then(() => done('Access review recorded')).catch(err);
        } })));
      const mfa = (p) => (p.mfaEnrolled ? ui.badge('On', 'success') : ui.badge('Missing', 'danger'));
      const findings = (p) => (p.findings.length ? h('div', { class: 'hq-pill-list' }, p.findings.map((f) => ui.badge(f, 'warning'))) : ui.badge('OK', 'success'));
      body.append(...ui.section('HQ staff', ui.table({
        columns: [
          { key: 'name', label: 'Name', render: (p) => h('strong', null, p.name), sort: (p) => p.name }, { key: 'email', label: 'Email' },
          { key: 'role', label: 'Role', render: (p) => (p.role === 'hq_admin' ? 'HQ admin' : 'HQ staff') }, { key: 'mfa', label: 'Two-step', render: mfa },
          { key: 'login', label: 'Last sign-in', render: (p) => (p.lastLoginAt ? ago(p.lastLoginAt) : 'never'), sort: (p) => p.lastLoginAt || '' },
          { key: 'findings', label: 'Findings', render: findings },
        ],
        rows: r.staff,
      })));
      body.append(...ui.section('Company owners and admins', ui.table({
        columns: [
          { key: 'tenant', label: 'Company', render: (p) => h('a', { href: `#/tenants/${p.tenantId}` }, p.tenantName), sort: (p) => p.tenantName },
          { key: 'name', label: 'Person', render: (p) => h('div', null, h('strong', null, p.name), h('div', { class: 'muted hq-small' }, p.email || '')), sort: (p) => p.name },
          { key: 'role', label: 'Role' }, { key: 'mfa', label: 'Two-step', render: mfa },
          { key: 'login', label: 'Last sign-in', render: (p) => (p.lastLoginAt ? ago(p.lastLoginAt) : 'never'), sort: (p) => p.lastLoginAt || '' },
          { key: 'findings', label: 'Findings', render: findings },
        ],
        rows: r.tenantAdmins,
        empty: ui.empty({ icon: 'users', title: 'No company admins' }),
      })));
    }

    // ---- incidents ------------------------------------------------------------------
    async function incidents() {
      const r = await get('/api/hq/compliance/incidents');
      ui.clear(body);
      body.append(h('div', { class: 'row' }, h('span', { class: 'grow' }), ui.button('Open incident', { variant: 'primary', icon: 'plus', onClick: openIncident })));
      body.append(ui.table({
        columns: [
          { key: 'n', label: '#', render: (i) => h('strong', { class: 'mono' }, `INC-${i.number}`), sort: (i) => i.number },
          { key: 'title', label: 'Title', render: (i) => h('div', null, i.title, i.customerImpact ? h('div', { class: 'hq-small' }, ui.badge('customer impact', 'danger')) : null) },
          { key: 'sev', label: 'Severity', render: (i) => ui.badge(i.severity.toUpperCase(), TONE[i.severity]), sort: (i) => i.severity },
          { key: 'status', label: 'Status', render: (i) => ui.badge(i.status, TONE[i.status]), sort: (i) => i.status },
          { key: 'opened', label: 'Opened', render: (i) => `${ui.fmtDateTime(i.openedAt)} · ${i.openedBy || '—'}`, sort: (i) => i.openedAt },
          { key: 'updated', label: 'Updated', render: (i) => ago(i.updatedAt) },
        ],
        rows: r.data,
        onRowClick: (i) => showIncident(i.id),
        empty: ui.empty({ icon: 'shield-check', title: 'No incidents', text: 'Open one for anything that affects customers, security or data.' }),
      }));
    }

    function openIncident() {
      ui.formSheet({
        title: 'Open an incident',
        fields: [
          { label: 'Title', name: 'title', required: true, span: true },
          { label: 'Severity', name: 'severity', type: 'select', value: 'sev3', options: [{ value: 'sev1', label: 'SEV1: outage or data exposure' }, { value: 'sev2', label: 'SEV2: major feature down' }, { value: 'sev3', label: 'SEV3: degraded' }, { value: 'sev4', label: 'SEV4: minor' }] },
          { label: 'Customers affected', name: 'customerImpact', type: 'checkbox' },
          { label: 'What is happening', name: 'summary', type: 'textarea', span: true },
        ],
        submitLabel: 'Open',
        onSubmit: (v) => { post('/api/hq/compliance/incidents', v).then((r) => { done(`INC-${r.number} opened`); showIncident(r.id); }).catch(err); },
      });
    }

    async function showIncident(id) {
      let i;
      try { i = await get(`/api/hq/compliance/incidents/${id}`); } catch (e) { err(e); return; }
      const note = h('textarea', { rows: 3, placeholder: 'What happened, what you did, what is next' });
      const status = h('select', null, ['', 'open', 'monitoring', 'resolved', 'closed'].map((s) => h('option', { value: s }, s ? `Set status: ${s}` : 'Status unchanged')));
      const sev = h('select', null, ['', 'sev1', 'sev2', 'sev3', 'sev4'].map((s) => h('option', { value: s }, s ? `Set severity: ${s.toUpperCase()}` : 'Severity unchanged')));
      const sheet = ui.openSheet({
        title: `INC-${i.number} ${i.title}`, wide: true,
        body: h('div', { class: 'stack' },
          h('div', { class: 'row' }, ui.badge(i.severity.toUpperCase(), TONE[i.severity]), ui.badge(i.status, TONE[i.status]), h('span', { class: 'muted hq-small' }, `Opened ${ui.fmtDateTime(i.openedAt)} by ${i.openedBy || '—'}${i.resolvedAt ? ` · resolved ${ui.fmtDateTime(i.resolvedAt)}` : ''}`)),
          i.summary ? h('p', { style: { margin: 0 } }, i.summary) : null,
          h('div', { class: 'list' }, i.timeline.map((e) => h('div', { class: 'list-row' }, ui.badge(e.kind, e.kind === 'status' ? 'info' : e.kind === 'severity' ? 'warning' : 'neutral'),
            h('div', { class: 'grow' }, h('div', { style: { whiteSpace: 'pre-wrap' } }, e.body), h('div', { class: 'meta' }, `${e.author || 'HQ'} · ${ui.fmtDateTime(e.at)}`))))),
          h('label', { class: 'field' }, h('span', null, 'Add to the timeline'), note),
          h('div', { class: 'form-grid' }, h('label', { class: 'field' }, h('span', null, 'Status'), status), h('label', { class: 'field' }, h('span', null, 'Severity'), sev))),
        actions: [ui.button('Close', { variant: 'ghost', onClick: () => sheet.close() }), ui.button('Add update', { variant: 'primary', onClick: () => {
          const b = { ...(note.value.trim() ? { body: note.value.trim() } : {}), ...(status.value ? { status: status.value } : {}), ...(sev.value ? { severity: sev.value } : {}) };
          if (!Object.keys(b).length) { ui.toast('Write a note or change the status', 'error'); return; }
          post(`/api/hq/compliance/incidents/${id}/events`, b).then(() => { sheet.close(); done('Incident updated'); showIncident(id); }).catch(err);
        } })],
      });
    }

    // ---- vendors ----------------------------------------------------------------------
    async function vendors() {
      const r = await get('/api/hq/compliance/vendors');
      ui.clear(body);
      if (isAdmin) body.append(h('div', { class: 'row' }, h('span', { class: 'grow' }), ui.button('Add vendor', { variant: 'primary', icon: 'plus', onClick: () => editVendor(null) })));
      const today = new Date().toISOString().slice(0, 10);
      body.append(ui.table({
        columns: [
          { key: 'name', label: 'Vendor', render: (v) => h('div', null, h('strong', null, v.name), h('div', { class: 'muted hq-small' }, v.purpose)), sort: (v) => v.name },
          { key: 'data', label: 'Data shared', render: (v) => h('span', { class: 'hq-small' }, v.dataShared || '—') },
          { key: 'risk', label: 'Risk', render: (v) => ui.badge(v.risk, TONE[v.risk]), sort: (v) => ['low', 'medium', 'high'].indexOf(v.risk) },
          { key: 'assurance', label: 'Assurance', render: (v) => h('div', { class: 'hq-small' }, v.assurance || '—', h('div', null, v.dpaSigned ? ui.badge('DPA signed', 'success') : ui.badge('No DPA', 'warning'))) },
          { key: 'status', label: 'Status', render: (v) => ui.badge(v.status, TONE[v.status]) },
          { key: 'review', label: 'Review', render: (v) => h('div', { class: 'hq-small' }, v.lastReviewedAt ? `last ${ui.fmtDate(v.lastReviewedAt)}` : 'never reviewed', v.reviewDue ? h('div', null, v.reviewDue < today ? ui.badge(`due ${v.reviewDue}`, 'danger') : `next ${v.reviewDue}`) : null) },
        ],
        rows: r.data,
        onRowClick: isAdmin ? (v) => editVendor(v) : null,
      }));
    }

    function editVendor(v) {
      const fields = [
        { label: 'Name', name: 'name', value: v?.name, required: true },
        { label: 'Status', name: 'status', type: 'select', value: v?.status || 'evaluating', options: ['evaluating', 'active', 'retired'] },
        { label: 'Purpose', name: 'purpose', value: v?.purpose, span: true },
        { label: 'Data shared', name: 'dataShared', value: v?.dataShared, span: true },
        { label: 'Risk', name: 'risk', type: 'select', value: v?.risk || 'medium', options: ['low', 'medium', 'high'] },
        { label: 'Assurance (e.g. SOC 2 Type II report, 2026)', name: 'assurance', value: v?.assurance },
        { label: 'DPA signed', name: 'dpaSigned', type: 'checkbox', value: v?.dpaSigned },
        { label: 'Next review due', name: 'reviewDue', type: 'date', value: v?.reviewDue || '' },
        { label: 'Notes', name: 'notes', type: 'textarea', value: v?.notes, span: true },
      ];
      ui.formSheet({
        title: v ? v.name : 'Add vendor', fields, submitLabel: 'Save',
        extra: v ? h('div', { class: 'row' }, ui.button('Mark reviewed today', { icon: 'check', onClick: () => patch(`/api/hq/compliance/vendors/${v.id}`, { reviewed: true }).then(() => done('Review recorded')).catch(err) })) : null,
        onSubmit: (x) => {
          const b = { ...x, reviewDue: x.reviewDue || null };
          (v ? patch(`/api/hq/compliance/vendors/${v.id}`, b) : post('/api/hq/compliance/vendors', b)).then(() => done('Vendor saved')).catch(err);
        },
      });
    }

    // ---- policies ---------------------------------------------------------------------
    async function policies() {
      const r = await get('/api/hq/compliance/policies');
      ui.clear(body);
      const yes = ui.icon('check', 16);
      body.append(h('p', { class: 'muted', style: { margin: 0 } }, 'Every HQ staff member acknowledges the current version of each required policy. A new version asks everyone again.'));
      body.append(h('div', { class: 'table-wrap' }, h('table', { class: 'table hq-matrix' },
        h('thead', null, h('tr', null, h('th', null, 'Policy'), h('th', null, 'Version'), r.staff.map((s) => h('th', { class: 'center' }, s.name)), h('th', null, ''))),
        h('tbody', null, r.policies.map((p) => h('tr', null,
          h('td', null, h('strong', null, p.title), p.docPath ? h('div', { class: 'muted hq-small mono' }, p.docPath) : null, p.required ? null : h('div', null, ui.badge('optional'))),
          h('td', { class: 'mono' }, `v${p.version}`),
          p.acks.map((a) => h('td', { class: 'center', title: a.ackedAt ? `Acknowledged ${ui.fmtDateTime(a.ackedAt)}` : 'Not yet' }, a.ackedAt ? yes.cloneNode(true) : h('span', { class: 'hq-dot', 'aria-label': 'not yet' }, '·'))),
          h('td', { class: 'right' },
            p.mine ? h('span', { class: 'muted hq-small' }, 'You acknowledged') : ui.button('I have read it', { size: 'sm', variant: 'primary', onClick: () => post(`/api/hq/compliance/policies/${p.id}/ack`).then(() => done('Acknowledged')).catch(err) }),
            isAdmin ? ui.button('', { size: 'sm', variant: 'ghost', icon: 'edit', title: 'Edit policy', onClick: () => editPolicy(p) }) : null)))))));
      if (isAdmin) body.append(h('div', { class: 'row' }, h('span', { class: 'grow' }), ui.button('Add policy', { icon: 'plus', onClick: () => editPolicy(null) })));
    }

    function editPolicy(p) {
      ui.formSheet({
        title: p ? `Edit ${p.title}` : 'Add policy',
        fields: [
          ...(p ? [] : [{ label: 'Id (a-z, 0-9, -)', name: 'id', required: true }]),
          { label: 'Title', name: 'title', value: p?.title, required: true, span: true },
          { label: 'Version', name: 'version', value: p?.version || '1.0', required: true, hint: 'Changing it asks everyone to acknowledge again.' },
          { label: 'Document path', name: 'docPath', value: p?.docPath || '', hint: 'e.g. docs/compliance/policies/access-control.md' },
          { label: 'Required', name: 'required', type: 'checkbox', value: p ? p.required : true },
        ],
        onSubmit: (v) => { put(`/api/hq/compliance/policies/${p?.id || v.id}`, { title: v.title, version: v.version, docPath: v.docPath || null, required: v.required }).then(() => done('Policy saved')).catch(err); },
      });
    }

    // ---- HQ activity --------------------------------------------------------------------
    async function activity() {
      const r = await get('/api/hq/activity?limit=200');
      ui.clear(body);
      body.append(ui.table({
        columns: [
          { key: 'at', label: 'When', render: (e) => ui.fmtDateTime(e.at), sort: (e) => e.at },
          { key: 'actor', label: 'Who', render: (e) => e.actor || 'system' },
          { key: 'action', label: 'Action', render: (e) => ui.badge(e.action, e.action.includes('support') ? 'warning' : e.action.includes('delete') || e.action.includes('suspend') ? 'danger' : 'neutral') },
          { key: 'tenant', label: 'Company', render: (e) => (e.tenantId ? h('a', { href: `#/tenants/${e.tenantId}` }, e.tenantName || e.tenantId.slice(0, 8)) : '—') },
          { key: 'summary', label: 'Detail', render: (e) => h('span', { class: 'hq-small' }, e.summary || '—') },
        ],
        rows: r.data,
        empty: ui.empty({ icon: 'activity', title: 'No HQ activity yet' }),
      }));
    }

    function render() {
      ({ controls, access, incidents, vendors, policies, activity })[tab]().catch(fail);
    }
    render();
    return () => {};
  },
};
