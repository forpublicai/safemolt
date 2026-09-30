# u5 Lane B fix round 1 — close codex A/B round 1's two MAJORs (spec)

Codex findings file: the A/B review verdict (2026-08-26). Both findings ADOPTED by the
orchestrator. KISS: minimal, projection-shaped fixes — no new gatherers, no redesign.

## Finding B-1 (MAJOR): the loop prompt drops the admissions surface

`src/lib/agent-loop.ts` projects ten context values but never `context.admissions`; the final
prompt has no admissions section, so an agent with a pending `next_action` cannot see it.

Fix, with one deliberate narrowing (orchestrator adjudication): project admissions into the loop
prompt ONLY when it is actionable — `next_action` present, or the agent not fully admitted.
An admitted agent with nothing to do gets NO admissions section (prompt tokens cost every tick for
every agent; a static "you are admitted" line is noise). When projected, the section preserves the
five pinned fields verbatim: `next_action`, `criteria_progress`, `public_ai_eligibility`,
`admission_source`, `state_source`.

Test: a loop-prompt test with all five fields present + the actionable/silent split (actionable ⇒
section with all five; admitted-and-idle ⇒ no section). Anchor in the existing
`agent-loop-prompt.test.ts` style.

## Finding B-2 (MAJOR): home builds a parallel senses assembly

`src/lib/agent-home/service.ts` (lines ~103/205/380) calls separate gatherers instead of
`buildAgentContext` — the one-context rule (P4.2: home sections are "projections from the same
context") is violated; concurrent drift between home, loop and endpoint becomes possible.

Fix: the home service assembles ONE `AgentContext` via `buildAgentContext(agentId, ...)` and
projects every section it serves from that object. Where home needs smaller limits or different
shapes, project/slice from the context result — do NOT add per-section options to the gatherers
unless a section is genuinely unbuildable otherwise (record it if so). Preserve the home payload
shape byte-for-byte where the data is the same; where a payload legitimately changes because the
underlying data source changed, the existing home tests must be re-anchored WITH a comment saying
why.

Test: the existing home payload tests stay green (re-anchored only with recorded reasons) + one
structural test proving the service imports/calls `buildAgentContext` and no individual `gather*`
from `agent-senses` (import-scan style, like the u3f characterization tests).

## Fences

- EDIT: `src/lib/agent-loop.ts`, `src/lib/agent-home/service.ts` (+`types.ts` only if a projection
  type needs it), `src/__tests__/lib/agent-loop-prompt.test.ts`,
  `src/__tests__/api/v1/agents-me-home.test.ts`, new/existing senses tests.
- Do NOT touch: `src/lib/agent-senses/**` internals except additive exports if strictly needed
  (record any), the context route, the store, events, playground, boundary files.

## Gates

`npx tsc --noEmit`; `npm run lint`; targeted suites (loop-prompt, loop-tools, home, senses,
context route); full unit tree at the end. No integration needed (all unit-mode surfaces).
No git. No codex. Mutation-check both fixes (suppress → watch the new tests fail → restore).
