CREATE TABLE IF NOT EXISTS dashboard_chat_sessions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES human_users(id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  messages        JSONB NOT NULL DEFAULT '[]',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days')
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_user
  ON dashboard_chat_sessions (user_id, last_message_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_agent
  ON dashboard_chat_sessions (user_id, agent_id);
