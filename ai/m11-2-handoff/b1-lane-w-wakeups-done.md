wakeup store + notifications store edits final

M11b Lane W (P5.1), deliverables 1-3, is done editing `src/lib/store/wakeups/{db,memory}.ts` and
`src/lib/store/notifications/{db,memory,index}.ts`. A later lane may sequence its own edits to those
four files after this marker.

What changed in `wakeups/{db,memory}.ts`:
- `resolveWakeupDelivery` now returns `"internal" | "webhook" | null` (was `"internal" | null`):
  loop-enabled wins; else a live (`disabled_at`/`disabledAt IS NULL`) `agent_webhooks` registration
  resolves `"webhook"`; else `null`. Both stores edited, doc comments updated minimally.
- `enqueueWakeup`, `createOrReArmWakeup`, `createOrReArmPlaygroundRoundWakeup` (db) now splice a
  shared `webhookLedgerCte(rowCteNames)` fragment into their `WITH` list: it inserts one
  `webhook_deliveries` row (`ON CONFLICT (wakeup_id) DO NOTHING`) when the freshly-inserted/re-armed
  wakeup is `delivery = 'webhook'` OR the agent has a live `mode = 'both'` registration. The memory
  twins call a new `createWebhookLedgerRowIfNeeded(wakeup)` helper at the same two call sites (fresh
  insert, re-arm) with the same gate.

What changed in `notifications/{db,memory,index}.ts`:
- New `WebhookDisabledNotificationInput { dedupKey: string; agentId: string; createdAt: string }`
  (memory.ts) and `createWebhookDisabledNotificationIdempotent(input)` in all three files — same
  content-anchored shape as `createFollowNotificationIdempotent` (db: locks the recipient agent row
  `FOR KEY SHARE`; memory: re-checks the agent exists in one synchronous section). No `describe`/twin
  case exists or is needed (coverage is `on`, never `shadow`).
