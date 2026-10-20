// Developer settings (#/developer): company API keys for scripts, integrations and AI agents
// (owners and admins, Business plan). Keys are created with a name, scopes and an optional
// expiry, shown once with a copy button, listed with their last use, and revoked in one tap.
// The server side is /api/v1/api-keys (server/src/routes/v1/admin.js); the MCP guide is the
// short form of docs/ai/mcp.md.
import { COLLECTIONS } from '../store.js';

const CODE = '<path d="M8 6l-6 6 6 6"/><path d="M16 6l6 6-6 6"/><path d="M14 4l-4 16"/>';

/** Scope presets offered first; "Custom" opens the per-collection grid. */
export const SCOPE_PRESETS = [
  { id: 'agent', label: 'AI agent that drafts estimates', scopes: ['jobs:read', 'clients:read', 'items:read', 'estimates:write'], hint: 'Reads jobs, clients and the price book; drafts estimates you approve.' },
  { id: 'read', label: 'Read everything', scopes: ['*:read'], hint: 'Reports and dashboards. Cannot change anything.' },
  { id: 'leads', label: 'Lead capture (website forms)', scopes: ['leads:write', 'clients:write'], hint: 'Creates and updates leads and clients.' },
  { id: 'custom', label: 'Custom', scopes: [], hint: 'Pick read or write per area.' },
];

const LABEL = {
  clients: 'Clients', leads: 'Leads', sequences: 'Sequences', enrolments: 'Enrolments', outbox: 'Outbox', jobs: 'Jobs', schedule: 'Schedule',
  estimates: 'Estimates', invoices: 'Invoices', payments: 'Payments', items: 'Price book', locations: 'Locations', stockMoves: 'Stock moves',
  employees: 'Employees', timeEntries: 'Time entries', drawings: 'Drawings', sops: 'SOPs', permits: 'Permits', inspections: 'Inspections',
  certifications: 'Certifications', checklists: 'Checklists', panels: 'Panels', auditLog: 'Audit log', settings: 'Settings',
  wireRuns: 'Wire runs', bends: 'Bends', benderProfiles: 'Bender profiles', materialRequests: 'Material requests',
};

/** Human summary of a scope list: "Read everything", "Jobs (read), Estimates (write)". */
export function describeScopes(scopes = []) {
  if (scopes.includes('*:write')) return 'Read and write everything';
  const parts = [];
  if (scopes.includes('*:read')) parts.push('Read everything');
  for (const s of scopes) {
    const [c, m] = s.split(':');
    if (c === '*') continue;
    parts.push(`${LABEL[c] || c} (${m})`);
  }
  return parts.join(', ') || 'No access';
}

export function keyStatus(k, now = Date.now()) {
  if (k.revokedAt) return 'revoked';
  if (k.expiresAt && Date.parse(k.expiresAt) <= now) return 'expired';
  return 'active';
}

const mcpUrl = () => `${location.origin}/api/mcp`;

function guide(ui, key = null) {
  const { h } = ui;
  const k = key || 'ft_live_YOUR_KEY';
  const pre = (text) => h('div', { class: 'dev-code' }, h('pre', null, text), ui.button('', { size: 'sm', variant: 'ghost', icon: 'copy', title: 'Copy', onClick: () => copy(ui, text) }));
  return h('div', { class: 'stack dev-guide' },
    h('p', { style: { margin: '0' } }, 'Fishtape runs an MCP (Model Context Protocol) server, so AI agents such as Claude Code or Claude Desktop can look up jobs, clients and the price book, and draft estimates for you to approve. They act for your company within the key’s scopes.'),
    h('ol', null,
      h('li', null, 'Create a key above with only the scopes the agent needs (the “AI agent that drafts estimates” preset is a good start). Copy it when it is shown: it is not shown again.'),
      h('li', null, h('span', null, 'Server address: '), h('code', null, mcpUrl()), h('span', null, ' (Streamable HTTP; the key goes in the Authorization header as Bearer).')),
      h('li', null, 'Claude Code: run this in a terminal:', pre(`claude mcp add --transport http fishtape ${mcpUrl()} --header "Authorization: Bearer ${k}"`)),
      h('li', null, 'Claude Desktop: Settings → Developer → Edit config, add this (needs Node.js), then restart Claude Desktop:',
        pre(JSON.stringify({ mcpServers: { fishtape: { command: 'npx', args: ['-y', 'mcp-remote', mcpUrl(), '--header', 'Authorization:${FISHTAPE_KEY}'], env: { FISHTAPE_KEY: `Bearer ${k}` } } } }, null, 2))),
      h('li', null, 'Ask it something like “List this week’s jobs” or “Draft an estimate for 12 receptacles at the Linden job”. Drafts wait for you in Assistant → Drafts.')),
    h('p', { class: 'muted', style: { margin: '0' } }, 'Revoke a key here the moment it is no longer needed; it stops working at once. Agents are limited to 120 requests a minute. Full guide: docs/ai/mcp.md in the Fishtape repository.'));
}

