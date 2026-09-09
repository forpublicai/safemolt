# b1 Lane W — fix round 2 report (webhooks)

All ten codex round-2 findings closed, including the two round-1 test deferrals codex overturned
(worker-pass test, interrupted-coupling/rollback test). Domain lock order (registration → ledger →
wakeup) applied to every path named in the spec.

## 1. Deliverables

| # | Finding | Files | State |
|---|---|---|---|
| F1 | No ledger-less webhook-primary wakeup | `src/lib/store/wakeups/db.ts`, `src/lib/store/wakeups/memory.ts` | Done, both stores |
| F2 | Disposition under a fresh snapshot | `src/lib/store/webhooks/db.ts` (`deleteAgentWebhook`, `recordWebhookAttempt`) | Done |
| F3 | Re-arm preserves an active `both` ledger | `src/lib/store/wakeups/db.ts`, `src/lib/store/wakeups/memory.ts` | Done, both stores |
| F4 | Attempt completion lock order | `src/lib/store/webhooks/db.ts` (`recordWebhookAttempt`) | Done |
| F5 | IPv6 allowlist | `src/lib/webhooks/deliver.ts` | Done |
| F6 | Deadline covers DNS | `src/lib/webhooks/deliver.ts` | Done |
| F7 | Memory upsert re-checks the agent | `src/lib/store/webhooks/memory.ts` | Done |
| F8 | Tests (deferrals overturned) | new/edited test files, listed below | Done, (a)(b)(c)(d) all added |
| F9 | Stop signal through the drain pass | `src/lib/worker/event-drain-pass.ts`, `worker/index.ts` | Done |
| F10 | KISS (drop unused field, trim comment) | `src/lib/store/webhooks/db.ts`, `src/lib/worker/webhook-pass.ts` | Done |

### Code changes, by file

- `src/lib/store/wakeups/db.ts` — new `registrationCte()` (shared `FOR SHARE` lock, keyed by `$1`),
  `insertWakeupSql()` and `rearmWebhookGate()` gate the wakeup INSERT/re-arm itself on a live
  registration whenever `delivery = 'webhook'` (F1). `webhookLedgerCte`'s `ON CONFLICT DO UPDATE`
  reset now requires `terminal_reason IS NOT NULL` AND the row's own `delivery = 'webhook'` (via a
  self-join back to `rowName`, since `EXCLUDED` cannot see it) — F3. All three enqueue/re-arm
  functions (`enqueueWakeup`, `createOrReArmWakeup`, `createOrReArmPlaygroundRoundWakeup`) updated.
- `src/lib/store/wakeups/memory.ts` — `webhookRegistrationLive()` gates the fresh-insert and re-arm
  branches of all three functions the same way (F1); `createWebhookLedgerRowIfNeeded`'s reset now
  requires `row.terminalReason !== null && wakeup.delivery === "webhook"` (F3).
- `src/lib/store/webhooks/db.ts` — `deleteAgentWebhook` is now a two-statement `sql.transaction`:
  statement 1 the DELETE, statement 2 the coupled disposition sweep under a fresh snapshot (F2).
  `recordWebhookAttempt` reorders its CTEs to lock the registration FIRST (`FOR SHARE`/`FOR NO KEY
  UPDATE` chosen from `input.ok`, before the token-fenced `target`), and its `disable_sweep`/
  `disable_sweep_wakeups` CTEs are now a SEPARATE statement 2 (same `sql.transaction`), gated on a
  fresh read of `disabled_at` rather than the first statement's own snapshot (F2+F4). Comment on
  `recordWebhookAttempt` cut from 26 lines to 5 (F10). `RecordWebhookAttemptInput.agentId` removed
  (F10) — the statement already derives agent_id from the delivery row's own immutable column.
- `src/lib/store/webhooks/memory.ts` — `upsertAgentWebhook` re-checks `agents.has(input.agentId)`
  immediately before the write and throws a `23503`-shaped error otherwise (F7), matching the
  established convention in `agents/memory.ts`'s `createVettingChallenge`.
- `src/lib/webhooks/deliver.ts` — `isPublicIPv6` rewritten as an ALLOWLIST (`2000::/3` only) instead
  of a denylist table, so `fec0::/10` and every other non-global-unicast range is refused by
  construction (F5). `deliverWakeup` starts its 10s deadline before DNS, races
  `resolvePublicAddresses` against a timer, and passes only the REMAINING time to
  `sendSignedRequest` (F6); the timer is cleared in a `finally` to avoid a leaked handle.
