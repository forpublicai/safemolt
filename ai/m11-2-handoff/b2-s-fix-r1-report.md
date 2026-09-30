# b2-s fix round 1 — report

Source: `ai/m11-2-handoff/b2-s-fix-r1-spec.md` (codex round 1, the only review round for lane S).
All 10 items done. No round 2.

FENCE note: this run's dispatch fenced off `src/lib/store/stream/memory.ts`, `src/lib/store/notifications/{db,memory}.ts` and `src/lib/agent-pulse/*` as owned by concurrent agents. Item 10 (NIT) originally called for editing `stream/memory.ts` too; that half is deferred (see §5).

## 1. Per-item changes

1. **MAJOR — school frame atomicity.** `src/lib/store/activity/events.ts`: `activityFrameCte` now takes a ready SQL expression instead of only a `sourceEventParam`; `upsertActivityEventFromSelect` gained `explicitFrameKeyParam`; `recordActivityEventInDatabase`/`recordActivityEvent` gained an `options.frameKey` that rides the SAME insert statement as an `activity_frame` CTE gated on `RETURNING` (db mode) or the same synchronous section as `memoryUpsertActivityProjection` already uses (memory mode, `void recordStreamFrame(...)` with no `await` in between). `src/app/api/v1/internal/school-events/route.ts:50-74`: deleted the two-call `frameSchoolEventIngest` helper; `POST` now passes `{ frameKey: `activity:firehose:${kind}:${entityId}` }` into one `recordActivityEvent` call.
2. **MAJOR — hidden frames stall the cursor.** `src/lib/worker/stream-server.ts:250-257` (`sendLedgerFrames`): `seenFrameIds.add` and `lastFrameId` advance for EVERY examined frame, before the hidden-actor filter runs.
3. **MAJOR — firehose capped by a shared key.** `src/lib/worker/stream-server.ts:377-380` (`serveFirehose`): no `tryAcquireConnection`/`releaseKey` call at all — public, anonymous, uncapped. `MAX_CONNECTIONS_PER_AGENT` now only ever gates a real agent id.
4. **MAJOR — history replay on connect.** Two changes: (a) `getLatestStreamFrameId(agentId)` (new, `stream-server.ts:196-217`, own db/memory branch — see §5 for why memory reads `_memory-state.streamFrames` directly) initializes `state.lastFrameId` before the tail starts; (b) `ConnectionState.connectedAtMs` (set once, at true connect time) bounds the query's own time-based overlap re-scan in `sendLedgerFrames` (`stream-server.ts:254`) — the re-scan matches on recency alone, so (a) alone isn't enough for a frame written just before connect.
5. **MAJOR — slot leak on early disconnect.** `replayThenTail` (`stream-server.ts:288-360`) now attaches `req.on("close", cleanup)` BEFORE any `await`; `cleanup` is idempotent (`closed` flag, `if (keepAlive)`/`if (tail)` guards) and owns releasing `releaseKey`. `serveFirehose`/`servePrivateStream` no longer register their own `finally { req.on("close", ...) }` — one registration, one release path.
6. **MAJOR — symmetry test didn't test the adapters.** `src/__tests__/lib/symmetry-contract.test.ts`: deleted `mapToRestBody`/`mapToToolBody`; the new `adapter-mapping projection` test calls the REAL `POST` route handler (`src/app/api/v1/posts/[id]/comments/route.ts`) and the REAL `executors.create_comment` (`src/lib/agent-tools/definitions/comments.ts`), both fed the SAME controlled `ActionResult` through one `jest.fn(actual.createComment)` (module-level `jest.mock("@/lib/actions/comments", ...)`, real behavior preserved for the untouched wakeup-symmetry describe block above it).
7. **MINOR — concurrent ticks.** `tickInFlight` boolean guard in `replayThenTail`'s `tick()` (`stream-server.ts:339-355`): a tick that's still running skips the next timer fire.
8. **MINOR — wrong context href.** `buildWakeupStreamPayload` (`stream-server.ts:130-140`): `context_href: "/api/v1/agents/me/context"`.
9. **MINOR (reduced) — no cron→SSE proof.** New describe block in `src/__tests__/integration/m11-2-b2-stream.test.ts` (`stream-server — end-to-end SSE delivery`): starts the real `handleStreamRequest` on an ephemeral `node:http` server against the reserved Neon DB, connects a raw SSE client, writes a notification through the real store (`createWebhookDisabledNotificationIdempotent`), asserts the frame arrives within 2s.
10. **NIT — duplicate type/mapper.** `src/lib/store/stream/db.ts:34-40`: removed `rowToWakeupWithSeq`; `listWakeupFramesForReplay` now returns `StoredWakeup[]` via `rowToWakeup` directly (it already carries `streamSeq`, landed in the b1 fix loop). `StoredWakeupWithSeq` stays as a `@deprecated` alias for `StoredWakeup` — `stream/memory.ts` (fenced this run) still imports that name, so it can't be deleted outright; see §5. `stream-server.ts` imports `StoredWakeup` directly, no alias. Header comments in `stream/db.ts` and `stream-server.ts` updated — the splice has landed, not pending.

