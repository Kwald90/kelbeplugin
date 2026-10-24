// Demo data so every screen has something real to show on first launch.
// Runs only when the database is empty. Settings > Data can wipe it.
// TG Electrical is a demo Ontario company: every phone number is a 555-01xx
// number, every email ends in .example, and the addresses are placeholders.
import { today } from './ui.js';
import { newDocTax } from './lib/tax.js';
import { CEC_TEMPLATES } from './lib/cec/checklists.js';
import { seedDemoPlan } from './lib/workplan.js';
import { presetModules } from './lib/modules.js';
import { STANDARD_COST_CODES } from './lib/cost-codes.js';
import { snapshotOf, signedContent, digestHex } from './lib/signing.js';

// Canvas symbol ids (js/canvas/symbols.js draws them). Price book items point
// at these so a drawing's symbol count can become an estimate.
export const SYMBOL_IDS = [
  'receptacle', 'receptacle-gfci', 'receptacle-240', 'switch', 'switch-3way', 'switch-dimmer',
  'light-ceiling', 'light-recessed', 'light-wall', 'fan', 'smoke', 'panel', 'junction',
  'disconnect', 'ev-charger', 'data', 'motor', 'meter',
];

const COMPANY = {
  name: 'TG Electrical', phone: '(705) 555-0142', email: 'office@tgelectrical.example',
  address: '100 Placeholder Rd, Barrie, ON', licenceNo: 'ECRA/ESA 7000000 (demo)', province: 'ON',
  gstHstNo: '123456789 RT0001', pstNo: '',
};