async function copy(ui, text) {
  try { await navigator.clipboard.writeText(text); ui.toast('Copied', 'success'); } catch { ui.toast('Copy blocked by the browser. Select the text and copy it.', 'error', 4000); }
}

function createSheet(ctx, onCreated) {
  const { ui } = ctx;
  const { h } = ui;
  let preset = 'agent';
  const grid = new Map(); // collection -> '' | 'read' | 'write'
  const gridHost = h('div');
  const drawGrid = () => {
    ui.clear(gridHost);
    if (preset !== 'custom') return;
    gridHost.append(h('div', { class: 'table-wrap' }, h('table', { class: 'table dev-scopes' },
      h('thead', null, h('tr', null, h('th', null, 'Area'), h('th', null, 'None'), h('th', null, 'Read'), h('th', null, 'Read + write'))),
      h('tbody', null, COLLECTIONS.map((c) => h('tr', null, h('td', null, LABEL[c] || c), ...['', 'read', 'write'].map((m) => h('td', { class: 'center' },
        h('input', { type: 'radio', name: `scope-${c}`, 'aria-label': `${LABEL[c] || c}: ${m || 'none'}`, checked: (grid.get(c) || '') === m, onChange: () => grid.set(c, m) })))))))));
  };
  const presetRadios = h('div', { class: 'stack dev-presets', role: 'radiogroup', 'aria-label': 'Access' }, SCOPE_PRESETS.map((p) => h('label', { class: 'dev-preset' },
    h('input', { type: 'radio', name: 'preset', value: p.id, checked: p.id === preset, onChange: () => { preset = p.id; drawGrid(); } }),
    h('span', null, h('strong', null, p.label), h('span', { class: 'muted' }, ` ${p.hint}`)))));
  const name = h('input', { name: 'name', required: true, maxlength: 100, placeholder: 'e.g. Claude Desktop on the office PC' });
  const expiry = h('select', { name: 'expiry' }, [['0', 'Never'], ['30', '30 days'], ['90', '90 days'], ['365', '1 year']].map(([v, l]) => h('option', { value: v, selected: v === '90' }, l)));
  const err = h('div', { role: 'alert' });
  const s = ui.openSheet({
    title: 'New API key', wide: true,
    body: h('div', { class: 'stack' },
      h('label', { class: 'field' }, h('span', null, 'Name *'), name),
      h('div', { class: 'field' }, h('span', null, 'Access'), presetRadios), gridHost,
      h('label', { class: 'field' }, h('span', null, 'Expires'), expiry), err),
    actions: [h('span', { class: 'grow' }), ui.button('Cancel', { variant: 'ghost', onClick: () => s.close() }), ui.button('Create key', { variant: 'primary', icon: 'key', onClick: create })],
  });
  async function create() {
    ui.clear(err);
    if (!name.value.trim()) { name.focus(); err.append(h('p', { class: 'imp-error' }, 'Give the key a name so you know what uses it.')); return; }
    const scopes = preset === 'custom' ? [...grid].filter(([, m]) => m).map(([c, m]) => `${c}:${m}`) : SCOPE_PRESETS.find((p) => p.id === preset).scopes;
    if (!scopes.length) { err.append(h('p', { class: 'imp-error' }, 'Pick at least one area.')); return; }
    const days = Number(expiry.value);
    const body = { name: name.value.trim(), scopes, ...(days ? { expiresAt: new Date(Date.now() + days * 86400000).toISOString() } : {}) };
    try {
      const { api } = await import('../session.js');
      const r = await api.post('/api/v1/api-keys', body);
      s.close();
      onCreated(r);
    } catch (e) { err.append(h('p', { class: 'imp-error' }, e.message)); }
  }
}

function showKeyOnce(ctx, r) {
  const { ui } = ctx;
  const { h } = ui;
  const keyInput = h('input', { class: 'input mono', readonly: true, value: r.key, 'aria-label': 'Your new API key', onFocus: (e) => e.target.select() });
  const s = ui.openSheet({
    title: 'Copy your key now', wide: true,
    body: h('div', { class: 'stack' },
      h('div', { class: 'dev-once', role: 'note' }, ui.icon('alert', 16), h('span', null, 'This is the only time the key is shown. Store it somewhere safe, like a password manager. Anyone with it can act for your company within its scopes.')),
      h('div', { class: 'int-inline' }, keyInput, ui.button('Copy', { icon: 'copy', variant: 'primary', onClick: () => copy(ui, r.key) })),
      h('div', { class: 'muted' }, `${r.apiKey.name} · ${describeScopes(r.apiKey.scopes)}${r.apiKey.expiresAt ? ` · expires ${ui.fmtDate(r.apiKey.expiresAt)}` : ''}`),
      h('details', { class: 'card flat' }, h('summary', null, 'Connect an AI agent with this key'), guide(ui, r.key))),
    actions: [h('span', { class: 'grow' }), ui.button('I have copied it', { variant: 'primary', onClick: () => s.close() })],
  });
  setTimeout(() => keyInput.select(), 50);
}

