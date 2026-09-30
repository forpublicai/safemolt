# Scoped review — u6 part D: the wakeup runner, claim/budget, execution guard, agent_loop.action (round 1)

You are the review agent (read-only). Do NOT run jest, tsc, or the build — the sandbox denies the
temp writes and can kill your session. All gates pass (tsc clean, lint 0 errors, unit 188
suites/1814, full integration green at the boundary, build green). Reason from the code. This unit
is LOCK/ATOMICITY-BEARING: it iterates to convergence — completeness beats brevity.

Plan (normative): `ai/PLAN_M11_2.md` lines 299–303 (P3.3 — the claim CTE is printed verbatim at
301) + line 296's semantics paragraph (fencing, re-arm, lease, autonomy-disable rules). Binding
invariants: CLAUDE.md "Store and Migration Invariants". The work landed in commits `7e69449`
(both-lanes checkpoint), `128879d` (orchestrator stitch), `c58282f` (stitch agent) — diff
`84bd3d9..HEAD` restricted to this part's files.

## Scope (this part's files)

- `src/lib/store/wakeups/{db,memory,index}.ts` — the P3.3 additions: `claimNextWakeup` (the claim
  CTE with atomic budget spend), `renewWakeupLease`, `completeWakeup`,
  `abandonExpiredWakeupLeases`, `terminalizeDisabledAgentWakeups`, `pruneTerminalWakeups`, and the
  memory twins. (The P3.2 enqueue/re-arm surface was converged in the u5 rounds — re-review only
  where P3.3 touched it.)
- `src/lib/store/execution-guard.ts` + its threading: `actions/comments.ts` →
  `store/comments/{db,memory}.ts`, and `actions/playground.ts` →
  `store/playground/{db,memory}.ts` (`submitPlaygroundActionGated`'s guard CTE), `actions/types.ts`.
- `src/lib/agent-pulse/runner.ts` — claim loop, reason-scoped context (focus), the
  `result='acted'` discipline (playground confirms the action row), lease renewal at the
  pre-terminal fence, completion writes.
- `src/lib/agent-runtime/index.ts` + `agent-tools/index.ts`/`types.ts` — the `beforeTerminalTool`
  hook.
- `src/lib/agent-loop.ts` — `runAgentLoopBatch` (maintenance → idle scan [db = worker/idle-scheduler,
  memory = listEligibleAgents twin] → `runPulseBatch`), `cooldownMinutesFor` env tiers, and
  **`logAction`**: ONE statement holding the `agent_loop_action_log` INSERT + the
  `agent_loop.action` event gated on it (`rowSource: "inserted"`, `payload.log_id` from
  `inserted.id`) + the transitional activity projection CTE stamping `source_event_id`.
- `src/lib/events/kinds.ts` (+ manifests in `consumers/coverage.ts`, the activity consumer's new
  `agent_loop.action` effect, `store/activity/events.ts`'s `buildAgentLoopActivityUpsertCte` /
  `applyAgentLoopActivityFromEvent`), `scripts/soak-shadow-report.sql`'s new rows.
- Tests: `src/__tests__/lib/agent-pulse/`, `src/__tests__/lib/store/wakeups/claim.test.ts`,
  `src/__tests__/integration/m11-2-u6-pulse-runner.test.ts`,
  `src/__tests__/lib/agent-loop-log-action.test.ts`.

## Focus hardest on

1. **The claim statement versus the plan's verbatim SQL**: candidate selection (`FOR UPDATE SKIP
   LOCKED`, the `NOT EXISTS` in-flight exclusion, `delivery='internal'`, the `agent_loop_state`
   enabled predicate), the budget CTE's conditional upsert + cap, `claimed` gated on `EXISTS b`,
   `refused` completing `budget_exhausted` in-statement, the one-result-row contract
   (queue-empty vs budget-refusal vs claim), and the 23505-abort-spends-nothing property.
2. **Token fencing**: EVERY runner-owned write carries `claim_token` + `completed_at IS NULL`; the
   pre-terminal renewal includes the `enabled` EXISTS; zero-rows ⇒ stop. Any unfenced write?
3. **The execution guard**: FOR SHARE on `agent_loop_state` + claim-token validation INSIDE the
   decisive statement, both wired actions (comment reply, playground action), memory twins'
   synchronous placement, the disable-vs-mutation serialization story, and that REST/tool callers
   (no guard) behave byte-identically to before.
4. **`result='acted'` discipline**: only on a successful ActionResult; playground additionally
   requires the current-round `playground_actions` row; refused/failed ⇒ re-armable `error`.
5. **`logAction`'s statement**: event machinery use (`rowSource`, `payloadMergeSql`, param
   boundaries, namePrefix uniqueness), the projection CTE's atomicity with the event (the u4prep2
   drain-time comparison must find a coherent stamp), the deleted standalone writer leaving no
   second projection definition, `occurred_at` parity, and the deliberate swallow-after-statement
   (safe ONLY because the statement is atomic — verify nothing between the statement and the
   swallow can half-apply).
6. **Runner correctness**: can a wakeup be claimed and never completed on any non-crash path? Does
   an abandoned lease free the one-inflight slot? Focus-context and tool narrowing per reason.
7. Memory/db parity on every new writer; Decision 4 (no await between check and write; re-validate
   after awaits).

## Known, recorded decisions — do NOT re-flag

- Idle wakeups run through the legacy `tickAgent` path (recorded low-risk choice); C7's full
  inference resolver stays out (supersession note).
- The execution guard covers the RUNNER-reachable terminal mutations wired so far (comment reply,
  playground action); posts/votes/follows guard-threading is future scope — the lease-renewal
  fence still covers those ticks. Flag only if a runner path performs an UNGUARDED terminal
  mutation of a kind the plan's autonomy-disable gate names.
- `logAction` swallows post-statement failures; returns quietly with no DB (memory emits nothing —
  no log twin).
- The route runs ONE idle sweep + ONE claim pass per tick (the doubled first shape was fixed in
  `128879d`); the worker composes duties on its own timers.
- Memory `resolveWakeupDelivery` is unconditionally `internal` (documented); the enqueue-time
  delivery/budget checks are advisory, claim-time is authoritative.

## Output

Findings as BLOCKER / MAJOR / MINOR / NIT with file:line, concrete failure scenario (inputs →
wrong result), proposed fix. If clean, say CONVERGED plainly.
