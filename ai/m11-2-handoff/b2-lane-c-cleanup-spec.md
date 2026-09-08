# b2 Lane C — P7.1–P7.4 strangler deletions + durable playground memory + hygiene (spec — DRAFT)

> STATUS: drafted while wave b-1 runs. Launch at the b-1 boundary, concurrently with Lane S.

Read `ai/m11-2-handoff/b1-common-rules.md` first (same rules). Then `ai/PLAN_M11_2.md` lines
392–411 (P7.1–P7.4 verbatim), `ai/validation/m11-inventory.md` §9 and §10, `scripts/gen-eslint-
boundary.js`, `src/lib/playground/memory.ts`, `src/lib/agent-loop.ts`, `src/lib/agent-pulse/
runner.ts` (`listEligibleAgents` users).

## Mission

Delete what the outbox and the runner superseded, make playground episodic memory durable with
its semantics unchanged, and record every route decision. This lane REMOVES more than it adds —
report the line delta.

## Deliverables

1. **P7.1 deletions.** Verify by import, never by inventory checkbox: tool-side mutation logic
   (P1.5 — the tool executors must be adapters only), loop-side gatherers (P4.3 — anything still
   duplicating `agent-senses`), inline side-effect call sites listed in inventory §9 whose kind is
   `on` in every consumer (check `coverage.ts`; a `legacy`/`shadow` kind's writer STAYS),
   `listEligibleAgents`/batch plumbing not needed by the degraded wrapper. The boundary allowlist
   in `gen-eslint-boundary.js` shrinks to the §10 permanent set (never to zero); regenerate
   `.eslintrc.json`; the boundary tests arbitrate. Report `git diff --stat`-style line deltas
   per file (the orchestrator runs git; you compute from `wc -l` before/after).
2. **P7.2 durable playground memory.** Migration `scripts/migrate-m11-playground-memories.sql`
   with the plan's DDL (both `ON DELETE CASCADE` FKs, PK `(agent_id, session_id)`, `importance`
   TEXT verbatim). Store `src/lib/store/playground-memories/{db,memory,index}.ts` behind
   `pickStore` (memory twin = today's map, moved). `src/lib/playground/memory.ts` keeps its
   function surface and becomes thin async calls; `retrieveMemories` keeps its scoring in TS
   over the fetched rows. `clearSessionMemories`/`clearAgentMemories`: delete if no production
   caller remains (the cascades replace them). Tests: survives a fresh module registry (db mode);
   overwrite-per-round; cascades leave no orphan; engine tests green.
3. **P7.3 route reconciliation.** `playground/sessions/active` becomes a filter over the same
   store read as `sessions?status=active`; the subscribe/unsubscribe routes stay; ATProto stays
   frozen. Docs delta text for reference.md/planned.md (recorded in the report, not applied).
4. **P7.4 planning hygiene.** Move `AGENT_EXPERIENCE_AUDIT.md`, `AGENT_EXPERIENCE_AUDIT_2026-05-
   14.md`, `AGENT_UX_PRIMITIVES_PLAN.md`, `cleanup-1.md`, `ai/agent-ux-plans/` to `ai/archive/`
   with a one-line index in `ai/archive/README.md`; replace PLAN.md's foreign tooling references
   (`fbsource/...`, `arc lint`, `ClaudeAgent.ts`) with SafeMolt equivalents; append M11's backlog
   items (PLAN_M11_2.md "Backlog additions") to PLAN.md `## Backlog`; verify PLAN_M10.md's
   supersession note. Use `mv` for files (the orchestrator stages renames).

## Fences

- NEW: `scripts/migrate-m11-playground-memories.sql`, `src/lib/store/playground-memories/`, tests.
- EDIT: `src/lib/playground/memory.ts`, `src/lib/agent-tools/definitions/*` (deletions only),
  `src/lib/agent-loop.ts`, `src/lib/agent-pulse/runner.ts` (deletions only),
  `scripts/gen-eslint-boundary.js`, `src/app/api/v1/playground/sessions/active/route.ts`,
  `ai/PLAN.md`, `ai/PLAN_M10.md`, `ai/archive/**`, the four moved files.
- SHARED: migrate.js, migration-ledger, export-manifest, store.ts.
- DO NOT TOUCH: `src/lib/store/{wakeups,notifications,activity}/`, `worker/**`, `src/lib/stream/`,
  `src/lib/worker/stream-server.ts`, `src/lib/events/consumers/activity-trail.ts`,
  `src/app/api/v1/internal/school-events/**` (Lane S), public docs, inventory, CLAUDE.md.
