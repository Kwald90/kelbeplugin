// Breaker and whole-panel templates for the panel schedule (S26). Offline-first and
// code-neutral: built-in libraries plus company-saved templates kept in company
// settings (settings.panelTemplates), which already sync. No server collection.
//
// A breaker template fills one circuit in a tap: { id, label, poles, amps, loadVA,
// breakerType, descriptionDefault, group }. loadVA is a typical estimate for balancing,
// nullable where it depends on the actual load (spares, feeders). A panel template is a
// whole-panel preset: { id, label, voltage, mainType, mainAmps, busAmps, slots,
// feedThrough, region }. voltage is a PANEL_SYSTEMS key (js/lib/cec/systems.js).

/** Breaker construction types, with labels for the picker. Stored on a circuit as `breakerType`. */
export const BREAKER_TYPES = {
  standard: 'Standard',
  gfci: 'GFCI',
  afci: 'AFCI',
  dual: 'Dual-function (AFCI/GFCI)',
  hacr: 'HACR',
  tandem: 'Tandem (half-space)',
  'lock-on': 'Lock-on',
};

export const BREAKER_TYPE_KEYS = Object.keys(BREAKER_TYPES);
export const breakerTypeLabel = (t) => BREAKER_TYPES[t] || BREAKER_TYPES.standard;

// Built-in breaker library. Canadian residential and light-commercial defaults. loadVA values
// are typical estimates (nameplate/trade rules of thumb), good enough for phase balancing; they
// are not a demand calculation. Grouped for the picker.
export const BUILT_IN_BREAKERS = [
  // Receptacles
  { id: 'recept-15', label: '15 A general receptacles', poles: 1, amps: 15, loadVA: 1440, breakerType: 'standard', descriptionDefault: 'Receptacles', group: 'Receptacles' },
  { id: 'recept-20', label: '20 A general receptacles', poles: 1, amps: 20, loadVA: 1920, breakerType: 'standard', descriptionDefault: 'Receptacles', group: 'Receptacles' },
  { id: 'recept-15-gfci', label: '15 A kitchen / bath receptacles (GFCI)', poles: 1, amps: 15, loadVA: 1440, breakerType: 'gfci', descriptionDefault: 'Kitchen / bath receptacles', group: 'Receptacles' },
  { id: 'recept-20-gfci', label: '20 A kitchen / bath receptacles (GFCI)', poles: 1, amps: 20, loadVA: 1500, breakerType: 'gfci', descriptionDefault: 'Counter receptacles', group: 'Receptacles' },
  // Lighting
  { id: 'light-15-afci', label: '15 A lighting (AFCI)', poles: 1, amps: 15, loadVA: 1200, breakerType: 'afci', descriptionDefault: 'Lighting', group: 'Lighting' },
  { id: 'light-20', label: '20 A lighting', poles: 1, amps: 20, loadVA: 1600, breakerType: 'standard', descriptionDefault: 'Lighting', group: 'Lighting' },
  // Appliances
  { id: 'laundry-20', label: '20 A laundry', poles: 1, amps: 20, loadVA: 1500, breakerType: 'standard', descriptionDefault: 'Laundry', group: 'Appliances' },
  { id: 'dryer-30', label: '30 A dryer (2-pole)', poles: 2, amps: 30, loadVA: 5000, breakerType: 'standard', descriptionDefault: 'Dryer', group: 'Appliances' },
  { id: 'range-40', label: '40 A range (2-pole)', poles: 2, amps: 40, loadVA: 8000, breakerType: 'standard', descriptionDefault: 'Range', group: 'Appliances' },
  { id: 'wh-30', label: '30 A water heater (2-pole)', poles: 2, amps: 30, loadVA: 4500, breakerType: 'standard', descriptionDefault: 'Water heater', group: 'Appliances' },
  // HVAC
  { id: 'ac-30', label: '30 A A/C or heat (2-pole, HACR)', poles: 2, amps: 30, loadVA: 5000, breakerType: 'hacr', descriptionDefault: 'Air conditioner', group: 'HVAC' },
  { id: 'ac-40', label: '40 A A/C or heat (2-pole, HACR)', poles: 2, amps: 40, loadVA: 7680, breakerType: 'hacr', descriptionDefault: 'Heat pump', group: 'HVAC' },
  { id: 'ac-50', label: '50 A A/C or heat (2-pole, HACR)', poles: 2, amps: 50, loadVA: 9600, breakerType: 'hacr', descriptionDefault: 'A/C or heat', group: 'HVAC' },
  // EV and special loads
  { id: 'ev-50', label: '50 A EV charger (2-pole)', poles: 2, amps: 50, loadVA: 9600, breakerType: 'standard', descriptionDefault: 'EV charger', group: 'EV & special' },
  { id: 'hottub-60-gfci', label: '60 A hot tub (2-pole, GFCI)', poles: 2, amps: 60, loadVA: 11520, breakerType: 'gfci', descriptionDefault: 'Hot tub', group: 'EV & special' },
  // Feeders
  { id: 'subfeed-100', label: '100 A sub-feed (2-pole)', poles: 2, amps: 100, loadVA: null, breakerType: 'standard', descriptionDefault: 'Sub-panel feed', group: 'Feeders', subFeed: true },
  { id: 'subfeed-60', label: '60 A sub-feed (2-pole)', poles: 2, amps: 60, loadVA: null, breakerType: 'standard', descriptionDefault: 'Sub-panel feed', group: 'Feeders', subFeed: true },
  // Other
  { id: 'spare', label: 'Spare', poles: 1, amps: 20, loadVA: 0, breakerType: 'standard', descriptionDefault: 'Spare', group: 'Other' },
  { id: 'space', label: 'Space (blank)', poles: 1, amps: null, loadVA: 0, breakerType: 'standard', descriptionDefault: 'Space', group: 'Other' },
];

