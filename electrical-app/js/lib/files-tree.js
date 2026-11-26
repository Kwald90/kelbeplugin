// Files (#/files): the folder tree the browser shows, built from the file and folder rows (server or
// this device) plus the company's customers and jobs. Pure, no DOM, so it is unit-tested
// (tests/files.test.mjs). The layout rules are in files-classify.js.
//
// A location (`loc`) is what the address bar holds:
//   {}                               the top: Inbox, Company files, every customer, Recently deleted
//   { at: 'inbox' }                  everything waiting to be sorted
//   { at: 'company', cat? }          the company area, or one of its folders
//   { at: 'nocustomer' }             jobs that have no customer
//   { at: 'trash' }                  Recently deleted
//   { clientId, cat? }               a customer: its jobs and its standard folders
//   { jobId, cat? }                  a job: its standard folders
//   { folderId }                     a folder someone made (it carries its own place)
import { CATEGORIES, COMPANY_CATEGORIES, MONEY_CATEGORIES, categoryLabel, categoryOf, isCompanyCategory } from './files-classify.js';

export const AREAS = ['inbox', 'company', 'nocustomer', 'trash'];
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const okId = (v) => (typeof v === 'string' && ID.test(v) ? v : null);

/** Read a location from the route query (#/files?j=job-1&cat=permits). Anything odd is ignored. */
export function parseLoc(q = {}) {
  const loc = {};
  if (AREAS.includes(q.at)) loc.at = q.at;
  if (okId(q.f)) return { folderId: q.f };
  if (okId(q.j)) loc.jobId = q.j;
  else if (okId(q.c)) loc.clientId = q.c;
  if (q.cat && categoryOf(q.cat)) {
    const company = isCompanyCategory(q.cat);
    if (company && (loc.at === 'company')) loc.cat = q.cat;
    else if (!company && (loc.jobId || loc.clientId)) loc.cat = q.cat;
  }
  if (loc.jobId || loc.clientId) delete loc.at;
  return loc;
}

