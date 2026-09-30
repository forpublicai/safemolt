# b1 Lane W — codex round-5 fix report (webhooks)

All six codex-findings-b1-w-round5.md items fixed, plus the whole-fence audit (item 7). No git, no
codex, no build, no no-path integration run. Every test ran as a foreground Bash call.

## Findings — status

1. **F1 withdrawal deadlock (agent → registration → delivery → wakeup) — DONE.**
   `deleteAgentWebhook` (`src/lib/store/webhooks/db.ts`) now opens with `SELECT 1 FROM agents ...
   FOR KEY SHARE` as statement 1, before the `DELETE FROM agent_webhooks` (now statement 2).
   `recordWebhookAttempt` now opens with the same agent lock as statement 1, before the existing
   `agent_webhooks FOR NO KEY UPDATE` lock (now statement 2) and the token-fenced ledger statement
   (now statement 3). Both match `registrationCte`'s enqueue-side order (round 4), so a withdrawal's
   `DELETE FROM agents` — which needs a stronger lock than `FOR KEY SHARE` — now waits out either
   call's whole transaction instead of racing its cascade against them in the opposite table order.
   Test: `F1 (round 5): recordWebhookAttempt and deleteAgentWebhook both start with the agent row`
   (`m11-2-b1-webhooks.test.ts`) — a real `DELETE FROM agents` held open on one connection while a
   real `recordWebhookAttempt` and a real `deleteAgentWebhook` race it concurrently; asserts both
   queue behind the withdrawal's own agent lock (marker `p5.1:agent-lock`) and both resolve cleanly
   (`not_found` / `{ deleted: false }`), never a `40P01`. **PASS.** Mutation (statement 1 removed
   from both functions): `observation.observedBlocked` goes from `true` to `false` —
   `Expected: true / Received: false` at line 631 — **shown failing below.**

2. **F2 IPv4 special range (192.88.99.0/24, deprecated 6to4 relay anycast) — DONE.** Added to
   `V4_NON_PUBLIC_RANGES` in `src/lib/webhooks/deliver.ts`. Table tests for both forms
   (`192.88.99.2`, `::ffff:192.88.99.2`) added to `deliver.test.ts`'s existing rejection table —
   covers both call sites (`actions/webhooks.ts` registration, `deliver.ts` per-attempt) since both
   route through `resolvePublicAddresses`/`isPublicIPv4`. **PASS.** Mutation (range entry removed):
   both new rows fail — `Received promise resolved instead of rejected` — **shown failing below.**

