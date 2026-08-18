# M11-2 execution handoff — stop point 2026-08-13

Work on `ai/PLAN_M11_2.md` stopped deliberately at a clean break, by user instruction, immediately
after both u3f implementation lanes landed and the tree returned to green. This file is the pickup
point for the next agent. Companion state lives in the orchestrator memory file
`~/.claude/projects/-Users-mohsin-Github-safemolt/memory/m11-2-execution-state.md`.

Branch: `ops/code-improve`. The tree is **COMMITTED** — checkpoint commits are ON (see the user
directives below; this reversed the old no-commit instruction on 2026-08-12). Nothing is pushed;
do not push unless the user asks. Commit ladder this session, oldest first:

| Commit | What it holds |
|---|---|
| `7efa80d` | Baseline WIP checkpoint: all M11-2 work to that point (231 files) |
| `6e2c93e` | u3e codex r7 closure (luna r9 + orchestrator statement repairs) |
| `fbe7093` | u4prep2 [A] round (superseded stamps, locked twin subjects, exact-kind attribution) |
| `20a8531` | u3e codex r8 closure (luna r10; ensure-pin adjudication) |
| `b1e9910` | u3e codex r9 closure (luna r11 + challenge-lock projection repair) |
| `a230fe4` | u3e codex r10 closure (luna r12 + precedence-merge and backlog-drain repairs) |
| `e9a4d06` | u3e codex r11 closure (luna r13 + verbatim-idempotency adjudication) |
| `f6b80ac` | u4prep2 round 2: statement-atomic follow/group-join projections |
| `34c53c6` | u4prep2 follow-label parity repair |
| `ac7c901` | u3e tests-only evidence round (production frozen) |
| `a2585c5` | u3f: the eleven kinds + none-manifests pre-landed |
| `682e40a` | u3f: both lanes' implementation + the UX6 re-anchor |
| `bc1dcb1` | u3f-LITE review round 1 closed (avatar statement-return race + 429/503 pins + rollback coverage) |
| `30acf36` | u3f-CORE review round 1 closed (3 BLOCKER + 7 MAJOR) |
| `a06175d` | u3f-CORE review round 2 closed (4 MAJOR) |
| `c0b2f9b` | u3f-CORE review round 3 closed (enroll-cap race proof strengthened) — **u3f CONVERGED (codex r4 clean)** |

## Verified state at the break

- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors (pre-existing complexity warnings only).
- `npm test -- --runInBand` — 160 suites / **1518 tests, all green**.
- `npm run test:integration` — 43 suites / **565 tests, all green** (the combined u3f tree).
- `npm run build` — green.

## THE USER'S STANDING DIRECTIVES (verbatim intent — these govern how to work)

1. **Reporting style**: ALWAYS report to the user in ASD-STE100 Simplified Technical English
   (global rule, `~/.claude/CLAUDE.md`). Code, comments, commits and repo documents are exempt.
2. **Reviewer**: `codex` CLI is the review agent (default model gpt-5.6-sol),
   `codex exec --sandbox read-only "$(cat <prompt>)" < /dev/null`.
3. **Implementer**: "gpt luna" = `codex exec -m gpt-5.6-luna --sandbox workspace-write
   -c sandbox_workspace_write.network_access=true "$(cat <prompt>)" < /dev/null` (without the
   network flag the sandbox blocks Neon DNS and every DB gate fails ENOTFOUND).
4. **Subagent models** (2026-08-12): haiku/sonnet for simple mechanical tasks (extraction, doc
   sweeps), **opus for implementation subagents**; the orchestrator is the main agent.
5. **Acceleration items 1–6, all adopted** (2026-08-12): (1) harness subagents as a second
   implementation lane; (2) specs written during wait time; (3) batched convergence reviews;
   (4) targeted gates while iterating, full five gates at round boundaries only; (5) u3f
   risk-split (low-risk parts get ONE codex round, stop unless BLOCKER/MAJOR); (6) **checkpoint
   commits** — the orchestrator owns ALL commits, one per green round boundary plus honest WIP
   checkpoints before parallel phases; agents are forbidden from git writes; commit messages end
   with the Claude co-author line.
6. **Agent freshness** (2026-08-05): past ~50–60% of an agent's context budget, hand the next
   round to a FRESH agent with a self-contained spec.
