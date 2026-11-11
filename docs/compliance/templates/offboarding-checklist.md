# Offboarding checklist (template)

Complete **within 24 hours** of the end of a contractor engagement, per
[hr-security.md](../hr-security.md#offboarding) (control HRS-02). Ending early for cause: remove
access first, then talk. Copy this list per contractor, tick each item, and file it with the next
access review. Nothing here is a secret.

**Contractor:** {{CONTRACTOR_NAME}} · **Engagement ended:** {{END_DATE}} · **Offboarded by:**
Kelvin Waldner · **Completed:** {{COMPLETED_DATE}}

## 1. Remove access

- [ ] Remove the GitHub collaborator from the repository.
- [ ] Remove any other account issued for this work (staging, any tooling).
- [ ] End any active sessions / revoke API keys or tokens the contractor held (see
      [rotate-secrets.md](../../runbooks/rotate-secrets.md#tenant-api-keys-and-hqstaff-sessions)).
- [ ] Revoke any deploy key or CI credential the contractor could have used.

## 2. Rotate secrets the contractor could have seen

Rotate anything within reach of their access, using
[rotate-secrets.md](../../runbooks/rotate-secrets.md). A contractor should not have had production
secrets at all (least privilege), so in the normal case this is limited to anything shared for a
specific task. Check and rotate as applicable:

- [ ] Any staging secret the task exposed.
- [ ] Any shared token, webhook verifier or service credential the contractor used.
- [ ] CI deploy key, only if the contractor could have reached it.
- [ ] Confirm no production secret, `SECRETS_MASTER_KEY`, SSH key or vendor console credential was
      ever shared — if one was, treat it as a leak and rotate it immediately
      ([rotate-secrets.md](../../runbooks/rotate-secrets.md): "On a leak: rotate first, investigate
      second").

## 3. Written confirmation of data return / deletion

- [ ] Get written confirmation (email is enough) that the contractor has returned or deleted all
      Fishtape data and non-public code — local clones, downloads and backups included.
- [ ] File the confirmation outside git with the signed agreement.

## 4. Record it

- [ ] Note the removal, the secrets rotated, and the date of the data-deletion confirmation in the
      next quarterly access review.
- [ ] Record each rotation in the evidence store (what, when, why = leaver, who), per
      [rotate-secrets.md](../../runbooks/rotate-secrets.md#record).

## Notes

{{FREE_TEXT_NOTES_OR_NONE}}
