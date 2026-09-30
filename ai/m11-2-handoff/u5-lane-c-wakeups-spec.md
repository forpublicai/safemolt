# u5 Lane C — P3.2 wakeup queue + router + round_opened producers (spec)

## Mission

Implement P3.2 (the wakeup queue) WITHOUT the runner: the migration, the wakeup store (both modes),
the wakeup-router consumer, the `playground.round_opened` kind with its producers (the conditional
round-1 prompt writers, the round-advancement CAS, the completion CAS), the reconstruction bridge,
and the deadline sweep's create-or-re-arm. **DEFERRED to wave 2 (do NOT build):** the claim
statement / runner (P3.3), the worker (P3.1), cron-route adoption + idle scheduler (P3.4), budget
SPENDING (the `pulse_budget_counters` TABLE ships in your migration; nothing writes it yet).

**This is the highest-risk lane: locks, CAS, events, two stores. KISS (user directive): the plan
text is prescriptive down to SQL shapes — implement exactly what it says, nothing extra.**

## Authoritative sources (read first, in this order)

- `CLAUDE.md` (= agents.md) "Store and Migration Invariants" — ALL of it. The event machinery rules
  (PreparedEvent, `emitEventCtes`, per-event overrides, `rowSource`, statement-atomic projections,
  memory preflight, `FOR SHARE` not bare EXISTS, sibling-CTE arbiters) are binding.
- `ai/PLAN_M11_2.md` lines 266–298 (P3.2 verbatim: the DDL, the semantics paragraph, the router,
  the emission-timing pins, the CAS shapes, the bridge, the rollout). Line 297 is the gate list.
- `src/lib/events/kinds.ts`, `src/lib/events/consumers/{coverage,dispatch,registry,notifications}.ts`
  — how a kind and a consumer land. `src/lib/store/events/*` for `emitEventCtes`/`emitEventStatement`.
