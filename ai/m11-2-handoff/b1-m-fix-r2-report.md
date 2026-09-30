# b1 Lane M — codex round-2 fix report (mentions / presence / hot)

All six findings from `ai/m11-2-handoff/codex-findings-b1-m-round2.md` closed. F2 from round 1
stays deferred (untouched), per the spec and the upheld verdict.

## Deliverables

1. **F1** — the `active_now` predicate now runs INSIDE the query before `LIMIT 500`.
   - `src/lib/store/agents/db.ts` `listAgents`: gained an optional `filter?: "active_now"` param.
     Six literal query branches (sort x filter), each applying
     `WHERE last_active_at > NOW() - make_interval(secs => ...)` (from `ACTIVE_NOW_THRESHOLD_MS`)
     before `LIMIT 500`, since the neon tag binds every `${}` as a parameter and a raw WHERE
     fragment cannot be composed in.
   - `src/lib/store/agents/memory.ts` `listAgents`: same `filter` param, applying the
     `presenceBucket(...) === "active_now"` predicate before any other narrowing (no cap exists
     there today, but the order now matches the db twin).
   - `src/app/api/v1/agents/route.ts`: passes `filter === "active_now" ? "active_now" : undefined`
     into `listAgents`; `visibleAgents` still does hidden-agent exclusion (unchanged) — this is
     idempotent against an already-narrowed list.
   - Test: `src/__tests__/lib/store/agents/list-agents-active-now.test.ts` (memory mode, per the
     spec's own "memory mode is enough if the db and memory reads share the predicate order").
     501 dormant agents + 1 active agent seeded directly into `_memory-state`'s `agents` map; the
     active agent is returned. I did not add a real 501-row DB integration test: it would pollute
     the shared reserved integration database used by all four concurrent lanes, and the db/memory
     SQL and JS predicate orders are now structurally identical (verified by reading both).

2. **F2** — rollback proof added to `src/__tests__/integration/m11-2-b1-mentions.test.ts`, one test
   per source type ("a failing derived event insert leaves no post/comment, no quota change, and
   no primary event"). Both events in the batch share one `idemKey`, which collides on
   `idx_events_idem` during statement execution (a real 23505, not a preflight refusal — no JS
   preflight in the db path checks idemKey uniqueness). Asserts the call rejects and that no
   post/comment row, no `agent_rate_limits` row, and no event survive. No production code change;
   this closes a test-coverage gap only.

3. **F3** — lock proof added: `createMentionNotificationIdempotent (db) — codex round 1 F1` gained
   "blocks on an uncommitted tombstone update, then refuses once it commits", using
   `raceAgainstHeldLock` (holds `UPDATE posts SET deleted_at = NOW()` open on a `pg` connection,
   races the writer via the Neon HTTP driver). Added a `/* race:b1m-mention-post-lock */` marker
   comment to `MENTION_NOTIFICATION_SELECT`'s post subquery in
   `src/lib/store/notifications/db.ts` (mention writer only) so the race helper can identify the
   waiting backend.

4. **F4** — removed id-order assumptions in `m11-2-b1-mentions.test.ts`. Added `findEvent(events,
   kind, subjectId)`, which locates an event by kind + subject rather than array position. Replaced
   `const [primary, derived] = emitted` and `const [, derived] = ...` in all four affected tests
   (both post and comment source cases) with `findEvent` lookups plus an explicit
   `expect(emitted).toHaveLength(2)`.

5. **F5** — `src/__tests__/lib/presence-writer.test.ts`: `SQL_WRITE` regex widened from
   `/\bSET\s+last_active_at\s*=/gi` to `/(?:\bSET\s+|,\s*)last_active_at\s*=/gi`, so a
   `last_active_at` assignment after a comma (a later column in a multi-column `SET`) is now
   detected. Added the exact fixture from the finding ("fails when last_active_at is a later
   column in a multi-column SET clause").

6. **F6** — trimmed `resolveMentionRecipients`'s doc comment in `src/lib/mentions.ts` from 9 lines
   to 4, keeping creation-time resolution and the store-assigned marker, dropping the F8 repair
   history.

## Gate results

- `npx tsc --noEmit`: no errors in any file this lane touched (verified by grepping the full
  output for this lane's file paths). The full run shows pre-existing `RecordWebhookAttemptInput`
  errors in `m11-2-b1-webhooks.test.ts`, `webhooks-memory.test.ts`, and `webhook-pass.ts` — all
  lane W's fence, mid-edit concurrently; none touch this lane's files.
- `npx eslint src/lib/store/agents/db.ts src/lib/store/agents/memory.ts
  src/app/api/v1/agents/route.ts src/lib/mentions.ts src/lib/store/notifications/db.ts
  src/__tests__/lib/presence-writer.test.ts src/__tests__/integration/m11-2-b1-mentions.test.ts
  src/__tests__/lib/store/agents/list-agents-active-now.test.ts --max-warnings=0`: 0 errors, 5
  pre-existing warnings, all in functions this lane did not touch: `completeVetting`
  (agents/db.ts:1172, complexity 16), `deleteAgent` (agents/memory.ts:378, complexity 13),
  `followAgent` (agents/memory.ts:483, complexity 14), `deleteEvaluationMemoryForAgent`
  (agents/memory.ts:884, complexity 15), `completeVetting` (agents/memory.ts:1068, complexity 18).
- `npm test -- src/__tests__/lib/mentions.test.ts src/__tests__/lib/events
  src/__tests__/lib/presence-writer.test.ts src/__tests__/api/v1/agents-presence.test.ts
  src/__tests__/lib/store src/__tests__/lib/actions --runInBand`: 68 suites, 740 tests. Ran clean
  (740/740) mid-session; a later re-run showed 3 failures confined to
  `src/__tests__/lib/store/webhooks-memory.test.ts`, all against `src/lib/store/webhooks/memory.ts`
  — lane W's fence, mid-edit concurrently (confirmed via `git status`: both files modified by that
  lane, neither touched by this one). Explicitly out of lane M's scope (webhooks files are on the
  do-not-touch list). All other 67 suites, including every lane-M file, passed both times.
- `npm run test:integration -- src/__tests__/integration/m11-2-b1-mentions.test.ts`: **11 tests,
  all passing** (final confirmation run after every mutation-check restore).

## Mutation-check evidence (verbatim)

**F1** (memory): gated the filter behind `if (false && filter === "active_now")`. Both new
boundary/cap tests failed:
```
listAgents(sort, "active_now") › returns an active agent even behind more than 500 dormant ones
  expect(result.map((a) => a.id)).toEqual([active.id])
  + 501 dormant ids present, "activemttcqdpq502" only one of 502
listAgents(sort, "active_now") › excludes an agent exactly at the threshold...
  Received: ["at-cutoffmttcqdpv503", "insidemttcqdpv504"]  (expected only the inside one)
```
Restored; all 3 tests green again.

**F2** (post + comment, each independently): changed the PRIMARY event's `idemKey` to
`` `${clashKey}-MUTATED-NO-CLASH` `` so the two events no longer collide. Both tests failed:
```
a failing derived event insert leaves no post, no quota change, and no primary event
  expect(received).rejects.toThrow()
  Received promise resolved instead of rejected
  Resolved to value: {"authorId": "b1m_agent_...", ..., "id": "post_1788913252813_4ywvj4c", ...}

a failing derived event insert leaves no comment, no quota change, and no primary event
  expect(received).rejects.toThrow()
  Received promise resolved instead of rejected
  Resolved to value: {"authorId": "b1m_agent_...", ..., "id": "comment_1788913301513_cjyultr", ...}
```
Restored (shared `clashKey` on both events); both tests green again, full 11-test file green.

**F3**: removed `FOR SHARE` from the mention writer's post subquery
(`src/lib/store/notifications/db.ts`). The new race test failed:
```
blocks on an uncommitted tombstone update, then refuses once it commits
  expect(race.observedBlocked).toBe(true)
  Expected: true
  Received: false
```
Restored `FOR SHARE`; test green again.

**F4**: reversed the `emitted` array (`.reverse()`) before the `findEvent` lookups in the "fills
the derived event's source_id from the same minted post id" test, simulating the derived event
landing at a lower id than the primary. The test still passed:
```
✓ the store fills the derived event's source_id from the same minted post id (1648 ms)
```
This is the intended proof (the fix must NOT depend on order); reverted the `.reverse()` afterward
to keep the test reading naturally against the query's actual `ORDER BY id`.

**F5**: reverted `SQL_WRITE` to the pre-fix `/\bSET\s+last_active_at\s*=/gi`. The new fixture test
failed:
```
fails when last_active_at is a later column in a multi-column SET clause
  expect(hits).toHaveLength(1)
  Expected length: 1
  Received length: 0
```
Restored the widened regex; test green again.

**F6**: comment-only change, no behavior to mutation-check.

## Shared-file edits

- `src/lib/store/agents/db.ts` / `memory.ts`: `listAgents` only (the allowed "agents-listing
  read"). No other function in either file touched.
- `src/lib/store/notifications/db.ts`: mention writer only (`MENTION_NOTIFICATION_SELECT`) — added
  one SQL comment marker, no other line touched. Re-read immediately before this edit and again
  before the mutation-check edit/restore, since another lane modified other parts of this file
  during the session; both edits landed cleanly on re-read with no collision.
- No edits to `src/lib/events/kinds.ts`, `coverage.ts`, `store-types.ts`, `notifications.ts`
  (planner switch), `wakeup-router.ts`, `store.ts`, `export-manifest.ts`, `migrate.js`,
  `migration-ledger.ts`, `agent-tools/index.ts`, or `actions/types.ts` — none needed.
- No new store exports added (existing `listAgents` export signature widened with an optional
  parameter, not renamed or newly added).

## Out-of-fence needs / cross-lane notes

- None. All six items were resolvable inside lane M's fence.
- `src/lib/store/notifications/db.ts` showed unrelated concurrent edits from another lane during
  this session (outside the mention writer); none touched or conflicted with this lane's lines.

## Docs delta

None of this round's items change any published API surface, request/response shape, or public
behavior description. F1 corrects an internal query defect against the already-published
`?filter=active_now` contract (no doc claims the old, broken behavior); F2–F5 are
correctness/test-coverage fixes with no externally visible contract change; F6 is a comment-only
cleanup. No changes proposed for `public/reference.md`, `public/skill.md`, `public/openapi.json`,
`public/planned.md`, or `CLAUDE.md`.

## Behavior changes or plan deviations

- `GET /api/v1/agents?filter=active_now` now returns correct results when more than 500 agents
  exist and the active ones are not among the first 500 by the requested sort — this is a bug fix,
  not a new behavior, matching the documented `active_now` presence-bucket semantics.
- No other behavior changes. No plan deviations.
