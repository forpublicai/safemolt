# Deliverable 6 — cross-cutting race / e2e tests (the wakeup queue's final gate)

You are implementing the LAST deliverable of SafeMolt's M11-2 wave u5 Lane C (the wakeup queue), on
branch `ops/code-improve` in /Users/mohsin/Github/safemolt (already checked out — do NOT switch
branches, do NOT run any git commands, do NOT run codex). This is a fresh agent with no memory of any
prior conversation; everything you need is below.

Deliverables 1-5 of this lane are ALL DONE, gates green, verified independently by the manager
(tsc clean, lint clean, full unit suite 179/179 suites green, and every new/changed integration suite
green in a combined targeted run). You are not implementing new production behavior — the wakeup
queue, the router, the notifications projection and all three `playground.round_opened` producers
already exist and work. Your job is the cross-cutting test suite that proves the PIECES compose
correctly under real concurrency and real drains, which no single deliverable's own tests fully cover
because each of deliverables 3/4/5 was built and tested in isolation from the other two.

## What already exists — read these before writing anything

1. `CLAUDE.md`'s "Store and Migration Invariants" section, in full.
2. `src/lib/store/wakeups/{db,memory,index}.ts` — the wakeup store. You will call `listWakeupsForAgent`,
   `getWakeupByAgentReasonEvent`, `findRoundOpenedEventId` as read helpers in assertions. Do not modify
   this domain.
3. `src/lib/events/consumers/wakeup-router.ts` — the router consumer (`wakeupRouterConsumer`,
   `wakeupRouterEffects`). Routes `comment.created` → `comment_on_my_post` / `reply_to_my_comment`, and
   `playground.round_opened` → `reason: "playground_round"` for every active, un-acted participant.
   Registered in `src/lib/events/consumers/registry.ts` alongside `notificationsConsumer`,
   `activityTrailConsumer`, `memoryIngestConsumer`.
4. `src/lib/events/consumers/notifications.ts` — gained `applyPlaygroundRoundOpenNotifications`, which
   writes a `playground_round_open` notification (dedup key `playground_round_open:{agentId}:{event.id}`)
   for the SAME un-acted-participant set the router computes, independently.
5. `src/lib/playground/session-manager.ts`:
   - `joinSession` (exported) triggers the private `activateSession(session, game)` once
     `participants.length >= game.minPlayers`. `activateSession` flips the session to `active` round 1
     via `store.activatePlaygroundSession(id, 1, now)` (no deadline set), then fires
     `safeWaitUntil(generateRoundPrompt(activeSession, game).then(async (prompt) => { await
     store.storeRound1PromptIfMissing(id, prompt, ACTION_TIMEOUT_MS, [playgroundRoundOpenedEvent(...)]);
     }), ...)` — **fire-and-forget, never awaited by the caller**. `generateRoundPrompt` is imported from
     `@/lib/playground/engine` (confirm the exact import path by reading the top of
     `session-manager.ts`) and is already mocked in existing tests
     (`src/__tests__/integration/m11-2-u3d-playground.test.ts` has
     `jest.mock('@/lib/playground/engine', () => ({ ...jest.requireActual(...), generateRoundPrompt:
     jest.fn(async () => "round prompt") }))` — read that file's mock block for the exact shape and
     import specifier, it may not be exactly this).
   - `checkDeadlines()` (exported) runs, in order: round advance, auto-activate pending sessions, **1c
     round-1 repair** (`store.listSessionsNeedingRound1PromptRepair(ROUND1_PROMPT_REPAIR_GRACE_MS, 50)`,
     then per stuck session: `generateRoundPrompt` → `storeRound1PromptIfMissing` with the SAME event
     builder), **1d+1e bridge + create-or-re-arm** (one fused pass over `listPlaygroundSessions({status:
     'active', limit: 50})`: reconstructs a missing `round_opened` via `store.emitEvent` when a prompted
     round lacks one, idempotent via `idem_key playground_round_opened:{session_id}:{round}`, then
     arms/re-arms a wakeup per active un-acted participant via `store.createOrReArmWakeup`), then expire
     stale pending sessions, then lifetime cap. `ROUND1_PROMPT_REPAIR_GRACE_MS = 2 * 60 * 1000` (2
     minutes) — a session must be aged past this before the repair step will touch it.
   - `advanceToNextRound`'s call to `store.applyPlaygroundResolution` now carries a 5th argument, one
     `playgroundRoundOpenedEvent({ sessionId, round: nextRound, schoolId })`, gated on the SAME CAS
     (`WHERE status='active' AND current_round=$prev`) that already exists. `completeSession`'s call is
     unchanged (never carries `round_opened`).
   - `tryAdvanceRound(sessionId)` (exported) is what both a submit and the deadline sweep call to
     attempt to close out a round.
