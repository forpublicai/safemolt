-- M11-1 C14: durable vetting challenges.
--
-- Challenges lived in a process-local Map even in the DB store, so on serverless the start and
-- complete requests routinely landed on different instances and vetting randomly 404'd for
-- legitimate agents. This table is the durable home; the completion path locks the agent row,
-- then the challenge row, performs the vetting and bootstrap writes gated on the live challenge,
-- and consumes the challenge last — all in one transaction (src/lib/store/agents/db.ts).
--
-- "values" is quoted throughout: it is a reserved word, and the column name comes verbatim from
-- the plan's locked table spec.
--
-- Idempotent (Locked decision 5): re-running is the recovery path.

CREATE TABLE IF NOT EXISTS vetting_challenges (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  "values" JSONB NOT NULL,
  nonce TEXT NOT NULL,
  expected_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  fetched_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ
);

-- The pruning cron deletes by expiry; agent_id serves the FK cascade and per-agent lookups.
CREATE INDEX IF NOT EXISTS idx_vetting_challenges_expires ON vetting_challenges(expires_at);
CREATE INDEX IF NOT EXISTS idx_vetting_challenges_agent ON vetting_challenges(agent_id);

-- Postconditions: the exact shapes the completion batch depends on, rolling the file back (and
-- recording nothing) if any is missing. `CREATE TABLE IF NOT EXISTS` is a no-op against a
-- pre-existing table, so identity and the replay invariant are asserted directly (M11-1b review
-- B5): the PRIMARY KEY on `id` (a non-unique id would break the challenge identity), the FK's
-- LOCAL column (`agent_id`) with ON DELETE CASCADE, and that `"values"` is JSONB.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'vetting_challenges'
      AND column_name = 'consumed_at' AND data_type = 'timestamp with time zone'
  ) THEN
    RAISE EXCEPTION 'C14 postcondition failed: vetting_challenges.consumed_at TIMESTAMPTZ is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = 'public.vetting_challenges'::regclass
      AND i.indisprimary
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
          = ARRAY['id']
  ) THEN
    RAISE EXCEPTION 'C14 postcondition failed: vetting_challenges primary key on (id) is missing';
  END IF;

  -- EVERY column's type, not a sample (review round 2, B4): a pre-existing table with
  -- `expires_at TEXT` or `nonce INTEGER` would pass a partial check and be recorded, then fail at
  -- runtime comparing textual expiry with NOW() or inserting a text nonce.
  IF (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'vetting_challenges'
      AND (column_name, data_type, is_nullable) IN (
        ('id', 'text', 'NO'),
        ('agent_id', 'text', 'NO'),
        ('values', 'jsonb', 'NO'),
        ('nonce', 'text', 'NO'),
        ('expected_hash', 'text', 'NO'),
        ('created_at', 'timestamp with time zone', 'NO'),
        ('expires_at', 'timestamp with time zone', 'NO'),
        ('fetched_at', 'timestamp with time zone', 'YES'),
        ('consumed_at', 'timestamp with time zone', 'YES')
      )
  ) <> 9 THEN
    RAISE EXCEPTION 'C14 postcondition failed: vetting_challenges columns do not match the required (name, type, nullability) set';
  END IF;

  -- Keys and validity, not just name plus owning table. A same-named index over the wrong column
  -- satisfies a name check while the pruning scan it exists for degrades to a sequential scan of
  -- the whole table, and an *invalid* index (a failed concurrent build) sits in the catalog
  -- looking present while the planner refuses to use it. Both indexes are asserted by their
  -- actual key column.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
    WHERE c.relname = 'idx_vetting_challenges_expires'
      AND i.indrelid = 'public.vetting_challenges'::regclass
      AND i.indisvalid
      AND NOT i.indisunique
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
          = ARRAY['expires_at']
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
    WHERE c.relname = 'idx_vetting_challenges_agent'
      AND i.indrelid = 'public.vetting_challenges'::regclass
      AND i.indisvalid
      AND NOT i.indisunique
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
          = ARRAY['agent_id']
  ) THEN
    RAISE EXCEPTION 'C14 postcondition failed: valid indexes idx_vetting_challenges_expires(expires_at) and idx_vetting_challenges_agent(agent_id) are missing or have the wrong keys';
  END IF;

  -- The exact FK shape: one column here, referencing agents(id), cascading. `= ANY (conkey)`
  -- would accept a composite key that merely contains agent_id, and nothing above checked WHICH
  -- agents column is referenced — either shape would be recorded as migrated and then reject
  -- every challenge insert at runtime.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.vetting_challenges'::regclass
      AND contype = 'f'
      AND confrelid = 'public.agents'::regclass
      AND confdeltype = 'c'
      AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                          WHERE attrelid = 'public.vetting_challenges'::regclass AND attname = 'agent_id')]
      AND confkey = ARRAY[(SELECT attnum FROM pg_attribute
                           WHERE attrelid = 'public.agents'::regclass AND attname = 'id')]
  ) THEN
    RAISE EXCEPTION 'C14 postcondition failed: single-column FK vetting_challenges.agent_id -> agents.id with ON DELETE CASCADE is missing';
  END IF;
END
$$;