- `src/lib/worker/webhook-pass.ts` — `recordWebhookAttempt` calls drop `agentId` (F10).
- `src/lib/worker/event-drain-pass.ts` — `runEventDrainPass` takes an optional `shouldStop` and
  forwards it to `runWebhookDeliveryPass` (F9).
- `worker/index.ts` — `runDrainDuty` passes `isShuttingDown`; the stale doc comment claiming the
  drain duty "does not take" a stop signal is corrected to describe the embedded webhook pass (F9).

### Test files

- `src/__tests__/lib/webhooks/deliver.test.ts` — F5 table additions (`fec0::1`,
  `2002:c0a8:101::`, `64:ff9b::7f00:1`) plus a positive global-unicast case; F6's DNS-deadline test;
  F8(c) replaces the old (ineffective) body-cap test with a receiver that streams forever and never
  ends.
- `src/__tests__/lib/store/webhooks-memory.test.ts` — F7's `upsertAgentWebhook` 23503 test; F1's
  enqueue/re-arm-refused-when-registration-gone tests; F3's live-claimed-`both`-ledger test.
- `src/__tests__/integration/m11-2-b1-webhooks.test.ts` — F1 (db), F3 (db), and F2/F8(b) (overlapping
  transactions via a held `pg` lock, `helpers/concurrency.ts`).
- `src/__tests__/lib/worker/webhook-pass.test.ts` (NEW) — F8(a) (disabled registration ⇒ no
  `deliverWakeup` call, ledger terminalizes) and F8(d) (sent payload keys are exactly
  `context_href, event_id, reason, subject, wakeup_id`; no top-level `title`/`content`).
- `src/__tests__/lib/worker/event-drain-pass-stop-signal.test.ts` (NEW) — F9 (the caller's
  `shouldStop` reaches `runWebhookDeliveryPass` unchanged, including `undefined`).

## 2. Gate results

```
$ npx tsc --noEmit
(clean for this fence — the only errors seen were in src/__tests__/integration/m11-2-b1-dms.test.ts
 and m11-2-b1-reactions.test.ts, both mid-edit by concurrent lanes, outside lane W's fence)

$ npx eslint <13 files listed> --max-warnings=0
/Users/mohsin/Github/safemolt/worker/index.ts
  31:1  warning  Function 'loadEnvLocalIfNeeded' has a complexity of 13. Maximum allowed is 12
✖ 1 problem (0 errors, 1 warning)
```
Verified pre-existing by running eslint against `git show HEAD:worker/index.ts` — identical warning,
same function, same complexity number, and `git diff worker/index.ts` shows no change to that
function. Every new/changed function in this round's own files carries no warnings.

```
$ npm test -- src/__tests__/lib/webhooks src/__tests__/lib/store/webhooks-memory.test.ts \
    src/__tests__/api/agents-me-webhook.test.ts src/__tests__/lib/events \
    src/__tests__/lib/store/wakeups src/__tests__/lib/worker
Test Suites: 17 passed, 17 total
Tests:       296 passed, 296 total
```

```
$ npm run test:integration -- src/__tests__/integration/m11-2-b1-webhooks.test.ts
Test Suites: 1 passed, 1 total
Tests:       15 passed, 15 total
```
(One run briefly waited on the shared integration lock held by a concurrent lane's process — per
`b1-common-rules.md`, waited it out rather than killing the holder.)

## 3. Mutation-check evidence (verbatim)

**F1 db (enqueue/re-arm insert gate)** — removed the `WHERE $5::text <> 'webhook' OR EXISTS (...)`
clause from `insertWakeupSql`:
```
✕ F1: no ledger-less webhook-primary wakeup › refuses the enqueue when the registration vanishes...
  Expected: {"created": false, "wakeup": null}   Received: {"created": true, "wakeup": {...}}
```
Restored → 15/15 integration pass.

**F1 memory (enqueue gate)** — removed the `webhookRegistrationLive` check from `enqueueWakeup`:
```
✕ F1: refuses a webhook-primary enqueue once the registration is gone (no ledger-less wakeup)
  Expected: {"created": false, "wakeup": null}   Received: {"created": true, "wakeup": {...}}
```
Restored → 17/17 pass.

