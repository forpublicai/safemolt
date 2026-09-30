# u3f — the last P1.4 slice: classes, memory, profile, admissions, inbox

Repo: /Users/mohsin/Github/safemolt, branch `ops/code-improve`. Source of truth: `ai/PLAN_M11_2.md`
P1.4 table + Locked decisions; `ai/validation/m11-inventory.md` §1a/§2/§3c/§3d/§4/§7; `agents.md`
"Store and Migration Invariants" (read the WHOLE section first). The verbatim source rows are
collected in the orchestrator's extraction (`u3f-source-material.md` in the session scratchpad).

## Why this slice is structurally lighter than u3d/u3e

Every kind u3f adds is **history-only**: `agent.profile_updated`, `memory.context_written`,
`memory.context_deleted`, `class.enrolled`, `class.dropped`, `class.session_message`,
`class.evaluation_submitted`, `admissions.application_submitted`, `admissions.offer_accepted`,
`admissions.offer_declined`, `admissions.offer_expired`. Inventory §9a/§9b confirm **no legacy
inline writer exists for any of them** — so there is NO shadow machinery, no transitional
projection, no soak participation in this slice. Each kind enters `kinds.ts` and gets `none` in
all three coverage manifests in the same deploy (the u1 rule). Inbox mark-read carries no kind at
all (Tier B). Producers are still full Tier 1: event gated on the decisive mutation's RETURNING,
both stores, memory preflight discipline per agents.md.

## Execution split — two lanes, disjoint fences

**u3f-lite (LOW RISK — one codex round, stop unless BLOCKER/MAJOR):**
1. **Profile**: `actions.updateMyProfile` owns the reserved-key metadata allowlist
   (**unconditional** — M10 D1 superseded). `agents/me` PATCH, `agents/me/avatar` POST/DELETE and
   the `update_my_profile` tool become adapters. One kind, `agent.profile_updated`, with
   `payload.fields` = the statement's before/after diff (the playground-join precedent — never the
   request's field list); avatar rides the same kind with `payload.fields: ["avatar"]`.
2. **Inbox read-state**: mark-one-read + read-all become Tier B actions (validation + thin
   adapters, NO events). `notifications.read_at` only.
3. **Memory raw-vector routes** (`memory/vector/upsert`, `memory/vector/delete`): Tier B actions —
   they mutate only the external vector store; validation and rate limits ride the action; NO
   events.
4. **Memory context write/delete** (`memory/context/file` PUT/DELETE + `put_context_file`/
   `delete_context_file` tools): Tier 1 — single-row upsert/delete batched with its event; the
   vector-index side effect stays the existing best-effort follow-up. The GET `IDENTITY.md`
   first-read backfill invokes the SAME write action with `payload.lazy: true` (state-changing GET,
   inventory §4).

**u3f-core (mixed risk — full rounds only where lock/atomicity-bearing):**
5. **Classes**: enroll/drop, class-evaluation submission, and the class-session message. The
   messages route is **MIXED-ACTOR**: the agent branch calls the action; the professor/TA branch
   moves behind `src/lib/class-ops/*` (NEW module — a named operator entry point, a legitimate
   writer outside the P1.6 boundary); the route file ends with NO mutating store import. The four
   `classes.ts` mutating tool executors become adapters. Class routes accepting `{id}` keep the
   UUID-or-slug resolution pin (agents.md).
6. **Classes GET re-sync ruling (RECORDED DECISION)**: `classes/[id]/route.ts` GET calls
   `updateClass` to re-sync from school YAML on every read, for both actor kinds (inventory §4
   flags it as needing a decision). RULING: move the refresh behind a `class-ops` entry point so
   the route imports no mutating store export; behavior unchanged; record the decision in
   inventory §4's row. Do NOT invent an event for it (operator-owned sync, out of the agent
   surface).
7. **Admissions**: `updateApplicationNiche` (agent PATCH route → action; the staff route keeps
   calling the domain service directly — it is a mixed-actor DOMAIN SERVICE, not a mixed route
   file); accept — `admissions.offer_accepted` joins the EXISTING M9 batch (agent `FOR KEY SHARE`
   first, D6 order); decline — already one CTE (inventory drift note: no batching work left), add
   `admissions.offer_declined` only; lazy pool-ensure from the status read invokes the application
   action with `payload.lazy: true` emitting `admissions.application_submitted`.
