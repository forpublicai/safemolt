# Local Postgres for the integration suite - report

## Result
`npm run test:integration` now runs against Docker (Postgres 17 + Neon HTTP proxy).
Full run, twice: 514.3 s and 513.4 s (wall 8:36 and 8:35), 61/61 suites, 801 passed, 1 skipped.
Baseline on the remote Neon branch: 1844 s. That is 3.6x faster.
Also green: `npx tsc --noEmit`, `npm run lint` (0 errors), `npm test -- --runInBand` (2154 passed).
The Neon path (`npm run test:integration:neon`) was NOT run in this task (about 31 min).

## Files changed
- `scripts/integration/docker-compose.yml` (new): `postgres:17` (Neon production is 17.11) on 127.0.0.1:5544,
  data on tmpfs, fsync off; `ghcr.io/timowilhelm/local-neon-http-proxy:main` on 127.0.0.1:4544.
  Ports 5433 and 4444 were avoided: 5433 is used by another container on this machine.
- `scripts/integration/disposable-targets.json`: added `localhost` with the requested note. Every guard is unchanged.
- `src/lib/db.ts`: when `NEON_LOCAL_FETCH_ENDPOINT` is set (and NODE_ENV is not production),
  `neonConfig.fetchEndpoint` is set to it. Unset means identical behavior.
- `src/__tests__/integration/helpers/db.ts`: side-effect import of `@/lib/db` so `neonSql()` gets the same config.
- `package.json`: `test:integration` (compose `up -d --wait`, then the harness with the local
  `INTEGRATION_DATABASE_URL` and `NEON_LOCAL_FETCH_ENDPOINT` set on the command, `.env.local` untouched),
  `test:integration:neon` (old behavior, `env -u NEON_LOCAL_FETCH_ENDPOINT` so a stray variable cannot redirect it),
  `test:integration:down`. `childEnv` already spreads `process.env`, so the variable reaches Jest with no change.
- `agents.md`: three Commands rows, one File Map row, one sentence on the arbiter invariant.

## How it works
The proxy is Neon's real proxy in mock-control-plane mode. It connects to the compose Postgres and takes the
database name from the client connection string, so the harness-created `safemolt_integration` works with no proxy
setting. The driver only needs `fetchEndpoint` (host in the URL can stay `localhost`; verified). `sql.transaction([...])`
batches verified through the proxy (multi-statement, RETURNING, atomic). Tests using `pg` connect directly to 5544.

## Tests / code changed (3 failures on first local run; each fixed, no assertion weakened)
1. `m11-2-b1-presence.test.ts`: the test asserted `toEqual([visibleId])` but agents left by earlier suites were still
   "active now" because the fast run stays inside the activity window. Added `beforeAll` that ages other agents out.
2. `m11-2-u3d-playground.test.ts` ("action -> cancel -> drain"): sole participant, so `submitAction` fire-and-forgets
   the round advance, whose resolution lease made `cancelSession` answer `resolution_in_progress`. Neon latency let the
   cancel win by luck. Added a second participant who has not acted (round stays open) and an explicit assertion
   that the cancel outcome is `cancelled`.
3. `m11-2-u3c-groups.test.ts` ("subscribe races unsubscribe"): NOT a test bug. A real production race that Neon latency
   hid. The group lock was inside the statement, but the `group_members` arm reads the statement snapshot taken before
   the wait, so a waiter left the snapshot and the canonical row disagreeing (reproduced 2 of 3 runs). Fix in
   `src/lib/store/groups/db.ts`: `runUnderGroupLock` takes the lock in a preceding statement of one `sql.transaction`;
   the statement text is unchanged. Test file untouched. `statement-shape.test.ts` now pins the lock statement.
   Worth reviewing (production SQL path changed).

## Notes
- Data is on tmpfs: `docker compose down`/restart wipes it; the harness recreates the database on the next run.
- Most of the remaining 514 s is inside the tests (waits, timeouts), not database latency.