6. `src/lib/actions/playground-events.ts`'s `playgroundRoundOpenedEvent(options)` — the shared builder,
   `{ sessionId, round, schoolId, reconstructed?, idemKey? }`.
7. **Deliverable 5 ALREADY wrote a store-level round-1-prompt race test**:
   `src/__tests__/integration/m11-2-u5c-round-opened.test.ts`, describe block "the round-1 prompt race",
   test "admits ONE of four concurrent publications and emits exactly one event" — it fires FOUR bare
   `storeRound1PromptIfMissing` calls concurrently via `runConcurrently` (no held lock; Postgres's own
   row-lock queuing on the UPDATE is what serializes them) and asserts exactly one succeeded and exactly
   one event exists. **This already proves the SQL predicate/CAS itself is race-safe. Do not duplicate
   this test.** What it does NOT prove, and what is still missing, is the END-TO-END version: the REAL
   `activateSession` fire-and-forget write racing the REAL `checkDeadlines()` repair step for the SAME
   session, through the actual production call paths, with the assertion carried all the way through to
   the wakeup queue and the notifications table (deliverables 3 and 4), proving the race does not
   duplicate a wakeup or a notification either. That end-to-end version is still owed and is described
   below as "Scenario 1."
8. Race-harness precedent, `src/__tests__/integration/helpers/concurrency.ts`: `pgClient()`/`pgPool()`
   from `./db`; `raceAgainstHeldLock({ hold, contend, contenderMarker, observeForMs? })` for one held
   lock + one contender; `runConcurrently(fns)` + `rejections(outcomes)` for N genuinely concurrent real
   calls (no artificial hold — relies on Postgres's own row-lock serialization, which is sufficient when
   the racing statements are single conditional UPDATEs against the same row, as `storeRound1PromptIfMissing`
   is). Read `src/__tests__/integration/m11-2-u3f-core-classes.test.ts`'s describe block "the enroll cap
   holds under a genuine two-connection race (R2-1)" (around line 393) for the manual `pgClient()` +
   `pg_blocking_pids()` polling idiom used when you need to prove TWO REAL application-level calls (not
   a raw-SQL holder) were both genuinely blocked before releasing — this is the pattern to reach for
   when a bare `runConcurrently` might not reliably create overlap because one side's async chain
   (`generateRoundPrompt` → `storeRound1PromptIfMissing`) has non-trivial async latency before it even
   issues its UPDATE. Also read the same file's "a student message races a concurrent session
   completion" test (around line 469) for the `raceAgainstHeldLock` idiom (one held lock, one real
   contending call).
9. `src/__tests__/integration/m11-2-u3d-playground.test.ts`'s `beforeAll` for the
   `idx_pg_sessions_one_live_per_school` orphan-neutralization idiom — copy it verbatim into any new
   integration suite that touches `playground_sessions`.
10. For the memory-mode consumer-drain test, find how `notifications.ts`'s own existing unit tests (or
    `wakeup-router.test.ts` from deliverable 4, at `src/__tests__/lib/events/wakeup-router.test.ts`)
    register consumers for a memory-mode drain — grep for `__setMemoryEventConsumersForTests` and copy
    the exact harness idiom from whichever of those two files uses it most simply.

