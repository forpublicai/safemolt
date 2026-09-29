# Lane S — fix spec, codex round 1 (the ONLY review round for S; user's 2026-09-29 "limit reviews")

Source: `codex-findings-b2-s-round1.md`. ACCEPTED: 1–8 and 10. Item 9 ACCEPTED in reduced form
(one integration test, see below). No round 2: the orchestrator re-verifies and commits.
Rules: `b1-common-rules.md` (KISS, complexity ≤ 12, comments ≤ 5 lines WHY-only, compact tests, no git).

1. MAJOR — `src/app/api/v1/internal/school-events/route.ts:~85`: the firehose frame for a school
   activity must be written in the SAME statement as the activity row, gated on its `RETURNING`
   (same shape as the seven public activity writers). No separate commit.
2. MAJOR — `src/lib/worker/stream-server.ts:~209`: advance the firehose scan cursor and the dedup
   record over EVERY examined frame before the hidden-agent filter. Test: 200+ hidden frames then a
   public one → the public one is delivered.
3. MAJOR — `stream-server.ts:~306`: the per-agent connection limit must not apply to the shared
   anonymous firehose key. Test: three anonymous firehose clients all connect.
4. MAJOR — `stream-server.ts:~243`: no history replay. Initialize the ledger cursor at connect time
   (current max frame id), so notifications and firehose are live-only; wakeups keep their
   Last-Event-ID replay as specified. Test: a frame written before connect is not sent.
5. MAJOR — `stream-server.ts:~247`: attach close/cleanup handlers BEFORE any async work; release
   each slot exactly once. Test: disconnect during the initial read → slot freed.
6. MAJOR — `src/__tests__/lib/symmetry-contract.test.ts:~226`: exercise the REAL route handler and
   the REAL tool executor with one controlled `ActionResult` (mock the action), assert both
   responses. Delete the local copies of the mappings.
7. MINOR — one active tick per connection (skip a tick while the previous one runs).
8. MINOR — wakeup `context_href` = `/api/v1/agents/me/context`; assert the exact value.
9. MINOR (reduced) — one integration test: start the stream server on an ephemeral port against
   the real DB, connect an SSE client, write a notification through the store, assert the frame
   arrives within 2 s.
10. NIT — `src/lib/store/stream/db.ts:~33`: use `StoredWakeup`/`rowToWakeup` directly; remove the
    obsolete splice comments in stream modules and tests.

Mutation-check each MAJOR fix (remove → test fails → paste the failing run → restore).
Report: `b2-s-fix-r1-report.md`.
