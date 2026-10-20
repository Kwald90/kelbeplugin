// Screens and sheets for location while clocked in: the notice and consent dialog, the job-site
// editor (map, address lookup, pin, radius), My location (a worker's own points), the owner's
// location and payroll settings, and the opt-in live crew map. The time clock (modules/time.js)
// and the job screen (modules/jobs.js) use these.
import { locationSettings, locationState, consentRecord, currentConsent, policyTextFor, policyFacts, defaultPolicyText, clampRetention } from './location-policy.js';
import { siteOf, clampRadius, fmtDistance, nearestSites, sitesOf } from './geo.js';
import { geocodeAddress } from './geocode.js';
import { miniMap, fitZoom, centerOf } from './minimap.js';
import { isNative } from './location.js';
import { OT_RULE_CHOICES, otRule, ruleText, PAYROLL_FORMATS } from './timesheet.js';

const paragraphs = (h, text) => String(text || '').split(/\n\s*\n/).map((p) => h('p', null, p.trim())).filter((p) => p.textContent);

/** The notice: policy text plus the facts of the current settings. */
export function policyBlock(ctx) {
  const { store, ui } = ctx;
  const { h } = ui;
  const settings = store.settings();
  return h('div', { class: 'loc-policy' }, paragraphs(h, policyTextFor(settings)),
    h('ul', { class: 'loc-facts' }, policyFacts(settings).map((f) => h('li', null, f))));
}

/**
 * Show the notice and ask, the first time (and again whenever the owner changes the policy).
 * Resolves 'granted' | 'declined' | 'off' | 'later' (closed without answering: nothing is recorded,
 * nothing is captured, and it asks again next time).
 */
export function ensureConsent(ctx, employeeId) {
  const { store, ui } = ctx;
  const { h } = ui;
  const state = locationState(store.list('locationConsents'), employeeId, store.settings());
  if (state !== 'ask') return Promise.resolve(state);
  return new Promise((resolve) => {
    let answered = false;
    const answer = (choice) => {
      answered = true;
      saveConsent(ctx, employeeId, choice);
      resolve(choice);
      s.close();
    };
    const s = ui.openSheet({
      title: 'Location while you are clocked in', dialog: true,
      body: h('div', { class: 'stack loc-consent' }, policyBlock(ctx)),
      actions: [
        ui.button('No thanks', { variant: 'ghost', onClick: () => answer('declined') }),
        ui.button('Allow while clocked in', { variant: 'primary', icon: 'check', onClick: () => answer('granted') }),
      ],
      onClose: () => { if (!answered) resolve('later'); },
    });
  });
}

/** Record (or change) this person's answer for the current policy version. */
export function saveConsent(ctx, employeeId, choice) {
  const { store } = ctx;
  const rec = consentRecord(employeeId, store.settings(), choice, { via: isNative() ? 'ios' : 'web' });
  if (store.get('locationConsents', rec.id)) store.update('locationConsents', rec.id, { choice: rec.choice, at: rec.at, via: rec.via });
  else store.add('locationConsents', rec);
  store.log('location-consent', `Location ${rec.choice === 'granted' ? 'allowed' : 'declined'} (policy v${rec.policyVersion})`, 'locationConsents', rec.id);
  return rec;
}

// ---- job site ----------------------------------------------------------------------------

