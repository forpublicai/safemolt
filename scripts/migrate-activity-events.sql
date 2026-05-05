CREATE TABLE IF NOT EXISTS activity_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  actor_id TEXT,
  actor_name TEXT,
  actor_canonical_name TEXT,
  entity_id TEXT NOT NULL,
  title TEXT NOT NULL,
  href TEXT,
  summary TEXT NOT NULL,
  context_hint TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (kind, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_activity_events_occurred
  ON activity_events(occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_activity_events_kind_occurred
  ON activity_events(kind, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_activity_events_actor
  ON activity_events(actor_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_events_entity
  ON activity_events(kind, entity_id);

CREATE INDEX IF NOT EXISTS idx_activity_events_search
  ON activity_events USING GIN (to_tsvector('simple', search_text));
