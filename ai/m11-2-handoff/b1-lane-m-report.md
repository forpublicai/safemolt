# b1 Lane M — P6.1 Mentions + P6.4 Presence + P6.5 Hot decay — report

All three deliverables complete, in sequence (P6.5 → P6.4 → P6.1) as required. Every subagent's
claims were independently re-verified by the manager (fresh `tsc`, `lint`, targeted `jest`, targeted
`test:integration`, and diff inspection of the actual edits) before being recorded here.

## 1. Deliverables

### P6.5 — Hot with decay + cold-start feed — DONE
- NEW `src/lib/store/hot-score.ts`: `hotScoreOrderBy(nowPlaceholder, colPrefix?)` (raw SQL ORDER BY
  fragment), `hotScore(post, nowMs)` (TS twin), `hotScoreComparator(nowMs)` (shared memory
  comparator with the `created_at DESC, id DESC` tie-break). Formula matches the plan verbatim.
- Applied at all four hot sites: `src/lib/store/posts/db.ts` (`listPosts` — group-scoped,
  school-scoped, global branches) and `src/lib/store/groups/db.ts` (`listFeed`), plus their memory
  twins `src/lib/store/posts/memory.ts` / `src/lib/store/groups/memory.ts`. `top`/`new` untouched.
  `deletePost` in `posts/db.ts` was NOT touched (Lane R's fence).
- `src/app/api/v1/feed/route.ts`: cold-start fallback to `listPosts` when `listFeed` is empty;
  `meta.feed_mode: "personalized" | "fallback"` on both response branches.
- Tests: `src/__tests__/lib/store/hot-score.test.ts` (unit + memory-store integration-style),
  `src/__tests__/api/v1/feed-cold-start.test.ts` (extended, not duplicated).

### P6.4 — Presence — DONE
- `presenceBucket(lastActiveAt, nowMs)` + `publicAgentSummary(agent, nowMs)` in
  `src/lib/agent-public.ts`. Buckets: `active_now` <10min, `today` <24h, `this_week` <7d, else
  `dormant`; null/undefined → `dormant`.
- NEW `src/app/api/v1/agents/route.ts`: `GET /api/v1/agents?filter=active_now&sort=`, hidden agents
  always excluded, no raw timestamp in the response.
- `AgentContext.network.activeNowCount` via new read `countActiveNowFollowees(agentId, thresholdMs)`
  (`src/lib/store/agents/{db,memory,index}.ts`), wired into `src/lib/agent-senses/network.ts`
  (`NetworkSummary.activeNowCount` added to `src/lib/agent-senses/types.ts` as a minimal fence
  extension — tightly coupled to `network.ts`, no other lane touches it).
- Single-writer discipline: `updateAgent`'s dead `lastActiveAt` field/branch DELETED (no live caller,
  confirmed by grep before deletion) from both `db.ts` and `memory.ts`. The two legitimate writers —
  `authenticateAndTouchByApiKey` and `touchAgentLastActiveAtIfStale` — kept in both stores.
  `src/__tests__/lib/presence-writer.test.ts` scans `src/lib`/`src/app` and allowlists exactly those
  two functions in those two files.
- Tests: `src/__tests__/lib/agent-public.test.ts`, `src/__tests__/api/v1/agents-presence.test.ts`,
  `src/__tests__/lib/presence-writer.test.ts`, plus mock updates to `agent-senses` tests for the new
  `NetworkSummary` field.
- Skipped (optional, out of literal fence, no conflict risk taken): adding `presence` to
  `src/app/api/v1/agents/profile/route.ts` — that route's pre-existing `last_active` raw-timestamp
  leak was left untouched either way.

### P6.1 — Mentions — DONE
- NEW `src/lib/mentions.ts`: `extractMentions(text)` — `@([a-zA-Z0-9_-]{2,64})`, lowercase, dedupe,
  cap 5, no code-block special-casing (documented).
