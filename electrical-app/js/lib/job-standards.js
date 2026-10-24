// Job standards: region-specific work-type playbooks built on top of SOPs (docs/releases/job-standards.md).
//
// A "job standard" is just an SOP with the new optional fields filled in (schema/sops.json): a jobType
// label, a region, a bill of materials, breakers & panel, wire/connection specs, and a task list, on top
// of the ordinary SOP steps and acknowledgement flow. Nothing here is a new collection.
//
// Everything in this file is pure and DOM-free: the builders turn a standard + a job into draft records
// (work tasks, material requests, a panel, a draft estimate), and `applyStandard` writes them through the
// store the caller passes in, so it works offline and syncs per company like any other write. The office-
// only pieces (material costs and the draft estimate) are gated on `auth.seesMoney()` by the caller and in
// applyStandard; the crew-safe pieces (material list, breakers, specs, steps, tasks) are not.
import { newTask } from './workplan.js';
import { newDocTax } from './tax.js';
import { listBreakerTemplates, listPanelTemplates, applyBreakerTemplate } from './panel-templates.js';

/** An SOP's document revision (same rule as modules/sops.js, kept local so this file imports no DOM). */
export const sopRev = (s) => s?.revision ?? 1;

/** A 2-letter province code, upper-cased and trimmed, or '' when empty. */
const prov = (p) => String(p ?? '').trim().toUpperCase().slice(0, 2);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Whether an SOP is a job standard: marked as one, or carrying a non-empty jobType. */
export function isStandard(sop) {
  return Boolean(sop && (sop.isStandard === true || (typeof sop.jobType === 'string' && sop.jobType.trim() !== '')));
}

/** The provinces a standard is tagged for (normalized), or [] = applies anywhere. */
export function standardProvinces(sop) {
  const list = Array.isArray(sop?.region?.provinces) ? sop.region.provinces : [];
  return list.map(prov).filter(Boolean);
}

/** The authority a standard is tagged for ('' = any). */
export function standardAuthority(sop) {
  return String(sop?.region?.authority ?? '').trim();
}

/**
 * Whether a standard applies in a province. An empty province list applies anywhere; a null/blank
 * `province` (the "All regions" filter) matches every standard.
 */
export function regionMatch(sop, province) {
  const want = prov(province);
  if (!want) return true;
  const ps = standardProvinces(sop);
  return ps.length === 0 || ps.includes(want);
}

/** The haystack a standard is searched over ("look up your job"): jobType, scale, title, specs, materials. */
function searchText(sop) {
  const specs = (sop.specs || []).map((s) => `${s?.label || ''} ${s?.value || ''}`).join(' ');
  const mats = (sop.materials || []).map((m) => m?.name || '').join(' ');
  return `${sop.jobType || ''} ${sop.scale || ''} ${sop.title || ''} ${sop.category || ''} ${specs} ${mats}`.toLowerCase();
}

/**
 * Standards from a list of SOPs, filtered by region and a search string, with a soft authority boost:
 * a standard whose authority matches `authority` sorts first, then by jobType/title. `province` null or ''
 * means all regions; `authority` is only a ranking hint, never a filter.
 */
export function filterStandards(sops, { province = null, authority = null, q = '' } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  const want = String(authority ?? '').trim();
  const rows = (sops || []).filter(isStandard)
    .filter((s) => regionMatch(s, province))
    .filter((s) => !needle || searchText(s).includes(needle));
  const label = (s) => (s.jobType || s.title || '').toLowerCase();
  return rows.sort((a, b) => {
    const am = want && standardAuthority(a) === want ? 0 : 1;
    const bm = want && standardAuthority(b) === want ? 0 : 1;
    return am - bm || label(a).localeCompare(label(b));
  });
}

/**
 * The region requirements to surface for a job in a province (and, when known, an authority): those
 * with no province (shown everywhere) plus those whose province matches. A requirement tied to another
 * authority is hidden only when the job's authority is known and differs.
 */
export function visibleRequirements(sop, { province = null, authority = null } = {}) {
  const wantP = prov(province);
  const wantA = String(authority ?? '').trim();
  return (sop?.regionRequirements || []).filter((r) => {
    const rp = prov(r?.province);
    if (rp && wantP && rp !== wantP) return false;
    const ra = String(r?.authority ?? '').trim();
    if (ra && wantA && ra !== wantA) return false;
    return Boolean(String(r?.text ?? '').trim());
  });
}

/** The seeding stamp every record carries so a re-apply can skip what is already there. */
export function stdRefOf(sop) {
  return { sopId: sop.id, rev: sopRev(sop) };
}

// ---------- pure builders (draft records, not yet written) ----------

/**
 * Draft work tasks from a standard's task list: one unassigned draft per `tasks[i]`, linked to the SOP
 * and stamped with `stdRef` for de-duplication. Returns `newTask`-shaped field objects.
 */
