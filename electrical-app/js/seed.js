// Demo data so every screen has something real to show on first launch.
// Runs only when the database is empty. Settings > Data can wipe it.
import { today } from './ui.js';

// Canvas symbol ids (js/canvas/symbols.js draws them). Price book items point
// at these so a drawing's symbol count can become an estimate.
export const SYMBOL_IDS = [
  'receptacle', 'receptacle-gfci', 'receptacle-240', 'switch', 'switch-3way', 'switch-dimmer',
  'light-ceiling', 'light-recessed', 'light-wall', 'fan', 'smoke', 'panel', 'junction',
  'disconnect', 'ev-charger', 'data', 'motor', 'meter',
];

export function seedIfEmpty(store) {
  if (!store.isEmpty()) return false;
  const S = { silent: true };
  const iso = (dayOffset, h = 8, m = 0) => { const d = new Date(); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); return d.toISOString(); };

  store.saveSettings({
    company: { name: 'Kelbe Electric', phone: '(555) 201-4410', email: 'office@kelbe-electric.example', address: '118 Foundry Rd, Springfield', licenceNo: 'EC-0042871' },
  });

  // locations
  const shop = store.add('locations', { name: 'Shop', kind: 'shop' }, S);
  const van1 = store.add('locations', { name: 'Van 1', kind: 'van' }, S);
  const van2 = store.add('locations', { name: 'Van 2', kind: 'van' }, S);

  // people
  const emp = (name, role, rate, color, extra = {}) => store.add('employees', {
    name, role, email: name.split(' ')[0].toLowerCase() + '@kelbe-electric.example', phone: '', rateCents: rate, color, active: true, pin: '',
    licenceNo: '', licenceExpiry: '', ...extra,
  }, S);
  const kelvin = emp('Kelvin Waldner', 'owner', 0, '#8a5a00', { licenceNo: 'ME-11872', licenceExpiry: today(300) });
  const dana = emp('Dana Ortiz', 'office', 3200, '#1f5fb8');
  const marcus = emp('Marcus Lee', 'foreman', 5200, '#1d7044', { licenceNo: 'JE-55210', licenceExpiry: today(21) });
  const priya = emp('Priya Shah', 'electrician', 4600, '#7a3fb0', { licenceNo: 'JE-60177', licenceExpiry: today(410) });
  const tom = emp('Tom Becker', 'apprentice', 2400, '#b42318', { licenceNo: 'AP-90311', licenceExpiry: today(-5) });

  // price book
  const item = (sku, name, category, unit, cost, price, labourHours, reorderPoint, stock, symbol) => store.add('items', {
    sku, name, category, unit, costCents: cost, priceCents: price, labourHours, reorderPoint,
    stock: { [shop.id]: stock[0], [van1.id]: stock[1], [van2.id]: stock[2] }, symbol: symbol || null,
  }, S);
  const items = {
    rec: item('DEV-REC-15', 'Duplex receptacle 15A TR, installed', 'Devices', 'ea', 245, 1200, 0.45, 40, [120, 18, 12], 'receptacle'),
    gfci: item('DEV-GFCI-20', 'GFCI receptacle 20A, installed', 'Devices', 'ea', 1890, 6500, 0.6, 12, [24, 4, 3], 'receptacle-gfci'),
    r240: item('DEV-REC-50', 'Range/240V receptacle 50A, installed', 'Devices', 'ea', 1650, 9500, 1.2, 4, [6, 1, 0], 'receptacle-240'),
    sw: item('DEV-SW-SP', 'Single-pole switch 15A, installed', 'Devices', 'ea', 180, 1000, 0.4, 40, [90, 15, 10], 'switch'),
    sw3: item('DEV-SW-3W', '3-way switch 15A, installed', 'Devices', 'ea', 420, 1800, 0.6, 20, [30, 6, 4], 'switch-3way'),
    dim: item('DEV-DIM-LED', 'LED dimmer, installed', 'Devices', 'ea', 1900, 6000, 0.5, 10, [14, 2, 2], 'switch-dimmer'),
    can: item('LT-CAN-6', '6" LED recessed wafer, installed', 'Lighting', 'ea', 1350, 8500, 0.75, 24, [48, 6, 6], 'light-recessed'),
    ceil: item('LT-CEIL', 'Ceiling fixture box + install (fixture by owner)', 'Lighting', 'ea', 600, 7500, 1, 10, [20, 2, 2], 'light-ceiling'),
    wall: item('LT-WALL', 'Wall sconce install', 'Lighting', 'ea', 600, 6500, 0.8, 10, [10, 2, 1], 'light-wall'),
    fan: item('LT-FAN', 'Ceiling fan, rated box + install', 'Lighting', 'ea', 2200, 14500, 1.5, 4, [6, 1, 1], 'fan'),
    smoke: item('LS-SMK-CO', 'Hardwired smoke/CO combo, installed', 'Life safety', 'ea', 3400, 11000, 0.6, 12, [18, 3, 2], 'smoke'),
    jbox: item('BX-JB-4', '4" square junction box', 'Boxes', 'ea', 210, 1500, 0.3, 50, [200, 30, 20], 'junction'),
    data: item('LV-CAT6', 'Cat6 data drop, terminated', 'Low voltage', 'ea', 900, 9500, 1, 10, [500, 0, 0], 'data'),
    evse: item('EV-L2-48', 'Level 2 EV charger circuit 60A (charger by owner)', 'EV', 'ea', 18500, 85000, 6, 2, [2, 0, 0], 'ev-charger'),
    disc: item('SW-DISC-60', '60A non-fused disconnect, installed', 'Gear', 'ea', 3800, 16500, 1.5, 3, [5, 1, 0], 'disconnect'),
    panel: item('GR-PNL-200', '200A 40-space main breaker panel', 'Gear', 'ea', 32000, 120000, 10, 1, [2, 0, 0], 'panel'),
    nm12: item('WR-NM-12-2', 'NM-B 12/2 w/G', 'Wire', 'ft', 62, 180, 0, 1000, [2500, 250, 250]),
    nm14: item('WR-NM-14-2', 'NM-B 14/2 w/G', 'Wire', 'ft', 45, 140, 0, 1000, [1800, 250, 0]),
    thhn6: item('WR-THHN-6', 'THHN 6 AWG Cu', 'Wire', 'ft', 155, 420, 0, 500, [300, 0, 0]),
    emt: item('CD-EMT-34', '3/4" EMT, 10 ft stick', 'Conduit', 'stick', 950, 2400, 0.35, 30, [80, 10, 10]),
    br20: item('BR-20-1P', '20A 1-pole breaker', 'Breakers', 'ea', 900, 2800, 0.2, 20, [40, 6, 6]),
    afci: item('BR-20-AFCI', '20A dual-function AFCI/GFCI breaker', 'Breakers', 'ea', 5200, 11500, 0.25, 10, [8, 2, 2]),
  };

  // clients
  const client = (name, type, email, phone, address, tags = []) => store.add('clients', { name, type, email, phone, address, notes: '', tags }, S);
  const c1 = client('Harbor View Dental', 'commercial', 'ops@harborview.example', '(555) 300-1201', '42 Harbor St, Springfield', ['repeat']);
  const c2 = client('Jenna & Rob Miller', 'residential', 'jenna.miller@example.com', '(555) 410-8821', '9 Linden Ct, Springfield', ['referral']);
  const c3 = client('Northside Brewing Co.', 'commercial', 'gm@northsidebrew.example', '(555) 777-2300', '1500 Mill Ave, Springfield', []);
  const c4 = client('Alvarez Residence', 'residential', 'm.alvarez@example.com', '(555) 214-0098', '77 Crescent Rd, Springfield', []);
  const c5 = client('Ridgeway Storage', 'industrial', 'facilities@ridgeway.example', '(555) 600-4100', '3 Depot Way, Springfield', []);

  // leads (funnel)
  const lead = (title, clientId, contactName, source, stage, value, days) => store.add('leads', {
    title, clientId, contactName, email: '', phone: '', source, stage, valueCents: value, notes: '', nextActionAt: today(days),
  }, S);
  const l1 = lead('Kitchen remodel rewire', c2.id, 'Jenna Miller', 'Referral', 'quoted', 860000, 2);
  lead('EV charger install', c4.id, 'M. Alvarez', 'Website', 'site-visit', 165000, 1);
  lead('Taproom lighting retrofit', c3.id, 'Sam (GM)', 'Repeat', 'contacted', 1240000, 3);
  lead('Panel upgrade 100A → 200A', null, 'Greg Hollis', 'Google', 'new', 420000, 0);
  lead('Warehouse LED high-bays', c5.id, 'Facilities', 'Cold call', 'new', 2800000, 5);
  lead('Generator inlet + interlock', null, 'Ana Ruiz', 'Website', 'won', 210000, -3);
  lead('Basement finish', null, 'Leo Park', 'Yard sign', 'lost', 540000, -10);

  // sequences
  const seq = store.add('sequences', {
    name: 'New lead follow-up', active: true, steps: [
      { dayOffset: 0, channel: 'email', subject: 'Thanks for reaching out', body: 'Hi {{name}}, thanks for contacting Kelbe Electric. When suits you for a quick site visit?' },
      { dayOffset: 2, channel: 'sms', subject: '', body: 'Hi {{name}}, Kelbe Electric here. Still keen to get your project booked in?' },
      { dayOffset: 5, channel: 'task', subject: 'Call the lead', body: 'Phone call follow-up' },
    ],
  }, S);
  store.add('sequences', {
    name: 'Quote chaser', active: true, steps: [
      { dayOffset: 3, channel: 'email', subject: 'Your quote from Kelbe Electric', body: 'Hi {{name}}, any questions about the quote we sent?' },
      { dayOffset: 7, channel: 'task', subject: 'Call about the quote', body: 'Call and offer to walk through options' },
    ],
  }, S);
  store.add('enrolments', { sequenceId: seq.id, leadId: l1.id, startedAt: iso(-2), stepIndex: 1, status: 'active' }, S);

  // estimates
  const line = (it, qty) => ({ itemId: it.id, description: it.name, qty, unitCents: it.priceCents, labourHours: it.labourHours, kind: 'material' });
  const e1 = store.add('estimates', {
    number: store.nextNumber('estimate'), clientId: c2.id, jobId: null, title: 'Kitchen remodel rewire', status: 'sent',
    lines: [line(items.rec, 14), line(items.gfci, 4), line(items.sw, 6), line(items.dim, 2), line(items.can, 12), line(items.afci, 4), line(items.r240, 1)],
    labourRateCents: 9500, markupPct: 0, taxPct: 8, notes: 'Permit fees included. Drywall patching by others.', validUntil: today(30),
  }, S);

  // jobs
  const job = (title, clientId, status, start, end, crewIds, address, description) => store.add('jobs', {
    number: store.nextNumber('job'), title, clientId, address, status, startDate: today(start), endDate: today(end), crewIds, estimateId: null, description, changeOrders: [],
  }, S);
  const j1 = job('Operatory 3 & 4 buildout', c1.id, 'in-progress', -2, 3, [marcus.id, tom.id], c1.address, 'Two new dental operatories: dedicated circuits for chairs, task lighting, data drops.');
  const j2 = job('Taproom service upgrade to 400A', c3.id, 'scheduled', 2, 6, [marcus.id, priya.id], c3.address, 'Replace 200A service with 400A 3-phase, new distribution panel.');
  const j3 = job('Generator interlock', null, 'complete', -9, -8, [priya.id], '14 Elm St, Springfield', 'Interlock kit and 30A inlet.');
  const j4 = job('Miller kitchen rewire', c2.id, 'lead', 10, 14, [], c2.address, 'Pending quote acceptance.');
  store.update('jobs', j1.id, { changeOrders: [{ id: 'co-1', title: 'Add 2 x dedicated 20A for compressors', amountCents: 78000, status: 'approved', date: today(-1) }] }, S);
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

  // invoices + payments
  const inv1 = store.add('invoices', {
    number: store.nextNumber('invoice'), clientId: null, jobId: j3.id, estimateId: null, status: 'paid',
    lines: [{ itemId: null, description: 'Generator interlock kit + 30A inlet, installed', qty: 1, unitCents: 185000, labourHours: 0, kind: 'other' }],
    taxPct: 8, issueDate: today(-8), dueDate: today(6), notes: '',
  }, S);
  store.add('payments', { invoiceId: inv1.id, amountCents: 199800, date: today(-4), method: 'card', reference: 'ch_demo' }, S);
  const inv2 = store.add('invoices', {
    number: store.nextNumber('invoice'), clientId: c1.id, jobId: j1.id, estimateId: null, status: 'partial',
    lines: [{ itemId: null, description: 'Progress billing 50%: operatory buildout', qty: 1, unitCents: 640000, labourHours: 0, kind: 'other' }],
    taxPct: 8, issueDate: today(-20), dueDate: today(-6), notes: 'Net 14',
  }, S);
  store.add('payments', { invoiceId: inv2.id, amountCents: 300000, date: today(-10), method: 'transfer', reference: 'ACH 88123' }, S);
  store.add('invoices', {
    number: store.nextNumber('invoice'), clientId: c3.id, jobId: null, estimateId: null, status: 'sent',
    lines: [{ itemId: null, description: 'Service call: tripping cooler circuit', qty: 1, unitCents: 28500, labourHours: 0, kind: 'other' }],
    taxPct: 8, issueDate: today(-3), dueDate: today(11), notes: '',
  }, S);

  // time entries (yesterday + one open shift today)
  store.add('timeEntries', { employeeId: marcus.id, jobId: j1.id, clockIn: iso(-1, 7, 0), clockOut: iso(-1, 15, 30), breakMins: 30, note: '', approved: true }, S);
  store.add('timeEntries', { employeeId: tom.id, jobId: j1.id, clockIn: iso(-1, 7, 5), clockOut: iso(-1, 15, 30), breakMins: 30, note: '', approved: false }, S);
  store.add('timeEntries', { employeeId: marcus.id, jobId: j1.id, clockIn: new Date(Date.now() - 2.5 * 3600e3).toISOString(), clockOut: null, breakMins: 0, note: '', approved: false }, S);

  // stock moves
  store.add('stockMoves', { itemId: items.rec.id, fromLocationId: shop.id, toLocationId: van1.id, qty: 10, jobId: null, date: today(-3), note: 'Restock van' }, S);
  store.add('stockMoves', { itemId: items.can.id, fromLocationId: van1.id, toLocationId: null, qty: 6, jobId: j1.id, date: today(-1), note: 'Used on job' }, S);

  // SOPs
  store.add('sops', {
    title: 'Lockout / tagout before work on equipment', category: 'Safety', version: 3, requiredRoles: ['foreman', 'electrician', 'apprentice'],
    steps: [
      { text: 'Tell everyone affected that the equipment is being shut down.' },
      { text: 'Identify every energy source (electrical, stored, mechanical).' },
      { text: 'Switch off at the disconnect and apply your personal lock and tag.' },
      { text: 'Release stored energy (capacitors, springs).' },
      { text: 'Test for absence of voltage with a tested meter: live-dead-live.' },
      { text: 'Only you remove your lock, after the work is complete and the area is clear.' },
    ],
    acks: [{ employeeId: marcus.id, version: 3, at: iso(-30) }, { employeeId: priya.id, version: 3, at: iso(-28) }],
  }, S);
  store.add('sops', {
    title: 'Site arrival and customer walk-through', category: 'Customer', version: 1, requiredRoles: ['foreman', 'electrician'],
    steps: [
      { text: 'Text the customer 30 minutes before arrival.' },
      { text: 'Boot covers on, drop cloths down in the work area.' },
      { text: 'Walk the scope with the customer and confirm device locations on the plan.' },
      { text: 'Photograph existing conditions and upload to the job.' },
    ], acks: [],
  }, S);
  store.add('sops', {
    title: 'Panel change-out checklist', category: 'Install', version: 2, requiredRoles: ['foreman', 'electrician'],
    steps: [
      { text: 'Confirm utility disconnect/reconnect appointment and permit number.' },
      { text: 'Label every existing circuit before removal.' },
      { text: 'Verify grounding electrode system and bonding per NEC 250.' },
      { text: 'Torque all terminations to the manufacturer spec and record values.' },
      { text: 'Update the panel schedule in the app and print the directory.' },
    ], acks: [],
  }, S);

  // compliance
  const p1 = store.add('permits', { jobId: j1.id, number: 'EL-2026-1182', authority: 'Springfield Building Dept', type: 'Electrical (commercial)', status: 'issued', appliedDate: today(-14), issuedDate: today(-9), expiryDate: today(170) }, S);
  store.add('permits', { jobId: j2.id, number: 'EL-2026-1240', authority: 'Springfield Building Dept', type: 'Service upgrade', status: 'applied', appliedDate: today(-2), issuedDate: '', expiryDate: '' }, S);
  store.add('inspections', { jobId: j1.id, permitId: p1.id, type: 'rough-in', date: today(1), result: 'scheduled', inspector: 'R. Gomez', notes: '' }, S);
  store.add('inspections', { jobId: j3.id, permitId: null, type: 'final', date: today(-8), result: 'passed', inspector: 'R. Gomez', notes: '' }, S);
  store.add('certifications', { employeeId: null, name: 'General liability insurance', issuer: 'Acme Mutual', number: 'GL-778812', expiry: today(45) }, S);
  store.add('certifications', { employeeId: null, name: 'Workers comp', issuer: 'State Fund', number: 'WC-11902', expiry: today(200) }, S);
  store.add('certifications', { employeeId: marcus.id, name: 'OSHA 30', issuer: 'OSHA', number: 'O30-55120', expiry: today(600) }, S);
  store.add('certifications', { employeeId: tom.id, name: 'NFPA 70E arc flash training', issuer: 'NFPA', number: '70E-2210', expiry: today(12) }, S);
  store.add('checklists', {
    kind: 'code', title: 'Residential rough-in (NEC 2023)', jobId: j4.id, completedAt: null, items: [
      { text: 'Kitchen countertop receptacles: 2+ 20A small-appliance circuits', ref: '210.11(C)(1)', status: 'open', note: '' },
      { text: 'GFCI protection on kitchen, bath, laundry, outdoor, garage receptacles', ref: '210.8(A)', status: 'open', note: '' },
      { text: 'AFCI protection on habitable-room branch circuits', ref: '210.12', status: 'open', note: '' },
      { text: 'Tamper-resistant receptacles throughout dwelling', ref: '406.12', status: 'open', note: '' },
      { text: 'Box fill within limits', ref: '314.16', status: 'open', note: '' },
      { text: 'Smoke alarms interconnected', ref: 'IRC R314', status: 'open', note: '' },
    ],
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

  // panel schedule
  store.add('panels', {
    jobId: j1.id, name: 'Panel LP-2 (operatories)', voltage: '208/120 3ph', mainAmps: 100, busAmps: 125, circuits: [
      { slot: 1, description: 'Operatory 3 chair', amps: 20, poles: 1, loadVA: 1440, phase: 'A' },
      { slot: 3, description: 'Operatory 4 chair', amps: 20, poles: 1, loadVA: 1440, phase: 'B' },
      { slot: 5, description: 'Task lighting', amps: 20, poles: 1, loadVA: 900, phase: 'C' },
      { slot: 7, description: 'Compressor', amps: 30, poles: 2, loadVA: 4160, phase: 'A-B' },
      { slot: 2, description: 'Receptacles op 3', amps: 20, poles: 1, loadVA: 1080, phase: 'A' },
      { slot: 4, description: 'Receptacles op 4', amps: 20, poles: 1, loadVA: 1080, phase: 'B' },
      { slot: 6, description: 'Data rack', amps: 20, poles: 1, loadVA: 800, phase: 'C' },
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

  store.log('seed', 'Demo data loaded');
  return true;
}
