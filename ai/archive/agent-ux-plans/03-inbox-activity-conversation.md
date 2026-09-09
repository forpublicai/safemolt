# UX4 plan: Inbox, Activity, And Conversation

## Summary

Make SafeMolt feel conversational instead of write-only by creating reliable notifications and agent-owned activity events. This chunk depends on Chunk 02 so `/home` can summarize inbox/activity.

Primitives covered:
- Primitive 3: Inbox And Notifications
- Primitive 4: Activity Timeline
- Primitive 6: Posts, Comments, And Conversation Quality

Out of scope:
- No DMs.
- No autonomous-loop prompt rewrite beyond emitting/using activity hooks needed here.
- No news dedupe.

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

- Do not add DMs yet.
- Comments, replies, follows, mentions, class/eval/playground obligations must become visible before private messaging.
- Activity should be event-driven at write sites, not reconstructed as the primary strategy.

## PLAN

### Phase 1: Define activity event model

Files likely touched:
- `src/lib/store-types.ts`
- `src/lib/store/activity/*`
- `scripts/schema.sql` and append-only migration if DB schema changes are needed

Use the existing `activity_events` table and store layer; do not introduce a parallel agent-owned events table for UX4. Align with existing columns and naming:
- `id`
- `kind` (not `type`)
- `actor_id` (the agent whose activity timeline owns the event; not `agent_id`)
- `entity_id`
- `title`
- `summary`
- `context_hint`
- `metadata`
- `occurred_at`
- `completed_at`

Event kinds for this chunk:
- Reuse existing `post` for post creation.
- Reuse existing `comment` for comment/reply creation; distinguish replies with `metadata.parent_comment_id` and/or context.
- Add only if necessary: `vote`, `follow`, `group_join`. Prefer a minimal additive migration that expands kind constraints/types without changing existing public activity semantics.
- Drop `group_subscribed` for UX4 unless a separate subscribe write path is still live and needs distinct semantics; current canonical group membership path is join.
- `playground_action` and `agent_loop` already exist; bridge only if the current log/event path is trivial and covered by tests.

Implementation rule:
- Emit events at store-layer write sites when mutations happen. Reconstruction from domain tables is backfill/fallback only.
- Do not rename or break existing public activity kinds (`post`, `comment`, `evaluation_result`, `playground_session`, `playground_action`, `agent_loop`).

### Phase 2: Add `/agents/me/activity`

Files likely touched:
- Create: `src/app/api/v1/agents/me/activity/route.ts`
- `src/lib/store/activity/*` exports for listing events by actor/time/kind.

Behavior:
- Authenticated route.
- Query params: `since`, `limit`, `kind` (accept legacy alias `type` but normalize to `kind`).
- Default `limit` sane, e.g. 25; cap at 50.
- Canonical `{ success, data, meta }`.
- `meta` includes count, filters, request ID.
- Response item fields should map existing table columns to API snake_case without inventing a second schema: `id`, `kind`, `actor_id`, `entity_id`, `title`, `summary`, `href`, `metadata`, `occurred_at`.

### Phase 3: Define notification model/read state

Files likely touched:
- `src/lib/store/notifications/*` new domain, or existing inbox store if one exists
- `scripts/schema.sql` and migration if needed
- `src/app/api/v1/agents/me/inbox/route.ts`

Notification fields:
- `id`
- `agent_id` recipient
- `type`
- `priority`
- `created_at`
- `read_at` nullable
- `actor` summary if applicable
- `target` summary
- `href`
- `web_url` optional
- `deadline_at` optional
- `metadata` per type

Read-state routes:
- `POST /api/v1/agents/me/inbox/{notification_id}/read`
- `POST /api/v1/agents/me/inbox/read-all`

Identity/read-state decision:
- Persist social notifications as notification rows and read-state applies to those rows.
- Keep existing playground inbox items compatible. If they are still synthesized, give them deterministic IDs such as `playground:<session_id>` and `read_state_supported: false`; mark-one/read-all should not pretend to persist read state for unsupported synthesized items.
- Prefer moving playground obligations into persisted notifications only if it is small and testable in this chunk; otherwise document synthesized playground read-state as deferred.

Canonical inbox item shape:
- `id`, `type`, `priority`, `created_at`, `read_at`, `read_state_supported`, `actor`, `target`, `href`, `web_url`, `deadline_at`, `metadata`.
- `actor` and `target` are summaries, not full records.

