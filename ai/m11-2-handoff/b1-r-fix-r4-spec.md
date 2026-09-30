# b1 Lane R — codex round-4 fix spec (reactions)

Findings: `ai/m11-2-handoff/codex-findings-b1-r-round4.md` — all six ADJUDICATED valid. Rules:
`b1-common-rules.md`. Fence = lane R.

1. **F1 comment lock in statement 1**: for a comment subject, statement 1 locks the live post
   (`FOR SHARE`) THEN the comment (`FOR SHARE`, joined to that post) — both BEFORE the rate-row
   seed (statement 2) whose actor FK takes the agent lock. Withdrawal test for the COMMENT
   subject (author without a rate row, self-reaction overlapping withdrawal ⇒ no `40P01`).
2. **F2 guard on the seed and the quota**: the seed statement is gated on the execution guard (no
   row created, no day roll, no reset when the guard fails); the final quota update is gated on
   `inserted`. Tests: absent row and previous-day row under a failed guard ⇒ unchanged.
3. **F3 actor-withdrawal parity**: translate the seed's actor FK `23503` (match the constraint
   NAME) into the same `not_found`-class refusal memory answers; re-throw other violations. Test
   both stores through the action.
4. **F4 F5 test**: hold a COMMITTED rate row on the holder; start ONE real contender; after it
   blocks, insert the matching reaction and set the count to the cap through the holder; commit
   ⇒ the contender answers `already_reacted`. Mutation: drop the seed lock ⇒ `rate_limited`
   observed. Record the evidence.
5. **F5 guard tests**: supply REAL `reaction.added` events; cover a superseded claim token and a
   concurrent autonomy disable; assert no reaction, no quota change, no event, and the
   `execution_guard_failed` code.
6. **F6 comments**: one short lock-order note beside the transaction; delete the repeats.

Report: `ai/m11-2-handoff/b1-r-fix-r4-report.md`.
