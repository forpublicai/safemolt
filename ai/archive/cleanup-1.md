# Cleanup-1: lean the SafeMolt repo

Subtraction-focused. Every phase removes complexity or isolates it. No new abstractions, no new tests scaffolded against problems that don't exist today, no reorganization for its own sake. Five phases, roughly three and a half working days.

The platform/product cuts (route collapsing, skill.md trim, on-platform agent inbox tools, memory API endpoint shrink, onboarding wizard) live in a separate doc — `cleanup-2-platform-experience.md` — because they're product decisions, not pure refactor. Three items that came up during analysis but aren't worth executing as part of this cleanup are captured in **Future considerations** at the end.

Each phase: **Tasks → What might break → Verify**. A "phase complete" requires `npm test`, `npm run lint`, and `npm run build` green. Preview smoke (`npm run preview:smoke -- <preview-url> [share-token]`) only where called out; it requires a URL argument and is not a default gate.

---

## Phase 0 — Foundation decisions (1 hour, no code)

Capture three answers in `agents.md` before code moves. Future agents need the intent, not just the result.

1. **AT Protocol surface stays.** Per user instruction, xrpc routes, `src/lib/atproto/*`, `@atproto/crypto`, `@atproto/repo`, `@noble/curves`, `multiformats`, `.well-known/*` are out of scope for this cleanup.
2. **Production has a DB.** `package.json` build is `node scripts/migrate.js && next build`; the migrate runner exits 1 with no DB URL (`scripts/migrate.js:162`). Memory-mode previews therefore don't exist with the current pipeline. Memory.ts is load-bearing for **jest tests only**, not for previews.
3. **`ao` and `classes` are intentionally Postgres-only.** Their facades say so (`src/lib/store/classes/index.ts:1`, `src/lib/store/ao/index.ts:1`). Tests touching these domains must use a real DB or `jest.mock` the store import.

---

## Phase 1 — Dead code sweep (0.75 day)

Confirmed-dead targets. Verified directly; not the speculative ones from earlier audit passes.

### Tasks

1. **Delete `src/lib/mock-data.ts`** (70 lines). Zero inbound references (`grep -rn "mock-data" src/` is empty). File dates to pre-rebrand work; safe to delete directly.
2. **Delete `scripts/sync-evaluations.ts`**. Orphan: its only mention is a stale doc comment at `src/lib/evaluations/sync.ts:14`. Repo has no `ts-node` / `tsx` runner, so it can't be invoked today even if someone wanted to. Delete the file and remove the comment.
3. **Remove `@modelcontextprotocol/sdk` from root `package.json`** (dep line). It is unused in `src/`. The MCP server in `packages/safemolt-memory-mcp/` has its own `package.json` with this dep — note that root `package.json` has **no `workspaces` field**, so the MCP package is a sibling, not an npm workspace. Verify the MCP package still installs and builds independently: `cd packages/safemolt-memory-mcp && npm install && npm run build`.
4. **Delete `IStore` from `src/lib/store-types.ts:519`** (~135 lines). Verified zero consumers: `grep -rn ": IStore\|implements IStore\|<IStore>" src/` is empty (excluding the declaration). It's a remnant from an earlier design that aimed to make memory.ts implement a contract; nothing uses it today.
5. **Delete empty / transient validation dirs:**
   - `ai/m6-validation/` — empty.
   - `ai/m7-validation/` — contains `next-dev.log`, `next-start.log` (build artifacts, not validation evidence).
6. **Move `ai/validation/`** (M1 screenshots) to `ai/archive/m1-validation/` — keeps evidence next to the milestone plan it documented.

### Additional sweep — static assets, cruft directories, one-line barrels

Verified directly in the additional-pass review. Each is independent of the others; do in any order.

7. **Delete `public/party-parrot.gif`**. Zero references anywhere in `src/`, `public/`, `docs/`, `ai/`, or configs.
8. **Delete `public/class-previews/` directory**. Contains only `when-to-make-yourself-obsolete.png`. The string `when-to-make-yourself-obsolete` appears once in `ClassDetailClient.tsx` as a class route ID (`classRouteId === "when-to-make-yourself-obsolete"`), but no code path loads the PNG (`grep -rn "class-previews\|/class-previews/" src/ public/` is empty). The PNG is unreferenced; the class ID lives on independently.
9. **Delete `.kilo/` directory**. Contains only `package-lock.json` (13.5 KB) from a tool that is not part of this project's workflow. No references in `src/`, `package.json`, or `.gitignore`. Cruft.
10. **Inline `src/app/playground/PlaygroundContent.tsx`**. The file is a single-line barrel: `export { PlaygroundContent } from "@/components/playground/PlaygroundContent";`. **One caller**: `src/app/playground/page.tsx:6` imports it relatively (`./PlaygroundContent`). The test file imports from the canonical path `@/components/playground/PlaygroundContent` directly, so it does not depend on the barrel. Update `page.tsx:6` to `import { PlaygroundContent } from "@/components/playground/PlaygroundContent"`, then delete the barrel file.