## 2. Gate results (exact commands + tails)

```
npx tsc --noEmit -p tsconfig.json
-> (clean, no output)
```

```
npx eslint src/lib/worker/stream-server.ts src/lib/store/activity/events.ts src/lib/store/stream/db.ts \
  src/lib/store/stream/index.ts src/app/api/v1/internal/school-events/route.ts \
  src/lib/agent-tools/definitions/comments.ts src/__tests__/lib/worker/stream-server.test.ts \
  src/__tests__/lib/symmetry-contract.test.ts src/__tests__/integration/m11-2-b2-stream.test.ts
-> 3 pre-existing warnings (school-events POST complexity 19, events.ts readActivityProjectionByKey
   15 and listActivityEventsFromDatabase 17 — same numbers the b2-lane-s-report.md gen-2 section
   already recorded before this fix round), 0 errors.
```

```
npx jest src/__tests__/lib/worker/stream-server.test.ts src/__tests__/lib/symmetry-contract.test.ts \
  src/__tests__/lib/stream/token.test.ts src/__tests__/api/v1/stream-token-route.test.ts
-> Test Suites: 4 passed, 4 total / Tests: 27 passed, 27 total
```

```
npm test -- src/__tests__/lib/store src/__tests__/lib/events src/__tests__/lib/worker \
  src/__tests__/lib/stream src/__tests__/lib/boundary src/__tests__/lib/symmetry-contract.test.ts src/__tests__/api
-> Test Suites: 104 passed, 104 total / Tests: 1081 passed, 1081 total
```

```
npm run test:integration -- src/__tests__/integration/m11-2-b2-stream.test.ts
-> Test Suites: 1 passed, 1 total / Tests: 5 passed, 5 total
   (seq-blocking, two idle wakeups, concurrent re-drain one frame, school-ingest frames once,
    NEW: SSE end-to-end delivery within 2s)
```

```
npm run gen:boundary
-> "wrote the generated block into .eslintrc.json"; git diff --stat .eslintrc.json empty —
   no new store export needed a boundary entry (no export names changed, only signatures)
```

## 3. Mutation-check evidence (verbatim, MAJOR items 1–6)

**Item 1 (school frame atomicity)** — changed the route's `{ frameKey: ... }` to `{ frameKey: undefined }`:
```
✕ re-ingesting the same (kind, entity_id) frames the firehose once
Expected length: 1
Received length: 0
```
Restored -> green (`re-ingesting the same (kind, entity_id) frames the firehose once ✓`).

**Item 2 (hidden-frame cursor stall)** — moved the `seenFrameIds.add`/`lastFrameId` update to AFTER the hidden-actor filter (the old order):
```
✕ advances past a full batch of hidden frames so a later public one is still reached (finding 2)
timed out waiting for 1 frame(s)
```
Restored -> green.

**Item 3 (firehose cap)** — reintroduced `tryAcquireConnection("__firehose__")` in `serveFirehose`:
```
✕ is not capped by the per-agent connection limit — three anonymous clients all connect (finding 3)
Expected: 200
Received: 503
```
Restored -> green.

**Item 4 (live-only cursor)** — set `connectedAtMs: 0` at connect (defeats the overlap-window bound):
```
✕ does not replay a frame written before connect — notifications/firehose are live-only (finding 4)
Expected length: 0
Received length: 1
Received array:  [{"data": "{\"ref_id\":\"act-preconnect-1\"}", "event": "activity", "id": null}]
```
Restored -> green.

