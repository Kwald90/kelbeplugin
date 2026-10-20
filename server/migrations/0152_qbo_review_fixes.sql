-- 0152 QuickBooks review fixes (docs/integrations/quickbooks.md 2.2, 4.9, 5.4, 5.8).

-- A payment Fishtape created in QuickBooks owns the line of the invoice it was sent to (4.9). Links
-- written before the create recorded it have the invoice in their snapshot: settlement, the line
-- checks and the merge find the payment by qbo_line.
UPDATE qbo_links SET qbo_line = snapshot->>'invoiceRef', updated_at = now()
 WHERE collection = 'payments' AND role = 'main' AND qbo_entity = 'Payment' AND qbo_line = ''
   AND qbo_id IS NOT NULL AND snapshot ? 'invoiceRef' AND snapshot->>'invoiceRef' ~ '^[0-9]{1,20}$';

-- The interstitial's pre-flow cookie (2.2): GET start stores its hash on the ticket, and the form's
-- POST must carry the cookie. A cross-site auto-submit of a ticket has none.
ALTER TABLE qbo_oauth_states ADD COLUMN preflow_hash bytea CHECK (preflow_hash IS NULL OR length(preflow_hash) = 32);

-- Failed tries of an outbox row whose record has no link yet (5.8): a failure before the pending link
-- exists still counts toward the poison limit.
ALTER TABLE qbo_outbox ADD COLUMN attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 1000);

-- A full reconcile's resume point (5.4 step 1): where it got to, so the next pass carries on instead
-- of starting over. NULL when no full reconcile is running.
ALTER TABLE qbo_connections ADD COLUMN reconcile jsonb CHECK (reconcile IS NULL OR jsonb_typeof(reconcile) = 'object');

-- Back-off of the dispatcher's periodic jobs (5.8): { "<kind>": { "until": iso, "failures": n } } for
-- qbo_reference_refresh, qbo_cdc and qbo_check, so a job that keeps failing or a pull stopped by a
-- budget is not queued again every minute.
ALTER TABLE qbo_connections ADD COLUMN backoff jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(backoff) = 'object');
