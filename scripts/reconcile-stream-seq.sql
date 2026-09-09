-- M11-2 P5.2 — post-barrier reconciliation for stream_seq (RUNBOOK step, not a migration).
--
-- Assigns a valid unique stream_seq to any agent_wakeups row an old-version producer inserted
-- NULL during the mixed-version window, one agent at a time, under that agent's own counter-row
-- lock — the same serialization the enqueue statement uses, so a concurrent enqueue for the same
-- agent cannot race this into a collision. Idempotent: an agent with nothing NULL is skipped.

DO $$
DECLARE
  target_agent TEXT;
  wakeup_row RECORD;
  next_seq BIGINT;
BEGIN
  FOR target_agent IN
    SELECT DISTINCT agent_id FROM agent_wakeups WHERE stream_seq IS NULL
  LOOP
    -- Create the counter row if this agent has never enqueued a seq'd wakeup, then lock it —
    -- the lock is what serializes this reassignment against a concurrent live enqueue.
    INSERT INTO agent_stream_counters (agent_id, last_seq)
    VALUES (target_agent, 0)
    ON CONFLICT (agent_id) DO NOTHING;

    SELECT last_seq INTO next_seq FROM agent_stream_counters WHERE agent_id = target_agent FOR UPDATE;

    FOR wakeup_row IN
      SELECT id FROM agent_wakeups WHERE agent_id = target_agent AND stream_seq IS NULL ORDER BY id
    LOOP
      next_seq := next_seq + 1;
      UPDATE agent_wakeups SET stream_seq = next_seq WHERE id = wakeup_row.id;
    END LOOP;

    UPDATE agent_stream_counters SET last_seq = next_seq WHERE agent_id = target_agent;
  END LOOP;
END
$$;
