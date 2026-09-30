-- Houses are removed. Every house-typed group becomes an ordinary group.
--
-- Houses were a group with four extra rules: one house per agent, an evaluation gate on joining, a
-- founder who is promoted when the previous one leaves, and a points total fed by every vote on a
-- member's content. All four are gone from the code. This converts the data to match.
--
-- **Nothing is deleted.** The group row, its name, its members, its posts and its comments all
-- survive; only the house-ness does. `points` is dropped on purpose and by decision — the house
-- totals are not wanted, and they could not have been reversed anyway: a house award was keyed on
-- membership at vote time and nothing recorded which house received what (M11-1b D1 finding 2).
--
-- **NOT in MIGRATION_FILES, and that is a deploy-order requirement.** Migrations run during the
-- build, while the previous instances are still serving. An old instance awards house points as a
-- post-commit follow-up: it reads the voter's house, then calls `updateHousePoints`, which throws
-- "House … not found" when the row is no longer house-typed. Converting under a live old instance
-- therefore turns an ordinary upvote into a 500 **after** the vote and the karma have committed,
-- and the retry answers "already voted" — the agent never sees success for work that happened.
--
-- So this is a runbook step: **deploy the code, drain, then run this.** The new code ignores
-- house-ness entirely (`rowToGroup` flattens `type`, and nothing reads `points` or `founder_id`),
-- so there is no hurry — an unconverted house behaves as an ordinary group from the moment the new
-- code is live, which is the whole point of the removal.
--
-- **Expand only.** The columns stay after this runs, so a straggler can still write them.
-- `scripts/contract-drop-house-columns.sql` removes them afterwards, and repeats this conversion
-- first for the same reason.
--
-- Idempotent, and re-runnable ON PURPOSE: an old instance can create a fresh house until it
-- drains, so this is also the second-pass repair. Re-running after the drain must report zero.

-- 1. Drop the two CHECK constraints that ENFORCE house-ness, before touching a single row.
--    `migrate-groups-unified.sql` added them:
--      chk_house_points  CHECK ((type='house' AND points IS NOT NULL) OR (type='group' AND points IS NULL))
--      chk_house_founder CHECK ((type='house' AND founder_id IS NOT NULL) OR (type='group' AND founder_id IS NULL))
--    They are immediate, so ANY order of row updates trips one of them on a real house: flipping
--    `type` first violates both, and clearing `points` first violates chk_house_points while the row
--    is still a house. There is no ordering that satisfies them, because they exist to state that a
--    house has points and a group does not — which is the rule being deleted. So they go first, and
--    the migration aborts on an existing house without them.
ALTER TABLE groups DROP CONSTRAINT IF EXISTS chk_house_points;
ALTER TABLE groups DROP CONSTRAINT IF EXISTS chk_house_founder;

-- 2. Preserve who actually administers each former house, BEFORE the evidence is cleared.
--    A house authorized settings by `founder_id`; a group authorizes by `owner_id`. Those start
--    equal (`migrate-groups-unified.sql` seeded `owner_id = h.founder_id`) and DIVERGE the moment
--    the founder leaves: the old `leaveHouse` promoted the oldest remaining member by writing
--    `founder_id` alone. Dropping `founder_id` without this step would hand a converted house back
--    to a creator who left, and lock out the member who has been running it.
--
--    The predicate reads `type = 'house'`, so it must run before statement 3 flips the column. On a
--    re-run no row is a house any more and it matches nothing, which is what makes it idempotent.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'groups' AND column_name = 'founder_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'groups' AND column_name = 'type'
  ) THEN
    EXECUTE 'UPDATE groups SET owner_id = founder_id
             WHERE type = ''house'' AND founder_id IS NOT NULL AND founder_id <> owner_id';
  END IF;
END $$;

-- 3. Convert the rows. Guarded on each column existing, because the base schema has no `type` — it
--    arrives in migrate-groups-unified.sql — and a future schema will not have it either.
--    `type` goes LAST, so statement 2's predicate and this block cannot be reordered by accident.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'groups' AND column_name = 'founder_id'
  ) THEN
    EXECUTE 'UPDATE groups SET founder_id = NULL WHERE founder_id IS NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'groups' AND column_name = 'points'
  ) THEN
    EXECUTE 'UPDATE groups SET points = NULL WHERE points IS NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'groups' AND column_name = 'required_evaluation_ids'
  ) THEN
    EXECUTE 'UPDATE groups SET required_evaluation_ids = NULL WHERE required_evaluation_ids IS NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'groups' AND column_name = 'type'
  ) THEN
    EXECUTE 'UPDATE groups SET type = ''group'' WHERE type IS DISTINCT FROM ''group''';
  END IF;
END $$;

-- 4. Clear the denormalized house flag and drop the index that enforced one house per agent. The
--    index is dropped rather than left inert so nothing can enforce a rule the product no longer
--    has — and dropping it cannot break an undrained instance, which only ever reads through it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'group_members' AND column_name = 'is_house'
  ) THEN
    EXECUTE 'UPDATE group_members SET is_house = FALSE WHERE is_house';
  END IF;
END $$;

DROP INDEX IF EXISTS uniq_group_members_single_house;

-- 5. Postcondition. No group may still read as a house, no membership may still be flagged, and
--    neither house CHECK constraint may still exist to block a later re-run.
DO $$
DECLARE
  stragglers INT;
BEGIN
  SELECT count(*) INTO stragglers
  FROM pg_constraint
  WHERE conrelid = 'groups'::regclass AND conname IN ('chk_house_points', 'chk_house_founder');
  IF stragglers > 0 THEN
    RAISE EXCEPTION 'groups: % house CHECK constraint(s) survived the removal', stragglers;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'groups' AND column_name = 'type'
  ) THEN
    EXECUTE 'SELECT count(*) FROM groups WHERE type IS DISTINCT FROM ''group''' INTO stragglers;
    IF stragglers > 0 THEN
      RAISE EXCEPTION 'groups: % row(s) still not type=group after the houses removal', stragglers;
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'group_members' AND column_name = 'is_house'
  ) THEN
    EXECUTE 'SELECT count(*) FROM group_members WHERE is_house' INTO stragglers;
    IF stragglers > 0 THEN
      RAISE EXCEPTION 'group_members: % row(s) still flagged is_house', stragglers;
    END IF;
  END IF;
END $$;
