// Location tracking policy: the company's settings (settings.location), the notice text workers
// see before their first clock-in with location, and their consent records. Pure; see
// docs/compliance/privacy.md ("Location while clocked in") for why each default is what it is.
//
// settings.location = { enabled, policyText, policyVersion, defaultRadiusM, retentionDays, liveCrewMap }
// locationConsents record: { id: 'lc-<employeeId>-v<version>', employeeId, policyVersion, choice: 'granted'|'declined', at, via }

export const RETENTION_DEFAULT_DAYS = 90;
export const RETENTION_MIN_DAYS = 7;
export const RETENTION_MAX_DAYS = 730;
export const LOCATION_DEFAULTS = Object.freeze({
  enabled: true,
  policyText: '',
  policyVersion: 1,
  defaultRadiusM: 150,
  retentionDays: RETENTION_DEFAULT_DAYS,
  liveCrewMap: false,
});

export const clampRetention = (d) => {
  const n = Math.round(Number(d));
  return Number.isFinite(n) ? Math.min(RETENTION_MAX_DAYS, Math.max(RETENTION_MIN_DAYS, n)) : RETENTION_DEFAULT_DAYS;
};

/** The company's location settings with defaults filled in. */
export function locationSettings(settings) {
  const s = { ...LOCATION_DEFAULTS, ...(settings?.location || {}) };
  s.retentionDays = clampRetention(s.retentionDays);
  s.policyVersion = Math.max(1, Math.round(Number(s.policyVersion)) || 1);
  s.enabled = s.enabled !== false;
  s.liveCrewMap = s.liveCrewMap === true;
  return s;
}

/** The default notice. Plain words; the owner can replace it in Time clock > Location settings. */
export function defaultPolicyText(companyName = 'Your employer') {
  const co = String(companyName || '').trim() || 'Your employer';
  return [
    `${co} uses Fishtape to fill in your timesheet from where you are while you are clocked in: which job you are at, and the time you spend driving between jobs.`,
    '',
    'What is recorded: your location when you clock in, clock out, start travel or arrive at a job. In the iPhone and iPad app, if you allow it, the app also notices when you arrive at or leave a job site, without tracking your route.',
    '',
    'When: only while you are clocked in. Clocking out stops it. Nothing is recorded on breaks you take off the clock, on your way home after clocking out, or on days off.',
    '',
    'Why: to record your hours and travel time against the right job, and to check timesheets before payroll. It is not sold or used for advertising.',
    '',
    'Who sees it: you can see every location record about you under Time clock > My location. Your foreman and the office see your time entries, including how far a clock-in was from the job site.',
    '',
    'Your choice: you can say no and still clock in; your foreman may then ask you to confirm your times. You can change your answer at any time under Time clock > My location.',
    '',
    `Questions or a request to see or correct your information: ask ${co}'s office.`,
  ].join('\n');
}

/** The policy text to show: the owner's, or the default. */
export const policyTextFor = (settings) => (locationSettings(settings).policyText || '').trim() || defaultPolicyText(settings?.company?.name);

/** Facts about the current settings, always shown under the policy text so it can't go stale. */
export function policyFacts(settings) {
  const s = locationSettings(settings);
  return [
    `Raw location points are deleted after ${s.retentionDays} days. Time entries stay as payroll records.`,
    s.liveCrewMap
      ? 'Live crew map is ON: managers can see your latest location on a map, only while you are clocked in.'
      : 'Live crew map is off: managers see time entries, not where you are right now.',
    'Each job site has a radius (usually 150 m); arriving inside it counts as being at the job.',
  ];
}

export const consentId = (employeeId, version) => `lc-${String(employeeId).replace(/[^A-Za-z0-9._:-]/g, '')}-v${version}`;

/** This person's answer for the current policy version, or null if not asked yet. */
export function currentConsent(consents, employeeId, settings) {
  const v = locationSettings(settings).policyVersion;
  return (consents || []).filter((c) => c.employeeId === employeeId && Number(c.policyVersion) === v)
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))[0] || null;
}

/**
 * What the clock should do about location for this person:
 *   'off'      the company turned location off
 *   'ask'      show the notice and ask (first time, or the policy changed)
 *   'granted'  capture fixes while clocked in
 *   'declined' never capture
 */
export function locationState(consents, employeeId, settings) {
  if (!employeeId || !locationSettings(settings).enabled) return 'off';
  const c = currentConsent(consents, employeeId, settings);
  if (!c) return 'ask';
  return c.choice === 'granted' ? 'granted' : 'declined';
}

/** The record to save for an answer. */
export function consentRecord(employeeId, settings, choice, { at = new Date().toISOString(), via = 'web' } = {}) {
  const v = locationSettings(settings).policyVersion;
  return { id: consentId(employeeId, v), employeeId, policyVersion: v, choice: choice === 'granted' ? 'granted' : 'declined', at, via };
}

/** Points older than the retention window (the server deletes them too; devices prune locally). */
export function expiredPoints(points, settings, now = Date.now()) {
  const cutoff = now - locationSettings(settings).retentionDays * 86_400_000;
  return (points || []).filter((p) => Date.parse(p.at) < cutoff);
}
