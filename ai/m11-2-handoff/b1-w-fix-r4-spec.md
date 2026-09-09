# b1 Lane W — codex round-4 fix spec (webhooks)

Findings: `ai/m11-2-handoff/codex-findings-b1-w-round4.md` — all six ADJUDICATED valid; every
remaining test deferral is OVERTURNED. Rules: `b1-common-rules.md`. Fence = lane W.

**Global lock order for this domain, by STATEMENT order:** `agents` (the wakeup's agent, `FOR KEY
SHARE`) → `agent_webhooks` → `webhook_deliveries` → `agent_wakeups`; playground paths keep
`playground_sessions` BEFORE the agent lock.

1. **F1 withdrawal deadlock**: every enqueue/re-arm path takes `SELECT 1 FROM agents WHERE id = $agent
   FOR KEY SHARE` as its FIRST statement (after the session lock on the playground path), THEN the
   registration lock, then the insert. Memory twin: no change needed beyond the existing re-check.
   Test: a withdrawal holding the agent row (DELETE in an open transaction) overlapping an enqueue
   ⇒ no `40P01`; the enqueue either waits and refuses (agent gone) or wins first.
2. **F2 honest tests**: (a) the rollback fixture creates a REAL consumer receipt for the event
   (through the receipt writer the drain uses) and asserts the disposition completes the wakeup
   despite the receipt; (b) the registration-lock test holds the REAL `enqueueWakeup` at its
   boundary (marker comment + `pg_stat_activity` detection, the u3f pattern) — no substitute lock
   holder; (c) the success-race test forces the overlap: hold the registration `FOR SHARE` on a
   third connection so both attempts' lock upgrades queue, then release — and the report must show
   the `FOR SHARE` mutation FAILING this test (if it cannot fail deterministically, restructure the
   test until it does; "passed three times" is not evidence).
3. **F3 terminal-token replay**: the sweep runs in statement 2, gated on `disabled_now` (the
   registration flipped in THIS call) and excluding the current delivery; a call whose token was
   rejected sweeps nothing. Memory identical. Test: replay a terminal delivery's token after
   auto-disable while another lease has expired ⇒ nothing written.
4. **F4 no connection reuse**: `agent: false` on the request so every attempt dials the freshly
   pinned IP. Test: two consecutive deliveries with different resolved addresses reach different
   receivers.
5. **F5 connect timer**: a separate 5 s connect timer cleared on `socket.connect`; the 10 s total
   deadline (already covering DNS) stays; do not use `req.setTimeout` inactivity for the connect
   bound. Test: a receiver that connects at once and answers after 6 s succeeds.
6. **F6 comments**: `webhooks/memory.ts:64` and `deliver.ts:351` ≤ 5 lines.

Report: `ai/m11-2-handoff/b1-w-fix-r4-report.md`.