- Registration: `registerAgent` (`src/lib/actions/agents.ts`) now refuses a name outside
  `AGENT_NAME_GRAMMAR` with `bad_request` before touching the store. `nameGrammarDeprecations` /
  `DeprecationNotice` deleted (no other live caller). `RegisterAgentResult.deprecations` kept as
  `never[]`, always `[]`. Existing P1.4 registration tests updated from
  "warns and still registers" to "refused with `bad_request`"
  (`src/__tests__/lib/actions/evaluations.test.ts`,
  `src/__tests__/api/v1/m11-2-u3e-evaluations-characterization.test.ts`).
- Resolution + events: `listAgentsByNamesCaseInsensitive(names)` (new read,
  `src/lib/store/agents/{db,memory,index}.ts`, `LOWER(name) = ANY(...)`, backed by the M11-1 C5
  index). `createPost`/`createComment` actions (`src/lib/actions/{posts,comments}.ts`) resolve
  mentions, drop self and `isPubliclyHiddenAgent`, cap 5, and append one derived
  `PreparedEvent<"agent.mentioned">` per recipient after the primary event.
- Store-side fill: `src/lib/store/posts/db.ts` (`createPost`) and `src/lib/store/comments/db.ts`
  (`createCommentWithOutcome`) extend their existing per-event `overrides` array — index 0 keeps
  filling the primary event's `subject_id`/`post_id`|`comment_id`; every index after it gets
  `payloadMergeSql: sqlPayloadObject({ source_id: sqlParam(1, "text") })`, reusing the SAME `$1`
  parameter the primary event's id already binds. No change to
  `src/lib/store/events/statement.ts` was needed — the existing per-event `overrides` mechanism
  already supports this. Memory twins mirror positionally in `posts/memory.ts` / `comments/memory.ts`.
- `kinds.ts`: `agent.mentioned` payload `{ source_type: 'post'|'comment'; source_id: string;
  mentioned_agent_id: string }` + `KIND_MEMBERSHIP` entry, under a `// ==== M11b lane-m ====` anchor.
- Coverage (`coverage.ts`): notifications `on`, wakeup-router `on`, activity-trail `none`,
  memory-ingest `none` — exactly per spec.
- `store-types.ts`: `NotificationType` gains `"mention"`.
- Notifications consumer (`src/lib/events/consumers/notifications.ts`): `planMentionNotification`,
  a `PlannedNotification` "mention" variant, `plan()`/`apply()` cases, dedup key
  `mention:{recipient}:{event_id}`. New idempotent store writer
  `createMentionNotificationIdempotent` added to `src/lib/store/notifications/{db,memory,index}.ts`
  — this was gated behind `ai/m11-2-handoff/b1-lane-w-wakeups-done.md`, which existed by the time
  this deliverable started, so the gate was open and the full write path is live (not deferred).
  Modeled directly on Lane W's freshly-landed `createWebhookDisabledNotificationIdempotent` pattern.
- Wakeup router (`src/lib/events/consumers/wakeup-router.ts`): `routeMentioned` — post-source always
  wakes (once the post is confirmed live); comment-source suppressed iff the mentioned agent is that
  comment's own reply/comment-on-my-post target, derived from the comment/post/parent ROWS (never
  from an existing wakeup row, per the plan's order-independence requirement). Reason string
  `"mention"`.
- `src/lib/agent-senses/inbox.ts`: `String(notification.type) === "mention"` →
  `notification.type === "mention"`.
- Tests: `src/__tests__/lib/mentions.test.ts` (extractor unit tests),
  `src/__tests__/lib/events/mentions-e2e.test.ts` (memory-mode e2e: post/comment mention → notif +
  wakeup, cap, self, hidden, case-insensitivity, suppression only on comment-source reply target),
  `src/__tests__/integration/m11-2-b1-mentions.test.ts` (real Postgres: `source_id` fill from the
  minted id, and atomicity — a refused post/comment writes neither the content nor the derived
  event).

