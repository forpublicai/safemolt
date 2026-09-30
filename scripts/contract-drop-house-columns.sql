-- Houses removal, contract step: drop the columns nothing reads any more.
--
-- **NOT a migration, and deliberately not in MIGRATION_FILES.** Migrations run as part of the
-- build, which is BEFORE the previous instances drain. An instance that still has the old
-- `createGroup` names `founder_id`, `points`, `required_evaluation_ids` and `is_house` in its
-- INSERT, so dropping them during the rollout would turn every group creation into a 500 for as
-- long as one old instance survives.
--
-- Run this by hand, once, after `scripts/migrate-remove-houses.sql` has been deployed AND the old
-- instances have drained.
--
-- **It converts before it drops, and that is not a convenience.** `migrate-remove-houses.sql` is
-- recorded in `_migrations`, so the runner SKIPS it on every later deploy — it converts the houses
-- that existed at build time and nothing after. An undrained old instance can create a house in
-- the window, and that house's founder can then leave, which promotes a new founder by writing
-- `founder_id` alone while `owner_id` still names the agent who left. Dropping `founder_id` at
-- that point would discard the only record of who actually administers the group, permanently and
-- silently. So the same carry-across and conversion run here first, and the drop is gated on there
-- being no house left.
--
-- `groups.type` is NOT dropped. `rowToGroup` normalizes it, so it costs nothing, and keeping one
-- nullable text column leaves a cheap audit trail of what a row used to be. Drop it in a later
-- pass if it ever gets in the way.
--
-- Idempotent.

-- 1. The same conversion the migration performs, for anything created after it ran. Constraints
--    first: they are immediate and no order of row updates satisfies them mid-conversion.
ALTER TABLE groups DROP CONSTRAINT IF EXISTS chk_house_points;
ALTER TABLE groups DROP CONSTRAINT IF EXISTS chk_house_founder;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'groups' AND column_name = 'founder_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'groups' AND column_name = 'type'
  ) THEN
    -- The promoted founder becomes the owner, BEFORE founder_id is cleared or dropped.
    EXECUTE 'UPDATE groups SET owner_id = founder_id
             WHERE type = ''house'' AND founder_id IS NOT NULL AND founder_id <> owner_id';
    EXECUTE 'UPDATE groups SET type = ''group'' WHERE type IS DISTINCT FROM ''group''';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'group_members' AND column_name = 'is_house'
  ) THEN
    EXECUTE 'UPDATE group_members SET is_house = FALSE WHERE is_house';
  END IF;
END $$;

DROP INDEX IF EXISTS uniq_group_members_single_house;

-- 2. Refuse to drop while anything still reads as a house. Statement 1 should have left none; if a
--    row survives, an instance is still writing houses and this script must not run yet.
DO $$
DECLARE
  stragglers INT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'groups' AND column_name = 'type'
  ) THEN
    EXECUTE 'SELECT count(*) FROM groups WHERE type IS DISTINCT FROM ''group''' INTO stragglers;
    IF stragglers > 0 THEN
      RAISE EXCEPTION 'groups: % house row(s) remain; drain the old instances and re-run', stragglers;
    END IF;
  END IF;
END $$;

-- 3. Drop.
ALTER TABLE groups DROP COLUMN IF EXISTS founder_id;
ALTER TABLE groups DROP COLUMN IF EXISTS points;
ALTER TABLE groups DROP COLUMN IF EXISTS required_evaluation_ids;
ALTER TABLE group_members DROP COLUMN IF EXISTS is_house;

SELECT count(*) AS house_columns_remaining
FROM information_schema.columns
WHERE (table_name = 'groups' AND column_name IN ('founder_id', 'points', 'required_evaluation_ids'))
   OR (table_name = 'group_members' AND column_name = 'is_house');
