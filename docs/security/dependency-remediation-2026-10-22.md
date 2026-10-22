# Fastify header validation security update

The dependency scan for `3f5333f` reported Fastify `5.12.5` under
[GHSA-389g-gv7q-r4x8 / CVE-2026-107832](https://github.com/fastify/fastify/security/advisories/GHSA-389g-gv7q-r4x8).
The upstream advisory rates it Low (CVSS 3.7): header names inside a
`propertyNames` schema's `enum` or `const` were not normalized to lowercase,
so constraints written with mixed-case names could be bypassed. A source search
found no `propertyNames` usage in this server's routes or tests; the dependency
is still upgraded rather than exempted from scanning.

Pin Fastify to exactly `5.12.6`, the first patched version identified in the
[official security release](https://github.com/fastify/fastify/releases/tag/v5.12.6).
The lockfile changes only Fastify's version, tarball URL and integrity hash,
plus the root dependency pin. No transitive dependencies, scanner policies,
application routes, or deployment settings change.

Validation on 2026-10-22:

- Server lint: 255 files checked, zero problems.
- Production dependency audit at the Low threshold: zero vulnerabilities.
- OSV Scanner 2.7.0, repository-wide recursive scan: four extraction sources,
  no issues, exit 0.
- An isolated Fastify request probe using a mixed-case `propertyNames` deny-list
  rejected the forbidden header with HTTP 400 before entering the handler;
  the ordinary request returned HTTP 200.
- Full embedded PostgreSQL server suite: running when this note was committed;
  completion remains pending and is not included in the results above.

This commit prepares the patched dependency for deployment; it does not update
any running server. Remote CI must pass on the integrated commit before release.
