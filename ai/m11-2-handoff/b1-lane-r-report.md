# b1 Lane R — P6.2 Reactions — report

Manager: Sonnet, this session. All ten spec deliverables are DONE and verified. One real
implementation bug was found by the integration tests and fixed (see §7). Two pre-existing tests
broke as a side effect of the new `reactions` serializer field and were updated (§7). All gates
pass except items that are confirmed another lane's fence (§5).

## 1. Deliverables

| # | Deliverable | Status | Files |
|---|---|---|---|
| 1 | Migration | Done | `scripts/migrate-m11-reactions.sql`, `scripts/migrate.js` |
| 2 | Store (db + memory) | Done | `src/lib/store/reactions/{db,memory,index}.ts` |
| 3 | `deletePost` cleanup | Done | `src/lib/store/posts/db.ts` (inside `deletePost` only), `src/lib/store/posts/memory.ts` (inside `deletePost` only) |
| 4 | Kinds | Done | `src/lib/events/kinds.ts` |
| 5 | Notifications consumer | Done | `src/lib/events/consumers/coverage.ts`, `src/lib/events/consumers/notifications.ts`, `src/lib/store/notifications/{db,memory,index}.ts` |
| 6 | Action | Done | `src/lib/actions/reactions.ts`, `src/lib/actions/types.ts` (`already_reacted` code) |
| 7 | Routes | Done | `src/app/api/v1/posts/[id]/reactions/route.ts`, `src/app/api/v1/comments/[id]/reactions/route.ts` |
| 8 | Tools | Done | `src/lib/agent-tools/definitions/reactions.ts`, `src/lib/agent-tools/index.ts`, `src/lib/agent-runtime/index.ts` (loop routing — see §4, not named in the spec but required by an existing repo-wide gate) |
| 9 | Serializers | Done | `src/app/api/v1/posts/route.ts`, `src/app/api/v1/posts/[id]/route.ts`, `src/app/api/v1/posts/[id]/comments/route.ts`, `src/app/api/v1/groups/[name]/feed/route.ts`, `src/app/api/v1/feed/route.ts`, `src/app/api/v1/search/route.ts`, `src/app/api/v1/agents/profile/route.ts`, `src/lib/agent-tools/definitions/posts.ts`, `src/lib/agent-tools/definitions/comments.ts` — 9 sites, one batched `getReactionCounts` call each, zero N+1. Two sites deliberately left untouched (§5). |
| 10 | Tests | Done | `src/__tests__/lib/store/reactions-memory.test.ts` (9/9), `src/__tests__/integration/m11-2-b1-reactions.test.ts` (8/8), `src/__tests__/api/reactions-routes.test.ts` (16/16) |

## 2. Gate results (exact commands, tails)

**tsc, whole repo, read-only:**
```
npx tsc --noEmit
```
Zero errors, repo-wide, at the end of this session (confirmed after all fixes below landed).

**lint, every file this lane created or edited:**
```
npx eslint scripts/migrate.js src/lib/store/reactions/db.ts src/lib/store/reactions/memory.ts \
  src/lib/store/reactions/index.ts src/lib/store/posts/db.ts src/lib/store/posts/memory.ts \
  src/lib/events/kinds.ts src/lib/events/consumers/coverage.ts src/lib/store-types.ts \
  src/lib/actions/types.ts src/lib/actions/reactions.ts \
  "src/app/api/v1/posts/[id]/reactions/route.ts" "src/app/api/v1/comments/[id]/reactions/route.ts" \
  src/lib/agent-tools/definitions/reactions.ts src/lib/agent-tools/index.ts \
  src/app/api/v1/posts/route.ts "src/app/api/v1/posts/[id]/route.ts" \
  "src/app/api/v1/posts/[id]/comments/route.ts" "src/app/api/v1/groups/[name]/feed/route.ts" \
  src/app/api/v1/feed/route.ts src/app/api/v1/search/route.ts src/app/api/v1/agents/profile/route.ts \
  src/lib/agent-tools/definitions/posts.ts src/lib/agent-tools/definitions/comments.ts \
  src/lib/store/notifications/db.ts src/lib/store/notifications/memory.ts \
  src/lib/store/notifications/index.ts src/lib/events/consumers/notifications.ts \
  src/lib/store/export-manifest.ts src/lib/store/_memory-state.ts src/lib/store.ts \
  src/lib/agent-runtime/index.ts \
  src/__tests__/lib/store/reactions-memory.test.ts src/__tests__/integration/m11-2-b1-reactions.test.ts \
  src/__tests__/api/reactions-routes.test.ts src/__tests__/lib/events-substrate.test.ts \
  src/__tests__/api/v1/feed-cold-start.test.ts src/__tests__/api/v1/envelope-contract.test.ts \
  src/__tests__/api/v1/ux7-contracts.test.ts src/__tests__/api/v1/m11-2-u3-posts-characterization.test.ts \
  --max-warnings=0
```
```
4 problems (0 errors, 4 warnings)
```
All 4 warnings are pre-existing complexity warnings in functions this lane never touched
(`runAgenticTurn`, `activityFeedMatches`, `buildCommentNotification`, `listPosts`) — 0 errors and 0
new warnings from any line this lane wrote.

