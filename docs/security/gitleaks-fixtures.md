# Historical secret-scan fixture findings

Reviewed 2026-10-21 with gitleaks 8.30.1. The failed whole-history CI job reported 16
findings. Scanning the newer local history identified 17. All were traced to the test
fixtures below; no credential values or unredacted scanner reports are recorded here.

`.gitleaksignore` contains only exact `commit:file:rule:line` fingerprints. It does not
ignore a test directory, rule, future commit, or every occurrence of a particular value.
The existing `.gitleaks.toml` rules remain enabled, including the Fishtape custom rules.
A new finding must be reviewed independently, even when it appears in the same test file.

## Provenance

| Findings | Source | Why this is a fixture |
| --- | --- | --- |
| 9 generic API-key findings | `server/test/qbo-{client,connect,integrity,migrations,r1,review,sync,webhook,wizard}.test.js` | Explicit owner passwords used only by `createTenantWithOwner` on the disposable `createTestDatabase` fixture. QuickBooks requests use a fake provider. Current literal occurrences were checked and are confined to these nine tests. |
| 2 generic API-key findings | Two historical versions of `server/test/mail.test.js` | Synthetic provider token used by `fakeSendgrid`, whose fetch override intercepts requests in the disposable database suite. |
| 1 generic API-key finding | `electrical-app/tests/site-pages.test.mjs` | Deterministic fragment-parser input and expected token output; no authentication request is made. |
| 1 Stripe finding | `server/test/hq-console.test.js` | Synthetic response-redaction sentinel. The suite injects `financeStripe` and a stub email provider into the test app. |
| 1 Stripe finding | `server/test/hq.test.js` | Synthetic Stripe value stored in a test tenant to assert that an HQ export omits secrets. |
| 3 Stripe findings | `server/test/integrations-unit.test.js` | Pure provider-format and scrubbing assertions, including a sequential sample restricted-key string. These assertions do not call a provider. |

Every exact location and commit is adjacent to a rationale in `.gitleaksignore`.
The test database helper creates a separate database and drops it during teardown.
No production secret was rotated, no history was rewritten, and no provider was contacted
with these values during review.

## Verify without exposing values

Install the pinned scanner with release-checksum verification, as the Security workflow does.
From the repository root, run the same whole-history command used by CI:

```sh
gitleaks git --config .gitleaks.toml --redact --no-banner --exit-code 1 --report-format sarif --report-path /tmp/gitleaks-reviewed.sarif .
node .github/scripts/check-gitleaks-fixtures.mjs
```

Use a temporary report path appropriate to the operating system. The regression command
accepts `GITLEAKS_PATH` when the verified executable is not on `PATH`. It creates a temporary
git repository and generates three synthetic positive samples at runtime. It verifies that
new credentials in the same previously flagged test paths and in a production source path
still fail scanning, then removes that temporary repository. It prints counts only.

For this review, the whole-history scan passed with the default `.gitleaksignore` discovery
and the existing CI config. CI must retain a full checkout (`fetch-depth: 0`) and `--redact`.
Do not add an ignore for an ambiguous or real credential; follow the existing
[secret rotation runbook](../runbooks/rotate-secrets.md) instead.
