# b1 Lane D — codex round-2 fix spec (direct messages)

Findings: `ai/m11-2-handoff/codex-findings-b1-d-round2.md` — all six ADJUDICATED valid. Codex
OVERTURNED the F1 deferral with a concrete harm; DMs are a NEW action and the guard machinery
already exists, so the guard is adopted here (ledger item 9's interim keeps covering the older
actions). Rules: `b1-common-rules.md`. Fence = lane D's files.

1. **F1 execution guard reaches DM writes**: the `send_dm`, `block_agent`, `unblock_agent` and
   `read_dm_thread` executors forward `ctx.executionGuard` into the actions; `sendDm`,
   `setDmBlock` and `markDmRead` take an optional `executionGuard` and the STORE gates the
   decisive statement on it exactly as `createComment` does (`src/lib/store/execution-guard.ts`,
   db + memory). A failed guard answers `execution_guard_failed`. Tests: a disabled agent /
   superseded claim writes nothing (memory), one db case for the send statement.
2. **F2 real concurrency**: rewrite the three races with barriers (`helpers/concurrency.ts` —
   hold the pair row on one connection, start the second operation, release, observe): two
   DIFFERENT senders overlapping ⇒ both succeed and seq order = commit order (assert by reading
   `committed_at`/seq pairs, not sorted values); send-vs-block in BOTH orders with the barrier ⇒
   the second observer sees the first; mark-read racing a held send ⇒ the cursor excludes the
   uncommitted message. Mutation-check each by weakening the lock.
3. **F3 unread-first in the store**: `listDmConversations` gains `unreadFirst` (or a dedicated
   unread read) so unread threads are selected BEFORE the limit in SQL (`ORDER BY (last_message_seq
   > my_last_read_seq) DESC, last_message_at DESC LIMIT n`); memory twin identical. Test with 25
   newer read conversations hiding one unread.
4. **F4 same missing-actor failure in both stores**: memory `sendDm` answers the same refusal the
   db answers when the sender is gone; db translates the sender-side `23503` (match the constraint
   NAME on `agent_rate_limits.agent_id`) into that refusal instead of a 500. Route test: 404-class,
   never 429/500, in both modes.
5. **F5 content type**: the thread POST route answers 400 unless `content` is a string; test.
6. **F6 comment**: cut the send comment to ≤ 5 lines (transaction boundary + the pair-row lock).

Report: `ai/m11-2-handoff/b1-d-fix-r2-report.md`.
