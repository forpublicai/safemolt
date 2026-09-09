# M11-2 execution handoff — stop point 2026-09-08 (late): M11b wave b-1 in codex round 5, wave b-2 landing

Work on `ai/PLAN_M11_2.md` moved from "M11a CODE COMPLETE" (the previous stop, commit `acc9490`) into
M11b. This file is the pickup point for the next session. Companion state lives in the orchestrator
memory files `~/.claude/projects/-Users-mohsin-Github-safemolt/memory/m11b-execution-state.md` (this
milestone) and `m11-2-execution-state.md` (the M11a trail).

Branch: `ops/code-improve`. **NOTHING FROM THIS SESSION IS PUSHED** — the branch was 0 ahead of origin
at session start; every commit below is local. Do not push unless the user asks. The orchestrator owns
ALL git writes; implementation agents are forbidden from git.

## Verified state at the stop (commit `432ab1b`, working tree clean at that commit)

- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors; 112 pre-existing complexity warnings (none in files this milestone created).
- `npm test -- --runInBand` — **213 suites / 2134 tests, all green.**
- `npm run test:integration` — last FULL run at the b-1 boundary (`d5b0627`): 57 suites / 724 tests
  green. Since then every lane's own integration file was re-run by the orchestrator after every fix
  round (last: W 22, M 17, R 26, D 21 ×2, all green). A full run is due at the next boundary.
- `npm run build` — green at the b-1 boundary; not re-run since (no route/page shape changed after).

Three agents were LIVE when this file was written (all background, all started after `432ab1b`):
lane S gen-2 (seq + frame CTE splices), lane C gen-2 (P7.1 deletions), and codex round 5 for lane M.
Their outputs land in `ai/m11-2-handoff/` as `b2-lane-s-report.md` (gen-2 section),
`b2-lane-c-report.md` (gen-2 section) and `codex-findings-b1-m-round5-raw.log`. **If you resume
cold, treat their files as possibly half-written: check `git status`, run tsc, and read the reports
before touching anything.**

## What M11b is, and what landed

M11b = P5 + P6 + P7 of the plan. Two waves were run:

| Wave | Lane | Content | State |
|---|---|---|---|
| b-1 | **W** webhooks (P5.1) | `agent_webhooks` + `webhook_deliveries` migration, store both modes, ledger CTE on every enqueue path, `webhook.disabled` kind + notification, SSRF-safe pinned https delivery (`src/lib/webhooks/deliver.ts`), `POST/GET/DELETE /agents/me/webhook` behind `WEBHOOKS_ENABLED`, worker duty + degraded cron pass | code complete; codex rounds 1–4 fixed (37 findings); round 5 pending |
| b-1 | **M** mentions + presence + hot decay (P6.1/P6.4/P6.5) | `extractMentions`, registration grammar enforced, `agent.mentioned` derived events in the SAME statement as the content write (store-filled `source_id`), mention notifications + wakeups with comment-source suppression, presence buckets + `GET /agents?filter=active_now`, `hot-score.ts` at all four sort sites + feed cold-start fallback | code complete; rounds 1–4 fixed (18 findings); round 5 RUNNING |
| b-1 | **R** reactions (P6.2) | `content_reactions` + rate-limit columns, three-statement transaction (subject lock → rate-row seed → decisive), add/remove actions, four routes, two tools, counts in every serializer incl. the context feed and news, `reaction_added` notification, deletePost cleanup | code complete; rounds 1–4 fixed (28 findings); round 5 pending |
| b-1 | **D** direct messages (P6.3) | `dm_conversations`/`dm_messages`, send as a guarded multi-statement transaction (pair-row lock, block re-check both directions, comment-pool claim, gated seq bump, empty-pair cleanup on refusal), four actions, five routes, five tools in a `messages` loop domain, `dm` wakeup reason with read-then-reply, DM inbox section | code complete; rounds 1–4 fixed (27 findings); round 5 pending |
| b-2 | **S** SSE stream + symmetry (P5.2/P5.3) | stream migration + two runbook scripts, `src/lib/stream/token.ts`, `POST /agents/me/stream-token` behind `STREAM_ENABLED`, `src/lib/store/stream/*`, `src/lib/worker/stream-server.ts` mounted in `worker/index.ts`, retention, `symmetry-contract.test.ts` | non-gated part landed in `432ab1b`; gen-2 agent splicing the per-recipient `stream_seq` CTE into the three enqueue paths and the frame CTE into every notification/activity writer + the school-events route; NO codex round yet |
| b-2 | **C** P7 cleanup | P7.4 hygiene done (five planning docs archived with `ai/archive/README.md`, PLAN.md tooling refs + backlog, PLAN_M10 supersession); P7.2 and P7.3 found ALREADY satisfied by earlier waves (M11-1b D5 made playground memory durable; `sessions/active` already reads the shared store); boundary allowlist already at the §10 permanent set | P7.1 deletions running in the gen-2 agent; NO codex round yet |