**Item 5 (slot leak)** — moved `req.on("close", cleanup)` to after the initial replay `await` (the old order). The mutated code genuinely leaks a live connection with forever-running timers (the same defect finding 5 describes), so a plain `jest` run hung outright; verified with `--forceExit --testTimeout=8000` for a bounded, readable failure:
```
✕ frees the slot when the client disconnects mid-replay, before cleanup was ever attached (finding 5)
Expected: 200
Received: 503
```
Restored -> green, and the SAME test now passes under a normal (non-`--forceExit`) run too (no lingering handles once the order is correct).

**Item 6 (adapter-mapping test doesn't test the adapters)** — changed the REAL tool executor's mapping (`src/lib/agent-tools/definitions/comments.ts`) from `comment_id: result.data.comment.id` to `comment_id: result.data.comment.postId`:
```
✕ REST and tool bodies are both projections of one ActionResult, and are not wire-identical
Expected: "commentmum8s02r2"
Received: "postmum8s02r3"
```
This is exactly the class of regression the OLD test (local copies of both mappings) could not have caught. Restored -> green.

## 4. Shared-file edits

None. No `src/lib/events/kinds.ts`, `coverage.ts`, `store.ts`, `export-manifest.ts`, `migrate.js`, `migration-ledger.ts`, or `agent-tools/index.ts` edits this round — no new store export, no new event kind, no new migration.

## 5. Out-of-fence needs and cross-lane notes

- **Item 10 is only half done.** The spec's literal text also wanted `stream/memory.ts` to drop its `StoredWakeupWithSeq` import in favor of `StoredWakeup`, and its header comment updated. This run's dispatch explicitly fenced `src/lib/store/stream/memory.ts` off ("another agent is editing it right now"), so `stream/db.ts` keeps `StoredWakeupWithSeq` as a `@deprecated` type alias (`= StoredWakeup`, zero runtime cost) purely so that file's import keeps compiling. Once the fence lifts: delete the alias from `stream/db.ts`, change `stream/memory.ts`'s import/return type from `StoredWakeupWithSeq` to `StoredWakeup`, and drop the alias from `stream/index.ts`'s re-export list.
- **Item 4's `getLatestStreamFrameId` has a memory-mode workaround, not a store primitive.** It lives inside `stream-server.ts` itself (db branch queries `stream_frames` directly; memory branch reads `_memory-state.streamFrames.rows` directly) rather than as a new export of `stream/memory.ts`, for the same fence reason as above — this file already had exactly this workaround pattern for `isFirehoseActorHidden`. Once the fence lifts, this could move into a real `stream/{db,memory}.ts` export pair if wanted, but is not required — the current form is correct and tested (both unit, memory mode, and integration, db mode).
- No other cross-lane collisions observed. `git status` at the end of this session shows unrelated concurrent edits to `notifications/{db,memory}.ts`, `agent-pulse/runner.ts`, `agent-tools/definitions/messages.ts`, `events/consumers/coverage.ts`, `public/*`, `agents.md` from other agents active in this tree — none of them touched by this session, and a final `tsc --noEmit` + full targeted `jest` run (after those files' concurrent edits) is still clean/green (see §2), so nothing here depends on or is broken by that other work.

## 6. Docs delta

None. No public-facing behavior changed beyond bug fixes to already-documented P5.2/P5.3 contracts (live-only notifications/firehose, the 2-per-agent cap excluding the public firehose, the context-href value, comment-adapter field-name asymmetry) — gen-1's and gen-2's docs delta texts in `b2-lane-s-report.md` already cover those correctly and need no revision.

## 7. Behavior changes / plan deviations

- **The public firehose (`GET /v1/stream/firehose`) is now genuinely uncapped**, where before it silently shared a cap with every other anonymous client (a bug, not a documented behavior — fixing it is the intended change, matching P5.2's "public firehose" framing).
- **`context_href` in a wakeup SSE frame changed from `/` to `/api/v1/agents/me/context`** — a bug fix (Decision 8), not a new field.
- **Notifications/firehose activity frames are now strictly live-only**, including a frame written in the few seconds just before a client connects (previously reachable via the tail's own overlap re-scan). This is what P5.2 already specified; the fix closes an unintended exception the overlap mechanism created, not a new restriction beyond the plan.
- Everything else matches the fix spec as written.
