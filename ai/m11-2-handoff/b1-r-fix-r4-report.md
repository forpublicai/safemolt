# b1 Lane R — fix round 4 report (reactions)

All six items from `codex-findings-b1-r-round4.md` implemented.

## 1. Deliverables

| # | Finding | State | Files |
|---|---|---|---|
| 1 | F1 — comment reactions still reverse the lock order | **Done** | `src/lib/store/reactions/db.ts` |
| 2 | F2 — a failed execution guard still permits quota writes | **Done** | `src/lib/store/reactions/db.ts` |
| 3 | F3 — actor withdrawal produces different refusals in the two stores | **Done** | `src/lib/store/reactions/db.ts` |
| 4 | F4/F5 test — the F5 deferral had no reliable mutation evidence | **Done** | `src/__tests__/integration/m11-2-b1-reactions.test.ts` |
| 5 | F5 — guard tests omitted superseded claims and real events | **Done** | `src/__tests__/integration/m11-2-b1-reactions.test.ts` |
| 6 | F6 — the store repeats its lock explanation | **Done** | `src/lib/store/reactions/db.ts` |

### Code changes — `src/lib/store/reactions/db.ts`

- **Item 1 (comment lock, statement 1).** `subjectOnlyLockStatementText`'s comment branch now locks
  BOTH the post and the comment (`SELECT p.id, c.id FROM posts p JOIN comments c ... FOR SHARE`),
  not just the post — before the seed's statement 2 ever touches `agents`. Keeps the global order
  posts -> comments -> agents for a comment subject the same way it already held for a post subject.
- **Item 2 (guard gates the seed and the quota).**
  - `seedStatementText` is new: with a guard, it renders `WITH guard AS (...) INSERT ... SELECT $1,
    CURRENT_DATE, 0 WHERE EXISTS (SELECT 1 FROM guard) ON CONFLICT ...` — a failed guard makes the
    `SELECT` return no rows, so the `INSERT` (and its `ON CONFLICT` arm) never fires. Without a
    guard it renders the same plain `INSERT ... SELECT` with no `WHERE`, unchanged behavior.
  - `addReactionStatementText`'s `rate_updated` CTE now reads `WHERE agent_id = $1 AND EXISTS
    (SELECT 1 FROM inserted)` instead of an unconditional `UPDATE` with a `CASE WHEN` on the delta —
    a duplicate, an over-cap call, or a failed guard now leaves the row's date and count untouched
    instead of only skipping the `+1`.
  - `addReaction` builds a SECOND guard fragment (`seedGuard = buildExecutionGuardCte(executionGuard,
    2)`) for statement 2's own placeholder namespace (`$1` is `agentId` there), independent of the
    decisive statement's guard fragment.
- **Item 3 (actor FK parity).** `ACTOR_RATE_LIMIT_FK = "agent_rate_limits_agent_id_fkey"` and
  `isActorForeignKeyViolation` mirror `dms/db.ts`'s `SENDER_RATE_LIMIT_FK` pattern exactly. A new
  `runOrActorGone` helper wraps the `sql.transaction` call, translating that one named constraint
  into `{ ok: false }` (re-thrown otherwise) — split into its own function specifically to keep
  `addReaction`'s own complexity under the budget (ESLint's `complexity` rule flagged 13 before the
  split). `addReaction` turns `{ ok: false }` into `{ outcome: "not_found", counts: ... }`, the same
  refusal `reactions/memory.ts` already gives for the identical race (its own F3, round 3).
- **Item 6 (comment consolidation).** `subjectOnlyLockStatementText`'s doc comment shrank to one
  line; the full lock-order/guard/FK explanation now lives ONCE, beside `addReaction`'s own
  `sql.transaction` call (5 lines, WHY-only).

No other files in the fence needed changes — `memory.ts`, `actions/reactions.ts`,
`agent-tools/definitions/reactions.ts`, and both route files were re-read but untouched; none of
the six findings touch their surface.

## 2. Gate results

```
$ npx tsc --noEmit
(clean, exit 0)

$ npx eslint src/lib/store/reactions/db.ts src/lib/store/reactions/memory.ts \
    src/lib/actions/reactions.ts src/lib/agent-tools/definitions/reactions.ts \
    "src/app/api/v1/posts/[id]/reactions/route.ts" "src/app/api/v1/comments/[id]/reactions/route.ts" \
    src/__tests__/lib/store/reactions-memory.test.ts src/__tests__/api/reactions-routes.test.ts \
    src/__tests__/integration/m11-2-b1-reactions.test.ts --max-warnings=0
