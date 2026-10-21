// QuickBooks Online (#/quickbooks): the office's view of the two-way sync
// (docs/integrations/quickbooks.md section 8). Overview with every connection state, the
// first-connect wizard, mappings, conflicts, the sync log and the live look-up.
//
// Office roles only (perm 'invoices': owner, admin, office); field roles and crew sessions never get
// here, and the server answers them 403 anyway. Every call goes through lib/qbo-api.js; what the
// screens show stays in memory (8.7). Offline: the last status, greyed, and no actions.
import { qboApi } from '../lib/qbo-api.js';
import * as Q from '../lib/qbo-ui.js';
import { openGuide } from './integrations.js';
import { openExternal, closeExternal, isNativeApp } from '../lib/native.js';

/** The last status this run loaded: shown greyed while offline. Memory only. */
let lastStatus = null;

const NAV = [
  { id: 'overview', label: 'Overview', href: '#/quickbooks' },
  { id: 'setup', label: 'Setup', href: '#/quickbooks/setup' },
  { id: 'mappings', label: 'Mappings', href: '#/quickbooks/mappings' },
  { id: 'conflicts', label: 'Conflicts', href: '#/quickbooks/conflicts' },
  { id: 'activity', label: 'Activity', href: '#/quickbooks/activity' },
  { id: 'lookup', label: 'Look-up', href: '#/quickbooks/lookup' },
];

export default {
  id: 'quickbooks',
  title: 'QuickBooks',
  icon: 'link',
  group: 'money',
  perm: 'invoices',
  render(root, ctx) {
    Q.ensureQboStyles();
    const [section, id] = ctx.params;
    if (!ctx.auth.synced) return demoNote(root, ctx);
    if (!Q.QBO_ROLES.includes(ctx.auth.role()) || ctx.auth.isCrew?.()) return noAccess(root, ctx);
    if (section === 'setup') return renderWizard(root, ctx);
    if (section === 'mappings') return renderMappings(root, ctx);
    if (section === 'conflicts') return id ? renderConflict(root, ctx, id) : renderConflicts(root, ctx);
    if (section === 'activity') return renderActivity(root, ctx);
    if (section === 'lookup') return renderLookup(root, ctx);
    return renderOverview(root, ctx);
  },
};

// ---------------------------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------------------------

function frame(ctx, active, { title = 'QuickBooks', subtitle, actions = [] }, ...body) {
  const { ui } = ctx;
  const { h } = ui;
  const offline = Q.isOffline(ctx);
  return ui.page({ title, subtitle: subtitle ?? 'Two-way sync with QuickBooks Online', actions: offline ? [] : actions },
    offline ? h('div', { class: 'qbo-banner info', role: 'status' }, ui.icon('alert', 16), h('span', null, "You're offline; QuickBooks needs a connection.")) : null,
    h('nav', { class: 'qbo-nav', 'aria-label': 'QuickBooks' }, NAV.map((n) => h('a', { href: n.href, class: n.id === active ? 'active' : null, 'aria-current': n.id === active ? 'page' : null }, n.label))),
    h('div', { class: ['stack', 'qbo-body', offline ? 'qbo-offline' : null] }, body),
    Q.trademarkLine(ui));
}

function demoNote(root, ctx) {
  const { ui } = ctx;
  root.append(ui.page({ title: 'QuickBooks' }, ui.empty({ icon: 'link', title: 'QuickBooks needs your company account', text: 'The demo runs on this device only. Sign in to your company to connect QuickBooks Online.' }), Q.trademarkLine(ui)));
}

function noAccess(root, ctx) {
  const { ui } = ctx;
  root.append(ui.page({ title: 'QuickBooks' }, ui.empty({ icon: 'lock', title: 'Office users only', text: 'QuickBooks is for owners, admins and office users.' })));
}

const isAdmin = (ctx) => Q.isAdminRole(ctx.auth.role());
const companyName = (ctx) => ctx.auth.account?.tenantName || ctx.store.settings().company?.name || 'this company';
const mfaMissing = (ctx) => ctx.app?.session?.me?.session?.mfaEnrolled === false;
const busy = (btn, on) => { if (btn) { btn.disabled = on; btn.classList.toggle('qbo-busy', on); } };

/** Run a write; mfa_required opens the "two-step sign-in" sheet, other errors toast. */
async function write(ctx, fn, { ok, btn } = {}) {
  busy(btn, true);
  try {
    const r = await fn();
    if (ok) ctx.ui.toast(typeof ok === 'function' ? ok(r) : ok, 'success');
    Q.qboStatusCache.clear();
    return r;
  } catch (e) {
    Q.showError(ctx, e);
    return undefined;
  } finally { busy(btn, false); }
}

function banner(ui, tone, ...kids) {
  return ui.h('div', { class: ['qbo-banner', tone], role: 'status' }, ui.icon(tone === 'danger' ? 'alert' : 'info', 16), ui.h('div', { class: 'grow' }, kids));
}

function mfaBanner(ctx) {
  const { ui } = ctx;
  return mfaMissing(ctx) ? banner(ui, 'warning', Q.MFA_TEXT, ' ', ui.h('a', { href: '#/account' }, 'Set it up')) : null;
}

// ---------------------------------------------------------------------------------------------
// Overview (8.2)
// ---------------------------------------------------------------------------------------------

function renderOverview(root, ctx) {
  const { ui, query } = ctx;
  const { h } = ui;
  const host = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading…'));
  // The connect result shows for the connection as it was when the page opened (keepConnectResult).
  let kept = { result: query.connect && query.connect !== '1' ? query.connect : null };
  root.append(frame(ctx, 'overview', { actions: [ui.button('Setup guide', { icon: 'book', onClick: () => openGuide('quickbooks') })] }, host));
  // Keep the result on screen but out of the address bar, so a reload doesn't repeat it.
  if (query.connect) history.replaceState(null, '', `${location.pathname}${location.search}#/quickbooks${query.show ? `?show=${encodeURIComponent(query.show)}` : ''}`);
  let alive = true;
  let poll = null;

  const draw = (status) => {
    if (!alive) return;
    ui.clear(host);
    const kind = Q.overviewKind(status);
    const parts = [];
    kept = Q.keepConnectResult(kept, status);
    const result = kept.result;
    if (result) {
      const r = Q.connectResultText(result, status);
      parts.push(banner(ui, r.tone === 'success' ? 'success' : r.tone, h('strong', null, r.title), ' ', r.text));
    }
    if (result === 'realm_in_use' || status?.takeoverOffer) parts.push(takeoverCard(ctx, status, reload));
    parts.push(mfaBanner(ctx));
    if (status && status.writesEnabled === false && ['active', 'paused', 'setup'].includes(status.state)) {
      parts.push(banner(ui, 'info', 'Sending to QuickBooks is paused by Fishtape. Your changes are kept and will be sent.'));
    }
    if (status?.writeMode === 'shadow' && status.state === 'active') {
      parts.push(h('div', { class: 'qbo-banner warning qbo-shadow', role: 'status' }, ui.icon('eye', 16),
        h('div', { class: 'grow' }, h('strong', null, 'Practice mode: nothing is written.'), ' ', h('a', { href: '#/quickbooks/activity?outcome=shadow' }, "Read the 'would change' list")),
        isAdmin(ctx) ? ui.button('Go live', { size: 'sm', variant: 'primary', onClick: (e) => goLive(ctx, e.currentTarget, reload) }) : null));
    }
    parts.push(stateCard(ctx, kind, status, reload));
    if (status?.catchingUp) parts.push(banner(ui, 'info', 'Catching up with QuickBooks after a long break: this can take a few passes.'));
    if (status && ['active', 'paused', 'reconnect_needed'].includes(status.state)) {
      const links = Q.countLinks(status.counts);
      if (links.length) parts.push(h('div', { class: 'card qbo-counts' }, h('h3', null, 'Needs attention'),
        h('div', { class: 'qbo-count-grid' }, links.map((l) => h('a', { class: ['qbo-count', l.tone], href: l.href }, h('strong', { class: 'num' }, String(l.n)), h('span', null, l.label))))));
      if ((status.counts?.mismatch || 0) > 0 || query.show === 'mismatch') parts.push(mismatchCard(ctx));
    }
    parts.push(h('div', { class: 'row qbo-links' },
      ui.button('Mappings', { size: 'sm', variant: 'ghost', icon: 'sliders', href: '#/quickbooks/mappings' }),
      ui.button('Activity', { size: 'sm', variant: 'ghost', icon: 'activity', href: '#/quickbooks/activity' }),
      ui.button('Conflicts', { size: 'sm', variant: 'ghost', icon: 'alert', href: '#/quickbooks/conflicts' }),
      ui.button('Look up in QuickBooks', { size: 'sm', variant: 'ghost', icon: 'search', href: '#/quickbooks/lookup' })));
    host.append(...parts.filter(Boolean));
  };

  async function reload() {
    if (Q.isOffline(ctx)) { draw(lastStatus); return; }
    try {
      const s = await qboApi.status();
      lastStatus = s;
      Q.qboStatusCache.clear();
      draw(s);
      if (query.connect === '1' && !reload.started) {
        reload.started = true;
        if (isAdmin(ctx) && ['not_connected', 'disconnected'].includes(s.state)) startConnect(ctx, { reconnect: false }, reload);
        else if (isAdmin(ctx) && ['reconnect_needed', 'paused', 'active'].includes(s.state)) startConnect(ctx, { reconnect: true }, reload);
      }
      // Setup progress (scan or apply) moves on its own: look again every 3 seconds while it runs.
      clearTimeout(poll);
      if (s.state === 'setup' && s.setup && s.setup.phase && s.setup.phase !== 'done' && !s.setup.finishedAt) poll = setTimeout(reload, 3000);
    } catch (e) {
      if (!alive) return;
      if (e.code === 'offline') { draw(lastStatus); return; }
      ui.clear(host).append(ui.empty({ icon: 'alert', title: e.status === 403 ? 'Office users only' : 'QuickBooks status could not be loaded', text: Q.errorText(e) }));
    }
  }
  reload();
  const onOnline = () => reload();
  addEventListener('online', onOnline);
  return () => { alive = false; clearTimeout(poll); removeEventListener('online', onOnline); };
}

function whatSyncs(ui) {
  const { h } = ui;
  return h('ul', { class: 'qbo-syncs' },
    h('li', null, h('strong', null, 'Clients and products'), ' both ways'),
    h('li', null, h('strong', null, 'Estimates, invoices and payments'), ' both ways, with your tax codes'),
    h('li', null, h('strong', null, 'Jobs'), ' as sub-customers, for job costing'),
    h('li', null, h('strong', null, 'Approved time'), ' as timesheets'),
    h('li', null, h('strong', null, 'Supplier bills and receipts'), ' tagged to jobs'),
    h('li', null, h('strong', null, 'Stripe payments'), ' with their fees and payouts'));
}

function connectControl(ctx, label, onClick) {
  const { ui } = ctx;
  if (Q.CONNECT_BUTTON_ASSET) {
    return ui.h('button', { type: 'button', class: 'qbo-connect-img', 'aria-label': label, onClick },
      ui.h('img', { src: Q.CONNECT_BUTTON_ASSET, alt: label }));
  }
  return ui.button(label, { variant: 'primary', icon: 'link', onClick });
}

