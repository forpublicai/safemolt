# M11-2 execution handoff — status at the 2026-08-05 break

Work on `ai/PLAN_M11_2.md` stopped deliberately at a clean break. This file is the pickup point for
the next agent. The whole tree is **uncommitted on `ops/code-improve`** (HEAD `a7f4cd3`) by user
instruction — do not commit until asked. Companion state also lives in the orchestrator memory file
`~/.claude/projects/-Users-mohsin-Github-safemolt/memory/m11-2-execution-state.md`.

## Verified state at the break

- `npx tsc --noEmit` — clean.
- `npm test -- --runInBand` — 157 suites / **1419 tests, all green** (2026-08-12, post luna r8b + nonce fix).
- `npm run lint` — 0 errors (pre-existing complexity warnings only).
- `npm run test:integration` — 42 suites / **549 green** (2026-08-12). `npm run build` — green.
- Note: the u3e integration suite's certification nonces are RUN-suffixed now — `certification_jobs.nonce` is UNIQUE and the reserved DB keeps rows across runs.
- The M11 migrations including `scripts/migrate-m11-shadow-compare.sql` are applied to the dev and
  integration databases.

## Achieved (all codex-converged unless noted)

| Unit | Content | Review state |
|---|---|---|
| P0 | inventory (`ai/validation/m11-inventory.md`), baseline, tick-log instrumentation | done |
| u1 | P1.0 events substrate + P2.2 drain/cursor/receipt/retry + `internal/events-drain` | converged (6 rounds, prior session) |
| u2 | P2.1 three consumers + kind union + manifests + shadow machinery | converged (10 rounds, prior session) |
| u3 | P1.1 posts producer | converged (6 rounds, prior session) |
| u3b | P1.2 comments/votes/follows | **converged this session** (4 rounds → clean; daily-cap 429 gained `retry_after_seconds`; `created_at` joined the notification soak projection) |
| u3c | P1.3 groups | **converged this session** (7 rounds → clean; security fix: settings tool had no ownership check; subscription snapshot sidecar; founder-wins centralization) |
| u4-prep | shadow-soak verification | **pivoted** after 6 non-converging rounds: comparison now stamps at DRAIN time (`legacy_match`/`legacy_detail` on `event_consumer_shadow`, written by the dispatcher; `src/lib/events/consumers/legacy-compare.ts`); `scripts/soak-shadow-report.sql` is a ~300-line stamp aggregator. **Three [A] findings still open — see next steps** |
| u3d | P1.4 playground slice (7 kinds, join/submit/cancel/create/expiry/cap producers) | round 1 done + its 3 [B] findings **fixed** (transitional projections spliced into the emitting statements with trigger-injection proof; lifetime-cap starvation fixed; JSON-null route guard). **Convergence round not yet run** |
| u3e | P1.4 evaluations + agent-lifecycle slice | **in full codex rounds** (karma-bearing). Trail: r1 (2B+4M+1m) → r2 (2B+3M+1m) → r3 (4M+1m) → r4 (1B+2M) → r5 crashed 4× → scoped store-A/actions-B split → r5a/b (9M+2m) → r6a/b (2B+8M) → luna r8+r8b → r7a/b (3B+7M+1m) → luna r9 + orchestrator repairs (commit `6e2c93e`) → r8a/b (2B+6M+1m; adjudication: the pinned ensure contract beats r8b-5's refusal reclassification) → luna r10 (commit `20a8531`, all five gates green, 42/553 integration) → r9a/b (1B+8M+2m) → luna r11 + one orchestrator repair (the vetting batch's challenge lock projected only `id`, so the classifier's consumed/expired arms were unreachable; commit `b1e9910`, gates green 42/553 after repair) → **r10a/b (1B+7M+2m+1N)** — the blocker is NEW machinery: the in-place nonce refresh is not fenced against a transcript submission authorized by the old nonce; plus the `live` job needs a locking read, raced-23505 registration classification, db refusal-precedence parity, and four test-evidence MAJORs → luna r12 in flight (`luna-u3e-fix-round12-prompt.md`). Production defects are narrowing to the newest arms; r10b found no production blocker at all |

Standing user directives (recorded in memory): **fewer review rounds on low-risk chunks** (full
convergence only for karma/lock/atomicity-bearing units); **agent freshness** (past ~50–60% of an
agent's context budget, hand the next round to a fresh agent with a self-contained spec).

## Next steps, in order

1. **Converge u3e.** Luna r9 is fixing codex r7's 3 BLOCKER + 7 MAJOR + 1 MINOR (findings:
   `codex-findings-u3e-round7{a,b}-*.md`; prompt: `luna-u3e-fix-round9-prompt.md`). After its five
   gates pass, run codex r8 with the two scoped prompts (`codex-u3e-review-{a,b}.md` — rewrite their
   "Recent (this round's subject)" sections first), SOLO and sequentially: parallel codex runs crash
   each other, and luna is also a codex run. Iterate to convergence — u3e is karma-bearing.
   `karma-writer-ownership.test.ts`'s enumerated inventory must stay unchanged.
2. **Execute the open u4prep2 fix round** — spec: `ai/m11-2-handoff/u4prep2-fix-round.md`; findings
   text: `ai/m11-2-handoff/codex-findings-u3d-u4prep2-round1.md` ([A]1 superseded stamp for reused
   keys, [A]3 locked twin lookups → `unverifiable`, [A]5 kind_map exact-kind attribution). The
   stopped agent had made **no edits** — start clean.
3. **Convergence rounds**: one combined codex round over u3d(+fixes) and u4prep2(+fixes); iterate
   only on BLOCKER/MAJOR per the low-risk directive.
4. **u3f — the last P1.4 slice**: classes enroll/drop + the mixed-actor session-message split
   (`src/lib/class-ops/*` operator entry), memory-context writes (Tier 1) and raw-vector routes
   (Tier B), profile update + avatar + the reserved-key allowlist (unconditional — D1 superseded),
   admissions transitions + the offer-expiry housekeeping move to the drain route, inbox read-state
   (Tier B). Write the spec from `ai/PLAN_M11_2.md` P1.4's table + inventory §3c/§3d/§4.
5. **P1.5 / P1.6** — tools and routes become adapters everywhere; the generated ESLint boundary +
   AST discipline test + manifest-completeness test; the permanent exemption list per the Surface
   bound.
6. **a3 = P4** (senses), **a4 = P3** (worker + wakeups, internally P3.2 → P3.3 → P3.1 → P3.4);
   then M11b (P5/P6/P7).
7. **Deploy-time (not code)**: deploy the shadow state, run the ≥3-day production soak
   (`scripts/soak-shadow-report.sql` is the operator report; flip-clean = matched-only stamps and
   zero anomalies, ingest rows are `unverifiable` and never count as passing), then per-kind
   `shadow → on` (dual-write) → inline-writer deletion, each a separate fully-rolled-out deploy
   behind the consumer-contract-hash barrier (inventory §8 protocols).

## Working rules added 2026-08-12 (user-directed acceleration)

1. **Checkpoint commits are ON.** The no-commit instruction is lifted. Policy: the orchestrator
   owns ALL commits; implementation agents and luna stay forbidden from git writes. One commit per
   green round boundary ("<unit>: codex r<N> fixes — gates green"), plus a WIP checkpoint before
   any parallel-agent phase (state the known-red gates honestly in the body). First checkpoint:
   `7efa80d`. Do not push unless the user asks.
2. **Two implementation lanes.** The codex CLI (luna + reviews) is ONE serial lane — parallel codex
   runs crash each other. Harness subagents are the second lane: opus for implementation rounds,
   sonnet/haiku for mechanical work (extraction, doc updates, log parsing). Lanes only run
   concurrently on disjoint file fences.
3. **Targeted gates while iterating; full gates at round boundaries.** During a fix round, agents
   run only the affected suites. The full five gates run once before each codex review and before
   each checkpoint commit. The full integration suite (~28 min) serializes on the advisory lock —
   concurrent runs queue; wait, never kill.
4. **Batched convergence.** u3d + u4prep2 share one combined codex convergence round.
5. **u3f is risk-split** (standing low-risk directive): profile/inbox/read-state get ONE codex
   round and stop unless BLOCKER/MAJOR; classes/admissions/memory-context get full rounds only
   where lock/atomicity-bearing.
6. **Codex needs a quiet machine.** Two codex r8 launches died silently (exit 1, no final message,
   different depths) while an opus harness agent was running gates and edits in the same repo; one
   also saw the codebase-memory MCP time out repeatedly (codex falls back to git reads — that alone
   is not fatal). Run codex only when no other agent lane is executing. Keep `< /dev/null` on every
   codex launch anyway: one background session had stale prompt text appended from stdin as a
   second user message.
7. **Test data must be run-unique.** The reserved integration DB keeps rows across runs; every
   fixed identifier a test inserts under a UNIQUE constraint must carry the suite's `RUN` suffix
   (the u3e nonce collision is the precedent).

## How to work (the pattern that converged five units)

Orchestrator writes a spec → an implementation agent executes it (characterization first,
mutation-check every behavioral fix: test first, watch it fail, fix) → `codex exec --sandbox
read-only "$(cat <review-prompt>)"` reviews fresh each round, no reference to prior rounds → fix
rounds until clean (full rounds only for karma/lock/atomicity surfaces). Gates per round:
`npx tsc --noEmit && npm run lint && npm test -- --runInBand && npm run test:integration &&
npm run build`. Integration serializes on a Postgres advisory lock; the known flake is `c13a`
(re-run before concluding). Review prompts for every converged unit are in `ai/m11-2-handoff/`.

## Cautions

- `claude -p` is broken (expired OAuth); the user must run `claude login`. Use harness subagents.
- Concurrent agents need explicit file fences; two agents once collided on `activity/events.ts`.
- Piped shell commands report the pipe tail's exit code — read jest's summary lines, not the code.
- The Neon integration DB intermittently reset connections on 2026-08-05; probe and retry before
  diagnosing test failures as real.
- `agents.md` (= CLAUDE.md) accumulated new invariants across u3b–u3d — read its store/migration
  section before touching any producer.
