// Create an HQ admin (or HQ staff member), or give an existing account an HQ role. Production
// has no seed, so this is how HQ gets its first person.
//
//   docker compose exec api node src/cli/create-hq-admin.js --email kelvin@example.ca --name "Full Name" [--role hq_admin|hq_staff]
//   docker compose exec api node src/cli/create-hq-admin.js --email owner@example.ca --promote [--role ...]
//
// New account: it gets no password. The tool prints a one-time link (valid 7 days, works once)
// where the person sets one; the database keeps only the link's hash. --promote: the account
// already exists (for example a company owner made with create-tenant.js) and keeps its own
// password; nothing secret is printed. Either way HQ opens only after TOTP two-step sign-in is
// set up (src/auth/guard.js). Every change is a platform audit event. The link goes to stdout
// only, never to a log (reveal.js).
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadEnvFile, readConfig } from '../config.js';
import { createDb, createPool } from '../db.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { appendAudit } from '../services/audit.js';
import { INVITE_TTL_S } from '../services/resets.js';
import { EMAIL_RE, normaliseEmail } from '../services/tenants.js';
import { info, secretOutputProblem } from './reveal.js';

export const HQ_ROLES = ['hq_admin', 'hq_staff'];
const ACTOR = { type: 'system', id: 'cli', label: 'hq:create-admin' };

const USAGE = `Usage:
  node src/cli/create-hq-admin.js --email person@example.ca --name "Full Name" [--role hq_admin|hq_staff] [--secret-to-stdout]
  node src/cli/create-hq-admin.js --email person@example.ca --promote [--role hq_admin|hq_staff]`;

/**
 * @param {import('../db.js').Db} db
 * @param {{ email: string, name?: string, role?: string, promote?: boolean, origin: string }} o
 * @returns {Promise<{ userId: string, action: 'created'|'promoted'|'unchanged', link: string|null }>}
 */
export async function createHqAdmin(db, { email, name, role = 'hq_admin', promote = false, origin }) {
  const addr = normaliseEmail(email);
  if (addr.length > 254 || !EMAIL_RE.test(addr)) throw new Error('A valid --email is required.');
  if (!HQ_ROLES.includes(role)) throw new Error(`--role must be ${HQ_ROLES.join(' or ')}.`);

  return db.tx(async (c) => {
    const { rows } = await c.query('SELECT id, platform_role, status FROM users WHERE email = $1 FOR UPDATE', [addr]);
    const user = rows[0];

    if (promote) {
      if (!user) throw new Error(`No account uses ${addr}. Leave out --promote to create one.`);
      if (user.status !== 'active') throw new Error(`The account for ${addr} is disabled.`);
      if (user.platform_role === role) return { userId: user.id, action: 'unchanged', link: null };
      await c.query('UPDATE users SET platform_role = $2, updated_at = now() WHERE id = $1', [user.id, role]);
      await appendAudit(c, null, {
        actor: ACTOR, action: 'hq.staff_role_set', collection: 'users', recordId: user.id,
        summary: `HQ role ${role} given to an existing account from the command line`,
        meta: { role, previousRole: user.platform_role || null },
      });
      return { userId: user.id, action: 'promoted', link: null };
    }

    if (user) throw new Error(`${addr} already has an account. Pass --promote to give it the ${role} role.`);
    const displayName = String(name || '').trim().slice(0, 200) || addr;
    const ins = await c.query('INSERT INTO users (email, display_name, platform_role) VALUES ($1, $2, $3) RETURNING id', [addr, displayName, role]);
    const userId = ins.rows[0].id;
    const token = randomToken('ftr_');
    await c.query(
      "INSERT INTO password_resets (user_id, token_hash, purpose, expires_at) VALUES ($1, $2, 'invite', now() + make_interval(secs => $3))",
      [userId, sha256(token), INVITE_TTL_S]);
    await appendAudit(c, null, {
      actor: ACTOR, action: 'hq.staff_created', collection: 'users', recordId: userId,
      summary: `HQ account (${role}) created from the command line; set-password link issued`,
      meta: { role },
    });
    return { userId, action: 'created', link: `${String(origin).replace(/\/$/, '')}/#/reset-password?token=${encodeURIComponent(token)}` };
  });
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' },
        promote: { type: 'boolean' }, 'secret-to-stdout': { type: 'boolean' }, help: { type: 'boolean' },
      },
    }));
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (values.help || !values.email) {
    console.error(USAGE);
    process.exitCode = values.help ? 0 : 2;
    return;
  }
  // A new account means a secret link: check where it would go before touching anything.
  if (!values.promote) {
    const problem = secretOutputProblem({ isTTY: process.stdout.isTTY, allowPipe: values['secret-to-stdout'] });
    if (problem) {
      console.error(problem);
      process.exitCode = 2;
      return;
    }
  }

  loadEnvFile();
  const config = readConfig();
  const db = createDb({ app: createPool(config.databaseUrl, { max: 1, applicationName: 'fishtape-cli' }) });
  try {
    const r = await createHqAdmin(db, {
      email: values.email, name: values.name, role: values.role || 'hq_admin', promote: Boolean(values.promote), origin: config.publicOrigin,
    });
    const addr = normaliseEmail(values.email);
    if (r.action === 'unchanged') {
      info(`${addr} already has the ${values.role || 'hq_admin'} role; nothing changed.`);
    } else if (r.action === 'promoted') {
      info(`${addr} now has the ${values.role || 'hq_admin'} role (user ${r.userId}). They sign in with their existing password;`);
      info('HQ opens once two-step sign-in (TOTP) is set up.');
    } else {
      info(`Created HQ account ${addr} (${values.role || 'hq_admin'}, user ${r.userId}).`);
      info('Open the link below to set a password (valid 7 days, works once), then sign in to HQ and set up two-step sign-in.');
      process.stdout.write(`${r.link}\n`);
    }
  } finally {
    await db.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
