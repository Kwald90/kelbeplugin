#!/usr/bin/env node
// Collect SOC 2-aligned evidence into a dated folder (gitignored). Monthly, and before any review.
//
//   node compliance/evidence/collect.mjs
//   node compliance/evidence/collect.mjs --since 2026-09-01
//   node compliance/evidence/collect.mjs --ssh staging=fishtape-ops@208.113.210.97 --ssh production=fishtape-ops@<host>
//   sudo node /path/to/collect.mjs --local          (on a server: read /var/lib/fishtape-* directly)
//
// Options:
//   --since <YYYY-MM-DD>    start of the period (default: 35 days ago)
//   --out <dir>             output folder (default: compliance/evidence/out/<today>)
//   --ssh <env>=<user@host> fetch that environment's logs over SSH (`sudo -n cat`), repeatable
//   --ssh-key <file>        identity for --ssh
//   --local                 read this machine's /var/lib/fishtape-staging and -production
//   --no-gh                 skip GitHub (gh CLI) queries
//
// What it gathers (each source is optional; anything it can't reach is listed in SUMMARY.md):
//   git-changes.json          commits in the period: author, date, subject, signature, merge, AI co-author
//   ci-runs.json              GitHub Actions runs in the period (gh)
//   branch-protection.json        branch protection, rulesets, environments and their protection rules (gh)
//   access-inventory.json     collaborators, deploy keys, Actions/environment secret NAMES and dates (gh)
//   security-alerts.json      open Dependabot, code scanning and secret scanning alerts: counts and
//                             metadata only, never the secret values (gh)
//   npm-audit-server.json     npm audit of server/ production dependencies
//   osv-scanner.json          if osv-scanner is installed
//   repo-checks.txt           check-committed-files.mjs and check-csp.mjs output
//   *-<env>.*                 deploy-log, backup-log, last-backup, last-deploy, restore-tests, host-status,
//                             last-exposure-check and check-host files, e.g. deploy-log-staging.jsonl
//   controls-summary.json     compliance/controls.yaml counted by status
//   access-review-<date>.md   the quarterly access review checklist, pre-filled
//   manifest.json             what was collected, from which commit, with sha256 of every file
//   SUMMARY.md                human-readable summary, skipped sources, things to add by hand
//
// Nothing secret is written: the GitHub API never returns secret values except in secret
// scanning alerts, whose `secret` field is dropped, and every file passes through redact().
// Keep bundles outside git: zip the folder and store it encrypted (docs/compliance/README.md).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const COLLECTOR_VERSION = 1;
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const today = new Date().toISOString().slice(0, 10);

// ---- args ----
const args = process.argv.slice(2);
const opt = { since: null, out: null, ssh: {}, sshKey: null, local: false, gh: true };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--since') opt.since = args[++i];
  else if (a === '--out') opt.out = args[++i];
  else if (a === '--ssh') { const [env, target] = String(args[++i]).split('='); opt.ssh[env] = target; }
  else if (a === '--ssh-key') opt.sshKey = args[++i];
  else if (a === '--local') opt.local = true;
  else if (a === '--no-gh') opt.gh = false;
  else if (a === '-h' || a === '--help') { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 32).join('\n')); process.exit(0); }
  else { console.error(`unknown option ${a}`); process.exit(2); }
}
const since = opt.since || new Date(Date.now() - 35 * 86400e3).toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) { console.error('--since must be YYYY-MM-DD'); process.exit(2); }
for (const [env, target] of Object.entries(opt.ssh)) {
  if (!['staging', 'production'].includes(env) || !/^[A-Za-z0-9._-]+@[A-Za-z0-9.:-]+$/.test(target || '')) {
    console.error(`--ssh expects staging=user@host or production=user@host (got ${env}=${target})`); process.exit(2);
  }
}
const OUT = opt.out || join(ROOT, 'compliance', 'evidence', 'out', today);
mkdirSync(OUT, { recursive: true });

