# b1 Lane D — codex round-1 fix report (direct messages)

Generation-2 fix agent. The prior agent's uncommitted work (through F4, verifying `dm-routes.test.ts`
coverage) was found on disk and NOT redone; this round added the missing tests/mutation-checks and
closed the two remaining gaps (F7 already satisfied, F8 code done but untested).

## Findings — status

1. **F1 (execution guard through DM tools) — DEFERRED**, per the spec's explicit instruction (ledger
   item 9). `send_dm` is recorded in the runner header's documented interim list of terminal tools that
   sit behind the lease fence alone (`src/lib/agent-pulse/runner.ts`, top-of-file comment, already
   present on disk from the prior agent). Not implemented; no guard parameter added to `actions/dms.ts`.

2. **F2 (preflight before any memory write) — FIXED, already on disk from the prior agent; this round
   added the tests.**
   - Change: `src/lib/store/dms/memory.ts` `sendDm`/`setDmBlock` now call `prepareEventBatch` over the
     whole substituted batch BEFORE touching the pair row, message list, quota, or flag.
   - Test: `src/__tests__/lib/store/dms-memory.test.ts`, describe `"F2 — preflight throws before any
     state changes (memory)"` — two tests, one per function, each seeding a duplicate `idemKey` to
     force `prepareEventBatch` to throw, then proving no message/conversation/flag change occurred.
   - Mutation-check: moved each function's `prepareEventBatch` call to just before its
     `appendPreparedBatch` call (i.e. after the mutation) — both tests failed with the forbidden state
     observed (a message with seq 1 landed / the flag flipped despite the throw). Restored; green again.

3. **F3 (read then reply in one turn) — FIXED, already on disk; this round added the runner test.**
   - Change: `src/lib/agent-pulse/runner.ts` — `DM_TOOL_NAMES` now includes `list_dms`;
     `DM_TERMINAL_TOOL_NAMES = {send_dm}` only; `NarrowWakeupConfig` gained `terminalToolNames` and
     `maxToolCalls`; `runDmWakeup` passes `terminalToolNames: DM_TERMINAL_TOOL_NAMES, maxToolCalls: 2`.
   - Test: `src/__tests__/lib/agent-pulse/runner.test.ts`, describe `"runPulseBatch — dm: a read does
     not end the turn, a reply in the same turn does"` — a fake two-call LLM (`read_dm_thread` then
     `send_dm`) driven through the REAL `runPulseBatch`, asserting both tool calls executed, the wakeup
     completed `acted`, and the reply landed in the real DM store.
   - Mutation-check: reverted `runDmWakeup` to the old shape (`terminalToolNames: DM_TOOL_NAMES,
     maxToolCalls: 1`) — the test failed (`callLLM` called once, `send_dm` never invoked). Restored;
     green again.

4. **F4 (withdrawn participant reachable) — FIXED, already on disk; this round added the withdrawal
   tests through the route/tool surfaces.**
   - Change: `resolveDmCounterpart` (`src/lib/actions/dms.ts`) resolves a name, or — once withdrawal
     makes the name unresolvable — treats the value as an id scoped to an existing conversation with
     the caller. Wired into the thread GET route, `markDmRead`, `blockAgent`, `unblockAgent`, and the
     `read_dm_thread` tool executor.
   - Test: `src/__tests__/api/dm-routes.test.ts`, describe `"F4 — a withdrawn counterpart is still
     reachable by id"` — three tests: thread GET route by id after withdrawal, read route + tool by id
     after withdrawal, and a control proving an unresolvable name with no prior history still 404s (an
     id cannot be forged into history that never existed).
   - Mutation-check: reverted the thread GET route to a plain `getAgentByName` lookup — the withdrawal
     test failed (404 instead of 200). Restored; green again.

