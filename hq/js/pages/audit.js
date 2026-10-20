// Audit log: one hash chain at a time (the platform's, or a company's), or every HQ action,
// filtered by actor, action and date, with the chain's verification status. Opening a
// company's log is itself logged in that company's chain.
import { get, post } from '../api.js';
import { banner, dayStart, labelled, loader } from '../kit.js';

const ACTOR_TONE = { hq: 'accent', user: 'neutral', api_key: 'info', agent: 'warning', system: 'neutral' };

export default {
  render(root, { ui }) {
    const { h } = ui;
    const scope = h('select', { 'aria-label': 'Log' }, h('option', { value: 'platform' }, 'Platform (sign-ins, HQ, system)'), h('option', { value: 'hq' }, 'HQ actions in every log'));
    const actor = h('input', { placeholder: 'name, email or id', 'aria-label': 'Actor' });
    const action = h('input', { placeholder: 'e.g. hq.invoice or auth.', 'aria-label': 'Action starts with' });
    const from = h('input', { type: 'date', 'aria-label': 'From' });
    const to = h('input', { type: 'date', 'aria-label': 'To' });
    const body = h('div', { class: 'stack' });
    root.append(ui.page({ title: 'Audit log', subtitle: 'Append-only, hash-chained per company', actions: [ui.button('Verify every chain', { size: 'sm', icon: 'shield-check', onClick: verifyAll })] },
      h('form', { class: 'hq-toolbar hq-filters', onSubmit: (e) => { e.preventDefault(); search(); } },
        labelled(ui, 'Log', scope, 'hq-filter-wide'), labelled(ui, 'Actor', actor), labelled(ui, 'Action', action), labelled(ui, 'From', from), labelled(ui, 'To', to),
        ui.button('Search', { variant: 'primary', type: 'submit', icon: 'search' })),
      body));

    get('/api/hq/tenants').then((r) => {
      const g = h('optgroup', { label: 'A company\'s log (opening it is logged there)' }, r.data.sort((a, b) => a.name.localeCompare(b.name)).map((t) => h('option', { value: t.id }, t.name)));
      scope.append(g);
    }).catch(() => { /* platform and HQ only */ });

    let rows = [];
    let cursor = null;
    const filters = () => ({
      scope: scope.value, ...(actor.value.trim() ? { actor: actor.value.trim() } : {}), ...(action.value.trim() ? { action: action.value.trim() } : {}),
      ...(from.value ? { from: dayStart(from.value) } : {}), ...(to.value ? { to: dayStart(to.value, 1) } : {}), limit: 100,
    });

    function search() {
      return loader(ui, body, async () => {
        const r = await post('/api/hq/audit/search', filters());
        rows = r.data; cursor = r.cursor;
        draw(r);
      });
    }

    async function more(r0) {
      try {
        const r = await post('/api/hq/audit/search', { ...filters(), cursor });
        rows = rows.concat(r.data); cursor = r.cursor;
        draw({ ...r0, more: r.more });
      } catch (e) { ui.toast(e.message, 'error'); }
    }

    function draw(r) {
      ui.clear(body);
      if (r.verification) {
        body.append(r.verification.ok
          ? banner(ui, 'ok', `Chain intact: ${ui.fmtNum(r.verification.checked)} events verified`, r.tenantName ? `${r.tenantName}'s log` : 'Platform log')
          : banner(ui, 'danger', `Chain BROKEN${r.verification.firstBadSeq ? ` at event ${r.verification.firstBadSeq}` : ' (events missing at the end)'}`, 'Someone changed or removed audit rows outside the API. Treat this as an incident.'));
      } else {
        body.append(h('p', { class: 'muted hq-small', style: { margin: 0 } }, 'HQ actions come from every chain; pick one log to verify it.'));
      }
      body.append(ui.table({
        columns: [
          { key: 'at', label: 'When', render: (e) => h('span', { class: 'hq-small' }, ui.fmtDateTime(e.at)) },
          { key: 'actor', label: 'Who', render: (e) => h('div', null, ui.badge(e.actorType.replace('_', ' '), ACTOR_TONE[e.actorType]), ' ', h('span', { class: 'hq-small' }, e.actor || e.actorId || '—')) },
          { key: 'action', label: 'Action', render: (e) => h('span', { class: 'mono hq-small' }, e.action) },
          { key: 'summary', label: 'What', render: (e) => h('div', { class: 'hq-small' }, e.summary || '—', e.collection ? h('div', { class: 'muted' }, `${e.collection}${e.recordId ? ` · ${e.recordId}` : ''}`) : null) },
          r.scope === 'hq' ? { key: 'co', label: 'Log', render: (e) => (e.tenantName || (e.tenantId ? 'deleted company' : 'platform')) } : null,
          { key: 'ip', label: 'IP / request', render: (e) => h('div', { class: 'mono hq-small muted' }, e.ip || '—', e.requestId ? h('div', null, e.requestId.slice(0, 8)) : null) },
        ].filter(Boolean),
        rows,
        empty: ui.empty({ icon: 'list', title: 'No events match' }),
      }));
      if (r.more) body.append(h('div', { class: 'row' }, ui.button('Load older', { onClick: () => more(r) })));
    }

    async function verifyAll() {
      try {
        const r = await post('/api/hq/audit/verify-all');
        ui.openSheet({
          title: r.ok ? 'Every chain is intact' : 'A chain is broken', body: ui.table({
            columns: [
              { key: 'name', label: 'Log', render: (c) => c.name },
              { key: 'n', label: 'Events', align: 'right', render: (c) => ui.fmtNum(c.checked) },
              { key: 'ok', label: '', render: (c) => (c.ok ? ui.badge('intact', 'success') : ui.badge(`broken at ${c.firstBadSeq ?? 'end'}`, 'danger')) },
            ],
            rows: r.chains,
          }),
        });
      } catch (e) { ui.toast(e.message, 'error'); }
    }

    search();
    return () => {};
  },
};
