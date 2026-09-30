# Implementation task — u3e fix round 7 (two scoped reviews: 9 MAJOR + 2 MINOR)

Repo: /Users/mohsin/Github/safemolt. Uncommitted tree on `ops/code-improve` — do NOT commit, do NOT run any git write command.

Round 5's review ran as two scoped passes. Fix ALL findings from both files:
- `ai/m11-2-handoff/codex-findings-u3e-round5a-store.md` (store layer: 4 MAJOR + 1 MINOR)
- `ai/m11-2-handoff/codex-findings-u3e-round5b-actions.md` (actions/adapters/tests: 5 MAJOR + 1 MINOR)
Binding: agents.md karma + D4 + prepared-events + memory-preflight invariants. Settled: pinned vetting ensure-semantics; D4 lock order; one recompute statement.

Orchestrator rulings on the two findings that need interpretation:
- **Actions finding 2 (self-serve executor errors):** the executor-error denial was round 1's prescribed fix for the PoAW consumed-challenge replay. It over-reached: it also changed the SELF-SERVE wire contract, which used to save the failed result and answer 200 with the result body's `error` field. RESTORE the legacy self-serve behavior (pass the executor result through to completion) and keep the denial ONLY where the refusal is the contract: a PoAW submission whose challenge is consumed/invalid (the replay-rejection rule) — that scoped denial is characterization-pinned already. Add exact characterization for the self-serve error branch.
- **Store finding 3 (job stays live after another completion wins):** the round-5 rule composes with round 3's "stale judge returns null": when the fenced completion answers `already_complete` (a standing result blocks insertion) while THIS judge holds a valid lease and token, make the job terminal in the same token-fenced statement (an explicit superseded/completed transition — pick one, name it in a comment, mirror memory). The judge still returns null after lease LOSS; a lease-holding judge whose work is superseded finishes the job instead of leaving it reclaimable forever.

The other findings as prescribed: (A1) memory stale-name release must refuse with `23503` when any non-cascading reference (e.g. `following.followee_id`) targets the stale agent — check what PostgreSQL checks, before any mutation; (A2) remove the `agents.size === 0` escape hatch in the memory actor check — fix fixtures instead; (A4) add `role` to the session-message insert's final SELECT; (A5) memory expands the expiration event batch per released row, positional-primary substitution only for the primary; (B1) couple the start CAS and its flow-specific durable write (PoAW challenge / certification job) into one conditional transaction with `evaluation.started` gated on the whole operation — a repeated start inserts nothing and emits nothing; (B3) vetting-start's already-vetted rule moves into a conditional store insert (decisive flags, action classifies, route renders); (B4) claim store operations return classified flags (`agent_exists`, `claimed`) — the action never maps a bare null to `already_claimed`; (B5) table-driven route+tool parity for the full C2 denial matrix + exact characterization for claim, verify and vetting-complete responses; (B6) rename the two false "race" tests as sequential-parity tests or give them a real barrier.

## Method
Mutation-check every behavioral fix: failing test first, watch it fail, fix, confirm, record revert-evidence. Match surrounding style. No bloat.

## Fences
Your surface: src/lib/actions/{evaluations,agents,types}.ts; src/lib/evaluations/{judge,executors/poaw,types}.ts; src/lib/store/evaluations/{db,memory}.ts; src/lib/store/agents/{db,index,memory}.ts; store-types.ts (type additions); the evaluation + agent-lifecycle routes and tool definitions; the u3e tests + evaluations.test.ts + withdrawal-cascade-memory.test.ts + complete-vetting-memory.test.ts; kinds.ts/coverage.ts only if a kind entry must change; inventory §3b. Do NOT touch: c14-vetting-durability, m11-1c-karma-components (byte-identical), karma-writer files, consumers, legacy-compare, soak-shadow-report.sql, playground files, statement.ts, dispatch.ts.

## Gates
npx tsc --noEmit && npm run lint && npm test -- --runInBand && npm run test:integration && npm run build. All five must pass. Advisory lock: wait if held. Known flake: c13a — re-run before concluding. Piped commands report the pipe tail's exit code — read jest's summary lines.

## Report
Per finding (A1–A5, B1–B6): files changed, tests added, mutation-check evidence, deviations with reasons. Then the five gate results verbatim.
