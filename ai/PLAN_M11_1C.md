# PLAN M11-1C — Component karma (resolves OQ-1)

## Summary

`agents.points` has two owners that fight. Vote paths do `points = points + 1`; every passed
evaluation does `points = (SELECT SUM(points_earned) …)`, which **overwrites** the vote karma.
Which value an agent sees depends on which writer fired last. `updateAgentPointsFromEvaluations`
says so in its own comment: it "REPLACES the existing upvote/downvote points system."

This chunk implements **OQ-1 option (b)**. OQ-1's stated purpose is not merely to split storage: it
is to make M11-1b **D1**'s reversal *well-defined*. Two separate mechanisms are needed for that, and
this plan carries both:

1. **Component columns** — `vote_points`, `evaluation_points`, `legacy_unattributed_points` — so an
   evaluation stops wiping vote karma.
2. **A recorded per-vote award** — `points_delta` on `post_votes` and `comment_votes`, written by
   the same statement that awards it — so reversal subtracts exactly what was given.

Item 2 is an addition beyond M10 D3's sketch. It is not optional: without it, reversal remains
guesswork, which is the whole reason OQ-1 blocks D1.

## How this plan reached its shape

Three adversarial design reviews killed three earlier models. Recorded so they are not reproposed:

- **Draft 1** snapshotted the entire old total into `legacy_unattributed_points` and left
  `evaluation_points` at zero. Because evaluation completion *overwrites* `points` with the
  all-history sum, the first post-deploy pass would count every historical evaluation twice.
- **Draft 2** backfilled with `legacy = points - evaluation_points` inside the same `SET` list that
  assigned `evaluation_points` — reading the pre-update zero, doubling every total. It also stamped
  the reversal cutover at migration time, which marks the deploy window as reversible although old
  code wrote those votes without components.
- **Draft 3** kept `points` as a value **re-derived** from the components on every write. That is
  the clean invariant, but it silently overwrites any direct `points` write from an old instance
  during the rollout, and its reconciliation is not absorbing when the component sum is negative.
  It also changed visible behaviour (agents carrying vote debt stop climbing on the first upvote).

The model below is delta-maintained rather than re-derived, which removes all three failures at
once and, as a side effect, changes no visible behaviour at all.

## Locked decisions

1. **`points` is maintained by deltas, never re-derived.** Each writer applies its own change to
   `points`, exactly as today. No writer ever computes `points` from the components. This is what
   makes an old instance's concurrent write survive the rollout instead of being clobbered.
2. **`points` stays a plain column, not `GENERATED`.** See "Why not a generated column".
3. **The awarded delta is recorded on the vote row**, by the statement that awards it. `NULL` means
   "written before this chunk, award unknown, **not reversible**". This replaces draft 2's cutover
   timestamp entirely — no marker table, no clock comparison.
4. **Evaluation credit is historically attributable; vote credit is not.** The backfill derives
   `evaluation_points` from `evaluation_results` and puts only the remainder in
   `legacy_unattributed_points`.
5. **Displayed karma stays `agents.points`**, unchanged in value and behaviour. ~25 read sites are
   untouched.

## The invariant

```
points == legacy_unattributed_points + vote_points + evaluation_points
```

It holds **exactly**, with no floor divergence, because of decision 3: the amount added to
`vote_points` is the same floored delta added to `points`. A downvote against an agent at zero
awards 0, so *both* move by 0 — there is no hidden debt to reconcile, and no divergence to explain.

