# u3f-core fix lane — CLASSES (opus implementation)

Repo `/Users/mohsin/Github/safemolt`, branch `ops/code-improve`, HEAD ~`bc1dcb1`. You are fixing the
CLASSES half of codex u3f-core review round 1. Full findings + adjudication:
`ai/m11-2-handoff/codex-findings-u3f-core-round1.md` (read it first). Raw log:
`ai/m11-2-handoff/codex-findings-u3f-core-round1-raw.log`.

**Read BEFORE coding:** `agents.md` → the WHOLE "Store and Migration Invariants" section (prepared-
events rendering, per-event `rowSource`/overrides, memory-preflight, per-path Postgres parity, and
"a refusal decided by a pre-read is decided from stale data — always reach the statement; classify
from its flags"). Also `ai/m11-2-handoff/u3f-spec.md` §5/§6.

**Fences — touch ONLY these files** (a concurrent agent owns admissions; do not touch
`src/lib/actions/admissions.ts`, `src/lib/admissions/*`, `src/app/api/v1/admissions/**`, or any
admissions test):
- `src/lib/actions/classes.ts`, `src/lib/class-ops/index.ts`
- `src/lib/store/classes/db.ts` (the enroll/drop/session-message/eval-result writers + any memory twin
  in `src/lib/store/classes/*`)
- `src/app/api/v1/classes/[id]/route.ts`, `.../enroll/route.ts`, `.../drop/route.ts`,
  `.../evaluations/[evalId]/submit/route.ts`, `.../sessions/[sessionId]/messages/route.ts`
- `src/lib/agent-tools/definitions/classes.ts`
- `src/__tests__/lib/m11-2-u3f-core-characterization.test.ts` (extend it) + NEW classes coupling +
  classes integration tests.
- You MAY read (not edit) `src/lib/store/events/statement.ts`, `src/lib/events/kinds.ts`, `scripts/schema.sql`.

Do NOT edit `src/lib/events/kinds.ts` or `coverage.ts` — the class kinds are landed and `none` in every
manifest; keep them so.

## Fixes (adjudicated — implement exactly this intent)

**B3 — an agent teaching-assistant emits `class.session_message`** (`messages/route.ts:66` +
`actions/classes.ts:57 sendSessionMessage`). Per the u3f-spec the professor/TA branch is operator-owned
and history-SILENT (class-ops, no event); only the enrolled-student agent branch emits. Currently an
agent-assistant falls through to `sendSessionMessage`, gets role `ta`, and EMITS. Fix: in the POST
messages route, after the professor check fails and `requireAgent` succeeds, detect
`isClassAssistant(cls.id, agent.id)`; if an assistant → `addOperatorClassSessionMessage(sessionId,
agent.id, "ta", content)` (no event, 201 + data); else → `sendSessionMessage` action (enrolled student,
role `student`, event). Then `sendSessionMessage` serves ONLY enrolled students — drop its assistant
branch (a non-enrolled, non-assistant agent still gets `forbidden`/"Not enrolled"). Keep both branches'
exact wire shape (201, `{ success:true, data: message }`). NOTE (record in your report): this makes
agent-TA class messages history-silent per the spec — a product-semantics choice the orchestrator has
flagged to the user; implement the spec, but keep the change isolated so it is trivially reversible.

**M4 — class producer statements do not enforce the domain gates** (`actions/classes.ts:28 enroll`,
`:57 sendSessionMessage`, `:75 submitEvaluation`; `store/classes/db.ts:337 enrollInClass`,
`:491 addClassSessionMessage`, the eval-result writer ~`:628`). The actions check capacity / class-
active / enrollment-open / session-active / eval-active / enrolled via UNLOCKED pre-reads, then the
statements INSERT/UPDATE with NO such predicate — a race breaches the seat cap or writes to a completed
session AND emits the event on that wrong write. Move the decisive gates INTO the statements: e.g.
`enrollInClass` inserts only `WHERE` the class is active + enrollment open + under `max_students`
(count in-statement) + not already enrolled, `RETURNING` the row; `addClassSessionMessage` inserts only
`WHERE` the session is active and the sender is enrolled/assistant; the eval-result writer only `WHERE`
the eval is active and the agent enrolled. Return an outcome (row-or-null / flags) so the ACTION
classifies the refusal from the statement, not the pre-read; the event gates on the row that passed
every rule (no over-cap write, no message to a dead session, ever emits). Do this in BOTH stores; the
memory twin re-checks the same rules synchronously after each await (per the memory-preflight rule).
Keep each action's existing refusal `code`/`message` vocabulary so wire shapes do not move (see M9).

**M8 (classes) — action-boundary leaks.**
- `classes/[id]/route.ts` still imports `updateClass` (used by the professor PATCH). Move the PATCH's
  class-settings write behind a NEW `class-ops` operator entry point (e.g. `updateClassSettings`), so
  the route file imports NO mutating store export (only read helpers + class-ops). Behavior unchanged;
  no event (operator-owned). The GET re-sync already goes through `refreshClassFromSchoolYaml` — keep it.
- `agent-tools/definitions/classes.ts:263/300` (and the other two mutating executors): remove any
  missing-resource / not-enrolled / not-active refusal the tool decides by a PRE-READ; the executor is
  parse → action → render, classifying from the action's ActionResult only.

**M9 (classes) — wire-shape regressions.** Characterize the LEGACY response shapes FIRST from the pre-
implementation tree: `git show a2585c5:src/app/api/v1/classes/[id]/enroll/route.ts` (and drop, submit,
messages, the class detail route, and the four tool executors in
`git show a2585c5:src/lib/agent-tools/definitions/classes.ts`). Pin the exact legacy status/title/hint/
fields. Ensure your M4/B3/M8 changes preserve them — where the action's `code`→status mapping differs
from legacy, add stable `reason` values and map each adapter to the exact legacy shape.

**M10 (classes) — tests.** Extend `m11-2-u3f-core-characterization.test.ts` beyond import-text, and add:
- A classes **events/coupling** unit test (memory mode, no DB): per producer (enroll, drop,
  session-message, eval-submit) — the event emits on the real mutation with the right payload; a
  refused/no-op mutation (class full, not enrolled, session/eval not active, already enrolled, drop of
  a non-enrolled) emits NOTHING; the assistant split (a TA message emits nothing, a student message
  emits); the M4 in-statement gates hold (mutation-check: the race/over-cap test fails on the pre-fix
  code, passes after).
- A classes **integration** test (`[integration]`, real Postgres): each producer's write + event are
  one statement (inject an event-insert failure via a `withEventFailure`-style trigger → the write
  rolls back, no event — see `m11-2-u3f-lite.test.ts` for the pattern); the enroll capacity gate holds
  in SQL; a message to a completed session writes nothing and emits nothing.
- A **wire-shape characterization** test pinning the legacy classes statuses/bodies (M9).
- RUN-suffix every fixture under every UNIQUE column (the reserved integration DB persists rows across
  runs).

## Working rules
- Characterize FIRST, then change. Mutation-check every behavioral fix: write the failing test, watch
  it fail on the current code, then fix. Preserve every pin. Class routes taking `{id}` keep the
  UUID-or-slug resolution.
- No new karma writer; `karma-writer-ownership.test.ts` unchanged. Class kinds stay history-only `none`.
- The `group-school-gate.test.ts` structural scan must stay green: each migrated agent mutation leaves
  the route scan and appears in the action scan.
- Gates you run (targeted, this lane only — do NOT run the full suite; the orchestrator runs full five):
  `npx tsc --noEmit`; `npm test -- --runInBand <your classes unit tests>`; your classes integration
  suite via `npm run test:integration -- <path>`. Report exact pass counts and the exact commands. Do
  NOT git commit — the orchestrator owns commits.
- Report: what you changed per finding (file:line), the mutation-check evidence, gate results verbatim,
  and any deviation from this spec and why.
