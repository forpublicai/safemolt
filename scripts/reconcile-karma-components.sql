-- M11-1C runbook step — reconcile agent karma components after a mixed-version window.
--
-- This is the SAME statement `scripts/migrate-agent-karma-components.sql` runs, extracted so it
-- can be run again by hand. It is here because the migration's own copy CANNOT cover the window
-- it opens: `scripts/migrate.js` records the filename and never reads that file again, so the
-- backfill inside it reconciles the database as it stood at commit time and nothing after.
--
-- Migrations run BEFORE `next build` (`"build": "node scripts/migrate.js && next build"`), so old
-- instances are still serving while the columns land. An old instance writes `points` directly and
-- knows nothing about the components. Because `points` is delta-maintained and never re-derived,
-- that write survives; running this statement afterwards ABSORBS it into
-- `legacy_unattributed_points` instead of losing it.
--
-- Sequencing:
--   1. Deploy N: the migration adds the columns and backfills.
--   2. Old instances drain.
--   3. Run this file.
--
-- Step 3 may instead be appended to `MIGRATION_FILES` as its own file in a later deploy, which
-- automates it: by the time deploy N+1 runs, deploy N's instances have drained. Either route is
-- correct. What is NOT correct is assuming the migration's own backfill covers the window.
--
-- Run it also after re-running by hand any migration that writes `agents.points` directly —
-- `migrate-evaluation-points.sql`, `migrate-verified-agents-evaluations.sql`, or
-- `migrate-evaluation-result-unique.sql`'s repair — and after any manual operator write to
-- `agents.points`. Those are the same class of event as an old instance's write, and this repairs
-- them the same way.
--
-- ONE LOSS IN THAT WINDOW IS NOT RECOVERABLE, and it is stated rather than glossed. Old evaluation
-- code is an ABSOLUTE overwrite (`points = SUM(points_earned)`), not a delta. An evaluation
-- completing on an old instance after the backfill overwrites `points` and destroys any vote karma
-- componentised since; this statement then treats the damaged `points` as authoritative and
-- preserves it. No formula can recover the overwritten value. The mitigation is that the window is
-- the gap between `migrate.js` finishing and the new build serving, and that this should be run as
-- soon as it closes.
--
-- Idempotent, with no "already reconciled" guard: `legacy_unattributed_points` is defined as the
-- residual, so a second run recomputes the same aggregate and the same residual. A guard would make
-- the statement refuse exactly the mixed-version rows it exists to repair.
--
-- ============================================================================================
-- KNOWN EXPOSURE — an evaluation completing WHILE this runs can lose its award. Read before use.
-- ============================================================================================
--
-- `saveEvaluationResult` is two statements, and they auto-commit separately: the result row is
-- inserted first, then `updateAgentPointsFromEvaluations` moves `points` by
-- `(aggregate total - evaluation_points)`. If this file runs in the gap between them, for that
-- agent:
--
--   start        points=P  vote=V  eval=E  legacy=L        (P = L + V + E)
--   result of N inserted and COMMITTED                     (points still P)
--   this file    eval := E+N, legacy := P - (E+N) - V = L-N   (invariant still holds)
--   recompute    delta = (E+N) - (E+N) = 0                 -> points stays P
--
-- The agent never receives the N points, the invariant stays intact, and the migration/reconcile
-- postcondition therefore does NOT fire. Re-running this file does not repair it: `points` is
-- authoritative here by design, and the value that should have been added is not recorded anywhere.
--
-- The window is one round trip per completing evaluation (~100 ms), so the exposure is bounded by
-- evaluation throughput at the moment this runs. Run it when evaluation traffic is quiet.
--
-- WHY THIS IS NOT FIXED HERE. The fix is to make the result insert and its award ONE statement, the
-- way the vote paths do. That was written and rejected for this chunk: `insertResultGatedOnTransition`
-- already holds a row lock on `evaluation_registrations`, so adding an `agents` lock to it produces
-- the order `evaluation_registrations -> agents`, while M11-1 C14's vetting batch takes
-- `agents -> evaluation_registrations`. Those two inverted orders deadlock (40P01) whenever a
-- bootstrap evaluation completes concurrently with vetting, and C14 retries only 23505 — so closing
-- a ~100 ms reconciliation race would have put a deadlock into the vetting path. Fixing it properly
-- means ordering both writers consistently, which is M11-1b D4's work (it already opens the
-- evaluation writer for its `FOR UPDATE` serialisation). Recorded here so the one-statement version
-- is not reproposed without the lock-ordering half.
--
-- CORRECTION, and D4 must carry it: that inversion is NOT hypothetical and adding an explicit
-- `agents` lock is not what would create it. It EXISTS TODAY, through an implicit lock rather than
-- a written one. `insertResultGatedOnTransition` updates `evaluation_registrations` and then
-- inserts `evaluation_results`, whose `agent_id` FK makes Postgres take `FOR KEY SHARE` on the
-- agent row — so that path already runs `evaluation_registrations -> agents`. C14's vetting batch
-- opens with `SELECT ... FROM agents ... FOR UPDATE`, and `FOR UPDATE` conflicts with
-- `FOR KEY SHARE`. A vetting run and an ordinary completion for the SAME agent can therefore
-- deadlock right now: vetting holds the agent row and waits for the registration, the completion
-- holds the registration and waits for the agent row. Neither path classifies 40P01, so one
-- request 500s.
--
-- This predates M11-1C — the vetting batch's `FOR UPDATE` is unchanged by this chunk and the FK has
-- always been there — so it is a defect to fix, not a regression to revert. It is recorded here
-- because D4 is the chunk that must order these two writers consistently, and because the
-- paragraph above previously implied today's code was clean.

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

-- The assertion that proves nobody's displayed karma moved. Same postcondition as the migration's.
DO $$
DECLARE
  drifted bigint;
BEGIN
  SELECT count(*) INTO drifted FROM agents
  WHERE points <> legacy_unattributed_points + vote_points + evaluation_points;

  IF drifted > 0 THEN
    RAISE EXCEPTION
      'M11-1C reconciliation failed: % agent row(s) where points <> legacy + vote + evaluation.',
      drifted;
  END IF;
END
$$;
