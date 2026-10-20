// HQ Mail (#/mail): an Outlook-style inbox for Fishtape's own mailboxes (support@, sales@ and
// any address forwarded in), fed by SendGrid Inbound Parse and sending through SendGrid.
// Folder pane | message list | reading pane, a command bar, Outlook keyboard shortcuts, and
// a compose pane that can pop out (#/mail/compose/<draftId>). System email (password resets,
// invites) shows under "System email" with what didn't get sent and why, never its body.
// On a phone or an iPad in portrait the panes collapse to one at a time.
import { BRAND } from '/js/brand.js';
import { api, get, post, put } from '../api.js';
import { MAIL_ICONS as I } from '../mail/icons.js';
import { messageView, systemView } from '../mail/reader.js';
import { composer, richEditor } from '../mail/compose.js';

const FOLDERS = [
  { id: 'inbox', label: 'Inbox', icon: I.inbox, count: (c) => c.inboxUnread },
  { id: 'drafts', label: 'Drafts', icon: I.drafts, count: (c) => c.drafts, total: true },
  { id: 'sent', label: 'Sent items', icon: I.sent },
  { id: 'outbox', label: 'Outbox', icon: I.outbox, count: (c) => c.outbox, total: true },
  { id: 'not_sent', label: 'Not sent', icon: I.notsent, count: (c) => c.notSent, total: true, danger: true },
  { id: 'archive', label: 'Archive', icon: I.archive, count: (c) => c.archiveUnread },
  { id: 'junk', label: 'Junk email', icon: I.junk, count: (c) => c.junkUnread },
  { id: 'trash', label: 'Deleted items', icon: I.trash, count: (c) => c.trash, total: true },
];
const SYSTEM_FOLDERS = [
  { id: 'outbox', label: 'Outbox', icon: I.outbox, count: (s) => s.outbox, total: true },
  { id: 'not_sent', label: 'Not sent', icon: I.notsent, count: (s) => s.notSent, total: true, danger: true },
  { id: 'sent', label: 'Sent', icon: I.sent },
];
const OUTGOING = new Set(['sent', 'outbox', 'not_sent', 'drafts']);
const SHORTCUTS = [
  ['Ctrl+Shift+M or N', 'New message'], ['Ctrl+R', 'Reply'], ['Ctrl+Shift+R', 'Reply all'], ['Ctrl+F', 'Forward'],
  ['Delete', 'Delete'], ['Ctrl+Alt+J', 'Junk'], ['Ctrl+Q', 'Mark as read'], ['Ctrl+U', 'Mark as unread'], ['Insert', 'Flag'],
  ['Ctrl+E or F3', 'Search'], ['↑ / ↓', 'Previous / next message'], ['Ctrl+Enter', 'Send (while writing)'], ['Esc', 'Close the message being written'],
];
const PREF = 'kc.hq.mail';

