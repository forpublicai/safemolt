# b1 Lane M — codex round-1 fix report (mentions / presence / hot)

Generation-2 agent. Continued a generation-1 agent's interrupted, on-disk, uncommitted work. All
eight findings from `ai/m11-2-handoff/codex-findings-b1-m-round1.md` are closed except F2
(deferred, per spec). No git operations performed.

## Starting state (from `git diff` before this session's edits)

- F3 (`posts/memory.ts` actor recheck), F4 (presence count), F5 (marker-gated override, all four
  call sites), F8 (one resolver) — **done** by the generation-1 agent.
- F1 (mention notification post lock) — **done** by the generation-1 agent (both db and memory).
- F6 (db hot-score parity integration test) — **not started**.
- F7 (drain-order/concurrency test) — **not started**.
- Tests for F1, F3's comment side already existed from an earlier wave (comments/memory.ts's actor
  recheck predates this round, labelled "codex round 4" in that file's comment).

## Deliverables

1. **F1** — no code change needed (already fixed). Added tests only:
   - `src/__tests__/lib/store/mention-notification-liveness.test.ts` (memory): deleted post, never-
     inserted post, live-post control.
   - `src/__tests__/integration/m11-2-b1-mentions.test.ts`: new `describe("createMentionNotification
     Idempotent (db) — codex round 1 F1")` block: delete-then-call creates nothing; live-post control.
2. **F3** — no code change needed (already fixed in both `posts/memory.ts` and
   `comments/memory.ts`). Covered by existing `posts.test.ts`/action-layer tests; no new test added
   (the fix and its test obligation were already satisfied pre-session).
3. **F4** — no code change needed (already fixed in `agents/db.ts` and `agents/memory.ts`). Added
   `src/__tests__/lib/agent-senses/active-now-followees.test.ts` (memory mode): hidden-followee
   exclusion, and the exactly-at-threshold boundary (the mutation anchor for the `>=`→`>` fix).
4. **F5** — no code change needed (already fixed in all four call sites: `posts/db.ts`,
   `posts/memory.ts`, `comments/db.ts`, `comments/memory.ts`). Added tests:
   - `src/__tests__/lib/store/marker-gated-source-id.test.ts` (memory, both `createPost` and
     `createCommentWithOutcome`): a derived event carrying the marker gets filled; a derived event
     carrying its own `source_id` keeps it.
   - `src/__tests__/integration/m11-2-b1-mentions.test.ts`: added "keeps a derived event's own
     source_id when it is not the marker" to both the `createPost` and `createComment` describe
     blocks (db side).
