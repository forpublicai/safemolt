# u5 Lane C (wakeup queue) — manager handoff, stop point 2026-08-26 01:29

Rotated out by the orchestrator for context freshness, mid-deliverable-3. This file is written so a
FRESH manager (no memory of the prior conversation) can pick the lane up with zero re-derivation of
the architecture — every SQL shape, function signature and file-fence decision below is final and
should be treated as settled, not re-litigated, unless you find it to be actually wrong.

**Read this whole file before touching anything.** Then read the lane's own spec,
`ai/m11-2-handoff/u5-lane-c-wakeups-spec.md`, and `CLAUDE.md`'s "Store and Migration Invariants"
section, exactly as the original manager brief required.

## Branch / repo state

Branch `ops/code-improve`, uncommitted (the orchestrator owns all commits — do not commit). Two OTHER
lanes are running concurrently in this same working tree right now — you will see modified/untracked
files that are NOT yours: `src/lib/agent-loop.ts`, `src/lib/auth.ts`,
`src/__tests__/lib/access-gate-inventory.test.ts`, `src/app/api/v1/agents/me/context/`,
`src/lib/agent-senses/`, `src/__tests__/lib/agent-senses/`. **Do not touch any of these** — they
belong to Lane B (senses) per the original fence (`src/lib/agent-loop.ts` / `agent-home/**` /
`agent-opportunities.ts` are Lane B's exclusive territory) and possibly Lane A. This is expected and
not a problem; just don't step on them, and don't be alarmed that `git status` shows more than your
own lane's files.

## Deliverable-by-deliverable disk state

### 1. Migration — DONE, applied, verified

`scripts/migrate-m11-wakeups.sql` (new file) — the `agent_wakeups` + `pulse_budget_counters` DDL,
verbatim from `ai/PLAN_M11_2.md` P3.2, **plus a fix the first implementation subagent correctly
caught**: both tables' `agent_id` columns carry `REFERENCES agents(id) ON DELETE CASCADE` (inline in
the `CREATE TABLE`s, plus a guarded retrofit `ALTER ... ADD CONSTRAINT` DO-block for the case where an
earlier apply of this same file ran without the FK — which is exactly what happened this session; see
"What actually happened, in order" below). This is `ai/PLAN_M11_2.md`'s "Agent-FK policy" pin
(search the plan for that phrase) — it is NOT repeated in the plan's own inline DDL sketch for P3.2,
but the plan explicitly says the sketch is "read with it applied even where not repeated." Verified
against `pg_constraint` on the dev DB: both `agent_wakeups_agent_id_fkey` and
`pulse_budget_counters_agent_id_fkey` exist with `confdeltype = 'c'` (CASCADE).

`scripts/migrate.js` — one new entry appended to `MIGRATION_FILES`:
`{ file: "migrate-m11-wakeups.sql", label: "Agent wakeup queue and pulse budget counters" }`.

`npm run db:migrate` has been run TWICE this session (once by the implementation subagent, once by me
after the FK fix — I deleted the `_migrations` row for this filename via a one-off `pg` client script
and re-ran the migrate command so the corrected file's `SUCCESS` path actually executed rather than
being skipped as "already recorded"). Current state: `_migrations` has one row for
`migrate-m11-wakeups.sql`, and the FK constraints are live on the dev DB. **Nothing left to do here.**
If you ever need to re-verify: `SELECT conname, conrelid::regclass, confrelid::regclass, confdeltype
FROM pg_constraint WHERE conname IN ('agent_wakeups_agent_id_fkey','pulse_budget_counters_agent_id_fkey')`
should return two rows, both `confdeltype = 'c'`.

**Consequence for every fixture you or any subagent writes from here on**: every `agent_wakeups` /
`pulse_budget_counters` row in an integration test MUST reference a real, already-seeded `agents.id`,
or the insert raises `23503`.

### 2. Kind + manifests — DONE

