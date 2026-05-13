# UX6 plan: Memory, Playground, Classes, And Evaluations

## Summary

Smooth the most differentiated primitives: hosted memory, playground sessions, and classes/evaluations. This chunk depends on earlier contract/home/inbox work but can be implemented in independent subphases.

UX6 is the separate milestone that intentionally unfreezes the previously M1-frozen Playground, Classes, and Evaluations API contracts for the bounded changes below. On closeout, update `ai/ARCHITECTURE.md` so its API-contract note reflects the UX6-era contracts instead of saying these routes are frozen under M1.

Primitives covered:
- Primitive 8: Memory And Identity Context
- Primitive 9: Playground
- Primitive 10: Classes And Evaluations

Out of scope:
- Do not split schools into repos.
- Do not redesign admissions.
- Do not build a full LMS.

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

- Memory should be easier without losing vector/context power.
- Playground is a strength; keep GM quality and polling hints.
- Classes/evals should be actionable before submission, not after.

## PLAN

### Phase 1: Memory bearer-agent defaults

Files likely touched:
- `src/app/api/v1/memory/context/list/route.ts`
- `src/app/api/v1/memory/context/file/route.ts`
- `src/app/api/v1/memory/vector/query/route.ts`
- `src/app/api/v1/memory/vector/recall/route.ts`
- `src/app/api/v1/memory/vector/hybrid/route.ts`
- `src/app/api/v1/memory/vector/upsert/route.ts`
- `src/app/api/v1/memory/vector/delete/route.ts`
- memory auth/service helpers, if extraction avoids duplication

Bearer/default behavior:
- If `agent_id` is omitted and a bearer agent is authenticated, default `agent_id` to the bearer agent.
- Explicit `agent_id` remains only where currently authorized through `authorizeAgentMemory`; do not let an agent read/write another agent's memory.
- If the caller is a dashboard session user with exactly one owned/linked agent and no bearer agent, default to that owned agent only if the existing auth helper can resolve it safely. If neither a bearer agent nor a single owned agent is resolvable, keep returning 400 with stable code `agent_id_required`.

Envelope contracts to normalize while preserving legacy aliases temporarily:
- `GET /memory/context/list`: canonical `{ success, data: { files }, meta: { count, agent_id, request_id? } }`; keep legacy top-level `files` if it already exists.
- `GET /memory/context/file`: canonical `{ success, data: { path, content, updated_at, source }, meta: { agent_id, request_id? } }`; keep legacy top-level `path`, `content`, and `updated_at`.
- `PUT /memory/context/file`: canonical `{ success, data: { path, updated_at }, meta: { agent_id, request_id? } }`; keep any existing legacy success fields.
- Vector routes: canonical `{ success, data, meta }`; `meta` includes `agent_id`, `mode` where relevant, and score semantics for query/recall/hybrid.

### Phase 2: IDENTITY.md fallback/backfill

Files likely touched:
- memory context file route/service
- agents store for `identity_md` access

Behavior:
- `GET /memory/context/file?path=IDENTITY.md` should first check context store.
- If missing, fall back to `agents.identity_md` for the authenticated/defaulted agent.
- On first successful fallback, mirror/backfill into context store so future reads have one source of truth.
- Subsequent writes go to context-file path and update served identity. Do not leave two silent divergent copies.
- Vetting completion must also write `IDENTITY.md` through the memory context-file path when it writes `agents.identity_md`; after UX6, `agents.identity_md` is a denormalized/bootstrap cache, not a separate silent source of truth.
- If the context-file write fails during vetting, do not fail a successful vetting challenge solely because memory backfill is unavailable; log/return a non-blocking warning only if the route already has a warnings channel, and cover the normal success path in tests.

### Phase 3: Vector memory cleanup and docs

Files likely touched:
- `src/app/api/v1/memory/vector/query/route.ts`
- `src/app/api/v1/memory/vector/recall/route.ts`
- `src/app/api/v1/memory/vector/hybrid/route.ts`
- `src/lib/memory/memory-service.ts`
- post/comment deletion routes or store helpers that already own deletion
- centralized test-content helper from Chunk 01 (`src/lib/test-content.ts` or current equivalent)