function stateCard(ctx, kind, status, reload) {
  const { ui } = ctx;
  const { h } = ui;
  const admin = isAdmin(ctx);
  const card = (...kids) => h('div', { class: ['card', 'qbo-state', `qbo-${kind}`], dataset: { qboKind: kind } }, kids);
  const askAdmin = h('p', { class: 'muted', style: { margin: 0 } }, 'Ask an owner or admin to connect.');
  switch (kind) {
    case 'loading': return card(h('p', { class: 'muted' }, 'Loading…'));
    case 'unavailable': return card(h('h3', null, "QuickBooks isn't available on this server yet."), h('p', { class: 'muted', style: { margin: 0 } }, 'Fishtape support turns it on once Intuit has approved the app for this server.'));
    case 'plan': return card(h('h3', null, 'QuickBooks sync is in the Pro plan and up'), h('p', { class: 'muted', style: { margin: 0 } }, 'Upgrade to send invoices, payments and time to QuickBooks Online and bring changes back.'),
      ui.button('See plans', { variant: 'primary', icon: 'unlock', href: '#/billing' }));
    case 'not_connected':
    case 'disconnected': return card(
      h('h3', null, kind === 'disconnected' ? 'Disconnected from QuickBooks' : 'Connect QuickBooks Online'),
      kind === 'disconnected' ? h('p', { class: 'muted', style: { margin: 0 } }, 'Records that came from QuickBooks stay in Fishtape. Reconnecting the same QuickBooks company within 30 days keeps the links and skips setup.') : null,
      h('p', { style: { margin: 0 } }, 'What syncs:'), whatSyncs(ui),
      h('p', { class: 'muted qbo-small', style: { margin: 0 } }, Q.AI_DISCLOSURE),
      h('div', { class: 'row' },
        admin ? connectControl(ctx, 'Connect to QuickBooks', (e) => startConnect(ctx, { reconnect: kind === 'disconnected', btn: e.currentTarget }, reload)) : askAdmin,
        ui.button('How it works', { variant: 'ghost', icon: 'book', onClick: () => openGuide('quickbooks') }),
        admin && kind === 'disconnected' ? ui.button('Delete QuickBooks data now', { variant: 'ghost danger', icon: 'trash', onClick: () => purgeNow(ctx, reload) }) : null),
      admin && Q.CONNECT_BUTTON_ASSET ? h('p', { class: 'muted qbo-small' }, 'The Connect to QuickBooks button is Intuit’s, used under its licence.') : null);
    case 'setup': {
      const s = status.setup || {};
      const pct = s.total ? Math.min(100, Math.round(((s.done || 0) / s.total) * 100)) : 0;
      return card(
        h('div', { class: 'row' }, h('h3', { class: 'grow' }, `Finish setting up${status.companyName ? ` ${status.companyName}` : ''}`), ui.badge('Setup', 'warning')),
        h('p', { class: 'muted', style: { margin: 0 } }, 'Nothing syncs until setup is applied: pick what syncs, your tax codes and accounts, then match your records so nothing is entered twice.'),
        s.phase && s.phase !== 'done' && s.total ? h('div', { class: 'qbo-progress' }, h('div', { class: 'progress' }, h('i', { style: { width: `${pct}%` } })), h('span', { class: 'muted' }, `${s.done || 0} of ${s.total}`)) : null,
        h('div', { class: 'row' }, ui.button('Continue setup', { variant: 'primary', icon: 'chevron-right', href: '#/quickbooks/setup' }),
          admin ? ui.button('Disconnect from QuickBooks', { variant: 'ghost danger', onClick: () => disconnectSheet(ctx, status, reload) }) : null));
    }
    case 'active': return card(
      h('div', { class: 'row' }, h('div', { class: 'grow' }, h('h3', { style: { margin: 0 } }, status.companyName || 'QuickBooks Online'), status.features?.edition ? h('div', { class: 'muted' }, status.features.edition) : null),
        ui.badge(status.writeMode === 'shadow' ? 'Practice mode' : 'Syncing', status.writeMode === 'shadow' ? 'warning' : 'success')),
      h('dl', { class: 'qbo-facts' },
        h('dt', null, 'Last from QuickBooks'), h('dd', null, ui.fmtDateTime(status.lastPullAt)),
        h('dt', null, 'Last to QuickBooks'), h('dd', null, ui.fmtDateTime(status.lastPushAt)),
        status.syncFrom ? [h('dt', null, 'Syncing from'), h('dd', null, ui.fmtDate(status.syncFrom))] : null,
        status.environment === 'sandbox' ? [h('dt', null, 'QuickBooks'), h('dd', null, 'Sandbox (test company)')] : null),
      expiryNote(ctx, status),
      h('div', { class: 'row' },
        ui.button('Sync now', { variant: 'primary', icon: 'redo', onClick: (e) => write(ctx, () => qboApi.sync('both'), { ok: 'Sync started', btn: e.currentTarget }).then(reload) }),
        ui.button('Pause', { icon: 'stop', onClick: (e) => write(ctx, () => qboApi.pause(true), { ok: 'QuickBooks sync paused', btn: e.currentTarget }).then(reload) }),
        admin ? ui.button('Disconnect from QuickBooks', { variant: 'ghost danger', onClick: () => disconnectSheet(ctx, status, reload) }) : null));
    case 'paused': {
      const p = Q.pauseInfo(status);
      return card(
        h('div', { class: 'row' }, h('h3', { class: 'grow', style: { margin: 0 } }, status.companyName || 'QuickBooks Online'), ui.badge('Paused', 'warning')),
        h('p', { style: { margin: 0 } }, p.text),
        waitingLine(ui, status),
        h('div', { class: 'row' },
          p.canResume ? ui.button(p.brake ? 'Resume…' : 'Resume', { variant: 'primary', icon: 'play', onClick: (e) => resume(ctx, status, e.currentTarget, reload) }) : null,
          p.needsUpgrade ? ui.button('Upgrade', { variant: 'primary', icon: 'unlock', href: '#/billing' }) : null,
          admin ? ui.button('Disconnect from QuickBooks', { variant: 'ghost danger', onClick: () => disconnectSheet(ctx, status, reload) }) : null));
    }
    case 'reconnect_needed': return card(
      h('div', { class: 'row' }, h('h3', { class: 'grow', style: { margin: 0 } }, 'Reconnect to QuickBooks'), ui.badge('Not syncing', 'danger')),
      h('p', { style: { margin: 0 } }, Q.reconnectText(status.reconnectReason)),
      status.pauseReason ? h('p', { class: 'muted', style: { margin: 0 } }, Q.pauseInfo(status).text) : null,
      waitingLine(ui, status),
      h('div', { class: 'row' }, admin ? connectControl(ctx, 'Reconnect to QuickBooks', (e) => startConnect(ctx, { reconnect: true, btn: e.currentTarget }, reload)) : askAdmin,
        admin ? ui.button('Disconnect from QuickBooks', { variant: 'ghost danger', onClick: () => disconnectSheet(ctx, status, reload) }) : null));
    default: return card(h('p', null, 'Unknown state.'));
  }
}

function waitingLine(ui, status) {
  const n = status.counts?.waitingOffline || 0;
  return ui.h('p', { class: 'muted', style: { margin: 0 } }, n ? `${n} change${n === 1 ? '' : 's'} waiting to be sent. They are kept and go out once syncing starts again.` : 'Your changes are kept and go out once syncing starts again.');
}

function expiryNote(ctx, status) {
  const { ui } = ctx;
  const d = status.hardExpiresAt ? ui.daysUntil(String(status.hardExpiresAt).slice(0, 10)) : Infinity;
  if (!(d <= 30)) return null;
  return banner(ui, 'warning', `Reconnect to QuickBooks before ${ui.fmtDate(status.hardExpiresAt)}. Intuit ends connections after five years.`,
    isAdmin(ctx) ? [' ', ui.h('a', { href: '#/quickbooks?connect=1' }, 'Reconnect now')] : null);
}

/** Start the connect flow (2.2): a one-time ticket, then the interstitial in this browser or Safari (iOS). */
async function startConnect(ctx, { reconnect = false, btn = null } = {}, reload) {
  const native = isNativeApp();
  const r = await write(ctx, () => qboApi.connect({ returnTo: native ? 'app' : 'web', reconnect }), { btn });
  if (!r?.url) return;
  if (!native) { await openExternal(r.url); return; }
  // iOS: the Intuit pages open in the system browser, which shares no cookies with the app. Watch
  // the status every 3 seconds until it changes, then show it (2.2 step 4).
  const before = lastStatus?.state;
  let stop = false;
  const until = Date.now() + 10 * 60_000; // Safari left open: stop asking after ten minutes
  const tick = async () => {
    if (stop) return;
    if (Date.now() > until) { stop = true; reload?.(); return; }
    try {
      const s = await qboApi.status();
      if (s.state !== before) { stop = true; lastStatus = s; closeExternal(); ctx.ui.toast(s.state === 'setup' || s.state === 'active' ? 'QuickBooks is connected' : 'QuickBooks status changed', 'success'); reload?.(); return; }
    } catch { /* keep trying */ }
    setTimeout(tick, 3000);
  };
  await openExternal(r.url, { onClose: () => { stop = true; reload?.(); } });
  setTimeout(tick, 3000);
}

function takeoverCard(ctx, status, reload) {
  const { ui } = ctx;
  const { h } = ui;
  const name = companyName(ctx);
  return h('div', { class: 'card qbo-state qbo-takeover' },
    h('h3', null, 'This QuickBooks company is connected to another Fishtape company.'),
    h('p', { class: 'muted', style: { margin: 0 } }, 'Fishtape never says which one. If it is yours (for example a former employee connected it to a trial), a QuickBooks admin of the company can move it here.'),
    status?.takeoverOffer && isAdmin(ctx) ? ui.button(`Move it to ${name}`, { variant: 'primary', onClick: async (e) => {
      const ok = await ui.confirmDialog(`The other Fishtape company is disconnected from this QuickBooks company and its links are deleted; its owners get an email. ${name} is then connected and goes through setup.`, { title: `Move QuickBooks to ${name}?`, okLabel: 'Move it here' });
      if (!ok) return;
      if (await write(ctx, () => qboApi.takeover(), { ok: `QuickBooks moved to ${name}`, btn: e.currentTarget })) reload();
    } }) : null);
}

async function goLive(ctx, btn, reload) {
  const ok = await ctx.ui.confirmDialog('Practice mode ends: from now on changes are written to QuickBooks and to Fishtape. The rest of setup runs first.', { title: 'Go live?', okLabel: 'Go live', danger: false });
  if (!ok) return;
  if (await write(ctx, () => qboApi.saveMappings({ set: [{ kind: 'option', key: 'writeMode', value: 'live' }] }), { ok: 'QuickBooks sync is live', btn })) reload();
}

async function resume(ctx, status, btn, reload) {
  const { ui } = ctx;
  const brake = status.pauseReason === 'brake';
  let allowCount = Q.brakeCount(status);
  if (brake && !allowCount) {
    // The server says how many changes tripped the brake (409 qbo_brake_count).
    try { await qboApi.pause(false); Q.qboStatusCache.clear(); ui.toast('Syncing again', 'success'); reload(); return; } catch (e) {
      if (e.code !== 'qbo_brake_count') { Q.showError(ctx, e); return; }
      allowCount = Q.brakeCount(e);
    }
  }
  if (brake) {
    const ok = await ui.confirmDialog(`The safety brake stopped ${allowCount ? `${allowCount} changes` : 'a large batch of changes'} in an hour. Check the activity first if that looks wrong.`, { title: `Allow ${allowCount || 'these'} changes?`, okLabel: `Allow ${allowCount || ''} changes`.replace('  ', ' '), danger: false });
    if (!ok) return;
  }
  if (await write(ctx, () => qboApi.pause(false, brake ? { allowCount } : {}), { ok: 'Syncing again', btn }) !== undefined) reload();
}

function disconnectSheet(ctx, status, reload) {
  const { ui } = ctx;
  const { h } = ui;
  const qbName = status?.companyName || 'QuickBooks';
  const purge = h('input', { type: 'checkbox', name: 'purge' });
  const s = ui.openSheet({
    title: 'Disconnect from QuickBooks', dialog: true,
    body: h('div', { class: 'stack' },
      h('p', { style: { margin: 0 } }, 'Sync stops at once and Fishtape’s access to QuickBooks is revoked. Records that came from QuickBooks stay in Fishtape.'),
      h('label', { class: 'field check' }, purge, h('span', null, `Also delete the links to ${qbName} now`)),
      h('p', { class: 'muted', style: { margin: 0 } }, 'Without it the links are kept for 30 days, so reconnecting the same company skips setup. Connecting a different QuickBooks company needs them deleted.')),
    actions: [ui.button('Cancel', { variant: 'ghost', onClick: () => s.close() }),
      ui.button('Disconnect', { variant: 'danger solid', onClick: async (e) => {
        const r = await write(ctx, () => qboApi.disconnect({ purge: purge.checked }), { ok: (x) => (x?.purged ? 'Disconnected; QuickBooks data deleted' : 'Disconnected from QuickBooks'), btn: e.currentTarget });
        if (r) { s.close(); reload(); }
      } })],
  });
}

