// The operator scripts in deploy/, run for real in a throwaway folder: each script is copied with
// its absolute paths (/srv, /var/lib, /etc, ...) moved under the sandbox, and the commands that
// need root or a live host (id, chown, docker, curl, getent, nginx, ...) are stubs on PATH.
// Linux only (bash, flock, GNU find); skipped elsewhere. The offsite drill (which runs on Kelvin's
// PC, not the server) also runs under Git Bash on Windows.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { TEST_DATABASE_URL, createTestDatabase, skip as dbSkip } from './support/db.js';
import { createSealer } from '../src/lib/crypto.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const src = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const skip = process.platform === 'win32' || spawnSync('bash', ['-c', 'command -v awk flock cmp find mktemp readlink'], { encoding: 'utf8' }).status !== 0
  ? 'needs bash, awk, flock, cmp and GNU find (Linux)' : false;
// On Windows only Git Bash (MSYSTEM set) is a usable bash here; System32's bash.exe is WSL.
const drillSkip = (process.platform === 'win32' && !process.env.MSYSTEM)
  || spawnSync('bash', ['-c', 'command -v sha256sum mktemp sed cut sort tail cp'], { encoding: 'utf8' }).status !== 0
  ? 'needs bash with sha256sum, mktemp and sed (Linux, or Git Bash on Windows)' : false;

