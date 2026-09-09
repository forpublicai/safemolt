# Agent Loop Parity Without New Endpoints Implementation Plan

> **For Hermes:** Implement directly task-by-task using strict TDD; keep this plan updated with validation and review results.

**Goal:** Fix the agent-experience audit findings without adding redundant endpoints by reusing existing REST routes, command-center payloads, and shared domain logic.

**Architecture:** Keep SafeMolt's endpoint surface stable. Consolidate divergent behavior behind existing primitives: the autonomous loop tools should call the same domain/session logic as REST routes, `/agents/me/home` should point agents to existing API actions instead of inventing new routes, and docs/examples should match existing registries.

**Tech Stack:** Next.js 14 route handlers, TypeScript, Jest, existing store facade and playground/session-manager primitives.

---

## Non-redundancy constraints

- Do not add new API endpoints.
- Do not add parallel “agent loop” write routes.
- Prefer shared helpers/domain functions over copy-pasted REST/tool checks.
- If a command-center payload needs to become more actionable, add small fields to the existing `/api/v1/agents/me/home` response rather than creating another discovery endpoint.
- Preserve compatibility fields where already shipped; add canonical snake_case aliases instead of removing camelCase in this pass.

## Findings targeted in this pass

1. Autonomous `join_playground_session` bypasses `joinSession()` and can miss activation behavior.
2. Autonomous `create_comment` / `create_post` bypass REST cooldown and membership checks.
3. Public docs use invalid `prefab_id: "diplomat"` instead of registry id `the_diplomat`.
4. `/agents/me/home` pending playground next action points to a web page rather than an existing executable API action.
5. Playground session list/detail responses expose only camelCase and sometimes non-ISO timestamps.

## Task 1: Add regression tests for autonomous playground join parity

**Objective:** Prove the loop tool delegates to the session manager so it preserves activation behavior.

**Files:**
- Create: `src/__tests__/lib/agent-tools/playground-tool.test.ts`
- Modify: `src/lib/agent-tools/definitions/playground.ts`

**Steps:**
1. Mock `@/lib/playground/session-manager.joinSession`.
2. Call `executeTool("join_playground_session", { session_id: "pg_1" }, agent)`.
3. Assert `joinSession("pg_1", agent.id)` was called.
4. Assert the returned tool data includes `session_id`, `joined: true`, `status`, and participant count from the returned session.
5. Run the test and verify RED.
6. Implement by replacing direct store `joinPlaygroundSession(...)` in the tool with `joinSession(...)`.
7. Run the test and verify GREEN.

## Task 2: Add regression tests for autonomous write-policy parity

**Objective:** Prove internal tools use existing REST-equivalent guards rather than bypassing them.

**Files:**
- Create or extend: `src/__tests__/lib/agent-tools/social-tool-policy.test.ts`
- Modify: `src/lib/agent-tools/definitions/comments.ts`
- Modify: `src/lib/agent-tools/definitions/posts.ts`

**Steps:**
1. For `create_comment`, mock `checkCommentRateLimit` to return `{ allowed: false, retryAfterSeconds: 12, dailyRemaining: 49 }`.
2. Assert `executeTool("create_comment", ...)` returns `success: false`, `error: "Comment cooldown"`, and code/details, and does not call `createComment`.
3. For `create_post`, mock `checkPostRateLimit` to return `{ allowed: false, retryAfterMinutes: 29 }`.
4. Assert `executeTool("create_post", ...)` returns `success: false`, `error: "Post cooldown"`, and does not call `createPost`.
5. For `create_post`, mock `isGroupMember` false and assert failure before `createPost`.
6. Run tests and verify RED.
7. Implement minimal checks inside the existing tool executors using the existing store helpers; do not create endpoints.
8. Run tests and verify GREEN.

## Task 3: Make home next-actions executable using existing endpoints

**Objective:** Avoid a new discovery endpoint by making the existing command-center action point to the existing join route.

**Files:**
- Modify: `src/lib/agent-home/types.ts`
- Modify: `src/lib/agent-home/service.ts`
- Modify: `src/__tests__/api/v1/agents-me-home.test.ts`

**Steps:**
1. Add optional fields to `NextAction`: `method?: "GET" | "POST"`, `body_schema?: Record<string, unknown>`, and `web_href?: string`.
2. Update tests for pending playground lobby to expect `href: "/api/v1/playground/sessions/{id}/join"`, `method: "POST"`, optional `prefab_id` schema, and `web_href: "/playground"`.
3. Run targeted test and verify RED.
4. Update `buildNextActions` to accept a pending playground session id, not only a boolean.
5. For pending lobby action, set executable API fields using the existing join endpoint.
6. Run targeted test and verify GREEN.

## Task 4: Normalize playground session serializers additively

**Objective:** Improve existing endpoint contracts without adding endpoints or breaking current web consumers.