async function purgeNow(ctx, reload) {
  const ok = await ctx.ui.confirmDialog('This forgets the links to the old QuickBooks company, the mappings and the sync log. Fishtape records stay. Needed before connecting a different QuickBooks company.', { title: 'Delete QuickBooks data now?', okLabel: 'Delete' });
  if (!ok) return;
  if (await write(ctx, () => qboApi.disconnect({ purge: true }), { ok: 'QuickBooks data deleted' })) reload();
}

function mismatchCard(ctx) {
  const { ui } = ctx;
  const { h } = ui;
  const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading…'));
  qboApi.checks({ limit: 100 }).then((r) => {
    ui.clear(body);
    const rows = r?.data || [];
    if (!rows.length) { body.append(h('p', { class: 'muted', style: { margin: 0 } }, 'Everything matched at the last daily check.')); return; }
    body.append(ui.table({
      columns: [
        { key: 'label', label: 'Record', render: (m) => { const href = Q.recordHref(m.collection, m.recordId); return href ? h('a', { href }, m.label || m.recordId) : m.label || m.recordId; } },
        { key: 'kind', label: 'What', render: (m) => ({ balance: 'Amount owing', total: 'Total', clearing: 'Stripe clearing account' }[m.kind] || m.kind) },
        { key: 'f', label: 'Fishtape', align: 'right', render: (m) => ui.fmtMoney(m.fishtapeCents) },
        { key: 'q', label: 'QuickBooks', align: 'right', render: (m) => ui.fmtMoney(m.quickbooksCents) },
        { key: 'at', label: 'Checked', render: (m) => ui.fmtDateTime(m.checkedAt) },
      ],
      rows,
    }));
  }).catch((e) => { ui.clear(body).append(h('p', null, Q.errorText(e))); });
  return h('div', { class: 'card qbo-mismatch', id: 'mismatch' }, h('h3', null, "Doesn't match QuickBooks"),
    h('p', { class: 'muted', style: { margin: 0 } }, 'From the daily check. Nothing is changed by it; fix the record on the side that is wrong.'), body);
}

// ---------------------------------------------------------------------------------------------
// Options (6.1): shared by the wizard's Settings step and the mappings screen
// ---------------------------------------------------------------------------------------------

function optionsForm(ctx, opts, status, { wizard = false } = {}) {
  const { ui } = ctx;
  const { h } = ui;
  const features = status?.features || {};
  const fromQbo = features.taxFiledThrough || null;
  // Practice mode on or off is "Go live" (8.2): owners and admins only. The wizard starts with a
  // practice week (13.10) unless one was already chosen.
  const canSwitchWrites = isAdmin(ctx);
  const o = { ...Q.optionDefaults({ features }), ...(wizard ? { writeMode: 'shadow' } : {}), ...(opts || {}) };
  const form = h('form', { class: 'stack qbo-options', onSubmit: (e) => e.preventDefault() },
    ui.formGrid([
      { label: 'Start syncing from', name: 'syncFrom', type: 'date', value: o.syncFrom, required: true, hint: 'Older documents stay only in QuickBooks, except open invoices and pending estimates.' },
      { label: 'QuickBooks customers to bring in', name: 'importCustomers', type: 'select', value: o.importCustomers, options: [{ value: 'active', label: 'Only those with recent work or a balance' }, { value: 'all', label: 'Every active customer' }], hint: 'Field crews can see client contact details in Fishtape.' },
      { label: 'Which system holds payroll hours?', name: 'timeOwner', type: 'select', value: o.timeOwner || '', options: [{ value: '', label: 'Pick one…' }, { value: 'fishtape', label: 'Fishtape: approved time goes to QuickBooks' }, { value: 'quickbooks', label: 'QuickBooks Time: Fishtape sends no hours' }], hint: 'Hours are never entered twice.' },
      { label: 'Last pay period run', name: 'timeLockedThrough', type: 'date', value: o.timeLockedThrough || '', hint: 'Hours on or before it are never changed from Fishtape.' },
      { label: 'Last GST return filed', name: 'taxFiledThrough', type: 'date', value: fromQbo || o.taxFiledThrough || '', readonly: Boolean(fromQbo), hint: fromQbo ? 'From QuickBooks.' : 'The last day of the last GST period filed. Changes to it are held for you to confirm.' },
      { label: 'Book Stripe from', name: 'stripeCutover', type: 'date', value: o.stripeCutover || o.syncFrom || '', hint: 'Stripe charges before this day stay with your bookkeeper.' },
      { label: 'Numbering', name: 'numbering', type: 'select', value: o.numbering,
        options: [{ value: 'fishtape', label: features.customTxnNumbers === false ? 'Fishtape numbers (turn on custom numbers in QuickBooks first)' : 'Fishtape numbers documents (INV-3001)' }, { value: 'quickbooks', label: 'QuickBooks numbers documents' }],
        hint: o.numbering === 'quickbooks' ? 'A document already emailed from Fishtape gets QuickBooks’ number.' : 'Use plain numbers for documents made in QuickBooks, so the two never meet.' },
      { label: 'New products and services in QuickBooks', name: 'items', type: 'select', value: o.items, options: [{ value: 'on_use', label: 'When first used on a document' }, { value: 'all', label: 'All of them now' }] },
      { label: 'Jobs become sub-customers in QuickBooks (job costing)', name: 'jobsAsSubCustomers', type: 'checkbox', value: o.jobsAsSubCustomers !== false },
      { label: 'Send approved time to QuickBooks', name: 'syncTime', type: 'checkbox', value: o.syncTime !== false },
      { label: 'Send drafts too', name: 'pushDrafts', type: 'checkbox', value: Boolean(o.pushDrafts) },
      { label: 'Bring in supplier bills tagged to your jobs', name: 'pullJobCosts', type: 'checkbox', value: o.pullJobCosts !== false },
      { label: 'Book Stripe fees', name: 'recordStripeFees', type: 'checkbox', value: o.recordStripeFees !== false },
      { label: 'Book Stripe payouts', name: 'recordStripePayouts', type: 'checkbox', value: o.recordStripePayouts !== false },
      { label: wizard ? 'Practice week first (nothing is written; recommended)' : 'Practice mode (nothing is written)', name: 'practice', type: 'checkbox', value: o.writeMode === 'shadow' },
    ]));
  const read = () => {
    const v = ui.readForm(form);
    const out = {
      syncFrom: v.syncFrom || null, importCustomers: v.importCustomers, timeOwner: v.timeOwner || null, timeLockedThrough: v.timeLockedThrough || null,
      stripeCutover: v.stripeCutover || null, numbering: v.numbering, items: v.items, jobsAsSubCustomers: v.jobsAsSubCustomers, syncTime: v.syncTime,
      pushDrafts: v.pushDrafts, pullJobCosts: v.pullJobCosts, recordStripeFees: v.recordStripeFees, recordStripePayouts: v.recordStripePayouts,
    };
    if (canSwitchWrites) out.writeMode = v.practice ? 'shadow' : 'live';
    if (!fromQbo) out.taxFiledThrough = v.taxFiledThrough || null;
    return out;
  };
  if (!canSwitchWrites) {
    const box = form.querySelector('input[name=practice]');
    if (box) {
      box.disabled = true;
      box.closest('.field')?.append(h('span', { class: 'hint' }, 'An owner or admin turns practice mode on or off.'));
    }
  }
  return { el: form, read, valid: () => form.reportValidity() };
}

/**
 * The option changes for PUT /qbo/mappings: a changed value goes in `set`; a cleared one (a date
 * emptied, a choice put back to 'Pick one…') goes in `remove`, which the server treats as back to
 * the default. A key is never in both.
 */
const optionChanges = (before = {}, after = {}) => {
  const changed = Object.entries(after).filter(([k, v]) => JSON.stringify(before?.[k] ?? null) !== JSON.stringify(v ?? null));
  return {
    set: changed.filter(([, v]) => v != null).map(([key, value]) => ({ kind: 'option', key, value })),
    remove: changed.filter(([, v]) => v == null).map(([key]) => ({ kind: 'option', key })),
  };
};

// ---------------------------------------------------------------------------------------------
// Mappings (8.4), also step 3 of the wizard
// ---------------------------------------------------------------------------------------------

function renderMappings(root, ctx) {
  const { ui } = ctx;
  const host = ui.h('div', { class: 'stack' }, ui.h('p', { class: 'muted' }, 'Loading…'));
  root.append(frame(ctx, 'mappings', { subtitle: 'Your QuickBooks tax codes, products, accounts and options' }, host));
  return mappingsView(ctx, host, { wizard: false });
}

/**
 * Draws the mappings into `host`. In the wizard, required entries come first and `onReady(required)`
 * reports what is still missing.
 */
