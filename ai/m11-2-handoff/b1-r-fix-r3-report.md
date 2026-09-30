# b1 Lane R — fix round 3 report (reactions)

All six items from `codex-findings-b1-r-round3.md` implemented.

## 1. Deliverables

| # | Finding | State | Files |
|---|---|---|---|
| 1 | F1 — reaction tools/actions/stores discard the execution guard | **Done** | `src/lib/store/reactions/db.ts`, `src/lib/store/reactions/memory.ts`, `src/lib/actions/reactions.ts`, `src/lib/agent-tools/definitions/reactions.ts`, both route files |
| 2 | F2 — a new rate row reverses the lock order (posts -> comments -> agents) | **Done** | `src/lib/store/reactions/db.ts` |
| 3 | F3 — reaction-first race remains sequential | **Done** | `src/__tests__/integration/m11-2-b1-reactions.test.ts` |
| 4 | F4 — memory checks event uniqueness before refusals | **Done** | `src/lib/store/reactions/memory.ts` |
| 5 | F5 — test deferral unresolved (uncommitted-seed hold proves nothing) | **Done** | `src/__tests__/integration/m11-2-b1-reactions.test.ts` |
| 6 | F6 — long comment essay in `db.ts` | **Done** | `src/lib/store/reactions/db.ts` |

### Code changes, by file

