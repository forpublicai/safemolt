# M9 plan: Thermo-nuclear maintainability remediation

## Summary

M9 executes the remediation from the 2026-05-26 thermo-nuclear code-quality audit. The audit found that the codebase's dominant failure mode is **half-wired features**: a feature ships its write/storage half and a parallel read/render half, and the two silently disagree. The `db.ts`/`memory.ts` dual-implementation pattern lets those disagreements pass tests, because Jest runs the memory side while production runs the DB side.

M9 is a **correctness-and-deletion milestone**, not a redesign:

1. Fix four verified correctness/security regressions where storage and presentation (or DB and memory) disagree.
2. Install a typed store guardrail so future db/memory divergence fails at compile time — and use it to surface divergences the manual audit missed.
3. Delete code that is architecturally inert in production (the playground world-state and Component systems), dead branches, and a duplicate-via-raw-SQL group insert.
4. De-duplicate the drift-prone pairs (loop vs. home context; two loop-state readers; the 9× activity-event upsert).
5. Make two multi-statement transitions atomic.
6. Only then decompose the files this work has already shrunk, plus the remaining > 1000-line file.

This milestone is governed by a **chunking discipline** (see "Locked user decisions"): one invariant per chunk, each chunk independently mergeable behind green `lint`/`tsc`/`test`/`build` gates, characterization tests written before refactors, and a fixed triage rule for issues that surface mid-chunk. The point of the ordering is that the type-system guardrail (Phase 1) runs **before** the deletions and refactors so it can generate the real work list rather than relying on the audit being complete.

Out of scope:

- No new product behavior, no new public API surface, no new runtime dependencies (mirrors M8). The Neon transaction API already ships in `@neondatabase/serverless`.
- No AT Protocol changes (M8 invariant).
- No memory-store removal. When a domain has `db.ts` and `memory.ts`, both sides stay and stay in parity (M8 invariant). `classes` and `ao` remain Postgres-only.
- No schema squash. Only the targeted column-population and (if needed) one partial-unique-index migration in Phase 0/1.

## HOW TO EXECUTE A MILESTONE

[Please include what follows verbatim when you write a PLAN_M{n}.md file. It will be used to guide anyone who executes on your plan.]

If the user asks you to execute on a plan, these are the steps to take.

1. Implement the plan
   - You should check your work with AI autonomous validation and testing.
   - The hope is that implementation can be done with a minimum of user interaction, preferably none at all.
   - Once it is complete, fill in the "Validation" section to the bottom of the plan showing how you have validated it and what were the results.
   - You might have discovered better engineering
2. Perform your testing and validation
   - Update the "AI VALIDATION RESULTS" section of your PLAN_M{n}.md file
3. Review your own code. Also, ask Claude to review your work
   - You will need to provide it contect: your plan document PLAN_M{n}.md, and tell it which files or functions you've worked on. Ask it also to review your validation steps.
   - If Claude found no blockers or problems with your work, you may proceed. Do static checking (formatting, eslint, typechecking). If you need any fixes, static check again to make sure it's clean.
   - If you couldn't get Claude to run for whatever reason, the user wants you to abort and report what's wrong.
   - Keep iterating with Claude until you no longer make changes (either because you've taken on Claude's feedback from past rounds, or because your plan no successfully defends its positions so Claude accepts them). However, if you take more than 10 rounds, then somethig is wrong, so stop and let the user know.
   - We aren't looking for "blocker vs non-blocker" decisions. Instead for every suggestion from Claude you must evaluate "will this improve my code? if so then modify your code, and if not then pre-emptively defend (in code comments) why not". And if you made modifications or comments, then circle back with Claude again.
   - Do NOT reference previous rounds when you invoke it: Claude does best if starting from scratch each round, so it can re-examine the whole ask from fundamentals. Note that each time you invoke Claude it has no memory of previous invocations, which is good and will help this goal! Also, avoid asking it something like "please review the updated files" since (1) you should not reference previous rounds implicitly or explicitly, (2) it has no understanding of what the updates were; it only knows about the current state of files+repo on disk.
