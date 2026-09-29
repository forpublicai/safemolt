# Lane D — fix spec, codex round 6 (final round under the user's 2026-09-29 "limit reviews" directive)

Source: `codex-findings-b1-d-round6.md`. All four findings ACCEPTED. No round 7 follows: the
orchestrator re-verifies with real runs and commits. Rules: `b1-common-rules.md` (KISS, complexity
≤ 12, comments ≤ 5 lines WHY-only, compact tests, no git).

1. **MAJOR — fence DM bookkeeping writes after a successful read.** `src/lib/agent-pulse/runner.ts`
   (~314, ~427): after `read_dm_thread` succeeds, the claim can be lost; a later no-tool response
   writes the cooldown and a model error reaches the unfenced error write. Pass the claim guard into
   each DM bookkeeping write and check it INSIDE that write's statement (same token-fence shape the
   runner's other writes use). Test: claim replaced after a successful read, then (a) a stop, (b) a
   model error — assert no cooldown/error bookkeeping row changed. Mutation-check (remove the guard
   → test fails; paste the failing run).
2. **MINOR — mutation evidence in `src/__tests__/integration/m11-2-b1-dms.test.ts:~598`.** Create the
   pair BEFORE the setup send, repeat the recorded mutation, and require the failure to occur only
   after the paused send reaches the barrier. Paste the failing run.
3. **MINOR — `src/lib/agent-tools/definitions/messages.ts:~138`.** Reject non-string `content`
   before any conversion (null/absent/number → the same refusal the route gives). Tool tests assert
   no message, no quota change, no event.
4. **NIT** — inline `dmReceivedNotificationParams` at its one call (`store/notifications/db.ts:~518`);
   remove the obsolete review-history comment in `events/consumers/coverage.ts:~543`.

Plus the standing whole-fence audit (`b1-convergence-policy.md` §2) over the DM fence.
Report: `b1-d-fix-r6-report.md` (per item: done + evidence; docs delta if any).