**Targeted jest — memory store:**
```
npm test -- src/__tests__/lib/store/reactions-memory.test.ts
```
`Tests: 9 passed, 9 total`

**Targeted jest — route/tool parity:**
```
npm test -- src/__tests__/api/reactions-routes.test.ts
```
`Tests: 16 passed, 16 total`

**Targeted integration (real Neon, advisory lock — waited, was not held):**
```
npm run test:integration -- src/__tests__/integration/m11-2-b1-reactions.test.ts
```
```
PASS src/__tests__/integration/m11-2-b1-reactions.test.ts (34.502 s)
  post reactions vs deletePost — both orderings
    ✓ delete-first: the reaction attempt afterward is not_found, writes nothing, emits nothing
    ✓ reaction-first: the reaction succeeds, and the subsequent delete removes it in the same transaction
  comment reactions vs deletePost — both orderings
    ✓ delete-first: the reaction attempt afterward is not_found, writes nothing, emits nothing
    ✓ reaction-first: the reaction succeeds, and the subsequent delete removes it in the same transaction
  concurrent duplicate reacts
    ✓ N racing adds of the exact same (agent, subject, emoji) leave one row, one event, one quota increment
  delayed-consume: a reaction.added event that drains after its subject is gone
    ✓ produces no notification and still receipts cleanly
  rate limit through both surfaces
    ✓ a capped add through either surface writes nothing and emits nothing; DELETE stays uncapped through both
  deletePost's reaction cleanup runs in the same transaction as the tombstone
    ✓ removes a post reaction and a comment reaction together when the post is deleted
Tests: 8 passed, 8 total
```
(First pass by the test-writing subagent showed 2/8 failing on a real bug, reproduced identically on
a second solo run — not a flake. Fixed in `src/lib/store/reactions/db.ts` per §7; this is the
post-fix run, 8/8.)

**Required cross-cutting suites:**
```
npm test -- src/__tests__/lib/events
```
`Test Suites: 8 passed, 8 total / Tests: 143 passed, 143 total`
```
npm test -- src/__tests__/lib/karma-writer-ownership.test.ts src/__tests__/lib/group-school-gate.test.ts
```
`Test Suites: 2 passed, 2 total / Tests: 39 passed, 39 total` (confirms the school-gate scan sees
`addReaction`/`removeReaction` in the ACTION scan — they live only in `src/lib/actions/reactions.ts`,
never called directly from a route or tool).

**Boundary generation + tests:**
```
npm run gen:boundary
```
`gen-eslint-boundary: wrote the generated block into .eslintrc.json` — run TWICE this session: once
mid-lane, then once more after Lane D closed its own `export-manifest.ts` gap (its fix landed
concurrently and the first boundary block had drifted against it). The second run is current.
```
npm test -- src/__tests__/lib/boundary-manifest-completeness.test.ts \
  src/__tests__/lib/boundary-generated-block.test.ts \
  src/__tests__/lib/boundary-mixed-actor-route.test.ts \
  src/__tests__/lib/boundary-ast-discipline.test.ts
```
`Test Suites: 4 passed, 4 total / Tests: 10 passed, 10 total`

**Full repo jest, final state:**
```
npm test
```
`Test Suites: 6 failed, 196 passed, 202 total / Tests: 12 failed, 1990 passed, 2002 total`
Every one of the 6 failing suites is independently confirmed NOT this lane's — see §5 for the
per-suite attribution.

## 3. Mutation-check evidence (verbatim from the test-writing subagent, independently re-verified by me)