Docs for b-1 were applied at the b-1 boundary (reference/skill/heartbeat/messaging/planned/openapi,
`agents.md` invariants + env table + file map, inventory §7 rows for the seven new kinds + §8 P5.1
runbook). **Docs for everything after `d5b0627` are NOT applied** — every fix round and both b-2
lanes recorded docs deltas in their reports; a docs pass is an open item below.

## Commit ladder this session (oldest first; `git log --oneline acc9490..HEAD`)

`7528702` b-1 specs → `ce78da9` b-2 draft specs → `d86788d` b-1 checkpoint (M+W) → `d5b0627` **b-1
BOUNDARY** (R+D+stitch+docs, five gates green) → `b3f07f1` codex prompts → round 1: `33f352c`
`e68b354` `941d7e6` `52c6fe8` findings, `65fc47e` fixes → round 2: `e47e0cc` prompts, `f84c255`
`2b1b8a5` `7aa1784` `adda4bf` findings, `6aebbfa` fixes → round 3: `126e9f1`, `9ec19e5` `a4f22e0`
`646a80b` `e778026`, `0b0e848` fixes → round 4: `536ea55`, `c018a93` `e615b50` `767e2db` `ef115d9`,
`2d7eb1d` b-2 concurrency rule, `91bb744` convergence policy, `432ab1b` **round-4 fixes + b-2 lanes
S/C (non-gated) + all round-4 markdown**.

(The many markdown-only commits predate the user's rule of 2026-09-08 — see directive 10 — and are
not to be repeated.)

## The codex loop, by the numbers

| Round | W | M | R | D | Notes |
|---|---|---|---|---|---|
| 1 | 7M+2m | 4M+3m+1N | 4M+4m+1N | 7M+1m+1N | M-F2 (mention wakeup pre-read) deferred; D-F1 (guard) deferred under ledger 9 |
| 2 | 8M+2m | 1M+4m+1N | 2M+4m+1N | 2M+3m+1N | W test deferrals OVERTURNED; R serializer deferrals OVERTURNED; D guard deferral OVERTURNED and adopted; M-F2 upheld |
| 3 | 5M+2m+1N | 1M+1m+1N | 3M+2m+1N | 2M+3m+1N | DM race flake adjudicated a TEST defect; M-F2 upheld |
| 4 | 2M+3m+1N | 1M+2m+1N | 1M+4m+1N | 2M+3m+1N | all accepted; M-F2 upheld |
| 5 | pending | running | pending | pending | first round under the convergence policy |

Recurring finding classes (they came back one file over each round — hence directive 12's
whole-fence audit): lock ORDER across statements (agent row FOR KEY SHARE first where an actor FK is
taken; posts → comments → agents; registration → ledger → wakeup; enforced by STATEMENT order inside a
`sql.transaction` — CTE order proves nothing); bare `EXISTS` where a `FOR SHARE` lock is required;
memory-mode parity after every `await` (actor/subject re-check, preflight before the first write,
same refusal class as the Postgres FK); tests that cannot fail (sequential calls where an overlap is
claimed, response order confused with commit order, mutation "passed three times" = no evidence);
comment essays (> 5 lines); JSON-boolean vs text comparison in the hidden-agent predicate.

## Open items, in order

1. **Finish codex round 5 for M (running), then R, D, W — strictly serial.** Apply
   `ai/m11-2-handoff/b1-convergence-policy.md`: a lane CONVERGES at a round with no BLOCKER/MAJOR;
   its leftover MINOR/NIT go to `b1-deferred-minors.md` (lane, round, finding, reason). Lanes M, R, D
   are expected to converge in round 5 or 6; W may need more. Fix specs for round 5+ carry the
   whole-fence audit item verbatim from the policy file.
