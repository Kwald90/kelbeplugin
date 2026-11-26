// Files (#/files): the folder layout and the deterministic "rules" classifier. Pure, no DOM: shared by
// the PWA (offline / demo filing, previews of what will happen) and the server (the fallback when no
// AI key is configured or the AI call fails: server/src/services/files-ai.js).
//
// Layout (a file's place is { clientId, jobId, category, folderId }):
//   Inbox · needs sorting        category null and folderId null (optionally already tied to a customer/job)
//   Company files › <company category>            clientId null, jobId null
//   <Customer> › <category>                        clientId, no jobId (customer-level papers)
//   <Customer> › <Job> › <category>                jobId (and the job's clientId)
//   …any of those › <custom folder> › …            folderId (folders carry the same place fields)
//
// The classifier reads the file name, its type and the first few thousand characters of text, and the
// customer's jobs (number, title, address). It returns a place, a 0–1 confidence, a reason a person can
// read and a clean file name. Callers file automatically at AUTO_FILE_CONFIDENCE and above; anything
// lower stays in the Inbox with the suggestion shown.

/** Standard subfolders of every customer and every job. Order is the display order. */
export const CATEGORIES = [
  { id: 'plans', label: 'Plans & drawings', noun: 'Drawing', icon: 'layers' },
  { id: 'permits', label: 'Permits & inspections', noun: 'Permit', icon: 'shield-check' },
  { id: 'quotes', label: 'Quotes & estimates', noun: 'Quote', icon: 'file-text', money: true },
  { id: 'invoices', label: 'Invoices & bills', noun: 'Invoice', icon: 'receipt', money: true },
  { id: 'photos', label: 'Photos', noun: 'Photo', icon: 'image' },
  { id: 'specs', label: 'Specs & submittals', noun: 'Spec sheet', icon: 'book' },
  { id: 'contracts', label: 'Contracts', noun: 'Contract', icon: 'pen', money: true },
  { id: 'correspondence', label: 'Correspondence', noun: 'Letter', icon: 'mail' },
  { id: 'other', label: 'Other', noun: 'Document', icon: 'box' },
];

/** Subfolders of the company-level area (files that are not a customer's). */
export const COMPANY_CATEGORIES = [
  { id: 'co-insurance', label: 'Insurance & WSIB', noun: 'Insurance', icon: 'shield-check' },
  { id: 'co-licences', label: 'Licences & certificates', noun: 'Certificate', icon: 'id-card' },
  { id: 'co-safety', label: 'Safety', noun: 'Safety document', icon: 'alert' },
  { id: 'co-vehicles', label: 'Vehicles & equipment', noun: 'Vehicle document', icon: 'truck' },
  { id: 'co-suppliers', label: 'Suppliers & price lists', noun: 'Supplier document', icon: 'box' },
  { id: 'co-templates', label: 'Templates & forms', noun: 'Form', icon: 'copy' },
  { id: 'co-other', label: 'Other', noun: 'Document', icon: 'box' },
];

export const ALL_CATEGORIES = [...CATEGORIES, ...COMPANY_CATEGORIES];
export const CATEGORY_IDS = ALL_CATEGORIES.map((c) => c.id);
const BY_ID = Object.fromEntries(ALL_CATEGORIES.map((c) => [c.id, c]));
export const categoryOf = (id) => BY_ID[id] || null;
export const categoryLabel = (id) => BY_ID[id]?.label || 'Inbox';
export const isCompanyCategory = (id) => String(id || '').startsWith('co-');
/** Categories that hold prices (quotes, invoices, contracts): only people who may see money open them. */
export const MONEY_CATEGORIES = CATEGORIES.filter((c) => c.money).map((c) => c.id);

/** At or above this confidence a file is filed automatically; below it waits in the Inbox. */
export const AUTO_FILE_CONFIDENCE = 0.6;
/** Characters of extracted text sent to the classifier (client and server agree). */
export const TEXT_LIMIT = 6000;
export const NAME_MAX = 160;

