# M8 plan: Subtractive repo cleanup, migration hygiene, and archive pruning

## Summary

M8 turns `ai/cleanup-1.md` into an executable milestone. The goal is not to redesign SafeMolt or invent new structure; it is to remove stale code, archive completed planning artifacts, fix one fresh-database migration hole, and write down a few invariants that future agents keep rediscovering.

This is a subtraction-first milestone:

1. Remove confirmed-dead files, stale scripts, transient validation artifacts, and one-line wrappers.
2. Archive completed milestone and implementation-plan documents so `ai/` and `docs/` read like current references.
3. Inline the legacy classes DDL into `scripts/schema.sql`, then delete the old top-level `migrations/` path.
4. Tighten the migration runner so missing-table or missing-column errors fail loudly after the classes schema hole is fixed.
5. Decide the activity-events backfill fate with a written live-writer parity audit; default to dropping the cron if parity is complete.
6. Add durable repo invariants to `agents.md`.

Important corrections to `ai/cleanup-1.md` that are locked into M8:

- Do **not** delete `public/class-previews/when-to-make-yourself-obsolete.png` or `public/class-previews/`. The asset is referenced by `schools/foundation/classes/democracy-as-literacy.yaml` through `preview_image`, and the classes list/API read that syllabus field. Removing it would be a visible product regression, not dead-code cleanup.
- `scripts/backfill-playground-prefabs.js` is currently absent while `package.json` still points at it. Remove the stale npm script; only delete the underlying file if it exists at execution time and still has zero references.
- `src/app/cohorts/page.tsx` is a useful AO back-compat redirect. Keep it and document the reason in `ai/ARCHITECTURE.md`, not `LEARNINGS.md`, because this is product routing behavior rather than durable engineering wisdom.
- The activity backfill has matching live writers today by code inspection, but M8 still requires the executor to produce a written mapping before deletion. If the audit finds any gap, move the backfill SQL to a script instead of dropping it.

Out of scope:

- No AT Protocol cleanup. XRPC routes, `src/lib/atproto/*`, `@atproto/crypto`, `@atproto/repo`, `@noble/curves`, `multiformats`, and `.well-known/*` stay.
- No platform/product cuts from `cleanup-2-platform-experience.md`.
- No memory API shrink, onboarding rewrite, route collapse, skill.md trim, or inbox tooling.
- No file splitting for `session-manager.ts`, `evaluations/db.ts`, `classes/db.ts`, `store-types.ts`, or `memory-service.ts`.
- No schema snapshot/squash. The current migration loop is fast enough; M8 only fixes hygiene and correctness.

## HOW TO EXECUTE A MILESTONE

[Please include what follows verbatim when you write a PLAN_M{n}.md file. It will be used to guide anyone who executes on your plan.]

If the user asks you to execute on a plan, these are the steps to take.

1. Implement the plan
   - You should check your work with AI autonomous validation and testing.
   - The hope is that implementation can be done with a minimum of user interaction, preferably none at all.
   - Once it is complete, fill in the "Validation" section to the bottom of the plan showing how you have validated it and what were the results.
   - You might have discovered better engineering
2. Perform your testing and validation
   - Update the "AI VALIDATION RESULTS" section of your PLAN_M{n}.md file
3. Review your own code. Also, ask Claude to review your work
   - You will need to provide it contect: your plan document PLAN_M{n}.md, and tell it which files or functions you've worked on. Ask it also to review your validation steps.
   - If Claude found no blockers or problems with your work, you may proceed. Do static checking (formatting, eslint, typechecking). If you need any fixes, static check again to make sure it's clean.
   - If you couldn't get Claude to run for whatever reason, the user wants you to abort and report what's wrong.
   - Keep iterating with Claude until you no longer make changes (either because you've taken on Claude's feedback from past rounds, or because your plan no successfully defends its positions so Claude accepts them). However, if you take more than 10 rounds, then somethig is wrong, so stop and let the user know.
   - We aren't looking for "blocker vs non-blocker" decisions. Instead for every suggestion from Claude you must evaluate "will this improve my code? if so then modify your code, and if not then pre-emptively defend (in code comments) why not". And if you made modifications or comments, then circle back with Claude again.
   - Do NOT reference previous rounds when you invoke it: Claude does best if starting from scratch each round, so it can re-examine the whole ask from fundamentals. Note that each time you invoke Claude it has no memory of previous invocations, which is good and will help this goal! Also, avoid asking it something like "please review the updated files" since (1) you should not reference previous rounds implicitly or explicitly, (2) it has no understanding of what the updates were; it only knows about the current state of files+repo on disk.
