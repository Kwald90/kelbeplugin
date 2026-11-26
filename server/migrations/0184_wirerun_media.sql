-- 0184 Wire-run video. The AR tape can record the camera while it measures, and a wire run can
-- carry the recording so the run can be re-checked later. The bytes go through the same video
-- store as walkthroughs (walkthrough_media, migration 0168): the media volume, the
-- walkthrough_transcode worker job, /media/ playback. Two additions:
--
-- 1. owner_kind says what the row belongs to. 'walkthrough' rows keep walkthrough_id as before; for
--    'wirerun' rows walkthrough_id holds the wire run's record id (same id pattern). Each route only
--    reads and writes rows of its own kind.
-- 2. Resumable uploads. Phones on a job site lose signal, and an AR recording can be large, so a
--    wire-run video goes up in chunks. The row is created first with status 'uploading', the
--    expected size in upload_total and the partial file in upload_file (a dot-name nginx never
--    serves); bytes counts what has arrived. When the last chunk lands the partial is renamed to a
--    random 32-hex name, the row turns 'processing' and the usual transcode job is queued.
--
-- fishtape_app already has full DML on walkthrough_media (0168), so the new columns need no grant.
ALTER TABLE walkthrough_media
  ADD COLUMN owner_kind   text NOT NULL DEFAULT 'walkthrough' CHECK (owner_kind IN ('walkthrough', 'wirerun')),
  ADD COLUMN upload_file  text CHECK (upload_file ~ '^\.upload-[a-f0-9]{32}\.part$'),
  ADD COLUMN upload_total bigint CHECK (upload_total >= 0),
  ADD COLUMN upload_mime  text CHECK (upload_mime IN ('video/mp4', 'video/webm'));

ALTER TABLE walkthrough_media DROP CONSTRAINT walkthrough_media_status_check;
ALTER TABLE walkthrough_media ADD CONSTRAINT walkthrough_media_status_check
  CHECK (status IN ('uploading', 'processing', 'ready', 'failed'));

-- An upload in progress always knows its size and partial file; a finished one has neither.
ALTER TABLE walkthrough_media ADD CONSTRAINT walkthrough_media_upload_state_check
  CHECK ((status = 'uploading') = (upload_file IS NOT NULL AND upload_total IS NOT NULL));

CREATE INDEX walkthrough_media_owner_idx ON walkthrough_media (tenant_id, owner_kind, walkthrough_id);
