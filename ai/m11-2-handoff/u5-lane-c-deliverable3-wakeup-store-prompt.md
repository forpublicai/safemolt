# Deliverable 3 — the wakeup store (both modes)

You are implementing ONE deliverable of SafeMolt's M11-2 wave u5 Lane C ("the wakeup queue"), on
branch `ops/code-improve` in /Users/mohsin/Github/safemolt (already checked out — do NOT switch
branches, do NOT run any git commands). This is a fresh agent with no memory of any prior
conversation; everything you need is below. A prior agent already landed:
- `scripts/migrate-m11-wakeups.sql` (applied to the dev DB) creating `agent_wakeups` and
  `pulse_budget_counters` — read this file first to see the exact table/index shapes you are
  building against.
- `src/lib/events/kinds.ts` gained the `playground.round_opened` kind (you do not need it for this
  deliverable — the wakeup store you are building is deliberately kind-agnostic: it deals in
  `agentId` / `reason` (a plain string) / `eventId` (a plain number) / `payload`, never in
  `EventKind` or `PreparedEvent`).

BEFORE writing any code, read in full:
- `CLAUDE.md`'s "Store and Migration Invariants" section — all of it. You will not emit any events
  yourself in this deliverable (this store has no events of its own), but the invariants about
  dual-store parity, `pickStore`, and "characterize before you change a writer" set the standard
  your code is held to.
- `src/lib/store/pick-store.ts` (the `pickStore` helper — every dual-implementation store domain in
  this repo routes its facade exports through it).
- `src/lib/store/playground/index.ts` as a worked example of a small `pickStore`-based facade file.
- `src/lib/store/_memory-state.ts` lines 1-40 and the `resetGroupState` function (search for it) —
  the pattern for module-level `Map` state on `globalThis` (survives HMR) plus a reset helper.
- `src/lib/store/events/memory.ts` (the whole file) — this is where the in-memory `eventLog` you
  will read from lives (`eventLog.rows`, exported from `_memory-state.ts`), and it is the precedent
  for "read-only import of another domain's memory state."
- `src/lib/agent-loop/state.ts` (the whole file, it is short) — `getLoopState`/`readLoopStateSafely`,
  which you will call from DB mode.
- `src/lib/store/notifications/db.ts` lines 1-50 (`createNotification`, `rowToNotification`) as a
  style precedent for row-mapping and id generation, and `src/lib/store/playground/db.ts`'s
  `applyPlaygroundResolution` function (the whole function) as your best precedent for a
  multi-CTE statement with `RETURNING *` fed into a row mapper.

## One correction to the migration, made after that prior agent's report

