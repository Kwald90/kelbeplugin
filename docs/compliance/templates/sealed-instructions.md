# Sealed instructions (template — structure only)

Key-person continuity instructions for the trusted backup contact to open if Kelvin is unavailable
for an extended period. This supports the key-person plan in
[business-continuity.md](../business-continuity.md#loss-of-kelvin-key-person-risk) (control GOV-02,
supports BCK-06).

> **This file is a structure only. Do not put any secret, password, recovery code, key, or
> password-manager master password in it, and do not commit a filled-in copy to git.** The real
> instructions are written up, printed, and kept with the backup contact (sealed envelope and/or the
> password manager's emergency-access feature). This repo holds only the outline below.

**Backup contact:** {{BACKUP_CONTACT_NAME}} — _Kelvin still needs to name this person._
**Prepared:** {{DATE_PREPARED}} · **Last reviewed:** {{LAST_REVIEWED}} (review annually)

---

## 1. What Fishtape is

- One-paragraph description: multi-tenant SaaS for Canadian electrical contractors, run by Kelvin
  Waldner as a one-person company.
- Who the customers (tenants) are and why keeping their data safe and returnable matters.

## 2. Who to contact first

- {{TRUSTED_TECHNICAL_HELPER_OR_PLACEHOLDER}} — a competent developer who can follow the runbooks.
- Any co-operator or advisor, if one exists by the time this is used.
- The point: you do not have to run Fishtape yourself; you coordinate.

## 3. How to reach the accounts (pointer, not the secrets)

- Where the password manager emergency access is set up and how to trigger it (the manager's
  emergency-access feature, or the emergency kit in the sealed envelope), including the **waiting
  period** before it unlocks — so Kelvin can decline a request made while he is reachable.
- **No passwords, master password, recovery codes or keys are written here.** They come only from
  the emergency access above.

## 4. What the service depends on

- Pointers (names only, no credentials) to: the production host, DNS registrar, the password
  manager, GitHub, the offsite backup storage, and the main vendors (payments, email, SMS, leads).
  The current list lives in
  [business-continuity.md](../business-continuity.md#critical-services-and-dependencies).

## 5. Keeping it running

- How to post a status notice so tenants know what is happening.
- Where the operating runbooks are ([docs/runbooks/](../../runbooks/)) and that they are written so
  a competent developer can follow them (deploy, restore from backup, rotate secrets).
- The technical helper handles day-to-day operation; the backup contact authorises and oversees.

## 6. Handing over

- If a new operator takes over: how access and ownership transfer, what to rotate first (every
  secret, following [rotate-secrets.md](../../runbooks/rotate-secrets.md)), and how to update the
  roles record.

## 7. Winding down in an orderly way

- If Fishtape cannot continue: give each tenant their own data back (export, by tenant), give
  reasonable notice, then shut services down.
- Only after tenants have their data: cancel vendor accounts and the hosting, and securely destroy
  remaining copies of tenant data per the retention rules.

## 8. Waiting period and Kelvin's override

- Restate the waiting period on emergency access, and that if Kelvin responds within it, the request
  is cancelled. This exists to prevent misuse while Kelvin is simply hard to reach.

---

### Checklist before this is considered done (for Kelvin)

- [ ] Backup contact named and has agreed.
- [ ] Password-manager emergency access configured for them, with a waiting period.
- [ ] Printed, sealed instructions (the filled-in version of this outline) handed over — **not**
      committed to git.
- [ ] A note added to the evidence bundle that the sealed instructions were reviewed (annually),
      per [business-continuity.md](../business-continuity.md#evidence).
