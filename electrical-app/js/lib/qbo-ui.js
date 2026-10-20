// QuickBooks in the PWA (docs/integrations/quickbooks.md section 8): the words for every state,
// who may see any of it, the per-record badges and their sheet, the in-memory status cache, the
// "Why no tax?" picker and the trademark line. modules/quickbooks.js draws the screens.
//
// The top half is pure (no DOM, no ui.js import) so node --test can check it. The DOM helpers take
// the screen's ctx and build with ctx.ui.
//
// Nothing from QuickBooks is stored on the device (8.7): the status cache lives in memory for
// 30 seconds, is never written to localStorage, IndexedDB or the store, and badges hide offline.
// The word "QBO" never reaches a screen; screens say "QuickBooks" (Intuit's branding rules).
import { qboApi, QBO_COLLECTIONS } from './qbo-api.js';
import { lineTaxIds, taxKey } from './qbo-export.js';
import { KINDS, keepsServerPaid, taxRoundingCents } from './money.js';

// The tax-rounding rule lives in lib/money.js so every screen shows the same status (invoiceShown).
export { keepsServerPaid, taxRoundingCents };
import { TAX_NONE_REASONS, ratesOn, provinceName, taxComponents, treatmentsFor, fmtPct } from './tax.js';

// ---------------------------------------------------------------------------------------------
// Fixed text
// ---------------------------------------------------------------------------------------------

/** Ends every QuickBooks screen and the guide (8). VERIFY the exact wording with Intuit's guidelines. */
export const TRADEMARK = 'QuickBooks and Intuit are trademarks of Intuit Inc., used with permission.';

/** The connect screen's disclosure (10.1, open question 13.11 default). */
export const AI_DISCLOSURE = "Fishtape's assistant can read your Fishtape records, including those that sync with QuickBooks. QuickBooks' own data (links, sync log, look-ups) is never given to the assistant.";

/**
 * Intuit's official "Connect to QuickBooks" button image, once Kelvin has downloaded it from
 * Intuit's developer site under its licence (see img/intuit/README.md). Until then the connect
 * control is a plain Fishtape button with the same words; no Intuit artwork is drawn or imitated.
 */
export const CONNECT_BUTTON_ASSET = null; // e.g. 'img/intuit/C2QB_green_btn_med_default.svg'

/** Office roles (7.1). Field roles and crew sessions never see QuickBooks. */
export const QBO_ROLES = ['owner', 'admin', 'office'];
export const QBO_ADMIN_ROLES = ['owner', 'admin'];

/** Link states (3.4) as badge words and tones. */
export const LINK_STATE = {
  pending: { text: 'Sending to QuickBooks', tone: 'info' },
  synced: { text: 'In QuickBooks', tone: 'success' },
  conflict: { text: 'Needs a decision', tone: 'warning' },
  error: { text: 'Not in QuickBooks', tone: 'danger' },
  blocked: { text: 'Waiting', tone: 'warning' },
  needs_review: { text: 'Check in QuickBooks', tone: 'warning' },
  deleted_remote: { text: 'Removed in QuickBooks', tone: 'neutral' },
  deleted_local: { text: 'Deleted', tone: 'neutral' },
  unlinked: { text: 'Not linked to QuickBooks', tone: 'neutral' },
};

/** Why a link waits (state `blocked`), in words. */
export const BLOCKED_REASON = {
  dependency: 'another record goes first',
  employee_not_linked: 'employee not linked to QuickBooks',
  mapping_missing: 'a QuickBooks code or account to pick',
  tax_reason: 'pick why this has no tax',
  feature_missing: 'not turned on in QuickBooks',
  module_off: 'module turned off',
  currency: 'not in Canadian dollars',
  books_closed: 'books closed in QuickBooks',
  no_invoice: 'no invoice',
  duplicate_number_local: 'number used twice',
  totals_mismatch: "bill total doesn't add up",
  stripe_unbooked: 'Stripe payments not booked yet',
};

/** Why a person must look (state `needs_review`, conflict kind `review`). */
export const REVIEW_REASON = {
  tax_shape: 'QuickBooks taxes this differently from how Fishtape can',
  totals_differ: "QuickBooks' totals differ from Fishtape's",
  tax_inclusive: 'Entered in QuickBooks with tax included',
  filed_period: 'This changes a GST period already filed',
  payroll_locked: 'Hours already paid; change them in QuickBooks Payroll if needed',
  origin: 'Made by an API key or the assistant; approve to send to QuickBooks',
  payout_items: 'This Stripe payout has items Fishtape cannot book',
  wizard_differs: 'Fishtape and QuickBooks differ; decide which is right',
  name_taken: 'The name is already used in QuickBooks',
};

/** Why a link failed (state `error`). Unknown reasons fall back to the server's message. */
export const ERROR_REASON = {
  tax_mismatch: "QuickBooks' tax differs from Fishtape's",
  duplicate_number: 'QuickBooks already has this number',
  number_too_long: 'The number is longer than QuickBooks allows (21 characters)',
  negative_line: 'QuickBooks refused a negative line',
  deposited: 'Remove it from the deposit in QuickBooks first',
  paid: 'Paid in QuickBooks; change it there',
  open_balance: 'Has an open balance in QuickBooks',
};

/** Connection pause reasons (2.5). */
export const PAUSE_REASON = {
  user: 'Paused by someone in your company.',
  plan: 'Paused: QuickBooks sync is in the Pro plan and up.',
  budget: 'Paused until the 1st: Fishtape used up its QuickBooks allowance for the month.',
  tenant_budget: "Paused until the 1st: your company used up this month's QuickBooks reads.",
  brake: 'Paused by the safety brake: more changes than usual in the last hour.',
  hq: 'Paused by Fishtape support.',
};

/** Why a reconnect is needed (2.5). */
export const RECONNECT_REASON = {
  revoked: 'QuickBooks ended the connection (disconnected in QuickBooks, or the access was revoked).',
  expired: 'The QuickBooks connection expired.',
  not_canada: 'The QuickBooks company is not a Canadian company.',
  not_cad: "The QuickBooks company's home currency is not the Canadian dollar.",
  environment: 'This server now connects to a different QuickBooks environment.',
  error: 'QuickBooks refused the connection.',
};

/** The callback result (2.2) on #/quickbooks?connect=<result>. Same meaning as the server's done page. */
export const CONNECT_RESULT = {
  ok: { tone: 'success', title: 'QuickBooks is connected', text: 'Next: set up what syncs and match your records.' },
  state_invalid: { tone: 'danger', title: 'The connect link expired', text: 'It expired or was already used. Press Connect to QuickBooks again.' },
  forbidden: { tone: 'danger', title: 'Not allowed', text: 'Only an owner or admin of the company can connect QuickBooks.' },
  plan: { tone: 'danger', title: 'Not in your plan', text: 'QuickBooks sync is part of the Pro plan and up.' },
  denied: { tone: 'info', title: 'Not connected', text: 'QuickBooks was not connected. You can try again any time.' },
  exchange_failed: { tone: 'danger', title: 'Something went wrong', text: 'QuickBooks did not finish connecting. Try again in a minute.' },
  not_canada: { tone: 'danger', title: 'Canadian companies only', text: 'Fishtape connects to Canadian QuickBooks Online companies only.' },
  not_cad: { tone: 'danger', title: 'Canadian dollars only', text: 'Fishtape connects to QuickBooks companies whose home currency is the Canadian dollar.' },
  realm_in_use: { tone: 'warning', title: 'Connected to another Fishtape company', text: 'This QuickBooks company is connected to another Fishtape company.' },
  wrong_company: { tone: 'danger', title: 'A different QuickBooks company', text: 'That is not the QuickBooks company this Fishtape company was connected to. Reconnect with the same company.' },
  purge_required: { tone: 'warning', title: 'Delete the old links first', text: 'This Fishtape company still has links to another QuickBooks company. Delete them first (Disconnect, with "Also delete the links"), then connect.' },
  unavailable: { tone: 'danger', title: 'Not available', text: "QuickBooks isn't available on this server yet." },
};

export function connectResultText(result) {
  return CONNECT_RESULT[result] || CONNECT_RESULT.exchange_failed;
}

