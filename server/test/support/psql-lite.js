// Runs a psql script through node-postgres, for machines without psql (the embedded
// Postgres used by `npm run test:embedded` ships no client). Supports exactly what
// db/bootstrap.sql uses: `\set ON_ERROR_STOP`, `:'var'` literals, `\gexec`, `\connect db`.
import pg from 'pg';

const quoteLiteral = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * @param {string} script psql script text
 * @param {string} url superuser connection URL (database part is the starting database)
 * @param {Record<string, string>} vars psql -v variables
 */
export async function runPsqlScript(script, url, vars = {}) {
  let client = new pg.Client({ connectionString: url });
  await client.connect();
  let buffer = '';
  const subst = (sql) => sql.replace(/:'([a-z_][a-z0-9_]*)'/gi, (m, name) => {
    if (!(name in vars)) throw new Error(`psql variable ${name} is not set`);
    return quoteLiteral(vars[name]);
  });
  const run = async (sql) => (sql.trim() ? client.query(subst(sql)) : null);
  try {
    for (const line of script.replace(/\r\n/g, '\n').split('\n')) {
      const t = line.trim();
      if (!buffer && (t === '' || t.startsWith('--'))) continue;
      if (t.startsWith('\\')) {
        const [cmd, arg] = t.split(/\s+/);
        if (cmd === '\\set') continue;
        if (cmd === '\\gexec') {
          const res = await run(buffer);
          buffer = '';
          for (const row of res?.rows || []) for (const cell of Object.values(row)) if (cell) await client.query(cell);
          continue;
        }
        if (cmd === '\\connect' || cmd === '\\c') {
          if (buffer.trim()) { await run(buffer); buffer = ''; }
          await client.end();
          const u = new URL(url);
          u.pathname = '/' + arg;
          client = new pg.Client({ connectionString: u.toString() });
          await client.connect();
          continue;
        }
        throw new Error(`psql-lite: unsupported meta-command ${cmd}`);
      }
      buffer += line + '\n';
      if (t.endsWith(';')) { await run(buffer); buffer = ''; }
    }
    if (buffer.trim()) await run(buffer);
  } finally {
    await client.end();
  }
}
