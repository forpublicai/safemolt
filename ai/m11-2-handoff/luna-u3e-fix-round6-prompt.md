# Implementation task — u3e fix round 6 (1 BLOCKER + 2 MAJOR, all concurrency races)

Repo: /Users/mohsin/Github/safemolt. Uncommitted tree on `ops/code-improve` — do NOT commit, do NOT run any git write command.

A fresh codex round found three races. Fix ALL. Full findings with file:line and prescribed minimal fixes: `ai/m11-2-handoff/codex-findings-u3e-round4.md`. Binding: agents.md karma + D4 + prepared-events + memory-preflight invariants. Settled and untouchable: the pinned vetting ensure-semantics; the D4 lock order; `buildAgentPointsRecompute` as the one prepared statement.

1. BLOCKER (store/evaluations/db.ts:690,718): `certification_gate` reads the judge token WITHOUT locking the job, so a lease reclaimed while completion waits on the registration lets the STALE judge record its result, award karma and overwrite the new owner's job. Lock the matching certification job `FOR UPDATE` in `certification_gate` before the registration transition; keep the status+token predicates on the final update. Add a real concurrent reclaim-vs-completion integration test. Mind the global lock order: the D4 batch takes the agent row FIRST — place the job lock so no new deadlock cycle appears (document the order you chose in a comment).
2. MAJOR (store/evaluations/memory.ts:523, store/agents/memory.ts:892): both memory completion paths append events and AWAIT dispatch before the evaluation-points recompute, exposing a completed result with stale karma — a state PostgreSQL cannot show (D4 is one transaction). Extract the recompute body into one synchronous helper used by the existing async wrapper; run it before the first await, in the same synchronous section as the result, challenge and event append. Do NOT add another karma writer — `karma-writer-ownership.test.ts` must not change.
3. MAJOR (actions/evaluations.ts:416, store/evaluations/db.ts:272): session-message authorization goes stale — a proctor completion can end the session while the message insert waits on the session lock, and the insert lands anyway. Gate the insert (inside the locked statement) on `status = 'active'` AND the sender's participant row, deriving the role there; mirror synchronously in memory; classified refusal when no row inserts. Race test through the route and the tool.

## Method
Mutation-check each fix: failing test first, watch it fail, fix, confirm, record revert-evidence. Race tests must use real concurrency (the harness's runConcurrently / raceAgainstHeldLock patterns) or a deterministic barrier, not sleeps. Match surrounding style. No bloat.

## Fences
Your surface: src/lib/store/evaluations/{db,memory}.ts; src/lib/store/agents/memory.ts; src/lib/actions/evaluations.ts; src/lib/evaluations/judge.ts if its rendering must follow; the u3e tests + src/__tests__/lib/actions/evaluations.test.ts. Do NOT touch: c14-vetting-durability, m11-1c-karma-components (byte-identical), karma-writer files, consumers, legacy-compare, soak-shadow-report.sql, playground files, statement.ts, dispatch.ts.

## Gates
npx tsc --noEmit && npm run lint && npm test -- --runInBand && npm run test:integration && npm run build. All five must pass. Advisory lock: wait if held. Known flake: c13a — re-run before concluding. Piped commands report the pipe tail's exit code — read jest's summary lines.

## Report
Per finding: files changed, tests added, mutation-check evidence, deviations with reasons. Then the five gate results verbatim (suite/test counts).
