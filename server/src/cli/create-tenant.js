// Create a company and its owner from the command line (works while signup is closed).
//   npm run tenant:create -- --name "TG Electrical" --email owner@example.com --owner "Kelvin Waldner" [--province AB]
// Prints a generated password once; the owner sets up two-step sign-in at first login.
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { loadEnvFile, readConfig } from '../config.js';
import { createDb, createPool } from '../db.js';
import { createTenantWithOwner } from '../services/tenants.js';

async function main() {
  const { values } = parseArgs({
    options: { name: { type: 'string' }, email: { type: 'string' }, owner: { type: 'string' }, province: { type: 'string' } },
  });
  if (!values.name || !values.email) {
    console.error('Usage: npm run tenant:create -- --name "Company" --email owner@example.com [--owner "Full Name"] [--province AB]');
    process.exit(2);
  }
  loadEnvFile();
  const config = readConfig();
  const db = createDb({ app: createPool(config.databaseUrl, { max: 1, applicationName: 'fishtape-cli' }) });
  try {
    const pw = randomBytes(15).toString('base64url');
    const { tenant } = await createTenantWithOwner(db, {
      name: values.name, province: values.province ? values.province.toUpperCase() : null,
      owner: { email: values.email, password: pw, displayName: values.owner || values.email },
      actor: { type: 'system', id: 'cli', label: 'tenant:create' },
    });
    console.log(`Created ${tenant.name} (${tenant.id}, slug ${tenant.slug})`);
    console.log(`Owner: ${values.email}  password (shown once): ${pw}`);
  } finally {
    await db.close();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
