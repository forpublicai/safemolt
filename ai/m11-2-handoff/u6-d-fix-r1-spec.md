# u6 part D fix round 1 — the idle-path fence BLOCKER + the fence-loss MAJOR (spec)

Codex findings (u6 D r1), both ADOPTED. Binding: CLAUDE.md invariants; plan lines 296/301
(the fencing + autonomy-disable rules). KISS: thread the EXISTING primitives; build nothing new.

## Finding 1 (BLOCKER): `idle` ticks run terminal tools with no fence and no guard

`runner.ts:212` routes an idle wakeup through legacy `tickAgent`, which invokes `runAgenticTurn`
WITHOUT the `beforeTerminalTool` hook and executes tool actions WITHOUT the execution guard
(`agent-loop.ts` ~960/990). A claimed idle wakeup whose agent is disabled mid-tick can still
post, vote, follow, or comment — the exact hole the kill-switch machinery exists to close, open
on the highest-volume reason.

Fix (codex's shape, adopted):
- `tickAgent` accepts an optional pulse bundle `{ beforeTerminalTool, executionGuard }` (name it
  once, type it in one place). When present: the hook is passed into its `runAgenticTurn` call(s),
  and the guard is threaded into the tool-execution context exactly the way the runner's own
  reply path threads it (`agent-tools/index.ts` — the guard reaches the wired actions: comment
  reply and playground submit; unwired actions stay behind the fence alone, which is the recorded
  interim state).
- The runner's idle path passes the bundle (fence = its token-fenced `renewWakeupLease` +
  `enabled` predicate — the same pre-terminal fence its other reasons use).
- Every OTHER `tickAgent` caller passes nothing and behaves byte-identically (grep all callers
  first; list them in your report).
- Mutation-check (the codex failure case, both stores where applicable): claim an idle wakeup,
  disable autonomy before the terminal call, prove NO terminal mutation lands and the wakeup
  completes as a fenced non-`acted` outcome; suppress the threading → watch the test observe the
  forbidden mutation → restore.

## Finding 2 (MAJOR): fence loss must end the tick with NO further unfenced writes

`runner.ts:305-309`: when the pre-terminal renewal returns zero rows (superseded or disabled),
the runtime returns without a terminal call and the runner then calls `recordSkip` — mutating
`agent_loop_state` (`next_eligible_at`, `last_seen_at`) under LOST ownership; a later re-enable
inherits the stale cooldown.

Fix (codex's shape, adopted):
- The hook reports fence-loss distinctly (not just `false`-skip): the runner must be able to tell
  "declined to act" from "ownership lost".
- On fence loss: attempt ONE token-fenced wakeup completion (which correctly no-ops if the row
  was re-armed/completed by its new owner) and return immediately — no `recordSkip`, no
  `recordError`, no `agent_loop_state` writers, no memory/log writers.
- Ordinary skips (the model declined) keep today's behavior.
- Test: disable autonomy before renewal on a reply wakeup; prove `agent_loop_state` is
  byte-identical after the tick (no cooldown bump) and the wakeup did not complete under the lost
  token. Mutation-check by suppressing the early return.

## Fences

EDIT: `src/lib/agent-pulse/runner.ts`, `src/lib/agent-loop.ts` (tickAgent threading only),
`src/lib/agent-runtime/index.ts` + `src/lib/agent-tools/index.ts`/`types.ts` ONLY if the hook/
guard plumbing needs a type, existing runner/loop tests + new cases. Do NOT touch: the stores,
the worker files, lifecycle, routes, kinds/manifests, boundary files.

## Rules & gates

No git, no codex, no full no-args integration (targeted fine — lock patience, RUN-suffixes).
Gates before reporting: tsc clean; lint 0 errors; runner + loop + wakeup suites green; full unit
tree green; the pulse-runner integration suite green. Report: files, caller list for tickAgent,
mutation evidence for both findings, anything deferred.
