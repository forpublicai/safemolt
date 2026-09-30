# u6 stitch — close the recorded seams before the codex rounds (spec)

Five items, SEQUENTIAL (they share files). The orchestrator already did the route de-duplication
and the cooldown env-tunability. Binding context: CLAUDE.md "Store and Migration Invariants";
`ai/PLAN_M11_2.md` lines 296 (P3.2 semantics), 299–303 (P3.3), 305–307 (P3.4);
`ai/validation/m11-inventory.md` §7 row `agent_loop.action` (line ~420) + §9a.

## Item 1 (d): the execution guard covers the playground turn

`src/lib/store/execution-guard.ts` (Lane D) locks `agent_loop_state` FOR SHARE + validates
`enabled` and the wakeup's `claim_token`, gating the decisive mutation — wired ONLY into the
comment-reply action today. Wire it into the PLAYGROUND ACTION path: `actions/playground.submitAction`
gains the same optional runner-populated guard parameter, threaded into
`submitPlaygroundActionGated`'s insert statement (`src/lib/store/playground/db.ts`) as a guard CTE
the decisive INSERT selects from — the same shape the comment statement uses. Memory twin: the
synchronous guard check the comment memory path uses. The runner (`agent-pulse/runner.ts`) passes
the guard for `playground_round` ticks. REST/tool callers pass none (unchanged behavior — assert).
Mutation-check: guard off ⇒ a disabled agent's playground action commits in the test; on ⇒ nothing
writes, nothing emits.

## Item 2 (g): the round-mismatch automated test

Lane D's runner confirms the current-round `playground_actions` row exists before writing
`result='acted'` for `playground_round` (P3.2: "terminal tool invoked" must never be read as
"acted"). The code path exists, untested. Add the test: a playground_round tick whose submit was
REFUSED (duplicate/stale round) completes its wakeup as re-armable `error`, never `acted`; a
successful submit completes `acted`. Unit-mode with the real memory store, model faked (the
existing runner.test.ts pattern).

## Item 3 (e): the `agent_loop.action` event (§7 row 420, train a4)

- `agent_loop.action` joins `src/lib/events/kinds.ts` (id-centric payload: `action`, `target_type`,
  `target_id` — no content; the log row's snippet stays OUT of the payload).
- Every consumer manifest gains the kind: activity `shadow` (it is MIGRATED — the legacy inline
  writer is `recordAgentLoopActivityEvent`, agent-loop.ts ~line 205, §9a), notifications/ingest/
  wakeup-router `none`.
- `logAction` (agent-loop.ts) becomes Tier 1: the `agent_loop_action_log` INSERT and the event in
  ONE statement (the emitEventCtes house pattern; subject = the log row? No — the SUBJECT is the
  AGENT (actor = subject), with the action identifiers in the payload; check the kind's §7/§8
  precedents and record your choice). The table is DB-ONLY (no memory twin — logAction is already a
  db-gated no-op in memory; the event therefore also does not fire in memory mode, DOCUMENT that
  parity: no mutation ⇒ no event, Decision 4 satisfied vacuously).
- The TRANSITIONAL inline activity writer must follow the u3b/u4prep2 statement-atomic rule: while
  the kind is `shadow`, the inline `recordAgentLoopActivityEvent` call stamps the emitted event's id
  into `source_event_id` — and per u4prep2, a projection named by the event must be written
  atomically with it where the drain could otherwise observe a gap. Study how `followAgent` and
  `comment.created` solved this (CLAUDE.md invariant bullets) and apply the SAME pattern; if the
  activity upsert cannot ride the log statement (different table, fine — it CAN as a CTE), record
  precisely what you did and why it satisfies the drain-time comparison.
- `occurred_at`: the activity row projects the ACTION's clock — decide from the consumer's
  projection (look at the activity consumer's agent_loop handling if any exists yet; if the
  consumer has no agent_loop effect yet, ADD it — `shadow` coverage requires the consumer able to
  describe/apply the effect. Follow the exact shape of the other activity effects).
- Tests: producer gates (a failed log insert emits nothing), shadow-stamp parity, consumer
  describe/apply, drain soak comparability (the existing u4prep2 suites' pattern — extend, don't
  fork).

## Item 4 (b): wakeup retention pruning

The P2.2 retention policy: completed wakeups prune after 30 days. Add
`pruneTerminalWakeups(retentionDays)` to the wakeups store (both modes — delete rows with
`completed_at < now() - interval`, NEVER a pending or claimed row), wire it into the existing
hourly retention duty (find where events/receipts pruning lives — the drain pass — and add it
there so the degraded topology prunes too, plus the worker inherits via the shared pass).
Env-tunable days with default 30, `.env.example` entry.

## Item 5 (f): the multi-page starvation test

Integration: seed MORE due sessions than one scan batch (exceed the page size), run repeated
sweeps, prove every overdue session eventually advances/expires/caps (due-ASC, none starved).
RUN-suffix everything; one-live-per-school orphan neutralization in beforeAll; the u5d suite's
seeding helpers are the pattern. Keep it bounded (2× page size is enough to prove the property).

## Fences

You own (this stitch only): agent-loop.ts (logAction + its inline writer), events/kinds.ts +
consumers manifests + activity consumer, actions/playground.ts + store/playground/{db,memory}.ts
(guard threading only), store/wakeups/** (pruneTerminalWakeups + claim-adjacent nothing else),
agent-pulse/runner.ts (guard passing + tests), the drain-pass retention module, export-manifest.ts
(new names) + `npm run gen:boundary`, .env.example, tests. Do NOT touch: worker/index.ts,
render.yaml, vercel.json, the internal routes, lifecycle.ts, boundary tests, docs.

## Rules

No git. No codex. No full no-args test:integration; targeted runs fine (advisory lock — wait,
never kill). run_in_background:false if you spawn helpers. Mutation-check items 1, 3, 4.
Characterize logAction before changing it. KISS — house patterns only, nothing novel.

## Gates before reporting

tsc clean; lint 0 errors; targeted suites green (runner, wakeups, playground producers, events
substrate/coverage, u4prep soak if touched); full unit tree green; your targeted integration
suites green.

## Report

Files; per-item evidence (incl. mutation checks); the subject/payload choice for agent_loop.action
and its statement-atomicity story; manifest/inventory deltas for the orchestrator; anything deferred.
