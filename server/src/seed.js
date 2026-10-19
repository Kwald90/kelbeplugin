// `npm run seed`: demo tenants for local and staging. Refuses to run in production.
// Creates TG Electrical, Test Co Alpha and Test Co Bravo, an owner for each, a few
// records each, and one HQ staff user. Generated passwords are printed once.
// Re-running skips tenants and users that already exist.
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnvFile, readConfig } from './config.js';
import { createDb, createPool } from './db.js';
import { createValidator } from './schemas.js';
import { createRecords } from './services/records.js';
import { createTenantWithOwner } from './services/tenants.js';
import { hashSecret } from './auth/passwords.js';
import { permsForRole } from './auth/permissions.js';

export const SEED_TENANTS = [
  { name: 'TG Electrical', province: 'AB', ownerName: 'Kelvin Waldner', email: 'owner@tgelectrical.test' },
  { name: 'Test Co Alpha', province: 'ON', ownerName: 'Alpha Owner', email: 'owner@alpha.test' },
  { name: 'Test Co Bravo', province: 'BC', ownerName: 'Bravo Owner', email: 'owner@bravo.test' },
];
export const SEED_HQ = { email: 'hq@fishtape.test', name: 'Fishtape HQ' };

const password = () => randomBytes(15).toString('base64url');
const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toISOString().slice(0, 10); };

function seedPrincipal(tenantId, userId) {
  return {
    kind: 'session', tenantId, userId, role: 'owner', perms: permsForRole('owner'), isManager: true, employeeId: null, scopes: null,
    actor: { type: 'system', id: 'seed', label: 'seed' },
  };
}

