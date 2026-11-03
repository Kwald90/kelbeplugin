// Test & commissioning records: the readings an electrician takes to prove an install is safe and
// works — insulation resistance (megger), continuity/bonding, GFCI/RCD trip time, torque, polarity,
// phase rotation. A report belongs to a job (and optionally a site asset), lists readings with their
// pass/fail against a limit, and carries the test instrument + its calibration date. Pure logic,
// shared by the module and tests.

const newId = (p) => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);

/**
 * Known test types. `unit` is the default reading unit; `direction` is how the limit reads:
 * 'min' = reading must be at least the limit (insulation resistance), 'max' = at most (continuity,
 * trip time), null = recorded, judged by hand (torque, polarity).
 */
export const TEST_TYPES = [
  { id: 'insulation-resistance', label: 'Insulation resistance (megger)', unit: 'MΩ', direction: 'min', defaultLimit: 1 },
  { id: 'continuity', label: 'Continuity / bonding', unit: 'Ω', direction: 'max', defaultLimit: null },
  { id: 'ground-bond', label: 'Ground bond', unit: 'Ω', direction: 'max', defaultLimit: null },
  { id: 'gfci-trip', label: 'GFCI / RCD trip time', unit: 'ms', direction: 'max', defaultLimit: null },
  { id: 'loop-impedance', label: 'Loop impedance', unit: 'Ω', direction: 'max', defaultLimit: null },
  { id: 'torque', label: 'Torque', unit: 'in-lb', direction: null, defaultLimit: null },
  { id: 'polarity', label: 'Polarity', unit: '', direction: null, defaultLimit: null },
  { id: 'phase-rotation', label: 'Phase rotation', unit: '', direction: null, defaultLimit: null },
  { id: 'functional', label: 'Functional', unit: '', direction: null, defaultLimit: null },
  { id: 'other', label: 'Other', unit: '', direction: null, defaultLimit: null },
];

export const typeOf = (id) => TEST_TYPES.find((t) => t.id === id) || TEST_TYPES.at(-1);

export const MAX_READINGS = 100;

/** A new test report for a job. */
export function newTestReport({ job = null, asset = null, type = 'insulation-resistance', by = null, date = null } = {}) {
  const t = typeOf(type);
  return {
    id: newId('tc'),
    jobId: job?.id || null,
    clientId: job?.clientId || asset?.clientId || null,
    assetId: asset?.id || null,
    title: t.label,
    type: t.id,
    date: date || null,
    technician: '',
    instrument: '',
    instrumentCalDate: null,
    result: 'pass',
    readings: [],
    notes: '',
    signatureId: null,
    createdBy: by || null,
  };
}

/** A blank reading for a report's test type (carries the type's unit + limit direction). */
export function newReading(type) {
  const t = typeOf(type);
  return { id: newId('r'), point: '', value: null, unit: t.unit, limit: t.defaultLimit, direction: t.direction, pass: null };
}

/**
 * Pass/fail for one reading: compares value to limit by direction. Returns true/false, or null
 * when it can't be judged automatically (no limit, or a recorded-only test).
 */
export function readingPasses(r) {
  const v = Number(r?.value);
  const lim = r?.limit;
  if (r?.direction == null || lim == null || lim === '' || !Number.isFinite(v) || !Number.isFinite(Number(lim))) {
    return typeof r?.pass === 'boolean' ? r.pass : null;
  }
  return r.direction === 'min' ? v >= Number(lim) : v <= Number(lim);
}

/** Overall suggested result from the readings: 'fail' if any reading fails, else 'pass'. */
export function resultFrom(report) {
  const rs = report?.readings || [];
  let judged = false;
  for (const r of rs) {
    const p = readingPasses(r);
    if (p === false) return 'fail';
    if (p === true) judged = true;
  }
  return judged || rs.length ? 'pass' : (report?.result || 'pass');
}

/** Is the test instrument's calibration out of date as of a day? (annual, the common rule). */
export function calibrationStale(report, asOf) {
  const d = report?.instrumentCalDate;
  if (!d) return false;
  const next = `${Number(d.slice(0, 4)) + 1}${d.slice(4)}`;
  return String(next) < String(asOf);
}

export const reportLabel = (r) => `${r?.title || typeOf(r?.type).label}${r?.date ? ` · ${r.date}` : ''}`;