`src/lib/events/kinds.ts`: `playground.round_opened` is in `EventPayloadMap` and `KIND_MEMBERSHIP`.
Payload: `{ session_id: string; round: number; reconstructed?: boolean }`. Subject columns (set by
producers, not by this file): `subjectType: "playground_session"`, `subjectId: <session id>`,
`actorAgentId: null` (no acting agent opens a round). Verify this file compiles and its own doc
comment about `round_opened`/`round_resolved` reads sensibly before building on it — the
implementation subagent updated the "deliberately ABSENT" comment block; a fresh read is cheap
insurance.

`src/lib/events/consumers/coverage.ts`: all THREE existing manifests
(`notificationsCoverage`, `activityTrailCoverage`, `memoryIngestCoverage`) have a
`"playground.round_opened"` entry — notifications `"on"` (new-kind protocol, never shadowed — no
legacy writer), activity-trail `"none"`, memory-ingest `"none"`. No `wakeupRouterCoverage` manifest
exists yet — that is deliverable 4's job (spec below), a NEW fourth manifest in this same file.

**Test files the implementation subagent had to touch as a SIDE EFFECT of adding the kind** (not
scope creep — read before you're surprised by them in `git status`): `src/__tests__/integration/m11-2-u1-events.test.ts`,
`src/__tests__/lib/events-substrate.test.ts`, `src/__tests__/lib/events/consumer-coverage.test.ts`.
These files apparently used `playground.round_opened` as a stand-in example of an "unknown kind" in
some fixtures (ironic, since it just became a known one) and were updated to use
`playground.round_resolved` instead (which genuinely remains absent — the round-RESOLUTION CAS kind,
not built by this lane or any lane yet). **Gate status on these**: the first subagent reported
`npx tsc --noEmit` clean and the FULL unit suite green (169 suites / 1589 tests) after this change —
but that was BEFORE the FK fix and BEFORE deliverable 3's glue landed, so re-run the unit suite once
you've confirmed deliverable 3 (below) is stable, don't just trust the old number blindly.

### 3. Wakeup store — CODE DONE, TESTS PARTIALLY DONE, GATES NOT RUN, NO REPORT RECEIVED

This is the one still actively in motion when I was rotated out. Read this section carefully; it is
the reason a fresh manager is needed rather than a fresh subagent picking up cold.

**What exists on disk, verified by direct reading (not trusting any subagent self-report — none was
received):**
- `src/lib/store/wakeups/db.ts` (332 lines) — COMPLETE. All seven functions from the spec
  (`enqueueWakeup`, `createOrReArmWakeup`, `reArmWakeupById`, `getWakeupByAgentReasonEvent`,
  `listWakeupsForAgent`, `findRoundOpenedEventId`, `resolveWakeupDelivery`), plus `StoredWakeup`,
  `WakeupDelivery`, `EnqueueWakeupInput/Result`, `CreateOrReArmWakeupInput/Result`, `rowToWakeup`,
  `DEFAULT_WAKEUP_LIST_LIMIT`, `ROUND_OPENED_KIND`, `normalizeListLimit`. I read the whole file: the
  SQL matches the spec's exact predicates verbatim (the `createOrReArmWakeup` CTE pair, the
  `reArmWakeupById` normative predicate, the bare `ON CONFLICT DO NOTHING`, `findRoundOpenedEventId`'s
  `payload->'round' = to_jsonb($3::int)` matching), and the reasoning comments are excellent. **I
  consider this file done and correct** — I would not ask a fresh subagent to rewrite it, only to add
  tests against it if gaps are found.