## 2. Gate results (manager's own independent runs, not just subagent claims)

```
$ npx tsc --noEmit -p .
(clean — zero output, whole tree)

$ npm test -- src/__tests__/lib/store/hot-score.test.ts src/__tests__/api/v1/feed-cold-start.test.ts
Test Suites: 2 passed, 2 total / Tests: 14 passed, 14 total

$ npm test -- src/__tests__/lib/presence-writer.test.ts src/__tests__/lib/agent-public.test.ts \
    src/__tests__/api/v1/agents-presence.test.ts src/__tests__/lib/agent-senses/
Test Suites: 10 passed, 10 total / Tests: 82 passed, 82 total

$ npm test -- src/__tests__/lib/mentions.test.ts src/__tests__/lib/events/mentions-e2e.test.ts \
    src/__tests__/lib/actions/evaluations.test.ts \
    src/__tests__/api/v1/m11-2-u3e-evaluations-characterization.test.ts
Test Suites: 4 passed, 4 total / Tests: 127 passed, 127 total

$ npm test -- src/__tests__/lib/events src/__tests__/lib/actions
Test Suites: 2 failed, 18 passed, 20 total / Tests: 8 failed, 351 passed, 359 total
  — the 2 failing files (wakeup-router.test.ts, wakeup-round-open-composition.test.ts) have ZERO
    diff (confirmed via `git diff --stat`) — pre-existing failures from Lane W's concurrent
    `resolveWakeupDelivery` memory-mode behavior change (now loop-enabled-only; these older
    fixtures never set up `agent_loop_state`). None of the failing assertions concern
    `agent.mentioned`/mention. Not this lane's to fix.

$ npx eslint <every file this lane touched>
0 errors. 8 pre-existing complexity warnings, all on functions this lane did not modify
(`completeVetting`, `deleteAgent`, `followAgent`, `buildCommentNotification`, `listPosts` — the
`listPosts` warning (complexity 13) predates the hot-score change, confirmed against the pre-edit
version via `git show HEAD:... | eslint --stdin`).

$ npm run test:integration -- src/__tests__/integration/m11-2-b1-mentions.test.ts
PASS — 4/4:
  createPost — the derived agent.mentioned event
    ✓ the store fills the derived event's source_id from the same minted post id
    ✓ a refused post writes no post AND no derived mention event
  createComment — the derived agent.mentioned event
    ✓ the store fills the derived event's source_id from the same minted comment id
    ✓ a refused comment (cooldown) writes no comment AND no derived mention event

$ npm run gen:boundary
gen-eslint-boundary: wrote the generated block into .eslintrc.json

$ npm test -- src/__tests__/lib/boundary-generated-block.test.ts
Test Suites: 1 passed / Tests: 2 passed (drift test agrees with the freshly generated block)

$ npm test -- src/__tests__/lib/boundary-manifest-completeness.test.ts
1 failed, 2 passed — the failure names `createDmReceivedNotificationIdempotent`, a Lane D export,
NOT this lane's. See §5.
```

## 3. Mutation-check evidence (verbatim from subagents, spot-checked by the manager against the
   final diffs — the described mechanisms are present in the delivered code)

**P6.5 hot-score**: reverted `hotScore`'s body to plain `upvotes - downvotes` (no decay) → 5/9 tests
failed, including the negative/positive ordering assertion and the decay-value checks. Restored →
14/14 green.

**P6.4 single-writer scan**: reinjected `UPDATE agents SET last_active_at = NOW()` into `updateAgent`
(db.ts) → scan failed, reporting `db.ts:475 fn=updateAgent`. Reinjected
`next.lastActiveAt = new Date().toISOString()` into `updateAgent` (memory.ts) → scan failed,
reporting `memory.ts:456 fn=updateAgent`. Both reverted → 9/9 green.
**P6.4 presenceBucket**: changed `ACTIVE_NOW_THRESHOLD_MS` 10min→5min → 2 boundary tests failed.
Reverted → 8/8 green.

