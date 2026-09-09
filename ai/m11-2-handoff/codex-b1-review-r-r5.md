# Codex review ROUND 5 — M11b wave b-1, lane R (P6.2 reactions)

Rounds 1–4 found the items in `ai/m11-2-handoff/codex-findings-b1-r-round{1,2,3,4}.md`; every accepted one was fixed per `ai/m11-2-handoff/b1-r-fix-r{1,2,3,4}-spec.md`, and the fix reports `ai/m11-2-handoff/b1-r-fix-r{1,2,3,4}-report.md` records the change, the test and the mutation-check for each. Start from scratch on the current tree: re-examine the whole lane from fundamentals, then ADJUDICATE the recorded deferrals explicitly (uphold or overturn, with a concrete harm).

You are reviewing ONE lane of the SafeMolt M11b milestone on branch `ops/code-improve`, working
tree at /Users/mohsin/Github/safemolt. Read-only sandbox. Do NOT run jest, tsc, next build or any
npm script: the sandbox denies the temp writes and the attempt can kill your session. Gate results
are stated below; trust them.

## What to read first
- `CLAUDE.md` § "Store and Migration Invariants" (the pinned rules: event coupling, token-fenced
  writes, FOR SHARE liveness locks, per-event substitutions, memory-mode re-checks).
- The plan section: `ai/PLAN_M11_2.md` lines 349–351 (P6.2).
- The lane spec: `ai/m11-2-handoff/b1-lane-r-reactions-spec.md` and the lane report
  `ai/m11-2-handoff/b1-lane-r-report.md`.
- The change: `git show --stat d86788d d5b0627 65fc47e 6aebbfa 0b0e848 FIX4_COMMIT` (the b-1 commits and the four fix commits; review ONLY the files listed under "Files in scope") then read those files from the working tree.

## Gate results (already run by the orchestrator)
- `npx tsc --noEmit`: clean. `npm run lint`: 0 errors. Jest: reactions-memory 9, reactions-routes 16, events/karma-writer/group-school-gate/boundary suites green.
  Integration: m11-2-b1-reactions.test.ts 8/8 green on the reserved Neon DB.

## Focus (rank findings BLOCKER / MAJOR / MINOR / NIT, with file:line and a concrete failure scenario)
1. Atomicity: is every event gated on its decisive mutation's RETURNING, in ONE statement/batch?
2. Locks: liveness checks are FOR SHARE / FOR KEY SHARE locks, never bare EXISTS; lock order is
   posts → comments → agents; no FOR UPDATE where a FK's FOR KEY SHARE would deadlock it.
3. Token fencing: every writer that runs after a claim carries the claim token.
4. Memory-mode parity: the memory twin refuses exactly what Postgres refuses (actor/subject
   re-check after every await), preflights events before any write.
5. Security/privacy: the subject is locked FOR KEY SHARE on its live row inside the statement; the daily cap has ONE writer of agent_rate_limits (the lane found and fixed a lost second-writer CTE — verify the fix is the documented Postgres rule, not a workaround); duplicate charges nothing and emits nothing; deletePost removes post AND comment reactions in the same transaction; removeReaction uncapped..
6. KISS / bloat: name any abstraction, option, comment essay, or duplicated helper that the plan
   does not require. The user wants LESS code, not more.
7. Test honesty: does each plan gate have a test that would fail if the behavior were removed?

## Known, recorded decisions — do NOT re-flag
- The plan's `none` wakeup channel is not materialized (`resolveWakeupDelivery` returns null).
- `createOrReArmWakeup`'s false/false race outcome is legitimate (ledger item 8).
- TA class messages emit (ledger item 6). Actionable-only admissions projection (item 7).
- Public docs and the inventory are updated at the wave boundary by the orchestrator, not per lane.
- already_reacted wins over rate_limited when both hold (lane R refinement, recorded).
- About-timeline reactions stay a separate, exempted surface (backlog).
- The reactions migration is deliberately NOT in REQUIRED_MIGRATIONS unless the stitch added it for the runner tools.

## Output
A findings list ordered by severity, each with: severity, file:line, the invariant or plan line it
violates, a concrete failure scenario, and the minimal fix. End with a one-line verdict:
"CONVERGED" if there is no BLOCKER or MAJOR, otherwise "NOT CONVERGED".

## Files in scope
scripts/migrate-m11-reactions.sql; src/lib/store/reactions/{db,memory,index}.ts; src/lib/actions/reactions.ts;
src/app/api/v1/posts/[id]/reactions/route.ts; src/app/api/v1/comments/[id]/reactions/route.ts;
src/lib/agent-tools/definitions/reactions.ts; src/lib/agent-runtime/index.ts (tool routing); the deletePost function in
src/lib/store/posts/{db,memory}.ts; the reaction.* entries in kinds.ts / coverage.ts / store-types.ts / consumers/notifications.ts;
src/lib/store/notifications/* (createReactionAddedNotificationIdempotent only); the `reactions` field in the post/comment
serializers (src/app/api/v1/{posts,feed,search}/…, groups/[name]/feed, agents/profile, agent-tools/definitions/{posts,comments}.ts);
tests: src/__tests__/lib/store/reactions-memory.test.ts, src/__tests__/api/reactions-routes.test.ts,
src/__tests__/integration/m11-2-b1-reactions.test.ts.
