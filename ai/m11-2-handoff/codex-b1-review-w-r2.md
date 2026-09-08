# Codex review ROUND 2 — M11b wave b-1, lane W (P5.1 webhooks)

Round 1 found the items in `ai/m11-2-handoff/codex-findings-b1-w-round1.md`; every accepted one was fixed per `ai/m11-2-handoff/b1-w-fix-r1-spec.md`, and the fix report `ai/m11-2-handoff/b1-w-fix-r1-report.md` records the change, the test and the mutation-check for each. Start from scratch on the current tree: re-examine the whole lane from fundamentals, then ADJUDICATE the recorded deferrals explicitly (uphold or overturn, with a concrete harm).

You are reviewing ONE lane of the SafeMolt M11b milestone on branch `ops/code-improve`, working
tree at /Users/mohsin/Github/safemolt. Read-only sandbox. Do NOT run jest, tsc, next build or any
npm script: the sandbox denies the temp writes and the attempt can kill your session. Gate results
are stated below; trust them.

## What to read first
- `CLAUDE.md` § "Store and Migration Invariants" (the pinned rules: event coupling, token-fenced
  writes, FOR SHARE liveness locks, per-event substitutions, memory-mode re-checks).
- The plan section: `ai/PLAN_M11_2.md` lines 327–330 (P5.1 webhooks).
- The lane spec: `ai/m11-2-handoff/b1-lane-w-webhooks-spec.md` and the lane report
  `ai/m11-2-handoff/b1-lane-w-report.md`.
- The change: `git show --stat d86788d d5b0627 FIX_COMMIT` (the b-1 commits and the round-1 fix commit; review ONLY the files listed under "Files in scope") then read those files from the working tree.

## Gate results (already run by the orchestrator)
- `npx tsc --noEmit`: clean. `npm run lint`: 0 errors. Jest: 13 suites / 250 tests green (webhooks, events, wakeups).
  Integration: m11-2-b1-webhooks.test.ts 8/8 green on the reserved Neon DB.

## Focus (rank findings BLOCKER / MAJOR / MINOR / NIT, with file:line and a concrete failure scenario)
1. Atomicity: is every event gated on its decisive mutation's RETURNING, in ONE statement/batch?
2. Locks: liveness checks are FOR SHARE / FOR KEY SHARE locks, never bare EXISTS; lock order is
   posts → comments → agents; no FOR UPDATE where a FK's FOR KEY SHARE would deadlock it.
3. Token fencing: every writer that runs after a claim carries the claim token.
4. Memory-mode parity: the memory twin refuses exactly what Postgres refuses (actor/subject
   re-check after every await), preflights events before any write.
5. Security: SSRF — every resolved address public, re-resolved per attempt, the IP pinned into the socket with SNI+Host kept, redirects never followed, body capped; the secret returned once; the WEBHOOK_ALLOW_INSECURE_LOCAL seam inert in production; the delivery payload ids-only..
6. KISS / bloat: name any abstraction, option, comment essay, or duplicated helper that the plan
   does not require. The user wants LESS code, not more.
7. Test honesty: does each plan gate have a test that would fail if the behavior were removed?

## Known, recorded decisions — do NOT re-flag
- The plan's `none` wakeup channel is not materialized (`resolveWakeupDelivery` returns null).
- `createOrReArmWakeup`'s false/false race outcome is legitimate (ledger item 8).
- TA class messages emit (ledger item 6). Actionable-only admissions projection (item 7).
- Public docs and the inventory are updated at the wave boundary by the orchestrator, not per lane.
- Registration is refused with `webhooks_not_enabled` until WEBHOOKS_ENABLED=true (the P5.1 two-step rollout).
- Terminal coupling: success, exhaustion and removal complete the webhook-primary wakeup in the SAME statement; mode=both ledgers never touch internal wakeups.

## Output
A findings list ordered by severity, each with: severity, file:line, the invariant or plan line it
violates, a concrete failure scenario, and the minimal fix. End with a one-line verdict:
"CONVERGED" if there is no BLOCKER or MAJOR, otherwise "NOT CONVERGED".

## Files in scope
scripts/migrate-m11-webhooks.sql; src/lib/store/webhooks/{db,memory,index}.ts; src/lib/webhooks/deliver.ts;
src/lib/actions/webhooks.ts; src/app/api/v1/agents/me/webhook/route.ts; src/lib/worker/webhook-pass.ts;
src/lib/store/wakeups/{db,memory}.ts (the ledger CTE + resolveWakeupDelivery); src/lib/store/notifications/{db,memory,index}.ts
(createWebhookDisabledNotificationIdempotent only); worker/index.ts; render.yaml; src/lib/worker/event-drain-pass.ts;
src/lib/store/_memory-state.ts (webhook maps); the webhook.disabled entries in src/lib/events/kinds.ts,
src/lib/events/consumers/coverage.ts, src/lib/store-types.ts, src/lib/events/consumers/notifications.ts;
tests: src/__tests__/lib/webhooks/, src/__tests__/lib/store/webhooks-memory.test.ts,
src/__tests__/api/agents-me-webhook.test.ts, src/__tests__/integration/m11-2-b1-webhooks.test.ts.