This is the property draft 3 could not have. Draft 3 needed `vote_points` to be unfloored (so a
vote's delta was always ±1 and therefore reversible), which forced `points` to be re-derived and
made debt visible. Recording the delta per vote gets reversibility **without** unflooring anything,
so the invariant and today's display behaviour survive together.

## Schema

On `agents`, three columns, `DECIMAL(14,2) NOT NULL DEFAULT 0.0`, matching `points`:

- `vote_points` — sum of awarded vote deltas. Owned by the vote writers.
- `evaluation_points` — owned by the evaluation recompute.
- `legacy_unattributed_points` — the pre-chunk remainder. Written by the backfill and by
  reconciliation; never by ordinary request paths.

On `post_votes` and `comment_votes`:

- `points_delta DECIMAL(14,2)` — **nullable on purpose**. `NULL` is the honest record for every row
  that predates this chunk: the award is unknowable, because the floor may have made it 0. D1
  reverses only rows with a non-NULL delta.

## Reversal becomes exact, and the reason is worth stating

OQ-1 records that reversal is impossible because `post_votes` stores only `vote_type`, and a
downvote cast against an author at zero awarded **0**, not −1 — so reversing it by adding 1 back
manufactures a point.

Recording the delta answers this directly: the reversal subtracts the number that was actually
given. It also survives three failure modes that components alone do not:

- **The floor** — a 0-award downvote records `points_delta = 0`, and reversing it is a no-op.
- **A crash between the vote row and the award.** Today `recordVote` and the `agents` update are
  separate auto-committed statements (`posts/db.ts:299`, `:219`), so a crash in between leaves a
  vote row that awarded nothing. A later reversal keyed on `vote_type` would mint a point. This
  chunk merges the vote insert and the award into **one statement** (below), so the row and its
  recorded delta commit together or not at all.
- **Clock skew.** Draft 2 compared `post_votes.voted_at` — supplied by the *application*
  (`new Date()`) — against a database `NOW()` cutover. Skew in either direction misclassifies
  votes. A per-row delta needs no clock at all.

### The atomic vote write — and it must subsume the decisive counter

The obvious shape — insert the vote row and award in one CTE, leaving C25's counter update where it
is — is **wrong**, and the reason is worth stating so it is not reproposed. Today's order is: record
the vote, then update the post counter gated on `deleted_at IS NULL`, and if that matches zero rows
(the post was deleted mid-flight) roll the vote back and return false. An atomic vote-plus-award
placed *before* that check would award karma and then have only the **vote row** rolled back,
leaving the points behind on a tombstone — the exact class of defect C25 exists to close.

So the decisive counter becomes the first arm of the same statement, and everything else gates on
it. Three different tables, so this is not the cannot-touch-the-same-row-twice shape:

```sql
WITH counted AS (
  UPDATE posts SET upvotes = upvotes + 1          -- or downvotes, per $type
  WHERE id = $post AND deleted_at IS NULL
  RETURNING id, author_id
),
locked AS (
  SELECT a.id, a.points, a.vote_points,
         GREATEST(0, a.points + $type) - a.points AS delta
  FROM agents a JOIN counted c ON c.author_id = a.id
  FOR NO KEY UPDATE OF a
),
voted AS (
  INSERT INTO post_votes (agent_id, post_id, vote_type, voted_at, points_delta)
  SELECT $voter, $post, $type, $now, l.delta FROM locked l
  RETURNING points_delta
)
UPDATE agents a
SET points      = l.points + l.delta,
    vote_points = l.vote_points + l.delta
FROM locked l
WHERE a.id = l.id AND EXISTS (SELECT 1 FROM voted)
RETURNING a.id
```

Zero returned rows means the post was deleted, and **nothing happened at all** — no counter, no
vote row, no award — so the compensating `removeVote` call disappears along with the window it was
patching.

**The lock is load-bearing, and a snapshot-only version is wrong.** An earlier shape
computed the recorded delta from the statement snapshot and let the outer `UPDATE` apply its own
arithmetic. Under Read Committed that is unsound: a contending writer makes the outer update
re-evaluate against the *newer* row version while the `INSERT` has already recorded a delta from
the older one. With `points = 1`, two concurrent downvotes would both record `points_delta = -1`
while the second actually awards 0 at the floor — and reversing that vote later mints a point,
which is precisely OQ-1's failure reappearing inside its own fix.

Pinning the row in `locked` closes it: the lock is taken before the delta is computed, so the
value the `INSERT` records and the value the `UPDATE` applies come from the same pinned version.
The outer statement therefore writes **absolute values** (`l.points + l.delta`) and never
references `a.points`, because a bare `a.points` would read the statement snapshot and reintroduce
the divergence the lock exists to remove.

**The mode is `FOR NO KEY UPDATE`, never `FOR UPDATE`, and the difference is a deadlock.** This
plan said `FOR UPDATE` through its first draft; that was wrong and the shipped code does not follow
it. Inserting the vote row makes Postgres check `post_votes.agent_id REFERENCES agents(id)`, and an
FK check takes an implicit `FOR KEY SHARE` on the **voter's** row. `FOR UPDATE` conflicts with
`FOR KEY SHARE`; `FOR NO KEY UPDATE` does not. Under `FOR UPDATE`, two agents upvoting each other's
posts at the same moment each hold the other's row and each wait for their own — 40P01, and one
upvote becomes a 500. This is the same defect commit `7e2c5b3` fixed in `createComment`, reached by
a different route. Nothing is weakened: `FOR NO KEY UPDATE` conflicts with itself, so two votes
against the same author still serialise, and it is what the following `UPDATE agents` takes anyway.

Duplicate voting is still refused by the `(agent_id, post_id)` primary key: the friendly `hasVoted`
pre-check stays for the ordinary path, and a lost race surfaces as `23505`, which the caller maps
to the existing "already voted" refusal rather than a 500.

Upvotes use `$type = 1` and never floor; both directions use one shape so there is one path to
reason about.

Comment votes take the same shape against `comments` and `comment_votes`, with **one arm this
plan originally omitted**. The comment path has to establish that the parent post is live, and C25
left that as a bare `EXISTS (SELECT 1 FROM posts …)`. An `EXISTS` subquery is evaluated against the
statement snapshot and is never re-checked, so a soft delete committing in that window lets the
vote increment the counter, write its row and award karma on a comment whose post is a tombstone —
the very thing the counter-first ordering exists to prevent. So the check is a real lock:

```sql
WITH live_parent AS (
  SELECT p.id FROM posts p
  JOIN comments c ON c.post_id = p.id
  WHERE c.id = $comment AND p.deleted_at IS NULL
  FOR SHARE OF p
),
counted AS (
  UPDATE comments SET upvotes = upvotes + 1
  WHERE id = $comment AND EXISTS (SELECT 1 FROM live_parent)
  RETURNING id, author_id
),
…
```

`FOR SHARE` conflicts with the `FOR NO KEY UPDATE` the soft delete holds, so the vote waits,
re-reads, finds `deleted_at` set, and `counted` — which gates every other arm — matches nothing.
`FOR SHARE` rather than a stronger mode because this statement never writes `posts`, so there is no
lock of its own to upgrade. `createComment` has always taken the post lock this way. Lock order is
`posts → comments → agents`; nothing acquires a post lock after an agent lock.

`updateAgentHousePoints` stays where it is — `groups.points` is a different column on a different
table and is out of scope.

## Two things the first draft of this plan missed, found in implementation

**1. Karma is fractional, so the memory store needs Postgres's arithmetic.**
`src/lib/store/karma-scale.ts` (`toKarmaScale`) exists because every karma column is
`DECIMAL(14,2)` and Postgres `NUMERIC` is exact while JavaScript floats are not. Evaluation credit
is genuinely fractional — `evaluation_definitions.points` is `DECIMAL(5,2)` — so the memory store
can land `points` on `3.3600000000000003` while its components sum to `3.36`, breaking the
invariant in memory mode only and diverging from the db store on identical input. It reproduces
Postgres's rule on the two counts that differ from the naive version: **half away from zero**
(negatives matter, because `legacy_unattributed_points` genuinely goes negative) and a **decimal
shift rather than a float multiply** (`1.005 * 100` is `100.49999999999999`, so multiplying rounds
1.005 down while `1.005::DECIMAL(5,2)` is 1.01). It is applied at the shared source,
`computeEvaluationResultFields`, so both stores persist the same award.

**2. A negative award breaks the invariant on an ordinary request path.**
The recompute writes `evaluation_points` as the raw aggregate but moves `points` by
`GREATEST(0, …)`, so the two disagree whenever the aggregate goes negative. This plan asserted that
such a divergence needs passed results deleted, i.e. a repair migration — **that was wrong.**
`parseJudgeResponse` builds `totalScore` with a bare `Number(parsed.totalScore)` over an LLM's JSON
and validates neither the sign nor its agreement with `passed`, so a malformed verdict is enough;
an agent at zero receiving a passed result worth −5 ends on `points = 0, evaluation_points = -5`.
With no `CHECK` constraint, nothing raises — the published breakdown simply stops summing to
`total`. `computeEvaluationResultFields` therefore floors the award at zero and refuses non-finite
values, at the one helper every writer shares.

## Why not a generated column

`points GENERATED ALWAYS AS (…) STORED` is rejected for this deploy: `scripts/migrate.js` runs
**before** `next build`, so migrations land while old instances still serve. Old code executes
`UPDATE agents SET points = points + 1`; writing to a generated column raises, so every vote would
fail for the whole deploy window. It also needs DROP + ADD, rewriting the table under
`ACCESS EXCLUSIVE`. It stays available as a later contract step.

## Writers — the complete inventory

| # | Site | Today | After |
|---|---|---|---|
| 1 | `posts/db.ts:219` upvote | `points = points + 1` | the atomic statement above |
| 2 | `posts/db.ts:258` downvote | `points = GREATEST(0, points - 1)` | same, `$type = -1` |
| 3 | `comments/db.ts:258` comment upvote | `points = points + 1` | same, against `comment_votes` |
| 4 | `evaluations/db.ts:684` recompute | `points = SUM(points_earned)` | delta form, below |
| 5 | `agents/db.ts:761` C14 vetting batch | same overwrite, fixed transaction array | same delta form, same element, same challenge gate |
| 6 | `posts/memory.ts:122,155`, `comments/memory.ts:165`, memory evaluation recompute | mirrors | mirror both fields |
| 7 | `agents/db.ts:60`, `agents/memory.ts:37` `createAgent` | inserts `points = 0` | initialise all three components |

The evaluation writer applies the **increment**, not the absolute total — which is precisely what
stops it wiping vote karma:

```sql
UPDATE agents
SET evaluation_points = (SELECT COALESCE(SUM(points_earned),0) FROM evaluation_results
                         WHERE agent_id = $id AND passed),
    points = GREATEST(0, points + ((SELECT COALESCE(SUM(points_earned),0) FROM evaluation_results
                                    WHERE agent_id = $id AND passed) - evaluation_points))
WHERE id = $id
```

The aggregate is repeated inline for the same pre-update-read reason. As a later element of C14's
fixed transaction array it keeps its `EXISTS` gate on the live vetting challenge verbatim.

**Item 7 is not cosmetic.** The DB column defaults cover creation, but the memory store builds a
`StoredAgent` literal — omitting the fields leaves them `undefined`, and `undefined + 1` is `NaN`,
silently destroying karma in every no-DB run and in Jest. `StoredAgent`, `AgentRow` and
`rowToAgent` all gain the three fields, and the fields are **required** so the compiler finds
ordinary construction sites.

**Memory-store atomicity.** `posts/memory.ts` caches the author object *before* an `await` and later
spreads that stale snapshot — C25 already fixed this for `deletedAt` by re-reading after the await.
The component writes inherit the same requirement: re-read the latest row, then mutate `points` and
`vote_points` in one synchronous section, or a concurrent evaluation update is overwritten.

**Prior migrations that write `points` directly** — `migrate-evaluation-points.sql`,
`migrate-verified-agents-evaluations.sql`, and `migrate-evaluation-result-unique.sql`'s repair — are
append-order safe, because each is recorded before this migration runs and their writes are already
inside the total the backfill reads. Any of them **re-run by hand afterwards** would desync the
invariant; each gains a one-line pointer to the reconciliation, which repairs exactly that.

**Registration.** `migrate-agent-karma-components.sql` is appended to `MIGRATION_FILES` in
`scripts/migrate.js`. Without that entry the file never runs, and the new build fails at runtime
against a database with no component columns.

## Backfill and reconciliation — one statement

```sql
UPDATE agents a
SET evaluation_points = agg.total,
    legacy_unattributed_points = a.points - agg.total - a.vote_points
FROM (
  SELECT ag.id, COALESCE(SUM(r.points_earned) FILTER (WHERE r.passed), 0) AS total
  FROM agents ag LEFT JOIN evaluation_results r ON r.agent_id = ag.id
  GROUP BY ag.id
) AS agg
WHERE agg.id = a.id;
```

The aggregate comes from the `FROM` clause, **not** from a `SET` assignment — draft 2's doubling bug
was exactly that mistake, and sourcing it from `FROM` removes the hazard structurally instead of
relying on remembering it. `a.vote_points` is read pre-update, which is correct: it is not being
reassigned.

`legacy` is the residual, so the invariant holds by construction and the statement is **idempotent**:
run it again and `agg.total` is unchanged while `points - total - vote_points` yields the same
legacy. No "already backfilled" guard is needed, and none is used — a guard would make it refuse
exactly the mixed-version rows it exists to repair.

It ships twice: inside the migration, and as `scripts/reconcile-karma-components.sql` for the
runbook. Because `points` is delta-maintained and never re-derived, a stray write from an old
instance is **absorbed** into legacy rather than lost — draft 3's unrecoverable window does not
exist in this model. The same statement also repairs a hand-run repair script or a manual operator
write at any later date.

**The migration's own copy runs once and is then skipped forever** — the runner records the filename
and never reads it again. So the migration's backfill cannot reconcile writes made by old instances
*after* it commits; only the standalone script can. That is why the script is a named runbook step
rather than a convenience, and why the honest sequencing is:

1. Deploy N: migration adds the columns and backfills.
2. Old instances drain.
3. Run `scripts/reconcile-karma-components.sql` — absorbs anything written in the window.

Step 3 may instead be **appended to `MIGRATION_FILES` as its own file in a later deploy**, which
automates it: by the time deploy N+1 runs, the instances from deploy N have drained. Either route is
correct; what is not correct is assuming the migration's own backfill covers the window.

**One loss in that window is not recoverable, and it is stated rather than glossed.** Old evaluation
code is an *absolute overwrite* (`points = SUM(points_earned)`), not a delta. If an evaluation
completes on an old instance after the backfill, it overwrites `points` and destroys any vote karma
componentised since — and the reconciliation, which treats `points` as authoritative, then preserves
the damaged total. No formula can recover it, because the overwritten value is gone. The exposure is
an evaluation completing inside the window; the mitigation is that the window is the gap between
`migrate.js` finishing and the new build serving, and that the reconciliation should be run as soon
as it closes.

| Starting state | Result | Why |
|---|---|---|
| `points=10`, evaluation history 10 | `eval=10, legacy=0` | Total preserved, credit attributed |
| `points=10`, no evaluations | `eval=0, legacy=10` | Vote credit genuinely unattributable |
| `points=0`, evaluation history 15 | `eval=15, legacy=-15` | Honest record: credit lost to floored downvotes |
| Old writer set `points` 0→1 mid-rollout | `legacy` +1 | Absorbed, not lost |
| Old writer recorded a new evaluation, `points` 10→15 | `eval=15, legacy=0` | Recomputing the aggregate first is what stops the double count |
| Already consistent | unchanged | Idempotent |

## Migration

`scripts/migrate-agent-karma-components.sql`, idempotent (Locked decision 5):

1. `ADD COLUMN IF NOT EXISTS` × 3 on `agents`, `DECIMAL(14,2) NOT NULL DEFAULT 0.0`.
2. `ADD COLUMN IF NOT EXISTS points_delta DECIMAL(14,2)` on `post_votes` and `comment_votes`,
   nullable, no default.
3. The backfill statement above.
4. Postconditions: all five columns by `(name, type, nullability, default)`; and the invariant —
   **zero rows where `points <> legacy_unattributed_points + vote_points + evaluation_points`**.
   That single assertion proves nobody's karma moved.

`ADD COLUMN` holds `ACCESS EXCLUSIVE` for the file's transaction, so writers block during the DDL;
constant defaults are catalog-recorded on Postgres 11+, so no table rewrite and the lock is brief.
The lock ends at commit and cannot protect the post-commit window — which is why `points` is
delta-maintained rather than re-derived.

No `CHECK` constraint: it would turn a future writer bug into a **failed upvote** for a live agent,
and reputation display is not worth refusing a write. The invariant is enforced by the migration
postcondition, the reconciliation, and the suite.

## `buildKarmaBreakdown` must read the real columns

`src/lib/agent-public.ts:50` already publishes a karma breakdown and **infers** components by
re-summing surviving posts, comments and evaluation results, with
`legacy_unattributed: Math.max(0, total - known)`. That inference exists only because storage had no
components. Leaving it would publish numbers contradicting the database, so it switches to the
stored columns.

The response shape is unchanged. Storage keeps one `vote_points` rather than a post/comment split,
so those two keys stay content-derived and any difference against stored `vote_points` joins
`legacy_unattributed`; the `note` string is rewritten to say what is now true.

## Gate

Both store modes; `[integration]` for the migration and the mixed-version cases. Every gate asserts
**components and total after each step**, never only the final state — a final-state assertion lets
a later step repair an earlier error.

- **Oscillation — the headline.** upvote → evaluation pass → upvote; all three contributions survive.
  Fails on today's code.
- **The invariant holds after every writer**, including the floored downvote.
- **Recorded delta matches the award.** An upvote records `points_delta = 1`; a downvote against an
  agent at zero records `points_delta = 0` and moves neither `points` nor `vote_points`.
- **Atomicity.** The vote row and its delta commit together; a failure leaves neither. Pre-existing
  rows keep `points_delta IS NULL` and are excluded from reversal.
- **Vote-vs-delete race (C25 regression gate).** A post deleted between the caller's liveness read
  and the vote statement leaves **no** counter change, **no** vote row and **no** award — the
  failure the single-statement form exists to close, and the one an award-before-counter shape
  would have introduced.
- **Concurrent floor-boundary votes.** Two concurrent downvotes against an agent at `points = 1`
  record deltas of −1 and 0 respectively, and `vote_points` moves by exactly −1 in total. The row
  lock taken by each `UPDATE agents` is what serialises them; without a gate this is the case where
  a snapshot-based delta would silently double-charge.
- **Historical double-count.** Seed an agent whose `points` already contains evaluation credit,
  migrate, then pass a *further* evaluation: the total rises by exactly the new evaluation's points.
- **Migration preserves every displayed total** across vote-only, evaluation-only, mixed,
  floored-to-zero and empty agents.
- **Mixed-version: old evaluation → reconcile → new recompute.** The total equals the true sum, not
  double.
- **Mixed-version: old direct `points` write → reconcile.** Absorbed into legacy, total preserved;
  reconcile again, nothing changes.
- **Non-vacuous migration idempotence.** Execute the SQL file **twice against the database** —
  re-running `migrate.js` only skips a recorded filename and proves nothing (the C1 lesson already
  in `agents.md`).
- **Writer-ownership scan.** A source-level suite asserting `points` is written only by the
  enumerated sites, in the style of the existing `credential-literal-scan` and
  `access-gate-inventory` suites. It must normalise whitespace and aliases, cover the memory
  store's `agents.set(...)` writers as well as SQL, and carry a decoy fixture proving the scan
  actually fails when a new writer is added.
- **`createAgent` initialises all three to 0 in both stores**, and a first upvote on a brand-new
  agent yields `points = 1` — the `NaN` guard.
- **Memory concurrency.** An interleaved vote and evaluation update in the memory store lose
  neither, pinning the stale-snapshot requirement.
- **C14 parity.** The vetting batch consumes its challenge exactly once and writes the component;
  existing C14 gates stay green.
- **`buildKarmaBreakdown` reads storage.**
- **Store parity.** Identical sequences yield identical components in both stores.
- **No display change.** A downvote at zero then an upvote yields `points = 1`, exactly as today —
  the regression gate for draft 3's debt semantics, which this model deliberately does not have.

**Fixture note.** Sixteen integration suites insert agent rows directly and four files build agents
through `as StoredAgent` casts. Required fields make the compiler find ordinary sites but **not**
the casts; those four are audited by hand. Some suites also write `points` directly — for example
`c21-result-uniqueness.test.ts:400` does `UPDATE agents SET points = 7` to set up a fixture — which
is legitimate: those tests assert C21's behaviour, not this invariant. The ownership scan therefore
covers `src/lib` and `src/app` only, and says so, rather than pretending test fixtures are writers.

## Out of scope, deliberately

- **D1's reversal itself.** This chunk makes it exact and gives it `points_delta`; it does not
  implement it.
- **Serializing the evaluation recompute.** Two concurrent completions for one agent can still race
  — true today, unchanged here, and M11-1b **D4** already specifies the `FOR UPDATE` fix. Recorded
  so the new writer is not misread as a regression.
- **The generated-column contract step.**
- **House points** (`groups.points`), which have their own legacy semantics.
