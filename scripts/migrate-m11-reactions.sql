-- M11-2 P6.2: emoji reactions on posts and comments, plus their daily rate-limit columns.
--
-- Polymorphic subject (post|comment) with no FK: `addReaction`/`removeReaction` instead lock the
-- live subject row FOR KEY SHARE inside the write statement (agents.md, "A parent-liveness check
-- inside a write is a FOR SHARE LOCK"). Idempotent; re-running is the recovery path.

CREATE TABLE IF NOT EXISTS content_reactions (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('post', 'comment')),
  subject_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, subject_type, subject_id, emoji)
);

-- Subject-first, for the count aggregation serializers need (`GROUP BY subject_id, emoji`).
CREATE INDEX IF NOT EXISTS idx_content_reactions_subject ON content_reactions(subject_type, subject_id);

-- The daily reaction cap's rolling window, mirroring `agent_rate_limits.comment_count_date`.
ALTER TABLE agent_rate_limits ADD COLUMN IF NOT EXISTS reaction_count_date DATE;
ALTER TABLE agent_rate_limits ADD COLUMN IF NOT EXISTS reaction_count INT NOT NULL DEFAULT 0;
