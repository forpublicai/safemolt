# b1 Lane M — codex round-5 fix report (mentions / presence / hot)

All four findings from `ai/m11-2-handoff/codex-findings-b1-m-round5.md` closed. Round-1 F2
deferral (`wakeup-router.ts:254`) stays untouched, per the upheld verdict (upheld a fifth time).
Item 5 (whole-fence audit) completed — see section 5.

## Deliverables

1. **F1** (`notifications/db.ts`) — `createMentionNotificationIdempotent` (db) is now one
   `sql.transaction` of THREE ordered statements instead of one statement whose three subqueries
   had no fixed evaluation order: `MENTION_POST_LOCK_STATEMENT` (post `FOR SHARE`),
   `MENTION_COMMENT_LOCK_STATEMENT` (comment source `FOR SHARE`, only when `commentId` is
   supplied), then `MENTION_INSERT_STATEMENT` (recipient `FOR SHARE` + the idempotent insert,
   re-taking all three locks for free). Statement order is now a protocol guarantee, not a planner
   choice.
   - Test: `codex round 5 F1` in `m11-2-b1-mentions.test.ts` — a holder mirrors a real post-vote
     transaction (locks the post, then the author's agent row — the SAME agent as the mention's
     recipient) and holds both; the writer is proven to be waiting on the POST statement while
     never reaching the recipient lock (`waitForWaiter`/`waitersOn` against the two markers), then
     completes with no `40P01` once released.

2. **F2** (`m11-2-b1-mentions.test.ts`) — new test `codex round 5 F2`: holds an uncommitted
   `DELETE FROM comments` open, starts the writer with that `commentId`, asserts it blocks on
   `race:b1m-mention-comment-lock` (not merely on the predicate), commits the delete, asserts the
   writer refuses (`null`).

3. **F3** (`agent-visibility-sql.ts`, `agents/db.ts`, `notifications/db.ts`) — new shared module
   `src/lib/store/agent-visibility-sql.ts` exports `HIDDEN_AGENT_PREDICATE` (moved out of
   `agents/db.ts`, which now imports it); the mention writer's `target` CTE imports the same
   constant instead of carrying its own inline copy. One definition, two consumers.

4. **F4** (`notifications/db.ts`) — the mention-writer doc comment is 5 lines, states only the
   three locks, the order guarantee and the terse-text reason; the stale claim about a
   `JOIN`/`ON` gate the SQL never had (falsified by F1) is gone, along with the repair-history
   list.

## Gate results

- `npx tsc --noEmit`: 0 errors in any file this lane touched. Two other lanes' concurrent WIP
  errors were observed across repeated runs, never in this lane's files: a persistent
  `agent-pulse/runner.test.ts` `streamSeq` type mismatch and a persistent
  `m11-2-b1-webhooks.test.ts` unused-import error (both lane S/lane W's own round-5 work,
  in progress at the time of this report), plus two transient errors (an `activity/events.ts`
  `emitFrame` property and an `inbox-classes.test.ts` name error) that were gone on the next
  run — both from lanes S's edits landing between reads.
- `npx eslint src/lib/store/agents/db.ts src/lib/store/notifications/db.ts
  src/lib/store/agent-visibility-sql.ts src/__tests__/integration/m11-2-b1-mentions.test.ts
  src/__tests__/integration/m11-2-b1-presence.test.ts
  src/__tests__/lib/store/mention-notification-liveness.test.ts --max-warnings=0`: 0 errors, 1
  pre-existing warning this lane did not touch — `completeVetting` (`agents/db.ts:1185`,
  complexity 16, flagged identically in rounds 3 and 4).
- `npm test -- src/__tests__/lib/mentions.test.ts src/__tests__/lib/events
  src/__tests__/api/v1/agents-presence.test.ts src/__tests__/lib/store src/__tests__/lib/actions
  src/__tests__/lib/agent-public.test.ts --runInBand`: 68 suites / 760 tests, all passing (final
  run, after the frame-CTE integration fix below).
- `npm run test:integration -- src/__tests__/integration/m11-2-b1-mentions.test.ts
  src/__tests__/integration/m11-2-b1-presence.test.ts`, run TWICE at the final state: 19/19 both
  times.
  ```
  PASS src/__tests__/integration/m11-2-b1-mentions.test.ts
  PASS src/__tests__/integration/m11-2-b1-presence.test.ts
  Test Suites: 2 passed, 2 total
  Tests:       19 passed, 19 total
  ```
  (repeated a second time with the same 19/19 result)

## Mutation-check evidence (verbatim)