### Deprecated-marker audit (do, with care)

Three locations explicitly announce themselves as deprecated or legacy. Each needs a small verification before action.

11. **`src/app/api/v1/agents/status/route.ts`** — the file header comment says `DEPRECATED: Enrollment status is no longer used.` But the route was **re-purposed**, not retired: it now returns claim status + latest announcement + news headlines, and is documented in `public/skill.md` (the "Check Claim Status" section). The deprecation comment is what's stale, not the route. Action: **update the comment**, do not delete the route.
12. **`maybeUpgradeLegacyPublicAiSlug` in `src/lib/provision-public-ai-agent.ts:27-49`** (called at line ~59). Only runs against legacy `publicai_*` slugs that pre-date the v2 naming change. Action: run `SELECT COUNT(*) FROM agents WHERE name LIKE 'publicai_%' AND (metadata->>'public_ai_handle_style' IS NULL OR metadata->>'public_ai_handle_style' != 'v2')` against production. If zero, delete the function and its call site, plus the `@deprecated`-marked `publicAiAgentNameForUser` helper above it. If non-zero, leave alone — the upgrade path is still needed.
13. **`src/app/cohorts/page.tsx` (`CohortsLegacyPage`)** — 10-line back-compat redirect shim to `/companies#venture-studio-cohorts`. Low value, low cost to remove, but external links may exist. **Audit but probably leave alone**: the redirect is doing useful work for ~10 lines, and removal is a routing-behavior change rather than a code-cleanup change. Document the decision either way in `LEARNINGS.md`.

### Stale npm scripts (decided: delete all three)

Three `package.json` scripts have zero `src/` references and only inbound links from archived milestone plans. Decision made: delete the scripts and their underlying files together.

15. **Remove from `package.json`** (`scripts` object):
    - `"perf:smoke": "node scripts/perf-smoke.js"` (line 15)
    - `"perf:trace": "node scripts/analyze-route-trace.js"` (line 17)
    - `"playground:backfill-prefabs": "node scripts/backfill-playground-prefabs.js"` (line 18)
16. **Delete the underlying files**:
    - `scripts/perf-smoke.js`
    - `scripts/analyze-route-trace.js`
    - `scripts/backfill-playground-prefabs.js`

Note: `preview:smoke` → `scripts/preview-smoke.js` stays untouched — it is referenced by the cleanup plan itself (Phase 0 gate) and is the only one of the four with a current use case.

### `DEMO_DAILY_REQUEST_LIMIT` env shim (verified four-site cleanup)

`process.env.DEMO_DAILY_REQUEST_LIMIT` appears as a fallback to `PUBLIC_AI_SPONSORED_DAILY_LIMIT` in four places: `src/app/dashboard/page.tsx:27`, `src/app/api/dashboard/sponsored-inference-status/route.ts:7`, `src/lib/human-users-memory.ts:322`, `src/lib/human-users-db.ts:459`. The shim env name is **not** in `.env.example` — it's a rename leftover.

14. **Confirm no Vercel environment (prod, preview, dev) still sets `DEMO_DAILY_REQUEST_LIMIT`**. If confirmed unset everywhere: simplify the four call sites to `process.env.PUBLIC_AI_SPONSORED_DAILY_LIMIT || "100"`. If any environment still uses it: rename that env var to the canonical name in the dashboard, then do the simplification.

### Do NOT touch

These came up in earlier rounds as candidates but verified live:

- `src/lib/agent-onboarding-copy.ts` — 3 callers (`agents/verify/route.ts:2`, `agents/claim/route.ts:4`, `claim/[id]/page.tsx:7`) using `SUGGESTED_MESSAGE_TO_SEND_AGENT_AFTER_CLAIM`.
- `src/lib/agent-identity-generator.ts` — used by `agent-loop.ts:50` (`isPlaceholderIdentity`, `generateRandomIdentity`).
- `src/lib/public-ai-agent-naming.ts` — single caller (`provision-public-ai-agent.ts:16`). Merge would save nothing. Leave alone.
- All `memory.ts` files. See Phase 5.

### What might break

- **MCP SDK removal**: fresh `npm install` fails if something in `src/` imports the SDK via a path the grep missed. Mitigation: `npx tsc --noEmit` immediately after — TypeScript reports unresolved imports.
- **`mock-data.ts`**: anything outside `src/` referencing it. Check `grep -rn "mock-data" . --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git --exclude-dir=ai`.
- **Validation dirs**: `grep -rn "ai/m6-validation\|ai/m7-validation\|ai/validation" .` — if PLAN_M6.md or PLAN_M7.md link to them, those plans archive in Phase 2 anyway; the links go to `ai/archive/`.

### Resolution

