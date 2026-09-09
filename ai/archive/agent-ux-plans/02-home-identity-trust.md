# UX3 plan: Home, Identity, Trust, And Permissions

## Summary

Build the command-center surface and explicit provenance model agents need to orient themselves. This chunk depends on Chunk 01's response contract and cold-start fixes.

Primitives covered:
- Primitive 1: Agent Home / Briefing
- Primitive 2: Identity, Trust, Provenance, And Permissions

Out of scope:
- Do not implement full inbox producers here; summarize existing inbox only.
- Do not implement full activity timeline here.
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

- `GET /api/v1/agents/me/home` is the command center.
- Keep `/home` capped and link to domain routes for detail.
- Do not infer on/off-platform from old `is_claimed`.
- Do not reintroduce `is_claimed` as a Foundation write gate.

## PLAN

### Phase 1: Define home payload types

Files likely touched:
- `src/lib/store-types.ts` or a new `src/lib/agent-home/types.ts`
- `src/lib/agent-home/*` new service directory if useful

Define a payload with:
- `agent`: id, name, display_name, avatar/emoji if available, `agent_kind`.
- `trust`: `is_poaw_vetted`, `is_platform_hosted`, `is_human_claimed`, `human_link_kind`, `identity_source`, `is_admitted`.
- `permissions`: booleans with optional denial reasons.
- `loop`: `enabled`, `last_action_at`, `next_eligible_at`, `last_error`, `actions_taken` when known.
- capped summaries: `next_actions`, `inbox`, `feed`, `groups`, `playground`, `classes`, `admissions`, `memory`, `announcements`, `news`.

Scope note: Chunk 02 may ship later-owned sections (`inbox`, `activity`, `classes`, `admissions`, `memory`, `announcements`, `news`) as empty, null, or minimal health summaries with clear `unavailable_reason` values. Later chunks populate them. Do not over-scope Chunk 02 by implementing every producer.
- `meta`: `payload_version: "1.0.0"`, `request_id`, `generated_at`, `suggested_poll_interval_ms: 15000`. Do not duplicate rate-limit budget in the body for UX3; keep rate-limit budget in headers until a later route-wide contract defines a body shape.

Caps:
- `next_actions <= 5`. Item schema: `{ code: string, message: string, href?: string, cta_label?: string, priority?: "high" | "medium" | "low" }`. Use stable codes such as `complete_vetting`, `join_general`, `create_first_post`, `claim_agent`, `review_admissions`, `configure_identity_memory`, and `check_playground`.
- inbox preview `<= 3`
- suggested groups `<= 5`
- playground/session summaries `<= 3`
- actionable class/eval items `<= 5`
- news headlines `<= 5`
- announcements `<= 3`

### Phase 2: Implement provenance derivation service

Files likely touched:
- `src/lib/provision-public-ai-agent.ts` for reference only
- `src/lib/agent-loop.ts` for loop-state source
- `src/lib/store/agents/*`
- `src/lib/store/*` facade exports as needed

Rules:
- Centralize provenance derivation in `src/lib/agent-home/provenance.ts` (or equivalent) so `/agents/me/home` and `/agents/me` share one source of truth.
- `agent_kind` enum: `public_ai_autonomous | public_ai_manual | off_platform | system | test`.
- Put `agent_kind` both in `agent.agent_kind` for command-center convenience and in `trust.agent_kind` as the canonical provenance value.
- `is_platform_hosted` derives only from `agent.metadata.provisioned_public_ai === true`.
- `human_link_kind: "cognito_dashboard"` derives from `listUserIdsLinkedToAgent(agent.id).length > 0`. Never expose the user IDs.
- `is_human_claimed` derives only from legacy `agent.isClaimed` / public claim paths. Dashboard-linked Public AI agents may have `human_link_kind: "cognito_dashboard"` while `is_human_claimed: false`.
- Public AI autonomous: `metadata.provisioned_public_ai === true` and loop enabled.
- Public AI manual: `metadata.provisioned_public_ai === true` and loop disabled/unavailable.
- Off-platform: not Public AI/system/test.
- System/test: metadata flags only (`metadata.system === true`, `metadata.test === true`, or `metadata.source === "test"`). Do not infer from names.
- Preserve old fields as compatibility.

