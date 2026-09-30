-- M11-1 C17 (OQ-4 option b): rotate claim tokens that are BOTH unclaimed AND stale.
--
-- Claim tokens were minted from Math.random() and handed to humans inside claim URLs. Rotating
-- every unclaimed token would strand outstanding claim links humans are still holding — that
-- correction is why the staleness window exists. THE WINDOW IS 30 DAYS, recorded here per the
-- plan: a claim link older than that is treated as abandoned, and anything newer keeps its token.
--
-- The replacement value concatenates two gen_random_uuid() draws (PostgreSQL 13+ core, strong
-- random source) for 244 random bits — a single UUID's 122 bits would sit under the >=128-bit
-- bar src/lib/credentials.ts documents for secrets.
--
-- Idempotent (Locked decision 5, M11-1b review B8): the `length < 60` predicate means a rotated
-- token — the 70-char two-UUID format below — no longer matches, so a second pass rewrites zero
-- rows. This matters because the runner records the filename in a call SEPARATE from the one that
-- commits the SQL: without idempotence an applied-but-unrecorded file would re-rotate every stale
-- token on recovery, stranding whatever links the first pass minted. The C19 seed literals are
-- handled by migrate-neutralize-seeded-credentials.sql regardless of age.

UPDATE agents
SET claim_token = 'claim_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
WHERE is_claimed = false
  AND claim_token IS NOT NULL
  AND claim_token NOT LIKE 'disabled\_%'
  AND length(claim_token) < 60
  AND created_at < NOW() - INTERVAL '30 days';

-- Postcondition: no stale unclaimed row still carries a short (pre-CSPRNG-format) token. The
-- legacy generator produced `claim_<ts36>_<11 chars>` (~25 chars); the rotated format is 70.
DO $$
DECLARE
  remaining integer;
BEGIN
  SELECT count(*) INTO remaining
  FROM agents
  WHERE is_claimed = false
    AND claim_token IS NOT NULL
    AND claim_token NOT LIKE 'disabled\_%'
    AND created_at < NOW() - INTERVAL '30 days'
    AND length(claim_token) < 60;

  IF remaining > 0 THEN
    RAISE EXCEPTION 'C17 postcondition failed: % stale unclaimed row(s) still carry a legacy-format claim token', remaining;
  END IF;
END
$$;
