1. **MAJOR** — [src/lib/store/evaluations/db.ts:42](/Users/mohsin/Github/safemolt/src/lib/store/evaluations/db.ts:42)

   The `idx_eval_reg_active` recovery uses two separate snapshots. After a registration insert causes the conflict, that registration can complete with a failed result before either classifier query, or between the passed-result query and the active-registration query. The classifier then finds no passed result and no active registration. It throws `"Active registration conflict disappeared before classification"`, and a valid registration request gets a 500.

   Minimal fix: if the conflict state is no longer present, retry the conditional registration operation once with a fresh transaction. Keep the retry bounded and keep handling only `idx_eval_reg_active`.

2. **MINOR** — [src/lib/store/evaluations/memory.ts:289](/Users/mohsin/Github/safemolt/src/lib/store/evaluations/memory.ts:289)

   `addSessionMessage` returns for an inactive session or missing participant before it validates the prepared events at line 300. PostgreSQL renders and validates the events before it runs the transaction. Thus, an invalid or non-JSON event produces an error in PostgreSQL but silently returns `null` in memory mode.

   Minimal fix: generate the message ID, substitute the primary event, and call `validatePreparedEvents` before the first state-based return. Keep `prepareEventBatch` after eligibility classification so a refused write does not test idempotency.

3. **MINOR** — [src/lib/store/agents/db.ts:1029](/Users/mohsin/Github/safemolt/src/lib/store/agents/db.ts:1029), [src/lib/store/agents/db.ts:1073](/Users/mohsin/Github/safemolt/src/lib/store/agents/db.ts:1073)

   Vetting bootstrap results and their activity rows use different completion times. The transaction stores the `now` created in `runCompleteVettingBatch`, but the post-transaction activity writer creates a second timestamp. Memory mode uses one timestamp for both. A database bootstrap can therefore have an activity ordering time that does not equal its result’s `completed_at`.

   Minimal fix: create one completion timestamp in `completeVetting`, pass it into `runCompleteVettingBatch`, and reuse it for the activity writes.

Verdict: I found no new karma writer, no points/component split, and no house-points write. The reviewed completion, certification, proctor, session, and vetting locks follow the required agents-first order, and I found no new deadlock cycle. The decisive event and mutation gates are otherwise correct. The registration conflict race is a release concern because it can produce a 500 during a normal concurrent transition. I did not run tests or modify files.
