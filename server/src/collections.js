// The collection registry: one entry per collection in electrical-app/js/store.js.
// It drives the tenant tables (scripts/gen-collections-sql.js writes
// migrations/0003_collections.sql from it), the REST routes, sync and access rules.

/** Same list and order as COLLECTIONS in electrical-app/js/store.js (checked by test/unit.test.js). */
export const COLLECTIONS = [
  'clients', 'leads', 'sequences', 'enrolments', 'outbox', 'jobs', 'schedule',
  'estimates', 'invoices', 'payments', 'items', 'locations', 'stockMoves',
  'employees', 'timeEntries', 'drawings', 'sops', 'permits', 'inspections',
  'certifications', 'checklists', 'panels', 'auditLog', 'settings',
  'wireRuns', 'bends', 'benderProfiles',
  'workPlans', 'workTasks', 'taskTemplates', 'huddles',
];

/** auditLog is not a table: it is a view over audit_events (append-only, server-written). */
export const AUDIT_COLLECTION = 'auditLog';

const KB = 1024;
const MB = 1024 * KB;

/** Default max size of one record's JSON body. */
export const DEFAULT_MAX_BYTES = 512 * KB;

/**
 * Generated column → JSON field. Each becomes `<col> text GENERATED ALWAYS AS (data->>'<field>') STORED`
 * with an index on (tenant_id, <col>).
 * @typedef {{ col: string, field: string }} GenCol
 */
const g = (col, field) => ({ col, field });
const CLIENT = g('client_id', 'clientId');
const JOB = g('job_id', 'jobId');
const STATUS = g('status', 'status');
const NUMBER = g('number', 'number');
const EMPLOYEE = g('employee_id', 'employeeId');

/**
 * @typedef {object} CollectionDef
 * @property {string} name        collection name used by the PWA and the API
 * @property {string} table       Postgres table
 * @property {GenCol[]} gen       generated columns (filters + indexes)
 * @property {string[]} read      permission keys, any of which allows reading
 * @property {string[]} write     permission keys, any of which allows writing
 * @property {boolean} [managerWrite]  writes also need a manager role (owner/admin/office/foreman)
 * @property {boolean} [ownRows]  non-managers only see and write rows whose employeeId is theirs
 * @property {{ field: string, values: string[] }} [ownRowsHide]  of their own rows, non-managers never see these
 *                                (the field needs a generated column)
 * @property {string} [migration] the migration that creates the table (default 0003_collections)
 * @property {'self'|'client'|null} portal  which rows a client-portal session may read
 * @property {number} maxBytes    max JSON size of one record
 * @property {string[]} [readAll] true when every member may read (settings)
 */