/** A sandbox: `dir` for files, stubs in `dir/bin` ahead of the real PATH. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'ft-deploy-'));
  mkdirSync(join(dir, 'bin'));
  const stub = (name, body) => {
    writeFileSync(join(dir, 'bin', name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(dir, 'bin', name), 0o755);
  };
  stub('id', '[ "${1:-}" = -u ] && echo 0 || echo root');
  /** Copy a repo script to `to`, moving absolute paths under the sandbox. */
  const place = (rel, to, moves) => {
    let text = src(rel);
    for (const [from, dest] of moves) text = text.split(from).join(dest);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, text);
    chmodSync(to, 0o755);
    return to;
  };
  // The sandbox as bash sees it (forward slashes, so Git Bash reads it too).
  const posix = dir.replace(/\\/g, '/');
  const run = (args, { input = '', env = {} } = {}) => spawnSync('bash', args, {
    input, encoding: 'utf8', timeout: 60_000, env: { ...process.env, PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH}`, SANDBOX: posix, ...env },
  });
  return { dir, posix, stub, place, run, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('set-env.sh', { skip }, () => {
  let sb, script, prod, state;
  const ORIGINAL = 'PUBLIC_ORIGIN=https://app.example.test\nSENDGRID_API_KEY=SG.old-key-0001\nFISHTAPE_APP_PASSWORD=abc123\nLOG_LEVEL=info\n';
  const envFile = () => readFileSync(join(prod, '.env'), 'utf8');
  const dockerCalls = () => (existsSync(join(sb.dir, 'docker.log')) ? readFileSync(join(sb.dir, 'docker.log'), 'utf8').trim().split('\n') : []);
  const setEnv = (name, value, env) => sb.run([script, 'production', name], { input: `${value}\n`, env: { READY_TIMEOUT: '1', ...env } });

  before(() => {
    sb = sandbox();
    prod = join(sb.dir, 'prod');
    state = join(sb.dir, 'state');
    script = sb.place('deploy/set-env.sh', join(sb.dir, 'set-env.sh'), [
      ['/srv/fishtape/repo/deploy/production', prod], ['/var/lib/fishtape-production', state],
    ]);
    mkdirSync(prod, { recursive: true });
    copyFileSync(join(ROOT, 'deploy/production/.env.example'), join(prod, '.env.example'));
    for (const cmd of ['chown', 'sleep']) sb.stub(cmd, 'exit 0');
    sb.stub('install', 'for a; do last="$a"; done; mkdir -p "$last"');
    sb.stub('docker', 'echo "IMAGE_TAG=${IMAGE_TAG:-} $*" >> "$SANDBOX/docker.log"');
    // The app is ready unless .env holds a value marked BROKEN.
    sb.stub('curl', 'if grep -q BROKEN "$SANDBOX/prod/.env"; then exit 7; fi; exit 0');
  });
  after(() => sb?.cleanup());

  const reset = () => {
    writeFileSync(join(prod, '.env'), ORIGINAL);
    rmSync(join(sb.dir, 'docker.log'), { force: true });
    rmSync(state, { recursive: true, force: true });
    mkdirSync(state);
    writeFileSync(join(state, 'current-image'), 'a'.repeat(40) + '\n');
  };

  test('a value with $, #, quotes and spaces is written single-quoted, so compose reads it literally', () => {
    reset();
    const value = 'SG.ab$9xQ ${HOME} #not-a-comment "quoted"';
    const r = setEnv('SENDGRID_API_KEY', value);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Saved SENDGRID_API_KEY \(ends …ted"\)/);
    assert.match(r.stdout, /Done\./);
    assert.ok(envFile().includes(`\nSENDGRID_API_KEY='${value}'\n`), envFile());
    const parsed = parseEnv(envFile());
    assert.equal(parsed.SENDGRID_API_KEY, value);
    assert.equal(parsed.PUBLIC_ORIGIN, 'https://app.example.test', 'other lines untouched');
    assert.equal(parsed.FISHTAPE_APP_PASSWORD, 'abc123');
    assert.equal(statSync(join(prod, '.env')).mode & 0o777, 0o600);
    assert.deepEqual(dockerCalls(), [`IMAGE_TAG=${'a'.repeat(40)} compose up -d --no-build --force-recreate api hq-api worker`]);
  });

  test('a single quote cannot be written literally: refused, nothing changed', () => {
    reset();
    const r = setEnv('SENDGRID_API_KEY', "it's");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /single quote/);
    assert.equal(envFile(), ORIGINAL);
    assert.deepEqual(dockerCalls(), []);
  });

  test('database passwords, the master key and PG_* are refused: .env alone cannot change them', () => {
    for (const name of ['FISHTAPE_APP_PASSWORD', 'FISHTAPE_HQ_PASSWORD', 'FISHTAPE_OWNER_PASSWORD', 'POSTGRES_SUPERUSER_PASSWORD', 'SECRETS_MASTER_KEY', 'PG_SHARED_BUFFERS', 'PG_MEM_LIMIT']) {
      reset();
      const r = setEnv(name, 'f00dfeed');
      assert.notEqual(r.status, 0, name);
      assert.match(r.stderr, /rotate-secrets\.md/, name);
      assert.equal(envFile(), ORIGINAL, name);
      assert.deepEqual(dockerCalls(), [], name);
    }
    // Names that are not in .env.example at all are still refused too.
    reset();
    assert.match(setEnv('NOT_A_SETTING', 'x').stderr, /not a known setting/);
  });

  test('the previous .env is kept, root-only, and only the newest 10 copies', () => {
    reset();
    assert.equal(setEnv('SENDGRID_API_KEY', 'SG.new-key-0002').status, 0);
    const dir = join(state, 'env-backups');
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    const files = readdirSync(dir, { withFileTypes: false });
    assert.equal(files.length, 1);
    assert.equal(readFileSync(join(dir, files[0]), 'utf8'), ORIGINAL);
    assert.equal(statSync(join(dir, files[0])).mode & 0o777, 0o600);
    for (let i = 0; i < 12; i++) assert.equal(setEnv('LOG_LEVEL', `debug${i}`).status, 0);
    assert.equal(readdirSync(dir).length, 10);
  });

  test('the app does not become ready with the new value: the previous .env is put back and restarted', () => {
    reset();
    const r = setEnv('SENDGRID_API_KEY', 'SG.BROKEN-key');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /putting the previous \.env back/);
    assert.match(r.stderr, /back on the old SENDGRID_API_KEY/);
    assert.equal(envFile(), ORIGINAL);
    assert.equal(dockerCalls().length, 2, 'restarted with the new value, then with the old one');
  });

  test('refused while a deploy holds the deploy lock: nothing changed, nothing restarted', () => {
    reset();
    const lock = join(state, 'deploy.lock');
    const r = sb.run(['-c', 'exec 8>"$1"; flock -n 8 || exit 99; shift; exec bash "$@"', 'hold', lock, script, 'production', 'SENDGRID_API_KEY'],
      { input: 'SG.new-key-0003\n', env: { READY_TIMEOUT: '1' } });
    assert.notEqual(r.status, 99, 'the test could not take the lock');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /a deploy is running/);
    assert.equal(envFile(), ORIGINAL);
    assert.deepEqual(dockerCalls(), []);
    // update.sh takes the same lock file.
    for (const env of ['production', 'staging']) assert.match(src(`deploy/${env}/update.sh`), /exec 9>"\$STATE_DIR\/deploy\.lock"\nflock -n 9/);
  });
});

describe('install-nginx.sh --check (update.sh installs whenever it fails)', { skip }, () => {
  let sb;
  before(() => {
    sb = sandbox();
    sb.stub('nginx', 'exit 0');
  });
  after(() => sb?.cleanup());

  test('production: not installed, a missing certificate, a changed file or a missing link all mean install', () => {
    const here = join(sb.dir, 'p/deploy/production');
    const etc = join(sb.dir, 'p/etc');
    const script = sb.place('deploy/production/install-nginx.sh', join(here, 'install-nginx.sh'), [['/etc/', `${etc}/`], ['/var/', `${sb.dir}/p/var/`]]);
    cpSync(join(ROOT, 'deploy/production/nginx'), join(here, 'nginx'), { recursive: true });
    copyFileSync(join(ROOT, 'deploy/production/logrotate-nginx'), join(here, 'logrotate-nginx'));
    const check = () => sb.run([script, '--check']).status;

    assert.equal(check(), 1, 'no certificate yet');
    mkdirSync(join(etc, 'letsencrypt/live/fishtape'), { recursive: true });
    writeFileSync(join(etc, 'letsencrypt/live/fishtape/fullchain.pem'), 'cert');
    assert.equal(check(), 1, 'nothing installed');

    const pairs = [
      ['nginx/fishtape.conf', 'nginx/sites-available/fishtape-production.conf'],
      ['nginx/security-headers.conf', 'nginx/snippets/fishtape-headers.conf'],
      ['nginx/proxy.conf', 'nginx/snippets/fishtape-proxy.conf'],
      ['nginx/deny.conf', 'nginx/snippets/fishtape-deny.conf'],
      ['nginx/tls.conf', 'nginx/snippets/fishtape-tls.conf'],
      ['logrotate-nginx', 'logrotate.d/fishtape-production-nginx'],
    ];
    for (const [from, to] of pairs) {
      mkdirSync(dirname(join(etc, to)), { recursive: true });
      copyFileSync(join(here, from), join(etc, to));
    }
    assert.equal(check(), 1, 'files installed but the site is not linked');
    mkdirSync(join(etc, 'nginx/sites-enabled'), { recursive: true });
    const link = join(etc, 'nginx/sites-enabled/zz-fishtape-production.conf');
    symlinkSync(join(etc, 'nginx/sites-available/fishtape-production.conf'), link);
    assert.equal(check(), 0, 'installed as in the checkout');

    // An earlier failed install left the old config live: the next deploy sees the difference.
    writeFileSync(join(etc, 'nginx/sites-available/fishtape-production.conf'), '# the previous release\n');
    assert.equal(check(), 1);
    copyFileSync(join(here, 'nginx/fishtape.conf'), join(etc, 'nginx/sites-available/fishtape-production.conf'));
    assert.equal(check(), 0);
    unlinkSync(join(etc, 'logrotate.d/fishtape-production-nginx'));
    assert.equal(check(), 1);
    assert.ok(!existsSync(join(sb.dir, 'p/var/lib/fishtape-production/nginx-backups')), '--check changes nothing');
  });

  test('staging: the same check for its snippets', () => {
    const here = join(sb.dir, 's/deploy/staging');
    const etc = join(sb.dir, 's/etc');
    const script = sb.place('deploy/staging/install-nginx.sh', join(here, 'install-nginx.sh'), [['/etc/', `${etc}/`], ['/var/', `${sb.dir}/s/var/`]]);
    const pairs = [
      ['nginx-http.conf', 'nginx/snippets/fishtape-staging-http.conf'],
      ['security-headers.conf', 'nginx/snippets/fishtape-staging-headers.conf'],
      ['nginx-proxy.conf', 'nginx/snippets/fishtape-staging-proxy.conf'],
      ['nginx-api.conf.snippet', 'nginx/snippets/fishtape-staging-site.conf'],
      ['logrotate-nginx', 'logrotate.d/fishtape-staging-nginx'],
    ];
    for (const [from] of pairs) copyFileSync(join(ROOT, 'deploy/staging', from), join(here, from));
    const check = () => sb.run([script, '--check']).status;
    assert.equal(check(), 1);
    for (const [from, to] of pairs) {
      mkdirSync(dirname(join(etc, to)), { recursive: true });
      copyFileSync(join(here, from), join(etc, to));
    }
    assert.equal(check(), 0);
    writeFileSync(join(etc, 'nginx/snippets/fishtape-staging-headers.conf'), '# old\n');
    assert.equal(check(), 1);
    assert.equal(sb.run([script, '--bogus']).status, 2);
  });

  test('update.sh decides on what is installed, every deploy, and a failed install is a recorded warning', () => {
    const prod = src('deploy/production/update.sh');
    assert.doesNotMatch(prod, /diff --quiet "\$PREV_SHA"/, 'not the git diff since the previous deploy');
    const check = prod.indexOf('"$HERE/install-nginx.sh" --check');
    assert.ok(check > 0);
    assert.ok(check < prod.indexOf('APEX_OK=0'), 'before the site checks, so they test the new config');
    assert.ok(check < prod.indexOf('record success'), 'before the deploy record');
    assert.ok(check > prod.indexOf('warn() {'), 'inside the warnings-only section');
    assert.match(prod.slice(check, prod.indexOf('APEX_OK=0')), /\n {4}warn "install-nginx\.sh failed/);
    assert.match(prod, /WARNINGS\[\*\]/, 'warnings go into the deploy record');

    const stg = src('deploy/staging/update.sh');
    assert.doesNotMatch(stg, /diff --quiet "\$PREV_SHA"/);
    assert.match(stg, /if ! "\$HERE\/install-nginx\.sh" --check/);
  });
});

describe('host-status.sh probes', { skip }, () => {
  let sb, script, out;
  before(() => {
    sb = sandbox();
    script = sb.place('deploy/production/host-status.sh', join(sb.dir, 'deploy/production/host-status.sh'), [
      ['/var/lib/', `${sb.dir}/var/lib/`], ['/var/backups/', `${sb.dir}/var/backups/`], ['/etc/letsencrypt/', `${sb.dir}/etc/letsencrypt/`],
      ['/usr/lib/update-notifier/', `${sb.dir}/no-update-notifier/`],
    ]);
    out = join(sb.dir, 'var/lib/fishtape-production/status/host-status.json');
    sb.stub('curl', 'printf 200');
    // Names listed in $UNRESOLVED have no DNS record.
    sb.stub('getent', 'case " ${UNRESOLVED:-} " in *" $2 "*) exit 2 ;; esac; echo "127.0.0.1 STREAM $2"');
  });
  after(() => sb?.cleanup());

  test('hq.fishtapehq.com without DNS (before launch) is left out, so it is not reported down', () => {
    const r = sb.run([script], { env: { UNRESOLVED: 'hq.fishtapehq.com' } });
    assert.equal(r.status, 0, r.stderr);
    const probes = JSON.parse(readFileSync(out, 'utf8')).probes;
    assert.deepEqual(probes, { app: 200, api: 200, site: 200, status: 200 });
  });

  test('once it resolves it is probed like the rest', () => {
    const r = sb.run([script], { env: { UNRESOLVED: '' } });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).probes, { app: 200, api: 200, hq: 200, site: 200, status: 200 });
  });

  test('only hq. gets that allowance: an app host without DNS is still probed (and fails)', () => {
    sb.stub('curl', 'printf 000; exit 6');
    const r = sb.run([script], { env: { UNRESOLVED: 'app.fishtapehq.com hq.fishtapehq.com' } });
    assert.equal(r.status, 0, r.stderr);
    const probes = JSON.parse(readFileSync(out, 'utf8')).probes;
    assert.equal(probes.app, 0);
    assert.equal(probes.hq, undefined);
  });
});

test('shared backup scripts are identical in staging and production (CI checks the same)', () => {
  for (const f of ['backup.sh', 'restore-test.sh', 'offsite-drill.sh']) {
    assert.equal(src(`deploy/staging/${f}`), src(`deploy/production/${f}`), f);
  }
});

test('drill results: hq-api writes them, the worker reads them, the api has no access, update.sh makes the folder', () => {
  for (const env of ['staging', 'production']) {
    const yml = src(`deploy/${env}/docker-compose.yml`);
    const svc = (name, next) => yml.slice(yml.indexOf(`\n  ${name}:`), yml.indexOf(`\n  ${next}:`));
    assert.match(yml, /RESTORE_TESTS_FILE: \/var\/lib\/fishtape\/drills\/restore-tests\.jsonl/, env);
    assert.match(svc('hq-api', 'worker'), new RegExp(`/var/lib/fishtape-${env}/drills:/var/lib/fishtape/drills\\n`), env);
    assert.match(svc('worker', 'migrate'), new RegExp(`/var/lib/fishtape-${env}/drills:/var/lib/fishtape/drills:ro\\n`), env);
    assert.doesNotMatch(svc('api', 'hq-api'), /drills/, env);
    assert.match(src(`deploy/${env}/update.sh`), /install -d -o 1000 -g 1000 -m 700 "\$STATE_DIR\/drills"/, env);
  }
});

// ---- the offsite drill (r1-get-paid.md 5.1) ------------------------------------------------------
// rclone reads a fake bucket under the sandbox, age prints the file it is given, docker answers
// restore-test.sh's queries, and node stands in for verify-restore.mjs. Each stub records what it
// got, so the tests can check where the age key and the master key went.

const NEWEST = 'fishtape-production-20261019T024700Z.dump.age';
const OLDER = 'fishtape-production-20261018T024700Z.dump.age';
const AGE_KEY = 'AGE-SECRET-KEY-1TESTONLYNOTAKEY';

describe('offsite-drill.sh', { skip: drillSkip }, () => {
  let sb, drill, P, tmp, bucket, masterKey;
  const sha = (text) => createHash('sha256').update(text).digest('hex');
  const put = (dirRel, name, text, shaText = `${sha(text)}  ${name}\n`) => {
    mkdirSync(join(sb.dir, 'remote', dirRel), { recursive: true });
    writeFileSync(join(sb.dir, 'remote', dirRel, name), text);
    if (shaText !== null) writeFileSync(join(sb.dir, 'remote', dirRel, `${name}.sha256`), shaText);
  };
  const logFile = () => join(sb.dir, 'drills.jsonl');
  const lines = () => (existsSync(logFile()) ? readFileSync(logFile(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const read = (name) => (existsSync(join(sb.dir, name)) ? readFileSync(join(sb.dir, name), 'utf8') : '');
  const drillRun = (args, { input = '', env = {} } = {}) => sb.run([drill, ...args], { input, env: { TMPDIR: `${P}/tmp`, ...env } });
  const full = (env = {}) => drillRun(['--remote', 'drill-ro:bucket/production', '--identity', '-', '--verify-secrets', '--log', `${P}/drills.jsonl`],
    { input: `${AGE_KEY}\nSECRETS_MASTER_KEY=${masterKey}\n`, env });
  const reset = () => {
    for (const f of ['rclone.log', 'docker.log', 'node.log', 'node-stdin.txt', 'age-identity.txt', 'drills.jsonl']) rmSync(join(sb.dir, f), { force: true });
    rmSync(join(sb.dir, 'remote'), { recursive: true, force: true });
    put('bucket/production/daily', OLDER, 'older encrypted backup bytes');
    put('bucket/production/daily', NEWEST, 'newest encrypted backup bytes');
    put('bucket/production/daily', 'fishtape-staging-20261020T031700Z.dump.age', 'another environment');
    put('bucket/production/daily', 'notes.txt', 'not a backup', null);
    mkdirSync(join(sb.dir, 'remote', 'bucket/empty/daily'), { recursive: true });
  };

  before(() => {
    sb = sandbox();
    P = sb.posix;
    masterKey = randomBytes(32).toString('base64');
    const moves = [['/var/lib/', `${P}/var/lib/`], ['/var/backups/', `${P}/var/backups/`]];
    const repo = join(sb.dir, 'repo');
    drill = sb.place('deploy/production/offsite-drill.sh', join(repo, 'deploy/production/offsite-drill.sh'), moves);
    sb.place('deploy/production/restore-test.sh', join(repo, 'deploy/production/restore-test.sh'), moves);
    copyFileSync(join(ROOT, 'deploy/production/docker-compose.yml'), join(repo, 'deploy/production/docker-compose.yml'));
    mkdirSync(join(repo, 'server/scripts'), { recursive: true });
    writeFileSync(join(repo, 'server/scripts/verify-restore.mjs'), '// stand-in: node is a stub in this test\n');
    drill = drill.replace(/\\/g, '/');
    tmp = join(sb.dir, 'tmp');
    mkdirSync(tmp);
    sb.stub('rclone', [
      'args=(); cfg=""',
      'while [ $# -gt 0 ]; do case "$1" in --config) cfg="$2"; shift 2 ;; --files-only|--no-traverse) shift ;; *) args+=("$1"); shift ;; esac; done',
      'echo "${args[*]} config=$cfg" >> "$SANDBOX/rclone.log"',
      '[ -z "${RCLONE_FAIL:-}" ] || exit 1',
      'map() { local r="${1#*:}"; printf "%s/remote/%s" "$SANDBOX" "${r%/}"; }',
      'case "${args[0]}" in',
      '  lsf) d="$(map "${args[1]}")"; [ -d "$d" ] || exit 3; ls -1 "$d" ;;',
      '  copyto) cp "$(map "${args[1]}")" "${args[2]}" ;;',
      '  *) exit 9 ;;',
      'esac',
    ].join('\n'));
    sb.stub('age', [
      'f=""',
      'while [ $# -gt 0 ]; do case "$1" in -d) shift ;; -i) cat "$2" > "$SANDBOX/age-identity.txt"; shift 2 ;; *) f="$1"; shift ;; esac; done',
      'cat "$f"',
    ].join('\n'));
    sb.stub('docker', [
      'echo "docker $*" >> "$SANDBOX/docker.log"',
      'all="$*"',
      'case "$1" in',
      '  run) echo 0123456789ab ;;',
      '  rm|logs) ;;',
      '  exec) case "$all" in',
      '      *pg_isready*) exit 0 ;;',
      '      *pg_restore*) cat > /dev/null; [ -z "${RESTORE_FAIL:-}" ] || exit 1 ;;',
      '      *"FROM pg_tables"*) echo 90 ;;',
      '      *to_regclass*) echo t ;;',
      '      *"FROM schema_migrations"*) echo 41 ;;',
      '      *"FROM tenants"*) echo 3 ;;',
      '      *"FROM audit_events"*) echo 2026-10-19T02:40:00Z ;;',
      '      *string_agg*) echo "" ;;',
      '      *relforcerowsecurity*) echo 80 ;;',
      '      *pg_size_pretty*) echo "12 MB" ;;',
      '      *) echo "" ;;',
      '    esac ;;',
      'esac',
    ].join('\n'));
    sb.stub('node', [
      'echo "node $*" >> "$SANDBOX/node.log"',
      'cat > "$SANDBOX/node-stdin.txt"',
      'case "${NODE_RESULT:-ok}" in',
      '  ok) echo \'{"ok":true,"migration":"0152","tenants":3,"decrypted":4,"failures":[]}\' ;;',
      '  none) echo \'{"ok":true,"migration":"0152","tenants":3,"decrypted":0,"failures":[]}\' ;;',
      '  bad) echo \'{"ok":false,"migration":"0152","decrypted":0,"failures":["2 encrypted value(s) did not decrypt"]}\'; exit 5 ;;',
      '  *) exit 1 ;;',
      'esac',
    ].join('\n'));
  });
  after(() => sb?.cleanup());

  test('dry run: the newest backup of this environment, nothing fetched or restored', () => {
    reset();
    const r = drillRun(['--remote', 'drill-ro:bucket/production', '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`would fetch: drill-ro:bucket/production/daily/${NEWEST.replace(/\./g, '\\.')}\\n`));
    assert.match(r.stdout, /dry run: nothing fetched/);
    assert.doesNotMatch(r.stdout, /fishtape-staging|20261018/);
    assert.deepEqual(read('rclone.log').trim().split('\n'), ['lsf drill-ro:bucket/production/daily/ config=']);
    assert.equal(read('docker.log'), '');
    assert.deepEqual(lines(), []);
  });

  test('a pass: checksum, restore with the age key through a pipe, secrets checked, one off-box line, nothing left behind', () => {
    reset();
    const r = full();
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const [l] = lines();
    assert.equal(lines().length, 1);
    assert.equal(l.source, 'offsite');
    assert.equal(l.host, 'off-box');
    assert.equal(l.environment, 'production');
    assert.equal(l.ok, true);
    assert.equal(l.file, NEWEST);
    assert.equal(l.sha256, sha('newest encrypted backup bytes'));
    assert.deepEqual([l.secretsChecked, l.secretsOk, l.migration, l.migrations, l.tenants], [true, true, '0152', 41, 3]);
    assert.equal(l.failures, null);
    assert.ok(Date.parse(l.ts) > 0);
    // The age key reached age only; the master key reached node only.
    assert.match(read('age-identity.txt'), new RegExp(AGE_KEY));
    assert.doesNotMatch(read('age-identity.txt'), /SECRETS_MASTER_KEY/);
    assert.equal(read('node-stdin.txt').trim(), `SECRETS_MASTER_KEY=${masterKey}`);
    assert.match(read('node.log'), /verify-restore\.mjs --container fishtape-drill-production-\d+/);
    assert.match(read('docker.log'), /docker run -d --name fishtape-drill-production-\d+ --network none/);
    assert.match(read('docker.log'), /docker rm -f -v fishtape-drill-production-\d+/, 'the scratch database is removed');
    assert.deepEqual(readdirSync(tmp), [], 'the temp copy is deleted');
    assert.ok(!read('rclone.log').includes(OLDER), 'only the newest is fetched');
  });

  test('a checksum mismatch fails before anything is restored, and is recorded', () => {
    reset();
    put('bucket/production/daily', NEWEST, 'newest encrypted backup bytes', `${sha('something else')}  ${NEWEST}\n`);
    const r = full();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /checksum mismatch/);
    assert.doesNotMatch(read('docker.log'), /docker run/);
    const [l] = lines();
    assert.deepEqual([l.ok, l.failures], [false, 'checksum mismatch: the offsite copy is damaged or incomplete']);
    assert.deepEqual(readdirSync(tmp), []);
    // A copy without its .sha256 fails the same way.
    reset();
    rmSync(join(sb.dir, 'remote/bucket/production/daily', `${NEWEST}.sha256`));
    assert.equal(full().status, 1);
    assert.match(lines()[0].failures, /no .*\.sha256/);
  });

  test('secrets that do not decrypt: exit 5, recorded as failed, scratch database still removed', () => {
    reset();
    const r = full({ NODE_RESULT: 'bad' });
    assert.equal(r.status, 5, r.stderr);
    const [l] = lines();
    assert.deepEqual([l.ok, l.secretsChecked, l.secretsOk], [false, true, false]);
    assert.match(read('docker.log'), /docker rm -f -v fishtape-drill-production-/);
    // No encrypted values at all: a pass, but the key was not proven.
    reset();
    assert.equal(full({ NODE_RESULT: 'none' }).status, 0);
    assert.deepEqual([lines()[0].ok, lines()[0].secretsChecked], [true, false]);
    reset();
    assert.equal(full({ NODE_RESULT: 'crash' }).status, 1);
  });

  test('a failed restore: exit 1, recorded', () => {
    reset();
    const r = full({ RESTORE_FAIL: '1' });
    assert.equal(r.status, 1);
    assert.equal(lines()[0].ok, false);
    assert.match(lines()[0].failures, /restore-test\.sh failed/);
    assert.equal(read('node.log'), '', 'no secrets check after a failed restore');
  });

  test('exit codes: 2 bad usage, 3 no target or unreachable, 4 nothing to fetch; none of them records a line', () => {
    reset();
    const code = (args, opts) => drillRun(args, opts).status;
    assert.equal(code(['--bogus']), 2);
    assert.equal(code(['--remote']), 2, 'an option without its value');
    assert.equal(code([]), 3, 'no --remote and no DRILL_REMOTE');
    assert.equal(code(['--remote', 'drill-ro:bucket/production']), 2, 'no --identity -');
    assert.equal(code(['--remote', 'drill-ro:bucket/production', '--identity', '/home/me/key.txt']), 2, 'the key must come on stdin');
    assert.equal(code(['--remote', 'drill-ro:bucket/production', '--identity', '-'], { input: 'not a key\n' }), 2);
    assert.equal(code(['--remote', 'drill-ro:bucket/production', '--identity', '-', '--verify-secrets'], { input: `${AGE_KEY}\n` }), 2, 'no master key line');
    assert.equal(code(['--remote', ':s3,access_key_id=AKIAEXAMPLE:bucket', '--dry-run']), 2, 'inline connection strings are refused');
    assert.equal(code(['--remote', 'drill-ro:bucket/production', '--dry-run'], { env: { RCLONE_FAIL: '1' } }), 3);
    assert.equal(code(['--remote', 'drill-ro:bucket/empty', '--dry-run']), 4);
    assert.equal(code(['--dry-run'], { env: { DRILL_REMOTE: 'drill-ro:bucket/production' } }), 0, 'DRILL_REMOTE works too');
    assert.deepEqual(lines(), []);
  });

  test('refuses to run on a Fishtape server', () => {
    reset();
    mkdirSync(join(sb.dir, 'var/lib/fishtape-production'), { recursive: true });
    try {
      const r = drillRun(['--remote', 'drill-ro:bucket/production', '--dry-run']);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /looks like a Fishtape server/);
      assert.equal(read('rclone.log'), '');
    } finally {
      rmSync(join(sb.dir, 'var'), { recursive: true, force: true });
    }
  });
});

describe('backup.sh offsite status', { skip: drillSkip }, () => {
  let sb, script, state, here;
  const status = () => JSON.parse(readFileSync(join(state, 'status/last-backup.json'), 'utf8'));
  before(() => {
    sb = sandbox();
    here = join(sb.dir, 'deploy/production');
    state = join(sb.dir, 'var/lib/fishtape-production');
    script = sb.place('deploy/production/backup.sh', join(here, 'backup.sh'), [
      ['/var/backups/fishtape-', `${sb.posix}/var/backups/fishtape-`], ['/var/lib/fishtape-', `${sb.posix}/var/lib/fishtape-`],
    ]);
    writeFileSync(join(here, 'backup-recipients.txt'), 'age1testrecipientonlynotarealkey\n');
    writeFileSync(join(here, 'backup.conf'), [
      `AGE_RECIPIENTS_FILE=${sb.posix}/deploy/production/backup-recipients.txt`,
      'OFFSITE_RCLONE_REMOTE=offsite-ca:fishtape-backups/production',
      'OFFSITE_LABEL="s3 ca-central-1"',
      'HEARTBEAT_URL=https://hc.example.test/ping/abc',
    ].join('\n'));
    const realStat = spawnSync('bash', ['-c', 'command -v stat'], { encoding: 'utf8' }).stdout.trim();
    // backup.conf must be root's: the sandbox can't chown, so stat reports root for that call.
    sb.stub('stat', `if [ "\${2:-}" = '%u %a' ]; then echo "0 600"; else exec ${realStat} "$@"; fi`);
    sb.stub('docker', 'case "$*" in *"ps --status running"*) echo pgid ;; *pg_dump*) head -c 4096 /dev/zero | tr "\\0" x ;; esac');
    sb.stub('age', 'out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; *) shift ;; esac; done; { printf "age-encryption.org/v1\\n"; cat; } > "$out"');
    sb.stub('rclone', 'echo "$*" >> "$SANDBOX/rclone.log"; [ -z "${RCLONE_FAIL:-}" ]');
    sb.stub('curl', 'echo "$*" >> "$SANDBOX/curl.log"');
    // One backup at a time is not what this tests (and Git Bash has no flock or hostname -s).
    sb.stub('flock', 'exit 0');
    sb.stub('hostname', 'echo testhost');
  });
  after(() => sb?.cleanup());

  test('records the offsite target (kind, remote name, label; no bucket or path) and the last good copy across failures', () => {
    const ok = sb.run([script]);
    assert.equal(ok.status, 0, ok.stderr);
    const s1 = status();
    assert.deepEqual([s1.status, s1.offsite, s1.offsiteTarget], ['ok', 'ok', 'rclone offsite-ca (s3 ca-central-1)']);
    assert.ok(Date.parse(s1.lastOffsiteOkAt) > 0);
    assert.ok(!JSON.stringify(s1).includes('fishtape-backups'), 'no bucket or path in the status');
    const rcl = readFileSync(join(sb.dir, 'rclone.log'), 'utf8');
    assert.match(rcl, /copy --no-traverse \S+\.dump\.age offsite-ca:fishtape-backups\/production\/daily\//);
    assert.match(rcl, /\.dump\.age\.sha256 offsite-ca:fishtape-backups\/production\/daily\//);
    assert.match(rcl, /offsite-ca:fishtape-backups\/production\/weekly\//, 'the first nightly is also the weekly, copied offsite too');
    assert.match(ok.stdout, /offsite ok \(rclone offsite-ca \(s3 ca-central-1\)\)/);

    const failed = sb.run([script], { env: { RCLONE_FAIL: '1' } });
    assert.equal(failed.status, 0, failed.stderr);
    const s2 = status();
    assert.deepEqual([s2.status, s2.offsite, s2.lastOffsiteOkAt], ['degraded', 'failed', s1.lastOffsiteOkAt]);
    assert.match(readFileSync(join(sb.dir, 'curl.log'), 'utf8'), /\/fail/, 'the heartbeat reports the failure');
    const log = readFileSync(join(state, 'backup-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(log.map((l) => l.offsite), ['ok', 'failed']);
  });

  test('an inline rclone connection string never reaches the status file', () => {
    writeFileSync(join(here, 'backup.conf'), [
      `AGE_RECIPIENTS_FILE=${sb.posix}/deploy/production/backup-recipients.txt`,
      'OFFSITE_RCLONE_REMOTE=:s3,access_key_id=AKIAEXAMPLEONLY,secret_access_key=notreal:bucket/path',
      'HEARTBEAT_URL=https://hc.example.test/ping/abc',
    ].join('\n'));
    assert.equal(sb.run([script]).status, 0);
    const s = status();
    assert.equal(s.offsiteTarget, 'rclone ');
    assert.ok(!JSON.stringify(s).includes('AKIA'));
  });
});

describe('verify-restore.mjs against a real database', { skip: dbSkip }, () => {
  let t, url, masterKey, tenantId;
  const SCRIPT = join(ROOT, 'server/scripts/verify-restore.mjs');
  const verify = (input, args = ['--database-url', url]) => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: 'utf8', timeout: 60_000 });

  before(async () => {
    t = await createTestDatabase('verifyrestore');
    const u = new URL(TEST_DATABASE_URL);
    u.pathname = `/${t.name}`;
    url = u.toString();
    masterKey = randomBytes(32).toString('base64');
    const sealer = createSealer(masterKey);
    const { rows: [tn] } = await t.superPool.query("INSERT INTO tenants (slug, name) VALUES ('alpha-wiring', 'Alpha Wiring') RETURNING id");
    tenantId = tn.id;
    await t.superPool.query('INSERT INTO tenant_secrets (tenant_id, name, value_enc) VALUES ($1, $2, $3), ($1, $4, $5)', [
      tenantId, 'twilio.auth_token', sealer.envelopeSeal('not-a-real-token', `tenant_secret:${tenantId}:twilio.auth_token`),
      'qbo.refresh_token', sealer.envelopeSeal('not-a-real-refresh', `tenant_secret:${tenantId}:qbo.refresh_token`),
    ]);
    const { rows: [user] } = await t.superPool.query("INSERT INTO users (email, display_name) VALUES ('owner@alpha.test', 'Owner') RETURNING id");
    await t.superPool.query("INSERT INTO mfa_factors (user_id, type, secret_enc, confirmed_at) VALUES ($1, 'totp', $2, now())", [user.id, sealer.seal('mfa-totp', 'JBSWY3DPEHPK3PXP', user.id)]);
  });
  after(async () => { await t?.close(); });

  test('the right key: migration version, rows per tenant, every kind present decrypts; nothing secret printed', () => {
    const r = verify(`SECRETS_MASTER_KEY=${masterKey}\n`);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
    assert.equal(out.ok, true);
    assert.match(out.migration, /^\d{4}$/);
    assert.equal(out.migration, out.checkoutLatest);
    assert.equal(out.tenants, 1);
    assert.equal(out.perTenant[tenantId].tenant_secrets, 2);
    assert.deepEqual(out.secrets.integration_secrets, { present: 1, ok: 1, failed: 0 });
    assert.deepEqual(out.secrets.quickbooks_tokens, { present: 1, ok: 1, failed: 0 });
    assert.deepEqual(out.secrets.mfa_secrets, { present: 1, ok: 1, failed: 0 });
    assert.equal(out.decrypted, 3);
    for (const s of [r.stdout, r.stderr]) {
      assert.ok(!s.includes(masterKey) && !s.includes('not-a-real') && !s.includes('JBSWY3DP') && !s.includes('Alpha'), 'no key, value or name in the output');
    }
  });

  test('the wrong key: exit 5; a bad key or bad usage: exit 2', () => {
    const wrong = verify(`SECRETS_MASTER_KEY=${randomBytes(32).toString('base64')}\n`);
    assert.equal(wrong.status, 5, wrong.stderr);
    assert.equal(JSON.parse(wrong.stdout).decrypted, 0);
    assert.equal(verify('SECRETS_MASTER_KEY=short\n').status, 2);
    assert.equal(verify('').status, 2);
    assert.equal(verify(`${masterKey}\n`).status, 0, 'a bare value works too');
    assert.equal(verify(`SECRETS_MASTER_KEY=${masterKey}\n`, []).status, 2, 'no target');
    assert.equal(verify(`SECRETS_MASTER_KEY=${masterKey}\n`, ['--container', 'bad name!']).status, 2);
  });
});