7. **Fewer review rounds on low-risk chunks** (2026-08-05): full convergence only for
   karma/lock/atomicity-bearing units.
8. **Stop instruction** (2026-08-13): stop at a natural point, write this handoff.

## Operational rules learned this session (follow them; each closed a real incident)

- **Codex runs SOLO on a QUIET machine.** Parallel `codex exec` runs crash each other, and two
  codex-sol review sessions died silently (exit 1, no final message) while an opus harness agent
  ran gates in the same repo. Reviews only when no other lane executes. One exception proved
  survivable: a luna implementation run and an opus agent ran concurrently ONCE (the u3f lanes)
  with disjoint fences and both completed — but treat that as tolerated, not guaranteed.
- **Close stdin on every codex launch** (`< /dev/null`): codex 0.147 reads "additional input from
  stdin" and one background session had stale prompt text appended as a second user message.
- **Luna's gate claims require orchestrator re-verification, every round.** Luna reported complete
  or passing gates four separate times when its runs were stale, interrupted, or never re-run
  after a last-minute edit. The orchestrator runs the full five gates itself before every commit
  and every review round. Also tell reviewers "do NOT run jest/build" (their sandbox denies the
  temp writes and the attempt can kill the session).
- **Piped shell commands report the pipe tail's exit code**, and `cmd | tail` in a background task
  DESTROYS the log — capture full output with `> file 2>&1` and grep the file.
- **Integration test data must be run-unique, and singletons need orphan cleanup.** The reserved
  integration DB persists rows AND cursors across runs. Two failure classes: (a) fixed values
  under UNIQUE columns collide with prior runs (RUN-suffix everything — the u3e nonce precedent);
  (b) one-per-scope partial unique indexes (`idx_pg_sessions_one_live_per_school`) ignore ids
  entirely — an interrupted run's skipped afterAll leaves an orphan that blocks all later seeds,
  so suites neutralize orphans in beforeAll (the u3d precedent). Also (c): the events table grows
  across runs and the drain-time comparison prices each drained event at several round-trips, so
  drain-heavy suites pay the cross-suite backlog once in beforeAll (the u3c precedent).
- Known integration flake: `c13a` — re-run before concluding. Neon intermittently resets
  connections — probe and retry before diagnosing. The advisory lock serializes runs — wait,
  never kill; a dead holder's lock frees when its connection dies.
- `claude -p` is broken (expired OAuth); the user must run `claude login`. Use harness subagents.

## Achieved (everything below is codex-converged unless marked)

| Unit | Content | State |
|---|---|---|
| P0 | inventory (`ai/validation/m11-inventory.md`), baseline, tick-log instrumentation | done |
| u1 | P1.0 events substrate + P2.2 drain/cursor/receipt/retry + `internal/events-drain` | converged |
| u2 | P2.1 three consumers + kind union + manifests + shadow machinery | converged |
| u3 | P1.1 posts producer | converged |
| u3b | P1.2 comments/votes/follows | converged |
| u3c | P1.3 groups | converged |
| u3d | P1.4 playground slice | **converged 2026-08-13** (combined convergence round, clean verdict) |
| u4prep2 | drain-time shadow comparison | **converged 2026-08-13** ("No findings"). Final design: every transitional projection is STATEMENT-ATOMIC with its event (follow + group-join were the last two spliced), which is what makes the `superseded` stamp safe without an evidence ledger |
| u3e | P1.4 evaluations + agent lifecycle | **fully converged 2026-08-13** after 12 scoped review rounds + 13 luna fix rounds + 5 orchestrator repairs + 1 tests-only opus round ("the u3e review is complete with zero production defects"). Full trail + all findings files in `ai/m11-2-handoff/` |
| u3f | P1.4 last slice: classes, memory, profile, admissions, inbox | **CONVERGED 2026-08-18** — LITE one round (3 MAJOR); CORE r1 (3 BLOCKER + 7 MAJOR) → r2 (4 MAJOR) → r3 (1 test-proof gap) → r4 CLEAN "CONVERGED". Two opus lanes per round on disjoint fences (admissions/classes). Full findings + adjudication in `ai/m11-2-handoff/codex-findings-u3f-*.md` |

## u3f state at the stop (implemented on disk, committed, unreviewed)

