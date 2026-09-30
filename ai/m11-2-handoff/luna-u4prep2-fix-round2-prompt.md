# Implementation task — u4prep2 fix round 2 (convergence review: 2 MAJOR, one design)

Repo: /Users/mohsin/Github/safemolt. Tree is COMMITTED through `e9a4d06` on `ops/code-improve`.
Do NOT run any git write command — the orchestrator owns commits. Never invoke the `codex` CLI.

Findings: `ai/m11-2-handoff/codex-findings-u3d-u4prep2-convergence.md`, the two [A] items. Unit B
(u3d) is converged — do not touch playground files. Binding: agents.md "Store and Migration
Invariants" (the transitional-projection rule especially) + prepared-events + memory-preflight.

## The one design (fixes [A]1, dissolves [A]2)

Splice the follow and group-join transitional projections INTO their event-emitting statements,
the way u3d's fix round spliced the seven playground writers (`buildPlaygroundSession…UpsertCtes`
is the pattern; createComment's in-statement notification insert + activity upsert is the original
precedent):
- **followAgent (agents/db.ts):** the follow notification insert and the activity-trail upsert
  become CTEs of the decisive follow statement, gated on its insert arm, with `dedup_key` and
  `source_event_id` referencing the event CTE INSIDE the statement — no post-statement
  `stampTransitionalFollowProjections` call remains on this path. Respect the statement's existing
  lock shape; do not change what it locks or its arms' semantics (re-follow still writes nothing,
  emits nothing, bumps nothing).
- **joinGroup (groups/db.ts):** the same splice for the join's trail upsert, gated on the
  `ON CONFLICT DO NOTHING RETURNING` arm (a duplicate join keeps writing nothing and emitting
  nothing).
- **Memory twins (agents/memory.ts, groups/memory.ts):** write the projections in the synchronous
  section AFTER `appendPreparedBatch` and BEFORE `await dispatched` — visible when the store call
  resolves, atomic with the append in the memory sense.
- **[A]2 needs NO evidence ledger.** With the projections atomic in the emitting statement, a
  committed event PROVES its inline write committed, so `superseded` can only mean "a later event
  rewrote the reusable key" — never a masked loss. Do NOT build the (event_id, effect_key) ledger
  the finding sketches. Instead: (a) prove the atomicity with trigger-injection tests in the u3d
  style (event insert fails ⇒ projection absent; projection write fails ⇒ event absent) for BOTH
  kinds; (b) record the dissolution in inventory §8 and in the report's header comment (one
  sentence each: superseded is safe because every inline write is statement-atomic with its
  event).
- The drain-side reader (consumers/activity-trail.ts) and the report need no semantic change; if
  the splice makes `stampTransitionalFollowProjections` or a group equivalent dead, DELETE the
  dead helper rather than leaving it exported.

## Method
Mutation-check every behavioral change: failing test first (a drain racing the old post-statement
stamp window is the [A]1 repro — a re-follow drained between the statement and the old stamp call
must NOT stamp legacy_missing), watch it fail, fix, confirm. Match surrounding style. No bloat.
Integration test data is RUN-suffixed under every UNIQUE column.

## Fences
Your surface: src/lib/store/agents/{db,memory}.ts (the follow region ONLY — do not touch vetting,
claim, registration, or withdrawal code), src/lib/store/groups/{db,memory}.ts (the join region
ONLY), src/lib/store/notifications/* and src/lib/store/activity/* readers if a signature must
follow, src/lib/events/consumers/activity-trail.ts (only if a comment/type must follow),
scripts/soak-shadow-report.sql (header note), the shadow-legacy-compare + m11-2-u3b-social +
m11-2-u3c-groups + m11-2-u4prep-soak-report tests, inventory §8. Do NOT touch: any evaluations or
agent-lifecycle file, karma-writer files, playground files, statement.ts, dispatch.ts, legacy
compare's stamp vocabulary.

## Gates
Targeted suites while iterating (u3b-social, u3c-groups, u4prep-soak-report, shadow-legacy-compare,
the store unit suites you touch). At the end run ALL FIVE and paste each summary verbatim:
npx tsc --noEmit && npm run lint && npm test -- --runInBand && npm run test:integration &&
npm run build. The full integration run takes ~28 minutes — RUN IT TO COMPLETION. Advisory lock:
wait if held. Known flake: c13a — re-run before concluding.

## Report
Per finding: files changed, tests added, mutation-check evidence, deviations with reasons. Then
the five gate results verbatim.
