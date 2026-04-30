# M4 plan: Replace the activity-feed UNION-ALL read path with a polymorphic `activity_events` append-only log

## Status after M2.5 speed-priority decision

This plan is superseded if `ai/PLAN_M2_5.md` is executed as written. The user clarified that speed is supreme, even if later milestones need to be redone, so the core `activity_events` implementation moved forward into M2.5.

After M2.5 lands, rewrite M4 as a burn-in and next-speed milestone:

- Delete the `ACTIVITY_FEED_SOURCE=union` rollback path after production confidence.
- Tune `activity_events` search and pagination with real production data.
- Consider `pg_notify` plus an SSE endpoint for live feed updates.
- Add retention or partitioning only if row counts justify it.
- Keep the M4 validation spirit: parity, performance, and production proof.

## Summary

The activity feed today has the right *user-visible* shape but the wrong *write architecture*. As of M1's perf pass, `listActivityFeed` (`store/activity/db.ts` after M2) is a single CTE that `UNION ALL`s six per-source SELECTs across `posts`, `comments`, `evaluation_results`, `playground_sessions`, `playground_actions`, and `agent_loop_action_log`. Every page of `/api/activity` re-derives "what happened" by joining and filtering six tables.

This works, and after M1's per-source `LIMIT` and covering indexes it's fast enough. But it has three structural problems:

1. **Adding a seventh source means editing a 200-line SQL block.** When M3's tool-call dispatch emits a brand-new activity type (say, `class_evaluation_completed`), there's no clean place to add it — the activity-feed SQL has to be re-engineered to know about a seventh table.
2. **The activity sources have different time-column conventions** (`created_at`, `completed_at`, `COALESCE(started_at, completed_at, created_at)`) and Postgres can't use a single index across them. Each source needs its own composite index, which M1 already added but represents permanent maintenance cost.
3. **Read-path-only normalization means the read path does work the writers should have done.** Every read computes `actor_name`, `actor_canonical_name`, `summary`, `search_text`, `metadata` from joins — those are derived facts that don't change after the activity happened. Writers should compute them once at the moment of the activity and store them for later reads.

M4 introduces an `activity_events` append-only log. Every domain that produces user-visible activity calls `recordActivityEvent(...)` at the moment of the action. The activity feed reads from this single table with a single `ORDER BY occurred_at DESC LIMIT n` query. The six existing source tables remain the source of truth for their entities; `activity_events` is purely the activity-feed denormalization.

This depends on **M2** (the per-domain store split — every domain owns its writers, so `recordActivityEvent` calls live next to the entity creates) and **M3** (the agent-loop unification — there is now exactly one tool-execution write site, not two).

Out of scope, on purpose:
- No new activity types. M4 migrates the existing six sources, no more.
- No change to the JSON shape returned by `/api/activity` or `/api/activity/{kind}/{id}/context`. The frontend keeps consuming the same `StoredActivityFeedItem` shape.
- No removal of the existing tables. `posts`, `comments`, `evaluation_results`, etc. remain the source of truth for entities. M4 only adds `activity_events` as a derived projection.
- No real-time / subscription model. M4 is still pull-based; the activity trail still refreshes on the same 5-second ISR + client polling cadence M1 set up.
- No deletion of the six covering indexes M1 added. Those are still useful for entity-direct queries (e.g. "list this agent's recent posts"). M4 only changes what `listActivityFeed` reads, not what `listRecentEvaluationResults` reads.

---

## HOW TO EXECUTE A MILESTONE

[Reproduced verbatim from `ai/PLAN.md` so this document is fully self-contained.]

If the user asks you to execute on a plan, these are the steps to take.

1. Implement the plan
   - You should check your work with AI autonomous validation and testing.
   - The hope is that implementation can be done with a minimum of user interaction, preferably none at all.
   - Once it is complete, fill in the "Validation" section to the bottom of the plan showing how you have validated it and what were the results.
   - You might have discovered better engineering
2. Perform your testing and validation
   - Update the "AI VALIDATION RESULTS" section of your PLAN_M{n}.md file
3. Review your own code. Also, ask Claude to review your work
   - Provide context: PLAN_M{n}.md and which files/functions you've worked on.
   - Iterate with Claude until no more changes (max 10 rounds). Do NOT reference previous rounds.
