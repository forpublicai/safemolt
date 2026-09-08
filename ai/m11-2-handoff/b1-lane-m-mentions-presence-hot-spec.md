# b1 Lane M — P6.1 Mentions + P6.4 Presence + P6.5 Hot decay (spec)

Read `ai/m11-2-handoff/b1-common-rules.md` first. Then `ai/PLAN_M11_2.md` lines 343–347 (P6.1),
381–383 (P6.4), 385–389 (P6.5), and line 296's mention-suppression sentence (P3.2). `CLAUDE.md`
invariants: "Substitutions are PER EVENT", "The store fills what only the statement knows",
"A column reference needs rowSource" — the P1.2 fan-out machinery in `src/lib/store/events/
statement.ts` was built for exactly `agent.mentioned`; read it before designing anything.
Also `src/lib/actions/{posts,comments,agents}.ts`, `src/lib/store/{posts,comments}/db.ts`
(`createPost`/`createComment`), `src/lib/events/consumers/{notifications,wakeup-router}.ts`,
`src/lib/agent-public.ts`, `src/lib/agent-senses/network.ts`, `src/lib/store/posts/db.ts` +
`src/lib/store/groups/db.ts` (the hot sorts) and their memory twins.

## Mission

Three small, independent features. Sequence: P6.5 (hot) → P6.4 (presence) → P6.1 (mentions, the
largest; spawn a Sonnet subagent for the statement work). KISS throughout.

## Deliverables

### P6.5 — Hot with decay + cold-start feed
1. `src/lib/store/hot-score.ts`: `HOT_SCORE_SQL` (a fragment taking `$now` as a bound
   parameter) and `hotScore(post, nowMs)` (TS twin) implementing the plan's formula verbatim:
   `s = upvotes - downvotes + comment_count * 0.5`; positive `s` decays as
   `s / power(GREATEST(age_hours, 1) + 2, 1.5)`; non-positive `s` is NOT divided. Tie-break
   `score DESC, created_at DESC, id DESC`.
2. Apply to every hot sort site (grep `upvotes - downvotes` AND `sort === "hot"` in
   `store/posts/db.ts`, `store/groups/db.ts` and the memory twins — the plan counts four db
   sites; find them all). `top`/`new` unchanged. Add `sort=hot` characterization test running
   identical fixtures (negative, zero, positive scores at several ages, fixed `now`) through
   both stores and asserting identical order + the semantics (old −10 below new −1; negatives
   below zero/positive).
3. Cold start: `/api/v1/feed` falls back to P4.1's global fallback when the agent has no groups
   and no follows, with `meta.feed_mode: "personalized" | "fallback"`. One test.

### P6.4 — Presence
4. `presenceBucket(lastActiveAt, nowMs)` in `src/lib/agent-public.ts`:
   `active_now` (<10 min) / `today` (<24 h) / `this_week` (<7 d) / `dormant`. Surfaced as
   `presence` on public agent summaries (find the shared serializer), on
   `AgentContext.network` as `active_now_count` over followed agents, and as
   `GET /api/v1/agents?filter=active_now`. Hidden agents excluded. No raw timestamp added to any
   public payload.
5. Single-writer discipline test `src/__tests__/lib/presence-writer.test.ts`: scan `src/lib` and
   `src/app` for `last_active_at` writes; the ONLY allowed sites are the auth touch's store
   function(s) in `src/lib/store/agents/db.ts` (+ memory twin) — inspect lines ~278/677/832 and
   decide which are the touch; if `updateAgent`'s `lastActiveAt` field has no live caller, delete
   it (less bloat) rather than allowlisting it.

### P6.1 — Mentions
6. Registration enforcement: `registerAgent` (actions/agents.ts) refuses a name outside
   `AGENT_NAME_GRAMMAR` with `bad_request` (message names the grammar). Keep
   `meta.deprecations` in the response shape (Decision 11) but it is now always `[]` — delete the
   notice builder if nothing else uses it. Update the existing P1.4 tests accordingly.
7. `src/lib/mentions.ts`: `extractMentions(text)` — pattern `@([a-zA-Z0-9_-]{2,64})`, lowercase,
   dedupe, first 5. Pure, unit-tested (prefix capture `@Alice Bot` → `alice`; code blocks NOT
   special-cased — documented).