## The one open design question you must resolve yourself, with reasoning in your report

`activateSession`'s round-1 write is genuinely fire-and-forget (`safeWaitUntil` does not return the
inner promise and the caller — `joinSession` — does not await it). To build "Scenario 1" (the real
end-to-end round-1 prompt race) you need BOTH the activation path's write and the repair sweep's write
to be in flight for the SAME session at overlapping times, deterministically, not by luck. Two
reasonable approaches, in descending order of how directly they exercise production code — pick
whichever actually works after you try it, and say which you used and why in your report:

- **(a) Control `generateRoundPrompt`'s timing.** Mock it (module-level `jest.mock`, matching
  `m11-2-u3d-playground.test.ts`'s existing mock target) so you can hold BOTH calls (activation's and
  the repair sweep's) pending on an externally-resolved promise, release them at the same tick, and let
  both downstream `storeRound1PromptIfMissing` calls race each other for real over the Neon HTTP driver.
  This exercises the real `activateSession` and the real repair step in `checkDeadlines()`, and the only
  thing synthetic is the GM-latency simulation, which is already how every existing playground test
  controls this.
- **(b) Hold the `playground_sessions` row `FOR UPDATE`** on a raw `pgClient()`, kick off a real
  `joinSession` call (to trigger activation — do not await its fire-and-forget inner write, just let the
  call return) and a real `checkDeadlines()` call for a session already aged past
  `ROUND1_PROMPT_REPAIR_GRACE_MS`, wait for both `storeRound1PromptIfMissing` executions to be observed
  blocked (`pg_blocking_pids` + a query marker — check whether `storeRound1PromptIfMissing`'s SQL already
  carries an SQL comment marker like `/* race:... */`; if not, you may need this precise wording
  reviewed — do NOT add a marker to production SQL without matching the existing convention exactly,
  grep `src/lib/store/playground/db.ts` for `/* race:` or similar markers other statements already
  carry and follow that convention), release, assert exactly one won.

Either way, the end assertion is the same and is what actually matters: after both racers settle,
**exactly one** `agent_wakeups` row and **exactly one** `notifications` row of type
`playground_round_open` exist per active participant, keyed to **exactly one** `playground.round_opened`
event — never zero (a lost wakeup), never two (a duplicate nudge from the race). Drive the router and
notifications drain (db-mode: `drainEventConsumer`, matching how `m11-2-u1-drain.test.ts` or
`m11-2-u5-wakeup-router.test.ts` already drains in a test) after the race settles, then assert.

## Scenarios to build (integration unless noted; this is the design brief, not literal copy-paste)

Build ALL of these. Mention-suppression is inapplicable in this codebase (no `agent.mentioned` kind
exists) — do not attempt it.

1. **Scenario 1 — the round-1 prompt race, end-to-end (the single highest-value test in this whole
   lane).** Described above. Do not skip or shortcut it.
2. **`no-wakeup-before-prompt`** — an active round-1 session with NO stored prompt yet (activation
   flipped the status but the async write has not landed) produces zero wakeups and zero notifications
   when `checkDeadlines()` runs (the repair step is inside its grace window and does not fire; the
   bridge step explicitly skips a promptless session — confirm this by reading deliverable 5's final
   1d+1e code, which checks `session.currentRoundPrompt === undefined || === null` before doing
   anything).
3. **`upgrade-bridge`** — seed an active session directly (raw SQL or a store call) with a stored
   round-1 (or round-N) prompt and NO `playground.round_opened` event at all (simulating a session that
   predates this kind). Run `checkDeadlines()`. Assert: exactly ONE synthetic event exists afterward
   (`idem_key playground_round_opened:{session_id}:{round}`, `payload.reconstructed: true`), no session
   was forfeited/advanced/expired by this, and wakeups/notifications get created from it (same pass or a
   second `checkDeadlines()` call — check which one deliverable 5's fused 1d+1e step actually produces,
   since it may already arm on the same pass it reconstructs).
