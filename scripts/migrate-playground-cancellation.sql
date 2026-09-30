-- M11-1 C3: playground cancellation becomes an attributed terminal transition, not a delete.
--
-- The cancel route hard-deleted the session row (any participant could destroy another group's
-- game with no record), and the stale-pending expiry path deleted too. Deletion cascaded action
-- rows while activity events kept no FK — dead links — and erased the evidence of who cancelled.
-- The user's decision (Locked decision 8): keep cancellation available to participants and make
-- it ACCOUNTABLE — status 'cancelled' plus who, why, and when. The expiry sweep uses the same
-- transition with a NULL actor and a sentinel reason, so an operator can tell an agent's
-- cancellation from a timeout.
--
-- status stays TEXT (no CHECK constraint exists on it), so 'cancelled' needs no DDL beyond the
-- attribution columns.
--
-- Idempotent (Locked decision 5): re-running is the recovery path.

ALTER TABLE playground_sessions ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE playground_sessions ADD COLUMN IF NOT EXISTS cancelled_by_agent_id TEXT REFERENCES agents(id);
ALTER TABLE playground_sessions ADD COLUMN IF NOT EXISTS cancelled_reason TEXT;

-- Postconditions: the columns and the attribution FK.
DO $$
BEGIN
  -- All three attribution columns, each nullable with no default. Nullability is not cosmetic
  -- here: an uncancelled session carries NULL in all three, and the **expiry sweep deliberately
  -- writes a NULL actor** to mark a system timeout apart from an agent's cancellation. A
  -- pre-existing `cancelled_by_agent_id TEXT NOT NULL` would pass a name-and-type check, be
  -- recorded as migrated, and then make the expiry sweep fail on every run. A default would
  -- likewise stamp every existing session as cancelled-by-someone.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'playground_sessions'
      AND column_name = 'cancelled_at' AND data_type = 'timestamp with time zone'
      AND is_nullable = 'YES' AND column_default IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'playground_sessions'
      AND column_name = 'cancelled_by_agent_id' AND data_type = 'text'
      AND is_nullable = 'YES' AND column_default IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'playground_sessions'
      AND column_name = 'cancelled_reason' AND data_type = 'text'
      AND is_nullable = 'YES' AND column_default IS NULL
  ) THEN
    RAISE EXCEPTION 'C3 postcondition failed: playground_sessions cancellation columns are missing or are not nullable-with-no-default (the expiry sweep writes a NULL actor by design)';
  END IF;

  -- The exact shape, not merely "this column participates in some FK to agents". `= ANY (conkey)`
  -- is satisfied by a composite key that happens to include the column, and says nothing about
  -- which agents column is referenced — either would be recorded as a valid attribution FK while
  -- cancellation writes later fail or attribute to the wrong column. Asserted the same way the
  -- soft-delete migration asserts posts.deleted_by_agent_id: one column here, agents.id there.
  -- `confdeltype = 'a'` (NO ACTION) is asserted too, because the delete behaviour is the point of
  -- an attribution column: this migration creates it as a plain `REFERENCES agents(id)`, so
  -- deleting an agent who cancelled a session must be *refused*, preserving the record of who
  -- cancelled. A pre-existing CASCADE would erase whole sessions when an agent is deleted, and a
  -- SET NULL would quietly rewrite an attributed cancellation into a system-expiry one — the very
  -- distinction the NULL actor encodes.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.playground_sessions'::regclass
      AND contype = 'f'
      AND confrelid = 'public.agents'::regclass
      AND confdeltype = 'a'
      AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                          WHERE attrelid = 'public.playground_sessions'::regclass
                            AND attname = 'cancelled_by_agent_id')]
      AND confkey = ARRAY[(SELECT attnum FROM pg_attribute
                           WHERE attrelid = 'public.agents'::regclass AND attname = 'id')]
  ) THEN
    RAISE EXCEPTION 'C3 postcondition failed: single-column NO ACTION FK playground_sessions.cancelled_by_agent_id -> agents.id is missing or has the wrong delete behaviour';
  END IF;
END
$$;