- `src/lib/store/wakeups/memory.ts` (272 lines as of my last read, may have grown slightly more by the
  time you look — it was still being edited) — COMPLETE, same seven functions, same semantics,
  including the exact `resolveWakeupDelivery` reasoning comment I required verbatim (memory mode
  unconditionally resolves `"internal"` because `agent_loop_state` has no memory-mode store anywhere
  and nothing in this lane's scope branches on `delivery` yet — P3.3 is deferred). Also correct and
  done.
- `src/lib/store/wakeups/index.ts` (32 lines) — COMPLETE. `pickStore`-based facade, all seven
  functions plus the six re-exported types. I read the whole file; matches spec exactly.
- `src/lib/store/_memory-state.ts` — EDITED correctly: `wakeupQueue` module state
  (`{ rows: Map<number, StoredWakeup>; nextId: number }`, globalThis-cached, matching the
  `eventLog`/`playgroundSessions` pattern) plus a `resetWakeupState()` helper (clears both `rows` and
  resets `nextId`, with a comment explaining why both halves matter — the `resetGroupState` reasoning
  applied here). One notable, deliberate architectural choice: this file now has
  `import type { StoredWakeup } from './wakeups/db';` at the top — a type-only import from a domain's
  `db.ts` into the shared substrate file, which is a mild inversion of the usual pattern (other
  domains' types come from `@/lib/store-types` or a domain `types.ts`). It is TYPE-ONLY (erased at
  compile time), creates no runtime circular import (`wakeups/db.ts` does not import from
  `_memory-state.ts`), and I judged it not worth unwinding given the rest of the implementation is
  high quality. If it bothers you, the clean fix is moving `StoredWakeup`/`WakeupDelivery` into
  `store-types.ts` and having `wakeups/db.ts` import them from there instead — but this is optional
  polish, not a defect.
- `src/lib/store.ts` — one new line: `export * from "./store/wakeups";`, in the existing re-export
  block, correctly placed.

**Tests: PARTIAL.** `src/__tests__/lib/store/wakeups/memory.test.ts` exists, 436 lines. I read its
`describe`/`it` structure (not every assertion body). It covers, per my last read:
- `enqueueWakeup` event-keyed dedup (create + refuse second; still refused after completion; keys on
  all three columns) — 3 tests.
- `enqueueWakeup` idle dedup (refuse second pending; admit after completion; dedupes per-reason) — 3
  tests.
- `createOrReArmWakeup` normative predicate: no row → creates; still pending → neither; claimed →
  neither; `result:'acted'` → refused; `budget_exhausted` same-day → refused; `budget_exhausted`
  yesterday → re-arms — roughly 6 tests, looked thorough.
- `reArmWakeupById`: re-arms an `'error'` completion and clears all five columns; refuses
  pending/acted/same-day-budget_exhausted; admits yesterday's budget_exhausted; answers false for a
  nonexistent id — 5 tests.
- `getWakeupByAgentReasonEvent` / `listWakeupsForAgent` (filter by reason, limit, newest-first,
  returns copies not live refs) — 3 tests.
- `findRoundOpenedEventId` (finds correctly, newest-first, non-integer round → null) — 3 tests.
- `resolveWakeupDelivery` (always `"internal"` in memory mode) — 1 test.

**What is MISSING, confirmed by absence**:
- The `(c)`/`(e)` **mutation-check evidence** the spec required (suppress a predicate clause, watch
  the test fail, restore, report it) — I saw no evidence of this having been done or written up; the
  test file's existence proves the assertions exist, not that the mutation check was performed. A
  fresh subagent picking this up should do this explicitly and record it.
- **Integration tests** (db mode) — I found NO file under `src/__tests__/integration/` for wakeups.
  The spec requires: the same dedup/re-arm cases against the real table; the create-or-re-arm
  concurrent race (assert exactly one row exists afterward, not that both callers report success);
  `findRoundOpenedEventId` against a real emitted event; db-mode `resolveWakeupDelivery` seeded via a
  real `agent_loop_state` row. **This is the largest remaining piece of deliverable 3.**
- **Gates never run and reported**: no `npx tsc --noEmit`, no `npm run lint`, no test run confirmed
  green, by this subagent, that I saw evidence of. Run these yourself before trusting the code is
  wired correctly — I verified the files exist and read correctly by eye, but I did NOT run `tsc`
  myself against this state (I was rotated out before I could). **This is your first action**: run
  `npx tsc --noEmit` and `npm test -- --runInBand src/__tests__/lib/store/wakeups` before doing
  anything else, to establish ground truth.

**The implementation subagent itself — status unknown, likely still running or just finished.**

Orchestrator context: I was told "the harness fired your completion notification, which means you had
NO live background children," but file mtimes at the time (files changing every 10-30 seconds, in a
sensible build order: memory.ts → index.ts → _memory-state.ts → store.ts → test file) proved the
opposite — it was demonstrably still alive and working, seconds before I was rotated out. I attempted
`TaskStop` on its agent id (`a3cba482dd11fa18f`) per the orchestrator's instruction to stop it if
possible, and got: `"Task a3cba482dd11fa18f is owned by a3cba482dd11fa18f; agent a9706292ed5fe5d3a
cannot stop it."` — i.e. **I could not stop it**; I lack ownership permission on it (likely because
task ownership is tied to the manager instance that spawned it, and something about the rotation
already changed that binding). **It may still be running RIGHT NOW, writing to these exact files:**
- `src/__tests__/lib/store/wakeups/memory.test.ts` (most likely still growing — it may add an
  integration test file next, or finish the unit file and stop)
