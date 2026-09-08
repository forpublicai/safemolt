# b1 Lane W — Webhooks (P5.1) — final report

Manager: Sonnet, lane W. Three subagents (store layer; delivery/action/route/runtime; two parallel
test-writing subagents) plus manager-level fixes to pre-existing tests broken by this lane's
recorded `resolveWakeupDelivery` behavior change. All work verified by the manager with real gate
runs, not accepted on subagent claim alone.

## 1. Deliverables — status

| # | Deliverable | Status | Files |
|---|---|---|---|
| 1 | Migration | Done | `scripts/migrate-m11-webhooks.sql` |
| 2 | Store (`webhooks/{db,memory,index}.ts`, wakeup ledger CTE) | Done | `src/lib/store/webhooks/{db,memory,index}.ts`; `src/lib/store/wakeups/{db,memory}.ts` (edited); `src/lib/store/_memory-state.ts` (edited) |
| 3 | Kind + consumer (`webhook.disabled`) | Done | `src/lib/events/kinds.ts`, `src/lib/events/consumers/coverage.ts`, `src/lib/store-types.ts`, `src/lib/store/notifications/{db,memory,index}.ts` (edited), `src/lib/events/consumers/notifications.ts` (edited) |
| — | Marker file | Done | `ai/m11-2-handoff/b1-lane-w-wakeups-done.md` |
| 4 | Delivery (`src/lib/webhooks/deliver.ts`) | Done | SSRF-safe pinning, signed POST, no new dependency |
| 5 | Action + route | Done | `src/lib/actions/webhooks.ts`, `src/app/api/v1/agents/me/webhook/route.ts`; `src/lib/actions/types.ts` (edited: `webhooks_not_enabled`) |
| 6 | Runtimes | Done | `src/lib/worker/webhook-pass.ts`; `worker/index.ts`, `src/lib/worker/event-drain-pass.ts`, `render.yaml`, `.env.example` (edited). Housekeeping: confirmed `pruneTerminalWakeups` already covers ledger cascade (`webhook_deliveries.wakeup_id ... ON DELETE CASCADE`) — no new pruner written. |
| 7 | Tests | Done | `src/__tests__/lib/webhooks/deliver.test.ts` (31), `src/__tests__/lib/store/webhooks-memory.test.ts` (9), `src/__tests__/integration/m11-2-b1-webhooks.test.ts` (8, db), `src/__tests__/api/agents-me-webhook.test.ts` (13) |
| — | Pre-existing test repair (manager) | Done | `src/__tests__/lib/events/wakeup-router.test.ts`, `src/__tests__/lib/events/wakeup-round-open-composition.test.ts`, `src/__tests__/lib/store/wakeups/memory.test.ts` — broken by this lane's `resolveWakeupDelivery` behavior change; fixed to seed a delivery channel (loop-enabled or webhook) and updated the one assertion that encoded the old unconditional `"internal"` placeholder behavior |

## 2. Gate results (exact commands run by the manager, tail output)

**`npx tsc --noEmit`** — clean for every file in this lane's fence. Remaining errors in the tree
belong to concurrent lanes M/R/D (`src/lib/actions/posts.ts` unused-import errors, an `agent.mentioned`
coverage gap, `reactions-routes.test.ts` type errors) — none touch webhook files, confirmed by
re-running after each of this lane's edits.

**`npm test -- src/__tests__/lib/webhooks/deliver.test.ts src/__tests__/lib/store/webhooks-memory.test.ts src/__tests__/api/agents-me-webhook.test.ts`**
```
PASS src/__tests__/api/agents-me-webhook.test.ts
PASS src/__tests__/lib/store/webhooks-memory.test.ts
PASS src/__tests__/lib/webhooks/deliver.test.ts
Test Suites: 3 passed, 3 total
Tests:       53 passed, 53 total
```

