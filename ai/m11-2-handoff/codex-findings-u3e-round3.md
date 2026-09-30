1. **MAJOR — Memory completion checks the actor before it classifies a refused write.**  
   [memory.ts:464](/Users/mohsin/Github/safemolt/src/lib/store/evaluations/memory.ts:464), [evaluations.test.ts:279](/Users/mohsin/Github/safemolt/src/__tests__/lib/actions/evaluations.test.ts:279)

   Failure scenario: an agent withdrawal cascades its registration. A late completion then reaches memory mode. Memory calls `requireAgent` and throws `23503`. PostgreSQL finds no actionable registration, inserts nothing, and returns `not_actionable`. The new test records the incorrect memory result as expected behavior.

   Minimal fix: run `classifyRefusedSave`, challenge classification, and certification classification before the actor and proctor checks. Check agent existence only if the write is still eligible. Change the withdrawal test to expect `not_actionable`.

2. **MAJOR — A valid second vetting completion can overwrite the IDENTITY.md mirror with an identity that did not win.**  
   [route.ts:194](/Users/mohsin/Github/safemolt/src/app/api/v1/agents/vetting/complete/route.ts:194), [db.ts:983](/Users/mohsin/Github/safemolt/src/lib/store/agents/db.ts:983), [memory.ts:860](/Users/mohsin/Github/safemolt/src/lib/store/agents/memory.ts:860)

   Failure scenario: two different valid challenges complete concurrently with identity values `a` and `b`. Both completions correctly consume their challenge. Only the first transition stores its identity in the agent row. The second route still writes its losing request value to the IDENTITY.md context. The database and the memory mirror then disagree. The response can also report `identity_received: true` for content that was not stored.

   Minimal fix: after every `completed` result, reload the agent and pass `fresh.identityMd` to `runPostCommitFollowUps` and `successResponse`. This is already done by `respondIdempotentSuccess`. Add a route test for two challenges with different identity values.

3. **MAJOR — Memory withdrawal does not reproduce two evaluation foreign-key effects.**  
   [memory.ts:656](/Users/mohsin/Github/safemolt/src/lib/store/agents/memory.ts:656), [migrate-multi-agent-sessions.sql:31](/Users/mohsin/Github/safemolt/scripts/migrate-multi-agent-sessions.sql:31), [schema.sql:277](/Users/mohsin/Github/safemolt/scripts/schema.sql:277), [withdrawal-cascade-memory.test.ts:109](/Users/mohsin/Github/safemolt/src/__tests__/lib/store/agents/withdrawal-cascade-memory.test.ts:109)

   Failure scenarios:

   - PostgreSQL deletes every evaluation message sent by the withdrawn agent. Memory deletes only messages in sessions owned by that agent’s registrations. A proctor message in another candidate’s session remains.
   - `evaluation_results.proctor_agent_id` has no delete cascade. PostgreSQL refuses withdrawal when the agent is a recorded proctor. Memory deletes the agent and leaves a dangling proctor ID.

   Minimal fix: before any withdrawal mutation, refuse if a result names the agent as `proctorAgentId`. During the cascade, also delete every message whose `senderAgentId` matches the agent. Add cross-agent proctor tests for both cases.

4. **MAJOR — A certification judge reports a verdict after its fenced completion loses.**  
   [judge.ts:238](/Users/mohsin/Github/safemolt/src/lib/evaluations/judge.ts:238), [judge.ts:314](/Users/mohsin/Github/safemolt/src/lib/evaluations/judge.ts:314), [route.ts:43](/Users/mohsin/Github/safemolt/src/app/api/v1/internal/certification-judging/route.ts:43)

   Failure scenario: a judge lease expires after the model call, and another worker reclaims the job. The stale worker’s folded completion returns `not_actionable`, but `judgeCertificationJob` returns its verdict. The dispatcher counts the job as judged although this worker stored no job transition, result, or event. This also contradicts the function’s documented `null` result for a lost lease.

   Minimal fix: return `null` when the registration is missing or when `saved.outcome !== "created"`. Add a test that reclaims the job between inference and folded completion and checks that the stale worker returns `null`.

5. **MINOR — The required claim event failure-injection test is absent.**  
   [m11-2-u3e-evaluations.test.ts:522](/Users/mohsin/Github/safemolt/src/__tests__/integration/m11-2-u3e-evaluations.test.ts:522), [m11-2-u3e-evaluations.test.ts:552](/Users/mohsin/Github/safemolt/src/__tests__/integration/m11-2-u3e-evaluations.test.ts:552)

   Failure scenario: a future change separates `agent.claimed` from the winner CTE. The concurrency test can still pass, while an event failure leaves a claimed agent without an event or a Cognito ownership link.

   Minimal fix: inject an `agent.claimed` event failure for both Cognito and X claims. Assert that the agent remains unclaimed and that Cognito creates no `user_agents` row.

**Verdict:** u3e preserves the central karma rules: the D4 agent lock remains first and uses `FOR UPDATE`, there is one `buildAgentPointsRecompute`, the writer ownership set is unchanged, and no house-points writer was added. Registration, PoAW consumption, completion event gating, claim winner CTEs, pinned vetting ensure-semantics, manifest declarations, and shared C2 authorization are otherwise correct. However, the four correctness defects above make this unit unsafe to accept yet. `tsc --noEmit --incremental false` and `git diff --check` passed. Jest could not run because the read-only sandbox denied creation of its haste-map cache with `EPERM`.
