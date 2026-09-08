# b1 Lane W — fix round 1 report (webhooks)

Generation-2 fix agent, continuing a generation-1 agent interrupted by a rate limit. Findings 4 and
8 were already fixed and committed to disk (uncommitted) when this agent started; findings 1, 2, 3,
5, 6, 7, 9 were not started or partial. All nine are now closed except item 7's two explicitly
deferred sub-items (recorded, not built, per the spec).

## 1. Deliverables

| # | Finding | State at start | State now | Files |
|---|---|---|---|---|
| 1 | Auto-disable disposition | db: outcome CASE + `disable_sweep` done. Memory: not started. `webhook-pass.ts`: not started. | **Done**, both stores + worker | `src/lib/store/webhooks/db.ts`, `src/lib/store/webhooks/memory.ts`, `src/lib/worker/webhook-pass.ts` |
| 2 | Re-arm resets the ledger | Not started | **Done**, both stores | `src/lib/store/wakeups/db.ts`, `src/lib/store/wakeups/memory.ts` |
| 3 | Registration liveness is a lock | Not started | **Done** | `src/lib/store/wakeups/db.ts` (+ memory eligibility parity) |
| 4 | Delete terminalizes expired claims | Done, both stores | Unchanged (verified) | `src/lib/store/webhooks/db.ts`, `src/lib/store/webhooks/memory.ts` |
| 5 | Memory-mode actor parity | Not started | **Done**, both halves | `src/lib/actions/webhooks.ts` (5a), `src/lib/store/webhooks/memory.ts` + `src/lib/store/agents/memory.ts` (5b) |
| 6 | SSRF ranges + per-attempt validation | Ranges + per-attempt validation done; table-driven tests missing | **Done**, tests added | `src/lib/webhooks/deliver.ts` (unchanged from start), `src/__tests__/lib/webhooks/deliver.test.ts` |
| 7 | Tests | Missing (pin test stale, no disposition/re-arm/expired-claim tests) | **Done** except two explicit deferrals | see test files below |
| 8 | Event subject from the row | Done | Unchanged (verified) | `src/lib/store/webhooks/db.ts` |
| 9 | JSON `null` body | Not started | **Done** | `src/app/api/v1/agents/me/webhook/route.ts` |

Deferred (recorded, not built, per item 7): a "full worker path" e2e test for `webhook-pass.ts`, and
a "rollback drain" test (a runbook step, not a unit-testable code path).

### Code changes, by file

- `src/lib/store/wakeups/db.ts` — `webhookLedgerCte` rewritten: the registration is now read via a
  `${prefix}_reg` CTE taken `FOR SHARE` (F3), gating BOTH the webhook-primary and `mode='both'`
  branches (a webhook-primary insert now also requires the registration to still be live at insert
  time, not merely at the earlier `resolveWakeupDelivery` read). A new `rearmCteName` parameter makes
  the ledger insert `ON CONFLICT (wakeup_id) DO UPDATE` — resetting `attempts, delivered_at,
  last_status, last_attempt_at, terminal_reason, claimed_at, claim_token, lease_expires_at,
  next_attempt_at` — gated on `EXISTS (SELECT 1 FROM rearmed WHERE rearmed.id = ...wakeup_id)` (F2).
  Both `createOrReArmWakeup` and `createOrReArmPlaygroundRoundWakeup` now pass `"rearmed"` as that
  name; `enqueueWakeup` passes nothing (no re-arm CTE exists on that path, so it stays `DO NOTHING`).
- `src/lib/store/wakeups/memory.ts` — `createWebhookLedgerRowIfNeeded` gained a `resetOnRearm`
  parameter (F2) and its eligibility check now requires a live registration for BOTH branches (F3
  parity, since memory has no lock to reproduce but must match the corrected decision). New
  `resetLedgerRow` helper. Both re-arm call sites pass `true`.
