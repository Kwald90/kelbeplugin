// AR tape measure — the saved-measurement record shape and small display helpers. Pure (no DOM):
// the module (modules/measure.js) captures the length with AR (lib/ar-measure.js) and persists the
// record this builds into the `measurements` collection. lengthM is always metres (the canonical
// unit); display follows the user's unit preference.
const iso = () => new Date().toISOString();

/** Build a measurements record from a captured (or typed) length in metres. */
export function newMeasurement({ lengthM, unit = 'metric', method = 'ar', jobId = null, clientId = null, label = '', note = '', by = null } = {}) {
  const now = iso();
  return {
    label: String(label || '').trim().slice(0, 200),
    lengthM: Number(lengthM) || 0,
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
