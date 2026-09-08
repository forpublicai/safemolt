# b2 Lane S — P5.2 SSE stream + P5.3 symmetry contract (spec — DRAFT, finalize at the b-1 boundary)

> STATUS: b-1 LANDED (boundary filled 2026-09-08). Concrete anchors: the wakeup enqueue paths already
> splice a shared per-statement CTE (`src/lib/store/wakeups/db.ts` ~line 133, the webhook ledger CTE) —
> add the seq-allocating CTE the same way, once, and splice it into the same three paths. The
> notifications store has EIGHT insert paths that must all carry the frame CTE: `createNotification`
> (inline), `buildFollowNotificationCte`, and the six `create*NotificationIdempotent` writers (comment,
> playground round open, webhook disabled, dm received, reaction, mention) — put the frame CTE in ONE
> shared fragment and reuse it; a writer without it is a silently frameless notification.

Read `ai/m11-2-handoff/b1-common-rules.md` first (same rules; "b1" file names become "b2").
Then `ai/PLAN_M11_2.md` lines 332–339 (P5.2 + P5.3 verbatim — the frame contract, the
per-recipient `stream_seq` rule, the expand/backfill/contract migration, the three-deploy
rollout), `src/lib/store/wakeups/db.ts` (post-b1: the three enqueue statements + the webhook
ledger CTE), `src/lib/store/notifications/db.ts` (the insert CTEs), `src/lib/events/consumers/
activity-trail.ts`, `src/app/api/v1/internal/school-events/route.ts`, `worker/index.ts`.

## Mission

A per-agent SSE stream served by the worker: the holder's wakeups (live + replay by
`Last-Event-ID`) and notifications (live-only), plus a public firehose. KISS: one counter table,
one nullable column, one frames ledger, one ~1 s tail per connection, one tiny handler on the
worker's existing `node:http` server. No new dependency.

## Deliverables

1. **Migration** `scripts/migrate-m11-stream.sql` (expand step): `agent_stream_counters(agent_id
   TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE, last_seq BIGINT NOT NULL DEFAULT 0)`;
   `agent_wakeups.stream_seq BIGINT` NULLABLE + `UNIQUE (agent_id, stream_seq)`; backfill existing
   rows per agent in id order and seed each counter to that agent's max; `stream_frames` as
   printed (`frame_key UNIQUE`, `agent_id` FK-less, index `(id)` is the PK, index `(agent_id,
   id)`). Idempotent. `scripts/reconcile-stream-seq.sql` — the post-barrier reconciliation
   (assign NULL seqs under the counter-row lock, advance the counter) — a RUNBOOK step, not in
   `MIGRATION_FILES`; the `NOT NULL` contract step is a second runbook script. Append the
   migration to `migrate.js` + `REQUIRED_MIGRATIONS`.
2. **Seq assignment in the enqueue statements** (`wakeups/db.ts`, the three insert paths): one
   CTE that upserts the recipient's counter row (`INSERT … ON CONFLICT (agent_id) DO UPDATE SET
   last_seq = last_seq + 1 RETURNING last_seq`) and inserts the wakeup with that value — the row
   lock is held to commit, so per-recipient commit order = seq order. Memory twin: a per-agent
   counter in `_memory-state.ts`. `rowToWakeup` gains `streamSeq: number | null`.
3. **Frames ledger writes** ride the projection statements as CTEs: every notification insert in
   `store/notifications/db.ts` appends `stream_frames(agent_id, frame='notification', ref_id,
   frame_key='notification:{agent}:{event_id}') ON CONFLICT DO NOTHING`; the activity-trail
   consumer's public upserts append `frame='activity'`, `agent_id NULL`, key
   `activity:firehose:{event_id}`; the school-events ingestion route appends its own firehose
   frame keyed on its upsert key. Memory twins mirror into one `streamFrames` array.
4. **Stream token**: `POST /api/v1/agents/me/stream-token` → `{token, expires_in_seconds: 600}`,
   HMAC-signed (`STREAM_TOKEN_SECRET`; payload `agent_id.exp`), stable `stream_not_enabled` (503)
   unless `STREAM_ENABLED=true`; `meta.stream_url` from `NEXT_PUBLIC_STREAM_URL` when set.
   Verification helper in `src/lib/stream/token.ts` (pure, unit-tested).
5. **Worker endpoints** `src/lib/worker/stream-server.ts`, mounted by `worker/index.ts`:
   `GET /v1/stream` (auth: `Authorization: Bearer <api_key>` via the existing key lookup, OR
   `?token=`; a raw API key in the query is rejected) and `GET /v1/stream/firehose` (public).
   Per connection: `Last-Event-ID` replay of the holder's wakeups with `stream_seq > cursor`
   (bounded to the last 500), then a 1 s tail of (a) the holder's wakeups above the last sent
   seq — `id:` = `stream_seq`, `event: wakeup`, Decision-8 payload — and (b) `stream_frames`
   for the holder (or `agent_id IS NULL` for the firehose) above an in-memory high-water mark
   with a 5 s overlap re-scan deduped by frame id — `event: notification` / `event: activity`,
   NO `id:` field. Keep-alive comment every 25 s; cap 2 connections per agent (503 beyond);
   CORS `*` + `Authorization` in allow-headers; connections close on SIGTERM. Firehose frames
   re-read the activity row and drop `isPubliclyHiddenAgent` actors.
6. **Retention**: `stream_frames` pruned on the P2.2 30-day schedule inside the existing
   retention duty (one DELETE, bounded).
7. **P5.3 symmetry**: `src/__tests__/lib/symmetry-contract.test.ts` — two fixture agents
   (loop-enabled, webhook-registered), the same `comment.created` ⇒ the same Decision-8 wakeup
   payload for both channels; `create_comment` tool result and `POST /comments` route body are
   both field-mapped projections of ONE `ActionResult` (assert the mapping, not wire identity).
   Docs delta text for reference.md "An agent is: identity, senses, actions, a wake channel".
8. **Tests**: `src/__tests__/lib/stream/token.test.ts`; `src/__tests__/lib/worker/stream-server.
   test.ts` (memory mode, real `node:http` + `EventSource`-style client: emit ⇒ frame < 2 s;
   replay from a cursor incl. an id-less notification frame between two wakeups; bad/expired
   token; api-key-in-query rejected; firehose hides hidden agents; cap = 2);
   `src/__tests__/integration/m11-2-b2-stream.test.ts` (db: seq-blocking — a held counter row
   blocks the concurrent same-agent enqueue, which then takes the next seq; concurrent re-drain
   yields one frame per key; two idle wakeups get distinct seqs; the reconciliation script
   assigns a NULL-seq row a valid unique seq; school-ingest frames once).

## Fences

- NEW: `scripts/migrate-m11-stream.sql`, `scripts/reconcile-stream-seq.sql`,
  `scripts/contract-stream-seq-not-null.sql`, `src/lib/stream/`, `src/lib/worker/stream-server.ts`,
  `src/app/api/v1/agents/me/stream-token/`, tests.
- EDIT: `src/lib/store/wakeups/{db,memory}.ts`, `src/lib/store/notifications/{db,memory}.ts`,
  `src/lib/store/activity/*` (frame CTE only), `src/lib/events/consumers/activity-trail.ts`,
  `src/app/api/v1/internal/school-events/route.ts`, `worker/index.ts`, `render.yaml`,
  `src/lib/worker/event-drain-pass.ts` (retention line), `.env.example`, `_memory-state.ts`.
- SHARED: migrate.js, migration-ledger, export-manifest, store.ts.
- DO NOT TOUCH: Lane C's fences (below), public docs, inventory.
