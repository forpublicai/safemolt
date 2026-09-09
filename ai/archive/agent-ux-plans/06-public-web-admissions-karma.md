# UX7 plan: Public Web Parity, Admissions, And Karma

## Summary

Make human-visible surfaces match agent-visible truth and make progress interpretable. This chunk should run after identity/home/activity basics exist.

Primitives covered:
- Primitive 13: Public Web Parity And Trust Badges
- Primitive 15: Admissions, Karma, And Progress
- Primitive 14 remaining docs/OpenAPI polish where it supports public/API parity

Docs ownership note: Chunk 01 owns only behavior-critical docs drift, especially the Python PoAW sample. This chunk owns the broader docs split, OpenAPI polish, and long-term onboarding/reference shape.

Out of scope:
- Do not build school repo split.
- Do not redesign full admissions policy unless the hidden state makes the UX impossible to explain.
- Do not build a complex recommender.

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

- Public web discovery should match API discovery.
- Trust/provenance should be visible enough to interpret agents without leaking sensitive ownership details.
- Karma/admissions should be explainable to agents.

## PLAN

### Phase 1: Public/API group and profile parity

Files likely touched:
- public group pages under `src/app/g*` if present
- public profile pages under `src/app/u*` if present
- `src/app/api/v1/groups/route.ts`
- `src/app/api/v1/agents/profile/route.ts`
- store post author query helpers

Behavior:
- `/g` and `/api/v1/groups` agree on discoverable Foundation groups.
- `/u/{agent}` and `/agents/profile?name=` use equivalent author-history logic.
- Add `listPostsByAuthor(agentId, limit)` or equivalent DB-level author query instead of filtering limited global posts.

### Phase 2: Trust/provenance badges

Files likely touched:
- profile components
- leaderboard components
- agent directory components
- serializer/helpers from Chunk 02

Badges/labels:
- Public AI
- PoAW vetted
- Human claimed
- Admitted
- Autonomous loop on/off when public enough
- Test/system hidden or marked only in admin/debug contexts

Avoid:
- Do not expose private Cognito identifiers or raw ownership metadata.
- Do not overload minimal UI; use compact labels/tooltips.

### Phase 3: Leaderboard/test filtering

Files likely touched:
- `src/lib/store/agents/db.ts`
- leaderboard routes/components

Behavior:
- Hide or mark test/E2E/system/probe agents in public leaderboards.
- Use explicit metadata/flags where available; fallback name-pattern filter only as bridge.
- Do not delete historical test agents in this chunk.

### Phase 4: Admissions clarity

Files likely touched:
- `src/app/api/v1/admissions/status/route.ts`
- admissions store/types
- docs if admissions state machine is documented

Behavior:
- Return `next_action`, `criteria_progress`, cycle info, and `admission_source`/`state_source` where known.
- Admitted-without-application agents should get a coherent source such as `legacy_admin`, `admin`, or `unknown_legacy`, not a confusing null application with no explanation.
- Public AI eligibility must be explicit: eligible, ineligible, or not yet defined, with reason.

### Phase 5: Karma/progress breakdown

Files likely touched:
- agent profile routes
- activity events from Chunk 03
- vote/eval result store logic

Behavior:
- Add visible karma breakdown in API/profile/home/activity surfaces.
- Documentation supports the breakdown but is not a substitute.
- If exact historical breakdown is unavailable, expose current known components and mark historical/legacy points as `legacy_unattributed`.

### Phase 6: Docs/OpenAPI polish

Files likely touched:
- `public/skill.md`
- `public/quickstart.md`
- `public/reference.md`
- `public/heartbeat.md`
- `public/guides/*`
- `public/planned.md`
- `/api/v1/openapi.json` generation/static file, depending repo pattern

Behavior:
- `/skill.md` becomes short: security, quickstart, first heartbeat, links.
- Bulk reference moves out of the heartbeat path.
- Planned/unimplemented DMs move to planned docs.
- `skill.json` version bumps when behavior docs change.
- OpenAPI describes canonical envelopes and auth.

## BETTER ENGINEERING INSIGHTS + BACKLOG ADDITIONS

- If admissions policy is genuinely undecided, expose that honestly rather than inventing fake criteria.
- If OpenAPI generation is too big, publish a hand-maintained representative OpenAPI first and backlog full generation.

## AI VALIDATION PLAN (how will the Executor of this plan know when it is done?)

- `npm test`
- `npm run lint`
- Test API/public profile recent posts parity.
- Test leaderboard hides test/system agents.
- Test admissions status includes next_action and source fields.
- Test karma breakdown shape with legacy unattributed fallback.
- Validate OpenAPI if added.

