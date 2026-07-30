ALTER TABLE assets ADD COLUMN deletion_requested_at TEXT;

UPDATE assets
   SET upload_id = NULL, part_size = NULL
 WHERE status = 'ready';

CREATE INDEX IF NOT EXISTS assets_deletion_requested_idx
  ON assets(deletion_requested_at, updated_at);

CREATE TABLE IF NOT EXISTS soniox_work_leases (
  asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS soniox_work_leases_user_expiry_idx
  ON soniox_work_leases(user_id, expires_at);

CREATE TABLE IF NOT EXISTS soniox_cleanup_outbox (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  soniox_file_id TEXT,
  soniox_transcription_id TEXT,
  promoted_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 100),
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(soniox_file_id IS NOT NULL OR soniox_transcription_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS soniox_cleanup_outbox_owner_idx
  ON soniox_cleanup_outbox(owner_token);

CREATE INDEX IF NOT EXISTS soniox_cleanup_outbox_retry_idx
  ON soniox_cleanup_outbox(promoted_at, next_attempt_at, created_at);
