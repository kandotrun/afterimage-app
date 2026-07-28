CREATE TABLE daily_summaries (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  transcript_digest TEXT NOT NULL CHECK(length(transcript_digest) = 64),
  source_transcript_count INTEGER NOT NULL CHECK(source_transcript_count > 0),
  summary TEXT NOT NULL CHECK(length(trim(summary)) > 0 AND length(summary) <= 60),
  model TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, start_at, end_at)
);

CREATE INDEX IF NOT EXISTS idx_daily_summaries_user_digest_model
  ON daily_summaries(user_id, transcript_digest, model);