function mappingsView(ctx, host, { wizard = false, onReady = null } = {}) {
  const { ui, store } = ctx;
  const { h } = ui;
  let alive = true;
  let data = null, status = lastStatus, draft = null, suggested = new Set();
  const province = () => status?.features?.province || store.settings().company?.province || 'ON';

  const load = async () => {
    if (Q.isOffline(ctx)) { ui.clear(host).append(ui.empty({ icon: 'alert', title: "You're offline", text: 'QuickBooks needs a connection.' })); return; }
    try {
      const [m, s] = await Promise.all([qboApi.mappings(), qboApi.status().catch(() => status)]);
      if (!alive) return;
      data = m; status = s || status; if (s) lastStatus = s;
      draft = JSON.parse(JSON.stringify(m.mappings || {}));
      suggested = new Set();
      // Suggestions (by rates, 4.8) fill empty entries; they are saved with the rest.
      for (const [kind, keys] of Object.entries(m.suggestions || {})) {
        for (const [key, value] of Object.entries(keys || {})) {
          if (value != null && Q.mapValue(draft, kind, key) == null) { (draft[kind] ||= {})[key] = value; suggested.add(`${kind}.${key}`); }
        }
      }
      draw();
    } catch (e) {
      if (!alive) return;
      ui.clear(host).append(ui.empty({ icon: 'alert', title: 'Mappings could not be loaded', text: Q.errorText(e) }));
    }
  };

  const required = () => Q.requiredSet(data?.required);
  // `required` lists what the server is missing; filled in here but not saved yet still counts.
  const missingIn = (m) => [...required()].filter((k) => { const [kind, ...rest] = k.split('.'); return Q.mapValue(m, kind, rest.join('.')) == null; });
  const missing = () => missingIn(draft);

  const select = (kind, key, options, { fit = null, label, hint } = {}) => {
    const value = Q.mapValue(draft, kind, key);
    const req = required().has(`${kind}.${key}`);
    const problem = value != null && fit ? fit(options.find((o) => String(o.id) === String(value))?.raw) : null;
    const sel = h('select', { name: `${kind}.${key}`, 'aria-label': label, onChange: (e) => { const v = e.target.value || null; (draft[kind] ||= {})[key] = v; if (v == null) delete draft[kind][key]; suggested.delete(`${kind}.${key}`); draw(); } },
      h('option', { value: '', selected: value == null }, req ? 'Pick one (required)…' : '— none —'),
      options.map((o) => {
        const f = fit ? fit(o.raw) : { ok: true };
        return h('option', { value: o.id, selected: String(o.id) === String(value ?? ''), disabled: !f.ok && String(o.id) !== String(value ?? '') }, f.ok ? o.label : `${o.label} (does not fit)`);
      }));
    return h('label', { class: ['field', req && value == null ? 'qbo-required' : null], dataset: { map: `${kind}.${key}` } },
      h('span', null, label, req ? ' *' : '', suggested.has(`${kind}.${key}`) ? h('span', { class: 'qbo-suggested' }, ' suggested') : null),
      sel,
      problem && !problem.ok ? h('span', { class: 'hint qbo-bad' }, problem.reason) : hint ? h('span', { class: 'hint' }, hint) : null);
  };

  const draw = () => {
    if (!alive || !data) return;
    ui.clear(host);
    const ch = data.choices || {};
    const prov = province();
    const date = new Date();
    const features = status?.features || {};
    const codeOpts = (purchase) => (ch.taxCodes || []).map((c) => ({ id: c.id, label: Q.codeOptionLabel(c, { purchase }), raw: c }));
    const itemOpts = (ch.items || []).map((i) => ({ id: i.id, label: `${i.name}${i.type ? ` · ${i.type}` : ''}`, raw: i }));
    const accountOpts = (types) => (ch.accounts || []).filter((a) => !types || types.includes(a.type)).map((a) => ({ id: a.id, label: `${a.name} · ${a.type}`, raw: a }));
    const listOpts = (list) => (list || []).map((x) => ({ id: x.id, label: x.name, raw: x }));

    const taxKeys = [...new Set([...Q.companyTaxKeys(prov, date), ...Object.keys(draft.taxCode || {}), ...[...required()].filter((k) => k.startsWith('taxCode.')).map((k) => k.slice(8))])];
    const purchaseKeys = [...new Set([...Q.companyPurchaseKeys(prov, date), ...Object.keys(draft.purchaseTaxCode || {}), ...[...required()].filter((k) => k.startsWith('purchaseTaxCode.')).map((k) => k.slice(16))])];
    // Built from the draft, and every change goes back into it: a select change redraws the whole
    // view, which must not lose an option typed in and not saved yet.
    const optionsBlock = optionsForm(ctx, draft.option || {}, status, { wizard });
    const keepOptions = () => { draft.option = { ...(draft.option || {}), ...optionsBlock.read() }; };
    optionsBlock.el.addEventListener('input', keepOptions);
    optionsBlock.el.addEventListener('change', keepOptions);

    const section = (title, intro, ...fields) => h('section', { class: 'card qbo-map-section' }, h('h3', null, title), intro ? h('p', { class: 'muted', style: { margin: 0 } }, intro) : null, h('div', { class: 'form-grid' }, fields));
    const miss = missing();
    // The wizard moves on only once what it needs is saved on the server.
    if (onReady) onReady([...required()]);

    const saveButton = () => ui.button('Save', { variant: 'primary', icon: 'save', onClick: (e) => save(e.currentTarget) });
    const sections = [
      section('Tax codes', 'Each Fishtape tax situation goes to the QuickBooks code with the same rates. A code whose rates differ (for example an old 8% PST rate) is refused.',
        taxKeys.map((key) => select('taxCode', key, codeOpts(false), { label: Q.taxKeyLabel(key, prov), fit: (code) => Q.taxCodeFit(key, code, { province: prov, date }) }))),
      section('Purchase tax codes', 'PST and RST you pay on what you use yourself are added to the cost; RST on materials you resell goes to RST recoverable; only GST/HST/QST is claimed.',
        purchaseKeys.map((key) => select('purchaseTaxCode', key, codeOpts(true), { label: Q.purchaseKeyLabel(key, prov), fit: (code) => Q.purchaseCodeFit(key, code) }))),
      section('Products and services', 'Lines without a linked price-book item use these QuickBooks items.',
        Q.ITEM_KEYS.map((k) => select('item', k.key, itemOpts, { label: k.label })),
        h('ul', { class: 'muted qbo-notes' }, Q.FEATURE_NOTES.map((n) => h('li', null, n)))),
      section('Accounts', null,
        Q.ACCOUNT_KEYS.map((k) => select('account', k.key, accountOpts(k.types), { label: k.label })),
        Q.PAID_FROM_KEYS.map((k) => select('paidFrom', k.key, accountOpts(['Bank', 'Credit Card']), { label: `Receipts paid by ${k.label.toLowerCase()} come from` }))),
      section('Payment methods', 'How each payment is recorded in QuickBooks, and where it is deposited.',
        Q.METHOD_KEYS.map((k) => [
          select('paymentMethod', k.key, listOpts(ch.paymentMethods), { label: `${k.label}: payment method` }),
          select('depositTo', k.key, accountOpts(['Bank', 'Other Current Asset']), { label: `${k.label}: deposit to`, hint: 'Undeposited Funds when you deposit several at once.' }),
        ])),
      features.classes || features.locations || (ch.terms || []).length ? section('Defaults', null,
        features.classes ? select('class', 'default', listOpts(ch.classes), { label: 'Class' }) : null,
        features.locations ? select('department', 'default', listOpts(ch.departments), { label: 'Location' }) : null,
        select('term', 'default', listOpts(ch.terms), { label: 'Terms' })) : null,
    ];
    // The wizard (8.3) puts the required entries first, in a section of their own.
    let requiredSection = null;
    if (wizard && required().size) {
      const grid = h('div', { class: 'form-grid' });
      for (const sec of sections) for (const el of sec ? [...sec.querySelectorAll('[data-map]')] : []) if (required().has(el.dataset.map)) grid.append(el);
      if (grid.children.length) requiredSection = h('section', { class: 'card qbo-map-section', dataset: { required: '1' } }, h('h3', null, 'Required'), h('p', { class: 'muted', style: { margin: 0 } }, 'Sync waits until each of these is set.'), grid);
      for (const sec of sections) if (sec && !sec.querySelector('[data-map]')) sec.remove();
    }
    h(host, null,
      miss.length ? banner(ui, 'warning', `${miss.length} required ${miss.length === 1 ? 'entry is' : 'entries are'} still empty. Sync waits until they are set.`)
        : required().size ? banner(ui, 'info', 'Everything required is filled in. Save to keep it.') : null,
      h('div', { class: 'row' }, h('span', { class: 'grow muted' }, 'Lists come from your QuickBooks company.'),
        ui.button('Refresh the lists', { size: 'sm', variant: 'ghost', icon: 'redo', onClick: (e) => write(ctx, () => qboApi.refreshReference(), { ok: 'Reading the lists from QuickBooks; back in a minute', btn: e.currentTarget }) }),
        saveButton()),
      requiredSection,
      sections.filter((sec) => sec && sec.querySelector('[data-map]')),
      h('section', { class: 'card qbo-map-section' }, h('h3', null, 'Options, filed GST period and payroll lock'),
        h('p', { class: 'muted', style: { margin: 0 } }, 'Filed GST period: changes to a period already filed are held for you to confirm. Payroll lock: hours on or before the last pay period run are never changed from Fishtape.'),
        optionsBlock.el),
      h('div', { class: 'row' }, h('span', { class: 'grow' }), saveButton()));

    async function save(btn) {
      if (!optionsBlock.valid()) return;
      const diff = Q.mappingDiff(data.mappings || {}, draft);
      const opt = optionChanges(data.mappings?.option, optionsBlock.read());
      // Options come only from the form (optionChanges), so a key is never in both set and remove.
      const all = [...diff.set.filter((s) => s.kind !== 'option'), ...opt.set];
      const remove = [...diff.remove.filter((r) => r.kind !== 'option'), ...opt.remove];
      if (!all.length && !remove.length) { ui.toast('Nothing changed', 'info'); return; }
      // Say what changed (8.4), by the names on screen.
      const nameOf = ({ kind, key }) => (kind === 'option'
        ? host.querySelector(`[name="${key === 'writeMode' ? 'practice' : key}"]`)?.closest('.field')?.querySelector('span')?.textContent?.replace(/\s*\*$/, '')
        : host.querySelector(`[data-map="${CSS.escape(`${kind}.${key}`)}"] select`)?.getAttribute('aria-label')) || key;
      const names = [...all, ...remove].map(nameOf);
      const r = await write(ctx, () => qboApi.saveMappings({ set: all, remove }), { btn });
      if (!r) return;
      data = r;
      draft = JSON.parse(JSON.stringify(r.mappings || {}));
      suggested = new Set();
      const n = names.length;
      ui.toast(`Saved ${n} change${n === 1 ? '' : 's'}: ${names.slice(0, 4).join('; ')}${n > 4 ? `; and ${n - 4} more` : ''}. Records that were waiting or failed are being sent again.`, 'success', 6000);
      draw();
    }
  };

  load();
  return () => { alive = false; };
}

// ---------------------------------------------------------------------------------------------
// Wizard (8.3)
// ---------------------------------------------------------------------------------------------

