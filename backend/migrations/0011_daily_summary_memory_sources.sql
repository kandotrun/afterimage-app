ALTER TABLE daily_summaries RENAME TO daily_summaries_legacy;

CREATE TABLE daily_summaries (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  source_digest TEXT NOT NULL CHECK(length(source_digest) = 64),
  source_transcript_count INTEGER NOT NULL CHECK(source_transcript_count >= 0),
  source_visual_analysis_count INTEGER NOT NULL CHECK(source_visual_analysis_count >= 0),
  summary TEXT NOT NULL CHECK(length(trim(summary)) > 0 AND length(summary) <= 60),
  model TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  CHECK(source_transcript_count + source_visual_analysis_count > 0),
  PRIMARY KEY(user_id, start_at, end_at)
);

INSERT INTO daily_summaries (
  user_id, start_at, end_at, source_digest, source_transcript_count,
  source_visual_analysis_count, summary, model, generated_at
)
SELECT
  user_id, start_at, end_at, transcript_digest, source_transcript_count,
  0, summary, model, generated_at
FROM daily_summaries_legacy;

DROP TABLE daily_summaries_legacy;

CREATE INDEX idx_daily_summaries_user_digest_model
  ON daily_summaries(user_id, source_digest, model);