/** A few records per tenant, in the shapes of electrical-app/js/seed.js. */
async function seedRecords(db, records, tenantId, userId, label) {
  const p = seedPrincipal(tenantId, userId);
  const who = { actor: p.actor, request: {} };
  await db.withTenant({ tenantId, userId }, async (tx) => {
    const add = (coll, body) => records.createRecord(tx, p, coll, body, who);
    const owner = await add('employees', { name: `${label} Owner`, role: 'owner', email: '', phone: '', rateCents: 0, color: '#8a5a00', active: true, licenceNo: '', licenceExpiry: '' });
    const lead = await add('employees', { name: `${label} Foreman`, role: 'foreman', email: '', phone: '', rateCents: 5200, color: '#1d7044', active: true, licenceNo: '', licenceExpiry: day(120) });
    await tx.query('UPDATE memberships SET employee_id = $3 WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId, owner.id]);
    const c1 = await add('clients', { name: `${label} Dental Clinic`, type: 'commercial', email: 'ops@clinic.example', phone: '', address: '42 Harbour St', notes: '', tags: ['repeat'] });
    const c2 = await add('clients', { name: `${label} Residence`, type: 'residential', email: 'home@example.com', phone: '', address: '9 Linden Ct', notes: '', tags: [] });
    const rec = await add('items', { sku: 'DEV-REC-15', name: 'Duplex receptacle 15A TR, installed', category: 'Devices', unit: 'ea', costCents: 245, priceCents: 1200, labourHours: 0.45, reorderPoint: 40, stock: {}, symbol: 'receptacle' });
    await add('items', { sku: 'WR-NMD90-14-2', name: 'NMD90 14/2', category: 'Wire', unit: 'm', costCents: 150, priceCents: 460, labourHours: 0, reorderPoint: 300, stock: {}, symbol: null });
    const j1 = await add('jobs', { number: 'J-1001', title: 'Operatory buildout', clientId: c1.id, address: '42 Harbour St', status: 'in-progress', startDate: day(-2), endDate: day(3), crewIds: [lead.id], estimateId: null, description: '', changeOrders: [] });
    await add('jobs', { number: 'J-1002', title: 'Panel upgrade 100A to 200A', clientId: c2.id, address: '9 Linden Ct', status: 'scheduled', startDate: day(5), endDate: day(6), crewIds: [lead.id], estimateId: null, description: '', changeOrders: [] });
    await add('estimates', {
      number: 'E-2001', clientId: c2.id, jobId: null, title: 'Kitchen rewire', status: 'draft',
      lines: [{ itemId: rec.id, description: rec.name, qty: 12, unitCents: rec.priceCents, labourHours: rec.labourHours, kind: 'material' }],
      labourRateCents: 9500, markupPct: 0, taxPct: 5, notes: '', validUntil: day(30),
    });
    await add('timeEntries', { employeeId: lead.id, jobId: j1.id, clockIn: new Date(Date.now() - 26 * 3600e3).toISOString(), clockOut: new Date(Date.now() - 18 * 3600e3).toISOString(), breakMins: 30, note: '', approved: false });
    await add('benderProfiles', { name: 'EMT 21 hand bender', brand: 'Generic', model: 'Hand bender', conduitType: 'EMT', tradeSize: '21', takeUpM: 0.152, gainM: 0.0286, backToBackMark: 'star', centreMark: 'notch', minRadiusM: 0.108, isDefault: true, notes: 'VERIFY against the bender you own.' });
  }, { write: true });
}

export async function seed({ db, ownerClient, log = console.log }) {
  const records = createRecords({ validator: createValidator() });
  const printed = [];
  for (const t of SEED_TENANTS) {
    const exists = await db.query('SELECT id FROM tenants WHERE name = $1', [t.name]);
    if (exists.rows[0]) { log(`skip: ${t.name} already exists`); continue; }
    const user = await db.query('SELECT id FROM users WHERE email = $1', [t.email]);
    if (user.rows[0]) { log(`skip: ${t.email} already exists`); continue; }
    const pw = password();
    const { tenant, userId } = await createTenantWithOwner(db, {
      name: t.name, province: t.province, owner: { email: t.email, password: pw, displayName: t.ownerName },
      actor: { type: 'system', id: 'seed', label: 'seed' },
    });
    await seedRecords(db, records, tenant.id, userId, t.name.split(' ').slice(-1)[0]);
    printed.push([t.name, t.email, pw]);
  }
  const hq = await db.query('SELECT id FROM users WHERE email = $1', [SEED_HQ.email]);
  if (!hq.rows[0]) {
    const pw = password();
    await db.query(
      "INSERT INTO users (email, display_name, password_hash, password_changed_at, platform_role) VALUES ($1, $2, $3, now(), 'hq_admin')",
      [SEED_HQ.email, SEED_HQ.name, await hashSecret(pw)]);
    printed.push(['HQ staff', SEED_HQ.email, pw]);
  }
  if (ownerClient) {
    await ownerClient.query("UPDATE feature_flags SET enabled = true, updated_at = now() WHERE key = 'signup_open' AND tenant_id IS NULL");
    log('signup_open: on');
  }
  return printed;
}

async function main() {
  loadEnvFile();
  const config = readConfig();
  if (config.appEnv === 'production') {
    console.error('Refusing to seed: APP_ENV is production.');
    process.exit(2);
  }
  const db = createDb({ app: createPool(config.databaseUrl, { max: 2, applicationName: 'fishtape-seed' }) });
  let ownerClient = null;
  if (config.migrateDatabaseUrl && config.appEnv === 'local') {
    ownerClient = new pg.Client({ connectionString: config.migrateDatabaseUrl });
    await ownerClient.connect();
  }
  try {
    const printed = await seed({ db, ownerClient });
    if (printed.length) {
      console.log('\nGenerated sign-ins (shown once; owners and HQ must set up two-step sign-in at first login):');
      for (const [who, email, pw] of printed) console.log(`  ${who.padEnd(16)} ${email.padEnd(28)} ${pw}`);
    } else {
      console.log('Nothing to seed.');
    }
  } finally {
    await ownerClient?.end();
    await db.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
