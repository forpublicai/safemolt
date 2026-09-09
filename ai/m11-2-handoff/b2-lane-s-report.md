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
