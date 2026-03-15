-- AT Protocol blob metadata (projected blobs e.g. agent avatars)
CREATE TABLE IF NOT EXISTS atproto_blobs (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  cid TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  source_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, cid)
);

CREATE INDEX IF NOT EXISTS idx_atproto_blobs_agent ON atproto_blobs(agent_id);
