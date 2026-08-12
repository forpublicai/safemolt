1. **MAJOR** — The nonce-lapse test asserts the wrong event behavior.  
   [evaluations.test.ts](/Users/mohsin/Github/safemolt/src/__tests__/lib/actions/evaluations.test.ts:263) seeds the registration as `registered`, then expects one `evaluation.started` event at line 281. A valid lapsed-nonce refresh starts from an `in_progress` registration and must refresh the same job without an event. This fixture tests an inconsistent hybrid state and does not pin the stated C22 contract.  
   Failure scenario: the refresh arm incorrectly emits `evaluation.started`, but this gate still passes.  
   Minimal fix: seed the registration as `in_progress`, assert the same job ID and new nonce, and assert zero new events.

2. **MAJOR** — The C22 action behavior is tested through the store instead of the public action.  
   The suite imports the memory store operation directly at [evaluations.test.ts](/Users/mohsin/Github/safemolt/src/__tests__/lib/actions/evaluations.test.ts:50), and the lapse and decided-job cases call it directly at lines 272 and 293. The only public `startEvaluationWithEffect` case tests initial PoAW creation at line 303.  
   Failure scenario: the action can map `refreshed` or `existing_job` to `none`, use a newly generated job, or return the wrong effect, while all C22 tests pass.  
   Minimal fix: drive the lapse and decided-job cases through `startEvaluationWithEffect`, then assert the authoritative job in the returned certification effect. Keep direct store tests only as lower-level coverage.

3. **MAJOR** — The claimed lifecycle route characterization evidence is absent.  
   The characterization suite only checks unauthenticated Cognito claim and missing X claim at [m11-2-u3e-evaluations-characterization.test.ts](/Users/mohsin/Github/safemolt/src/__tests__/api/v1/m11-2-u3e-evaluations-characterization.test.ts:216). Its vetting-complete coverage contains success only at line 272. There are no route cases for `challenge_not_found`, `challenge_mismatch`, `expired_challenge`, `consumed_challenge`, or `invalid_hash`. There is also no successful Cognito claim assertion that pins `owner` from `claimed.data.agent`, and no successful X verification route case.  
   Failure scenario: a refusal can regress from 410 to 400, use the wrong legacy title, or the Cognito response can render stale owner data without failing this suite.  
   Minimal fix: add a table that calls the real vetting-complete route for every refusal reason and checks exact status and title. Add successful Cognito and X route cases, including the returned owner.

4. **MAJOR** — The route-versus-tool race does not validate either adapter response.  
   At [m11-2-u3e-evaluations.test.ts](/Users/mohsin/Github/safemolt/src/__tests__/integration/m11-2-u3e-evaluations.test.ts:632), each response is reduced to a boolean. Line 659 only checks that both values are booleans. It does not check their values or refusal codes.  
   Failure scenario: the route commits and then returns 500, while the losing tool returns an incorrect refusal. The test still sees two booleans, one result, and one event, so it passes.  
   Minimal fix: retain the full route response and tool result. Assert that the route returns the legal 200 response and that the tool returns either the winning success shape or the exact legal `registration_already_complete` loser shape.

Verdict: I found no action, adapter, or event-manifest legality defect in the reviewed code. The history-only manifests are `none`, `evaluation.completed` remains `legacy`, all four declared inline-writer counts match, and Tier B challenge fetches remain event-less. However, four required evidence contracts are not delivered or are too weak. I would not accept u3e as fully reviewed until these tests are corrected. I did not run tests or modify files.