/** The job's site card: map, and for managers the address lookup, pin drop and radius. */
export function siteCard(ctx, job, { canEdit = false } = {}) {
  const { store, ui, auth } = ctx;
  const { h } = ui;
  const ls = locationSettings(store.settings());
  const site = siteOf(job, ls.defaultRadiusM);
  let picking = !site && canEdit;
  let radius = site?.radiusM || ls.defaultRadiusM;
  const status = h('div', { class: 'muted loc-site-status', role: 'status' });
  const save = (patch, msg) => {
    const cur = store.get('jobs', job.id);
    const next = { ...(cur.site || {}), radiusM: radius, ...patch, setAt: new Date().toISOString(), setBy: auth.current().id || null };
    store.update('jobs', job.id, { site: next }, { summary: `site location for ${job.number}` });
    ui.toast(msg, 'success');
  };
  const map = miniMap({
    h, height: 220, label: `Map of the site for ${job.number}`,
    center: site || centerOf(sitesOf(store.list('jobs'), ls.defaultRadiusM)), zoom: site ? 16 : 11,
    circle: site ? { lat: site.lat, lng: site.lng, radiusM: site.radiusM } : null,
    markers: site ? [{ lat: site.lat, lng: site.lng, kind: 'site', title: job.number }] : [],
    onPick: canEdit ? (p) => {
      if (!picking) { ui.clear(status).append('Tap "Move pin" first, then tap the map.'); return; }
      picking = false;
      save({ lat: p.lat, lng: p.lng, source: 'pin', label: 'Pin dropped on the map' }, 'Site pin saved');
    } : null,
  });
  const radiusInput = h('input', { class: 'input loc-radius', type: 'number', min: '30', max: '2000', step: '10', value: String(radius), 'aria-label': 'Site radius in metres',
    onChange: (e) => { radius = clampRadius(e.target.value, ls.defaultRadiusM); e.target.value = String(radius); if (siteOf(store.get('jobs', job.id))) save({}, `Radius ${radius} m`); } });
  const find = async () => {
    const addr = store.get('jobs', job.id)?.address || '';
    ui.clear(status).append('Looking up the address…');
    try {
      const [best, ...rest] = await geocodeAddress(addr, { province: store.settings().company?.province });
      save({ lat: best.lat, lng: best.lng, source: 'geocode', label: best.label }, `Found: ${best.label}`);
      ui.clear(status).append(best.approximate ? 'Approximate position: check the pin and move it if needed.' : '', rest.length ? ` ${rest.length} other match${rest.length === 1 ? '' : 'es'}; move the pin if this is the wrong one.` : '');
    } catch (e) {
      ui.clear(status).append(e.message);
    }
  };
  const controls = canEdit ? h('div', { class: 'row loc-site-actions' },
    job.address ? ui.button('Find address', { icon: 'search', size: 'sm', onClick: find }) : null,
    ui.button(site ? 'Move pin' : 'Drop pin', { icon: 'map-pin', size: 'sm', onClick: () => { picking = true; ui.clear(status).append('Tap the map where the site is.'); } }),
    h('label', { class: 'row loc-radius-field' }, h('span', { class: 'muted' }, 'Radius'), radiusInput, h('span', { class: 'muted' }, 'm')),
    site ? ui.button('Remove', { variant: 'ghost danger', size: 'sm', onClick: () => { store.update('jobs', job.id, { site: null }); ui.toast('Site location removed'); } }) : null) : null;
  if (picking) status.append(job.address ? 'No site location yet. Find the address, or drop a pin on the map.' : 'No site location yet. Tap the map where the site is.');
  return h('div', { class: 'card loc-site' },
    h('div', { class: 'row' }, h('h3', { class: 'grow', style: { margin: 0 } }, 'Site location'),
      site ? ui.badge(`${fmtDistance(site.radiusM)} radius`, 'info') : ui.badge('not set', 'warning')),
    site ? h('div', { class: 'muted' }, job.site.label || `${site.lat.toFixed(5)}, ${site.lng.toFixed(5)}`) : null,
    map.el, controls, status,
    h('p', { class: 'muted loc-small' }, 'Clock-ins inside this circle count as at the job; travel between job sites is recorded as travel time.'));
}

// ---- My location -------------------------------------------------------------------------

const SOURCE = { 'clock-in': 'Clocked in', 'clock-out': 'Clocked out', travel: 'Started travel', arrive: 'Arrived', check: 'Check while clocked in', enter: 'Arrived at a site (background)', exit: 'Left a site (background)', significant: 'Moved (background)' };

