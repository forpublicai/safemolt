Findings

1. MAJOR — [webhooks/db.ts:355](/Users/mohsin/Github/safemolt/src/lib/store/webhooks/db.ts:355), [webhooks/memory.ts:203](/Users/mohsin/Github/safemolt/src/lib/store/webhooks/memory.ts:203), [webhook-pass.ts:35](/Users/mohsin/Github/safemolt/src/lib/worker/webhook-pass.ts:35)

   Invariant: P5.1 requires auto-disable to terminalize all unclaimed deliveries in the same operation.

   The tenth failure disables the registration, but it leaves the current row and other unclaimed rows live. The worker also ignores `disabledAt`.

   Thus, the worker can send more HTTP requests after auto-disable. Webhook-primary wakeups also remain incomplete.

   Minimal fix: terminalize all unclaimed rows during auto-disable. Complete their webhook-primary wakeups. Do not send when the claim reports `disabledAt`.

2. MAJOR — [wakeups/db.ts:248](/Users/mohsin/Github/safemolt/src/lib/store/wakeups/db.ts:248), [wakeups/db.ts:163](/Users/mohsin/Github/safemolt/src/lib/store/wakeups/db.ts:163), [wakeups/memory.ts:240](/Users/mohsin/Github/safemolt/src/lib/store/wakeups/memory.ts:240)

   Invariant: each nonterminal webhook-primary wakeup must have one claimable delivery row.

   A re-arm clears the wakeup completion fields. The ledger insert then ignores its conflict with the old terminal ledger row.

   The result pairs a nonterminal wakeup with a terminal delivery. No worker can claim that delivery again.

   Minimal fix: reset the existing ledger row during the same re-arm operation. Apply the same rule to both stores.

3. MAJOR — [wakeups/db.ts:159](/Users/mohsin/Github/safemolt/src/lib/store/wakeups/db.ts:159)

   Invariant: a liveness check must use a row lock. P5.1 requires delete and disable to leave no live delivery.

   The `mode='both'` check uses a bare `EXISTS`. The webhook-primary branch does not recheck the registration.

   A delete can complete its sweep before a concurrent enqueue inserts a new ledger row from an old snapshot.

   Minimal fix: lock the live registration with `FOR SHARE`. Use that locked row to gate the ledger and webhook-primary wakeup.

4. MAJOR — [webhooks/db.ts:109](/Users/mohsin/Github/safemolt/src/lib/store/webhooks/db.ts:109), [webhooks/memory.ts:56](/Users/mohsin/Github/safemolt/src/lib/store/webhooks/memory.ts:56)

   Invariant: delete must terminalize each delivery that has no active claimant.

   Both stores only accept `claimed_at IS NULL`. They treat an expired lease as an active claim.

   A crashed claimant can leave an expired row. A later webhook delete leaves that row and its wakeup nonterminal.

   Minimal fix: also terminalize rows whose lease expired. Keep only claims with a live lease for post-attempt completion.

5. MAJOR — [webhooks/memory.ts:25](/Users/mohsin/Github/safemolt/src/lib/store/webhooks/memory.ts:25), [_memory-state.ts:374](/Users/mohsin/Github/safemolt/src/lib/store/_memory-state.ts:374), [actions/webhooks.ts:50](/Users/mohsin/Github/safemolt/src/lib/actions/webhooks.ts:50)

   Invariant: memory mode must reproduce PostgreSQL foreign-key refusals after each `await`.

   Registration waits for DNS. The agent can withdraw during that wait. Memory mode then creates a registration for the deleted agent.

   Memory agent withdrawal also has no webhook-map cascade. PostgreSQL removes these rows through its foreign keys.

   Minimal fix: recheck the agent immediately before the memory write. Add one shared webhook cascade helper for agent withdrawal.

6. MAJOR — [deliver.ts:59](/Users/mohsin/Github/safemolt/src/lib/webhooks/deliver.ts:59), [deliver.ts:123](/Users/mohsin/Github/safemolt/src/lib/webhooks/deliver.ts:123), [deliver.ts:301](/Users/mohsin/Github/safemolt/src/lib/webhooks/deliver.ts:301)

   Invariant: every resolved address must be public, and the insecure seam must have no production effect.

   The address rules accept non-public ranges such as `198.18.0.0/15`, `240.0.0.0/4`, and `2001:db8::/32`.

   The delivery path also does not apply `validateWebhookUrl`. A stored HTTP URL can expose the secret and payload without TLS.

   Minimal fix: accept only global-unicast addresses. Apply URL validation during every attempt. Add reserved-range and production-path tests.

7. MAJOR — [deliver.test.ts:191](/Users/mohsin/Github/safemolt/src/__tests__/lib/webhooks/deliver.test.ts:191), [webhooks-memory.test.ts:204](/Users/mohsin/Github/safemolt/src/__tests__/lib/store/webhooks-memory.test.ts:204), [m11-2-b1-webhooks.test.ts:196](/Users/mohsin/Github/safemolt/src/__tests__/integration/m11-2-b1-webhooks.test.ts:196)

   Invariant: each P5.1 gate must have a test that fails when the behavior disappears.

   The pin test uses an IP as both the URL host and socket address. It does not prove separate DNS pin and `Host` values.

   No test covers the full worker path, auto-disable disposition, rollback drain, re-arm coupling, or expired-claim deletion.

   The disable test expects the triggering delivery to remain a retry. That expectation preserves the first finding.

   Minimal fix: add focused tests for these gates. Use a named host and an injected address for the pin test.

8. MINOR — [webhooks/db.ts:269](/Users/mohsin/Github/safemolt/src/lib/store/webhooks/db.ts:269)

   Invariant: the statement must supply identifiers that only the statement can know.

   The disabled event uses `input.agentId`, although the token-fenced row already supplies the real agent ID.

   A wrong internal argument can disable agent A but emit agent B’s event and notification. The memory store uses the row ID correctly.

   Minimal fix: remove `agentId` from the input. Derive the event subject and payload from `disabled_now`.

9. MINOR — [route.ts:30](/Users/mohsin/Github/safemolt/src/app/api/v1/agents/me/webhook/route.ts:30)

   A valid JSON body of `null` causes property access on `null`. The route returns a server error instead of HTTP 400.

   Minimal fix: verify that the body is a non-null object before access. Add a route test for JSON `null`.

NOT CONVERGED
CODEX_EXIT=0
