# Implementation task — u3e fix round 1 (evaluations + agent-lifecycle slice; KARMA-BEARING)

Repo: /Users/mohsin/Github/safemolt. Uncommitted tree on `ops/code-improve` — do NOT commit, do NOT run any git write command. You are the implementation agent; a separate reviewer converges your work later.

u3e (the P1.4 evaluations + agent-lifecycle slice) is implemented; a fresh codex review found 2 BLOCKER + 4 MAJOR + 1 MINOR. Fix ALL of them. Findings text: `ai/m11-2-handoff/codex-findings-u3e-round1.md`.

## Task 0 — harness hardening (do this FIRST, it is small)
A stale `system.activation_fence` event left by an interrupted run makes `activateEventConsumer` a silent no-op, so a suite drains nothing and reports "no receipt" as a harness artifact. `src/__tests__/integration/m11-2-u3d-playground.test.ts` (its shadow-parity `beforeAll`, around line 720) already hardened itself: delete the real consumers' `event_consumers` rows, delete their fence events, then activate and `expect(activated).toBe(true)`. Three suites activate WITHOUT that hardening and failed exactly this way in the last full run: `m11-2-u3-posts.test.ts` (~line 784), `m11-2-u3b-social.test.ts` (~line 1213), `m11-2-u4prep-soak-report.test.ts` (~line 326). Extract the u3d pattern into one shared helper (put it beside the other integration helpers) and use it in all FOUR suites. Behavior-neutral refactor of test setup only — no production code. The original binding spec is `ai/m11-2-handoff/u3e-spec.md` — its non-negotiables still bind you. Before editing ANYTHING, read agents.md (= CLAUDE.md): the ENTIRE karma block, the D4 completion-atomicity rules, the prepared-events invariants, and the memory-preflight rules.

## Hard constraints (violating any of these fails the round)
- The completion batch's lock order (`agents FOR UPDATE` first, D4/C14 alignment) is untouched.
- `buildAgentPointsRecompute` stays the ONE prepared statement; `toAwardedPoints` stays where it is.
- `src/__tests__/lib/karma-writer-ownership.test.ts` must not gain or lose a writer.
- `src/__tests__/integration/m11-1c-karma-components.test.ts` untouched and green.
- No house-points write appears anywhere.
- Statement.ts vocabulary only; positional primary-event substitution; memory preflight order (validate → eligibility → refusal → uniqueness → synchronous claim/mutate/append).
- Finding 1's fix must put the certification job transition INSIDE the D4 completion transaction, token-fenced, with every completion effect gated on the winning transition — do not invent a second completion path.
- Finding 3's fix must gate the vetted flip, both bootstrap statements, the recompute, ALL events and the challenge consumption on ONE locked unvetted decision, in BOTH stores.
- Finding 5's memory re-checks are parity with what PostgreSQL refuses, decided per path — never a blanket check (see the groups-domain precedent in agents.md).

## Method
Mutation-check every behavioral fix: write the failing test FIRST, watch it fail against the unfixed code, then fix, then confirm green (revert fix → test fails → restore). For finding 6, the fix IS the tests: real route + real tool concurrently, constraint/trigger-based failure injection after the decisive writes for registration, claim, proctor completion, PoAW completion, certification completion and vetting, asserting full rollback of state AND events. Match surrounding code style. No bloat.

## Fences
Your surface: src/lib/actions/{evaluations,agents,types}.ts; src/lib/evaluations/{judge.ts,executors/poaw.ts,types.ts}; src/lib/store/evaluations/{db,memory}.ts; src/lib/store/agents/{db,index,memory}.ts; the evaluation routes (src/app/api/v1/evaluations/**), the agent-lifecycle routes (src/app/api/v1/agents/{register,claim,verify,vetting/*}), src/lib/agent-tools/definitions/{agents,evaluations}.ts; the u3e test files + src/__tests__/lib/actions/evaluations.test.ts + withdrawal-cascade-memory.test.ts; events/kinds.ts + consumers/coverage.ts ONLY if a kind entry must change; ai/validation/m11-inventory.md §3b rows; agents.md ONLY to record a new invariant your fix establishes.
For Task 0 only, you may also edit the `beforeAll` activation blocks of src/__tests__/integration/{m11-2-u3-posts,m11-2-u3b-social,m11-2-u4prep-soak-report,m11-2-u3d-playground}.test.ts plus one new shared test helper file — nothing else in those suites.
Do NOT edit: src/lib/events/consumers/legacy-compare.ts, consumers/{notifications,activity-trail,memory-ingest}.ts, scripts/soak-shadow-report.sql, any playground file, dispatch.ts, statement.ts, any karma-writer file outside the fenced list.

## Gates
npx tsc --noEmit && npm run lint && npm test -- --runInBand && npm run test:integration && npm run build. The integration suite serializes on a Postgres advisory lock — another run may hold it; wait, do not kill. The known flake is `c13a` — re-run before concluding a failure is real. The Neon DB has intermittently reset connections — probe and retry before diagnosing failures as real. Piped shell commands report the pipe tail's exit code — read jest's own summary lines.

## Report
Per finding: what you changed (files), the mutation-check evidence (test name, failed-then-passed), deviations from the prescribed minimal fix with the reason. Then the gate results verbatim (suite/test counts).