/** Sync log outcomes (7.5 LogEntry.outcome) in words, for the activity filter. */
export const OUTCOMES = [
  { id: '', label: 'Everything' },
  { id: 'ok', label: 'Sent or received' },
  { id: 'error', label: 'Errors' },
  { id: 'warning', label: 'Warnings' },
  { id: 'conflict', label: 'Needs a decision' },
  { id: 'auto_resolved', label: 'Settled automatically' },
  { id: 'skipped', label: 'Skipped' },
  { id: 'shadow', label: 'Would change (practice mode)' },
];

export const COLLECTION_LABEL = {
  clients: 'Client', jobs: 'Job', items: 'Product or service', vendors: 'Supplier', estimates: 'Estimate', invoices: 'Invoice',
  payments: 'Payment', bills: 'Bill', purchaseOrders: 'Purchase order', timeEntries: 'Time entry', stripePayouts: 'Stripe payout',
};
export const COLLECTION_ROUTE = {
  clients: (id) => `#/clients/${id}`, jobs: (id) => `#/jobs/${id}`, items: () => '#/inventory', vendors: (id) => `#/purchasing/vendors/${id}`,
  estimates: (id) => `#/estimates/${id}`, invoices: (id) => `#/invoices/${id}`, bills: (id) => `#/purchasing/bills/${id}`,
  purchaseOrders: (id) => `#/purchasing/orders/${id}`, timeEntries: () => '#/time/week', payments: () => null, stripePayouts: () => null,
};
export const recordHref = (collection, id) => (COLLECTION_ROUTE[collection] ? COLLECTION_ROUTE[collection](encodeURIComponent(id)) : null);

/** Settlement payments (4.9): written only by the QuickBooks sync, shown read-only. */
export const SETTLEMENT_LABEL = 'Credited or paid in QuickBooks';
export const isSettlementPayment = (p) => Boolean(p) && p.method === 'credit' && p.source === 'quickbooks';
export const DEPOSIT_LABEL = 'Deposit in QuickBooks';
/** A QuickBooks deposit on the invoice (payment 'deposit-<invoiceId>', 4.7): also written only by the sync. */
export const isDepositPayment = (p) => Boolean(p) && String(p.id || '').startsWith('deposit-') && (p.source === 'quickbooks' || p.reference === DEPOSIT_LABEL);
/** Payments only the QuickBooks sync writes: shown read-only, never deleted here. */
export const isQuickBooksPayment = (p) => isSettlementPayment(p) || isDepositPayment(p);

// ---------------------------------------------------------------------------------------------
// Who sees QuickBooks
// ---------------------------------------------------------------------------------------------

/** Does the plan (with HQ overrides, as /me sends them) include QuickBooks? */
export function planHasQuickBooks(entitlements) {
  return Boolean(entitlements && Array.isArray(entitlements.features) && entitlements.features.includes('quickbooks'));
}

/**
 * May this person see anything QuickBooks? Signed in (not the demo), an office role in a normal
 * session (not a crew PIN session), the invoices permission, and the plan. Field roles: never.
 * @param {{ synced: boolean, role: string, crew?: boolean, can: (perm: string) => boolean, entitlements?: object|null, plan?: boolean }} who
 */
export function qboAllowed({ synced, role, crew = false, can, entitlements = null, plan = true }) {
  if (!synced || crew || !QBO_ROLES.includes(role)) return false;
  if (typeof can === 'function' && !can('invoices')) return false;
  return plan ? planHasQuickBooks(entitlements) : true;
}

/** The same question from a screen's ctx. `plan: false` skips the plan check (the module's own screen shows the upgrade card). */
export function allowedFor(ctx, { plan = true } = {}) {
  const auth = ctx?.auth;
  if (!auth) return false;
  return qboAllowed({
    synced: Boolean(auth.synced), role: auth.role?.(), crew: Boolean(auth.isCrew?.()), can: (p) => auth.can(p),
    entitlements: ctx.app?.session?.me?.entitlements || null, plan,
  });
}

export const isAdminRole = (role) => QBO_ADMIN_ROLES.includes(role);

/** No network, or the sync engine says offline. QuickBooks screens need a connection (8.7). */
export function isOffline(ctx) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  try { return ctx?.app?.sync?.status?.()?.state === 'offline'; } catch { return false; }
}

// ---------------------------------------------------------------------------------------------
// Errors in words
// ---------------------------------------------------------------------------------------------

export const MFA_TEXT = 'Turn on two-step sign-in to change QuickBooks data.';
export const isMfaError = (e) => e?.code === 'mfa_required' || e?.code === 'mfa_enrolment_required';

/** One sentence for an API error from a QuickBooks route. */
export function errorText(e) {
  const code = e?.code;
  if (isMfaError(e)) return MFA_TEXT;
  if (code === 'offline' || e?.status === 0) return "You're offline; QuickBooks needs a connection.";
  if (code === 'feature_not_in_plan') return 'QuickBooks sync is part of the Pro plan and up.';
  if (code === 'qbo_unavailable') return e?.status === 502 ? "QuickBooks isn't answering right now. Try again in a few minutes." : "QuickBooks isn't available on this server yet.";
  if (code === 'qbo_not_connected') return 'QuickBooks is not connected.';
  if (code === 'qbo_reconnect_needed') return 'Reconnect to QuickBooks first.';
  if (code === 'qbo_not_ready') return 'Finish setting up QuickBooks first.';
  // 409 qbo_paused from resolve, Send now and Retry: the pause reason, and what still works.
  if (code === 'qbo_paused') return `${PAUSE_REASON[e?.details?.pauseReason] || 'QuickBooks sync is paused.'} Sending waits until it resumes; Unlink still works.`;
  if (code === 'qbo_pause_locked') {
    const reason = e?.details?.pauseReason;
    return `${PAUSE_REASON[reason] || "This pause can't be lifted here."}${reason === 'hq' ? ' Only Fishtape support can resume it.' : ''}`;
  }
  if (code === 'qbo_reconnect_not_allowed') return 'QuickBooks is connected and being set up; there is nothing to reconnect.';
  if (code === 'qbo_busy') return 'QuickBooks sync is busy; try again in a minute.';
  if (code === 'lookup_budget') return "Look-ups are off for the rest of the month: your company used most of this month's QuickBooks reads.";
  if (code === 'qbo_throttled') {
    const s = Number(e?.details?.retryAfterS ?? e?.retryAfterS);
    if (Number.isFinite(s) && s > 0) return `QuickBooks needs a break. Try again in ${s >= 90 ? `${Math.ceil(s / 60)} minutes` : `${Math.ceil(s)} seconds`}.`;
    return 'QuickBooks needs a break. Try again in a minute.';
  }
  if (code === 'forbidden' || e?.status === 403) return e?.message || 'Only office users can use QuickBooks.';
  return e?.message || 'Something went wrong.';
}

// ---------------------------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------------------------

/**
 * Which overview card a Status (7.2) gets: unavailable | plan | not_connected | setup | active |
 * paused | reconnect_needed | disconnected.
 */
export function overviewKind(status) {
  if (!status) return 'loading';
  if (status.available === false) return 'unavailable';
  if (status.plan && status.plan.entitled === false) return 'plan';
  const s = status.state || 'not_connected';
  if (['not_connected', 'setup', 'active', 'paused', 'reconnect_needed', 'disconnected'].includes(s)) return s;
  return 'not_connected';
}

/** Is per-record sync running (badges show)? The connection is active (shadow included). */
export const connectionActive = (status) => Boolean(status && status.available !== false && status.state === 'active' && status.plan?.entitled !== false);

/** Pause text, with the HQ pause never offering Resume. */
export function pauseInfo(status) {
  const reason = status?.pauseReason || null;
  return {
    reason,
    text: PAUSE_REASON[reason] || 'Paused.',
    canResume: ['user', 'brake'].includes(reason),
    needsUpgrade: reason === 'plan',
    brake: reason === 'brake',
  };
}

export function reconnectText(reason) { return RECONNECT_REASON[reason] || 'Reconnect to QuickBooks.'; }

/**
 * The counts as links (8.2): [{ key, label, n, href, tone }], only non-zero ones.
 * @param {object} counts Status.counts
 */
