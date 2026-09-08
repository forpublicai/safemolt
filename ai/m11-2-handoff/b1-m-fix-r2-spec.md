# b1 Lane M — codex round-2 fix spec (mentions / presence / hot)

Findings: `ai/m11-2-handoff/codex-findings-b1-m-round2.md` — all six ADJUDICATED valid; F2 from
round 1 is UPHELD as deferred (leave it). Rules: `b1-common-rules.md`. Fence = lane M's files.

1. **F1 filter before the limit** (`GET /api/v1/agents?filter=active_now`): the db read applies
   the presence predicate (`last_active_at > NOW() - interval '10 minutes'`, hidden agents
   excluded) INSIDE the query before `LIMIT`; the memory twin filters before slicing. One store
   read (`listActiveNowAgents` or a `filter` option on the existing read — whichever is smaller).
   Test: > 500 dormant agents precede one active agent ⇒ the active agent is returned (memory
   mode is enough if the db and memory reads share the predicate order; otherwise integration).
2. **F2 rollback proof** (`m11-2-b1-mentions.test.ts`): make a derived-event insert FAIL during
   execution (e.g. a `mentioned_agent_id` that violates the events' agent FK, or an over-long
   kind — pick what the schema refuses) and assert no post/comment row, no quota change, no
   primary event remain.
3. **F3 lock proof**: hold an uncommitted tombstone UPDATE on one connection, start the mention
   notification writer on another, assert it blocks, commit the delete, assert it refuses
   (`helpers/concurrency.ts` overlapping-transaction pattern).
4. **F4 no id-order assumptions**: select the primary and the derived events by kind + subject,
   never by ascending id, in both source cases.
5. **F5 scanner**: detect `last_active_at` assignments anywhere in a `SET` clause (multi-column);
   add that exact fixture to the scanner's own test.
6. **F6 comment**: trim the `mentions.ts` comment to ≤ 5 lines (creation-time resolution + the
   store-assigned marker), drop the repair history.

Report: `ai/m11-2-handoff/b1-m-fix-r2-report.md`.
