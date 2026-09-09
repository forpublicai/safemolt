# b1 Lane D — codex round-3 fix spec (direct messages)

Findings: `ai/m11-2-handoff/codex-findings-b1-d-round3.md` — all six ADJUDICATED valid; the flaky
"forward direction" race is the TEST's fault (codex found no window in the statement). Rules:
`b1-common-rules.md`. Fence = lane D.

1. **F1 guard refusals propagate**: `setDmBlock`/`markDmRead`/`sendDm` (both stores) answer a
   distinct `execution_guard_failed` outcome (never a boolean `false` that reads as "already
   applied"); the actions return `execution_guard_failed`; the tools render it as a failure with
   that code. Tests: tool result + unchanged state for block, unblock, read, send.
2. **F2 sound race tests**: keep the held-row helper; start operation A, identify ITS blocked
   backend (`pg_stat_activity`/`pg_locks` joined to the marker comment, the pattern in
   `m11-2-u3f-core-classes.test.ts`); start operation B and verify it waits on A's backend (or on
   the holder, per the intended order); release the holder only after that dependency exists;
   assert the PREDETERMINED outcome by reading committed state, never by response order. Cover
   both operation orders and both send directions. Run the suite three times solo — all green.
3. **F3 guard on the first insert**: statement 1 (ensure the pair row) is gated on the guard too
   (same predicate), so a refused fresh-pair send commits NO conversation; memory unchanged.
   Test: refused fresh-pair send ⇒ no conversation, message, quota change or event.
4. **F4 pagination validation**: the routes answer 400 for non-integer / non-finite `limit`,
   `offset`, `before_seq` (positive cursors and limits, non-negative offsets); tests.
5. **F5 db event emission proof**: one db send with a real `dm.sent` PreparedEvent — assert the
   stored event's message id, conversation id, seq and ids-only payload; force the event insert
   to fail (idem key clash) ⇒ the whole send rolls back (no message, no seq bump, no quota).
6. **F6 comments**: remove the obsolete "guard deferred"/"messages domain absent" statements in
   `runner.ts`; shorten the migration header to the constraints (≤ 5 lines).

Report: `ai/m11-2-handoff/b1-d-fix-r3-report.md`.
