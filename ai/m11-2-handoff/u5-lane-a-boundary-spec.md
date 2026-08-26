# u5 Lane A — P1.5/P1.6 store-boundary enforcement (spec)

## Mission

Build the P1.5/P1.6 **enforcement machinery**. The adapter conversions themselves are ALREADY DONE
(u3–u3f made every mutating route and tool executor an adapter over `src/lib/actions/*`) — verified
2026-08-26 by import inspection. What remains is the boundary that keeps it true, plus fixing any
straggler the boundary itself surfaces.

**KISS rule (user directive): the simplest implementation that satisfies the plan's gates. No
speculative abstraction. A flat generated ESLint block and three plain Jest tests beat a framework.**

## Authoritative sources (read these first)

- `ai/PLAN_M11_2.md` lines 239–245 (P1.5 + P1.6 verbatim remedy + gates).
- `ai/validation/m11-inventory.md` §1 (routes), §2 (tools), §10 (the permanent exemption lists —
  10a internal allowlist, 10b out-of-scope families, the "Not exempted, by design" block, and the
  two OPEN items in §10's tail).
- `CLAUDE.md` (= agents.md) "Store and Migration Invariants" — context only; you change no store code.

## Deliverables

1. **`src/lib/store/export-manifest.ts`** — the canonical manifest of MUTATING store exports.
   Simplest correct shape: an exported `const MUTATING_STORE_EXPORTS: readonly string[]` (names of
   every write export re-exported by `src/lib/store.ts` / `src/lib/store/index`-style facade),
   plus a short doc header. Classify by reading `src/lib/store.ts` and the domain modules under
   `src/lib/store/*/index.ts`. Reads (`get*`, `list*`, `search*`, `is*`, `has*` and other
   non-mutating exports) are NOT in the manifest. When a name is ambiguous, open the implementation
   and check whether it writes. Also include mutating exports of `src/lib/post-deletion.ts`? NO —
   the boundary is over `@/lib/store` imports only, per the plan; `post-deletion` is the sanctioned
   deletion path. Keep scope exactly what the plan names.
2. **`scripts/gen-eslint-boundary.js`** — reads the manifest (simple approach: `require` the
   compiled name list — since the repo has no build step for scripts, the pragmatic KISS path is to
   have the script parse `export-manifest.ts` for the string-literal list with a regex, or keep the
   manifest as a `.ts` file whose list the generator extracts; choose the simplest that the
   drift-test can verify) and rewrites ONE clearly-delimited generated block inside `.eslintrc.json`:
   a `no-restricted-imports` override with `paths: [{ name: "@/lib/store", importNames: [...] }]`
   (and the same for relative `@/lib/store` variants only if they exist in the tree — check; do not
   invent cases), with `files` = `src/app/api/v1/**` + `src/lib/agent-tools/**` and
   `excludedFiles` = the §10a + §10b lists verbatim. Wire an npm script `gen:boundary`.
3. **Run the generator, commit the generated block** (the config is checked in). Then run
   `npm run lint`. If any in-scope file violates the boundary, FIX the file: mutating call moves
   behind its existing action (do NOT create new actions without recording it in your report;
   expected stragglers: none — the survey found tool files import only reads).
4. **Three Jest tests** (unit project, no DB):
   - `src/__tests__/lib/boundary-generated-block.test.ts` — regenerates the block in-memory and
     asserts `.eslintrc.json`'s committed block matches (drift fails CI).
   - `src/__tests__/lib/boundary-ast-discipline.test.ts` — TypeScript compiler API over the same
     file set (minus the same exemptions): fails on `import * as X from "@/lib/store"`, aliased
     imports of manifest names (`import { createPost as x }`), `require("@/lib/store")`, and
     dynamic `import("@/lib/store")`. Keep it a single walk; no plugin architecture.
   - `src/__tests__/lib/boundary-manifest-completeness.test.ts` — enumerates the store facade's
     actual exports (compiler API or a targeted parse of `src/lib/store.ts`), classifies
     write-vs-read by a maintained read-prefix allowlist INSIDE the manifest file (so the one file
     owns both lists), and fails when an export is in neither list. New store exports added by other
     lanes this wave will trip this test AT THE MERGE BOUNDARY — that is by design; the failure
     message MUST name the missing export and say "add to export-manifest.ts (mutating) or the
     read-prefix list, then `npm run gen:boundary`".
5. **Mixed-actor route test** (plan P1.6 gate): extend or add a unit test asserting
   `src/app/api/v1/classes/[id]/sessions/[sessionId]/messages/route.ts` imports no mutating store
   export, its agent branch cannot reach `addOperatorClassSessionMessage` (only the professor-auth
   branch invokes it — assert via source scan, the pattern used in
   `src/__tests__/lib/m11-2-u3f-core-characterization.test.ts`), and the file appears on no
   exemption list (import the generator's exemption list and assert absence).
6. **Inventory refresh (mechanical)**: in `ai/validation/m11-inventory.md`, tick the stale `[ ]`
   checkboxes in §1a and §2 for rows whose routes/tools are verifiably adapters now (verify each by
   grepping the file's imports — u3d/u3e migrated playground/evaluations/vetting/registration).
   Add one line to §10's tail resolving the two OPEN items ONLY IF trivially resolvable by
   classification (the three school-federation routes join §10b as a named family; the classes GET
   YAML note stays open) — otherwise leave them and say so in your report.

## Fences — files you may touch

- NEW: `src/lib/store/export-manifest.ts`, `scripts/gen-eslint-boundary.js`,
  `src/__tests__/lib/boundary-*.test.ts`.
- EDIT: `.eslintrc.json` (generated block + any needed override), `package.json` (ONE npm script),
  `ai/validation/m11-inventory.md` (§1a/§2 checkboxes + §10 tail).
- EDIT only if the boundary surfaces a violation: files under `src/app/api/v1/**` or
  `src/lib/agent-tools/**` (record every such edit in the report).
- DO NOT touch: `src/lib/store/**` implementation files (manifest is a new standalone file),
  `src/lib/actions/**`, `src/lib/events/**`, `src/lib/agent-senses/**` (Lane B),
  `src/lib/playground/**`, `scripts/migrate.js`, `agents.md`/`CLAUDE.md`, anything in
  `src/lib/agent-loop*` or `src/lib/agent-home/**`.

## Gates you run (targeted; the orchestrator runs the full five at the boundary)

- `npx tsc --noEmit`
- `npm run lint` (must be 0 errors with the boundary ACTIVE)
- `npx jest src/__tests__/lib/boundary-*.test.ts src/__tests__/lib/m11-2-u3f-core-characterization.test.ts src/__tests__/lib/group-school-gate.test.ts --runInBand`
- `npx jest src/__tests__/lib --runInBand` once at the end (whole unit-lib tree)
- Do NOT run `npm run test:integration`. Do NOT run `npm run build` (orchestrator does).
- Do NOT run codex. Do NOT use git (no add/commit/stash — the orchestrator owns git).

## Working rules

- Mutation-check the enforcement: temporarily add a forbidden import to a scratch in-scope file,
  watch lint AND the AST test fail, remove it. Put the evidence (the exact error lines) in your
  report — do not leave the scratch file behind.
- Context management (user directive): if YOU pass ~60% of your context, STOP and write a complete
  handoff to `ai/m11-2-handoff/u5-lane-a-handoff.md` (disk state, remaining items, gate status);
  the orchestrator respawns a fresh manager from it. Apply the same rule to any subagent you spawn:
  self-contained spec in, completion report out, never resume one past ~50–60%.
- Subagents: this lane is small enough to do directly or with ONE opus implementer for the AST
  test + ONE haiku for the inventory checkbox sweep. Do not over-parallelize a small lane.

## Report format (your final message)

State: files created/edited; gate outputs (pass/fail, counts); mutation-check evidence; every
boundary violation found and how it was fixed; inventory rows ticked; anything deferred.