5. **F5 (block event payload) — FIXED, already on disk; this round added the db-level test.**
   - Change: `src/lib/store/dms/db.ts` `setDmBlock`'s event override now adds
     `payloadMergeSql: sqlPayloadObject({ conversation_id: sqlColumn("changed.id", "text") })` beside
     the existing `subject_id` override.
   - Test (integration, real Postgres): `src/__tests__/integration/m11-2-b1-dms.test.ts`, describe
     `"F5 — block event payload names the real conversation, not the store-assigned marker"` — calls
     `setDmBlock` with a `dm.blocked` event carrying the `STORE_ASSIGNED_PAYLOAD_ID` placeholder, then
     reads the row back from `events` and asserts `payload.conversation_id === subject_id` and neither
     equals the marker.
   - Mutation-check: removed the `payloadMergeSql` override — the test failed, reproducing exactly the
     reported defect (`payload.conversation_id` read back as the literal string `"__STORE_ASSIGNED__"`).
     Restored; green again.

6. **F6 (memory sender re-check) — FIXED, already on disk; this round added the test.**
   - Change: `src/lib/store/dms/memory.ts` `sendDm` re-checks `agents.has(senderId)` synchronously,
     immediately before the quota claim, refusing as `rate_limited` (folded into the existing outcome
     since `SendDmResult` has no separate case) — matching what `agent_rate_limits.agent_id`'s FK would
     do in db mode.
   - Test: `src/__tests__/lib/store/dms-memory.test.ts`, describe `"F6 — memory re-checks the sender by
     id"` — withdraws the sender via `deleteAgent`, then calls `sendDm` directly and asserts
     `{outcome: "rate_limited", message: null}` with no message written.
   - Mutation-check: removed the `agents.has(senderId)` check — the test failed (message inserted for a
     withdrawn sender). Restored; green again.

7. **F7 (real concurrency in the integration races) — ALREADY SATISFIED, no change needed.**
   `src/__tests__/integration/m11-2-b1-dms.test.ts` was already committed (checkpoint `d86788d`) in the
   form the spec asks for: `runConcurrently`/`rejections` from `helpers/concurrency.ts`, two DIFFERENT
   senders racing (the cooldown is per sender, so a same-sender burst cannot exercise the row-lock
   race), a send-vs-block race resolved by `assertLinearized` against a real follow-up probe, and a
   3-send-vs-mark-read race. This predates the round-1 findings' review of an earlier state of this
   file; verified against the current spec wording line by line and left untouched.

8. **F8 (unread-first inbox) — FIXED, already on disk; this round added the test.**
   - Change: `src/lib/agent-senses/inbox.ts` scans `DM_CONVERSATION_SCAN_LIMIT = 20` conversations,
     filters to unread, THEN slices to 5 — replacing the old limit-5-then-filter order.
   - Test: `src/__tests__/lib/agent-senses/inbox-classes.test.ts`, `"F8: an older unread thread is not
     hidden by 5 newer READ ones"` — 5 more-recent read conversations plus one older unread one 6th in
     scan order; asserts `listDmConversations` is called with `{limit: 20}` and the unread thread still
     surfaces.
   - Mutation-check: reverted the scan limit to 5 — the test failed (`listDmConversations` called with
     `{limit: 5}`, no dm threads surfaced). Restored; green again.

9. **F9 (KISS: cut the comment, delete wrapper functions) — FIXED, already on disk.**
   `src/lib/store/dms/memory.ts`'s 28-line send comment is now ≤5 lines; `preflightEvents` and
   `appendPreparedEvents` are deleted, callers use `prepareEventBatch`/`appendPreparedBatch` directly.
   No test needed (non-behavioral).

## Gate results

