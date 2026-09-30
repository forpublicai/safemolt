-- M11-1 C22: one live certification job per registration, and a judging lease the paid call is
-- gated on.
--
-- `POST /evaluations/{id}/start` rejected only terminal registrations and then created a fresh
-- job with a fresh nonce on every call, and `certification_jobs` had no uniqueness over live
-- jobs — so one agent looping `start` accumulated unbounded future judging spend. The judge was
-- separately check-then-act around the paid model call, so two dispatchers reaching one job both
-- billed. The partial unique index below closes the accumulation; the two lease columns carry the
-- claim that makes `submitted → judging` a CAS and fences every terminal write.
--
-- Repair before constraining (C0 report 10: three registrations with 5/3/2 pending jobs at the
-- production baseline): keep the earliest live job per registration, expire the rest. Keeping the
-- earliest is safe here in a way C21's result repair was not — a job carries no verdict, only a
-- nonce; the survivor is simply the attempt `start` now returns, and a survivor whose nonce has
-- lapsed is expired-and-replaced by `start` itself on the next call.
--
-- Idempotent (Locked decision 5): re-running is the recovery path. Wording avoids the substrings
-- the runner's dropped swallow filter used to match.

LOCK TABLE certification_jobs IN SHARE MODE;

ALTER TABLE certification_jobs ADD COLUMN IF NOT EXISTS judge_token TEXT;
ALTER TABLE certification_jobs ADD COLUMN IF NOT EXISTS judge_claim_expires_at TIMESTAMPTZ;

-- Keep-earliest repair: every live job per registration except the first (by created_at, then id)
-- becomes 'expired'. Deterministic and idempotent — re-running over repaired data matches nothing.
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY registration_id ORDER BY created_at ASC, id ASC) AS position
  FROM certification_jobs
  WHERE status IN ('pending', 'submitted', 'judging')
    AND registration_id IN (
      SELECT registration_id FROM certification_jobs
      WHERE status IN ('pending', 'submitted', 'judging')
      GROUP BY registration_id HAVING count(*) > 1
    )
)
UPDATE certification_jobs j
SET status = 'expired'
FROM ranked
WHERE j.id = ranked.id AND ranked.position > 1;

-- Belt-and-braces before the index: if the repair above ever regresses, fail here with the
-- registrations named rather than letting CREATE UNIQUE INDEX raise something opaque.
DO $$
DECLARE
  unresolved text;
BEGIN
  SELECT string_agg(registration_id, ', ' ORDER BY registration_id) INTO unresolved
  FROM (
    SELECT registration_id FROM certification_jobs
    WHERE status IN ('pending', 'submitted', 'judging')
    GROUP BY registration_id HAVING count(*) > 1
  ) AS remaining;

  IF unresolved IS NOT NULL THEN
    RAISE EXCEPTION
      'C22: registration(s) % still carry more than one live certification job after the repair. Investigate and re-run; nothing was recorded.',
      unresolved;
  END IF;
END
$$;

-- `CREATE UNIQUE INDEX IF NOT EXISTS` matches on **name alone**: a same-named index that is
-- non-unique, invalid, keyed differently, or predicated differently would be silently kept and
-- this file would record success while live jobs stayed unconstrained. The guard reads the
-- catalog; the predicate is compared against the canonical text Postgres itself renders for the
-- CREATE below (`pg_get_expr` output is deparse-canonical, so equality is exact, not a regex).
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
  WHERE n.nspname = 'public' AND c.relname = 'idx_cert_jobs_live_registration'
    AND i.indrelid = 'public.certification_jobs'::regclass;

  IF NOT FOUND THEN
    RETURN; -- absent; the CREATE below makes it
  END IF;

  IF NOT idx.indisunique OR NOT idx.indisvalid
     OR idx.keys IS DISTINCT FROM ARRAY['registration_id']
     OR idx.predicate IS DISTINCT FROM
        '(status = ANY (ARRAY[''pending''::text, ''submitted''::text, ''judging''::text]))' THEN
    RAISE EXCEPTION
      'C22: index idx_cert_jobs_live_registration has the wrong shape (unique=%, valid=%, keys=%, predicate=%). Drop it and re-run.',
      idx.indisunique, idx.indisvalid, idx.keys, idx.predicate;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cert_jobs_live_registration
  ON certification_jobs (registration_id)
  WHERE status IN ('pending', 'submitted', 'judging');

-- Postconditions: the two columns with their exact types, and the index with the same four
-- properties the guard requires — asserted because the guard returns early when the name is
-- absent, so a clean exit above does not prove existence.
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(item, ', ') INTO missing FROM (
    SELECT 'certification_jobs.judge_token (text, nullable, no default)' AS item
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'certification_jobs'
        AND column_name = 'judge_token' AND data_type = 'text' AND is_nullable = 'YES' AND column_default IS NULL
    )
    UNION ALL
    -- Nullable with no default on both: NULL is "no judge holds this job". A NOT NULL or defaulted
    -- column would make the unclaimed state unrepresentable, so the CAS lease could never be taken
    -- and completion could never release it.
    SELECT 'certification_jobs.judge_claim_expires_at (timestamptz, nullable, no default)'
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'certification_jobs'
        AND column_name = 'judge_claim_expires_at'
        AND data_type = 'timestamp with time zone' AND is_nullable = 'YES'
        AND column_default IS NULL
    )
    UNION ALL
    SELECT 'unique, valid partial index idx_cert_jobs_live_registration on (registration_id) over live statuses'
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_index i ON i.indexrelid = c.oid
      WHERE n.nspname = 'public' AND c.relname = 'idx_cert_jobs_live_registration'
        AND i.indrelid = 'public.certification_jobs'::regclass
        AND i.indisunique AND i.indisvalid
        AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
             FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
            = ARRAY['registration_id']
        AND pg_get_expr(i.indpred, i.indrelid) =
            '(status = ANY (ARRAY[''pending''::text, ''submitted''::text, ''judging''::text]))'
    )
  ) AS absent;

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'C22 postcondition failed: missing %', missing;
  END IF;
END
$$;
