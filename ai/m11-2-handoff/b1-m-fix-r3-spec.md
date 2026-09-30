# b1 Lane M — codex round-3 fix spec (mentions / presence / hot)

Findings: `ai/m11-2-handoff/codex-findings-b1-m-round3.md` — all three ADJUDICATED valid; the
round-1 F2 deferral is UPHELD (leave it). Rules: `b1-common-rules.md`. Fence = lane M.

1. **F1 hidden agents excluded before the LIMIT** (`listAgents` db, `filter=active_now`): put the
   hidden-agent predicate (the SQL twin of `isPubliclyHiddenAgent` — metadata `test`/`system`/
   `source='test'`, whatever the memory predicate encodes) INSIDE the query with the presence
   predicate, before `LIMIT`; the memory twin filters the same way before slicing. Db test:
   more hidden active agents than the limit precede one visible active agent ⇒ it is returned
   (RUN-suffix, and clean up in `afterAll`; keep the count small by passing a small limit
   option if the read accepts one — do not insert 500 rows).
2. **F2 visibility at consume time**: `createMentionNotificationIdempotent` (db + memory) gates the
   insert on the recipient being currently visible (the same predicate, on the locked recipient
   row); the consumer keeps its existence check. Test: recipient visible at emit, hidden before
   the drain ⇒ no notification, receipt still written.
3. **F3 comment**: `comments/memory.ts` substitution comment ≤ 5 lines: positional primary rule +
   marker condition only.

Report: `ai/m11-2-handoff/b1-m-fix-r3-report.md`.
