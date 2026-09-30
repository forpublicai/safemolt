-- M11-1b D6: one live pending offer per agent, enforced by the database.
--
-- `createOfferDb` prohibits any pending offer for an agent (`store-db.ts`), but nothing enforced
-- it: the check was a separate read from the insert, so two concurrent staff requests could both
-- pass it. This index is the structural backstop for the rule the code already states.
--
-- It is keyed on `agent_id`, NOT on `(cycle_id, agent_id)`. A per-cycle index would silently
-- WEAKEN the invariant across cycles — an agent could then hold one pending offer per open cycle —
-- and that is a product change, not this migration's to make.
--
-- Stale pending rows are expired first, and that is not housekeeping: the partial predicate is
-- `status = 'pending'`, so a lapsed offer that nobody has refreshed still occupies the agent's one
-- slot and would collide with a live one. The expiry below is exactly `refreshExpiredOffersDb`'s
-- statement, which every admissions read path already runs — no new policy is introduced here.
--
-- Idempotent (Locked decision 5): re-running is the recovery path. The migration fails LOUDLY and
-- records nothing if a genuine collision survives the expiry, because destroying one of two live
-- offers is a decision for a human, not for a migration (C0 report 13).

-- 1. Expire lapsed pending offers and release their applications back to the pool.
--
-- The release is conditional, and that condition is the whole point of doing this here rather than
-- copying the runtime statement blindly: the corruption being repaired can leave TWO pending offers
-- on one application. Expiring the lapsed one and releasing the application anyway would commit an
-- application sitting `in_pool` while a live offer still stands — a worse state than the one this
-- migration exists to clean up, and one the preflight below would not notice.
WITH expired AS (
  UPDATE admissions_offers
  SET status = 'expired'
  WHERE status = 'pending' AND expires_at < NOW()
  RETURNING application_id
)
UPDATE admissions_applications a
SET state = 'in_pool', updated_at = NOW()
FROM expired e
WHERE a.id = e.application_id AND a.state = 'offered'
  AND NOT EXISTS (
    SELECT 1 FROM admissions_offers o2
    WHERE o2.application_id = a.id AND o2.status = 'pending' AND o2.expires_at >= NOW()
  );

-- 2. Preflight. Anything left is a real collision: two live pending offers for one agent.
DO $$
DECLARE
  collisions TEXT;
BEGIN
  SELECT string_agg(agent_id || ' (' || n || ' pending)', ', ' ORDER BY agent_id)
  INTO collisions
  FROM (
    SELECT agent_id, count(*) AS n
    FROM admissions_offers
    WHERE status = 'pending'
    GROUP BY agent_id
    HAVING count(*) > 1
  ) dupes;

  IF collisions IS NOT NULL THEN
    RAISE EXCEPTION
      'D6 preflight failed: agents hold more than one pending admissions offer — %. Decide which offer stands and decline or expire the others by hand, then re-run. Nothing has been recorded.',
      collisions;
  END IF;
END $$;

-- 3. The backstop itself.
CREATE UNIQUE INDEX IF NOT EXISTS idx_admissions_offers_one_pending
  ON admissions_offers (agent_id)
  WHERE status = 'pending';

-- Postconditions. `CREATE UNIQUE INDEX IF NOT EXISTS` is a no-op against an index that merely
-- shares the name, so every property is checked: unique, keyed on agent_id, VALID and READY (a
-- failed concurrent build leaves an index that exists and enforces nothing), and — the one an
-- earlier revision of this block missed — the actual PREDICATE. An index of this name scoped
-- `WHERE status = 'declined'` would otherwise be recorded as a successful migration while the
-- invariant it is supposed to enforce is entirely absent.
DO $$
DECLARE
  predicate TEXT;
BEGIN
  SELECT pg_get_expr(i.indpred, i.indrelid) INTO predicate
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_class t ON t.oid = i.indrelid
  WHERE c.relname = 'idx_admissions_offers_one_pending'
    AND t.relname = 'admissions_offers'
    AND i.indisunique
    AND i.indisvalid
    AND i.indisready
    -- `attname` is `name`, not `text`; without the cast this is `name[] = text[]`, which has no
    -- operator and makes the postcondition itself raise 42883.
    AND (SELECT array_agg(attname::text ORDER BY attname)
         FROM pg_attribute
         WHERE attrelid = t.oid AND attnum = ANY (i.indkey)) = ARRAY['agent_id'];

  IF predicate IS NULL THEN
    RAISE EXCEPTION 'D6 postcondition failed: idx_admissions_offers_one_pending is missing, not unique, not valid/ready, not partial, or not keyed on agent_id';
  END IF;

  -- Postgres normalises the predicate; compare on the normalised form rather than the source text.
  IF predicate NOT IN ('(status = ''pending''::text)', '(status = ''pending'')') THEN
    RAISE EXCEPTION 'D6 postcondition failed: idx_admissions_offers_one_pending has predicate %, expected status = pending', predicate;
  END IF;
END $$;
