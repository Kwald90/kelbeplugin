// Server-side access rules per collection. Same roles and permission keys as the PWA
// (auth/permissions.js), applied to every REST call and every sync mutation.
import { AUDIT_COLLECTION, collectionDef } from '../collections.js';
// Work tasks: the same rules the PWA applies offline (who may change what, photo evidence).
import { mergeTask, taskWriteProblem } from '../../../electrical-app/js/lib/workplan.js';
// Drawings: object-level merge (two people editing different parts both keep their work).
import { mergeDrawing } from '../../../electrical-app/js/lib/drawing-collab.js';
import { canSeeMoney } from '../../../electrical-app/js/lib/drawing-costs.js';

/**
 * @typedef {object} Principal
 * @property {'session'|'api_key'} kind
 * @property {string} tenantId
 * @property {string|null} userId
 * @property {string|null} role             membership role (capped for crew sessions)
 * @property {Set<string>} perms             permission keys of the role
 * @property {boolean} isManager
 * @property {string|null} employeeId        the member's employees record id
 * @property {string[]|null} scopes          API key scopes
 * @property {boolean} [crew]                shared-device PIN session
 * @property {{ type: string, id: string|null, label?: string|null }} actor
 */

/** Scopes an API key may hold. */
export function validScopes(collections) {
  const out = new Set(['*:read', '*:write']);
  for (const c of collections) { out.add(`${c}:read`); out.add(`${c}:write`); }
  return out;
}

function hasScope(p, coll, mode) {
  const s = p.scopes || [];
  if (s.includes(`${coll}:write`) || s.includes('*:write')) return true;
  return mode === 'read' && (s.includes(`${coll}:read`) || s.includes('*:read'));
}

/** @param {Principal} p */
export function canRead(p, coll) {
  if (p.kind === 'api_key') return !collectionDef(coll)?.noApiKeys && hasScope(p, coll, 'read');
  if (coll === AUDIT_COLLECTION) return p.perms.has('security');
  const def = collectionDef(coll);
  if (!def) return false;
  if (def.readAll) return true;
  return def.read.some((k) => p.perms.has(k));
}

/** @param {Principal} p */
export function canWrite(p, coll) {
  if (p.kind === 'api_key') return !collectionDef(coll)?.noApiKeys && hasScope(p, coll, 'write');
  const def = collectionDef(coll);
  if (!def || coll === AUDIT_COLLECTION) return false;
  if (def.managerWrite && !p.isManager) return false;
  return def.write.some((k) => p.perms.has(k));
}

/**
 * Row filter for reads. Non-managers see only their own time entries and work tasks, and of
 * their tasks only the published ones (`exclude`: rows whose column holds one of `values`).
 * @returns {null | { column: string, value: string|null, exclude?: { column: string, field: string, values: string[] } }}
 */
export function rowFilter(p, coll) {
  const def = collectionDef(coll);
  if (def?.ownRows && p.kind !== 'api_key' && (!p.isManager || def.ownRowsAlways)) {
    const f = { column: 'employee_id', value: p.employeeId || null };
    const hide = def.ownRowsHide;
    const col = hide && def.gen.find((x) => x.field === hide.field)?.col;
    if (col) f.exclude = { column: col, field: hide.field, values: [...hide.values] };
    return f;
  }
  return null;
}

/** Does a row's data pass the row filter? (the same test as the SQL in services/records.js) */
export function rowVisible(f, data, def) {
  if (!f) return true;
  const field = def.gen.find((x) => x.col === f.column)?.field;
  if (f.value == null || data?.[field] !== f.value) return false;
  if (f.exclude && f.exclude.values.includes(data?.[f.exclude.field])) return false;
  return true;
}

/**
 * The data to store for a write, when a collection merges instead of replacing: work tasks
 * keep the foreman's fields from a worker's write and resolve progress by its own timestamp
 * (lib/workplan.js mergeTask). Returns null for collections that store what was sent.
 */
