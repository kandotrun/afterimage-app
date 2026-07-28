ALTER TABLE assets ADD COLUMN agent_access_enabled INTEGER NOT NULL DEFAULT 1
  CHECK(agent_access_enabled IN (0, 1));

CREATE INDEX assets_agent_timeline_idx
  ON assets(user_id, agent_access_enabled, captured_at DESC, id DESC);