1. **Daily cap (memory mode).** If the `usedToday >= input.dailyLimit` gate in
   `store/reactions/memory.ts`'s `addReaction` were removed, the third `addReaction` call past a
   `dailyLimit=2` fixture would return `ok:true` instead of `outcome:"rate_limited"`, and
   `getReactionCounts` for that subject would show a count instead of `{}`. The test's assertion on
   `third.outcome` would observe `"added"` where it expects `"rate_limited"` — a real forbidden
   state, not an assumption.
2. **Duplicate charges nothing (memory mode).** If the `already_reacted` early return were removed,
   a second identical `addReaction` call would fall through to the write path: the memory event
   log's `nextId` would advance a second time (observed as `afterFirst + 1` instead of staying flat)
   and `reactionCountToday.get(reactor.id)?.count` would read `2` instead of `1`. Two independent
   assertions catch this.
3. **Concurrent duplicate reacts (integration, real DB).** If the insert's
   `ON CONFLICT (agent_id, subject_type, subject_id, emoji) DO NOTHING` gate were removed, more than
   one of six racing `addReaction` calls could land a `content_reactions` row; the test's `SELECT
   COUNT(*)` would read >1 instead of exactly 1. This sub-assertion passed on the FIRST run even
   before the cap-bump fix (§7), which is exactly how the real bug was isolated to the `bump`
   CTE specifically rather than to the whole cap/insert mechanism.
4. **The CTE bug itself, as its own mutation check.** Before the fix, the exact forbidden state the
   integration test observed was: `inserted: true` (the reaction row really landed) alongside
   `agent_rate_limits.reaction_count` unchanged at `0` — i.e. the cap accounting silently lost every
   charge in db mode while memory mode charged correctly, which is precisely the kind of two-store
   divergence this milestone's invariants (CLAUDE.md, "store-parity fixtures") exist to catch.

## 4. Shared-file edits, new store exports, classification

| File | Anchor / what was added |
|---|---|
| `scripts/migrate.js` | Appended `{ file: "migrate-m11-reactions.sql", label: "Content reactions and daily rate limit" }` to `MIGRATION_FILES`, last entry. |
| `src/lib/events/kinds.ts` | `reaction.added` / `reaction.removed` added to `EventPayloadMap` under `// ==== M11b lane R: reactions (P6.2) ====`, and to `KIND_MEMBERSHIP`, both at the end. |
| `src/lib/events/consumers/coverage.ts` | One line per kind, end of each of the four manifests: `notificationsCoverage["reaction.added"]="on"` (new-kind-at-birth, no legacy writer — same precedent as `playground.round_opened`), `notificationsCoverage["reaction.removed"]="none"`; both `"none"` in `activityTrailCoverage`, `memoryIngestCoverage`, `wakeupRouterCoverage`. |
| `src/lib/store-types.ts` | `"reaction_added"` appended to `NotificationType`. |
| `src/lib/actions/types.ts` | `"already_reacted"` appended to `ActionErrorCode` — the plan names this refusal explicitly (409 mapping, duplicate-react gate text). |
| `src/lib/store/export-manifest.ts` | New `// --- reactions (src/lib/store/reactions/index.ts) ---` section: `"addReaction"`, `"removeReaction"`, `"deleteReactionsForPostBatchElement"` (mutating; `getReactionCounts` needs no entry — `get` prefix). New line in the notifications section: `"createReactionNotificationIdempotent"`. |
| `src/lib/store.ts` | `export * from "./store/reactions";` appended. |
| `src/lib/agent-tools/index.ts` | `import * as reactions from "./definitions/reactions";` + `reactions,` in `modules`. |
| `src/lib/store/notifications/{db,memory,index}.ts` | `ReactionNotificationInput`, `createReactionNotificationIdempotent` (db + memory + pickStore wiring) — edited only after `ai/m11-2-handoff/b1-lane-w-wakeups-done.md` was confirmed present. |
| `src/lib/events/consumers/notifications.ts` | `planReactionNotification`, the `"reaction"` `PlannedNotification` variant, a `case "reaction.added"` in `plan()`, a new arm in `apply()`. Not on the common-rules shared-file table but touched concurrently by lanes D/M/W too — re-read immediately before every edit; final file correctly threads all four lanes' variants. |
| `src/lib/agent-runtime/index.ts` | **Not named in the lane spec, but required.** `LOOP_TOOL_DOMAINS.discussion` and `LOOP_TERMINAL_TOOLS` both needed `add_reaction`/`remove_reaction` or `src/__tests__/lib/agent-tools/registry.test.ts`'s "routes every platform tool" gate fails for this lane's two new tools. Added both, minimally, alongside the existing `upvote_post`/`upvote_comment` entries. |
| `src/__tests__/lib/events-substrate.test.ts` | Not in the shared-file table but structurally required by every kind-adding lane: added `reaction.added`/`reaction.removed` to the local `COVERAGE` object and to the sorted `EVENT_KINDS` assertion array, in the correct alphabetical position. |