export function mergeWrite(p, coll, existing, next) {
  if (!existing || !next) return null;
  if (coll === 'drawings') return mergeDrawing(existing, next);
  if (coll !== 'workTasks') return null;
  return mergeTask(existing, next, { worker: p.kind !== 'api_key' && !p.isManager });
}

/** What a manager's review or approval of a time entry changes (PWA lib/clock.js reviewFlag, approveEntries). */
export const TIME_REVIEW_FIELDS = ['flag', 'approved', 'approvedAt', 'approvedBy'];
const FLAG_REVIEW_KEYS = ['reviewedAt', 'reviewedBy', 'reviewNote'];

/**
 * A stale write (made on an older copy) that only reviews or approves a time entry: `fields`, the
 * fields the device changed, are all review fields. Only those go onto the stored entry, so a
 * foreman's old copy never puts back clock times the worker changed since (a clock-out, a
 * corrected time). Returns the data to store, or null when this is not such a write.
 */
export function reviewMerge(coll, existing, next, fields) {
  if (coll !== 'timeEntries' || !existing || !next || !Array.isArray(fields) || !fields.length) return null;
  if (!fields.every((f) => TIME_REVIEW_FIELDS.includes(f))) return null;
  const t = (iso) => Date.parse(iso) || 0;
  const out = { ...existing, updatedAt: t(next.updatedAt) >= t(existing.updatedAt) ? next.updatedAt : existing.updatedAt };
  for (const f of fields) {
    if (f === 'flag' && existing.flag && next.flag) {
      out.flag = { ...existing.flag };
      for (const k of FLAG_REVIEW_KEYS) { if (k in next.flag) out.flag[k] = next.flag[k]; else delete out.flag[k]; }
    } else if (f in next) out[f] = next[f];
    else delete out[f];
  }
  return out;
}

// ---- money (prices, costs, rates) ---------------------------------------------
// Crew never see prices or costs. Money roles: owner, admin, office (the `estimates`
// permission), foremen when the company allows it (settings.foremanSeesCosts, loaded once per
// request by services/records.js loadMoneyAccess), API keys (a company admin scoped them) and
// background agents. Readers without money get records without these fields, and their
// writes cannot change them (restoreHiddenFields puts the stored values back).

/** Price fields hidden from readers without money, per collection. */
export const MONEY_FIELDS = {
  items: ['priceCents', 'costCents'],
  settings: ['labourRateCents', 'markupPct'],
  // the office's cost on a material request (crew file requests, never with prices)
  materialRequests: ['costCents'],
};

/** Can this principal see prices and costs? */
export function seesMoney(p) {
  if (!p) return false;
  if (typeof p.seesMoney === 'boolean') return p.seesMoney;
  if (p.kind === 'api_key') return true;
  return canSeeMoney({ role: p.role, perms: p.perms });
}

/** A change order as a reader without money sees it. */
function coWithoutMoney(co) {
  if (!co || typeof co !== 'object') return co;
  const { amountCents, lines, ...rest } = co;
  void amountCents;
  return Array.isArray(lines)
    ? { ...rest, lines: lines.map((l) => { const { unitCents, ...x } = l || {}; void unitCents; return x; }) }
    : rest;
}

function stripMoney(coll, data) {
  if (!data) return data;
  if (MONEY_FIELDS[coll] && MONEY_FIELDS[coll].some((k) => k in data)) {
    const rest = { ...data };
    for (const k of MONEY_FIELDS[coll]) delete rest[k];
    rest.pricesHidden = true;
    return rest;
  }
  if (coll === 'jobs' && Array.isArray(data.changeOrders) && data.changeOrders.length) {
    return { ...data, changeOrders: data.changeOrders.map(coWithoutMoney), pricesHidden: true };
  }
  return data;
}

