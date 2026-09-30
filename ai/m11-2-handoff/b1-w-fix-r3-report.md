# b1 Lane W — codex round-3 fix report (webhooks)

Continuation of a stranded generation-2 agent. Its work was on disk, uncommitted; this pass mapped
every spec item against the diff, finished the one gap, and re-verified the rest.

## 1. Deliverables — spec item by item

1. **F1+F2 attempt completion (lock order + 3-statement shape)** — DONE (prior agent) + FIXED here.
   `recordWebhookAttempt` (`src/lib/store/webhooks/db.ts`) has statement 1 = a plain registration
   lock (`FOR NO KEY UPDATE`, always, no shared→update upgrade), statement 2 = the token-fenced
   ledger UPDATE + wakeup completion. The prior agent's statement 3 (the disposition sweep) ran as a
   **separate, non-transactional call** gated on a JS check of statement 2's outcome — this released
   the registration lock before the sweep ran, reopening a window where a concurrent re-registration
   could clear `disabled_at` between the two. Fixed: all three statements now run in **one**
   `sql.transaction()` call (registration lock held throughout), and the sweep gates itself in SQL —
   its own subquery requires the SAME `(id, claim_token)` pair statement 2's fence required, so a
   rejected/stale attempt finds no `agent_id` and sweeps nothing. This also satisfies item 6 (F6).
2. **F2 lock-order enforcement by statement order** — DONE (prior agent, unchanged). `attemptText`'s
   `reg` CTE lost its own lock entirely; only the standalone `lockText` statement takes it, first.
3. **F3 payload allowlist** — DONE (prior agent). `webhook-pass.ts`'s `buildSubject` copies only the
   12 named id fields; test asserts the full outbound body (`JSON.stringify`) never contains
   `title`/`content`, at any depth.
4. **F4 IPv6 special ranges** — DONE (prior agent). `deliver.ts`'s `V6_NON_PUBLIC_IN_GLOBAL` rejects
   `2001::/23`, `2001:db8::/32`, `3fff::/20`, `5f00::/16`; table tests cover all four addresses.
5. **F5 effective tests** — DONE (prior agent): (a) forced-failure-between-writes trigger test, (b)
   real-enqueue/real-event rollback race, (c) new file
   `src/__tests__/api/agents-me-webhook-real-action.test.ts` — the REAL action + memory store, secret
   once in POST/never in GET, (d) real local HTTP receiver, 500→retry→disabled, event-less `both`
   delivery, same `X-SafeMolt-Wakeup-Id` on both real attempts.
6. **F6 sweep gated on accepted attempt** — FIXED here (see item 1): SQL-native gate inside the same
   transaction, not a JS `if` outside it.
7. **F7 memory repeated delete** — DONE (prior agent). `webhooks/memory.ts`'s sweep runs even when
   the registration is already absent; `deleted` reports only whether this call removed the row.
8. **F8 comments** — DONE (prior agent). `wakeups/db.ts` and `webhooks/db.ts` comments are ≤5 lines,
   and the "commits" wording is gone (replaced with "the transaction stays open ... fresh snapshot").

## 2. Gate results

- `npx tsc --noEmit` — exit 0, no output.
- `npx eslint <9 fenced files> --max-warnings=0` — exit 0, no warnings (no pre-existing warnings in
  this fence either).
- `npm test -- src/__tests__/lib/webhooks src/__tests__/lib/store/webhooks-memory.test.ts src/__tests__/api/agents-me-webhook.test.ts src/__tests__/lib/events src/__tests__/lib/store/wakeups src/__tests__/lib/worker`
  → 17 suites, 301 tests passed. (Also ran the new
  `src/__tests__/api/agents-me-webhook-real-action.test.ts` alongside — 1 more suite, 302 tests,
  all green.)
- `npm run test:integration -- src/__tests__/integration/m11-2-b1-webhooks.test.ts` — run twice,
  foreground: 20/20 passed both times (~24-28s each).

## 3. Mutation-check evidence (verbatim outcomes)

**F6 SQL gate (my fix).** Changed the sweep's subquery from
`WHERE id = $1::bigint AND claim_token = $2::text` to `WHERE id = $1::bigint` (dropping the token
requirement) and re-ran the F6 integration test solo:
```
● F6: ... rejected (wrong-token) call does not sweep this agent's other pending deliveries
  expect((await ledgerRowForWakeup(pendingWakeup)).terminal_reason).toBeNull();
  Received: "webhook_disabled"
```
The rejected call's sweep fired anyway — exactly the bug F6 names. Restored (`diff` against backup
confirmed byte-identical) — re-ran solo, green.

**F4 IPv6 (prior agent's fix, re-verified).** Reverted `isPublicIPv6`'s final two lines to the old
`return (g[0] & 0xe000) === 0x2000;` (dropping the special-range exclusion) and ran
`deliver.test.ts`: 4 failures, exactly the 4 new round-3 addresses (`2001::1`, `2001:2::1`,
`3fff::1`, `5f00::1`) resolved instead of rejected. Restored, re-ran: 55/55 green.

**F1 lock mode (prior agent's fix).** Changed `lockText`'s `FOR NO KEY UPDATE` to `FOR SHARE` and
ran the "two concurrent successful attempts never deadlock" integration test 3x solo — it stayed
green every time (no 40P01 observed). This mutation did not reliably reproduce the deadlock; the
round-1 report documents the same limitation for a closely related race ("a statement cannot be
paused mid-CTE from the client... inherently probabilistic"). The code itself matches the spec's
literal remedy exactly (uniform `FOR NO KEY UPDATE`, no shared→update upgrade), so I am recording
this as verified-by-code-match plus a passing dedicated test, not a deterministic mutation-kill.
Restored, confirmed byte-identical to the pre-mutation file.

## 4. Not done / deviations

None outstanding against the spec. The one gap (F6's JS-outside-transaction gate) is closed with a
SQL-native gate instead of literal "JS between statements" — the Neon serverless driver's
`sql.transaction()` is documented as **non-interactive** (all statements submitted before any result
returns), so inspecting statement 2's row count in JS before deciding whether to send statement 3 is
not expressible in one atomic transaction with this driver. The SQL-native re-check achieves the
same refusal and additionally keeps the registration lock held for the sweep's whole lifetime, which
the spec's own reasoning (statement-order lock enforcement) argues for.
