# Path to green — closing the controls register

This is the working plan for turning the **HQ → Compliance & security → Controls** page green. That
page renders [`compliance/controls.yaml`](../../compliance/controls.yaml) grouped by status:
`implemented` is green, `partial` and `planned` are not.

**Rule:** status is honest. A control only becomes `implemented` when the work is actually done and
has evidence — never by editing the status alone. Update the status in the *same commit* as the
change that closes it.

As of 2026-11-11 there are ~90 controls, of which ~66 are `partial` or `planned`. They fall into
four lanes:

| Lane | Who | What it needs | Can an agent close it? |
| --- | --- | --- | --- |
| **A — Docs & drafts** | agent → Kelvin/counsel review | A policy, notice, template or checklist that doesn't exist yet | Yes: draft it; Kelvin/counsel approves |
| **B — Code & tests** | agent | A script, API feature or test that can run and be verified in CI | Yes, where the surface already exists |
| **C — Kelvin / infra** | Kelvin | MFA, GitHub settings, server builds, vendor contracts, scheduled reviews | No — agent can only prep the script/checklist |
| **D — Blocked on API / Release 1** | product build | Auth layer, audit hash-chain, money-integrity — active roadmap work | Not a quick fix; tracked in BUILD-PLAN |

Each lane-A/B cluster has a self-contained task file under [`tasks/`](tasks/) that a Codex or Claude
agent can pick up without more context. Lane C/D items are listed so nothing is lost, with the exact
action owner.

---

## Lane A — docs & drafts (agent-draftable now)

| Controls | Deliverable | Task file |
| --- | --- | --- |
| GOV-05, PRV-01, PRV-02, PRV-06 | Public privacy notice, terms of service + DPA, sub-processor list (drafts; counsel review before publish) | [T1-public-legal-commitments.md](tasks/T1-public-legal-commitments.md) |
| HRS-01, HRS-02 | Contractor agreement template, security-briefing outline, offboarding checklist | [T2-people-security-templates.md](tasks/T2-people-security-templates.md) |
| SDL-06 | OWASP ASVS self-assessment filled against the current code (the pentest checklist) | [T3-asvs-self-assessment.md](tasks/T3-asvs-self-assessment.md) |
| GOV-02 | Name the backup/key-person contact and record sealed-instructions process | Lane C (Kelvin picks the person); T2 drafts the sealed-instructions template |
| RSK-02, RSK-03 | Risk-review-on-change note + fraud/misuse control confirmations | folds into T3 (ASVS covers the control checks) |

## Lane B — code & tests (agent-closeable where the surface exists)

| Controls | Deliverable | Task file |
| --- | --- | --- |
| SDL-10 | CEC / tax / money reproducibility unit tests (cite source, assert integer cents & SI units) | [T4-integrity-tests.md](tasks/T4-integrity-tests.md) |
| DAT-03, DAT-04 | Purge jobs (tombstones, expired sessions, closed tenants) + tenant export/delete runbook | [T5-data-lifecycle.md](tasks/T5-data-lifecycle.md) — **partly blocked on API** |
| ACC-06 | HQ-only API mode: hq-api must not mount tenant routes; add a route-exposure test | [T6-hq-only-api-mode.md](tasks/T6-hq-only-api-mode.md) — **security-sensitive, review before merge** |
| SDL-02 | Confirm `.github/dependabot.yml` groups + cooldown; enabling security updates is Lane C | folds into T3 |

## Lane C — Kelvin / infra only (agent can prep, cannot close)

These stay `partial`/`planned` until Kelvin does the real-world action. Where a script or checklist
helps, the task files above produce it.

