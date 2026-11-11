# T5 — Data lifecycle: purge jobs + tenant export/delete

**Closes toward green:** DAT-03 (`partial`), DAT-04 (`planned`).
**Lane:** B, **partly blocked on the API** — do the parts whose surface exists; task-file the rest.

## Why these aren't green

- DAT-03 (retention & disposal): backup pruning is implemented, but **purge jobs** for tombstones,
  expired sessions, and closed-tenant data are planned.
- DAT-04 (tenant offboarding, export & deletion): export-then-delete flow is planned; the runbook
  `docs/runbooks/offboard-tenant.md` is the anchor.

## Deliverable (do what the current API supports; clearly mark what's blocked)

1. **Retention schedule doc** (always doable): confirm/extend `docs/compliance/backup-retention.md`
   and `docs/compliance/data-classification.md` so every data class has a concrete retention + disposal
   rule (logs 30d, audit events tenant-life + 1y, evidence 3y, sessions on expiry, tombstones after
   N days). This alone advances DAT-03's documentation side.
2. **Purge job** — *only if* the server has a worker/job surface already (check
   `server/src/` for the worker and any existing scheduled jobs). If it does: add an idempotent job
   that deletes expired sessions and aged tombstones, gated by a dry-run flag, with a test. If the
   surface isn't there yet, **stop and document** the exact interface needed and leave DAT-03
   `partial`.
3. **Offboarding runbook** (always doable): flesh out `docs/runbooks/offboard-tenant.md` — export via
   an encrypted/expiring link, delete records + secrets, keep audit events 1 year, tell the tenant
   backups age out (~8 weeks server / ~13 months offsite). The *code* for export/delete is Lane D
   (API) — note that.

## Acceptance

- Retention schedule complete; offboarding runbook complete.
- If a purge job was added: `cd server && node scripts/with-embedded-pg.js node --test
  test/<file>.test.js` passes and the job is idempotent + dry-runnable.
- Update DAT-03 `notes:` with what now exists; status → `implemented` only if the purge job landed and
  runs. DAT-04 stays `planned`/`partial` until the API export/delete path exists — note the runbook is
  ready.

## Do not

- Do not write a destructive purge without a dry-run flag and a test proving it only deletes
  expired/tombstoned rows. Never touch production data.