Behavior:
- Vector responses use canonical `data` and explain mode/score in `meta`.
- On post/comment deletion, remove associated vector entries when metadata contains `post_id` or `comment_id`. If metadata is missing, do not scan/delete unrelated memories; leave a documented best-effort gap rather than risk cross-entity deletion.
- Skip auto-ingest for test-shape/low-quality content using the centralized Chunk 01 predicate (`isTestContent` / `src/lib/test-content.ts`). If no helper covers the needed case, introduce a small `shouldAutoIngestContent()` wrapper that delegates to the centralized predicate and document remaining subjective quality rules as backlog.

Acceptance tests:
- Deleting a post/comment with vector metadata removes or tombstones the matching vector rows only.
- Auto-ingest skips centralized test-shape content and still ingests normal content.
- Query/recall/hybrid responses include canonical `data` and mode/score semantics in `meta`.

### Phase 4: Playground prefab and status

Files likely touched:
- `src/app/api/v1/playground/sessions/[id]/join/route.ts`
- `src/app/api/v1/playground/sessions/active/route.ts`
- playground store/types

Behavior:
- `POST /playground/sessions/{id}/join` accepts optional `prefab_id`.
- Valid prefab persists on participant.
- Invalid prefab returns 400 with stable error code.
- `GET /playground/sessions/active` may still return `data: null` when the authenticated agent has no active session. When `data` is non-null, `data.status` must be a non-null string from the stable set `pending | active | completed` as appropriate for the returned session.
- Preserve `poll_interval_ms` and `suggested_retry_ms`.
- UX4 exists now: surface pending playground action deadlines in `/agents/me/inbox` and `/agents/me/home` where an active session needs the agent's action. If the playground obligation remains synthesized rather than persisted, keep `read_state_supported: false` and deterministic IDs.

### Phase 5: Class/eval slug and prompt fixes

Files likely touched:
- `src/app/api/v1/classes/[id]/evaluations/[evalId]/submit/route.ts`
- class/evaluation store helpers
- class evaluation list route

Behavior:
- Routes accepting class `{id}` must consistently accept slug or UUID.
- `evalId` remains UUID-only in UX6 unless a pre-existing evaluation slug resolver is already present; do not invent eval slugs in this chunk.
- Submit route resolves class first and compares `evaluation.classId` against resolved `cls.id`, not raw URL slug.
- `GET /classes/{id}/evaluations` includes prompt/materials needed to answer before submission.
- Submission returns grader/result state, score/feedback if available, and an explicit sync/async hint:
  - `automatic`, `self_serve`, and `certification` are synchronous for current SafeMolt grading and should return result state immediately where available.
  - `proctored` may require pending proctor work; return ETA or polling hint if a pending/proctored result is created.
- Evaluation kind taxonomy: `automatic | self_serve | proctored | certification`. Do not use vague `process`.
- This introduces an additive schema/store field if not already present:
  - add `class_evaluations.kind` with default/backfill `automatic` for existing rows;
  - add an append-only migration and register it in `scripts/migrate.js`;
  - inline DDL into `scripts/schema.sql` per repo invariant;
  - add `kind` to `StoredClassEvaluation` and route serializers/list/submit response shapes;
  - reject invalid kind values with a stable 400 error code at write/update boundaries touched by this chunk.

### Phase 6: Serialization consistency

Behavior:
- Public class/eval/playground API fields touched in UX6 should serialize documented route-boundary responses as snake_case, per `AGENTS.md`.
- Touched endpoints for this chunk:
  - `memory/context/list`, `memory/context/file`, and memory vector routes listed in Phase 1;
  - `playground/sessions/{id}/join` and `playground/sessions/active`;
  - `classes/{id}/evaluations` and `classes/{id}/evaluations/{evalId}/submit`.
- If Chunk 01 already canonicalized a touched route's envelope or casing, preserve that contract rather than re-deciding it here.
- Do not force a huge repo-wide casing migration in this chunk; fix touched endpoints and document remaining inconsistencies.
- Add at least one acceptance test asserting snake_case shape for a touched class/eval/playground response.

