# b1 Lane W — codex round-5 fix spec (webhooks)

Findings: `ai/m11-2-handoff/codex-findings-b1-w-round5.md` — all six ADJUDICATED valid (the same-time
claim ordering deferral is UPHELD). Policy: `ai/m11-2-handoff/b1-convergence-policy.md` — the
WHOLE-FENCE AUDIT (item 2) is a standing deliverable. Rules: `b1-common-rules.md`. Fence = lane W.

Global lock order, by STATEMENT order: `agents` (`FOR KEY SHARE`) → `agent_webhooks` →
`webhook_deliveries` → `agent_wakeups`. EVERY writer in the domain starts with the agent row —
enqueue/re-arm (done in r4), and now completion and deletion too.

1. **F1 completion and deletion start with the agent row**: `recordWebhookAttempt` and
   `deleteAgentWebhook` (and the auto-disable path) take `SELECT 1 FROM agents WHERE id = $agent FOR
   KEY SHARE` as statement 1 (the delivery's agent id comes from the claimed row, which the caller
   already holds; for delete it is the input). Test: a withdrawal holding the agent row and its
   wakeup rows overlapping an attempt completion and a delete ⇒ no `40P01`.
2. **F2 IPv4 special range**: reject `192.88.99.0/24` (6to4 relay anycast, deprecated) in both
   forms; table tests for `192.88.99.2` and `::ffff:192.88.99.2` at registration and per attempt.
3. **F3 real enqueue-lock proof**: pause the REAL `enqueueWakeup` transaction AFTER it took the
   registration lock and before commit (a test-only `AFTER INSERT` trigger on `webhook_deliveries`
   that locks a row the holder connection holds `FOR UPDATE` — create it in `beforeAll` under a
   RUN-suffixed name, drop in `afterAll`), start `deleteAgentWebhook`, prove by backend pid that
   the delete waits on the enqueue, release, assert the delete then swept the new ledger. Mutation:
   remove enqueue's registration `FOR SHARE` ⇒ the test FAILS (show the run).
4. **F4 context_href**: the webhook payload's `context_href` is `/api/v1/agents/me/context`; assert
   in the delivery-pass test.
5. **F5 IPv6 literals**: strip the brackets from `URL.hostname` before resolution/pinning; keep the
   bracketed form for `Host`/SNI where Node needs it; test a public IPv6 literal URL.
6. **F6 comments** in `webhooks/memory.ts:173` and `wakeups/memory.ts:184` ≤ 5 lines.
7. **WHOLE-FENCE AUDIT** (policy item 2): every statement in `webhooks/db.ts`, `wakeups/db.ts`
   (webhook paths), `deliver.ts` address rules, and every lane-W test; per-file result lines.

Report: `ai/m11-2-handoff/b1-w-fix-r5-report.md`.
