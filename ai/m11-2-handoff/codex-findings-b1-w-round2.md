148,605
I reviewed the current tree without changes. I accepted the supplied gate results and ran no prohibited checks.

1. **MAJOR — A webhook-primary wakeup can lack a delivery row.**  
   [wakeups/db.ts:193](/Users/mohsin/Github/safemolt/src/lib/store/wakeups/db.ts:193), [wakeups/memory.ts:237](/Users/mohsin/Github/safemolt/src/lib/store/wakeups/memory.ts:237)

   **Rule:** P5.1 requires atomic creation of the wakeup and its delivery row.

   The resolver returns `webhook`. Then a delete removes the registration. The enqueue still creates the wakeup, but the registration check prevents its delivery row. No delivery worker can complete that wakeup. Re-arm has the same gap.

   **Minimal fix:** Gate the webhook-primary insert and re-arm on the locked registration, before either mutation. Apply the same rule in memory.

2. **MAJOR — The disposition sweep can miss a concurrent enqueue.**  
   [webhooks/db.ts:108](/Users/mohsin/Github/safemolt/src/lib/store/webhooks/db.ts:108), [webhooks/db.ts:396](/Users/mohsin/Github/safemolt/src/lib/store/webhooks/db.ts:396)

   **Rule:** P5.1 requires delete and disable to complete all unclaimed deliveries atomically.

   An enqueue holds the registration lock and creates an uncommitted delivery. A delete starts, then waits for that lock. After the enqueue commits, the delete proceeds. Its original snapshot cannot see the new delivery. The disable sweep has the same gap. PostgreSQL does not refresh the whole statement snapshot after a lock wait. [PostgreSQL isolation rules](https://www.postgresql.org/docs/current/transaction-iso.html)

   **Minimal fix:** Acquire the registration lock in an initial transaction statement. Run the coupled disposition statement under the next snapshot.

3. **MAJOR — An internal re-arm clears an active webhook claim.**  
   [wakeups/db.ts:164](/Users/mohsin/Github/safemolt/src/lib/store/wakeups/db.ts:164), [wakeups/memory.ts:195](/Users/mohsin/Github/safemolt/src/lib/store/wakeups/memory.ts:195)

   **Rule:** P5.1 requires independent channel state and one claimant per attempt window.

   In `both` mode, an internal tick can finish unsuccessfully while its webhook request remains active. An internal re-arm clears the webhook token and lease. Another worker can immediately send the same delivery. The first worker then loses its result.

   **Minimal fix:** Preserve an existing `both` ledger across internal re-arms. Restrict the reset to terminal webhook-primary deliveries.

4. **MAJOR — Attempt completion and delete use opposite lock orders.**  
   [webhooks/db.ts:303](/Users/mohsin/Github/safemolt/src/lib/store/webhooks/db.ts:303), [webhooks/db.ts:108](/Users/mohsin/Github/safemolt/src/lib/store/webhooks/db.ts:108)

   **Rule:** The pinned lock rules require a consistent order.

   A late attempt holds an expired delivery row and requests the registration lock. A concurrent delete holds the registration and requests that delivery row. PostgreSQL detects a deadlock and aborts one operation. An expired attempt can also conflict with the disable sweep. [PostgreSQL lock rules](https://www.postgresql.org/docs/current/explicit-locking.html)

   **Minimal fix:** Establish one lock order across enqueue, re-arm, delete, and attempt completion. Recheck the claim token under those locks.

5. **MAJOR — The IPv6 check still accepts non-public addresses.**  
   [deliver.ts:157](/Users/mohsin/Github/safemolt/src/lib/webhooks/deliver.ts:157)

   **Rule:** P5.1 permits only public destination addresses.

   `fec0::1` passes every check. IANA reserves `fec0::/10`, formerly the site-local range. A hostname that resolves to a reachable internal address in this range passes registration and attempt validation. The sender then attempts an internal connection. [IANA IPv6 registry](https://www.iana.org/assignments/ipv6-address-space)

   **Minimal fix:** Accept supported public ranges explicitly. Reject the remaining reserved and local ranges. Add rejection cases beyond the round-1 examples.

6. **MAJOR — DNS runs outside the total timeout.**  
   [deliver.ts:347](/Users/mohsin/Github/safemolt/src/lib/webhooks/deliver.ts:347), [deliver.ts:315](/Users/mohsin/Github/safemolt/src/lib/webhooks/deliver.ts:315)

   **Rule:** P5.1 requires a ten-second total timeout.

   The timer starts after DNS returns. A slow resolver can exceed the thirty-second claim lease. Another runtime can reclaim the delivery before the first sender starts its POST. The first sender can then issue a duplicate request.

   **Minimal fix:** Start the deadline before DNS. Refuse a late DNS result before any socket request. Give the socket only the remaining time.

7. **MAJOR — The memory registration check still has an await gap.**  
   [actions/webhooks.ts:57](/Users/mohsin/Github/safemolt/src/lib/actions/webhooks.ts:57), [webhooks/memory.ts:25](/Users/mohsin/Github/safemolt/src/lib/store/webhooks/memory.ts:25)

   **Rule:** Memory mode must reproduce foreign-key refusals after every await.

   `getAgentById` can return the agent, then yield at the action’s `await`. Withdrawal can remove the agent before the continuation resumes. The memory upsert never checks the agent and creates an orphan registration. PostgreSQL refuses that insert.

   **Minimal fix:** Check the shared agent map inside the memory upsert, immediately before the write. Test withdrawal during the final read’s await.

8. **MAJOR — Required tests remain absent or ineffective.**  
   [webhook-pass.ts:33](/Users/mohsin/Github/safemolt/src/lib/worker/webhook-pass.ts:33), [deliver.test.ts:291](/Users/mohsin/Github/safemolt/src/__tests__/lib/webhooks/deliver.test.ts:291), [m11-2-b1-webhooks.test.ts:101](/Users/mohsin/Github/safemolt/src/__tests__/integration/m11-2-b1-webhooks.test.ts:101)

   **Rule:** P5.1 line 330 requires tests that detect removal of each protected behavior.

   **Worker-test deferral: OVERTURN.** No scoped test calls the delivery pass. Removal of its disabled-registration check can restore forbidden POSTs without a test failure. A focused pass test is sufficient.

   **Rollback-test deferral: OVERTURN.** The coupling helper checks only final state after successful calls. It does not test a receipted event, pending delivery, or rollback completion. Finding 1 can leave zero pending deliveries beside an incomplete wakeup.

   The body-cap test also passes without the cap because its finite response ends normally. The DNS test calls only the resolver helper. No scoped test checks the actual worker payload for content.

   **Minimal fix:** Add focused pass, rollback, interrupted-coupling, body-cap, and payload tests. Verify each test through removal of the protected behavior.

9. **MINOR — The drain duty bypasses the shutdown signal.**  
   [event-drain-pass.ts:164](/Users/mohsin/Github/safemolt/src/lib/worker/event-drain-pass.ts:164), [worker/index.ts:142](/Users/mohsin/Github/safemolt/worker/index.ts:142)

   **Rule:** The lane requires a stop check before every new claim.

   The dedicated webhook duty receives `isShuttingDown`. The drain duty also delivers webhooks, but supplies no stop signal. After SIGTERM, an active drain can continue to claim and send new requests.

   **Minimal fix:** Pass the worker’s stop signal through the drain pass to its webhook pass.

10. **MINOR — Unused input and long comments violate the simplicity rules.**  
    [webhooks/db.ts:225](/Users/mohsin/Github/safemolt/src/lib/store/webhooks/db.ts:225), [webhooks/db.ts:257](/Users/mohsin/Github/safemolt/src/lib/store/webhooks/db.ts:257)

    **Rule:** The common rules prohibit unused options and limit explanatory comments to five lines.

    `RecordWebhookAttemptInput.agentId` remains mandatory although neither store uses it. Callers must supply redundant data. The 26-line attempt comment repeats the code and increases review effort.

    **Minimal fix:** Remove `agentId` from the input and callers. Reduce the comment to the non-obvious lock and coupling rules.

NOT CONVERGED
CODEX_EXIT=0
