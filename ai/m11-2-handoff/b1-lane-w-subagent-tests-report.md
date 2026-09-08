# b1 Lane W — subagent report: the last two deliverable-7 test files

Scope: `src/__tests__/integration/m11-2-b1-webhooks.test.ts` (db) and
`src/__tests__/api/agents-me-webhook.test.ts` (route-level, mocked). All upstream deliverables
(1–6: migration, store, kind/consumer wiring, delivery, action/route) were already on disk when
this subagent started — nothing in them was changed except a transient, reverted mutation-check
edit documented below.

## 1. Deliverables

- `src/__tests__/integration/m11-2-b1-webhooks.test.ts` — **done**. 8 tests, real Postgres.
- `src/__tests__/api/agents-me-webhook.test.ts` — **done**. 13 tests, mocked, no DB.

## 2. Gate results

`npx tsc --noEmit` — clean for both files (0 errors attributable to either; pre-existing errors in
`src/__tests__/lib/webhooks/deliver.test.ts`, owned by a different subagent, are unrelated).

`npx eslint src/__tests__/api/agents-me-webhook.test.ts src/__tests__/integration/m11-2-b1-webhooks.test.ts`
— 0 errors, 0 warnings.

`npm test -- src/__tests__/api/agents-me-webhook.test.ts`:
```
PASS src/__tests__/api/agents-me-webhook.test.ts
  POST /api/v1/agents/me/webhook
    ✓ calls registerWebhook with the authenticated agent and the parsed input, returns 200
    ✓ defaults mode to 'primary' when omitted
    ✓ 400s on a missing url without calling the action
    ✓ 400s on an invalid mode without calling the action
    ✓ maps 'webhooks_not_enabled' to 503 with the stable code
    ✓ 401s when unauthenticated, and never calls the action
  GET /api/v1/agents/me/webhook
    ✓ calls getWebhook and returns 200 with a registered webhook
    ✓ returns 200 with data:null for an unregistered agent — never 404
    ✓ 401s when unauthenticated, and never calls the action
  DELETE /api/v1/agents/me/webhook
    ✓ calls removeWebhook and returns 200 with {removed}
    ✓ 401s when unauthenticated, and never calls the action
  secret handling
    ✓ POST's response body carries exactly what registerWebhook returned, secret included once
    ✓ GET never carries a secret key when the action's data has none

Test Suites: 1 passed, 1 total
Tests:       13 passed, 13 total
```

`npm run test:integration -- src/__tests__/integration/m11-2-b1-webhooks.test.ts` (ran immediately,
no lock wait; re-ran solo a second time for confidence — both green):
```
PASS src/__tests__/integration/m11-2-b1-webhooks.test.ts (9.7s)
  claimNextWebhookDelivery — exactly one claimant per row
    ✓ lets exactly one of N concurrent callers claim a reclaimable (expired-lease) row
  recordWebhookAttempt — the token fence
    ✓ reclaims an expired lease and rejects the stale token's update
  terminal-ledger / webhook-primary-wakeup coupling
    ✓ success completes the webhook-primary wakeup
    ✓ exhaustion (3 failures) completes the webhook-primary wakeup
    ✓ removal (deleteAgentWebhook) terminalizes the unclaimed ledger row and completes the wakeup
    ✓ a mode='both' ledger terminalizes WITHOUT completing the internal-primary wakeup it rides beside
  agent withdrawal cascades
    ✓ leaves zero agent_webhooks/webhook_deliveries rows for a deleted agent
  registerWebhook — the two-step rollout gate
    ✓ refuses with 'webhooks_not_enabled' and writes nothing when the flag is unset

Test Suites: 1 passed, 1 total
Tests:       8 passed, 8 total
```

## 3. Mutation-check evidence (verbatim)

Target: `src/lib/store/webhooks/db.ts`, `recordWebhookAttempt`'s `completed_wakeup` CTE, the
`AND ud.wakeup_delivery = 'webhook'` clause — the gate that stops a terminal ledger row from
completing a `mode='both'` internal-primary wakeup.

Step 1 — suppressed the clause:
```diff
        FROM updated_delivery ud
        WHERE w.id = ud.wakeup_id
-         AND ud.wakeup_delivery = 'webhook'
          AND ud.outcome IN ('success', 'exhausted', 'gone', 'disabled')
```

