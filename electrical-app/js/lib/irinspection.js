// Thermal / infrared (IR) inspection report (#/irinspection): the record of a thermographic survey
// of electrical gear — panels, switchgear, connections, motors — good for service-agreement PM.
// Each finding is a hot spot: where it is, the measured temperature, a reference/ambient temperature,
// the resulting ΔT, a severity band from that ΔT, a recommended action, and a thermal + a visible
// photo. Pure logic, shared by the module and the tests.
//
// VERIFY: the ΔT severity bands below are the commonly cited NETA (InterNational Electrical Testing
// Association, ATS Table 100.18) thermographic survey bands, by ΔT over a reference/ambient. The
// governing standard and the AHJ decide the real action thresholds — treat these as a sensible
// default a tech can override per finding, not as an authority. Confirm against the current NETA
// edition (or the applicable standard) before relying on them.

const newId = (p) => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);

/**
 * Severity bands by ΔT (measured minus reference/ambient, in °C), worst last. `maxDelta` is the top
 * of the band (inclusive); the last band has no ceiling. `rank` orders them (higher = worse).
 * VERIFY against NETA ATS Table 100.18 / the governing standard.
 */
export const SEVERITY_BANDS = [
  { id: 'none', label: 'Normal', rank: 0, maxDelta: 1, action: 'No action — within normal range.' },
  { id: 'investigate', label: 'Investigate', rank: 1, maxDelta: 3, action: 'Possible deficiency — investigate / re-check at next PM.' },
  { id: 'repair-scheduled', label: 'Repair (scheduled)', rank: 2, maxDelta: 15, action: 'Probable deficiency — repair as time permits.' },
  { id: 'repair-immediate', label: 'Repair immediately', rank: 3, maxDelta: null, action: 'Serious discrepancy — repair immediately.' },
];

export const severityOf = (id) => SEVERITY_BANDS.find((b) => b.id === id) || SEVERITY_BANDS[0];
export const severityLabel = (id) => severityOf(id).label;
export const severityRank = (id) => severityOf(id).rank;

export const MAX_FINDINGS = 50;

/**
 * The severity band for a ΔT in °C. Negative/zero ΔT is 'none'. Returns a band id.
 * VERIFY: band edges follow SEVERITY_BANDS (NETA-style, confirm against the standard).
 */
export function severityForDelta(deltaC) {
  const d = Number(deltaC);
  if (!Number.isFinite(d) || d < 1) return 'none';
  for (const b of SEVERITY_BANDS) {
    if (b.maxDelta == null) return b.id;
    if (d <= b.maxDelta) return b.id;
  }
  return SEVERITY_BANDS.at(-1).id;
}

/** ΔT for a finding: measured − reference, or null when either is missing. */
export function computeDelta(finding) {
  const m = Number(finding?.measuredC);
  const r = Number(finding?.referenceC);
  if (!Number.isFinite(m) || !Number.isFinite(r)) return null;
  return Math.round((m - r) * 10) / 10;
}

/**
 * A finding's severity: the tech's manual override if set, else the band from its ΔT. Returns a band
 * id, or 'none' when there is no ΔT to judge yet.
 */
export function findingSeverity(finding) {
  if (finding?.severity && SEVERITY_BANDS.some((b) => b.id === finding.severity)) return finding.severity;
  const d = computeDelta(finding);
  return d == null ? 'none' : severityForDelta(d);
}

/** A new, blank finding. */
export function newFinding() {
  return {
    id: newId('f'),
    location: '',
    component: '',
    loadAmps: null,
    measuredC: null,
    referenceC: null,
    deltaC: null, // cached; computeDelta is the source of truth
    severity: '', // '' = auto from ΔT; a band id = manual override
    action: '',
    notes: '',
    thermalPhotos: [],
    visiblePhotos: [],
  };
}

/** A new IR inspection, optionally tied to a job and a site asset. */
export function newInspection({ job = null, asset = null, by = null, date = null } = {}) {
  return {
    id: newId('ir'),
    jobId: job?.id || null,
    clientId: job?.clientId || asset?.clientId || null,
    assetId: asset?.id || null,
    target: asset?.name || job?.title || '',
    date: date || null,
    inspector: '',
    instrument: '', // camera make/model
    emissivity: null,
    ambientC: null,
    findings: [],
    summary: '',
    notes: '',
    signatureId: null,
    createdBy: by || null,
  };
}

/** Counts by severity, and the worst band present (by rank). */
export function summarize(findings) {
  const out = { total: 0, none: 0, investigate: 0, 'repair-scheduled': 0, 'repair-immediate': 0, worst: 'none' };
  let worstRank = 0;
  for (const f of findings || []) {
    out.total++;
    const s = findingSeverity(f);
    out[s] = (out[s] ?? 0) + 1;
    if (severityRank(s) > worstRank) { worstRank = severityRank(s); out.worst = s; }
  }
  return out;
}

/** Sort findings worst-first, then by ΔT descending. */
export function sortFindings(findings) {
  return [...(findings || [])].sort((a, b) =>
    (severityRank(findingSeverity(b)) - severityRank(findingSeverity(a))) ||
    (Number(computeDelta(b) ?? -Infinity) - Number(computeDelta(a) ?? -Infinity)));
}

export const inspectionLabel = (r) => {
  const name = (r?.target || '').trim() || 'IR inspection';
  return `${name}${r?.date ? ` · ${r.date}` : ''}`;
};
