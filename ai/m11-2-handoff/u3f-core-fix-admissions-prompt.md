# u3f-core fix lane — ADMISSIONS (opus implementation)

Repo `/Users/mohsin/Github/safemolt`, branch `ops/code-improve`, HEAD ~`bc1dcb1`. You are fixing the
ADMISSIONS half of codex u3f-core review round 1. Full findings + adjudication:
`ai/m11-2-handoff/codex-findings-u3f-core-round1.md` (read it first). Raw codex log:
`ai/m11-2-handoff/codex-findings-u3f-core-round1-raw.log`.

**Read BEFORE coding:** `agents.md` → the WHOLE "Store and Migration Invariants" section (the
prepared-events rendering rules, memory-preflight discipline, per-path Postgres parity, lock-order
invariants, D6 admissions batch, and "a refusal decided by a pre-read is decided from stale data —
always reach the statement; classify from its flags"). Also `ai/m11-2-handoff/u3f-spec.md` §7/§8.

**Fences — touch ONLY these files** (a concurrent agent owns classes; do not touch
`src/lib/actions/classes.ts`, `src/lib/class-ops/*`, `src/lib/store/classes/*`, `src/app/api/v1/classes/**`,
`src/lib/agent-tools/definitions/classes.ts`, or any classes test):
- `src/lib/admissions/store-db.ts`, `src/lib/admissions/store-memory.ts`, `src/lib/admissions/index.ts`
- `src/lib/actions/admissions.ts`
- `src/app/api/v1/admissions/{application,accept,decline}/route.ts`
- NEW tests: an admissions events/coupling test and an admissions expiry integration test (see M10).
- You MAY read (not edit) `src/lib/store/events/statement.ts`, `src/lib/events/kinds.ts`, `scripts/schema.sql`.

Do NOT edit `src/lib/events/kinds.ts` or `coverage.ts` — the admissions kinds are already landed and
`none` in every manifest; keep them so.

## Fixes (adjudicated — implement exactly this intent)

**B1 — db expiry sweep lock order** (`store-db.ts:88 refreshExpiredOffersDb`). It UPDATEs offers then
applications with no `agents` lock; `deleteAgent` locks agents then cascades → 40P01. Add the ordered
`sweep_agents` CTE that `createOfferDb`'s internal sweep already uses (select the agents of the
expiring offers `ORDER BY a.id FOR KEY SHARE` as the FIRST CTE), so this sweep and agent-deletion
share the agents-first order. Keep the `admissions.offer_expired` event render and the "no other live
offer" release predicate intact; the event still gates on the `expired` UPDATE's RETURNING.

**B2 — memory expiry emits nothing + wrong release** (`store-memory.ts:89 refreshExpiredOffersMem`,
the hardened twin is `expireLapsedOffersSync:311`). Make ONE shared expiry helper that (a) applies the
"no OTHER live (pending, non-expired) offer" predicate before releasing an application to `in_pool`
(the db side and `expireLapsedOffersSync` both do; the current `refreshExpiredOffersMem` does not),
and (b) collects each newly-expired offer. `refreshExpiredOffersMem` then builds one
`admissions.offer_expired` PreparedEvent per collected offer (`actorAgentId: null`, subjectType
`admissions_offer`, `subjectId: offer.id`, `secondarySubjectId: offer.applicationId`, `payload: {}`),
PREFLIGHTS the whole batch (`prepareEventBatch`) before mutating, then `appendPreparedBatch(...).dispatched`.
`expireLapsedOffersSync` (createOffer's internal capacity cleanup) stays event-LESS — matching
`createOfferDb`'s element 2, which also emits nothing. Each offer expires once (`status !== 'pending'`
skips it), so re-calling emits nothing new. Match db semantics exactly.

**M5 — db accept outcome from a post-tx read** (`store-db.ts:556 acceptOfferAsAgentDb`,
`:609 classifyAcceptOutcomeDb`). Classify the `"ok" | "invalid"` outcome from WITHIN the transaction
(mirror the `createCommentWithOutcome` discipline), not a read after it commits: add a final element
to the `sql.transaction` that SELECTs the offer's locked `status, accepted_at_agent` and derive the
outcome there (`ok` = this side's timestamp is set AND status ∈ {pending, fully_accepted}; else
`invalid`). Keep the agent `FOR KEY SHARE`-first order and the idempotent accept predicate. Apply the
same fix to `acceptOfferAsHumanDb` for parity. Do not re-read the offer after the transaction.

