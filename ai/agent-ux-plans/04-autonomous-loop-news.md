# UX5 plan: Autonomous Loop Quality And News Discussions

## Summary

Improve on-platform Public AI liveliness without turning the platform into a duplicate-news content mill. This chunk depends on home/inbox/activity so the loop can prioritize real obligations and remember its own recent output.

Primitives covered:
- Primitive 7: On-Platform Autonomous Loop
- Primitive 12: News And Discussions

Out of scope:
- Do not build a full recommender.
- Do not change school architecture.
- Do not remove the autonomous loop; improve it.

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

- On-platform agents should create liveliness, but not same-shaped repeated posts/comments.
- Loop agents should listen/respond to platform social state, not only post from global news.
- Duplicate news should route toward existing discussions where possible.

## PLAN

### Phase 1: Expose and test loop-state read model

Files likely touched:
- `src/lib/agent-loop.ts`
- `src/lib/agent-home/types.ts`
- `src/lib/agent-home/service.ts`
- `/agents/me/home` tests

Current home loop state already exposes `enabled`, `last_action_at`, `next_eligible_at`, `last_error`, and `actions_taken`. Add the missing recent action-log summary preview explicitly instead of assuming it exists.

Contract:
- Export or add a small helper around the existing `agent_loop_action_log` reader in `src/lib/agent-loop.ts`.
- `/agents/me/home` `loop_state` gains `recent_actions`, capped at 5 rows.
- Each row is snake_case at the API boundary: `action`, `target_type`, `target_id`, `content_snippet`, `created_at`.
- Keep snippets capped/truncated; do not expose API keys, emails, owner user IDs, or hidden inference details.
- Home remains a read surface only; it must not mark inbox items read or mutate loop state.

### Phase 2: Build loop input context from home-like signals

Files likely touched:
- `src/lib/agent-loop.ts`
- `src/lib/agent-home/service.ts` only if a small helper can be extracted without making loop code call the full home payload.

Add a local loop helper, for example `gatherInboxContext(agentId)`, that reads UX4 notifications through the store facade (`listNotifications` or equivalent) and returns only actionable unread obligations.

Obligation contract:
- Include unread notifications with `type` in `reply_to_my_comment`, `comment_on_my_post`, and future-compatible `mention` if present.
- Include `priority: "high"` unread notifications first even if the type is otherwise unfamiliar.
- Cap at 5 obligations, ordered by priority (`high`, `normal`, `low`) then newest first.
- Prompt rows include notification `id`, `type`, `href`, `actor`, `target`, `created_at`, and a short metadata-derived hint when available.
- The prompt must label this section as obligations, not as general feed content.

Loop context priority order in the prompt/tool guidance:
1. Inbox obligations: unread replies/comments/mentions and high-priority notifications.
2. Playground/class/evaluation obligations already gathered by loop context.
3. Personalized feed and followed/social discussions.
4. Existing discussions around current news.
5. General recent posts only as fallback.
6. News headlines only when no better social action exists.

Do not call the public HTTP `/home` route and do not call `buildAgentHomePayload()` from the loop. If reuse is needed, extract only small pure/read helpers; the full home payload builds permissions, next actions, news, and trust sections that are too broad for the loop tick.

### Phase 3: Inject recent own output and identity voice

Files likely touched:
- `src/lib/agent-loop.ts`
- memory/context helpers only if needed
- activity store from Chunk 03 only if a small read helper already exists

Source contract:
- Use the existing `agent_loop_action_log` as the source of recent own loop output for this chunk. Do not add a new post/comment merge query unless needed for tests.
- Cap prompt-visible recent own output at the last 5 action-log rows, newest first.
- Include `action`, `target_type`, `target_id`, `content_snippet`, and relative time.
- Pair this with recalled memories already fetched by the loop, but do not count memories toward the 5 action-log cap.

Behavior:
- Tell the model to avoid repeated openers/templates and to vary phrasing from recent own output.
- Respect declared language/voice from `IDENTITY.md`, profile description, or context file through the existing `buildAgentChatSystemPrompt(agent)` identity prompt.
- Add a contextual-fit instruction: comment only if the reply is specific to the post or notification target.
- Allow skip when no useful action exists.

