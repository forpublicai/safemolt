-- M11-1b D5: durable playground episodic memories.
--
-- `src/lib/playground/memory.ts` kept per-agent episodic memories in a process-local Map **even in
-- DB mode**: round resolution wrote them, the engine read them for retrieval, and the public
-- session response advertised whether they were available — so a later request served by another
-- instance, or one arriving after a cold start, saw them silently vanish.
--
-- The shape is M11-2's P7.2 design lifted verbatim, and it preserves today's semantics exactly:
-- ONE record per (agent, session), overwritten each round — which is why (agent_id, session_id) is
-- the primary key rather than a surrogate. `importance` stores the existing
-- `low | medium | high | critical` label as text.
--
-- Both FKs cascade: an agent or a session going away must not strand memory rows. Session
-- CANCELLATION is a status transition since M11-1 C3, so the cascade does NOT fire on it —
-- cleanup there is driven explicitly by the transition, in both stores.
--
-- Idempotent (Locked decision 5): re-running is the recovery path.

CREATE TABLE IF NOT EXISTS playground_agent_memories (
  id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES playground_sessions(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  importance TEXT NOT NULL,
  round_created INT,
  embedding JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (agent_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_pg_agent_memories_session ON playground_agent_memories(session_id);

-- Postconditions: every column's (name, type, nullability), the composite primary key, and both
-- cascading FKs with their local columns — `CREATE TABLE IF NOT EXISTS` is a no-op against a
-- pre-existing table, so name-only checks would record a malformed one as migrated.
DO $$
BEGIN
  IF (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'playground_agent_memories'
      AND (column_name, data_type, is_nullable) IN (
        ('id', 'text', 'NO'),
        ('agent_id', 'text', 'NO'),
        ('agent_name', 'text', 'NO'),
        ('session_id', 'text', 'NO'),
        ('content', 'text', 'NO'),
        ('importance', 'text', 'NO'),
        ('round_created', 'integer', 'YES'),
        ('embedding', 'jsonb', 'YES'),
        ('created_at', 'timestamp with time zone', 'NO')
      )
  ) <> 9 THEN
    RAISE EXCEPTION 'D5 postcondition failed: playground_agent_memories columns do not match the required (name, type, nullability) set';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = 'public.playground_agent_memories'::regclass
      AND i.indisprimary
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
          = ARRAY['agent_id', 'session_id']
  ) THEN
    RAISE EXCEPTION 'D5 postcondition failed: playground_agent_memories primary key (agent_id, session_id) is missing';
  END IF;

  -- Exact shape for both: one local column, referencing the parent's own `id`, cascading.
  -- `= ANY (conkey)` accepts a composite key that merely contains the column, and nothing here
  -- checked WHICH parent column is referenced — an `agent_id -> agents(api_key)` FK would satisfy
  -- a looser check, be recorded as migrated, and then reject every ordinary insert, because the
  -- value written is an agent id and no api_key equals it.
  IF (
    SELECT count(*) FROM pg_constraint
    WHERE conrelid = 'public.playground_agent_memories'::regclass
      AND contype = 'f' AND confdeltype = 'c'
      AND ((confrelid = 'public.agents'::regclass
            AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                                WHERE attrelid = 'public.playground_agent_memories'::regclass
                                  AND attname = 'agent_id')]
            AND confkey = ARRAY[(SELECT attnum FROM pg_attribute
                                 WHERE attrelid = 'public.agents'::regclass AND attname = 'id')])
        OR (confrelid = 'public.playground_sessions'::regclass
            AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                                WHERE attrelid = 'public.playground_agent_memories'::regclass
                                  AND attname = 'session_id')]
            AND confkey = ARRAY[(SELECT attnum FROM pg_attribute
                                 WHERE attrelid = 'public.playground_sessions'::regclass
                                   AND attname = 'id')]))
  ) <> 2 THEN
    RAISE EXCEPTION 'D5 postcondition failed: single-column cascading FKs playground_agent_memories.agent_id -> agents.id and .session_id -> playground_sessions.id are missing or malformed';
  END IF;

  -- The session index is load-bearing, not decorative: `listPlaygroundMemoriesForSession` and the
  -- cancellation sweep both filter on `session_id`. `CREATE INDEX IF NOT EXISTS` matches on name
  -- alone and index names are unique per *schema*, so a same-named index on any other relation
  -- makes the create a silent no-op while this migration records success. Pinned to this table,
  -- to this column, and asserted valid — an invalid index (a failed concurrent build) is present
  -- in the catalog but is not used by the planner.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relname = 'idx_pg_agent_memories_session'
      AND i.indrelid = 'public.playground_agent_memories'::regclass
      AND i.indisvalid
      AND NOT i.indisunique
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
          = ARRAY['session_id']
  ) THEN
    RAISE EXCEPTION 'D5 postcondition failed: valid index idx_pg_agent_memories_session(session_id) on playground_agent_memories is missing (a same-named index on another relation makes CREATE INDEX IF NOT EXISTS skip)';
  END IF;
END
$$;
