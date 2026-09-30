# Deliverable 4 — the wakeup-router consumer + the notifications consumer's `playground_round_open`
# markable projection

You are implementing ONE deliverable of SafeMolt's M11-2 wave u5 Lane C ("the wakeup queue"), on
branch `ops/code-improve` in /Users/mohsin/Github/safemolt (already checked out — do NOT switch
branches, do NOT run any git commands). This is a fresh agent with no memory of any prior
conversation; everything you need is below.

Prior agents in this same lane already landed, and are DONE — you do not need to build or modify any
of these:

1. `scripts/migrate-m11-wakeups.sql` (applied) — `agent_wakeups`, `pulse_budget_counters`.
2. `src/lib/events/kinds.ts` gained `playground.round_opened`:
   `{ session_id: string; round: number; reconstructed?: boolean }`, subject columns
   `subjectType: "playground_session"`, `subjectId: <session id>`, `actorAgentId: null`.
3. `src/lib/store/wakeups/{index,db,memory}.ts` — a dual-mode wakeup queue store, already re-exported
   from `@/lib/store`. You will call exactly two of its exports:
   - `enqueueWakeup(input: { agentId: string; reason: string; eventId: number | null; payload:
     Record<string, unknown>; delivery: "internal" | "webhook" | "none"; dueAt?: string }):
     Promise<{ created: boolean; wakeup: unknown | null }>` — a plain conflict-tolerant insert (`ON
     CONFLICT DO NOTHING`), never a re-arm.
   - `resolveWakeupDelivery(agentId: string): Promise<"internal" | null>` — the pre-P5 delivery rule
     (`null` means "do not create a wakeup for this agent at all").
4. A different agent (working in parallel with you, on disjoint files) is changing the playground
   producers so that `playground.round_opened` actually gets emitted — `activateSession`'s round-1
   write, `advanceToNextRound`'s CAS, a repair sweep, and a rollout bridge. **You do not need any of
   that to be done to build or test what's in this file**: your consumer reacts to events that
   already exist in the union (deliverable 2, done) and to real playground state
   (`getPlaygroundSession`/`getPlaygroundActions`, which already exist and are unchanged), so you can
   write and test everything below by constructing/emitting `playground.round_opened` events directly
   in your own tests (via the events domain's `emitEvent`, or by seeding one in a memory-mode test —
   see "Test requirements"). Do not wait on or ask about that other agent's progress.

BEFORE writing any code, read in full:
- `CLAUDE.md`'s "Store and Migration Invariants" section — all of it.
- `src/lib/events/consumers/dispatch.ts` (the whole file) — `defineConsumer`, `ConsumerEffects`,
  `eventPayload`, `payloadId`, `requiredNullablePayloadId`, `requireCorrelation`, `requireColumn`.
  Every helper you need already exists here.
- `src/lib/events/consumers/notifications.ts` (the whole file) — this is your PRIMARY template. Its
  `planCommentNotification` function is the recipient-derivation logic you are about to
  independently re-derive for the router (comment_on_my_post / reply_to_my_comment) — read it
  closely, you will write something structurally identical but wiring to a wakeup instead of a
  notification. Its `describe`/`apply`/`plan` shape is also exactly what you extend to add the
  `playground.round_opened` case.
- `src/lib/events/consumers/coverage.ts` (the whole file) — the three existing manifests
  (`notificationsCoverage`, `activityTrailCoverage`, `memoryIngestCoverage`) are your template for
  the FOURTH manifest you are adding (`wakeupRouterCoverage`). Note the `playground.round_opened`
  entries a prior agent already added to all three: notifications `"on"`, activity-trail `"none"`,
  memory-ingest `"none"`.
