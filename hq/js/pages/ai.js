// AI: estimated spend per company and month (each company's own Anthropic key; estimates in
// US dollars), top tools, companies near their monthly cap, editing a cap (HQ admins,
// audited in the company's log), the platform model and effort (env) and recent AI errors.
import { get, put } from '../api.js';
import { ago } from '../fmt.js';
import { card, kv, loader, usd } from '../kit.js';

const CODE_HELP = {
  ai_not_connected: 'No Anthropic key connected', ai_key_rejected: 'Anthropic refused the key', ai_cap_reached: 'Monthly cap reached',
  ai_rate_limited: 'Anthropic rate limit', ai_billing: 'Anthropic account out of credit', ai_unavailable: 'Anthropic unreachable or busy',
  ai_busy: 'A reply was already running', stop_refusal: 'Model declined', stop_max_tokens: 'Reply cut off (too long)', internal: 'Server error',
};

export default {
  render(root, { ui, isAdmin }) {
    const { h } = ui;
    const body = h('div', { class: 'stack' });
    root.append(ui.page({ title: 'AI', subtitle: "Usage on each company's own Anthropic key, caps and errors" }, body));

    function editCap(c) {
      ui.formSheet({
        title: `AI cap: ${c.tenantName}`,
        extra: h('p', { class: 'muted hq-small', style: { margin: 0 } }, 'Estimated Anthropic spend per calendar month (UTC), in US dollars. At the cap the assistant stops until next month. The company sees this change in its audit log.'),
        fields: [
          { label: 'Use the platform default', name: 'useDefault', type: 'checkbox', value: c.capIsDefault },
          { label: 'Cap (US$ a month)', name: 'cap', type: 'money', value: c.capCents },
          { label: 'Reason', name: 'reason', type: 'textarea', required: true, span: true },
        ],
        submitLabel: 'Save cap',
        onSubmit: (v) => {
          if (v.reason.trim().length < 5) { ui.toast('Give a reason of at least 5 characters', 'error'); return false; }
          put(`/api/hq/ai/caps/${c.tenantId}`, { monthlyCapCents: v.useDefault ? null : v.cap, reason: v.reason.trim() })
            .then(() => { ui.toast('Cap saved', 'success'); load(); }).catch((e) => ui.toast(e.message, 'error'));
        },
      });
    }

    function draw(d) {
      ui.clear(body);
      body.append(h('div', { class: 'grid hq-stats' },
        ui.stat({ label: 'Spend this month (estimate)', value: usd(d.monthTotal.costCents), hint: `${ui.fmtNum(d.monthTotal.calls)} model call${d.monthTotal.calls === 1 ? '' : 's'}` }),
        ...d.monthTotal.byFeature.map((f) => ui.stat({ label: f.feature, value: usd(f.costCents), hint: `${ui.fmtNum(f.calls)} call${f.calls === 1 ? '' : 's'}` })),
        ui.stat({ label: 'Near or at cap', value: d.nearCap.length, hint: '80% or more of their cap', tone: d.nearCap.length ? 'warning' : null }),
        ui.stat({ label: 'Errors (7 d)', value: d.errorCounts.reduce((a, e) => a + e.count, 0), tone: d.errorCounts.length ? 'danger' : null })));

      body.append(h('div', { class: 'hq-cards' },
        card(ui, 'Platform model (env, read-only)', 'settings', kv(ui, [
          ['Model', h('span', { class: 'mono' }, d.config.model)], ['Effort', d.config.effort],
          ['Background model', h('span', { class: 'mono' }, d.config.backgroundModel)], ['Background effort', d.config.backgroundEffort],
          ['Default cap', `${usd(d.config.defaultCapCents)} a month`], ['Steps per message', d.config.maxSteps],
          ['Refusal fallback', d.config.fallbacks ? 'on' : 'off'], ['Progress notes', d.config.thinkingDisplay],
        ]), h('p', { class: 'muted hq-small' }, `Change with ${d.config.env.join(', ')} in the server .env, then restart the API and worker.`)),
        card(ui, 'Errors by code (7 d)', 'alert', d.errorCounts.length
          ? kv(ui, d.errorCounts.map((e) => [h('span', { class: 'mono hq-small' }, e.code), `${e.count} · ${CODE_HELP[e.code] || ''}`]))
          : h('p', { class: 'muted' }, 'No AI errors in 7 days.'))));

      body.append(...ui.section('Near their cap', ui.table({
        columns: [
          { key: 'co', label: 'Company', render: (c) => h('a', { href: `#/tenants/${c.tenantId}` }, c.tenantName) },
          { key: 'spent', label: 'Spent', align: 'right', render: (c) => usd(c.spentCents) },
          { key: 'cap', label: 'Cap', align: 'right', render: (c) => `${usd(c.capCents)}${c.capIsDefault ? ' (default)' : ''}` },
          { key: 'pct', label: '', render: (c) => h('div', { class: 'hq-bar hq-bar-inline' }, h('div', { class: ['progress', c.pct >= 100 ? 'bad' : 'warn'], role: 'img', 'aria-label': `${c.pct}% of cap` }, h('i', { style: { width: `${Math.min(100, c.pct)}%` } })), h('span', { class: 'right num' }, `${c.pct}%`)) },
          { key: 'act', label: '', render: (c) => (isAdmin ? ui.button('Edit cap', { size: 'sm', onClick: () => editCap(c) }) : null) },
        ],
        rows: d.nearCap,
        empty: h('div', { class: 'card flat muted' }, 'No company is at 80% of its cap.'),
      })));

      body.append(...ui.section('Caps and spend this month', ui.table({
        columns: [
          { key: 'co', label: 'Company', render: (c) => h('a', { href: `#/tenants/${c.tenantId}` }, c.tenantName), sort: (c) => c.tenantName },
          { key: 'spent', label: 'Spent', align: 'right', render: (c) => usd(c.spentCents), sort: (c) => c.spentCents },
          { key: 'cap', label: 'Cap', align: 'right', render: (c) => `${usd(c.capCents)}${c.capIsDefault ? ' (default)' : ''}`, sort: (c) => c.capCents },
          { key: 'pct', label: 'Used', align: 'right', render: (c) => `${c.pct}%`, sort: (c) => c.pct },
          { key: 'last', label: 'Last used', render: (c) => (c.lastUsedAt ? ago(c.lastUsedAt) : '—') },
          { key: 'act', label: '', render: (c) => (isAdmin ? ui.button('Edit cap', { size: 'sm', onClick: () => editCap(c) }) : null) },
        ],
        rows: d.caps,
        empty: h('div', { class: 'card flat muted' }, 'No AI use this month and no custom caps.'),
      })), isAdmin && d.companies.length ? h('div', { class: 'row' }, h('label', { class: 'field hq-filter' }, h('span', null, 'Set a cap for another company'),
        h('select', { 'aria-label': 'Company', onChange: (e) => { const c = d.companies.find((x) => x.tenantId === e.target.value); if (c) editCap({ ...c, spentCents: 0 }); e.target.value = ''; } },
          h('option', { value: '' }, 'Pick a company…'), d.companies.map((c) => h('option', { value: c.tenantId }, c.tenantName))))) : null);

      body.append(...ui.section('Spend by company and month', ui.table({
        columns: [
          { key: 'month', label: 'Month', render: (u) => u.month, sort: (u) => u.month },
          { key: 'co', label: 'Company', render: (u) => u.tenantName || 'deleted company', sort: (u) => u.tenantName || '' },
          { key: 'calls', label: 'Calls', align: 'right', render: (u) => ui.fmtNum(u.calls) },
          { key: 'in', label: 'Input tokens', align: 'right', render: (u) => ui.fmtNum(u.inputTokens) },
          { key: 'out', label: 'Output tokens', align: 'right', render: (u) => ui.fmtNum(u.outputTokens) },
          { key: 'cost', label: 'Estimated', align: 'right', render: (u) => usd(u.costCents), sort: (u) => u.costCents },
        ],
        rows: d.usage,
        empty: h('div', { class: 'card flat muted' }, 'No AI use in this period.'),
      })));

      body.append(h('div', { class: 'grid-2' },
        h('div', null, ...ui.section('Top tools (30 d)', ui.table({
          columns: [
            { key: 'tool', label: 'Tool', render: (t) => h('span', { class: 'mono hq-small' }, t.tool) },
            { key: 'via', label: 'Via', render: (t) => ui.badge(t.via, t.via === 'mcp' ? 'accent' : 'info') },
            { key: 'calls', label: 'Calls', align: 'right', render: (t) => ui.fmtNum(t.calls) },
            { key: 'err', label: 'Failed', align: 'right', render: (t) => (t.errors ? ui.badge(String(t.errors), 'warning') : '0') },
          ],
          rows: d.tools,
          empty: h('div', { class: 'card flat muted' }, 'No tool calls in 30 days.'),
        }))),
        h('div', null, ...ui.section('Recent AI errors', ui.table({
          columns: [
            { key: 'at', label: 'When', render: (e) => ago(e.at) },
            { key: 'co', label: 'Company', render: (e) => e.tenantName || '—' },
            { key: 'code', label: 'What', render: (e) => h('div', null, h('span', { class: 'mono hq-small' }, e.code), CODE_HELP[e.code] ? h('div', { class: 'muted hq-small' }, CODE_HELP[e.code]) : null) },
            { key: 'f', label: 'Where', render: (e) => e.feature },
          ],
          rows: d.errors,
          empty: h('div', { class: 'card flat muted' }, 'No AI errors recorded.'),
        })))));
      body.append(h('p', { class: 'muted hq-small' }, 'Costs are our estimate from token counts at list prices; each company\'s Anthropic invoice is the truth. Prompts and replies are never shown in HQ.'));
    }

    const load = () => loader(ui, body, async () => draw(await get('/api/hq/ai')));
    load();
    return () => {};
  },
};
