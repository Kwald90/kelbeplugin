# Runbooks

Step-by-step procedures for running Fishtape. Each one says when to use it, what you need, the
commands, how to check it worked, and what to record. Policies (the "why" and "how often") are in
[docs/compliance/](../compliance/README.md); security background is in [docs/security/](../security/README.md).

| runbook | use it when |
| --- | --- |
| [deploy-staging.md](deploy-staging.md) | shipping a commit to tgelectrical.truecollarbuilt.com |
| [deploy-production.md](deploy-production.md) | releasing a `v*` tag to app.fishtapehq.com |
| [rollback.md](rollback.md) | a deploy went wrong and the automatic rollback didn't cover it |
| [restore-from-backup.md](restore-from-backup.md) | testing a backup, recovering lost or corrupted data, or rebuilding a host |
| [incident-response.md](incident-response.md) | anything that might be an outage, a breach or a compromise |
| [rotate-secrets.md](rotate-secrets.md) | scheduled rotation, a leaked secret, or someone leaving |
| [onboard-tenant.md](onboard-tenant.md) | a new electrical company signs up |
| [offboard-tenant.md](offboard-tenant.md) | a company leaves, or asks for its data or for deletion |
| [on-call.md](on-call.md) | how one person stays on call: alerts, daily and weekly checks |

Conventions:

- Hosts: staging is the shared VPS (checkout `/var/www/tgelectrical/current`), production is the
  dotmoose host (checkout `/srv/fishtape/repo`). `<env>` is `staging` or `production`.
- `dc` below means `sudo docker compose` run from `deploy/<env>/` in that checkout.
- Every deploy, backup and restore test writes a JSON line under `/var/lib/fishtape-<env>/`.
  Incidents and reviews go in the encrypted evidence store, never in git (this repo is public).
