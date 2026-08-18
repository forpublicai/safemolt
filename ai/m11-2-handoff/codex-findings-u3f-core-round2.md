# u3f-core — codex review round 2

Prompt: `ai/m11-2-handoff/codex-u3f-review-core-r2.md`. Verdict: NOT converged — **4 MAJOR, 0 BLOCKER**.
codex CONFIRMED B1, B2, M5, M6, M7 "match their accepted designs"; event CTEs gate on their decisive
rows; no karma writer; routes/tools follow the action boundary. Orchestrator adjudication: all 4 real.

## Findings

**R2-1 (MAJOR, classes) — the M4 SQL gates still permit race writes** (`store/classes/db.ts:372`
enroll, `:616` message, `:781` eval). The enroll cap is ONE statement with `FOR UPDATE` + count +
insert — but a single statement takes ONE snapshot at statement start, so a contender that waits on
the class lock still counts seats as they stood before the winner committed, and the cap is breached
(both enroll, both emit `class.enrolled`). This is EXACTLY the READ-COMMITTED trap the admissions D6
batch documents and avoids (`admissions/store-db.ts:337` comment). The message/eval gates re-check
session/eval/enrollment liveness with bare snapshot reads, not `FOR SHARE` locks (agents.md: "a
parent-liveness check inside a write is a FOR SHARE LOCK, never a bare EXISTS"). **ADOPT.** Fix:
enroll cap = two elements — element 1 locks the class row `FOR UPDATE`; a LATER element (fresh
snapshot) counts enrollments and inserts, gated on the count. Message/eval = take `FOR SHARE` on the
session row / evaluation row / enrollment row inside the decisive statement so a concurrent
completion/closure/drop cannot slip past a snapshot read. Both stores; memory re-checks synchronously.

**R2-2 (MAJOR, classes) — agent teaching-assistant bypasses the school gate** (`messages/route.ts:80`).
A REGRESSION from B3: the student branch runs `requireSchoolAccess` (inside `sendSessionMessage`'s
`resolveClass`), but the new assistant branch calls `addOperatorClassSessionMessage` with no school
check, so an unvetted/unadmitted agent-assistant can post. **ADOPT.** Fix: call `requireSchoolAccess`
(the route already imports it) in the assistant branch before the operator write, returning the exact
school-denial response; add a negative-assistant test.

**R2-3 (MAJOR, admissions) — a concurrent staff decision can change a closed application**
(`actions/admissions.ts:33 updateNiche`; `admissions/store-db.ts:255 updateApplicationNicheDb`). The
action reads `app.state` then the UPDATE has no state condition, so staff admitting/rejecting in the
gap lets the agent edit a closed application. **ADOPT** (the pre-read-is-stale rule). Fix: one
conditional UPDATE with an allowed-state predicate (`state NOT IN ('rejected','admitted')`) and
`RETURNING`; the action classifies from the returned row/flag; the memory twin re-checks the current
state immediately before its write.

**R2-4 (MAJOR, both) — M10 does not prove the race/coupling** (`integration/m11-2-u3f-core-classes.test.ts:155`;
`integration/admissions-expiry.test.ts:15`; `lib/admissions/events-coupling.test.ts:108`). Class tests
are sequential (no true 2-connection race for the enroll cap / a concurrent completion / a drop); the
expiry test treats successful execution as lock-order proof (it never runs the sweep against agent
deletion, so B1 is unproven); and db event-failure rollback is missing for class drop, application
creation, acceptance and decline. **ADOPT.** Fix: deterministic two-connection race tests with lock
barriers proving the R2-1 cap holds and B1's order holds against a concurrent `deleteAgent`; add
event-insert-failure triggers for each missing producer; assert the full 201 body for all three
message actor branches (professor, TA, student).

## Fix lanes (resume the two agents)
- **classes agent**: R2-1, R2-2, R2-4(classes).
- **admissions agent**: R2-3, R2-4(admissions — the expiry-vs-deletion race + the missing db
  event-failure rollbacks).
Then: full five gates, CORE codex round 3.
