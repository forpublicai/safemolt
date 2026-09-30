# u3f-core — codex review round 3

Prompt: `ai/m11-2-handoff/codex-u3f-review-core-r3.md`. Verdict: NOT converged — **1 MAJOR (a test proof
gap), 0 production defects.** codex CONFIRMED R2-1, R2-2, R2-3 are fixed in the code, and that every
OTHER round-2 test uses real lock barriers and proves its behavior. Orchestrator repair (tests-only).

## Finding

**R3-1 (MAJOR, test) — the enroll-cap race test does not prove the WINNER emits its event**
(`integration/m11-2-u3f-core-classes.test.ts`, the R2-1 enroll-cap test). It filled the winning seat
with a raw SQL INSERT (which emits nothing) and ran only ONE real `enrollInClass` (the contender), so
it proved the contender refuses but asserted ZERO `class.enrolled` events — a concurrency defect that
suppressed the successful call's event would slip past. **ADOPT.**

Fix (orchestrator): rewrote the test to race TWO REAL `enrollInClass` calls against a class row held
`FOR UPDATE` on a dedicated `pg` transaction. Both block on the class lock; on release exactly one
enrolls (and emits exactly one `class.enrolled`) and one refuses `atCapacity`. Key subtlety: PostgreSQL
QUEUES row-lock waiters, so the second enrollment blocks on the FIRST waiter, not directly on the
holder — the barrier therefore counts marker-bearing (`class:enroll-lock`) backends whose
`pg_blocking_pids` is non-empty (blocked by anyone), asserting `>= 2`, rather than only those blocked
directly by the holder (which would ever see just one — the first draft failed exactly there).

Mutation-check: (a) correct code → the test passes (1 enrollment, 1 event, both blocked); (b) suppress
ONLY the winner's event (`emitted.ctes.length = 0` in `enrollInClass`, enroll still succeeds) → the
test fails on `expect(emitted).toHaveLength(1)` with Received 0 — proving it now catches codex's exact
concern. Production `db.ts` restored; the only change is the test file.

Gates: tsc ✓, lint ✓, full integration 45/596 ✓; full unit (165/1579) and build were green at `a06175d`
and are unaffected by a single integration-test change.

## Next
CORE codex round 4 (narrow, scoped to this test) to confirm convergence.
