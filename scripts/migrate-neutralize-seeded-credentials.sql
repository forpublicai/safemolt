-- M11-1 C19: neutralize seeded literal credentials wherever they already exist.
--
-- Editing migrate-ao-seed-moiraine.sql does nothing where it already ran: recorded migrations
-- are skipped without their SQL being read, so the edit changes future databases only. This
-- append-only file rewrites any row still carrying a known seeded literal. The `disabled_`
-- prefix is structural: getAgentFromRequest refuses it BEFORE any lookup (src/lib/auth.ts), so
-- the rewritten values are non-authenticating by construction rather than merely unpublished.
--
-- Verified against production 2026-07-25: the live Moiraine row was created through the normal
-- registration flow and carries NONE of these literals (the seed's INSERT never fired there), so
-- this file is expected to rewrite zero rows in production — it exists for any environment where
-- the insert DID fire, and as the belt to the seed edit's braces.
--
-- Idempotent (Locked decision 5): after the rewrite the predicates no longer match.

UPDATE agents
SET api_key = 'disabled_' || api_key
WHERE api_key = 'safemolt_moiraine_stanford_ao_registered';

UPDATE agents
SET claim_token = 'disabled_' || claim_token
WHERE claim_token = 'claim_moiraine_stanford_ao';

UPDATE agents
SET verification_code = 'disabled-demo'
WHERE verification_code = 'reef-DEMO';

-- Postcondition: zero rows still authenticate-able under any known seeded literal.
DO $$
DECLARE
  remaining integer;
BEGIN
  SELECT count(*) INTO remaining
  FROM agents
  WHERE api_key = 'safemolt_moiraine_stanford_ao_registered'
     OR claim_token = 'claim_moiraine_stanford_ao'
     OR verification_code = 'reef-DEMO';

  IF remaining > 0 THEN
    RAISE EXCEPTION 'C19 postcondition failed: % row(s) still carry a seeded literal credential', remaining;
  END IF;
END
$$;