export default {
  id: 'developer',
  title: 'Developer & API keys',
  icon: CODE,
  group: 'admin',
  perm: 'settings',
  hidden: true, // reached from Settings
  render(root, ctx) {
    const { ui, auth } = ctx;
    const { h } = ui;
    const list = h('div', { 'aria-live': 'polite' });
    const newBtn = ui.button('New API key', { variant: 'primary', icon: 'plus', onClick: () => createSheet(ctx, (r) => { showKeyOnce(ctx, r); load(); }) });
    root.append(ui.page({ title: 'Developer & API keys', subtitle: 'Let scripts, integrations and AI agents work with your company’s data', actions: auth.synced && auth.isAdmin() ? [newBtn] : [] },
      list,
      h('section', { class: 'card stack', style: { marginTop: 'var(--s4)' } }, h('h3', null, 'Connect an AI agent over MCP'), guide(ui)),
      h('p', { class: 'muted' }, `API reference (OpenAPI): `, h('a', { href: '/api/v1/openapi.json', target: '_blank', rel: 'noopener' }, '/api/v1/openapi.json'))));
    let alive = true;
    async function load() {
      if (!auth.synced) { ui.clear(list).append(ui.empty({ icon: 'key', title: 'Sign in to manage API keys', text: 'API keys belong to a company on the server. The demo on this device has none.' })); return; }
      if (!auth.isAdmin()) { ui.clear(list).append(ui.empty({ icon: 'lock', title: 'Owners and admins only' })); return; }
      ui.clear(list).append(h('p', { class: 'muted' }, 'Loading keys…'));
      let data;
      try {
        const { api } = await import('../session.js');
        ({ data } = await api.get('/api/v1/api-keys'));
      } catch (e) {
        if (alive) ui.clear(list).append(ui.empty({ icon: 'alert', title: e.code === 'offline' ? 'You are offline' : 'Keys could not be loaded', text: e.code === 'offline' ? 'API keys need a connection.' : e.message }));
        return;
      }
      if (!alive) return;
      const rows = data.map((k) => ({ ...k, status: keyStatus(k) })).sort((a, b) => (a.status !== 'active') - (b.status !== 'active') || String(b.createdAt).localeCompare(String(a.createdAt)));
      ui.clear(list).append(ui.table({
        columns: [
          { key: 'name', label: 'Name', render: (k) => h('div', null, h('strong', null, k.name), h('div', { class: 'muted mono dev-prefix' }, `${k.prefix}…`)) },
          { key: 'scopes', label: 'Access', render: (k) => h('span', { class: 'dev-scope-text' }, describeScopes(k.scopes)) },
          { key: 'created', label: 'Created', render: (k) => ui.fmtDate(k.createdAt), sort: (k) => k.createdAt },
          { key: 'used', label: 'Last used', render: (k) => (k.lastUsedAt ? ui.fmtDateTime(k.lastUsedAt) : h('span', { class: 'muted' }, 'Never')), sort: (k) => k.lastUsedAt || '' },
          { key: 'expires', label: 'Expires', render: (k) => (k.expiresAt ? ui.fmtDate(k.expiresAt) : 'Never') },
          { key: 'status', label: 'Status', render: (k) => ui.badge(k.status, k.status === 'active' ? 'success' : 'neutral') },
          { key: 'x', label: '', render: (k) => (k.status === 'active' ? ui.button('Revoke', { size: 'sm', variant: 'ghost danger', onClick: async () => {
            if (!(await ui.confirmDialog(`Revoke "${k.name}"? Anything using it stops working immediately.`, { title: 'Revoke API key', okLabel: 'Revoke' }))) return;
            try { const { api } = await import('../session.js'); await api.del(`/api/v1/api-keys/${encodeURIComponent(k.id)}`); ui.toast('Key revoked', 'success'); load(); } catch (e) { ui.toast(e.message, 'error'); }
          } }) : '') },
        ],
        rows,
        empty: ui.empty({ icon: 'key', title: 'No API keys yet', text: 'Create one for each tool or agent, with only the access it needs.', action: ui.button('New API key', { variant: 'primary', icon: 'plus', onClick: () => newBtn.click() }) }),
      }));
    }
    load();
    return () => { alive = false; };
  },
};