- `npx tsc --noEmit` — clean. (During the session, transient `TS6133` errors briefly appeared in files
  outside lane D's fence — `src/__tests__/integration/m11-2-b1-reactions.test.ts`,
  `src/lib/store/comments/db.ts`, `src/lib/store/posts/db.ts`, `src/__tests__/lib/store/
  webhooks-memory.test.ts` — from concurrently-running lanes R/M/W mid-edit; re-checks minutes later
  showed the tree clean again. None of lane D's files were ever implicated.)
- `npx eslint <lane D files, incl. tests> --max-warnings=0`:
  ```
  src/lib/agent-pulse/runner.ts
    327:1  warning  Async function 'runNarrowWakeup' has a complexity of 13. Maximum allowed is 12

  src/lib/store/notifications/memory.ts
    165:1  warning  Function 'buildCommentNotification' has a complexity of 16. Maximum allowed is 12
  ✖ 2 problems (0 errors, 2 warnings)
  ```
  Both are **pre-existing, in functions this round did not touch or whose complexity this round's
  diff did not change** — verified by temporarily reverting `runNarrowWakeup`'s two touched lines
  (`maxToolCalls`/`terminalToolNames`) to their pre-fix literal values and re-running eslint: the same
  complexity-13 warning reproduced identically, proving the fix's own lines added zero complexity.
  `buildCommentNotification` is untouched by this diff entirely (only `buildMentionNotification`
  changed, per the shared-file protocol's "dm/mention writer only" scope).
- `npm test -- src/__tests__/lib/store/dms-memory.test.ts src/__tests__/api/dm-routes.test.ts
  src/__tests__/lib/events src/__tests__/lib/agent-pulse src/__tests__/lib/agent-senses
  src/__tests__/api/v1/agents-me-context.test.ts`:
  ```
  Test Suites: 20 passed, 20 total
  Tests:       266 passed, 266 total
  ```
- `npm run test:integration -- src/__tests__/integration/m11-2-b1-dms.test.ts`:
  ```
  Test Suites: 1 passed, 1 total
  Tests:       7 passed, 7 total
  ```
  (waited for the advisory lock once at start; never killed a holder.)

## Files touched this round

Tests only — no production code changed in this round beyond what the prior agent had already left on
disk (verified fixed via `git diff` before starting):
- `src/__tests__/lib/store/dms-memory.test.ts` (+F2, +F6 describe blocks)
- `src/__tests__/api/dm-routes.test.ts` (+F4 describe block)
- `src/__tests__/lib/agent-pulse/runner.test.ts` (+F3 describe block, +2 top-level imports, +1
  `resetDmState()` call in the shared `beforeEach`)
- `src/__tests__/lib/agent-senses/inbox-classes.test.ts` (+F8 test)
- `src/__tests__/integration/m11-2-b1-dms.test.ts` (+F5 describe block, +1 import line, +1 `afterAll`
  cleanup line for the `events` table)

Production files carrying the prior agent's already-correct fixes (unchanged by this round, confirmed
via mutation-check rather than re-implemented): `src/lib/store/dms/db.ts`, `src/lib/store/dms/memory.ts`,
`src/lib/actions/dms.ts`, `src/app/api/v1/dm/[agent_name]/route.ts`,
`src/lib/agent-tools/definitions/messages.ts`, `src/lib/agent-pulse/runner.ts`,
`src/lib/agent-senses/inbox.ts`, `src/lib/store/notifications/{db,memory}.ts` (mention-writer hunks
only, pre-existing from this lane's own earlier work — not touched this round).

## Out-of-fence needs / cross-lane notes

- Transient whole-repo `tsc` errors observed in lanes R (`m11-2-b1-reactions.test.ts`), W
  (`webhooks-memory.test.ts`), and an unidentified lane touching `comments/db.ts`/`posts/db.ts` — all
  self-resolved within the session (concurrent mid-edit states), none require action from lane D.

## Docs delta

None. This round added tests and mutation-check evidence only; the prior agent's production changes
(already covered by an earlier docs pass, if any) are unaffected.

## Behavior changes or plan deviations

None beyond what the prior agent already recorded on disk (F1 deferred per ledger item 9, `send_dm`
added to the runner header's interim-guard list). This round made no new behavior changes — only test
coverage and mutation-check verification of behavior already present.
