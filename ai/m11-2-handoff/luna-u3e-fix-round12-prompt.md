# Implementation task — u3e fix round 12 (codex r10: 1 BLOCKER + 7 MAJOR + 2 MINOR + 1 NIT)

Repo: /Users/mohsin/Github/safemolt. Tree is COMMITTED through `b1e9910` on `ops/code-improve`.
Do NOT run any git write command — the orchestrator owns commits. Never invoke the `codex` CLI.

Fix ALL findings from both files:
- `ai/m11-2-handoff/codex-findings-u3e-round10a-store.md` (1 BLOCKER + 3 MAJOR + 1 MINOR)
- `ai/m11-2-handoff/codex-findings-u3e-round10b-actions.md` (4 MAJOR + 1 MINOR + 1 NIT)
Binding: agents.md karma + D4 + prepared-events + memory-preflight invariants. Standing
adjudication: the PINNED ensure contract — a VALID unconsumed challenge always completes.

## Rulings

- **A1 (BLOCKER, nonce fence):** `submitCertificationTranscript` takes the VALIDATED nonce and the
  CAS adds `nonce = $expectedNonce` (memory: the equivalent synchronous check). A submission
  authorized by a lapsed nonce that lost to an in-place refresh must write nothing in both stores.
  Mutation-check with exactly r10a-1's scenario: validate, refresh in place, then submit stale.
- **A2 (lock the selected job):** the start operation's `live` CTE becomes a locking read
  (`FOR UPDATE OF cj`) before the arms use it. Keep the A1 nonce fence as well — the lock alone
  does not reject a later stale submission.
- **A3 (raced 23505):** registration catches `23505` ONLY for `idx_eval_reg_active`, then reruns
  the conditional classifier on a fresh snapshot and answers `existing`/`already_passed`. Every
  other 23505 re-throws (the constraint-name discipline from agents.md).
- **A4 (db refusal precedence):** in the db classifier, a PRESENT challenge classifies
  `mismatch`/`consumed`/`expired` BEFORE any `already_vetted` fallback; `already_vetted` only when
  the challenge row is absent. This does NOT touch the pin: a valid unconsumed challenge completes
  through the batch itself and never reaches the classifier. Memory already has this order — this
  is db parity. A vetted agent replaying a consumed challenge answers `consumed_challenge` in both
  stores, never an idempotent success.
- **A5 (MINOR, memory preflight):** memory start paths substitute + `validatePreparedEvents`
  BEFORE the first state-based return (parity with the db render-before-execute);
  `prepareEventBatch` only when the CAS will emit.
- **B1:** route-level table for certification transcript refusals: absent/`null` ⇒ 400 `Missing
  transcript`; string/object ⇒ 400 `Submission rejected`; exact status and body.
- **B2:** exact action + route cases for `already_vetted`, `expired_challenge`,
  `challenge_mismatch`, `consumed_challenge`, `challenge_not_found`; the live-challenge losing
  race (must NOT answer expired) and the lost-response retry (must answer the idempotent
  already-vetted success, never `challenge_not_found`); characterization for the Cognito claim
  route and the X verify route.
- **B3:** ONE negative-authorization table covering all five operations; per adapter assert the
  exact HTTP status, route `error_detail.code`, tool code, and full before/after state snapshots
  INCLUDING the event log.
- **B4:** the route-vs-tool completion race keeps one-result/one-event and ALSO asserts the legal
  winner and loser responses (retain the route status/body and the full tool result; the loser's
  idempotent `already_complete` 200 is legal).
- **B5 (MINOR):** `submitCertificationTranscriptAction` returns a discriminated refusal union over
  `CertificationRefusalReason`; remove the route's cast so the `never` check actually binds.
- **B6 (NIT):** delete the vetting route's unreachable `outcome === "unavailable"` branch; update
  the comments to say the action classifies the decisive outcome.

## Method
Mutation-check every behavioral fix: failing test first, watch it fail, fix, confirm, record
revert-evidence. Race tests use the harness's concurrency helpers, not sleeps. Match surrounding
style. No bloat. Integration test data is RUN-suffixed under every UNIQUE column.

## Fences
Your surface: src/lib/actions/{evaluations,agents,types}.ts; src/lib/store/evaluations/{db,memory}.ts;
src/lib/store/agents/{db,index,memory}.ts; store-types.ts; the evaluation + agent-lifecycle routes
and tool definitions; the m11-2-u3e-* tests + evaluations.test.ts + complete-vetting-memory.test.ts
+ c21/c22 assertions ONLY where a return-shape change forces re-anchoring (justify each); inventory
§3b. Do NOT touch: karma-writer-ownership.test.ts's enumerated inventory, c14-vetting-durability,
m11-1c-karma-components, consumers, legacy-compare, soak-shadow-report.sql, activity/notifications
store files, playground files, statement.ts, dispatch.ts.

## Gates
Targeted suites while iterating. At the end run ALL FIVE and paste each summary verbatim:
npx tsc --noEmit && npm run lint && npm test -- --runInBand && npm run test:integration &&
npm run build. The full integration run takes ~28 minutes — RUN IT TO COMPLETION; do not substitute
a targeted run and do not stop early. Advisory lock: wait if held. Known flake: c13a — re-run
before concluding.

## Report
Per finding: files changed, tests added, mutation-check evidence, deviations with reasons. Then
the five gate results verbatim.