- Possibly a NEW file: `src/__tests__/integration/m11-2-u5-wakeups.test.ts` or similar (it hadn't
  appeared yet as of my last check)
- It should NOT touch `db.ts`/`memory.ts`/`index.ts`/`_memory-state.ts`/`store.ts` again (those looked
  finished), but I cannot guarantee it won't.

**Your first move on deliverable 3, concretely**: check `git status` / `ls -la
src/lib/store/wakeups/ src/__tests__/lib/store/wakeups/ src/__tests__/integration/` and compare
mtimes against wall-clock time. If files are still changing (mtime within the last ~60s), WAIT for
quiescence (a Monitor-tool poll loop is the right tool, not a Bash sleep) rather than editing anything
— you could be racing a live writer and corrupting its work. Once quiescent for a couple of minutes
with no new subagent activity, treat it as abandoned/finished and take over: run the gates, and if the
integration suite and mutation-check evidence are still missing, either finish them yourself (the
work is small and well-scoped — the spec at
`ai/m11-2-handoff/u5-lane-c-deliverable3-wakeup-store-prompt.md` has the exact test list) or spawn ONE
fresh, narrowly-scoped subagent whose ONLY job is: "the db.ts/memory.ts/index.ts implementation is
done and correct (do not modify it except to fix a genuine bug the gates reveal); write the missing
integration test suite and the mutation-check evidence; run all gates; report." Do not ask a fresh
subagent to reimplement the store — that would be wasted, duplicated, high-quality-already work.

### 4. Router consumer + notifications `playground_round_open` projection — NOT STARTED

Zero files touched. Full, final, ready-to-launch subagent prompt is at
`ai/m11-2-handoff/u5-lane-c-deliverable4-router-prompt.md` (copied verbatim from my scratchpad before
rotation, so it survives). It is completely self-contained — do not summarize or paraphrase it, hand
it to a fresh OPUS subagent as-is (the launch pattern used earlier in this lane: `Agent` tool, a
one-line message telling the subagent to read that file in full and follow it exactly, plus "do not
write summary .md files, report back in your final message").

**Key decisions already made and locked in that file** (so you don't have to re-derive them):
- `agent.mentioned` and `dm.sent` do NOT exist in this codebase's `EventKind` union (verified by grep
  — they belong to a later mentions/DM train, not yet built). The router is scoped to ONLY the kinds
  that exist: `comment.created` (reply/comment-on-my-post, no mention-suppression needed since there's
  no mention kind) and `playground.round_opened`. `agent.followed` routes to nothing. This is a
  documented, deliberate deviation from the master plan's literal P3.2 prose (which describes routing
  for kinds this codebase doesn't have yet) — correct and necessary, not an error to fix.
- **Fence extension**: this deliverable must touch `src/lib/store-types.ts` (extend `NotificationType`
  with `"playground_round_open"`, extend `NotificationTarget.type` with `"playground_session"`) and
  `src/lib/store/notifications/{db,memory,index}.ts` (new function
  `createPlaygroundRoundOpenNotificationIdempotent` in each, additive only) — these were NOT on the
  lane's originally published file list but are structurally required (the master plan's P2.1 text
  explicitly names this notification type). Additive-only edits, low collision risk with the two other
  concurrently-running lanes. This is explained and justified in the prompt file itself.
