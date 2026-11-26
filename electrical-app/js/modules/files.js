// Files (#/files): a Drive-like home for every document the company gets: plans, permits, quotes,
// invoices, photos, specs, contracts, letters. Organised by customer, then job, each with the same
// standard folders, plus a company area. Import (button, drag and drop, or "Send to Fishtape" from
// another app) and the AI files each document into the right job and folder and suggests a clean name;
// anything it isn't sure of waits in "Inbox · needs sorting". People can undo, move and rename.
//
//   #/files                       the top (or the focused job's folder when "Working on" a job)
//   #/files?top=1                 the top even when a job is focused
//   #/files?c=<client>&cat=…      a customer / one of its folders; ?j=<job>&cat=… a job; ?f=<folder>
//   #/files?at=inbox|company|trash|nocustomer
//   #/files?shared=1              files shared from another app: opens the Import sheet
//
// Pure logic: lib/files-tree.js (tree, crumbs, search, sort), lib/files-classify.js (folders, rules
// classifier, names). Data: lib/files-api.js (server or this device, offline queue). Text for filing:
// lib/files-text.js. Shares: lib/files-share.js (service worker, iOS and Android plugins).
// Server: server/src/routes/v1/files.js (FILES_DIR, never a web root; AI filing in services/files-ai.js).
import { CATEGORIES, COMPANY_CATEGORIES, categoryLabel, categoryOf, extOf, isCompanyCategory } from '../lib/files-classify.js';
import {
  parseLoc, locHref, sameLoc, startLoc, placeOf, folderTiles, crumbs, fileInLoc, countIndex, searchFiles, sortFiles, SORTS,
  fmtBytes, fileKind, SAFE_IMAGE, placeLabel, locOfFile, jobLabel, visibleCategories, jobsOf, isUnsorted,
} from '../lib/files-tree.js';
import { filesBackend, createQueue, queuedAsFiles, importProblem, isOfflineError, MAX_FILE_BYTES_DEFAULT } from '../lib/files-api.js';
import { extractText, loadPdfJs } from '../lib/files-text.js';
import { takeShared, stashShared, countShared, onShared, installNativeShareListener } from '../lib/files-share.js';
import { getBlob } from '../lib/local-blobs.js';
import { jobFocus, onJobFocus } from '../lib/job-focus.js';
import { noteUse, rankByUse } from '../lib/usage-rank.js';

// Files handed over by the iOS/Android app ("Open in Fishtape", Share) are taken as soon as the app has
// loaded, whatever screen is open (a no-op in a browser).
try { installNativeShareListener(); } catch { /* not in the app */ }

