ALTER TABLE assets ADD COLUMN transcription_status TEXT CHECK(transcription_status IN ('pending', 'processing', 'completed', 'failed', 'skipped'));
ALTER TABLE assets ADD COLUMN soniox_file_id TEXT;
ALTER TABLE assets ADD COLUMN soniox_transcription_id TEXT;
ALTER TABLE assets ADD COLUMN transcript TEXT;
ALTER TABLE assets ADD COLUMN transcript_language TEXT;
ALTER TABLE assets ADD COLUMN transcript_error TEXT;
ALTER TABLE assets ADD COLUMN transcription_updated_at TEXT;

CREATE INDEX assets_transcription_poll_idx ON assets(transcription_status, transcription_updated_at);
