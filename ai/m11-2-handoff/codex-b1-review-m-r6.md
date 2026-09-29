# Codex review ROUND 6 — M11b wave b-1, lane M (P6.1 mentions + P6.4 presence + P6.5 hot decay)

Rounds 1–5 found the items in `ai/m11-2-handoff/codex-findings-b1-m-round{1,2,3,4,5}.md`; every accepted one was fixed per `ai/m11-2-handoff/b1-m-fix-r{1,2,3,4,5}-spec.md`, and the fix reports `ai/m11-2-handoff/b1-m-fix-r{1,2,3,4,5}-report.md` records the change, the test and the mutation-check for each. Start from scratch on the current tree: re-examine the whole lane from fundamentals, then ADJUDICATE the recorded deferrals explicitly (uphold or overturn, with a concrete harm).

You are reviewing ONE lane of the SafeMolt M11b milestone on branch `ops/code-improve`, working
tree at /Users/mohsin/Github/safemolt. Read-only sandbox. Do NOT run jest, tsc, next build or any
npm script: the sandbox denies the temp writes and the attempt can kill your session. Gate results
are stated below; trust them.

## What to read first
- `CLAUDE.md` § "Store and Migration Invariants" (the pinned rules: event coupling, token-fenced
  writes, FOR SHARE liveness locks, per-event substitutions, memory-mode re-checks).
- The plan section: `ai/PLAN_M11_2.md` lines 343–347 (P6.1), 381–383 (P6.4), 385–389 (P6.5), and line 296 (the mention-suppression sentence).
- The lane spec: `ai/m11-2-handoff/b1-lane-m-mentions-presence-hot-spec.md` and the lane report
  `ai/m11-2-handoff/b1-lane-m-report.md`.
- The change: `git show --stat d86788d d5b0627 65fc47e 6aebbfa 0b0e848 432ab1b bdd5d62` (the b-1 commits and the five fix commits; review ONLY the files listed under "Files in scope") then read those files from the working tree.

## Gate results (already run by the orchestrator)
- `npx tsc --noEmit`: clean. `npm run lint`: 0 errors. Jest: hot-score, presence, mentions, mentions-e2e, actions, events suites green.
  Integration: m11-2-b1-mentions.test.ts 4/4 green on the reserved Neon DB.

## Focus (rank findings BLOCKER / MAJOR / MINOR / NIT, with file:line and a concrete failure scenario)
1. Atomicity: is every event gated on its decisive mutation's RETURNING, in ONE statement/batch?
2. Locks: liveness checks are FOR SHARE / FOR KEY SHARE locks, never bare EXISTS; lock order is
   posts → comments → agents; no FOR UPDATE where a FK's FOR KEY SHARE would deadlock it.
3. Token fencing: every writer that runs after a claim carries the claim token.
4. Memory-mode parity: the memory twin refuses exactly what Postgres refuses (actor/subject
   re-check after every await), preflights events before any write.
5. Security/privacy: the derived agent.mentioned events sit in the SAME statement as the content write with the store-filled source_id (per-event overrides, never a whole-list substitution); comment-source suppression derives from the comment ROW; hidden agents never notified; registration grammar enforced with bad_request; no raw last_active_at timestamp added to a public payload; hot-score parity between SQL and TS on a shared bound $now..
6. KISS / bloat: name any abstraction, option, comment essay, or duplicated helper that the plan
   does not require. The user wants LESS code, not more.
7. Test honesty: does each plan gate have a test that would fail if the behavior were removed?

## Known, recorded decisions — do NOT re-flag
- The plan's `none` wakeup channel is not materialized (`resolveWakeupDelivery` returns null).
- `createOrReArmWakeup`'s false/false race outcome is legitimate (ledger item 8).
- TA class messages emit (ledger item 6). Actionable-only admissions projection (item 7).
- Public docs and the inventory are updated at the wave boundary by the orchestrator, not per lane.
- The plan's `none` wakeup channel remains unmaterialized. The profile route's pre-existing raw `last_active` field is out of this lane's scope (recorded).
- `meta.deprecations` stays in the registration response as an always-empty list (Decision 11).

## Output
A findings list ordered by severity, each with: severity, file:line, the invariant or plan line it
violates, a concrete failure scenario, and the minimal fix. End with a one-line verdict:
"CONVERGED" if there is no BLOCKER or MAJOR, otherwise "NOT CONVERGED".

## Files in scope
src/lib/store/hot-score.ts; src/lib/mentions.ts; src/lib/actions/{posts,comments,agents}.ts;
src/lib/store/posts/{db,memory}.ts (createPost + the hot sorts; NOT deletePost); src/lib/store/comments/{db,memory}.ts;
src/lib/store/groups/{db,memory}.ts (listFeed hot sort); src/lib/store/agents/{db,memory,index}.ts
(listAgentsByNamesCaseInsensitive, countActiveNowFollowees, the deleted lastActiveAt branch);
src/lib/agent-public.ts; src/lib/agent-senses/{network,inbox,types}.ts; src/app/api/v1/agents/route.ts;
src/app/api/v1/feed/route.ts; the agent.mentioned entries in kinds.ts / coverage.ts / store-types.ts /
consumers/notifications.ts / consumers/wakeup-router.ts; src/lib/store/notifications/* (createMentionNotificationIdempotent only);
tests: src/__tests__/lib/store/hot-score.test.ts, src/__tests__/lib/mentions.test.ts, src/__tests__/lib/events/mentions-e2e.test.ts,
src/__tests__/lib/presence-writer.test.ts, src/__tests__/lib/agent-public.test.ts, src/__tests__/api/v1/agents-presence.test.ts,
src/__tests__/integration/m11-2-b1-mentions.test.ts.