**F1** — reverted `createMentionNotificationIdempotent` to a single `sql!(...)` call against
`MENTION_INSERT_STATEMENT` alone (no `sql.transaction`, no separate lock statements):
```
FAIL src/__tests__/integration/m11-2-b1-mentions.test.ts
  createMentionNotificationIdempotent (db) — codex round 5 F1
    ✕ blocks on the post statement (never the recipient) while a vote-shaped transaction holds
      both, then completes with no deadlock
    expect(received).toBe(expected)
    Expected: true
    Received: false
      > expect(await waitForWaiter(holderPid, "race:b1m-mention-post-lock")).toBe(true);
```
Restored the three-statement transaction. Re-run: `✓ ... (2233 ms)`.

**F2** — same mutation removed only the comment-lock statement from the array (statement 3 still
re-locks the comment internally, but without the separate marker):
```
FAIL ... codex round 5 F2
  ✕ blocks on an uncommitted comment deletion, then refuses once it commits
    expect(race.observedBlocked).toBe(true)
    Expected: true
    Received: false
```
Restored the statement. Re-run: `✓ ... (5020 ms)`.

**F3** — changed the shared `HIDDEN_AGENT_PREDICATE` to the literal `true` (always-visible) to
prove BOTH consumers read the one definition:
```
FAIL src/__tests__/integration/m11-2-b1-presence.test.ts
  listAgents(sort, "active_now", limit) — codex round 3 F1
    ✕ returns a visible active agent behind more hidden active agents than the limit
  listAgents(sort, "active_now", limit) — codex round 4 F3
    ✕ excludes a JSON boolean true but not a string "true", absent, or JSON null metadata
FAIL src/__tests__/integration/m11-2-b1-mentions.test.ts
  createMentionNotificationIdempotent (db) — codex round 3 F2
    ✕ creates nothing for a recipient visible at emit but hidden before the drain
```
Both files fail from the one change, proving the sharing. Restored the real predicate; both
files pass again.

**F4**: pure comment/refactor, no independent behavioral test — covered by the F1/F2 integration
runs above passing unchanged.

**Integration correctness catch during this round**: after landing F1-F4, `npm run
test:integration` failed with `NeonDbError: syntax error at or near "ins"` — Lane S had, between
my read and my edit, added a `stream_frames` "frame CTE" to every OTHER notification writer in
this file (`notificationFrameCte`, wired through `insertNotificationFromSelect`). My rewritten
mention writer no longer routed through that helper, so it would have silently regressed SSE
frame emission for mentions once Lane S's change landed. Re-read the file (collision protocol),
wrapped the mention INSERT in its own `ins AS (...)` CTE, and appended
`${notificationFrameCte("ins", "frame")}` — matching the convention Lane S established for every
other writer. First attempt had a missing comma after the `target AS (...)` CTE (caught by the
same syntax error); fixed, then both mutation-checked round-5 tests were shown FAILING again
against a reverted `createMentionNotificationIdempotent` at the FINAL (frame-CTE-included) code
to confirm the fix still holds with Lane S's addition, then restored and re-verified 19/19 twice.

## Shared-file edits

- `src/lib/store/notifications/db.ts` — re-read immediately before every edit per the collision
  protocol; edited ONLY the mention writer (`MENTION_POST_LOCK_STATEMENT`,
  `MENTION_COMMENT_LOCK_STATEMENT`, `MENTION_INSERT_STATEMENT`,
  `createMentionNotificationIdempotent`) plus the import line (dropped unused `TEST_NAME_PATTERN`,
  added `HIDDEN_AGENT_PREDICATE`). Lane S's concurrent additions elsewhere in the same file
  (`notificationFrameCte`, the `withFrame` parameter, `createNotification`,
  `buildFollowNotificationCte`, `insertNotificationFromSelect`) were left untouched except that
  the mention writer now calls `notificationFrameCte` too, matching the convention — see the
  integration-catch note above.
- No edits to `src/lib/store/notifications/memory.ts` (owned by Lane S this round; the mention
  writer's memory twin needed no change since F1/F2 are Postgres-lock concerns with no memory-store
  analogue).
- New file `src/lib/store/agent-visibility-sql.ts` (not a listed shared-file anchor; a new flat
  module beside `execution-guard.ts`/`hot-score.ts`, per the spec's "or a tiny shared module under
  `src/lib/store/`" option).
- `src/lib/store/agents/db.ts`: removed the local `HIDDEN_AGENT_PREDICATE` const and its now-unused
  `TEST_NAME_PATTERN` import; imports the shared one instead. No other change.
- No entries added to any `b1-common-rules.md` shared-file table (no kinds, coverage manifests,
  store exports, migrations, or tool registrations touched).

## Whole-fence audit (policy item 2, deliverable 5)

Walked every statement in lane M's fence against the two rules (statement-order locks with the
actor row first where an actor FK is taken, then posts → comments → agents; liveness is `FOR
SHARE`, never a bare `EXISTS`) and reviewed the fence's existing behavioral tests for the
mutation-fails-first bar.

