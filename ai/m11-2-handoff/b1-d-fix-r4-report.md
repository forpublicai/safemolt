# b1 Lane D — codex round-4 fix report (direct messages)

All six findings fixed.

## Findings — status

1. **F1 (fence-loss after a refused DM read) — FIXED.** `src/lib/agent-pulse/runner.ts`:
   `read_dm_thread` is non-terminal (`DM_TOOL_NAMES` minus `DM_TERMINAL_TOOL_NAMES`), so
   `beforeTerminalTool` never sees it — a stale claim's `markDmRead` guard refusal used to fall
   through to the ordinary "model declined" branch and stamp `recordSkip`'s cooldown on an agent
   the runner no longer owned. New helper `anyToolGuardRefused(turn.toolCallsExecuted)` scans EVERY
   executed tool (not only the terminal one) for `data.code === "execution_guard_failed"`; combined
   with `fence.fenceLost()` into `fenceOrGuardLost()` (kept as a separate function to hold
   `runNarrowWakeup`'s own complexity down — see gates). Either signal now routes to the existing
   `completeAfterFenceLoss` path: one token-fenced `completeWakeup(..., "skip")` attempt, no
   `recordSkip`, no other bookkeeping.
   - Test: `src/__tests__/lib/agent-pulse/runner.test.ts`, new describe "dm: a refused non-terminal
     read is fence loss, not an ordinary skip" — a claim superseded mid-tick (matching the existing
     "claim superseded" test's technique), `read_dm_thread` refused by the guard, model then
     declines. Asserts `agent_loop_state` byte-identical (no cooldown bump) and the superseded
     runner's completion attempt matched zero rows.

2. **F2 (late-commit read proof) — FIXED, with a documented pivot away from the spec's literal
   advisory-lock suggestion.** The spec's `pg_advisory_xact_lock`-inside-the-transaction barrier was
   implemented in `dms/db.ts` first (a `testOnlyBarrierKey` param, a `MATERIALIZED` CTE gated on
   `inserted`) and reproducibly did NOT block: a standalone Node repro against this environment's
   `POSTGRES_URL` (a Neon **pooler** endpoint, confirmed by the harness's own
   `[integration] target proven: ...-pooler...` log line) showed a `pg_advisory_xact_lock` call
   inside `sql.transaction()` resolving in ~375ms against a session-level `pg_advisory_lock` held by
   a separate raw connection — consistent with PgBouncer transaction pooling's documented
   incompatibility with session-scoped advisory locks. The barrier hook was fully reverted from
   `dms/db.ts` and `dms/memory.ts` (no production code changes remain for F2/F3 — see item 4 below
   for the one real `db.ts` change, which is F4's). The spec's own fallback ("or hold the pair row
   from the test connection so the send's statement 2 blocks mid-transaction") was used instead: a
   REAL `sendDm` call is what queues behind the raw `withHeldPairRow` holder, and a second send plus
   a read are proven to queue behind THAT real send's own backend — never the raw holder directly —
   via the F3 chain mechanism. From outside the transaction, "paused after the message insert" and
   "paused before it" are indistinguishable anyway (nothing commits either way until release), so
   this proves the same externally-observable guarantee the spec asks for, against a REAL send
   rather than a stand-in.
   - Test: `src/__tests__/integration/m11-2-b1-dms.test.ts`, new describe "F2 (round 4) — a real held
     send is what a second send and a read genuinely queue behind". Also rewrote "mark-read racing a
     held send" to use `stageRace` (it previously started both contenders at once and asserted a
     count of 2 waiters on the raw holder directly — the exact F3 defect, see below — which flaked
     under concurrent-lane DB load during this round; fixed by staging).

3. **F3 (barrier by backend) — FIXED.** `waitForBlockedCount` (counted ANY marker-bearing backend
   blocked by anyone) replaced by `waitForContenderBehind(blockerPid, excludePid)` /
   `waitForContenderCountBehind(blockerPid, count)`, both built on `helpers/concurrency.ts`'s
   existing `waitersOn` (`pg_blocking_pids(pid)` filtered to include `blockerPid` specifically).
   `stageRace` now uses `withHeldPairRow`'s own `holderPid` (previously discarded) and proves the
   FIRST contender's backend waits on the holder, THEN the SECOND's waits on the FIRST's pid — never
   the holder directly, matching Postgres's FIFO row-lock queueing. Applied to `stageRace` (used by
   every `concurrent sends` / `send-vs-block` test), the rewritten "mark-read racing a held send"
   test, and the new F2 test.

4. **F4 (no empty pair on refusal) — FIXED.** `src/lib/store/dms/db.ts`'s `sendDm`: a third
   statement, self-gating purely on table state so no JS branching on statement 1/2's outcome is
   needed — `DELETE FROM dm_conversations WHERE id = $1 AND last_message_seq = 0 AND NOT
   low_blocked_high AND NOT high_blocked_low`, keyed on THIS call's own freshly-generated
   `conversationId`. A pre-existing pair's real id never equals this call's fresh id (statement 1's
   `ON CONFLICT DO NOTHING` never inserted it), so the delete is a no-op for it; a successful send
   bumps `last_message_seq` to 1+ before this runs, so it is also a no-op there. The one case it
   matches is exactly the bug: statement 1 created a fresh pair and statement 2 refused (rate
   limited), leaving nothing else to preserve. `sender_gone` needed no handling — that path throws
   and the whole transaction (including statement 1) rolls back automatically; a fresh pair can never
   be "blocked" (its flags default false). Memory already created nothing (unchanged).
   - Tests: `m11-2-b1-dms.test.ts` new describe "F4 (round 4)" — a rate-limited first-ever send
     leaves no pair, and an EXISTING conversation's block state survives the same refusal (proving
     statement 3 never touches a pre-existing row). `dms-memory.test.ts`'s existing rate-limit test
     extended with a `listDmConversations(a.id)` length-0 assertion for memory parity.

