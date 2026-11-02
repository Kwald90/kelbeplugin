// Minimum cover for underground wiring, from CEC Table 53 (Rule 12-012). Pure, offline, mm.
// VERIFY: every figure below is entered from the 0-750 V columns of Table 53 as recalled from earlier
// editions and has NOT been confirmed against the CEC 2024 (CSA C22.1:24) text. Table 53 also has
// reduced-cover and concrete-encasement allowances and higher figures above 750 V; those are not modelled.
// Check the printed table (and any provincial amendment) before you dig.

export const MM_PER_IN = 25.4;

export const BURIAL_METHODS = [
  { value: 'cable', label: 'Direct-buried cable (TECK90, RA90, NMW, etc.)' },
  { value: 'rmc', label: 'Rigid metal conduit / IMT' },
  { value: 'pvc', label: 'Rigid PVC / HDPE / RTRC (nonmetallic) conduit' },
];

export const BURIAL_LOCATIONS = [
  { value: 'general', label: 'General: lawn, garden, field, under a building' },
  { value: 'dwelling', label: 'Driveway of a single dwelling' },
  { value: 'vehicle', label: 'Parking area, commercial driveway, lane or public road' },
];

/** Minimum cover in mm [method][location] (VERIFY against CEC 2024 Table 53). */
export const BURIAL_MM = {
  cable: { general: 600, dwelling: 600, vehicle: 900 },
  rmc: { general: 150, dwelling: 150, vehicle: 600 },
  pvc: { general: 450, dwelling: 450, vehicle: 600 },
};

export const BURIAL_SOURCE = 'CEC Table 53 / Rule 12-012';

/** Minimum cover for a wiring method at a location, in mm and inches; null for an unknown pair. */
export function minimumCover(method, location) {
  const mm = BURIAL_MM[method]?.[location];
  if (mm == null) return null;
  return { mm, inches: mm / MM_PER_IN, method, location };
}