// ---- helpers ----
const skipped = [];
const collected = [];
const run = (cmd, argv, o = {}) => execFileSync(cmd, argv, { cwd: o.cwd || ROOT, encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'], timeout: o.timeout || 120000 });
const tryRun = (cmd, argv, o) => { try { return { ok: true, out: run(cmd, argv, o) }; } catch (e) { return { ok: false, out: String(e.stdout || ''), err: String(e.stderr || e.message).trim().split('\n').slice(-3).join(' ') }; } };
const has = (cmd) => tryRun(cmd, ['--version']).ok;

const SECRET_PATTERNS = [
  [/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, '$1[REDACTED]@'],
  [/\bft_(live|test)_[A-Za-z0-9_-]{8,}/g, 'ft_$1_[REDACTED]'],
  [/AGE-SECRET-KEY-1[0-9A-Z]{20,}/g, 'AGE-SECRET-KEY-[REDACTED]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[REDACTED GITHUB TOKEN]'],
  [/\b(sk|rk)_(live|test)_[A-Za-z0-9]{10,}/g, '$1_$2_[REDACTED]'],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, 'sk-ant-[REDACTED]'],
  [/((?:SECRETS_MASTER_KEY|[A-Z_]*PASSWORD|[A-Z_]*SECRET|[A-Z_]*TOKEN)\s*[=:]\s*["']?)[^\s"',}]+/g, '$1[REDACTED]'],
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED]'],
];
const redact = (s) => SECRET_PATTERNS.reduce((t, [re, rep]) => t.replace(re, rep), String(s));
function write(name, data) {
  const file = join(OUT, name);
  mkdirSync(dirname(file), { recursive: true });
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n';
  writeFileSync(file, redact(text));
  collected.push(name);
}
const skip = (what, why) => { skipped.push({ what, why }); console.log(`skip  ${what}: ${why}`); };
const ok = (what) => console.log(`ok    ${what}`);

// ---- repo identity ----
const head = tryRun('git', ['rev-parse', 'HEAD']).out.trim();
const branch = tryRun('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim();
let repo = null;
const remote = tryRun('git', ['remote', 'get-url', 'origin']).out.trim();
const m = remote.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/);
if (m) repo = m[1];

// ---- 1. git history ----
{
  const fmt = ['%H', '%an', '%ae', '%aI', '%s', '%G?', '%P', '%(trailers:key=Co-Authored-By,valueonly,separator=%x2C)'].join('%x1f');
  const r = tryRun('git', ['log', '--all', `--since=${since}T00:00:00`, `--pretty=format:${fmt}%x1e`]);
  if (!r.ok) skip('git-changes.json', r.err);
  else {
    const commits = r.out.split('\x1e').map((s) => s.trim()).filter(Boolean).map((line) => {
      const [sha, author, email, date, subject, sig, parents, coauthors] = line.split('\x1f');
      const co = (coauthors || '').split(',').map((s) => s.trim()).filter(Boolean);
      return { sha, author, email, date, subject, signature: sig, merge: (parents || '').trim().split(/\s+/).length > 1, coAuthors: co, aiCoAuthored: co.some((c) => /claude|anthropic|copilot|openai|gpt/i.test(c)) };
    });
    const byAuthor = {};
    for (const c of commits) byAuthor[c.author] = (byAuthor[c.author] || 0) + 1;
    write('git-changes.json', {
      period: { since, until: today }, head, branch, total: commits.length, merges: commits.filter((c) => c.merge).length,
      aiCoAuthored: commits.filter((c) => c.aiCoAuthored).length,
      signed: commits.filter((c) => ['G', 'U', 'X', 'Y'].includes(c.signature)).length, byAuthor, commits,
    });
    ok(`git-changes.json (${commits.length} commits)`);
  }
}

// ---- 2-5. GitHub ----
const ghOk = opt.gh && repo && has('gh') && tryRun('gh', ['auth', 'status']).ok;
if (!opt.gh) skip('GitHub sources', '--no-gh');
else if (!repo) skip('GitHub sources', 'origin is not a github.com remote');
else if (!ghOk) skip('GitHub sources', 'gh CLI missing or not signed in (gh auth login)');
const ghJson = (path, extra = []) => {
  const r = tryRun('gh', ['api', '-H', 'Accept: application/vnd.github+json', ...extra, path]);
  if (!r.ok) return { error: r.err.includes('404') ? 'not found or not enabled' : r.err };
  try { return JSON.parse(r.out); } catch { return { error: 'unparseable response' }; }
};
const ghPaged = (path) => {
  const r = tryRun('gh', ['api', '--paginate', '--slurp', '-H', 'Accept: application/vnd.github+json', path]);
  if (!r.ok) return { error: r.err.includes('404') ? 'not found or not enabled' : r.err };
  try { return JSON.parse(r.out).flat(); } catch { return { error: 'unparseable response' }; }
};
if (ghOk) {
  // CI runs
  const runs = tryRun('gh', ['run', 'list', '--repo', repo, '--limit', '500', '--json', 'databaseId,workflowName,headBranch,headSha,event,status,conclusion,createdAt,url']);
  if (runs.ok) {
    const list = JSON.parse(runs.out).filter((r) => r.createdAt >= since);
    const byWorkflow = {};
    for (const r of list) { const k = r.workflowName; byWorkflow[k] ||= {}; byWorkflow[k][r.conclusion || r.status] = (byWorkflow[k][r.conclusion || r.status] || 0) + 1; }
    write('ci-runs.json', { period: { since, until: today }, total: list.length, byWorkflow, runs: list });
    ok(`ci-runs.json (${list.length} runs)`);
  } else skip('ci-runs.json', runs.err);

  // repository settings
  const repoInfo = ghJson(`repos/${repo}`);
  const defaultBranch = repoInfo.default_branch;
  const branches = [...new Set([defaultBranch, 'claude/electrical-concept-app-h4qz12'].filter(Boolean))];
  const protection = Object.fromEntries(branches.map((b) => [b, ghJson(`repos/${repo}/branches/${encodeURIComponent(b)}/protection`)]));
  const envs = ghJson(`repos/${repo}/environments`);
  write('branch-protection.json', {
    repo, visibility: repoInfo.visibility, defaultBranch,
    securityAndAnalysis: repoInfo.security_and_analysis || null,
    branchProtection: protection,
    rulesets: ghJson(`repos/${repo}/rulesets`),
    environments: Array.isArray(envs.environments) ? envs.environments.map((e) => ({
      name: e.name, protectionRules: e.protection_rules, deploymentBranchPolicy: e.deployment_branch_policy, updatedAt: e.updated_at,
    })) : envs,
  });
  ok('branch-protection.json');

  // access inventory (names and dates only)
  const collaborators = ghPaged(`repos/${repo}/collaborators?affiliation=all&per_page=100`);
  const keys = ghPaged(`repos/${repo}/keys?per_page=100`);
  const actionSecrets = ghJson(`repos/${repo}/actions/secrets?per_page=100`);
  const envSecrets = {};
  for (const e of (envs.environments || [])) envSecrets[e.name] = ghJson(`repos/${repo}/environments/${encodeURIComponent(e.name)}/secrets?per_page=100`);
  const names = (s) => (Array.isArray(s?.secrets) ? s.secrets.map((x) => ({ name: x.name, createdAt: x.created_at, updatedAt: x.updated_at })) : s);
  const variables = ghJson(`repos/${repo}/actions/variables?per_page=100`);
  write('access-inventory.json', {
    collaborators: Array.isArray(collaborators) ? collaborators.map((c) => ({ login: c.login, role: c.role_name, permissions: c.permissions })) : collaborators,
    deployKeys: Array.isArray(keys) ? keys.map((k) => ({ id: k.id, title: k.title, readOnly: k.read_only, createdAt: k.created_at, lastUsed: k.last_used ?? null })) : keys,
    actionsSecrets: names(actionSecrets),
    environmentSecrets: Object.fromEntries(Object.entries(envSecrets).map(([k, v]) => [k, names(v)])),
    actionsVariables: Array.isArray(variables?.variables) ? variables.variables.map((v) => ({ name: v.name, value: v.value, updatedAt: v.updated_at })) : variables,
  });
  ok('access-inventory.json');

  // security alerts (metadata only)
  const dep = ghPaged(`repos/${repo}/dependabot/alerts?state=open&per_page=100`);
  const code = ghPaged(`repos/${repo}/code-scanning/alerts?state=open&per_page=100`);
  const sec = ghPaged(`repos/${repo}/secret-scanning/alerts?state=open&per_page=100`);
  const count = (list, sev) => (Array.isArray(list) ? list.reduce((o, a) => { const k = sev(a) || 'unknown'; o[k] = (o[k] || 0) + 1; return o; }, {}) : list);
  write('security-alerts.json', {
    dependabot: { open: Array.isArray(dep) ? dep.length : dep, bySeverity: count(dep, (a) => a.security_advisory?.severity),
      alerts: Array.isArray(dep) ? dep.map((a) => ({ number: a.number, package: a.dependency?.package?.name, severity: a.security_advisory?.severity, ghsa: a.security_advisory?.ghsa_id, createdAt: a.created_at, url: a.html_url })) : [] },
    codeScanning: { open: Array.isArray(code) ? code.length : code, bySeverity: count(code, (a) => a.rule?.security_severity_level || a.rule?.severity),
      alerts: Array.isArray(code) ? code.map((a) => ({ number: a.number, rule: a.rule?.id, tool: a.tool?.name, severity: a.rule?.security_severity_level || a.rule?.severity, createdAt: a.created_at, url: a.html_url })) : [] },
    // `secret` (the leaked value) is deliberately never copied.
    secretScanning: { open: Array.isArray(sec) ? sec.length : sec,
      alerts: Array.isArray(sec) ? sec.map((a) => ({ number: a.number, type: a.secret_type_display_name, createdAt: a.created_at, pushProtectionBypassed: a.push_protection_bypassed, url: a.html_url })) : [] },
  });
  ok('security-alerts.json');
}

// ---- 6. dependency audits ----
if (existsSync(join(ROOT, 'server', 'package-lock.json'))) {
  // On Windows npm is npm.cmd, which Node only starts through cmd.exe (fixed arguments, no input).
  const r = process.platform === 'win32'
    ? tryRun('cmd.exe', ['/d', '/c', 'npm', 'audit', '--json', '--omit=dev'], { cwd: join(ROOT, 'server') })
    : tryRun('npm', ['audit', '--json', '--omit=dev'], { cwd: join(ROOT, 'server') });
  const text = r.out || '';
  try { const j = JSON.parse(text); write('npm-audit-server.json', { metadata: j.metadata, vulnerabilities: j.vulnerabilities }); ok('npm-audit-server.json'); }
  catch { skip('npm-audit-server.json', r.err || 'npm audit gave no JSON (offline?)'); }
} else skip('npm-audit-server.json', 'server/package-lock.json not found');
if (has('osv-scanner')) {
  const r = tryRun('osv-scanner', ['scan', 'source', '--recursive', '--format', 'json', '.'], { timeout: 300000 });
  if (r.out.trim().startsWith('{')) { write('osv-scanner.json', r.out); ok('osv-scanner.json'); } else skip('osv-scanner.json', r.err || 'no output');
} else skip('osv-scanner.json', 'osv-scanner not installed (CI runs it weekly: see ci-runs.json)');

// ---- 7. repo checks ----
{
  const parts = [];
  for (const s of ['.github/scripts/check-committed-files.mjs', '.github/scripts/check-csp.mjs']) {
    if (!existsSync(join(ROOT, s))) continue;
    const r = tryRun(process.execPath, [join(ROOT, s)]);
    parts.push(`$ node ${s}\n${r.ok ? r.out : r.out + '\n' + r.err}\nexit: ${r.ok ? 0 : 'non-zero'}\n`);
  }
  if (parts.length) { write('repo-checks.txt', parts.join('\n')); ok('repo-checks.txt'); }
}

// ---- 8. server logs ----
// Bundle names carry the environment: deploy-log-staging.jsonl, last-backup-production.json, ...
const SERVER_FILES = ['deploy-log.jsonl', 'backup-log.jsonl', 'restore-tests.jsonl', 'last-exposure-check.txt', 'status/last-backup.json', 'status/last-deploy.json', 'status/host-status.json'];
const bundleName = (f, env) => f.replace('status/', '').replace(/^(.*?)(\.[a-z]+)$/, `$1-${env}$2`);
for (const env of ['staging', 'production']) {
  const base = `/var/lib/fishtape-${env}`;
  if (opt.local) {
    if (!existsSync(base)) { skip(`${env} logs`, `${base} not found on this machine`); continue; }
    for (const f of SERVER_FILES) {
      const p = join(base, f);
      if (existsSync(p)) { write(bundleName(f, env), readFileSync(p, 'utf8')); ok(bundleName(f, env)); }
    }
    for (const f of readdirSync(base).filter((n) => /^check-host-.*\.json$/.test(n)).sort().slice(-1)) {
      write(`check-host-${env}.json`, readFileSync(join(base, f), 'utf8')); ok(`check-host-${env}.json (${f})`);
    }
  } else if (opt.ssh[env]) {
    const sshArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', ...(opt.sshKey ? ['-i', opt.sshKey] : []), opt.ssh[env]];
    for (const f of [...SERVER_FILES, 'LATEST_CHECK_HOST']) {
      const remote = f === 'LATEST_CHECK_HOST'
        ? `ls -1 ${base}/check-host-*.json 2>/dev/null | tail -1 | xargs -r sudo -n cat`
        : `sudo -n cat ${base}/${f}`;
      const r = tryRun('ssh', [...sshArgs, remote], { timeout: 60000 });
      const name = f === 'LATEST_CHECK_HOST' ? `check-host-${env}.json` : bundleName(f, env);
      if (r.ok && r.out.trim()) { write(name, r.out); ok(name); }
      else if (f !== 'LATEST_CHECK_HOST') skip(name, r.ok ? 'empty or missing on the server' : r.err);
    }
  } else skip(`${env} logs`, `pass --ssh ${env}=user@host, or run with --local on the server`);
}

// ---- 9. controls summary ----
const controlsFile = join(ROOT, 'compliance', 'controls.yaml');
const controls = [];
if (existsSync(controlsFile)) {
  let cur = null;
  for (const line of readFileSync(controlsFile, 'utf8').split(/\r?\n/)) {
    const id = line.match(/^\s*- id:\s*["']?([A-Z]+-\d+)/);
    if (id) { cur = { id: id[1] }; controls.push(cur); continue; }
    if (!cur) continue;
    const kv = line.match(/^\s{4}(title|status|frequency):\s*["']?(.*?)["']?\s*$/);
    if (kv) cur[kv[1]] = kv[2];
  }
  const byStatus = {};
  for (const c of controls) (byStatus[c.status || 'unknown'] ||= []).push(c.id);
  write('controls-summary.json', { total: controls.length, counts: Object.fromEntries(Object.entries(byStatus).map(([k, v]) => [k, v.length])), byStatus, controls });
  ok(`controls-summary.json (${controls.length} controls)`);
} else skip('controls-summary.json', 'compliance/controls.yaml not found');

// ---- 10. access review checklist ----
{
  let inv = null;
  try { inv = JSON.parse(readFileSync(join(OUT, 'access-inventory.json'), 'utf8')); } catch { /* gh skipped */ }
  const rows = (list, fn) => (Array.isArray(list) && list.length ? list.map(fn).join('\n') : '| (not collected: fill in by hand) | | | |');
  const md = `# Access review ${today}

Quarterly (Jan, Apr, Jul, Oct). Procedure: docs/compliance/access-control.md. For each row, decide
keep / change / remove, act on it, and initial. Keep this file in the evidence bundle.

Reviewer: ______________________  Date: ____________

## GitHub repository ${repo || ''}

| account | role | 2FA confirmed | decision |
| --- | --- | --- | --- |
${rows(inv?.collaborators, (c) => `| ${c.login} | ${c.role} | | |`)}

Deploy keys:

| title | read-only | created | last used | decision |
| --- | --- | --- | --- | --- |
${rows(inv?.deployKeys, (k) => `| ${k.title} | ${k.readOnly} | ${k.createdAt} | ${k.lastUsed ?? ''} | |`)}

Secrets (names only; rotate any older than the schedule in docs/security/secrets-management.md):

| scope | name | updated | decision |
| --- | --- | --- | --- |
${[...(Array.isArray(inv?.actionsSecrets) ? inv.actionsSecrets.map((s) => `| repository | ${s.name} | ${s.updatedAt} | |`) : []),
   ...Object.entries(inv?.environmentSecrets || {}).flatMap(([env, list]) => (Array.isArray(list) ? list.map((s) => `| ${env} | ${s.name} | ${s.updatedAt} | |`) : []))].join('\n') || '| (none or not collected) | | | |'}

## Servers (run on each host and paste the output)

\`\`\`
getent passwd | awk -F: '$7 !~ /(nologin|false)$/ {print $1}'      # accounts with a login shell
sudo grep -H . /home/*/.ssh/authorized_keys /root/.ssh/authorized_keys 2>/dev/null | cut -c1-120
sudo grep -rh . /etc/sudoers.d/ | grep -v '^#'
\`\`\`

| host | account | why it exists | decision |
| --- | --- | --- | --- |
| staging 208.113.210.97 | ubuntu | | |
| staging | fishtape-deploy | CI deploy (forced command) | |
| production | | | |

## Application

- [ ] HQ staff accounts (platform_role set) all belong to current staff; MFA enrolled on each.
- [ ] Owners and admins of TG Electrical and every tenant on staging have MFA (owners/admins require it).
- [ ] API keys unused for 90 days revoked; agent keys scoped to what they need.
- [ ] Shared iPads (devices) still in use; lost or retired ones revoked.

## Vendor consoles (MFA on, only current people, no shared logins)

| vendor | accounts reviewed | MFA on | decision |
| --- | --- | --- | --- |
| GitHub (account security, sessions, PATs, OAuth apps) | | | |
| Domain registrar / DNS | | | |
| DreamHost (staging VPS) | | | |
| dotmoose (production host) | | | |
| Anthropic | | | |
| Stripe | | | |
| Twilio | | | |
| Resend | | | |
| Meta (Facebook business / Lead Ads) | | | |
| Apple Developer / App Store Connect | | | |
| Google Cloud (OAuth client) | | | |
| Microsoft Entra (OAuth app) | | | |
| Password manager (emergency access) | | | |
| Backup storage / uptime monitor | | | |

Sign-off: all removals done on ____________ by ____________.
`;
  write(`access-review-${today}.md`, md);
  ok(`access-review-${today}.md`);
}

// ---- manifest and summary ----
const files = [];
(function walk(dir) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (!['manifest.json', 'SUMMARY.md'].includes(n)) files.push({ path: relative(OUT, p).replaceAll('\\', '/'), bytes: statSync(p).size, sha256: createHash('sha256').update(readFileSync(p)).digest('hex') });
  }
})(OUT);
write('manifest.json', {
  collector: { version: COLLECTOR_VERSION, script: 'compliance/evidence/collect.mjs' },
  collectedAt: new Date().toISOString(), period: { since, until: today }, repo, branch, head, node: process.version,
  files, skipped,
});
let summary = `# Evidence bundle ${today}

Period ${since} to ${today}. Collected from ${repo || 'the local repo'} at ${branch} ${head.slice(0, 12)}.

## Collected

${files.map((f) => `- ${f.path} (${f.bytes} bytes)`).join('\n')}

## Not collected

${skipped.length ? skipped.map((s) => `- ${s.what}: ${s.why}`).join('\n') : '- nothing skipped'}

## Add by hand before you close the bundle

- GitHub account security log export (Settings, Security log; GitHub keeps it for a limited time).
- The completed access review (access-review-${today}.md), when it is a review month.
- Restore test output if it was run on your own computer (restore-test.sh --log).
- Incident records, post-incident reviews, DR drill and tabletop notes from the period.
- Vendor review notes, risk register changes, policy review log entries, training record.

Then: zip this folder, store it encrypted outside git (docs/compliance/README.md), keep 3 years.
`;
if (controls.length) {
  const counts = controls.reduce((o, c) => ((o[c.status] = (o[c.status] || 0) + 1), o), {});
  summary += `\nControls: ${controls.length} (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}).\n`;
}
write('SUMMARY.md', summary);
console.log(`\nEvidence written to ${OUT}\n${collected.length} files, ${skipped.length} sources skipped (see SUMMARY.md).`);