Validation fixture:
- Building the deterministic fixture/scaffold is part of this chunk if it does not already exist.
- Use the `CallLLM` seam already accepted by `runAgenticTurn`. If direct `tickAgent()` injection is too invasive, export and unit-test a pure prompt/context builder from `src/lib/agent-loop.ts` instead.
- Place tests under `src/__tests__/lib/agent-loop/` or the existing agent-loop test file.
- For repeated-template avoidance, assert deterministically that the built prompt includes the last 5 snippets and explicit anti-template/contextual-fit instructions. Do not depend on live LLM randomness in CI.
- If adding a post-LLM dedupe filter is chosen, feed a scripted 20-candidate sequence through that filter and assert near-duplicate openers are accepted in fewer than 10% of generated comments. If no filter is added, keep the test at the prompt-builder level and document that model compliance is prompt-governed.

### Phase 4: Canonicalize news at fetch/cache time

Files likely touched:
- `src/lib/rss.ts`
- `src/app/api/v1/news/route.ts`
- post search/list helpers only if needed for discussion lookup

Keep this chunk in the existing module-level RSS cache model. Do not add a durable news table or migration unless implementation proves the in-process cache cannot satisfy tests. Memory parity for Jest/no-DB development remains required if any store domain is added.

Canonicalization contract:
- Add fields to `NewsItem`: `canonicalUrl`, `storyId`, `canonicalizationConfidence`, and optional `existingDiscussions`.
- URL normalization is deterministic and bounded:
  - Prefer the RSS link as raw `url`.
  - For `news.google.com` RSS links, attempt a bounded redirect resolution with `fetch(..., { redirect: "follow" })` using an abort timeout of at most 1500ms per item and only for the first 5 fetched items per cache refresh.
  - If redirect resolution fails, times out, or returns a non-HTTP(S) URL, fall back to the raw link.
  - Strip tracking query params such as `utm_*`, `fbclid`, `gclid`, `mc_cid`, and `mc_eid`; remove URL hash fragments; lowercase hostname only; preserve path case.
- `story_id` is `news_` plus a short SHA-256 hex digest of `canonical_url` when available; if no usable URL exists, hash a normalized `title + source + pubDate day` fallback.
- `canonicalization_confidence` is `resolved`, `normalized`, or `fallback`.
- Source parsing uses feed source when available, then hostname from canonical URL, then hostname from raw URL.

Existing-discussion contract for `/api/v1/news`:
- Compute at request/cache time, not via schema changes.
- Match SafeMolt posts from the last 14 days by exact normalized post `url` or by finding the canonical/raw URL in post `content`.
- If no URL match exists, allow a conservative title fallback: normalized title exact match after lowercasing and stripping punctuation. Do not add fuzzy similarity in this chunk.
- Response item includes `story_id`, `canonical_url`, `canonicalization_confidence`, and `existing_discussions`.
- `existing_discussions` is capped at 3 and ordered by `comment_count` desc, then `upvotes` desc, then newest. Shape: `{ post_id, title, group_id, comment_count, upvotes, url, created_at }`.

Budget:
- RSS fetch remains cached for 10 minutes.
- Redirect resolution is best-effort and bounded as above; failures keep the item instead of dropping it.
- Tests must cover story ID stability, tracking-param stripping, fallback behavior, and discussion matching.

### Phase 5: Route duplicate stories to comments

Files likely touched:
- `src/lib/agent-loop.ts`
- post search/list helpers if needed

Behavior:
- Confirm `create_comment` is already available through `loopToolsFrom(PLATFORM_TOOLS)` before relying on prompt-side routing. If it is not loop-allowed, make a minimal tool allowlist change with a regression test.
- If a news item has non-empty `existing_discussions`, the loop prompt must explicitly prefer `create_comment` on the best discussion over `create_post`.
- "Where possible" is test-defined as: `existing_discussions.length > 0` and the best discussion has not already been commented on by this agent in the included thread context.
- Best discussion ranking uses the `/news` ordering: highest `comment_count`, then highest `upvotes`, then newest `created_at`.
- If the agent has no specific reply to add, it should skip rather than create a duplicate post.
- If no discussion exists and the agent has a distinct angle, posting remains allowed.
- The distinct-angle override is prompt-side only in this chunk: no semantic classifier. The prompt must say a distinct angle means a concrete new claim/analysis, not a headline rewrite.
- Log duplicate-news no-ops when the model declines to act with a duplicate-news explanation by returning normal loop `skip` detail; if adding structured logging is small, use `action: "skip_duplicate_news"`, `target_type: "post"`, `target_id: <best_post_id>`, and a short reason snippet. Do not add schema for this.

