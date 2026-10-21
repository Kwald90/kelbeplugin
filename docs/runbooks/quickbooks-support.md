# QuickBooks support

Use it when a company's QuickBooks sync needs help: it asks to reconnect, something did not reach
QuickBooks, the books don't match, an HQ alert arrived, or a server moves. The design is in
[docs/integrations/quickbooks.md](../integrations/quickbooks.md) (the contract; section numbers
below point into it). Alerts and their thresholds:
[logging-monitoring.md](../compliance/logging-monitoring.md#quickbooks-alerts).

What you can see, and where:

| who | where | what |
| --- | --- | --- |
| The company's office (owner, admin, office) | **QuickBooks** in the app (`#/quickbooks`), its Activity (sync log), Conflicts and each record's badge | Everything about their own sync, including Intuit's error text and the Intuit transaction id |
| HQ | HQ > the company > **QuickBooks** card; HQ > Developer > **QuickBooks** | States, times, counts, error codes and Intuit transaction ids. Never the QuickBooks company name, customers, records or messages |
| Support with an open support grant | HQ > the company > Support access | The company's Fishtape records, as for any support case (audited in their log) |

Never ask a company for its QuickBooks password, and never sign in to their QuickBooks. Changes in
their books are theirs to make; Fishtape support explains what the sync did.

## Reconnect

The company sees "Reconnect to QuickBooks" when the connection is `reconnect_needed` (HQ shows the
reason):

| reason | meaning | what to do |
| --- | --- | --- |
| `revoked` | Intuit refused the refresh token: someone disconnected Fishtape inside QuickBooks, or the grant was revoked | An owner or admin presses **Reconnect** and signs in to the **same** QuickBooks company. Nothing is lost: edits made meanwhile wait in the outbox and go once it is back. |
| `expired` | The refresh token lapsed (100 days unused, or the 5-year hard limit) | Same. The daily housekeeping refreshes every 30 days, so a lapse means the worker was down for months or the hard limit came; the company was emailed 30, 7 and 1 days before it. |
| `environment` | This server's `QBO_ENVIRONMENT` differs from the one the company connected under (sandbox vs production) | Fix the server's setting if it is wrong; otherwise the company reconnects under this environment's keys (a different environment is a different company to Intuit, so it needs a purge first: [Purging](#purging)). |
| `not_canada`, `not_cad` | The QuickBooks company is not Canadian or not in CAD | Not supported (1.2). |
| `error` | Anything else | Read the company's Activity for the detail; ask them for a screenshot if needed. |

Reconnecting to a **different** QuickBooks company is refused (`wrong_company`). To switch
companies, they disconnect with "Also delete the links" ticked, then connect the new one and run the
setup again.

## Token problems

- **Many companies at once** (`qbo_platform_credentials` or `qbo_mass_revoke` alert): this is
  Fishtape's problem, not theirs. Do not ask anyone to reconnect. Check `QBO_CLIENT_ID`,
  `QBO_CLIENT_SECRET` and `QBO_ENVIRONMENT` (HQ > Settings shows whether each is set) against the
  Intuit developer portal. After a fix, restart api and worker; companies recover on their own
  (the token breaker closes after 10 minutes).
- **One company** keeps landing in `reconnect_needed` right after reconnecting: two Fishtape
  servers may be refreshing the same company's token (see [Moving a server](#moving-a-server)), or
  the company keeps disconnecting the app in QuickBooks. Check HQ > Developer > QuickBooks events
  for `invalid_grant` on that company.

## Reading the sync log and finding an `intuit_tid`

The company's office opens **QuickBooks > Activity**: every push and pull with its outcome, the
record, and for errors Intuit's own text and the **Intuit transaction id**. Filters: outcome
(errors, conflicts, practice-mode "would change"), collection, record. A record's badge sheet shows
the last 20 lines for that record.

Intuit support asks for the `intuit_tid`. The office copies it from the log line's detail. HQ sees
the last 10 errors' codes and transaction ids on the company's QuickBooks card ("Last errors"),
without the text. Error codes worth knowing (5.8):

| code | meaning |
| --- | --- |
| 5010 | Stale object: someone edited it in QuickBooks at the same moment; retried automatically |
| 6140 / 6240 | Duplicate document number / duplicate name; the badge offers Renumber or a choice |
| 6000 | Validation (often a closed period: "books closed") |
| 5020 | Permission: the QuickBooks user who connected lost admin rights |
| 5030 | The QuickBooks plan lacks the feature (purchase orders need Plus) |
| 610 | The referenced object is inactive or gone in QuickBooks |

## Pausing and releasing a company

HQ > the company > **QuickBooks** card (every action needs a reason and goes into the company's own
audit log, which its owner can read):

- **Pause QuickBooks sync** (HQ staff): nothing is pushed or pulled for this company until HQ resumes
  it; the office sees "Paused by Fishtape support" and cannot resume. A pass already running stops
  before its next write. Edits made meanwhile wait and go after **Resume**. Resuming a company that
  was already paused before (by itself, its plan, its budget or the safety brake) puts that pause
  back.
- **Release QuickBooks company** (HQ admins): disconnects this company and frees its QuickBooks
  company so another Fishtape company can connect it. The worker then deletes the old tokens. It
  revokes them at Intuit first only if no other Fishtape company has connected that QuickBooks
  company meanwhile: the grant may be shared, and revoking it would disconnect the new holder. Use it for a squatted company when the takeover below is not possible, and record
  who asked and how you checked they are entitled to the books.

## Takeover

A QuickBooks company can be connected to only one Fishtape company. When another Fishtape company
holds it (for example a former employee who is still a QuickBooks admin connected the books to a
throwaway trial), the real company sees "This QuickBooks company is connected to another Fishtape
company" and, for an owner or admin with two-step sign-in, **Move it to <company>**. Approving
Intuit's consent screen already proved they are a QuickBooks admin of those books. The other
Fishtape company is disconnected and emailed. Support never names the other company to them.

If the button does not appear (no owner or admin with two-step sign-in, or the offer expired after
10 minutes), they connect again, or HQ releases the other company (above).

## Purging

Disconnecting keeps links, mappings and the log for 30 days so a reconnect to the same company
skips the setup. "Also delete the links to <company> now" (or 30 days passing) deletes them.
Records that came from QuickBooks stay in Fishtape. A purge is needed before connecting a different
QuickBooks company or switching between sandbox and production (`purge_required`); the server
refuses until then, so old links can never be used against other books.

A `qbo_realm_mismatch` alert means the sync found rows written for another QuickBooks company than
the one connected and refused them. That should never happen: pause the company from HQ and treat
it as a bug.

## Safety brake

When a company's sync would write more than 500 changes in an hour (outside the setup), it stops
before writing, pauses itself (`paused`, reason `brake`), notifies the office and alerts HQ
(`qbo_safety_brake`). Usually it is a big legitimate change (a price list import, a mapping change
that re-sends every invoice); sometimes a bug.

1. Ask the office what they changed. Look at the counts on HQ's card and the company's log.
2. If it is expected, the office presses **Resume** and confirms "Allow N changes". It runs once
   with that allowance for an hour.
3. If it is not, keep the company paused from HQ and open an incident
   ([incident-response.md](incident-response.md)).

## The "Doesn't match" list

The daily check (5.13) compares, for every linked open invoice and bill, the QuickBooks balance and
total with Fishtape's, and the Stripe clearing account's balance with what Fishtape expects. It
writes nothing. Differences above 2 cents show on the company's QuickBooks overview with both
amounts and a link to the record. Common causes:

- a payment entered only in QuickBooks before the sync start date (it shows as a "Credited or paid in
  QuickBooks" settlement payment once QuickBooks applies it);
- a one-cent tax rounding QuickBooks would not take (the badge says "QuickBooks tax differs by $0.01";
  the pay link already charges the QuickBooks total);
- a Stripe refund, dispute or fee Fishtape does not book (the payout is in review; the bookkeeper
  enters it in QuickBooks and resolves the review);
- an edit in QuickBooks to a closed period (see below).

The office fixes it on whichever side is wrong; the next pass syncs it.

## Release 1 reviews (contract 17)

The company's QuickBooks **Conflicts** list holds these; support explains them, the office decides.

| reason | what happened | what the office does |
| --- | --- | --- |
| `period_locked` | QuickBooks changed (or created) a record in a month closed on Fishtape's Books page. Fishtape kept its copy; the refused write is on Books → refused writes. | An owner reopens the month on Books, then **Reopen the period and accept QuickBooks**; or **Keep the difference noted** with a note. Fishtape's copy is never pushed over QuickBooks (`qbo_locked`). |
| `document_signed` | QuickBooks changed an estimate the customer signed in Fishtape. | Make a revision in Fishtape, or note the difference. |
| `exemption_missing` | A Manitoba invoice from QuickBooks charges no RST and the job has no exemption evidence. | Add the customer's number on the job, then **Check again** (422 `exemption_required` lists what is still missing). |
| `holdback_invalid`, `tax_off_invalid` | A QuickBooks invoice's holdback or a line's tax cannot stand in Fishtape. | Fix it in QuickBooks (or Fishtape), then **Check again**. |
| `credit_apply` | A credit note applied to an invoice: sent as a $0 payment only after approval (sandbox VERIFY). | **Approve and send**. Once Intuit's sandbox confirms the shape, HQ may ask the company to set the option `creditApplyConfirmed`. |
| `on_account`, `refund`, `reversal` | Money on account, a refund or a returned payment: never sent in R1. | Enter it in QuickBooks, then **I've recorded it in QuickBooks** (approving is refused, `qbo_not_sent`). |

`blocked/mapping_missing` with "Pick the QuickBooks product for Holdback / Deposits / Interest" or "RST
recoverable" means the mapping row is empty: the office picks it on the mappings screen and the waiting
records go again. A deposit invoice never uses the `other` item as a fallback.

## A token that will not revoke

A revoke Intuit refuses (on disconnect, purge or close) is kept sealed in `qbo_revoke_pending` and
retried daily for 14 days. HQ > Developer > QuickBooks shows how many are pending. After 14 days it
is deleted and `qbo_revoke_gave_up` alerts HQ: ask the company to remove Fishtape in QuickBooks
(Apps > My apps > Fishtape > Disconnect), which ends the grant from their side.

## Stop everything

For a problem across companies (a bad release writing wrong data, Intuit asking us to stop):

1. `set-env.sh <env> QBO_WRITES` and type `off`; `sudo docker compose up -d api worker`. Nothing is
   written to any company's QuickBooks; pulls continue; edits wait in the outbox. Every company sees
   "Sending to QuickBooks is paused by Fishtape. Your changes are kept and will be sent."
2. Pause the companies concerned from HQ, so nothing restarts on its own when writes come back.
3. Fix, then `QBO_WRITES` back to `on`, restart, and resume the companies one at a time, watching
   their logs.

Turning QuickBooks off entirely (empty `QBO_ENVIRONMENT`) also stops pulls and webhooks; edits are
picked up by the Fishtape-side sweep when it comes back.

## Moving a server

Staging to production (TG Electrical's case, open question 13.2), or any move of a company's data
between servers. The rule: **never two servers holding live tokens for the same company.** Both
would refresh the same refresh token, and each refresh kills the other's.

1. On the old server: `QBO_WRITES=off`, then empty `QBO_ENVIRONMENT` and stop its worker
   (`sudo docker compose stop worker`). Nothing there talks to Intuit any more.
2. Move the data (backup and restore, [restore-from-backup.md](restore-from-backup.md)) with the
   **same** `SECRETS_MASTER_KEY`. With a different key: re-wrap the tenant secrets and run
   `node scripts/qbo-rehash.js` on the new server in the same window
   ([rotate-secrets.md](rotate-secrets.md#secrets_master_key-tenant-secrets-envelope-key)), or
   webhooks will not find the company.
3. In the Intuit developer portal, point the webhook at the new server
   (`https://<new host>/api/v1/webhooks/qbo`), and add the new redirect URI
   (`https://<new host>/api/v1/qbo/oauth/callback`). Production keys only on a server whose hosting
   region matches Intuit's answer ([vendor-management.md](../compliance/vendor-management.md#intuit-quickbooks-online)).
4. Set the keys on the new server with `set-env.sh` (`QBO_ENVIRONMENT`, `QBO_CLIENT_ID`,
   `QBO_CLIENT_SECRET`, `QBO_WEBHOOK_VERIFIER`), with `QBO_WRITES=off`, and start it.
5. Check one company in practice mode first: set its option `writeMode` to `shadow` (its mappings
   screen), turn `QBO_WRITES` on, let a pass run, and read the "would change" list. Then back to
   live.
6. Remove the old server's Intuit settings for good (its `.env` QBO lines, the old redirect URI if
   no longer used). The monthly read allowance belongs to the Intuit app, so both servers shared it
   while both ran.

Record the move in the evidence store: when, which companies, who checked the shadow pass.
