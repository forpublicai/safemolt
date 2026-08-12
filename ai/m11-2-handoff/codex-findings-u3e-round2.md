## Findings

1. **BLOCKER — A certification job can complete without a result.**  
   [src/lib/store/evaluations/db.ts:690](/Users/mohsin/Github/safemolt/src/lib/store/evaluations/db.ts:690)

   Failure scenario: `certification` changes the job to `completed` before `transitioned` proves that the registration is actionable. If the registration is already terminal, `transitioned` and `inserted` return no rows, but the certification update still commits. The job is then terminal, no result or `evaluation.completed` event exists, and a retry cannot recover it. The memory store does not have this behavior because it classifies the registration before it changes the job at [memory.ts:474](/Users/mohsin/Github/safemolt/src/lib/store/evaluations/memory.ts:474). The current failure test at [m11-2-u3e-evaluations.test.ts:619](/Users/mohsin/Github/safemolt/src/__tests__/integration/m11-2-u3e-evaluations.test.ts:619) only tests a transaction exception. It does not test a zero-row registration transition.

   Minimal fix: use a token-fenced, read-only job CTE as the registration gate. Insert the result from the registration transition. Then update the certification job from `inserted`, so the job can complete only when the result exists. Add a test with a valid judging token and a terminal registration. Assert that the job stays `judging` and that no result or event exists.

2. **BLOCKER — Vetting effects are not gated on the successful unvetted decision.**  
   [src/lib/store/agents/db.ts:982](/Users/mohsin/Github/safemolt/src/lib/store/agents/db.ts:982), [src/lib/store/agents/db.ts:1045](/Users/mohsin/Github/safemolt/src/lib/store/agents/db.ts:1045), [src/lib/store/agents/db.ts:1100](/Users/mohsin/Github/safemolt/src/lib/store/agents/db.ts:1100), [src/lib/store/agents/db.ts:1118](/Users/mohsin/Github/safemolt/src/lib/store/agents/db.ts:1118)

   Failure scenario: an unvetted agent has two valid challenges. The first transaction vets the agent and consumes the first challenge. The second transaction then gets the agent lock. Its `vetted` CTE returns no row, but its bootstrap statements, points update, and challenge consumption are gated only on the second live challenge. The second challenge is consumed, and the function reports `completed`, although that call did not win the vetted transition. Memory mode instead returns early and does not consume the second challenge at [memory.ts:831](/Users/mohsin/Github/safemolt/src/lib/store/agents/memory.ts:831). This is a DB/memory difference. The integration test at [m11-2-u3e-evaluations.test.ts:864](/Users/mohsin/Github/safemolt/src/__tests__/integration/m11-2-u3e-evaluations.test.ts:864) hides it because it counts only completed outcomes that contain bootstrap rows.

   Minimal fix: create the required token-stamped decision from the locked `is_vetted = false` transition. Gate both bootstrap statements, the later points recompute, and challenge consumption on that token. A losing call must return `unavailable` and leave its challenge unconsumed. Update the DB and memory tests to require exactly one total `completed` outcome and to check both challenge rows.

3. **MAJOR — Memory Cognito claim exposes a claimed agent before it records its owner.**  
   [src/lib/store/agents/memory.ts:287](/Users/mohsin/Github/safemolt/src/lib/store/agents/memory.ts:287)

   Failure scenario: memory mode sets `isClaimed`, appends `agent.claimed`, and then crosses two `await` points before `linkUserToAgent` runs at line 291. During that interval, another request can see a claimed agent for which `userOwnsAgent` is false. This is the claimed-but-unlinked state that the PostgreSQL winner CTE prevents. A future error in event dispatch or ownership linking would also make the state permanent. The required claim failure-injection test is absent; the current test only checks concurrent winners at [m11-2-u3e-evaluations.test.ts:522](/Users/mohsin/Github/safemolt/src/__tests__/integration/m11-2-u3e-evaluations.test.ts:522).

   Minimal fix: add a synchronous memory ownership-link operation and perform the agent change, ownership link, and event append in one no-`await` section after full preflight. Add failure injection for the PostgreSQL `user_agents` insert and a memory observation test that cannot see a claimed-but-unlinked state.