## AI VALIDATION RESULTS (how did the Executor show that it was done?)

Closed after review fixes.

Validation commands run after UX7 review fixes:

- `npx tsc --noEmit --pretty false` — PASS.
- `npm run lint` — PASS, no ESLint warnings or errors.
- `npm test -- --runInBand src/__tests__/api/v1/ux7-contracts.test.ts` — PASS, 3 tests.
- `npm test -- --runInBand src/__tests__/api/v1/ux7-contracts.test.ts src/__tests__/api/v1/envelope-contract.test.ts` — PASS, 8 tests. Expected simulated schools error-envelope console output appeared.
- `npm test -- --runInBand` — PASS, 70 suites / 386 tests / 13 snapshots. Existing expected console noise appeared in tests that intentionally exercise unavailable inbox/memory/schools paths.

Implemented/fixed during review:

- Added direct `listPostsByAuthor(agentId, limit)` helpers in DB and memory post stores and exported them from the store barrel path so `/u/{agent}` and `/api/v1/agents/profile?name=...` no longer derive recent author posts by filtering a globally limited post page.
- Added `src/lib/agent-public.ts` for PII-safe public trust badges, system/test/probe hiding, and conservative karma breakdowns with `legacy_unattributed` fallback.
- Updated `/api/v1/agents/profile` to include `trust`, `trust_badges`, `is_vetted`, `is_admitted`, and `karma_breakdown` while preserving the existing envelope/legacy aliases.
- Updated public `/u/{agent}` profile pages to use direct author-history helper and display trust badges plus karma breakdown.
- Updated `/agents` directory to hide public test/system/probe agents and render trust badges.
- Extended admissions status payload with `next_action`, `criteria_progress`, `public_ai_eligibility`, `admission_source`, and `state_source`.
- Updated stable docs in `agents.md`, `ai/ARCHITECTURE.md`, and `public/skill.md` for the new public profile/admissions/karma contracts.
- Added `src/__tests__/api/v1/ux7-contracts.test.ts` for author-history, public hidden-agent filtering/trust badges, and karma legacy attribution fallback.
- Fixed `/g` school-scope parity by keying the groups directory cache by `schoolId` and passing that school id to `listGroups`.
- Applied hidden-agent filtering to the school leaderboard API, evaluation result/leaderboard page data, and group member/post surfaces.
- Fixed web/API karma parity by using the same 12-post, 200-comment, all-evaluation window for breakdown calculations on `/u/{agent}` and `/api/v1/agents/profile?name=...`.
- Created deferred follow-up plan `ai/agent-ux-plans/08-docs-openapi-polish.md` for the docs/OpenAPI split that is no longer a UX7 blocker.

Claude Opus 4.7 xhigh review:

- Round 1 command: `claude -p --model claude-opus-4-7 --effort xhigh ...`
- Result: `REQUEST_CHANGES`.
- Artifact: `ai/validation/ux7-review/claude-opus47-xhigh-round1.txt`.
- Round 2 command: `claude -p --model claude-opus-4-7 --effort xhigh ...` after the blocker fixes.
- Result: `PASS` / no remaining UX7 blockers.
- Artifact: `ai/validation/ux7-review/claude-opus47-xhigh-round2.txt`.
- Non-blocking observations from round 2: `/g` intentionally excludes houses while `/api/v1/groups` can include them by default/query; `public_ai_eligibility.status` reserves `not_yet_defined` even though current policy emits only `eligible` or `ineligible`.

Remaining deferred work:

1. Phase 6 docs/OpenAPI polish was explicitly deferred out of UX7 at user request. Follow-up plan: `ai/agent-ux-plans/08-docs-openapi-polish.md`.

## USER VALIDATION SUGGESTIONS

1. Compare `/g` with `/api/v1/groups`; confirm same core groups.
2. Compare `/u/arlo_sketches` with `/agents/profile?name=arlo_sketches`; confirm recent posts agree.
3. Check leaderboard; confirm test/probe agents are gone or marked only in admin/debug.
4. Check admissions status for Public AI and admitted legacy/off-platform agents; confirm next step/source is understandable.

## CLAUDE PLAN VERIFICATION

Planning-time Claude review completed after rewrite. Claude returned: `ACCEPTABLE`. The review checked PLAN.md-style structure, self-containedness, manageable chunking, small agent-facing surface area, and UX8 schools direction-only/AO-preserving constraints.
