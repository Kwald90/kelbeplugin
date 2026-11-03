-- 0168 Walkthrough video store. A site walkthrough (collection `walkthroughs`) is an ordinary
-- synced JSON record; its video is too large to sync, so the bytes live on the media volume
-- (MEDIA_DIR, like HQ promotion media) and this table holds one row of metadata per video,
-- tenant-scoped under RLS. The synced record keeps only this row's id (recording.mediaId), never
-- a URL, so playback URLs can change (e.g. move to signed URLs) without rewriting records.
--
-- Lifecycle: the device uploads the recording -> a row is inserted `processing` and a
-- `walkthrough_transcode` job is queued -> the worker runs ffmpeg (720p H.264 + faststart) and a
-- poster, then sets the row `ready` -> the client plays /media/<output_file>. Original webm/mp4
-- is kept until a successful transcode, then removed to save disk.

CREATE TABLE walkthrough_media (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- The client walkthrough record this video belongs to (same id pattern as a synced record).
  walkthrough_id text NOT NULL CHECK (walkthrough_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  status         text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'failed')),
  -- Random 32-hex file names in MEDIA_DIR (nginx only serves that pattern). NULL until produced.
  original_file  text CHECK (original_file ~ '^[a-f0-9]{32}\.(mp4|webm)$'),
  output_file    text CHECK (output_file ~ '^[a-f0-9]{32}\.mp4$'),
  poster_file    text CHECK (poster_file ~ '^[a-f0-9]{32}\.jpg$'),
  original_mime  text CHECK (original_mime IN ('video/mp4', 'video/webm')),
  bytes          bigint CHECK (bytes >= 0),
  duration_ms    integer CHECK (duration_ms >= 0),
  width          integer CHECK (width >= 0),
  height         integer CHECK (height >= 0),
  error          text CHECK (length(error) <= 1000),
  created_by     uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX walkthrough_media_tenant_idx ON walkthrough_media (tenant_id, created_at DESC);
CREATE INDEX walkthrough_media_walkthrough_idx ON walkthrough_media (tenant_id, walkthrough_id);

ALTER TABLE walkthrough_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE walkthrough_media FORCE ROW LEVEL SECURITY;
-- Tenant staff only: the client portal (app_portal_client_id) cannot read or write video rows.
CREATE POLICY walkthrough_media_tenant ON walkthrough_media
  USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL);
GRANT SELECT, INSERT, UPDATE, DELETE ON walkthrough_media TO fishtape_app;
GRANT SELECT ON walkthrough_media TO fishtape_hq;
