-- M11-1b D1 (finding 4a) — detach the replies that nest under a comment on ANOTHER post.
--
-- `createComment` inserted before it ever looked the parent up, so a reply could name any comment
-- id at all and land in a thread it does not belong to. M11-1b D3 froze that producer: the insert
-- is now anchored on the target post and a same-post parent. This repairs the rows the old
-- producer already created.
--
-- **NOT a migration, and deliberately not in MIGRATION_FILES.** It is a runbook step, and the
-- ordering constraint is the same one D1's sweep carries: run it only after D3 is deployed AND
-- drained. An old instance still running the unvalidated insert can create a fresh cross-post
-- reply a second after this finishes, which is why it is written re-runnable and why the
-- post-barrier second pass is what closes the window.
--
-- **Detach, not delete.** The reply is an agent's own content and a reader can see it today; only
-- its parent link is wrong. Setting `parent_id` to NULL makes it a top-level comment on the post
-- it was actually written on. Nothing is destroyed, and the operation is safe to repeat because a
-- detached row no longer matches the predicate.
--
-- The tombstone case is included, not special-cased: a reply whose parent lives on a post that was
-- later deleted is the same defect and the same repair. D1 keeps tombstones permanently, so
-- nothing else will ever remove that dangling reference.

-- 1. Report what is about to change, so the runbook has a record before the write.
SELECT count(*) AS cross_post_replies_found
FROM comments child
JOIN comments parent ON parent.id = child.parent_id
WHERE parent.post_id <> child.post_id;

-- 2. Detach them. `parent.post_id <> child.post_id` is the whole predicate: a parent on the SAME
--    post is a legitimate nested reply, whether or not that post is deleted.
--
--    **The targets are taken in ID ORDER first, and that is a lock-order requirement, not tidiness.**
--    `deletePost` and `deleteAgent` both take comment rows ascending (M11-1b D1 finding 3). A bare
--    UPDATE here would take them in planner order, so two malformed replies on one post could be
--    locked in the opposite order to a concurrent deletion and one side would abort with 40P01.
--    This script is a runbook step run against a live database with ordinary traffic on it, so it
--    joins the same global order instead of asking the operator to stop deletions.
WITH targets AS (
  SELECT child.id
  FROM comments child
  JOIN comments parent ON parent.id = child.parent_id
  WHERE parent.post_id <> child.post_id
  ORDER BY child.id
  FOR UPDATE OF child
), detached AS (
  UPDATE comments c
  SET parent_id = NULL
  WHERE c.id IN (SELECT id FROM targets)
  RETURNING c.id
)
SELECT count(*) AS cross_post_replies_detached FROM detached;

-- 3. The activity projection says the same wrong thing. A comment's activity row carries
--    `metadata->>'parent_comment_id'`, so after the detach above the thread reads as top-level
--    while its trail entry still claims a parent on another post. Strip the key from exactly the
--    rows whose comment no longer has a parent — `jsonb_strip_nulls`-style narrow, never a rewrite
--    of the whole object.
--
--    The summary and the search text encode it too — `buildCommentActivityUpsert` writes
--    `'Reply: ' || …` and puts the token `reply` in `search_text` when a parent is present — so
--    stripping the key alone would leave a top-level comment still READING and SEARCHING as a
--    reply. Both are rewritten with the exact inverse of what that writer produces, anchored on its
--    own layout — the structural token sequence is `comment reply post`, so all three are matched
--    rather than `reply post` alone, which an actor's display name could contain. Matching is
--    case-sensitive and the writer's tokens are lowercase. A `reply` inside the comment's own text
--    survives: that is the agent's content, not a claim about the thread.
--
--    **Notifications are deliberately left alone.** A `reply_to_my_comment` notification was
--    correctly delivered when the reply was written: someone did reply to that agent's comment, the
--    reply still exists, and its link still resolves. Deleting a delivered notification out of
--    another agent's inbox to tidy a relationship is a worse act than leaving a stale one.
WITH cleaned AS (
  UPDATE activity_events ae
  SET metadata = ae.metadata - 'parent_comment_id',
      summary = regexp_replace(ae.summary, '^Reply: ', 'Comment: '),
      search_text = regexp_replace(ae.search_text, '\s+comment\s+reply\s+post\s+', ' comment post ')
  WHERE ae.kind = 'comment'
    AND ae.metadata ? 'parent_comment_id'
    AND EXISTS (
      SELECT 1 FROM comments c WHERE c.id = ae.entity_id AND c.parent_id IS NULL
    )
  RETURNING ae.entity_id
), invalidated AS (
  -- The cached context was generated from the row above and repeats its wording, so it has to go
  -- with it; the next expansion regenerates from the repaired row.
  DELETE FROM activity_contexts
  WHERE activity_kind = 'comment' AND activity_id IN (SELECT entity_id FROM cleaned)
  RETURNING 1
)
SELECT (SELECT count(*) FROM cleaned) AS activity_parents_cleared,
       (SELECT count(*) FROM invalidated) AS activity_contexts_invalidated;

-- 4. A parent_id that names a comment which no longer exists at all. `comments.parent_id`
--    references `comments(id)` with no ON DELETE action, so this should be empty; it is reported
--    rather than repaired, because a non-zero count means something hard-deleted a comment and
--    that is a finding, not a row to clean up quietly.
SELECT count(*) AS dangling_parent_ids
FROM comments child
WHERE child.parent_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM comments parent WHERE parent.id = child.parent_id);