**New store exports and their classification:** `addReaction`, `removeReaction` — mutating (write
`content_reactions` / `agent_rate_limits`). `getReactionCounts` — read (by `get` prefix, no manual
entry needed). `deleteReactionsForPostBatchElement` — mutating by this repo's documented
default-deny rule (a pure SQL-fragment builder in db mode, a direct mutator in memory mode).
`createReactionNotificationIdempotent` — mutating.

## 5. Out-of-fence needs and cross-lane notes

- **Not added:** `migrate-m11-reactions.sql` to `src/lib/worker/migration-ledger.ts`'s
  `REQUIRED_MIGRATIONS`. No worker duty or runner tool reads `content_reactions` or the
  `agent_rate_limits` reaction columns, so per the common-rules criterion ("if the worker's duties or
  the runner's tools read your table") this is a deliberate omission, not a gap.
- **REQUIRED_MIGRATIONS drift observed, not mine to fix:**
  `src/__tests__/lib/worker/migration-ledger.test.ts` currently fails because
  `migrate-m11-webhooks.sql` (Lane W's) is missing from the same list — a Lane W gap, confirmed by
  reading the failing diff (only the webhooks filename is absent; the reactions migration was never
  expected there per the paragraph above).
- **`src/__tests__/lib/store/houses-deleted.test.ts` fails** on two comments containing the word
  "house" as an analogy, in `src/lib/actions/dms.ts:120` and `src/lib/actions/webhooks.ts:72` — Lane
  D's and Lane W's own files, zero relation to reactions.
- **`src/__tests__/lib/agent-tools/registry.test.ts` still fails** on two items after this lane's own
  fix: (a) `PLATFORM_TOOLS.length` (72) now exceeds the hardcoded `<=70` ceiling because multiple
  lanes' tool additions landed the same wave — a shared threshold, not this lane's alone to widen;
  (b) `send_dm`/`list_dms`/`read_dm_thread`/`block_agent`/`unblock_agent` are unrouted in
  `LOOP_TOOL_DOMAINS`/`LOOP_TERMINAL_TOOLS` — Lane D's tools, same file this lane edited for its own
  two tools; Lane D needs the same treatment §4 describes for `add_reaction`/`remove_reaction`.
- **`src/__tests__/api/v1/agents-me-context.test.ts` fails** on the inbox section's `degraded` flag
  via a `dmThreads`/"Agent not found" path in `src/lib/agent-senses/inbox.ts` — Lane D's DM inbox
  section, unrelated to reactions (confirmed by reading the stack trace).
- **`src/__tests__/lib/worker/event-drain-pass-retention.test.ts` fails** on
  `claimNextWebhookDelivery is not a function` — a webhook worker-pass test missing a store mock
  entry, Lane W's.
- **`src/__tests__/playground/round-opened-producers.test.ts` fails** on wakeup-arming assertions
  entirely inside the playground/wakeup domain — confirmed unrelated to reactions by reading the
  failure (no reaction/notification code in the stack).
- **Deliberately excluded from the serializer pass (deliverable 9):**
  - `src/app/api/v1/agents/me/context/serialize.ts` — a documented PURE function (its own doc
    comment: "nothing is dropped, summarized or re-read from storage here"), fed pre-fetched objects
    and diffed by a parity gate against the loop's own prompt renderer. Adding a store call here
    would break that contract; reactions on this surface are a future, larger change (adding a
    `reactions` field to `PostWithThread`/`AgentContext` upstream, then this file just serializes it).
  - `src/app/api/v1/news/route.ts` — `discussion.upvotes` comes from a cached RSS-derived structure
    (`src/lib/rss.ts`, 10-minute TTL), a different domain/cache; wiring live counts through it is out
    of scope for this pass.
- **About-timeline reactions** (`src/app/api/v1/about/timeline/reactions/route.ts`,
  `toggleAboutTimelineReaction`) were read only as a template, never touched — the plan names this
  surface a "named exemption," and this lane respected it.

## 6. Docs delta (exact text for the docs agent)

### `public/reference.md` — new section, insert after "### Upvote a comment" / before "### Vote errors" (~line 536)

```markdown
### React to a post or comment

```bash
curl -X POST https://www.safemolt.com/api/v1/posts/POST_ID/reactions \
  -H "Authorization: Bearer ***" \
  -H "Content-Type: application/json" \
  -d '{"emoji": "🎉"}'
```

```json
{ "success": true, "data": { "subject_type": "post", "subject_id": "post_123", "emoji": "🎉", "counts": { "🎉": 1 } } }
```

The same body and shape works for a comment at
`POST /api/v1/comments/COMMENT_ID/reactions`. `counts` is every emoji currently on that post or
comment, read fresh after your write. Reactions are capped at 200 per day per agent (env-tunable);
removal is uncapped.

### Remove a reaction

```bash
curl -X DELETE https://www.safemolt.com/api/v1/posts/POST_ID/reactions \
  -H "Authorization: Bearer ***" \
  -H "Content-Type: application/json" \
  -d '{"emoji": "🎉"}'
```

Answers the same shape as react, or `404` if you had not reacted with that emoji.

### Reaction errors

| Status | Meaning |
|--------|---------|
| `400` | Invalid or missing `emoji`. |
| `404` | The post or comment does not exist, or was deleted. |
| `409` `already_reacted` | You already reacted to this with this exact emoji. |
| `429` `rate_limited` | Daily reaction cap reached; `retry_after_seconds` counts down to UTC midnight. |
```

Also add one line under "Upvote a post" / "Upvote a comment" cross-references and under the existing
`upvotes`/`downvotes` note in post and comment list responses:

> Posts and comments also carry a `reactions` field: `{ "🎉": 3, "👀": 1 }`, one batched read per
> page — every emoji currently on that item, alongside its vote counts.

### `public/skill.md` — one line, in the feature-summary sentence near the top

Change:
`SafeMolt is the Hogwarts of the agent internet: a social network where AI agents register, post, comment, vote, join groups, take classes, and play social simulations.`
to:
`SafeMolt is the Hogwarts of the agent internet: a social network where AI agents register, post, comment, vote, react with emoji, join groups, take classes, and play social simulations.`

### `public/openapi.json` — two new paths, `/api/v1/posts/{id}/reactions` and `/api/v1/comments/{id}/reactions`

Each gets a `post` and a `delete` operation, tag `"social"`, `operationId` `addPostReaction` /
`removePostReaction` / `addCommentReaction` / `removeCommentReaction`, request body
`{"emoji": {"type": "string"}}` required, 200 response body:
```json
{
  "type": "object",
  "properties": {
    "success": { "type": "boolean" },
    "data": {
      "type": "object",
      "properties": {
        "subject_type": { "type": "string", "enum": ["post", "comment"] },
        "subject_id": { "type": "string" },
        "emoji": { "type": "string" },
        "counts": { "type": "object", "additionalProperties": { "type": "integer" } }
      },
      "required": ["subject_type", "subject_id", "emoji", "counts"]
    }
  },
  "required": ["success", "data"]
}
```
Plus 400/404/409/429 responses using `#/components/schemas/ErrorEnvelope` (mirror the shape already
used for `/api/v1/posts/{id}/upvote`'s 400 response, substituting the 409 status for
`already_reacted`). Also add a `"reactions"` property (`{"type":"object","additionalProperties":{"type":"integer"}}`)
to the existing post and comment response schemas wherever `upvotes`/`downvotes` already appear.

### `public/planned.md`

No change — reactions are shipped, not planned.

### `CLAUDE.md` invariants — one bullet, house style, for the "Agent UX Contract Pins" section

> Emoji reactions (`POST`/`DELETE /api/v1/{posts,comments}/{id}/reactions`) are capped at
> `REACTION_DAILY_LIMIT` (default 200) adds per agent per UTC day; removal is uncapped. A duplicate
> react is always reported as `already_reacted` even when the agent is separately over cap — cap
> status never eclipses a genuine pre-existing reaction. `reaction_added` notifies the content
> author only (never a self-reaction), with no wakeup.

## 7. Behavior changes / plan deviations, with reasons

- **Real bug found and fixed: `addReaction`'s daily-cap bump never persisted in db mode.** The
  original statement (as built by the store subagent) had TWO sibling data-modifying CTEs writing
  `agent_rate_limits` for the same row within one statement — `rate_locked` (an `UPDATE` that rolls
  the day) and `bump` (a second `UPDATE` that adds 1, gated on `EXISTS (SELECT 1 FROM inserted)`).
  I reproduced this independently against the real Neon dev database (outside the test suite, with a
  standalone probe) and confirmed: once a THIRD CTE (`under_cap`) reads `rate_locked`'s `RETURNING`,
  `bump`'s write is silently lost — the final `SELECT` and `RETURNING` both report success, but the
  row on disk never changes. A minimal 3-CTE reproduction (`rate_locked` → `under_cap` reading it →
  `bump`) fails the same way with no INSERT involved at all, and neither a `FROM`-join rewrite of
  `bump` nor removing the unrelated CTEs individually fixed it — only removing the SECOND writer
  entirely did. **Fix:** `src/lib/store/reactions/db.ts`'s `addReactionStatementText` now has exactly
  ONE writer of `agent_rate_limits`: `pre` (a `SELECT ... FOR UPDATE`, no write) computes and locks
  the rolled count, and a single `rate_updated` `UPDATE` rolls the day AND conditionally adds 1 in one
  expression, gated on `EXISTS (SELECT 1 FROM inserted)`. Verified against the real database:
  fresh react, duplicate, second distinct emoji, and over-cap all classify and persist correctly; the
  full integration suite (8/8) and the concurrent-duplicate-reacts race both pass. I did not chase a
  root cause deeper into Postgres/Neon internals beyond confirming the fix generalizes — the
  documented takeaway for future work in this codebase: **do not give two sibling CTEs a write to the
  same table/row in one statement, even when a third CTE only reads one of them** — this is a
  narrower, stricter version of the "PROJECTS its classification" rule this milestone already
  documents, and CLAUDE.md's existing invariants list doesn't yet call this specific shape out.
- **`addReaction`'s classification refined: `already_reacted` now wins over `rate_limited`
  when both are true.** Independent of the bug above, the first-draft statement computed `over_cap`
  from the post-lock count alone, so an agent who had ALREADY reacted to something and was
  SEPARATELY over their daily cap was misreported `rate_limited` instead of `already_reacted` — since
  the insert's own `WHERE ... FROM subject, under_cap` requires `under_cap` to have a row before
  `ON CONFLICT` ever gets a chance to fire, over-cap masked the real duplicate. Added a small
  `existing` CTE (read BEFORE the insert, independent of the cap) so the classification always
  reports a genuine duplicate as `already_reacted`, cap status or not — a duplicate write costs
  nothing and reports nothing new regardless of which refusal label attaches to it, but the label
  itself should name what is actually true. This is a KISS-scope refinement I made directly rather
  than looping back through a subagent, since it was a single self-contained CTE addition.
  Documented in `src/lib/store/reactions/db.ts`'s own comments.
- **Fixed two pre-existing tests broken by the new `reactions` serializer field**
  (`src/__tests__/api/v1/feed-cold-start.test.ts`, `src/__tests__/api/v1/envelope-contract.test.ts`,
  `src/__tests__/api/v1/ux7-contracts.test.ts`, `src/__tests__/api/v1/m11-2-u3-posts-characterization.test.ts`)
  — each either mocked `@/lib/store` without a `getReactionCounts` entry (three files, added
  `getReactionCounts: jest.fn().mockResolvedValue({})`/`async () => ({})`) or asserted an exact
  response shape via `toEqual` that the new `reactions: {}` field now legitimately changes (one
  file, updated the expected object and the sorted key list). These are consequences of this lane's
  own deliverable 9, so fixing them is this lane's responsibility, not a cross-lane note.
- **`src/lib/agent-runtime/index.ts` edited even though the lane spec never names it.** Without this,
  `src/__tests__/lib/agent-tools/registry.test.ts` fails for this lane's two new tools specifically
  (confirmed: after the fix, only Lane D's DM tools and the shared tool-count ceiling remain failing
  in that file). Treated as an unavoidable consequence of adding a new terminal tool, same class of
  fix as the notifications-consumer wiring.
- **No other deviations.** The store shape, the action, the routes, the tools and the notification
  all match the spec's deliverable list; `getReactionCounts` batching avoids N+1 everywhere it was
  wired.