// ---- keywords -----------------------------------------------------------------------------------
// Lower-case phrases. A hit in the file name counts 3, in the text 1 (each phrase at most 3 times).

const KEYWORDS = {
  plans: ['plan', 'plans', 'drawing', 'drawings', 'dwg', 'dxf', 'blueprint', 'elevation', 'layout', 'single line', 'single-line', 'one-line', 'sld', 'schematic', 'riser', 'floor plan', 'site plan', 'as-built', 'as built', 'asbuilt', 'reflected ceiling', 'rcp', 'lighting plan', 'power plan', 'sheet', 'issued for construction', 'ifc', 'markup', 'redline', 'takeoff'],
  permits: ['permit', 'inspection', 'inspector', 'esa', 'electrical safety authority', 'notification', 'technical safety bc', 'tsbc', 'safety codes', 'defect notice', 'deficiency', 'certificate of inspection', 'certificate of acceptance', 'connection authorization', 'authorization to connect', 'wiring permit', 'electrical permit', 'rough-in', 'final inspection', 'inspection report', 'permit number', 'municipal'],
  quotes: ['quote', 'quotation', 'estimate', 'proposal', 'bid', 'tender', 'pricing', 'budget', 'rfq', 'request for quotation', 'scope and price', 'cost breakdown'],
  invoices: ['invoice', 'inv', 'bill', 'receipt', 'statement', 'payment', 'paid', 'amount due', 'balance due', 'total due', 'remit', 'remittance', 'purchase order', 'po number', 'packing slip', 'credit memo', 'gst/hst', 'hst #', 'gst #'],
  photos: ['photo', 'photos', 'pic', 'picture', 'img', 'image', 'snapshot'],
  specs: ['spec', 'specs', 'specification', 'specifications', 'submittal', 'data sheet', 'datasheet', 'cut sheet', 'cutsheet', 'product data', 'manual', 'installation instructions', 'install guide', 'shop drawing', 'o&m', 'operation and maintenance', 'warranty', 'catalog', 'catalogue', 'brochure', 'technical data'],
  contracts: ['contract', 'agreement', 'subcontract', 'terms and conditions', 'signed', 'signature', 'change order', 'ccdc', 'scope of work', 'lien', 'holdback', 'waiver', 'purchase agreement', 'letter of intent', 'notice to proceed'],
  correspondence: ['email', 'e-mail', 'letter', 'memo', 'message', 'meeting minutes', 'minutes', 'notes', 'dear', 'subject:', 'from:', 'sent:', 'regards', 'sincerely'],
  'co-insurance': ['insurance', 'liability', 'coi', 'certificate of insurance', 'wsib', 'wcb', 'worksafe', 'worksafebc', 'clearance', 'policy', 'bond', 'bonding', 'premium'],
  'co-licences': ['licence', 'license', 'certificate', 'certification', 'master electrician', 'journeyman', 'red seal', 'training', 'course', 'cor', 'ticket', 'registration of contractor', 'ecra'],
  'co-safety': ['safety', 'hazard', 'flha', 'toolbox', 'incident', 'sds', 'msds', 'whmis', 'ppe', 'safety manual', 'lockout', 'arc flash', 'fall protection'],
  'co-vehicles': ['vehicle', 'truck', 'van', 'registration', 'ownership', 'lease', 'equipment', 'maintenance', 'mileage', 'plate', 'oil change', 'tire', 'service record'],
  'co-suppliers': ['supplier', 'vendor', 'price list', 'pricelist', 'catalog', 'account application', 'credit application', 'westburne', 'eecol', 'nedco', 'gescan', 'wesco', 'rexel', 'guillevin', 'graybar', 'home depot', 'lowes', 'anixter'],
  'co-templates': ['template', 'form', 'blank', 'checklist', 'letterhead', 'logo', 'boilerplate'],
};

