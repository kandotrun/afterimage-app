CREATE TABLE IF NOT EXISTS apple_auth_challenges (
  id TEXT PRIMARY KEY,
  nonce TEXT NOT NULL UNIQUE CHECK(length(nonce) = 43),
  client_ip_hash TEXT NOT NULL CHECK(length(client_ip_hash) = 64),
  identity_token_hash TEXT UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS apple_auth_challenges_rate_idx
  ON apple_auth_challenges(client_ip_hash, created_at);

CREATE INDEX IF NOT EXISTS apple_auth_challenges_expiry_idx
  ON apple_auth_challenges(expires_at);

CREATE TABLE IF NOT EXISTS ai_consents (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  consented_at TEXT,
  withdrawn_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK(consented_at IS NOT NULL OR withdrawn_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS asset_creation_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS asset_creation_ledger_user_time_idx
  ON asset_creation_ledger(user_id, created_at);

INSERT OR IGNORE INTO asset_creation_ledger (id, user_id, created_at)
SELECT id, user_id, created_at FROM assets;

CREATE TABLE IF NOT EXISTS external_ai_work_leases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('qwen_summary')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS external_ai_work_leases_user_expiry_idx
  ON external_ai_work_leases(user_id, expires_at);

CREATE TABLE IF NOT EXISTS account_deletion_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  apple_subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'completed')),
  authorization_code TEXT CHECK(authorization_code IS NULL OR length(authorization_code) BETWEEN 10 AND 2048),
  revocation_token TEXT CHECK(revocation_token IS NULL OR length(revocation_token) BETWEEN 1 AND 16384),
  revocation_token_type TEXT CHECK(revocation_token_type IN ('refresh_token', 'access_token')),
  apple_revoked_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 100),
  next_attempt_at TEXT NOT NULL,
  last_error_code TEXT CHECK(last_error_code IS NULL OR length(last_error_code) <= 64),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS account_deletion_jobs_retry_idx
  ON account_deletion_jobs(status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS account_deletion_jobs_subject_idx
  ON account_deletion_jobs(apple_subject, status, created_at DESC);

CREATE TABLE IF NOT EXISTS account_deletion_receipts (
  token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 64),
  job_id TEXT NOT NULL REFERENCES account_deletion_jobs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS account_deletion_receipts_job_idx
  ON account_deletion_receipts(job_id);

CREATE TABLE IF NOT EXISTS account_deletion_assets (
  job_id TEXT NOT NULL REFERENCES account_deletion_jobs(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  upload_mode TEXT NOT NULL CHECK(upload_mode IN ('single', 'multipart')),
  upload_id TEXT,
  soniox_file_id TEXT,
  soniox_transcription_id TEXT,
  soniox_cleaned_at TEXT,
  multipart_aborted_at TEXT,
  r2_cleaned_at TEXT,
  PRIMARY KEY(job_id, asset_id)
);

CREATE INDEX IF NOT EXISTS account_deletion_assets_pending_idx
  ON account_deletion_assets(job_id, soniox_cleaned_at, r2_cleaned_at);

CREATE TRIGGER IF NOT EXISTS assets_agent_access_default_off
AFTER INSERT ON assets
WHEN NEW.agent_access_enabled <> 0
BEGIN
  UPDATE assets SET agent_access_enabled = 0 WHERE id = NEW.id;
END;

UPDATE assets SET agent_access_enabled = 0 WHERE agent_access_enabled <> 0;

DELETE FROM media_grants
WHERE purpose IN ('agent', 'worker') OR id LIKE 'transcription:%';

DELETE FROM gpu_jobs;