- If TS reports unresolved MCP imports: restore the dep. Do not add a `//` comment to `package.json` — JSON does not support comments. Instead record rationale in `agents.md` under a "Pinned dependencies" subsection.
- If `mock-data` references appear outside `src/`: inline the fixtures into the consumer.

### Verify

- `npm install && npm run lint && npm test && npm run build` green.
- `npm ls @modelcontextprotocol/sdk` at repo root shows "(empty)".
- `packages/safemolt-memory-mcp/` builds independently.

---

## Phase 2 — Docs and plans archival (0.5 day)

### Tasks

1. **Create `ai/archive/` and `docs/archive/`** (with `.gitkeep` if empty initially).
2. **Move unconditionally** to `ai/archive/`: `ai/PLAN_M1.md` through `PLAN_M7.md`, `PLAN_M2_5.md`, `PLAN_REVIEW_FINDINGS.md`, `CLAUDE_REVIEW_DASHBOARD_ACTIVITY_PLAYGROUND.md`. Use `git mv` so history is preserved.
3. **Leave alone**: `ai/ARCHITECTURE.md`, `ai/DESIGN.md`, `ai/PLAN.md` — read like current references.
4. **For each `docs/*_PLAN.md` (21 files — verified count)**, run a coarse verdict first, per-doc only when coarse is ambiguous:
   - **Coarse pass**: open the doc, look at its top-level deliverable (a named page, a named route, a feature flag). Check whether that thing exists in the codebase today. If clearly shipped, `git mv docs/<file> docs/archive/<file>` and move on. If clearly not shipped, leave in place.
   - **Per-doc pass** (only for ambiguous cases): identify 2–3 concrete sub-deliverables, grep / ls for evidence, then decide: archive, annotate `**Status:** Partially implemented as of YYYY-MM-DD; see X, Y.` at the top, or leave alone.
   - The coarse pass should resolve most of the 21; the per-doc pass should hit fewer than half a dozen. This keeps Phase 2 at ~0.5 day rather than ballooning into a multi-day audit.
5. **Leave non-`*_PLAN.md` docs** in place: `COGNITO_AUTH.md`, `PUBLIC_AI_PROVISIONING.md`, `playground.md`, `inbox.md`, `DESIGN_AESTHETIC.md`, `CLASSES_CURL_TUTORIAL.md`, `CLASSES_SYSTEM.md`. These are reference docs.
6. **`LEARNINGS.md` stays as is.** Per user instruction, it's the code-level architectural-learnings log — distinct purpose from `agents.md`.
7. **Delete `TODOS.md` at repo root.** Decided: `ai/PLAN.md` is the canonical "what's next" surface; `TODOS.md` is a parallel duplicate. Verified zero inbound links outside this plan itself. Before deleting, scan TODOS.md's "Active Projects" and "Backlog" sections and fold any items not already captured into `ai/PLAN.md`:
   - The MPP marketplace project entry in TODOS.md is a pointer to `docs/MPP_MARKETPLACE_POC_PLAN.md` — already canonical there, no merge needed.
   - The "Admissions & Careers Pages" and "Research API & Data Firehose" backlog items: confirm whether `ai/PLAN.md` covers them; if not, add a short backlog section to `ai/PLAN.md`.
8. **Add a one-line invariant to `agents.md`** (under "Project conventions" or similar): "Roadmap and what's-next planning lives in `ai/PLAN.md`. Do not create parallel TODO/planning files at the repo root." This is what prevents the surface from re-fragmenting.

### What might break

Internal links from one doc to another. After all moves: `grep -rn "docs/.*_PLAN.md\|ai/PLAN_M" . --exclude-dir=archive --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git --exclude=cleanup-*.md` should return zero stale references. The `--exclude=cleanup-*.md` is required because this plan mentions both patterns.

### Resolution

Update each dangling link to point at `ai/archive/` or `docs/archive/`. If the linker (e.g. `agents.md`, `README.md`, `CLAUDE.md`) referenced an archived doc, ask whether the linker line should be removed entirely.

### Verify

- `ai/PLAN_M*.md` and the four named extras no longer at top level.
- `docs/archive/` contains only fully-implemented docs.
- The exclude-aware grep returns empty.

---

## Phase 3 — SQL hygiene (1.5 days)

The goal is to make `scripts/` legible, not to overhaul the migration pipeline. The 33-entry runner is fine; the noise around it is what matters.

### The inlining pattern (read this first)

Several historical `migrate-*.sql` files have had their DDL inlined into `scripts/schema.sql` over time. Once that happens, the orphan migration is safe to delete because `schema.sql` is the **first** entry in `MIGRATION_FILES` and runs on every fresh-DB bootstrap. Verified examples:

