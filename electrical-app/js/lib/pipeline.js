// The sales pipeline: the stages a lead moves through, from first enquiry to a won or lost job.
// A company starts with DEFAULT_STAGES and can rename stages, add or remove open ones, reorder
// them and set a follow-up sequence each stage triggers (Settings → Sales pipeline). The list is
// stored in settings.pipeline.stages. Pure and DOM-free so it can be unit-tested and shared by the
// Leads board (modules/leads.js) and the editor (modules/settings.js).
//
// A stage is { id, label, kind, sequenceId? }. kind is 'open' | 'won' | 'lost'. The 'won' and
// 'lost' stages are terminal and always present: Won offers to create the job and stops follow-ups,
// Lost stops follow-ups. Their ids are reserved ('won', 'lost') so the rest of the app — costing,
// dashboards, this module's own won/lost handling — keeps working no matter how stages are renamed.

export const DEFAULT_STAGES = [
  { id: 'new', label: 'New', kind: 'open' },
  { id: 'contacted', label: 'Contacted', kind: 'open' },
  { id: 'site-visit', label: 'Site visit', kind: 'open' },
  { id: 'quoted', label: 'Quoted', kind: 'open' },
  { id: 'won', label: 'Won', kind: 'won' },
  { id: 'lost', label: 'Lost', kind: 'lost' },
];

const LABEL_MAX = 40;

/**
 * Repair a stored stage list into a valid pipeline: every entry gets a non-empty id and label,
 * ids are unique, non-reserved stages are 'open', and there is exactly one 'won' and one 'lost'
 * terminal stage (appended from the defaults if missing). Falls back to DEFAULT_STAGES when the
 * input is not a non-empty array, so a bad or empty value never leaves the board without columns.
 */
export function normalizeStages(raw) {
  if (!Array.isArray(raw) || !raw.length) return DEFAULT_STAGES.map((s) => ({ ...s }));
  const seen = new Set();
  const out = [];
  let hasWon = false;
  let hasLost = false;
  for (const s of raw) {
    const id = String(s?.id || '').trim();
    if (!id || seen.has(id)) continue;
    // Reserved ids are the only terminal stages; everything else is open.
    const kind = id === 'won' ? 'won' : id === 'lost' ? 'lost' : 'open';
    if (kind === 'won') hasWon = true;
    if (kind === 'lost') hasLost = true;
    seen.add(id);
    const label = String(s?.label ?? id).trim().slice(0, LABEL_MAX) || id;
    const stage = { id, label, kind };
    if (s?.sequenceId) stage.sequenceId = String(s.sequenceId);
    out.push(stage);
  }
  if (!hasWon) out.push({ ...DEFAULT_STAGES.find((s) => s.id === 'won') });
  if (!hasLost) out.push({ ...DEFAULT_STAGES.find((s) => s.id === 'lost') });
  return out;
}

/** The company's stages from a settings object (store.settings()), repaired and ready to render. */
export function pipelineStages(settings) {
  return normalizeStages(settings?.pipeline?.stages);
}

/** The stage with this id, or null. */
export function stageById(stages, id) {
  return stages.find((s) => s.id === id) || null;
}

/** The open stages, in order (what you can reorder, add to and remove). */
export function openStages(stages) {
  return stages.filter((s) => s.kind === 'open');
}

/** True when a lead is still open (its stage is not the won or lost terminal stage). */
export function leadIsOpen(stage) {
  return stage !== 'won' && stage !== 'lost';
}

/** Mint a stage id not already used in `stages`. */
export function newStageId(stages) {
  let n = openStages(stages).length + 1;
  let id;
  do { id = `stage-${n}`; n += 1; } while (stages.some((s) => s.id === id));
  return id;
}

/** The stages shown in the funnel: every non-lost stage (open ones plus Won), in order. */
export function funnelOrder(stages) {
  return stages.filter((s) => s.kind !== 'lost');
}

/**
 * How many leads have reached each stage in `order`. A lead has reached every stage up to and
 * including its own; a lost lead only counts at the top (we don't know where it dropped out); a
 * lead on an unknown stage (e.g. a stage that was removed) also counts only at the top.
 */
export function reachedCounts(leads, order) {
  const pos = (id) => order.findIndex((s) => s.id === id);
  return order.map((_, i) => leads.filter((l) => {
    if (l.stage === 'lost') return i === 0;
    const p = pos(l.stage);
    return p >= 0 ? p >= i : i === 0;
  }).length);
}
