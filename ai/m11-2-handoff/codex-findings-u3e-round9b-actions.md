## Findings

1. **MAJOR** — The start action does not fully consume the discriminated store outcome.  
   [evaluations.ts](/Users/mohsin/Github/safemolt/src/lib/actions/evaluations.ts:338), [evaluations.ts](/Users/mohsin/Github/safemolt/src/lib/actions/evaluations.ts:359)

   The PoAW branch tests only `started.challenge`. The certification branch tests only `started.certificationJob`. Both map every outcome without that optional field to `standard`. Thus, `{ kind: "none" }` becomes a successful standard start. A race that makes the conditional operation return `none` can make the route say “Evaluation started” although it created no challenge, job, transition, or event. This is also not an exhaustive use of `created | existing_challenge | existing_job | refreshed | none`.

   Minimal fix: switch exhaustively on `started.kind`. For PoAW, return only `created` or `existing_challenge` with the authoritative challenge. For certification, return `created`, `refreshed`, or `existing_job` with the authoritative job. Render `none` as a defined no-effect outcome or refusal, never as `standard`.

2. **MAJOR** — Vetting completion still classifies from a challenge pre-read and returns a refused decisive outcome as success.  
   [agents.ts](/Users/mohsin/Github/safemolt/src/lib/actions/agents.ts:385), [agents.ts](/Users/mohsin/Github/safemolt/src/lib/actions/agents.ts:393), [route.ts](/Users/mohsin/Github/safemolt/src/app/api/v1/agents/vetting/complete/route.ts:111), [evaluations.test.ts](/Users/mohsin/Github/safemolt/src/__tests__/lib/actions/evaluations.test.ts:716)

   The action returns before the decisive operation for missing, mismatched, consumed, and expired challenges. After the operation, it wraps `unavailable` in `actionOk`, so the route must classify raw store reasons. A lost-response retry after challenge cleanup can return `challenge_not_found`, although the decisive agent/challenge outcome can be `already_vetted`. The scoped action test explicitly pins `unavailable` as `ok: true`, which is the old contract.

   Minimal fix: use the conditional completion outcome as the classification authority. Keep hash validation in the action, map every decisive flag to a structured action refusal, and return `ok: true` only for completion or its defined idempotent success. Update the action and integration assertions accordingly.

3. **MAJOR** — The route-versus-tool race test has an invalid success-count assertion and can be schedule-dependent.  
   [m11-2-u3e-evaluations.test.ts](/Users/mohsin/Github/safemolt/src/__tests__/integration/m11-2-u3e-evaluations.test.ts:632), [route.ts](/Users/mohsin/Github/safemolt/src/app/api/v1/evaluations/[id]/proctor/submit/route.ts:89), [evaluations.ts](/Users/mohsin/Github/safemolt/src/lib/agent-tools/definitions/evaluations.ts:398)

   The test requires exactly one adapter to report success. If the tool writes first, it reports success and the losing route can render `already_complete` as idempotent HTTP 200. Both adapters then report success, although only one result and event exist. The opposite schedule produces one success.

   Minimal fix: do not assert exactly one transport success. Assert one stored result, one `evaluation.completed` event, and valid adapter responses for both possible winners.

4. **MAJOR** — The negative-authorization parity table does not prove the stated no-mutation contract.  
   [m11-2-u3e-evaluations-characterization.test.ts](/Users/mohsin/Github/safemolt/src/__tests__/api/v1/m11-2-u3e-evaluations-characterization.test.ts:793)

   Registration and start only check that serialized responses contain text. They do not snapshot state. The other three rows snapshot four domain maps but omit `eventLog`. A denied adapter that emits a ghost event would pass. A denied registration or start that mutates state would also pass the first table.

   Minimal fix: use one table for all five operations. Before each route and tool call, snapshot every applicable map and `eventLog`. Assert the exact denial code and unchanged state after each adapter separately.

5. **MAJOR** — The scoped conditional-start tests do not pin the two required C22 outcomes.  
   [m11-2-u3e-evaluations.test.ts](/Users/mohsin/Github/safemolt/src/__tests__/integration/m11-2-u3e-evaluations.test.ts:352), [m11-2-u3e-evaluations.test.ts](/Users/mohsin/Github/safemolt/src/__tests__/integration/m11-2-u3e-evaluations.test.ts:382)

   The first test covers a fresh job and a basic repeat. The held-lock test covers a live pending winner. No scoped test proves:

   - An expired pending nonce refreshes the same job row without a second row or event.
   - A submitted, judging, or completed job is returned unchanged without a new paid attempt.

   A regression that inserts a second job or rejudges a decided job can pass the current scoped suite.

   Minimal fix: add the two C22 cases. Assert row identity, nonce behavior, job count, status, and zero additional `evaluation.started` events.

6. **MINOR** — Certification refusal-title rendering is not exhaustive, and the scoped tests do not pin malformed transcript inputs.  
   [route.ts](/Users/mohsin/Github/safemolt/src/app/api/v1/evaluations/[id]/submit/route.ts:32), [types.ts](/Users/mohsin/Github/safemolt/src/lib/actions/types.ts:33)

   `titleByReason` is `Record<string, string>` with a fallback. TypeScript cannot report a missing reason. A new or misspelled reason silently becomes “Submission rejected.” The scoped tests contain no route case for string or object transcripts, nor exact assertions for “Missing transcript” versus “Submission rejected.”

   Minimal fix: export a certification-refusal reason union and use an exhaustive switch with a `never` check. Add absent/null, string, and object route cases.

## Verdict

The event kinds and manifests are legal: the nine history-only kinds are `none`, `evaluation.completed` is `legacy`, and all four declared inline-writer counts match. The deprecation object also has the required shape and keeps enforcement at M11b. However, the start-outcome mapping, vetting classification, and several required evidence gates are not complete. I would not approve u3e until the major findings are fixed. I did not run tests or modify files.
