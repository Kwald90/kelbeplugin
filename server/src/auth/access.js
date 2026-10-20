// Server-side access rules per collection. Same roles and permission keys as the PWA
// (auth/permissions.js), applied to every REST call and every sync mutation.
import { AUDIT_COLLECTION, collectionDef } from '../collections.js';

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
  if (p.kind === 'api_key') return hasScope(p, coll, 'read');
  if (coll === AUDIT_COLLECTION) return p.perms.has('security');
  const def = collectionDef(coll);
  if (!def) return false;
  if (def.readAll) return true;
  return def.read.some((k) => p.perms.has(k));
}

/** @param {Principal} p */
export function canWrite(p, coll) {
  if (p.kind === 'api_key') return hasScope(p, coll, 'write');
  const def = collectionDef(coll);
  if (!def || coll === AUDIT_COLLECTION) return false;
  if (def.managerWrite && !p.isManager) return false;
  return def.write.some((k) => p.perms.has(k));
}

/**
 * Row filter for reads. Non-managers see only their own time entries.
 * @returns {null | { column: string, value: string|null }}
 */
export function rowFilter(p, coll) {
  const def = collectionDef(coll);
  if (def?.ownRows && p.kind !== 'api_key' && !p.isManager) return { column: 'employee_id', value: p.employeeId || null };
  return null;
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
  if (p.kind === 'api_key') return null;
  const def = collectionDef(coll);

  // Time entries: non-managers write only their own, and cannot approve.
  if (def?.ownRows && !p.isManager) {
    if (!p.employeeId) return 'Your membership is not linked to an employee record, so you cannot record time.';
    if (existing && existing.employeeId !== p.employeeId) return 'You can only change your own time entries.';
    if (next && next.employeeId !== p.employeeId) return 'You can only record time for yourself.';
  }
  if (coll === 'timeEntries' && next && !p.perms.has('time-approve') && Boolean(next.approved) !== Boolean(existing?.approved)) {
    return 'Approving time needs the time-approve permission.';
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
export function redactForReader(p, coll, data) {
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