export function countLinks(counts = {}) {
  const c = counts || {};
  const rows = [
    { key: 'error', label: 'Not sent (errors)', n: c.error || 0, href: '#/quickbooks/activity?outcome=error', tone: 'danger' },
    { key: 'blocked', label: 'Waiting', n: (c.blocked || 0), href: '#/quickbooks/activity?outcome=warning', tone: 'warning' },
    { key: 'pending', label: 'Sending', n: c.pending || 0, href: '#/quickbooks/activity', tone: 'info' },
    { key: 'conflict', label: 'Need a decision', n: c.conflict || 0, href: '#/quickbooks/conflicts', tone: 'warning' },
    { key: 'needsReview', label: 'To check', n: c.needsReview || 0, href: '#/quickbooks/conflicts', tone: 'warning' },
    { key: 'mismatch', label: "Doesn't match", n: c.mismatch || 0, href: '#/quickbooks?show=mismatch', tone: 'danger' },
    { key: 'waitingOffline', label: 'Changes waiting to be sent', n: c.waitingOffline || 0, href: '#/quickbooks/activity', tone: 'info' },
  ];
  return rows.filter((r) => r.n > 0);
}

/** "Allow 742 changes" from a 409 qbo_brake_count (details.count) or the status. */
export function brakeCount(errOrStatus) {
  const n = Number(errOrStatus?.details?.count ?? errOrStatus?.brake?.count ?? errOrStatus?.brakeCount);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
}

// ---------------------------------------------------------------------------------------------
// Badges (8.5)
// ---------------------------------------------------------------------------------------------

/**
 * Badge text and tone for a RecordState (7.5), or null when there is nothing to show.
 * @param {object|null} rs { state, reason, message, conflictId, docNumber, owner? }
 * @param {{ mismatch?: object|null }} [o] a "Doesn't match" row for this record (5.13)
 */
export function badgeFor(rs, { mismatch = null } = {}) {
  if (mismatch && rs?.state !== 'unlinked') return { text: "Doesn't match QuickBooks", tone: 'danger', kind: 'mismatch' };
  if (!rs || !rs.state) return null;
  const base = LINK_STATE[rs.state];
  if (!base || rs.state === 'deleted_local') return null;
  if (rs.state === 'synced' && rs.owner === 'quickbooks') return { text: 'Edit in QuickBooks', tone: 'info', kind: 'synced' };
  if (rs.state === 'blocked') {
    if (rs.reason === 'no_invoice') return { text: 'Not sent: no invoice', tone: 'neutral', kind: 'blocked' };
    if (rs.reason === 'totals_mismatch') return { text: "Bill total doesn't add up", tone: 'warning', kind: 'blocked' };
    const why = BLOCKED_REASON[rs.reason];
    return { text: why ? `Waiting: ${why}` : 'Waiting', tone: 'warning', kind: 'blocked' };
  }
  if (rs.state === 'pending' && rs.reason === 'tax_override') return { text: 'Sending to QuickBooks', tone: 'info', kind: 'pending' };
  return { text: base.text, tone: base.tone, kind: rs.state };
}

/** Words for a RecordState's reason, for the sheet. */
export function reasonText(rs) {
  if (!rs) return '';
  if (rs.state === 'blocked') return BLOCKED_REASON[rs.reason] ? `Waiting: ${BLOCKED_REASON[rs.reason]}.` : '';
  if (rs.state === 'needs_review') return REVIEW_REASON[rs.reason] || '';
  if (rs.state === 'error') return ERROR_REASON[rs.reason] || '';
  return '';
}

const DOC_COLLECTIONS = ['estimates', 'invoices'];

/** "Open in QuickBooks" only for an https address on Intuit's own domain; anything else is dropped. */
export function safeQboUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return u.protocol === 'https:' && !u.username && !u.password && (host === 'intuit.com' || host.endsWith('.intuit.com')) ? u.href : null;
  } catch { return null; }
}

/** Look-up search text: % and _ are refused (the server would answer 400). */
export const LOOKUP_BAD_CHARS = /[%_]/;

/**
 * What the badge sheet offers for a record (8.5). Pure: the sheet turns these into buttons.
 * @returns {string[]} ids among retry, sendNow, renumber, unlink, asNew, link, approve, conflict, open
 */
export function badgeActions(rs, { collection, record = null, url = null } = {}) {
  const out = [];
  const doc = DOC_COLLECTIONS.includes(collection);
  if (!rs || !rs.state) {
    if (doc && record && record.status === 'draft') out.push('sendNow');
    return out;
  }
  if (safeQboUrl(url)) out.push('open');
  if (rs.state === 'unlinked') { out.push('asNew', 'link'); return out; }
  if (rs.conflictId) out.push(rs.state === 'needs_review' && rs.reason === 'origin' ? 'approve' : 'conflict');
  if (rs.state === 'error' || (rs.state === 'blocked' && rs.reason !== 'no_invoice')) out.push('retry');
  if (doc && ['duplicate_number', 'duplicate_number_local'].includes(rs.reason)) out.push('renumber');
  if (rs.state === 'deleted_remote' && collection === 'timeEntries') out.push('asNew');
  if (!['unlinked', 'deleted_local'].includes(rs.state)) out.push('unlink');
  return [...new Set(out)];
}

/**
 * The in-memory status cache (8.5): one GET /qbo/records/status?collection= per collection per
 * screen, kept 30 seconds, the connection Status the same way, and the "Doesn't match" list only
 * when the status counts some. Memory only: nothing here reaches localStorage, IndexedDB or the store.
 */
export function createStatusCache({ api = qboApi, ttlMs = 30_000, now = () => Date.now() } = {}) {
  const entries = new Map(); // key -> { at, p }
  const watched = new WeakSet();
  const get = (key, load) => {
    const e = entries.get(key);
    if (e && now() - e.at < ttlMs) return e.p;
    const p = Promise.resolve().then(load).catch((err) => { entries.delete(key); throw err; });
    entries.set(key, { at: now(), p });
    return p;
  };
  const cache = {
    status: () => get('status', () => api.status()),
    async records(collection) {
      if (!QBO_COLLECTIONS.includes(collection)) return {};
      const r = await get(`records:${collection}`, () => api.recordsStatus(collection));
      return r?.data || {};
    },
    async mismatches() {
      const s = await cache.status();
      if (!(s?.counts?.mismatch > 0)) return [];
      const r = await get('checks', () => api.checks({ limit: 200 }));
      return r?.data || [];
    },
    /** RecordState for one record, plus its "Doesn't match" row; null when the user can't see QuickBooks here. */
    async recordState(collection, id) {
      const s = await cache.status();
      if (!connectionActive(s)) return null;
      const [states, mism] = await Promise.all([cache.records(collection), cache.mismatches().catch(() => [])]);
      return { status: s, state: states[id] || null, mismatch: mism.find((m) => m.collection === collection && m.recordId === id) || null };
    },
    invalidate(collection) { if (collection) entries.delete(`records:${collection}`); else entries.clear(); },
    /**
     * Drop a collection's record states when this device changes one of its records, so a badge
     * does not say "In QuickBooks" for 30 seconds after a local edit. Pulled changes (remote) do
     * not count: a pull of many records would otherwise ask the server again for each one.
     */
    watch(store) {
      if (!store?.on || watched.has(store)) return;
      watched.add(store);
      store.on('*', (e) => { if (e && !e.remote && QBO_COLLECTIONS.includes(e.coll)) entries.delete(`records:${e.coll}`); });
    },
    clear() { entries.clear(); },
    size: () => entries.size,
  };
  return cache;
}

/** The app's one cache. */
export const qboStatusCache = createStatusCache();

// ---------------------------------------------------------------------------------------------
// Tax: situations in words, code fits, the no-tax reason
// ---------------------------------------------------------------------------------------------

const PROVINCIAL = { PST: 'PST', RST: 'RST', QST: 'QST' };

/** Parse 'GST+RST|MB' -> { ids: ['GST', 'RST'], province: 'MB', none, reason, legacy }. */
export function parseKey(key) {
  const k = String(key || '');
  if (k === 'TAX') return { ids: ['TAX'], province: null, none: false, reason: null, legacy: true };
  if (k === 'NONE' || k.startsWith('NONE|')) return { ids: [], province: null, none: true, reason: k.split('|')[1] || null, legacy: false };
  const [ids, province = null] = k.split('|');
  return { ids: ids ? ids.split('+') : [], province: province || null, none: false, reason: null, legacy: false };
}