**`npm run test:integration -- src/__tests__/integration/m11-2-b1-webhooks.test.ts`** (waited briefly
on the advisory lock held by a concurrent lane's suite, then ran; re-ran solo by the subagent for
confidence)
```
PASS src/__tests__/integration/m11-2-b1-webhooks.test.ts (9.4s)
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

**`npm test -- src/__tests__/lib/events src/__tests__/lib/store/wakeups`** (includes the three files
the manager repaired)
```
PASS src/__tests__/lib/events/wakeup-router.test.ts
PASS src/__tests__/lib/events/wakeup-round-open-composition.test.ts
PASS src/__tests__/lib/store/wakeups/memory.test.ts
PASS src/__tests__/lib/store/wakeups/claim.test.ts
PASS src/__tests__/lib/events-substrate.test.ts
PASS src/__tests__/lib/events/consumer-coverage.test.ts
PASS src/__tests__/lib/events/statement-options.test.ts
PASS src/__tests__/lib/events/mentions-e2e.test.ts
PASS src/__tests__/lib/events/consumer-dispatch.test.ts
PASS src/__tests__/lib/events/shadow-legacy-compare.test.ts
Test Suites: 10 passed, 10 total
Tests:       197 passed, 197 total
```

**`npm run gen:boundary` then `npm test -- src/__tests__/lib/boundary`**
```
FAIL src/__tests__/lib/boundary-manifest-completeness.test.ts
  The store facade exports 1 name(s) not classified in src/lib/store/export-manifest.ts:
  createDmReceivedNotificationIdempotent.
PASS src/__tests__/lib/boundary-generated-block.test.ts
PASS src/__tests__/lib/boundary-ast-discipline.test.ts
PASS src/__tests__/lib/boundary-mixed-actor-route.test.ts
Test Suites: 1 failed, 3 passed, 4 total
```
This single failure is **lane D's** (DMs) unclassified export, not lane W's — confirmed none of
lane W's new exports (`upsertAgentWebhook`, `deleteAgentWebhook`, `claimNextWebhookDelivery`,
`recordWebhookAttempt`, `createWebhookDisabledNotificationIdempotent`) appear in the error. Recorded
under §5 as a cross-lane blocker for the orchestrator, not fixed by this lane (out of fence).

**`npx eslint`** on every file this lane created or edited — 0 errors; only pre-existing warnings in
code this lane did not write (`_memory-state.ts`'s `activityFeedMatches` complexity 20,
`notifications/memory.ts`'s `buildCommentNotification` complexity 16, `worker/index.ts`'s
`loadEnvLocalIfNeeded` complexity 13 — all three predate this lane).

## 3. Mutation-check evidence (verbatim, from both test subagents, re-verified by the manager)

1. **`resolvePublicAddresses`'s check-every-address loop** (`src/lib/webhooks/deliver.ts`) — changed
   to check only `addresses[0]`. Re-ran the "MIXED list" test:
   `expect(received).rejects.toThrow()` failed, resolved value
   `["93.184.216.34","10.0.0.1"]` — a private address in a mixed list was let through. Restored;
   suite green again.
2. **`handleResponse`'s success predicate** (`deliver.ts`) — changed `status < 300` to `status < 400`.
   Re-ran "3xx is a failure": got `{ok:true, status:302}` instead of `{ok:false, status:302}` — a
   redirect counted as success. Restored; green.
3. **`recordWebhookAttempt`'s `willDisable` event gate** (`src/lib/store/webhooks/memory.ts`) —
   forced `events` to always `[]`. Re-ran the 10th-failure test: registration correctly disabled but
   `listNotifications` had no `webhook_disabled` entry — the disable happened silently. Restored;
   green.
4. **`applyRecordedAttempt`'s wakeup-completion gate** (`memory.ts`) — dropped the
   `wakeup.delivery === "webhook"` condition. Re-ran the `mode='both'` isolation test: the
   internal-primary wakeup's `completedAt` was wrongly stamped. Restored; green.
5. **`completed_wakeup` CTE's `AND ud.wakeup_delivery = 'webhook'` clause** (`src/lib/store/webhooks/db.ts`,
   the db-side twin of #4) — removed transiently. Re-ran the integration suite: exactly one test
   failed (`a mode='both' ledger terminalizes WITHOUT completing the internal-primary wakeup`),
   `wakeup.completed_at` was non-null when it must stay `null`. Reverted; the manager confirmed by
   `grep -n "wakeup_delivery = 'webhook'" src/lib/store/webhooks/db.ts` that the clause is present
   (line 343) after the revert, and the full integration suite is green again.

## 4. Shared-file edits (file + anchor) and new store exports

| File | Anchor / what was added |
|---|---|
| `src/lib/events/kinds.ts` | `webhook.disabled` payload under `// ==== M11b Lane W ====`, end of `EventPayloadMap`; entry in `KIND_MEMBERSHIP` |
| `src/lib/events/consumers/coverage.ts` | `"webhook.disabled"` appended to all four manifests: `on` (notifications), `none` (activity-trail, memory-ingest, wakeup-router) |
| `src/lib/store-types.ts` | `"webhook_disabled"` appended to `NotificationType` |
| `src/lib/events/consumers/notifications.ts` | one `case` in `plan()`, `PlannedNotification` widened with a `webhook_disabled` variant, one `apply()` branch |
| `src/lib/store.ts` | `export * from "./store/webhooks";` appended |
| `src/lib/store/export-manifest.ts` | new `// --- webhooks ---` section: `upsertAgentWebhook`, `deleteAgentWebhook`, `claimNextWebhookDelivery`, `recordWebhookAttempt` (mutating); `createWebhookDisabledNotificationIdempotent` added to the existing notifications section. `getAgentWebhook` needs no entry (read prefix). |
| `scripts/migrate.js` | `{ file: "migrate-m11-webhooks.sql", label: "Webhook registrations and delivery ledger" }` appended to `MIGRATION_FILES` |
| `src/lib/worker/migration-ledger.ts` | `"migrate-m11-webhooks.sql"` appended to `REQUIRED_MIGRATIONS` |
| `src/lib/actions/types.ts` | `"webhooks_not_enabled"` appended to `ActionErrorCode` |
| `src/__tests__/lib/events-substrate.test.ts` | `"webhook.disabled": true` appended to the test's `COVERAGE` fixture and to the expected sorted `EVENT_KINDS` array (manager edit, needed to keep this shared test file's own tsc gate green after deliverable 1-3 landed; lane D's `dm.*` entries were separately added by that lane) |

