# Contractor agreement (template)

Fill in the `{{PLACEHOLDERS}}`, delete this note, and have both parties sign before any access is
granted. This template supports the onboarding steps in
[hr-security.md](../hr-security.md#onboarding) (control HRS-01). A separate NDA may replace the
confidentiality section if one is already in place; the rest still applies.

Nothing in this file is a secret. Keep the signed copy outside git (see
[hr-security.md](../hr-security.md#evidence)).

---

**This agreement** is between **Kelvin Waldner**, operating Fishtape ("the Company"), and
**{{CONTRACTOR_NAME}}** ("the Contractor").

- Effective date: **{{START_DATE}}**
- Expected end / review date: **{{END_DATE}}**
- Scope of work: **{{SCOPE_OF_WORK}}**

## 1. Confidentiality

The Contractor will not disclose or use, except to do the work above, any non-public information
about the Company, its code, its customers (tenants) or their data. This duty continues after the
engagement ends. The Contractor will not copy Fishtape data or non-public code for personal use or
for another client.

The Contractor must never access customer or tenant production data. Development and testing use
seeded or synthetic data only (see [acceptable-use.md](../acceptable-use.md#data)).

## 2. Acceptable use

The Contractor has read and agrees to follow the [acceptable-use policy](../acceptable-use.md) on
every device and account used for Fishtape work. Key points, repeated here so they are in the
contract:

- Use your own accounts; never share a login or MFA device.
- Never put a password, token or key in git, chat, email, a ticket, a screenshot or an AI prompt.
- Never paste tenant data, customer personal information or secrets into a third-party AI tool.
- No production data in staging or local development.

## 3. Ownership of work (IP assignment)

All work the Contractor creates for the Company under this agreement — code, documentation,
designs and other deliverables — is a work made for hire and belongs to the Company on creation.
To the extent any right does not pass automatically, the Contractor assigns it to the Company, and
will sign anything reasonably needed to record that assignment. The Contractor keeps no licence to
reuse the work. Pre-existing tools the Contractor owns and brings to the work stay the
Contractor's, but the Company gets a perpetual licence to use them as part of the deliverables;
list any such tools here: **{{PRE_EXISTING_MATERIAL_OR_NONE}}**.

## 4. Security requirements

- **MFA.** The Contractor has multi-factor authentication turned on for their GitHub account before
  the invite is sent, and on any other account issued for this work. A hardware key or passkey is
  used where offered.
- **Least privilege.** Access is normally a GitHub collaborator invite only. The Contractor works
  in their own branch and submits changes as pull requests for review. **No production access, no
  production secrets, no `.env` files, no SSH keys, no HQ accounts, no vendor consoles.** Staging
  access is granted only if the task needs it, and recorded with the reason.
- **Devices.** The Contractor's device meets the rules in
  [acceptable-use.md](../acceptable-use.md#devices): full-disk encryption, screen lock, current
  updates, malware protection.
- **Review.** Every change is reviewed by Kelvin and must pass CI before merge. The Contractor will
  not disable or bypass security checks (CI gates, push protection, gitleaks, CSP) to land a change.
- **Reporting.** The Contractor reports anything that might be a security or privacy problem to
  Kelvin right away, through [SECURITY.md](../../../SECURITY.md) or directly. There is no blame for
  reporting.

## 5. Return or deletion of data on exit

When the engagement ends, or on the Company's request, the Contractor will within a reasonable time
(and in any case before the offboarding step in [hr-security.md](../hr-security.md#offboarding)
completes):

- stop using all Company accounts and access,
- return or securely delete all Fishtape data and non-public code held on any device or account,
  including local clones, downloads and backups, and
- confirm in writing (an email is enough) that this is done.

The Company will remove the Contractor's access within 24 hours of the end of the engagement and
may rotate any secret the Contractor could have seen.

## 6. Term and ending

Either party may end this agreement with reasonable notice. The Company may end it immediately for a
breach of these terms; access is removed first, then the parties talk. Sections 1, 3 and 5 survive
the end of the agreement.

## 7. Governing law

This agreement is governed by the laws of **{{PROVINCE}}**, Canada.

## Signatures

| | Company | Contractor |
| --- | --- | --- |
| Name | Kelvin Waldner | {{CONTRACTOR_NAME}} |
| Signature | ____________________ | ____________________ |
| Date | ____________________ | ____________________ |
