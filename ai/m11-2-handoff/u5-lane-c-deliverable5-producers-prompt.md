# Deliverable 5 — the `playground.round_opened` producers (the highest-risk piece of this lane)

You are implementing ONE deliverable of SafeMolt's M11-2 wave u5 Lane C ("the wakeup queue"), on
branch `ops/code-improve` in /Users/mohsin/Github/safemolt (already checked out — do NOT switch
branches, do NOT run any git commands). This is a fresh agent with no memory of any prior
conversation; everything you need is below.

Two prior agents in this same lane already landed, and are DONE — you do not need to build or modify
either:

1. `scripts/migrate-m11-wakeups.sql` (applied to the dev DB) — `agent_wakeups`,
   `pulse_budget_counters`, FK'd to `agents(id) ON DELETE CASCADE`.
2. `src/lib/events/kinds.ts` gained the `playground.round_opened` kind:
   `{ session_id: string; round: number; reconstructed?: boolean }`, subject columns
   `subjectType: "playground_session"`, `subjectId: <session id>`. Coverage manifests
   (`src/lib/events/consumers/coverage.ts`) are set: notifications `"on"`, activity-trail `"none"`,
   memory-ingest `"none"`.
3. `src/lib/store/wakeups/{index,db,memory}.ts` — a dual-mode wakeup queue store. You will call THREE
   of its exports (all already implemented and tested; do not reimplement, do not modify these
   files):
   - `findRoundOpenedEventId(sessionId: string, round: number): Promise<number | null>`
   - `resolveWakeupDelivery(agentId: string): Promise<"internal" | null>`
   - `createOrReArmWakeup(input: { agentId: string; reason: string; eventId: number; payload:
     Record<string, unknown>; delivery: "internal" | "webhook" | "none"; dueAt?: string }):
     Promise<{ created: boolean; reArmed: boolean }>`

   All three are re-exported from `@/lib/store` (the store facade), so `session-manager.ts`'s
   existing `const store = await getStore()` lazy-import pattern gives you `store.findRoundOpenedEventId(...)`,
   `store.resolveWakeupDelivery(...)`, `store.createOrReArmWakeup(...)` for free — do not add a new
   import statement at the top of `session-manager.ts` for these; use the existing `store` binding
   exactly the way every other store call in that file already does.

BEFORE writing any code, read in full:
- `CLAUDE.md`'s "Store and Migration Invariants" section — all of it. The specific rules that bind
  every change you make here: "The store fills what only the statement knows... FAILS LOUD" (not
  directly relevant — you have no `STORE_ASSIGNED_PAYLOAD_ID` fields here), "The PRIMARY event is the
  one at index 0" (not relevant — you never emit more than one event per statement here), "Sibling
  data-modifying CTEs need an ARBITER" (relevant to nothing you touch — you are not writing a
  multi-arm CTE), "Never read `ev_0` as positional truth" (relevant only if you look at
  `emitEventCtes`'s internals, which you should not need to). The rules that DO bind you directly:
  the playground-specific bullets about `activateSession` no longer pre-setting `round_deadline`, the
  round-1 prompt race, the CAS carrying the complete transition state, and the reconstruction bridge —
  these are already stated in CLAUDE.md's playground section (search for "playground join is ONE
  conditional statement" and read forward through the playground-specific bullets; they describe the
  EXISTING P1.4 machinery you are extending, not what you're building, but you must not violate any
  of them).
- `ai/PLAN_M11_2.md`, search for `**P3.2 — The wakeup queue.**` and read that whole numbered section
  (it is long — one paragraph covers everything from the table DDL through the rollout). The parts
  that matter most for THIS deliverable are: "`playground.round_opened` emission timing (pinned)"
  through "**Rollout bridge (a4):**" — read those two paragraphs twice. Every SQL shape and predicate
  below is derived from that text; where this file gives you exact SQL, use it exactly.
- `src/lib/playground/session-manager.ts` (the WHOLE file, 1215 lines — yes, all of it; you are
  changing three functions inside it and adding steps to a fourth, and you cannot safely do that
  without seeing the whole control flow).
- `src/lib/playground/lifecycle.ts` (the whole file, short).
- `src/lib/store/playground/db.ts` (the whole file) — study `applyPlaygroundResolution`,
  `listSessionsDueForLifetimeCap`, `expireStalePendingSessions`, and `activatePlaygroundSession`
  closely; your new functions are siblings of these and must match their style (parameter order,
  `spliceCtes` usage, row-mapping via `rowToPlaygroundSession`).
