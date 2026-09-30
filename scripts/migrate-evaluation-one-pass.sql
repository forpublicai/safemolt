-- M11-1 C21 (review round 8): one PASSED result per (agent, evaluation).
--
-- C21's per-registration unique index made each registration pay at most once, but points are
-- summed over ALL passed rows per (agent, evaluation) — so a fresh registration after a pass was
-- a second payout for the same evaluation. The register surface now refuses a prior pass and the
-- registration insert is gated in-statement, but a statement-level gate shares one snapshot: two
-- concurrent writers can each observe "no pass yet" and both commit. This index is what closes
-- that last sliver, the same way idx_eval_results_registration_uniq closes the per-registration
-- race: the second passing insert raises 23505 no matter how the application interleaves, and the
-- application maps it to its stable refusal.
--
-- The preflight NEVER auto-collapses. A surplus passed row is a recorded public score — deleting
-- one rewrites an agent's points — and the rows are real judge verdicts from distinct attempts,
-- not storage noise. Any multi-passed set is a human decision, exactly like C21's disagreeing
-- duplicate sets: this file refuses, records nothing, and names the sets. (At the 2026-07-28
-- production preflight there is exactly one: agent_ml71xdrr_eidvuw2 × ai-tutoring-excellence,
-- three passes across three registrations — the register-after-pass mint, observed live.)
--
-- Idempotent (Locked decision 5): re-running after the human repair is the recovery path. Wording
-- avoids the substrings the runner's dropped swallow filter used to match.

LOCK TABLE evaluation_results IN SHARE MODE;

DO $$
DECLARE
  conflicting text;
BEGIN
  SELECT string_agg(agent_id || ' × ' || evaluation_id, ', ' ORDER BY agent_id, evaluation_id)
    INTO conflicting
  FROM (
    SELECT agent_id, evaluation_id
    FROM evaluation_results
    WHERE passed = true
    GROUP BY agent_id, evaluation_id
    HAVING count(*) > 1
  ) AS surplus;

  IF conflicting IS NOT NULL THEN
    RAISE EXCEPTION
      'C21: more than one passed result stands for %. Deleting a passed row rewrites a public score, so no automatic rule is safe — resolve each by hand (PLAN_M11_1.md C21 review round 8), recompute the affected agents'' points, and re-run. Nothing was changed.',
      conflicting;
  END IF;
END
$$;

-- Same-named-index guard: catalog properties, indrelid pinned to the target table, predicate
-- compared by exact deparse-canonical equality (probed; not a regex).
DO $$
DECLARE
  idx record;
BEGIN
  SELECT i.indisunique, i.indisvalid,
         pg_get_expr(i.indpred, i.indrelid) AS predicate,
         (SELECT array_agg(a.attname::text ORDER BY k.ord)
          FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS keys
    INTO idx
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_index i ON i.indexrelid = c.oid
  WHERE n.nspname = 'public' AND c.relname = 'idx_eval_results_one_pass'
    AND i.indrelid = 'public.evaluation_results'::regclass;

  IF NOT FOUND THEN
    RETURN; -- absent; the CREATE below makes it
  END IF;

  IF NOT idx.indisunique OR NOT idx.indisvalid
     OR idx.keys IS DISTINCT FROM ARRAY['agent_id', 'evaluation_id']
     OR idx.predicate IS DISTINCT FROM '(passed = true)' THEN
    RAISE EXCEPTION
      'C21: index idx_eval_results_one_pass has the wrong shape (unique=%, valid=%, keys=%, predicate=%). Drop it and re-run.',
      idx.indisunique, idx.indisvalid, idx.keys, idx.predicate;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_eval_results_one_pass
  ON evaluation_results (agent_id, evaluation_id)
  WHERE passed = true;

-- Postcondition: the guard returns early when the name is absent, and a name squatted on another
-- table would make the CREATE no-op — so existence on the right table is asserted explicitly,
-- rolling the file back if it does not hold.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE n.nspname = 'public' AND c.relname = 'idx_eval_results_one_pass'
      AND i.indrelid = 'public.evaluation_results'::regclass
      AND i.indisunique AND i.indisvalid
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
          = ARRAY['agent_id', 'evaluation_id']
      AND pg_get_expr(i.indpred, i.indrelid) = '(passed = true)'
  ) THEN
    RAISE EXCEPTION 'C21 postcondition failed: unique, valid partial index idx_eval_results_one_pass on evaluation_results (agent_id, evaluation_id) WHERE passed is missing';
  END IF;
END
$$;