// Every role has "dashboard", so it only grants reads the dashboard shows to everyone
// (jobs, schedule, own time, crew, stock alerts, expiring certifications); money and
// sales data need their own permission, as the dashboard module itself checks.
/** @type {Record<string, Omit<CollectionDef, 'name'>>} */
const DEFS = {
  clients: { table: 'clients', gen: [], read: ['clients', 'leads', 'jobs', 'estimates', 'invoices', 'schedule', 'compliance', 'panels', 'drawings', 'dashboard'], write: ['clients', 'leads'], portal: 'self' },
  leads: { table: 'leads', gen: [CLIENT, g('status', 'stage')], read: ['leads', 'sequences', 'estimates', 'clients'], write: ['leads', 'estimates', 'sequences'], portal: 'client' },
  sequences: { table: 'sequences', gen: [], read: ['sequences', 'leads'], write: ['sequences'], portal: null },
  enrolments: { table: 'enrolments', gen: [g('lead_id', 'leadId'), g('sequence_id', 'sequenceId'), STATUS], read: ['sequences', 'leads'], write: ['sequences', 'leads'], portal: null },
  outbox: { table: 'outbox', gen: [STATUS, g('related_id', 'relatedId')], read: ['sequences', 'leads', 'estimates', 'invoices'], write: ['sequences', 'leads', 'estimates', 'invoices'], portal: null },
  jobs: { table: 'jobs', gen: [CLIENT, STATUS, NUMBER], read: ['jobs', 'schedule', 'time', 'drawings', 'estimates', 'invoices', 'compliance', 'panels', 'inventory', 'clients', 'calcs', 'dashboard'], write: ['jobs', 'estimates', 'leads', 'schedule'], managerWrite: true, portal: 'client' },
  schedule: { table: 'schedule', gen: [JOB, EMPLOYEE, g('day', 'date')], read: ['schedule', 'jobs', 'time', 'employees', 'dashboard'], write: ['schedule', 'jobs'], managerWrite: true, portal: null },
  estimates: { table: 'estimates', gen: [CLIENT, JOB, STATUS, NUMBER], read: ['estimates', 'invoices', 'leads', 'clients'], write: ['estimates'], portal: 'client' },
  invoices: { table: 'invoices', gen: [CLIENT, JOB, STATUS, NUMBER], read: ['invoices', 'estimates', 'clients'], write: ['invoices'], portal: 'client' },
  payments: { table: 'payments', gen: [g('invoice_id', 'invoiceId')], read: ['invoices'], write: ['invoices'], portal: null },
  items: { table: 'items', gen: [g('sku', 'sku')], read: ['inventory', 'estimates', 'invoices', 'drawings', 'jobs', 'dashboard'], write: ['inventory'], portal: null },
  locations: { table: 'locations', gen: [], read: ['inventory', 'jobs'], write: ['inventory'], portal: null },
  stockMoves: { table: 'stock_moves', gen: [JOB, g('item_id', 'itemId')], read: ['inventory', 'jobs'], write: ['inventory'], portal: null },
  employees: { table: 'employees', gen: [], read: ['employees', 'time', 'schedule', 'jobs', 'sops', 'compliance', 'security', 'drawings', 'dashboard'], write: ['employees'], portal: null },
  timeEntries: { table: 'time_entries', gen: [EMPLOYEE, JOB], read: ['time', 'time-approve', 'jobs', 'employees', 'dashboard'], write: ['time'], ownRows: true, portal: null },
  // Underlays are data URLs for now (<= 4096 px); they move to object storage later.
  drawings: { table: 'drawings', gen: [JOB], read: ['drawings', 'jobs'], write: ['drawings'], portal: null, maxBytes: 24 * MB },
  sops: { table: 'sops', gen: [], read: ['sops'], write: ['sops'], portal: null },
  permits: { table: 'permits', gen: [JOB, STATUS, NUMBER], read: ['compliance', 'jobs'], write: ['compliance'], portal: null },
  inspections: { table: 'inspections', gen: [JOB, g('permit_id', 'permitId'), g('status', 'result')], read: ['compliance', 'jobs'], write: ['compliance'], portal: null },
  certifications: { table: 'certifications', gen: [EMPLOYEE], read: ['compliance', 'employees', 'dashboard'], write: ['compliance', 'employees'], portal: null },
  checklists: { table: 'checklists', gen: [JOB], read: ['compliance', 'security', 'jobs'], write: ['compliance', 'security'], portal: null },
  panels: { table: 'panels', gen: [JOB], read: ['panels', 'jobs'], write: ['panels'], portal: null },
  settings: { table: 'settings', gen: [], read: [], readAll: true, write: ['settings', 'estimates', 'invoices', 'jobs'], portal: null },
  // Photos are data URLs for now (up to 12 x ~4.8 MB); they move to object storage later.
  wireRuns: { table: 'wire_runs', gen: [JOB, g('drawing_id', 'drawingId')], read: ['drawings', 'jobs', 'estimates'], write: ['drawings'], portal: null, maxBytes: 64 * MB },
  bends: { table: 'bends', gen: [JOB], read: ['calcs', 'jobs'], write: ['calcs'], portal: null },
  benderProfiles: { table: 'bender_profiles', gen: [], read: ['calcs'], write: ['calcs'], portal: null },
  // Work plans (migration 0100). Owners, admins, office and foremen plan and publish.
  workPlans: { table: 'work_plans', gen: [JOB, STATUS], read: ['workplan', 'kpis'], write: ['workplan'], managerWrite: true, portal: null, migration: '0100_workplan' },
  // One task per worker per day. Everyone else sees only their own tasks once published and
  // may only record progress on them (auth/access.js, rules from electrical-app/js/lib/workplan.js).
  // Evidence photos are downscaled data URLs for now (up to 6 x ~300 KB).
  workTasks: {
    table: 'work_tasks', gen: [g('plan_id', 'planId'), JOB, EMPLOYEE, g('day', 'date'), STATUS], read: ['today', 'workplan', 'kpis'], write: ['today', 'workplan'],
    ownRows: true, ownRowsHide: { field: 'status', values: ['draft'] }, portal: null, maxBytes: 4 * MB, migration: '0100_workplan',
  },
  taskTemplates: { table: 'task_templates', gen: [], read: ['workplan'], write: ['workplan'], managerWrite: true, portal: null, migration: '0100_workplan' },
  huddles: { table: 'huddles', gen: [g('day', 'date')], read: ['workplan', 'kpis'], write: ['workplan'], managerWrite: true, portal: null, migration: '0100_workplan' },
};

/** @type {Map<string, CollectionDef>} */
export const DEFS_BY_NAME = new Map(
  Object.entries(DEFS).map(([name, d]) => [name, { name, maxBytes: DEFAULT_MAX_BYTES, managerWrite: false, ownRows: false, readAll: false, ...d }]),
);

/** Collections stored in their own tenant table (all but auditLog), in registry order. */
export const TABLE_COLLECTIONS = COLLECTIONS.filter((c) => c !== AUDIT_COLLECTION);

/** @returns {CollectionDef | undefined} */
export function collectionDef(name) {
  return DEFS_BY_NAME.get(name);
}

export function isCollection(name) {
  return COLLECTIONS.includes(name);
}

/** Query-string filters a collection supports: the record field names of its generated columns. */
export function filterFields(def) {
  return def.gen.map((x) => x.field);
}

/** Largest record any collection accepts; used for the sync push body limit. */
export const MAX_RECORD_BYTES = Math.max(...[...DEFS_BY_NAME.values()].map((d) => d.maxBytes));