- `src/lib/store/playground/memory.ts` (the whole file) — same reason, for the memory twin.
- `src/lib/actions/playground-events.ts` (the whole file, short) — you are adding ONE builder here.
- `ai/M11_2_HANDOFF.md`'s "Operational rules" section (already summarized for you): run-unique
  integration fixture ids; the `idx_pg_sessions_one_live_per_school` one-per-scope index means your
  integration suites must neutralize orphaned live sessions in `beforeAll`, exactly like
  `src/__tests__/integration/m11-2-u3d-playground.test.ts` already does (read that file's `beforeAll`
  for the exact idiom and copy it).

## What you are building, in one paragraph

Today, a playground round's prompt is stored two ways: round 1 is stored ASYNCHRONOUSLY after
activation (a `safeWaitUntil`-scheduled write, unconditional `updatePlaygroundSession`), and rounds
≥ 2 are stored inside `advanceToNextRound`'s resolution write (`applyPlaygroundResolution`, already a
CAS keyed on `(status='active', current_round=$prev)`, already able to carry events — it just isn't
given any today). You are making BOTH paths emit `playground.round_opened` **gated on the exact
statement that durably stores that round's prompt**, never on a promptless status flip — plus a
defensive repair sweep for a crashed round-1 write, a rollout bridge for sessions that predate this
kind, and a sweep step that creates-or-re-arms wakeups for any active round whose event already
exists. Read the plan text above for WHY each piece exists; this file tells you exactly HOW to build
each one.

## Files

EDIT (all already in your fence):
- `src/lib/store/playground/db.ts`
- `src/lib/store/playground/memory.ts`
- `src/lib/store/playground/index.ts` (the `pickStore` export lines — you're adding two new ones and
  the arity of one existing one changes)
- `src/lib/actions/playground-events.ts`
- `src/lib/playground/session-manager.ts`
- Existing playground tests that pin the writers you are changing (see "Characterization, precisely"
  below for which files to search).

NEW test files under `src/__tests__/` following this repo's existing placement conventions for
playground unit/integration tests (mirror where `m11-2-u3d-playground.test.ts` /
`m11-2-u3d-playground-characterization.test.ts` / `lifecycle.test.ts` already live).

Do NOT touch: `src/lib/store/wakeups/**` (done, treat as a black box behind the three functions
named above), `src/lib/events/**`, `src/lib/store/_memory-state.ts`, `src/lib/store.ts`,
`src/lib/actions/playground.ts` (unless a builder signature you add genuinely forces a change there —
it should not; you are only adding one new event builder to `playground-events.ts`, and
`actions/playground.ts` never calls the two writers you are changing), `scripts/*`.

---

## Piece 1 — `activateSession` stops pre-setting the deadline; round-1 prompt storage becomes ONE
## dedicated conditional store op, shared by activation and the repair sweep

### 1a. `activatePlaygroundSession` — remove the `roundDeadline` parameter

Current signature (db.ts and memory.ts):
```ts
activatePlaygroundSession(sessionId: string, initialRound: number, roundDeadline: string, startedAt: string): Promise<boolean>
```
New signature (both files):
```ts
activatePlaygroundSession(sessionId: string, initialRound: number, startedAt: string): Promise<boolean>
```
db.ts: remove `round_deadline = ${roundDeadline}` from the `SET` clause of the UPDATE — the column is
simply not touched, so it stays whatever it already was (NULL for a session that was pending, which
is every caller today). Everything else in the function (the `status = 'pending'` gate, the
post-commit `recordPlaygroundSessionActivityEvent` call, the boolean return) is UNCHANGED — this
activation still refreshes the trail (the session becomes visibly "active"), it just no longer claims
a deadline nobody can act against yet.

memory.ts: remove the `roundDeadline` parameter and stop writing `updated.roundDeadline`.

`src/lib/store/playground/index.ts`: the existing line
`export const activatePlaygroundSession = pickStore(db.activatePlaygroundSession, mem.activatePlaygroundSession);`
needs no textual change — `pickStore`'s arity check will simply now validate against the new 3-arg
signature on both sides. Just confirm it still compiles.

