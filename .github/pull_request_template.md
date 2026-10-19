## What and why

<!-- One or two sentences. Link the issue or BUILD-PLAN section. -->

## How it was tested

<!-- Commands run, screens checked, devices used. -->

## Checklist

- [ ] CI is green (tests, CSP guard, deploy-config checks, security scans).
- [ ] No secrets, tokens, real customer data or production dumps in the diff, the PR text, or test fixtures.
- [ ] New tenant tables have `ENABLE` and `FORCE ROW LEVEL SECURITY`, a policy on `tenant_id`, and a test in `server/test/isolation.test.js`.
- [ ] Migrations are expand/contract: the previous release still works against the new schema (deploys don't roll migrations back).
- [ ] New inputs are validated (JSON Schema / ajv) and every write appends an audit event.
- [ ] No inline `<script>`, `on*=` handlers, `eval`/`new Function`, or `style="..."` strings in HTML; styles go through `h()`/CSSOM. New external origins are added to the CSP in both `deploy/*/security-headers.conf` files.
- [ ] Docs and runbooks updated if behaviour, config or operations changed.

## Security notes

<!-- Required when this touches auth, sessions, MFA/PIN devices, RLS or tenant context, HQ
     (BYPASSRLS), API keys, crypto or tenant secrets, integrations/webhooks, AI tools, CI/CD or
     deploy scripts. What could go wrong, and what stops it? "None" is fine otherwise.
     See docs/security/secure-sdlc.md. -->

## Author

- [ ] Human
- [ ] AI agent (session/worktree: ___ ), reviewed line by line by: ___
