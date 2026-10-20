// Create a company and its owner from the command line (works while signup is closed).
//   npm run tenant:create -- --name "TG Electrical" --email owner@example.com --owner "Kelvin Waldner" [--province AB]
// In a deployed environment: docker compose exec api node src/cli/create-tenant.js --name ... (exec, not run).
// Prints a generated password once, to stdout only (a terminal, or --secret-to-stdout into a
// root-only file; see reveal.js). The owner sets up two-step sign-in at first login.
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { loadEnvFile, readConfig } from '../config.js';
import { createDb, createPool } from '../db.js';
import { createTenantWithOwner } from '../services/tenants.js';
import { info, secretOutputProblem } from './reveal.js';

async function main() {
  const { values } = parseArgs({
    options: {
      name: { type: 'string' }, email: { type: 'string' }, owner: { type: 'string' }, province: { type: 'string' },
      'secret-to-stdout': { type: 'boolean' },
    },
  });
  if (!values.name || !values.email) {
    console.error('Usage: npm run tenant:create -- --name "Company" --email owner@example.com [--owner "Full Name"] [--province AB] [--secret-to-stdout]');
    process.exit(2);
  }
  const problem = secretOutputProblem({ isTTY: process.stdout.isTTY, allowPipe: values['secret-to-stdout'] });
  if (problem) {
    console.error(problem);
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
    info(`Created ${tenant.name} (${tenant.id}, slug ${tenant.slug})`);
    info(`Owner: ${values.email}. Password below, shown once; change it after the first sign-in.`);
    process.stdout.write(`${values.email}  password (shown once): ${pw}\n`);
  } finally {
    await db.close();
  }
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