- Depends ONLY on deliverable 3 (needs `enqueueWakeup`/`resolveWakeupDelivery` from
  `@/lib/store`) and deliverable 2 (needs the kind, already done). **Does NOT depend on deliverable 5**
  — `getPlaygroundSession`/`getPlaygroundActions` already exist unchanged; the router reacts to
  whatever `playground.round_opened` events exist regardless of which producer emitted them, and the
  subagent is explicitly told to construct/emit test events directly rather than waiting on producers.
  This means **deliverable 4 can run in parallel with deliverable 5** once deliverable 3 is confirmed
  stable (this is a discovery I made that goes beyond the original lane spec's suggested "3∥5, then 4"
  sequencing — file-disjoint, dependency-clean, safe to parallelize; the original spec undersold this).

### 5. Producers (round-1 conditional op, advance CAS, repair sweep, bridge, sweep create-or-re-arm) — NOT STARTED

Zero files touched. Full, final, ready-to-launch subagent prompt is at
`ai/m11-2-handoff/u5-lane-c-deliverable5-producers-prompt.md`. This is the highest-risk piece of the
whole lane (locks, CAS, the round-1 race, the rollout bridge) and the prompt is correspondingly the
most detailed — it gives EXACT SQL for every new statement, the EXACT diff for every changed call
site in `session-manager.ts`, and names every existing test file to search for characterization
pins before changing `activatePlaygroundSession`/`advanceToNextRound`/`checkDeadlines`.

**Key decisions already made and locked in that file:**
- `activatePlaygroundSession`'s signature loses its `roundDeadline` parameter (grep confirmed exactly
  ONE production call site: `session-manager.ts`'s `activateSession` — no route/tool calls it
  directly).
- New store function `storeRound1PromptIfMissing(sessionId, prompt, roundDurationMs, events?)` — the
  plan's exact conditional UPDATE, shared by the activation path AND the new repair sweep.
- `advanceToNextRound`'s call to `applyPlaygroundResolution` needs ONLY a 5th argument added (the
  event array) — **the store function itself needs ZERO changes**, since it already accepts and
  gates `events?` on the same CAS. This was a genuinely nice discovery that simplifies the highest-risk
  part of the whole lane down to a one-line call-site change.
- `completeSession`'s call is explicitly UNCHANGED (completion never opens a round) — the prompt
  requires a pin proving this stays true.
- New store function `listSessionsNeedingRound1PromptRepair(graceMs, limit)`, modeled directly on the
  existing `listSessionsDueForLifetimeCap` (oldest-first, bounded, predicate-in-query).
- Three new steps inside `checkDeadlines()` (session-manager.ts): round-1 repair, the reconstruction
  bridge (uses `store.emitEvent` — the ONE place in this deliverable that uses the standalone,
  ungated form, since there's no mutation to gate a synthetic historical event on), and
  create-or-re-arm (calls `store.findRoundOpenedEventId`/`store.resolveWakeupDelivery`/
  `store.createOrReArmWakeup` — all from deliverable 3). Exact code for all three steps is in the
  prompt file, including a `ROUND1_PROMPT_REPAIR_GRACE_MS = 2 * 60 * 1000` constant.
- Deliberately does NOT change `PlaygroundDeadlineRunResult`'s shape (KISS — the new steps just
  `console.log`/`console.error`, matching every existing step in that function).
- **Depends on deliverable 3 being real and stable** (calls three of its exports from the sweep). Does
  NOT depend on deliverable 4.
- Explicitly tells the subagent NOT to build the full two-connection race harness (round-1 prompt
  race, advance-vs-completion, submit-vs-deadline) — that is deliverable 6's job; deliverable 5 only
  needs ONE clean positive-path integration test proving the CAS carries the event correctly, plus the
  characterization pins for the three changed writers.

## 6. Cross-cutting race/e2e tests — NOT STARTED, NOT YET SPECCED