**P6.1 self-mention drop**: removed the `agent.id !== authorId` filter clause → e2e test observed a
real self-notification in the diff (`"type": "mention", "agent_id": "authorXXXX"`). Restored → 8/8
green.
**P6.1 suppression predicate**: short-circuited `if (suppressTarget === mentionedAgentId) return;` to
never fire → both suppression tests failed, each observing an unwanted `reason: "mention"` wakeup
row. Restored → 54/54 green (full e2e + coverage + substrate suites).

## 4. Shared-file edits (append-only, own anchor) + new store exports

| File | Anchor | Content |
|---|---|---|
| `src/lib/events/kinds.ts` | `// ==== M11b lane-m ====` | `agent.mentioned` payload type + `KIND_MEMBERSHIP` entry |
| `src/lib/store-types.ts` | end of `NotificationType` | `\| "mention"` |
| `src/lib/events/consumers/coverage.ts` | end of each of the 4 manifests | `agent.mentioned`: notifications `on`, activity-trail `none`, memory-ingest `none`, wakeup-router `on` |
| `src/lib/events/consumers/notifications.ts` | new section | `planMentionNotification`, `PlannedNotification` "mention" variant, `plan()`/`apply()` cases |
| `src/lib/events/consumers/wakeup-router.ts` | new section | `MENTION_REASON`, `commentMentionSuppressTarget`, `routeMentioned`, `apply()` case |
| `src/lib/store/notifications/{db,memory,index}.ts` | new section, mirrors `createWebhookDisabledNotificationIdempotent` | `MentionNotificationInput`, `createMentionNotificationIdempotent` |
| `src/lib/store/export-manifest.ts` | `MUTATING_STORE_EXPORTS` | `"createMentionNotificationIdempotent"` |
| `.eslintrc.json` | generated | regenerated via `npm run gen:boundary` at lane end |

**New store exports and classification:**
- `countActiveNowFollowees` (P6.4) — read (`count` is in `READ_EXPORT_PREFIXES`), no manifest entry.
- `listAgentsByNamesCaseInsensitive` (P6.1) — read (`list` prefix), no manifest entry.
- `createMentionNotificationIdempotent` (P6.1) — mutating, added to `MUTATING_STORE_EXPORTS`.
- `hotScoreOrderBy` / `hotScore` / `hotScoreComparator` (P6.5) — plain functions in
  `src/lib/store/hot-score.ts`, not re-exported through `store.ts` (consumed directly by the domain
  store files that need them; nothing outside the store layer has cause to call them).

Two structural test files needed matching entries (not originally in this lane's literal fence, but
the same append-only obligation `kinds.ts`/`coverage.ts` carry — every prior kind-adding lane had
already extended them the same way): `src/__tests__/lib/events-substrate.test.ts` and
`src/__tests__/lib/events/consumer-coverage.test.ts`, both gaining an `agent.mentioned` entry.

## 5. Out-of-fence needs and cross-lane notes

- **`boundary-manifest-completeness.test.ts` currently fails**, naming
  `createDmReceivedNotificationIdempotent` (Lane D's export, not this lane's) as unclassified in
  `export-manifest.ts`. This lane's own export (`createMentionNotificationIdempotent`) IS correctly
  classified — confirmed present in `MUTATING_STORE_EXPORTS`. Left for Lane D / the orchestrator to
  close; not touched here since it is not this lane's function and `notifications/db.ts` /
  `export-manifest.ts` are shared files other lanes also append to concurrently.
- Two pre-existing test failures in `src/__tests__/lib/events/{wakeup-router,wakeup-round-open-composition}.test.ts`
  (zero diff, confirmed) — Lane W's `resolveWakeupDelivery` memory-mode change needs those fixtures
  updated to set up `agent_loop_state`. Not this lane's fence.
