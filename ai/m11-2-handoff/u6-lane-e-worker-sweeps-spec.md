# u6 Lane E — P3.1 worker + P3.4 cron sweeps + idle scheduler (spec — DRAFT, finalize at wave-1 boundary)

> STATUS: drafted while wave 1 (u5) runs. Launch AFTER (or late-overlapping) Lane D — the worker
> drives the runner; sequence internally so the deadline-lock work (independent of the runner)
> goes first. [BOUNDARY-FILL] sections completed from wave-1/Lane-D landed APIs.

## Mission

Implement P3.1 (the worker) and P3.4 (cron routes become sweeps; scheduling honesty), plus P3.2's
deferred idle scheduler. **KISS: the worker is a plain node loop + tiny http server; the deadline
lock is one upsert; the sweeps reuse consumers/housekeeping that already exist.**

## Authoritative sources

- `ai/PLAN_M11_2.md` lines 261–264 (P3.1 verbatim — the singleton-lock SQL is printed; the
  due-state-driven scan rules; the migration-ledger boot check; shutdown semantics), 305–307
  (P3.4), 296 tail (idle scheduler semantics: loop-enabled + cooldown elapsed + advisory
  budget check at enqueue).
- `CLAUDE.md` invariants; `vercel.json` crons; `src/lib/auth-cron.ts` (`requireCronAuth` exists
  since u1 — P3.4 extends ADOPTION to every remaining internal route, check which still lack it).
- `src/lib/playground/lifecycle.ts` (`checkDeadlines`, `runDeadlinesAndCap`, `inflightDeadlineRuns`)
  + the six direct-caller sites the P0 inventory names (§6 of `ai/validation/m11-inventory.md`).

## Deliverables

### P3.1 — worker
1. `worker/index.ts` at repo root (main tsconfig covers it); `tsx` as a PRODUCTION dependency;
   `npm run worker`. Boot: migration-ledger readiness check — a checked-in list of THIS train's
   required migration filenames verified against `_migrations`; missing ⇒ named log + exit
   non-zero. Never a future train's file.
2. `worker_locks` singleton (DDL per plan — goes in a migration with `worker_heartbeats` from
   P3.4), the exact upsert-acquire printed in the plan; holder = fresh UUID per invocation, NO
   same-holder re-acquisition arm; token-matched renewal + release; renewal-lost ⇒ stop claiming
   further sessions.
3. The lock lives INSIDE the deadline-progression entry point; `checkDeadlines`' direct export
   removed (private); all six direct callers route through the locked entry NON-BLOCKING (busy ⇒
   skip); memory mode: one process-wide mutex under the DB lock's name (NOT the label-keyed
   `inflightDeadlineRuns`).
4. Due-state-driven scans: store gains due-filtered list variants (active with
   `round_deadline <= now()`; pending past activation/expiry thresholds; active past lifetime cap),
   due-ASC ordered, batched until no due rows remain or a documented per-pass budget with durable
   continuation. Replaces every newest-first fixed window.
5. Loop duties: drain → consumers; claim/run wakeups (Lane D's runner); deadlines every 60s under
   the lock; housekeeping (abandoned leases, below-floor receipt sweep, admissions offer-expiry,
   retention). `node:http` `/healthz` reporting the consumer-contract hash. SIGTERM: stop claiming,
   drain up to `WORKER_SHUTDOWN_GRACE_MS` (default 240s). `render.yaml` (buildCommand npm install,
   startCommand npm run worker, healthCheck /healthz). Document the accepted `safeWaitUntil` gap.

### P3.4 — sweeps + honesty
6. `internal/agent-loop` = idle-sweep + bounded wakeup-run (keeps `*/30`); `internal/events-drain`
   extends to: consumers + router + abandoned-lease housekeeping + admissions offer-expiry +
   below-floor receipt sweep + bounded retention pruning hourly (FULL P2.2 policy — events/receipts
   90d per-event-receipted-by-all, wakeups/failures/dead-letters/ingest-progress 30d).
7. `worker_heartbeats(worker_id PK, seen_at, contract_hash)`; `meta.mode`,
   `expected_wait_seconds` (both formulas), `schedule_note`; the drain route stamps the hash per
   run. C8 env-tunability: degraded batch size + posting-energy cooldown tiers move to env config
   beside `PULSE_*`.
8. `requireCronAuth` adopted by EVERY remaining internal route (audit; federation routes keep
   their own secrets deliberately).

### Idle scheduler (P3.2 deferred)
9. Worker timer + degraded sweep in `internal/agent-loop`: enqueue `reason='idle'` for
   loop-enabled agents with elapsed posting-energy cooldown AND general bucket below cap
   (enqueue-time advisory check).

### Tests
Plan gates lines 264 + 307 + the P3.2 idle-dedup/cap-exhaustion gates: boot refusal names the
missing migration; singleton-lock suite (empty-table acquire; contested refusal; same-runtime
overlap — only one acquires; renewal keeps contender out; lost-lock stops claiming; concurrent
worker/cron/page sweeps serialize; all six legacy callers route through the locked entry and skip
when busy; no direct `checkDeadlines` export remains — discipline test; memory-mode two-label
serialization); starvation test (more due sessions than any batch ⇒ all eventually processed,
due-ASC); abandoned-lease; degraded e2e + degraded retention (nothing accumulates unboundedly);
mode reporting truthful; cron fail-closed; env-overridable batch/cooldowns; idle dedup under
concurrent schedulers; repeated idle sweeps after cap exhaustion create no rows.

## Fences

- NEW: `worker/index.ts`, `render.yaml`, migration `scripts/migrate-m11-worker.sql`
  (worker_locks + worker_heartbeats), tests.
- EDIT: `scripts/migrate.js`, `package.json` (worker script + tsx dep), `vercel.json` if a cron
  entry changes, `src/lib/playground/lifecycle.ts` + the six caller sites, the playground store's
  scan functions (due-variants), `src/app/api/v1/internal/*`, `.env.example`.
- [BOUNDARY-FILL]: Lane D runner entry points; Lane C wakeup-store housekeeping names; exact list
  of internal routes still lacking requireCronAuth.

## Gates / rules

Same operating rules as u5: no git, no codex, no full integration, targeted integration with
lock patience, RUN-suffixes + orphan neutralization, mutation checks, ~60% context handoff to
`ai/m11-2-handoff/u6-lane-e-handoff.md`. The worker boot test must run against the dev DB without
leaving a live lock behind (release in afterAll).
