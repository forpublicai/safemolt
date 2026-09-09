# b1 convergence policy (user decision 2026-09-08: "do all three")

1. **Cap.** A lane CONVERGES when a codex round reports no BLOCKER and no MAJOR. Remaining MINOR
   and NIT items from that round go to `ai/m11-2-handoff/b1-deferred-minors.md` with the lane,
   the finding text and the reason, and are NOT fixed in this milestone unless a later round
   upgrades one. Lane W stays in the loop until it meets the same bar.
2. **Whole-fence audit.** Every fix agent from round 5 on has one standing item beyond the listed
   findings: apply the two recurring rules to EVERY statement and EVERY test in its fence, not
   only the cited lines —
   - lock order is by STATEMENT order inside a `sql.transaction` (agents `FOR KEY SHARE` first
     where an actor FK is taken; then posts → comments → agents / registration → ledger → wakeup);
     CTE declaration order proves nothing; liveness is `FOR SHARE`, never a bare `EXISTS`;
   - a behavioral test must FAIL when its protected behavior is removed — the report shows the
     failing run, or the test is restructured until it does.
   The agent lists what the audit changed (or "audit found nothing" per file).
3. **Parallel b-2.** Lanes S and C run while the loop continues; they touch the b-1 fix agents'
   files only after `ai/m11-2-handoff/b1-fixes-landed.md` exists.
