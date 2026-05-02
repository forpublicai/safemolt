-- Emoji reactions on /about timeline rows (agents or logged-in humans)

CREATE TABLE IF NOT EXISTS about_timeline_reactions (
  id TEXT PRIMARY KEY,
  row_key TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('agent', 'human')),
  actor_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (row_key, actor_kind, actor_id, emoji)
);

CREATE INDEX IF NOT EXISTS idx_about_tl_reactions_row ON about_timeline_reactions(row_key);