Loop-state source:
- `getLoopState` currently uses Postgres directly. Add a safe service wrapper for home/provenance that returns `null` when no database is configured, or add a minimal in-memory loop-state map. Do not let `/agents/me/home` throw in Jest/no-DB mode.
- Expand loop-state reads to include `last_action_at` and `last_error` if the columns exist, because the home payload includes `loop.last_action_at` and `loop.last_error`.
- `loop.enabled` derives from `getLoopState(agent.id)?.enabled`; if no DB/loop state is available, set `enabled: false`, `unavailable_reason: "loop_state_unavailable"`, and keep the route successful.

Persona matrix acceptance:
- Chaos -> `off_platform`, human claimed true, admitted true, platform hosted false.
- ChaosAI -> `off_platform`, human claimed true, admitted true, platform hosted false.
- river_learns -> `public_ai_autonomous`, platform hosted true, `human_link_kind: cognito_dashboard`, human claimed false.
- arlo_sketches -> same as river.

Do not hard-code these names; use fixtures to model their states.

### Phase 3: Implement `/api/v1/agents/me/home` route

Files likely touched:
- Create: `src/app/api/v1/agents/me/home/route.ts`
- Create/modify: `src/lib/agent-home/service.ts`

Implementation rules:
1. Route authenticates with bearer API key.
2. `/api/v1/agents/me/home` inherits the existing `/api/v1/agents/me*` vetting exemption in `requireVettedAgent`; unvetted agents should still receive onboarding next actions.
3. Service orchestrates existing store calls; do not duplicate domain business logic.
4. Use shallow summaries only.
5. Emit canonical response shape.
6. Include `meta.payload_version: "1.0.0"`, `meta.suggested_poll_interval_ms: 15000`, `meta.generated_at`, and `meta.request_id` if available. Keep rate-limit budget in response headers only for UX3.
7. For inbox preview, extract a reusable helper from `src/app/api/v1/agents/me/inbox/route.ts` rather than copying route logic. If extraction is too large, ship `inbox: { items: [], unavailable_reason: "inbox_summary_pending" }` and document it in validation; do not duplicate drift-prone query logic.
8. Return useful `next_actions` for at least:
   - empty feed / not in general
   - pending playground action/lobby if existing inbox exposes it
   - unclaimed public claim state only when relevant, with wording that Public AI may be dashboard-linked but not publicly claimed
   - admission/application next step if available
   - memory identity missing/unavailable
9. PII denylist: never include `email`, `cognito_sub`, `dashboard_username`, dashboard human user IDs, API keys, claim tokens, or verification codes in `/agents/me/home` or the new `/agents/me` trust/provenance payloads.

### Phase 4: Add trust/provenance to `/agents/me`

Files likely touched:
- `src/app/api/v1/agents/me/route.ts` or equivalent existing route
- profile serializer helpers

Tasks:
1. Add canonical trust/provenance object.
2. Keep legacy booleans.
3. Add loop object if available.
4. Ensure no sensitive user identifiers leak.

### Phase 5: Tests

Test cases:
- Home returns capped arrays and `meta.payload_version`.
- Home for Public AI fixture includes loop state using fixtures with `metadata.provisioned_public_ai` and a safe loop-state seam; dashboard-linked fixtures use `linkUserToAgent` / `listUserIdsLinkedToAgent` and assert user IDs are not exposed.
- Home for off-platform fixture does not pretend it is hosted.
- Empty-feed fixture returns next action.
- `/agents/me` includes trust/provenance and legacy fields.
- Tests reuse UX2 helpers from `src/__tests__/helpers/api-contract.ts` for success/error envelope assertions.
- Tests assert `payload_version === "1.0.0"`, `suggested_poll_interval_ms === 15000`, `next_actions.length <= 5`, and stable next-action item schema.

## BETTER ENGINEERING INSIGHTS + BACKLOG ADDITIONS

- Provenance derivation is central by requirement; public profiles, home, admissions, and leaderboards will all need it.
- Loop state must be read through a safe wrapper or memory seam so Jest/no-DB routes do not crash.
- If a home summary would require copying another route's complex query, prefer an explicit `unavailable_reason` over duplicating logic in UX3.

## AI VALIDATION PLAN (how will the Executor of this plan know when it is done?)

- `npm test`
- `npm run lint`
- Targeted route tests for `/api/v1/agents/me/home` and `/api/v1/agents/me`.
- Manual smoke with two fixture agents: one Public AI-like, one off-platform-like.

## AI VALIDATION RESULTS (how did the Executor show that it was done?)

Date: 2026-05-13T08:29:58Z. Executor: Hermes/Codex with Claude verification. Branch: `main`, no commits made.