function loadCss() {
  if (document.querySelector('link[data-hq-mail]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/hq/mail.css';
  link.dataset.hqMail = '1';
  document.head.append(link);
}

function prefs(next) {
  try {
    if (next) localStorage.setItem(PREF, JSON.stringify(next));
    return JSON.parse(localStorage.getItem(PREF) || '{}') || {};
  } catch { return {}; }
}

/** "10:42 AM" today, "Mon" this week, "Oct 3" this year, else the full date. */
function when(ui, iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return ui.fmtTime(d);
  if (now - d < 6 * 86_400_000) return d.toLocaleDateString(undefined, { weekday: 'short' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return ui.fmtDate(d);
}

export default {
  render(root, ctx) {
    loadCss();
    if (ctx.params[0] === 'compose') return renderPopout(root, ctx, ctx.params[1]);
    return renderMail(root, ctx);
  },
};

function renderMail(root, ctx) {
  const { ui, isAdmin } = ctx;
  const { h } = ui;
  const saved = prefs();
  const S = {
    ov: null, mailboxId: saved.mailboxId || null, folder: saved.folder || 'inbox', items: [], cursor: null, grouped: true,
    sel: new Set(), anchor: null, current: null, message: null, view: 'list', search: {}, allFolders: false,
    images: new Set(), compose: null, reader: null, listSeq: 0, openSeq: 0, collapsed: new Set(saved.collapsed || []),
  };
  const narrow = matchMedia('(max-width: 900px)');
  const medium = matchMedia('(max-width: 1200px)');

  // ---- layout ----------------------------------------------------------------------------------
  const folderPane = h('nav', { class: 'mail-folders', 'aria-label': 'Mail folders' });
  const listHead = h('div', { class: 'mail-list-head' });
  const listBody = h('div', { class: 'mail-rows', role: 'listbox', 'aria-label': 'Messages', tabindex: 0, 'aria-multiselectable': 'true' });
  const listPane = h('section', { class: 'mail-list', 'aria-label': 'Message list' }, listHead, listBody);
  const readerPane = h('section', { class: 'mail-reader', 'aria-label': 'Reading pane', tabindex: -1 });
  const scrim = h('div', { class: 'mail-scrim', onClick: () => toggleFolders(false) });

  const searchIn = h('input', { class: 'input', type: 'search', placeholder: 'Search mail', 'aria-label': 'Search mail', autocomplete: 'off' });
  const fFrom = h('input', { class: 'input', type: 'text', 'aria-label': 'From', placeholder: 'From' });
  const fTo = h('input', { class: 'input', type: 'text', 'aria-label': 'To', placeholder: 'To' });
  const fSubject = h('input', { class: 'input', type: 'text', 'aria-label': 'Subject', placeholder: 'Subject' });
  const fAttach = h('input', { type: 'checkbox', 'aria-label': 'Has attachments' });
  const fUnread = h('input', { type: 'checkbox', 'aria-label': 'Unread only' });
  const fAll = h('input', { type: 'checkbox', 'aria-label': 'All folders' });
  const filters = h('form', { class: 'mail-filters', hidden: true, onSubmit: (e) => { e.preventDefault(); runSearch(); } },
    fFrom, fTo, fSubject,
    h('label', { class: 'mail-check' }, fAttach, h('span', null, 'Has attachments')),
    h('label', { class: 'mail-check' }, fUnread, h('span', null, 'Unread')),
    h('label', { class: 'mail-check' }, fAll, h('span', null, 'All folders')),
    ui.button('Search', { variant: 'primary', size: 'sm', type: 'submit' }),
    ui.button('Clear', { variant: 'ghost', size: 'sm', onClick: clearSearch }));
  const searchForm = h('form', { class: 'mail-search', role: 'search', onSubmit: (e) => { e.preventDefault(); runSearch(); } },
    ui.icon('search', 16), searchIn,
    h('button', { type: 'button', class: 'btn ghost sm icon', title: 'Search filters', 'aria-label': 'Search filters', onClick: () => { filters.hidden = !filters.hidden; if (!filters.hidden) fFrom.focus(); } }, ui.icon('filter', 16)));

  const assignSel = h('select', { class: 'input mail-assign', 'aria-label': 'Assign to', title: 'Assign to HQ staff', onChange: (e) => assign(e.target.value) });
  const cmd = (label, icon, onClick, title) => ui.button(label, { icon, onClick, title: title || label, size: 'sm', variant: 'ghost' });
  const btn = {
    folders: h('button', { type: 'button', class: 'btn ghost sm icon mail-only-narrow-folders', title: 'Folders', 'aria-label': 'Folders', onClick: () => toggleFolders() }, ui.icon(I.folders, 18)),
    back: h('button', { type: 'button', class: 'btn ghost sm icon mail-back', title: 'Back to the list', 'aria-label': 'Back to the list', onClick: () => setView('list') }, ui.icon(I.back, 18)),
    new: ui.button('New', { icon: 'plus', variant: 'primary', size: 'sm', onClick: () => startCompose('new'), title: 'New message (Ctrl+Shift+M)' }),
    reply: cmd('Reply', I.reply, () => reply('reply'), 'Reply (Ctrl+R)'),
    replyAll: cmd('Reply all', I.replyAll, () => reply('replyAll'), 'Reply all (Ctrl+Shift+R)'),
    forward: cmd('Forward', I.forward, () => reply('forward'), 'Forward (Ctrl+F)'),
    archive: cmd('Archive', I.archive, () => move('archive')),
    del: cmd('Delete', I.trash, () => remove(), 'Delete (Del)'),
    junk: cmd('Junk', I.junk, () => junk(), 'Junk (Ctrl+Alt+J)'),
    read: cmd('Read / Unread', I.read, () => toggleRead(), 'Mark as read (Ctrl+Q) or unread (Ctrl+U)'),
    flag: cmd('Flag', I.flag, () => toggleFlag(), 'Flag (Insert)'),
    keys: h('button', { type: 'button', class: 'btn ghost sm icon', title: 'Keyboard shortcuts', 'aria-label': 'Keyboard shortcuts', onClick: showShortcuts }, ui.icon(I.keyboard, 18)),
  };
  const bar = h('div', { class: 'mail-bar', role: 'toolbar', 'aria-label': 'Mail commands' },
    btn.folders, btn.back, btn.new,
    h('span', { class: 'mail-sep' }), btn.reply, btn.replyAll, btn.forward,
    h('span', { class: 'mail-sep' }), btn.archive, btn.del, btn.junk,
    h('span', { class: 'mail-sep' }), btn.read, btn.flag, assignSel,
    h('span', { class: 'grow' }), searchForm, btn.keys);
  const shell = h('div', { class: 'mail', dataset: { view: 'list', folders: 'closed' } }, bar, filters, h('div', { class: 'mail-panes' }, folderPane, listPane, readerPane), scrim);
  root.append(shell);

  function setView(v) {
    S.view = v;
    shell.dataset.view = v;
    if (v === 'list' && narrow.matches) listBody.focus({ preventScroll: true });
  }
  function toggleFolders(open = shell.dataset.folders !== 'open') { shell.dataset.folders = open ? 'open' : 'closed'; }
  const remember = () => prefs({ mailboxId: S.mailboxId, folder: S.folder, collapsed: [...S.collapsed] });

  // ---- folders -------------------------------------------------------------------------------
  async function loadOverview() {
    try {
      S.ov = await get('/api/hq/mail/overview');
    } catch (e) {
      if (!S.ov) { ui.clear(listBody).append(ui.empty({ icon: 'alert', title: 'Mail could not be loaded', text: e.message })); }
      return;
    }
    if (!S.mailboxId || (S.mailboxId !== 'system' && !S.ov.mailboxes.some((m) => m.id === S.mailboxId))) S.mailboxId = S.ov.mailboxes.find((m) => m.isDefault)?.id || S.ov.mailboxes[0]?.id || 'system';
    drawFolders();
    drawAssign();
    const unread = S.ov.mailboxes.reduce((n, m) => n + m.counts.inboxUnread, 0);
    document.title = `${unread ? `(${unread}) ` : ''}Mail · ${BRAND.name} HQ`;
  }

  function folderButton(mailboxId, f, counts) {
    const n = f.count ? f.count(counts) : 0;
    const active = S.mailboxId === mailboxId && S.folder === f.id && !searching();
    return h('button', {
      type: 'button', class: ['mail-folder', active ? 'active' : null, n && !f.total ? 'has-unread' : null], 'aria-current': active ? 'true' : null,
      onClick: () => selectFolder(mailboxId, f.id),
    }, ui.icon(f.icon, 18), h('span', { class: 'label' }, f.label), n ? h('span', { class: ['count', f.danger ? 'danger' : null, f.total ? 'total' : null] }, String(n)) : null);
  }

  function drawFolders() {
    ui.clear(folderPane);
    for (const mb of S.ov.mailboxes) {
      const closed = S.collapsed.has(mb.id);
      folderPane.append(h('div', { class: 'mail-box' },
        h('button', { type: 'button', class: 'mail-box-head', 'aria-expanded': String(!closed), title: mb.address, onClick: () => { if (closed) S.collapsed.delete(mb.id); else S.collapsed.add(mb.id); remember(); drawFolders(); } },
          ui.icon('chevron-down', 16), h('span', null, mb.name), mb.counts.inboxUnread && closed ? h('span', { class: 'count' }, String(mb.counts.inboxUnread)) : null),
        closed ? null : h('div', { class: 'mail-box-folders' }, FOLDERS.map((f) => folderButton(mb.id, f, mb.counts)))));
    }
    const sysClosed = S.collapsed.has('system');
    folderPane.append(h('div', { class: 'mail-box system' },
      h('button', { type: 'button', class: 'mail-box-head', 'aria-expanded': String(!sysClosed), title: 'Password resets, invites and alerts Fishtape sends', onClick: () => { if (sysClosed) S.collapsed.delete('system'); else S.collapsed.add('system'); remember(); drawFolders(); } },
        ui.icon('chevron-down', 16), h('span', null, 'System email'), S.ov.system.notSent ? h('span', { class: 'count danger' }, String(S.ov.system.notSent)) : null),
      sysClosed ? null : h('div', { class: 'mail-box-folders' }, SYSTEM_FOLDERS.map((f) => folderButton('system', f, S.ov.system)))));
    const warn = [];
    const st = S.ov.setup;
    if (!st.sending) warn.push('Sending is off: set SENDGRID_API_KEY and EMAIL_FROM on the server.');
    if (!st.eventsSigned) warn.push('Delivery events are off: set SENDGRID_EVENT_PUBLIC_KEY.');
    if (!st.inbound) warn.push('Receiving is off: set SENDGRID_INBOUND_TOKEN.');
    if (!st.storage) warn.push('Attachments are off: set MAIL_DIR.');
    if (S.ov.inbound.failing) warn.push(`${S.ov.inbound.failing} received message(s) could not be filed. See the API logs.`);
    folderPane.append(h('div', { class: 'mail-folders-foot' },
      warn.length ? h('ul', { class: 'mail-warn' }, warn.map((w) => h('li', null, w))) : null,
      isAdmin ? ui.button('Mail settings', { icon: 'settings', size: 'sm', variant: 'ghost', onClick: openSettings }) : null,
      h('p', { class: 'muted hq-small' }, `Kept ${S.ov.settings.retentionDays} days; Junk and Deleted items ${S.ov.settings.cleanupDays} days.`)));
  }

  function drawAssign() {
    ui.clear(assignSel);
    assignSel.append(h('option', { value: '' }, 'Assign…'), h('option', { value: 'none' }, 'Unassigned'),
      S.ov.staff.map((u) => h('option', { value: u.id }, u.name)));
    assignSel.value = '';
  }

  function selectFolder(mailboxId, folder) {
    S.mailboxId = mailboxId;
    S.folder = folder;
    S.search = {};
    searchIn.value = '';
    S.sel.clear();
    remember();
    drawFolders();
    toggleFolders(false);
    setView('list');
    loadList();
  }

  // ---- the list ------------------------------------------------------------------------------
  const searching = () => Object.values(S.search).some(Boolean);
  const folderLabel = () => {
    if (searching()) return 'Search results';
    const list = S.mailboxId === 'system' ? SYSTEM_FOLDERS : FOLDERS;
    const box = S.mailboxId === 'system' ? 'System email' : S.ov?.mailboxes.find((m) => m.id === S.mailboxId)?.name || '';
    return `${list.find((f) => f.id === S.folder)?.label || ''} · ${box}`;
  };

  async function loadList({ more = false, keepSelection = false } = {}) {
    const seq = ++S.listSeq;
    if (!more && !keepSelection) { ui.clear(listBody).append(h('p', { class: 'muted mail-pad' }, 'Loading…')); }
    const body = {
      mailboxId: S.mailboxId, folder: searching() && S.allFolders && S.mailboxId !== 'system' ? 'all' : S.folder, limit: 50, ...(S.groupOff ? { group: false } : {}),
      ...Object.fromEntries(Object.entries(S.search).filter(([, v]) => v)), ...(more && S.cursor ? { cursor: S.cursor } : {}),
    };
    try {
      const r = await post('/api/hq/mail/list', body);
      if (seq !== S.listSeq) return;
      S.items = more ? [...S.items, ...r.items] : r.items;
      S.cursor = r.nextCursor;
      S.grouped = r.grouped;
      if (!keepSelection && !more) S.sel.clear();
      drawList();
    } catch (e) {
      if (seq === S.listSeq) ui.clear(listBody).append(ui.empty({ icon: 'alert', title: 'Could not load messages', text: e.message }));
    }
  }

  function row(m) {
    const outgoing = OUTGOING.has(S.folder) || m.direction === 'out';
    const name = outgoing ? `To: ${(m.to || []).map((a) => a.name || a.address).join('; ') || '(no recipients)'}` : (m.from.name || m.from.address || '(unknown sender)');
    const selected = S.sel.has(m.id);
    const status = m.sendStatus === 'failed' ? ui.badge('Not sent', 'danger')
      : m.sendStatus === 'queued' || m.sendStatus === 'sending' ? ui.badge('Outbox', 'info')
        : m.deliveryStatus === 'deferred' ? ui.badge('Delayed', 'warning') : null;
    return h('div', {
      class: ['mail-row', m.read ? null : 'unread', selected ? 'selected' : null, m.id === S.current ? 'current' : null, m.flagged ? 'flagged' : null],
      role: 'option', 'aria-selected': String(selected), id: `mail-row-${m.id}`, dataset: { id: m.id },
      onClick: (e) => onRowClick(e, m),
    },
    h('span', { class: 'who' }, name, m.threadCount > 1 ? h('span', { class: 'thread-count', title: `${m.threadCount} messages in this conversation` }, ` (${m.threadCount})`) : null),
    h('span', { class: 'when' }, when(ui, m.date)),
    h('span', { class: 'subj' }, m.subject || '(no subject)'),
    h('span', { class: 'icons' },
      m.hasAttachments ? h('span', { title: 'Has attachments', class: 'ico' }, ui.icon(I.clip, 14)) : null,
      m.flagged ? h('span', { title: 'Flagged', class: 'ico flag' }, ui.icon(I.flag, 14)) : null,
      m.assignedName ? h('span', { class: 'assignee', title: `Assigned to ${m.assignedName}` }, ui.initials(m.assignedName)) : null),
    h('span', { class: 'prev' }, status, m.sendStatus === 'failed' && m.deliveryDetail ? ` ${m.deliveryDetail}` : m.preview || ''));
  }

  function drawList() {
    ui.clear(listHead).append(
      h('h2', null, folderLabel()),
      S.mailboxId !== 'system' && !searching() ? h('label', { class: 'mail-check', title: 'Group messages by conversation' },
        h('input', { type: 'checkbox', checked: !S.groupOff, onChange: () => { S.groupOff = !S.groupOff; loadList(); } }), h('span', null, 'Conversations')) : null);
    ui.clear(listBody);
    if (!S.items.length) {
      listBody.append(ui.empty({ icon: S.mailboxId === 'system' ? I.system : I.inbox, title: searching() ? 'Nothing matches' : 'Nothing here', text: searching() ? 'Try other words or filters.' : null }));
      return;
    }
    for (const m of S.items) listBody.append(row(m));
    if (S.cursor) listBody.append(h('div', { class: 'mail-more' }, ui.button('Load more', { size: 'sm', onClick: () => loadList({ more: true, keepSelection: true }) })));
    syncButtons();
  }

  function redrawRow(id) {
    const m = S.items.find((x) => x.id === id);
    const old = listBody.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (m && old) old.replaceWith(row(m));
  }

  function onRowClick(e, m) {
    if (e.ctrlKey || e.metaKey) {
      if (S.sel.has(m.id)) S.sel.delete(m.id); else S.sel.add(m.id);
      S.anchor = m.id;
      for (const x of S.items) redrawRow(x.id);
      syncButtons();
      return;
    }
    if (e.shiftKey && S.anchor) {
      const a = S.items.findIndex((x) => x.id === S.anchor);
      const b = S.items.findIndex((x) => x.id === m.id);
      S.sel = new Set(S.items.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.id));
      for (const x of S.items) redrawRow(x.id);
      syncButtons();
      return;
    }
    S.anchor = m.id;
    open(m.id);
  }

  const targets = () => (S.sel.size ? [...S.sel] : S.current ? [S.current] : []);
  function syncButtons() {
    const any = targets().length > 0;
    const sys = S.mailboxId === 'system';
    const haveMsg = Boolean(S.message) && !sys;
    for (const b of [btn.reply, btn.replyAll, btn.forward]) b.disabled = !haveMsg || S.message?.folder === 'drafts';
    for (const b of [btn.archive, btn.del, btn.junk, btn.read, btn.flag]) b.disabled = !any || sys;
    assignSel.disabled = !any || sys;
    btn.junk.title = S.folder === 'junk' ? 'Not junk: move to the Inbox' : 'Junk (Ctrl+Alt+J)';
  }

  // ---- reading -------------------------------------------------------------------------------
  function showInReader(view) {
    S.reader?.destroy?.();
    S.reader = view;
    ui.clear(readerPane).append(view.el);
    readerPane.scrollTop = 0;
  }

  function emptyReader() {
    S.reader?.destroy?.();
    S.reader = null;
    S.message = null;
    ui.clear(readerPane).append(h('div', { class: 'mail-reader-empty' }, ui.empty({ icon: I.read, title: 'Select a message to read it', text: 'Press ? for keyboard shortcuts.' })));
    syncButtons();
  }

  async function open(id, { quiet = false } = {}) {
    if (S.compose && S.compose.isDirty() && !(await ui.confirmDialog('Leave the message you are writing? It will be saved as a draft.', { title: 'Leave message', okLabel: 'Save and leave', danger: false }))) return;
    if (S.compose) { if (S.compose.isDirty()) await S.compose.saveDraft({ quiet: true }); S.compose = null; }
    const seq = ++S.openSeq;
    S.current = id;
    S.sel = new Set([id]);
    for (const x of S.items) redrawRow(x.id);
    document.getElementById(`mail-row-${id}`)?.scrollIntoView({ block: 'nearest' });
    if (!quiet) setView('reader');
    ui.clear(readerPane).append(h('p', { class: 'muted mail-pad' }, 'Loading…'));
    try {
      if (S.mailboxId === 'system') {
        const s = await get(`/api/hq/mail/system/${id}`);
        if (seq !== S.openSeq) return;
        S.message = null;
        showInReader(systemView({ ui }, s));
        syncButtons();
        return;
      }
      const m = await get(`/api/hq/mail/messages/${id}${S.images.has(id) ? '?images=1' : ''}`);
      if (seq !== S.openSeq) return;
      if (m.folder === 'drafts') { S.message = null; startCompose('draft', m); return; }
      S.message = m;
      showInReader(messageView(readerCtx, m));
      syncButtons();
      if (!m.read) {
        await api('/api/hq/mail/messages', { method: 'PATCH', body: { ids: [id], read: true } }).catch(() => {});
        const it = S.items.find((x) => x.id === id);
        if (it) { it.read = true; it.threadUnread = Math.max(0, (it.threadUnread || 1) - 1); redrawRow(id); }
        m.read = true;
        loadOverview();
      }
    } catch (e) {
      if (seq === S.openSeq) ui.clear(readerPane).append(ui.empty({ icon: 'alert', title: 'Could not open the message', text: e.message }));
    }
  }

  const readerCtx = {
    ui,
    onShowImages: () => { if (S.current) { S.images.add(S.current); open(S.current, { quiet: true }); } },
    onOpen: (id) => open(id),
    onKey: (e) => onKey(e),
    onMailto: (address) => startCompose('new', null, address),
    onToDrafts: async (id) => {
      try {
        await post(`/api/hq/mail/messages/${id}/to-drafts`);
        ui.toast('Moved to Drafts. Fix it and send it again.', 'success');
        await loadOverview();
        await loadList();
        open(id);
      } catch (e) { ui.toast(e.message, 'error', 4500); }
    },
  };

  // ---- writing -------------------------------------------------------------------------------
  async function startCompose(mode, message = null, to = null) {
    if (!S.ov) return;
    if (S.compose?.isDirty() && !(await ui.confirmDialog('Replace the message you are writing? It will be saved as a draft.', { title: 'New message', okLabel: 'Save draft and continue', danger: false }))) return;
    if (S.compose?.isDirty()) await S.compose.saveDraft({ quiet: true });
    const c = composer({
      ui, overview: S.ov, mailboxId: S.mailboxId === 'system' ? null : S.mailboxId,
      onSent: async () => { S.compose = null; emptyReader(); setView('list'); await loadOverview(); loadList({ keepSelection: true }); },
      onClose: async (reason) => {
        S.compose = null;
        if (reason === 'popout') ui.toast('Opened in a new window.', 'info');
        if (S.message) showInReader(messageView(readerCtx, S.message)); else emptyReader();
        if (narrow.matches && !S.message) setView('list');
        await loadOverview();
        if (S.folder === 'drafts') loadList();
      },
    }, { mode, message, to });
    S.compose = c;
    S.reader?.destroy?.();
    S.reader = null;
    ui.clear(readerPane).append(c.el);
    setView('reader');
    setTimeout(() => c.focus(), 30);
  }

  function reply(mode) {
    if (!S.message) { ui.toast('Open a message first.', 'info'); return; }
    startCompose(mode, S.message);
  }

  // ---- commands ------------------------------------------------------------------------------
  async function change(body, { drop = false } = {}) {
    const ids = targets();
    if (!ids.length) return;
    try {
      await api('/api/hq/mail/messages', { method: 'PATCH', body: { ids, ...(S.grouped ? { thread: true } : {}), ...body } });
    } catch (e) { ui.toast(e.message, 'error', 4500); return; }
    if (drop) {
      const idx = S.items.findIndex((x) => x.id === ids[0]);
      S.items = S.items.filter((x) => !ids.includes(x.id));
      S.sel.clear();
      const next = S.items[Math.min(idx, S.items.length - 1)];
      drawList();
      if (next && !narrow.matches) open(next.id, { quiet: true });
      else { emptyReader(); S.current = null; setView('list'); }
    } else {
      await loadList({ keepSelection: true });
      if (S.current && ids.includes(S.current) && S.message) {
        const m = await get(`/api/hq/mail/messages/${S.current}${S.images.has(S.current) ? '?images=1' : ''}`).catch(() => null);
        if (m && !S.compose) { S.message = m; showInReader(messageView(readerCtx, m)); }
      }
    }
    loadOverview();
  }

  const move = (folder) => change({ folder }, { drop: !searching() || folder === 'trash' });
  async function remove() {
    if (S.folder === 'trash' || S.folder === 'drafts') {
      const ids = targets();
      if (!ids.length) return;
      if (!(await ui.confirmDialog(`Delete ${ids.length === 1 ? 'this message' : `${ids.length} messages`} for good? This can't be undone.`, { title: 'Delete for good', okLabel: 'Delete' }))) return;
      try { await api('/api/hq/mail/messages', { method: 'DELETE', body: { ids } }); } catch (e) { ui.toast(e.message, 'error'); return; }
      S.items = S.items.filter((x) => !ids.includes(x.id));
      S.sel.clear();
      drawList();
      emptyReader();
      loadOverview();
      return;
    }
    move('trash');
  }
  const junk = () => (S.folder === 'junk' ? move('inbox') : move('junk'));
  function toggleRead(force) {
    const first = S.items.find((x) => x.id === targets()[0]);
    const read = force ?? !(first?.read ?? true);
    change({ read });
  }
  function toggleFlag() {
    const first = S.items.find((x) => x.id === targets()[0]) || S.message;
    change({ flagged: !first?.flagged });
  }
  function assign(v) {
    assignSel.value = '';
    if (!v) return;
    change({ assignedTo: v === 'none' ? null : v });
  }

  // ---- search ----------------------------------------------------------------------------------
  function runSearch() {
    S.search = { q: searchIn.value.trim(), from: fFrom.value.trim(), to: fTo.value.trim(), subject: fSubject.value.trim(), hasAttachment: fAttach.checked || undefined, unread: fUnread.checked || undefined };
    S.allFolders = fAll.checked;
    drawFolders();
    setView('list');
    loadList();
  }
  function clearSearch() {
    for (const i of [searchIn, fFrom, fTo, fSubject]) i.value = '';
    for (const i of [fAttach, fUnread, fAll]) i.checked = false;
    S.search = {};
    filters.hidden = true;
    drawFolders();
    loadList();
  }

  // ---- keyboard (Outlook) --------------------------------------------------------------------
  function step(d) {
    if (!S.items.length) return;
    const i = S.items.findIndex((x) => x.id === S.current);
    const next = S.items[Math.max(0, Math.min(S.items.length - 1, (i < 0 ? -1 : i) + d))];
    if (next) open(next.id, { quiet: narrow.matches && S.view === 'list' });
  }

  function onKey(e) {
    if (document.querySelector('.scrim')) return; // a dialog is open
    const k = (e.key || '').toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    const typing = e.target?.closest?.('input, textarea, select, [contenteditable="true"]');
    if (S.compose) {
      if (mod && k === 'enter') { e.preventDefault(); S.compose.send(); return; }
      if (k === 'escape') { e.preventDefault(); S.compose.discard(); return; }
      if (typing) return;
    }
    if (typing) {
      if (k === 'escape' && e.target === searchIn) { clearSearch(); searchIn.blur(); }
      return;
    }
    let done = true;
    if (mod && e.shiftKey && k === 'r') reply('replyAll');
    else if (mod && e.shiftKey && k === 'm') startCompose('new');
    else if (mod && e.altKey && k === 'j') junk();
    else if (mod && k === 'r') reply('reply');
    else if (mod && k === 'f') reply('forward');
    else if (mod && k === 'q') toggleRead(true);
    else if (mod && k === 'u') toggleRead(false);
    else if ((mod && k === 'e') || e.key === 'F3') { searchIn.focus(); searchIn.select(); }
    else if (mod) done = false;
    else if (e.key === 'Delete') remove();
    else if (e.key === 'Insert') toggleFlag();
    else if (e.key === 'ArrowDown' || k === 'j') step(1);
    else if (e.key === 'ArrowUp' || k === 'k') step(-1);
    else if (k === 'n') startCompose('new');
    else if (e.key === '?') showShortcuts();
    else if (k === 'escape' && narrow.matches && S.view === 'reader') setView('list');
    else done = false;
    if (done) e.preventDefault();
  }

  function showShortcuts() {
    const s = ui.openSheet({ title: 'Keyboard shortcuts', dialog: true,
      body: h('dl', { class: 'hq-kv mail-keys' }, SHORTCUTS.map(([key, what]) => [h('dt', null, h('kbd', null, key)), h('dd', null, what)])),
      actions: [ui.button('Close', { variant: 'primary', onClick: () => s.close() })] });
  }

  // ---- settings (HQ admin) -------------------------------------------------------------------
  function openSettings() {
    const st = S.ov.settings;
    const body = h('div', { class: 'stack' },
      h('h3', null, 'Mailboxes'),
      h('p', { class: 'muted' }, 'Mail sent to a mailbox address (or one of its aliases, e.g. a forwarding rule from Outlook) lands in it. Replies go out From the sender address, which must be on a domain authenticated in SendGrid.'),
      h('div', { class: 'mail-settings-boxes' }, S.ov.mailboxes.map((mb) => h('div', { class: 'card flat mail-settings-box' },
        h('div', null, h('strong', null, mb.name), mb.isDefault ? ui.badge('Default', 'info') : null),
        h('div', { class: 'muted hq-small' }, mb.address), mb.aliases.length ? h('div', { class: 'muted hq-small' }, `Also: ${mb.aliases.join(', ')}`) : null,
        h('div', { class: 'muted hq-small' }, `Sends as ${mb.fromName || mb.name} <${mb.fromAddress || mb.address}>`),
        ui.button('Edit', { size: 'sm', onClick: () => { s.close(); editMailbox(mb); } })))),
      ui.button('Add a mailbox', { icon: 'plus', size: 'sm', onClick: () => { s.close(); editMailbox(null); } }),
      h('h3', null, 'Retention and spam'),
      ui.formGrid([
        { label: 'Keep mail (days)', name: 'retentionDays', type: 'number', value: st.retentionDays, min: 30, max: 3650, hint: 'Flagged mail is kept.' },
        { label: 'Empty Junk and Deleted items after (days)', name: 'cleanupDays', type: 'number', value: st.cleanupDays, min: 1, max: 365 },
        { label: 'Junk when SendGrid\'s spam score is at least', name: 'spamThreshold', type: 'number', value: st.spamThreshold, min: 0, max: 100, step: 0.1 },
      ]));
    const s = ui.openSheet({ title: 'Mail settings', wide: true, body,
      actions: [h('span', { class: 'grow' }), ui.button('Close', { variant: 'ghost', onClick: () => s.close() }), ui.button('Save', { variant: 'primary', onClick: async () => {
        const v = ui.readForm(body);
        try {
          await put('/api/hq/mail/settings', { retentionDays: Number(v.retentionDays), cleanupDays: Number(v.cleanupDays), spamThreshold: Number(v.spamThreshold) });
          ui.toast('Saved', 'success');
          s.close();
          loadOverview();
        } catch (e) { ui.toast(e.message, 'error', 4500); }
      } })] });
  }

  function editMailbox(mb) {
    const sig = richEditor(ui, { html: mb?.signatureHtml || '', label: 'Signature' });
    ui.formSheet({
      title: mb ? `Mailbox: ${mb.name}` : 'New mailbox', wide: true,
      fields: [
        { label: 'Name', name: 'name', value: mb?.name || '', required: true },
        { label: 'Address (receives mail)', name: 'address', type: 'email', value: mb?.address || '', required: true, placeholder: 'support@inbox.fishtapehq.com' },
        { label: 'Aliases (forwarded addresses, comma separated)', name: 'aliases', value: (mb?.aliases || []).join(', '), placeholder: 'info@tgelectrical.ca', span: true },
        { label: 'Sender name', name: 'fromName', value: mb?.fromName || '' },
        { label: 'Sender address (authenticated domain)', name: 'fromAddress', type: 'email', value: mb?.fromAddress || '', placeholder: 'support@fishtapehq.com' },
        { label: 'Default mailbox (unknown addresses land here)', name: 'isDefault', type: 'checkbox', value: Boolean(mb?.isDefault) },
      ],
      extra: h('div', { class: 'field' }, h('span', null, 'Signature'), sig.el),
      submitLabel: 'Save',
      onSubmit: (v) => {
        const body = { name: v.name, address: v.address, aliases: String(v.aliases || '').split(/[,;\s]+/).filter(Boolean), fromName: v.fromName || null, fromAddress: v.fromAddress || null, signatureHtml: sig.editor.innerHTML, isDefault: Boolean(v.isDefault) };
        (mb ? put(`/api/hq/mail/mailboxes/${mb.id}`, body) : post('/api/hq/mail/mailboxes', body))
          .then(() => { ui.toast('Mailbox saved', 'success'); loadOverview(); })
          .catch((e) => ui.toast(e.message, 'error', 5000));
      },
    });
  }

  // ---- start -----------------------------------------------------------------------------------
  const onResize = () => { if (!narrow.matches) shell.dataset.folders = medium.matches ? shell.dataset.folders : 'closed'; };
  narrow.addEventListener('change', onResize);
  document.addEventListener('keydown', onKey);
  emptyReader();
  (async () => {
    await loadOverview();
    if (S.ov) loadList();
  })();
  const timer = setInterval(async () => {
    if (document.hidden) return;
    await loadOverview();
    if (!searching() && !S.compose && listBody.scrollTop < 40) loadList({ keepSelection: true });
  }, 60_000);

  return () => {
    clearInterval(timer);
    document.removeEventListener('keydown', onKey);
    narrow.removeEventListener('change', onResize);
    S.reader?.destroy?.();
  };
}

/** #/mail/compose/<draftId>: the compose window on its own (Outlook's pop-out). */
function renderPopout(root, ctx, draftId) {
  const { ui } = ctx;
  const { h } = ui;
  const host = h('div', { class: 'mail mail-popout' }, h('p', { class: 'muted mail-pad' }, 'Loading…'));
  root.append(host);
  const done = () => { if (window.opener) window.close(); else ctx.nav('mail'); };
  (async () => {
    try {
      const [ov, m] = await Promise.all([get('/api/hq/mail/overview'), get(`/api/hq/mail/messages/${draftId}`)]);
      if (m.folder !== 'drafts') { ui.clear(host).append(ui.empty({ icon: I.sent, title: 'This message was already sent or deleted' })); return; }
      const c = composer({ ui, overview: ov, mailboxId: m.mailbox.id, popout: true, onSent: done, onClose: done }, { mode: 'draft', message: m });
      ui.clear(host).append(c.el);
      document.title = `${m.subject || 'New message'} · ${BRAND.name} HQ`;
      setTimeout(() => c.focus(), 30);
      host.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); c.send(); }
      });
    } catch (e) {
      ui.clear(host).append(ui.empty({ icon: 'alert', title: 'Could not open the draft', text: e.message }));
    }
  })();
  return () => {};
}
