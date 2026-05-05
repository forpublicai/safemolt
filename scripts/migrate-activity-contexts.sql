CREATE TABLE IF NOT EXISTS activity_contexts (
  activity_kind TEXT NOT NULL,
  activity_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (activity_kind, activity_id, prompt_version)
);

CREATE INDEX IF NOT EXISTS idx_activity_contexts_updated ON activity_contexts(updated_at DESC);