**F1 memory (re-arm gate)** — removed the same check from `createOrReArmWakeup`'s re-arm branch:
```
✕ F1: refuses a webhook-primary re-arm once the registration is gone
  Expected: {"reArmed": false}   Received: {"reArmed": true}
```
Restored → 17/17 pass.

**F3 db (reset gate)** — dropped the `terminal_reason IS NOT NULL` / `rr.delivery = 'webhook'`
predicates from the `ON CONFLICT DO UPDATE`'s `WHERE`:
```
✕ F3: an internal re-arm never resets an active mode='both' ledger › leaves a live-claimed both...
  Expected: "b1w_f3_live"   Received: null
```
Restored → 15/15 integration pass.

**F3 memory (reset gate)** — dropped the same predicates in `createWebhookLedgerRowIfNeeded`:
```
✕ F3: an internal re-arm never resets an active `mode='both'` ledger › leaves a live-claimed...
  Expected: "f3-live-claim"   Received: null
```
Restored → 17/17 pass.

**F2 (deleteAgentWebhook two-statement fix)** — reverted to the single-statement, one-snapshot form:
```
✕ F2/F8(b): the disposition sweep sees a ledger committed during its own lock wait › terminalizes...
  Expected: 0   Received: 1
```
Restored → 15/15 integration pass.