- **`src/lib/store/notifications/db.ts` (mention writer)** — fixed by F1-F4 above.
- **`src/lib/store/agents/db.ts`** (reads plus every write with a lock) — every explicit row lock
  (`listAgents` has none; `followAgent`, vetting, name-release, claim writers) targets exactly one
  agent id per statement via a single-row `FOR UPDATE`/`FOR KEY SHARE`/`FOR NO KEY UPDATE`, so
  there is no multi-table independent-subquery ordering hazard of the kind F1 fixed.
  `deleteAgent`'s withdrawal batch (`~1505-1509`) already locks `posts` then `comments` then
  `agents`, matching the rule exactly — it is the canonical example this round's fix now mirrors.
  Audit found nothing to change beyond the F3 predicate relocation.
- **`src/lib/store/posts/db.ts` createPost** — one INSERT/CTE statement; the only agent-row touch
  is the acting author's own row via the `agent_rate_limits` FK (the cap CTE), so there is no
  second, different agent row in play and no ordering hazard. Spot-checked the file's other
  lock-bearing statements in the same fence (`deletePost`, `pinPost`, `castPostVote`,
  `recordVote`'s comment-vote twin in `comments/db.ts`): each takes its real lock
  (`FOR UPDATE`/`FOR SHARE`/`FOR NO KEY UPDATE`) on a named CTE BEFORE any `EXISTS` reference to
  that same CTE — e.g. `pinPost`'s `locked_post AS (... FOR SHARE)` feeding
  `EXISTS (SELECT 1 FROM locked_post)`, and `deletePost`'s statement-1 `FOR UPDATE` on the post held
  for the whole transaction while statements 2-6 re-read `deleted_at IS NULL` under that same held
  lock rather than a fresh, unlocked snapshot. No bare `EXISTS` substituting for a lock was found.
  Audit found nothing to change.
- **`src/lib/store/comments/db.ts` createComment** — statement 1 pre-locks the post
  `FOR NO KEY UPDATE` before statement 2 (parent check, rate-limit claim, comment insert) touches
  any agent row; the two agent-row touches in statement 2 (`agent_rate_limits.agent_id` FK, then
  `comments.author_id` FK) are the SAME acting agent, so there is no second row to cross-order
  against. The comment-vote statement's `live_parent` CTE takes `FOR SHARE OF p` before its
  `EXISTS` reference. Audit found nothing to change.
- **Hot sorts (`src/lib/store/hot-score.ts`)** — pure `ORDER BY` text and a TS-twin formula; no
  statements, no locks, nothing for the lock-order rule to apply to. The characterization tests
  compare against hand-computed values and fail on any formula change by construction. Audit found
  nothing to change.

Behavioral-test mutation bar: the four fence tests directly exercised this round (F1, F2, F3 x2)
were shown failing under mutation above. The remaining fence tests (rounds 1-4's own F1/F2/F3
db-lock and predicate tests in `m11-2-b1-mentions.test.ts` and `m11-2-b1-presence.test.ts`) were
re-run unchanged as part of every gate pass in this report and were not independently
re-mutation-tested this round — their own mutation evidence is recorded in
`ai/m11-2-handoff/b1-m-fix-r{1,2,3,4}-report.md`.

## Out-of-fence needs and cross-lane notes

None new. Lane S is actively editing `src/lib/store/notifications/{db,memory}.ts` and
`src/lib/store/dms/*`, `src/lib/store/wakeups/*`, `src/lib/agent-pulse/runner.ts`,
`src/lib/agent-senses/inbox.ts` concurrently — several transient `tsc` errors were observed and
resolved on their own between reads; none were caused by this lane and none required action here
beyond the frame-CTE compatibility fix recorded above.

## Docs delta

None. This round only changes internal lock structure, a shared SQL fragment, and test coverage;
no new agent-visible API surface, request/response shape, or behavior change from the agent's
point of view.

## Behavior changes or plan deviations

One deviation beyond the spec's literal file list: the spec named `agents/db.ts` or "a tiny
shared module under `src/lib/store/`" for F3; a new file `src/lib/store/agent-visibility-sql.ts`
was created (the module option) rather than exporting from `agents/db.ts`, because
`agents/db.ts` already imports from `notifications/db.ts` and exporting the predicate the other
way would have created a circular import between the two files. No other deviations. The
frame-CTE integration fix (wiring `notificationFrameCte` into the mention writer) was not in the
spec's four findings but was necessary to keep the mention writer consistent with Lane S's
concurrent, in-flight change to every other writer in the same file — recorded above as a
cross-lane compatibility fix, not a behavior change this lane's spec asked for.
