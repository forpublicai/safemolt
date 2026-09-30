# b1 Lane R — P6.2 Reactions (spec)

Read `ai/m11-2-handoff/b1-common-rules.md` first. Then `ai/PLAN_M11_2.md` lines 349–351 (P6.2
verbatim), `CLAUDE.md` invariants ("A parent-liveness check inside a write is a FOR SHARE LOCK",
"The vote write is one statement", the comment rate-limit shape in `store/comments/db.ts`),
`src/lib/actions/posts.ts` (the vote actions — your adapter template), `src/lib/about-timeline-
reactions.ts` (`validateReactionEmoji` — reuse, do not copy), `src/lib/store/rate-limit-windows.ts`,
`src/lib/agent-tools/definitions/comments.ts` (tool shape), the post/comment serializers.

## Mission

Emoji reactions on posts and comments: one table, two actions, four routes, two tools, counts in
serializers, one notification. KISS: the statement shape is the plan's two-statement batch, and
nothing beyond it.

## Deliverables

1. **Migration** `scripts/migrate-m11-reactions.sql`: `content_reactions` exactly as printed
   (PK `(agent_id, subject_type, subject_id, emoji)`, `agent_id REFERENCES agents(id) ON DELETE
   CASCADE` per Decision 10, index `(subject_type, subject_id)`), plus `agent_rate_limits` gains
   `reaction_count_date DATE` and `reaction_count INT NOT NULL DEFAULT 0`. Idempotent. Append to
   `scripts/migrate.js` and `REQUIRED_MIGRATIONS` (the runner's tools reach it).
2. **Store** `src/lib/store/reactions/{db,memory,index}.ts`:
   - `addReaction({agentId, subjectType, subjectId, emoji, dailyLimit}, events)` — the plan's
     batch: statement 1 seeds the agent's `agent_rate_limits` row idempotently; statement 2 is ONE
     CTE statement: lock the rate row `FOR UPDATE` (rolling `reaction_count` to 0 when
     `reaction_count_date <> CURRENT_DATE`), take the live subject `FOR KEY SHARE` (`posts …
     deleted_at IS NULL`, or `comments` joined to its live post), insert `ON CONFLICT DO NOTHING`
     gated on under-cap, increment the quota and render the `reaction.added` event ONLY from the
     insert's `RETURNING`. Project the classification as a scalar SELECT (`subject_exists`,
     `inserted`, `over_cap`) so the caller never re-reads. Result:
     `{ outcome: 'added' | 'already_reacted' | 'not_found' | 'rate_limited', counts }`.
   - `removeReaction(...)` — uncapped, one statement, `reaction.removed` gated on the DELETE's
     `RETURNING`.
   - `getReactionCounts(subjectType, subjectIds[])` → `Record<subjectId, Record<emoji, count>>`
     (one query for a page of posts/comments).
   - `deleteReactionsForPostBatchElement(postId)`: the SQL element (text + params) the
     `deletePost` batch appends — deletes reactions on the post AND on its comments. Memory twin
     as a function. Memory store mirrors the gate and the daily cap (`_memory-state.ts` map + reset).
3. **`deletePost` cleanup**: append your element to the `deletePost` batch in
   `src/lib/store/posts/db.ts` (edit ONLY that function — Lane M edits the rest of the file;
   re-read immediately before editing) and the memory twin. The reaction rows go in the same
   transaction as the tombstone.
4. **Kinds**: `reaction.added` payload `{ subject_type, subject_id, emoji, author_id }` (subject
   column = the content id; `author_id` = the content author, so the notification consumer needs
   no re-read for the recipient but still re-checks liveness), `reaction.removed` same payload.
   Coverage: `reaction.added` → notifications `on`, others `none`; `reaction.removed` → `none`
   everywhere (history-only).
5. **Consumer**: notifications plans `reaction_added` (new `NotificationType`), recipient = the
   content author, skipped when the subject is gone or the reactor is the author; dedup key per
   Decision 6; NO wakeup. Idempotent insert in `store/notifications/*` — add it ONLY after
   `ai/m11-2-handoff/b1-lane-w-wakeups-done.md` exists (Lane W is editing that store first); do
   the rest of the lane meanwhile and record the dependency if the marker never appears.
6. **Action** `src/lib/actions/reactions.ts`: `addReaction(agent, {subjectType, subjectId,
   emoji})` / `removeReaction(...)`: school rule as the vote actions apply it, vetted agents,
   `validateReactionEmoji`, `REACTION_DAILY_LIMIT` env (default 200), `rate_limited` carries
   `retryAfterSeconds = secondsUntilUtcMidnight()`. Result data `{ subject_type, subject_id,
   emoji, counts }`.
7. **Routes** `src/app/api/v1/posts/[id]/reactions/route.ts` and
   `src/app/api/v1/comments/[id]/reactions/route.ts`: POST/DELETE with body `{emoji}`, house
   envelope, 404/409(`already_reacted`)/429 mapping mirrors the vote routes.
8. **Tools** `src/lib/agent-tools/definitions/reactions.ts`: `add_reaction`/`remove_reaction`
   (terminal mutating tools, same executor shape as the vote tools), registered in
   `agent-tools/index.ts`.
9. **Serializers**: `reactions: {emoji: count}` on post and comment payloads wherever the vote
   counts are serialized (one batched count read per page, never N+1).
10. **Tests**: `src/__tests__/lib/store/reactions-memory.test.ts` (idempotent react/unreact,
    counts, delete-cleans-reactions incl. comment reactions, cap binds + `retry_after_seconds`,
    removal uncapped, duplicate charges nothing and emits nothing, notification projected, no
    wakeup); `src/__tests__/integration/m11-2-b1-reactions.test.ts` (db: concurrent react-vs-
    delete both orders for both subject types; concurrent duplicate reacts → one row, one event,
    one quota increment; delayed-consume: react → delete → drain emits no notification);
    `src/__tests__/api/reactions-routes.test.ts` (route + tool parity through the one action).

## Fences

- NEW: `src/lib/store/reactions/`, `src/lib/actions/reactions.ts`, the two route dirs,
  `src/lib/agent-tools/definitions/reactions.ts`, `scripts/migrate-m11-reactions.sql`, tests.
- EDIT (yours alone): the post/comment serializer file(s), `src/lib/store/_memory-state.ts`
  (your map + reset only), `.env.example`; `src/lib/store/posts/{db,memory}.ts` ONLY inside
  `deletePost`.
- SHARED (append-only): kinds, coverage, store-types, notifications consumer, store.ts,
  export-manifest, migrate.js, migration-ledger, agent-tools/index.ts.
- DO NOT TOUCH: `src/lib/store/{wakeups,webhooks,dms,comments}/`, `src/lib/actions/{posts,
  comments,dms,webhooks}.ts`, `src/lib/agent-senses/**`, `worker/**`, `about/timeline` reactions
  (backlog; its route stays a named exemption), public docs, inventory.

## Gates before you report

tsc clean; lint 0 errors, no new complexity warnings; your jest files + `src/__tests__/lib/events`
+ `src/__tests__/lib/karma-writer-ownership.test.ts` + `src/__tests__/lib/group-school-gate.test.ts`
green (the school-gate scan must see your two mutations in the action scan); your integration
file green; `npm run gen:boundary` at lane end + boundary tests green. Report per the common
format with the docs delta (reference.md reactions section, openapi paths + `reactions` field,
skill.md one line).
