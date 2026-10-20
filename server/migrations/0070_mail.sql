-- 0070 mail: SendGrid sending and delivery events for email_outbox, and the HQ inbox
-- (mailboxes, threads, messages, attachments). docs/email/README.md explains the flow.
--
-- Mail is platform data: no company can see it. Access by role:
--   fishtape_hq   (the HQ console API, hq-api)  reads and changes all mail tables.
--   fishtape_app  (tenant API and worker)       no access to mailboxes, threads, messages,
--                 attachments or settings. It may only DROP new inbound mail into mail_inbound
--                 and record delivery events in email_events (INSERT, never SELECT), and only
--                 outside a tenant transaction (app.tenant_id unset).
-- hq-api moves mail_inbound rows into the inbox (src/email/inbox.js syncMail).

-- email_outbox: provider, two-phase sending, HQ-composed mail, delivery state -------------------
ALTER TABLE email_outbox DROP CONSTRAINT email_outbox_status_check;
ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_status_check CHECK (status IN ('queued', 'sending', 'sent', 'failed'));
ALTER TABLE email_outbox
  ADD COLUMN provider            text CHECK (provider IS NULL OR provider IN ('sendgrid', 'resend')),
  ADD COLUMN provider_message_id text CHECK (provider_message_id IS NULL OR length(provider_message_id) <= 200),
  ADD COLUMN sending_at          timestamptz,
  -- HQ Mail sends through the same queue with its own sender, recipients, headers and files.
  ADD COLUMN from_address        text CHECK (from_address IS NULL OR length(from_address) <= 320),
  ADD COLUMN reply_to            text CHECK (reply_to IS NULL OR length(reply_to) <= 320),
  ADD COLUMN to_addresses        text[],
  ADD COLUMN cc_addresses        text[],
  ADD COLUMN bcc_addresses       text[],
  ADD COLUMN headers             jsonb,
  ADD COLUMN attachments         jsonb,
  ADD COLUMN mail_message_id     uuid,
  -- Latest delivery state from the SendGrid Event Webhook (src/email/events.js).
  ADD COLUMN delivery_status     text CHECK (delivery_status IS NULL OR delivery_status IN ('processed', 'deferred', 'delivered', 'bounce', 'blocked', 'dropped', 'spamreport')),
  ADD COLUMN delivery_detail     text CHECK (delivery_detail IS NULL OR length(delivery_detail) <= 500),
  ADD COLUMN delivery_at         timestamptz,
  ADD COLUMN opened_at           timestamptz;
CREATE INDEX email_outbox_sending_idx ON email_outbox (sending_at) WHERE status = 'sending';
CREATE INDEX email_outbox_mail_idx ON email_outbox (mail_message_id) WHERE mail_message_id IS NOT NULL;
CREATE INDEX email_outbox_failed_idx ON email_outbox (created_at DESC) WHERE status = 'failed';

-- Delivery events, one row per SendGrid sg_event_id (replays are ignored). No foreign key:
-- sent outbox rows are purged after 7 days, their events stay for HQ Mail.
CREATE TABLE email_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sg_event_id   text NOT NULL CHECK (length(sg_event_id) BETWEEN 1 AND 200),
  outbox_id     uuid,
  event         text NOT NULL CHECK (event ~ '^[a-z_]{1,40}$'),
  recipient     text CHECK (recipient IS NULL OR length(recipient) <= 320),
  reason        text CHECK (reason IS NULL OR length(reason) <= 500),
  smtp_status   text CHECK (smtp_status IS NULL OR length(smtp_status) <= 40),
  bounce_type   text CHECK (bounce_type IS NULL OR length(bounce_type) <= 40),
  bounce_class  text CHECK (bounce_class IS NULL OR length(bounce_class) <= 60),
  sg_message_id text CHECK (sg_message_id IS NULL OR length(sg_message_id) <= 200),
  occurred_at   timestamptz NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX email_events_sg_event_id_key ON email_events (sg_event_id);
CREATE INDEX email_events_outbox_idx ON email_events (outbox_id, occurred_at);
CREATE INDEX email_events_received_idx ON email_events (received_at);

-- Mailboxes: an address SendGrid Inbound Parse delivers to, plus any addresses forwarded in.
CREATE TABLE mail_mailboxes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  address        text NOT NULL UNIQUE CHECK (address = lower(address) AND length(address) BETWEEN 3 AND 254),
  aliases        text[] NOT NULL DEFAULT '{}' CHECK (cardinality(aliases) <= 50),
  from_name      text CHECK (from_name IS NULL OR length(from_name) <= 80),
  from_address   text CHECK (from_address IS NULL OR (from_address = lower(from_address) AND length(from_address) BETWEEN 3 AND 254)),
  signature_html text NOT NULL DEFAULT '' CHECK (length(signature_html) <= 20000),
  is_default     boolean NOT NULL DEFAULT false,
  sort           integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX mail_mailboxes_one_default ON mail_mailboxes (is_default) WHERE is_default;

