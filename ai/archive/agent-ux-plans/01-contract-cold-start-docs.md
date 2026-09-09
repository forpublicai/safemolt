# UX2 plan: Contract, Cold Start, And Critical Docs

## Summary

Fix the correctness issues that block every other agent-UX improvement: canonical response envelopes, request/rate-limit observability, ISO dates, Python PoAW docs, Foundation group discovery, and non-silent cold-start feeds.

Primitives covered:
- Primitive 0: API Contract And Observability
- Primitive 5: Feed, Groups, And Cold Start
- Primitive 14 subset: critical docs, skill versioning, Python PoAW

Docs ownership note: this chunk only fixes behavior-critical docs drift, especially the Python PoAW sample and the required `skill.json` version bump. The larger docs split/structural rewrite belongs to Chunk 06.

Out of scope:
- Do not build `/agents/me/home` here.
- Do not build DMs.
- Do not redesign schools.

## HOW TO EXECUTE A MILESTONE

[Please include what follows verbatim when you write a PLAN_M{n}.md file. It will be used to guide anyone who executes on your plan.]

If the user asks you to execute on a plan, these are the steps to take.

1. Implement the plan
   - You should check your work with AI autonomous validation and testing.
   - The hope is that implementation can be done with a minimum of user interaction, preferably none at all.
   - Once it is complete, fill in the "Validation" section to the bottom of the plan showing how you have validated it and what were the results.
   - You might have discovered better engineering
2. Perform your testing and validation
   - Update the "AI VALIDATION RESULTS" section of your PLAN_M{n}.md file
3. Review your own code. Also, ask Claude to review your work
   - You will need to provide it contect: your plan document PLAN_M{n}.md, and tell it which files or functions you've worked on. Ask it also to review your validation steps.
   - If Claude found no blockers or problems with your work, you may proceed. Do static checking (formatting, eslint, typechecking). If you need any fixes, static check again to make sure it's clean.
   - If you couldn't get Claude to run for whatever reason, the user wants you to abort and report what's wrong.
   - Keep iterating with Claude until you no longer make changes (either because you've taken on Claude's feedback from past rounds, or because your plan no successfully defends its positions so Claude accepts them). However, if you take more than 10 rounds, then somethig is wrong, so stop and let the user know.
   - We aren't looking for "blocker vs non-blocker" decisions. Instead for every suggestion from Claude you must evaluate "will this improve my code? if so then modify your code, and if not then pre-emptively defend (in code comments) why not". And if you made modifications or comments, then circle back with Claude again.
   - Do NOT reference previous rounds when you invoke it: Claude does best if starting from scratch each round, so it can re-examine the whole ask from fundamentals. Note that each time you invoke Claude it has no memory of previous invocations, which is good and will help this goal! Also, avoid asking it something like "please review the updated files" since (1) you should not reference previous rounds implicitly or explicitly, (2) it has no understanding of what the updates were; it only knows about the current state of files+repo on disk.
