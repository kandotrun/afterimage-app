PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  apple_subject TEXT NOT NULL UNIQUE,
  email TEXT,
  display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX sessions_user_expiry_idx ON sessions(user_id, expires_at);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('photo', 'video')),
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK(byte_size > 0),
  captured_at TEXT NOT NULL,
  duration_ms INTEGER,
  width INTEGER,
  height INTEGER,
  status TEXT NOT NULL CHECK(status IN ('uploading', 'ready', 'failed')),
  object_key TEXT NOT NULL UNIQUE,
  thumbnail_key TEXT,
  upload_mode TEXT NOT NULL CHECK(upload_mode IN ('single', 'multipart')),
  upload_id TEXT,
  part_size INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX assets_timeline_idx ON assets(user_id, captured_at DESC, id DESC);

CREATE TABLE upload_parts (
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL CHECK(part_number BETWEEN 1 AND 10000),
  etag TEXT NOT NULL,
  PRIMARY KEY(asset_id, part_number)
);
