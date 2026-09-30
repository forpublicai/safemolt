1. **BLOCKER** — The conditional start contract is incomplete. [evaluations.ts](/Users/mohsin/Github/safemolt/src/lib/actions/evaluations.ts:351) maps a PoAW retry with no returned challenge to `standard` at line 362. The route then returns the generic “Evaluation started” body instead of the existing challenge. The certification branch also performs a second read at lines 380–385 when the conditional operation returns no job. That read is outside the authoritative operation.

   Failure scenario: an agent retries PoAW after the first start response is lost. The registration is already `in_progress`, so the action returns `standard`. The agent gets no challenge and cannot continue, although the original challenge exists. A certification fallback read can also observe a job that was changed after the conditional operation.

   Minimal fix: make the conditional start operation return a discriminated authoritative result for every arm: created effect, existing PoAW challenge, existing live or decided certification job, refreshed lapsed nonce job, or no applicable effect. Remove the follow-up certification read and the PoAW-to-`standard` fallback. Add route-level retry assertions for the same PoAW challenge.

2. **MAJOR** — Vetting proof validation and refusal classification remain in the route instead of the action. The exported action accepts no submitted hash and passes the challenge ID directly to the store in [agents.ts](/Users/mohsin/Github/safemolt/src/lib/actions/agents.ts:348). It then wraps every decisive outcome in `actionOk` at line 388. The route performs hash validation and challenge classification through pre-reads and post-reads in [route.ts](/Users/mohsin/Github/safemolt/src/app/api/v1/agents/vetting/complete/route.ts:23) and lines 163–190.

   Failure scenario: another caller of `completeVetting` can vet an agent with only a challenge ID, without proof of the hash. Also, a challenge can expire between the decisive statement and the route’s re-read. The route can then report `expired` although the decisive outcome was `already_vetted`, `mismatch`, or `consumed`.

   Minimal fix: pass the hash into the action. Move proof validation and outcome classification into the action. Render the action’s structured result in the route without reading the challenge again. Keep post-commit memory and group follow-ups outside the decisive write.

3. **MAJOR** — Invalid certification transcript types receive the wrong structured reason, and the route still matches message text. In [evaluations.ts](/Users/mohsin/Github/safemolt/src/lib/actions/evaluations.ts:395), any non-array value becomes `undefined`, then an empty array, and finally `missing_transcript` at line 422. In [submit/route.ts](/Users/mohsin/Github/safemolt/src/app/api/v1/evaluations/[id]/submit/route.ts:32), most legacy titles still depend on `message.toLowerCase()` and substring checks.

   Failure scenario: `transcript: "text"` or `transcript: {}` returns HTTP 400, but it is classified as missing and rendered as `Missing transcript`. A supplied value with the wrong type must be `invalid_transcript` and render `Submission rejected`. A later wording change can also silently change nonce-related titles.

   Minimal fix: classify non-null, non-array transcripts as `invalid_transcript`. Add structured reasons for every certification refusal and use an exhaustive reason-to-title switch in the route. Do not inspect message text.

4. **MAJOR** — Evaluation registration still has a pre-read race and DB/memory result drift. [evaluations.ts](/Users/mohsin/Github/safemolt/src/lib/actions/evaluations.ts:231) reads the current registration, then separately inserts at lines 244–253.

   Failure scenario: a route and tool register the same agent concurrently. Both pre-reads can see no active registration. PostgreSQL lets one insert win and can raise a unique violation for the other, which becomes a 500. Memory mode can return the winner’s row from the store, but the action reports it as a fresh registration with `alreadyRegistered: false`.

   Minimal fix: use one conditional store outcome that distinguishes `created`, `existing`, and `already_passed`. Classify only from that outcome and return the authoritative existing row on a race.

5. **MAJOR** — A vetting race test asserts the old behavior that the recent contract rejects. [m11-2-u3e-evaluations.test.ts](/Users/mohsin/Github/safemolt/src/__tests__/integration/m11-2-u3e-evaluations.test.ts:1084) expects both concurrent completions with different challenges to return `completed` and both challenges to be consumed at lines 1095–1102. Only one `agent.vetted` event is expected.

   Failure scenario: the losing request is treated as a successful completion although its decisive result should be `already_vetted`. This test will reject the required outcome classification and preserve the action’s current “all outcomes are success” behavior.

   Minimal fix: expect one completed outcome and one authoritative `already_vetted` refusal. Assert that the loser is not reported as expired. Assert the intended challenge-consumption state from the decisive result.

6. **MINOR** — The named test evidence does not deliver all claimed recent gates. The start tests in [evaluations.test.ts](/Users/mohsin/Github/safemolt/src/__tests__/lib/actions/evaluations.test.ts:196) and [m11-2-u3e-evaluations.test.ts](/Users/mohsin/Github/safemolt/src/__tests__/integration/m11-2-u3e-evaluations.test.ts:332) do not test lapsed-nonce in-place refresh or return of a decided certification job. The negative-authorization table in [m11-2-u3e-evaluations-characterization.test.ts](/Users/mohsin/Github/safemolt/src/__tests__/api/v1/m11-2-u3e-evaluations-characterization.test.ts:793) does not assert response status or unchanged state for registration and start; those checks exist only for the later three cases.

   Failure scenario: a regression can create a second certification row, replace a decided job, or mutate during a denied registration/start while all named tests remain green.

   Minimal fix: add the two explicit C22 store-operation tests. Extend each negative-parity row to assert the exact route code, tool code, and unchanged registrations, sessions, messages, results, challenges, jobs, and events.

Verdict: the event vocabulary and manifests are legal. The nine history-only kinds are `none` everywhere, `evaluation.completed` remains `legacy` only for activity-trail, and all four declared legacy-writer patterns match once. The deprecation object also has the required shape and keeps enforcement at `M11b`. However, the recent start and vetting contracts are not fully delivered, and one race test actively pins the wrong vetting outcome. I would not accept u3e until findings 1–5 are fixed. I did not run any tests or builds.