Grep the whole repo for `activatePlaygroundSession(` before you start (`grep -rn
"activatePlaygroundSession(" src`) — as of the last check there was exactly ONE call site
(`session-manager.ts`'s `activateSession`, which you are also changing in 1b) plus the store's own
`db.ts`/`memory.ts`/`index.ts` definitions. If your grep finds any OTHER call site (a route, a tool,
a test calling the store function directly by name), update it too and say so in your report.

### 1b. `storeRound1PromptIfMissing` — the new dedicated conditional store op

New function, exported from BOTH `db.ts` and `memory.ts`, added to `index.ts`'s `pickStore` list.

```ts
storeRound1PromptIfMissing(
  sessionId: string,
  prompt: string,
  roundDurationMs: number,
  events?: readonly PreparedEvent[]
): Promise<boolean>
```

db.ts — exact SQL (this is the plan's normative predicate; do not alter it):
```sql
WITH prompted AS (
  UPDATE playground_sessions
  SET current_round_prompt = $2::text,
      round_deadline = NOW() + make_interval(secs => $3::int)
  WHERE id = $1::text AND status = 'active' AND current_round = 1 AND current_round_prompt IS NULL
  RETURNING id
){emitted CTEs spliced}
SELECT prompted.id FROM prompted
```
Follow `completePlaygroundSessionAtLifetimeCap`'s exact shape as your template: build `params`,
render `emitEventCtes(events, "prompted", { firstParamIndex: params.length + 1, overrides:
events?.length ? [{ columnSql: { subject_id: sqlParam(1, "text") } }] : [] })`, splice with
`spliceCtes(emitted.ctes)`, return `rows.length > 0`. `$3` is seconds
(`Math.max(1, Math.round(roundDurationMs / 1000))`, same rounding `expireStalePendingSessions` uses
for its own duration parameter).

**No activity-trail splice.** `playground.round_opened`'s activity-trail coverage is `"none"` (already
set by a prior agent) — there is no new public activity kind for a round opening (Decision 5), and the
session's trail row already reflects only lifecycle-level state (created/joined/completed/cancelled/
expired), never per-round state. Do not call `buildPlaygroundSessionActivityUpsertCtes` here.

memory.ts:
```ts
export async function storeRound1PromptIfMissing(
  sessionId: string,
  prompt: string,
  roundDurationMs: number,
  events?: readonly PreparedEvent[]
): Promise<boolean> {
  const prepared = withSessionSubject(events, sessionId);
  validatePreparedEvents(prepared);
  const session = playgroundSessions.get(sessionId);
  if (!session || session.status !== 'active' || session.currentRound !== 1 || session.currentRoundPrompt !== undefined) {
    return false;
  }
  const batch = prepareEventBatch(prepared);
  playgroundSessions.set(sessionId, {
    ...session,
    currentRoundPrompt: prompt,
    roundDeadline: new Date(Date.now() + roundDurationMs).toISOString(),
  });
  const { dispatched } = appendPreparedBatch(batch);
  await dispatched;
  return true;
}
```
Use `withSessionSubject`/`validatePreparedEvents`/`prepareEventBatch`/`appendPreparedBatch` exactly
as the other memory.ts writers in this file already do (they're already imported at the top of the
file). Note the `!== undefined` check — `IS NULL` in SQL is not the same as falsy in JS, and this
domain's `currentRoundPrompt` type is `string | undefined`; matching `IS NULL` means checking for
`undefined` specifically, not `!session.currentRoundPrompt` (which would also treat a
hypothetical empty-string prompt as "missing," which the SQL predicate would not).

### 1c. `activateSession` (session-manager.ts, private function) — wire both changes together