(clean — no errors, no warnings; the pre-existing "addReaction complexity 13" warning from round 3
 is gone after the `runOrActorGone` extraction)

$ npm test -- src/__tests__/lib/store/reactions-memory.test.ts src/__tests__/api/reactions-routes.test.ts \
    src/__tests__/lib/events src/__tests__/lib/agent-tools src/__tests__/lib/karma-writer-ownership.test.ts
Test Suites: 17 passed, 17 total
Tests:       238 passed, 238 total
```

Integration file, run three times total against the fully-finished file (two consecutive clean runs
recorded here, both solo, advisory lock uncontended once acquired):

```
$ npm run test:integration -- src/__tests__/integration/m11-2-b1-reactions.test.ts   (run A)
PASS src/__tests__/integration/m11-2-b1-reactions.test.ts
Test Suites: 1 passed, 1 total
Tests:       26 passed, 26 total
Time:        92.904 s

$ npm run test:integration -- src/__tests__/integration/m11-2-b1-reactions.test.ts   (run B)
PASS src/__tests__/integration/m11-2-b1-reactions.test.ts
Test Suites: 1 passed, 1 total
Tests:       26 passed, 26 total
Time:        91.63 s
```

(A third full run, immediately after the last mutation-check restore and before runs A/B above, also
passed 26/26 — omitted here to avoid repeating an identical tail.)

## 3. Mutation-check evidence, verbatim

**Item 1 (comment lock in statement 1).** Reverted the comment branch of
`subjectOnlyLockStatementText` to lock only the post (the pre-round-4 shape). Ran the new
"F1: a self-reaction on a COMMENT..." test:
```
● F1: a self-reaction on a COMMENT with no existing rate row does not deadlock with a withdrawal (codex round 4)
    › addReaction queues behind a held withdrawal comment-lock and both sides resolve without a 40P01

  expect(received).not.toBe(expected) // Object.is equality
  Expected: not "40P01"
```
A genuine `40P01` was raised (the reaction's seed grabbed the actor's `agents` lock before the
comment was ever contended, so withdrawal's `DELETE` then waited on that lock while the reaction
waited on withdrawal's held comment lock — the exact cycle the finding describes). Restored — green
again.

**Item 2a (seed gated on guard).** Removed the seed's `WHERE EXISTS (SELECT 1 FROM guard)` clause
(seed always inserts regardless of the guard). Ran "F2: a failed guard leaves... › creates no row
for an agent with none yet":
```
expect(received).toBeUndefined()
Received: {"reaction_count": 0, "reaction_count_date": "2026-09-09"}
```
A fresh row was seeded despite the disabled loop state. Restored — green again.

**Item 2b (quota update gated on `inserted`).** Removed `AND EXISTS (SELECT 1 FROM inserted)` from
`rate_updated`'s `WHERE`. Ran "F2: a failed guard leaves... › rolls neither the date nor the count
of a previous-day row":
```
Expected: 5
Received: 1
```
The previous-day row's count was rolled to 1 (and its date to today) despite the guard failure and
zero inserts. Restored — green again.

**Item 3 (actor FK translation).** Disabled the `isActorForeignKeyViolation` branch inside
`runOrActorGone` (`if (false && isActorForeignKeyViolation(error)) ...`). Ran "F3: a withdrawn
actor...":
```
NeonDbError: insert or update on table "agent_rate_limits" violates foreign key constraint
"agent_rate_limits_agent_id_fkey"
  at runOrActorGone (src/lib/store/reactions/db.ts:70:37)
```
The raw `23503` propagated as an uncaught rejection instead of `not_found`. Restored — green again.

**Item 4 (the rewritten F5 test, "drop the seed's lock").** Replaced the seed statement's body with
a no-op that never touches `agent_rate_limits` (`SELECT $1::text`), keeping the statement's position
and marker. Ran the new single-real-contender F5 test:
```
● concurrent duplicate reacts › F5: a contender blocked on the seed's COMMITTED row lock answers
  already_reacted, never rate_limited, once the holder plants the duplicate and caps the count

  Expected: "already_reacted"
  Received: "rate_limited"