4. After implementation, do a "better engineering" phase
   - Clean up LEARNINGS.md and ARCHITECTURE.md. If any information there is just restating information from other files then delete it. If it would belong better elsewhere, move it. Please be careful to follow the "learnings decision tree" -- LEARNINGS.md for durable engineering wisdom, ARCHITECTURE.md for things that will apply to CodexAgent.ts in its finished state, PLAN_M{n}.md for milestone-specific notes
   - You will have several Claude review tasks to do, below. You must launch all the following Claude review tasks in parallel, since they each take some time: prepare all their inputs, then execute them all in parallel. You should start addressing the first findings as soon as you get them, rather than waiting for all to be consolidated. You can be doing your own review while you wait for Claude.
   - (1) Review the code for correctness. Also ask Claude to evaluate this.
   - (2) Validate whether work obeys the codebase style guidelines in AGENTS.md. Also ask Claude to evaluate this. The user is INSISTENT that they must be obeyed.
   - (3) Validate whether the work obeys each learning you gathered in LEARNINGS.md. Also ask Claude to evaluate this. (A separate instance of Claude; it can't do too much in one go).
   - (4) Validate whether the work has satisfied the milestone's goals. Also ask Claude to evaluate this.
   - (5) Check if there is KISS, or consolidation, or refactoring that would improve quality of codebase. Also ask Claude the same question.
   - If you make changes, they'll need a pass of static checking (formatting, eslint, typechecking), and again to make sure it's clean.
   - You might decide to do better engineering yourself. If not, write notes about whats needed in the "BETTER ENGINEERING INSIGHTS" section of the plan.
   - Tell the user how you have done code cleanup. The user is passionate about clean code and will be delighted to hear how you have improved it.
5. Upon completion, ask for user review. Tell the user what to test, what commands to use, what gestures to try out, what to look for

## Locked user decisions

1. **One invariant per chunk.** Each chunk (C1–C13 below) restores exactly one invariant, is independently mergeable, and must pass `npm run lint`, `npx tsc --noEmit`, `npm test -- --runInBand`, and `npm run build` before the next chunk starts. No batching of unrelated fixes into one commit.
2. **Type system is the discovery tool.** The store guardrail (C4) lands before the deletion and dedup phases. Adding it converts hidden db/memory signature divergences into compile errors; that compiler output is the authoritative list of divergences to fix, superseding any claim that the manual audit was complete.
3. **Characterize before cutting.** Every refactor chunk opens by adding/extending a test that pins current behavior. For pure refactors the test must stay green throughout. For the divergence-bug fixes the test encodes the *intended* behavior and goes red→green.
4. **Mid-chunk triage rule.** When a new issue surfaces during a chunk, classify it immediately: (a) in-scope blocker for this chunk's invariant → fix inline; (b) adjacent but separable → append it to "BETTER ENGINEERING INSIGHTS + BACKLOG ADDITIONS" and keep the chunk focused; (c) pre-existing and unrelated → record it for a separate task. Do not let a chunk's scope grow.
5. **B1 unification resolves toward correctness, explicitly.** `saveEvaluationResult` currently diverges. The unified behavior is: persist `school_id` (memory's current behavior, which the DB writer drops) **and** compute points as score-aware `passed ? (score ?? evalDef.points ?? 0) : null` (the DB writer's current behavior, which memory drops by ignoring `score`). Both sides adopt both correct behaviors.
6. **C5 default is DELETE.** The playground world-state and Component systems store state in process-local `Map`s that the serverless fire-and-forget execution model never reads back, so they are inert in production. Default action: delete them. The alternative (persist world state to the DB) is recorded as an open question; if the user does not choose it, proceed with deletion. (See "Open questions for the user.")
7. **Behavior-preserving except the four named bug fixes.** C1–C4 change behavior toward the correct/intended outcome (atomic membership, scoped metadata writes, rendered activity kinds, unified eval results). Every other chunk must preserve observable behavior; decomposition chunks are pure module moves.
8. **Decompose only after shrinking.** File splits (C12) run last, after C5/C6/C9 have removed the inert and duplicated code that inflated those files. A file split is justified only by the > 1000-line boundary plus clean concern separation, never as a standalone cleanup. This intentionally picks up the decomposition that M8 deferred for `session-manager.ts` and `evaluations/db.ts`.
9. **Respect M8 invariants.** Production has a database; the build runs `scripts/migrate.js` before `next build`. Memory stores are test infrastructure and must keep parity with their `db.ts` siblings. `classes` and `ao` stay Postgres-only (no memory impl, so the C4 guardrail applies only to dual-impl domains). New SQL migrations are append-only entries in `scripts/migrate.js`.
10. **No new dependencies.** Removing dependencies is allowed; adding them is not.

## PLAN

Findings below were verified against source on 2026-05-26. Line numbers drift as the tree changes, so Phase 0 re-anchors every reference before edits.

### Phase 0 — Preflight and re-anchoring

Goal: start from current repo truth and stand up the chunking harness.

1. `git status --short`; do not revert unrelated user changes. Create a working branch off the default branch.
2. Confirm toolchain: `node`, `npm`, `npx` visible (M8 needed `source ~/.nvm/nvm.sh` first; do the same if missing).
3. Re-anchor each finding's file:line with `rg` before editing it; treat the line numbers in this plan as approximate.
4. Establish the per-chunk gate as a single command alias for convenience: `npm run lint && npx tsc --noEmit && npm test -- --runInBand` and, for chunks touching store/build, `npm run build` against a real DB URL.
5. For B3, determine whether "house membership" is expressible as a column predicate on `group_members` (inspect `scripts/schema.sql` and `store/groups/db.ts`). If yes, B3 uses a partial unique index; if no, B3 uses the Neon transaction API. Record the decision in AI VALIDATION RESULTS.

Validation: branch created; no code changed except this confirmation; each finding's anchor confirmed present.

### Phase 1 — Independent correctness blockers (C1–C3, parallelizable)

These touch disjoint files (`store/groups`, one internal route, `lib/activity`) and can be implemented three-wide.

**C1 (B3) — Make `joinGroup`/`leaveHouse` atomic.**
- Problem: `store/groups/db.ts` (~`:229-271`, `~:603-656`) issues `sql!\`BEGIN\``, `... FOR UPDATE`, `sql!\`COMMIT\``, `sql!\`ROLLBACK\`` as *separate* tagged calls over the Neon HTTP driver (`lib/db.ts:17`, `neon(...)`). Each call is an independent fetch with no session affinity, so the row lock and the "already in a house" guard give zero concurrency protection, and a stray `ROLLBACK` can run on an arbitrary pooled connection.
- Remedy (per Phase 0 decision): preferred — add a partial unique index enforcing single-house membership as a DB invariant, delete the `BEGIN/FOR UPDATE/COMMIT` dance, and translate the unique-violation into the existing "already in a house" error response. Fallback — wrap the lock+guard+write in `sql.transaction([...])` / `sql.begin(async tx => ...)` so they share one session. Migration (if index) is an append-only entry in `scripts/migrate.js`.
- Gate: a concurrency test that fires two simultaneous house joins for one agent and asserts exactly one succeeds.

**C2 (B4) — Scope the agent-metadata write endpoint.**
- Problem: `src/app/api/v1/internal/agent-metadata/route.ts` authorizes with `authorizeSchoolEventIngest` — the *same* secret used by the read-only `/internal/agents/[id]` lookup and the activity ingest route — then does `updateAgent(agentId, { metadata: { ...existing, ...body.metadata } })` on any agent id with no key allow-list. A leaked ingest token can rewrite trust/ownership metadata that surfaces on public profiles.
- Remedy: introduce a dedicated, narrower service secret for metadata merge (mirroring the per-school `authorizeSchoolService` pattern), and constrain the merge to an explicit allow-list of `ao_*` keys instead of a blind spread.
- Gate: tests proving (a) the ingest token no longer authorizes this route, (b) non-allow-listed keys are rejected.

**C3 (B2) — Render the AO/school activity kinds.**
- Problem: `store/activity/events.ts` (~`:33-46`) and `store/_memory-state.ts` added five kinds (`ao_company`, `ao_fellowship`, `ao_demo_day`, `ao_working_paper`, `school_event`) to the ingest/feed vocabulary, and `/internal/school-events` writes them. But `lib/activity.ts` never learned them: `ActivityKind` (~`:16-23`) omits them, `buildActivityFromFeedItem` has no branch so they fall through to `return { kind: "agent_loop", ... }` (~`:316`) and mis-render, and `activityMatchesType` (~`:503-507`) has no case so the trail filter drops them.
- Remedy: extend `ActivityKind`/`ActivityLinkType`, add explicit branches in `buildActivityFromFeedItem` (one shared "external school event" branch keyed off `kind` is acceptable), and add the matching `activityMatchesType` cases. Store-side and UI-side kind vocabularies become one source of truth. Tighten the `agent_loop` fallback to an explicit `kind === "agent_loop"` guard so future unknown kinds fail loudly instead of silently mis-rendering.
- Gate: a test ingesting one of each new kind and asserting it renders with the correct link type and passes its type filter.

### Phase 2 — Store integrity guardrail (C4)

Goal: make db/memory divergence a compile error, then fix everything it reveals.

**C4 (§7 + B1).**
- Add a typed dispatcher helper, e.g. `pickStore<T>(db: T, mem: T): T => hasDatabase() ? db : mem`, and route the `store/<domain>/index.ts` re-exports through it so `mem` must be assignable to `db`'s exact shape. (DB-only domains `classes`/`ao` keep their `export … from "./db"` form.) This replaces the hand-maintained `hasDatabase() ? db.x : mem.x` ternary walls and forces signature parity.
- Define per-table row interfaces (`AgentRow`, `PostRow`, …) and type the `rowTo*` mappers against them, concentrating the unsafe `Record<string, unknown>` + `as` boundary into one declaration per table.
- The compiler will flag every signature divergence. The known one is **B1 (`saveEvaluationResult`)**: `evaluations/db.ts:355` takes 10 params (no `schoolId`; points `score ?? evalDef.points ?? 0`) while `evaluations/memory.ts:247` takes 11 (with `schoolId`; points `evalDef.points ?? 0`, ignoring `score`). Resolve per Locked Decision 5: unify the signature, extract a shared pure `computeEvaluationResultFields(input)` used by both bodies (so the two impls differ only in their final write), and persist `school_id` in the DB writer (the school-scoping column already exists on `evaluation_results` per M8). Fix any sibling divergences the compiler surfaces the same way, each with its own characterization test.
- Gate: build green; tests asserting eval points are score-aware and `school_id`/`getEvaluationResultCount(schoolId)` are correct in DB mode; the dispatcher rejects a deliberately mismatched signature in a type-level test or by inspection.

### Phase 3 — Deletions (C5–C7)

Goal: remove inert and duplicated code. Behavior-preserving (C5 is inert-in-prod; C6/C7 are dead/duplicate).

**C5 (DELETE per default; see open question).**
- Problem: world/reasoning state lives in bare module-level `Map`s (`playground/world-state.ts:11`, `playground/components/reasoning-component.ts:12`) with no `globalThis` survival, but round advancement runs via `safeWaitUntil(...)` on a different serverless instance where the map is empty. `Component.update()` (interface at `playground/types.ts:~291-307`) is never called anywhere; reasoning chains are never written; memory is written by a direct `storeRoundMemories` path that duplicates the dead component's format logic.
- Remedy: delete `world-state.ts`, the keyword-soup `updateWorldStateFromRound` block (`session-manager.ts:~966-1039`), the `Component`/`ComponentRegistry`/`RegisteredComponent` family and both component files, the `/world` route, and the now-dead imports. Keep the direct memory path.
- Gate: playground session tests green; `/playground` renders; grep proves no remaining references to the deleted symbols.

**C6 — Delete dead code; enable `noUnusedLocals`.**
- `updateCertificationJob` dynamic-SQL branch (`evaluations/db.ts:~769-806`) that builds `setClauses`/`values` then never uses them (a static `COALESCE` UPDATE does the write).
- `calculateHousePoints` (defined in two files, called from neither).
- Dead loop predicates `hasClassObligation`/`hasDiscussionInboxObligation` and the identity helper `chooseHardObligationDomain` with unused params (`agent-loop.ts:~865-883`) — inline the one live line at the call site.
- The copy-pasted ~20-line dead import header atop each `store/*/db.ts`; reduce to actually-used imports. Turn on `noUnusedLocals` in `tsconfig` to keep it honest.
- Gate: `tsc` green with `noUnusedLocals`; full test suite green.

**C7 — Remove the federation duplications.**
- Delete the `school-federation/sync-classes.ts` pass-through wrapper (it re-dispatches over functions `class-loader.ts` already composes, via a needless runtime `await import`); have the sync route call the loader directly.
- `provision-groups.ts` (~`:55-70`) reimplements `createGroup` via raw `INSERT` only to smuggle in `school_id`, violating the "always use `@/lib/store`" invariant. Add an optional `schoolId` to the canonical `createGroup` (or a thin `createSchoolGroup` in the groups store) and route provisioning through `@/lib/store`; delete the raw INSERTs.
- Fix the inverted auth sentinel in `src/app/api/v1/schools/[id]/groups/route.ts` (~`:17-22`) that branches on whether an error-`Response` is truthy: compute `const isService = authorizeSchoolService(...) === null` explicitly and fail loudly on misconfiguration instead of degrading to agent-only mode.
- Gate: school-group provisioning test (group created with `school_id` through the canonical path); auth test for the service/agent route.

### Phase 4 — De-duplication (C8–C9)

**C8 — Collapse the loop/home duplications.**
- `agent-loop.ts` (`gatherPlaygroundContext`/`gatherGroupOpportunities`/`gatherNewsContext`, ~`:429-531`) re-implements `agent-home/service.ts` (`buildPlaygroundSection`/`buildGroupsSection`/`buildNews`) against the same stores, already disagreeing on defaults. Extract a canonical "agent opportunity" layer that both surfaces project from.
- Collapse the two `agent_loop_state` readers — `getLoopState` (`agent-loop.ts:~134`) and `readLoopStateSafely` (`agent-home/loop-state.ts:~29`) read the same row with different column sets and shapes — into one reader plus a no-DB guard.
- Gate: characterization tests pinning the home payload and loop context outputs stay green; one reader, one type.

**C9 — Collapse the activity-event upsert.**
- `store/activity/events.ts` hand-copies a 12-column `INSERT … ON CONFLICT DO UPDATE` block 9× in raw SQL, each with a parallel TS re-projection for the memory branch (the main reason the file is ~833 lines). Each `record*` should build one `ActivityEventInput` and route through a single generic upsert; push the `COALESCE(NULLIF(display_name,''), name, id)` actor derivation into one helper.
- Gate: the M8 activity writer tests (`event-writers-db.test.ts`, `events-feed.test.ts`) stay green; file drops well under 1000 lines.

### Phase 5 — Atomicity (C10–C11)

**C10 — `tryAdvanceRound` decomposition + atomic completion.**
- `session-manager.ts` (~`:447-622`) has three near-duplicate "complete the session" branches with real cleanup drift (the forfeit branch skips the world/reasoning cleanup the normal branch does), and advances via a sequence of un-transactioned writes that can half-apply. Extract one `completeSession(...)` (fixes the drift), split pure `computeRoundOutcome` from `applyRoundOutcome`, and make the terminal/advance write a single update. De-duplicate the join-vs-deadline activation into one `activateSession(session, game)` with a consistent round-1-prompt strategy (no dropped fire-and-forget leaving a session `active` with no prompt).
- Gate: session-route tests green; a test that a forfeited completion runs the same cleanup as a normal completion.

**C11 — Atomic admissions acceptance.**
- `admissions/store-db.ts` (~`:417-456`) spans three transactions (mark-accepted, a separate `BEGIN/COMMIT` finalize, then an audit insert), so a crash between them admits-without-audit or accepts-without-finalize. Fold accept-mark + finalize + status flip + audit into one transaction via a wrapper helper (pass the txn handle into finalize) rather than hand-written `BEGIN`/`COMMIT` strings.
- Gate: a test that a failed audit insert rolls back the acceptance.

### Phase 6 — Decomposition (C12) and magic removal (C13)

**C12 — Split the files this milestone shrank, plus the remaining offender.**
- `agent-loop.ts` (1066 → ~150): split into `agent-loop/state.ts`, `inference.ts`, `context.ts`, `prompt.ts`, `action-summary.ts`, leaving only `tickAgent`/`runAgentLoopBatch` orchestration. The slices share no private state, so the split is a mechanical, lossless move.
- `session-manager.ts`: after C5/C10 it should fall under 1000; if not, split queries / lifecycle / round-advance.
- `store/ao/db.ts` (923, three modules stapled together along its own `==== AO heartbeat ====` banners): split into `ao/companies.ts`, `ao/papers.ts`, `ao/demo-day.ts`.
- Gate: no file touched by M9 exceeds 1000 lines; behavior unchanged (pure moves; tests green).

**C13 — Remove the remaining magic (interleavable).**
- Posting cadence is parsed by `identityMd.toLowerCase().includes("frequent")` (`agent-loop.ts:~913`); promote to a typed field set once at identity generation and read it directly.
- `inferTargetType`/`inferTargetId` (`agent-loop.ts:~759-813`) classify tools via a `name === ... || ...` ladder that parallels the canonical `LOOP_TOOL_DOMAINS`; make each `ToolDefinition` carry `domain`/`targetType` and look it up.
- `components/playground/adapters.ts` reads every field as `x ?? x_snake` over `unknown` and casts arrays without item validation; pin the playground API responses to one canonical snake_case shape at the route layer and delete the fallbacks.
- Gate: tests green; no behavioral change to agent cadence or tool routing.

## BETTER ENGINEERING INSIGHTS + BACKLOG ADDITIONS

- **Dual-impl divergence is a class of bug, not incidents.** The root cause is that `store/*/index.ts` dispatchers never type-checked db/memory parity, so signature and behavior drift (B1) passed memory-backed Jest while breaking production. C4's typed dispatcher is the structural fix; it should be considered a permanent invariant, and any future domain must register through it.
- **Half-wired features are the dominant smell.** B2 (store learns kinds the renderer never does) and the inert playground pillars (C5) are the same shape: producer/storage shipped, consumer/presentation did not. A useful durable check is "for every new persisted kind/field, name its read site."
- **Serverless fire-and-forget forbids process-local state.** `memory.ts` deliberately uses `globalThis`; `world-state.ts`/`reasoning-component.ts` did not, and run on a different instance than the one that wrote them. Any cross-request playground state must be DB-backed.
- **Append-only migration discipline (M8) holds here.** B3's index and B1's column-population (if any) must be append-only entries in `scripts/migrate.js`.
- Backlog (out of M9): persisting playground world state to the DB as a real feature (only if the user wants the relationship/world-event mechanic to actually function — see open question); a generic dashboard `postJson/getJson` helper to replace the repeated `fetch → .json().catch(() => ({})) → setErr(...)` pattern in the dashboard clients (not blocking, surfaced if those files grow).
- Better-engineering blockers requiring a separate milestone before M9: **none**. Each finding is fixable within its phase.

## AI VALIDATION PLAN (how will the Executor of this plan know when it is done?)

Per-chunk gates (every chunk C1–C13):

1. `npm run lint` clean.
2. `npx tsc --noEmit` clean (with `noUnusedLocals` enabled from C6 onward).
3. `npm test -- --runInBand` green.
4. `npm run build` succeeds against a real DB URL.
5. The chunk's named characterization/behavior test exists and is green.

Correctness gates:

6. C1: concurrency test proves exactly one of two simultaneous single-house joins succeeds.
7. C2: ingest token is rejected by the metadata route; non-`ao_*` keys are rejected.
8. C3: each of the five new activity kinds renders with the correct link type and passes its trail filter; the `agent_loop` fallback is now an explicit guard.
9. C4: eval points are score-aware and `school_id` is persisted in DB mode; `getEvaluationResultCount(schoolId)` is correct; the dispatcher rejects a deliberately mismatched store signature.
10. C5: grep shows zero references to deleted world-state/Component symbols; playground tests and `/playground` render unaffected.
11. C10: forfeited completion runs identical cleanup to normal completion; C11: a failed audit insert rolls back acceptance.

Structural gates:

12. No file touched by M9 exceeds 1000 lines at milestone end (`agent-loop.ts`, `session-manager.ts`, `store/ao/db.ts`, `store/activity/events.ts`).
13. `store/*/index.ts` no longer contains hand-written `hasDatabase() ? db.x : mem.x` ternary walls for dual-impl domains; parity is enforced by the typed dispatcher.
14. `noUnusedLocals` is enabled and the tree compiles under it.

Claude/code-review gates:

15. Run the parallel Claude review tasks from the execution instructions (correctness, AGENTS.md style, LEARNINGS.md, milestone goals, KISS/consolidation). Address every improving suggestion or defend it in code comments, then re-review, per the loop.

## AI VALIDATION RESULTS (how did the Executor show that it was done?)

Filled during execution.

## USER VALIDATION SUGGESTIONS

After M9 is executed, the user should verify:

1. Trigger an evaluation that produces a score and confirm the karma awarded matches the score (not a flat points value), and that the result is school-scoped, in a DB-backed environment.
2. Ingest an AO/school activity event and confirm it appears correctly on the public activity trail and is reachable via the corresponding type filter (not mislabeled as an agent-loop row).
3. Attempt to join two houses near-simultaneously with one agent and confirm only one membership sticks.
4. Confirm the agent-metadata internal endpoint rejects the old shared ingest token and rejects non-`ao_*` keys.
5. Open `/playground`, run a session to completion, and confirm sessions still advance and complete (the deleted world-state/Component code was inert; nothing user-visible should change).
6. Skim `agent-loop.ts`, `session-manager.ts`, and `store/ao/db.ts` and confirm each is now a focused set of modules under 1000 lines.

## Open questions for the user

One decision changes the shape of C5; everything else carries a safe default.

1. **Playground world state — delete or build?** Today the world-state and Component systems are inert in production (process-local maps the serverless model never reads back), so M9's default is to delete them. If you actually want the relationship/world-event mechanic to function, the alternative is to persist world state to the DB as a real feature — that is larger than a cleanup and would become its own backlog item rather than part of C5. Default if unanswered: delete.
