# codex findings — wave u6, round 1

Reviewer: `codex exec --sandbox read-only` (gpt-5.6-sol), solo, quiet machine.
Prompts: `codex-u6-review-d.md`, `codex-u6-review-e.md`. Reviewed state: through `c58282f`
(both lanes + both stitch halves), all five gates green (unit 188/1814, integration 53/693).

## Part D (runner / claim / guard / agent_loop.action) — 1 BLOCKER + 1 MAJOR, both ADOPTED

**BLOCKER (runner.ts:212)**: the `idle` reason routes through legacy `tickAgent`, which runs
terminal tools with NEITHER the `beforeTerminalTool` lease fence NOR the execution guard — a
claimed idle wakeup whose agent is disabled mid-tick can still post, vote, follow, or comment.
The routing choice (idle through tickAgent) was a recorded low-risk decision; the missing FENCE
was not. Adopted fix: an optional pulse bundle threads the existing hook + guard into tickAgent;
the runner's idle path passes it; every other caller unchanged.

**MAJOR (runner.ts:305-309)**: a failed pre-terminal renewal (superseded or disabled) still let
the runner call `recordSkip`, mutating `agent_loop_state` under lost ownership (stale cooldown
inherited on re-enable). Adopted fix: fence-loss becomes a distinct hook outcome; on fence loss
the runner attempts one token-fenced completion and returns immediately — no loop-state writers.

Explicitly confirmed clean: the claim CTE, the budget gate, token-fenced wakeup writes, both
action guards, the playground `acted` check, and the atomic `logAction` statement "otherwise
match the scoped plan."

Fix spec: `u6-d-fix-r1-spec.md`; opus fix agent dispatched.

## Part E — round 1 pending (runs after the D fix lands, machine-quiet rule)

## Part E (worker / lock / sweeps) — 1 BLOCKER + 4 MAJOR + 1 MINOR, ALL ADOPTED

**BLOCKER (session-manager ~1097)**: `isLockLost` checked only per-page in the round loop, and the
cap sweep received NO signal — a lost lock kept claiming sessions B..Z. Fix: the signal threads
into every phase, checked before each claim.
**MAJOR (~1190)**: the bridge/wakeup-arm pass scanned the NEWEST 50 actives — the zero-forfeit
bridge itself could starve older sessions. **MAJOR (~1094)**: a page of 50 failed advances was
re-read forever; session 51 starved. **MAJOR (~1128)**: 50 stale pendings blocked an eligible
activation behind them. Fix for all three: oldest-first due-eligible scans with per-pass
attempted-exclusion/cursor progress and documented budgets.
**MAJOR (worker ~201)**: SIGTERM stopped timers but not claims inside an active duty. Fix: a
shutdown predicate before every new claim (runPulseBatch gains optional shouldStop — a recorded
cross-fence parameter). **MINOR (~158)**: /healthz contract_hash null until the first drain; now
computed at boot.

Fix spec: `u6-e-fix-r1-spec.md`; opus fix agent dispatched. Part D's r1 fix landed in `f5f622d`.