const DOC_EXT = new Set(['pdf', 'doc', 'docx', 'rtf', 'txt', 'odt', 'pages']);
const SHEET_EXT = new Set(['xls', 'xlsx', 'csv', 'ods', 'numbers']);
const MAIL_EXT = new Set(['eml', 'msg']);
const CAD_EXT = new Set(['dwg', 'dxf', 'dwf', 'rvt']);

/** 'Smith Reno.PDF' -> 'pdf' */
export function extOf(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}
export function stemOf(name) {
  const s = String(name || '');
  const e = extOf(s);
  return e ? s.slice(0, -(e.length + 1)) : s;
}

/** Lower-case, accents folded, punctuation turned to spaces, so phrase search is simple. */
export function norm(s) {
  return ` ${String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[_./\\|,;()[\]{}"'`!?<>*+=~^]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

/** How often (at most `cap`) `phrase` occurs as whole words in a norm()-ed string. */
function hits(hay, phrase, cap = 3) {
  const p = norm(phrase).trim();
  if (!p) return 0;
  let n = 0, i = 0;
  const needle = ` ${p} `;
  while (n < cap && (i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length - 1; }
  return n;
}

function isImage(mime, ext) { return /^image\//.test(mime || '') || ['jpg', 'jpeg', 'png', 'heic', 'heif', 'gif', 'webp', 'tif', 'tiff', 'bmp'].includes(ext); }
function isVideo(mime, ext) { return /^video\//.test(mime || '') || ['mp4', 'mov', 'm4v', 'webm', 'avi'].includes(ext); }

/**
 * Category scores for a file. `company` scores the company-level categories instead of the customer ones.
 * @returns {{ id: string, score: number, why: string[] }[]} highest first
 */
export function categoryScores({ name = '', mime = '', text = '' } = {}, { company = false } = {}) {
  const ext = extOf(name);
  const n = norm(cleanStem(stemOf(name)));
  const t = norm(String(text || '').slice(0, TEXT_LIMIT));
  const list = company ? COMPANY_CATEGORIES : CATEGORIES;
  const out = list.map((c) => ({ id: c.id, score: 0, why: [] }));
  const get = (id) => out.find((o) => o.id === id);
  for (const o of out) {
    for (const k of KEYWORDS[o.id] || []) {
      const a = hits(n, k), b = hits(t, k);
      if (a || b) { o.score += a * 3 + b; if (o.why.length < 3) o.why.push(k); }
    }
  }
  if (!company) {
    // Sheet numbers like E-1.0, E2.01, A101 point at drawings.
    if (/\b[ae]-?\d{1,3}(\.\d{1,2})?\b/i.test(stemOf(name))) { get('plans').score += 3; get('plans').why.push('sheet number'); }
    if (CAD_EXT.has(ext)) { get('plans').score += 8; get('plans').why.push(`.${ext} drawing`); }
    if (MAIL_EXT.has(ext)) { get('correspondence').score += 8; get('correspondence').why.push('saved email'); }
    if (isVideo(mime, ext)) { get('photos').score += 8; get('photos').why.push('video'); }
    else if (isImage(mime, ext)) {
      // A photo of a permit or a plan is still that document; plain photos go to Photos.
      const best = Math.max(...out.filter((o) => o.id !== 'photos').map((o) => o.score));
      get('photos').score += best >= 6 ? 2 : 6;
      get('photos').why.push('image');
    }
    if (SHEET_EXT.has(ext) && get('quotes').score + get('invoices').score === 0) get('quotes').score += 1;
  } else if (isImage(mime, ext) || isVideo(mime, ext)) {
    get('co-other').score += 1;
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Pick the category: { category, confidence, why }. */
export function pickCategory(file, { company = false } = {}) {
  const s = categoryScores(file, { company });
  const top = s[0], second = s[1] || { score: 0 };
  const other = company ? 'co-other' : 'other';
  if (!top || top.score <= 0) return { category: other, confidence: 0.2, why: [] };
  const confidence = Math.max(0.3, Math.min(0.95, 0.4 + 0.08 * top.score - 0.08 * second.score));
  return { category: top.id, confidence: Math.round(confidence * 100) / 100, why: top.why };
}

// ---- customers and jobs --------------------------------------------------------------------------

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'job', 'jobs', 'project', 'reno', 'renovation', 'new', 'old', 'house', 'home', 'street', 'road', 'avenue', 'drive', 'unit', 'suite', 'inc', 'ltd', 'corp', 'electric', 'electrical', 'service', 'services', 'company', 'canada']);
const words = (s) => norm(s).trim().split(' ').filter((w) => w.length >= 4 && !STOP.has(w));
const digits = (s) => String(s || '').replace(/\D+/g, '');

/** The job's number as it may appear in a file name or text ("J-1001", "1001"). */
function numberHit(hay, number) {
  const num = String(number || '').trim();
  if (!num) return 0;
  if (hits(hay, num)) return 1;
  const d = digits(num);
  // A bare number counts only when it is long enough not to be a page number or a quantity.
  if (d.length >= 4 && new RegExp(`(^|\\D)${d}(\\D|$)`).test(hay)) return 1;
  return 0;
}

/** "12 Main St, Winnipeg" -> { num: '12', street: 'main' } */
function addressParts(address) {
  const m = /(\d{1,6})\s+([A-Za-z][A-Za-z'-]{2,})/.exec(String(address || ''));
  return m ? { num: m[1], street: m[2].toLowerCase() } : null;
}

/**
 * Score one job against a file: number 10, street number + street 6, street 2, title words 2 (name) / 1 (text).
 * @returns {{ score: number, why: string[] }}
 */
export function jobScore(job, { name = '', text = '' } = {}) {
  const n = norm(stemOf(name)), t = norm(String(text || '').slice(0, TEXT_LIMIT));
  let score = 0;
  const why = [];
  if (numberHit(n, job.number) || numberHit(t, job.number)) { score += 10; why.push(`job number ${job.number}`); }
  const a = addressParts(job.address);
  if (a) {
    const both = (h) => hits(h, `${a.num} ${a.street}`) > 0;
    if (both(n) || both(t)) { score += 6; why.push(`address ${a.num} ${a.street}`); }
    else if (a.street.length >= 4 && !STOP.has(a.street) && (hits(n, a.street) || hits(t, a.street))) { score += 2; why.push(`street ${a.street}`); }
  }
  let titleScore = 0;
  for (const w of new Set(words(job.title))) {
    if (hits(n, w)) titleScore += 2; else if (hits(t, w)) titleScore += 1;
  }
  if (titleScore) { score += Math.min(6, titleScore); why.push('job title'); }
  return { score, why };
}

/** Score a customer by name (whole name 6, name words 2 / 1). */
export function clientScore(client, { name = '', text = '' } = {}) {
  const n = norm(stemOf(name)), t = norm(String(text || '').slice(0, TEXT_LIMIT));
  const full = String(client?.name || '').trim();
  if (!full) return { score: 0, why: [] };
  if (hits(n, full) || hits(t, full)) return { score: 6, why: [`customer ${full}`] };
  let s = 0;
  for (const w of new Set(words(full))) { if (hits(n, w)) s += 2; else if (hits(t, w)) s += 1; }
  return { score: Math.min(5, s), why: s ? [`customer ${full}`] : [] };
}

const OPEN = (j) => !['complete', 'invoiced', 'cancelled', 'archived', 'lost'].includes(j?.status);

/**
 * Decide the customer and job. `fixed` holds what the person already chose by where they dropped
 * the file ({ clientId?, jobId? }): those are never changed.
 * @returns {{ clientId: string|null, jobId: string|null, confidence: number, why: string[] }}
 */
export function pickJob(file, { clients = [], jobs = [], fixed = {} } = {}) {
  if (fixed.jobId) {
    const j = jobs.find((x) => x.id === fixed.jobId);
    return { clientId: j?.clientId || fixed.clientId || null, jobId: fixed.jobId, confidence: 1, why: [] };
  }
  let pool = jobs;
  let clientId = fixed.clientId || null;
  let clientConf = clientId ? 1 : 0;
  const why = [];
  if (!clientId) {
    // Inbox: find the customer first (by name, or through a job that matches strongly).
    const ranked = clients.map((c) => ({ c, ...clientScore(c, file) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
    const viaJob = jobs.map((j) => ({ j, ...jobScore(j, file) })).filter((x) => x.score >= 6).sort((a, b) => b.score - a.score)[0];
    if (viaJob && viaJob.j.clientId && (!ranked[0] || viaJob.score >= 10 || ranked[0].c.id === viaJob.j.clientId)) {
      clientId = viaJob.j.clientId; clientConf = viaJob.score >= 10 ? 0.85 : 0.7; why.push(...viaJob.why);
    } else if (ranked[0] && ranked[0].score >= 4 && (!ranked[1] || ranked[0].score > ranked[1].score)) {
      clientId = ranked[0].c.id; clientConf = ranked[0].score >= 6 ? 0.8 : 0.6; why.push(...ranked[0].why);
    }
    if (!clientId) return { clientId: null, jobId: null, confidence: 0.2, why: [] };
  }
  pool = jobs.filter((j) => j.clientId === clientId);
  const scored = pool.map((j) => ({ j, ...jobScore(j, file) })).sort((a, b) => b.score - a.score);
  const top = scored[0], second = scored[1];
  let jobId = null, jobConf = 1;
  if (top && top.score >= 6 && (!second || top.score > second.score)) {
    jobId = top.j.id; jobConf = top.score >= 10 ? 0.9 : 0.75; why.push(...top.why.filter((w) => !why.includes(w)));
  } else if (top && top.score >= 2 && (!second || top.score >= second.score + 2)) {
    jobId = top.j.id; jobConf = 0.65; why.push(...top.why.filter((w) => !why.includes(w)));
  } else {
    const open = pool.filter(OPEN);
    if (open.length === 1) { jobId = open[0].id; jobConf = 0.7; why.push('their only open job'); }
    // Several jobs and no clue which: file it at the customer level rather than guess.
  }
  return { clientId, jobId, confidence: Math.round(Math.min(clientConf, jobConf) * 100) / 100, why };
}

// ---- names ---------------------------------------------------------------------------------------

const JUNK_STEM = /^(?:img|image|dsc|dscn|dscf|dcim|pxl|photo|pic|scan|scanned|scan_?doc|doc|document|file|untitled|attachment|download|new document|cam|camera|screenshot|screen shot|whatsapp image|whatsapp|signal|mms|received|temp|tmp|output|print)?[\s_.-]*[\d\s_:.()-]*(?:at[\s\d_:.-]*(?:am|pm)?)?$/i;

/** Remove forwarding prefixes, copies and separators: 'FW_ Copy of Permit__final (2)' -> 'Permit final'. */
export function cleanStem(stem) {
  let s = String(stem || '').normalize('NFC');
  s = s.replace(/[\u0000-\u001f\u007f]+/g, ' ');
  for (let i = 0; i < 3; i++) s = s.replace(/^\s*(?:fw|fwd|re|copy of)\s*[:_-]?\s*/i, '');
  s = s.replace(/[_]+/g, ' ').replace(/\s*\((?:\d{1,3}|copy)\)\s*$/i, '').replace(/\s+-\s*copy$/i, '').replace(/[\\/:*?"<>|]+/g, '-');
  s = s.replace(/\s{2,}/g, ' ').replace(/^[\s.-]+|[\s.-]+$/g, '');
  return s;
}

/** Is a stem meaningless ("IMG_2034", "scan0001", "Document (3)", a long hex id)? */
export function isJunkStem(stem) {
  const s = String(stem || '').trim();
  if (!s) return true;
  if (/^[a-f0-9-]{16,}$/i.test(s)) return true;
  return JUNK_STEM.test(s);
}

/**
 * A safe stored name: the person's own name, minus path separators, characters file systems refuse and
 * control characters, with no leading dots, at most NAME_MAX characters, extension kept. (Tidying the
 * wording is suggestName's job, offered rather than imposed.)
 */
export function safeName(name, fallback = 'File') {
  const ext = extOf(name);
  let stem = String(stemOf(name) || '').normalize('NFC').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s{2,}/g, ' ').replace(/^[\s.-]+|[\s.]+$/g, '');
  stem = stem.slice(0, NAME_MAX - (ext ? ext.length + 1 : 0)).trim();
  if (!stem) stem = fallback;
  return ext ? `${stem}.${ext}` : stem;
}

/**
 * A clean name for a filed document. Meaningful names are tidied; junk ones ("IMG_2034.jpg") become
 * "2026-11-25 Photo J-1001 Smith reno.jpg".
 * @param {{ name: string, category?: string|null, job?: object|null, client?: object|null, date?: string }} o
 */
export function suggestName({ name, category, job = null, client = null, date = '' }) {
  const ext = extOf(name);
  const stem = cleanStem(stemOf(name));
  let out;
  if (!isJunkStem(stem)) out = stem;
  else {
    const noun = categoryOf(category)?.noun || 'Document';
    const who = job ? [job.number, job.title].filter(Boolean).join(' ') : (client?.name || '');
    out = [String(date || '').slice(0, 10), noun, who].filter(Boolean).join(' ');
  }
  return safeName(ext ? `${cleanStem(out)}.${ext}` : cleanStem(out));
}

// ---- the whole decision ------------------------------------------------------------------------

/**
 * The rules classifier. `fixed` is where the file was dropped: { clientId?, jobId?, category?, folderId? }.
 * Never moves a file out of what the person picked: a fixed category or folder is kept as is.
 * @returns {{ by: 'rules', clientId: string|null, jobId: string|null, category: string|null,
 *            confidence: number, reason: string, suggestedName: string }}
 */
export function rulesClassify(file, { clients = [], jobs = [], fixed = {}, date = '' } = {}) {
  const place = pickJob(file, { clients, jobs, fixed });
  const job = place.jobId ? jobs.find((j) => j.id === place.jobId) : null;
  const client = place.clientId ? clients.find((c) => c.id === place.clientId) : null;
  let category = fixed.category || null;
  let catConf = 1, catWhy = [];
  const companyLevel = !place.clientId && !place.jobId && Boolean(fixed.company);
  if (!category && !fixed.folderId) {
    const c = pickCategory(file, { company: companyLevel });
    category = c.category; catConf = c.confidence; catWhy = c.why;
  }
  // In the Inbox with no customer found: only company-level filing is possible, and only when asked.
  if (!place.clientId && !place.jobId && !companyLevel && !fixed.category && !fixed.folderId) {
    const c = pickCategory(file);
    return {
      by: 'rules', clientId: null, jobId: null, category: null, confidence: 0.2,
      reason: 'No customer or job in the name or text. Pick where it goes.',
      suggestedName: suggestName({ name: file.name, category: c.category, date }),
      suggestion: { clientId: null, jobId: null, category: c.category },
    };
  }
  const confidence = Math.round(Math.min(companyLevel ? 1 : place.confidence, catConf) * 100) / 100;
  const bits = [...place.why, ...catWhy.map((w) => `“${w}”`)];
  return {
    by: 'rules', clientId: place.clientId, jobId: place.jobId, category, confidence,
    reason: bits.length ? `Matched ${bits.slice(0, 4).join(', ')}.` : 'No strong clues; best guess from the file type.',
    suggestedName: suggestName({ name: file.name, category, job, client, date }),
  };
}

/** Should a result be filed without asking? */
export const autoFiles = (r) => Boolean(r && r.category && (r.confidence ?? 0) >= AUTO_FILE_CONFIDENCE);
