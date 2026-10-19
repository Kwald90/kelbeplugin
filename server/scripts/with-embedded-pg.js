// Starts a throwaway Postgres 17 (the embedded-postgres dev dependency, no install,
// no Docker), runs db/bootstrap.sql on it, then runs a command with TEST_DATABASE_URL
// and the role passwords set, and removes the cluster afterwards.
//   node scripts/with-embedded-pg.js                       runs the whole test suite
//   node scripts/with-embedded-pg.js node --test test/isolation.test.js
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { runPsqlScript } from '../test/support/psql-lite.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

const pw = () => randomBytes(18).toString('base64url');

async function main() {
  const args = process.argv.slice(2);
  const cmd = args.length ? args : [process.execPath, '--test', '--test-concurrency=1', 'test/'];
  const dir = mkdtempSync(join(tmpdir(), 'fishtape-pg-'));
  const port = await freePort();
  const superPassword = pw();
  const pgServer = new EmbeddedPostgres({
    databaseDir: join(dir, 'data'), port, user: 'postgres', password: superPassword,
    authMethod: 'scram-sha-256', persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {}, onError: (e) => { if (process.env.DEBUG_PG) console.error(String(e)); },
  });
  let code = 1;
  try {
    await pgServer.initialise();
    await pgServer.start();
    const superUrl = `postgres://postgres:${encodeURIComponent(superPassword)}@127.0.0.1:${port}/postgres`;
    const roles = { owner_password: pw(), app_password: pw(), hq_password: pw() };
    await runPsqlScript(readFileSync(join(ROOT, 'db/bootstrap.sql'), 'utf8'), superUrl, roles);
    console.log(`embedded Postgres 17 on 127.0.0.1:${port}, bootstrap.sql applied`);
    const env = {
      ...process.env,
      TEST_DATABASE_URL: superUrl,
      TEST_OWNER_PASSWORD: roles.owner_password,
      TEST_APP_PASSWORD: roles.app_password,
      TEST_HQ_PASSWORD: roles.hq_password,
    };
    code = await new Promise((resolve) => {
      const child = spawn(cmd[0], cmd.slice(1), { cwd: ROOT, env, stdio: 'inherit', shell: false });
      child.on('exit', (c) => resolve(c ?? 1));
    });
  } catch (e) {
    console.error('embedded Postgres failed:', e?.message || e);
  } finally {
    try { await pgServer.stop(); } catch { /* already stopped */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold files briefly */ }
  }
  process.exit(code);
}

main();
