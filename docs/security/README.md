# Fishtape security documents

| | |
| --- | --- |
| Owner | Kelvin Waldner |
| Applies to | Fishtape PWA, API, worker, HQ, iOS app, staging and production hosts, CI/CD |
| Review cadence | Annually, and after a SEV1/SEV2 incident or a major change |
| Last reviewed | 2026-10-19 |
| Related controls | SDL, RSK, CRY, CHG, OPS domains in `compliance/controls.yaml` |

This folder holds the technical security documents for Fishtape: what can go wrong, how code
reaches production safely, how secrets and vulnerabilities are handled, and how to test it all.
Policies, evidence and the risk register live in `docs/compliance/`; step-by-step procedures for
bad days live in `docs/runbooks/`.

Fishtape is pre-revenue and run by one person. These documents say what exists today and mark
everything else as planned. Where a control belongs to the API, which workstream A is building
now, the documents say "required by the contract" (`docs/BUILD-PLAN.md`) rather than "done".

## Documents

| file | what it covers | read it when |
| --- | --- | --- |
| [threat-model.md](threat-model.md) | STRIDE threat model: trust boundaries, data flows, assets, actors, threats per area with ratings, and the top risks | designing a feature, changing a trust boundary, or planning the next security work |
| [secure-sdlc.md](secure-sdlc.md) | how code goes from idea to production: branches, PRs, CI gates, security review triggers, dependencies, migrations, releases, rules for AI agents | opening or reviewing a pull request, cutting a release |
| [headers-csp.md](headers-csp.md) | every response header and CSP directive with its reason, caching rules, pdf.js, how to extend the CSP, how to test | changing nginx config, `index.html`, `sw.js`, or adding a third-party script |
| [secrets-management.md](secrets-management.md) | inventory of every secret, where it lives, who can read it, rotation and blast radius; envelope encryption design; what to do when one leaks | adding a secret, rotating one, or after a leak |
| [vulnerability-management.md](vulnerability-management.md) | where findings come from, triage, fix SLAs, exceptions, tracking and metrics | a Dependabot or CodeQL alert, a report from outside, the monthly review |
| [pentest-checklist-asvs.md](pentest-checklist-asvs.md) | self-assessment and pen-test checklist mapped to OWASP ASVS 4.0.3 Level 2, with Fishtape-specific must-test items | before production launch, annually, after a major change |

## How they connect

- The threat model names risks (ids like `TM-TEN-07`). Fixes become GitHub issues labelled
  `security`, tracked under [vulnerability-management.md](vulnerability-management.md). Risks that are
  accepted rather than fixed go in the risk register (see [docs/compliance/README.md](../compliance/README.md)).
- The pull request template (`.github/pull_request_template.md`) asks for a security note when a
  change touches the areas listed in [secure-sdlc.md](secure-sdlc.md#security-review-triggers). The note
  should cite the threat ids it affects.
- [secrets-management.md](secrets-management.md) says what each secret is and how bad a leak would be. The
  step-by-step rotation lives in [docs/runbooks/rotate-secrets.md](../runbooks/rotate-secrets.md).
- An exploited vulnerability, a leaked secret that may have been used, or any sign of
  cross-tenant exposure is an incident: follow [docs/runbooks/incident-response.md](../runbooks/incident-response.md)
  (SEV1 for a confirmed or likely breach or cross-tenant exposure, SEV2 for a suspected breach or
  active exploitation attempt).
- Controls and evidence for the SOC 2-aligned program (no formal audit) are mapped in
  [docs/compliance/README.md](../compliance/README.md). The monthly evidence bundle
  (`node compliance/evidence/collect.mjs`) includes the security alert counts used in
  [vulnerability-management.md](vulnerability-management.md#monthly-review).

## Where the security controls themselves live

| control | file |
| --- | --- |
| Security headers and CSP (staging, production) | `deploy/staging/security-headers.conf`, `deploy/production/nginx/security-headers.conf` |
| nginx routing, caching, rate limits, path blocking, log formats | `deploy/staging/nginx-api.conf.snippet`, `deploy/staging/nginx-proxy.conf`, `deploy/staging/nginx-http.conf`, `deploy/production/nginx/fishtape.conf`, `deploy/production/nginx/proxy.conf`, `deploy/production/nginx/deny.conf`, `deploy/production/nginx/tls.conf` |
| HQ isolation (separate `hq-api` container, the only holder of the BYPASSRLS role) | `deploy/*/docker-compose.yml` |
| CSP guard in CI | `.github/scripts/check-csp.mjs` (job "Web app tests" in `ci.yml`) |
| Secret, code and dependency scanning | `.github/workflows/security.yml`, `.gitleaks.toml`, `.github/dependabot.yml` |
| Deploy gate (SSH forced command) | `deploy/staging/deploy-gate.sh`, `deploy/production/deploy-gate.sh` |
| Exposure check after deploys | `deploy/check-exposure.sh` |
| Encrypted backups and restore tests | `deploy/*/backup.sh`, `deploy/*/restore-test.sh` |
| Host audit (production) | `deploy/production/check-host.sh` |
| Tenant isolation (RLS) and its tests | `server/migrations/`, `server/test/isolation.test.js` (required by the contract) |
| How to report a vulnerability | `SECURITY.md`, and `/.well-known/security.txt` on each site |

## Keeping these documents current

Each file has its own review line at the top. Review all of them at least once a year, after a
SEV1 or SEV2 incident, and when something in the "major change" list in
[threat-model.md](threat-model.md#review) happens. Update "Last reviewed" when you do, even if
nothing changed.
