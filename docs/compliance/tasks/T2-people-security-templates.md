# T2 — People-security templates (contractor agreement, briefing, offboarding, sealed instructions)

**Closes toward green:** HRS-01, HRS-02 (`partial`); supports GOV-02 (`partial`).
**Lane:** A — agent drafts templates; Kelvin uses them with the next contractor / names the contact.

## Why these aren't green

HRS-01 (contractor onboarding) and HRS-02 (offboarding within 24h) are defined in
`docs/compliance/hr-security.md` but there is **no ready-to-use agreement template or briefing
outline**, so the moment a contractor is needed the control can't be executed cleanly. GOV-02 needs a
named backup contact with sealed instructions — Kelvin names the person, but the **sealed-instructions
template** can be drafted now.

## Deliverable

Create `docs/compliance/templates/`:

1. `contractor-agreement.md` — template covering confidentiality, acceptable use (cross-ref
   `docs/compliance/acceptable-use.md`), IP assignment, MFA requirement, least-privilege (own branch,
   PRs, **no production**), data return/deletion on exit, and a signature block. Placeholders for name,
   date, scope. (HRS-01)
2. `security-briefing.md` — a one-page onboarding briefing outline: phishing/account-takeover, secret
   handling (never commit `.env`, `SECRETS_MASTER_KEY`, keys), the branch/PR workflow, incident
   reporting via `SECURITY.md`, and device requirements (FDE, screen lock, updates). (HRS-01)
3. `offboarding-checklist.md` — the 24-hour offboarding checklist: remove GitHub collaborator access,
   revoke deploy keys/tokens, rotate any secrets the contractor could have seen (cross-ref
   `docs/runbooks/rotate-secrets.md`), get written confirmation of data return/deletion, record in the
   access review. (HRS-02)
4. `sealed-instructions.md` — template for the key-person continuity instructions a trusted backup
   contact holds (what the service is, how to keep it running / hand over / wind down, where the
   password-manager emergency access is, waiting period). No actual secrets or recovery material —
   it's the *structure* only. (GOV-02, supports BCK-06)

Link the templates from `docs/compliance/hr-security.md` and `docs/compliance/business-continuity.md`.

## Acceptance

- Four templates exist, consistent with the referenced policies, no real secrets or personal data.
- `node .github/scripts/check-committed-files.mjs` passes.
- In the same commit, update HRS-01 / HRS-02 `notes:` to "templates ready in
  docs/compliance/templates/"; status can move to `implemented` for HRS-01/HRS-02 **only if**
  `docs/compliance/hr-security.md` considers "template prepared" the bar (it says "Prepare an agreement
  template and briefing outline before the next contractor") — so **HRS-01 → implemented** is
  justified once the template + briefing exist. HRS-02 stays `partial` (depends on an actual exit).
- GOV-02 stays `partial` (Kelvin must still name the person); note the template exists.

## Do not

- Do not invent a backup contact's name. Do not include any real credentials.
