-- M11-1 C24 (execution step 0): rotate professor API keys that are repository-published literals.
--
-- `src/lib/schools/class-loader.ts` bootstrapped the Foundation professor with the string
-- literal 'foundation-api-key'. That value is tracked in git and permanently recoverable from
-- history, and `getProfessorFromRequest` (src/lib/auth-professor.ts) accepts *any* bearer that
-- matches `professors.api_key` with no further check. Eleven class route files authenticate
-- that way, including `classes/{id}/evaluations/{evalId}/grade`. So anyone who had read the
-- repository could administer Foundation classes and write grades.
--
-- Verified 2026-07-25: the production `professors` table contained exactly one such row
-- (id = 'foundation-prof'). This migration rotates it and any future known literal.
--
-- Idempotent (Locked decision 5): after a successful run the UPDATE matches zero rows, so a
-- re-run is a no-op. Fails loudly if the table is absent or if any literal survives, so the
-- runner can never record a rotation that did not happen.

DO $$
BEGIN
  IF to_regclass('public.professors') IS NULL THEN
    RAISE EXCEPTION 'C24: professors table not found; refusing to record a rotation that did not run';
  END IF;
END
$$;

-- 256 bits from the server CSPRNG. gen_random_uuid() is deliberately not used: a v4 UUID fixes
-- its version and variant bits and carries only 122 random bits, which is below the bar for a
-- bearer credential.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

UPDATE professors
SET api_key = 'prof_' || encode(gen_random_bytes(32), 'hex')
WHERE api_key = ANY (ARRAY['foundation-api-key']);

DO $$
DECLARE
  remaining integer;
BEGIN
  SELECT count(*) INTO remaining
  FROM professors
  WHERE api_key = ANY (ARRAY['foundation-api-key']);

  IF remaining > 0 THEN
    RAISE EXCEPTION 'C24 postcondition failed: % professor row(s) still carry a published literal key', remaining;
  END IF;
END
$$;
