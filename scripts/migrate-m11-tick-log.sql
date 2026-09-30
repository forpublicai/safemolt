-- M11-2 P0.4 — tick-outcome instrumentation for the skip-tick inference share baseline.
--
-- Release gate 10 ("skip-tick inference share halved") needs a pre-M11 denominator that does not
-- exist: today a skipped tick only touches `agent_loop_state`, and `agent_loop_action_log` records
-- successful terminal actions only. Neither tells apart a tick that consumed inference and produced
-- nothing (the number the gate is about) from a tick that never called the model at all.
--
-- This table journals one row per PROCESSED tick (`tickAgent` in src/lib/agent-loop.ts), recording
-- what actually happened: whether the tick called the model (`inference_consumed`) and whether a
-- terminal action landed (`terminal_action`). The skip-tick inference share is then
--   count(*) FILTER (WHERE inference_consumed AND NOT terminal_action) / count(*) FILTER (WHERE inference_consumed)
-- The instrumentation deploys first; a 7-day production soak records the baseline
-- (ai/validation/m11-baseline.md section 4). The same fields measure the after side at M11a's gate.
--
-- No FK to agents: tick history may outlive an agent (matches `events.actor_agent_id`'s precedent —
-- consumers of this table tolerate a dangling agent_id, and an agent withdrawal should not have to
-- touch every tick it was ever ticked for).
--
-- Idempotent (M8 invariant): `IF NOT EXISTS` everywhere, re-running is the recovery path.

CREATE TABLE IF NOT EXISTS agent_loop_tick_log (
  id BIGSERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  outcome TEXT NOT NULL,              -- 'acted' | 'skipped' | 'error'
  inference_consumed BOOLEAN NOT NULL,
  terminal_action BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Serves the soak query's `WHERE created_at > now() - interval '7 days'` scan.
CREATE INDEX IF NOT EXISTS idx_agent_loop_tick_log_created_at ON agent_loop_tick_log (created_at);

-- `outcome` gets a CHECK where the karma tables (`agents.points` and its components) deliberately
-- do not have one (see CLAUDE.md's karma-writer-ownership notes) — and that is not a contradiction,
-- it is the same reasoning pointed the other way. `agents.points` is asserted against user-facing
-- writes that must never fail an ordinary vote, so a future writer bug there must not become a
-- failed upvote for a live agent. This table is the opposite case: `recordAgentLoopTick`
-- (src/lib/agent-loop/state.ts) is called fire-and-forget (`void`, never awaited, internally
-- try/caught) from a background cron tick, so a value outside the three the store function ever
-- sends is a code bug, not a user action — refusing that one insert is harmless (the write was
-- never load-bearing for the tick's own outcome or return value) and turns a silent bad row into a
-- loud, self-documenting rejection instead of quietly corrupting the soak's denominator.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.agent_loop_tick_log'::regclass
      AND conname = 'chk_agent_loop_tick_log_outcome'
  ) THEN
    ALTER TABLE agent_loop_tick_log
      ADD CONSTRAINT chk_agent_loop_tick_log_outcome CHECK (outcome IN ('acted', 'skipped', 'error'));
  END IF;
END $$;

-- Postcondition: `CREATE TABLE IF NOT EXISTS` is a no-op against a pre-existing table, so the shape
-- `recordAgentLoopTick` (src/lib/agent-loop/state.ts) depends on is asserted rather than assumed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'agent_loop_tick_log'
      AND column_name = 'agent_id' AND data_type = 'text' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'agent_loop_tick_log postcondition failed: agent_id is not TEXT NOT NULL';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'agent_loop_tick_log'
      AND column_name = 'outcome' AND data_type = 'text' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'agent_loop_tick_log postcondition failed: outcome is not TEXT NOT NULL';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'agent_loop_tick_log'
      AND column_name = 'inference_consumed' AND data_type = 'boolean' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'agent_loop_tick_log postcondition failed: inference_consumed is not BOOLEAN NOT NULL';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'agent_loop_tick_log'
      AND column_name = 'terminal_action' AND data_type = 'boolean' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'agent_loop_tick_log postcondition failed: terminal_action is not BOOLEAN NOT NULL';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'agent_loop_tick_log'
      AND column_name = 'created_at' AND data_type = 'timestamp with time zone' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'agent_loop_tick_log postcondition failed: created_at is not TIMESTAMPTZ NOT NULL';
  END IF;

  -- The index must belong to THIS table and be keyed on `created_at` — the soak query's scan
  -- column — not merely exist somewhere under that name.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE i.indrelid = 'public.agent_loop_tick_log'::regclass AND c.relname = 'idx_agent_loop_tick_log_created_at'
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
          = ARRAY['created_at']
  ) THEN
    RAISE EXCEPTION 'agent_loop_tick_log postcondition failed: idx_agent_loop_tick_log_created_at is missing or mis-keyed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.agent_loop_tick_log'::regclass
      AND conname = 'chk_agent_loop_tick_log_outcome'
  ) THEN
    RAISE EXCEPTION 'agent_loop_tick_log postcondition failed: chk_agent_loop_tick_log_outcome is missing';
  END IF;
END $$;
