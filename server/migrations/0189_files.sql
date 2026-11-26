-- 0189 Files (#/files): a Drive-like store of each company's documents, organised by customer and job
-- with standard subfolders (electrical-app/js/lib/files-classify.js has the list) and filed by AI.
--
-- The bytes live in FILES_DIR on the server: outside the code checkout and outside every web root,
-- random 128-bit names, mode 600, never served by nginx. They are read only through the authenticated,
-- company-scoped route GET /api/v1/files/:id/content (routes/v1/files.js). These tables hold the
-- metadata, tenant-scoped under RLS like their neighbours; the client portal sees none of it.
--
-- A file's place: category NULL and folder_id NULL = "Inbox · needs sorting". Otherwise it sits in a
-- standard subfolder (category) of the company area (client_id and job_id NULL), a customer
-- (client_id) or a job (job_id), optionally inside a folder people made (folder_id).
-- Deleting moves a file to "Recently deleted" (deleted_at); the worker purges the bytes after 30 days.

CREATE TABLE file_folders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  client_id   text CHECK (client_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  job_id      text CHECK (job_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  category    text CHECK (category ~ '^[a-z][a-z-]{1,30}$'),
  parent_id   uuid REFERENCES file_folders (id) ON DELETE CASCADE,
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX file_folders_tenant_idx ON file_folders (tenant_id, parent_id);

CREATE TABLE files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  original_name text NOT NULL CHECK (length(original_name) BETWEEN 1 AND 260),
  mime          text NOT NULL CHECK (length(mime) BETWEEN 3 AND 120),
  ext           text NOT NULL DEFAULT '' CHECK (ext ~ '^[a-z0-9]{0,8}$'),
  bytes         bigint NOT NULL CHECK (bytes >= 0),
  sha256        text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  -- Random 32-hex name in FILES_DIR (sub-folder = first two characters). Never shown to anyone.
  storage_key   text NOT NULL UNIQUE CHECK (storage_key ~ '^[a-f0-9]{32}$'),
  client_id     text CHECK (client_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  job_id        text CHECK (job_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  category      text CHECK (category ~ '^[a-z][a-z-]{1,30}$'),
  folder_id     uuid REFERENCES file_folders (id) ON DELETE SET NULL,
  -- Up to 8,000 characters of text (PDF text from the device, or the file itself for plain text), for
  -- search and for filing again later.
  text_excerpt  text CHECK (length(text_excerpt) <= 8000),
  -- How it was filed: { by: 'ai'|'rules'|'person', provider, confidence, reason, suggestedName, suggestion, at }
  ai            jsonb CHECK (ai IS NULL OR jsonb_typeof(ai) = 'object'),
  source        text NOT NULL DEFAULT 'upload' CHECK (source IN ('upload', 'share', 'drop', 'camera')),
  created_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  deleted_by    uuid REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX files_tenant_idx ON files (tenant_id, created_at DESC);
CREATE INDEX files_place_idx ON files (tenant_id, client_id, job_id, category) WHERE deleted_at IS NULL;
CREATE INDEX files_sha_idx ON files (tenant_id, sha256);
CREATE INDEX files_trash_idx ON files (deleted_at) WHERE deleted_at IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['file_folders', 'files'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    -- Company staff only: the client portal (app_portal_client_id) never reads or writes files.
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL) WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL)', t || '_tenant', t);
    -- DELETE is for purging after "Recently deleted" (the bytes go too); people's deletes are soft.
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO fishtape_app', t);
    EXECUTE format('GRANT SELECT ON %I TO fishtape_hq', t);
  END LOOP;
END $$;

-- AI filing is metered with the assistant's usage and monthly cap (feature 'files').
ALTER TABLE ai_usage DROP CONSTRAINT IF EXISTS ai_usage_feature_check;
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_feature_check
  CHECK (feature IN ('assistant', 'cec', 'background', 'mcp', 'files'));
