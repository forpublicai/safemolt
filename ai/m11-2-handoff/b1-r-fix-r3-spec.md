# b1 Lane R — codex round-3 fix spec (reactions)

Findings: `ai/m11-2-handoff/codex-findings-b1-r-round3.md` — all six ADJUDICATED valid. Rules:
`b1-common-rules.md`. Fence = lane R (+ `src/lib/agent-tools/definitions/reactions.ts`).

**Lock order is enforced by STATEMENT ORDER inside the transaction** (posts → comments → agents):
1. **F2 subject before actor**: `addReaction` becomes a three-statement `sql.transaction`:
   statement 1 locks the live subject (`posts … FOR SHARE`, then the comment joined to its live
   post); statement 2 seeds + locks the rate row (`FOR NO KEY UPDATE`, non-key no-op update —
   its actor FK `FOR KEY SHARE` now comes AFTER the subject lock); statement 3 is the decisive
   statement (which may re-take the same locks — re-taking is free). Test: withdrawal holding
   the author's post overlaps a self-reaction with NO rate row ⇒ no `40P01`, one side refuses.
2. **F1 execution guard**: `add_reaction`/`remove_reaction` executors forward `ctx.executionGuard`;
   both actions and both stores take the optional guard and gate the decisive statement on it
   exactly like `sendDm` now does (`src/lib/store/execution-guard.ts`). Tests: disabled agent /
   superseded claim ⇒ nothing written, `execution_guard_failed` (memory), one db case.
3. **F3 reaction-first race held open**: hold the reaction transaction (subject lock + insert)
   uncommitted, start `deletePost`, assert it BLOCKS, commit the reaction, assert the delete then
   removes the reaction and its drained notification. Both subject types.
4. **F4 memory validation order**: shape validation (`validatePreparedEvents`) before the
   refusals; the full uniqueness preflight (`prepareEventBatch`) immediately before the first
   mutation. Test: a valid-shape event with a conflicting idem key on a MISSING subject answers
   `not_found` in both stores (memory must not throw).
5. **F5 test**: commit the seed, then hold ITS row lock on the holder connection while two
   contenders run ⇒ one `added`, one `already_reacted`; mutation: drop the seed lock ⇒ the
   duplicate misclassifies (record the observed `rate_limited`).
6. **F6 comment**: one ≤ 5-line note on the non-key update and the lock lifetime.

Report: `ai/m11-2-handoff/b1-r-fix-r3-report.md`.