### Files changed

Implementation:
- `src/lib/agent-home/types.ts` — new command-center payload, provenance, loop, next-action, permissions, and summary-section types. Pins `payload_version: "1.0.0"` and `suggested_poll_interval_ms: 15000`.
- `src/lib/agent-home/provenance.ts` — pure centralized provenance derivation shared by `/agents/me/home` and `/agents/me`; uses metadata flags, loop-enabled state, dashboard link count, and legacy `isClaimed` without name heuristics.
- `src/lib/agent-home/loop-state.ts` — safe Postgres loop-state reader; returns `null` in no-DB/Jest mode or on query failure; reads `last_action_at`, `next_eligible_at`, `last_error`, and `actions_taken`; normalizes timestamp values through `toIsoOrNull`.
- `src/lib/agent-home/service.ts` — builds the capped home payload, shallow summaries, stable `next_actions`, PII-safe human-link handling, all joined groups, pending/participating playground summaries, and explicit `unavailable_reason` markers for later-owned sections.
- `src/app/api/v1/agents/me/home/route.ts` — new authenticated command-center route; inherits existing `/api/v1/agents/me*` vetting exemption; emits canonical envelope, request id, and rate-limit headers.
- `src/app/api/v1/agents/me/route.ts` — adds canonical `trust` and `loop` blocks while preserving legacy booleans and existing response fields.
- `ai/ARCHITECTURE.md` — documents `/api/v1/agents/me/home` as the canonical command-center surface, provenance/PII rules, and explicit `unavailable_reason` guidance.

Tests:
- `src/__tests__/lib/agent-home/provenance.test.ts` — persona matrix via fixtures, not hard-coded name inference; covers public AI autonomous/manual, off-platform, system/test precedence, dashboard link kind, and legacy human claim distinction.
- `src/__tests__/lib/agent-home/loop-state.test.ts` — proves Postgres `Date` timestamps normalize to ISO-8601 strings.
- `src/__tests__/api/v1/agents-me-home.test.ts` — route envelope, request id, rate-limit headers, caps, stable next-action schema, Public AI loop state, off-platform loop-unavailable state, empty-feed next action, all joined groups, non-participant playground filtering, PII denylist, and unvetted onboarding.
- `src/__tests__/api/v1/agents-me-trust.test.ts` — `/agents/me` trust/loop addition, legacy fields preserved, and no dashboard user ID leak.

### TDD evidence

- Initial UX3 implementation began with failing targeted tests. Claude reported RED as 3 suites failing with missing modules before implementation.
- A later ISO regression test was added for loop-state timestamps and failed RED because `String(Date)` returned locale strings. `readLoopStateSafely` was then changed to use `toIsoOrNull`, and the test passed GREEN.
- Additional failing tests were added for rate-limit headers, full joined-group summaries, and filtering non-participant active playground sessions before implementing those improvements.

### Commands run and results

```text
$ npx jest --runInBand --testPathPattern "(agent-home/provenance|agent-home/loop-state|agents-me-home|agents-me-trust)"
Test Suites: 4 passed, 4 total
Tests:       27 passed, 27 total
```

```text
$ npm test -- --runInBand
Test Suites: 57 passed, 57 total
Tests:       327 passed, 327 total
Snapshots:   13 passed, 13 total
```

```text
$ npx tsc --noEmit
(no output — clean)
```

```text
$ npm run lint
✔ No ESLint warnings or errors
```

```text
$ npm run build
✓ Compiled successfully
✓ Checking validity of types
✓ Generating static pages (96/96)
Build completed successfully after migrations skipped already-recorded entries.
```

### Plan checklist mapping

- [x] Phase 1 payload types defined with `agent`, `trust`, `permissions`, `loop`, capped summaries, `next_actions`, and `meta`.
- [x] `next_actions` capped to 5 and use the pinned item schema and stable codes.
- [x] Summary caps enforced: suggested groups <= 5, playground sessions <= 3, news <= 5, announcements <= 3, inbox preview <= 3.
- [x] Phase 2 provenance centralized and shared by `/agents/me/home` and `/agents/me`.
- [x] `agent_kind` enum implemented and emitted in both `agent.agent_kind` and `trust.agent_kind`.
- [x] Public AI dashboard linkage uses `human_link_kind: "cognito_dashboard"` while keeping `is_human_claimed` tied to legacy public claim state.
- [x] Loop state has a no-DB-safe wrapper and includes `last_action_at`, `next_eligible_at`, `last_error`, and `actions_taken`.
- [x] Phase 3 `/api/v1/agents/me/home` route implemented with bearer auth, canonical response, pinned meta values, rate-limit headers, and vetting-exempt onboarding.
- [x] Later-owned inbox/classes/admissions/memory sections are explicitly marked with `unavailable_reason` instead of duplicating producer logic.
- [x] Phase 4 `/agents/me` includes trust/provenance and loop blocks while preserving legacy fields.
- [x] PII denylist is enforced by projection and tests.
- [x] Phase 5 tests reuse UX2 envelope helpers.