- `src/app/api/v1/agents/profile/route.ts` still leaks a raw `last_active` timestamp in its public
  response — pre-existing behavior, out of this lane's literal fence, left untouched. Would be a
  natural follow-up to also surface `presence` there and consider dropping the raw field, but that is
  a product decision outside this lane's remit.

## 6. Docs delta (exact text; NOT applied — a docs agent applies at the wave boundary)

**`public/reference.md`** — new "Mentions" section (near Notifications):
> Mention another agent by name in a post or comment title/content with `@name` (case-insensitive,
> 2–64 chars, `[a-zA-Z0-9_-]`). Up to 5 unique mentions per item; self-mentions and hidden/test
> agents are silently skipped. A resolved mention creates a `type: "mention"` notification for the
> recipient and, for a loop-enabled or webhook-registered agent, a wakeup (`reason: "mention"`) —
> unless the mention is inside a comment addressed to the same agent who would already be notified
> as `comment_on_my_post`/`reply_to_my_comment` (the wakeup is suppressed there; the notification
> still lands). Mention resolution happens at post/comment creation time; a later rename does not
> retro-apply. `@Alice Bot` resolves `Alice` — the mention grammar stops at the space (documented
> limitation).

**`public/reference.md`** — Presence:
> Agents surface a coarse `presence` bucket — `active_now` (<10 min since last authenticated
> request), `today`, `this_week`, or `dormant` — on public agent summaries and via
> `GET /api/v1/agents?filter=active_now`. No raw timestamp is published. Hidden/test agents never
> appear.

**`public/reference.md`** — Hot sort / feed:
> `sort=hot` now applies signed decay: `score = (upvotes - downvotes + comment_count * 0.5)`,
> divided by `(age_hours + 2)^1.5` once positive, left undivided (and therefore un-decayed) when
> zero or negative, so stale heavily-downvoted posts never outrank fresh mildly-negative ones.
> `GET /api/v1/feed` now falls back to the global feed (`meta.feed_mode: "fallback"`) for an agent
> with no group memberships and no follows, instead of returning permanently empty.

**`heartbeat.md`** — "mentions now true" (flip the existing "promised, not implemented" note to
reflect P6.1 landing).

**`public/openapi.json`** — add `"mention"` to the notification `type` enum, alongside
`comment_on_my_post`, `reply_to_my_comment`, `new_follower`, `playground_round_open`; add
`presence` (`active_now|today|this_week|dormant`) to the public agent schema; add `filter` query
param (`active_now`) to `GET /api/v1/agents`; add `feed_mode` (`personalized|fallback`) to
`GET /api/v1/feed`'s `meta`.

**`CLAUDE.md`-style invariant (one bullet, for the "Store and Migration Invariants" section):**
> **A derived event's store-assigned field is filled by extending the SAME per-event `overrides`
> array the primary event already uses, never a parallel mechanism.** `createPost`/`createComment`
> append one `agent.mentioned` `PreparedEvent` per resolved mention recipient after the primary
> event; the store's `overrides[0]` keeps filling the primary's `subject_id`/minted-id payload key,
> and `overrides[1..]` fills only `payload.source_id` from the same `$1` — the derived event keeps
> its OWN subject (the mentioned agent, known to the action), and every arm is still gated on the
> one decisive CTE, so a refused post/comment writes neither the content nor any derived event.

## 7. Behavior changes / plan deviations

- **Recorded behavior change (per Decision 11's own rollout, expected)**: agent registration with a
  name outside `^[a-zA-Z0-9_-]{2,64}$` now REFUSES (`bad_request`) instead of succeeding with a
  deprecation notice. This is exactly the M11b enforcement half the plan calls for.
- No other deviations from the spec. `src/lib/store/events/statement.ts` needed no edit — the
  existing per-event `overrides` mechanism already supported the mention fan-out shape without
  modification, contrary to the spec's framing of it as something to "minimally extend."
- P6.4's `presenceBucket` was NOT wired into `src/app/api/v1/agents/profile/route.ts` (optional per
  spec, skipped to avoid touching a file outside the literal fence — see §5).
