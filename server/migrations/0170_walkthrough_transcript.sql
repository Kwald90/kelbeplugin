-- 0170 Walkthrough transcription: the AI (Gemini) transcript of a recorded walk, produced by the
-- worker from the stored video's audio (services/gemini.js). Stored on the media row so it can be
-- re-fetched and so the client can poll for it, separate from the client-editable transcript on the
-- synced walkthrough record. transcribe_status drives the poll (processing -> ready | failed).
-- fishtape_app already has full DML on walkthrough_media (0168), so added columns need no new grant.
ALTER TABLE walkthrough_media
  ADD COLUMN transcript        text CHECK (transcript IS NULL OR length(transcript) <= 200000),
  ADD COLUMN transcribe_status text CHECK (transcribe_status IS NULL OR transcribe_status IN ('processing', 'ready', 'failed')),
  ADD COLUMN transcribe_error  text CHECK (transcribe_error IS NULL OR length(transcribe_error) <= 1000),
  ADD COLUMN transcribed_at    timestamptz;
