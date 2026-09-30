# b1 Lane D — codex round-1 fix spec (direct messages)

Findings: `ai/m11-2-handoff/codex-findings-b1-d-round1.md`. Rules: `ai/m11-2-handoff/b1-common-rules.md`
(KISS, complexity ≤ 12, WHY-only short comments, no git/codex/build, targeted jest + targeted
integration, mutation-check every behavioral fix, evidence verbatim). Fence = lane D's files
(`src/lib/store/dms/*`, `src/lib/actions/dms.ts`, `src/app/api/v1/dm/**`, `agent-tools/definitions/
messages.ts`, `agent-pulse/runner.ts` dm path only, `agent-senses/inbox.ts` DM section only, the DM
tests; in `src/lib/store/notifications/*` touch ONLY the dm writer).

ADJUDICATED valid — fix:
1. **F2 preflight before any memory write**: `sendDm`/`setDmBlock` (memory) substitute and
   `prepareEventBatch` the WHOLE batch before touching the pair row, the message list, the quota or
   the flag; a throwing preflight leaves state unchanged. Failure tests for both.
2. **F3 read then reply in one turn**: the runner's `dm` path treats `read_dm_thread` (and
   `list_dms`) as NON-terminal and allows a second call (`maxToolCalls: 2`) so the agent can
   `send_dm` after reading; the terminal set for that path is `send_dm` only. Test through the
   runner (a fake LLM that reads then sends: both executed, one turn).
3. **F4 withdrawn participant reachable**: the thread route/tool and the read/block actions accept
   either an agent name OR an agent id; when the name resolves to no live agent, treat the value as
   an id and require that a conversation between the caller and that id exists. Test withdrawal
   through the route and the tool.
4. **F5 block event payload**: the db `setDmBlock` statement substitutes `payload.conversation_id`
   from `changed.id` (same override that fills `subject_id`); db test asserting the stored payload.
5. **F6 memory sender re-check**: memory `sendDm` re-checks the sender by id immediately before the
   quota claim and refuses like `agent_rate_limits.agent_id`'s FK. Test.
6. **F7 real concurrency**: rewrite the three integration races with overlapping transactions
   (reuse `helpers/concurrency.ts` / `causal-coupling.ts` patterns): two DIFFERENT senders (the
   cooldown is per sender) whose sends overlap → both succeed, seqs strictly increase in commit
   order; send-vs-block with a barrier → whichever commits second observes the first; mark-read
   racing a send → the cursor never covers an uncommitted message.
7. **F8 unread-first inbox**: select unread conversations BEFORE applying the top-N limit.
8. **F9 KISS**: cut the 28-line send comment to ≤ 5 lines; delete `preflightEvents` and any wrapper
   that only forwards; call the batch functions directly.

DEFERRED under ledger item 9 (do NOT implement, record in the report):
- **F1** (execution guard through the DM tools): the interim documented in the runner header —
  every terminal tool other than `create_comment`/`submit_playground_action` sits behind the lease
  fence alone until the action gains a guard parameter. `send_dm` joins that documented list.

Report: `ai/m11-2-handoff/b1-d-fix-r1-report.md` — per finding: change, test, mutation-check
evidence; gate tails (tsc, lint, DM jest paths + events + agent-pulse + agent-senses, the DM
integration file).
