# b1 Lane D — codex round-4 fix spec (direct messages)

Findings: `ai/m11-2-handoff/codex-findings-b1-d-round4.md` — all six ADJUDICATED valid; the flake
adjudication (test defect) is upheld. Rules: `b1-common-rules.md`. Fence = lane D (+ the runner's
skip path for item 1).

1. **F1 fence-loss after a refused DM read**: in `agent-pulse/runner.ts`, when ANY executed tool
   returned `execution_guard_failed`, the tick treats the fence as LOST: no `recordSkip`, no
   loop-state/bookkeeping writers — only the one token-fenced completion attempt, then return
   (the existing fence-loss discipline). Runner test: a stale claim whose `read_dm_thread` is
   refused and whose model then stops ⇒ the cooldown is untouched.
2. **F2 late-commit read proof**: pause a REAL send after its message insert with a test-only
   advisory-lock barrier (`pg_advisory_xact_lock` taken inside the send transaction when a test
   flag/marker is set — or hold the pair row from the test connection so the send's statement 2
   blocks mid-transaction), prove a second send and a mark-read both wait on it, release, then
   assert messages, seqs and the cursor. Mutation: commit the counter before the message ⇒ fails.
3. **F3 barrier by backend**: the helper identifies the first contender's backend and proves it
   waits on THIS holder (`pg_locks`/`pg_stat_activity` join on the holder's pid), then the second
   contender's dependency on the first; release only after both checks.
4. **F4 no empty pair on refusal**: when statement 2 refuses (`rate_limited`, `blocked`,
   `sender_gone`, guard) and statement 1 CREATED the pair in this transaction (its `RETURNING
   (xmax = 0) AS inserted` or an explicit flag), statement 3 deletes that empty pair (no
   messages, no block flags) — existing conversations and block state untouched. Memory already
   creates nothing. Test both stores.
5. **F5 pagination bounds**: `offset` ≤ 2^31−1, `limit` ≤ 200 (or the existing cap), `before_seq`
   a safe integer ≤ 2^53−1; 400 outside. Boundary tests.
6. **F6 comments**: fix the obsolete `dm.sent` line in `coverage.ts` and the memory send comment
   (sender-only check); keep ≤ 5 lines.

Report: `ai/m11-2-handoff/b1-d-fix-r4-report.md`.