function renderWizard(root, ctx) {
  const { ui, query } = ctx;
  const { h } = ui;
  const host = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading…'));
  root.append(frame(ctx, 'setup', { subtitle: 'Set up QuickBooks so nothing is entered twice' }, host));
  let alive = true;
  let cleanupStep = null;
  let poll = null;

  const go = (step) => ctx.nav(`#/quickbooks/setup?step=${step}`);
  const stepper = (active) => h('ol', { class: 'qbo-steps' }, Q.WIZARD_STEPS.map((s, i) => h('li', { class: [s.id === active ? 'active' : null, Q.WIZARD_STEPS.findIndex((x) => x.id === active) > i ? 'done' : null] },
    h('span', { class: 'qbo-step-n' }, String(i + 1)), h('span', null, s.label))));

  const start = async () => {
    let status = lastStatus;
    if (!Q.isOffline(ctx)) {
      try { status = await qboApi.status(); lastStatus = status; } catch (e) { ui.clear(host).append(ui.empty({ icon: 'alert', title: 'QuickBooks status could not be loaded', text: Q.errorText(e) })); return; }
    }
    if (!alive) return;
    const kind = Q.overviewKind(status);
    const phase = status?.setup?.phase || null;
    const applying = status?.state === 'setup' && phase && !/scan/i.test(phase) && phase !== 'done' && !status.setup.finishedAt;
    let step = query.step || (kind === 'setup' ? (applying ? 'apply' : 'settings') : kind === 'active' ? 'apply' : 'connect');
    if (!Q.WIZARD_STEPS.some((s) => s.id === step)) step = 'settings';
    if (kind !== 'setup' && kind !== 'active' && step !== 'connect') step = 'connect';
    ui.clear(host).append(stepper(step), mfaBanner(ctx) || '');
    const body = h('div', { class: 'stack' });
    host.append(body);
    const steps = { connect: stepConnect, settings: stepSettings, mappings: stepMappings, match: stepMatch, review: stepReview, apply: stepApply };
    cleanupStep = steps[step](body, status) || null;
  };

  function nextPrev(prev, next, { nextLabel = 'Next', disabled = false, onNext } = {}) {
    return h('div', { class: 'row qbo-wizard-foot' },
      prev ? ui.button('Back', { variant: 'ghost', icon: 'chevron-left', onClick: () => go(prev) }) : null, h('span', { class: 'grow' }),
      next || onNext ? ui.button(nextLabel, { variant: 'primary', icon: 'chevron-right', disabled, onClick: onNext || (() => go(next)) }) : null);
  }

  // 1 Connect
  function stepConnect(body, status) {
    const kind = Q.overviewKind(status);
    if (kind === 'setup' || kind === 'active') { body.append(h('div', { class: 'card' }, h('p', { style: { margin: 0 } }, `Connected to ${status.companyName || 'QuickBooks'}.`)), nextPrev(null, 'settings')); return; }
    body.append(h('div', { class: 'card stack' }, h('h3', null, 'Connect QuickBooks Online first'),
      h('p', { class: 'muted', style: { margin: 0 } }, kind === 'unavailable' ? "QuickBooks isn't available on this server yet." : kind === 'plan' ? 'QuickBooks sync is in the Pro plan and up.' : 'An owner or admin connects the company; then setup continues here.'),
      ui.button('Go to the overview', { variant: 'primary', href: '#/quickbooks' })));
  }

  // 2 Settings
  function stepSettings(body, status) {
    let form = null, before = {};
    body.append(h('p', { class: 'muted' }, 'Loading your options…'));
    qboApi.mappings().then((m) => {
      if (!alive) return;
      before = m.mappings?.option || {};
      form = optionsForm(ctx, before, status, { wizard: true });
      const problems = h('div');
      ui.clear(body).append(h('div', { class: 'card stack' }, h('h3', null, 'What syncs'), form.el, problems),
        nextPrev('connect', null, { onNext: async (e) => {
          if (!form.valid()) return;
          const v = form.read();
          const p = Q.settingsProblems(v);
          ui.clear(problems);
          if (p.length) { problems.append(banner(ui, 'warning', p.join(' '))); return; }
          const { set, remove } = optionChanges(before, v);
          if ((set.length || remove.length) && !(await write(ctx, () => qboApi.saveMappings({ set, remove }), { btn: e.currentTarget }))) return;
          go('mappings');
        } }));
    }).catch((e) => { ui.clear(body).append(h('p', null, Q.errorText(e))); });
  }

  // 3 Tax codes, products and accounts
  function stepMappings(body) {
    const inner = h('div', { class: 'stack' });
    let foot = nextPrev('settings', 'match', { disabled: true });
    body.append(h('p', { class: 'muted', style: { margin: 0 } }, 'Required entries come first. Setup can only continue once each is set.'), inner, foot);
    return mappingsView(ctx, inner, { wizard: true, onReady: (miss) => {
      const next = nextPrev('settings', 'match', { disabled: miss.length > 0, nextLabel: miss.length ? `${miss.length} still to set` : 'Next' });
      foot.replaceWith(next); foot = next;
    } });
  }

  // 4 Match
  function stepMatch(body, status) {
    let kind = query.kind && Q.MATCH_KINDS.some((k) => k.id === query.kind) ? query.kind : 'customers';
    let filter = 'all';
    let rows = [], cursor = null, more = false, counts = null;
    const tableHost = h('div');
    const filtersHost = h('div', { class: 'row qbo-chips' });
    const scanHost = h('div', { class: 'card qbo-scan' });
    const money = (c) => ui.fmtMoney(c);

    const drawScan = (s) => {
      ui.clear(scanHost);
      const st = s?.setup || {};
      const scanning = /scan/i.test(st.phase || '') && !st.finishedAt;
      h(scanHost, null, h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('strong', null, scanning ? 'Reading your QuickBooks company…' : 'Match your records'),
          h('div', { class: 'muted' }, scanning ? `${st.done || 0} of ${st.total || '…'}` : 'Read QuickBooks again to refresh the matches (at most every 15 minutes).')),
        ui.button(scanning ? 'Reading…' : 'Read QuickBooks', { icon: 'redo', disabled: scanning, onClick: (e) => write(ctx, () => qboApi.scan(), { ok: 'Reading QuickBooks', btn: e.currentTarget }).then((r) => { if (r) watchScan(); }) })));
      if (scanning) watchScan();
    };
    const watchScan = () => {
      clearTimeout(poll);
      poll = setTimeout(async () => {
        if (!alive) return;
        try { const s = await qboApi.status(); lastStatus = s; drawScan(s); if (!(/scan/i.test(s.setup?.phase || '') && !s.setup?.finishedAt)) load(true); } catch { /* try later */ }
      }, 3000);
    };

    const load = async (reset = true) => {
      const f = Q.MATCH_FILTERS.find((x) => x.id === filter);
      try {
        const r = await qboApi.matches({ kind, status: f?.status, cursor: reset ? undefined : cursor, limit: 100 });
        if (!alive) return;
        rows = reset ? (r.data || []) : [...rows, ...(r.data || [])];
        cursor = r.cursor || null; more = Boolean(r.more); counts = r.counts || counts;
        drawTable();
      } catch (e) { ui.clear(tableHost).append(h('p', null, Q.errorText(e))); }
    };
    const setChoice = async (c, patch) => {
      const r = await write(ctx, () => qboApi.setChoices([{ id: c.id, ...patch }]));
      if (r !== undefined) { Object.assign(c, patch); drawTable(); }
    };
    const drawTable = () => {
      ui.clear(tableHost);
      const f = Q.MATCH_FILTERS.find((x) => x.id === filter);
      const shown = f?.test ? rows.filter(f.test) : rows;
      tableHost.append(ui.table({
        columns: [
          { key: 'f', label: 'Fishtape', render: (c) => Q.sideSummary(c.fishtape, money) },
          { key: 'q', label: 'QuickBooks', render: (c) => Q.sideSummary(c.quickbooks, money) },
          { key: 's', label: 'Match', render: (c) => h('span', { class: 'qbo-score' }, c.score ? `${c.score}` : '—', (c.reasons || []).length ? h('span', { class: 'muted' }, ` ${c.reasons.map((r) => Q.MATCH_REASON[r] || r).join(', ')}`) : null) },
          { key: 'c', label: 'Choice', render: (c) => choiceCell(c) },
        ],
        rows: shown,
        empty: ui.empty({ icon: 'search', title: 'Nothing here', text: 'Try another filter, or read QuickBooks again.' }),
      }));
      if (more) tableHost.append(ui.button('Show more', { variant: 'ghost', onClick: () => load(false) }));
    };
    const choiceCell = (c) => {
      const choices = Q.choicesFor(kind, c);
      const sel = h('select', { 'aria-label': 'Choice', onChange: (e) => setChoice(c, { choice: e.target.value }) },
        choices.map((x) => h('option', { value: x, selected: c.choice === x }, x === 'create_in_qbo' && Q.isPossibleDuplicate(c) ? 'Create anyway' : Q.CHOICE_LABEL[x])));
      const alts = c.alternatives || (c.options || []).map((id) => ({ qboId: id, label: `QuickBooks #${id}` }));
      const alt = c.choice === 'link' && alts.length ? h('select', { 'aria-label': 'Which QuickBooks record', onChange: (e) => setChoice(c, { choice: 'link', qboId: e.target.value }) },
        [c.quickbooks ? { qboId: c.quickbooks.qboId, label: c.quickbooks.label } : null, ...alts].filter(Boolean).map((a) => h('option', { value: a.qboId, selected: String(a.qboId) === String(c.quickbooks?.qboId) }, a.label || a.qboId))) : null;
      return h('div', { class: 'qbo-choice' }, sel, alt,
        Q.needsFiledTick(c) ? h('label', { class: 'field check' }, h('input', { type: 'checkbox', checked: Boolean(c.confirmed), onChange: (e) => setChoice(c, { confirmed: e.target.checked }) }), h('span', null, 'Adds to a GST period already filed')) : null);
    };

    body.append(scanHost,
      h('div', { class: 'qbo-tabs-wrap' }, ui.tabs(Q.MATCH_KINDS.map((k) => ({ id: k.id, label: k.label })), kind, (k) => { kind = k; filter = 'all'; drawTabs(); load(true); })),
      h('div', { class: 'row qbo-filters' }, filtersHost),
      h('div', { class: 'row qbo-bulk' },
        ui.button('Create all unmatched in QuickBooks', { size: 'sm', variant: 'ghost', onClick: (e) => write(ctx, () => qboApi.bulkChoices({ kind, status: 'fishtape_only', choice: 'create_in_qbo' }), { ok: 'Done', btn: e.currentTarget }).then((r) => { if (r) load(true); }) }),
        ui.button('Leave all unmatched alone', { size: 'sm', variant: 'ghost', onClick: (e) => write(ctx, () => qboApi.bulkChoices({ kind, status: 'fishtape_only', choice: 'skip' }), { ok: 'Done', btn: e.currentTarget }).then((r) => { if (r) load(true); }) })),
      tableHost, nextPrev('mappings', 'review'));
    function drawTabs() {
      const t = body.querySelector('.qbo-tabs-wrap');
      ui.clear(t).append(ui.tabs(Q.MATCH_KINDS.map((k) => ({ id: k.id, label: k.label })), kind, (k) => { kind = k; filter = 'all'; drawTabs(); load(true); }));
      drawFilters();
    }
    function drawFilters() {
      ui.clear(filtersHost).append(...Q.MATCH_FILTERS.map((f) => h('button', { type: 'button', class: ['chip', f.id === filter ? 'active' : null], 'aria-pressed': String(f.id === filter), onClick: () => { filter = f.id; drawFilters(); load(true); } },
        f.label, counts && f.status && counts[f.status] != null && !f.test ? ` ${counts[f.status]}` : '')));
    }
    drawFilters();
    drawScan(status);
    load(true);
  }

  // 5 Review
  function stepReview(body) {
    let plan = null, cands = [], dups = [], filed = [], raise = false;
    const host2 = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading the plan…'));
    body.append(host2);
    const loadAll = async (params) => {
      const out = [];
      let cursor;
      for (let i = 0; i < 20; i++) {
        const r = await qboApi.matches({ ...params, cursor, limit: 500 });
        out.push(...(r.data || []));
        if (!r.more || !r.cursor) break;
        cursor = r.cursor;
      }
      return out;
    };
    const load = async () => {
      try {
        const [p, ...lists] = await Promise.all([
          qboApi.plan(),
          ...Q.CHOICE_KINDS.map((kind) => loadAll({ kind, choice: 'link' })),
          loadAll({ kind: 'invoices', status: 'ambiguous' }), loadAll({ kind: 'estimates', status: 'ambiguous' }),
          loadAll({ kind: 'invoices', choice: 'create_in_qbo' }), loadAll({ kind: 'estimates', choice: 'create_in_qbo' }),
        ]);
        if (!alive) return;
        plan = p;
        const n = Q.CHOICE_KINDS.length;
        cands = lists.slice(0, n).flat().map((c) => ({ kind: c.kind, ...c })).filter((c) => (c.diffs || []).length);
        dups = lists.slice(n, n + 2).flat().filter(Q.isPossibleDuplicate);
        filed = lists.slice(n + 2).flat().filter(Q.needsFiledTick);
        draw();
      } catch (e) { ui.clear(host2).append(h('p', null, Q.errorText(e))); }
    };
    // Picks on one candidate go one after another, each with every pick so far: two quick taps
    // never send {A} and then {B} with A lost. Reload after the last: the plan's count moves too.
    const chains = new Map();
    const setField = (c, field, side) => {
      c.fieldChoices = { ...(c.fieldChoices || {}), [field]: side };
      const fieldChoices = { ...c.fieldChoices };
      const next = (chains.get(c.id) || Promise.resolve()).then(() => write(ctx, () => qboApi.setChoices([{ id: c.id, choice: 'link', fieldChoices }])));
      chains.set(c.id, next);
      next.then(() => { if (chains.get(c.id) === next) { chains.delete(c.id); load(); } });
    };
    const draw = () => {
      ui.clear(host2);
      const ready = Q.applyReady({ cands, plan });
      const kindLabel = (k) => Q.MATCH_KINDS.find((x) => x.id === k)?.label || k;
      const byKind = Q.CHOICE_KINDS.map((k) => [k, cands.filter((c) => c.kind === k)]).filter(([, l]) => l.length);
      h(host2, null,
        h('section', { class: 'card stack' }, h('h3', null, 'Differences'),
          h('p', { class: 'muted', style: { margin: 0 } }, 'For each linked record, pick which side is right for each field. The other side is updated on the first sync.'),
          byKind.length ? byKind.map(([k, list]) => h('div', { class: 'stack qbo-diff-kind' },
            h('div', { class: 'row qbo-diff-head' }, h('strong', { class: 'grow' }, kindLabel(k)),
              ui.button('Use Fishtape for all', { size: 'sm', variant: 'ghost', onClick: (e) => write(ctx, () => qboApi.bulkChoices({ kind: k, fieldsFrom: 'fishtape' }), { btn: e.currentTarget }).then((r) => { if (r !== undefined) load(); }) }),
              ui.button('Use QuickBooks for all', { size: 'sm', variant: 'ghost', onClick: (e) => write(ctx, () => qboApi.bulkChoices({ kind: k, fieldsFrom: 'quickbooks' }), { btn: e.currentTarget }).then((r) => { if (r !== undefined) load(); }) })),
            list.map((c) => h('div', { class: 'qbo-diff', dataset: { cand: c.id } }, h('div', { class: 'qbo-diff-title' }, c.fishtape?.label || c.quickbooks?.label || c.id),
              (c.diffs || []).map((d) => diffRow(c, d)))))) : h('p', { class: 'muted', style: { margin: 0 } }, 'No differences to decide.')),
        dups.length ? h('section', { class: 'card stack' }, h('h3', null, 'Possible duplicates'),
          h('p', { class: 'muted', style: { margin: 0 } }, 'These look like the same document keyed into QuickBooks under another number. Link them, or create anyway.'),
          dups.map((c) => h('div', { class: 'row qbo-dup' }, h('div', { class: 'grow' }, Q.sideSummary(c.fishtape, ui.fmtMoney), h('div', { class: 'muted' }, 'QuickBooks: ', Q.sideSummary(c.quickbooks, ui.fmtMoney))),
            h('select', { 'aria-label': 'Choice', onChange: (e) => write(ctx, () => qboApi.setChoices([{ id: c.id, choice: e.target.value }])).then(load) },
              ['skip', 'link', 'create_in_qbo'].map((x) => h('option', { value: x, selected: c.choice === x }, x === 'create_in_qbo' ? 'Create anyway' : Q.CHOICE_LABEL[x])))))) : null,
        filed.length ? h('section', { class: 'card stack' }, h('h3', null, 'Creates in a filed GST period'),
          h('p', { class: 'muted', style: { margin: 0 } }, 'These add to a GST period already filed. Tick each one that should still go to QuickBooks; the rest are skipped.'),
          filed.map((c) => h('label', { class: 'field check' }, h('input', { type: 'checkbox', checked: Boolean(c.confirmed), onChange: (e) => write(ctx, () => qboApi.setChoices([{ id: c.id, choice: c.choice, confirmed: e.target.checked }])).then((r) => { if (r !== undefined) c.confirmed = e.target.checked; }) }),
            h('span', null, Q.sideSummary(c.fishtape, ui.fmtMoney))))) : null,
        plan ? planCard(plan, Q.undecidedDiffs(cands).length) : null,
        h('div', { class: 'row qbo-wizard-foot' }, ui.button('Back', { variant: 'ghost', icon: 'chevron-left', onClick: () => go('match') }), h('span', { class: 'grow' }),
          ready.ok ? null : h('span', { class: 'qbo-why muted' }, ready.why),
          ui.button('Apply', { variant: 'primary', icon: 'check', disabled: !ready.ok || Q.isOffline(ctx), onClick: async (e) => {
            const r = await write(ctx, () => qboApi.apply({ raiseNumbers: raise }), { btn: e.currentTarget });
            if (r !== undefined) go('apply');
          } })));
    };
    const diffRow = (c, d) => {
      const pick = c.fieldChoices?.[d.field] || null;
      const name = `f-${c.id}-${d.field}`;
      const opt = (side, value) => h('label', { class: ['qbo-side', pick === side ? 'picked' : null] },
        h('input', { type: 'radio', name, value: side, checked: pick === side, onChange: () => setField(c, d.field, side) }),
        h('span', { class: 'muted' }, side === 'fishtape' ? 'Fishtape' : 'QuickBooks'), h('span', null, d[side] === '' || d[side] == null ? '(empty)' : String(d[side])));
      return h('div', { class: ['qbo-diff-row', pick ? null : 'undecided'] }, h('span', { class: 'qbo-diff-field' }, d.label || d.field), opt('fishtape'), opt('quickbooks'));
    };
    // One line per kind of record (a five-column table does not fit a phone): only the counts that are not 0.
    const PLAN_PARTS = [['link', 'linked'], ['createInQbo', 'created in QuickBooks'], ['createInFishtape', 'created in Fishtape'], ['skip', 'left alone']];
    const planCard = (p, openDiffs = 0) => {
      const nums = Object.entries(p.numbers || {}).filter(([, v]) => v && v.qboHighest != null && v.fishtapeNext != null && Number(v.qboHighest) >= Number(v.fishtapeNext));
      // The server counts records with a difference left; the screen counts fields, as the Apply line does.
      const countOf = (w) => (['differences', 'differences_undecided', 'undecided_differences'].includes(w.code) ? Math.max(openDiffs, w.count || 0) : w.count);
      return h('section', { class: 'card stack' }, h('h3', null, 'What happens'),
        h('div', { class: 'list qbo-plan' }, (p.phases || []).map((r) => {
          const parts = PLAN_PARTS.filter(([k]) => r[k] > 0).map(([k, words]) => `${r[k]} ${words}`);
          return h('div', { class: 'list-row', dataset: { planKind: r.kind } },
            h('strong', { class: 'qbo-plan-kind' }, Q.MATCH_KINDS.find((k) => k.id === r.kind)?.label || r.kind),
            h('span', { class: parts.length ? null : 'muted' }, parts.length ? parts.join(' · ') : 'Nothing to do'));
        })),
        (p.warnings || []).length ? h('ul', { class: 'qbo-warnings' }, p.warnings.map((w) => { const n = countOf(w); return h('li', null, w.message || w.code, n != null ? ` (${n})` : ''); })) : null,
        nums.length ? h('label', { class: 'field check' }, h('input', { type: 'checkbox', onChange: (e) => { raise = e.target.checked; } }),
          h('span', null, `Raise Fishtape's next numbers above QuickBooks' highest (${nums.map(([k, v]) => `${k} ${v.qboHighest}`).join(', ')})`)) : null);
    };
    load();
  }

  // 6 Apply
  function stepApply(body, status) {
    const prog = h('div', { class: 'card stack' });
    body.append(prog);
    const draw = async (s) => {
      ui.clear(prog);
      const st = s?.setup || {};
      const done = s?.state === 'active' || st.phase === 'done' || Boolean(st.finishedAt);
      const pct = st.total ? Math.min(100, Math.round(((st.done || 0) / st.total) * 100)) : done ? 100 : 0;
      h(prog, null, h('h3', null, done ? 'Setup applied' : 'Applying…'),
        h('div', { class: 'qbo-progress' }, h('div', { class: 'progress' }, h('i', { style: { width: `${pct}%` } })), h('span', { class: 'muted' }, st.total ? `${st.done || 0} of ${st.total}` : '')),
        st.phase && !done ? h('p', { class: 'muted', style: { margin: 0 } }, `Working on: ${String(st.phase).replace(/_/g, ' ')}`) : null,
        done && s?.writeMode === 'shadow' ? banner(ui, 'warning', 'Practice mode: records are linked, nothing was written. Read the would-change list, then go live from the overview.') : null,
        st.errors ? h('div', { class: 'stack' }, banner(ui, 'danger', `${st.errors} record${st.errors === 1 ? '' : 's'} could not be set up.`), failures()) : null,
        h('div', { class: 'row' },
          !done ? ui.button('Stop after this part', { variant: 'ghost', onClick: (e) => write(ctx, () => qboApi.cancelSetup(), { ok: 'Stopping after this part', btn: e.currentTarget }) }) : null,
          st.errors ? ui.button('Retry', { icon: 'redo', onClick: (e) => write(ctx, () => qboApi.apply(), { ok: 'Trying again', btn: e.currentTarget }).then((r) => { if (r !== undefined) tick(); }) }) : null,
          done ? ui.button('Go to the overview', { variant: 'primary', href: '#/quickbooks' }) : null));
      if (!done) { clearTimeout(poll); poll = setTimeout(tick, 3000); }
    };
    const failures = () => {
      const list = h('div', { class: 'list' }, h('p', { class: 'muted' }, 'Loading…'));
      qboApi.matches({ status: 'error', limit: 50 }).then((r) => {
        ui.clear(list);
        for (const c of r.data || []) list.append(h('div', { class: 'list-row' }, h('div', { class: 'grow' }, h('div', { class: 'title' }, Q.sideSummary(c.fishtape || c.quickbooks, ui.fmtMoney)), h('div', { class: 'meta' }, c.error || c.message || Q.MATCH_KINDS.find((k) => k.id === c.kind)?.label || ''))));
      }).catch(() => ui.clear(list));
      return list;
    };
    const tick = async () => {
      if (!alive) return;
      try { const s = await qboApi.status(); lastStatus = s; draw(s); } catch { clearTimeout(poll); poll = setTimeout(tick, 3000); }
    };
    draw(status);
  }

  start();
  return () => { alive = false; clearTimeout(poll); if (typeof cleanupStep === 'function') cleanupStep(); };
}

