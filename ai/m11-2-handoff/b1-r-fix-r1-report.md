# b1 Lane R — fix round 1 report (reactions)

Generation-2 fix agent. The generation-1 agent was interrupted by a rate limit before writing any
file — confirmed via `git diff -- src/lib/store/reactions src/lib/actions/reactions.ts
src/app/api/v1/posts/[id]/reactions src/app/api/v1/comments/[id]/reactions` (empty) and
`git status --porcelain` for the same paths (empty). No disk-state inventory was needed; all nine
findings were implemented from scratch in this session.

## 1. Deliverables

| # | Finding | State | Files |
|---|---|---|---|
| 1 | F1 — reaction notification survives post deletion | **Done** | `src/lib/store/notifications/db.ts`, `src/lib/store/notifications/memory.ts` |
| 2 | F2 — comment lock can reverse `posts → comments` order | **Done** | `src/lib/store/reactions/db.ts`, `src/lib/store/notifications/db.ts` |
| 3 | F3 — memory mode accepts a withdrawn actor | **Done** | `src/lib/store/reactions/memory.ts` |
| 4 | F4 — deletion tests do not exercise real races | **Done** | `src/__tests__/integration/m11-2-b1-reactions.test.ts` |
| 5 | F5 — concurrent duplicate can report `rate_limited` | **Done** | `src/lib/store/reactions/db.ts` |
| 6 | F6 — seed and reaction write in separate transactions | **Done** | `src/lib/store/reactions/db.ts` |
| 7 | F7 — removal omits the subject-liveness gate | **Done**, both stores | `src/lib/store/reactions/db.ts`, `src/lib/store/reactions/memory.ts` |
| 8 | F8 — JSON `null` body throws instead of 400 | **Done**, both routes | `src/app/api/v1/posts/[id]/reactions/route.ts`, `src/app/api/v1/comments/[id]/reactions/route.ts` |
| 9 | F9 — misleading SQL comment | **Done** | `src/lib/store/reactions/db.ts` |

### Code changes, by file

- **`src/lib/store/reactions/db.ts`**
  - `addReactionStatementText`/new `removeReactionStatementText`: both now open with a `live_post`
    CTE locked `FOR SHARE` (post case) or resolved via a `posts` subquery keyed off the comment's
    `post_id` then locked `FOR SHARE` (comment case); the `subject` CTE selects `FROM live_post`
    (post) or `FROM live_post JOIN comments` (comment) — a dependent CTE runs after the one it reads,
    so the post lock is always attempted before the comment's (F2). **The lock mode is the load-
    bearing detail**: `FOR KEY SHARE` (the original mode) is *compatible* with the `FOR NO KEY
    UPDATE` `deletePost`'s tombstone takes — verified empirically, see mutation-check below — so it
    never actually waited for a concurrent delete. `FOR SHARE` does conflict with `FOR NO KEY
    UPDATE` and genuinely blocks.
  - `removeReactionStatementText`'s `DELETE` now carries `AND EXISTS (SELECT 1 FROM subject)` (F7):
    removal against a tombstoned post or its comment matches nothing and emits nothing.
  - `addReaction` is now one `sql!.transaction` batch (F5/F6): statement 1 seeds+locks
    `agent_rate_limits` (`ON CONFLICT ... DO UPDATE`, holding the row lock to commit); statement 2
    is the unchanged decisive CTE text. Events are rendered (and validated, via
    `emitEventCtes`/`validatePreparedEvent`) **before** either statement runs, so a bad event leaves
    no orphan seed row.
  - The misleading "two sibling UPDATEs... verified empirically" comment (F9) is replaced with the
    general Postgres rule and a link to the WITH-queries docs, ≤ 4 lines.
- **`src/lib/store/notifications/db.ts`** — `reactionNotificationSelectSql` restructured the same
  way as the reactions statement: `live_post` CTE locked `FOR SHARE` first (already correct — this
  file did not have the `FOR KEY SHARE` mistake), `subj` CTE joins from it for the comment case
  (F2), and `subj.post_id` is now selected in both branches and spliced into
  `metadata.post_id` (F1) — the anchor `deleteNotificationsAnchoredToPost` reads.
