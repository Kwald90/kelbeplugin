// Notifications: what the bell shows. Two kinds of item, merged into one list:
//  - server notifications (GET /api/v1/notifications): payments from Stripe, AI suggestions,
//    Facebook leads, and anything else server code sends with notify() (server/src/services/notify.js);
//  - device-derived ones, worked out here from the synced records: jobs I'm on, time waiting for my
//    approval, permits, licences and certifications about to expire.
// Derived items have stable keys, so "read" is remembered per key (store meta, per user and company).
// Pure (no DOM): modules/notifications.js draws it.
//
// Hook for other screens (announcements): addNotificationSource(fn) where fn({ store, me, now })
// returns items shaped like { key, kind, title, body?, link, at, tone? }.

const DAY = 86400000;
const sources = new Set();

/** Register an extra source of items (announcements). Returns an unregister function. */
export function addNotificationSource(fn) { sources.add(fn); return () => sources.delete(fn); }

const day = (d) => new Date(d).toISOString().slice(0, 10);
const daysBetween = (fromDay, toDay) => Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY);

export const KIND_LABEL = {
  job_assigned: 'Jobs', timesheet: 'Time', ai_suggestion: 'AI suggestions', payment: 'Payments', lead: 'Leads',
  expiring: 'Expiring', announcement: 'Announcements', system: 'System', safety: 'Safety', workplan: 'Crew tasks', materials: 'Material requests',
};
export const KIND_ICON = {
  job_assigned: 'briefcase', timesheet: 'clock', ai_suggestion: 'zap', payment: 'dollar', lead: 'funnel', expiring: 'id-card', announcement: 'info', system: 'info', safety: 'shield-check', workplan: 'list', materials: 'truck',
};

/**
 * Items worked out from local records for one person.
 * @param {{ list: Function }} store
 * @param {{ employeeId?: string|null, can: (perm: string) => boolean }} me
 * @param {Date} [now]
 */
export function deriveNotifications(store, me, now = new Date()) {
  const out = [];
  const today = day(now);
  const can = (p) => Boolean(me?.can?.(p));
  // Jobs I'm on (crew) that are still open.
  if (me?.employeeId) {
    for (const j of store.list('jobs', (x) => (x.crewIds || []).includes(me.employeeId) && !['complete', 'invoiced'].includes(x.status))) {
      out.push({ key: `job:${j.id}:${me.employeeId}`, kind: 'job_assigned', title: `You're on ${[j.number, j.title].filter(Boolean).join(' · ')}`,
        body: j.startDate ? `Starts ${j.startDate}${j.address ? ` at ${j.address}` : ''}` : j.address || '', link: `#/jobs/${j.id}`, at: j.updatedAt || j.createdAt, tone: 'info' });
    }
  }
  // Time waiting for approval (one item; its key changes when more arrive, so it shows again).
  if (can('time-approve')) {
    const pending = store.list('timeEntries', (t) => t.clockOut && !t.approved && t.employeeId !== me?.employeeId);
    if (pending.length) {
      const latest = pending.reduce((a, t) => ((t.clockOut || '') > (a.clockOut || '') ? t : a));
      const people = new Set(pending.map((t) => t.employeeId)).size;
      out.push({ key: `time:${pending.length}:${latest.id}`, kind: 'timesheet', title: `${pending.length} time entr${pending.length === 1 ? 'y' : 'ies'} waiting for approval`,
        body: `${people} ${people === 1 ? 'person' : 'people'}`, link: '#/time', at: latest.clockOut, tone: 'warning' });
    }
  }
  // Permits, licences and certifications expiring within 30 days (or expired in the last 30).
  const expiring = (id, label, expiry, link) => {
    if (!expiry) return;
    const d = daysBetween(today, String(expiry).slice(0, 10));
    if (d > 30 || d < -30) return;
    const bucket = d < 0 ? 'expired' : d <= 7 ? 'week' : 'month';
    out.push({ key: `exp:${id}:${String(expiry).slice(0, 10)}:${bucket}`, kind: 'expiring', title: d < 0 ? `${label} expired ${-d} day${d === -1 ? '' : 's'} ago` : d === 0 ? `${label} expires today` : `${label} expires in ${d} day${d === 1 ? '' : 's'}`,
      link, at: `${today}T00:00:00.000Z`, tone: d <= 7 ? 'danger' : 'warning' });
  };
  if (can('compliance')) {
    for (const p of store.list('permits', (x) => x.status !== 'closed')) expiring(`permit:${p.id}`, `Permit ${p.number || ''}`.trim(), p.expiryDate, '#/compliance');
    for (const c of store.list('certifications')) expiring(`cert:${c.id}`, c.name || 'A certification', c.expiry, '#/compliance');
  }
  for (const e of store.list('employees', (x) => x.active !== false && x.licenceExpiry)) {
    if (e.id === me?.employeeId) expiring(`lic:${e.id}`, 'Your licence', e.licenceExpiry, `#/employees/${e.id}`);
    else if (can('employees')) expiring(`lic:${e.id}`, `${e.name}'s licence`, e.licenceExpiry, `#/employees/${e.id}`);
  }
  for (const fn of sources) {
    try { for (const it of fn({ store, me, now }) || []) if (it?.key && it.title) out.push({ kind: 'announcement', ...it }); } catch (e) { console.error('notification source failed', e); }
  }
  return out;
}

/**
 * One list for the bell: server items (read state from the server) and derived ones (read when
 * their key is in `readKeys`), newest first.
 */
export function mergeNotifications(server = [], derived = [], readKeys = new Set()) {
  const items = [
    ...server.map((n) => ({ key: `srv:${n.id}`, id: n.id, kind: n.kind, title: n.title, body: n.body || '', link: n.link || null, at: n.createdAt, read: Boolean(n.readAt), server: true })),
    ...derived.map((d) => ({ ...d, read: readKeys.has(d.key), server: false })),
  ];
  return items.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}

export const unreadCount = (items) => items.reduce((n, i) => n + (i.read ? 0 : 1), 0);

/** Read keys to keep: the ones still derived today (old ones fall away), capped. */
export function pruneReadKeys(readKeys, derived, max = 500) {
  const live = new Set(derived.map((d) => d.key));
  return [...readKeys].filter((k) => live.has(k)).slice(-max);
}

/** "3 min ago", "2 h ago", "yesterday", "Oct 4". */
export function timeAgo(at, now = new Date()) {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (now.getTime() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 2 * 86400) return 'yesterday';
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`;
  return new Date(t).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
}
