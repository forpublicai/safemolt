-- M11-2 u4-prep amendment — the two columns the drain-time shadow comparison stamps.
--
-- The soak's comparison moved from post-hoc SQL reconstruction to DRAIN TIME: the dispatcher reads
-- the legacy twin the moment it writes the shadow row, while the event, the fresh legacy row and the
-- intended payload are all in hand, and records the verdict here. `scripts/soak-shadow-report.sql`
-- then aggregates stamps instead of re-deriving expected keys from live state days later.
--
-- **A SEPARATE file rather than an append to `scripts/migrate-m11-consumers.sql`, and that is a rule
-- rather than a preference.** `scripts/migrate.js` records applied filenames in `_migrations` and
-- skips a recorded file FOREVER, and the consumers migration is already recorded on the development
-- and integration databases. Appending there would land these columns on a fresh database and never
-- on one that has run the suite once — a schema split with no recovery path short of a hand repair.
--
-- Idempotent (M8 invariant): `IF NOT EXISTS` everywhere, and re-running is the recovery path. A file
-- that raises records nothing and rolls back (M11-1 C1).

-- ==================== The comparison stamp ====================

-- **NULLABLE, and NULL is a MEANING rather than a gap: "not compared, pre-amendment".** Every shadow
-- row drained before this deploy was written by a build with no comparison at all, so it can never
-- be classified retroactively — the legacy row it would have been diffed against has since moved on.
-- The report gives those rows their own bucket and refuses to read them as clean.
--
-- The vocabulary is `matched | legacy_missing | payload_mismatch | unverifiable | compare_error`,
-- owned by `src/lib/events/consumers/legacy-compare.ts`. It is deliberately NOT a CHECK constraint
-- or an enum: a newer build's added verdict must never turn a drained event into a failed insert and
-- a retried, eventually dead-lettered consumer pass. The report buckets an unrecognized value as an
-- invalid shadow row instead, which is visible without being an outage.
ALTER TABLE event_consumer_shadow ADD COLUMN IF NOT EXISTS legacy_match TEXT;

-- The mismatch detail: the differing paths with both sides' values, or the missing-twin marker.
-- JSONB rather than TEXT so the report can read individual paths out of it without parsing.
ALTER TABLE event_consumer_shadow ADD COLUMN IF NOT EXISTS legacy_detail JSONB;

-- No index. The report scans the shadow rows of one window through the existing
-- `(consumer, event_id, effect_key)` unique index and the events join, and an index on a column
-- whose whole population is one of five values would serve nothing.

-- ==================== Postconditions ====================
--
-- `ADD COLUMN IF NOT EXISTS` is a no-op against a pre-existing shape, so what the dispatcher's
-- insert and the report's aggregation depend on is asserted rather than assumed. Written against
-- `current_schema()` so the assertion verifies whichever schema the file actually ran in.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'event_consumer_shadow'
      AND column_name = 'legacy_match' AND data_type = 'text' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'M11-2 u4-prep postcondition failed: event_consumer_shadow.legacy_match is not a nullable TEXT';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'event_consumer_shadow'
      AND column_name = 'legacy_detail' AND data_type = 'jsonb' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'M11-2 u4-prep postcondition failed: event_consumer_shadow.legacy_detail is not a nullable JSONB';
  END IF;
END
$$;
