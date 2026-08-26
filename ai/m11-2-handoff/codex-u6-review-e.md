# Scoped review — u6 part E: the worker, the deadline singleton lock, sweeps + retention (round 1)

You are the review agent (read-only). Do NOT run jest, tsc, or the build — the sandbox denies the
temp writes and can kill your session. All gates pass (tsc clean, lint 0 errors, unit 188
suites/1814, full integration green at the boundary, build green). Reason from the code. This unit
carries the deadline singleton lock and the retention policy: iterate to convergence.

Plan (normative): `ai/PLAN_M11_2.md` lines 261–264 (P3.1 — the singleton-lock SQL is printed
verbatim; the due-state-driven scan rules; the migration-ledger boot check; shutdown semantics) and
305–307 (P3.4), line 296 tail (idle scheduler). Binding: CLAUDE.md invariants + "Scheduled jobs
fail closed". Commits `7e69449`, `128879d`, `c58282f`; diff `84bd3d9..HEAD` restricted to this
part's files.

## Scope (this part's files)

- `worker/index.ts` — boot ledger check, the four duties on independent timers, `/healthz`
  (contract hash), SIGTERM drain; `render.yaml`; `package.json` (tsx production dep, worker
  script); `.env.example`'s WORKER_*/PULSE_*/IDLE_SWEEP_*/WAKEUP_RETENTION_DAYS entries.
- `scripts/migrate-m11-worker.sql` (`worker_locks`) + `scripts/migrate.js` entry;
  `src/lib/store/worker-locks/{db,memory,index}.ts` — the plan-verbatim upsert-acquire
  (fresh-UUID holder, NO same-holder re-acquisition arm), token-matched renewal/release.
- `src/lib/playground/lifecycle.ts` + `session-manager.ts` — `checkDeadlines` PRIVATE behind the
  locked `runDeadlinesAndCap` entry (`runDeadlineProgressionUnlocked` importable only by
  lifecycle.ts, discipline test), renewal timer + `isLockLost` threading, the five converted
  direct callers, non-blocking skip when busy, the memory-mode process-wide mutex under the DB
  lock's name.
- The due-state scans: `listActiveSessionsDueForRound`, `listPendingSessionsForActivationScan`
  (db + memory), due-ASC, replacing the newest-first-50 windows; the paging constants.
- `src/lib/worker/{idle-scheduler,wakeup-pass,schedule-honesty,event-drain-pass}.ts` — the idle
  scan (SQL-side eligibility incl. the budget advisory via `pulseGeneralDailyCap()`), the shared
  drain pass (consumers + router + housekeeping + retention incl. `pruneTerminalWakeups`), the
  honesty fields (`meta.mode` via `worker_heartbeats` liveness, `expected_wait_seconds` both
  formulas, `schedule_note`).
- `src/app/api/v1/internal/{agent-loop,events-drain}/route.ts` — the de-duplicated route shape
  (`128879d`): ONE `runAgentLoopBatch` + honesty meta; the drain route on the shared pass.
- Tests: worker-locks, migration-ledger, lock-discipline, lifecycle-lock, event-drain-pass
  retention, `m11-2-u6-worker.test.ts`, `m11-2-u6-sweep-starvation.test.ts`.

## Focus hardest on

1. **The singleton lock**: the upsert-acquire versus the plan's SQL (empty-table bootstrap,
   expired-only takeover, fresh-UUID holder per invocation — verify NO same-holder arm survived);
   renewal/release token-matched; a lost renewal stops further claiming mid-sweep (`isLockLost`
   threading — can any session be claimed AFTER the signal?); the residual single-session-over-TTL
   overlap is the plan's accepted window, no worse.
2. **Every progression door goes through the lock**: the five converted callers + the two
   pre-existing `runDeadlinesAndCap` callers; the discipline test's scan actually catches a new
   direct import; non-blocking skip semantics (busy ⇒ request proceeds on current state); the
   memory mutex is ONE process-wide key (never the label-keyed `inflightDeadlineRuns`).
3. **Due-state scans**: due-ASC, exhaustive batching (or the documented budget + continuation),
   no fixed newest-first window anywhere on the progression path; the starvation suite proves the
   property (more due rows than a page).
4. **The worker**: the ledger boot check lists THIS train's migrations only and fails by name;
   duty timers never overlap themselves; SIGTERM stops claiming and bounds the drain; `/healthz`
   reports the contract hash; the boot test leaves no live lock.
5. **Retention**: `pruneTerminalWakeups` deletes ONLY completed rows past the window (never
   pending/claimed at any age); the shared pass gives the cron-only topology the full policy;
   bounded deletes.
6. **Honesty**: `meta.mode` truthful under a stale heartbeat; both `expected_wait_seconds`
   formulas match the plan; env-tunability (batch size, cooldown tiers via `128879d`).
7. Anything the stitch (`c58282f`, `128879d`) broke in these files.

## Known, recorded decisions — do NOT re-flag

- The tree had FIVE direct `checkDeadlines` callers, not the plan's six (inventory §6a records the
  drift; the tree wins).
- `runIdleSweep` is a documented no-op in memory mode (no `agent_loop_state` listing surface);
  `runAgentLoopBatch`'s `listEligibleAgents` loop is the memory twin of the scan.
- The memory idle-advisory miss (no budget pre-check in the memory twin) is accepted: claim-time
  enforcement is authoritative and memory is Jest-only.
- `worker_heartbeats` predates this wave (u1); not recreated.
- The pre-GM round-resolution claim stays backlog; `runPulseHousekeeping` was renamed
  `runPulseMaintenance` for the houses-deleted scan (substring).

## Output

Findings as BLOCKER / MAJOR / MINOR / NIT with file:line, concrete failure scenario, proposed fix.
If clean, say CONVERGED plainly.