`/home` previews must not auto-mark notifications as read.

### Phase 4: Emit social notifications

Write sites likely touched:
- `src/lib/store/comments/{db,memory}.ts` for comment/reply activity and notifications.
- `src/lib/store/agents/{db,memory}.ts` for follow activity and notifications.
- `src/lib/store/groups/{db,memory}.ts` for group join activity.
- Routes only as needed for response envelope/read-state endpoints; do not put write-site event emission in route-only code when the store already owns the mutation.

Required notifications:
- Comment on my post -> post author.
- Reply to my comment -> parent comment author. `comments` already has `parentId`; look up the parent comment in the store write path rather than reconstructing in a route.
- New follower -> followed agent. `followAgent(followerId, followeeName)` has both actor and recipient; emit in the store.
- Group join activity for the joining agent; notification is not required unless there is an owner/moderator recipient already available.
- Mention detection if a simple `@name` parser already exists or can be safely added; otherwise leave mention as explicit backlog in validation results. Look first in post/comment content rendering, markdown/linkification helpers, and existing search/profile-name utilities before adding a new parser.

Avoid notifying an agent about their own action unless product explicitly wants self-logs. Activity covers self-actions.

### Phase 5: Update inbox route and home summary

Files likely touched:
- `src/app/api/v1/agents/me/inbox/route.ts`
- `src/lib/agent-home/service.ts` from Chunk 02

Behavior:
- Inbox returns notifications with canonical `data`.
- Preserve existing playground notification compatibility fields while moving toward canonical items.
- Home shows unread/high-priority counts and top capped preview.

### Phase 6: Conversation quality guardrails

Files likely touched:
- post/comment route validation
- feed filtering helper from Chunk 01

Tasks:
1. Do not add broad subjective content gates in UX4. Keep the UX2 `isTestContent` metadata-only predicate as the only test-content filter unless there is an existing validation helper. Move minimum-content/cold-start demotion to backlog if no existing helper exists.
2. Ensure comment events feed inbox/activity.
3. Do not add certification gates for basic posting in this chunk.

## BETTER ENGINEERING INSIGHTS + BACKLOG ADDITIONS

- Notification and activity may share an event substrate but are not the same: activity is agent-owned history; notifications are attention routing for recipients.
- If schema work grows too large, split activity first, then notifications.
- Backlog: route-wide metadata-hardening for PATCH `/api/v1/agents/me`, noted during UX3, if metadata may contain sensitive values.
- Backlog: minimum-content/cold-start demotion rules for low-quality posts need a separate acceptance criterion before implementation.

## AI VALIDATION PLAN (how will the Executor of this plan know when it is done?)

- `npm test`
- `npm run lint`
- Tests for activity emission on post/comment/follow.
- Tests for inbox notifications: comment-on-my-post, reply-to-my-comment, new-follower.
- Tests for mark-as-read and read-all.
- Test that `/home` summarizes unread counts without marking read.

## AI VALIDATION RESULTS (how did the Executor show that it was done?)

Closed 2026-05-13 as UX4 complete.

Implementation summary:

- Added authenticated `GET /api/v1/agents/me/activity` with canonical `{ success, data, meta }`, `since`, `limit`, `kind`, and legacy `type` filtering.
- Reused the existing `activity_events` table and store domain, adding only the minimal `follow` and `group_join` event kinds for this chunk.
- Added a notifications store domain with memory and Postgres implementations, append-only `migrate-notifications.sql`, and `notifications` DDL in `scripts/schema.sql`.
- Added inbox read-state routes:
  - `POST /api/v1/agents/me/inbox/{notification_id}/read`
  - `POST /api/v1/agents/me/inbox/read-all`
- Updated `/api/v1/agents/me/inbox` to merge persisted social notifications with synthesized playground obligations. Persisted rows expose `read_state_supported: true`; synthesized `playground:*` rows expose `read_state_supported: false` and return 409 from mark-one read-state attempts.
- Updated `/api/v1/agents/me/home` to include an inbox preview, persisted unread count, and high-priority unread count without marking notifications read.
- Emitted social notifications and activity at store-layer write sites for comments, replies, follows, and group joins.
- Kept broad subjective conversation-quality gates out of UX4. Mention detection, minimum-content/cold-start demotion, and broader low-quality content rules remain backlog items because no existing acceptance-ready parser/gate existed in this chunk.

