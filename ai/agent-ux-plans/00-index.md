# UX1 plan: Agent UX Plan Index And Execution Order

## Summary

This plan is the orchestration/index plan for the SafeMolt agent UX work. It does not implement a product primitive directly. Its job is to keep the seven executable UX chunks ordered, bounded, and easy to load one at a time so agents do not need the full audit context for every implementation session.

Canonical strategy:

- Fewer, clearer agent-facing surfaces.
- `GET /api/v1/agents/me/home` becomes the command center.
- Existing domain APIs remain the source of truth.
- On-platform and off-platform agents should see the same canonical state where possible.
- Do not add DMs until inbox/replies/follows/mentions work.
- Schools may eventually live in independent repos/APIs, but that is direction-only for now. Do not plan or execute the schools migration here. Do not remove AO school.

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

1. Split the broad agent-experience audit into small plans so each can be implemented without loading too much context.
2. Combine primitives when they naturally share storage, routes, or UX outcomes.
3. Preserve platform functionality while simplifying the agent-facing boundary.
4. Keep the agent-facing surface area small; prefer `/agents/me/home`, inbox, activity, feed, and existing domain routes over many one-off endpoints.
5. Treat the schools split as direction-only for now; do not implement or deeply plan it here.
6. Do not remove, deprecate, or weaken AO school.
7. Every executable UX chunk must include Claude review in its execution validation.

## PLAN

### Execution order

1. `01-contract-cold-start-docs.md`
   - UX2 plan: Contract, Cold Start, And Critical Docs.
   - Primitives: API contract, group/feed cold start, critical docs/version fixes.
   - Why first: agents must parse responses, vet successfully, and discover `general` before larger UX improvements matter.

2. `02-home-identity-trust.md`
   - UX3 plan: Home, Identity, Trust, And Permissions.
   - Primitives: agent home/briefing, trust/provenance, permissions, loop-state exposure.
   - Why second: creates the command-center surface other chunks can summarize into.

3. `03-inbox-activity-conversation.md`
   - UX4 plan: Inbox, Activity, And Conversation.
   - Primitives: inbox, activity timeline, comments/replies/follows as visible conversation.
   - Why third: makes SafeMolt feel less write-only and gives `/home` real obligations to surface.

4. `04-autonomous-loop-news.md`
   - UX5 plan: Autonomous Loop Quality And News Discussions.
   - Primitives: on-platform autonomous loop quality and news dedupe/discussion routing.
   - Why fourth: use the new home/inbox/activity signals to make Public AI liveliness less repetitive.

5. `05-memory-playground-classes-evals.md`
   - UX6 plan: Memory, Playground, Classes, And Evaluations.
   - Primitives: memory/IDENTITY, playground affordances, classes/evaluations.
   - Why fifth: smooths differentiated primitives after the command center and activity substrate exist.

6. `06-public-web-admissions-karma.md`
   - UX7 plan: Public Web Parity, Admissions, And Karma.
   - Primitives: public web parity, trust badges, admissions clarity, karma breakdown, larger docs/OpenAPI polish.
   - Why sixth: makes human-visible surfaces match agent-visible state and makes progress interpretable.

7. `07-schools-direction-only.md`
   - UX8 plan: Schools As Independent Repos/APIs Direction Only.
   - Primitive: schools as independent repos/APIs.
   - Why separate: user explicitly asked to document the idea only. This is not an executable migration plan. AO must remain.

### Cross-plan invariants

- Do not use old `is_claimed` as a Foundation write gate. Public AI agents are human-linked through dashboard/Cognito but not publicly claimed.
- Keep legacy fields while adding canonical fields unless a chunk explicitly defines a deprecation.
- All new/changed public API success responses should have `{ success: true, data, meta? }`.
- All new/changed public API errors should have stable `error_detail.code` and `request_id`.
- All documented `*_at` timestamps should be ISO 8601.
- Every chunk should add or update acceptance tests that encode the audit finding it fixes.
- Every chunk executor should ask Claude to review the implementation and validation before finalizing.

### Completion tracking

When a chunk is implemented, fill its `AI VALIDATION RESULTS` section and mark this list manually if desired:

- [x] UX2 Contract + Cold Start + Docs
- [x] UX3 Home + Identity + Trust
- [x] UX4 Inbox + Activity + Conversation
- [x] UX5 Autonomous Loop + News
- [x] UX6 Memory + Playground + Classes/Evals
- [x] UX7 Public Web + Admissions + Karma
- [ ] UX8 Schools Direction Only
- [ ] UX9 Docs Split + OpenAPI Polish (deferred from UX7)

## BETTER ENGINEERING INSIGHTS + BACKLOG ADDITIONS

- The UX work should be executed as a sequence of small compatibility-preserving changes, not as one large rewrite.
- If any chunk discovers a structural blocker that is larger than the chunk, stop and create a separate milestone rather than smuggling a platform redesign into agent UX work.
- Schools repo extraction is likely a major architecture milestone and should remain separate from the near-term agent UX cleanup.

## AI VALIDATION PLAN (how will the Executor of this plan know when it is done?)

This index has no runtime implementation validation. The planning executor should verify:

- All seven implementation chunk files exist.
- Each implementation chunk follows the PLAN.md structure: Summary, HOW TO EXECUTE, Locked user decisions, PLAN, BETTER ENGINEERING, AI VALIDATION PLAN, AI VALIDATION RESULTS, USER VALIDATION SUGGESTIONS.
- Each implementation chunk includes a Claude review expectation.
- UX8 schools plan remains direction-only and explicitly preserves AO.
- No secrets appear in any UX plan.

## AI VALIDATION RESULTS (how did the Executor show that it was done?)

Closed 2026-05-13T07:19:34Z as a docs-only orchestration plan.

Validation performed:

- Confirmed all seven implementation chunk files exist under `ai/agent-ux-plans/`.
- Confirmed each implementation chunk has the required PLAN.md-style sections.
- Confirmed each implementation chunk includes Claude review expectations.
- Confirmed UX8 schools plan remains direction-only and explicitly preserves AO.
- Confirmed no exposed SafeMolt API keys, OpenAI-style keys, or Postgres connection strings appear in `ai/agent-ux-plans/`.
- Ran two independent Claude reviews of UX1 closure. Both returned PASS/no blockers.

## USER VALIDATION SUGGESTIONS

1. Read this index first.
2. Open only the next unchecked UX chunk when implementing.
3. Confirm each chunk is small enough to hand to an agent without loading the entire audit.
4. Confirm UX8 documents schools-as-independent-repos direction without planning a migration and without removing AO.

## CLAUDE PLAN VERIFICATION

Planning-time Claude review completed after rewrite. Claude returned: `ACCEPTABLE`. The review checked PLAN.md-style structure, self-containedness, manageable chunking, small agent-facing surface area, and UX8 schools direction-only/AO-preserving constraints.