4. **`late-recovery`** — a round-1 prompt repaired well after `ROUND1_PROMPT_REPAIR_GRACE_MS` has
   elapsed gets a deadline computed as `now + ACTION_TIMEOUT_MS` at the moment of repair, not anything
   derived from the session's original `started_at`/`created_at` — assert the stored `round_deadline` is
   close to `now + ACTION_TIMEOUT_MS` (a tolerance window, not exact-millisecond), and that zero
   participants were forfeited/expired by the delay.
5. **`stale-round-event`** — a round-N `playground.round_opened` event drained by the router AFTER the
   session has genuinely already advanced to round N+1 (real advance, via `tryAdvanceRound` or
   `advanceToNextRound`, not a hand-edited row) produces NO wakeup and NO notification — receipt only.
   This needs a genuinely advanced session, not just a mismatched `current_round` seeded by hand — use
   the real advance path so the test also proves the advance's own event ordering doesn't accidentally
   race the drain.
6. **`early-actor`** — one participant submits their action (via `submitAction`, the real path, or
   directly via the store's action-submission function if `submitAction` pulls in unrelated GM-inference
   machinery you cannot easily mock — check and use whichever is more direct) BEFORE the round's
   `round_opened` event is drained by the router/notifications consumer. When the drain runs, only the
   REMAINING (un-acted) participants get a wakeup/notification; the one who already acted gets neither.
7. **`submit-vs-deadline` advance race (rounds ≥ 2)** — a submit that completes the round (via
   `tryAdvanceRound`) racing the deadline sweep's own `tryAdvanceRound` call for the SAME session/round.
   Use `raceAgainstHeldLock` or the manual `pgClient()` + `pg_blocking_pids` idiom (whichever the
   existing round-advance CAS tests in `m11-2-u3d-playground.test.ts` already use — search for
   `advanceToNextRound`/`applyPlaygroundResolution` race tests there and follow the SAME idiom rather
   than inventing a new one). Assert: exactly one transition, exactly one `playground.round_opened`
   event for the new round.
8. **`advance-vs-completion`** — a stale round-N completion (the CAS's terminal branch, i.e. a
   completion decided before a concurrent racer had already advanced the session to round N+1) matches
   zero rows in `applyPlaygroundResolution`'s own `WHERE` clause, writes nothing, emits nothing. This is
   the round predicate that already exists, unmodified by deliverable 5 — this test is pure verification
   of existing behavior in the presence of the NEW `round_opened` event argument, not a new mechanism.
   Confirm no stray `round_opened` (or `session_completed`) event appears from the loser.
9. **`memory-mode round-opening`** (UNIT test, not integration) — in memory mode (no DB), drive a
   `playground.round_opened` event through the real emission path with both the wakeup-router and the
   notifications consumer registered (via `__setMemoryEventConsumersForTests` or whatever the exact
   harness idiom is — see point 10 above), and assert BOTH the wakeup and the notification are visible
   the instant the emitting store call resolves (Decision 6's `await` delivery mode — no cron, no
   worker). Also assert that a stale event (session already advanced/completed in the memory store)
   produces neither.
10. **Re-arm predicate coverage — confirm, do not duplicate.** Deliverable 3's own unit and integration
    suites already cover the full normative re-arm predicate exhaustively (cases a-f, mutation-checked
    by the manager directly). Do not write new tests for the predicate itself; if you find a gap
    specific to the SWEEP's usage of `createOrReArmWakeup` (e.g., the sweep re-arming a wakeup for a
    participant who already has a completed 'acted' wakeup from a PRIOR round, keyed by a DIFFERENT
    event id — should create a fresh one, not touch the old row) that's a legitimate new case worth one
    test; state explicitly why it's new coverage, not a duplicate.

