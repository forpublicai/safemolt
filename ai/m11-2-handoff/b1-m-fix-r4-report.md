# b1 Lane M — codex round-4 fix report (mentions / presence / hot)

All four findings from `ai/m11-2-handoff/codex-findings-b1-m-round4.md` closed. Round-1 F2
deferral (`wakeup-router.ts:254`) stays untouched, per the upheld verdict (upheld a fourth time
in this round's findings doc).

This report picks up from a stranded prior agent: its code and tests for F1-F4 were already on
disk. This pass verified the disk state, found and fixed one real defect the stranded agent's
own doc comment described but never implemented (F1's dead-comment gate), then ran every gate
and mutation check.

## Deliverables

1. **F1** (`notifications/db.ts`, `notifications/memory.ts`) — a mention notification sourced
   from a comment now requires the comment to still exist and still point at the given post.
   - `src/lib/store/notifications/db.ts`: `MENTION_NOTIFICATION_SELECT` locks the post `FOR SHARE`,
     then the source comment (if `$6` is non-null) `FOR SHARE` re-verifying `post_id = $5`, then
     the recipient. **Bug found and fixed**: the doc comment on disk already claimed a
     `JOIN`/`ON ($6 IS NULL OR c.id IS NOT NULL)` gate, but the query only had
     `LEFT JOIN (...) c ON true` — no predicate anywhere enforced it, so a withdrawn comment
     author's dead-link notification was still created. Added
     `WHERE $6::text IS NULL OR c.id IS NOT NULL` to the query. Confirmed by the integration test
     failing before the fix and passing after (see Mutation-check evidence).
   - `src/lib/store/notifications/memory.ts`: `mentionCommentSourceLive` re-checks the comment
     map by id and post; `buildMentionNotification` calls it after the post-liveness check.
   - Tests: two new cases in `m11-2-b1-mentions.test.ts` (real Postgres: gone comment refuses,
     live comment control) and three new cases in `mention-notification-liveness.test.ts`
     (memory: gone comment, mismatched post, live control).

2. **F2** (`notifications/db.ts`) — the recipient lock is `FOR SHARE`, not `FOR KEY SHARE`, so a
   concurrent metadata update (which takes `FOR NO KEY UPDATE`) cannot commit invisibly underneath
   the writer.
   - Test: new case in `m11-2-b1-mentions.test.ts` using `raceAgainstHeldLock` — holds a metadata
     update open, starts the writer, commits the update, asserts the writer blocked and then
     refused.

3. **F3** (`agents/db.ts`, `notifications/db.ts`) — the hidden-agent predicate compares
   `metadata->'system'`/`'test'` as JSON booleans (`= 'true'::jsonb`), not text, so a string
   `"true"` metadata value (visible per `isPubliclyHiddenAgent` in JS) is no longer wrongly
   excluded in SQL.
   - `src/lib/store/agents/db.ts`: `HIDDEN_AGENT_PREDICATE` uses `->` (JSONB) for `system`/`test`,
     keeps `->>` (text) for `source` (a string comparison in JS too).
   - `src/lib/store/notifications/db.ts`: the mention writer's recipient-visibility check uses the
     same JSON-boolean comparison.
   - Test: new case in `m11-2-b1-presence.test.ts` covering boolean `true` (excluded), string
     `"true"` (included), absent (included), JSON `null` (included).

4. **F4** (`agents/db.ts`) — `listAgents` now builds `HIDDEN_AGENT_PREDICATE` once as a module
   constant and interpolates it into all three `active_now` branches via the parameterized
   `sql!(text, params)` form, replacing three copy-pasted `NOT (...)` fragments built from
   `${}`-bound tagged-template values. The repair-history comment (six-template claim) is gone;
   the doc comment now names only the round-2/round-3 fixes still relevant to behavior.

## Gate results

- `npx tsc --noEmit`: 0 errors (run twice — once mid-mutation-check with F3 reverted are the
  `.ts` types unaffected by the SQL-string change, and once on the final restored state).
- `npx eslint src/lib/store/agents/db.ts src/lib/store/notifications/db.ts
  src/lib/store/notifications/memory.ts src/__tests__/integration/m11-2-b1-mentions.test.ts
  src/__tests__/integration/m11-2-b1-presence.test.ts
  src/__tests__/lib/store/mention-notification-liveness.test.ts --max-warnings=0`: 0 errors, 2
  pre-existing warnings in functions this lane did not touch: `completeVetting`
  (agents/db.ts:1191, complexity 16) and `buildCommentNotification`
  (notifications/memory.ts:166, complexity 16) — both flagged identically in the round-3 report.
- `npm test -- src/__tests__/lib/mentions.test.ts src/__tests__/lib/events
  src/__tests__/api/v1/agents-presence.test.ts src/__tests__/lib/store src/__tests__/lib/actions
  src/__tests__/lib/agent-public.test.ts --runInBand`: 68 suites / 760 tests, all passing (two
  confirming runs, before and after the mutation checks).
- `npm run test:integration -- src/__tests__/integration/m11-2-b1-mentions.test.ts`: 15/15 passing
  (after the F1 db fix; failed 14/15 before it — see below).
- `npm run test:integration -- src/__tests__/integration/m11-2-b1-presence.test.ts`: 2/2 passing.
- `npm run test:integration -- src/__tests__/integration/m11-2-b1-mentions.test.ts
  src/__tests__/integration/m11-2-b1-presence.test.ts` (both paths together, final confirmation):
  17/17 passing — see tail below.

```
PASS src/__tests__/integration/m11-2-b1-presence.test.ts
  listAgents(sort, "active_now", limit) — codex round 3 F1
    ✓ returns a visible active agent behind more hidden active agents than the limit
  listAgents(sort, "active_now", limit) — codex round 4 F3
    ✓ excludes a JSON boolean true but not a string "true", absent, or JSON null metadata

PASS src/__tests__/integration/m11-2-b1-mentions.test.ts
  createPost — the derived agent.mentioned event (4 passed)
  createComment — the derived agent.mentioned event (4 passed)
  createMentionNotificationIdempotent (db) — codex round 1 F1 (3 passed)
  createMentionNotificationIdempotent (db) — codex round 3 F2 (1 passed)
  createMentionNotificationIdempotent (db) — codex round 4 F1 (2 passed)
  createMentionNotificationIdempotent (db) — codex round 4 F2 (1 passed)

Test Suites: 2 passed, 2 total
Tests:       17 passed, 17 total
```

## Mutation-check evidence (verbatim)

**F1 (db)** — this WAS the real bug found this round. Original disk state had the doc comment
claiming a gate that did not exist in the SQL:
```
FAIL src/__tests__/integration/m11-2-b1-mentions.test.ts
  createMentionNotificationIdempotent (db) — codex round 4 F1
    ✕ creates nothing when the source comment is gone though its post is live (947 ms)
    expect(received).toBeNull()
    Received: {"...", "href": ".../comment-b1m_comment_..._60", "metadata": {"comment_id": "b1m_comment_..._60", ...}}
```
Fix applied: added `WHERE $6::text IS NULL OR c.id IS NOT NULL` to `MENTION_NOTIFICATION_SELECT`.
Re-run: `PASS ... createMentionNotificationIdempotent (db) — codex round 4 F1 ✓ creates nothing
when the source comment is gone though its post is live (1109 ms)`. 15/15 passing.

**F1 (memory)** — suppressed `mentionCommentSourceLive` call in `buildMentionNotification`:
```
FAIL src/__tests__/lib/store/mention-notification-liveness.test.ts
  ✕ codex round 4 F1: creates nothing when the source comment is gone (author withdrew)
  ✕ codex round 4 F1: creates nothing when the comment points at a different post
  Received: {"...", "href": "/post/post4#comment-gone-comment", ...}
```
Restored the call. Re-run: `PASS ... 7/7 passing`.

**F2 (db)** — changed the recipient lock from `FOR SHARE` back to `FOR KEY SHARE`:
```
FAIL ... createMentionNotificationIdempotent (db) — codex round 4 F2
  ✕ blocks on an uncommitted recipient metadata update, then refuses once it commits
  expect(received).toBe(expected)
  Expected: true
  Received: false   // race.observedBlocked
```
Restored `FOR SHARE`. Re-run: `PASS ... ✓ blocks ... (2079 ms)`. 1/1 (targeted `-t`).

**F3 (db)** — changed `HIDDEN_AGENT_PREDICATE` back to text comparison
(`(metadata->>'system') IS NOT DISTINCT FROM 'true'`, etc.):
```
FAIL ... listAgents(sort, "active_now", limit) — codex round 4 F3
  ✕ excludes a JSON boolean true but not a string "true", absent, or JSON null metadata
  expect(received).toContain(expected)
  Expected value: "b1p_string-true_..."
  Received array: ["b1p_json-null_...", "b1p_absent_..."]   // string-true wrongly excluded
```
Restored the JSON-boolean predicate. Re-run: `PASS ... 2/2 passing`.

**F4**: pure dedup/refactor, no independent behavioral test — covered by F1/F3's `active_now`
integration cases (all three sort branches exercised via the full jest+integration runs above)
passing unchanged before and after.

## Shared-file edits

None. All edits were confined to lane-M's own files
(`src/lib/store/agents/db.ts`, `src/lib/store/notifications/{db,memory}.ts`, and their tests).
No entries added to any shared-file table in `b1-common-rules.md`.

## Out-of-fence needs and cross-lane notes

None observed. `git status` showed no unexpected files from other lanes touching this fence
during this session.

## Docs delta

None. This round fixed drain-time consistency and a hidden-agent predicate bug; no new
agent-visible API surface, request/response shape, or behavior change from the agent's point of
view (a mention notification for a dead comment or a wrongly-hidden agent was already meant to
not exist/not be hidden — this closes gaps, not new features).

## Behavior changes or plan deviations

One real behavior change beyond the spec's literal text: the F1 fix required adding a `WHERE`
clause that the stranded prior agent's own doc comment already described intending to add but
never wrote into the query. This is not a deviation from the spec — it is completing F1 as
specified. No other deviations.