- `src/lib/playground/session-manager.ts`, `src/lib/playground/lifecycle.ts`,
  `src/lib/store/playground/{db,memory}.ts`, `src/lib/actions/playground.ts` +
  `src/lib/actions/playground-events.ts` (the sweep event builders live beside the agent-facing
  ones — one module decides what a playground event looks like; follow that pattern for
  `round_opened`'s builders).
- `src/lib/agent-loop/state.ts` — loop-state reads (the router's enqueue-time delivery resolution).
- `ai/M11_2_HANDOFF.md` "Operational rules" — run-unique integration data; one-per-scope index
  orphan cleanup (the `idx_pg_sessions_one_live_per_school` precedent DIRECTLY applies: your
  `idx_wakeups_dedup_idle` and `idx_wakeups_one_inflight` are the same one-per-scope class, so
  suites must neutralize orphans in beforeAll).

## Deliverables (sequence them; parallelize only where files are disjoint)

1. **Migration** `scripts/migrate-m11-wakeups.sql` — the DDL verbatim from plan lines 268–295
   (`agent_wakeups` + 4 indexes + `pulse_budget_counters`), fully idempotent (`IF NOT EXISTS`
   everywhere), appended to `MIGRATION_FILES` in `scripts/migrate.js`. Apply to the dev DB via
   `npm run db:migrate` and record the output.
2. **Kind + manifests**: `playground.round_opened` enters `src/lib/events/kinds.ts` (payload:
   `session_id`, `round`, `reconstructed?: boolean` — id-centric, no content). SAME deploy rule as
   ever: every consumer's coverage manifest gains the kind — notifications `on` (new-kind protocol,
   never shadowed: no legacy writer exists), activity-trail `none`, memory-ingest `none`, and the
   NEW wakeup-router consumer gets a FULL manifest over the whole union (everything `none` except
   the kinds it routes). Record in your report that the runtime ROLLOUT is two deploys
   (consumer-coverage deploy before producer deploy, plan line 296 end) — code lands together.
3. **Wakeup store** `src/lib/store/wakeups/{index,db,memory}.ts`, re-exported through
   `src/lib/store.ts`: enqueue (`ON CONFLICT DO NOTHING` against the dedup indexes; delivery
   resolved AT ENQUEUE: loop-enabled → `internal`, else NOT created — pre-P5 rule), the normative
   re-arm UPDATE (plan's exact predicate), list/read helpers for tests and the sweep. Memory twin
   enforces the same uniqueness semantics in code and lives in `_memory-state.ts`-style module
   state with a reset helper. NO claim function (P3.3).
4. **Router consumer** `src/lib/events/consumers/wakeup-router.ts` + registry entry: maps events →
   wakeups per plan (reply/comment-on-my-post → wake target; `agent.mentioned` with the
   domain-derived comment-mention suppression — read the source comment's `post_id`/`parent_id`,
   suppress iff the mentioned agent is the reply/comment-on-my-post target; post mentions re-fetch
   the live post, deleted ⇒ receipt no wakeup; `playground.round_opened` → wake each active
   participant not yet acted this round after the consume-time freshness check — session `active`,
   `current_round` equals the event's round, no `playground_actions` row for the triple; stale ⇒
   receipt only; `agent.followed` → nothing). The notifications consumer gains the markable
   `playground_round_open` projection with the SAME un-acted predicate (one owner per projection).
5. **Producers** (each event gated on its statement's `RETURNING`, per-store parity):
   - Round-1 prompt: BOTH writers (activation's async write, the sweep's repair) become ONE
     dedicated conditional store op — the plan's exact `UPDATE … WHERE status='active' AND
     current_round=1 AND current_round_prompt IS NULL RETURNING id`, event on the RETURNING.
     `activateSession` stops pre-setting `round_deadline`; prompt publication starts the clock;
     deadline progression treats a promptless active round as un-expirable (repair or skip, never
     advance/forfeit).
   - Rounds ≥ 2: `advanceToNextRound`'s persist becomes the CAS carrying the COMPLETE transition
     state (round, prompt, deadline, transcript, participants) `WHERE … status='active' AND
     current_round=$prev`; completion CAS keeps the round predicate. Loser: zero rows, no event,
     prompt discarded. The residual double-GM-inference stays backlog — do NOT build a pre-GM claim.
   - Bridge: the sweep first emits a synthetic `round_opened` for any active PROMPTED current round
     lacking one (`idem_key playground_round_opened:{session_id}:{round}`,
     `payload.reconstructed: true`), then keys wakeups off it.
   - Sweep create-or-re-arm: for active un-acted participants of the current round, idempotent via
     the `(agent_id, reason, event_id)` index keyed by the round's event id.
6. **Tests** — the plan line 297 gate list MINUS runner/claim/budget/idle/autonomy items (wave 2).
   Must include: router per-kind tests with mention suppression under BOTH drain orders; re-arm
   predicate (acted not re-armed; error/skip/abandoned re-armed; `budget_exhausted` date rule —
   seed rows directly, nothing spends budget yet); no-wakeup-before-prompt; upgrade-bridge
   (exactly one synthetic event, no forfeit); late-recovery (fresh deadline); stale round event
   (receipt only); early-actor; round-1 prompt race (loser writes nothing — two-connection race,
   the u3f enroll-cap race test is the pattern); submit-vs-deadline advance race + raced terminal
   completion (one transition, one event); advance-vs-completion (stale completion writes nothing);
   memory-mode round-opening (sweep's event produces notification + wakeup with no cron, visible
   when the store call resolves). Unit tests where possible; integration for the races and drains.

## Fences — files you may touch

- NEW: `scripts/migrate-m11-wakeups.sql`, `src/lib/store/wakeups/**`,
  `src/lib/events/consumers/wakeup-router.ts`, test files.
- EDIT: `scripts/migrate.js`, `src/lib/store.ts` (re-export block only), `src/lib/events/kinds.ts`,
  `src/lib/events/consumers/{coverage,registry,notifications}.ts`, `src/lib/events/consumer-contract.ts`
  ONLY if the hash derivation needs the new manifest (check — it should pick it up automatically),
  `src/lib/playground/{session-manager,lifecycle}.ts`, `src/lib/store/playground/{db,memory}.ts`,
  `src/lib/actions/playground-events.ts` (+ `actions/playground.ts` only if a builder signature
  forces it), `src/lib/store/_memory-state.ts` (or the playground memory-state module — follow the
  existing pattern), existing playground tests that pin changed writers.
- DO NOT touch: `src/lib/agent-loop.ts` / `agent-home/**` / `agent-opportunities.ts` (Lane B),
  `.eslintrc.json` / `package.json` / boundary files (Lane A), `agents.md`/`CLAUDE.md`,
  `ai/validation/m11-inventory.md` (report deltas; orchestrator folds), any evaluations/classes/
  admissions module.

## Gates you run

- `npx tsc --noEmit`; `npm run lint`
- Targeted unit suites (yours + every playground/events suite — grep importers) `--runInBand`.
- Targeted integration: `npm run test:integration -- <your new suites + m11-2-u3d-playground>` —
  the reserved-DB advisory lock SERIALIZES runs across lanes; if you wait, WAIT (never kill a
  holder). RUN-suffix all fixture values under UNIQUE columns; beforeAll-neutralize orphans for
  the one-per-scope indexes (yours AND `idx_pg_sessions_one_live_per_school`).
- Do NOT run the FULL `npm run test:integration` with no args, `npm run build`, codex, or git.

## Working rules

- Characterization FIRST for every writer you change (`advanceToNextRound`, `activateSession`,
  `completeSession`, the sweep): pin current behavior, then change, then re-anchor intentionally.
- Mutation-check every race/atomicity fix: suppress the fix, watch the test fail, restore.
- Decision 4 memory rules: no `await` between mutation and event append; re-validate after every
  await; preflight the whole batch first; early exits sit where the DB's do.
- Never read `ev_0` as positional truth; distinct `namePrefix` per render in one statement
  (the u3d double-prefix bug precedent).
- Context (user directive): stop at ~60% of your own context with a complete handoff to
  `ai/m11-2-handoff/u5-lane-c-handoff.md`; subagents get self-contained specs, report back, and
  are never resumed past ~50–60% — spawn fresh with a handoff instead.
- Subagents: OPUS for every statement/store/producer item (1, 3, 5); the router (4) can be a second
  opus once the kind (2) is landed; keep test-writing WITH the item that it proves, not a separate
  lane. Sequence 1→2, then 3∥5 (disjoint files), then 4, then the cross-cutting tests.

## Report format

Files created/edited; migration apply output; gate outputs (unit + targeted integration counts);
per-item mutation-check evidence; the two-deploy rollout note for the inventory (§7/§8 rows for
`playground.round_opened` + router consumer); every behavior change to existing writers, each with
its re-anchored test; anything deferred (must include: claim/runner, worker, idle scheduler,
budget spend, cron adoption).