This is the piece I had not gotten to writing a subagent prompt for yet (I was designing it, having
just finished 4 and 5's prompts, when the first rotation instruction interrupted me — then I spent the
interim verifying deliverable 3's disk state per the orchestrator's redirect, and now this second
rotation instruction has stopped me before I could draft deliverable 6's spec at all).

**What it needs to cover** (from the original lane spec, `ai/m11-2-handoff/u5-lane-c-wakeups-spec.md`,
deliverable 6, minus items that don't apply to this codebase — mention-suppression is inapplicable per
the `agent.mentioned` non-existence noted above):
- Re-arm predicate tests — **already substantially covered by deliverable 3's own unit tests** (see
  above); confirm coverage rather than duplicating.
- `no-wakeup-before-prompt` — an e2e proving a promptless active round-1 session produces zero
  wakeups (needs deliverables 3+4+5 all present).
- `upgrade-bridge` — seed an active session with a stored prompt and NO `round_opened` event
  (simulating pre-a4 state); run the sweep; assert exactly ONE synthetic event
  (`idem_key: playground_round_opened:{session}:{round}`, `payload.reconstructed: true`), no forfeit,
  and wakeups get created from it on the same or a subsequent pass.
- `late-recovery` — a round-1 prompt repaired well after normal generation time still gets a FRESH
  deadline (now + ACTION_TIMEOUT_MS), not a deadline computed from any earlier "phantom" schedule —
  zero forfeits.
- `stale-round-event` — a round-N `round_opened` event drained (by the router) after the session has
  already advanced to round N+1 produces NO wakeup (receipt only). Partially exercisable at the unit
  level (deliverable 4's own tests should already cover the router's stale-check in isolation); this
  item wants the INTEGRATION version with a genuinely advanced session.
- `early-actor` — one participant submits before the round's `round_opened` event drains; only the
  REMAINING participants get wakeups/notifications when it does drain.
- **`round-1 prompt race`** — the actual two-connection race: the activation path's async write racing
  the sweep's repair for the SAME session's round-1 prompt. Model this exactly on
  `src/__tests__/integration/m11-2-u3f-core-classes.test.ts`'s "the enroll cap holds under a genuine
  two-connection race" test (hold the `playground_sessions` row `FOR UPDATE` on a raw `pg` client via
  `pgClient()`/`raceAgainstHeldLock`/`runConcurrently` from `src/__tests__/integration/helpers/concurrency.ts`,
  release, assert exactly one stored prompt / one `round_opened` event / one wakeup per participant —
  the loser's conditional UPDATE returns zero rows). This is the single highest-value test in the
  whole lane; do not skip or shortcut it.