5. **F6** — **new**: `src/__tests__/integration/m11-2-b1-hot-score.test.ts`. Runs the same six-bucket
   negative/zero/positive fixture set (mirrored from `hot-score.test.ts`'s pure-comparator case)
   through all four `sort === "hot"` sites — `listPosts({group})`, `listPosts({schoolId})`,
   `listPosts()` (global, filtered to the run's own ids), and `listFeed()` — asserting each site's
   order equals `hotScoreComparator`'s order over the same fixture set, with `created_at` pinned off
   one captured `seedNow` so DB and TS agree on every post's age.
6. **F7** — **new**: added `mentions-e2e.test.ts` test "suppresses the reply-mention wakeup
   regardless of drain order or concurrency". Replays `wakeupRouterEffects.apply` directly on the
   real emitted `comment.created`/`agent.mentioned` events (extracted from `eventLog.rows` after the
   normal action call) in three orders — mention-first, reply-first, concurrent (`Promise.all`) —
   resetting wakeup state between runs, asserting exactly one `reply_to_my_comment` wakeup each time.
7. **F8** — no code change needed (already one resolver, `resolveMentionRecipients` in
   `src/lib/mentions.ts`, used by both `actions/posts.ts` and `actions/comments.ts`).
8. **F2** — DEFERRED, not implemented, per spec instruction.

## Gate results

- `npx tsc --noEmit`: clean for every file in this lane's fence. (Two other lanes' concurrently-
  edited files — `src/__tests__/integration/m11-2-b1-reactions.test.ts`,
  `src/lib/store/webhooks/memory.ts` — showed transient errors mid-edit during this session; none
  are in this lane's fence and a standalone check of this lane's files is clean.)
- `npx eslint <fence files> --max-warnings=0`: 0 errors, 7 pre-existing warnings, all in functions
  this lane did not touch: `completeVetting` (agents/db.ts:1155, complexity 16),
  `deleteAgent` (agents/memory.ts:378, complexity 13), `followAgent` (agents/memory.ts:475,
  complexity 14), `deleteEvaluationMemoryForAgent` (agents/memory.ts:876, complexity 15),
  `completeVetting` (agents/memory.ts:1060, complexity 18), `buildCommentNotification`
  (notifications/memory.ts:165, complexity 16), `listPosts` (posts/db.ts:208, complexity 13).
- `npm test -- src/__tests__/lib/store/hot-score.test.ts src/__tests__/lib/mentions.test.ts
  src/__tests__/lib/events src/__tests__/lib/presence-writer.test.ts
  src/__tests__/lib/agent-public.test.ts src/__tests__/api/v1/agents-presence.test.ts
  src/__tests__/api/v1/feed-cold-start.test.ts src/__tests__/lib/actions
  src/__tests__/lib/agent-senses` (+ the two new store-level test files) — **36 suites, 474 tests,
  all passing** (`--runInBand`). Two earlier runs without `--runInBand` showed one flaky failure
  each (a worker SIGSEGV once, and once a `evaluations.test.ts` assertion tripped by a random test
  id whose generated suffix happened to contain the substring "hi" — confirmed non-reproducible by
  rerunning that file alone: 49/49 pass). Both are infra/random-collision flakes unrelated to this
  lane's changes, outside this lane's fence.
- `npm run test:integration -- src/__tests__/integration/m11-2-b1-mentions.test.ts
  src/__tests__/integration/m11-2-b1-hot-score.test.ts` — **2 suites, 12 tests, all passing** (run
  twice for stability, including once with the mutation-check patches reverted at each step).

## Mutation-check evidence (verbatim)

**F4** (memory): flipped `isPubliclyHiddenAgent` exclusion off and `>` back to `>=` in
`countActiveNowFollowees`. Both new tests failed:
```
● countActiveNowFollowees › excludes a publicly hidden followee, even though it is active
  Expected: 1
  Received: 2
● countActiveNowFollowees › excludes a followee whose last activity is exactly at the threshold
  Expected: 1
  Received: 2
```
Restored; both green again.

**F1** (memory): removed the `if (!post || post.deletedAt) return null;` guard in
`buildMentionNotification`. Both new tests failed:
```
● creates nothing for a post deleted after the consumer's pre-read
  expect(received).toBeNull()
  Received: {"...", "href": "/post/post1", ..., "target": {"id": "post1", "title": "t", ...}}
● creates nothing for a post id that was never inserted
  expect(received).toBeNull()
  Received: {"...", "href": "/post/missing-post", ..., "target": {"id": "missing-post", "title": "Post", ...}}
```
Restored; all three tests green again.

**F1** (db): reverted `MENTION_NOTIFICATION_SELECT` to the pre-fix `LEFT JOIN posts p` (no post lock,
no gate). The new integration test failed:
```
● creates nothing for a post deleted after the consumer's pre-read
  expect(received).toBeNull()
  Received: {"...", "href": "/post/b1m_post_...", "target": {"id": "b1m_post_...", "title": "a post", ...}}
```
Restored; all 6 tests in that describe pass, and the full 8-test file passes.

**F5** (memory, both `posts/memory.ts` and `comments/memory.ts`): reverted the marker check so every
event after the primary always got `source_id` overwritten. Both new tests failed:
```
● createPost fills only the marker...
  Expected: "explicit-source-id"
  Received: "post_1"
● createCommentWithOutcome fills only the marker...
  Expected: "explicit-source-id"
  Received: "comment_1"
```
Restored; both green again.

**F5** (db, both `posts/db.ts` and `comments/db.ts`): reverted `overrides.slice(1)` to the
unconditional `payloadMergeSql` (no marker check). `STORE_ASSIGNED_PAYLOAD_ID` became an unused
import (tsc confirmed: `TS6133` in both files — direct evidence the mutation removed the only
consumer of the marker constant), and the two new integration tests failed:
```
● createPost — keeps a derived event's own source_id when it is not the marker
  Expected: "explicit-source-id"
  Received: "post_1788908682361_kv5emdz"
● createComment — keeps a derived event's own source_id when it is not the marker
  Expected: "explicit-source-id"
  Received: "comment_1788908686026_yyxgpwy"
```
Restored; all 8 tests in that integration file pass, tsc clean.

**F7**: not independently mutation-checked against a reintroduced bug, because the router's
suppression logic (`routeMentioned`/`commentMentionSuppressTarget`) was not changed by this lane —
the finding was a test-coverage gap, not a code defect. The test itself validates the real,
unmodified consumer code directly (not a mock), across three drain orders, which is the assurance
the finding asked for.

**F6**: not a behavioral code fix (test-coverage gap only, per the finding); no mutation-check
applicable. The new integration test does exercise the real SQL formula: it was run against the
actual `hotScoreOrderBy`/`listPosts`/`listFeed` implementations in `src/lib/store/posts/db.ts` and
`src/lib/store/groups/db.ts` and passed on the first attempt with no code changes needed.

## Shared-file edits

- `src/lib/store/notifications/db.ts` / `memory.ts` — mention writer only (`MENTION_NOTIFICATION_
  SELECT`, `buildMentionNotification`). No lines outside the mention writer touched.
- `src/lib/store/agents/db.ts` / `memory.ts` — `countActiveNowFollowees` only.
- No edits to `src/lib/events/kinds.ts`, `coverage.ts`, `store-types.ts`, `notifications.ts` (planner
  switch), `wakeup-router.ts`, `store.ts`, `export-manifest.ts`, `migrate.js`,
  `migration-ledger.ts`, `agent-tools/index.ts`, or `actions/types.ts` — none needed for this
  round's items.
- No new store exports added.
- Ran into two transient collisions from other lanes' concurrent edits (`m11-2-b1-reactions.test.ts`,
  `webhooks/memory.ts` — both outside this lane's fence) as `tsc` noise mid-session; both were the
  other lanes' own in-progress work, not touched or reverted by this lane.

## Out-of-fence needs / cross-lane notes

- None. F2 is explicitly deferred per the spec; no other item required touching a file outside this
  lane's fence.

## Docs delta

None of this round's items change any published API surface, request/response shape, or public
behavior description — F1/F3/F5 are internal correctness fixes with no externally visible contract
change, F4's presence-count fix corrects an internal aggregate to match the already-published
`ACTIVE_NOW_THRESHOLD_MS`/`presenceBucket` semantics (no doc currently claims the old, wrong
behavior), and F6/F7/F8 are test/cleanup-only. No changes proposed for `public/reference.md`,
`public/skill.md`, `public/openapi.json`, `public/planned.md`, or `CLAUDE.md`.

## Behavior changes or plan deviations

- None beyond what the generation-1 agent already recorded in-code (F1/F3/F4/F5/F8 comments). This
  session made no additional behavior changes — only tests, run against the already-fixed code.
