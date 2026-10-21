# Sprint 02 CI remediation

Started 2026-10-21. Branch: `codex/ux-sprint-02`.
Review: [draft PR #2](https://github.com/Kwald90/kelbeplugin/pull/2).
Status: code fixes integrated and locally verified; remote results are tracked in
the linked PR checks. No merge or deployment.

The UX changes passed local tests but exposed existing CI failures on base
`d68b264`. This follow-up addresses their causes while keeping the checks active.
The three agents work in separate deployment-check, dependency and secret-scan
worktrees; the lead integrates and records the combined result.

## Findings and intended changes

| Check | Cause | Resolution |
| --- | --- | --- |
| Web app tests | `site-pages.test.mjs` imports server code requiring dependencies absent in the clean web CI job | Install the locked test dependencies before the PWA suite |
| Deploy configuration | Shell grep requires individual COPY entries despite a valid directory COPY and mistakes a comment for an import | Reuse and strengthen import-closure/context tests, including missing transitive files and URL-loaded schemas; keep the allow-list unchanged |
| Vulnerable dependencies | OSV reports `GHSA-w5hq-g745-h8pq` in Xcode's `uuid@7.0.3` development dependency | Override only Xcode's UUID to patched `11.1.1`; six mobile tests and audit pass |
| Whole-history secret scan | Historical test credentials and mock-provider/parser fixtures trigger scanner rules | 17 verified historical fingerprints; full-history scan passes and three new synthetic credentials are still detected |
| Dependency review | GitHub reports Dependency graph unavailable; alerts API confirms disabled | Kelvin approved enabling Dependency graph and vulnerability alerts; enabled and verified via the alerts and comparison APIs |
| Server test reporting | `npm test` piped through `tee` could report success despite a failed test | Enable `pipefail`; a synthetic failing command retained exit code 37 through the logging pipeline |

## Repository configuration

The repository is public. GitHub documents that enabling vulnerability alerts also
enables Dependency graph through
[`PUT /repos/{owner}/{repo}/vulnerability-alerts`](https://docs.github.com/en/rest/repos/repos#enable-vulnerability-alerts).
The concrete change is to enable these two features on `Kwald90/kelbeplugin`, then
verify the dependency comparison API and rerun the PR dependency-review job.

Kelvin explicitly approved this administrative change on 2026-10-21 after the
repository's [agent policy](../security/secure-sdlc.md#rules-for-ai-coding-agents)
was identified. The enable request and subsequent alerts check succeeded; the
dependency comparison API changed from HTTP 403 to a successful empty comparison
for the original UX-only diff. Automatic dependency-update PRs and repository
visibility were not changed. The PR check remains active.

## Validation

| Check | Result |
| --- | --- |
| Agent clean server install and PWA suite | 803 passed |
| Integrated mobile `npm ci --ignore-scripts --no-audit --no-fund` | Passed |
| Integrated mobile `npm test` | 6 passed; includes real Xcode project parse/change/write/parse and UUID buffer validation |
| Integrated mobile `npm audit --audit-level=high` | 0 vulnerabilities |
| Agent recursive OSV Scanner 2.7.0 | No issues; same four extraction sources as CI |
| Integrated Docker-context suite | 6 passed |
| actionlint 1.7.12 | CI and Security workflow checks passed |
| Agent deploy static checks | Shared scripts match, executable git modes verified, bash syntax and shellcheck passed |
| Integrated gitleaks 8.30.1 full-history scan | 246 local commits scanned, no leaks found; includes local agent history |
| Integrated gitleaks fixture regression | 17 exact historical exceptions; three fresh test/production-path samples all detected |
| GitHub configuration verification | Alerts enabled; dependency comparison API succeeds |
| QuickBooks connection suite with embedded PostgreSQL | 32 passed; caller-owned transaction assertion also passed independently |
| QuickBooks mutation check | Temporarily holding a transaction across refresh failed the intended assertion; production source restored |
| Server logging pipeline | Synthetic failure exit 37 propagates through `tee`; actionlint remains clean |

CI now installs both server and mobile locked dependencies and runs the six mobile
compatibility tests. The deploy job invokes the strengthened Docker-context suite.
No extra PWA file was admitted to the Docker context: the `importers.js` string
that triggered the former grep is a prose reference, not a runtime import.

The mobile change and upstream advisory are documented in the
[dependency remediation note](../security/dependency-remediation-2026-10-21.md).
The [fixture review](../security/gitleaks-fixtures.md) records secret-scan provenance
and limits. Security CI runs the regression before its full-history scan. Remote
CI results remain visible on [PR #2](https://github.com/Kwald90/kelbeplugin/pull/2/checks);
local success alone is not a release approval.
Windows tests validate the Xcode project tools; a native macOS/iOS build remains
part of mobile release validation. Docker is unavailable locally; Compose, nginx,
image-build and container-smoke validation will come from the Linux CI jobs.

The first remote remediation run exposed a further issue through log review: the
server job showed success while its TAP summary reported 1000 passes and one
failure. The duplicate run passed all 1001 tests. The failing QuickBooks test
counted every connection's idle transaction while four callers read tokens;
another caller's brief read could be mistaken for the refreshing caller holding
a transaction during the provider request. The test now tags each caller's
transactions and inspects the refreshing caller only. A deliberately held
unrelated transaction serves as a negative control, while one-refresh and
shared-token assertions remain. Production QuickBooks code is unchanged. The
logging pipeline now propagates test failures, so a green job cannot conceal
that failure again. Final verification must inspect both job status and the
server TAP summary.

## Security review

All required scan jobs remain active and fail on unresolved findings. No broad ignore,
history rewrite, credential rotation, production access, or deployment is part of
this work. The PR requires Kelvin's review before merge. Reports contain safe
metadata only and do not reproduce credential values.

The mobile override crosses UUID major versions only for the Xcode build tool.
It retains the CommonJS interface actually used by Xcode; committed tests cover
project edits and identifiers. The scanner exceptions bind commit, path, rule
and line; a new commit or credential is not covered by them. The Docker check
still requires the exact broad COPY and follows shared dependencies, including
schema URLs, without expanding the build context.
