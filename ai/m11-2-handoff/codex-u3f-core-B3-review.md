## Scoped review — M11-2 u3f-core finding B3 REVERSAL (agent teaching-assistant message emit)

You are the review agent (read-only). Review ONE small, self-contained change on branch
`ops/code-improve`, commit `360b844` (`git show 360b844`). Do NOT run jest, tsc, or the build — the
sandbox denies the temp writes and the attempt can kill your session. All five gates already pass
(tsc, lint, 24 unit, 18 integration, build). Reason about the diff and the surrounding code only.

### What changed and WHY

Background: SafeMolt classes have session messages. Four actors can post: the human **professor**,
an enrolled **student**, and an agent **teaching assistant (TA)**. `class.session_message` is a
history event consumed by the activity trail.

u3f-core codex round 1 (finding B3) made the TA branch *history-silent*: the messages route detected
`isClassAssistant` and routed the TA through `addOperatorClassSessionMessage` (role `ta`, NO event),
matching the u3f-spec's "professor/TA operator branch". Round 1 itself flagged this as a
**product-semantics choice**, not a correctness fix. **The user has now decided the OPPOSITE: TA
messages MUST emit `class.session_message` again.** This commit implements that decision.

DO NOT re-flag the product decision. "The TA should be history-silent / should not emit" is REJECTED
by the user and is out of scope. Review only the *correctness* of the implementation that makes the
TA emit.

### The three files in scope

1. `src/app/api/v1/classes/[id]/sessions/[sessionId]/messages/route.ts` — the POST handler now:
   - keeps the human professor on `addOperatorClassSessionMessage` (operator, no event);
   - routes EVERY agent (enrolled student OR class assistant) through the `sendSessionMessage`
     action, which emits;
   - removed the old `isClassAssistant` special-case branch and its inline `requireSchoolAccess`.
2. `src/lib/actions/classes.ts` — `sendSessionMessage`: unchanged control flow; it calls
   `resolveClass` (which runs `schoolAccessDenialReason` on the CLASS's own `schoolId` and returns
   `vetting_required` / `admission_required`), then calls the store gate and renders the outcome.
3. `src/lib/store/classes/db.ts` — `addSessionMessageAsStudent` / `StudentMessageOutcome`: the gated
   INSERT now admits an assistant OR an enrolled (non-dropped) student, and derives the stored role
   IN the statement.

### The store statement (the heart of the change) — verify these specifically

```
WITH
  sess AS (SELECT status FROM class_sessions WHERE id = $2 FOR SHARE),
  enr  AS (SELECT 1 AS ok FROM class_enrollments WHERE class_id = $6 AND agent_id = $3 AND status <> 'dropped' FOR SHARE),
  asst AS (SELECT 1 AS ok FROM class_assistants   WHERE class_id = $6 AND agent_id = $3 FOR SHARE),
  gate AS (
    SELECT COALESCE((SELECT status = 'active' FROM sess), false) AS session_active,
           EXISTS (SELECT 1 FROM enr)  AS enrolled,
           EXISTS (SELECT 1 FROM asst) AS is_assistant
  ),
  inserted AS (
    INSERT INTO class_session_messages (id, session_id, sender_id, sender_role, content, created_at, sequence)
    SELECT $1, $2, $3, CASE WHEN g.is_assistant THEN 'ta' ELSE 'student' END, $4, $5,
      COALESCE((SELECT MAX(sequence) + 1 FROM class_session_messages WHERE session_id = $2), 1)
    FROM gate g WHERE g.session_active AND (g.enrolled OR g.is_assistant)
    RETURNING id, sequence, created_at
  ) <event CTEs> 
  SELECT g.session_active, g.enrolled, g.is_assistant, i.id, i.sequence, i.created_at
  FROM gate g LEFT JOIN inserted i ON true
```
Params: `$1 id, $2 session, $3 agent, $4 content, $5 createdAt, $6 class`. The role is NO LONGER a
param (previously `$4`); dropping it renumbered content/createdAt/class from `$5/$6/$7` to `$4/$5/$6`.
Event CTEs start at `firstParamIndex: params.length + 1` (= `$7`). The overrides reference
`sqlParam(2)` (session → subject_id) and `sqlParam(1)` (id → message_id).

### Focus your review on

- **Parameter numbering**: is every `$n` in the SQL and in the event-override `sqlParam(n)` calls
  bound to the intended value after the role param was dropped? Any off-by-one?
- **Role derivation correctness**: the `CASE` reads `g.is_assistant` from the `gate` CTE; the
  returned `senderRole` reads `row.is_assistant`. An agent who is BOTH an assistant and enrolled gets
  role `ta` (assistant wins) — is that consistent between the INSERT and the returned object?
- **Lock correctness**: `asst` is read `FOR SHARE` like `sess`/`enr`. Is that the right mode, and
  does adding a third `FOR SHARE` row-lock introduce any lock-ordering hazard vs the completer's
  `FOR UPDATE` on the session or a concurrent assistant-revocation? (agents.md: "a parent-liveness
  check inside a write is a FOR SHARE LOCK, never a bare EXISTS".)
- **The adapter split**: does the route still refuse correctly? A non-professor, non-enrolled,
  non-assistant agent should get 403 "Not enrolled". The action returns `forbidden` when the store
  wrote no row and the session was active. Is the school gate (`resolveClass` →
  `schoolAccessDenialReason` on the class's OWN school) equivalent to the removed inline
  `requireSchoolAccess(agent, cls.schoolId)` — same denial envelope, same host-vs-class-school
  semantics (R2-2)?
- **Outcome shape**: `StudentMessageOutcome` gained `isAssistant`. Any caller or test relying on the
  old shape? Any place still assuming a message from this store is always role `student`?
- **Regression**: does anything OTHER than the intended behavior change? (Student and professor
  branches must be byte-for-byte equivalent to before.)

### Pins — do NOT re-litigate (settled)

- The product decision "TA emits" is the USER's; do not propose reverting it.
- The R2-1 pattern (session + participation re-checked `FOR SHARE` inside the write, not a bare
  pre-read) is the CONVERGED correct design; this change extends it to the assistant read.
- Classes are Postgres-ONLY — there is no memory-store twin to keep in parity.

### Output

List findings as BLOCKER / MAJOR / MINOR / NIT, each with file:line, the concrete failure scenario
(inputs → wrong result), and a proposed fix. If the change is correct, say so plainly. Per the user's
risk-split rule this round stops unless you find a BLOCKER or MAJOR.
