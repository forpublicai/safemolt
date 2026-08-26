# M11-2 execution handoff — stop point 2026-08-26: M11a CODE COMPLETE

Work on `ai/PLAN_M11_2.md` reached the end of M11a's code: every code phase (P1.5/P1.6, P4,
P3.2, P3.3, P3.1, P3.4) is implemented, codex-reviewed to convergence, and committed. This file
is the pickup point for the next session. Companion state lives in the orchestrator memory file
`~/.claude/projects/-Users-mohsin-Github-safemolt/memory/m11-2-execution-state.md`.

Branch: `ops/code-improve`. **NOTHING IS PUSHED** — do not push unless the user asks. The
orchestrator owns ALL git writes; implementation agents are forbidden from git.

## Verified state at the stop

- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors (pre-existing complexity warnings only).
- `npm test -- --runInBand` — **189 suites / 1842 tests, all green.**
- `npm run test:integration` — 53 suites / 698 tests; **one recorded flake** (see "Open items").
  An immediate solo re-run of the failing suite was 19/19 green.
- `npm run build` — green.

## Commit ladder this session (oldest first)

| Commit | What it holds |
|---|---|
| `360b844` | u3f-core B3 REVERSED per user decision: TA class messages emit again (in-statement role derivation under FOR SHARE) |
| `84bd3d9` | B3 codex round: "No findings. The change is correct." |
| `8491367` | u5 wave-1 lane specs (A boundary / B senses / C wakeups) |
| `41dfcfe` | u5 Lane A: P1.5/P1.6 boundary machinery (manifest 321 exports, generator, 4 tests, exemptions; 2 real pre-existing defects found by the boundary itself) |
| `79e5a77` | u5 Lane C gen-1 manager handoff + prepared subagent prompts (freshness rotation) |
| `18f808d` | u5 Lane C d1–3: wakeups migration (FK CASCADE both ways), `playground.round_opened` kind+manifests, wakeup store both modes |
| `5d5e8b6` | u5 Lane B: P4 senses library + `GET /agents/me/context` + loop/home rewire; `agent-opportunities.ts` deleted |
| `cf1db07` | u5 Lane C d4–6: wakeup-router consumer, round_opened producers (conditional round-1 write + advancement CAS + bridge + arming), race suites — **wave-1 boundary, all five gates green** |
| `20dd055` | u5-C codex r1 fix: the playground-round arm gate lives IN the statement (`createOrReArmPlaygroundRoundWakeup`, FOR SHARE live gate, both stores, mutation-checked both sides) |
| `e2ee255` | u5 A+B codex r1 fixes: comment-aware extractor; loop projects actionable admissions; home projects ONE `buildAgentContext` |
| `78a3299` | u5 convergence record — codex r2 clean on all three lanes |
| `7e69449` | u6 both lanes: P3.3 runner + P3.1 worker + P3.4 sweeps + idle scheduler (WIP checkpoint) |
| `128879d` | u6 stitch (orchestrator half): route de-dup (idle sweep + claim ran TWICE per tick), cooldown env tiers |
| `c58282f` | u6 stitch (agent half): playground execution guard, round-mismatch proof, `agent_loop.action` Tier-1 + shadow, wakeup retention, starvation suite |
| `933be02` | u6 codex round-1 findings + fix specs archived |
| `f5f622d` | u6-D codex r1 fix: the idle-path fence BLOCKER (PulseTickBundle into tickAgent) + fence-loss discipline |
| `e61ce57` | u6-E codex r1 fix: ShouldStop to every claim, three scan-starvation fixes, boot-time hash |
| `ca502ab` | u6-E codex r2 fix: two stale-signal windows, repair-path paging (deferral ADJUDICATED must-close), comment |
| `afb5a48` | u6-E codex r3 fix (orchestrator): re-check the signal AFTER the GM call — the longest window in the sweep |
| `acc9490` | **M11a CODE COMPLETE** — convergence record, final gates, the flake recorded honestly |

## Achieved (all codex-converged)