/** Put back the money a reader without it could not see (or change). */
function restoreMoney(coll, existing, next) {
  const out = { ...next };
  delete out.pricesHidden; // a read marker, never stored
  if (MONEY_FIELDS[coll]) {
    for (const k of MONEY_FIELDS[coll]) {
      // A new record from a reader without money carries none either (a crew member's material request).
      if (existing && k in existing) out[k] = existing[k]; else if (existing || coll === 'materialRequests') delete out[k];
    }
  }
  if (coll === 'jobs' && Array.isArray(out.changeOrders)) {
    const before = new Map((existing?.changeOrders || []).filter((c) => c?.id).map((c) => [c.id, c]));
    out.changeOrders = out.changeOrders.map((co) => {
      const old = co?.id && before.get(co.id);
      if (!old) { const { amountCents, ...rest } = co || {}; void amountCents; return rest; }
      const keep = { ...co };
      if ('amountCents' in old) keep.amountCents = old.amountCents; else delete keep.amountCents;
      if ('lines' in old) keep.lines = old.lines; else delete keep.lines;
      return keep;
    });
  }
  return out;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const IGNORED = new Set(['updatedAt', 'createdAt', 'id']);
function changedKeys(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...keys].filter((k) => !IGNORED.has(k) && !same(before?.[k], after?.[k]));
}

/**
 * Rules that depend on the record itself. Returns an error message, or null when allowed.
 * @param {Principal} p
 * @param {string} coll
 * @param {object|null} existing  current record data (null when creating)
 * @param {object|null} next      new record data (null when deleting)
 */
export function checkWriteRules(p, coll, existing, next) {
  // Evidence is required on every path, API keys included; the rest is per person.
  if (coll === 'workTasks') {
    if (p.kind === 'api_key') return taskWriteProblem({ isManager: true, employeeId: null }, existing, next);
    return taskWriteProblem({ isManager: p.isManager, employeeId: p.employeeId || null }, existing, next);
  }
  if (p.kind === 'api_key') return null;
  const def = collectionDef(coll);

  // Material requests: crew file their own, and change or withdraw them only until they are sent.
  if (coll === 'materialRequests' && !p.isManager) return materialRequestRule(p, existing, next);
  // Location points and consents belong to one person: only they record them, whatever their role
  // (a manager can't give consent or add points for someone else). Points never change once saved.
  if (coll === 'locationPoints' || coll === 'locationConsents') {
    if (!p.employeeId) return 'Your membership is not linked to an employee record, so location is not recorded.';
    if (existing && existing.employeeId !== p.employeeId) return 'Only the person it belongs to can change this.';
    if (next && next.employeeId !== p.employeeId) return 'Location records are only ever made by the person themselves.';
    if (coll === 'locationPoints' && existing && next) return 'Location points cannot be changed.';
    if (!next) return coll === 'locationPoints' ? 'Location points are removed by the retention schedule.' : 'Consent answers are kept; record a new answer instead.';
    return null;
  }

  // Time entries: non-managers write only their own, and cannot approve.
  if (def?.ownRows && !p.isManager) {
    if (!p.employeeId) return 'Your membership is not linked to an employee record, so you cannot record time.';
    if (existing && existing.employeeId !== p.employeeId) return 'You can only change your own time entries.';
    if (next && next.employeeId !== p.employeeId) return 'You can only record time for yourself.';
  }
  if (coll === 'timeEntries' && next && !p.perms.has('time-approve') && Boolean(next.approved) !== Boolean(existing?.approved)) {
    return 'Approving time needs the time-approve permission.';
  }
  // An approved entry is locked for everyone who can't approve (threat model TM-SYNC-04).
  if (coll === 'timeEntries' && existing?.approved && !p.perms.has('time-approve')) {
    return 'This time is approved. Ask your foreman or the office to change it.';
  }
  if (coll === 'timeEntries' && next && !p.isManager && !same(existing?.flag?.reviewedAt ?? null, next.flag?.reviewedAt ?? null)) {
    return 'Only a manager can review an off-site clock-in.';
  }

  // SOPs: managers edit; everyone else may only add their own acknowledgement.
  if (coll === 'sops' && !p.isManager) {
    if (!existing || !next) return 'Only managers can create or delete SOPs.';
    const changed = changedKeys(existing, next);
    if (changed.some((k) => k !== 'acks')) return 'You can only acknowledge an SOP.';
    const before = existing.acks || [];
    const after = next.acks || [];
    if (after.length < before.length || !before.every((a, i) => same(a, after[i]))) return 'Acknowledgements cannot be removed or changed.';
    if (after.slice(before.length).some((a) => a?.employeeId !== p.employeeId)) return 'You can only acknowledge for yourself.';
  }

  const safetyMsg = SAFETY_COLLECTIONS.has(coll) && !p.isManager ? safetyWriteRule(p, coll, existing, next) : null;
  if (safetyMsg) return safetyMsg;

  // Settings: the settings permission edits anything; document creators may only bump nextNumbers.
  if (coll === 'settings' && !p.perms.has('settings')) {
    if (!existing || !next) return 'Only the settings permission can create or delete settings.';
    const changed = changedKeys(existing, next);
    if (changed.some((k) => k !== 'nextNumbers')) return 'Changing settings needs the settings permission.';
  }
  return null;
}