/** The query string for a location ('' for the top). */
export function locQuery(loc = {}) {
  const p = new URLSearchParams();
  if (loc.folderId) p.set('f', loc.folderId);
  else {
    if (loc.at) p.set('at', loc.at);
    if (loc.jobId) p.set('j', loc.jobId);
    else if (loc.clientId) p.set('c', loc.clientId);
    if (loc.cat) p.set('cat', loc.cat);
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}
export const locHref = (loc) => `#/files${locQuery(loc)}`;
export const sameLoc = (a, b) => locQuery(a) === locQuery(b);

/** Where an upload into this location goes: { clientId, jobId, category, folderId, company }. */
export function placeOf(loc = {}, data = {}) {
  if (loc.folderId) {
    const f = (data.folders || []).find((x) => x.id === loc.folderId);
    return { clientId: f?.clientId || null, jobId: f?.jobId || null, category: f?.category || null, folderId: loc.folderId, company: Boolean(f && !f.clientId && !f.jobId) };
  }
  if (loc.jobId) {
    const j = (data.jobs || []).find((x) => x.id === loc.jobId);
    return { clientId: j?.clientId || null, jobId: loc.jobId, category: loc.cat || null, folderId: null, company: false };
  }
  if (loc.clientId) return { clientId: loc.clientId, jobId: null, category: loc.cat || null, folderId: null, company: false };
  if (loc.at === 'company') return { clientId: null, jobId: null, category: loc.cat || null, folderId: null, company: true };
  return { clientId: null, jobId: null, category: null, folderId: null, company: false }; // Inbox
}

/** Is a file waiting to be sorted? */
export const isUnsorted = (f) => !f.deletedAt && !f.category && !f.folderId;

/** The location a file sits in (for "Show in folder" and paths). */
export function locOfFile(f) {
  if (f.folderId) return { folderId: f.folderId };
  if (!f.category) return { at: 'inbox' };
  if (f.jobId) return { jobId: f.jobId, cat: f.category };
  if (f.clientId) return { clientId: f.clientId, cat: f.category };
  return { at: 'company', cat: f.category };
}

/** Does a file sit directly in this location (not in a sub-folder)? */
export function fileInLoc(f, loc) {
  if (f.deletedAt) return loc.at === 'trash';
  if (loc.at === 'trash') return false;
  if (loc.folderId) return f.folderId === loc.folderId;
  if (f.folderId) return false;
  if (loc.at === 'inbox') return !f.category;
  if (!f.category) {
    // Unsorted files also show at the customer or job they were dropped on, marked "needs sorting".
    if (loc.jobId && !loc.cat) return f.jobId === loc.jobId;
    if (loc.clientId && !loc.cat) return f.clientId === loc.clientId && !f.jobId;
    return false;
  }
  if (loc.jobId) return Boolean(loc.cat) && f.jobId === loc.jobId && f.category === loc.cat;
  if (loc.clientId) return Boolean(loc.cat) && f.clientId === loc.clientId && !f.jobId && f.category === loc.cat;
  if (loc.at === 'company') return Boolean(loc.cat) && !f.clientId && !f.jobId && f.category === loc.cat;
  return false;
}

/** Folders people made that sit directly in this location. */
export function foldersInLoc(folders, loc) {
  if (loc.at === 'trash' || loc.at === 'inbox' || loc.at === 'nocustomer') return [];
  if (loc.folderId) return folders.filter((f) => f.parentId === loc.folderId);
  return folders.filter((f) => !f.parentId && (
    loc.jobId ? f.jobId === loc.jobId && (f.category || null) === (loc.cat || null)
      : loc.clientId ? f.clientId === loc.clientId && !f.jobId && (f.category || null) === (loc.cat || null)
        : loc.at === 'company' ? !f.clientId && !f.jobId && (f.category || null) === (loc.cat || null)
          : false));
}

/**
 * Counts for folder tiles: live files under each customer, job, standard folder, made folder, the
 * company area, the Inbox and Recently deleted.
 */
export function countIndex(files, folders = []) {
  const n = new Map();
  const add = (k) => n.set(k, (n.get(k) || 0) + 1);
  const parent = new Map(folders.map((f) => [f.id, f.parentId || null]));
  for (const f of files) {
    if (f.deletedAt) { add('trash'); continue; }
    if (!f.category && !f.folderId) add('inbox');
    if (f.jobId) add(`j:${f.jobId}`);
    if (f.clientId) add(`c:${f.clientId}`);
    if (!f.clientId && !f.jobId && (f.category || f.folderId)) add('company');
    if (f.category) {
      if (f.jobId) add(`j:${f.jobId}:${f.category}`);
      else if (f.clientId) add(`c:${f.clientId}:${f.category}`);
      else add(`co:${f.category}`);
    }
    for (let id = f.folderId, guard = 0; id && guard < 50; id = parent.get(id), guard++) add(`f:${id}`);
  }
  return (key) => n.get(key) || 0;
}

/** Standard folders for a place, minus the money ones for people who don't see prices. */
export function visibleCategories({ company = false, money = true } = {}) {
  return (company ? COMPANY_CATEGORIES : CATEGORIES).filter((c) => money || !MONEY_CATEGORIES.includes(c.id));
}

const OPEN = (j) => !['complete', 'invoiced', 'cancelled', 'archived', 'lost'].includes(j?.status);
export const jobLabel = (j) => (j ? [j.number, j.title].filter(Boolean).join(' · ') || 'Job' : 'Job');
const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base', numeric: true });

/** A customer's jobs: open ones first (newest number first), then closed. */
export function jobsOf(jobs, clientId) {
  return jobs.filter((j) => (clientId ? j.clientId === clientId : !j.clientId))
    .sort((a, b) => (OPEN(b) - OPEN(a)) || String(b.number || '').localeCompare(String(a.number || ''), undefined, { numeric: true }) || String(a.title || '').localeCompare(String(b.title || '')));
}

/**
 * The folder tiles for a location, in display order. `rank(list, items, idOf)` puts the most used
 * first (lib/usage-rank.js rankByUse); without it the natural order stays.
 * Each tile: { key, kind, label, sub, icon, loc, count, place }.
 */
export function folderTiles(loc, data, { money = true, companyFiles = true, rank = (l, items) => items } = {}) {
  const { clients = [], jobs = [], folders = [] } = data;
  const count = data.count || countIndex(data.files || [], folders);
  const made = (list) => [...list].sort(byName).map((f) => ({
    key: `f:${f.id}`, kind: 'folder', label: f.name, icon: 'folder', loc: { folderId: f.id }, count: count(`f:${f.id}`),
    place: { clientId: f.clientId || null, jobId: f.jobId || null, category: f.category || null, folderId: f.id }, folder: f,
  }));
  const cats = (base, keyOf, place, company = false) => visibleCategories({ company, money }).map((c) => ({
    key: keyOf(c.id), kind: 'category', label: c.label, icon: c.icon, loc: { ...base, cat: c.id }, count: count(keyOf(c.id)), place: { ...place, category: c.id },
  }));
  if (loc.at === 'trash' || loc.at === 'inbox') return [];
  if (loc.folderId) return made(foldersInLoc(folders, loc));
  if (loc.at === 'nocustomer') {
    return rank('files.jobs', jobsOf(jobs, null), (j) => j.id).map((j) => ({
      key: `j:${j.id}`, kind: 'job', label: jobLabel(j), sub: OPEN(j) ? '' : 'closed', icon: 'briefcase', loc: { jobId: j.id }, count: count(`j:${j.id}`), place: { clientId: null, jobId: j.id, category: null },
    }));
  }
  if (loc.at === 'company') {
    if (loc.cat) return made(foldersInLoc(folders, loc));
    return [...made(foldersInLoc(folders, loc)), ...cats({ at: 'company' }, (id) => `co:${id}`, { clientId: null, jobId: null }, true)];
  }
  if (loc.jobId) {
    if (loc.cat) return made(foldersInLoc(folders, loc));
    const j = jobs.find((x) => x.id === loc.jobId);
    return [...made(foldersInLoc(folders, loc)), ...cats({ jobId: loc.jobId }, (id) => `j:${loc.jobId}:${id}`, { clientId: j?.clientId || null, jobId: loc.jobId })];
  }
  if (loc.clientId) {
    if (loc.cat) return made(foldersInLoc(folders, loc));
    const jobTiles = rank('files.jobs', jobsOf(jobs, loc.clientId), (j) => j.id).map((j) => ({
      key: `j:${j.id}`, kind: 'job', label: jobLabel(j), sub: OPEN(j) ? (j.address || '') : 'closed', icon: 'briefcase', loc: { jobId: j.id }, count: count(`j:${j.id}`),
      place: { clientId: loc.clientId, jobId: j.id, category: null },
    }));
    return [...jobTiles, ...made(foldersInLoc(folders, loc)), ...cats({ clientId: loc.clientId }, (id) => `c:${loc.clientId}:${id}`, { clientId: loc.clientId, jobId: null })];
  }
  // The top: Inbox, Company files, customers (most used first, then A–Z), jobs without a customer.
  const top = [{ key: 'inbox', kind: 'inbox', label: 'Inbox · needs sorting', icon: 'download', loc: { at: 'inbox' }, count: count('inbox'), place: { clientId: null, jobId: null, category: null } }];
  if (companyFiles) top.push({ key: 'company', kind: 'company', label: 'Company files', sub: 'Insurance, licences, safety, vehicles…', icon: 'briefcase', loc: { at: 'company' }, count: count('company'), place: { clientId: null, jobId: null, category: null, company: true } });
  const customers = rank('files.clients', [...clients].sort(byName), (c) => c.id).map((c) => {
    const open = jobs.filter((j) => j.clientId === c.id && OPEN(j)).length;
    return { key: `c:${c.id}`, kind: 'client', label: c.name || 'Customer', sub: open ? `${open} open job${open === 1 ? '' : 's'}` : '', icon: 'user', loc: { clientId: c.id }, count: count(`c:${c.id}`), place: { clientId: c.id, jobId: null, category: null } };
  });
  const orphans = jobs.filter((j) => !j.clientId).length;
  return [...top, ...customers, ...(orphans ? [{ key: 'nocustomer', kind: 'area', label: 'Jobs with no customer', icon: 'briefcase', loc: { at: 'nocustomer' }, count: orphans, place: null }] : [])];
}

/** Breadcrumbs: [{ label, loc }], the first is always Files. */
export function crumbs(loc, { clients = [], jobs = [], folders = [] } = {}) {
  const out = [{ label: 'Files', loc: {} }];
  const client = (id) => clients.find((c) => c.id === id);
  const job = (id) => jobs.find((j) => j.id === id);
  const placeCrumbs = ({ clientId, jobId, cat, company }) => {
    if (company) out.push({ label: 'Company files', loc: { at: 'company' } });
    const j = jobId ? job(jobId) : null;
    const cid = clientId || j?.clientId;
    if (cid) out.push({ label: client(cid)?.name || 'Customer', loc: { clientId: cid } });
    else if (jobId) out.push({ label: 'Jobs with no customer', loc: { at: 'nocustomer' } });
    if (jobId) out.push({ label: jobLabel(j), loc: { jobId } });
    if (cat) out.push({ label: categoryLabel(cat), loc: jobId ? { jobId, cat } : cid ? { clientId: cid, cat } : { at: 'company', cat } });
  };
  if (loc.folderId) {
    const chain = [];
    const byId = new Map(folders.map((f) => [f.id, f]));
    for (let f = byId.get(loc.folderId), guard = 0; f && guard < 50; f = f.parentId ? byId.get(f.parentId) : null, guard++) chain.unshift(f);
    const root = chain[0];
    if (root) placeCrumbs({ clientId: root.clientId, jobId: root.jobId, cat: root.category, company: !root.clientId && !root.jobId });
    for (const f of chain) out.push({ label: f.name, loc: { folderId: f.id } });
    return out;
  }
  if (loc.at === 'inbox') out.push({ label: 'Inbox · needs sorting', loc: { at: 'inbox' } });
  else if (loc.at === 'trash') out.push({ label: 'Recently deleted', loc: { at: 'trash' } });
  else if (loc.at === 'nocustomer') out.push({ label: 'Jobs with no customer', loc: { at: 'nocustomer' } });
  else if (loc.at === 'company') placeCrumbs({ cat: loc.cat, company: true });
  else if (loc.jobId || loc.clientId) placeCrumbs({ clientId: loc.clientId, jobId: loc.jobId, cat: loc.cat });
  return out;
}

/** "Jane Smith › J-1001 · Kitchen › Permits & inspections" for a file or a place. */
export function placeLabel(place, data = {}) {
  if (!place) return '';
  if (!place.category && !place.folderId) {
    const who = place.jobId ? jobLabel((data.jobs || []).find((j) => j.id === place.jobId)) : place.clientId ? (data.clients || []).find((c) => c.id === place.clientId)?.name : '';
    return who ? `Inbox (${who})` : 'Inbox';
  }
  const c = crumbs(place.folderId ? { folderId: place.folderId } : locOfFile(place), data).slice(1);
  return c.map((x) => x.label).join(' › ');
}

/** The file's kind, for icons and previews: pdf | image | video | audio | text | office | cad | mail | archive | other. */
export function fileKind(f) {
  const m = String(f?.mime || ''), e = String(f?.ext || '').toLowerCase() || String(f?.name || '').split('.').pop().toLowerCase();
  if (m === 'application/pdf' || e === 'pdf') return 'pdf';
  if (m.startsWith('image/vnd.') || ['dwg', 'dxf'].includes(e)) return 'cad';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'message/rfc822' || ['eml', 'msg'].includes(e)) return 'mail';
  if (m.startsWith('text/') || ['txt', 'csv', 'md', 'json', 'rtf'].includes(e)) return 'text';
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'pages', 'numbers', 'key'].includes(e) || /officedocument|msword|ms-excel|ms-powerpoint|opendocument/.test(m)) return 'office';
  if (m === 'application/zip' || e === 'zip') return 'archive';
  return 'other';
}