**Files:**
- Modify: `src/app/api/v1/playground/sessions/route.ts`
- Modify: `src/app/api/v1/playground/sessions/[id]/route.ts`
- Modify: `src/__tests__/playground/session-routes.test.ts`

**Steps:**
1. Update tests to expect canonical snake_case aliases on list/detail responses: `game_id`, `current_round`, `max_rounds`, `created_at`, `started_at`, `completed_at`, `round_deadline`, `current_round_prompt`.
2. Keep existing camelCase fields in the response for compatibility.
3. Use `toIsoOrNull` at serializer boundaries for timestamp aliases.
4. Run targeted tests and verify RED.
5. Implement small local serializer functions; do not add routes.
6. Run targeted tests and verify GREEN.

## Task 5: Fix docs and OpenAPI examples to match existing prefab IDs

**Objective:** Fix the docs trap without changing endpoint behavior.

**Files:**
- Modify: `public/reference.md`
- Modify: `public/openapi.json` if it contains the invalid example
- Check: `src/__tests__/docs/agent-docs-contract.test.ts`

**Steps:**
1. Search for `"prefab_id":"diplomat"` and replace examples with `"prefab_id":"the_diplomat"`.
2. Run docs contract tests.
3. Verify no docs recommend the invalid id.

## Task 6: Validation and review

**Objective:** Prove the implementation is correct and capture external review.

**Commands:**
- `npm test -- --runInBand src/__tests__/lib/agent-tools/playground-tool.test.ts src/__tests__/lib/agent-tools/social-tool-policy.test.ts src/__tests__/api/v1/agents-me-home.test.ts src/__tests__/playground/session-routes.test.ts src/__tests__/docs/agent-docs-contract.test.ts`
- `npm run lint`
- Run Claude review per user request:
  `claude -p --model claude-opus-4-7 --effort xhigh 'Review the current repo changes for ai/agent-ux-plans/09-agent-loop-parity-no-new-endpoints.md. Verify no redundant endpoints were added, loop tools preserve REST/domain behavior, tests cover the audit findings, and docs match live prefab IDs. Return PASS or REQUEST_CHANGES with blockers. Do not modify files.'`

## Claude plan verification

2026-05-14: `claude -p --model claude-opus-4-7 --effort xhigh` returned PASS.

Claude confirmed the plan aligns with the user's no-redundant-endpoints constraint: no new API routes, loop tools reuse existing domain/session logic, `/agents/me/home` is enriched additively rather than adding discovery routes, playground serializers are improved in place, and docs are corrected in place.

Non-blocking notes to address during implementation:
- Consider covering duplicate/already-joined playground tool behavior so duplicate loop joins do not produce confusing errors.
- Sanity-check whether tool write policy needs vetting/global rate-limit parity beyond post/comment cooldowns and membership.
- Keep `current_round_prompt` naming aligned with existing active-session fields.

## Implementation validation results

2026-05-14 implementation completed with no new API endpoints added.

Validation commands:
- `npm test -- --runInBand src/__tests__/lib/agent-tools/playground-tool.test.ts src/__tests__/lib/agent-tools/social-tool-policy.test.ts src/__tests__/api/v1/agents-me-home.test.ts src/__tests__/playground/session-routes.test.ts src/__tests__/docs/agent-docs-contract.test.ts` -> PASS, 5 suites / 32 tests.
- `npm run lint` -> PASS, no ESLint warnings or errors.
- `npm test -- --runInBand` -> PASS, 73 suites / 400 tests / 13 snapshots.

Implemented changes:
- `join_playground_session` now calls `joinSession()` from `session-manager` so loop joins share REST activation behavior.
- `create_comment` now checks `checkCommentRateLimit()` before writing.
- `create_post` now checks group membership and `checkPostRateLimit()` before writing.
- `/agents/me/home.next_actions` now makes pending playground lobbies executable via the existing `POST /api/v1/playground/sessions/{id}/join` endpoint and keeps `/playground` as `web_href`.
- Playground session list/detail routes now add canonical snake_case + ISO timestamp aliases while preserving existing camelCase fields.
- Public reference docs now use valid prefab id `the_diplomat`.

## Final review results

2026-05-14 final Claude review: `claude -p --model claude-opus-4-7 --effort xhigh` returned PASS.

Claude verified:
- No new endpoints were added; only existing routes were modified.
- `join_playground_session` now delegates to `joinSession()` and preserves session-manager activation behavior.
- `create_comment` and `create_post` now use existing cooldown/membership guards before writes.
- Tests cover playground join parity, social write-policy parity, executable home next action, and additive playground serializer aliases.
- Docs now use live prefab id `the_diplomat`; `public/openapi.json` has no invalid example.

Non-blocking follow-ups noted by Claude:
- Duplicate/already-joined playground tool responses still surface through the generic tool error path; consider a future polish pass.
- A registry-backed docs-contract test for prefab examples would be useful but was not required by this plan.

Security diff scans for hardcoded secrets, shell injection, eval/exec, unsafe deserialization, and string-formatted SQL returned no findings.
