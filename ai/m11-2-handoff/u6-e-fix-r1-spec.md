# u6 part E fix round 1 — lock-loss propagation, scan starvation, shutdown claims (spec)

Codex findings (u6 E r1): 1 BLOCKER + 4 MAJOR + 1 MINOR, ALL adopted. Binding: CLAUDE.md
invariants; `ai/PLAN_M11_2.md` lines 261–264 (P3.1: "a holder that loses its lock claims no
further sessions"; due-state-driven, oldest-first, exhaustive-or-budgeted-with-continuation
scans; SIGTERM "stop claiming and drain in-flight"). KISS: predicates and signal threading —
no new machinery.

## 1 (BLOCKER, session-manager.ts ~1097): a lost lock must stop EVERY later claim

`isLockLost` is checked only before a page in the round loop, and the cap sweep receives no
signal. Fix: thread `isLockLost` into every sweep phase (round advance, pending
activation/expiry, the bridge/arm pass, the lifetime-cap sweep) and check it BEFORE EACH SESSION
CLAIM and before each phase; on loss, stop immediately (in-flight session finishes its current
statement, nothing new starts). Test: fail the renewal after session A in a multi-due fixture;
prove sessions B+ are untouched in EVERY phase (the cap sweep explicitly). Mutation-check by
removing one phase's check.

## 2 (MAJOR, ~1190): the bridge/wakeup-arm path scans newest-50 actives

The zero-forfeit bridge itself can starve older actives. Fix: an oldest-first scan for this
path — reuse/extend the due-scan store variants (an active-sessions-oldest-first list with a
bounded page loop, or fold the bridge/arm pass into the existing due-round scan where the
sessions substantially overlap — choose the simpler, record it). Prove: more active sessions
than one page; the oldest promptless/un-armed session gets its synthetic event + wakeups.

## 3 (MAJOR, ~1094): a page of failed advances starves session 51

The loop re-reads the same first 50 when all 50 fail (`fresh` empties, loop exits). Fix: per-pass
progress that cannot re-read a stuck page — simplest: track attempted ids this pass and exclude
them in the next page query (`AND id <> ALL($ids)` with the page-size bound), or a due-ts/id
cursor advancing past attempted rows. Prove: 50+ sessions whose advance fails (GM mock throws),
one more valid due session behind them — it advances in the same sweep.

## 4 (MAJOR, ~1128): the pending-activation scan reads only 50 rows

50 stale under-participated pendings block an eligible one behind them. Fix: page through the
ordered pending rows with the same attempted-exclusion/cursor shape and a documented per-pass
budget (constant + comment), or push the eligibility predicate into the query where it is
expressible. Prove: 50 ineligible olds + 1 eligible behind them ⇒ activated.

## 5 (MAJOR, worker/index.ts ~201): SIGTERM must stop claims inside active duties

Timers stop but an active duty keeps claiming (runPulseBatch slots; deadline sweeps). Fix: a
shutdown predicate (`isShuttingDown`) passed into each duty loop, checked before every NEW claim;
already-claimed work finishes. `runPulseBatch` gains an optional `shouldStop` callback (Lane D's
file — this crosses the old lane fence deliberately; keep the change to the optional parameter +
its check). Same for the deadline entry (compose with isLockLost — one "stop claiming" signal
type used for both). Prove: unit-level — a batch of 3 due wakeups with shouldStop flipping true
after the first claim processes exactly one.

## 6 (MINOR, worker/index.ts ~158): /healthz hash null until first drain

Compute the consumer-contract hash at boot, set it before the server accepts requests.

## Fences

EDIT: `src/lib/playground/session-manager.ts`, `src/lib/playground/lifecycle.ts`,
`worker/index.ts`, `src/lib/worker/*.ts`, the playground store scan functions
(`src/lib/store/playground/{db,memory,index}.ts`) for new/extended list variants,
`src/lib/agent-pulse/runner.ts` ONLY for the optional `shouldStop` parameter, tests
(worker, lifecycle-lock, starvation, runner). Export-manifest + `npm run gen:boundary` for any
new store export. Do NOT touch: routes, kinds/manifests, wakeup store internals beyond nothing,
agent-loop.ts, boundary files.

## Rules & gates

No git, no codex, no full no-args integration (targeted fine — lock patience, RUN-suffixes,
orphan neutralization incl. the DUE SET). Mutation-check items 1, 3, 5. Characterize the sweep
before restructuring its loops. Gates before reporting: tsc clean; lint 0 errors; targeted
suites green (worker, lifecycle, starvation, u5c/u5d playground, pulse-runner); full unit tree
green; the starvation + worker integration suites green. Report: files, per-item evidence,
mutation checks, any store-export additions, anything deferred.
