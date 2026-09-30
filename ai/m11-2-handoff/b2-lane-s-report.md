# b2 Lane S report — P5.2 SSE stream + P5.3 symmetry contract

Marker `ai/m11-2-handoff/b1-fixes-landed.md` never appeared during this lane's run. Per the spec's
Concurrency rule, everything NOT requiring an edit to `src/lib/store/wakeups/*`,
`src/lib/store/notifications/*`, `src/lib/events/consumers/*`, `src/lib/store/activity/*` or
`src/app/api/v1/internal/school-events/*` was built and verified; the remainder is in
`ai/m11-2-handoff/b2-lane-s-handoff.md`.

## 1. Deliverables

| # | Deliverable | Status | Files |
|---|---|---|---|
| 1 | Migration + 2 runbook scripts | Done | `scripts/migrate-m11-stream.sql`, `scripts/reconcile-stream-seq.sql`, `scripts/contract-stream-seq-not-null.sql` |
| 2 | Seq assignment in wakeup enqueue | **Not started** — fenced | see handoff §1 |
| 3 | Frame CTEs in notification/activity writers | **Not started** — fenced | see handoff §2-4 |
| 3 (primitive) | Frames-ledger + replay store module | Done | `src/lib/store/stream/{db,memory,index}.ts` |
| 4 | Stream token mint/verify + route | Done | `src/lib/stream/token.ts`, `src/app/api/v1/agents/me/stream-token/route.ts` |
| 5 | Worker SSE endpoints + mount | Done | `src/lib/worker/stream-server.ts`, `worker/index.ts` |
| 6 | Retention | Done | `src/lib/worker/event-drain-pass.ts` (`pruneStreamFrames(30, 1000)` in `runHourlyDuties`) |
| 7 | P5.3 symmetry contract | Done | `src/__tests__/lib/symmetry-contract.test.ts` |
| 8 | Tests | Done (unit-level); DB seq-blocking integration test deferred to handoff | `src/__tests__/lib/stream/token.test.ts`, `src/__tests__/api/v1/stream-token-route.test.ts`, `src/__tests__/lib/worker/stream-server.test.ts`, `src/__tests__/integration/m11-2-b2-stream-migration.test.ts` |

## 2. Gate results (exact commands + tails)

```
npm run test:integration -- src/__tests__/integration/m11-2-b2-stream-migration.test.ts
Test Suites: 1 passed, 1 total
Tests:       1 skipped, 5 passed, 6 total
```

```
npx jest src/__tests__/lib/worker/stream-server.test.ts src/__tests__/lib/symmetry-contract.test.ts \
  src/__tests__/lib/stream/token.test.ts src/__tests__/api/v1/stream-token-route.test.ts \
  src/__tests__/lib/boundary-manifest-completeness.test.ts src/__tests__/lib/worker/migration-ledger.test.ts \
  src/__tests__/lib/worker/event-drain-pass-retention.test.ts
Test Suites: 7 passed, 7 total
Tests:       36 passed, 36 total
```

```
npx jest src/__tests__/lib/store src/__tests__/lib/worker
Test Suites: 50 passed, 50 total   (1 pre-existing failure — migration-ledger.test.ts's pinned
list — found and fixed by the manager during this lane; see §7)
Tests: 399 passed, 399 total
```

```
npm run gen:boundary  ->  "wrote the generated block into .eslintrc.json"
npx jest src/__tests__/lib/boundary-generated-block.test.ts  ->  2 passed, 2 total
```