The prior agent flagged, correctly, that `ai/PLAN_M11_2.md`'s "Agent-FK policy" pin (search the plan
for that phrase) requires `agent_wakeups.agent_id` and `pulse_budget_counters.agent_id` to carry
`REFERENCES agents(id) ON DELETE CASCADE`, even though the plan's own inline DDL sketch for P3.2
does not repeat it. This has already been fixed and re-applied to the dev DB (`scripts/migrate-m11-wakeups.sql`
now has the FK inline plus a guarded retrofit `ALTER`, verified against `pg_constraint`) — you do not
need to do anything about it, but it means **every `agent_wakeups`/`pulse_budget_counters` row your
integration tests insert must reference a real, already-seeded `agents.id`**, or the insert will raise
a foreign-key violation (`23503`). Seed an agent row first in every integration test (look at any
existing integration suite's `seedAgent()`-style helper for the idiom) — this does not apply to your
memory-mode unit tests, since the memory store has no FK enforcement of its own and you were not asked
to add any (don't add agent-existence checks to the memory implementation; parity with the DB's FK
behavior is out of scope for this deliverable).

## Why this exists (one paragraph, so you understand what you're building)

`agent_wakeups` is a queue: a row means "agent X has a reason to check in." Nothing in this lane
*claims* or *runs* wakeups (that's a later wave, P3.3, explicitly deferred) — you are building the
data layer two OTHER pieces of this same lane will call: the wakeup-router consumer (drains events
and creates wakeups) and the playground deadline sweep (creates-or-re-arms wakeups defensively).
Both of those are being built by other agents against the exact interface below — **do not deviate
from the function names, parameter shapes, or return shapes given here**, because code that does
not exist yet is being written against this contract in parallel/sequence.

## Files

NEW, under `src/lib/store/wakeups/`:
- `src/lib/store/wakeups/index.ts` — the `pickStore`-based facade (re-exported through `src/lib/store.ts`).
- `src/lib/store/wakeups/db.ts` — Postgres implementation.
- `src/lib/store/wakeups/memory.ts` — in-memory implementation, semantically identical.

EDIT:
- `src/lib/store/_memory-state.ts` — add the module state map (see below), following the exact
  existing pattern used for `playgroundSessions`/`playgroundActions` (find them and match the style:
  a `globalStore.__safemolt_*` entry, an exported `const` binding to it, and — check whether
  `playgroundSessions`/other domains export a reset helper at all; if the existing pattern for a
  comparable domain has no reset helper, you do not need to invent one either, but DO add one if you
  see the `resetGroupState`-style pattern used elsewhere for a domain your new tests will need to
  reset between test files).
- `src/lib/store.ts` — the re-export block ONLY. Add wakeup exports next to the playground ones (or
  wherever the file's existing organization suggests), following the exact style already used for
  every other domain (a re-export list, not a wildcard).

Test files: your own new unit tests, under `src/__tests__/lib/store/wakeups/` or similar (match this
repo's existing test file placement conventions — look at where `src/__tests__/lib/store/` puts
domain-specific store tests, e.g. anything testing `playground/db.ts`/`memory.ts` directly, or the
events domain's own tests under `src/__tests__/lib/events/` or `src/__tests__/lib/store/events/`).
Integration tests belong under `src/__tests__/integration/` with a `RUN`-suffix fixture-id
discipline (see "Test requirements" below).

Do NOT touch: `src/lib/events/kinds.ts`, anything under `src/lib/events/consumers/`,
`src/lib/playground/*`, `src/lib/store/playground/*`, `src/lib/actions/*`, `scripts/*`. Those belong
to other deliverables of this same lane, done by other agents, sequenced before or after you.

## The exact interface to build (`src/lib/store/wakeups/index.ts` and its two implementations)

```ts
export interface StoredWakeup {
  id: number;                    // agent_wakeups.id (BIGSERIAL) — Number(), matching StoredEvent.id
  agentId: string;
  reason: string;
  eventId: number | null;
  payload: Record<string, unknown>;
  delivery: "internal" | "webhook" | "none";
  dueAt: string;                 // ISO
  claimedAt: string | null;
  claimToken: string | null;
  leaseExpiresAt: string | null;
  completedAt: string | null;
  result: string | null;
}

export interface EnqueueWakeupInput {
  agentId: string;
  reason: string;
  eventId: number | null;        // null => idle-shaped row, dedup via idx_wakeups_dedup_idle
  payload: Record<string, unknown>;
  delivery: "internal" | "webhook" | "none";
  dueAt?: string;                 // defaults to now
}

export interface EnqueueWakeupResult {
  created: boolean;               // false = a dedup index already had this key; nothing written
  wakeup: StoredWakeup | null;    // the row, only when created === true
}

/** Plain insert. `ON CONFLICT DO NOTHING` against whichever dedup index applies. Never re-arms. */
export async function enqueueWakeup(input: EnqueueWakeupInput): Promise<EnqueueWakeupResult>;

export interface CreateOrReArmWakeupInput {
  agentId: string;
  reason: string;
  eventId: number;                // ALWAYS non-null here — this path is event-keyed dedup only
  payload: Record<string, unknown>;
  delivery: "internal" | "webhook" | "none";
  dueAt?: string;
}

export interface CreateOrReArmWakeupResult {
  created: boolean;
  reArmed: boolean;
  // Never both true. Both false is a LEGITIMATE outcome (see "the create-or-re-arm race" below) —
  // it does not mean nothing happened, it means THIS call didn't do it (a concurrent caller for the
  // same triple did, or an existing row failed the re-arm predicate for a real reason — e.g. it is
  // still pending/claimed, or it completed 'acted', or it completed 'budget_exhausted' today).
}

/**
 * Find-or-create-or-re-arm in ONE statement (db) / one synchronous section (memory), keyed by the
 * dedup TRIPLE (agent_id, reason, event_id) — never by a numeric row id, because the caller does not
 * know one yet. See "SQL — createOrReArmWakeup" below for the exact statement.
 */
export async function createOrReArmWakeup(input: CreateOrReArmWakeupInput): Promise<CreateOrReArmWakeupResult>;

/**
 * The NORMATIVE re-arm predicate, standalone, by a KNOWN numeric id — for a caller that already
 * holds the row (a future runner will; nothing in THIS lane does, but the plan pins this exact SQL
 * and it deserves its own direct unit coverage rather than only being exercised indirectly through
 * createOrReArmWakeup). Do not alter the predicate.
 */
export async function reArmWakeupById(id: number): Promise<boolean>;

export async function getWakeupByAgentReasonEvent(
  agentId: string,
  reason: string,
  eventId: number
): Promise<StoredWakeup | null>;

export async function listWakeupsForAgent(
  agentId: string,
  options?: { reason?: string; limit?: number }
): Promise<StoredWakeup[]>;

/**
 * Locate the `playground.round_opened` event id for (sessionId, round) — real or reconstructed —
 * newest first (there should only ever be one per (session, round) thanks to that kind's producers'
 * gating and the bridge's idem_key, but "newest first, limit 1" is the defensive read). DB: a plain
 * SELECT against `events` — no lock; it's an append-only log and this is a read. Memory: scan
 * `eventLog.rows` from `@/lib/store/_memory-state` (a READ-ONLY import — do not mutate it, and do
 * not import anything from `@/lib/store/events/*` to avoid a layering surprise; `_memory-state.ts`
 * is the shared substrate every domain's memory module reads directly).
 */
export async function findRoundOpenedEventId(sessionId: string, round: number): Promise<number | null>;

/**
 * Delivery resolution — the pre-P5 rule ("loop-enabled -> internal; else the wakeup must not be
 * created"), factored here so BOTH the wakeup-router consumer and the playground deadline sweep
 * (two OTHER deliverables of this lane, one built after you) apply the identical rule instead of
 * each inventing their own.
 *
 * DB mode: call `getLoopState(agentId)` from `@/lib/agent-loop/state` (already exists, DB-only).
 * `enabled === true` -> `"internal"`. A missing row, or `enabled === false` -> `null` (the caller
 * must not create a wakeup for this agent at all).
 *
 * Memory mode: `agent_loop_state` has NO memory-mode store anywhere in this codebase today, and
 * `src/lib/agent-loop.ts` — which would own one if it existed — is a DIFFERENT lane's EXCLUSIVE
 * fence for this milestone (do not touch it, do not import from it). Nothing in this lane's scope
 * (the claim/runner that would actually branch on `delivery` is P3.3, explicitly deferred) reads
 * this value for any decision yet. So memory mode DELIBERATELY and unconditionally resolves
 * `"internal"` for every agent id — this is a recorded, deliberate scope decision, not an oversight.
 * Write this exact reasoning as a code comment at the definition site (do not soften it into just
 * "TODO" — a future reader needs to know this is intentional and why), and repeat it verbatim in
 * your final report's "deferred / scope decisions" section.
 */
export async function resolveWakeupDelivery(agentId: string): Promise<"internal" | null>;
```

## SQL — `enqueueWakeup` (db.ts)

```sql
INSERT INTO agent_wakeups (agent_id, reason, event_id, payload, delivery, due_at)
VALUES ($1, $2, $3, $4::jsonb, $5, COALESCE($6::timestamptz, NOW()))
ON CONFLICT DO NOTHING
RETURNING *
```
A bare `ON CONFLICT DO NOTHING` (no explicit conflict target) is correct and deliberate: Postgres
lets a plain `DO NOTHING` catch a violation of *any* unique constraint or exclusion constraint on the
table, and there are exactly two partial unique indexes that could fire here
(`idx_wakeups_dedup_event` when `event_id IS NOT NULL`, `idx_wakeups_dedup_idle` when `event_id IS
NULL AND completed_at IS NULL`) — whichever applies to this row is the one that should suppress the
insert, and a bare `DO NOTHING` handles both without the caller having to know which. `created =
rows.length > 0`.

## SQL — `createOrReArmWakeup` (db.ts)

```sql
WITH ins AS (
  INSERT INTO agent_wakeups (agent_id, reason, event_id, payload, delivery, due_at)
  VALUES ($1, $2, $3, $4::jsonb, $5, COALESCE($6::timestamptz, NOW()))
  ON CONFLICT DO NOTHING
  RETURNING *
),
rearmed AS (
  UPDATE agent_wakeups
  SET claimed_at = NULL, claim_token = NULL, lease_expires_at = NULL, completed_at = NULL, result = NULL
  WHERE agent_id = $1 AND reason = $2 AND event_id = $3
    AND completed_at IS NOT NULL
    AND result IS DISTINCT FROM 'acted'
    AND (result IS DISTINCT FROM 'budget_exhausted' OR completed_at::date < CURRENT_DATE)
  RETURNING *
)
SELECT (SELECT to_jsonb(ins) FROM ins) AS created_row, (SELECT to_jsonb(rearmed) FROM rearmed) AS rearmed_row
```
Since `eventId` is always non-null on this path, the bare `ON CONFLICT DO NOTHING` in `ins` can only
ever match `idx_wakeups_dedup_event` — note that in a comment. `ins` and `rearmed` are mutually
exclusive by construction in the ordinary case (a freshly-inserted row has `completed_at IS NULL`, so
`rearmed`'s predicate cannot match it), so this does NOT need the "sibling data-modifying CTEs need
an arbiter" lock CLAUDE.md warns about elsewhere — there is no torn-state or deadlock shape here,
only an idempotent "somebody already has this covered" outcome. Read the next section before you
"fix" this.

**The create-or-re-arm race, and why a false/false double-loss is CORRECT, not a bug.** Two
concurrent callers racing `createOrReArmWakeup` for the SAME (agent, reason, event) triple when no
row exists yet (e.g. the wakeup-router consumer and the playground sweep both reacting to the same
freshly-drained `round_opened` event at nearly the same instant) can, under Postgres's MVCC
snapshotting, both come back with `created: false, reArmed: false` — the loser's `ins` correctly
no-ops against the winner's now-committed row, but the loser's OWN statement snapshot was taken
before the winner committed, so its sibling `rearmed` CTE (evaluated against that same snapshot) also
sees no matching row. **This is fine.** After both statements complete, exactly one row exists (never
zero, never two — the unique index enforces that), which is the only invariant that matters: a
"nudge" queue is inherently best-effort, and the sweep that "lost" its create-or-re-arm attempt this
pass will simply see the row already correctly present the next time it looks (or the consumer that
"lost" doesn't need to do anything further — the row already exists in the state it wanted). Do NOT
add a `FOR UPDATE` lock or any other arbiter to force one caller to "win" and see it — that would add
serialization contention for a benign reporting gap with no correctness payoff. Your test for this
(see "Test requirements") must assert on the FINAL ROW COUNT (exactly one), never on both callers'
individual return values agreeing.

## SQL — `reArmWakeupById` (db.ts)

```sql
UPDATE agent_wakeups
SET claimed_at = NULL, claim_token = NULL, lease_expires_at = NULL, completed_at = NULL, result = NULL
WHERE id = $1 AND completed_at IS NOT NULL AND result IS DISTINCT FROM 'acted'
  AND (result IS DISTINCT FROM 'budget_exhausted' OR completed_at::date < CURRENT_DATE)
RETURNING id
```
`reArmed = rows.length > 0`. This predicate is the plan's NORMATIVE text verbatim (`ai/PLAN_M11_2.md`
P3.2) — do not add, remove, or reorder any clause.

## Memory-mode semantics (memory.ts)

Reproduce the SAME dedup/re-arm semantics in a synchronous section against the `wakeups` Map you add
to `_memory-state.ts` — no `await` between reading and writing (there is nothing to `await` here
regardless; this domain issues no events and needs no `prepareEventBatch`/Decision-4 discipline).
Specifically:

- **Event-keyed dedup** (`idx_wakeups_dedup_event`): at most one row EVER (any status, any time) for
  a given `(agentId, reason, eventId)` triple where `eventId !== null` — the index is NOT partial on
  `completed_at`, so a completed row still blocks a second insert forever; only the re-arm UPDATE
  (which reuses the SAME row) ever clears it.
- **Idle dedup** (`idx_wakeups_dedup_idle`): at most one row with `eventId === null` and
  `completedAt === null` per agent+reason — once a row completes, a NEW idle row for that
  agent+reason may be created again (the memory scan must therefore filter on `completedAt === null`
  when checking for a conflicting idle row, exactly mirroring the index's own partial predicate).
- **One-inflight** (`idx_wakeups_one_inflight`): you are not writing any code that sets `claimedAt`
  in this deliverable (no claim function exists yet — P3.3), so this index has no observable effect
  on anything you build. Do not implement claim logic. If a future caller ever tries to set
  `claimedAt` through a function you did not build, that's out of scope; do not add a
  claim/lease-setting function of any kind here.
- id generation: a simple incrementing counter alongside the Map, matching `eventLog.nextId`'s
  pattern in `_memory-state.ts` — read that pattern and mirror it exactly (a counter on the same
  globalThis-cached object, incremented per insert).

## Report format

State plainly: files created/edited; the exact exported function signatures (confirm they match this
contract exactly — if you had to deviate from anything above, say precisely what and why, since
another agent is about to write code against this same contract); gate results (`npx tsc --noEmit`,
`npm run lint`, targeted unit test counts, and a targeted integration run scoped to only your new
suites — do NOT run the full `npm run test:integration` with no args, and do NOT run `npm run
build`); your mutation-check evidence for the create-or-re-arm predicate (suppress one clause of the
re-arm WHERE, watch the corresponding test fail, restore); and the exact wording you used for the
`resolveWakeupDelivery` memory-mode comment (paste it).

## Test requirements

Unit tests (memory mode, `npm test`):
- `enqueueWakeup`: event-keyed dedup rejects a second insert for the same triple (returns
  `created:false`, no second row); idle dedup rejects a second PENDING idle row for the same
  agent+reason but ADMITS a new one once the prior idle row is completed (seed a completed row
  directly, then enqueue again, assert `created:true`).
- `createOrReArmWakeup`: (a) no existing row -> creates; (b) existing row, `completed_at IS NULL`
  (still pending/claimed) -> neither creates nor re-arms (both false); (c) existing row, completed
  with `result:'acted'` -> neither (re-arm refused); (d) existing row, completed with
  `result:'error'` (or `'skip'`/`'abandoned'`) -> re-arms; (e) existing row, completed with
  `result:'budget_exhausted'` and `completed_at` is TODAY -> neither; (f) same but `completed_at` is
  YESTERDAY (seed the row with an explicit past date) -> re-arms. Cases (c)-(f) directly exercise the
  plan's normative predicate — write them as a mutation check: for at least (c) and (e) (the two
  REFUSAL cases), temporarily comment out the relevant predicate clause in your own code, run the
  test, confirm it fails (wrongly re-arms), then restore and confirm it passes. Report this
  explicitly.
- `reArmWakeupById`: same predicate, exercised directly by id.
- `findRoundOpenedEventId`: seed a couple of unrelated events plus a `playground.round_opened` event
  in the memory event log (you can append directly via the events domain's own `emitEvent`/store
  facade — do not hand-construct `eventLog.rows` entries yourself; go through the real API so your
  test also proves the read agrees with how events are actually written) with `subjectId=sessionId`,
  `payload.round=N`; assert it is found; assert a different round or different session id is not.
- `resolveWakeupDelivery`: memory mode returns `"internal"` for an arbitrary agent id with no setup
  at all (proving the documented always-internal behavior).

Integration tests (db mode, `npm run test:integration -- <your new suite file(s)>`), run-unique
fixture ids (a `RUN` suffix, matching every other integration suite's discipline — read
`ai/M11_2_HANDOFF.md`'s "Operational rules" section, already summarized for you: fixed values under
unique columns collide across runs unless suffixed):
- The same dedup/re-arm cases above, against the real table.
- The create-or-re-arm race: two genuinely concurrent `createOrReArmWakeup` calls for the SAME triple
  where no row exists yet (plain `Promise.all`/`runConcurrently` is sufficient here — you do not need
  the `raceAgainstHeldLock` held-transaction harness for this one, since there is no lock to
  contrieve blocking on; a bare concurrent-insert race against the unique index is enough to exercise
  Postgres's own conflict serialization). Assert: exactly one row exists afterward for that triple
  (query it directly), and every settled promise resolved (none rejected) — do NOT assert both
  callers report `created:true`; assert only that the row count is exactly one, per the reasoning
  above.
- `findRoundOpenedEventId` against the real `events` table (seed via the real event-emission path —
  the events domain's `emitEvent`, imported from `@/lib/store`).
- No test in this deliverable needs to touch `playground_sessions` at all — do not seed playground
  fixtures; this domain's tests are self-contained around `agent_wakeups`/`events`/`agent_loop_state`
  (for the db-mode `resolveWakeupDelivery` cases: seed an `agent_loop_state` row with `enabled=true`
  and one with `enabled=false`, or none at all, and assert `"internal"` / `null` / `null`
  respectively — check `scripts/schema.sql` or `migrate-agent-loop.sql` for that table's exact
  columns before seeding).

Clean up everything you seed in `afterAll` (delete by your RUN-suffixed ids / by a `WHERE id LIKE
'u5%'`-style pattern matching this repo's convention — look at any existing integration suite's
`afterAll` for the exact idiom).