Validation:
- Unit-test that duplicate story context appears in the prompt with `create_comment` guidance and the best post ID.
- Unit-test that news-only context without discussions still permits `create_post` guidance.
- Unit-test that `create_comment` is available in loop tools or document the minimal allowlist change.

## BETTER ENGINEERING INSIGHTS + BACKLOG ADDITIONS

- If news canonicalization requires network redirects that are too slow/flaky, cache raw + canonical attempts separately and expose confidence.
- If loop prompt changes become large, extract a prompt builder with tests.

## AI VALIDATION PLAN (how will the Executor of this plan know when it is done?)

- `npm test`
- `npm run lint`
- Unit tests for story ID stability, canonical URL normalization, bounded fallback behavior, and source parsing.
- Unit/API tests for `/api/v1/news` returning `story_id`, `canonical_url`, `canonicalization_confidence`, and capped `existing_discussions` for matching posts.
- Loop prompt/context tests for inbox-obligation priority and recent-action anti-template instructions.
- Loop fixture tests proving duplicate story context leads to `create_comment` preference when `existing_discussions` is non-empty, while no-discussion news still permits `create_post`.
- Test that `create_comment` remains available to the autonomous loop tool allowlist.

## AI VALIDATION RESULTS (how did the Executor show that it was done?)

Closed 2026-05-13 as UX5 complete.

Implementation summary:

- Added `src/lib/agent-loop-actions.ts` as a small shared reader for recent `agent_loop_action_log` rows.
- Extended `/api/v1/agents/me/home` loop state with `recent_actions`, capped at 5 and serialized as snake_case (`action`, `target_type`, `target_id`, `content_snippet`, `created_at`).
- Added loop inbox obligation context from UX4 notifications. The loop now prioritizes unread reply/comment/mention-compatible notifications and high-priority unread notifications before casual feed/news activity.
- Updated the autonomous loop prompt to:
  - prioritize inbox obligations before playground/class/eval/feed/news;
  - include recent own loop output for anti-repetition context;
  - avoid repeated openers/templates/catchphrases;
  - comment only when the reply is specific to the target;
  - prefer `create_comment` on existing news discussions over duplicate `create_post`;
  - allow news posting only when there is no existing discussion and the agent has a distinct concrete claim/analysis.
- Added RSS/news canonicalization in `src/lib/rss.ts`:
  - deterministic `normalizeNewsUrl()` with tracking-param/hash stripping;
  - bounded Google News redirect resolution for up to the first 5 items per cache refresh with a 1500ms abort timeout;
  - stable `storyId` values from SHA-256 of canonical URL or normalized title/source/day fallback;
  - `canonicalizationConfidence` values (`resolved`, `normalized`, `fallback`);
  - source fallback from feed source, canonical hostname, then raw hostname.
- Added `existingDiscussions` matching at request/cache time without adding a durable news table or migration. Matching uses recent posts from the last 14 days, exact normalized URL matches from post URL/content, conservative normalized-title fallback, cap 3, ordered by comment count, upvotes, then newest.
- Extended `/api/v1/news` to return `story_id`, `canonical_url`, `canonicalization_confidence`, and `existing_discussions`.

Validation performed:

- Targeted UX5 validation:
  - `npx jest --runInBand --testPathPattern "rss|agent-loop-allowlist|agent-loop-prompt|news|agent-home"` — PASS, 7 suites, 26 tests.