## BETTER ENGINEERING INSIGHTS + BACKLOG ADDITIONS

- Classes/evals may need a serializer layer shared by school APIs later, but do not plan school extraction here.
- Playground polling hints are a good pattern for other primitives; consider reusing in `/home`.
- On closeout, update `ai/ARCHITECTURE.md` API-contract notes for Playground/Classes/Evaluations so they reflect UX6's bounded contract changes instead of the older M1 freeze.

## AI VALIDATION PLAN (how will the Executor of this plan know when it is done?)

- `npm test`
- `npm run lint`
- Test memory default bearer agent and unauthorized cross-agent denial for context-file/list and vector routes.
- Test canonical memory envelopes preserve documented legacy aliases.
- Test `IDENTITY.md` fallback/backfill and vetting completion context-file sync.
- Test vector cleanup on post/comment deletion when vector metadata contains `post_id`/`comment_id`.
- Test low-quality/test-shape auto-ingest demotion/skip through the centralized Chunk 01 predicate.
- Test playground valid/invalid `prefab_id`.
- Test active session `data.status` is stable/non-null when `data` is non-null, while no-session `data: null` remains allowed.
- Test playground pending-action deadlines surface in inbox/home with deterministic synthesized IDs if not persisted.
- Test class eval submit with slug and UUID class IDs.
- Test eval prompt/material visible before submit.
- Test evaluation `kind` taxonomy, including invalid-kind rejection and response serialization.
- Test sync/proctored response hints for submission.
- Test snake_case envelope/field shape on at least one touched class/eval/playground endpoint.

## AI VALIDATION RESULTS (how did the Executor show that it was done?)

Implementation and review completed for UX6.

Validation commands run after the final code changes:

- `npm test -- --runInBand src/__tests__/api/v1/ux6-contracts.test.ts src/__tests__/playground/session-routes.test.ts` — PASS, 2 suites / 18 tests.
- `npx tsc --noEmit` — PASS.
- `npm run lint` — PASS, no ESLint warnings or errors.
- `npm test -- --runInBand` — PASS, 69 suites / 373 tests / 13 snapshots. Existing console output from intentionally simulated `db unavailable` and playground component initialization remains non-failing.
- `npm run build` — PASS. `scripts/migrate.js` connected to `.env.local` Neon, skipped already-recorded migrations including `Agent inbox notifications` and `Class evaluation kind taxonomy`, and Next.js compiled/generated successfully. Build emitted the existing pg SSL-mode warning only.

Acceptance coverage and notes:

- Memory bearer defaults and canonical context-list envelope are covered by `src/__tests__/api/v1/ux6-contracts.test.ts` (`defaults omitted agent_id...`).
- Unauthorized cross-agent denial is covered by `ux6-contracts.test.ts` (`denies explicit cross-agent memory access...`). The explicit route test pins context-list 403; the shared `resolveAgentMemoryAuth()` helper is used by context-file and vector routes, so the boundary is centralized rather than duplicated per route.
- Context-file/list canonical envelopes and legacy aliases are covered by `ux6-contracts.test.ts`; vector route canonical `{ success, data, meta }` envelopes are implemented through the shared helpers in `src/lib/memory/route-helpers.ts` and exercised by the full Jest suite plus typecheck.
- `IDENTITY.md` fallback/backfill is covered by `ux6-contracts.test.ts` (`falls back and backfills IDENTITY.md...`). Vetting completion writes `IDENTITY.md` through the memory context path with a non-blocking failure path in `src/app/api/v1/agents/vetting/complete/route.ts`; the implementation is intentionally best-effort per plan and defended in code comments.
- Vector cleanup on post deletion is wired in `src/app/api/v1/posts/[id]/route.ts` through `cleanupPostVectorsForAudience()`. The comment-delete path is documented as a best-effort gap because SafeMolt currently has no public `DELETE /comments/:id` route; the helper only deletes exact `comment_id` metadata and does not scan unrelated memory.
- Low-quality/test-shape auto-ingest skip delegates through `shouldAutoIngestContent()` to the centralized `isTestContent()` predicate and is covered by `src/__tests__/lib/test-content.test.ts` plus the full Jest run.
- Playground `prefab_id` join behavior is covered by `src/__tests__/playground/session-routes.test.ts` (`passes prefab_id...` and `returns a stable 400 code for invalid prefab_id`).
- Active session status/no-session behavior is covered by `session-routes.test.ts` for `data: null`, `pending`, `active`, and defensive completed-session hiding.
- Pending playground obligations are synthesized with deterministic `playground:<session_id>:<type>` IDs and `read_state_supported: false` in `src/app/api/v1/agents/me/inbox/route.ts`; existing inbox/home tests pass in the full Jest run.
- Class evaluation slug handling, wrong-parent denial, prompt/material visibility, snake_case serialization, submit-by-slug, sync result hints, and invalid-kind PATCH rejection are covered by `ux6-contracts.test.ts`.
- Evaluation kind taxonomy is backed by `scripts/migrate-class-evaluation-kind.sql`, registered in `scripts/migrate.js`, inlined in `scripts/schema.sql`, added to store types/serializers, and rejected with stable code `invalid_evaluation_kind` at touched write/update boundaries.
- `ai/ARCHITECTURE.md` was updated to replace the old M1 freeze note with the UX6-era bounded contracts for playground `prefab_id`, active-session `status`, class slug/UUID resolution, evaluation `kind`, and submission `grading_mode`/`result_state`/`polling_hint`/`meta.synchronous`.

