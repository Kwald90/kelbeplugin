# Change management policy

How code, configuration and database changes get from a laptop to production, and how a one-person
team keeps that honest.

| | |
| --- | --- |
| Owner | Kelvin Waldner |
| Applies to | Application code, database migrations, CI/CD workflows, deploy scripts, nginx and host configuration, in every environment |
| Review cadence | Annually, and after a SEV1/SEV2 incident or a change to the release process |
| Last reviewed | 2026-10-19 |
| Related controls | CHG-01 to CHG-07, SDL-01, SDL-07 |

## Purpose

Every change is tracked, tested and approved before it reaches customers, and can be traced and
undone afterwards.

## Scope

Everything that changes how Fishtape behaves: code in this repository, `.github/`, `deploy/`,
migrations, nginx files on the hosts, host packages and settings, GitHub settings.

## Policy

1. All changes go through git. Nothing is edited by hand on a server and left there; `update.sh`
   discards local edits to tracked files and records that it did.
2. Changes from contractors and AI agents arrive on their own branch or as a pull request. Kelvin
   reviews the diff before it is merged into the release branch `claude/electrical-concept-app-h4qz12`.
3. CI must pass before anything is deployed.
4. Staging gets a change before production does.
5. Production deploys only from a `v*` tag on the release branch, pointing at the commit CI tested,
   after Kelvin approves the run in the GitHub `production` environment.
6. Database migrations are forward-only and follow expand/contract.
7. Every deploy writes a line to the deploy log, and the log is reviewed monthly.

## How it's done here

### Pull requests and CI gates

The pull request template has a security checklist (secrets, tenant isolation, input validation,
logging, migrations). CODEOWNERS is `* @Kwald90`. These checks run on every push and pull request
and gate deploys through the `ci-ok` job:

| workflow | checks |
| --- | --- |
| `ci.yml` | Web unit tests (`node --test`, Node 22). CSP guard (`check-csp.mjs`: inline styles and scripts covered by CSP hashes, no `eval` or inline handlers, staging and production CSP identical). Infra lint: shellcheck, actionlint, `docker compose config`, `nginx -t` in a container, identical-copy check of shared deploy scripts. Server job when `server/` exists: Postgres 17 service, `bootstrap.sql`, `npm ci`, lint, migrate, `npm test`, Docker build and a container smoke test of `/api/healthz` and `/api/readyz`. Final `ci-ok` gate. |
| `security.yml` | gitleaks over the full history, CodeQL (`security-extended`), osv-scanner and `npm audit` (high and above), dependency review on pull requests (fails on high). Also weekly. |

Branch protection on the release branch must require `ci-ok` (a GitHub setting Kelvin turns on;
`branch-protection.json` in the evidence bundle shows it). Third-party actions are pinned to commit
SHAs and workflows default to `contents: read`.

### Staging

`deploy-staging.yml` deploys after CI passes on a push to the release branch, through the
`fishtape-deploy` forced command (off until `STAGING_DEPLOY_ENABLED=true`). By hand:
`sudo deploy/staging/update.sh`. See [docs/runbooks/deploy-staging.md](../runbooks/deploy-staging.md).

### Production

1. Check the change on staging.
2. Tag the release: `git tag -a v1.2.3 -m "..." && git push origin v1.2.3`.
3. `deploy-production.yml` re-runs CI, checks the tag format and that the tag is on the release branch.
4. The deploy job waits in the `production` environment until Kelvin approves it. Approve only
   after reading the change list for the tag. The pause is deliberate.
5. `update.sh` checks the tag again, refuses a tag that moved since CI tested it, takes a required
   encrypted backup, migrates, switches containers, waits for `/api/readyz`, publishes the static
   release folder and flips the symlink.

See [docs/runbooks/deploy-production.md](../runbooks/deploy-production.md).

### Migrations

- Expand/contract: first add (new nullable columns or tables, backfill, code that writes both),
  deploy, and only remove the old shape in a later release when no running code uses it. The
  previous release must keep working against the new schema.
- Forward-only: no down migrations. Fix a bad migration with a new one.
- The migrate container is the only place the `fishtape_owner` role is used.
- The pre-deploy backup is the last resort if data is damaged ([backup-retention.md](backup-retention.md)).

### Rollback

`update.sh` rolls back automatically if migrations fail or `/api/readyz` doesn't come up: the
previous image is restarted and, in production, the web root symlink is pointed back. By hand:
`update.sh --sha <known-good>` (staging) or `update.sh --tag <previous tag>` (production). Schema
changes are not rolled back; that is why migrations are expand/contract. See
[docs/runbooks/rollback.md](../runbooks/rollback.md).

### Emergency changes

When production is down or being attacked, Kelvin may shorten the process: deploy by hand on the
host, or with `--skip-backup` (production logs it in the actor field). The change must still be
committed to git. Within 2 business days, write up what changed and why, make sure CI passes on the
commit that is running, and record it in the monthly change review.

### Host and nginx changes

Changes to `deploy/` files are linted in CI. The live nginx files are not changed automatically:
back up the live file, edit, `nginx -t`, reload, and commit the matching change to `deploy/`.
On staging, never touch other sites' files. Run `check-host.sh` after any production host change.

### Deploy log

Every run of `update.sh` appends one JSON line to `/var/lib/fishtape-<env>/deploy-log.jsonl`:
time, environment, result (`success`, `noop`, `failed`, `rolled_back`, `rollback_failed`), from and
to commit, tag (production), actor (a GitHub run id or the sudo user) and a message. The evidence
collector copies it into the monthly bundle as `deploy-log-<env>.jsonl`.

## Segregation of duties

A normal control says the person who writes a change is not the person who approves or deploys it.
Fishtape has one person, so that can't be met. These controls compensate:

| compensating control | how |
| --- | --- |
| Automated CI as an independent check | Tests, lint, CSP guard and security scanners run on every change and can't be skipped for a deploy. |
| Required environment approval | Production waits for an explicit approval in GitHub. Kelvin reads the tag's change list before approving. |
| AI-assisted review | Security-relevant changes (auth, RLS, migrations, crypto, HQ, deploy scripts, workflows) get `/code-review` and `/security-review` before merge, and the result is noted in the pull request. |
| Review of others' work | Changes from contractors and AI agents are always reviewed by Kelvin before merge. |
| Monthly self-review | Compare the deploy log with tags, CI runs and merged changes (`deploy-log-<env>.jsonl`, `git-changes.json`, `ci-runs.json`). Every production deploy should have a tag, a green CI run and an approval. Explain anything else. |

When a second person with the right skills joins, add required pull request reviews by someone other
than the author.

## Evidence

- `git-changes.json`, `ci-runs.json`, `branch-protection.json` in the monthly bundle.
- `deploy-log-staging.jsonl`, `deploy-log-production.jsonl`.
- GitHub deployment history for the `production` environment (who approved, when).
- Pull requests with the completed security checklist and review notes.
- Emergency change write-ups.

## Exceptions

Through [information-security.md](information-security.md#exceptions). Emergency changes follow the
section above and are not exceptions.

## Review log

| date | reviewer | result | notes |
| --- | --- | --- | --- |
| 2026-10-19 | Kelvin Waldner | First version | Drafted with an AI agent; adopted when Kelvin merges it. |