- **`src/lib/store/reactions/db.ts`**
  - `addReaction` is now a **three-statement** `sql.transaction` (F2): statement 1
    (`subjectOnlyLockStatementText`) locks the live subject alone (`FOR SHARE`, post directly or a
    comment's post) — no write; statement 2 is the seed (unchanged text, same `FOR NO KEY UPDATE`
    non-key no-op from round 2's F1); statement 3 is the unchanged decisive statement, which now
    re-takes both locks for free. The seed's actor-FK `FOR KEY SHARE` now always comes AFTER the
    subject lock, keeping the global order `posts -> comments -> agents` — previously a brand-new
    rate row's INSERT locked `agents` (via its own FK check) before the reaction ever touched the
    post, crossing a withdrawal's `posts -> agents` order and deadlocking (40P01).
  - Both `addReaction` and `removeReaction` now accept an optional `executionGuard: ExecutionGuard`
    (F1), threaded through `buildExecutionGuardCte` exactly as `sendDm`/`createComment` do: rendered
    LAST (after every event param), spliced into the decisive statement's `WITH` list, and gating
    the mutation — `addReaction`'s `inserted` CTE cross-joins `guard` in its `FROM` list;
    `removeReaction`'s `DELETE` gains `AND EXISTS (SELECT 1 FROM guard)`. Both project
    `guard_passed`, checked FIRST in the outcome classification (matching `sendDm`'s precedence).
  - `AddReactionOutcome`/`RemoveReactionOutcome` gained `"execution_guard_failed"`.
  - The seed statement's inline comment shrunk from 6 lines of review history to 3 lines, WHY-only
    (F6); the decisive statement's own now-redundant `live_post` lock comment (superseded by
    statement 1's) was removed rather than kept as a duplicate.
- **`src/lib/store/reactions/memory.ts`**
  - `addReaction`/`removeReaction` now call `validatePreparedEvents(events)` — shape only — as the
    FIRST thing, before any refusal, and `prepareEventBatch(events)` (the full idemKey preflight)
    only immediately before the actual mutation (F4). Previously `prepareEventBatch` ran up front,
    so a conflicting `idemKey` against a MISSING subject threw `23505` in memory where Postgres
    would answer `not_found` (its event insert is gated on the same `inserted`/`deleted` row the
    subject check gates, so it never even attempts the conflicting insert).
  - Both functions accept `executionGuard?: ExecutionGuard`, checked via `executionGuardPasses`
    immediately after `validatePreparedEvents` and before every other refusal (F1) — matching
    `sendDm`'s memory precedence, since (unlike `createComment`) reactions have no separate initial
    subject-existence statement for the guard to be ordered against.
- **`src/lib/actions/reactions.ts`** — `ReactionInput` gained `executionGuard?: ExecutionGuard`,
  threaded into both `storeAddReaction`/`storeRemoveReaction` calls; both `addReaction`/
  `removeReaction` actions answer `actionError("execution_guard_failed", ...)` for the new outcome.
- **`src/lib/agent-tools/definitions/reactions.ts`** — both executors destructure
  `executionGuard` from their context and forward it; `reactionToolRefusal` gained a case.
- **`src/app/api/v1/posts/[id]/reactions/route.ts`**, **`.../comments/[id]/reactions/route.ts`** —
  one `case "execution_guard_failed"` each (unreachable from a route, which never supplies a guard;
  named explicitly rather than falling into the `bad_request` default, mirroring the comments
  route's own precedent).
- **`src/__tests__/integration/m11-2-b1-reactions.test.ts`**
  - F3: the "reaction-first" test now holds a SECOND reactor's add OPEN (uncommitted, on a raw `pg`
    connection reproducing `addReaction`'s exact lock shape) and asserts `deletePost` genuinely
    BLOCKS on it (`d1:post-delete-lock`, the marker on `deletePost`'s own first statement in
    `posts/db.ts`) before cleaning up both that reaction and a separately drained notification from
    a first, real `addReaction` call — replacing the old fully-sequential version the finding named.
  - F5: rewritten to commit the rate row FIRST (a plain `pgPool().query` insert, not the seed) and
    then hold a real `FOR NO KEY UPDATE` lock on that ALREADY-COMMITTED row while two real
    `addReaction` calls contend — the old version held an UNCOMMITTED insert, which any writer must
    wait for regardless of the fix (round 2's own mutation-check already showed this test passed
    even against a full revert to two auto-committed statements).
  - New `describe("F2: a self-reaction with no existing rate row does not deadlock with a
    withdrawal...")`: a genuine two-connection reproduction — a raw connection takes
    `deleteAgent`'s own first lock (`d1:agent-delete-post-lock`), waits (via `waitForWaiter`) until
    a real `addReaction` call is observed queued behind it, then runs the rest of `deleteAgent`'s
    real steps inline, asserting neither side ever raises `40P01`.
  - New `describe("F1: the execution guard gates the decisive statement (db, codex round 3)")`: one
    `addReaction` and one `removeReaction` case, each with a real claimed wakeup
    (`claimNextWakeup`/`enqueueWakeup`), asserting a live claim succeeds and a claim disabled before
    the write answers `execution_guard_failed`, writing and emitting nothing.

## 2. Gate results

```
$ npx tsc --noEmit
(clean for every file in this fence; the one remaining error,
 src/lib/store/dms/db.ts(161,9): 'guard1' is declared but its value is never read,
 is lane D's own file, actively being edited concurrently — confirmed out of fence and
 unrelated by re-checking after this lane's own edits landed)

$ npx eslint src/lib/store/reactions/db.ts src/lib/store/reactions/memory.ts \
    src/lib/actions/reactions.ts src/lib/agent-tools/definitions/reactions.ts \
    "src/app/api/v1/posts/[id]/reactions/route.ts" "src/app/api/v1/comments/[id]/reactions/route.ts" \
    src/__tests__/lib/store/reactions-memory.test.ts src/__tests__/api/reactions-routes.test.ts \
    src/__tests__/integration/m11-2-b1-reactions.test.ts --max-warnings=0
(clean — no errors, no warnings)

$ npm test -- src/__tests__/lib/store/reactions-memory.test.ts src/__tests__/api/reactions-routes.test.ts \
    src/__tests__/lib/events src/__tests__/lib/agent-tools src/__tests__/lib/karma-writer-ownership.test.ts
Test Suites: 17 passed, 17 total
Tests:       238 passed, 238 total
```

Integration file, run twice against the fully-finished file, back to back, both solo (advisory lock
uncontended in each):

```
$ npm run test:integration -- src/__tests__/integration/m11-2-b1-reactions.test.ts   (run 1)
PASS src/__tests__/integration/m11-2-b1-reactions.test.ts
Test Suites: 1 passed, 1 total
Tests:       21 passed, 21 total
Time:        82.399 s

$ npm run test:integration -- src/__tests__/integration/m11-2-b1-reactions.test.ts   (run 2)
PASS src/__tests__/integration/m11-2-b1-reactions.test.ts
Test Suites: 1 passed, 1 total
Tests:       21 passed, 21 total
```

(Two earlier full-file runs against intermediate states of this fix — 19/19 before the two new
`describe` blocks below were added, then a transient failure while the `agent_loop_state` seed and
the `eventsSince` filter in the new F1/F2 tests were still being hardened — are superseded by these
two clean 21/21 runs against the final file.)

## 3. Mutation-check evidence, verbatim

**F2 (three-statement lock order).** Reverted `addReaction` to a two-statement transaction (seed
first, decisive second — the pre-round-3 order), keeping the seed's own `FOR NO KEY UPDATE` fix from
round 2 intact. Re-ran the new "F2: a self-reaction..." test:
```
● F2: a self-reaction with no existing rate row does not deadlock with a withdrawal (codex round 3)
    › addReaction queues behind a held withdrawal post-lock and both sides resolve without a 40P01

  expect(received).not.toBe(expected) // Object.is equality
  Expected: not "40P01"
    > expect(holderError?.code).not.toBe("40P01");
```
A genuine `40P01` was raised on the withdrawal side — exactly the cycle the finding describes:
the reaction's seed (now running first) grabs `agents(author)` via its own FK check; withdrawal's
`DELETE FROM agents` then waits on THAT lock while the reaction's decisive statement waits on
withdrawal's already-held post lock. Restored the three-statement order — green again
(`holderError.code === "23503"`, `reactionSettled.value.ok === true`, no `40P01` either side).

**F1 (execution guard, db, both mutations).** Removed `, guard` from `addReaction`'s `inserted`
CTE's `FROM subject, under_cap${...}` list. Re-ran the new db-level F1 test:
```
● F1: the execution guard gates the decisive statement (db, codex round 3)
    › addReaction writes and emits with a live claim, then refuses execution_guard_failed ...

  expect(await reactionRows("post", subjectId2)).toEqual([]);
  - Array []
  + Array [ Object { "agent_id": "...", "emoji": "👍" } ]
```
Restored. Then removed `AND EXISTS (SELECT 1 FROM guard)` from `removeReaction`'s `DELETE`. Re-ran:
```
● F1 ... › removeReaction refuses execution_guard_failed once disabled before the write, ...
  expect(await reactionRows("post", subjectId)).toHaveLength(1);
  Expected length: 1
  Received length: 0
```
Both removed the reaction despite the disabled guard; both restored — green again.

**F1 (execution guard, memory, both functions).** Removed the `executionGuardPasses` check from
`addReaction` in `reactions/memory.ts`. Re-ran the memory-mode F1 test:
```
Expected: "execution_guard_failed"
Received: "added"
```
Restored. Removed the same check from `removeReaction`. Re-ran:
```
Expected: "execution_guard_failed"
Received: "removed"
```
Both restored — green again. Also mutation-checked the TOOL-level wiring specifically (finding 1's
literal complaint — "Both executors accept only agent"): removed `executionGuard` from
`add_reaction`'s executor call, re-ran `src/__tests__/api/reactions-routes.test.ts`'s new "F1: the
tool executors forward ctx.executionGuard" test — failed (`success: true` instead of `false`);
restored — green. Repeated for `remove_reaction` — same result, same restore. Repeated once more at
the ACTION layer (`actions/reactions.ts`'s `addReaction` dropped `input.executionGuard` from its
`storeAddReaction` call) — the tool-level test failed the same way; restored.

**F3 (reaction-first race).** In-fence mutation: made `deleteReactionsForPostBatchElement` a no-op
(`DELETE FROM content_reactions WHERE FALSE AND subject_id = $1 AND $2 = $2`, still referencing both
params so the statement binds). Re-ran the new "reaction-first" race test for both surfaces — both
failed:
```
● post reactions vs deletePost ... › reaction-first: deletePost genuinely BLOCKS ...
  expect(await reactionRows(surface, subjectId)).toEqual([]);
  - Array []
  + Array [ Object { agent_id: ..., emoji: "🎉" } ]   (the held-open second reactor's row survived)
● comment reactions vs deletePost ... › (same failure, both the post and comment reactions survived)
```
Restored the real cleanup element — both surfaces green again.

**F4 (memory validation order).** Reverted `addReaction` to run the full `prepareEventBatch` up
front (before the subject-exists check), keeping the later `const batch = earlyBatch` reference so
the function still compiled. Re-ran the existing (round-2) "F4: memory validates events before any
refusal" idemKey test:
```
duplicate key value violates unique constraint "idx_events_idem"
  at duplicateIdemKeyError (src/lib/store/events/memory.ts:67:17)
  at addReaction (src/lib/store/reactions/memory.ts:49:39)
```
Threw instead of answering `{ outcome: "not_found" }` for a missing subject with a conflicting
idemKey. Restored the validate-first/preflight-last split — green again (both `addReaction` and
`removeReaction` cases in that test, plus the pre-existing "throws on an invalid kind" cases).

**F5 (the rewritten committed-lock test).** Two attempts to "drop the seed's lock":
1. Changed the seed's `ON CONFLICT (agent_id) DO UPDATE ...` to `ON CONFLICT (agent_id) DO
   NOTHING`. Re-ran the new F5 test 3x solo — all 3 green (`["added", "already_reacted"]` every
   time). Postgres's `ON CONFLICT` conflict-detection still takes a transaction-held lock on the
   candidate row even on the `DO NOTHING` branch, so this mutation did not actually drop anything
   observable.
2. Replaced the entire seed statement with a no-op (`SELECT 1`, touching `agent_rate_limits` not at
   all). Re-ran the new F5 test 3x solo — all 3 still green.
   This is the SAME limitation round 1's report already documented for the closely related `pre`
   CTE race ("I could not construct a mutation that reliably distinguishes the fix... it is
   inherently probabilistic... it did not reproduce the bug against a DO NOTHING-only mutation in my
   testing either, in either direction"). The actual defect is a single decisive statement's own
   EPQ (EvalPlanQual) restart semantics: two decisive statements' `pre` CTEs must be caught racing
   each other at the EXACT row-lock-wait instant, which requires precise sub-statement timing no
   client-side lock hold can force (a client can pause between statements, never mid-statement).
   Per finding 5's own literal remedy, the test now at least holds a REAL, COMMITTED row's lock
   (correcting the literal defect named — "even a seed that uses DO NOTHING must wait for that
   insert" no longer applies, since there is no insert to wait for) and both real contenders
   genuinely queue on it (`observedBlocked: true` every run). I could not go further and also make
   the mutation-check deterministic without a full two-connection statement-internal choreography
   that this driver/harness cannot express (a statement cannot be paused mid-CTE from the client).
   Recorded here rather than claimed as verified, matching round 1's own precedent for the sibling
   race.

## 4. Shared-file edits (collision protocol)

- No shared files from the common-rules table were touched this round — every edit landed inside
  this lane's own fence (`src/lib/store/reactions/*`, `src/lib/actions/reactions.ts`,
  `src/lib/agent-tools/definitions/reactions.ts`, the two reaction route files, and this lane's own
  tests). `src/lib/store/execution-guard.ts` and `src/lib/store/wakeups/{db,memory}.ts` were READ
  only, to reuse their existing exports (`buildExecutionGuardCte`, `executionGuardPasses`,
  `claimNextWakeup`, `enqueueWakeup`, `completeWakeup`) exactly as `dms`/`comments` already do.
- No new store exports were added; `addReaction`/`removeReaction` keep their existing
  `export-manifest.ts` classification (already `MUTATING_STORE_EXPORTS`, unchanged by adding a third
  optional parameter).

## 5. Out-of-fence needs and cross-lane notes

- `src/lib/store/dms/db.ts` carries a pre-existing, unrelated `guard1` unused-variable TS error from
  lane D's own concurrent edits (confirmed via `git status`/re-checks across this session, never
  touched by this lane). Not actionable from this fence; flagged for the orchestrator/lane D.
- No other cross-lane collisions observed.

## 6. Docs delta

None of the six findings change agent-visible request/response shapes: the execution guard is
populated ONLY by `agent-pulse/runner.ts` (never a REST route or a direct tool call from outside
that runner), and the lock-order/validation-order/test fixes are internal correctness only. No
`public/reference.md`, `public/skill.md`, `public/openapi.json`, or `public/planned.md` change is
needed.

Suggested `CLAUDE.md`/`agents.md` invariant addition (docs agent to apply verbatim, house style),
extending the existing "A `FOR KEY SHARE` is not a delete-liveness gate" family:

> **A writer that seeds a row for the first time must lock its OWN subject before the seed runs.**
> `agent_rate_limits`' PK has no cascade from `agents`, so a brand-new row's INSERT locks the
> referenced `agents` row (`FOR KEY SHARE`) as part of its own FK check — before the writer has
> touched anything else. A caller that also needs a lock on a DIFFERENT table (posts, comments) in
> the SAME transaction as that seed must take that lock FIRST, in a statement of its own, or the
> seed's incidental `agents` lock can cross a concurrent withdrawal's `posts -> comments -> agents`
> order and deadlock (40P01) — `reactions/db.ts`'s `addReaction`, M11b lane R fix round 3, F2.

## 7. Behavior changes or plan deviations

- **`addReaction` is now a three-statement transaction, not two.** Statement 1 (subject-only lock)
  is new; statements 2 (seed) and 3 (decisive) are otherwise unchanged. This is the fix for F2 and
  is a genuine behavior change in lock ACQUISITION ORDER only — no outcome, status code, or response
  shape changed for any existing caller.
- **F5 has no positive mutation-check evidence for the specific EPQ-restart misclassification**, as
  documented in section 3. The test is a strict improvement over the round-2 version (a real,
  committed lock instead of a trivially-blocking uncommitted insert) and passes reliably, but two
  reasonable mutation attempts could not make it fail — recorded rather than claimed as verified,
  matching round 1's own precedent for the closely related `pre`-CTE race.
- No other deviations. All other findings implement the spec's stated remedy directly.