- **`submit-vs-deadline` advance race** (rounds ≥ 2) — a submit completing the round (via
  `tryAdvanceRound`'s `safeWaitUntil`) racing the deadline sweep's own `tryAdvanceRound` call for the
  SAME session/round: exactly one transition, one event.
- **`advance-vs-completion` race** — a stale round-N completion (the CAS's terminal branch) racing a
  session that a concurrent racer already advanced to round N+1: the stale completion CAS matches zero
  rows, writes nothing, emits nothing (the round predicate in `applyPlaygroundResolution`'s WHERE
  clause is what closes this — already exists, unmodified by deliverable 5; this test is pure
  verification, not a new mechanism).
- **`memory-mode round-opening`** — in memory mode (no DB), the deadline sweep's `round_opened` (via
  the repair path or the bridge) produces BOTH the notification and the wakeup with no cron/worker,
  visible synchronously when the emitting store call resolves (Decision 6's `await` delivery mode,
  already wired into both the router and notifications consumers by deliverable 4). This is a UNIT
  test (memory mode), not an integration one.

**Do not write deliverable 6's subagent prompt from scratch again** — reconstruct it using the
"Test requirements" sections already embedded in the deliverable 3/4/5 prompt files as a base for
style/idiom (RUN-suffixed fixtures, `raceAgainstHeldLock`, orphan-neutralizing `beforeAll`), and the
list immediately above for exact scenario coverage. This deliverable's subagent prompt still needs to
be WRITTEN by whoever picks this up next — treat everything above as the design brief, not a
copy-pasteable spec.

## Gate status — what has actually been run and confirmed, vs. not

- **Deliverable 1+2's subagent reported**: `npx tsc --noEmit` clean, `npm run lint` 0 errors, full
  unit suite green (169 suites / 1589 tests) — but this was BEFORE the FK fix (which only touched a
  `.sql` file and re-ran `db:migrate`, so it should not have invalidated that result) and BEFORE
  deliverable 3 existed. **Re-run before trusting it as current.**
- **The FK fix** (`scripts/migrate-m11-wakeups.sql` edit + `db:migrate` re-run): verified directly by
  me via a `pg_constraint` query, not just trusted. Confirmed correct.
- **Deliverable 3**: NO gate has been run and confirmed by anyone against the current combined state
  (db.ts + memory.ts + index.ts + `_memory-state.ts` + `store.ts` + the partial test file). This is
  the single most important thing for the next manager to do first:
  ```
  npx tsc --noEmit
  npm run lint
  npm test -- --runInBand src/__tests__/lib/store/wakeups
  ```
  If `tsc` is not clean, the most likely culprits are: the `wakeupQueue` state shape not matching what
  `memory.ts` expects (I read both and they matched as of my last check, but the memory.ts file was
  still being edited afterward), or a stale import somewhere. Diagnose from the actual compiler error,
  don't guess.
- **Deliverables 4, 5, 6**: not started, nothing to gate.
- **No integration suite has been run this session by anyone**, and no `npm run build` has been run
  (correctly, per the hard rules — do not run it).

## Working rules, restated (do not relax these)

- No git commands (orchestrator owns git). No codex. No full `npm run test:integration` with no args.
  No `npm run build`. Targeted integration runs are fine; if one waits on the reserved-DB advisory
  lock, WAIT, never kill the holder (another lane may hold it).
- RUN-suffix every fixture value under a UNIQUE column in every new integration test. Neutralize
  `idx_pg_sessions_one_live_per_school` orphans in `beforeAll` for ANY suite that touches
  `playground_sessions` (deliverables 4, 5, 6 all will) — copy the exact idiom from
  `src/__tests__/integration/m11-2-u3d-playground.test.ts`'s `beforeAll`.
- Characterization FIRST for every existing writer a subagent changes (this is baked into deliverable
  5's prompt already).
- Mutation-check every race/atomicity fix: suppress, watch the test fail, restore, report the
  evidence explicitly — do not accept a subagent's bare claim that it did this without seeing the
  before/after.
- Fences: do not touch `src/lib/agent-loop.ts` / `agent-home/**` / `agent-opportunities.ts` (Lane B),
  `.eslintrc.json` / `package.json` / boundary files (Lane A), `agents.md`/`CLAUDE.md`,
  `ai/validation/m11-inventory.md` (record deltas for the orchestrator to fold, don't edit it
  yourself), any evaluations/classes/admissions module. The two additive fence extensions already
  made/planned (deliverable 3's `_memory-state.ts` type import, deliverable 4's `store-types.ts` +
  `store/notifications/*`) are the ONLY sanctioned extensions beyond the original list — do not invent
  further ones without the same level of justification (structurally required, additive-only,
  documented).
- Context discipline: stop and write a handoff at ~60% of YOUR OWN context budget (not this session's
  — a fresh manager gets a fresh budget). Never resume a subagent past ~50-60% of ITS budget; spawn
  fresh with a handoff instead, the way this file exists for exactly that reason.

## Final report format expected of you, at the end of this lane

Per the original brief: files; migration output; gate outputs (unit + targeted integration counts);
per-item mutation-check evidence; the two-deploy rollout note (deploy 1 = tables + kind + manifests +
router code, deploy 2 = the producers — this maps directly onto how the work has been sequenced:
deliverables 1-2-3-4 are all "deploy 1" content, deliverable 5 is "deploy 2" content, which is a nice
confirmation the sequencing has been right); every behavior change to an existing writer with its
re-anchored test; the deferred list (claim/runner P3.3, the worker, the idle scheduler, budget
spending, cron adoption — none of it touched, correctly).