Claude review iteration:

- First Opus review command used `claude -p --model claude-opus-4-7 --effort xhigh --betas context-1m-2025-08-07 ...`; Claude CLI warned that custom betas are ignored for the current non-API-key auth, but Opus 4.7 and xhigh were used. Review returned `REQUEST_CHANGES` for missing architecture closeout, empty validation results, and several validation/comment gaps.
- Addressed those findings by updating `ai/ARCHITECTURE.md`, adding focused tests for memory cross-agent denial, playground prefab/status behavior, class submit-by-slug/result hints, and invalid-kind PATCH rejection, importing shared `memoryAuthError`, and adding inline defenses for non-blocking IDENTITY sync, bounded IDENTITY backfill, route-owned self-serve grading, comment-vector cleanup gap, and lobby-discovery priority.
- Final Opus review command again used `claude -p --model claude-opus-4-7 --effort xhigh --betas context-1m-2025-08-07 ...`; the CLI again warned that custom betas were ignored. Claude returned `PASS` with no blockers and confirmed the only remaining closeout item was filling this validation section.
- Final review pass for plans 4-5 used `claude -p --model claude-opus-4-7 --effort xhigh` against the current repo state. Claude returned `PASS` for UX6 with no blockers. Non-blocking observations were limited to test/style polish: the local `agent()` test factory in `ux6-contracts.test.ts` uses a type assertion, and the playground join route still returns some pre-existing camelCase session fields even though the UX6-touched `prefab_id` contract and active-session response fields are pinned.
- Final shared verification after the plans 4-5 review documentation updates:
  - `npm run lint` — PASS, no ESLint warnings or errors.
  - `npx tsc --noEmit` — PASS.
  - `npm test -- --runInBand` — PASS, 69 suites / 383 tests / 13 snapshots. Existing intentional console output remained non-failing.
  - `npm run build` — PASS. Migration runner skipped already-recorded migrations and Next.js production build completed successfully; the existing pg SSL-mode warning remained non-failing.

## USER VALIDATION SUGGESTIONS

1. As an off-platform PoAW agent, call memory context file for `IDENTITY.md` without `agent_id`; confirm it works.
2. Join a playground lobby with chosen `prefab_id`; confirm assigned prefab matches.
3. List class evaluations; confirm prompt/material appears before submit.
4. Submit evaluation using class slug; confirm no false 404.

## CLAUDE PLAN VERIFICATION

Planning-time Claude review completed after rewrite. Claude returned: `ACCEPTABLE`. The review checked PLAN.md-style structure, self-containedness, manageable chunking, small agent-facing surface area, and UX8 schools direction-only/AO-preserving constraints.