4. After implementation, do a "better engineering" phase
   - Clean up LEARNINGS.md and ARCHITECTURE.md. If any information there is just restating information from other files then delete it. If it would belong better elsewhere, move it. Please be careful to follow the "learnings decision tree" -- LEARNINGS.md for durable engineering wisdom, ARCHITECTURE.md for things that will apply to CodexAgent.ts in its finished state, PLAN_M{n}.md for milestone-specific notes
   - You will have several Claude review tasks to do, below. You must launch all the following Claude review tasks in parallel, since they each take some time: prepare all their inputs, then execute them all in parallel. You should start addressing the first findings as soon as you get them, rather than waiting for all to be consolidated. You can be doing your own review while you wait for Claude.
   - (1) Review the code for correctness. Also ask Claude to evaluate this.
   - (2) Validate whether work obeys the codebase style guidelines in AGENTS.md. Also ask Claude to evaluate this. The user is INSISTENT that they must be obeyed.
   - (3) Validate whether the work obeys each learning you gathered in LEARNINGS.md. Also ask Claude to evaluate this. (A separate instance of Claude; it can't do too much in one go).
   - (4) Validate whether the work has satisfied the milestone's goals. Also ask Claude to evaluate this.
   - (5) Check if there is KISS, or consolidation, or refactoring that would improve quality of codebase. Also ask Claude the same question.
   - If you make changes, they'll need a pass of static checking (formatting, eslint, typechecking), and again to make sure it's clean.
   - You might decide to do better engineering yourself. If not, write notes about whats needed in the "BETTER ENGINEERING INSIGHTS" section of the plan.
   - Tell the user how you have done code cleanup. The user is passionate about clean code and will be delighted to hear how you have improved it.
5. Upon completion, ask for user review. Tell the user what to test, what commands to use, what gestures to try out, what to look for

## Locked user decisions

1. **Subtraction, not reorganization.** M8 removes or archives things that are already dead, stale, duplicated, or misleading. It does not split large cohesive files merely because they are long.
2. **Ambiguity fails closed.** When repo evidence, environment access, or production data is ambiguous, leave the file/script/shim in place and record the blocker in AI VALIDATION RESULTS.
3. **No product cuts in M8.** Platform/product changes live in `cleanup-2-platform-experience.md` and future plans.
4. **AT Protocol is out of scope.** Keep every AT Protocol dependency, route, and helper even if an audit flags them as unusual.
5. **Production has a database.** The production build runs `node scripts/migrate.js && next build`; no DB URL means the migration runner exits 1. Memory mode is for Jest and local no-DB development, not production previews.
6. **Memory stores are test infrastructure.** Do not delete `memory.ts` files. When a domain has both `db.ts` and `memory.ts`, new store functions must exist on both sides.
7. **`classes` and `ao` remain Postgres-only.** Their facades intentionally say so. Do not add memory implementations for those domains as part of cleanup.
8. **Keep class preview images while YAML references them.** `schools/foundation/classes/democracy-as-literacy.yaml` points at `/class-previews/when-to-make-yourself-obsolete.png`; `src/app/classes/page.tsx` and `src/app/api/v1/classes/route.ts` surface `preview_image`. This asset is live.
9. **Keep the AO cohorts redirect.** `src/app/cohorts/page.tsx` preserves old AO links to `/companies#venture-studio-cohorts`. Its value is greater than the 10 lines it costs.
10. **Choose strict migration failure after the classes DDL is inlined.** Implement the strict option: duplicate/already-exists errors can remain ignorable, but undefined-table (`42P01`) and undefined-column (`42703`) errors must fail by default. Do not leave `"does not exist"` in the broad ignorable path.
11. **Do not remove `DEMO_DAILY_REQUEST_LIMIT` until environment state is known.** If Vercel env inspection is unavailable or inconclusive, leave the fallback in code and record the blocker. Remove it only after verifying prod, preview, and dev envs do not set it.
12. **Activity backfill defaults to removal only after proof.** The executor must write a live-writer parity table before deleting the cron route. Any mismatch flips the action to "move SQL into a script and keep the route as a thin wrapper."
13. **No new dependencies.** Removing dependencies is in scope; adding dependencies is not.

## PLAN

### Phase 0 - Preflight and current-state notes

Goal: make sure the cleanup starts from current repo truth rather than stale audit memory.

1. Record the current branch and working tree:
   - `git status --short`
   - If unrelated user changes exist, do not revert them. Work around them or pause only if they make cleanup impossible.
   - `ai/PLAN_M8.md` and `ai/cleanup-1.md` are M8 planning inputs and must remain in place; `ai/cleanup-1.md` is read-only input evidence.

2. Confirm core commands and package manager are available:
   - `npm --version`
   - `node --version`
   - `npx --version`
   - If the executor shell cannot see npm but a login shell can, run command gates through the login shell and document that in validation results.

3. Production access protocol for M8 checks:
   - For production or preview DB queries, use a masked connection string from the deployment environment or `vercel env pull` into a temporary untracked path.
   - Never write raw DB URLs, tokens, or env values into `ai/PLAN_M8.md`, terminal logs intended for commit, screenshots, or docs.
   - Validation results may include the query, row count, masked host/project name, and a statement that the secret was loaded from a temporary env file.
   - A production-history scratch branch, restored production snapshot, or existing preview/staging DB with real `_migrations` history is a precondition for Phase 3 completion. If none is available, stop before Phase 3 rather than discovering the blocker mid-migration.
   - If production/preview access is unavailable, record the literal blocker reason and take the safe branch: do not delete compatibility shims or one-shot backfills that depend on that query.

4. Add a short "M8 cleanup invariants" subsection to `agents.md` under "Store and Migration Invariants":
   - All M8 convention edits target the git-tracked lowercase `agents.md`. Do not create a separate uppercase `AGENTS.md` on case-sensitive filesystems.
   - `claude.md` is a tracked symlink to `agents.md`; `CLAUDE.md` and `AGENTS.md` are not tracked and exist only as case-insensitive views on macOS. Edit `agents.md` only.
   - AT Protocol is excluded from cleanup unless the user explicitly reopens it.
   - Production builds require a DB URL because `scripts/migrate.js` runs before `next build`.
   - Memory stores are load-bearing for Jest and should not be treated as preview fallback code.
   - `classes` and `ao` are intentionally Postgres-only.

5. Do not edit `ai/cleanup-1.md`; it is input evidence. Put corrections in this M8 plan and in durable docs where needed.

Validation:

- `agents.md` contains the M8 cleanup invariant subsection, including the lowercase `agents.md` filename note.
- No code changed in Phase 0 except docs.

### Phase 1 - Dead-code and stale-script sweep

Goal: delete only targets that are demonstrably dead, then prove no hidden references remain.

Run the pre-delete grep from the repo root before each deletion:

```bash
rg -n "<target string>" . --glob '!node_modules/**' --glob '!.next/**' --glob '!.git/**'
```

Delete or edit the following:

1. Delete `src/lib/mock-data.ts`.
   - Expected references: none outside cleanup/plans.
   - If a real caller appears, inline the fixture into that caller or leave the file and record why.

2. Delete `scripts/sync-evaluations.ts`.
   - Edit `src/lib/evaluations/sync.ts` to remove the stale comment that names this manual script. Do not rewrite it into a new script reference.
   - Do not introduce a TS script runner.

3. Remove root `@modelcontextprotocol/sdk` from `package.json`.
   - Use `npm install` after editing `package.json` so the lockfile changes mechanically.
   - Do not hand-edit `package-lock.json`. Do not use `--package-lock-only` for this change.
   - Commit only lockfile changes related to removing the root MCP SDK package. Investigate and revert unrelated lockfile drift before committing.
   - Keep `packages/safemolt-memory-mcp/package.json` untouched; that package owns its own MCP dependency.
   - Because `packages/safemolt-memory-mcp` is not an npm workspace, the later `cd packages/safemolt-memory-mcp && npm install && npm run build` gate is load-bearing, not an optional smoke.

4. Delete `IStore` from `src/lib/store-types.ts`.
   - First confirm `rg -n ': IStore|implements IStore|<IStore>' src` is empty.
   - Remove only the unused interface block.
   - Do not split `store-types.ts` in M8.

5. Delete transient validation artifacts:
   - Delete empty `ai/m6-validation/`.
   - Delete `ai/m7-validation/` and its generated logs.

6. Delete `public/party-parrot.gif`.
   - Keep `public/class-previews/` and its PNG.

7. Delete `.kilo/`.

8. Inline the playground component wrapper:
   - Change `src/app/playground/page.tsx` from `import { PlaygroundContent } from "./PlaygroundContent";` to `import { PlaygroundContent } from "@/components/playground/PlaygroundContent";`.
   - Delete `src/app/playground/PlaygroundContent.tsx`.

9. Refresh stale comments:
   - In `src/app/api/v1/agents/status/route.ts`, clarify only if needed that the route itself is repurposed, not retired: it no longer reports enrollment status; it now returns claim status, the latest announcement, and curated news headlines for agent onboarding.
   - Do not delete the route; `public/skill.md` documents it.

10. Audit legacy Public AI slug upgrade:
   - Run this against production or a production-shaped DB:
     ```sql
     SELECT COUNT(*) AS legacy_public_ai_agents
     FROM agents
     WHERE name LIKE 'publicai_%'
       AND (metadata->>'public_ai_handle_style' IS NULL OR metadata->>'public_ai_handle_style' != 'v2');
     ```
   - Before deleting anything, run `rg -n "publicAiAgentNameForUser|maybeUpgradeLegacyPublicAiSlug" . --glob '!node_modules/**' --glob '!.next/**' --glob '!.git/**'`. The only allowed hits are the helper declarations and the single call inside `src/lib/provision-public-ai-agent.ts`.
   - If extra hits exist, treat each as a real caller, leave both helpers in place, and record the additional call sites in validation results.
   - If the count is zero, delete `publicAiAgentNameForUser`, `maybeUpgradeLegacyPublicAiSlug`, and the call in `ensureProvisionedPublicAiAgent`.
   - If the count is nonzero or the query cannot be run, leave the upgrade path in place and record the count/blocker in validation results.

11. Keep `src/app/cohorts/page.tsx`.
   - Add or keep a comment explaining that the route preserves AO links after cohorts moved to Companies.
   - Add one note to `ai/ARCHITECTURE.md` under AO routes or the file map if that architecture note is not already present.

12. Remove stale npm scripts from `package.json`:
   - Remove `"perf:smoke": "node scripts/perf-smoke.js"`.
   - Remove `"perf:trace": "node scripts/analyze-route-trace.js"`.
   - Remove `"playground:backfill-prefabs": "node scripts/backfill-playground-prefabs.js"`.
   - Delete `scripts/perf-smoke.js` and `scripts/analyze-route-trace.js`.
   - `scripts/backfill-playground-prefabs.js` is currently absent; this collapses to removing the package script only. If the file exists at execution time and has no references, delete it.
   - Keep `"preview:smoke": "node scripts/preview-smoke.js"`.

13. `DEMO_DAILY_REQUEST_LIMIT` shim:
   - Inspect Vercel envs for production, preview, and development. Acceptable evidence: `vercel env ls`, `vercel env pull` outputs, or a dashboard-confirmed note.
   - If no env uses `DEMO_DAILY_REQUEST_LIMIT`, simplify the four call sites to `process.env.PUBLIC_AI_SPONSORED_DAILY_LIMIT || "100"`:
     - `src/app/dashboard/page.tsx`
     - `src/app/api/dashboard/sponsored-inference-status/route.ts`
     - `src/lib/human-users-memory.ts`
     - `src/lib/human-users-db.ts`
   - If any env still uses it, rename that Vercel env to `PUBLIC_AI_SPONSORED_DAILY_LIMIT` first, then simplify.
   - If env inspection is blocked, do not edit the four call sites.

Do not touch:

- `src/lib/agent-onboarding-copy.ts`
- `src/lib/agent-identity-generator.ts`
- `src/lib/public-ai-agent-naming.ts`
- `public/class-previews/`
- any `memory.ts` file
- AT Protocol code or deps

Validation:

- `rg -n "mock-data|sync-evaluations|party-parrot|src/app/playground/PlaygroundContent|perf:smoke|perf:trace|playground:backfill-prefabs" . --glob '!node_modules/**' --glob '!.next/**' --glob '!.git/**' --glob '!ai/archive/**' --glob '!docs/archive/**' --glob '!ai/PLAN_M8.md' --glob '!ai/cleanup-1.md'` returns only intentional non-archived references or no hits.
- `rg -n "@modelcontextprotocol/sdk" package.json package-lock.json src` has no root package hits and no `src` hits.
- `npm ls @modelcontextprotocol/sdk` at the repo root shows empty.
- `cd packages/safemolt-memory-mcp && npm install && npm run build` succeeds.

### Phase 2 - Archive completed plans and docs

Goal: make current planning surfaces current again.

1. Create archive directories:
   - `ai/archive/`
   - `docs/archive/`
   - Add `.gitkeep` only if a directory would otherwise be empty.

2. Move completed AI planning artifacts with `git mv`:
   - `ai/PLAN_M1.md` through `ai/PLAN_M7.md`
   - `ai/PLAN_M2_5.md`
   - `ai/PLAN_REVIEW_FINDINGS.md`
   - `ai/CLAUDE_REVIEW_DASHBOARD_ACTIVITY_PLAYGROUND.md`
   - `ai/validation/` to `ai/archive/m1-validation/`
   - Leave `ai/PLAN_M8.md`, `ai/PLAN.md`, `ai/ARCHITECTURE.md`, and `ai/DESIGN.md` at top level.

3. Audit the 21 `docs/*_PLAN.md` files:
   - First pass: read each doc's top-level deliverable. If the named route/page/schema/feature clearly exists today and the doc is not the canonical future plan, move it to `docs/archive/`.
   - Ambiguous pass: for unclear docs, check 2-3 concrete sub-deliverables with `rg`/`ls`.
   - Outcomes per doc:
     - Archive if fully shipped or obsolete.
     - Leave in place if still an active future plan.
     - If partially shipped, add this one-line header at the top and leave in place:
       `**Status:** Partially implemented as of YYYY-MM-DD; see <paths>.`
   - Do not archive reference docs that are not `*_PLAN.md`, such as `COGNITO_AUTH.md`, `PUBLIC_AI_PROVISIONING.md`, `playground.md`, `inbox.md`, `DESIGN_AESTHETIC.md`, `CLASSES_CURL_TUTORIAL.md`, and `CLASSES_SYSTEM.md`.

4. Delete root `TODOS.md` after preserving unique backlog:
   - If `TODOS.md` is absent at execution time, the delete step is a no-op; still create the `## Backlog` section in `ai/PLAN.md` from the items listed below.
   - `docs/MPP_MARKETPLACE_POC_PLAN.md` already covers the MPP marketplace item.
   - Add a `## Backlog` section to `ai/PLAN.md` before deleting `TODOS.md`. Put this backlog section after the existing HOW TO PLAN/HOW TO EXECUTE instructional content under a clear divider; this is intentional because `ai/PLAN.md` is the canonical planning surface. First grep `ai/PLAN.md` for each item and do not duplicate items already covered there. Preserve these items if absent: Admissions/Careers pages, Research API/Data Firehose, Visual Identity, Network-Based Site Structure, Visually-Driven Classes, and Agent Labor Markets. Note that the MPP marketplace item remains canonical in `docs/MPP_MARKETPLACE_POC_PLAN.md`.
   - Add to `agents.md`: "Roadmap and what's-next planning lives under `## Backlog` in `ai/PLAN.md`; do not create parallel TODO/planning files at the repo root."

5. Fix stale links after moves:
   - Run:
     ```bash
     rg -n "docs/.*_PLAN.md|ai/PLAN_M|ai/validation|ai/m6-validation|ai/m7-validation" . \
       --glob '!node_modules/**' --glob '!.next/**' --glob '!.git/**' \
       --glob '!ai/archive/**' --glob '!docs/archive/**' --glob '!ai/cleanup-1.md'
     ```
   - Update any non-archived references to the new archive path, or remove the sentence if it no longer belongs.

Validation:

- Top-level `ai/` contains only current references, `PLAN_M8.md`, and the read-only cleanup input file if it is still needed as execution evidence.
- `docs/archive/` contains archived plan docs; current future plans remain in `docs/`.
- The stale-link grep returns no non-archived stale links.

### Phase 3 - SQL and migration hygiene

Goal: make fresh DB bootstrap honest and make `scripts/` legible.

Strict order matters. Do not tighten `isIgnorableMigrationError` before the classes DDL is inlined.

1. Inline `migrations/007_classes_system.sql` into `scripts/schema.sql`.
   - Copy the eight `CREATE TABLE IF NOT EXISTS` blocks verbatim:
     - `professors`
     - `classes`
     - `class_assistants`
     - `class_enrollments`
     - `class_sessions`
     - `class_session_messages`
     - `class_evaluations`
     - `class_evaluation_results`
   - Copy the 007 indexes verbatim.
   - Preserve the within-file table order from `007_classes_system.sql` exactly: `professors` first, then `classes`, then `class_assistants`, and so on. Do not regroup the copied DDL.
   - Add this exact SQL comment above the inlined block:
     ```sql
     -- Classes system. school_id/slug/human_user_id are added by migrate-schools.sql, migrate-class-slugs.sql, and migrate-professor-users.sql respectively; do not inline them here.
     ```
   - In particular, do not add `classes.school_id` or its school FK to the copied `CREATE TABLE`; `scripts/migrate-schools.sql` adds that column before `migrate-class-slugs.sql` reads it. Do not add `professors.human_user_id`; `scripts/migrate-professor-users.sql` owns that later ALTER.
   - Place the block after the `agents` table exists, because `class_assistants`, `class_enrollments`, and `class_evaluation_results` reference `agents(id)`. Prefer the current grouping after the playground tables and before announcements/activity if that placement still satisfies the FK dependency.
   - Do not "improve" column types or constraints while moving.

2. Add an append-only classes/schools repair migration for existing DBs.
   - Create `scripts/migrate-classes-base-repair.sql`.
   - Append it to the end of `MIGRATION_FILES`. Do not insert it into the middle of the array; new SQL migrations are append-only entries in this runner.
   - The repair migration must be fully idempotent and safe to run on both fresh and historical databases.
   - Include the copied 007 classes DDL as `CREATE TABLE IF NOT EXISTS` blocks and indexes, preserving the same table order.
   - Include the school-scoping state from `scripts/migrate-schools.sql`, because historical DBs may have recorded that whole file as applied after it failed on the first `professors` reference:
     - `CREATE TABLE IF NOT EXISTS schools`
     - `CREATE INDEX IF NOT EXISTS idx_schools_subdomain`
     - `CREATE INDEX IF NOT EXISTS idx_schools_status`
     - `CREATE TABLE IF NOT EXISTS school_professors`
     - `ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_admitted BOOLEAN NOT NULL DEFAULT FALSE;`
     - `ALTER TABLE groups ADD COLUMN IF NOT EXISTS school_id TEXT REFERENCES schools(id) DEFAULT NULL;`
     - `CREATE INDEX IF NOT EXISTS idx_groups_school ON groups(school_id);`
     - `ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS school_id TEXT DEFAULT 'foundation';`
     - `CREATE INDEX IF NOT EXISTS idx_eval_results_school ON evaluation_results(school_id);`
     - `ALTER TABLE evaluation_registrations ADD COLUMN IF NOT EXISTS school_id TEXT DEFAULT 'foundation';`
     - `CREATE INDEX IF NOT EXISTS idx_eval_registrations_school ON evaluation_registrations(school_id);`
     - `ALTER TABLE playground_sessions ADD COLUMN IF NOT EXISTS school_id TEXT DEFAULT 'foundation';`
     - `CREATE INDEX IF NOT EXISTS idx_pg_sessions_school ON playground_sessions(school_id);`
     - `ALTER TABLE classes ADD COLUMN IF NOT EXISTS school_id TEXT DEFAULT 'foundation';`
     - `CREATE INDEX IF NOT EXISTS idx_classes_school ON classes(school_id);`
     - the Foundation School seed row with `ON CONFLICT (id) DO NOTHING`
   - Include the later professor field that may have been skipped on DBs where `professors` did not exist when `scripts/migrate-professor-users.sql` was recorded:
     - `human_users` must already exist before this ALTER. Phase 3 diagnostics check it explicitly; if a historical target lacks `human_users`, apply `scripts/migrate-dashboard-memory.sql` manually once with the Phase 0 production access protocol before running `npm run db:migrate`, then re-run the diagnostic. If that manual repair fails, block M8 rather than weakening the FK.
     - `ALTER TABLE professors ADD COLUMN IF NOT EXISTS human_user_id TEXT REFERENCES human_users(id);`
     - the unique `professors.human_user_id` index from `scripts/migrate-professor-users.sql`
   - Include the slug/alias repair from `scripts/migrate-class-slugs.sql`: add `classes.slug`, create `class_slug_aliases`, repair UUID-style IDs, backfill slugs, set `classes.slug` `NOT NULL`, and backfill aliases. Copy the existing slug logic rather than inventing a new slug algorithm.
   - Keep `scripts/migrate-class-slugs.sql` in its current `MIGRATION_FILES` position. The appended repair migration is for historical DBs whose earlier files were already recorded incorrectly.
   - Do not delete or mutate `_migrations` rows as part of M8. If diagnostics show an old DB recorded a skipped slug migration, the new repair migration fixes it under a new filename. If the repair migration fails, fix the repair migration; do not manually edit migration history.

3. Make `scripts/migrate-class-slugs.sql` succeed on a fresh DB and historical DBs.
   - After the inline, a fresh DB must have `classes` before `migrate-class-slugs.sql` runs.
   - On a fresh DB, `migrate-class-slugs.sql` must run to completion before the appended repair migration and must not be recorded through the ignorable-error SKIP path.
   - On a historical DB that already recorded a skipped `migrate-class-slugs.sql`, the appended repair migration must still leave `classes.slug` and `class_slug_aliases` present.
   - Do not remove `migrate-class-slugs.sql`; it remains in `MIGRATION_FILES` and adds slug/alias behavior.

4. Fresh and historical DB bootstrap validation:
   - Create a disposable local DB:
     ```bash
     dropdb --if-exists safemolt_m8_check
     createdb safemolt_m8_check
     DATABASE_URL=postgres://localhost/safemolt_m8_check npm run db:migrate
     ```
   - Confirm the class tables:
     ```bash
     psql -d safemolt_m8_check -c "\dt class*"
     psql -d safemolt_m8_check -c "\dt professors"
     ```
   - Confirm late-added class/professor columns:
     ```bash
     psql -d safemolt_m8_check -c "\d classes"
     psql -d safemolt_m8_check -c "\d professors"
     ```
     The output must show `classes.school_id` and `professors.human_user_id`.
   - Confirm school-scoping repair state:
     ```bash
     psql -d safemolt_m8_check -c "\dt human_users"
     psql -d safemolt_m8_check -c "\dt schools"
     psql -d safemolt_m8_check -c "\dt school_professors"
     psql -d safemolt_m8_check -c "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND ((table_name, column_name) IN (('agents', 'is_admitted'), ('groups', 'school_id'), ('evaluation_results', 'school_id'), ('evaluation_registrations', 'school_id'), ('playground_sessions', 'school_id'))) ORDER BY table_name, column_name;"
     psql -d safemolt_m8_check -c "SELECT COUNT(*) AS foundation_school_rows FROM schools WHERE id = 'foundation';"
     ```
   - Confirm both the repair migration and `migrate-class-slugs.sql` are recorded, and capture migration stdout showing `[Migration] SUCCESS:` for both labels rather than `[Migration] SKIP: ... (already applied or not needed)`:
     ```bash
     psql -d safemolt_m8_check -c "SELECT filename FROM _migrations WHERE filename IN ('migrate-classes-base-repair.sql', 'migrate-class-slugs.sql') ORDER BY filename;"
     ```
   - Also run `npm run db:migrate` against at least one existing preview/staging database, production-history scratch branch, or restored production snapshot that has real `_migrations` history, with secrets loaded through the Phase 0 production access protocol. Run this once after adding the repair migration and before tightening `isIgnorableMigrationError`, so the appended repair can heal databases with historical silent skips. After step 8 tightens the runner, run `npm run db:migrate` against the same target again under the strict policy; it may report earlier files as already recorded, but it must not fail or need missing-dependency skips.
   - If no existing preview/staging DB, production-history scratch branch, or restored snapshot is available, M8 is blocked. Do not mark M8 complete on fresh DB proof alone.
   - Run this diagnostic against production and every preview/staging/scratch/snapshot DB used for validation:
     ```sql
     SELECT
       to_regclass('public.classes') IS NOT NULL AS has_classes_table,
       EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'classes'
           AND column_name = 'slug'
       ) AS has_classes_slug,
       to_regclass('public.class_slug_aliases') IS NOT NULL AS has_class_slug_aliases,
       to_regclass('public.schools') IS NOT NULL AS has_schools_table,
       to_regclass('public.school_professors') IS NOT NULL AS has_school_professors_table,
       to_regclass('public.human_users') IS NOT NULL AS has_human_users_table,
       EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'classes'
           AND column_name = 'school_id'
       ) AS has_classes_school_id,
       EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'professors'
           AND column_name = 'human_user_id'
       ) AS has_professors_human_user_id,
       EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'agents'
           AND column_name = 'is_admitted'
       ) AS has_agents_is_admitted,
       EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'groups'
           AND column_name = 'school_id'
       ) AS has_groups_school_id,
       EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'evaluation_results'
           AND column_name = 'school_id'
       ) AS has_evaluation_results_school_id,
       EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'evaluation_registrations'
           AND column_name = 'school_id'
       ) AS has_evaluation_registrations_school_id,
       EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'playground_sessions'
           AND column_name = 'school_id'
       ) AS has_playground_sessions_school_id,
       EXISTS (
         SELECT 1
         FROM _migrations
         WHERE filename = 'migrate-class-slugs.sql'
       ) AS slug_migration_recorded;
     ```
   - If the pre-migration diagnostic shows `has_human_users_table = false`, apply `scripts/migrate-dashboard-memory.sql` manually once with the Phase 0 production access protocol, re-run the diagnostic, and proceed only if `has_human_users_table = true`.
   - Run the diagnostic before and after `npm run db:migrate` on the historical target. If the before state is broken, the after state must show all schema booleans true because of `migrate-classes-base-repair.sql`.
   - After `has_schools_table` is true, run `SELECT COUNT(*) FROM schools WHERE id = 'foundation';` and record that the Foundation School seed row exists.
   - Same diagnostic is required against production before M8 ships. If production access is unavailable, record a validation blocker and do not mark M8 complete until access is available.

5. Delete `migrations/007_classes_system.sql`.
   - Delete the top-level `migrations/` directory if empty.

6. Delete orphan migration/backfill scripts after final per-file grep:
   - `scripts/migrate-twitter.js`
   - `scripts/migrate-evaluations.sql`
   - `scripts/migrate-twitter-verification.sql`
   - `scripts/migrate-x-followers.sql`
   - `scripts/migrate-agents-vetting.sql`
   - `scripts/apply-scoping.js`
   - `scripts/cleanup-duplicate-classes.js`
   - `scripts/migrate-provisioned-agents-vetted.sql` only after this production check:
     ```sql
     SELECT COUNT(*) AS unvetted_provisioned_public_ai
     FROM agents
     WHERE metadata->>'provisioned_public_ai' = 'true'
       AND (is_vetted IS NULL OR is_vetted = false);
     ```
     If the count is nonzero, run the migration once first. If the query cannot be run, leave the file in place and record the blocker.
     Record the count or blocker in AI VALIDATION RESULTS.
   - Before deleting each orphan file, run `rg -n "<filename>" . --glob '!node_modules/**' --glob '!.next/**' --glob '!.git/**' --glob '!ai/PLAN_M8.md' --glob '!ai/cleanup-1.md'`.
   - For DDL duplicates, spot-check the relevant columns/tables/indexes are still present in `scripts/schema.sql` before deletion. If a schema target is missing, keep the orphan and record the blocker.

7. Do not delete `scripts/migrate-evaluations-scoping.sql`.
   - It is in `MIGRATION_FILES` and contains a school-scoping migration that is not fully represented by the current `schema.sql` definition of `evaluation_definitions`.

8. Tighten `isIgnorableMigrationError` in `scripts/migrate.js`.
   - Edit the literal `ignorableCodes` set inside `scripts/migrate.js:isIgnorableMigrationError`.
   - Keep duplicate/already-exists SQLSTATEs as ignorable: `42P07`, `42701`, `42710`, plus message checks for `"already exists"` and `"duplicate"`.
   - Remove undefined-table and undefined-column from the ignorable set: `42P01`, `42703`.
   - Remove the broad `"does not exist"` message check.
   - Do not record a missing-dependency migration as applied by default.
   - If a future migration truly needs missing dependency tolerance, it must add an explicit per-migration flag and an inline comment explaining why. M8 should not add any such flag.
   - This strictness change does not add migration atomicity. A future partially applied migration can still leave partial SQL state before failing; M8 only ensures missing dependencies are not silently recorded as applied.
   - If the preview/staging migration run surfaces a regression, fix the offending migration in place before merging. Do not weaken strict mode or skip the migration file; strict mode is the deliverable.

9. Document in `agents.md`:
   - Classes DDL is inlined into `scripts/schema.sql`; do not reintroduce a top-level `migrations/` runner path.
   - Migration missing-dependency errors fail loudly; duplicate/already-applied errors can be idempotently skipped.

Validation:

- Fresh DB bootstrap succeeds.
- Fresh DB has all eight class tables plus `class_slug_aliases`.
- Fresh DB has `classes.school_id`, `professors.human_user_id`, `schools`, `school_professors`, and `agents.is_admitted`.
- No `migrations/` directory remains unless a file was intentionally left with a documented reason.
- After M8, the only files in `scripts/` outside `MIGRATION_FILES` are `migrate.js` and `preview-smoke.js`; `schema.sql` remains in `MIGRATION_FILES`.
- A deliberate local scratch migration with a missing referenced table fails loudly under the new error handling. Do not commit the scratch file.

### Phase 4 - Activity-events backfill verdict

Goal: remove the daily backfill if it is vestigial, or isolate it as an operator script if it is still needed.

Current sources:

- Live writers: `src/lib/store/activity/events.ts`
- Cron route: `src/app/api/v1/internal/activity-events-backfill/route.ts`
- Cron entry: `vercel.json`
- Test: `src/__tests__/api/activity-events-backfill.test.ts`
- Architecture notes: `ai/ARCHITECTURE.md`

1. Write a parity table in `ai/PLAN_M8.md` under "AI VALIDATION RESULTS" during execution. It must include:

   `match` means coverage parity: every source row the backfill would scan has an awaited live writer on the entity write path, and the live writer preserves the same user-visible `kind`, `entity_id`, `href`, `title`, `summary`, `context`, and search semantics. Metadata counters such as post `upvotes` or comment counts may differ at creation time and do not by themselves force `no-match`, but only if grep proves there are no consumers that read those counters from `activity_events.metadata`. If such consumers exist, either update the live writer or mark that row `no-match`.

   Before filling verdicts, run:

   ```bash
   rg -n "metadata.*(upvotes|comments)|upvotes.*metadata|comments.*metadata|activity.*upvotes|activity.*comments" src
   ```

   Also open each `record*ActivityEvent` helper in `src/lib/store/activity/events.ts` and compare the columns it writes against the matching `INSERT INTO activity_events ... SELECT ...` block in `src/app/api/v1/internal/activity-events-backfill/route.ts`. A `match` verdict requires the live writer and backfill projection to agree on the user-visible columns named above; any intentional drift belongs in the Notes column.

   | Kind | Entity write site | Live writer | Backfill SQL block | Verdict | Notes |
   |---|---|---|---|---|---|
   | `post` | `src/lib/store/posts/{db,memory}.ts:createPost` | `recordPostActivityEvent` | post INSERT SELECT | match/no-match | record accepted metadata drift or consumer risk |
   | `comment` | `src/lib/store/comments/{db,memory}.ts:createComment` | `recordCommentActivityEvent` | comment INSERT SELECT | match/no-match | record accepted metadata drift or consumer risk |
   | `evaluation_result` | `src/lib/store/evaluations/{db,memory}.ts:saveEvaluationResult` | `recordEvaluationResultActivityEvent` | evaluation_result INSERT SELECT | match/no-match | record gaps, if any |
   | `playground_session` | Run `rg -n "INSERT INTO playground_sessions|UPDATE playground_sessions" src/lib/store/playground src/lib/playground` and audit every row-changing site | `recordPlaygroundSessionActivityEvent` | playground_session INSERT SELECT | match/no-match | Known non-writer sites: `joinPlaygroundSession` and `mergePlaygroundParticipantAffiliationFields` mutate `participants` without re-recording; justify this drift in the verdict or mark `no-match` |
   | `playground_action` | `src/lib/store/playground/{db,memory}.ts:createPlaygroundAction` | `recordPlaygroundActionActivityEvent` | playground_action INSERT SELECT | match/no-match | record gaps, if any |
   | `agent_loop` | `src/lib/agent-loop.ts:logAction` writing `agent_loop_action_log` | `recordAgentLoopActivityEvent` in `src/lib/store/activity/events.ts` | agent_loop INSERT SELECT from `agent_loop_action_log` | match/no-match | record gaps, if any |

   Before filling the `agent_loop` row, verify the helper names still exist with `rg -n "logAction|recordAgentLoopActivityEvent" src/lib/agent-loop.ts src/lib/store/activity/events.ts`. If either symbol moved, update the table with the current function name rather than auditing a stale path.

2. If every row is `match`, drop the backfill:
   - Delete `src/app/api/v1/internal/activity-events-backfill/`.
   - Delete `src/__tests__/api/activity-events-backfill.test.ts`.
   - Remove the `/api/v1/internal/activity-events-backfill` cron entry from `vercel.json`.
   - Rewrite `ai/ARCHITECTURE.md` references so activity events are described as live awaited projections. Keep only a note that historical backfill was removed in M8 after live-writer parity.
   - Add a concise `LEARNINGS.md` entry only if it is durable and general. Recommended wording: "Before deleting a repair/backfill job for a derived projection, prove every source kind has an awaited live writer and record the mapping in the execution plan."
   - Add or extend DB-mode activity writer coverage, preferably `src/__tests__/lib/store/activity/event-writers-db.test.ts`, for all six `record*ActivityEvent` helpers after dropping the backfill route. This prevents the parity audit from being only a memory-store proof.

3. If any row is `no-match`, keep but move the SQL:
   - Move the SQL into `scripts/backfill-activity-events.js`.
   - The route becomes a thin cron-gated wrapper around the script export.
   - Keep a route auth test and move SQL-shape tests to the script.
   - Update `ai/ARCHITECTURE.md` to name the script as the source of truth.

Validation:

- If dropped: `vercel.json` has four cron entries, not five.
- If dropped: add or extend a focused memory-mode test, preferably `src/__tests__/lib/store/activity/events-feed.test.ts`, proving `createPost` and `createComment` produce activity feed rows through `recordPostActivityEvent` and `recordCommentActivityEvent`.
- If dropped: add or extend a focused DB-mode writer test covering `recordPostActivityEvent`, `recordCommentActivityEvent`, `recordEvaluationResultActivityEvent`, `recordPlaygroundSessionActivityEvent`, `recordPlaygroundActionActivityEvent`, and `recordAgentLoopActivityEvent`.
- If moved: route file is under 50 lines and script test covers the six SQL blocks.

### Phase 5 - Final documentation cleanup

Goal: leave durable docs sharper than they started.

1. `agents.md` should include:
   - Add one consolidated, deduplicated block for all new cleanup scope, roadmap/TODO, migration strictness, and classes schema invariants from Phases 0, 2, 3, and 5.
   - The consolidated block must preserve this full invariant set:
     - edit lowercase `agents.md` only; `claude.md` is a symlink and uppercase variants are case-insensitive views
     - AT Protocol is excluded from cleanup unless explicitly reopened
     - production builds require a DB URL because `scripts/migrate.js` runs before `next build`
     - memory stores are load-bearing for Jest and local no-DB development
     - `classes` and `ao` are intentionally Postgres-only
     - roadmap and what's-next planning lives under `## Backlog` in `ai/PLAN.md`; no root TODO/planning files
     - classes DDL is inlined into `scripts/schema.sql`; do not reintroduce a top-level `migrations/` runner path
     - migration missing-dependency errors fail loudly; duplicate/already-applied errors can be idempotently skipped
   - Delete the stale gotcha that says `scripts/migrate.js` strips full-line SQL comments before splitting on semicolons. The current runner reads each migration file and sends the whole SQL string to `client.query(sql)`, so there is nothing accurate left to preserve from that bullet.
   - Delete the stale File Map row for `docs/MOLTBOOK_GAPS.md` if that file is still absent.

2. `ai/ARCHITECTURE.md` should include:
   - AO cohorts redirect compatibility note
   - updated activity-events architecture after Phase 4
   - no stale claims that activity backfill still runs if it was dropped

3. `LEARNINGS.md` should include only durable engineering wisdom:
   - Add the backfill-removal proof pattern if Phase 4 drops the cron.
   - Add the provisioned-agent backfill retirement note only if the production query returned zero and the file was deleted.
   - If the production query could not be run, keep `scripts/migrate-provisioned-agents-vetted.sql` and do not add a retirement learning.
   - Do not add product-route details like cohorts redirects.

4. Update `README.md` or `agents.md` links only if Phase 2 moves their targets.

Validation:

- `rg -n "activity-events-backfill|DEMO_DAILY_REQUEST_LIMIT|TODOs|TODOS|ai/PLAN_M[1-7]|CLAUDE_REVIEW_DASHBOARD_ACTIVITY_PLAYGROUND" README.md agents.md ai docs src vercel.json package.json --glob '!ai/archive/**' --glob '!docs/archive/**' --glob '!ai/PLAN_M8.md' --glob '!ai/cleanup-1.md'` has only intentional hits.
- Durable docs do not merely restate this plan.

### Phase 6 - Static checks and package consistency

Run these after all edits:

1. `npm install`
2. `npm run lint`
3. `npx tsc --noEmit`
4. `npm test -- --runInBand`
5. `npm run build`
6. `cd packages/safemolt-memory-mcp && npm install && npm run build`

Notes:

- Phase 6's `npm install` is a re-verification pass after the Phase 1 lockfile update. It should be a no-op. If it introduces new lockfile changes, treat them as drift and investigate or revert before committing.
- `arc lint` is not a SafeMolt command. The SafeMolt lint gate is `npm run lint`.
- If `npm run build` fails because no DB URL is available, load `.env.local` or set a disposable local `DATABASE_URL`; do not bypass `scripts/migrate.js`.
- If Postgres tools (`createdb`, `psql`) are unavailable, use a temporary Neon/Postgres branch and record the exact connection target with credentials masked.

## BETTER ENGINEERING INSIGHTS + BACKLOG ADDITIONS

- **Fresh DB bootstrap is a production contract.** Production may work because old migrations ran historically, while fresh preview databases fail because `schema.sql` drifted. M8 fixes the classes subsystem and makes future missing dependencies fail loudly.
- **Repair jobs need explicit retirement proof.** The activity-events backfill should not live forever just because it was useful during cutover. It also should not be deleted by vibe. The right retirement proof is a source-kind to awaited-live-writer mapping.
- **Asset deletion must follow data references, not only TS imports.** `public/class-previews/when-to-make-yourself-obsolete.png` is referenced from YAML content that flows through the classes UI/API. Static asset audits must search content directories and config, not just `src/`.
- **A missing script behind an npm command is worse than no script.** `playground:backfill-prefabs` currently points at a file that is not present. Removing the script improves honesty even though it does not delete code.
- **Do not split cohesive long files as cleanup.** The deferred file-split structures in `ai/cleanup-1.md` are preserved as future considerations, but M8 does not execute them because they remove no behavior and add navigation indirection.

Backlog not in M8:

- `cleanup-2-platform-experience.md`: product cuts and API surface simplification.
- Possible future schema snapshot/squash if fresh bootstrap time becomes a real problem.
- Possible `store-types.ts` per-domain split if type navigation becomes a demonstrated pain.
- Possible `memory-service.ts` internal split after the memory API surface decision.
- Possible shared conversation primitive only if classes/evaluations/playground converge further in real use.

Better-engineering blockers found that require a separate milestone before M8: **none**. The classes migration bug is important, but it is small enough to fix inside M8.

## AI VALIDATION PLAN (how will the Executor of this plan know when it is done?)

Hard gates:

1. `npm install` succeeds and updates `package-lock.json` consistently.
2. `npm run lint` succeeds.
3. `npx tsc --noEmit` succeeds.
4. `npm test -- --runInBand` succeeds.
5. `npm run build` succeeds with a real DB URL.
6. `cd packages/safemolt-memory-mcp && npm install && npm run build` succeeds.

Migration gates:

7. A fresh disposable DB runs `npm run db:migrate` successfully. This is necessary but not sufficient; gate 11 is also required.
8. Fresh DB contains `human_users`, `professors`, `classes`, `class_assistants`, `class_enrollments`, `class_sessions`, `class_session_messages`, `class_evaluations`, `class_evaluation_results`, `class_slug_aliases`, `schools`, and `school_professors`, plus `classes.school_id`, `professors.human_user_id`, `agents.is_admitted`, school-scoping columns on `groups`/`evaluation_results`/`evaluation_registrations`/`playground_sessions`, and the `foundation` school row.
9. `migrate-classes-base-repair.sql` and `migrate-class-slugs.sql` are recorded in `_migrations`, and fresh-DB migration stdout shows `[Migration] SUCCESS:` for both labels rather than `[Migration] SKIP: ... (already applied or not needed)`.
10. Undefined-table and undefined-column errors are no longer silently recorded as applied.
11. An existing preview/staging database, production-history scratch branch, or restored production snapshot with migration history runs `npm run db:migrate` under the strict error policy. Lack of such a target blocks M8; fresh DB proof alone is not enough.
12. Production and preview/staging class/school/slug diagnostics are recorded with masked targets; any DB with missing `human_users`, class, school, professor-link, admission, or slug schema is repaired by the prescribed manual dashboard replay and/or `scripts/migrate-classes-base-repair.sql` before strict mode ships.

Cleanup gates:

13. Root `package.json` and `package-lock.json` no longer contain `@modelcontextprotocol/sdk`.
14. Root `npm ls @modelcontextprotocol/sdk` is empty.
15. `packages/safemolt-memory-mcp` still builds with its own dependency.
16. `public/class-previews/when-to-make-yourself-obsolete.png` still exists unless the YAML reference was intentionally removed in a separate product change. M8 should not remove it.
17. `src/app/playground/page.tsx` imports `PlaygroundContent` directly from `@/components/playground/PlaygroundContent`.
18. No top-level `ai/PLAN_M*.md` files remain except `ai/PLAN_M8.md`.
19. No non-archived stale links point to moved plan docs.

Activity gates:

20. The activity parity table is filled with match/no-match verdicts.
21. The activity metadata-consumer grep is recorded before accepting metadata drift in the parity table.
22. The `playground_sessions` INSERT/UPDATE grep is recorded before marking the `playground_session` row `match`.
23. If the backfill is dropped, the focused memory-mode live-writer test proves `createPost` and `createComment` produce activity feed rows.
24. If the backfill is dropped, DB-mode writer coverage proves all six `record*ActivityEvent` helpers still write the expected activity rows.
25. If the backfill is moved, route and script tests cover auth and SQL shape respectively.

Claude/code-review gates:

26. Run Claude review on the completed implementation and validation results, following the review loop in the execution instructions.
27. Address every Claude suggestion that improves the work; otherwise document the reason in code comments or plan notes and re-review.

## AI VALIDATION RESULTS (how did the Executor show that it was done?)

Execution date: 2026-05-12.

### Preflight

- Branch: `main`.
- Initial tracked worktree: clean; only `ai/PLAN_M8.md` and `ai/cleanup-1.md` were untracked planning inputs.
- `npm`/`npx` were not visible until `source ~/.nvm/nvm.sh`; all npm/npx gates used that shell setup.
- Tool versions after nvm: Node `v24.15.0`, npm `11.14.1`, npx `11.14.1`.
- Vercel env inspection blocker: `npx --yes vercel env ls` authenticated but failed with "codebase isn't linked to a project on Vercel." Because production/preview/development envs could not be inspected, the four `DEMO_DAILY_REQUEST_LIMIT` compatibility fallbacks were left in place.

### Cleanup Results

- Deleted confirmed-dead files and wrappers: `src/lib/mock-data.ts`, `scripts/sync-evaluations.ts`, `public/party-parrot.gif`, `.kilo/`, `src/app/playground/PlaygroundContent.tsx`, `scripts/perf-smoke.js`, and `scripts/analyze-route-trace.js`.
- Removed stale npm scripts: `perf:smoke`, `perf:trace`, and `playground:backfill-prefabs`.
- Removed root `@modelcontextprotocol/sdk`; `rg -n "@modelcontextprotocol/sdk" package.json package-lock.json src` returned no hits, and `npm ls @modelcontextprotocol/sdk` returned `(empty)`.
- Kept `public/class-previews/when-to-make-yourself-obsolete.png`.
- Kept Public AI legacy slug upgrade path because the configured Neon target reported `legacy_public_ai_agents = 1`.
- Deleted `scripts/migrate-provisioned-agents-vetted.sql` after the configured Neon target reported `unvetted_provisioned_public_ai = 0`.
- Archived completed/obsolete plan docs under `ai/archive/` and `docs/archive/`; active future docs left at top level include CIP agentic evaluations, evaluation contribution, magical details, and MPP marketplace.
- Moved root `TODOS.md` backlog into `ai/PLAN.md`.

### Migration Results

- Local `psql`/`createdb`/`dropdb` were unavailable, so fresh bootstrap used disposable schemas on the configured Neon target with credentials loaded from `.env.local`. The pooled Neon endpoint rejected `search_path` startup options, so the isolated-schema checks used the equivalent unpooled host. Temporary schemas were dropped after diagnostics.
- Fresh isolated schema `safemolt_m8_check_1778600736`: `npm run db:migrate` succeeded before strict mode; stdout showed `[Migration] SUCCESS:` for both `Class UUID and slug migration` and `Classes base schema repair`.
- Fresh isolated schema proof included: `human_users`, all eight class tables, `class_slug_aliases`, `schools`, `school_professors`, `classes.school_id`, `classes.slug`, `professors.human_user_id`, `agents.is_admitted`, school-scoping columns, and `foundation_school_rows = 1`.
- Configured Neon target: masked Neon endpoint from `.env.local` (`ep-polished-queen-.../neondb`).
- Pre-repair diagnostic on that target showed all class/school/slug booleans true and `foundation_school_rows = 1`.
- `npm run db:migrate` on that target before strict mode recorded `[Migration] SUCCESS: Classes base schema repair`.
- After strict mode, `npm run db:migrate` on the same target succeeded with all files already recorded.
- Fresh isolated schema `safemolt_m8_check_strict_1778600916`: `npm run db:migrate` succeeded under strict mode; diagnostics showed all class/school/slug booleans true, `slug_migration_recorded = true`, `repair_migration_recorded = true`, and `foundation_school_rows = 1`.
- Missing-dependency tolerance check: `scripts/migrate.js` no longer contains `42P01`, `42703`, or the broad `"does not exist"` message check; duplicate/already-exists SQLSTATEs remain ignorable.

### Activity Parity

Metadata consumer grep:

```text
rg -n "metadata.*(upvotes|comments)|upvotes.*metadata|comments.*metadata|activity.*upvotes|activity.*comments" src
```

Result: only writer metadata literals, an activity-context prompt string, and a test fixture. No production consumer reads post/comment engagement counters from `activity_events.metadata`.

Playground row-changing grep:

```text
rg -n "INSERT INTO playground_sessions|UPDATE playground_sessions" src/lib/store/playground src/lib/playground
```

Result: session creation, general session update, join participant update, activation update. Creation/status/start/completion/participant/prompt/summary updates have awaited live writers because the session projection summary/search/context fields include those values.

| Kind | Entity write site | Live writer | Backfill SQL block | Verdict | Notes |
|---|---|---|---|---|---|
| `post` | `src/lib/store/posts/{db,memory}.ts:createPost` | `recordPostActivityEvent` | post INSERT SELECT | match | User-visible columns match; metadata count drift accepted because no production consumer reads those counters. |
| `comment` | `src/lib/store/comments/{db,memory}.ts:createComment` | `recordCommentActivityEvent` | comment INSERT SELECT | match | User-visible columns match; metadata upvote drift accepted for the same reason. |
| `evaluation_result` | `src/lib/store/evaluations/{db,memory}.ts:saveEvaluationResult` | `recordEvaluationResultActivityEvent` | evaluation_result INSERT SELECT | match | Status, result link, summary, context, search text, and metadata agree. |
| `playground_session` | `src/lib/store/playground/{db,memory}.ts` create/update/activate/join/affiliation paths | `recordPlaygroundSessionActivityEvent` | playground_session INSERT SELECT | match | Creation, activation, joins, participant-affiliation patches, and projection-affecting session updates re-record because participant count/search/context fields are part of the projection. |
| `playground_action` | `src/lib/store/playground/{db,memory}.ts:createPlaygroundAction` | `recordPlaygroundActionActivityEvent` | playground_action INSERT SELECT | match | Action rows are written through awaited live writers. |
| `agent_loop` | `src/lib/agent-loop.ts:logAction` | `recordAgentLoopActivityEvent` | agent_loop INSERT SELECT | match | `logAction` awaits the activity writer after inserting `agent_loop_action_log`. |

Verdict: all rows `match`, so the backfill route, cron entry, and route test were deleted. Added/kept validation coverage:

- `src/__tests__/lib/store/activity/event-writers-db.test.ts` covers all six DB writer helpers.
- `src/__tests__/lib/store/activity/events-feed.test.ts` now proves memory-mode `createPost`/`createComment` produce activity feed rows and that playground participant/context updates refresh the session activity row.

### Command Gates

- `npm install`: passed; final run was up to date. npm audit still reports inherited vulnerabilities.
- `npm run lint`: passed with no ESLint warnings or errors.
- `npx tsc --noEmit`: passed.
- Focused activity tests: `npm test -- --runInBand src/__tests__/lib/store/activity/events-feed.test.ts src/__tests__/lib/store/activity/event-writers-db.test.ts` passed after the final playground activity refresh fix, 2 suites / 9 tests.
- Full Jest: `npm test -- --runInBand` passed after the final playground activity refresh fix, 46 suites / 250 tests.
- `npm run build`: passed; strict migration pre-step succeeded against the configured DB and Next built 95 static pages.
- `cd packages/safemolt-memory-mcp && npm install && npm run build`: passed. Its own `package-lock.json` mechanically updated the bin target from `dist/index.js` to `lib/index.js`, matching that package's existing `package.json`.
- `git diff --check`: passed.
- `scripts/` audit: every file except `migrate.js` and `preview-smoke.js` is listed in `MIGRATION_FILES`.

### Remaining Intentional Compatibility

- `DEMO_DAILY_REQUEST_LIMIT` remains in four call sites because Vercel env inspection was blocked by the unlinked project.
- `publicAiAgentNameForUser` and `maybeUpgradeLegacyPublicAiSlug` remain because the configured Neon target still has one legacy `publicai_%` provisioned agent.

### Claude Review

- Initial parallel Claude passes reported no blockers for AGENTS compliance, milestone coverage, or KISS/refactor opportunities.
- Claude's LEARNINGS pass found that `playground_session` participant joins/affiliation patches changed user-visible projection fields without re-recording after the backfill route was removed. Follow-up change: `joinPlaygroundSession` and `mergePlaygroundParticipantAffiliationFields` now refresh the session activity projection in both DB and memory stores.
- Claude's correctness pass then noted that `updatePlaygroundSession` also needed to re-record when projection-affecting participant, prompt, summary, or timestamp/status fields change. Follow-up change: `updatePlaygroundSession` now refreshes the session activity row for those fields, and the focused activity test pins participant/search and context refresh behavior.
- Final Claude pass after the `updatePlaygroundSession` fix reported no blockers across migration safety, activity freshness after backfill removal, lockfile/package drift, and PLAN_M8 hard gates.

## USER VALIDATION SUGGESTIONS

After M8 is executed, the user should verify:

1. Open `/classes` and confirm the "When to Make Yourself Obsolete" preview image still loads.
2. Open `/playground` and confirm it still renders after the wrapper deletion.
3. Open `/api/v1/agents/status` with an agent API key and confirm it still returns claim/news status.
4. Open the AO `/cohorts` URL on the AO host and confirm it still redirects/preserves the Companies cohorts anchor behavior.
5. Review `ai/` and `docs/`; current references should be easy to spot, while old milestone plans live under archive directories.
6. Ask the executor for the fresh DB bootstrap proof before merging. The most important M8 correctness win is that a brand-new DB gets the classes subsystem instead of silently recording a failed slug migration.

## Open questions for the user

No user decision blocks execution. The plan carries safe defaults:

1. If production/Vercel env inspection is unavailable, keep compatibility shims rather than guessing.
2. If the activity parity audit finds a missing live writer, keep the backfill by moving it to a script instead of deleting it.
3. If a docs-plan audit is ambiguous, annotate it as partially implemented rather than archiving it aggressively.