New mutating store exports and their classification: all five listed above are `MUTATING_STORE_EXPORTS`
entries (write to `agent_webhooks`/`webhook_deliveries`/`notifications`). `getAgentWebhook` is a read
(prefix `get`).

## 5. Out-of-fence needs and cross-lane notes

- **Blocking for the wave, not for this lane**: `src/__tests__/lib/boundary-manifest-completeness.test.ts`
  currently fails because lane D's `createDmReceivedNotificationIdempotent` is not yet classified in
  `export-manifest.ts`. This lane's own exports are correctly classified. The orchestrator should
  confirm lane D adds its entry before the wave boundary's `npm run gen:boundary` is treated as final.
- **Pre-existing tests broken by this lane's recorded behavior change**: memory-mode
  `resolveWakeupDelivery` no longer unconditionally answers `"internal"` (see §7). Three files
  (`wakeup-router.test.ts`, `wakeup-round-open-composition.test.ts`, `wakeups/memory.test.ts`)
  encoded the old placeholder and were repaired by the manager (see §1, §7) rather than left broken,
  since the spec's own gate list requires `npm test -- src/__tests__/lib/events` green.
- **Minor ambiguity, not a bug** (flagged by a test subagent): `claimNextWebhookDelivery`'s db-side
  `ORDER BY wd.next_attempt_at LIMIT 1` has no id-based tiebreak for same-instant candidate rows,
  unlike `wakeups/memory.ts`'s claim (which breaks ties by ascending id for reproducibility). Not a
  correctness issue — Postgres's own tie order is fine — but a future test in this family that
  assumes db-side ordering determinism across same-instant rows should not.
- **Non-blocking observation**: `validateWebhookUrl`'s `parsed.hostname === ""` branch
  (`src/lib/webhooks/deliver.ts`) appears unreachable for `https:` URLs under the current WHATWG
  `URL` implementation (the constructor throws before returning an empty host for a special scheme),
  so it is currently dead code reached only via the earlier `catch`. Both paths return the same
  `ok:false` outcome, so this has no behavioral effect; noting in case a future Node URL-parsing
  change makes the branch live.
- No needs outside this lane's fence were otherwise encountered. Files under
  `src/lib/actions/{posts,comments,agents}.ts`, `src/lib/store/{posts,comments,agents,groups}/*`,
  `src/lib/agent-tools/**`, and the mentions/reactions/dms surfaces were read-only reference points
  (e.g. `deleteAgent` was called, never edited, for the withdrawal-cascade test) and were left
  untouched.

## 6. Docs delta (exact text for the docs agent)

**`public/reference.md`** — add a "Being woken up: webhooks" subsection alongside the existing wakeup
documentation (once it exists; the lane C wakeup docs pass has not landed yet — coordinate ordering
with that docs delta):

