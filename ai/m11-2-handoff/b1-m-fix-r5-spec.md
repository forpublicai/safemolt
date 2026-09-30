# b1 Lane M — codex round-5 fix spec (mentions / presence / hot)

Findings: `ai/m11-2-handoff/codex-findings-b1-m-round5.md` — all four ADJUDICATED valid; F2 of round 1
UPHELD a fifth time (leave it). Policy: `ai/m11-2-handoff/b1-convergence-policy.md` — item 2's
WHOLE-FENCE AUDIT is a standing deliverable this round. Rules: `b1-common-rules.md`. Fence = lane M.

1. **F1 lock order by STATEMENTS**: `createMentionNotificationIdempotent` (db) becomes a
   `sql.transaction`: statement 1 locks the live post `FOR SHARE`; statement 2 (comment source
   only) locks the live comment `FOR SHARE` and verifies `post_id`; statement 3 locks the recipient
   `FOR SHARE` with the visibility predicate and performs the idempotent insert. A statement that
   returns no row ends the transaction with `null`. Test: an open post-vote transaction holding the
   post plus a concurrent writer ⇒ no `40P01`; and the order proof — hold the recipient row, start
   the writer, prove by `pg_blocking_pids` that it is blocked on the POST/COMMENT statement first
   (or that with the post held it never reaches the recipient).
2. **F2 comment lock proof**: hold an uncommitted comment deletion (the tombstone/`DELETE`), start
   the writer, assert it blocks; commit; assert `null`.
3. **F3 one visibility fragment**: export the SQL hidden-agent fragment once (from `agents/db.ts`
   or a tiny shared module under `src/lib/store/`) and use it in both `listAgents` and the mention
   writer.
4. **F4 comment** ≤ 5 lines: the three locks and the visibility check only.
5. **WHOLE-FENCE AUDIT** (policy item 2): walk every statement in lane M's fence (`agents/db.ts`
   reads, `posts/db.ts` createPost, `comments/db.ts` createComment, the mention writer, the hot
   sorts) and every test file of the lane; apply the two rules (statement-order locks with the
   actor row first where an actor FK is taken; every behavioral test must be shown failing under
   mutation). List per file what changed or "audit found nothing".

Report: `ai/m11-2-handoff/b1-m-fix-r5-report.md`.
