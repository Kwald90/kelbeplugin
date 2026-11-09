// Module registry. Order here is the order in the rail and on the wheel.
import dashboard from './dashboard.js';
import clients from './clients.js';
import leads from './leads.js';
import sequences from './sequences.js';
import servicerequests from './servicerequests.js';
import jobs from './jobs.js';
import schedule from './schedule.js';
import service from './service.js';
import memberships from './memberships.js';
import drawings from './drawings.js';
import wireruns from './wireruns.js';
import estimates from './estimates.js';
import assemblies from './assemblies.js';
import labour from './labour.js';
import pricelists from './pricelists.js';
import invoices from './invoices.js';
import getpaid from './getpaid.js';
import inventory from './inventory.js';
import employees from './employees.js';
import time from './time.js';
import sops from './sops.js';
import compliance from './compliance.js';
import security from './security.js';
import calcs from './calcs.js';
import bending from './bending.js';
import panels from './panels.js';
import controlpanels from './controlpanels.js';
import walkthroughs from './walkthroughs.js';
import testing from './testing.js';
import punchlist from './punchlist.js';
import dailylog from './dailylog.js';
import faverification from './faverification.js';
import irinspection from './irinspection.js';
import rfis from './rfis.js';
import submittals from './submittals.js';
import drawingrevisions from './drawingrevisions.js';
import procurement from './procurement.js';
import settings from './settings.js';
import integrations from './integrations.js';
// AI assistant hidden for now (removed from the registry below and from the Settings module picker).
// Re-enable: uncomment this import, add `assistant` back to MODULES, and drop `hidden` in lib/modules.js.
// import assistant from './assistant.js';
import billing from './billing.js';
import help from './help.js';
import onboarding from './onboarding.js';
import importer from './import.js';
import notifications from './notifications.js';
import developer from './developer.js';
import safety from './safety.js';
import today from './today.js';
import workplan from './workplan.js';
import materials from './materials.js';
import purchasing from './purchasing.js';
import quickbooks from './quickbooks.js';
import books from './books.js';

export const GROUPS = {
  home: 'Home', sales: 'Sales', work: 'Work', money: 'Money', people: 'People', field: 'Field', admin: 'Admin',
};

export const MODULES = [
  dashboard, today, clients, leads, sequences, servicerequests, jobs, schedule, service, memberships, workplan, materials, drawings, wireruns, estimates, assemblies, invoices, getpaid, purchasing, quickbooks, books, inventory, pricelists,
  employees, time, labour, sops, safety, compliance, security, calcs, bending, panels, controlpanels, walkthroughs, testing, punchlist, dailylog, faverification, irinspection, rfis, submittals, drawingrevisions, procurement, settings, integrations, billing,
  importer, developer, onboarding, notifications, help,
];
