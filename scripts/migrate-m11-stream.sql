-- M11-2 P5.2 (lane S) — SSE stream substrate: expand step.
--
-- `stream_seq` cannot be the wakeup's own id (ids allocate before commit, so replay needs a value
-- whose commit order matches allocation order) — `agent_stream_counters` provides that value,
-- incremented under its own row lock by the enqueue statement (a later chunk). This file only
-- expands the schema: nullable column, backfill, counter seed. Contract (`NOT NULL`) is a
-- separate runbook step, after `reconcile-stream-seq.sql` clears any post-barrier NULLs.

CREATE TABLE IF NOT EXISTS agent_stream_counters (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  last_seq BIGINT NOT NULL DEFAULT 0
);

ALTER TABLE agent_wakeups ADD COLUMN IF NOT EXISTS stream_seq BIGINT;

-- Plain (non-partial) unique index: Postgres already treats multiple NULLs as distinct under a
-- unique index, so pre-backfill and mixed-version rows with `stream_seq IS NULL` coexist freely.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wakeups_stream_seq ON agent_wakeups(agent_id, stream_seq);

-- Backfill only rows still NULL, numbered from each agent's own already-assigned maximum (0 if
-- none) so a recovery re-run after a partial failure extends rather than collides with any seqs
-- a previous partial run already committed for that agent.
WITH existing_max AS (
  SELECT agent_id, MAX(stream_seq) AS base FROM agent_wakeups GROUP BY agent_id
),
backfill AS (
  SELECT w.id, ROW_NUMBER() OVER (PARTITION BY w.agent_id ORDER BY w.id) + COALESCE(m.base, 0) AS seq
  FROM agent_wakeups w
  LEFT JOIN existing_max m ON m.agent_id = w.agent_id
  WHERE w.stream_seq IS NULL
)
UPDATE agent_wakeups w
SET stream_seq = backfill.seq
FROM backfill
WHERE w.id = backfill.id;

-- Seed each counter to the backfilled maximum. GREATEST(...) makes a re-run harmless — it can
-- only raise an already-seeded counter, never lower one below what a concurrent enqueue set.
INSERT INTO agent_stream_counters (agent_id, last_seq)
SELECT agent_id, MAX(stream_seq) FROM agent_wakeups WHERE stream_seq IS NOT NULL GROUP BY agent_id
ON CONFLICT (agent_id) DO UPDATE
  SET last_seq = GREATEST(agent_stream_counters.last_seq, EXCLUDED.last_seq);

-- `agent_id` is deliberately FK-less: NULL means a firehose frame with no single recipient, and
-- nothing here needs a cascade.
CREATE TABLE IF NOT EXISTS stream_frames (
  id BIGSERIAL PRIMARY KEY,
  agent_id TEXT,
  frame TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  frame_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stream_frames_agent ON stream_frames(agent_id, id);
