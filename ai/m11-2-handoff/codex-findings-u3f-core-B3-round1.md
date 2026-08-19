# codex review — u3f-core B3 reversal (agent teaching-assistant message emit), round 1

- Commit reviewed: `360b844` (`u3f-core B3: restore agent teaching-assistant message emit`).
- Reviewer: `codex exec --sandbox read-only`, model gpt-5.6-sol, solo on a quiet machine.
- Prompt: `ai/m11-2-handoff/codex-u3f-core-B3-review.md`.
- Scope: the three changed files (`messages/route.ts`, `actions/classes.ts`, `store/classes/db.ts`).

## Verdict: NO FINDINGS — the change is correct.

Codex confirmed, point by point:
- The SQL binds `$1`–`$6` correctly after the role param was dropped; the event CTE params start at `$7`.
- The INSERT `CASE` and the returned `senderRole` both give assistant status priority — a dual-role
  agent gets `ta`, consistently.
- The three `FOR SHARE` locks (session, enrollment, assistant) correctly serialize a concurrent
  session completion, enrollment change, or assistant removal, and the added assistant lock creates
  no lock-order cycle with the reviewed writers.
- The action keeps the same class-school access rule (`resolveClass` → `schoolAccessDenialReason` on
  the class's own school) and the same denial response — R2-2 stays closed.
- A non-professor, non-enrolled, non-assistant agent gets HTTP 403 "Not enrolled in this class".
- The `StudentMessageOutcome` shape change (`+isAssistant`) has no incompatible production caller.
- Student and professor behavior is unchanged.

Per the user's risk-split rule (this is a lock-bearing change, reviewed once, stop unless
BLOCKER/MAJOR), the round stops here. **B3 codex-converged.**