// ---------------------------------------------------------------------------------------------
// Conflicts (7.7)
// ---------------------------------------------------------------------------------------------

const CONFLICT_KIND = { fields: 'Changed on both sides', review: 'To check', deleted: 'Deleted on one side', merged: 'Merged in QuickBooks' };

function renderConflicts(root, ctx) {
  const { ui, nav } = ctx;
  const { h } = ui;
  const host = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading…'));
  root.append(frame(ctx, 'conflicts', { subtitle: 'Records that need a person to decide' }, host));
  let alive = true, rows = [], cursor = null, more = false, status = 'open';
  const load = async (reset = true) => {
    if (Q.isOffline(ctx)) { ui.clear(host).append(ui.empty({ icon: 'alert', title: "You're offline", text: 'QuickBooks needs a connection.' })); return; }
    try {
      const r = await qboApi.conflicts({ status, cursor: reset ? undefined : cursor, limit: 50 });
      if (!alive) return;
      rows = reset ? r.data || [] : [...rows, ...(r.data || [])];
      cursor = r.cursor; more = Boolean(r.more);
      draw();
    } catch (e) { if (alive) ui.clear(host).append(ui.empty({ icon: 'alert', title: 'Conflicts could not be loaded', text: Q.errorText(e) })); }
  };
  const draw = () => {
    ui.clear(host);
    host.append(mfaBanner(ctx) || '', ui.tabs([{ id: 'open', label: 'Open' }, { id: 'resolved', label: 'Resolved' }], status, (s) => { status = s; load(true); }),
      ui.table({
        columns: [
          { key: 'label', label: 'Record', render: (c) => c.label || `${Q.COLLECTION_LABEL[c.collection] || c.collection} ${c.recordId}` },
          { key: 'kind', label: 'What', render: (c) => ui.badge(CONFLICT_KIND[c.kind] || c.kind, c.kind === 'review' ? 'warning' : c.kind === 'deleted' ? 'danger' : 'info') },
          { key: 'why', label: 'Why', render: (c) => Q.REVIEW_REASON[c.reason] || (c.fields || []).map((f) => f.label).join(', ') || '—' },
          { key: 'at', label: 'Since', render: (c) => ui.fmtDateTime(c.createdAt) },
        ],
        rows,
        onRowClick: (c) => nav(`#/quickbooks/conflicts/${encodeURIComponent(c.id)}`),
        empty: ui.empty({ icon: 'check', title: status === 'open' ? 'Nothing to decide' : 'Nothing resolved yet', text: status === 'open' ? 'When Fishtape and QuickBooks disagree about a record, it shows here.' : null }),
      }),
      more ? ui.button('Show more', { variant: 'ghost', onClick: () => load(false) }) : null);
  };
  load(true);
  return () => { alive = false; };
}