-- Replies are sent From the authenticated domain and come back through Reply-To to the inbox host.
INSERT INTO mail_mailboxes (name, address, from_name, from_address, is_default, sort, signature_html) VALUES
  ('Support', 'support@inbox.fishtapehq.com', 'Fishtape Support', 'support@fishtapehq.com', true, 0, '<p>Fishtape Support<br>fishtapehq.com</p>'),
  ('Sales', 'sales@inbox.fishtapehq.com', 'Fishtape Sales', 'sales@fishtapehq.com', false, 1, '<p>Fishtape Sales<br>fishtapehq.com</p>');

CREATE TABLE mail_threads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id      uuid NOT NULL REFERENCES mail_mailboxes (id) ON DELETE CASCADE,
  subject         text NOT NULL DEFAULT '' CHECK (length(subject) <= 1000),
  -- Lower case, without Re:/Fwd: prefixes: the fallback when a reply has no usable References.
  subject_key     text NOT NULL DEFAULT '' CHECK (length(subject_key) <= 1000),
  assigned_to     uuid REFERENCES users (id) ON DELETE SET NULL,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mail_threads_subject_idx ON mail_threads (mailbox_id, subject_key, last_message_at DESC);

CREATE TABLE mail_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id      uuid NOT NULL REFERENCES mail_mailboxes (id) ON DELETE CASCADE,
  thread_id       uuid NOT NULL REFERENCES mail_threads (id) ON DELETE CASCADE,
  direction       text NOT NULL CHECK (direction IN ('in', 'out')),
  folder          text NOT NULL CHECK (folder IN ('inbox', 'sent', 'drafts', 'archive', 'junk', 'trash')),
  prev_folder     text CHECK (prev_folder IS NULL OR prev_folder IN ('inbox', 'sent', 'drafts', 'archive', 'junk')),
  source          text NOT NULL CHECK (source IN ('parse', 'support', 'compose')),
  message_id      text CHECK (message_id IS NULL OR length(message_id) <= 998),
  in_reply_to     text CHECK (in_reply_to IS NULL OR length(in_reply_to) <= 998),
  refs            text[] NOT NULL DEFAULT '{}' CHECK (cardinality(refs) <= 100),
  from_name       text CHECK (from_name IS NULL OR length(from_name) <= 300),
  from_address    text CHECK (from_address IS NULL OR length(from_address) <= 320),
  to_list         jsonb NOT NULL DEFAULT '[]',
  cc_list         jsonb NOT NULL DEFAULT '[]',
  bcc_list        jsonb NOT NULL DEFAULT '[]',
  reply_to_list   jsonb NOT NULL DEFAULT '[]',
  subject         text NOT NULL DEFAULT '' CHECK (length(subject) <= 1000),
  text_body       text,
  html_body       text,
  preview         text NOT NULL DEFAULT '' CHECK (length(preview) <= 300),
  has_attachments boolean NOT NULL DEFAULT false,
  size_bytes      integer NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  spam_score      real,
  is_spam         boolean NOT NULL DEFAULT false,
  auth_results    jsonb,
  is_read         boolean NOT NULL DEFAULT false,
  is_flagged      boolean NOT NULL DEFAULT false,
  meta            jsonb,
  raw_key         text CHECK (raw_key IS NULL OR raw_key ~ '^[a-f0-9]{32}$'),
  outbox_id       uuid,
  send_status     text CHECK (send_status IS NULL OR send_status IN ('queued', 'sending', 'sent', 'failed')),
  delivery_status text,
  delivery_detail text CHECK (delivery_detail IS NULL OR length(delivery_detail) <= 500),
  created_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  sent_at         timestamptz,
  received_at     timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  search          tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig,
                    coalesce(subject, '') || ' ' || coalesce(from_name, '') || ' ' || coalesce(from_address, '') || ' ' || left(coalesce(text_body, ''), 200000))) STORED
);
CREATE INDEX mail_messages_folder_idx ON mail_messages (mailbox_id, folder, received_at DESC);
CREATE INDEX mail_messages_thread_idx ON mail_messages (thread_id, received_at);
CREATE INDEX mail_messages_message_id_idx ON mail_messages (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX mail_messages_outbox_idx ON mail_messages (outbox_id) WHERE outbox_id IS NOT NULL;
CREATE INDEX mail_messages_unread_idx ON mail_messages (mailbox_id, folder) WHERE NOT is_read;
CREATE INDEX mail_messages_search_idx ON mail_messages USING gin (search);

-- Files live on disk under MAIL_DIR with random names; this is the only map to them.
CREATE TABLE mail_attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id   uuid REFERENCES mail_messages (id) ON DELETE CASCADE,  -- NULL: an upload not yet on a message
  storage_key  text NOT NULL UNIQUE CHECK (storage_key ~ '^[a-f0-9]{32}$'),
  filename     text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  content_type text NOT NULL CHECK (length(content_type) BETWEEN 3 AND 255),
  size_bytes   integer NOT NULL CHECK (size_bytes >= 0),
  sha256       text CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  content_id   text CHECK (content_id IS NULL OR length(content_id) <= 998),
  is_inline    boolean NOT NULL DEFAULT false,
  uploaded_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mail_attachments_message_idx ON mail_attachments (message_id);
CREATE INDEX mail_attachments_orphan_idx ON mail_attachments (created_at) WHERE message_id IS NULL;

-- Drop box: inbound mail (SendGrid Inbound Parse) and in-app support requests, written by the
-- tenant API (write-only) and filed into mailboxes by hq-api.
CREATE TABLE mail_inbound (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source      text NOT NULL CHECK (source IN ('parse', 'support')),
  payload     jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text CHECK (last_error IS NULL OR length(last_error) <= 300)
);

CREATE TABLE mail_settings (
  id              boolean PRIMARY KEY DEFAULT true CHECK (id),
  retention_days  integer NOT NULL DEFAULT 730 CHECK (retention_days BETWEEN 30 AND 3650),
  cleanup_days    integer NOT NULL DEFAULT 30 CHECK (cleanup_days BETWEEN 1 AND 365),
  spam_threshold  real NOT NULL DEFAULT 5 CHECK (spam_threshold BETWEEN 0 AND 100),
  last_cleanup_at timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO mail_settings DEFAULT VALUES;

-- Row-level security: forced everywhere, HQ-only policies, plus the two write-only drop boxes.
ALTER TABLE email_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_events FORCE ROW LEVEL SECURITY;
CREATE POLICY email_events_app_insert ON email_events FOR INSERT TO fishtape_app WITH CHECK (app_tenant_id() IS NULL);
CREATE POLICY email_events_hq ON email_events TO fishtape_hq USING (true) WITH CHECK (true);

ALTER TABLE mail_inbound ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_inbound FORCE ROW LEVEL SECURITY;
CREATE POLICY mail_inbound_app_insert ON mail_inbound FOR INSERT TO fishtape_app WITH CHECK (app_tenant_id() IS NULL);
CREATE POLICY mail_inbound_hq ON mail_inbound TO fishtape_hq USING (true) WITH CHECK (true);

ALTER TABLE mail_mailboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_mailboxes FORCE ROW LEVEL SECURITY;
CREATE POLICY mail_mailboxes_hq ON mail_mailboxes TO fishtape_hq USING (true) WITH CHECK (true);
ALTER TABLE mail_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_threads FORCE ROW LEVEL SECURITY;
CREATE POLICY mail_threads_hq ON mail_threads TO fishtape_hq USING (true) WITH CHECK (true);
ALTER TABLE mail_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY mail_messages_hq ON mail_messages TO fishtape_hq USING (true) WITH CHECK (true);
ALTER TABLE mail_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY mail_attachments_hq ON mail_attachments TO fishtape_hq USING (true) WITH CHECK (true);
ALTER TABLE mail_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY mail_settings_hq ON mail_settings TO fishtape_hq USING (true) WITH CHECK (true);

-- Grants. fishtape_app: the two drop boxes, INSERT only. Nothing else.
GRANT INSERT ON email_events, mail_inbound TO fishtape_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON mail_mailboxes, mail_threads, mail_messages, mail_attachments TO fishtape_hq;
GRANT SELECT, UPDATE ON mail_settings TO fishtape_hq;
GRANT SELECT, DELETE ON mail_inbound, email_events TO fishtape_hq;
GRANT UPDATE (attempts, last_error) ON mail_inbound TO fishtape_hq;
-- HQ queues its own mail, can cancel a queued message, and asks the worker to send right away.
GRANT INSERT ON email_outbox TO fishtape_hq;
GRANT UPDATE (status, attempts, last_error) ON email_outbox TO fishtape_hq;
GRANT INSERT ON jobs_queue TO fishtape_hq;
