# Implementation task — u3e round 8b: close round 8's three leftovers

Repo: /Users/mohsin/Github/safemolt. Uncommitted tree on `ops/code-improve` — do NOT commit, do NOT run any git write command.

Round 8 implemented findings A1–A6 and B1–B3 (see `ai/m11-2-handoff/luna-u3e-fix-round8-prompt.md` for their text). Three things remain. Binding: agents.md karma + D4 + prepared-events + memory-preflight invariants.

## Leftover 1 — the karma-writer scan fails (fix FIRST)
`npm test -- --runInBand src/__tests__/lib/karma-writer-ownership.test.ts` fails: the scan finds a SECOND `memory-agents-set-karma` site in `src/lib/store/agents/memory.ts` (the enumerated inventory allows exactly one). Round 8's memory edits introduced an `agents.set` whose object (directly or via a bound literal the scanner resolves) carries a karma field. Run the test, read the received-vs-expected diff, find the new site, and REROUTE it through the existing single writer — the recompute helper in `src/lib/store/evaluations/memory.ts` — or restructure so the object no longer carries karma fields. Do NOT add the site to the test's enumerated inventory: the invariant is one writer per component, and the scan exists to refuse new ones.

## Leftover 2 — the two c22 unit tests that pin the pre-B1 fallback
`src/__tests__/api/v1/c22-certification-lifecycle.test.ts`: "expires a pending job whose nonce lapsed and issues a fresh one" and "start returns the decided job while its result save is in flight, instead of a fresh one" fail because they drive the removed action-layer fallback. RULING: their CONTRACTS survive — nonce-lapse expiry+reissue is recorded product behavior (c17-reissue-rotation still passes in integration), and a completed-gap start must not mint a second paid attempt. What moved is WHERE: both now live inside the conditional store start operation. Update ONLY these two tests to drive the new entry point (the action, which delegates to the store operation) and assert the SAME outcomes: a lapsed nonce yields exactly one fresh job and the old one expired; a decided job is returned as-is with no new job row. If either contract does NOT survive through the new path, that is a production defect — fix the store operation, not the assertion.

## Leftover 3 — B4, the missing test evidence
From `ai/m11-2-handoff/codex-findings-u3e-round6b-actions.md` finding 4: add real memory AND Postgres tests for `startEvaluationWithEffect`: atomic PoAW challenge creation, atomic certification-job creation, a losing start CAS via a held-lock race (harness concurrency helpers, no sleeps), repeated-start no-write no-emit, and rollback after an injected `evaluation.started` failure. Add table-driven negative-authorization parity tests that invoke each applicable ROUTE and TOOL adapter (not only the shared action) for the C2 denial matrix.

## Method
Mutation-check each behavioral change: failing test first, watch it fail, fix, confirm, record revert-evidence. Match surrounding style. No bloat.

## Fences
Your surface: src/lib/store/agents/memory.ts; src/lib/store/evaluations/{db,memory}.ts; src/lib/actions/evaluations.ts if leftover 2's contract needs a store fix routed through it; the two named c22 tests ONLY (no other c22 test may change); the m11-2-u3e-* tests + evaluations.test.ts; inventory §3b. Do NOT touch: karma-writer-ownership.test.ts's enumerated inventory, c14, m11-1c, consumers, legacy-compare, soak-shadow-report.sql, playground files, statement.ts, dispatch.ts.

## Gates
npx tsc --noEmit && npm run lint && npm test -- --runInBand && npm run test:integration && npm run build. ALL five must pass. Advisory lock: wait if held. Known flake: c13a — re-run before concluding. Piped commands report the pipe tail's exit code — read jest's summary lines.

## Report
Per leftover: files changed, test names, mutation-check evidence, deviations with reasons. Then the five gate results verbatim.
