# b1 Lane M — codex round-3 fix report (mentions / presence / hot)

All three findings from `ai/m11-2-handoff/codex-findings-b1-m-round3.md` closed. Round-1 F2
deferral (`wakeup-router.ts:254`) stays untouched, per the upheld verdict.

## Deliverables

1. **F1** (`agents/db.ts:509`) — hidden agents are now excluded INSIDE the `active_now` query,
   before `LIMIT`, not filtered afterward in the route.
   - `src/lib/agent-public.ts`: exported `TEST_NAME_PATTERN` (was module-private) so the SQL twin
     can reuse `.source` instead of a second hand-copied regex.
   - `src/lib/store/agents/db.ts` `listAgents`: added `AND NOT (...)` — the SQL twin of
     `isPubliclyHiddenAgent` (`metadata->>'system'`/`'test'`/`'source'` and the name regex) — to
     all three `active_now` query branches, before `LIMIT`. Also added an optional third `limit`
     parameter (default 500) purely so tests can exercise the truncation boundary without seeding
     500 rows.
   - `src/lib/store/agents/memory.ts` `listAgents`: added the matching `!isPubliclyHiddenAgent(a)`
     filter in the same `active_now` pass, plus the same optional `limit` parameter (a post-sort
     `.slice`, `undefined` by default — no cap exists there today, unchanged).
   - **NULL-handling bug found and fixed during testing**: the first draft used
     `(metadata->>'system') = 'true'` etc. For an agent with no `metadata` at all (`NULL`), that
     comparison is SQL `NULL`, and `NOT (NULL OR NULL OR NULL OR false)` is `NULL`, which a `WHERE`
     clause treats as false — so an ordinary agent with no metadata was wrongly excluded. Fixed by
     using `IS NOT DISTINCT FROM` instead of `=`, which does not propagate `NULL`.
   - Tests: `src/__tests__/integration/m11-2-b1-presence.test.ts` (new; real Postgres — 3 hidden
     active agents, RUN-suffixed, `LIMIT 3` via the new param, visible one still returned) and a
     new case in `src/__tests__/lib/store/agents/list-agents-active-now.test.ts` (memory mode).

2. **F2** (`notifications.ts:256`) — `createMentionNotificationIdempotent` now gates the insert on
   the recipient's CURRENT visibility, not just existence, in both stores.
   - `src/lib/store/notifications/db.ts`: the `target` subquery (mention writer only) now carries
     the same `NOT (...)` predicate as F1's SQL twin, inside the `FOR KEY SHARE`-locked row read —
     a recipient hidden after emit but before this drain-time write is excluded under the lock.
   - `src/lib/store/notifications/memory.ts`: `buildMentionNotification` now also refuses when
     `isPubliclyHiddenAgent(recipient)`.
   - The consumer's existence check (`plan()`/dispatch) is unchanged; the drain still receipts a
     `null` return as success (same mechanism the post-liveness refusal already relies on).
   - Tests: new case in `m11-2-b1-mentions.test.ts` ("visible at emit but hidden before the drain",
     real Postgres) and in `mention-notification-liveness.test.ts` (memory).

3. **F3** (`comments/memory.ts:28`) — trimmed `withCreatedCommentId`'s doc comment from 9 lines to
   4, keeping the positional-primary rule and the marker condition, dropping the repair history and
   the misleading "every later event gets source_id filled" opening line.

## Gate results

- `npx tsc --noEmit`: 0 errors. One error appeared mid-session in `reactions-memory.test.ts`
  (`Type '{ kind: "reaction.removed"; ... }' is not assignable to type 'PreparedEvent'`) — grepped
  the full output for every lane-M file path: zero hits. `git status` confirms
  `reactions-memory.test.ts` and `reactions/{db,memory}.ts` are lane R's concurrent in-flight edit;
  a later re-run showed it gone. No lane-M file was ever implicated.
- `npx eslint src/lib/store/agents/db.ts src/lib/store/agents/memory.ts src/lib/agent-public.ts
  src/lib/store/notifications/db.ts src/lib/store/notifications/memory.ts
  src/lib/store/comments/memory.ts src/__tests__/lib/store/agents/list-agents-active-now.test.ts
  src/__tests__/lib/store/mention-notification-liveness.test.ts
  src/__tests__/integration/m11-2-b1-mentions.test.ts
  src/__tests__/integration/m11-2-b1-presence.test.ts --max-warnings=0`: 0 errors, 6 pre-existing
  warnings, all in functions this lane did not touch: `completeVetting` (agents/db.ts:1177,
  complexity 16), `deleteAgent` (agents/memory.ts:378, complexity 13), `followAgent`
  (agents/memory.ts:491, complexity 14), `deleteEvaluationMemoryForAgent` (agents/memory.ts:892,
  complexity 15), `completeVetting` (agents/memory.ts:1076, complexity 18), `buildCommentNotification`
  (notifications/memory.ts:166, complexity 16) — the last is newly visible only because this run is
  the first time `notifications/memory.ts` was in this lane's eslint file list; the function itself
  is untouched by this lane.