> ### Webhooks
>
> An agent with no autonomous loop can still be woken up: register an HTTPS endpoint once and
> receive every wakeup as a signed POST.
>
> `POST /api/v1/agents/me/webhook` — body `{"url": "https://...", "mode": "primary"}` (`mode` is
> `"primary"` or `"both"`; `"both"` delivers by webhook *and* keeps the loop tick if one is enabled).
> Returns `{"url", "mode", "secret"}` — **the secret is shown once**; a re-POST rotates it. Refused
> with `webhooks_not_enabled` (503) until the platform enables webhook registration.
>
> `GET /api/v1/agents/me/webhook` — the current registration (never the secret), or `data: null`.
>
> `DELETE /api/v1/agents/me/webhook` — removes the registration.
>
> Each wakeup is delivered as `POST <your url>` with:
> - `Content-Type: application/json`
> - `X-SafeMolt-Signature: sha256=<hex hmac-sha256(your secret, raw body)>` — verify this before
>   trusting the payload.
> - `X-SafeMolt-Wakeup-Id` — always present; the idempotency key for de-duplicating retries.
> - `X-SafeMolt-Event-Id` — present only when the wakeup has a source event.
>
> Body: `{"reason", "wakeup_id", "event_id"?, "subject": {...ids}, "context_href"}` — ids only, never
> post/comment content; fetch the content yourself if you need it.
>
> Delivery retries up to 3 times with backoff (1m, 10m, 60m). After 10 consecutive delivery failures
> your webhook is automatically disabled (you'll see a `webhook_disabled` notification in your
> inbox) — re-register to resume.

**`public/skill.md`** — one line under the existing autonomy/wakeup pointer: "No loop? Register a
webhook (`POST /api/v1/agents/me/webhook`) to get woken up by signed HTTP POST instead — see
reference.md."

**`public/openapi.json`** — add `POST`/`GET`/`DELETE /api/v1/agents/me/webhook`: request body schema
`{url: string, mode?: "primary"|"both"}` for POST; response schema `{url, mode, secret}` for POST,
`{url, mode, disabled} | null` for GET, `{removed: boolean}` for DELETE; document the four response
headers (`X-SafeMolt-Signature`, `X-SafeMolt-Wakeup-Id`, `X-SafeMolt-Event-Id`) as an external
webhook-delivery description (not a request/response of this API itself — most naturally a
`description` block on the POST operation).

**`public/planned.md`** — prune any existing "webhook delivery" or "outbound notifications" planned
entry if one exists (grep found none at time of writing — this section pre-registers webhooks, it
may collide with a future or concurrent lane's placeholder; the docs agent should check current
state at merge time).

**`CLAUDE.md`** (one bullet, house style, for the "Store and Migration Invariants" section): "A
webhook delivery's terminal transition (`delivered`/`exhausted`/`webhook_removed`/`webhook_disabled`)
and its webhook-primary wakeup's completion are coupled in ONE token-fenced statement
(`recordWebhookAttempt`, `deleteAgentWebhook`), never two separate calls — the same terminal-coupling
rule the wakeup runner's own writers follow. A `mode='both'` ledger's completion never touches the
internal-primary wakeup it rides beside; the tick still owns that."

## 7. Behavior changes / plan deviations

- **Recorded, spec-mandated behavior change**: `resolveWakeupDelivery` in memory mode no longer
  unconditionally returns `"internal"` for every agent id (its pre-P5.1 documented placeholder). It
  now applies the real precedence — loop-enabled wins, else a live webhook registration resolves
  `"webhook"`, else `null` — matching the db side exactly, per P5.1's explicit instruction that this
  function is "where [the webhook twin] lands." This broke three pre-existing test files, all
  repaired (see §1, §5).
- **`deliverWakeup`'s payload-in design**: chosen over building the Decision-8 body inside `deliver.ts`
  itself, per the subagent's own KISS judgment — `deliver.ts` stays ignorant of wakeup business shape
  (reason/subject/context_href), and `webhook-pass.ts` (the caller) owns building that body from the
  claimed ledger row's fields. No functional deviation from the spec, purely a module-boundary choice.
  A `Content-Length` header was added to the delivery request (not explicitly named in the spec's
  header list) — standard, harmless, does not affect signature or SSRF behavior.
- No other deviations from `ai/m11-2-handoff/b1-lane-w-webhooks-spec.md`.
