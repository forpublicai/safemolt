# Implementation task — u3e fix round 3

Repo: /Users/mohsin/Github/safemolt. Uncommitted tree on `ops/code-improve` — do NOT commit, do NOT run any git write command.

Rounds 1–2 fixed the first review's findings; a fresh codex round found 2 BLOCKER + 3 MAJOR + 1 MINOR in and around those fixes. Fix ALL of them. Findings text with file:line and prescribed minimal fixes: `ai/m11-2-handoff/codex-findings-u3e-round2.md`. Read it in full first. Binding context: agents.md karma block + D4 completion-atomicity + prepared-events + memory-preflight invariants; the original spec `ai/m11-2-handoff/u3e-spec.md`.

Summary of the six:
1. BLOCKER (db.ts:690): the certification job can reach `completed` with zero-row registration transition — gate the job update on `inserted` so the job completes only when the result exists; test: valid judging token + terminal registration ⇒ job stays `judging`, no result, no event.
2. BLOCKER (agents/db.ts:982…1118): vetting effects gate on the live challenge, not on the winning unvetted decision — introduce the token-stamped decision from the locked `is_vetted = false` transition and gate BOTH bootstrap statements, the points recompute and the challenge consumption on it; a losing call returns `unavailable` and leaves its challenge unconsumed; align memory (which today returns early without consuming — after the fix both stores must agree); update the two-challenge tests to require exactly one total `completed` and to check both challenge rows.
3. MAJOR (agents/memory.ts:287): memory Cognito claim exposes claimed-but-unlinked across awaits — synchronous ownership-link + agent change + event append in one no-await section after full preflight; add PostgreSQL `user_agents` insert failure injection and a memory observation test.
4. MAJOR (evaluations/[id]/start/route.ts): the start route performs Tier-1 mutations outside the action layer and ignores the registration CAS — add a start action/domain operation owning the start transition and its PoAW/certification effect, preserving the current route response and certification idempotency; route becomes parse → action → render. CHARACTERIZE the route's current wire behavior first (extend the existing characterization suite), then refactor behind it.
5. MAJOR (agents/memory.ts:300): memory withdrawal leaves evaluation rows PostgreSQL cascades away — one evaluation-memory cascade helper called before the agent delete, removing registrations, dependent results, participants, certification jobs and applicable session data in FK order; parity test with active and completed data.
6. MINOR (agents/memory.ts:35,76): memory registration preflights the two event groups as separate batches — substitute all subjects first, then ONE prepareEventBatch over the combined ordered list, then mutate and append once.

## Hard constraints (unchanged)
- Completion batch lock order untouched; `buildAgentPointsRecompute` stays the ONE prepared statement; `toAwardedPoints` unmoved; `karma-writer-ownership.test.ts` gains/loses no writer; `m11-1c-karma-components.test.ts` untouched; no house-points write; statement.ts vocabulary only; memory preflight order; memory re-checks are parity with what PostgreSQL refuses, per path.
- Finding 2's fix must NOT weaken the FOR UPDATE agent lock or reorder the batch.
- Finding 4's refactor must not change any wire shape — the characterization tests are the proof.

## Method
Mutation-check every behavioral fix: write the failing test FIRST against the unfixed code, watch it fail, fix, confirm green, and record revert-evidence (revert fix → test fails → restore). Match surrounding code style. No bloat.

## Fences
Your surface: src/lib/actions/{evaluations,agents,types}.ts; src/lib/evaluations/{judge,executors/poaw,types}.ts; src/lib/store/evaluations/{db,memory}.ts; src/lib/store/agents/{db,index,memory}.ts; src/lib/store-types.ts (type additions only); the evaluation + agent-lifecycle routes and tool definitions; the m11-2-u3e-* tests; src/__tests__/lib/actions/evaluations.test.ts; withdrawal-cascade-memory.test.ts; events/kinds.ts + consumers/coverage.ts only if a kind entry must change; ai/validation/m11-inventory.md §3b; agents.md only to record a new invariant.
Do NOT edit: legacy-compare.ts, the consumers, soak-shadow-report.sql, playground files, dispatch.ts, statement.ts, any karma-writer file outside the fenced list.

## Gates
npx tsc --noEmit && npm run lint && npm test -- --runInBand && npm run test:integration && npm run build. The integration suite serializes on a Postgres advisory lock — wait if held. Known flake: `c13a` — re-run before concluding. Piped commands report the pipe tail's exit code — read jest's own summary lines. All five must pass.

## Report
Per finding: files changed, test names added, mutation-check evidence, deviations from the prescribed fix with reasons. Then the five gate results verbatim (suite/test counts).