4. After implementation, do a "better engineering" phase
   - Clean up LEARNINGS.md and ARCHITECTURE.md per the learnings decision tree.
   - Launch all five Claude review tasks in parallel: correctness, AGENTS.md style, LEARNINGS.md compliance, milestone goal satisfaction, KISS/consolidation/refactor.
5. Upon completion, ask for user review with concrete walkthrough steps.

---

## Locked user decisions

1. **One table, one read query.** `activity_events` schema:
   ```sql
   CREATE TABLE activity_events (
     id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     kind          TEXT NOT NULL,                 -- "post" | "comment" | "evaluation_result" | "playground_session" | "playground_action" | "agent_loop"
     occurred_at   TIMESTAMPTZ NOT NULL,
     actor_id      TEXT,                           -- agent id; nullable for system events
     actor_name    TEXT,                           -- denormalized at write time
     actor_canonical_name TEXT,                    -- denormalized at write time
     entity_id     TEXT NOT NULL,                  -- the post id, comment id, eval result id, etc
     title         TEXT NOT NULL,
     href          TEXT,
     summary       TEXT NOT NULL,
     context_hint  TEXT NOT NULL DEFAULT '',
     search_text   TEXT NOT NULL DEFAULT '',
     metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );

   CREATE INDEX idx_activity_events_occurred ON activity_events(occurred_at DESC, id);
   CREATE INDEX idx_activity_events_kind_occurred ON activity_events(kind, occurred_at DESC);
   CREATE INDEX idx_activity_events_actor ON activity_events(actor_id, occurred_at DESC);
   CREATE INDEX idx_activity_events_entity ON activity_events(kind, entity_id);
   CREATE INDEX idx_activity_events_search ON activity_events USING GIN (to_tsvector('english', search_text));
   ```

2. **`(kind, entity_id)` is unique per logical event.** The constraint `UNIQUE (kind, entity_id)` is added on top of the schema above. This means a post create writes one event with `kind="post"` and `entity_id=<post.id>`. If a post is edited (not currently possible but planned), the same `(kind, entity_id)` row gets updated, not duplicated. The agent-loop case writes `kind="agent_loop"` and `entity_id=<agent_loop_action_log.id>`, so each loop action is a separate row.

3. **App-level writes, not Postgres triggers.** Every entity-creating store function calls `recordActivityEvent(...)` at the end. No `CREATE TRIGGER`. Reasons:
   - Triggers hide writes. A new developer reading `createPost` would not see the activity write happen.
   - The denormalized fields (`actor_name`, `summary`, etc.) require joining `agents`, looking up groups, formatting strings — easier in TypeScript than PL/pgSQL.
   - In-memory store has no triggers; we'd duplicate the trigger logic in TS for `store-memory` anyway. Doing it in TS once is simpler.

4. **Writes are best-effort, never block the entity write.** `createPost` returns the post even if the activity event write fails. The fall-back is a backfill cron (Phase 4) that catches up missing events. We deliberately accept eventual consistency for the activity feed.

5. **Backfill from existing tables, deletions allowed.** Phase 4's backfill SQL re-derives every historical `activity_events` row from the six source tables using the same denormalization logic the M1 SQL did. Production cutover requires the backfill to complete before the read path switch. The backfill is idempotent (`INSERT … ON CONFLICT (kind, entity_id) DO UPDATE` so re-running fills new rows without duplicating).

6. **`listActivityFeed`'s public signature does not change.** Same `StoredActivityFeedOptions`, same `StoredActivityFeedItem[]` return type. Internal SQL collapses from 200 lines to ≈ 30:
   ```sql
   SELECT id, kind, occurred_at, actor_id, actor_name, actor_canonical_name,
          title, href, summary, context_hint, search_text, metadata
   FROM activity_events
   WHERE (${before}::timestamptz IS NULL OR occurred_at < ${before}::timestamptz)
     AND (${q}     = ''   OR LOWER(search_text) LIKE ${like})
     AND (${kindCount} = 0  OR kind = ANY(${kinds}::text[]))
   ORDER BY occurred_at DESC, id DESC
   LIMIT ${limit}
   ```
   The dual-tiebreaker `(occurred_at DESC, id DESC)` matches the new `idx_activity_events_occurred` covering index for keyset pagination.

7. **Per-source covering indexes M1 added stay.** They serve other queries (e.g. `listRecentPlaygroundActions`). M4 only changes the activity-feed read path.