// Built-in whole-panel presets. mainType: 'MLO' (main-lug-only, no main breaker — mainAmps is the
// feed/OCPD rating upstream) or 'MB' (main breaker). region: 'CA' | 'US' | 'CA US'.
export const BUILT_IN_PANELS = [
  { id: 'res-100', label: 'Residential 100 A · 120/240 V · 24 spaces', voltage: '120/240 1ph', mainType: 'MB', mainAmps: 100, busAmps: 100, slots: 24, feedThrough: false, region: 'CA US' },
  { id: 'res-125', label: 'Residential 125 A · 120/240 V · 32 spaces', voltage: '120/240 1ph', mainType: 'MB', mainAmps: 125, busAmps: 125, slots: 32, feedThrough: false, region: 'CA US' },
  { id: 'res-200', label: 'Residential 200 A · 120/240 V · 40 spaces', voltage: '120/240 1ph', mainType: 'MB', mainAmps: 200, busAmps: 200, slots: 40, feedThrough: false, region: 'CA US' },
  { id: 'comm-225-208', label: 'Commercial 225 A · 120/208 V 3φ · 42 spaces (MLO)', voltage: '208/120 3ph', mainType: 'MLO', mainAmps: 225, busAmps: 225, slots: 42, feedThrough: false, region: 'CA US' },
  { id: 'comm-400-208', label: 'Distribution 400 A · 120/208 V 3φ · 30 spaces (MB)', voltage: '208/120 3ph', mainType: 'MB', mainAmps: 400, busAmps: 400, slots: 30, feedThrough: true, region: 'CA US' },
  { id: 'comm-600-600', label: 'Distribution 600 A · 347/600 V 3φ · 42 spaces (MLO)', voltage: '347/600 3ph', mainType: 'MLO', mainAmps: 600, busAmps: 600, slots: 42, feedThrough: true, region: 'CA' },
  { id: 'comm-400-480', label: 'Commercial 400 A · 277/480 V 3φ · 42 spaces (MLO)', voltage: '480/277 3ph', mainType: 'MLO', mainAmps: 400, busAmps: 400, slots: 42, feedThrough: false, region: 'US' },
];

const custom = (settings, kind) => {
  const pt = settings?.panelTemplates;
  return pt && Array.isArray(pt[kind]) ? pt[kind] : [];
};

/** Built-in breaker templates (marked custom:false) merged with the company's saved ones (custom:true). */
export function listBreakerTemplates(settings) {
  const builtin = BUILT_IN_BREAKERS.map((t) => ({ ...t, custom: false }));
  const saved = custom(settings, 'breakers').map((t) => ({ ...t, custom: true }));
  return [...builtin, ...saved];
}

/** Built-in panel presets merged with any company-saved ones. */
export function listPanelTemplates(settings) {
  const builtin = BUILT_IN_PANELS.map((t) => ({ ...t, custom: false }));
  const saved = custom(settings, 'panels').map((t) => ({ ...t, custom: true }));
  return [...builtin, ...saved];
}

/** Fields a breaker template contributes to a circuit. Null amps leaves the current amps alone. */
export function applyBreakerTemplate(tpl, base = {}) {
  const out = { ...base };
  out.description = tpl.descriptionDefault ?? base.description ?? '';
  out.poles = Number(tpl.poles) || base.poles || 1;
  out.amps = tpl.amps == null ? (base.amps ?? 20) : Number(tpl.amps);
  out.loadVA = tpl.loadVA == null ? (base.loadVA ?? 0) : Number(tpl.loadVA);
  out.breakerType = tpl.breakerType || 'standard';
  if (tpl.subFeed) out.subFeed = true;
  return out;
}

/** Save the current breaker as a reusable company template. Returns the template id. */
export function saveBreakerTemplate(store, tpl) {
  const s = store.settings();
  const pt = s.panelTemplates || {};
  const breakers = Array.isArray(pt.breakers) ? pt.breakers : [];
  const id = tpl.id || `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const clean = {
    id,
    label: String(tpl.label || tpl.descriptionDefault || 'Custom breaker').slice(0, 200),
    poles: Number(tpl.poles) || 1,
    amps: tpl.amps == null ? null : Number(tpl.amps),
    loadVA: tpl.loadVA == null ? null : Number(tpl.loadVA),
    breakerType: tpl.breakerType || 'standard',
    descriptionDefault: String(tpl.descriptionDefault ?? ''),
    group: tpl.group || 'Company',
  };
  if (tpl.subFeed) clean.subFeed = true;
  const next = [...breakers.filter((t) => t.id !== id), clean];
  store.saveSettings({ panelTemplates: { ...pt, breakers: next } });
  return id;
}

/** Remove a company-saved breaker template by id. Built-ins are not removable. */
export function removeBreakerTemplate(store, id) {
  const s = store.settings();
  const pt = s.panelTemplates || {};
  const breakers = (Array.isArray(pt.breakers) ? pt.breakers : []).filter((t) => t.id !== id);
  store.saveSettings({ panelTemplates: { ...pt, breakers } });
}
