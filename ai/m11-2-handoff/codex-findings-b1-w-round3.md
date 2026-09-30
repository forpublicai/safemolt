171,308
I reviewed the current tree without changes. I accepted the supplied gate results and ran no prohibited checks.

1. **MAJOR — Successful attempts can deadlock.**  
   [webhooks/db.ts:278](/Users/mohsin/Github/safemolt/src/lib/store/webhooks/db.ts:278), [webhooks/db.ts:353](/Users/mohsin/Github/safemolt/src/lib/store/webhooks/db.ts:353)

   **Rule:** The pinned lock rules require compatible lock modes and a consistent order.

   Two successful deliveries for one agent can each acquire `FOR SHARE` on the registration. Both then request an update lock to reset `failure_count`. Each shared lock blocks the other update. PostgreSQL aborts one transaction. Its successful POST remains unrecorded and can repeat after lease expiry. [PostgreSQL lock rules](https://www.postgresql.org/docs/current/explicit-locking.html)

   **Minimal fix:** Use `FOR NO KEY UPDATE` for successful attempts too. Add an overlap test for two successful deliveries.

2. **MAJOR — The reordered CTEs do not enforce the registration-first lock order.**  
   [webhooks/db.ts:285](/Users/mohsin/Github/safemolt/src/lib/store/webhooks/db.ts:285)

   **Rule:** Round-2 F4 requires registration → ledger → wakeup.

   `target` has no dependency on `reg`. Their declaration order does not force the registration lock first. [PostgreSQL CTE rules](https://www.postgresql.org/docs/current/queries-with.html)

   With a plan that evaluates `target` first, a late claimant can lock an expired ledger before the registration. A concurrent delete can hold the registration and wait for that ledger. The two operations then deadlock.

   **Minimal fix:** Acquire the registration lock in an initial transaction statement, or enforce an explicit dependency before the ledger lock. Test the late-attempt/delete overlap.

3. **MAJOR — The webhook body can contain content.**  
   [webhook-pass.ts:49](/Users/mohsin/Github/safemolt/src/lib/worker/webhook-pass.ts:49)

   **Rule:** P5.1 line 328 and Decision 8 permit identifiers and `context_href`, never content.

   `subject: claimed.payload` copies every stored field. A payload with `{post_id, title, content}` sends the title and content inside `subject`.

   The round-2 mutation check only rejects these fields at the top level. It does not prove payload privacy.

   **Minimal fix:** Construct `subject` from an explicit list of permitted identifier fields. Check the complete outbound body for unwanted fields.

4. **MAJOR — The IPv6 check still accepts non-public destinations.**  
   [deliver.ts:164](/Users/mohsin/Github/safemolt/src/lib/webhooks/deliver.ts:164)

   **Rule:** P5.1 line 328 requires every resolved address to be public.

   `2001:2::1` and `3fff::1` pass the final `2000::/3` test. IANA lists their ranges as benchmark and documentation space, respectively. Neither range is globally reachable. [IANA IPv6 registry](https://www.iana.org/assignments/iana-ipv6-special-registry)

   A hostname that resolves to an internally routed benchmark address passes both checks. The sender then attempts an internal connection.

   **Minimal fix:** Exclude non-public special-purpose ranges within `2000::/3`. Add both addresses to the rejection tests.

5. **MAJOR — Several required tests still cannot detect removal of the protected behavior.**  
   [m11-2-b1-webhooks.test.ts:106](/Users/mohsin/Github/safemolt/src/__tests__/integration/m11-2-b1-webhooks.test.ts:106), [m11-2-b1-webhooks.test.ts:562](/Users/mohsin/Github/safemolt/src/__tests__/integration/m11-2-b1-webhooks.test.ts:562), [agents-me-webhook.test.ts:217](/Users/mohsin/Github/safemolt/src/__tests__/api/agents-me-webhook.test.ts:217)

   **Rule:** P5.1 line 330 requires effective tests for atomic completion, rollback, delivery, and security.

   The completion tests inspect final states after successful calls. Separate committed writes would also pass. No test forces a failure between the ledger write and wakeup completion.

   The reported rollback test uses a synthetic event ID, without an event receipt. Its held lock also substitutes for the enqueue function. Thus, it cannot detect removal of that function’s registration lock.

   The secret test mocks `getWebhook` without a secret. A change that exposes the secret in the real action would still pass.

   The local receiver tests also omit the complete 500/retry/disable sequence and repeated event-less delivery.

   **Minimal fix:** Add focused tests with a real receipt, forced transaction failure, actual enqueue overlap, real registration actions, and receiver retries.

6. **MINOR — A rejected claim token can still cause writes.**  
   [webhooks/db.ts:376](/Users/mohsin/Github/safemolt/src/lib/store/webhooks/db.ts:376)

   **Rule:** P5.1 requires every post-claim writer to use the claim token.

   The second transaction statement receives only `input.id`. It runs even when the first statement rejects the token.

   After disable, another delivery’s lease can expire. A stale call can then complete that delivery and its wakeup while it returns `not_found`. Memory mode returns before these writes.

   **Minimal fix:** Gate the sweep on an accepted attempt. Preserve the fresh snapshot and atomic completion.

7. **MINOR — Repeated deletion has different results in memory mode.**  
   [webhooks/memory.ts:72](/Users/mohsin/Github/safemolt/src/lib/store/webhooks/memory.ts:72)

   **Rule:** Memory mode must reproduce PostgreSQL behavior.

   Delete preserves a delivery with a live claim. If its claimant crashes, the lease later expires. A second delete sweeps that row in PostgreSQL. Memory mode exits because the registration is already absent. Its wakeup remains incomplete.

   **Minimal fix:** Run the memory sweep even when the registration is absent. Return the original deletion result afterward.

8. **NIT — Long comments still violate the simplicity rule.**  
   [wakeups/db.ts:143](/Users/mohsin/Github/safemolt/src/lib/store/wakeups/db.ts:143), [webhooks/db.ts:93](/Users/mohsin/Github/safemolt/src/lib/store/webhooks/db.ts:93)

   **Rule:** The common rules limit explanatory comments to five lines.

   These comments repeat implementation details and review history. The delete comment also says the first statement “commits” before the next statement, although the transaction remains open.

   **Minimal fix:** Keep only the lock dependency and fresh-snapshot reason. Remove the repeated history.

The recorded deferrals receive these decisions:

- **Round-1 worker-test deferral: OVERTURN.** The reported focused test now protects the disabled guard. That closes the original forbidden-POST gap.
- **Round-1 rollback-test deferral: OVERTURN.** Item 5 remains open. Separate commits could pass these tests and leave an incomplete wakeup after a crash.
- **Round-1 registration-lock test omission: OVERTURN.** The substitute held lock does not test the actual enqueue lock.
- **Round-2 F4 mutation-check deferral: OVERTURN.** Items 1 and 2 show concrete deadlock risks that sequential outcome tests cannot detect.

NOT CONVERGED
CODEX_EXIT=0
