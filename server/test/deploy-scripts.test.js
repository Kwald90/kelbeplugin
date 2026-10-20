// The operator scripts in deploy/, run for real in a throwaway folder: each script is copied with
// its absolute paths (/srv, /var/lib, /etc, ...) moved under the sandbox, and the commands that
// need root or a live host (id, chown, docker, curl, getent, nginx, ...) are stubs on PATH.
// Linux only (bash, flock, GNU find); skipped elsewhere.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const src = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const skip = process.platform === 'win32' || spawnSync('bash', ['-c', 'command -v awk flock cmp find mktemp readlink'], { encoding: 'utf8' }).status !== 0
  ? 'needs bash, awk, flock, cmp and GNU find (Linux)' : false;

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
  const run = (args, { input = '', env = {} } = {}) => spawnSync('bash', args, {
    input, encoding: 'utf8', timeout: 60_000, env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, SANDBOX: dir, ...env },
  });
  return { dir, stub, place, run, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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
