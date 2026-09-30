# Implementation task — u3e fix round 10 (codex r8, 2 BLOCKER + 6 MAJOR + 1 MINOR)

Repo: /Users/mohsin/Github/safemolt. Tree is COMMITTED through `fbe7093` on `ops/code-improve`.
Do NOT run any git write command — the orchestrator owns commits. Never invoke the `codex` CLI.

Fix ALL findings from both files:
- `ai/m11-2-handoff/codex-findings-u3e-round8a-store.md` (1 BLOCKER + 2 MAJOR)
- `ai/m11-2-handoff/codex-findings-u3e-round8b-actions.md` (1 BLOCKER + 4 MAJOR + 1 MINOR)
Binding: agents.md karma + D4 + prepared-events + memory-preflight invariants.

## THE ADJUDICATED RULING — read before touching vetting (r8a-1 vs r8b-5)

The two reviews collide on concurrent vetting completions, and the PINNED ensure-semantics
contract WINS: every caller with a VALID unconsumed challenge gets `completed` — challenge
consumed, both bootstrap evaluations ensured, recompute run — even when the agent is already
vetted; ONLY the `is_vetted` flip and the `agent.vetted` event gate on the winning unvetted
decision.
- r8a-1 (BLOCKER) is CORRECT and is the memory-parity half of that pin: remove the memory
  `agent.isVetted` refusal; `winningVetting = !agent.isVetted` gates only the flip and the event;
  bootstrap ensure + recompute + consume always run for a valid challenge.
- r8b-5's proposed fix is REJECTED as written. The integration race test KEEPS asserting that both
  concurrent completions with two valid challenges answer `completed`, both challenges consumed,
  one `agent.vetted`. Do NOT reclassify the loser as a refusal.
- What r8b-5 legitimately protects (with r8b-2): the outcome VOCABULARY. The decisive statement
  distinguishes `already_vetted` / expired / mismatch / consumed internally so the ROUTE can never
  misreport a live challenge as expired — but `already_vetted` WITH a valid consumed-by-this-call
  challenge still renders as completed success. Classification honesty, pinned product contract.

## The other rulings

- **B1 (BLOCKER, start outcome):** the conditional store start operation returns a DISCRIMINATED
  authoritative result for every arm: `created` (CAS fired, fresh effect), `existing_challenge`
  (PoAW retry — project the live unconsumed challenge from inside the statement), `existing_job`
  (live or decided certification job), `refreshed` (lapsed-nonce in-place reissue), `none`.
  The action removes the PoAW→`standard` fallback and the post-operation certification read; the
  route renders the existing challenge on a PoAW retry. Add route-level retry assertions for the
  same PoAW challenge.
- **A3 (r8a-3, registered-branch priority):** a `registered` registration with an existing live or
  decided job must not stay unstartable. Decide the `registered` arm FIRST under the registration
  lock: perform the CAS and establish the usable job (reuse the live one; refresh a lapsed one) in
  the same conditional operation, `evaluation.started` gated only on the CAS. Existing-job reuse
  and lapsed refresh WITHOUT a CAS apply only to `in_progress`. Both stores answer identically.
- **A2 (r8a-2, memory claim):** one internal memory claim operation returns `AgentClaimOutcome`
  from one synchronous section after the human-user lookup await — resolve token, classify target,
  mutate, link, capture outcome, no later map reads. Keep the dispatch rollback.
- **B2:** the vetting-complete route's hash validation and challenge classification move into the
  action — the action takes the submitted hash, the store outcome carries the decisive flags, the
  route renders structured results with no challenge re-read. Post-commit memory/group follow-ups
  stay outside the decisive write.
- **B3:** a non-null non-array transcript classifies as `invalid_transcript` (renders `Submission
  rejected`, 400); `missing_transcript` only for absent/null; every certification refusal carries
  a structured reason and the route uses an exhaustive reason→title switch — no message-text
  matching anywhere.
- **B4:** registration becomes one conditional store outcome distinguishing `created` / `existing`
  / `already_passed`; the action classifies only from it; a route-vs-tool race returns the
  authoritative existing row, never a 500, and memory never reports a raced winner's row as fresh.
- **B6 (MINOR):** add the two missing C22 store-operation tests (lapsed-nonce in-place refresh;
  decided-job returned as-is) and extend EVERY negative-parity row to assert route code, tool code,
  and unchanged registrations/sessions/messages/results/challenges/jobs/events.

## Method
Mutation-check every behavioral fix: failing test first, watch it fail, fix, confirm, record
revert-evidence. Race tests use the harness's concurrency helpers, not sleeps. Match surrounding
style. No bloat. Integration test data is RUN-suffixed under every UNIQUE column.

## Fences
Your surface: src/lib/actions/{evaluations,agents,types}.ts; src/lib/store/evaluations/{db,memory}.ts;
src/lib/store/agents/{db,index,memory}.ts; store-types.ts (type additions); the evaluation +
agent-lifecycle routes and tool definitions; the m11-2-u3e-* tests + evaluations.test.ts +
complete-vetting-memory.test.ts + c22-certification-lifecycle.test.ts (only starts/vetting
contracts); inventory §3b. Do NOT touch: karma-writer-ownership.test.ts's enumerated inventory,
c14-vetting-durability, m11-1c-karma-components, consumers, legacy-compare, soak-shadow-report.sql,
activity/notifications store files, playground files, statement.ts, dispatch.ts.

## Gates
Targeted suites while iterating. At the end, ALL five: npx tsc --noEmit && npm run lint &&
npm test -- --runInBand && npm run test:integration && npm run build. Advisory lock: wait if held.
Known flake: c13a — re-run before concluding. Piped commands report the pipe tail's exit code —
read jest's summary lines. Run the FULL integration gate and report its complete summary — do not
report a targeted run as the full gate.

## Report
Per finding: files changed, tests added, mutation-check evidence, deviations with reasons. Then
the five gate results verbatim.