2. **Land lane S gen-2 and lane C gen-2** (running): re-verify with real runs (S: `m11-2-b2-stream`,
   `m11-2-b1-webhooks`, `m11-2-u5-wakeups` integration files; C: the agent-loop/pulse/tools/senses
   suites + boundary), then ONE code commit carrying every pending markdown.
3. **Codex for wave b-2**: lane S needs full convergence (the seq counter is a commit-order argument;
   the frames ledger rides eight notification writers; the SSE server is a security surface — token,
   query-key rejection, CORS, connection cap). Lane C is low-risk: one round, stop unless
   BLOCKER/MAJOR. Prompt template: `codex-b1-review-w.md` (structure) — write `codex-b2-review-s.md`
   and `codex-b2-review-c.md` with files-in-scope lists from the lane reports.
4. **Boundary gates + docs pass** once b-2 converges: the five gates (full integration ~30 min,
   backgrounded, log to a file; build), then a docs agent applies the deltas recorded since
   `d5b0627` (all `b1-*-fix-r*-report.md` §docs, `b2-lane-s-report.md`, `b2-lane-c-report.md`):
   reference.md (SSE "listen, don't poll", the symmetry section, webhook headers/timeouts, DM
   pagination bounds, guard semantics), heartbeat.md, openapi (stream-token route, `stream_url`
   meta), `agents.md` (new invariants: statement-order lock rule, agent-row-first rule, JSON-boolean
   predicate, no-empty-pair rule, the stream counter rule; File Map rows for `store/stream`,
   `lib/stream`, `worker/stream-server.ts`; env vars `STREAM_ENABLED`, `STREAM_TOKEN_SECRET`,
   `NEXT_PUBLIC_STREAM_URL`), inventory §7/§8 (the P5.2 three-deploy runbook; the P5.1 runbook is
   there). Then the docs contract tests (`src/__tests__/docs`).
5. **Deploy-time (not code)** — inventory §8 runbooks: P5.1 two-step (migrations + code with
   `WEBHOOKS_ENABLED` unset → barrier → enable), P5.2 three-deploy (Vercel migrations + inert
   producers → Render worker → enable token minting + advertise URL), the `stream_seq` post-barrier
   reconciliation script then the NOT NULL contract script, the per-kind `shadow → on` flips for the
   b-1 kinds after a ≥3-day soak (`scripts/soak-shadow-report.sql`), and the still-open M11a runbooks
   (worker deploy order, `playground.round_opened` two-deploy, `agent_loop.action` shadow).
6. **Recorded follow-ups** (not in this milestone): `deleteAgent` refuses any agent with an
   `agent_rate_limits` row (pre-existing; consistent with the pristine-withdrawal policy; noted by
   lane D); the profile route still publishes a raw `last_active` timestamp (pre-existing; lane M);
   the `ux7` fixture pattern — memory `createPost` now refuses an unregistered author, so fixtures
   must seed agents; the DM owner-dashboard reader and the report endpoint (plan backlog).
7. **Final handoff rewrite** at the M11b code-complete stop, and the memory files.

## THE USER'S STANDING DIRECTIVES (verbatim intent — these govern how to work)

1. **Reporting style**: ALWAYS report to the user in ASD-STE100 Simplified Technical English
   (global rule, `~/.claude/CLAUDE.md`). Code, comments, commits and repo documents are exempt.
2. **Reviewer**: `codex` CLI (gpt-5.6-sol), `codex exec --sandbox read-only "$(cat <prompt>)"
   < /dev/null > <log> 2>&1`, one at a time.
3. **REVIEW EVERYTHING**: every unit gets at least one codex round; lock/atomicity/security-bearing
   units iterate to convergence. "Do not push shit code."
4. **KISS + minimize bloat + CRAP scores** (2026-09-08): "just remember KISS and CRAP scores. we need
   to minimize bloat." Complexity ≤ 12 per new function, comments ≤ 5 lines WHY-only, no new
   abstractions/options/dependencies, compact tests. Encoded in `b1-common-rules.md`.
5. **MAX PARALLELISM, sonnet + haiku** (2026-09-08): "Parallelize implementation. use sonnet and
   haikus to implement as fast as possible." Sonnet MANAGERS per lane spawn sonnet (statements/
   store/actions) and haiku (mechanical) subagents on DISJOINT file fences.
