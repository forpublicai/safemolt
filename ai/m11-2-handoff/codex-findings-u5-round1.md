# codex findings — wave u5, round 1 (all three lanes)

Reviewer: `codex exec --sandbox read-only` (gpt-5.6-sol), solo, quiet machine.
Prompts: `codex-u5-lane-c-review.md`, `codex-u5-lane-ab-review.md`, `codex-u5-lane-c-review-r2.md`.

## Lane C (P3.2 wakeup queue) — round 1: 1 MAJOR → round 2: CONVERGED

**r1 MAJOR (ADOPTED, fixed in `20dd055`)**: the consume-time freshness check was a pre-read
separated from the wakeup insert by awaits (router `routeRoundOpened` + the sweep's arming loop) —
a session advancing in the window landed a stale round-N wakeup beside the legitimate round-N+1
one: two claimable rows for one agent, double budget once P3.3's runner exists (the event-keyed
dedup index sees two event ids). Fix: `createOrReArmPlaygroundRoundWakeup` in both stores — the
db statement's `live` CTE re-checks status + round + the agent's action AT INSERT TIME under
`FOR SHARE` of the session row; both arms (insert, re-arm) gate on it; the memory twin evaluates
the same gate in the same synchronous section. Proof: 5 memory + 6 db tests including the
deterministic interleaving and a FOR SHARE serialization proof; mutation-checked both stores.

**r2 verdict: "CONVERGED: The unit needs no change." Zero findings.** Confirmed: both round paths
use the gated op; comment wakeups are immutable-fact-keyed; the session lock serializes against
advancement; the unlocked action check can only permit an already-acted wakeup (harmless); no lock
cycle; memory gate matches db; the delivery read stays the plan's enqueue-time advisory.

## Lane A (P1.5/P1.6 boundary) — round 1: 1 MINOR (fixed by orchestrator)

The generator's `extractStringArray` regexed quoted tokens from the WHOLE array body including
comments, so a quoted word in a manifest comment (`"find"` was live) leaked into the generated
ESLint block as a restriction no manifest decision made. Fixed: comments stripped before
extraction (block + line), safe by the manifest's pinned one-identifier-per-line format;
regenerated block verified free of the stray token; 10/10 boundary tests green.
Clean otherwise: route conversions behavior-identical, bracket escaping correct in both
representations, no write export hides behind a read prefix.

## Lane B (P4 senses) — round 1: 2 MAJOR (fix round dispatched)

1. **The loop prompt drops the admissions surface**: ten context values projected, never
   `context.admissions` — the five pinned fields are gathered but unreachable by the autonomous
   agent. ADOPTED with a narrowing: project ONLY when actionable (next_action present or not fully
   admitted); admitted-and-idle agents get no section (prompt cost discipline).
2. **Home builds a parallel senses assembly**: `agent-home/service.ts` calls separate gatherers
   instead of `buildAgentContext` — the one-context rule (P4.2 "projections from the same
   context") violated; home can drift from loop/endpoint. ADOPTED: home assembles one
   `AgentContext` and projects every section from it; structural import-scan test added.

Clean otherwise: cold-start fallback, per-section degraded isolation, endpoint serialization,
metadata, and the narrow auth allowlist all confirmed correct.

## Round 2 verdicts — WAVE u5 FULLY CONVERGED

- Lane C r2: "CONVERGED: The unit needs no change." (zero findings)
- Lanes A + B r2 (verification of the fixes, commit `e2ee255`): "Both lanes are CONVERGED."