```
This is the exact misclassification round 3 could not reliably reproduce: without the seed's own
statement-level wait, the contender's decisive statement races the holder's commit instead of
waiting for it first — `existing` keeps its pre-wait (empty) snapshot from the statement's own
snapshot while `pre`'s row lock picks up the fresh, capped count via EPQ once the holder commits,
so a genuine duplicate is misreported as `rate_limited`. Restored — green again. This closes the
finding-4 deferral: round 3's mutation attempts (`DO NOTHING`, a no-op still referencing the table)
did not reproduce it because a TWO-real-contender test left statement 3's own `pre` lock as a second,
redundant serialization point; the single-contender-plus-holder-writes-directly design removes that
redundancy and makes the seed's own wait the only thing standing between the two snapshots.

**Item 5 (superseded-claim-token test, verified non-vacuous).** Mutated the classification's guard
check in `addReaction` (`Number(row?.guard_passed ?? 0) === 0` to `=== -1`, i.e. never true). Ran
"F1: the execution guard gates... › addReaction refuses execution_guard_failed once the claim is
superseded by a fresh token":
```
Expected: "execution_guard_failed"
Received: "already_reacted"
```
(The seed's own guard gate still blocked the insert, but with the top-level classification disabled
the outcome fell through to the ternary chain's final default, `"already_reacted"` — a real
misclassification, not just a missed `execution_guard_failed`.) Restored — green again. Also
reconfirmed the pre-existing "disabled before the write" test still fails under the ORIGINAL round-3
mutation (dropping `guard` from the `inserted` CTE's `FROM` list), and that this specific mutation
does NOT trip the superseded-token test — the two tests exercise the guard's two independent SQL
conditions (`ls.enabled` vs. `w.claim_token = ...`) through the one shared classification line, so
between them they cover both causes of a `guard_passed = 0` row.

**Item 6 (comment consolidation).** No behavior to mutation-check — a doc-comment-only change.
Verified by re-reading the file: the lock-order/guard/FK explanation now appears exactly once,
beside `addReaction`'s own `sql.transaction` call.

## 4. Shared-file edits (collision protocol)

None. Every edit this round landed inside `src/lib/store/reactions/db.ts` and
`src/__tests__/integration/m11-2-b1-reactions.test.ts`, both exclusively owned by this lane. No
files from the common-rules shared-file table were touched. `src/lib/store/execution-guard.ts` was
read only, to reuse `buildExecutionGuardCte` a second time (for the seed's own placeholder
namespace) exactly as `sendDm`/`createComment` already do for their own statements.

## 5. Out-of-fence needs and cross-lane notes

None observed this round. `git status` at the end of this session shows only the two files listed
above as modified within this lane's fence.

## 6. Docs delta

None of the six findings change agent-visible request/response shapes — all six are internal
lock-order, gating, refusal-parity, and test-quality corrections. No `public/reference.md`,
`public/skill.md`, `public/openapi.json`, or `public/planned.md` change is needed.

Suggested `CLAUDE.md`/`agents.md` invariant addition (docs agent to apply verbatim, house style),
extending round 3's "A writer that seeds a row for the first time must lock its OWN subject before
the seed runs" entry:

> **A polymorphic subject's lock covers every table the subject spans, in the SAME statement.**
> `addReaction`'s statement 1 originally locked only the post for a comment subject, leaving the
> comment itself unlocked ahead of the seed's actor lock — a self-reacting comment author's
> withdrawal could then lock the comment (as `deleteAgent` always does) while the reaction's seed
> already held the actor's row, a genuine `40P01`. Locking the whole subject — post AND comment —
> in statement 1 keeps a polymorphic write's lock order (posts -> comments -> agents) intact
> regardless of which concrete table the subject resolves to (`reactions/db.ts`, M11b lane R fix
> round 4, F1).

## 7. Behavior changes or plan deviations

- **A comment reaction's statement 1 now locks the comment too**, not just its post (F1). Genuine
  lock-acquisition-order change; no outcome, status code, or response shape changed for any caller.
- **A failed execution guard no longer seeds `agent_rate_limits`, and no longer rolls a stale row's
  date or resets its count** (F2). Previously a disabled runner's refused call could still create a
  rate-limit row or silently roll a previous day's window forward; now it writes nothing. This is a
  genuine behavior change but is unreachable from any REST route or external tool call — the
  execution guard is populated only by `agent-pulse/runner.ts`.
- **A withdrawn actor's `addReaction` now answers `not_found` instead of raising an uncaught
  `23503`** (F3). The route-facing effect is that this race no longer 500s.
- **The F5 integration test is rewritten** from a two-real-contender race (which round 3's own
  mutation-check could not reliably distinguish from the unfixed code) to a single-real-contender
  test where a third connection plants the duplicate and caps the count while the contender is
  provably blocked — this version DOES have positive mutation evidence (section 3), closing the
  round-3 deferral.
- No other deviations. All other findings implement the spec's stated remedy directly.