4. **MAJOR — The evaluation start route is not an adapter and creates eventless durable rows.**  
   [src/app/api/v1/evaluations/[id]/start/route.ts:5](/Users/mohsin/Github/safemolt/src/app/api/v1/evaluations/%5Bid%5D/start/route.ts:5), [src/app/api/v1/evaluations/[id]/start/route.ts:98](/Users/mohsin/Github/safemolt/src/app/api/v1/evaluations/%5Bid%5D/start/route.ts:98), [src/app/api/v1/evaluations/[id]/start/route.ts:102](/Users/mohsin/Github/safemolt/src/app/api/v1/evaluations/%5Bid%5D/start/route.ts:102)

   Failure scenario: a repeated PoAW start loses the registration CAS, so no `evaluation.started` event is emitted. The route ignores that result and directly creates another durable challenge. A crash after the CAS but before challenge or certification-job creation also leaves a partial start. These are agent-visible Tier 1 mutations outside the action layer. Recording this deviation in the inventory does not satisfy the binding u3e adapter requirement.

   Minimal fix: add a route-specific action or domain operation that owns the start transition and its PoAW or certification effect. It must preserve the current route response and certification idempotency. The route must only parse, call that operation, and render the result.

5. **MAJOR — Memory withdrawal leaves evaluation rows for a deleted agent.**  
   [src/lib/store/agents/memory.ts:300](/Users/mohsin/Github/safemolt/src/lib/store/agents/memory.ts:300)

   Failure scenario: an agent with registrations, results, or certification jobs withdraws in memory mode. `deleteAgent` deletes the agent but does not remove those evaluation maps. PostgreSQL removes candidate-owned registrations, results, participants, and certification jobs through the foreign keys at [scripts/schema.sql:260](/Users/mohsin/Github/safemolt/scripts/schema.sql:260), [scripts/schema.sql:276](/Users/mohsin/Github/safemolt/scripts/schema.sql:276), and [scripts/schema.sql:319](/Users/mohsin/Github/safemolt/scripts/schema.sql:319). Memory reads can therefore return passed evaluations and jobs for an agent that no longer exists. The new withdrawal test checks notifications and stale registration concurrency, but it does not check the evaluation cascade.

   Minimal fix: add one evaluation-memory cascade helper and call it before deleting the agent. Remove registrations, dependent results, participants, certification jobs, and applicable session data in foreign-key order. Add a parity test with both active and completed evaluation data.

6. **MINOR — Memory registration preflights the two event statements as separate batches.**  
   [src/lib/store/agents/memory.ts:35](/Users/mohsin/Github/safemolt/src/lib/store/agents/memory.ts:35), [src/lib/store/agents/memory.ts:76](/Users/mohsin/Github/safemolt/src/lib/store/agents/memory.ts:76)

   Failure scenario: an expiry event and the registered event use the same `idemKey`. Both independent preflights can succeed against an unchanged event log. Memory then performs the stale deletion and insert and appends both duplicate keys. PostgreSQL inserts statement 1, rejects statement 2 on uniqueness, and rolls back the transaction. Current action-generated events do not use keys, but this breaks the required whole-batch memory invariant.

   Minimal fix: substitute all released-agent subjects and the new agent subject first. Pass the combined ordered event list through one `prepareEventBatch`, then perform the mutations and append once.

**Verdict:** u3e is not ready to merge. The karma writer inventory remains unchanged, `buildAgentPointsRecompute` is still the single prepared recompute, `toAwardedPoints` remains in place, and I found no house-points writer. The PoAW executor error check and normal failure rollback are also present. However, the certification zero-row path and the missing vetting decision token violate the main atomicity rules. The memory claim and withdrawal differences add significant lifecycle risk.
