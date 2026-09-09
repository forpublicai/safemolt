# b1 Lane W — codex round-3 fix spec (webhooks)

Findings: `ai/m11-2-handoff/codex-findings-b1-w-round3.md` — all eight ADJUDICATED valid; every
remaining test deferral is OVERTURNED (must-close). Rules: `b1-common-rules.md`. Fence = lane W.

**Lock order is enforced by STATEMENT ORDER, not by CTE declaration order.** Every path that
touches the registration and a ledger row is a `sql.transaction` whose statement 1 locks the
registration row and whose later statements do the ledger/wakeup work — CTE siblings have no
ordering guarantee, so a registration lock inside the same statement as the ledger lock proves
nothing.

1. **F1 + F2 attempt completion**: `recordWebhookAttempt` becomes statement 1 = `SELECT … FROM
   agent_webhooks WHERE agent_id = (SELECT agent_id FROM webhook_deliveries WHERE id = $1 AND
   claim_token = $2) FOR NO KEY UPDATE` (the same mode for success and failure — no shared→update
   upgrade); statement 2 = the token-fenced ledger UPDATE + wakeup completion; statement 3 (only
   when the attempt was accepted, item 6) = the disposition sweep. Tests: two successful
   deliveries for one agent overlapping ⇒ no `40P01`, both recorded; a late attempt on an expired
   ledger overlapping a delete ⇒ no deadlock, one wins, nothing torn (`helpers/concurrency.ts`).
2. **F3 payload allowlist**: `webhook-pass.ts` builds `subject` from an explicit allowlist of id
   fields (`post_id, comment_id, parent_comment_id, session_id, round, conversation_id,
   message_id, mentioned_agent_id, source_id, source_type, group_id, agent_id`) — nothing else
   copied; test feeds a payload with `title`/`content` and asserts the FULL outbound body
   contains neither, at any depth.
3. **F4 IPv6 special ranges inside 2000::/3**: additionally reject `2001::/23` (IETF protocol
   assignments: Teredo, benchmark 2001:2::/48, ORCHID, …), `2001:db8::/32`, `3fff::/20`,
   `5f00::/16`; table tests with `2001:2::1`, `3fff::1`, `2001::1`, `5f00::1`.
4. **F5 effective tests** (integration unless noted): (a) forced failure BETWEEN the ledger write
   and the wakeup completion (inject a failing element / a constraint trip after the ledger arm)
   ⇒ neither is committed; (b) rollback test with a REAL receipted event and the REAL `enqueueWakeup`
   racing the delete (hold the registration lock via a real enqueue transaction, not a substitute);
   (c) route test through the REAL action with the memory store: the secret appears once in the
   POST body and never in GET; (d) local receiver test: 500 → retry → … → disable at the
   threshold, and an event-less `both` delivery retried twice carries the same `X-SafeMolt-
   Wakeup-Id`.
5. **F6 sweep gated on an accepted attempt**: statement 3 runs only when statement 2 matched the
   token (check its row count in JS between statements, inside the transaction).
6. **F7 memory repeated delete**: the memory sweep runs even when the registration is already
   absent (a later delete finishes a row whose lease expired); return the original result.
7. **F8 comments**: `wakeups/db.ts` ledger CTE and `webhooks/db.ts` delete comments ≤ 5 lines; fix
   the "commits" wording (the transaction stays open; the next statement sees a NEW snapshot).

Report: `ai/m11-2-handoff/b1-w-fix-r3-report.md`.
