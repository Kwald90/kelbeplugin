# Incident response (hands-on)

The policy (what counts, roles, notice duties) is
[docs/compliance/incident-response.md](../compliance/incident-response.md); breach rules are in
[privacy.md](../compliance/privacy.md#breaches). This page is what to do, in order.

## Severity

| | meaning | respond | update |
| --- | --- | --- | --- |
| SEV1 | Production down for all tenants, or a confirmed or likely data breach or cross-tenant exposure | now, 24/7 | every hour |
| SEV2 | Major feature down or degraded for many tenants, suspected breach, active exploitation attempt | within 1 h awake, 4 h overnight | when status changes |
| SEV3 | Partial degradation, one tenant, a workaround exists | next business day | when status changes |
| SEV4 | Minor | backlog | none |

Unsure? Pick the higher one. Staging-only problems are SEV3 at most, unless staging leaked
something real (a secret, Kelvin's data), which is SEV2.

## The first 15 minutes

1. Open an incident record (template below) in the encrypted evidence store. Start the UTC timeline.
2. Assign the severity.
3. Preserve evidence before changing anything you suspect is compromised:
   - provider snapshot of the host;
   - `sudo docker compose logs --since 24h > /root/incident-<date>-compose.log` (from `deploy/<env>/`);
   - copy `/var/log/fishtape-<env>/`, `/var/lib/fishtape-<env>/*.jsonl`, `/var/log/auth.log`,
     `journalctl --since -24h`;
   - `sha256sum` the copies and move them off the host.
4. Contain, smallest reversible step first:

| situation | contain |
| --- | --- |
| leaked secret or key | rotate it now ([rotate-secrets.md](rotate-secrets.md)); revoke sessions or keys that used it |
| compromised user or HQ account | `UPDATE users SET status = 'disabled' WHERE id = '<id>'; UPDATE sessions SET revoked_at = now() WHERE user_id = '<id>';` then reset their password and MFA before re-enabling |
| leaked tenant API key | revoke it in the app (or `UPDATE api_keys SET revoked_at = now() WHERE id = '<id>'`) |
| cross-tenant exposure | take the affected route offline (nginx `location ... { return 503; }` + `install-nginx.sh`) or stop `api`; keep `hq-api` and the database |
| compromised host | firewall it (`ufw default deny incoming`, keep your SSH), stop containers, rebuild from scratch ([restore-from-backup.md](restore-from-backup.md) C) |
| bad deploy | [rollback.md](rollback.md) |
| outage | check `deploy/check-exposure.sh`, `docker compose ps`, `/api/readyz`, disk (`df -h`), certificate (`host-status.json`) |
| GitHub account compromise | revoke sessions and PATs, rotate deploy keys and environment secrets, check recent pushes and tags |
| QuickBooks sync writing wrong data (a sync loop, a mapping or merge bug, the safety brake firing for several companies) | `QBO_WRITES=off` first (`set-env.sh <env> QBO_WRITES`, then `sudo docker compose up -d api worker`): nothing is written to any company's QuickBooks, edits wait in the outbox, pulls continue. Then HQ > each company concerned > **Pause QuickBooks sync** (reason required), so the office cannot resume it. Details: [quickbooks-support.md](quickbooks-support.md#stop-everything) |
| QuickBooks credentials leaked or Intuit alerts us | rotate `QBO_CLIENT_SECRET` ([rotate-secrets.md](rotate-secrets.md#quickbooks-intuit-app-client-secret)); stolen refresh tokens stop working only when revoked, so with a database or backup leak treat every connected company as exposed and ask each to disconnect and reconnect |

SQL above runs as the superuser inside the container: `sudo docker compose exec postgres psql -U postgres -d fishtape`.

QuickBooks alerts (`qbo_*`, emailed to `HQ_NOTIFY_EMAIL`) and their first steps are listed in
[logging-monitoring.md](../compliance/logging-monitoring.md#quickbooks-alerts). A wrong write in a
company's books is an incident for that company (SEV3, SEV2 if several companies): tell them what
was written and when, from their sync log; Fishtape never edits QuickBooks by hand for them.

## Then

5. Eradicate the cause; recover service (rollback, restore, rebuild).
6. Decide notifications ([privacy.md](../compliance/privacy.md#breaches)): affected tenants within
   72 hours of confirming a breach of their data; the Office of the Privacy Commissioner and
   individuals when a breach of safeguards creates a real risk of significant harm; Alberta's
   commissioner for Alberta personal information; others as privacy.md says. Record every breach,
   reported or not.
7. Close: write the post-incident review within 5 business days (SEV1/SEV2), track the actions,
   update runbooks, policies and `compliance/controls.yaml` if they were wrong.

## Incident record template

```
Incident:      INC-<YYYY>-<NN>   Severity: SEV_   Status: open | contained | resolved | closed
Detected:      <UTC time>, by <alert / person / report>
Commander:     Kelvin Waldner
Summary:       <one paragraph>
Impact:        tenants <list or count>; records <count, kinds>; duration <from-to>
Personal info: yes / no / unknown  ->  breach assessment in privacy.md
Timeline (UTC):
  <time>  <what was seen / done / decided, by whom>
Evidence:      <files, sha256, where stored>
Notified:      <who, when, how>
Root cause:    <after review>
Actions:       <action, owner, due date>
```

## Communication templates

Keep them short, factual and dated. Say what is known, what isn't, and when the next update comes.
Never guess at causes in public.

**Status / all tenants (outage)**

> Subject: Fishtape service disruption, <date>
>
> Since <time> <timezone>, <what doesn't work, e.g. "the app can't sync and sign-in fails">.
> Your data on your devices is safe and will sync when service returns. We are working on it and
> will update you by <time>.

**Resolved**

> Service was restored at <time>. The cause was <plain-language cause>. <"No data was lost." |
> "Changes made between <time> and <time> need to be re-entered: <how to check">.>
> We are <the follow-up step> so it doesn't happen again.

**Affected tenant (possible breach of their data)**

> Subject: Security incident affecting your Fishtape account
>
> On <date> we found <what happened> affecting <your company's data: kinds of records>.
> What we know: <facts>. What we don't know yet: <open questions>.
> What we've done: <containment>. What you should do: <e.g. reset passwords, review users, tell
> your customers if advised>. Under Canadian privacy law your company may need to assess whether
> the people in these records face a real risk of significant harm; we will give you the details
> you need for that. Next update by <time>. Contact: <name, phone, email>.

**Regulator (OPC breach report)**

Use the OPC's current online breach report form. Have ready: date or period of the breach, date
discovered, description, personal information involved, number of individuals (estimate), the
real-risk-of-significant-harm assessment, containment steps, notification of individuals (how and
when), contact person. Confirm with privacy counsel before filing.

**Individuals (when Fishtape must notify them directly)**

> We are writing to tell you about a security incident at Fishtape, a service <company> uses.
> On <date>, <what happened>. The information involved was <kinds>. <What we have done.> What you
> can do: <steps>. You can contact us at <contact>, and you have the right to complain to the
> Office of the Privacy Commissioner of Canada.