- **ACC-01** MFA on every company & vendor account — enroll + record at the access review.
- **ACC-02** First quarterly access review — run `collect.mjs`, complete `access-review-<date>.md`.
- **ACC-03 / CHG-02** Branch protection: make `ci-ok` a required check; restrict the release branch; set the production environment reviewer.
- **ACC-04 / ACC-05 / OPS-05 / OPS-06** Production host build + SSH/firewall/forced-command setup.
- **SDL-02** Turn on Dependabot security updates; point alerts at the release branch.
- **CHG-03** Enable the staging & production deploy workflows (`*_DEPLOY_ENABLED`).
- **GOV-03 / GOV-04** Stand up the monthly evidence routine + encrypted storage location.
- **CRY-01 / CRY-02 / CRY-04** Confirm staging TLS, disk encryption, key rotation record.
- **BCK-02 / BCK-03 / BCK-08** Pick the Canadian offsite backup provider + heartbeat monitor.
- **OPS-01 / OPS-02** External uptime monitor + HQ health page wiring.
- **VND-02 / VND-03** Vendor due diligence + production host agreement.
- **HRS-03 / INC-04 / BCK-05 / BCK-06** Scheduled human activities (training, tabletop, DR drill, key-person).
- **GOV-02** Name the backup contact.

## Lane D — blocked on the API / Release 1 build

Tracked in [`docs/BUILD-PLAN.md`](../BUILD-PLAN.md) and [`docs/releases/r1-get-paid.md`](../releases/r1-get-paid.md).
Not quick wins; do not half-build these in a side agent.

- **ACC-07, ACC-08, ACC-09, CRY-03** — HQ audit events, in-app auth layer, isolation tests, app-level encryption.
- **OPS-04** — audit trail hash-chain + verification.
- **SDL-08, SDL-09** — in-app AI/agent safeguards, schema-validated sync integrity.
- **PRI-01, PRI-02, PRI-03, PRV-03, PRV-07** — Release 1: closed periods, signed-document integrity, field-role money stripping, CASL consent, field-ticket location/signature privacy.

---

## How to work a task

1. Open the task file. It lists the control IDs, why they're not green, the exact deliverable, the
   files to touch, and the acceptance check.
2. Make the change on the branch. Run the verification command in the task.
3. In the **same commit**, set `status:` on each listed control in `compliance/controls.yaml` and
   update its `notes:` to say what now exists.
4. If the control needs a Kelvin/counsel step before it's truly done, leave it `partial`, note what's
   left, and move the human step to Lane C above.

Verification commands used across tasks:

    node --test electrical-app/tests/*.test.mjs
    cd server && node scripts/with-embedded-pg.js node --test test/<file>.test.js
    node .github/scripts/check-csp.mjs
    node .github/scripts/check-committed-files.mjs

---

## Progress log

**2026-11-11 — first green pass.**

- **HRS-01 → implemented** (T2): contractor agreement, briefing, offboarding and sealed-instructions
  templates in `docs/compliance/templates/`.
- **SDL-10 → implemented** (T4): CEC/tax/money reproducibility tests
  (`electrical-app/tests/integrity.test.mjs`); integer-cents + SI invariants asserted.
- **SDL-06 → implemented** (T3): ASVS self-assessment filled in — 126 items, 97 pass, 18 gap, 11 N/A.
  All 18 gaps map to existing controls below; no orphans.
- **GOV-05 / PRV-01 / PRV-02 / PRV-06** advanced (T1): public legal drafts in `docs/legal/`; stay
  `partial` pending counsel review + publish.
- **Android workflow** hardened (security-review defense-in-depth): dispatch input no longer
  interpolated into shell `run:` steps.

**Open follow-ups the ASVS surfaced:**

- **Dependency advisory (SDL-02/SDL-03):** 1 moderate `fast-uri` (transitive). Fix via `npm audit fix`
  in `server/`. Within the 90-day Medium deadline.
- **Under-marked controls to re-verify:** ACC-08 (in-app auth), CRY-03 (app-level encryption) and
  OPS-04 (audit trail) have more working, tested code than their `planned`/`partial` status implies —
  but each still has a named gap in the assessment (e.g. no session rotation after MFA, no `__Host-`
  cookie, 403s not audited), so none can honestly flip to `implemented` yet. **Do not upgrade status
  without re-reading the code + tests.**

**2026-11-11 — ACC-09 re-verified → implemented.** Confirmed `migrations.test.js` catalog-asserts
ENABLE+FORCE RLS + a USING/WITH CHECK policy on every collection and platform table; `restore-test.sh`
fails if any table with the tenant-data shape lacks ENABLE+FORCE RLS (catches new tables);
`isolation.test.js` proves cross-tenant access is blocked at API and DB layers and `withTenant` rejects
malformed ids. All run in the embedded CI suite (1054 pass).