export function buildWorkTasks(sop, { jobId }) {
  const ref = stdRefOf(sop);
  return (sop.tasks || []).filter((t) => String(t?.title || '').trim()).map((t) => newTask({
    jobId,
    title: String(t.title).trim().slice(0, 300),
    phaseName: t.phaseName || '',
    taskType: t.taskType || '',
    estHours: num(t.estHours),
    qty: t.qty == null || t.qty === '' ? null : num(t.qty),
    unit: t.unit || '',
    requiresPhoto: Boolean(t.requiresPhoto),
    minPhotos: t.minPhotos || 1,
    priority: ['low', 'normal', 'high'].includes(t.priority) ? t.priority : 'normal',
    status: 'draft',
    link: { sopId: sop.id },
    stdRef: ref,
  }));
}

/**
 * Material requests / BOM from a standard's materials. `costCents` (office only) is set only when
 * `seesMoney` and the price-book item has a cost; otherwise it is left off (and the server strips it
 * for crew anyway). The description falls back to the item name, then the typed name.
 */
export function buildMaterialRequests(sop, { jobId, items = [], seesMoney = false } = {}) {
  const ref = stdRefOf(sop);
  const byId = new Map((items || []).map((i) => [i.id, i]));
  return (sop.materials || []).map((m) => {
    const item = m.itemId ? byId.get(m.itemId) : null;
    const qty = num(m.qty);
    const rec = {
      jobId,
      itemId: m.itemId || null,
      description: (m.name || item?.name || 'Material').slice(0, 300),
      qty,
      unit: m.unit || item?.unit || '',
      status: 'requested',
      stdRef: ref,
    };
    if (m.note) rec.note = String(m.note).slice(0, 1000);
    if (seesMoney && item && Number.isFinite(Number(item.costCents))) {
      rec.costCents = Math.max(0, Math.round(Number(item.costCents) * qty));
    }
    return rec;
  });
}

/** A circuit-filling template built from a breaker row (merged with its referenced built-in, if any). */
function breakerTemplate(row, templates) {
  const base = row.templateId ? (templates || []).find((t) => t.id === row.templateId) : null;
  return {
    descriptionDefault: row.note || base?.descriptionDefault || base?.label || 'Circuit',
    poles: row.poles ?? base?.poles ?? 1,
    amps: row.amps == null ? (base?.amps ?? null) : row.amps,
    loadVA: row.loadVA == null ? (base?.loadVA ?? null) : row.loadVA,
    breakerType: row.breakerType || base?.breakerType || 'standard',
    ...(base?.subFeed ? { subFeed: true } : {}),
  };
}

/**
 * Panel circuits from a standard's breakers: one circuit per breaker row, expanded by `qty`, seeded with
 * `applyBreakerTemplate`. Slots are numbered sequentially; the office arranges them in the panel editor.
 */
export function buildBreakerCircuits(sop, { settings = {} } = {}) {
  const templates = listBreakerTemplates(settings);
  const out = [];
  let slot = 1;
  for (const row of sop.breakers || []) {
    const n = Math.max(1, Math.round(num(row.qty) || 1));
    const tpl = breakerTemplate(row, templates);
    for (let i = 0; i < n; i++) out.push({ slot: slot++, ...applyBreakerTemplate(tpl, {}) });
  }
  return out;
}

/** A draft panel schedule from a standard: the preset main (if any) plus one circuit per breaker. */
export function buildPanel(sop, { jobId, settings = {} } = {}) {
  const preset = sop.panelTemplateId ? listPanelTemplates(settings).find((p) => p.id === sop.panelTemplateId) : null;
  return {
    jobId,
    name: `${sop.jobType || sop.title || 'Panel'} (from standard)`.slice(0, 200),
    voltage: preset?.voltage || null,
    mainAmps: preset?.mainAmps ?? null,
    busAmps: preset?.busAmps ?? null,
    slots: preset?.slots ?? null,
    mainType: preset?.mainType || null,
    feedThrough: preset?.feedThrough ?? null,
    templateId: preset?.id || null,
    circuits: buildBreakerCircuits(sop, { settings }),
    stdRef: stdRefOf(sop),
  };
}

/**
 * A draft estimate from a standard (office only — the caller gates on `auth.seesMoney()`): one material
 * line per priced material at its sell price (unpriced materials become a $0 line the office prices),
 * plus one labour line of the standard's total estimated hours at the labour rate. Tax fields come from
 * `newDocTax` so the estimate carries the company's province/treatment snapshot. markupPct defaults to 0.
 */
export function buildDraftEstimate(sop, { job, client = null, items = [], settings = {}, today = null, labourRateCents = null, markupPct = 0 } = {}) {
  const byId = new Map((items || []).map((i) => [i.id, i]));
  const rate = labourRateCents == null ? (num(settings.labourRateCents) || 9500) : num(labourRateCents);
  const lines = [];
  for (const m of sop.materials || []) {
    const item = m.itemId ? byId.get(m.itemId) : null;
    const priced = item && Number.isFinite(Number(item.priceCents));
    lines.push({
      itemId: m.itemId || null,
      kind: 'material',
      description: (priced ? '' : '[set price] ') + (m.name || item?.name || 'Material'),
      qty: num(m.qty),
      unitCents: priced ? Number(item.priceCents) : 0,
    });
  }
  const hours = (sop.tasks || []).reduce((s, t) => s + num(t.estHours), 0);
  if (hours > 0) lines.push({ itemId: null, kind: 'labour', description: 'Labour', qty: Math.round(hours * 100) / 100, unitCents: rate });
  return {
    jobId: job?.id || null,
    clientId: job?.clientId ?? client?.id ?? null,
    title: `${sop.jobType || sop.title || 'Job standard'} — from standard`.slice(0, 300),
    status: 'draft',
    lines,
    labourRateCents: rate,
    markupPct: num(markupPct),
    stdRef: stdRefOf(sop),
    ...newDocTax(settings, today || new Date(), { job, client }),
  };
}

