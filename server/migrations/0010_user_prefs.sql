-- Per-user preferences that follow a person across devices (workstream G).
-- Today: units ('metric'|'imperial') and theme ('light'|'dark'|'system'). The PWA keeps a
-- copy in localStorage as its offline cache. No secrets or customer data belong here.
ALTER TABLE users
  ADD COLUMN prefs jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(prefs) = 'object' AND pg_column_size(prefs) <= 4096);
