# u5 Lane B — P4 senses surface (P4.1 + P4.2 + P4.3) (spec)

## Mission

Implement Phase 4 whole: one senses library, the context endpoint, and the loop rendering from it.
**KISS (user directive): promote and unify what exists; do not redesign it.** The gather functions
mostly exist today — scattered. This phase MOVES them behind one typed facade and deletes the
duplicates. Resist adding features the plan does not name.

## Authoritative sources (read first)

- `ai/PLAN_M11_2.md` lines 309–323 (P4.1/P4.2/P4.3 verbatim — problem, remedy, gates).
- Current code: `src/lib/agent-opportunities.ts` (the M9 C8 shared pieces — playground/groups/news),
  `src/lib/agent-loop.ts` (the private `gather*` set + `buildDecisionPrompt`),
  `src/lib/agent-home/service.ts` (the parallel home builders + the hardcoded
  `classes`/`admissions`/`memory` stubs), `src/lib/agent-loop-actions.ts`, `src/lib/agent-loop/state.ts`.
- `CLAUDE.md` "Agent UX Contract Pins" — the admissions pinned fields (`next_action`,
  `criteria_progress`, `public_ai_eligibility`, `admission_source`, `state_source`) MUST survive.
- `src/lib/auth.ts` route conventions; look at `src/app/api/v1/agents/me/route.ts` for the
  vetting-exempt pattern the new route must share.

## Deliverables

### P4.1 — `src/lib/agent-senses/`
- Promote `agent-opportunities.ts` into `src/lib/agent-senses/` and add the missing gatherers:
  `gatherFeed` (personalized `listFeed`; **global-new fallback with `feed_mode: "global_fallback"`**
  when the personalized feed is empty — the cold-start fix; today's loop reads global
  `listPosts({sort:"new"})` unconditionally, which is the defect), `gatherInbox`, `gatherClasses`,
  `gatherEvaluations`, `gatherPlayground`, `gatherGroups`, `gatherNetwork`, `gatherNews`,
  `gatherMemories`, `gatherAdmissions` (via `getAdmissionsStatusForAgent`, pinned fields intact),
  `gatherLimits`.
- `buildAgentContext(agentId, {focus?})` → typed `AgentContext`; every section carries
  `{items, degraded: boolean}` (degraded = the section's source threw or was unavailable; catch per
  section, never let one section's failure kill the context).
- `focus` narrows WHAT IS ASSEMBLED (P3.3 will pass `reply`/`mention`/`playground_round`/`idle`);
  for this wave implement the focus parameter and its narrowing per the P3.3 text (line 301:
  reply/mention preload the thread; playground_round preloads round prompt + transcript tail;
  idle = full discovery) but nothing that depends on the (not-yet-existing) wakeup runner.
- Reads only. This library performs NO mutations and emits NO events. Import reads from
  `@/lib/store` freely (Decision 3: reads stay reads).

### P4.2 — `GET /api/v1/agents/me/context`
- New route returning `AgentContext` in snake_case (convert at the boundary, repo convention),
  `meta.suggested_poll_interval_ms` and `meta.mode` (`meta.mode`: `"degraded"` — no worker exists
  yet; expose from one helper so P3.4 can flip it later, keep it dumb).
- Rate-limited (follow the pattern of the nearest rate-limited GET; if none fits, a simple
  per-agent in-route window is enough — record what you chose), vetting-exempt like `agents/me*`.
- Home's `classes`/`admissions`/`memory` stubs in `agent-home/service.ts` replaced by projections
  from the SAME context object.
- Docs delta: `public/skill.md`, `public/reference.md`, `public/openapi.json` gain the endpoint
  (match the existing documentation style and level of detail; representative, not exhaustive).
  `public/heartbeat.md`: check whether it exists first; if it does not, SKIP it and note that —
  do not create new doc surfaces beyond the endpoint entry.

### P4.3 — loop renders from senses
- `buildDecisionPrompt` takes `AgentContext`; delete the private `gather*` set from
  `agent-loop.ts` and the parallel home builders P4.2 replaced.
- Gate (plan): loop tests green; `grep -c "gather" src/lib/agent-loop.ts` shows no gather
  functions remain; loop prompt and home payload snapshots unchanged OR intentionally updated —
  when a snapshot changes, your report must say exactly why (e.g. the personalized-feed fix
  changes the feed section for agents with subscriptions; that is an INTENDED change, record it).

## Fences — files you may touch

- NEW: `src/lib/agent-senses/**`, `src/app/api/v1/agents/me/context/route.ts`, new tests
  `src/__tests__/lib/agent-senses*.test.ts` + route test.
- EDIT: `src/lib/agent-loop.ts` (P4.3 only — prompt/gather side; do NOT touch tick/claim
  machinery), `src/lib/agent-home/service.ts`, `src/lib/agent-opportunities.ts` (delete/forward
  after promotion — prefer deleting it and updating its importers; grep all importers first),
  existing loop/home tests that pin the prompt/payload, `public/skill.md`, `public/reference.md`,
  `public/openapi.json`.
- DO NOT touch: `src/lib/store/**` (reads via the facade only), `src/lib/actions/**`,
  `src/lib/events/**`, `src/lib/playground/**` (Lane C owns it), `.eslintrc.json`, `package.json`,
  `scripts/**`, `agents.md`/`CLAUDE.md`, `ai/validation/m11-inventory.md` (record inventory deltas
  in your report; the orchestrator folds them).

## Gates you run

- `npx tsc --noEmit`; `npm run lint`
- Targeted: your new suites + every existing suite that imports `agent-loop`, `agent-home`,
  or `agent-opportunities` (grep to find them) — `--runInBand`.
- `npx jest src/__tests__ --runInBand` (full unit tree) once at the end.
- Do NOT run `npm run test:integration`, `npm run build`, codex, or git.

## Working rules

- Characterize FIRST: snapshot the current loop prompt sections and home payload (there are
  existing tests — find them before writing new ones) so every diff is intentional.
- The new route is inside Lane A's concurrent ESLint boundary scope: import ONLY reads from
  `@/lib/store` in the route file, no mutating store exports (there is no reason to).
- Context management (user directive): stop at ~60% of your context with a full handoff to
  `ai/m11-2-handoff/u5-lane-b-handoff.md`; same rule for subagents (self-contained spec in,
  report out, never resume past ~50–60%).
- Subagents: reasonable split = ONE opus implementer for P4.1 (the library + types), then P4.2 and
  P4.3 sequentially (they edit the same neighborhoods — do not parallelize B internally beyond the
  library build), a haiku for the docs delta.
- Every behavioral claim gets a test; mutation-check fixes (break it, watch it fail, fix it).

## Report format

Files created/edited/deleted; gate outputs; snapshot diffs and WHY each is intended; the
cold-start/degraded/pinned-fields/parity gate evidence (plan lines 314, 319, 323); inventory
deltas for the orchestrator; anything deferred.