6. **Agent freshness / context kills**: managers stop at ~60% context with a handoff file; a fresh
   manager resumes from it. Subagents rotate at ~50%.
7. **Checkpoint commits**: the orchestrator owns ALL commits and re-verifies every claim with real
   runs before committing. Commit messages end with the Claude co-author line.
8. **Risk-split review depth**: full convergence for karma/lock/atomicity/security units; low-risk
   chunks (docs, adapters over settled actions, tooling, cleanup) get ONE round and stop unless
   BLOCKER/MAJOR.
9. **Stop instruction pattern**: at a natural stop, rewrite this handoff thoroughly — next steps,
   the user's instructions, and the harness/agent instructions in use (this file).
10. **COMMIT ONLY WITH CODE** (2026-09-08): ".md and docs update dont need their own commits." Specs,
    findings, fix specs, reports, docs deltas and handoffs ride the NEXT code commit. Saved as memory
    `commit-only-with-code.md`.
11. **"Do all three" (2026-09-08)** — the acceleration decision: (a) run wave b-2 in parallel with
    the b-1 review loop (b-2 touches the fix agents' files only behind the marker
    `b1-fixes-landed.md`); (b) give fix agents the RULE, not just the findings — the whole-fence
    audit; (c) cap the loop at no-MAJOR with a deferred-minors ledger. Recorded in
    `b1-convergence-policy.md`.
12. **Do not push** unless the user asks. Nothing from this session is pushed.

## THE ORCHESTRATION LOOP (what ran this session)

1. Orchestrator scopes the wave from the plan lines + a tree survey (never trust inventory
   checkboxes — lane C found P7.2/P7.3 already done), splits into lanes with DISJOINT FILE FENCES,
   writes `b1-common-rules.md` (shared rules, shared-file append protocol, report format) + one spec
   per lane, commits them WITH the next code change.
2. Spawn sonnet MANAGERS concurrently (`run_in_background: true` for the managers only). Each
   manager prompt: read the rules then the spec; spawn subagents with `run_in_background: false`;
   the hard rules; context discipline; report format; "final message ≤ 25 lines".
3. While lanes run: draft the next wave's specs and the codex prompts; update memory; nothing heavy
   in the repo.
4. As each lane reports: RE-VERIFY with real targeted runs (tsc, its jest paths, its integration
   file), then commit — scoped while other lanes run (an honest "lane X complete, lanes Y/Z WIP"
   checkpoint is fine when tsc is clean), full at the boundary.
5. Boundary: five gates (full integration backgrounded to a log file; build backgrounded), a STITCH
   agent for cross-lane suite failures (mocks lacking new store reads, registry ceilings, forbidden
   substrings, fixtures needing the new resolver), a DOCS agent applying every lane's recorded
   delta, then the boundary commit.
