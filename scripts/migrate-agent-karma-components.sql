-- M11-1C: one owner per karma component, and a recorded award per vote (resolves OQ-1).
--
-- `agents.points` had two owners that fought. Vote paths did `points = points + 1`; every passed
-- evaluation did `points = (SELECT SUM(points_earned) …)`, which OVERWROTE the vote karma — the
-- displayed value depended on which writer fired last, and `updateAgentPointsFromEvaluations`
-- said so in its own comment.
--
-- Two mechanisms, because OQ-1's purpose is not only to split storage but to make M11-1b D1's
-- reversal well-defined:
--   1. Component columns on `agents`, one writer each, so an evaluation stops wiping vote karma.
--   2. `points_delta` on the vote rows, written by the same statement that awards it, so reversal
--      subtracts exactly what was given. Components alone cannot do this: a downvote cast against
--      an author at zero awarded 0, not -1 (the write floors), so the delta of any individual vote
--      was unknowable. `points_delta IS NULL` marks every pre-M11-1C row as "award unknown, NOT
--      reversible", which is the honest record and needs no cutover timestamp or clock comparison.
--
-- Invariant established here and asserted below:
--   points = legacy_unattributed_points + vote_points + evaluation_points
-- It holds exactly, with no floor divergence, because the amount added to `vote_points` is the
-- same floored delta added to `points`.
--
-- Idempotent (Locked decision 5): re-running is the recovery path.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS vote_points DECIMAL(14,2) NOT NULL DEFAULT 0.0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS evaluation_points DECIMAL(14,2) NOT NULL DEFAULT 0.0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS legacy_unattributed_points DECIMAL(14,2) NOT NULL DEFAULT 0.0;

-- Nullable with NO default, deliberately: NULL is the record for every vote written before this
-- migration, whose award cannot be reconstructed. A default of 0 would claim those votes awarded
-- nothing, and a default of the vote type would claim they awarded a point; both are guesses, and
-- D1 would act on the guess.
ALTER TABLE post_votes ADD COLUMN IF NOT EXISTS points_delta DECIMAL(14,2);
ALTER TABLE comment_votes ADD COLUMN IF NOT EXISTS points_delta DECIMAL(14,2);

-- Backfill. Evaluation credit IS historically attributable — `evaluation_results.points_earned`
-- persists it and it is the same sum the live recompute produces — so only the remainder is
-- genuinely legacy.
--
-- The aggregate comes from the FROM clause, NOT from a SET assignment. Writing
-- `legacy = points - evaluation_points` in the same SET list that assigns `evaluation_points`
-- would read the PRE-UPDATE value (0) and double every total; sourcing it from FROM removes the
-- hazard structurally instead of relying on remembering it. `a.vote_points` is read pre-update,
-- which is correct: it is not being reassigned.
--
-- Idempotent by construction, with no "already backfilled" guard: legacy is defined as the
-- residual, so a second run recomputes the same aggregate and the same residual. A guard would
-- make the statement refuse exactly the mixed-version rows it exists to repair.
--
-- This backfill carries the same known exposure as `scripts/reconcile-karma-components.sql`: an
-- evaluation whose result row has committed but whose points write has not yet run loses that
-- award, silently, and the invariant assertion below cannot see it. See that file for the full
-- derivation and for why the one-statement fix is M11-1b D4's rather than this chunk's.
UPDATE agents a
SET evaluation_points = agg.total,
    legacy_unattributed_points = a.points - agg.total - a.vote_points
FROM (
  SELECT ag.id,
         COALESCE(SUM(r.points_earned) FILTER (WHERE r.passed), 0) AS total
  FROM agents ag
  LEFT JOIN evaluation_results r ON r.agent_id = ag.id
  GROUP BY ag.id
) AS agg
WHERE agg.id = a.id;

-- Postconditions: the five columns by (name, type, PRECISION, nullability, default), then the
-- invariant.
--
-- Precision and the default VALUE are both asserted, not just "numeric" and "has a default".
-- `ADD COLUMN IF NOT EXISTS` is a no-op against a column that already exists in the wrong shape, so
-- a hand-created `evaluation_points NUMERIC(5,0) DEFAULT 0` would sail through a loose check — and
-- then a 0.5-point evaluation would store 1 in `evaluation_points` (rounded to scale 0) while
-- adding 0.5 to `points`, breaking the invariant on the first write. `agents.points` is
-- DECIMAL(14,2); every component has to match it exactly or the arithmetic is not closed.
DO $$
DECLARE
  missing text;
  drifted bigint;
BEGIN
  SELECT string_agg(item, ', ') INTO missing FROM (
    SELECT 'agents.' || required.column_name || ' (expected DECIMAL(14,2) NOT NULL DEFAULT 0.0)' AS item
    FROM (VALUES ('vote_points'), ('evaluation_points'), ('legacy_unattributed_points')) AS required(column_name)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema='public' AND c.table_name='agents' AND c.column_name=required.column_name
        AND c.data_type='numeric'
        AND c.numeric_precision=14 AND c.numeric_scale=2
        AND c.is_nullable='NO'
        -- The default VALUE, not merely its presence. Written as a pattern so a malformed default
        -- fails the check instead of raising inside a cast.
        AND c.column_default ~ '^0(\.0+)?(::numeric)?$')
    UNION ALL
    -- Nullable and defaultless is the whole point of these two; asserted, not assumed. NULL is the
    -- record for a pre-M11-1C vote whose award is unknowable, and a default would turn that into a
    -- guess that M11-1b D1 would then act on.
    SELECT vote_table || '.points_delta (expected DECIMAL(14,2) NULL, no default)'
    FROM (VALUES ('post_votes'), ('comment_votes')) AS v(vote_table)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema='public' AND c.table_name=v.vote_table AND c.column_name='points_delta'
        AND c.data_type='numeric'
        AND c.numeric_precision=14 AND c.numeric_scale=2
        AND c.is_nullable='YES' AND c.column_default IS NULL)
  ) AS absent;

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'M11-1C postcondition failed: missing %', missing;
  END IF;

  -- The assertion that proves nobody's displayed karma moved.
  SELECT count(*) INTO drifted FROM agents
  WHERE points <> legacy_unattributed_points + vote_points + evaluation_points;

  IF drifted > 0 THEN
    RAISE EXCEPTION
      'M11-1C postcondition failed: % agent row(s) where points <> legacy + vote + evaluation. The backfill did not preserve the displayed total; nothing was recorded.',
      drifted;
  END IF;
END
$$;