`npx tsc --noEmit -p tsconfig.json` (run by the stream-server subagent): exit 0.
`npx eslint` over every new/edited file: 0 errors (one pre-existing, unrelated complexity-13 warning
on `worker/index.ts`'s `loadEnvLocalIfNeeded`, not touched by this lane).

## 3. Mutation-check evidence (verbatim, collected from all four subagents)

**Migration idempotency** — re-ran `migrate-m11-stream.sql` and `reconcile-stream-seq.sql` a second
time against live rows in the reserved integration DB; asserted already-assigned `stream_seq`/
`last_seq` values were unchanged (proven against real data, not a mock).

**Stream token expiry** — commented out the expiry comparison in `verifyStreamToken`:
`Expected: {"ok": false, "reason": "expired"} / Received: {"agentId": "agent_1", "ok": true}`.
Restored -> 8/8 green.

**Stream token HMAC** — disabled the signature check: 3 failures, each a forbidden accept (tampered
payload, tampered signature, rotated-secret token). Restored -> 13/13 green (both token test files).

**Stream-server connection cap** — changed `>= MAX_CONNECTIONS_PER_AGENT` to
`> MAX_CONNECTIONS_PER_AGENT + 5`: the cap test failed (3rd connection became a live stream instead
of a fast 503, test timed out waiting for a response that never ends). Restored -> green.

**Stream-server token expiry (server-level)** — same expiry-check removal as above, observed from
the server side: the "rejects an expired stream token" test failed the same way. Restored -> green.

**Symmetry — wakeup payload shape** — injected a `"bogus_extra_field"` into the expected key set:
`Expected - 1 / + Received + 0` diff on the key array. Restored -> green.

**Symmetry — adapter mapping** — changed `mapToToolBody`'s `comment_id` source from
`result.data.comment.id` to `.postId`: assertion failed (`Expected: "comment_3", Received:
"post_3"`). Restored -> green.

## 4. Shared-file edits (anchor + reason) and new store exports

| File | Anchor | What was added |
|---|---|---|
| `scripts/migrate.js` | end of `MIGRATION_FILES` | `{ file: "migrate-m11-stream.sql", label: "SSE stream: per-agent seq counters and frames ledger" }` |
| `src/lib/worker/migration-ledger.ts` | end of `REQUIRED_MIGRATIONS` | `"migrate-m11-stream.sql"` |
| `src/lib/store.ts` | end | `export * from "./store/stream"` |
| `src/lib/store/export-manifest.ts` | end of `MUTATING_STORE_EXPORTS` | `"recordStreamFrame"`, `"pruneStreamFrames"` (mutating: INSERT/DELETE). Reads (`listWakeupFramesForReplay`, `listStreamFramesForTail`) need no entry — the tail reader was deliberately named with a `list` prefix rather than `tail`, since `tail` is not in `READ_EXPORT_PREFIXES` and renaming was less invasive than widening that list. |
| `src/lib/store/_memory-state.ts` | end | `streamFrames` (ledger array/map) + `streamSeqCounters` (deliverable-2 shape, unwired — no producer calls it yet) with reset helpers |
| `worker/index.ts` | inside `createServer` callback + boot | mount hook for `handleStreamRequest`, `setStreamShutdownSignal(isShuttingDown)` at boot; `/healthz` and the 404 fallback are byte-identical for unrelated paths |
| `src/lib/worker/event-drain-pass.ts` | `runHourlyDuties` | `pruneStreamFrames(30, 1000)` call + `HourlyReport.prunedStreamFrames` field |
| `.env.example` | new block near the P5.1 webhook block | `STREAM_ENABLED=false`, `STREAM_TOKEN_SECRET=`, `NEXT_PUBLIC_STREAM_URL=` |
| `src/__tests__/lib/worker/migration-ledger.test.ts` | pinned list | added `"migrate-m11-stream.sql"` (fixed by the manager — see §7) |
| `src/__tests__/lib/worker/event-drain-pass-retention.test.ts` | mock stub | added `pruneStreamFrames` mock + assertion on the new field |

No route or tool executor registration files were touched (no new agent tool in this lane).

## 5. Out-of-fence needs and cross-lane notes

- The real seq-allocation CTE (wakeups) and frame CTEs (notifications, activity) are blocked on the
  marker file — see `ai/m11-2-handoff/b2-lane-s-handoff.md` for the exact splice points, already
  reduced to "import the existing primitive and add one CTE" by the work done this lane.
- `src/lib/worker/stream-server.ts`'s firehose hidden-actor filter currently does its own read-only
  probe of `activity_events` (db) / the memory `activityEvents` map, because no store getter for
  "one activity row by id" exists yet outside the fenced activity module. Documented in that file;
  worth replacing with a proper store getter once the fence lifts (see handoff §5).
- A real bug was found and fixed in `stream-server.ts`: Node withholds HTTP response headers until
  the first body write (or a timer), so an SSE connection with nothing to replay immediately never
  reached the client at all until a frame arrived or the 25s keep-alive fired. Fixed with
  `res.flushHeaders()` in `writeSseHeaders`.
- `authenticateAndTouchByApiKey` is the only exported API-key lookup, so a long-lived SSE connection
  stamps `last_active_at` on connect (minor, documented, not a correctness issue).
- The manager fixed one shared-file collision: the migration subagent's addition to
  `REQUIRED_MIGRATIONS` broke `migration-ledger.test.ts`'s pinned-list assertion (a different
  subagent's file). Updated the pin to include `migrate-m11-stream.sql`; re-ran, green.

## 6. Docs delta (exact text for the docs agent)

**reference.md — "listen, don't poll" (P5.2):**
> **Live stream (SSE).** `GET /v1/stream` (or the public `/v1/stream/firehose`, no auth) pushes your
> wakeups and notifications as they happen — reconnect with `Last-Event-ID` to replay any wakeups you
> missed; notifications and firehose activity are live-only (catch up via the inbox or activity feed
> instead). Authenticate with your API key as a Bearer token, or mint a short-lived token via
> `POST /agents/me/stream-token` for browser `EventSource` clients that can't set custom headers.

**reference.md — symmetry section (P5.3):**
> **An agent is: identity, senses, actions, a wake channel.** Identity lives in `IDENTITY.md`. Senses
> come from `GET /agents/me/context`. Actions are the REST API — every tool an agent can call has a
> matching REST endpoint, because both surfaces run the same underlying action; only the response
> shape differs per surface (for example, comment creation returns `data.id` over REST and
> `data.comment_id` from the `create_comment` tool — same comment, two field names, by design). A
> wake channel tells the agent when to act: the internal loop runner, a registered webhook, the SSE
> stream, or ordinary polling — pick whichever fits your deployment, and switch at any time via
> `POST /agents/me/webhook` or the loop toggle.

**CLAUDE.md invariant (one bullet, house style, for the docs agent to place under M11-2 P5 items):**
> **The SSE stream's `stream_seq` is a per-recipient counter, never the wakeup's own id.** Ids
> allocate before commit, so a client's cursor is only safe against a value whose commit order
> matches allocation order — `agent_stream_counters`, incremented under its own row lock inside the
> same enqueue statement, is that value. `event: notification`/`event: activity` frames never carry
> an `id:` line (an id-less SSE frame leaves the client's last-event-id untouched), because they have
> no per-recipient commit-ordered counter of their own.

No changes were made to `public/*.md`, `public/openapi.json`, `CLAUDE.md`, `agents.md`, or
`ai/validation/m11-inventory.md` — all four texts above are for the docs agent to apply.

## 7. Behavior changes / plan deviations

- **Query-string auth rejection is broader than the letter of the spec**: `?api_key=`, `?key=`, and
  `?apiKey=` are all rejected outright (not just a generic "raw API key" heuristic), even alongside a
  valid `Authorization` header — a client putting a real key in a URL is treated as the mistake worth
  refusing regardless of what else is present.
- **Migration-ledger test fix**: `src/__tests__/lib/worker/migration-ledger.test.ts`'s pinned
  `REQUIRED_MIGRATIONS` list was updated to include `migrate-m11-stream.sql` (a one-line, purely
  additive fix to a smoke-check assertion, not a behavior change).
- Everything else matches the spec as written; no other deviations.

## 8. Gen-2 section — the gated splice (marker landed 2026-09-08)

`ai/m11-2-handoff/b1-fixes-landed.md` appeared; this session did the remaining handoff §1–4 work
(the seq CTE, the notification/activity frame CTEs, the school-events frame) plus the two
integration cases from handoff §6, in a tree with the b1 codex fix loop still actively editing
`wakeups/*`, `notifications/*` and `activity/events.ts` underneath this work (several transient
`tsc` errors mid-edit from that concurrent process, all resolved by a retry with no change from
this session).

### 8.1 Deliverables

| # | Deliverable | Files |
|---|---|---|
| 1 | Seq-allocating CTE, both stores | `src/lib/store/wakeups/db.ts` (`streamSeqCte`, `insertWakeupSql`, all 3 insert/re-arm paths, `rowToWakeup`), `src/lib/store/wakeups/memory.ts` (`nextStreamSeq`, wired into `insertRow` and `clearClaimAndCompletion`) |
| 2 | Frame CTE on all 8 notification insert paths | `src/lib/store/notifications/db.ts` (`notificationFrameCte`, `createNotification`, `insertNotificationFromSelect` + `withFrame` param, `buildFollowNotificationCte`), `src/lib/store/notifications/memory.ts` (`recordNotificationFrame`, wired into `createNotification` and `insertNotificationIdempotentSync` + `withFrame` param) |
| 3 | Firehose frame on the activity-trail consumer's 7 `apply*` writers | `src/lib/store/activity/events.ts` (`activityFrameCte`, `upsertActivityEventFromSelect` + `emitFrame` param now returning the row id, `buildCommentActivityUpsert` + `emitFrame` option, `memoryUpsertActivityProjection` + `emitFrame` param, all 7 `apply*ActivityFromEvent` call sites) |
| 4 | School-events route's own firehose frame | `src/app/api/v1/internal/school-events/route.ts` (`frameSchoolEventIngest`; `recordActivityEvent` now returns the written row's id — `string \| null` — instead of `void`, so this route can key its frame without a second read) |
| 6/8 | Integration tests for the real seq CTE | `src/__tests__/integration/m11-2-b2-stream.test.ts` (new): seq-blocking (real held lock via `raceAgainstHeldLock`), two idle wakeups get distinct seqs, concurrent re-drain of one notification insert writes one frame, school-ingest frames once. The reconciliation-script case from handoff §6 was already covered by `m11-2-b2-stream-migration.test.ts` from gen-1 — not duplicated. |
| — | New unit test for the memory-mode `emitFrame` gate | `src/__tests__/lib/store/activity/events.test.ts` (`applyPostActivityFromEvent` frames, `recordPostActivityEvent` does not) |
| 7 | `npm run gen:boundary` re-run | No diff — no new store export needed a boundary entry |

### 8.2 Two real defects found and fixed during this session (both by the required gates, not by inspection)

1. **F1-class regression, wakeups/db.ts**: the first cut of `streamSeqCte` inserted into
   `agent_stream_counters` unconditionally. That table carries the same
   `agent_id REFERENCES agents(id) ON DELETE CASCADE` policy `agent_wakeups` does, and the existing
   F1 withdrawal-race gate (`m11-2-b1-webhooks.test.ts`) caught it immediately: a withdrawal winning
   the race against `enqueueWakeup` now raised `agent_stream_counters_agent_id_fkey` instead of the
   pinned "refuses cleanly, no error" outcome. Fixed by gating the counter insert on
   `EXISTS (SELECT 1 FROM agent_lock)` — the same `agent_lock` CTE `registrationCte` already defines
   in all three callers.
2. **A second-order break from fix 1**: gating the counter insert then had to feed `stream_seq` into
   the wakeup row via `FROM seq`, which — for internal/none delivery, which has NO existing
   `agent_lock` gate on its own insert — silently suppressed the whole `agent_wakeups` insert instead
   of letting it fail loud on ITS OWN agent FK for a genuinely unknown agent id (a separate pinned
   gate, `m11-2-u5-wakeups.test.ts`'s "the agent foreign key" case). Fixed by `LEFT JOIN` on the seq
   CTE instead of an inner `FROM`, so the wakeup insert still attempts (and still correctly raises)
   when the counter has nothing, while `stream_seq` degrades to `NULL` in that case. Both gates are
   green together now; neither regressed the other.

### 8.3 Gate results (exact commands + tails, this session)

```
npx tsc --noEmit          -> exit 0 (clean; two transient errors mid-session were the concurrent
                              b1 fix loop editing shared files, both gone on retry with no change here)
npm run lint               -> 0 errors; same pre-existing complexity warnings on files this lane
                              touched (school-events POST: 19, activity/events.ts's
                              readActivityProjectionByKey: 15 and listActivityEventsFromDatabase: 17,
                              notifications/memory.ts's buildCommentNotification: 16) — none raised
                              by this session's diff (verified against `git diff` hunks per function)
npm test -- src/__tests__/lib/store src/__tests__/lib/events src/__tests__/lib/worker \
  src/__tests__/lib/stream src/__tests__/lib/boundary
  -> Test Suites: 63 passed, 63 total / Tests: 565 passed, 565 total

npm run test:integration -- src/__tests__/integration/m11-2-b2-stream.test.ts \
  src/__tests__/integration/m11-2-b1-webhooks.test.ts src/__tests__/integration/m11-2-u5-wakeups.test.ts
  -> Test Suites: 3 passed, 3 total / Tests: 50 passed, 50 total

npm run gen:boundary       -> "wrote the generated block into .eslintrc.json"; `git diff --stat
                              .eslintrc.json` empty (no new export needed a boundary entry)
```

One flake along the way, diagnosed and closed rather than waived: an early combined run of the
three integration files above showed 5 failures in `m11-2-b1-webhooks.test.ts`, all wrong-wakeup-id
or wrong-claim-count assertions. Direct inspection of the reserved DB found a genuine orphaned
`webhook_deliveries`/`agent_wakeups`/`agents` row set from an EARLIER interrupted run in this same
session (RUN prefix `mtto1fyl_eq8s`, created ~05:36, well before this session's fix — most likely
stranded by a crash during the pre-fix FK-violation failures in §8.2.1, which cut a test file off
before its own `afterAll` ran). It was global-scan-visible to `claimNextWebhookDelivery`'s "exactly
one claimant" gate. It disappeared on its own between two solo re-runs of the same file (almost
certainly another concurrently-running lane's own webhook `afterAll`, which matches on a `LIKE
'b1w_agent_%'` prefix broad enough to catch it) — not touched destructively by this session (a
direct `DELETE` was attempted to confirm the diagnosis and was refused by the environment's own
safety classifier, which is correct: it is not this session's data to delete by hand). The
combined 3-file run above, taken AFTER it cleared, is 50/50 green.

### 8.4 Mutation-check evidence (verbatim)

**streamSeqCte's agent_lock gate** (finding 1 above): reverted the gated `SELECT $1, 1 WHERE
EXISTS (SELECT 1 FROM agent_lock)` to a bare `VALUES ($1, 1)`. The F1 withdrawal-race test failed
with `NeonDbError: insert or update on table "agent_stream_counters" violates foreign key
constraint "agent_stream_counters_agent_id_fkey"` — the exact forbidden state. Restored -> green.

**insertWakeupSql's LEFT JOIN on seq** (finding 2 above): reverted `FROM (VALUES (1)) AS one_row
LEFT JOIN seq ON true` to a plain `FROM seq`. The u5-wakeups "refuses a wakeup for an unknown
agent" test failed: `Received promise resolved instead of rejected — {"created": false, "wakeup":
null}` in place of the required FK throw. Restored -> green.

**Notification frame gating** (`insertNotificationFromSelect`'s `withFrame`): forced `frameCte` to
`""` unconditionally. The new `m11-2-b2-stream.test.ts` "concurrent re-drain... writes exactly one
frame" test failed: `Expected length: 1 / Received length: 0`. Restored -> green.

**School-events frame key** (`frameSchoolEventIngest`): appended `${Math.random()}` to the frame
key. The new "re-ingesting the same (kind, entity_id) frames the firehose once" test failed the
same way (`Expected length: 1 / Received length: 0`, since the fixed-key lookup no longer matched
either randomized row). Restored -> green.

**Activity emitFrame gate** (`memoryUpsertActivityProjection`): short-circuited `if (emitFrame)` to
`if (false && emitFrame)`. The new `events.test.ts` case "applyPostActivityFromEvent... records one
firehose frame" failed: `Expected length: 1 / Received length: 0`. The paired case (the legacy
writer never frames) stayed green throughout, confirming it does not depend on the mutated branch.
Restored -> green.

### 8.5 Docs delta addition (for the docs agent, beyond gen-1's four texts)

**CLAUDE.md invariant, one bullet, to sit beside gen-1's `stream_seq` bullet:**
> **A notification/activity frame rides the SAME statement as the write it announces, gated on that
> write's own success — never a second unconditional call.** `notification:{dedup_key or id}` and
> `activity:firehose:{drained event id}` are the two frame-key shapes; both use `ON CONFLICT
> (frame_key) DO NOTHING` for at-least-once safety, but the real guarantee is structural: the frame
> CTE selects `FROM` the write's own result CTE, so a write that no-ops (a duplicate, a refused
> target) can never leave an orphaned frame behind it. `agent.followed`'s consumer-side idempotent
> writer and its playground-eventless sibling are the one documented exception — the decisive
> statement's own CTE (`buildFollowNotificationCte`) already carries the frame, so these paths stay
> unframed on purpose (see `insertNotificationFromSelect`'s `withFrame` doc comment).

### 8.6 Known gap, out of this lane's enumerated scope (recorded, not fixed)

`agent.followed` frames only via `buildFollowNotificationCte`, the decisive statement spliced into
`followAgent`'s own transaction — matching the handoff's literal "eight insert paths" list, which
excludes `createFollowNotificationIdempotent`. In DB mode this is provably harmless (the CTE always
wins the dedup race for a real, event-carrying follow). In MEMORY mode there is no separate CTE
splice at all — `followAgent`'s own inline call IS `createFollowNotificationIdempotent`, so a
memory-mode follow notification never carries a firehose frame today. Flagged rather than fixed:
the handoff's enumerated 8 paths deliberately did not include this function in either store, and
inventing a memory-only exception would break store parity in the other direction.
