# u3f-lite — codex review round 1 (the one scheduled low-risk round)

Prompt: `ai/m11-2-handoff/codex-u3f-review-lite.md`. Model gpt-5.6-sol, `codex exec --sandbox
read-only`, solo, stdin closed. Verdict: does NOT ship as-is — 3 MAJOR. All three adjudicated as
REAL and fixed by the orchestrator (small prescribed repairs). No BLOCKER.

## Findings and disposition

1. **MAJOR — avatar statement re-reads the row (`store/agents/db.ts` `writeAgentAvatar`;
   memory twin `store/agents/memory.ts`).** The write + event commit, then `getAgentById`
   re-reads. A concurrent withdrawal in the window reports `not_found` AFTER a committed write and
   event; a concurrent avatar edit lets the response carry the other write's value. `updateAgentProfile`
   already returns the row FROM its statement — the avatar writer was the lone re-reader.
   **ADOPTED.** Db: restructured to `prior` (FOR NO KEY UPDATE) + conditional `updated` CTEs,
   returns `updated_row ?? prior_row` (mirrors `updateAgentProfile`); the event still gates on
   `updated`, so a no-op still emits nothing and the statement is still atomic. Memory: returns the
   saved `next` value, not a post-await map re-read. Verified: lite integration `rolls the avatar
   write back when its event cannot be written` (the new statement parses and rolls back).

2. **MAJOR — characterization does not pin the raw-vector 429 and 503 outcomes**
   (`m11-2-u3f-lite-characterization.test.ts`). The suite pins 200/400 for upsert/delete but never
   the `rate_limited` (429) or `vector_unavailable` (503) published results, so a later edit could
   move their status/body/code with every gate still green. **ADOPTED (tests-only).** Added a
   behavior-preserving `jest.mock("@/lib/memory/memory-service", requireActual + jest.fn wrapper)`
   — the only mock this file needs, since these are backend-failure paths — and two tests:
   sponsored-limit ⇒ 429 `rate_limited` "daily limit reached"; provider error ⇒ 503
   `service_unavailable` "embedding or vector store failed". (`jest.spyOn` on the export fails —
   SWC makes it non-configurable — hence the module-mock form.)

3. **MAJOR — coupling failure-injection incomplete** (`m11-2-u3f-lite.test.ts`). The header claims
   context write AND delete carry their events in one statement, but only `memory.context_written`
   was failure-tested, and the avatar statement had no rollback test. **ADOPTED (tests-only).**
   Added `rolls the delete back when the context-deleted event cannot be written` (row survives, no
   event) and `rolls the avatar write back when its event cannot be written` (avatar unchanged, no
   event). Both use the existing `withEventFailure` trigger.

## Gates after fix
tsc ✓; lint ✓ (0 errors, pre-existing complexity warnings only); full unit 160 suites / 1520 ✓;
build ✓; lite integration 12/12 ✓. Full integration deferred to the combined u3f boundary after
the core review.

## Ruling
LITE is closed after round 1 per directive 7 (low-risk slice, one round, fix BLOCKER/MAJOR then
stop). The three MAJORs were fixed; finding 1's production change is a mechanical mirror of the
already-reviewed `updateAgentProfile` pattern, verified by the new integration rollback test — no
re-review round warranted for this slice.