| Unit | Content | Review trail |
|---|---|---|
| P0–u4prep2, u3–u3f | events substrate, drain, consumers, all P1.1–P1.4 producers, drain-time soak | converged in prior sessions (see this file's git history for the earlier ladder) |
| u3f B3 | TA messages emit (user's product decision, reversing the spec's operator branch) | 1 round, clean |
| u5 Lane A | P1.5/P1.6: `export-manifest.ts`, `gen-eslint-boundary.js`, the generated `no-restricted-imports` block, AST/drift/completeness/mixed-actor tests, §10 exemptions | 1 MINOR (comment-token leak in the generator) → fixed → CONVERGED |
| u5 Lane B | P4.1–P4.3: `agent-senses/` (11 gatherers + `buildAgentContext(agentId,{focus})`, per-section `{items,degraded}`), the context endpoint, loop + home as projections of ONE context | 2 MAJOR (admissions never projected; home's parallel assembly) → fixed, mutation-proven → CONVERGED |
| u5 Lane C | P3.2: `agent_wakeups` + `pulse_budget_counters` migration, wakeup store both modes, wakeup-router consumer, notifications' `playground_round_open`, round_opened producers, a4 reconstruction bridge, sweep arming | 1 MAJOR (freshness pre-read TOCTOU → in-statement FOR SHARE gate) → fixed → r2 "CONVERGED, zero findings" |
| u6 part D | P3.3: the plan-verbatim claim CTE (budget atomic, one-result-row contract), token-fenced writes, `beforeTerminalTool`, the execution guard (comment-reply + playground-turn), reason-scoped context, `runAgentLoopBatch` degraded wrapper, `agent_loop.action` (Tier-1 `logAction`: journal insert + event + spliced activity projection in ONE statement; activity `shadow`) | r1 1 BLOCKER (idle path unfenced/unguarded) + 1 MAJOR (fence-loss wrote loop state) → r2 CONVERGED |
| u6 part E | P3.1/P3.4: `worker/index.ts` (ledger boot check, 4 duties, /healthz with boot-time hash, SIGTERM), `worker_locks` (verbatim upsert, fresh-UUID holder, no same-holder arm), `checkDeadlines` PRIVATE behind the locked entry (discipline test; 5 direct callers converted), due-ASC scans with in-query attempted-id exclusion, stop-signal at EVERY claim point in EVERY phase, retention incl. `pruneTerminalWakeups`, honesty meta, idle scheduler, `render.yaml`, env-tunability | r1 1B+4M+1m → r2 2B+1M+1NIT → r3 1B (re-check after the GM call) → r4 CONVERGED |

## Open items, in order

1. **Push** — the user's explicit call; 20 commits ahead of origin.
2. **The u3c flake**: `m11-2-u3c-groups.test.ts:454` ("leaves the two membership halves agreeing
   when subscribe races unsubscribe") failed ONCE in 698 (canonical row present, snapshot missing
   — the torn state the FOR-NO-KEY-UPDATE arbiter exists to prevent), clean 19/19 on solo re-run;
   first failure across every full run this milestone. A task chip is filed. Verdict needed:
   Neon-reset flake class vs a real narrow hole. Do not silently ignore it.
3. **Deploy-time (not code)** — the runbooks are inventory §8: shadow deploy → ≥3-day production
   soak (`scripts/soak-shadow-report.sql`; flip-clean = matched-only stamps + zero anomalies) →
   per-kind `shadow → on` → inline-writer deletion, each a fully-rolled-out deploy behind the
   consumer-contract-hash barrier. Specifics added this session: the P3.2 TWO-DEPLOY runbook for
   `playground.round_opened` (consumer coverage before producers — bundled, the fence classifies
   producer events as pre-activation and turns are permanently lost); `agent_loop.action` is a new
   `shadow` kind on the activity consumer; the P3.1 worker deploy order (Vercel migrations first,
   then the worker build; Render per `render.yaml`).
4. **M11b (P5/P6/P7)** — a separate plan, not started. Rough size: half to two-thirds of this
   session's work. b1 = P5.1 webhooks (the largest single unit — u3e-class review depth: SSRF,
   delivery ledger, terminal coupling, two-deploy rollout) + P5.2 SSE; b2 = P6.1 mentions + P6.2
   reactions; b3 = P6.3 DMs + P7 cleanup (the boundary allowlist shrinks to the permanent set).

## THE USER'S STANDING DIRECTIVES (verbatim intent — these govern how to work)

1. **Reporting style**: ALWAYS report to the user in ASD-STE100 Simplified Technical English
   (global rule, `~/.claude/CLAUDE.md`). Code, comments, commits and repo documents are exempt.
2. **Reviewer**: `codex` CLI (default gpt-5.6-sol),
   `codex exec --sandbox read-only "$(cat <prompt>)" < /dev/null`, output captured to a file.
3. **REVIEW EVERYTHING**: "dont forget to review work. use codex wherever appropriate. do not
   push shit code." Every unit gets at least one codex round before it is considered done;
   lock/atomicity/security-bearing units iterate to convergence.
4. **KISS**: "remember KISS!" — the simplest implementation that satisfies the plan's gates. No
   frameworks, no speculative abstraction, house patterns only. Encode it in every spec.
5. **MAX PARALLELISM (2026-08-26)**: "parallelize as much implementation as possible. spawn
   sonnet agents, that manage subagents. i want this entire milestone achieved fast." Sonnet
   MANAGER agents run concurrent lanes on disjoint file fences and spawn their own implementation
   subagents (opus for statement/store work, haiku for mechanical tasks).
6. **Agent freshness / context kills**: "make sure to kill agents that eat up 60-70% of their
   context and start new ones." Managers self-assess and STOP at ~60% with a complete handoff
   file; the orchestrator spawns a fresh manager from it. Same rule for subagents (never resume
   one past ~50–60%; fresh spawn with a self-contained handoff).
7. **Checkpoint commits**: the orchestrator owns ALL commits — one per green round boundary plus
   honest WIP checkpoints before/during parallel phases (scoped `git add` of one lane's files is
   fine while other lanes run). Commit messages end with the Claude co-author line.
8. **Risk-split review depth** (2026-08-05, still in force): full convergence for
   karma/lock/atomicity/security-bearing units; low-risk chunks (docs, adapters over settled
   actions, tooling) get ONE codex round and stop unless it finds a BLOCKER/MAJOR.
9. **Stop instruction pattern**: at a natural stop, rewrite this handoff.

## THE ORCHESTRATION LOOP (what converged two waves in one session)

1. Orchestrator scopes the wave: reads the plan lines, surveys the tree (never trust stale
   inventory checkboxes — verify imports), splits into lanes with DISJOINT FILE FENCES, writes
   one spec file per lane into `ai/m11-2-handoff/` (mission, deliverables, fences, gates,
   working rules, report format), and checkpoint-commits the specs.
2. Spawn sonnet MANAGERS concurrently (one per lane, `run_in_background: true` for the managers
   themselves). Each manager prompt: read the spec first; spawn subagents for heavy items; hard
   rules (no git, no codex, no full no-args integration, no build); context discipline; report
   format.
3. While lanes run: the orchestrator drafts the NEXT wave's specs and the codex prompts,
   updates memory, and does nothing heavy in the repo.
4. As each lane reports: the orchestrator RE-VERIFIES its claims (targeted gates), then makes a
   SCOPED commit of that lane's files only (other lanes' WIP stays uncommitted).
