1. **BLOCKER** — Certification restart bypasses the operation that owns nonce expiry and reissue. [evaluations.ts](/Users/mohsin/Github/safemolt/src/lib/actions/evaluations.ts:378)

   After the first start, the registration is `in_progress`. When its pending nonce expires, the next start skips `startEvaluationWithEffect` because the action calls it only for a `registered` row. Lines 387–390 then return the expired job. The agent cannot get a new nonce and the certification is permanently blocked. The PoAW branch has a related problem at line 352: a retry returns a generic result and loses access to the existing challenge.

   Minimal fix: call the conditional start operation for certification without the adapter-side status guard. Make its outcome return the authoritative existing, decided, or reissued job. For PoAW, return the existing challenge after a losing CAS.

2. **MAJOR** — The certification submit adapter validates and transforms the transcript before the action. [route.ts](/Users/mohsin/Github/safemolt/src/app/api/v1/evaluations/[id]/submit/route.ts:32)

   If `transcript` is a string or object, `normalizeTranscript()` calls `.map()` and throws. The route returns 500. Before u3e, this input returned the documented 400. A missing transcript also now gets the title `Submission rejected`, not `Missing transcript`, because the route derives the title from message text at lines 34–37.

   Minimal fix: pass `transcript` as `unknown` to the action. Validate and normalize it there. Return a structured refusal reason so the adapter can render the exact existing title and status without message-text matching.

3. **MAJOR** — The claimed negative-authorization parity gate is incomplete. [m11-2-u3e-evaluations-characterization.test.ts](/Users/mohsin/Github/safemolt/src/__tests__/api/v1/m11-2-u3e-evaluations-characterization.test.ts:793)

   The table covers only registration and start. It does not compare route and tool denials for proctor claim, session message, or proctor submission. For example, either session-message adapter could stop calling the shared C2 authorization function, and this parity table would still pass.

   Minimal fix: add one negative authorization row for every applicable route/tool pair: registration, start, proctor claim, session message, and proctor submission. Assert the expected code and confirm that no mutation occurred.

4. **MAJOR** — Vetting completion can report an unexpired challenge as expired. [route.ts](/Users/mohsin/Github/safemolt/src/app/api/v1/agents/vetting/complete/route.ts:179)

   An agent can hold two valid challenges. If concurrent completions use both, one vets the agent. The other action returns `unavailable`. Its challenge is still live, owned, unconsumed, and hash-valid, so `classifyUnavailable()` returns `null`. Lines 185–190 then report `Challenge expired`, although expiry was not the decisive reason. The action currently returns the store outcome without classification. [agents.ts](/Users/mohsin/Github/safemolt/src/lib/actions/agents.ts:382)

   Minimal fix: make the decisive outcome distinguish `already_vetted`, challenge expiry, mismatch, and consumption. Classify these flags in the action, then let the route render them. Do not infer the cause from later reads.

Verdict: u3e has correct event manifest states: history-only kinds are `none`, `evaluation.completed` remains `legacy`, and all four declared inline-writer anchors exist. The deprecation object also has the required shape and keeps enforcement at `M11b`. However, the certification nonce-lapse defect is release-blocking. The transcript adapter, vetting refusal classification, and incomplete authorization-parity evidence also need correction. I did not run tests or modify files.
