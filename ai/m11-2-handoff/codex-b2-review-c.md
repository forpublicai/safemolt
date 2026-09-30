# Codex review ROUND 1 — M11b wave b-2, lane C (P7.1–P7.4 cleanup and hygiene) — LOW RISK: one round unless BLOCKER/MAJOR

You are reviewing ONE lane of the SafeMolt M11b milestone on branch `ops/code-improve`, working
tree at /Users/mohsin/Github/safemolt. Read-only sandbox. Do NOT run jest, tsc, next build or any
npm script: the sandbox denies the temp writes and the attempt can kill your session. Gate results
are stated below; trust them.

## What to read first
- `CLAUDE.md` § "Store and Migration Invariants" (the pinned rules: event coupling, token-fenced
  writes, FOR SHARE liveness locks, per-event substitutions, memory-mode re-checks).
- The plan section: `ai/PLAN_M11_2.md` lines 392–411 (P7.1–P7.4) and ai/validation/m11-inventory.md §9–§10.
- The lane spec: `ai/m11-2-handoff/b2-lane-c-cleanup-spec.md` and the lane report
  `ai/m11-2-handoff/b2-lane-c-report.md (incl. the gen-2 section) and b2-lane-c-handoff.md`.
- The change: `git show --stat 432ab1b bdd5d62 (review ONLY the files listed under "Files in scope")` then the files it lists.

## Gate results (already run by the orchestrator)
- `npx tsc --noEmit`: clean. `npm run lint`: 0 errors. Jest: boundary (5 suites), d5-durable-memories 13/13, agent-loop/pulse/tools/senses 22 suites / 154 tests.
  Integration: none needed (no store or statement changed).

## Focus (rank findings BLOCKER / MAJOR / MINOR / NIT, with file:line and a concrete failure scenario)
1. Atomicity: is every event gated on its decisive mutation's RETURNING, in ONE statement/batch?
2. Locks: liveness checks are FOR SHARE / FOR KEY SHARE locks, never bare EXISTS; lock order is
   posts → comments → agents; no FOR UPDATE where a FK's FOR KEY SHARE would deadlock it.
3. Token fencing: every writer that runs after a claim carries the claim token.
4. Memory-mode parity: the memory twin refuses exactly what Postgres refuses (actor/subject
   re-check after every await), preflights events before any write.
5. Honesty of the "already satisfied" claims: verify by import search that (a) every tool executor under src/lib/agent-tools/definitions is an adapter with no mutating store import, (b) `listEligibleAgents` is still required by the memory-mode degraded path, (c) no loop-side gatherer duplicates src/lib/agent-senses, (d) the boundary allowlist in scripts/gen-eslint-boundary.js equals inventory §10, (e) playground memory is durable behind pickStore with both cascades, (f) `sessions/active` reads the same store primitive as `sessions?status=active`, (g) the archive index and PLAN.md edits are complete and nothing live was archived..
6. KISS / bloat: name any abstraction, option, comment essay, or duplicated helper that the plan
   does not require. The user wants LESS code, not more.
7. Test honesty: does each plan gate have a test that would fail if the behavior were removed?

## Known, recorded decisions — do NOT re-flag
- The plan's `none` wakeup channel is not materialized (`resolveWakeupDelivery` returns null).
- `createOrReArmWakeup`'s false/false race outcome is legitimate (ledger item 8).
- TA class messages emit (ledger item 6). Actionable-only admissions projection (item 7).
- Public docs and the inventory are updated at the wave boundary by the orchestrator, not per lane.
- Inline writers whose kinds are still `legacy`/`shadow` in coverage.ts are NOT deletable in this milestone (they go with the per-kind flips at deploy time); do not flag their presence.

## Output
A findings list ordered by severity, each with: severity, file:line, the invariant or plan line it
violates, a concrete failure scenario, and the minimal fix. End with a one-line verdict:
"CONVERGED" if there is no BLOCKER or MAJOR, otherwise "NOT CONVERGED".

## Files in scope
ai/archive/README.md and the five moved items; ai/PLAN.md; ai/PLAN_M10.md; scripts/gen-eslint-boundary.js (unchanged — confirm);
src/lib/playground/memory.ts and src/lib/store/playground/agent-memories-{db,memory}.ts (unchanged — confirm durable);
src/app/api/v1/playground/sessions/active/route.ts (unchanged — confirm); src/lib/agent-loop.ts, src/lib/agent-pulse/runner.ts,
src/lib/agent-tools/definitions/* (unchanged by this lane — confirm the "nothing deletable" claim); the two lane C reports.
