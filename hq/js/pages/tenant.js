// One company: plan, seats, billing, members (with MFA), QuickBooks health with pause and
// release, plan editor with overrides, suspend/reactivate, export, two-step delete, and
// time-boxed read-only support access.
import { FEATURE_PLAN, PLANS } from '/js/plans.js';
import { del, get, patch, post } from '../api.js';
import { TONE, ago, daysUntil, planName } from '../fmt.js';

const COLLECTIONS = ['clients', 'leads', 'jobs', 'schedule', 'estimates', 'invoices', 'payments', 'items', 'employees', 'timeEntries', 'drawings',
  'wireRuns', 'bends', 'panels', 'permits', 'inspections', 'certifications', 'checklists', 'sops', 'sequences', 'enrolments', 'outbox', 'locations',
  'stockMoves', 'benderProfiles', 'settings', 'auditLog'];
const QBO_PAUSE = { user: 'by the company', plan: 'plan below Pro', budget: 'workspace read budget used up', tenant_budget: 'its read budget used up', brake: 'safety brake', hq: 'by Fishtape support' };

export default {
  render(root, { ui, params, nav, isAdmin, me }) {
    const { h } = ui;
    const id = params[0];
    let t = null;
    let supportView = { collection: 'clients', rows: null };
    let timer = null;
    const host = h('div', { class: 'content' }, h('p', { class: 'muted' }, 'Loading…'));
    root.append(host);

    async function load() {
      try { t = await get(`/api/hq/tenants/${encodeURIComponent(id)}`); draw(); } catch (e) {
        ui.clear(host);
        host.append(ui.empty({ icon: 'alert', title: e.status === 404 ? 'No such company' : 'Could not load', text: e.message, action: ui.button('All companies', { onClick: () => nav('tenants') }) }));
      }
    }

    const act = (fn, ok) => async () => {
      try { await fn(); if (ok) ui.toast(ok, 'success'); await load(); } catch (e) { ui.toast(e.message, 'error'); }
    };

    function draw() {
      ui.clear(host);
      const actions = [
        ui.button('Back', { icon: 'chevron-left', variant: 'ghost', onClick: () => nav('tenants') }),
        isAdmin && t.status === 'active' ? ui.button('Suspend', { variant: 'danger', icon: 'lock', onClick: suspend }) : null,
        isAdmin && t.status === 'suspended' ? ui.button('Reactivate', { variant: 'primary', icon: 'unlock', onClick: act(() => post(`/api/hq/tenants/${id}/status`, { status: 'active' }), 'Reactivated') }) : null,
        isAdmin && t.status === 'closed' ? ui.button('Cancel deletion', { variant: 'primary', icon: 'undo', onClick: restore }) : null,
        ui.button('Verify audit chain', { icon: 'shield-check', onClick: verify }),
      ].filter(Boolean);
      const subtitle = `${t.slug} · ${t.province || 'no province'} · created ${ui.fmtDate(t.createdAt)} · ${t.lastActiveAt ? `active ${ago(t.lastActiveAt)}` : 'never active'}`;
      host.append(h('header', { class: 'page-head' },
        h('div', null, h('h1', null, t.name, ' ', ui.badge(t.status === 'closed' ? 'closing' : t.status, TONE[t.status])), h('div', { class: 'sub' }, subtitle)),
        h('div', { class: 'actions' }, actions)));

      if (t.status === 'suspended') host.append(banner('danger', 'Suspended', t.statusReason || ''));
      if (t.status === 'closed') host.append(banner('danger', `Scheduled for deletion ${ui.fmtDate(t.deleteAfter)} (${ago(t.deleteAfter)})`, `Reason: ${t.statusReason || '—'}. The worker deletes everything after this date; until then you can cancel.`));
      if (t.billing.graceEndsAt) host.append(banner('degraded', 'Payment failed', `Features stay on until ${ui.fmtDate(t.billing.graceEndsAt)}, then the company falls back to Starter.`));

      const trialLeft = daysUntil(t.trialEndsAt);
      host.append(h('div', { class: 'grid hq-stats' },
        ui.stat({ label: 'Plan in force', value: planName(t.effectivePlan), hint: (t.onTrial ?? t.plan === 'trial') ? `Trial · ${t.trialEndsAt ? (trialLeft >= 0 ? `${trialLeft} days left` : 'ended') : 'no end date'}` : `Set to ${planName(t.plan)}` }),
        ui.stat({ label: 'Seats', value: `${t.seats.used} / ${t.seats.included ?? '∞'}`, hint: t.seats.extra ? `${t.seats.extra} extra user(s) billed` : 'within the plan', tone: t.seats.extra ? 'accent' : null }),
        ui.stat({ label: 'Billing', value: t.billing.status === 'none' ? 'Not subscribed' : t.billing.status.replace(/_/g, ' '), hint: t.billing.currentPeriodEnd ? `Renews ${ui.fmtDate(t.billing.currentPeriodEnd)}${t.billing.cancelAtPeriodEnd ? ' (cancels)' : ''}` : t.billing.hasCustomer ? 'Customer, no subscription' : 'No Stripe customer' }),
        ui.stat({ label: 'Records', value: ui.fmtNum(Object.values(t.recordCounts).reduce((a, b) => a + b, 0)), hint: `${t.devices} devices · ${t.apiKeys} API keys` }),
        // Self-serve sign-up: the $1 deposit paid at Checkout and credited to the first invoice.
        t.signup ? ui.stat({
          label: 'Sign-up deposit', value: t.signup.depositPaid ? ui.fmtMoney(t.signup.depositCents ?? 100) : 'Not paid',
          hint: `${t.signup.depositCredited ? 'Credited to the first invoice' : t.signup.creditError ? `Credit failed (${t.signup.creditError}): add it in Stripe` : 'Not credited yet'}${t.signup.emailVerified ? '' : ' · email not confirmed'}`,
          tone: t.signup.creditError ? 'danger' : null,
        }) : null));

      host.append(...ui.section('Members', ui.table({
        columns: [
          { key: 'name', label: 'Name', render: (m) => h('strong', null, m.name), sort: (m) => m.name },
          { key: 'email', label: 'Email', render: (m) => m.email || h('span', { class: 'muted' }, 'PIN only') },
          { key: 'role', label: 'Role', render: (m) => m.role, sort: (m) => m.role },
          { key: 'status', label: 'Status', render: (m) => ui.badge(m.status, m.status === 'active' ? 'success' : m.status === 'invited' ? 'info' : 'neutral') },
          { key: 'mfa', label: 'Two-step', render: (m) => (m.mfaEnrolled ? ui.badge('On', 'success') : ['owner', 'admin'].includes(m.role) ? ui.badge('Missing', 'danger') : ui.badge('Off', 'neutral')) },
          { key: 'login', label: 'Last sign-in', render: (m) => (m.lastLoginAt ? ago(m.lastLoginAt) : 'never'), sort: (m) => m.lastLoginAt || '' },
        ],
        rows: t.members,
        empty: ui.empty({ icon: 'users', title: 'No members' }),
      })));

      if (t.quickbooks) host.append(...ui.section('QuickBooks', quickbooksCard()));
      host.append(...ui.section('Plan and features', planEditor()));
      host.append(...ui.section('Support access', supportSection()));

      const counts = Object.entries(t.recordCounts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
      host.append(h('div', { class: 'grid-2' },
        h('div', null, ...ui.section('Records', counts.length
          ? h('div', { class: 'card flat' }, h('dl', { class: 'hq-kv' }, counts.map(([c, n]) => [h('dt', null, c), h('dd', null, ui.fmtNum(n))])))
          : h('div', { class: 'card flat muted' }, 'No records yet.'))),
        h('div', null, ...ui.section('HQ and system events', t.hqEvents.length
          ? h('div', { class: 'list' }, t.hqEvents.slice(0, 12).map((e) => h('div', { class: 'list-row' }, h('div', { class: 'grow' }, h('div', { class: 'title hq-small' }, e.summary || e.action), h('div', { class: 'meta' }, `${e.action} · ${e.actor || 'system'} · ${ago(e.at)}`)))))
          : h('div', { class: 'card flat muted' }, 'Nothing yet.')))));

      if (isAdmin) host.append(...ui.section('Data and deletion', dangerZone()));
    }

    function banner(tone, title, text) {
      return h('div', { class: ['hq-banner', tone] }, ui.icon('alert', 20), h('div', null, h('strong', null, title), text ? h('span', { class: 'hq-small' }, text) : null));
    }

    // ---- QuickBooks: health (counts only), pause/resume and release ------------------
    function quickbooksCard() {
      const q = t.quickbooks;
      if (q.state === 'not_connected') return h('div', { class: 'card flat muted' }, 'Not connected to QuickBooks.');
      const tone = { active: 'success', setup: 'info', paused: 'warning', reconnect_needed: 'danger', disconnected: 'neutral' }[q.state] || 'neutral';
      const stateText = q.state === 'paused' ? `paused: ${QBO_PAUSE[q.pauseReason] || q.pauseReason}`
        : q.state === 'reconnect_needed' ? `reconnect needed (${q.reconnectReason || 'unknown'})` : q.state;
      const when = (v) => (v ? `${ui.fmtDateTime(v)} (${ago(v)})` : '—');
      const n = (v, danger) => (v ? ui.badge(ui.fmtNum(v), danger ? 'danger' : 'warning') : '0');
      const usage = q.usageThisMonth;
      const rows = [
        ['State', ui.badge(stateText, tone)],
        ['QuickBooks', `${q.edition || 'edition unknown'} · ${q.environment}`],
        ['Connected', when(q.connectedAt)],
        ['Last pull / push', `${q.lastPullAt ? ago(q.lastPullAt) : 'never'} / ${q.lastPushAt ? ago(q.lastPushAt) : 'never'}`],
        ['Last webhook', q.lastWebhookAt ? ago(q.lastWebhookAt) : 'never'],
        ['Last daily check', q.lastCheckAt ? ago(q.lastCheckAt) : 'never'],
        ['Links', Object.entries(q.links).filter(([, v]) => v).map(([k, v]) => `${k.replace(/_/g, ' ')} ${ui.fmtNum(v)}`).join(' · ') || 'none'],
        ['Errors (24 h)', n(q.errors24h, true)],
        ['Open conflicts', n(q.conflictsOpen)],
        ['Webhook backlog', n(q.inboxBacklog)],
        ['Waiting to send', q.outboxWaiting ? `${ui.fmtNum(q.outboxWaiting)} (oldest ${ago(q.outboxOldestAt)})` : '0'],
        ['Reads this month', `${ui.fmtNum(usage.coreplus)} of ${ui.fmtNum(usage.budget)} · ${ui.fmtNum(usage.core)} writes`],
        ['Token renews by', when(q.refreshExpiresAt)],
        ['Reconnect before', when(q.hardExpiresAt)],
      ];
      if (q.pausedSince) rows.splice(1, 0, ['Paused since', when(q.pausedSince)]);
      const hqPaused = q.state === 'paused' && q.pauseReason === 'hq';
      const canPause = ['setup', 'active', 'paused'].includes(q.state) && !hqPaused;
      return h('div', { class: ['card stack', q.state === 'reconnect_needed' || q.errors24h ? 'hq-danger-zone' : ''] },
        h('dl', { class: 'hq-kv' }, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
        q.recentErrors.length ? h('details', null, h('summary', { class: 'hq-small' }, `Last ${q.recentErrors.length} errors (codes and Intuit transaction ids, for Intuit support)`),
          h('div', { class: 'list' }, q.recentErrors.map((e) => h('div', { class: 'list-row hq-small' },
            h('span', { class: 'grow' }, `${e.direction} ${e.action}${e.collection ? ` · ${e.collection}` : ''}${e.errorCode ? ` · fault ${e.errorCode}` : ''}`),
            h('span', { class: 'mono muted' }, e.intuitTid || '—'), h('span', { class: 'muted' }, ago(e.at)))))) : null,
        h('p', { class: 'muted hq-small', style: { margin: 0 } }, 'Counts only: HQ never sees the company\'s QuickBooks data. Pausing stops the sync until Fishtape resumes it; releasing disconnects this company so its QuickBooks company can be connected elsewhere.'),
        h('div', { class: 'row' }, h('span', { class: 'grow' }),
          canPause ? ui.button('Pause QuickBooks sync', { icon: 'stop', onClick: () => qboPause(true) }) : null,
          hqPaused ? ui.button('Resume', { variant: 'primary', icon: 'play', onClick: () => qboPause(false) }) : null,
          isAdmin && q.state !== 'disconnected' ? ui.button('Release QuickBooks company', { variant: 'danger', icon: 'unlock', onClick: qboRelease }) : null));
    }

    async function qboPause(paused) {
      const reason = await ui.promptDialog('Reason (shown in the company\'s audit log)', { title: paused ? 'Pause QuickBooks sync' : 'Resume QuickBooks sync', okLabel: paused ? 'Pause' : 'Resume' });
      if (reason == null) return;
      act(() => post(`/api/hq/tenants/${id}/quickbooks/pause`, { paused, reason }), paused ? 'QuickBooks sync paused' : 'QuickBooks sync resumed')();
    }

    async function qboRelease() {
      const reason = await ui.promptDialog('Reason (shown in the company\'s audit log). The company is disconnected from QuickBooks. The worker then deletes its tokens, and revokes them at Intuit only if no other Fishtape company has connected that QuickBooks company meanwhile.', { title: `Release ${t.name}'s QuickBooks company`, okLabel: 'Release' });
      if (reason == null) return;
      act(() => post(`/api/hq/tenants/${id}/quickbooks/release`, { reason }), 'QuickBooks company released')();
    }

    // ---- plan editor --------------------------------------------------------------
    function planEditor() {
      const overrides = { ...t.overrides };
      const planSel = h('select', { name: 'plan', disabled: !isAdmin }, ['trial', 'starter', 'pro', 'business', 'enterprise'].map((p) => h('option', { value: p, selected: p === t.plan }, planName(p))));
      const trial = h('input', { type: 'date', name: 'trialEndsAt', value: t.trialEndsAt ? t.trialEndsAt.slice(0, 10) : '', disabled: !isAdmin });
      const grid = h('div', { class: 'hq-overrides' }, Object.keys(FEATURE_PLAN).map((f) => {
        const sel = h('select', { 'aria-label': `Override for ${f}`, disabled: !isAdmin, onChange: (e) => {
          if (e.target.value === '') delete overrides[f]; else overrides[f] = e.target.value === 'on';
          row.className = ['hq-override', f in overrides ? (overrides[f] ? 'on' : 'off') : ''].join(' ');
        } },
        h('option', { value: '', selected: !(f in overrides) }, `Plan (${PLANS[FEATURE_PLAN[f]]?.name || FEATURE_PLAN[f]}+)`),
        h('option', { value: 'on', selected: overrides[f] === true }, 'Always on'),
        h('option', { value: 'off', selected: overrides[f] === false }, 'Always off'));
        const row = h('label', { class: ['hq-override', f in overrides ? (overrides[f] ? 'on' : 'off') : ''] }, h('span', { class: 'mono hq-small' }, f), sel);
        return row;
      }));
      const save = ui.button('Save plan', { variant: 'primary', icon: 'save', disabled: !isAdmin, onClick: act(() => patch(`/api/hq/tenants/${id}/plan`, {
        plan: planSel.value,
        trialEndsAt: trial.value ? new Date(`${trial.value}T23:59:59`).toISOString() : null,
        overrides,
      }), 'Plan saved (logged in the company\'s audit log)') });
      return h('div', { class: 'card stack' },
        h('div', { class: 'form-grid' }, h('label', { class: 'field' }, h('span', null, 'Plan'), planSel), h('label', { class: 'field' }, h('span', null, 'Trial ends'), trial)),
        h('p', { class: 'muted hq-small', style: { margin: 0 } }, 'Overrides win over the plan. Billing webhooks may change the plan when the company pays; use an override for a lasting comp.'),
        grid,
        h('div', { class: 'row' }, h('span', { class: 'grow' }), isAdmin ? null : h('span', { class: 'muted hq-small' }, 'HQ admins change plans.'), save,
          isAdmin && t.billing.hasSubscription ? ui.button('Sync seats to Stripe', { onClick: act(() => post(`/api/hq/tenants/${id}/billing/sync-seats`), 'Seats synced') }) : null));
    }

    // ---- support access -----------------------------------------------------------
    function supportSection() {
      const wrap = h('div', { class: 'stack' });
      const mine = t.supportGrants.filter((g) => g.active && g.staffId === me.id);
      const others = t.supportGrants.filter((g) => g.active && g.staffId !== me.id);
      for (const g of others) wrap.append(h('div', { class: 'card flat hq-small' }, ui.badge('Open', 'warning'), ` ${g.staff} has read-only access until ${ui.fmtDateTime(g.expiresAt)}: "${g.reason}"`));
      if (!mine.length) {
        wrap.append(h('div', { class: 'card stack' },
          h('p', { style: { margin: 0 } }, 'Read-only access to this company\'s records, for a limited time, with a reason. Opening it, every read and closing it are written to the company\'s own audit log, which its owner sees.'),
          h('div', { class: 'row' }, ui.button('Open read-only access', { variant: 'primary', icon: 'eye', onClick: openSupport }))));
      } else {
        const g = mine[0];
        const collSel = h('select', { 'aria-label': 'Collection', onChange: (e) => { supportView.collection = e.target.value; readSupport(); } },
          COLLECTIONS.map((c) => h('option', { value: c, selected: c === supportView.collection }, c)));
        const out = h('div', { class: 'stack' });
        wrap.append(h('div', { class: 'card stack' },
          h('div', { class: 'row' }, ui.badge('Support access open', 'warning'), h('span', { class: 'muted hq-small' }, `by ${g.staff} · ends ${ago(g.expiresAt)} · "${g.reason}"`), h('span', { class: 'grow' }),
            ui.button('End now', { size: 'sm', variant: 'danger', onClick: act(() => del(`/api/hq/support-access/${g.id}`), 'Support access ended') })),
          h('div', { class: 'row' }, h('label', { class: 'field', style: { minWidth: '220px' } }, h('span', null, 'Collection'), collSel), ui.button('Read', { icon: 'eye', onClick: readSupport })),
          out));
        supportView.out = out;
        if (supportView.rows) drawSupport();
      }
      const past = t.supportGrants.filter((g) => !g.active).slice(0, 5);
      if (past.length) wrap.append(h('div', { class: 'list' }, past.map((g) => h('div', { class: 'list-row hq-small' }, h('div', { class: 'grow' }, `${g.staff}: ${g.reason}`), h('span', { class: 'muted' }, `${ui.fmtDateTime(g.createdAt)}${g.revokedAt ? ' · ended early' : ' · expired'}`)))));
      return wrap;
    }

    function openSupport() {
      ui.formSheet({
        title: 'Open read-only support access',
        fields: [
          { label: 'Why do you need access?', name: 'reason', type: 'textarea', required: true, span: true, hint: 'The company owner sees this in their security log. At least 10 characters.' },
          { label: 'For how long', name: 'minutes', type: 'select', value: '60', options: [{ value: '15', label: '15 minutes' }, { value: '30', label: '30 minutes' }, { value: '60', label: '1 hour' }, { value: '120', label: '2 hours' }, { value: '240', label: '4 hours' }, { value: '480', label: '8 hours' }] },
        ],
        submitLabel: 'Open access',
        onSubmit: (v) => {
          if (v.reason.trim().length < 10) { ui.toast('Give a reason of at least 10 characters', 'error'); return false; }
          act(() => post(`/api/hq/tenants/${id}/support-access`, { reason: v.reason.trim(), minutes: Number(v.minutes) }), 'Read-only access open')();
        },
      });
    }

    async function readSupport() {
      try {
        const r = await get(`/api/hq/tenants/${id}/support/${encodeURIComponent(supportView.collection)}?limit=50`);
        supportView.rows = r.data;
        drawSupport();
      } catch (e) { ui.toast(e.message, 'error'); if (e.code === 'support_access_required') load(); }
    }

    function drawSupport() {
      const out = supportView.out;
      if (!out) return;
      ui.clear(out);
      const rows = supportView.rows || [];
      out.append(h('div', { class: 'muted hq-small' }, `${rows.length} newest ${supportView.collection} (long values hidden). This read was logged.`));
      out.append(rows.length ? h('div', { class: 'list' }, rows.map((r) => {
        const label = r.name || r.number || r.title || r.summary || r.description || r.id;
        const pre = h('pre', { class: 'hq-json', hidden: true }, JSON.stringify(r, null, 2));
        return h('div', { class: 'list-row click', style: { flexDirection: 'column', alignItems: 'stretch' }, onClick: () => { pre.hidden = !pre.hidden; } },
          h('div', { class: 'row' }, h('strong', { class: 'grow' }, String(label).slice(0, 120)), h('span', { class: 'muted hq-small mono' }, r.id)), pre);
      })) : h('div', { class: 'card flat muted' }, 'Nothing here.'));
    }

    // ---- export and delete ------------------------------------------------------
    function dangerZone() {
      const exported = t.lastExportAt && Date.now() - new Date(t.lastExportAt).getTime() < 24 * 3600e3;
      return h('div', { class: 'card hq-danger-zone stack' },
        h('h3', null, 'Export and delete'),
        h('p', { style: { margin: 0 } }, 'Deleting is two steps. Export everything first; then close the company. Its data is purged by the worker after the grace period (30 days unless set otherwise), and you can cancel until then. The audit log is kept.'),
        h('div', { class: 'hq-steps-inline' },
          h('div', { class: ['hq-step', exported ? 'done' : ''] }, h('span', { class: 'n' }, exported ? '✓' : '1'), ui.button('Export all data (JSON)', { icon: 'download', onClick: exportData })),
          h('span', { class: 'muted hq-small' }, t.lastExportAt ? `last export ${ago(t.lastExportAt)}` : 'never exported'),
          h('div', { class: 'hq-step' }, h('span', { class: 'n' }, '2'), ui.button('Delete company…', { variant: 'danger solid', icon: 'trash', disabled: !exported || t.status === 'closed', onClick: deleteCompany }))));
    }

    async function exportData() {
      try {
        const data = await get(`/api/hq/tenants/${id}/export`);
        ui.download(`fishtape-export-${t.slug}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2));
        ui.toast('Export downloaded (logged in the company\'s audit log)', 'success');
        load();
      } catch (e) { ui.toast(e.message, 'error'); }
    }

    function deleteCompany() {
      ui.formSheet({
        title: `Delete ${t.name}`,
        fields: [
          { label: `Type the slug to confirm: ${t.slug}`, name: 'confirmSlug', required: true, span: true },
          { label: 'Reason', name: 'reason', type: 'textarea', required: true, span: true, hint: 'Kept in the audit log.' },
        ],
        submitLabel: 'Close and schedule deletion',
        onSubmit: (v) => {
          if (v.confirmSlug !== t.slug) { ui.toast('The slug does not match', 'error'); return false; }
          act(() => post(`/api/hq/tenants/${id}/delete`, { confirmSlug: v.confirmSlug, reason: v.reason }), 'Company closed; deletion scheduled')();
        },
      });
    }

    async function suspend() {
      const reason = await ui.promptDialog('Reason (shown in the company\'s audit log)', { title: `Suspend ${t.name}`, okLabel: 'Suspend' });
      if (reason == null) return;
      act(() => post(`/api/hq/tenants/${id}/status`, { status: 'suspended', reason }), 'Suspended')();
    }

    async function restore() {
      if (!(await ui.confirmDialog('The company reopens and its members can sign in again.', { title: 'Cancel the deletion?', okLabel: 'Cancel deletion', danger: false }))) return;
      act(() => post(`/api/hq/tenants/${id}/restore`), 'Deletion cancelled')();
    }

    async function verify() {
      try {
        const r = await get(`/api/hq/tenants/${id}/audit/verify`);
        ui.toast(r.ok ? `Audit chain intact (${r.checked} events)` : `Audit chain BROKEN at event ${r.firstBadSeq ?? 'end'}`, r.ok ? 'success' : 'error', 5000);
      } catch (e) { ui.toast(e.message, 'error'); }
    }

    load();
    timer = setInterval(() => { if (!document.hidden && t?.supportGrants?.some((g) => g.active)) load(); }, 60_000);
    return () => clearInterval(timer);
  },
};
