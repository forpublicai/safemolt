# Implementation task — u3e fix round 9 (codex r7 findings, both scoped reviews)

Repo: /Users/mohsin/Github/safemolt. Uncommitted tree on `ops/code-improve` — do NOT commit, do NOT run any git write command.

Fix ALL findings from both files, blockers first:
- `ai/m11-2-handoff/codex-findings-u3e-round7a-store.md` (store: 2 BLOCKER + 4 MAJOR + 1 MINOR)
- `ai/m11-2-handoff/codex-findings-u3e-round7b-actions.md` (actions/adapters/tests: 1 BLOCKER + 3 MAJOR)

**A1, A4 and B1 are ONE redesign of the certification-start store operation — do them together, first.**
Binding: agents.md karma + D4 + prepared-events + memory-preflight invariants. Settled: pinned vetting ensure-semantics; the D4 agent-first FOR UPDATE completion batch; one recompute statement; the PoAW-vs-other executor-error split; the single conditional start operation (round 8's B1 — the store start operation is the ONLY creator of the first challenge/job).

Key rulings:
- **A1 (BLOCKER, sibling CTEs):** the certification start's `expired` UPDATE and `effect` INSERT are unordered sibling CTEs over the SAME partial unique index (`idx_cert_jobs_live_registration`) — agents.md's arbiter rule forbids exactly this. Restructure into ONE ordered conditional operation: decide from a locked read (the registration row is already FOR UPDATE in the transaction) whether to REFRESH the lapsed pending job in place (UPDATE nonce/nonce_expires_at/created_at) or INSERT a fresh job when none is live; the two arms must be mutually exclusive, playground-join style, and the CAS + effect + `evaluation.started` still gate together. No unordered sibling update+insert touching one partial unique index.
- **A2 (BLOCKER, lock order):** the D4 completion batch's FIRST element locks BOTH `row.agentId` AND `row.proctorAgentId` (when supplied), in agent-id order, before job/registration/session locks — the proctor claim already locks both, so completion must match or the FK lock on `proctor_agent_id` closes a 40P01 cycle. Add a deadlock race test in the D4 `CLOSED BY D4` style (wedge a claim on the agent locks, drive a completion with a proctor whose id sorts first).
- **A3:** the memory certification-start failure path restores EVERYTHING it changed: snapshot the old pending job (the one it expired) and the registration before mutating; on dispatch failure restore both and delete ONLY a job id this call created — never a pre-existing job `createCertificationJobSync` merely returned.
- **A4:** an existing non-expired live job on a `registered` registration is classified BEFORE any mutation, in BOTH stores, with the SAME no-write no-emit outcome (return the existing job, no new `evaluation.started`). The db path currently 23505s and rolls back; the memory path wrongly emits a fresh start over the ensured job. Both must answer identically. The c22 decided-job contract (submitted/judging job returned as-is) must keep passing.
- **A5:** memory `claimAgentForHumanUserWithOutcome` projects `agentExists`/`claimed`/the agent in ONE synchronous section AFTER the last await — no pre-await existence read may survive into the outcome.
- **A6:** the memory Cognito claim snapshots the agent + human-ownership link before mutating and restores both when event dispatch fails (same rollback structure as `setAgentClaimedWithOutcome`).
- **A7 (MINOR):** memory vetting expiry refuses at `expiresAt <= Date.now()` (PostgreSQL's `expires_at > NOW()` twin).

- **B1 (BLOCKER, permanent certification block):** round 8's B1 removed the action fallback, but the store operation's CAS only fires for a `registered` registration — so an `in_progress` registration whose pending nonce lapsed can never get a reissue, and the certification is permanently blocked. The fix folds into A1's redesign: the ONE conditional store operation owns every arm, decided from one locked read — (a) `registered` ⇒ CAS + fresh effect + `evaluation.started`; (b) `in_progress` + lapsed pending job ⇒ refresh/reissue the job, NO event (the original start already emitted; a reissue is not a new start); (c) `in_progress` + live pending/decided job ⇒ no write, no emit, return the existing job (A4). The action calls the operation WITHOUT an adapter-side status guard and returns the authoritative existing/decided/reissued job. PoAW: a losing or repeated start returns the EXISTING challenge, not a generic refusal. The two re-anchored c22 contracts must keep passing through this shape.
- **B2:** the submit route's certification branch passes `transcript` as `unknown` to the action; validation + normalization live in the action; a string/object transcript answers the documented 400 (never a 500 from `.map()`); the action returns a structured refusal reason and the adapter renders the exact legacy titles (`Missing transcript` vs `Submission rejected`) from flags, never from message-text matching. Characterize the legacy wire shapes FIRST.
- **B3:** extend the negative-authorization parity table to EVERY applicable route/tool pair: registration, start, proctor claim, session message, proctor submission — assert the expected code AND that no mutation occurred.
- **B4:** the vetting-completion outcome distinguishes `already_vetted` / expiry / mismatch / consumption from the DECISIVE statement (both stores); the action classifies from those flags; the route renders them. A losing concurrent completion whose challenge is still live must NOT report `Challenge expired`. No cause inference from later reads.

## Method
Mutation-check every behavioral fix: failing test first, watch it fail, fix, confirm, record revert-evidence. Race tests use the harness's concurrency helpers, not sleeps. Match surrounding style. No bloat.

## Fences
Your surface: src/lib/actions/{evaluations,agents,types}.ts; src/lib/evaluations/{judge,types}.ts; src/lib/store/evaluations/{db,memory}.ts; src/lib/store/agents/{db,index,memory}.ts; store-types.ts (type additions); the evaluation + agent-lifecycle routes and tool definitions; the m11-2-u3e-* tests + evaluations.test.ts + withdrawal-cascade-memory.test.ts + complete-vetting-memory.test.ts + save-result-parity.test.ts; c22-certification-lifecycle.test.ts ONLY if A4's classification needs a pinned-contract update (justify in the report); inventory §3b. Do NOT touch: karma-writer-ownership.test.ts's enumerated inventory, c14-vetting-durability, m11-1c-karma-components, consumers, legacy-compare, soak-shadow-report.sql, playground files, statement.ts, dispatch.ts.

## Gates
npx tsc --noEmit && npm run lint && npm test -- --runInBand && npm run test:integration && npm run build. ALL five must pass. Advisory lock: wait if held. Known flake: c13a — re-run before concluding. Piped commands report the pipe tail's exit code — read jest's summary lines.

## Report
Per finding (A1–A7, B…): files changed, tests added, mutation-check evidence, deviations with reasons. Then the five gate results verbatim.
