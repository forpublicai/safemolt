# Codex review ROUND 3 — M11b wave b-1, lane D (P6.3 direct messages)

Rounds 1 and 2 found the items in `ai/m11-2-handoff/codex-findings-b1-d-round{1,2}.md`; every accepted one was fixed per `ai/m11-2-handoff/b1-d-fix-r{1,2}-spec.md`, and the fix reports `ai/m11-2-handoff/b1-d-fix-r{1,2}-report.md` records the change, the test and the mutation-check for each. Start from scratch on the current tree: re-examine the whole lane from fundamentals, then ADJUDICATE the recorded deferrals explicitly (uphold or overturn, with a concrete harm).

You are reviewing ONE lane of the SafeMolt M11b milestone on branch `ops/code-improve`, working
tree at /Users/mohsin/Github/safemolt. Read-only sandbox. Do NOT run jest, tsc, next build or any
npm script: the sandbox denies the temp writes and the attempt can kill your session. Gate results
are stated below; trust them.

## What to read first
- `CLAUDE.md` § "Store and Migration Invariants" (the pinned rules: event coupling, token-fenced
  writes, FOR SHARE liveness locks, per-event substitutions, memory-mode re-checks).
- The plan section: `ai/PLAN_M11_2.md` lines 353–379 (P6.3) and Decision 10 (FK-less participant ids).
- The lane spec: `ai/m11-2-handoff/b1-lane-d-dms-spec.md` and the lane report
  `ai/m11-2-handoff/b1-lane-d-report.md`.
- The change: `git show --stat d86788d d5b0627 65fc47e FIX2_COMMIT` (the b-1 commits and the round-1 fix commit; review ONLY the files listed under "Files in scope") then read those files from the working tree.

## Gate results (already run by the orchestrator)
- `npx tsc --noEmit`: clean. `npm run lint`: 0 errors. Jest: dms-memory, dm-routes, events, agent-pulse, agent-senses, boundary suites green.
  Integration: m11-2-b1-dms.test.ts 6/6 green on the reserved Neon DB (run twice).

## Focus (rank findings BLOCKER / MAJOR / MINOR / NIT, with file:line and a concrete failure scenario)
1. Atomicity: is every event gated on its decisive mutation's RETURNING, in ONE statement/batch?
2. Locks: liveness checks are FOR SHARE / FOR KEY SHARE locks, never bare EXISTS; lock order is
   posts → comments → agents; no FOR UPDATE where a FK's FOR KEY SHARE would deadlock it.
3. Token fencing: every writer that runs after a claim carries the claim token.
4. Memory-mode parity: the memory twin refuses exactly what Postgres refuses (actor/subject
   re-check after every await), preflights events before any write.
5. Security/privacy: block ⇒ 403 BOTH directions re-checked on the locked pair row inside the decisive statement; seq assigned from the locked pair row so commit order = seq order; a refused send burns no seq (the lane found and fixed this); the comment cooldown + daily pool claimed in-statement; push payloads and events carry ids only; a dangling participant renders as deleted; read_dm_thread marks read and stays non-terminal..
6. KISS / bloat: name any abstraction, option, comment essay, or duplicated helper that the plan
   does not require. The user wants LESS code, not more.
7. Test honesty: does each plan gate have a test that would fail if the behavior were removed?

## Known, recorded decisions — do NOT re-flag
- The plan's `none` wakeup channel is not materialized (`resolveWakeupDelivery` returns null).
- `createOrReArmWakeup`'s false/false race outcome is legitimate (ledger item 8).
- TA class messages emit (ledger item 6). Actionable-only admissions projection (item 7).
- Public docs and the inventory are updated at the wave boundary by the orchestrator, not per lane.
- sendDm is a two-element sql.transaction (ensure-row, then lock+claim+insert) mirroring createComment — recorded.
- deleteAgent refusing any agent with an agent_rate_limits row is pre-existing and consistent with the pristine-withdrawal policy; do not flag as a DM defect.
- unblockAgent has no self-check (harmless no-op).

## Output
A findings list ordered by severity, each with: severity, file:line, the invariant or plan line it
violates, a concrete failure scenario, and the minimal fix. End with a one-line verdict:
"CONVERGED" if there is no BLOCKER or MAJOR, otherwise "NOT CONVERGED".

## Files in scope
scripts/migrate-m11-dms.sql; src/lib/store/dms/{db,memory,index}.ts; src/lib/actions/dms.ts; src/app/api/v1/dm/**;
src/lib/agent-tools/definitions/messages.ts; src/lib/agent-runtime/index.ts (the messages domain); src/lib/agent-pulse/runner.ts
(the dm reason); src/lib/agent-senses/{inbox,types}.ts (the DM section); the dm.* entries in kinds.ts / coverage.ts / store-types.ts /
consumers/notifications.ts / consumers/wakeup-router.ts; src/lib/store/notifications/* (createDmReceivedNotificationIdempotent only);
tests: src/__tests__/lib/store/dms-memory.test.ts, src/__tests__/api/dm-routes.test.ts, src/__tests__/integration/m11-2-b1-dms.test.ts.

## Recorded flake to adjudicate
`src/__tests__/integration/m11-2-b1-dms.test.ts` "the blocker's own send races their own block
(forward direction)" failed on two consecutive orchestrator runs and passed on the third (the other
nine cases were green every time). The barrier is timing-based. Judge whether the TEST's barrier
is unsound (chained-waiter counting, sleep-based ordering) or whether the statement has a real
window; propose the minimal deterministic barrier.
