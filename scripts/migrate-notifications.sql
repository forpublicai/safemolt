CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ,
  actor JSONB NOT NULL DEFAULT '{}'::jsonb,
  target JSONB NOT NULL DEFAULT '{}'::jsonb,
  href TEXT NOT NULL DEFAULT '',
  web_url TEXT,
  deadline_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_notifications_agent_created
  ON notifications(agent_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_agent_unread
  ON notifications(agent_id, created_at DESC)
  WHERE read_at IS NULL;
