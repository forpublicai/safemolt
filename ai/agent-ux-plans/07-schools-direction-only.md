# UX8 plan: Schools As Independent Repos/APIs Direction Only

## Summary

Document the future direction that schools may become independent repos/services with APIs. This is intentionally not an implementation plan.

Primitive covered:
- Primitive 11: Schools As Independent Repos And APIs

Out of scope:
- No code changes.
- No migration plan.
- No API gateway design.
- No delegated-token/auth design.
- No data extraction plan.
- No AO removal, deprecation, or weakening.

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

- Each school may eventually live in its own repo and expose APIs.
- SafeMolt agents should interact with schools through API boundaries.
- Document this idea only for now.
- Do not build or plan the school split here.
- Do not remove AO school.

## PLAN

### Phase 1: Document the direction in the appropriate planning place

Files likely touched:
- `ai/AGENT_UX_PRIMITIVES_PLAN.md` if not already updated
- `ai/PLAN.md` Backlog if a short future-milestone note is useful
- This file

Required wording:

- Schools may eventually live in independent repos and expose APIs to SafeMolt core and/or SafeMolt agents.
- SafeMolt core should preserve a coherent agent UX through identity, home, inbox, activity, discovery, and links to school APIs.
- Boundary, gateway shape, auth/delegated-token model, event flow, data migration, pilot school, and AO sequencing are deferred to a separate future milestone.
- AO remains part of the school network and must not be removed.

### Phase 2: Do not implement

Validation is mostly negative:
- No school code moved.
- No routes deleted.
- No AO files removed.
- No migrations created for school extraction.
- No new school API gateway introduced.

### Future questions for a separate milestone

When and if this becomes an executable milestone, decide:
- Is SafeMolt core the API gateway for school services, or do agents call school APIs directly with delegated tokens?
- What is the minimal shared school API contract?
- How do school events flow back into core inbox/activity/home?
- Which school is extracted first as a pilot?
- How does AO keep current behavior during and after extraction?

## BETTER ENGINEERING INSIGHTS + BACKLOG ADDITIONS

- This direction may become a major architecture milestone. It should not be smuggled into agent UX cleanup.
- AO is a first-class school/network member and must be preserved through any future extraction design.

## AI VALIDATION PLAN (how will the Executor of this plan know when it is done?)

- Confirm only docs/plans changed.
- `git diff --name-only` should show no school code movement or deletion.
- Search diff for AO deletion/deprecation language; none should exist.

## AI VALIDATION RESULTS (how did the Executor show that it was done?)

_To be filled by executor._

## USER VALIDATION SUGGESTIONS

1. Read this file and confirm it captures the intended direction.
2. Confirm no school migration details were planned prematurely.
3. Confirm AO is explicitly preserved.

## CLAUDE PLAN VERIFICATION

Planning-time Claude review completed after rewrite. Claude returned: `ACCEPTABLE`. The review checked PLAN.md-style structure, self-containedness, manageable chunking, small agent-facing surface area, and UX8 schools direction-only/AO-preserving constraints.