**M6 — memory accept yields before finalization** (`store-memory.ts:434 acceptOfferAsAgentMem`). Run
the synchronous finalization (the flip in `tryFinalizeOfferMem`) in the SAME non-yielding section as
the accept write, BEFORE the first `await` (the event dispatch). Only after all state changes are
applied do you `await appendPreparedBatch(...).dispatched` and any `await setAgentAdmitted`. A
concurrent decline must not be able to interleave between the accept write and the finalize flip — the
db batch finalizes atomically. Keep idempotence (a repeat accept still records nothing and returns
`ok`). Preserve `acceptOfferAsHumanMem` parity if it has the same shape.

**M7 — memory duplicate applications** (`store-memory.ts:163 ensureApplicationInPoolMem`). After the
last `await` (`getAgentById`), RE-CHECK `appKey`/`apps` synchronously before writing: if an application
for `(agentId, cycleId)` now exists, return it and emit nothing. This reproduces the PG unique index.

**M8 (admissions) — action-boundary leaks.**
- `admissions/index.ts:184`: the status-read lazy pool-ensure inlines an `admissions.application_submitted`
  PreparedEvent. Route it through the existing `ensurePoolApplication` action in `actions/admissions.ts`
  (currently DEAD — it has no caller). The status service calls the action; the action builds the event.
- `accept/route.ts` and `decline/route.ts`: any missing-resource / ownership refusal decided by an
  adapter pre-read must move into the action (the action already resolves the offer and owns
  `not_found`/`bad_request`); the routes render the action's ActionResult only. Do not pre-read to decide.

**M9 (admissions) — wire-shape regressions.** Characterize the LEGACY response shapes FIRST from the
pre-implementation tree: `git show a2585c5:src/app/api/v1/admissions/application/route.ts` (and accept,
decline). Pin the exact legacy status/title/hint/fields (e.g. no-open-cycle answered 503, not the
current 409; school-denial fields and hints that the action dropped). Add stable `reason` values to the
`actions/admissions.ts` results and map each adapter's render to the EXACT legacy shape. The
characterization test you add (M10) pins these against the legacy values.

**M10 (admissions) — tests.** Add:
- An admissions **events/coupling** unit test (memory mode, no DB): per producer
  (application-ensure, accept, decline, expiry) — the event emits on the real mutation with the right
  payload; a no-op/refused call (already-applied ensure, repeat accept, decline of a non-pending offer,
  expiry of nothing due) emits NOTHING; the memory races from M6/M7 are pinned (mutation-check: the
  test fails on the pre-fix code, passes after). Assert memory expiry now emits `admissions.offer_expired`.
- An admissions **expiry integration** test (`[integration]`, real Postgres): db-mode — the drain
  duty (`runAdmissionsExpiryDuty`) expires a past-due offer, returns its application to the pool, and
  emits `admissions.offer_expired` atomically (event gated on the transition; inject an event-insert
  failure → the offer stays pending, no event); the status read itself writes nothing in db mode; the
  "no other live offer" predicate holds (an application with a second live offer is NOT released).
- A **wire-shape characterization** test pinning the legacy admissions statuses/bodies (M9).
- RUN-suffix every fixture under every UNIQUE column (the reserved integration DB persists rows across
  runs). Use `withEventFailure`-style triggers as `m11-2-u3f-lite.test.ts` does for the rollback tests.

## Working rules
- Characterize FIRST, then change. Mutation-check every behavioral fix: write the failing test, watch
  it fail on the current code, then fix. Preserve every pin in agents.md and the D6 comments.
- No new karma writer; `karma-writer-ownership.test.ts` unchanged. Admissions kinds stay history-only
  `none` in all manifests.
- Gates you run (targeted, this lane only — do NOT run the full suite; the orchestrator runs full five):
  `npx tsc --noEmit`; `npm test -- --runInBand <your admissions unit tests>`; and your admissions
  integration suite via `npm run test:integration -- <path>`. Report exact pass counts and the exact
  commands. Do NOT git commit — the orchestrator owns commits.
- Report: what you changed per finding (file:line), the mutation-check evidence, gate results verbatim,
  and any place you deviated from this spec and why.
