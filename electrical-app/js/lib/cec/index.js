// The CEC book: Canadian Electrical Code, Part I, CSA C22.1:24 (26th edition).
// The default for every company; NEC 2023 (../nec.js) is the per-company option.
// Pure functions in SI. Numbers and rule/table references only, never CSA text.
// Data still to confirm against the printed 2024 tables is marked VERIFY in the
// source and listed in docs/code/verify.md.

export const BOOK = { id: 'CEC-2024', name: 'Canadian Electrical Code 2024', standard: 'CSA C22.1:24', edition: '26th' };

export * from './conductors.js';
export * from './voltage-drop.js';
export * from './conduit.js';
export * from './boxes.js';
export * from './loads.js';
export * from './motors.js';
export * from './bonding.js';
export * from './systems.js';
export * from './amendments.js';
export * from './provinces.js';
export * from './checklists.js';