export function seedIfEmpty(store) {
  if (!store.isEmpty()) return false;
  const S = { silent: true };
  const iso = (dayOffset, h = 8, m = 0) => { const d = new Date(); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); return d.toISOString(); };

  store.saveSettings({
    company: COMPANY, codeBook: 'CEC-2024', units: 'metric', currency: 'CAD',
    tax: { mode: 'province', treatment: 'standard', custom: [] }, taxPct: 13,
    labourRateCents: 11500, markupPct: 20,
    // The demo shows every module; a real company starts with the recommended set.
    modules: presetModules('all'), billing: { defaultMode: 'fixed', travelRateCents: null }, materialRequests: { sendAt: '15:00', emailTo: '' },
  });
  const tax = () => newDocTax(store.settings()); // Ontario: HST 13% on everything

  // locations
  const shop = store.add('locations', { name: 'Shop', kind: 'shop' }, S);
  const van1 = store.add('locations', { name: 'Van 1', kind: 'van' }, S);
  const van2 = store.add('locations', { name: 'Van 2', kind: 'van' }, S);

  // people (licence and certificate numbers are demo values)
  const emp = (name, role, rate, color, extra = {}) => store.add('employees', {
    name, role, email: name.split(' ')[0].toLowerCase() + '@tgelectrical.example', phone: '', rateCents: rate, color, active: true, pin: '',
    licenceNo: '', licenceExpiry: '', ...extra,
  }, S);
  const kelvin = emp('Kelvin Waldner', 'owner', 0, '#8a5a00', { licenceNo: 'Master Electrician ME-DEMO-01', licenceExpiry: today(300) });
  void kelvin;
  emp('Dana Ortiz', 'office', 3200, '#1f5fb8');
  const marcus = emp('Marcus Lee', 'foreman', 5400, '#1d7044', { licenceNo: '309A C of Q DEMO-552', licenceExpiry: today(21) });
  const priya = emp('Priya Shah', 'electrician', 4800, '#7a3fb0', { licenceNo: '309A C of Q DEMO-617', licenceExpiry: today(410) });
  const tom = emp('Tom Becker', 'apprentice', 2600, '#b42318', { licenceNo: 'Apprentice reg. DEMO-311', licenceExpiry: today(-5) });

  // price book: CAD sell prices (device and lighting lines include install labour)
  const item = (sku, name, category, unit, cost, price, labourHours, reorderPoint, stock, symbol) => store.add('items', {
    sku, name, category, unit, costCents: cost, priceCents: price, labourHours, reorderPoint,
    stock: { [shop.id]: stock[0], [van1.id]: stock[1], [van2.id]: stock[2] }, symbol: symbol || null,
  }, S);
  const items = {
    rec: item('DEV-REC-15TR', 'Duplex receptacle 15 A TR (5-15R), installed', 'Devices', 'ea', 350, 6500, 0.45, 40, [120, 18, 12], 'receptacle'),
    split: item('DEV-REC-20T', 'Counter receptacle 20 A T-slot TR (5-20RA), installed', 'Devices', 'ea', 900, 7500, 0.5, 20, [40, 6, 4]),
    gfci: item('DEV-GFCI-15', 'GFCI receptacle 15 A TR, Class A, installed', 'Devices', 'ea', 2400, 12500, 0.6, 12, [24, 4, 3], 'receptacle-gfci'),
    r240: item('DEV-REC-1450', 'Range receptacle 14-50R 50 A, installed', 'Devices', 'ea', 1800, 18500, 1.2, 4, [6, 1, 0], 'receptacle-240'),
    sw: item('DEV-SW-SP', 'Decora single-pole switch 15 A, installed', 'Devices', 'ea', 250, 6000, 0.4, 40, [90, 15, 10], 'switch'),
    sw3: item('DEV-SW-3W', 'Decora 3-way switch 15 A, installed', 'Devices', 'ea', 500, 7500, 0.6, 20, [30, 6, 4], 'switch-3way'),
    dim: item('DEV-DIM-LED', 'LED dimmer, installed', 'Devices', 'ea', 2600, 11000, 0.5, 10, [14, 2, 2], 'switch-dimmer'),
    pot: item('LT-POT-4', '4 in. slim LED pot light (IC, airtight), installed', 'Lighting', 'ea', 1600, 9500, 0.75, 24, [48, 6, 6], 'light-recessed'),
    ceil: item('LT-CEIL', 'Ceiling outlet (octagon box) + fixture install, fixture by owner', 'Lighting', 'ea', 700, 12000, 1, 10, [20, 2, 2], 'light-ceiling'),
    wall: item('LT-WALL', 'Wall sconce install', 'Lighting', 'ea', 700, 11000, 0.8, 10, [10, 2, 1], 'light-wall'),
    fan: item('LT-FAN', 'Ceiling fan, fan-rated box + install', 'Lighting', 'ea', 2800, 22500, 1.5, 4, [6, 1, 1], 'fan'),
    smoke: item('LS-SMK-CO', 'Hardwired smoke/CO alarm, interconnected, installed', 'Life safety', 'ea', 4200, 16500, 0.6, 12, [18, 3, 2], 'smoke'),
    oct: item('BX-OCT-4-150', 'Octagon box 4 in. × 1-1/2 in. with bracket', 'Boxes', 'ea', 290, 1400, 0.3, 50, [200, 30, 20], 'junction'),
    dev: item('BX-DEV-3x2-250', 'Device box 3 × 2 × 2-1/2 in., gangable', 'Boxes', 'ea', 260, 1200, 0.25, 50, [150, 25, 25]),
    sq: item('BX-SQ-4-218', '4 in. square box × 2-1/8 in.', 'Boxes', 'ea', 480, 1900, 0.3, 30, [80, 10, 10]),
    data: item('LV-CAT6', 'Cat6 data drop, terminated', 'Low voltage', 'ea', 1100, 14500, 1, 10, [500, 0, 0], 'data'),
    evse: item('EV-L2-60', 'Level 2 EV charger circuit, 60 A (charger by owner)', 'EV', 'ea', 22000, 145000, 6, 2, [2, 0, 0], 'ev-charger'),
    disc: item('SW-DISC-60', '60 A non-fused disconnect, installed', 'Gear', 'ea', 5200, 32000, 1.5, 3, [5, 1, 0], 'disconnect'),
    panel: item('GR-LC-200', 'Square D Homeline 200 A 40-space load centre, main breaker', 'Gear', 'ea', 42000, 78000, 10, 1, [2, 0, 0], 'panel'),
    nmd14: item('WR-NMD90-14-2', 'NMD90 14/2 Cu', 'Wire', 'm', 115, 290, 0, 300, [750, 75, 75]),
    nmd12: item('WR-NMD90-12-2', 'NMD90 12/2 Cu', 'Wire', 'm', 175, 420, 0, 300, [600, 75, 0]),
    nmd143: item('WR-NMD90-14-3', 'NMD90 14/3 Cu', 'Wire', 'm', 170, 420, 0, 150, [300, 75, 0]),
    teck: item('WR-TECK90-6-3', 'Teck90 6/3 Cu', 'Wire', 'm', 1450, 2900, 0, 50, [120, 0, 0]),
    acwu: item('WR-ACWU90-3/0-3', 'ACWU90 3/0-3 Al service cable', 'Wire', 'm', 1700, 3400, 0, 30, [60, 0, 0]),
    t90: item('WR-T90-6', 'T90 Nylon 6 AWG Cu', 'Wire', 'm', 380, 850, 0, 150, [300, 0, 0]),
    emt: item('CD-EMT-21', 'EMT 21 (3/4 in.), 3.05 m length', 'Conduit', 'length', 1200, 2900, 0.35, 30, [80, 10, 10]),
    pvc: item('CD-PVC-27', 'Rigid PVC 27 (1 in.), 3.05 m length', 'Conduit', 'length', 1100, 2600, 0.35, 20, [40, 0, 0]),
    ent: item('CD-ENT-21', 'ENT 21 (3/4 in.)', 'Conduit', 'm', 90, 250, 0, 60, [150, 0, 0]),
    br15: item('BR-QO-115', 'Square D QO 15 A 1-pole breaker', 'Breakers', 'ea', 1100, 3200, 0.2, 20, [40, 6, 6]),
    cafci: item('BR-CH-CAFCI-15', 'Eaton CH 15 A combination AFCI breaker', 'Breakers', 'ea', 5800, 12500, 0.25, 10, [8, 2, 2]),
    gfcibr: item('BR-QO-GFCI-15', 'Square D QO 15 A GFCI breaker (Class A)', 'Breakers', 'ea', 6200, 13500, 0.25, 6, [6, 1, 1]),
    inuse: item('CV-WP-INUSE-1G', 'Weatherproof in-use cover, 1-gang, installed', 'Covers', 'ea', 1100, 4500, 0.2, 12, [24, 4, 4]),
    dual: item('BR-SIE-DF-20', 'Siemens 20 A dual-function AFCI/GFCI breaker', 'Breakers', 'ea', 6800, 14500, 0.25, 6, [6, 1, 1]),
  };

  // clients (fictional)
  const client = (name, type, email, phone, address, tags = []) => store.add('clients', { name, type, email, phone, address, notes: '', tags }, S);
  const c1 = client('Bayview Dental Clinic', 'commercial', 'ops@bayviewdental.example', '(705) 555-0121', '42 Example St, Barrie, ON', ['repeat']);
  const c2 = client('Jenna & Rob Miller', 'residential', 'jenna.miller@example.com', '(705) 555-0188', '9 Sample Cres, Barrie, ON', ['referral']);
  const c3 = client('Northside Brewing Co.', 'commercial', 'gm@northsidebrew.example', '(705) 555-0130', '1500 Demo Ave, Barrie, ON', []);
  const c4 = client('Alvarez Residence', 'residential', 'm.alvarez@example.com', '(705) 555-0109', '77 Test Rd, Innisfil, ON', []);
  const c5 = client('Ridgeway Storage', 'industrial', 'facilities@ridgeway.example', '(705) 555-0164', '3 Placeholder Way, Barrie, ON', []);

  // leads (funnel)
  const lead = (title, clientId, contactName, source, stage, value, days) => store.add('leads', {
    title, clientId, contactName, email: '', phone: '', source, stage, valueCents: value, notes: '', nextActionAt: today(days),
  }, S);
  const l1 = lead('Kitchen remodel rewire', c2.id, 'Jenna Miller', 'Referral', 'quoted', 960000, 2);
  lead('EV charger install', c4.id, 'M. Alvarez', 'Website', 'site-visit', 210000, 1);
  lead('Taproom lighting retrofit', c3.id, 'Sam (GM)', 'Repeat', 'contacted', 1450000, 3);
  lead('Service upgrade 100 A → 200 A', null, 'Greg Hollis', 'Google', 'new', 520000, 0);
  lead('Warehouse LED high-bays', c5.id, 'Facilities', 'Cold call', 'new', 3200000, 5);
  lead('Generator inlet + interlock', null, 'Ana Ruiz', 'Website', 'won', 260000, -3);
  lead('Basement finish', null, 'Leo Park', 'Yard sign', 'lost', 640000, -10);

  // sequences
  const seq = store.add('sequences', {
    name: 'New lead follow-up', active: true, steps: [
      { dayOffset: 0, channel: 'email', subject: 'Thanks for reaching out', body: 'Hi {{name}}, thanks for contacting TG Electrical. When suits you for a quick site visit?' },
      { dayOffset: 2, channel: 'sms', subject: '', body: 'Hi {{name}}, TG Electrical here. Still keen to get your project booked in?' },
      { dayOffset: 5, channel: 'task', subject: 'Call the lead', body: 'Phone call follow-up' },
    ],
  }, S);
  store.add('sequences', {
    name: 'Quote chaser', active: true, steps: [
      { dayOffset: 3, channel: 'email', subject: 'Your quote from TG Electrical', body: 'Hi {{name}}, any questions about the quote we sent?' },
      { dayOffset: 7, channel: 'task', subject: 'Call about the quote', body: 'Call and offer to walk through options' },
    ],
  }, S);
  store.add('enrolments', { sequenceId: seq.id, leadId: l1.id, startedAt: iso(-2), stepIndex: 1, status: 'active' }, S);

  // estimates
  const line = (it, qty) => ({ itemId: it.id, description: it.name, qty, unitCents: it.priceCents, labourHours: it.labourHours, kind: 'material' });
  const labour = (hours, description = 'Labour') => ({ itemId: null, description, qty: hours, unitCents: 11500, labourHours: 1, kind: 'labour' });
  const e1 = store.add('estimates', {
    number: store.nextNumber('estimate'), clientId: c2.id, jobId: null, title: 'Kitchen remodel rewire', status: 'sent',
    lines: [line(items.split, 6), line(items.rec, 8), line(items.gfci, 2), line(items.sw, 6), line(items.dim, 2), line(items.pot, 12),
      line(items.cafci, 4), line(items.r240, 1), line(items.nmd14, 90), line(items.nmd12, 60), labour(6, 'Remove and make safe existing wiring')],
    labourRateCents: 11500, markupPct: 0, ...tax(), notes: 'ESA notification and inspection fees included. Drywall patching by others.', validUntil: today(30),
  }, S);

  // jobs
  const job = (title, clientId, status, start, end, crewIds, address, description) => store.add('jobs', {
    number: store.nextNumber('job'), title, clientId, address, status, startDate: today(start), endDate: today(end), crewIds, estimateId: null, description, changeOrders: [],
  }, S);
  const j1 = job('Operatory 3 & 4 buildout', c1.id, 'in-progress', -2, 3, [marcus.id, tom.id], c1.address, 'Two new dental operatories: dedicated circuits for chairs, task lighting, data drops. Fed from LP-2, 120/208 V.');
  const j2 = job('Brewhouse 347/600 V distribution', c3.id, 'scheduled', 2, 6, [marcus.id, priya.id], c3.address, 'New 225 A 347/600 V distribution panel DP-1 for the brewhouse, chiller and kettle; 45 kVA transformer to a 120/208 V panel.');
  const j3 = job('Generator interlock', null, 'complete', -9, -8, [priya.id], '14 Elm St, Barrie, ON', 'Interlock kit and 30 A inlet.');
  const j4 = job('Miller kitchen rewire', c2.id, 'lead', 10, 14, [], c2.address, 'Pending quote acceptance.');
  store.update('jobs', j1.id, { billingMode: 'tm', changeOrders: [{ id: 'co-1', title: 'Add 2 × dedicated 20 A for compressors', amountCents: 98000, status: 'approved', date: today(-1) }] }, S);
  for (const j of [j2, j3, j4]) store.update('jobs', j.id, { billingMode: 'fixed' }, S);
  store.update('estimates', e1.id, { jobId: j4.id }, S);
  store.update('jobs', j4.id, { estimateId: e1.id }, S);

  // schedule
  for (let d = -2; d <= 3; d++) {
    store.add('schedule', { jobId: j1.id, employeeId: marcus.id, date: today(d), hours: 8, note: '' }, S);
    store.add('schedule', { jobId: j1.id, employeeId: tom.id, date: today(d), hours: 8, note: '' }, S);
  }
  for (let d = 2; d <= 6; d++) {
    store.add('schedule', { jobId: j2.id, employeeId: priya.id, date: today(d), hours: 8, note: '' }, S);
  }

  // invoices + payments (HST 13%: $1,850.00 -> $2,090.50; $6,400.00 -> $7,232.00)
  const inv1 = store.add('invoices', {
    number: store.nextNumber('invoice'), clientId: null, jobId: j3.id, estimateId: null, status: 'paid',
    lines: [{ itemId: null, description: 'Generator interlock kit + 30 A inlet, installed', qty: 1, unitCents: 185000, labourHours: 0, kind: 'other' }],
    ...tax(), issueDate: today(-8), dueDate: today(6), notes: '',
  }, S);
  store.add('payments', { invoiceId: inv1.id, amountCents: 209050, date: today(-4), method: 'e-transfer', reference: 'e-Transfer DEMO-4471' }, S);
  const inv2 = store.add('invoices', {
    number: store.nextNumber('invoice'), clientId: c1.id, jobId: j1.id, estimateId: null, status: 'partial',
    lines: [{ itemId: null, description: 'Progress billing 50%: operatory buildout', qty: 1, unitCents: 640000, labourHours: 0, kind: 'other' }],
    ...tax(), issueDate: today(-20), dueDate: today(-6), notes: 'Net 14',
  }, S);
  store.add('payments', { invoiceId: inv2.id, amountCents: 300000, date: today(-10), method: 'cheque', reference: 'Cheque 1042' }, S);
  store.add('invoices', {
    number: store.nextNumber('invoice'), clientId: c3.id, jobId: null, estimateId: null, status: 'sent',
    lines: [
      { itemId: null, description: 'Service call: tripping cooler circuit', qty: 1, unitCents: 14500, labourHours: 0, kind: 'other' },
      { itemId: null, description: 'Labour', qty: 1.5, unitCents: 11500, labourHours: 1, kind: 'labour' },
    ],
    ...tax(), issueDate: today(-3), dueDate: today(11), notes: '',
  }, S);

  // time entries (yesterday + one open shift today)
  // (the cost code is the job's phase, set at clock-in without asking; Release 1 demo codes below)
  store.add('timeEntries', { employeeId: marcus.id, jobId: j1.id, costCodeId: 'cc-rough-in', clockIn: iso(-1, 7, 0), clockOut: iso(-1, 15, 30), breakMins: 30, note: '', approved: true }, S);
  store.add('timeEntries', { employeeId: tom.id, jobId: j1.id, costCodeId: 'cc-rough-in', clockIn: iso(-1, 7, 5), clockOut: iso(-1, 15, 30), breakMins: 30, note: '', approved: false }, S);
  store.add('timeEntries', { employeeId: marcus.id, jobId: j1.id, costCodeId: 'cc-rough-in', clockIn: new Date(Date.now() - 2.5 * 3600e3).toISOString(), clockOut: null, breakMins: 0, note: '', approved: false }, S);

  // stock moves
  store.add('stockMoves', { itemId: items.rec.id, fromLocationId: shop.id, toLocationId: van1.id, qty: 10, jobId: null, date: today(-3), note: 'Restock van' }, S);
  store.add('stockMoves', { itemId: items.pot.id, fromLocationId: van1.id, toLocationId: null, qty: 6, jobId: j1.id, date: today(-1), note: 'Used on job' }, S);

  // material requests from the crew (one waiting for today's send, one the office has to order)
  store.add('materialRequests', { jobId: j1.id, itemId: items.rec.id, description: 'Duplex receptacle 15 A TR (5-15R), installed', qty: 12, unit: 'ea', note: 'Op 4 north wall', urgent: false, employeeId: tom.id, status: 'requested' }, S);
  store.add('materialRequests', { jobId: j1.id, itemId: null, description: '3/4" EMT', qty: 20, unit: 'sticks', note: '', urgent: true, employeeId: marcus.id, status: 'sent', sentAt: iso(-1, 15, 0), batchId: 'demo-batch-1' }, S);

  seedReleaseOne(store, { S, iso, tax, shop, van1, van2, marcus, priya, tom, j1, j2, c1, c3 });

  // SOPs
  store.add('sops', {
    title: 'Lockout / tagout before work on equipment', category: 'Safety', revision: 3, requiredRoles: ['foreman', 'electrician', 'apprentice'],
    steps: [
      { text: 'Tell everyone affected that the equipment is being shut down.' },
      { text: 'Identify every energy source (electrical, stored, mechanical).' },
      { text: 'Switch off at the disconnect and apply your personal lock and tag.' },
      { text: 'Release stored energy (capacitors, springs).' },
      { text: 'Test for absence of voltage with a tested meter: live-dead-live (CSA Z462).' },
      { text: 'Only you remove your lock, after the work is complete and the area is clear.' },
    ],
    acks: [{ employeeId: marcus.id, revision: 3, at: iso(-30) }, { employeeId: priya.id, revision: 3, at: iso(-28) }],
  }, S);
  store.add('sops', {
    title: 'Site arrival and customer walk-through', category: 'Customer', revision: 1, requiredRoles: ['foreman', 'electrician'],
    steps: [
      { text: 'Text the customer 30 minutes before arrival.' },
      { text: 'Boot covers on, drop cloths down in the work area.' },
      { text: 'Walk the scope with the customer and confirm device locations on the plan.' },
      { text: 'Photograph existing conditions and upload to the job.' },
    ], acks: [],
  }, S);
  store.add('sops', {
    title: 'Panel change-out checklist', category: 'Install', revision: 2, requiredRoles: ['foreman', 'electrician'],
    steps: [
      { text: 'Confirm the ESA notification number and the utility disconnect/reconnect appointment.' },
      { text: 'Label every existing circuit before removal.' },
      { text: 'Verify grounding electrodes and bonding (CEC Section 10).' },
      { text: 'Torque all terminations to the manufacturer spec and record values.' },
      { text: 'Update the panel schedule in the app and print the directory (CEC Rule 2-100).' },
    ], acks: [],
  }, S);

  // compliance (ESA-style notifications; numbers are demo values)
  const ESA = 'Electrical Safety Authority (ESA)';
  const p1 = store.add('permits', { jobId: j1.id, number: 'ESA-NOT-DEMO-104821', authority: ESA, type: 'Notification of work (commercial)', status: 'issued', appliedDate: today(-14), issuedDate: today(-9), expiryDate: today(170) }, S);
  store.add('permits', { jobId: j2.id, number: 'ESA-NOT-DEMO-105240', authority: ESA, type: 'Notification of work + plan review (600 V)', status: 'applied', appliedDate: today(-2), issuedDate: '', expiryDate: '' }, S);
  const p3 = store.add('permits', { jobId: j3.id, number: 'ESA-NOT-DEMO-103977', authority: ESA, type: 'Notification of work (residential)', status: 'closed', appliedDate: today(-12), issuedDate: today(-12), expiryDate: '' }, S);
  store.add('inspections', { jobId: j1.id, permitId: p1.id, type: 'rough-in', date: today(1), result: 'scheduled', inspector: 'ESA inspector (demo)', notes: '' }, S);
  store.add('inspections', { jobId: j3.id, permitId: p3.id, type: 'final', date: today(-8), result: 'passed', inspector: 'ESA inspector (demo)', notes: 'Connection authorization sent to the utility.' }, S);
  store.add('certifications', { employeeId: null, name: 'WSIB clearance certificate', issuer: 'WSIB Ontario', number: 'DEMO-WSIB-7781', expiry: today(45) }, S);
  store.add('certifications', { employeeId: null, name: 'Commercial general liability, $5M', issuer: 'Demo Insurance Co.', number: 'DEMO-CGL-11902', expiry: today(200) }, S);
  store.add('certifications', { employeeId: marcus.id, name: 'Working at Heights', issuer: 'CPO-approved provider', number: 'DEMO-WAH-55120', expiry: today(600) }, S);
  store.add('certifications', { employeeId: tom.id, name: 'CSA Z462 arc flash training', issuer: 'Training provider (demo)', number: 'DEMO-Z462-2210', expiry: today(12) }, S);
  const rough = CEC_TEMPLATES.find((t) => t.id === 'dwelling-rough-in') || CEC_TEMPLATES[0];
  store.add('checklists', {
    kind: 'code', title: rough.title, jobId: j4.id, completedAt: null,
    items: rough.items.map(([text, ref]) => ({ text, ref, status: 'open', note: '' })),
  }, S);
  store.add('checklists', {
    kind: 'security', title: 'Quarterly security review', jobId: null, completedAt: null, items: [
      { text: 'Every active employee still works here', ref: 'Access', status: 'pass', note: '' },
      { text: 'Owner/admin roles limited to people who need them', ref: 'Access', status: 'open', note: '' },
      { text: 'Every shared device has a PIN on each user', ref: 'Devices', status: 'fail', note: 'Apprentice has no PIN' },
      { text: 'Backup exported in the last 30 days', ref: 'Data', status: 'open', note: '' },
      { text: 'Customer data only on company devices', ref: 'Data', status: 'open', note: '' },
    ],
  }, S);

  // panel schedules: a 120/208 V lighting panel and a 347/600 V distribution panel
  store.add('panels', {
    jobId: j1.id, name: 'Panel LP-2 (operatories)', voltage: '208/120 3ph', mainAmps: 100, busAmps: 125, circuits: [
      { slot: 1, description: 'Operatory 3 chair', amps: 20, poles: 1, loadVA: 1440, phase: 'A' },
      { slot: 3, description: 'Operatory 4 chair', amps: 20, poles: 1, loadVA: 1440, phase: 'B' },
      { slot: 5, description: 'Task lighting', amps: 15, poles: 1, loadVA: 900, phase: 'C' },
      { slot: 7, description: 'Compressor', amps: 30, poles: 2, loadVA: 4160, phase: 'A-B' },
      { slot: 2, description: 'Receptacles op 3', amps: 20, poles: 1, loadVA: 1080, phase: 'A' },
      { slot: 4, description: 'Receptacles op 4', amps: 20, poles: 1, loadVA: 1080, phase: 'B' },
      { slot: 6, description: 'Data rack', amps: 20, poles: 1, loadVA: 800, phase: 'C' },
    ],
  }, S);
  store.add('panels', {
    jobId: j2.id, name: 'Panel DP-1 (brewhouse)', voltage: '347/600 3ph', mainAmps: 225, busAmps: 225, slots: 42, circuits: [
      { slot: 1, description: 'Brewhouse lighting 347 V', amps: 20, poles: 1, loadVA: 3800, phase: 'A' },
      { slot: 3, description: 'Cellar lighting 347 V', amps: 20, poles: 1, loadVA: 3100, phase: 'B' },
      { slot: 5, description: 'Exterior lighting 347 V', amps: 15, poles: 1, loadVA: 1200, phase: 'C' },
      { slot: 7, description: 'Glycol chiller', amps: 40, poles: 3, loadVA: 24000, phase: 'A-B-C' },
      { slot: 2, description: 'Boil kettle element', amps: 60, poles: 3, loadVA: 45000, phase: 'A-B-C' },
      { slot: 8, description: 'Transformer T1 45 kVA to LP-1 120/208 V', amps: 70, poles: 3, loadVA: 30000, phase: 'B-C-A' },
    ],
  }, S);
  // A 120/240 V house panel that exercises every space type: full 1- and 2-pole breakers,
  // two tandems sharing a space (A over B), and an Eaton-style quad (space-saver) — a single
  // device that is two outer singles plus one inner handle-tied 2-pole across four half-positions.
  // Quad at spaces 5 & 7: 5A single, inner 2-pole in 5B+7A, 7B single.
  store.add('panels', {
    jobId: j1.id, name: 'Panel HP-1 (house · tandems + quad)', voltage: '120/240 1ph', mainType: 'MB', mainAmps: 200, busAmps: 200, slots: 24, circuits: [
      // left column (odd)
      { slot: 1, half: 'A', description: 'Kitchen plugs', amps: 15, poles: 1, loadVA: 1440, breakerType: 'tandem', phase: 'A' },
      { slot: 1, half: 'B', description: 'Bedroom lights', amps: 15, poles: 1, loadVA: 900, breakerType: 'tandem', phase: 'A' },
      { slot: 3, description: 'Living room plugs', amps: 20, poles: 1, loadVA: 1440, phase: 'B' },
      { slot: 5, half: 'A', description: 'Bathroom plugs', amps: 15, poles: 1, loadVA: 1440, breakerType: 'gfci', phase: 'A' },
      { slot: 5, half: 'B', description: 'Garage 240 V heater (quad inner)', amps: 30, poles: 2, loadVA: 5760, breakerType: 'standard', phase: 'A-B' },
      { slot: 7, half: 'B', description: 'Hall + stair lights', amps: 15, poles: 1, loadVA: 800, breakerType: 'tandem', phase: 'B' },
      { slot: 9, description: 'Dryer', amps: 30, poles: 2, loadVA: 5000, phase: 'A-B' },
      { slot: 13, description: 'Smoke / CO alarms', amps: 15, poles: 1, loadVA: 300, purpose: 'smoke', phase: 'B' },
      // right column (even)
      { slot: 2, description: 'Dishwasher', amps: 15, poles: 1, loadVA: 1200, phase: 'A' },
      { slot: 4, half: 'A', description: 'Office plugs', amps: 15, poles: 1, loadVA: 1200, breakerType: 'tandem', phase: 'B' },
      { slot: 4, half: 'B', description: 'Basement lights', amps: 15, poles: 1, loadVA: 700, breakerType: 'tandem', phase: 'B' },
      { slot: 6, description: 'Microwave', amps: 20, poles: 1, loadVA: 1500, phase: 'A' },
      { slot: 8, description: 'Range', amps: 40, poles: 2, loadVA: 8000, phase: 'A-B' },
      { slot: 12, description: 'EV charger', amps: 50, poles: 2, loadVA: 9600, phase: 'A-B' },
    ],
  }, S);

  // one drawing so the gallery is not empty (canvas module fills in the rest)
  store.add('drawings', {
    name: 'Operatory 3 & 4 — power plan', jobId: j1.id, paper: 'grid', scale: 24,
    layers: [{ id: 'L1', name: 'Plan', visible: true, locked: false, opacity: 1 }, { id: 'L2', name: 'Power', visible: true, locked: false, opacity: 1 }],
    strokes: [], objects: [
      { id: 'o1', layer: 'L2', symbol: 'receptacle', x: 120, y: 80, rotation: 0, scale: 1 },
      { id: 'o2', layer: 'L2', symbol: 'receptacle', x: 260, y: 80, rotation: 0, scale: 1 },
      { id: 'o3', layer: 'L2', symbol: 'receptacle-gfci', x: 400, y: 80, rotation: 0, scale: 1 },
      { id: 'o4', layer: 'L2', symbol: 'switch', x: 60, y: 200, rotation: 0, scale: 1 },
      { id: 'o5', layer: 'L2', symbol: 'light-recessed', x: 200, y: 220, rotation: 0, scale: 1 },
      { id: 'o6', layer: 'L2', symbol: 'light-recessed', x: 340, y: 220, rotation: 0, scale: 1 },
      { id: 'o7', layer: 'L2', symbol: 'data', x: 460, y: 160, rotation: 0, scale: 1 },
    ], texts: [], underlay: null, view: { x: 0, y: 0, zoom: 1 }, thumb: null,
  }, S);

  // a 35-day work plan on the in-progress job: today's and tomorrow's lists are out
  seedDemoPlan(store, { today: today(), jobId: j1.id, employees: [marcus, priya, tom] });

  store.log('seed', 'Demo data loaded');
  return true;
}