3. **F3 real enqueue-lock proof — DONE.** A test-only `AFTER INSERT` trigger on `webhook_deliveries`
   (`b1w_pause_fn_<RUN>`, created in the file's own `beforeAll`, dropped in `afterAll`) locks a
   dedicated `b1w_pause_gate_<RUN>` row `FOR UPDATE` whenever the inserted delivery's wakeup carries
   a designated `reason` — pausing the REAL `enqueueWakeup` transaction mid-flight, AFTER it has
   taken its own registration `FOR SHARE` lock. Restructured
   `F3 (round 5): deleteAgentWebhook genuinely waits on enqueueWakeup's OWN registration lock`
   (replacing the old F5(b), whose "unrelated FOR SHARE holder" could not detect a removed lock):
   a controller holds the pause-gate row, the real enqueue pauses on it (proven via the
   `p5.1:agent-lock` marker), a real `deleteAgentWebhook` is proven — BY BACKEND PID — to queue
   behind enqueue's own backend (marker `p5.1:delete-registration`), then the gate releases and both
   real calls finish, with delete sweeping what enqueue committed. **PASS**, wrapped in try/finally
   (round 4's own "Bug A" lesson) so a failed assertion can never leak the controller's transaction.
   Mutation (registration `FOR SHARE` removed from `registrationCte`): `deleteWaitedOnEnqueue` goes
   false — `Expected: true / Received: false` — **shown failing below**, and completes in 11s (no
   hang) because of the try/finally.

4. **F4 context_href — DONE.** `src/lib/worker/webhook-pass.ts`'s outbound payload now sends
   `context_href: "/api/v1/agents/me/context"`. Assertion added to the existing delivery-pass test
   (`webhook-pass.test.ts`, F3 round 3's payload-shape test). **PASS.** Mutation (reverted to `"/"`):
   `Expected: "/api/v1/agents/me/context" / Received: "/"` — **shown failing below.**

5. **F5 IPv6 literals — DONE.** New `stripIPv6Brackets` export in `deliver.ts`, applied at the two
   named call sites (`deliverWakeup`'s `resolvePublicAddresses` call; `actions/webhooks.ts`'s
   registration-time resolve) — `Host`/SNI still use `parsed.hostname` unchanged (Node re-brackets a
   plain IPv6 host for the `Host` header on its own). New test in `deliver.test.ts` sends a bracketed
   literal URL through `deliverWakeup` with an injected resolver that rejects a bracketed hostname
   the way real `dns.lookup` does; asserts the bare address reaches the resolver and the bracketed
   form still reaches `Host`. **PASS.** Mutation (`stripIPv6Brackets` made a no-op): resolver called
   with `"[2606:4700::1111]"` instead of the bare address — **shown failing below.**

6. **F6 comments ≤5 lines — DONE.** `webhooks/memory.ts:173` (was 8 lines) and `wakeups/memory.ts:184`
   (was 13 lines across three paragraphs) condensed to 3–4 lines each, WHY-only, no essay.

## 7. Whole-fence audit (policy item 2)

Reviewed every statement in `webhooks/db.ts`, the webhook-related statements in `wakeups/db.ts`
(`registrationCte`, `webhookLedgerCte`, `insertWakeupSql`, `rearmWebhookGate`,
`resolveWakeupDelivery`), `deliver.ts`'s address rules, and every test in
`m11-2-b1-webhooks.test.ts`, against the two recurring rules (statement-order locking; liveness is
`FOR SHARE` never bare `EXISTS`) and the mutation-fail requirement.

- **`src/lib/store/webhooks/db.ts` — audit changed 2 functions (the two findings above); everything
  else reviewed, nothing else changed.** `claimNextWebhookDelivery` uses `FOR UPDATE SKIP LOCKED`
  (never blocks, so it cannot deadlock with withdrawal — confirmed, not touched). `upsertAgentWebhook`
  is a plain `INSERT ... ON CONFLICT` relying on the `agent_webhooks_agent_id_fkey` for liveness
  (correct — no bare-`EXISTS` substitute needed since the FK itself is the gate).
  `recordWebhookAttempt`'s `reg` CTE (statement 3) reads `agent_webhooks` with no lock of its own —
  audited and confirmed SAFE, not a defect: statement 2 in the SAME transaction already holds
  `FOR NO KEY UPDATE` on that exact row, so `reg`'s read cannot observe a concurrent write. No bare
  `EXISTS` used as a liveness substitute anywhere in this file.
- **`src/lib/store/wakeups/db.ts` (webhook paths) — audit found nothing to change; round 4's F1 fix
  re-verified correct.** `registrationCte`'s `agent_lock` (`FOR KEY SHARE`) → `reg` (`FOR SHARE`)
  order is enforced by a genuine data dependency (`reg`'s `WHERE` references `agent_lock` via
  `EXISTS`), not WITH-list position — confirmed by re-reading, not just trusting the comment.
  `createOrReArmWakeup`/`createOrReArmPlaygroundRoundWakeup` lock an EXISTING `agent_wakeups` row
  (`rearmed`) before an existing `webhook_deliveries` row (the ledger's `ON CONFLICT` arm) — the
  reverse of `recordWebhookAttempt`'s own order — audited for a cross-path deadlock and found safe:
  a re-arm's precondition (`completed_at IS NOT NULL`) is structurally exclusive with an in-flight
  attempt's non-terminal claim on the same row, so the two paths can never contend for the same row
  pair despite locking in "opposite" table order. Documented here since it is not obvious from either
  function in isolation.
- **`src/lib/webhooks/deliver.ts` address rules — audit added F2 and F5 above; reviewed the rest of
  the IANA special-purpose registries (AS112 delegation ranges, drone/AMT) for further gaps and found
  none flagged by any finding — not added, to avoid unrequested scope creep (KISS).** No SQL/locks in
  this file; the audit's applicable criterion here is classification completeness, not lock order.
- **`src/__tests__/integration/m11-2-b1-webhooks.test.ts` — audit restructured 1 test (F5(b) → F3
  round 5) and added 1 (F1 round 5); all 23 tests reviewed for the mutation-fail requirement.** Every
  behavioral test in this file that asserts a lock/outcome property was checked against the
  requirement that removing its protected behavior makes it fail; the two new round-5 tests and the
  F2/F4/F5 unit tests all have verbatim failing-run evidence above. The remaining tests carry mutation
  evidence recorded in the round-2/3/4 reports (not re-run here, out of scope for this round beyond
  the two items codex named). One robustness gap FOUND AND FIXED during this audit: the restructured
  F3 test's controller connection had no `try/finally`, so its own first (correct) mutation-check run
  hung for 70s and crashed Jest with an unhandled `idle-in-transaction timeout` error once an
  assertion failed before the `COMMIT` — round 4's own "Bug A" pattern, reproduced. Fixed by wrapping
  the controller lifecycle and both racing calls in `try/finally`; re-ran the same mutation and it now
  fails cleanly in 11s. The leaked connection's one orphaned fixture agent (from the pre-fix hung run)
  was found polluting `claimNextWebhookDelivery`'s "exactly one claimant" test on the next real run
  (a second winner from a stale row) and was swept via a temporary, sanctioned integration test
  (`DELETE ... WHERE agent_id LIKE 'b1w_agent_%'`), then deleted — same convention as round 4's Bug B
  cleanup, no ad hoc script run outside the test harness.

## Mutation-check evidence (verbatim, all restored to the fixed state before the next gate run)

**F1 (round 5)** — statement 1 removed from both functions:
```
expect(observation.observedBlocked).toBe(true);
Expected: true
Received: false
```

**F3 (round 5)** — `FOR SHARE` removed from `registrationCte`'s `reg`:
```
expect(deleteWaitedOnEnqueue).toBe(true);
Expected: true
Received: false
```
(Time: 10.969s — no hang, confirming the try/finally fix holds under a real failure.)

**F2** — range entry removed:
```
rejects 6to4 relay anycast 192.88.99/24 (192.88.99.2)
Received promise resolved instead of rejected
Resolved to value: ["192.88.99.2"]

rejects 6to4 relay anycast, IPv4-mapped (::ffff:192.88.99.2)
Resolved to value: ["::ffff:192.88.99.2"]
```

**F4** — `context_href` reverted to `"/"`:
```
Expected: "/api/v1/agents/me/context"
Received: "/"
```

**F5** — `stripIPv6Brackets` made a no-op:
```
expect(lookupAll).toHaveBeenCalledWith("2606:4700::1111", { all: true });
- Expected: "2606:4700::1111"
+ Received: "[2606:4700::1111]"
```

## Gates

- `npx tsc --noEmit` — clean.
- `npx eslint src/lib/store/webhooks/db.ts src/lib/store/webhooks/memory.ts src/lib/store/wakeups/db.ts src/lib/store/wakeups/memory.ts src/lib/webhooks/deliver.ts src/lib/worker/webhook-pass.ts src/lib/actions/webhooks.ts src/__tests__/integration/m11-2-b1-webhooks.test.ts src/__tests__/lib/webhooks/deliver.test.ts src/__tests__/lib/worker/webhook-pass.test.ts --max-warnings=0` — clean, 0 warnings.
- `npm test -- src/__tests__/lib/webhooks src/__tests__/lib/store/webhooks-memory.test.ts src/__tests__/api/agents-me-webhook.test.ts src/__tests__/api/agents-me-webhook-real-action.test.ts src/__tests__/lib/events src/__tests__/lib/store/wakeups src/__tests__/lib/worker` — **19 suites, 315 tests, all PASS** (re-run after every mutation restore).
- `npm run test:integration -- src/__tests__/integration/m11-2-b1-webhooks.test.ts`, run twice: **23/23 PASS both times** (32.6s, 32.9s). A pre-existing unrelated `tsc` error surfaced transiently in `src/__tests__/lib/store/activity/events.test.ts` from a concurrent lane's in-flight edit — not touched, confirmed resolved by that lane before the final gate run above.

## Files touched this session (webhooks lane only)

- `src/lib/store/webhooks/db.ts` — F1: `deleteAgentWebhook` and `recordWebhookAttempt` each gained a
  leading `agents ... FOR KEY SHARE` statement.
- `src/lib/store/webhooks/memory.ts` — F6: comment trim (no behavior change).
- `src/lib/store/wakeups/memory.ts` — F6: comment trim (no behavior change). Did not touch
  `insertRow`/`nextStreamSeq` (lane S's stream_seq territory).
- `src/lib/webhooks/deliver.ts` — F2 (range table entry), F5 (`stripIPv6Brackets` export + call site).
- `src/lib/actions/webhooks.ts` — F5 (registration-time call site).
- `src/lib/worker/webhook-pass.ts` — F4 (`context_href`).
- `src/__tests__/integration/m11-2-b1-webhooks.test.ts` — added F1(round5) test, restructured
  F5(b)→F3(round5) test with the trigger-based pause, added the pause-gate `beforeAll`/`afterAll`,
  added `waitersOn` import.
- `src/__tests__/lib/webhooks/deliver.test.ts` — F2 table rows, F5 test.
- `src/__tests__/lib/worker/webhook-pass.test.ts` — F4 assertion.
- No other lane's files were touched. `src/lib/store/wakeups/db.ts` was read but not edited (round
  4's F1 fix there was re-verified, not changed) — re-read fresh immediately before that verification
  and again immediately before/after the F3 mutation-check edit, per the collision protocol.

## Not done / open

Nothing from the spec is outstanding. All six findings are fixed and tested with verbatim failing
mutation runs; the whole-fence audit covered every statement in the fence and recorded one
robustness defect it found and fixed in its own new test (the missing try/finally) plus the orphaned-
row cleanup that defect's earlier (pre-fix) run left behind.