**F6 (DNS deadline)** — moved the deadline to start after `resolvePublicAddresses` (pre-fix shape):
```
thrown: "Exceeded timeout of 15000 ms for a test."
```
(the resolver's 11s delay plus the old post-DNS 10s socket phase blows past the test's own 15s
bound — proving the fix's whole point). Restored → 51/51 pass.

**F8(c) (body cap)** — set `MAX_RESPONSE_BYTES = Infinity`:
```
✕ F8(c): stops at the 64KB cap even against a receiver that streams forever and never ends
  Expected: {"ok": true, "status": 200}   Received: {"ok": false, "status": null}
```
(falls through to the 10s total-timeout path instead of the cap). Restored → 51/51 pass.

**F5 (IPv6 allowlist)** — replaced the allowlist check with `return true`:
```
✕ rejects ULA fc00::/7 (fc00::1)                          Resolved to value: ["fc00::1"]
✕ rejects deprecated site-local fec0::/10 (fec0::1)       Resolved to value: ["fec0::1"]
✕ rejects IPv6 documentation 2001:db8::/32 (2001:db8::1)  Resolved to value: ["2001:db8::1"]
```
Restored → 51/51 pass.

**F7 (memory actor re-check)** — removed the `agents.has` guard from `upsertAgentWebhook`:
```
✕ F7: refuses (23503-shaped) a registration for an agent the shared map no longer has
  Resolved to value: {...} instead of rejecting
```
Restored → 14/14 pass (webhooks-memory.test.ts at that point).

**F8(a) (worker disabled-registration check)** — removed `claimed.disabledAt !== null` from the
worker's guard clause:
```
✕ terminalizes a reclaimed row for a since-disabled registration without calling deliverWakeup
  TypeError: Cannot read properties of undefined (reading 'status')
```
(the mocked `deliverWakeup` is now reached and called, proving the guard's removal lets a request
through). Restored → 2/2 pass.

**F8(d) (worker payload shape)** — spread `...claimed.payload` instead of nesting under `subject`:
```
✕ never spreads the wakeup's own payload fields (e.g. title/content) into the top level
  - "subject"        + "content"  + "title"
```
Restored → 2/2 pass.

**F9 (drain pass stop-signal forwarding)** — dropped the `shouldStop` argument from the
`runWebhookDeliveryPass()` call inside `runEventDrainPass`:
```
✕ passes the caller's shouldStop through, unchanged
  Expected: [[Function shouldStop]]   Received: [[]]
```
Restored → 2/2 pass (plus the whole `src/__tests__/lib/worker` suite re-run clean).

**F4 (recordWebhookAttempt lock reorder)**: not independently mutation-tested as a standalone
finding — no dedicated `Test:` line in the spec for it, and it is a pure CTE-reordering change with
no output-visible behavior difference for any admitted/refused outcome (the token fence, exhaustion,
and disposition tests all still exercise the same statement, unchanged, and all pass — see gate
output above). The lock-order correctness itself was reasoned through directly: a webhook-primary
wakeup's `completed_at` and its ledger's `terminal_reason` are always set together in the SAME
statement (the pre-existing coupling invariant), so a re-arm's `completed_at IS NOT NULL`
precondition can never overlap with a live (non-terminal) `recordWebhookAttempt` on that same row —
no reachable interleaving between re-arm and attempt-completion can deadlock either way.

## 4. Shared-file edits

- `worker/index.ts` (not listed as multi-lane shared in `b1-common-rules.md`, but touched carefully
  regardless): one call-site edit (`runEventDrainPass(WORKER_HEARTBEAT_ID, isShuttingDown)`) and one
  doc-comment correction, both inside lane W's own webhook-related duty. Re-read immediately before
  editing; no collision.
- No edits to any of the common-rules "collision protocol" files (`events/kinds.ts`,
  `consumers/coverage.ts`, `store-types.ts`, `store.ts`, `export-manifest.ts`, `migrate.js`,
  `agent-tools/index.ts`, `actions/types.ts`) — this round's findings needed none of them.
- No new store exports. `RecordWebhookAttemptInput` lost a field (`agentId`); no export name changed.

## 5. Out-of-fence needs and cross-lane notes

None observed. `src/lib/store/agents/memory.ts` (shared with lane M) was not touched this round —
round 2's findings did not require it. `tsc --noEmit` showed pre-existing, unrelated errors in
`src/__tests__/integration/m11-2-b1-dms.test.ts` and `m11-2-b1-reactions.test.ts` from concurrent
lanes' in-progress edits; not acted on, not this lane's fence.

## 6. Docs delta

None required. All ten fixes are internal correctness/security hardening (registration-gated
enqueue/re-arm, disposition snapshot freshness, lock ordering, SSRF allowlist, DNS-inclusive
timeout, memory-mode actor parity, stop-signal propagation, and a KISS cleanup) with no change to
the documented request/response contract of `POST/GET/DELETE /api/v1/agents/me/webhook` or to any
`public/*.md`/`openapi.json` surface.

## 7. Behavior changes or plan deviations

- **F1**: a webhook-primary enqueue or re-arm whose registration is gone/disabled at the instant of
  the write now refuses outright (`created: false` / `reArmed: false`) instead of creating a wakeup
  with no ledger to ever claim it through. Only changes behavior in the race window the fix targets.
- **F2**: `deleteAgentWebhook` is now two statements in one transaction instead of one; behavior is
  identical on the ordinary (non-racing) path, and now ALSO terminalizes a ledger row a concurrent
  enqueue committed during the delete's own lock wait — previously left nonterminal forever.
- **F3**: an internal re-arm of a `mode='both'` wakeup no longer resets its webhook ledger's
  claim/attempts/terminal state at all (previously it did, whenever a stale row existed) — this is a
  narrowing fix, not a widening one: the old behavior could clobber an in-flight webhook attempt and
  invite a duplicate send.
- **F5**: `isPublicIPv6` moved from a denylist to an allowlist (`2000::/3` only). Same rejections as
  before for every address round 1 tested, PLUS newly-rejected: `fec0::/10` (deprecated site-local)
  and any other reserved/unassigned IPv6 range not previously named. No legitimate global-unicast
  target is affected.
- **F6**: a webhook delivery attempt against a slow-resolving hostname now fails faster (refused at
  the 10s deadline measured from BEFORE DNS, rather than 10s after DNS completes) — narrows the
  worst-case attempt duration, never widens it.
- **F7**: `upsertAgentWebhook` (memory) now throws a `23503`-shaped error for a nonexistent agent
  instead of silently writing an orphan registration — reachable only via a bypass of the action's
  own re-check (F5a from round 1), which remains the primary defense on the ordinary path.
- **F9**: the worker's drain duty now stops claiming new webhook deliveries after `SIGTERM`, where
  previously only its dedicated webhook duty did. A cron-only invocation (`internal/events-drain`)
  passes no signal and is unaffected.
- **F10**: `RecordWebhookAttemptInput.agentId` removed — a breaking change to that internal type's
  shape only; no caller outside this fence referenced it (verified by repo-wide grep).