8. **Offer-expiry housekeeping move**: expiry leaves `getAdmissionsStatusForAgent`'s read path in
   db mode and joins the ALREADY-LIVE P2.2 drain route's housekeeping duties **in the same deploy**
   (gap-free at `*/5` cadence; rollout overlap is harmless — the sweep is idempotent). The sweep is
   one atomic statement per expired offer: offer transition + application returned to the pool +
   gated `admissions.offer_expired`. **Memory mode keeps the read path as the expiry driver**
   through ONE shared entry point (Decision 6 — no cron in memory mode), still emitting through
   the append→dispatcher path. Driver divergence, identical state semantics — the deadline sweep's
   pattern.

The two lanes may run as two agents concurrently: lane fences are disjoint (lite: profile/inbox/
memory files; core: classes/admissions files). `kinds.ts` + `coverage.ts` are SHARED — the lane
that lands first adds its kinds; the second rebases its additions (append-only edits, trivial
merge). If run sequentially, one agent does lite then core.

## Non-negotiables (both lanes)

- Adapters are parse → action → render; characterize every wire shape FIRST (status, body, titles,
  error codes) and pin it. No refusal decided from an adapter pre-read.
- Tier-1 events gate on the decisive mutation's RETURNING in the same statement; no write without
  event, no event without write; memory twins preflight the FULL batch before any write and
  re-check eligibility after every await (agents.md, per-path Postgres parity).
- The C2-style shared authorization is CALLED where one exists, never re-implemented.
- `karma-writer-ownership.test.ts`'s enumerated inventory unchanged. No karma writer appears here.
- The structural gate (`group-school-gate.test.ts` and its scans): each migrated mutation leaves
  the route scan and appears in the action scan.
- Verify `markChallengeFetched` already rides its Tier-B action from u3e; if not, absorb it in
  u3f-lite (both challenge-fetch GETs, inventory §4).
- Test data in integration suites is RUN-suffixed under every UNIQUE column (the u3e nonce
  precedent — the reserved DB persists rows across runs).
- Inventory updates: tick the §1a/§2 Migrated boxes this slice migrates; record the §4 classes-GET
  ruling; add the u3f runbook section to §8 (deploy is single-phase — history-only kinds need no
  shadow protocol).

## Gates (per the plan's P1.4 gate list, u3f rows)

- Profile reserved-key test (**unconditional**): trust/visibility-adjacent metadata keys rejected
  via BOTH adapters.
- Memory-mode admissions-expiry: an offer past `expires_at` transitions (and its application
  returns to the pool) via the plain status read, no manual housekeeping call.
- Db-mode admissions-expiry: the drain route's sweep expires a past-due offer, returns the
  application to the pool, and emits `admissions.offer_expired` atomically with the transition,
  while the status read itself writes nothing.
- Mixed-actor split: after migration the messages route file imports no mutating store export;
  agent sends go through the action (event emitted), professor sends through `class-ops` (no
  event); both branches keep their exact wire shapes.
- Per-domain adapter parity + negative-authorization through both adapters where both exist
  (classes and memory tools; admissions and inbox are REST-only — no tool surface exists, do not
  invent one).
- Tier-1 coupling tests per producer: refused/no-op mutations emit nothing; event-failure
  injection rolls back the write (db) / restores snapshots (memory).
- Full five gates before each codex round: tsc, lint, unit, integration, build. Targeted suites
  while iterating (working rule 3).

## Review protocol

u3f-lite: ONE codex round (`codex exec --sandbox read-only`, scoped prompt), stop unless
BLOCKER/MAJOR. u3f-core: iterate BLOCKER/MAJOR to convergence, but the surface is small — the
admissions batch order (agent lock first) and the mixed-actor split are the two places a blocker
can live. Codex runs are SOLO, sequential with every other codex use. Reviewers must be told NOT
to run jest/build (sandbox denies the temp writes).
