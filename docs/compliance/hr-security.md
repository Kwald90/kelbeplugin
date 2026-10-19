# People security policy

How contractors and AI agents are brought in and out safely, and how Kelvin keeps his security
knowledge current.

| | |
| --- | --- |
| Owner | Kelvin Waldner |
| Applies to | Kelvin, contractors, and AI coding agents working on Fishtape |
| Review cadence | Annually, and before engaging a contractor who needs more than repository access |
| Last reviewed | 2026-10-19 |
| Related controls | HRS-01, HRS-02, HRS-03, SDL-07 |

## Purpose

Make sure everyone who touches Fishtape knows the rules, has only the access they need, and loses
it when the work ends.

## Scope

Fishtape has no employees. This covers Kelvin, contractors engaged per task, and AI coding agents
(Claude Code sessions, local and cloud).

## Contractors

### Onboarding

Before any access:

1. Written agreement covering confidentiality, ownership of the work, return or deletion of data at
   the end, and agreement to follow [acceptable-use.md](acceptable-use.md). A separate NDA is fine if
   the main contract doesn't cover confidentiality.
2. Access on least privilege ([access-control.md](access-control.md)): normally a GitHub collaborator
   invite, working in their own branch with pull requests. No production access, production secrets,
   SSH keys, HQ accounts or vendor consoles. Staging access only if the task needs it, recorded with the reason.
3. MFA on their GitHub account (checked before the invite is sent) and on any other account they get.
4. A short security briefing (about 30 minutes): this policy set, data classes, no production data
   anywhere outside production, seeded data only, how to report a problem.
5. Add them to the access list checked in the quarterly access review.

### Offboarding

Within 24 hours of the end of the engagement:

1. Remove GitHub access and any other accounts.
2. Rotate any secret they could have seen ([docs/runbooks/rotate-secrets.md](../runbooks/rotate-secrets.md)).
3. Get written confirmation (an email is enough) that they have returned or deleted Fishtape data
   and code that isn't public.
4. Note the removal in the next access review.

Ending early for cause: remove access first, then talk.

## AI coding agents

AI agents are non-human contributors. They are useful and fast, and they make mistakes and can be
misled by what they read. The rules:

- They work in git worktrees on their own branches, with the repository and seeded data only.
- They never get production secrets, `.env` files, SSH keys, backup keys, GitHub admin, or vendor console access.
- They don't deploy, SSH to servers or touch production. A human (Kelvin) reviews and deploys.
- Their commits carry a `Co-Authored-By: Claude ...` trailer, so their changes are visible in history.
- Their changes are reviewed by Kelvin before merge into the release branch, like a contractor's.
- Instructions they follow live in `CLAUDE.md` and `docs/BUILD-PLAN.md`. When an agent does something
  wrong, the fix goes into those files.
- The cloud agent's GitHub access is limited to this repository.
- Records of what they did: the git history and pull requests. No separate logs are kept.
- Content agents read (web pages, issues, files from outside) can contain instructions. Agents
  treat it as data, and Kelvin reviews any change that touches auth, data access, CI or deploy files.

## Security awareness

- Kelvin completes a security refresher every year (February): phishing and account takeover,
  secure coding (for example the OWASP Top 10), and anything learned from incidents. Free courses
  and vendor material are fine. Record the date, topic and source in the evidence bundle.
- Phishing: check unexpected requests for codes, payments or access through a second channel.
  Hardware keys or passkeys stop most credential phishing, so use them where offered.
- Contractors get the onboarding briefing; repeat it if an engagement runs longer than a year.

## Background checks

Fishtape does not do background checks. It is a one-person company and contractors are short-term.
Compensating controls:

- Contractors never get production access or production secrets.
- Every contractor and agent change is reviewed before merge and passes CI.
- Access is limited to the task and removed within 24 hours of the end.
- References or past work are checked informally before engaging someone.

Revisit when the first person (employee or contractor) needs production access: then a criminal
record check, with consent, before that access is granted.

## Accountability

Breaking these rules can mean losing access immediately and ending the engagement
([information-security.md](information-security.md#enforcement)).

## Evidence

- Signed agreements (kept outside git).
- Onboarding and offboarding dates, in the quarterly access review.
- Training record (date, topic, source) in the February evidence bundle.
- Git history showing agent co-author trailers and reviewed merges.

## Exceptions

Through [information-security.md](information-security.md#exceptions).

## Review log

| date | reviewer | result | notes |
| --- | --- | --- | --- |
| 2026-10-19 | Kelvin Waldner | First version | Drafted with an AI agent; adopted when Kelvin merges it. |