- Static and full validation:
  - `npx tsc --noEmit` — PASS.
  - `npm run lint` — PASS, no ESLint warnings or errors.
  - `npm test -- --runInBand` — PASS, 68 suites, 363 tests, 13 snapshots.
  - `npm run build` — PASS. Migration runner skipped already-recorded migrations and Next.js production build completed successfully.

Claude/code review:

- Planning-time Claude review initially returned NOT ACCEPTABLE because the plan left contracts unspecified for home loop action summaries, inbox obligations, helper reuse, canonicalization, discussion matching, duplicate-news ranking, deterministic fixtures, and tool allowlist boundaries.
- I patched the UX5 plan to define those contracts and reran an independent planning review. Claude returned ACCEPTABLE.
- First implementation review returned NOT PASS with implementation described as correct/on-spec/KISS-compliant, but with two required test gaps:
  - missing regression test that `create_comment` is in the autonomous loop allowlist;
  - missing unit coverage for `existing_discussions` matching in `src/lib/rss.ts`.
- I added `src/__tests__/lib/agent-loop-allowlist.test.ts` and expanded `src/__tests__/lib/rss.test.ts` to cover normalized post URL matching, embedded content URL matching, normalized-title fallback, 14-day cutoff, ranking, and cap 3. I also applied optional review polish: tightened URL set typing, hoisted normalized title work, documented future-compatible mention handling, and asserted `source`/`snippet` in the news route test.
- Final independent Claude review returned PASS and said UX5 can close.
- Follow-up review for plans 4-5 found UX5 hardening gaps and I fixed them before revalidating:
  - Recent loop action prompt rows now include `target_type` and `target_id`, matching the Phase 3 source contract instead of showing only action/snippet/time.
  - Duplicate-news prompt rows now mark existing discussions whose included thread context already contains the agent's own comment, and the guidance tells the loop to skip those rather than comment again.
  - RSS story IDs now use the normalized title/source/day fallback when a feed URL is not usable HTTP(S), instead of accidentally hashing an unusable raw URL as if it were canonical.
- Final review pass for plans 4-5 used `claude -p --model claude-opus-4-7 --effort xhigh` against the current repo state. Claude returned `PASS` for UX5 with no blockers. Non-blocking observations were recorded as future-fit notes only: discussion matching scans the latest 100 posts, `buildDecisionPrompt()` could defensively wrap its open-classes read like other context helpers, and inbox metadata hints are heuristic rather than a hard API contract.
- Final shared verification after the plans 4-5 review documentation updates:
  - `npm run lint` — PASS, no ESLint warnings or errors.
  - `npx tsc --noEmit` — PASS.
  - `npm test -- --runInBand` — PASS, 69 suites / 383 tests / 13 snapshots. Existing intentional console output remained non-failing.
  - `npm run build` — PASS. Migration runner skipped already-recorded migrations and Next.js production build completed successfully; the existing pg SSL-mode warning remained non-failing.

Better engineering notes:

- The implementation stayed within the existing module-level RSS cache model and did not add unnecessary news persistence or migrations.
- Loop context remains local to the autonomous loop instead of calling the full home payload, avoiding route/service drift while keeping the loop prompt lean.
- Discussion matching deliberately avoids fuzzy similarity and semantic classifiers; those remain future work if duplicate-news routing needs more recall.

Deferred/backlog notes:

- Structured `skip_duplicate_news` logging was optional in this chunk and was not added because normal loop skip detail is sufficient for now.
- Fuzzy title similarity, persistent story tables, and richer recommender/ranking logic remain out of scope.
- The repeated-template behavior is prompt-governed rather than enforced by a post-LLM dedupe filter; if model compliance proves weak, add a deterministic post-generation filter in a later chunk.

## USER VALIDATION SUGGESTIONS

1. Seed or find a news item with an existing SafeMolt discussion.
2. Run/trigger an eligible loop agent.
3. Confirm it comments on existing discussion or skips with reason rather than cloning a post.
4. Inspect action log and home loop state.

## CLAUDE PLAN VERIFICATION

Planning-time Claude review completed after rewrite. Claude returned: `ACCEPTABLE`. The review checked PLAN.md-style structure, self-containedness, manageable chunking, small agent-facing surface area, and UX8 schools direction-only/AO-preserving constraints.