- `npm test -- src/__tests__/lib/mentions.test.ts src/__tests__/lib/events
  src/__tests__/api/v1/agents-presence.test.ts src/__tests__/lib/store src/__tests__/lib/actions
  --runInBand`: 67 suites / 746 tests, ran clean (67/67, 746/746) on the confirming run. One
  interim run showed `dms-memory.test.ts` failing (`setDmBlock` assertion) — confirmed via
  `git status` as lane D's concurrent in-flight edit to `src/lib/store/dms/memory.ts` /
  `src/lib/actions/dms.ts`, not a lane-M file; a later re-run of the full path list was clean.
- `npm run test:integration -- src/__tests__/integration/m11-2-b1-mentions.test.ts`: 12/12 passing
  (final confirmation run).
- `npm run test:integration -- src/__tests__/integration/m11-2-b1-presence.test.ts`: 1/1 passing
  (final confirmation run).

## Mutation-check evidence (verbatim)

**F1 (db)**: removed the `AND NOT (...)` clause from the `sort="recent"` `active_now` branch.
```
- Expected  - 1
+ Received  + 4
  Array [
-   "b1p_visible_...",
+   "b1p_hidden_..._4",
+   "b1p_hidden_..._3d1n_4",
+   ...
```
(3 hidden ids returned instead of the 1 visible id — limit filled entirely by hidden rows).
Restored; `m11-2-b1-presence.test.ts` green again.

**F1 (memory)**: removed `&& !isPubliclyHiddenAgent(a)` from the `active_now` filter.
```
- Expected  - 1
+ Received  + 1
  Array [
-   "visiblemttfq7ol506",
+   "hiddenmttfq7ol505",
  ]
```
Restored; `list-agents-active-now.test.ts` green again (4/4).

**F2 (db)**: reverted the `target` subquery to `SELECT id, name FROM agents WHERE id = $3::text
FOR KEY SHARE` (no visibility predicate). The new test failed:
```
expect(received).toBeNull()
Received: {"actor": {...}, "agent_id": "b1m_agent_..._51", ..., "type": "mention", ...}
```
A real notification row was returned. Restored; `m11-2-b1-mentions.test.ts` green again (12/12).

**F2 (memory)**: reverted `buildMentionNotification`'s guard to `if (!recipient) return null;`
(dropped the `isPubliclyHiddenAgent` check). The new test failed:
```
expect(received).toBeNull()
Received: {"actor": {...}, "agent_id": "recipient", ..., "type": "mention", ...}
```
Restored; `mention-notification-liveness.test.ts` green again (4/4).

**F3**: comment-only change, no behavior to mutation-check.

## Shared-file edits

- `src/lib/store/agents/db.ts` / `memory.ts`: `listAgents` only.
- `src/lib/store/notifications/db.ts`: mention writer only (`MENTION_NOTIFICATION_SELECT`'s
  `target` subquery) — re-read immediately before each edit; no collision.
- `src/lib/agent-public.ts`: this lane's own file (not on the shared list) — one export keyword
  added, no behavior change.
- No changes to `src/lib/events/kinds.ts`, `coverage.ts`, `store-types.ts`, `store.ts`,
  `export-manifest.ts`, `migrate.js`, `agent-tools/index.ts`, or `actions/types.ts` this round.

## Out-of-fence needs and cross-lane notes

- None. All three findings were resolvable within lane M's fence.

## Docs delta

None of the three findings change any documented API behavior, request/response shape, or public
invariant — F1/F2 are bug fixes that make behavior match what was already documented (hidden
agents excluded, mentions to hidden agents suppressed), and F3 is comment-only. No `public/*.md`,
`openapi.json`, or `CLAUDE.md` bullet is needed.

## Behavior changes or plan deviations

- **New optional third parameter on `listAgents`** (`limit?: number`, db default 500, memory
  default unbounded): not requested by name in the plan, but the round-3 spec itself suggested
  "passing a small limit option if the read accepts one" to avoid seeding 500 rows for the DB test.
  Added as the minimal, backward-compatible way to satisfy that instruction — every existing call
  site is unaffected (arity-compatible, same default behavior).
- **`IS NOT DISTINCT FROM` instead of `=`** in the SQL hidden-agent predicate (both `agents/db.ts`
  and `notifications/db.ts`): required for correctness once tested against a real agent row with
  `metadata IS NULL` (the common case) — plain `=` against `NULL` silently disabled the whole
  predicate. Recorded here since it was not literally specified by the finding text, but the round
  gate ("mutation-check every behavioral fix") caught it before commit.
