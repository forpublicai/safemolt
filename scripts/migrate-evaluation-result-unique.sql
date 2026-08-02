-- M11-1 C21: one evaluation result per registration.
--
-- `evaluation_results.registration_id` carried only a plain index, and `saveEvaluationResult`
-- inserted unconditionally — so two concurrent completions of one registration produced two result
-- rows, and because `agents.points` is recomputed as SUM(points_earned) over passed rows, the
-- second row doubled the agent's points. The unique index below is the load-bearing change: with
-- it, the second insert raises 23505 no matter how the application races.
--
-- Repair before constraining, and the repair splits (PLAN_M11_1.md C21):
--   * Sets that are semantically identical on (agent_id, evaluation_id, passed, score,
--     points_earned, evaluation_version, school_id, proctor_agent_id) are auto-collapsed
--     keep-earliest — they carry the same verdict for the same agent and evaluation, so which row
--     survives is immaterial. `agent_id` and `evaluation_id` are in the tuple deliberately: the
--     pre-C2 tool wrote caller-chosen values for both straight through, so two rows on one
--     registration can disagree on WHO is credited or WHICH evaluation while agreeing on
--     everything else — and collapsing such a set could delete the legitimate row and leave the
--     forged credit standing.
--   * Sets that DISAGREE on any of those fields are never auto-resolved: keeping the earliest
--     could preserve a forged pass (the pre-C2 tool wrote caller-chosen verdicts straight through)
--     and discard the legitimate one, laundering the forgery into a permanent score. Such sets
--     raise here, the file records nothing, and a human decides (the one production set was
--     resolved by hand on 2026-07-27 — see ai/validation/m11-1-baseline-prod.md).
--   * Affected agents' points are recomputed after the collapse — deleting a surplus row without
--     re-running the sum would leave the inflated total in place, and the inflation is the damage.
--
-- Idempotent (Locked decision 5): re-running is the recovery path. Preflight wording avoids the
-- substrings the runner's dropped swallow filter used to match.

-- Writes race the repair-then-constrain sequence in this file, so hold them off for its duration
-- (the file runs as one implicit transaction; the lock releases at commit). Same shape C5 uses.
LOCK TABLE evaluation_results IN SHARE MODE;

-- Refuse before touching anything: a set that disagrees on the verdict fields has no safe
-- automatic resolution.
DO $$
DECLARE
  conflicting text;
BEGIN
  SELECT string_agg(registration_id, ', ' ORDER BY registration_id) INTO conflicting
  FROM (
    SELECT registration_id
    FROM evaluation_results
    GROUP BY registration_id
    HAVING count(*) > 1
       -- Every column a reader could tell two results apart by, not just the verdict fields.
       -- `result_data` holds the answers and the evidence: two rows can agree on pass/score and
       -- still be different submissions, and keep-earliest would destroy the other one with no
       -- archive. Widening this tuple only ever routes MORE sets to the human, never fewer.
       AND count(DISTINCT (agent_id, evaluation_id, passed, score, max_score, points_earned,
                           evaluation_version, COALESCE(school_id, 'foundation'),
                           proctor_agent_id, proctor_feedback, result_data)) > 1
  ) AS disagreeing;

  IF conflicting IS NOT NULL THEN
    RAISE EXCEPTION
      'C21: conflicting evaluation result sets for registration(s) %. No automatic rule is safe — resolve each by hand (PLAN_M11_1.md C21, ai/validation/m11-1-baseline-prod.md documents the shape) and re-run. Nothing was changed.',
      conflicting;
  END IF;
END
$$;

-- Collapse identical sets keep-earliest, sweep the removed rows' activity projections, and
-- recompute affected agents' points. The recompute is a separate statement inside the block —
-- an outer arm of the deleting statement would still see the pre-delete snapshot and sum the
-- rows it just removed.
DO $$
DECLARE
  affected text[];
BEGIN
  WITH ranked AS (
    SELECT id,
           row_number() OVER (PARTITION BY registration_id ORDER BY completed_at ASC, id ASC) AS position
    FROM evaluation_results
    WHERE registration_id IN (
      SELECT registration_id FROM evaluation_results
      GROUP BY registration_id HAVING count(*) > 1
    )
  ),
  removed AS (
    DELETE FROM evaluation_results r
    USING ranked
    WHERE r.id = ranked.id AND ranked.position > 1
    RETURNING r.id, r.agent_id
  ),
  swept_events AS (
    DELETE FROM activity_events e
    USING removed
    WHERE e.kind = 'evaluation_result' AND e.entity_id = removed.id
    RETURNING e.entity_id
  ),
  swept_contexts AS (
    DELETE FROM activity_contexts c
    USING removed
    WHERE c.activity_kind = 'evaluation_result' AND c.activity_id = removed.id
    RETURNING c.activity_id
  )
  SELECT array_agg(DISTINCT agent_id) INTO affected FROM removed;

  IF affected IS NOT NULL THEN
    UPDATE agents a
    SET points = (
      SELECT COALESCE(SUM(r.points_earned), 0)
      FROM evaluation_results r
      WHERE r.agent_id = a.id AND r.passed = true
    )
    WHERE a.id = ANY (affected);
  END IF;
END
$$;

-- `CREATE UNIQUE INDEX IF NOT EXISTS` matches on **name alone**: a same-named partial or
-- non-unique index would be silently kept and this file would record success while registrations
-- stayed unconstrained. So the guard reads the catalog — unique, valid, unpredicated, keyed on
-- exactly (registration_id) — and raises on any same-named index of the wrong shape.
DO $$
DECLARE
  idx record;
BEGIN
  SELECT i.indisunique, i.indisvalid, i.indpred IS NOT NULL AS partial,
         (SELECT array_agg(a.attname::text ORDER BY k.ord)
          FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS keys
    INTO idx
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_index i ON i.indexrelid = c.oid
  WHERE n.nspname = 'public' AND c.relname = 'idx_eval_results_registration_uniq'
    AND i.indrelid = 'public.evaluation_results'::regclass;

  IF NOT FOUND THEN
    RETURN; -- absent; the CREATE below makes it
  END IF;

  IF NOT idx.indisunique OR NOT idx.indisvalid OR idx.partial
     OR idx.keys IS DISTINCT FROM ARRAY['registration_id'] THEN
    RAISE EXCEPTION
      'C21: index idx_eval_results_registration_uniq has the wrong shape (unique=%, valid=%, partial=%, keys=%). Drop it and re-run.',
      idx.indisunique, idx.indisvalid, idx.partial, idx.keys;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_eval_results_registration_uniq
  ON evaluation_results (registration_id);

-- The plain single-column index is fully covered by the unique one; keeping both would just be a
-- second structure to maintain on every write. Dropped after the unique index exists, never
-- before, so there is no window with neither.
DROP INDEX IF EXISTS idx_eval_results_registration;

-- Postcondition: the same four catalog properties the guard requires. A clean exit above does not
-- prove the index exists (the guard returns early when the name is absent), so it is asserted
-- here explicitly.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE n.nspname = 'public' AND c.relname = 'idx_eval_results_registration_uniq'
      AND i.indrelid = 'public.evaluation_results'::regclass
      AND i.indisunique AND i.indisvalid AND i.indpred IS NULL
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
          = ARRAY['registration_id']
  ) THEN
    RAISE EXCEPTION 'C21 postcondition failed: unique, valid, unpredicated index idx_eval_results_registration_uniq on exactly (registration_id) is missing';
  END IF;
END
$$;
