// AR tape measure — the saved-measurement record shape and small display helpers. Pure (no DOM):
// the module (modules/measure.js) captures the length with AR (lib/ar-measure.js) and persists the
// record this builds into the `measurements` collection. lengthM is always metres (the canonical
// unit); display follows the user's unit preference.
const iso = () => new Date().toISOString();
const SQFT_PER_SQM = 10.7639104;

/**
 * Build a measurements record from a captured (or typed) measurement. kind 'length' keeps lengthM
 * (metres); kind 'area' keeps areaM2 (square metres) and perimeterM (metres, the closed loop).
 */
export function newMeasurement({ kind = 'length', lengthM, areaM2 = null, perimeterM = null, unit = 'metric', method = 'ar', jobId = null, clientId = null, label = '', note = '', by = null } = {}) {
  const now = iso();
  const isArea = kind === 'area';
  return {
    kind: isArea ? 'area' : 'length',
    label: String(label || '').trim().slice(0, 200),
    lengthM: Number(lengthM) || 0,
    areaM2: isArea ? (Number(areaM2) || 0) : null,
    perimeterM: isArea ? (Number(perimeterM) || 0) : null,
    unit: unit === 'imperial' ? 'imperial' : 'metric',
    method: method === 'manual' ? 'manual' : 'ar',
    jobId: jobId || null,
    clientId: clientId || null,
    note: String(note || '').trim().slice(0, 2000),
    takenAt: now,
    createdAt: now,
    updatedAt: now,
    createdBy: by || null,
  };
}

/**
 * An area in m² as { primary, other }, the user's unit first: "12.50 m²" / "134.6 ft²". Both are
 * always computed so a saved area reads correctly whichever unit the reader prefers.
 */
export function fmtArea(m2, { units = 'metric' } = {}) {
  const n = Math.max(0, Number(m2) || 0);
  const sqft = n * SQFT_PER_SQM;
  const m = `${n.toFixed(n < 100 ? 2 : 1)} m²`;
  const f = `${sqft.toFixed(sqft < 1000 ? 1 : 0)} ft²`;
  return units === 'imperial' ? { primary: f, other: m } : { primary: m, other: f };
}

/** An area that is sane to save (positive, under 10,000,000 m²). */
export function validArea(m2) {
  const n = Number(m2);
  return Number.isFinite(n) && n > 0 && n < 1e7;
}

/** Newest first, by when it was taken (then created). */
export function sortMeasurements(list) {
  return [...(list || [])].sort((a, b) => String(b.takenAt || b.createdAt || '').localeCompare(String(a.takenAt || a.createdAt || '')));
}

/** A readable title for a saved measurement row. */
export function measurementTitle(m) {
  return String(m?.label || '').trim() || 'Measurement';
}

/** A length that is sane to save (positive, under 100 km). */
export function validLength(lengthM) {
  const n = Number(lengthM);
  return Number.isFinite(n) && n > 0 && n < 100000;
}
