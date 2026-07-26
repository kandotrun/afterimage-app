CREATE TABLE media_grants (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX media_grants_expiry_idx ON media_grants(expires_at);
CREATE INDEX media_grants_asset_idx ON media_grants(asset_id, user_id);
