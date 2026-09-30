1. **MAJOR** — [src/lib/actions/agents.ts:385](/Users/mohsin/Github/safemolt/src/lib/actions/agents.ts:385) classifies a dead challenge from a pre-read.

   The action returns `consumed_challenge` before it calls the decisive completion operation when an owned consumed challenge has an invalid hash. It also returns `invalid_hash` for an owned expired challenge with an invalid hash. This overrides the required decisive outcomes. A vetted agent retrying its own consumed challenge can receive 410 instead of the defined idempotent success.

   Minimal fix: validate the hash early only when the owned challenge is live and unconsumed. For missing, consumed, or expired challenges, call `storeCompleteVetting` and classify only from its outcome flags.

2. **MAJOR** — The required recent-contract tests are absent. See [src/__tests__/lib/actions/evaluations.test.ts:16](/Users/mohsin/Github/safemolt/src/__tests__/lib/actions/evaluations.test.ts:16) and [src/__tests__/api/v1/m11-2-u3e-evaluations-characterization.test.ts:38](/Users/mohsin/Github/safemolt/src/__tests__/api/v1/m11-2-u3e-evaluations-characterization.test.ts:38).

   The action suite does not import or test `startEvaluationWithEffect` or `submitCertificationTranscriptAction`; it tests the memory store operation directly. The route suite does not import the vetting-complete, Cognito-claim, or X-verify routes. It has no certification transcript table for absent, `null`, string, and object inputs. It also has no route cases for each vetting refusal, the lost-response retry, or the live-challenge losing race.

   A regression that converts a string transcript into a 500, collapses a PoAW retry into `none`, or reports a concurrent vetting loser as expired can pass these scoped suites.

   Minimal fix: add the stated action and route tables, and call the public actions and route adapters. Keep the existing store-level C22 tests as lower-level evidence.

3. **MAJOR** — [src/__tests__/api/v1/m11-2-u3e-evaluations-characterization.test.ts:808](/Users/mohsin/Github/safemolt/src/__tests__/api/v1/m11-2-u3e-evaluations-characterization.test.ts:808) does not provide the required denial-parity evidence.

   The five operations are split across two tables. The first table checks only string containment. The second accepts any status of 400 or higher and checks only that serialized output contains `not_found`. It does take full state snapshots, including the event log, but it does not assert exact route status, route code, or tool code per case.

   A route can change from 403 to 404, or a tool can place the expected text in the wrong field, and the table can still pass.

   Minimal fix: use one five-row table. Each row must assert the exact route status, exact route error code, exact tool code, and unchanged full state snapshot for both adapters.

4. **MINOR** — [src/app/api/v1/agents/claim/route.ts:41](/Users/mohsin/Github/safemolt/src/app/api/v1/agents/claim/route.ts:41) does not render the full claim result from the authoritative agent returned by the action.

   The route uses `agent.id` and `agent.name`, but it renders `owner` from the earlier local input at line 44. If storage later normalizes the owner value, the response can report a value different from the saved row.

   Minimal fix: render `owner: agent.owner ?? null`.

Verdict: The event manifests are legal for this slice. The history-only kinds are `none`, `evaluation.completed` remains `legacy`, and all four declared inline-writer anchors have the stated invocation counts. The failure-injection tests use an `AFTER INSERT` event trigger, and the database race tests use concurrent lock contention. However, the decisive vetting classification defect and the missing exact adapter evidence mean that u3e is not ready for approval. I did not modify files or run tests.