5. **F5 (pagination bounds) — FIXED.** `src/app/api/v1/dm/pagination.ts`: `parsePaginationInt` takes
   an optional `max` (default `Number.MAX_SAFE_INTEGER`) and switched `Number.isInteger` →
   `Number.isSafeInteger`. Call sites: `dm/route.ts`'s `limit` capped at 100 (this route's own
   existing `Math.min(100, ...)` clamp), `offset` capped at `MAX_PG_INT` (2147483647, Postgres's
   `int4` max, newly exported); `dm/[agent_name]/route.ts`'s `limit` capped at 500 (its own existing
   clamp), `before_seq` left at the bare safe-integer check (a `seq` never approaches it).
   - Tests: `dm-routes.test.ts`, new describe "F5 (round 4)" — 400 for `offset=2147483648`, 200 at
     exactly `2147483647`, 400 for `limit` above each route's cap, 400 for `before_seq =
     9007199254740993` (rounds to `2^53` under IEEE-754, one past `MAX_SAFE_INTEGER`).

6. **F6 (comments) — FIXED.** `src/lib/events/consumers/coverage.ts`'s `wakeupRouterCoverage` doc
   no longer claims `dm.sent` "does not exist in this build's `EventKind` union" (it does, and
   already routes `"on"` two paragraphs below in the same file) — trimmed to describe only the
   remaining true gap (`agent.mentioned`). `src/lib/store/dms/memory.ts`'s `sendDm` doc corrected
   from "re-check both agents" to "re-check the SENDER" (the recipient is deliberately FK-less,
   per the comment immediately below it).

## Gate results

- `npx tsc --noEmit` — clean for every file this lane touched. (Pre-existing, unrelated
  `TS6133` errors in `src/__tests__/integration/m11-2-b1-webhooks.test.ts`, another lane's
  concurrently in-progress file — untouched by this lane, confirmed via `git status`.)
- `npx eslint <all files touched> --max-warnings=0`:
  ```
  src/lib/agent-pulse/runner.ts
    337:1  warning  Async function 'runNarrowWakeup' has a complexity of 13. Maximum allowed is 12

  ✖ 1 problem (0 errors, 1 warning)
  ```
  Pre-existing (recorded verbatim in `b1-d-fix-r1-report.md` as complexity 13, and again in
  `b1-d-fix-r3-report.md`). This round's F1 fix would have raised it to 14 (an added `||` branch);
  extracting `fenceOrGuardLost()` as its own function brought it back to exactly 13 — verified by
  re-running eslint after the extraction (same single warning, not two).
- `npm test -- src/__tests__/lib/store/dms-memory.test.ts src/__tests__/api/dm-routes.test.ts
  src/__tests__/lib/events src/__tests__/lib/agent-pulse src/__tests__/lib/agent-tools`:
  ```
  Test Suites: 17 passed, 17 total
  Tests:       235 passed, 235 total
  ```
- `npm run test:integration -- src/__tests__/integration/m11-2-b1-dms.test.ts`, run in the
  FOREGROUND every time (never `run_in_background`; the harness's own 120s idle-output watchdog
  auto-backgrounded two of these runs while they were genuinely waiting on the shared reserved-DB
  advisory lock under concurrent-lane load — never killed, always waited out to completion before
  reading the result):
  ```
  Run 1: Test Suites: 1 passed, 1 total | Tests: 21 passed, 21 total | Time: 28.2s
  Run 2: Test Suites: 1 passed, 1 total | Tests: 21 passed, 21 total | Time: 29.0s
  Run 3: Test Suites: 1 passed, 1 total | Tests: 21 passed, 21 total | Time: 28.8s
  ```
  One EARLIER run (before this final set) flaked in a PRE-EXISTING test ("send-vs-block
  linearization ... forward, send staged first") with a `waitForContenderBehind` timeout, under
  heavy concurrent-lane DB load (three other lanes' jest processes observed running against the
  same reserved DB via `ps aux` at the time). Per `b1-common-rules.md`'s explicit protocol ("A
  first-time failure of a race test: re-run the suite SOLO before diagnosing"), a solo re-run
  immediately after was clean (21/21) — the three runs recorded above are that clean run plus two
  more, all passing.

## Mutation-check evidence (verbatim, all restored to green after)

1. **F1**: reverted `fenceOrGuardLost` call back to `fence.fenceLost()` alone (dropping the
   `anyToolGuardRefused` half). New test failed:
   ```
   - "lastSeenAt": null,        + "lastSeenAt": "2026-09-09T03:42:17.255Z",
   - "nextEligibleAt": null,    + "nextEligibleAt": "2026-09-09T04:42:17.255Z",
   ```
   — `recordSkip` ran and stamped a cooldown on the superseded agent, exactly the forbidden state.
   Restored; re-ran the full `agent-pulse` suite (20/20 green).

2. **F4**: replaced statement 3's `DELETE ...` with `SELECT 1 WHERE false` (a no-op with the same
   shape, so the transaction still has 3 elements). New test failed:
   ```
   Expected length: 0
   Received length: 1
   Received array:  [{"id": "dmc_1788927843319_7pxgrdz"}]
   ```
   — the empty fresh pair from statement 1 survived the refusal, reproducing the reported defect
   exactly. Restored; re-ran `F4 (round 4)` plus the full file (21/21 green across 3 runs, see
   Gate results).

3. **F5**: reverted `parsePaginationInt`'s `if (value > max) return INVALID_PAGINATION;` line. All 3
   of the new upper-bound tests that depend on `max` failed (`Expected: 400, Received: 200`), while
   the `before_seq` safe-integer test still passed (that one is caught by the default
   `max = Number.MAX_SAFE_INTEGER`, not by a route-supplied `max` — confirming the two checks cover
   different things, not redundant coverage of the same line). Restored; full `dm-routes.test.ts`
   green (30/30).

F2/F3 are test-infrastructure fixes (no new production behavior to suppress-and-observe), so their
correctness is evidenced by the 3 clean full-file runs plus the one genuine flake being traced to
the OLD (now-replaced) counting mechanism in a pre-existing test and resolved by the rewrite.

## Shared-file edits

- `src/lib/agent-pulse/runner.ts` (dm path and fence-loss path only, re-read immediately before each
  edit): the `if (fence.fenceLost())` line replaced with `fenceOrGuardLost(fence, ...)`, plus two new
  small functions (`anyToolGuardRefused`, `fenceOrGuardLost`). No other line touched; `runIdleWakeup`
  and the reply/playground dispatch functions are unchanged.
- `src/lib/events/consumers/coverage.ts` (the `dm.sent` comment only): trimmed the obsolete
  `wakeupRouterCoverage` doc paragraph (b), as described in F6 above. No manifest entries changed.

No new store exports, no new `ActionErrorCode`, no new `NotificationType`.

## Out-of-fence needs / cross-lane notes

- `src/__tests__/integration/m11-2-b1-webhooks.test.ts` showed pre-existing `TS6133` (unused import)
  errors mid-session from a concurrently-active lane's own edits — confirmed via `git status` as
  already modified before this session started work, and outside this lane's fence. No action taken.
- The Neon `POSTGRES_URL` used by the integration harness is a **pooler** endpoint
  (`...-pooler...`), which does not reliably support session-scoped advisory locks
  (`pg_advisory_lock`/`pg_advisory_xact_lock`) across the two drivers this harness mixes (a raw `pg`
  Client vs. the Neon HTTP driver's `sql.transaction()`). Any FUTURE lane or round tempted to reach
  for `pg_advisory_lock`-based test barriers here should know this in advance — held ROW locks inside
  an explicit `BEGIN`/`COMMIT` (this file's existing `withHeldPairRow` pattern) are what reliably
  pins one real backend for the duration, and are the only mechanism this round found to work.

## Docs delta

None. All six findings are internal store/runner/test behavior with no new public API surface,
`ActionErrorCode`, or documented contract change beyond F5's stricter (previously-undocumented)
upper-bound validation of the already-documented `limit`/`offset`/`before_seq` params (400 instead
of a 500 or silent clamp outside the documented range — not a new contract).

## Behavior changes or plan deviations

- **F2 deviates from the spec's literal `pg_advisory_xact_lock` mechanism** (see item 2 above) —
  reverted after a reproducible failure specific to this environment's pooled Neon endpoint, in favor
  of the spec's own named fallback. No `db.ts`/`memory.ts` signature changes remain from this attempt.
- **`sendDm` gains a third statement** (F4) that runs on every call, a cheap self-gating `DELETE`
  that is a no-op except for the one case it exists to fix. No caller-visible signature or return
  type change.
- **DM pagination query params now 400** for `limit`/`offset` values above each route's own
  pre-existing effective cap, and for any value exceeding `Number.MAX_SAFE_INTEGER` — stricter than
  before (previously silently clamped or, for `offset`, could 500). No existing valid caller's
  behavior changes.
- No other deviations from the round-4 fix spec.
