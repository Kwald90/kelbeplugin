// Minimum cover for underground wiring, from CEC Table 53 (Rule 12-012). Pure, offline, mm.
// VERIFY — the 0-750 V figures below are NOT confirmed against the CEC 2024 (CSA C22.1:24) text, which
// is paywalled. A 2026-11 web check of Canadian secondary sources corroborated the two main
// non-vehicular values — direct-buried cable 600 mm and rigid PVC 450 mm — and that Rule 12-012 points
// to Table 53. It did NOT confirm the vehicular-area figures (sources conflict: some read Table 53 as a
// flat +150 mm over the base, others as up to 900 mm) or the rigid-metal-conduit value (the 150 mm here
// is a US NEC figure, unconfirmed for Canada). Table 53 also has reduced-cover and concrete-encasement
// allowances and higher figures above 750 V; those are not modelled. Confirm against the printed CSA
// C22.1:24 Table 53 (and any provincial amendment) before you dig — especially the vehicular and
// metal-conduit rows.

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