// A 1 x 1 white JPEG: the demo signature's pad image.
const DEMO_SIGNATURE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

/**
 * Release 1 demo data (docs/releases/r1-get-paid.md 13.3): the standard cost codes with a phase on
 * the jobs, two trucks driven by the foreman and the electrician, wage history and burden fields on
 * the crew, a signed field ticket, a deposit invoice and a progress invoice with holdback. Uses only
 * add, update and settings (the schema test runs it against a small stand-in store).
 */
function seedReleaseOne(store, { S, iso, tax, van1, van2, marcus, priya, tom, j1, j2, c1, c3 }) {
  for (const cc of STANDARD_COST_CODES) store.add('costCodes', { ...cc, active: true }, S);
  store.update('jobs', j1.id, { currentCostCodeId: 'cc-rough-in', kind: 'standard', billable: true }, S);
  store.update('jobs', j2.id, {
    currentCostCodeId: 'cc-service', kind: 'standard', billable: true,
    contract: { role: 'prime', signedOn: today(-30), ownerName: 'Northside Brewing Co.', contractNo: 'NB-2026-01', valueCents: 4850000, holdbackPct: 10, paymentTermsDays: 28, properInvoiceRequired: true },
  }, S);

  // Trucks: day rates are demo values (Job costing → Rates sets the real ones).
  const truck = (name, unitNo, loc, driver) => store.add('equipment', {
    name, kind: 'truck', unitNo, plate: '', rateCents: 9500, rateUnit: 'day', rateHistory: [{ from: today(-365), rateCents: 9500, rateUnit: 'day' }],
    billRateCents: null, locationId: loc.id, defaultEmployeeId: driver.id, active: true, note: 'Demo rate',
  }, S);
  const t1 = truck('Truck 1 (Transit)', 'T1', van1, marcus);
  const t2 = truck('Truck 2 (Sprinter)', 'T2', van2, priya);
  const burden = { vacationPct: 4, holidayPct: 4, wcbPct: null, nonProductivePct: 10, benefitsCentsPerHour: null, annualHours: 2000 };
  store.update('employees', marcus.id, { defaultEquipmentId: t1.id, hireDate: today(-2900), rateHistory: [{ from: today(-400), rateCents: 5200 }, { from: today(-40), rateCents: 5400 }], burden }, S);
  store.update('employees', priya.id, { defaultEquipmentId: t2.id, hireDate: today(-1500), rateHistory: [{ from: today(-1500), rateCents: 4800 }], burden }, S);
  store.update('employees', tom.id, { hireDate: today(-200), rateHistory: [{ from: today(-200), rateCents: 2600 }], burden }, S);

  // A signed extra-work ticket on the T&M job (no money on it: the office prices it).
  const ticket = {
    id: 'demo-ticket-1', number: 'T-1001', jobId: j1.id, clientId: c1.id, kind: 'extra', date: today(-1), title: 'Relocate two receptacles in Op 4',
    description: 'Dentist asked to move two receptacles 600 mm east for the new cabinet layout.', requestedBy: 'Dr. Demo (owner)',
    pricingBasis: 'contract-rates', rateSheetRef: 'rates on the signed estimate',
    labour: [{ employeeId: tom.id, name: 'Tom Becker', hours: 1.5 }], materials: [{ description: 'Duplex receptacle 15 A TR', qty: 2, unit: 'ea' }], equipment: [], photos: [],
    agreementText: 'I confirm the work listed above was requested and done. Billed at the rates on the signed estimate.',
    status: 'signed', employeeId: tom.id, costCodeId: 'cc-change-order', signatureId: 'demo-sig-1', signedAt: iso(-1, 14, 10), signerName: 'Dr. Demo',
  };
  const snapshot = snapshotOf('fieldTicket', ticket);
  store.add('signatures', {
    id: 'demo-sig-1', v: snapshot.v, docType: 'fieldTicket', docId: ticket.id, jobId: j1.id, clientId: c1.id, signerName: 'Dr. Demo', signerTitle: 'Owner',
    method: 'on-device', dataUrl: DEMO_SIGNATURE, signedAt: iso(-1, 14, 10), capturedBy: { employeeId: tom.id, name: 'Tom Becker' }, device: 'Demo phone',
    snapshot, digest: null, status: 'valid',
  }, S);
  // The digest is SHA-256 (crypto.subtle, async): filled in a moment after the seed.
  digestHex(signedContent(snapshot)).then((digest) => store.update('signatures', 'demo-sig-1', { digest }, S)).catch(() => {});
  store.add('fieldTickets', ticket, S);

  // A prepayment deposit on the brewhouse job and a progress invoice with 10% holdback (HST deferred to release).
  store.add('invoices', {
    number: store.nextNumber('invoice'), clientId: c3.id, jobId: j2.id, estimateId: null, status: 'paid', kind: 'deposit', depositModel: 'prepayment',
    lines: [{ itemId: null, description: 'Deposit on the brewhouse distribution contract', qty: 1, unitCents: 500000, labourHours: 0, kind: 'other', lineType: 'deposit' }],
    ...tax(), issueDate: today(-28), dueDate: today(-21), notes: 'Prepayment: tax charged now and credited on the final invoice.',
  }, S);
  store.add('invoices', {
    number: store.nextNumber('invoice'), clientId: c3.id, jobId: j2.id, estimateId: null, status: 'sent', kind: 'progress',
    lines: [{ itemId: null, description: 'Progress billing: rough-in 40%', qty: 1, unitCents: 1940000, labourHours: 0, kind: 'other', costCodeId: 'cc-rough-in' }],
    holdback: { pct: 10, cents: 194000, deferTaxIds: ['HST'] }, contractRef: 'NB-2026-01', periodFrom: today(-30), periodTo: today(-1), properInvoice: true,
    ...tax(), issueDate: today(-1), dueDate: today(27), notes: '',
  }, S);
}
