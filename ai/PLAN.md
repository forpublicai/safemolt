## SAFEMOLT

safemolt is agentic platform for A2A evaluations, experimentation and development.


## HOW TO PLAN A MILESTONE

If the user asks you to plan a milestone, these are the steps to take.

1. Read all of PLAN.md (the current document) to learn about the milestone, in the context of past and future milestones. This document lists only the bare essential deliverables and validation steps for each milestone.
2. Read all prior PLAN_M{n}.md milestone documents as well
3. Ask any important initial clarifying questions about the milestone you might have.
  - If you're not asking any questions at all for the entire planning, something's wrong! I know that this file isn't fully specified. There must be important things for you to clarify.
  - It's better to eliminate unknowns in the milestone by discovering facts, not by asking the user. Do not ask questions that can be answered from the repo or system (for example, "where is this struct?" or "which UI component should we use?" when exploration can make it clear). Only ask once you have exhausted reasonable research.
     - **Discoverable facts** (repo/system truth): explore first: Before asking, run targeted searches and check likely sources of truth (configs/manifests/entrypoints/schemas/types/constants). Ask only if: multiple plausible candidates; nothing found but you need a missing identifier/context; or ambiguity is actually product intent. If asking, present concrete candidates (paths/service names) + recommend one.Never ask questions you can answer from your environment (e.g., "where is this struct").
    - **Preferences/tradeoffs** (not discoverable): ask early. These are intent or implementation preferences that cannot be derived from exploration. Provide 2–4 mutually exclusive options + a recommended default. If unanswered, proceed with the recommended option and record it as an assumption in the final plan.
  - When you ask a question, the user doesn't have your context. You must phrase your questions so as to include FULL context, tradeoffs, background, explanation of terms. Don't use jargon. A good question is typically 2-5 sentences long.
  - Questions should where possible offer multiple choices, and your recommendation.
  - Questions should be meaningful; don't include filler choices that are obviously wrong or irrelevant.
  - You SHOULD ask many questions, but each question must: materially change the spec/plan, OR confirm/lock an assumption, OR choose between meaningful tradeoffs. And it must not be answerable by research.
  - Keep asking until you can clearly state: goal + success criteria, audience, in/out of scope, constraints, current state, and the key preferences/tradeoffs.
  - Bias toward questions over guessing: if any high-impact ambiguity remains, do NOT plan yet—ask.
  - Once intent is stable, proceed with implementation planning...
  - Once intent is stable, keep asking until the spec is decision complete: approach, interfaces (APIs/schemas/I/O), data flow, edge cases/failure modes, testing + acceptance criteria, rollout/monitoring, and any migrations/compat constraints.
4. Research milestone-relevant aspects of how `codex app-server` works and how to use it. These are your resources:
   - Read the official documentation for `codex app-server` at fbsource/third-party/codex/main/codex-rs/app-server/README.md
   - Read the official client at fbsource/third-party/codex/main/codex-rs/app-server-test-client/README.md
   - Read as needed the source code implementation of `codex app-server` should we have questions about how it works, at fbsource/third-party/codex/main/codex-rs/app-server
   - Reverse-engineer as needed OpenAI's Codex extension for VSCode, should we have questions about how they use `codex app-server`. The extension is stored in vsix/vsix.extension.js (for their extension) and vsix/vsix.index.js (for their webview). A user can download a fresh version by running scripts/fetch_vsix.sh (but an AI can't due to sandbox internet restructions).
5. Research milestone-relevant aspects of how ClaudeMode does the work, starting from xplat/vscode/modules/dvsc-core/src/extension-host/casdk/ClaudeAgent.ts
6. Flesh out the milestone deliverables and validation steps as needed, if any are missing
   - You should have a focus on validation in everything you do.
   - The validation steps should be about how someone who implements this milestone can validate that their implementation is good
   - I outlined a few tentative validation steps for each milestone, but they're weak, and I expect you to find better validation for each milestone.
   - Make sure to include the basics: typechecker clean and `arc lint` clean
