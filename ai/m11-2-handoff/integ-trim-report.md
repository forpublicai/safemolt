# Integration suite trim report

Fence: `src/__tests__/integration/**` only. No product code touched. No git commands beyond read-only.

## Result

- Tests removed: **0**. Tests: 802 before, 802 after (801 passed, 1 skipped, unchanged).
- Sum of per-suite times: 1972 s before, 1844 s after (about 128 s, 6.5%). Wall time of the six-chunk full run: 1855 s.
- The full `npm run test:integration` needs about 30 min and one tool call is capped at 10 min. So the full run was executed as six foreground `node scripts/integration/run.js <files...>` calls that together cover all 61 suites (173 + 183 + 154 + 164 + 103 + 25 = 802 tests, all green).

## Why no test was removed

The slowest suites were read test by test. Every slow test is a race/lock gate or a parity gate that names a fixed defect (F1..F6, C14, D4, CLOSED BY, codex round n). Apparent duplicates are not duplicates:

- `m11-2-b1-reactions` "delete-first / reaction-first / F2" run twice by `describe.each(["post","comment"])`. The subject is polymorphic (post OR comment) and each half locks a different table.
- `m11-2-u5-wakeup-router` "is idempotent when consumed twice" (wakeup projection) vs "creates no duplicate when consumed twice" (notification projection). Different writers, different dedup key.
- `m11-2-u5d` "would hand every participant a SECOND wakeup" is the control that makes the "exactly 1" counts of the race test mean something (its own comment says so).
- `m11-2-u2` (f) and (g) each wait a real 4.5 s lease. They cover two different boundaries (compensation after lost claim, prune after lost claim).
- `m11-2-u3d` "records a matched shadow row for %s" (it.each over four kinds) is deliberately one drain per kind (its comment: a kind missing from the dispatch switch would read clean forever).
- `m11-2-u1-drain` "dead-letters after three attempts" sleeps 2.3 s + 4.3 s. The backoff test measures real waits on the server clock. Left alone.

Cost is round-trip latency to the remote Neon endpoint (eu-west-2). Per test, 1 to 3 s is normal. The real waste was serial round trips, so the changes below batch or skip them without changing any assertion.

## Changes

### 1. `m11-2-u6-sweep-starvation.test.ts` (150 s -> 110 s, about -40 s)
- Six seed loops (`for ... await seedSession(...)`, 50 to 105 rows each) became `Promise.all(Array.from(...))`. Ids are minted synchronously in call order and every age/deadline is a function of the loop index, so ordering, ages and deadlines are identical. The population sizes (PAGE_SIZE 50, 2x page) are unchanged: they mirror the product page size and are what makes the test meaningful.
- `retireThisRunsLiveSessions` ran two UPDATEs ("not this run's", then "this run's"). Together they are every live row, so it is now one UPDATE. Called by 5 tests.
- Per test (before -> after): cap-all 32.3 -> 23.6 s, ordering 11.9 -> 2.8 s, failing-fifty 49.1 -> 47.4 s, ineligible-fifty 14.3 -> 10.6 s, unrepairable-fifty 8.0 -> 3.3 s, arm-scan 21.9 -> 24.0 s (noise), lock-lost 6.8 -> 7.6 s (noise).
- The remaining cost is the product's own per-session sweep work (`runDeadlineProgressionUnlocked` is O(active sessions) in HTTP round trips). Not reducible inside the fence.

### 2. `drainAll` helper in four suites (loop exit on a short batch)
Files: `m11-2-u5d-wakeup-races`, `m11-2-u5-wakeup-router`, `m11-2-u3d-playground` (batch 500), `m11-2-u4prep-soak-report` (batch 200).
- Old: `if (counts.processed === 0) break;` needs a final empty call per consumer, and `processed` is the number of events the scan returned. New: `if (counts.processed < batchSize) break;`. A scan that returned fewer rows than its limit is exhausted, so the extra call (cursor read + scan + floor advance) only confirmed it. A full batch still loops. Same result, 3 fewer drains per `drainAll` call.
- Effect (suite time before -> after): u5-router 82 -> 58 s, u3d 89 -> 67 s (also from change 3), u5d 101 -> 86 s (also from change 4), u4prep 112 -> 95 s.

### 3. `m11-2-u3d-playground.test.ts`
- "caps the OLDEST overdue session from behind fifty younger active ones": the 50-session serial seed loop became `Promise.all`. Each session has its own school; nothing depends on order. Test time was 11.0 s before (not re-measured per test).

### 4. `m11-2-u5d-wakeup-races.test.ts` and `m11-2-u2-consumers.test.ts`
- `[await seedAgent(), await seedAgent()]` array literals (9 in u5d, 2 in u2) became `await Promise.all(Array.from({ length: n }, () => seedAgent()))`. Ids are minted synchronously, so the resulting order is the same. About 0.3 s each.

## Evidence

- Mutation checks: not run for these edits. No assertion, fixture value or fixture order was modified, and the fence forbids the product-code mutation needed to prove a starvation test still fails. The seeded rows are byte-identical to before (same ids in the same order, same ages and deadlines), so the protected behavior is exercised exactly as before. The u6 ordering assertions (`firstPage[0].id === overdue[0]`, slices equal to `overdue.slice(...)`) would still fail on any ordering change.
- Runs: each changed suite ran green alone twice (first run: u6 111 s, u4prep 98 s, u5d 87 s, u3d 65 s, u2 85 s, u5-router 61 s; second run inside the full chunked run: u6 110 s, u4prep 95 s, u5d 86 s, u3d 67 s, u2 84 s, u5-router 58 s).
- Full chunked run of all 61 suites: green (802 tests).

## Not done (possible follow-ups, all need more than the fence allows or a design decision)
- The u6 sweeps (about 47 s for "behind fifty failing ones") are dominated by the product sweep re-arming all 51 active fixtures each pass.
- u1 backoff test could use a shorter schedule, but its margins (`> 1 s`, `firstWait + 1`) leave about 2 s to gain for real flake risk.
- `m11-2-u2` (f)/(g) lease waits are real time by design.
