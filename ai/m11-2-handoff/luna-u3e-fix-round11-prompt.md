# Implementation task — u3e fix round 11 (codex r9: 1 BLOCKER + 8 MAJOR + 2 MINOR)

Repo: /Users/mohsin/Github/safemolt. Tree is COMMITTED through `20a8531` on `ops/code-improve`.
Do NOT run any git write command — the orchestrator owns commits. Never invoke the `codex` CLI.

Fix ALL findings from both files:
- `ai/m11-2-handoff/codex-findings-u3e-round9a-store.md` (1 BLOCKER + 3 MAJOR + 1 MINOR)
- `ai/m11-2-handoff/codex-findings-u3e-round9b-actions.md` (5 MAJOR + 1 MINOR)
Binding: agents.md karma + D4 + prepared-events + memory-preflight invariants. The r8 adjudication
stands: the PINNED ensure contract wins — a valid unconsumed challenge always completes; the
concurrent two-challenge test keeps asserting both-completed.

## The one design to finish (A1 — BLOCKER, plus A2, B1, B5)

The certification/PoAW start must FINISH its state machine, in the STATEMENT, with the outcome
projected from the statement — this is the third round on this operation; close it completely:
- The conditional SQL projects the SELECTED JOB and an ARM LABEL (`created`/`refreshed`/
  `existing_job`) directly; the registration CAS fires for a `registered` registration whichever
  arm supplied the job — fresh insert, lapsed refresh, OR reuse of a valid live job —
  with `evaluation.started` gated on the CAS; `started: true` iff the CAS fired. REMOVE the
  post-transaction `getCertificationJobByRegistration` read entirely: the statement's projection
  is the only source of the returned job.
- `refreshed` must actually be returned by the refresh arm (db and memory).
- PoAW retry parity (A2): ONE shared rule — the NEWEST valid unconsumed challenge — in both
  stores; and the `registered`-arm reuse/create decision must match between stores exactly.
- The ACTION (B1) switches EXHAUSTIVELY on `outcome.kind`; `none` renders as a defined refusal,
  never as a `standard` success. No optional-field sniffing (`started.challenge` /
  `started.certificationJob` as the discriminator is what r9b-1 rejects).
- B5's missing C22 evidence: scoped tests proving (a) a lapsed pending nonce refreshes the SAME
  row (row identity, no second row, no event) and (b) a submitted/judging/completed job returns
  unchanged (no new paid attempt), asserting job count, status, nonce behavior, and zero
  additional `evaluation.started`.

## The remaining rulings

- **A3 (registration under concurrency):** first transaction statement locks the AGENT row; the
  conditional outcome statement runs after it on a fresh snapshot; the passed-result arm has
  priority over the active-registration arm in BOTH stores; `already_passed` projects the REAL
  prior registration identifiers (db parity with memory); a raced loser's `23505` on
  `idx_eval_reg_active` classifies as `existing` with the winner's row, never a throw.
- **A4 (memory Cognito claim ordering):** read the human row but DEFER its absence error; resolve
  the token and classify missing/already-claimed in one synchronous section after the last await;
  the human-row error surfaces only when the claim is otherwise eligible to write (parity with the
  FK that Postgres only checks on the write).
- **A5 (MINOR, claim rollback):** snapshot the exact prior ownership ROLE (e.g. `public_ai`), not
  a boolean; restore that exact role on dispatch failure.
- **B2 (vetting classification authority):** the decisive completion outcome is the ONLY
  classification authority. The action maps every decisive flag to a structured result; a refused
  challenge (missing/mismatch/consumed/expired) is a structured REFUSAL, not `actionOk`-wrapped
  `unavailable`; `ok: true` only for completion or its defined idempotent success (the pinned
  valid-challenge completion). A lost-response retry after challenge cleanup must never report
  `challenge_not_found` when the decisive outcome says `already_vetted`. Update the action test
  that pins `unavailable` as `ok: true` — that is the OLD contract.
- **B3 (race test):** drop the exactly-one-transport-success assertion; assert one stored result,
  one `evaluation.completed` event, and a valid response from BOTH adapters for either winner
  (the loser's idempotent 200 `already_complete` is legal).
- **B4 (parity table):** ONE table covering all five operations; before each ROUTE and TOOL call,
  snapshot every applicable domain map AND the event log; assert the exact denial code and fully
  unchanged state per adapter.
- **B6 (MINOR):** export the certification-refusal reason union; the route's reason→title mapping
  becomes an exhaustive switch with a `never` check; add route cases for absent/null, string, and
  object transcripts asserting the exact `Missing transcript` vs `Submission rejected` titles.

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