// ---------- apply: write the records, de-duplicated per job + sop ----------

const sameRef = (ref, sopId) => ref && ref.sopId === sopId;

/**
 * Apply a standard to a job, writing records through `ctx.store` (so they sync). Idempotent per job+sop:
 * a task already present (same sopId + title) is skipped, a material (same sopId + itemId/description) is
 * skipped, and a panel or estimate already seeded from this sop is skipped, so re-applying after a
 * revision bump adds only what is new. Money-bearing writes (material costs, the draft estimate) are
 * gated on `ctx.auth.seesMoney()`.
 *
 * @param {{ store: object, auth: { seesMoney: () => boolean, who?: () => { name: string } }, ui?: { today?: () => string } }} ctx
 * @param {object} job
 * @param {object} sop  the standard (an SOP with the job-standard fields)
 * @param {{ createPanel?: boolean, buildEstimate?: boolean, province?: string|null, authority?: string|null }} [opts]
 * @returns {{ addedTasks: number, skippedTasks: number, addedMaterials: number, skippedMaterials: number, panel: string, estimate: string }}
 */
export function applyStandard(ctx, job, sop, opts = {}) {
  const { store, auth } = ctx;
  const sopId = sop.id;
  const seesMoney = Boolean(auth?.seesMoney?.());
  const now = new Date().toISOString();
  const result = { addedTasks: 0, skippedTasks: 0, addedMaterials: 0, skippedMaterials: 0, panel: 'none', estimate: 'none' };

  // (a) Work tasks — skip by stdRef.sopId + title.
  const existingTasks = store.list('workTasks', (t) => t.jobId === job.id && sameRef(t.stdRef, sopId));
  const haveTitles = new Set(existingTasks.map((t) => String(t.title || '').trim().toLowerCase()));
  for (const t of buildWorkTasks(sop, { jobId: job.id })) {
    if (haveTitles.has(t.title.toLowerCase())) { result.skippedTasks++; continue; }
    store.add('workTasks', t);
    haveTitles.add(t.title.toLowerCase());
    result.addedTasks++;
  }

  // (b) Materials / BOM — skip by stdRef.sopId + itemId (or description when no itemId).
  const existingMats = store.list('materialRequests', (r) => r.jobId === job.id && sameRef(r.stdRef, sopId));
  const matKey = (r) => (r.itemId ? `id:${r.itemId}` : `d:${String(r.description || '').trim().toLowerCase()}`);
  const haveMats = new Set(existingMats.map(matKey));
  for (const r of buildMaterialRequests(sop, { jobId: job.id, items: store.list('items'), seesMoney })) {
    if (haveMats.has(matKey(r))) { result.skippedMaterials++; continue; }
    store.add('materialRequests', r);
    haveMats.add(matKey(r));
    result.addedMaterials++;
  }

  // (c) SOP link on the job — dedupe by sopId, refresh the revision/time on re-apply.
  const applied = Array.isArray(job.appliedStandards) ? job.appliedStandards.filter((a) => a && a.sopId !== sopId) : [];
  applied.push({ sopId, revision: sopRev(sop), appliedAt: now, appliedBy: auth?.who?.().name || null });
  store.update('jobs', job.id, { appliedStandards: applied }, { summary: `${job.number || job.id}: applied standard ${sop.jobType || sop.title || ''}`.trim() });

  // (d) Panel (opt-in) — skip if one was already seeded from this sop.
  if (opts.createPanel && (sop.breakers || []).length) {
    const have = store.list('panels', (p) => p.jobId === job.id && sameRef(p.stdRef, sopId));
    if (have.length) result.panel = 'skipped';
    else { store.add('panels', buildPanel(sop, { jobId: job.id, settings: store.settings() })); result.panel = 'added'; }
  }

  // (e) Draft estimate (opt-in, office only).
  if (opts.buildEstimate) {
    if (!seesMoney) result.estimate = 'blocked';
    else {
      const have = store.list('estimates', (e) => e.jobId === job.id && sameRef(e.stdRef, sopId));
      if (have.length) result.estimate = 'skipped';
      else {
        const client = job.clientId ? store.get('clients', job.clientId) : null;
        const today = ctx.ui?.today ? ctx.ui.today() : now.slice(0, 10);
        const est = buildDraftEstimate(sop, { job, client, items: store.list('items'), settings: store.settings(), today });
        store.add('estimates', { ...est, number: store.nextNumber('estimate') });
        result.estimate = 'added';
      }
    }
  }
  return result;
}