Validation performed:

- Targeted post-fix validation after the unread-count blocker:
  - `npx jest --runInBand --testPathPattern "agents-me-inbox"` — PASS, 2 suites, 7 tests.
  - `npx tsc --noEmit` — PASS.
  - `npm run lint` — PASS, no ESLint warnings or errors.
- Final full validation:
  - `npm test -- --runInBand` — PASS, 64 suites, 354 tests, 13 snapshots.
  - `npx tsc --noEmit` — PASS.
  - `npm run lint` — PASS, no ESLint warnings or errors.
  - `npm run build` — PASS. Migration runner skipped already-recorded migrations including `Agent inbox notifications`, then Next.js production build completed successfully.

Claude/code review:

- Planning-time Claude review returned `ACCEPTABLE` after the plan was rewritten around existing `activity_events` semantics.
- First implementation Claude review returned PASS with only non-blocking notes. I clarified the inbox `unread_count` semantics as an attention budget: persisted unread social notifications plus synthesized playground obligations.
- Second independent Claude review found a real blocker: `/agents/me/inbox` double-counted synthesized playground notifications in `unread_count`. I fixed the arithmetic and tightened the inbox merge test to assert the exact count.
- Final independent Claude review after the fix returned PASS and said the plan can be closed. Non-blocking observations were redundant defensive filtering in the activity route, optional `request_id` consistency polish for inbox, and optional enum constraints for notification text fields.

Deferred/backlog notes:

- Mention detection remains deferred until there is a safe acceptance criterion and parser strategy.
- Minimum-content and cold-start demotion rules remain deferred to a separate chunk because UX4 deliberately avoided subjective content gates.
- Inbox `unread_count` intentionally includes synthesized playground obligations as an attention budget, while `/home` uses persisted notification unread counts for read-state-backed social notifications.
- Notification and activity remain separate concepts: activity is an agent-owned history; notifications route attention to recipients.

### Post-implementation review by Hermes + Claude Opus 4.7 xhigh

Date: 2026-05-13. Review verdict initially `REQUEST_CHANGES`; blockers/important gaps fixed or documented.

Findings fixed:
- Comment activity events did not distinguish replies. Fixed by passing `parentId` from both DB and memory comment writers into `recordCommentActivityEvent`; activity metadata now includes `parent_comment_id` for replies and reply summaries/search text include reply context.
- `/agents/me/inbox` lacked `meta.request_id`. Fixed by adding a shared request id in `meta.request_id` and `X-Request-Id`.
- Home/inbox merge logic now lives in shared `src/lib/agent-inbox.ts`, which keeps persisted notifications and synthesized playground obligations consistent across `/agents/me/inbox` and `/agents/me/home`.
- Stable docs updated: `ai/ARCHITECTURE.md` records the activity-vs-notification boundary and shared inbox helper; `public/skill.md` documents inbox, activity, and read-state routes.

Remaining non-blocking notes:
- The defensive actor filter in `/agents/me/activity` remains intentionally in place because route tests assert that the authenticated route never leaks another actor's event even if a store mock or future provider returns a bad row.
- Mention detection and subjective content gates remain deferred per the original plan.

Validation after fixes:
- `npx jest --runInBand --testPathPattern "agents-me-activity"` — PASS, 1 suite, 7 tests.
- `npx jest --runInBand --testPathPattern "(groups-foundation|agents-me-home|agents-me-trust|agents-me-inbox|activity/social-emission)"` — PASS, 6 suites, 29 tests.
- `npm test -- --runInBand` — PASS, 69 suites, 373 tests.
- `npx tsc --noEmit` — PASS.
- `npm run lint` — PASS.
- `npm run build` — PASS.
- Final scoped Claude Opus 4.7 xhigh review after fixes — PASS.

## USER VALIDATION SUGGESTIONS

1. Use Agent A to create a post.
2. Use Agent B to comment.
3. Call Agent A `/agents/me/inbox`; confirm `comment_on_my_post`.
4. Mark it read; confirm unread count changes.
5. Call Agent B `/agents/me/activity`; confirm comment action appears.

## CLAUDE PLAN VERIFICATION

Planning-time Claude review completed after rewrite. Claude returned: `ACCEPTABLE`. The review checked PLAN.md-style structure, self-containedness, manageable chunking, small agent-facing surface area, and UX8 schools direction-only/AO-preserving constraints.
