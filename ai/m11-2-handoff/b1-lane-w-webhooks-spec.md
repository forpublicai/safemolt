# b1 Lane W — P5.1 Webhooks (spec)

Read `ai/m11-2-handoff/b1-common-rules.md` first. Then `ai/PLAN_M11_2.md` line 327–330
(P5.1 verbatim — it is the contract), `CLAUDE.md` "Store and Migration Invariants" (the event
coupling rules, token-fenced writes), `src/lib/store/wakeups/db.ts` (the enqueue statements and the
runner's token-fenced writers — your templates), `src/lib/events/consumers/wakeup-router.ts`,
`src/lib/events/consumers/notifications.ts`, `src/lib/auth-cron.ts` (the `ALLOW_INSECURE_CRON`
pattern), `worker/index.ts`, `src/lib/worker/event-drain-pass.ts`.

## Mission

An external agent registers an https URL once and receives every wakeup as a signed POST. KISS:
one registration row per agent, one delivery-ledger row per wakeup, one claim statement, one
attempt function over `node:https`, one worker duty, one bounded degraded pass in the drain cron.

## Deliverables (sequence: 1 → 2 → 3 FIRST, then 4–7; write the marker file after 3)

1. **Migration** `scripts/migrate-m11-webhooks.sql` — `agent_webhooks` and `webhook_deliveries`
   exactly as P5.1 prints them, with Decision 10 FKs: `agent_webhooks.agent_id` and
   `webhook_deliveries.agent_id` → `agents(id) ON DELETE CASCADE`; `webhook_deliveries.wakeup_id`
   → `agent_wakeups(id) ON DELETE CASCADE`. Index on `(lease_expires_at, delivered_at)` for the
   claim scan. Fully idempotent. Append to `scripts/migrate.js` and to `REQUIRED_MIGRATIONS`.
2. **Store** `src/lib/store/webhooks/{db,memory,index}.ts` behind `pickStore`:
   - `upsertAgentWebhook({agentId,url,secret,mode})` (re-POST rotates; clears `disabled_at` and
     `failure_count`), `getAgentWebhook(agentId)`, `deleteAgentWebhook(agentId)` — the delete
     terminalizes every UNCLAIMED ledger row (`result`-style column: use `last_status` +
     `delivered_at`? NO — add `terminal_reason TEXT` to the ledger: `delivered | exhausted |
     webhook_removed | webhook_disabled`) and completes each row's webhook-PRIMARY wakeup
     (`agent_wakeups.delivery = 'webhook'`, result `webhook_removed`) in the SAME statement
     (data-modifying CTEs). `mode='both'` ledgers terminalize without touching internal wakeups.
   - `claimNextWebhookDelivery({claimToken, leaseMs})`: `FOR UPDATE SKIP LOCKED`, due = nonterminal
     AND (unclaimed OR lease expired) AND `next_attempt_at <= NOW()` (add `next_attempt_at
     TIMESTAMPTZ` for the exponential backoff), stamps `claimed_at/claim_token/lease_expires_at`
     (`make_interval`), returns the row joined with the wakeup payload + the registration
     (url, secret, disabled_at).
   - `recordWebhookAttempt({id, claimToken, status, ok})`: ONE token-fenced statement. Success →
     `delivered_at`, `terminal_reason='delivered'`, and complete the webhook-primary wakeup in the
     same statement. Failure → `attempts+1`, `last_status`, `next_attempt_at = NOW() + backoff
     (1m, 10m, 60m)`, release the claim; at attempts ≥ 3 → `terminal_reason='exhausted'` +
     complete the wakeup. Also on failure: `agent_webhooks.failure_count + 1`, and when it reaches
     10, `disabled_at = NOW()` gated by `disabled_at IS NULL`, carrying a `webhook.disabled`
     event via `emitEventCtes` gated on that UPDATE's `RETURNING`. If the registration is gone or
     disabled when the fenced update runs, terminalize (`webhook_removed`/`webhook_disabled`)
     instead of rescheduling. Success resets `failure_count` to 0.
   - `resolveWakeupDelivery` (EDIT `wakeups/db.ts` + `memory.ts`): loop-enabled → `internal`;
     else live registration → `webhook`; else `null` (keep the existing "create nothing"; record
     that the plan's `none` channel is not materialized — a row nobody consumes is bloat).
   - **Ledger creation rides the enqueue statement.** In `wakeups/db.ts` the three insert paths
     (`enqueueWakeup`, `createOrReArmWakeup`, `createOrReArmPlaygroundRoundWakeup`) gain ONE
     shared CTE fragment: insert a `webhook_deliveries` row `ON CONFLICT (wakeup_id) DO NOTHING`
     for the RETURNING'd row when `delivery = 'webhook'` OR the agent has a live registration with
     `mode = 'both'`. Memory twin mirrors. Add the memory ledger map to `_memory-state.ts` and its
     reset.
3. **Kind + consumer**: `webhook.disabled` in `kinds.ts` (payload `{ agent_id: string }`, subject =
   agent), coverage: notifications `on` (new kind, no legacy writer), the other three `none`.
   `NotificationType` gains `webhook_disabled`; the notifications consumer plans one idempotent
   insert (dedup key per Decision 6) via a small new store insert in `store/notifications/*`
   (`createWebhookDisabledNotificationIdempotent`, same shape as the follow one).
   **Then write `ai/m11-2-handoff/b1-lane-w-wakeups-done.md`** ("wakeup store + notifications
   store edits final") — a later lane sequences its own edits to those files after this marker.
4. **Delivery** `src/lib/webhooks/deliver.ts` (no new dependency):
   - `validateWebhookUrl(url)` pure: https only, port 443 only (explicit or implicit), no
     userinfo, hostname present.
   - `resolvePublicAddresses(hostname, lookupAll = dns.promises.lookup)`: every A/AAAA record
     must be public — reject loopback, link-local, private (10/8, 172.16/12, 192.168/16), CGNAT
     (100.64/10), multicast, unspecified, ULA fc00::/7, and IPv4-mapped IPv6 (check the mapped
     v4). Returns the validated list. Injectable resolver for tests.
   - `deliverWakeup({url, secret, wakeupId, eventId, payload})`: fresh resolve per attempt; pick
     one validated IP; `https.request` with `lookup` pinned to that IP, `servername`/`Host` = the
     hostname, `POST`, headers `Content-Type: application/json`, `X-SafeMolt-Signature:
     sha256=<hmac(secret, body)>`, `X-SafeMolt-Wakeup-Id`, `X-SafeMolt-Event-Id` only when
     non-null; 5 s connect / 10 s total timeout; 3xx = failure (never follow); read ≤ 64 KB and
     discard; result `{ ok: 2xx, status }`. Body = Decision-8 payload: `{reason, wakeup_id,
     event_id?, subject:{…ids}, context_href}` — ids only, never content.
   - Test seam, the `ALLOW_INSECURE_CRON` pattern: `WEBHOOK_ALLOW_INSECURE_LOCAL=true` (inert when
     `NODE_ENV=production`) permits `http://` and loopback so a local `node:http` receiver can
     assert signature/retry/disable. Nothing else is relaxed.
5. **Action + route**: `src/lib/actions/webhooks.ts` — `registerWebhook(agent, {url, mode})`
   (mode `primary | both`; validate URL, resolve public addresses, generate a 32-byte secret,
   upsert, return `{url, mode, secret}` ONCE), `getWebhook`, `removeWebhook`. Registration is
   refused with a stable `webhooks_not_enabled` (HTTP 503) unless `WEBHOOKS_ENABLED=true` — the
   P5.1 two-step rollout. Add the code to `ActionErrorCode`. Route
   `src/app/api/v1/agents/me/webhook/route.ts` POST/GET/DELETE, vetted agents, house envelope.
   No tool surface (external agents use REST).
6. **Runtimes**: `src/lib/worker/webhook-pass.ts` — `runWebhookDeliveryPass(shouldStop)`: loop
   claim → deliver → record, re-checking `shouldStop` before EVERY claim, per-pass budget (env
   `WEBHOOK_DELIVERY_BATCH`, default 20). Worker duty in `worker/index.ts` (interval
   `WORKER_WEBHOOK_INTERVAL_MS`, default 5000; `render.yaml` entry). The drain cron
   (`event-drain-pass.ts`) runs one bounded pass per invocation (degraded mode). Housekeeping:
   the existing retention duty prunes terminal ledger rows on the wakeup schedule (a ledger row
   cascades with its wakeup — check whether `pruneTerminalWakeups` already covers it; if so, no
   new pruner).
7. **Tests** (compact; the P5.1 gate list mapped to the fewest files):
   - `src/__tests__/lib/webhooks/deliver.test.ts` (unit, injected resolver + local receiver):
     URL hygiene table; private/mapped rejection; DNS change between attempts rejected; pinning
     (the receiver sees `Host` = hostname while the socket connected to the pinned IP); signature
     verifies; 3xx is a failure; body capped; payload carries ids only.
   - `src/__tests__/lib/store/webhooks-memory.test.ts`: register/rotate/delete; enqueue creates a
     ledger for webhook-primary and for `both`; attempt bookkeeping; disable at 10 emits
     `webhook.disabled` ⇒ `webhook_disabled` notification via the consumer; delete/disable
     disposition; `both` ledgers leave internal wakeups alone.
   - `src/__tests__/integration/m11-2-b1-webhooks.test.ts` (db): concurrent claim → exactly one
     claimant per row; expired lease reclaimed and the stale token's update rejected; coupling —
     after success/exhaustion/removal no state pairs a terminal ledger with a nonterminal
     webhook-primary wakeup or vice versa; agent withdrawal cascades leave no orphan; registration
     refused with the stable error when the flag is unset.
   - `src/__tests__/api/agents-me-webhook.test.ts`: the three verbs, secret returned once, 503 when
     disabled.

## Fences

- NEW: everything under `src/lib/store/webhooks/`, `src/lib/webhooks/`, `src/lib/actions/webhooks.ts`,
  `src/app/api/v1/agents/me/webhook/`, `src/lib/worker/webhook-pass.ts`,
  `scripts/migrate-m11-webhooks.sql`, the tests above.
- EDIT (yours alone): `src/lib/store/wakeups/db.ts`, `src/lib/store/wakeups/memory.ts`,
  `src/lib/store/notifications/{db,memory,index}.ts`, `worker/index.ts`, `render.yaml`,
  `src/lib/worker/event-drain-pass.ts`, `.env.example`, `src/lib/store/_memory-state.ts` (your
  map + reset only).
- SHARED (append-only per the common rules): kinds, coverage, store-types, notifications consumer,
  store.ts, export-manifest, migrate.js, migration-ledger, actions/types.ts.
- DO NOT TOUCH: `src/lib/actions/{posts,comments,agents,reactions,dms}.ts`, `src/lib/store/{posts,
  comments,reactions,dms,agents}/`, `src/lib/agent-tools/**`, `src/lib/agent-senses/**`,
  `src/lib/agent-pulse/**`, public docs, inventory.

## Gates before you report

`npx tsc --noEmit` clean; `npm run lint` 0 errors and no NEW complexity warnings; your jest files
green; your integration file green; `npm test -- src/__tests__/lib/boundary` green after
`npm run gen:boundary` at lane end; `npm test -- src/__tests__/lib/events` green (coverage
exhaustiveness, contract hash tests). Report per the common format, including the docs delta
for reference.md "Being woken up" (webhook), skill.md, openapi (the three verbs + headers), and
planned.md prunes.
