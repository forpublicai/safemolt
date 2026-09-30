# Integration harness

Real-database tests for gates that a mock cannot satisfy: row-lock blocking, constraint races,
migration behaviour, rollback, and Neon HTTP driver semantics. Introduced by M11-1 C0
([`ai/PLAN_M11_1.md`](../ai/PLAN_M11_1.md)); gates marked `[integration]` in that plan are **not
met** by a mocked test.

```bash
npm run test:integration              # whole suite
npm run test:integration -- -t "race" # pass args straight through to Jest
npm run build:integration             # `npm run build` against the same guarded target
```

The default `npm test` run excludes these tests, so the no-database path stays green.

## Why the default suite cannot cover this

`npm test` is Jest under `jsdom` with no database, and the repository's existing "db-mode" tests
mock `sql` and `sql.transaction`. Mocked promises cannot observe lock blocking, snapshot rules,
constraint races, or rollback — which is what most `[integration]` gates assert. A race test built
on mocks goes green whether or not the fix works.

## Choosing a target

The harness reads **`INTEGRATION_DATABASE_URL` only**. `POSTGRES_URL` and `DATABASE_URL` are
scrubbed from every child process before the integration URL is mapped in, because the real
migration runner reads those variables and falls back to loading `.env.local` — "just source the
integration variable" cannot be achieved by convention.

Set it in your environment or in `.env.local`:

```
INTEGRATION_DATABASE_URL=postgres://user:pass@ep-<endpoint>.<region>.aws.neon.tech/neondb
```

Three independent conditions must hold before anything is truncated, and **absence of positive
proof is a refusal, not a pass**:

1. The connection's **full hostname** (minus any `-pooler` suffix) appears in
   [`scripts/integration/disposable-targets.json`](../scripts/integration/disposable-targets.json).
   A human edits that file; the harness never does. Matching only the first label would admit
   `ep-<allowlisted-id>.attacker.example` — that checks a prefix, not an identity.
2. All work happens inside a reserved database (`safemolt_integration`), never the database named
   in your URL.
3. That reserved database carries the **ownership marker** the harness stamps when it creates it.

Condition 3 exists because 2 is not sufficient on its own: a pre-existing database that merely
shares the reserved name would otherwise be adopted and truncated. The marker proves *provenance*
("this database is the harness's own artefact"), which is a claim a harness may legitimately make
about something it created. It is never used as a **disposability** proof — that claim lives in the
tracked allowlist, because a marker the harness wrote would show only that it had write access.

A pre-existing unmarked database is refused with instructions rather than adopted. If you are
certain it is the harness's own — for example it predates the marker — claim it deliberately:

```bash
node scripts/integration/prepare.js --adopt
```

The database name in the supplied URL is irrelevant; only the host matters.

### Adding a disposable branch

```bash
# create a throwaway branch (Neon CLI)
neonctl branches create --name integration-$(date +%s)
neonctl connection-string <branch> --database-name neondb
```

Add the **full hostname** (minus any `-pooler` suffix) to `disposableEndpoints` with a one-line
note saying who confirmed it is disposable. Drop the branch
with `neonctl branches delete <branch>` when finished.

### Editing a migration you already ran

`scripts/migrate.js` skips any filename already recorded in `_migrations` **without reading the
file**, and the harness reuses its reserved database between runs. So editing a migration after an
earlier run leaves the suite executing stale schema — silently, and with everything green. Rebuild
when you change migration SQL:

```bash
npm run test:integration -- --fresh
```

`--fresh` **drops** the reserved database, so it refuses to run unless it can first prove the
database is the harness's own: existence and the ownership marker are both read before anything is
written. An unmarked database — one that merely shares the reserved name — is refused and left
intact, and pointed at `--adopt`. A database recording a *different* owner is refused outright.

## What setup does

`scripts/integration/prepare.js` creates the reserved database if absent, asserts it is connected
to that database, then applies `scripts/schema.sql` and every registered migration through the
**real** `scripts/migrate.js`. Using the real runner is the point: C1 hardens it and several
chunks assert migration behaviour, so applying schema by any other route would test something the
deploy never runs.

## Only one run at a time

Provisioning and the suite each take a Postgres advisory lock
([`scripts/integration/lock.js`](../scripts/integration/lock.js)). A second run waits, and says what
it is waiting for:

```
[integration] waiting for the integration lock — held by safemolt-integration pid=65319 safemolt
```

This is not tidiness. Two runs share one database *and* the same fixture prefixes (`c16_`, `c21_`,
`c25_`), and the suites delete by prefix in `beforeEach`, so each deletes the other's rows mid-test.
The damage never looks like contention — it looks like application defects:

- `*_fkey` violations raised in `beforeAll`, because a parent row vanished between two setup
  statements;
- a race gate observing no contention, because its post was deleted and the call stopped at its
  liveness pre-check;
- a migration gate where an expected refusal does not happen, because the other run already
  repaired the fixture.

Each one costs an investigation before anyone suspects a second run.

Two details are load-bearing, and both were measured rather than assumed:

- **The lock connects to the direct endpoint, never the `-pooler` host.** Neon's pooler is
  PgBouncer in transaction mode, where two clients both acquire the same key — with
  `pg_backend_pid()` stable in both, so a single-connection self-check cannot tell the working case
  from the broken one. `acquireHarnessLock` proves exclusion with a second connection every time it
  acquires, so pointing the lock back at a pooled host fails loudly instead of serializing nothing.
