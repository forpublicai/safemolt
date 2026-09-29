# b2 Lane S gap-fix report — memory-mode FOLLOW notification frame

Scope: close the recorded KNOWN GAP in `ai/m11-2-handoff/codex-b2-review-s.md` — memory-mode
`agent.followed` notifications got no SSE stream frame — then audit all eight notification writers
and the seven public activity writers for any other memory-mode frame gap. Only one gap existed;
it is closed.

## 1. Root cause

`src/lib/store/notifications/db.ts`'s `insertNotificationFromSelect` takes `withFrame = false` only
for the follow writer (`createFollowNotificationIdempotent`, line 447), because on the db side
`followAgent`'s own decisive statement already frames the follow via `buildFollowNotificationCte`
(`src/lib/store/agents/db.ts:599`) — that call passes `false` so the consumer's shadow attempt at the
same `dedup_key` never double-frames a real follow.

Memory mode has no equivalent decisive-statement splice: `src/lib/store/agents/memory.ts:557`'s
`followAgent` calls `createFollowNotificationIdempotent` directly, and that call **is** the only
writer of a follow notification in memory mode. The pre-fix `notifications/memory.ts` mirrored the
db side's literal `false` argument without the db side's reason for it — so a memory-mode follow
notification was created (visible in the inbox) but never framed (invisible on the SSE stream), and
the doc comment on `insertNotificationIdempotentSync` incorrectly described the db-side rationale as
if it applied to memory mode too.

## 2. Fix

`src/lib/store/notifications/memory.ts`:
- Line ~289-292: corrected the doc comment on `insertNotificationIdempotentSync` — memory mode has
  no separate decisive statement, so this function must frame a follow itself or never.
- Line 336: `createFollowNotificationIdempotent` now calls `insertNotificationIdempotentSync(built,
  input.dedupKey)` (default `withFrame = true`), matching every other memory-mode notification
  writer (comment, playground round open, webhook disabled, dm received, reaction, mention, and the
  bare `createNotification`) — all of which already defaulted to `true`.

No other file changed. `src/lib/store/agents/memory.ts` (`followAgent`) needed no edit — the caller
already supplies `dedupKey`/`recipientAgentId`/`actorAgentId`/`createdAt` correctly; only the
callee's frame gating was wrong. `src/lib/store/notifications/db.ts` was not touched (fenced).

## 3. Audit of the other 7 notification writers + 7 activity writers — no other gap found

**Notification writers** (`src/lib/store/notifications/{db,memory}.ts`): `createNotification`
(inline), `createCommentNotificationIdempotent`, `createFollowNotificationIdempotent` (fixed above),
`createPlaygroundRoundOpenNotificationIdempotent`, `createWebhookDisabledNotificationIdempotent`,
`createDmReceivedNotificationIdempotent`, `createReactionNotificationIdempotent`,
`createMentionNotificationIdempotent`. Verified: on the db side only the follow writer passes
`withFrame = false` (`grep insertNotificationFromSelect` in `db.ts` — 6 call sites, only line 447
passes `false`); on the memory side every writer other than follow already defaulted `withFrame`
to `true`. Symmetric now.

**Activity writers** (`src/lib/store/activity/events.ts`'s 7 `apply*ActivityFromEvent` functions):
`applyPostActivityFromEvent`, `applyCommentActivityFromEvent`, `applyFollowActivityFromEvent`,
`applyGroupJoinActivityFromEvent`, `applyPlaygroundSessionActivityFromEvent`,
`applyPlaygroundActionActivityFromEvent`, `applyAgentLoopActivityFromEvent`. Read each in full: the
first six all pass `emitFrame = true` (or `{ emitFrame: true }`) to both the db path
(`upsertActivityEventFromSelect`/`buildCommentActivityUpsert`) and the memory path
(`memoryUpsertActivityProjection(built, sourceEventId, true)`) — symmetric. The seventh,
`applyAgentLoopActivityFromEvent`, is documented db-only by construction (`agent_loop_action_log`
has no memory twin: `if (!hasDatabase()) return;`), so there is no memory path to be asymmetric with.

## 4. Test added (mutation-checked)

`src/__tests__/lib/store/agents/follow-notification-frame.test.ts` — memory mode, real
`createAgent`/`followAgent`: a real follow records exactly one `stream_frames` row
(`frame: "notification"`, `agentId: <followee>`, key prefix `notification:`), and a re-follow adds
no second frame (`followAgent`'s own membership gate refuses the re-follow before the notification
call runs, so this needs no extra gating in the fix itself — it falls out of the existing gate).

Mutation check: reverted `createFollowNotificationIdempotent`'s call back to
`insertNotificationIdempotentSync(built, input.dedupKey, false)`. Result:

```
Expected length: 1
Received length: 0
Received array:  []
```

Restored the fix — green again.

## 5. Gate results

```
npx tsc --noEmit
  -> exit 0, no output

npx jest src/__tests__ -t stream --runInBand
  -> Test Suites: 8 passed, 8 total (206 skipped, no match)
  -> Tests: 27 passed, 27 total (2118 skipped)

npx jest src/__tests__/lib/symmetry-contract.test.ts src/__tests__/lib/store/notifications.test.ts \
  src/__tests__/lib/store/social-notifications.test.ts src/__tests__/lib/store/activity/events.test.ts \
  src/__tests__/lib/store/activity/social-emission.test.ts src/__tests__/lib/store/agents --runInBand
  -> Test Suites: 13 passed, 13 total
  -> Tests: 66 passed, 66 total

npx jest src/__tests__/lib/store src/__tests__/lib/events src/__tests__/lib/worker \
  src/__tests__/lib/stream --runInBand
  -> Test Suites: 60 passed, 60 total
  -> Tests: 556 passed, 556 total
```

No integration (Neon) test was needed — this is a pure memory-mode fix and the db side was already
correct and untouched.

## 6. Docs delta

None. This closes a recorded gap in already-shipped M11b Lane S behavior; it does not change any
public contract, endpoint shape, or CLAUDE.md invariant — the existing Lane S invariants (`stream_seq`
per-recipient counter, frame rides the same statement as its write) already describe the intended
end state, which memory mode now actually reaches for the follow kind. No `public/*`, `CLAUDE.md`, or
`agents.md` edit is proposed.

## 7. Files touched

- `src/lib/store/notifications/memory.ts` (fix + comment correction, lines ~289-336)
- `src/__tests__/lib/store/agents/follow-notification-frame.test.ts` (new test)
- `ai/m11-2-handoff/b2-s-gap-report.md` (this report)

No git commands were run (orchestrator owns git).
