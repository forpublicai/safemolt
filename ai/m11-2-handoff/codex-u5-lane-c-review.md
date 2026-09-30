# Scoped review — u5 Lane C: P3.2 wakeup queue (round 1)

You are the review agent (read-only). Do NOT run jest, tsc, or the build — the sandbox denies the
temp writes and the attempt can kill your session. All five gates pass (tsc clean, lint 0 errors,
180 suites/1729 unit, full integration green, build green). Reason from the code.

Review the M11-2 P3.2 implementation on branch `ops/code-improve`. The plan text is
`ai/PLAN_M11_2.md` lines 266–298 (P3.2 — normative down to SQL shapes; line 297 is the gate list).
Binding invariants: CLAUDE.md "Store and Migration Invariants". The wave diff is
`git diff 84bd3d9..HEAD` restricted to the files below.

## Scope (this lane's files)

- `scripts/migrate-m11-wakeups.sql` (+ its `scripts/migrate.js` entry)
- `src/lib/store/wakeups/{db,memory,index}.ts`, `src/lib/store/_memory-state.ts` (wakeup part),
  `src/lib/store.ts` (re-export)
- `src/lib/events/kinds.ts` (`playground.round_opened`), `src/lib/events/consumers/{coverage,
  registry,notifications}.ts` (the new manifests + `playground_round_open` projection),
  `src/lib/events/consumers/wakeup-router.ts` (NEW consumer)
- `src/lib/playground/session-manager.ts`, `src/lib/store/playground/{db,memory,index}.ts`,
  `src/lib/actions/playground-events.ts`, `src/lib/store-types.ts`,
  `src/lib/store/notifications/{db,memory,index}.ts`
- Tests: `src/__tests__/lib/store/wakeups/`, `src/__tests__/integration/m11-2-u5-wakeups*.test.ts`,
  and the new/edited playground + events test files in the diff.

## What was built (verify each against the plan)

1. Migration: `agent_wakeups` + 4 partial indexes + `pulse_budget_counters`; both `agent_id` FKs
   `ON DELETE CASCADE` (inline + a guarded DO block); idempotent.
2. Wakeup store both modes: enqueue (`ON CONFLICT DO NOTHING`, delivery resolved at enqueue —
   loop-enabled ⇒ `internal`, else NOT created pre-P5), the plan's normative re-arm predicate
   VERBATIM, list/read helpers. NO claim/lease/completion writers (P3.3, deferred by design).
3. Router consumer: comment.created → wake reply/comment-on-my-post target;
   `playground.round_opened` → wake each active un-acted participant after the consume-time
   freshness check (session active, round matches, no `playground_actions` row for the triple);
   stale ⇒ receipt only; `agent.followed` ⇒ nothing. `agent.mentioned`/`dm.sent` deliberately out
   (kinds do not exist yet — M11b).
4. Notifications consumer: the markable `playground_round_open` projection with the SAME un-acted
   predicate (one owner per projection).
5. Producers: `storeRound1PromptIfMissing` — ONE conditional statement shared by activation's async
   write and the sweep's repair (`status='active' AND current_round=1 AND current_round_prompt IS
   NULL RETURNING id`), event gated on the RETURNING; `activateSession` no longer pre-sets
   `round_deadline` (prompt publication starts the clock; a promptless active round is
   un-expirable); `advanceToNextRound`'s CAS carries the complete transition state + the event;
   completion CAS keeps the round predicate and emits NO round_opened.
6. Bridge + re-arm in the deadline sweep: synthetic `round_opened` for prompted current rounds
   lacking one (`idem_key playground_round_opened:{session}:{round}`, `payload.reconstructed:
   true`), then create-or-re-arm wakeups keyed by the round's event id.

## Focus hardest on

- The producers' CAS/conditional statements versus the plan's exact shapes: can two racers both
  emit? Can the loser's write land anything? Is the event ALWAYS gated on the decisive RETURNING?
- Event machinery use: per-event overrides by position, `namePrefix` collisions when two events
  render in one statement, `callerParamBoundary`, `rowSource` where a column is referenced.
- Memory-store parity: Decision 4 (no await between mutation and append; re-validate after every
  await; preflight whole batch; early exits sit where the DB's do). The memory sweep/dispatcher
  path for the memory-mode round-opening gate.
- The router's freshness check and the un-acted predicate: order-independence under concurrent
  drainers; can a stale round-N event beside a legitimate round-(N+1) event produce a second
  claimable wakeup? Receipts written on every skip path?
- The re-arm predicate: exactly the plan's normative UPDATE; live claims never touched.
- The enqueue-time delivery resolution reading loop state: TOCTOU exposure acceptable? (Claim-time
  enforcement is P3.3's; flag only if something WORSE than the plan's own advisory framing exists.)
- Index/uniqueness semantics duplicated in memory mode; `resetWakeupState` completeness.
- Migration idempotency and the DO-block FK repair path.

## Known, recorded decisions — do NOT re-flag

- No claim/lease/completion writers, no budget spending, no idle scheduler, no worker/cron wiring:
  wave 2 (P3.3/P3.1/P3.4), deliberate.
- Memory `resolveWakeupDelivery` answers `internal` unconditionally — `agent_loop_state` has no
  memory twin; documented at the definition site; nothing branches on it until P3.3.
- `createOrReArmWakeup`'s concurrent race may answer `created:false, reArmed:false` on both sides
  with exactly one row — no arbiter, accepted until a caller needs the report.
- The sweep can emit a stray historical event for a round that closed a moment earlier; both
  consumers reject it as stale (receipt, no effect) — recorded as accepted.
- Router scope excludes `agent.mentioned`/`dm.sent` (kinds absent until M11b).
- The residual double-GM-inference on racing advancement is TODAY's exposure and stays backlog —
  do not propose a pre-GM claim.

## Output

Findings as BLOCKER / MAJOR / MINOR / NIT with file:line, concrete failure scenario (inputs →
wrong result), and a proposed fix. If clean, say so plainly. This unit is lock/atomicity-bearing:
it iterates to convergence, so completeness beats brevity.