const NONE_KEY_LABEL = { ZERO: 'No tax: zero-rated', EXEMPT: 'No tax: exempt', OOS: 'No tax: out of scope', RELIEF: 'No tax: Indian Act relief' };
const KEY_REASON = { ZERO: 'zero', EXEMPT: 'exempt', OOS: 'out_of_scope', RELIEF: 'relief' };
const REASON_KEY = Object.fromEntries(Object.entries(KEY_REASON).map(([k, v]) => [v, k]));

/** A sales tax key (4.8) as the situation in words: 'GST+RST|MB' -> 'GST + Manitoba RST'. */
export function taxKeyLabel(key, companyProvince = null) {
  const p = parseKey(key);
  if (p.legacy) return 'Old single tax rate (documents from before tax provinces)';
  if (p.none) return p.reason ? (NONE_KEY_LABEL[p.reason] || `No tax: ${p.reason.toLowerCase()}`) : 'No tax (reason not picked yet)';
  if (key === 'stripeFee') return 'Stripe fees';
  if (p.ids.length === 1 && p.ids[0] === 'GST') {
    const pstProvince = ['BC', 'SK', 'MB', 'QC'].includes(companyProvince);
    const tax = companyProvince === 'QC' ? 'QST' : companyProvince === 'MB' ? 'RST' : 'PST';
    return pstProvince ? `GST only (customer has ${tax === 'RST' ? 'an' : 'a'} ${tax} number)` : 'GST';
  }
  if (p.ids.length === 1 && p.ids[0] === 'HST') return `HST${p.province ? ` (${provinceName(p.province)})` : ''}`;
  const where = p.province ? provinceName(p.province) : '';
  return p.ids.map((id) => (PROVINCIAL[id] ? `${where ? `${where} ` : ''}${PROVINCIAL[id]}` : id)).join(' + ');
}

/** A purchase tax key (4.8) in words: the PST/RST part is added to cost, only GST/HST/QST is claimed. */
export function purchaseKeyLabel(key, companyProvince = null) {
  if (key === 'stripeFee') return 'Stripe fees';
  const p = parseKey(key);
  if (p.none) return 'No tax on the bill';
  const label = taxKeyLabel(key, companyProvince).replace(/^GST only \(.*\)$/, 'GST only');
  return p.ids.some((id) => id === 'PST' || id === 'RST') ? `${label} (${p.ids.filter((x) => x === 'PST' || x === 'RST').join('/')} added to cost)` : label;
}

/**
 * Every sales tax key a company in this province uses (4.8): each treatment's key for each line
 * kind, then the four no-tax reasons. Keys found on documents or in the mappings are added by the caller.
 */
export function companyTaxKeys(province, date = new Date()) {
  const keys = [];
  const add = (k) => { if (k && k !== 'NONE' && !keys.includes(k)) keys.push(k); };
  for (const t of treatmentsFor(province)) {
    if (t === 'none') continue;
    const doc = { taxes: taxComponents({ province, treatment: t, date }), taxProvince: province };
    for (const kind of KINDS) add(taxKey(lineTaxIds(doc, kind), province));
  }
  for (const r of ['ZERO', 'EXEMPT', 'OOS', 'RELIEF']) keys.push(`NONE|${r}`);
  return keys;
}

/** Purchase tax keys for bills in this province (4.8): the full rate, GST alone, none, and Stripe fees. */
export function companyPurchaseKeys(province, date = new Date()) {
  const ids = ratesOn(province, date).map((r) => r.id).sort();
  const keys = [taxKey(ids, province)];
  if (!keys.includes('GST') && ids.includes('GST')) keys.push('GST');
  keys.push('NONE', 'stripeFee');
  return [...new Set(keys)];
}

/** The percentages a key charges on a date: 'GST+RST|MB' -> [5, 7]; none -> []; legacy -> null (any). */
export function keyPcts(key, { province = null, date = new Date() } = {}) {
  const p = parseKey(key);
  if (p.legacy || key === 'stripeFee') return null;
  if (p.none) return [];
  const rates = ratesOn(p.province || province || 'AB', date);
  return p.ids.map((id) => rates.find((r) => r.id === id)?.pct ?? (id === 'GST' ? 5 : null)).filter((x) => x != null).sort((a, b) => a - b);
}

const pctList = (list) => (list.length ? list.map((x) => `${fmtPct(x)}%`).join(' + ') : 'no tax');
const samePcts = (a, b) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 0.0005);

/**
 * Can this QuickBooks sales tax code stand for this key (4.8, 7.6)? By rates, never by name.
 * @param {{ name, active, salesRates: [{ name, pct }] }} code
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function taxCodeFit(key, code, { province = null, date = new Date() } = {}) {
  if (!code) return { ok: false, reason: 'Pick a QuickBooks tax code.' };
  if (code.active === false) return { ok: false, reason: `QuickBooks code ${code.name} is inactive.` };
  const want = keyPcts(key, { province, date });
  if (want == null) return { ok: true, reason: null };
  const has = (code.salesRates || []).map((r) => Number(r.pct) || 0).filter((x) => x > 0).sort((a, b) => a - b);
  if (samePcts(has, want)) return { ok: true, reason: null };
  return { ok: false, reason: `QuickBooks code ${code.name} charges ${pctList(has)}; Fishtape charges ${pctList(want)}.` };
}

/**
 * Purchase codes (4.8): PST and RST paid on purchases are not recoverable, so a code for a key with
 * PST or RST must not claim them. The server checks the rate's agency; this checks the rate names.
 */
export function purchaseCodeFit(key, code) {
  if (!code) return { ok: false, reason: 'Pick a QuickBooks tax code.' };
  if (code.active === false) return { ok: false, reason: `QuickBooks code ${code.name} is inactive.` };
  const p = parseKey(key);
  const claims = (code.purchaseRates || []).filter((r) => /\b(PST|RST)\b/i.test(r.name || ''));
  if ((p.ids.includes('PST') || p.ids.includes('RST')) && claims.length) {
    return { ok: false, reason: `QuickBooks code ${code.name} would claim ${claims.map((r) => r.name).join(', ')}; PST and RST you pay are added to the cost instead.` };
  }
  return { ok: true, reason: null };
}

/** "GST/PST MB · 5% + 7%" for a code picker option. */
export function codeOptionLabel(code, { purchase = false } = {}) {
  const rates = (purchase ? code.purchaseRates : code.salesRates) || [];
  const pcts = rates.map((r) => Number(r.pct) || 0).filter((x) => x > 0);
  return `${code.name} · ${pcts.length ? pcts.map((x) => `${fmtPct(x)}%`).join(' + ') : 'no tax'}${code.active === false ? ' (inactive)' : ''}`;
}

/** Line kinds a document uses (a markup only exists on material lines). */
export function docKinds(doc) {
  const used = new Set((doc?.lines || []).map((l) => (KINDS.includes(l.kind) ? l.kind : 'material')));
  return KINDS.filter((k) => used.has(k));
}

/** Kinds on the document that are charged no tax (they get a NONE key, 4.8). */
export function noTaxKinds(doc) {
  if (!doc || !Array.isArray(doc.taxes)) return [];
  return docKinds(doc).filter((k) => !lineTaxIds(doc, k).length);
}

/** Show "Why no tax?" (8.5): the treatment is `none`, or some kind on it has no tax. Every company, connected or not. */
export function needsNoTaxReason(doc) {
  if (!doc) return false;
  if (doc.taxTreatment === 'none') return true;
  return noTaxKinds(doc).length > 0;
}

/** The sales tax key a no-tax document's lines get: 'NONE|EXEMPT' etc., 'NONE' without a reason. */
export const noneKeyFor = (reason) => (REASON_KEY[reason] ? `NONE|${REASON_KEY[reason]}` : 'NONE');

export { TAX_NONE_REASONS };

/** A "Why no tax?" reason left on a document that is taxed again (it is cleared on the next edit). */
export const staleNoTaxReason = (doc) => Boolean(doc?.taxNoneReason) && !needsNoTaxReason(doc);

