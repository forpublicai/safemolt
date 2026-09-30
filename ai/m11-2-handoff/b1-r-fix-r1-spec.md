# b1 Lane R — codex round-1 fix spec (reactions)

Findings: `ai/m11-2-handoff/codex-findings-b1-r-round1.md` (all nine ADJUDICATED valid). Rules:
`ai/m11-2-handoff/b1-common-rules.md` (KISS, complexity ≤ 12, WHY-only short comments, no
git/codex/build, targeted jest + targeted integration, mutation-check every behavioral fix, evidence
verbatim). Fence = lane R's files; in `src/lib/store/notifications/*` touch ONLY the reaction writer.

1. **F1 cleanup key**: both stores' `reaction_added` notifications carry `metadata.post_id` (the
   post itself, or the comment's post) so `deleteNotificationsAnchoredToPost` removes them. Test:
   react → drain → deletePost → the notification is gone.
2. **F2 lock order**: in `addReaction`/`removeReaction` (db) and the reaction notification writer,
   lock the LIVE POST first in its own CTE (`FOR SHARE`, `deleted_at IS NULL`) and make the comment
   lock CTE select `FROM live_post JOIN comments …` so the post lock is always taken first.
3. **F3 memory actor re-check**: `reactions/memory.ts` checks the actor by id immediately before
   any mutation (quota, row, event) and answers `not_found`-class refusal like the FK. Test with a
   withdrawal during the action's read.
4. **F5+F6 one transaction**: `addReaction` validates events first, then runs ONE `sql.transaction`
   batch: statement 1 seeds the rate row AND locks it (`INSERT … ON CONFLICT DO UPDATE … RETURNING`
   or a `SELECT … FOR UPDATE` right after the seed), statement 2 is the decisive statement whose
   snapshot is taken AFTER the lock — so a concurrent duplicate at the cap classifies
   `already_reacted`. Test: two identical requests with one slot left → one `added`, one
   `already_reacted`, never `rate_limited`.
5. **F7 removal gate**: `removeReaction` gates its DELETE and `reaction.removed` on the locked live
   subject (post first, then comment) in both stores; stays uncapped. Test: remove against deleted
   content writes nothing, emits nothing.
6. **F4 real races**: rewrite the react-vs-delete integration cases with overlapping transactions
   (reuse `src/__tests__/integration/helpers/concurrency.ts` / `causal-coupling.ts` patterns used by
   the u3 suites) for both orders and both subject types; assert notification removal after a
   drain; add a memory-mode concurrent-duplicate test; make the serializer test assert a NON-empty
   `reactions` map and the 429 test assert `retry_after_seconds === secondsUntilUtcMidnight()` at a
   frozen clock.
7. **F8 JSON null body**: both routes answer 400 for a non-object body (POST and DELETE); tests.
8. **F9 comment**: replace the sibling-writer paragraph with the general rule (one row, one
   modification per statement) and the Postgres WITH-queries reference, ≤ 4 lines.

Report: `ai/m11-2-handoff/b1-r-fix-r1-report.md` — per finding: change, test, mutation-check
evidence; gate tails (tsc, lint, reactions jest paths + events + karma-writer + school-gate,
the reactions integration file).