## Fences

- NEW test files only, under `src/__tests__/integration/` (most scenarios) and `src/__tests__/lib/` or
  wherever the memory-mode consumer tests already live (scenario 9) — match this repo's existing
  placement conventions, mirroring `m11-2-u5c-round-opened.test.ts` / `m11-2-u5-wakeup-router.test.ts`'s
  location and naming style (e.g. `m11-2-u5d-wakeup-races.test.ts` or similar — your choice, state it).
- You may READ (never modify) anything under `src/lib/store/wakeups/**`, `src/lib/events/consumers/**`,
  `src/lib/playground/**`, `src/lib/store/playground/**`, `src/lib/actions/playground-events.ts`.
- Do NOT modify any production file. If you believe you have found a genuine defect (not a test-design
  problem) while building these races, STOP, do not fix it yourself, and report it in full instead —
  the manager will triage whether it's real and whose fence it falls in.
- Do NOT touch `src/lib/agent-loop.ts`, `src/lib/agent-home/**`, `src/lib/agent-opportunities.ts` (a
  different lane's fence), `.eslintrc.json`, `package.json`, `agents.md`/`CLAUDE.md`,
  `ai/validation/m11-inventory.md`.
- Do not write summary/report `.md` files anywhere in the repo. Put your full report in your final
  message text only.

## Hard rules (binding, repo-wide)

No git commands ever. No codex. No `npm run build`. No full `npm run test:integration` with no
arguments — targeted runs only (`npm run test:integration -- <your new suite files>`); if a run waits on
the reserved-DB advisory lock, WAIT for it, never kill another process. RUN-suffix every fixture value
under a UNIQUE column. Neutralize `idx_pg_sessions_one_live_per_school` orphans in `beforeAll` for every
suite touching `playground_sessions`. Wall-clock ordering is never an assertion basis for a race —
`observedBlocked`/row counts/event counts are (per `concurrency.ts`'s own header comment). Mutation-check
is not required for scenarios that verify EXISTING, unmodified behavior (8, 10) but IS expected for
anything you'd call a genuinely new assertion about a race outcome (1, 7) — if practical, briefly show
that a deliberately-broken version of the relevant guard (e.g., temporarily removing the round predicate
from a describe you're pinning, if you can do so non-destructively via a local experiment) makes your
new test fail, then confirm it passes against the real code; if a mutation check isn't practical for a
given scenario (e.g. it would require modifying store internals you're fenced off from), say so
explicitly rather than skipping the discussion.

## Gates

- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors on files you touched.
- Targeted unit: any new unit test file you add (scenario 9), `--runInBand`, green. Also re-run
  `npm test -- --runInBand src/__tests__/lib/events` if you touched anything there, to confirm no
  collision with deliverable 4's router tests.
- Targeted integration: `npm run test:integration -- <your new suite files>` plus
  `m11-2-u5-wakeups.test.ts`, `m11-2-u5-wakeup-router.test.ts`, `m11-2-u5c-round-opened.test.ts`,
  `m11-2-u3d-playground.test.ts` (the four suites your new tests most directly extend/depend on
  conceptually) — WAIT on the reserved-DB lock if you hit it.

## Report format

Files created (one line each, with which scenario(s) each covers); which design option (a) or (b) you
used for Scenario 1 and why, with the exact blocking/interleaving evidence you observed
(`observedBlocked`, `pg_blocking_pids` counts, or the deferred-promise release ordering — whichever
applies); the final row/event/wakeup/notification counts your Scenario-1 assertion checks; per-scenario
pass/fail with test counts; the re-arm-predicate-gap finding from item 10 if you found one (with
reasoning for why it's new coverage) or an explicit "none found, confirmed by reading deliverable 3's
suite" if you did not; any production defect you found and did NOT fix (full description, file, line);
gate results with exact counts; anything you deliberately left out of scope and why.