// ---------------------------------------------------------------------------------------------
// Invoices and estimates that QuickBooks writes too (4.8, 4.9, 5.10)
// ---------------------------------------------------------------------------------------------

/**
 * The status to store after payments or an edit (void is never touched). Plain arithmetic, except
 * that a 'paid' within the tax rounding is kept when this device changed no money: no payment
 * added or deleted and no change to the total (`moneyChanged` false). An edit that moves the
 * total, or any payment change made here, is worked out from the payments as before.
 */
export function nextInvoiceStatus(inv, paidCents, totalCents, { moneyChanged = true } = {}) {
  if (!inv) return null;
  if (inv.status === 'void') return 'void';
  if (paidCents > 0 && paidCents >= totalCents) return 'paid';
  if (!moneyChanged && keepsServerPaid(inv, paidCents, totalCents)) return 'paid';
  if (paidCents > 0) return 'partial';
  if (inv.status === 'paid' || inv.status === 'partial') return 'sent';
  return inv.status;
}

/** Bookkeeping fields an editor never saves; status has its own buttons (save.write). */
export const DOC_EDITOR_SKIP = ['id', 'createdAt', 'updatedAt', 'status'];
const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const copyValue = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const setOrDrop = (o, k, v) => { if (v === undefined) delete o[k]; else o[k] = v; };

/** The fields of `doc` that differ from `base` (what was typed since the last save), never DOC_EDITOR_SKIP. */
export function docChanges(doc, base, skip = DOC_EDITOR_SKIP) {
  const keys = new Set([...Object.keys(doc || {}), ...Object.keys(base || {})]);
  return [...keys].filter((k) => !skip.includes(k) && !sameValue(doc?.[k], base?.[k]));
}

/**
 * Keeps an open estimate or invoice editor and the store in step, now that QuickBooks pulls write
 * these records too (5.10). The form, the line editor and the tax editor change `doc` in place.
 *
 * - `save()` saves after `ms`, `save.flush()` at once: only the fields that differ from what this
 *   screen last saved or took in, through `write(patch)` (the screen's store.update). The sync then
 *   sends `fields: ['notes']`, and the server's per-field merge keeps what QuickBooks changed.
 * - Status is never autosaved. `save.write(patch, opts)` saves a status (or a field a button sets)
 *   on its own, after what was typed.
 * - A change to this record made elsewhere (a QuickBooks pull, another device, another screen)
 *   goes into `doc` and `onPulled(fields, clashes)` runs. A field changed here too and not saved
 *   yet takes the other side's value and is listed in `clashes` (the screen says so): the books
 *   win over an unsaved keystroke.
 * - Deleted on another device: `onRemoved()`. `save.stop()` saves what is left and stops listening.
 *
 * @param {{ get: Function, on: Function }} records store.js's store (read and listen only)
 * @param {(patch: object, opts?: object) => object|null} write saves a patch (store.update)
 */
export function docEditor(records, coll, id, doc, { write, ms = 450, onSaved = null, onPulled = null, onRemoved = null } = {}) {
  const base = copyValue(doc);
  let timer = null, gone = false;
  const flush = () => {
    clearTimeout(timer); timer = null;
    if (gone) return null;
    const fields = docChanges(doc, base);
    const before = fields.length ? records.get(coll, id) : null;
    if (!before) return null;
    const patch = {};
    // `base` first: the store's update event then finds nothing new.
    for (const k of fields) { patch[k] = doc[k] === undefined ? null : copyValue(doc[k]); base[k] = copyValue(patch[k]); }
    const after = write(patch);
    onSaved?.(patch, before, after);
    return after;
  };
  const off = records.on(coll, (e) => {
    if (e?.record?.id !== id) return;
    if (e.type === 'remove') {
      clearTimeout(timer); timer = null; gone = true;
      if (e.remote) onRemoved?.();
      return;
    }
    const rec = e.record;
    const pulled = [], clashes = [];
    for (const k of new Set([...Object.keys(rec), ...Object.keys(base)])) {
      if (k === 'id' || k === 'createdAt' || k === 'updatedAt' || sameValue(rec[k], base[k])) continue;
      if (!sameValue(doc[k], base[k]) && !sameValue(doc[k], rec[k])) clashes.push(k);
      setOrDrop(doc, k, copyValue(rec[k]));
      setOrDrop(base, k, copyValue(rec[k]));
      pulled.push(k);
    }
    if (pulled.length) onPulled?.(pulled, clashes);
  });
  const save = () => { if (gone) return; clearTimeout(timer); timer = setTimeout(flush, ms); };
  save.flush = flush;
  save.write = (patch, opts) => {
    flush();
    if (gone || !records.get(coll, id)) return null;
    for (const [k, v] of Object.entries(patch)) { doc[k] = copyValue(v); base[k] = copyValue(v); }
    return write(patch, opts);
  };
  save.pending = () => docChanges(doc, base);
  save.stop = () => { flush(); off(); };
  return save;
}

// ---------------------------------------------------------------------------------------------
// Wizard (8.3)
// ---------------------------------------------------------------------------------------------

export const WIZARD_STEPS = [
  { id: 'connect', label: 'Connect' },
  { id: 'settings', label: 'Settings' },
  { id: 'mappings', label: 'Tax codes, products and accounts' },
  { id: 'match', label: 'Match' },
  { id: 'review', label: 'Review' },
  { id: 'apply', label: 'Apply' },
];

export const MATCH_KINDS = [
  { id: 'customers', label: 'Customers', fishtape: 'clients' },
  { id: 'jobs', label: 'Jobs', fishtape: 'jobs' },
  { id: 'items', label: 'Products', fishtape: 'items' },
  { id: 'employees', label: 'Employees', fishtape: 'employees' },
  { id: 'vendors', label: 'Suppliers', fishtape: 'vendors' },
  { id: 'invoices', label: 'Invoices', fishtape: 'invoices' },
  { id: 'estimates', label: 'Estimates', fishtape: 'estimates' },
  { id: 'payments', label: 'Payments', fishtape: 'payments' },
];

/** Filters on the match tables (8.3); `status` goes to the API, `test` narrows a loaded page. */
export const MATCH_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'matched', label: 'Matched', status: 'matched' },
  { id: 'ambiguous', label: 'Needs a choice', status: 'ambiguous' },
  { id: 'duplicates', label: 'Possible duplicates', status: 'ambiguous', test: (c) => (c.reasons || []).includes('possible_duplicate') },
  { id: 'fishtape_only', label: 'Only in Fishtape', status: 'fishtape_only' },
  { id: 'quickbooks_only', label: 'Only in QuickBooks', status: 'quickbooks_only' },
];

export const CHOICE_LABEL = {
  link: 'Link them', create_in_qbo: 'Create in QuickBooks', create_in_fishtape: 'Create in Fishtape', skip: 'Leave alone',
};

export const MATCH_REASON = {
  email: 'same email', phone: 'same phone', name: 'same name', postal: 'same postal code', number: 'same number', title: 'same title',
  sku: 'same SKU', customer: 'same customer', totals: 'same totals', tie: 'more than one fits', contested: 'also fits another record',
  name_only: 'name only', possible_duplicate: 'possible duplicate', customer_differs: 'customer differs', totals_differ: 'totals differ',
  filed_period: 'dated in a filed GST period', net_of_fee: 'net of the Stripe fee', amount: 'same amount', balances_agree: 'balances already agree',
  would_overpay: 'would overpay the invoice',
};

/** Choices a candidate may take (6.3): employees and jobs only link or skip. */
export function choicesFor(kind, cand) {
  if (kind === 'employees' || kind === 'jobs') return cand?.qboId || cand?.options?.length || cand?.alternatives?.length ? ['link', 'skip'] : ['skip'];
  const both = Boolean(cand?.fishtapeId || cand?.fishtape) && Boolean(cand?.qboId || cand?.quickbooks);
  const out = [];
  if (both || cand?.options?.length || cand?.alternatives?.length) out.push('link');
  if (cand?.fishtapeId || cand?.fishtape) out.push('create_in_qbo');
  if (cand?.qboId || cand?.quickbooks) out.push('create_in_fishtape');
  out.push('skip');
  return [...new Set(out)];
}