function renderConflict(root, ctx, id) {
  const { ui, nav } = ctx;
  const { h } = ui;
  const host = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading…'));
  root.append(frame(ctx, 'conflicts', { title: 'Decide', subtitle: h('a', { href: '#/quickbooks/conflicts' }, '← All conflicts') }, host));
  let alive = true;
  const picks = {};
  // The note of a noted difference outlives a redraw of the conflict (r1-get-paid.md 9.6).
  let noteText = '';
  const resolve = async (body, btn) => {
    const r = await write(ctx, () => Q.resolveConflict(id, body), { ok: 'Decided', btn });
    if (r !== undefined) nav('#/quickbooks/conflicts');
  };
  // Choices that delete, void or unlink in the books are confirmed first.
  const confirmThen = async (e, text, okLabel, body) => {
    const btn = e.currentTarget;
    if (!(await ui.confirmDialog(text, { title: 'Are you sure?', okLabel }))) return;
    resolve(body, btn);
  };
  // The column heads; on a phone each value carries its own (data-label), so the heads are hidden.
  const gridHead = () => ['Field', 'Before', 'Fishtape', 'QuickBooks'].map((t) => h('span', { class: 'muted qbo-cg-head' }, t));
  const draw = (c) => {
    ui.clear(host);
    const href = Q.recordHref(c.collection, c.recordId);
    const resolved = c.status && c.status !== 'open';
    const title = h('div', { class: 'row qbo-conflict-title' }, h('h3', { class: 'grow', style: { margin: 0 } }, c.label || c.recordId), ui.badge(CONFLICT_KIND[c.kind] || c.kind, 'warning'),
      href ? ui.button('Open record', { size: 'sm', variant: 'ghost', href }) : null);
    const actions = [];
    if (c.kind === 'fields') {
      const fields = c.fields || [];
      const allPicked = () => fields.every((f) => picks[f.field]);
      const applyBtn = ui.button('Use my choices', { variant: 'primary', disabled: true, onClick: (e) => resolve({ choice: 'fields', fields: { ...picks } }, e.currentTarget) });
      host.append(title, mfaBanner(ctx) || '', h('div', { class: 'card stack' },
        h('p', { class: 'muted', style: { margin: 0 } }, 'Both sides changed these since they last agreed. Pick the right value for each; it is written to the other side.'),
        h('div', { class: 'qbo-conflict-grid' }, gridHead(),
          fields.map((f) => [h('strong', null, f.label || f.field), h('span', { class: 'muted', dataset: { label: 'Before' } }, fmtVal(f.base)),
            sidePick(f, 'fishtape'), sidePick(f, 'quickbooks')]))));
      function sidePick(f, side) {
        return h('label', { class: 'qbo-side', dataset: { label: side === 'fishtape' ? 'Fishtape' : 'QuickBooks' } }, h('input', { type: 'radio', name: `c-${f.field}`, disabled: resolved, onChange: () => { picks[f.field] = side; applyBtn.disabled = !allPicked(); } }), h('span', null, fmtVal(f[side])));
      }
      actions.push(ui.button('Use Fishtape for all', { onClick: (e) => resolve({ choice: 'fishtape' }, e.currentTarget) }),
        ui.button('Use QuickBooks for all', { onClick: (e) => resolve({ choice: 'quickbooks' }, e.currentTarget) }), applyBtn);
    } else {
      host.append(title, mfaBanner(ctx) || '', h('div', { class: 'card stack' },
        h('p', { style: { margin: 0 } }, c.message || Q.REVIEW_REASON[c.reason] || CONFLICT_KIND[c.kind] || ''),
        (c.fields || []).length ? h('div', { class: 'qbo-conflict-grid' }, gridHead(),
          c.fields.map((f) => [h('strong', null, f.label || f.field), h('span', { class: 'muted', dataset: { label: 'Before' } }, fmtVal(f.base)), h('span', { dataset: { label: 'Fishtape' } }, fmtVal(f.fishtape)), h('span', { dataset: { label: 'QuickBooks' } }, fmtVal(f.quickbooks))])) : null));
      const r1 = c.kind === 'review' ? Q.reviewChoices(c.reason) : null;
      if (r1) {
        // Release 1 reviews (r1-get-paid.md 9.2, 9.6, 9.7): their own choices; a noted difference carries a note.
        const note = r1.choices.some((x) => x.note) ? h('textarea', { rows: 2, maxlength: 500, 'aria-label': 'Note', placeholder: 'Why the difference stays (kept with the record)', value: noteText, onInput: (e) => { noteText = e.target.value; }, onChange: (e) => { noteText = e.target.value; } }) : null;
        if (r1.hint) host.append(h('p', { class: 'muted', dataset: { r1Hint: '1' }, style: { margin: 0 } }, r1.hint));
        if (note) host.append(h('label', { class: 'field' }, h('span', null, 'Note'), note));
        for (const x of r1.choices) {
          const body = () => { const text = (noteText || note?.value || '').trim(); return { choice: x.choice, ...(x.note && text ? { note: text.slice(0, 500) } : {}) }; };
          actions.push(x.choice === 'unlink'
            ? ui.button(x.label, { variant: 'ghost danger', onClick: (e) => confirmThen(e, `Unlink ${c.label || 'this record'} from QuickBooks? Both records are kept; nothing is sent for it until it is linked again or sent as new.`, 'Unlink', body()) })
            : ui.button(x.label, { variant: x.primary ? 'primary' : 'secondary', onClick: (e) => resolve(body(), e.currentTarget) }));
        }
      } else if (c.kind === 'review') {
        if (c.reason === 'name_taken') actions.push(ui.button('Link to the QuickBooks customer', { variant: 'primary', onClick: (e) => resolve({ choice: 'link' }, e.currentTarget) }), ui.button('Create with a new name', { onClick: (e) => resolve({ choice: 'create' }, e.currentTarget) }));
        else {
          const approve = { origin: 'Approve and send', filed_period: 'Send it anyway', payroll_locked: 'Send it anyway', payout_items: 'I entered these in QuickBooks' }[c.reason] || "Use Fishtape's version";
          // 7.7: on an origin review, keeping QuickBooks puts Fishtape back to the QuickBooks copy.
          if (c.reason === 'origin') host.append(h('p', { class: 'muted', dataset: { keepQbo: '1' }, style: { margin: 0 } }, "Don't send it: Fishtape goes back to the QuickBooks copy; the change is not sent."));
          actions.push(ui.button(approve, { variant: 'primary', onClick: (e) => resolve({ choice: 'fishtape' }, e.currentTarget) }),
            ui.button(['origin', 'filed_period', 'payroll_locked'].includes(c.reason) ? "Don't send it" : "Keep QuickBooks' version", { onClick: (e) => resolve({ choice: 'quickbooks' }, e.currentTarget) }),
            ui.button('Unlink', { variant: 'ghost danger', onClick: (e) => confirmThen(e, `Unlink ${c.label || 'this record'} from QuickBooks? Both records are kept; nothing is sent for it until it is linked again or sent as new.`, 'Unlink', { choice: 'unlink' }) }));
        }
      } else if (c.kind === 'deleted') {
        actions.push(ui.button('Restore it', { variant: 'primary', onClick: (e) => resolve({ choice: 'restore' }, e.currentTarget) }),
          ui.button('Delete it on the other side too', { variant: 'ghost danger', onClick: (e) => confirmThen(e, `Delete ${c.label || 'this record'} on the other side too? In QuickBooks an invoice or payment is voided or deleted; in Fishtape the record is deleted.`, 'Delete it', { choice: 'delete' }) }));
      } else if (c.kind === 'merged') {
        // 5.6: the person picks which of the merged Fishtape records to unlink (both, when the server lists both).
        const ids = [...new Set([c.recordId, ...(Array.isArray(c.recordIds) ? c.recordIds : [])].filter(Boolean))];
        const nameOf = (rid) => { const r = ctx.store?.get?.(c.collection, rid); return r?.number || r?.name || 'this record'; };
        for (const rid of ids) {
          const label = ids.length > 1 ? `Unlink ${nameOf(rid)}` : 'Unlink this record';
          actions.push(ui.button(label, { variant: ids.length > 1 ? 'secondary' : 'primary', onClick: (e) => confirmThen(e, 'This Fishtape record stops syncing with the merged QuickBooks record. Nothing is deleted.', 'Unlink', { choice: 'unlink', recordId: rid }) }));
        }
      }
    }
    host.append(resolved ? h('p', { class: 'muted' }, `Resolved${c.resolvedAt ? ` ${ui.fmtDateTime(c.resolvedAt)}` : ''}.`) : h('div', { class: 'row qbo-actions' }, Q.isOffline(ctx) ? [] : actions));
  };
  qboApi.conflict(id).then((c) => { if (alive) draw(c); }).catch((e) => { if (alive) ui.clear(host).append(ui.empty({ icon: 'alert', title: e.status === 404 ? 'This conflict no longer exists' : 'Could not load it', text: e.status === 404 ? null : Q.errorText(e) })); });
  return () => { alive = false; };
}

const fmtVal = (v) => (v == null || v === '' ? '(empty)' : typeof v === 'object' ? JSON.stringify(v) : String(v));

// ---------------------------------------------------------------------------------------------
// Activity (7.5 log)
// ---------------------------------------------------------------------------------------------

function renderActivity(root, ctx) {
  const { ui, query } = ctx;
  const { h } = ui;
  const host = h('div', { class: 'stack' });
  root.append(frame(ctx, 'activity', { subtitle: 'What was sent to and received from QuickBooks' }, host));
  let alive = true, rows = [], cursor = null, more = false;
  if (query.show === 'waiting') return renderWaiting(host, ctx, () => { alive = false; });
  const f = { outcome: query.outcome || '', collection: query.collection || '', recordId: query.recordId || '' };
  const filters = h('div', { class: 'row qbo-filters' },
    h('label', { class: 'field' }, h('span', null, 'Show'), h('select', { name: 'outcome', onChange: (e) => { f.outcome = e.target.value; load(true); } }, Q.OUTCOMES.map((o) => h('option', { value: o.id, selected: o.id === f.outcome }, o.label)))),
    h('label', { class: 'field' }, h('span', null, 'Records'), h('select', { name: 'collection', onChange: (e) => { f.collection = e.target.value; f.recordId = ''; load(true); } },
      h('option', { value: '' }, 'All records'), Object.entries(Q.COLLECTION_PLURAL).map(([k, v]) => h('option', { value: k, selected: k === f.collection }, v)))),
    f.recordId ? ui.button('All records', { size: 'sm', variant: 'ghost', icon: 'x', onClick: (e) => { f.recordId = ''; e.currentTarget.remove(); load(true); } }) : null);
  const list = h('div');
  host.append(f.outcome === 'shadow' ? banner(ui, 'warning', 'Practice mode: these are the changes Fishtape would have made. Nothing was written.') : '', filters, list);
  const load = async (reset = true) => {
    if (Q.isOffline(ctx)) { ui.clear(list).append(ui.empty({ icon: 'alert', title: "You're offline", text: 'QuickBooks needs a connection.' })); return; }
    try {
      const r = await qboApi.log({ ...f, cursor: reset ? undefined : cursor, limit: 50 });
      if (!alive) return;
      rows = reset ? r.data || [] : [...rows, ...(r.data || [])];
      cursor = r.cursor; more = Boolean(r.more);
      draw();
    } catch (e) { if (alive) ui.clear(list).append(ui.empty({ icon: 'alert', title: 'The activity could not be loaded', text: Q.errorText(e) })); }
  };
  const tone = (o) => ({ error: 'danger', warning: 'warning', conflict: 'warning', shadow: 'accent', skipped: 'neutral', info: 'info', ok: 'success' }[o] || 'neutral');
  const draw = () => {
    ui.clear(list);
    list.append(ui.table({
      columns: [
        { key: 'at', label: 'When', render: (l) => ui.fmtDateTime(l.at) },
        { key: 'dir', label: 'Way', render: (l) => (l.direction === 'pull' ? 'From QuickBooks' : l.direction === 'push' ? 'To QuickBooks' : l.direction || '—') },
        { key: 'outcome', label: 'Result', render: (l) => ui.badge(Q.OUTCOMES.find((o) => o.id === l.outcome)?.label || l.outcome || '—', tone(l.outcome)) },
        { key: 'rec', label: 'Record', render: (l) => { const href = Q.recordHref(l.collection, l.recordId); return href ? h('a', { href, onClick: (e) => e.stopPropagation() }, l.label || l.recordId) : l.label || l.collection || '—'; } },
        { key: 'msg', label: 'What happened', render: (l) => l.message || l.action || '—' },
      ],
      rows,
      onRowClick: (l) => detail(l),
      empty: ui.empty({ icon: 'activity', title: 'Nothing yet', text: 'Changes show here once QuickBooks syncs.' }),
    }));
    if (more) list.append(ui.button('Show more', { variant: 'ghost', onClick: () => load(false) }));
  };
  const detail = (l) => {
    const s = ui.openSheet({
      title: 'Activity', dialog: true,
      body: h('dl', { class: 'qbo-facts' },
        h('dt', null, 'When'), h('dd', null, ui.fmtDateTime(l.at)),
        h('dt', null, 'What'), h('dd', null, [l.action, l.outcome].filter(Boolean).join(' · ')),
        l.label ? [h('dt', null, 'Record'), h('dd', null, l.label)] : null,
        l.actorType ? [h('dt', null, 'Caused by'), h('dd', null, { user: 'An office user', field_user: 'A field user', api_key: 'An API key', agent: 'The assistant', stripe: 'Stripe', system: 'Fishtape', sweep: 'Fishtape (catch-up)' }[l.actorType] || l.actorType)] : null,
        l.message ? [h('dt', null, 'Message'), h('dd', null, l.message)] : null,
        l.errorCode ? [h('dt', null, 'QuickBooks error'), h('dd', { class: 'mono' }, l.errorCode)] : null,
        l.intuitTid ? [h('dt', null, 'Intuit transaction id'), h('dd', { class: 'mono' }, l.intuitTid, h('div', { class: 'hint muted' }, 'Give this to Intuit support if they ask.'))] : null),
      actions: [ui.button('Close', { variant: 'ghost', onClick: () => s.close() })],
    });
  };
  load(true);
  return () => { alive = false; };
}