/** A worker's own location history and consent. Only their own points ever reach this device. */
export function myLocation(ctx, employeeId) {
  const { store, ui } = ctx;
  const { h } = ui;
  const settings = store.settings();
  const ls = locationSettings(settings);
  const consent = currentConsent(store.list('locationConsents'), employeeId, settings);
  const state = locationState(store.list('locationConsents'), employeeId, settings);
  const points = store.list('locationPoints', (p) => p.employeeId === employeeId).sort((a, b) => b.at.localeCompare(a.at));
  const sites = sitesOf(store.list('jobs'), ls.defaultRadiusM);
  const jobs = new Map(store.list('jobs').map((j) => [j.id, j]));
  const byDay = new Map();
  for (const p of points) { const d = ui.localDay(p.at); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(p); }
  const latestDay = [...byDay.keys()][0];
  const dayPoints = latestDay ? byDay.get(latestDay) : [];
  const near = (p) => { const n = nearestSites(p, sites)[0]; if (!n) return ''; const j = jobs.get(n.site.id); return n.inside ? `at ${j?.number || 'a job'}` : `${fmtDistance(n.distanceM)} from ${j?.number || 'a job'}`; };
  const stateText = { off: 'Your company has location turned off.', ask: "You haven't answered yet. You'll be asked the next time you clock in.", granted: 'Allowed while you are clocked in.', declined: 'Not allowed. Your time is recorded without location.' }[state];
  return h('div', { class: 'stack' },
    h('div', { class: 'card stack' },
      h('div', { class: 'row' }, h('strong', { class: 'grow' }, 'Your answer'), ui.badge(state === 'granted' ? 'allowed' : state === 'declined' ? 'declined' : state === 'off' ? 'off' : 'not asked', state === 'granted' ? 'success' : 'neutral')),
      h('p', { style: { margin: 0 } }, stateText, consent?.at ? h('span', { class: 'muted' }, ` (${ui.fmtDateTime(consent.at)})`) : null),
      state === 'off' || !employeeId ? null : h('div', { class: 'row' },
        state !== 'granted' ? ui.button('Allow while clocked in', { variant: 'primary', size: 'sm', onClick: () => { saveConsent(ctx, employeeId, 'granted'); ui.toast('Location allowed while you are clocked in', 'success'); } }) : null,
        state !== 'declined' ? ui.button('Stop using my location', { variant: 'ghost', size: 'sm', onClick: () => { saveConsent(ctx, employeeId, 'declined'); ui.toast('Location turned off for you'); } }) : null),
      h('details', { class: 'loc-details' }, h('summary', null, "Read the company's location policy"), policyBlock(ctx))),
    h('h2', { class: 'section' }, 'Your location records'),
    h('p', { class: 'muted', style: { marginTop: 0 } }, `Only you can see these. They are deleted after ${ls.retentionDays} days; your time entries stay.`),
    // Map tiles only around job sites: a tile request never shows where you were off site.
    dayPoints.length ? miniMap({ h, height: 220, label: 'Map of your location records', center: centerOf(dayPoints), zoom: fitZoom(dayPoints), tilesNear: sites,
      markers: dayPoints.map((p, i) => ({ lat: p.lat, lng: p.lng, kind: 'point', label: String(dayPoints.length - i), title: ui.fmtTime(p.at) })) }).el : null,
    points.length ? [...byDay].map(([day, list]) => h('div', { class: 'stack loc-day' },
      h('h3', { class: 'loc-dayhead' }, ui.fmtDate(day, { weekday: 'long', month: 'short', day: 'numeric' })),
      h('div', { class: 'list' }, list.map((p) => h('div', { class: 'list-row' },
        h('span', { class: 'num loc-time' }, ui.fmtTime(p.at)),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, SOURCE[p.source] || p.source || 'Location'), h('div', { class: 'meta' }, [near(p), p.accuracyM != null ? `±${p.accuracyM} m` : null].filter(Boolean).join(' · '))))))))
      : ui.empty({ icon: 'map-pin', title: 'No location records', text: state === 'granted' ? 'Records appear here when you clock in, travel and clock out.' : 'Nothing has been recorded about where you are.' }));
}