Step 2 — re-ran the full integration file. Exactly one test failed, and only that one — the one
built to catch this class of defect:
```
FAIL src/__tests__/integration/m11-2-b1-webhooks.test.ts
  terminal-ledger / webhook-primary-wakeup coupling
    ✓ success completes the webhook-primary wakeup
    ✓ exhaustion (3 failures) completes the webhook-primary wakeup
    ✓ removal (deleteAgentWebhook) terminalizes the unclaimed ledger row and completes the wakeup
    ✕ a mode='both' ledger terminalizes WITHOUT completing the internal-primary wakeup it rides beside

  ● terminal-ledger / webhook-primary-wakeup coupling › a mode='both' ledger terminalizes WITHOUT completing the internal-primary wakeup it rides beside

    expect(received).toBeNull()
    Received: 2026-09-08T18:35:31.811Z

      106 |     expect(wakeup.completed_at).not.toBeNull();
      107 |   } else {
    > 108 |     expect(wakeup.completed_at).toBeNull();
          |                                 ^
      109 |   }

Tests:       1 failed, 7 passed, 8 total
```
The forbidden state was directly observed: with the gate removed, the internal-primary wakeup's
`completed_at` was wrongly stamped by the webhook success attempt.

Step 3 — reverted the edit (re-added the exact removed line):
```diff
        FROM updated_delivery ud
        WHERE w.id = ud.wakeup_id
+         AND ud.wakeup_delivery = 'webhook'
          AND ud.outcome IN ('success', 'exhausted', 'gone', 'disabled')
```

Step 4 — verified the revert is byte-identical to what I first read (the file is untracked in this
shared working tree, so `git diff` shows nothing regardless of content — I compared the restored
region directly against the content captured at the start of this session; lines match exactly).

Step 5 — final full re-run, confirming genuinely restored and green:
```
PASS src/__tests__/integration/m11-2-b1-webhooks.test.ts (9.7s)
Tests:       8 passed, 8 total
```
`src/lib/store/webhooks/db.ts` is left byte-identical to how it was found. No other implementation
file was touched.

## 4. Shared-file edits

None. This subagent added only the two new test files named above. No edits to
`src/lib/events/kinds.ts`, `coverage.ts`, `store-types.ts`, `store.ts`, `export-manifest.ts`,
`migrate.js`, `migration-ledger.ts`, `actions/types.ts`, or any other shared file — all of the
kind/coverage/notification-type wiring this file's tests rely on (`webhook.disabled` in
`kinds.ts`/`coverage.ts`, `webhook_disabled` in `NotificationType`) was already present from the
earlier deliverables in this lane.

New store exports exercised (not added by me, already exported from
`src/lib/store/webhooks/{db,index}.ts` and `src/lib/store/wakeups/db.ts`):
`upsertAgentWebhook`, `getAgentWebhook`, `deleteAgentWebhook`, `claimNextWebhookDelivery`,
`recordWebhookAttempt`, `enqueueWakeup` — all mutating/reading per the existing manifest
classification from the earlier deliverable; I made no `export-manifest.ts` changes.

## 5. Out-of-fence needs and cross-lane notes

- None encountered. `deleteAgent` (`src/lib/store/agents/db.ts`) was used read-only (called, not
  edited) for the withdrawal-cascade test — it already opens with `posts`/`comments` locks in id
  order per CLAUDE.md's `deleteAgent` invariant, and worked against a fixture agent with none of
  either, no complication.
- Minor ambiguity, not a bug: `claimNextWebhookDelivery`'s `ORDER BY wd.next_attempt_at LIMIT 1`
  gives ties (rows inserted in the same instant) no deterministic tiebreak by `id`, unlike
  `wakeups/memory.ts`'s claim which explicitly breaks ties by ascending id for reproducibility. The
  db statement doesn't need one (Postgres's own order is fine for correctness), but it means a test
  seeding multiple same-instant candidate rows and asserting *which* one is claimed first cannot
  rely on insertion order — I worked around this in the withdrawal-cascade test by branching on
  whichever wakeup the first claim actually returned, rather than assuming order. Flagging in case
  a future test in this family assumes id-order determinism against the db store.
- `beforeAll`/index-orphan judgment: I did **not** add any index-orphan neutralization for
  `idx_webhook_deliveries_claim_scan` / `idx_webhook_deliveries_lease`. Both are ordinary
  (non-unique) performance indexes, not "one row per scope" partial unique indexes like
  `idx_wakeups_one_inflight` or the playground "one live session per school" index that the
  wakeup-router suite neutralizes. Every constraint `webhook_deliveries` actually carries
  (`UNIQUE (wakeup_id)`) is scoped to a single wakeup row created fresh per test, and every fixture
  hangs off a RUN-suffixed agent id — so a prior interrupted run cannot leave anything here that
  blocks a fresh insert. `m11-2-u5-wakeups.test.ts`, this file's own template, does the same
  (no neutralization, just RUN-suffixed ids + explicit `afterAll` cleanup), so this follows house
  convention rather than deviating from it.

## 6. Docs delta

No public-docs-visible behavior was added by this subagent (webhooks REST surface docs are covered
by the deliverable-5 action/route author, not by test authorship). Nothing to add here.

## 7. Behavior changes or plan deviations

None. Both files implement exactly the gate list in `b1-lane-w-webhooks-spec.md` deliverable 7's
last two bullets, against the store/action/route code as found. No implementation behavior was
changed (the one implementation edit was transient and fully reverted, verified above).
