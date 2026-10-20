// Module switches: which parts of the app a company uses (Settings → Modules), separate from
// what its plan includes (plans.js). Stored as settings.modules = { [switchId]: boolean }.
//
//  - settings.modules missing (companies from before switches, the demo): everything is on.
//  - a switch missing from the object (one added later): its `core` default.
//
// A switch that is off hides its screens everywhere (rail, wheel, dashboard, links, bell,
// onboarding). Nothing is deleted: turning it back on brings every record back. The server
// refuses writes into a turned-off module's collections (module_turned_off) and never hides
// existing data from reads. Pure: shared by the PWA and the server (server/src/services/modules.js).

/** Groups in Settings → Modules, in order. */
export const SWITCH_GROUPS = [
  { id: 'work', label: 'Jobs and the field' },
  { id: 'money', label: 'Money' },
  { id: 'people', label: 'People and safety' },
  { id: 'sales', label: 'Sales' },
  { id: 'extras', label: 'Extras' },
];

/**
 * Every switch. `modules` are the screens (module ids in modules/index.js) it shows; `core`
 * is on for a new company. `needs` names a switch it depends on (shown, not enforced).
 */
export const SWITCHES = [
  { id: 'schedule', group: 'work', label: 'Schedule', desc: 'Who is on which job, day by day.', modules: ['schedule'], core: true },
  { id: 'drawings', group: 'work', label: 'Drawings', desc: 'Plans, markup and takeoff on an endless canvas.', modules: ['drawings'], core: true },
  { id: 'materials', group: 'work', label: 'Material requests', desc: 'Crew ask for material; the office gets one list a day.', modules: ['materials'], core: true },
  { id: 'calcs', group: 'work', label: 'Code calculators', desc: 'Voltage drop, conductor sizing, box fill and more.', modules: ['calcs'], core: true },
  { id: 'workplan', group: 'work', label: 'Work plans', desc: 'Daily task lists, My day, the morning meeting and crew KPIs.', modules: ['workplan', 'today'] },
  { id: 'wireruns', group: 'work', label: 'Wire runs', desc: 'Measured runs with allowances, pushed to estimates.', modules: ['wireruns'] },
  { id: 'panels', group: 'work', label: 'Panel schedules', desc: 'Circuits, loads and printable directories.', modules: ['panels'] },
  { id: 'bending', group: 'work', label: 'Pipe bending', desc: 'Offsets, saddles and kicks with marks.', modules: ['bending'] },
  { id: 'estimates', group: 'money', label: 'Estimates', desc: 'Quotes from the price book and drawing takeoffs.', modules: ['estimates'], core: true },
  { id: 'invoices', group: 'money', label: 'Invoices', desc: 'Billing, payments and what is owed.', modules: ['invoices'], core: true },
  { id: 'pricebook', group: 'money', label: 'Price book', desc: 'Your items with cost and sell prices.', modules: [], core: true },
  { id: 'inventory', group: 'money', label: 'Stock', desc: 'Stock in the shop and vans, and what moved where.', modules: [] },
  { id: 'purchasing', group: 'money', label: 'Purchasing', desc: 'Suppliers, bills, receipts and purchase orders.', modules: ['purchasing'] },
  { id: 'time', group: 'people', label: 'Time clock', desc: 'Clock in and out against jobs; weekly timesheets.', modules: ['time'], core: true },
  { id: 'employees', group: 'people', label: 'Employees', desc: 'Crew records, licences and pay rates.', modules: ['employees'], core: true },
  { id: 'safety', group: 'people', label: 'Safety', desc: 'Hazard assessments, toolbox talks and incidents.', modules: ['safety'], core: true },
  { id: 'sops', group: 'people', label: 'SOPs', desc: 'Procedures the crew read and sign.', modules: ['sops'] },
  { id: 'compliance', group: 'people', label: 'Permits and compliance', desc: 'Permits, inspections and certifications.', modules: ['compliance'] },
  { id: 'clients', group: 'sales', label: 'Clients', desc: 'Customer list with jobs and balances.', modules: ['clients'], core: true },
  { id: 'leads', group: 'sales', label: 'Leads', desc: 'A pipeline for enquiries before they become jobs.', modules: ['leads'] },
  { id: 'sequences', group: 'sales', label: 'Follow-ups', desc: 'Automatic follow-up emails and texts.', modules: ['sequences'], needs: 'leads' },
  { id: 'assistant', group: 'extras', label: 'AI assistant', desc: 'Drafts estimates and answers code questions.', modules: ['assistant'] },
  { id: 'integrations', group: 'extras', label: 'Integrations', desc: 'Card payments, email and texts from your own accounts.', modules: ['integrations'], core: true },
  { id: 'security', group: 'extras', label: 'Security checklist', desc: 'Device and account checks for the office.', modules: ['security'] },
];

export const SWITCH_BY_ID = Object.fromEntries(SWITCHES.map((s) => [s.id, s]));

/** Module ids no switch can turn off (the shell, settings and the job list everything hangs off). */
export const ALWAYS_ON = ['dashboard', 'jobs', 'settings', 'billing', 'help', 'notifications', 'onboarding', 'account', 'import', 'developer'];

