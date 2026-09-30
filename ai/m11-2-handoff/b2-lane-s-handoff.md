# b2 Lane S — handoff (marker `b1-fixes-landed.md` still absent at lane end)

Everything buildable WITHOUT touching `src/lib/store/wakeups/*`, `src/lib/store/notifications/*`,
`src/lib/events/consumers/*`, `src/lib/store/activity/*`, `src/app/api/v1/internal/school-events/*`
is done and green (see `b2-lane-s-report.md` for full detail, gate output, mutation-check evidence).
This file names ONLY the remaining edits, to be done after `ai/m11-2-handoff/b1-fixes-landed.md`
exists — re-read `b1-common-rules.md` and `b2-lane-s-sse-symmetry-spec.md` in full before starting,
since the b-1 fix loop may have changed the shape of the files below in the interim.

## Remaining work (in dependency order)

1. **`src/lib/store/wakeups/db.ts`** — splice a seq-allocating CTE into the three insert paths
   (`enqueueWakeup`, `createOrReArmWakeup`, `createOrReArmPlaygroundRoundWakeup`), the same way the
   webhook ledger CTE is already spliced (see `webhookLedgerCte`/`insertWakeupSql` for the pattern).
   The CTE: `INSERT INTO agent_stream_counters (agent_id, last_seq) VALUES ($1, 1) ON CONFLICT
   (agent_id) DO UPDATE SET last_seq = agent_stream_counters.last_seq + 1 RETURNING last_seq`, joined
   into the wakeup insert's `SELECT` so the new row's `stream_seq` = the counter's returned value.
   The row lock is held to commit, so per-recipient commit order = seq order (do not add any
   separate locking — the `ON CONFLICT ... DO UPDATE` already serializes per `agent_id`). Add
   `streamSeq: number | null` to `rowToWakeup` in the same file. Memory twin:
   `src/lib/store/wakeups/memory.ts` (or wherever the memory enqueue lives) must call
   `src/lib/store/_memory-state.ts`'s already-added `streamSeqCounters` map (built by this lane,
   unwired) to assign the same value on each insert/re-arm.
2. **`src/lib/store/notifications/db.ts`** — append the frame CTE (`stream_frames(agent_id, frame=
   'notification', ref_id, frame_key='notification:{agent}:{event_id}') ON CONFLICT DO NOTHING`) to
   ALL EIGHT insert paths named in the spec's header: `createNotification` (inline),
   `buildFollowNotificationCte`, and the six `create*NotificationIdempotent` writers (comment,
   playground round open, webhook disabled, dm received, reaction, mention). Use
   `src/lib/store/stream/db.ts`'s existing `recordStreamFrame`-shaped SQL as the reference for the
   exact `stream_frames` column list; do not call the function itself from inside a CTE-based
   statement — inline the SQL fragment, matching `webhookLedgerCte`'s own style (a shared SQL-string
   builder function, not a runtime function call, since these are all pieces of ONE statement).
   Memory twin: each memory notification writer must also call `recordStreamFrame` (the real
   function this time, since memory mode has no CTE-splicing constraint) — see
   `src/lib/store/stream/memory.ts`.
3. **`src/lib/events/consumers/activity-trail.ts`** — the consumer's public upserts append
   `frame='activity'`, `agent_id NULL`, key `activity:firehose:{event_id}`. Splice into
   `applyPostActivityFromEvent`/`applyCommentActivityFromEvent`/etc. in `src/lib/store/activity/db.ts`
   (the underlying upsert statements those apply-functions call) — NOT into `activity-trail.ts`
   itself, which only orchestrates; the actual SQL lives in the activity store module. Memory twin
   in `src/lib/store/activity/memory.ts` calls `recordStreamFrame` directly.
4. **`src/app/api/v1/internal/school-events/route.ts`** — append its own firehose frame
   (`frame='activity'`, `agent_id NULL`, `frame_key` derived from the school event's own upsert key)
   in the same `recordActivityEvent` call or immediately after it (this route is NOT a CTE-based
   statement, so calling `recordStreamFrame` directly, as a second store call, is correct here and
   does not need the CTE-splicing discipline the other two do — there is no companion decisive
   statement to gate on, per Decision 5's documented exception).
5. Wire up `src/lib/worker/stream-server.ts`'s firehose hidden-actor filter to a proper store getter
   once one becomes available (currently a local read-only `sql`/memory-map probe inside
   `stream-server.ts` — see that file's own doc comment) — optional cleanup, not required for
   correctness.
6. Re-run `src/__tests__/lib/worker/stream-server.test.ts` once real data flows through (it currently
   exercises directly-seeded fixtures; once (1)-(3) land, add the two integration-only cases from the
   spec's deliverable 8 that need the real seq CTE: `src/__tests__/integration/m11-2-b2-stream.test.ts`
   (db: seq-blocking — a held counter row blocks the concurrent same-agent enqueue; concurrent
   re-drain yields one frame per key; two idle wakeups get distinct seqs; the reconciliation script
   assigns a NULL-seq row a valid unique seq; school-ingest frames once).
7. Run `npm run gen:boundary` again at the true lane end (already run once this session; re-run if
   any of the above adds a new store export).

## What NOT to redo

The migration (`scripts/migrate-m11-stream.sql` + the two runbook scripts), the stream-token module +
route, `src/lib/store/stream/*` (the frames/seq PRIMITIVE — reuse its functions, do not reinvent),
`src/lib/worker/stream-server.ts`, the `worker/index.ts` mount hook, the retention wiring in
`event-drain-pass.ts`, and `src/__tests__/lib/symmetry-contract.test.ts` are all DONE and green — see
`b2-lane-s-report.md`.
