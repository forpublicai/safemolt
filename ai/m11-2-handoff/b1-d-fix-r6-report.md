# Lane D — fix report, codex round 6

Source: `codex-findings-b1-d-round6.md`. All four findings fixed. No round 7 (user's "limit
reviews" directive) — orchestrator re-verifies with real runs.

## 1. MAJOR — fence DM bookkeeping writes after a successful read

`src/lib/agent-pulse/runner.ts`:

- `PulseFence` gained `verifyClaim()` (line ~263), the same token-fenced `renewWakeupLease` call
  `beforeTerminalTool` already used — factored out so it can be invoked on demand, not only ahead
  of a terminal tool.
- New helper `reclaimBeforeBookkeeping` (line ~309) — returns the fenced-off outcome when the
  claim no longer holds, `null` when the write may proceed.
- New helper `completeAsDecline` (line ~343) replaces the inline `!terminal` skip branch, and
  `completeAfterTurnThrow` (line ~325) now also calls `reclaimBeforeBookkeeping` before its error
  write. Both are reached only when `NarrowWakeupConfig.reverifyClaimBeforeBookkeeping` is `true`,
  set only by `runDmWakeup` (line ~547) — the reply/playground paths are unchanged (out of fence).
- `runNarrowWakeup` precomputes `reverifyClaim = config.reverifyClaimBeforeBookkeeping === true`
  once (line ~419) and calls `completeAsDecline`/`completeAfterTurnThrow` with it, keeping the
  function's own complexity unchanged (ESLint `complexity` stayed clean; see Gate results).

**Why this closes the gap:** `read_dm_thread` is non-terminal, so `beforeTerminalTool` never runs
for it. A claim can be superseded strictly AFTER that read committed (unlike the round-4/round-5
cases, which mutate the claim before the read executes and so trip the read's own
`execution_guard_failed`). Before this fix, neither `fenceLost()` nor `guardRefused()` had fired,
so a subsequent decline wrote `recordSkip`'s cooldown and a subsequent throw wrote `recordError`
on an agent this runner no longer owned.

**Tests** (`src/__tests__/lib/agent-pulse/runner.test.ts`, new describe block "a claim lost AFTER a
successful read is still fence loss", ~line 380): two cases — decline after a successful read, and
a throw after a successful read — both assert `agentLoopState` is byte-identical to `before` and
the wakeup stays owned by `"another-runners-token"`, uncompleted.

**Mutation-check evidence** (removed `reverifyClaimBeforeBookkeeping: true` from `runDmWakeup`'s
config, reran the two new tests):

```
● ... writes no loop state when the model declines after the read succeeded
  - lastSeenAt: null                          + lastSeenAt: "2026-09-29T05:20:53.965Z"
  - nextEligibleAt: null                      + nextEligibleAt: "2026-09-29T06:20:53.965Z"

● ... writes no loop state when the model throws after the read succeeded
  Expected: "skip"
  Received: "error"

Tests: 2 failed, 21 skipped, 23 total
```

Restored; full suite green again (23/23). Re-ran after the complexity refactor too — same failure
signature reproduced, confirming the extracted helpers still carry the fix.

## 2. MINOR — mutation evidence in `m11-2-b1-dms.test.ts:~598`

`src/__tests__/integration/m11-2-b1-dms.test.ts`, F2 (round 5) describe block: added
`await seedConversation(a.id, b.id);` before the setup send (was: the setup send was the pair's
first-ever message, so a mutated bump statement failed there instead of at the real barrier).
Updated the block's docstring to record the corrected evidence.

**Mutation-check** (dms/db.ts's `sendDm`, temporarily): split the bump into its own earlier,
separately-committed `sql!` call (target lock + claim + bump, auto-committing and releasing the
pair lock), leaving the transaction's statement 2 to insert the message using the pre-bumped
values. Ran the targeted test:

```
● F2 (round 5) ... a second send and a read both wait on the paused send's own backend ...
  no backend blocked by pid 854 within 5000ms
    at waitForContenderBehind (m11-2-b1-dms.test.ts:150:9)
    at Object.<anonymous> (m11-2-b1-dms.test.ts:616:27)
Tests: 1 failed, 20 skipped, 21 total
```

Line 616 is inside the barrier-proving section (after the setup send already succeeded) — the
failure is now genuinely at the barrier: the paused insert no longer carries the
`race:dm-send-pair-lock` marker (it moved to the separately-committed pre-statement), so
`waitForContenderBehind` never finds a waiter. This replaces the round-5 evidence, which fired
during the unrelated setup send.

Reverted `dms/db.ts` — `git diff --stat src/lib/store/dms/db.ts` shows no changes (byte-identical
to HEAD). Full DM integration suite reran green (21/21) after the revert.

## 3. MINOR — `messages.ts:~138` converts invalid content into a message

`src/lib/agent-tools/definitions/messages.ts`, `send_dm` executor: rejects `typeof args.content
!== "string"` before any conversion, returning `{ success: false, error: "content must be a
string", data: { code: "bad_request" } }` — the same refusal `POST /api/v1/dm/{agent_name}` gives
(`src/app/api/v1/dm/[agent_name]/route.ts:104`).

**Tests** (`src/__tests__/api/dm-routes.test.ts`, `it.each([[null], [undefined], [42]])` in "the
five tool executors", ~line 231): asserts the refusal shape, no conversation created
(`listDmConversations`), no rate-limit counter touched (`commentCountToday`), no `dm.sent` event
(`eventLog.rows`).

**Mutation-check** (reverted to `content: String(args.content)`):

```
● ... rejects non-string content (null) ...
  - success: false, data.code: "bad_request"
  + success: true,  data: { conversation_id: ..., message_id: ..., seq: 1 }
● ... rejects non-string content (undefined) ...  (same shape)
● ... rejects non-string content (42) ...          (same shape)
Tests: 3 failed, 31 skipped, 34 total
```

Confirms the unfixed code silently sent `"null"`/`"undefined"`/`"42"` as real messages. Restored;
full suite green (34/34).

## 4. NIT — dead code and a stale comment

- `src/lib/store/notifications/db.ts`: `dmReceivedNotificationParams` inlined at its one call
  (`createDmReceivedNotificationIdempotent`, ~line 522); the standalone function removed.
- `src/lib/events/consumers/coverage.ts` (~line 543): trimmed the `dm.sent` comment from
  "The blocked-conversation re-check is router logic (a later round), not a coverage-state
  question — this only says the kind routes." to "Wakes the recipient (block re-check lives in the
  router's `routeDmSent`)." — the re-check landed in `wakeup-router.ts`'s `routeDmSent`
  (`isDmBlocked` call) well before this round; the "later round" framing was stale.

## Whole-fence audit (convergence policy §2)

Reviewed every statement in the fence for the two recurring rules:

- **Lock order / bare-EXISTS liveness**: `dms/db.ts`'s statements each touch one canonical pair row
  (`dm_conversations`, locked directly via `FOR NO KEY UPDATE` in `target`, never a bare `EXISTS`
  liveness pre-check) plus `agent_rate_limits`/`dm_messages` as sibling CTEs gated on that lock —
  no cross-table lock-order concern (DM tables carry no FK to `agents` except
  `agent_rate_limits.agent_id`, handled via `isSenderForeignKeyViolation`'s catch, not a lock).
  `notifications/db.ts`'s `DM_RECEIVED_NOTIFICATION_SELECT` locks the recipient `FOR KEY SHARE`,
  matching the webhook-notification precedent beside it. No changes needed.
- **Behavioral tests fail when the behavior is removed**: verified for every test I added or
  touched this round (evidence above). Pre-existing DM tests were already whole-fence-audited in
  round 5 (`b1-d-fix-r5-report.md`, item 7) and round 6's own codex review — which re-read this
  fence end to end — raised only the four items above, not a fifth. No further changes made.

Audit found nothing beyond the four listed items.

## Gate results

```
npx tsc --noEmit                                        → clean (no errors from any file this
                                                            lane touched, across repeated runs;
                                                            see note below)
npx eslint <7 touched source files>                      → 0 errors, 0 warnings
                                                            (runNarrowWakeup complexity: 12, same
                                                            as before this round's fix)
npx jest src/__tests__/api/dm-routes.test.ts
          src/__tests__/lib/agent-pulse/runner.test.ts
          src/__tests__/lib/store/dms-memory.test.ts     → 80/80 passed
npm run test:integration -- \
    src/__tests__/integration/m11-2-b1-dms.test.ts       → 21/21 passed
```

**Note on `tsc --noEmit` flakiness**: this branch runs four concurrent lanes in one working tree.
Across repeated `tsc` runs during this session, `src/__tests__/lib/symmetry-contract.test.ts`
(outside this lane's fence — owned by another lane, explicitly listed as do-not-touch) showed
different transient type errors each time, consistent with another lane mid-edit. No error ever
named a file this lane touched. Left untouched per the fence.

## Shared-file edits

None — no shared files (`kinds.ts`, `coverage.ts`'s four manifests as new entries, `store.ts`,
etc.) needed new entries this round; the `coverage.ts` edit was a comment trim on an existing line,
not a new manifest entry.

## Out-of-fence needs

None identified.

## Docs delta

None — no behavior visible to `public/reference.md`/`skill.md`/`openapi.json`/`planned.md` or a
new `CLAUDE.md` invariant changed this round (the fixes close a runner-internal race and an
input-validation gap; the DM API's documented contract is unchanged).

## Behavior changes

- `send_dm` (both the tool and, indirectly, nothing about the route — it already validated) now
  refuses non-string `content` instead of coercing it to a literal `"null"`/`"undefined"` message.
  Any caller that was relying on that coercion (none known; it was never a documented behavior)
  now gets `bad_request` instead.
- No other externally visible behavior changed. The DM runner fix is purely about which internal
  agent this runner writes bookkeeping for after a claim is lost — no new refusal code reaches an
  API response.
