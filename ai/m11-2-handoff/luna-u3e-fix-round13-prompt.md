# Implementation task — u3e fix round 13 (codex r11: 4 MAJOR + 3 MINOR, NO blockers)

Repo: /Users/mohsin/Github/safemolt. Tree is COMMITTED through `a230fe4` on `ops/code-improve`.
Do NOT run any git write command — the orchestrator owns commits. Never invoke the `codex` CLI.

This should be the closing round: r11 found no blockers and no karma/lock/manifest issues. Fix ALL
findings from both files:
- `ai/m11-2-handoff/codex-findings-u3e-round11a-store.md` (1 MAJOR + 2 MINOR)
- `ai/m11-2-handoff/codex-findings-u3e-round11b-actions.md` (3 MAJOR + 1 MINOR)
Binding: agents.md invariants. Standing adjudications: the PINNED ensure contract; the merged
refusal precedence (mismatch first; a vetted agent's OWN dead-or-absent challenge answers
idempotent `already_vetted`; only an unvetted agent sees `consumed`/`expired`).

## Rulings

- **A1 (registration 23505 recovery):** when the conflict state has vanished before classification
  (the racing registration completed with a failed result in the gap), do NOT throw — retry the
  conditional registration operation ONCE with a fresh transaction, still handling only
  `idx_eval_reg_active` by name. Bounded: one retry, then the normal outcome (a second conflict
  classifies again; a second disappearance may throw as today).
- **A2 (MINOR):** memory `addSessionMessage` substitutes the primary event and calls
  `validatePreparedEvents` BEFORE the first state-based return; `prepareEventBatch` stays after
  eligibility classification.
- **A3 (MINOR):** one completion timestamp, created in `completeVetting`, passed into
  `runCompleteVettingBatch` AND reused by the post-transaction activity writes — a bootstrap
  result's `completed_at` equals its activity row's ordering time (memory already does this).
- **B1 (pre-read override — the last idempotency hole):** the action's early hash guard fires ONLY
  when the owned challenge is LIVE and unconsumed. For a missing, consumed, or expired challenge
  the action calls `storeCompleteVetting` and classifies from its decisive flags alone — a vetted
  agent retrying its own consumed challenge answers the idempotent success regardless of the
  submitted hash. Mutation-check exactly that scenario.
- **B2 (recent-contract evidence):** the ACTION suite imports and tests the public
  `startEvaluationWithEffect`-consuming action and `submitCertificationTranscriptAction` (not the
  memory store op directly). The ROUTE characterization imports and drives the vetting-complete,
  Cognito-claim, and X-verify routes; a certification transcript table (absent/`null` ⇒ 400
  `Missing transcript`; string/object ⇒ 400 `Submission rejected`); route cases for every vetting
  refusal reason, the lost-response retry (idempotent 200), and the live-challenge losing race
  (not expired). Keep the store-level C22 tests as lower-level evidence.
- **B3 (denial parity):** ONE five-row table; per row assert the EXACT route HTTP status, EXACT
  route error code, EXACT tool code, and the unchanged full state snapshot (event log included)
  for both adapters. No substring checks, no >=400 acceptance.
- **B4 (MINOR):** the claim route renders `owner: agent.owner ?? null` from the action's returned
  agent, not from local input.

## Method
Mutation-check every behavioral fix: failing test first, watch it fail, fix, confirm, record
revert-evidence. Match surrounding style. No bloat. Integration test data is RUN-suffixed under
every UNIQUE column.

## Fences
Your surface: src/lib/actions/{evaluations,agents,types}.ts; src/lib/store/evaluations/{db,memory}.ts;
src/lib/store/agents/{db,index,memory}.ts; the evaluation + agent-lifecycle routes and tool
definitions; the m11-2-u3e-* tests + evaluations.test.ts + complete-vetting-memory.test.ts;
inventory §3b. Do NOT touch: karma-writer-ownership.test.ts's enumerated inventory,
c14-vetting-durability, m11-1c-karma-components, c21/c22 (this round forces no shape change),
consumers, legacy-compare, soak-shadow-report.sql, activity/notifications store files, playground
files, statement.ts, dispatch.ts.

## Gates
Targeted suites while iterating. At the end run ALL FIVE and paste each summary verbatim:
npx tsc --noEmit && npm run lint && npm test -- --runInBand && npm run test:integration &&
npm run build. The full integration run takes ~28 minutes — RUN IT TO COMPLETION. Advisory lock:
wait if held. Known flake: c13a — re-run before concluding.

## Report
Per finding: files changed, tests added, mutation-check evidence, deviations with reasons. Then
the five gate results verbatim.