8. **Search uses GIN-tsvector, not LIKE.** The current LIKE-on-LOWER scan is fine for small data but degrades fast. M4 adds `idx_activity_events_search` (GIN), and the search code path in `listActivityFeed` uses `to_tsvector('english', search_text) @@ plainto_tsquery('english', ${q})` when `q` is non-empty. The LIKE fallback is removed.

9. **Memory & context endpoints are unchanged.** `getCachedActivityContext` / `upsertActivityContext` / `generateOrGetActivityContext` keep working against `activity_contexts` keyed by `(kind, entity_id, prompt_version)`. M4 simply makes `entity_id` consistent across all sources (it already is — M1's row mapping uses each source's `id` as the activity feed item's `id`).

10. **The "agent_loop" event type continues to be a separate event, not folded into the underlying tool's event.** When a loop tick calls `create_post`, **two** events get written: one `kind="post"` (the post creation) and one `kind="agent_loop"` (the autonomous-loop attribution row). This matches today's behavior and lets the UI deduplicate the agent_loop row when the underlying post row exists (the existing `dedupeActivities` in `src/lib/activity.ts:575` continues to work).

11. **No new dependencies.**

### Executor questions deferred to user signoff

- **Q1.** Should the writer also publish a Postgres `NOTIFY` so a future server-sent-events surface can pick up live activity? *Recommendation: skip in M4 (no consumer exists), but design the writer so adding `pg_notify('activity_events', ...)` later is a one-line change.*
- **Q2.** During backfill, how do we handle the read-path cutover — feature flag, a hot swap with a fallback to the union SQL, or a hard switch on deploy? *Recommendation: env var `ACTIVITY_FEED_SOURCE = "events" | "union"` defaulting to `events`. The union SQL stays in code (one file) for one milestone after M4 ships, then gets removed in M5 cleanup. This buys safe rollback.*
- **Q3.** After M4 lands and burns in for a milestone, can `listRecentCommentsWithPosts`, `listRecentEvaluationResults`, `listRecentPlaygroundActions`, `listRecentAgentLoopActions` be deleted entirely? They're only callers from the old activity union; nothing else uses them today. *Recommendation: delete in M5. Leave them in M4.*
- **Q4.** GIN tsvector search materializes English stemming. This is good for "evaluation"-vs-"evaluations" matches but bad for non-English content (agent names with accents, code snippets). Should we use `simple` instead of `english`? *Recommendation: `simple`. Agent identity content is multilingual and we don't want stemming surprises. Documented at the index definition.*

---

## PLAN

Five phases. Phases 1-3 prepare the new system in parallel with the old one; Phase 4 cuts the read path over; Phase 5 deletes the old union SQL after burn-in.

### Phase 1 — Schema and writer

#### 1.1 Migration

`scripts/migrations/2026-XX-add-activity-events.sql`:

```sql
CREATE TABLE IF NOT EXISTS activity_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                  TEXT NOT NULL,
  occurred_at           TIMESTAMPTZ NOT NULL,
  actor_id              TEXT,
  actor_name            TEXT,
  actor_canonical_name  TEXT,
  entity_id             TEXT NOT NULL,
  title                 TEXT NOT NULL,
  href                  TEXT,
  summary               TEXT NOT NULL,
  context_hint          TEXT NOT NULL DEFAULT '',
  search_text           TEXT NOT NULL DEFAULT '',
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (kind, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_activity_events_occurred ON activity_events(occurred_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_activity_events_kind_occurred ON activity_events(kind, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_events_actor ON activity_events(actor_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_events_entity ON activity_events(kind, entity_id);
CREATE INDEX IF NOT EXISTS idx_activity_events_search ON activity_events USING GIN (to_tsvector('simple', search_text));
```

Update `scripts/schema.sql` to mirror this.

#### 1.2 The writer

`src/lib/store/activity/writer.ts` (new):

```ts
import { sql, hasDatabase } from "@/lib/db";

export interface ActivityEventInput {
  kind: "post" | "comment" | "evaluation_result" | "playground_session" | "playground_action" | "agent_loop";
  occurredAt: string;          // ISO
  actorId?: string;
  actorName?: string;
  actorCanonicalName?: string;
  entityId: string;
  title: string;
  href?: string;
  summary: string;
  contextHint?: string;
  searchText?: string;
  metadata?: Record<string, unknown>;
}

/** Best-effort: writes an activity_events row. Never throws — failures are logged and absorbed. */
export async function recordActivityEvent(input: ActivityEventInput): Promise<void> {
  try {
    if (!hasDatabase()) {
      // In-memory: append to in-memory list mirror (see writer-memory.ts)
      return recordActivityEventMemory(input);
    }
    await sql!`
      INSERT INTO activity_events (
        kind, occurred_at, actor_id, actor_name, actor_canonical_name,
        entity_id, title, href, summary, context_hint, search_text, metadata
      ) VALUES (
        ${input.kind}, ${input.occurredAt}::timestamptz, ${input.actorId ?? null},
        ${input.actorName ?? null}, ${input.actorCanonicalName ?? null},
        ${input.entityId}, ${input.title}, ${input.href ?? null},
        ${input.summary}, ${input.contextHint ?? ""}, ${input.searchText ?? ""},
        ${JSON.stringify(input.metadata ?? {})}::jsonb
      )
      ON CONFLICT (kind, entity_id) DO UPDATE SET
        occurred_at = EXCLUDED.occurred_at,
        actor_id = EXCLUDED.actor_id,
        actor_name = EXCLUDED.actor_name,
        actor_canonical_name = EXCLUDED.actor_canonical_name,
        title = EXCLUDED.title,
        href = EXCLUDED.href,
        summary = EXCLUDED.summary,
        context_hint = EXCLUDED.context_hint,
        search_text = EXCLUDED.search_text,
        metadata = EXCLUDED.metadata
    `;
  } catch (err) {
    console.error("[activity_events] write failed:", err, "input:", input);
    // Swallow — backfill will catch up.
  }
}
```

In-memory mirror in `src/lib/store/activity/writer-memory.ts`:

```ts
import type { ActivityEventInput } from "./writer";

const events: ActivityEventInput[] = [];

export function recordActivityEventMemory(input: ActivityEventInput): void {
  // Match UNIQUE (kind, entity_id): if exists, replace.
  const idx = events.findIndex((e) => e.kind === input.kind && e.entityId === input.entityId);
  if (idx >= 0) events[idx] = input;
  else events.push(input);
}

export function listActivityEventsMemory(/* options */): ActivityEventInput[] { /* ... */ }
```

### Phase 2 — Wire writers into every entity creator

This is the largest change in M4 by line count, but each call site is one-line: at the end of the existing `createPost` / `createComment` / `saveEvaluationResult` / `createPlaygroundSession` / `createPlaygroundAction` / `logAction` (in agent-runtime after M3), add a `recordActivityEvent({...})` call.

Each call needs to compute the same denormalized fields the M1 union SQL computed. The mapping is documented per source below — these are the only six places M4 modifies for writes.

#### 2.1 Posts (`src/lib/store/posts/db.ts:createPost`)

```ts
const post = /* … existing insert … */;
const author = await getAgentById(post.authorId);
const group = await getGroup(post.groupId);
await recordActivityEvent({
  kind: "post",
  occurredAt: post.createdAt,
  actorId: post.authorId,
  actorName: author?.displayName || author?.name || post.authorId,
  actorCanonicalName: author?.name || post.authorId,
  entityId: post.id,
  title: post.title,
  href: `/post/${post.id}`,
  summary: `Post in ${group ? `g/${group.name}` : "a group"}: ${post.title}`,
  contextHint: post.content || post.url || post.title,
  searchText: [author?.displayName, author?.name, "post", post.title, post.content, group?.name].filter(Boolean).join(" "),
  metadata: { post_id: post.id, group: group?.name, upvotes: post.upvotes, comments: post.commentCount },
});
return post;
```

The same logic in `store/posts/memory.ts` for the in-memory variant.

#### 2.2 Comments (`src/lib/store/comments/db.ts:createComment`)

Same pattern; `kind: "comment"`, `entityId: comment.id`, joins post for `summary` text. Mirrors the M1 SQL block at `store-db.ts:1125-1146`.

#### 2.3 Evaluation results (`src/lib/store/evaluations/db.ts:saveEvaluationResult`)

`kind: "evaluation_result"`, `entityId: result.id`, `occurredAt: result.completedAt`. Mirrors the M1 SQL block at `store-db.ts:1148-1172`.

#### 2.4 Playground sessions (`src/lib/store/playground/db.ts:createPlaygroundSession` and `updatePlaygroundSession`)

Tricky one: the union SQL today picks `COALESCE(s.started_at, s.completed_at, s.created_at)` as `occurred_at` — which means the same session shows up at different times in the feed depending on its lifecycle stage. To preserve current behavior, we write **on every status transition**:
- `createPlaygroundSession` writes the row with `occurred_at = createdAt`, `metadata.status = "lobby"`.
- `activatePlaygroundSession` updates the row (via the `ON CONFLICT … DO UPDATE`) with `occurred_at = startedAt`, `metadata.status = "active"`.
- The session's "completed" transition (find via `grep status:"completed"`) updates with `occurred_at = completedAt`, `metadata.status = "completed"`.

Each is one extra `recordActivityEvent` call per transition.

#### 2.5 Playground actions (`src/lib/store/playground/db.ts:createPlaygroundAction`)

Standard — `kind: "playground_action"`, `entityId: action.id`. Mirrors the M1 SQL block at `store-db.ts:1200-1221`.

#### 2.6 Agent loop actions

After M3, the loop logs via `agent-runtime`'s `onToolExecuted` callback. M4 replaces that callback's body to write to `activity_events`:

```ts
onToolExecuted: async (call, res) => {
  const logRow = await logAction(agentId, call.name, /* … */);  // existing agent_loop_action_log write stays
  await recordActivityEvent({
    kind: "agent_loop",
    occurredAt: logRow.createdAt,
    actorId: agentId,
    actorName: agent.displayName || agent.name,
    actorCanonicalName: agent.name,
    entityId: logRow.id,                       // unique per loop action
    title: `${agent.displayName || agent.name} ${call.name}`,
    href: inferHref(call, res),
    summary: summarizeForFeed(call, res),
    contextHint: extractContent(call.arguments),
    searchText: [agent.displayName, agent.name, call.name].join(" "),
    metadata: { target_type: inferTargetType(call), target_id: inferTargetId(call, res), action: call.name },
  });
}
```

The existing `agent_loop_action_log` table stays — it's the source of truth for cron scheduling decisions (cooldowns read from it). `activity_events` is a derived projection only.

### Phase 3 — Update `listActivityFeed` and `listActivityEventsMemory`

Replace the 200-line union SQL in `store/activity/db.ts:listActivityFeed` with the 30-line query from Locked Decision #6. Drop the per-source `WHERE ${includePosts}` machinery — kind filtering is now `kind = ANY(${kinds}::text[])` against a single column.

`store/activity/memory.ts:listActivityFeed` becomes:

```ts
export async function listActivityFeed(options: StoredActivityFeedOptions = {}): Promise<StoredActivityFeedItem[]> {
  const all = listActivityEventsMemory();
  return filterAndSort(all, options).slice(0, options.limit ?? 30).map(toStoredFeedItem);
}
```

Equivalent shape, equivalent semantics. The complex multi-table iteration the in-memory store does today goes away.

### Phase 4 — Backfill

A new admin-gated route `POST /api/v1/internal/activity-events-backfill` populates `activity_events` from the existing source tables. Idempotent: uses the `(kind, entity_id)` `UNIQUE` constraint with `ON CONFLICT DO NOTHING` so re-running is safe.

The backfill is six SELECTs (one per source table) feeding a batched INSERT. Each batch is `INSERT INTO activity_events (...) SELECT ... FROM posts ...` style — pure SQL, no app-side iteration. Reuses the SQL fragments from the M1 union.

Cutover protocol:
1. Deploy M4 with `ACTIVITY_FEED_SOURCE = "union"` (env var, the legacy path).
2. Wait for the new writers to populate `activity_events` for live traffic (≈ a few minutes).
3. Trigger the backfill: `curl -X POST .../api/v1/internal/activity-events-backfill`. Wait for `{ done: true, rows: <n> }`.
4. Flip env: `ACTIVITY_FEED_SOURCE = "events"`. Activity feed now reads from `activity_events`.
5. Verify on production: `/` activity trail looks identical to before; `EXPLAIN ANALYZE` on the new query shows index-only scans.
6. After 7 days of clean traffic, M5 deletes the union SQL (Phase 5 below).

### Phase 5 — Delete the union SQL after burn-in

Not part of M4 itself. M5 (the next milestone after M4) deletes the union SQL block from `store/activity/db.ts:listActivityFeedFromUnion` and the `ACTIVITY_FEED_SOURCE` env var. Documented here so M5 doesn't forget.

---

## BETTER ENGINEERING INSIGHTS + BACKLOG ADDITIONS

1. **`activity_contexts` cache key (`kind, entity_id, prompt_version`) now matches `activity_events.(kind, entity_id)` exactly.** That symmetry was accidental in M1; M4 makes it intentional. Document in `LEARNINGS.md`: "When a derived projection table cites a primary entity, the cite tuple should be `(entity_kind, entity_id)` everywhere."
2. **The denormalization at write time means schema migrations to `agents.display_name` won't auto-propagate to historical activity rows.** If an agent renames, their old activity rows still show the old name. This is correct for an audit log but might surprise the user. Document the policy: "Activity feed reflects the actor's display at the moment of action."
3. **GIN-tsvector search opens the door to phrase search and ranking** in the activity-search box. M5 could add `ts_rank(...)` to the ORDER BY when `q` is non-empty. Defer.
4. **The `pg_notify('activity_events', ...)` line we deferred could power a `/api/activity/stream` SSE endpoint** for real-time feed updates, replacing the 5-second ISR + client polling with push. Big UX win, big code addition. Schedule for later when the product calls for it.
5. **The agent_loop event's deduplication against the underlying entity event** currently happens in JavaScript (`dedupeActivities` in `src/lib/activity.ts:575`). After M4 it could move into SQL: `WHERE NOT EXISTS (SELECT 1 FROM activity_events e2 WHERE e2.kind = e1.metadata->>'target_type' AND e2.entity_id = e1.metadata->>'target_id')`. Defer; the JS path is fast and tested.
6. **The `activity_events` table will grow unboundedly.** A cleanup job (e.g. delete events older than 1 year for non-evaluation kinds) is a future concern. For now, partition by month if growth becomes an issue. Document the threshold for action: > 10M rows.
7. **The chat path doesn't write activity events** (Locked Decision in M3 §6). When the user has the agent post via chat, only the underlying entity write (post create) emits an event, not an "agent_loop"-style attribution row. This is intentional: chat actions are human-attributed. If the product wants "Mohsin's agent posted X via chat" attribution someday, M5 can add a `kind="dashboard_action"` event from the chat path's runtime callback.

---

## AI VALIDATION PLAN

### Static checks

1. `npm run lint` clean.
2. `npx tsc --noEmit` clean.
3. `npm test` clean.
4. `npm run build` clean — runs the new migration.

### Migration & schema validation

5. `psql $DATABASE_URL -c "\d activity_events"` shows the table with all six indexes and the `UNIQUE (kind, entity_id)` constraint.
6. `psql -c "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'activity_events';"` shows `idx_activity_events_search` is GIN.

### New tests M4 must add

7. `src/__tests__/lib/store/activity/writer.test.ts`:
   - `recordActivityEvent({...})` inserts a row.
   - Calling twice with same `(kind, entity_id)` updates the row, doesn't duplicate.
   - On in-memory store, the row appears in `listActivityEventsMemory`.
8. `src/__tests__/lib/store/activity/feed.test.ts`:
   - Insert 30 mixed-kind events. `listActivityFeed({limit: 10})` returns the 10 most recent.
   - `listActivityFeed({types: ["post"], limit: 10})` returns only post events.
   - `listActivityFeed({query: "uniqueWord"})` returns only events with `uniqueWord` in `search_text`.
   - `listActivityFeed({before: middle.occurredAt, limit: 5})` returns events older than `middle`.
9. `src/__tests__/lib/store/activity/parity.test.ts`: with both `ACTIVITY_FEED_SOURCE` values, same fixture, same returned shape (deep-equal).
10. `src/__tests__/api/activity-events-backfill.test.ts`: seeded posts/comments/evals → POST backfill → `activity_events` count matches sum of source rows. Re-run backfill → count unchanged.

### Behavioral parity (the cutover safety net)

11. Boot a fresh DB (drop + migrate). Insert ~100 fixture entities across all six sources via the M3 store APIs. Capture the activity feed from `/api/activity?limit=100` with `ACTIVITY_FEED_SOURCE=union`. Run the backfill. Switch to `ACTIVITY_FEED_SOURCE=events`. Capture the same response. Diff: must be byte-equivalent (modulo non-deterministic ordering ties — break ties in both queries by `(occurred_at DESC, id DESC)`).
12. Same exercise for `/api/activity?types=post,comment&q=hello&limit=20`.

### Performance check

13. Seed 1M `activity_events` rows (use a Postgres `generate_series` INSERT). Run `EXPLAIN ANALYZE SELECT ... FROM activity_events ORDER BY occurred_at DESC LIMIT 30;`. Expected: index scan on `idx_activity_events_occurred`, total time < 5ms.
14. Same with `WHERE kind = 'post'` — expected scan on `idx_activity_events_kind_occurred`, total time < 5ms.
15. Same with `to_tsvector('simple', search_text) @@ plainto_tsquery('simple', 'evaluation')` — expected GIN bitmap scan, < 30ms even at 1M rows.

### Production verification

16. Vercel preview deploy with `ACTIVITY_FEED_SOURCE=union`. Activity trail unchanged from M3.
17. Trigger backfill: `curl -X POST <preview>/api/v1/internal/activity-events-backfill`. Wait for completion.
18. Set `ACTIVITY_FEED_SOURCE=events` env var on preview, redeploy.
19. Refresh `/`. Visual diff against the union baseline: zero pixel difference (modulo timestamps that may have advanced).
20. Open DevTools → Network. `/api/activity` response time should be lower than M1 baseline by at least 30% for `limit=40` queries (no more six-table union).

---

## AI VALIDATION RESULTS

*To be filled by the executor during M4 implementation.*

- [ ] `next lint` clean
- [ ] `tsc --noEmit` clean
- [ ] `jest` clean (4 new test files)
- [ ] `next build` clean
- [ ] `\d activity_events` shows all 5 indexes + UNIQUE constraint
- [ ] Backfill on preview completes
- [ ] Behavioral parity test (union vs events) deep-equal
- [ ] EXPLAIN ANALYZE on 1M rows: < 5ms unfiltered, < 5ms by-kind, < 30ms by-search
- [ ] `/api/activity` response time on preview is ≥ 30% lower than M1 baseline
- [ ] Preview URL: <link>

---

## USER VALIDATION SUGGESTIONS

1. Open the preview URL with `ACTIVITY_FEED_SOURCE=events`. The activity trail at `/` should look exactly like it did at the end of M3. If anything is missing or out of order, that's a bug.
2. Take an action that produces an activity row (e.g. send your agent to make a post via the dashboard chat). Within 10 seconds it should appear at the top of `/`. If it doesn't, the writer is failing silently — check `vercel logs` for `[activity_events] write failed`.
3. Search the activity trail for a word you know appears in a recent activity. The result should be instant (GIN tsvector). Compare to M3 where the LIKE-on-LOWER scan was noticeably slower at scale.
4. Filter by a single kind (click `[post]` filter). Only post events should appear, instantly.
5. Open DevTools → Network on `/`. Time the `/api/activity` response. Compare against your M3 baseline (you noted timings in the M1 validation log). Should be ≥ 30% faster.
6. As a safety check: flip `ACTIVITY_FEED_SOURCE=union` on the preview env, redeploy. The trail should be identical (the rollback path works). Flip back to `events`.
7. SSH/`psql` to the preview DB. Run `SELECT kind, COUNT(*) FROM activity_events GROUP BY kind;`. The counts should match `(SELECT COUNT(*) FROM posts) + (SELECT COUNT(*) FROM comments) + ...` for the corresponding kinds.
8. Open `src/lib/store/activity/db.ts`. The 200-line union SQL has either been replaced by a 30-line single-table read (if `ACTIVITY_FEED_SOURCE=events` is the only path post-burn-in) or coexists with a comment marking the union as the legacy fallback.
9. Open `src/lib/store/posts/db.ts:createPost`. The `recordActivityEvent({ kind: "post", ...})` call appears at the bottom. The same pattern is visible in `comments/db.ts:createComment`, `evaluations/db.ts:saveEvaluationResult`, `playground/db.ts:createPlaygroundSession` and `:createPlaygroundAction`, and in the agent-runtime's `onToolExecuted` callback (after M3).
