# b1 Lane M — codex round-1 fix spec (mentions / presence / hot)

Findings: `ai/m11-2-handoff/codex-findings-b1-m-round1.md`. Rules: `ai/m11-2-handoff/b1-common-rules.md`
(KISS, complexity ≤ 12, WHY-only short comments, no git/codex/build, targeted jest + targeted
integration, mutation-check every behavioral fix, evidence verbatim). Fence = lane M's files only
(`src/lib/store/notifications/*` for the mention writer only; do NOT touch the wakeup store).

ADJUDICATED valid — fix:
1. **F1 mention notification locks the live post** (`createMentionNotificationIdempotent`, db +
   memory): take `posts … deleted_at IS NULL FOR SHARE` (for a comment source, the comment's post)
   BEFORE the recipient lock (lock order posts → comments → agents) and gate the insert on it; the
   memory twin re-checks the post right before writing. Test: delete-then-drain creates nothing.
2. **F3 memory actor re-check** (`posts/memory.ts` createPost, `comments/memory.ts` createComment):
   after the action's mention-resolution await, the memory writer re-checks the author by id
   immediately before any write (quota, row, events) and refuses like the Postgres FK. Test.
3. **F4 presence count** (`countActiveNowFollowees`, db + memory): exclude publicly hidden agents
   (reuse the predicate `isPubliclyHiddenAgent` encodes — find its SQL twin used by the public
   listings) and use a strict `>` cutoff matching `presenceBucket`. Boundary test at exactly 10 min.
4. **F5 marker-gated override**: add the `source_id` override only to derived events whose payload
   carries `STORE_ASSIGNED_PAYLOAD_ID` in `source_id` (posts + comments, db + memory). Test: a
   derived event with its own `source_id` keeps it.
5. **F6 db hot-score parity**: `src/__tests__/integration/m11-2-b1-hot-score.test.ts` — identical
   fixtures (negative/zero/positive at several ages, fixed `now`) through `listPosts` (group,
   school, global) and `listFeed` on Postgres, asserting the order equals `hotScoreComparator`'s
   order on the same rows. RUN-suffix fixtures.
6. **F7 suppression order-independence**: in `mentions-e2e.test.ts` drain `agent.mentioned` before
   `comment.created`, after it, and both concurrently — exactly one wakeup total each time.
7. **F8 one resolver**: one `resolveMentionRecipients(text, actor, schoolId)` in `src/lib/mentions.ts`
   (or the actions' shared helper) used by both actions; delete the duplicate.

DEFERRED for codex to adjudicate in round 2 (do NOT implement):
- **F2** (mention wakeup enqueued from a pre-read): this is the SAME shape as the converged
  `routeCommentCreated` (u5 Lane C, two codex rounds) — a wakeup is a best-effort nudge, the
  runner re-reads its subject and does nothing for deleted content, and the enqueue is deduped.
  Pinned unless codex shows a concrete harm the comment path does not share.

Report: `ai/m11-2-handoff/b1-m-fix-r1-report.md` — per finding: change, test, mutation-check
evidence; gate tails (tsc, lint, mentions/presence/hot jest paths + `src/__tests__/lib/events`,
the two integration files).
