# b1 Lane R — fix round 2 report (reactions)

All nine items from `codex-findings-b1-r-round2.md` implemented, including items 8-9 (the two
overturned serializer deferrals).

## 1. Deliverables

| # | Finding | State | Files |
|---|---|---|---|
| 1 | F1 — quota locks deadlock with withdrawal | **Done** | `src/lib/store/reactions/db.ts` |
| 2 | F2 — no real overlaps for notification writer / rollback | **Done** | `src/__tests__/integration/m11-2-b1-reactions.test.ts` |
| 3 | F5/F6 test deferral overturned | **Done** | `src/__tests__/integration/m11-2-b1-reactions.test.ts` |
| 4 | F4 — memory skips event validation on refusals | **Done** | `src/lib/store/reactions/memory.ts` |
| 5 | F5 — object-valued emoji still throws | **Done**, both routes | `src/app/api/v1/posts/[id]/reactions/route.ts`, `src/app/api/v1/comments/[id]/reactions/route.ts` |
| 6 | F6 — serializer gate lacks a nonempty read test | **Done** | `src/__tests__/api/reactions-routes.test.ts` |
| 7 | F7 — comment exceeds size limit | **Done** | `src/lib/store/notifications/db.ts` |
| 8 | Context serializer (deferral overturned) | **Done** | `src/lib/agent-senses/feed.ts`, `src/lib/agent-senses/types.ts`, `src/app/api/v1/agents/me/context/serialize.ts` |
| 9 | News discussions (deferral overturned) | **Done** | `src/app/api/v1/news/route.ts` |

### Code changes, by file

