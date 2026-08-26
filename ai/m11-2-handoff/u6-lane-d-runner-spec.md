# u6 Lane D — P3.3 the wakeup runner (spec — DRAFT, finalize at wave-1 boundary)

> STATUS: drafted while wave 1 (u5) runs. Before launching this lane, the orchestrator fills the
> two [BOUNDARY-FILL] sections from wave 1's landed APIs (the wakeup store's exported names, the
> `AgentContext`/`buildAgentContext` signature) and re-verifies fences against wave-1 diffs.

## Mission

Implement P3.3: the wakeup runner. Claim-with-budget in ONE CTE statement, token-fenced ownership,
the `beforeTerminalTool` runtime hook, the execution guard through the action layer, reason-scoped
context, and `runAgentLoopBatch` as the degraded wrapper. **KISS: the plan prescribes the claim
statement verbatim — transcribe it, do not redesign it.**

## Authoritative sources

- `ai/PLAN_M11_2.md` lines 299–303 (P3.3 verbatim — the claim CTE is printed in full at line 301),
  plus the P3.2 semantics paragraph (line 296) for fencing/re-arm/lease rules the runner honors.
- `CLAUDE.md` Store and Migration Invariants (binding).
- Wave-1 landed code: `src/lib/store/wakeups/*` (Lane C), `src/lib/agent-senses/*` (Lane B),
  `src/lib/events/consumers/wakeup-router.ts`.
- `src/lib/agent-runtime/index.ts` + `src/lib/agent-tools/index.ts` (the runtime the hook extends),
  `src/lib/agent-loop.ts` (the batch wrapper), `src/lib/agent-loop/state.ts`.

## Deliverables

1. **`src/lib/agent-pulse/runner.ts`** — the claim statement EXACTLY as printed in the plan
   (candidates/budget/claimed/refused CTEs; always one result row; queue-empty vs budget-refusal vs
   claim distinguished; 23505 on the one-inflight index aborts the whole statement including the
   budget increment — catch, re-run, the committed claim is then visible to NOT EXISTS). Loop per
   free slot; pass ends on empty `cand`. Lease default 10 min via env (`PULSE_*` naming).
2. **Token-fenced writes everywhere**: lease renewal and EVERY completion write (`acted`, `skip`,
   `error`) carry `WHERE id = $id AND claim_token = $token AND completed_at IS NULL`; zero rows ⇒
   stop, write nothing further. Pre-terminal renewal includes the `agent_loop_state.enabled`
   EXISTS predicate (the kill switch); abort tick on zero rows.
3. **`beforeTerminalTool` hook** in the runtime: an async hook called with the pending terminal
   call before it executes; `false` return ends the turn as a skip without invoking the tool. The
   runner's fence lives there. Smallest possible seam — one optional param through
   `runAgenticTurn`.
4. **Execution guard through the action layer**: an optional parameter beside prepared events,
   populated ONLY by the runner; the store renders it as a CTE locking `agent_loop_state` FOR SHARE
   validating `enabled` + the wakeup's `claim_token`, decisive mutation gated on it. Start with the
   terminal actions the runner can actually invoke (enumerate from the loop's tool surface) —
   record the covered set in the report.
5. **`result = 'acted'` discipline**: only on a SUCCESSFUL ActionResult; for `playground_round`
   additionally confirm the current-round `playground_actions` row exists. Rejected/failed submit
   completes as re-armable `error`.
6. **Reason-scoped context** via `buildAgentContext(agentId, {focus})` per the plan's mapping;
   playground_round narrows tools to the playground submit surface.
7. **`runAgentLoopBatch` becomes the degraded wrapper**: idle-sweep + run due wakeups up to the old
   batch size. The loop-surface minimal inference resolver per plan (C7's full resolver stays out).
8. **Tests** — plan line 303's gate list: two concurrent runners claim disjoint sets, never two for
   one agent; expired lease ⇒ abandoned + slot freed, no auto-re-run; pre-terminal renewal aborts a
   superseded runner; focused-context snapshots per reason; budget atomicity (concurrent claims
   never exceed cap; aborted claim spends nothing; over-cap candidate completes budget_exhausted);
   e2e comment ⇒ reply with no cron. Plus P3.2's deferred autonomy-disable tests (pending never
   claimed + housekeeping terminalizes as `autonomy_disabled`; disable after claim aborts at the
   fence; statement-level race resolves per the guard's lock order).

## Fences

- NEW: `src/lib/agent-pulse/**`, tests.
- EDIT: `src/lib/agent-runtime/index.ts` (the hook), `src/lib/agent-tools/index.ts` if the hook
  threads through it, `src/lib/agent-loop.ts` (batch wrapper), `src/lib/store/wakeups/*` (claim +
  completion + housekeeping abandon functions join the store), `src/lib/actions/*` ONLY where the
  execution guard parameter threads (enumerate first, keep minimal), the store statements that
  render the guard CTE.
- [BOUNDARY-FILL]: exact wakeup-store function names; AgentContext focus types; whether Lane C left
  claim-shaped helpers.

## Gates / rules

Same operating rules as u5 lanes: no git, no codex, no full integration, targeted integration
allowed (advisory lock — wait, never kill), RUN-suffixed fixtures, orphan neutralization
(one-inflight index is one-per-scope!), mutation-check every race fix, ~60% context handoff to
`ai/m11-2-handoff/u6-lane-d-handoff.md`.