/** Kinds whose differing fields need a side picked before Apply (6.4); documents go to review instead. */
export const CHOICE_KINDS = ['customers', 'jobs', 'items', 'vendors'];

/** [{ cand, field }] for linked candidates whose differing field has no choice yet (Apply waits on these). */
export function undecidedDiffs(cands) {
  const out = [];
  for (const c of cands || []) {
    if (c.choice !== 'link' || !CHOICE_KINDS.includes(c.kind)) continue;
    for (const d of c.diffs || []) if (!['fishtape', 'quickbooks'].includes(c.fieldChoices?.[d.field])) out.push({ cand: c, field: d.field });
  }
  return out;
}

/** Possible duplicates (6.3 pass 2) and creates dated in a filed GST period still unticked. */
export const isPossibleDuplicate = (c) => (c.reasons || []).includes('possible_duplicate');
export const needsFiledTick = (c) => c.choice === 'create_in_qbo' && (c.needsConfirm || (c.reasons || []).includes('filed_period'));

/**
 * Can Apply run? Every difference has a side, and the plan reports none left to decide.
 * @returns {{ ok: boolean, why: string|null }}
 */
export function applyReady({ cands = [], plan = null } = {}) {
  const open = undecidedDiffs(cands).length;
  const fromPlan = (plan?.warnings || []).find((w) => ['differences', 'differences_undecided', 'undecided_differences'].includes(w.code));
  const n = Math.max(open, fromPlan?.count || 0);
  if (n > 0) return { ok: false, why: `${n} difference${n === 1 ? '' : 's'} still to decide.` };
  return { ok: true, why: null };
}

/** Wizard option defaults (6.1). */
export function optionDefaults({ today = new Date(), features = {} } = {}) {
  const d = new Date(today);
  const first = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  return {
    syncFrom: first, importCustomers: 'active', numbering: features.customTxnNumbers === false ? 'quickbooks' : 'fishtape',
    jobsAsSubCustomers: true, items: 'on_use', pushDrafts: false, syncTime: true, timeOwner: null, timeLockedThrough: null,
    taxFiledThrough: null, pullJobCosts: true, recordStripeFees: true, recordStripePayouts: true, stripeCutover: null, writeMode: 'live',
  };
}

/** What still stops the Settings step (6.1): the payroll question when time syncs. */
export function settingsProblems(opts) {
  const out = [];
  if (!opts?.syncFrom) out.push('Pick the date to start syncing from.');
  if (opts?.syncTime !== false && !['fishtape', 'quickbooks'].includes(opts?.timeOwner)) out.push('Say which system holds payroll hours.');
  return out;
}

/** "3 lines, $1,065.00" style for candidate sides. */
export function sideSummary(side, money = (c) => String(c)) {
  if (!side) return '—';
  const parts = [side.label || side.number || side.name || null, side.email || null, side.date || null,
    side.totalCents != null ? money(side.totalCents) : null, side.balanceCents != null && side.balanceCents !== side.totalCents ? `owing ${money(side.balanceCents)}` : null,
    side.status || null];
  return parts.filter(Boolean).join(' · ') || '—';
}

// ---------------------------------------------------------------------------------------------
// Mappings (8.4)
// ---------------------------------------------------------------------------------------------

export const ITEM_KEYS = [
  { key: 'material', label: 'Materials' }, { key: 'labour', label: 'Labour' }, { key: 'other', label: 'Other' },
  { key: 'markup', label: 'Markup' }, { key: 'travel', label: 'Travel' }, { key: 'deposit', label: 'Deposits' },
];
export const ACCOUNT_KEYS = [
  { key: 'income.default', label: 'Income for new products and services', types: ['Income'] },
  { key: 'expense.default', label: 'Expense for new products and services', types: ['Expense', 'Other Expense', 'Cost of Goods Sold'] },
  { key: 'jobCost.material', label: 'Job cost: materials', types: ['Expense', 'Other Expense', 'Cost of Goods Sold'] },
  { key: 'jobCost.subcontract', label: 'Job cost: subcontractors', types: ['Expense', 'Other Expense', 'Cost of Goods Sold'] },
  { key: 'jobCost.equipment', label: 'Job cost: equipment', types: ['Expense', 'Other Expense', 'Cost of Goods Sold'] },
  { key: 'jobCost.other', label: 'Job cost: other', types: ['Expense', 'Other Expense', 'Cost of Goods Sold'] },
  { key: 'stripeClearing', label: 'Stripe clearing (a bank account named "Stripe")', types: ['Bank'] },
  { key: 'stripeFees', label: 'Stripe fees', types: ['Expense'] },
  { key: 'stripePayoutBank', label: 'Bank that Stripe pays out to', types: ['Bank'] },
];
export const METHOD_KEYS = [
  { key: 'cash', label: 'Cash' }, { key: 'check', label: 'Cheque' }, { key: 'card', label: 'Card' },
  { key: 'transfer', label: 'Bank transfer' }, { key: 'e-transfer', label: 'e-Transfer' }, { key: 'other', label: 'Other' },
];
export const PAID_FROM_KEYS = [
  { key: 'card', label: 'Card' }, { key: 'cash', label: 'Cash' }, { key: 'cheque', label: 'Cheque' }, { key: 'debit', label: 'Debit' }, { key: 'transfer', label: 'Bank transfer' },
];

/** Value of a mapping from the { kind: { key: value } } shape. */
export const mapValue = (mappings, kind, key) => mappings?.[kind]?.[key] ?? null;

/** `required` (7.6) as a Set of 'kind.key' strings, whatever shape the server sends. */
export function requiredSet(required) {
  const out = new Set();
  for (const r of required || []) {
    if (typeof r === 'string') out.add(r);
    else if (r && r.kind) out.add(`${r.kind}.${r.key}`);
  }
  return out;
}

/** The change between two { kind: { key: value } } maps, as the PUT body (7.6). */
export function mappingDiff(before = {}, after = {}) {
  const set = [], remove = [];
  const kinds = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const kind of kinds) {
    const a = before?.[kind] || {}, b = after?.[kind] || {};
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const was = a[key] ?? null, now = b[key] ?? null;
      if (JSON.stringify(was) === JSON.stringify(now)) continue;
      if (now == null || now === '') { if (was != null) remove.push({ kind, key }); } else set.push({ kind, key, value: now });
    }
  }
  return { set, remove };
}

// ---------------------------------------------------------------------------------------------
// DOM helpers (take ctx; build with ctx.ui)
// ---------------------------------------------------------------------------------------------

/** The trademark line at the foot of every QuickBooks screen. */
export function trademarkLine(ui) {
  return ui.h('p', { class: 'qbo-tm muted' }, TRADEMARK);
}

