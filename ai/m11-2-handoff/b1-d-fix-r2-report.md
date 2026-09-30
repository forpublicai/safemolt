# b1 Lane D — codex round-2 fix report (direct messages)

All six adjudicated findings fixed. F1 (deferred in round 1) is now implemented for real, with
statement-level gating in both stores. F2's concurrency tests are rewritten as genuine held-lock
barriers, discovered and fixed a real bug in the barrier technique itself along the way (below).

## Findings — status

1. **F1 (execution guard reaches DM writes) — FIXED.**
   - `src/lib/actions/dms.ts`: `SendDmInput`/`MarkDmReadInput`/`BlockAgentInput`/`UnblockAgentInput`
     gain an optional `executionGuard`, threaded into `storeSendDm`/`storeMarkDmRead`/`storeSetDmBlock`.
     `sendDm`'s action checks `outcome.outcome === "execution_guard_failed"` first (matching
     `createComment`'s precedence) and answers `actionError("execution_guard_failed", …)`.
   - `src/lib/agent-tools/definitions/messages.ts`: `send_dm`, `read_dm_thread`, `block_agent`,
     `unblock_agent` forward `ctx.executionGuard` into their action calls. `read_dm_thread` is
     non-terminal (no lease-renewal fence ever covers it), so this closes exactly the hole codex
     named: "the non-terminal read also changes its cursor without a lease check."
   - `src/lib/store/dms/db.ts`: `sendDm` takes `executionGuard`, renders `buildExecutionGuardCte`
     spliced into the `target`/`guard` WITH list, gates `claim` on it, projects `guard_passed`, and
     classifies `execution_guard_failed` before `blocked`/`rate_limited`. `markDmRead` and
     `setDmBlock` take the same optional parameter and gate their UPDATE/INSERT on
     `EXISTS (SELECT 1 FROM guard)` — a failed guard leaves the boolean return `false` (same shape
     as an ordinary no-op), since neither surfaces a distinct refusal code to its caller.
   - `src/lib/store/dms/memory.ts`: all three functions call `executionGuardPasses` in the same
     synchronous section as their write (no `await` in between), mirroring the db side's precedence.
   - Tests: `src/__tests__/lib/store/dms-memory.test.ts` ("F1 — the execution guard reaches
     send/read/block (memory)", 3 tests) and `src/__tests__/integration/m11-2-b1-dms.test.ts`
     ("F1 — the execution guard reaches sendDm's decisive statement", 2 tests, real
     `agent_loop_state`/`agent_wakeups` via `claimNextWakeup`).
   - Mutation-check (verbatim): disabling the memory guard check in `sendDm` made the "refuses once
     disabled" test fail (`{outcome:"rate_limited"}` instead of `execution_guard_failed`); disabling
     it in `markDmRead` flipped `expect(...).toBe(false)` to received `true` (cursor moved); disabling
     it in `setDmBlock` did the same (flag flipped). Disabling the db-side classification
     (`if (false && executionGuard …)`) made the integration "refuses" test receive `rate_limited`
     instead. All four restored to green after.

2. **F2 (real concurrency) — FIXED**, and this uncovered a genuine bug in the barrier technique
   itself, not just the app code. `src/__tests__/integration/m11-2-b1-dms.test.ts` was rewritten with
   `withHeldPairRow` (a dedicated `pg` session holds the pair row `FOR NO KEY UPDATE`, always released
   in a `finally`) and `waitForBlockedCount` (polls `pg_stat_activity` for backends blocked, directly
   or transitively, on a query carrying the `race:dm-send-pair-lock` marker — added to `sendDm`'s
   `target` CTE and, for the block/read tests, to `setDmBlock`'s and `markDmRead`'s statements too).
   - **Root-cause investigation**: my first implementation counted only waiters whose
     `pg_blocking_pids()` included the holder's own pid directly, and it NEVER observed 2 waiters
     over a 5s window even though the diagnostic proved a single contender genuinely blocks. Root
     cause: PostgreSQL QUEUES row-lock waiters — the SECOND contender is blocked by the FIRST WAITER,
     not by the original holder — so `pg_blocking_pids()` reports the direct blocker only. This exact
     shape is already documented and solved in `m11-2-u3f-core-classes.test.ts` (marker-scoped,
     "blocked by anyone" counting); I adopted the same pattern rather than re-inventing it once found.
   - Three tests: two different senders overlapping (asserts `seq` order against the ACTUAL JS
     resolution order, read straight from `dm_messages`, never sorted); send-vs-block in both
     directions (asserts whichever op the barrier proves resolved first determines the outcome,
     with a follow-up send proving the pair is blocked either way); mark-read racing a held send
     (markDmRead is queued first via an intermediate `waitForBlockedCount(1)` check before the send
     even starts, so Postgres's FIFO queue makes the ordering deterministic, not a guess).
   - Mutation-check (verbatim): removed `FOR NO KEY UPDATE` from `target`'s `SELECT`. The
     "concurrent sends" test still passed (the `bumped` CTE's own `UPDATE` independently serializes
     on the row — a real resilience property, not a test weakness). The "send-vs-block" tests BOTH
     failed (`Expected: "blocked", Received: "inserted"`) — proving they depend on exactly the lock
     that makes the block-flag re-check observe a concurrent block, which is the actual defect this
     finding is about. Restored; both stores of tests green again (10/10 in the full integration file).

3. **F3 (unread-first in the store) — FIXED.** `listDmConversations` (`db.ts` and `memory.ts`) gains
   `unreadFirst?: boolean`. db: `ORDER BY (<unread expr>) > 0 DESC, last_message_at DESC, …` (built as
   a plain parameterized string, not a tagged template, since the Neon driver cannot compose nested
   `sql` fragments — see "behavior changes" below). memory: the same predicate as the sort's first
   key. `src/lib/agent-senses/inbox.ts` now calls `listDmConversations(agentId, {limit: 5,
   unreadFirst: true})` directly — the old 20-scan-then-filter workaround is gone.
   - Tests: `src/__tests__/lib/store/dms-memory.test.ts` ("F3: unreadFirst surfaces an older unread
     thread ahead of newer read ones, before the limit" — 3 partners, `limit: 2`, proves the unread
     one is never dropped) and `src/__tests__/lib/agent-senses/inbox-classes.test.ts` (updated to
     assert the call carries `{limit: 5, unreadFirst: true}` and the store's contract, not the
     inbox's own re-derivation).
   - Mutation-check: flipped `unreadFirst: true` → `false` in `inbox.ts` — the inbox test failed
     (wrong call args) as expected. Restored.

4. **F4 (same missing-actor failure in both stores) — FIXED.** `SendDmResult['outcome']` gains
   `"sender_gone"` (in both `db.ts` and `memory.ts`). memory's `sendDm` answers it instead of folding
   into `rate_limited`. db's `sendDm` catches `23503` on `agent_rate_limits_agent_id_fkey`
   (`isSenderForeignKeyViolation`) and answers it instead of rethrowing. `actions/dms.ts` maps it to
   `actionError("not_found", …)` — the route/tool already answer 404 for `not_found`, so no new
   adapter case was needed.
   - Tests: memory (`dms-memory.test.ts`, updated F6 test + new "F4" describe) and db
     (`m11-2-b1-dms.test.ts`, new "F4" describe, real FK violation).
   - Mutation-check: db — commented out the FK-catch; the test then threw the raw
     `NeonDbError: … violates foreign key constraint "agent_rate_limits_agent_id_fkey"` uncaught
     (the exact pre-fix 500). memory — reverted the outcome to `rate_limited`; the F4 action-level
     test failed with `code: "rate_limited"` instead of `"not_found"`. Both restored.

5. **F5 (content type) — FIXED.** `src/app/api/v1/dm/[agent_name]/route.ts`'s `POST` checks
   `typeof body?.content !== "string"` before calling `.trim()`, answering 400.
   - Test: `src/__tests__/api/dm-routes.test.ts`, "F5: answers 400, not 500, for a non-string
     content field" (`{content: 42}`).
   - Mutation-check: disabled the check — the test failed (`Received: 500`). Restored.

6. **F6 (comment) — FIXED.** `db.ts`'s `sendDm` doc comment cut from 28 lines to 4
   (transaction-boundary + lock, nothing else). Non-behavioral; no test.

## Gate results

- `npx tsc --noEmit` — clean over the whole tree except pre-existing errors in
  `src/__tests__/integration/m11-2-b1-webhooks.test.ts` and
  `src/__tests__/lib/store/webhooks-memory.test.ts` (lane W's concurrently-edited
  `RecordWebhookAttemptInput` type — outside this fence, not caused by or fixed by this round).
- `npx eslint <all files touched this round, incl. tests> --max-warnings=0` — clean, 0
  problems:
  ```
  src/lib/store/dms/db.ts src/lib/store/dms/memory.ts src/lib/actions/dms.ts
  src/lib/agent-tools/definitions/messages.ts src/lib/agent-senses/inbox.ts
  src/app/api/v1/dm/[agent_name]/route.ts src/__tests__/integration/m11-2-b1-dms.test.ts
  src/__tests__/lib/store/dms-memory.test.ts src/__tests__/api/dm-routes.test.ts
  src/__tests__/lib/agent-senses/inbox-classes.test.ts
  ```
- `npm test -- src/__tests__/lib/store/dms-memory.test.ts src/__tests__/api/dm-routes.test.ts
  src/__tests__/lib/events src/__tests__/lib/agent-pulse src/__tests__/lib/agent-senses
  src/__tests__/api/v1/agents-me-context.test.ts src/__tests__/lib/agent-tools`:
  ```
  Test Suites: 26 passed, 26 total
  Tests:       293 passed, 293 total
  ```
  (A transient failure in `context.test.ts`/`agents-me-context.test.ts`, caused by lane M's
  concurrently in-progress edits to `src/lib/agent-senses/feed.ts`/`types.ts`, self-resolved once
  that lane's edit landed — confirmed via `git diff` at the time: those two production files were
  mid-edit with no corresponding test-file diff, and neither is in this lane's fence.)
- `npm run test:integration -- src/__tests__/integration/m11-2-b1-dms.test.ts`:
  ```
  Test Suites: 1 passed, 1 total
  Tests:       10 passed, 10 total
  ```
  (waited for the advisory lock at the very first run; never killed a holder.)

## Files touched this round

- `src/lib/store/dms/db.ts` — guard on all three mutations, `sender_gone` FK translation,
  `unreadFirst`, cut comment, `race:dm-send-pair-lock` markers on all three lock-taking statements.
- `src/lib/store/dms/memory.ts` — guard on all three mutations, `sender_gone`, `unreadFirst` sort key.
- `src/lib/actions/dms.ts` — `executionGuard` threaded through all four action inputs;
  `execution_guard_failed` and `sender_gone` classification in `sendDm`.
- `src/lib/agent-tools/definitions/messages.ts` — `executionGuard` forwarded from ctx in
  `send_dm`, `read_dm_thread`, `block_agent`, `unblock_agent`.
- `src/lib/agent-senses/inbox.ts` — `unreadFirst: true`, `limit: 5` (scan-then-filter removed).
- `src/app/api/v1/dm/[agent_name]/route.ts` — content type-check before `.trim()`.
- Tests: `src/__tests__/lib/store/dms-memory.test.ts`, `src/__tests__/api/dm-routes.test.ts`,
  `src/__tests__/lib/agent-senses/inbox-classes.test.ts`,
  `src/__tests__/integration/m11-2-b1-dms.test.ts` (rewritten concurrency section + new F1/F4
  describes).

No changes to `src/lib/agent-pulse/runner.ts` (my shared-file allowance there) — it already forwards
`executionGuard` to every `executeTool` call, terminal or not, so no runner-side change was needed to
close F1.

## Shared-file edits

None of the collision-protocol files (`src/lib/agent-senses/inbox.ts`'s DM section,
`src/lib/agent-pulse/runner.ts`'s dm path) needed a runner.ts edit. `inbox.ts`'s DM section was
re-read immediately before editing; no collision.

No new store exports (only parameter/return-shape changes to existing `sendDm`/`markDmRead`/
`setDmBlock`/`listDmConversations`), so no `export-manifest.ts` change was needed.

## Out-of-fence needs / cross-lane notes

- The barrier-counting bug fixed in `helpers/concurrency.ts`'s USAGE (not the file itself — I did
  not edit it) is worth flagging to other lanes writing NEW two-contender race tests: `waitersOn(
  holderPid)` alone misses the second waiter in a chain. `m11-2-u3f-core-classes.test.ts` already
  has the correct pattern; I did not touch `helpers/concurrency.ts` itself since it is not in this
  lane's fence and the existing `raceAgainstHeldLock`/`waitersOn` helpers are correct for their
  documented one-hold-vs-one-contender use — the gap is only in *my* code, not theirs.
- The lane-W webhooks type mismatch (`RecordWebhookAttemptInput`'s `agentId`) seen in `tsc` output is
  unrelated to this lane; not touched.

## Docs delta

None. This round is entirely internal DM store/action/tool behavior with no new public API surface,
no new `ActionErrorCode` beyond the already-existing `execution_guard_failed`, and no new
`NotificationType`. `execution_guard_failed`/`sender_gone` are internal outcomes never surfaced to an
external caller in a new way (`sender_gone` renders as the same `not_found` 404 the docs already
describe for an unknown recipient).

## Behavior changes or plan deviations

- **`listDmConversations`'s db implementation switched from a tagged-template `sql` call to the
  string+params form** (`sql!(text, [...])`) to support the conditional `unreadFirst` ORDER BY term.
  The Neon serverless driver's `sql\`...\`` tag does not support composing a nested `sql` fragment as
  an interpolated value (unlike `postgres.js`), so the initial attempt (`${cond ? sql\`...\` :
  sql\`\`}`) would have silently mis-bound. No behavior change for existing callers — the query text
  and parameter values are identical for `unreadFirst` omitted/false.
- **`sender_gone` is a new `SendDmResult` outcome member** (not folded into an existing one). This is
  a deliberate, minimal type change: the alternative was throwing a class-based error from the store
  and catching it in the action, which is less consistent with this file's existing discriminated-
  union idiom. `setDmBlock`/`markDmRead`'s guard failures deliberately do NOT get an equivalent new
  return shape — they keep their existing boolean contract, since guard failure there behaves
  identically to their existing "no-op, nothing changed" case and neither action layer inspects the
  return value for anything beyond truthiness today.
