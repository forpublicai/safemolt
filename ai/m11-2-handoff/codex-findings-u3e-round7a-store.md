1. **BLOCKER** — [src/lib/store/evaluations/db.ts:503](/Users/mohsin/Github/safemolt/src/lib/store/evaluations/db.ts:503)

   The certification start uses sibling data-changing CTEs for `expired` and `effect`. PostgreSQL does not define their execution order. If `effect` runs before `expired` removes the old pending row from `idx_cert_jobs_live_registration`, the insert raises `23505`. The complete transaction then rolls back. A registration with a lapsed nonce can therefore fail to restart.

   Minimal fix: make the certification effect one ordered operation. For example, use a conditional upsert that refreshes only an expired pending job, and gate the registration CAS and event on that effect’s `RETURNING`. Do not use unordered sibling update and insert operations for the same partial unique index.

2. **BLOCKER** — [src/lib/store/evaluations/db.ts:654](/Users/mohsin/Github/safemolt/src/lib/store/evaluations/db.ts:654)

   Completion locks only the candidate agent before it locks the registration. The result insert later takes an implicit foreign-key lock on `proctor_agent_id` at [src/lib/store/evaluations/db.ts:797](/Users/mohsin/Github/safemolt/src/lib/store/evaluations/db.ts:797). Proctor claim locks both candidate and proctor agents in ID order before the registration at [src/lib/store/evaluations/db.ts:392](/Users/mohsin/Github/safemolt/src/lib/store/evaluations/db.ts:392).

   Concrete cycle: the proctor ID sorts first. A claim locks the proctor and waits for the candidate. A completion holds the candidate and registration, then waits for the proctor foreign-key lock. PostgreSQL detects `40P01`, and one request fails.

   Minimal fix: the D4 completion’s first batch element must lock both `row.agentId` and `row.proctorAgentId`, when supplied, in agent-ID order. It must do this before the certification job, registration, or session locks.

3. **MAJOR** — [src/lib/store/evaluations/memory.ts:458](/Users/mohsin/Github/safemolt/src/lib/store/evaluations/memory.ts:458)

   The certification start changes an old pending job to `expired`. If event dispatch then fails, the catch deletes only the new job. It does not restore the old job. The database transaction restores both rows, but memory mode permanently loses the old live state.

   The catch can also delete a pre-existing job when `createCertificationJobSync` returns that job instead of inserting one.

   Minimal fix: record whether a new job was inserted, snapshot the old job and registration, and restore all changed state on failure. Delete only an ID that this call created. Apply the same snapshot rule to the PoAW challenge collision case.

4. **MAJOR** — [src/lib/store/evaluations/memory.ts:463](/Users/mohsin/Github/safemolt/src/lib/store/evaluations/memory.ts:463)

   If a registered registration already has an unexpired pending, submitted, or judging job, `createCertificationJobSync` returns it. Memory mode then changes the registration to `in_progress` and emits `evaluation.started`. The database attempts a new insert, hits the live-job unique index, and rolls the transaction back.

   This state can exist during a mixed-version deployment or after an older multi-step start fails between writes.

   Minimal fix: classify an existing non-expired live job before any mutation. Make both stores return the same no-write result. Do not treat an ensured existing job as the new effect for a fresh start event.

5. **MAJOR** — [src/lib/store/agents/memory.ts:342](/Users/mohsin/Github/safemolt/src/lib/store/agents/memory.ts:342)

   `claimAgentForHumanUserWithOutcome` calculates `agentExists` before it calls the async claim function. The human-user lookup inside that function yields. A stale-name cleanup or withdrawal can remove the agent during that interval. The inner claim returns null, but the wrapper still returns `agentExists: true`. The database projects existence and the claim from one locked target.

   Minimal fix: move existence, claimed-state, and returned-agent projection into one post-await synchronous section. Return an `AgentClaimOutcome` directly from that section.

6. **MAJOR** — [src/lib/store/agents/memory.ts:327](/Users/mohsin/Github/safemolt/src/lib/store/agents/memory.ts:327)

   The Cognito claim changes the agent and adds the human ownership link before it awaits event dispatch. It has no rollback. If dispatch fails, memory mode leaves the agent claimed and owned, while the database statement rolls back the claim, ownership link, and event together. A retry then reports “already claimed” without the required event.

   Minimal fix: snapshot the agent and ownership-link state, and restore both if dispatch fails. Use the same rollback structure already present in `setAgentClaimedWithOutcome`.

7. **MINOR** — [src/lib/store/agents/memory.ts:935](/Users/mohsin/Github/safemolt/src/lib/store/agents/memory.ts:935)

   Memory vetting accepts a challenge when `expiresAt === Date.now()`, because it rejects only `<`. PostgreSQL requires `expires_at > NOW()` and rejects equality. A frozen-clock request can therefore complete and consume a challenge only in memory mode.

   Minimal fix: change the memory expiry refusal to `<= Date.now()`.

Verdict: u3e is not ready because the certification restart can fail on its own partial unique index, and proctor claim can deadlock with completion. The memory store also has material transaction and outcome differences in certification start and Cognito claim. The karma writer set is unchanged: the two evaluation recomputes remain the listed component-aware writers, `toAwardedPoints` remains in use, and I found no house-points write in scope. The named result-uniqueness filter in `completeRegistrationAtomically` correctly rethrows `idx_events_idem` and other unrelated `23505` errors. I did not run tests or modify files.
