// API entry point: `npm start`.
import { loadEnvFile, readConfig } from './config.js';
import { createDb, createPool } from './db.js';
import { buildApp } from './app.js';

/** Refuse to serve tenants through a database role that can see past RLS. */
export async function checkAppRole(db, config, log) {
  const { rows } = await db.query('SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  const r = rows[0];
  if (r && (r.rolsuper || r.rolbypassrls)) {
    const msg = `DATABASE_URL connects as ${r.role}, which bypasses row-level security. Use the fishtape_app role.`;
    if (config.deployed) throw new Error(msg);
    log.warn(msg);
  }
}

async function main() {
  loadEnvFile();
  const config = readConfig();
  const db = createDb({
    app: createPool(config.databaseUrl, { max: config.dbPoolMax }),
    hq: config.hqDatabaseUrl ? createPool(config.hqDatabaseUrl, { max: 2, applicationName: 'fishtape-hq' }) : null,
  });
  const app = await buildApp({ config, db });
  try {
    await checkAppRole(db, config, app.log);
  } catch (e) {
    app.log.fatal(e.message);
    process.exit(1);
  }
  const close = async (signal) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
  await app.listen({ port: config.port, host: config.host });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
