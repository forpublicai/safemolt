# Scoped review — u5 Lanes A + B (one round each, stop unless BLOCKER/MAJOR)

You are the review agent (read-only). Do NOT run jest, tsc, or the build — the sandbox denies the
temp writes and the attempt can kill your session. All five gates pass (tsc clean, lint 0 errors,
180 suites/1729 unit, full integration green, build green). Reason from the code. The wave diff is
`git diff 84bd3d9..HEAD` restricted to each lane's files. Both lanes are LOW-RISK by the project's
risk-split rule: one round, stop unless you find a BLOCKER or MAJOR.

## Part 1 — Lane A: P1.5/P1.6 store-boundary enforcement

Plan: `ai/PLAN_M11_2.md` lines 239–245. Exemptions: `ai/validation/m11-inventory.md` §10.

Files: `src/lib/store/export-manifest.ts` (178 mutating names + read prefixes),
`scripts/gen-eslint-boundary.js`, the generated block in `.eslintrc.json`, `package.json`
(`gen:boundary`), `src/__tests__/lib/boundary-{generated-block,ast-discipline,
manifest-completeness,mixed-actor-route}.test.ts`, five route files converted from
namespace/dynamic store imports to named read imports (`schools/*` ×4,
`evaluations/[id]/results/[resultId]/transcript`).

Check: (a) does the generated `no-restricted-imports` block actually bind? — `files` globs cover
`src/app/api/v1/**` and `src/lib/agent-tools/**`, `excludedFiles` match the §10 lists, and the
bracket-escaping fix (`[id]` glob semantics) is correct for BOTH the rendered block and the plain
string lists the tests use; (b) can the AST discipline test be evaded (re-export chains, `require`,
computed dynamic import, type-only import abuse)? Flag only evasions a WELL-MEANING author could
hit accidentally — this is drift protection, not sandboxing; (c) manifest completeness: is the
read-prefix classification sound (any WRITE export whose name starts with a read prefix would be
silently unlisted — check the store facade for such names); (d) the five route conversions are
read-only and behavior-identical; (e) the mixed-actor messages-route test pins what P1.6's gate
demands. Known decision — do not re-flag: seven pure/no-IO exports sit in the mutating list by
documented default-deny; `findRoundOpenedEventId` likewise (no `find` read prefix on purpose).

## Part 2 — Lane B: P4 senses surface

Plan: `ai/PLAN_M11_2.md` lines 309–323 (P4.1/P4.2/P4.3). Pins: CLAUDE.md "Agent UX Contract Pins"
(the five admissions fields).

Files: `src/lib/agent-senses/**` (16 files), `src/app/api/v1/agents/me/context/{route,serialize}.ts`,
`src/lib/agent-loop.ts` (gatherers deleted; `buildDecisionPrompt` takes `AgentContext`),
`src/lib/agent-home/{service,types}.ts` (stubs → real projections), `src/lib/auth.ts` (ONE line:
the context route joins the `agents/me*` vetting-exempt allowlist), `src/lib/agent-opportunities.ts`
DELETED, tests (`src/__tests__/lib/agent-senses/`, `agents-me-context`, updated loop/home/access
suites), docs (`public/{skill,reference,heartbeat}.md`, `openapi.json`).

Check: (a) the cold-start fallback — personalized `listFeed` first, global-new ONLY when empty,
`feed_mode: "global_fallback"` marked; does any path still read the global list unconditionally?
(b) per-section degraded isolation — can one gatherer's throw kill the whole context or leak a
rejection? (c) the five pinned admissions fields pass through unmodified on every path (loop,
endpoint, home); (d) the auth.ts allowlist line — exactly the `agents/me*` rule, no broader; the
route performs no mutation and imports no mutating store export; (e) the loop rewire — is any
prompt section silently LOST relative to the old gatherers (compare what the deleted functions fed
`buildDecisionPrompt` against what `AgentContext` now feeds it); (f) home projections — same
context object, no second assembly path reintroduced; (g) serialization — snake_case boundary
conversion complete and consistent with the repo convention; `meta.mode`/`meta.
suggested_poll_interval_ms` present. Known context: two subagents briefly overlapped on these
files mid-lane; the final state was verified coherent — look for residue anyway (dead exports,
duplicate helpers, half-renamed symbols).

## Output

Findings as BLOCKER / MAJOR / MINOR / NIT with file:line, concrete failure scenario, proposed fix,
grouped by lane. If a lane is clean, say so plainly.