- `src/lib/events/consumers/registry.ts` (the whole file, it's short) — where you register your new
  consumer.
- `src/lib/store/notifications/db.ts` AND `src/lib/store/notifications/memory.ts` (both whole files)
  — you are adding one new insert function to each, following the EXACT existing pattern for
  `createCommentNotificationIdempotent`/`buildCommentNotification` (memory) and
  `commentNotificationSelectSql`/`insertNotificationFromSelect` (db). Read both closely before
  writing anything.
- `src/lib/store-types.ts` lines ~420-460 (`NotificationType`, `NotificationTarget`,
  `StoredNotification`) — you are extending two small unions here.
- `src/lib/store/playground/db.ts`'s `getPlaygroundSession`/`getPlaygroundActions` and
  `src/lib/playground/types.ts`'s `PlaygroundSession`/`SessionParticipant`/`SessionAction` shapes —
  you read these, you do not write them.

## A scope decision already made for you, with reasoning — do not re-derive or second-guess this

The master plan's P3.2 prose (`ai/PLAN_M11_2.md`, search `**Wakeup router**`) describes routing for
`agent.mentioned` (with comment/post mention suppression) and `dm.sent` in addition to
`comment.created` and `playground.round_opened`. **Neither `agent.mentioned` nor `dm.sent` exists in
this codebase's `EventKind` union** (`src/lib/events/kinds.ts`) — mentions and DMs belong to a LATER
train (P6.1/b2, per `src/lib/events/consumers/coverage.ts`'s own comments, which you should verify
yourself by grepping `src/lib/events/kinds.ts` for `mentioned`/`dm.sent` before you start — you will
find nothing). Confirmed already: no producer, no kind, nothing to route. **You are building the
router ONLY for kinds that actually exist**: `comment.created` (reply/comment-on-my-post — with NO
mention-suppression logic, because there is no mention kind to suppress against) and
`playground.round_opened`. `agent.followed` routes to nothing (per the plan text, this is also true
of the real train). Every other kind in the union maps to `"none"` in your manifest. State this
explicitly in your report as a recorded scope deviation from the plan's literal prose, with the
reasoning above (it is not a mistake — it is the only thing buildable against the actual kind union).

## Fence extension you must make, and why it's safe

Your fence (files you may touch) is: NEW `src/lib/events/consumers/wakeup-router.ts`; EDIT
`src/lib/events/consumers/{coverage,registry,notifications}.ts`; EDIT `src/lib/store-types.ts`; EDIT
`src/lib/store/notifications/{db,memory,index}.ts`; new test files.

The last two groups (`store-types.ts`, `store/notifications/*`) are NOT on the lane's originally
published file list, but they are structurally required: the master plan text for P2.1 explicitly
says the notifications consumer gets "a new markable notification type `playground_round_open`,
extending the union in M11a" — this cannot be built without touching the type that defines
`NotificationType`. This has been reviewed and approved as a necessary, minimal, additive extension.
**Keep your edits to these two areas strictly additive**: add new union members, add new functions;
never rename, remove, or change the behavior of an existing member or function. State in your report,
prominently, exactly which lines you added to `store-types.ts` and which new functions you added to
`store/notifications/{db,memory,index}.ts}`, so the orchestrator can verify no collision with any
other concurrently-running lane (two OTHER lanes of this same milestone are running elsewhere in this
repo on different files, and additive-only changes to a small, low-churn shared file are the safest
shape of edit if any coincidental overlap occurs).

Do NOT touch: `src/lib/events/kinds.ts`, `src/lib/store/wakeups/**`, `src/lib/playground/*`,
`src/lib/store/playground/*`, `src/lib/actions/*`, `scripts/*`, `src/lib/agent-loop.ts`,
`agent-home/**`, `agent-opportunities.ts` (a different lane's exclusive fence).

---

## Piece A — the wakeup-router consumer

### A1. The manifest, `wakeupRouterCoverage` in `coverage.ts`

Add a fourth exported const, same shape as the other three (`satisfies CoverageManifest`), covering
EVERY kind in the current union (copy the key list and order from `memoryIngestCoverage`, the
shortest of the three, to make sure you don't miss one — there is a compile-time check
(`satisfies Record<EventKind, CoverageState>`) that will catch a missing key for you). Values:
- `"comment.created"`: `"on"`
- `"playground.round_opened"`: `"on"`
- every other kind: `"none"`

Add a short doc comment above it explaining: (a) this consumer is brand new with no legacy writer of
any kind, so it never carries `"legacy"` or `"shadow"` anywhere — every state is `"on"` or `"none"`;
(b) the `agent.mentioned`/`dm.sent`/`agent.followed` scope note from above, condensed to a sentence or
two; (c) it activates via the same fence-seeded cursor every other consumer does (`activateEventConsumer`),
so pre-activation history never becomes a wakeup.

Do NOT add anything to `DECLARED_LEGACY_WRITERS` — this consumer needs no entry there (that map is
only for `"legacy"`/`"shadow"` kinds).

### A2. `src/lib/events/consumers/wakeup-router.ts` (new file)

Structure it exactly like `notifications.ts`: a top-of-file doc comment, small per-kind routing
functions, a `ConsumerEffects` object, and `defineConsumer(...)` at the bottom.

**`routeCommentCreated(event)`** — copy `notifications.ts`'s `planCommentNotification` function's
CONTROL FLOW almost verbatim (re-fetch comment by `payload.comment_id`, skip if gone; correlate
`post_id`/`parent_id` against the re-fetched comment via `requireCorrelation` BEFORE checking post
liveness, exactly as the comment there explains why; re-fetch post, skip if gone; branch on
`parent_id === null` for `comment_on_my_post` vs a re-fetched parent comment for
`reply_to_my_comment`, with the SAME self-notification and cross-post exclusions
`planCommentNotification` already applies) — but instead of building a `PlannedNotification`, resolve
the target agent id and a wakeup `reason` string (`"comment_on_my_post"` / `"reply_to_my_comment"` —
reuse those exact strings even though this is a different namespace from `NotificationType`; matching
names keep the two consumers' intent legible side by side), then:
```ts
const delivery = await resolveWakeupDelivery(targetAgentId);
if (!delivery) return;
await enqueueWakeup({
  agentId: targetAgentId,
  reason,
  eventId: event.id,
  payload: { post_id: postId, comment_id: commentId, parent_comment_id: parentId },
  delivery,
});
```

**`routeRoundOpened(event)`** — the consume-time freshness check, exactly:
```ts
const payload = eventPayload(event);
const sessionId = payloadId(event, payload, "session_id");
const roundValue = payload.round;
if (typeof roundValue !== "number" || !Number.isInteger(roundValue)) {
  throw new PermanentEffectError(`[events] event ${event.id} (${event.kind}) payload 'round' is not an integer`);
}
requireCorrelation(event, "session_id", sessionId, requireColumn(event, "subjectId"));

const session = await getPlaygroundSession(sessionId);
if (!session || session.status !== "active" || session.currentRound !== roundValue) return; // stale: receipt only, no wakeup

const actions = await getPlaygroundActions(sessionId, roundValue);
const acted = new Set(actions.map((a) => a.agentId));
const candidates = session.participants.filter((p) => p.status === "active" && !acted.has(p.agentId));

for (const participant of candidates) {
  const delivery = await resolveWakeupDelivery(participant.agentId);
  if (!delivery) continue;
  await enqueueWakeup({
    agentId: participant.agentId,
    reason: "playground_round",
    eventId: event.id,
    payload: { session_id: sessionId, round: roundValue },
    delivery,
  });
}
```
Import `PermanentEffectError` from `@/lib/events/errors`, `getPlaygroundSession`/`getPlaygroundActions`/
`enqueueWakeup`/`resolveWakeupDelivery` from `@/lib/store`.

**`ConsumerEffects`**:
```ts
export const wakeupRouterEffects: ConsumerEffects = {
  // This consumer's coverage is only ever "on" or "none" — never "shadow" (there is no legacy
  // wakeup writer of any kind to dual-write against; the wakeup queue is brand new). `describe` is
  // therefore never invoked in practice; it exists only to satisfy the interface.
  async describe(): Promise<ShadowEffect[]> {
    return [];
  },
  async apply(event: StoredEvent): Promise<void> {
    switch (event.kind) {
      case "comment.created":
        return routeCommentCreated(event);
      case "playground.round_opened":
        return routeRoundOpened(event);
      default:
        return;
    }
  },
};

export const wakeupRouterConsumer: RegisteredConsumer = defineConsumer({
  name: "wakeup-router",
  coverage: wakeupRouterCoverage,
  effects: wakeupRouterEffects,
  // Memory mode has no worker/cron; a wakeup must be visible when the emitting store call resolves,
  // exactly like the notifications consumer (whose reasoning this borrows verbatim).
  memoryModeDelivery: "await",
});
```

### A3. `registry.ts` — add `wakeupRouterConsumer` to the `eventConsumers` array

Import it and add it to the exported array. Order matters only in memory mode (sequential dispatch);
append it after the existing three, since nothing about it needs to run before them.

---

## Piece B — the notifications consumer's `playground_round_open` markable projection

This is a SEPARATE effect from the router's wakeup — same event, same un-acted predicate, but a
DIFFERENT owner and a DIFFERENT projection (a notification row, not a wakeup row). "One owner per
projection": the router never writes a notification, the notifications consumer never writes a
wakeup.

### B1. `store-types.ts` — two additive union extensions

```ts
export type NotificationType =
  | "comment_on_my_post"
  | "reply_to_my_comment"
  | "new_follower"
  | "playground_round_open";
```
```ts
export interface NotificationTarget {
  type: "post" | "comment" | "agent" | "group" | "playground_session";
  id: string;
  title?: string;
  name?: string;
}
```
Nothing else in this file changes.

### B2. `store/notifications/memory.ts` — the new input type and builder

Add, following the EXACT shape of `CommentNotificationInput`/`buildCommentNotification`:
```ts
export interface PlaygroundRoundOpenNotificationInput {
  dedupKey: string;
  sessionId: string;
  round: number;
  agentId: string;
  createdAt: string;
}

function buildPlaygroundRoundOpenNotification(
  input: PlaygroundRoundOpenNotificationInput
): CreateNotificationInput | null {
  const session = playgroundSessions.get(input.sessionId);
  if (!session || session.status !== "active" || session.currentRound !== input.round) return null;
  const acted = Array.from(playgroundActions.values()).some(
    (a) => a.sessionId === input.sessionId && a.round === input.round && a.agentId === input.agentId
  );
  if (acted) return null;
  return {
    agentId: input.agentId,
    type: "playground_round_open",
    priority: "normal",
    // No actor: nobody acts to open a round, the GM/system does. A fixed placeholder rather than a
    // real agent — extending NotificationActor to tolerate "no actor" is out of scope here, and every
    // other notification kind always has one.
    actor: { id: "system", name: "Game Master" },
    target: { type: "playground_session", id: input.sessionId },
    href: "/playground",
    metadata: { session_id: input.sessionId, round: input.round },
    createdAt: input.createdAt,
  };
}

export async function createPlaygroundRoundOpenNotificationIdempotent(
  input: PlaygroundRoundOpenNotificationInput
): Promise<StoredNotification | null> {
  const built = buildPlaygroundRoundOpenNotification(input);
  if (!built) return null;
  return insertNotificationIdempotentSync(built, input.dedupKey);
}
```
You need `playgroundSessions`/`playgroundActions` imported into this file from `../_memory-state`
(they are not imported there today — add them to the existing import line from `_memory-state`).

### B3. `store/notifications/db.ts` — the locked-target insert

Follow `commentNotificationSelectSql`/`insertNotificationFromSelect` exactly:
```ts
function playgroundRoundOpenSelectSql(): string {
  return `
      SELECT $1::text, $3::text, 'playground_round_open'::text, 'normal'::text, $6::timestamptz, NULL::timestamptz,
        '{"id":"system","name":"Game Master"}'::jsonb,
        jsonb_build_object('type', 'playground_session', 'id', $4::text),
        '/playground'::text,
        NULL::text, NULL::timestamptz,
        jsonb_build_object('session_id', $4::text, 'round', $5::int),
        $2::text
      FROM (
        -- The locked live subject: session is still active on exactly this round. FOR SHARE is what
        -- the comment/follow notification writers already take on THEIR subjects, and contends
        -- correctly with the round-1/advance writers' plain UPDATEs the same way those contend with
        -- deletePost's FOR UPDATE elsewhere.
        SELECT id FROM playground_sessions
        WHERE id = $4::text AND status = 'active' AND current_round = $5::int
        FOR SHARE
      ) s
      WHERE NOT EXISTS (
        -- The un-acted predicate, matching the router's own consume-time check exactly.
        SELECT 1 FROM playground_actions a
        WHERE a.session_id = $4::text AND a.round = $5::int AND a.agent_id = $3::text
      )
    `;
}

function playgroundRoundOpenParams(
  input: { dedupKey: string; sessionId: string; round: number; agentId: string; createdAt: string },
  id: string
): unknown[] {
  return [id, input.dedupKey, input.agentId, input.sessionId, input.round, input.createdAt];
}

export async function createPlaygroundRoundOpenNotificationIdempotent(
  input: { dedupKey: string; sessionId: string; round: number; agentId: string; createdAt: string }
): Promise<StoredNotification | null> {
  return insertNotificationFromSelect(
    playgroundRoundOpenSelectSql(),
    playgroundRoundOpenParams(input, generateNotificationId())
  );
}
```
Import the `PlaygroundRoundOpenNotificationInput` type from `./memory` (matching how this file already
imports `CommentNotificationInput`/`FollowNotificationInput` from `./memory`) rather than redeclaring
the shape — check the top of `db.ts` for the exact import style and match it.

### B4. `store/notifications/index.ts` — re-export

Find this domain's index/facade file (it may be `store/notifications/index.ts` — check; if
`notifications` is instead re-exported directly via `pickStore` calls inline in `store.ts`'s
`export * from "./store/notifications"`, add your `pickStore` line wherever the sibling
`createCommentNotificationIdempotent`/`createFollowNotificationIdempotent` lines already live).
`createPlaygroundRoundOpenNotificationIdempotent` needs a `pickStore(db.createPlaygroundRoundOpenNotificationIdempotent,
mem.createPlaygroundRoundOpenNotificationIdempotent)` export line, same as its two siblings.

### B5. `notifications.ts` (the events consumer) — wire the new kind into `apply`

In `notificationEffects.apply`, add a branch BEFORE the fallthrough to `plan()` (mirroring how
`post.deleted` is already special-cased at the top of both `describe` and `apply`):
```ts
async apply(event: StoredEvent): Promise<void> {
  if (event.kind === "post.deleted") { /* unchanged */ }
  if (event.kind === "playground.round_opened") {
    await applyPlaygroundRoundOpenNotifications(event);
    return;
  }
  const planned = await plan(event);
  /* unchanged */
},
```
Where:
```ts
async function applyPlaygroundRoundOpenNotifications(event: StoredEvent): Promise<void> {
  const payload = eventPayload(event);
  const sessionId = payloadId(event, payload, "session_id");
  const roundValue = payload.round;
  if (typeof roundValue !== "number" || !Number.isInteger(roundValue)) {
    throw new PermanentEffectError(`[events] event ${event.id} (${event.kind}) payload 'round' is not an integer`);
  }
  requireCorrelation(event, "session_id", sessionId, requireColumn(event, "subjectId"));

  const session = await getPlaygroundSession(sessionId);
  if (!session || session.status !== "active" || session.currentRound !== roundValue) return;
  const actions = await getPlaygroundActions(sessionId, roundValue);
  const acted = new Set(actions.map((a) => a.agentId));
  const candidates = session.participants.filter((p) => p.status === "active" && !acted.has(p.agentId));

  for (const participant of candidates) {
    await createPlaygroundRoundOpenNotificationIdempotent({
      sessionId,
      round: roundValue,
      agentId: participant.agentId,
      eventId omitted — dedup key derived below,
      createdAt: event.createdAt,
      dedupKey: `playground_round_open:${participant.agentId}:${event.id}`,
    });
  }
}
```
(Fix the pseudo-line above — there is no `eventId` field on the input type; the dedup key alone
carries the event id, matching `notificationDedupKey(...)`'s existing pattern one function above it in
this same file. Use that exact same `{type}:{recipient}:{event_id}` shape:
`` `playground_round_open:${participant.agentId}:${event.id}` ``.)

You do NOT need to add a `playground.round_opened` branch to `describe`/`plan`/`twinSubject` — this
kind's notifications coverage is `"on"` (never `"shadow"`, no legacy writer to compare against), so
`describe` is never invoked for it in practice; leaving `plan()`'s default branch return `null` for
this kind (which it already does, since `plan`'s `switch` has no case for it) is correct and
sufficient — `describe` will fall through to `if (!planned) return [];` and return an empty array
harmlessly if it is ever called. Do not add unreachable dead code to `describe` for this kind.

Import `getPlaygroundSession`, `getPlaygroundActions`, `createPlaygroundRoundOpenNotificationIdempotent`
into `notifications.ts` from `@/lib/store`, alongside its existing imports.

---

## Gates

- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors on files you touched.
- Targeted unit suites: every events-consumer unit test file (grep-find files importing
  `@/lib/events/consumers/*` or `@/lib/store/notifications/*`), `--runInBand`, all green. Also run
  `npm test -- --runInBand src/__tests__/lib/store/notifications` if such a file exists (check).
- Targeted integration: `npm run test:integration -- <your new/changed suite files>` — the
  reserved-DB advisory lock serializes runs across this lane's other concurrently-running agent(s); if
  your run waits on it, WAIT (never kill a holder). RUN-suffix every fixture value under a UNIQUE
  column.
- Do NOT run the full `npm run test:integration` with no args. Do NOT run `npm run build`. No codex.
  No git commands.

## Test requirements

Unit (memory mode):
- Router, `comment.created`: top-level comment wakes the post author with `reason:
  "comment_on_my_post"`; reply wakes the parent author with `"reply_to_my_comment"`; self-comment
  wakes nobody; a comment whose payload names a post it does not actually belong to throws
  (`requireCorrelation`); a deleted comment/post produces no wakeup (receipt only).
- Router, `playground.round_opened`: seed a memory-mode active session at round N with 3 active
  participants, 1 of whom has already submitted an action for round N; emit the event (through the
  real event-emission path, e.g. `emitEvent` from `@/lib/store`, registering this consumer via
  `__setMemoryEventConsumersForTests` the way `notifications.ts`'s own tests already do — check an
  existing consumer test file for the exact harness idiom); assert exactly 2 wakeups were created
  (the 2 who had not acted), none for the one who had. A STALE event (session already advanced past
  that round, or completed) produces zero wakeups. `resolveWakeupDelivery` returning `null` for a
  candidate (you can force this by NOT registering the agent — though remember memory mode
  unconditionally resolves `"internal"` today per the wakeup store's documented scope decision, so
  this specific case may be untestable in memory mode; if so, say so in your report rather than
  contriving a fake failure).
- Notifications consumer, `playground.round_opened`: same fixture shape; assert the un-acted
  participants each get exactly one `playground_round_open` notification, the acted one gets none, a
  re-drain of the SAME event (idempotency) creates no duplicates.
- Manifest exhaustiveness: confirm the existing consumer-coverage test (if one enumerates all
  registered consumers against `EVENT_KINDS`) picks up your new manifest automatically and passes —
  do not skip running it.

Integration (db mode):
- The router and the notifications consumer's round-open effect, seeded directly against real
  `playground_sessions`/`playground_actions`/`agents` rows and a real emitted event (through
  `emitEvent`) — assert the resulting `agent_wakeups` and `notifications` rows match the memory-mode
  assertions above. Seed run-unique ids; neutralize `idx_pg_sessions_one_live_per_school` orphans in
  `beforeAll` per `m11-2-u3d-playground.test.ts`'s established idiom.
- Comment-routing wakeup, against real `posts`/`comments`/`agents` rows.

## Report format

Files created/edited (one line each); the exact final `wakeupRouterCoverage` manifest (paste it);
confirmation of the scope decision documented above (agent.mentioned/dm.sent do not exist);
confirmation that `store-types.ts` and `store/notifications/*` edits are additive-only, with the
exact new lines pasted; gate results with counts; anything you discovered that belongs to a
DIFFERENT deliverable of this lane (producers, cross-cutting race tests) that you deliberately did
NOT build.