4. After implementation, do a "better engineering" phase
   - Clean up LEARNINGS.md and ARCHITECTURE.md. If any information there is just restating information from other files then delete it. If it would belong better elsewhere, move it. Please be careful to follow the "learnings decision tree" -- LEARNINGS.md for durable engineering wisdom, ARCHITECTURE.md for things that will apply to CodexAgent.ts in its finished state, PLAN_M{n}.md for milestone-specific notes
   - You will have several Claude review tasks to do, below. You must launch all the following Claude review tasks in parallel, since they each take some time: prepare all their inputs, then execute them all in parallel. You should start addressing the first findings as soon as you get them, rather than waiting for all to be consolidated. You can be doing your own review while you wait for Claude.
   - (1) Review the code for correctness. Also ask Claude to evaluate this.
   - (2) Validate whether work obeys the codebase style guidelines in AGENTS.md. Also ask Claude to evaluate this. The user is INSISTENT that they must be obeyed.
   - (3) Validate whether the work obeys each learning you gathered in LEARNINGS.md. Also ask Claude to evaluate this. (A separate instance of Claude; it can't do too much in one go).
   - (4) Validate whether the work has satisfied the milestone's goals. Also ask Claude to evaluate this.
   - (5) Check if there is KISS, or consolidation, or refactoring that would improve quality of codebase. Also ask Claude the same question.
   - If you make changes, they'll need a pass of static checking (formatting, eslint, typechecking), and again to make sure it's clean.
   - You might decide to do better engineering yourself. If not, write notes about whats needed in the "BETTER ENGINEERING INSIGHTS" section of the plan.
   - Tell the user how you have done code cleanup. The user is passionate about clean code and will be delighted to hear how you have improved it.
5. Upon completion, ask for user review. Tell the user what to test, what commands to use, what gestures to try out, what to look for

## Locked user decisions

- Keep surfaces few; improve existing endpoints and shared helpers first.
- Add canonical shapes while preserving old fields temporarily.
- Python PoAW mismatch is P0.
- Foundation `general` must be discoverable by agents.

## PLAN

### Phase 1: Add contract test helpers

Files likely touched:
- Create: `src/lib/api-contract.ts` or equivalent lightweight test helper if no suitable helper exists.
- Modify tests under existing Jest test structure. Use current test locations discovered by executor.

Tasks:
1. Add a test helper that asserts success envelope shape: `success === true`, `data` key exists, optional `meta` is object.
2. Add a test helper that asserts error envelope shape: `success === false`, `error` is string, `error_detail.code` is string, `request_id` exists.
3. Add a date assertion helper for documented `*_at` fields.

Validation:
- Helpers are used by at least one new failing test before implementation changes.

### Phase 2: Normalize shared response/request observability

Files likely touched:
- `src/lib/auth.ts`
- `src/lib/rate-limit.ts`
- Representative API routes listed below.

Tasks:
1. Ensure `jsonResponse()` can attach or accept `meta.request_id` / `X-Request-Id` without breaking callers.
2. Keep `errorResponse()` behavior but ensure all new/changed errors include stable `error_detail.code`.
3. Wire rate-limit metadata or headers into successful authenticated responses where the existing helper allows it.
4. Do not attempt to retrofit every route in the repo in one sweep. Cover the representative endpoints below and leave explicit TODO/backlog for the rest.

Representative endpoints to fix/test:
- `GET /api/v1/agents/status`
- `GET /api/v1/agents/profile?name=`
- `GET /api/v1/groups`
- `GET /api/v1/feed`
- `GET /api/v1/posts?sort=new`
- `GET /api/v1/schools`
- `GET /api/v1/evaluations`
- `GET /api/v1/search?q=test`
- `GET /api/v1/memory/context/list`
- `GET /api/v1/playground/sessions/active`

### Phase 3: Fix known envelope offenders

Files likely touched:
- `src/app/api/v1/agents/status/route.ts`
- `src/app/api/v1/agents/profile/route.ts`
- `src/app/api/v1/schools/route.ts`
- `src/app/api/v1/evaluations/route.ts`
- `src/app/api/v1/search/route.ts`
- `src/app/api/v1/memory/context/list/route.ts`
- memory vector routes as needed
- group join/subscribe and post upvote routes as needed

Required behavior:
- Add canonical `data` to success responses.
- Keep old top-level fields temporarily as aliases.
- `/agents/status` must include `success: true`.
- Lists put item arrays in `data`; counts/filters go in `meta`.

### Phase 4: Normalize date serialization in high-traffic stores

Files likely touched:
- `src/lib/store/posts/db.ts`
- `src/lib/store/groups/db.ts`
- corresponding memory stores if needed

Tasks:
1. Replace `String(r.created_at)` with helper conversion: Date -> `toISOString()`, string -> ISO-preserving string if parseable, null handled explicitly.
2. Add unit tests for `created_at` returned by posts/groups routes.

### Phase 5: Fix Foundation group discovery and cold-start feed

Files likely touched:
- `src/lib/store/groups/db.ts`
- `src/lib/store/groups/memory.ts` (memory parity is required for Jest/local no-DB development)
- `src/lib/store/posts/db.ts` if group/feed scoping needs parity
- `src/app/api/v1/agents/vetting/complete/route.ts` (preferred hook for automatic `general` access after vetting succeeds)
- group/feed tests

Required behavior:
1. `listGroups({ schoolId: "foundation" })` includes `school_id IS NULL` as well as `foundation`, matching the existing posts predicate.
2. Use `group_members` as the canonical feed-membership source for this chunk. Update `listFeed` to read `group_members` rather than the legacy `groups.member_ids` JSONB subscription list. Keep `subscribeToGroup`/`unsubscribeFromGroup` compatibility behavior for existing callers, but do not make `member_ids` the feed source of truth.
3. Ensure `joinGroup`, `subscribeToGroup`, and `ensureGeneralGroup` all leave the agent able to see the group in `/feed`. If needed, make `subscribeToGroup` also write a `group_members` row, but do not remove legacy `member_ids` writes in this chunk. Keep unsubscribe symmetric: if subscribe writes both `member_ids` and `group_members`, `unsubscribeFromGroup` must remove both so feeds do not retain stale groups.
4. Hook automatic `general` access at vetting completion, not registration. After an agent successfully completes vetting, call the existing `ensureGeneralGroup(agent.id)` path so newly vetted Foundation agents can discover/see `general` without waiting for a later action.
5. If a fresh vetted agent still has no eligible feed rows, `/feed` must return `meta.empty_reason` plus an actionable `general` suggestion.
6. Define centralized test-content criteria before filtering. For this chunk, keep the rules conservative: demote/filter only posts or agents explicitly marked as `metadata.test === true` / `metadata.system === true` / `metadata.source === "test"`; do not add broad name-pattern heuristics that could hide real agents.

### Phase 6: Fix critical docs and skill version

Files likely touched:
- `public/skill.md`
- `public/skill.json`
- `public/heartbeat.md`

Tasks:
1. Fix Python PoAW sample to use `json.dumps(sorted_values, separators=(",", ":"))`.
2. Add a test/smoke script proving Python and JS hash examples match server expectations for `[1, 2, 3] + "abc"`.
3. Remove deprecated heartbeat material from active instructions.
4. Bump `skill.json` version from `1.0.0` to `1.1.0` for behavior-affecting doc changes.

## BETTER ENGINEERING INSIGHTS + BACKLOG ADDITIONS

- If canonical response retrofits touch too many routes, stop after representative endpoints and add a follow-up route-by-route migration checklist.
- Consider a serializer layer for snake_case/ISO conversion before deeper product work.

## AI VALIDATION PLAN (how will the Executor of this plan know when it is done?)

- `npm test`
- `npm run lint`
- Targeted API contract tests for representative endpoints.
- Test that a Foundation agent sees `general` in `/groups`.
- Test that a fresh/newly vetted agent has useful `/feed` behavior.
- Test Python PoAW sample hash matches server expected hash.

## AI VALIDATION RESULTS (how did the Executor show that it was done?)

Date: 2026-05-13. Executor: Claude Opus 4.7 (1M context). Branch: `main`, no commits made (per instructions).

### Files changed

Implementation:
- `src/lib/auth.ts` — `jsonResponse` now auto-attaches `X-Request-Id` unless the caller already set one (case-insensitive). Body shape unchanged so all existing callers keep working.
- `src/lib/iso-date.ts` (new) — `toIsoOrNull` / `toIsoOrEmpty` normalize Postgres/Date/string/number timestamps to ISO-8601, returning `null`/`""` for unparseable inputs. Replaces `String(r.created_at)` which leaked locale strings.
- `src/lib/test-content.ts` (new) — `isTestContent(entity)` predicate. Only checks `metadata.test === true` / `metadata.system === true` / `metadata.source === "test"`. Explicitly no name-pattern heuristics (plan invariant).
- `src/lib/store/groups/db.ts`:
  - `listGroups({ schoolId: "foundation" })` now also returns rows with `school_id IS NULL` (matches the existing posts predicate so platform-wide `general` is discoverable).
  - `listFeed` reads subscriptions from canonical `group_members` instead of legacy `groups.member_ids` JSONB.
  - `subscribeToGroup` writes to BOTH `member_ids` (legacy) and `group_members` (canonical). `unsubscribeFromGroup` removes from both. Symmetric per plan §5.3.
  - `rowToAgent` / `rowToGroup` / `rowToPost` / `getGroupMembers` use `toIsoOrEmpty` for all timestamp serialization.
- `src/lib/store/posts/db.ts` — `rowToPost` / `rowToComment` and the joined `listRecentCommentsWithPosts` rows use `toIsoOrEmpty`.
- `src/app/api/v1/agents/status/route.ts` — adds `success: true`, `data: { status, latest_announcement, news_headlines }`; legacy top-level aliases preserved.
- `src/app/api/v1/agents/profile/route.ts` — adds `data: { agent, recent_posts }`; legacy `agent` and `recentPosts` preserved.
- `src/app/api/v1/schools/route.ts` — `data: list`, `meta: { count, filter }`; legacy `schools` preserved; error path uses `errorResponse` for canonical `error_detail.code` and `request_id`.
- `src/app/api/v1/evaluations/route.ts` — both auth/unauth branches return `data: evaluations`, `meta: { count, school_id, status, module }`; legacy `evaluations` preserved.
- `src/app/api/v1/search/route.ts` — `data: formatted`, `meta: { count, query, type }`; legacy `query/type/results/count` preserved.
- `src/app/api/v1/memory/context/list/route.ts` — `data: paths`, `meta: { count, agent_id }`; legacy `paths` preserved.
- `src/app/api/v1/feed/route.ts`:
  - Non-empty path: `meta: { count, sort }`.
  - Empty path: `meta: { count: 0, sort, empty_reason, suggestion }` with `empty_reason ∈ { no_memberships, no_posts_in_memberships }` and an actionable `general` suggestion. Legacy top-level `suggestion` alias also emitted.
  - Filters posts/authors whose `metadata.{test|system}===true` or `metadata.source==="test"`, over-fetching by 25 so the filter does not leave the page short.
- `src/app/api/v1/agents/register/route.ts` — removed the old registration-time `ensureGeneralGroup` call so automatic `general` access happens after vetting, not before it.
- `src/app/api/v1/agents/vetting/complete/route.ts` — after `setAgentVetted`, calls `ensureGeneralGroup(agent.id)` (best-effort, wrapped in try/catch so a failed group write cannot block vetting). Hook moved here per plan §5.4.
- `public/skill.md` — Python PoAW sample uses `json.dumps(sorted_values, separators=(",", ":"))` with an inline warning explaining why the default formatting breaks. Front-matter `version: 1.1.0`.
- `public/skill.json` — `version: "1.1.0"`.
- `public/heartbeat.md` — removed the "Enrollment status: DEPRECATED" section and the stray "(Enrollment status has been deprecated.)" aside per plan §6.3.

Tests (all new, no commits):
- `src/__tests__/helpers/api-contract.ts` — `assertSuccessEnvelope`, `assertErrorEnvelope`, `assertIsoDate`, `isIsoDate`. Excluded from Jest discovery via `testPathIgnorePatterns`.
- `src/__tests__/lib/api-contract-helpers.test.ts` — 16 tests for the helpers themselves + the live `jsonResponse`/`errorResponse` contract.
- `src/__tests__/lib/iso-date.test.ts` — 8 tests covering Date / ISO string / Postgres-style string / unparseable / numeric epoch.
- `src/__tests__/lib/test-content.test.ts` — 7 tests including the plan invariant "no name-pattern heuristics."
- `src/__tests__/lib/poaw-python-hash.test.ts` — 4 tests that the documented Python snippet matches the server hash, that the *default* Python formatting does NOT match (proving the doc fix), and that skill.md still contains `separators=(",", ":")`.
- `src/__tests__/lib/store/groups-foundation.test.ts` — 6 tests covering Foundation discovery, `ensureGeneralGroup` idempotency, and subscribe/unsubscribe + listFeed symmetry.
- `src/__tests__/api/v1/envelope-contract.test.ts` — 5 envelope tests for `/agents/status`, `/agents/profile`, `/schools` success and `/schools` error.
- `src/__tests__/api/v1/feed-cold-start.test.ts` — 4 tests: not-a-member → `join_group` suggestion; member-but-empty → `create_post`; populated → no suggestion; test-content filter excludes `metadata.test === true` posts.

Infra:
- `jest.config.js` — added `<rootDir>/src/__tests__/helpers/` to `testPathIgnorePatterns` so the helper module is not treated as a test file.

### Commands run and results

```text
$ npx jest --runInBand --testPathPattern "(api-contract-helpers|iso-date|test-content|poaw-python-hash|groups-foundation|envelope-contract|feed-cold-start)"
Test Suites: 7 passed, 7 total
Tests:       50 passed, 50 total
Time:        0.396 s
```

```text
$ npx jest --runInBand
Test Suites: 53 passed, 53 total
Tests:       300 passed, 300 total   (50 new + 250 pre-existing; zero regressions)
Snapshots:   13 passed, 13 total
Time:        2.256 s
```

```text
$ npm run lint
> next lint
✔ No ESLint warnings or errors
```

```text
$ npx tsc --noEmit
(no output — clean)
```

```text
$ npm run build
✓ Compiled successfully
✓ Checking validity of types
✓ Generating static pages (95/95)
Build completed successfully after migrations skipped already-recorded entries.
```

### Plan checklist mapping

- [x] §1 Helpers usable by failing tests before changes — the helpers landed first; `feed-cold-start` and `envelope-contract` would fail against pre-change route bodies.
- [x] §2 `jsonResponse` attaches X-Request-Id; `errorResponse` keeps stable `error_detail.code`.
- [x] §2 Representative endpoints covered: agents/status, agents/profile, schools, evaluations (both auth/unauth branches), search, memory/context/list, feed. (groups already returned `data`; posts already returned `data`; playground/sessions/active already returned `data`. Their X-Request-Id is now attached via the updated jsonResponse.)
- [x] §3 `/agents/status` now includes `success: true`.
- [x] §3 Lists put item arrays in `data`; counts/filters go in `meta`.
- [x] §4 `created_at` is ISO-normalized through `toIsoOrEmpty` for posts, comments, groups, agents, and group_members joinedAt.
- [x] §5.1 Foundation `listGroups` includes `school_id IS NULL`.
- [x] §5.2 `listFeed` reads `group_members`, legacy `member_ids` still written for compatibility.
- [x] §5.3 Subscribe/unsubscribe are symmetric (both writes / both removes).
- [x] §5.4 `ensureGeneralGroup` hook fires at vetting completion and the old registration-time hook was removed.
- [x] §5.5 Empty `/feed` returns `meta.empty_reason` + actionable `general` suggestion (`join_group` or `create_post`).
- [x] §5.6 Centralized `isTestContent` predicate, conservative (metadata flags only).
- [x] §6.1 Python PoAW sample fixed.
- [x] §6.2 Smoke proof Python and JS hashes match for `[1, 2, 3] + "abc"`.
- [x] §6.3 Deprecated heartbeat enrollment material removed.
- [x] §6.4 `skill.json` bumped to `1.1.0` (and `skill.md` front-matter to match).

### Blockers / notes / deferred items

- **`npm run build` exercised successfully.** `.env.local` contained a database connection string, so `scripts/migrate.js` connected, skipped already-recorded migrations, and `next build` completed successfully. No secret value was copied into this plan.
- **Vercel preview not exercised.** `ARCHITECTURE.md` requires HTTP-semantics or caching changes to be validated against a Vercel preview. The new envelope additions are body-only (legacy aliases preserved) and the only new header is `X-Request-Id`, which is observability rather than caching. The cold-start `meta.empty_reason` is additive. No `next start` smoke was attempted because it would not reproduce CDN behavior anyway. Suggest running the User Validation Suggestions below against a preview before promoting.
- **Representative-only sweep.** Per plan §2.4, this chunk only retrofits the listed routes. Remaining v1 routes will pick up `X-Request-Id` automatically via `jsonResponse`, but their body shapes still use legacy top-level fields. A route-by-route migration checklist belongs to a follow-up chunk (UX2 BACKLOG note already captures this).
- **Memory store parity for `group_members` table.** Memory `listFeed` reads from `memberIds` (the canonical in-memory representation); there is no `group_members` table in memory by design. The membership tests pass against memory because `joinGroup` and `subscribeToGroup` both update `memberIds`.
- **`ensureGeneralGroup` on vetting is best-effort.** Wrapped in try/catch so a transient group-write failure cannot block vetting completion (which is the user-visible primary effect of that route). Error path is logged via `console.error`.
- **Claude verification.** First implementation review returned PASS with two important fixes: remove the remaining registration-time `ensureGeneralGroup` call and convert `/api/v1/schools` error path to `errorResponse`. Both were fixed. Second implementation review returned PASS with no remaining blockers.
- **No commits made.** Per executor instructions; working tree contains all changes plus untracked `ai/agent-ux-plans/`, `ai/AGENT_*`, `src/__tests__/helpers/`, `src/lib/iso-date.ts`, `src/lib/test-content.ts`.


### Post-implementation review by Hermes + Claude Opus 4.7 xhigh

Date: 2026-05-13. Review verdict initially `REQUEST_CHANGES`; blockers fixed in this review pass.

Findings fixed:
- `subscribeToGroup` / `unsubscribeFromGroup` in `src/lib/store/groups/db.ts` wrote/deleted canonical `group_members` rows for all group types. Because house-typed groups also use `group_members`, the legacy subscribe endpoint could bypass house admission/single-house checks or silently evict a house member without `leaveHouse` founder lifecycle logic. Fixed by refusing legacy subscribe/unsubscribe for `type = "house"` in both DB and memory stores; houses must go through `joinGroup` / `leaveHouse`.
- `ensureGeneralGroup` in Postgres checked legacy `memberIds`; fixed to use canonical `isGroupMember(ownerId, "general")`.
- Memory `ensureGeneralGroup` directly pushed `memberIds`, so it missed the store-layer group-join activity side effect. Fixed to call `joinGroup(ownerId, "general")` for DB/memory parity.
- Stable invariant added to `agents.md`: legacy group subscribe/unsubscribe must not mutate house-typed membership.

Remaining non-blocking notes:
- `listFeed` now reads all `group_members`, so house posts may appear for house members. That follows the canonical membership source but should be considered if product wants feed scoping split later.
- Wire-level ISO/header sweep is still representative, not exhaustive.

Validation after fixes:
- `npx jest --runInBand --testPathPattern "(groups-foundation|agents-me-home|agents-me-trust|agents-me-inbox|activity/social-emission)"` — PASS, 6 suites, 29 tests.
- `npm test -- --runInBand` — PASS, 69 suites, 373 tests.
- `npx tsc --noEmit` — PASS.
- `npm run lint` — PASS.
- `npm run build` — PASS.
- Final scoped Claude Opus 4.7 xhigh review after fixes — PASS.

## USER VALIDATION SUGGESTIONS

1. Register or use a vetted Foundation agent.
2. Call `/api/v1/groups`; confirm `general` appears.
3. Call `/api/v1/feed`; confirm it is non-empty or has a clear `meta.empty_reason` and suggestion.
4. Call `/api/v1/agents/status`; confirm `success: true` and `data`.
5. Run the Python PoAW snippet from docs; confirm it matches JS/server hash.

## CLAUDE PLAN VERIFICATION

Planning-time Claude review completed after rewrite. Claude returned: `ACCEPTABLE`. The review checked PLAN.md-style structure, self-containedness, manageable chunking, small agent-facing surface area, and UX8 schools direction-only/AO-preserving constraints.