// ---- money and material requests ------------------------------------------------

/** A non-manager's write to a material request: an error message, or null when allowed. */
function materialRequestRule(p, existing, next) {
  const me = p.employeeId;
  if (!me) return 'Your membership is not linked to an employee record, so you cannot request material.';
  if (existing && existing.employeeId !== me) return 'You can only change your own material requests.';
  if (next && next.employeeId !== me) return 'Request material as yourself.';
  if (existing && (existing.status || 'requested') !== 'requested') return 'This request has gone to the office; ask them to change it.';
  if (!next) return null;
  if (!['requested', 'cancelled'].includes(next.status || 'requested')) return 'Only the office marks requests sent, ordered or fulfilled.';
  if (!same(existing?.costCents ?? null, next.costCents ?? null)) return 'Only the office sets costs.';
  for (const k of ['batchId', 'sentAt', 'stockMoveId']) if (!same(existing?.[k] ?? null, next[k] ?? null)) return 'Only the office handles sent requests.';
  return null;
}

// ---- safety (docs/safety/README.md) ------------------------------------------
// Every role holds `safety`. Managers (owner, admin, office, foreman) do anything; everyone
// else files their own FLHAs, near misses, incidents and inspections, signs toolbox talks for
// themselves and closes corrective actions assigned to them.
const SAFETY_COLLECTIONS = new Set(['flhas', 'toolboxTalks', 'incidents', 'correctiveActions', 'safetyInspections']);

/** Incident fields only managers read: injury, body part, treatment, WCB claim. */
export const MEDICAL_FIELDS = ['medical'];

/** Can this principal see incident medical details? Session managers only (not API keys). */
export const seesMedical = (p) => p.kind === 'session' && Boolean(p.isManager);

const onlyKeys = (existing, next, allowed) => changedKeys(existing, next).filter((k) => !allowed.includes(k));

