-- 0090 notifications (onboarding/import/notifications workstream, range 0090-0099): the bell in the
-- app. One row per person: server code fans a notification out to the members it is for
-- (services/notify.js). Tenant data with RLS like the rest, narrowed to the person: anyone in the
-- company context may create a notification for a member, only that member reads or changes it.

CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.-]{0,39}$'),
  title      text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  body       text CHECK (body IS NULL OR length(body) <= 2000),
  link       text CHECK (link IS NULL OR (length(link) <= 500 AND link ~ '^#/')),  -- an app route, never an outside URL
  ref        text CHECK (ref IS NULL OR length(ref) <= 200),                        -- once per person per ref
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz,
  emailed_at timestamptz
);
CREATE INDEX notifications_user_idx ON notifications (tenant_id, user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (tenant_id, user_id) WHERE read_at IS NULL;
CREATE UNIQUE INDEX notifications_ref_key ON notifications (tenant_id, user_id, ref) WHERE ref IS NOT NULL;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY notifications_insert ON notifications FOR INSERT
  WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL);
CREATE POLICY notifications_select ON notifications FOR SELECT
  USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL AND user_id::text = app_user_id());
CREATE POLICY notifications_update ON notifications FOR UPDATE
  USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL AND user_id::text = app_user_id())
  WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL AND user_id::text = app_user_id());
CREATE POLICY notifications_delete ON notifications FOR DELETE
  USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL AND user_id::text = app_user_id());

-- Per person and company: the daily email digest (off by default). The digest worker lists who
-- asked for it per company, so reading is company-wide (the row holds only a yes/no and times);
-- changing it is the person's own.
CREATE TABLE notification_prefs (
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  digest         boolean NOT NULL DEFAULT false,
  last_digest_at timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
ALTER TABLE notification_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_prefs FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_prefs_select ON notification_prefs FOR SELECT
  USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL);
CREATE POLICY notification_prefs_insert ON notification_prefs FOR INSERT
  WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL AND user_id::text = app_user_id());
CREATE POLICY notification_prefs_update ON notification_prefs FOR UPDATE
  USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL AND user_id::text = app_user_id())
  WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL AND user_id::text = app_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON notifications TO fishtape_app;
GRANT SELECT, INSERT, UPDATE ON notification_prefs TO fishtape_app;