// ---- settings ----------------------------------------------------------------------------

/** Owner/admin: location policy, retention, radius, live crew map; payroll rules and format. */
export function settingsForm(ctx) {
  const { store, ui } = ctx;
  const { h } = ui;
  const settings = store.settings();
  const ls = locationSettings(settings);
  const pay = settings.payroll || {};
  const province = settings.company?.province || 'ON';
  const text = h('textarea', { class: 'input loc-policy-text', name: 'policyText', rows: 12, 'aria-label': 'Location policy text' }, ls.policyText || defaultPolicyText(settings.company?.name));
  const form = h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); submit(); } },
    h('div', { class: 'card stack' },
      h('h3', { style: { margin: 0 } }, 'Location while clocked in'),
      ui.field({ label: 'Use location on the time clock', name: 'enabled', type: 'checkbox', value: ls.enabled, span: true }),
      h('label', { class: 'field' }, h('span', null, 'Policy shown to each worker before their first clock-in'), text,
        h('span', { class: 'hint' }, 'Workers are asked again whenever you change this text, the live map or the retention period.')),
      h('div', null, ui.button('Use the default wording', { size: 'sm', variant: 'ghost', onClick: () => { text.value = defaultPolicyText(settings.company?.name); } })),
      ui.formGrid([
        { label: 'Default site radius (m)', name: 'defaultRadiusM', type: 'number', min: '30', max: '2000', step: '10', value: ls.defaultRadiusM },
        { label: 'Delete raw location points after (days)', name: 'retentionDays', type: 'number', min: '7', max: '730', value: ls.retentionDays, hint: '90 recommended. Time entries are kept.' },
      ]),
      ui.field({ label: 'Live crew map while clocked in (managers see each person\'s latest location)', name: 'liveCrewMap', type: 'checkbox', value: ls.liveCrewMap, span: true }),
      h('p', { class: 'muted loc-small', style: { margin: 0 } }, 'Off by default. Turning it on is a bigger privacy step: workers are told and asked again, and every view of the map is logged.')),
    h('div', { class: 'card stack' },
      h('h3', { style: { margin: 0 } }, 'Timesheets and payroll'),
      ui.formGrid([
        { label: 'Overtime rule', name: 'otRule', type: 'select', value: pay.otRule || province, options: OT_RULE_CHOICES.map((c) => ({ value: c.id, label: c.label + (c.id === province ? ' (your province)' : '') })) },
        { label: 'Payroll week starts', name: 'weekStartsOn', type: 'select', value: String(pay.weekStartsOn ?? 1), options: [{ value: '1', label: 'Monday' }, { value: '0', label: 'Sunday' }] },
        { label: 'Payroll export', name: 'format', type: 'select', value: pay.format || 'wagepoint', options: Object.entries(PAYROLL_FORMATS).map(([value, f]) => ({ value, label: f.label })) },
      ]),
      h('p', { class: 'muted loc-small', style: { margin: 0 } }, ruleText(otRule(pay.otRule || province))),
      otRule(pay.otRule || province).note ? h('p', { class: 'muted loc-small', style: { margin: 0 } }, otRule(pay.otRule || province).note) : null),
    h('div', { class: 'row' }, h('span', { class: 'grow' }), ui.button('Save settings', { variant: 'primary', icon: 'check', type: 'submit' })));
  function submit() {
    const v = ui.readForm(form);
    const next = {
      enabled: !!v.enabled, policyText: String(v.policyText || '').trim() === defaultPolicyText(settings.company?.name).trim() ? '' : String(v.policyText || '').trim().slice(0, 8000),
      defaultRadiusM: clampRadius(v.defaultRadiusM, 150), retentionDays: clampRetention(v.retentionDays), liveCrewMap: !!v.liveCrewMap,
    };
    const changed = next.policyText !== (ls.policyText || '') || next.liveCrewMap !== ls.liveCrewMap || next.retentionDays !== ls.retentionDays;
    next.policyVersion = ls.policyVersion + (changed ? 1 : 0);
    store.saveSettings({ location: next, payroll: { ...(settings.payroll || {}), otRule: v.otRule, weekStartsOn: Number(v.weekStartsOn), format: v.format } });
    ui.toast(changed ? 'Saved. Workers will see the new policy at their next clock-in.' : 'Saved', 'success', 3500);
  }
  return form;
}