/** Make sure css/quickbooks.css is loaded (index.html links it; this covers a page cached before it did). */
export function ensureQboStyles() {
  if (typeof document === 'undefined' || document.querySelector('link[href$="css/quickbooks.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'css/quickbooks.css';
  document.head.append(link);
}

/** An mfa_required error as a sheet with the way to fix it; any other error as a toast. */
export function showError(ctx, e) {
  const { ui } = ctx;
  if (isMfaError(e)) {
    const s = ui.openSheet({
      title: 'Two-step sign-in needed', dialog: true,
      body: ui.h('div', { class: 'stack' },
        ui.h('p', { style: { margin: 0 } }, MFA_TEXT),
        ui.h('p', { class: 'muted', style: { margin: 0 } }, 'Reading QuickBooks status works without it. Changing anything that reaches your books needs it, whatever your role.')),
      actions: [ui.button('Later', { variant: 'ghost', onClick: () => s.close() }), ui.button('Set it up', { variant: 'primary', icon: 'key', href: e?.details?.link || '#/account', onClick: () => s.close() })],
    });
    return s;
  }
  ui.toast(errorText(e), 'error', 5000);
  return null;
}

/**
 * The per-record badge (8.5). Null unless this person can use QuickBooks here; otherwise a small
 * host that fills in once the status is known, and stays empty when the company isn't connected
 * and active, offline, or the record has no link.
 * @param {object} ctx a screen ctx ({ ui, auth, app, store, nav })
 * @param {string} collection
 * @param {string} recordId
 * @param {{ detail?: boolean, record?: object, cache?: object }} [opts] detail: also show "Not sent to QuickBooks" for an unlinked draft
 */
export function qboBadge(ctx, collection, recordId, opts = {}) {
  if (!recordId || !QBO_COLLECTIONS.includes(collection) || !allowedFor(ctx)) return null;
  ensureQboStyles();
  const { ui } = ctx;
  const cache = opts.cache || qboStatusCache;
  const host = ui.h('span', { class: 'qbo-badge-host', dataset: { qboFor: `${collection}:${recordId}` } });
  if (isOffline(ctx)) return host;
  cache.watch?.(ctx.store);
  cache.recordState(collection, recordId).then((r) => {
    if (!r) return;
    const info = badgeFor(r.state, { mismatch: r.mismatch });
    const record = opts.record || ctx.store?.get?.(collection, recordId) || null;
    if (!info) {
      if (opts.detail && DOC_COLLECTIONS.includes(collection) && record?.status === 'draft') {
        host.append(ui.h('button', { type: 'button', class: 'qbo-badge badge neutral', title: 'QuickBooks', onClick: (e) => { e.stopPropagation(); openRecordSheet(ctx, collection, recordId, { record }); } }, 'Not sent to QuickBooks'));
      }
      return;
    }
    const title = r.mismatch ? `Fishtape ${ui.fmtMoney(r.mismatch.fishtapeCents)}, QuickBooks ${ui.fmtMoney(r.mismatch.quickbooksCents)}` : 'QuickBooks';
    host.append(ui.h('button', {
      type: 'button', class: ['qbo-badge', 'badge', info.tone], title, dataset: { qboState: r.mismatch ? 'mismatch' : r.state?.state || info.kind },
      onClick: (e) => { e.stopPropagation(); e.preventDefault(); openRecordSheet(ctx, collection, recordId, { record, mismatch: r.mismatch }); },
    }, info.text));
  }).catch(() => { /* offline or not allowed: no badge */ });
  return host;
}

/**
 * The badge's sheet: state in words, the last log lines, "Open in QuickBooks", and the actions of
 * badgeActions(). Built from GET /qbo/records/:collection/:id (no QuickBooks call).
 */
export function openRecordSheet(ctx, collection, id, { record = null, mismatch = null, cache = qboStatusCache } = {}) {
  const { ui } = ctx;
  const { h } = ui;
  const body = h('div', { class: 'stack qbo-sheet' }, h('p', { class: 'muted' }, 'Loading…'));
  const sheet = ui.openSheet({ title: `QuickBooks · ${COLLECTION_LABEL[collection] || collection}`, body, actions: [ui.button('Close', { variant: 'ghost', onClick: () => sheet.close() })] });
  const after = (msg) => { cache.invalidate(collection); cache.invalidate(); if (msg) ui.toast(msg, 'success'); sheet.close(); ctx.route?.(); };
  // One request per tap: the button stays off until the server answers (a double tap would ask
  // QuickBooks twice). `btn` is taken before any await: currentTarget is gone after the click.
  const act = async (fn, msg, btn = null) => {
    if (btn?.disabled) return;
    if (btn) btn.disabled = true;
    try { await fn(); after(msg); } catch (e) { showError(ctx, e); } finally { if (btn) btn.disabled = false; }
  };
  const draw = (view) => {
    ui.clear(body);
    const rs = view?.state || null;
    const info = badgeFor(rs, { mismatch });
    const q = view?.quickbooks || null;
    const qUrl = safeQboUrl(q?.url);
    const money = (c) => ui.fmtMoney(c);
    const acts = badgeActions(rs, { collection, record, url: qUrl });
    const button = (which) => {
      switch (which) {
        case 'open': return h('a', { class: 'btn secondary sm', href: qUrl, target: '_blank', rel: 'noopener noreferrer' }, ui.icon('link', 16), h('span', null, 'Open in QuickBooks'));
        case 'retry': return ui.button('Retry', { size: 'sm', icon: 'redo', onClick: (e) => act(() => qboApi.pushRecord(collection, id), 'Sending again', e.currentTarget) });
        case 'sendNow': return ui.button('Send to QuickBooks now', { size: 'sm', variant: 'primary', icon: 'send', onClick: (e) => act(() => qboApi.pushRecord(collection, id, { force: true }), 'Sending to QuickBooks', e.currentTarget) });
        case 'asNew': return ui.button('Send to QuickBooks as new', { size: 'sm', variant: 'primary', icon: 'send', onClick: async (e) => {
          const btn = e.currentTarget;
          if (btn.disabled) return;
          if (!(await ui.confirmDialog('This creates a new record in QuickBooks. The QuickBooks record it was linked to stays as it is.', { title: 'Send as new?', okLabel: 'Send as new', danger: false }))) return;
          act(() => qboApi.pushRecord(collection, id, { asNew: true }), 'Sending to QuickBooks as new', btn);
        } });
        case 'link': return ui.button('Link…', { size: 'sm', icon: 'link', onClick: () => linkSheet(ctx, collection, id, () => after('Linked')) });
        case 'renumber': return ui.button('Renumber', { size: 'sm', icon: 'edit', onClick: async (e) => {
          const btn = e.currentTarget;
          if (btn.disabled) return;
          const cur = record || ctx.store?.get?.(collection, id);
          const warn = cur?.sentAt ? `The customer has this as ${cur.number}. ` : '';
          if (!(await ui.confirmDialog(`${warn}Fishtape gives it the next free number and sends it again.`, { title: 'Renumber?', okLabel: 'Renumber', danger: Boolean(cur?.sentAt) }))) return;
          act(async () => { const r = await qboApi.renumber(collection, id); ui.toast(`Now ${r?.number || 'renumbered'}`, 'success'); }, null, btn);
        } });
        case 'unlink': return ui.button('Unlink', { size: 'sm', variant: 'ghost danger', icon: 'x', onClick: async (e) => {
          const btn = e.currentTarget;
          if (btn.disabled) return;
          if (!(await ui.confirmDialog('Both records are kept. Nothing is sent to QuickBooks for this record until you send it as new or link it again.', { title: 'Unlink from QuickBooks?', okLabel: 'Unlink' }))) return;
          act(() => qboApi.unlink(collection, id), 'Unlinked', btn);
        } });
        case 'approve': return ui.button('Approve and send', { size: 'sm', variant: 'primary', icon: 'check', onClick: (e) => act(() => qboApi.resolve(rs.conflictId, { choice: 'fishtape' }), 'Approved; sending to QuickBooks', e.currentTarget) });
        case 'conflict': return ui.button(rs?.state === 'needs_review' ? 'Check it' : 'Decide', { size: 'sm', variant: 'primary', icon: 'alert', href: `#/quickbooks/conflicts/${encodeURIComponent(rs.conflictId)}`, onClick: () => sheet.close() });
        default: return null;
      }
    };
    h(body, null,
      h('div', { class: 'row' }, info ? ui.badge(info.text, info.tone) : ui.badge(record?.status === 'draft' ? 'Not sent to QuickBooks' : 'Not linked to QuickBooks', 'neutral'),
        rs?.docNumber ? h('span', { class: 'mono muted' }, rs.docNumber) : null),
      rs?.message ? h('p', { style: { margin: 0 } }, rs.message) : (reasonText(rs) ? h('p', { style: { margin: 0 } }, reasonText(rs)) : null),
      !rs && record?.status === 'draft' ? h('p', { class: 'muted', style: { margin: 0 } }, 'Drafts are not sent. Send it now if QuickBooks should have it already.') : null,
      mismatch ? h('div', { class: 'qbo-amounts' },
        h('div', null, h('span', { class: 'muted' }, 'Fishtape'), h('strong', { class: 'num' }, money(mismatch.fishtapeCents))),
        h('div', null, h('span', { class: 'muted' }, 'QuickBooks'), h('strong', { class: 'num' }, money(mismatch.quickbooksCents)))) : null,
      q ? h('dl', { class: 'qbo-facts' },
        q.docNumber ? [h('dt', null, 'Number in QuickBooks'), h('dd', { class: 'mono' }, q.docNumber)] : null,
        q.totalCents != null ? [h('dt', null, 'Total in QuickBooks'), h('dd', { class: 'num' }, money(q.totalCents))] : null,
        q.balanceCents != null ? [h('dt', null, 'Owing in QuickBooks'), h('dd', { class: 'num' }, money(q.balanceCents))] : null,
        q.unappliedCents ? [h('dt', null, 'Left as credit in QuickBooks'), h('dd', { class: 'num' }, money(q.unappliedCents))] : null,
        q.updatedAt ? [h('dt', null, 'Changed in QuickBooks'), h('dd', null, ui.fmtDateTime(q.updatedAt))] : null,
        rs?.syncedAt ? [h('dt', null, 'Last in step'), h('dd', null, ui.fmtDateTime(rs.syncedAt))] : null) : null,
      acts.length ? h('div', { class: 'row qbo-actions' }, acts.map(button)) : null,
      view?.log?.length ? [h('h3', null, 'Recent activity'), h('div', { class: 'list qbo-log-mini' }, view.log.slice(0, 8).map((l) => h('div', { class: 'list-row' },
        h('div', { class: 'grow' }, h('div', { class: 'title' }, l.message || l.action || l.outcome), h('div', { class: 'meta' }, [ui.fmtDateTime(l.at), l.direction === 'pull' ? 'from QuickBooks' : l.direction === 'push' ? 'to QuickBooks' : null, l.outcome].filter(Boolean).join(' · '))))))] : null,
      h('a', { href: `#/quickbooks/activity?collection=${encodeURIComponent(collection)}&recordId=${encodeURIComponent(id)}`, class: 'muted', onClick: () => sheet.close() }, 'All activity for this record'),
      trademarkLine(ui));
  };
  if (isOffline(ctx)) { draw(null); ui.clear(body).append(h('p', null, "You're offline; QuickBooks needs a connection.")); return sheet; }
  qboApi.record(collection, id).then((v) => draw(v)).catch((e) => {
    if (e?.status === 404) { draw({ state: null }); return; }
    ui.clear(body).append(h('p', null, errorText(e)));
  });
  return sheet;
}

/** "Link…": pick the QuickBooks record to link to (look-up for customers, invoices and estimates; an id otherwise). */
export function linkSheet(ctx, collection, id, onDone) {
  const { ui } = ctx;
  const { h } = ui;
  const entity = { clients: 'customers', invoices: 'invoices', estimates: 'estimates' }[collection] || null;
  const results = h('div', { class: 'list' });
  const input = h('input', { class: 'input', type: entity ? 'search' : 'text', inputmode: entity ? null : 'numeric', placeholder: entity === 'customers' ? 'Customer name' : entity ? 'Number' : 'QuickBooks id (digits)', 'aria-label': 'Search QuickBooks' });
  const link = async (qboId) => {
    try { await qboApi.link(collection, id, qboId); s.close(); onDone?.(); } catch (e) { showError(ctx, e); }
  };
  const search = async () => {
    const q = input.value.trim();
    if (!entity) { if (/^\d{1,20}$/.test(q)) link(q); else ui.toast('A QuickBooks id is digits only', 'error'); return; }
    if (LOOKUP_BAD_CHARS.test(q)) { ui.toast('Leave out % and _', 'error'); return; }
    ui.clear(results).append(h('p', { class: 'muted' }, 'Searching QuickBooks…'));
    try {
      const body = entity === 'customers' ? { q, limit: 25 } : { q: q || undefined, status: 'all', limit: 25, ...(ctx.store?.get?.(collection, id)?.clientId ? { clientId: ctx.store.get(collection, id).clientId } : {}) };
      const r = await qboApi.lookup(entity, body);
      ui.clear(results);
      for (const row of r?.data || []) {
        results.append(h('div', { class: 'list-row' },
          h('div', { class: 'grow' }, h('div', { class: 'title' }, row.name || row.docNumber || row.qboId), h('div', { class: 'meta' }, [row.customer, row.date, row.totalCents != null ? ui.fmtMoney(row.totalCents) : null, row.email].filter(Boolean).join(' · '))),
          row.linked ? ui.badge('Already linked', 'neutral') : ui.button('Link', { size: 'sm', onClick: () => link(row.qboId) })));
      }
      if (!results.children.length) results.append(h('p', { class: 'muted' }, 'Nothing found.'));
    } catch (e) { ui.clear(results).append(h('p', null, errorText(e))); }
  };
  const s = ui.openSheet({
    title: 'Link to a QuickBooks record', dialog: true,
    body: h('div', { class: 'stack' }, h('p', { class: 'muted', style: { margin: 0 } }, 'Every field that differs then needs a decision; nothing is written either way until you choose.'),
      h('div', { class: 'int-inline' }, input, ui.button(entity ? 'Search' : 'Link', { icon: entity ? 'search' : 'link', onClick: search })), results),
    actions: [ui.button('Cancel', { variant: 'ghost', onClick: () => s.close() })],
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
  return s;
}

/**
 * "Look up in QuickBooks" (8.6) for the client page and new invoices and estimates. An empty host
 * until the company is known to be connected and active; nothing for people without QuickBooks.
 */
export function lookupAction(ctx, { entity = 'customers', clientId = null } = {}) {
  if (!allowedFor(ctx)) return null;
  const { ui } = ctx;
  const host = ui.h('span', { class: 'qbo-lookup-host' });
  if (isOffline(ctx)) return host;
  qboStatusCache.status().then((s) => {
    if (!connectionActive(s) || s.lookupsEnabled === false) return;
    const href = `#/quickbooks/lookup?entity=${entity}${clientId ? `&clientId=${encodeURIComponent(clientId)}` : ''}`;
    host.append(ui.button('Look up in QuickBooks', { size: 'sm', variant: 'ghost', icon: 'search', href }));
  }).catch(() => {});
  return host;
}

/**
 * "Why no tax?" (8.5) on estimates and invoices, for every company. Shows when the document's
 * treatment is "No tax" or a line kind on it has no tax; writes `taxNoneReason`.
 * @returns {HTMLElement & { update(): void }}
 */
export function noTaxReasonPicker(ctx, doc, { onChange, readOnly = false } = {}) {
  const { ui } = ctx;
  const { h } = ui;
  const host = h('div', { class: 'field span-2 qbo-notax', dataset: { noTax: '1' } });
  const draw = (edited = false) => {
    ui.clear(host);
    const show = needsNoTaxReason(doc);
    host.hidden = !show;
    host.style.display = show ? '' : 'none';
    // Taxed again after an edit: the old reason goes, so it never rides along on a taxed document.
    if (edited && !readOnly && staleNoTaxReason(doc)) doc.taxNoneReason = null;
    if (!show) return;
    const kinds = doc.taxTreatment === 'none' ? [] : noTaxKinds(doc);
    const sel = h('select', { name: 'taxNoneReason', disabled: readOnly, 'aria-label': 'Why no tax?', onChange: (e) => { doc.taxNoneReason = e.target.value || null; drawHint(); onChange?.(); } },
      h('option', { value: '', selected: !doc.taxNoneReason }, 'Pick a reason…'),
      TAX_NONE_REASONS.map((r) => h('option', { value: r.id, selected: doc.taxNoneReason === r.id }, r.label)));
    const hint = h('span', { class: 'hint' });
    const drawHint = () => {
      ui.clear(hint);
      hint.append(!doc.taxNoneReason
        ? 'Each reason goes on a different line of the GST return. Keep the proof on file.'
        : 'Keep the proof on file (certificate, status card number or the reason the supply is zero-rated or exempt).');
      hint.classList.toggle('qbo-notax-missing', !doc.taxNoneReason);
    };
    drawHint();
    host.append(h('span', null, 'Why no tax?', kinds.length ? h('span', { class: 'muted' }, ` (${kinds.join(', ')} lines)`) : null), sel, hint);
  };
  draw();
  /** Call after every edit of the document (lines, treatment): redraws, and drops a reason no longer needed. */
  host.update = () => draw(true);
  return host;
}

/** Settlement payment row label: "Credited or paid in QuickBooks", read-only. */
export function settlementNote(ui) {
  return ui.h('span', { class: 'qbo-settlement muted', title: 'Written by the QuickBooks sync. Change it in QuickBooks.' }, ui.icon('lock', 14), ' Change it in QuickBooks');
}
