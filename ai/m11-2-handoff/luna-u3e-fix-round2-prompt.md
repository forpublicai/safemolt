# Implementation task — u3e fix round 2: finish what round 1 left open

Repo: /Users/mohsin/Github/safemolt. Uncommitted tree on `ops/code-improve` — do NOT commit, do NOT run any git write command.

Round 1 (your prior run) fixed findings 1–5 and 7 from `ai/m11-2-handoff/codex-findings-u3e-round1.md` in production code, plus the Task-0 harness hardening (`src/__tests__/integration/helpers/activate-consumers.ts`). Round 1 could NOT reach the database (sandbox network block — now lifted for you) and therefore left these open. Close ALL of them:

## Open item 1 — Finding 6 (MAJOR): the failure-injection and adapter gates
`src/__tests__/integration/m11-2-u3e-evaluations.test.ts` claims coverage its tests do not deliver. Add real tests (there or in a sibling `m11-2-u3e-*` integration file):
- Concurrent completion through the REAL route and the REAL tool (not two direct `completeEvaluation` calls): exactly one result, one registration transition, one `evaluation.completed` event.
- Constraint- or trigger-based failure injection AFTER the decisive write, asserting full rollback of state AND events, for: registration (stale-cleanup + insert), claim, proctor completion, PoAW completion through the REAL submit route, certification completion (this exercises your round-1 finding-1 fix: token-fenced job transition inside the D4 transaction — inject a failure after the transition and prove the job does NOT strand as completed-without-result), and vetting completion.
- A consumed-challenge replay through the REAL submit route: registration, result table, event log, challenge and karma all unchanged (your round-1 finding-2 fix).
Study the injection patterns the neighboring suites already use (m11-1c-karma-components, m11-2-u3-posts, c14-vetting-durability) and reuse their approach; do not invent new harness machinery.

## Open item 2 — the missing race tests from findings 1, 3, 4
- Finding 3: a concurrent two-challenge vetting completion emits exactly ONE `agent.vetted` (both stores — db via real concurrency, memory via its deterministic interleaving pattern used elsewhere).
- Finding 4: the memory registration race (concurrent same-name registration during the stale-cleanup yield) leaves either a clean success or nothing — no stale deletion with a surviving expiry event.
- Finding 5: at least one withdrawal-race test against the memory evaluation writers (the pattern in `src/__tests__/lib/store/agents/withdrawal-cascade-memory.test.ts` is the template).
Mutation-check each: revert the round-1 fix locally → the new test must FAIL → restore. Report the evidence (test name, what you reverted, the failure line).

## Open item 3 — full gates
npx tsc --noEmit && npm run lint && npm test -- --runInBand && npm run test:integration && npm run build.
The integration suite serializes on a Postgres advisory lock — wait if held. The known flake is `c13a` — re-run before concluding. Piped commands report the pipe tail's exit code — read jest's own summary lines. ALL FIVE gates must pass and be reported with their real counts.

## Hard constraints (unchanged from round 1)
- Completion batch lock order untouched; `buildAgentPointsRecompute` stays the one prepared statement; `toAwardedPoints` unmoved; `karma-writer-ownership.test.ts` gains/loses no writer; `m11-1c-karma-components.test.ts` untouched; no house-points write; statement.ts vocabulary only; memory preflight order.
- Fences: your surface is the u3e files (actions/{evaluations,agents,types}.ts, evaluations/{judge,executors/poaw,types}.ts, store/evaluations/{db,memory}.ts, store/agents/{db,index,memory}.ts, the evaluation + agent-lifecycle routes and tool definitions, the m11-2-u3e-* tests, src/__tests__/lib/actions/evaluations.test.ts, withdrawal-cascade-memory.test.ts, store-types.ts type additions only). Do NOT edit legacy-compare.ts, the consumers, soak-shadow-report.sql, playground files, dispatch.ts, statement.ts.
- Production-code changes in this round only where a new test PROVES a defect in round 1's fixes; otherwise this round is tests + gates only. No bloat.

## Report
Per open item: files changed, test names added, mutation-check evidence. Any production defect the new tests exposed and how you fixed it. Then the five gate results verbatim (suite/test counts).