Current:
```ts
async function activateSession(session: PlaygroundSession, game: PlaygroundGame): Promise<boolean> {
    const store = await getStore();
    const now = new Date().toISOString();
    const roundDeadline = new Date(Date.now() + ACTION_TIMEOUT_MS).toISOString();

    const activated = await store.activatePlaygroundSession(session.id, 1, roundDeadline, now);
    if (!activated) return false;

    const activeSession: PlaygroundSession = { ...session, status: 'active', currentRound: 1, startedAt: now, roundDeadline };

    safeWaitUntil(
        generateRoundPrompt(activeSession, game).then(async (roundPrompt) => {
            await store.updatePlaygroundSession(session.id, { currentRoundPrompt: roundPrompt });
            console.log(`[playground] Round 1 prompt saved for session ${session.id}.`);
        }),
        `round1-prompt:${session.id}`
    );
    return true;
}
```
New:
```ts
async function activateSession(session: PlaygroundSession, game: PlaygroundGame): Promise<boolean> {
    const store = await getStore();
    const now = new Date().toISOString();

    const activated = await store.activatePlaygroundSession(session.id, 1, now);
    if (!activated) return false;

    // No roundDeadline yet: the clock starts when the prompt is durably stored, not before —
    // an active round-1 session promptless in this window is treated as un-expirable by every
    // deadline-scanning path (they all key off `roundDeadline` being set at all).
    const activeSession: PlaygroundSession = { ...session, status: 'active', currentRound: 1, startedAt: now };

    safeWaitUntil(
        generateRoundPrompt(activeSession, game).then(async (roundPrompt) => {
            const stored = await store.storeRound1PromptIfMissing(session.id, roundPrompt, ACTION_TIMEOUT_MS, [
                playgroundRoundOpenedEvent({ sessionId: session.id, round: 1, schoolId: session.schoolId ?? null }),
            ]);
            if (stored) {
                console.log(`[playground] Round 1 prompt saved for session ${session.id}.`);
            } else {
                console.log(`[playground] Round 1 prompt for session ${session.id} was already stored (the repair sweep won this race); discarding this generation.`);
            }
        }),
        `round1-prompt:${session.id}`
    );
    return true;
}
```
Add the import for `playgroundRoundOpenedEvent` to session-manager.ts's existing import block from
`@/lib/actions/playground-events` (that block already imports `playgroundSessionCompletedEvent` and
`playgroundSessionCreatedEvent`, `playgroundSessionExpiredEvent` — add the new name to the same
`import { ... } from '@/lib/actions/playground-events';` line).

### 1d. The new event builder, `src/lib/actions/playground-events.ts`