- **`src/lib/store/reactions/db.ts`**
  - `addReactionStatementText`'s `pre` CTE: lock mode `FOR UPDATE` → `FOR NO KEY UPDATE`. `FOR
    UPDATE` conflicts with the `FOR KEY SHARE` a withdrawal's own FK-restrict check takes on this
    row (`agent_rate_limits.agent_id REFERENCES agents(id)`, no cascade); `FOR NO KEY UPDATE` does
    not. Added a race marker (`/* race:b1r-pre-lock */`) for testability.
  - `addReaction`'s seed statement: `ON CONFLICT (agent_id) DO UPDATE SET agent_id = EXCLUDED.agent_id`
    → `SET reaction_count = agent_rate_limits.reaction_count`. Writing back the row's own PK column
    forces Postgres's strongest (FOR UPDATE-equivalent) tuple lock regardless of any explicit mode
    elsewhere in the transaction; a non-key no-op update takes the weaker NO KEY UPDATE lock. Added
    `/* race:b1r-seed-lock */`.
- **`src/lib/store/reactions/memory.ts`** — `addReaction`/`removeReaction`: `prepareEventBatch(events)`
  moved to the top of each function, before the subject/duplicate/cap/actor refusals (F4). No
  `await` sits between it and the refusal reads on any path, so Decision 4 is unaffected; batch
  uniqueness is still checked before the write, just earlier than before.
- **`src/lib/store/notifications/db.ts`** — `reactionNotificationSelectSql`'s docblock trimmed to
  the lock order and the cleanup anchor (F7), 4 lines instead of 10.
- **`src/app/api/v1/posts/[id]/reactions/route.ts`**, **`.../comments/[id]/reactions/route.ts`** —
  new `readEmoji(body)` helper: returns a string only when `body.emoji` is actually a string, `null`
  for anything else (missing, JSON `null` body, a non-string value). Both `POST`/`DELETE` refuse
  with 400 on `null` (F5), replacing the bare `String((body as {emoji?:unknown}).emoji ?? "")` that
  threw on an object.
- **`src/lib/agent-senses/types.ts`** — `PostWithThread` gained `reactions: Record<string, number>`.
- **`src/lib/agent-senses/feed.ts`** — new `reactionCountsFor(posts)`: one batched `getReactionCounts`
  call per gathered page (or per focused post), spliced into `enrichPost`'s new `reactions` param.
  `gatherFeed` and `gatherThread` both call it once, not once per post (item 8).
- **`src/app/api/v1/agents/me/context/serialize.ts`** — `serializeFeedItem` emits `reactions: item.reactions`
  verbatim; the serializer stays pure, no store calls.
- **`src/app/api/v1/news/route.ts`** — one batched `getReactionCounts("post", allDiscussionPostIds)`
  per request, spliced into each `existing_discussions` entry (item 9). The RSS cache itself is
  untouched.

## 2. Gate results

```
$ npx tsc --noEmit
(no output for any file in this fence; the only pre-existing error is
 src/lib/webhooks/deliver.ts:327 'afterMs' unused — lane W's file, unrelated)

$ npx eslint <all fence files + their tests> --max-warnings=0
(no output — clean)

$ npm test -- src/__tests__/lib/store/reactions-memory.test.ts src/__tests__/api/reactions-routes.test.ts \
    src/__tests__/lib/events src/__tests__/lib/agent-senses src/__tests__/api/v1/agents-me-context.test.ts \
    src/__tests__/lib/karma-writer-ownership.test.ts

Test Suites: 20 passed, 20 total
Tests:       285 passed, 285 total
```

```
$ npm run test:integration -- src/__tests__/integration/m11-2-b1-reactions.test.ts

PASS src/__tests__/integration/m11-2-b1-reactions.test.ts (70.159 s)
  post reactions vs deletePost — both orderings
    ✓ delete-first (real overlapping transaction): addReaction blocks on the tombstone, then is not_found
    ✓ delete-first (real overlapping transaction): removeReaction against a live row blocks on the tombstone, then is not_found and leaves the row untouched
    ✓ reaction-first: the reaction succeeds, its drained notification exists, and the subsequent delete removes both in the same transaction
    ✓ F2: the reaction notification writer itself blocks on a held tombstone, then refuses
    ✓ F2: a tombstone failure after the reaction cleanup element ran rolls back the whole delete, including the cleanup
  comment reactions vs deletePost — both orderings (same 5, all ✓)
  concurrent duplicate reacts
    ✓ N racing adds ... leave one row, one event, one quota increment
    ✓ F5/F6: two identical requests contending on a HELD seed row never answer rate_limited
    ✓ F6: a decisive-statement failure rolls back the seed, in the same transaction
  F1: the seed's rate-row lock does not deadlock with a withdrawal's FK check
    ✓ does NOT block a concurrent FOR KEY SHARE — the mode a withdrawal's own RI check takes
  F4: db validates events before any statement (parity with memory)
    ✓ addReaction throws on an invalid event even against a missing subject
  delayed-consume, rate limit through both surfaces, deletePost's reaction cleanup (all ✓, unchanged)

Test Suites: 1 passed, 1 total
Tests:       18 passed, 18 total
```
Ran solo the first time (advisory lock uncontended); re-ran twice more after mutation-check restores
with identical results.

Also ran (parity/serializer surfaces touched): `npm test -- src/__tests__/lib/agent-loop-prompt.test.ts`
— passes with the fixture's new `reactions: {}` field.

## 3. Mutation-check evidence, verbatim

**F1 (`pre`'s lock mode).** Flipped `FOR NO KEY UPDATE` back to `FOR UPDATE` in `pre`, kept the
seed's non-key no-op and the new `/* race:b1r-pre-lock */` marker. Re-ran the new F1 test solo:
```
● F1: the seed's rate-row lock does not deadlock with a withdrawal's FK check › does NOT block ...
  expect(received).toBe(expected)
  Expected: false
  Received: true
```
Restored `FOR NO KEY UPDATE` — green again (`observedBlocked: false`, `race.result.ok: true`).

**F2 (notification writer's own lock).** Weakened `reactionNotificationSelectSql`'s post-case
`live_post` CTE from `FOR SHARE` to `FOR KEY SHARE` (both branches). Re-ran the new "F2: the
reaction notification writer itself blocks..." test for both surfaces — both failed:
```
● post reactions vs deletePost ... › F2: the reaction notification writer itself blocks ...
  expect(received).toBe(expected)
  Expected: true
  Received: false
● comment reactions vs deletePost ... › (same failure)
```
Restored `FOR SHARE` — both green again.

**F4 (memory validation order).** Moved `prepareEventBatch(events)` back below all the refusal
checks in both `addReaction` and `removeReaction` (the pre-round-2 shape). Re-ran the new "F4:
memory validates events before any refusal" tests:
```
● F4 ... › addReaction throws on an invalid event even against a missing subject ...
  Received promise resolved instead of rejected
  Resolved to value: {"counts": {}, "outcome": "not_found"}
● F4 ... › removeReaction throws on an invalid event even against a missing subject ...
  (same failure)
```
Restored the preflight-first order — both green again.

**F5 (emoji type guard).** Reverted `readEmoji` to `return String(emoji ?? "")` (no `typeof`
check) in both route files. Re-ran the new "object-valued emoji" tests — all 4 (post × {POST,
DELETE}, comment × {POST, DELETE}) failed with the forbidden state itself:
```
TypeError: Cannot convert object to primitive value
  at String (src/app/api/v1/.../route.ts:19:10)
```
Restored the `typeof emoji === "string"` guard in both files — all 4 green again.

**F6 / item 8 / item 9 (serializer read paths), one mutation each:**
- `src/app/api/v1/posts/[id]/route.ts`: `reactions: reactionCountsMap[post.id] ?? {}` → `reactions: {}`.
  The new "F6: the reactions serializer..." test failed: expected `{"👍": 2}`, received `{}`.
  Restored — green.
- `src/lib/agent-senses/feed.ts`: `enrichPost`'s return → hardcoded `reactions: {}`. The new
  "attaches reactions from one batched read" test failed the same way. Restored — green.
- `src/app/api/v1/agents/me/context/serialize.ts`: `reactions: item.reactions` → `reactions: {}`.
  The new assertion in "serializes every section in snake_case" (`agents-me-context.test.ts`)
  failed the same way. Restored — green.
- `src/app/api/v1/news/route.ts`: `reactions: reactionCounts[discussion.postId] ?? {}` →
  `reactions: {}`. The new "item 9" test in `news.test.ts` failed the same way. Restored — green.

**F6/F5 (the transactional shape underlying the held-row and rollback tests).** Reverted
`addReaction` from one `sql.transaction` batch back to two separately auto-committed calls
(the pre-round-1 shape). Re-ran both tests:
```
✓ F5/F6: two identical requests contending on a HELD seed row never answer rate_limited ...
✕ F6: a decisive-statement failure rolls back the seed, in the same transaction
  expect(received).toEqual(expected)
  - Expected  - 1        (empty array)
  + Received  + 5        ([{ "?column?": 1 }])   <- the seed row SURVIVED the later failure
```
This confirms the held-row race alone does not discriminate the transactional shape (both shapes
resolve correctly under simple contention, matching round 1's own finding), but the rollback test
does — exactly the gap codex's finding 3 named. Restored the one-transaction shape — both green.

**Not separately mutated:** the "F2: a tombstone failure ... rolls back the whole delete, including
the cleanup" test. Its discrimination is structural rather than needing a source revert: `deletePost`
already binds the reaction-cleanup element and the tombstone element into one `sql.transaction`
array (unchanged by this round), and the test forces a genuine `22003` in the LAST element via
`memoryIngestFanoutCap` (mocked past its own documented clamp) after the cleanup element has already
run. Were those two elements ever split into separate auto-committed statements, this test would
fail today without any further edit, because the cleanup's effect would already be committed before
the later failure — the same shape the F6-rollback mutation above demonstrates for the seed. Did not
mutate `src/lib/store/posts/db.ts` itself (shared, heavily invariant-pinned file, out of this lane's
fence) to avoid destabilizing its ~15 other test suites.

## 4. Shared-file edits (collision protocol)

- `src/lib/store/notifications/db.ts` — touched only `reactionNotificationSelectSql`'s docblock
  (F7 comment shrink). Re-read immediately before editing; confirmed lane M's own edit elsewhere in
  the file (a new `/* race:b1m-mention-post-lock */` marker on `MENTION_NOTIFICATION_SELECT`)
  landed at a different anchor with no collision.
- `src/lib/agent-senses/feed.ts`, `src/lib/agent-senses/types.ts` — touched only the `reactions`
  field/attachment, per the fence.
- No edits to `src/lib/agent-senses/inbox.ts` (lane D's file in the same directory).
- No new store exports were added; `getReactionCounts` (already exported and classified) is the
  only store function newly consumed by `feed.ts` and `news/route.ts`.

## 5. Out-of-fence needs and cross-lane notes

- None identified beyond the shared-file edits above.

## 6. Docs delta

No agent-visible request/response shape changed except that three READ surfaces now carry live,
non-empty `reactions` counts where they previously could only ever show `{}` in practice (the field
existed from an earlier wave but was never populated): `GET /api/v1/agents/me/context`'s `feed`
items, and `GET /api/v1/news`'s `existing_discussions` entries. Suggested `public/reference.md`
addition (docs agent to apply verbatim):

> `GET /api/v1/agents/me/context`'s `feed.items[].reactions` and `GET /api/v1/news`'s
> `existing_discussions[].reactions` report live emoji-reaction counts (`{emoji: count}`), matching
> the shape already published on posts and comments.

No `CLAUDE.md`/`agents.md` invariant addition — the lock-mode facts here are corollaries of the
already-documented "`FOR KEY SHARE` is not a delete-liveness gate" family, not a new invariant.

## 7. Behavior changes or plan deviations

- **`addReaction`'s daily-cap seed no longer takes the strongest possible row lock.** Previously
  (round 1) the seed's `ON CONFLICT DO UPDATE SET agent_id = EXCLUDED.agent_id` forced a FOR
  UPDATE-equivalent lock by writing back the row's own key column; it now writes `reaction_count`
  (a non-key no-op), taking only `FOR NO KEY UPDATE`. Combined with `pre`'s mode change, this closes
  a real `40P01` deadlock between a reaction and a concurrent withdrawal of the same agent — a
  genuine correctness fix, not a refactor.
- **`readEmoji` refuses a JSON `null` body and a non-string `emoji` with the same 400** (`"Invalid
  emoji"`), where round 1 answered `"Invalid JSON"` for the null-body case specifically. No test
  in either fixed or new suites asserts the exact error string, only the status code.
- All other items implement the spec's stated remedy directly; no other deviations.