- `scripts/migrate-evaluations.sql` creates `evaluation_definitions`. Same table is now created at `scripts/schema.sql:175`. Inlined.
- `scripts/migrate-twitter-verification.sql` adds `claim_token`, `verification_code`, `owner` to `agents`. All three columns are inlined in the `agents` `CREATE TABLE` at schema.sql lines 17–19.
- `scripts/migrate-x-followers.sql` adds `x_follower_count`. Inlined at agents line 20.
- `scripts/migrate-agents-vetting.sql` adds `is_vetted`, `identity_md`, `idx_agents_is_vetted`. All inlined at schema.sql lines 28, 29, 31 (note: as `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements directly after the agents `CREATE TABLE`, not inside it).

**This pattern is the right way to handle a load-bearing orphan**: inline its DDL into `schema.sql`, then delete the orphan file. Production is unaffected because the new columns/tables already exist there; fresh DBs are unaffected because schema.sql now creates them.

### The `migrations/007_classes_system.sql` situation (load-bearing — DO NOT DELETE before inlining)

**Corrected from the previous draft of this plan.** Direct verification (`sed -n '14p' scripts/schema.sql` returns `display_name TEXT,`; `grep -n "^CREATE TABLE" scripts/schema.sql` returns 23 tables, none of them `classes`/`professors`/`class_*`): `scripts/schema.sql` does **NOT** create the classes subsystem. The earlier claim in this doc that it did was a verification error on my part (I misattributed grep output across a header marker).

Today's actual state on a fresh DB:

1. `MIGRATION_FILES[0]` = `schema.sql` runs, creates `agents`, `groups`, `posts`, etc. — but **no `classes` or class_* tables**.
2. Later in the loop, `migrate-class-slugs.sql` runs `ALTER TABLE classes ADD COLUMN slug TEXT`.
3. PostgreSQL throws `42P01: relation "classes" does not exist`.
4. `isIgnorableMigrationError` (`scripts/migrate.js:91-101`) catches the error message `"does not exist"` and silently records the migration as applied.
5. The fresh DB now has no classes subsystem at all, the `_migrations` log shows green, and any code path touching classes will fail at runtime.

Production works because 007 was applied at some point in the past through a path that no longer exists. The combination of "schema.sql missing the tables" + "isIgnorableMigrationError masking the cascade failure" hides the bug from CI.

**Required fix in this order**:

1. **Inline 007's DDL into `scripts/schema.sql`** — port the eight `CREATE TABLE IF NOT EXISTS` statements (`professors`, `classes`, `class_assistants`, `class_enrollments`, `class_sessions`, `class_session_messages`, `class_evaluations`, `class_evaluation_results`) plus 007's indexes into schema.sql. Same pattern as the four orphans above. Production is unaffected (tables already exist with `IF NOT EXISTS`); fresh DBs now get the tables.
2. **Then delete `migrations/007_classes_system.sql`** — it becomes a true duplicate at that point.
3. **Then evaluate the top-level `migrations/` directory** — once 007 is gone, the directory is likely empty. Delete it.
4. **Only after steps 1–3 land**, do the `isIgnorableMigrationError` tightening (next section). Otherwise the very first fresh-DB CI run after the strict-mode change explodes — which is the *correct* loud failure, but you want it pointing at something you've already fixed.

### Pre-flight orphan audit

With the inlining pattern in mind, six files in `scripts/` are not in `MIGRATION_FILES` and have verifiable verdicts:

| File | Verdict | Reason |
|------|---------|--------|
| `migrate-twitter.js` | **delete** | Only self-reference is its own header comment `Run: node scripts/migrate-twitter.js`. No call site anywhere. |
| `migrate-evaluations.sql` | **delete** | DDL inlined at `scripts/schema.sql:175` (`evaluation_definitions` + indexes). |
| `migrate-twitter-verification.sql` | **delete** | All columns inlined at agents lines 17–19. |
| `migrate-x-followers.sql` | **delete** | `x_follower_count` inlined at agents line 20. |
| `migrate-agents-vetting.sql` | **delete** | All columns + index inlined at schema.sql lines 28, 29, 31. |
| `migrate-provisioned-agents-vetted.sql` | **delete after pre-check** | One-shot data backfill (`UPDATE agents SET is_vetted = true WHERE provisioned_public_ai`). Header comment says "optional — new provisioned agents are auto-vetted during provisioning." **Required pre-delete check** against production: `SELECT COUNT(*) FROM agents WHERE metadata->>'provisioned_public_ai' = 'true' AND (is_vetted IS NULL OR is_vetted = false);` — if non-zero, run the migration once before deleting the file. If zero, delete directly and note in `LEARNINGS.md` that the backfill was retired YYYY-MM-DD with N=0 stragglers. |
| `scripts/apply-scoping.js` | **delete** | 40-line one-shot scoping backfill. Not in `MIGRATION_FILES`. Zero inbound references (`grep -rn "apply-scoping" .` outside the file itself is empty). Same pattern as `migrate-twitter.js`. |
| `scripts/cleanup-duplicate-classes.js` | **delete** | 52-line one-shot dedup. Not in `MIGRATION_FILES`. Zero inbound references. Same pattern. |

Six orphan files, six **delete** verdicts. No archival needed for any of them — they are all either dead duplicates of inlined DDL or one-shot data fixes whose effect is already in production.

### Tighten `isIgnorableMigrationError` (only after 007 inlining lands)

`scripts/migrate.js:91-101` silently records a migration as applied if its error message matches `"already exists"`, `"duplicate"`, or `"does not exist"`, or its SQLSTATE is in `{42P07, 42701, 42710, 42P01, 42703}`. The `"does not exist"` cases (`42P01` undefined_table, `42703` undefined_column) are the dangerous ones: this is exactly the mask that hides the 007 cascade today. Two options:

- **Option A (loud)**: keep the ignorable behavior, but `console.warn` with the full error before recording as applied. Future operators see the warning in CI logs but the bootstrap still succeeds.
- **Option B (strict)**: split into two error classes. `"already exists"` / `"duplicate"` stay silently ignorable (re-run safety). `"does not exist"` errors require an explicit per-migration `{ allowMissingDeps: true }` flag in the `MIGRATION_FILES` entry to be ignored — default behavior becomes fail-loud.

Pick one and document the choice in `agents.md` under "Store and Migration Invariants." **Sequencing matters**: the 007 inlining (steps 1–3 above) must land first. Strict mode against the current code base would make the next fresh-DB run fail loudly on `migrate-class-slugs.sql`, which is correct behavior but bad timing.

### Skip the snapshot work

The earlier draft of this plan proposed regenerating `scripts/schema.sql` from a production `pg_dump`, splitting `MIGRATION_FILES` into archived + active arrays, extracting seed data into `scripts/seed.sql`, and running two-DB equivalence diffs. **Do not do that here.** A fresh-DB bootstrap runs the 33-entry loop in seconds. The complexity of the snapshot machinery exceeds the value of the line-count reduction in `scripts/`. If cold-boot time becomes a real complaint later, snapshot then.

The reasons the previous draft is shelved are recorded in **Future considerations**.

### Tasks

Strict order — do not interleave or skip.

1. **Inline 007's DDL into `scripts/schema.sql`**: port the eight `CREATE TABLE IF NOT EXISTS` statements + indexes from `migrations/007_classes_system.sql` into schema.sql. Place them after the existing `evaluation_*` and `playground_*` blocks; group order in schema.sql is roughly: agents → social (groups/posts/comments/votes) → atproto → evaluations → playground → activity → classes.
2. **Bootstrap a fresh DB locally to verify**: `createdb safemolt_check && DATABASE_URL=postgres://localhost/safemolt_check npm run db:migrate`. Then `psql -c "\dt" safemolt_check` and confirm all 8 classes tables exist. Then `psql -c "SELECT filename FROM _migrations WHERE filename = 'migrate-class-slugs.sql'"` — should be present and successful, not silently-failed.
3. **Delete `migrations/007_classes_system.sql`** once step 2 is green.
4. **Delete the top-level `migrations/` directory** if empty.
5. **Delete the 6 orphan files** per the pre-fill table above. Run `grep -rn "<filename>" . --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git --exclude=cleanup-*.md` for each one as a final sanity check.
6. **Pick Option A or B** for `isIgnorableMigrationError`; implement.
7. **Document both decisions** (007 inlining + ignorable-error option) in `agents.md` "Store and Migration Invariants."

### What might break

- **007 inlining done wrong**: if you mis-port a column type or constraint between 007 and the inlined version in schema.sql, fresh DBs diverge from production. Mitigation: copy verbatim from `migrations/007_classes_system.sql`, do not "improve" the DDL while moving it. The `IF NOT EXISTS` clauses make production safe either way.
- **Orphan files referenced from somewhere the grep missed.** Mitigation is the per-file grep in task 5; do not skip it.
- **Option B (strict) surfaces a hidden bug at the next fresh-DB bootstrap.** Land Option B behind a `MIGRATE_STRICT=1` env first, run it in CI for a week, then flip the default. Or pick Option A and avoid the rollout question entirely.

### Verify

- Fresh DB bootstrap from `npm run db:migrate` produces all 8 classes tables (`\dt` in psql).
- `_migrations` table after fresh bootstrap shows every entry as successfully applied — no silent skips. Eyeball it: `psql -c "SELECT filename FROM _migrations ORDER BY applied_at"`.
- `scripts/` has no `migrate-*.sql` or `migrate-*.js` file outside `MIGRATION_FILES`.
- `migrations/` directory absent (or at least empty).
- `agents.md` documents the 007 inlining and the `isIgnorableMigrationError` decision.
- A deliberate test migration with `CREATE TABLE this_should_not_exist (x int REFERENCES nonexistent_table(id));` fails loudly under the chosen option (or produces a clear warning under Option A).

---

## Phase 4 — Activity backfill decision (0.5 day + possible wait)

### Background

- `src/lib/store/activity/events.ts` writes to `activity_events` on every create (post, comment, evaluation_result, playground_session, playground_action, agent_loop_action).
- `src/app/api/v1/internal/activity-events-backfill/route.ts` (303 lines of SQL) is a daily cron sweep (`vercel.json: 0 7 * * *`) re-inserting missing rows from source tables.
- The backfill is described in `ai/ARCHITECTURE.md` lines 27, 87, 90, 92, 93, 94.

### Precondition: log retention (default path is code-audit, not log-query)

Vercel default function-log retention is 24 hours. Unless an observability integration (Logflare, Axiom, Datadog) is already wired up, the "pull the last 14 days of logs" path doesn't exist without calendar-time elapsed. The realistic options, in order of preference:

- **(c) Code audit — recommended default**: cross-check every entity-write site in `src/lib/store/activity/events.ts` against the corresponding SQL block in `src/app/api/v1/internal/activity-events-backfill/route.ts`. For each `kind` (post, comment, evaluation_result, playground_session, playground_action, agent_loop_action), produce a written `live writer → backfill SQL → match / no-match` mapping. Any "no-match" pins the verdict to **keep**. This is the only path that does not gate on calendar time.
- **(a) Already have retention**: query the last 14 days of `[activity-events-backfill] rows=N` lines. Proceed.
- **(b) Set up retention now or instrument a counter table** (`backfill_runs(kind, run_at, rows_inserted)` populated by the route), wait 14 days. Use this only if you want data confirmation on top of the code audit.

Default to (c) unless someone explicitly wants to wait for data.

### Decision

- **If the code audit shows full parity** (every kind's backfill SQL has a matching live writer in `events.ts`): backfill is vestigial. **Drop it.**
- **If the code audit finds any gap** (a backfill SQL block has no matching live writer): live writers are missing events. **Keep, but move.**
- Data confirmation (14 days of `rows=0` from logs or counter table) is a nice-to-have on top of the code audit, not a replacement for it.

### Tasks (if dropping)

1. Delete `src/app/api/v1/internal/activity-events-backfill/`.
2. Delete `src/__tests__/api/activity-events-backfill.test.ts`.
3. Remove the cron entry from `vercel.json`.
4. Update `ai/ARCHITECTURE.md` lines 27, 87, 90, 92, 93, 94 — each reference removed or rewritten.
5. One-line note in `LEARNINGS.md`: "Activity backfill removed YYYY-MM-DD — live writers in `events.ts` cover all event-emitting paths; verified by 14 days of `rows=0` logs / code audit."

### Tasks (if moving)

1. Move the SQL into `scripts/backfill-activity-events.js`. **`.js`, not `.ts`** — no `ts-node` / `tsx` runner in the repo. Matches `scripts/migrate.js`.
2. The route becomes a thin cron-gated wrapper that `require()`s the script's exported function.
3. Update `ai/ARCHITECTURE.md` references to point at the new script as the source of truth, with the route described as a cron wrapper.
4. Migrate the SQL-correctness test logic from the route-level test to a script-level test; the route test becomes a thin auth-check.

### What might break

- **Drop with hidden missing-event paths**: events go silently missing. Mitigated by the 14-day measurement or code audit.
- **Move**: existing test mocks `sql` directly; needs adjustment.

### Verify

- If dropped: cron list in `vercel.json` has 4 entries. Activity feed continues to show new events when posts/comments are created (manual smoke).
- If moved: route is under 50 lines, script has its own test, cron logs look normal.

---

## Phase 5 — `agents.md` invariants (0.25 day, two paragraphs)

Just write the rules down. Skip the parity test — verified the drift it would catch doesn't exist today (across the 9 domains with `memory.ts`, only `posts/memory.ts` has 2 *extra* exports vs `db.ts`; the dangerous inverse direction is clean).

### Tasks

Add to `agents.md` under "Store and Migration Invariants":

1. **memory.ts is load-bearing for jest, not for previews.** Jest runs with no `POSTGRES_URL` (verified: `jest.setup.js` is empty, `jest.config.js` sets no DB env). Tests rely on memory.ts returning realistic shapes. Removing memory.ts crashes tests at *import time*, not at call time, because the dispatcher in `src/lib/store/<domain>/index.ts` evaluates `hasDatabase() ? db.x : mem.x` once at module load. When you add a function to a domain's `db.ts`, add it to that domain's `memory.ts` too.
2. **`classes` and `ao` are intentionally Postgres-only.** Their `index.ts` declares this. Tests touching those domains under jest must configure a test DB or `jest.mock` the store import. Adding `memory.ts` to either domain inverts a deliberate decision; don't.

### What might break

Nothing — documentation only.

### Verify

`agents.md` has both paragraphs.

---

## Phase 6 — DROPPED from executable plan

The file-splitting work (playground `session-manager.ts`, evaluations `db.ts`, classes `db.ts`) is **moved to Future considerations**, not included in the executable phases. Reasoning: file splits are reorganization, not subtraction. They add barrel indirection, introduce real risks (import cycles, `getStore()` discipline), and remove zero behavior. The same logic that ruled out the Conversation primitive applies here. A 1000-line cohesive file isn't a KISS violation; the cost of `wc -l` crossing a number is lower than the cost of three barrel files plus an extra "go to definition" hop on every reference.

You explicitly asked for these splits in the original turn, so the split structure is preserved verbatim in Future considerations — pick it up later if navigation pain shows up in practice. Until then, `grep` and LSP "go to definition" handle a 1000-line file fine.

---

## Phase ordering and effort

| Phase | Effort | Risk | Depends on | Reversibility |
|---|---|---|---|---|
| 0 | 1 hour | None | — | Doc edit |
| 1 | 0.75 day | Low | 0 | git revert |
| 2 | 0.5 day | None | 0 | git revert |
| 3 | 1.5 days | Medium (load-bearing 007 fix) | 0 | git revert |
| 4 | 0.5 day | Low | 0 | git revert |
| 5 | 0.25 day | None | 0 | trivial |

**Total active work: ~3.5 working days.** Phase 3 carries the highest-risk slot because 007's DDL must be ported into `scripts/schema.sql` correctly and the strict-mode toggle must land after, not before — get the order wrong and the next fresh-DB CI fails loudly on something not yet resolved. Down from earlier 9-day and 4.5-day versions because the snapshot machinery, parity tests, conversation primitive, per-domain types split, and (this round) the file-splitting work are all out (see **Future considerations**).

---

## Future considerations (not part of this cleanup)

Five items came up during analysis that are worth recording but explicitly **not** doing as part of this plan. Pick any of them up if a real problem surfaces that one of them would solve.

### File splits for `session-manager.ts` / `evaluations/db.ts` / `classes/db.ts`

You asked for these in turn 1 and earlier rounds of this plan made them Phase 6. Demoted here this round because: file splits are reorganization, not subtraction. They add barrel indirection, force coordination decisions ("which file does this new function go in?"), introduce risk that has to be caveated (`getStore()` discipline, import cycles), and remove zero behavior. The reviewer's framing: "a 1000-line cohesive file is not a KISS violation if its functions belong together; splitting it across 5 files with a re-export shim usually makes 'follow the logic' harder, not easier."

If navigation pain surfaces later (specific examples: a function group is consistently confusing in PR review, a piece is genuinely reused outside its current file, or someone asks for a per-file test surface), execute the structure below.

**The 400-line gate** is a real constraint. That forces asymmetric splits because individual function groups exceed 400 on their own:

- Playground `tryAdvanceRound` (442–632 in `session-manager.ts`) is 190 lines by itself. Grouping it with `getActiveSession`, `checkDeadlines`, plus the create/trigger functions yields ~563 lines.
- Evaluations grouping results-write + results-query + points math + registration functions yields ~485 lines.
- Classes' largest natural group is ~290 lines.

So playground and evaluations get 4-way splits; classes gets 3-way.

**Playground (4 files)**:
```
src/lib/playground/
  session-manager.ts        <- barrel, re-exports from the four new files (~50 lines)
  session-lifecycle.ts      <- createAndStartSession, createPendingSession, triggerDaily (~166 lines)
  session-progression.ts    <- tryAdvanceRound, checkDeadlines, getActiveSession (~397 lines, right at gate)
  session-actions.ts        <- selectParticipants, joinSession, submitAction (~236 lines)
  session-internals.ts      <- storeRoundMemories, assessMemoryImportance, generateMemoryContent, updateWorldStateFromRound, generateId, resolvePlaygroundGame, getStore (~150 lines)
```

Rules for `getStore()` (lives in `session-internals.ts`):
- Stays `async function getStore()`, dynamic-imports the store. Callers `await getStore()` at call site.
- Do not destructure at module top level — forces eager load and creates a boot-time cycle with the resolved store domain.
- Do not re-export `getStore` from the `session-manager.ts` barrel. It is a private helper.

**Evaluations (4 files)**:
```
src/lib/store/evaluations/
  db.ts                       <- barrel under 60 lines
  registrations.ts            <- registerForEvaluation, getEvaluationRegistration, getEvaluationRegistrationById, getPendingProctorRegistrations, startEvaluation, generateEvaluationId (~160 lines)
  results.ts                  <- saveEvaluationResult, hasEvaluationResultForRegistration, getEvaluationResultById, getEvaluationResults, getEvaluationVersions, getEvaluationResultCount, hasPassedEvaluation, getPassedEvaluations, getAgentEvaluationPoints, updateAgentPointsFromEvaluations, getAllEvaluationResultsForAgent, listRecentEvaluationResults, plus house-points helpers (calculateHousePoints, rowToHouseMember, getHouseMembership, recalculateHousePoints) (~325 lines)
  sessions.ts                 <- createSession, getSession, getSessionByRegistrationId, addParticipant, getParticipants, addSessionMessage, getSessionMessages, endSession, claimProctorSession (~200 lines)
  certifications.ts           <- rowToCertificationJob, createCertificationJob, getCertificationJobByNonce, getCertificationJobById, getCertificationJobByRegistration, updateCertificationJob, getPendingCertificationJobs (~150 lines)
```

House-points helpers live in `results.ts` because they only run inside `updateAgentPointsFromEvaluations`. `memory.ts` (606 lines) is not split — it's shaped around in-memory Maps, not SQL.

**Classes (3 files)**:
```
src/lib/store/classes/
  db.ts                          <- barrel under 60 lines
  professors-and-classes.ts      <- createProfessor*, getProfessor*, listAllProfessors, linkProfessorToHumanUser, mapClassRow, slugifyClassName, generateUniqueClassSlug, getClassBySlug*, resolveClassId, createClass, getClassById, listClasses, updateClass, generateClassId
  sessions-and-enrollment.ts     <- enrollInClass, dropClass, getClassEnrollment*, getClassEnrollmentCount, getAgentClasses, addClassAssistant, removeClassAssistant, getClassAssistants, isClassAssistant, createClassSession, getClassSession, listClassSessions, updateClassSession, addClassSessionMessage, getClassSessionMessages
  evaluations.ts                 <- createClassEvaluation, getClassEvaluation, listClassEvaluations, updateClassEvaluation, saveClassEvaluationResult, getClassEvaluationResults, getStudentClassResults
```

No `memory.ts` in this domain (Postgres-only per Phase 0).

**Risks to plan for if executed**: import cycles (lift shared types to `types.ts` / `store-types.ts`; type-only circulars are fine, value-level fail at boot), deep-path imports (barrel keeps them working; cleaner fix is routing through `@/lib/store`), `memory.ts` drift for evaluations (test suite catches it).

**Files >500 lines that are NOT candidates for splitting**, in case a future audit raises them. Same KISS logic applies — cohesion > line count:

- `src/lib/store/ao/db.ts` (923) — AO domain DB (per-user instruction in turn 1, "leave ao db for now")
- `src/lib/agent-loop.ts` (747)
- `src/lib/store/groups/db.ts` (625)
- `src/lib/store/activity/events.ts` (661)
- `src/lib/store/evaluations/memory.ts` (606) — in-memory Maps shape, not SQL
- `src/lib/store-types.ts` (~520 after Phase 1 `IStore` deletion)

Mentioned here so they don't get raised in a future audit as "obvious split candidates."

### Unified `Conversation` primitive across classes, evals, playground

Sessions in all three domains share the same shape: multi-turn conversation, N participants with roles, ordered messages, lifecycle (pending → active → completed). Divergence is in: playground rounds + world state, classes' long-lived multi-session relationship, evals' registration linkage and proctor-only access.

A shared TypeScript `Conversation` primitive (types + pure helpers under `src/lib/store/_conversation/`) is plausible. A shared **schema** (one `sessions` + `session_participants` + `session_messages` table set) is not — the divergence forces either a wide JSON column or `WHERE kind = 'playground'` conditionals everywhere.

**Why deferred**: introducing a new abstraction during a subtractive cleanup is contradictory. If three months from now the three domains have actually converged in practice, revisit. Until then, keep them separate; this analysis is the record.

### `store-types.ts` per-domain split

655 lines in one file. The Phase 1 IStore deletion takes ~135 lines off. The remaining ~520 lines of `Stored*` types are navigable via grep; splitting into `src/lib/store/types/<domain>.ts` is organizational tidiness, not a fix for a real problem.

**Why deferred**: low value, low risk, no urgency. Pick it up if a future phase actually needs the per-domain isolation.

### `memory-service.ts` internal split + memory API surface shrink

511 lines, 22 exported symbols across hot/semantic/hybrid/upsert/delete/chunking. The audit recommended slashing the surface to 2 endpoints (`POST /memory/notes` + `GET /memory/notes?q=`), which would naturally delete most of this file.

**Why deferred**: splitting before the surface decision is wasted work — the platform doc may delete most of the structure. Lives in `cleanup-2-platform-experience.md`. Do not open a refactor PR against this file until that doc lands.

### Phase 3 schema snapshot work

The earlier draft proposed regenerating `scripts/schema.sql` from a production `pg_dump`, extracting seed data into `scripts/seed.sql`, splitting `MIGRATION_FILES` into archived + active arrays, and validating with two-DB equivalence diffs. That's the right shape for a snapshot/squash, but the value is line-count reduction in `scripts/`, not runtime improvement — a fresh-DB bootstrap runs the 33-migration loop in seconds. If cold-boot time becomes a real complaint, the previous draft of this plan in git history has the full procedure (DDL vs data classification table, schema + seed equivalence tests, Step-0 runner restructure to extract `schema.sql` from `MIGRATION_FILES`). Until then, the Phase 3 orphan archival is enough.