/** Kinds the app previews itself; the rest download (or open in the iOS share sheet). */
export const PREVIEWABLE = new Set(['pdf', 'image', 'video', 'text']);
/** Image types every browser draws; HEIC and TIFF only on Safari, so they get a download fallback. */
export const SAFE_IMAGE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** Search across names, the extracted text and the customer/job/folder path. */
export function searchFiles(files, query, data = {}) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return files.filter((f) => {
    if (f.deletedAt) return false;
    const hay = `${f.name} ${f.originalName || ''} ${f.text || ''} ${placeLabel(f, data)}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Sort keys for the file list. Folders always stay above files. */
export const SORTS = [
  { id: 'date', label: 'Newest first', cmp: (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) },
  { id: 'name', label: 'Name A–Z', cmp: (a, b) => byName(a, b) },
  { id: 'size', label: 'Largest first', cmp: (a, b) => (b.bytes || 0) - (a.bytes || 0) },
  { id: 'type', label: 'Type', cmp: (a, b) => fileKind(a).localeCompare(fileKind(b)) || byName(a, b) },
];
export function sortFiles(files, sortId = 'date') {
  const s = SORTS.find((x) => x.id === sortId) || SORTS[0];
  return [...files].sort((a, b) => s.cmp(a, b) || String(a.id).localeCompare(String(b.id)));
}

/** "820 KB", "12.4 MB" */
export function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(b / 1024 ** 3).toFixed(1)} GB`;
}

/** The location to open first: the focused job's folder when a job is focused and nothing else was asked for. */
export function startLoc(query, focusJobId) {
  const loc = parseLoc(query);
  const asked = Object.keys(query || {}).some((k) => ['at', 'c', 'j', 'f', 'cat', 'top'].includes(k));
  if (!asked && focusJobId) return { jobId: focusJobId };
  return loc;
}

/** May a file or folder be moved/dropped into a place? (Company folders take company files only.) */
export function canDropInto(place) {
  if (!place) return false;
  if (place.company && place.category && !isCompanyCategory(place.category)) return false;
  return true;
}
