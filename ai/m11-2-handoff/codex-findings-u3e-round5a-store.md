1. **MAJOR** — [agents/memory.ts:30](/Users/mohsin/Github/safemolt/src/lib/store/agents/memory.ts:30), [agents/memory.ts:77](/Users/mohsin/Github/safemolt/src/lib/store/agents/memory.ts:77) — Stale-name replacement does not match PostgreSQL foreign-key behavior.  
   Failure scenario: Agent B follows an old, unclaimed, inactive Agent A. A new registration requests A’s name. PostgreSQL cannot delete A because `following.followee_id` has no cascade. The complete registration transaction rolls back. Memory mode deletes A, creates the replacement, emits the expiration event, and leaves the follow edge with an invalid agent ID.  
   Minimal fix: Before any memory mutation, check every non-cascading agent reference that PostgreSQL checks. Return the same `23503` failure when one exists. Do not delete, insert, or emit in that case.

2. **MAJOR** — [evaluations/memory.ts:82](/Users/mohsin/Github/safemolt/src/lib/store/evaluations/memory.ts:82) — The empty-store exception disables the withdrawal race check.  
   Failure scenario: The only agent starts an evaluation registration request. The request yields before the store call, and withdrawal removes that agent. `agents.size` is then zero, so `requireAgent()` accepts the deleted actor and creates a registration that PostgreSQL rejects through `evaluation_registrations.agent_id`.  
   Minimal fix: Remove the `agents.size === 0` exception. Fixtures that create evaluation rows without agents must create their required agent records.

3. **MAJOR** — [judge.ts:314](/Users/mohsin/Github/safemolt/src/lib/evaluations/judge.ts:314) — A certification job can stay live forever after another completion wins.  
   Failure scenario: The judge owns a valid lease while another route completes the registration. The fenced completion returns `already_complete`. The judge returns without making its certification job terminal. Reclaim later changes the job back to `submitted`, and the system can pay for the same judging work again. This cycle can repeat.  
   Minimal fix: Under the same job lock and token fence, make the job terminal when a standing registration result prevents insertion. This can be a `completed` or explicit superseded/failed transition. Apply the same rule in memory mode.

4. **MAJOR** — [evaluations/db.ts:293](/Users/mohsin/Github/safemolt/src/lib/store/evaluations/db.ts:293), [evaluations/db.ts:304](/Users/mohsin/Github/safemolt/src/lib/store/evaluations/db.ts:304) — DB mode returns `"undefined"` as the accepted session-message role.  
   Failure scenario: A valid participant inserts a message. The `inserted` CTE returns `role`, but the final query selects only `sequence` and `created_at`. `String(row.role)` therefore returns `"undefined"`. Memory mode returns the participant’s real role. The stored DB row is correct, but the successful response is not.  
   Minimal fix: Add `role` to `SELECT sequence, created_at FROM inserted`.

5. **MINOR** — [agents/memory.ts:27](/Users/mohsin/Github/safemolt/src/lib/store/agents/memory.ts:27), [agents/memory.ts:73](/Users/mohsin/Github/safemolt/src/lib/store/agents/memory.ts:73) — Memory mode silently drops all but the first registration-expiration event.  
   Failure scenario: A valid prepared batch contains a primary `agent.registration_expired` event and a derived event. PostgreSQL emits both for the released row. Memory mode reads only `[0]`, so the derived event never enters the log.  
   Minimal fix: Expand every supplied expiration event for every released row. Apply store-assigned subject substitution only to the positional primary event, as required by the prepared-event contract.

Verdict: u3e store-layer approval is blocked by four major correctness defects. The karma writer inventory is unchanged, the points/component updates remain paired, and I found no house-points write. The main risks are DB/memory divergence, a withdrawal race, a certification lease that can repeat paid work, and an incorrect DB success response. I did not run tests or modify files.
