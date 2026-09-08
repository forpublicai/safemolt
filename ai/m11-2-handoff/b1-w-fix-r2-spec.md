# b1 Lane W — codex round-2 fix spec (webhooks)

Findings: `ai/m11-2-handoff/codex-findings-b1-w-round2.md` — all ten ADJUDICATED valid; codex
OVERTURNED both round-1 test deferrals, so they are must-close. Rules: `b1-common-rules.md`.
Fence = lane W's files (+ `src/lib/worker/event-drain-pass.ts`, `worker/index.ts` for item 9).

**One lock order for the whole domain, and every path takes it: `agent_webhooks` (registration)
→ `webhook_deliveries` (ledger) → `agent_wakeups`.** Enqueue/re-arm, delete, auto-disable and
attempt completion all lock the registration FIRST.

1. **F1 no ledger-less webhook-primary wakeup**: in every enqueue/re-arm path the webhook-primary
   INSERT/re-arm itself is gated on the locked live registration (no live row ⇒ nothing is
   written, `created:false`); `both` ledgers stay gated on `mode='both'`. Both stores. Test:
   delete the registration between `resolveWakeupDelivery` and `enqueueWakeup` ⇒ no wakeup.
2. **F2 disposition under a fresh snapshot**: `deleteAgentWebhook` and the auto-disable become a
   two-statement `sql.transaction`: statement 1 locks the registration `FOR NO KEY UPDATE`
   (auto-disable: the conditional `disabled_at` UPDATE with its event, which takes that lock);
   statement 2 performs the coupled disposition (terminalize unclaimed/expired ledgers + complete
   webhook-primary wakeups) under the next snapshot. Test: an enqueue holding the registration
   lock commits during the delete's wait ⇒ its delivery is terminalized too (overlapping
   transactions, `helpers/concurrency.ts`).
3. **F3 re-arm preserves an active `both` ledger**: the re-arm's ledger reset applies only to a
   TERMINAL ledger row (`terminal_reason IS NOT NULL`) of a webhook-PRIMARY wakeup; an internal
   re-arm never touches a claimed/live `both` ledger. Both stores. Test.
4. **F4 attempt completion lock order**: `recordWebhookAttempt` locks the registration first
   (`FOR SHARE`, or `FOR NO KEY UPDATE` when it will bump `failure_count`), then the token-fenced
   delivery UPDATE, then the wakeup completion. Re-check the claim token under those locks.
5. **F5 IPv6 allowlist**: IPv6 is accepted ONLY inside `2000::/3` (global unicast) and not in
   `2001:db8::/32`; `64:ff9b::/96`, `::ffff:0:0/96` and `2002::/16` are judged by their embedded
   IPv4. Everything else (`fec0::/10`, `fe80::/10`, `fc00::/7`, `::1`, `::`, `ff00::/8`, …) is
   rejected. Table test with `fec0::1`, `fe80::1`, `fc00::1`, `2001:db8::1`, `2002:c0a8:101::`,
   `64:ff9b::7f00:1`.
6. **F6 deadline covers DNS**: start the 10 s total deadline before resolving; a late DNS result
   is refused before any socket work; the socket receives only the remaining time. Test with a
   resolver that resolves after the deadline ⇒ no request made.
7. **F7 memory upsert re-checks the agent** inside `upsertAgentWebhook` (memory) immediately
   before the write — not only in the action. Test: withdrawal during the action's last await.
8. **F8 tests (deferrals overturned)**: (a) a focused `runWebhookDeliveryPass` test — a claim
   whose registration is disabled/removed makes NO request and terminalizes; (b) an interrupted-
   coupling / rollback test — a receipted event with a pending delivery: run the disposition and
   assert zero nonterminal ledgers AND zero incomplete webhook-primary wakeups; (c) a body-cap
   test against a receiver that streams > 64 KB and never ends ⇒ the client stops at the cap;
   (d) a payload test on the WORKER path asserting ids + `context_href` only (no title/content
   fields). Mutation-check each.
9. **F9 stop signal through the drain pass**: `runEventDrainPass` takes an optional `shouldStop`
   and forwards it to its webhook pass; `worker/index.ts` passes `isShuttingDown`. Test.
10. **F10 KISS**: drop `RecordWebhookAttemptInput.agentId` and its callers; cut the 26-line comment
    to the lock order + coupling rule (≤ 5 lines).

Report: `ai/m11-2-handoff/b1-w-fix-r2-report.md` (per finding: change, test, mutation-check;
gate tails).