7. Develop your plan for the milestone and write it to a new PLAN_M{n}.md file.
   - A great plan is very detailed—intent- and implementation-wise—so that it can be handed to another engineer or agent to be implemented right away. It must be **decision complete**, where the implementer does not need to make any decisions. It must be **self-contained**: the implementor will know nothing of your research other than what's in your PLAN_M{n}.md file.
   - The plan must include validation steps, i.e. how someone implementing the plan will validate that they've done so well.
8. Are there better-engineering blockers? If so, bail!
   - The user always wants things done the right way, with clean engineering, good architecture. Never any shortcuts. It's normal that your plan work discovers a structural architectural problem that must be fixed before your plan can proceed.
   - If the architectural problem is small enough to solve, then include that as a phase in your plan. But if it's a major one, worthy of a whole separate plan in its own right, then you should bail, tell the user the problem, and leave them to insert a new milestone specifically for that better engineering.
   - The user is always delighted to hear about better engineering.
9. Present your PLAN_M{n}.md file to Claude and ask for its feedback.
   - If you couldn't get Claude to run for whatever reason, the user wants you to abort and report what's wrong.
   - You can trust Claude has already read AGENTS.md, and is able to do its own autonomous research.
   - If Claude found no problems with your plan, you may proceed.
   - Otherwise, you must address the issues Claude found: (1) if you agree with the issues, then update your plan, (2) if you disagree with Claude's findings, then update your plan to defend your perspective better.
   - Keep iterating with Claude until you no longer make changes (either because you've taken on Claude's feedback from past rounds, or because your plan no successfully defends its positions so Claude accepts them). However, if you take more than 10 rounds, then somethig is wrong, so stop and let the user know.
   - We aren't looking for "blocker vs non-blocker" decisions. Instead for every suggestion from Claude you must evaluate "will this improve my plan? if so then modify your plan, and if not then pre-emptively defend (in the plan) why not". And if you made modifications or defenses, then circle back with Claude again.
   - Do NOT reference previous rounds when you invoke it: Claude does best if starting from scratch each round, so it can re-examine the whole ask from fundamentals. Note that each time you invoke Claude it has no memory of previous invocations, which is good and will help this goal! Also, avoid asking it something like "please review the updated files" since (1) you should not reference previous rounds implicitly or explicitly, (2) it has no understanding of what the updates were; it only knows about the current state of files+repo on disk.
10. Ask the user any further important clarifying questions you have that arose as a result of your research and Claude-review.
   - Please postpone these questions until the end, after research and Claude-review. That way you will be able to do as much planning as possible without being slowed down by me.
   - Every course-correction the user gives you will likely represent a gap that should be added to LEARNINGS.md or ARCHITECTURE.md. And similarly for many clarifying questions. Please update with these learnings. The goal is so that, if you're asked to develop a plan in future, you won't even need to ask.
   - Please be careful to follow the "learnings decision tree" -- LEARNINGS.md for durable engineering wisdom, ARCHITECTURE.md for things that will apply to CodexAgent.ts in its finished state, PLAN_M{n}.md for milestone-specific notes
11. Present the plan for user review and signoff.
   - First, double-check that it is a completely self-contained handoff document.

Please use the following format for your PLAN_M{n}.md files:
```
# M{n} plan: {title}

## Summary
{brief summary of deliverables+validation for this milestone from PLAN.md, augmented as you see fit}

## HOW TO EXECUTE A MILESTONE
{please include verbatim the content of "how to execute" section of PLAN.md, for the benefit of readers who will read PLAN_M{n}.md but won't read PLAN.md itself

## Locked user decisions
{write out all the decisions that the user made}

## PLAN
{... your plan goes here, in whatever format you see fit. You might include API, algorithms, files changed, testing}

## BETTER ENGINEERING INSIGHTS + BACKLOG ADDITIONS
{what architectural insights you learned, about our codebase or about how things should be done, plus what better engineering has been deferred or will be needed in future}

## AI VALIDATION PLAN (how will the Executor of this plan know when it is done?)
{... what AI will do to validate its work, the "definition of done". This may include typechecking it, running it, running unit and integration tests, creating new tests}

## AI VALIDATION RESULTS (how did the Executor show that it was done?)
{this will be filled during execution}

## USER VALIDATION SUGGESTIONS
{A walkthrough of steps the user can follow, so they can see what you have built}
```

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