Two concurrent lanes, disjoint fences, kinds pre-landed at `a2585c5` (all eleven history-only,
`none` in every manifest — no shadow protocol exists for this slice; spec:
`ai/m11-2-handoff/u3f-spec.md`).

**Core lane (luna; prompt `luna-u3f-core-prompt.md`; log in the 2026-08-13 session scratchpad):**
`src/lib/actions/classes.ts` + `src/lib/actions/admissions.ts` + `src/lib/class-ops/index.ts`
(NEW); event-coupled enroll/drop/session-message/evaluation-result writes; class routes + four
class tools are adapters; the mixed-actor messages route split (agent branch → action, professor →
class-ops); the classes/[id] GET YAML re-sync moved behind class-ops (inventory §4 records the
decision); admissions application/accept/decline through actions with events joining the existing
batches (agent-first FOR KEY SHARE preserved); the offer-expiry sweep joined the drain route's
housekeeping (db) with the read path removed, memory keeping the read-path driver through one
shared entry point.

**Lite lane (opus subagent; full report in its completion notification, summarized):**
`src/lib/actions/{profile,inbox,memory}.ts` (NEW); `updateAgentProfile` — ONE conditional
statement moving description/display-name/metadata with `payload.fields` from the statement's own
diff CTE (the old two-write half-apply is gone); avatar writes conditional (`IS DISTINCT FROM`);
unconditional reserved-key rule checked on the delta; inbox read-state + raw vectors as Tier B
actions (no events); memory-context write/delete Tier 1 with events in-statement
(`context-store-db` now takes prepared events — a recorded fence deviation); the IDENTITY.md GET
backfill invokes the write action with `lazy: true`; `markChallengeFetched` absorbed as a Tier-B
action (it was NOT done in u3e — verified); 58 characterization pins; 10 mutation checks.
Recorded deviations worth knowing at review: `types.ts` gained `reservedKeys?: string[]` on the
refusal arm; `vector_unavailable` rides `bad_request` with a `reason`; `update_my_profile`
deliberately gained no metadata parameter (pinned); three callers still write `agent_context_files`
event-less (u3e's vetting surface + two outside the Surface bound — inventory §3d/§8).

**Orchestrator stitch:** the one cross-lane casualty was `ux6-contracts › submits a class
evaluation by class slug` — re-anchored to the new store signature (the call now carries the
prepared `class.evaluation_submitted` event; both lanes independently flagged it).

## Next steps, in order

0. **u3f review — DONE, CONVERGED 2026-08-18** (was step 1). LITE one codex round (3 MAJOR fixed,
   `bc1dcb1`); CORE four rounds — r1 3 BLOCKER + 7 MAJOR (`30acf36`), r2 4 MAJOR (`a06175d`), r3 one
   test-proof gap (`c0b2f9b`), r4 clean "CONVERGED". The loop that worked this session: two OPUS
   harness subagents per round on disjoint fences (admissions / classes), orchestrator re-verifies
   the FULL five gates itself, checkpoint commit per green boundary, codex re-review to convergence.
   Reviewer prompts + findings + fix specs archived as `ai/m11-2-handoff/codex-u3f-review-*.md`,
   `codex-findings-u3f-*.md`, `u3f-core-fix-*-prompt.md`. **One product decision left open for the
   user (finding B3): agent teaching-assistant class messages are now history-silent per the
   u3f-spec's professor/TA operator branch — reversible in the messages route + `sendSessionMessage`
   action if the user wants TA messages to keep emitting.** THE NEXT STEP IS NOW P1.5/P1.6.
2. **P1.5 / P1.6** — remaining tools/routes become adapters everywhere; the generated ESLint
   boundary + `src/lib/store/export-manifest.ts` + AST discipline test + manifest-completeness
   test; the permanent exemption list per the Surface bound (the about-timeline reaction route and
   the operator surfaces are named exemptions — plan §Surface bound).
3. **a3 = P4** (senses), **a4 = P3** (worker + wakeups, internally P3.2 → P3.3 → P3.1 → P3.4);
   then M11b (P5/P6/P7) — a separate plan.
4. **Deploy-time (not code)**: deploy the shadow state, run the ≥3-day production soak
   (`scripts/soak-shadow-report.sql`; flip-clean = matched-only stamps + zero anomalies,
   `superseded` counts toward neither side, ingest rows are `unverifiable`), then per-kind
   `shadow → on` → inline-writer deletion, each a separate fully-rolled-out deploy behind the
   consumer-contract-hash barrier (inventory §8 protocols). The u3f kinds need NONE of this —
   they are history-only with no legacy writers.

## The adjudication ledger — pins that BEAT reviewer proposals (do not let a future round re-litigate)

1. **The vetting ensure contract** (r8): every caller with a VALID unconsumed challenge gets
   `completed` — consume + bootstrap ensure + recompute — even when already vetted; only the
   `is_vetted` flip and `agent.vetted` gate on the winning unvetted decision. r8b's proposal to
   reclassify the losing concurrent completion as a refusal was REJECTED.
2. **The merged refusal precedence** (r10 repair): `mismatch` first — a FOREIGN challenge never
   succeeds; a vetted agent's OWN dead-or-absent challenge answers `already_vetted`; only an
   UNVETTED agent sees `consumed`/`expired`. Both stores identical. (Codex r10a-4's rule as
   written broke the same-challenge race and c14's lost-response retry.)
3. **Verbatim-only idempotency** (r11 repair): the hash identifies the request, so the idempotent
   already-vetted success covers only a retry presenting the SAME valid proof; a wrong or absent
   hash refuses in every challenge state (live `invalid_hash` 400, consumed `consumed_challenge`
   410 — c14-pinned, expired `expired_challenge` 410). Codex r11b-1's decisive-only classification
   was too broad.
4. **The superseded dissolution** (u4prep2 round 2): no (event_id, effect_key) evidence ledger.
   Every transitional projection is statement-atomic with its event, so a committed event PROVES
   its inline write committed, and `superseded` can only mean a later event rewrote the reusable
   key. Recorded in inventory §8 + the soak report header.
5. **The torn-state reissue** (r9 repair): an `in_progress` certification registration whose only
   jobs are dead `expired` rows deliberately gets a fresh job — that state is unreachable through
   the new statement-atomic path and reissuing is B1's permanent-block cure. The held-lock race
   test plants the winner's FULL state (status + job) for exactly this reason.

## How to work (the loop that converged four units this session)

Orchestrator writes a scoped spec/prompt → implementation agent executes (luna via codex CLI for
store/statement work; opus harness subagent for parallel or tests-only lanes; characterization
first; mutation-check every behavioral fix: failing test first, watch it fail, fix — or
inverted-assertion evidence when production is frozen) → orchestrator RE-VERIFIES the five gates
itself → checkpoint commit → `codex exec --sandbox read-only` reviews fresh, scoped A/B when the
unit is big, findings saved to `ai/m11-2-handoff/codex-findings-<unit>-round<N>.md` → the
orchestrator ADJUDICATES findings against the pinned contracts before writing the fix prompt
(reviewer proposals lose to pins — see the ledger) → repeat until a clean verdict. Small
prescribed defects (a missing join, a wrong projection, test-data hygiene) are orchestrator
repairs, not full rounds. Review prompts get their "Recent (this round's subject)" section
rewritten every round; adjudicated pins get a "do not re-flag" line.

Gates: `npx tsc --noEmit && npm run lint && npm test -- --runInBand && npm run test:integration
&& npm run build`. Full integration ≈ 28 minutes. Targeted while iterating; all five at
boundaries.

## Where everything lives

- Specs + review prompts + findings, every unit: `ai/m11-2-handoff/` (this directory is the
  archive; the u3e trail alone is rounds 1–12 with prompts r1–r13).
- The u3f spec: `ai/m11-2-handoff/u3f-spec.md`; core-lane prompt `luna-u3f-core-prompt.md`;
  the lite-lane prompt is embedded in the 2026-08-13 session (its content is summarized in the
  u3f state section above — reconstruct from the spec's items 1–4 if needed).
- Invariants: `agents.md` (= CLAUDE.md) "Store and Migration Invariants" — grew across
  u3b–u4prep2; read before touching any producer or consumer.
- Inventory: `ai/validation/m11-inventory.md` (per-route/tool/kind rows, §8 rollout protocols,
  the u3f runbook notes both lanes appended).
- Session scratchpad logs (luna runs, codex runs, gate logs): `/private/tmp/claude-501/...` per
  session — ephemeral; the durable copies are the findings files in `ai/m11-2-handoff/`.
