# Scoped review — u5 Lane C: P3.2 wakeup queue (round 2)

You are the review agent (read-only). Do NOT run jest, tsc, or the build — the sandbox denies the
temp writes and the attempt can kill your session. All gates pass (tsc clean, lint 0 errors, unit
180 suites/1734, the wakeup/producer/race integration suites 65 tests, full integration green at
the wave boundary). Reason from the code.

## Round 1 recap and what changed since

Your round 1 found ONE MAJOR and said all other scoped P3.2 work is consistent with the plan:
the consume-time freshness check was a pre-read separated from the wakeup insert by awaits, so a
session advancing in the window let a stale round-N wakeup land beside the legitimate round-N+1
one (two claimable rows, double budget once P3.3's runner exists).

The fix landed in commit `20dd055` (`git show 20dd055`). Review THAT commit's diff first, then a
short fresh pass over anything it touches:

- `createOrReArmPlaygroundRoundWakeup` in `src/lib/store/wakeups/db.ts`: a `live` CTE re-checks
  `status = 'active' AND current_round = $round AND NOT EXISTS (action for the triple)` at insert
  time, taking the session row `FOR SHARE OF s`; BOTH arms (the insert and the re-arm) gate on
  `live`. Reason literal moved into `PLAYGROUND_ROUND_REASON`, owned by the op.
- The memory twin (`memory.ts`): `playgroundRoundIsFresh` evaluated in the SAME synchronous section
  as the write, reading `playgroundSessions`/`playgroundActions` from the shared `_memory-state`
  registry (the sanctioned cross-domain path — the comments twin reads `posts` the same way).
- Both call sites converted: the router's `routeRoundOpened` loop and the sweep's arming loop in
  `session-manager.ts`. The pre-reads survive as the cheap receipt-path skip only.
- Proof tests: 5 memory gate cases (`src/__tests__/lib/store/wakeups/memory.test.ts`) and 6 db
  cases (`src/__tests__/integration/m11-2-u5e-round-arm-gate.test.ts`) including the deterministic
  form of your interleaving (pre-read says fresh → advancement commits → gated arm refuses) and a
  FOR SHARE serialization proof (in-flight advancement blocks the arm, which then refuses).
  Mutation-checked in both stores (gate suppressed → 4 failures each side → restored).

## Check specifically

1. Is the fix complete? Any OTHER wakeup-writing path still deciding freshness from a pre-read?
   (`enqueueWakeup` remains for the comment reasons — those wakeups are keyed to immutable comment
   facts, not to a mutable round; confirm that reasoning holds.)
2. The `live` CTE's lock: `FOR SHARE OF s` with the `NOT EXISTS` in the WHERE — is the lock
   actually acquired before the arms read `live` in all plans (CTE materialization), and is the
   deliberate non-lock on `playground_actions` sound given `submitAction`'s duplicate-per-round
   rejection?
3. Lock ordering: the statement takes `playground_sessions` FOR SHARE then the insert's FK takes
   FOR KEY SHARE on `agents`. Any writer anywhere taking an agent lock before a session lock that
   could cycle with this?
4. The delivery pre-read (`resolveWakeupDelivery`) stays OUTSIDE the statement — acceptable per the
   plan's enqueue-time-advisory framing (claim-time enforcement is P3.3); flag only if something
   worse than that framing exists.
5. Memory/db parity of the gate's refusals — same inputs, same outcomes, both arms.
6. Anything the fix broke or regressed in the files it touched.

## Known, recorded decisions — do NOT re-flag

Everything from round 1's list, plus: `PLAYGROUND_ROUND_REASON` is classified in the export
manifest's default-deny bucket (a constant, not a writer); the false/false concurrent outcome of
the gated op is inherited from the base op and stays accepted; no claim/lease/completion writers,
no budget spend, no idle scheduler, no worker (wave 2).

## Output

Findings as BLOCKER / MAJOR / MINOR / NIT with file:line, concrete failure scenario, proposed fix.
If the fix is correct and nothing new surfaced, say the unit is CONVERGED plainly.
