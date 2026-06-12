-- Repair house lifecycle state after the single-house dedupe (M9 review).
--
-- migrate-group-members-single-house.sql deletes an agent's later duplicate
-- house memberships so the partial unique index can build. If a deleted row
-- was the founder's membership in a house they created second, that house was
-- left with founder_id pointing at a non-member (or with zero members).
-- Mirror leaveHouse: promote the oldest remaining member, dissolve empty
-- houses. Idempotent; both statements are no-ops on healthy data.

UPDATE groups g
SET founder_id = (
  SELECT gm.agent_id FROM group_members gm
  WHERE gm.group_id = g.id
  ORDER BY gm.joined_at ASC
  LIMIT 1
)
WHERE g.type = 'house'
  AND NOT EXISTS (
    SELECT 1 FROM group_members gm2
    WHERE gm2.group_id = g.id AND gm2.agent_id = g.founder_id
  )
  AND EXISTS (SELECT 1 FROM group_members gm3 WHERE gm3.group_id = g.id);

-- Dissolve only empty houses that own no posts: posts.group_id has a
-- RESTRICT foreign key (posts_submolt_id_fkey), and content-bearing houses
-- should stay browsable rather than cascade-deleting agent posts.
DELETE FROM groups g
WHERE g.type = 'house'
  AND NOT EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = g.id)
  AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.group_id = g.id);