6. Codex rounds, STRICTLY SERIAL: one prompt per lane (`codex-b1-review-<lane>[-rN].md`: recap,
   what changed, gate results, focus list, known decisions do-not-re-flag, "ADJUDICATE the recorded
   deferrals explicitly", files-in-scope list, verdict line). Adjudicate findings against the pins
   BEFORE writing the fix spec (`b1-<lane>-fix-rN-spec.md`: one numbered item per accepted finding
   with the exact test; deferred items named with the pin). Fix agents (sonnet) run in PARALLEL, one
   per lane, on the disjoint fences; each writes `b1-<lane>-fix-rN-report.md` with mutation-check
   evidence verbatim. Orchestrator re-verifies, ONE commit per round carrying code + all markdown,
   stamps the commit hash into the next round's prompts, repeats.
7. Under directive 11 the b-2 lanes ran DURING codex rounds (the user accepted the crash risk; no
   codex run died this session).

## OPERATIONAL GUARDRAILS (each closed a real incident this session — follow them)

### Agents
- **THE WAIT-TRAP is the #1 incident class**: FOUR fix agents (W r3, M r4, W r4, and the first W r3)
  stranded themselves by ending their turn to "wait for the monitor" on a background jest/integration
  run — despite being told not to. **`SendMessage` is DISABLED in this session** (cannot wake them).
  Remedy that worked every time: `TaskStop` the stranded agent (to stop it re-waking and editing
  concurrently), spawn a gen-2 SUCCESSOR whose prompt says "your predecessor's work is ON DISK: run
  `git diff` on the fence, map every spec item to done/partial/not started, continue; never
  `run_in_background: true`, never the Monitor tool, never end a turn to wait — every test is a
  FOREGROUND Bash call with a long timeout". Put that sentence in EVERY fix-agent prompt.
- **Session rate limit** (hit once at 5:40 pm): all four running agents died mid-work with their
  partial edits on disk and tsc still clean. Remedy: wait for the reset, spawn gen-2 agents with the
  same "inventory the diff first" instruction. Every prompt now says "on a rate-limit error write
  `<lane>-handoff.md` with the exact disk state and stop".
- **Verify every claim with a real run.** Lane D's round-1 "F7 already satisfied" was rejected by
  codex two rounds later; lane W's round-3 "FOR SHARE mutation passed three times" was called
  "not evidence"; lane M's round-4 F1 had a documented `WHERE` gate that was never in the SQL until
  the successor checked. The orchestrator re-ran every lane's suites before every commit.
- Prompts to codex must say "do NOT run jest/tsc/build — the sandbox denies the temp writes"; state
  the gate results instead. Close stdin, capture to a file, extract the findings from the LAST
  `tokens used` line onward.

### Parallel-lane hygiene
- Disjoint fences per lane, spelled in the spec with an explicit do-not-touch list. Shared files
  (`kinds.ts`, `coverage.ts`, `store-types.ts`, the notifications consumer, the wakeup router,
  `store.ts`, `export-manifest.ts`, `migrate.js`, `migration-ledger.ts`, `agent-tools/index.ts`,
  `actions/types.ts`) are APPEND-ONLY at a lane's own anchor with re-read-before-edit; it held for
  four concurrent lanes with zero lost work.
- One function of one file can belong to another lane (R owned `deletePost` inside M's
  `posts/db.ts`) — say so in both specs.
- A store the whole wave depends on (the notifications inserts) is edited by ONE lane first, which
  writes a MARKER file when done (`b1-lane-w-wakeups-done.md`); the others wait on the marker for
  that file only. The same pattern gated b-2 behind `b1-fixes-landed.md`.
- Generated `.eslintrc.json`: lanes run `gen:boundary` at lane END only; the drift test arbitrates.
- Docs (`public/*.md`, `openapi.json`, `agents.md`, the inventory) are boundary-only: lanes record
  the exact delta text in their reports; one docs agent applies all of them.
- The tool registry ceiling (`registry.test.ts`) and the `houses-deleted` substring scan (no
  "house" even in a comment) are the two shared tests new lanes trip.

### Testing discipline
- **Mutation-check every behavioral fix**, and the report must show the FAILING run. A test whose
  mutation "passed three times" is restructured until it fails.
- Integration data: RUN-suffix every unique value; neutralize one-per-scope index orphans in
  `beforeAll`; clean up in `afterAll` (lane W swept 170 orphaned rows other runs had left).
- Race tests: hold the row on one connection, identify each contender's backend by pid
  (`pg_blocking_pids`, marker comments in the SQL, `pg_stat_activity`), release only after the
  dependency is observed, assert COMMITTED state never response order. Counting blocked queries is
  unsound (chained waiters, unrelated queries). `pg_advisory_xact_lock` barriers are unreliable
  through the Neon POOLER endpoint.
- Known-flake protocol: re-run the suite SOLO; twice-failing = real; record it in the next codex
  prompt for adjudication (the DM forward-direction race was adjudicated a test defect and fixed).
- Memory-mode tests must seed agents: `createPost`/`createComment`/`addReaction`/`sendDm` now refuse
  an unregistered actor (parity with the FKs).

### Design rules reinforced this session (add to `agents.md` in the docs pass)
- **Lock order is enforced by STATEMENT order inside a `sql.transaction`.** CTE declaration order
  guarantees nothing; a registration lock in the same statement as the ledger lock proves nothing.
- **The actor row comes first** (`SELECT … FROM agents WHERE id = $1 FOR KEY SHARE`) wherever a later
  insert's actor FK would take that lock, or withdrawal (which cascade-deletes the agent's rows)
  deadlocks with the write. Then posts → comments → agents; registration → ledger → wakeup.
- **`FOR SHARE`, not `FOR KEY SHARE`, for a liveness gate**: `FOR KEY SHARE` is compatible with the
  tombstone's `FOR NO KEY UPDATE` and never blocks it. And never `FOR SHARE` before an UPDATE of the
  same row (shared → exclusive upgrade deadlocks); take `FOR NO KEY UPDATE` from the start.
