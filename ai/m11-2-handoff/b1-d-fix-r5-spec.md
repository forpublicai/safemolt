# b1 Lane D — codex round-5 fix spec (direct messages)

Findings: `ai/m11-2-handoff/codex-findings-b1-d-round5.md` — all six ADJUDICATED valid. Policy:
`ai/m11-2-handoff/b1-convergence-policy.md` — the WHOLE-FENCE AUDIT (item 2) is a standing
deliverable this round. Rules: `b1-common-rules.md`. Fence = lane D (+ the runner's catch path).

1. **F1 guard loss before ANY error write**: the runner records guard loss when a tool result is
   `execution_guard_failed` (in the `onToolExecuted` path) and the catch block checks that state
   BEFORE `recordError` — under guard loss the tick does only the one token-fenced completion
   attempt and returns. Runner test: refused `read_dm_thread` then a throwing model call ⇒ no error
   write, no cooldown write.
2. **F2 late-commit proof with a real pause AFTER the insert**: a test-only `AFTER INSERT` trigger on
   `dm_messages` (created in `beforeAll` under a RUN-suffixed name, dropped in `afterAll`) that takes
   a row lock on a test table row the holder connection already holds `FOR UPDATE` — so the REAL
   send pauses after its message insert and seq bump, inside its transaction. Prove a second send
   and a mark-read wait on it (by backend pid), release, verify messages/seqs/cursor. Mutation: a
   send that commits the counter before the message must FAIL this test (show the run).
3. **F3 holder pid after BEGIN**: read `pidOf(client)` only after the holder's `BEGIN` (the pooler
   may hand a different backend before the transaction starts).
4. **F4 id before name**: `resolveDmCounterpart` tries a caller-scoped conversation participant id
   FIRST, then a live name. Test: a live agent whose name equals a withdrawn participant's id.
5. **F5 received-message preview**: filter `sender_agent_id <> me` BEFORE `LIMIT 1` in both stores.
   Test: one received message followed by ten outgoing ⇒ the preview is the received one.
6. **F6 comments**: fix the obsolete focus comment in `agent-senses/types.ts:255` and cut
   `dm/pagination.ts`'s header to ≤ 5 lines.
7. **WHOLE-FENCE AUDIT** (policy item 2): every statement in `dms/db.ts` (statement-order locks,
   actor row first where an FK is taken) and every DM test (must fail under mutation); list per
   file what changed or "audit found nothing".

Report: `ai/m11-2-handoff/b1-d-fix-r5-report.md`.
