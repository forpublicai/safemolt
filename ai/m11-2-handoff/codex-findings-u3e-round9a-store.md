1. **BLOCKER** — Certification start does not implement its outcome state machine. [db.ts:536](/Users/mohsin/Github/safemolt/src/lib/store/evaluations/db.ts:536), [db.ts:554](/Users/mohsin/Github/safemolt/src/lib/store/evaluations/db.ts:554), [db.ts:583](/Users/mohsin/Github/safemolt/src/lib/store/evaluations/db.ts:583)

   Failure scenario: A `registered` registration already has a valid pending job. `effect` writes nothing, and `started` requires a row from `effect`. The registration stays `registered`, `evaluation.started` is not emitted, and the function returns `existing_job` with `started: false`. The pinned contract requires the CAS, event, and reuse of that job. The function also reports a created or refreshed job as `existing_job` when the registration is already `in_progress`. It never returns `refreshed`. Finally, the separate read at line 583 can return a different job or no job after the transaction already committed.

   Minimal fix: Project the selected job and an arm label from the conditional SQL operation. Let the registration CAS use either a new/refreshed job or a reusable live job. Return `created`, `refreshed`, or `existing_job` from that projection. Remove the post-transaction job read.

2. **MAJOR** — A PoAW retry can return different challenges in memory and PostgreSQL. [memory.ts:439](/Users/mohsin/Github/safemolt/src/lib/store/evaluations/memory.ts:439), [db.ts:513](/Users/mohsin/Github/safemolt/src/lib/store/evaluations/db.ts:513)

   Failure scenario: An agent has two valid unconsumed challenges. PostgreSQL selects the newest challenge with `ORDER BY created_at DESC`. Memory uses `Array.find` and returns the oldest inserted challenge. The same retry therefore receives a different nonce based on the store. Also, with a `registered` registration and an existing challenge, PostgreSQL reuses it while memory creates another challenge.

   Minimal fix: Implement one shared state rule. In memory, select the newest valid challenge. Make the `registered` arm either reuse or create in both stores according to the pinned rule.

3. **MAJOR** — Evaluation registration is not a safe conditional outcome under concurrency. [db.ts:84](/Users/mohsin/Github/safemolt/src/lib/store/evaluations/db.ts:84), [db.ts:90](/Users/mohsin/Github/safemolt/src/lib/store/evaluations/db.ts:90), [db.ts:98](/Users/mohsin/Github/safemolt/src/lib/store/evaluations/db.ts:98)

   Failure scenario: Two calls register the same agent for the same evaluation. Both statement snapshots can see no active registration. One insert wins, but the other gets `23505` from `idx_eval_reg_active`; it does not return `existing`. A second divergence occurs when a passed result and a slipped-through active registration coexist: PostgreSQL returns `existing`, while memory checks the pass first and returns `already_passed`. PostgreSQL also returns empty required identifiers for `already_passed`, while memory returns the real registration identifiers.

   Minimal fix: Lock the agent in the first transaction statement. Run the conditional outcome statement after that lock, with a fresh snapshot. Give the passed-result arm priority over the active-registration arm, and project the real prior registration data.

4. **MAJOR** — The memory Cognito claim checks the human user before it classifies a gated refusal. [memory.ts:350](/Users/mohsin/Github/safemolt/src/lib/store/agents/memory.ts:350), [memory.ts:326](/Users/mohsin/Github/safemolt/src/lib/store/agents/memory.ts:326)

   Failure scenario: The claim token is unknown or already claimed, and the human-user row is absent. PostgreSQL writes no `user_agents` row, so the foreign key is not checked; it returns `agentExists: false` or `claimed: false`. Memory throws for the absent human user before it resolves the token. This can turn a normal refusal into a 500.

   Minimal fix: Read the human row, but defer its error. After the last `await`, resolve the token and classify missing/already-claimed outcomes in one synchronous section. Check the human result only when the claim is eligible to write.

5. **MINOR** — Claim rollback does not restore the original ownership role. [memory.ts:331](/Users/mohsin/Github/safemolt/src/lib/store/agents/memory.ts:331), [memory.ts:341](/Users/mohsin/Github/safemolt/src/lib/store/agents/memory.ts:341)

   Failure scenario: A user already has a `public_ai` link to the agent. If claim event dispatch fails, PostgreSQL rollback preserves `public_ai`. Memory records only a boolean and restores the link as `owner`. `getPublicAiAgentIdForUser` can then stop finding the agent.

   Minimal fix: Snapshot the exact prior role, not only whether a link exists. Restore that exact role after failure.

Verdict: u3e store-layer delivery is not ready because the main certification-start contract is incomplete. Registration and claim paths also have concrete PostgreSQL/memory divergence. I found no new karma writer, no points/component split on a normal completed path, and no house-points write. The declared lock order in completion, proctor claim, and session-message insertion is consistent. I did not run tests or builds and did not modify files.
