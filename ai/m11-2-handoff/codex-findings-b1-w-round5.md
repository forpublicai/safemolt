180,967
I made no file changes. I accepted the supplied gate results. I ran no prohibited commands.

1. **MAJOR — Withdrawal can still deadlock with delivery completion.**  
   [webhooks/db.ts:269](/Users/mohsin/Github/safemolt/src/lib/store/webhooks/db.ts:269), [webhooks/db.ts:100](/Users/mohsin/Github/safemolt/src/lib/store/webhooks/db.ts:100)

   **Rule:** The round-4 spec requires agent → registration → delivery → wakeup lock order.

   Completion and deletion still start with the registration. The SQL permits a cycle during a wakeup-first withdrawal cascade. The attempt holds the delivery row. Withdrawal holds its wakeup and waits for the delivery. Completion then waits for the wakeup. PostgreSQL aborts one operation. [PostgreSQL lock rules](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-DEADLOCKS)

   **Minimal fix:** Acquire the agent’s `FOR KEY SHARE` lock before the registration in both operations. Add a controlled withdrawal overlap test.

2. **MAJOR — The address check accepts a non-public destination.**  
   [deliver.ts:64](/Users/mohsin/Github/safemolt/src/lib/webhooks/deliver.ts:64)

   **Rule:** P5.1 line 328 requires every resolved address to be public.

   The read-only probe accepted `192.88.99.2` and `::ffff:192.88.99.2`. IANA marks `192.88.99.2` as not globally reachable. [IANA registry](https://www.iana.org/assignments/iana-ipv4-special-registry)

   A hostname that resolves to this locally routed address passes registration and attempt checks. The sender can then attempt a connection to that non-public destination.

   **Minimal fix:** Reject this address in the IPv4 check. Cover both forms in registration and delivery tests.

3. **MAJOR — The registration-lock test still masks removal of enqueue’s lock.**  
   [m11-2-b1-webhooks.test.ts:637](/Users/mohsin/Github/safemolt/src/__tests__/integration/m11-2-b1-webhooks.test.ts:637)

   **Rule:** P5.1 line 330 and round-4 F2(b) require an effective test of the actual enqueue lock.

   A separate connection holds the registration lock. Enqueue finishes before that connection releases the lock. Removing enqueue’s own `FOR SHARE` would still pass this test.

   That regression permits enqueue to commit a delivery after deletion completes its sweep.

   **Minimal fix:** Pause the actual enqueue before commit. Prove that deletion waits for enqueue’s lock. Confirm that removal of that lock fails the test.

4. **MINOR — The context link points to the home page.**  
   [webhook-pass.ts:76](/Users/mohsin/Github/safemolt/src/lib/worker/webhook-pass.ts:76)

   **Rule:** P5.1 and Decision 8 require the external wakeup’s `context_href`.

   Every payload supplies `/`. An external receiver that follows this link receives the website instead of its authenticated agent context.

   **Minimal fix:** Use `/api/v1/agents/me/context`. Assert that link in the delivery-pass test.

5. **MINOR — Valid IPv6 literal URLs fail resolution.**  
   [actions/webhooks.ts:51](/Users/mohsin/Github/safemolt/src/lib/actions/webhooks.ts:51), [deliver.ts:381](/Users/mohsin/Github/safemolt/src/lib/webhooks/deliver.ts:381)

   **Rule:** P5.1 permits valid HTTPS URLs with public addresses.

   `URL.hostname` preserves brackets in `https://[2606:4700::1111]/hook`. The Node probe resolved the unbracketed address but returned `ENOTFOUND` for the bracketed form. Registration therefore rejects a valid public IPv6 endpoint.

   **Minimal fix:** Remove IPv6 brackets before address resolution and socket setup. Preserve valid HTTP Host formatting. Add a literal-address test.

6. **NIT — Comment essays remain.**  
   [webhooks/memory.ts:173](/Users/mohsin/Github/safemolt/src/lib/store/webhooks/memory.ts:173), [wakeups/memory.ts:184](/Users/mohsin/Github/safemolt/src/lib/store/wakeups/memory.ts:184)

   **Rule:** The common rules limit explanatory comments to five lines.

   These comments repeat implementation details and fix history. They increase review effort and duplicate the reports.

   **Minimal fix:** Keep only the non-obvious atomicity and reset conditions.

The recorded deferrals receive these decisions:

- **Worker-test deferral: OVERTURN, now addressed by the reported focused tests.** Those tests protect against forbidden POSTs and content exposure. A full-process test is unnecessary.
- **Rollback-test deferral: OVERTURN, now addressed.** The receipt and forced-failure tests protect against an incomplete wakeup after a committed delivery.
- **Registration-lock test omission: OVERTURN, still open.** Finding 3 identifies the remaining gap.
- **Round-2 and round-3 lock mutation deferrals: OVERTURN.** Round 4 addresses the successful-attempt case. Finding 1 identifies a separate withdrawal cycle.
- **Same-time claim ordering: UPHOLD.** Either due row is valid. No correctness rule requires an ID-based tie order.

NOT CONVERGED
CODEX_EXIT=0
