-- 0026 HQ media: videos and posters uploaded in HQ > Promotions (POST /api/hq/media).
-- The files live in MEDIA_DIR (outside the code checkout, served read-only by nginx at
-- /media/); this table records what each random file name is, who uploaded it and its hash.

CREATE TABLE hq_media (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name   text NOT NULL UNIQUE CHECK (file_name ~ '^[a-f0-9]{32}\.(mp4|webm|jpg|png|webp)$'),
  kind        text NOT NULL CHECK (kind IN ('video', 'image')),
  mime_type   text NOT NULL CHECK (mime_type IN ('video/mp4', 'video/webm', 'image/jpeg', 'image/png', 'image/webp')),
  bytes       bigint NOT NULL CHECK (bytes > 0),
  sha256      text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  label       text NOT NULL DEFAULT '' CHECK (length(label) <= 200),   -- the uploader's file name, cleaned
  uploaded_by uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hq_media_created_idx ON hq_media (created_at DESC);

GRANT SELECT, INSERT, DELETE ON hq_media TO fishtape_hq;
