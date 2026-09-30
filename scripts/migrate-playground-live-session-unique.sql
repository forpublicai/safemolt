-- M11-1 C23: at most one live playground session per school, enforced by the database.
--
-- createPendingSession asked "is there already a live session?" in two separate queries and
-- inserted later, so concurrent triggers all observed "none" and all inserted — several
-- simultaneous live sessions per school, each drawing participants and billing GM inference.
-- The partial unique index below is the constraint the guard pretended to be. It is built on
-- COALESCE(school_id, 'foundation') because the column is nullable with a 'foundation' default:
-- a bare index would let a NULL row and a 'foundation' row coexist — the same bug with extra
-- steps.
--
-- Existing multi-live-session schools are repaired first, keep-earliest (C0 report 14 was empty
-- on production 2026-07-27; this in-file repair covers other environments and re-runs). The
-- surplus moves to 'cancelled' through C3's system-repair transition — cancelled_by_agent_id NULL
-- plus a stable repair reason, NEVER attributed to an agent: a migration has no truthful agent to
-- name, and fabricating one would poison the very column C3 exists to make trustworthy.
--
-- Idempotent (Locked decision 5): re-running is the recovery path. If rows still collide after
-- the repair, the CREATE UNIQUE INDEX fails loudly and the runner records nothing.

WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY COALESCE(school_id, 'foundation')
    ORDER BY created_at ASC, id ASC
  ) AS rn
  FROM playground_sessions
  WHERE status IN ('pending', 'active')
)
UPDATE playground_sessions
SET status = 'cancelled',
    cancelled_at = NOW(),
    cancelled_by_agent_id = NULL,
    cancelled_reason = 'system: repair - duplicate live session'
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_sessions_one_live_per_school
  ON playground_sessions ((COALESCE(school_id, 'foundation')))
  WHERE status IN ('pending', 'active');

-- Postconditions: unique, valid, partial, on the right table, over exactly the coalesced school
-- expression with exactly the live-status predicate — both deparses probed empirically and
-- compared by exact string equality (a regex over indexdef is the spoofable shape C2 warned about).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE n.nspname = 'public' AND c.relname = 'idx_pg_sessions_one_live_per_school'
      AND i.indrelid = 'public.playground_sessions'::regclass
      AND i.indisunique AND i.indisvalid
      AND pg_get_expr(i.indexprs, i.indrelid) = 'COALESCE(school_id, ''foundation''::text)'
      AND pg_get_expr(i.indpred, i.indrelid) = '(status = ANY (ARRAY[''pending''::text, ''active''::text]))'
  ) THEN
    RAISE EXCEPTION 'C23 postcondition failed: partial unique index idx_pg_sessions_one_live_per_school is missing or mis-shaped';
  END IF;
END
$$;
