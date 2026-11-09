// Fire-alarm verification (CAN/ULC S537): the record a tech makes when verifying a fire-alarm
// system in a building. S537 ("Standard for the Verification of Fire Alarm Systems") is a
// documentation/verification standard, not a numeric calculator — a verification lists every
// device, what was done to it and what the tech observed (installed, correct type/location, an
// alarm received at the panel, annunciation, audibility/visibility), plus the standby-battery
// check and an overall result. We record what the tech observed; we do NOT invent S537 pass/fail
// thresholds. Pure logic, shared by the module (modules/faverification.js) and the tests.
//
// VERIFY: the device list, the check list and the standby-battery fields below are a practical
// working set drawn from CAN/ULC S537; confirm the exact device categories and the full verification
// checklist against the current edition of CAN/ULC S537 (and the local AHJ) before relying on them.

const newId = (p) => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);

/** Device categories a verification covers. `other` catches anything not listed (VERIFY list vs S537). */
export const DEVICE_TYPES = [
  { id: 'smoke', label: 'Smoke detector' },
  { id: 'heat', label: 'Heat detector' },
  { id: 'duct', label: 'Duct smoke detector' },
  { id: 'pull', label: 'Manual pull station' },
  { id: 'strobe', label: 'Strobe / visual signal' },
  { id: 'horn', label: 'Horn / audible signal' },
  { id: 'speaker', label: 'Speaker / voice' },
  { id: 'module', label: 'Module (monitor / control)' },
  { id: 'other', label: 'Other device' },
];

export const deviceTypeOf = (id) => DEVICE_TYPES.find((t) => t.id === id) || DEVICE_TYPES.at(-1);
export const deviceTypeLabel = (id) => deviceTypeOf(id).label;

/**
 * The per-device checks the tech records. Each is a tri-state the tech sets from what they observed:
 * 'pass' (observed good), 'fail' (observed a problem), 'na' (not applicable to this device), or ''
 * (not yet checked). No thresholds — just what was seen. (VERIFY the list against CAN/ULC S537.)
 */
export const DEVICE_CHECKS = [
  { id: 'installed', label: 'Installed / present' },
  { id: 'correctType', label: 'Correct type & location' },
  { id: 'alarmAtPanel', label: 'Alarm received at panel' },
  { id: 'annunciation', label: 'Correct zone / address annunciation' },
  { id: 'audibilityVisibility', label: 'Audibility / visibility' },
];

/** Allowed values for a check and for a result. */
export const CHECK_VALUES = ['', 'pass', 'fail', 'na'];
export const RESULTS = ['pass', 'fail', 'incomplete'];

export const MAX_DEVICES = 400;

/** A new, blank device row of a type. */
export function newDevice(type = 'smoke') {
  const t = deviceTypeOf(type);
  const checks = {};
  for (const c of DEVICE_CHECKS) checks[c.id] = '';
  return { id: newId('d'), type: t.id, location: '', zone: '', address: '', checks, notes: '' };
}

/** A new verification for a building, optionally tied to a job. */
export function newVerification({ job = null, by = null, date = null } = {}) {
  return {
    id: newId('fa'),
    jobId: job?.id || null,
    clientId: job?.clientId || null,
    building: job?.title || '',
    address: job?.address || '',
    stage: 'initial', // initial | reverification | annual (VERIFY wording vs S537)
    panelMake: '',
    panelModel: '',
    panelType: '', // conventional | addressable | '' (VERIFY)
    zones: null,
    date: date || null,
    verifierName: '',
    verifierCert: '', // the verifier's certification / licence number
    devices: [],
    battery: { voltageV: null, alarmVoltageV: null, batteryAh: null, standbyOk: '', alarmOk: '', notes: '' },
    overallResult: 'incomplete',
    notes: '',
    signatureId: null,
    createdBy: by || null,
  };
}

/**
 * What the device as a whole shows, from the checks the tech recorded:
 *  - 'fail' if any check is 'fail',
 *  - 'pass' if at least one check is 'pass' and none fail (na/blank ignored),
 *  - 'pending' when nothing has been recorded yet.
 * This only summarises observed pass/fail; it is not an S537 acceptance judgement.
 */
export function deviceResult(device) {
  const checks = device?.checks || {};
  let anyPass = false;
  for (const c of DEVICE_CHECKS) {
    const v = checks[c.id];
    if (v === 'fail') return 'fail';
    if (v === 'pass') anyPass = true;
  }
  return anyPass ? 'pass' : 'pending';
}

/** Counts across the device list: total, pass, fail, pending (by deviceResult). */
export function summarizeDevices(devices) {
  const out = { total: 0, pass: 0, fail: 0, pending: 0 };
  for (const d of devices || []) {
    out.total++;
    out[deviceResult(d)]++;
  }
  return out;
}

/**
 * The overall result suggested from what was recorded. 'fail' if any device failed or the standby
 * check was marked failing; 'incomplete' while devices are still pending or nothing is recorded;
 * otherwise 'pass'. The verifier can still set the field by hand (what they certify is theirs).
 */
export function resultFrom(v) {
  const devices = v?.devices || [];
  const sum = summarizeDevices(devices);
  const bat = v?.battery || {};
  if (sum.fail > 0 || bat.standbyOk === 'fail' || bat.alarmOk === 'fail') return 'fail';
  if (sum.total === 0 || sum.pending > 0) return 'incomplete';
  return 'pass';
}

/** A short label for lists and the page title. */
export const verificationLabel = (v) => {
  const name = (v?.building || '').trim() || 'Fire-alarm verification';
  return `${name}${v?.date ? ` · ${v.date}` : ''}`;
};

export const RESULT_LABEL = { pass: 'Verified', fail: 'Deficiencies', incomplete: 'Incomplete' };
export const resultLabel = (r) => RESULT_LABEL[r] || 'Incomplete';
export const CHECK_LABEL = { pass: 'Pass', fail: 'Fail', na: 'N/A', '': '—' };
