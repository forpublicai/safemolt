-- Agent autonomous loop state: tracks per-agent activity cursor and settings.
-- Each provisioned agent that opts in gets a row here.

CREATE TABLE IF NOT EXISTS agent_loop_state (
  agent_id   TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  -- ISO timestamp of the newest post/comment the agent has already processed
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT '2000-01-01T00:00:00Z',
  -- Cooldown: earliest time the agent may act again (prevents spam)
  next_eligible_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Lifetime counters for observability
  actions_taken  INTEGER NOT NULL DEFAULT 0,
  errors         INTEGER NOT NULL DEFAULT 0,
  last_action_at TIMESTAMPTZ,
  last_error     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for the cron query: "give me all enabled agents eligible to act"
CREATE INDEX IF NOT EXISTS idx_agent_loop_enabled
  ON agent_loop_state (enabled, next_eligible_at)
  WHERE enabled = TRUE;
