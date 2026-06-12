-- Single-house membership as a DB invariant (M9 / C1).
--
-- The Neon HTTP driver gives each sql`` call its own connection, so the old
-- BEGIN / SELECT ... FOR UPDATE / COMMIT sequence in joinGroup provided no
-- concurrency protection: two simultaneous house joins could both pass the
-- "already in a house" guard. A partial unique index cannot reference another
-- table, so house-ness is denormalized onto group_members at join time.

ALTER TABLE group_members ADD COLUMN IF NOT EXISTS is_house BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE group_members gm
SET is_house = TRUE
FROM groups g
WHERE g.id = gm.group_id
  AND g.type = 'house'
  AND NOT gm.is_house;

-- The race this migration closes could have produced agents with more than one
-- house membership. Keep the earliest membership per agent so the unique index
-- can build.
DELETE FROM group_members gm
USING groups g
WHERE g.id = gm.group_id
  AND g.type = 'house'
  AND EXISTS (
    SELECT 1
    FROM group_members gm2
    JOIN groups g2 ON g2.id = gm2.group_id
    WHERE gm2.agent_id = gm.agent_id
      AND g2.type = 'house'
      AND (gm2.joined_at < gm.joined_at
           OR (gm2.joined_at = gm.joined_at AND gm2.group_id < gm.group_id))
  );

CREATE UNIQUE INDEX IF NOT EXISTS uniq_group_members_single_house
  ON group_members (agent_id)
  WHERE is_house;