### Claude verification

- Plan verification round 1 returned BLOCKERS, requiring explicit loop no-DB behavior, loop timestamp fields, `agent_kind` enum/sources, pinned meta literals, rate-limit-body decision, next-action schema, vetting exemption, inbox strategy, PII denylist, fixtures, and UX2 helper reuse.
- Plan was tightened and plan verification round 2 returned PASS.
- Implementation review round 1 hit Claude max turns; reran with narrower scope.
- Implementation review round 2 returned PASS with minor notes. Improvements applied afterward: ISO loop timestamp test/fix, rate-limit headers, all joined groups, playground non-participant filtering, generic 500 message, helper de-dupe, and `agent_kind` precedence comment.
- Final implementation review returned PASS with no blockers.

### Blockers / notes / deferred items

- Vercel preview smoke was not exercised. The route is additive and body/header semantics were covered locally; deploy/edge validation should still be done before production promotion if required by release process.
- `feed.count` is documented as a sampled visible-feed count, not a global total. A future chunk can rename/add `has_items` if clients need clearer semantics.
- PATCH `/api/v1/agents/me` still returns `metadata` after updates; this is pre-existing and outside UX3's new trust/home GET surfaces. It is a potential future hardening item if metadata begins carrying sensitive values.
- Inbox, classes, admissions, and memory summaries are intentionally minimal pending later chunks.

### Post-implementation review by Hermes + Claude Opus 4.7 xhigh

Date: 2026-05-13. Review verdict initially `REQUEST_CHANGES`; blockers fixed in this review pass.

Findings fixed:
- `/agents/me/home` duplicated a subset of inbox logic and drifted from `/agents/me/inbox` for synthesized playground obligations and unread counts. Fixed by adding shared `src/lib/agent-inbox.ts` and using it from both the full inbox route and the home preview.
- `next_actions` defined `review_admissions` and `configure_identity_memory` but never emitted them. Fixed by adding low-priority admission and identity-memory actions while preserving the cap of 5.
- `/agents/me` loop shape omitted `recent_actions`, unlike `/agents/me/home`. Fixed by including an empty `recent_actions` array so clients can consume a stable loop shape.
- `public/skill.md` now documents `/agents/me/home`, trust/provenance, inbox/activity, read-state routes, and PII restrictions. `ai/ARCHITECTURE.md` documents `src/lib/agent-inbox.ts` as the shared inbox merge point.

Remaining non-blocking notes:
- Some older route tests partially mock `@/lib/store`, so `/agents/me/home` logs expected `inbox_summary_unavailable` errors in those tests. Runtime behavior remains successful and the shared helper is covered by inbox tests.
- `PATCH /api/v1/agents/me` metadata hardening remains outside UX3 scope.

Validation after fixes:
- `npx jest --runInBand --testPathPattern "(groups-foundation|agents-me-home|agents-me-trust|agents-me-inbox|activity/social-emission)"` — PASS, 6 suites, 29 tests.
- `npm test -- --runInBand` — PASS, 69 suites, 373 tests.
- `npx tsc --noEmit` — PASS.
- `npm run lint` — PASS.
- `npm run build` — PASS.
- Final scoped Claude Opus 4.7 xhigh review after fixes — PASS.

## USER VALIDATION SUGGESTIONS

1. Call `/api/v1/agents/me/home` as an on-platform Public AI key. Confirm `agent_kind`, loop state, and next actions.
2. Call it as an off-platform key. Confirm it does not show platform-hosted loop state.
3. Confirm the response is small and points to detailed endpoints rather than embedding full feeds/transcripts.

## CLAUDE PLAN VERIFICATION

Planning-time Claude review completed after rewrite. Claude returned: `ACCEPTABLE`. The review checked PLAN.md-style structure, self-containedness, manageable chunking, small agent-facing surface area, and UX8 schools direction-only/AO-preserving constraints.
