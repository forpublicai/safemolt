# UX9 plan: Live Agent UX Polish

## Summary

Fix the small live-contract gaps found while dogfooding the deployed agent experience with one off-platform agent and one on-platform autonomous Public AI agent. Keep the work KISS: no new primitives, no schema changes, no policy redesign. Reuse existing provenance, loop-state, ISO-date, and response-envelope helpers.

## Goal

Make the live agent-facing surfaces tell a consistent story: public/profile identity matches authenticated identity, timestamps are parseable ISO strings, class routes speak snake_case, and high-traffic list/profile APIs expose enough `meta` for agents to reason without scraping headers.

## KISS architecture

- Add regression tests around the exact live failures.
- Fix serializers at route boundaries instead of changing store shapes.
- Read public loop state through the existing PII-safe `readLoopStateSafely()` helper.
- Preserve legacy aliases where clients may already depend on them.

## PLAN

### Phase 1: Public profile autonomy parity

Files:
- Modify `src/lib/agent-public.ts`
- Modify `src/app/api/v1/agents/profile/route.ts`
- Modify public profile page code if it calls `publicAgentProvenance()` directly
- Test `src/__tests__/api/v1/ux7-contracts.test.ts`

Behavior:
- Public/API profile trust for provisioned Public AI should use known loop state when available.
- If loop state is enabled, expose `agent_kind: "public_ai_autonomous"` and badge `Autonomous loop on`.
- If loop state is disabled, expose `public_ai_manual` and `Autonomous loop off/unknown` for compatibility.
- Do not expose Cognito user IDs or ownership metadata.

### Phase 2: ISO timestamp normalization at touched route boundaries

Files:
- Modify `src/app/api/v1/classes/[id]/evaluations/route.ts`
- Modify `src/app/api/v1/classes/[id]/evaluations/[evalId]/route.ts`
- Modify `src/app/api/v1/classes/route.ts`
- Modify `src/app/api/v1/announcements/route.ts`
- Modify `src/lib/agent-home/service.ts`
- Test `src/__tests__/api/v1/ux6-contracts.test.ts`

Behavior:
- Class evaluation `created_at` must be ISO 8601 even when store rows contain Date objects or JS date strings.
- Class list items should include snake_case `enrollment_open`, `max_students`, and `created_at` while preserving `enrollmentOpen`, `maxStudents`, and `createdAt` legacy aliases.
- Announcements in `/announcements` and `/agents/me/home` should use ISO `created_at`.

### Phase 3: Add minimal meta polish

Files:
- Modify `src/app/api/v1/groups/route.ts`
- Modify `src/app/api/v1/agents/profile/route.ts`
- Tests in `ux7-contracts.test.ts` or focused route tests.

Behavior:
- `/api/v1/groups` adds `meta.count`, `meta.school_id`, `meta.include_houses`, `meta.my_membership`, and `meta.request_id`.
- `/api/v1/agents/profile?name=` adds `meta.request_id` and `meta.recent_posts_count`.
- Preserve current top-level legacy aliases.

## AI VALIDATION PLAN

- Run focused failing tests first to prove coverage.
- Run focused tests after fixes:
  - `npm test -- --runInBand src/__tests__/api/v1/ux7-contracts.test.ts src/__tests__/api/v1/ux6-contracts.test.ts`
- Run static checks:
  - `npx tsc --noEmit --pretty false`
  - `npm run lint`
- Run full Jest if focused checks pass and time allows.
- Perform at least one Claude review pass. If Claude CLI is unavailable, stop and report the blocker per the project workflow.

## AI VALIDATION RESULTS

Implementation completed with a KISS route-boundary serializer approach.

Validation performed:

- RED: `npm test -- --runInBand src/__tests__/api/v1/ux7-contracts.test.ts src/__tests__/api/v1/ux6-contracts.test.ts` failed on the new assertions for public AI autonomy, profile/groups meta, class evaluation ISO timestamps, and class snake_case aliases.
- GREEN focused: same command passed after implementation — 2 suites / 19 tests.
- `npx tsc --noEmit --pretty false` — PASS.
- `npm run lint` — PASS, no ESLint warnings or errors.
- `npm test -- --runInBand` — PASS, 70 suites / 390 tests / 13 snapshots. Existing intentional console output from inbox fallback, vetting memory sync, schools error-envelope, and playground component initialization remained non-failing.
- `npm run build` — PASS. Migration runner connected to `.env.local` Neon, skipped already-recorded migrations, and Next.js production build completed. Existing pg SSL-mode warning remained non-failing.
- Claude Opus 4.7 xhigh review round 1 — PASS / no blockers. Non-blocking suggestions were evaluated: clarified the intentional null loop-state behavior for bulk badge surfaces, made groups `meta.include_houses` reflect the effective filter, removed duplicate class timestamp normalization in the professor branch, and normalized group POST `created_at`.
- After those cleanup changes, reran focused tests + typecheck + lint — PASS.
- After those cleanup changes, reran `npm test -- --runInBand` and `npm run build` — PASS.
- Claude Opus 4.7 xhigh review round 2 — PASS / no blockers. Non-blocking notes were limited to possible future coverage for announcements/home announcement ISO and older pre-existing profile timestamp aliases.

Remaining deferred/non-blocking work:

- Bulk public surfaces (`/agents`, group member snippets, leaderboards) intentionally keep `loopEnabled: null` to avoid N+1 loop-state reads. Single-agent profile surfaces now pass known PII-safe loop state.
- Existing pre-UX9 profile timestamp aliases can be normalized in a broader contract cleanup if needed.
- Announcement ISO behavior is implemented but not directly tested in this patch; class/profile/groups dogfood regressions are covered by focused tests.

## USER VALIDATION SUGGESTIONS

After deploy, verify:

1. `GET /api/v1/agents/me/home` and `GET /api/v1/agents/profile?name=arlo_sketches` agree that Arlo is autonomous when loop is enabled.
2. `/u/arlo_sketches` shows `Autonomous loop on` instead of `off/unknown`.
3. `GET /api/v1/classes/{slug}/evaluations` returns ISO `created_at`.
4. `GET /api/v1/classes` includes snake_case aliases.
5. `GET /api/v1/groups` and `GET /api/v1/agents/profile?name=...` include useful `meta`.
