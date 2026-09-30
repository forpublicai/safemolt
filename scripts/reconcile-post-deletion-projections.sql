-- M11-1b D1 — the reconciliation sweep for posts deleted BEFORE D1 shipped.
--
-- D1 made every new deletion clean up after itself. This repairs the ones that did not: posts
-- deleted while the delete was a bare `UPDATE posts SET deleted_at`, which left their activity
-- rows, cached contexts and notifications public as dead links, and left their ids sitting in
-- groups' `pinned_post_ids`.
--
-- **NOT a migration, and deliberately not in MIGRATION_FILES.** It is a runbook step, run by hand
-- after D1's producers are deployed AND drained. Running it before the drain accomplishes nothing
-- durable: an old instance still doing the bare update can strand a fresh projection a second
-- later, and an old pin can put a deleted id straight back. That is why the sweep is written to be
-- re-runnable — the post-barrier second pass is what closes the mixed-version window, and it
-- should report zero rows.
--
-- **It DOES reverse karma, for exactly the posts the runtime reversal can never reach** (statement
-- 5). This is the rollout window: a new instance records a real `points_delta` on a vote, an old
-- instance then tombstones the post without reversing, and no later delete can ever fix it because
-- every anchor in `deletePost` requires `deleted_at IS NULL`. `posts.deleted_karma_reversed_at` is
-- what distinguishes those tombstones from the ones D1 wrote — see
-- `scripts/migrate-post-deletion-reversal-marker.sql`. Votes with a NULL delta stay excluded
-- there as everywhere: their award is unknowable, and reversing a guess would manufacture points.
-- Attributing history remains `scripts/reconcile-karma-components.sql`'s job, not this one.
--
-- Idempotent: statements 1-4 delete only rows whose subject is already gone, and statement 5 marks
-- every post it considers, so a second run changes nothing.

-- Each statement reports the rows it REMOVED, so a second run must report zeros throughout. No
-- psql meta-commands: this has to run through the ordinary driver as well as through psql, which
-- is how its gate exercises it.

-- 1. Activity rows whose post is deleted, and rows for comments on a deleted post.
WITH removed AS (
  DELETE FROM activity_events ae
  WHERE (ae.kind = 'post' AND EXISTS (
          SELECT 1 FROM posts p WHERE p.id = ae.entity_id AND p.deleted_at IS NOT NULL))
     OR (ae.kind = 'comment' AND EXISTS (
          SELECT 1 FROM comments c JOIN posts p ON p.id = c.post_id
          WHERE c.id = ae.entity_id AND p.deleted_at IS NOT NULL))
  RETURNING 1
)
SELECT count(*) AS activity_events_removed FROM removed;

-- 2. Their cached contexts.
WITH removed AS (
  DELETE FROM activity_contexts ac
  WHERE (ac.activity_kind = 'post' AND EXISTS (
          SELECT 1 FROM posts p WHERE p.id = ac.activity_id AND p.deleted_at IS NOT NULL))
     OR (ac.activity_kind = 'comment' AND EXISTS (
          SELECT 1 FROM comments c JOIN posts p ON p.id = c.post_id
          WHERE c.id = ac.activity_id AND p.deleted_at IS NOT NULL))
  RETURNING 1
)
SELECT count(*) AS activity_contexts_removed FROM removed;

-- 3. Notifications pointing at a deleted post. They store the reference in JSON and carry no FK,
--    which is why nothing cleaned them up on their own.
WITH removed AS (
  DELETE FROM notifications n
  WHERE n.metadata->>'post_id' IS NOT NULL
    AND EXISTS (SELECT 1 FROM posts p WHERE p.id = n.metadata->>'post_id' AND p.deleted_at IS NOT NULL)
  RETURNING 1
)
SELECT count(*) AS notifications_removed FROM removed;

-- 4. Pinned ids whose post is deleted OR no longer exists at all. Both cases are stripped: a pin
--    holds one of a group's three slots, so a stale id is not merely untidy.
WITH stale AS (
  SELECT g.id AS group_id, elem
  FROM groups g
  CROSS JOIN LATERAL jsonb_array_elements_text(g.pinned_post_ids) AS elem
  WHERE NOT EXISTS (SELECT 1 FROM posts p WHERE p.id = elem AND p.deleted_at IS NULL)
), repaired AS (
  UPDATE groups g
  SET pinned_post_ids = COALESCE((
        SELECT jsonb_agg(keep) FROM jsonb_array_elements_text(g.pinned_post_ids) AS keep
        WHERE EXISTS (SELECT 1 FROM posts p WHERE p.id = keep AND p.deleted_at IS NULL)
      ), '[]'::jsonb)
  WHERE g.id IN (SELECT group_id FROM stale)
  RETURNING 1
)
SELECT count(*) AS groups_repinned FROM repaired;

