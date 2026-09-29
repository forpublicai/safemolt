# Codex review ROUND 1 — M11b wave b-2, lane S (P5.2 SSE stream + P5.3 symmetry contract)

You are reviewing ONE lane of the SafeMolt M11b milestone on branch `ops/code-improve`, working
tree at /Users/mohsin/Github/safemolt. Read-only sandbox. Do NOT run jest, tsc, next build or any
npm script: the sandbox denies the temp writes and the attempt can kill your session. Gate results
are stated below; trust them.

## What to read first
- `CLAUDE.md` § "Store and Migration Invariants" (the pinned rules: event coupling, token-fenced
  writes, FOR SHARE liveness locks, per-event substitutions, memory-mode re-checks).
- The plan section: `ai/PLAN_M11_2.md` lines 332–339 (P5.2 + P5.3), plus Decision 8 (the wakeup payload) and P2.2 (the allocation-vs-commit inversion the per-recipient seq exists to close).
- The lane spec: `ai/m11-2-handoff/b2-lane-s-sse-symmetry-spec.md` and the lane report
  `ai/m11-2-handoff/b2-lane-s-report.md (sections 1–8; section 8 is the gen-2 splice work)`.
- The change: `git show --stat 432ab1b bdd5d62 (review ONLY the files listed under "Files in scope")` then the files it lists.

## Gate results (already run by the orchestrator)
- `npx tsc --noEmit`: clean. `npm run lint`: 0 errors. Jest: 64 suites / 586 tests (store, events, worker, stream, boundary).
  Integration: m11-2-b2-stream.test.ts + m11-2-u5-wakeups.test.ts 27/27, m11-2-b1-webhooks.test.ts 23/23 on the reserved Neon DB.

## Focus (rank findings BLOCKER / MAJOR / MINOR / NIT, with file:line and a concrete failure scenario)
1. Atomicity: is every event gated on its decisive mutation's RETURNING, in ONE statement/batch?
2. Locks: liveness checks are FOR SHARE / FOR KEY SHARE locks, never bare EXISTS; lock order is
   posts → comments → agents; no FOR UPDATE where a FK's FOR KEY SHARE would deadlock it.
3. Token fencing: every writer that runs after a claim carries the claim token.
4. Memory-mode parity: the memory twin refuses exactly what Postgres refuses (actor/subject
   re-check after every await), preflights events before any write.
5. Security/correctness: the per-recipient `stream_seq` is allocated from the counter row INSIDE the enqueue statement so per-recipient commit order equals seq order (the counter lock is held to commit; an unseeded counter or an unconditional counter insert breaks withdrawal parity); frames are appended by the SAME statement that writes the projection, `ON CONFLICT DO NOTHING` on `frame_key`; the SSE server rejects a raw API key in the query, verifies the HMAC token TTL, caps two connections per agent, hides `isPubliclyHiddenAgent` actors on the firehose, sets `id:` ONLY on wakeup frames; the token route answers `stream_not_enabled` unless `STREAM_ENABLED`; the expand/backfill/contract migration seeds counters to the backfilled max..
6. KISS / bloat: name any abstraction, option, comment essay, or duplicated helper that the plan
   does not require. The user wants LESS code, not more.
7. Test honesty: does each plan gate have a test that would fail if the behavior were removed?

## Known, recorded decisions — do NOT re-flag
- The plan's `none` wakeup channel is not materialized (`resolveWakeupDelivery` returns null).
- `createOrReArmWakeup`'s false/false race outcome is legitimate (ledger item 8).
- TA class messages emit (ledger item 6). Actionable-only admissions projection (item 7).
- Public docs and the inventory are updated at the wave boundary by the orchestrator, not per lane.
- The memory-mode follow-frame gap is being closed by a parallel agent right now; do NOT re-flag it.
- The `none` wakeup channel stays unmaterialized. The reconciliation and NOT NULL contract scripts are runbook steps, not migrations.

## Output
A findings list ordered by severity, each with: severity, file:line, the invariant or plan line it
violates, a concrete failure scenario, and the minimal fix. End with a one-line verdict:
"CONVERGED" if there is no BLOCKER or MAJOR, otherwise "NOT CONVERGED".

## Files in scope
scripts/migrate-m11-stream.sql; scripts/reconcile-stream-seq.sql; scripts/contract-stream-seq-not-null.sql;
src/lib/stream/token.ts; src/app/api/v1/agents/me/stream-token/route.ts; src/lib/store/stream/{db,memory,index}.ts;
src/lib/worker/stream-server.ts + its mount in worker/index.ts; the seq CTE in src/lib/store/wakeups/{db,memory}.ts;
the frame CTE in src/lib/store/notifications/{db,memory}.ts (all eight writers); the firehose frames in
src/lib/store/activity/events.ts and src/lib/events/consumers/activity-trail.ts; src/app/api/v1/internal/school-events/route.ts;
the retention line in src/lib/worker/event-drain-pass.ts; src/lib/worker/migration-ledger.ts; .env.example;
tests: src/__tests__/lib/stream/, src/__tests__/lib/worker/stream-server.test.ts, src/__tests__/lib/symmetry-contract.test.ts,
src/__tests__/lib/store/activity/events.test.ts, src/__tests__/integration/m11-2-b2-stream.test.ts.
