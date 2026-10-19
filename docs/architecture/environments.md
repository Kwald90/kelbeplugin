# Environments

Three environments, one codebase. They never share data, secrets, backup keys, OAuth apps or
deploy keys. Code moves one way: local, then staging (every push to the branch that passes CI),
then production (a `v*` tag, CI again, and Kelvin's approval).

| | local | staging | production |
| --- | --- | --- | --- |
| URL | http://localhost:8080 (+ API on :3410) | https://tgelectrical.truecollarbuilt.com | https://app.fishtapehq.com, https://hq.fishtapehq.com, https://status.fishtapehq.com |
| Host | Kelvin's PC (or any dev machine) | shared VPS 208.113.210.97 (Ubuntu 24.04, CloudPanel nginx, Docker) | dedicated VPS at dotmoose (to be confirmed: OS, location, disk encryption) |
| Code | working tree | branch `claude/electrical-concept-app-h4qz12`, any commit on it | `v*` tags on the release branch only |
| Deploy | none | `deploy/staging/update.sh` (by CI or by hand) | `deploy/production/update.sh --tag` (by CI after approval) |
| PWA served from | `python -m http.server` in `electrical-app/` | the git checkout's `electrical-app/` | a copied release folder, `/srv/fishtape/www/current` |
| API | `node server/src/index.js` (`HOST=127.0.0.1`) | compose `fishtape-staging`: `api` 127.0.0.1:3410, `hq-api` 127.0.0.1:3411, `worker` | compose `fishtape-production`: same ports, own host |
| HQ | `/api/hq/` on the local API | `/hq/` and `/api/hq/` on the staging host | its own host, `hq.fishtapehq.com` |
| Postgres | `deploy/local`, 127.0.0.1:5433 | container, 127.0.0.1:5433 (the host's own Postgres on 5432 belongs to other sites) | container, no host port |
| Data | seeds | seeded test companies + TG Electrical (test data only) | real customer data |
| Secrets | `server/.env` (dev key allowed) | `deploy/staging/.env`, root 600 | `deploy/production/.env`, root 600, never copied from staging |
| Backups | none | nightly, age-encrypted, 14 daily / 8 weekly | nightly, age-encrypted, offsite copy in Canada required, heartbeat |
| Headers | none | nginx: HSTS, CSP, Permissions-Policy, allow-list of app files | same, plus rate limits, HQ on its own host, no API docs |
| Who can change it | the developer | anyone who can push to the branch (= root on the shared VPS: see the threat model) | Kelvin, through the `production` environment approval |

## Rules

- Nothing real in staging: no production data, no real customer details, no production secrets.
  Staging shares a box with unrelated sites and is treated as untrusted.
- Each environment has its own `SECRETS_MASTER_KEY`, database passwords, OAuth clients, age backup
  key, and CI deploy key. Generating them is `init-env.sh` plus the READMEs.
- `.env` files live outside every web root, root-owned, mode 600, and never in git (CI fails if
  one is committed; `update.sh` refuses a commit that tracks one).
- Ports are bound to 127.0.0.1 only. nginx is the only thing listening publicly.
- The API's behaviour differs by `APP_ENV` only where the contract says so: the seed refuses
  production, the development master key is refused outside local, error bodies carry debug
  text only locally.

## Status page

`status.fishtapehq.com` currently points at the production host and returns `/api/v1/status`.
A status page on the same box goes down with it, so before launch move it to an external status
service (Better Stack, Instatus or similar, with a CNAME) that watches `/api/readyz` from outside
and can be updated by hand during an incident.

## Promotion checklist

| step | where | gate |
| --- | --- | --- |
| commit | local | tests pass locally (`node --test electrical-app/tests/*.test.mjs`, `npm test` in server/) |
| push | branch | CI passed (tests, CSP guard, deploy checks, server tests, image smoke test) and Security workflow green |
| staging | automatic | `update.sh` readiness checks, `check-exposure.sh` 0 fail, a look on the iPad |
| tag | Kelvin | release notes, migrations expand/contract, at least a day on staging for risky changes |
| production | approval | CI on the tag, Kelvin's approval with a comment, readiness and exposure checks |

Details: [deploy-staging.md](../runbooks/deploy-staging.md),
[deploy-production.md](../runbooks/deploy-production.md), [rollback.md](../runbooks/rollback.md).
