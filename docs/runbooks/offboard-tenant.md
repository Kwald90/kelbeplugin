# Offboard a tenant, export data, handle deletion requests

Three related requests:

- **A company leaves** (cancels): export, close, delete after the notice period.
- **A company asks for a copy of its data**: export (section 1).
- **A person asks for their personal information to be corrected or deleted** (a customer of a
  tenant, a tenant's employee, a lead): the tenant controls that data. Forward the request to the
  tenant within 2 business days and help them act on it; Fishtape deletes on the tenant's
  instruction (section 4). For Fishtape's own account data (users, billing contacts), Fishtape
  answers directly within 30 days as PIPEDA requires.

The API has no self-serve export or delete for a whole company yet (planned for HQ). Until then,
Kelvin runs the steps below as the database superuser inside the container. Every step is
recorded in the incident-style record at the end. Retention rules:
[backup-retention.md](../compliance/backup-retention.md).

Run everything from `<checkout>/deploy/<env>` in a root shell (`sudo -i`), after defining:

```bash
sql() { docker compose exec -T postgres psql -U postgres -d fishtape -v ON_ERROR_STOP=1 "$@"; }
sql -c "SELECT id, name, status FROM tenants ORDER BY name"      # find the tenant id
T=<tenant uuid>
```

## 1. Export

Records are JSON in each collection table. A full export per collection, as JSON lines:

```bash
mkdir -m 700 /root/export-$T
for t in $(sql -Atc "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'data')
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id')
      AND c.relname <> 'record_history'"); do
  sql -Atc "SELECT row_to_json(r) FROM (SELECT id, data, version, created_at, updated_at, deleted_at
            FROM $t WHERE tenant_id = '$T' ORDER BY id) r" > /root/export-$T/$t.jsonl
done
tar -C /root -czf - export-$T | age -r <the company's age or ssh public key, or a one-time key> > /root/export-$T.tar.gz.age
```

Send the encrypted file through a link that expires (or hand it over); send the passphrase or key
by another channel. Delete `/root/export-$T*` from the host when delivered. Plan images and photos
are inside the drawing and wire-run records as data URLs.

## 2. Close (the company leaves)

**QuickBooks first.** If the company connected QuickBooks, disconnect it before anything else, so
Intuit's grant ends while Fishtape still holds the token to revoke it:

- Best: an owner or admin presses **Disconnect from QuickBooks** on the company's QuickBooks
  screen (revokes at Intuit, then deletes the tokens).
- Otherwise: closing the company from HQ (Delete company…, step 2) queues
  `qbo_token_housekeeping` for it at once, which revokes and disconnects. Check HQ > the company >
  QuickBooks shows `disconnected` within a few minutes; if it does not, see
  [quickbooks-support.md](quickbooks-support.md#a-token-that-will-not-revoke).
- Closing by hand with the SQL below does not queue it: the daily housekeeping run disconnects
  closed companies, but run it now with
  `sql -c "INSERT INTO jobs_queue (kind, tenant_id, payload, dedupe_key) VALUES ('qbo_token_housekeeping', '$T', jsonb_build_object('tenantId', '$T'), 'qbo_token_housekeeping:$T')"`
  after the `UPDATE tenants` line.

A revoke Intuit refuses is retried from `qbo_revoke_pending` for 14 days, and survives the
company's deletion. Records that came from QuickBooks stay the company's own records (in the export).

```bash
sql -c "UPDATE tenants SET status = 'closed', updated_at = now() WHERE id = '$T'"
sql -c "UPDATE sessions SET revoked_at = now() WHERE tenant_id = '$T' AND revoked_at IS NULL"
sql -c "UPDATE api_keys SET revoked_at = now() WHERE tenant_id = '$T' AND revoked_at IS NULL"
```

A closed company can't sign in or sync (the API answers 403 `tenant_inactive`). Cancel its
Fishtape subscription in Stripe. Remind the company to revoke the keys it gave Fishtape (Stripe,
Twilio, Resend, Meta, Anthropic) at those providers, and to check Fishtape is gone from QuickBooks
(Apps > My apps).

## 3. Delete (after the notice period in the agreement, 30 days by default)

Every tenant table references `tenants` with `ON DELETE CASCADE`, so deleting the company row
removes all of its data in one step. `audit_events` has no foreign key on purpose (the log outlives
the tenant): it stays for 1 year after closure, then goes in the second step below.

```bash
sql <<SQL
BEGIN;
-- People who belonged to this company, captured before their memberships go.
CREATE TEMP TABLE leaving ON COMMIT DROP AS
  SELECT DISTINCT user_id FROM memberships WHERE tenant_id = '$T';
DELETE FROM tenants WHERE id = '$T' AND status = 'closed';
-- Their user accounts, unless they still belong to another company or are HQ staff.
DELETE FROM users u USING leaving l
 WHERE u.id = l.user_id AND u.platform_role IS NULL
   AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id);
COMMIT;
SQL
```

If the `DELETE FROM tenants` reports `DELETE 0`, the company wasn't closed first (step 2).
Check nothing is left except the audit trail:

```bash
sql -Atc "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r'
    AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped)" |
while read -r t; do echo "$t $(sql -Atc "SELECT count(*) FROM $t WHERE tenant_id = '$T'")"; done
# every count 0 except audit_events
```

One year after closure (unless there is a legal hold), delete the audit trail. `audit_events`
refuses deletes, so its guard trigger is switched off inside the transaction only; do it at a quiet
hour (the table is locked for the moment it takes):

```bash
sql <<SQL
BEGIN;
ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update;
DELETE FROM audit_events WHERE tenant_id = '$T';
ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update;
COMMIT;
SQL
```

Backups: deleted data stays in encrypted backups until they age out (14 days daily and 8 weeks weekly
on the server, and about 13 months in the offsite weekly copies (400-day lifecycle)). Tell the company
that date; don't edit backups.

## 4. Deleting one person's data (on the tenant's instruction)

Prefer the tenant doing it in the app (delete the client, lead or employee record): that is
audited and syncs the deletion to devices. An app delete is a soft delete (a tombstone, so devices
learn about it); the record's body and its `record_history` rows still hold the personal data, so
on a deletion request also purge them centrally:

```bash
sql -c "SELECT id FROM <collection table> WHERE tenant_id = '$T' AND data::text ILIKE '%<name or email>%'"
sql -c "UPDATE <collection table> SET data = '{}'::jsonb WHERE tenant_id = '$T' AND id = '<record id>' AND deleted_at IS NOT NULL"
sql -c "DELETE FROM record_history WHERE tenant_id = '$T' AND record_id = '<record id>'"
```

Search free text too (notes, sequence emails, audit summaries) and note every change in the
record below. If the schema rejects an empty `data` for that collection, ask workstream A for a
purge function rather than editing rows by hand.

## Record

Keep in the encrypted evidence store: who asked, when, what was exported or deleted (tables, row
counts), the closure and deletion dates, when backups age out, and confirmation sent to the
requester. Deletion requests are part of the privacy evidence (P4/P5 in `compliance/controls.yaml`).
