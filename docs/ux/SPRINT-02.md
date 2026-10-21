# Sprint 02: understand the job and start useful work

Started: 2026-10-21. Status: implemented and locally verified; pending review and
merge. Integration branch: `codex/ux-sprint-02`.

## Baseline and scope

Base commit `d68b264` includes R1 signing, deposits, costing, and access fixes
added after Sprint 01. Preserve those contracts in [R1](../releases/r1-get-paid.md).
The baseline PWA suite passes 784 tests. The older estimate UX browser test failed
because it expected synchronous Mark sent; R1 added asynchronous send validation.

This sprint implements the next bounded slices of UX-05, UX-06 and UX-07 and
restores estimate guidance explicitly listed in the backlog. It does not implement
the remote customer portal, change approval/payment contracts, introduce a new
service/project record type, or change payroll and tax calculations.

## Workstreams

| Workstream | Checkout | Owned files under electrical-app/ |
| --- | --- | --- |
| Job overview | `F:/Local/fishtape-ux2-jobs` | `js/modules/jobs.js`, `css/job-experience.css`, overview helper/tests |
| Field experience | `F:/Local/fishtape-ux2-field` | `js/modules/today.js`, `css/field-experience.css`, field-status helper/tests |
| Progressive onboarding | `F:/Local/fishtape-ux2-onboarding` | `js/modules/onboarding.js`, `css/onboarding.css`, onboarding helper/tests |
| Lead | Main workspace, feature branch | Estimate guidance, shared registration/cache, integration tests, documentation and review |

Each workstream commits locally. Integration stays on a feature branch, following
the backlog process; the deploy branch is not changed by this sprint.

## Acceptance

- [x] Job overview shows real next visit/crew, task blockers and material needs.
- [x] Existing costing, change orders, signatures, tabs and financial access remain.
- [x] My day distinguishes task progress from paid time without changing time records.
- [x] Sync states communicate offline, pending, rejected/error and recovery truthfully.
- [x] Field additions respect worker scope, role permissions and module switches.
- [x] Onboarding separates essential setup from later configuration without falsely completing skipped steps.
- [x] Quote entry is available only when permitted and enabled; all previous setup remains reachable.
- [x] Estimate guidance restored across draft, sent, accepted, signed, superseded and plan-locked states.
- [x] Existing R1 signing/email evidence/deposit controls retained, with plan-lock mutation controls hidden.
- [x] Integrated unit/browser/CSP results recorded and screenshots reviewed.

## Result

The job opens with its next action, scope, next visit, named crew, blockers and
material requests. Billing, costs and contracts sit in a disclosure below, with
role restrictions retained. Narrow-screen tabs now keep their label width and
scroll instead of overlapping.

My day names task progress and payroll time separately, shows personal clock
status, and provides site/directions links when permitted. Sync feedback describes
waiting, offline and rejected changes without claiming server confirmation before
it exists. Existing sync details provide recovery actions.

Setup leads with company, province and rates. Later configuration remains available
in a disclosure; skipped essentials never count as verified. Quote entry uses the
existing entitlement/module checks. Estimate guidance now reflects current state
while preserving R1 signing and deposit controls.

Three parallel agents delivered job overview, field experience and onboarding in
isolated worktrees. The lead integrated them, restored estimate guidance, registered
assets, bumped the offline shell cache, reviewed layouts and ran the combined checks.

## Validation

| Check | Result |
| --- | --- |
| Baseline `node --test electrical-app/tests/*.test.mjs` | 784 passed |
| Integrated `node --test electrical-app/tests/*.test.mjs` | 803 passed, 0 failed |
| `node electrical-app/tests/e2e/estimate-experience.e2e.mjs` after guidance restoration | 30 assertions passed; now waits for asynchronous send validation |
| `node --test electrical-app/tests/estimates.test.mjs` | 2 plan-lock regression checks passed |
| `node electrical-app/tests/e2e/onboarding-flow.e2e.mjs` | 22 assertions passed; includes saves, skips, restore, entitlement and narrow layout |
| `node electrical-app/tests/e2e/ux-navigation.e2e.mjs` | Passed desktop/phone navigation, job and onboarding layout, separate mobile tabs, field progress/payroll invariance, role/module switches and no runtime errors |
| Agent field browser smoke | Passed injected offline/rejected feedback, sync recovery access, read-only tasks and permission-limited site/time controls; supplementary local harness |
| `node .github/scripts/check-csp.mjs` | 0 errors, 0 warnings |
| `git diff --check` | Passed |
| Screenshot review | Desktop job/setup and phone job/field/setup/estimate reviewed; tab overlap found and fixed |

New tests cover job overview prioritization/scope, field sync/clock/site projections
and onboarding progression. The full suite includes existing accounting and signing
regressions. Browser tests use synthetic demo/local stores, not a live API.

See the [preview index](README.md#sprint-02-previews) for committed screenshots.
These do not establish real-device usability or live service delivery. No production
deployment or live customer messaging/payment was performed.

## Review and CI handoff

[Draft PR #2](https://github.com/Kwald90/kelbeplugin/pull/2) contains this sprint.
Local checks above pass, but GitHub CI is not green. On commit `9fd8d76`, the web
job fails to import `@node-rs/argon2` through the existing `site-pages.test.mjs`;
the web job does not install the server dependencies that are already present in
the local workspace. Deploy configuration checks fail on their Docker COPY/import
allow-list checks. Whole-history gitleaks and OSV dependency scans also fail.

The same failing jobs/stages exist on base `d68b264`:
[baseline CI](https://github.com/Kwald90/kelbeplugin/actions/runs/39578359580) and
[baseline Security](https://github.com/Kwald90/kelbeplugin/actions/runs/39578359724).
The PR-only dependency review additionally reports that the repository does not
support it and asks for Dependency graph to be enabled. These remain merge/release
blockers; this UX sprint does not suppress or disable any checks. Resolve them in
the repository's CI/security workstream, then rerun the complete PR checks.

## Follow-up boundaries

User research, job-type templates, a complete first-quote onboarding flow, broader
field recovery tests, remote customer approvals, and real device testing remain on
the roadmap. This sprint uses existing state and routes rather than adding new
record contracts. Live API, email, payment and geolocation behaviour must be
validated separately before release.

Two existing workflow gaps were recorded in the [backlog](../BACKLOG.md): signed
quotes cannot currently create a job or revision because their frozen-record guard
also blocks those actions; new quote markup does not inherit the company setting.
This sprint explains the actual available actions and avoids altering those
financial/signature contracts without dedicated regression work.
