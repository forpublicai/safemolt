# Implementation task — u3f-core: classes + admissions (P1.4's last slice, core lane)

Repo: /Users/mohsin/Github/safemolt, committed through `a2585c5` on `ops/code-improve`. Do NOT run
any git write command — the orchestrator owns commits. Never invoke the `codex` CLI.

Read FIRST, in order: `ai/m11-2-handoff/u3f-spec.md` (your spec — you are the CORE lane, items
5–8), `agents.md` "Store and Migration Invariants" (the whole section), inventory rows the spec
names (§1a classes/admissions, §3c, §4).

Your scope (spec items 5–8):
5. Classes: enroll/drop, class-evaluation submission, the MIXED-ACTOR session-message split with
   the NEW `src/lib/class-ops/*` operator module; the four classes.ts tool executors become
   adapters.
6. The classes/[id] GET YAML re-sync moves behind a class-ops entry point (RECORDED DECISION —
   update inventory §4's row).
7. Admissions: application PATCH → action; accept event joins the existing M9 batch; decline gets
   its event only (already one CTE); lazy pool-ensure invokes the action with `payload.lazy: true`.
8. The offer-expiry sweep joins the P2.2 drain route's housekeeping (db) in the same deploy that
   removes the read-path call; memory keeps the read path as the driver through ONE shared entry
   point; one atomic statement per expired offer.

**The event kinds are PRE-LANDED** (commit `a2585c5`): `class.enrolled`, `class.dropped`,
`class.session_message`, `class.evaluation_submitted`, `admissions.application_submitted`
(`{lazy: boolean}`), `admissions.offer_accepted`/`offer_declined`/`offer_expired` — all
history-only, `none` in every manifest. Do NOT edit kinds.ts or coverage.ts; implement to the
payload types they declare. Use `secondary_subject_id` for the application id on offer events.

Non-negotiables (spec §Non-negotiables, all of them) plus: characterize every wire shape FIRST;
Tier-1 events gate on the decisive mutation's RETURNING; memory twins preflight the full batch and
re-check eligibility after every await, per-path Postgres parity; admissions accept keeps the M9
agent-first `FOR KEY SHARE` order (D6); the C2-style shared authorization is CALLED where one
exists; `karma-writer-ownership.test.ts`'s enumerated inventory unchanged; integration test data
RUN-suffixed under every UNIQUE column, and mind singleton partial-unique indexes (the u3d orphan
precedent).

## Fences — a CONCURRENT lane works profile/inbox/memory-context; respect these strictly
Your surface: src/lib/actions/classes.ts + admissions action file(s) (NEW), src/lib/class-ops/*
(NEW), src/lib/admissions/*, src/lib/store/classes DDL surfaces if any exist under store,
the classes routes (src/app/api/v1/classes/**), the admissions routes (src/app/api/v1/admissions/**),
the drain route's housekeeping hook (src/app/api/v1/internal/events-drain/route.ts — housekeeping
addition ONLY), src/lib/agent-tools/definitions/classes.ts, NEW test files named
m11-2-u3f-core-* plus a characterization file, inventory §1a/§3c/§4 rows + §8 runbook note.
Do NOT touch: kinds.ts, coverage.ts, ANY profile/inbox/memory file (src/app/api/v1/agents/me/**,
src/app/api/v1/memory/**, src/lib/memory/**, definitions/memory.ts, definitions/agents.ts),
evaluations/agents actions and stores, playground files, statement.ts, dispatch.ts,
karma-writer files, consumers, legacy-compare, soak-shadow-report.sql.

## Gates
Targeted suites while iterating. At the end: npx tsc --noEmit && npm run lint &&
npm test -- --runInBand, plus TARGETED integration for your new suites and any suite your files
feed. Do NOT run the full 28-minute integration gate — the orchestrator runs it after both lanes
land. The integration runner serializes on an advisory lock; the OTHER lane may hold it — wait,
never kill. Known flake: c13a. Neon resets connections intermittently — retry before diagnosing.

## Report
Per spec item: files changed, tests added, mutation-check evidence (failing test first), wire
shapes characterized, deviations with reasons. Then the gate summaries verbatim.
