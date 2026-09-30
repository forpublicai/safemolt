# Implementation task — u3e fix round 5 (4 MAJOR + 1 MINOR; no blockers left)

Repo: /Users/mohsin/Github/safemolt. Uncommitted tree on `ops/code-improve` — do NOT commit, do NOT run any git write command.

A fresh codex round over u3e found 4 MAJOR + 1 MINOR. Fix ALL. Full findings with file:line and prescribed minimal fixes: `ai/m11-2-handoff/codex-findings-u3e-round3.md`. Binding context: agents.md karma + D4 + prepared-events + memory-preflight invariants. The PINNED vetting ensure-semantics from round 4 are settled — do not touch them.

Summary:
1. MAJOR (store/evaluations/memory.ts:464): memory completion runs `requireAgent` BEFORE classifying a refused write, so a withdrawal-cascaded registration answers `23503` where PostgreSQL answers `not_actionable`. Reorder: classify refusals (registration/challenge/certification) first; check the actor only when the write is still eligible. Fix the withdrawal test to expect `not_actionable` — memory refusal parity is per path, matching what PostgreSQL actually does.
2. MAJOR (vetting/complete/route.ts:194): a valid SECOND vetting completion overwrites the IDENTITY.md context mirror with the losing request's identity. After every `completed`, reload the agent and pass `fresh.identityMd` to `runPostCommitFollowUps` and `successResponse` (the `respondIdempotentSuccess` path already does this). Route test: two challenges, different identity values — the stored identity and the mirror agree, and `identity_received` reports what was actually stored.
3. MAJOR (store/agents/memory.ts:656): memory withdrawal misses two FK effects: (a) PostgreSQL deletes every evaluation message whose sender is the withdrawn agent — memory deletes only messages in the agent's own sessions; (b) `evaluation_results.proctor_agent_id` has NO cascade, so PostgreSQL REFUSES withdrawal of a recorded proctor — memory must refuse BEFORE any mutation (the `foreign_key` refusal path, like the group-owner rule). Cross-agent tests for both.
4. MAJOR (judge.ts:238,314): a stale certification judge whose lease was reclaimed still returns its verdict after its folded completion answers `not_actionable`. Return `null` when the registration is missing or `saved.outcome !== "created"`. Test: reclaim between inference and completion — the stale worker returns `null`, stores nothing.
5. MINOR (m11-2-u3e-evaluations.test.ts:522): add `agent.claimed` event failure-injection for BOTH Cognito and X claims — agent stays unclaimed, no `user_agents` row.

## Method
Mutation-check every behavioral fix: failing test first, watch it fail, fix, confirm, record revert-evidence. Match surrounding style. No bloat.

## Fences
Your surface: src/lib/store/evaluations/memory.ts; src/lib/store/agents/{db,memory}.ts; src/lib/evaluations/judge.ts; src/app/api/v1/agents/vetting/complete/route.ts; src/app/api/v1/internal/certification-judging/route.ts if its rendering must follow; the u3e tests + src/__tests__/lib/actions/evaluations.test.ts + withdrawal-cascade-memory.test.ts + complete-vetting-memory.test.ts. Do NOT touch: c14-vetting-durability, m11-1c-karma-components (byte-identical), karma-writer files, consumers, legacy-compare, soak-shadow-report.sql, playground files, statement.ts, dispatch.ts.

## Gates
npx tsc --noEmit && npm run lint && npm test -- --runInBand && npm run test:integration && npm run build. All five must pass. Advisory lock: wait if held. Known flake: c13a — re-run before concluding. Piped commands report the pipe tail's exit code — read jest's summary lines.

## Report
Per finding: files changed, tests added, mutation-check evidence, deviations with reasons. Then the five gate results verbatim (suite/test counts).