```ts
/**
 * `playground.round_opened` — for BOTH producers (the round-1 async prompt write, and
 * `advanceToNextRound`'s CAS for rounds >= 2), and for the rollout bridge's synthetic reconstruction.
 *
 * `subject_id` is store-assigned for round 1 (the session id is already known at the caller, so it
 * is actually supplied directly here, not through the store-assigned marker — every call site of
 * this builder already has a concrete session id in hand, unlike `playgroundSessionCreatedEvent`
 * whose caller does not yet know the id the store is about to mint). `actorAgentId` is NULL: no
 * agent opens a round, the GM/system does (the same reasoning `session_completed` and
 * `session_expired` already carry for their own NULL actors).
 */
export function playgroundRoundOpenedEvent(options: {
  sessionId: string;
  round: number;
  schoolId: string | null;
  /** True only for the rollout bridge's synthetic reconstruction of a pre-existing prompted round. */
  reconstructed?: boolean;
  /**
   * Only the rollout bridge sets this: `playground_round_opened:{session_id}:{round}` makes repeated
   * sweep passes emit exactly one synthetic event for a session that predates this kind. The two
   * REAL producers (round-1 activation, the round-advance CAS) carry no idem key at all — their
   * uniqueness comes from the conditional statement's own predicate, not from a key.
   */
  idemKey?: string;
}): PreparedEvent<"playground.round_opened"> {
  return {
    ...playgroundSubjects({ sessionId: options.sessionId, actorAgentId: null, schoolId: options.schoolId }),
    kind: "playground.round_opened",
    ...(options.idemKey !== undefined ? { idemKey: options.idemKey } : {}),
    payload: {
      session_id: options.sessionId,
      round: options.round,
      ...(options.reconstructed ? { reconstructed: true } : {}),
    },
  };
}
```
Place it after `playgroundSessionExpiredEvent` (the file's last existing export), matching the file's
existing doc-comment density and tone.

---

## Piece 2 — `advanceToNextRound`'s CAS carries the event (rounds ≥ 2)

`applyPlaygroundResolution` (the store function) ALREADY accepts a 5th parameter,
`events?: readonly PreparedEvent[]`, and already renders it via `emitEventCtes(events, "advanced",
...)` gated on the SAME CAS `advanced` CTE that carries round/prompt/deadline/transcript/participants.
**You do not need to change `applyPlaygroundResolution` in `db.ts` or `memory.ts` at all** — this is
deliberate: the CAS shape already gives you "loser writes nothing, emits nothing" for free. Your only
change is at the CALL SITE, in `session-manager.ts`'s `advanceToNextRound`:

Current call (no events):
```ts
    const won = await store.applyPlaygroundResolution(
        input.session.id,
        input.fence,
        {
            participants: input.participants,
            transcript: input.transcript,
            currentRound: nextRound,
            currentRoundPrompt: nextPrompt,
            roundDeadline: nextDeadline,
        },
        input.memories
    );
```
New (add the 5th argument):
```ts
    const won = await store.applyPlaygroundResolution(
        input.session.id,
        input.fence,
        {
            participants: input.participants,
            transcript: input.transcript,
            currentRound: nextRound,
            currentRoundPrompt: nextPrompt,
            roundDeadline: nextDeadline,
        },
        input.memories,
        [
            playgroundRoundOpenedEvent({
                sessionId: input.session.id,
                round: nextRound,
                schoolId: input.session.schoolId ?? null,
            }),
        ]
    );
```
**Do not touch `completeSession`'s call** to `applyPlaygroundResolution` — completion does not open a
new round, and it already correctly carries only `playgroundSessionCompletedEvent`. Write a
characterization test proving completion NEVER emits `playground.round_opened` (see "Characterization,
precisely" below) — this is a pin against a future accidental regression, not a behavior change.

---

## Piece 3 — the round-1 repair, the reconstruction bridge, and create-or-re-arm, all inside
## `checkDeadlines()` (session-manager.ts)

### 3a. New store list function: `listSessionsNeedingRound1PromptRepair`

`db.ts` and `memory.ts`, added to `index.ts`'s pickStore list:
```ts
listSessionsNeedingRound1PromptRepair(graceMs: number, limit: number): Promise<PlaygroundSession[]>
```
Model it EXACTLY on `listSessionsDueForLifetimeCap` (same file, same style — oldest-first, bounded,
predicate fully in the query so a page cannot re-return a row the caller already processed). db.ts SQL:
```sql
SELECT * FROM playground_sessions
WHERE status = 'active' AND current_round = 1 AND current_round_prompt IS NULL
  AND COALESCE(started_at, created_at) <= NOW() - make_interval(secs => $1)
ORDER BY COALESCE(started_at, created_at) ASC
LIMIT $2
```
(`$1` = seconds, same rounding convention as elsewhere in this file; `$2` = `Math.max(1,
Math.floor(limit))`.) memory.ts: filter `playgroundSessions` by the same predicate
(`status === 'active' && currentRound === 1 && currentRoundPrompt === undefined && Date.parse(startedAt
?? createdAt) <= cutoffMs`), sort ascending by that same timestamp, slice to `limit` — copy
`listSessionsDueForLifetimeCap`'s memory twin almost verbatim, changing only the predicate.

### 3b. `checkDeadlines()` — three new steps

Read the CURRENT `checkDeadlines()` function in full before editing (it has five numbered steps today:
1 advance, 1b auto-activate pending, then the lifetime cap call sits between 1 and 1b currently — check
the exact order in the file rather than trusting this description, and preserve every EXISTING step's
relative order and behavior unchanged). Insert three NEW steps after the existing auto-activation step
(1b) and BEFORE the existing step 2 (expire stale pending sessions):

```ts
// 1c. Repair active round-1 sessions whose prompt never landed (a crashed activation write).
try {
    const stuck = await store.listSessionsNeedingRound1PromptRepair(ROUND1_PROMPT_REPAIR_GRACE_MS, 50);
    for (const session of stuck) {
        try {
            const game = resolvePlaygroundGame(session.schoolId, session.gameId);
            if (!game) continue;
            const roundPrompt = await generateRoundPrompt(session, game);
            const stored = await store.storeRound1PromptIfMissing(session.id, roundPrompt, ACTION_TIMEOUT_MS, [
                playgroundRoundOpenedEvent({ sessionId: session.id, round: 1, schoolId: session.schoolId ?? null }),
            ]);
            if (stored) {
                console.log(`[playground] Repaired missing round-1 prompt for session ${session.id}.`);
            }
        } catch (err) {
            console.error(`[playground] Error repairing round-1 prompt for session ${session.id}:`, err);
        }
    }
} catch (err) {
    console.error('[playground] Error scanning for round-1 prompt repairs:', err);
}

// 1d. Rollout bridge: any active, PROMPTED current round lacking a round_opened event gets exactly
// one synthetic one (idempotent via idem_key — a session predating this kind, or one whose real
// event is merely slow to have landed, converges to exactly one event either way).
try {
    const activePrompted = await store.listPlaygroundSessions({ status: 'active', limit: 50 });
    for (const session of activePrompted) {
        if (session.currentRoundPrompt === undefined) continue; // still promptless; repair owns this
        try {
            const existing = await store.findRoundOpenedEventId(session.id, session.currentRound);
            if (existing) continue;
            await store.emitEvent(
                playgroundRoundOpenedEvent({
                    sessionId: session.id,
                    round: session.currentRound,
                    schoolId: session.schoolId ?? null,
                    reconstructed: true,
                    idemKey: `playground_round_opened:${session.id}:${session.currentRound}`,
                })
            );
            console.log(`[playground] Reconstructed round_opened for session ${session.id} round ${session.currentRound}.`);
        } catch (err) {
            // A 23505 on the idem key means a concurrent sweep pass already reconstructed it —
            // benign, not an error.
            const code = (err as { code?: string } | null)?.code;
            if (code !== '23505') {
                console.error(`[playground] Error reconstructing round_opened for session ${session.id}:`, err);
            }
        }
    }
} catch (err) {
    console.error('[playground] Error scanning for round_opened reconstruction:', err);
}

// 1e. Create-or-re-arm wakeups for active, un-acted participants of the current round.
try {
    const activeForWakeups = await store.listPlaygroundSessions({ status: 'active', limit: 50 });
    for (const session of activeForWakeups) {
        try {
            const eventId = await store.findRoundOpenedEventId(session.id, session.currentRound);
            if (!eventId) continue; // no round_opened yet for this round (promptless, or bridge hasn't landed)
            const actions = await store.getPlaygroundActions(session.id, session.currentRound);
            const acted = new Set(actions.map((a) => a.agentId));
            const unActed = session.participants.filter((p) => p.status === 'active' && !acted.has(p.agentId));
            for (const participant of unActed) {
                const delivery = await store.resolveWakeupDelivery(participant.agentId);
                if (!delivery) continue;
                await store.createOrReArmWakeup({
                    agentId: participant.agentId,
                    reason: 'playground_round',
                    eventId,
                    payload: { session_id: session.id, round: session.currentRound },
                    delivery,
                });
            }
        } catch (err) {
            console.error(`[playground] Error arming wakeups for session ${session.id}:`, err);
        }
    }
} catch (err) {
    console.error('[playground] Error scanning sessions for wakeup arming:', err);
}
```
Add `const ROUND1_PROMPT_REPAIR_GRACE_MS = 2 * 60 * 1000;` (2 minutes) near the file's other
constants (`ACTION_TIMEOUT_MS`, `PENDING_TIMEOUT_MS`) with a one-line comment: normal round-1
generation completes in 15-20s per the existing GM-latency comments elsewhere in this file; 2 minutes
is generous grace before assuming the async write crashed.

**Do not change `PlaygroundDeadlineRunResult`'s shape** (`lifecycle.ts`) or `checkDeadlines`'s return
value to surface counts for these three new steps — `console.log`/`console.error` only, matching every
existing step in this function. This is a deliberate KISS choice: `runDeadlinesAndCap`'s callers
(routes, cron, page-render catch-up) destructure `{ advanced, capped, advanceDurationMs, capDurationMs
}` today and none of them need to change.

**`store.emitEvent`** is the events domain's standalone, UNGATED single-event insert (already exported
from `@/lib/store`) — appropriate here specifically because the bridge event has no accompanying
mutation to gate on (the session is already prompted; nothing about it is changing). This is the ONE
place in this whole deliverable where you use `emitEvent` instead of the `emitEventCtes`-gated form.

---

## Characterization, precisely

For EACH of the three writers you are changing (`activatePlaygroundSession`,
`storeRound1PromptIfMissing`'s predecessor behavior via `activateSession`, `advanceToNextRound`), find
the existing test(s) that pin today's behavior and evolve them deliberately — never delete a pin
silently. Search these files specifically before you touch anything:
- `src/__tests__/integration/m11-2-u3d-playground.test.ts`
- `src/__tests__/api/v1/m11-2-u3d-playground-characterization.test.ts`
- `src/__tests__/lib/playground/lifecycle.test.ts`
- `src/__tests__/playground/c12-action-path.test.ts`
- `src/__tests__/playground/complete-session.test.ts`
- `src/__tests__/playground/session-routes.test.ts`

grep each for `roundDeadline`/`round_deadline`/`activatePlaygroundSession`/`currentRoundPrompt` and
read every match in context. If NONE of them currently assert that `roundDeadline` is set synchronously
at activation (before the prompt exists) — this is plausible; the async race may simply never have been
under test — WRITE ONE NEW test first that seeds a pending session, drives it to activation (join
enough participants, or however this repo's existing fixtures do it), and asserts the OLD behavior
(`roundDeadline` present immediately, `currentRoundPrompt` absent) against the CURRENT, unmodified code
— run it, confirm it passes — THEN make your changes — THEN change that SAME test to assert the NEW
behavior (`roundDeadline` absent immediately; present only after the prompt-storing write lands) and
confirm it passes. This is the mutation-check discipline for a behavior change where there is no
"suppress the fix" step (there is no old code path left to suppress once you've made the change) — the
before/after pair of assertions on the SAME test IS your evidence, and your report must show both
versions of the assertion.

For `advanceToNextRound`, find (or write) an integration test that advances a round ≥ 2 and assert:
`playground.round_opened` was emitted exactly once, with `payload.round` equal to the NEW round number
and `payload.session_id` equal to the session id, and `subjectId`/`subjectType` on the event row match.
Extend the EXISTING round-advance race tests in `m11-2-u3d-playground.test.ts` (or wherever the CAS
loser/winner tests for `applyPlaygroundResolution` already live — search for `advanceToNextRound` and
`applyPlaygroundResolution` across `src/__tests__`) rather than writing a parallel new race test from
scratch, since deliverable 6 (a different, later piece of this lane) owns the FULL cross-cutting race
suite (round-1 prompt race, advance-vs-completion, submit-vs-deadline) — you only need ONE clean
positive-path test proving the event rides the CAS, plus the completion-never-emits-round_opened pin
mentioned in Piece 2. Do not attempt the two-connection race harness yourself; that is explicitly
deliverable 6's job, and duplicating it here wastes both agents' effort.

## Gates

- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors on the files you touched (repo-wide may show pre-existing unrelated
  errors in files you did not touch — note them if present, do not fix them, do not let them block you).
- Targeted unit suites: every playground unit test file (grep-find every `src/__tests__/**/*.test.ts`
  that imports from `@/lib/playground/session-manager`, `@/lib/playground/lifecycle`,
  `@/lib/store/playground/*`, or `@/lib/actions/playground-events`) — `--runInBand`, all green.
- Targeted integration: `npm run test:integration -- <your changed/new suite files, plus
  m11-2-u3d-playground.test.ts since you are changing writers it characterizes>` — the reserved-DB
  advisory lock serializes runs across this lane's other agents; if your run waits on it, WAIT (never
  kill a holder — another deliverable's agent may be holding it). RUN-suffix every fixture value
  under a UNIQUE column. Neutralize `idx_pg_sessions_one_live_per_school` orphans in `beforeAll`
  exactly as `m11-2-u3d-playground.test.ts` already does.
- Do NOT run the full `npm run test:integration` with no args. Do NOT run `npm run build`. No codex.
  No git commands.

## Report format

Files edited (with a one-line description of each functional change — not a diff dump); every new/
changed store function's final signature; the exact new steps 1c/1d/1e's final code (paste it, since
another agent building deliverable 4's router will need to know exactly what wakeup-store calls
already fire from the sweep, to avoid describing the SAME re-arm logic as something the router itself
must also do); gate results with exact counts; your characterization evidence for all three writers
(the before-assertion, the after-assertion, and confirmation both were actually run); confirmation
that `completeSession`'s call to `applyPlaygroundResolution` is unchanged and that a test pins its
non-emission of `round_opened`; any deviation from this spec and why; anything you discovered that
belongs to deliverable 4 (the router) or deliverable 6 (cross-cutting tests) that you deliberately did
NOT build, so the orchestrator can hand it to the right agent.