/** A non-manager's write to a safety collection: an error message, or null when allowed. */
function safetyWriteRule(p, coll, existing, next) {
  if (p.kind === 'api_key') return null;
  const me = p.employeeId;
  if (!me) return 'Your membership is not linked to an employee record, so you cannot file safety records.';
  if (coll === 'flhas') {
    if (!next) return 'Only managers can delete a hazard assessment.';
    if ((existing && existing.employeeId !== me) || next.employeeId !== me) return 'You can only file your own hazard assessment.';
    if (!same(existing?.review ?? null, next.review ?? null)) return 'Only a manager can sign off the review.';
    return null;
  }
  if (coll === 'toolboxTalks') {
    if (!existing || !next) return 'Only managers can schedule or delete toolbox talks.';
    if (onlyKeys(existing, next, ['attendees']).length) return 'You can only sign the attendance sheet.';
    const before = existing.attendees || [];
    const after = next.attendees || [];
    if (after.length < before.length || !before.every((a, i) => same(a, after[i]))) return 'Signatures cannot be removed or changed.';
    if (after.slice(before.length).some((a) => a?.employeeId !== me)) return 'You can only sign for yourself.';
    return null;
  }
  if (coll === 'incidents') {
    if (!next) return 'Only managers can delete an incident report.';
    if (!existing) return next.reportedBy === me ? null : 'File the report as yourself.';
    if (existing.reportedBy !== me) return "Only managers can change someone else's report.";
    if ((existing.status || 'reported') !== 'reported') return 'This report is under investigation; ask a manager to change it.';
    const locked = changedKeys(existing, next).filter((k) => ['status', 'investigation', 'reporting', 'reportedBy', 'closedAt'].includes(k));
    return locked.length ? 'Only managers investigate, close or report incidents.' : null;
  }
  if (coll === 'correctiveActions') {
    if (!next) return 'Only managers delete corrective actions.';
    if (!existing) {
      // A worker may raise an action from their own inspection or report: open, unassigned or theirs.
      if (next.createdBy !== me || (next.status || 'open') !== 'open' || (next.ownerId && next.ownerId !== me)) return 'Only managers assign corrective actions.';
      return null;
    }
    if (existing.ownerId !== me) return 'Only the owner of a corrective action can close it.';
    if (onlyKeys(existing, next, ['status', 'doneAt', 'doneBy', 'doneNote', 'evidence']).length) return 'You can only mark the action done with evidence.';
    if (!['open', 'done'].includes(next.status)) return 'Only a manager can verify a corrective action.';
    return null;
  }
  if (coll === 'safetyInspections') {
    if (!next) return 'Only managers can delete an inspection.';
    if ((existing && existing.inspectorId !== me) || next.inspectorId !== me) return 'You can only file inspections you did.';
    return null;
  }
  return null;
}

/**
 * Hidden fields a reader could not see cannot be changed by their write either: put the
 * stored values back (a worker editing their own report never wipes the medical details).
 * Returns the record to store.
 */
export function restoreHiddenFields(p, coll, existing, next) {
  if (coll === 'timeEntries' && next && p.kind === 'api_key') {
    // An API key never saw the coordinates, so its write keeps the stored ones.
    const out = { ...next };
    for (const k of ENTRY_COORDS) { if (existing && k in existing) out[k] = existing[k]; else delete out[k]; }
    return out;
  }
  if (next && (MONEY_FIELDS[coll] || coll === 'jobs')) {
    if (!seesMoney(p)) return restoreMoney(coll, existing, next);
    if ('pricesHidden' in next) { const out = { ...next }; delete out.pricesHidden; return out; }
    return next;
  }
  if (coll !== 'incidents' || !next) return next;
  const out = { ...next };
  delete out.medicalHidden; // a read marker (redactForReader), never stored
  if (!existing || seesMedical(p)) return out;
  for (const k of MEDICAL_FIELDS) {
    if (k in existing) out[k] = existing[k]; else delete out[k];
  }
  return out;
}

/** Fields hidden from some readers. Returns a copy when anything is removed. */
/** Coordinates on time entries; API keys and AI tools get the distances and flags without them. */
export const ENTRY_COORDS = ['clockInLoc', 'clockOutLoc'];

export function redactForReader(p, coll, data) {
  if (coll === 'timeEntries' && data && p.kind === 'api_key' && ENTRY_COORDS.some((k) => k in data)) {
    const rest = { ...data };
    for (const k of ENTRY_COORDS) delete rest[k];
    return rest;
  }
  if (data && (MONEY_FIELDS[coll] || coll === 'jobs') && !seesMoney(p)) return stripMoney(coll, data);
  if (coll === 'employees' && data && p.kind !== 'api_key' && !p.perms.has('employees') && 'rateCents' in data) {
    const { rateCents, ...rest } = data;
    return rest;
  }
  if (coll === 'incidents' && data && !seesMedical(p) && MEDICAL_FIELDS.some((k) => k in data)) {
    const rest = { ...data };
    for (const k of MEDICAL_FIELDS) delete rest[k];
    rest.medicalHidden = true;
    return rest;
  }
  return data;
}

/** Fields the server never stores. */
export function sanitizeForStorage(coll, data) {
  if (coll === 'employees' && data && 'pin' in data) {
    const { pin, ...rest } = data;
    return rest;
  }
  return data;
}