- **`src/lib/store/notifications/memory.ts`** — `buildPostReactionNotification` and
  `buildCommentReactionNotification` both now stamp `metadata.post_id` (the post itself, or the
  comment's own `postId`) (F1). No other lines in this shared file were touched.
- **`src/lib/store/reactions/memory.ts`**
  - `addReaction`: a new `agents.has(input.agentId)` check, placed immediately before
    `prepareEventBatch`/the mutation (after the duplicate and cap checks, which are reads), answers
    `not_found` for a withdrawn actor (F3).
  - `removeReaction`: `removed` now requires `contentReactions.has(key) && isSubjectLive(...)` (F7).
- **`src/app/api/v1/posts/[id]/reactions/route.ts`**,
  **`src/app/api/v1/comments/[id]/reactions/route.ts`** — `body` is now typed `unknown`; both
  `POST`/`DELETE` refuse with 400 before any property read when `typeof body !== "object" || body
  === null` (F8).

## 2. Gate results

```
$ npx tsc --noEmit
(no output for any file in this fence; the only pre-existing errors are in
 src/__tests__/integration/m11-2-b1-webhooks.test.ts, lane W's fence, unrelated to this change)

$ npx eslint src/lib/store/reactions/db.ts src/lib/store/reactions/memory.ts \
    src/lib/store/notifications/db.ts src/lib/store/notifications/memory.ts \
    "src/app/api/v1/posts/[id]/reactions/route.ts" "src/app/api/v1/comments/[id]/reactions/route.ts" \
    src/__tests__/lib/store/reactions-memory.test.ts src/__tests__/api/reactions-routes.test.ts \
    src/__tests__/integration/m11-2-b1-reactions.test.ts --max-warnings=0

/Users/mohsin/Github/safemolt/src/lib/store/notifications/memory.ts
  165:1  warning  Function 'buildCommentNotification' has a complexity of 16. Maximum allowed is 12  complexity

✖ 1 problem (0 errors, 1 warning)
```
`buildCommentNotification` is **pre-existing** and untouched by this lane — confirmed via
`git diff -- src/lib/store/notifications/memory.ts | grep buildCommentNotification` (no hits) before
any of this lane's edits landed. It belongs to lane M's mention/comment-notification surface.

```
$ npm test -- src/__tests__/lib/store/reactions-memory.test.ts src/__tests__/api/reactions-routes.test.ts \
    src/__tests__/lib/events src/__tests__/lib/karma-writer-ownership.test.ts \
    src/__tests__/lib/group-school-gate.test.ts

Test Suites: 12 passed, 12 total
Tests:       215 passed, 215 total
```

```
$ npm run test:integration -- src/__tests__/integration/m11-2-b1-reactions.test.ts

PASS src/__tests__/integration/m11-2-b1-reactions.test.ts (~51-56s)
  post reactions vs deletePost — both orderings
    ✓ delete-first (real overlapping transaction): addReaction blocks on the tombstone, then is not_found
    ✓ delete-first (real overlapping transaction): removeReaction against a live row blocks on the tombstone, then is not_found and leaves the row untouched
    ✓ reaction-first: the reaction succeeds, its drained notification exists, and the subsequent delete removes both in the same transaction
  comment reactions vs deletePost — both orderings
    ✓ delete-first (real overlapping transaction): addReaction blocks on the tombstone, then is not_found
    ✓ delete-first (real overlapping transaction): removeReaction against a live row blocks on the tombstone, then is not_found and leaves the row untouched
    ✓ reaction-first: the reaction succeeds, its drained notification exists, and the subsequent delete removes both in the same transaction
  concurrent duplicate reacts
    ✓ N racing adds of the exact same (agent, subject, emoji) leave one row, one event, one quota increment
    ✓ F5/F6: two identical requests with exactly one slot left never answer rate_limited — one added, one already_reacted
  delayed-consume: a reaction.added event that drains after its subject is gone
    ✓ produces no notification and still receipts cleanly
  rate limit through both surfaces
    ✓ a capped add through either surface writes nothing and emits nothing; DELETE stays uncapped through both
  deletePost's reaction cleanup runs in the same transaction as the tombstone
    ✓ removes a post reaction and a comment reaction together when the post is deleted

Test Suites: 1 passed, 1 total
Tests:       11 passed, 11 total
```
Ran solo (advisory lock acquired without contention); re-ran the full file three times across the
session (after each mutation-check restore) with identical results.

## 3. Mutation-check evidence, verbatim

**F2 (lock mode, the real defect under the stated remedy).** Initially implemented the fix keeping
the original `FOR KEY SHARE` mode (matching pre-existing code) and only added the CTE ordering
dependency. The new "delete-first (real overlapping transaction)" integration tests **failed**:
```
● post reactions vs deletePost — both orderings › delete-first ...: addReaction blocks on the tombstone, then is not_found
  expect(race.observedBlocked).toBe(true)
  Expected: true
  Received: false
```
Diagnostic logging showed `addReaction` completed successfully (`"result":{"ok":true,...}`) against
a post whose tombstone UPDATE was concurrently open and uncommitted on another connection —
`FOR KEY SHARE` is compatible with `FOR NO KEY UPDATE` (verified independently with a bare
`SELECT ... FOR KEY SHARE` vs `SELECT ... FOR NO KEY UPDATE` probe against the same held lock: the
former never blocked, the latter did, `observedBlocked: true`). Switched `live_post`'s lock mode to
`FOR SHARE` (per the fix spec's literal wording, which I had initially glossed over) — all 4 races
(add/remove × post/comment) now pass with `observedBlocked: true`. Mutation-check: reverted the
comment-case branch back to `FOR KEY SHARE` — the two "comment reactions" race tests failed again
with the same `observedBlocked: false`; restored `FOR SHARE` — green again.

**F1 (notification `post_id`).** Removed `'post_id', subj.post_id` from the metadata
`jsonb_build_object` in `reactionNotificationSelectSql`. The "reaction-first" integration test (react
→ drain → delete) failed for both surfaces:
```
● ... reaction-first: ... › expect(notifAfter).toEqual([])
  - Array []
  + Array [ Object { "?column?": 1 } ]
```
Restored the field — both pass again.

**F7 (db removal gate).** Removed `AND EXISTS (SELECT 1 FROM subject)` from `removeReaction`'s
`DELETE`. The "removeReaction against a live row" race tests for both surfaces failed at
`observedBlocked` (Postgres pruned the now-unreferenced `live_post`/`subject` CTEs entirely, so
neither the lock nor the gate existed — an even stronger failure mode than a live-but-ineffective
gate). Restored the clause — both pass again.

**F3 (memory actor re-check).** Removed the `agents.has(input.agentId)` block from
`reactions/memory.ts`'s `addReaction`. The new "F3" unit test failed:
```
Expected: "not_found"
Received: "added"
```
Restored — passes again.

**F7 (memory removal gate).** Changed `removed = contentReactions.has(key) && isSubjectLive(...)`
back to `removed = contentReactions.has(key)`. The new "F7" unit test failed:
```
Expected: "not_found"
Received: "removed"
```
Restored — passes again.

**F8 (JSON null body).** Removed the `typeof body !== "object" || body === null` guard from the post
route. The new "JSON null body" tests failed with the forbidden state itself, not merely a wrong
status code:
```
TypeError: Cannot read properties of null (reading 'emoji')
  at Object.emoji [as POST] (.../route.ts:58:49)
```
Restored — passes again (both routes, both methods, verified for the posts route directly and the
comments route by code symmetry + its own green run).

**F5/F6.** I could not construct a mutation that reliably distinguishes the fix via
`raceAgainstHeldLock`: an external "fake winner" (raw SQL simulating a whole concurrent
`addReaction`) makes the loser's statement 1 block and then run statement 2 with a fresh snapshot
**regardless of whether the two statements share a `sql.transaction`**, because JS `await` already
sequences them and each is a genuinely separate Postgres statement (fresh READ COMMITTED snapshot)
either way. I proved this by reverting `addReaction` to two separate auto-committed calls (the
exact pre-fix shape) and re-running that harness test — it still passed. The actual bug (per the
finding) is a **single combined statement's** internal snapshot behavior: `pre`'s `FOR UPDATE`
re-fetches only the locked `agent_rate_limits` row after its wait, while `existing` (reading
`content_reactions`, unlocked) keeps the statement's original pre-wait snapshot. Reproducing that
specific interleaving needs two REAL concurrent `addReaction` calls contending on `pre`'s lock
inside the same statement, which is exactly what the retained `runConcurrently`-based "F5/F6" test
exercises (real Neon HTTP driver concurrency) — but it is inherently probabilistic (it did not
reproduce the bug against a `DO NOTHING`-only mutation in my testing either, in either direction).
I removed my non-discriminating deterministic test rather than keep a mutation-check that doesn't
actually mean anything; the structural fix (statement 1 fully separate from statement 2, matching
`addSessionMessage`'s documented precedent in `evaluations/db.ts`) is correct by inspection and by
analogy to that precedent, but F5/F6 do not have real mutation-check evidence beyond that. Flagged
under "not done" below.

## 4. Shared-file edits (collision protocol)

- `src/lib/store/notifications/db.ts` — touched only `reactionNotificationSelectSql` (the reaction
  writer). Re-read immediately before each edit; no collisions with lanes M/D's own writers in this
  file (their edits landed in other functions, confirmed by grep before and after each of my edits).
- `src/lib/store/notifications/memory.ts` — touched only `buildPostReactionNotification` and
  `buildCommentReactionNotification`. Same re-read discipline; a "file changed on disk" notice fired
  twice mid-session (other lanes editing elsewhere in the file) and both times my prior edits were
  confirmed intact by grep before proceeding.
- `src/lib/store/posts/{db,memory}.ts` — **not touched**. No finding required a `deletePost` change.
- No new store exports were added (existing `addReaction`/`removeReaction`/`getReactionCounts`
  exports, already classified in `export-manifest.ts` by whichever lane first wired reactions).

## 5. Out-of-fence needs and cross-lane notes

- None identified. `getReactionCounts`, `deleteReactionsForPostBatchElement` and the reactions tool
  executors (`src/lib/agent-tools/definitions/reactions.ts`) were read but needed no changes for any
  of the 9 findings.

## 6. Docs delta

None of the 9 findings change agent-visible behavior in a way `public/reference.md`,
`public/skill.md`, `public/openapi.json`, or `public/planned.md` need to reflect — the reaction
endpoints' request/response shapes, status codes, and refusal codes (`not_found`, `already_reacted`,
`rate_limited`, `bad_request`) are unchanged; only internal correctness (lock ordering, transaction
shape, a cleanup anchor, a race window, an input-validation edge case) moved.

Suggested `agents.md`/`CLAUDE.md` invariant addition (for the docs agent to apply verbatim, house
style):

> **`FOR KEY SHARE` is not a delete-liveness gate.** It is compatible with the `FOR NO KEY UPDATE`
> an ordinary `UPDATE` takes (including `deletePost`'s tombstone), so a writer that needs to WAIT
> for a concurrent soft-delete to resolve before trusting `deleted_at IS NULL` must lock the subject
> `FOR SHARE` (or stronger), never `FOR KEY SHARE` — verified empirically against this schema
> (`reactions/db.ts`, M11b lane R fix round 1, F2).

## 7. Behavior changes or plan deviations

- **Lock mode changed from `FOR KEY SHARE` to `FOR SHARE`** for the reactions' post-liveness check
  (both `addReaction` and `removeReaction`, both stores' notification writer already used `FOR
  SHARE`). This is a genuine behavior change: reactions now serialize against `deletePost` (and
  against `createComment`'s own post lock, and against each other's tombstone-adjacent locks) where
  they previously did not block at all. This is required for F2's stated remedy to have any effect;
  see the F2 mutation-check above for why the originally-planned "just reorder the CTEs" fix was
  insufficient on its own.
- **F5/F6 has no positive mutation-check evidence**, as documented in section 3. The structural fix
  (one `sql.transaction`, statement 1 = seed+lock, statement 2 = decisive) is implemented exactly as
  the design note specified and is not, in my assessment, wrong — but I could not construct a test
  that fails without it and passes with it. Recorded here rather than claimed as verified.
- No other deviations. All other findings implement the spec's stated remedy directly.
