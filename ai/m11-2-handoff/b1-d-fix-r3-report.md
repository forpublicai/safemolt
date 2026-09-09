# b1 Lane D — codex round-3 fix report (direct messages)

All six findings fixed. The "forward direction" race flake is fixed as a TEST-only defect, per
codex's own adjudication (no window found in the send statement).

## Findings — status

1. **F1 (guard refusals propagate) — FIXED.**
   - `src/lib/store/dms/db.ts`: `markDmRead`/`setDmBlock` now select `guard_passed` alongside
     `changed_count` and return the sentinel `"execution_guard_failed"` (new return type
     `Promise<boolean | "execution_guard_failed">`), checked independently of the flag's own no-op
     suppression — same precedence as `sendDm`. Two small shared helpers
     (`guardPassedSelectSql`, `guardRefusal`) hold the duplicated SQL fragment and classification so
     neither function's own complexity grows past 12.
   - `src/lib/store/dms/memory.ts`: both functions check `executionGuardPasses` FIRST, before the
     no-op checks, returning the same sentinel.
   - `src/lib/actions/dms.ts`: `markDmRead`/`blockAgent`/`unblockAgent` now capture the store's
     return value and answer `actionError("execution_guard_failed", ...)` via a new shared
     `guardRefusal()` helper (also used to de-duplicate `sendDm`'s existing check).
   - `src/lib/agent-tools/definitions/messages.ts`: `read_dm_thread` now checks `markDmRead`'s
     `ActionResult` and returns `{success:false, data:{code:"execution_guard_failed"}}` instead of
     discarding it. `block_agent`/`unblock_agent` already forwarded the action's `ActionResult`, so
     the pre-existing `default:` switch arm in `blockRefusal` renders the new code without change.
   - Tests: `src/__tests__/lib/store/dms-memory.test.ts` (2 store-level + 3 new tool-level tests:
     `block_agent`, `unblock_agent`, `read_dm_thread`) and
     `src/__tests__/integration/m11-2-b1-dms.test.ts` (2 new db-level tests for `markDmRead`/
     `setDmBlock`).

2. **F2 (sound race tests) — FIXED.** Rewrote both flagged describe blocks in
   `m11-2-b1-dms.test.ts` around a new `stageRace` helper: start `first`, prove (via
   `waitForBlockedCount(1)`) it alone is queued behind the holder, THEN start `second` and prove
   (via `waitForBlockedCount(2)`) it queues behind `first` too, and only then release — so which one
   commits first is a fact the harness establishes, never a guess from JS resolution order.
   - "concurrent sends" is now 2 tests (`a` staged first / `b` staged first), each asserting the
     committed `seq` order read from `dm_messages`, never `resolveOrder`.
   - "send-vs-block" is now 4 tests (2 orders × 2 directions: forward/reverse × send-first/
     block-first), each asserting a **predetermined** outcome instead of branching on which promise
     resolved first.
   - Ran the full integration file 3 times solo after the rewrite: 18/18 green every time (see Gate
     results below for tails).

3. **F3 (guard on the first insert) — FIXED.** `sendDm` (`db.ts`) now builds a second guard
   fragment (`guard1`, its own `$`-numbering starting at 5) and gates statement 1's conversation
   INSERT the same way `setDmBlock`'s blocking branch already does (`SELECT ... FROM guard`, zero
   rows when the guard fails). Test: `m11-2-b1-dms.test.ts`, "F3 — a refused guard on a fresh pair
   commits no conversation" — asserts no conversation, message, quota row, or event.

4. **F4 (pagination validation) — FIXED.** New `src/app/api/v1/dm/pagination.ts` exports
   `parsePaginationInt`/`INVALID_PAGINATION`; both DM GET routes validate `limit`/`offset`/
   `before_seq` before any store call and answer 400 for a non-finite, fractional, or
   out-of-bound value. Tests: `dm-routes.test.ts`, 5 new cases (list route: bad limit, fractional
   limit, negative offset; thread route: bad `before_seq`, non-positive limit).

