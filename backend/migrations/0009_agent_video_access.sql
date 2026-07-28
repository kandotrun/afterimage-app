ALTER TABLE assets ADD COLUMN agent_access_enabled INTEGER NOT NULL DEFAULT 1
  CHECK(agent_access_enabled IN (0, 1));

CREATE INDEX assets_agent_timeline_idx
  ON assets(user_id, agent_access_enabled, captured_at DESC, id DESC);

CREATE TABLE gpu_jobs (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('analysis', 'frame', 'clip')),
  status TEXT NOT NULL CHECK(status IN ('queued', 'leased', 'failed')),
  request_json TEXT NOT NULL,
  priority INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 3),
  available_at TEXT NOT NULL,
  lease_token_hash TEXT,
  lease_expires_at TEXT,
  error_code TEXT CHECK(error_code IN (
    'download_failed',
    'size_mismatch',
    'decode_failed',
    'model_load_failed',
    'inference_failed',
    'output_invalid',
    'disk_space_low',
    'cancelled'
  )),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX gpu_jobs_lease_idx
  ON gpu_jobs(status, priority DESC, available_at, created_at);
CREATE INDEX gpu_jobs_asset_idx ON gpu_jobs(asset_id, kind, status);

CREATE TABLE video_analyses (
  asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL UNIQUE,
  model_id TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  backend TEXT NOT NULL CHECK(backend IN ('frames', 'codec')),
  coverage_mode TEXT NOT NULL CHECK(coverage_mode IN ('full', 'sampled')),
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE video_analysis_ranges (
  analysis_asset_id TEXT NOT NULL REFERENCES video_analyses(asset_id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position >= 0),
  start_ms INTEGER NOT NULL CHECK(start_ms >= 0),
  end_ms INTEGER NOT NULL CHECK(end_ms > start_ms),
  PRIMARY KEY(analysis_asset_id, position)
);

CREATE TABLE video_analysis_segments (
  analysis_asset_id TEXT NOT NULL REFERENCES video_analyses(asset_id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position >= 0),
  start_ms INTEGER NOT NULL CHECK(start_ms >= 0),
  end_ms INTEGER NOT NULL CHECK(end_ms > start_ms),
  caption TEXT NOT NULL CHECK(length(caption) BETWEEN 1 AND 2000),
  PRIMARY KEY(analysis_asset_id, position)
);

CREATE TABLE media_derivatives (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('frame', 'clip')),
  start_ms INTEGER NOT NULL CHECK(start_ms >= 0),
  end_ms INTEGER NOT NULL CHECK(end_ms >= start_ms),
  status TEXT NOT NULL CHECK(status IN ('queued', 'ready', 'failed')),
  object_key TEXT,
  content_type TEXT,
  byte_size INTEGER CHECK(byte_size > 0),
  error_code TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(asset_id, kind, start_ms, end_ms)
);

CREATE INDEX media_derivatives_expiry_idx ON media_derivatives(expires_at);

ALTER TABLE media_grants ADD COLUMN purpose TEXT NOT NULL DEFAULT 'app'
  CHECK(purpose IN ('app', 'agent', 'worker'));
ALTER TABLE media_grants ADD COLUMN derivative_id TEXT;

INSERT INTO gpu_jobs (
  id, asset_id, kind, status, request_json, priority, attempt_count,
  available_at, created_at, updated_at
)
SELECT
  lower(hex(randomblob(16))), id, 'analysis', 'queued', '{}', 0, 0,
  updated_at, updated_at, updated_at
FROM assets
WHERE kind = 'video' AND status = 'ready' AND agent_access_enabled = 1;
