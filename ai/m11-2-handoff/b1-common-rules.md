# M11b wave b-1 — common rules for every lane (read FIRST, then your lane spec)

Branch `ops/code-improve`. Four lanes run CONCURRENTLY in this one working tree. Each lane is a
Sonnet manager that spawns its own subagents (Sonnet for statements/store/actions, Haiku for
mechanical work: test scaffolding, memory-store twins from a finished db twin, report writing).

## The user's standing directives (verbatim intent)

1. **KISS and MINIMAL BLOAT.** The simplest implementation that satisfies the plan's remedy and
   gates. No frameworks, no speculative abstraction, no new dependencies, no "for later" options,
   no config knobs the plan does not name. Reuse the house machinery exactly: `pickStore`,
   `defineConsumer`, `emitEventStatement`/`emitEventCtes`, `PreparedEvent`, `ActionResult`
   (`actionOk`/`actionError`), `jsonResponse`/`errorResponse`, `requireCronAuth`.
2. **CRAP scores matter.** ESLint `complexity` max 12 per function is a WARNING — treat it as an
   error for new code. Small functions, early returns, no nested conditionals three deep. Every new
   function has a test that exercises it (coverage × complexity is the score).
3. **Comment style: WHY, in ≤ 5 lines.** The tree has long essay comments from earlier waves; do
   NOT imitate them. One short paragraph on the non-obvious decision (the lock, the gate, the
   ordering), nothing on what the code plainly does.
4. **Tests are compact.** One test file per concern, shared fixtures, reuse
   `src/__tests__/integration/helpers/*` and existing memory-mode helpers. No duplicated helper
   code across lanes; no test that asserts implementation detail instead of the plan's gate.

## Hard rules (each closed a real incident)

- **No git.** The orchestrator owns every commit. Never `git add/commit/stash/checkout/reset`.
- **No codex.** Reviews happen after the wave, serially, on a quiet machine.
- **No `npm run build`, no full `npm run test:integration` without a path.** Run TARGETED jest
  (`npm test -- <path>`) and targeted integration (`npm run test:integration -- <path>`; it takes
  an advisory lock on the reserved DB — if it waits, WAIT, never kill a holder).
- **Subagents: `run_in_background: false` ALWAYS.** A manager that ends its turn to "wait" for a
  background child is stranded and receives nothing.
- **Context discipline.** At ~60% of your context, STOP: write a complete handoff to
  `ai/m11-2-handoff/b1-lane-<x>-handoff.md` (disk state, what is done, what is next, exact
  file list, gate results) and end your turn saying so. Same for subagents (fresh spawn at ~50%,
  self-contained prompt). A subagent that stalls dies with its partial work on disk — inventory
  the disk, then spawn a fresh one for the remainder; never re-run from scratch blindly.
- **Verify subagent claims yourself** with real gate runs before you report them.
- **Mutation-check every behavioral test**: suppress the behavior → watch the test fail with the
  forbidden state observed → restore → green. Record the evidence in your report.

## Shared files — the collision protocol

These files are edited by MORE THAN ONE lane. For each: re-read the file IMMEDIATELY before every
edit, make ONE minimal append at your own anchor (never reformat, never reorder), and never touch
another lane's lines. If an Edit fails with "modified since read", re-read and retry.

| File | What you may add |
|---|---|
| `src/lib/events/kinds.ts` | your kind(s) in `EventPayloadMap`, under a `// ==== M11b <lane> ====` anchor at the END of the interface, plus the union entries where the file lists kinds |
| `src/lib/events/consumers/coverage.ts` | one line per kind at the END of EACH of the four manifests (`notificationsCoverage`, `activityTrailCoverage`, `memoryIngestCoverage`, `wakeupRouterCoverage`) — the `satisfies Record<EventKind,…>` makes an omission a compile error |
| `src/lib/store-types.ts` | your `NotificationType` member(s) at the end of the union |
| `src/lib/events/consumers/notifications.ts` | one `case` in the kind switch + one planner function + one `PlannedNotification` variant |
| `src/lib/events/consumers/wakeup-router.ts` | one `case` in `apply` + one route function |
| `src/lib/store.ts` | one `export * from "./store/<domain>"` line |
| `src/lib/store/export-manifest.ts` | your mutating export NAMES appended to `MUTATING_STORE_EXPORTS` (one quoted, comma-terminated literal per line); reads must start with a `READ_EXPORT_PREFIXES` prefix (`get`, `list`, `is`, `has`, …) |
| `scripts/migrate.js` | one `{ file, label }` line appended to `MIGRATION_FILES` |
| `src/lib/worker/migration-ledger.ts` | your migration filename appended to `REQUIRED_MIGRATIONS` if the worker's duties or the runner's tools read your table |
| `src/lib/agent-tools/index.ts` | one import + one entry in `modules` |
| `src/lib/actions/types.ts` | a new `ActionErrorCode` member ONLY if the plan names the code |

- `.eslintrc.json` is GENERATED. Run `npm run gen:boundary` only at your lane END. The
  orchestrator regenerates once at the wave boundary; the drift test arbitrates.
- **Do NOT edit**: `public/*.md`, `public/openapi.json`, `CLAUDE.md`/`agents.md`,
  `ai/validation/m11-inventory.md`, `ai/PLAN_M11_2.md`. Write your docs delta (exact text) into
  your report; a docs agent applies all four at the boundary.
- Out-of-fence needs are RECORDED in your report, not acted on.

## Integration-test discipline (reserved Neon DB)

- RUN-suffix every fixture value under a UNIQUE column (`const RUN = Date.now().toString(36)`).
- Neutralize one-per-scope index orphans in `beforeAll` (see `m11-2-u5-wakeups.test.ts` for the
  wakeup indexes; drain-heavy suites pay the cross-run backlog once in `beforeAll`).
- A first-time failure of a race test: re-run the suite SOLO before diagnosing (Neon resets).
- Memory mode: the in-process dispatcher fires consumers synchronously on emit — a test isolating a
  producer's own writes must step around what the consumer already produced from the same event.

## Report format (`ai/m11-2-handoff/b1-lane-<x>-report.md`)

1. Deliverables — done / partial / not started, with file paths.
2. Gate results — the exact commands you ran and their tail output (tsc, lint, jest paths,
   integration paths).
3. Mutation-check evidence, verbatim.
4. Shared-file edits made (file + anchor), new store exports and their manifest classification.
5. Out-of-fence needs and cross-lane notes.
6. Docs delta — exact text for `public/reference.md`, `public/skill.md`, `public/openapi.json`,
   `public/planned.md`, `CLAUDE.md` invariants (one bullet each, in the house style).
7. Behavior changes or plan deviations, with the reason.
