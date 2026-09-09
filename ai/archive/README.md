# Archive index

Superseded plans, audits, and one-off reviews, kept for history. The live planning surface is
`ai/PLAN.md` (+ `## Backlog`), `ai/decisions/`, `ai/validation/`, and the active `PLAN_M{n}.md`
files at the `ai/` root.

- `PLAN_M1.md` — public-surface aesthetic alignment, dead-surface pruning, activity-trail perf pass.
- `PLAN_M2.md` — domain-split the store, drop the dead `houses` tables, tighten theming tokens.
- `PLAN_M2_5.md` — hot-path performance cleanup, cache discipline, text-first render diet.
- `PLAN_M3.md` — unify agent-loop and dashboard-chat onto one tool-calling core; split the tool registry by domain.
- `PLAN_M4.md` — replace the activity-feed UNION-ALL read path with the `activity_events` append-only log.
- `PLAN_M5.md` — interior surfaces aesthetic alignment, per-route loading skeletons, the PlaygroundContent split.
- `PLAN_M6.md` — remaining UI polish, usable search, validation artifact cleanup.
- `PLAN_M7.md` — playground performance, freshness, and visual hierarchy.
- `PLAN_REVIEW_FINDINGS.md` — gaps between PLAN_M{1..5}.md validation claims and live preview behavior.
- `CLAUDE_REVIEW_DASHBOARD_ACTIVITY_PLAYGROUND.md` — review findings for the dashboard/activity/playground surfaces.
- `m1-validation/` — screenshots captured for M1's validation pass.
- `AGENT_EXPERIENCE_AUDIT.md` — 2026-05-13 combined agent/API/public-web experience audit; superseded by M10/M11.
- `AGENT_EXPERIENCE_AUDIT_2026-05-14.md` — 2026-05-14 live agent-perspective follow-up audit; superseded by M10/M11.
- `AGENT_UX_PRIMITIVES_PLAN.md` — primitive map chunking the two audits above into independent UX improvements; executed via M10/M11.
- `cleanup-1.md` — subtraction-focused repo-lean plan; executed via M11-2 P7.4 (still-open items folded into `PLAN.md` `## Backlog`).
- `agent-ux-plans/` — the UX1 index plus ten per-primitive execution chunks (00–10) that implemented `AGENT_UX_PRIMITIVES_PLAN.md`; executed via M10/M11.
