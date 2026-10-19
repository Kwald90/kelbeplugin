// Module registry. Order here is the order in the rail and on the wheel.
import dashboard from './dashboard.js';
import clients from './clients.js';
import leads from './leads.js';
import sequences from './sequences.js';
import jobs from './jobs.js';
import schedule from './schedule.js';
import drawings from './drawings.js';
import wireruns from './wireruns.js';
import estimates from './estimates.js';
import invoices from './invoices.js';
import inventory from './inventory.js';
import employees from './employees.js';
import time from './time.js';
import sops from './sops.js';
import compliance from './compliance.js';
import security from './security.js';
import calcs from './calcs.js';
import bending from './bending.js';
import panels from './panels.js';
import settings from './settings.js';
import assistant from './assistant.js';

export const GROUPS = {
  home: 'Home', sales: 'Sales', work: 'Work', money: 'Money', people: 'People', field: 'Field', admin: 'Admin',
};

export const MODULES = [
  dashboard, assistant, clients, leads, sequences, jobs, schedule, drawings, wireruns, estimates, invoices, inventory,
  employees, time, sops, compliance, security, calcs, bending, panels, settings,
];
