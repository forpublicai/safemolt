# Implementation task — u3e fix round 8 (2 BLOCKER + 8 MAJOR from two scoped reviews)

Repo: /Users/mohsin/Github/safemolt. Uncommitted tree on `ops/code-improve` — do NOT commit, do NOT run any git write command.

Fix ALL findings from both files, in this order (the blockers interact — do A1 and B1 first, together):
- `ai/m11-2-handoff/codex-findings-u3e-round6a-store.md` (store: 1 BLOCKER + 5 MAJOR)
- `ai/m11-2-handoff/codex-findings-u3e-round6b-actions.md` (actions/adapters/tests: 1 BLOCKER + 3 MAJOR)
Binding: agents.md karma + D4 + prepared-events + memory-preflight invariants. Settled: pinned vetting ensure-semantics; the D4 agent-first FOR UPDATE completion batch; one recompute statement; the PoAW-vs-other executor-error split (poaw_handler error ⇒ 400 denial writing nothing; other executors ⇒ legacy saved-error 200).

Key rulings:
- **A1 (BLOCKER, lock order):** the global order is AGENTS FIRST — the D4 batch and C14 already lock the agent before touching the registration. Bring `claimProctorSession` and `startEvaluationWithEffect` into that order: lock every referenced agent row first (agent-id order when two — candidate and proctor), then the registration, then session/job. Add a deadlock race test in the style of the D4 `CLOSED BY D4` cases (wedge one path on the agent lock, drive the other).
- **B1 (BLOCKER, start fallback):** the conditional store start operation is the ONLY creator of the first challenge/job. A call that loses the start CAS may READ and return an existing effect; it must never create, expire, or replace one. Remove the action's fallback mutations.
- A2: memory start preflights the FULL event batch before any write; certification job creation synchronous in the decisive section, or re-check the registration after the await and before all writes.
- A3: `completeRegistrationAtomically` catches ONLY the two expected result-uniqueness constraints BY NAME (the 23503-by-name precedent in agents.md); `idx_events_idem` and every other 23505 re-throws.
- A4: vetting-start selects and locks the target agent in the statement, gates the insert on the locked `is_vetted`, and returns `agent_exists`/`created`/`already_vetted` from one scalar projection.
- A5: the claim operations project `agentExists`/`claimed`/the claimed row from the locked target + claim CTEs (db) and one synchronous section (memory) — no wrapper reconstruction from later reads.
- A6: memory `addSessionMessage` and `claimProctorSession` classify all no-write conditions BEFORE actor checks (per-path PostgreSQL parity).
- B2: the submit route's certification branch (transcript validation, authorization, expiry classification, submitCertificationTranscript) moves into an evaluation action; route parses, calls, schedules judging, renders. Characterize the branch's wire shapes FIRST.
- B3: the Cognito claim route calls the action for the decision and renders from `claimed.data.agent`; the pre-read may remain only for building auxiliary response context, never as the refusal decision.
- B4: add the missing test evidence: `startEvaluationWithEffect` memory + Postgres tests (atomic PoAW challenge, atomic certification job, losing CAS via held-lock race, repeated-start no-write, evaluation.started failure rollback) and table-driven negative-authorization parity through each applicable ROUTE and TOOL adapter.

## Method
Mutation-check every behavioral fix: failing test first, watch it fail, fix, confirm, record revert-evidence. Race tests use the harness's concurrency helpers, not sleeps. Match surrounding style. No bloat.

## Fences
Your surface: src/lib/actions/{evaluations,agents,types}.ts; src/lib/evaluations/{judge,types}.ts; src/lib/store/evaluations/{db,memory}.ts; src/lib/store/agents/{db,index,memory}.ts; store-types.ts (type additions); the evaluation + agent-lifecycle routes and tool definitions; the m11-2-u3e-* tests + evaluations.test.ts + withdrawal-cascade-memory.test.ts + complete-vetting-memory.test.ts + save-result-parity.test.ts; kinds.ts/coverage.ts only if a kind entry must change; inventory §3b. Do NOT touch: c14-vetting-durability, m11-1c-karma-components, c22-certification-lifecycle beyond adding tests (existing tests byte-identical), karma-writer files, consumers, legacy-compare, soak-shadow-report.sql, playground files, statement.ts, dispatch.ts.

## Gates
npx tsc --noEmit && npm run lint && npm test -- --runInBand && npm run test:integration && npm run build. All five must pass. Advisory lock: wait if held. Known flake: c13a — re-run before concluding. Piped commands report the pipe tail's exit code — read jest's summary lines.

## Report
Per finding (A1–A6, B1–B4): files changed, tests added, mutation-check evidence, deviations with reasons. Then the five gate results verbatim.