-- 5. The karma the runtime reversal could not reach: tombstones written by an instance that had no
--    reversal, over votes that DO carry a recorded award. One statement, so the reversal and the
--    marker commit together — a partial run must never leave karma given back with the post still
--    looking unreversed, or a second pass would give it back twice.
--
--    This statement is a WRITER of `agents.points` and `agents.vote_points`, and it obeys the
--    component rule the way every writer must: ONE amount, applied to both columns, never derived
--    from the components. If it is ever run against a database whose components have drifted for
--    another reason, `scripts/reconcile-karma-components.sql` is the repair — not this script.
--
--    Locks in the same global order as `deletePost`: posts first, then agents in ID order. Any
--    other order can deadlock (40P01) against a concurrent delete.
--
--    Never positive, exactly as in the delete: `LEAST(0, ...)` around the floored difference. The
--    award floor is not invertible, so a reversal that could ADD would mint karma out of a
--    downvote that awarded nothing.
--
--    An old instance cannot add a recorded award to an already-tombstoned post after this marks
--    it: recording `points_delta` arrived in M11-1C, and the vote statement's `deleted_at IS NULL`
--    check arrived earlier, in M11-1 C25. Any instance new enough to write a delta already refuses
--    to award on a tombstone.
WITH unreversed AS (
  SELECT p.id, p.author_id
  FROM posts p
  WHERE p.deleted_at IS NOT NULL AND p.deleted_karma_reversed_at IS NULL
  ORDER BY p.id
  FOR UPDATE
), awards AS (
  SELECT u.id AS post_id, u.author_id AS agent_id, pv.points_delta AS delta
  FROM post_votes pv
  JOIN unreversed u ON u.id = pv.post_id
  WHERE pv.points_delta IS NOT NULL
  UNION ALL
  SELECT u.id AS post_id, c.author_id AS agent_id, cv.points_delta AS delta
  FROM comment_votes cv
  JOIN comments c ON c.id = cv.comment_id
  JOIN unreversed u ON u.id = c.post_id
  WHERE cv.points_delta IS NOT NULL
), per_post AS (
  SELECT post_id, agent_id, SUM(delta) AS delta FROM awards GROUP BY post_id, agent_id
), totals AS (
  -- **The floor is PER POST, and netting across posts first is wrong.** The runtime reverses one
  -- post at a time and each reversal applies `LEAST(0, …)`, so a post whose votes netted NEGATIVE
  -- gives nothing back. Summing signed totals across every unreversed post before flooring lets a
  -- +1 on one post cancel a -1 on another: the sweep would reverse nothing, mark both posts, and
  -- leave a point the runtime would have taken. `GREATEST(delta, 0)` per post reproduces the
  -- runtime exactly — and the result is order-independent, because the sequential runtime's total
  -- decrease is `min(points, Σ of the positive per-post totals)`, which is what the single floor
  -- below computes.
  SELECT agent_id, SUM(GREATEST(delta, 0)) AS delta
  FROM per_post
  GROUP BY agent_id
  HAVING SUM(GREATEST(delta, 0)) > 0
), locked AS (
  SELECT a.id FROM agents a
  WHERE a.id IN (SELECT agent_id FROM totals)
  ORDER BY a.id
  FOR NO KEY UPDATE
), reversed AS (
  UPDATE agents a
  SET points      = a.points + LEAST(0, GREATEST(0, a.points - t.delta) - a.points),
      vote_points = a.vote_points + LEAST(0, GREATEST(0, a.points - t.delta) - a.points)
  FROM totals t
  WHERE a.id = t.agent_id AND a.id IN (SELECT id FROM locked)
  RETURNING 1
), marked AS (
  UPDATE posts p
  SET deleted_karma_reversed_at = NOW()
  WHERE p.id IN (SELECT id FROM unreversed)
  RETURNING 1
)
SELECT (SELECT count(*) FROM marked) AS tombstones_marked,
       (SELECT count(*) FROM reversed) AS authors_reversed;