// ---- live crew map (opt-in) --------------------------------------------------------------

/** Managers, only when the company turned it on. Synced: from the API; demo: from this device. */
export function crewMap(ctx) {
  const { store, ui, app } = ctx;
  const { h } = ui;
  const host = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading…'));
  const people = new Map(store.list('employees').map((e) => [e.id, e]));
  const jobs = new Map(store.list('jobs').map((j) => [j.id, j]));
  const ls = locationSettings(store.settings());
  const paint = (crew) => {
    const sites = sitesOf([...jobs.values()], ls.defaultRadiusM);
    const pts = crew.map((c) => ({ ...c, person: people.get(c.employeeId) }));
    const all = [...pts, ...sites];
    ui.clear(host).append(
      h('p', { class: 'muted', style: { margin: 0 } }, `Latest location of each person clocked in now (last 12 hours). Nobody off the clock is shown. Views are logged.`),
      miniMap({ h, height: 320, label: 'Crew map', center: centerOf(all), zoom: fitZoom(all, 360, 320), tilesNear: sites,
        markers: [...sites.map((s) => ({ lat: s.lat, lng: s.lng, kind: 'site', title: jobs.get(s.id)?.number })), ...pts.map((p) => ({ lat: p.lat, lng: p.lng, kind: 'crew', label: ui.initials(p.person?.name), title: p.person?.name }))] }).el,
      pts.length ? h('div', { class: 'list' }, pts.map((p) => h('div', { class: 'list-row' },
        h('span', { class: 'avatar', style: { background: p.person?.color || '#5f5a51' } }, ui.initials(p.person?.name)),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, p.person?.name || 'Someone'), h('div', { class: 'meta' }, `${p.kind === 'travel' ? 'Travelling' : 'Working'}${jobs.get(p.jobId) ? ` · ${jobs.get(p.jobId).number}` : ''} · ${ui.fmtTime(p.at)}${p.accuracyM != null ? ` · ±${p.accuracyM} m` : ''}`)))))
        : h('p', { class: 'muted' }, 'Nobody clocked in has a recent location.'));
  };
  if (store.synced && app?.api) {
    app.api.get('/api/v1/location/live').then((r) => paint(r.crew || [])).catch((e) => { ui.clear(host).append(h('p', { class: 'muted' }, e.message || 'The crew map is not available.')); });
  } else {
    // Demo on one device: every record is local anyway.
    const open = store.list('timeEntries', (t) => t.clockIn && !t.clockOut);
    const crew = open.map((t) => {
      const p = store.list('locationPoints', (x) => x.employeeId === t.employeeId && x.at >= t.clockIn).sort((a, b) => b.at.localeCompare(a.at))[0];
      return p ? { employeeId: t.employeeId, at: p.at, lat: p.lat, lng: p.lng, accuracyM: p.accuracyM, jobId: t.jobId, kind: t.kind === 'travel' ? 'travel' : 'work' } : null;
    }).filter(Boolean);
    queueMicrotask(() => paint(crew));
  }
  return host;
}