5. **F5 (db event emission proof) — FIXED (test-only).** New describe block in
   `m11-2-b1-dms.test.ts`: a real `sendDm` call with a `dm.sent` `PreparedEvent`, asserting the
   stored event's `subject_id` (== message id) and an ids-only `payload` (conversation id, message
   id, seq, recipient id — no content); a second test forces the event insert to fail via a
   trigger (mirroring `m11-2-u3e-evaluations.test.ts`'s `withEventFailure`) and asserts the whole
   send rolled back (no message, no quota row, no conversation for the fresh pair).

6. **F6 (comments) — FIXED.** `src/lib/agent-pulse/runner.ts`: the top-of-file doc no longer lists
   `send_dm` as lacking a statement-level guard (it has one since round 2); `runDmWakeup`'s doc no
   longer claims no `messages` `LoopDomain` exists (it does, in `agent-runtime/index.ts` — this call
   deliberately still uses `"discussion"` for prompt-guidance text only, unchanged behavior).
   `scripts/migrate-m11-dms.sql`'s header cut from 16 lines to 5, keeping only the two load-bearing
   constraints (seq/lock serialization, FK-less policy). Non-behavioral; no test.

## Gate results

- `npx tsc --noEmit` — clean. (One transient error was observed mid-session in
  `src/lib/store/reactions/db.ts` — `TS6133` on `subjectOnlyLockStatementText` — from lane R's
  concurrent in-progress edit; a re-run 15s later was clean, and that file is untouched by this
  lane.)
- `npx eslint <all files touched, incl. tests> --max-warnings=0`:
  ```
  src/lib/agent-pulse/runner.ts
    326:1  warning  Async function 'runNarrowWakeup' has a complexity of 13. Maximum allowed is 12

  ✖ 1 problem (0 errors, 1 warning)
  ```
  Pre-existing (recorded verbatim in b1-d-fix-r1-report.md as complexity 13, untouched by this
  round — my two edits to this file are both inside comment blocks nowhere near
  `runNarrowWakeup`'s body). `src/lib/store/dms/db.ts`'s `setDmBlock` briefly regressed to
  complexity 14 after the F1 fix; extracting `guardPassedSelectSql`/`guardRefusal` brought it back
  to a clean pass (0 warnings) — verified below under "Mutation-check evidence" is unrelated; the
  complexity fix itself was verified by re-running eslint after the extraction (clean).
- `npm test -- src/__tests__/lib/store/dms-memory.test.ts src/__tests__/api/dm-routes.test.ts
  src/__tests__/lib/events src/__tests__/lib/agent-pulse src/__tests__/lib/agent-tools`:
  ```
  Test Suites: 17 passed, 17 total
  Tests:       229 passed, 229 total
  ```
- `npm run test:integration -- src/__tests__/integration/m11-2-b1-dms.test.ts`, run **three times
  solo** after the final rewrite:
  ```
  Run 1: Test Suites: 1 passed, 1 total | Tests: 18 passed, 18 total | Time: 24.9s
  Run 2: Test Suites: 1 passed, 1 total | Tests: 18 passed, 18 total | Time: 25.2s
  Run 3: Test Suites: 1 passed, 1 total | Tests: 18 passed, 18 total | Time: 24.8s
  ```
  (waited for the advisory lock once at the very first run in the session; never killed a holder.)

## Mutation-check evidence (verbatim, all restored to green after)

1. **F1, memory `markDmRead`**: changed `return "execution_guard_failed"` back to `return false`.
   New test failed: `Expected: "execution_guard_failed", Received: false`. Restored.
2. **F1, db `markDmRead`+`setDmBlock`**: made `guardRefusal()` always `return null`. Both new
   integration tests failed identically: `Expected: "execution_guard_failed", Received: false`.
   Restored.
3. **F1, tool `read_dm_thread`**: dropped the `if (!readResult.ok)` check, called `markDmRead`
   without inspecting its result. New test failed: `Expected: false, Received: true` (tool reported
   success despite the refused guard). Restored.
4. **F1, action `blockAgent`**: dropped the `if (outcome === "execution_guard_failed")` check.
   `block_agent` tool test failed identically (`Expected: false, Received: true`); the sibling
   `unblock_agent` test still passed, confirming the two checks are independently gated, not
   accidentally coupled. Restored.
5. **F2**: swapped `stageRace`'s internal invocation order (called `second()` before `first()`
   while keeping the same variable names) — simulates the fix staging the wrong contender first.
   Both "concurrent sends" tests failed with the committed sender order reversed
   (`["b1dm_agent_..._5", "b1dm_agent_..._4"]` vs expected `[..._4, ..._5]`); all 4 "send-vs-block"
   tests failed too (e.g. `Expected: "blocked", Received: "inserted"` and vice versa) — proving
   every one of the 6 rewritten tests genuinely depends on the staged order, not on chance. (An
   earlier attempt that only swapped the *returned* `firstResult`/`secondResult` labels passed
   unchanged, which is correct: the seq/outcome assertions read real committed state, never the
   labels — confirming the tests are not accidentally order-label-driven either.) Restored.
6. **F3**: reverted statement 1 to the original unconditional `VALUES(...)` insert (no guard1
   gating). New test failed: `Expected length: 0, Received length: 1` on `dm_conversations` —
   reproducing exactly the reported defect (a refused guard still created the fresh-pair
   conversation). Restored.
7. **F4**: removed the `INVALID_PAGINATION` checks from both DM GET routes. All 5 new pagination
   tests failed (`Expected: 400, Received: 200` / `500`). Restored.
8. **F5**: stripped 3 of 4 fields from `sendDm`'s `payloadMergeSql` override. New positive test
   failed (a `NeonDbError: could not determine data type of parameter $11` — the unreferenced
   `recipient_agent_id` param this repo's own convention treats as a hard failure, not a silent
   no-op). Restored.

## Shared-file edits

- `src/lib/agent-pulse/runner.ts` (shared: dm path and obsolete comments only) — re-read
  immediately before each edit. Two comment-only edits: the top-of-file doc's "WIRED actions" list
  (line ~28) and `runDmWakeup`'s doc (line ~478). No code changed; `domain: "discussion"` is
  unchanged (a comment now correctly says why it is kept over the registered `messages`
  `LoopDomain`, rather than falsely claiming that domain does not exist).

No new store exports, no new `ActionErrorCode` (`execution_guard_failed` already existed), no new
`NotificationType`.

## Out-of-fence needs / cross-lane notes

- None new this round. The transient `reactions/db.ts` tsc error (lane R, concurrent edit)
  self-resolved and required no action.

## Docs delta

None. All six findings are internal store/action/tool/test behavior with no new public API surface
or `ActionErrorCode`. The pagination 400s are a stricter (previously-undocumented) validation of an
already-documented `limit`/`offset`/`before_seq` contract, not a new contract.

## Behavior changes or plan deviations

- **`markDmRead`/`setDmBlock`'s return type changed** from `Promise<boolean>` to
  `Promise<boolean | "execution_guard_failed">` in both stores. Every existing caller that omits
  `executionGuard` is unaffected (the sentinel can only be returned when a guard was supplied and
  failed).
- **DM pagination query params now 400 instead of silently clamping/500ing** for a non-integer or
  out-of-bound `limit`, `offset`, or `before_seq`. This is stricter than before; no existing valid
  caller's behavior changes.
- No other deviations from the round-3 fix spec.