/** Switches that show a module. The Inventory screen holds the price book and the stock. */
const MODULE_SWITCHES = { inventory: ['pricebook', 'inventory'], kpis: ['workplan'] };
for (const s of SWITCHES) for (const m of s.modules) (MODULE_SWITCHES[m] ||= []).push(s.id);

/** Presets in Settings → Modules. */
export const PRESETS = {
  core: { label: 'Recommended', desc: 'What most shops use every week.', on: SWITCHES.filter((s) => s.core).map((s) => s.id) },
  simple: { label: 'Simple mode', desc: 'Jobs, schedule, time, drawings, estimates and invoices only.', on: ['schedule', 'time', 'drawings', 'estimates', 'invoices'] },
  all: { label: 'Everything', desc: 'Every module your plan includes.', on: SWITCHES.map((s) => s.id) },
};

/** A full { id: boolean } map for a preset. */
export function presetModules(preset) {
  const on = new Set(PRESETS[preset]?.on || PRESETS.core.on);
  return Object.fromEntries(SWITCHES.map((s) => [s.id, on.has(s.id)]));
}

/** New companies start with the recommended set (store.js DEFAULT_SETTINGS). */
export const DEFAULT_MODULES = presetModules('core');

/** Is a switch on? `settings` is the company settings record (or anything with `.modules`). */
export function switchOn(settings, id) {
  const m = settings?.modules;
  const sw = SWITCH_BY_ID[id];
  if (!sw || !m || typeof m !== 'object') return true;
  if (Object.hasOwn(m, id)) return m[id] !== false;
  return Boolean(sw.core);
}

/** Is a screen (module id) on? A screen two switches show is on when either is. */
export function moduleOn(settings, moduleId) {
  if (!moduleId || ALWAYS_ON.includes(moduleId)) return true;
  const sws = MODULE_SWITCHES[moduleId];
  if (!sws) return true;
  return sws.some((id) => switchOn(settings, id));
}

/** The module an app link points at: '#/invoices/abc?x=1' -> 'invoices'. Null for other links. */
export function hrefModule(href) {
  const m = /^#\/?([A-Za-z0-9_-]+)/.exec(String(href || ''));
  return m ? m[1] : null;
}

/** Is an app link's target on? Links that are not app routes always are. */
export const linkOn = (settings, href) => moduleOn(settings, hrefModule(href));

/** The full map to store: every switch with its current value, after `patch`. */
export function nextModules(settings, patch = {}) {
  const out = Object.fromEntries(SWITCHES.map((s) => [s.id, switchOn(settings, s.id)]));
  for (const [k, v] of Object.entries(patch)) if (SWITCH_BY_ID[k]) out[k] = Boolean(v);
  return out;
}

/** Which preset the map matches, or 'custom'. */
export function presetOf(settings) {
  const cur = nextModules(settings);
  for (const [id, p] of Object.entries(PRESETS)) {
    const on = new Set(p.on);
    if (SWITCHES.every((s) => cur[s.id] === on.has(s.id))) return id;
  }
  return 'custom';
}

/**
 * The switch(es) that own each collection: a write needs one of them on. Collections not listed
 * (clients, jobs, settings, employees, outbox, auditLog) are shared by many screens and always
 * writable. Mirrors COLLECTION_FEATURES in server/src/services/entitlements.js.
 */
export const COLLECTION_SWITCHES = {
  leads: ['leads'],
  sequences: ['sequences'],
  enrolments: ['sequences'],
  schedule: ['schedule'],
  estimates: ['estimates'],
  invoices: ['invoices'],
  payments: ['invoices'],
  items: ['pricebook', 'inventory'],
  locations: ['inventory'],
  stockMoves: ['inventory'],
  timeEntries: ['time'],
  drawings: ['drawings'],
  wireRuns: ['wireruns'],
  bends: ['bending'],
  benderProfiles: ['bending'],
  panels: ['panels'],
  sops: ['sops'],
  permits: ['compliance'],
  inspections: ['compliance'],
  certifications: ['compliance', 'employees'],
  checklists: ['compliance', 'security'],
  flhas: ['safety'],
  toolboxTalks: ['safety'],
  incidents: ['safety'],
  correctiveActions: ['safety'],
  safetyInspections: ['safety'],
  siteOrientations: ['safety'],
  jobSafety: ['safety'],
  workPlans: ['workplan'],
  workTasks: ['workplan'],
  taskTemplates: ['workplan'],
  huddles: ['workplan'],
  materialRequests: ['materials'],
  locationPoints: ['time'],
  locationConsents: ['time'],
  vendors: ['purchasing'],
  bills: ['purchasing'],
  purchaseOrders: ['purchasing'],
};

/** The switch that blocks a write to `coll`, or null when the write is allowed. */
export function blockingSwitch(settings, coll) {
  const sws = COLLECTION_SWITCHES[coll];
  if (!sws || sws.some((id) => switchOn(settings, id))) return null;
  return sws[0];
}

/** "Invoices is turned off for this company…" for a switch id. */
export function turnedOffMessage(id) {
  const label = SWITCH_BY_ID[id]?.label || id;
  return `${label} is turned off for this company. An owner or admin can turn it back on in Settings → Modules.`;
}