- **The lock lives in the maintenance database.** Advisory locks are database-local, and `--fresh`
  terminates every session on the reserved database and drops it. A lock held there would be
  destroyed by the run it exists to block.

**The lock is owned by the process doing the destructive work, and nothing is inherited.**
`run.js` holds it across `prepare()`, releases it, and Jest's `globalSetup` takes its own before the
first suite; `globalTeardown` releases that one. The obvious alternative — the wrapper holds one
lock for the whole run and tells Jest it may proceed — cannot survive SIGKILL: the wrapper's session
dies with it, its lock is released, and the orphaned Jest keeps issuing destructive SQL believing
itself covered. A claim passed to a child only ever describes a process that may already be gone.

Between the wrapper's release and Jest's acquire another run may win the lock. It is then simply
waited for, before this run's first statement — which is the only place waiting costs nothing.

`INTEGRATION_LOCK_TIMEOUT_MS` overrides the 45-minute wait. A run that cannot prove it still held
the lock when it finished fails instead of reporting its results.

## The guard runs however Jest was started

`npm run test:integration` is the convenient path, not the only thing protecting you. Jest's
`globalSetup` ([`scripts/integration/jest-global-setup.js`](../scripts/integration/jest-global-setup.js))
runs before any suite, any setup file and any worker fork, and re-derives the permitted target from
the **tracked allowlist** rather than from what the environment claims. It proves three things and
refuses otherwise:

1. `POSTGRES_URL` names the allowlisted endpoint — whole hostname, and with no connection-redirecting
   query parameter (`?host=`, `?dbname=`, …), which `pg-connection-string` would otherwise let
   override the URL authority;
2. the connection really lands in the reserved database, asked of the server via
   `current_database()` rather than parsed out of a string;
3. that database carries the ownership marker.

This matters because the suites issue destructive SQL (`TRUNCATE`, `DELETE`, `DROP TABLE`) directly
rather than only through the guarded truncation helper. Running `jest --config
jest.integration.config.js` by hand is therefore safe: it is validated, or it does not start.
`src/__tests__/integration/helpers/setup.ts` remains as a per-worker re-assertion after `next/jest`
loads `.env.*` into each worker — it is not the guard.

## Writing a test

```ts
import { neonSql, pgPool, truncateAllTables } from "./helpers/db";
import { raceAgainstHeldLock, runConcurrently } from "./helpers/concurrency";
```

- `neonSql()` — the **Neon HTTP driver**, which is what production runs. Assert driver-specific
  behaviour here, never on `pg`.
- `pgPool()` / `pgClient()` — the `pg` driver the migration runner uses, and the only way to hold
  a transaction open.
- `truncateAllTables()` — re-asserts the reserved-database invariant at the point of destruction.

### Races

`raceAgainstHeldLock` holds a **real** lock on the **same object** the application statement
contends on, inside an open `pg` transaction, and reports whether the contender blocked using
`pg_blocking_pids()` sampled from a third connection. Wall-clock ordering is never the assertion
basis — it cannot distinguish "blocked" from "was slower".

Pass `contenderMarker` — a string appearing verbatim in the contending statement, such as an SQL
comment or a distinctive fragment of its text. Without it, *any* backend blocked by the holder
satisfies the assertion, including one from a concurrent run against the same shared database, and
a race can look detected when the statement under test never blocked at all.

A contender that **rejects** is a failed race, not an outcome: its error is rethrown once the holder
is released. Returning it as the result — which this helper used to do, casting the error to `T` —
made "the statement failed instantly" indistinguishable from "the statement ran and did not block",
so every `observedBlocked === false` assertion passed for free. When you need to classify expected
failures (two writers racing a unique index, say), use `runConcurrently`, which reports each side.

Two things it deliberately does not do:

- It does not use the Neon driver to hold the lock. Every `sql\`\`` call is its own connection and
  auto-commits, so a standalone `SELECT ... FOR UPDATE` has released its lock before any JavaScript
  barrier is reached.
- It does not use advisory locks to create contention. `pg_advisory_lock` blocks only callers
  requesting the same advisory key; it does not block an ordinary `UPDATE` at all, so a harness
  built on them would certify itself while detecting nothing. Advisory locks may still sequence the
  harness's own setup.

## The self-test

[`harness.self-test.test.ts`](../src/__tests__/integration/harness.self-test.test.ts) must pass
before any other `[integration]` result is evidence. It asserts a known-conflicting pair **is**
observed to block (with the blocker identified by pid) and a known-independent pair **is not** —
so the helper fails loudly in both directions rather than reporting success from a harness that
cannot detect a race.

"Did not block" only counts as evidence when the statement ran, so the independent case also asserts
the value it resolved to and the row it wrote; a separate case proves a rejecting contender throws
rather than being handed back as a result. Two further cases stand a fixture up in the reserved
database and prove `--fresh` refuses — leaving the fixture intact — when the ownership marker is
absent or names another owner.

It also pins four driver facts the plan's statement shapes depend on:

| Fact | Consequence in the plan |
| --- | --- |
| Neon HTTP auto-commits per call | a standalone `FOR UPDATE` holds nothing; locks need `pg` |
| Batch elements cannot read one another's `RETURNING` | gated writes must be one CTE, not a `sql.transaction` batch |
| A CTE arm **can** gate an `INSERT` into another table | the shape C6, C14 and C21 prescribe |
| One statement **cannot** update the same row twice | `WITH claimed AS (UPDATE t ...) UPDATE t ...` silently does nothing — gate a different row or table |

That last row is a real trap: the second `UPDATE` raises no error and affects no rows, so the
shape looks correct in review and is inert in production.