/** The records waiting to be sent (link state blocked), each with why: the overview's "Waiting" count. */
function renderWaiting(host, ctx, stop) {
  const { ui } = ctx;
  const { h } = ui;
  let alive = true;
  const list = h('div', null, h('p', { class: 'muted' }, 'Loading…'));
  host.append(h('div', { class: 'row' }, h('h3', { style: { margin: 0 } }, 'Waiting to be sent'), h('span', { class: 'grow' }), ui.button('All activity', { size: 'sm', variant: 'ghost', href: '#/quickbooks/activity' })), list);
  if (Q.isOffline(ctx)) { ui.clear(list).append(ui.empty({ icon: 'alert', title: "You're offline", text: 'QuickBooks needs a connection.' })); return () => { alive = false; stop(); }; }
  qboApi.waiting({ limit: 200 }).then((r) => {
    if (!alive) return;
    ui.clear(list).append(ui.table({
      columns: [
        { key: 'rec', label: 'Record', render: (w) => { const href = Q.recordHref(w.collection, w.recordId); const text = w.label || `${Q.COLLECTION_LABEL[w.collection] || w.collection} ${w.recordId}`; return href ? h('a', { href }, text) : text; } },
        { key: 'why', label: 'Waiting for', render: (w) => Q.reasonText({ state: 'blocked', reason: w.reason }) || w.message || w.reason || '—' },
        { key: 'at', label: 'Since', render: (w) => (w.since ? ui.fmtDateTime(w.since) : '—') },
      ],
      rows: r?.data || [],
      onRowClick: (w) => Q.openRecordSheet(ctx, w.collection, w.recordId),
      empty: ui.empty({ icon: 'check', title: 'Nothing is waiting', text: 'Every record that should be in QuickBooks has gone.' }),
    }));
  }).catch((e) => { if (alive) ui.clear(list).append(ui.empty({ icon: 'alert', title: 'The list could not be loaded', text: Q.errorText(e) })); });
  return () => { alive = false; stop(); };
}

// ---------------------------------------------------------------------------------------------
// Look-up (7.8, 8.6)
// ---------------------------------------------------------------------------------------------

function renderLookup(root, ctx) {
  const { ui, query, store, nav } = ctx;
  const { h } = ui;
  const host = h('div', { class: 'stack' });
  root.append(frame(ctx, 'lookup', { subtitle: 'Search your QuickBooks company and bring a record into Fishtape' }, host));
  let alive = true;
  let entity = ['customers', 'invoices', 'estimates'].includes(query.entity) ? query.entity : 'customers';
  let taxCodes = null;
  const client = query.clientId ? store.get('clients', query.clientId) : null;
  const results = h('div');
  const note = h('div');
  const input = h('input', { class: 'input', type: 'search', name: 'q', value: entity === 'customers' && client ? client.name : '', 'aria-label': 'Search QuickBooks', maxlength: 100 });
  const statusSel = h('select', { 'aria-label': 'Which', name: 'status' });
  const searchBtn = ui.button('Search', { variant: 'primary', icon: 'search', onClick: () => search() });
  const drawControls = () => {
    input.placeholder = entity === 'customers' ? 'Customer name (at least 2 letters)' : 'Number starts with… (optional)';
    ui.clear(statusSel).append(...(entity === 'customers' ? [] : (entity === 'invoices' ? [['open', 'Open'], ['all', 'All']] : [['pending', 'Pending'], ['all', 'All']]).map(([v, l]) => h('option', { value: v }, l))));
    statusSel.hidden = entity === 'customers';
  };
  const tabsHost = h('div');
  // Always in the page (an empty, hidden paragraph without a client): host.append is the DOM's own
  // and would write a null as the text "null".
  const clientNote = h('p', { class: 'muted', style: { margin: 0 } }, client ? `For ${client.name}` : '');
  const drawClientNote = () => { clientNote.hidden = !(client && entity !== 'customers'); };
  const drawTabs = () => ui.clear(tabsHost).append(ui.tabs([{ id: 'customers', label: 'Customers' }, { id: 'invoices', label: 'Invoices' }, { id: 'estimates', label: 'Estimates' }], entity,
    (e) => { entity = e; ui.clear(results); input.value = ''; drawControls(); drawTabs(); drawClientNote(); }));
  host.append(
    tabsHost,
    note,
    h('form', { class: 'row qbo-lookup-form', onSubmit: (e) => { e.preventDefault(); search(); } }, input, statusSel, searchBtn),
    clientNote,
    results);
  drawClientNote();
  drawTabs();
  drawControls();

  const disable = (why) => { ui.clear(note).append(banner(ui, 'warning', why)); searchBtn.disabled = true; input.disabled = true; };
  if (Q.isOffline(ctx)) disable("You're offline; QuickBooks needs a connection.");
  else qboApi.status().then((s) => {
    lastStatus = s;
    if (!alive) return;
    if (!Q.connectionActive(s) && s.state !== 'setup') disable('Connect QuickBooks first.');
    else if (s.lookupsEnabled === false) disable("Look-ups are off for the rest of the month: your company used most of this month's QuickBooks reads.");
  }).catch(() => {});

  async function search() {
    const q = input.value.trim();
    if (entity === 'customers' && q.length < 2) { ui.toast('Type at least 2 letters', 'error'); return; }
    if (/[%_]/.test(q)) { ui.toast('Leave out % and _', 'error'); return; }
    const body = entity === 'customers' ? { q, limit: 25 }
      : { status: statusSel.value || 'all', limit: 25, ...(q ? { q } : {}), ...(client ? { clientId: client.id } : {}) };
    ui.clear(results).append(h('p', { class: 'muted' }, 'Searching QuickBooks…'));
    busy(searchBtn, true);
    try {
      const r = await qboApi.lookup(entity, body);
      if (!alive) return;
      drawResults(r.data || []);
    } catch (e) {
      ui.clear(results).append(h('p', null, Q.errorText(e)));
    } finally { busy(searchBtn, false); }
  }
  const drawResults = (rows) => {
    ui.clear(results);
    const linkTo = (l) => (l ? Q.recordHref(l.collection, l.id) : null);
    results.append(ui.table({
      columns: entity === 'customers' ? [
        { key: 'name', label: 'Customer', render: (r) => h('span', null, r.name, r.isJob ? h('span', { class: 'muted' }, ' (job)') : null, r.active === false ? h('span', { class: 'muted' }, ' (inactive)') : null) },
        { key: 'email', label: 'Email', render: (r) => r.email || '—' },
        { key: 'bal', label: 'Owing', align: 'right', render: (r) => (r.balanceCents != null ? ui.fmtMoney(r.balanceCents) : '—') },
        { key: 'act', label: '', render: (r) => action(r) },
      ] : [
        { key: 'num', label: 'Number', render: (r) => h('span', { class: 'mono' }, r.docNumber || '—') },
        { key: 'cust', label: 'Customer', render: (r) => r.customer || '—' },
        { key: 'date', label: 'Date', render: (r) => ui.fmtDate(r.date) },
        { key: 'total', label: 'Total', align: 'right', render: (r) => ui.fmtMoney(r.totalCents) },
        { key: 'bal', label: 'Owing', align: 'right', render: (r) => (r.balanceCents != null ? ui.fmtMoney(r.balanceCents) : '—') },
        { key: 'act', label: '', render: (r) => action(r) },
      ],
      rows,
      onRowClick: (r) => preview(r),
      empty: ui.empty({ icon: 'search', title: 'Nothing found in QuickBooks' }),
    }));
    function action(r) {
      const href = linkTo(r.linked);
      if (href) return ui.button('Open in Fishtape', { size: 'sm', variant: 'ghost', href });
      if (r.linked) return ui.badge('In Fishtape', 'success');
      return ui.button('Import into Fishtape', { size: 'sm', icon: 'download', onClick: (e) => { e.stopPropagation(); importIt(r, e.currentTarget); } });
    }
  };
  async function importIt(r, btn) {
    const res = await write(ctx, () => qboApi.importOne(entity, r.qboId), { ok: 'Imported into Fishtape', btn });
    if (!res) return;
    // The record reaches this device with the next sync; pull now so the link opens it.
    try { await ctx.app?.sync?.syncNow?.(); } catch { /* it arrives with the next pull */ }
    const href = Q.recordHref(res.collection, res.id);
    if (href) nav(href);
  }
  function preview(r) {
    const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading…'));
    const s = ui.openSheet({ title: entity === 'customers' ? r.name : `${entity === 'invoices' ? 'Invoice' : 'Estimate'} ${r.docNumber || ''}`, body, actions: [ui.button('Close', { variant: 'ghost', onClick: () => s.close() })] });
    // The tax code names come from the mappings' lists (read once per screen): a line shows the
    // code's name, never its QuickBooks id.
    const codes = entity === 'customers' ? Promise.resolve([]) : (taxCodes ||= qboApi.mappings().then((m) => m?.choices?.taxCodes || []).catch(() => []));
    Promise.all([qboApi.lookupOne(entity, r.qboId), codes]).then(([o, list]) => {
      ui.clear(body);
      const v = Q.lookupFacts(entity, o, { money: (c) => ui.fmtMoney(c), date: (d) => ui.fmtDate(d), taxCodeName: (id) => list.find((c) => String(c.id) === id)?.name || null });
      h(body, null,
        v.facts.length ? h('dl', { class: 'qbo-facts' }, v.facts.map(([k, val]) => [h('dt', null, k), h('dd', null, val)])) : null,
        v.lines.length ? ui.table({ columns: [
          { key: 'd', label: 'Description', render: (l) => l.description || '—' },
          { key: 'q', label: 'Qty', align: 'right', render: (l) => (l.qty != null ? String(l.qty) : '—') },
          { key: 'a', label: 'Amount', align: 'right', render: (l) => ui.fmtMoney(l.amountCents) },
          ...(v.taxColumn ? [{ key: 't', label: 'Tax', render: (l) => l.taxName || '—' }] : []),
        ], rows: v.lines }) : null,
        Q.trademarkLine(ui));
    }).catch((e) => { ui.clear(body).append(h('p', null, Q.errorText(e))); });
  }
  if (client && entity === 'customers' && !Q.isOffline(ctx)) setTimeout(() => { if (alive && !searchBtn.disabled) search(); }, 0);
  return () => { alive = false; };
}