8. Resolution + events: in `createPost`/`createComment` actions, resolve names case-insensitively
   (one new store read `listAgentsByNamesCaseInsensitive(names)` — db uses `LOWER(name) = ANY`,
   the C5 index), drop self and `isPubliclyHiddenAgent`, and pass ONE derived
   `agent.mentioned` PreparedEvent per recipient (payload `{ source_type: 'post'|'comment',
   source_id, mentioned_agent_id }`, subject = the mentioned agent) into the SAME store call as
   the primary event. Where the store mints the source id (`post.created`'s `post_id`), the store
   fills `source_id` from the minted id for every derived event that carries the
   `STORE_ASSIGNED_PAYLOAD_ID` marker — extend the minimal existing per-event substitution, never
   a parallel mechanism. Memory twins mirror. Kind entry in `kinds.ts`; coverage: notifications
   `on`, wakeup-router `on`, activity-trail `none`, memory-ingest `none`.
9. Consumers: notifications plans a `mention` notification (dedup key per Decision 6, target =
   the post; comment source carries `comment_id` in metadata); the wakeup-router routes
   `agent.mentioned` to reason `mention` — post source always wakes; comment source is
   SUPPRESSED iff the mentioned agent is that comment's `comment_on_my_post`/`reply_to_my_comment`
   target (derive from the comment row: parent author, or post author for a top-level comment —
   never from existing wakeup rows). `agent-senses/inbox.ts`'s `String(type) === "mention"`
   becomes the typed comparison. The runner already handles reason `mention`.
10. Tests: `src/__tests__/lib/mentions.test.ts` (extractor); memory-mode e2e
    `src/__tests__/lib/events/mentions-e2e.test.ts` — post mention and comment mention each land
    a notification + a wakeup; cap/self/hidden/case; suppression fires only for comment sources
    and only for the reply target; registration rejects a nonconforming name;
    `src/__tests__/integration/m11-2-b1-mentions.test.ts` — the derived events are in the SAME
    statement as the content write (a failed mention event aborts the post; the P1.2 fan-out
    proof pattern), and the store-filled `source_id` equals the minted post id.

## Fences

- NEW: `src/lib/store/hot-score.ts`, `src/lib/mentions.ts`, the tests above.
- EDIT (yours alone): `src/lib/actions/{posts,comments,agents}.ts`, `src/lib/store/posts/{db,
  memory}.ts` EXCEPT the `deletePost` function (Lane R edits only that function — re-read before
  each edit), `src/lib/store/comments/{db,memory}.ts`, `src/lib/store/groups/{db,memory}.ts`
  (hot feed sort only), `src/lib/store/agents/{db,memory,index}.ts` (the name read + presence
  filter), `src/lib/store/events/statement.ts` (minimal substitution extension only),
  `src/lib/agent-public.ts`, `src/lib/agent-senses/{network,inbox}.ts`,
  `src/app/api/v1/agents/route.ts`, `src/app/api/v1/feed/route.ts`, the agent serializer, the
  existing P1.4 registration tests.
- SHARED (append-only): kinds, coverage, store-types, notifications consumer, wakeup-router,
  export-manifest.
- DO NOT TOUCH: `src/lib/store/wakeups/**`, `src/lib/store/notifications/**` (if you need a new
  idempotent insert for `mention`, add it ONLY after `ai/m11-2-handoff/b1-lane-w-wakeups-done.md`
  exists; until then keep the planner ready and record the dependency), `src/lib/store/
  {webhooks,reactions,dms}/`, `src/lib/agent-tools/**`, `worker/**`, public docs, inventory.

## Gates before you report

tsc clean; lint 0 errors, no new complexity warnings; your jest files + `src/__tests__/lib/events`
+ `src/__tests__/api/agents*` + `src/__tests__/lib/actions` green; your integration file green;
`npm run gen:boundary` at lane end + boundary tests green. Report per the common format with
the docs delta (reference.md mentions + presence + hot; heartbeat.md "mentions now true";
openapi enum `mention`, `presence`, `filter=active_now`, `meta.feed_mode`).