- **One row, one modification per statement**: two data-modifying CTEs on the same row silently lose
  one write (Postgres documents it); split into statements.
- **A refused write must leave NOTHING**: no empty pair row, no seeded rate row, no seq bump, no
  quota roll. Gate every statement of the transaction, or delete what an earlier statement created.
- **A statement's classification is projected, never re-read**; the hidden-agent predicate compares
  JSON booleans (`metadata->'test' = 'true'::jsonb`) in SQL exactly as the JS twin does.
- **Fence-loss discipline extends to non-terminal tools**: a refused `execution_guard_failed` from
  ANY tool ends the tick with no bookkeeping writers.
- **Payloads are id-only by construction** (an allowlist of id fields), never by filtering a copy.

## The adjudication ledger (pins that beat or bound reviewer proposals — do not re-litigate)

1–11. The M11a ledger stands (vetting ensure contract; merged refusal precedence; verbatim-only
idempotency; superseded dissolution; torn-state reissue; TA-emit; actionable-only admissions;
`createOrReArmWakeup` false/false; interim guard coverage — NOW NARROWED, see 13; drain duty takes
no shutdown signal — NOW NARROWED, see 14; exclusion-over-cursor).
12. **The plan's `none` wakeup channel is not materialized**: `resolveWakeupDelivery` answers
    `internal` | `webhook` | `null`; a row nobody consumes is bloat. Codex accepted it four rounds.
13. **New actions adopt the execution guard** (reactions, DMs did); ledger 9's interim covers only
    the older actions. Codex overturned the deferral with a concrete harm; the user's KISS rule did
    not outweigh a stale write.
14. **The drain pass forwards the worker's stop signal to its webhook pass** (round 2 MINOR); the
    drain's own receipt work still takes none.
15. **Mention wakeups may be enqueued from a pre-read** (M round-1 F2): the same shape as the
    converged `comment.created` router; a stale wakeup for deleted content is harmless under the
    runner contract. UPHELD by codex in rounds 2, 3 and 4 — do not propose an in-statement gate.
16. **`already_reacted` wins over `rate_limited`** when both hold (lane R refinement).
17. **The DM send is a multi-statement transaction** (ensure pair → lock+claim+insert → cleanup on
    refusal), mirroring `createComment`; codex upheld the structure and only ever refined its
    refusal effects.
18. **The recipient-only withdrawal test** for DMs stands (pristine-withdrawal policy: `deleteAgent`
    refuses any agent with an `agent_rate_limits` row, which is pre-existing and consistent).
19. **The DM forward-direction race flake was a TEST defect** (response order vs commit order);
    Postgres re-evaluates the locked row after the wait, there is no statement window.
20. **Serializer completeness**: reaction counts appear on the context feed and on news discussions
    too (codex overturned the "pure serializer / cached RSS" deferrals; both were cheap).

## Where everything lives

- Specs, rules, prompts, findings, fix specs, fix reports, lane reports, handoffs, policy:
  `ai/m11-2-handoff/` — `b1-common-rules.md`, `b1-convergence-policy.md`, `b1-deferred-minors.md`,
  `b1-lane-<w|m|r|d>-*-spec.md` + `-report.md`, `codex-b1-review-<lane>[-rN].md`,
  `codex-findings-b1-<lane>-roundN{.md,-raw.log}`, `b1-<lane>-fix-rN-{spec,report}.md`,
  `b2-lane-<s|c>-*-spec.md`, `-report.md`, `-handoff.md`, the two markers.
- Memory: `m11b-execution-state.md` (this milestone), `commit-only-with-code.md` (directive 10),
  `m11-2-execution-state.md` (M11a), `MEMORY.md` index.
- Invariants: `agents.md` (= `CLAUDE.md`) "Store and Migration Invariants" — read before touching any
  producer, consumer or statement; the "Design rules reinforced" section above is the pending delta.
- Inventory: `ai/validation/m11-inventory.md` — §7 rows for the seven b-1 kinds, §8 P5.1 runbook;
  the P5.2 runbook and the `stream_seq` reconciliation are the pending delta.
- Gates: `npx tsc --noEmit && npm run lint && npm test -- --runInBand && npm run test:integration &&
  npm run build`. Targeted while iterating; all five at boundaries; the orchestrator runs them itself
  before every commit and every review round.