5. At the wave boundary (all lanes landed): full five gates — tsc, lint, full jest, FULL
   `npm run test:integration` (~28 min, backgrounded), build — then the boundary commit.
6. Codex rounds, STRICTLY SERIAL on a QUIET machine (no jest/build/agents running): scoped
   prompts per unit (A/B batched when low-risk), findings adjudicated against the pinned
   contracts BEFORE writing fix specs (reviewer proposals lose to pins — see the ledger), fixes
   via opus fix agents (or orchestrator repairs for small prescribed defects), mutation-check
   every behavioral fix, commit per round, re-review to a plain "CONVERGED".
7. Archive everything: prompts as `codex-u*-review-*.md`, findings as `codex-findings-*.md`,
   fix specs as `u*-fix-*-spec.md`, all committed.

## OPERATIONAL GUARDRAILS (each closed a real incident — follow them)

### Codex
- **Codex runs SOLO on a QUIET machine.** Parallel codex runs crash each other; codex died while
  an agent ran gates in the same repo. Reviews only when no lane executes.
- **Close stdin** (`< /dev/null`) on every codex launch; capture full output with `> file 2>&1`
  (a `| tail` in a background task DESTROYS the log; piped commands report the tail's exit code).
- Tell reviewers "do NOT run jest/tsc/build — the sandbox denies the temp writes and the attempt
  can kill your session"; state the gate results in the prompt instead.
- Rewrite each round's prompt: a "recap + what changed" section, the commit to `git show`, the
  focus list, and a "known, recorded decisions — do NOT re-flag" list (adjudicated pins get a
  do-not-re-litigate line). Ask codex to ADJUDICATE recorded deferrals explicitly — it overturned
  one correctly this session (the round-1-repair paging).

### Sonnet managers and subagents
- **THE WAIT-TRAP (this session's biggest lesson)**: a manager that ends its turn to "wait" for a
  background child is STRANDED — it receives nothing. MANDATE `run_in_background: false` in every
  manager prompt so subagent waits are synchronous. If a manager still strands, wake it via
  SendMessage with explicit disk-state instructions.
- An "orphaned" subagent (one a rotated manager could not stop) may COMPLETE INDEPENDENTLY and
  report later — when it does, immediately message the successor manager so it does not rebuild
  finished work. Fresh managers must check FILE MTIME QUIESCENCE before touching files a possibly
  live predecessor child might still edit.
- Manager rotation: handoff file → fresh manager whose prompt names the handoff as its first
  read. Commit gen-N handoffs (they are archive material).
- A stalled subagent (600 s watchdog) dies with its partial work ON DISK — the manager inventories
  disk state and spawns a fresh one for the remainder; never re-runs from scratch blindly.
- Verify manager/agent claims yourself: every lane report is re-verified with real gate runs
  before its commit (the luna precedent: gate claims were stale four separate times).

### Parallel-lane hygiene
- Disjoint file fences per lane, spelled in the spec, with an explicit "do not touch" list naming
  the OTHER lanes' fences. Out-of-fence needs are RECORDED in the report, not acted on (one
  justified exception this session: auth.ts's one-line allowlist — demanded by the plan itself).
- **Generated files are collision points**: two lanes regenerating `.eslintrc.json` silently
  overwrote each other once — the drift test caught it. Rule: lanes may append manifest names at
  their own anchor and regenerate at lane END; the orchestrator regenerates once at the boundary;
  the drift test arbitrates.
- `src/lib/store/export-manifest.ts` is the designed merge point: a new store export from any
  lane trips `boundary-manifest-completeness` BY NAME at the boundary — classify it (mutating
  list, or a read prefix) and `npm run gen:boundary`. Constants/pure builders go in the mutating
  list per the documented default-deny (no third bucket).
- Cross-lane dependencies: sequence the dependent duty LAST in its lane; the lane checks disk
  when it arrives (this session: Lane E wired Lane D's runner live when it landed mid-lane) or
  leaves ONE marked stub hook. Shared naming collides in real time — coordinate renames through
  the orchestrator (`runPulseHousekeeping` tripped the houses-deleted scan on the `house`
  substring; renamed `runPulseMaintenance`).
- agents.md/CLAUDE.md and `ai/validation/m11-inventory.md` edits are ORCHESTRATOR-ONLY during
  parallel waves; lanes record their deltas in reports.

### Testing discipline
- **Mutation-check every behavioral fix**: suppress the fix → watch the specific test fail with
  the forbidden behavior observed → restore → green. Record the evidence VERBATIM in the report
  and the commit. Orchestrator repairs get the same treatment.
- Integration data on the reserved DB: RUN-suffix every fixture value under UNIQUE columns;
  neutralize one-per-scope index orphans in beforeAll (`idx_pg_sessions_one_live_per_school`,
  `idx_wakeups_dedup_idle`, `idx_wakeups_one_inflight`, and now the DUE SET for ordered
  global-limit scans — a foreign leftover lands inside the page under test); drain-heavy suites
  pay the cross-run backlog once in beforeAll.
- The advisory lock serializes integration runs across lanes — WAIT, never kill a holder. Full
  integration (~28 min) is orchestrator-only, at boundaries, backgrounded with the log to a file.
- Known flake protocol: re-run the failing suite SOLO before diagnosing (Neon resets
  intermittently). A first-ever failure of a converged race test gets recorded + a filed
  investigation, never silently ignored (the u3c item above).
- Memory-mode test discovery this session: the in-process dispatcher fires consumers
  synchronously on emit, so a test isolating a SWEEP's own writes must clear/step around what the
  consumer already produced from the same event.

### Design guardrails reinforced by this session's findings (the classes codex keeps catching)
- **A freshness/eligibility check separated from its write by an await is a TOCTOU** — gate INSIDE
  the statement, `FOR SHARE` on the row the racing writer updates (never a bare EXISTS). The u5-C
  arm gate and the u6 execution guard are the templates.
- **A "stop claiming" signal (lock loss, SIGTERM) must be re-checked immediately before EVERY
  claim/write, in EVERY phase — and again after every long await** (the GM call was the longest
  window in the sweep). A conditional write's predicate protects against a racing WRITER, not
  against this worker acting under a lost lock.
- **Fence-loss ends a tick with NOTHING further written under lost ownership**: one token-fenced
  completion attempt, then return — no loop-state/bookkeeping writers.
- **Any bounded scan whose failed items stay in the set is a starvation bug**: oldest-first,
  due-eligible predicates, in-query attempted-id exclusion (`AND id <> ALL($ids)`) with page ×
  max-pages budgets. Keyset cursors on ms-ISO strings re-read µs rows — exclusion beats cursor
  here.
- **Transitional projections ride the emitting statement as CTEs** (the u4prep2 rule held for
  `agent_loop.action`); duplicated projection definitions read as soak mismatches — delete the
  old writer in the same change.

## The adjudication ledger (pins that beat or bound reviewer proposals — do not re-litigate)

1–5. The u3e/u4prep2 ledger from the prior stop (vetting ensure contract; merged refusal
precedence; verbatim-only idempotency; superseded dissolution; torn-state reissue) — all stand.
6. **TA-emit (B3)**: the user chose it over the spec's operator branch; codex-clean. Do not
   propose re-silencing.
7. **Actionable-only admissions projection**: the loop prompt renders admissions ONLY when
   next_action exists or the agent is not fully admitted (prompt-cost narrowing, orchestrator
   adjudication on codex's fix proposal).
8. **`createOrReArmWakeup`'s false/false race outcome** is legitimate (exactly one row exists);
   no arbiter — do not add FOR UPDATE for a reporting gap.
9. **Recorded interim guard coverage**: the statement-level execution guard reaches the two wired
   actions (create_comment, submit_playground_action); every other runner-reachable terminal tool
   sits behind the lease fence alone — documented in the runner header; extend per-action when
   those actions gain guard parameters, do not re-flag the interim.
10. **The drain duty takes no shutdown signal** (receipt-bounded, budget-bounded) — codex
    adjudicated acceptable.
11. **Exclusion-over-cursor** for the sweep paging (ms-ISO vs µs precision) — codex confirmed
    sound.

## Where everything lives

- Specs, review prompts, findings, fix specs, manager handoffs: `ai/m11-2-handoff/` (the u5 trail
  is `u5-lane-*`, `codex-u5-*`, `codex-findings-u5-round1.md`; the u6 trail is `u6-lane-*`,
  `u6-stitch-spec.md`, `u6-*-fix-*`, `codex-u6-*`, `codex-findings-u6-round1.md`).
- Invariants: `CLAUDE.md` (= agents.md) "Store and Migration Invariants" — read before touching
  any producer, consumer, or statement. NOTE: agents.md has NOT yet absorbed this wave's new
  facts (the wakeup queue module, the worker & pulse section P3.1's docs delta names, the P3.2
  runbook pointer) — a documentation pass is a small open item for the next session.
- Inventory: `ai/validation/m11-inventory.md` — §7 rows updated for `playground.round_opened` and
  `agent_loop.action`; §8 gained the P3.2 two-deploy runbook; §10 exemptions current.
- Gates: `npx tsc --noEmit && npm run lint && npm test -- --runInBand && npm run test:integration
  && npm run build`. Targeted while iterating; all five at boundaries; the orchestrator runs them
  itself before every commit and every review round.