function loadCss() {
  if (typeof document === 'undefined' || document.querySelector('link[href$="css/files.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = 'css/files.css';
  document.head.append(link);
}

export default {
  id: 'files',
  title: 'Files',
  icon: 'file-text',
  group: 'work',
  perm: 'jobs',
  render(root, ctx) {
    loadCss();
    return filesView(root, ctx);
  },
};

// Kept across screens of this module so going into a folder doesn't flash empty.
let cache = null; // { db, data }
// Recent import results ("Filed to … · Undo · Move"), kept until dismissed.
const tray = [];
const DRAG_TYPE = 'application/x-fishtape-files';
const PAGE_SIZE = 300;
const pref = (k, d) => { try { return localStorage.getItem(`ft.files.${k}`) || d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(`ft.files.${k}`, v); } catch { /* storage blocked */ } };
const SVGNS = 'http://www.w3.org/2000/svg';

/** A folder glyph (the shared icon set has none). */
function folderGlyph(size = 36) {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'fl-glyph');
  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('d', 'M3 6.6C3 5.7 3.7 5 4.6 5h4.6l2 2.1h8.2c.9 0 1.6.7 1.6 1.6v8.7c0 .9-.7 1.6-1.6 1.6H4.6c-.9 0-1.6-.7-1.6-1.6z');
  svg.append(p);
  return svg;
}

const KIND_ICON = { pdf: 'file-text', image: 'image', video: 'play', audio: 'play', text: 'file-text', office: 'file-text', cad: 'layers', mail: 'mail', archive: 'box', other: 'file-text' };
const KIND_LABEL = { pdf: 'PDF', image: 'Image', video: 'Video', audio: 'Audio', text: 'Text', office: 'Office', cad: 'Drawing', mail: 'Email', archive: 'ZIP', other: 'File' };

function filesView(root, ctx) {
  const { store, ui, auth, nav } = ctx;
  const { h } = ui;
  const backend = filesBackend(store);
  const queue = createQueue(store);
  const uid = auth.current?.()?.id;
  const canWrite = !ctx.readOnly && auth.can('jobs');
  const money = auth.isManager?.() || auth.can('invoices') || auth.can('estimates');
  const rank = (list, items, idOf) => rankByUse(list, items, idOf, { uid });

  let loc = startLoc(ctx.query, jobFocus(store, auth));
  if (!sameLoc(loc, parseLoc(ctx.query))) history.replaceState(null, '', locHref(loc));
  let data = cache?.db === store.dbName ? cache.data : null;
  let queued = [];
  let query = '';
  let sort = pref('sort', 'date');
  let view = pref('view', 'grid');
  let selected = new Set();
  let shown = PAGE_SIZE;
  let alive = true;
  const thumbs = new Map(); // fileId -> object URL
  const offs = [];

  const hrefOf = (l) => (sameLoc(l, {}) ? '#/files?top=1' : locHref(l));
  const go = (l) => nav(hrefOf(l));
  const clients = () => store.list('clients');
  const jobs = () => store.list('jobs');
  const treeData = () => ({ files: allFiles(), folders: data?.folders || [], clients: clients(), jobs: jobs() });
  const allFiles = () => [...(data?.files || []), ...queuedAsFiles(queued)];
  const companyFiles = () => data?.companyFiles !== false;
  const maxBytes = () => data?.usage?.maxFileBytes || MAX_FILE_BYTES_DEFAULT;
  const place = () => placeOf(loc, treeData());
  const nameOfPlace = (p) => placeLabel(p, treeData()) || 'Inbox';

  // ---------- layout ----------
  const crumbHost = h('nav', { class: 'fl-crumbs', 'aria-label': 'Folder path' });
  const bannerHost = h('div', { class: 'fl-banners' });
  const selHost = h('div', { class: 'fl-selbar', hidden: true });
  const body = h('div', { class: 'fl-body' });
  const trayHost = h('aside', { class: 'fl-tray', 'aria-live': 'polite', hidden: true });
  const dropCover = h('div', { class: 'fl-dropcover', hidden: true }, h('div', null, ui.icon('upload', 28), h('strong', { class: 'fl-dropcover-text' }, 'Drop to import')));
  const subtitle = h('span');
  const search = h('input', { type: 'search', class: 'fl-search-input', placeholder: 'Search files, text, customers…', 'aria-label': 'Search files', onInput: (e) => { query = e.target.value; shown = PAGE_SIZE; drawBody(); } });
  const sortPick = h('select', { class: 'fl-select', 'aria-label': 'Sort files', onChange: (e) => { sort = e.target.value; setPref('sort', sort); drawBody(); } },
    SORTS.map((s) => h('option', { value: s.id, selected: s.id === sort }, s.label)));
  const viewBtn = (id, ic, label) => ui.button('', { variant: 'ghost', icon: ic, title: label, onClick: () => { view = id; setPref('view', id); drawBody(); paintViewBtns(); } });
  const gridBtn = viewBtn('grid', 'grid', 'Grid view');
  const listBtn = viewBtn('list', 'list', 'List view');
  const paintViewBtns = () => { gridBtn.setAttribute('aria-pressed', String(view === 'grid')); listBtn.setAttribute('aria-pressed', String(view === 'list')); };
  paintViewBtns();
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onChange: () => { const fs = [...fileInput.files]; fileInput.value = ''; if (fs.length) openImport(fs, { source: 'upload' }); } });
  const importBtn = canWrite ? ui.button('Import', { variant: 'primary', icon: 'upload', onClick: () => fileInput.click() }) : null;
  const folderBtn = canWrite ? ui.button('New folder', { icon: 'plus', onClick: () => newFolder() }) : null;

  const page = ui.page({ title: 'Files', subtitle: '', actions: [folderBtn, importBtn].filter(Boolean) },
    h('div', { class: 'fl-toolbar' }, crumbHost, h('span', { class: 'grow' }),
      h('label', { class: 'field search fl-search' }, ui.icon('search', 16), search), sortPick, h('span', { class: 'fl-viewbtns' }, gridBtn, listBtn)),
    bannerHost, selHost, body, fileInput);
  page.querySelector('.page-head .sub')?.remove();
  page.querySelector('.page-head h1')?.after(h('div', { class: 'sub' }, subtitle));
  const shell = h('div', { class: 'fl-page' }, page, dropCover, trayHost);
  root.append(shell);

  // ---------- drawing ----------
  function draw() {
    if (!alive) return;
    drawCrumbs();
    drawSubtitle();
    drawBanners();
    drawBody();
    drawTray();
    if (folderBtn) folderBtn.hidden = !canMakeFolderHere();
    if (importBtn) importBtn.disabled = Boolean(data && data.storage === 'off');
  }

  function drawCrumbs() {
    ui.clear(crumbHost);
    const list = crumbs(loc, treeData());
    list.forEach((c, i) => {
      const last = i === list.length - 1;
      if (i) crumbHost.append(h('span', { class: 'fl-crumb-sep', 'aria-hidden': 'true' }, '›'));
      const a = last ? h('span', { class: 'fl-crumb current', 'aria-current': 'page' }, c.label) : h('a', { class: 'fl-crumb', href: hrefOf(c.loc) }, c.label);
      if (!last) dropTarget(a, placeForLoc(c.loc));
      crumbHost.append(a);
    });
  }

  function drawSubtitle() {
    const u = data?.usage;
    const bits = [];
    if (u) {
      bits.push(`${u.count} file${u.count === 1 ? '' : 's'}`);
      bits.push(u.quotaBytes ? `${fmtBytes(u.bytes)} of ${fmtBytes(u.quotaBytes)} used` : `${fmtBytes(u.bytes)} on this device`);
    }
    subtitle.textContent = bits.join(' · ') || 'Documents by customer and job, filed for you';
  }

  async function drawBanners() {
    ui.clear(bannerHost);
    if (!data) return;
    if (data.storage === 'off') bannerHost.append(banner('warning', 'File storage is not set up on this server yet, so files can’t be imported. An administrator sets FILES_DIR.'));
    if (data.offline) bannerHost.append(banner('info', 'Offline: showing the files as of the last sync. Imports wait on this device and upload when you’re back online.'));
    if (data.local) bannerHost.append(banner('info', 'Demo: files stay on this device and are sorted by keywords. Signed in, they sync to your company and the AI files them.'));
    const u = data.usage;
    if (u?.quotaBytes && u.bytes > u.quotaBytes * 0.9) bannerHost.append(banner('warning', `Storage is ${Math.round((u.bytes / u.quotaBytes) * 100)}% full (${fmtBytes(u.bytes)} of ${fmtBytes(u.quotaBytes)}). Empty Recently deleted or remove files you no longer need.`));
    const waiting = queued.filter((q) => q.status === 'queued').length, failed = queued.filter((q) => q.status === 'failed').length;
    if (waiting || failed) {
      bannerHost.append(h('div', { class: 'fl-banner info' }, ui.icon('upload', 16),
        h('span', { class: 'grow' }, [waiting ? `${waiting} file${waiting === 1 ? '' : 's'} waiting to upload` : '', failed ? `${failed} couldn’t upload` : ''].filter(Boolean).join(' · ')),
        ui.button('Upload now', { size: 'sm', onClick: () => flushQueue({ loud: true }) }),
        failed ? ui.button('Clear failed', { size: 'sm', variant: 'ghost', onClick: async () => { for (const q of queued.filter((x) => x.status === 'failed')) await queue.remove(q.id); await reloadQueue(); draw(); } }) : null));
    }
    const sharedN = await countShared();
    if (sharedN && alive) bannerHost.append(h('div', { class: 'fl-banner accent' }, ui.icon('download', 16), h('span', { class: 'grow' }, `${sharedN} shared file${sharedN === 1 ? '' : 's'} waiting to be filed`), ui.button('File them', { size: 'sm', variant: 'primary', onClick: () => openShared() })));
  }

  const banner = (tone, text) => h('div', { class: ['fl-banner', tone] }, ui.icon(tone === 'warning' ? 'alert' : 'info', 16), h('span', null, text));

  function drawBody() {
    ui.clear(body);
    drawSelection();
    if (!data) { body.append(h('div', { class: 'fl-loading muted' }, 'Loading files…')); return; }
    const td = { ...treeData(), count: countIndex(allFiles(), data.folders || []) };
    if (query.trim()) {
      const hits = sortFiles(searchFiles(allFiles(), query, td), sort);
      body.append(h('h2', { class: 'fl-h' }, `${hits.length} result${hits.length === 1 ? '' : 's'} for “${query.trim()}”`));
      body.append(hits.length ? fileList(hits, { showPath: true }) : ui.empty({ icon: 'search', title: 'Nothing found', text: 'Search looks at file names, the text inside PDFs and documents, and customer and job names.' }));
      return;
    }
    if (loc.at === 'company' && !companyFiles()) {
      body.append(ui.empty({ icon: 'lock', title: 'Company files are for the office', text: 'Ask an owner, admin or office person if you need something from here.' }));
      return;
    }
    const tiles = folderTiles(loc, td, { money, companyFiles: companyFiles(), rank });
    const here = sortFiles(allFiles().filter((f) => fileInLoc(f, loc)), sort);
    if (loc.jobId && !jobs().some((j) => j.id === loc.jobId)) body.append(banner('warning', 'This job is no longer in the job list. Its files are still here.'));
    if (tiles.length) {
      body.append(h('h2', { class: 'fl-h' }, loc.clientId && !loc.cat ? 'Jobs and folders' : 'Folders'));
      body.append(h('div', { class: ['fl-tiles', view === 'list' ? 'list' : null] }, tiles.map(tileEl)));
    }
    if (!sameLoc(loc, {}) || here.length) {
      const unsortedHere = here.filter(isUnsorted);
      if ((loc.clientId || loc.jobId) && !loc.cat && unsortedHere.length) {
        body.append(h('h2', { class: 'fl-h' }, 'Needs sorting'));
        body.append(fileList(unsortedHere, { showPath: false }));
      }
      const rest = (loc.clientId || loc.jobId) && !loc.cat ? here.filter((f) => !isUnsorted(f)) : here;
      if (rest.length) {
        body.append(h('h2', { class: 'fl-h' }, loc.at === 'trash' ? 'Recently deleted' : loc.at === 'inbox' ? 'Waiting to be sorted' : 'Files'));
        if (loc.at === 'trash') body.append(h('p', { class: 'muted fl-note' }, `Files here are removed for good after ${data.usage?.trashDays || 30} days.`));
        body.append(fileList(rest, { showPath: loc.at === 'inbox' || loc.at === 'trash' }));
      } else if (!tiles.length || loc.cat || loc.folderId) {
        body.append(emptyHere());
      }
    }
    if (sameLoc(loc, {})) {
      const recent = sortFiles(allFiles().filter((f) => !f.deletedAt), 'date').slice(0, 8);
      if (recent.length) { body.append(h('h2', { class: 'fl-h' }, 'Recent')); body.append(fileList(recent, { showPath: true })); }
      const trashN = td.count('trash');
      body.append(h('div', { class: 'fl-bottomlinks' }, h('a', { href: hrefOf({ at: 'trash' }), class: 'fl-link' }, ui.icon('trash', 14), ` Recently deleted${trashN ? ` (${trashN})` : ''}`)));
    }
  }

  function emptyHere() {
    if (loc.at === 'inbox') return ui.empty({ icon: 'check', title: 'All sorted', text: 'New files the AI wasn’t sure about wait here. Right now there’s nothing to sort.' });
    if (loc.at === 'trash') return ui.empty({ icon: 'trash', title: 'Nothing deleted', text: 'Deleted files stay here for 30 days, then they’re removed for good.' });
    if (loc.at === 'nocustomer') return ui.empty({ icon: 'briefcase', title: 'Every job has a customer', text: '' });
    return ui.empty({
      icon: 'upload', title: 'Nothing here yet',
      text: canWrite ? 'Drop files here, or tap Import. Files dropped on a customer or job are sorted into the right folder for you.' : 'No files in this folder yet.',
      action: canWrite ? ui.button('Import files', { variant: 'primary', icon: 'upload', onClick: () => fileInput.click() }) : null,
    });
  }

  /** The place a breadcrumb or tile location stands for (for drops). */
  function placeForLoc(l) {
    if (sameLoc(l, {}) || l.at === 'trash' || l.at === 'nocustomer') return null;
    return placeOf(l, treeData());
  }

  function canMakeFolderHere() {
    if (!canWrite || !data || data.storage === 'off') return false;
    if (loc.at === 'company') return companyFiles();
    return Boolean(loc.clientId || loc.jobId || loc.folderId);
  }

  // ---------- tiles ----------
  function tileEl(t) {
    const glyph = t.kind === 'folder' || t.kind === 'category'
      ? h('span', { class: 'fl-tile-ico folder' }, folderGlyph(view === 'list' ? 24 : 34), t.kind === 'category' ? h('span', { class: 'fl-tile-badge' }, ui.icon(t.icon, 12)) : null)
      : h('span', { class: ['fl-tile-ico', t.kind] }, ui.icon(t.icon, view === 'list' ? 18 : 22));
    const a = h('a', {
      class: ['fl-tile', `k-${t.kind}`, t.kind === 'inbox' && t.count ? 'attention' : null], href: hrefOf(t.loc),
      onClick: () => { if (t.kind === 'client') noteUse('files.clients', t.loc.clientId, { uid }); if (t.kind === 'job') noteUse('files.jobs', t.loc.jobId, { uid }); },
    },
    glyph,
    h('span', { class: 'fl-tile-text' }, h('span', { class: 'fl-tile-label' }, t.label), t.sub ? h('span', { class: 'fl-tile-sub' }, t.sub) : null),
    h('span', { class: 'fl-tile-count', 'aria-label': `${t.count} files` }, t.count ? String(t.count) : ''));
    if (t.kind === 'folder' && canWrite) {
      a.append(ui.button('', { variant: 'ghost', size: 'sm', icon: 'more', title: `${t.label}: more`, onClick: (e) => { e.preventDefault(); e.stopPropagation(); folderMenu(t.folder); } }));
    }
    if (t.place && canWrite) dropTarget(a, { ...t.place, company: t.kind === 'company' || (t.place && !t.place.clientId && !t.place.jobId && isCompanyCategory(t.place.category)) });
    return a;
  }

  async function folderMenu(f) {
    const s = ui.openSheet({
      title: f.name, dialog: true,
      body: h('div', { class: 'stack' },
        ui.button('Rename', { icon: 'pencil', onClick: async () => { s.close(); const name = await ui.promptDialog('Folder name', { title: 'Rename folder', value: f.name, okLabel: 'Rename' }); if (name && name.trim() && name.trim() !== f.name) await act(() => backend.renameFolder(f.id, name.trim()), 'Folder renamed.'); } }),
        ui.button('Remove folder', { icon: 'trash', variant: 'ghost danger', onClick: async () => { s.close(); if (await ui.confirmDialog(`Remove “${f.name}”? Its files and folders move up one level; nothing is deleted.`, { title: 'Remove folder', okLabel: 'Remove' })) await act(() => backend.deleteFolder(f.id), 'Folder removed. Its files moved up a level.'); } })),
    });
  }

  // ---------- files ----------
  function fileList(files, { showPath }) {
    const list = files.slice(0, shown);
    const wrap = h('div', { class: ['fl-files', view === 'list' ? 'list' : 'grid'] }, list.map((f) => fileEl(f, { showPath })));
    const out = [wrap];
    if (files.length > shown) out.push(h('div', { class: 'fl-more' }, ui.button(`Show ${Math.min(PAGE_SIZE, files.length - shown)} more`, { onClick: () => { shown += PAGE_SIZE; drawBody(); } })));
    observeThumbs(wrap);
    return h('div', null, out);
  }

  function aiBadge(f) {
    if (f.pending) return ui.badge(f.status === 'failed' ? 'upload failed' : 'waiting to upload', f.status === 'failed' ? 'danger' : 'info');
    if (f.deletedAt) return ui.badge(`deleted ${ui.fmtDate(f.deletedAt)}`, 'neutral');
    if (isUnsorted(f)) return ui.badge('needs sorting', 'warning');
    if (f.ai?.by === 'ai' && f.ai.applied) return h('span', { class: 'badge accent', title: f.ai.reason || '' }, `AI ${Math.round((f.ai.confidence || 0) * 100)}%`);
    if (f.ai?.by === 'rules' && f.ai.applied) return h('span', { class: 'badge neutral', title: f.ai.reason || '' }, 'auto-filed');
    return null;
  }

  function fileEl(f, { showPath }) {
    const kind = fileKind(f);
    const isSel = selected.has(f.id);
    const check = h('input', { type: 'checkbox', class: 'fl-check', checked: isSel, 'aria-label': `Select ${f.name}`, onClick: (e) => e.stopPropagation(), onChange: (e) => { if (e.target.checked) selected.add(f.id); else selected.delete(f.id); el.classList.toggle('selected', e.target.checked); drawSelection(); } });
    const thumb = h('span', { class: ['fl-thumb', `k-${kind}`], dataset: kind === 'image' && SAFE_IMAGE.has(f.mime) && !f.pending && view === 'grid' && f.bytes < 8 * 1024 * 1024 ? { thumb: f.id } : {} },
      ui.icon(KIND_ICON[kind] || 'file-text', view === 'list' ? 18 : 26), h('span', { class: 'fl-ext' }, (f.ext || extOf(f.name) || KIND_LABEL[kind]).toUpperCase().slice(0, 5)));
    const meta = [fmtBytes(f.bytes), f.createdAt ? ui.fmtDate(f.createdAt) : null].filter(Boolean).join(' · ');
    const el = h('div', {
      class: ['fl-file', isSel ? 'selected' : null, f.pending ? 'pending' : null], role: 'button', tabindex: 0, draggable: canWrite && !f.pending && !f.deletedAt ? 'true' : null,
      'aria-label': `${f.name}, ${KIND_LABEL[kind]}, ${fmtBytes(f.bytes)}`,
      onClick: (e) => { if (e.shiftKey || e.metaKey || e.ctrlKey || selected.size) { e.preventDefault(); check.checked = !check.checked; check.dispatchEvent(new Event('change')); } else openPreview(f); },
      onKeydown: (e) => { if (e.key === 'Enter') openPreview(f); if (e.key === ' ') { e.preventDefault(); check.checked = !check.checked; check.dispatchEvent(new Event('change')); } },
      onDragstart: (e) => {
        const ids = selected.has(f.id) ? [...selected] : [f.id];
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
        e.dataTransfer.effectAllowed = 'move';
      },
    },
    check, thumb,
    h('span', { class: 'fl-file-text' },
      h('span', { class: 'fl-file-name', title: f.name }, f.name),
      h('span', { class: 'fl-file-meta' }, meta, aiBadge(f) ? ' ' : '', aiBadge(f)),
      showPath && !f.pending ? h('span', { class: 'fl-file-path' }, placeLabel(f, treeData())) : null,
      f.pending && f.error ? h('span', { class: 'fl-file-path danger' }, f.error) : null),
    ui.button('', { variant: 'ghost', size: 'sm', icon: 'more', title: `${f.name}: more`, onClick: (e) => { e.stopPropagation(); fileMenu(f); } }));
    return el;
  }

  // Thumbnails for photos in grid view: fetched when scrolled into view, kept for this visit.
  let io = null;
  function observeThumbs(wrap) {
    const els = wrap.querySelectorAll('[data-thumb]');
    if (!els.length || typeof IntersectionObserver === 'undefined') return;
    io ||= new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        io.unobserve(en.target);
        const id = en.target.dataset.thumb;
        const put = (url) => {
          if (!alive) return;
          const img = h('img', { src: url, alt: '', loading: 'lazy', decoding: 'async', onError: () => { img.remove(); en.target.classList.remove('has-img'); } });
          en.target.classList.add('has-img');
          en.target.prepend(img);
        };
        if (thumbs.has(id)) { put(thumbs.get(id)); continue; }
        backend.content(id).then((blob) => { const url = URL.createObjectURL(blob); thumbs.set(id, url); put(url); }).catch(() => {});
      }
    }, { rootMargin: '200px' });
    els.forEach((e) => io.observe(e));
  }

  function fileMenu(f) {
    const live = !f.deletedAt && !f.pending;
    const item = (label, ic, fn, variant) => ui.button(label, { icon: ic, variant: variant || 'ghost', onClick: () => { s.close(); fn(); } });
    const s = ui.openSheet({
      title: f.name, dialog: true,
      body: h('div', { class: 'stack fl-menu' },
        f.pending ? null : item('Open', 'eye', () => openPreview(f)),
        f.pending ? null : item('Download', 'download', () => downloadFile(f)),
        live && canWrite ? item('Rename', 'pencil', () => renameFile(f)) : null,
        live && canWrite ? item('Move', 'chevron-right', () => moveFiles([f.id])) : null,
        live && canWrite && isUnsorted(f) ? item('Sort with AI', 'zap', () => organizeFiles([f])) : null,
        live && canWrite && f.ai?.suggestedName && f.ai.suggestedName !== f.name ? item(`Rename to “${f.ai.suggestedName}”`, 'pencil', () => act(() => backend.rename(f.id, f.ai.suggestedName), 'Renamed.')) : null,
        live && !sameLoc(locOfFile(f), loc) ? item('Show in folder', 'chevron-right', () => { query = ''; search.value = ''; go(locOfFile(f)); }) : null,
        f.deletedAt && canWrite ? item('Restore', 'undo', () => act(() => backend.restore(f.id), 'Restored.')) : null,
        live && canWrite ? item('Delete', 'trash', () => deleteFiles([f.id]), 'ghost danger') : null,
        f.deletedAt && data?.canPurge ? item('Delete for good', 'trash', () => purgeFiles([f.id]), 'ghost danger') : null,
        f.pending ? item('Upload now', 'upload', () => flushQueue({ loud: true })) : null,
        f.pending ? item('Cancel this upload', 'x', async () => { await queue.remove(f.id); await reloadQueue(); draw(); }, 'ghost danger') : null,
        f.ai?.reason && !f.pending ? h('p', { class: 'muted fl-why' }, `${f.ai.by === 'ai' ? 'AI' : f.ai.by === 'person' ? 'Moved by a person. Earlier: ' : 'Keywords'}: ${f.ai.reason}`) : null),
    });
  }

  // ---------- selection ----------
  function drawSelection() {
    for (const id of [...selected]) if (!allFiles().some((f) => f.id === id)) selected.delete(id);
    ui.clear(selHost);
    selHost.hidden = !selected.size;
    if (!selected.size) return;
    const files = allFiles().filter((f) => selected.has(f.id));
    const live = files.filter((f) => !f.deletedAt && !f.pending);
    const trashed = files.filter((f) => f.deletedAt);
    const unsorted = live.filter(isUnsorted);
    h(selHost, null,
      h('strong', null, `${selected.size} selected`),
      canWrite && live.length ? ui.button('Move', { size: 'sm', icon: 'chevron-right', onClick: () => moveFiles(live.map((f) => f.id)) }) : null,
      live.length ? ui.button('Download', { size: 'sm', icon: 'download', onClick: async () => { for (const f of live) await downloadFile(f); } }) : null,
      canWrite && unsorted.length ? ui.button(`Sort ${unsorted.length} with AI`, { size: 'sm', icon: 'zap', onClick: () => organizeFiles(unsorted) }) : null,
      canWrite && trashed.length ? ui.button('Restore', { size: 'sm', icon: 'undo', onClick: () => act(async () => { for (const f of trashed) await backend.restore(f.id); }, `${trashed.length} restored.`) }) : null,
      canWrite && live.length ? ui.button('Delete', { size: 'sm', icon: 'trash', variant: 'ghost danger', onClick: () => deleteFiles(live.map((f) => f.id)) }) : null,
      data?.canPurge && trashed.length ? ui.button('Delete for good', { size: 'sm', icon: 'trash', variant: 'ghost danger', onClick: () => purgeFiles(trashed.map((f) => f.id)) }) : null,
      h('span', { class: 'grow' }),
      ui.button('Select all here', { size: 'sm', variant: 'ghost', onClick: () => { for (const el of body.querySelectorAll('.fl-check')) { el.checked = true; } for (const f of visibleFiles()) selected.add(f.id); drawBody(); } }),
      ui.button('', { size: 'sm', variant: 'ghost', icon: 'x', title: 'Clear selection', onClick: () => { selected.clear(); drawBody(); } }));
  }
  const visibleFiles = () => (query.trim() ? searchFiles(allFiles(), query, treeData()) : allFiles().filter((f) => fileInLoc(f, loc)));

  // ---------- actions ----------
  async function act(fn, done) {
    try { await fn(); if (done) ui.toast(done, 'success'); } catch (e) { ui.toast(errText(e), 'error', 5000); }
    await refresh();
  }
  const errText = (e) => (isOfflineError(e) ? 'You’re offline. Try again when you have a connection.' : e?.message || 'Something went wrong.');

  async function renameFile(f) {
    const name = await ui.promptDialog('File name', { title: 'Rename', value: f.name, okLabel: 'Rename' });
    if (name && name.trim() && name.trim() !== f.name) await act(() => backend.rename(f.id, name.trim()), 'Renamed.');
  }

  async function deleteFiles(ids) {
    const n = ids.length;
    if (!await ui.confirmDialog(`Move ${n === 1 ? 'this file' : `${n} files`} to Recently deleted? ${data?.usage?.trashDays ? `You can restore ${n === 1 ? 'it' : 'them'} for ${data.usage.trashDays} days.` : ''}`, { title: 'Delete', okLabel: 'Delete' })) return;
    let done = 0;
    try { for (const id of ids) { await backend.trash(id); done++; } } catch (e) { ui.toast(errText(e), 'error', 5000); }
    selected.clear();
    await refresh();
    if (done) undoToast(`${done} file${done === 1 ? '' : 's'} deleted.`, async () => { for (const id of ids.slice(0, done)) await backend.restore(id).catch(() => {}); await refresh(); });
  }

  async function purgeFiles(ids) {
    if (!await ui.confirmDialog(`Delete ${ids.length === 1 ? 'this file' : `${ids.length} files`} for good? This can’t be undone.`, { title: 'Delete for good', okLabel: 'Delete for good' })) return;
    selected.clear();
    await act(async () => { for (const id of ids) await backend.purge(id); }, 'Deleted for good.');
  }

  /** A toast-like note with an Undo button (in the tray, so it stays long enough to use). */
  function undoToast(text, undo) {
    tray.unshift({ key: `u${Date.now()}`, state: 'info', text, actions: [{ label: 'Undo', run: async (entry) => { await undo(); entry.text = 'Undone.'; entry.actions = []; drawTray(); } }] });
    drawTray();
  }

  async function downloadFile(f) {
    try {
      const blob = f.pending ? await getBlob(f.id) : await backend.content(f.id);
      if (!blob) throw new Error('This file is no longer on this device.');
      await ui.download(f.name, blob, f.mime || blob.type || 'application/octet-stream');
    } catch (e) { ui.toast(errText(e), 'error', 5000); }
  }

  async function moveFiles(ids) {
    const files = allFiles().filter((f) => ids.includes(f.id));
    const first = files[0];
    const to = await pickPlace({ title: ids.length === 1 ? `Move “${first?.name}”` : `Move ${ids.length} files`, okLabel: 'Move here', start: first ? { clientId: first.clientId, jobId: first.jobId, category: first.category, folderId: first.folderId } : place(), allowAi: false });
    if (!to) return;
    let n = 0;
    try { for (const id of ids) { await backend.move(id, to); n++; } } catch (e) { ui.toast(errText(e), 'error', 5000); }
    selected.clear();
    if (to.clientId) noteUse('files.clients', to.clientId, { uid });
    if (to.jobId) noteUse('files.jobs', to.jobId, { uid });
    await refresh();
    if (n) ui.toast(`Moved ${n} file${n === 1 ? '' : 's'} to ${nameOfPlace(to)}.`, 'success', 3500);
  }

  async function organizeFiles(files) {
    for (const f of files) {
      const entry = { key: `o${f.id}${Date.now()}`, fileId: f.id, name: f.name, state: 'working', text: 'Sorting…' };
      tray.unshift(entry); drawTray();
      try {
        const r = await backend.organize(f.id, { date: ui.today() });
        describeResult(entry, r.file, r.result);
      } catch (e) { entry.state = 'failed'; entry.text = errText(e); }
      drawTray();
    }
    selected.clear();
    await refresh();
  }

  async function newFolder() {
    const name = await ui.promptDialog('Folder name', { title: 'New folder', okLabel: 'Make folder' });
    if (!name || !name.trim()) return;
    const p = place();
    await act(() => backend.createFolder({ name: name.trim(), clientId: p.clientId, jobId: p.jobId, category: p.category, parentId: loc.folderId || null }), 'Folder made.');
  }

  // ---------- drag and drop ----------
  function dropTarget(el, target) {
    if (!target || !canWrite) return;
    el.addEventListener('dragover', (e) => {
      const types = [...(e.dataTransfer?.types || [])];
      if (!types.includes('Files') && !types.includes(DRAG_TYPE)) return;
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = types.includes(DRAG_TYPE) ? 'move' : 'copy';
      el.classList.add('drop-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      el.classList.remove('drop-over');
      hideCover();
      handleDrop(e.dataTransfer, target);
    });
  }

  function handleDrop(dt, target) {
    const internal = dt?.getData?.(DRAG_TYPE);
    if (internal) {
      let ids = [];
      try { ids = JSON.parse(internal); } catch { ids = []; }
      if (ids.length && target && (target.category || target.folderId || target.clientId || target.jobId || target.company)) moveDropped(ids, target);
      return;
    }
    const files = [...(dt?.files || [])];
    if (files.length) runImport(files, target || place(), { source: 'drop', auto: true });
  }

  async function moveDropped(ids, target) {
    // A drop on a customer or job (not a folder in it) lets the AI pick the folder.
    if (!target.category && !target.folderId) {
      let n = 0;
      for (const id of ids) {
        try { await backend.move(id, { clientId: target.clientId, jobId: target.jobId, category: null, folderId: null }); n++; } catch (e) { ui.toast(errText(e), 'error', 5000); break; }
      }
      await refresh();
      const moved = allFiles().filter((f) => ids.includes(f.id));
      if (n) await organizeFiles(moved);
      return;
    }
    let n = 0;
    try { for (const id of ids) { await backend.move(id, target); n++; } } catch (e) { ui.toast(errText(e), 'error', 5000); }
    selected.clear();
    await refresh();
    if (n) ui.toast(`Moved ${n} file${n === 1 ? '' : 's'} to ${nameOfPlace(target)}.`, 'success', 3000);
  }

  // The whole page takes external files: they go to the folder being shown (Inbox at the top).
  let dragDepth = 0;
  const showCover = () => {
    const p = placeForLoc(loc) || place();
    dropCover.querySelector('.fl-dropcover-text').textContent = `Drop to import into ${nameOfPlace(p)}`;
    dropCover.hidden = false;
  };
  const hideCover = () => { dragDepth = 0; dropCover.hidden = true; };
  if (canWrite) {
    shell.addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { dragDepth++; showCover(); } });
    shell.addEventListener('dragleave', () => { if (--dragDepth <= 0) hideCover(); });
    shell.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
    shell.addEventListener('drop', (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      hideCover();
      if (!data || data.storage === 'off') { ui.toast('File storage is not set up on this server.', 'error'); return; }
      handleDrop(e.dataTransfer, placeForLoc(loc) || place());
    });
  }

  // ---------- place picker (Import and Move) ----------
  /**
   * Pick a customer → job → folder. With allowAi, blanks mean "let the AI decide".
   * Resolves to a place { clientId, jobId, category, folderId, company } or null.
   */
  function pickPlace({ title, okLabel, start = {}, allowAi = true, intro = null, extra = null }) {
    return new Promise((resolve) => {
      let answered = false;
      const cl = [...clients()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
      const rankedClients = rank('files.clients', cl, (c) => c.id);
      const COMPANY = '__company', INBOX = '';
      let who = start.company || (!start.clientId && !start.jobId && start.category && isCompanyCategory(start.category)) ? COMPANY
        : start.clientId || (start.jobId ? jobs().find((j) => j.id === start.jobId)?.clientId || '__nocustomer' : INBOX);
      let jobId = start.jobId || '';
      let folder = start.folderId ? `f:${start.folderId}` : start.category ? `c:${start.category}` : '';
      const whoSel = h('select', { class: 'fl-select wide', 'aria-label': 'Customer' });
      const jobSel = h('select', { class: 'fl-select wide', 'aria-label': 'Job' });
      const folderSel = h('select', { class: 'fl-select wide', 'aria-label': 'Folder' });
      const where = h('p', { class: 'fl-where muted' });
      const fill = () => {
        ui.clear(whoSel);
        whoSel.append(h('option', { value: INBOX }, allowAi ? 'Inbox: let the AI find the customer' : 'Inbox · needs sorting'));
        if (companyFiles()) whoSel.append(h('option', { value: COMPANY, selected: who === COMPANY }, 'Company files'));
        if (jobs().some((j) => !j.clientId)) whoSel.append(h('option', { value: '__nocustomer', selected: who === '__nocustomer' }, 'Jobs with no customer'));
        whoSel.append(h('optgroup', { label: 'Customers' }, rankedClients.map((c) => h('option', { value: c.id, selected: c.id === who }, c.name || 'Customer'))));
        whoSel.value = who;
        const customer = who && who !== COMPANY;
        jobSel.disabled = !customer;
        ui.clear(jobSel);
        if (customer) {
          const list = rank('files.jobs', jobsOf(jobs(), who === '__nocustomer' ? null : who), (j) => j.id);
          if (who !== '__nocustomer') jobSel.append(h('option', { value: '' }, allowAi ? 'Let the AI pick the job' : 'Customer-level (no job)'));
          if (allowAi && who !== '__nocustomer') jobSel.append(h('option', { value: '__none' }, 'Customer-level (no job)'));
          for (const j of list) jobSel.append(h('option', { value: j.id }, `${jobLabel(j)}${['complete', 'invoiced', 'cancelled'].includes(j.status) ? ' (closed)' : ''}`));
          if (!list.some((j) => j.id === jobId) && jobId !== '__none') jobId = who === '__nocustomer' ? (list[0]?.id || '') : '';
          jobSel.value = jobId;
        } else jobSel.append(h('option', { value: '' }, who === COMPANY ? '—' : 'The AI picks the customer and job'));
        ui.clear(folderSel);
        const company = who === COMPANY;
        const noPlace = !who;
        folderSel.disabled = noPlace;
        if (noPlace) { folderSel.append(h('option', { value: '' }, allowAi ? 'The AI picks the folder' : '—')); folder = ''; }
        else {
          folderSel.append(h('option', { value: '' }, allowAi ? 'Let the AI pick the folder' : company ? 'Choose a folder' : 'Choose a folder'));
          const cats = visibleCategories({ company, money });
          for (const c of cats) folderSel.append(h('option', { value: `c:${c.id}` }, c.label));
          const jid = jobId && jobId !== '__none' ? jobId : null;
          const made = (data?.folders || []).filter((f) => (company ? !f.clientId && !f.jobId : jid ? f.jobId === jid : f.clientId === who && !f.jobId));
          if (made.length) {
            folderSel.append(h('optgroup', { label: 'Your folders' }, made.map((f) => h('option', { value: `f:${f.id}` }, `${f.category ? `${categoryLabel(f.category)} › ` : ''}${f.name}`))));
          }
          if (![...folderSel.options].some((o) => o.value === folder)) folder = '';
          folderSel.value = folder;
        }
        const p = result();
        where.textContent = p ? (p.category || p.folderId ? `Goes to: ${nameOfPlace(p)}` : allowAi ? `The AI files ${p.clientId || p.jobId ? `it inside ${nameOfPlace({ ...p, category: 'other' }).replace(/ › Other$/, '')}` : p.company ? 'it into a company folder' : 'it with the right customer and job'}; anything it isn’t sure of waits in Inbox · needs sorting.` : 'Pick a folder.') : '';
        ok.disabled = !allowAi && !(p && (p.category || p.folderId || (!p.clientId && !p.jobId && !p.company)));
      };
      const result = () => {
        const company = who === COMPANY;
        const p = { clientId: company || !who || who === '__nocustomer' ? null : who, jobId: jobId && jobId !== '__none' ? jobId : null, category: null, folderId: null, company };
        if (folder.startsWith('c:')) p.category = folder.slice(2);
        if (folder.startsWith('f:')) p.folderId = folder.slice(2);
        if (p.jobId && !p.clientId) p.clientId = jobs().find((j) => j.id === p.jobId)?.clientId || null;
        return p;
      };
      whoSel.addEventListener('change', () => { who = whoSel.value; jobId = ''; folder = ''; fill(); });
      jobSel.addEventListener('change', () => { jobId = jobSel.value; folder = folder.startsWith('c:') ? folder : ''; fill(); });
      folderSel.addEventListener('change', () => { folder = folderSel.value; fill(); });
      const ok = ui.button(okLabel, { variant: 'primary', onClick: () => { answered = true; const p = result(); s.close(); resolve(p); } });
      const s = ui.openSheet({
        title,
        body: h('div', { class: 'stack fl-picker' }, intro,
          h('label', { class: 'field' }, h('span', null, 'Customer'), whoSel),
          h('label', { class: 'field' }, h('span', null, 'Job'), jobSel),
          h('label', { class: 'field' }, h('span', null, 'Folder'), folderSel),
          where, extra),
        actions: [h('span', { class: 'grow' }), ui.button('Cancel', { variant: 'ghost', onClick: () => s.close() }), ok],
        onClose: () => { if (!answered) resolve(null); },
      });
      fill();
    });
  }

  // ---------- import ----------
  async function openImport(files, { source = 'upload' } = {}) {
    if (!canWrite) { ui.toast('You can’t add files here.', 'error'); return; }
    if (data?.storage === 'off') { ui.toast('File storage is not set up on this server yet.', 'error', 5000); return; }
    const max = maxBytes();
    const rows = files.map((f) => ({ f, problem: importProblem(f, max) }));
    const ok = rows.filter((r) => !r.problem);
    const intro = h('div', { class: 'fl-importlist' },
      h('p', { class: 'muted' }, `${files.length} file${files.length === 1 ? '' : 's'}${source === 'share' ? ' shared with Fishtape' : ''}. Pick where ${files.length === 1 ? 'it goes' : 'they go'}, or let the AI sort ${files.length === 1 ? 'it' : 'them'}.`),
      h('ul', { class: 'fl-importrows' }, rows.map((r) => h('li', { class: r.problem ? 'bad' : null },
        ui.icon(KIND_ICON[fileKind({ mime: r.f.type, name: r.f.name })] || 'file-text', 16),
        h('span', { class: 'grow fl-importname' }, r.f.name || 'File'),
        h('span', { class: 'muted' }, r.problem || fmtBytes(r.f.size))))));
    const focus = jobFocus(store, auth);
    const cur = place();
    const start = cur.clientId || cur.jobId || cur.company || cur.folderId ? cur : focus ? { jobId: focus, clientId: store.get('jobs', focus)?.clientId || null } : {};
    const to = await pickPlace({ title: source === 'share' ? 'File shared documents' : 'Import files', okLabel: ok.length ? `Import ${ok.length} file${ok.length === 1 ? '' : 's'}` : 'Close', start, allowAi: true, intro });
    if (!to) return false;
    if (ok.length) runImport(ok.map((r) => r.f), to, { source, auto: true, checked: true });
    return true;
  }

  let sharing = false;
  async function openShared() {
    if (sharing) return;
    sharing = true;
    try {
      if (/[?&]shared=1/.test(location.hash)) history.replaceState(null, '', hrefOf(loc));
      const files = await takeShared();
      // Closed without importing: put them back, so "waiting to be filed" offers them again.
      if (files.length && !(await openImport(files, { source: 'share' }))) await stashShared(files, 'share').catch(() => {});
    } finally { sharing = false; }
    if (alive) drawBanners();
  }

  /** Upload, then let the AI file each one (sequentially, so a phone on site isn't swamped). */
  async function runImport(files, target, { source = 'upload', auto = true, checked = false } = {}) {
    if (!canWrite) return;
    const max = maxBytes();
    const t = { clientId: target?.clientId || null, jobId: target?.jobId || null, category: target?.category || null, folderId: target?.folderId || null, company: Boolean(target?.company) };
    if (t.clientId) noteUse('files.clients', t.clientId, { uid });
    if (t.jobId) noteUse('files.jobs', t.jobId, { uid });
    const sortIt = auto && !t.category && !t.folderId;
    for (const file of files) {
      const entry = { key: `i${Date.now()}${Math.random()}`, name: file.name || 'File', state: 'working', text: 'Uploading…' };
      tray.unshift(entry); drawTray();
      const problem = checked ? null : importProblem(file, max);
      if (problem) { entry.state = 'failed'; entry.text = problem; drawTray(); continue; }
      const text = sortIt ? await extractText(file) : '';
      const toQueue = async () => {
        await queue.add(file, { place: t, source, text, auto: sortIt, company: t.company });
        entry.state = 'queued'; entry.text = 'Saved on this device. It uploads and gets filed when you’re back online.';
        await reloadQueue();
      };
      try {
        if (backend.kind === 'server' && typeof navigator !== 'undefined' && navigator.onLine === false) { await toQueue(); drawTray(); continue; }
        const up = await backend.upload(file, t, { source });
        entry.fileId = up.file.id;
        if (up.duplicate) {
          entry.state = 'info'; entry.text = `Already in Files: ${placeLabel(up.file, treeData())}`;
          entry.actions = [{ label: 'Show', run: () => go(locOfFile(up.file)) }];
        } else if (sortIt) {
          entry.text = 'Sorting…'; drawTray();
          try {
            const r = await backend.organize(up.file.id, { text: text || undefined, company: t.company, date: ui.today() });
            describeResult(entry, r.file, r.result);
          } catch (e) {
            entry.state = 'inbox'; entry.text = `Uploaded. ${isOfflineError(e) ? 'Offline, so it' : 'It'} waits in Inbox · needs sorting.`;
            entry.actions = [{ label: 'Move', run: () => moveFiles([up.file.id]) }];
          }
        } else {
          entry.state = 'filed'; entry.text = `Added to ${nameOfPlace(up.file)}`;
          entry.actions = [{ label: 'Move', run: () => moveFiles([up.file.id]) }];
        }
      } catch (e) {
        if (isOfflineError(e) && backend.kind === 'server') await toQueue();
        else { entry.state = 'failed'; entry.text = e?.message || 'Upload failed.'; }
      }
      drawTray();
      await refresh({ quiet: true });
    }
  }

  /** Turn an organize answer into a tray line with Undo / Move / Accept / Rename. */
  function describeResult(entry, file, result) {
    entry.fileId = file.id;
    entry.name = file.name;
    const who = result.by === 'ai' ? 'AI' : 'Keywords';
    const why = result.reason ? ` ${result.reason}` : '';
    entry.actions = [];
    if (result.applied) {
      entry.state = 'filed';
      entry.text = `Filed to ${nameOfPlace(file)}`;
      entry.detail = `${who}, ${Math.round((result.confidence || 0) * 100)}% sure.${why}${result.note ? ` ${result.note}` : ''}`;
      const from = result.from;
      entry.actions.push({ label: 'Undo', run: async (en) => { try { await backend.move(file.id, from); en.text = `Moved back to ${nameOfPlace(from)}`; en.state = 'info'; en.actions = [{ label: 'Move', run: () => moveFiles([file.id]) }]; } catch (e) { ui.toast(errText(e), 'error'); } await refresh(); drawTray(); } });
    } else {
      entry.state = 'inbox';
      const s = result.suggestion || {};
      const guess = s.category && (s.clientId || s.jobId || isCompanyCategory(s.category)) ? nameOfPlace({ clientId: s.clientId, jobId: s.jobId, category: s.category }) : null;
      entry.text = `Needs sorting${guess ? `: maybe ${guess}` : ''}`;
      entry.detail = `${who}, ${Math.round((result.confidence || 0) * 100)}% sure.${why}${result.note ? ` ${result.note}` : ''}`;
      if (guess) entry.actions.push({ label: 'Accept', run: async (en) => { try { await backend.move(file.id, { clientId: s.clientId, jobId: s.jobId, category: s.category }); en.state = 'filed'; en.text = `Filed to ${guess}`; en.actions = en.actions.filter((a) => a.label === 'Rename'); } catch (e) { ui.toast(errText(e), 'error'); } await refresh(); drawTray(); } });
    }
    entry.actions.push({ label: 'Move', run: () => moveFiles([file.id]) });
    if (result.suggestedName && result.suggestedName !== file.name) {
      entry.actions.push({ label: 'Rename', title: `Rename to “${result.suggestedName}”`, run: async (en) => { try { await backend.rename(file.id, result.suggestedName); en.name = result.suggestedName; en.actions = en.actions.filter((a) => a.label !== 'Rename'); } catch (e) { ui.toast(errText(e), 'error'); } await refresh(); drawTray(); } });
      entry.suggestedName = result.suggestedName;
    }
  }

  function drawTray() {
    ui.clear(trayHost);
    trayHost.hidden = !tray.length;
    if (!tray.length) return;
    while (tray.length > 30) tray.pop();
    const working = tray.filter((e) => e.state === 'working').length;
    h(trayHost, null,
      h('header', { class: 'fl-tray-head' }, h('strong', null, working ? `Filing ${working}…` : 'Recent imports'), h('span', { class: 'grow' }),
        ui.button('', { variant: 'ghost', size: 'sm', icon: 'x', title: 'Close', onClick: () => { for (let i = tray.length - 1; i >= 0; i--) if (tray[i].state !== 'working') tray.splice(i, 1); drawTray(); } })),
      h('ul', { class: 'fl-tray-list' }, tray.map((en) => h('li', { class: ['fl-tray-row', en.state] },
        h('span', { class: 'fl-tray-ico' }, ui.icon(en.state === 'filed' ? 'check' : en.state === 'failed' ? 'alert' : en.state === 'queued' ? 'clock' : en.state === 'working' ? 'upload' : en.state === 'inbox' ? 'download' : 'info', 16)),
        h('span', { class: 'fl-tray-text' },
          en.name ? h('span', { class: 'fl-tray-name' }, en.name) : null,
          h('span', null, en.text),
          en.suggestedName && en.actions?.some((a) => a.label === 'Rename') ? h('span', { class: 'muted fl-tray-detail' }, `Suggested name: ${en.suggestedName}`) : null,
          en.detail ? h('span', { class: 'muted fl-tray-detail' }, en.detail) : null,
          en.actions?.length ? h('span', { class: 'fl-tray-actions' }, en.actions.map((a) => ui.button(a.label, { size: 'sm', variant: a.label === 'Undo' || a.label === 'Accept' ? 'secondary' : 'ghost', title: a.title, onClick: () => a.run(en) }))) : null)))));
  }

  // ---------- preview ----------
  async function openPreview(f) {
    const kind = fileKind(f);
    const frame = h('div', { class: ['fl-preview', `k-${kind}`] }, h('p', { class: 'muted' }, 'Opening…'));
    const urls = [];
    const canvases = [];
    const live = !f.deletedAt && !f.pending;
    const s = ui.openSheet({
      title: f.name, wide: true,
      body: h('div', { class: 'stack' },
        h('div', { class: 'fl-preview-meta muted' }, [KIND_LABEL[kind], fmtBytes(f.bytes), f.createdAt ? ui.fmtDateTime(f.createdAt) : null, f.pending ? 'waiting to upload' : placeLabel(f, treeData())].filter(Boolean).join(' · ')),
        f.ai?.reason ? h('p', { class: 'fl-why muted' }, `${f.ai.by === 'ai' ? 'AI' : f.ai.by === 'person' ? 'Moved by a person; first filed by keywords/AI' : 'Keywords'}: ${f.ai.reason}`) : null,
        frame),
      actions: [
        live && canWrite ? ui.button('Delete', { variant: 'ghost danger', icon: 'trash', onClick: () => { s.close(); deleteFiles([f.id]); } }) : null,
        h('span', { class: 'grow' }),
        live && canWrite ? ui.button('Rename', { icon: 'pencil', onClick: () => { s.close(); renameFile(f); } }) : null,
        live && canWrite ? ui.button('Move', { icon: 'chevron-right', onClick: () => { s.close(); moveFiles([f.id]); } }) : null,
        ui.button('Download', { variant: 'primary', icon: 'download', onClick: () => downloadFile(f) }),
      ].filter(Boolean),
      onClose: () => { for (const u of urls) URL.revokeObjectURL(u); for (const c of canvases) { c.width = 0; c.height = 0; } },
    });
    let blob;
    try { blob = f.pending ? await getBlob(f.id) : await backend.content(f.id, { inline: true }); } catch (e) { ui.clear(frame).append(h('p', { class: 'danger' }, errText(e))); return; }
    if (!blob) { ui.clear(frame).append(h('p', { class: 'muted' }, 'This file is no longer on this device.')); return; }
    ui.clear(frame);
    const url = () => { const u = URL.createObjectURL(f.mime && blob.type !== f.mime ? new Blob([blob], { type: f.mime }) : blob); urls.push(u); return u; };
    if (kind === 'image' && (SAFE_IMAGE.has(f.mime) || /heic|tiff/.test(f.mime))) {
      const img = h('img', { class: 'fl-preview-img', alt: f.name, src: url() });
      img.addEventListener('error', () => { img.replaceWith(noPreview(f, 'This photo type can’t be shown here.')); });
      frame.append(img);
    } else if (kind === 'video') {
      frame.append(h('video', { class: 'fl-preview-video', controls: true, playsinline: true, preload: 'metadata', src: url() }));
    } else if (kind === 'pdf') {
      await renderPdf(blob, frame, canvases, () => s.el.isConnected);
    } else if (kind === 'text' || kind === 'mail') {
      const text = await blob.slice(0, 256 * 1024).text();
      frame.append(h('pre', { class: 'fl-preview-text' }, text, blob.size > 256 * 1024 ? '\n…' : ''));
    } else {
      frame.append(noPreview(f));
    }
  }

  function noPreview(f, why) {
    const kind = fileKind(f);
    return h('div', { class: 'fl-nopreview' }, ui.icon(KIND_ICON[kind] || 'file-text', 32),
      h('p', null, why || (kind === 'office' ? 'Word, Excel and PowerPoint files open in their own apps. Download it to open it.' : kind === 'cad' ? 'Drawings (DWG/DXF) open in your CAD viewer. Download it to open it.' : 'There’s no preview for this kind of file. Download it to open it.')),
      ui.button('Download', { variant: 'primary', icon: 'download', onClick: () => downloadFile(f) }));
  }

  async function renderPdf(blob, host, canvases, open) {
    let lib, pdf;
    try {
      lib = await loadPdfJs();
      pdf = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false }).promise;
    } catch { host.append(h('p', { class: 'muted' }, 'This PDF can’t be shown here. Download it to open it.')); return; }
    const width = Math.min(1400, Math.max(320, (host.clientWidth || 800))) * Math.min(2, globalThis.devicePixelRatio || 1);
    let next = 1;
    const more = ui.button('Show more pages', { onClick: () => renderSome() });
    const pagesHost = h('div', { class: 'fl-pdf' });
    host.append(h('p', { class: 'muted fl-pdf-count' }, `${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'}`), pagesHost);
    async function renderSome(n = 5) {
      more.remove();
      for (let k = 0; k < n && next <= pdf.numPages; k++, next++) {
        if (!open()) break;
        const page = await pdf.getPage(next);
        const vp1 = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: Math.min(3, width / vp1.width) });
        const c = h('canvas', { class: 'fl-pdf-page', width: Math.round(vp.width), height: Math.round(vp.height), 'aria-label': `Page ${next}` });
        canvases.push(c);
        pagesHost.append(c);
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise.catch(() => {});
        page.cleanup();
      }
      if (next <= pdf.numPages && open()) host.append(more);
      else pdf.destroy().catch(() => {});
    }
    await renderSome(3);
  }

  // ---------- loading, queue, shares ----------
  async function reloadQueue() { queued = await queue.list().catch(() => []); }

  async function refresh({ quiet = false } = {}) {
    try {
      const d = await backend.load();
      if (!alive) return;
      data = d;
      cache = { db: store.dbName, data: d };
    } catch (e) {
      if (!quiet) ui.toast(errText(e), 'error', 5000);
      if (!data) data = { files: [], folders: [], usage: null, error: true };
    }
    await reloadQueue();
    if (alive) draw();
  }

  let flushing = false;
  async function flushQueue({ loud = false } = {}) {
    if (flushing || backend.kind !== 'server') return;
    flushing = true;
    try {
      const sent = await queue.flush(backend, (e, out) => {
        if (out.ok && out.result) {
          const entry = { key: `q${e.id}`, name: e.name, state: 'working', text: '' };
          describeResult(entry, out.file, out.result);
          tray.unshift(entry);
        } else if (out.ok) tray.unshift({ key: `q${e.id}`, name: e.name, state: 'filed', text: out.duplicate ? 'Already in Files' : `Uploaded to ${nameOfPlace(out.file)}` });
        else if (!out.offline) tray.unshift({ key: `q${e.id}`, name: e.name, state: 'failed', text: out.error?.message || 'Upload failed.' });
      });
      if (loud && !sent && queued.length) ui.toast('Still offline. The files will upload when the connection is back.', 'info', 4000);
    } finally { flushing = false; }
    await refresh({ quiet: true });
  }

  const onOnline = () => flushQueue();
  addEventListener('online', onOnline);
  offs.push(() => removeEventListener('online', onOnline));
  offs.push(onShared(() => openShared()));
  const onSkipped = (e) => { const n = e?.detail?.skipped?.length || 0; if (n) ui.toast(`${n} shared file${n === 1 ? ' was' : 's were'} too large or unreadable.`, 'warning', 5000); };
  addEventListener('ft:files-share-skipped', onSkipped);
  offs.push(() => removeEventListener('ft:files-share-skipped', onSkipped));
  offs.push(onJobFocus((jobId) => { if (jobId) go({ jobId }); }));
  const onStore = () => { if (alive && !document.querySelector('.sheet, .dialog')) draw(); };
  offs.push(store.on('clients', onStore));
  offs.push(store.on('jobs', onStore));

  draw();
  refresh().then(async () => {
    if (!alive) return;
    if (queued.some((q) => q.status === 'queued') && navigator.onLine !== false) flushQueue();
    if (ctx.query.shared || (await countShared())) openShared();
  });

  return () => {
    alive = false;
    for (const off of offs) { try { off?.(); } catch { /* ignore */ } }
    io?.disconnect();
    for (const u of thumbs.values()) URL.revokeObjectURL(u);
  };
}

export { CATEGORIES, COMPANY_CATEGORIES, categoryOf };
