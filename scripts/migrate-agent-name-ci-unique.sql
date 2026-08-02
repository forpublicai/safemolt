-- M11-1 C5: case-insensitive uniqueness for agent names.
--
-- `agents.name` was only case-sensitively unique and `idx_agents_name_lower` was a plain index,
-- so `Foo` and `foo` could coexist — and `getAgentByName`'s `LOWER(name) = LOWER($1) LIMIT 1`
-- resolved one of them arbitrarily, disclosing content and notifications to the wrong agent.
-- This file promotes the index to UNIQUE so the 23505 the register route already handles covers
-- case-fold duplicates too.
--
-- The file runs as one implicit transaction. The SHARE lock is held to commit, so a registration
-- cannot insert a case-fold collision between the preflight and the index build; concurrent
-- inserts block and land after the unique index exists (23505 → the friendly name-taken error).
--
-- Idempotent (Locked decision 5): re-running is the recovery path. The preflight wording avoids
-- the substrings the runner's dropped swallow filter used to match — belt and braces.

LOCK TABLE agents IN SHARE MODE;

-- Refuse before touching anything: a case-fold collision has no safe automatic resolution
-- (either agent may own content, credentials, and followers under the colliding name).
DO $$
DECLARE
  colliding text;
BEGIN
  SELECT string_agg(folded || ' (' || cnt || ' rows)', ', ' ORDER BY folded) INTO colliding
  FROM (
    SELECT LOWER(name) AS folded, count(*) AS cnt
    FROM agents
    GROUP BY LOWER(name)
    HAVING count(*) > 1
  ) AS collisions;

  IF colliding IS NOT NULL THEN
    RAISE EXCEPTION
      'C5: case-fold name collision(s): %. No automatic rule is safe — resolve each set by hand (rename or release all but one) and re-run. Nothing was changed.',
      colliding;
  END IF;
END
$$;

-- The index name must not be squatted by an index on another table: DROP INDEX goes by name
-- alone, so dropping a squatter and rebuilding on agents would silently strip that other table
-- of an index it presumably needs (round-7 lesson: pin indrelid before any DROP).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE n.nspname = 'public' AND c.relname = 'idx_agents_name_lower'
      AND i.indrelid <> 'public.agents'::regclass
  ) THEN
    RAISE EXCEPTION
      'C5: an index named idx_agents_name_lower exists on a table other than agents. Investigate before re-running. Nothing was changed.';
  END IF;
END
$$;

DROP INDEX IF EXISTS idx_agents_name_lower;
CREATE UNIQUE INDEX idx_agents_name_lower ON agents (LOWER(name));

-- Postcondition: unique, valid, on agents, over exactly lower(name) — deparse probed empirically
-- (exact string equality, not a regex over indexdef, which is spoofable).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE n.nspname = 'public' AND c.relname = 'idx_agents_name_lower'
      AND i.indrelid = 'public.agents'::regclass
      AND i.indisunique AND i.indisvalid
      AND pg_get_expr(i.indexprs, i.indrelid) = 'lower(name)'
      AND i.indpred IS NULL
  ) THEN
    RAISE EXCEPTION 'C5 postcondition failed: unique, valid index idx_agents_name_lower on agents (lower(name)) is missing';
  END IF;
END
$$;