- `src/lib/store/webhooks/memory.ts` — `classifyAttemptOutcome` now reclassifies to `disabled` when
  crossing the threshold, before the exhaustion check (F1). `applyRecordedAttempt` takes a
  `liveFailure` flag (mirrors the db `live_failure` predicate) instead of gating the counter bump on
  `outcome === 'exhausted' || 'retry'`, which would have missed the newly-added `disabled` case. New
  `sweepDisabledAgentLedgers` (F1's disposition sweep) and `forgetWebhooksFor` (F5b cascade) added.
- `src/lib/worker/webhook-pass.ts` — `attemptOne` now also treats `claimed.disabledAt !== null` as
  "nothing to deliver to", same branch as a missing url/secret (F1's worker-side half).
- `src/lib/actions/webhooks.ts` — `registerWebhook` re-checks the acting agent by id
  (`getAgentById`) immediately after the DNS-resolving `await`, before the write (F5a).
- `src/lib/store/agents/memory.ts` — `deleteAgent` now calls `forgetWebhooksFor(agentId)` (F5b),
  one import + one call, at the same anchor as the other per-domain sweep calls.
- `src/app/api/v1/agents/me/webhook/route.ts` — body parsing extracted into `parseRegisterBody`,
  which refuses a non-object/`null`/array body with 400 before any property read (F9, kept out of
  `POST` itself to hold complexity under 12). `webhookRefusal` gained a `not_found` → 404 case.
- `src/lib/store/webhooks/db.ts`, `src/lib/store/webhooks/memory.ts` (F1/F4/F8) — unchanged from
  what generation-1 left; re-verified by full mutation-check (see below).

## 2. Gate results

```
$ npx tsc --noEmit
(no output — clean; the only errors seen mid-session were in files outside this fence,
 touched by concurrent lanes M/R/D — e.g. reactions-memory.test.ts, m11-2-b1-mentions.test.ts)

$ npx eslint <13 files listed> --max-warnings=0
/Users/mohsin/Github/safemolt/src/lib/store/agents/memory.ts
   378:8  warning  Async function 'deleteAgent' has a complexity of 13. Maximum allowed is 12
   475:8  warning  Async function 'followAgent' has a complexity of 14. Maximum allowed is 12
   876:1  warning  Function 'deleteEvaluationMemoryForAgent' has a complexity of 15. Max is 12
  1060:8  warning  Async function 'completeVetting' has a complexity of 18. Maximum allowed is 12
✖ 4 problems (0 errors, 4 warnings)
```
All four are **pre-existing**, verified by running eslint against `git show HEAD:...memory.ts`
(the committed baseline before this round's edits) — identical four warnings, same functions, same
complexity numbers. This lane's own new/changed functions (`parseRegisterBody`, the wakeups ledger
CTE builder, the memory disposition sweep, etc.) carry no warnings.

```
$ npm test -- src/__tests__/lib/webhooks src/__tests__/lib/store/webhooks-memory.test.ts \
    src/__tests__/api/agents-me-webhook.test.ts src/__tests__/lib/events \
    src/__tests__/lib/store/wakeups src/__tests__/lib/worker
Test Suites: 15 passed, 15 total
Tests:       283 passed, 283 total
```

```
$ npm run test:integration -- src/__tests__/integration/m11-2-b1-webhooks.test.ts
PASS src/__tests__/integration/m11-2-b1-webhooks.test.ts (15.034 s)
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
    ✓ F5: refuses 'not_found' (not a raised 23503) when the acting agent was withdrawn before the write
  F1: auto-disable disposition sweep
    ✓ crossing the threshold terminalizes pending and expired-claim rows, leaves a live claim alone
  F4: delete terminalizes an expired-lease claim, not just an unclaimed row
    ✓ sweeps an expired-claim ledger row exactly like an unclaimed one
  F2: re-arm resets a stale terminal ledger row
    ✓ exhausts, re-arms, and finds ONE ledger row that is claimable again
Test Suites: 1 passed, 1 total
Tests:       12 passed, 12 total
```

One flaky-looking intermediate result during mutation-checking is explained in section 3 below
(concurrent lane contention on the shared reserved DB, resolved by a solo re-run per
`b1-common-rules.md`'s own guidance — not a defect in this lane's code).

## 3. Mutation-check evidence (verbatim)

**F1 memory reclassification** — commented out
`if (registration.failureCount + 1 >= 10) return "disabled";` in `classifyAttemptOutcome`:
```
✕ the 10th failure reclassifies THIS attempt as disabled (F1) and the notification appears
  Expected: "disabled"   Received: "retry"
✕ F1 disposition: crossing the threshold also terminalizes pending and expired-claim rows...
  Expected: "disabled"   Received: "retry"
```
Restored → 13/13 pass.

**F1 memory disposition sweep** — removed the `sweepDisabledAgentLedgers` call:
```
✕ F1 disposition: crossing the threshold also terminalizes pending and expired-claim rows...
  Expected: "webhook_disabled"   Received: null
```
Restored → 13/13 pass.

**F5b memory cascade** — removed `forgetWebhooksFor(agentId);` from `deleteAgent`:
```
✕ deleteAgent sweeps the webhook registration and every ledger row for that agent
  expect(agentWebhooks.has(agent.id)).toBe(false)   Expected: false   Received: true
```
Restored → 13/13 pass.

**F2 memory re-arm reset** — reverted both `createWebhookLedgerRowIfNeeded(existing, true)` call
sites back to `createWebhookLedgerRowIfNeeded(existing)`:
```
✕ exhausts, re-arms, and finds ONE ledger row that is claimable again
  expect(reset.terminalReason).toBeNull()   Received: "exhausted"
```
Restored → 13/13 pass.

**F2 db re-arm reset** — reverted `src/lib/store/wakeups/db.ts` to the git-committed (pre-fix)
version, ran the integration suite:
```
✕ F2: re-arm resets a stale terminal ledger row › ... finds ONE ledger row that is claimable again
  expect(rows[0].terminal_reason).toBeNull()   Received: "exhausted"
(11 other tests in the file still passed — F2 is isolated to this CTE)
```
Restored → 12/12 pass (see gate output above).

**F1/F4/F8 db (webhooks/db.ts)** — reverted `src/lib/store/webhooks/db.ts` to the git-committed
(pre-fix) version, ran the integration suite:
```
✕ F1: auto-disable disposition sweep › crossing the threshold ...
  expect(outcome).toBe("disabled")   Received: "retry"
✕ F4: delete terminalizes an expired-lease claim ...
  expect(ledger.terminal_reason).not.toBeNull()   Received: null
```
(The F2 re-arm test in this same mutated run showed one contended, non-reproducible result —
`Expected: "exhausted", Received: "disabled"` — while `wakeups/db.ts` was still fixed. A solo
re-run of only that test against the identical mutated tree passed as expected (`"exhausted"`),
and the log showed this session's run had waited on `[integration] waiting for the integration
lock — held by ... pid=...` immediately before — i.e. a concurrent lane's process was active on
the same shared reserved DB moments earlier. Per `b1-common-rules.md`'s own guidance ("a first-time
failure of a race test: re-run the suite SOLO before diagnosing (Neon resets)"), this is recorded as
cross-lane contention, not a defect.) Restored → 12/12 pass.

**F5a actor recheck** — removed the `getAgentById` re-check block from `registerWebhook`:
```
✕ F5: refuses 'not_found' (not a raised 23503) when the acting agent was withdrawn before the write
  NeonDbError: insert or update on table "agent_webhooks" violates foreign key constraint
  "agent_webhooks_agent_id_fkey"
```
This is a stronger result than a wrong refusal code — without the fix the route would 500 on this
race, since nothing catches the FK violation. Restored → passes cleanly.

**F6 SSRF ranges** — removed `(a) => a >= 240,` from `V4_NON_PUBLIC_RANGES`:
```
✕ rejects reserved 240/4 (240.0.0.1)     Resolved to value: ["240.0.0.1"]
✕ rejects broadcast (255.255.255.255)    Resolved to value: ["255.255.255.255"]
```
Restored → 46/46 pass.

**F9 null body** — removed the object-type guard from `parseRegisterBody`:
```
✕ F9: 400s on a JSON `null` body instead of throwing on property access
  TypeError: Cannot read properties of null (reading 'url')
    at route.ts:50:19
```
Restored → 16/16 pass.

**Not mutation-tested**: `webhook-pass.ts`'s `claimed.disabledAt !== null` check (F1's worker half).
No test file exists for `webhook-pass.ts` and a "full worker path" e2e is item 7's own explicit
deferral; the change is a one-line addition to an existing OR-condition, verified by inspection.

**Item 3 (registration FOR SHARE lock)**: the row-lock's serialization guarantee is inherently a
concurrency property; no test in this file exercises the specific race (a concurrent
`deleteAgentWebhook` interleaved with an in-flight enqueue). It was exercised indirectly — every
existing and new enqueue/re-arm/disable/delete test passed with the eligibility check now also
covering the webhook-primary branch (previously ungated), so the decision-logic half of F3 is
covered; the lock's interleaving guarantee is asserted by code review against `deleteAgentWebhook`'s
own `DELETE FROM agent_webhooks` taking the same row.

## 4. Shared-file edits

- `src/lib/store/agents/memory.ts` (shared with lane M) — re-read immediately before editing both
  times (once for the import, once for the `deleteAgent` call site); added one import line
  (`import { forgetWebhooksFor } from "../webhooks/memory";`) and one call
  (`forgetWebhooksFor(agentId);`) directly after the existing `forgetNotificationsForRecipient`
  call, at the same anchor point every other domain's withdrawal sweep uses. No other lines touched.
- `src/lib/store/_memory-state.ts` — **not touched**. The webhook maps (`agentWebhooks`,
  `webhookDeliveries`) already existed there from generation-1's work; no new state was needed.
- No new store exports beyond what generation-1 already added; `forgetWebhooksFor` is a new export
  of `src/lib/store/webhooks/memory.ts` (not the facade — it is a cross-domain sweep helper, called
  directly by `agents/memory.ts`, the same pattern `forgetNotificationsForRecipient` uses). It is not
  agent-visible and does not need an `export-manifest.ts` entry (it is not re-exported through
  `store.ts`).

## 5. Out-of-fence needs and cross-lane notes

None. All nine findings were within lane W's declared fence. No collisions were observed on
`agents/memory.ts` beyond the expected re-read/retry protocol (no "modified since read" errors this
session; the file's `countActiveNowFollowees` edits from lane M were already on disk before this
agent's first read and were left untouched throughout).

## 6. Docs delta

None required. All nine fixes are internal correctness/security hardening (SSRF ranges, ledger
disposition/re-arm bookkeeping, actor-withdrawal races, input validation) with no change to the
documented request/response contract of `POST/GET/DELETE /api/v1/agents/me/webhook` or to any
`public/*.md`/`openapi.json` surface. The one new observable status code — 404 `not_found` for the
rare actor-withdrawn-during-registration race — is not itself worth enumerating in the public
reference (no other action's race-refusal codes are individually documented there either).

## 7. Behavior changes or plan deviations

- **`resolvePublicAddresses`/`deliverWakeup` behavior change (F6, generation-1, re-verified here)**:
  a webhook URL resolving to `240.0.0.0/4`, `255.255.255.255`, `198.18.0.0/15`, the three TEST-NET
  blocks, `192.0.0.0/24`, `2001:db8::/32`, or a NAT64/6to4 address embedding any of the above is now
  refused where it previously was not. This narrows what a registered webhook can point at; no
  legitimate public target is affected.
- **`recordWebhookAttempt` outcome change (F1)**: the delivery attempt that crosses the 10-failure
  threshold now reports `disabled` instead of `retry`/`exhausted` for that same attempt, and every
  other unclaimed-or-expired ledger row of that agent is terminalized in the same call. A caller
  (the worker) that previously saw `retry`/`exhausted` and rescheduled will now see `disabled` and
  stop — this is the fix's entire purpose (P5.1's own auto-disable contract).
- **Ledger re-arm change (F2)**: a re-armed wakeup's stale terminal ledger row is now reset in place
  rather than left terminal; a re-armed webhook-primary wakeup is claimable again immediately, where
  before it was a nonterminal wakeup permanently paired with a terminal, unclaimable delivery row.
- **Webhook-primary enqueue now also requires a live registration (F3)**: previously a wakeup with
  `delivery = 'webhook'` always got a ledger row; now it additionally requires the registration to
  still exist and be undisabled at insert time (locked). This only changes behavior in the race
  window the fix targets (concurrent delete/disable), never in the ordinary path where
  `resolveWakeupDelivery` and this insert observe the same live state.
- **`registerWebhook` now performs one extra read** (`getAgentById`) on every call, in both stores,
  to close the withdrawal race (F5a). Negligible cost; no behavior change on the ordinary path.
