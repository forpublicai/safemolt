-- M11-1b D4, part 4 — DEPLOY 1 of 3 (EXPAND): school becomes part of an evaluation's identity.
--
-- The corruption this starts to close: `evaluation_definitions.id` is a GLOBAL primary key, and
-- `src/lib/evaluations/sync.ts` upserts `ON CONFLICT (id)` while overwriting `school_id`. Both
-- Foundation and Humanities ship the persisted `evaluation_id` `twitter-verification`
-- (schools/foundation/evaluations/SIP-4.md, schools/humanities/evaluations/SIP-4.md — "SIP-4" is
-- the human file label, not the id that collides), so whichever school syncs last wins and the
-- other school's definition CEASES TO EXIST in the database. A test built on the filesystem loader
-- would pass while the database is corrupt.
--
-- **`sip_number` is a SECOND global uniqueness, and the plan did not name it.** Those same two
-- files both carry `sip: 4`. Today no violation is raised only because the id conflict fires first
-- and updates in place; the moment two same-id rows are allowed to coexist, `sip_number INTEGER
-- UNIQUE` would reject the second one with 23505. Scoping it to the school here is therefore not
-- tidying — without it, deploy 3 cannot succeed.
--
-- WHAT THIS DEPLOY DOES, AND DELIBERATELY DOES NOT DO.
-- Migrations run BEFORE the new build (package.json's `build` script), so while this migration is
-- applying, every instance still running is the OLD one, still doing `ON CONFLICT (id)` with
-- unscoped prerequisite deletes. Dropping global `id` uniqueness in the same deploy would break
-- them instantly. So this deploy only EXPANDS:
--   * backfill `school_id`, then make it NOT NULL — the composite key cannot be built over NULLs;
--   * add `UNIQUE (school_id, id)` ALONGSIDE the existing primary key;
--   * replace the global `UNIQUE (sip_number)` with `UNIQUE (school_id, sip_number)`.
-- Same-id cross-school rows are still impossible after this, because `id TEXT PRIMARY KEY` still
-- stands and a table cannot carry two primary keys. That is expected: deploy 2 ships school-aware
-- dual reads/writes, old instances drain, and only then does deploy 3 replace every dependent FK
-- (evaluation_prerequisites, evaluation_registrations, evaluation_results, evaluation_participants,
-- certification jobs, evaluation_sessions, ao_company_evaluations) and drop or promote the old key.
--
-- Idempotent (Locked decision 5): re-running is the recovery path. It fails LOUDLY and records
-- nothing if the data cannot support the new constraints, because choosing which of two colliding
-- definitions to discard is a decision for a human.

-- 1. Backfill. `school_id` was added by migrate-schools.sql with a 'foundation' default, but rows
--    written before that column existed can still hold NULL.
UPDATE evaluation_definitions SET school_id = 'foundation' WHERE school_id IS NULL;

ALTER TABLE evaluation_definitions ALTER COLUMN school_id SET NOT NULL;
ALTER TABLE evaluation_definitions ALTER COLUMN school_id SET DEFAULT 'foundation';

-- 2. Preflight, before any constraint is built: a collision inside ONE school is a real duplicate
--    and no scoping can resolve it.
DO $$
DECLARE
  collisions TEXT;
BEGIN
  SELECT string_agg(school_id || '/' || id, ', ' ORDER BY school_id, id) INTO collisions
  FROM (SELECT school_id, id FROM evaluation_definitions GROUP BY school_id, id HAVING count(*) > 1) d;
  IF collisions IS NOT NULL THEN
    RAISE EXCEPTION 'D4 preflight failed: duplicate (school_id, id) definitions — %. Nothing recorded.', collisions;
  END IF;

  SELECT string_agg(school_id || '/sip ' || sip_number, ', ' ORDER BY school_id, sip_number) INTO collisions
  FROM (SELECT school_id, sip_number FROM evaluation_definitions GROUP BY school_id, sip_number HAVING count(*) > 1) d;
  IF collisions IS NOT NULL THEN
    RAISE EXCEPTION 'D4 preflight failed: duplicate (school_id, sip_number) definitions — %. Nothing recorded.', collisions;
  END IF;
END $$;

-- 3. The composite identity, alongside the existing primary key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_eval_def_school_id ON evaluation_definitions (school_id, id);

-- 4. SIP numbers become school-scoped. The old constraint is dropped only AFTER its replacement
--    exists, so no window leaves the table unprotected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_eval_def_school_sip ON evaluation_definitions (school_id, sip_number);

DO $$
DECLARE
  global_sip_constraint TEXT;
BEGIN
  -- Named constraints and bare unique indexes are dropped differently, and the name Postgres chose
  -- for the inline `sip_number INTEGER UNIQUE` depends on how the table was created. Find it by
  -- SHAPE — unique, one column, that column — rather than by guessing a name.
  SELECT c.conname INTO global_sip_constraint
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'evaluation_definitions'
    AND c.contype = 'u'
    AND array_length(c.conkey, 1) = 1
    AND c.conkey[1] = (SELECT attnum FROM pg_attribute WHERE attrelid = t.oid AND attname = 'sip_number')
  LIMIT 1;

  IF global_sip_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE evaluation_definitions DROP CONSTRAINT %I', global_sip_constraint);
  END IF;
END $$;

-- Postconditions. `CREATE UNIQUE INDEX IF NOT EXISTS` is a no-op against an index that merely
-- shares the name, so each is checked by shape: unique, and keyed on exactly these columns.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'evaluation_definitions'
      AND column_name = 'school_id' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'D4 postcondition failed: evaluation_definitions.school_id is still nullable';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    WHERE c.relname = 'idx_eval_def_school_id' AND t.relname = 'evaluation_definitions' AND i.indisunique
      AND (SELECT array_agg(attname::text ORDER BY attname) FROM pg_attribute
            WHERE attrelid = t.oid AND attnum = ANY (i.indkey)) = ARRAY['id', 'school_id']
  ) THEN
    RAISE EXCEPTION 'D4 postcondition failed: unique (school_id, id) is missing or malformed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    WHERE c.relname = 'idx_eval_def_school_sip' AND t.relname = 'evaluation_definitions' AND i.indisunique
      AND (SELECT array_agg(attname::text ORDER BY attname) FROM pg_attribute
            WHERE attrelid = t.oid AND attnum = ANY (i.indkey)) = ARRAY['school_id', 'sip_number']
  ) THEN
    RAISE EXCEPTION 'D4 postcondition failed: unique (school_id, sip_number) is missing or malformed';
  END IF;

  -- The global one must be GONE, or two schools can never both ship SIP 4.
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'evaluation_definitions' AND c.contype = 'u'
      AND array_length(c.conkey, 1) = 1
      AND c.conkey[1] = (SELECT attnum FROM pg_attribute WHERE attrelid = t.oid AND attname = 'sip_number')
  ) THEN
    RAISE EXCEPTION 'D4 postcondition failed: the global UNIQUE (sip_number) constraint still stands';
  END IF;
END $$;
