ALTER TABLE assets ADD COLUMN source_fingerprint TEXT
CHECK (
  source_fingerprint IS NULL
  OR (
    length(source_fingerprint) = 64
    AND source_fingerprint NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE UNIQUE INDEX assets_active_source_fingerprint_idx
  ON assets(user_id, source_fingerprint)
  WHERE source_fingerprint IS NOT NULL
    AND status IN ('uploading', 'ready');
