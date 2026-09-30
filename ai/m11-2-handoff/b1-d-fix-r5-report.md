# b1 Lane D — codex round-5 fix report (direct messages)

All six findings fixed, plus the whole-fence audit (policy item 2).

## Findings — status

1. **F1 (guard loss before ANY error write) — FIXED.** `src/lib/agent-pulse/runner.ts`: guard-loss
   tracking moved to REAL TIME. `createPulseFence` now returns a `PulseFence` (extends
   `PulseTickBundle`) carrying `onToolExecuted` (flips `guardRefused` when a tool result's
   `data.code === "execution_guard_failed"`) and `guardRefused()`. `runAgenticTurn` is called with
   `onToolExecuted: fence.onToolExecuted`, so a refusal is recorded AS IT HAPPENS — not reconstructed
   from `turn.toolCallsExecuted` after the fact, which is unreachable when the turn itself throws.
   The `catch` around `runAgenticTurn` is extracted into `completeAfterTurnThrow(agent, wakeup,
   claimToken, fence, error)`, which checks `fenceOrGuardLost(fence)` BEFORE `recordError` (kept as
   its own function to hold `runNarrowWakeup`'s complexity at 12, not 14 — see gates). `fenceOrGuardLost`
   simplified to `fence.fenceLost() || fence.guardRefused()` (no longer needs `turn.toolCallsExecuted`,
   so `anyToolGuardRefused` was removed as dead code).
   - Test: `src/__tests__/lib/agent-pulse/runner.test.ts`, new describe "dm: a refused non-terminal
     read followed by a throwing model call is still fence loss" — `read_dm_thread` refused by the
     guard, then the SECOND model call throws. Asserts `agent_loop_state` byte-identical (no error
     bookkeeping) and the wakeup uncompleted.

2. **F2 (late-commit proof with a real pause AFTER the insert) — FIXED.** `src/__tests__/integration/
   m11-2-b1-dms.test.ts`: replaced the round-4 "F2" describe with "F2 (round 5)". A test-only
   `AFTER INSERT` trigger on `dm_messages` (RUN-suffixed function/trigger/gate-table names, created in
   the describe's own `beforeAll`, dropped in `afterAll`) fires only for a content marker and then
   takes `FOR UPDATE` on a one-row gate table a raw holder connection already holds — so the REAL
   `sendDm` call pauses strictly AFTER its own `bumped` UPDATE and `inserted` INSERT, still inside its
   own open transaction. A second send and a read are proven to (transitively) queue behind the real
   send's own backend pid — see F2 audit note below for why "transitively" replaced "directly".
   Verified after release: three increasing seqs, reader cursor ≥ 2.

3. **F3 (holder pid after BEGIN) — FIXED.** `withHeldPairRow` now calls `client.query("BEGIN")`
   BEFORE `pidOf(client)`, not after — a pooled endpoint can hand a different backend to the session
   before its transaction starts, and the lock (and any wait on it) belongs to the pid that holds it.

4. **F4 (id before name) — FIXED.** `src/lib/actions/dms.ts`'s `resolveDmCounterpart` now tries the
   caller-scoped conversation-history lookup (`listDmMessages(callerId, nameOrId, {limit:1})`) FIRST,
   falling back to `getAgentByName` only when no history matches — so a live agent registering a name
   equal to a withdrawn participant's id can never steal the caller's retained thread.
   - Test: `src/__tests__/api/dm-routes.test.ts`, new describe "F4 (round 5)" — an impostor agent is
     created with `name = b.id` after `b` withdraws; the caller's `GET /dm/{b.id}` still returns the
     retained pre-withdrawal history, never an empty thread with the impostor.

5. **F5 (received-message preview) — FIXED.** New store function `getLastReceivedDmMessage(agentId,
   otherId)` in both `src/lib/store/dms/db.ts` (SQL: `sender_agent_id <> agentId` filtered before
   `LIMIT 1`) and `src/lib/store/dms/memory.ts` (filter before sort/slice), wired through
   `src/lib/store/dms/index.ts` (`pickStore`). `src/lib/agent-senses/inbox.ts`'s
   `getDmThreadPreview` now calls this instead of `listDmMessages(..., {limit:10})` + a JS loop, which
   could miss a received message buried under ten-plus newer outgoing ones.
   - Tests: `src/__tests__/lib/store/dms-memory.test.ts`, new describe (real memory-store, 1 received
     + 10 outgoing, plus a null-case pair); `src/__tests__/lib/agent-senses/inbox-classes.test.ts`,
     new "F5 (round 5)" test (mocked store, proves `gatherInbox` renders the store's answer verbatim).

6. **F6 (comments) — FIXED.** `src/lib/agent-senses/types.ts:255`'s obsolete "later round's job"
   comment on `SensesFocus`'s `dm` member trimmed to state what the code does today.
   `src/app/api/v1/dm/pagination.ts`'s header trimmed from 6 lines to 3.

7. **WHOLE-FENCE AUDIT (policy item 2) — per file:**
   - `src/lib/store/dms/db.ts`: read every statement (`sendDm`'s 3-element transaction, `markDmRead`,
     `setDmBlock`, `listDmConversations`, `listDmMessages`, the new `getLastReceivedDmMessage`,
     `isDmBlocked`, `countUnreadDms`). Lock order: `dm_conversations` is always locked (explicit
     `FOR NO KEY UPDATE`/implicit row lock from an `UPDATE`) BEFORE any implicit `agents` FK lock a
     later CTE triggers (`claim`'s insert into `agent_rate_limits`, `inserted`'s insert into
     `dm_messages`) — consistent with `deleteAgent`'s own posts/comments-before-agents order. Every
     `EXISTS (...)` in these statements reads a CTE computed earlier in the SAME statement (never a
     stale cross-statement read), so the "liveness is `FOR SHARE`, never a bare `EXISTS`" rule has no
     bare-`EXISTS`-on-external-state case to find here. No changes beyond F1–F5 above.
   - `src/lib/store/dms/memory.ts`: read `sendDm`/`markDmRead`/`setDmBlock`/`listDmMessages` plus the
     new `getLastReceivedDmMessage`. The memory-mode actor re-check (sender re-checked BY ID after the
     synchronous section starts, no `await` between check and write) is already in place from prior
     rounds. No changes beyond the F5 addition.
   - `src/lib/agent-pulse/runner.ts`: read `createPulseFence`, `completeAfterFenceLoss`,
     `fenceOrGuardLost`, `runIdleWakeup`, `runNarrowWakeup`, `completeAfterTurnThrow` end to end (the
     `dm` reason's own config). No lock/statement concerns (this file issues no SQL); the audit here
     was the F1 live-tracking rewrite itself, changed as described above.
   - `src/__tests__/integration/m11-2-b1-dms.test.ts`: every describe block re-read. The F2 rewrite
     surfaced a real chaining fact worth recording — Postgres's FIFO row-lock queue means two
     contenders STARTED CONCURRENTLY (not staged one-after-another like `stageRace` elsewhere in this
     file) can chain either way (`secondSend` behind `read`, or vice versa; `secondSend`'s own
     STATEMENT 1 `INSERT ... ON CONFLICT` can queue via an XID wait with no pair-lock comment in its
     text, so a marker-based check misses it). The fix is a generalized transitive check added for
     this test only — `blockedBackends()` (unfiltered `pg_blocking_pids` snapshot) and
     `chainReaches()`/`waitUntilCountTransitivelyBlockedBy()` (BFS through the blocker graph) — rather
     than assuming a fixed chain shape. Every other describe block (F1 guard tests, F3, F4 round-4,
     concurrent-sends, send-vs-block, both-direction rejection, mark-read racing a held send, F5
     payload, F5 round-3 event, F4 withdrawn-sender, withdrawal-history) already asserts on real
     committed rows read AFTER every contender resolves, or on statement-decided classifications
     (`outcome`) — audit found nothing else to change there.
   - `src/__tests__/api/dm-routes.test.ts`, `src/__tests__/lib/agent-senses/{inbox-classes,
     context}.test.ts`, `src/__tests__/lib/store/dms-memory.test.ts`: audited for the F4/F5 mock and
     import updates only; no other findings.

## Gate results

- `npx tsc --noEmit` — clean, no errors, across the whole repo (a concurrent lane's
  `notifications/db.ts` TS6133 pair observed mid-session resolved itself by the final run).
- `npx eslint <14 touched files> --max-warnings=0` — clean, 0 warnings, 0 errors. (F1's live-tracking
  extraction — `completeAfterTurnThrow` — was needed specifically to keep `runNarrowWakeup`'s
  complexity at the pre-existing 12/13 baseline rather than raising it to 14.)
- `npm test -- src/__tests__/lib/store/dms-memory.test.ts src/__tests__/api/dm-routes.test.ts
  src/__tests__/lib/events src/__tests__/lib/agent-pulse src/__tests__/lib/agent-tools
  src/__tests__/lib/agent-senses`:
  ```
  Test Suites: 25 passed, 25 total
  Tests:       304 passed, 304 total
  ```
- `npm run test:integration -- src/__tests__/integration/m11-2-b1-dms.test.ts`, three FOREGROUND runs
  (one auto-backgrounded by the harness's 120s idle-output watchdog while genuinely waiting on the
  shared reserved-DB advisory lock under concurrent-lane load — never killed, waited out):
  ```
  Run 1: Test Suites: 1 passed, 1 total | Tests: 21 passed, 21 total | Time: 28.7s
  Run 2: Test Suites: 1 passed, 1 total | Tests: 21 passed, 21 total | Time: 28.3s
  Run 3: Test Suites: 1 passed, 1 total | Tests: 21 passed, 21 total | Time: 29.2s
  ```

## Mutation-check evidence (verbatim, all restored to green after)

1. **F1**: reverted `completeAfterTurnThrow`'s guard-loss check to nothing (removed the `if
   (fenceOrGuardLost(fence)) return ...` line). New test failed:
   ```
   Expected: "skip"
   Received: "error"
   ```
   — `recordError` ran and the wakeup completed as `error` for a superseded runner. Restored;
   `runner.test.ts` re-ran green (21/21).

2. **F2**: this is the hard evidence the round asked for — the counter-first defect class. Applied
   THREE coordinated changes to `src/lib/store/dms/db.ts`'s `sendDm` to make the counter bump commit
   BY ITSELF, ahead of the message: (a) added a separate, autocommitted `UPDATE dm_conversations SET
   last_message_seq = last_message_seq + 1 ...` issued BEFORE `sql!.transaction(...)`; (b) removed
   `target`'s `FOR NO KEY UPDATE`; (c) changed `bumped` from an `UPDATE ... RETURNING` to a plain
   `SELECT` (since the counter was already bumped by (a)). Re-ran "F2 (round 5)" alone — it FAILED:
   ```
   NeonDbError: update or delete on table "dm_conversations" violates foreign key constraint
   "dm_messages_conversation_id_fkey" on table "dm_messages"
     at sendDm (src/lib/store/dms/db.ts:170:15)
   ```
   With the pair lock gone, the real send's own transaction no longer excludes concurrent writers on
   the row, and the resulting race corrupted statement 3's self-gating precondition badly enough to
   throw a live FK violation rather than merely time out — a LOUDER failure than the anticipated
   "fewer than 2 backends" timeout, but still an unambiguous, reproducible failure of the exact
   defect class F2 exists to catch. Restored all three changes verbatim (confirmed via `git diff`
   showing only the F5 addition remains); re-ran "F2 (round 5)" alone (green) and the full file three
   times (21/21 each, see Gate results).

3. **F3**: test-infrastructure only (no new production behavior to suppress-and-observe); correctness
   evidenced by the three clean full-file runs plus F2's own reliance on an accurate `gateHolderPid`.

4. **F4**: reverted `resolveDmCounterpart` to name-first. New test failed:
   ```
   - Array [ "before withdrawal" ]
   + Array []
   ```
   — the impostor (live agent named after the withdrawn id) received an empty fresh thread instead of
   the caller's retained history. Restored; `dm-routes.test.ts` re-ran green (31/31).

5. **F5**: reverted `getDmThreadPreview` to ignore the store's answer (return `""` unconditionally).
   New test failed:
   ```
   Expected: "me", "other"
   Number of calls: 0
   ```
   — `getLastReceivedDmMessage` was never even called. Restored; `inbox-classes.test.ts` re-ran green.

## Shared-file edits

- `src/lib/agent-pulse/runner.ts` (dm/fence-loss path only, re-read immediately before each edit):
  `PulseFence` interface added (extends `PulseTickBundle`), `createPulseFence` returns it,
  `anyToolGuardRefused` removed, `fenceOrGuardLost` simplified, `completeAfterTurnThrow` added, the
  `runAgenticTurn` call gains `onToolExecuted: fence.onToolExecuted`. No other function touched.

No new store exports beyond `getLastReceivedDmMessage` (a `get*`-prefixed READ — no
`MUTATING_STORE_EXPORTS` entry needed; `boundary-manifest-completeness.test.ts` re-run green). No new
`ActionErrorCode`, no new `NotificationType`, no migration file, no `.eslintrc.json` regeneration
(none of this round's changes touch generated-boundary-relevant exports).

## Out-of-fence needs / cross-lane notes

- None observed this round. `git status` at session end shows lane M's and lane S's files
  (`notifications/{db,memory}.ts`, `store/activity/events.ts`, `store/wakeups/{db,memory}.ts`,
  `store/agents/db.ts`, `app/api/v1/internal/school-events/route.ts`,
  `__tests__/integration/m11-2-b1-mentions.test.ts`) modified concurrently but untouched by this lane.

## Docs delta

None. All six findings are internal store/action/runner/test behavior with no new public API surface
or documented contract change. `getLastReceivedDmMessage` is an internal store function, not a new
endpoint or field.

## Behavior changes or plan deviations

- **F1** changes WHEN guard loss is observed (live, via `onToolExecuted`) rather than WHAT it means —
  no caller-visible behavior change beyond closing the throw-after-refusal gap itself.
- **F4** changes `resolveDmCounterpart`'s precedence (id-before-name instead of name-before-id) for
  the one case they can disagree: a live agent's name colliding with a withdrawn participant's id.
  Every other caller (a real name, or an id with no colliding live name) resolves identically.
- **F5** is a bug fix with no contract change: the preview was always documented as "the last
  received message"; it could previously return `""` incorrectly in a corner case now fixed.
- No other deviations from the round-5 fix spec.
